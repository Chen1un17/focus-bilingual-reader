// 专注双语阅读 · 后台 Service Worker
// 1. 点击图标 / Alt+T / 右键菜单时，向当前页注入内容脚本，再次触发则关闭
// 2. 持有 API Key，以流式方式调用 DeepSeek，每译完一段就推回页面
// 3. 用 chrome.storage.local 缓存译文，同一段落不重复花钱

const DEFAULTS = {
  apiKey: '',
  model: 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com',
  density: 'medium',
  fontScale: 1,
  focusDefault: false,
};
const PROMPT_VERSION = 2;
const MAX_KWS = { low: 2, medium: 4, high: 6 };
const CACHE_PREFIX = 'tc:';
const CACHE_LIMIT_BYTES = 8 * 1024 * 1024;

// 内容脚本跑在网页进程里，不让它直接读到存储里的 API Key
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'fbr-toggle', title: '双语对照阅读本页（Alt+T）', contexts: ['page', 'selection'] });
  });
  await applyPreset();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(toggleTab);
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'fbr-toggle') toggleTab(tab);
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});

async function toggleTab(tab) {
  if (!tab?.id) return;
  let { apiKey } = await getSettings();
  if (!apiKey) {
    await applyPreset();
    ({ apiKey } = await getSettings());
  }
  if (!apiKey) {
    chrome.runtime.openOptionsPage();
    return;
  }
  const target = { tabId: tab.id };
  try {
    const [res] = await chrome.scripting.executeScript({
      target,
      func: () => (window.__fbr ? window.__fbr.toggle() : 'absent'),
    });
    if (res?.result === 'absent') {
      await chrome.scripting.insertCSS({ target, files: ['content.css'] });
      await chrome.scripting.executeScript({ target, files: ['content.js'] });
    }
  } catch (err) {
    // chrome:// 页面、应用商店、PDF 阅读器等页面不允许注入脚本
    console.warn('无法在此页面运行：', err);
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#9ca3af' }).catch(() => {});
    chrome.action.setBadgeText({ tabId: tab.id, text: '×' }).catch(() => {});
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {}), 2000);
  }
}

function setBadge(tabId, active) {
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#5b6ee1' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: active ? 'ON' : '' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 只有扩展自己的页面（设置页）能做测试连接、管理缓存；网页里的内容脚本不行
  const fromExtensionPage = sender.origin === self.location.origin;
  switch (msg?.type) {
    case 'config':
      getSettings().then(s => sendResponse({ fontScale: s.fontScale, focusDefault: s.focusDefault }));
      return true;
    case 'state':
      if (sender.tab?.id != null) setBadge(sender.tab.id, msg.active);
      return false;
    case 'openOptions':
      chrome.runtime.openOptionsPage();
      return false;
    case 'test':
      if (!fromExtensionPage) return false;
      testConnection(msg.settings).then(sendResponse);
      return true;
    case 'cacheInfo':
      if (!fromExtensionPage) return false;
      cacheStats().then(sendResponse);
      return true;
    case 'clearCache':
      if (!fromExtensionPage) return false;
      clearCache().then(sendResponse);
      return true;
  }
  return false;
});

// ---------- 翻译：内容脚本每发一批段落就开一个 port ----------

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'fbr') return;
  const ac = new AbortController();
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
    ac.abort();
  });
  const post = m => {
    if (!open) return;
    try {
      port.postMessage(m);
    } catch {
      open = false;
    }
  };
  port.onMessage.addListener(async msg => {
    if (msg?.type !== 'translate') return;
    keepAlive(+1);
    try {
      const reason = await translateBatch(msg, item => post({ type: 'item', ...item }), ac.signal);
      post({ type: 'done', reason });
    } catch (err) {
      if (!ac.signal.aborted) post({ type: 'error', ...toClientError(err) });
    } finally {
      keepAlive(-1);
      if (open) port.disconnect();
    }
  });
});

async function translateBatch({ segs, title }, onItem, signal) {
  const cfg = await getSettings();
  if (!cfg.apiKey) throw new ApiError('nokey', '还没有填写 DeepSeek API Key，请先到设置页填写', { fatal: true });

  const keyed = await Promise.all(
    segs.map(async s => ({ ...s, key: CACHE_PREFIX + (await sha1(`${PROMPT_VERSION}|${cfg.model}|${cfg.density}|${s.text}`)) })),
  );
  const cached = await chrome.storage.local.get(keyed.map(s => s.key));
  const misses = [];
  for (const s of keyed) {
    const hit = cached[s.key];
    if (hit) onItem({ id: s.id, zh: hit.z, kws: hit.k });
    else misses.push(s);
  }
  if (!misses.length) return 'cache';

  const toStore = {};
  try {
    return await callDeepSeek(cfg, misses, title, item => {
      const s = misses.find(m => m.id === item.id);
      if (!s || s.done) return;
      s.done = true;
      // 模型偶尔多给几个：按密度截断，标题最多 1 个
      item.kws = item.kws.slice(0, s.heading ? 1 : MAX_KWS[cfg.density] || MAX_KWS.medium);
      onItem(item);
      toStore[s.key] = { z: item.zh, k: item.kws, t: Date.now() };
    }, signal);
  } finally {
    if (Object.keys(toStore).length) {
      await chrome.storage.local.set(toStore);
      pruneCache();
    }
  }
}

async function callDeepSeek(cfg, segs, title, onItem, signal) {
  const res = await fetchWithRetry(cfg, buildBody(cfg, segs, title), signal);
  const ids = new Set(segs.map(s => s.id));
  let text = '';
  let cursor = 0;
  let finish = null;
  for await (const chunk of sseEvents(res.body)) {
    if (chunk.error) {
      throw new ApiError('stream', chunk.error.message || 'DeepSeek 返回了错误', { retryable: true });
    }
    const choice = chunk.choices?.[0];
    const piece = choice?.delta?.content;
    if (piece) {
      text += piece;
      cursor = extractSegs(text, cursor, item => {
        if (ids.has(item.id)) onItem(item);
      });
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
  }
  return finish || 'stop';
}

function buildBody(cfg, segs, title) {
  return {
    model: cfg.model,
    messages: [
      { role: 'system', content: systemPrompt(cfg.density) },
      { role: 'user', content: userPrompt(segs, title) },
    ],
    // 翻译不需要思维链：关掉思考模式，速度更快、更省钱
    thinking: { type: 'disabled' },
    stream: true,
    max_tokens: 8192,
  };
}

// 读取 SSE：DeepSeek 在排队时会发 ": keep-alive" 注释行，这里一并跳过
async function* sseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          finished = true;
          return;
        }
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        yield chunk;
      }
    }
  } finally {
    if (!finished) reader.cancel().catch(() => {});
  }
}

// 模型常把编号写成 id=“1”（中文引号），所以不挑引号
const SEG_RE = /<seg\s+id\s*=[^\d>]*(\d+)[^>]*>([\s\S]*?)<\/seg>/g;

// 从已收到的文本里取出完整的 <seg> 块；返回下次开始查找的位置
function extractSegs(text, from, onItem) {
  SEG_RE.lastIndex = from;
  let end = from;
  let m;
  while ((m = SEG_RE.exec(text))) {
    end = SEG_RE.lastIndex;
    const item = parseSeg(Number(m[1]), m[2]);
    if (item) onItem(item);
  }
  return end;
}

const CJK = /[　-〿㐀-鿿＀-￯]/;
// 重心词两端的引号、句读去掉：模型可能给出 "work hard"，而原文是 "work hard."
const EDGE = /^[\s"'“”‘’「」『』《》.,;:!?，。；：！？、]+|[\s"'“”‘’「」『』《》.,;:!?，。；：！？、]+$/g;

function parseSeg(id, inner) {
  // 模型偶尔会在长译文中间换行：挨着中文的换行直接去掉，其它换成空格
  const zh = (inner.match(/<zh>([\s\S]*?)<\/zh>/)?.[1] || '')
    .trim()
    .replace(/\s*\n\s*/g, (m, i, s) => (CJK.test(s[i - 1] || '') || CJK.test(s[i + m.length] || '') ? '' : ' '));
  if (!zh) return null;
  const kws = [];
  for (const [, raw] of inner.matchAll(/<kw>([\s\S]*?)<\/kw>/g)) {
    const i = raw.search(/[|｜]/);
    if (i < 0) continue;
    const en = raw.slice(0, i).replace(EDGE, '');
    const cn = raw.slice(i + 1).replace(EDGE, '');
    if (en && cn) kws.push([en, cn]);
  }
  return { id, zh, kws };
}

// ---------- 提示词 ----------

const DENSITY_RULE = {
  low: '普通段落选 1–2 个；很短的段落或标题选 0–1 个。',
  medium: '普通段落选 2–3 个，很长的段落最多 4 个；很短的段落或标题选 0–1 个。',
  high: '普通段落选 3–5 个，很长的段落最多 6 个；标题选 0–1 个。',
};

function systemPrompt(density) {
  return `你是专业的英译中译者，服务对象是一位有 ADHD 的读者：TA 会逐段对照阅读原文和你的译文，并依靠高亮的“重心词”快速抓住每段要点。

你会收到同一个网页里的若干段落，格式为 <seg id="编号">原文</seg>；带 heading 标记的是标题。请逐段完成两件事。

一、译文
把原文完整、准确地译成自然流畅的简体中文。不要总结、删减、补充或解释；保持原文的语气和逻辑关系。人名、机构、产品名、代码、网址、数字和单位要准确：有通行中文译名的用通行译名，没有的保留原文。原文如果不是英文，同样译成简体中文。

二、重心词
挑出最能承载本段核心意思的词或短语：只扫一眼这些词，就能知道这一段在讲什么。优先选核心概念、关键论断、转折或因果关系、关键数字、关键人物或机构；不要选泛泛的常用词。按重要性从高到低排列，第一个必须是本段最核心的那个。数量：${DENSITY_RULE[density] || DENSITY_RULE.medium}
每个重心词写成“英文 | 中文”：
- 英文：从原文中逐字复制的连续片段（拼写、大小写、标点完全一致），1–4 个词；
- 中文：从你写好的译文里原样复制的连续片段（一字不改，不增不减），和英文意思对应；
- 不同重心词之间不要互相重叠。

输出格式（严格遵守；不要输出任何其他文字，不要用 Markdown 或代码块）：
<seg id="编号">
<zh>译文</zh>
<kw>英文 | 中文</kw>
</seg>
每个输入段落都要输出，顺序和编号与输入一致。没有合适的重心词时可以不写 <kw>。

示例输入：
<seg id="1">Sleep deprivation impairs working memory, but even a short nap can restore it.</seg>
示例输出：
<seg id="1">
<zh>睡眠不足会损害工作记忆，但哪怕只是短暂的小睡，也能让它恢复。</zh>
<kw>Sleep deprivation | 睡眠不足</kw>
<kw>working memory | 工作记忆</kw>
<kw>short nap | 短暂的小睡</kw>
</seg>`;
}

function userPrompt(segs, title) {
  const clean = s => s.replace(/<(\/?)(seg|zh|kw)\b/gi, '‹$1$2');
  const head = title ? `网页标题：${clean(title.trim().slice(0, 150))}\n\n` : '';
  return head + segs.map(s => `<seg id="${s.id}"${s.heading ? ' heading' : ''}>${clean(s.text)}</seg>`).join('\n');
}

// ---------- 网络请求与错误 ----------

class ApiError extends Error {
  constructor(code, message, { fatal = false, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.fatal = fatal;
    this.retryable = retryable;
  }
}

function toClientError(err) {
  if (err instanceof ApiError) return { code: err.code, message: err.message, fatal: err.fatal, retryable: err.retryable };
  return { code: 'unknown', message: String(err?.message || err), fatal: false, retryable: true };
}

function endpoint(cfg) {
  return `${(cfg.baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, '')}/chat/completions`;
}

function headers(cfg) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey.trim()}` };
}

async function fetchWithRetry(cfg, body, signal) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(endpoint(cfg), { method: 'POST', headers: headers(cfg), body: JSON.stringify(body), signal });
    } catch (err) {
      if (signal.aborted) throw err;
      if (attempt < 2) {
        await sleep(1000 * 2 ** attempt, signal);
        continue;
      }
      throw new ApiError('network', '连不上 DeepSeek，请检查网络或代理', { retryable: true });
    }
    if (res.ok) return res;
    const detail = await readError(res);
    if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 2) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(after > 0 ? after * 1000 : 1500 * 2 ** attempt, signal);
      continue;
    }
    throw httpError(res.status, detail);
  }
}

function httpError(status, detail) {
  switch (status) {
    case 401:
      return new ApiError('auth', 'API Key 无效或已被删除，请到设置页检查', { fatal: true });
    case 402:
      return new ApiError('balance', 'DeepSeek 账户余额不足，请先到开放平台充值', { fatal: true });
    case 429:
      return new ApiError('rate', '请求太频繁（达到并发上限），稍后会自动重试', { retryable: true });
    case 400:
    case 422:
      return new ApiError('request', `请求被拒绝（${status}）：${detail}`, { fatal: true });
    default:
      if (status >= 500) return new ApiError('server', 'DeepSeek 服务繁忙，稍后会自动重试', { retryable: true });
      return new ApiError('http', `请求失败（${status}）：${detail}`, { fatal: true });
  }
}

async function readError(res) {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text);
    return j.error?.message || j.message || text.slice(0, 200);
  } catch {
    return text.slice(0, 200) || res.statusText;
  }
}

async function testConnection(settings) {
  const cfg = { ...DEFAULTS, ...settings };
  if (!cfg.apiKey?.trim()) return { ok: false, message: '请先填写 API Key' };
  try {
    const res = await fetch(endpoint(cfg), {
      method: 'POST',
      headers: headers(cfg),
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'ping' }],
        thinking: { type: 'disabled' },
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) return { ok: true, message: '连接成功，可以开始使用了' };
    return { ok: false, message: httpError(res.status, await readError(res)).message };
  } catch (err) {
    return { ok: false, message: `连接失败：${err.message}` };
  }
}

// ---------- 缓存 ----------

let lastPrune = 0;
async function pruneCache() {
  if (Date.now() - lastPrune < 60_000) return;
  lastPrune = Date.now();
  if ((await chrome.storage.local.getBytesInUse(null)) < CACHE_LIMIT_BYTES) return;
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([k]) => k.startsWith(CACHE_PREFIX))
    .sort((a, b) => (a[1].t || 0) - (b[1].t || 0));
  await chrome.storage.local.remove(entries.slice(0, Math.ceil(entries.length / 2)).map(([k]) => k));
}

async function cacheStats() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX));
  return { count: keys.length, bytes: keys.length ? await chrome.storage.local.getBytesInUse(keys) : 0 };
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX)));
  return cacheStats();
}

// ---------- 工具 ----------

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

// 扩展文件夹里的 preset.json（例如预先写好的 API Key）会填进还空着的设置项；设置页里改过的不覆盖
async function applyPreset() {
  let preset;
  try {
    preset = await (await fetch(chrome.runtime.getURL('preset.json'))).json();
  } catch {
    return; // 没有这个文件
  }
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const patch = {};
  for (const [k, v] of Object.entries(preset || {})) {
    if (k in DEFAULTS && (stored[k] === undefined || stored[k] === '')) patch[k] = v;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

async function sha1(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}

// 有请求在跑时，定期调用一次扩展 API，避免 Service Worker 因空闲被回收
let running = 0;
let keepAliveTimer = 0;
function keepAlive(delta) {
  running = Math.max(0, running + delta);
  if (running && !keepAliveTimer) keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
  if (!running && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = 0;
  }
}
