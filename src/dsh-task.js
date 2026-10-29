// DSH 任务转发客户端：把主人的 agent 需求提交给本机 DSH 执行。
// 协议：POST http://127.0.0.1:3080/api/<method>，body = client-request 信封。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

// 🔴 DSH 地址探测（2026-10-28 修）
//
// 事故：dsh_task 一直报「任务提交失败：fetch failed」。
// 根因：这里写死 3080，但本机 DSH 实际跑在 **3083**（A 实例是 3084）。
//      3080 根本没进程监听 → 连接被拒 → fetch failed。
//
// 本机会跑多个 DSH 实例（C=3083 / A=3084），端口不固定。
// 写死任何一个都会在换实例/换机器后失效，所以改成：
//   ① 环境变量 DSH_BASE_URL 优先（显式指定永远最高）
//   ② 否则按候选端口探测，谁活着用谁
//   ③ 探测失败时给出**可操作的**错误，而不是 bare 的 fetch failed
const DSH_CANDIDATES = [
  'http://127.0.0.1:3083',   // C 实例（本机主用）
  'http://127.0.0.1:3084',   // A 实例
  'http://127.0.0.1:3080',   // 历史默认
];

let dshBaseCache = null;

/** 探测活着的 DSH 地址（结果缓存 60 秒，避免每次调用都探） */
async function resolveDshBase() {
  if (process.env.DSH_BASE_URL) return String(process.env.DSH_BASE_URL).replace(/\/+$/, '');
  if (dshBaseCache && Date.now() - dshBaseCache.at < 60000) return dshBaseCache.url;

  for (const url of DSH_CANDIDATES) {
    try {
      const res = await fetch(url + '/', { method: 'GET', signal: AbortSignal.timeout(2500) });
      if (res.ok || res.status < 500) {
        dshBaseCache = { url, at: Date.now() };
        return url;
      }
    } catch { /* 试下一个 */ }
  }
  throw new Error(
    '连不上 DSH。已试过 ' + DSH_CANDIDATES.join(' / ') + '。'
    + '请确认 DSH 实例在运行（systemctl status 或 ss -tlnp | grep 308），'
    + '或用环境变量 DSH_BASE_URL 指定正确地址。'
  );
}
// 部署目录不固定（历史上是 /root/BG-QQagent-Linux），跟着项目根走，换机器/换路径都不用改代码。
// 🔴 工作目录改到用户指定的《鱼鱼的工作目录》（2026-10-28）
//
// 用户："我创建了一个《鱼鱼的工作目录》，以后她的外包对话全部放到这里"
// 原来散在项目里的 dsh-work/，用户看不到她干了什么。
// 现在统一放到 /home/lyy/鱼鱼的工作目录/，她自己也能在里面按任务建子目录。
const YUYU_DIR = process.env.QQ_AGENT_YUYU_DIR || '/home/lyy/鱼鱼的工作目录';
const WORK_ROOT = process.env.QQ_AGENT_WORK_ROOT || YUYU_DIR;
const WORKSPACE_DIR = path.join(ROOT, 'workspace');

let rpcSeq = 1;

/**
 * 调用 DSH 的 typert 网关（2026-10-28 重写）
 *
 * 🔴 原来的实现全是错的，所以 dsh_task 从来就没通：
 *   ① 端点写成 `session.list`（点号）→ 真实是 `session/list`（斜杠）
 *   ② 连的端口 3080 没有进程监听
 *   ③ 调了个不存在的 `workspace.create`（DSH 根本没有这个方法，
 *      建会话只要传 cwd，不需要 workspaceId）
 *   ④ payload 直接传对象 → 网关要求包一层 `{ args: { request: {...} } }`
 *
 * 正确的调用形态（实测）：:
 *   POST http://127.0.0.1:3083/api/session/list
 *   { "type":"client-request", "rpcId":"...", "method":"session/list",
 *     "payload": { "args": { "request": {} } } }
 *   → { "type":"server-response", "result": { "ok":true, "value":{...} } }
 *
 * @param {string} endpoint  形如 'session/list'（用斜杠）
 * @param {object} args      会包成 { args: { request: args } }
 */
async function rpc(endpoint, args = {}, timeoutMs = 60000) {
  const base = await resolveDshBase();
  const name = String(endpoint).replace(/\./g, '/');
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'qqa_' + (rpcSeq++),
    method: name,
    // 🔴 参数名各端点不同（2026-10-28 实测）
    //   session/list   → { args: { _request: {} } }
    //   session/create → { args: { request: {...} } }
    //   session/prompt → { args: { request: {...} } }
    // 用错了会被网关按 schema 拒掉（missing "_request" / unexpected "request"）。
    payload: { args: name === 'session/list' ? { _request: args || {} } : { request: args || {} } }
  });
  const res = await fetch(`${base}/api/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`DSH RPC ${name} HTTP ${res.status}`);
  const data = await res.json();
  const r = data?.result;
  if (!r?.ok) throw new Error(`DSH ${name} 失败: ${r?.error?.message || r?.error?.code || 'unknown'}`);
  return r.value;
}

/**
 * 把任务整理成一句人能看懂的标题（2026-10-28）
 *
 * 用户要求："标题要她自己整理好，我想看的时候要可以看到她干了什么"
 *
 * 不做花哨生成，只做三件事：
 *   ① 去掉"帮我/请你/麻烦"这类客套开头
 *   ② 去掉换行和多余标点，压成一行
 *   ③ 超长截断到 28 字（够看清做什么，又不至于文件名离谱）
 *
 * 为什么不用模型生成标题：这里只是写文件名的辅助函数，
 * 为了一个标题再调一次模型不值当，而且会拖慢任务提交。
 */
function humanTitle(name, taskText) {
  let s = String(name || '').trim();
  if (!s || s.length < 4) s = String(taskText || '').trim();

  s = s
    .replace(/^(帮我|帮忙|请你|请|麻烦你?|给我|替我)\s*/g, '')
    .replace(/^\d+[.、)]\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(/[。！？!?]+$/g, '')
    .trim();

  // 取第一句（任务描述常有多行，标题只留最核心那句）
  let firstLine = s.split(/[。\n；;]/)[0].trim() || s;

  // 去掉"在当前目录/在 dsh-work/请在"这类执行细节 —— 标题该说"做什么"，
  // 不该说"在哪做"。实测「在当前目录创建 worklog-test.txt」读起来像操作日志。
  firstLine = firstLine
    .replace(/^(在|从)[^，,]{0,12}(目录|文件夹|下)\s*/g, '')
    .replace(/^(当前|这个|该)\s*(目录|文件夹)\s*/g, '')
    .trim();

  // 截断时按整词切，避免把 worklog-test.txt 切成 .tx
  if (firstLine.length > 26) {
    const cut = firstLine.slice(0, 26);
    const lastSpace = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('，'));
    firstLine = (lastSpace > 12 ? cut.slice(0, lastSpace) : cut) + '…';
  }
  return firstLine || '未命名任务';
}

/** 安全目录名：去掉路径分隔和特殊字符 */
function safeDirName(name) {
  return String(name || 'task')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/\.\./g, '')
    .slice(0, 60);
}

/** 统一工作目录：所有 QQ 转发的 DSH 任务都在同一目录下执行。
 *  为什么统一：早期每个任务建一个子目录（dsh-work/<任务名>/），导致
 *    ① 目录爆炸、难以管理；② **同名任务会 rmSync 掉旧目录，误删上一次的产物**
 *       （如部署脚本 apply.sh）；③ 任务之间无法共享上下文文件。
 *  现在：所有任务共用 WORK_ROOT，靠「任务标题」区分；每次提交在 WORK_ROOT/.tasks/ 里
 *  记一条任务记录，产物直接落在 WORK_ROOT（DSH 侧自会按需建子文件）。
 *  ⚠️ 不再 rmSync 整个目录——那会删掉别的任务的产物。 */
/** 带重试的 RPC：DSH 高负载时单次调用容易超时，
 *  但"超时"不等于失败（请求可能已生效），因此重试是安全的（这些接口都幂等）。 */
async function rpcRetry(method, payload, { tries = 3, timeoutMs = 60000 } = {}) {
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try {
      return await rpc(method, payload, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (i < tries) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw lastErr;
}

export async function submitDshTask(taskText, { taskName = '', preset = '' } = {}) {
  const name = safeDirName(taskName || taskText.slice(0, 24));
  const workDir = WORK_ROOT;                       // ← 统一目录
  fs.mkdirSync(workDir, { recursive: true });

  // 任务档案：记录本次任务（标题用于区分，不再用作目录名）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const taskId = `${stamp}_${name}`;
  // ── 工作记录（2026-10-28 重做）──
  //
  // 用户："我看不到她的工作记录…以后她的外包对话全部放到这里，
  //        而且标题要她自己整理好，我想看的时候要可以看到她干了什么"
  //
  // 原来按天一个大 md 追加，标题只是截取任务前 24 字 ——
  // 翻起来像日志，看不出"她干了哪几件事"。
  //
  // 现在：**一个任务一个文件**，文件名带时间和整理好的标题，
  // 结构固定（标题 / 什么时候 / 为什么派出去 / 交给 DSH 的原话 / 结果），
  // 面板列表里一眼能扫完她做过什么。
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  const title = humanTitle(name, taskText);
  const recordFile = `${day} ${time.replace(/:/g, '')} ${title}.md`.replace(/[\\/:*?"<>|]/g, '-');
  try {
    const dialogDir = path.join(WORK_ROOT, '对话记录');
    fs.mkdirSync(dialogDir, { recursive: true });
    fs.writeFileSync(path.join(dialogDir, recordFile), [
      `# ${title}`,
      '',
      `**时间**：${day} ${time}（北京时间）`,
      `**交给**：本机 dshc`,
      `**会话**：${taskId}`,
      '',
      '## 我为什么派出去',
      '',
      '这类活需要跑代码/处理文件，我自己做不了，所以交给 dshc。',
      '',
      '## 我给 dshc 的原话',
      '',
      '```',
      String(taskText).slice(0, 3000),
      '```',
      '',
      '## 结果',
      '',
      '（完成后自动补进来）',
      ''
    ].join('\n'), 'utf8');
  } catch { /* 记录失败不影响任务 */ }

  try {
    const tasksDir = path.join(workDir, '.tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, taskId + '.json'), JSON.stringify({
      taskId, name, taskText: String(taskText).slice(0, 4000), submittedAt: Date.now()
    }, null, 2), 'utf8');
  } catch { /* 档案写失败不影响任务 */ }

  // 1. 先建/复用 workspace（2026-10-28 修正）
  //
  // 用户反馈："为什么她的外包任务都进了 dsh 的未分组"
  //
  // 🔴 更正我之前的错误结论：`workspace/create` **是存在的**。
  //    我上次搜端点时漏了它，误判成"DSH 没有这个方法"，改成只传 cwd ——
  //    会话确实能建，但没有分组，全落进「未分组」。
  //
  //    workspace 的标题就是分组名（取 path 的最后一段），
  //    所以工作目录叫《鱼鱼的工作目录》→ 分组名就是中文的。
  //    同一 path 重复调用返回同一个 workspaceId，可以放心每次都建。
  let workspaceId = '';
  try {
    const ws = await rpcRetry('workspace/create', { path: String(workDir) }, { tries: 2 });
    workspaceId = ws?.workspace?.workspaceId || '';
  } catch { /* 建不了 workspace 也要能建会话，退回 cwd 模式 */ }

  // 2. 建会话：优先挂到 workspace（这样才不是"未分组"）
  const params = workspaceId ? { workspaceId } : { cwd: String(workDir) };
  if (preset) params.agentPreset = preset;
  const sess = await rpcRetry('session/create', params, { tries: 3 });
  const sessionId = sess?.sessionId;
  if (!sessionId) throw new Error('session/create 未返回 sessionId');

  // 3. 用**中文标题**命名会话（2026-10-28）
  //
  // 用户："标题不要英文，要方便我能看懂的中文"
  // 原来直接用调用方传的 taskName（heybox-reverse / mt-verify-probe 这类英文短名），
  // 在 DSH 列表里根本看不出干了什么。现在统一走 humanTitle()。
  // 改名要**重试**：刚建完会话时 title 可能被初始化流程覆盖掉。
  // 实测：建完立刻 rename 返回 ok，但列表里仍是英文/空 —— 过一会儿再改才稳。
  for (let i = 0; i < 3; i++) {
    try {
      await rpc('session/rename', { sessionId, title: title.slice(0, 60) }, 15000);
    } catch { /* 单次失败继续试 */ }
    await new Promise((r) => setTimeout(r, 1200));
  }
  // 3. 提交任务（queue 模式异步执行）
  const promptText = `【QQ 主人任务 · 小白鲸转发】任务名：${name || '(未命名)'}
请完成以下任务：
${taskText}

要求：
1. 产物写在当前工作目录（统一目录，注意不要覆盖其他任务的既有文件；
   如需独立空间可自建子目录，子目录名建议带本次任务名：${name}）
2. 完成后在回复里明确说「任务完成」并列出产物文件
3. 不要改动服务器系统配置（/etc、服务、DSH 配置等）
4. 如果任务无法完成，说明原因`;
  // requestId 是必填的（schema 要求），用 taskId 当幂等键
  const accepted = await rpcRetry('session/prompt', {
    requestId: taskId,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: promptText }]
  }, { tries: 3, timeoutMs: 90000 });
  return { sessionId, workDir, taskId, recordFile, accepted: !!accepted?.accepted };
}

/**
 * 把执行结果写回工作记录（2026-10-28）
 *
 * 提交时只写了"结果（完成后自动补进来）"，
 * 真正跑完要把结果填进去 —— 否则用户翻记录只看到任务，看不到干成什么样。
 *
 * @param {string} recordFile  提交时返回的记录文件名
 * @param {object} state       getDshSessionState 的返回
 * @param {string[]} [files]   产物文件列表（可选）
 */
export function appendRecordResult(recordFile, state, files = []) {
  if (!recordFile) return false;
  try {
    const full = path.join(WORK_ROOT, '对话记录', recordFile);
    if (!fs.existsSync(full)) return false;
    let text = fs.readFileSync(full, 'utf8');
    const lines = [
      `**状态**：${state?.detail || state?.state || '未知'}`,
      `**完成时间**：${new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}`,
      ''
    ];
    if (files.length) {
      lines.push('**产物**：', ...files.slice(0, 30).map((f) => `- \`${f}\``), '');
    }
    lines.push('**产出在哪**：`鱼鱼的工作目录/` 下（或本次会话的子目录）');

    text = text.replace('（完成后自动补进来）', lines.join('\n'));
    fs.writeFileSync(full, text, 'utf8');
    return true;
  } catch { return false; }
}

/** 直接查询 DSH 会话的真实状态（不猜、不推断）。
 *  返回 { state, detail }：
 *    'running'     任务正在跑（DSH 明确说 running=true）
 *    'finished'    任务已结束（running=false 且 turns>0）
 *    'idle'        会话存在但从未运行过（turns=0）
 *    'missing'     列表里没有这个会话
 *    'unreachable' 查询失败（DSH 忙/超时）——**绝不能据此判定失败**
 */
export async function getDshSessionState(sessionId) {
  try {
    const list = await rpc('session.list', {}, 25000);
    const item = (list?.items || []).find((s) => s.sessionId === sessionId);
    if (!item) return { state: 'missing', detail: '会话不在列表中' };
    const stats = item.projections?.values?.sessionStats || {};
    const turns = Number(stats.turns || 0);
    const steps = Number(stats.steps || 0);
    const title = String(item.projections?.values?.title || '');
    if (item.running) return { state: 'running', turns, steps, title, detail: `运行中（${steps} 步）` };
    if (turns > 0) return { state: 'finished', turns, steps, title, detail: `已结束（turns=${turns}, steps=${steps}）` };
    return { state: 'idle', turns, steps, title, detail: '会话存在但尚未运行' };
  } catch (e) {
    // 查询失败：DSH 可能只是忙。重试 3 次，全部失败才回报 unreachable。
    // ⚠️ unreachable 绝不能被当成"任务失败"——它只意味着"现在问不到"。
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const list2 = await rpc('session.list', {}, 30000);
        const item2 = (list2?.items || []).find((s) => s.sessionId === sessionId);
        if (!item2) return { state: 'missing', detail: '会话不在列表中' };
        const stats2 = item2.projections?.values?.sessionStats || {};
        const turns2 = Number(stats2.turns || 0);
        const steps2 = Number(stats2.steps || 0);
        const title2 = String(item2.projections?.values?.title || '');
        if (item2.running) return { state: 'running', turns: turns2, steps: steps2, title: title2, detail: `运行中（${steps2} 步）` };
        if (turns2 > 0) return { state: 'finished', turns: turns2, steps: steps2, title: title2, detail: `已结束（turns=${turns2}, steps=${steps2}）` };
        return { state: 'idle', turns: turns2, steps: steps2, title: title2, detail: '会话存在但尚未运行' };
      } catch { /* 继续重试 */ }
    }
    return { state: 'unreachable', detail: String(e?.message || e) };
  }
}

/** 轮询一个任务是否完成（按 DSH 的**真实状态**判断，不再靠推测）。
 *  设计原则：**只有 DSH 明确说"结束了"才叫完成；只有有确凿证据才叫失败**。
 *  返回 { done, files, reason, state, running } */
export async function pollDshTask(sessionId, workDir, { timeoutMs = 10 * 60 * 1000, intervalMs = 8000 } = {}) {
  const start = Date.now();
  const snapshot = () => {
    try {
      const items = fs.readdirSync(workDir, { withFileTypes: true });
      const files = [];
      for (const it of items) {
        const p = path.join(workDir, it.name);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (it.isDirectory()) {
          let inner = 0;
          try { inner = fs.readdirSync(p).length; } catch {}
          files.push({ name: it.name + '/', size: 0, mtime: st.mtimeMs, entries: inner, dir: true });
        } else {
          files.push({ name: it.name, size: st.size, mtime: st.mtimeMs, dir: false });
        }
      }
      return files;
    } catch { return []; }
  };
  const hasContent = (files) => files.some((f) => (f.dir ? (f.entries || 0) > 0 : (f.size || 0) > 0));

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const files = snapshot();
    const st = await getDshSessionState(sessionId);

    // ── DSH 明确说在跑：什么都不用做，继续等（正常状态，绝不判定失败）──
    if (st.state === 'running') continue;

    // ── DSH 说结束了：看产物，判定完成 ──
    if (st.state === 'finished') {
      const content = hasContent(files);
      return {
        done: true, files, state: 'finished', running: false,
        reason: content ? '会话结束+产物存在' : '会话结束（产物为空）',
        empty: !content
      };
    }

    // ── 查询失败：DSH 忙/超时。**不做任何失败推断**，继续等下一轮 ──
    if (st.state === 'unreachable') continue;

    // ── 会话不存在 / 未运行：可能是提交还在排队，多等几轮再说 ──
    // 只有超过 3 分钟仍未开跑，才算真的异常
    if (Date.now() - start > timeoutMs - 1000) break;
  }
  // 窗口结束仍未结束 → 把当前真实状态带回去，供调用方决定
  const st = await getDshSessionState(sessionId);
  return {
    done: st.state === 'finished',
    files: snapshot(),
    state: st.state,
    running: st.state === 'running',
    timeout: true,
    reason: 'poll-window-ended:' + st.state
  };
}

// ── 待汇报任务注册表（持久化）──────────────────────────────────────────
// dsh_task 提交后注册；orchestrator 的 watcher 轮询此表，完成后主动唤醒机器人汇报。
// ⚠️ 必须落盘：早期用内存 Map，服务一重启任务就"消失"→ 跑完了也没人汇报
//    （2026-09-13 真实事故：修复期间两次重启，schedule-notify 跑完但无人汇报）。

// ── 产物生命周期（分级保留，避免删掉持续性任务的依赖）──────────────
// ⚠️ 设计要点（2026-09-13 修订）：
//   早期实现是"1 小时一律删除"，对**持续性任务**（定时播报、长期服务）是灾难：
//   DSH 产出的部署脚本/配置文件/数据源被删后，后续定时任务就会失败。
//   现在分三级：
//     ① PERSIST（永久保留）：被标记为"持续依赖"的产物——部署件、脚本、数据、定时任务素材
//     ② WORK（24 小时）：普通任务产物（报告、分析、临时文件）
//     ③ DEPLOY（永久）：部署到静态目录的线上资源
//   只有明确属于"一次性任务"的产物才走 24 小时清理。

export const PRODUCT_TTL_MS = 24 * 60 * 60 * 1000;  // 普通产物：24 小时（原为 1 小时，太短）
export const PERSIST_DIR = path.join(WORK_ROOT, '.persist');   // 永久保留区
export const completedTasks = new Map();            // workDir -> completedAt

/** 判断产物是否为「持续性依赖」，需要永久保留。
 *  规则（保守：宁可多留，不可误删）：
 *   - 目录名/文件名含 部署/脚本/配置/数据/课表/定时/服务 等关键词
 *   - 是 .sh/.mjs/.js/.json/.patch 等可执行或配置类文件
 *   - 目录名叫 schedule-* / *-notify / *-service / *-cron 之类 */
const PERSIST_HINTS = /(部署|脚本|配置|数据|课表|定时|服务|调度|deploy|script|config|data|schedule|notify|service|cron|patch|apply|register)/i;
const PERSIST_EXT = /\.(sh|mjs|cjs|js|ts|json|patch|diff|service|timer|conf|yml|yaml)$/i;
export function isPersistentArtifact(name) {
  return PERSIST_HINTS.test(String(name)) || PERSIST_EXT.test(String(name));
}

/** 把一个产物目录/文件搬进永久保留区（持续性任务用）。返回新路径。 */
export function persistArtifact(srcPath) {
  try {
    if (!srcPath || !fs.existsSync(srcPath)) return null;
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    const base = path.basename(srcPath);
    const dest = path.join(PERSIST_DIR, base);
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(srcPath, dest);
    return dest;
  } catch { return null; }
}

/** 登记一个已完成的产物目录（开始计时）。持续性产物直接转入永久区。 */
export function markTaskCompleted(workDir) {
  try {
    if (!workDir || !workDir.startsWith(WORK_ROOT)) return;
    // ⚠️ 绝不能登记 WORK_ROOT 本身：统一工作目录后所有任务的 workDir 都是它，
    //    一旦登记，24 小时后会把整个 dsh-work 删掉（灾难性）。
    const norm = path.resolve(workDir);
    if (norm === path.resolve(WORK_ROOT)) return;
    if (norm === path.resolve(PERSIST_DIR) || norm.startsWith(path.resolve(PERSIST_DIR) + path.sep)) return;
    // 持续性依赖（部署件/脚本/数据）→ 永久保留，不参与清理
    if (isPersistentArtifact(path.basename(workDir))) {
      const moved = persistArtifact(workDir);
      if (moved) { completedTasks.set(moved, Date.now()); return; }
    }
    completedTasks.set(workDir, Date.now());
  } catch { /* 忽略 */ }
}

// 需要 TTL 清理的根目录
const TTL_ROOTS = [
  WORK_ROOT,                                 // DSH 任务产物
  WORKSPACE_DIR,                             // 本地工作文件
  '/var/www/ai-tools/static'                 // 部署到域名的静态资源（只清 qqagent_ 前缀）
];
const DEPLOY_PREFIX = 'qqagent_';

function isTtlCandidate(root, name) {
  if (name === '.persist' || name === '.tasks' || name.startsWith('_')) return false;  // 系统目录不清理
  if (root === '/var/www/ai-tools/static') return name.startsWith(DEPLOY_PREFIX);
  return true;
}

/** 清理过期产物。持续性产物、永久区、系统文件一律不动。 */
export function cleanupExpiredProducts(now = Date.now()) {
  const removed = [];
  // 1. 到期且非持续性的已登记产物
  for (const [dir, completedAt] of [...completedTasks]) {
    if (now - completedAt > PRODUCT_TTL_MS) {
      // 双保险：即便登记了，只要看起来是持续性依赖就不删
      if (isPersistentArtifact(path.basename(dir)) || dir.startsWith(PERSIST_DIR)) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(dir); } catch {}
      completedTasks.delete(dir);
    }
  }
  // 2. 兜底扫描
  for (const root of TTL_ROOTS) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const name of fs.readdirSync(root)) {
        if (!isTtlCandidate(root, name)) continue;
        if (isPersistentArtifact(name)) continue;        // 持续性依赖不清理
        const p = path.join(root, name);
        // 保护：永不删除根目录本身或其永久保留区
        if (path.resolve(p) === path.resolve(root)) continue;
        if (path.resolve(p) === path.resolve(PERSIST_DIR)) continue;
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory() && now - st.mtimeMs > PRODUCT_TTL_MS) {
          const isPending = [...pendingDshTasks.values()].some((e) => e.workDir === p);
          if (!isPending) {
            try { fs.rmSync(p, { recursive: true, force: true }); removed.push(p + ' (24h到期)'); } catch {}
          }
        } else if (!st.isDirectory() && now - st.mtimeMs > PRODUCT_TTL_MS && !st.isSymbolicLink()) {
          if (isPersistentArtifact(name)) continue;
          try { fs.unlinkSync(p); removed.push(p + ' (24h到期)'); } catch {}
        }
      }
    } catch {}
  }
  return removed;
}

const PENDING_FILE = path.join(WORK_ROOT, '_pending-tasks.json');

function loadPending() {
  try {
    const raw = fs.readFileSync(PENDING_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const map = new Map();
    for (const [k, v] of Object.entries(obj || {})) {
      // 只恢复 24 小时内的（更早的没必要再汇报，产物也早被清理）
      if (v && typeof v === 'object' && Date.now() - (v.submittedAt || 0) < 24 * 3600 * 1000) {
        map.set(k, v);
      }
    }
    return map;
  } catch { return new Map(); }
}

export function savePendingTasks() { savePending(pendingDshTasks); }

function savePending(map) {
  try {
    fs.mkdirSync(WORK_ROOT, { recursive: true });
    const obj = {};
    for (const [k, v] of map) obj[k] = v;
    const tmp = PENDING_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
    fs.renameSync(tmp, PENDING_FILE);
  } catch { /* 落盘失败不影响主流程 */ }
}

export const pendingDshTasks = loadPending();

/** 注册待汇报任务（落盘，重启不丢）。 */
export function registerDshTask(entry) {
  pendingDshTasks.set(entry.sessionId, { reported: false, ...entry });
  savePending(pendingDshTasks);
}

/** 从待汇报表移除（落盘同步）。 */
export function unregisterDshTask(sessionId) {
  pendingDshTasks.delete(sessionId);
  savePending(pendingDshTasks);
}

/** 标记已汇报（落盘同步）。 */
export function markDshReported(sessionId, patch = {}) {
  const cur = pendingDshTasks.get(sessionId);
  if (cur) {
    pendingDshTasks.set(sessionId, { ...cur, ...patch, reported: true });
    savePending(pendingDshTasks);
  }
}
