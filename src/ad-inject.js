// ── 广告/固定内容注入 · 独立可运行原型（2026-10-18）────────────────────────
//
// 用途：关键词命中 → 机器人自动发送预设的固定内容（多条广告、每条多段消息）。
//
// 本文件是**独立原型**：不 import 项目里的任何模块，`node ad-inject-prototype.js`
// 就能跑完全部自测。落地时把 AdInject 类整段搬进 src/ad-inject.js 即可，
// 只需把三处依赖改成项目真实接口：
//   1) 配置      → 从 `this.#cfg()` 换成 `getConfig().adInject`（config.js 的 getConfig）
//   2) 发送      → sender 传入真实的 SendQueue（sendTextBatch 签名完全一致）
//   3) 落盘      → store 传入 JsonStore（生产用 DATA_DIR/ad-inject.json）
//
// ── 为什么是纯代码路径，而不是"让模型自己发广告"？────────────────────────
//   与 anti-ad.js 完全对称的论证（建议对照阅读 anti-ad.js 顶部注释）：
//     · 内容必须**一字不差**：链接、邀请码、口令、免责声明，模型改写一次就失效；
//       LLM 还有截断/美化 URL 的老毛病（把带 ?a=1&b=2 的链接改成 ...）。
//     · 成本：命中关键词就跑一次模型，纯属烧钱 —— 而这件事根本不需要智能。
//     · 稳定性：与 anti-ad 同理，**确定性动作交给代码**，模型只负责"聊天"。
//   但「不进 LLM」≠「机器人失忆」：sendTextBatch 内部会 store.appendSelf()，
//   下次运行时这条广告会以「我：...」出现在【过去状态】里，模型自然知道自己说过。
//   详见设计文档第 6 节。
//
// ── 与 anti-ad.js 的关系（相反用途，必须共存）────────────────────────────
//   anti-ad   ：检测**群友**发广告 → 禁言（保护群）
//   ad-inject ：检测**群友的关键词** → 机器人发预设内容（引导/推广）
//   两者冲突点：群友发「怎么部署」+ 带链接，可能同时被 anti-ad 判广告禁言，
//   而机器人正在给他发部署教程 —— 画面荒诞。故 app.js 里用同一次 sync 预判做门闸：
//   **ad-inject 命中就不再走 anti-ad 的禁言判定**（见设计文档第 4 节代码骨架）。
//
// ── 设计上刻意对齐 anti-ad.js / welfare.js 的三件事 ──────────────────────
//   ① 分层：**同步纯函数预判**（零成本、可被反广告门闸复用）与**异步执行**分离；
//   ② 闸门：冷却 / 每日单群上限 / 单会话小时上限，三层独立，任一不过就不发；
//   ③ 可观测：dryRun 演练 + stats + recent 审计，默认关闭，先观察再放开。

// ══════════════════════════════════════════════════════════════════════════
//  第 1 部分：默认值 & 纯函数工具
// ══════════════════════════════════════════════════════════════════════════

const DEFAULTS = {
  enabled: false,               // 总开关。默认关闭，理由见设计文档第 2 节
  dryRun: false,                // true = 只记录不发送（正式开启前观察用）
  cooldownMs: 5 * 60 * 1000,    // 同一人同一广告的冷却：5 分钟
  maxPerDayPerGroup: 3,         // 同一广告在同一个群一天最多发几次（防刷屏）
  maxPerHourPerChat: 10,        // 单会话每小时注入总次数上限（防多广告叠加刷屏）
  maxAdsPerMessage: 1,          // 一条消息最多触发几条广告（默认只发最匹配的一条）
  maxTextLength: 240,           // 超过这个字数的消息不做匹配（防引用长文误触发）
  allowPrivate: false,          // 是否允许私聊触发（默认否，理由见文档 1.2）
  skipWhenAtBot: true,          // 被 @ 时不注入（此时 LLM 必定运行，会重复回复）
  failureBackoffMs: 60 * 1000,  // 发送失败后的退避，避免对着坏配置疯狂重试
  regexMaxLength: 200           // 正则源码长度上限（ReDoS 缓解措施之一）
};

/** 北京时间（UTC+8）的 YYYY-MM-DD。服务器 TZ 是 UTC，但业务按北京时间算"一天"。 */
function dayKeyCN(ts) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 归一化文本：全角→半角、去零宽字符、折叠空白。
 *
 * 为什么必须做：QQ 群友用手机输入法会打出全角标点（"，"）和全角字母（"ＶＰＮ"），
 * 还会夹零宽字符。不做归一化，配置里写"怎么部署"就匹配不上"怎么部署？"以外的变体。
 * ⚠️ 但归一化**不删标点**：删了会把"苹果，手机"和"苹果手机"混为一谈，
 *    反而放大子串误匹配（见文档 3.1）。
 */
function normalizeText(text) {
  let s = String(text ?? '');
  // 零宽 & BOM
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  // 全角 ASCII（！到 ～）转半角
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  // 全角空格
  s = s.replace(/\u3000/g, ' ');
  // 折叠空白
  s = s.replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').trim();
  return s;
}

// 称呼/礼貌前缀：从 welfare.js 的事故里学来的（"老大，领取福利" 匹配不上纯指令）。
const LEAD_AT = /^(?:@[^\s,，。.！!？?：:]{1,20}\s*)+/;
const LEAD_ADDRESS = /^(?:老大|老板|群主|管理|管理员|你好|您好|请问|那个|麻烦|请|喂|诶|哎|话说|兄弟|大佬)+[，,。.！!？?：:~～\s]*/;

/** 剥掉"@某人 / 称呼 / 客套"前缀与尾部标点，让 exact 模式能吃口语化说法。 */
function stripLeadIn(s) {
  let out = String(s || '');
  // 循环剥：可能同时有 "@小白鲸 老大，" 这种复合前缀
  for (let i = 0; i < 5; i++) {
    const before = out;
    out = out.replace(LEAD_AT, '').replace(LEAD_ADDRESS, '');
    if (out === before) break;
  }
  return out.replace(/[。.！!？?~～…，,：:；;"'""''）)】\]]+\s*$/g, '').trim();
}

/** 该字符算不算"拉丁单词的一部分"（用于词边界判定）。 */
function isAsciiWordChar(ch) {
  return !!ch && /[A-Za-z0-9_+\-.]/.test(ch);
}

/**
 * 拉丁关键词的**词边界**判定 —— 解决 "vpn" 误匹配 "vpnxx"。
 *
 * 注意：这条只对纯 ASCII 关键词生效。中文没有词边界（"苹果手机"里确实含"苹果"），
 * 中文子串问题必须靠 `exclude` 排除词或 exact/regex 解决，见文档 3.1。
 */
function boundaryOk(hay, needle) {
  // 关键词里含非拉丁字符（中文/日文/emoji）→ 不做边界要求，直接放行
  if (!/^[\x20-\x7E]+$/.test(needle)) return true;
  let i = -1;
  while ((i = hay.indexOf(needle, i + 1)) !== -1) {
    const before = i > 0 ? hay[i - 1] : '';
    const after = hay[i + needle.length] ?? '';
    if (!isAsciiWordChar(before) && !isAsciiWordChar(after)) return true;
  }
  return false;
}

// ReDoS 缓解：嵌套量词（(a+)+）与反向引用是灾难性回溯的常见来源，直接拒绝。
const NESTED_QUANTIFIER = /\((?:[^()]*[+*][^()]*)\)\s*[+*]/;
const BACKREFERENCE = /\\[1-9]/;

/**
 * 安全编译正则。
 *
 * ⚠️ 为什么需要它：正则是**管理员**在面板里写的，但输入流是**群友**控制的。
 *    一条 `(a+)+$` 配上 200 字的 "aaaa...b" 就能把 Node 主线程锁死几十秒 ——
 *    整个机器人（含 HTTP 面板）全挂。JS 正则无法设超时，只能事前拒绝危险形态。
 *    这是缓解而非根治，文档里明确写出该限制。
 */
function compileSafeRegex(src, flags) {
  const s = String(src || '');
  if (!s) return { error: 'empty' };
  if (s.length > DEFAULTS.regexMaxLength) return { error: 'too-long' };
  if (NESTED_QUANTIFIER.test(s)) return { error: 'nested-quantifier' };
  if (BACKREFERENCE.test(s)) return { error: 'backreference' };
  try {
    return { re: new RegExp(s, flags || 'i') };
  } catch (e) {
    return { error: 'invalid:' + (e?.message ?? e) };
  }
}

/** 内容体检：把"配置时能发现的问题"提前暴露，而不是等发出去才尴尬。 */
function lintContent(messages) {
  const warnings = [];
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) warnings.push('内容为空');
  for (const m of list) {
    const t = String(m ?? '');
    if (t.length > 1000) warnings.push(`单条过长(${t.length}字)，QQ 会截断/失败`);
    // CQ 码注入：sendText 会 escapeCqText，但配置里出现的 [CQ: 说明是管理员从别处复制来的，
    // 发出去会被 QQ 当成字面量，提示他改。
    if (/\[CQ:/i.test(t)) warnings.push('含 [CQ: 片段，发送时会被转义成纯文本');
    const urls = t.match(/https?:\/\/[^\s]+/g) || [];
    for (const u of urls) {
      if (u.length > 300) warnings.push('链接过长，建议用短链');
    }
  }
  return [...new Set(warnings)];
}

// ══════════════════════════════════════════════════════════════════════════
//  第 2 部分：存储（生产环境用文件，原型默认内存）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 需要落盘的只有两样：**每日计数** 和 **审计日志**。
 *
 * 为什么每日计数要落盘（而 anti-ad 的处罚计数不用）：
 *   反广告的冷却/窗口是"限速"，进程重启后清空可以接受（重启本身就是一次刹车）；
 *   而"同一广告一天最多发 3 次"是**业务承诺**，重启清空就等于给刷屏开后门 ——
 *   群友只要把机器人重启一次（或等它崩一次）就能重新刷屏。所以必须持久化。
 * 为什么冷却（cooldownMs）可以只在内存：它是短窗口限速（分钟级），放内存足够，
 *   也避免每条消息都读盘。这样是「热路径零 IO、冷数据落盘」。
 */
class MemoryStore {
  constructor() { this.data = { daily: {}, audit: [] }; }
  load() { return this.data; }
  save(d) { this.data = d; }
}

/**
 * 生产用文件版（原子写：写 .tmp 再 rename，与 welfare.js 的 save() 同一套做法）。
 * 这里保留实现但默认不用 —— 原型要能零依赖跑起来。
 */
class JsonStore {
  constructor(fs, path) { this.fs = fs; this.path = path; }
  load() {
    try {
      const d = JSON.parse(this.fs.readFileSync(this.path, 'utf8'));
      return d && d.daily ? d : { daily: {}, audit: [] };
    } catch {
      return { daily: {}, audit: [] };
    }
  }
  save(d) {
    const tmp = this.path + '.tmp';
    this.fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
    this.fs.renameSync(tmp, this.path);   // 原子替换：断电也不会留下半个 JSON
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  第 3 部分：核心类
// ══════════════════════════════════════════════════════════════════════════

export class AdInject {
  /**
   * @param {object}   opts
   * @param {Function} [opts.config]   () => 完整配置对象（生产传 getConfig）
   * @param {object}   [opts.sender]   需提供 sendTextBatch(chatKey, messages, options)
   * @param {object}   [opts.store]    { load(), save(data) } 持久化适配器
   * @param {Function} [opts.log]
   * @param {Function} [opts.now]      时间源（测试注入假时钟，生产不传）
   */
  constructor({ config = () => ({}), sender = null, store = new MemoryStore(), log = () => {}, now = () => Date.now() } = {}) {
    this.configFn = config;
    this.sender = sender;
    this.store = store;
    this.log = log;
    this.now = now;

    this.stats = { matched: 0, sent: 0, wouldSend: 0, skipped: 0, errors: 0 };
    this.recent = [];                    // 内存审计（面板展示用，最近 50 条）

    // 冷却表：`<adId>:<userId>` -> 上次成功发送时间戳。
    // 放内存即可：分钟级限速，重启清空无副作用（见 MemoryStore 注释的对比）。
    this.lastByUser = new Map();
    // 单会话小时窗：chatKey -> [ts]
    this.chatTimes = new Map();
    // 失败退避：adId -> 解禁时间戳
    this.backoff = new Map();
    // 正则编译缓存：`<src>|<flags>` -> RegExp | null（null = 编译失败）
    this.reCache = new Map();

    this.db = this.store.load();
  }

  #cfg() { return this.configFn() || {}; }
  #ai() { return this.#cfg().adInject || {}; }
  #on(key, dflt) { const v = this.#ai()[key]; return v === undefined ? dflt : v; }

  /** 取全部广告定义（面板 CRUD 也走它）。 */
  ads() {
    const list = this.#ai().ads;
    return Array.isArray(list) ? list : [];
  }

  #record(type, detail) {
    const entry = { at: this.now(), type, ...detail };
    this.recent.unshift(entry);
    if (this.recent.length > 50) this.recent.length = 50;
    // 审计落盘（保留最近 300 条）：这是"事后追责"的唯一依据
    const d = this.db || (this.db = { daily: {}, audit: [] });
    if (!Array.isArray(d.audit)) d.audit = [];
    d.audit.unshift(entry);
    if (d.audit.length > 300) d.audit.length = 300;
  }

  #persist() {
    try {
      this.store.save(this.db);
    } catch (e) {
      // 落盘失败绝不能影响发消息（与 anti-ad 的"检测失败不影响聊天"同一条原则）
      this.stats.errors += 1;
      this.log('[广告注入] 落盘失败:', e?.message ?? e);
    }
  }

  // ── 匹配引擎 ────────────────────────────────────────────────────────────

  #getRegex(src, flags) {
    const key = `${src}|${flags || 'i'}`;
    if (this.reCache.has(key)) return this.reCache.get(key);
    const { re, error } = compileSafeRegex(src, flags);
    if (error) {
      this.log(`[广告注入] 正则不可用（${error}）：${String(src).slice(0, 60)}`);
      this.reCache.set(key, null);
      return null;
    }
    this.reCache.set(key, re);
    return re;
  }

  /**
   * 单条广告是否命中关键词。返回命中的关键词（或正则源码），未命中返回 null。
   *
   * 三种模式：
   *   exact    —— 归一化 + 剥前缀后**完全相等**。最严格，"怎么部署"不会命中
   *               "怎么部署服务器啊"，适合强指令型广告（如领取口令）。
   *   contains —— 归一化后**包含**。最宽松但也最容易误伤，适合长尾/口语化关键词，
   *               建议配 exclude 排除词。
   *   regex    —— 管理员写正则，最灵活（可写负向前瞻 `苹果(?!手机)`）。
   */
  matchAd(ad, text) {
    const mode = String(ad?.matchMode || 'contains');
    const kws = Array.isArray(ad?.keywords) ? ad.keywords : [];
    if (!kws.length) return null;

    for (const raw of kws) {
      const kw = String(raw ?? '').trim();
      if (!kw) continue;

      if (mode === 'regex') {
        const re = this.#getRegex(kw, ad.regexFlags);
        // 正则跑在**归一化文本**上：全角输入也能命中（详见 normalizeText）
        if (re && re.test(text)) return kw;
        continue;
      }

      const needle = normalizeText(kw);
      if (!needle) continue;
      // ⚠️ 必须大小写不敏感：全角输入 "ＶＰＮ" 归一化后是**大写** "VPN"，
      //    而配置里多半写小写 "vpn" —— 只做全角折叠、不做大小写折叠就会漏匹配。
      //    中文不受影响，英文关键词（vpn / api / docker）全都会踩这个坑。
      const needleLower = needle.toLowerCase();

      if (mode === 'exact') {
        // 剥前缀后再比：兼容"老大，怎么部署"这种口语化开头
        if (stripLeadIn(text).toLowerCase() === stripLeadIn(needle).toLowerCase()) return kw;
        continue;
      }

      // contains（默认）
      if (text.toLowerCase().includes(needleLower) && boundaryOk(text.toLowerCase(), needleLower)) return kw;
    }
    return null;
  }

  /** 排除词命中 → 该广告整体不触发（解决"苹果"误伤"苹果手机"，见文档 3.1）。 */
  #excluded(ad, text) {
    const ex = Array.isArray(ad?.exclude) ? ad.exclude : [];
    const hay = String(text || '').toLowerCase();
    for (const e of ex) {
      const s = normalizeText(String(e ?? '')).toLowerCase();
      if (s && hay.includes(s)) return String(e);
    }
    return null;
  }

  /**
   * 决策核心。**同步、只读、零 IO** —— 这是刻意设计：
   * app.js 需要在调用 antiAd.inspect 之前就拿到结论（两个功能互斥，见文件头），
   * 如果这里 await 一个异步操作，就会把反广告的判定拖后（禁言晚到几秒）。
   *
   * @param {object} ctx { text, kind, groupId, userId, isAtBot, isQuoteOfSelf }
   * @returns {{matched:boolean, wouldSend:boolean, reason:string, ad?:object, keyword?:string, dryRun?:boolean}}
   */
  match({ text = '', kind = 'group', groupId = '', userId = '', isAtBot = false, isQuoteOfSelf = false } = {}) {
    const ai = this.#ai();
    if (ai.enabled !== true) return { matched: false, wouldSend: false, reason: 'disabled' };

    const store = this.ads().filter((a) => a && a.enabled !== false);
    if (!store.length) return { matched: false, wouldSend: false, reason: 'no-enabled-ad' };

    const uid = String(userId ?? '');
    const gid = String(groupId ?? '');
    if (!uid) return { matched: false, wouldSend: false, reason: 'no-user' };

    // 私聊默认不注入（见文档 1.2：私聊必定触发 LLM，注入+LLM 会撞出两条回复）
    const allowPrivate = this.#on('allowPrivate', DEFAULTS.allowPrivate) === true;
    if (kind === 'private' && !allowPrivate) {
      return { matched: false, wouldSend: false, reason: 'private-not-allowed' };
    }

    // 长文本直接放弃：群友引用一大段文章时，里面几乎必然含关键词 → 必误触发
    const maxLen = Number(this.#on('maxTextLength', DEFAULTS.maxTextLength));
    const raw = String(text ?? '');
    if (maxLen > 0 && raw.length > maxLen) {
      return { matched: false, wouldSend: false, reason: 'text-too-long' };
    }

    const norm = normalizeText(raw);
    if (!norm) return { matched: false, wouldSend: false, reason: 'empty-text' };

    const now = this.now();
    const chatKey = `${kind}:${gid || uid}`;
    const day = dayKeyCN(now);
    const candidates = [];
    let lastReason = 'no-keyword';

    for (let i = 0; i < store.length; i++) {
      const ad = store[i];
      const adId = String(ad.id || '');

      // ── 作用域闸门 ──
      const groups = Array.isArray(ad.groups) ? ad.groups.map(String) : [];
      if (kind === 'group' && groups.length && !groups.includes(gid)) { lastReason = 'group-not-allowed'; continue; }
      const exGroups = Array.isArray(ad.excludeGroups) ? ad.excludeGroups.map(String) : [];
      if (kind === 'group' && exGroups.includes(gid)) { lastReason = 'group-excluded'; continue; }
      if (kind === 'private' && ad.allowPrivate !== true) { lastReason = 'ad-private-off'; continue; }

      // ── @ 语义 ──
      // 默认「被 @ 就不注入」：被 @ 时 orchestrator 必定运行（系统提示要求必回），
      // 再叠一条固定广告 = 群里两条回复撞车。这是最容易被忽略的重复来源。
      const requireAt = ad.requireAt === true;
      const skipWhenAt = ad.skipWhenAtBot !== undefined
        ? ad.skipWhenAtBot !== false
        : this.#on('skipWhenAtBot', DEFAULTS.skipWhenAtBot) === true;
      if (requireAt && !isAtBot) { lastReason = 'require-at'; continue; }
      if (!requireAt && skipWhenAt && isAtBot) { lastReason = 'skip-when-at'; continue; }

      // 引用自己发的消息 → 默认仍允许，但可关（防止"引用广告说链接打不开"又被塞一遍）
      if (isQuoteOfSelf && ad.skipWhenQuotingSelf === true) { lastReason = 'quote-of-self'; continue; }

      // ── 关键词 ──
      const ex = this.#excluded(ad, norm);
      if (ex) { lastReason = `excluded:${ex}`; continue; }
      const kw = this.matchAd(ad, norm);
      if (!kw) { lastReason = 'no-keyword'; continue; }

      // ── 闸门（只读检查，真正记账在 send 里）──
      if (this.backoff.get(adId) > now) { lastReason = 'backoff'; continue; }

      const cdMs = Number(ad.cooldownMs ?? this.#on('cooldownMs', DEFAULTS.cooldownMs));
      const last = this.lastByUser.get(`${adId}:${uid}`);
      if (cdMs > 0 && last && now - last < cdMs) {
        lastReason = `cooldown:${Math.ceil((cdMs - (now - last)) / 1000)}s`;
        continue;
      }

      const capDay = Number(ad.maxPerDayPerGroup ?? this.#on('maxPerDayPerGroup', DEFAULTS.maxPerDayPerGroup));
      const perGroup = kind === 'group';
      const dk = `${day}|${perGroup ? gid : 'p' + uid}|${adId}`;
      if (capDay > 0 && Number(this.db?.daily?.[dk] || 0) >= capDay) {
        lastReason = 'daily-cap';
        continue;
      }

      // 特异性：命中的关键词越长越具体（"怎么部署服务器" 优于 "部署"）
      candidates.push({ ad, keyword: kw, index: i, specificity: String(kw).length });
    }

    if (!candidates.length) {
      this.stats.skipped += 1;
      return { matched: false, wouldSend: false, reason: lastReason };
    }

    // 会话级总闸：多个广告叠加时防止一小时刷十几条
    const maxHour = Number(this.#on('maxPerHourPerChat', DEFAULTS.maxPerHourPerChat));
    if (maxHour > 0) {
      const times = (this.chatTimes.get(chatKey) || []).filter((t) => now - t < 3600 * 1000);
      this.chatTimes.set(chatKey, times);
      if (times.length >= maxHour) {
        this.stats.skipped += 1;
        return { matched: false, wouldSend: false, reason: 'chat-rate-cap' };
      }
    }

    // ── 排序：priority 优先 → 关键词更长（更具体）优先 → 配置顺序 ──
    candidates.sort((a, b) =>
      Number(b.ad.priority || 0) - Number(a.ad.priority || 0)
      || b.specificity - a.specificity
      || a.index - b.index);

    // ── 多命中策略：默认只发最匹配的一条 ──
    // 为什么默认 1：一次发 2~3 条广告是刷屏，群友的第一反应是"机器人抽风/被盗号"。
    const limit = Math.max(1, Math.min(3, Number(this.#on('maxAdsPerMessage', DEFAULTS.maxAdsPerMessage))));
    const picks = candidates.slice(0, limit);

    this.stats.matched += 1;
    const dryRun = this.#on('dryRun', DEFAULTS.dryRun) === true;
    if (dryRun) this.stats.wouldSend += 1;

    return {
      matched: true,
      wouldSend: !dryRun,
      dryRun,
      reason: 'matched',
      ad: picks[0].ad,
      keyword: picks[0].keyword,
      all: picks.map((p) => ({ ad: p.ad, keyword: p.keyword }))
    };
  }

  // ── 执行 ────────────────────────────────────────────────────────────────

  /**
   * 真正发送。从 match() 的结论出发，把 pick 出来的每条广告各自按批发出。
   *
   * 记账原则：**只有发送成功才消耗冷却与每日额度**。
   * 理由：配置写错（比如 chatKey 非法）导致失败时，不该把这个人的额度白白吃掉；
   *      但失败要写退避（failureBackoffMs），否则每条消息都会重试一次并刷日志。
   */
  async send(hit, { chatKey, messageId = null, userId = '', senderName = '', keyword = '' } = {}) {
    if (!hit?.matched) return { sent: false, reason: hit?.reason || 'not-matched' };

    const picks = Array.isArray(hit.all) && hit.all.length ? hit.all : [{ ad: hit.ad, keyword: hit.keyword }];
    const now = this.now();
    const results = [];

    for (const pick of picks) {
      const ad = pick.ad || {};
      const adId = String(ad.id || '');
      const messages = (Array.isArray(ad.messages) ? ad.messages : [])
        .map((m) => String(m ?? ''))
        .filter((m) => m.trim() !== '');
      if (!messages.length) {
        this.#record('empty-content', { adId, chatKey });
        results.push({ adId, sent: false, reason: 'empty-content' });
        continue;
      }

      // 演练模式：只记录，不发
      if (hit.dryRun || this.#on('dryRun', DEFAULTS.dryRun) === true) {
        this.#record('dry-run', { adId, chatKey, userId, keyword: pick.keyword, messages: messages.length });
        this.#persist();
        this.log(`[广告注入] [演练] 本应发送「${ad.name || adId}」${messages.length} 条到 ${chatKey}`);
        results.push({ adId, sent: false, reason: 'dry-run', wouldSend: true });
        continue;
      }

      const options = {};
      // 引用挂在第一条上（sendTextBatch 内部已处理"只有第一条带 reply/at"）
      if (ad.quote === true && messageId != null) options.replyToMessageId = messageId;
      if (ad.atUser === true && userId) options.atUserId = userId;

      try {
        if (!this.sender) throw new Error('sender 未注入');
        await this.sender.sendTextBatch(chatKey, messages, options);

        // 记账（成功才记）
        this.lastByUser.set(`${adId}:${String(userId)}`, now);
        const chatTimes = this.chatTimes.get(chatKey) || [];
        chatTimes.push(now);
        this.chatTimes.set(chatKey, chatTimes);

        const d = this.db || (this.db = { daily: {}, audit: [] });
        if (!d.daily) d.daily = {};
        const [kind] = String(chatKey).split(':');
        const gid = String(chatKey).split(':')[1] || '';
        const dk = `${dayKeyCN(now)}|${kind === 'group' ? gid : 'p' + userId}|${adId}`;
        d.daily[dk] = Number(d.daily[dk] || 0) + 1;

        this.stats.sent += 1;
        this.#record('sent', {
          adId, chatKey, userId, senderName,
          keyword: pick.keyword, count: messages.length,
          preview: messages.join(' / ').slice(0, 120)
        });
        this.#persist();
        this.log(`[广告注入] 已发「${ad.name || adId}」${messages.length} 条到 ${chatKey}（触发词：${pick.keyword}）`);
        results.push({ adId, sent: true, count: messages.length });
      } catch (e) {
        this.stats.errors += 1;
        // 失败退避：防止配置错误时每条群消息都去试一次
        this.backoff.set(adId, this.now() + Number(this.#on('failureBackoffMs', DEFAULTS.failureBackoffMs)));
        this.#record('send-error', { adId, chatKey, userId, error: String(e?.message ?? e) });
        this.#persist();
        this.log(`[广告注入] ✘ 发送失败「${ad.name || adId}」→ ${e?.message ?? e}`);
        results.push({ adId, sent: false, reason: 'send-error:' + (e?.message ?? e) });
      }
    }

    return {
      sent: results.some((r) => r.sent),
      // 只要有一条真发出去，就算"已注入"（app.js 用它决定是否跳过 anti-ad）
      injected: results.some((r) => r.sent),
      results
    };
  }

  /** 便捷入口：一次调用完成 判定 + 发送（不需要给 anti-ad 做门闸时用它）。 */
  async handle(ctx = {}) {
    const hit = this.match(ctx);
    if (!hit.matched) return { ...hit, sent: false };
    const r = await this.send(hit, {
      chatKey: `${ctx.kind || 'group'}:${ctx.kind === 'private' ? ctx.userId : ctx.groupId}`,
      messageId: ctx.messageId ?? null,
      userId: ctx.userId ?? '',
      senderName: ctx.senderName ?? '',
      keyword: hit.keyword
    });
    return { ...hit, ...r };
  }

  // ── 管理（面板 CRUD）────────────────────────────────────────────────────

  /**
   * 新增/更新一条广告。
   * ⚠️ 必须"整表读 → 改 → 整表写"：config.js 的 deepMerge 对**数组是整体替换**，
   *    传部分 ad 对象不会合并进旧数组，只会把整个 ads 覆盖掉（见文档"坑 2"）。
   */
  upsertAd(input, { write }) {
    const ad = {
      id: String(input?.id || '').trim() || `ad${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      name: String(input?.name || '').trim() || '未命名广告',
      enabled: input?.enabled !== false,
      matchMode: ['exact', 'contains', 'regex'].includes(input?.matchMode) ? input.matchMode : 'contains',
      keywords: (input?.keywords || []).map((k) => String(k).trim()).filter(Boolean).slice(0, 50),
      exclude: (input?.exclude || []).map((k) => String(k).trim()).filter(Boolean).slice(0, 50),
      messages: (input?.messages || []).map((m) => String(m)).filter((m) => m.trim() !== '').slice(0, 10),
      priority: Number(input?.priority || 0),
      groups: (input?.groups || []).map(String).filter(Boolean),
      excludeGroups: (input?.excludeGroups || []).map(String).filter(Boolean),
      allowPrivate: input?.allowPrivate === true,
      requireAt: input?.requireAt === true,
      skipWhenAtBot: input?.skipWhenAtBot !== false,
      skipWhenQuotingSelf: input?.skipWhenQuotingSelf === true,
      quote: input?.quote === true,
      atUser: input?.atUser === true,
      cooldownMs: Number.isFinite(Number(input?.cooldownMs)) ? Number(input.cooldownMs) : undefined,
      maxPerDayPerGroup: Number.isFinite(Number(input?.maxPerDayPerGroup)) ? Number(input.maxPerDayPerGroup) : undefined
    };
    // 没配的关键词广告 = 永远不会触发，属于配置错误，面板应拦（这里只记 warning）
    if (!ad.keywords.length) this.log(`[广告注入] 警告：「${ad.name}」没有关键词，永远不会触发`);
    if (ad.matchMode === 'regex') {
      const bad = ad.keywords.filter((k) => compileSafeRegex(k).error);
      if (bad.length) this.log(`[广告注入] 警告：正则不可用 ${bad.join(' | ')}`);
    }

    const list = [...this.ads()];
    const idx = list.findIndex((a) => String(a?.id) === ad.id);
    if (idx >= 0) list[idx] = ad; else list.push(ad);
    write(list);   // 由调用方落到 config（updateConfig({ adInject: { ...ai, ads: list } })）
    return ad;
  }

  removeAd(id, { write }) {
    const list = this.ads().filter((a) => String(a?.id) !== String(id));
    write(list);
    // 顺手清掉该广告的运行期状态，避免同名 id 重建后继承旧冷却
    for (const k of [...this.lastByUser.keys()]) if (k.startsWith(id + ':')) this.lastByUser.delete(k);
    this.backoff.delete(String(id));
    return list.length;
  }

  /**
   * 面板保存前校验正则：返回不可用的条目（空数组 = 全部可用）。
   * 为什么单独暴露：正则错误必须在**保存时**告诉管理员，
   * 而不是等群友说了一句话才发现"这条广告永远不触发"。
   */
  checkRegexes(keywords) {
    const bad = [];
    for (const k of (Array.isArray(keywords) ? keywords : [])) {
      const src = String(k ?? '').trim();
      if (!src) continue;
      const { error } = compileSafeRegex(src);
      if (error) bad.push({ keyword: src, error });
    }
    return bad;
  }

  /** 面板展示用：只给统计，不给完整内容（内容由 /api/ad-inject/ads 单独给）。 */
  snapshot() {
    const ai = this.#ai();
    const now = this.now();
    return {
      enabled: ai.enabled === true,
      dryRun: ai.dryRun === true,
      adCount: this.ads().length,
      enabledAdCount: this.ads().filter((a) => a && a.enabled !== false).length,
      stats: { ...this.stats },
      recent: this.recent.slice(0, 20),
      // 当天各广告已发次数（面板上"余量"一目了然）
      today: this.#todayUsage(now)
    };
  }

  #todayUsage(now) {
    const day = dayKeyCN(now);
    const out = {};
    for (const [k, v] of Object.entries(this.db?.daily || {})) {
      const [d, scope, adId] = k.split('|');
      if (d !== day) continue;
      out[adId] = out[adId] || {};
      out[adId][scope] = Number(v) || 0;
    }
    return out;
  }

  /** 面板"重置冷却"按钮：群友被误冷却时不用等 5 分钟。 */
  resetCooldowns() {
    this.lastByUser.clear();
    this.chatTimes.clear();
    this.backoff.clear();
    return true;
  }
}

export { DEFAULTS, normalizeText, stripLeadIn, boundaryOk, compileSafeRegex, lintContent, MemoryStore, JsonStore, dayKeyCN };

// ══════════════════════════════════════════════════════════════════════════
//  第 4 部分：自测（node ad-inject-prototype.js）
// ══════════════════════════════════════════════════════════════════════════

/** 假 sender：记录被发的批，可配置为抛错。 */
function fakeSender({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async sendTextBatch(chatKey, messages, options = {}) {
      if (fail) throw new Error('NapCat 未连接');
      calls.push({ chatKey, messages: [...messages], options });
      return { sent: messages.map((m) => ({ text: m, messageId: 1 })), failed: [] };
    }
  };
}

/** 一条标准测试配置。 */
function baseConfig(over = {}) {
  return {
    adInject: {
      enabled: true,
      dryRun: false,
      cooldownMs: 5 * 60 * 1000,
      maxPerDayPerGroup: 3,
      maxPerHourPerChat: 10,
      maxAdsPerMessage: 1,
      maxTextLength: 240,
      allowPrivate: false,
      skipWhenAtBot: true,
      ads: over.ads || [],
      ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'ads'))
    }
  };
}

const DEPLOY_AD = {
  id: 'deploy', name: '部署教程', enabled: true, matchMode: 'contains',
  keywords: ['怎么部署', '如何部署'], messages: ['想部署的话看这里', 'https://example.com/tutorial']
};
const BUY_AD = {
  id: 'buy', name: '购买引导', enabled: true, matchMode: 'contains',
  keywords: ['怎么买', '在哪买'], messages: ['点这里购买：https://shop.example.com']
};

function newEngine({ ads = [DEPLOY_AD], sender = fakeSender(), cfgPatch = {}, nowRef = { t: 1000000 } } = {}) {
  const cfg = baseConfig({ ads, ...cfgPatch });
  const eng = new AdInject({
    config: () => cfg,
    sender,
    log: () => {},
    now: () => nowRef.t
  });
  return { eng, sender, cfg, nowRef };
}

const G = { kind: 'group', groupId: '100000001', userId: '1001', senderName: '群友A' };

async function runTests() {
  let pass = 0, fail = 0;
  const ok = (cond, name, extra = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
  };

  console.log('\n[1] 总开关 / 单条开关');
  {
    let { eng } = newEngine({ cfgPatch: { enabled: false } });
    ok(eng.match({ ...G, text: '怎么部署' }).matched === false, '总开关关闭 → 不触发',
      eng.match({ ...G, text: '怎么部署' }).reason);
    ({ eng } = newEngine({ ads: [{ ...DEPLOY_AD, enabled: false }] }));
    ok(eng.match({ ...G, text: '怎么部署' }).matched === false, '单条广告 enabled:false → 不触发',
      eng.match({ ...G, text: '怎么部署' }).reason);
    ({ eng } = newEngine({ cfgPatch: { enabled: false } }));
    ok(eng.match({ ...G, text: '怎么部署' }).reason === 'disabled', '关闭时 reason=disabled');
  }

  console.log('\n[2] contains 模式');
  {
    const { eng } = newEngine();
    ok(eng.match({ ...G, text: '请问怎么部署这个项目' }).matched === true, '包含命中');
    ok(eng.match({ ...G, text: '请问怎么部署' }).keyword === '怎么部署', '返回命中的关键词');
    ok(eng.match({ ...G, text: '今天天气不错' }).matched === false, '无关文本不命中');
    ok(eng.match({ ...G, text: '怎么安装依赖' }).matched === false, '近义但不含关键词 → 不命中（不做语义联想）');
  }

  console.log('\n[3] exact 模式：严格相等');
  {
    const { eng } = newEngine({ ads: [{ ...DEPLOY_AD, matchMode: 'exact', keywords: ['怎么部署'] }] });
    ok(eng.match({ ...G, text: '怎么部署' }).matched === true, '完全相等 → 命中');
    ok(eng.match({ ...G, text: '怎么部署服务器' }).matched === false, '包含但不相等 → 不命中（这正是 exact 的价值）');
    ok(eng.match({ ...G, text: '老大，怎么部署？' }).matched === true, '剥掉称呼+标点后命中（welfare 事故的教训）');
    ok(eng.match({ ...G, text: '怎么部署啊' }).matched === false, '多一个语气词就不命中（严格性符合预期）');
  }

  console.log('\n[4] 归一化：全角 / 空格 / 零宽字符');
  {
    const { eng } = newEngine({ ads: [{ ...DEPLOY_AD, keywords: ['怎么部署'] }] });
    ok(eng.match({ ...G, text: '怎么部署？？' }).matched === true, '全角问号不影响');
    ok(eng.match({ ...G, text: '怎么 部署' }).matched === false, '插入空格后不命中（中文不做模糊匹配，符合预期）');
    const { eng: e2 } = newEngine({ ads: [{ ...DEPLOY_AD, keywords: ['vpn'] }] });
    ok(e2.match({ ...G, text: 'ＶＰＮ怎么用' }).matched === true, '全角字母 ＶＰＮ 归一化后命中');
    ok(e2.match({ ...G, text: 'vpn\u200b怎么用' }).matched === true, '零宽字符被剥离后命中');
  }

  console.log('\n[5] 子串污染：苹果 / 苹果手机');
  {
    const apple = {
      id: 'apple', name: '苹果相关', enabled: true, matchMode: 'contains',
      keywords: ['苹果'], exclude: ['苹果手机'], messages: ['你说的苹果是水果还是手机？']
    };
    const { eng } = newEngine({ ads: [apple] });
    ok(eng.match({ ...G, text: '苹果多少钱一斤' }).matched === true, '「苹果」命中');
    ok(eng.match({ ...G, text: '苹果手机好贵' }).matched === false, '「苹果手机」被 exclude 挡住（不误触发）',
      eng.match({ ...G, text: '苹果手机好贵' }).reason);
    // 正则负向前瞻等价写法
    const { eng: e2 } = newEngine({
      ads: [{ ...apple, matchMode: 'regex', keywords: ['苹果(?!手机)'], exclude: [] }]
    });
    ok(e2.match({ ...G, text: '苹果多少钱' }).matched === true, '正则负向前瞻：苹果 → 命中');
    ok(e2.match({ ...G, text: '苹果手机' }).matched === false, '正则负向前瞻：苹果手机 → 不命中');
  }

  console.log('\n[6] 拉丁词边界：vpn 不应匹配 vpnxx');
  {
    const { eng } = newEngine({ ads: [{ ...DEPLOY_AD, keywords: ['vpn'] }] });
    ok(eng.match({ ...G, text: 'vpn 怎么配置' }).matched === true, '独立单词 vpn 命中');
    ok(eng.match({ ...G, text: '用vpn上网' }).matched === true, '中文紧邻 vpn 也算边界');
    ok(eng.match({ ...G, text: 'vpnxx 是什么' }).matched === false, 'vpnxx 不命中（词边界生效）');
  }

  console.log('\n[7] regex 模式');
  {
    const { eng } = newEngine({
      ads: [{ ...DEPLOY_AD, matchMode: 'regex', keywords: ['怎么(部署|安装|运行)'] }]
    });
    ok(eng.match({ ...G, text: '怎么安装' }).matched === true, '正则分组命中');
    ok(eng.match({ ...G, text: '怎么下载' }).matched === false, '正则不匹配则不命中');
    const { eng: e2 } = newEngine({
      ads: [{ ...DEPLOY_AD, matchMode: 'regex', keywords: ['(a+)+$'] }]
    });
    ok(e2.match({ ...G, text: 'aaaaaaaaaaaaaaaaaaaaaaab' }).matched === false, 'ReDoS 危险正则被拒绝（不挂死主线程）');
    const { eng: e3 } = newEngine({
      ads: [{ ...DEPLOY_AD, matchMode: 'regex', keywords: ['([unclosed'] }]
    });
    ok(e3.match({ ...G, text: '随便说点什么' }).matched === false, '非法正则不抛异常，只是不命中');
  }

  console.log('\n[8] 多命中：优先级 / 只发一条');
  {
    const low = { ...BUY_AD, priority: 0 };
    const high = { id: 'deploy-hi', name: '部署(高优先级)', enabled: true, matchMode: 'contains', keywords: ['怎么部署'], messages: ['高优先级内容'], priority: 10 };
    const { eng } = newEngine({ ads: [low, high] });
    const hit = eng.match({ ...G, text: '怎么部署 和 怎么买 哪个好' });
    ok(hit.matched === true, '两条广告同时命中');
    ok(hit.ad.id === 'deploy-hi', 'priority 高者胜', String(hit.ad?.id));
    ok(hit.all.length === 1, '默认只发一条（maxAdsPerMessage=1）', String(hit.all.length));
  }
  {
    // 无 priority 时，关键词更长（更具体）者优先
    const short = { id: 's', name: '短词', enabled: true, matchMode: 'contains', keywords: ['部署'], messages: ['短'] };
    const long = { id: 'l', name: '长词', enabled: true, matchMode: 'contains', keywords: ['怎么部署服务器'], messages: ['长'] };
    const { eng } = newEngine({ ads: [short, long] });
    ok(eng.match({ ...G, text: '怎么部署服务器的' }).ad.id === 'l', '同优先级时更具体的长关键词优先');
  }
  {
    const { eng, sender } = newEngine({ ads: [DEPLOY_AD, BUY_AD], cfgPatch: { maxAdsPerMessage: 2 } });
    const hit = eng.match({ ...G, text: '怎么部署和怎么买' });
    ok(hit.all.length === 2, 'maxAdsPerMessage=2 时发两条', String(hit.all.length));
    await eng.send(hit, { chatKey: 'group:100000001', userId: '1001' });
    ok(sender.calls.length === 2, '两条广告各发一批', String(sender.calls.length));
  }

  console.log('\n[9] 冷却：同一个人短时间只回一次');
  {
    const { eng, sender, nowRef } = newEngine({ cfgPatch: { cooldownMs: 60000 } });
    const hit1 = eng.match({ ...G, text: '怎么部署' });
    ok(hit1.matched === true, '第一次命中');
    await eng.send(hit1, { chatKey: 'group:100000001', userId: '1001' });
    ok(sender.calls.length === 1, '第一次已发送');

    const hit2 = eng.match({ ...G, text: '怎么部署' });
    ok(hit2.matched === false, '冷却期内第二次不触发');
    ok(String(hit2.reason).startsWith('cooldown:'), 'reason 带剩余秒数', hit2.reason);

    // 另一个人不受影响
    ok(eng.match({ kind: 'group', groupId: '100000001', userId: '2002', text: '怎么部署' }).matched === true,
      '不同用户互不影响');

    // 冷却过期
    nowRef.t += 60001;
    ok(eng.match({ ...G, text: '怎么部署' }).matched === true, '冷却过期后可再触发');
  }

  console.log('\n[10] 每日单群上限（防刷屏）');
  {
    const { eng, nowRef } = newEngine({ cfgPatch: { cooldownMs: 0, maxPerDayPerGroup: 2 } });
    // cooldownMs:0 = 不限个人冷却，专门验证日上限
    for (let i = 0; i < 2; i++) {
      const h = eng.match({ ...G, text: '怎么部署' });
      ok(h.matched === true, `第 ${i + 1} 次可发`);
      await eng.send(h, { chatKey: 'group:100000001', userId: '1001' });
    }
    const h3 = eng.match({ ...G, text: '怎么部署' });
    ok(h3.matched === false, '第 3 次被日上限拦住');
    ok(h3.reason === 'daily-cap', 'reason=daily-cap', h3.reason);

    // 换群不受这个群的额度影响
    ok(eng.match({ kind: 'group', groupId: '999', userId: '1001', text: '怎么部署' }).matched === true,
      '另一个群的额度独立');

    // 次日恢复
    nowRef.t += 24 * 3600 * 1000;
    ok(eng.match({ ...G, text: '怎么部署' }).matched === true, '次日额度恢复（北京时间跨天）');
  }

  console.log('\n[11] @ 语义');
  {
    const { eng } = newEngine();
    const h = eng.match({ ...G, text: '@小白鲸 怎么部署', isAtBot: true });
    ok(h.matched === false, '被 @ 时默认不注入（LLM 必定运行，避免重复回复）', h.reason);
    ok(h.reason === 'skip-when-at', 'reason=skip-when-at', h.reason);

    const { eng: e2 } = newEngine({ ads: [{ ...DEPLOY_AD, requireAt: true }] });
    ok(e2.match({ ...G, text: '怎么部署', isAtBot: true }).matched === true, 'requireAt:true 时被 @ 才触发');
    ok(e2.match({ ...G, text: '怎么部署', isAtBot: false }).matched === false, 'requireAt:true 时未被 @ 不触发');
  }

  console.log('\n[12] 私聊策略：双闸（全局 + 单条）');
  {
    // ⚠️ 这里是「与」不是「或」：私聊里机器人一定会回话，注入最容易撞车，
    //    所以要两道锁都打开才生效 —— 全局给"允许私聊注入"的能力，单条决定"这条要不要"。
    const { eng } = newEngine();
    ok(eng.match({ kind: 'private', userId: '1001', text: '怎么部署' }).matched === false,
      '私聊默认不注入', eng.match({ kind: 'private', userId: '1001', text: '怎么部署' }).reason);

    // 只开全局，单条没开 → 仍不触发
    const { eng: e2 } = newEngine({ cfgPatch: { allowPrivate: true } });
    const h2 = e2.match({ kind: 'private', userId: '1001', text: '怎么部署' });
    ok(h2.matched === false && h2.reason === 'ad-private-off',
      '只开全局、单条 allowPrivate 未开 → 不触发（避免全局一开全部广告涌入私聊）', h2.reason);

    // 两把锁都开 → 触发
    const { eng: e3 } = newEngine({ ads: [{ ...DEPLOY_AD, allowPrivate: true }], cfgPatch: { allowPrivate: true } });
    ok(e3.match({ kind: 'private', userId: '1001', text: '怎么部署' }).matched === true, '全局 + 单条都开启后才触发');
  }

  console.log('\n[13] 群范围限制');
  {
    const { eng } = newEngine({ ads: [{ ...DEPLOY_AD, groups: ['111'] }] });
    ok(eng.match({ kind: 'group', groupId: '111', userId: '1001', text: '怎么部署' }).matched === true, '指定群内触发');
    ok(eng.match({ kind: 'group', groupId: '222', userId: '1001', text: '怎么部署' }).matched === false,
      '非指定群不触发', eng.match({ kind: 'group', groupId: '222', userId: '1001', text: '怎么部署' }).reason);
    const { eng: e2 } = newEngine({ ads: [{ ...DEPLOY_AD, excludeGroups: ['222'] }] });
    ok(e2.match({ kind: 'group', groupId: '222', userId: '1001', text: '怎么部署' }).matched === false, 'excludeGroups 生效');
  }

  console.log('\n[14] 长文本保护');
  {
    const { eng } = newEngine();
    const longText = '怎么部署' + '啊'.repeat(300);
    ok(eng.match({ ...G, text: longText }).matched === false, '超过 maxTextLength 不匹配（防引用长文误触发）',
      eng.match({ ...G, text: longText }).reason);
    const { eng: e2 } = newEngine({ cfgPatch: { maxTextLength: 0 } });
    ok(e2.match({ ...G, text: longText }).matched === true, 'maxTextLength=0 表示不限制');
  }

  console.log('\n[15] 内容体检 & 发送');
  {
    const { eng, sender } = newEngine();
    const hit = eng.match({ ...G, text: '怎么部署这个' });
    await eng.send(hit, { chatKey: 'group:100000001', messageId: 777, userId: '1001' });
    const call = sender.calls[0];
    ok(call.messages.length === 2, '多条内容作为数组交给 sendTextBatch 一次发（内部自动串行+限频）', String(call.messages.length));
    ok(call.messages[0] === '想部署的话看这里', '内容一字未改（纯代码路径的核心价值）');
    ok(call.options.replyToMessageId === undefined, '默认不引用（人为感更自然）');
    ok(lintContent(['看这里 [CQ:at,qq=1]']).some((w) => w.includes('CQ')), 'lintContent 能识别 CQ 码片段');

    const { eng: e2, sender: s2 } = newEngine({ ads: [{ ...DEPLOY_AD, quote: true, atUser: true }] });
    await e2.send(e2.match({ ...G, text: '怎么部署' }), { chatKey: 'group:100000001', messageId: 777, userId: '1001' });
    ok(s2.calls[0].options.replyToMessageId === 777, 'quote:true 时带上源消息 id');
    ok(s2.calls[0].options.atUserId === '1001', 'atUser:true 时 @ 触发者');
  }

  console.log('\n[16] dryRun 演练模式');
  {
    const { eng, sender } = newEngine({ cfgPatch: { dryRun: true } });
    const hit = eng.match({ ...G, text: '怎么部署' });
    ok(hit.matched === true && hit.wouldSend === false, 'dryRun 下 matched=true 但 wouldSend=false（供 anti-ad 门闸判断）');
    const r = await eng.send(hit, { chatKey: 'group:100000001', userId: '1001' });
    ok(sender.calls.length === 0, 'dryRun 不真发');
    ok(r.results[0].reason === 'dry-run', '结果标记 dry-run');
    ok(eng.recent.some((x) => x.type === 'dry-run'), '审计里有演练记录');
  }

  console.log('\n[17] 发送失败：不消耗冷却 + 退避');
  {
    const { eng, nowRef } = newEngine({ sender: fakeSender({ fail: true }) });
    const h1 = eng.match({ ...G, text: '怎么部署' });
    const r1 = await eng.send(h1, { chatKey: 'group:100000001', userId: '1001' });
    ok(r1.sent === false, '发送失败返回 sent:false');
    ok(eng.backoff.size === 1, '写入了失败退避');
    const h2 = eng.match({ ...G, text: '怎么部署' });
    ok(h2.matched === false && h2.reason === 'backoff', '退避期内不再重试（不打爆日志）', h2.reason);
    nowRef.t += 61000;
    ok(eng.match({ ...G, text: '怎么部署' }).matched === true, '退避到期后恢复');
  }

  console.log('\n[18] 审计与统计');
  {
    const { eng } = newEngine();
    await eng.send(eng.match({ ...G, text: '怎么部署' }), { chatKey: 'group:100000001', userId: '1001', senderName: '群友A' });
    const snap = eng.snapshot();
    ok(snap.stats.sent === 1, 'stats.sent 计数正确', String(snap.stats.sent));
    ok(snap.recent.some((x) => x.type === 'sent' && x.keyword === '怎么部署'), '审计记录了触发关键词');
    ok(snap.today.deploy && snap.today.deploy['100000001'] === 1, '当天用量按群统计');
    ok(snap.enabledAdCount === 1, '嗅探 enabledAdCount');
  }

  console.log('\n[19] CRUD：新增 / 更新 / 删除');
  {
    const { eng } = newEngine({ ads: [] });
    let written = null;
    eng.upsertAd({ name: '新广告', keywords: ['测试词'], messages: ['内容'] }, { write: (l) => { written = l; } });
    ok(Array.isArray(written) && written.length === 1, 'upsert 新增后写回整表（避免 deepMerge 数组覆盖）');
    ok(!!written[0].id, '自动生成 id');
    eng.upsertAd({ id: written[0].id, name: '改名了', keywords: ['测试词'], messages: ['内容2'] }, { write: (l) => { written = l; } });
    ok(written.length === 1 && written[0].name === '改名了', '同 id 更新而不是追加');
    eng.removeAd(written[0].id, { write: (l) => { written = l; } });
    ok(written.length === 0, '删除生效');

    // 正则校验：保存时就要把"永远不触发"的正则挑出来
    ok(eng.checkRegexes(['怎么(部署|安装)']).length === 0, '合法正则通过校验');
    ok(eng.checkRegexes(['([unclosed'])[0]?.error?.startsWith('invalid'), '非法正则被 checkRegexes 报出');
    ok(eng.checkRegexes(['(a+)+$'])[0]?.error === 'nested-quantifier', '危险正则被标为 nested-quantifier');
  }

  console.log('\n[20] 冷却表不泄漏 / 重置');
  {
    const { eng } = newEngine();
    await eng.send(eng.match({ ...G, text: '怎么部署' }), { chatKey: 'group:100000001', userId: '1001' });
    ok(eng.lastByUser.size === 1, '冷却表有一条');
    eng.resetCooldowns();
    ok(eng.lastByUser.size === 0, 'resetCooldowns 清空');
    ok(eng.match({ ...G, text: '怎么部署' }).matched === true, '重置后可立即再触发');
  }

  console.log('\n' + '='.repeat(64));
  console.log(`通过: ${pass}   失败: ${fail}`);
  if (fail) {
    console.log('广告注入原型自测未通过 ❌');
    return false;
  }
  console.log('广告注入原型自测全部通过 ✅');
  return true;
}

// 直接运行时执行自测；被 import 时只导出类，不跑测试。
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain || process.argv[1]?.endsWith('ad-inject-prototype.js')) {
  runTests().then((okAll) => process.exit(okAll ? 0 : 1));
}
