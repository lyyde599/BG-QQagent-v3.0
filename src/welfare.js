// ── 群友福利发放（2026-10-04，v2 泛化为「活动」模型）────────────────────────
//
// 需求演进：
//   v1：写死"token + Codex 券"两类福利。
//   v2（用户要求）：「把领取福利完善为能力，以后我想发布什么福利（通过发放 ck、key
//        的方式），公告，在控制面板即可操作」→ 改为**通用活动（campaign）模型**：
//        每个活动可挂任意多个「奖励项」，每项就是一串码（ck / key / 券码 / 邀请码…），
//        发放时按项轮询分配，每人每项限领一次。
//
// 为什么用**确定性代码**而不是让模型处理：
//   领取涉及「一人一次」「入群时效」「码有限先到先得」三类硬约束，
//   交给 LLM 会出三类错：同一个人反复领、不满足条件的人也发、码发超了不知道。
//   所以这里做纯代码判定 + 落盘去重，模型完全不参与发放决策。
//
// ⚠️ 已知限制：若奖励项是**共享池**（如中转站 key），我们无法在上游按人设额度，
//    "每人 N 万 token" 只是本地记账的名义值，不是技术强制。面板上会有提示。
//
// 数据落盘：
//   config.json 的 welfare.campaigns —— 活动定义（面板可编辑）
//   data/welfare-claims.json          —— 领取记录（谁领了哪项、领到什么码）
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';

// 领取记录路径：插件可注入私有目录（globalThis.__qqWelfareClaimFile），
// 未注入时用历史位置 data/welfare-claims.json。
function claimFile() {
  return globalThis.__qqWelfareClaimFile || path.join(DATA_DIR, 'welfare-claims.json');
}

const DAY_MS = 24 * 60 * 60 * 1000;

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(claimFile(), 'utf8'));
    // v1 结构迁移：{ claims: { uid: {token,coupon} }, couponIssued, keyCursor }
    // → v2：{ claims: { "<cid>:<uid>": { rewards: { rid: {...} } } }, cursors: {} }
    if (d && d.claims && !d.cursors) {
      const migrated = { claims: {}, cursors: {}, migratedFromV1: true };
      for (const [uid, rec] of Object.entries(d.claims || {})) {
        const rewards = {};
        if (rec.token) rewards.token = { code: rec.token.key, at: rec.token.at };
        if (rec.coupon) rewards.coupon = { code: rec.coupon.code, at: rec.coupon.at };
        migrated.claims[`launch-20261004:${uid}`] = { rewards };
      }
      migrated.cursors['launch-20261004:token'] = Number(d.keyCursor || 0);
      return migrated;
    }
    return d && d.claims ? d : { claims: {}, cursors: {} };
  } catch {
    return { claims: {}, cursors: {} };
  }
}
function save(d) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = claimFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
  fs.renameSync(tmp, claimFile());
}

/** 生成一个短 id */
export function newId(prefix = 'c') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 奖励项未配置 keywords 时按类型给的默认识别词 */
const DEFAULT_KEYWORDS = {
  key: ['token', '令牌', '额度', 'key', '密钥', 'api'],
  coupon: ['优惠券', '折扣券', '券', '折扣码', '优惠码'],
  ck: ['ck', 'cookie', '账号'],
  code: ['兑换码', '邀请码', '码']
};

export class Welfare {
  /**
   * @param {object} opts
   * @param {object} opts.onebot
   * @param {Function} [opts.log]
   */
  constructor({ onebot, log = () => {}, configProvider = null } = {}) {
    this.onebot = onebot;
    this.log = log;
    // 配置来源可注入（插件化后由 ctx.config 提供）；不传则回退全局 getConfig()。
    this.configProvider = typeof configProvider === 'function' ? configProvider : () => getConfig();
    this.stats = { claims: 0, codesIssued: 0, rejected: 0, errors: 0 };
  }

  #cfg() { return this.configProvider().welfare || {}; }

  /** 取所有活动（v2）；兼容 v1 的扁平配置，自动包装成一个活动 */
  campaigns() {
    const w = this.#cfg();
    if (Array.isArray(w.campaigns) && w.campaigns.length) return w.campaigns;
    // v1 兼容：把旧的 tokenKeys/coupons 包装成 launch-20261004 活动
    if (w.tokenKeys || w.coupons) {
      return [{
        id: 'launch-20261004',
        title: '群福利',
        enabled: w.enabled !== false,
        sourceGroups: w.sourceGroups || [],
        minJoinHours: w.minJoinHours ?? 24,
        graceExisting: w.graceExisting !== false,
        exemptUsers: w.exemptUsers || [],
        claimWords: [],
        rewards: [
          ...(w.tokenKeys || []).length ? [{
            id: 'token', label: 'API 额度', type: 'key',
            items: w.tokenKeys, perUser: 1,
            info: { baseUrl: w.baseUrl, model: w.model, quota: w.tokenQuota }
          }] : [],
          ...(w.coupons || []).length ? [{
            id: 'coupon', label: 'Codex 会员 97 折券', type: 'coupon',
            items: w.coupons, perUser: 1,
            info: { shopUrl: w.shopUrl }
          }] : []
        ]
      }];
    }
    return [];
  }

  enabled() {
    if (this.#cfg().enabled === false) return false;
    return this.campaigns().some((c) => c.enabled !== false);
  }

  /**
   * 识别领取意图。返回 { campaignId, rewardId|null } 或 null。
   *
   * ⚠️ 2026-10-04 事故：初版用**精确全等**匹配（`^领取福利$`），
   *    结果群友说「老大，领取福利」匹配不上 → 漏进模型 → 模型不知道有活动，
   *    当成诈骗反问「？什么福利」。**必须容忍口语化前缀/称呼/标点**。
   *    现在：先归一化（去空白标点、剥称呼前缀），再判断是否含领取动词。
   *    仍要求"领取"与具体对象/活动词同现，避免群聊闲聊误触发。
   */
  parseIntent(text, campaigns = null) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const list = campaigns || this.campaigns();

    // 疑问句不算领取指令（"这个福利怎么领"是在问，不是在领）
    if (/[？?]/.test(raw) || /(怎么|如何|怎样|能不能|可以吗|是什么|在哪)/.test(raw)) return null;

    // 归一化：去空白标点；剥掉纯称呼/礼貌前缀
    // ⚠️「要」「想」不能放进前缀剥离列表 —— 它们是领取动词的一部分（"要额度"）。
    const s = raw
      .replace(/[\s，。！、,.!~～…：:；;"'“”‘’（）()【】\[\]]/g, '')
      .replace(/^(老大|老板|群主|管理|管理员|你好|您好|请问|那个|麻烦|请|我要|我想要|我想|我)+/g, '');
    if (!s) return null;

    const grab = /(领取?|领|要|拿|申请|搞)/.test(s);
    if (!grab) return null;

    // 活动自定义领取词优先（面板里可为每个活动设口令）
    for (const c of list) {
      if (c.enabled === false) continue;
      for (const w of (c.claimWords || [])) {
        if (w && s.includes(String(w))) return { campaignId: c.id, rewardId: null };
      }
    }

    // 通用：按奖励项的关键词匹配
    for (const c of list) {
      if (c.enabled === false) continue;
      for (const r of (c.rewards || [])) {
        // 未显式配置 keywords 时，按 type 给一套默认词
        // （v1 扁平配置包装出来的奖励项没有 keywords，缺了这层就永远匹配不上）
        const kws = (r.keywords && r.keywords.length)
          ? r.keywords
          : (DEFAULT_KEYWORDS[r.type] || []);
        for (const kw of kws) {
          if (kw && s.includes(String(kw))) return { campaignId: c.id, rewardId: r.id };
        }
      }
    }

    // 兜底：说「领取福利/领取」且只有一个活动 → 该活动全部奖励
    if (/(福利|奖品|奖励|东西)/.test(s) || /^(领取|领奖|要|拿|申请|搞)$/.test(s)) {
      const active = list.filter((c) => c.enabled !== false);
      if (active.length === 1) return { campaignId: active[0].id, rewardId: null };
      if (active.length > 1) return { campaignId: null, rewardId: null };  // 多个活动需指明
    }
    return null;
  }

  /** 查群成员的入群时间（秒） */
  async #joinTime(groupId, userId) {
    try {
      const info = await this.onebot.getGroupMemberInfo(Number(groupId), Number(userId));
      return Number(info?.join_time || 0);
    } catch (e) {
      this.log(`[福利] 查成员信息失败 ${userId}: ${e?.message ?? e}`);
      return 0;
    }
  }

  /**
   * 处理领取。返回 { ok, text }
   * @param {object} p { userId, text, userName }
   */
  async claim({ userId, text, userName = '' }) {
    if (!this.enabled()) return { ok: false, text: '' };
    const intent = this.parseIntent(text);
    if (!intent) return { ok: false, text: '' };

    const uid = String(userId || '');
    if (!uid) return { ok: false, text: '' };

    const all = this.campaigns();
    let campaign = intent.campaignId ? all.find((c) => c.id === intent.campaignId) : null;
    if (!campaign) {
      const active = all.filter((c) => c.enabled !== false);
      if (active.length === 1) campaign = active[0];
      else {
        return { ok: true, text: `现在有 ${active.length} 个福利活动：\n` + active.map((c) => `· ${c.title}（发「${(c.claimWords || [])[0] || '领取 ' + c.title}」）`).join('\n') + '\n你想领哪个？' };
      }
    }

    // ── 资格校验 ──
    const groups = (campaign.sourceGroups || []).map(String);
    const minHours = Number(campaign.minJoinHours ?? 24);
    let join = 0;
    for (const g of groups) {
      const jt = await this.#joinTime(g, uid);
      if (jt > 0) { join = jt; break; }
    }
    if (!join) {
      this.stats.rejected += 1;
      return { ok: true, text: '没有查到你在我负责的群里的成员记录～\n这个福利只给群内成员，先进群再说吧。' };
    }
    const hours = (Date.now() / 1000 - join) / 3600;
    const exempt = (campaign.exemptUsers || []).map(String);
    const isExempt = exempt.includes(uid);
    // 当天前已在群的老成员默认可领；今天才入群的视为新人，需满 minHours
    const todayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); })();
    const joinedToday = join >= todayStart;
    const graceAll = campaign.graceExisting !== false;

    if (hours < minHours && !isExempt && !(graceAll && !joinedToday)) {
      this.stats.rejected += 1;
      return {
        ok: true,
        text: `你入群才 ${hours.toFixed(1)} 小时，还差一点点～\n再等约 ${Math.ceil(minHours - hours)} 小时就可以领啦 ᗜ ᴗ ᗜ`
      };
    }

    // ── 发放 ──
    const db = load();
    const key = `${campaign.id}:${uid}`;
    const rec = db.claims[key] || { rewards: {} };
    const lines = [];
    let gave = false;

    for (const r of (campaign.rewards || [])) {
      if (campaign && intent.rewardId && r.id !== intent.rewardId) continue;
      const perUser = Number(r.perUser ?? 1);
      const mine = rec.rewards[r.id];
      if (mine && perUser <= 1) {
        lines.push(`· ${r.label}：你已经领过啦（${fmtTime(mine.at)}），每人限 ${perUser} 次哦`);
        continue;
      }
      const items = (r.items || []).map(String).filter(Boolean);
      const used = new Set(Object.values(db.claims).flatMap((x) => Object.values(x.rewards || {}).map((v) => v.code)));
      const free = items.filter((x) => !used.has(x));
      if (!free.length) {
        lines.push(`· ${r.label}：已经发完了（共 ${items.length} 份，先到先得）😢`);
        continue;
      }
      const cursorKey = `${campaign.id}:${r.id}`;
      const idx = Number(db.cursors[cursorKey] || 0) % free.length;
      db.cursors[cursorKey] = idx + 1;
      const code = free[idx];
      rec.rewards[r.id] = { code, at: Date.now() };
      this.stats.codesIssued += 1;
      gave = true;
      lines.push('', renderReward(r, code));
    }

    db.claims[key] = rec;
    save(db);
    if (gave) {
      this.stats.claims += 1;
      this.log(`[福利] 已发放 ${campaign.title} 给 ${uid}${userName ? `(${userName})` : ''}`);
    }

    const head = gave
      ? `🎉 恭喜！「${campaign.title}」领取成功！`
      : `你之前已经领过「${campaign.title}」啦：`;
    return { ok: true, text: [head, ...lines].join('\n') };
  }

  /** 面板用：概览 */
  snapshot() {
    const db = load();
    const campaigns = this.campaigns().map((c) => {
      const rewards = (c.rewards || []).map((r) => {
        const used = new Set(Object.values(db.claims).flatMap((x) => Object.values(x.rewards || {}).map((v) => v.code)));
        const total = (r.items || []).length;
        const issued = (r.items || []).filter((x) => used.has(String(x))).length;
        return { id: r.id, label: r.label, type: r.type || 'code', total, issued, left: total - issued };
      });
      const claimed = Object.entries(db.claims).filter(([k]) => k.startsWith(c.id + ':')).length;
      return {
        id: c.id, title: c.title, enabled: c.enabled !== false,
        sourceGroups: c.sourceGroups || [], minJoinHours: c.minJoinHours ?? 24,
        graceExisting: c.graceExisting !== false,
        exemptUsers: c.exemptUsers || [],
        claimWords: c.claimWords || [],
        rewards, claimedUsers: claimed
      };
    });
    return {
      enabled: this.enabled(),
      campaignCount: campaigns.length,
      campaigns,
      totalClaims: Object.keys(db.claims).length,
      stats: { ...this.stats }
    };
  }

  /** 面板用：某活动的领取明细 */
  claimsOf(campaignId) {
    const db = load();
    const out = [];
    for (const [k, v] of Object.entries(db.claims)) {
      if (!k.startsWith(campaignId + ':')) continue;
      const uid = k.slice(campaignId.length + 1);
      out.push({
        userId: uid,
        at: Math.max(0, ...Object.values(v.rewards || {}).map((x) => x.at || 0)),
        rewards: Object.fromEntries(
          Object.entries(v.rewards || {}).map(([rid, x]) => [rid, { code: maskCode(x.code), at: x.at }])
        )
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
/** 面板展示用：码中间打码，避免整屏泄露 */
export function maskCode(c) {
  const s = String(c || '');
  if (s.length <= 8) return s;
  return s.slice(0, 5) + '****' + s.slice(-4);
}

/** 按奖励项类型渲染发放文案（⚠️ QQ 不渲染 Markdown，只用纯文本+符号） */
function renderReward(r, code) {
  const label = r.label || '奖励';
  const info = r.info || {};
  const L = [];
  L.push(`🎁 ${label}`, '━━━━━━━━━━━━', code, '━━━━━━━━━━━━');
  if (info.baseUrl) L.push(`📍 接口地址：${info.baseUrl}`);
  if (info.model) L.push(`🤖 模型名称：${info.model}`);
  if (info.quota) L.push(`💎 额度：${(Number(info.quota) / 10000).toFixed(0)} 万 token`);
  if (info.shopUrl) L.push(`🛒 购买地址：${info.shopUrl}`);
  if (info.note) L.push(String(info.note));
  if (info.howto) L.push('', '📖 使用方法：', String(info.howto));
  L.push('', '⚠️ 请自己收好，别发到群里哦～');
  return L.join('\n');
}

export { renderReward };
