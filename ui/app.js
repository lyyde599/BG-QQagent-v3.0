// QQ Agent 控制台前端：会话式（每次运行 = 一个会话）。
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  tab: 'sessions',
  sessions: [],          // 摘要列表
  currentSessionId: null,
  sessionDetail: null,   // 完整记录
  chats: [],
  currentChatKey: null,
  chatMessages: [],
  config: null,
  personaTemplates: {},
  personaGroups: [],          // 人设分组顺序（后端给，用于下拉分组展示）
  // 覆盖人设前的临时备份（仅本页面会话内有效，刷新即失效）
  personaBackup: null,
  status: null,
  paused: false,
  pauseReason: null,
  autoFollowRunning: true,
  settingsSection: 'api',
  // 群友福利（welfare）面板状态
  welfare: null,              // GET /api/welfare 的快照（统计用）
  welfareLoadedAt: 0,
  welfareLoading: false,
  welfareError: '',
  welfareDraft: null,         // 编辑中的表单草稿（加/减奖励项时不丢输入）
  welfareEditing: '',         // 正在编辑的活动 id（空 = 新建）
  welfareClaims: null,        // 当前活动的领取明细
  welfareClaimsFor: '',       // 明细对应的活动 id（防止重复加载）
  welfareClaimsCampaign: '',  // 明细下拉选中的活动
  welfareClaimsError: '',
  welfareNotice: '',          // 公告草稿（跨重渲染保留）
  welfareNoticeGroups: '',
  welfareToast: ''            // 表单操作结果提示
};

// ── 工具函数 ──
/**
 * HTTP 请求封装。
 *
 * 🔴 options.body 传**对象**时自动 JSON.stringify（2026-10-21 修）。
 *   起因：广告列表的「删除」按钮点了没反应。查出来是调用方写
 *   `body: { adInject: {...} }` 但没 stringify，fetch 把对象转成
 *   字符串 "[object Object]" 发出去，服务端 JSON.parse 报 500：
 *     [http] 处理出错: "[object Object]" is not valid JSON
 *   同类调用当时有 9 处（圣杯战争的操作按钮全中），逐个改容易漏，
 *   所以在这一层统一兜住：字符串原样传，对象自动序列化。
 */
/**
 * 提示词正文的可读化渲染（2026-10-21）。
 *
 * 原样 esc() 后整块等宽字，几万字符的提示词读起来是一片糊。
 * 这里只做**轻量**增强，不引 Markdown 库（没必要，也不安全）：
 *   · 【xxx】/ ## xxx 开头的小节 → 加粗成阅读锚点
 *   · 连续空行压成一个空行，减少视觉碎片
 *   · 其余全部转义，不解释任何 HTML
 */
function fmtPrompt(text) {
  if (!text) return '';
  return esc(String(text))
    .replace(/(^|\n)(【[^】\n]{1,30}】)/g, '$1<span class="pt-h">$2</span>')
    .replace(/(^|\n)(#{1,3} [^\n]{1,60})/g, '$1<span class="pt-h">$2</span>')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * 轻提示。前端出错时**必须让人看见** ——
 * 之前所有失败只往 console 打日志，页面上完全静默，
 * 用户看到的就是"点了没反应"（2026-10-21 广告添加/删除都踩过）。
 */
function toast(msg, ms = 2600) {
  let el = document.getElementById('pl-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pl-toast';
    el.className = 'pl-toast';
    document.body.appendChild(el);
  }
  el.textContent = String(msg);
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

// ══════════════════════════════════════════════════════════════
//  插件前端加载器（2026-10-21）
// ══════════════════════════════════════════════════════════════
//
// 架构约束：**插件功能的前端代码必须放在插件自己的目录里**。
// 内核 ui/app.js 只提供公共能力，不写任何插件界面。
//
// 插件侧（plugins/<id>/ui.js）:
//   export async function mount(root, ctx) { ... }
//   export async function unmount(root) { ... }   ← 可选
//
// ctx = { pluginId, api, toast, esc, state, $, $$, fmtTime, getConfig }
// 插件完全不需要 import 内核模块。

const pluginUiCache = new Map();

/**
 * 加载插件前端模块。
 *
 * 🔴 两个必须注意的点（2026-10-21 实测踩到）：
 *
 * ① **不缓存失败结果**。原来失败时 `set(pluginId, null)`，
 *    于是插件文件修好后再也不会重试，必须刷新整个页面 ——
 *    用户看到的就是"一直报没有导出 mount()"。
 *
 * ② **URL 带 mtime 版本号**。浏览器对 ES module 的缓存很激进，
 *    插件 ui.js 更新后仍可能加载旧内容。加 ?v=<mtime> 强制拉新的。
 *    （内核不缓存 mtime，每次现取；代价是一次 API 调用，可接受）
 */
async function loadPluginUi(pluginId, entryFile, stamp) {
  if (!entryFile) return null;
  const key = `${pluginId}@${stamp || ''}`;
  if (pluginUiCache.has(key)) return pluginUiCache.get(key);
  try {
    const q = stamp ? `?v=${encodeURIComponent(stamp)}` : '';
    const url = `/plugin-ui/${encodeURIComponent(pluginId)}/${entryFile}${q}`;
    const mod = await import(/* @vite-ignore */ url);
    pluginUiCache.set(key, mod);
    return mod;
  } catch (e) {
    console.error(`[plugin-ui] ${pluginId} 加载失败:`, e);
    toast(`插件「${pluginId}」界面加载失败：${e.message}`);
    // 注意：**不写缓存**，下次调用会重试
    return null;
  }
}

function pluginUiContext(pluginId) {
  return {
    pluginId, api, toast, esc, state,
    $: (s) => document.querySelector(s),
    $$: (s) => [...document.querySelectorAll(s)],
    fmtTime,
    getConfig: async () => (await api('/api/config')) || {},
    // 插件页的**公共组件**（内核提供，插件直接用，不必各自实现一遍）
    panelShell, bindPanelClose, savePluginConfig, pluginConfigOf
  };
}

/**
 * 挂载插件面板。
 * @param {string} pluginId
 * @param {HTMLElement} root 容器
 * @param {string} [entryFile] 未传则从 /api/plugins 的 tabs 里查
 */
async function mountPluginUi(tabId, root, entryFile) {
  if (!root) return false;
  root.innerHTML = '<div class="muted" style="padding:16px">加载插件界面…</div>';

  // 🔴 tabId ≠ pluginId（页签 id 是 ad，插件 id 是 ad-inject）。
  //    路径必须用 **pluginId**（/plugin-ui/<pluginId>/<file>），不能用 tabId。
  let pluginId = tabId;
  let entry = entryFile;
  let stamp = '';
  if (!entry) {
    try {
      const d = await api('/api/plugins');
      const tab = (d.tabs || []).find((x) => x.id === tabId);
      if (tab) { pluginId = tab.pluginId || tabId; entry = tab.file || ''; stamp = tab.fileStamp || ''; }
    } catch { /* ignore */ }
  }
  if (!entry) {
    root.innerHTML = `<div class="muted" style="padding:16px">插件「${esc(pluginId)}」没有提供界面文件（manifest.ui 为空）。</div>`;
    return false;
  }

  const mod = await loadPluginUi(pluginId, entry, stamp);
  if (!mod || typeof mod.mount !== 'function') {
    root.innerHTML = `<div class="error" style="padding:16px">插件「${esc(pluginId)}」的界面文件没有导出 mount()。</div>`;
    return false;
  }
  try {
    root.innerHTML = '';
    await mod.mount(root, pluginUiContext(pluginId));
    return true;
  } catch (e) {
    console.error(`[plugin-ui] ${pluginId} 渲染失败:`, e);
    root.innerHTML = `<div class="error" style="padding:16px">插件界面渲染失败：${esc(e.message)}</div>`;
    return false;
  }
}


// ══════════════════════════════════════════════════════════════
//  外观：皮肤 + 自定义背景（2026-10-21）
// ══════════════════════════════════════════════════════════════
//
// 设计：皮肤 = 一组令牌覆盖（ui/skins/*.css），靠 :root[data-skin="x"] 生效。
//       背景 = 一张图，通过 CSS 变量注入，透明度用「面板不透明度」表达。
//
//   🔴 不透明度的实现要点：
//      不能直接给 body 加 opacity（会让整个界面连文字一起变淡）。
//      做法是给 body 铺一层背景图，再让面板/卡片用半透明底色 ——
//      这样只有"纸"变透，字始终清晰（对比度不受影响）。

const SKINS = [
  { id: 'default',    label: '纸墨灰', desc: '原色 · 白纸墨字' },
  { id: 'paper-warm', label: '暖纸',   desc: '米黄纸感 · 长时间阅读' },
  { id: 'midnight',   label: '深墨',   desc: '深色底 · 夜间护眼' },
  { id: 'forest',      label: '青苔',   desc: '低饱和绿灰 · 冷静' },
  { id: 'sakura',     label: '樱灰',   desc: '淡粉灰 · 柔和' },
  { id: 'ocean',      label: '深海',   desc: '冷蓝灰 · 数据看板' }
];

let appearanceState = null;

/** 读取外观配置（带缓存，避免每次渲染都请求） */
async function loadAppearance(force = false) {
  if (appearanceState && !force) return appearanceState;
  try {
    const c = await api('/api/config');
    appearanceState = c?.appearance || { skin: 'default', background: {} };
  } catch {
    appearanceState = { skin: 'default', background: {} };
  }
  return appearanceState;
}

/** 应用外观到 DOM（皮肤 attr + 背景图 + 面板透明度） */
function applyAppearance(app) {
  const skin = app?.skin || 'default';
  const bg = app?.background || {};
  const root = document.documentElement;

  // ① 皮肤
  if (skin === 'default') root.removeAttribute('data-skin');
  else root.setAttribute('data-skin', skin);

  // ② 背景图
  const hasBg = !!(bg.dataUrl && bg.dataUrl.startsWith('data:image/'));
  root.style.setProperty('--user-bg-image', hasBg ? `url("${bg.dataUrl}")` : 'none');
  root.style.setProperty('--user-bg-blur', `${Number(bg.blur) || 0}px`);
  root.style.setProperty('--user-bg-mode', bg.mode === 'contain' ? 'contain'
    : bg.mode === 'repeat' ? 'repeat' : 'cover');
  // 面板不透明度：0.3~1.0，值越小背景越透
  const op = hasBg ? Math.min(1, Math.max(0.3, Number(bg.opacity) || 0.92)) : 1;
  root.style.setProperty('--user-panel-alpha', String(op));
  root.classList.toggle('has-user-bg', hasBg);
}

/** 保存外观并立即生效 */
async function saveAppearance(patch) {
  const cur = await loadAppearance(true);
  const next = {
    ...cur,
    ...patch,
    background: { ...(cur.background || {}), ...(patch.background || {}) }
  };
  const r = await api('/api/config', { method: 'POST', body: { appearance: next } });
  if (r && r.ok === false) throw new Error(r.error || '保存失败');
  appearanceState = next;
  applyAppearance(next);
  return next;
}

/** 把文件读成 dataURL（限制 2MB，太大塞进 config 不合适） */
function readImageAsDataUrl(file, maxMB = 2) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('没有文件'));
    if (!/^image\//.test(file.type)) return reject(new Error('请选择图片文件'));
    if (file.size > maxMB * 1024 * 1024) {
      return reject(new Error(`图片过大（${(file.size / 1024 / 1024).toFixed(1)}MB），上限 ${maxMB}MB`));
    }
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('读取失败'));
    fr.readAsDataURL(file);
  });
}

async function api(path, options = {}) {
  const opts = { ...options };
  if (opts.body !== undefined && opts.body !== null && typeof opts.body === 'object'
      && !(opts.body instanceof FormData) && !(opts.body instanceof Blob)) {
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// 时间一律按**北京时间**渲染：进程已锁 TZ=Asia/Shanghai（见 src/server.js 首行），
// 所以这里的 getHours()/getMonth() 取到的就是北京时间，不是服务器 UTC。
function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_LABEL = { done: '已发言', noreply: '未回复', running: '运行中', error: '出错', aborted: '中止' };

// ── 启动 loading 壳：页面先渲染，等服务可用后自动隐藏 ──
const loadingOverlay = $('#loading-overlay');
const loadingStatus = $('#loading-status');
const loadingLogs = $('#loading-logs');
let appReady = false;
let bootLogs = [];

function setLoadingStatus(text) {
  bootLogs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`);
  if (loadingStatus) loadingStatus.textContent = text;
  if (loadingLogs) loadingLogs.textContent = bootLogs.slice(-12).join('\n');
}

function hideLoading() {
  appReady = true;
  if (loadingOverlay) {
    loadingOverlay.style.transition = 'opacity .25s ease';
    loadingOverlay.style.opacity = '0';
    setTimeout(() => { loadingOverlay?.remove(); }, 300);
  }
}

async function pollUntilReady() {
  const startedAt = Date.now();
  try {
    const status = await api('/api/status');
    if (!status.onebot?.connected) setLoadingStatus('网关已就绪，正在连接 OneBot…');
    else setLoadingStatus(`OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}，即将进入控制台…`);
    // 服务已可达，无需等到 OneBot 完全连上即可进入控制台（体检卡会继续提示）
    return true;
  } catch (e) {
    if (Date.now() - startedAt > 45000) {
      setLoadingStatus('连接超时。请确认 OneBot 网关已启动（NapCat / SnowLuma 均可），或到「登录」页签手动启动。');
      return false;
    }
    return false;
  }
}

async function bootLoop() {
  for (let i = 0; i < 90; i++) {
    if (await pollUntilReady()) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  hideLoading();
  refreshStatus();
  if (state.tab === 'sessions') loadSessions();
}

// ── 就绪度体检（傻瓜式引导的核心） ──
function assessReadiness(cfg, status) {
  const checks = [];
  if (!cfg) return { ready: false, checks: [{ ok: false, label: '配置加载失败' }] };
  const modelOk = !!(cfg.api.model && cfg.api.baseUrl);
  checks.push({ ok: modelOk, label: modelOk ? `模型已选择：${cfg.api.model}` : '还没有选择模型（必填）', fix: modelOk ? null : 'settings-api' });
  const allowOk = (cfg.allow?.groups?.length || cfg.allow?.private?.length || cfg.allowAllWhenEmpty);
  checks.push({ ok: !!allowOk, label: allowOk ? `白名单：${(cfg.allow.groups || []).length} 个群 / ${(cfg.allow.private || []).length} 个好友` : '还没有配置白名单（必填）', fix: allowOk ? null : 'settings-allow' });
  const obOk = status?.onebot?.connected;
  const acct2 = status?.onebot?.account || {};
  const acctOffline2 = acct2.online === false;
  // 分两条报：WS 连接 / 账号在线。只报前者会把"账号掉线"判成健康（2026-09-14 事故）
  checks.push({ ok: !!obOk, label: obOk ? `OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}` : 'OneBot 未连接 —— 请到「登录」页签启动', fix: obOk ? null : 'snowluma-tab' });
  if (obOk) {
    const mins2 = acct2.offlineMs ? Math.round(acct2.offlineMs / 60000) : 0;
    checks.push({
      ok: !acctOffline2,
      label: acctOffline2
        ? `⚠ QQ 账号已离线${mins2 ? `（${mins2} 分钟）` : ''} —— 机器人收不到消息，请重新登录`
        : (acct2.online === true ? 'QQ 账号在线' : 'QQ 账号状态未探测（稍候自动重试）'),
      fix: acctOffline2 ? 'snowluma-tab' : null
    });
  }
  return { ready: modelOk && allowOk && obOk && !acctOffline2, checks };
}

function renderBanner() {
  const banner = $('#banner');
  const s = state.status;
  let show = false;
  let html = '';
  if (state.paused && state.pauseReason === 'budget') {
    show = true;
    const cap = state.config?.budget?.dailyCostYuan || 0;
    const cost = state.status?.usage?.cost ?? 0;
    html = `💰 已触发今日预算上限（¥${cost.toFixed(2)} / ¥${cap}），机器人自动暂停。可先 <a href="#" id="banner-goto-settings">设置 → 预算保险丝</a> 调整上限，然后选择"恢复"（补处理积压消息）或"恢复并全部标为已读"（丢弃积压）。`;
  } else if (state.paused) {
    show = true;
    html = '⏸ 机器人已暂停，不会处理任何消息。';
  } else if (s && !s.onebot.connected && !s.onebot.everConnected) {
    show = true;
    html = '🔌 OneBot 还没连上：请确认网关（NapCat / SnowLuma）已启动，且设置里的 WS/HTTP 地址正确。';
  }
  banner.classList.toggle('hidden', !show);
  if (show) {
    if (state.paused) {
      html += ` <button class="btn btn-small" id="banner-resume-btn">恢复</button>
        <button class="btn btn-small btn-danger" id="banner-resume-read-btn" title="恢复运行，并把暂停期间积压的所有未读消息直接标记为已读（不再处理）">恢复并全部标为已读</button>`;
    }
    banner.innerHTML = html;
    const link = $('#banner-goto-settings');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); switchTab('settings'); });
    const resumeBtn = $('#banner-resume-btn');
    if (resumeBtn) resumeBtn.addEventListener('click', () => resumePause({ skipBacklog: false }));
    const resumeReadBtn = $('#banner-resume-read-btn');
    if (resumeReadBtn) resumeReadBtn.addEventListener('click', () => resumePause({ skipBacklog: true }));
  }
}

async function resumePause({ skipBacklog = false } = {}) {
  try {
    if (skipBacklog) {
      await api('/api/pause', { method: 'DELETE', body: '{}' });
    } else {
      await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: false }) });
    }
    await refreshStatus();
    if (state.tab === 'chats') loadChats({ quiet: true });
  } catch (e) {
    console.error('恢复失败:', e);
  }
}

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  state.tab = name;
  dispatchTabLoad(name);
}

// ── 状态栏 ──
async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    const s = state.status;
    const dot = $('#onebot-dot');
    const label = $('#onebot-label');
    // ⚠️ 关键：WS 连着 ≠ 账号可用。NapCat 的 WS 在账号离线时依然在监听，
    // 只看 connected 会让"掉线"显示成"已连接"（2026-09-14 事故）。
    const acct = s.onebot.account || {};
    const acctOffline = acct.online === false;
    const acctUnknown = acct.online === null || acct.online === undefined;
    if (acctOffline) {
      dot.className = 'dot dot-off';
      const mins = acct.offlineMs ? Math.round(acct.offlineMs / 60000) : 0;
      label.textContent = `⚠ QQ 账号已离线${mins ? `（${mins} 分钟）` : ''} —— 机器人收不到消息，请检查登录`;
    } else if (s.onebot.connected) {
      dot.className = 'dot ' + (acctUnknown ? 'dot-wait' : 'dot-on');
      label.textContent = `OneBot 已连接${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}`
        + (acctUnknown ? ' · 账号状态未探测' : '');
    } else {
      dot.className = 'dot ' + (s.onebot.everConnected ? 'dot-wait' : 'dot-off');
      label.textContent = 'OneBot 未连接';
    }
    $('#model-label').textContent = `模型：${s.orchestrator.model || '未设置'}`;
    const u = s.usage;
    // 缓存命中率（2026-10-26）：有真实数据才显示，没有就不占位置
    const cachePart = (u.cacheHitRate !== null && u.cacheHitRate !== undefined)
      ? ` · 缓存 ${u.cacheHitRate}%`
      : '';
    $('#usage-label').textContent = `今日：${u.runs} 次运行 · ${fmtTokens(u.totalTokens)}${cachePart}${u.cost ? ` · ¥${u.cost.toFixed(2)}` : ''}`;
    // 显式展示时区（记忆系统 01 第六节：页面时间必须让用户看到北京时间）
    const tzEl = document.getElementById('tz-label');
    if (tzEl) {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const off = -d.getTimezoneOffset() / 60;
      tzEl.textContent = `北京时间 ${p2(d.getHours())}:${p2(d.getMinutes())}（UTC${off >= 0 ? '+' : ''}${off}）`;
    }
    state.paused = s.paused;
    state.pauseReason = s.pauseReason;
    $('#pause-btn').textContent = state.paused ? '恢复' : '暂停';
    renderBanner();
  } catch (e) { /* 忽略瞬时错误 */ }
}

function fmtTokens(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

$('#pause-btn').addEventListener('click', async () => {
  if (state.paused) {
    await resumePause({ skipBacklog: false });
  } else {
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    refreshStatus();
  }
});

// ── SSE ──
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('session-start', () => { loadSessions(); refreshStatus(); });
  es.addEventListener('session-update', (ev) => {
    const id = JSON.parse(ev.data).sessionId;
    if (id === state.currentSessionId) loadSessionDetail(id, { quiet: true });
    const item = state.sessions.find((s) => s.id === id);
    if (item && item.status !== 'done' && item.status !== 'noreply') loadSessions({ quiet: true });
  });
  es.addEventListener('session-end', () => {
    loadSessions();
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
  });
  es.addEventListener('chat-update', () => {
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
  });  es.addEventListener('onebot-status', () => { refreshStatus(); if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true }); });
  es.addEventListener('status', () => refreshStatus());
  // 账号健康事件：掉线/恢复时立即刷新界面，不必等 15 秒轮询
  es.addEventListener('onebot-health', () => { refreshStatus(); if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true }); });
  es.addEventListener('snowluma-status', () => { refreshStatus(); if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true }); });
  es.addEventListener('snowluma-log', (ev) => {
    const d = JSON.parse(ev.data);
    if (!appReady && d?.text) {
      setLoadingStatus(d.text);
    }
    if (appReady && (state.tab === 'snowluma' || state.tab === 'settings')) {
      refreshSnowlumaLogs();
    }
  });
  es.addEventListener('feedback', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.level === 'error') console.warn('[agent 反馈]', d.message);
  });
  // 🔴 插件动作（偷图/发表情）—— 不改内核 session，由前端追加显示
  es.addEventListener('sticker-action', (ev) => {
    const d = JSON.parse(ev.data);
    // 存到全局，会话详情渲染时取出来追加
    (state.pluginActions ||= []).push(d);
    if (state.currentSessionId && state.tab === 'sessions') {
      loadSessionDetail(state.currentSessionId, { quiet: true });
    }
  });
  es.onerror = () => { /* EventSource 自动重连 */ };
}

// ── 会话视图 ──
async function loadSessions({ quiet = false } = {}) {
  try {
    const data = await api('/api/sessions?limit=80');
    state.sessions = data.sessions || [];
    renderSessionList();
    // 自动跟随最新运行中的会话
    if (state.autoFollowRunning && !state.currentSessionId) {
      const running = state.sessions.find((s) => s.status === 'running');
      if (running) selectSession(running.id);
    }
  } catch (e) { if (!quiet) console.error(e); }
}

// 会话列表定时刷新：只要停在会话页，就持续更新列表（运行中会话也会轮询详情）
setInterval(() => {
  if (state.tab === 'sessions') loadSessions({ quiet: true });
  if (state.tab === 'chats') loadChats({ quiet: true });
  if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true });
  if (state.tab === 'settings') refreshStatus();
}, 4000);

function renderSessionList() {
  const box = $('#session-items');
  box.innerHTML = state.sessions.map((s) => {
    const chatName = s.chatKey.replace('group:', '群 ').replace('private:', '私聊 ');
    return `
      <div class="session-item ${s.id === state.currentSessionId ? 'selected' : ''}" data-id="${s.id}">
        <div class="session-title">
          <span class="session-chat">${esc(chatName)}</span>
          <span class="session-time">${fmtTime(s.startedAt)}</span>
        </div>
        <div class="session-trigger">${esc(s.trigger || '')}</div>
        <div class="session-meta">
          <span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
          <span>${s.usage ? fmtTokens(s.usage.totalTokens) : '-'}</span>
          <span>${s.rounds || 0} 轮</span>
        </div>
      </div>`;
  }).join('');
  $$('.session-item', box).forEach((el) => {
    el.addEventListener('click', () => selectSession(el.dataset.id));
  });
}

async function selectSession(id) {
  state.currentSessionId = id;
  state.sessionDetail = null;
  lastDetailFp = null;
  renderSessionList();
  $('#session-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadSessionDetail(id);
}

// 上次渲染会话详情的指纹：内容没变就不重渲染（轮询期间避免闪烁与滚动重置）
let lastDetailFp = null;

async function loadSessionDetail(id, { quiet = false } = {}) {
  try {
    const s = await api(`/api/sessions/${id}`);
    state.sessionDetail = s;
    if (state.currentSessionId === id && state.tab === 'sessions') renderSessionDetail(s);
  } catch (e) {
    if (!quiet) $('#session-detail').innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

function renderSessionDetail(s) {
  const detail = $('#session-detail');
  // 内容没变（轮询/SSE 重复推送）→ 完全不动 DOM，保住滚动位置和展开状态
  const fp = `${s.id}|${s.status}|${s.rounds || 0}|${(s.messages || []).length}|${(s.sent || []).length}|${s.error ? 1 : 0}`;
  if (lastDetailFp === fp) return;
  const firstRender = lastDetailFp === null;
  lastDetailFp = fp;

  // 保留用户的阅读位置；仅当用户本来就贴着底部时才跟随新内容（聊天式）
  const wasAtBottom = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 48;
  const keepScroll = detail.scrollTop;
  const chatName = s.chatKey.replace('group:', '群 ').replace('private:', '私聊 ');
  const statusBadge = `<span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>`;
  const usage = s.usage || {};

  const html = [];
  html.push(`
    <div class="detail-header">
      <h2>${esc(chatName)} ${statusBadge}</h2>
      <div class="sub">
        <span>触发：${esc(s.triggerSummary || (s.trigger === 'proactive' ? '主动机会' : '-'))}</span>
        <span>开始 ${fmtClock(s.startedAt)}${s.endedAt ? ` · 结束 ${fmtClock(s.endedAt)}` : ' · 进行中'}</span>
        <span>模型 ${esc(s.model || '-')}</span>
        <span>${usage.calls || 0} 次调用 · ${fmtTokens(usage.promptTokens)} 入 / ${fmtTokens(usage.completionTokens)} 出 / ${fmtTokens(usage.totalTokens)} 总</span>
        ${(usage.cachedTokens || usage.cacheMissTokens) ? `<span title="命中 ${fmtTokens(usage.cachedTokens || 0)} / 未命中 ${fmtTokens(usage.cacheMissTokens || 0)}">缓存命中 ${(() => { const c = usage.cachedTokens || 0; const m = usage.cacheMissTokens || 0; const b = c + m; return b > 0 ? Math.round(c / b * 1000) / 10 : 0; })()}%</span>` : ''}
        <span>${s.rounds || 0} 轮工具</span>
      </div>
    </div>`);

  if (s.systemPrompt) {
    html.push(`
      <details class="collapsible">
        <summary>系统提示（${s.systemPrompt.length} 字符，每次运行重发）</summary>
        <div class="coll-body">${fmtPrompt(s.systemPrompt)}</div>
      </details>`);
  }
  if (s.userPrompt) {
    html.push(`
      <details class="collapsible" open>
        <summary>本次输入（${s.userPrompt.length} 字符 —— 零对话历史，全部来自 JSON 存档）</summary>
        <div class="coll-body">${fmtPrompt(s.userPrompt)}</div>
      </details>`);
  }

  html.push('<div class="msg-flow">');
  for (const item of s.messages || []) {
    if (item.toolCall) {
      html.push(`
        <div class="tool-card ${item.toolCall.isError ? 'tool-error' : ''}">
          <div class="tool-head"><span class="tool-name">${esc(item.toolCall.name)}</span></div>
          <div class="tool-args">${esc(JSON.stringify(item.toolCall.args, null, 1))}</div>
          <div class="tool-result ${item.toolCall.isError ? 'is-error' : ''}">${esc(item.toolCall.result)}</div>
        </div>`);
    } else if (item.toolImages) {
      html.push(`
        <div class="tool-card">
          <div class="tool-head"><span class="tool-name">${esc(item.toolImages.tool)}</span>
          <span class="muted">→ ${item.toolImages.count} 张图片已作为图像输入注入模型</span></div>
        </div>`);
    } else if (item.role === 'assistant') {
      const text = typeof item.content === 'string' ? item.content : '';
      if (item.tool_calls && item.tool_calls.length && !text.trim()) continue; // 纯工具调用轮，卡片已展示
      html.push(`
        <div class="bubble bubble-assistant">
          <div class="asr-label">思考（不发送）</div>
          ${esc(text || '（无文本输出，仅调用工具）')}
        </div>`);
    }
  }
  // 发出的消息
  for (const sent of s.sent || []) {
    html.push(`
      <div class="sent-badge">
        <div class="asr-label">已发送到 QQ${sent.at ? ` · ${sent.at}` : ''}</div>
        ${esc(sent.text)}
      </div>`);
  }
  // 🔴 插件动作（偷图/发表情）—— 由 sticker-action SSE 事件追加
  const actions = (state.pluginActions || []).filter((a) => a.chatKey === s.chatKey);
  for (const a of actions) {
    if (a.type === 'collect') {
      html.push(`
        <div class="tool-card" style="border-left:3px solid var(--accent)">
          <div class="tool-head">
            <span class="tool-name">🐳 偷图收藏</span>
            <span class="muted">${a.inQQ ? '已写入 QQ 收藏' : '仅本地'}${a.selfLike ? ' · 像自己' : ''}${a.score ? ` · ${a.score}分` : ''}</span>
          </div>
          <div class="tool-result">${esc(a.note || '')}</div>
        </div>`);
    } else if (a.type === 'send') {
      html.push(`
        <div class="tool-card" style="border-left:3px solid var(--accent)">
          <div class="tool-head">
            <span class="tool-name">📤 发表情</span>
            <span class="muted">${esc(a.mood || '')}${a.note ? ` · ${esc(a.note)}` : ''}</span>
          </div>
        </div>`);
    }
  }

  if (s.error) html.push(`<div class="session-error">${esc(s.error)}</div>`);
  if (s.finishReason) html.push(`<div class="bubble bubble-user">finish：${esc(s.finishReason)}</div>`);
  html.push('</div>');

  // 折叠面板的展开状态也要保留（否则每次刷新"系统提示"都被折回去）
  const openStates = new Map();
  detail.querySelectorAll('details.collapsible').forEach((d, i) => openStates.set(i, d.open));
  detail.innerHTML = html.join('');
  detail.querySelectorAll('details.collapsible').forEach((d, i) => { if (openStates.has(i)) d.open = openStates.get(i); });
  if (firstRender || (s.status === 'running' && wasAtBottom)) {
    detail.scrollTop = detail.scrollHeight;      // 首次打开 / 贴底跟随新内容
  } else {
    detail.scrollTop = keepScroll;               // 保留阅读位置
  }
  if (s.status === 'running') {
    // 运行中轮询（仅当前打开的会话详情）
    setTimeout(() => { if (state.currentSessionId === s.id && state.tab === 'sessions') loadSessionDetail(s.id, { quiet: true }); }, 1500);
  }
}

// ── SnowLuma 页签：防闪烁基础设施 ──
// 本页每 4 秒被全局定时器刷新一次。早期实现每次都 `box.innerHTML = ...` 整块重建卡片，
// 导致二维码 <img> 与日志 <pre> 反复销毁重建、图片重复下载 → 屏幕持续闪烁。
// 现在：骨架只建一次（事件也只绑一次），之后只"按需打补丁"更新变化的文本；
// 二维码仅在 NapCat 换码（qrAt 变化）时才换 src。
const SL = { built: false, bound: false, qrTimer: null, qrAt: '', loggedIn: null, logText: '' };

function slEl(id) { return document.getElementById(id); }

function setText(id, text) {
  const el = slEl(id);
  if (el && el.textContent !== text) el.textContent = text;
}
function setDot(id, on) {
  const el = slEl(id);
  if (!el) return;
  const want = on ? 'dot dot-on' : 'dot dot-off';
  if (el.className !== want) el.className = want;
}

/** 建立卡片骨架 + 绑定事件（只做一次）。 */
function buildSnowlumaSkeleton() {
  const box = slEl('snowluma-page');
  if (!box || SL.built) return;
  box.innerHTML = `
    <div class="snowluma-page-card">
      <div class="snowluma-head" style="align-items:flex-start;gap:20px">
        <!-- 左侧：标题 + 状态速览（2026-10-27 优化：把原来散在下面的状态压到这里） -->
        <div style="flex:1;min-width:0">
          <h2 style="margin:0 0 10px">OneBot 网关</h2>
          <div style="display:grid;gap:5px;font-size:12.5px;line-height:1.6">
            <div><span class="dot" id="sl-dot-run2"></span> 网关进程：<strong id="sl-txt-run2">—</strong>
              <span class="muted" id="sl-txt-pid2"></span></div>
            <div><span class="dot" id="sl-dot-ob2"></span> OneBot：<strong id="sl-txt-ob2">—</strong>
              <span class="muted" id="sl-txt-obws2"></span></div>
            <div class="muted" id="sl-txt-dir2" style="font-size:11.5px;word-break:break-all"></div>
          </div>
          <!-- 账号密码登录移到这里（2026-10-27 用户要求），填满左侧空白 -->
          <div class="sl-login" id="sl-login-panel" style="margin-top:14px"></div>
        </div>
        <!-- 右侧：二维码 -->
        <div class="snowluma-qr" id="sl-qr-panel" style="flex:0 0 auto"></div>
      </div>
      <!-- 账号密码登录已上移到顶部左侧（2026-10-27） -->
      <!-- 账号总览与一键切号（2026-09-16 新增，见 renderAccountsPanel） -->
      <div class="sl-accounts" id="sl-accounts-panel"></div>
      <!-- 原状态行已移到顶部左侧（2026-10-27），这里保留隐藏元素供旧代码写入 -->
      <div style="display:none">
        <span class="dot" id="sl-dot-run"></span>
        <strong id="sl-txt-run"></strong>
        <span id="sl-txt-pid"></span>
        <span id="sl-txt-mode"></span>
        <span class="dot" id="sl-dot-ob"></span>
        <strong id="sl-txt-ob"></strong>
        <span id="sl-txt-obws"></span>
        <span id="sl-txt-dir"></span>
      </div>
      <div class="snowluma-state-row">
        <span>WebUI：</span>
        <span id="sl-webui-slot"></span>
      </div>

      <!-- ═══ SnowLuma 内嵌（2026-10-27）═══
           通过 nginx /snowluma/ 反代嵌入，已去掉 x-frame-options 与
           frame-ancestors 限制（本机自建备用通道，嵌进自家面板合理）。
           点「打开」才创建 iframe —— 不点不加载，避免白占资源。 -->
      <div class="snowluma-state-row" style="flex-direction:column;align-items:stretch;gap:8px">
        <div class="row" style="align-items:center;gap:8px;flex-wrap:wrap">
          <b>SnowLuma 控制台</b>
          <span class="muted" id="sl3-state" style="font-size:12px">—</span>
          <span class="muted" id="sl3-hint" style="font-size:11.5px"></span>
          <span style="flex:1"></span>
          <button class="btn btn-small" id="sl3-check">刷新状态</button>
          <button class="btn btn-small primary" id="sl3-open">打开</button>
          <button class="btn btn-small" id="sl3-close">收起</button>
          <button class="btn btn-small" id="sl3-newwin">新窗口</button>
        </div>
        <div id="sl3-frame-wrap" style="display:none">
          <div class="muted" style="font-size:11.5px;margin-bottom:6px">
            下方是 SnowLuma 控制台。首次进入需要在里面输入<b>访问令牌</b>（用密码登录可换取）。
          </div>
          <div id="sl3-frame-slot"></div>
        </div>
        <div class="muted" style="font-size:11.5px;line-height:1.7">
          · 走 <code>/snowluma/</code> 反代，已去掉 X-Frame-Options 与 frame-ancestors。<br>
          · 账号 <code>admin</code>　密码 <code id="sl3-pw">读取中…</code>
          <button class="btn tiny" id="sl3-getpw" style="margin-left:6px">取访问令牌</button>
        </div>
      </div>

      <!-- ═══ 通道切换 NapCat ⇄ SnowLuma（2026-10-27）═══ -->
      <div class="snowluma-state-row" style="flex-direction:column;align-items:stretch;gap:8px">
        <div class="row" style="align-items:center;gap:8px">
          <b>协议通道</b>
          <span class="muted" id="be-current" style="font-size:12px"></span>
          <span style="flex:1"></span>
          <button class="btn btn-small" id="be-refresh">刷新</button>
        </div>
        <div id="be-list" style="font-size:12.5px">点「刷新」查看可用通道</div>

        <!-- 选型建议（2026-10-27 用户要求）-->
        <div style="border:1px solid var(--line);border-radius:7px;padding:9px 11px;
                    background:var(--bg-soft,#faf9f7);font-size:11.5px;line-height:1.75">
          <div style="font-weight:600;margin-bottom:5px">怎么选？按你的情况对号入座</div>
          <div style="display:grid;gap:6px">
            <div>
              <b>NapCat</b> —— 需运行官方 QQ 客户端（Electron + 虚拟显示）
              <div class="muted" style="font-size:11px">
                ✅ <b>协议最真</b>：走真实客户端，行为与真人无异，抗风控能力最强<br>
                ✅ <b>功能最全</b>：支持语音 silk 转码、合并转发等依赖客户端的特性<br>
                ⚠️ <b>资源要求高</b>：要跑完整 QQ 客户端，需要图形环境（Xvfb），
                   磁盘与内存开销明显大于协议端<br>
                ⚠️ <b>部署较重</b>：装客户端 + 配虚拟显示 + 注入，步骤多、易出错<br>
                👉 适合：<b>主力号、高等级号</b>，或需要语音等完整功能的场景
              </div>
            </div>
            <div>
              <b>SnowLuma</b> —— 独立协议端，不依赖 QQ 客户端
              <div class="muted" style="font-size:11px">
                ✅ <b>轻量</b>：无需客户端、无需图形环境，解压即用，内置 Node<br>
                ✅ <b>部署简单</b>：一条命令装好，不吃 Xvfb 那套配置<br>
                ⚠️ <b>协议非官方</b>：风控风险理论上高于客户端协议<br>
                ⚠️ <b>生态较新</b>：遇到冷门问题可查资料比 NapCat 少<br>
                👉 适合：<b>小号 / 新号 / 测试号</b>，或服务器资源紧张、想快速上手的场景
              </div>
            </div>
          </div>
          <div class="muted" style="margin-top:6px;font-size:11px">
            两者都走标准 OneBot v11，插件完全通用，随时可换。
          </div>
          <div style="margin-top:8px;padding-top:7px;border-top:1px dashed var(--line)">
            <b>⚠️ 信息安全提醒</b>
            <div class="muted" style="font-size:11px;margin-top:3px;line-height:1.7">
              SnowLuma 默认开启 <code>#sl</code> 命令，<b>任何群友</b>发这句就能查到
              框架版本、平台（如 win32-x64）、运行时长 —— 等于把技术栈暴露给陌生人。<br>
              本项目的安装脚本<b>已默认关闭</b>该命令。如果你手动装的 SnowLuma，
              请编辑 <code>config/onebot.json</code> 把
              <code>statusCommand.enabled</code> 设为 <code>false</code> 后重启。
              NapCat 没有这类命令，无需处理。
            </div>
          </div>
        </div>

        <div class="muted" style="font-size:11.5px;line-height:1.7">
          · 两个协议端都走标准 OneBot v11，插件无需改动。<br>
          · <b>同一个 QQ 号不能同时在两边登录</b>（会互踢），切换时会自动停掉另一个。<br>
          · 切换后内核要重连才生效，会提示你重启。
        </div>
      </div>

      <!-- ═══ 账号切换（2026-10-27）═══
           换号是排查"账号被限 vs 接口坏了"最快的办法。 -->
      <div class="snowluma-state-row" style="flex-direction:column;align-items:stretch;gap:8px">
        <div class="row" style="align-items:center;gap:8px">
          <b>切换账号</b>
          <span class="muted" id="acct-current" style="font-size:12px"></span>
          <span style="flex:1"></span>
          <button class="btn btn-small" id="acct-refresh">刷新账号</button>
        </div>
        <div class="row" style="align-items:center;gap:8px;flex-wrap:wrap">
          <select id="acct-select" class="gr-select" style="min-width:220px">
            <option value="">点「刷新账号」读取本地登录态</option>
          </select>
          <button class="btn btn-small primary" id="acct-switch">切换并重启</button>
          <button class="btn btn-small" id="acct-delete" style="color:#c00">删除此号</button>
        </div>
        <div class="muted" style="font-size:11.5px;line-height:1.7">
          · 列出的是<b>本地已有登录态</b>的号；没有登录态的号重启后会掉到扫码。<br>
          · 切换会重启网关（约 60~90 秒），当前会话会断开重连。<br>
          · 删除只移除登录态文件（先备份到 config/.deleted/），当前正在用的号删不掉。
        </div>
      </div>

      <!-- ═══ 版本更新（2026-10-27）═══
           NapCat 与 QQ 客户端分别检测、分别升级。
           没安装的会显示「安装」而不是「更新」。 -->
      <div class="snowluma-state-row" style="flex-direction:column;align-items:stretch;gap:8px">
        <div class="row" style="align-items:center;gap:8px">
          <b>版本更新</b>
          <button class="btn btn-small" id="nq-check-btn">检测更新</button>
          <span class="muted" id="nq-check-hint" style="font-size:12px"></span>
        </div>
        <div id="nq-list" class="muted" style="font-size:12px">点「检测更新」查看 NapCat 与 QQ 客户端的版本情况</div>
      </div>
      <div class="snowluma-actions">
        <button class="btn btn-primary" id="sl-start-btn">启动网关</button>
        <button class="btn btn-danger" id="sl-stop-btn">关闭网关</button>
        <button class="btn btn-small" id="sl-restart-btn" title="发不出图片/文件时点这个。NapCat 跑久了富媒体通道会退化，重启即恢复">重启网关</button>
        <button class="btn btn-small" id="sl-refresh-btn">刷新状态</button>
        <button class="btn btn-small" id="sl-open-folder-btn">打开文件夹</button>
        <span id="sl-hint" class="muted" style="font-size:12px"></span>
      </div>
      <div>
        <div class="hint" style="margin-bottom:6px">运行日志（实时滚动，仅保留最近 500 行）</div>
        <pre class="snowluma-logs-view" id="sl-logs"></pre>
      </div>
    </div>`;
  SL.built = true;
  bindSnowlumaEvents();
}

function bindSnowlumaEvents() {
  if (SL.bound) return;
  SL.bound = true;

  slEl('sl-start-btn')?.addEventListener('click', async () => {
    const btn = slEl('sl-start-btn');
    btn.disabled = true; btn.textContent = '启动中…';
    setText('sl-hint', '');
    try {
      const r = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
      setText('sl-hint', r.alreadyRunning ? '网关已经在运行 ✓' : (r.ok ? '已启动，日志见下方。' : ('启动失败：' + r.error)));
    } catch (e) { setText('sl-hint', '启动失败：' + e.message); }
    setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
  });

  slEl('sl-stop-btn')?.addEventListener('click', async () => {
    const btn = slEl('sl-stop-btn');
    btn.disabled = true; btn.textContent = '关闭中…';
    setText('sl-hint', '');
    try {
      await api('/api/snowluma/stop', { method: 'POST', body: '{}' });
      setText('sl-hint', '已请求关闭网关。');
    } catch (e) { setText('sl-hint', '关闭失败：' + e.message); }
    setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
  });

  slEl('sl-refresh-btn')?.addEventListener('click', () => loadSnowlumaPage());

  // ── SnowLuma 内嵌控制台（2026-10-27）──
  //
  // 通过 nginx /snowluma/ 反代（已去掉 X-Frame-Options / frame-ancestors）。
  // 懒加载：点「打开」才建 iframe，不点不加载。
  slEl('sl3-open')?.addEventListener('click', () => {
    const wrap = slEl('sl3-frame-wrap');
    const slot = slEl('sl3-frame-slot');
    if (!wrap || !slot) return;
    if (!slot.querySelector('iframe')) {
      const f = document.createElement('iframe');
      f.src = '/snowluma/';
      f.style.cssText = 'width:100%;height:760px;border:1px solid var(--line);border-radius:8px;background:#fff';
      f.setAttribute('referrerpolicy', 'no-referrer');
      slot.appendChild(f);
    }
    wrap.style.display = 'block';
    const hint = slEl('sl3-hint');
    if (hint) hint.textContent = '已内嵌加载';
  });

  slEl('sl3-close')?.addEventListener('click', () => {
    const wrap = slEl('sl3-frame-wrap');
    if (wrap) wrap.style.display = 'none';
    const hint = slEl('sl3-hint');
    if (hint) hint.textContent = '已收起（iframe 保留，再点打开可恢复）';
  });

  // SnowLuma 状态查询（2026-10-27）
  //
  // 合并到控制台区块 —— 原先单独一块「SnowLuma 登录」跟这里功能重复，
  // 已删除（用户指出"新窗口和打开登录页其实重复了"）。
  const sl3Check = async () => {
    const el = slEl('sl3-state');
    if (!el) return;
    el.textContent = '检查中…';
    try {
      const d = await api('/api/snowluma-alt/status');
      if (!d?.ok) { el.textContent = '读取失败'; return; }
      if (!d.installed) { el.textContent = '未安装'; return; }
      const parts = [d.running ? '运行中' : '未运行'];
      if (d.running) parts.push(d.loggedIn ? `已登录 ${d.uin || ''}`.trim() : '未登录 QQ');
      el.textContent = parts.join(' · ');
      el.style.color = d.running && d.loggedIn ? '#2f855a' : (d.running ? '#b7791f' : 'var(--muted)');
    } catch (e) { el.textContent = '读取失败'; }
  };
  slEl('sl3-check')?.addEventListener('click', sl3Check);

  // 取访问令牌（2026-10-27 用户要求把密码给大家用）
  //
  // SnowLuma 登录页要的是「访问令牌」而不是密码，
  // 但令牌可以用密码换。这里自动换一次并复制到剪贴板，
  // 省得每个人还要去敲 curl。
  slEl('sl3-getpw')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    const oldTxt = btn.textContent;
    btn.textContent = '获取中…';
    try {
      const r = await api('/api/snowluma-alt/token', { method: 'POST', body: {} });
      if (!r?.ok) { alert('获取失败：' + (r?.error || '未知')); return; }
      const pwEl = slEl('sl3-pw');
      if (pwEl) pwEl.textContent = r.password || '';
      try {
        await navigator.clipboard.writeText(r.token || '');
        toast('访问令牌已复制到剪贴板，粘贴进下面的输入框即可');
      } catch {
        alert('访问令牌（手动复制）：\n\n' + (r.token || ''));
      }
    } catch (e) {
      alert('获取失败：' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = oldTxt;
    }
  });

  // 新窗口用**相对路径**，跟着当前访问域名走：
  //   从 qq.597457.xyz 打开 → https://qq.597457.xyz/snowluma/
  //   从 127.0.0.1:3210 打开 → http://127.0.0.1:3210/snowluma/
  // 原来写死 127.0.0.1:5099，公网用户根本打不开（2026-10-27 修）
  slEl('sl3-newwin')?.addEventListener('click', () => {
    window.open(location.origin + '/snowluma/', '_blank', 'noopener');
  });

  // ── 通道切换 NapCat ⇄ SnowLuma（2026-10-27）──
  //
  // 用户问："前端如何从napcat切换到snowluma？"
  // 内核连谁取决于 config.snowluma.wsUrl/httpUrl，这里做的就是改它 + 启停服务。

  const beRender = (d) => {
    const box = slEl('be-list');
    const cur = slEl('be-current');
    if (!box) return;
    if (cur) cur.textContent = d?.current ? `当前：${(d.backends || []).find((x) => x.current)?.label || d.current}` : '当前：未识别';
    const rows = (d?.backends || []).map((b) => {
      let btn = '';
      if (!b.installed) {
        btn = '<span class="muted">未安装</span>';
      } else if (b.current) {
        btn = '<span style="color:#2f855a">✓ 使用中</span>';
      } else {
        btn = `<button class="btn btn-small primary" data-be-switch="${esc(b.key)}">切到 ${esc(b.label)}</button>`;
      }
      const run = b.active
        ? '<span style="color:#2f855a">运行中</span>'
        : '<span class="muted">已停止</span>';
      return `
        <div class="row" style="align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--line)">
          <span style="min-width:90px;font-weight:600">${esc(b.label)}</span>
          ${run}
          <span class="muted" style="font-size:11.5px">${esc(b.wsUrl)}</span>
          <span style="flex:1"></span>
          ${btn}
        </div>`;
    }).join('');
    box.innerHTML = rows || '<span class="muted">没有可用通道</span>';

    box.querySelectorAll('[data-be-switch]').forEach((btn) => {
      btn.addEventListener('click', () => beSwitch(btn.dataset.beSwitch, btn));
    });
  };

  const beLoad = async () => {
    try {
      const d = await api('/api/napcat-qq/backend');
      if (d?.ok) beRender(d);
    } catch (e) { toast('读取通道失败：' + e.message); }
  };

  const beSwitch = async (target, btn) => {
    const label = target === 'snowluma' ? 'SnowLuma' : 'NapCat';
    if (!confirm(`切换到 ${label}？\n\n`
      + '· 会自动停掉另一个协议端（同一 QQ 号不能两处登录）\n'
      + `· 然后启动 ${label}，并把内核连接地址改过去\n`
      + '· 切换后内核需重连才生效（会再问你要不要重启）')) return;
    if (btn.disabled) return;
    btn.disabled = true;
    const oldTxt = btn.textContent;
    btn.textContent = '切换中…';
    try {
      const r = await api('/api/napcat-qq/switch-backend', { method: 'POST', body: { target } });
      if (r?.ok) {
        toast(`已切到 ${label}`);
        await beLoad();
        if (r.needKernelRestart) {
          const doRestart = confirm(
            `通道已切换为 ${label}。\n\n`
            + '但内核还在连旧地址，需要重启主服务才会生效。\n'
            + '重启会中断当前对话（约 20 秒）。\n\n'
            + '现在重启吗？（选「取消」可以稍后自己重启）'
          );
          if (doRestart) {
            toast('正在重启主服务…');
            try { await api('/api/self-restart', { method: 'POST' }); } catch { /* 重启期间必然断 */ }
            setTimeout(() => location.reload(), 25000);
          }
        }
      } else {
        alert('切换失败：' + (r?.error || '未知'));
      }
    } catch (e) {
      alert('切换失败：' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = oldTxt;
    }
  };

  slEl('be-refresh')?.addEventListener('click', beLoad);

  // ── 账号切换（2026-10-27）──
  //
  // 换号排查：同一个环境换个号，行为不同 → 账号问题；一样 → 环境/接口问题。

  const acctLoad = async () => {
    const sel = slEl('acct-select');
    const cur = slEl('acct-current');
    try {
      const d = await api('/api/napcat-qq/accounts');
      if (!d?.ok) { toast('读取账号失败'); return; }
      const list = d.accounts || [];
      if (cur) cur.textContent = d.current ? `当前配置：${d.current}` : '当前配置：未知';
      if (!sel) return;
      if (!list.length) {
        sel.innerHTML = '<option value="">本地没有可用登录态</option>';
        return;
      }
      sel.innerHTML = '<option value="">选择要切换的 QQ 号…</option>' + list.map((a) => {
        const t = a.updatedAt ? a.updatedAt.slice(0, 10) : '';
        return `<option value="${esc(a.uin)}"${a.isCurrent ? ' selected' : ''}>${esc(a.uin)}${a.isCurrent ? '（当前）' : ''} · ${esc(t)}</option>`;
      }).join('');
    } catch (e) {
      toast('读取账号失败：' + e.message);
    }
  };

  slEl('acct-refresh')?.addEventListener('click', acctLoad);

  // 删除账号登录态（2026-10-27 用户要求："登录历史添加账号删除"）
  slEl('acct-delete')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const uin = String(slEl('acct-select')?.value || '').trim();
    if (!uin) return toast('先选一个要删除的 QQ 号');
    if (!confirm(`删除 QQ ${uin} 的历史登录态？\n\n`
      + '· 删掉后这个号不会再出现在快速登录列表\n'
      + '· 以后要用它需要重新扫码\n'
      + '· 文件会先备份到 config/.deleted/')) return;
    if (btn.disabled) return;
    btn.disabled = true;
    const oldTxt = btn.textContent;
    btn.textContent = '删除中…';
    try {
      const r = await api('/api/napcat-qq/delete-account', { method: 'POST', body: { uin } });
      if (r?.ok) {
        toast(`已删除 ${uin}（${(r.removed || []).length} 个文件）`);
        await acctLoad();
      } else {
        alert('删除失败：' + (r?.error || '未知'));
      }
    } catch (e) {
      alert('删除失败：' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = oldTxt;
    }
  });
  slEl('acct-switch')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const uin = String(slEl('acct-select')?.value || '').trim();
    if (!uin) return toast('先选一个 QQ 号');
    if (!confirm(`切换到 QQ ${uin} 并重启网关？\n\n· 约需 60~90 秒\n· 机器人在此期间离线\n· 若该号没有登录态，需要扫码`)) return;
    if (btn.disabled) return;
    btn.disabled = true;
    const oldTxt = btn.textContent;
    btn.textContent = '切换中…';
    try {
      const r = await api('/api/napcat-qq/switch', { method: 'POST', body: { uin, restart: true } });
      if (r?.ok) {
        toast(`已切换到 ${r.uin}，网关重启中…`);
        // 🔴 立刻清掉「已登录」的残留状态（2026-10-27）
        //
        // 不清的话，界面右上角会一直显示旧账号的「✅ 已登录 3170037984」，
        // 用户以为切换没生效（实际 autoLoginAccount 已经改了、二维码也在重新生成）。
        SL.loggedIn = null;
        const qrBox = slEl('sl-qr-panel');
        if (qrBox) {
          qrBox.innerHTML = '<div class="sl-qr-empty">切换中…<br>'
            + '<span class="muted">网关重启后将显示新账号的登录状态</span></div>';
        }
        if (r.warn) setTimeout(() => alert(r.warn), 1200);
        // 重启要 60~90 秒，分几次刷新，确保二维码一出来就能看到
        [30000, 60000, 95000].forEach((ms) => setTimeout(() => loadSnowlumaPage(), ms));
      } else {
        alert('切换失败：' + (r?.error || '未知'));
      }
    } catch (e) {
      alert('切换失败：' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = oldTxt;
    }
  });

  // ── NapCat / QQ 版本检测与一键升级（2026-10-27）──
  //
  // 用户要求："检测 napcat 和 QQ 客户端新版本（分别），登录 tab 页一键更新，
  // 包括没安装的，直连最新版本通道"

  const nqRender = (d) => {
    const boxEl = slEl('nq-list');
    if (!boxEl) return;
    const rows = [];
    for (const [key, label] of [['napcat', 'NapCat'], ['qq', 'QQ 客户端'], ['snowluma', 'SnowLuma']]) {
      const x = (d && d[key]) || {};
      const loc = x.local || '未安装';
      const lat = x.latest || '未知';
      let status = '';
      let btn = '';
      if (x.needInstall) {
        status = '<span style="color:var(--acc)">未安装</span>';
        btn = `<button class="btn btn-small primary" data-nq-install="${key}">安装 ${esc(lat)}</button>`;
      } else if (x.needUpdate) {
        status = `<span style="color:#b7791f">有新版 ${esc(lat)}</span>`;
        btn = `<button class="btn btn-small primary" data-nq-install="${key}">更新到 ${esc(lat)}</button>`;
      } else {
        status = '<span style="color:#2f855a">已是最新</span>';
      }
      const err = x.error ? ` <span class="muted">（${esc(x.error)}）</span>` : '';
      // SnowLuma 是备用通道，标出来免得用户困惑为什么有两套
      const tag = key === 'snowluma'
        ? ' <span class="muted" style="font-size:11px">备用通道</span>'
        : '';
      rows.push(`
        <div class="row" style="align-items:center;gap:10px;padding:4px 0;border-bottom:1px solid var(--line)">
          <span style="min-width:90px;font-weight:600">${label}${tag}</span>
          <span>当前 <code>${esc(loc)}</code></span>
          <span>最新 <code>${esc(lat)}</code></span>
          <span style="flex:1"></span>
          ${status}${err}
          ${btn}
        </div>`);
    }
    boxEl.innerHTML = rows.join('') || '读取失败';
    boxEl.querySelectorAll('[data-nq-install]').forEach((b) => {
      b.addEventListener('click', () => nqInstall(b.dataset.nqInstall, b));
    });
  };

  const nqInstall = async (target, btn) => {
    const label = target === 'napcat' ? 'NapCat' : 'QQ 客户端';
    if (!confirm(`下载并安装最新的 ${label}？\n\n· 会先备份现有版本\n· 装完自动重启网关（约 60~90 秒）\n· 若登录态失效需要重新扫码`)) return;
    if (btn.disabled) return;
    btn.disabled = true;
    const oldTxt = btn.textContent;
    btn.textContent = '安装中…';
    toast(`开始下载 ${label}，请稍候（大包可能要一两分钟）`);
    try {
      const r = await api('/api/napcat-qq/update', {
        method: 'POST',
        body: { target, restart: true },
      });
      if (r?.ok) {
        toast(`${label} 已更新到 ${r.version || '最新版'}，网关重启中…`);
        // 重启期间接口会断，等 90 秒后刷新
        setTimeout(() => loadSnowlumaPage(), 90000);
      } else {
        alert(`${label} 安装失败：` + (r?.error || '未知'));
      }
    } catch (e) {
      alert(`${label} 安装失败：` + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = oldTxt;
    }
  };

  slEl('nq-check-btn')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const hint = slEl('nq-check-hint');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '检测中…';
    if (hint) hint.textContent = '';
    try {
      const d = await api('/api/napcat-qq/check');
      if (d?.ok) {
        nqRender(d);
        if (hint) hint.textContent = `检测于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
      } else if (hint) hint.textContent = '检测失败：' + (d?.error || '未知');
    } catch (e) {
      if (hint) hint.textContent = '检测失败：' + e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '检测更新';
    }
  });

  // 重启网关（2026-10-26）
  //
  // 用户要求："加一个重启按钮在登录界面"
  // 用途：NapCat 跑久了（实测 13 小时）富媒体通道退化 ——
  //      文字能发、图片/文件 10 秒超时。重启即恢复。
  slEl('sl-restart-btn')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    if (btn.disabled) return;
    if (!confirm('重启 OneBot 网关？\n\n· 约需 40~60 秒\n· 期间机器人暂时离线\n· 若登录态失效，需要重新扫码')) return;
    btn.disabled = true;
    const oldTxt = btn.textContent;
    btn.textContent = '重启中…';
    try {
      const r = await api('/api/snowluma/restart', { method: 'POST', body: {} });
      if (r?.ok) {
        toast('已发起重启，约 40~60 秒后恢复');
        // 轮询状态：起来了就自动刷新面板
        let tries = 0;
        const iv = setInterval(async () => {
          tries += 1;
          try {
            const s = await api('/api/status');
            const ob = s?.onebot || {};
            if (ob.connected) {
              clearInterval(iv);
              toast('网关已恢复');
              loadSnowlumaPage();
            }
          } catch { /* 重启期间接口必然失败，忽略 */ }
          if (tries > 30) { clearInterval(iv); loadSnowlumaPage(); }
        }, 3000);
      } else {
        alert(r?.error || '重启失败');
      }
    } catch (e) {
      alert('重启失败：' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = oldTxt;
    }
  });
  slEl('sl-open-folder-btn')?.addEventListener('click', async () => {
    try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
    catch (e) { setText('sl-hint', '失败：' + e.message); }
  });
}

// ── 账号密码登录（含人机验证中转）──
// 目的：QQ 风控掉线时，用户可在面板里自助用账密登录，不必找管理员扫码。
// 安全：**密码明文不出浏览器** —— 前端算 MD5 后只把 passwordMd5 发给后端。
// 人机验证走腾讯 TCaptcha（NapCat 返回的 proofWaterUrl 里带 aid/sid），
// 验证通过拿到 ticket/randstr 再回传后端完成登录。
const SLLogin = { uin: '', passwordMd5: '', capSid: '', capAid: '', busy: false, timer: null };

/** 纯 JS MD5（同步，无依赖）。密码只在这里转成 MD5，明文不上行。 */
function md5(str) {
  // 精简实现（RFC 1321），足够登录用
  function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
  function au(x, y) { const l = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff); }
  function cmn(q, a, b, x, s, t) { return au(rl(au(au(a, q), au(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  function tb(str2) {
    const n = ((str2.length + 8) >> 6) + 1;
    const blk = new Array(n * 16).fill(0);
    for (let i = 0; i < str2.length; i++) blk[i >> 2] |= str2.charCodeAt(i) << ((i % 4) * 8);
    blk[str2.length >> 2] |= 0x80 << ((str2.length % 4) * 8);
    blk[n * 16 - 2] = str2.length * 8;
    return blk;
  }
  function hex(num) { let s2 = ''; for (let i = 0; i < 4; i++) s2 += ('0' + ((num >> (i * 8)) & 0xff).toString(16)).slice(-2); return s2; }
  const utf8 = unescape(encodeURIComponent(str));
  const x = tb(utf8);
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222);
    c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = au(a, oa); b = au(b, ob); c = au(c, oc); d = au(d, od);
  }
  return hex(a) + hex(b) + hex(c) + hex(d);
}

function slLoginMsg(text, kind) {
  const el = slEl('sl-login-msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'sl-login-msg' + (kind ? ' ' + kind : '');
}

function renderSnowlumaLogin(info) {
  const box = slEl('sl-login-panel');
  if (!box) return;
  if (!info?.available) {
    box.innerHTML = '<div class="muted" style="font-size:12.5px">未找到 NapCat WebUI 配置，无法使用账密登录。</div>';
    return;
  }
  box.innerHTML = `
    <div class="sl-login-title">账号密码登录 <span class="muted">（风控掉线时用，免扫码）</span></div>
    <div class="field-row">
      <div class="field" style="max-width:170px">
        <label>QQ 号</label>
        <input type="text" id="sl-uin" placeholder="填写机器人 QQ 号" autocomplete="username">
      </div>
      <div class="field">
        <label>QQ 密码 <span class="muted">（仅在本机浏览器算 MD5，明文不上传）</span></label>
        <input type="password" id="sl-pwd" placeholder="密码" autocomplete="current-password">
      </div>
    </div>
    <div class="snowluma-actions">
      <button class="btn btn-primary btn-small" id="sl-do-login">登录</button>
      <button class="btn btn-small" id="sl-quick-login">快速登录（已登录过的号）</button>
      <span class="muted" id="sl-quick-list" style="font-size:12px"></span>
    </div>
    <div class="sl-login-msg" id="sl-login-msg"></div>
    <div id="sl-captcha-slot"></div>`;

  slEl('sl-do-login')?.addEventListener('click', doPasswordLogin);
  slEl('sl-quick-login')?.addEventListener('click', doQuickLogin);
  loadQuickList();
}

async function loadQuickList() {
  try {
    const r = await api('/api/snowluma/login/status');
    const list = r.quickList || [];
    const el = slEl('sl-quick-list');
    if (el) el.textContent = list.length ? ('可用：' + list.join('、')) : '（暂无快速登录记录）';
    const uinEl = slEl('sl-uin');
    if (uinEl && !uinEl.value && list.length === 1) uinEl.value = list[0];
  } catch { /* ignore */ }
}

async function doQuickLogin() {
  const uin = (slEl('sl-uin')?.value || '').trim();
  if (!uin) return slLoginMsg('请先填 QQ 号', 'err');
  if (!/^\d{5,12}$/.test(uin)) return slLoginMsg('QQ 号格式不对', 'err');
  if (!confirm(`用 ${uin} 快速登录？\n\n· 会重启网关（约 60~90 秒）\n· 该号需有历史登录态，否则要扫码`)) return;

  slLoginMsg('正在设定并重启网关…');
  try {
    const r = await api('/api/snowluma/login/set-quick', { method: 'POST', body: JSON.stringify({ uin, restart: true }) });
    if (!r.ok) return slLoginMsg('快速登录失败：' + r.error, 'err');

    // 说清楚到底做了什么（原来只提示"已请求"，用户以为卡死）
    if (r.restarted) {
      slLoginMsg(`✅ 已设定 ${uin} 并重启网关，约 60~90 秒后完成登录`, 'ok');
      SL.loggedIn = null;
      const qrBox = slEl('sl-qr-panel');
      if (qrBox) qrBox.innerHTML = '<div class="sl-qr-empty">网关重启中…<br>'
        + '<span class="muted">稍后自动刷新登录状态</span></div>';
      [30000, 60000, 95000].forEach((ms) => setTimeout(() => loadSnowlumaPage(), ms));
      if (r.warn) setTimeout(() => alert(r.warn), 1500);
    } else {
      slLoginMsg('⚠️ 已设定 ' + uin + '，但重启失败，请手动点「重启网关」', 'warn');
    }
  } catch (e) { slLoginMsg('失败：' + e.message, 'err'); }
}

async function doPasswordLogin() {
  const uin = (slEl('sl-uin')?.value || '').trim();
  const pwd = slEl('sl-pwd')?.value || '';
  if (!uin || !pwd) return slLoginMsg('请填 QQ 号与密码', 'err');
  if (!/^\d{5,12}$/.test(uin)) return slLoginMsg('QQ 号格式不对', 'err');
  SLLogin.uin = uin;
  SLLogin.passwordMd5 = md5(pwd);          // 明文到此为止，不上行
  if (slEl('sl-pwd')) slEl('sl-pwd').value = '';
  slLoginMsg('正在登录…');
  try {
    const r = await api('/api/snowluma/login/password', {
      method: 'POST',
      body: JSON.stringify({ uin, passwordMd5: SLLogin.passwordMd5 })
    });
    if (!r.ok) return slLoginMsg('登录失败：' + r.error, 'err');
    if (r.needNewDevice) return startNewDeviceVerify(r.jumpUrl, r.newDevicePullQrCodeSig);
    if (r.needCaptcha) {
      slLoginMsg('需要人机验证，请在下方完成', 'warn');
      return showCaptcha(r.proofWaterUrl);
    }
    slLoginMsg('登录请求已发送，稍候观察状态', 'ok');
  } catch (e) { slLoginMsg('失败：' + e.message, 'err'); }
}


/* ───────────────────────── 账号总览与一键切号（2026-09-16 新增）─────────────────────────
 *
 * 背景：用户点了原来的「快速登录（已登录过的号）」按钮，提示「已请求快速登录，请稍候观察状态…」
 *       然后**永远没反应**。查明真凶：该按钮调的是 NapCat 的 SetQuickLoginQQ，
 *       它**只是设定『下次快速登录用哪个号』，完全不触发登录动作** —— 状态自然不会变。
 *
 * 用户诉求：「直接展示后台在线账号，然后切换过去」。
 * 本区块因此：
 *   ① 列出每个 QQ 实例**当前真实登录的账号**（UIN + 昵称 + 端点）；
 *   ② 列出已缓存可快速登录的号；
 *   ③ 提供「切到此号」按钮 → 先设定、再询问是否重启生效（两步，避免误操作掉线）。
 *
 * 数据来自桌面端的 /api/qq/accounts（面板后端已透传，令牌不下发浏览器）。
 */
async function renderAccountsPanel() {
  const box = slEl('sl-accounts-panel');
  if (!box) return;
  let d;
  try {
    const r = await api('/api/accounts/overview');
    if (!r.ok) { box.innerHTML = '<div class="muted" style="font-size:12px">账号总览不可用：' + (r.error || '') + '</div>'; return; }
    d = r.data;
  } catch (e) {
    box.innerHTML = '<div class="muted" style="font-size:12px">账号总览读取失败：' + e.message + '</div>';
    return;
  }

  const rows = (d.instances || []).map((i) => `
    <div class="sl-acct-row">
      <span class="sl-acct-pill ${i.online ? 'on' : 'off'}">${i.online ? '在线' : '离线'}</span>
      <span class="sl-acct-label">${esc(i.label)}</span>
      <span class="sl-acct-uin">${i.online ? esc(i.uin + (i.nick ? '　' + i.nick : '')) : '—'}</span>
      <span class="muted" style="font-size:11px">${i.oneBotPort ? ':' + i.oneBotPort : ''}</span>
    </div>`).join('');

  const cached = (d.quickList || []).length
    ? d.quickList.map((q) => esc(q)).join('、')
    : '（无）';

  const switches = (d.switchable || []).map((s) => {
    const isCurrent = s.online && s.from === 'bot';
    return `
    <div class="sl-acct-row">
      <span class="sl-acct-pill ${s.online ? 'on' : 'off'}">${s.online ? '在线' : '已缓存'}</span>
      <span class="sl-acct-uin">${esc(s.uin)}${s.nick ? '　' + esc(s.nick) : ''}</span>
      <span class="muted" style="font-size:11px">${esc(s.fromLabel)}</span>
      <span style="flex:1"></span>
      ${isCurrent
        ? '<span class="sl-acct-cur">✓ 当前使用中</span>'
        : `<button class="btn btn-small" data-switch-uin="${esc(s.uin)}" data-switch-nick="${esc(s.nick || '')}">切到此号</button>`}
    </div>`;
  }).join('');

  box.innerHTML = `
    <div class="sl-accounts-title">后台在线账号 <span class="muted" style="font-size:11.5px">${esc(d.note || '')}</span></div>
    <div class="sl-accounts-card">
      ${rows || '<div class="muted" style="font-size:12px">未发现实例</div>'}
      <div class="muted" style="font-size:11.5px;margin-top:8px">已缓存可快速登录：${cached}</div>
    </div>
    <div class="sl-accounts-title" style="margin-top:12px">切换机器人登录账号</div>
    <div class="sl-accounts-card">
      ${switches || '<div class="muted" style="font-size:12px">暂无可切换账号</div>'}
      <div class="muted" style="font-size:11px;margin-top:8px;line-height:1.7">
        点「切到此号」= 先把它设为机器人的快速登录账号，再询问是否重启 NapCat 生效。<br>
        ⚠️ 重启期间机器人会短暂离线（30–60 秒）；同一 QQ 号不能在两处同时在线（会互踢）。
      </div>
    </div>`;

  // 绑定切号按钮
  box.querySelectorAll('[data-switch-uin]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const uin = btn.getAttribute('data-switch-uin');
      const nick = btn.getAttribute('data-switch-nick') || '';
      const ok = window.confirm(
        '将把 QQ 机器人的快速登录账号设为 ' + uin + (nick ? '（' + nick + '）' : '') + '。\n\n' +
        '⚠️ 这一步只是「设定」；需要重启 NapCat 才会真正用它登录，\n' +
        '   期间机器人会短暂离线（约 30–60 秒）。\n\n' +
        '另外：同一个 QQ 号不能在两处同时在线，否则会互踢。\n\n' +
        '确定继续吗？'
      );
      if (!ok) return;
      btn.disabled = true;
      btn.textContent = '设定中…';
      try {
        const r1 = await api('/api/accounts/switch', {
          method: 'POST',
          body: JSON.stringify({ action: 'bot-quick-login', uin })
        });
        if (!r1.ok) { alert('设定失败：' + (r1.error || '')); btn.disabled = false; btn.textContent = '切到此号'; return; }
        btn.textContent = '重启中…';
        const r2 = await api('/api/accounts/switch', {
          method: 'POST',
          body: JSON.stringify({ action: 'bot-restart' })
        });
        alert(r2.ok ? ('已设定并重启机器人。\n\n' + (r2.message || '') + '\n\n约 30–60 秒后完成登录，可稍后刷新查看。')
                    : ('设定成功，但重启失败：' + (r2.error || r2.message || '')));
      } catch (e) {
        alert('操作失败：' + e.message);
      }
      btn.disabled = false;
      btn.textContent = '切到此号';
      setTimeout(renderAccountsPanel, 1500);
    });
  });
}

// 注：HTML 转义复用文件顶部已有的 esc()（第 50 行），不重复定义。

/** 登录面板只渲染一次（否则 4 秒定时刷新会把用户输入冲掉）。 */
function renderSnowlumaLoginOnce() {
  const box = slEl('sl-login-panel');
  if (!box) return;
  if (box.dataset.ready === '1') return;      // 已建，保留用户输入
  box.dataset.ready = '1';
  api('/api/snowluma/login/info')
    .then((info) => renderSnowlumaLogin(info))
    .catch(() => { box.dataset.ready = ''; });
}

// ── 新设备扫码验证 ──
// QQ 检测到"新设备登录"时会要求用**手机 QQ 扫码**确认（不是登录二维码，是设备验证）。
// 流程：GetNewDeviceQRCode 取 str_url → 渲染二维码 → 每 2.5s 轮询 PollNewDeviceQR
//       → 手机确认后拿 str_nt_succ_token → NewDeviceLogin 完成登录。
const SLDev = { uin: '', passwordMd5: '', bytesToken: '', timer: null };

function stopDevPoll() {
  if (SLDev.timer) { clearInterval(SLDev.timer); SLDev.timer = null; }
}

async function startNewDeviceVerify(jumpUrl, sig) {
  stopDevPoll();
  const slot = slEl('sl-captcha-slot');
  if (!slot) return;
  SLDev.uin = SLLogin.uin;
  SLDev.passwordMd5 = SLLogin.passwordMd5;
  slLoginMsg('检测到新设备：请用**手机 QQ** 扫码确认（不是登录码）', 'warn');
  slot.innerHTML = '<div class="sl-captcha-box"><div class="muted">正在获取验证二维码…</div></div>';

  try {
    const r = await api('/api/snowluma/login/new-device-qr', {
      method: 'POST',
      body: JSON.stringify({ uin: SLDev.uin, jumpUrl })
    });
    if (!r.ok) { slot.innerHTML = ''; return slLoginMsg('获取验证二维码失败：' + r.error, 'err'); }
    const qr = r.qr || {};
    SLDev.bytesToken = qr.bytes_token || '';
    if (!qr.str_url) { slot.innerHTML = ''; return slLoginMsg('NapCat 未返回验证二维码', 'err'); }

    const imgTag = r.qrImage
      ? '<img class="sl-devqr-img" src="' + r.qrImage + '" alt="新设备验证二维码">'
      : '<div class="muted">（服务端未生成图片，请点下方链接）</div>';
    slot.innerHTML = '<div class="sl-captcha-box">'
      + '<div class="sl-login-title">用手机 QQ 扫码完成设备验证</div>'
      + imgTag
      + '<div class="sl-devqr-hint" id="sl-devqr-hint">等待扫码…</div>'
      + '<div class="muted" style="font-size:12px;word-break:break-all">扫码不了可复制：'
      + '<a href="' + esc(qr.str_url) + '" target="_blank" rel="noopener">验证链接</a></div>'
      + '</div>';

    startDevPoll();
  } catch (e) {
    slot.innerHTML = '';
    slLoginMsg('失败：' + e.message, 'err');
  }
}

function startDevPoll() {
  stopDevPoll();
  SLDev.timer = setInterval(async () => {
    try {
      const r = await api('/api/snowluma/login/new-device-poll', {
        method: 'POST',
        body: JSON.stringify({ uin: SLDev.uin, bytesToken: SLDev.bytesToken })
      });
      if (!r.ok) return;
      const p = r.poll || {};
      const st = p.uint32_guarantee_status;
      if (st === 3) {
        const h = slEl('sl-devqr-hint');
        if (h) h.textContent = '已扫描，请在手机上确认…';
      } else if (st === 1) {
        stopDevPoll();
        const h = slEl('sl-devqr-hint');
        if (h) h.textContent = '验证成功，正在登录…';
        // 用返回的 token 完成登录
        await finishNewDeviceLogin(p.str_nt_succ_token || SLDev.bytesToken);
      }
    } catch { /* 轮询失败继续 */ }
  }, 2500);
}

async function finishNewDeviceLogin(sig) {
  try {
    const r = await api('/api/snowluma/login/new-device', {
      method: 'POST',
      body: JSON.stringify({
        uin: SLDev.uin, passwordMd5: SLDev.passwordMd5, newDevicePullQrCodeSig: sig
      })
    });
    if (!r.ok) return slLoginMsg('设备验证后登录失败：' + r.error, 'err');
    slLoginMsg('登录成功 ✧ 稍候即可收发消息', 'ok');
    const slot = slEl('sl-captcha-slot');
    if (slot) slot.innerHTML = '';
  } catch (e) { slLoginMsg('失败：' + e.message, 'err'); }
}

/** 渲染腾讯 TCaptcha：解析 proofWaterUrl 里的 aid/sid，动态加载 TCaptcha.js。 */
function showCaptcha(proofWaterUrl) {
  const slot = slEl('sl-captcha-slot');
  if (!slot) return;
  let aid = '', sid = '';
  try {
    const q = proofWaterUrl.includes('?') ? proofWaterUrl.split('?')[1].split('#')[0] : '';
    for (const kv of q.split('&')) {
      const [k, v] = kv.split('=');
      if (k === 'aid') aid = decodeURIComponent(v || '');
      if (k === 'sid') sid = decodeURIComponent(v || '');
    }
  } catch { /* ignore */ }
  SLLogin.capAid = aid || '2081081773';
  SLLogin.capSid = sid;
  slot.innerHTML = '<div class="sl-captcha-box"><div id="sl-captcha-target"></div>'
    + '<div class="muted" style="font-size:12px">若验证码未出现，点此手动打开：'
    + '<a href="' + esc(proofWaterUrl) + '" target="_blank" rel="noopener">验证链接</a></div></div>';

  const load = (src) => new Promise((resolve, reject) => {
    if (window.TencentCaptcha) return resolve();
    const sc = document.createElement('script');
    sc.src = src; sc.onload = () => resolve(); sc.onerror = () => reject(new Error('load fail'));
    document.head.appendChild(sc);
  });
  load('https://captcha.gtimg.com/TCaptcha.js')
    .catch(() => load('https://ssl.captcha.qq.com/TCaptcha.js'))
    .then(() => {
      const cap = new window.TencentCaptcha(SLLogin.capAid, (res) => {
        if (res.ret === 0 && res.ticket) return submitCaptcha(res.ticket, res.randstr);
        slLoginMsg('验证未通过或已取消', 'err');
      }, { type: 'popup', showHeader: false, uin: SLLogin.uin, sid: SLLogin.capSid });
      cap.show();
    })
    .catch(() => slLoginMsg('验证码脚本加载失败，请点上面的验证链接手动完成', 'err'));
}

async function submitCaptcha(ticket, randstr) {
  slLoginMsg('验证通过，正在提交…');
  try {
    const r = await api('/api/snowluma/login/captcha', {
      method: 'POST',
      body: JSON.stringify({
        uin: SLLogin.uin, passwordMd5: SLLogin.passwordMd5,
        ticket, randstr, sid: SLLogin.capSid
      })
    });
    if (!r.ok) return slLoginMsg('验证码登录失败：' + r.error, 'err');
    if (r.needNewDevice) return startNewDeviceVerify(r.jumpUrl, r.newDevicePullQrCodeSig);
    slLoginMsg('登录成功，稍候即可收发消息 ✧', 'ok');
  } catch (e) { slLoginMsg('失败：' + e.message, 'err'); }
}

// ── 卡片右上角的登录二维码 ──
async function renderSnowlumaQr(connectedHint, selfHint, opts = {}) {
  const box = slEl('sl-qr-panel');
  if (!box) return;

  const showLoggedIn = (nick, uid, force = false) => {
    // 🔴 force=true 用于账号切换后强制重绘（2026-10-27）
    //    原来只要 SL.loggedIn 已是 true 就直接 return，
    //    切换账号后界面停在"已登录旧账号"，看起来像没切成功。
    if (SL.loggedIn === true && !force) return;
    SL.loggedIn = true;
    box.innerHTML = '<div class="sl-qr-done">✅ 已登录'
      + (nick ? '<br><strong>' + esc(nick) + '</strong>' : '')
      + (uid ? '<br><span class="muted">' + esc(String(uid)) + '</span>' : '')
      + '</div>';
    stopSnowlumaQrTimer();
  };

  if (connectedHint === true) return showLoggedIn(selfHint?.nickname, selfHint?.userId);

  try {
    const r = await api('/api/snowluma/qr');
    if (r.loggedIn) return showLoggedIn(r.self?.nickname, r.self?.userId);
    // 账号掉线/切换后：loggedIn 变 false，要把 SL 标记一起清掉，
    // 否则下次真登录了 showLoggedIn 会因为「已是 true」而不重绘。
    const wasLoggedIn = SL.loggedIn === true;
    SL.loggedIn = false;
    if (wasLoggedIn) {
      // 身份变了，强制把二维码区域重置，走下面的"显示二维码"流程
      box.innerHTML = '';
    }

    if (!r.exists) {
      if (box.querySelector('.sl-qr-img') || !box.querySelector('.sl-qr-empty')) {
        box.innerHTML = '<div class="sl-qr-empty">等待 NapCat 生成二维码…<br>'
          + '<span class="muted">若长时间无二维码，请检查下方日志</span></div>';
      }
      return;
    }

    const age = Math.round((r.ageMs || 0) / 1000);
    const stale = age > 150;   // NapCat 约 2 分钟换一次
    const hint = stale ? '⏳ 二维码可能已过期，等待刷新…' : ('用手机 QQ 扫码 · ' + age + 's 前刷新');

    const img = box.querySelector('.sl-qr-img');
    if (!img) {
      box.innerHTML = '<div class="sl-qr-title">扫码登录 QQ</div>'
        + '<img class="sl-qr-img" src="/api/snowluma/qr.png?t=' + Date.now() + '" alt="登录二维码">'
        + '<div class="sl-qr-hint" id="sl-qr-hint"></div>'
        + '<div style="margin-top:6px"><button class="btn btn-small" id="sl-qr-refresh">刷新二维码</button></div>';
      SL.qrAt = r.qrAt;
    } else if (opts.forceReload === true) {
      // 用户主动点刷新：不管换没换码，都重拉一次图
      img.src = '/api/snowluma/qr.png?t=' + Date.now();
      SL.qrAt = r.qrAt;
    } else if (r.qrAt && r.qrAt !== SL.qrAt) {
      SL.qrAt = r.qrAt;                    // 仅在 NapCat 换码时换图，避免闪烁
      img.src = '/api/snowluma/qr.png?t=' + Date.now();
    }
    setText('sl-qr-hint', hint);

    // 手动刷新二维码（2026-10-27 用户要求："加入刷新二维码功能，不点击不主动刷新"）
    //
    // 两种刷新语义：
    //   ① 本地重载 — 只是重新拉一次 qr.png（NapCat 没换码时看到的是同一张）
    //   ② 请求换码 — 调 refresh-qr 让 NapCat 生成新码（原码可能已过期）
    // 这里默认只做 ①，因为 ② 会作废当前正在扫的码，容易让人白扫。
    const rbtn = box.querySelector('#sl-qr-refresh');
    if (rbtn && !rbtn.dataset.bound) {
      rbtn.dataset.bound = '1';
      rbtn.addEventListener('click', async () => {
        if (rbtn.disabled) return;
        if (!confirm('放弃当前二维码并重新生成一张？\n\n当前这张会立即作废，需要重新扫码。')) return;
        rbtn.disabled = true;
        const oldTxt = rbtn.textContent;
        rbtn.textContent = '重新生成中…';
        try {
          // 🔴 真刷新 = 作废旧码 + 让 NapCat 生成新码（2026-10-27 用户澄清）
          //
          // 之前只做了"重拉一次图片"，NapCat 没换码时看到的是同一张，
          // 倒计时也不重置 —— 那不是刷新，只是重新下载。
          // 现在调 /api/snowluma/login/refresh-qr 让上游真的换码。
          const r = await api('/api/snowluma/login/refresh-qr', { method: 'POST', body: {} });
          if (!r?.ok) {
            toast('重新生成失败：' + (r?.error || '未知'));
            return;
          }
          // NapCat 换码后会写新的 qrcode.png，稍等一下再取图
          await new Promise((z) => setTimeout(z, 1200));
          // 清掉 qrAt + 清空容器 —— 让 renderSnowlumaQr 走"首图"分支
          // 完整重建二维码块，倒计时才会从 0s 重新开始（用户明确要求）
          SL.qrAt = '';
          const qrBox = slEl('sl-qr-panel');
          if (qrBox) qrBox.innerHTML = '';
          await renderSnowlumaQr(false, null, { forceReload: true });
          toast('已生成新二维码，请重新扫码');
        } catch (e) {
          toast('刷新失败：' + e.message);
        } finally {
          rbtn.disabled = false;
          rbtn.textContent = oldTxt;
        }
      });
    }
    startSnowlumaQrTimer();
  } catch (e) {
    if (!box.querySelector('.sl-qr-empty')) {
      box.innerHTML = '<div class="sl-qr-empty">二维码加载失败<br><span class="muted">' + esc(e.message) + '</span></div>';
    }
  }
}

function startSnowlumaQrTimer() {
  // 🔴 不做自动轮询（2026-10-27 用户要求："不点击不主动刷新二维码"）
  //
  // 原来每 5 秒自动重渲染一次，会不停请求 /api/snowluma/qr.png，
  // 也没必要 —— NapCat 自己约 2 分钟才换一次码，5 秒刷是浪费。
  // 现在改为：只在首次进入页面时渲染一次，之后由用户点「刷新二维码」触发。
  if (SL.qrTimer) return;
  SL.qrTimer = true;   // 标记已初始化，避免重复
}
function stopSnowlumaQrTimer() {
  SL.qrTimer = null;
}

// ── SnowLuma 独立页签 ──
async function loadSnowlumaPage({ quiet = false } = {}) {
  try {
    const [status, logs] = await Promise.all([
      api('/api/status'),
      api('/api/snowluma/logs')
    ]);
    const s = status;
    const box = $('#snowluma-page');
    if (!box) return;
    const running = !!(s.snowluma?.running);
    const onebotConnected = !!s.onebot?.connected;
    const dir = s.snowluma?.dir || '';
    const embedded = !!s.snowluma?.embedded;
    const pid = s.snowluma?.pid ?? null;
    const webuiUrl = s.snowluma?.webuiUrl || '';
    const logText = (logs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';

    buildSnowlumaSkeleton();
    {
      const _s = s;
      const _running = !!( _s.snowluma?.running );
      const _obOk = !!_s.onebot?.connected;
      const _pid = _s.snowluma?.pid ?? null;
      const _embedded = !!_s.snowluma?.embedded;
      const _webui = _s.snowluma?.webuiUrl || '';

      setDot('sl-dot-run', _running);
      setText('sl-txt-run', _running ? '运行中' : '未运行');
      setText('sl-txt-pid', _pid ? ('pid ' + _pid) : '');
      setText('sl-txt-mode', _embedded ? '内置模式（随 QQ Agent 退出）' : (_running ? '独立模式' : ''));

      setDot('sl-dot-ob', _obOk);
      const _acct = _s.onebot?.account || {};
      const _acctOff = _acct.online === false;
      if (_acctOff) {
        const _m = _acct.offlineMs ? Math.round(_acct.offlineMs / 60000) : 0;
        setText('sl-txt-ob', '⚠ 账号已离线' + (_m ? ('（' + _m + ' 分钟）') : ''));
        setDot('sl-dot-ob', false);
      } else {
        setText('sl-txt-ob', _obOk ? ('已连接' + (_s.onebot.self ? ('（' + _s.onebot.self.nickname + '）') : '')) : '未连接');
        setDot('sl-dot-ob', _obOk);
      }
      setText('sl-txt-obws', _acctOff
        ? ('账号离线 —— 扫码或检查登录' + (_acct.lastError ? ('（' + _acct.lastError + '）') : ''))
        : (_s.onebot?.error ? ('WS ：' + _s.onebot.error) : ''));
      setText('sl-txt-dir', '目录：' + (dir || '（未找到项目内 snowluma/ 文件夹）'));

      // 把同样的状态同步到顶部左侧的紧凑面板（2026-10-27 布局优化）
      // 直接用 innerHTML 复制，避免再写一遍判断逻辑
      const mirror = [
        ['sl-txt-run2', 'sl-txt-run'],
        ['sl-txt-pid2', 'sl-txt-pid'],
        ['sl-txt-ob2', 'sl-txt-ob'],
        ['sl-txt-obws2', 'sl-txt-obws'],
        ['sl-txt-dir2', 'sl-txt-dir'],
      ];
      for (const [dst, src] of mirror) {
        const a = slEl(src);
        const b = slEl(dst);
        if (a && b) b.innerHTML = a.innerHTML;
      }
      const d1 = slEl('sl-dot-run'); const d2 = slEl('sl-dot-run2');
      if (d1 && d2) d2.className = d1.className;
      const e1 = slEl('sl-dot-ob'); const e2 = slEl('sl-dot-ob2');
      if (e1 && e2) e2.className = e1.className;

      const webSlot = slEl('sl-webui-slot');
      if (webSlot) {
        const want = _webui
          ? ('<button class="btn btn-small" id="sl-open-webui-btn" title="在浏览器中打开网关控制台">' + esc(_webui) + '</button>')
          : '<span class="muted">等待网关启动后自动识别…</span>';
        if (webSlot.innerHTML !== want) {
          webSlot.innerHTML = want;
          const b = slEl('sl-open-webui-btn');
          if (b) b.addEventListener('click', async () => {
            try {
              const r = await api('/api/snowluma/open-webui', { method: 'POST', body: '{}' });
              if (!r.ok) setText('sl-hint', r.error);
            } catch (e) { setText('sl-hint', '打开失败：' + e.message); }
          });
        }
      }

      const startBtn = slEl('sl-start-btn');
      if (startBtn) {
        const label = _running ? '已运行' : '启动网关';
        if (startBtn.textContent !== label) startBtn.textContent = label;
        if (startBtn.disabled !== _running) startBtn.disabled = _running;
      }
      const stopBtn = slEl('sl-stop-btn');
      if (stopBtn && stopBtn.disabled === _running) stopBtn.disabled = !_running;

      // 日志：内容变化才写，并保持贴底滚动
      const pre = slEl('sl-logs');
      if (pre && logText !== SL.logText) {
        SL.logText = logText;
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
        pre.textContent = logText;
        if (atBottom) pre.scrollTop = pre.scrollHeight;
      }

      // ⚠️ 必须传「账号是否真的在线」，不能传 _obOk（= WS 是否连着）。
      //    NapCat 的 WS 在账号离线时依然在监听，传 _obOk 会让面板误显示
      //    「✅ 已登录」，于是**不显示二维码**，用户想重登都没码可扫。
      //    （2026-09-16 事故：掉线后二维码消失，用户无法自助恢复）
      renderSnowlumaQr(_acctOff === false, _s.onebot?.self || null);
    renderSnowlumaLoginOnce();
    // 账号总览与一键切号：每轮刷新都重渲染（数据实时变化，且没有用户输入需要保留）
    renderAccountsPanel().catch(() => {});
    }

  } catch (e) {
    if (!quiet) console.error(e);
  }
}

// ── 存档视图 ──
async function loadChats({ quiet = false } = {}) {
  try {
    const data = await api('/api/chats');
    state.chats = data.chats || [];
    renderChatList();
    if (state.currentChatKey) {
      // 打开着某群详情时也刷新该群消息
      loadChatMessages(state.currentChatKey);
    }
  } catch (e) { if (!quiet) console.error(e); }
}

function renderChatList() {
  const box = $('#chat-items');
  box.innerHTML = state.chats.map((c) => {
    const name = c.key.replace('group:', '群 ').replace('private:', '私聊 ');
    return `
      <div class="chat-item ${c.key === state.currentChatKey ? 'selected' : ''}" data-key="${c.key}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(name)}</span>
          ${c.unread ? `<span class="unread-pill">${c.unread}</span>` : ''}
        </div>
        <div class="chat-item-sub">${esc(c.lastText || '（空）')}</div>
        <div class="session-meta"><span>${c.total} 条</span><span>${fmtTime(c.lastTs)}</span></div>
      </div>`;
  }).join('') || '<div class="list-head muted">还没有消息存档（等白名单里的群/好友来消息）</div>';
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => selectChat(el.dataset.key));
  });
}

async function selectChat(key) {
  state.currentChatKey = key;
  renderChatList();
  $('#chat-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadChatMessages(key);
}

async function loadChatMessages(key) {
  try {
    const data = await api(`/api/chats/${key.replace(':', '_')}/messages?limit=200`);
    state.chatMessages = data.messages || [];
    renderChatMessages();
  } catch (e) {
    $('#chat-detail').innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

function renderChatMessages() {
  const key = state.currentChatKey;
  if (!key) return;
  const name = key.replace('group:', '群 ').replace('private:', '私聊 ');
  const meta = state.chats.find((c) => c.key === key) || {};
  const detail = $('#chat-detail');
  const rows = state.chatMessages.map((m) => `
    <tr class="${m.read ? '' : 'unread'}">
      <td class="t">${fmtTime(m.ts)}</td>
      <td class="w ${m.self ? 'self' : ''}">${m.self ? '我' : esc(m.senderName)}</td>
      <td class="text">${esc(m.text)}${m.read ? '' : ' <span class="unread-pill">未读</span>'}</td>
    </tr>`).join('');
  detail.innerHTML = `
    <div class="detail-header">
      <h2>${esc(name)} ${meta.unread ? `<span class="unread-pill">${meta.unread} 未读</span>` : ''}</h2>
      <div class="sub"><span>共 ${meta.total || 0} 条 · 存储于 data/messages/</span></div>
    </div>
    <div class="chat-toolbar">
      <button class="btn btn-small" id="chat-wake-btn">唤醒一次处理</button>
      <button class="btn btn-small" id="chat-read-btn">全部标为已读</button>
      <input type="text" id="test-send-text" placeholder="手动发一条测试消息（不走模型）" style="flex:1" />
      <button class="btn btn-small" id="chat-testsend-btn">发送</button>
    </div>
    <table class="archive-table"><tbody>${rows}</tbody></table>`;
  $('#chat-wake-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/wake`, { method: 'POST', body: '{}' });
    refreshStatus();
  });
  $('#chat-read-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/mark-read`, { method: 'POST', body: '{}' });
    loadChats();
    loadChatMessages(key);
  });
  $('#chat-testsend-btn').addEventListener('click', async () => {
    const input = $('#test-send-text');
    const text = input.value.trim();
    if (!text) return;
    const btn = $('#chat-testsend-btn');
    btn.textContent = '发送中…';
    try {
      await api(`/api/chats/${key.replace(':', '_')}/test-send`, { method: 'POST', body: JSON.stringify({ text }) });
      btn.textContent = '已发出 ✓';
      input.value = '';
      loadChatMessages(key);
    } catch (e) {
      btn.textContent = `失败：${e.message}`.slice(0, 40);
    }
    setTimeout(() => { btn.textContent = '发送'; }, 2500);
  });
}

// ── 设置视图 ──
async function loadSettings() {
  // 能力总览页已删除（2026-10-21）：工具清单与插件状态改由「插件」页展示，
  // 不再占用设置页的一次往返请求。
  const [cfg, tplData, provData, visionData] = await Promise.all([
    api('/api/config'),
    api('/api/persona-templates').catch(() => ({ templates: [] })),
    api('/api/providers').catch(() => ({ providers: [] })),
    api('/api/vision/results').catch(() => ({ results: {}, scanning: false }))
  ]);
  state.config = cfg;
  loadSearchKeys().catch(() => {});
  state.providers = provData.providers || [];
  state.visionResults = visionData.results || {};
  state.visionScanning = !!visionData.scanning;
  state.personaTemplates = {};
  for (const t of tplData.templates || []) state.personaTemplates[t.id] = { name: t.name, text: t.text, builtin: !!t.builtin, group: t.group || '' };
  state.personaGroups = tplData.groups || [];
  renderSettings();
}

function renderPersonaPicker(c) {
  const currentId = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === (c.persona?.roleText || ''))?.[0] || '';
  const currentName = state.personaTemplates[currentId]?.name || '';
  return `
    <div class="field-row" style="align-items:flex-end">
      <div class="field">
        <label>选择人设（点击选择）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-persona-pick" readonly placeholder="点击选择人设" value="${esc(currentName)}" style="flex:1;cursor:pointer" />
          <button class="btn btn-small" id="new-persona-btn">＋ 添加人设</button>
          <button class="btn btn-small btn-danger hidden" id="del-persona-btn">删除当前自定义人设</button>
        </div>
        <span id="persona-pick-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>`;
}

function renderPersonaSaveBar() {
  return `
    <div class="persona-save-row">
      <button class="btn btn-primary" id="save-persona-btn">保存人设修改</button>
      <span id="persona-save-result" class="muted"></span>
    </div>`;
}

function renderHealthCard() {
  const { ready, checks } = assessReadiness(state.config, state.status);
  const rows = checks.map((c) => {
    let extra = '';
    if (!c.ok && c.fix === 'snowluma-tab') {
      extra = ' <button class="btn btn-small" id="hc-goto-snowluma">前往「登录」页签</button>';
    }
    return `
    <div class="h-item ${c.ok ? 'ok' : 'bad'}">
      <span>${c.ok ? '✓' : '✗'}</span>
      <span class="h-label">${esc(c.label)}${extra}</span>
    </div>`;
  }).join('');
  const testRow = `
    <div class="h-item ${'mute'}">
      <span>·</span>
      <span class="h-label">API 连通性：
        <button class="btn btn-small" id="test-api-btn">测试一下</button>
        <span id="test-api-result" class="muted"></span>
      </span>
    </div>`;
  return `
    <div class="health-card ${ready ? 'all-ok' : ''}">
      <div class="h-title">${ready ? '✅ 一切就绪，机器人运行中' : '🧭 完成下面缺失项就能跑起来'}</div>
      ${rows}
      ${testRow}
    </div>`;
}

// 人设模板数据：state.personaTemplates（由 loadSettings 从后端填充）

// ── 模型目录（多提供商；面板式选择 + 图片输入能力徽标） ──
function visionBadge(providerId, model) {
  const r = (state.visionResults || {})[`${providerId}|||${model}`];
  const src = r?.source === 'docs' ? '【官方资料】' : (r?.source === 'probe' ? '【在线探测】' : '');
  const t = (cls, text) => `<span class="vbadge ${cls}" title="${esc(src + (r?.note || ''))}">${text}</span>`;
  if (!r) return t('unk', '未检测');
  if (r.verdict === 'vision') return t('ok', '支持图片');
  if (r.verdict === 'no-vision') return t('no', '无图片输入');
  return t('unk', '无法判定');
}

// ── 两栏悬停下拉：左供应商 / 右模型 ──
function visionVerdictOf(providerId, model) {
  return (state.visionResults || {})[`${providerId}|||${model}`]?.verdict;
}

// 目录的"点击外部 / Esc 收起"监听器只在全局注册一次（renderSettings 每次重渲染都会
// 重建 DOM，若在这里注册会随渲染次数无限叠加、并引用已脱离文档的旧节点）。
// 事件触发时按 id 现查当前元素，天然跟随最新 DOM。
let modelDdDismissBound = false;
function bindModelDdDismiss() {
  if (modelDdDismissBound) return;
  modelDdDismissBound = true;
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('model-dd');
    if (!dd || dd.hidden || dd.contains(e.target)) return;
    const btn = document.getElementById('model-pick-btn');
    if (btn && btn.contains(e.target)) return;   // 按钮自己负责开合
    dd.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    const dd = document.getElementById('model-dd');
    if (dd && !dd.hidden && e.key === 'Escape') dd.hidden = true;
  });
}

function renderProviderColumn(c) {
  const provs = state.providers || [];
  if (!provs.length) return '<div class="muted" style="padding:10px;font-size:12px">目录为空——点"从 DSH 导入"。</div>';
  let html = '<div class="mdd-prov" data-pid="__manual__"><span class="mdd-prov-name">（手动输入模型名）</span></div>';
  for (const p of provs) {
    const warn = [!p.hasKey ? '⚠无密钥' : '', p.needsBaseUrl ? '⚠需补地址' : ''].filter(Boolean).join(' ');
    const visionOk = (p.models || []).filter((m) => visionVerdictOf(p.id, m) === 'vision').length;
    const meta = warn || `${p.models.length} 模型${visionOk ? ` · ${visionOk} 可看图` : ' · 0 可看图'}`;
    html += `<div class="mdd-prov" data-pid="${esc(p.id)}">
      <span class="mdd-prov-name">${esc(p.displayName || p.id)}</span>
      <span class="mdd-prov-meta">${esc(meta)}</span>
    </div>`;
  }
  return html;
}

function renderModelColumn(pid, c) {
  if (pid === '__manual__') {
    return '<div class="muted" style="padding:12px;font-size:12px">选此项后直接在下方"模型"输入框填任意模型名，并手动填 Base URL / Key。</div>';
  }
  const p = (state.providers || []).find((x) => x.id === pid);
  if (!p) return '';
  const current = `${c.api.provider || ''}|||${c.api.model || ''}`;
  return `<div class="mp-provider"><span>${esc(p.displayName || p.id)}${p.anthropicOrigin ? ' · Anthropic 协议' : ''}</span><span class="mp-url">${esc(p.baseURL || '无端点')}</span></div>
    ${p.models.map((m) => {
      const v = `${p.id}|||${m}`;
      return `<div class="mp-row${v === current ? ' current' : ''}" data-v="${esc(v)}"><span class="mp-name">${esc(m)}</span>${visionBadge(p.id, m)}</div>`;
    }).join('')}`;
}

function applyProviderPick(value, { silent = false } = {}) {
  const hint = $('#provider-hint');
  const store = $('#cfg-provider');
  if (!value || value === '__manual__') {
    store.value = '';
    if (!silent) hint.textContent = '手动模式：直接在下面填 Base URL / Key / 模型名。';
    return;
  }
  const [pid, model] = value.split('|||');
  const p = (state.providers || []).find((x) => x.id === pid);
  if (!p) { hint.textContent = '未找到该提供商，请重新从 DSH 导入。'; return; }
  store.value = pid;
  $('#cfg-model').value = model;
  const notes = [];
  if (p.baseURL) {
    $('#cfg-baseurl').value = p.baseURL;
    notes.push(`端点 ${p.baseURL}`);
  } else {
    notes.push('⚠ 该提供商地址未知，请手动填 Base URL');
  }
  if (p.hasKey && p.apiKey) {
    $('#cfg-apikey').value = p.apiKey;
    notes.push(`密钥已填充（${p.apiKeyFrom === 'manual' ? '手动保存' : `来自环境变量 ${p.apiKeyFrom}`}）`);
  } else {
    notes.push('⚠ 该提供商没有可用密钥，请手动粘贴 API Key');
  }
  if (p.anthropicOrigin) notes.push('（DSH 中为 Anthropic 协议，已按 OpenAI 兼容模式调用，若报错请换用其他模型）');
  hint.textContent = `已选 ${p.displayName || p.id} · ${model}：${notes.join('；')}`;
}

/**
 * 按已装载插件的 manifest.uiTab 动态渲染顶部页签。
 *
 * 为什么必须动态：页签原来写死在 index.html 里，
 * 插件卸载后页签还在，点进去就是"未知 API"报错。
 * 现在插件没了页签也没了，视图容器一并清理。
 */
/**
 * 按配置隐藏内置「插件」页（2026-10-25）
 *
 * 用户反馈：装上 plugin-center 后，「插件中心」与内置「插件」功能重复，
 * 而且插件中心是超集（分组折叠、黑名单、救援列表、批量开关）。
 *
 * 设计取舍：
 *   · 默认 false，行为与之前完全一致
 *   · 只在检测到 plugin-center 时生效 —— 否则藏了就没入口了
 *   · 幂等：重复调用不会出错（摘除是 remove，已删再删是空操作）
 *
 * @returns {boolean} 是否真的隐藏了
 */
function applyHidePluginPage(tabs = []) {
  if (state.config?.ui?.hidePluginPage !== true) return false;

  // 没装插件中心时忽略该配置，避免用户失去插件管理入口
  const hasCenter = tabs.some((t) => t.id === 'plugin-center');
  if (!hasCenter) {
    if (!state.__hidePluginWarned) {
      state.__hidePluginWarned = true;
      console.warn('[ui] ui.hidePluginPage 已开启，但没检测到 plugin-center，已忽略（否则会失去插件管理入口）');
    }
    return false;
  }

  $('#tab-plugins')?.remove();
  $('#view-plugins')?.remove();

  // 如果用户正停在被隐藏的页，切到插件中心
  if (state.tab === 'plugins') {
    state.tab = 'plugin-center';
    $$('.tab').find((x) => x.dataset.tab === 'plugin-center')?.click();
  }
  return true;
}

async function syncPluginTabs() {
  const holder = $('#plugin-tabs');
  if (!holder) return;

  // 🔴 配置要单独拉一次（2026-10-25）
  //
  // state.config 原本只在用户打开「设置」页时才由 loadSettings 赋值。
  // 而本函数在**页面启动时**就跑，那时 state.config 还是空对象 →
  // ui.hidePluginPage 读不到，开关形同虚设。
  // 这里补一次轻量请求（同一个接口，浏览器有缓存，代价很小）。
  if (!state.config || !('ui' in state.config) || !Object.keys(state.config).length) {
    try { state.config = await api('/api/config'); } catch { /* 拉不到就跳过隐藏 */ }
  }

  let tabs = [];
  try {
    const d = await api('/api/plugins');
    // 只保留"要占顶栏"的插件页签；inline 的收在插件页里渲染
    tabs = (d.tabs || []).filter((t) => t.inline !== true);
  } catch { tabs = []; }

  // 即使页签没变化，也要把「隐藏内置插件页」跑一遍（它与插件页签无关）
  applyHidePluginPage(tabs);

  const want = tabs.map((t) => t.id).join(',');
  if (holder.dataset.sig === want) return;      // 没变化就不重绘（避免闪）
  holder.dataset.sig = want;

  holder.innerHTML = tabs.map((t) =>
    `<button class="tab" data-tab="${esc(t.id)}">${esc(t.label)}</button>`
  ).join('');

  // 视图容器：有页签才有，卸掉时一并删除
  const main = $('#layout');
  for (const t of tabs) {
    // 容器内层 id 必须是 plugin-view-<id>（内核只认这个命名）。
    // 老版本建的是 <id>-page，这里做一次性纠正，避免升级后子页面空白。
    const exist = $(`#view-${t.id}`);
    if (exist && !$(`#plugin-view-${t.id}`)) exist.remove();
    if (!$(`#view-${t.id}`)) {
      const sec = document.createElement('section');
      sec.id = `view-${t.id}`;
      sec.className = 'view';
      // 容器 id 用 plugin-view-<tabId>：内核只认这个命名，不认具体插件
      sec.innerHTML = `<div id="plugin-view-${esc(t.id)}" class="snowluma-pane"></div>`;
      main.appendChild(sec);
    }
  }
  // 清理已卸载插件的视图
  //
  // 🔴 2026-10-25 修：**内置视图必须列全**，漏一个就会被误删。
  //    事故：加了 view-market（创造营核心页签）却忘了加进下面这个白名单，
  //    结果每次刷新页面，这段清理逻辑都会把它 remove() 掉 ——
  //    服务端 HTML 明明有，DOM 里却找不到，页签点开一片空白。
  //
  //    凡是 ui/index.html 里写死的 <section id="view-xxx">，都必须在这里列出。
  const hidePluginPage = applyHidePluginPage(tabs);
  const alive = new Set(tabs.map((t) => t.id));
  const builtin = ['sessions', 'chats', 'snowluma', 'skills', 'settings', 'market']
    .concat(hidePluginPage ? [] : ['plugins']);
  $$('[id^="view-"]').forEach((v) => {
    const id = v.id.slice(5);
    if (!builtin.includes(id) && !alive.has(id)) v.remove();
  });

  // 给新页签绑事件（两套绑定都要覆盖，见 switchTab 的注释）
  holder.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.remove('active'));
      tab.classList.add('active');
      $$('.view').forEach((x) => x.classList.remove('active'));
      const v = $(`#view-${tab.dataset.tab}`);
      if (v) v.classList.add('active');
      state.tab = tab.dataset.tab;
      dispatchTabLoad(state.tab);
    });
  });
}

/** 统一的页签加载分发（新增页签只改这里） */
// ── 市场页（核心页签，内容来自插件）──────────────────────────────
//
// 插件的 ui.js 通过 mountPluginUi 动态 import，
// 和「内联插件面板」走同一条路 —— 不为市场单独写一套加载逻辑。
async function loadMarketPage() {
  const box = $('#market-page');
  if (!box) return;

  try {
    // 确认插件存在且启用
    const d = await api('/api/plugins');
    const meta = (d.plugins || []).find((p) => p.id === 'plugin-market');
    if (!meta) {
      box.innerHTML = `<div class="card"><h3>创造营</h3>
        <p class="muted">找不到 plugin-market 插件。它本该随内核一起提供 ——
        如果被误删，从发布包里恢复 plugins/plugin-market/ 即可。</p></div>`;
      return;
    }
    if (meta.status !== 'enabled') {
      box.innerHTML = `<div class="card"><h3>创造营</h3>
        <p class="muted">创造营已被停用（当前状态：${esc(meta.status)}）。</p>
        <p class="muted" style="font-size:12.5px">它是核心功能，正常不该被关。
        到「插件」页把它重新启用即可。</p></div>`;
      return;
    }

    const mod = await loadPluginUi('plugin-market', meta.ui || 'ui.js');
    const mount = mod?.mountPanel || mod?.mount;
    if (typeof mount !== 'function') {
      box.innerHTML = `<div class="card"><h3>创造营</h3>
        <p class="muted">界面文件没有导出 mount / mountPanel。</p></div>`;
      return;
    }
    box.innerHTML = '';
    await mount(box, {
      ...pluginUiContext('plugin-market'),
      openPluginPanel,
      // 🔴 提供"只重挂这个面板"的能力（2026-10-25）
      //
      // 用户反馈："创作营刷新的时候能不能不刷新网页，只刷新这个窗口"
      //
      // 原来插件内部用的是 location.reload() —— 整页重载：
      //   · 会话列表、滚动位置全部丢失
      //   · 要重新请求所有接口，慢
      //   · 用户在别的页签切回来时体验很差
      //
      // 这里给一个 remount()：清空当前容器、重新 mount。
      // 效果上等价于"刷新这个窗口"，但不动整个页面。
      // 🔴 递归注入 remount（2026-10-26 修）
      //
      // 原来重挂后的新 ctx 里**没有 remount** —— 第一次点刷新能用，
      // 第二次就退化成 location.reload() 整页重载。
      // 这里让重挂后的 ctx 也带上 remount（闭包，无需命名函数）。
      remount: (function mountCycle() {
        return async () => {
          const fresh = await loadPluginUi('plugin-market', meta.ui || 'ui.js');
          const m2 = fresh?.mountPanel || fresh?.mount;
          if (typeof m2 !== 'function') return;
          box.innerHTML = '';
          const ctx2 = { ...pluginUiContext('plugin-market'), openPluginPanel };
          ctx2.remount = mountCycle();     // ← 递归注入
          await m2(box, ctx2);
        };
      })(),
    });
    box.dataset.mounted = '1';
  } catch (e) {
    box.innerHTML = `<div class="card"><h3>创造营</h3>
      <p class="muted">加载失败：${esc(String(e?.message ?? e))}</p>
      <p class="muted" style="font-size:12.5px">刷新页面重试；若持续失败，检查 /api/market/index 是否可达。</p></div>`;
  }
}

function dispatchTabLoad(name) {
  // ── 内核自带的页签 ──
  if (name === 'sessions') return loadSessions();
  if (name === 'chats') return loadChats();
  if (name === 'snowluma') return loadSnowlumaPage();
  if (name === 'settings') return loadSettings();
  if (name === 'plugins') return loadPluginsPage();
  // ── 插件市场（核心页签，2026-10-25）──
  //
  // 设计意图（用户要求「市场作为核心包功能」）：
  //   · 页签是内核内置的 → 用户关不掉，市场永远可用
  //   · 但界面代码仍在 plugins/plugin-market/ui.js → 可独立更新
  //
  // 为什么不把整套逻辑搬进内核：
  //   内核现在很精简（依赖只有 4 个），塞一个市场进去会破坏这个优点。
  //   这里是「内核给位置，插件给内容」—— 两者解耦。
  //
  // 插件被禁用时给出提示，而不是白屏。
  if (name === 'market') return loadMarketPage();
  if (name === 'skills') { loadSkillsPage().then(bindSkillsEvents); return; }

  // ── 插件页签（2026-10-21）──
  // 内核**不再认识任何具体插件**。页签内容由插件自己的 ui.js 提供，
  // 通过 mountPluginUi() 动态 import。
  // 新增/修改插件界面只动 plugins/<id>/ui.js，内核零改动。
  const root = $(`#plugin-view-${name}`);
  if (root) return mountPluginUi(name, root);
}


// ── 关于（2026-10-24）──────────────────────────────────────
//
// 放交流群信息，但**只放这一处**：
//   · 不弹窗、不自动展开、不挡住任何操作
//   · 不写进提示词，模型不知道这个群
//   · 不放进任何 Tab 首屏，用户主动点「关于」才看得到
//
// 群信息在 src/config.js 的 COMMUNITY 里，改群号只需改那一处。
/**
 * BUG 反馈 / 优化建议页（2026-10-25）
 *
 * 放在设置最下面。需要创造营登录 —— 复用作者账号，不另建体系。
 * 未登录只给提示，不给表单（避免提交后被后端拒，白填）。
 */
async function renderFeedbackSection() {
  const pane = $('#settings-form');
  if (!pane) return;
  pane.innerHTML = '<div class="muted" style="padding:16px">加载中…</div>';

  let st;
  try {
    st = await api('/api/feedback/ping');
  } catch (e) {
    pane.innerHTML = `<div class="card"><div class="error">加载失败：${esc(e.message)}</div></div>`;
    return;
  }

  // 未登录：只给引导
  if (!st?.logged) {
    pane.innerHTML = `
      <div class="card">
        <h3>BUG 反馈</h3>
        <p class="muted" style="font-size:13px;line-height:1.8">
          这个功能需要先登录创造营作者账号。<br>
          到 <b>BG创造营 → 发布 → 作者账号</b> 注册或用邮箱密码登录，回来就能提交。
        </p>
      </div>`;
    return;
  }

  const who = st.who || {};
  const env = st.env || {};
  const stats = st.stats || {};

  pane.innerHTML = `
    <div class="card">
      <h3>BUG 反馈 / 优化建议</h3>
      <p class="muted" style="font-size:13px;line-height:1.7">
        提交内核的问题报告或改进想法。可以附错误日志、也可以直接传一份 .md。
        提交时会<b>自动带上运行环境</b>（版本、Node、平台），不用你手抄。
      </p>
      <div class="muted" style="font-size:12px;margin-top:8px">
        当前登录：<b>${esc(who.nickname || who.email || '')}</b>
        · 已提交 ${esc(String(stats.total ?? 0))} 条
      </div>
    </div>

    <div class="card">
      <div class="field" style="margin-bottom:12px">
        <label class="muted" style="font-size:12.5px">类型</label>
        <select id="fb-type" style="max-width:200px">
          <option value="bug">BUG / 报错</option>
          <option value="feature">优化建议</option>
          <option value="other">其它</option>
        </select>
      </div>

      <div class="field" style="margin-bottom:12px">
        <label class="muted" style="font-size:12.5px">标题</label>
        <input id="fb-title" placeholder="一句话说清问题，如「插件覆盖更新后版本号不对」" style="width:100%" />
      </div>

      <div class="field" style="margin-bottom:12px">
        <label class="muted" style="font-size:12.5px">详细描述 / 错误日志</label>
        <textarea id="fb-body" rows="10" style="width:100%;font-family:ui-monospace,monospace;font-size:12.5px"
          placeholder="怎么复现、看到什么、期望什么。报错栈可以直接粘进来。"></textarea>
      </div>

      <div class="field" style="margin-bottom:12px">
        <label class="muted" style="font-size:12.5px">附件（可选，.md / .txt / .log，≤2MB）</label>
        <div class="row" style="gap:8px;align-items:center">
          <input type="file" id="fb-file" accept=".md,.txt,.log,.json" style="font-size:12.5px" />
          <span id="fb-file-name" class="muted" style="font-size:12px"></span>
        </div>
      </div>

      <details style="margin-bottom:12px">
        <summary class="muted" style="font-size:12.5px;cursor:pointer">会附带哪些环境信息</summary>
        <pre class="muted" style="font-size:11.5px;line-height:1.6;margin:8px 0 0;white-space:pre-wrap">${esc(JSON.stringify(env, null, 2))}</pre>
      </details>

      <div class="row" style="gap:10px;align-items:center">
        <button class="btn primary" id="fb-submit">提交反馈</button>
        <span id="fb-msg" class="muted" style="font-size:12.5px"></span>
      </div>
    </div>

    <div class="card">
      <h3>我提交过的</h3>
      <div id="fb-list" class="muted" style="font-size:13px">加载中…</div>
    </div>`;

  bindFeedbackEvents();
  loadFeedbackList();
}

/** 反馈页事件 */
function bindFeedbackEvents() {
  const msg = (s, ok) => {
    const el = $('#fb-msg');
    if (!el) return;
    el.textContent = s;
    el.style.color = ok ? 'var(--ok, #2f855a)' : 'var(--err, #b91c1c)';
  };

  let file = null;
  $('#fb-file')?.addEventListener('change', (ev) => {
    file = ev.target.files?.[0] || null;
    const n = $('#fb-file-name');
    if (n) n.textContent = file ? `${file.name}（${(file.size / 1024).toFixed(0)}KB）` : '';
  });

  $('#fb-submit')?.addEventListener('click', async () => {
    const type = $('#fb-type')?.value || 'bug';
    const title = ($('#fb-title')?.value || '').trim();
    const body = ($('#fb-body')?.value || '').trim();
    if (!title) return msg('请填标题');

    msg('提交中…', true);
    try {
      let attachBase64 = '';
      let attachName = '';
      if (file) {
        if (file.size > 2 * 1024 * 1024) return msg('附件超过 2MB');
        attachBase64 = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result || '').split(',')[1] || '');
          fr.onerror = () => reject(new Error('附件读取失败'));
          fr.readAsDataURL(file);
        });
        attachName = file.name;
      }

      const r = await api('/api/feedback/submit', {
        method: 'POST',
        body: { type, title, body, attachBase64, attachName }
      });
      if (!r.ok) return msg('失败：' + (r.error || ''));

      msg(`✅ 已提交（编号 ${r.id}）`, true);
      toast('反馈已提交，谢谢');
      // 清空表单并刷新列表
      const ti = $('#fb-title'); if (ti) ti.value = '';
      const bo = $('#fb-body'); if (bo) bo.value = '';
      const fi = $('#fb-file'); if (fi) fi.value = '';
      const fn = $('#fb-file-name'); if (fn) fn.textContent = '';
      file = null;
      loadFeedbackList();
    } catch (e) {
      msg('失败：' + e.message);
    }
  });
}

/** 拉「我提交过的」 */
async function loadFeedbackList() {
  const box = $('#fb-list');
  if (!box) return;
  try {
    const r = await api('/api/feedback/list');
    if (!r.ok) {
      box.textContent = '读取失败：' + (r.error || '');
      return;
    }
    const items = r.items || [];
    if (!items.length) {
      box.innerHTML = '<span class="muted">还没有提交过</span>';
      return;
    }
    const label = { bug: 'BUG', feature: '建议', other: '其它' };
    box.innerHTML = `
      <table class="table">
        <thead><tr><th>类型</th><th>标题</th><th>提交时间</th><th>附件</th></tr></thead>
        <tbody>${items.map((x) => `
          <tr>
            <td style="font-size:12px">${esc(label[x.type] || x.type)}</td>
            <td>${esc(x.title)}</td>
            <td class="muted" style="font-size:12px">${esc(fmtTime(x.submittedAt))}</td>
            <td class="muted" style="font-size:12px">${x.attach ? esc(x.attach.name) : '—'}</td>
          </tr>`).join('')}</tbody>
      </table>`;
  } catch (e) {
    box.textContent = '读取失败：' + e.message;
  }
}

function renderAboutSection(c) {
  const k = (c && c.community) || {};
  const qq = String(k.number || '').trim();
  const name = String(k.name || '').trim();
  const intro = String(k.intro || '').trim();
  const repo = String(k.repo || '').trim();
  const gitee = String(k.gitee || '').trim();

  return `
    <h3>关于</h3>
    <div class="hint" style="margin-bottom:14px">
      QQ Agent 是一个可扩展的群机器人框架：内核只保留收发消息与调度，
      其余能力都以插件形式装卸。
    </div>

    ${name ? `
    <div style="padding:16px 18px;border:1px solid var(--line2);border-radius:var(--r);background:var(--panel)">
      <div style="font-size:14px;font-weight:600">${esc(name)}</div>
      ${intro ? `<div class="muted" style="font-size:13px;margin-top:6px">${esc(intro)}</div>` : ''}
      ${qq ? `
      <div style="margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="muted" style="font-size:13px">群号</span>
        <code style="font-size:14px;letter-spacing:.5px">${esc(qq)}</code>
        <button class="btn tiny" id="about-copy">复制群号</button>
        <a class="btn tiny" href="${esc(k.joinUrl || '')}" target="_blank" rel="noopener">加入群聊</a>
      </div>` : ''}
      <div class="muted" style="font-size:12px;margin-top:10px">
        用这个项目遇到问题、想找现成插件、或者想分享自己写的插件，都可以进群聊。
      </div>
    </div>` : ''}

    ${(repo || gitee) ? `
    <h3 style="margin-top:24px">开源地址</h3>
    <div style="padding:14px 16px;border:1px solid var(--line2);border-radius:var(--r);background:var(--panel)">
      <div style="font-size:13px;margin-bottom:10px">
        这个项目是开源的。如果它帮到了你，去点个 Star 就是最好的支持 ⭐
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${repo ? `<a class="btn tiny" href="${esc(repo)}" target="_blank" rel="noopener">GitHub · 点 Star</a>` : ''}
        ${gitee ? `<a class="btn tiny" href="${esc(gitee)}" target="_blank" rel="noopener">Gitee · 点 Star</a>` : ''}
      </div>
      <div class="muted" style="font-size:12px;margin-top:10px;line-height:1.7">
        ${repo ? `GitHub：${esc(repo)}<br>` : ''}
        ${gitee ? `Gitee：${esc(gitee)}<br>` : ''}
        <span style="font-size:11.5px">国内访问 Gitee 更快，两边代码同步。</span>
      </div>
    </div>` : ''}

    <h3 style="margin-top:24px">内核版本</h3>
    <div id="about-kernel" style="padding:14px 16px;border:1px solid var(--line2);border-radius:var(--r);background:var(--panel)">
      <div class="row" style="gap:12px;align-items:center;flex-wrap:wrap">
        <span style="font-size:13px">当前版本</span>
        <code id="about-ver" style="font-size:14px">—</code>
        <button class="btn tiny" id="about-check">检查更新</button>
        <span id="about-update-msg" class="muted" style="font-size:12px"></span>
      </div>
      <div id="about-update-body" class="muted" style="font-size:12px;margin-top:10px;line-height:1.7"></div>
    </div>

    <div id="about-autocheck" style="margin-top:10px"></div>
    <div id="about-publish" style="margin-top:14px"></div>

    <h3 style="margin-top:24px">运行环境</h3>
    <div class="muted" style="font-size:13px;line-height:1.9">
      Node ${esc(String((c && c.node) || '').replace(/^v/, ''))}${(c && c.version) ? ` · 版本 ${esc(c.version)}` : ''}<br>
      所有时间按北京时间显示（进程已锁 TZ=Asia/Shanghai）
    </div>`;
}

// ── 外观设置面板 ────────────────────────────────────────────
function renderAppearanceSection(c) {
  const app = (c && c.appearance) || { skin: 'default', background: {} };
  const bg = app.background || {};
  const cur = app.skin || 'default';

  // 每套皮肤的小色板（用该皮肤自己的值，肉眼可辨）
  const SWATCH = {
    'default':    ['#F7F7F7', '#202020', '#000000'],
    'paper-warm': ['#FAF6EF', '#2B2620', '#8C6A3F'],
    'midnight':   ['#17181A', '#E8E9EB', '#EDEFF2'],
    'forest':     ['#F2F5F2', '#1E2A22', '#2F6B4A'],
    'sakura':     ['#FBF7F8', '#2B2427', '#8A4A5E'],
    'ocean':      ['#F3F6F9', '#1B2530', '#1F5A85']
  };

  const cards = SKINS.map((s) => {
    const sw = (SWATCH[s.id] || []).map((col) => `<i style="background:${col}"></i>`).join('');
    return `
      <div class="skin-card ${s.id === cur ? 'active' : ''}" data-skin-pick="${esc(s.id)}">
        <div class="sc-name">${esc(s.label)}</div>
        <div class="sc-desc">${esc(s.desc)}</div>
        <div class="skin-swatch">${sw}</div>
      </div>`;
  }).join('');

  const hasBg = !!(bg.dataUrl || '').startsWith('data:image/');
  const alpha = Number(bg.opacity) || 0.92;

  return `
    <h3>皮肤</h3>
    <p class="muted" style="font-size:13px;margin:4px 0 0">
      换皮肤只换配色令牌，不改任何布局。所有皮肤都通过 WCAG AA 对比度校验。
    </p>
    <div class="skin-grid">${cards}</div>

    <h3 style="margin-top:26px">自定义背景</h3>
    <p class="muted" style="font-size:13px;margin:4px 0 0">
      上传一张图做背景。下面的<b>透明度</b>控制"纸有多透"——调低能看到背景，文字始终清晰。
    </p>

    <div class="bg-preview" id="bg-preview"
         style="${hasBg ? `background-image:url('${bg.dataUrl}')` : ''}">
      ${hasBg ? '' : '未设置背景（点下方按钮上传）'}
    </div>

    <div class="row" style="gap:10px;flex-wrap:wrap;margin-top:12px">
      <input type="file" id="bg-file" accept="image/*" style="display:none" />
      <button class="btn" id="bg-upload">${hasBg ? '更换图片' : '上传图片'}</button>
      ${hasBg ? '<button class="btn" id="bg-clear">移除背景</button>' : ''}
    </div>

    <div class="row" style="gap:16px;flex-wrap:wrap;margin-top:16px;align-items:flex-end">
      <div class="field" style="min-width:220px">
        <label class="muted" style="font-size:12px">
          透明度（当前 <b id="bg-alpha-val">${Math.round(alpha * 100)}</b>%）——
          数值越小，背景越明显
        </label>
        <input type="range" id="bg-alpha" min="30" max="100" step="1"
               value="${Math.round(alpha * 100)}" style="width:100%" />
      </div>
      <div class="field" style="min-width:160px">
        <label class="muted" style="font-size:12px">背景模糊</label>
        <input type="range" id="bg-blur" min="0" max="20" step="1"
               value="${Number(bg.blur) || 0}" style="width:100%" />
      </div>
      <div class="field" style="min-width:140px">
        <label class="muted" style="font-size:12px">显示方式</label>
        <select id="bg-mode" style="width:100%">
          <option value="cover" ${bg.mode === 'cover' || !bg.mode ? 'selected' : ''}>铺满（裁剪）</option>
          <option value="contain" ${bg.mode === 'contain' ? 'selected' : ''}>完整显示</option>
          <option value="repeat" ${bg.mode === 'repeat' ? 'selected' : ''}>平铺</option>
        </select>
      </div>
    </div>
    <p class="muted" style="font-size:12px;margin-top:10px">
      图片以 dataURL 存进 <code>data/config.json</code>，上限 2MB。<br>
      背景图只存在本机，不会随插件包导出。
    </p>

    <div class="card" style="margin-top:20px">
      <h3>界面入口</h3>
      <label class="row" style="gap:8px;font-size:13px;align-items:flex-start">
        <input type="checkbox" id="hide-plugin-page" ${c?.ui?.hidePluginPage === true ? 'checked' : ''}>
        <span>
          隐藏顶栏的「插件」页
          <div class="muted" style="font-size:12px;margin-top:4px;line-height:1.7">
            装上「插件中心」之后，它和内置「插件」页功能重复，
            而插件中心还多了分组折叠、黑名单、救援列表、批量开关。<br>
            勾上后顶栏少一个入口，插件管理全部由插件中心承接。<br>
            <b>没装插件中心时这项会被自动忽略</b>，不会让你失去入口。
          </div>
        </span>
      </label>
    </div>`;
}

/** 外观面板的事件绑定（由 bindSettingsEvents 调用） */
function bindAppearanceEvents() {
  if (state.settingsSection !== 'appearance') return;

  $$('[data-skin-pick]').forEach((el) => el.addEventListener('click', async () => {
    try {
      await saveAppearance({ skin: el.dataset.skinPick });
      $$('[data-skin-pick]').forEach((x) => x.classList.remove('active'));
      el.classList.add('active');
      toast('已切换皮肤');
    } catch (e) { toast('切换失败：' + e.message); }
  }));

  const file = $('#bg-file');
  $('#bg-upload')?.addEventListener('click', () => file?.click());

  file?.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const dataUrl = await readImageAsDataUrl(f);
      await saveAppearance({ background: { dataUrl } });
      toast('背景已设置');
      renderSettings();
    } catch (e) { toast('设置失败：' + e.message); }
  });

  $('#bg-clear')?.addEventListener('click', async () => {
    try {
      await saveAppearance({ background: { dataUrl: '' } });
      toast('背景已移除');
      renderSettings();
    } catch (e) { toast('移除失败：' + e.message); }
  });

  // 透明度 / 模糊：拖动即时预览，松手才保存
  const alphaEl = $('#bg-alpha');
  alphaEl?.addEventListener('input', () => {
    const v = Number(alphaEl.value) / 100;
    document.documentElement.style.setProperty('--user-panel-alpha', String(v));
    const lab = $('#bg-alpha-val');
    if (lab) lab.textContent = String(Math.round(v * 100));
  });
  alphaEl?.addEventListener('change', async () => {
    try { await saveAppearance({ background: { opacity: Number(alphaEl.value) / 100 } }); }
    catch (e) { toast('保存失败：' + e.message); }
  });

  const blurEl = $('#bg-blur');
  blurEl?.addEventListener('input', () => {
    document.documentElement.style.setProperty('--user-bg-blur', `${Number(blurEl.value)}px`);
  });
  blurEl?.addEventListener('change', async () => {
    try { await saveAppearance({ background: { blur: Number(blurEl.value) } }); }
    catch (e) { toast('保存失败：' + e.message); }
  });

  $('#bg-mode')?.addEventListener('change', async (ev) => {
    try { await saveAppearance({ background: { mode: ev.target.value } }); }
    catch (e) { toast('保存失败：' + e.message); }
  });

  // 隐藏内置「插件」页（2026-10-25）
  $('#hide-plugin-page')?.addEventListener('change', async (ev) => {
    const on = ev.target.checked;
    try {
      await api('/api/config', { method: 'POST', body: { ui: { hidePluginPage: on } } });
      state.config = { ...(state.config || {}), ui: { ...(state.config?.ui || {}), hidePluginPage: on } };
      toast(on ? '已隐藏，正在刷新…' : '已恢复，正在刷新…');
      // 需要重载页面才生效（页签是启动时渲染的）
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      ev.target.checked = !on;
      toast('保存失败：' + e.message);
    }
  });
}


function renderSettingsSidebar() {
  const s = state.status;
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;
  const menu = [
    ['api', '模型 API'],
    ['persona', '人设'],
    ['allow', '聊天白名单'],
    ['chat', '聊天设置'],
    ['appearance', '外观'],
    ['desktop', '桌面端'],
    ['onebot', 'OneBot 连接'],
    ['about', '关于'],
    ['feedback', 'BUG 反馈']
  ];
  sidebar.innerHTML = `
    <div class="settings-runstate">
      <div class="rs-title">机器人运行状态</div>
      <div class="rs-row"><span class="dot ${(s?.onebot?.account?.online === false) ? 'dot-off' : (s?.onebot?.connected ? 'dot-on' : 'dot-off')}"></span><span>${(s?.onebot?.account?.online === false) ? '⚠ 账号已离线' : (s?.onebot?.connected ? '运行中' : '未就绪')}</span></div>
      <div class="rs-row muted">${state.paused ? '⏸ 已暂停' : (s?.orchestrator?.model ? `模型：${s.orchestrator.model}` : '模型：未设置')}</div>
    </div>
    <div class="settings-menu">
      ${menu.map(([id, label]) => `<button class="settings-menu-item ${state.settingsSection === id ? 'active' : ''}" data-section="${id}">${label}</button>`).join('')}
    </div>`;
  sidebar.querySelectorAll('.settings-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      state.settingsSection = el.dataset.section;
      renderSettingsSidebar();
      renderSettings();
    });
  });
}

function renderSettings() {
  const c = state.config;
  const box = $('#settings-form');
  renderSettingsSidebar();
  box.innerHTML = `
    ${renderSettingsSection(c)}`;
  bindSettingsEvents(c);

  // 「BUG 反馈」也自带异步渲染（要先查创造营登录态）
  if ((state.settingsSection || 'api') === 'feedback') {
    renderFeedbackSection();
  }

  // 「关于」区需要 /api/about 的数据（群信息、Node 版本），
  // 是异步的，所以先渲染空壳再补内容 —— 不阻塞其它设置项。
  if ((state.settingsSection || 'api') === 'about') {
    api('/api/about').then((d) => {
      const pane = $('#settings-form');
      if (!pane || (state.settingsSection || 'api') !== 'about') return;
      pane.innerHTML = renderAboutSection(d);
      $('#about-copy')?.addEventListener('click', async () => {
        const qq = String(d?.community?.number || '');
        if (!qq) return;
        try {
          await navigator.clipboard.writeText(qq);
          toast('群号已复制');
        } catch {
          toast('复制失败，请手动选中');
        }
      });

      // ── 内核版本 / 检查更新（2026-10-25）──
      const verEl = $('#about-ver');
      const msgEl = $('#about-update-msg');
      const bodyEl = $('#about-update-body');
      const setMsg = (s) => { if (msgEl) msgEl.textContent = s; };
      const setBody = (h) => { if (bodyEl) bodyEl.innerHTML = h; };

      api('/api/kernel/version').then((v) => {
        if (verEl) verEl.textContent = v?.version || '未知';
      }).catch(() => { if (verEl) verEl.textContent = '未知'; });

      $('#about-check')?.addEventListener('click', async () => {
        setMsg('检查中…'); setBody('');
        try {
          const r = await api('/api/kernel/check');
          if (!r.ok) { setMsg('检查失败：' + (r.error || '未知')); return; }
          if (!r.hasUpdate) { setMsg(`已是最新（${r.current}）`); return; }
          const rel = r.release || {};
          setMsg(`有新版本 ${rel.version}（当前 ${r.current}）`);
          setBody(`
            <div style="margin-bottom:8px">${esc(String(rel.notes || '').slice(0, 600)).replace(/\n/g, '<br>')}</div>
            <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              <button class="btn primary tiny" id="about-autoinstall">下载并自动安装</button>
              <button class="btn tiny" id="about-dl">只下载</button>
              <span class="muted" style="font-size:11.5px">自动安装会重启服务（约 30~90 秒），失败自动回滚</span>
            </div>
            <div id="about-installer-note" class="muted" style="font-size:11.5px;margin-top:6px"></div>`);

          // 提示安装脚本是否太旧（太旧会导致更新失败/502）
          api('/api/kernel/installer-check').then((r) => {
            const el = $('#about-installer-note');
            if (!el) return;
            if (r?.outdated) {
              el.innerHTML = `<span style="color:#b45309">⚠ 本机安装脚本是旧版（${esc(r.current || '无标记')}，需要 ${esc(r.required || '?')}）。`
                + `本次安装会自动使用新包里的脚本，不影响；但装完会自动更新。</span>`;
            } else {
              el.innerHTML = `<span style="color:#2f855a">✓ 安装脚本已是最新（${esc(r?.current || '?')}）</span>`;
            }
          }).catch(() => {});

          // 一键：下载 → 安装 → 轮询日志
          $('#about-autoinstall')?.addEventListener('click', async () => {
            if (!confirm('将自动安装并重启服务（约 30~90 秒不可用）。\n\n流程：备份 → 替换 → 重启 → 健康探测 → 失败自动回滚。\n继续？')) return;
            setMsg('下载中…');
            setBody('');
            try {
              const d2 = await api('/api/kernel/download', { method: 'POST' });
              if (!d2.ok) { setMsg('下载失败：' + (d2.error || '未知')); return; }
              if (d2.upToDate) { setMsg('已是最新'); return; }

              setMsg('安装中，服务即将重启…');
              const inst = await api('/api/kernel/install', { method: 'POST', body: {} });
              if (!inst.ok) { setMsg('安装未启动：' + (inst.error || '未知')); return; }

              // 轮询日志
              let last = '';
              const timer = setInterval(async () => {
                try {
                  const r = await api('/api/kernel/install-log');
                  const lines = String(r.log || '').trim().split('\n').slice(-6);
                  const tail = lines.join('\n');
                  if (tail !== last) {
                    last = tail;
                    setBody(`<pre style="font-size:11.5px;line-height:1.6;white-space:pre-wrap;margin:0">${esc(tail)}</pre>`);
                  }
                  if (/安装成功/.test(r.log)) {
                    clearInterval(timer);
                    setMsg('✅ 安装成功，正在刷新…');
                    setTimeout(() => location.reload(), 1500);
                  } else if (/安装失败/.test(r.log)) {
                    clearInterval(timer);
                    setMsg('❌ 安装失败，已自动回滚，请查看日志');
                  }
                } catch { /* 服务重启中，接口暂时不可用，继续轮询 */ }
              }, 3000);

              // 90 秒后停止轮询
              setTimeout(() => clearInterval(timer), 90000);
            } catch (e) { setMsg('失败：' + e.message); }
          });
          $('#about-dl')?.addEventListener('click', async () => {
            setMsg('下载中…');
            try {
              const d2 = await api('/api/kernel/download', { method: 'POST' });
              if (!d2.ok) { setMsg('下载失败：' + (d2.error || '未知')); return; }
              if (d2.upToDate) { setMsg('已是最新'); return; }
              setMsg(`已下载 v${d2.version}（${(d2.bytes / 1024 / 1024).toFixed(1)}MB，校验${d2.verified ? '通过' : '跳过'}）`);
              setBody(`
                <div style="margin-bottom:6px">安装包：<code>${esc(d2.file)}</code></div>
                <div style="margin-bottom:6px"><b>不会自动覆盖现有内核</b>，确认后按下面步骤手动装：</div>
                <ol style="margin:6px 0 0 18px;line-height:1.8">
                  ${(d2.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}
                </ol>`);
              toast('更新包已下载');
            } catch (e) { setMsg('下载失败：' + e.message); }
          });
        } catch (e) { setMsg('检查失败：' + e.message); }
      });

      // ── 自动检查开关（2026-10-25）──
      //
      // 只做「查 + 提示 + 可选下载」，永远不自动安装。
      (async () => {
        const box = $('#about-autocheck');
        if (!box) return;
        let cfgNow = {};
        try { cfgNow = (await api('/api/config'))?.kernelUpdate || {}; } catch { /* ignore */ }
        const onCheck = cfgNow.autoCheck !== false;
        const onDl = cfgNow.autoDownload === true;
        const onInst = cfgNow.autoInstall === true;
        const installDelay = Number(cfgNow.installDelayMinutes) || 5;
        const lastAt = cfgNow.lastCheckAt ? fmtTime(cfgNow.lastCheckAt) : '尚未检查';

        box.innerHTML = `
          <div style="padding:14px 16px;border:1px solid var(--line2);border-radius:var(--r);background:var(--panel)">
            <div style="font-size:13px;font-weight:600;margin-bottom:8px">自动检查</div>
            <label class="row" style="gap:6px;font-size:13px">
              <input type="checkbox" id="kc-auto" ${onCheck ? 'checked' : ''}>
              定期检查新版本（发现后在这里提示）
            </label>
            <label class="row" style="gap:6px;font-size:13px;margin-top:6px">
              <input type="checkbox" id="kc-dl" ${onDl ? 'checked' : ''}>
              发现新版后自动下载并校验（不会安装）
            </label>
            <label class="row" style="gap:6px;font-size:13px;margin-top:6px">
              <input type="checkbox" id="kc-inst" ${onInst ? 'checked' : ''}>
              <b>自动安装</b>（下载后自动装，<b>会重启服务一次</b>）
            </label>
            <div id="kc-inst-hint" class="muted" style="font-size:12px;margin-top:6px;padding-left:22px;${onInst ? '' : 'display:none'}">
              安装前等待 <input id="kc-delay" type="number" min="1" max="120" value="${installDelay}" style="width:56px;font-size:12px;padding:1px 4px"> 分钟
              （留出取消时间）。流程：备份 → 语法自检 → 替换 → 重启 → 健康探测，
              <b>失败自动回滚</b>。期间服务会断 30~90 秒。
            </div>
            <div class="muted" style="font-size:12px;margin-top:8px">
              上次检查：${esc(lastAt)} · 每 ${esc(String(cfgNow.checkIntervalHours || 24))} 小时一次
            </div>
            <div class="muted" style="font-size:12px;margin-top:4px">
              不开启自动安装时，替换内核永远需要你手动确认。
              开启后每次都会先备份，装坏了自动回滚到备份。
            </div>
          </div>`;

        // 🔴 只传**变更的键**，不要把整个 cfgNow 回写（2026-10-25 修）
        //
        // 原来的写法 body: { kernelUpdate: { ...cfgNow, ...patch } } 有隐患：
        // cfgNow 是打开页面那一刻的快照，里面还带着 lastSeenVersion /
        // lastInstallAt 这类会变动的字段。用户在别的开关上点一下，
        // 就会把这份**过期快照**整体写回，覆盖掉后台刚更新的值。
        // 深合并只补不改，这里传最小差异集最安全。
        const save = async (patch) => {
          try {
            await api('/api/config', { method: 'POST', body: { kernelUpdate: patch } });
            cfgNow = { ...cfgNow, ...patch };
            toast('已保存');
          } catch (e) { toast('保存失败：' + e.message); }
        };
        box.querySelector('#kc-auto')?.addEventListener('change', (ev) => save({ autoCheck: ev.target.checked }));
        box.querySelector('#kc-dl')?.addEventListener('change', (ev) => save({ autoDownload: ev.target.checked }));

        box.querySelector('#kc-inst')?.addEventListener('change', (ev) => {
          const on = ev.target.checked;
          const hint = box.querySelector('#kc-inst-hint');
          if (hint) hint.style.display = on ? '' : 'none';
          if (on && !confirm('开启自动安装后，每次发现新版本会在延时后自动替换内核并重启服务。\n\n失败会自动回滚，但期间服务会中断 30~90 秒。\n\n确定开启？')) {
            ev.target.checked = false;
            if (hint) hint.style.display = 'none';
            return;
          }
          save({ autoInstall: on });
        });

        box.querySelector('#kc-delay')?.addEventListener('change', (ev) => {
          const n = Math.max(1, Math.min(120, Number(ev.target.value) || 5));
          ev.target.value = n;
          save({ installDelayMinutes: n });
        });
      })();

      // ── 作者发布区（2026-10-25）──
      //
      // 仅作者可见。复用创造营的作者账号（author.json），不另建一套认证。
      (async () => {
        const box = $('#about-publish');
        if (!box) return;
        let st;
        try { st = await api('/api/kernel/can-publish'); } catch { return; }
        if (!st?.ok) return;

        // 未注册作者：不显示发布区（避免普通用户困惑）
        if (!st.author?.verified) {
          box.innerHTML = `
            <div class="muted" style="font-size:12px;padding:10px 12px;border:1px dashed var(--line2);border-radius:var(--r)">
              想发布自己的内核改版？先到「创造营」注册作者账号。
            </div>`;
          return;
        }

        const who = st.author.nickname || st.author.email || '作者';
        box.innerHTML = `
          <div style="padding:14px 16px;border:1px solid var(--acc);border-radius:var(--r);background:var(--panel)">
            <div style="font-size:13px;font-weight:600;margin-bottom:8px">发布内核新版本</div>
            <div class="muted" style="font-size:12px;margin-bottom:10px">
              当前作者：<b>${esc(who)}</b>
              ${st.hasCredentials ? '' : ' · ⚠ 本机没有发布凭据（R2），只能打包不能上传'}
            </div>
            <div class="field" style="margin-bottom:10px">
              <label class="muted" style="font-size:12px">更新说明（会显示在别人的更新提示里）</label>
              <textarea id="kp-notes" rows="3" style="width:100%;font-size:12.5px"
                placeholder="这次改了什么？一两句话说清即可"></textarea>
            </div>
            <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
              <button class="btn tiny" id="kp-dry">先看包大小</button>
              <button class="btn primary tiny" id="kp-pub" ${st.hasCredentials ? '' : 'disabled'}>打包并发布</button>
              <span id="kp-msg" class="muted" style="font-size:12px"></span>
            </div>
            <div class="muted" style="font-size:12px;margin-top:8px">
              发布 = 把当前内核打成 tar.gz → 上传市场 → 更新版本清单。
              别人在「检查更新」里就会看到这个版本。
            </div>
          </div>`;

        const msg = (s) => { const el = box.querySelector('#kp-msg'); if (el) el.textContent = s; };
        const notes = () => box.querySelector('#kp-notes')?.value || '';

        box.querySelector('#kp-dry')?.addEventListener('click', async () => {
          msg('打包中…');
          try {
            const r = await api('/api/kernel/publish', { method: 'POST', body: { dryRun: true } });
            if (!r.ok) return msg('失败：' + (r.error || '未知'));
            msg(`版本 ${r.version} · ${(r.bytes / 1024 / 1024).toFixed(2)}MB · ${r.filename}`);
          } catch (e) { msg('失败：' + e.message); }
        });

        box.querySelector('#kp-pub')?.addEventListener('click', async () => {
          if (!confirm('确定发布？这会更新市场里的内核版本清单。')) return;
          msg('打包并上传中，请稍候…');
          try {
            const r = await api('/api/kernel/publish', { method: 'POST', body: { notes: notes() } });
            if (!r.ok) return msg('发布失败：' + (r.error || '未知'));
            msg(`✅ 已发布 v${r.version}（${(r.bytes / 1024 / 1024).toFixed(2)}MB，清单共 ${r.releases} 个版本）`);
            toast('内核已发布');
          } catch (e) { msg('发布失败：' + e.message); }
        });
      })();

    }).catch(() => { /* 取不到就保持空壳，不影响其它设置 */ });
  }
}

function renderSettingsSection(c) {
  const sec = state.settingsSection || 'api';
  const sections = {
    api: () => renderApiSection(c),
    persona: () => renderPersonaSection(c),
    groupmgr: () => renderGroupMgrSection(c),
    allow: () => renderAllowSection(c),
    chat: () => renderChatSection(c),
    desktop: () => renderDesktopSection(c),
    onebot: () => renderOnebotSection(c),
    appearance: () => renderAppearanceSection(c),
    about: () => renderAboutSection(c),
    // BUG 反馈页自带异步渲染（要查登录态），这里给空壳，实际内容由
    // renderFeedbackSection() 在设置渲染后填充
    feedback: () => '<div class="card" id="fb-shell"><div class="muted" style="padding:16px">加载中…</div></div>'
  };
  const render = sections[sec] || sections.api;
  const saveBar = `
    <div class="save-bar">
      <button class="btn btn-primary" id="save-cfg-btn">保存设置</button>
      <span id="cfg-save-result" class="muted"></span>
    </div>`;
  // BUG 反馈不是配置项，是自己带提交按钮的表单，不该出现「保存设置」
  const noSaveBar = sec === 'feedback';
  return `
    ${noSaveBar ? '' : saveBar}
    ${render()}`;
}

function renderApiSection(c) {
  const currentProvider = (state.providers || []).find((p) => p.id === c.api.provider);
  const currentModelDisplay = (currentProvider?.modelNames || {})[c.api.model] || c.api.model;
  return `
    <h3 id="settings-api">模型 API</h3>
    <div class="field"><label>模型目录（点击选择）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-model-pick" readonly placeholder="点击选择模型" value="${esc(currentModelDisplay || '')}" style="flex:1;cursor:pointer" />
        <button class="btn btn-small" id="test-provider-btn">测试连通性</button>
        <span id="provider-test-result" class="muted" style="align-self:center"></span>
      </div>
      <div class="hint" id="provider-hint">${currentProvider ? `当前：${esc(currentProvider.displayName)} · ${esc(c.api.model || '未选模型')} @ ${esc(currentProvider.baseURL)}` : '尚未选择模型'}</div>
      <input type="hidden" id="cfg-provider" value="${esc(c.api.provider || '')}" />
      <input type="hidden" id="cfg-model" value="${esc(c.api.model || '')}" />
    </div>
    <div class="field-row">
      <div class="field"><label>当前 Base URL</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-baseurl" value="${esc(c.api.baseUrl)}" placeholder="https://api.example.com/v1（可手动编辑）" style="flex:1" />
          <button class="btn btn-small" id="fetch-current-models-btn">获取列表</button>
        </div></div>
      <div class="field"><label>当前 API Key</label>
        <div class="row" style="gap:8px">
          <input type="password" id="cfg-apikey" value="${esc(c.api.apiKey)}" style="flex:1" autocomplete="off" />
          <button type="button" class="btn btn-small" id="toggle-apikey" title="显示/隐藏">显示</button>
        </div>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>温度</label><input type="number" id="cfg-temperature" step="0.1" min="0" max="2" value="${esc(c.api.temperature)}" /></div>
      <div class="field"><label>单次运行最大工具轮数</label><input type="number" id="cfg-maxrounds" min="1" max="40" value="${esc(c.api.maxRounds)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-vision" ${c.api.vision !== false ? 'checked' : ''} />
      <label for="cfg-vision">图片输入（关闭则移除看图工具，模型只会看到 [图片] 占位符）</label>
      <span id="vision-switch-hint" class="muted" style="font-size:12px;align-self:center"></span></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-websearch" ${c.webSearch?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-websearch">联网搜索：启用 web_search / web_fetch 工具</label></div>
    <div class="field"><label>搜索引擎</label>
      <select id="cfg-searchprovider">
        <option value="auto" ${(c.webSearch?.provider || 'auto') === 'auto' ? 'selected' : ''}>自动（优先 AnySearch，失败回退 Bing）— 推荐</option>
        <option value="anysearch" ${c.webSearch?.provider === 'anysearch' ? 'selected' : ''}>AnySearch（需配置 API key，结果更全）</option>
        <option value="bing" ${c.webSearch?.provider === 'bing' ? 'selected' : ''}>Bing 网页抓取（免 key）</option>
      </select>
      <div class="hint" style="margin-top:4px">未配置 key 时，自动模式会回退到 Bing 网页抓取。</div></div>
    <div class="field"><label>AnySearch API Key</label>
      <div id="search-key-rows"></div>
      <div style="display:flex;gap:8px;margin-top:6px;align-items:center">
        <button class="btn btn-small" type="button" id="add-search-key-btn">+ 添加一个 Key</button>
        <button class="btn btn-small btn-primary" type="button" id="save-search-keys-btn">保存 Key</button>
        <span id="search-key-result" class="muted"></span>
      </div>
      <div class="hint" style="margin-top:4px">支持多个 Key 轮换（某个额度用尽时自动换下一个）。已保存的 Key 只显示首尾，重新填写才会覆盖；环境变量注入的 Key 优先且不在此显示。</div></div>
    <div class="field"><label>搜索地址（高级：可替换为兼容 Bing 结果格式的引擎）</label><input type="text" id="cfg-searchurl" value="${esc(c.webSearch?.searchUrl || 'https://cn.bing.com/search')}" /></div>

    <div class="settings-divider"></div>

    <h3>手动添加提供商</h3>
    <div class="field"><label>Base URL（可填写）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="new-baseurl" placeholder="例如 http://127.0.0.1:8787/v1 或 https://api.example.com/v1" style="flex:1" />
        <button class="btn btn-small" id="fetch-models-btn">获取列表</button>
      </div></div>
    <div class="field"><label>API Key</label><input type="text" id="new-apikey" placeholder="sk-..." /></div>
    <div class="field"><label>模型 id（两列：左侧模型 ID，右侧模型目录中显示的名字；可添加多行）</label>
      <div id="model-rows"></div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-small" id="add-model-row-btn">＋ 添加一行</button>
      </div>
      <div class="hint">「获取列表」会从上面的 Base URL 拉取模型，并在弹窗里勾选加入列表。</div></div>
    <div class="field-row">
      <div class="field"><button class="btn btn-primary" id="confirm-add-provider-btn">确认添加</button></div>
      <div class="field"><button class="btn btn-danger" id="delete-model-btn">删除模型…</button></div>
    </div>
    <div class="hint" id="provider-action-hint"></div>`;
}

function renderPersonaSection(c) {
  return `
    <h3>人设</h3>
    ${renderPersonaPicker(c)}
    <div class="field-row">
      <div class="field"><label>机器人名字</label><input type="text" id="cfg-botname" value="${esc(c.persona.botName)}" /></div>
      <div class="field"><label>群内展示名（可选）</label><input type="text" id="cfg-selfnick" value="${esc(c.persona.selfNickname || '')}" /></div>
      <div class="field"><label>参与度</label>
        <select id="cfg-participation">
          <option value="low" ${c.persona.participation === 'low' ? 'selected' : ''}>安静型</option>
          <option value="medium" ${c.persona.participation === 'medium' ? 'selected' : ''}>普通群友</option>
          <option value="high" ${c.persona.participation === 'high' ? 'selected' : ''}>活跃型</option>
        </select></div>
    </div>
    <div id="persona-backup-bar" style="display:flex;gap:8px;align-items:center;min-height:20px"></div>
    <div class="field"><label>角色设定（每轮注入，群友不可修改）</label>
      <div class="hint" style="margin-bottom:6px">选模板不会直接覆盖：会先问「覆盖还是追加」，覆盖前自动备份、可一键还原。</div>
      <textarea id="cfg-roletext" class="persona-role-text" placeholder="例如：你是运维群里的老油条……">${esc(c.persona.roleText || '')}</textarea></div>
    <div class="field"><label>管理员附加规则（可选，追加到系统提示）</label>
      <textarea id="cfg-customrules" class="persona-role-text" style="min-height:100px">${esc(c.persona.customRules || '')}</textarea></div>
    ${renderPersonaSaveBar()}`;
}



// ── AnySearch Key 管理 ──────────────────────────────
function renderSearchKeyRows() {
  const box = $('#search-key-rows');
  if (!box) return;
  const sk = state.searchKeys || {};
  const masked = sk.configKeys || [];
  const envCount = sk.envCount || 0;
  const rows = [];
  if (envCount > 0) {
    rows.push('<div class="muted" style="font-size:12px;margin-bottom:6px">检测到 ' + envCount + ' 个环境变量注入的 Key（优先使用，不在此显示）</div>');
  }
  const n = Math.max(masked.length, 1);
  for (let i = 0; i < n; i++) {
    const v = masked[i] || '';
    rows.push('<div style="display:flex;gap:8px;margin-bottom:6px;align-items:center">' +
      '<input type="text" class="search-key-input" data-idx="' + i + '" placeholder="粘贴 AnySearch API Key" value="' + esc(v) + '" style="flex:1" />' +
      '<button class="btn btn-small" type="button" data-del-key="' + i + '" title="删除这一项">✕</button>' +
      '</div>');
  }
  box.innerHTML = rows.join('');
  box.querySelectorAll('[data-del-key]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.delKey);
      const inputs = [...box.querySelectorAll('.search-key-input')];
      if (inputs[idx]) inputs[idx].value = '';
      el.closest('div').style.opacity = '.4';
      el.disabled = true;
    });
  });
}

async function loadSearchKeys() {
  try {
    state.searchKeys = await api('/api/search-keys');
    renderSearchKeyRows();
  } catch (e) { /* 忽略 */ }
}

async function saveSearchKeys() {
  const box = $('#search-key-rows');
  const out = $('#search-key-result');
  if (!box) return;
  const inputs = [...box.querySelectorAll('.search-key-input')];
  const keys = inputs.map((el) => el.value.trim()).filter(Boolean);
  // 只提交新填的（含 **** 的是遮影值，不提交）
  try {
    const r = await fetch('/api/search-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys })
    });
    const j = await r.json();
    if (j.ok) {
      if (out) out.textContent = '已保存 ' + j.saved + ' 个 Key';
      await loadSearchKeys();
    } else if (out) out.textContent = '保存失败：' + (j.error || '');
  } catch (e) {
    if (out) out.textContent = '保存失败：' + e.message;
  }
}

// 群管理：迎新引导 + 自动同意申请
function renderGroupMgrSection(c) {
  const g = c.groupManager || {};
  const on = (v, dflt) => (v === undefined ? dflt : v !== false);
  const sw = (id, label, checked, hint) => `
    <label class="switch-row" for="${id}">
      <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} />
      <span class="switch-text"><strong>${label}</strong>${hint ? `<span class="muted">${hint}</span>` : ''}</span>
    </label>`;
  return `
    <h3 id="settings-groupmgr">群管理</h3>
    <div class="hint" style="margin-bottom:12px">只对<b>聊天白名单里的群</b>生效；机器人不参与的群收不到事件。</div>
    <div class="switch-group">
      <div class="switch-group-title">自动行为</div>
      ${sw('cfg-gm-welcome', '新人入群自动引导', on(g.welcomeEnabled, true), '发欢迎语 + 群规（@ 新人）')}
      ${sw('cfg-gm-friend', '自动同意好友申请', on(g.autoApproveFriend, false), '收到加好友申请时自动通过')}
      ${sw('cfg-gm-group', '自动同意入群申请', on(g.autoApproveGroup, false), '收到入群申请时自动通过')}
    </div>
    <div class="field"><label>迎新语模板</label>
      <textarea id="cfg-gm-welcome-tpl" rows="7" placeholder="留空则不发送">${esc(g.welcomeTemplate || '')}</textarea>
      <div class="muted" style="font-size:12px;margin-top:4px">
        可用变量：<code>{at}</code> 会 @ 新人、<code>{nickname}</code> 昵称、<code>{groupId}</code> 群号、<code>{userId}</code> QQ 号
      </div></div>
    <div class="field"><label>机器人自己被拉进群时的引导语</label>
      <textarea id="cfg-gm-selfjoin-tpl" rows="4" placeholder="留空则不发送">${esc(g.selfJoinTemplate || '')}</textarea></div>
    <div class="field-row">
      <div class="field"><label>入群附言关键词（逗号分隔，留空=不校验）</label>
        <input type="text" id="cfg-gm-keywords" value="${esc((g.requiredKeywords || []).join(','))}" placeholder="如：答案,入群暗号" /></div>
      <div class="field"><label>黑名单 QQ（逗号分隔，一律拒绝）</label>
        <input type="text" id="cfg-gm-deny" value="${esc((g.denyUsers || []).join(','))}" placeholder="如：123456" /></div>
    </div>
    <div class="field"><label>最近处理记录</label>
      <div id="gm-recent" class="muted" style="font-size:12.5px;max-height:180px;overflow:auto">加载中…</div></div>`;
}

function renderAllowSection(c) {
  const masterQQ = String(c.persona?.masterQQ || '');
  return `
    <h3 id="settings-allow">主人</h3>
    <div class="hint" style="margin-bottom:10px">
      主人拥有最高权限：可以命令机器人主动调用任意插件能力，也可以让机器人
      修改内核与插件的配置参数。群友触发时这些工具不会挂载。
    </div>
    <div class="field-row">
      <div class="field">
        <label>主人 QQ（逗号分隔可填多个）</label>
        <input type="text" id="cfg-masterqq" value="${esc(masterQQ)}" placeholder="例如 100012345" />
        <div class="hint">改这里会同时影响：主人专属工具、白名单私聊放行、被动唤醒对象。</div>
      </div>
    </div>

    <h3 id="settings-allow" style="margin-top:26px">聊天白名单</h3>
    <div class="hint" style="margin-bottom:10px">白名单为空时机器人不会在任何群聊/私聊内运行。</div>
    <div class="field"><label>从 QQ 账号直接勾选（不用查群号）</label>
      <div style="display:flex;gap:8px">
        <button class="btn btn-small" id="pick-groups-btn">选择群</button>
        <button class="btn btn-small" id="pick-friends-btn">选择好友</button>
        <span id="pick-result" class="muted" style="align-self:center"></span>
      </div></div>
    <div class="field-row">
      <div class="field"><label>允许的群号（逗号分隔）</label><input type="text" id="cfg-allowgroups" value="${esc((c.allow.groups || []).join(','))}" /></div>
      <div class="field"><label>允许的 QQ（逗号分隔）</label><input type="text" id="cfg-allowprivate" value="${esc((c.allow.private || []).join(','))}" /></div>
    </div>`;
}

function renderChatSection(c) {
  return `
    <h3>运行节奏</h3>
    <div class="field-row">
      <div class="field"><label>防抖聚批窗口（毫秒）—— 等连发消息聚成一批再开运行</label><input type="number" id="cfg-wakedelay" min="0" value="${esc(c.wakeDelayMs)}" /></div>
      <div class="field"><label>批次间隔（毫秒）—— 上轮结束到下轮处理的间隔</label><input type="number" id="cfg-draindelay" min="0" value="${esc(c.drainDelayMs)}" /></div>
      <div class="field"><label>同时处理几个会话</label><input type="number" id="cfg-maxruns" min="1" max="8" value="${esc(c.maxConcurrentRuns)}" /></div>
    </div>

    <h3>发送保护</h3>
    <div class="field-row">
      <div class="field"><label>相邻消息最小间隔（毫秒）</label><input type="number" id="cfg-mingap" min="200" value="${esc(c.send.minGapMs)}" /></div>
      <div class="field"><label>最大间隔（毫秒）</label><input type="number" id="cfg-maxgap" min="500" value="${esc(c.send.maxGapMs)}" /></div>
      <div class="field"><label>每分钟最多发送</label><input type="number" id="cfg-maxpermin" min="1" value="${esc(c.send.maxPerMinute)}" /></div>
    </div>

    <h3>主动开话题</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-proactive" ${c.proactive.enabled ? 'checked' : ''} />
      <label for="cfg-proactive">冷场时按概率主动开话题</label></div>
    <div class="field-row">
      <div class="field"><label>检查间隔下限（毫秒）</label><input type="number" id="cfg-pro-min" min="60000" value="${esc(c.proactive.checkIntervalMinMs)}" /></div>
      <div class="field"><label>检查间隔上限（毫秒）</label><input type="number" id="cfg-pro-max" min="120000" value="${esc(c.proactive.checkIntervalMaxMs)}" /></div>
      <div class="field"><label>触发概率 0~1</label><input type="number" id="cfg-pro-prob" step="0.05" min="0" max="1" value="${esc(c.proactive.probability)}" /></div>
    </div>

    <h3>表情包</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-sticker" ${c.sticker.enabled ? 'checked' : ''} />
      <label for="cfg-sticker">启用表情包（收藏表情同步 + 发送工具）</label></div>

    <h3>会话与访问</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-feat-allowgroupmembers" ${c.privateAllowGroupMembers !== false ? 'checked' : ''} />
      <label for="cfg-feat-allowgroupmembers">功能群成员可私聊（白名单群里的成员私聊机器人也会回复）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-feat-proactive-private" ${c.features?.proactivePrivate !== false ? 'checked' : ''} />
      <label for="cfg-feat-proactive-private">私聊主动开话题（机器人主动找人聊天，需要能主动发起会话的通道）</label></div>

    <h3>发给模型的聊天记录</h3>
    <div class="field-row">
      <div class="field"><label>最多条数</label>
        <input type="number" id="cfg-pastlimit" min="10" max="500" value="${esc(c.store?.pastStateLimit ?? 80)}" />
        <div class="hint">每次运行提示词里"过去状态"最多携带的历史消息条数。</div></div>
      <div class="field"><label>字符预算</label>
        <input type="number" id="cfg-pastchars" min="1000" max="60000" step="500" value="${esc(c.store?.pastStateMaxChars ?? 6000)}" />
        <div class="hint">聊天记录的总字符上限，超出时从最旧的开始丢弃。保存后下次运行立即生效。</div></div>
    </div>`;
}

function renderDesktopSection(c) {
  return `
    <h3>桌面端</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-autostart" ${c.server?.autoStart ? 'checked' : ''} />
      <label for="cfg-autostart">开机自启（登录 Windows 后自动运行）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-closetray" ${c.server?.closeToTray !== false ? 'checked' : ''} />
      <label for="cfg-closetray">点关闭时最小化到托盘（机器人常驻，从托盘真正退出）</label></div>`;
}

function renderOnebotSection(c) {
  return `
    <h3 id="settings-onebot">OneBot 连接</h3>
    <div class="hint" style="margin-bottom:10px">网关的启动、关闭与日志在顶部「登录」页签。此处只保留连接配置。</div>
    <div class="field"><label>网关程序目录（用 SnowLuma 时填；NapCat 部署留空即可）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-snowlumadir" value="${esc(c.snowluma.dir || '')}" style="flex:1" />
        <button class="btn btn-small" id="open-snowluma-btn">打开文件夹</button>
      </div>
      <div class="hint" id="snowluma-hint"></div></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-snowlumalaunch" ${c.snowluma.autoLaunch ? 'checked' : ''} />
      <label for="cfg-snowlumalaunch">QQ Agent 启动时自动拉起网关（仅 SnowLuma 部署有效）</label></div>
    <div class="field-row">
      <div class="field"><label>WebSocket 地址（收消息）</label><input type="text" id="cfg-wsurl" value="${esc(c.snowluma.wsUrl)}" /></div>
      <div class="field"><label>HTTP 地址（发消息）</label><input type="text" id="cfg-httpurl" value="${esc(c.snowluma.httpUrl)}" /></div>
      <div class="field"><label>WebSocket 令牌</label><input type="password" id="cfg-obtoken" value="${esc(c.snowluma.accessToken || '')}" /></div>
      <div class="field"><label>HTTP 令牌（与 WS 不同时填）</label><input type="password" id="cfg-obhttptoken" value="${esc(c.snowluma.httpAccessToken || '')}" /></div>
    </div>
    <div class="hint">改完 OneBot 地址需要重启应用生效；模型/人设/白名单即时生效。</div>`;
}

// ── 群友福利（welfare）─────────────────────────────────────
// 数据来源：GET /api/welfare（概览/统计）、GET /api/welfare/claims（明细，码已打码）。
// 编辑回填用 state.config.welfare.campaigns（原始活动对象，含码列表）；
// 写入一律走 POST /api/welfare/campaign，不改动 /api/config 的其它字段。
const WELFARE_REWARD_TYPES = [
  ['key', 'API Key / 额度'],
  ['coupon', '优惠券 / 折扣码'],
  ['ck', 'CK / Cookie'],
  ['code', '兑换码 / 邀请码']
];
const WELFARE_ICON = { key: '🔑', coupon: '🎟️', ck: '🍪', code: '🎫' };
const WELFARE_NOTICE_LIMIT = 600;

function welfareOn(v, dflt = true) { return v === undefined ? dflt : v !== false; }

/** 新建奖励项的默认形状（id 立即生成，编辑时保持不变，领取明细按 id 对齐） */
function blankWelfareReward() {
  return {
    id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    label: '', type: 'key', items: [], perUser: 1, keywords: [],
    info: { baseUrl: '', model: '', quota: '', shopUrl: '', note: '', howto: '' }
  };
}

/** 从 state.config 读原始活动（含码列表），用于编辑回填 */
function welfareRawCampaign(id) {
  const list = state.config?.welfare?.campaigns;
  if (!Array.isArray(list)) return null;
  return list.find((x) => x && x.id === id) || null;
}

/** 总览：总开关、活动数、累计领取、每个活动各奖励项「已发/总数」+ 进度条 */
/** 活动列表：每个活动的关键配置 + 启停开关 + 编辑/删除 */
/** 组装编辑器的初始草稿：优先用正在编辑的草稿，其次原始配置，最后快照 */
function welfareEditorDraft(w) {
  if (state.welfareDraft) return state.welfareDraft;
  const editingId = state.welfareEditing || '';
  if (!editingId) return null;
  const raw = welfareRawCampaign(editingId);
  const snap = (w.campaigns || []).find((x) => x.id === editingId);
  const base = raw || snap;
  if (!base) return null;
  return {
    id: base.id || '',
    title: base.title || '',
    enabled: welfareOn(base.enabled, true),
    sourceGroups: base.sourceGroups || [],
    minJoinHours: base.minJoinHours ?? 24,
    graceExisting: welfareOn(base.graceExisting, true),
    exemptUsers: base.exemptUsers || [],
    claimWords: base.claimWords || [],
    rewards: (raw?.rewards || []).map((r) => ({
      id: r.id || '',
      label: r.label || '',
      type: r.type || 'key',
      items: Array.isArray(r.items) ? r.items.slice() : [],
      perUser: r.perUser ?? 1,
      keywords: Array.isArray(r.keywords) ? r.keywords.slice() : [],
      info: {
        baseUrl: r.info?.baseUrl || '', model: r.info?.model || '',
        quota: r.info?.quota ?? '', shopUrl: r.info?.shopUrl || '',
        note: r.info?.note || '', howto: r.info?.howto || ''
      }
    })),
    rawMissing: !raw && !!snap
  };
}

/** 新建/编辑活动的表单；奖励项数量不限 */
/** 读取编辑器表单为活动对象 */
function readWelfareForm() {
  const box = $('#wf-editor');
  if (!box) return null;
  const val = (sel) => { const n = $('#' + sel, box); return n ? n.value : ''; };
  const rewards = $$('[data-wf-reward]', box).map((el, idx) => {
    const rv = (key) => { const n = $(`[data-wf-r-${key}="${idx}"]`, box); return n ? n.value : ''; };
    const quotaRaw = rv('quota').trim();
    return {
      id: el.dataset.wfRewardId || blankWelfareReward().id,
      label: rv('label').trim(),
      type: rv('type') || 'key',
      items: rv('items').split('\n').map((x) => x.trim()).filter(Boolean),
      perUser: Math.max(1, Number(rv('peruser')) || 1),
      keywords: parseList(rv('keywords')),
      info: {
        baseUrl: rv('baseurl').trim(),
        model: rv('model').trim(),
        quota: quotaRaw === '' ? '' : Number(quotaRaw),
        shopUrl: rv('shopurl').trim(),
        note: rv('note').trim(),
        howto: rv('howto').trim()
      }
    };
  });
  const chk = (id) => !!$('#' + id, box)?.checked;
  return {
    id: val('wf-id').trim(),
    title: val('wf-title').trim(),
    enabled: chk('wf-enabled'),
    sourceGroups: parseList(val('wf-groups')),
    minJoinHours: Math.max(0, Number(val('wf-hours')) || 0),
    graceExisting: chk('wf-grace'),
    exemptUsers: parseList(val('wf-exempt')),
    claimWords: parseList(val('wf-words')),
    rewards
  };
}

/** 领取明细：选中的活动 → 谁在什么时间领到了哪些（码已打码） */
/** 发布公告：内容 + 群号，600 字实时计数 */
function updateWelfareCounter() {
  const ta = $('#wf-notice-text');
  const el = $('#wf-notice-counter');
  const btn = $('#wf-notice-btn');
  if (!ta || !el) return;
  const n = ta.value.length;
  el.textContent = `${n} / ${WELFARE_NOTICE_LIMIT}`;
  el.className = 'wf-counter' + (n > WELFARE_NOTICE_LIMIT ? ' over' : '');
  if (btn) btn.disabled = n > WELFARE_NOTICE_LIMIT || n === 0;
}

/** 保存（创建或更新）一个活动；POST /api/welfare/campaign */
async function saveWelfareCampaign() {
  const out = $('#wf-editor-result');
  const draft = readWelfareForm();
  if (!draft) return;
  if (!draft.id) draft.id = 'welfare-' + Date.now().toString(36);
  if (!/^[A-Za-z0-9_-]+$/.test(draft.id)) {
    if (out) out.textContent = '活动 ID 只能用字母/数字/-/_';
    return;
  }
  if (!draft.title) draft.title = draft.id;
  // 丢掉完全空白的奖励项；缺名称的用 id 兜底
  draft.rewards = draft.rewards.filter((r) => r.label || r.items.length || r.keywords.length);
  draft.rewards.forEach((r, i) => {
    if (!r.id) r.id = 'r' + i;
    if (!r.label) r.label = `奖励 ${i + 1}`;
    if (!r.type) r.type = 'key';
  });
  if (!draft.rewards.length && !confirm('这个活动还没有任何奖励项，群友领取时不会有内容。仍要保存吗？')) return;
  const btn = $('#wf-save-campaign-btn');
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/welfare/campaign', { method: 'POST', body: JSON.stringify(draft) });
    state.welfareEditing = r.campaign?.id || draft.id;
    state.welfareDraft = null;
    state.welfareToast = '已保存活动 ✓';
    setTimeout(() => { state.welfareToast = ''; }, 4000);
    await loadWelfare({ withConfig: true });
    if (state.settingsSection === 'welfare') renderSettings();
  } catch (e) {
    if (out) out.textContent = '保存失败：' + e.message;
    if (btn) btn.disabled = false;
  }
}

async function deleteWelfareCampaign(id) {
  if (!confirm(`确定删除活动「${id}」？领取记录不会被删除。`)) return;
  try {
    await api('/api/welfare/campaign/delete', { method: 'POST', body: JSON.stringify({ id }) });
    if (state.welfareEditing === id) { state.welfareEditing = ''; state.welfareDraft = null; }
    if (state.welfareClaimsCampaign === id) { state.welfareClaimsCampaign = ''; state.welfareClaims = null; state.welfareClaimsFor = ''; }
    state.welfareToast = '已删除 ✓';
    setTimeout(() => { state.welfareToast = ''; }, 4000);
    await loadWelfare({ withConfig: true });
    if (state.settingsSection === 'welfare') renderSettings();
  } catch (e) {
    alert('删除失败：' + e.message);
  }
}

async function toggleWelfareCampaign(id, enabled) {
  const raw = welfareRawCampaign(id);
  if (!raw) { alert('该活动不在本地配置里（可能来自旧版结构），请点「编辑」后保存。'); return; }
  try {
    await api('/api/welfare/campaign', { method: 'POST', body: JSON.stringify({ ...raw, enabled }) });
    state.welfareToast = enabled ? '已启用 ✓' : '已停用 ✓';
    setTimeout(() => { state.welfareToast = ''; }, 4000);
    await loadWelfare({ withConfig: true });
    if (state.settingsSection === 'welfare') renderSettings();
  } catch (e) {
    alert('操作失败：' + e.message);
    if (state.settingsSection === 'welfare') renderSettings();
  }
}

async function publishWelfareNotice() {
  const out = $('#wf-notice-result');
  const ta = $('#wf-notice-text');
  const groupsEl = $('#wf-notice-groups');
  const content = (ta?.value || '').trim();
  const groups = parseList(groupsEl?.value || '');
  state.welfareNotice = content;
  state.welfareNoticeGroups = groupsEl?.value || '';
  if (!content) { if (out) out.textContent = '请先填写公告内容'; return; }
  if (content.length > WELFARE_NOTICE_LIMIT) {
    if (out) out.textContent = `内容 ${content.length} 字，超出 ${WELFARE_NOTICE_LIMIT} 字上限，请精简。`;
    return;
  }
  if (!groups.length) { if (out) out.textContent = '请填写至少一个群号'; return; }
  const btn = $('#wf-notice-btn');
  if (btn) { btn.disabled = true; btn.textContent = '发布中…'; }
  const results = [];
  for (const gid of groups) {
    try {
      const r = await api('/api/welfare/notice', { method: 'POST', body: JSON.stringify({ groupId: gid, content }) });
      results.push(`${gid} ${r.ok === false ? '✗ ' + (r.error || '失败') : '✓'}`);
    } catch (e) {
      results.push(`${gid} ✗ ${e.message}`);
    }
  }
  if (out) out.textContent = results.join('；');
  if (btn) { btn.textContent = '发布公告'; }
  updateWelfareCounter();
}

/** 福利区块事件绑定（由 bindSettingsEvents 在 welfare 区块调用） */
function bindWelfareEvents() {
  const reload = $('#wf-reload-btn');
  if (reload) reload.addEventListener('click', () => { state.welfareError = ''; loadWelfare({ withConfig: true }); });

  // 首次进入：拉取概览 + 原始配置（编辑回填要用）
  if (!state.welfareLoadedAt) { loadWelfare({ withConfig: true }); return; }
  if (!state.welfare) return;

  // 活动列表：启停 / 编辑 / 删除
  $$('[data-wf-toggle]').forEach((el) => el.addEventListener('change', () => toggleWelfareCampaign(el.dataset.wfToggle, el.checked)));
  $$('[data-wf-edit]').forEach((el) => el.addEventListener('click', () => {
    state.welfareEditing = el.dataset.wfEdit;
    state.welfareDraft = null;
    renderSettings();
  }));
  $$('[data-wf-del]').forEach((el) => el.addEventListener('click', () => deleteWelfareCampaign(el.dataset.wfDel)));

  // 编辑器：增删奖励项（先读回草稿再重渲染，避免输入丢失）
  const addReward = $('#wf-add-reward-btn');
  if (addReward) addReward.addEventListener('click', () => {
    const d = readWelfareForm();
    if (d) state.welfareDraft = d;
    if (!state.welfareDraft) state.welfareDraft = { id: state.welfareEditing || '', title: '', enabled: true, sourceGroups: [], minJoinHours: 24, graceExisting: true, exemptUsers: [], claimWords: [], rewards: [] };
    state.welfareDraft.rewards.push(blankWelfareReward());
    renderSettings();
  });
  $$('[data-wf-remove-reward]').forEach((el) => el.addEventListener('click', () => {
    const idx = Number(el.dataset.wfRemoveReward);
    const d = readWelfareForm();
    if (d) state.welfareDraft = d;
    if (state.welfareDraft) {
      state.welfareDraft.rewards.splice(idx, 1);
      renderSettings();
    }
  }));
  const saveCampaign = $('#wf-save-campaign-btn');
  if (saveCampaign) saveCampaign.addEventListener('click', saveWelfareCampaign);
  const newCampaign = $('#wf-new-campaign-btn');
  if (newCampaign) newCampaign.addEventListener('click', () => {
    state.welfareEditing = '';
    state.welfareDraft = null;
    renderSettings();
  });

  // 领取明细：切换活动即拉取
  const claimsSel = $('#wf-claims-campaign');
  if (claimsSel) {
    const cid = claimsSel.value || '';
    state.welfareClaimsCampaign = cid;
    if (!cid) state.welfareClaims = [];
    else if (state.welfareClaimsFor !== cid) loadWelfareClaims(cid);
    claimsSel.addEventListener('change', () => loadWelfareClaims(claimsSel.value));
  }

  // 发布公告：实时字数
  const noticeText = $('#wf-notice-text');
  if (noticeText) {
    updateWelfareCounter();
    noticeText.addEventListener('input', () => {
      state.welfareNotice = noticeText.value;
      updateWelfareCounter();
    });
  }
  const noticeGroups = $('#wf-notice-groups');
  if (noticeGroups) noticeGroups.addEventListener('input', () => { state.welfareNoticeGroups = noticeGroups.value; });
  const noticeBtn = $('#wf-notice-btn');
  if (noticeBtn) noticeBtn.addEventListener('click', publishWelfareNotice);
}

function bindSettingsEvents(c) {
  // 外观面板（皮肤 / 背景）—— 它有自己的绑定函数
  bindAppearanceEvents();

  // API Key 显示/隐藏（默认遮蔽：密钥不在屏幕上明文暴露 —— 记忆 00 的密钥纪律）
  const toggleKey = $('#toggle-apikey');
  if (toggleKey) toggleKey.addEventListener('click', () => {
    const inp = $('#cfg-apikey');
    if (!inp) return;
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    toggleKey.textContent = show ? '隐藏' : '显示';
  });

  // AnySearch Key 的添加/保存按钮
  const addKeyBtn = $('#add-search-key-btn');
  if (addKeyBtn) addKeyBtn.addEventListener('click', () => {
    const box = $('#search-key-rows');
    if (!box) return;
    const inputs = box.querySelectorAll('.search-key-input');
    const idx = inputs.length;
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;align-items:center';
    div.innerHTML = '<input type="text" class="search-key-input" data-idx="' + idx + '" placeholder="粘贴 AnySearch API Key" style="flex:1" />' +
      '<button class="btn btn-small" type="button" title="清空">✕</button>';
    div.querySelector('button').addEventListener('click', () => { div.remove(); });
    box.appendChild(div);
  });
  const saveKeyBtn = $('#save-search-keys-btn');
  if (saveKeyBtn) saveKeyBtn.addEventListener('click', saveSearchKeys);

  // 保存当前区块设置（通用保存按钮）。只有当前区块的字段才会被读取，不会 null 报错。
  // 群管理区块：加载最近处理记录
  if (state.settingsSection === 'groupmgr' && $('#gm-recent')) {
    api('/api/group-manager').then((r) => {
      const el = $('#gm-recent');
      if (!el) return;
      const rec = r.recent || [];
      if (!rec.length) { el.textContent = '（暂无记录）'; return; }
      const kindName = { welcome: '迎新', 'friend-approve': '同意好友', 'friend-reject': '拒绝好友',
        'group-approve': '同意入群', 'group-reject': '拒绝入群', 'friend-pending': '好友申请(未处理)',
        'group-pending': '入群申请(未处理)' };
      el.innerHTML = rec.map((x) => {
        const t = new Date(x.at).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        return `<div>${t} · ${esc(kindName[x.type] || x.type)}${x.userId ? ' · ' + esc(x.userId) : ''}${x.groupId ? ' · 群 ' + esc(x.groupId) : ''}</div>`;
      }).join('');
    }).catch(() => { const el = $('#gm-recent'); if (el) el.textContent = '（读取失败）'; });
  }

  const saveCfgBtn = $('#save-cfg-btn');
  if (saveCfgBtn) saveCfgBtn.addEventListener('click', async () => {
    try {
      await saveConfig();
      $('#cfg-save-result').textContent = '已保存 ✓';
      refreshStatus();
    } catch (e) {
      $('#cfg-save-result').textContent = `保存失败：${e.message}`;
    }
  });

  // ── 模型 API 区块事件 ──
  // 点击文本框弹出选择模态框（无“选择”按钮）
  const modelPickInput = $('#cfg-model-pick');
  if (modelPickInput) modelPickInput.addEventListener('click', () => openModelPicker());
  const testProviderBtn = $('#test-provider-btn');
  if (testProviderBtn) testProviderBtn.addEventListener('click', async () => {
    const btn = testProviderBtn;
    const out = $('#provider-test-result');
    btn.textContent = '测试中…';
    if (out) out.textContent = '';
    try {
      const baseUrl = $('#cfg-baseurl')?.value.trim() || '';
      const apiKey = $('#cfg-apikey')?.value.trim() || '';
      const model = $('#cfg-model')?.value.trim() || '';
      const r = await api('/api/providers/test-chat', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey, model })
      });
      const res = r.result || {};
      if (out) out.textContent = res.ok
        ? `✓ 测试通过（${res.latencyMs}ms）：${res.note || '请求成功'}`
        : `✗ 测试失败：${res.note || '未知错误'}`;
    } catch (e) {
      if (out) out.textContent = `测试失败：${e.message}`;
    }
    btn.textContent = '测试连通性';
  });

  // 当前 Base URL 右侧的“获取列表”
  const fetchCurrentBtn = $('#fetch-current-models-btn');
  if (fetchCurrentBtn) fetchCurrentBtn.addEventListener('click', async () => {
    const btn = fetchCurrentBtn;
    const base = $('#cfg-baseurl')?.value.trim() || '';
    const key = $('#cfg-apikey')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '当前 Base URL 为空'; return; }
    btn.textContent = '拉取中…';
    try {
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  const fetchModelsBtn = $('#fetch-models-btn');
  if (fetchModelsBtn) fetchModelsBtn.addEventListener('click', async () => {
    const btn = fetchModelsBtn;
    const base = $('#new-baseurl')?.value.trim() || '';
    const key = $('#new-apikey')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '请先填写 Base URL'; return; }
    btn.textContent = '拉取中…';
    try {
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  // 模型列表行：ID + 显示名
  let modelRows = [{ id: '', name: '' }];
  function renderModelRows() {
    const box = $('#model-rows');
    if (!box) return;
    box.innerHTML = `
      <table class="model-rows-table">
        <tr><th style="width:44%">模型 ID</th><th style="width:44%">模型目录显示名</th><th></th></tr>
        ${modelRows.map((row, i) => `
          <tr>
            <td><input type="text" class="mr-id" data-i="${i}" placeholder="如 glm-5.3-flash" value="${esc(row.id)}" /></td>
            <td><input type="text" class="mr-name" data-i="${i}" placeholder="如 智谱 GLM 5.3 Flash" value="${esc(row.name)}" /></td>
            <td style="width:56px;text-align:right"><button class="btn btn-small btn-danger mr-del" data-i="${i}" ${modelRows.length <= 1 ? 'disabled' : ''}>删除</button></td>
          </tr>`).join('')}
      </table>`;
    box.querySelectorAll('.mr-id').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].id = el.value; });
    });
    box.querySelectorAll('.mr-name').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].name = el.value; });
    });
    box.querySelectorAll('.mr-del').forEach((el) => {
      el.addEventListener('click', () => {
        if (modelRows.length <= 1) return;
        modelRows.splice(Number(el.dataset.i), 1);
        renderModelRows();
      });
    });
  }
  renderModelRows();
  const addModelRowBtn = $('#add-model-row-btn');
  if (addModelRowBtn) addModelRowBtn.addEventListener('click', () => {
    modelRows.push({ id: '', name: '' });
    renderModelRows();
  });

  const confirmAddProviderBtn = $('#confirm-add-provider-btn');
  if (confirmAddProviderBtn) confirmAddProviderBtn.addEventListener('click', async () => {
    const baseUrl = $('#new-baseurl').value.trim();
    const apiKey = $('#new-apikey').value.trim();
    const models = modelRows.map((r) => ({ id: r.id.trim(), name: (r.name || r.id).trim() })).filter((m) => m.id);
    if (!baseUrl) { $('#provider-action-hint').textContent = '请填写 Base URL'; return; }
    if (!models.length) { $('#provider-action-hint').textContent = '请至少添加一个模型（先点「获取列表」勾选，或手动填一行）'; return; }
    try {
      const r = await api('/api/providers', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey, models }) });
      $('#provider-action-hint').textContent = r.created ? '已添加新提供商，并自动切换为当前模型。' : '该 Base URL 已存在，模型已合并进该提供商。';
      modelRows = [{ id: '', name: '' }];
      renderModelRows();
      $('#new-baseurl').value = '';
      $('#new-apikey').value = '';
      setTimeout(() => loadSettings(), 500);
    } catch (e) {
      $('#provider-action-hint').textContent = `添加失败：${e.message}`;
    }
  });

  const deleteModelBtn = $('#delete-model-btn');
  if (deleteModelBtn) deleteModelBtn.addEventListener('click', () => openModelDeleteModal());

  // 图片输入开关联动（视觉扫描结果）
  function syncVisionSwitch(pid, model) {
    const box = $('#cfg-vision');
    const hint = $('#vision-switch-hint');
    if (!box) return;
    const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
    if (r && r.verdict === 'no-vision') {
      box.checked = false;
      box.disabled = true;
      hint.textContent = '此模型无图片输入';
    } else {
      box.disabled = false;
      box.checked = state.config.api.vision !== false;
      hint.textContent = r && r.verdict === 'vision' ? '检测结果：支持图片输入' : '';
    }
  }
  syncVisionSwitch(c.api.provider, c.api.model);

  // ── 人设区块事件 ──
  renderPersonaBackupBar();
  const personaPick = $('#cfg-persona-pick');
  function currentPersonaId() {
    const roleText = $('#cfg-roletext')?.value ?? '';
    const found = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === roleText);
    return found ? found[0] : '';
  }
  function syncPersonaButtons() {
    const id = currentPersonaId();
    const tpl = state.personaTemplates[id];
    const isCustom = id.startsWith('custom_');
    const delBtn = $('#del-persona-btn');
    if (delBtn) delBtn.classList.toggle('hidden', !isCustom);
    const hint = $('#persona-pick-hint');
    if (hint) hint.textContent = tpl ? (tpl.builtin ? '内置人设（小鲸鱼）' : '自定义人设') : '';
  }
  if (personaPick) {
    personaPick.addEventListener('click', () => openPersonaPicker());
  }
  const newPersonaBtn = $('#new-persona-btn');
  if (newPersonaBtn) newPersonaBtn.addEventListener('click', () => openPersonaCreateModal());
  const delPersonaBtn = $('#del-persona-btn');
  if (delPersonaBtn) delPersonaBtn.addEventListener('click', async () => {
    const id = currentPersonaId();
    if (!id.startsWith('custom_')) return;
    const tpl = state.personaTemplates[id];
    if (!tpl) return;
    if (!confirm(`确定删除自定义人设「${tpl.name}」？`)) return;
    try {
      await api(`/api/persona-templates/${id}`, { method: 'DELETE', body: '{}' });
      $('#cfg-roletext').value = state.personaTemplates.xiaojingyu?.text || '';
      $('#cfg-customrules').value = '';
      await loadSettings();
    } catch (e) {
      $('#persona-pick-hint').textContent = `删除失败：${e.message}`;
    }
  });
  const savePersonaBtn = $('#save-persona-btn');
  if (savePersonaBtn) savePersonaBtn.addEventListener('click', async () => {
    try {
      await saveConfig();
      $('#persona-save-result').textContent = '人设已保存 ✓';
      setTimeout(() => { $('#persona-save-result').textContent = ''; }, 3000);
    } catch (e) {
      $('#persona-save-result').textContent = `保存失败：${e.message}`;
    }
  });
  syncPersonaButtons();

  // ── 白名单区块事件 ──
  const pickGroupsBtn = $('#pick-groups-btn');
  if (pickGroupsBtn) pickGroupsBtn.addEventListener('click', () => openWhitelistPicker('groups'));
  const pickFriendsBtn = $('#pick-friends-btn');
  if (pickFriendsBtn) pickFriendsBtn.addEventListener('click', () => openWhitelistPicker('friends'));

  // ── OneBot 区块事件 ──
  const openSnowlumaBtn = $('#open-snowluma-btn');
  if (openSnowlumaBtn) openSnowlumaBtn.addEventListener('click', async () => {
    await saveConfig({ quiet: true });
    try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
    catch (e) { $('#snowluma-hint').textContent = `失败：${e.message}`; }
  });

  // ── 群友福利区块事件 ──
  if (state.settingsSection === 'welfare') bindWelfareEvents();
}

// ── 模型选择/添加/删除 模态框 ──
function closeModelModal(overlay) {
  if (overlay) overlay.remove();
}

function modelModalShell({ head, body, foot = '', danger = false }) {
  const overlay = document.createElement('div');
  overlay.className = 'model-modal-overlay';
  overlay.innerHTML = `
    <div class="model-modal ${danger ? 'danger' : ''}">
      <div class="model-modal-head">
        <span>${head}</span>
        <button class="model-modal-close">×</button>
      </div>
      <div class="model-modal-body">${body}</div>
      ${foot ? `<div class="model-modal-foot">${foot}</div>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModelModal(overlay);
  });
  overlay.querySelector('.model-modal-close').addEventListener('click', () => closeModelModal(overlay));
  return overlay;
}

// ── 人设选择/添加 模态框 ──

/** 选择人设：弹窗列出所有人设（含自定义），点击后填入角色设定文本框。 */
function openPersonaPicker() {
  const entries = Object.entries(state.personaTemplates || {});
  if (!entries.length) {
    $('#persona-pick-hint').textContent = '人设列表为空';
    return;
  }
  // 按 group 分组展示（2026-10-05：人设扩到 16+ 后，平铺列表太长不好找）。
  // 分组顺序用后端给的 groups；无 group 的（legacy 模板/自定义）归到「其他」。
  const order = Array.isArray(state.personaGroups) ? state.personaGroups : [];
  const bucket = new Map();
  for (const [id, p] of entries) {
    const g = (p.group && order.includes(p.group)) ? p.group : '其他';
    if (!bucket.has(g)) bucket.set(g, []);
    bucket.get(g).push([id, p]);
  }
  const groups = [...order.filter((g) => bucket.has(g)), ...(bucket.has('其他') ? ['其他'] : [])];
  const curText = $('#cfg-roletext')?.value ?? '';
  const overlay = modelModalShell({
    head: '选择人设',
    body: `<div class="model-modal-right" id="persona-list" style="flex:1">${
      groups.map((g) => `
        <div class="persona-group-title muted">${esc(g)}</div>
        ${bucket.get(g).map(([id, p]) => `
          <div class="mm-model" data-id="${esc(id)}">
            <span class="mm-check">${p.text === curText ? '✓' : ''}</span>
            <span>${esc(p.name)}</span>
            <span class="muted" style="font-size:11px">${p.builtin ? '内置' : '自定义'}</span>
          </div>`).join('')}`
      ).join('')
    }</div>`,
    foot: `<button class="btn" id="persona-cancel">取消</button>`
  });
  overlay.querySelectorAll('.mm-model').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const tpl = state.personaTemplates[id];
      closeModelModal(overlay);
      if (tpl) applyPersonaTemplate(tpl);
    });
  });
  overlay.querySelector('#persona-cancel').addEventListener('click', () => closeModelModal(overlay));
}

// 应用人设模板。**不再无条件整体覆盖**（2026-09-17 改）：
//   旧行为 = 点模板直接把 roleText 换掉、还把 customRules 清空，且无提示不可撤销，
//   用户自己写的人设会瞬间丢失。
//   新行为 = 先弹确认框，让用户选「覆盖」还是「追加」，并在覆盖前自动备份旧人设。
function applyPersonaTemplate(tpl) {
  const roleEl = $('#cfg-roletext');
  const rulesEl = $('#cfg-customrules');
  if (!roleEl) return;

  const oldText = roleEl.value || '';
  const oldRules = rulesEl?.value || '';
  const newText = tpl.text || '';
  const newRules = tpl.customRules || '';

  // 无内容可覆盖 → 直接套用，不打扰
  if (!oldText.trim()) {
    roleEl.value = newText;
    if (rulesEl && newRules) rulesEl.value = newRules;
    const input = $('#cfg-persona-pick');
    if (input) input.value = tpl.name;
    syncPersonaButtons();
    return;
  }

  // 已有内容 → 询问覆盖还是追加（追加 = 保留旧人设，把模板接在后面）
  const keepRules = oldRules.trim()
    ? '\n\n（你原有的「附加规则」会保留，不会被模板清掉。）'
    : '';
  const useOverwrite = window.confirm(
    `要把当前人设替换为「${tpl.name}」吗？\n\n`
    + `当前人设：${oldText.length} 字\n`
    + `新模板：${newText.length} 字\n\n`
    + `【确定】= 覆盖（旧人设会先自动备份，可还原）\n`
    + `【取消】= 改为「追加」（保留旧人设，模板内容接在后面）`
    + keepRules
  );

  if (useOverwrite) {
    // 覆盖前备份旧人设，防误操作
    state.personaBackup = { text: oldText, rules: oldRules, at: Date.now() };
    roleEl.value = newText;
    if (rulesEl) rulesEl.value = newRules;   // 覆盖时才替换附加规则
  } else {
    roleEl.value = oldText.trimEnd() + '\n\n---\n\n' + newText;
    // 追加模式保留原有附加规则；若原本为空，则带入模板自带的
    if (rulesEl && !oldRules.trim() && newRules) rulesEl.value = newRules;
  }

  const input = $('#cfg-persona-pick');
  if (input) input.value = tpl.name;
  syncPersonaButtons();
  renderPersonaBackupBar();
}

// 覆盖后可一键还原（仅在本次页面会话内有效，刷新即失效）
function renderPersonaBackupBar() {
  const bar = $('#persona-backup-bar');
  if (!bar) return;
  const b = state.personaBackup;
  if (!b) { bar.innerHTML = ''; return; }
  const t = new Date(b.at).toLocaleTimeString('zh-CN', { hour12: false });
  bar.innerHTML = `<span class="muted" style="font-size:12px">已备份覆盖前的人设（${b.text.length} 字，${t}）</span>
    <button class="btn btn-small" id="persona-restore-btn">还原</button>`;
  const btn = $('#persona-restore-btn');
  if (btn) btn.addEventListener('click', () => {
    const roleEl = $('#cfg-roletext');
    if (roleEl) roleEl.value = b.text;
    const rulesEl = $('#cfg-customrules');
    if (rulesEl) rulesEl.value = b.rules;
    state.personaBackup = null;
    renderPersonaBackupBar();
    syncPersonaButtons();
  });
}

/** 添加人设：弹窗填写人设名称、角色设定、管理员附加规则。 */
function openPersonaCreateModal() {
  const overlay = modelModalShell({
    head: '添加人设',
    body: `
      <div class="field" style="flex:1;min-width:0">
        <label>人设名称</label>
        <input type="text" id="new-persona-name" placeholder="例如：毒舌老哥" />
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>角色设定</label>
        <textarea id="new-persona-text" class="persona-role-text" style="min-height:220px" placeholder="人设文本（每轮注入，群友不可修改）"></textarea>
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>管理员附加规则（可选）</label>
        <textarea id="new-persona-rules" style="min-height:90px" placeholder="可选：追加到系统提示的规则"></textarea>
      </div>`,
    foot: `<button class="btn" id="persona-add-cancel">取消</button>
           <button class="btn btn-primary" id="persona-add-apply">确认添加</button>`
  });
  overlay.querySelector('#persona-add-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#persona-add-apply').addEventListener('click', async () => {
    const name = overlay.querySelector('#new-persona-name').value.trim();
    const text = overlay.querySelector('#new-persona-text').value.trim();
    const customRules = overlay.querySelector('#new-persona-rules').value.trim();
    if (!name) { $('#persona-pick-hint').textContent = '人设名称不能为空'; return; }
    if (!text) { $('#persona-pick-hint').textContent = '角色设定不能为空'; return; }
    try {
      await api('/api/persona-templates', {
        method: 'POST',
        body: JSON.stringify({ name, text, customRules })
      });
      closeModelModal(overlay);
      $('#cfg-roletext').value = text;
      $('#cfg-customrules').value = customRules;
      const input = $('#cfg-persona-pick');
      if (input) input.value = name;
      $('#persona-pick-hint').textContent = `人设「${name}」已添加。记得点「保存人设修改」使当前填写生效。`;
      await loadSettings();
    } catch (e) {
      $('#persona-pick-hint').textContent = `添加失败：${e.message}`;
    }
  });
}

/** 选择模型：左提供商 / 右模型，点击模型后保存到当前 api 配置并关闭。 */
function openModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-hint').textContent = '模型目录为空：请先在下方的“手动添加提供商”里添加。';
    return;
  }
  const overlay = modelModalShell({
    head: '选择模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  const current = state.config?.api?.provider;
  let activePid = current || providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === state.config?.api?.model && p.id === current ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        try {
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ api: { provider: pid, model, baseUrl: p.baseURL, apiKey: p.apiKey || '' } })
          });
          closeModelModal(overlay);
          loadSettings();
        } catch (e) {
          $('#provider-hint').textContent = `选择失败：${e.message}`;
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** “获取列表”后的勾选添加弹窗：已添加的模型显示为已选（不可重复勾选）。 */
function openModelAddModal(baseUrl, apiKey, remoteModels) {
  const providers = state.providers || [];
  const existingProvider = providers.find((p) => (p.baseURL || '').replace(/\/+$/, '') === baseUrl.replace(/\/+$/, ''));
  const existingIds = new Set(existingProvider?.models || []);
  const overlay = modelModalShell({
    head: '勾选模型加入列表',
    body: `
      <div class="model-modal-right" id="ma-list" style="flex:1">
        ${remoteModels.map((m) => `
          <label class="mm-model">
            <input type="checkbox" class="ma-check" value="${esc(m)}" ${existingIds.has(m) ? 'checked disabled' : ''} />
            <span>${esc(m)}</span>
            ${existingIds.has(m) ? '<span class="muted" style="font-size:11px">已添加</span>' : ''}
          </label>`).join('') || '<div class="muted" style="padding:10px">没有拉到模型</div>'}
      </div>`,
    foot: `<button class="btn" id="ma-cancel">取消</button>
           <button class="btn btn-primary" id="ma-apply">加入列表</button>`
  });
  overlay.querySelector('#ma-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#ma-apply').addEventListener('click', async () => {
    const picked = [...overlay.querySelectorAll('.ma-check:checked')].map((el) => el.value);
    const newModels = picked.filter((m) => !existingIds.has(m));
    if (!newModels.length) {
      closeModelModal(overlay);
      return;
    }
    try {
      const body = existingProvider
        ? { providerId: existingProvider.id, models: newModels.map((m) => ({ id: m, name: m })) }
        : { baseUrl, apiKey, models: newModels.map((m) => ({ id: m, name: m })) };
      const endpoint = existingProvider ? '/api/providers/models' : '/api/providers';
      await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      closeModelModal(overlay);
      $('#provider-action-hint').textContent = `已加入 ${newModels.length} 个模型。`;
      loadSettings();
    } catch (e) {
      $('#provider-action-hint').textContent = `加入失败：${e.message}`;
      closeModelModal(overlay);
    }
  });
}

/** 删除模型：左提供商 / 右模型（带删除按钮），暗红色调。 */
function openModelDeleteModal() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-action-hint').textContent = '模型目录为空，没有可删除的模型。';
    return;
  }
  const overlay = modelModalShell({
    head: '删除模型',
    body: `
      <div class="model-modal-left" id="md-left"></div>
      <div class="model-modal-right" id="md-right"></div>`,
    foot: `<button class="btn" id="md-cancel">关闭</button>`,
    danger: true
  });
  const left = overlay.querySelector('#md-left');
  const right = overlay.querySelector('#md-right');
  let activePid = providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-model="${esc(m)}">
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
        <button class="mm-del">删除</button>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.querySelector('.mm-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        const model = el.dataset.model;
        if (!confirm(`确定从「${p.displayName || p.id}」删除模型 ${model}？`)) return;
        try {
          await api('/api/providers/models', {
            method: 'DELETE',
            body: JSON.stringify({ providerId: p.id, modelId: model })
          });
          renderRight();
          loadSettings();
        } catch (err) {
          alert(`删除失败：${err.message}`);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#md-cancel').addEventListener('click', () => closeModelModal(overlay));
}

// ── 白名单可视化选择器 ──
async function openWhitelistPicker(kind) {
  const isGroups = kind === 'groups';
  $('#pick-result').textContent = '拉取中…';
  let list;
  try {
    const data = await api(`/api/onebot/${kind}`);
    list = isGroups ? data.groups : data.friends;
  } catch (e) {
    $('#pick-result').textContent = `拉取失败：${e.message}（OneBot 未连接？）`;
    return;
  }
  if (!list?.length) {
    $('#pick-result').textContent = isGroups ? '没拉到群列表（检查网关连接）' : '没拉到好友列表';
    return;
  }
  const inputEl = $(isGroups ? '#cfg-allowgroups' : '#cfg-allowprivate');
  const selected = new Set(parseList(inputEl.value));
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">选择${isGroups ? '群' : '好友'}（已选 ${selected.size} 个）</div>
      <div class="modal-list">
        ${list.map((g) => `
          <label class="pick-item">
            <input type="checkbox" value="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''} />
            <span>${esc(g.name)}</span>
            <span class="muted">${esc(g.id)}</span>
          </label>`).join('')}
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="pick-apply">确定</button>
        <button class="btn" id="pick-cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#pick-cancel', overlay).addEventListener('click', () => overlay.remove());
  $('#pick-apply', overlay).addEventListener('click', () => {
    const picked = $$('input[type=checkbox]:checked', overlay).map((el) => el.value);
    inputEl.value = picked.join(',');
    $('#pick-result').textContent = `已选 ${picked.length} 个${isGroups ? '群' : '好友'}，记得点"保存设置"`;
    overlay.remove();
  });
}

function parseList(s) {
  return String(s || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

async function saveConfig({ quiet = false } = {}) {
  const c = state.config;
  // 只在当前区块的元素存在时才读取，避免“每个区块保存时读取其他区块元素”导致的 null 报错。
  const el = (sel) => document.querySelector(sel);
  const val = (sel, fallback = '') => {
    const node = el(sel);
    return node ? node.value : fallback;
  };
  const chk = (sel, fallback = false) => {
    const node = el(sel);
    return node ? node.checked : fallback;
  };
  const sec = state.settingsSection || 'api';

  const patch = {};

  if (sec === 'api') {
    // 🔴 2026-10-26 修：原来这里没读 baseUrl / apiKey，
    //    导致用户手改后再保存会被旧值覆盖（看着像"强制改回"）。
    //    baseUrl 之前还是 readonly，连改都改不了。
    const baseUrlInput = val('#cfg-baseurl', c.api.baseUrl).trim();
    const apiKeyInput = val('#cfg-apikey', c.api.apiKey);
    patch.api = {
      vision: chk('#cfg-vision', c.api.vision !== false),
      temperature: Number(val('#cfg-temperature', c.api.temperature)) || 0.8,
      maxRounds: Number(val('#cfg-maxrounds', c.api.maxRounds)) || 12
    };
    // 只在用户真的改了才覆盖（避免空值把已有配置清掉）
    if (baseUrlInput && baseUrlInput !== String(c.api.baseUrl || '')) {
      patch.api.baseUrl = baseUrlInput;
    }
    if (apiKeyInput && apiKeyInput !== String(c.api.apiKey || '')) {
      patch.api.apiKey = apiKeyInput;
    }
    patch.webSearch = {
      ...c.webSearch,
      enabled: chk('#cfg-websearch', c.webSearch?.enabled !== false),
      provider: val('#cfg-searchprovider', c.webSearch?.provider || 'auto'),
      searchUrl: val('#cfg-searchurl', c.webSearch?.searchUrl || 'https://cn.bing.com/search').trim() || 'https://cn.bing.com/search'
    };
  }

  if (sec === 'persona') {
    patch.persona = {
      botName: val('#cfg-botname', c.persona.botName).trim() || '小鲸鱼',
      selfNickname: val('#cfg-selfnick', c.persona.selfNickname || '').trim(),
      participation: val('#cfg-participation', c.persona.participation),
      roleText: val('#cfg-roletext', c.persona.roleText || ''),
      customRules: val('#cfg-customrules', c.persona.customRules || '')
    };
  }

  // 能力相关的总开关（原「能力总览」页有两个，2026-10-21 该页删除后搬到这里）。
  // ⚠️ 只保留**内核级**开关；插件级开关（课程播报、学习模式、teacher_control）
  //    已归到各自插件，在「插件」页管理 —— 状态与开关应在同一处，不要两处重复。
  if (sec === 'chat') {
    patch.privateAllowGroupMembers = chk('#cfg-feat-allowgroupmembers', c.privateAllowGroupMembers !== false);
    patch.features = {
      ...(c.features || {}),
      proactivePrivate: chk('#cfg-feat-proactive-private', c.features?.proactivePrivate !== false)
    };
  }

  if (sec === 'groupmgr') {
    patch.groupManager = {
      ...(c.groupManager || {}),
      welcomeEnabled: chk('#cfg-gm-welcome', c.groupManager?.welcomeEnabled !== false),
      autoApproveFriend: chk('#cfg-gm-friend', c.groupManager?.autoApproveFriend === true),
      autoApproveGroup: chk('#cfg-gm-group', c.groupManager?.autoApproveGroup === true),
      welcomeTemplate: val('#cfg-gm-welcome-tpl', c.groupManager?.welcomeTemplate || ''),
      selfJoinTemplate: val('#cfg-gm-selfjoin-tpl', c.groupManager?.selfJoinTemplate || ''),
      requiredKeywords: parseList(val('#cfg-gm-keywords', (c.groupManager?.requiredKeywords || []).join(','))),
      denyUsers: parseList(val('#cfg-gm-deny', (c.groupManager?.denyUsers || []).join(',')))
    };
  }

  if (sec === 'allow') {
    patch.allow = {
      groups: parseList(val('#cfg-allowgroups', (c.allow?.groups || []).join(','))),
      private: parseList(val('#cfg-allowprivate', (c.allow?.private || []).join(',')))
    };
    patch.deny = { groups: [], private: [] };
    patch.allowAllWhenEmpty = false;

    // 主人 QQ（2026-10-21）：与 masterOnly 工具共用同一份配置 persona.masterQQ。
    // 只取第一个 —— 判定逻辑（orchestrator 的 isMaster）比较的是单个值。
    const masters = parseList(val('#cfg-masterqq', c.persona?.masterQQ || ''));
    patch.persona = { ...(c.persona || {}), masterQQ: masters[0] || '' };
  }

  if (sec === 'chat') {
    patch.wakeDelayMs = Number(val('#cfg-wakedelay', c.wakeDelayMs)) || 2000;
    patch.drainDelayMs = Number(val('#cfg-draindelay', c.drainDelayMs)) || 1200;
    patch.maxConcurrentRuns = Number(val('#cfg-maxruns', c.maxConcurrentRuns)) || 2;
    patch.send = {
      ...c.send,
      minGapMs: Number(val('#cfg-mingap', c.send?.minGapMs)) || 1000,
      maxGapMs: Number(val('#cfg-maxgap', c.send?.maxGapMs)) || 3000,
      maxPerMinute: Number(val('#cfg-maxpermin', c.send?.maxPerMinute)) || 8
    };
    patch.proactive = {
      ...c.proactive,
      enabled: chk('#cfg-proactive', !!c.proactive?.enabled),
      checkIntervalMinMs: Number(val('#cfg-pro-min', c.proactive?.checkIntervalMinMs)) || 1800000,
      checkIntervalMaxMs: Number(val('#cfg-pro-max', c.proactive?.checkIntervalMaxMs)) || 5400000,
      probability: Number(val('#cfg-pro-prob', c.proactive?.probability)) || 0.25
    };
    patch.sticker = { ...c.sticker, enabled: chk('#cfg-sticker', c.sticker?.enabled !== false) };
    patch.store = {
      pastStateLimit: Math.min(500, Math.max(10, Number(val('#cfg-pastlimit', c.store?.pastStateLimit)) || 80)),
      pastStateMaxChars: Math.min(60000, Math.max(1000, Number(val('#cfg-pastchars', c.store?.pastStateMaxChars)) || 6000))
    };
  }

  if (sec === 'desktop') {
    patch.server = {
      ...c.server,
      autoStart: chk('#cfg-autostart', !!c.server?.autoStart),
      closeToTray: chk('#cfg-closetray', c.server?.closeToTray !== false)
    };
  }

  if (sec === 'onebot') {
    patch.snowluma = {
      dir: val('#cfg-snowlumadir', c.snowluma?.dir || '').trim(),
      autoLaunch: chk('#cfg-snowlumalaunch', !!c.snowluma?.autoLaunch),
      wsUrl: val('#cfg-wsurl', c.snowluma?.wsUrl || '').trim(),
      httpUrl: val('#cfg-httpurl', c.snowluma?.httpUrl || '').trim(),
      accessToken: val('#cfg-obtoken', c.snowluma?.accessToken || '').trim(),
      httpAccessToken: val('#cfg-obhttptoken', c.snowluma?.httpAccessToken || '').trim()
    };
  }

  const data = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  state.config = data.config;
  if (!quiet) $('#model-label').textContent = `模型：${state.config.api.model || '未设置'}`;
  return data;
}

// ── 标签页切换 ──
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    $$('.view').forEach((v) => v.classList.remove('active'));
    $(`#view-${tab.dataset.tab}`).classList.add('active');
    state.tab = tab.dataset.tab;
    // ⚠️ 这里是**第二套** tab 绑定（与上方 switchTab 并存）。
    //    历史上漏加分支导致「点了页签但页面永远空白」，实测踩过一次（v3 记录）。
    //    以后每加一个 tab，**两处都要同步**。
    dispatchTabLoad(state.tab);
  });
});

// ── 启动 ──
(async function init() {
  // 启动 loading：先等 HTTP 服务可用（页面可能先于服务打开）
  setLoadingStatus('正在启动 QQ Agent 服务…');
  await bootLoop();

  // 首启引导：关键配置（模型/白名单）没填就直接带去设置页
  try {
    const cfg = await api('/api/config');
    const ready = !!cfg.api.model && ((cfg.allow.groups?.length || cfg.allow.private?.length) || cfg.allowAllWhenEmpty);
    if (!ready) {
      switchTab('settings');
      connectSSE();
      refreshStatus();
      setInterval(refreshStatus, 15000);
      // 🔴 外观必须在这一支里也应用（首启没配模型会走这里并 return）
      loadAppearance().then(applyAppearance).catch(() => {});
      syncPluginTabs();
      setInterval(syncPluginTabs, 20000);
      return;
    }
  } catch { /* 按默认流程走 */ }
  refreshStatus();
  setInterval(refreshStatus, 15000);
  connectSSE();
  // 启动即应用外观（皮肤 + 背景），避免先闪一下默认色
  loadAppearance().then(applyAppearance).catch(() => {});
  syncPluginTabs();                    // 按已装载插件渲染页签
  setInterval(syncPluginTabs, 20000);  // 装卸插件后页签跟着变
  loadSessions();
})();


// ══════════════════════════════════════════════════════════════
//  圣杯战争面板
// ══════════════════════════════════════════════════════════════
// 设计：这是**操作台**，不是玩家界面。
// 玩家在 QQ 里玩，主人在这里开局/发牌/结算。
// 圣杯战争操作哪个群：从聊天白名单的第一个群取（不再写死群号）。
// 换群只需改白名单，不用改代码。
/** 单人详情卡：从者数值、宝具、弱点、情报网 */
/** 规则手册：地点 / 职阶克制 / 行动耗时 */
// ══════════════════════════════════════════════════════════════
//  广告注入面板
// ══════════════════════════════════════════════════════════════
/**
 * 广告回复内容的单元格渲染（2026-10-21 修）。
 *
 * 原来写的是 `.slice(0, 60)` —— 直接把内容切掉，**且没有任何提示**。
 * 用户看到"小米mimo可以领取10元token赠送金额噢，点击：https://platform.xiaomimimo.com?r"
 * 就断了，以为是显示不全，实际是数据被前端砍了（真实 74 字符，只显示前 60）。
 *
 * 现在：**完整显示，不截断**。多条逐行，超长由 CSS 折行。
 */
// ══════════════════════════════════════════════════════════════
//  插件管理面板（2026-10-20 插件化）
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
//  技能管理（2026-10-21）
// ══════════════════════════════════════════════════════════════
//
// Skill = 按需加载的知识块。内核内置 / 插件注册 / 用户自定义三种来源。
// 这个页面只允许**编辑用户自定义的**（.md 文件），
// 内置与插件提供的只读 —— 它们随代码走，改了下次更新就被覆盖。

const SKILL_SOURCE_LABEL = {
  builtin: '内核内置',
  plugin: '插件提供',
  user: '自定义'
};

async function loadSkillsPage() {
  const el = $('#skills-page');
  if (!el) return;
  el.innerHTML = '<div class="muted" style="padding:16px">加载中…</div>';
  try {
    const d = await api('/api/skills');
    renderSkills(el, d.skills || []);
  } catch (e) {
    el.innerHTML = `<div class="card"><div class="error">加载失败：${esc(e.message)}</div></div>`;
  }
}

function renderSkills(el, skills) {
  const userCount = skills.filter((s) => s.source === 'user').length;
  const rows = skills.map((s) => {
    const editable = s.source === 'user';
    return `
      <tr>
        <td>
          <strong>${esc(s.name)}</strong>
          <div class="muted pl-meta"><span>${esc(s.id)}</span></div>
        </td>
        <td>
          ${s.author
            ? `<span class="skill-author">${esc(s.author)}</span>`
            : `<span class="skill-src skill-src-${esc(s.source || 'builtin')}">${esc(SKILL_SOURCE_LABEL[s.source] || s.source)}</span>`}
        </td>
        <td class="pl-desc">${esc(s.summary || '—')}</td>
        <td class="pl-desc">${esc(s.when || '—')}</td>
        <td style="white-space:nowrap">
          <button class="btn tiny" data-sk-view="${esc(s.id)}">查看</button>
          ${editable ? `<button class="btn tiny" data-sk-edit="${esc(s.id)}">编辑</button>
          <button class="btn tiny" data-sk-del="${esc(s.id)}">删除</button>` : ''}
        </td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="card">
      <h3>技能（Skill）</h3>
      <p class="muted">
        技能是<b>按需加载</b>的知识：提示词里只留一行索引，模型需要时才调 <code>load_skill</code> 读正文。
        这样长文档（规范、套路、领域资料）不会每轮都占 token。
      </p>
      <div class="row" style="margin-top:12px;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn primary" id="sk-new">新建技能</button>
        <span class="muted" style="font-size:12px">
          共 ${skills.length} 个（自定义 ${userCount} 个，其余随内核/插件）
        </span>
      </div>
    </div>

    <div class="card">
      <h3>全部技能</h3>
      <table class="table">
        <thead><tr><th>名称</th><th>作者</th><th>说明</th><th>何时用</th><th>操作</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">还没有技能</td></tr>'}</tbody>
      </table>
      <p class="muted" style="font-size:12px;margin-top:10px">
        🔒 内核内置与插件提供的技能<b>只读</b> —— 它们随代码走，改了下次更新会被覆盖。
        想定制可以新建一个同用途的自定义技能，模型会优先读你的。
      </p>
    </div>

    <div class="card">
      <h3>技能市场</h3>
      <p class="muted" style="font-size:13px">
        从市场装别人分享的 skill，或者把你的发上去。skill 是单个 md 文件，<b>装上即生效，不用重启</b>。
      </p>
      <div class="row" style="margin-top:10px;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn tiny" id="skm-browse">浏览市场</button>
        <button class="btn tiny" id="skm-updates">检查更新</button>
        <span id="skm-msg" class="muted" style="font-size:12px"></span>
      </div>
      <div id="skm-list" style="margin-top:12px"></div>
      <div id="skm-publish" style="margin-top:14px"></div>
    </div>

    <div class="card" id="sk-editor" style="display:none"></div>`;
}

/** 打开编辑器（id 为空 = 新建） */
async function openSkillEditor(id) {
  const box = $('#sk-editor');
  if (!box) return;
  box.style.display = '';
  box.innerHTML = '<div class="muted" style="padding:12px">加载中…</div>';

  let s = { id: '', name: '', summary: '', when: '', content: '', source: 'user' };
  if (id) {
    try {
      const r = await api('/api/skills/one?id=' + encodeURIComponent(id));
      if (!r.ok) throw new Error(r.error || '读取失败');
      s = r.skill;
    } catch (e) {
      box.innerHTML = `<div class="error" style="padding:12px">${esc(e.message)}</div>`;
      return;
    }
  }
  const readonly = s.source && s.source !== 'user';

  box.innerHTML = `
    <div class="row" style="align-items:center">
      <h3 style="margin:0">${id ? '编辑技能' : '新建技能'}</h3>
      <span style="flex:1"></span>
      <button class="btn tiny" id="sk-close">收起</button>
    </div>
    ${readonly ? `<p class="error" style="font-size:13px">这是${esc(SKILL_SOURCE_LABEL[s.source])}技能，只读。</p>` : ''}
    <div class="field-row" style="margin-top:12px">
      <div class="field">
        <label>id（唯一，只能字母数字下划线连字符）</label>
        <input type="text" id="sk-id" value="${esc(s.id)}" ${id ? 'disabled' : ''} placeholder="如 my-guide" />
      </div>
      <div class="field">
        <label>显示名称</label>
        <input type="text" id="sk-name" value="${esc(s.name)}" placeholder="如 代码风格" />
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>一句话说明（模型据此判断是什么）</label>
        <input type="text" id="sk-summary" value="${esc(s.summary || '')}" placeholder="如 本项目写代码的约定" />
      </div>
      <div class="field">
        <label>何时该用（写给模型看）</label>
        <input type="text" id="sk-when" value="${esc(s.when || '')}" placeholder="如 主人让你改代码时" />
      </div>
    </div>
    <div class="field" style="margin-top:10px">
      <label>正文（Markdown）</label>
      <textarea id="sk-content" rows="18" style="width:100%;font-family:var(--mono);font-size:12.5px"
        ${readonly ? 'readonly' : ''}>${esc(s.content || '')}</textarea>
    </div>
    ${readonly ? '' : `<div class="row" style="margin-top:12px;gap:8px">
      <button class="btn primary" id="sk-save">保存</button>
      <span class="muted" style="font-size:12px">保存后下一轮运行即生效，不用重启</span>
    </div>`}`;

  $('#sk-close')?.addEventListener('click', () => { box.style.display = 'none'; box.innerHTML = ''; });

  // 打开编辑器后滚到可见位置（2026-10-25）
  //
  // 编辑器在技能列表和技能市场下面，位置很靠下。之前渲染完不滚动，
  // 用户点了「编辑」看着页面没反应 —— 其实面板已经打开，只是还在视口外。
  // 这里用 requestAnimationFrame 等布局稳定后再滚，避免滚到旧位置。
  // 滚动到可见：分两次做，因为编辑器刚插入时高度还没定下来
  //   · 第一帧后先滚一次（让用户看到反应）
  //   · 100ms 后内容和图片/字体都排好了，再精确滚一次
  const scrollToEditor = () => {
    try {
      const page = $('#skills-page');
      if (page) {
        // 用相对容器的偏移，比 scrollIntoView 更可控（不依赖祖先滚动容器）
        const top = box.offsetTop - 12;
        page.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      } else {
        box.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    } catch {
      try { box.scrollIntoView(); } catch { /* 忽略 */ }
    }
  };

  requestAnimationFrame(scrollToEditor);
  setTimeout(scrollToEditor, 120);

  // 焦点给第一个**可编辑**的输入框（编辑已有技能时 #sk-id 是 disabled）
  requestAnimationFrame(() => {
    try {
      const first = [...box.querySelectorAll('input, textarea')]
        .find((el) => !el.disabled && !el.readOnly);
      if (first) first.focus({ preventScroll: true });
    } catch { /* 忽略 */ }
  });

  $('#sk-save')?.addEventListener('click', async () => {
    const newId = (id || $('#sk-id')?.value || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(newId)) return toast('id 只能用字母数字下划线连字符');
    const content = $('#sk-content')?.value || '';
    if (!content.trim()) return toast('正文不能为空');
    try {
      const r = await api('/api/skills/save', {
        method: 'POST',
        body: {
          id: newId,
          name: $('#sk-name')?.value || newId,
          summary: $('#sk-summary')?.value || '',
          when: $('#sk-when')?.value || '',
          content
        }
      });
      if (!r.ok) throw new Error(r.error || '保存失败');
      toast('已保存');
      loadSkillsPage();
    } catch (e) { toast('保存失败：' + e.message); }
  });
}

/** 技能页事件绑定 */
function bindSkillsEvents() {
  if (state.tab !== 'skills') return;

  // ── Skill 市场（2026-10-25）──
  const skmMsg = (s) => { const e = $('#skm-msg'); if (e) e.textContent = s; };
  const skmList = () => $('#skm-list');

  const renderMarket = (skills, installedIds) => {
    const box = skmList();
    if (!box) return;
    if (!skills.length) {
      box.innerHTML = '<div class="muted" style="font-size:12px">市场里还没有技能</div>';
      return;
    }
    box.innerHTML = `
      <table class="table">
        <thead><tr><th>名称</th><th>版本</th><th>说明</th><th>何时用</th><th>操作</th></tr></thead>
        <tbody>${skills.map((s) => `
          <tr>
            <td><strong>${esc(s.name)}</strong><div class="muted pl-meta"><span>${esc(s.id)}</span></div></td>
            <td style="font-size:12px">${esc(s.version || '—')}</td>
            <td class="pl-desc">${esc(s.summary || '—')}</td>
            <td class="pl-desc">${esc(s.when || '—')}</td>
            <td style="white-space:nowrap">
              <button class="btn tiny" data-skm-install="${esc(s.id)}">
                ${installedIds.has(s.id) ? '重装' : '安装'}
              </button>
            </td>
          </tr>`).join('')}</tbody>
      </table>`;
  };

  $('#skm-browse')?.addEventListener('click', async () => {
    skmMsg('加载中…');
    try {
      const [mkt, local] = await Promise.all([api('/api/skill-market/index'), api('/api/skills')]);
      if (!mkt.ok) { skmMsg('失败：' + (mkt.error || '未知')); return; }
      const installed = new Set((local.skills || []).filter((x) => x.source === 'user').map((x) => x.id));
      renderMarket(mkt.skills || [], installed);
      skmMsg(`市场 ${mkt.skills?.length || 0} 个技能`);
      // 重装 = 明确覆盖
      $$('[data-skm-install]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.dataset.skmInstall;
        const isRe = installed.has(id);
        if (isRe && !confirm(`本地已有 ${id}，覆盖它？`)) return;
        b.disabled = true; b.textContent = '安装中…';
        try {
          const r = await api('/api/skill-market/install', { method: 'POST', body: { id, overwrite: isRe } });
          if (!r.ok) { toast('安装失败：' + r.error); b.disabled = false; b.textContent = '安装'; return; }
          toast(`已安装 ${r.id} v${r.version}`);
          loadSkillsPage().then(bindSkillsEvents);
        } catch (e) { toast('安装失败：' + e.message); b.disabled = false; }
      }));
    } catch (e) { skmMsg('失败：' + e.message); }
  });

  $('#skm-updates')?.addEventListener('click', async () => {
    skmMsg('检查中…');
    try {
      const r = await api('/api/skill-market/updates');
      if (!r.ok) { skmMsg('失败：' + (r.error || '未知')); return; }
      if (!r.updates?.length) { skmMsg(`已装 ${r.installed} 个，都是最新`); return; }
      skmMsg(`${r.updates.length} 个可更新：` + r.updates.map((u) => `${u.id} ${u.local}→${u.remote}`).join('、'));
    } catch (e) { skmMsg('失败：' + e.message); }
  });

  // 发布区：只对作者显示
  (async () => {
    const box = $('#skm-publish');
    if (!box) return;
    let st;
    try { st = await api('/api/kernel/can-publish'); } catch { return; }
    if (!st?.author?.verified) return;

    const mine = (await api('/api/skills').catch(() => ({ skills: [] })))
      .skills.filter((s) => s.source === 'user');
    if (!mine.length) {
      box.innerHTML = '<div class="muted" style="font-size:12px">你还没有自定义技能。先「新建技能」，再回来发布。</div>';
      return;
    }
    box.innerHTML = `
      <div style="padding:12px 14px;border:1px solid var(--acc);border-radius:var(--r)">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">发布我的技能</div>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
          <div class="field" style="min-width:160px">
            <label class="muted" style="font-size:12px">选择技能</label>
            <select id="skp-id" style="width:100%">
              ${mine.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}（${esc(s.id)}）</option>`).join('')}
            </select>
          </div>
          <div class="field" style="min-width:100px">
            <label class="muted" style="font-size:12px">版本</label>
            <input id="skp-ver" value="1.0.0" style="width:100px" />
          </div>
          <button class="btn primary tiny" id="skp-go">发布到市场</button>
          <span id="skp-msg" class="muted" style="font-size:12px"></span>
        </div>
        <div class="muted" style="font-size:12px;margin-top:8px">
          发布前请确保技能文件里 frontmatter 有 <code>name</code> 和 <code>summary</code>。
        </div>
      </div>`;

    $('#skp-go')?.addEventListener('click', async () => {
      const id = $('#skp-id')?.value;
      const ver = $('#skp-ver')?.value || '1.0.0';
      const msg = (s) => { const e = $('#skp-msg'); if (e) e.textContent = s; };
      if (!id) return;
      if (!confirm(`发布技能 ${id} v${ver} 到市场？`)) return;
      msg('发布中…');
      try {
        const r = await api('/api/skill-market/publish', { method: 'POST', body: { id, version: ver } });
        if (!r.ok) return msg('失败：' + (r.error || '未知'));
        msg(`✅ 已发布 v${r.version}（市场共 ${r.total} 个）`);
        toast('技能已发布');
      } catch (e) { msg('失败：' + e.message); }
    });
  })();

  $('#sk-new')?.addEventListener('click', () => openSkillEditor(''));

  $$('[data-sk-view]').forEach((b) => b.addEventListener('click', () => openSkillEditor(b.dataset.skView)));
  $$('[data-sk-edit]').forEach((b) => b.addEventListener('click', () => openSkillEditor(b.dataset.skEdit)));
  $$('[data-sk-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`删除技能「${b.dataset.skDel}」？`)) return;
    try {
      const r = await api('/api/skills/delete', { method: 'POST', body: { id: b.dataset.skDel } });
      if (!r.ok) throw new Error(r.error || '删除失败');
      toast('已删除');
      loadSkillsPage();
    } catch (e) { toast('删除失败：' + e.message); }
  }));
}

async function loadPluginsPage() {
  const el = $('#plugins-page');
  if (!el) return;
  el.innerHTML = '<div class="muted">加载中…</div>';
  try {
    const data = await api('/api/plugins');
    renderPlugins(el, data);
  } catch (e) {
    el.innerHTML = `<div class="error">加载失败：${esc(e.message)}</div>`;
  }
}

function pluginStatusBadge(p) {
  if (p.status === 'enabled') return '<span class="badge badge-on">已启用</span>';
  if (p.status === 'failed') return '<span class="badge badge-off">装载失败</span>';
  return '<span class="badge badge-wait">已停用</span>';
}

function renderPlugins(el, data) {
  const plugins = Array.isArray(data.plugins) ? data.plugins : [];
  const modes = Array.isArray(data.exportModes) ? data.exportModes : [];
  const rows = plugins.map((p) => {
    const tools = (p.tools || []).length ? p.tools.map((t) => `<code>${esc(t)}</code>`).join(' ') : '<span class="muted">—</span>';
    const scopeCount = Object.keys((p.config && p.config.scopes) || {}).length;
    const d = p.data || {};
    const dataCell = d.exists && d.fileCount
      ? `<span title="运行数据">${esc(d.sizeText)} · ${d.fileCount} 文件</span>`
      : '<span class="muted">无</span>';
    // 启用/停用做成开关：比两个按钮更直观，且一眼看出当前状态
    const isOn = p.status === 'enabled';
    const toggle = `<label class="pl-switch" title="${isOn ? '点击停用' : '点击启用'}">
        <input type="checkbox" ${isOn ? 'checked' : ''} ${p.status === 'failed' ? 'disabled' : ''}
          data-pl-toggle="${esc(p.id)}" />
        <span class="pl-switch-track"><span class="pl-switch-knob"></span></span>
      </label>`;
    // 有配置面板的插件才显示「配置」按钮：
    //   ① 插件自己提供了 ui.js（mountPanel）—— 插件化后的标准做法
    //   ② 或内核里仍有残留面板（尚未迁移的插件）
    const hasPanel = !!PANEL_RENDERERS[p.id] || !!(p.ui || '');
    const ops = toggle
      + (hasPanel ? `<button class="btn tiny" data-pl-cfg="${esc(p.id)}">配置</button>` : '')
      + `<button class="btn tiny" data-pl-reload="${esc(p.id)}">重载</button>`
      + `<button class="btn tiny" data-pl-data="${esc(p.id)}">数据</button>`
      + `<button class="btn tiny" data-pl-export="${esc(p.id)}">导出</button>`
      + `<button class="btn tiny" data-pl-del="${esc(p.id)}">卸载</button>`;
    // 作者展示（2026-10-21）：从 manifest.author 取，没有就显示"—"
    const author = (p.author || '').trim();
    return `
    <tr>
      <td>
        <strong>${esc(p.name)}</strong>
        <div class="muted pl-meta">
          <span class="pl-author" title="作者">${author ? esc(author) : '—'}</span>
          <span class="pl-dot">·</span>
          <span>${esc(p.id)}</span>
          <span class="pl-dot">·</span>
          <span>v${esc(p.version)}</span>
        </div>
      </td>
      <td>${pluginStatusBadge(p)}</td>
      <td class="pl-desc" title="${esc(p.description || '')}">${esc(p.description || '')}</td>
      <td style="font-size:12px">${tools}</td>
      <td style="font-size:12px">${dataCell}</td>
      <td style="font-size:12px">${scopeCount ? scopeCount + ' 处覆盖' : '全局'}</td>
      <td style="white-space:nowrap">${ops}</td>
    </tr>
    ${p.lastError ? `<tr><td colspan="7" class="error" style="font-size:12px">最近错误：${esc(p.lastError)}</td></tr>` : ''}`;
  }).join('');

  el.innerHTML = `
    <div class="card">
      <h3>插件管理</h3>
      <p class="muted">基础功能（收发消息、模型、记忆、表情、识图、联网、人设切换、控制台）常驻内核，不在下表。
      下面全是附加功能，可装可卸、可导出导入 —— <strong>装卸不影响基础功能</strong>。</p>
      <div class="row" style="margin-top:12px;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn primary" id="pl-enable-all">一键启用全部</button>
        <button class="btn" id="pl-disable-all">一键停用全部</button>
        <label class="btn" style="cursor:pointer">导入插件包
          <input type="file" id="pl-import" accept=".gz,.tgz,.tar.gz" style="display:none">
        </label>
        <span class="spacer" style="flex:1"></span>
        <span class="muted" style="font-size:12px">
          已启用 <b>${plugins.filter((p) => p.status === 'enabled').length}</b> / ${plugins.length}
          ｜ 内核 API v${data.apiVersion}
        </span>
      </div>
    </div>

    <div class="card">
      <h3>已安装（${plugins.length}）</h3>
      <table class="table">
        <thead><tr><th>插件</th><th>状态</th><th>说明</th><th>工具</th><th>数据</th><th>作用域</th><th>操作</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="muted">还没有插件</td></tr>'}</tbody>
      </table>
    </div>

    <div class="card" id="pl-data-card" style="display:none"></div>`;

  const post = async (path, body) => {
    try {
      const r = await api(path, { method: 'POST', body: JSON.stringify(body) });
      if (r && r.ok === false) alert(r.error || '操作失败');
      else if (r && r.note) console.log('[plugins]', r.note);
      return r;
    } catch (e) {
      alert('失败：' + e.message);
      return null;
    } finally {
      loadPluginsPage();
    }
  };

  // 配置面板
  $$('[data-pl-cfg]').forEach((b) => b.addEventListener('click', () => openPluginPanel(b.dataset.plCfg)));

  // 行内开关：勾上=启用，取消=停用
  $$('[data-pl-toggle]').forEach((el) => el.addEventListener('change', async () => {
    const id = el.dataset.plToggle;
    const wantOn = el.checked;
    el.disabled = true;                       // 防连点
    const r = await post(wantOn ? '/api/plugins/enable' : '/api/plugins/disable', { id });
    if (r && r.ok === false) {
      el.checked = !wantOn;                   // 失败回滚开关状态
      alert(r.error || '操作失败');
    }
  }));

  // 全局一键
  const bulk = async (enable) => {
    const label = enable ? '启用' : '停用';
    if (!enable && !confirm('停用全部插件？\n\n机器人将只剩内核基础能力（收发消息/记忆/情感回复），' +
      '联网、识图、表情、圣杯战争等功能会全部不可用。\n\n可随时再一键启用。')) return;
    const btns = ['#pl-enable-all', '#pl-disable-all'].map((s) => $(s)).filter(Boolean);
    btns.forEach((b) => { b.disabled = true; });
    try {
      const r = await api('/api/plugins/bulk', { method: 'POST', body: JSON.stringify({ enable }) });
      if (!r.ok && r.note) alert(`${label}完成，但有失败：\n${r.note}`);
    } catch (e) {
      alert(`${label}失败：${e.message}`);
    } finally {
      btns.forEach((b) => { b.disabled = false; });
      loadPluginsPage();
    }
  };
  $('#pl-enable-all')?.addEventListener('click', () => bulk(true));
  $('#pl-disable-all')?.addEventListener('click', () => bulk(false));
  $$('[data-pl-reload]').forEach((b) => b.addEventListener('click', () => post('/api/plugins/reload', { id: b.dataset.plReload })));
  $$('[data-pl-del]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.plDel;
    const purge = confirm('卸载「' + id + '」\n\n点「确定」继续。\n下一步会问你要不要连数据一起删。');
    if (!purge) return;
    const purgeData = confirm('要连运行数据一起删除吗？\n\n· 确定 = 彻底清除（不可恢复）\n· 取消 = 保留数据，以后重装可继续用');
    post('/api/plugins/uninstall', { id, purgeData });
  }));

  // ── 数据盘点 / 清空 ──
  $$('[data-pl-data]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.plData;
    const card = $('#pl-data-card');
    if (!card) return;
    card.style.display = '';
    card.innerHTML = '<div class="muted">读取数据目录…</div>';
    try {
      const d = await api('/api/plugins/data?id=' + encodeURIComponent(id));
      const files = (d.files || []).map((f) => `<tr><td><code>${esc(f.name)}</code></td><td>${esc(f.sizeText)}</td></tr>`).join('');
      card.innerHTML = `
        <h3>「${esc(id)}」的数据</h3>
        <p class="muted" style="font-size:13px">
          ${d.exists
            ? `共 <b>${d.fileCount}</b> 个文件，<b>${esc(d.sizeText)}</b>。目录：<code>${esc(d.dir)}</code>`
            : '这个插件还没有产生运行数据。'}
        </p>
        ${d.exists && d.fileCount ? `<table class="table" style="margin-top:8px">
          <thead><tr><th>文件</th><th>大小</th></tr></thead><tbody>${files}</tbody></table>` : ''}
        <div style="margin-top:12px">
          <button class="btn" id="pl-data-clear" ${d.exists && d.fileCount ? '' : 'disabled'}>清空数据</button>
          <span class="muted" style="font-size:12px;margin-left:8px">清空只删运行数据，不动插件代码与配置</span>
        </div>`;
      $('#pl-data-clear')?.addEventListener('click', async () => {
        if (!confirm('清空「' + id + '」的全部运行数据？\n\n这不可恢复，但插件本身仍可正常使用。')) return;
        const r = await post('/api/plugins/data/clear', { id });
        if (r && r.ok) alert(r.note || '已清空');
      });
    } catch (e) {
      card.innerHTML = '<div class="error">读取失败：' + esc(e.message) + '</div>';
    }
  }));

  // ── 导出（三种模式）──
  $$('[data-pl-export]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.plExport;
    const lines = modes.map((m, i) => `${i + 1}. ${m.label}\n   ${m.desc}`).join('\n\n');
    const pick = prompt(`导出「${id}」，选一个模式（输入序号）：\n\n${lines}`, '1');
    if (!pick) return;
    const idx = Number(pick) - 1;
    const m = modes[idx];
    if (!m) return alert('序号不对');
    window.location.href = `/api/plugins/export?id=${encodeURIComponent(id)}&mode=${encodeURIComponent(m.id)}`;
  }));

  $('#pl-import')?.addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      // 分块转 base64：一次 apply 几 MB 会把调用栈打爆
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      const r = await api('/api/plugins/import', { method: 'POST', body: JSON.stringify({ base64: btoa(binary) }) });
      if (r.ok) alert('导入完成：' + (r.note || '')); else alert('导入失败：' + (r.error || ''));
    } catch (e) {
      alert('导入失败：' + e.message);
    }
    loadPluginsPage();
  });
}

// ══════════════════════════════════════════════════════════════
//  插件配置面板（2026-10-21）
// ══════════════════════════════════════════════════════════════
//
// 设计取舍：**内嵌在插件页，不给每个插件开顶栏 tab**。
// 理由：15 个插件各占一个顶栏页签会把导航挤爆；而用户的操作路径本来就是
// "打开插件页 → 找到那个插件 → 调它的设置"，内嵌正好顺路。
//
// 🔴 架构约束（2026-10-21）：**面板代码全部在插件自己的 ui.js 里**。
//    内核不保留任何插件映射，openPluginPanel() 按 manifest.ui 动态加载。
//    加/改插件面板只动 plugins/<id>/ui.js，内核零改动。
//
// 插件侧签名：export async function mountPanel(box, ctx)

// 插件配置面板已**全部迁到各自的 plugins/<id>/ui.js**（mountPanel）。
// 这个映射保留为空对象，仅为兼容 openPluginPanel 与 hasPanel 的判定逻辑。
// 新增插件面板请写 plugins/<id>/ui.js，不要往这里加。
const PANEL_RENDERERS = {};

/**
 * 插件配置弹窗容器（2026-10-21）
 *
 * 原来配置面板内嵌在插件页底部，点「配置」要滚到页尾 ——
 * 19 个插件的长列表里体验很差：跳走、丢位置、关掉还得滚回来。
 * 改成居中弹窗：不打断浏览位置，点背幕 / ESC / 收起按钮都能关。
 */
function ensurePluginModal() {
  let ov = document.getElementById('plugin-modal-overlay');
  if (ov) return ov;

  ov = document.createElement('div');
  ov.id = 'plugin-modal-overlay';
  ov.className = 'modal-overlay';
  ov.style.display = 'none';
  ov.innerHTML = `
    <div class="modal plugin-modal" role="dialog" aria-modal="true">
      <div class="pm-head">
        <span class="pm-title" id="pm-title">插件配置</span>
        <span style="flex:1"></span>
        <button class="btn tiny" id="pm-close">收起</button>
      </div>
      <div class="pm-body" id="pm-body"></div>
    </div>`;

  // 点背幕关闭（点内容区不关）
  ov.addEventListener('click', (e) => { if (e.target === ov) closePluginModal(); });
  // ESC 关闭
  ov._esc = (e) => { if (e.key === 'Escape') closePluginModal(); };
  document.body.appendChild(ov);
  return ov;
}

/** 打开弹窗并清空内容 */
function openPluginModal(title) {
  const ov = ensurePluginModal();
  const tEl = ov.querySelector('#pm-title');
  if (tEl) tEl.textContent = title || '插件配置';
  ov.querySelector('#pm-body').innerHTML = '';
  ov.style.display = 'flex';
  document.addEventListener('keydown', ov._esc);
  ov.querySelector('#pm-close').onclick = closePluginModal;
  return ov.querySelector('#pm-body');
}

/** 关闭弹窗 */
function closePluginModal() {
  const ov = document.getElementById('plugin-modal-overlay');
  if (!ov) return;
  ov.style.display = 'none';
  ov.querySelector('#pm-body').innerHTML = '';
  if (ov._esc) document.removeEventListener('keydown', ov._esc);
}

/** 打开某个插件的配置面板（弹窗展示） */
async function openPluginPanel(id) {
  // 先取插件名做标题，取不到就用 id
  let title = id;
  try {
    const d0 = await api('/api/plugins');
    const meta = (d0.plugins || []).find((x) => x.id === id);
    if (meta?.name) title = `${meta.name} · 配置`;
  } catch { /* 忽略，用 id 当标题 */ }

  const box = openPluginModal(title);
  box.innerHTML = '<div class="muted" style="padding:16px">加载中…</div>';

  // ── 通用「局部重挂」工厂（2026-10-26）──
  //
  // 插件面板里点「刷新」时，希望只重挂自己那块，不要 location.reload()
  // 把整个控制台白屏重载（会话列表、滚动位置全丢）。
  //
  // 🔴 关键：**重挂后的新 ctx 里必须还能拿到 remount**，
  //    否则第二次点刷新又会退化成整页重载。所以这里递归注入自己。
  const panelRemount = async (pid, entry, container) => {
    try {
      const fresh = await loadPluginUi(pid, entry || 'ui.js');
      const m2 = fresh?.mountPanel || fresh?.mount;
      if (typeof m2 !== 'function') return false;
      container.innerHTML = '';
      const ctx2 = { ...pluginUiContext(pid), openPluginPanel };
      ctx2.remount = () => panelRemount(pid, entry, container);
      await m2(container, ctx2);
      return true;
    } catch (e) {
      console.warn('[plugin-ui] remount 失败', pid, e);
      return false;
    }
  };

  // ① 优先用**插件自己提供的**配置面板（plugins/<id>/ui.js 的 mountPanel）
  //    这是插件化要求：插件的界面归插件，内核不认识具体插件。
  try {
    const d = await api('/api/plugins');
    const tab = (d.tabs || []).find((x) => x.pluginId === id);
    const entry = tab?.file || '';
    if (entry) {
      const mod = await loadPluginUi(id, entry);
      // ① 有 mountPanel 就用它（配置面板形态）
      if (mod && typeof mod.mountPanel === 'function') {
        box.innerHTML = '';
        const ctx1 = { ...pluginUiContext(id), openPluginPanel };
        ctx1.remount = () => panelRemount(id, entry, box);
        await mod.mountPanel(box, ctx1);
        return;
      }
      // ② 只有 mount（顶栏页签形态，如 grail / ad-inject）—— 也允许在插件页内展开，
      //    这样用户在插件页也能直接调它的设置，不必切页签。
      if (mod && typeof mod.mount === 'function') {
        box.innerHTML = '<div id="pl-inline-mount"></div>';
        const ctx2 = { ...pluginUiContext(id), openPluginPanel };
        ctx2.remount = () => panelRemount(id, entry, $('#pl-inline-mount'));
        await mod.mount($('#pl-inline-mount'), ctx2);
        return;
      }
    }
  } catch (e) {
    console.warn(`[plugin-ui] ${id} mountPanel 失败，回退内核面板`, e);
  }

  // ② 回退：内核里仍保留的少量面板（尚未迁移的插件）
  const fn = PANEL_RENDERERS[id];
  if (!fn) {
    box.innerHTML = `<div class="card"><h3>${esc(id)}</h3>
      <p class="muted">这个插件没有独立配置面板，用上方的启用开关与「数据」「导出」即可管理。</p></div>`;
    return;
  }
  try {
    await fn(box, { id });
  } catch (e) {
    box.innerHTML = `<div class="card"><h3>${esc(id)}</h3>
      <div class="error">加载失败：${esc(e.message)}</div></div>`;
  }
}

/** 面板外壳：统一标题 + 关闭按钮 */
function panelShell(id, title, bodyHtml, hint) {
  return `
    <div class="card pl-panel-card">
      <div class="row" style="align-items:center;gap:8px">
        <h3 style="margin:0">${esc(title)}</h3>
        <span class="spacer" style="flex:1"></span>
        <button class="btn tiny" data-panel-close="1">收起</button>
      </div>
      ${hint ? `<p class="muted" style="font-size:13px;margin:6px 0 0">${hint}</p>` : ''}
      <div class="pl-panel-body">${bodyHtml}</div>
    </div>`;
}

/** 绑定「收起」 */
function bindPanelClose(box) {
  box.querySelectorAll('[data-panel-close]').forEach((b) => b.addEventListener('click', () => {
    // 面板现在渲染在弹窗里，「收起」应当关掉整个弹窗，而不是留一个空壳
    if (document.getElementById('plugin-modal-overlay')) { closePluginModal(); return; }
    box.style.display = 'none';
    box.innerHTML = '';
  }));
}

/** 通用：读插件配置（走 /api/plugins 里已经带出来的 config） */
async function pluginConfigOf(id) {
  const d = await api('/api/plugins');
  const p = (d.plugins || []).find((x) => x.id === id);
  return p?.config || {};
}

/** 通用：保存插件配置片段 */
async function savePluginConfig(id, patch) {
  const r = await api('/api/plugins/config', {
    method: 'POST', body: JSON.stringify({ id, patch })
  });
  if (r && r.ok === false) throw new Error(r.error || '保存失败');
  return r;
}

// ── 群友黑名单 ────────────────────────────────────────────────

// ── 广告自动禁言 ──────────────────────────────────────────────

// ── 群友福利发放 ──────────────────────────────────────────────

// ── 群管理 ────────────────────────────────────────────────────

// ── 联网搜索 ──────────────────────────────────────────────────

// ── 语音说与听 ────────────────────────────────────────────────

// ── 识图 ──────────────────────────────────────────────────────

// ── 轻量记忆 ──────────────────────────────────────────────────

// ── 定时任务与课表 ────────────────────────────────────────────

// ── 表情包 ────────────────────────────────────────────────────

// ── 学习模式与知识库 ──────────────────────────────────────────

// ── 教师模式 ──────────────────────────────────────────────────

// ── 主人专属工具 ──────────────────────────────────────────────


// ── 胜者奖励配置（2026-10-21）──────────────────────────────────
//
// 需求：奖励不能写死，要能在面板里填【名字】和【内容】。
//
// 设计要点（安全）：
//   · 名字  → 公开。会写进邀请文案和终局公告。
//   · 内容  → 私密。**只私聊发给胜者**，不进群公告、不回显到面板。
//     内容通常是兑换码/API key，公开等于当场作废。
//   · 面板里内容框用 type=password，只显示"已设置/未设置"，
//     不回显原文 —— 与密钥零披露纪律一致。
/** 拉取当前奖励配置（内容不回显，只报有没有） */
// ── 候选名单（2026-10-21）──────────────────────────────────────
//
// 需求：预选者名单要能在面板里看到，且管理员能手动指定邀请谁。
//
// 设计：
//   · 表格列出群成员 + 发言数 + 活跃档 + 当前状态
//   · 可勾选 → 「邀请选中的人」按钮（绕过活跃度算法，按管理员意志发）
//   · 状态用中文标签，一眼看出这人能不能邀