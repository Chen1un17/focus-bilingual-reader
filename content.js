// 专注双语阅读 · 内容脚本
// 由后台在用户点击图标 / 按 Alt+T 时注入。找出正文段落，随滚动分批请求翻译，
// 在每段下方插入译文，并把成对的重心词（英文 ↔ 中文）用同一种颜色标出来。
(() => {
  if (window.__fbr) return;

  // ---------- 常量 ----------

  const MAX_INFLIGHT = 4; // 同时进行的请求数
  const BATCH_SEGS = 4; // 每个请求最多几段
  const BATCH_CHARS = 1800; // 每个请求最多多少字符原文
  const MAX_TRIES = 3;
  const PALETTE = 6; // 高亮配色数量，对应 content.css 里的 data-c
  const READING_LINE = 0.38; // “当前段落”判定线：视口高度的 38% 处

  const CANDIDATE = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'dd', 'dt', 'figcaption', 'td', 'th', 'caption', 'summary', 'div', 'section', 'article']);
  const BLOCK = new Set([...CANDIDATE, 'ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'pre', 'figure', 'hr', 'form', 'fieldset', 'details', 'header', 'footer', 'nav', 'aside', 'main', 'address', 'menu', 'center', 'dialog', 'hgroup', 'search', 'video', 'audio', 'canvas', 'iframe']);
  const NO_TEXT = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'textarea', 'select', 'option', 'input', 'button']);
  const EXCLUDE = new Set([...NO_TEXT, 'nav', 'footer', 'pre', 'code', 'kbd', 'samp', 'iframe', 'video', 'audio', 'canvas', 'object', 'embed', 'dialog']);
  const EXCLUDE_ROLE = /^(navigation|contentinfo|search|menu|menubar|toolbar|tablist|dialog|alertdialog)$/;
  const SR_ONLY = /\b(sr-only|visually-hidden|screen-reader-text|a11y-hidden)\b/;
  const INVIS = /[­​-‍⁠﻿]/;
  const SPACE = /\s/;
  const WORD = /[\p{L}\p{N}]/u;
  // 匹配重心词时把弯引号、各种破折号统一，避免模型输出与原文写法略有出入就匹配不上
  const FOLD = {
    '‘': "'", '’': "'", '‛': "'", '′': "'", 'ʼ': "'",
    '“': '"', '”': '"', '‟': '"', '″': '"',
    '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  };
  const SENTENCE_END = /[。！？；!?;]/;

  // ---------- 状态 ----------

  const S = {
    active: false,
    segs: [], // 已登记的段落，按文档顺序
    byEl: new Map(),
    splitBoxes: new WeakSet(), // 已按 <br><br> 拆过的容器
    queue: [],
    inflight: 0,
    ports: new Set(),
    fatal: null, // 需要用户处理的错误（Key 无效、余额不足……）
    focus: false,
    cur: -1, // 当前阅读到的段落下标
    hotPair: null,
    rootIsBody: true,
    nextId: 1,
    cfg: { fontScale: 1, focusDefault: false },
  };
  const SPLIT = new WeakSet(); // splitText 产生的文本节点，关闭时合并回原节点
  let io = null;
  let mo = null;
  let scanTimer = 0;
  let rafId = 0;
  let spot = null;
  let spotSeg = null;

  // ---------- 开关 ----------

  async function activate() {
    if (S.active) return;
    S.active = true;
    S.fatal = null;
    try {
      S.cfg = { ...S.cfg, ...(await chrome.runtime.sendMessage({ type: 'config' })) };
    } catch {}
    if (!S.active) return;
    io = new IntersectionObserver(onIntersect, { rootMargin: '100% 0px 150% 0px' });
    mo = new MutationObserver(onMutate);
    mo.observe(document.body, { childList: true, subtree: true });
    addEventListener('scroll', onScroll, { capture: true, passive: true });
    addEventListener('resize', onScroll, { passive: true });
    document.addEventListener('mouseover', onHover, true);
    panel.mount();
    scan();
    setFocus(!!S.cfg.focusDefault);
    notify(true);
  }

  function deactivate() {
    if (!S.active) return;
    S.active = false;
    for (const port of S.ports) {
      try {
        port.disconnect();
      } catch {}
    }
    S.ports.clear();
    S.inflight = 0;
    S.queue = [];
    S.fatal = null;
    io?.disconnect();
    mo?.disconnect();
    io = mo = null;
    clearTimeout(scanTimer);
    removeEventListener('scroll', onScroll, { capture: true });
    removeEventListener('resize', onScroll);
    document.removeEventListener('mouseover', onHover, true);
    setFocus(false);
    panel.unmount();
    for (const seg of S.segs) seg.slot?.remove();
    unwrapMarks();
    for (const p of document.querySelectorAll('fbr-p')) p.replaceWith(...p.childNodes);
    S.segs = [];
    S.byEl.clear();
    S.splitBoxes = new WeakSet();
    S.cur = -1;
    S.hotPair = null;
    notify(false);
  }

  function toggle() {
    if (S.active) deactivate();
    else activate();
    return S.active ? 'on' : 'off';
  }

  function notify(active) {
    chrome.runtime.sendMessage({ type: 'state', active }).catch(() => {});
  }

  addEventListener('pageshow', e => {
    if (e.persisted && S.active) notify(true);
  });

  // ---------- 找段落 ----------

  // 正文容器：<article>/<main> 里装着页面一半以上的段落文字时，只在它里面找
  function pickRoot() {
    const body = document.body;
    const pText = el => {
      let n = 0;
      for (const p of el.querySelectorAll('p')) n += p.textContent.length;
      return n;
    };
    const total = pText(body) || 1;
    let best = null;
    let bestN = 0;
    for (const el of body.querySelectorAll('article, main, [role="main"]')) {
      const n = pText(el);
      if (n > bestN) {
        best = el;
        bestN = n;
      }
    }
    return best && bestN / total >= 0.5 ? best : body;
  }

  function isExcluded(el) {
    const tag = el.localName;
    if (EXCLUDE.has(tag) || tag.startsWith('fbr-')) return true;
    if (tag === 'aside' && S.rootIsBody) return true;
    if (el.hidden || el.isContentEditable) return true;
    if (el.getAttribute('aria-hidden') === 'true' || el.getAttribute('translate') === 'no') return true;
    if (el.classList.contains('notranslate')) return true;
    const role = el.getAttribute('role');
    return !!role && EXCLUDE_ROLE.test(role);
  }

  function isExcludedChain(el) {
    for (let a = el; a && a !== document.body; a = a.parentElement) if (isExcluded(a)) return true;
    return false;
  }

  function scan() {
    if (!S.active) return;
    // 页面换了内容（单页应用跳转等），清理已经不在文档里的段落
    for (const seg of [...S.segs]) {
      if (seg.el.isConnected) continue;
      seg.slot?.remove();
      S.byEl.delete(seg.el);
      S.segs.splice(S.segs.indexOf(seg), 1);
    }
    const root = pickRoot();
    S.rootIsBody = root === document.body;
    const fresh = [];
    const add = el => {
      const seg = makeSeg(el);
      if (!seg) return;
      fresh.push(seg);
      S.byEl.set(el, seg);
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: el => {
        if (isExcluded(el)) return NodeFilter.FILTER_REJECT;
        return CANDIDATE.has(el.localName) || el.getAttribute('role') === 'heading' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (S.byEl.has(el) || S.splitBoxes.has(el) || insideRun(el)) continue;
      const parts = splitBreaks(el);
      if (parts) {
        S.splitBoxes.add(el);
        parts.forEach(add);
      } else {
        add(el);
      }
    }
    // 文章标题有时放在 <article> 外面
    if (!S.rootIsBody) {
      const h1 = document.querySelector('h1');
      if (h1 && !root.contains(h1) && !S.byEl.has(h1) && !isExcludedChain(h1)) add(h1);
    }
    if (fresh.length) {
      S.segs.push(...fresh);
      S.segs.sort(docOrder);
      for (const seg of fresh) io.observe(seg.el);
    }
    updateReading();
    panel.update();
  }

  // el 是否已经被某个祖先段落的文字范围包含（避免重复翻译）
  function insideRun(el) {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const seg = S.byEl.get(a);
      if (seg && (!seg.stopAt || seg.stopAt.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)) return true;
    }
    return false;
  }

  function firstBlockChild(el) {
    for (const c of el.childNodes) if (c.nodeType === Node.ELEMENT_NODE && BLOCK.has(c.localName)) return c;
    return null;
  }

  const isBr = n => n.nodeType === Node.ELEMENT_NODE && n.localName === 'br';
  const isBlank = n => n.nodeType === Node.TEXT_NODE && !n.data.trim();
  const childrenUntil = (box, end) => {
    const out = [];
    for (let c = box.firstChild; c && c !== end; c = c.nextSibling) out.push(c);
    return out;
  };

  // 老式网页常用 <br><br> 分段（整篇文章在一个元素里）。按连续两个 <br> 拆开，
  // 每段包进一个行内的 <fbr-p>，关闭时再拆掉
  function splitBreaks(el) {
    let box = el;
    let end = firstBlockChild(el);
    for (let depth = 0; depth < 6; depth++) {
      const groups = groupByBreaks(childrenUntil(box, end)).filter(g => g.some(n => n.textContent.trim()));
      if (groups.length >= 2) {
        return groups.map(g => {
          const p = document.createElement('fbr-p');
          g[0].before(p);
          p.append(...g);
          return p;
        });
      }
      // 只有一个带文字的行内子元素时往里找，比如 <td><img><br><br><font>正文…</font></td>
      const texty = groups[0]?.filter(n => n.textContent.trim()) || [];
      const only = texty[0];
      if (texty.length !== 1 || only.nodeType !== Node.ELEMENT_NODE) return null;
      if (BLOCK.has(only.localName) || NO_TEXT.has(only.localName) || only.localName.startsWith('fbr-')) return null;
      box = only;
      end = firstBlockChild(only);
    }
    return null;
  }

  // 按连续两个（及以上）<br> 把一串兄弟节点分组，<br> 本身留在原处不进任何组
  function groupByBreaks(nodes) {
    const groups = [];
    let group = [];
    for (let i = 0; i < nodes.length; i++) {
      if (isBr(nodes[i])) {
        let j = i + 1;
        while (j < nodes.length && isBlank(nodes[j])) j++;
        if (j < nodes.length && isBr(nodes[j])) {
          groups.push(group);
          group = [];
          i = j;
          while (i + 1 < nodes.length && (isBr(nodes[i + 1]) || isBlank(nodes[i + 1]))) i++;
          continue;
        }
      }
      group.push(nodes[i]);
    }
    groups.push(group);
    return groups;
  }

  // 一个段落 = 元素开头到第一个块级子元素之前的行内内容
  function makeSeg(el) {
    const stopAt = firstBlockChild(el);
    const seg = { id: S.nextId++, el, stopAt, text: '', state: 'idle', slot: null, result: null, tries: 0, marked: false };
    seg.heading = /^h[1-6]$/.test(el.localName) || el.getAttribute('role') === 'heading';
    seg.text = collapse(runItems(seg).map(it => (typeof it === 'string' ? it : it.data)).join(''));
    if (!worthTranslating(seg.text, seg.heading)) return null;
    if (!el.getClientRects().length) return null; // 不可见
    return seg;
  }

  // 段落里的文本节点（<br> 记作一个空格字符串）
  function runItems(seg) {
    const out = [];
    const visit = node => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (node === seg.el && c === seg.stopAt) break;
        if (c.nodeType === Node.TEXT_NODE) out.push(c);
        else if (c.nodeType === Node.ELEMENT_NODE) {
          const tag = c.localName;
          if (tag === 'br') out.push(' ');
          else if (tag !== 'fbr-t' && !NO_TEXT.has(tag) && c.getAttribute('aria-hidden') !== 'true' && !SR_ONLY.test(c.getAttribute('class') || '')) visit(c);
        }
      }
    };
    visit(seg.el);
    return out;
  }

  function worthTranslating(text, heading) {
    const latin = text.match(/[A-Za-zÀ-ɏ]/g)?.length || 0;
    if (latin < 2) return false;
    const cjk = text.match(/[぀-ヿ㐀-鿿가-힯豈-﫿]/g)?.length || 0;
    if (cjk > latin * 0.3) return false; // 已经是中文 / 日文 / 韩文为主
    const words = text.match(/[A-Za-zÀ-ɏ]{2,}/g)?.length || 0;
    if (heading) return words >= 1;
    if (words < 3 || text.length < 16) return false; // 按钮、标签之类的短文字
    const code = text.match(/[{}[\]();=<>$#*\\|`_]/g)?.length || 0;
    return code / text.length < 0.08;
  }

  function docOrder(a, b) {
    if (a.el === b.el) return 0;
    return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  function onMutate(muts) {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === Node.ELEMENT_NODE && !n.localName.startsWith('fbr-')) {
          clearTimeout(scanTimer);
          scanTimer = setTimeout(scan, 800);
          return;
        }
      }
    }
  }

  // ---------- 排队与请求：先译视口里的，再译下方的 ----------

  function onIntersect(entries) {
    if (S.fatal) return;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const seg = S.byEl.get(e.target);
      if (seg?.state === 'idle') enqueue(seg);
    }
    schedule();
  }

  function enqueue(seg) {
    seg.state = 'queued';
    showSlot(seg, 'loading');
    S.queue.push(seg);
  }

  function schedule() {
    while (S.active && !S.fatal && S.inflight < MAX_INFLIGHT && S.queue.length) send(takeBatch());
    panel.update();
  }

  function priority(seg) {
    const r = segRect(seg);
    const vh = innerHeight || 1;
    if (r.bottom >= 0 && r.top <= vh) return r.top / vh / 1000; // 在视口里：从上往下
    if (r.top > vh) return 1 + (r.top - vh) / vh; // 在下方：越近越先
    return 100 - r.bottom / vh; // 在上方：最后
  }

  function takeBatch() {
    const p = new Map(S.queue.map(seg => [seg, priority(seg)]));
    S.queue.sort((a, b) => p.get(a) - p.get(b));
    const batch = [];
    let chars = 0;
    while (S.queue.length && batch.length < BATCH_SEGS) {
      const next = S.queue[0];
      if (batch.length && chars + next.text.length > BATCH_CHARS) break;
      batch.push(S.queue.shift());
      chars += next.text.length;
    }
    return batch.sort(docOrder);
  }

  function send(batch) {
    let port;
    try {
      port = chrome.runtime.connect({ name: 'fbr' });
    } catch {
      // 扩展被重新加载后，旧页面里的脚本就和后台断开了
      const err = { fatal: true, message: '扩展刚更新过，请刷新页面后再打开双语' };
      setFatal(err);
      for (const seg of batch) failSeg(seg, err);
      return;
    }
    S.inflight++;
    S.ports.add(port);
    const pending = new Map(batch.map((seg, i) => [i + 1, seg]));
    for (const seg of batch) seg.state = 'loading';
    let finished = false;
    const finish = (err, reason) => {
      if (finished) return;
      finished = true;
      S.ports.delete(port);
      try {
        port.disconnect();
      } catch {}
      if (!S.active) return;
      S.inflight--;
      if (err?.fatal) setFatal(err);
      for (const seg of pending.values()) failSeg(seg, err, reason);
      schedule();
    };
    port.onMessage.addListener(msg => {
      if (msg.type === 'item') {
        const seg = pending.get(msg.id);
        if (!seg || !msg.zh) return;
        pending.delete(msg.id);
        seg.result = { zh: msg.zh, kws: msg.kws || [] };
        if (S.active && S.byEl.get(seg.el) === seg) render(seg);
      } else if (msg.type === 'done') {
        finish(null, msg.reason);
      } else if (msg.type === 'error') {
        finish(msg);
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      finish({ code: 'disconnected', message: '和后台的连接中断了', retryable: true });
    });
    port.postMessage({
      type: 'translate',
      title: document.title,
      segs: batch.map((seg, i) => ({ id: i + 1, text: seg.text, heading: seg.heading })),
    });
  }

  function failSeg(seg, err, reason) {
    if (S.byEl.get(seg.el) !== seg || seg.state === 'done') return;
    if (err?.fatal) {
      // 等用户处理完（比如充值），点“重试”再继续
      seg.state = 'idle';
      seg.slot?.remove();
      seg.slot = null;
      io?.observe(seg.el);
      return;
    }
    const filtered = reason === 'content_filter';
    if (!filtered && ++seg.tries < MAX_TRIES) {
      seg.state = 'queued';
      setTimeout(() => {
        if (S.active && S.byEl.get(seg.el) === seg && seg.state === 'queued') {
          S.queue.push(seg);
          schedule();
        }
      }, 1200 * seg.tries);
      return;
    }
    seg.state = 'failed';
    showSlot(seg, 'failed', filtered ? '这一段被模型拒绝翻译' : err?.message || '这一段没有翻译成功');
  }

  function setFatal(err) {
    S.fatal = { message: err.message || '翻译出错了' };
    for (const seg of S.queue) {
      seg.state = 'idle';
      seg.slot?.remove();
      seg.slot = null;
      io?.observe(seg.el);
    }
    S.queue = [];
    panel.update();
  }

  function retryAfterFatal() {
    S.fatal = null;
    // 重新观察一次，IntersectionObserver 会立刻回报视口附近的段落
    for (const seg of S.segs) {
      if (seg.state !== 'idle') continue;
      io?.unobserve(seg.el);
      io?.observe(seg.el);
    }
    panel.update();
  }

  // ---------- 渲染 ----------

  function ensureSlot(seg) {
    if (seg.slot?.isConnected) return seg.slot;
    const slot = document.createElement('fbr-t');
    slot.setAttribute('lang', 'zh-CN');
    slot.setAttribute('translate', 'no');
    slot.style.setProperty('--fbr-scale', String(S.cfg.fontScale || 1));
    if (seg.heading) slot.dataset.h = '';
    // <fbr-p> 是行内元素；flex / grid 容器里塞一个块会被排到旁边。这两种情况放到段落后面
    if (seg.el.localName === 'fbr-p' || (!seg.stopAt && /flex|grid/.test(getComputedStyle(seg.el).display))) {
      seg.el.after(slot);
      seg.outside = true;
    } else {
      seg.el.insertBefore(slot, seg.stopAt?.parentNode === seg.el ? seg.stopAt : null);
    }
    seg.slot = slot;
    return slot;
  }

  function showSlot(seg, state, message) {
    const slot = ensureSlot(seg);
    slot.dataset.state = state;
    slot.textContent = '';
    if (state !== 'failed') return;
    slot.append(message + ' ');
    const retry = document.createElement('fbr-retry');
    retry.setAttribute('role', 'button');
    retry.tabIndex = 0;
    retry.textContent = '重试';
    const go = e => {
      e.preventDefault();
      e.stopPropagation();
      seg.tries = 0;
      enqueue(seg);
      schedule();
    };
    retry.addEventListener('click', go);
    retry.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') go(e);
    });
    slot.append(retry);
  }

  function render(seg) {
    seg.state = 'done';
    const slot = ensureSlot(seg);
    slot.dataset.state = 'done';
    slot.textContent = seg.result.zh;
    const terms = seg.result.kws.slice(0, 8).map(([en, zh], i) => ({ en, zh, pair: `${seg.id}-${i}`, color: i % PALETTE, core: i === 0 }));
    if (!seg.marked) {
      highlight(runItems(seg), terms.map(t => ({ ...t, text: t.en, title: t.zh })), true);
      seg.marked = true;
    }
    highlight([...slot.childNodes], terms.map(t => ({ ...t, text: t.zh, title: t.en })), false);
    panel.update();
  }

  // ---------- 重心词高亮 ----------

  // items：文本节点（或代表换行的空格字符串）；terms：要标的词；boundary：英文按整词匹配
  function highlight(items, terms, boundary) {
    let raw = '';
    const starts = [];
    for (const it of items) {
      starts.push(raw.length);
      raw += typeof it === 'string' ? it : it.data;
    }
    const { norm, map } = normalizeWithMap(raw);
    const taken = [];
    const pieces = [];
    for (const t of terms) {
      const q = fold(collapse(t.text || ''));
      if (!q) continue;
      const hit = findTerm(norm, q, taken, boundary) || (boundary ? null : fuzzyTerm(norm, q, taken));
      if (!hit) continue;
      taken.push(hit);
      const rs = map[hit[0]];
      const re = map[hit[1] - 1] + 1;
      items.forEach((it, i) => {
        if (typeof it === 'string') return;
        const s = Math.max(rs, starts[i]) - starts[i];
        const e = Math.min(re, starts[i] + it.data.length) - starts[i];
        if (s < e) pieces.push({ node: it, i, s, e, t });
      });
    }
    // 从后往前包，前面的偏移量就不会失效
    pieces.sort((a, b) => b.i - a.i || b.s - a.s);
    for (const p of pieces) wrap(p.node, p.s, p.e, p.t);
  }

  function findTerm(hay, q, taken, boundary) {
    for (let from = 0; ; ) {
      const i = hay.indexOf(q, from);
      if (i < 0) return null;
      from = i + 1;
      let j = i + q.length;
      if (boundary) {
        if (WORD.test(q[0]) && i > 0 && WORD.test(hay[i - 1])) continue;
        if (WORD.test(q[q.length - 1]) && WORD.test(hay[j] || '')) {
          // 允许 model → models / modeling 这类词尾变化
          let k = j;
          while (k < hay.length && k - j < 3 && WORD.test(hay[k])) k++;
          if (WORD.test(hay[k] || '')) continue;
          j = k;
        }
      }
      if (taken.some(([a, b]) => i < b && a < j)) continue;
      return [i, j];
    }
  }

  // 译文里找不到原样的中文重心词时（模型偶尔会改写，如“知识的前沿”对“知识的某个前沿”），
  // 在同一句里找字符重合最多的一小段：首尾都是重心词里的字，最多比它长 3 个字
  function fuzzyTerm(hay, q, taken) {
    const chars = q.replace(/ /g, '');
    if (chars.length < 2) return null;
    const want = new Map();
    for (const ch of chars) want.set(ch, (want.get(ch) || 0) + 1);
    let best = null;
    for (let i = 0; i < hay.length; i++) {
      if (!want.has(hay[i])) continue;
      const left = new Map(want);
      let hit = 0;
      for (let j = i; j < hay.length && j - i < chars.length + 3 && !SENTENCE_END.test(hay[j]); j++) {
        if (!left.get(hay[j])) continue;
        left.set(hay[j], left.get(hay[j]) - 1);
        hit++;
        const score = (2 * hit) / (chars.length + j - i + 1);
        if (hit >= 2 && hit >= chars.length * 0.6 && score >= 0.6 && (!best || score > best.score) && !taken.some(([a, b]) => i < b && a <= j)) {
          best = { score, at: [i, j + 1] };
        }
      }
    }
    return best?.at || null;
  }

  function wrap(node, s, e, t) {
    let target = node;
    if (s > 0) {
      target = node.splitText(s);
      SPLIT.add(target);
    }
    if (e - s < target.data.length) SPLIT.add(target.splitText(e - s));
    const k = document.createElement('fbr-k');
    k.dataset.c = String(t.color);
    k.dataset.pair = t.pair;
    if (t.core) k.dataset.core = '';
    if (t.title) k.title = t.title;
    target.before(k);
    k.append(target);
  }

  function unwrapMarks() {
    const parents = new Set();
    for (const k of document.querySelectorAll('fbr-k')) {
      if (!k.parentNode) continue;
      parents.add(k.parentNode);
      k.replaceWith(...k.childNodes);
    }
    // 把我们拆开的文本节点合并回去，页面 DOM 恢复原样
    for (const p of parents) {
      for (let c = p.firstChild; c; ) {
        const next = c.nextSibling;
        if (c.nodeType === Node.TEXT_NODE && SPLIT.has(c) && c.previousSibling?.nodeType === Node.TEXT_NODE) {
          c.previousSibling.appendData(c.data);
          c.remove();
        }
        c = next;
      }
    }
  }

  function collapse(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) if (!INVIS.test(s[i])) out += s[i];
    return out.replace(/\s+/g, ' ').trim();
  }

  function foldChar(ch) {
    if (FOLD[ch]) return FOLD[ch];
    const lower = ch.toLowerCase();
    return lower.length === 1 ? lower : ch;
  }

  function fold(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) out += foldChar(s[i]);
    return out;
  }

  // 与 collapse + fold 等价，同时记下每个字符在原始字符串里的位置
  function normalizeWithMap(raw) {
    let norm = '';
    const map = [];
    let space = -1;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (INVIS.test(ch)) continue;
      if (SPACE.test(ch)) {
        if (norm && space < 0) space = i;
        continue;
      }
      if (space >= 0) {
        norm += ' ';
        map.push(space);
        space = -1;
      }
      norm += foldChar(ch);
      map.push(i);
    }
    return { norm, map };
  }

  // 鼠标指向某个重心词时，同时点亮它在原文 / 译文里的另一半
  function onHover(e) {
    const k = e.target instanceof Element ? e.target.closest('fbr-k') : null;
    const pair = k?.dataset.pair || null;
    if (pair === S.hotPair) return;
    for (const m of document.querySelectorAll('fbr-k[data-hot]')) delete m.dataset.hot;
    S.hotPair = pair;
    if (pair) for (const m of document.querySelectorAll(`fbr-k[data-pair="${pair}"]`)) m.dataset.hot = '';
  }

  // ---------- 阅读位置与专注模式 ----------

  function segRect(seg) {
    let r;
    if (seg.stopAt && seg.stopAt.parentNode === seg.el) {
      const range = document.createRange();
      range.setStart(seg.el, 0);
      range.setEndBefore(seg.stopAt);
      r = range.getBoundingClientRect();
    } else {
      r = seg.el.getBoundingClientRect();
    }
    if (seg.outside && seg.slot?.isConnected) {
      const s = seg.slot.getBoundingClientRect();
      r = new DOMRect(Math.min(r.left, s.left), r.top, Math.max(r.right, s.right) - Math.min(r.left, s.left), s.bottom - r.top);
    }
    return r;
  }

  // 判定线所在（或刚越过它）的那一段
  function currentIndex() {
    const line = innerHeight * READING_LINE;
    let lo = 0;
    let hi = S.segs.length - 1;
    let ans = S.segs.length ? 0 : -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segRect(S.segs[mid]).top <= line) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  function onScroll() {
    if (!rafId) rafId = requestAnimationFrame(updateReading);
  }

  function updateReading() {
    cancelAnimationFrame(rafId);
    rafId = 0;
    if (!S.active) return;
    const i = currentIndex();
    if (i !== S.cur) {
      S.cur = i;
      panel.update();
    }
    if (!spot) return;
    const seg = S.segs[i];
    const r = seg && segRect(seg);
    if (!r || !r.height) {
      spot.style.opacity = '0';
      return;
    }
    if (seg !== spotSeg) {
      // 换段时平滑移过去；同一段内跟随滚动，不加过渡
      spotSeg = seg;
      spot.dataset.move = '';
      clearTimeout(spot.moveTimer);
      spot.moveTimer = setTimeout(() => spot && delete spot.dataset.move, 220);
    }
    const pad = 10;
    Object.assign(spot.style, {
      opacity: '1',
      top: `${r.top - pad}px`,
      left: `${r.left - pad}px`,
      width: `${r.width + pad * 2}px`,
      height: `${r.height + pad * 2}px`,
    });
  }

  function setFocus(on) {
    S.focus = on;
    if (on && !spot) {
      spot = document.createElement('fbr-spot');
      spot.dataset.theme = pageIsDark() ? 'dark' : 'light';
      document.documentElement.append(spot);
      spotSeg = null;
    } else if (!on && spot) {
      spot.remove();
      spot = null;
    }
    updateReading();
    panel.update();
  }

  function pageIsDark() {
    for (const el of [document.body, document.documentElement]) {
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (!m) continue;
      const [r, g, b, a = 1] = m.map(Number);
      if (a < 0.5) continue;
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.45;
    }
    return false;
  }

  // ---------- 右下角的小面板 ----------

  const PANEL_CSS = `
    :host { all: initial; }
    .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      font: 13px/1.4 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
    .wrap[data-theme="light"] { --bg: rgba(255,255,255,.96); --fg: #2b2f36; --line: rgba(15,23,42,.1);
      --btn: rgba(15,23,42,.06); --btn-hover: rgba(15,23,42,.12); --accent: #5b6ee1; --on-accent: #fff; --ok: #3aa864; --bad: #d9534f; }
    .wrap[data-theme="dark"] { --bg: rgba(32,34,40,.96); --fg: #e6e7ea; --line: rgba(255,255,255,.12);
      --btn: rgba(255,255,255,.08); --btn-hover: rgba(255,255,255,.16); --accent: #8b9cf6; --on-accent: #15171c; --ok: #5cc982; --bad: #ef7d7a; }
    .pill { position: relative; display: flex; align-items: center; gap: 6px; padding: 5px 5px 5px 12px;
      color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 999px;
      box-shadow: 0 6px 20px rgba(0,0,0,.12); overflow: hidden; }
    .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
    .pill[data-busy] .dot { background: var(--accent); }
    .pill[data-error] .dot { background: var(--bad); }
    .text { margin-right: 4px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    button { all: unset; box-sizing: border-box; padding: 4px 10px; border-radius: 999px; background: var(--btn);
      color: var(--fg); font-size: 12px; line-height: 1.4; cursor: pointer; white-space: nowrap; }
    button:hover { background: var(--btn-hover); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    button[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); }
    .bar { position: absolute; left: 0; bottom: 0; height: 2px; width: 0; background: var(--accent); opacity: .7; }
    .err { max-width: 300px; padding: 10px 12px; color: var(--fg); background: var(--bg); border: 1px solid var(--line);
      border-left: 3px solid var(--bad); border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.12); }
    .err[hidden] { display: none; }
    .err p { margin: 0 0 8px; }
    .err .row { display: flex; justify-content: flex-end; gap: 6px; }
    @media (prefers-reduced-motion: no-preference) { .bar { transition: width .3s ease; } }
  `;

  const panel = (() => {
    let host = null;
    let ui = null;
    function mount() {
      if (host) return;
      host = document.createElement('fbr-panel');
      host.setAttribute('translate', 'no');
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>${PANEL_CSS}</style>
        <div class="wrap" data-theme="${pageIsDark() ? 'dark' : 'light'}">
          <div class="err" role="alert" hidden>
            <p class="msg"></p>
            <div class="row"><button class="settings" type="button">打开设置</button><button class="retry" type="button">重试</button></div>
          </div>
          <div class="pill">
            <span class="dot"></span>
            <span class="text">准备中…</span>
            <button class="focus" type="button" aria-pressed="false" title="专注模式：淡化当前段落以外的内容">专注</button>
            <button class="close" type="button" aria-label="关闭双语" title="关闭双语（Alt+T）">✕</button>
            <span class="bar"></span>
          </div>
        </div>`;
      const $ = sel => root.querySelector(sel);
      ui = { pill: $('.pill'), text: $('.text'), bar: $('.bar'), focus: $('.focus'), err: $('.err'), msg: $('.msg') };
      ui.focus.addEventListener('click', () => setFocus(!S.focus));
      $('.close').addEventListener('click', deactivate);
      $('.retry').addEventListener('click', retryAfterFatal);
      $('.settings').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openOptions' }).catch(() => {}));
      document.documentElement.append(host);
    }
    function unmount() {
      host?.remove();
      host = ui = null;
    }
    function update() {
      if (!ui) return;
      const total = S.segs.length;
      const busy = S.inflight > 0 || S.queue.length > 0;
      const cur = Math.min(Math.max(S.cur, 0) + 1, total);
      ui.text.textContent = total ? `第 ${cur} / ${total} 段${busy ? ' · 翻译中' : ''}` : '这页没找到需要翻译的英文段落';
      ui.pill.toggleAttribute('data-busy', busy);
      ui.pill.toggleAttribute('data-error', !!S.fatal);
      ui.bar.style.width = total ? `${(cur / total) * 100}%` : '0';
      ui.focus.setAttribute('aria-pressed', String(S.focus));
      ui.err.hidden = !S.fatal;
      ui.msg.textContent = S.fatal?.message || '';
    }
    return { mount, unmount, update };
  })();

  window.__fbr = {
    toggle,
    setFocus: on => setFocus(on ?? !S.focus),
    debug: () => ({
      active: S.active,
      segs: S.segs.length,
      done: S.segs.filter(s => s.state === 'done').length,
      failed: S.segs.filter(s => s.state === 'failed').length,
      queue: S.queue.length,
      inflight: S.inflight,
      fatal: S.fatal,
      focus: S.focus,
      cur: S.cur,
    }),
  };
  activate();
})();
