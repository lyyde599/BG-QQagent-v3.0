// ── 群管理：自动迎新 + 自动同意入群/加好友申请 ───────────────────────────
//
// 背景（2026-10-02 用户要求）：
//   「加入群管理功能，会自动引导群内环境，并且会自动同意好友入群申请」
//
// 三件事：
//   ① **自动迎新**：新人入群 → 发一条欢迎语 + 群规引导（可配模板、可开关）
//   ② **自动同意入群申请**：收到 group request 按策略同意（支持答案关键词、问题编号）
//   ③ **自动同意好友申请**：收到 friend request 按策略同意
//
// 安全默认值（**保守**）：
//   - 申请自动同意**默认关闭**（`features.autoApprove.*`），避免机器人变成拉群工具
//   - 迎新**默认开启但只在白名单群**（机器人不参与的群根本收不到事件，天然受限）
//   - 支持黑名单 / 关键词 / 问题答案校验，防止"随便点同意"
//
// OneBot v11 事件契约：
//   request: { post_type:'request', request_type:'friend'|'group', user_id, comment, flag }
//            group 额外有 { sub_type:'add'|'invite', group_id }
//   notice : { post_type:'notice', notice_type:'group_increase'|'group_decrease',
//              sub_type:'approve'|'invite'|'leave'|'kick'|'kick_me', group_id, user_id, operator_id }
//   响应  : set_friend_add_request { flag, approve }
//           set_group_add_request  { flag, sub_type:'add'|'invite', approve }
import { getConfig, resolvePersona } from './config.js';
import { PERSONAS } from './personas.js';

export class GroupManager {
  /**
   * @param {object} opts
   * @param {object} opts.onebot  OneBotClient（提供 call）
   * @param {Function} [opts.log]
   */
  constructor({ onebot, log = () => {}, configProvider = null } = {}) {
    this.onebot = onebot;
    this.log = log;
    // 配置来源可注入（插件化后由 ctx.config 提供）；不传则回退全局 getConfig()。
    this.configProvider = typeof configProvider === 'function' ? configProvider : () => getConfig();
    this.stats = { welcomed: 0, approvedGroup: 0, approvedFriend: 0, rejected: 0, errors: 0 };
    this.recent = [];   // 最近处理记录（供面板展示）
  }

  #cfg() { return this.configProvider(); }
  #gm() { return this.#cfg().groupManager || {}; }
  #on(key, dflt) { const v = this.#gm()[key]; return v === undefined ? dflt : v; }

  #record(type, detail) {
    this.recent.unshift({ at: Date.now(), type, ...detail });
    if (this.recent.length > 50) this.recent.length = 50;
  }

  // ── ① 新人入群 → 引导 ──
  /**
   * 处理 group_increase 通知。返回是否发送了欢迎语。
   * sub_type: approve（管理员同意）/ invite（被邀请）
   */
  async onGroupIncrease(e) {
    if (this.#on('welcomeEnabled', true) === false) return false;
    const groupId = String(e.group_id ?? '');
    const userId = String(e.user_id ?? '');
    if (!groupId || !userId) return false;

    // 只对白名单群生效（allow.groups 为空时表示不限制）
    const cfg = this.#cfg();
    const allow = (cfg.allow?.groups || []).map(String);
    if (allow.length && !allow.includes(groupId)) return false;

    // 机器人自己被拉进群（user_id == self）→ 发"入驻引导"而非欢迎新人
    const selfJoin = userId === String(this.onebot.selfId ?? '');

    const tmpl = selfJoin
      ? (this.#gm().selfJoinTemplate || '')
      : this.#welcomeTemplateFor(groupId);
    if (!tmpl) return false;

    const text = this.#render(tmpl, { groupId, userId, nickname: '' });
    try {
      await this.onebot.call('send_group_msg', { group_id: Number(groupId), message: text }, 15000);
      this.stats.welcomed += 1;
      this.#record('welcome', { groupId, userId, selfJoin, persona: this.#personakeyFor(groupId) });
      this.log(`[群管理] 已在群 ${groupId} 发送${selfJoin ? '入驻引导' : '迎新语'}（人设 ${this.#personakeyFor(groupId) || '默认'}）`);
      return true;
    } catch (err) {
      this.stats.errors += 1;
      this.log(`[群管理] ✘ 迎新失败（群 ${groupId}）：${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * 该群当前生效的人设 key。
   *   · 有绑定/模式 → builtin 人设返回其 key；自定义人设返回 ''（走兜底）
   *   · 没有任何绑定（默认身份）→ 返回 'xiaojingyu'（默认小鲸鱼）
   */
  #personakeyFor(groupId) {
    try {
      const ident = resolvePersona(`group:${groupId}`);
      const ref = String(ident?.persona?.ref || '');
      if (!ref) return ident?.mode && ident.mode !== 'assistant' ? '' : 'xiaojingyu';
      const m = /^builtin:(.+)$/.exec(ref);
      return m ? m[1] : '';
    } catch { return 'xiaojingyu'; }
  }

  /**
   * 按群当前人设取欢迎语，优先级：
   *   ① 该人设自带的 welcome（每个 profile 一套语气）
   *   ② 全局 groupManager.welcomeTemplate（兜底：自定义人设、或该人设没写 welcome）
   * 这样换人设后欢迎语会自动跟着换，不用改配置。
   */
  #welcomeTemplateFor(groupId) {
    const key = this.#personakeyFor(groupId);
    if (key) {
      const builtin = PERSONAS[key];
      if (builtin?.welcome) return builtin.welcome;
    }
    return this.#gm().welcomeTemplate || '';
  }

  /** 模板变量替换：支持 {at} {nickname} {groupId} {userId} */
  #render(tmpl, { groupId, userId, nickname }) {
    return String(tmpl)
      .replace(/\{at\}/g, `[CQ:at,qq=${userId}]`)
      .replace(/\{nickname\}/g, nickname || userId)
      .replace(/\{groupId\}/g, groupId)
      .replace(/\{userId\}/g, userId);
  }

  // ── ②③ 申请处理 ──
  /**
   * 处理 request 事件（加好友 / 加群 / 被邀请入群）。
   * 返回 { handled:boolean, approve?:boolean, reason?:string }
   */
  async onRequest(e) {
    const type = String(e.request_type || '');
    if (type === 'friend') return this.#handleFriendRequest(e);
    if (type === 'group') return this.#handleGroupRequest(e);
    return { handled: false, reason: 'unknown-request-type' };
  }

  #isDenied(userId) {
    const deny = (this.#gm().denyUsers || []).map(String);
    return deny.includes(String(userId));
  }

  async #handleFriendRequest(e) {
    const userId = String(e.user_id ?? '');
    if (!userId) return { handled: false, reason: 'no-user' };
    if (!this.#on('autoApproveFriend', false)) {
      this.log(`[群管理] 收到好友申请 ${userId}（自动同意已关闭，忽略）`);
      this.#record('friend-pending', { userId });
      return { handled: false, reason: 'disabled' };
    }
    if (this.#isDenied(userId)) {
      this.stats.rejected += 1;
      this.#record('friend-reject', { userId });
      return this.#respond('set_friend_add_request', { flag: e.flag, approve: false }, { userId, kind: 'friend' });
    }
    return this.#respond('set_friend_add_request', { flag: e.flag, approve: true },
      { userId, kind: 'friend', approve: true });
  }

  async #handleGroupRequest(e) {
    const groupId = String(e.group_id ?? '');
    const userId = String(e.user_id ?? '');
    const subType = String(e.sub_type || 'add');   // add=申请入群 / invite=邀请机器人入群
    if (!this.#on('autoApproveGroup', false)) {
      this.log(`[群管理] 收到入群申请（群 ${groupId}，${userId}，${subType}）（自动同意已关闭，忽略）`);
      this.#record('group-pending', { groupId, userId, subType });
      return { handled: false, reason: 'disabled' };
    }
    if (this.#isDenied(userId)) {
      this.stats.rejected += 1;
      return this.#respond('set_group_add_request', { flag: e.flag, sub_type: subType, approve: false },
        { groupId, userId, kind: 'group', approve: false });
    }
    // 关键词校验：配置了 requiredKeywords 时，comment（申请附言/答案）必须命中其一
    const kws = (this.#gm().requiredKeywords || []).map(String).filter(Boolean);
    if (kws.length) {
      const comment = String(e.comment ?? '');
      const hit = kws.some((k) => comment.includes(k));
      if (!hit) {
        this.log(`[群管理] 入群申请 ${userId} 附言未命中关键词（附言：${comment.slice(0, 40)}），拒绝`);
        this.stats.rejected += 1;
        return this.#respond('set_group_add_request', { flag: e.flag, sub_type: subType, approve: false },
          { groupId, userId, kind: 'group', approve: false, reason: 'keyword-miss' });
      }
    }
    return this.#respond('set_group_add_request', { flag: e.flag, sub_type: subType, approve: true },
      { groupId, userId, kind: 'group', approve: true, subType });
  }

  async #respond(action, params, info) {
    try {
      await this.onebot.call(action, params, 15000);
      if (info.approve) {
        if (info.kind === 'friend') this.stats.approvedFriend += 1;
        else this.stats.approvedGroup += 1;
      }
      this.#record(info.approve ? `${info.kind}-approve` : `${info.kind}-reject`, info);
      this.log(`[群管理] ${info.approve ? '已同意' : '已拒绝'}${info.kind === 'friend' ? '好友' : '入群'}申请：${info.userId}`
        + (info.groupId ? `（群 ${info.groupId}）` : ''));
      return { handled: true, approve: !!info.approve };
    } catch (err) {
      this.stats.errors += 1;
      this.log(`[群管理] ✘ 处理申请失败：${err?.message ?? err}`);
      return { handled: false, reason: String(err?.message ?? err) };
    }
  }

  snapshot() {
    return {
      enabled: {
        welcome: this.#on('welcomeEnabled', true),
        autoApproveFriend: this.#on('autoApproveFriend', false),
        autoApproveGroup: this.#on('autoApproveGroup', false)
      },
      stats: { ...this.stats },
      recent: this.recent.slice(0, 10)
    };
  }
}
