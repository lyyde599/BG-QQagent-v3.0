// ── 广告/推广检测与自动禁言（2026-10-03 新增）────────────────────────────
//
// 背景（用户要求）：
//   「遇上疑似打广告或者推广的请禁言 10 分钟」
//
// 设计原则（**为什么不是"让模型自己决定禁言"**）：
//   群消息本来就会触发模型运行（app.js: ingestMessage → orchestrator.onIncoming），
//   所以模型"看得见"广告。但把禁言权完全交给模型有三个问题：
//     ① 模型不稳定 —— 同一句话这次判广告、下次不判，群友体验割裂；
//     ② 误伤不可逆 —— 禁言是真实处罚，模型幻觉一次就伤到真人；
//     ③ 人设冲突 —— 角色卡明写"群管理操作（禁言/踢人）拒绝"，模型会照着拒。
//   因此改成**确定性代码路径**：
//     关键词预筛（零成本，命中才继续）→ 模型复核（只判"是否广告"，不做处罚决定）
//     → 代码执行禁言（带保护名单、频率限制、审计日志）。
//   模型只提供"判断"，"处罚"始终由代码按规则执行 —— 与 lint-account-check 同一思路：
//   与其靠"记得别写错"，不如让错误写不出来。
//
// 三层保护（防误伤）：
//   ① **保护名单**：主人 / 群管理员 / 群主 / 机器人自己 / 显式豁免名单，永不处理；
//   ② **双重确认**：关键词命中 **且**（模型复核通过 或 命中高置信关键词）；
//   ③ **频率闸门**：同一人冷却期内只罚一次；单位时间内处罚次数上限（防模型抽风批量误伤）。
//
// 默认**关闭**（enabled: false）。原因：禁言会影响真实群友，应由用户显式开启并
// 观察 dryRun 一段时间后再放开。这与 groupManager 的"申请自动同意默认关闭"一致。
import { getConfig } from './config.js';

// ── 高置信广告特征（命中即认为证据充分，可跳过模型复核）──
// 选取标准：正常聊天几乎不会出现，出现即广告意图明确。
const HIGH_CONFIDENCE = [
  /加\s*(?:我|下)?\s*(?:微信|vx|v信|威信|qq|企鹅)\s*[:：]?\s*[a-zA-Z0-9_-]{4,}/i,
  /(?:微信|vx|v信|威信)\s*[:：]\s*[a-zA-Z0-9_-]{5,}/i,
  /(?:日|月|年)?(?:入|赚|撸|躺赚|稳赚)\s*(?:过?\s*万|[0-9]+\s*[kw万])/i,
  /(?:兼职|刷单|跑分|代付|代收|洗白|菠菜|博彩|彩票|时时彩|六合彩)/i,
  /(?:免费|低价)\s*(?:送|领|撸)\s*(?:皮肤|点券|会员|话费|流量|红包)/i,
  /(?:机场|节点|梯子|翻墙|ssr|v2ray|clash)\s*(?:订阅|推荐|出售|购买|便宜)/i,
  /(?:成人|色情|约炮|裸聊|福利姬|资源群)/i,
  /(?:贷款|套现|养卡|提额|征信修复|反催收)/i,
  // ⚠️ 「发链接」本身**不是**广告特征 —— 群友分享技术文章、新闻、视频都会带链接。
  //    这里只把「明确号召去外部加群/扫码」视为高置信；单纯带 URL 归入弱信号。
  /(?:扫码|扫下方|扫下面)\s*(?:二维码|码|进群|加群|关注)/i,
  /(?:加|进)\s*(?:群|qq群)\s*[:：]?\s*(?:http|www\.|t\.me|qm\.qq\.com|\d{6,})/i
];

// ── 弱特征（需模型复核确认，单独出现不足以定罪）──
// 正常聊天也可能出现，所以只作为"候选信号"，必须模型复核。
const WEAK_SIGNALS = [
  /https?:\/\/[^\s]+/i,                       // 带链接
  /(?:优惠|折扣|促销|特价|秒杀|拼团|代购|推广|招商|招代理|招募)/i,
  /(?:免费|领取|福利)\s*(?:加|私|戳|扫)/i,
  /(?:一手货源|厂家直供|批发|低价出|清仓)/i,
  /(?:股票|荐股|带单|跟单|合约|带赚|导师)/i,
  /(?:加|私)\s*(?:我|聊)\s*(?:了解|咨询|详聊)/i,
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/i,  // 邮箱
  /(?:加|联系)\s*(?:q|Q|扣)\s*[:：]?\s*\d{5,}/i
];

const DEFAULT_MUTE_SECONDS = 600;    // 10 分钟（用户指定）

export class AntiAd {
  /**
   * @param {object} opts
   * @param {object} opts.onebot    OneBotClient（提供 call / getGroupMemberInfo）
   * @param {Function} [opts.log]
   * @param {Function} [opts.classify]  可选：模型复核函数 (text, context) => Promise<{ad:boolean, reason:string}>
   */
  constructor({ onebot, log = () => {}, classify = null, configProvider = null } = {}) {
    this.onebot = onebot;
    this.log = log;
    this.classify = classify;
    // 配置来源可注入：插件化后由 ctx.config 提供（命名空间隔离），
    // 不传则回退全局 getConfig()——保持内核直连时的旧行为。
    this.configProvider = typeof configProvider === 'function' ? configProvider : () => getConfig();
    this.stats = { scanned: 0, candidates: 0, muted: 0, skippedProtected: 0, skippedCooldown: 0, errors: 0 };
    this.recent = [];
    // userId -> 上次处罚时间戳（冷却用）
    this.lastMuted = new Map();
    // 滑动窗口：最近的处罚时间戳（单位时间上限用）
    this.muteTimes = [];
    // "<groupId>:<userId>" -> { role, at }（群角色缓存，避免每条候选都打 API）
    this.roleCache = new Map();
  }

  #cfg() { return this.configProvider(); }
  #aa() { return this.#cfg().antiAd || {}; }
  #on(key, dflt) { const v = this.#aa()[key]; return v === undefined ? dflt : v; }

  #record(type, detail) {
    this.recent.unshift({ at: Date.now(), type, ...detail });
    if (this.recent.length > 50) this.recent.length = 50;
  }

  /**
   * 静态打分：返回 { level: 'high'|'weak'|'none', hits: string[] }
   * 纯函数、零成本，可在任意消息上安全调用。
   */
  scan(text) {
    const s = String(text || '');
    if (!s.trim()) return { level: 'none', hits: [] };
    const high = [];
    for (const re of HIGH_CONFIDENCE) if (re.test(s)) high.push(re.source.slice(0, 40));
    if (high.length) return { level: 'high', hits: high };
    const weak = [];
    for (const re of WEAK_SIGNALS) if (re.test(s)) weak.push(re.source.slice(0, 40));
    if (weak.length) return { level: 'weak', hits: weak };
    return { level: 'none', hits: [] };
  }

  /** 是否受保护（永不处罚）。返回原因字符串或 null。 */
  async #protectedReason(groupId, userId) {
    const uid = String(userId);
    const selfId = String(this.onebot.selfId ?? '');
    if (uid && uid === selfId) return '机器人自己';

    // 主人
    const master = String(this.#cfg().persona?.masterQQ || '');
    if (uid === master) return '主人';

    // 显式豁免名单
    const exempt = (this.#aa().exemptUsers || []).map(String);
    if (exempt.includes(uid)) return '豁免名单';

    // 群主 / 管理员（禁言他们权限上会被拒，且属自伤行为）
    // 结果缓存：群成员角色变动很少，而候选消息可能很多 —— 不缓存会每条都打一次 API。
    const key = `${groupId}:${uid}`;
    const cached = this.roleCache.get(key);
    const ttl = Number(this.#on('roleCacheMs', 10 * 60 * 1000));
    if (cached && Date.now() - cached.at < ttl) {
      if (cached.role === 'owner') return '群主';
      if (cached.role === 'admin') return '管理员';
      return null;
    }
    try {
      const info = await this.onebot.getGroupMemberInfo(Number(groupId), Number(uid));
      const role = String(info?.role || 'member');
      this.roleCache.set(key, { role, at: Date.now() });
      if (role === 'owner') return '群主';
      if (role === 'admin') return '管理员';
    } catch (err) {
      // 查不到身份时保守放行（不罚）——宁可漏罚不可误伤
      return `身份查询失败(${err?.message ?? err})`;
    }
    return null;
  }

  /** 频率闸门：返回 null 表示放行，否则返回拒绝原因。 */
  #rateLimited(userId) {
    const now = Date.now();
    const cooldownMs = Number(this.#on('cooldownMs', 30 * 60 * 1000));
    const last = this.lastMuted.get(String(userId));
    if (last && now - last < cooldownMs) {
      return `冷却中（${Math.ceil((cooldownMs - (now - last)) / 1000)}s）`;
    }
    const windowMs = Number(this.#on('windowMs', 10 * 60 * 1000));
    const maxInWindow = Number(this.#on('maxPerWindow', 5));
    this.muteTimes = this.muteTimes.filter((t) => now - t < windowMs);
    if (this.muteTimes.length >= maxInWindow) {
      return `窗口内处罚数达上限（${maxInWindow}）`;
    }
    return null;
  }

  /**
   * 处理一条群消息。命中广告则禁言。
   * 返回 { action:'muted'|'skipped'|'none', reason, ... }
   *
   * 调用方应已确认 groupId 在白名单内。
   */
  async inspect({ groupId, userId, text, senderName = '' }) {
    if (this.#on('enabled', false) !== true) return { action: 'none', reason: 'disabled' };
    const gid = String(groupId ?? '');
    const uid = String(userId ?? '');
    if (!gid || !uid) return { action: 'none', reason: 'no-id' };

    this.stats.scanned += 1;

    // ① 静态预筛 —— 零成本，绝大多数消息在这里就结束
    const { level, hits } = this.scan(text);
    if (level === 'none') return { action: 'none', reason: 'no-signal' };
    this.stats.candidates += 1;

    // ② 保护名单 —— **必须早于模型复核**：
    //    否则主人/管理员的每条含链接消息都要白烧一次分类请求。
    const prot = await this.#protectedReason(gid, uid);
    if (prot) {
      this.stats.skippedProtected += 1;
      this.#record('protected', { groupId: gid, userId: uid, reason: prot, hits });
      return { action: 'skipped', reason: `protected:${prot}`, hits };
    }

    // ③ 证据强度判定
    let confirmed = level === 'high';
    let verdict = level === 'high' ? 'high-confidence-keyword' : '';

    if (!confirmed) {
      // 弱特征：必须模型复核（未配置分类器则一律放行 —— 不能凭弱特征禁言）
      if (typeof this.classify !== 'function') {
        this.#record('candidate-unverified', { groupId: gid, userId: uid, hits });
        return { action: 'skipped', reason: 'weak-signal-needs-model-but-no-classifier', hits };
      }
      try {
        const r = await this.classify(String(text || ''), { groupId: gid, userId: uid, senderName });
        confirmed = r?.ad === true;
        verdict = String(r?.reason || '');
      } catch (err) {
        this.stats.errors += 1;
        this.#record('classify-error', { groupId: gid, userId: uid, error: String(err?.message ?? err) });
        return { action: 'skipped', reason: 'classify-error', hits };
      }
      if (!confirmed) {
        this.#record('candidate-cleared', { groupId: gid, userId: uid, hits, verdict });
        return { action: 'skipped', reason: 'model-says-not-ad', hits, verdict };
      }
    }

    // ④ 频率闸门
    const limited = this.#rateLimited(uid);
    if (limited) {
      this.stats.skippedCooldown += 1;
      this.#record('rate-limited', { groupId: gid, userId: uid, reason: limited, hits });
      return { action: 'skipped', reason: `rate-limited:${limited}`, hits, verdict };
    }

    const seconds = Number(this.#on('muteSeconds', DEFAULT_MUTE_SECONDS));

    // ⑤ 演练模式：只记录不处罚（开启前观察用）
    if (this.#on('dryRun', false) === true) {
      this.#record('dry-run', { groupId: gid, userId: uid, seconds, hits, verdict, text: String(text).slice(0, 120) });
      this.log(`[防广告] [演练] 本应禁言 ${uid} ${seconds}s（命中：${hits.join(',')}）`);
      return { action: 'skipped', reason: 'dry-run', hits, verdict, wouldMute: true };
    }

    // ⑥ 执行禁言
    try {
      await this.onebot.call('set_group_ban', {
        group_id: Number(gid),
        user_id: Number(uid),
        duration: seconds
      }, 15000);
      this.stats.muted += 1;
      this.lastMuted.set(uid, Date.now());
      this.muteTimes.push(Date.now());
      this.#record('muted', { groupId: gid, userId: uid, seconds, hits, verdict, text: String(text).slice(0, 120) });
      this.log(`[防广告] 已禁言 ${uid}（${senderName || '未知昵称'}）${seconds}s —— ${verdict || hits.join(',')}`);
      return { action: 'muted', seconds, hits, verdict };
    } catch (err) {
      this.stats.errors += 1;
      this.#record('mute-error', { groupId: gid, userId: uid, error: String(err?.message ?? err) });
      this.log(`[防广告] ✘ 禁言 ${uid} 失败：${err?.message ?? err}`);
      return { action: 'skipped', reason: `mute-error:${err?.message ?? err}`, hits, verdict };
    }
  }

  snapshot() {
    const aa = this.#aa();
    return {
      enabled: aa.enabled === true,
      dryRun: aa.dryRun === true,
      muteSeconds: Number(aa.muteSeconds ?? DEFAULT_MUTE_SECONDS),
      exemptUsers: (aa.exemptUsers || []).map(String),
      stats: { ...this.stats },
      recent: this.recent.slice(0, 20)
    };
  }
}

export { HIGH_CONFIDENCE, WEAK_SIGNALS, DEFAULT_MUTE_SECONDS };
