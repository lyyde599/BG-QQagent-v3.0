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

async function loadPluginUi(pluginId, entryFile) {
  if (!entryFile) return null;
  if (pluginUiCache.has(pluginId)) return pluginUiCache.get(pluginId);
  try {
    const url = `/plugin-ui/${encodeURIComponent(pluginId)}/${entryFile}`;
    const mod = await import(/* @vite-ignore */ url);
    pluginUiCache.set(pluginId, mod);
    return mod;
  } catch (e) {
    console.error(`[plugin-ui] ${pluginId} 加载失败:`, e);
    toast(`插件「${pluginId}」界面加载失败：${e.message}`);
    pluginUiCache.set(pluginId, null);
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
  if (!entry) {
    try {
      const d = await api('/api/plugins');
      const tab = (d.tabs || []).find((x) => x.id === tabId);
      if (tab) { pluginId = tab.pluginId || tabId; entry = tab.file || ''; }
    } catch { /* ignore */ }
  }
  if (!entry) {
    root.innerHTML = `<div class="muted" style="padding:16px">插件「${esc(pluginId)}」没有提供界面文件（manifest.ui 为空）。</div>`;
    return false;
  }

  const mod = await loadPluginUi(pluginId, entry);
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
    if (!status.onebot?.connected) setLoadingStatus('SnowLuma 已就绪，正在连接 OneBot…');
    else setLoadingStatus(`OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}，即将进入控制台…`);
    // 服务已可达，无需等到 OneBot 完全连上即可进入控制台（体检卡会继续提示）
    return true;
  } catch (e) {
    if (Date.now() - startedAt > 45000) {
      setLoadingStatus('启动超时。请确认项目内 snowluma 文件夹完整，或到设置页手动启动 SnowLuma。');
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
  checks.push({ ok: !!obOk, label: obOk ? `OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}` : 'OneBot（SnowLuma）未连接 —— 请到 SnowLuma 页签启动', fix: obOk ? null : 'snowluma-tab' });
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
    html = '🔌 OneBot（SnowLuma）还没连上：请确认 SnowLuma 已启动，且设置里的 WS/HTTP 地址正确。';
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
    $('#usage-label').textContent = `今日：${u.runs} 次运行 · ${fmtTokens(u.totalTokens)}${u.cost ? ` · ¥${u.cost.toFixed(2)}` : ''}`;
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
      <div class="snowluma-head">
        <h2>SnowLuma（OneBot 网关）</h2>
        <div class="snowluma-qr" id="sl-qr-panel"></div>
      </div>
      <div class="sl-login" id="sl-login-panel"></div>
      <!-- 账号总览与一键切号（2026-09-16 新增，见 renderAccountsPanel） -->
      <div class="sl-accounts" id="sl-accounts-panel"></div>
      <div class="snowluma-state-row">
        <span class="dot" id="sl-dot-run"></span>
        <span>SnowLuma：<strong id="sl-txt-run"></strong></span>
        <span class="muted" id="sl-txt-pid"></span>
        <span class="muted" id="sl-txt-mode"></span>
      </div>
      <div class="snowluma-state-row">
        <span class="dot" id="sl-dot-ob"></span>
        <span>OneBot：<strong id="sl-txt-ob"></strong></span>
        <span class="muted" id="sl-txt-obws"></span>
      </div>
      <div class="snowluma-state-row muted"><span id="sl-txt-dir"></span></div>
      <div class="snowluma-state-row">
        <span>WebUI：</span>
        <span id="sl-webui-slot"></span>
      </div>
      <div class="snowluma-actions">
        <button class="btn btn-primary" id="sl-start-btn">启动 SnowLuma</button>
        <button class="btn btn-danger" id="sl-stop-btn">关闭 SnowLuma</button>
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
      setText('sl-hint', r.alreadyRunning ? 'SnowLuma 已经在运行 ✓' : (r.ok ? '已启动，日志见下方。' : ('启动失败：' + r.error)));
    } catch (e) { setText('sl-hint', '启动失败：' + e.message); }
    setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
  });

  slEl('sl-stop-btn')?.addEventListener('click', async () => {
    const btn = slEl('sl-stop-btn');
    btn.disabled = true; btn.textContent = '关闭中…';
    setText('sl-hint', '');
    try {
      await api('/api/snowluma/stop', { method: 'POST', body: '{}' });
      setText('sl-hint', '已请求关闭 SnowLuma。');
    } catch (e) { setText('sl-hint', '关闭失败：' + e.message); }
    setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
  });

  slEl('sl-refresh-btn')?.addEventListener('click', () => loadSnowlumaPage());
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
  slLoginMsg('正在快速登录 ' + uin + ' …');
  try {
    const r = await api('/api/snowluma/login/set-quick', { method: 'POST', body: JSON.stringify({ uin }) });
    if (!r.ok) return slLoginMsg('快速登录失败：' + r.error, 'err');
    slLoginMsg('已请求快速登录，请稍候观察状态…', 'ok');
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
async function renderSnowlumaQr(connectedHint, selfHint) {
  const box = slEl('sl-qr-panel');
  if (!box) return;

  const showLoggedIn = (nick, uid) => {
    if (SL.loggedIn === true) return;
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
    SL.loggedIn = false;

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
        + '<div class="sl-qr-hint" id="sl-qr-hint"></div>';
      SL.qrAt = r.qrAt;
    } else if (r.qrAt && r.qrAt !== SL.qrAt) {
      SL.qrAt = r.qrAt;                    // 仅在 NapCat 换码时换图，避免闪烁
      img.src = '/api/snowluma/qr.png?t=' + Date.now();
    }
    setText('sl-qr-hint', hint);
    startSnowlumaQrTimer();
  } catch (e) {
    if (!box.querySelector('.sl-qr-empty')) {
      box.innerHTML = '<div class="sl-qr-empty">二维码加载失败<br><span class="muted">' + esc(e.message) + '</span></div>';
    }
  }
}

function startSnowlumaQrTimer() {
  if (SL.qrTimer) return;
  SL.qrTimer = setInterval(() => {
    if (state.tab !== 'snowluma') return;
    if (SL.loggedIn === true) { stopSnowlumaQrTimer(); return; }
    renderSnowlumaQr(false, null);
  }, 5000);
}
function stopSnowlumaQrTimer() {
  if (SL.qrTimer) { clearInterval(SL.qrTimer); SL.qrTimer = null; }
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

      const webSlot = slEl('sl-webui-slot');
      if (webSlot) {
        const want = _webui
          ? ('<button class="btn btn-small" id="sl-open-webui-btn" title="在浏览器中打开 SnowLuma 控制台">' + esc(_webui) + '</button>')
          : '<span class="muted">等待 SnowLuma 启动后自动识别…</span>';
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
        const label = _running ? '已运行' : '启动 SnowLuma';
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
      extra = ' <button class="btn btn-small" id="hc-goto-snowluma">前往 SnowLuma 页签</button>';
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
async function syncPluginTabs() {
  const holder = $('#plugin-tabs');
  if (!holder) return;
  let tabs = [];
  try {
    const d = await api('/api/plugins');
    // 只保留"要占顶栏"的插件页签；inline 的收在插件页里渲染
    tabs = (d.tabs || []).filter((t) => t.inline !== true);
  } catch { tabs = []; }

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
  const alive = new Set(tabs.map((t) => t.id));
  $$('[id^="view-"]').forEach((v) => {
    const id = v.id.slice(5);
    const builtin = ['sessions', 'chats', 'snowluma', 'plugins', 'settings'];
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
function dispatchTabLoad(name) {
  // ── 内核自带的页签 ──
  if (name === 'sessions') return loadSessions();
  if (name === 'chats') return loadChats();
  if (name === 'snowluma') return loadSnowlumaPage();
  if (name === 'settings') return loadSettings();
  if (name === 'plugins') return loadPluginsPage();

  // ── 插件页签（2026-10-21）──
  // 内核**不再认识任何具体插件**。页签内容由插件自己的 ui.js 提供，
  // 通过 mountPluginUi() 动态 import。
  // 新增/修改插件界面只动 plugins/<id>/ui.js，内核零改动。
  const root = $(`#plugin-view-${name}`);
  if (root) return mountPluginUi(name, root);
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
    ['desktop', '桌面端'],
    ['onebot', 'OneBot（SnowLuma）']
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
    onebot: () => renderOnebotSection(c)
  };
  const render = sections[sec] || sections.api;
  const saveBar = `
    <div class="save-bar">
      <button class="btn btn-primary" id="save-cfg-btn">保存设置</button>
      <span id="cfg-save-result" class="muted"></span>
    </div>`;
  return `
    ${saveBar}
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
          <input type="text" id="cfg-baseurl" readonly value="${esc(c.api.baseUrl)}" style="flex:1" />
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
  return `
    <h3 id="settings-allow">聊天白名单</h3>
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
    <h3 id="settings-onebot">OneBot（SnowLuma）</h3>
    <div class="hint" style="margin-bottom:10px">SnowLuma 的启动、关闭与日志已移动到顶部「SnowLuma」页签。此处只保留连接配置。</div>
    <div class="field"><label>SnowLuma 程序目录（留空 = 自动使用项目内 snowluma/ 文件夹）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-snowlumadir" value="${esc(c.snowluma.dir || '')}" style="flex:1" />
        <button class="btn btn-small" id="open-snowluma-btn">打开文件夹</button>
      </div>
      <div class="hint" id="snowluma-hint"></div></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-snowlumalaunch" ${c.snowluma.autoLaunch ? 'checked' : ''} />
      <label for="cfg-snowlumalaunch">QQ Agent 启动时自动拉起 SnowLuma（未运行时）</label></div>
    <div class="field-row">
      <div class="field"><label>WebSocket 地址（收消息）</label><input type="text" id="cfg-wsurl" value="${esc(c.snowluma.wsUrl)}" /></div>
      <div class="field"><label>HTTP 地址（发消息）</label><input type="text" id="cfg-httpurl" value="${esc(c.snowluma.httpUrl)}" /></div>
      <div class="field"><label>WebSocket 令牌</label><input type="password" id="cfg-obtoken" value="${esc(c.snowluma.accessToken || '')}" /></div>
      <div class="field"><label>HTTP 令牌（与 WS 不同时填；SnowLuma 默认分开）</label><input type="password" id="cfg-obhttptoken" value="${esc(c.snowluma.httpAccessToken || '')}" /></div>
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
    $('#pick-result').textContent = isGroups ? '没拉到群列表（检查 SnowLuma）' : '没拉到好友列表';
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
    patch.api = {
      vision: chk('#cfg-vision', c.api.vision !== false),
      temperature: Number(val('#cfg-temperature', c.api.temperature)) || 0.8,
      maxRounds: Number(val('#cfg-maxrounds', c.api.maxRounds)) || 12
    };
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
      syncPluginTabs();
      setInterval(syncPluginTabs, 20000);
      return;
    }
  } catch { /* 按默认流程走 */ }
  refreshStatus();
  setInterval(refreshStatus, 15000);
  connectSSE();
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
    return `
    <tr>
      <td><strong>${esc(p.name)}</strong><div class="muted" style="font-size:12px">${esc(p.id)} · v${esc(p.version)}</div></td>
      <td>${pluginStatusBadge(p)}</td>
      <td class="muted" style="font-size:12px">${esc(p.description || '').slice(0, 70)}</td>
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

    <div id="pl-panel" style="display:none"></div>
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
// 每个面板 = 独立的 async 渲染函数，签名统一：
//   render<XxxPanel>(box, ctx)  —— box 是要填充的容器
// 只有 grail / ad-inject 还保留顶栏 tab（它们体量大、是主功能）。

const PANEL_RENDERERS = {
  'blacklist': renderBlacklistPanel,
  'anti-ad': renderAntiAdPanel,
  'group-manager': renderGroupManagerPanel,
  'websearch': renderWebsearchPanel,
  'voice': renderVoicePanel,
  'vision': renderVisionPanel,
  'memory': renderMemoryPanel,
  'schedule': renderSchedulePanel,
  'sticker': renderStickerPanel,
  'study': renderStudyPanel,
  'teacher': renderTeacherPanel,
  'master-tools': renderMasterToolsPanel
};

/** 打开某个插件的配置面板（在插件页内展开） */
async function openPluginPanel(id) {
  const box = $('#pl-panel');
  if (!box) return;
  box.style.display = '';
  box.innerHTML = '<div class="muted" style="padding:16px">加载中…</div>';
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  // ① 优先用**插件自己提供的**配置面板（plugins/<id>/ui.js 的 mountPanel）
  //    这是插件化要求：插件的界面归插件，内核不认识具体插件。
  try {
    const d = await api('/api/plugins');
    const tab = (d.tabs || []).find((x) => x.pluginId === id);
    const entry = tab?.file || '';
    if (entry) {
      const mod = await loadPluginUi(id, entry);
      if (mod && typeof mod.mountPanel === 'function') {
        box.innerHTML = '';
        await mod.mountPanel(box, { ...pluginUiContext(id), openPluginPanel });
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
async function renderBlacklistPanel(box, ctx) {
  const d = await api('/api/blacklist');
  const levels = d.levels || [];
  const rows = (d.entries || []).map((e) => `
    <tr>
      <td><code>${esc(e.userId)}</code></td>
      <td>${esc(e.levelLabel || e.level)}</td>
      <td class="muted" style="font-size:12px">${e.groupId ? '群 ' + esc(e.groupId) : '全群'}</td>
      <td class="muted" style="font-size:12px">${esc(e.note || '')}</td>
      <td><button class="btn tiny" data-bl-del="${esc(e.userId)}" data-bl-gid="${esc(e.groupId || '')}">移除</button></td>
    </tr>`).join('');

  box.innerHTML = panelShell('blacklist', '群友黑名单', `
    <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <input id="bl-uid" placeholder="QQ 号" style="width:140px" />
      <select id="bl-level" class="gr-select" style="min-width:120px">
        ${levels.map((l) => `<option value="${esc(l.id)}" title="${esc(l.desc)}">${esc(l.label)}</option>`).join('')}
      </select>
      <input id="bl-gid" placeholder="群号（留空=全群）" style="width:160px" />
      <input id="bl-note" placeholder="备注原因" style="width:180px" />
      <button class="btn primary" id="bl-add">加入</button>
    </div>
    <div class="pl-level-desc muted" style="font-size:12px;line-height:1.8;margin-bottom:10px">
      ${levels.map((l) => `· <b>${esc(l.label)}</b>：${esc(l.desc)}`).join('<br>')}
    </div>
    <table class="table">
      <thead><tr><th>QQ</th><th>级别</th><th>范围</th><th>备注</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">名单为空</td></tr>'}</tbody>
    </table>`, '三级语义：静默=不回复 / 屏蔽=连线都不收 / 驱逐=自动踢出群');

  bindPanelClose(box);
  $('#bl-add')?.addEventListener('click', async () => {
    const userId = $('#bl-uid').value.trim();
    if (!/^\d{4,}$/.test(userId)) return alert('QQ 号必须是数字');
    try {
      await api('/api/blacklist/entry', {
        method: 'POST',
        body: JSON.stringify({
          userId,
          level: $('#bl-level').value,
          groupId: $('#bl-gid').value.trim(),
          note: $('#bl-note').value.trim()
        })
      });
      openPluginPanel('blacklist');
    } catch (e) { alert(e.message); }
  });
  box.querySelectorAll('[data-bl-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`把 ${b.dataset.blDel} 移出黑名单？`)) return;
    try {
      await api('/api/blacklist/remove', {
        method: 'POST',
        body: JSON.stringify({ userId: b.dataset.blDel, groupId: b.dataset.blGid })
      });
      openPluginPanel('blacklist');
    } catch (e) { alert(e.message); }
  }));
}

// ── 广告自动禁言 ──────────────────────────────────────────────
async function renderAntiAdPanel(box, ctx) {
  const d = await api('/api/anti-ad');
  const recent = (d.recent || []).slice(0, 8).map((r) =>
    `<li>· ${new Date(r.at).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })} ${esc(r.type)} ${esc(r.reason || r.groupId || '')}</li>`
  ).join('');

  box.innerHTML = panelShell('anti-ad', '广告自动禁言', `
    <div class="row" style="gap:16px;flex-wrap:wrap">
      <label class="switch-row"><input type="checkbox" id="aa-dry" ${d.dryRun ? 'checked' : ''} />
        <span>演练模式（只记录不处罚）</span></label>
      <label>禁言时长（秒）<input type="number" id="aa-sec" value="${d.muteSeconds || 600}" style="width:100px" /></label>
      <label>同一人冷却（分钟）<input type="number" id="aa-cool" value="${Math.round((d.cooldownMs || 1800000) / 60000)}" style="width:90px" /></label>
      <button class="btn primary" id="aa-save">保存</button>
    </div>
    <div class="row" style="gap:24px;margin-top:14px;font-size:13px">
      <span>扫描 <b>${d.stats?.scanned ?? 0}</b></span>
      <span>候选 <b>${d.stats?.candidates ?? 0}</b></span>
      <span>已禁言 <b>${d.stats?.muted ?? 0}</b></span>
      <span>保护跳过 <b>${d.stats?.skippedProtected ?? 0}</b></span>
    </div>
    <div style="margin-top:12px;font-size:12px" class="muted">
      <b>最近记录</b><br>${recent || '暂无'}</div>`,
    '关键词预筛 → 模型复核 → 代码执行禁言。模型只判断"是不是广告"，处罚始终由代码按规则执行。');

  bindPanelClose(box);
  $('#aa-save')?.addEventListener('click', async () => {
    try {
      await api('/api/anti-ad/config', {
        method: 'POST',
        body: JSON.stringify({
          dryRun: $('#aa-dry').checked,
          muteSeconds: Number($('#aa-sec').value),
          cooldownMs: Number($('#aa-cool').value) * 60000
        })
      });
      openPluginPanel('anti-ad');
      alert('已保存');
    } catch (e) { alert(e.message); }
  });
}

// ── 群友福利发放 ──────────────────────────────────────────────

// ── 群管理 ────────────────────────────────────────────────────
async function renderGroupManagerPanel(box, ctx) {
  const cfg = await pluginConfigOf('group-manager');
  box.innerHTML = panelShell('group-manager', '群管理', `
    <div class="row" style="gap:16px;flex-wrap:wrap">
      <label class="switch-row"><input type="checkbox" id="gm-welcome" ${cfg.welcomeEnabled !== false ? 'checked' : ''} />
        <span>新人入群自动迎新</span></label>
      <label class="switch-row"><input type="checkbox" id="gm-friend" ${cfg.autoApproveFriend ? 'checked' : ''} />
        <span>自动同意好友申请</span></label>
      <label class="switch-row"><input type="checkbox" id="gm-group" ${cfg.autoApproveGroup ? 'checked' : ''} />
        <span>自动同意入群申请</span></label>
    </div>
    <div style="margin-top:12px">
      <label class="muted" style="font-size:12px">迎新文案（{userId} 会被替换成 @对方，{nickname} 是机器人昵称）</label>
      <textarea id="gm-tpl" rows="5" style="width:100%;margin-top:4px">${esc(cfg.welcomeTemplate || '')}</textarea>
    </div>
    <div class="row" style="gap:8px;margin-top:8px">
      <label class="muted" style="font-size:12px">拒绝名单（QQ 号，逗号分隔）</label>
    </div>
    <input id="gm-deny" value="${esc((cfg.denyUsers || []).join(','))}" style="width:100%" />
    <button class="btn primary" id="gm-save" style="margin-top:12px">保存</button>`,
    '自动同意默认关闭 —— 开启前请确认你知道会放进来什么人');

  bindPanelClose(box);
  $('#gm-save')?.addEventListener('click', async () => {
    try {
      await savePluginConfig('group-manager', {
        welcomeEnabled: $('#gm-welcome').checked,
        autoApproveFriend: $('#gm-friend').checked,
        autoApproveGroup: $('#gm-group').checked,
        welcomeTemplate: $('#gm-tpl').value,
        denyUsers: $('#gm-deny').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      });
      alert('已保存');
    } catch (e) { alert(e.message); }
  });
}

// ── 联网搜索 ──────────────────────────────────────────────────
async function renderWebsearchPanel(box, ctx) {
  const d = await api('/api/websearch/status');
  box.innerHTML = panelShell('websearch', '联网搜索', `
    <div class="row" style="gap:16px;flex-wrap:wrap">
      <label class="switch-row"><input type="checkbox" id="ws-on" ${d.enabled ? 'checked' : ''} />
        <span>启用 web_search / web_fetch</span></label>
    </div>
    <div class="row" style="gap:12px;margin-top:12px;flex-wrap:wrap">
      <label>搜索引擎
        <select id="ws-provider" class="gr-select" style="min-width:200px">
          <option value="auto" ${d.provider === 'auto' ? 'selected' : ''}>自动（优先 AnySearch，失败回退 Bing）</option>
          <option value="anysearch" ${d.provider === 'anysearch' ? 'selected' : ''}>只用 AnySearch</option>
          <option value="bing" ${d.provider === 'bing' ? 'selected' : ''}>只用 Bing 抓取</option>
        </select>
      </label>
      <label>结果条数 <input type="number" id="ws-max" value="${d.maxResults || 8}" style="width:80px" /></label>
      <button class="btn primary" id="ws-save">保存</button>
    </div>
    <div style="margin-top:14px;font-size:13px">
      <b>AnySearch Key</b>：${d.keyCount > 0
        ? `${d.keyCount} 个已配置（${d.keyTails.map(esc).join('、')}）`
        : (d.envAvailable ? '通过环境变量提供' : '<span class="error">未配置（会回退 Bing）</span>')}
    </div>
    <p class="muted" style="font-size:12px;margin-top:8px">
      Key 原文不在面板显示，也不写回配置 —— 需要更换请直接编辑 data/config.json 或环境变量。</p>`,
    'Key 只显示尾号；这是密钥零披露纪律');

  bindPanelClose(box);
  $('#ws-save')?.addEventListener('click', async () => {
    try {
      await savePluginConfig('websearch', {
        provider: $('#ws-provider').value,
        maxResults: Number($('#ws-max').value) || 8
      });
      // enabled 在内核 config.webSearch 上（不是插件配置）
      const cfg = await api('/api/config');
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ webSearch: { ...(cfg.webSearch || {}), enabled: $('#ws-on').checked } })
      });
      alert('已保存');
    } catch (e) { alert(e.message); }
  });
}

// ── 语音说与听 ────────────────────────────────────────────────
async function renderVoicePanel(box, ctx) {
  const d = await api('/api/voice/status');
  const c = d.config || {};
  const env = d.env || {};
  const okEnv = env.ffmpeg;
  box.innerHTML = panelShell('voice', '语音（说 / 听）', `
    <div class="row" style="gap:12px;flex-wrap:wrap;font-size:13px;margin-bottom:12px">
      <span>Python：<code>${esc(env.python || '?')}</code></span>
      <span>venv：${env.hasVenv ? '✅ 已有' : '<span class="muted">未建（用系统 python3）</span>'}</span>
      <span>ffmpeg：${okEnv ? '✅' : '<span class="error">❌ 未安装</span>'}</span>
    </div>
    ${!okEnv ? '<p class="error" style="font-size:13px">缺 ffmpeg，语音转码会失败。安装：<code>sudo apt install -y ffmpeg</code></p>' : ''}
    <div class="row" style="gap:12px;flex-wrap:wrap">
      <label>音色
        <select id="vo-voice" class="gr-select" style="min-width:220px">
          ${['zh-CN-XiaoxiaoNeural:女·温暖', 'zh-CN-XiaoyiNeural:女·活泼', 'zh-CN-YunxiNeural:男·阳光', 'zh-CN-YunyangNeural:男·播报'].map((o) => {
            const [v, label] = o.split(':');
            return `<option value="${v}" ${c.ttsVoice === v ? 'selected' : ''}>${label}（${v}）</option>`;
          }).join('')}
        </select>
      </label>
      <label>语速 <input id="vo-rate" value="${esc(c.ttsRate || '+0%')}" style="width:80px" /></label>
      <label>识别模型
        <select id="vo-model" class="gr-select">
          ${['tiny', 'base', 'small', 'medium'].map((m) => `<option value="${m}" ${c.sttModel === m ? 'selected' : ''}>${m}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="row" style="gap:16px;margin-top:12px">
      <label class="switch-row"><input type="checkbox" id="vo-auto" ${c.autoTranscribe ? 'checked' : ''} />
        <span>自动转写群友语音</span></label>
    </div>
    <div class="row" style="gap:8px;margin-top:12px">
      <button class="btn primary" id="vo-save">保存</button>
      <button class="btn" id="vo-test">试合成一句</button>
      <span id="vo-test-out" class="muted" style="font-size:12px"></span>
    </div>
    <p class="muted" style="font-size:12px;margin-top:10px">
      依赖不随插件包分发。安装：<br>
      <code>python3 -m venv plugins/voice/.venv &amp;&amp; plugins/voice/.venv/bin/pip install edge-tts faster-whisper "av&lt;13"</code></p>`,
    '说：文字→语音（NapCat 自动转 silk）；听：语音→文字（本地 whisper，不出机器）');

  bindPanelClose(box);
  $('#vo-save')?.addEventListener('click', async () => {
    try {
      await savePluginConfig('voice', {
        ttsVoice: $('#vo-voice').value,
        ttsRate: $('#vo-rate').value,
        sttModel: $('#vo-model').value,
        autoTranscribe: $('#vo-auto').checked
      });
      alert('已保存');
    } catch (e) { alert(e.message); }
  });
  $('#vo-test')?.addEventListener('click', async () => {
    const out = $('#vo-test-out');
    out.textContent = '合成中…';
    try {
      const r = await api('/api/voice/test', { method: 'POST', body: JSON.stringify({ text: '这是一条测试语音。' }) });
      out.textContent = r.ok ? `✅ 成功（${r.bytes} 字节，未发送）` : `❌ ${r.error}`;
    } catch (e) { out.textContent = '❌ ' + e.message; }
  });
}

// ── 识图 ──────────────────────────────────────────────────────
async function renderVisionPanel(box, ctx) {
  const d = await api('/api/vision/status');
  const results = d.results || {};
  const list = Object.entries(results).slice(0, 12).map(([k, v]) =>
    `<li>· <code>${esc(k)}</code> → ${esc(String(v?.verdict || v))}</li>`).join('');
  box.innerHTML = panelShell('vision', '识图', `
    <div class="row" style="gap:16px;flex-wrap:wrap;font-size:13px">
      <span>总开关：${d.enabled ? '✅ 已启用' : '⛔ 已关闭'}</span>
      <span>当前模型：<code>${esc(d.model || '未设置')}</code></span>
      <span>提供商：<code>${esc(d.provider || '-')}</code></span>
    </div>
    <p class="muted" style="font-size:12px;margin-top:10px">
      模型必须支持图片输入，否则工具会给出"看不到图"的提示。
      开关在「设置 → 模型 API → 图片输入」。</p>
    <div style="margin-top:12px;font-size:12px" class="muted">
      <b>模型能力探测结果</b><br>${list || '还没有探测记录（在设置页点「测试连通性」会顺带探测）'}</div>`,
    '把消息里的图片交给视觉模型查看');
  bindPanelClose(box);
}

// ── 轻量记忆 ──────────────────────────────────────────────────
async function renderMemoryPanel(box, ctx) {
  const chats = (state.chats || []).slice(0, 20);
  box.innerHTML = panelShell('memory', '轻量记忆', `
    <p class="muted" style="font-size:13px">
      模型用 memory_append / memory_query / memory_remove 维护三类记忆：
      进行中的话题、想说没说的话、对群友的印象。每次运行自动注入提示词。</p>
    <div class="row" style="gap:8px;margin-top:12px">
      <input id="mem-chat" placeholder="会话键，如 group:123456" style="width:280px" />
      <button class="btn primary" id="mem-view">查看</button>
    </div>
    <pre id="mem-out" class="mem-preview" style="margin-top:12px"></pre>`,
    '记忆数据存 data/memory/，不随插件导出');
  bindPanelClose(box);
  $('#mem-view')?.addEventListener('click', async () => {
    const chat = $('#mem-chat').value.trim();
    const out = $('#mem-out');
    if (!chat) { out.textContent = '请填会话键'; return; }
    try {
      const r = await api('/api/memory/status?chat=' + encodeURIComponent(chat));
      out.textContent = r.ok ? (r.text || '（该会话没有记忆）') : ('错误：' + r.error);
    } catch (e) { out.textContent = '错误：' + e.message; }
  });
}

// ── 定时任务与课表 ────────────────────────────────────────────
async function renderSchedulePanel(box, ctx) {
  const d = await api('/api/schedule/status');
  const tasks = (d.tasks || []).map((t) =>
    `<li>· ${esc(t.when)} ${t.enabled === false ? '<span class="muted">(已停用)</span>' : ''}</li>`).join('');
  box.innerHTML = panelShell('schedule', '定时任务与课表', `
    <div class="row" style="gap:16px;flex-wrap:wrap">
      <label class="switch-row"><input type="checkbox" id="sc-notify" ${d.notifyEnabled ? 'checked' : ''} />
        <span>每晚课程播报</span></label>
      <label>播报时间 <input id="sc-time" value="${esc(d.notifyTime || '21:00')}" style="width:90px" /></label>
      <button class="btn primary" id="sc-save">保存</button>
    </div>
    <div style="margin-top:14px;font-size:13px">
      <b>待触发任务</b>（${d.taskCount || 0} 条）
      <ul style="margin:6px 0 0;padding-left:18px;font-size:12px">${tasks || '<li class="muted">暂无</li>'}</ul>
    </div>
    <p class="muted" style="font-size:12px;margin-top:10px">
      主人在 QQ 里说「X点提醒我…」即可创建任务；课表数据放在 data/plugins/schedule/schedule.json。</p>`,
    '播报是每晚私聊主人次日课程；课表查询是秒回工具');
  bindPanelClose(box);
  $('#sc-save')?.addEventListener('click', async () => {
    try {
      await api('/api/schedule/config', {
        method: 'POST',
        body: JSON.stringify({
          notifyEnabled: $('#sc-notify').checked,
          notifyTime: $('#sc-time').value
        })
      });
      alert('已保存');
    } catch (e) { alert(e.message); }
  });
}

// ── 表情包 ────────────────────────────────────────────────────
async function renderStickerPanel(box, ctx) {
  let d = { total: 0, annotated: 0 };
  try { d = await api('/api/stickers/stats'); } catch { /* 忽略 */ }
  box.innerHTML = panelShell('sticker', '表情包', `
    <div class="row" style="gap:24px;font-size:13px">
      <span>收藏表情 <b>${d.total ?? 0}</b> 个</span>
      <span>已标注 <b>${d.annotated ?? 0}</b> 个</span>
    </div>
    <p class="muted" style="font-size:12.5px;margin-top:10px">
      模型用 list_stickers 查找、get_sticker_image 看图、sticker_note 记理解、collect_sticker 收藏。</p>
    <p class="muted" style="font-size:12px">
      表情库在 <code>data/stickers.json</code>（内核共享数据，不随插件导出）。</p>`,
    '让机器人会发表情、也能理解别人发的表情');
  bindPanelClose(box);
}

// ── 学习模式与知识库 ──────────────────────────────────────────
async function renderStudyPanel(box, ctx) {
  let ov = null;
  try { ov = (await api('/api/study/progress')).overview; } catch { /* 忽略 */ }
  const subs = (ov?.subjects || []).map((s) =>
    `<tr><td>${esc(s.subject)}</td><td>${s.total} 题</td><td>${(s.chapters || []).length} 章</td></tr>`).join('');
  const total = (ov?.subjects || []).reduce((a, s) => a + s.total, 0);
  box.innerHTML = panelShell('study', '学习模式与知识库', `
    <div class="row" style="gap:24px;font-size:13px;margin-bottom:12px">
      <span>科目 <b>${(ov?.subjects || []).length}</b></span>
      <span>总题量 <b>${total}</b></span>
    </div>
    <table class="table">
      <thead><tr><th>科目</th><th>题量</th><th>章节</th></tr></thead>
      <tbody>${subs || '<tr><td colspan="3" class="muted">题库未安装</td></tr>'}</tbody>
    </table>
    <p class="muted" style="font-size:12px;margin-top:10px">
      题库是**资产**，随插件包分发（在 plugins/study/kb/）；
      学习进度是运行数据（在 data/plugins/study/）。</p>`,
    '6 个教学工具：看总览 / 取题 / 查教材 / 进度 / 档案 / 学习计划');
  bindPanelClose(box);
}

// ── 教师模式 ──────────────────────────────────────────────────
async function renderTeacherPanel(box, ctx) {
  const d = await api('/api/teacher/status');
  box.innerHTML = panelShell('teacher', '教师模式', `
    <div class="row" style="gap:24px;font-size:13px">
      <span>角色卡：${d.personaInstalled ? '✅ 已注入' : '⛔ 未注入'}</span>
      <span>身份模式：${d.modeInstalled ? '✅ 已注册' : '⛔ 未注册'}</span>
      <span>角色卡长度：<b>${d.roleTextLength ?? 0}</b> 字</span>
    </div>
    <div style="margin-top:12px;font-size:13px">
      <b>切换口令</b><br>
      <span style="font-size:12px">进入：${(d.enter || []).map((x) => `「${esc(x)}」`).join(' ')}</span><br>
      <span style="font-size:12px">退出：${(d.exit || []).map((x) => `「${esc(x)}」`).join(' ')}</span>
    </div>
    <p class="muted" style="font-size:12px;margin-top:10px">
      老师人设不内置在内核，由本插件注入；卸载插件会一并撤回。</p>`,
    '老师角色卡 + 学习模式身份，配合「学习模式与知识库」使用');
  bindPanelClose(box);
}

// ── 主人专属工具 ──────────────────────────────────────────────
async function renderMasterToolsPanel(box, ctx) {
  const d = await api('/api/master-tools/status');
  box.innerHTML = panelShell('master-tools', '主人专属工具', `
    <div class="row" style="gap:16px;flex-wrap:wrap">
      <label class="switch-row"><input type="checkbox" id="mt-teacher" ${d.teacherControl ? 'checked' : ''} />
        <span>启用 teacher_control（控制教师机器人）</span></label>
      <button class="btn primary" id="mt-save">保存</button>
    </div>
    <div style="margin-top:14px;font-size:13px;line-height:1.9">
      <div>主人 QQ：<code>${esc(d.masterQQ || '未设置')}</code></div>
      <div>教师服务（:3211）：${d.teacherReachable ? '✅ 可达' : '<span class="muted">未运行</span>'}</div>
      <div>DSH 转发：${d.dshEnabled ? '✅ 可用' : '⛔ 关闭'}</div>
    </div>
    <p class="muted" style="font-size:12px;margin-top:10px">
      这三个工具只对主人挂载 —— 群友触发时模型根本看不到它们。</p>`,
    'dsh_task（转发复杂任务）/ teacher_control（控制教师）/ report_feedback（反馈）');
  bindPanelClose(box);
  $('#mt-save')?.addEventListener('click', async () => {
    try {
      await savePluginConfig('master-tools', { teacherControl: $('#mt-teacher').checked });
      alert('已保存');
    } catch (e) { alert(e.message); }
  });
}


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