// OneBot 账号健康探针（控制台告警用）
//
// 背景（2026-09-14 事故）：控制台原先只用 【WebSocket 是否连上】判断健康，
// 但 NapCat 的 WS 端口在**账号已离线**时依然在监听 —— 于是：
//   - QQ 07:26 起就反复掉线（当日 10 次「账号状态变更为离线」）
//   - 控制台却一直显示"已连接"，直到用户自己发现机器人在 08:27 后不再回话
// 教训：**"进程/端口活着" ≠ "账号可用"**。
//
// 本探针周期性调用 get_status（账号在线标志），并在掉线时发出告警事件。
import { EventEmitter } from 'node:events';

export class OneBotHealth extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.onebot  OneBot 客户端（需有 call 方法）
   * @param {Function} [opts.log]
   * @param {number} [opts.intervalMs] 探测间隔，默认 60 秒
   */
  constructor({ onebot, log = console.log, intervalMs = 60000 } = {}) {
    super();
    this.onebot = onebot;
    this.log = log;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.state = {
      online: null,          // true/false/null(=未知)
      checkedAt: null,
      lastOnlineAt: null,    // 最近一次确认在线
      offlineSince: null,    // 本次离线开始时间
      failStreak: 0,         // 连续探测失败次数（用于过滤抖动）
      lastError: ''
    };
  }

  /** 探测一次。返回 state。连续 2 次失败才判定离线，避免网络抖动误报。 */
  async probe() {
    const now = Date.now();
    let online = null;
    let error = '';
    try {
      const r = await this.onebot.call('get_status', {}, 15000);
      // ⚠️ OneBotClient.call() **已经把 body.data 解包了**（见 onebot.js 的 `return body.data`），
      //    所以这里 r 直接就是 { online: true|false, good, stat }。
      //    早期写成 `r?.data ?? r` 会多剥一层 → r.data 为 undefined → 永远判不出在线状态，
      //    表现为 account.online 恒为 null（"未探测"），掉线也不告警。
      if (r && typeof r.online === 'boolean') online = r.online;
      else online = null;   // 拿不到 online 字段，视为未知
    } catch (e) {
      error = String(e?.message ?? e);
    }

    this.state.checkedAt = now;
    this.state.lastError = error;

    if (online === true) {
      const wasOffline = this.state.online === false;
      this.state.online = true;
      this.state.lastOnlineAt = now;
      this.state.offlineSince = null;
      this.state.failStreak = 0;
      if (wasOffline) this.emit('recovered', { ...this.state });
      return this.state;
    }

    if (online === false || error) {
      this.state.failStreak += 1;
      // 连续 2 次才判定离线；首次只记录，避免抖动误报
      if (this.state.failStreak >= 2) {
        const wasOnline = this.state.online !== false;
        this.state.online = false;
        if (!this.state.offlineSince) this.state.offlineSince = now;
        if (wasOnline) {
          this.log('[health] ⚠ OneBot 账号已离线' + (error ? '（' + error + '）' : ''));
          this.emit('offline', { ...this.state });
        }
      }
      return this.state;
    }

    // online === null：字段缺失，不改判离线，但保留时间戳
    return this.state;
  }

  start() {
    if (this.timer) return;
    // 启动后延迟 10 秒再首次探测（等服务与登录稳定）
    this.timer = setInterval(() => {
      this.probe().catch(() => { /* 已内部记录 */ });
    }, this.intervalMs);
    setTimeout(() => { this.probe().catch(() => {}); }, 10000);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 供 /api/status 内联的快照 */
  snapshot() {
    const s = this.state;
    return {
      online: s.online,                 // null=未知 / true / false
      checkedAt: s.checkedAt,
      lastOnlineAt: s.lastOnlineAt,
      offlineSince: s.offlineSince,
      offlineMs: s.offlineSince ? Date.now() - s.offlineSince : 0,
      lastError: s.lastError
    };
  }
}
