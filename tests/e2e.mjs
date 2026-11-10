// 端到端测试：无头 Chrome 加载扩展 + 本地模拟 DeepSeek 流式接口
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// 运行：node tests/e2e.mjs [截图目录]。Chrome 不在默认位置时，用环境变量 CHROME_PATH 指定
const EXT_SRC = fileURLToPath(new URL('..', import.meta.url));
const WORK = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'fbr-e2e-'));
fs.mkdirSync(WORK, { recursive: true });
const CHROME = process.env.CHROME_PATH || {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
}[process.platform] || 'google-chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ARTICLE = fs.readFileSync(new URL('./article.html', import.meta.url), 'utf8');

// ---- 测试用扩展副本：只拷扩展自身的文件（不带 preset.json），额外授权本地模拟服务器 ----
const NOT_EXT = new Set(['.git', 'tests', 'docs', 'preset.json']);
const extDir = path.join(WORK, 'ext');
fs.rmSync(extDir, { recursive: true, force: true });
fs.cpSync(EXT_SRC, extDir, { recursive: true, filter: src => !NOT_EXT.has(path.relative(EXT_SRC, src).split(path.sep)[0]) });
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*');
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ---- 模拟 DeepSeek ----
const log = { requests: [], skipSeen: 0 };
function fakeSeg(s) {
  const kws = [];
  if (s.text.includes('working memory')) kws.push(['working memory', '工作记忆']);
  if (s.text.includes('it’s important')) kws.push(["it's important", '很重要']);
  if (s.text.includes('models')) kws.push(['model', '模型']);
  const words = [...new Set(s.text.match(/[A-Za-z]{5,}/g) || [])].sort((a, b) => b.length - a.length);
  for (const w of words) {
    if (kws.length >= (s.heading ? 1 : 3)) break;
    if (!kws.some(k => k[0].toLowerCase().includes(w.toLowerCase()) || w.toLowerCase().includes(k[0].toLowerCase()))) kws.push([w, `「${w}」`]);
  }
  const zh = s.heading
    ? `标题：${kws.map(k => k[1]).join('与')}`
    : `这一段讲的是${kws.map(k => k[1]).join('、')}。这是用于测试的模拟中文译文，用来检查行距、行长和高亮配色是否舒适，句子稍长一些方便观察换行。`;
  return `<seg id="${s.id}">\n<zh>${zh}</zh>\n${kws.map(k => `<kw>${k[0]} | ${k[1]}</kw>`).join('\n')}\n</seg>\n`;
}
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/article.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(ARTICLE);
  }
  if (req.method === 'POST' && req.url === '/chat/completions') {
    let body = '';
    for await (const c of req) body += c;
    const json = JSON.parse(body);
    log.requests.push({ auth: req.headers.authorization, json });
    if (req.headers.authorization !== 'Bearer sk-test') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Authentication Fails, Your api key is invalid' } }));
    }
    const segs = [...json.messages[1].content.matchAll(/<seg id="(\d+)"( heading)?>([\s\S]*?)<\/seg>/g)]
      .map(m => ({ id: Number(m[1]), heading: !!m[2], text: m[3] }));
    let out = '';
    for (const s of segs) {
      if (s.text.includes('SKIPME') && log.skipSeen++ === 0) continue; // 第一次故意漏掉这一段
      out += fakeSeg(s);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': keep-alive\n\n');
    for (let i = 0; i < out.length; i += 12) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: out.slice(i, i + 12) }, finish_reason: null }] })}\n\n`);
      await sleep(3);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] })}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  res.writeHead(404);
  res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// ---- Chrome DevTools Protocol（pipe 模式）----
const profile = path.join(WORK, 'profile');
fs.rmSync(profile, { recursive: true, force: true });
const proc = spawn(CHROME, [
  '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let stderr = '';
proc.stderr.on('data', d => (stderr += d));
let msgId = 0;
const pending = new Map();
const listeners = [];
let rbuf = Buffer.alloc(0);
proc.stdio[4].on('data', d => {
  rbuf = Buffer.concat([rbuf, d]);
  let i;
  while ((i = rbuf.indexOf(0)) >= 0) {
    const msg = JSON.parse(rbuf.subarray(0, i).toString('utf8'));
    rbuf = rbuf.subarray(i + 1);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
    } else listeners.forEach(fn => fn(msg));
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject, method });
  proc.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + '\0');
});

const exceptions = [];
const contexts = [];
listeners.push(msg => {
  if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') exceptions.push('console.error: ' + msg.params.args.map(a => a.value ?? a.description).join(' '));
  if (msg.method === 'Runtime.executionContextCreated') contexts.push({ ...msg.params.context, sessionId: msg.sessionId });
});

async function evaluate(sessionId, expression, contextId) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(contextId && { contextId }) }, sessionId);
  if (r.exceptionDetails) throw new Error(`evaluate 出错：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n${expression}`);
  return r.result.value;
}
async function waitFor(fn, what, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`等待超时：${what}`);
    await sleep(150);
  }
}

const results = [];
const check = (name, fn) => results.push([name, fn]);

try {
  const { id: extId } = await send('Extensions.loadUnpacked', { path: extDir });
  const swTarget = await waitFor(async () => (await send('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`)), 'service worker');
  const { sessionId: sw } = await send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
  await send('Runtime.enable', {}, sw);
  const evalSW = expr => evaluate(sw, expr);
  await evalSW(`chrome.storage.local.set({ apiKey: 'sk-test', baseUrl: '${base}' })`);

  const { targetId } = await send('Target.createTarget', { url: `${base}/article.html` });
  const { sessionId: page } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, page);
  await send('Runtime.enable', {}, page);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, page);
  const evalPage = expr => evaluate(page, expr);
  await waitFor(() => evalPage(`document.readyState === 'complete'`), '页面加载');
  const before = await evalPage('document.body.innerHTML');
  const shot = async name => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, page);
    fs.writeFileSync(path.join(WORK, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const toggle = () => evalSW(`(async () => { const t = (await chrome.tabs.query({})).find(x => x.url && x.url.includes('/article.html')); await toggleTab(t); return t.id; })()`);
  const isolated = () => contexts.filter(c => c.sessionId === page && c.auxData?.type === 'isolated' && c.origin?.includes(extId)).at(-1)?.id;
  const debug = () => evaluate(page, 'window.__fbr.debug()', isolated());
  const idle = d => d.queue === 0 && d.inflight === 0;

  // 1) 打开双语
  await toggle();
  await waitFor(isolated, '内容脚本的隔离环境');
  const d1 = await waitFor(async () => { const d = await debug(); return d.done >= 8 && idle(d) && d; }, '首屏翻译完成');
  await shot('1-top');

  const dom = await evalPage(`(() => {
    const has = sel => !!document.querySelector(sel + ' fbr-t');
    const lead = document.querySelector('p.lead');
    const leadMarks = [...lead.querySelectorAll(':scope fbr-k')].filter(k => !k.closest('fbr-t'));
    const para = document.querySelectorAll('article > p')[1];
    const origMarks = [...para.querySelectorAll('fbr-k')].filter(k => !k.closest('fbr-t')).map(k => k.textContent);
    const outerLi = document.querySelector('article > ul > li');
    const note = document.querySelector('.note');
    const far = [...document.querySelectorAll('article > p')].slice(-3);
    const pairs = [...document.querySelectorAll('fbr-k')].filter(k => !k.closest('fbr-t')).map(k => k.dataset.pair);
    const transPairs = new Set([...document.querySelectorAll('fbr-t fbr-k')].map(k => k.dataset.pair));
    return {
      slots: document.querySelectorAll('fbr-t').length,
      navT: has('nav'), footerT: has('footer'), preT: has('pre'),
      zhT: !!document.querySelectorAll('article > p')[2].querySelector('fbr-t'),
      buttonT: !!document.querySelectorAll('article > p')[3].querySelector('fbr-t'),
      leadMarks: leadMarks.map(k => [k.textContent, k.dataset.pair, k.hasAttribute('data-core')]),
      origMarks,
      outerLiSlotBeforeUl: outerLi.querySelector(':scope > fbr-t')?.nextElementSibling?.localName,
      nestedLiSlot: !!outerLi.querySelector('ul > li > fbr-t'),
      noteSlotBeforeP: note.querySelector(':scope > fbr-t')?.nextElementSibling?.localName,
      noteInnerP: !!note.querySelector('p > fbr-t'),
      brParts: [...document.querySelectorAll('.brs > fbr-p')].map(p => [p.textContent.trim().slice(0, 30), p.nextElementSibling?.localName]),
      farSlots: far.filter(p => p.querySelector('fbr-t')).length,
      unpaired: pairs.filter(p => !transPairs.has(p)).length,
      h1Slot: !!document.querySelector('h1 > fbr-t[data-h]'),
      panel: !!document.querySelector('fbr-panel'),
    };
  })()`);

  check('首屏段落已翻译（标题、段落、列表、引用、div）', () => assert.ok(d1.done >= 8, `done=${d1.done}`));
  check('导航、页脚、代码块、中文段落、按钮文字不翻译', () => {
    assert.equal(dom.navT, false); assert.equal(dom.footerT, false); assert.equal(dom.preT, false);
    assert.equal(dom.zhT, false); assert.equal(dom.buttonT, false);
  });
  check('h1 标题有译文（标题样式）', () => assert.equal(dom.h1Slot, true));
  check('嵌套列表：外层 li 的译文插在子列表之前，子项单独翻译', () => {
    assert.equal(dom.outerLiSlotBeforeUl, 'ul'); assert.equal(dom.nestedLiSlot, true);
  });
  check('div 里先文字后段落：译文插在 <p> 之前，<p> 单独翻译', () => {
    assert.equal(dom.noteSlotBeforeP, 'p'); assert.equal(dom.noteInnerP, true);
  });
  check('跨 <em> 的 “working memory” 被拆成同一对的两段高亮，且是核心词', () => {
    const wm = dom.leadMarks.filter(m => m[0] === 'working' || m[0] === ' memory');
    assert.equal(wm.length, 2, JSON.stringify(dom.leadMarks));
    assert.equal(wm[0][1], wm[1][1]);
    assert.equal(wm[0][2], true);
  });
  check('弯引号 it’s 与模型给的直引号能匹配；model 能匹配到 models', () => {
    assert.ok(dom.origMarks.includes('it’s important'), JSON.stringify(dom.origMarks));
    assert.ok(dom.origMarks.includes('models'), JSON.stringify(dom.origMarks));
  });
  check('原文里的每个高亮都能在译文里找到配对', () => assert.equal(dom.unpaired, 0));
  check('<br><br> 分段的老式写法被拆成 3 段，各自带译文', () => {
    assert.equal(dom.brParts.length, 3, JSON.stringify(dom.brParts));
    assert.ok(dom.brParts.every(([, next]) => next === 'fbr-t'), JSON.stringify(dom.brParts));
    assert.match(dom.brParts[1][0], /^Second paragraph/);
  });
  check('懒加载：远处段落还没翻译', () => assert.equal(dom.farSlots, 0));
  check('请求参数：关闭思考模式、流式、deepseek-flash', () => {
    const r = log.requests[0].json;
    assert.equal(r.model, 'deepseek-flash'); assert.equal(r.stream, true); assert.deepEqual(r.thinking, { type: 'disabled' });
  });

  // 2) 悬停一个英文重心词，它的中文另一半同时亮起
  const pos = await evalPage(`(() => { const r = document.querySelector('p.lead fbr-k[data-core]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y }, page);
  await sleep(200);
  const hot = await evalPage(`[...document.querySelectorAll('fbr-k[data-hot]')].map(k => !!k.closest('fbr-t'))`);
  check('悬停配对：原文和译文里同一对都被点亮', () => { assert.ok(hot.includes(true) && hot.includes(false), JSON.stringify(hot)); });
  await shot('2-hover');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }, page);

  // 3) 漏掉的段落会自动重试
  const skipped = await waitFor(() => evalPage(`[...document.querySelectorAll('article > p')].find(p => p.textContent.includes('SKIPME'))?.querySelector('fbr-t')?.dataset.state === 'done'`), 'SKIPME 段重试成功');
  check('模型漏掉一段时自动重试并补上', () => assert.equal(skipped, true));

  // 4) 专注模式
  await evaluate(page, 'window.__fbr.setFocus(true)', isolated());
  await evalPage(`window.scrollTo(0, document.querySelectorAll('article > p')[1].offsetTop - 250)`);
  await sleep(400);
  const spot = await evalPage(`(() => { const s = document.querySelector('fbr-spot'); const r = s.getBoundingClientRect(); return { h: r.height, op: getComputedStyle(s).opacity }; })()`);
  check('专注模式：聚光框出现并框住当前段落', () => { assert.ok(spot.h > 60, JSON.stringify(spot)); assert.equal(spot.op, '1'); });
  await shot('3-focus');
  await evaluate(page, 'window.__fbr.setFocus(false)', isolated());

  // 5) 滚到底部，远处段落开始翻译
  await evalPage('window.scrollTo(0, document.body.scrollHeight)');
  const farDone = await waitFor(() => evalPage(`[...document.querySelectorAll('article > p')].slice(-3).every(p => p.querySelector('fbr-t')?.dataset.state === 'done')`), '远处段落翻译');
  check('滚动到下方后远处段落被翻译', () => assert.equal(farDone, true));
  await shot('4-bottom');
  await evalPage('window.scrollTo(0, 0)');

  // 6) 关闭：页面 DOM 完全恢复
  await toggle();
  await sleep(300);
  const after = await evalPage('document.body.innerHTML');
  const leftovers = await evalPage(`document.querySelectorAll('fbr-t, fbr-k, fbr-panel, fbr-spot').length`);
  check('关闭后没有残留元素', () => assert.equal(leftovers, 0));
  check('关闭后 body.innerHTML 与打开前逐字一致', () => assert.equal(after, before));

  // 7) 再次打开：全部命中缓存，不发新请求
  const reqBefore = log.requests.length;
  await toggle();
  await waitFor(async () => { const d = await debug(); return d.active && d.done >= 8 && idle(d); }, '缓存重开');
  const reqAfterReopen = log.requests.length;
  check('重新打开全部命中缓存，不再请求接口', () => assert.equal(reqAfterReopen, reqBefore));

  // 8) Key 无效：面板报错；换回正确的 Key 后点“重试”继续
  await toggle();
  await evalSW(`chrome.storage.local.set({ apiKey: 'sk-bad', density: 'high' })`);
  await toggle();
  const fatal = await waitFor(async () => (await debug()).fatal, '401 报错');
  check('API Key 无效时面板显示错误提示', () => assert.match(fatal.message, /API Key 无效/));
  await shot('5-error');
  await evalSW(`chrome.storage.local.set({ apiKey: 'sk-test' })`);
  const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }, page);
  const findNode = (n, pred) => { if (pred(n)) return n; for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) { const f = findNode(c, pred); if (f) return f; } return null; };
  const retryBtn = findNode(root, n => n.nodeName === 'BUTTON' && (n.attributes || []).join(' ').includes('retry'));
  const { model } = await send('DOM.getBoxModel', { nodeId: retryBtn.nodeId }, page);
  const [x1, y1, , , x3, y3] = model.content;
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: (x1 + x3) / 2, y: (y1 + y3) / 2, button: 'left', clickCount: 1 }, page);
  const recovered = await waitFor(async () => { const d = await debug(); return !d.fatal && d.done >= 8 && idle(d) && d; }, '点重试后恢复');
  check('点“重试”后继续翻译', () => assert.ok(recovered.done >= 8));

  // 9) 设置页能正常打开并读出已保存的设置
  const { targetId: optId } = await send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
  const { sessionId: opt } = await send('Target.attachToTarget', { targetId: optId, flatten: true });
  await send('Runtime.enable', {}, opt);
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1500, deviceScaleFactor: 1, mobile: false }, opt);
  const optState = await waitFor(() => evaluate(opt, `document.getElementById('apiKey').value && document.getElementById('cacheCount').textContent !== '…' && ({ key: document.getElementById('apiKey').value, density: document.querySelector('input[name=density]:checked').value, cache: document.getElementById('cacheCount').textContent, shortcut: document.getElementById('shortcut').textContent })`), '设置页加载');
  check('设置页读出已保存的 Key、密度和缓存数量', () => {
    assert.equal(optState.key, 'sk-test'); assert.equal(optState.density, 'high'); assert.ok(Number(optState.cache) > 0, optState.cache);
  });
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, opt);
  fs.writeFileSync(path.join(WORK, '6-options.png'), Buffer.from(data, 'base64'));

  check('页面与后台没有未捕获的异常', () => assert.deepEqual(exceptions, []));
} catch (err) {
  console.log('✗ 测试流程中断：', err.message);
  console.log(stderr.split('\n').filter(l => /error/i.test(l)).slice(-10).join('\n'));
  results.push(['流程完整跑完', () => { throw err; }]);
} finally {
  let failed = 0;
  for (const [name, fn] of results) {
    try { await fn(); console.log('✓', name); } catch (e) { failed++; console.log('✗', name, '\n   ', e.message.split('\n')[0]); }
  }
  console.log(`\n请求次数：${log.requests.length}；${failed ? `${failed} 项失败` : `全部 ${results.length} 项通过`}`);
  console.log(`截图在 ${WORK}`);
  proc.kill();
  server.close();
  process.exit(failed ? 1 : 0);
}
