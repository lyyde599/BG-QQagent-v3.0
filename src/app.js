// 🔴 时区铁律（记忆系统 00 铁律 0.5 / 01 第六节）：
//   服务器系统时区是 UTC，但用户在**中国（UTC+8）** —— 所有面向用户的时间必须是北京时间。
//   TZ 必须在任何 new Date() 之前设置，且 ESM 的 import 会先于模块体执行，
//   所以这三行放在**所有 import 之上**。
process.env.TZ = process.env.TZ || 'Asia/Shanghai';
// 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
// Electron 主进程与 headless 服务器都从这里启动。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig, updateConfig, ROOT, DATA_DIR, COMMUNITY } from './config.js';
import { checkKernelUpdate, downloadKernelUpdate, localKernelVersion, listDownloaded, publishKernel, canPublishKernel } from './kernel-update.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments } from './onebot.js';
import { ChatStore } from './store.js';
import { MemoryStore } from './memory.js';
import { StickerManager } from './sticker-manager.js';
import { SendQueue } from './sender.js';
import { SessionRegistry } from './sessions.js';
import { Orchestrator } from './orchestrator.js';
import { listModels, estimateCost, chatCompletion } from './llm.js';
import { importFromDsh, currentProviders, setProviderKey, testAllProviders, testOneProvider, testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider } from './providers.js';
import { scanModelsVision, visionResults } from './vision-scan.js';
import { qrInfo, readQrBuffer } from './napcat-qr.js';
import { NapCatWebui } from './napcat-webui.js';
import { QrRefreshGuard } from './qr-refresh-guard.js';
import { GroupMemberCache } from './group-member-cache.js';
import { PluginHost } from './core/plugin-host.js';
import { projectLegacyConfig, splitLegacyPatch } from './core/config-compat.js';
import { registerPluginAdmin } from './core/plugin-admin.js';
import { listSkills, getSkillBody, reloadUserSkills, userSkillDir } from './skill.js';
import { fetchSkillIndex, publishSkill, installSkill, unpublishSkill, checkSkillUpdates } from './skill-market.js';

/**
 * 把面板传来的值规范成字符串数组。
 * 面板这些字段是「一行一项」或「逗号分隔」的文本，也可能直接是数组，都接受。
 */
function toStrList(v, { keepEmpty = false } = {}) {
  let arr;
  if (Array.isArray(v)) arr = v;
  else if (v === undefined || v === null) arr = [];
  else arr = String(v).split(/[\n,，]/);
  const out = arr.map((x) => String(x).trim());
  return keepEmpty ? out : out.filter(Boolean);
}

import { OneBotHealth } from './onebot-health.js';
import { ScheduledTaskRunner } from './scheduled-tasks.js';
import { createEventBus, todayKey } from './util.js';
import { getGrant } from './core/plugin-grants.js';
import { sendMail, mailReady, mailStatus, saveMailConfig, clearMailConfig } from './core/mailer.js';
import crypto from 'node:crypto';

// 验证码暂存（中心端，内存即可 —— 重启失效是特性不是缺陷）
const authCodes = new Map();     // email -> { code, at }
const authSendLog = new Map();   // email -> 上次发送时间
const authIpLog = new Map();     // ip -> [时间戳]

// 全局 fetch（undici）默认连接建立超时只有 10 秒，openrouter.ai 这类海外端点
// 握手慢时会直接报 "Connect Timeout Error ... timeout: 10000ms"（注意这不是
// 请求超时——那是 llm.js 里 180 秒的 AbortSignal）。这里放宽到 30 秒。
// 动态导入 + 容错：undici 与 Electron 内置 Node 不兼容时只退回默认超时，绝不崩主进程。
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 30_000 } }));
} catch (error) {
  console.warn('[net] 全局连接超时设置失败（使用 undici 默认值 10s）:', error?.message ?? error);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..', 'ui');
// 插件目录：插件的**前端文件**（ui.js / ui.css）也放在各自插件目录下，
// 由 /plugin-ui/<id>/<file> 提供。内核 ui/app.js 不得写入插件界面代码。
const PLUGINS_DIR = path.resolve(__dirname, '..', 'plugins');

// ── 白名单判断（移植自原版 allowed()） ───────────────────────────────────
// ⚠️ ref 会被动态赋值（见下方 allowed 的 groupMemberCache 注入），
//    因为群成员缓存是异步拉取的，而本函数必须同步返回。
let groupMemberCache = null;
export function setGroupMemberCache(cache) { groupMemberCache = cache; }

function allowed(kind, id, cfg) {
  const s = String(id);
  const denyList = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (allowList.length > 0) {
    if (allowList.map(String).includes(s)) return true;
    // 私聊放行策略（2026-10-02 用户要求「开放功能群的好友进行私聊均回复」）：
    // 白名单群里的成员私聊机器人时也放行 —— 他们对机器人而言是"自己人"。
    // 由 cfg.privateAllowGroupMembers 控制，默认开启；置 false 可退回严格白名单。
    if (kind === 'private'
      && cfg.privateAllowGroupMembers !== false
      && groupMemberCache
      && groupMemberCache.has(s)) {
      return true;
    }
    return false;
  }
  return cfg.allowAllWhenEmpty === true;
}

/**
 * 私聊放行的**异步兜底查证**。
 *
 * 背景（2026-10-04 事故）：私聊是否放行依赖 groupMemberCache，而缓存是异步填充的。
 * 群友在缓存填充前私聊 → allowed() 判 false → 消息被**静默丢弃**（连存档都没有），
 * 机器人完全不知情，用户以为被无视。
 *
 * 对策：allowed() 同步判断失败后，这里再**实时查一次** QQ（get_group_member_info），
 * 确属白名单群成员就放行并顺手补进缓存。这样即使缓存还没热起来，
 * 真正群成员的私聊也不会被丢。
 *
 * @returns {Promise<boolean>}
 */
async function allowedAsync(kind, id, cfg) {
  if (allowed(kind, id, cfg)) return true;
  // 只对"私聊 + 开了群成员放行 + 在群列表里没查到"的情况做实时查证
  if (kind !== 'private') return false;
  if (cfg.privateAllowGroupMembers === false) return false;
  const allowList = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (!allowList.length) return false;   // 白名单为空时走 allowAllWhenEmpty，不在这里处理
  const groups = (cfg.allow?.groups || []).map(String).filter(Boolean);
  if (!groups.length) return false;
  const uid = Number(id);
  if (!Number.isInteger(uid) || uid <= 0) return false;
  for (const gid of groups) {
    try {
      const info = await onebot.getGroupMemberInfo(Number(gid), uid);
      if (info && info.user_id != null) {
        // 确认是群成员 → 补进缓存，之后同步判断即可命中
        if (groupMemberCache) {
          groupMemberCache.members.add(String(uid));
          groupMemberCache.updatedAt = groupMemberCache.updatedAt || Date.now();
        }
        log(`[放行] 缓存未命中，实时查证确认 ${uid} 是群 ${gid} 成员 → 放行私聊`);
        return true;
      }
    } catch { /* 不是该群成员，试下一个群 */ }
  }
  return false;
}

/**
 * 调用桌面端（配套项目）的内部 API（带访问令牌）。
 *
 * ⚠️ 令牌从 600 的 config.json 读取，**只在本进程使用**，不下发给浏览器。
 * 用于面板的「账号总览 / 一键切号」—— 复用桌面侧已实现且已做安全校验的能力
 * （桌面侧已限制 URL 白名单 + 改配置前自动备份），避免两处重复实现。
 */
async function deskApi(pathname, method = 'GET', body) {
  // 桌面端配置路径：可用环境变量覆盖，默认放在项目同级（不写死别人的绝对路径）
  const cfgPath = process.env.DESK_CONFIG_PATH || path.join(ROOT, '..', 'desk', 'data', 'config.json');
  let token = '';
  try {
    token = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).authToken || '';
  } catch (error) {
    throw new Error('读不到桌面令牌（' + cfgPath + '）');
  }
  if (!token) throw new Error('桌面令牌为空');
  const res = await fetch('http://127.0.0.1:8090' + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Desk-Token': token },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const data = await res.json().catch(() => ({}));
  return data?.data !== undefined ? data.data : data;
}

export function createApp({ log = console.log } = {}) {
  const cfg = getConfig();
  const bus = createEventBus();
  const sseClients = new Set();

  // ── SnowLuma 程序目录与进程管理 ──
  function snowlumaDir() {
    const configured = String(getConfig().snowluma?.dir || '').trim();
    if (configured) return configured;
    const bundled = path.join(ROOT, 'snowluma');
    return fs.existsSync(bundled) ? bundled : '';
  }

  function snowlumaWsPort() {
    try {
      const wsUrl = String(getConfig().snowluma?.wsUrl || 'ws://127.0.0.1:3001');
      const u = new URL(wsUrl);
      if (u.port) return Number(u.port);
    } catch { /* ignore */ }
    return 3001;
  }

  /** 从 SnowLuma 的 runtime.json 读取 WebUI 地址（http(s)://host:port/）。拿不到就返回空串。 */
  function snowlumaWebuiUrl() {
    try {
      const dir = snowlumaDir();
      if (!dir) return '';
      const rtPath = path.join(dir, 'config', 'runtime.json');
      if (!fs.existsSync(rtPath)) return '';
      const rt = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
      const host = String(rt.webuiHost || '127.0.0.1');
      const port = Number(rt.webuiPort) || 5099;
      const tls = !!(rt.webuiTls && rt.webuiTls.enabled);
      return `${tls ? 'https' : 'http'}://${host}:${port}/`;
    } catch {
      // 配置读不到时，从最近日志里找 "listening http(s)://…" 兜底
      for (const line of [...snowlumaLogs].reverse()) {
        const m = /listening\s+(https?:\/\/[\w.:-]+)/i.exec(line.text || '');
        if (m) return m[1];
      }
      return '';
    }
  }

  function isPortOpen(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (result) => { try { socket.destroy(); } catch { /* ignore */ } resolve(result); };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  // SnowLuma 内置控制台日志（环形缓冲，最近 500 行）
  // 内置 SnowLuma 状态与日志。未采用多进程方案：由 Electron 主进程提供 IPC 控制与日志转发，
  // 确保 SnowLuma 随 QQ Agent 退出、无需单独管理窗口。
  const snowlumaLogs = [];
  let snowlumaProc = null;
  let snowlumaStopping = false;

  function pushSnowlumaLog(text, stream = 'stdout') {
    const line = { at: Date.now(), stream, text: String(text ?? '').replace(/\r?\n$/, '') };
    if (!line.text) return;
    snowlumaLogs.push(line);
    if (snowlumaLogs.length > 500) snowlumaLogs.splice(0, snowlumaLogs.length - 500);
    emit('snowluma-log', line);
  }

  function snowlumaStatus() {
    return { embedded: !!snowlumaProc, pid: snowlumaProc?.pid ?? null };
  }

  /** 关闭内置启动的 SnowLuma。返回是否执行了关闭动作。 */
  function stopSnowluma() {
    const proc = snowlumaProc;
    if (!proc) return false;
    try {
      proc.kill();
      pushSnowlumaLog('已请求关闭 SnowLuma。', 'stdout');
    } catch (error) {
      pushSnowlumaLog(`关闭 SnowLuma 失败：${error?.message ?? error}`, 'stderr');
      throw error;
    }
    return true;
  }

  /** 拉起 SnowLuma。优先用项目内置 node.exe 直接运行（日志进内置控制台）；失败再回退到独立窗口 launcher.bat。 */
  async function launchSnowluma() {
    const dir = snowlumaDir();
    if (!dir) return { ok: false, error: '找不到 SnowLuma 目录：请确认项目内 snowluma/ 文件夹存在，或在设置里填写 SnowLuma 目录' };
    const wsPort = snowlumaWsPort();
    if (await isPortOpen('127.0.0.1', wsPort)) {
      pushSnowlumaLog(`SnowLuma 已在运行（端口 ${wsPort} 已就绪），无需重复启动`, 'stdout');
      return { ok: true, alreadyRunning: true };
    }
    const indexMjs = path.join(dir, 'index.mjs');
    const nodeExe = path.join(dir, 'node.exe');
    if (fs.existsSync(indexMjs) && fs.existsSync(nodeExe)) {
      try {
        // 用 Windows 的 CREATE_NEW_PROCESS_GROUP + 独立进程方式启动，
        // 让 SnowLuma 真正独立于 Electron 主进程（Electron 退出时不会拖垮它）。
        const child = spawn(nodeExe, [indexMjs], {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: false
        });
        snowlumaProc = child;
        child.unref();
        pushSnowlumaLog(`SnowLuma 启动中（内置模式，pid=${child.pid}）…`, 'stdout');
        child.stdout.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushSnowlumaLog(line, 'stdout');
          }
        });
        child.stderr.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushSnowlumaLog(line, 'stderr');
          }
        });
        child.on('exit', (code, signal) => {
          snowlumaProc = null;
          pushSnowlumaLog(`SnowLuma 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
          emit('snowluma-status', { running: false, embedded: false, pid: null });
        });
        child.on('error', (error) => {
          pushSnowlumaLog(`SnowLuma 启动失败：${error?.message ?? error}`, 'stderr');
        });
        emit('snowluma-status', { running: true, embedded: true, pid: child.pid });
        return { ok: true, launched: true, embedded: true, pid: child.pid };
      } catch (error) {
        pushSnowlumaLog(`内置模式启动失败，尝试回退独立窗口：${error?.message ?? error}`, 'stderr');
        snowlumaProc = null;
      }
    }
    // 回退：launcher.bat 独立控制台窗口（老行为，日志无法内置）
    const launcher = path.join(dir, 'launcher.bat');
    if (!fs.existsSync(launcher)) return { ok: false, error: `目录里没有 index.mjs / node.exe，也没有 launcher.bat：${dir}` };
    const child = spawn('cmd.exe', ['/c', launcher], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: false // 保留 SnowLuma 自己的控制台窗口
    });
    child.unref();
    pushSnowlumaLog('SnowLuma 已用独立控制台窗口启动（此模式下日志不进内置控制台）', 'stdout');
    return { ok: true, launched: true, embedded: false };
  }

  const emit = (type, payload) => {
    bus.emit(type, payload);
    const line = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of sseClients) {
      try { res.write(line); } catch { /* 客户端断开会由 close 清理 */ }
    }
  };

  // ── 组件 ──
  const visionScan = { running: false };   // 模型图片输入能力扫描的运行状态
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 2000);
  const memory = new MemoryStore();
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 300);
  const onebot = new OneBotClient({
    wsUrl: cfg.snowluma?.wsUrl,
    httpUrl: cfg.snowluma?.httpUrl,
    accessToken: cfg.snowluma?.accessToken,
    httpToken: cfg.snowluma?.httpAccessToken || cfg.snowluma?.accessToken,
    onEvent: (event) => handleOneBotEvent(event).catch((error) => log('[ingest] 处理事件出错:', error?.message ?? error))
  });
  const stickers = new StickerManager(onebot);
  const sender = new SendQueue({
    onebot, store,
    onSent: ({ chatKey, text }) => log(`[发送 -> ${chatKey}] ${String(text).slice(0, 60)}`)
  });
  // 注意：pluginHost 在下面才构造，这里先传 null 占位；构造完成后立刻回填，
  // 避免插件工具/提示词与内核形成循环依赖（宿主需要 orchestrator 的工具校验，orchestrator 也要宿主的插件）。
  const orchestrator = new Orchestrator({ store, memory, stickers, sender, sessions, onebot, emit, pluginHost: null });

  // 每晚课程播报已**移交 schedule 插件**（2026-10-21）。
  // 内核不再持有这个调度器 —— 否则"插件停用了但播报还在跑"，
  // 而且干净版本里没有课表、没有 chatKey，会一直重试并报错。
  // 通用定时任务（主人在 QQ 里下的提醒/定时指令）
  // ── NapCat WebUI 客户端（账密登录 / 人机验证代理）──
  const napcatWebui = new NapCatWebui({ log });



  // ── QQ 账号健康探针 ──
  // 只用 WS 连接状态判断健康是不够的：NapCat 的 WS 在**账号离线**时依然在监听，
  // 会导致控制台误报"已连接"（2026-09-14 事故：掉线 5 小时无人发现）。
  // 这里周期性调 get_status 拿真实的 online 标志，掉线时推 SSE 事件 + 打印告警。
  const onebotHealth = new OneBotHealth({ onebot, log });
  onebotHealth.on('offline', (st) => {
    log('[health] ⚠ QQ 账号离线，机器人将无法收发消息。请检查 NapCat 登录状态。');
    emit('onebot-health', { online: false, since: st.offlineSince, error: st.lastError });
  });
  onebotHealth.on('recovered', () => {
    log('[health] ✔ QQ 账号已恢复在线。');
    emit('onebot-health', { online: true, at: Date.now() });
  });

  // ── 登录二维码刷新守护 ──
  // NapCat 的自动刷新循环会卡死（2026-09-16 事故），进程却还活着，
  // 外部健康检查查不出来。这里靠"二维码文件是否还在更新"来发现并踢活。
  // ── 群成员缓存（私聊放行策略用）──
  // 「功能群成员私聊也回复」需要同步判断，而查群成员是异步的，
  // 所以周期拉取存成 Set（见 group-member-cache.js）。
  const groupMemberCache = new GroupMemberCache({ onebot, log });
  setGroupMemberCache(groupMemberCache);

  // ── 插件宿主（2026-10-20 插件化）──────────────────────────────────
  // 附加功能（广告禁言/内容注入/福利/圣杯战争/群管理/定时/学习）全部是 plugins/<id>/
  // 里的独立插件，可装可卸、可导出导入；内核只负责把能力递进去。
  // 详见 PLUGIN-ARCH.md。
  const pluginHost = new PluginHost({
    log,
    deps: {
      store, sender, onebot, stickers, memory, emit,
      chatCompletion,
      getConfig,
      // 邮件通道（内核基础设施，2026-10-25）
      mailReady,
      sendMail,
      // 权限守卫：插件 ctx 构建时按授权裁剪能力
      grantCheck: (id, perm) => {
        // 兼容策略：老插件没有授权记录时放行（见 plugin-grants.js 文件头 ②）
        const g = getGrant(id);
        if (!g) return true;
        return Array.isArray(g.granted) && g.granted.includes(perm);
      },
      // 回填时机：start() 里 orchestrator 建好后注入，避免构造期循环依赖
      get orchestrator() { return orchestrator; }
    }
  });
  // 宿主就绪 → 把插件能力接进 orchestrator（工具集 + 提示词段）
  orchestrator.pluginHost = pluginHost;
  // 管理端点（列表/启停/导出/导入/卸载）——属内核能力，不随任何业务插件走
  registerPluginAdmin(pluginHost, { getConfig, log });

  const qrGuard = new QrRefreshGuard({
    napcatWebui,
    // ⚠️ 必须用「账号是否在线」，**不能**用 onebot.connected（WS 是否连着）！
    //    NapCat 的 WS 在账号离线时依然在监听 → connected 恒为 true → 守护误以为
    //    "已登录"，直接跳过检查，于是二维码再旧也不会被踢活（2026-09-17 事故）。
    //    这是同一个坑第三次出现（前两次：控制台显示、二维码面板），务必保持警惕。
    isLoggedIn: () => onebotHealth.snapshot().online === true,
    dir: () => snowlumaDir(),
    log
  });

  const scheduledRunner = new ScheduledTaskRunner({ orchestrator, log });

  // OneBot 连接状态推送
  onebot.onStatus((status) => emit('onebot-status', status));

  // ── 从 SnowLuma 配置自动同步 OneBot 令牌 ──
  // SnowLuma 登录后会在 snowluma/config/onebot_<uin>.json 里写入随机 accessToken。
  // 脱敏发布/全新副本中 qq-agent 的 token 为空，若不自动同步会一直 401。这里在
  // OneBot 未连接时读取 SnowLuma 配置，把 HTTP/WS 令牌补进我们的配置。
  let lastSyncTokenSig = '';
  function syncSnowlumaTokens() {
    try {
      const dir = snowlumaDir();
      if (!dir) return false;
      const cfgDir = path.join(dir, 'config');
      const files = fs.readdirSync(cfgDir).filter((f) => /^onebot_\d+\.json$/.test(f) && !/^onebot_0\.json$/.test(f)).sort();
      if (!files.length) return false;
      const data = JSON.parse(fs.readFileSync(path.join(cfgDir, files[0]), 'utf8'));
      const http = (data?.networks?.httpServers || []).find((s) => (s.port === 3000) || (s.name === 'http-default')) || (data?.networks?.httpServers || [])[0];
      const ws = (data?.networks?.wsServers || []).find((s) => (s.port === 3001) || (s.name === 'ws-default')) || (data?.networks?.wsServers || [])[0];
      const wsToken = String(ws?.accessToken ?? '');
      const httpToken = String(http?.accessToken ?? '');
      const sig = `${wsToken}|${httpToken}`;
      if (!sig || sig === lastSyncTokenSig) return false;
      const cur = getConfig();
      if (cur.snowluma?.accessToken !== wsToken || cur.snowluma?.httpAccessToken !== httpToken) {
        updateConfig({ snowluma: { ...cur.snowluma, accessToken: wsToken, httpAccessToken: httpToken } });
        log('[onebot] 已从 SnowLuma 配置同步 OneBot 访问令牌');
      }
      lastSyncTokenSig = sig;
      return true;
    } catch (error) {
      log('[onebot] 同步 SnowLuma 令牌失败:', error?.message ?? error);
      return false;
    }
  }

  // 401 / 未连接时自动同步一次令牌并重连
  let tokenSyncRetryAt = 0;
  function maybeRecoverOnebot() {
    const now = Date.now();
    if (now - tokenSyncRetryAt < 5000) return;   // 限频
    tokenSyncRetryAt = now;
    if (syncSnowlumaTokens()) {
      const cur = getConfig();
      onebot.wsUrl = String(cur.snowluma?.wsUrl || onebot.wsUrl);
      onebot.httpUrl = String(cur.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      onebot.accessToken = String(cur.snowluma?.accessToken || '');
      onebot.httpToken = String(cur.snowluma?.httpAccessToken || cur.snowluma?.accessToken || '');
      onebot.reconnect();
    }
  }
  onebot.onStatus((status) => {
    if (!status.connected && String(status.error || '').includes('401')) maybeRecoverOnebot();
  });

  // ── 入站事件处理 ──
  let atNameCache = new Map(); // groupId:userId -> name
  async function resolveAtName(groupId, userId) {
    const key = `${groupId}:${userId}`;
    if (atNameCache.has(key)) return atNameCache.get(key);
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      const name = info?.card || info?.nickname || null;
      if (name) {
        atNameCache.set(key, String(name));
        if (atNameCache.size > 500) atNameCache.clear(); // 简单防膨胀
        return String(name);
      }
    } catch { /* ignore */ }
    return null;
  }

  async function resolveReply(messageId) {
    try {
      const msg = await onebot.getMsg(messageId);
      const senderName = msg?.sender?.card || msg?.sender?.nickname || '';
      const senderId = String(msg?.sender?.user_id ?? msg?.user_id ?? '');
      let text = '';
      if (Array.isArray(msg?.message)) {
        text = msg.message.map((s) => (s.type === 'text' ? s.data?.text ?? '' : `[${s.type}]`)).join('').trim();
      } else if (typeof msg?.message === 'string') {
        text = msg.message;
      }
      return { sender: String(senderName), senderId, text: String(text).slice(0, 120) };
    } catch {
      return null;
    }
  }

  async function ingestMessage(kind, id, event) {
    const cfgNow = getConfig();
    // 白名单外的聊天完全不记录。
    // ⚠️ 用 allowedAsync：缓存未热时对私聊做实时查证，避免群成员私聊被静默丢弃
    //    （2026-10-04 事故，见 allowedAsync 注释）。
    if (!await allowedAsync(kind, id, cfgNow)) return;

    const segments = Array.isArray(event.message) ? event.message : null;
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
    const senderName = String(event.sender?.card || event.sender?.nickname || senderId || '');
    const media = segments ? extractMediaFromSegments(segments) : [];

    let text;
    if (segments) {
      text = await segmentsToText(segments, {
        resolveReply: (mid) => resolveReply(mid),
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : null
      });
    } else {
      text = String(event.raw_message ?? event.message ?? '').trim();
    }

    if (!text && !media.length) return;
    const chatKey = kind + ':' + id;

    // ── 入库前拦截（黑名单等，2026-10-21）──
    // 必须在 appendIncoming **之前**：被拉黑的人说的话连存档都不该留，
    // 否则控制台还能翻到，等于没屏蔽。
    const pre = await pluginHost.dispatchPrefilter({
      chatKey, kind, chatId: id,
      userId: senderId, senderName,
      text: text || '', media,
      messageId: event.message_id ?? null,
      selfId: onebot.selfId
    });
    if (pre.drop) {
      log(`[拦截] 丢弃 ${chatKey} 来自 ${senderId} 的消息（${pre.by}：${pre.reason || '命中屏蔽'}）`);
      return;
    }

    store.appendIncoming(chatKey, {
      mid: event.message_id,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: text || '[图片]' ,
      media
    });
    emit('chat-update', chatKey);

    // ── 插件消息链（2026-10-20 插件化）─────────────────────────────────
    // 原来这里硬编码了四个块（anti-ad / ad-inject / welfare / grail），
    // 现在全部交给插件宿主按 manifest.priority 顺序分发。
    //
    // 语义保持：
    //   · 插件返回 { handled:true } → 终止链，不再触发 LLM（welfare / grail 就是这种）
    //   · 插件不返回 handled    → 继续下一个插件、最后交给 LLM（anti-ad / ad-inject）
    //   · 插件之间用 chain.flags 传信号（ad-inject 命中 → anti-ad 自行让路）
    //   · 任一插件抛错只写日志，链继续（绝不让插件拖垮聊天）
    const chainResult = await pluginHost.dispatchMessage({
      chatKey, kind, chatId: id,
      userId: senderId, senderName,
      text: text || '', media,
      messageId: event.message_id ?? null,
      selfId: onebot.selfId
    });
    if (chainResult.handled) return;

    // 所有消息都交给模型处理（入库 + 触发），由模型根据上下文自主决定是否回复。
    // 系统提示已引导：@/点名/针对自己的必回；无关群聊/别人的图/别人的引用 → 模型选择安静结束（不回复）。
    orchestrator.onIncoming(chatKey);
  }

  async function ingestPoke(event) {
    // OneBot v11: notice_type=notify, sub_type=poke；群拍 target_id，私聊拍自己
    const isGroup = event.group_id != null;
    const id = isGroup ? String(event.group_id) : String(event.user_id);
    const cfgNow = getConfig();
    // 同样用 allowedAsync：拍一拍也来自群成员，缓存未热时不该被丢
    if (!await allowedAsync(isGroup ? 'group' : 'private', id, cfgNow)) return;

    const operatorId = String(event.user_id ?? '');
    // 自己拍的拍（send_poke 的 OneBot 回显）不触发处理——与 message_sent 同理，发送时已留档
    if (operatorId && operatorId === onebot.selfId) return;
    const targetId = String(event.target_id ?? event.user_id ?? '');
    const selfId = onebot.selfId;
    let text;
    if (String(targetId) === String(selfId)) {
      text = `[拍一拍] 你拍了拍${isGroup ? '' : '你'}（来自 ${operatorId}）`;
    } else {
      const operatorName = isGroup ? (await resolveAtName(id, operatorId)) || operatorId : operatorId;
      const targetName = isGroup ? (await resolveAtName(id, targetId)) || targetId : targetId;
      text = operatorId === targetId ? `[拍一拍] ${operatorName} 拍了拍自己` : `[拍一拍] ${operatorName} 拍了拍 ${targetName}`;
    }
    // senderName 必须是**真实昵称**（2026-10-21 修）：
    // 原来写死成 '（拍一拍事件）'，导致活跃度排行里出现一个
    // 叫"（拍一拍事件）"的"人"—— 其实是某个真实群友，
    // 只是名字被覆盖了，管理员根本认不出该不该邀请他。
    let operatorName = '';
    try {
      operatorName = (isGroup ? (await resolveAtName(id, operatorId)) : '') || '';
    } catch { /* 拿不到就留空 */ }
    store.appendIncoming(`${isGroup ? 'group' : 'private'}:${id}`, {
      mid: null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId: operatorId,
      senderName: operatorName || String(operatorId),
      text,
      media: []
    });
    emit('chat-update', `${isGroup ? 'group' : 'private'}:${id}`);
    orchestrator.onIncoming(`${isGroup ? 'group' : 'private'}:${id}`);
  }

  async function handleOneBotEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      // 自己发的消息（message_sent / self_id 相同）不触发处理（发送时已自行记录）
      if (String(event.user_id ?? event.sender?.user_id ?? '') === onebot.selfId) return;
      if (event.message_type === 'group' && event.group_id != null) return ingestMessage('group', String(event.group_id), event);
      if (event.message_type === 'private' && event.user_id != null) return ingestMessage('private', String(event.user_id), event);
      return;
    }
    // 群成员增加（新人入群 / 机器人被拉进群）→ 交给 notice 钩子（群管理插件）
    if (event.post_type === 'notice' && event.notice_type === 'group_increase') {
      pluginHost.dispatch('notice', { type: 'group_increase', event })
        .catch((e) => log('[插件] 迎新分发出错:', e?.message ?? e));
      return;
    }
    // 申请事件（加好友 / 入群 / 被邀请入群）→ 交给 notice 钩子（群管理插件）
    if (event.post_type === 'request') {
      pluginHost.dispatch('notice', { type: 'request', event })
        .catch((e) => log('[插件] 申请分发出错:', e?.message ?? e));
      return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      return ingestPoke(event);
    }
    // meta/心跳等事件忽略
  }

  // ── HTTP API ──
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log('[http] 处理出错:', error?.message ?? error);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      } catch { /* ignore */ }
    });
  });

  function json(res, code, data) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  /**
   * 读请求体。
   *
   * @param {object} [opts]
   * @param {number} [opts.limitMB] 体积上限（MB），默认 2。
   *   🔴 插件导入必须放宽到 32MB：base64 会让体积膨胀 33%，
   *      像「学习模式与知识库」这种带题库的包（2.7MB → base64 3.6MB）
   *      会直接撞上限，报出一个**误导性**的「缺少 base64 数据」。
   *   （2026-10-21 实测踩到：命令行还叠加了 Argument list too long，双重陷阱）
   * @param {boolean} [opts.raw] true = 返回原始文本不解析 JSON
   */
  async function readBody(req, opts = {}) {
    const limitBytes = (Number(opts.limitMB) || 2) * 1024 * 1024;
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limitBytes) {
        const err = new Error(
          `请求体过大（上限 ${Math.round(limitBytes / 1024 / 1024)}MB）。` +
          `当前端点支持的最大体积见接口说明。`
        );
        err.code = 'BODY_TOO_LARGE';
        err.sizeBytes = size;
        throw err;
      }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (opts.raw) return text;
    return text ? JSON.parse(text) : {};
  }

  function authorize(req) {
    const token = String(getConfig().server?.token ?? '');
    if (!token) return true;
    const url = new URL(req.url, 'http://127.0.0.1');
    return req.headers['x-console-token'] === token || url.searchParams.get('token') === token;
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    // SSE
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      const method = req.method;
      const cfgNow = getConfig();

      // ── Skill 市场（2026-10-25）──
      //
      // 与插件市场的区别：skill 是单个 .md，装上即生效，不用重启。
      if (pathname === '/api/skill-market/index' && method === 'GET') {
        const r = await fetchSkillIndex();
        return json(res, 200, r);
      }

      if (pathname === '/api/skill-market/publish' && method === 'POST') {
        const body = await readBody(req, { limitMB: 2 }).catch(() => ({}));
        // 只有作者能发布（与内核发布同一套判定）
        let author = null;
        try {
          const f = path.join(DATA_DIR, 'plugins', 'plugin-market', 'author.json');
          if (fs.existsSync(f)) author = JSON.parse(fs.readFileSync(f, 'utf8'));
        } catch { /* ignore */ }
        if (!author?.verifiedAt) {
          return json(res, 403, { ok: false, error: '请先在「创造营」注册作者账号' });
        }
        const r = await publishSkill(String(body?.id || ''), {
          version: String(body?.version || '1.0.0'),
          notes: String(body?.notes || ''),
          dryRun: body?.dryRun === true
        });
        return json(res, 200, r);
      }

      // ── skill 下架（2026-10-25）──
      // 与插件下架同一套语义：从远端清单移除，本地 .md 保留。
      if (pathname === '/api/skill-market/unpublish' && method === 'POST') {
        const body = await readBody(req, { limitMB: 2 }).catch(() => ({}));
        let author = null;
        try {
          const f = path.join(DATA_DIR, 'plugins', 'plugin-market', 'author.json');
          if (fs.existsSync(f)) author = JSON.parse(fs.readFileSync(f, 'utf8'));
        } catch { /* ignore */ }
        if (!author?.verifiedAt) {
          return json(res, 403, { ok: false, error: '请先在「创造营」注册作者账号' });
        }
        const r = await unpublishSkill(String(body?.id || ''), {
          reason: String(body?.reason || ''),
        });
        return json(res, 200, r);
      }

      if (pathname === '/api/skill-market/install' && method === 'POST') {
        const body = await readBody(req, { limitMB: 2 }).catch(() => ({}));
        const r = await installSkill(String(body?.id || ''), { overwrite: body?.overwrite === true });
        return json(res, 200, r);
      }

      if (pathname === '/api/skill-market/updates' && method === 'GET') {
        // 先刷本地缓存 —— 用户可能刚在外面改过 skills/*.md，
        // 不刷的话拿到的是进程启动时的旧快照，版本比对会失真。
        reloadUserSkills();
        const r = await checkSkillUpdates();
        return json(res, 200, r);
      }

      // ── 内核升级（2026-10-25）──
      //
      // 只做「查 / 下 / 交」，不做自动覆盖。
      // 原因见 src/kernel-update.js 顶部：整包替换第三方宿主出过真实事故。
      if (pathname === '/api/kernel/version' && method === 'GET') {
        return json(res, 200, { ok: true, version: localKernelVersion() });
      }

      if (pathname === '/api/kernel/check' && method === 'GET') {
        const r = await checkKernelUpdate();
        return json(res, 200, r);
      }

      if (pathname === '/api/kernel/download' && method === 'POST') {
        const r = await downloadKernelUpdate();
        return json(res, 200, r);
      }

      // 能不能发布（有没有 R2 凭据 + 是不是作者）
      if (pathname === '/api/kernel/can-publish' && method === 'GET') {
        let author = null;
        try {
          const f = path.join(DATA_DIR, 'plugins', 'plugin-market', 'author.json');
          if (fs.existsSync(f)) author = JSON.parse(fs.readFileSync(f, 'utf8'));
        } catch { /* 没有作者档案 */ }
        return json(res, 200, {
          ok: true,
          hasCredentials: canPublishKernel(),
          author: author ? { nickname: author.nickname || '', email: author.email || '', verified: !!author.verifiedAt } : null
        });
      }

      // 发布内核新版本（打包 → 上传 → 更新清单）
      if (pathname === '/api/kernel/publish' && method === 'POST') {
        const body = await readBody(req, { limitMB: 4 }).catch(() => ({}));
        // 必须已注册作者，且昵称是白光（与创造营同一套归属判定）
        let author = null;
        try {
          const f = path.join(DATA_DIR, 'plugins', 'plugin-market', 'author.json');
          if (fs.existsSync(f)) author = JSON.parse(fs.readFileSync(f, 'utf8'));
        } catch { /* ignore */ }
        if (!author?.verifiedAt) {
          return json(res, 403, { ok: false, error: '请先在「创造营」注册作者账号' });
        }
        const mine = String(author.nickname || '') === '白光' || String(author.qq || '') === '3170037984';
        if (!mine) {
          return json(res, 403, { ok: false, error: '只有内核作者能发布内核更新' });
        }
        const r = await publishKernel({
          notes: String(body?.notes || ''),
          dryRun: body?.dryRun === true
        });
        return json(res, 200, r);
      }

      if (pathname === '/api/kernel/downloaded' && method === 'GET') {
        return json(res, 200, { ok: true, items: listDownloaded() });
      }

      // 关于 / 交流群（2026-10-24）：只读，供控制台「关于」区展示
      if (pathname === '/api/about' && method === 'GET') {
        return json(res, 200, {
          ok: true,
          community: COMMUNITY,
          version: process.env.npm_package_version || null,
          node: process.version
        });
      }

      if (pathname === '/api/status' && method === 'GET') {
        const dayKey = todayKey();
        const usage = sessions.todayUsage(dayKey);
        return json(res, 200, {
          onebot: {
            connected: onebot.connected,
            everConnected: onebot.everConnected,
            error: onebot.lastConnectError,
            self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null,
            // 账号级健康（与"WS 是否连上"不同：账号离线时 WS 仍可能连着）
            account: onebotHealth.snapshot(),
            // 综合结论：WS 连着 **且** 账号在线，才算真正可用
            healthy: !!onebot.connected && onebotHealth.snapshot().online !== false
          },
          snowluma: {
            dir: snowlumaDir(),
            running: await isPortOpen('127.0.0.1', snowlumaWsPort()),
            webuiUrl: snowlumaWebuiUrl(),
            ...snowlumaStatus()
          },
          orchestrator: orchestrator.statusSummary(),
          usage: {
            ...usage,
            cost: estimateCost(usage)
          },
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null
        });
      }

      // ── SnowLuma 进程管理 ──
      if (pathname === '/api/snowluma/launch' && method === 'POST') {
        try {
          const result = await launchSnowluma();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/logs' && method === 'GET') {
        return json(res, 200, { logs: snowlumaLogs.slice(-200) });
      }

      // ── 登录二维码（未登录时展示，供扫码）──
      // NapCat 会把二维码写到它的 cache/qrcode.png，约每 2 分钟自动刷新。
      if (pathname === '/api/snowluma/qr' && method === 'GET') {
        const info = qrInfo(snowlumaDir());
        return json(res, 200, {
          exists: info.exists,
          qrAt: info.qrAt,
          ageMs: info.ageMs,
          // ⚠️ 用「账号是否在线」而非「WS 是否连着」——WS 在账号离线时依然在监听，
        //    用 connected 会让面板以为已登录、从而不显示二维码（2026-09-16 事故）。
        loggedIn: onebotHealth.snapshot().online === true,
          onebotError: onebot.lastConnectError || '',
          self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
        });
      }

      if (pathname === '/api/snowluma/qr.png' && method === 'GET') {
        const got = readQrBuffer(snowlumaDir());
        if (!got) return json(res, 404, { error: '暂无二维码（已登录，或 NapCat 未在等待扫码）' });
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'content-length': got.buffer.length
        });
        return res.end(got.buffer);
      }

      // ── NapCat 登录代理（账密登录 / 人机验证 / 新设备）──
      // 目的：QQ 风控掉线后，用户可在面板里用账号密码自助登录，不必找管理员扫码。
      // 安全：**密码明文不出浏览器**（前端算 MD5 后只传 passwordMd5），
      //       整个 /api/snowluma/* 已在 nginx Basic Auth 之后。
      if (pathname === '/api/snowluma/login/info' && method === 'GET') {
        return json(res, 200, napcatWebui.info(snowlumaDir()));
      }

      if (pathname === '/api/snowluma/login/status' && method === 'GET') {
        try {
          const st = await napcatWebui.loginStatus(snowlumaDir());
          const quick = await napcatWebui.quickList(snowlumaDir()).catch(() => []);
          return json(res, 200, { ok: true, status: st, quickList: quick });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/password' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.uin || !body?.passwordMd5) return json(res, 400, { ok: false, error: '需要 uin 与 passwordMd5' });
          const r = await napcatWebui.passwordLogin(body.uin, body.passwordMd5, snowlumaDir());
          // 三种结果：直接成功(null) / 需要人机验证 / 需要新设备验证
          return json(res, 200, {
            ok: true,
            needCaptcha: !!(r && r.needCaptcha),
            proofWaterUrl: r?.proofWaterUrl || '',
            needNewDevice: !!(r && r.needNewDevice),
            jumpUrl: r?.jumpUrl || '',
            newDevicePullQrCodeSig: r?.newDevicePullQrCodeSig || ''
          });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/captcha' && method === 'POST') {
        try {
          const body = await readBody(req);
          const need = ['uin', 'passwordMd5', 'ticket', 'randstr'];
          for (const k of need) if (!body?.[k]) return json(res, 400, { ok: false, error: '缺少参数 ' + k });
          const r = await napcatWebui.captchaLogin(body.uin, body.passwordMd5, body.ticket, body.randstr, body.sid, snowlumaDir());
          return json(res, 200, {
            ok: true,
            needNewDevice: !!(r && r.needNewDevice),
            jumpUrl: r?.jumpUrl || '',
            newDevicePullQrCodeSig: r?.newDevicePullQrCodeSig || ''
          });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/new-device' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = await napcatWebui.newDeviceLogin(body.uin, body.passwordMd5, body.newDevicePullQrCodeSig, snowlumaDir());
          return json(res, 200, { ok: true, result: r });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 新设备扫码验证：取二维码（str_url 给手机 QQ 扫）
      if (pathname === '/api/snowluma/login/new-device-qr' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.uin || !body?.jumpUrl) return json(res, 400, { ok: false, error: '需要 uin 与 jumpUrl' });
          const r = await napcatWebui.getNewDeviceQr(body.uin, body.jumpUrl, snowlumaDir());
          // 顺手在服务端把 str_url 渲染成二维码 dataURL，前端直接展示
          let qrImage = '';
          try {
            if (r?.str_url) qrImage = await napcatWebui.newDeviceQrDataUrl(r.str_url);
          } catch (e) {
            log('[login] 新设备二维码生成失败:', e?.message ?? e);
          }
          return json(res, 200, { ok: true, qr: r, qrImage });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 新设备扫码验证：轮询状态（3=已扫码 / 1=已确认）
      if (pathname === '/api/snowluma/login/new-device-poll' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.uin || !body?.bytesToken) return json(res, 400, { ok: false, error: '需要 uin 与 bytesToken' });
          const r = await napcatWebui.pollNewDeviceQr(body.uin, body.bytesToken, snowlumaDir());
          return json(res, 200, { ok: true, poll: r });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 设备指纹：查看 / 重置（缓解风控掉线）
      // ── 插件 HTTP 路由分发（2026-10-20 插件化）──
      // 原 anti-ad / grail / welfare 等端点已移入各自插件，由插件注册、内核分发。
      // 好处：卸载插件即卸载端点，前端不会调到已死的接口而报 500。
      const pluginRoute = pluginHost.routes.find((r) => r.method === method && r.path === pathname);
      if (pluginRoute) {
        try {
          // 插件路由：放宽体积上限到 32MB（插件导入要传 base64）
          // 并且**不能**把 readBody 的错误吞成空对象 —— 那会让"包太大"
          // 显示成"缺少数据"，排查方向完全跑偏（实测踩过）。
          let body = null;
          if (method === 'POST') {
            try {
              body = await readBody(req, { limitMB: 32 });
            } catch (error) {
              if (error?.code === 'BODY_TOO_LARGE') {
                return json(res, 413, {
                  ok: false,
                  error: `请求体过大：${(error.sizeBytes / 1024 / 1024).toFixed(1)}MB，`
                    + `上限 32MB。请检查插件包是否异常（正常插件包应小于 20MB）。`
                });
              }
              log(`[插件路由] ${pluginRoute.id} ${pathname} 读请求体失败:`, error?.message ?? error);
              return json(res, 400, { ok: false, error: String(error?.message ?? error) });
            }
          }
          const out = await pluginRoute.handler(req, body, url);
          // raw 响应：插件自己要控制 Content-Type / 下载头（如插件包导出）
          if (out && out.__raw === true && out.buffer) {
            if (res.writableEnded) return;
            res.writeHead(200, {
              'Content-Type': out.contentType || 'application/octet-stream',
              'Content-Length': out.buffer.length,
              'Content-Disposition': `attachment; filename="${encodeURIComponent(out.filename || 'download.bin')}"`
            });
            res.end(out.buffer);
            return;
          }
          if (out !== undefined && !res.writableEnded) return json(res, 200, out);
          return;
        } catch (error) {
          log('[插件路由] ' + pluginRoute.id + ' ' + pathname + ' 出错:', error?.message ?? error);
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 群成员缓存状态（私聊放行策略依赖它）
      if (pathname === '/api/group-members' && method === 'GET') {
        return json(res, 200, { ok: true, ...groupMemberCache.snapshot() });
      }

      // 手动刷新群成员缓存
      if (pathname === '/api/group-members/refresh' && method === 'POST') {
        try {
          const n = await groupMemberCache.refresh();
          return json(res, 200, { ok: true, count: n });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/device' && method === 'GET') {
        try {
          const guid = await napcatWebui.getDeviceGuid(snowlumaDir()).catch((e) => ({ error: String(e?.message ?? e) }));
          const backups = await napcatWebui.getGuidBackups(snowlumaDir()).catch(() => []);
          return json(res, 200, { ok: true, guid, backups });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/device/reset' && method === 'POST') {
        try {
          const r = await napcatWebui.resetDeviceId(snowlumaDir());
          return json(res, 200, { ok: true, result: r });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // ── 账号总览与一键切号（2026-09-16 新增）─────────────────────────────
      // 用户诉求：面板里要能**直接看到后台在线账号并一键切过去**。
      // 原「快速登录」按钮调 SetQuickLoginQQ 只是**设定**、不触发登录，点了没反应（已查明）。
      // 这里改为：透传桌面端已实现好的账号总览与切号能力。
      if (pathname === '/api/accounts/overview' && method === 'GET') {
        try {
          const data = await deskApi('/api/qq/accounts');
          return json(res, 200, { ok: true, data });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/accounts/switch' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.action) return json(res, 400, { ok: false, error: '需要 action' });
          const r = await deskApi('/api/qq/switch', 'POST', body);
          return json(res, 200, r);
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/set-quick' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.uin) return json(res, 400, { ok: false, error: '需要 uin' });
          await napcatWebui.setQuickLogin(body.uin, snowlumaDir());
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/refresh-qr' && method === 'POST') {
        try {
          await napcatWebui.refreshQr(snowlumaDir());
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/stop' && method === 'POST') {
        try {
          const stopped = stopSnowluma();
          return json(res, 200, { ok: true, stopped, embedded: snowlumaStatus().embedded, pid: snowlumaStatus().pid });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/open-folder' && method === 'POST') {
        const dir = snowlumaDir();
        if (!dir) return json(res, 400, { ok: false, error: '找不到 SnowLuma 目录' });
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/snowluma/open-webui' && method === 'POST') {
        const webuiUrl = snowlumaWebuiUrl();
        if (!webuiUrl) return json(res, 400, { ok: false, error: '没有找到 SnowLuma WebUI 地址（等日志出现 listening 后再试）' });
        spawn('cmd.exe', ['/c', 'start', '', webuiUrl], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, webuiUrl });
      }

      // ── 体检/引导相关 ──
      if (pathname === '/api/onebot/groups' && method === 'GET') {
        try {
          const list = await onebot.call('get_group_list');
          const groups = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
          return json(res, 200, { groups });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/onebot/friends' && method === 'GET') {
        try {
          const list = await onebot.call('get_friend_list');
          const friends = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
          return json(res, 200, { friends });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/persona-templates' && method === 'GET') {
        const { PERSONAS, PERSONA_GROUPS } = await import('./personas.js');
        // group 字段供面板下拉分组展示（傻妞系/傲娇系/…）；legacy 模板无 group
        const builtins = Object.entries(PERSONAS).map(([id, p]) => ({
          id, name: p.name, text: p.text, builtin: true, group: p.group || ''
        }));
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: `custom_${i}`,
          name: p.name,
          text: p.text,
          customRules: p.customRules || '',
          builtin: false,
          group: ''
        }));
        return json(res, 200, { templates: [...builtins, ...customs], groups: PERSONA_GROUPS });
      }

      // 用户自定义人设：新增 / 删除
      if (pathname === '/api/persona-templates' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
        // customRules 允许为空
        const entry = { name, text };
        if (String(body.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
        const next = [...(getConfig().customPersonas || []), entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, templates: next });
      }

      const personaDeleteMatch = /^\/api\/persona-templates\/(custom_\d+)$/.exec(pathname);
      if (personaDeleteMatch && method === 'DELETE') {
        const idx = Number(personaDeleteMatch[1].replace('custom_', ''));
        const next = (getConfig().customPersonas || []).filter((_, i) => i !== idx);
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true });
      }

      // ── 多提供商模型目录 ──
      if (pathname === '/api/providers' && method === 'GET') {
        const providers = currentProviders().map((p) => ({
          id: p.id,
          displayName: p.displayName,
          baseURL: p.baseURL,
          apiKey: p.apiKey || '',
          apiKeyFrom: p.apiKeyFrom || '',
          needsBaseUrl: p.needsBaseUrl === true,
          hasKey: !!p.apiKey,
          anthropicOrigin: p.anthropicOrigin === true,
          models: p.models,
          modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers, source: getConfig().providersSourceYaml });
      }

      // 用当前 api 配置拉取模型列表（前端“获取列表”）
      if (pathname === '/api/providers/fetch-models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const cfgNow = getConfig();
          const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
          const apiKey = body.apiKey !== undefined ? String(body.apiKey ?? '') : String(cfgNow.api.apiKey || '');
          const models = await fetchModelsFrom(baseUrl, apiKey);
          return json(res, 200, { ok: true, models });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 测试单个提供商（测试连通性）
      if (pathname === '/api/providers/test-one' && method === 'POST') {
        try {
          const body = await readBody(req);
          const result = await testOneProvider({
            providerId: String(body.providerId ?? ''),
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 用 baseUrl + apiKey + model 发送一次最小 chat 测试请求
      if (pathname === '/api/providers/test-chat' && method === 'POST') {
        try {
          const body = await readBody(req);
          const result = await testModelChat({
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? ''),
            model: String(body.model ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 新增提供商（同 baseURL 自动合并）
      if (pathname === '/api/providers' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? ''),
            models: body.models || []
          });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 给已有提供商追加模型
      if (pathname === '/api/providers/models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: p });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 删除某提供商下的一个模型
      if (pathname === '/api/providers/models' && method === 'DELETE') {
        try {
          const body = await readBody(req);
          const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          return json(res, 200, { ok: true, provider: p });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/providers/set-key' && method === 'POST') {
        const body = await readBody(req);
        const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }

      if (pathname === '/api/providers/test-all' && method === 'POST') {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }

      if (pathname === '/api/vision/results' && method === 'GET') {
        return json(res, 200, { results: visionResults(), scanning: visionScan.running });
      }

      if (pathname === '/api/vision/scan' && method === 'POST') {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await readBody(req).catch(() => ({}));
        const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
        visionScan.running = true;
        emit('vision-scan', { phase: 'start' });
        scanModelsVision({
          providers: currentProviders(),
          emit,
          onlyProviderIds,
          timeoutMs: 25000,
          limit: 3
        })
          .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
          .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { visionScan.running = false; });
        return json(res, 202, { ok: true, started: true });
      }

      if (pathname === '/api/test/api' && method === 'POST') {
        const startedAt = Date.now();
        try {
          const r = await chatCompletion({
            messages: [{ role: 'user', content: '请只回复两个字符：pong' }],
            tools: null,
            temperature: 0
          });
          const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
          return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
        }
      }

      // ── Skill 管理（2026-10-21）──────────────────────────
      //
      // 三种来源统一在这里列出，前端「技能」页据此渲染。
      // 用户自定义的 .md 支持增删改 —— 主人不用写代码就能加知识。
      if (pathname === '/api/skills' && method === 'GET') {
        return json(res, 200, { ok: true, skills: listSkills() });
      }

      // 读单个 skill 的完整正文（内置/插件的也能读，只是不可编辑）
      if (pathname === '/api/skills/one' && method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const s = getSkillBody(id);
        if (!s) return json(res, 404, { ok: false, error: `没有这个 skill：${id}` });
        return json(res, 200, {
          ok: true,
          skill: {
            id: s.id, name: s.name, summary: s.summary, when: s.when,
            source: s.source || 'builtin', content: s.content
          }
        });
      }

      // 新建 / 覆盖**用户** skill（内置与插件的不可改）
      if (pathname === '/api/skills/save' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const id = String(body?.id || '').trim();
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
          return json(res, 400, { ok: false, error: 'id 只能用字母数字下划线连字符，长度 1~64' });
        }
        const existing = listSkills().find((s) => s.id === id);
        if (existing && existing.source !== 'user') {
          return json(res, 400, {
            ok: false,
            error: `「${id}」是${existing.source === 'builtin' ? '内核内置' : '插件提供'}的技能，不能在这里改`
          });
        }
        const content = String(body?.content ?? '').trim();
        if (!content) return json(res, 400, { ok: false, error: '内容不能为空' });

        // 元信息写进 frontmatter，保持「文件即真相」
        const name = String(body?.name || id).trim();
        const summary = String(body?.summary || '').trim();
        const when = String(body?.when || '').trim();
        const lines = ['---', `name: ${name}`];
        if (summary) lines.push(`summary: ${summary}`);
        if (when) lines.push(`when: ${when}`);
        lines.push('---', '');
        const full = `${lines.join('\n')}\n${content}\n`;

        const dir = userSkillDir();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${id}.md`), full, 'utf8');
        reloadUserSkills();
        return json(res, 200, { ok: true, id, note: '已保存，下一轮运行即生效' });
      }

      // 删除用户 skill
      if (pathname === '/api/skills/delete' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const id = String(body?.id || '').trim();
        const existing = listSkills().find((s) => s.id === id);
        if (!existing) return json(res, 404, { ok: false, error: '没有这个 skill' });
        if (existing.source !== 'user') {
          return json(res, 400, { ok: false, error: '只有用户自定义的技能可以删除' });
        }
        try {
          fs.unlinkSync(path.join(userSkillDir(), `${id}.md`));
          reloadUserSkills();
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e?.message ?? e) });
        }
      }

      if (pathname === '/api/config' && method === 'GET') {
        // 兼容层：插件配置同时以旧顶层键暴露（前端无需改动）。见 core/config-compat.js
        return json(res, 200, projectLegacyConfig(cfgNow));
      }

      if (pathname === '/api/config' && method === 'POST') {
        const rawPatch = await readBody(req);
        // 兼容层：前端提交的 antiAd/adInject/welfare 自动落到 plugins.<id>
        const { core: corePatch, plugins: pluginPatch } = splitLegacyPatch(rawPatch);
        const patch = Object.keys(pluginPatch).length
          ? { ...corePatch, plugins: { ...(getConfig().plugins || {}), ...pluginPatch } }
          : corePatch;
        const next = updateConfig(patch);
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 2000);
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        emit('status', { configUpdated: true });
        return json(res, 200, { ok: true, config: next });
      }

      // ── 邮件通道（内核能力，2026-10-25）──
      //
      // 这是**后端基础设施**，不归任何插件。
      // 理由：它和 OneBot token、模型 key 同级 ——
      // 谁能发信、用什么邮箱发，是部署方的事，
      // 不该由某个业务插件替部署方决定。
      //
      // 创造营的邮箱验证码注册会用到这里配的凭据。
      // ── 验证码服务（中心端，2026-10-25）──
      //
      // 架构决定：**验证码是服务方的事，不是部署方的事**。
      //
      // 别人的机器上没有我们的邮箱授权码，也不该为了注册一个作者账号
      // 跑去 QQ 邮箱开 SMTP。所以：
      //   · 中心服务器（这台）暴露 /api/auth/send 和 /api/auth/verify
      //   · 客户端部署的创造营调这两个接口
      //   · 验证码存在中心，不上传、不下发、不经过客户端
      //
      // 这个接口**自带限流**：同邮箱 60 秒一次、同 IP 每小时 20 次。
      // 它是公网接口，必须防刷。
      if (pathname === '/api/auth/send' && method === 'POST') {
        const body = await readBody(req, { limitMB: 1 }).catch(() => ({}));
        const email = String(body?.email || '').trim().toLowerCase();
        if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
          return json(res, 400, { ok: false, error: '邮箱格式不对' });
        }
        if (!mailReady()) {
          return json(res, 503, { ok: false, error: '验证码服务暂时不可用（中心端未配置发信）' });
        }

        // 同邮箱 60 秒
        const last = authSendLog.get(email) || 0;
        if (Date.now() - last < 60 * 1000) {
          const wait = Math.ceil((60 * 1000 - (Date.now() - last)) / 1000);
          return json(res, 429, { ok: false, error: `刚发过，请 ${wait} 秒后再试` });
        }
        // 同 IP 每小时 20 次
        const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
        const now = Date.now();
        const arr = (authIpLog.get(ip) || []).filter((x) => now - x < 3600 * 1000);
        if (arr.length >= 20) {
          return json(res, 429, { ok: false, error: '这个网络发得太频繁了，一小时后再试' });
        }
        arr.push(now);
        authIpLog.set(ip, arr);

        const code = String(crypto.randomInt(100000, 1000000));
        authCodes.set(email, { code, at: now });

        const r = await sendMail(email, '【QQAgent 创造营】注册验证码',
          `你好，\n\n你正在注册 QQAgent 创造营的作者账号。\n\n验证码：${code}\n\n10 分钟内有效。若不是你本人操作，忽略这封邮件。\n\n—— QQAgent 创造营`);
        if (!r.ok) {
          authCodes.delete(email);
          return json(res, 500, { ok: false, error: '发信失败' });
        }
        authSendLog.set(email, now);
        log(`[auth] 验证码已发往 ${email.replace(/^(.{3}).*(@.*)$/, '$1***$2')}`);
        return json(res, 200, { ok: true, message: '验证码已发送' });
      }

      if (pathname === '/api/auth/verify' && method === 'POST') {
        const body = await readBody(req, { limitMB: 1 }).catch(() => ({}));
        const email = String(body?.email || '').trim().toLowerCase();
        const input = String(body?.code || '').trim();
        const rec = authCodes.get(email);
        if (!rec) return json(res, 400, { ok: false, error: '请先获取验证码' });
        if (Date.now() - rec.at > 10 * 60 * 1000) {
          authCodes.delete(email);
          return json(res, 400, { ok: false, error: '验证码已过期，请重新获取' });
        }
        if (input !== rec.code) {
          return json(res, 400, { ok: false, error: '验证码不对' });
        }
        authCodes.delete(email);
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/mail' && method === 'GET') {
        return json(res, 200, {
          ok: true,
          ...mailStatus(),
          hint: 'QQ 邮箱 → 设置 → 账户 → 开启 SMTP 服务 → 生成授权码（16 位）',
        });
      }

      if (pathname === '/api/mail' && method === 'POST') {
        const body = await readBody(req, { limitMB: 1 }).catch(() => ({}));
        const r = saveMailConfig({ user: body?.user, code: body?.code });
        if (r.ok) log(`[mail] 邮件通道已更新：${r.user || '（未设发件人）'}`);
        return json(res, r.ok ? 200 : 400, r);
      }

      if (pathname === '/api/mail' && method === 'DELETE') {
        return json(res, 200, clearMailConfig());
      }

      if (pathname === '/api/mail/test' && method === 'POST') {
        const body = await readBody(req, { limitMB: 1 }).catch(() => ({}));
        const to = String(body?.to || '').trim();
        if (!to) return json(res, 400, { ok: false, error: '请填收件邮箱' });
        const r = await sendMail(to, '【QQAgent】邮件通道测试',
          '这是测试邮件。\n\n收到说明邮件通道配置正确，注册作者时可以收到验证码了。\n\n—— QQAgent');
        return json(res, 200, r.ok ? { ok: true, message: '已发送，请查收（含垃圾箱）' } : { ok: false, error: r.error });
      }

      if (pathname === '/api/models' && method === 'GET') {
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/sessions' && method === 'GET') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
        return json(res, 200, { sessions: sessions.listSummaries(limit) });
      }

      const sessionMatch = /^\/api\/sessions\/([\w-]+)$/.exec(pathname);
      if (sessionMatch && method === 'GET') {
        const s = sessions.get(sessionMatch[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, s);
      }

      if (pathname === '/api/chats' && method === 'GET') {
        const chats = store.listChats().map((key) => ({ key, ...store.getChatMeta(key) }))
          .sort((a, b) => b.lastTs - a.lastTs);
        return json(res, 200, { chats });
      }

      const chatMsgMatch = /^\/api\/chats\/(group|private)_(\d+)\/messages$/.exec(pathname);
      if (chatMsgMatch && method === 'GET') {
        const chatKey = `${chatMsgMatch[1]}:${chatMsgMatch[2]}`;
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        const messages = store.recent(chatKey, { limit }).map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.text, self: m.self, read: m.read, reply: m.reply
        }));
        return json(res, 200, { chatKey, messages });
      }

      // 联网搜索的 key 状态与设置（key 本身**绝不回传**，只回遮影形态）
      if (pathname === '/api/search-keys' && method === 'GET') {
        try {
          const cfg = getConfig();
          const arr = Array.isArray(cfg.webSearch?.anysearchKeys) ? cfg.webSearch.anysearchKeys : [];
          const envCount = [process.env.ANYSEARCH_API_KEY, process.env.ANYSEARCH_API_KEY_2].filter(Boolean).length;
          return json(res, 200, {
            provider: String(cfg.webSearch?.provider || 'auto'),
            envCount,
            configKeys: arr.map((k) => {
              const s = String(k || '');
              return s ? (s.slice(0, 6) + '****' + s.slice(-4)) : '';
            }),
            configKeyCount: arr.filter((x) => String(x || '').trim()).length,
            total: envCount + arr.filter((x) => String(x || '').trim()).length
          });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
      // 保存 key：只接受新填入的值（不回显旧的）；传空字符串表示删除该位
      if (pathname === '/api/search-keys' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          if (!Array.isArray(body.keys)) return json(res, 400, { ok: false, error: 'keys 必须是数组' });
          const rawKeys = body.keys.map((k) => String(k ?? '').trim());
          // 判定用户意图：
          //   · 全部为空且显式传了 allowClear → 清空
          //   · 全部为空但没授权清空  → 保留原值（防误点保存把 key 清掉）
          //   · 有新值                → 用新值替换（遮影值 **** 不参与）
          const newOnes = rawKeys.filter((k) => k && !k.includes('****'));
          const hadMasked = rawKeys.some((k) => k.includes('****'));
          const prev = Array.isArray(getConfig().webSearch?.anysearchKeys) ? getConfig().webSearch.anysearchKeys : [];
          let next;
          if (newOnes.length) {
            // 有新填的：替换（若同时含遮影项，说明用户想保留其余，这里简单起见以新值为准）
            next = newOnes;
          } else if (hadMasked) {
            // 只有遮影项 = 用户没改，保持原样
            next = prev;
          } else if (body.allowClear === true) {
            next = [];
          } else {
            next = prev;   // 空提交且未授权清空 → 不动
          }
          updateConfig({ webSearch: { ...(getConfig().webSearch || {}), anysearchKeys: next } });
          return json(res, 200, { ok: true, saved: next.length, unchanged: next === prev });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
      // 能力总览：工具清单 + 关键功能状态（供设置页展示）
      // ── 能力总览（2026-10-21 插件化重构）──
      // 工具现在来自两处：内核基础工具 + 各插件注册的工具。
      // 分组依据从"写死的正则表"改成"它属于谁"——
      // 这样面板展示的就是真实的架构：内核负责聊天骨架，其余全是插件。
      if (pathname === '/api/capabilities' && method === 'GET') {
        try {
          const { buildToolDefs } = await import('./tools.js');
          const coreDefs = buildToolDefs().filter((d) => d && d.name);

          // 插件工具：从宿主拿，带上是哪个插件提供的
          const pluginRows = [];
          const pluginMeta = [];
          for (const rec of pluginHost.records.values()) {
            if (rec.status !== 'enabled') {
              if (rec.manifest) {
                pluginMeta.push({
                  id: rec.id,
                  name: rec.manifest.name,
                  status: rec.status,
                  toolCount: 0,
                  tools: [],
                  lastError: rec.lastError || null
                });
              }
              continue;
            }
            const owned = pluginHost.toolDefs.filter((t) => t.id === rec.id).map((t) => t.def);
            for (const d of owned) {
              pluginRows.push({
                name: d.name,
                group: rec.manifest?.name || rec.id,
                pluginId: rec.id,
                description: String(d.description || '').slice(0, 200),
                masterOnly: !!d.masterOnly,
                params: Object.keys(d.parameters?.properties || {})
              });
            }
            pluginMeta.push({
              id: rec.id,
              name: rec.manifest?.name || rec.id,
              version: rec.manifest?.version || '?',
              status: rec.status,
              toolCount: owned.length,
              tools: owned.map((d) => d.name),
              lastError: null
            });
          }

          // 内核工具：统一归到「基础（内核）」
          const coreRows = coreDefs.map((d) => ({
            name: d.name,
            group: '基础 · 内核',
            description: String(d.description || '').slice(0, 200),
            masterOnly: !!d.masterOnly,
            params: Object.keys(d.parameters?.properties || {})
          }));

          const tools = [...coreRows, ...pluginRows];

          // 关键功能状态
          let schedule = null;
          try {
            const SQ = await import('./schedule-query.js');
            const tmr = SQ.localDate(SQ.shiftDate(1));
            const r = SQ.getDaySchedule(tmr);
            schedule = { ok: !!r.ok, tomorrow: tmr, count: r.count || 0, range: r.range || null };
          } catch (e) { schedule = { ok: false, error: String(e?.message || e) }; }
          const cfg = getConfig();
          let scheduled = { count: 0, items: [] };
          try {
            const ST = await import('./scheduled-tasks.js');
            const list = ST.listTasks().filter((t) => t.enabled);
            scheduled = { count: list.length, items: list.slice(0, 8).map((t) => ST.describeTask(t)) };
          } catch (e) { scheduled = { count: 0, items: [], error: String(e?.message || e) }; }
          const hasAnyKey = !!(process.env.ANYSEARCH_API_KEY || process.env.ANYSEARCH_API_KEY_2);
          const searchProvider = String(cfg.webSearch?.provider || 'auto');
          return json(res, 200, {
            tools,
            total: tools.length,
            coreTotal: coreRows.length,
            pluginTotal: pluginRows.length,
            plugins: pluginMeta.sort((a, b) => a.id.localeCompare(b.id)),
            features: {
              schedule,
              scheduleNotify: {
                enabled: cfg.plugins?.schedule?.notifyEnabled === true,
                time: cfg.plugins?.schedule?.notifyTime || '21:00'
              },
              identityModes: Object.entries(cfg.identityModes || {}).map(([k, v]) => ({ id: k, label: v?.label || k, enter: v?.enter || [], exit: v?.exit || [] })),
              personaModes: cfg.personaModes || {},
              customPersonas: (cfg.customPersonas || []).map((p) => p.name),
              kb: (() => { try { return fs.existsSync(path.join(DATA_DIR, 'knowledge', 'securities')) ? 'ok' : 'missing'; } catch { return 'unknown'; } })(),
              search: {
                enabled: cfg.webSearch?.enabled !== false,
                provider: searchProvider,
                anysearchAvailable: hasAnyKey,
                effective: searchProvider === 'bing'
                  ? 'Bing 网页抓取'
                  : (searchProvider === 'anysearch'
                    ? (hasAnyKey ? 'AnySearch' : 'AnySearch（未配置 key，会失败）')
                    : (hasAnyKey ? 'AnySearch（失败自动回退 Bing）' : 'Bing（未配置 AnySearch key）'))
              },
              scheduled
            }
          });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      // 补报 DSH 任务：任务已完成但没汇报时（或通知链路故障后），让机器人现在汇报一次
      if (pathname === '/api/dsh/report' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const workDir = String(body.workDir ?? '').trim();
          // 默认发给配置里的主人（不再硬编码某个 QQ 号）
          const masterQQ = String(getConfig().persona?.masterQQ || '');
          const chatKey = String(body.chatKey ?? (masterQQ ? `private:${masterQQ}` : '')).trim();
          if (!workDir) return json(res, 400, { ok: false, error: 'workDir 必填' });
          const fsmod = await import('node:fs');
          const pathmod = await import('node:path');
          if (!fsmod.existsSync(workDir)) return json(res, 404, { ok: false, error: '目录不存在' });
          const items = fsmod.readdirSync(workDir, { withFileTypes: true });
          const files = [];
          for (const it of items) {
            const p = pathmod.join(workDir, it.name);
            if (it.isDirectory()) {
              let n = 0; try { n = fsmod.readdirSync(p).length; } catch {}
              files.push({ name: it.name + '/', size: 0, dir: true, entries: n });
            } else {
              let sz = 0; try { sz = fsmod.statSync(p).size; } catch {}
              files.push({ name: it.name, size: sz, dir: false });
            }
          }
          const real = files.filter((f) => (f.dir ? (f.entries || 0) > 0 : (f.size || 0) > 0));
          let reportFile = '', reportText = '';
          const cand = real.find((f) => !f.dir && /回给主人|汇报|report|summary/i.test(f.name) && /\.(txt|md)$/i.test(f.name));
          if (cand) {
            reportFile = cand.name;
            try { reportText = fsmod.readFileSync(pathmod.join(workDir, cand.name), 'utf8').slice(0, 2500); } catch {}
          }
          orchestrator.wake(chatKey, {
            proactive: true,
            taskContext: {
              kind: 'DSH 后台任务（补报）',
              name: pathmod.basename(workDir),
              taskText: String(body.taskText || '').slice(0, 400),
              workDir, files: real, empty: !real.length,
              reportFile, reportText
            }
          }).catch(() => {});
          return json(res, 200, { ok: true, fileCount: real.length, reportFile });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      const chatWakeMatch = /^\/api\/chats\/(group|private)_(\d+)\/wake$/.exec(pathname);
      if (chatWakeMatch && method === 'POST') {
        const chatKey = `${chatWakeMatch[1]}:${chatWakeMatch[2]}`;
        const ok = orchestrator.forceWake(chatKey);
        return json(res, 200, { ok });
      }

      // 手动发一条测试消息（不走模型，直接经 OneBot 发出，用于配置后验证链路）
      const chatTestSendMatch = /^\/api\/chats\/(group|private)_(\d+)\/test-send$/.exec(pathname);
      if (chatTestSendMatch && method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        try {
          const chatKey = `${chatTestSendMatch[1]}:${chatTestSendMatch[2]}`;
          const data = await onebot.sendText(chatTestSendMatch[1], chatTestSendMatch[2], text);
          store.appendSelf(chatKey, { text, ts: Date.now() });
          emit('chat-update', chatKey);
          return json(res, 200, { ok: true, messageId: data?.message_id ?? null });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      const chatReadMatch = /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/.exec(pathname);
      if (chatReadMatch && method === 'POST') {
        const chatKey = `${chatReadMatch[1]}:${chatReadMatch[2]}`;
        const drained = store.drainUnread(chatKey);
        return json(res, 200, { ok: true, marked: drained.length });
      }

      if (pathname === '/api/pause' && method === 'POST') {
        const body = await readBody(req);
        const wasPaused = orchestrator.paused;
        orchestrator.setPaused(!!body.paused);
        if (wasPaused && !orchestrator.paused && !body.skipBacklog) {
          // 恢复时自动补处理暂停期间积压的未读消息
          orchestrator.drainBacklogAfterResume();
        }
        return json(res, 200, { ok: true, paused: orchestrator.paused });
      }

      // 恢复运行，并把所有会话当前未读一次性标记为已读（用户明确选择丢弃积压）
      if (pathname === '/api/pause' && method === 'DELETE') {
        orchestrator.setPaused(false);
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = store.drainUnread(chatKey).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        return json(res, 200, { ok: true, paused: false, marked });
      }

      return json(res, 404, { error: `未知 API：${method} ${pathname}` });
    }

    // ── 插件前端静态资源（2026-10-21）──
    //
    // 目的：**插件的前端代码必须放在插件自己的目录里**，不许写进内核 ui/app.js。
    //
    //   /plugin-ui/<id>/<file>  →  plugins/<id>/<file>
    //
    // 例：plugins/grail/ui.js → /plugin-ui/grail/ui.js
    //
    // 安全：只允许字母数字下划线连字符与点，且限制在 plugins/<id>/ 内，
    //      不允许 ../ 逃逸。
    if (req.method === 'GET' && pathname.startsWith('/plugin-ui/')) {
      const rest = pathname.slice('/plugin-ui/'.length);
      const m = /^([a-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/.exec(rest);
      if (!m) { res.writeHead(400); res.end('Bad plugin path'); return; }
      const [, pid, fname] = m;
      if (fname.includes('..')) { res.writeHead(403); res.end(); return; }
      const full = path.join(PLUGINS_DIR, pid, fname);
      if (!full.startsWith(path.join(PLUGINS_DIR, pid))) { res.writeHead(403); res.end(); return; }
      try {
        const data = fs.readFileSync(full);
        const ext = path.extname(fname);
        const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };
        res.writeHead(200, {
          'content-type': types[ext] ?? 'application/octet-stream',
          'cache-control': 'no-cache'
        });
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Plugin asset not found');
        return;
      }
    }

    // 静态 UI
    if (req.method === 'GET') {
      let file = pathname === '/' ? '/index.html' : pathname;
      file = file.replace(/\.\./g, '');
      const fullPath = path.join(UI_DIR, file);
      if (!fullPath.startsWith(UI_DIR)) { res.writeHead(403); res.end(); return; }
      try {
        let data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
        // index.html 里给 app.js / style.css 注入基于 mtime 的版本号，
        // 这样每次更新前端代码后浏览器会自动拉新文件（避免"改了没生效"的缓存问题）
        if (ext === '.html') {
          const stamp = (f) => { try { return Math.floor(fs.statSync(path.join(UI_DIR, f)).mtimeMs).toString(36); } catch { return '0'; } };
          // 用相对路径 + 版本号：
          //   · 浏览器在 /qqbot/ 下访问 './app.js' → 自动解析为 /qqbot/app.js（Nginx 反代正确）
          //   · 本地直连 3210 时解析为 /app.js（也对）
          //   · 这样既拿到缓存失效，又不依赖 Nginx 的 sub_filter 改写
          data = Buffer.from(
            data.toString('utf8')
              // 令牌文件也要带指纹：改配色后浏览器必须拿到新令牌（否则浅色/深色混搭）
              .replace('href="/paper-ink-light.css"', 'href="./paper-ink-light.css?v=' + stamp('/paper-ink-light.css') + '"')
              .replace('href="/style.css"', 'href="./style.css?v=' + stamp('/style.css') + '"')
              .replace('src="/app.js"', 'src="./app.js?v=' + stamp('/app.js') + '"'),
            'utf8'
          );
        }
        res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    res.writeHead(404);
    res.end();
  }

  // ── 启停 ──
  // DSH 自动导入已移除：模型目录改为在设置页手动维护（见 /api/providers 相关接口）。

  // ── 启停 ──
  async function listenOn(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(port); // 必须把实际端口传回去，Electron 壳要用它加载页面
      });
    });
  }

  async function start() {
    // 先把 HTTP 服务拉起来，让窗口/浏览器立刻能加载页面（loading 壳）
    const basePort = Number(getConfig().server?.port) || 3210;
    let port = null;
    let lastError = null;
    for (let p = basePort; p < basePort + 10; p++) {
      try {
        port = await listenOn(p);
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE') throw error;
      }
    }
    if (port == null) throw lastError ?? new Error('无法监听端口');

    // 启动账号健康探针（60 秒一次）
    onebotHealth.start();
    qrGuard.start();
    groupMemberCache.start();

    // ── 装载插件（2026-10-20 插件化）──
    // 任何插件坏掉都不影响内核：宿主内部逐个隔离，只记 failed。
    try {
      const loaded = await pluginHost.loadAll();
      const bad = loaded.filter((p) => p.status === 'failed');
      log(`[plugins] 已装载 ${loaded.filter((p) => p.status === 'enabled').length} 个插件`
        + (bad.length ? `，${bad.length} 个失败：${bad.map((b) => b.id).join(', ')}` : ''));
    } catch (error) {
      log('[plugins] 装载过程异常（内核继续启动）:', error?.message ?? error);
    }

    // 拉起 SnowLuma（如配置了自动启动）、连 OneBot。
    if (getConfig().snowluma?.autoLaunch) {
      try {
        const wsPort = snowlumaWsPort();
        if (!(await isPortOpen('127.0.0.1', wsPort))) {
          const r = await launchSnowluma();
          if (r.ok && r.launched) {
            for (let i = 0; i < 20 && !(await isPortOpen('127.0.0.1', wsPort)); i++) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        }
      } catch (error) {
        log('[snowluma] 自动启动失败:', error?.message ?? error);
      }
    }
    // OneBot 连接前先尝试从 SnowLuma 配置同步令牌（脱敏副本/首次登录场景尤其重要）
    if (syncSnowlumaTokens()) {
      const c = getConfig();
      onebot.wsUrl = String(c.snowluma?.wsUrl || onebot.wsUrl);
      onebot.httpUrl = String(c.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      onebot.accessToken = String(c.snowluma?.accessToken || '');
      onebot.httpToken = String(c.snowluma?.httpAccessToken || c.snowluma?.accessToken || '');
    }
    await onebot.connect();
    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    orchestrator.startDshWatcher(); // DSH 任务完成汇报 watcher
    // 课程播报的启动逻辑在 schedule 插件里（插件启用且 notifyEnabled 才跑）
    scheduledRunner.start();   // 通用定时任务调度器

    // ── 内核自动检查更新（2026-10-25）──
    //
    // 只查、只提示、可选自动下载 —— **绝不自动安装**。
    // 理由见 src/kernel-update.js 顶部：整包替换第三方宿主出过真实事故。
    startKernelAutoCheck();

    log(`控制台已就绪：http://127.0.0.1:${port}`);
    log(`OneBot（SnowLuma）: ws=${getConfig().snowluma?.wsUrl} http=${getConfig().snowluma?.httpUrl}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    return port;
  }

  /**
   * 内核更新自动检查（2026-10-25）
   *
   * 行为：
   *   · 启动 60 秒后查一次（避开启动高峰）
   *   · 之后按 config.kernelUpdate.checkIntervalHours 周期查（默认 24h）
   *   · 查到新版 → 记进 config.lastSeenVersion，前端「关于」页显示提示
   *   · autoDownload=true 时顺带下载并校验（仍不安装）
   *   · 网络不通只记日志，不影响任何功能
   */
  let _kernelCheckTimer = null;
  function startKernelAutoCheck() {
    const cfgNow = getConfig().kernelUpdate || {};
    if (cfgNow.autoCheck === false) return;

    const runOnce = async () => {
      try {
        const r = await checkKernelUpdate();
        if (!r.ok) {
          // 网络问题不当错误刷日志，降级为 debug 级
          log(`[内核更新] 检查失败（不影响运行）：${r.error}`);
          return;
        }
        updateConfig({ kernelUpdate: { lastCheckAt: new Date().toISOString() } });
        if (!r.hasUpdate) return;

        log(`[内核更新] 发现新版本 ${r.latest}（当前 ${r.current}）`);
        updateConfig({ kernelUpdate: { lastSeenVersion: r.latest } });

        if (cfgNow.autoDownload === true) {
          log('[内核更新] 已开启自动下载，开始下载…');
          const d = await downloadKernelUpdate();
          if (d.ok && !d.upToDate) {
            log(`[内核更新] 已下载 v${d.version} → ${d.file}（校验${d.verified ? '通过' : '跳过'}），等待手动安装`);
          } else {
            log(`[内核更新] 下载失败：${d.error || '未知'}`);
          }
        }
      } catch (e) {
        log(`[内核更新] 自动检查异常：${e?.message ?? e}`);
      }
    };

    // 启动 60 秒后首次检查
    setTimeout(runOnce, 60000).unref?.();

    const hours = Math.max(1, Number(cfgNow.checkIntervalHours) || 24);
    _kernelCheckTimer = setInterval(runOnce, hours * 3600 * 1000);
    _kernelCheckTimer.unref?.();
  }

  async function stop() {
    if (_kernelCheckTimer) { clearInterval(_kernelCheckTimer); _kernelCheckTimer = null; }
    onebotHealth.stop();
    qrGuard.stop();
    groupMemberCache.stop();
    await orchestrator.abortAll();
    onebot.close();
    server.close();
    // 内置启动的 SnowLuma：QQ Agent 退出时一并关掉，避免留一个无窗口的后台进程
    try { snowlumaProc?.kill(); } catch { /* ignore */ }
  }

  return {
    server, onebot, store, memory, stickers, sender, sessions, orchestrator,
    start, stop, emit, getConfig, updateConfig,
    launchSnowluma, stopSnowluma, snowlumaStatus, onebotHealth, qrGuard,
    groupMemberCache, pluginHost
  };
}
