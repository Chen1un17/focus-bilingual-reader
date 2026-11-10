// 后台脚本单元测试：在 vm 里加载 background.js，替换 chrome / fetch。运行：node tests/unit.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const ev = () => ({ fns: [], addListener(fn) { this.fns.push(fn); } });
const store = {};
const chrome = {
  storage: { local: {
    setAccessLevel: async () => {},
    get: async keys => {
      if (keys == null) return { ...store };
      const out = {};
      for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
      return out;
    },
    set: async obj => { Object.assign(store, obj); },
    remove: async keys => { for (const k of [].concat(keys)) delete store[k]; },
    getBytesInUse: async () => JSON.stringify(store).length,
  } },
  runtime: { onInstalled: ev(), onMessage: ev(), onConnect: ev(), openOptionsPage() {}, getPlatformInfo() {}, getURL: p => `chrome-extension://test/${p}` },
  contextMenus: { removeAll() {}, create() {}, onClicked: ev() },
  action: { onClicked: ev(), setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: { onUpdated: ev() },
  scripting: {},
};

let fetchImpl = null;
let presetImpl = () => Promise.reject(new TypeError('Failed to fetch'));
const requests = [];
const ctx = vm.createContext({
  chrome, crypto, TextEncoder, TextDecoder, ReadableStream, Response, AbortController, AbortSignal,
  setTimeout, clearTimeout, setInterval, clearInterval, console,
  self: { location: { origin: 'chrome-extension://test' } },
  fetch: async (url, init) => {
    if (url.endsWith('/preset.json')) return presetImpl(url);
    requests.push({ url, init, body: JSON.parse(init.body) });
    return fetchImpl(url, init);
  },
});
vm.runInContext(src, ctx, { filename: 'background.js' });
const run = code => vm.runInContext(code, ctx);

// 把模型输出切成 SSE 流，再按任意字节边界切块（测试跨块拼行、多字节字符被切断）
function sseResponse(output, { piece = 7, cut = 13, finish = 'stop', status = 200 } = {}) {
  let sse = ': keep-alive\n\n';
  for (let i = 0; i < output.length; i += piece) {
    sse += `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: output.slice(i, i + piece) }, finish_reason: null }] })}\r\n\r\n`;
    if (i === piece * 3) sse += ': keep-alive\n\n';
  }
  sse += `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '' }, finish_reason: finish }], usage: { prompt_tokens: 10 } })}\n\n`;
  sse += 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(sse);
  const stream = new ReadableStream({
    async start(c) {
      for (let i = 0; i < bytes.length; i += cut) { c.enqueue(bytes.slice(i, i + cut)); await new Promise(r => setTimeout(r, 0)); }
      c.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('parseSeg 解析译文与重心词（含全角竖线、空格）', () => {
  const item = run(`parseSeg(3, '\\n<zh> 睡眠不足会损害工作记忆。 </zh>\\n<kw>Sleep deprivation | 睡眠不足</kw>\\n<kw>working memory｜工作记忆</kw>\\n<kw>bad</kw>\\n')`);
  assert.equal(item.id, 3);
  assert.equal(item.zh, '睡眠不足会损害工作记忆。');
  assert.deepEqual(JSON.parse(JSON.stringify(item.kws)), [['Sleep deprivation', '睡眠不足'], ['working memory', '工作记忆']]);
  assert.equal(run(`parseSeg(1, '<kw>a | b</kw>')`), null, '没有 <zh> 时返回 null');
});

test('parseSeg 清理译文里的换行：中文之间去掉，英文之间换成空格', () => {
  const item = run(`parseSeg(1, '<zh>第一句话，\\n第二句话 with\\nEnglish words。</zh>')`);
  assert.equal(item.zh, '第一句话，第二句话 with English words。');
});

test('extractSegs 只取完整的 <seg> 块，并返回续读位置', () => {
  const got = [];
  ctx.__got = got;
  const full = '<seg id="1">\n<zh>甲</zh>\n</seg>\n<seg id="2">\n<zh>乙</zh>\n<kw>B | 乙</kw>\n</seg>';
  let cursor = 0;
  for (let n = 1; n <= full.length; n++) {
    ctx.__text = full.slice(0, n);
    ctx.__cursor = cursor;
    cursor = run('extractSegs(__text, __cursor, it => __got.push(it))');
  }
  assert.deepEqual(got.map(g => g.id), [1, 2]);
  assert.equal(got[1].zh, '乙');
  assert.equal(cursor, full.length);
});

test('sseEvents 跳过 keep-alive 注释、处理 CRLF 和跨块切断的 UTF-8', async () => {
  ctx.__res = sseResponse('你好，世界！Hello', { piece: 3, cut: 5 });
  const chunks = await run(`(async () => { const out = []; for await (const c of sseEvents(__res.body)) out.push(c); return out; })()`);
  const text = chunks.map(c => c.choices[0].delta.content).join('');
  assert.equal(text, '你好，世界！Hello');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
});

test('callDeepSeek：请求格式正确，流式逐段回调', async () => {
  requests.length = 0;
  const output = '<seg id="1">\n<zh>第一段译文</zh>\n<kw>first | 第一段</kw>\n</seg>\n<seg id="2" >\n<zh>第二段译文</zh>\n</seg>\n<seg id="9">\n<zh>不该出现</zh>\n</seg>';
  fetchImpl = () => sseResponse(output);
  const items = [];
  ctx.__items = items;
  const reason = await run(`callDeepSeek({ apiKey: ' sk-test ', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/', density: 'medium' },
    [{ id: 1, text: 'The first paragraph.' }, { id: 2, text: 'Heading <seg> two', heading: true }], 'My <seg>Page',
    it => __items.push(it), new AbortController().signal)`);
  assert.equal(reason, 'stop');
  assert.deepEqual(items.map(i => i.id), [1, 2], '只回调本批次的编号');
  const req = requests[0];
  assert.equal(req.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(req.init.headers.Authorization, 'Bearer sk-test');
  assert.equal(req.body.model, 'deepseek-flash');
  assert.deepEqual(req.body.thinking, { type: 'disabled' });
  assert.equal(req.body.stream, true);
  assert.equal(req.body.messages[0].role, 'system');
  assert.match(req.body.messages[0].content, /普通段落选 2–3 个/);
  assert.match(req.body.messages[1].content, /^网页标题：My ‹seg>Page\n\n<seg id="1">The first paragraph\.<\/seg>\n<seg id="2" heading>Heading ‹seg> two<\/seg>$/);
});

test('fetchWithRetry：503 自动重试，401/402 立即报致命错误', async () => {
  let calls = 0;
  fetchImpl = () => (++calls === 1 ? new Response('{"error":{"message":"busy"}}', { status: 503, headers: { 'retry-after': '0' } }) : sseResponse('<seg id="1"><zh>好</zh></seg>'));
  const items = [];
  ctx.__items2 = items;
  await run(`callDeepSeek({ apiKey: 'k', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', density: 'low' }, [{ id: 1, text: 'ok' }], '', it => __items2.push(it), new AbortController().signal)`);
  assert.equal(calls, 2);
  assert.equal(items[0].zh, '好');

  for (const [status, code] of [[401, 'auth'], [402, 'balance'], [422, 'request']]) {
    fetchImpl = () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status });
    const err = await run(`callDeepSeek({ apiKey: 'k', model: 'm', baseUrl: 'https://x', density: 'low' }, [{ id: 1, text: 'a' }], '', () => {}, new AbortController().signal).then(() => null, e => toClientError(e))`);
    assert.equal(err.code, code);
    assert.equal(err.fatal, true);
  }
});

test('translateBatch：命中缓存不发请求，未命中的译完写入缓存', async () => {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, { apiKey: 'sk-x' });
  requests.length = 0;
  fetchImpl = () => sseResponse('<seg id="1">\n<zh>一</zh>\n</seg>\n<seg id="2">\n<zh>二</zh>\n<kw>two | 二</kw>\n</seg>');
  const first = [];
  ctx.__first = first;
  await run(`translateBatch({ segs: [{ id: 1, text: 'one' }, { id: 2, text: 'two' }], title: 't' }, it => __first.push(it), new AbortController().signal)`);
  assert.equal(requests.length, 1);
  assert.equal(Object.keys(store).filter(k => k.startsWith('tc:')).length, 2);

  const second = [];
  ctx.__second = second;
  const reason = await run(`translateBatch({ segs: [{ id: 5, text: 'two' }, { id: 6, text: 'three' }], title: 't' }, it => __second.push(it), new AbortController().signal)`);
  assert.equal(second[0].id, 5, '缓存命中立即返回');
  assert.equal(second[0].zh, '二');
  assert.deepEqual(JSON.parse(JSON.stringify(second[0].kws)), [['two', '二']]);
  assert.equal(requests.length, 2, '只为未命中的段落发请求');
  assert.deepEqual(requests[1].body.messages[1].content.match(/<seg id="\d+"/g), ['<seg id="6"']);
  assert.equal(reason, 'stop');
});

test('没有 API Key 时报致命错误', async () => {
  for (const k of Object.keys(store)) delete store[k];
  const err = await run(`translateBatch({ segs: [{ id: 1, text: 'x' }] }, () => {}, new AbortController().signal).then(() => null, e => toClientError(e))`);
  assert.equal(err.code, 'nokey');
  assert.equal(err.fatal, true);
});

test('extractSegs 接受中文引号写的编号 id=“1”（真实模型会这样输出）', () => {
  const got = [];
  ctx.__got3 = got;
  ctx.__text3 = '<seg id=“1”>\n<zh>标题</zh>\n</seg>\n<seg id=“12” heading>\n<zh>甲</zh>\n<kw>A | 甲</kw>\n</seg>\n<seg id=\'3\'>\n<zh>乙</zh>\n</seg>';
  run('extractSegs(__text3, 0, it => __got3.push(it))');
  assert.deepEqual(got.map(g => g.id), [1, 12, 3]);
});

test('parseSeg 去掉重心词两端的引号和句读，保留中间和括号', () => {
  const item = run(`parseSeg(1, '<zh>它不只是一个标着“努力工作”的点。</zh><kw>"work hard." | “努力工作”</kw><kw>chrome.storage.local.set() | 「设置」</kw><kw>it’s important | 很重要</kw>')`);
  assert.deepEqual(JSON.parse(JSON.stringify(item.kws)), [['work hard', '努力工作'], ['chrome.storage.local.set()', '设置'], ['it’s important', '很重要']]);
});

test('translateBatch 按密度截断重心词，标题最多 1 个', async () => {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, { apiKey: 'sk-x', density: 'low' });
  const kws = n => Array.from({ length: n }, (_, i) => `<kw>w${i} | 词${i}</kw>`).join('');
  fetchImpl = () => sseResponse(`<seg id="1"><zh>标题</zh>${kws(3)}</seg><seg id="2"><zh>正文</zh>${kws(5)}</seg>`);
  const got = [];
  ctx.__got4 = got;
  await run(`translateBatch({ segs: [{ id: 1, text: 'Head', heading: true }, { id: 2, text: 'Body text' }] }, it => __got4.push(it), new AbortController().signal)`);
  assert.deepEqual(got.map(g => g.kws.length), [1, 2]);
});

test('applyPreset：只填空着的设置项，忽略未知字段；没有 preset.json 时什么都不做', async () => {
  for (const k of Object.keys(store)) delete store[k];
  await run('applyPreset()');
  assert.deepEqual({ ...store }, {}, '没有文件时不写入');

  presetImpl = async () => new Response(JSON.stringify({ apiKey: 'sk-preset', model: 'deepseek-v4-pro', evil: 1 }));
  Object.assign(store, { apiKey: '', model: 'deepseek-flash' });
  await run('applyPreset()');
  assert.equal(store.apiKey, 'sk-preset', '空字符串当作没填');
  assert.equal(store.model, 'deepseek-flash', '用户已选的模型不覆盖');
  assert.equal('evil' in store, false);

  store.apiKey = 'sk-user';
  await run('applyPreset()');
  assert.equal(store.apiKey, 'sk-user', '用户自己填的 Key 不覆盖');
  presetImpl = () => Promise.reject(new TypeError('Failed to fetch'));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('✓', name); }
  catch (e) { failed++; console.log('✗', name, '\n ', e.message); }
}
console.log(failed ? `\n${failed} 个失败` : `\n全部 ${tests.length} 项通过`);
process.exit(failed ? 1 : 0);
