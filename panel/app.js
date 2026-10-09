/* opencodez-free · 面板前端逻辑
 *
 * 设计语言与 workbuddy-free 一致（PIXEL OPS）；本服务无账号体系，
 * 「账号池」改为「运行概览」、「任务中心」改为「诊断中心」。
 */
'use strict';

/* ── 状态 ─────────────────────────────────────────────────────────── */
const LS_KEY = 'o2f.key', LS_THEME = 'o2f.theme';
let theme = localStorage.getItem(LS_THEME) || 'auto';   // auto | light | dark
let view = 'overview';
let cfgLoaded = null;
let logPin = true, logCh = 'all', logSince = null;
let refTimer = null, probeTimer = null;
// 统计页状态提到顶层：首屏直接以 #stats 进入时 go() 会立刻调用 loadStats，
// 若声明在文件后段（let 不提升）会撞上暂时性死区。
let statsRng = '30d', statsData = null;
// 图表当前的点位与峰值：读数槽、悬停高亮、错误降级态都要读这几个。
let chartPts = [], chartPeak = null, chartPeakIdx = -1;
// 概览与目录的最近一次响应，供多处渲染复用。
let overviewData = null, modelsData = null;

const $ = id => document.getElementById(id);

/* ── 主题 ─────────────────────────────────────────────────────────── */
function effTheme() {
  return theme === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
}
function applyTheme() {
  const eff = effTheme();
  document.documentElement.dataset.theme = eff;
  $('icoTheme').innerHTML = eff === 'light'
    ? '<circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M12.8 3.2l-1.4 1.4M4.6 11.4l-1.4 1.4"/>'
    : '<path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z"/>';
  $('btnTheme').title = eff === 'light' ? '切换到深色' : '切换到浅色';
}
addEventListener('change', applyTheme);
$('btnTheme').onclick = () => {
  theme = effTheme() === 'light' ? 'dark' : 'light';
  localStorage.setItem(LS_THEME, theme);
  applyTheme();
};
applyTheme();

/* ── 请求 ─────────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const h = Object.assign({}, opts.headers || {});
  const k = localStorage.getItem(LS_KEY);
  if (k) h['Authorization'] = 'Bearer ' + k;
  if (opts.body) h['Content-Type'] = 'application/json';
  const r = await fetch('/panel/api/' + path, Object.assign({}, opts, { headers: h }));
  if (r.status === 401) { openKey(); throw new Error('密钥无效或未填写'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}
function toast(msg, cls) {
  const el = document.createElement('div');
  el.className = 'tst ' + (cls || '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}
// esc 文本/属性双安全转义。不能只用 div.innerHTML（它转义 <>& 但不转义引号），
// 否则字符串拼进 HTML 属性时引号可闭合属性并注入事件处理器。
// 显式替换 5 个字符：& < > " '（& 必须最先，避免二次转义）。
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function ago(iso) {
  if (!iso || iso.startsWith('0001-')) return '—';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 0) return '刚刚';
  if (s < 60) return Math.floor(s) + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}
function dur(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  if (d) return d + '天' + String(h).padStart(2, '0') + '时';
  return h ? h + '时' + String(m).padStart(2, '0') + '分' : m ? m + '分' + String(s).padStart(2, '0') + '秒' : s + '秒';
}

// formatTokenCount 中文数量级：万 / 亿 / 万亿（步进 1e4，与国内读数习惯一致）。
// 一万以下走千分位；四舍五入后越界就升级单位，避免出现"10000万"这种写法。
function formatTokenCount(tokens) {
  if (tokens == null || tokens === '') return '—';
  const n = Number(tokens);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1e4) return formatInt(n);
  const units = [['万', 1e4], ['亿', 1e8], ['万亿', 1e12]];
  let unit = units[0];
  for (const candidate of units) {
    if (n >= candidate[1]) unit = candidate;
  }
  let rounded = Number((n / unit[1]).toFixed(1));
  const next = units[units.indexOf(unit) + 1];
  if (next && rounded >= 1e4) {
    unit = next;
    rounded = Number((n / unit[1]).toFixed(1));
  }
  return rounded + unit[0];
}
function formatInt(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('en-US');
}
function formatLatency(ms) {
  if (ms == null || ms === '') return '—';
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n < 1000 ? Math.round(n) + 'ms' : (n / 1000).toFixed(1).replace(/\.0$/, '') + 's';
}
function formatRate(rate) {
  if (rate == null || rate === '') return '—';
  const n = Number(rate);
  if (!Number.isFinite(n) || n < 0) return '—';
  return n.toFixed(1) + 'tok/s';
}

/* ── 密钥门 ───────────────────────────────────────────────────────── */
function openKey() {
  $('keyVeil').classList.add('on');
  // Deliberately no api() call here: this dialog is opened *because* a request
  // returned 401, so another authenticated call would 401 and recurse. The hint
  // text carries the default path instead; a custom path is printed at startup.
  setTimeout(() => $('keyInput').focus(), 60);
}
$('btnKey').onclick = async () => {
  const v = $('keyInput').value.trim();
  if (!v) return;
  localStorage.setItem(LS_KEY, v);
  try {
    await api('overview');
    $('keyErr').hidden = true;
    $('keyVeil').classList.remove('on');
    start();
  } catch (e) { $('keyErr').hidden = false; }
};
$('keyInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnKey').click(); });

/* ── 路由 ─────────────────────────────────────────────────────────── */
const TITLES = { overview: '运行概览', stats: '用量统计', diagnostics: '诊断中心', models: '模型与档位', config: '配置', logs: '运行日志' };
function go(v) {
  if (!TITLES[v]) v = 'overview';
  view = v;
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', a.dataset.view === v));
  document.querySelectorAll('.view').forEach(s => { s.hidden = s.id !== 'view-' + v; });
  $('ttl').textContent = TITLES[v];
  $('navSub').textContent = TITLES[v];
  $('btnProbeAll').hidden = v === 'config';
  location.hash = v;
  // 侧栏状态与顶栏副标题来自 overview，非概览视图下也要取一次——
  // 否则直接落在 #stats 时它们会停在"连接中 / -"。
  if (view !== 'overview') loadStatus();
  if (v === 'overview') loadOverview();
  if (v === 'stats') loadStats();
  if (v === 'diagnostics') loadProbe();
  if (v === 'models') loadModels();
  if (v === 'config') loadConfig();
  if (v === 'logs') loadLogs();
}

/** The chrome (nav pulse, version, uptime, topbar meta) without a view's data. */
async function loadStatus() {
  try {
    const d = await api('overview');
    overviewData = d;
    $('navPulse').className = 'pulse';
    $('navState').textContent = '服务正常';
    $('navVer').textContent = 'v' + d.service.version;
    $('navUp').textContent = '已运行 ' + dur(d.service.uptime_seconds);
    $('subMeta').textContent = d.service.base_url.replace('/v1', '') + ' · 运行 ' + dur(d.service.uptime_seconds);
  } catch (e) {
    $('navPulse').className = 'pulse bad';
    $('navState').textContent = '连接失败';
  }
}
document.querySelectorAll('.nav a').forEach(a => {
  a.onclick = ev => { ev.preventDefault(); go(a.dataset.view); };
});
addEventListener('hashchange', () => go(location.hash.slice(1)));

/* ── 概览 ─────────────────────────────────────────────────────────── */
async function loadOverview(quiet) {
  let d;
  try {
    d = await api('overview');
  } catch (e) {
    if (!quiet) toast(e.message, 'err');
    $('navPulse').className = 'pulse bad';
    $('navState').textContent = '连接失败';
    return;
  }
  overviewData = d;
  $('navPulse').className = 'pulse';
  $('navState').textContent = '服务正常';
  $('navVer').textContent = 'v' + d.service.version;
  $('navUp').textContent = '已运行 ' + dur(d.service.uptime_seconds);
  $('subMeta').textContent = d.service.base_url.replace('/v1', '') + ' · 运行 ' + dur(d.service.uptime_seconds);

  $('sModels').textContent = d.catalog.exposed;
  $('sLifetime').textContent = formatTokenCount(d.usage.total_tokens);
  $('sRequests').textContent = formatInt(d.usage.requests);
  $('sFailed').textContent = formatInt(d.usage.failed);
  $('sFailCell').className = 'stat' + (d.usage.failed > 0 ? ' bad' : '');
  $('sUptime').textContent = dur(d.service.uptime_seconds);
  const okCount = d.probe.results.ok;
  const failCount = d.probe.results.fail;
  $('sProbe').textContent = okCount + failCount > 0 ? okCount + '/' + (okCount + failCount) : '未实测';
  $('sProbeCell').className = 'stat' + (failCount > 0 ? ' warn' : okCount > 0 ? ' good' : '');

  $('svcBase').value = d.service.base_url;
  $('svcPanel').value = location.origin + '/panel/';
  $('svcConfig').value = d.service.config_path;
  // The key is fetched separately (it is generated, so it lives outside the
  // config file); the overview only tells us whether auth is on.
  loadKeyInto($('svcKey'), $('svcKeyHint'));
  $('svcNote').textContent = 'v' + d.service.version;

  $('cExposed').textContent = d.catalog.exposed;
  $('cLive').textContent = d.catalog.live;
  $('cStatus').textContent = { ready: '就绪', pending: '获取中', stale: '已过期', error: '错误' }[d.catalog.status] || d.catalog.status;
  $('cRefresh').textContent = d.catalog.last_refresh ? ago(d.catalog.last_refresh) : '—';
  $('catNote').textContent = d.catalog.expose_all ? '已开启全部在线模型' : '仅暴露免费模型';
  $('catErr').hidden = !d.catalog.last_error;
  if (d.catalog.last_error) $('catErrText').textContent = '目录获取失败：' + d.catalog.last_error;

  renderRecent(d.recent);
}

function renderRecent(list) {
  const tb = $('recentBody');
  if (!list || !list.length) {
    tb.innerHTML = '<tr><td colspan="8"><div class="empty"><div class="big">还没有请求</div><div>客户端发起第一次调用后，这里会显示每一条请求的耗时与用量。</div></div></td></tr>';
    return;
  }
  tb.innerHTML = list.map(r => {
    const total = (r.prompt_tokens || 0) + (r.completion_tokens || 0);
    const rate = r.duration_ms > 0 ? (r.completion_tokens || 0) / (r.duration_ms / 1000) : 0;
    const bad = r.status >= 400 || r.error;
    return '<tr class="' + (bad ? 'off' : '') + '">' +
      '<td class="mark"><i></i></td>' +
      '<td class="num">' + esc(ago(r.time)) + '</td>' +
      '<td><div class="who"><div class="nm" title="' + esc(r.model) + '">' + esc(r.model) + '</div>' +
      '<div class="id">' + (r.streaming ? '流式' : '非流式') + (r.session ? ' · ' + esc(String(r.session).slice(0, 18)) : '') + '</div></div></td>' +
      '<td>' + (bad
        ? '<span class="tag bad" title="' + esc(r.error || '') + '">失败</span>'
        : '<span class="tag ok">成功</span>') + '</td>' +
      '<td class="usage-cell"><span class="usage-line">' +
        '<span class="usage-item usage-count"><b>' + formatTokenCount(r.prompt_tokens) + '</b><em>入</em></span>' +
        '<span class="usage-item usage-total"><b>' + formatTokenCount(r.completion_tokens) + '</b><em>出</em></span>' +
        '<span class="usage-item"><b>' + formatTokenCount(total) + '</b><em>总</em></span>' +
      '</span></td>' +
      '<td class="num">' + (r.ttft_ms != null ? '<span class="tag mute">' + formatLatency(r.ttft_ms) + '</span>' : '—') + '</td>' +
      '<td class="num">' + formatLatency(r.duration_ms) + '</td>' +
      '<td class="num">' + (rate > 0 ? '<span class="tag ok">' + formatRate(rate) + '</span>' : '—') + '</td>' +
      '</tr>';
  }).join('');
}

$('btnRecentClear').onclick = async () => {
  try {
    await api('stats/reset', { method: 'POST', body: '{}' });
    renderRecent([]);
    toast('已清空显示（不影响累计用量）', 'ok');
  } catch (e) { toast(e.message, 'err'); }
};

$('btnCatalogRefresh').onclick = async () => {
  try {
    await api('models');
    await loadOverview();
    toast('目录已刷新', 'ok');
  } catch (e) { toast(e.message, 'err'); }
};

/* ── 接入说明 ─────────────────────────────────────────────────────── */
function guideTexts() {
  const base = (overviewData && overviewData.service.base_url) || (location.origin + '/v1');
  // The agent key is the one an integration needs; the panel key is for this UI.
  const agent = agentOf(authInfo);
  const key = agent.enabled ? agent.key : '';
  const auth = key ? ' -H "Authorization: Bearer ' + key + '"' : '';
  const model = (modelsData && modelsData.data && modelsData.data[0] && modelsData.data[0].id) || 'mimo-v2.6-flash-free';
  return {
    curl: 'curl ' + base + '/chat/completions \\\n' +
      '  -H "content-type: application/json"' + auth + ' \\\n' +
      '  -d \'{"model":"' + model + '","messages":[{"role":"user","content":"你好"}]}\'',
    py: 'from openai import OpenAI\n\n' +
      'client = OpenAI(\n' +
      '    base_url="' + base + '",\n' +
      '    api_key="' + (key || 'not-needed') + '",\n' +
      ')\n\n' +
      'resp = client.chat.completions.create(\n' +
      '    model="' + model + '",\n' +
      '    messages=[{"role": "user", "content": "你好"}],\n' +
      ')\n' +
      'print(resp.choices[0].message.content)',
    models: ((modelsData && modelsData.data) || []).map(m => m.id).join('\n'),
  };
}
async function openGuide() {
  if (!modelsData) { try { await loadModels(true); } catch (e) { /* 目录可选 */ } }
  await fetchAuth();
  const t = guideTexts();
  const base = (overviewData && overviewData.service.base_url) || (location.origin + '/v1');
  $('guideBase').textContent = base;
  const agent = agentOf(authInfo);
  $('guideKey').textContent = agent.enabled ? agent.key : '（当前未启用鉴权，随便填）';
  $('guideCurl').textContent = t.curl;
  $('guidePy').textContent = t.py;
  $('guideModels').textContent = t.models || '（目录尚未就绪，请稍后重试）';
  $('guideVeil').classList.add('on');
}
$('btnShowGuide').onclick = openGuide;
$('btnCloseGuide').onclick = () => $('guideVeil').classList.remove('on');
$('btnGuideCopy').onclick = () => copy($('guideBase').textContent, 'Base URL');
$('btnCopyBase').onclick = () => copy($('svcBase').value, 'Base URL');
$('btnCopyKey').onclick = async () => {
  const agent = agentOf(await fetchAuth());
  if (!agent.enabled) return toast('当前未启用鉴权，无需密钥', 'err');
  copy(agent.key, 'Agent 密钥');
};
$('btnCopyCurl').onclick = async () => { await openGuide(); copy($('guideCurl').textContent, '调用示例'); };
function copy(text, what) {
  navigator.clipboard.writeText(text)
    .then(() => toast('已复制' + what, 'ok'))
    .catch(() => toast('复制失败，请手动选择', 'err'));
}
$('probeVeil').onclick = ev => { if (ev.target === $('probeVeil')) $('probeVeil').classList.remove('on'); };
$('btnCloseProbe').onclick = () => $('probeVeil').classList.remove('on');
$('guideVeil').onclick = ev => { if (ev.target === $('guideVeil')) $('guideVeil').classList.remove('on'); };

/* ── 数字动效 ─────────────────────────────────────────────────────── */
/* 观测数字滚动到终值：只作用于统计页与概览的观测条，表格数字不参与
   （表格每几秒重绘，跟着跳会让人没法读）。 */
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const easeOut = p => 1 - Math.pow(1 - p, 3);
const FMT = {
  tok: formatTokenCount,
  int: formatInt,
  lat: formatLatency,
  rate: formatRate,
};
function tween(duration, fn, done) {
  if (reduceMotion.matches) { fn(1); if (done) done(); return; }
  const started = performance.now();
  const step = now => {
    const p = Math.min(1, (now - started) / duration);
    fn(easeOut(p));
    if (p < 1) requestAnimationFrame(step);
    else if (done) done();
  };
  requestAnimationFrame(step);
}
function setNum(el, value, fmt) {
  if (!el) return;
  el.dataset.to = String(value ?? '');
  el.dataset.fmt = fmt;
  if (value == null || value === '') { el.textContent = '—'; return; }
  el.textContent = FMT[fmt](value);
}

/* ── 用量统计 ─────────────────────────────────────────────────────── */
function syncRangeChips() {
  document.querySelectorAll('#rngChips .chip').forEach(c => c.classList.toggle('on', c.dataset.rng === statsRng));
}
$('rngChips').addEventListener('click', ev => {
  const c = ev.target.closest('.chip');
  if (!c) return;
  statsRng = c.dataset.rng;
  syncRangeChips();
  loadStats();
});

async function loadStats(quiet) {
  let d;
  try {
    d = await api('stats?range=' + encodeURIComponent(statsRng));
  } catch (e) {
    if (!quiet) toast(e.message, 'err');
    return;
  }
  statsData = d;
  renderStats(d);
}

function renderStats(d) {
  const lt = d.summary.lifetime;
  setNum($('ltTotal'), lt.total_tokens, 'tok');
  setNum($('ltPrompt'), lt.prompt_tokens, 'tok');
  setNum($('ltCompletion'), lt.completion_tokens, 'tok');
  setNum($('ltRequests'), lt.requests, 'int');
  setNum($('ltFailed'), lt.failed, 'int');
  $('ltFoot').textContent = lt.requests > 0
    ? '自 ' + String(lt.since || '').slice(0, 10) + ' 首次请求起累计，不随保留窗口缩减；明细保留 ' + d.summary.keepDays + ' 天'
    : '还没有任何请求记录，客户端首次调用后开始累计';

  const t = d.totals;
  setNum($('stTotal'), t.total_tokens, 'tok');
  setNum($('stPrompt'), t.prompt_tokens, 'tok');
  setNum($('stCompletion'), t.completion_tokens, 'tok');
  setNum($('stRequests'), t.requests, 'int');
  setNum($('stFailed'), t.failed, 'int');
  const rate = t.requests > 0 ? (t.failed / t.requests * 100) : 0;
  $('stFailK').textContent = t.requests > 0 ? '失败 · 成功率 ' + (100 - rate).toFixed(1) + '%' : '失败';
  $('stFailCell').className = 'stat' + (t.failed > 0 ? ' bad' : '');
  $('stRate').textContent = t.avg_rate > 0 ? formatRate(t.avg_rate) : '—';

  $('rngNote').textContent = '统计 ' + d.from + ' 起 · 覆盖 ' + d.points.length + ' 个' + (d.unit === 'hour' ? '小时' : '天');
  $('chartUnit').textContent = d.unit === 'hour' ? '按小时（本地时区）' : '按自然日（本地时区）';

  renderChart(d);
  renderModelDist(d);
  renderDayTable(d);
}

function renderModelDist(d) {
  const rows = d.models || [];
  const total = rows.reduce((sum, r) => sum + (r.total_tokens || 0), 0) || 1;
  $('mdStatNote').textContent = rows.length + ' 个模型';
  const tb = $('mdStatBody');
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="6"><div class="empty">区间内还没有模型用量</div></td></tr>';
    return;
  }
  tb.innerHTML = rows.map(r => {
    const share = (r.total_tokens || 0) / total * 100;
    return '<tr>' +
      '<td class="mark" aria-hidden="true"></td>' +
      '<td><div class="who"><div class="nm" title="' + esc(r.model) + '">' + esc(r.model) + '</div></div></td>' +
      '<td class="num"><b>' + formatTokenCount(r.total_tokens) + '</b></td>' +
      '<td class="cred"><div class="num">' + share.toFixed(0) + '%</div>' +
        '<div class="bar"><i style="width:' + Math.max(1, share) + '%"></i></div></td>' +
      '<td class="num">' + formatInt(r.requests) + '</td>' +
      '<td class="num">' + formatTokenCount(r.prompt_tokens) + ' / ' + formatTokenCount(r.completion_tokens) + '</td>' +
      '</tr>';
  }).join('');
}

function renderDayTable(d) {
  const rows = (d.points || []).filter(p => p.requests > 0);
  const total = rows.reduce((sum, r) => sum + r.total_tokens, 0) || 1;
  $('dyStatNote').textContent = rows.length + ' 个有记录的' + (d.unit === 'hour' ? '时段' : '日期');
  const tb = $('dyStatBody');
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="6"><div class="empty">区间内还没有请求记录</div></td></tr>';
    return;
  }
  // 倒序：最近的日期在最上面，与「最近请求」的读法一致。
  tb.innerHTML = rows.slice().reverse().map(r => {
    const share = r.total_tokens / total * 100;
    const label = d.unit === 'hour' ? r.key.slice(5).replace('T', ' ') + ' 时' : r.key;
    return '<tr class="' + (r.failed > 0 ? 'cool' : '') + '">' +
      '<td class="mark" aria-hidden="true"></td>' +
      '<td class="num">' + esc(label) + '</td>' +
      '<td class="num"><b>' + formatTokenCount(r.total_tokens) + '</b></td>' +
      '<td class="cred"><div class="num">' + share.toFixed(0) + '%</div>' +
        '<div class="bar"><i style="width:' + Math.max(1, share) + '%"></i></div></td>' +
      '<td class="num">' + formatInt(r.requests) + '</td>' +
      '<td class="num">' + (r.failed > 0 ? '<span class="tag bad">' + formatInt(r.failed) + '</span>' : '<span class="tag mute">0</span>') + '</td>' +
      '</tr>';
  }).join('');
}

function mdOf(key) { return String(key).slice(5); }

function renderChart(d) {
  const pts = d.points || [];
  const plot = $('chartPlot'), strip = $('chartStrip'), scale = $('chartScale');
  chartPts = pts;
  chartPeak = null;
  const maxT = Math.max(1, ...pts.map(p => p.total_tokens || 0));
  const maxR = Math.max(1, ...pts.map(p => p.requests || 0));

  chartPeakIdx = -1;
  pts.forEach((p, i) => {
    if ((p.total_tokens || 0) > 0 && (chartPeakIdx < 0 || p.total_tokens > pts[chartPeakIdx].total_tokens)) chartPeakIdx = i;
  });
  if (chartPeakIdx >= 0) {
    const pk = pts[chartPeakIdx];
    chartPeak = { tokens: pk.total_tokens, label: d.unit === 'hour' ? pk.key + ' 时' : mdOf(pk.key) };
  }

  plot.innerHTML = pts.map((p, i) => {
    const tok = p.total_tokens || 0;
    const h = tok > 0 ? Math.max(3, Math.round(tok / maxT * 100)) : 0;
    const cls = 'col' + (tok > 0 ? '' : ' zero') + (i === chartPeakIdx ? ' peak' : '');
    return '<div class="' + cls + '" data-i="' + i + '" tabindex="0" aria-label="' +
      esc(pointSegs(d, i).join(' · ')) + '" style="--h:' + h + '%"><i class="fill"></i></div>';
  }).join('');

  strip.innerHTML = pts.map(p => {
    const r = p.requests || 0;
    const h = r > 0 ? Math.max(8, Math.round(r / maxR * 100)) : 0;
    return '<div class="col-r"><i class="r' + (r > 0 ? '' : ' zero') + '" style="--r:' + h + '%"></i></div>';
  }).join('');

  // 刻度：按列数取约 7 个位置（24 小时取每 3 小时）。末尾必标，但若离前一个标签
  // 太近就跳过它——窄屏上两个标签贴在一起比少一个标签难读得多。
  const n = pts.length;
  const step = n > 12 ? Math.ceil(n / 7) : 1;
  scale.innerHTML = pts.map((p, i) => {
    const label = d.unit === 'hour' ? p.key.slice(11) + '时' : mdOf(p.key);
    if (i === n - 1) return '<span>' + esc(label) + '</span>';
    if (i % step || (n - 1 - i) < step * 0.6) return '<span></span>';
    return '<span>' + esc(label) + '</span>';
  }).join('');

  // 空序列与"整区间零请求"都要显式写空态：前者会留下上一轮读数，后者会显示
  // 某一天的"无请求"——都没回答"这一页为什么是空的"。
  const hasAny = pts.some(p => (p.requests || 0) > 0);
  if (!pts.length) $('chartReadout').textContent = '统计区间内还没有记录';
  else if (!hasAny) $('chartReadout').textContent = '区间内还没有请求记录（网关首次转发后开始累积）';
  else selectPoint(-1);
}

// pointSegs 某个时间点的明细分段（读数槽、柱子 aria-label、空态共用一套取数）。
function pointSegs(d, i) {
  const p = (d.points || [])[i];
  if (!p) return ['—'];
  const label = d.unit === 'hour' ? p.key.slice(11) + ' 时' : mdOf(p.key);
  if (!p.requests) return [label, '无请求'];
  const seg = [label, formatTokenCount(p.total_tokens) + ' tok', formatInt(p.requests) + ' 次'];
  if (p.failed) seg.push('失败 ' + formatInt(p.failed));
  return seg;
}
function pointReadout(d, i) {
  const seg = pointSegs(d, i);
  if (seg.length > 2) seg[1] = '<b>' + seg[1].replace(/ tok$/, '') + '</b> tok';
  if (seg[seg.length - 1].startsWith('失败')) {
    seg[seg.length - 1] = '<span class="bad">' + seg[seg.length - 1] + '</span>';
  }
  return seg.join(' · ');
}
// selectPoint 高亮第 i 个点并刷新读数槽；i < 0 回到峰值点（图上永远有一个读数）。
function selectPoint(i) {
  $('chartPlot').querySelectorAll('.col').forEach(c => c.classList.toggle('on', Number(c.dataset.i) === i));
  if (!chartPts.length) return;
  $('chartReadout').innerHTML = pointReadout(statsData, i >= 0 ? i : Math.max(0, chartPeakIdx));
}
$('chartPlot').addEventListener('mouseover', ev => {
  const c = ev.target.closest('.col');
  if (c) selectPoint(Number(c.dataset.i));
});
$('chartPlot').addEventListener('mouseleave', () => selectPoint(-1));
$('chartPlot').addEventListener('focusin', ev => {
  const c = ev.target.closest('.col');
  if (c) selectPoint(Number(c.dataset.i));
});
$('chartPlot').addEventListener('focusout', () => selectPoint(-1));

/* ── 模型与档位 ───────────────────────────────────────────────────── */
async function loadModels(quiet) {
  let d;
  try {
    d = await api('models');
  } catch (e) {
    if (!quiet) toast(e.message, 'err');
    throw e;
  }
  modelsData = d;
  const tb = $('mdBody');
  if (!d.data.length) {
    tb.innerHTML = '<tr><td colspan="8"><div class="empty"><div class="big">目录里还没有模型</div><div>上游目录获取失败或尚未就绪，稍后点击「重新获取」。</div></div></td></tr>';
    return d;
  }
  tb.innerHTML = d.data.map(m => {
    const efforts = m.efforts && m.efforts.length
      ? m.efforts.map(e => '<span class="tag mute">' + esc(e) + '</span>').join(' ')
      : '<span class="hint" style="color:var(--ink-3)">' + (m.reasoning ? '可调（未声明档位）' : '不思考') + '</span>';
    return '<tr>' +
      '<td class="mark" aria-hidden="true"></td>' +
      '<td><div class="who"><div class="nm" title="' + esc(m.id) + '">' + esc(m.id) + '</div>' +
        (m.free ? '<div class="id">免费</div>' : '<div class="id">' + esc(m.source) + '</div>') + '</div></td>' +
      '<td>' + (m.protocol === 'responses' ? '<span class="tag mute">responses</span>' : '<span class="tag mute">completions</span>') + '</td>' +
      '<td><span class="tag ' + (m.free ? 'ok' : 'warn') + '">' + esc(m.source) + '</span></td>' +
      '<td class="num">' + formatInt(m.context_window) + '</td>' +
      '<td class="num">' + formatInt(m.max_output) + '</td>' +
      '<td>' + (m.input_modalities || []).map(x => '<span class="tag mute">' + esc(x) + '</span>').join(' ') + '</td>' +
      '<td class="efs">' + efforts + '</td>' +
      '</tr>';
  }).join('');
  return d;
}
$('btnModels').onclick = () => loadModels().then(() => toast('已重新获取', 'ok')).catch(e => toast(e.message, 'err'));

/* ── 诊断中心 ─────────────────────────────────────────────────────── */
async function loadProbe(quiet) {
  let d;
  try {
    d = await api('probe');
  } catch (e) {
    if (!quiet) toast(e.message, 'err');
    return;
  }
  renderProbe(d);
}

function renderProbe(d) {
  const results = d.results || [];
  const counts = d.counts || { ok: 0, fail: 0, pending: 0 };
  const tested = counts.ok + counts.fail;
  $('probeSummary').textContent = tested > 0
    ? '已测 ' + tested + ' 个：' + counts.ok + ' 可用 / ' + counts.fail + ' 失败'
    : '尚未实测';
  $('probeEmpty').hidden = results.length > 0;
  $('probeWrap').hidden = results.length === 0;

  const prog = d.progress || { total: 0, done: 0, failed: 0, running: false };
  $('probeProg').hidden = !d.running && prog.total === 0;
  if (prog.total > 0) {
    const pct = Math.round(prog.done / prog.total * 100);
    $('probeBarFill').style.width = pct + '%';
    $('probeProgText').textContent = prog.done + ' / ' + prog.total + (prog.failed ? '（失败 ' + prog.failed + '）' : '') + (d.running ? ' 进行中' : ' 已完成');
  }
  $('btnProbeRun').disabled = d.running;
  $('btnProbeAll').disabled = d.running;

  const tb = $('probeBody');
  // 排序：运行中在最前，其次失败（要处理），再次未测，最后成功的按延迟升序。
  const order = { running: 0, fail: 1, pending: 2, ok: 3 };
  const sorted = results.slice().sort((a, b) => {
    const od = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (od) return od;
    if (a.status === 'ok' && b.status === 'ok') return (a.ttft_ms || 1e9) - (b.ttft_ms || 1e9);
    return String(a.model).localeCompare(String(b.model));
  });
  tb.innerHTML = sorted.map(r => {
    const rowCls = r.status === 'fail' ? 'off' : r.status === 'running' || r.status === 'pending' ? 'cool' : '';
    const dot = r.status === 'ok' ? 'done' : r.status === 'fail' ? 'err' : r.status === 'running' ? 'run' : 'wait';
    const label = { ok: '可用', fail: '失败', running: '实测中', pending: '待测' }[r.status] || r.status;
    const detail = r.detail || r.error || '';
    return '<tr class="' + rowCls + '">' +
      '<td class="mark"><i></i></td>' +
      '<td><div class="who"><div class="nm" title="' + esc(r.model) + '">' + esc(r.model) + '</div>' +
        (r.reasoning ? '<div class="id">含思考内容</div>' : '') + '</div></td>' +
      '<td><span class="qdot ' + dot + '"></span> <span class="tag ' + (r.status === 'ok' ? 'ok' : r.status === 'fail' ? 'bad' : 'mute') + '">' + label + '</span></td>' +
      '<td class="num">' + (r.ttft_ms != null ? formatLatency(r.ttft_ms) : '—') + '</td>' +
      '<td class="num">' + (r.total_ms != null ? formatLatency(r.total_ms) : '—') + '</td>' +
      '<td class="num">' + (r.chars != null ? formatInt(r.chars) + ' 字' : '—') + '</td>' +
      '<td class="msg" title="' + esc(detail) + '">' + esc(detail || (r.status === 'ok' ? '正常返回' : '—')) + '</td>' +
      '<td class="c-acts"><span class="acts">' +
        '<button type="button" class="xs" data-probe="' + esc(r.model) + '">实测</button>' +
      '</span></td>' +
      '</tr>';
  }).join('');
}

$('probeBody').addEventListener('click', async ev => {
  const btn = ev.target.closest('button[data-probe]');
  if (!btn) return;
  const model = btn.dataset.probe;
  openProbeDialog(model);
  try {
    const d = await api('probe', { method: 'POST', body: JSON.stringify({ model }) });
    paintProbeDialog(d.result);
    renderProbe(d);
    // 概览的"上次实测"读数也跟着更新。
    if (overviewData) loadOverview(true);
  } catch (e) {
    paintProbeDialog({ model, status: 'fail', detail: e.message });
  }
});

function openProbeDialog(model) {
  $('probeWho').textContent = model;
  $('probeState').className = 'state';
  $('probeState').innerHTML = '<span class="dots">正在实测</span>';
  $('probeDetail').hidden = true;
  $('probeVeil').classList.add('on');
}
function paintProbeDialog(r) {
  if (!r) return;
  const ok = r.status === 'ok';
  $('probeState').className = 'state ' + (ok ? 'ok' : 'err');
  $('probeState').textContent = ok
    ? '模型可用：首字节 ' + formatLatency(r.ttft_ms) + '，总耗时 ' + formatLatency(r.total_ms) + '，输出 ' + formatInt(r.chars) + ' 字'
    : '实测失败：' + (r.detail || r.error || '未知原因');
  const lines = [];
  if (r.ttft_ms != null) lines.push('首字节延迟: ' + formatLatency(r.ttft_ms));
  if (r.total_ms != null) lines.push('总耗时:     ' + formatLatency(r.total_ms));
  if (r.chars != null) lines.push('输出长度:   ' + formatInt(r.chars) + ' 字');
  if (r.reasoning) lines.push('思考内容:   有');
  if (r.error) lines.push('错误分类:   ' + r.error);
  if (r.detail) lines.push('详情:       ' + r.detail);
  $('probeDetail').textContent = lines.join('\n');
  $('probeDetail').hidden = lines.length === 0;
}

$('btnProbeRun').onclick = async () => {
  try {
    await api('probe', { method: 'POST', body: JSON.stringify({ concurrency: Number($('probeConc').value) }) });
    toast('已开始实测队列', 'ok');
    pollProbe();
  } catch (e) { toast(e.message, 'err'); }
};
$('btnProbeAll').onclick = () => { go('diagnostics'); setTimeout(() => $('btnProbeRun').click(), 60); };
$('btnProbeRefresh').onclick = () => loadProbe().then(() => toast('已刷新', 'ok')).catch(e => toast(e.message, 'err'));
$('probeConc').onchange = async () => {
  try { await api('probe', { method: 'POST', body: JSON.stringify({ concurrency: Number($('probeConc').value) }) }); }
  catch (e) { /* 并发设置非关键 */ }
};

/* 队列运行时按节奏轮询；结束时自动停。 */
function pollProbe() {
  if (probeTimer) clearInterval(probeTimer);
  probeTimer = setInterval(async () => {
    if (view !== 'diagnostics') { clearInterval(probeTimer); probeTimer = null; return; }
    try {
      const d = await api('probe');
      renderProbe(d);
      if (!d.running) {
        clearInterval(probeTimer);
        probeTimer = null;
        const c = d.counts || {};
        toast('实测完成：' + (c.ok || 0) + ' 可用 / ' + (c.fail || 0) + ' 失败', (c.fail || 0) > 0 ? 'err' : 'ok');
        if (overviewData) loadOverview(true);
      }
    } catch (e) {
      clearInterval(probeTimer);
      probeTimer = null;
    }
  }, 1500);
}

/* ── 配置 ─────────────────────────────────────────────────────────── */
const CFG_FIELDS = ['host', 'port', 'auth', 'panelAuth', 'apiKey', 'agentKey', 'defaultModel', 'refreshSeconds', 'exposeAllModels', 'includeReasoning',
  'firstEventMs', 'bodyIdleMs', 'responsesBodyIdleMs', 'maxRotates', 'maxBodyBytes', 'requestTimeoutMs',
  'panel', 'statsKeepDays', 'logLevel'];

async function loadConfig() {
  const d = await api('config').catch(e => { toast(e.message, 'err'); return null; });
  if (!d) return;
  cfgLoaded = d.config;
  $('cfgPath').textContent = d.path;
  const form = $('cfgForm');
  for (const key of CFG_FIELDS) {
    const el = form.elements[key];
    if (!el) continue;
    const value = d.config[key];
    if (el.type === 'checkbox') el.checked = value === true;
    else el.value = value == null ? '' : value;
  }
  $('cfgNote').textContent = '';
  loadKey();
}

/* ── 访问密钥 ─────────────────────────────────────────────────────── */
// 两个密钥互相独立：Agent 密钥给 /v1 用，面板密钥用来登录面板。
// 它们都存在自己的文件里（不在 config.json），所以单独读一次并在两处共用。
let authInfo = null;
async function fetchAuth(force) {
  if (authInfo && !force) return authInfo;
  try {
    authInfo = await api('auth');
  } catch (e) {
    authInfo = { enabled: false, key: '', source: 'unknown', path: null, agent: { enabled: false, key: '', path: null } };
  }
  return authInfo;
}

/** The agent credential, which is what an Agent integration needs. */
function agentOf(info) {
  return (info && info.agent) || { enabled: false, key: '', path: null };
}

/** 概览页那句提示随鉴权状态变化。 */
function keyHintText(enabled) {
  return enabled ? '填进 Agent / 客户端的 API Key 字段' : '当前未启用鉴权，API Key 随便填';
}

async function loadKeyInto(input, hint) {
  const info = await fetchAuth();
  const agent = agentOf(info);
  input.value = agent.enabled ? agent.key : '';
  input.placeholder = agent.enabled ? '' : '（未启用）';
  if (hint) hint.textContent = keyHintText(agent.enabled);
  return info;
}

async function loadKey() {
  const info = await fetchAuth(true);
  const agent = agentOf(info);

  // Agent 密钥
  $('keyAgent').value = agent.enabled ? agent.key : '';
  $('keyAgent').placeholder = agent.enabled ? '' : '（未启用）';
  $('keyAgentHint').textContent = agent.enabled
    ? (agent.source === 'configured'
        ? '当前使用你在下面填的自定义 Agent 密钥。'
        : '自动生成并保存在 ' + (agent.path || '服务目录') + '，重启后沿用。')
    : 'Agent 调用未要求密钥，任何能访问本机端口的程序都可以调用 /v1。';
  $('btnAgentRotate').disabled = !agent.enabled;

  // 面板密钥：只有开启「打开面板需要密钥」后才存在
  $('keyValue').value = info.enabled && info.key ? info.key : '';
  $('keyValue').placeholder = info.enabled && info.key ? '' : '（面板免登录）';
  $('keyHint').textContent = !info.enabled
    ? '面板当前免登录（默认）。打开上面的开关即可要求密钥。'
    : info.source === 'configured'
      ? '当前使用你在下面填的自定义面板密钥。'
      : '自动生成并保存在 ' + (info.path || '服务目录') + '。';
  $('btnKeyRotate').disabled = !info.enabled;

  $('keyNote').textContent = agent.enabled
    ? 'Agent 密钥已启用 · 面板' + (info.enabled ? '需登录' : '免登录')
    : '未启用鉴权';
  return info;
}

/** Reveal/hide toggle for a password input. */
function bindEye(buttonId, inputId) {
  $(buttonId).onclick = () => {
    const el = $(inputId);
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    $(buttonId).textContent = show ? '隐藏' : '显示';
  };
}
bindEye('btnKeyEye', 'keyValue');
bindEye('btnAgentEye', 'keyAgent');
bindEye('btnEye', 'cfgKey');
bindEye('btnEyeAgentKey', 'cfgAgentKey');
bindEye('btnSvcKeyEye', 'svcKey');

$('btnKeyCopy').onclick = async () => {
  const info = await fetchAuth();
  if (!info.enabled || !info.key) return toast('当前未启用鉴权，无需密钥', 'err');
  copy(info.key, '面板密钥');
};
$('btnAgentCopy').onclick = async () => {
  const agent = agentOf(await fetchAuth());
  if (!agent.enabled) return toast('当前未启用鉴权，无需密钥', 'err');
  copy(agent.key, 'Agent 密钥');
};

/**
 * Rotate one credential. Only the agent path refreshes the stored panel key:
 * rotating the panel key invalidates the session that is asking, so the new key
 * must be adopted locally or the operator locks themselves out.
 */
async function rotateKey(target) {
  const isAgent = target === 'agent';
  const label = isAgent ? 'Agent 密钥' : '面板密钥';
  const warn = isAgent
    ? '重新生成 Agent 密钥？所有已接入的 Agent 都需要改成新密钥（不影响面板）。'
    : '重新生成面板密钥？你需要用新密钥重新登录面板。';
  if (!confirm(warn)) return;
  try {
    const d = await api('auth/rotate', { method: 'POST', body: JSON.stringify({ target }) });
    if (!isAgent) localStorage.setItem(LS_KEY, d.key);
    authInfo = null;
    await loadKey();
    await loadKeyInto($('svcKey'), $('svcKeyHint'));
    toast('已生成新的' + label, 'ok');
    copy(d.key, '新' + label);
  } catch (e) {
    toast(e.message, 'err');
  }
}
$('btnKeyRotate').onclick = () => rotateKey('panel');
$('btnAgentRotate').onclick = () => rotateKey('agent');

/* 概览页上的复制按钮 */
$('btnSvcKeyCopy').onclick = async () => {
  const agent = agentOf(await fetchAuth());
  if (!agent.enabled) return toast('当前未启用鉴权，无需密钥', 'err');
  copy(agent.key, 'Agent 密钥');
};
$('btnCfgReload').onclick = () => loadConfig().then(() => toast('已放弃修改', 'ok'));
$('cfgForm').onsubmit = async ev => {
  ev.preventDefault();
  const form = $('cfgForm');
  const body = {};
  for (const key of CFG_FIELDS) {
    const el = form.elements[key];
    if (!el) continue;
    if (el.type === 'checkbox') body[key] = el.checked;
    else if (el.value !== '') body[key] = el.value;
    else body[key] = '';
  }
  $('btnCfgSave').disabled = true;
  try {
    await api('config', { method: 'POST', body: JSON.stringify(body) });
    toast('配置已保存（监听地址/端口与面板开关需重启生效）', 'ok');
    $('cfgNote').textContent = '已保存到文件';
    await loadConfig();
    await loadOverview(true);
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    $('btnCfgSave').disabled = false;
  }
};

/* ── 运行日志 ─────────────────────────────────────────────────────── */
$('logChips').addEventListener('click', ev => {
  const c = ev.target.closest('.chip');
  if (!c) return;
  logCh = c.dataset.ch;
  document.querySelectorAll('#logChips .chip').forEach(x => x.classList.toggle('on', x === c));
  logSince = null;
  $('logBox').textContent = '';
  loadLogs();
});
$('btnLogPin').onclick = () => {
  logPin = !logPin;
  $('btnLogPin').textContent = '自动滚动：' + (logPin ? '开' : '关');
};

async function loadLogs() {
  let d;
  try {
    d = await api('logs?channel=' + encodeURIComponent(logCh) + '&limit=500' + (logSince != null ? '&since=' + logSince : ''));
  } catch (e) { return; }
  const box = $('logBox');
  const entries = d.entries || [];
  $('logNote').textContent = '缓冲 ' + d.size + ' 行' + (logSince != null ? ' · 增量拉取' : ' · 全量');
  if (!entries.length && logSince == null) {
    box.innerHTML = '<span class="lt">还没有日志。客户端发起请求、或运行模型实测后，这里会出现记录。</span>';
  } else if (entries.length) {
    const html = entries.map(e => {
      const lvl = e.level === 'error' ? 'e' : e.level === 'warn' ? 'w' : '';
      const ch = 'c-' + (e.channel || 'sys');
      const label = { task: '任务', chat: '对话', sys: '系统' }[e.channel] || '系统';
      const extra = e.extra ? ' ' + JSON.stringify(e.extra) : '';
      return '<span class="ln ' + lvl + '"><span class="lt">' + esc(String(e.time).slice(11, 19)) + '</span>' +
        '<i class="lch ' + ch + '">' + label + '</i>' + esc(e.message) + esc(extra) + '</span>';
    }).join('');
    if (logSince == null) box.innerHTML = html;
    else box.innerHTML = box.innerHTML + html;
    // 只保留最近 500 行，避免长时间开着页面把 DOM 撑爆。
    const lines = box.querySelectorAll('.ln');
    if (lines.length > 500) for (let i = 0; i < lines.length - 500; i++) lines[i].remove();
  }
  if (d.lastSeq != null) logSince = d.lastSeq;
  if (logPin) box.scrollTop = box.scrollHeight;
}

/* ── 统一刷新 ─────────────────────────────────────────────────────── */
$('btnRefresh').onclick = async () => {
  await refreshCurrent(true);
  toast('已刷新', 'ok');
};
async function refreshCurrent(notify) {
  if (view === 'overview') return loadOverview(!notify);
  if (view === 'stats') return loadStats(!notify);
  if (view === 'diagnostics') return loadProbe(!notify);
  if (view === 'models') return loadModels(!notify).catch(() => {});
  if (view === 'config') return loadConfig();
  if (view === 'logs') return loadLogs();
}

/* ── 启动 ─────────────────────────────────────────────────────────── */
function start() {
  go(location.hash.slice(1) || 'overview');
  if (refTimer) clearInterval(refTimer);
  // 概览每 5 秒自刷新（观测页）；其余视图刷新靠手动或轮询逻辑。
  refTimer = setInterval(() => {
    if (view === 'overview') loadOverview(true);
    else if (view === 'logs') loadLogs();
  }, 5000);
}
start();
