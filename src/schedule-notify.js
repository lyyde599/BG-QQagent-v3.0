// src/schedule-notify.js
// ─────────────────────────────────────────────────────────────────────────────
// 「每晚定时私聊播报次日课程」——应用内调度器（不使用 cron / systemd timer）。
//
// 设计要点：
//   1. 纯应用内：所有改动都在 /root/BG-QQagent-Linux 里，不碰任何系统级配置。
//   2. 到点走 orchestrator.wake(chatKey, { proactive: true, pushTask })，因此自动继承：
//      · 预算熔断 / 全局并发上限 / 暂停状态保护
//      · 私聊配额与"私聊必回"兜底；提醒逻辑写在主提示词里（见 src/prompt.js 的 pushTask 分支）
//   3. 幂等：lastPushDate 落盘（notify_state.json），进程重启、补推逻辑都不会重复推。
//   4. 真·成功判定：wake 返回后回查消息存档，确认真的发出去了（唤醒被暂停/没模型/并发满
//      静默跳过时不算成功），否则经发送队列 SendQueue 兜底直发（同样受防风控限频约束）。
//   5. 失败重试：wake 抛错 → 退避重试 maxAttempts 次；整体失败 → 落盘 pendingRetry，
//      10 分钟后自动重试（可配）。
//   6. 一律用「本地时间」构造日期：服务器时区 Asia/Shanghai，绝不用 toISOString()
//      （那是 UTC，23:00 之后会跨天，把"明天"算错）。
//   7. 三态文案：有课 / 明日无课 / 超出课表范围（2027-01-18 之后）都有话说。
//
// 部署：把本文件拷到 /root/BG-QQagent-Linux/src/schedule-notify.js（见 apply.sh）
// 依赖改动：src/app.js（import/实例化/start/stop/两个 API）、src/orchestrator.js（wake 透传
//          pushTask）、src/prompt.js（渲染播报指令）。详见同目录 功能说明与部署手册.md
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, updateConfig, resolveChatKey } from './config.js';
import { sleep } from './util.js';

const WD_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export const DEFAULT_TIME = '21:00';
const TICK_MS = 20 * 1000;   // 每 20 秒检查一次（到点分钟窗口内必触发；错过也有补推兜底）
const STATE_KEEP = 60;       // 状态文件里保留最近多少天的推送记录

// ── 时间工具（全部本地时区） ────────────────────────────────────────────────

/** 本地日期 → 'YYYY-MM-DD' */
export function localDate(d = new Date()) {
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

/** 本地时间 → 'HH:MM' */
export function localHHMM(d = new Date()) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 今天的日期 + N 天（本地时间，跨月跨年自动处理） */
export function shiftDate(days = 0, base = new Date()) {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

/**
 * 容错解析"推送时间"。接受 21:00 / 21:00:00 / 2100 / 21 等形式。
 * 背景：config.js 的 deepMerge 遇到「非对象覆盖非对象」时会整体替换，
 * 若 config.json 里写成 21（数字），加载后 time 会变成数字，必须容错。
 */
export function normalizeTime(raw, fallback = DEFAULT_TIME) {
  const s = String(raw ?? '').trim();
  let m = /^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/.exec(s);
  if (m) {
    const h = Math.min(23, Math.max(0, Number(m[1])));
    const mi = Math.min(59, Math.max(0, Number(m[2])));
    return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
  }
  m = /^(\d{3,4})$/.exec(s);            // 2100 → 21:00
  if (m) {
    const t = m[1].padStart(4, '0');
    return t.slice(0, 2) + ':' + t.slice(2);
  }
  m = /^(\d{1,2})$/.exec(s);            // 21 → 21:00
  if (m) return String(Math.min(23, Math.max(0, Number(m[1])))).padStart(2, '0') + ':00';
  return fallback;
}

// ── 文案 ────────────────────────────────────────────────────────────────────

/**
 * 生成「次日课程」播报文案（纯文本，QQ 友好）。
 * @param {{date:string, weekday:string, items:any[], dataAvailable?:boolean, range?:string[]|null}} o
 */
export function renderDigest({ date, weekday, items, dataAvailable = true, range = null }) {
  const head = '【明日课程】' + date + '（' + (weekday || '') + '）';
  if (!dataAvailable) {
    return head + '\n课表数据没读到（data/schedule/schedule.json 缺失或坏了），今晚报不了啦——'
      + '主人把课表再发我一次，或者让我重新跑一遍解析就好。';
  }
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    const start = range && range[0];
    const end = range && range[1];
    if (end && date > end) {
      return head + '\n课表只排到 ' + end + '（秋季学期结束），之后还没有新学期的课表，'
        + '所以暂时没得报——新课表出来让本鲸重新导入就继续报。';
    }
    if (start && date < start) {
      return head + '\n课表从 ' + start + ' 才开始，明天还没排课。';
    }
    return head + '\n明天没有课，安心休息／自习吧～';
  }
  const lines = [head];
  for (const s of list) {
    const bits = [];
    if (s.section != null && s.section !== '') bits.push('第' + s.section + '节');
    // 完整时段优先（time_span）；s.time 只是第一小节结束时间，会把连排课报短
    const span = s.time_span || (s.time_start && s.time_end ? s.time_start + '-' + s.time_end : '') || s.time || '';
    if (span) bits.push(String(span));
    let line = '· ' + bits.join(' ');
    if (s.course) line += '　' + s.course;
    const tail = [];
    if (s.teacher) tail.push(String(s.teacher));
    if (s.room) tail.push(String(s.room));
    if (tail.length) line += '（' + tail.join(' · ') + '）';
    lines.push(line);
  }
  lines.push('共 ' + list.length + ' 节课。');
  return lines.join('\n');
}

/** 生成"这条消息是不是播报内容"的指纹词（用于回查存档确认真的发出去了） */
export function digestSignatures(text, date, items) {
  const sigs = new Set([date, date.slice(5), date.slice(5).replace('-', '/'), date.slice(5).replace('-', '.')]);
  for (const s of (items || []).slice(0, 8)) if (s && s.course) sigs.add(String(s.course));
  if (!items || !items.length) ['没课', '无课', '没有课', '休息', '课表'].forEach((w) => sigs.add(w));
  return [...sigs].filter(Boolean);
}

// ── 调度器 ──────────────────────────────────────────────────────────────────

export class ScheduleNotifyScheduler {
  /**
   * @param {object} o
   * @param {object} o.orchestrator 必填，提供 wake()
   * @param {object} [o.sender]     发送队列（兜底直发用；缺省取 orchestrator.sender）
   * @param {object} [o.onebot]     OneBot 客户端（群聊兜底前查禁言用，可选）
   * @param {Function} [o.log]
   * @param {string} [o.root]       应用根目录（默认 process.cwd()，即项目根目录）
   * @param {object} [o.config]     覆盖配置（测试/临时用；缺省每次实时读 getConfig().scheduleNotify）
   */
  constructor({ orchestrator = null, sender = null, onebot = null, log = console.log, root = process.cwd(), config = null } = {}) {
    this.orchestrator = orchestrator;
    this.sender = sender;
    this.onebot = onebot;
    this.log = typeof log === 'function' ? log : console.log;
    this.root = root;
    this.configOverride = config || null;
    this.timer = null;
    this.retryAt = 0;       // 失败重试的到点时间（内存态；pendingRetry 落盘）
    this.running = false;
    this.schedCache = null; // 课表 JSON 缓存（按 mtime 失效）
    this.state = { lastPushDate: null, lastFiredAt: 0, lastResult: null, pendingRetry: null, history: {} };
    this.#loadState();
  }

  // ── 配置 ──
  config() { return this.configOverride || getConfig().scheduleNotify || {}; }
  enabled() { return this.config().enabled !== false; }
  time() { return normalizeTime(this.config().time, DEFAULT_TIME); }
  chatKey() {
    const c = this.config().chatKey;
    if (c) return String(c);
    // 没配就用配置里的主人 QQ（不再硬编码）
    const m = String(getConfig().persona?.masterQQ || '');
    return m ? `private:${m}` : '';
  }
  dataFile() { return path.resolve(this.root, String(this.config().dataFile || 'data/schedule/schedule.json')); }
  stateFile() { return path.resolve(this.root, String(this.config().stateFile || 'data/schedule/notify_state.json')); }

  // ── 状态持久化 ──
  #loadState() {
    try {
      const p = this.stateFile();
      if (!fs.existsSync(p)) return;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      this.state.lastPushDate = j.lastPushDate || null;
      this.state.lastFiredAt = Number(j.lastFiredAt) || 0;
      this.state.lastResult = j.lastResult || null;
      this.state.pendingRetry = j.pendingRetry || null;
      this.state.history = (j.history && typeof j.history === 'object') ? j.history : {};
    } catch (e) {
      this.log('[课程播报] 状态文件读取失败（忽略，按全新状态跑）:', e?.message || e);
    }
  }

  #saveState() {
    try {
      const p = this.stateFile();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const keys = Object.keys(this.state.history).sort();
      while (keys.length > STATE_KEEP) delete this.state.history[keys.shift()];
      const tmp = p + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        lastPushDate: this.state.lastPushDate,
        lastFiredAt: this.state.lastFiredAt,
        lastResult: this.state.lastResult,
        pendingRetry: this.state.pendingRetry,
        history: this.state.history,
        updatedAt: new Date().toISOString()
      }, null, 2), 'utf8');
      fs.renameSync(tmp, p);
    } catch (e) {
      this.log('[课程播报] 状态文件写入失败（忽略）:', e?.message || e);
    }
  }

  // ── 课表数据 ──
  loadSchedule() {
    const file = this.dataFile();
    try {
      const st = fs.statSync(file);
      if (this.schedCache && this.schedCache.file === file && this.schedCache.mtimeMs === st.mtimeMs) {
        return this.schedCache.data;
      }
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.schedCache = { file, mtimeMs: st.mtimeMs, data };
      return data;
    } catch (e) {
      this.log('[课程播报] 读取课表失败:', e?.message || e);
      this.schedCache = null;
      return null;
    }
  }

  /** 课表覆盖范围 [起, 止] */
  #rangeOf(data) {
    if (!data) return null;
    if (Array.isArray(data.date_range) && data.date_range.length === 2) return data.date_range;
    const keys = Object.keys(data.by_date || {}).sort();
    return keys.length ? [keys[0], keys[keys.length - 1]] : null;
  }

  /** 生成「次日」播报内容（纯计算，不发送） */
  buildDigestForTomorrow(now = new Date()) {
    const tmr = shiftDate(1, now);
    const date = localDate(tmr);
    const weekday = WD_CN[tmr.getDay()];
    const data = this.loadSchedule();
    const byDate = (data && data.by_date) || {};
    const items = (Array.isArray(byDate[date]) ? byDate[date].slice() : [])
      .sort((a, b) => (Number(a.section) || 0) - (Number(b.section) || 0));
    const range = this.#rangeOf(data);
    const dataAvailable = !!(data && data.by_date);
    const text = renderDigest({ date, weekday, items, dataAvailable, range });
    return { date, weekday, items, count: items.length, range, dataAvailable, text };
  }

  // ── 生命周期 ──
  start() {
    this.stop();
    if (!this.enabled()) {
      this.log('[课程播报] 配置里已关闭（scheduleNotify.enabled=false），不启动');
      return;
    }
    this.#repairConfigTime();
    if (this.state.pendingRetry?.at) this.retryAt = Number(this.state.pendingRetry.at) || 0;
    const tick = async () => {
      this.timer = setTimeout(() => { tick().catch(() => {}); }, TICK_MS);
      try { await this.#check(); } catch (e) { this.log('[课程播报] 检查出错:', e?.message || e); }
    };
    this.timer = setTimeout(() => { tick().catch(() => {}); }, 8000);
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return '?'; } })();
    this.log('[课程播报] 调度器已启动：每天 ' + this.time() + ' 私聊 ' + this.chatKey()
      + ' 播报次日课程（本地时区 ' + tz + '；上次推送=' + (this.state.lastPushDate || '无') + '）');
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** 运维/测试用：立刻跑一次"到点检查"（等价于定时器那一跳） */
  async tickNow() { return this.#check(); }

  /** 把被写坏的时间配置（数字 21 / "2100" 之类）修回标准 HH:MM 并落盘 */
  #repairConfigTime() {
    try {
      if (this.configOverride) return;
      const raw = getConfig().scheduleNotify;
      if (!raw) return;
      const fixed = normalizeTime(raw.time, DEFAULT_TIME);
      if (String(raw.time ?? '') === fixed) return;
      this.log('[课程播报] 配置时间 ' + JSON.stringify(raw.time) + ' 不标准，已修正为 ' + fixed);
      updateConfig({ scheduleNotify: { ...raw, time: fixed } });
    } catch (e) {
      this.log('[课程播报] 修正配置时间失败（忽略）:', e?.message || e);
    }
  }

  // ── 主检查（每 20 秒一跳） ──
  async #check() {
    if (!this.enabled()) return;
    const today = localDate();
    if (this.state.lastPushDate === today) { this.retryAt = 0; return; }   // 今天已推 → 幂等

    if (this.retryAt) {                       // 上一次失败的重试
      if (Date.now() >= this.retryAt) {
        this.retryAt = 0;
        this.log('[课程播报] 重试上一次失败的推送');
        await this.#fire({ reason: 'retry' });
      }
      return;
    }

    const now = new Date();
    if (localHHMM(now) === this.time()) {
      await this.#fire({ reason: 'scheduled' });
      return;
    }
    // 补推：错过推送点（当时进程没在跑 / 重启 / 掉线）且今天还没成功推过
    if (this.config().catchUp !== false && this.#shouldCatchUp(now)) {
      this.log('[课程播报] 检测到今天还没播报（可能错过 ' + this.time() + '），补推一次');
      await this.#fire({ reason: 'catchup' });
    }
  }

  #shouldCatchUp(now = new Date()) {
    const today = localDate(now);
    if (this.state.lastPushDate === today) return false;
    if (localHHMM(now) < this.time()) return false;      // 还没到今天的推送时间
    if (!this.state.lastPushDate) return true;           // 从没推过（首次部署）→ 允许当天补推
    const last = new Date(this.state.lastPushDate + 'T' + this.time() + ':00');
    if (Number.isNaN(last.getTime())) return true;
    return (now.getTime() - last.getTime()) >= 24 * 3600 * 1000;   // 距上次成功推送 ≥ 1 天
  }

  // ── 触发 ──
  /**
   * 真正发起一次播报。
   * @param {{reason?:string, force?:boolean}} o
   * @returns {Promise<{ok:boolean, via:string|null, text:string, error?:string}>}
   */
  async #fire({ reason = 'scheduled', force = false } = {}) {
    if (this.running) return { ok: false, via: null, text: '', error: 'busy' };
    const cfg = this.config();
    if (!force && this.orchestrator?.paused) {
      this.log('[课程播报] 机器人处于暂停状态，跳过本次播报');
      return { ok: false, via: null, text: '', error: 'paused' };
    }
    if (!this.orchestrator?.wake) {
      this.log('[课程播报] 没有 orchestrator，无法播报（接线有误）');
      return { ok: false, via: null, text: '', error: 'no-orchestrator' };
    }

    this.running = true;
    const chatKey = this.chatKey();
    try {
      const digest = this.buildDigestForTomorrow();
      const text = digest.text;
      const sigs = digestSignatures(text, digest.date, digest.items);
      if (!text) { this.log('[课程播报] 本次没有可发的内容，跳过'); return { ok: false, via: null, text: '', error: 'empty' }; }

      // ① 首选：唤醒 agent 本人（和主人亲自说话一样，带人设、写进消息存档）
      const maxAttempts = Math.max(1, Number(cfg.maxAttempts) || 3);
      const backoffMs = Math.max(1000, Number(cfg.retryBackoffMs) || 30000);
      let lastErr = null;
      let dispatched = false;
      const t0 = Date.now();
      for (let attempt = 1; attempt <= maxAttempts && !dispatched; attempt++) {
        try {
          await this.orchestrator.wake(chatKey, {
            proactive: true,
            pushTask: {
              kind: 'schedule',
              date: digest.date,
              weekday: digest.weekday,
              count: digest.count,
              firedAt: localHHMM(),
              source: reason,
              text
            }
          });
          dispatched = true;               // 唤醒调用本身成功（不代表真的发言了，下面回查）
        } catch (e) {
          lastErr = e;
          this.log('[课程播报] 第 ' + attempt + '/' + maxAttempts + ' 次唤醒失败:', e?.message || e);
          if (attempt < maxAttempts) await sleep(backoffMs);
        }
      }

      // ② 回查消息存档：确认 agent 真的把播报发出去了（唤醒被暂停/没模型/并发满时会静默跳过）
      let via = null;
      if (dispatched) {
        const hit = this.#findSentSince(chatKey, t0, sigs);
        if (hit) via = 'agent';
        else this.log('[课程播报] 唤醒已完成但没查到播报内容（可能被暂停/未配置模型/模型没发言），转兜底发送');
      }

      // ③ 兜底：经发送队列直发纯文本（仍受 SendQueue 限频与防风控约束，不绕过）
      if (!via) {
        const fb = await this.#directFallback(chatKey, text);
        if (fb.ok) via = fb.via || 'direct';
        else lastErr = fb.error || lastErr;
      }

      const ok = !!via;
      this.state.lastFiredAt = Date.now();
      this.state.lastResult = {
        at: new Date().toISOString(), reason, via, ok, forDate: digest.date, count: digest.count,
        error: ok ? null : String(lastErr?.message || lastErr || 'unknown')
      };
      if (ok) {
        this.state.lastPushDate = localDate();
        this.state.pendingRetry = null;
        this.state.history[localDate()] = { at: Date.now(), forDate: digest.date, via, reason, count: digest.count };
        this.log('[课程播报] 已推送（' + via + '）：' + digest.date + ' 共 ' + digest.count + ' 节课');
      } else {
        this.#scheduleRetry();
        this.log('[课程播报] 推送失败：' + this.state.lastResult.error);
      }
      this.#saveState();
      return { ok, via, text, error: ok ? undefined : this.state.lastResult.error };
    } finally {
      this.running = false;
    }
  }

  /** 回查：t0 之后该会话（物理键 + 身份有效键）里有没有发出过像播报的消息 */
  #findSentSince(chatKey, t0, sigs) {
    const store = this.orchestrator?.store;
    if (!store?.recent) return null;      // 拿不到存档 → 无法判定，交给调用方
    const keys = new Set([String(chatKey)]);
    try { keys.add(resolveChatKey(String(chatKey))); } catch { /* ignore */ }
    for (const key of keys) {
      let recent = [];
      try { recent = store.recent(key, { limit: 400 }) || []; } catch { continue; }
      for (const m of recent) {
        if (!m?.self || (m.ts || 0) < t0) continue;
        const t = String(m.text || '');
        if (sigs.some((s) => s && t.includes(s))) return m;
      }
    }
    return null;
  }

  /** 兜底：经发送队列直接发纯文本；群聊先查是否被禁言 */
  async #directFallback(chatKey, text) {
    const sender = this.sender || this.orchestrator?.sender;
    if (!sender?.sendTextBatch) return { ok: false, error: '没有可用的发送队列（SendQueue），兜底发送放弃' };
    const [kind, id] = String(chatKey).split(':');
    if (kind === 'group') {
      try {
        const info = await this.onebot?.getGroupMemberInfo?.(id, this.onebot?.selfId);
        if (info && Number(info.shut_up_timestamp || 0) > Math.floor(Date.now() / 1000)) {
          return { ok: false, error: '当前在群里被禁言，兜底发送跳过' };
        }
      } catch { /* 查不到就不拦 */ }
    }
    try {
      this.log('[课程播报] 改用发送队列兜底直发');
      const r = await sender.sendTextBatch(chatKey, [text], {});
      const sent = (r?.sent || []).length;
      return sent > 0 ? { ok: true, via: 'direct' } : { ok: false, error: '发送队列没有成功发出任何消息' };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  #scheduleRetry() {
    const cfg = this.config();
    if (cfg.retryEnabled === false) return;
    const delayMs = Math.max(10000, Number(cfg.retryDelayMs) || 10 * 60 * 1000);
    this.retryAt = Date.now() + delayMs;
    this.state.pendingRetry = { at: this.retryAt, date: localDate(), reason: 'failed-push' };
    this.log('[课程播报] 已安排 ' + Math.round(delayMs / 60000) + ' 分钟后重试一次');
  }

  // ── 对外：手动触发 / 预览 / 状态 ──

  /** 手动触发一次（忽略时间与幂等，用于部署后验证链路）；dryRun=true 只算文案不发送 */
  async runNow({ dryRun = false } = {}) {
    if (dryRun) {
      const d = this.buildDigestForTomorrow();
      return { ok: true, dryRun: true, forDate: d.date, weekday: d.weekday, count: d.count, text: d.text };
    }
    const r = await this.#fire({ reason: 'manual', force: true });
    return { ...r, status: this.status() };
  }

  /** 预览：offset=0 今天 / 1 明天 / N 之后 N 天（不发送） */
  preview(offset = 1) {
    const target = shiftDate(Number(offset) || 0, new Date());
    const date = localDate(target);
    const weekday = WD_CN[target.getDay()];
    const data = this.loadSchedule();
    const byDate = (data && data.by_date) || {};
    const items = (Array.isArray(byDate[date]) ? byDate[date].slice() : [])
      .sort((a, b) => (Number(a.section) || 0) - (Number(b.section) || 0));
    return {
      date, weekday, count: items.length,
      text: renderDigest({ date, weekday, items, dataAvailable: !!(data && data.by_date), range: this.#rangeOf(data) })
    };
  }

  status() {
    const d = this.buildDigestForTomorrow();
    return {
      enabled: this.enabled(),
      time: this.time(),
      chatKey: this.chatKey(),
      dataFile: this.dataFile(),
      stateFile: this.stateFile(),
      lastPushDate: this.state.lastPushDate,
      lastFiredAt: this.state.lastFiredAt,
      lastResult: this.state.lastResult,
      retryAt: this.retryAt || (this.state.pendingRetry?.at ?? 0) || 0,
      tomorrow: { date: d.date, weekday: d.weekday, count: d.count }
    };
  }
}

export default ScheduleNotifyScheduler;
