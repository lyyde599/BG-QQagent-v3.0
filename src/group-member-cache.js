// 群成员缓存：用于「功能群成员可私聊」的放行判断
//
// 背景（2026-10-02 用户要求）：
//   机器人改为纯 Q 群机器人。私聊策略 = **凡在功能群里的成员，私聊也回复**。
//   白名单里的群成员对机器人来说才是"自己人"，其私聊不该被拦。
//
// 为什么需要缓存：白名单判断（allowed()）是**同步**的，而 OneBot 查群成员是**异步**的。
//   于是这里周期性把「所有白名单群」的成员拉下来存成一个 Set，
//   同步判断时只查 Set，既准确又不阻塞。
//
// 刷新策略：定时（默认 10 分钟）+ 群成员变动事件时主动刷新（接口见 refresh()）。
import { getConfig } from './config.js';

const REFRESH_MS = Number(process.env.GROUP_MEMBER_REFRESH_MS || 10 * 60 * 1000);

export class GroupMemberCache {
  /**
   * @param {object} opts
   * @param {object} opts.onebot  OneBotClient（提供 call）
   * @param {Function} [opts.log]
   */
  constructor({ onebot, log = () => {} } = {}) {
    this.onebot = onebot;
    this.log = log;
    /** @type {Set<string>} 白名单群成员 QQ 号 */
    this.members = new Set();
    this.timer = null;
    this.updatedAt = 0;
    this.lastError = '';
  }

  start() {
    if (this.timer) return;
    // ⚠️ 首次拉取必须**尽快**，且失败要快速重试。
    // 2026-10-04 事故：原实现是「启动后延迟 20 秒拉一次，之后每 10 分钟一次」。
    //   群友 18:39:31 私聊「领取福利」，而 QQ 18:39:06 才登录、缓存 18:42:56 才填充 ——
    //   他正好落在空窗期，`allowed()` 因缓存为空判 false，**私聊被静默丢弃**，
    //   机器人完全没收到（连存档都没有），用户以为机器人没理他。
    //   现在：立刻拉一次 + 短间隔重试直到成功（最多 6 次，5 秒起退避）。
    const tryFetch = (attempt = 0) => {
      this.refresh()
        .then((n) => {
          if (!n && attempt < 6) setTimeout(() => tryFetch(attempt + 1), 3000 + attempt * 2000);
        })
        .catch(() => { if (attempt < 6) setTimeout(() => tryFetch(attempt + 1), 3000 + attempt * 2000); });
    };
    setTimeout(() => tryFetch(0), 1000);
    this.timer = setInterval(() => { this.refresh().catch(() => {}); }, REFRESH_MS);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 拉取所有白名单群的成员，重建 Set。返回成员数。 */
  async refresh() {
    const cfg = getConfig();
    const groups = (cfg.allow?.groups || []).map(String).filter(Boolean);
    if (!groups.length) {
      this.members = new Set();
      this.updatedAt = Date.now();
      return 0;
    }
    const next = new Set();
    const failed = [];
    for (const gid of groups) {
      try {
        const list = await this.onebot.call('get_group_member_list', { group_id: Number(gid) }, 20000);
        for (const m of (list || [])) {
          const uid = m?.user_id;
          if (uid != null) next.add(String(uid));
        }
      } catch (e) {
        failed.push(`${gid}:${e?.message ?? e}`);
      }
    }
    // 有群拉取失败时，**保留旧数据**而不是清空 —— 否则会瞬间把所有人踢出白名单
    if (failed.length && this.members.size) {
      this.lastError = failed.join('；');
      this.log(`[group-members] ⚠ 部分群拉取失败（保留旧缓存）：${this.lastError}`);
      return this.members.size;
    }
    this.members = next;
    this.updatedAt = Date.now();
    this.lastError = failed.join('；');
    if (failed.length) this.log(`[group-members] ⚠ 拉取失败：${this.lastError}`);
    else this.log(`[group-members] 已刷新 ${groups.length} 个群的成员，共 ${next.size} 人`);
    return next.size;
  }

  /** 同步判断：某人是否是白名单群的成员。 */
  has(userId) {
    return this.members.has(String(userId ?? ''));
  }

  snapshot() {
    return {
      count: this.members.size,
      updatedAt: this.updatedAt,
      lastError: this.lastError,
      ageMs: this.updatedAt ? Date.now() - this.updatedAt : null
    };
  }
}
