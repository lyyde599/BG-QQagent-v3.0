// 登录二维码刷新守护（NapCat 自动刷新循环卡死时自愈）
//
// 背景（2026-09-16 事故）：用户报"SnowLuma 的二维码不更新了"。
// 排查发现 NapCat **自身**的二维码自动刷新循环死掉了 ——
//   08:01 ~ 08:37 连续刷新 18 次（约每 2 分钟一次），之后**彻底静默**；
//   但进程健在（4 进程 / 26 线程），且手动调 RefreshQRcode **立即恢复**。
// 也就是说：死的只是那个定时器，登录服务本身没崩。
//
// 这类"进程活着但内部定时器卡死"的故障，外部健康检查（端口/进程）查不出来，
// 只能靠**观察产物是否还在更新**（二维码文件的 mtime）来发现。
//
// 本模块：未登录时若二维码文件超过阈值未更新，就主动调 NapCat 的 RefreshQRcode 踢活它。
import { qrInfo } from './napcat-qr.js';

// 超过这个时长没更新就认为刷新循环卡死。
// NapCat 原生约每 2 分钟刷一次（与 QQ 登录码有效期同步），阈值取 2.5 分钟：
// 既能及时发现卡死，又不会与原生刷新打架。
// ⚠️ 早期设 4 分钟太松 —— 码有一半时间是过期的，用户扫码常失败（2026-09-17 实测调整）。
const STALE_MS = Number(process.env.QR_STALE_MS || 2.5 * 60 * 1000);
// 检查间隔 30 秒：比阈值密，保证超时后最多 30 秒内被踢活
const CHECK_INTERVAL_MS = Number(process.env.QR_WATCH_INTERVAL_MS || 30 * 1000);

export class QrRefreshGuard {
  /**
   * @param {object} opts
   * @param {object} opts.napcatWebui  NapCatWebui 实例（提供 refreshQr）
   * @param {Function} opts.isLoggedIn 返回当前是否已登录（已登录则无需守护）
   * @param {Function} [opts.dir]      取 NapCat 目录
   * @param {Function} [opts.log]
   */
  constructor({ napcatWebui, isLoggedIn, dir = () => '', log = console.log } = {}) {
    this.webui = napcatWebui;
    this.isLoggedIn = isLoggedIn;
    this.dir = dir;
    this.log = log;
    this.timer = null;
    this.lastKickAt = 0;
    this.kickCount = 0;
    this.failStreak = 0;
    this.mode = '';        // 'idle' | 'healing' | 'error'，用于"仅在状态变化时打日志"
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.check().catch(() => {}); }, CHECK_INTERVAL_MS);
    // 启动后延迟 30 秒做首次检查（等登录流程稳定）
    setTimeout(() => { this.check().catch(() => {}); }, 30000);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 检查一次；卡死则踢活。返回 { kicked, reason }。 */
  async check() {
    // 已登录就不需要二维码了
    try {
      if (this.isLoggedIn && this.isLoggedIn()) return this.#settle('logged-in', { kicked: false });
    } catch { /* ignore */ }

    const info = qrInfo(this.dir());
    if (!info.exists) return this.#settle('no-qr', { kicked: false });

    const age = info.ageMs ?? 0;
    if (age < STALE_MS) return this.#settle('fresh', { kicked: false, ageMs: age });

    // 卡死：二维码超过阈值未更新。避免与上次踢活靠得太近（NapCat 需时间重生成）
    // 冷却 20 秒：早期设 60 秒比阈值还长，会明显拖慢恢复
    if (Date.now() - this.lastKickAt < 20 * 1000) {
      return { kicked: false, reason: 'cooldown' };
    }
    this.lastKickAt = Date.now();
    this.kickCount += 1;
    const mins = Math.round(age / 60000);
    // 只在**首次进入自愈**时打一条日志，避免每 3 分钟刷屏（4 天曾累积 1000+ 行）
    if (this.mode !== 'healing') {
      this.log(`[qr-guard] ⚠ 登录二维码已 ${mins} 分钟未更新（NapCat 自动刷新疑似卡死），开始主动刷新`);
      this.mode = 'healing';
    }
    try {
      await this.webui.refreshQr(this.dir());
      this.failStreak = 0;
      return { kicked: true, reason: 'stale', ageMs: age };
    } catch (e) {
      const msg = String(e?.message ?? e);
      this.failStreak += 1;
      // 「QQ Is Logined」是竞态（刚登录成功那一瞬），不算故障，静默
      const benign = /Is Logined/i.test(msg);
      if (!benign && this.failStreak <= 3) {
        this.log(`[qr-guard] ✘ 刷新失败（连续 ${this.failStreak} 次）：${msg}`);
      }
      if (this.failStreak === 3) this.log('[qr-guard] ✘ 连续 3 次刷新失败，后续静默（登录服务可能异常）');
      return { kicked: false, reason: 'refresh-failed', error: msg };
    }
  }

  /**
   * 记录"无需自愈"的状态；从 healing 回到正常时打一条恢复日志。
   * 目的：只报状态变化，不刷屏。
   */
  #settle(reason, ret) {
    if (this.mode === 'healing' || this.mode === 'error') {
      this.log(`[qr-guard] ✔ 二维码刷新已恢复正常（原因：${reason}，累计自愈 ${this.kickCount} 次）`);
    }
    this.mode = 'idle';
    this.failStreak = 0;
    return ret;
  }

  snapshot() {
    return { kickCount: this.kickCount, lastKickAt: this.lastKickAt, intervalMs: CHECK_INTERVAL_MS, staleMs: STALE_MS };
  }
}
