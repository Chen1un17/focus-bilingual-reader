// 设置页：改动后自动保存
const DEFAULTS = {
  apiKey: '',
  model: 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com',
  density: 'medium',
  fontScale: 1,
  focusDefault: false,
};
const PRESET_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
const $ = id => document.getElementById(id);

let savedTimer = 0;
async function save(patch) {
  await chrome.storage.local.set(patch);
  $('saved').textContent = '✓ 已自动保存';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($('saved').textContent = ''), 1800);
}

function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function setStatus(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${ok === undefined ? '' : ok ? 'ok' : 'bad'}`;
}

function modelValue() {
  return $('model').value === 'custom' ? $('customModel').value.trim() : $('model').value;
}

function baseUrlValue() {
  const raw = $('baseUrl').value.trim().replace(/\/+$/, '');
  return raw || DEFAULTS.baseUrl;
}

function originPattern(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? `${u.origin}/*` : null;
  } catch {
    return null;
  }
}

function applyDemoScale(scale) {
  $('demoT').style.setProperty('--fbr-scale', String(scale));
}

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $('apiKey').value = s.apiKey;
  if (PRESET_MODELS.includes(s.model)) {
    $('model').value = s.model;
  } else {
    $('model').value = 'custom';
    $('customModel').value = s.model;
    $('customModel').hidden = false;
  }
  if (s.baseUrl !== DEFAULTS.baseUrl) {
    $('baseUrl').value = s.baseUrl;
    $('baseUrl').closest('details').open = true;
  }
  const pick = (name, value, fallback) =>
    (document.querySelector(`input[name="${name}"][value="${value}"]`) || document.querySelector(`input[name="${name}"][value="${fallback}"]`)).checked = true;
  pick('density', s.density, DEFAULTS.density);
  pick('fontScale', s.fontScale, DEFAULTS.fontScale);
  $('focusDefault').checked = !!s.focusDefault;
  applyDemoScale(s.fontScale);

  const cmd = (await chrome.commands.getAll()).find(c => c.name === '_execute_action');
  $('shortcut').textContent = cmd?.shortcut || '未设置';
  refreshCache();
}

async function refreshCache() {
  const info = await chrome.runtime.sendMessage({ type: 'cacheInfo' }).catch(() => null);
  $('cacheCount').textContent = info ? String(info.count) : '?';
}

// ---------- 连接 ----------

$('apiKey').addEventListener('input', debounce(() => save({ apiKey: $('apiKey').value.trim() }), 400));

$('toggleKey').addEventListener('click', () => {
  const show = $('apiKey').type === 'password';
  $('apiKey').type = show ? 'text' : 'password';
  $('toggleKey').textContent = show ? '隐藏' : '显示';
});

$('model').addEventListener('change', () => {
  const custom = $('model').value === 'custom';
  $('customModel').hidden = !custom;
  if (custom) $('customModel').focus();
  else save({ model: $('model').value });
});

$('customModel').addEventListener('input', debounce(() => {
  const m = $('customModel').value.trim();
  if (m) save({ model: m });
}, 400));

// 非默认域名需要用户点击授权（浏览器要求权限申请必须由点击触发）
async function applyBaseUrl() {
  const url = baseUrlValue();
  const pattern = originPattern(url);
  $('grant').hidden = true;
  if (!pattern) {
    setStatus('testResult', 'API 地址格式不对，应以 https:// 开头', false);
    return;
  }
  if (await chrome.permissions.contains({ origins: [pattern] })) {
    await save({ baseUrl: url });
    return;
  }
  $('grant').textContent = `授权访问 ${new URL(url).host}`;
  $('grant').hidden = false;
  setStatus('testResult', '这个地址需要先授权才能使用', false);
}
$('baseUrl').addEventListener('change', applyBaseUrl);

$('grant').addEventListener('click', async () => {
  const url = baseUrlValue();
  const granted = await chrome.permissions.request({ origins: [originPattern(url)] });
  if (!granted) {
    setStatus('testResult', '没有获得授权，仍使用原来的地址', false);
    return;
  }
  $('grant').hidden = true;
  setStatus('testResult', '');
  await save({ baseUrl: url });
});

$('test').addEventListener('click', async () => {
  $('test').disabled = true;
  setStatus('testResult', '正在连接…');
  const res = await chrome.runtime
    .sendMessage({ type: 'test', settings: { apiKey: $('apiKey').value.trim(), model: modelValue(), baseUrl: baseUrlValue() } })
    .catch(err => ({ ok: false, message: err.message }));
  setStatus('testResult', res.message, res.ok);
  $('test').disabled = false;
});

// ---------- 阅读偏好 ----------

for (const r of document.querySelectorAll('input[name="density"]')) {
  r.addEventListener('change', () => save({ density: r.value }));
}
for (const r of document.querySelectorAll('input[name="fontScale"]')) {
  r.addEventListener('change', () => {
    applyDemoScale(r.value);
    save({ fontScale: Number(r.value) });
  });
}
$('focusDefault').addEventListener('change', () => save({ focusDefault: $('focusDefault').checked }));

// 预览里也演示“指向一个词，另一半同时亮起”
const demo = document.querySelector('.demo');
const clearHot = () => demo.querySelectorAll('fbr-k[data-hot]').forEach(m => delete m.dataset.hot);
demo.addEventListener('mouseover', e => {
  clearHot();
  const k = e.target.closest('fbr-k');
  if (k) demo.querySelectorAll(`fbr-k[data-pair="${k.dataset.pair}"]`).forEach(m => (m.dataset.hot = ''));
});
demo.addEventListener('mouseleave', clearHot);

// ---------- 快捷键与缓存 ----------

$('editShortcut').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

$('clearCache').addEventListener('click', async () => {
  if (!confirm('清除后，再打开读过的页面需要重新翻译（会再次计费）。确定清除吗？')) return;
  const info = await chrome.runtime.sendMessage({ type: 'clearCache' }).catch(() => null);
  $('cacheCount').textContent = info ? String(info.count) : '?';
});

load();
