// 轻量记忆：每会话一个 JSON（activeTopic / pendingThought / memberImpression）。
// 移植自原版 qq_memory_* 工具的数据模型，去掉令牌机制。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');

// 🔴 类别定义（2026-11-06 优化）
//
// 用户反馈清单："没有 personFact，只有 memberImpression —— 模型会写形容词"
//
// personFact = 关于某人的**具体事实**（他明天去党校 / 他说手冷），
//   不参与"合并成综合印象"，只去重。
export const CATEGORIES = ['activeTopic', 'pendingThought', 'memberImpression', 'personFact'];

/** 每类硬上限 */
// 🔴 上限要**高于整理阈值**（2026-11-06）
//
// 整理触发条件：activeTopic 超过 8 条就开始合并。
// 如果把硬上限也设成 8，append 会立刻裁回 8 —— 永远超不过阈值，
// 整理永远不会触发，测试也会死循环（实测卡死）。
//
// 所以：硬上限 = 阈值 + 余量，让"超阈值"这件事真的能发生。
export const CAT_LIMITS = { activeTopic: 20, pendingThought: 20, memberImpression: 30, personFact: 60 };

/** 内容上限（统一 500，原来 append 500 / replace 300 不一致） */
export const CONTENT_MAX = 500;

/**
 * 🔴 chatKey → 文件名要防碰撞（2026-11-06）
 *
 * 原来 `group:1-2` 和 `group:1_2` 都会被替换成 `group_1_2` —— 同一个文件。
 * 现在：可打印字符保留，其余转十六进制 + 短哈希兜底。
 */
function memoryFile(chatKey) {
  const raw = String(chatKey);
  const safe = raw.replace(/[^a-z0-9_]/gi, '_');
  // 🔴 防碰撞，但不破坏已有文件名（2026-11-06）
  //
  // 单纯 replace 会让 `group:1-2` 和 `group:1_2` 落到同一个文件。
  // 但给**所有**文件都加哈希，会让老记忆"改名"——
  // 已有的 group_456.json 读不到，用户会觉得记忆丢了。
  //
  // 折中：只有当"清洗会丢失信息"时才加短哈希。
  // 绝大多数 chatKey（group:123 / private:456）清洗后是无损的，文件名保持不变。
  // 判据：冒号是**唯一允许被替换**的字符（它本来就不该出现在文件名里）。
  // 把冒号还原成冒号后如果和原文一致，就算无损 —— 保持老文件名。
  // 判据：把 safe 里的下划线全部还原成冒号，若等于原文 → 无损（只是冒号被换了）
  const lossless = safe.replace(/_/g, ':') === raw;
  if (lossless) return path.join(MEMORY_DIR, `${safe}.json`);
  let h = 0;
  for (let i = 0; i < raw.length; i += 1) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return path.join(MEMORY_DIR, `${safe}-${(h % 1679616).toString(36)}.json`);
}

/** 生成短 id（条目级） */
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function load(chatKey) {
  try {
    let text = fs.readFileSync(memoryFile(chatKey), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return {
        activeTopic: Array.isArray(parsed.activeTopic) ? parsed.activeTopic : [],
        pendingThought: Array.isArray(parsed.pendingThought) ? parsed.pendingThought : [],
        memberImpression: Array.isArray(parsed.memberImpression) ? parsed.memberImpression : [],
        personFact: Array.isArray(parsed.personFact) ? parsed.personFact : [],
        lastConsolidatedAt: Number(parsed.lastConsolidatedAt) || 0
      };
    }
  } catch { /* 新记忆 */ }
  return { activeTopic: [], pendingThought: [], memberImpression: [], personFact: [], lastConsolidatedAt: 0 };
}

function save(chatKey, state) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const tmp = `${memoryFile(chatKey)}.${process.pid}.tmp`;
  // 🔴 内部字段（__mtime / __checkedAt）不能落盘（2026-11-06）
  const clean = {};
  for (const [k, v] of Object.entries(state || {})) {
    if (k.startsWith('__')) continue;
    clean[k] = v;
  }
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 1), 'utf8');
  fs.renameSync(tmp, memoryFile(chatKey));
}

export class MemoryStore {
  constructor() {
    this.cache = new Map();
  }

  /**
   * 取某个会话的状态（带 mtime 失效）
   *
   * 🔴 原来只在首次 load 时读文件（2026-11-06 P0-4）
   *   用户清单："MemoryStore.cache 只在首次 load 时读文件，
   *   外部手改 JSON 后进程看不到，需重启。"
   *
   * 现在：每 2 秒最多校验一次 mtime，变了就重新读。
   *   （不每次 stat 是为了避免高频 IO；2 秒的手改延迟可接受）
   */
  #state(chatKey) {
    const cached = this.cache.get(chatKey);
    const now = Date.now();
    if (cached && cached.__checkedAt && now - cached.__checkedAt < 2000) {
      return cached;
    }
    let fileMtime = 0;
    try { fileMtime = fs.statSync(memoryFile(chatKey)).mtimeMs; } catch { /* 文件不存在 */ }
    if (!cached || cached.__mtime !== fileMtime) {
      const fresh = load(chatKey);
      fresh.__mtime = fileMtime;
      fresh.__checkedAt = now;
      this.cache.set(chatKey, fresh);
      return fresh;
    }
    cached.__checkedAt = now;
    return cached;
  }

  /** 写完更新 mtime 快照，避免自己写完后立刻又读一遍 */
  #touch(chatKey, st) {
    try {
      const m = fs.statSync(memoryFile(chatKey)).mtimeMs;
      st.__mtime = m;
      st.__checkedAt = Date.now();
    } catch { /* 忽略 */ }
    this.cache.set(chatKey, st);
  }

  /**
   * 追加一条记忆
   *
   * 🔴 返回值必须反映**真实结果**（2026-11-06 修"假成功"）
   *
   * 用户清单："非法 category 返回 null 但工具仍说 saved:true；
   *   重复内容不写入也说 saved:true；空 content 会写入空条目"
   * → 模型以为记上了，实际没有，后面继续"编记忆"。
   *
   * @returns {{ok:boolean, added:boolean, duplicate:boolean, entry:object|null, error?:string}}
   */
  append(chatKey, category, content, extra = {}) {
    const st = this.#state(chatKey);
    // ① 类别白名单
    if (!CATEGORIES.includes(category) || !Array.isArray(st[category])) {
      return { ok: false, added: false, duplicate: false, entry: null, error: `不认识的记忆类别：${category}` };
    }
    // ② 内容非空
    const text = String(content ?? '').trim().slice(0, CONTENT_MAX);
    if (!text) {
      return { ok: false, added: false, duplicate: false, entry: null, error: '记忆内容不能为空' };
    }
    // ③ 敏感信息过滤（P2：别把密钥记进来）
    if (/(sk-[a-z0-9]{12,}|api[_-]?key\s*[:=]|password\s*[:=]|密码\s*[:：]\s*\S)/i.test(text)) {
      return { ok: false, added: false, duplicate: false, entry: null, error: '这条像是密钥/口令，不记。' };
    }

    const now = Date.now();
    const entry = {
      id: newId(),
      content: text,
      createdAt: now,
      lastUsedAt: now,
      ...extra,
    };
    if (category === 'pendingThought') {
      entry.expiresAt = now + Math.max(10 * 60 * 1000, Number(extra.expiresInMs) || 2 * 60 * 60 * 1000);
    }
    if (category === 'personFact' || category === 'memberImpression') {
      entry.targetId = String(extra.targetId || '').slice(0, 32);
      entry.targetName = String(extra.target || extra.targetName || '').slice(0, 60);
      entry.source = String(extra.source || 'said').slice(0, 12);   // said | inferred
    }

    // ④ 去重：同类别同内容（同一人）不重复记
    const dup = st[category].some((e) => e.content === entry.content
      && (category !== 'personFact' && category !== 'memberImpression'
        || String(e.targetId || '') === String(entry.targetId || '')));
    if (dup) {
      return { ok: true, added: false, duplicate: true, entry: null };
    }

    // ⑤ 每类上限：超了就丢最旧的（按 lastUsedAt）
    const cap = CAT_LIMITS[category] || 20;
    st[category].push(entry);
    if (st[category].length > cap) {
      st[category].sort((a, b) => Number(b.lastUsedAt || b.createdAt || 0) - Number(a.lastUsedAt || a.createdAt || 0));
      st[category] = st[category].slice(0, cap);
    }
    save(chatKey, st);
    return { ok: true, added: true, duplicate: false, entry };
  }

  query(chatKey, category = '') {
    const st = this.#state(chatKey);
    const now = Date.now();
    // 清理过期的 pendingThought
    let changed = false;
    for (const cat of ['pendingThought']) {
      const before = st[cat].length;
      st[cat] = st[cat].filter((e) => !e.expiresAt || e.expiresAt > now);
      if (st[cat].length !== before) changed = true;
    }
    if (changed) save(chatKey, st);
    // 🔴 非法 category 不再"静默返回全部"（P2）
    if (category) {
      if (!CATEGORIES.includes(category) || !st[category]) {
        return { __error: `不认识的记忆类别：${category}` };
      }
      return { [category]: st[category] };
    }
    const out = {};
    for (const c of CATEGORIES) out[c] = st[c] || [];
    return out;
  }

  /**
   * 删除记忆
   *
   * 🔴 支持按 id 精确删（P1-9）
   *   用户清单："memberImpression 只按 target 删（一删全删）；
   *   activeTopic / pendingThought 要精确 content，模型很难复述"
   */
  remove(chatKey, category, { content = '', target = '', targetId = '', id = '' } = {}) {
    const st = this.#state(chatKey);
    if (!CATEGORIES.includes(category) || !st[category]) {
      return { ok: false, removed: 0, error: `不认识的记忆类别：${category}` };
    }
    const before = st[category].length;
    // ① 按 id（最精确）
    if (id) {
      st[category] = st[category].filter((e) => String(e.id || '') !== String(id));
    } else if (category === 'personFact' || category === 'memberImpression') {
      // ② 按人（QQ 号优先，名字兜底）
      if (targetId) st[category] = st[category].filter((e) => String(e.targetId || '') !== String(targetId));
      else if (target) {
        st[category] = st[category].filter((e) => String(e.targetName || e.target || '') !== target);
      } else if (content) {
        st[category] = st[category].filter((e) => e.content !== content);
      }
    } else if (content) {
      st[category] = st[category].filter((e) => e.content !== content);
    }
    const removed = before - st[category].length;
    if (removed > 0) save(chatKey, st);
    return { ok: true, removed };
  }

  /** 改一条（P1-9：模型记错了能改，不用删了重记） */
  update(chatKey, category, id, content) {
    const st = this.#state(chatKey);
    if (!CATEGORIES.includes(category) || !st[category]) {
      return { ok: false, error: `不认识的记忆类别：${category}` };
    }
    const text = String(content ?? '').trim().slice(0, CONTENT_MAX);
    if (!text) return { ok: false, error: '内容不能为空' };
    const e = st[category].find((x) => String(x.id || '') === String(id));
    if (!e) return { ok: false, error: '没有这条记忆（id 对不上）' };
    e.content = text;
    e.lastUsedAt = Date.now();
    save(chatKey, st);
    return { ok: true, entry: e };
  }

  /** 关键词搜索（P1-9） */
  search(chatKey, keyword, limit = 20) {
    const k = String(keyword || '').trim();
    if (!k) return [];
    const mem = this.query(chatKey);
    const out = [];
    for (const c of CATEGORIES) {
      for (const e of (mem[c] || [])) {
        if (String(e.content || '').includes(k)) out.push({ ...e, category: c });
      }
    }
    return out.slice(-limit);
  }

  clear(chatKey, category = '') {
    const st = this.#state(chatKey);
    // 🔴 非法 category 不再"清空全部"（P2）
    if (category) {
      if (!CATEGORIES.includes(category) || !st[category]) {
        return { ok: false, error: `不认识的记忆类别：${category}` };
      }
      st[category] = [];
    } else {
      for (const c of CATEGORIES) st[c] = [];
    }
    save(chatKey, st);
    return { ok: true };
  }

  /** 生成提示词里的【记忆】摘要（空的类别不出现）。 */
  /**
   * 生成提示词用的记忆摘要
   *
   * 🔴 按场景过滤（2026-11-06 P0-3）
   *
   * 用户清单："群聊也会把【记忆】整段注入，包括对群友 A/B 的印象；
   *   插件工具守卫只能防 memory_query 调用，防不了 prompt 里已经有这些内容；
   *   模型可能被诱导复述。"
   *
   * @param {string} chatKey
   * @param {{scope?:'group'|'private', isMaster?:boolean}} opts
   *   群聊里只给"本群安全条目"（进行中的话题 + 想说没说的话），
   *   不给任何关于具体人的印象/事实 —— 那属于私密。
   */
  formatForPrompt(chatKey, opts = {}) {
    const scope = String(opts.scope || 'private');
    const isMaster = opts.isMaster === true;
    // 群聊且不是主人 → 只注入非人物类
    const groupSafe = scope === 'group' && !isMaster;
    const mem = this.query(chatKey);
    const lines = [];
    // 🔴 时间要打出来（P1-7）
    //   用户清单："formatForPrompt 不打印 createdAt" ——
    //   模型看到"他明天去党校"却不知道是几天前记的，会当现在的事说。
    const ago = (ts) => {
      const t = Number(ts) || 0;
      if (!t) return '';
      const d = Date.now() - t;
      const day = 86400000;
      if (d < 0) return '刚';
      if (d < day) return '今天';
      if (d < day * 2) return '昨天';
      if (d < day * 7) return `${Math.floor(d / day)} 天前`;
      return `${Math.floor(d / day)} 天前`;
    };
    // 按最近使用排序（P2：原来 slice(-N) 按写入顺序，旧的可能挤掉新的）
    const recent = (arr, n) => [...(arr || [])]
      .sort((a, b) => Number(b.lastUsedAt || b.createdAt || 0) - Number(a.lastUsedAt || a.createdAt || 0))
      .slice(0, n);

    if (mem.activeTopic?.length) {
      lines.push('【进行中的话题】');
      for (const e of recent(mem.activeTopic, 5)) {
        const t = ago(e.createdAt);
        lines.push(`- ${e.content}${t ? `（${t}）` : ''}`);
      }
    }
    if (mem.pendingThought?.length) {
      lines.push('【想说但还没说的话】');
      for (const e of recent(mem.pendingThought, 5)) lines.push(`- ${e.content}`);
    }
    if (!groupSafe && mem.memberImpression?.length) {
      lines.push('【对群友的印象】');
      for (const e of recent(mem.memberImpression, 12)) {
        const who = e.targetName || e.target || '某人';
        const t = ago(e.createdAt);
        lines.push(`- ${who}${t ? `（${t}）` : ''}：${e.content}`);
      }
    }
    // 🔴 具体事实单独一段（P1-5）
    //   和"印象"分开：事实是"他明天去党校"，印象是"他最近很忙"。
    if (!groupSafe && mem.personFact?.length) {
      lines.push('【关于他们的具体事实】');
      for (const e of recent(mem.personFact, 15)) {
        const who = e.targetName || e.target || '某人';
        const t = ago(e.createdAt);
        // 🔴 来源要说清楚（P1-8）：他说 vs 我猜
        const src = e.source === 'inferred' ? '（推测）' : '（他说的）';
        lines.push(`- ${who}${t ? `（${t}）` : ''}${src}：${e.content}`);
      }
    }
    return lines.join('\n');
  }

  // ── 自动整理（consolidation）──

  /** 整理触发判断所需的状态：各类条数 + 上次整理时间。 */
  consolidationState(chatKey) {
    const st = this.#state(chatKey);
    return {
      lastConsolidatedAt: Number(st.lastConsolidatedAt) || 0,
      counts: {
        activeTopic: st.activeTopic.length,
        pendingThought: st.pendingThought.filter((e) => !e.expiresAt || e.expiresAt > Date.now()).length,
        memberImpression: st.memberImpression.length
      }
    };
  }

  /**
   * 用整理结果整体替换某会话的记忆。
   * 先把原文件轮转备份 3 份（data/memory/backups/），再原子写入。
   * 返回规范化后的新状态（只保留合法条目，各类有硬上限）。
   */
  replaceConsolidated(chatKey, next) {
    const cut = (s, n) => String(s ?? '').trim().slice(0, n);
    const now = Date.now();
    const norm = {
      activeTopic: [],
      pendingThought: [],
      memberImpression: [],
      personFact: [],
      lastConsolidatedAt: now
    };
    // 🔴 personFact 不参与整理（P0-4 最重要的一条）
    //
    // 用户清单："consolidation 会把具体事实合并成综合印象，还会重置时间。
    //   用户要的'他明天去党校 / 他说手冷'会在 6 小时后变成'他最近很忙'"
    //
    // 事实**原样保留**（只去重），不合并、不改时间。
    const oldFacts = Array.isArray(this.#state(chatKey).personFact) ? this.#state(chatKey).personFact : [];
    const seenFact = new Set();
    for (const f of oldFacts) {
      const key = `${f.targetId || ''}|${f.content}`;
      if (seenFact.has(key)) continue;
      seenFact.add(key);
      norm.personFact.push({ ...f });
    }
    // 整理结果里如果带了新事实，追加（同样去重）
    for (const item of Array.isArray(next?.personFact) ? next.personFact : []) {
      const content = cut(item?.content, CONTENT_MAX);
      if (!content) continue;
      const key = `${item?.targetId || ''}|${content}`;
      if (seenFact.has(key)) continue;
      seenFact.add(key);
      norm.personFact.push({
        id: newId(),
        content,
        targetId: cut(item?.targetId, 32),
        targetName: cut(item?.targetName ?? item?.target ?? '', 60),
        source: item?.source === 'inferred' ? 'inferred' : 'said',
        createdAt: Number(item?.createdAt) || now,
        lastUsedAt: now,
      });
    }
    // 上限保护
    const factCap = CAT_LIMITS.personFact;
    if (norm.personFact.length > factCap) {
      norm.personFact.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      norm.personFact = norm.personFact.slice(0, factCap);
    }
    for (const item of Array.isArray(next?.activeTopic) ? next.activeTopic.slice(0, 6) : []) {
      const content = cut(item, CONTENT_MAX);
      if (content) norm.activeTopic.push({ id: newId(), content, createdAt: now, lastUsedAt: now });
    }
    for (const item of Array.isArray(next?.pendingThought) ? next.pendingThought.slice(0, 6) : []) {
      const content = cut(item, CONTENT_MAX);
      if (content) norm.pendingThought.push({ id: newId(), content, createdAt: now, lastUsedAt: now, expiresAt: now + 2 * 60 * 60 * 1000 });
    }
    for (const item of Array.isArray(next?.memberImpression) ? next.memberImpression.slice(0, 15) : []) {
      // 🔴 兼容两种形态（2026-11-06）
      //   整理结果可能是字符串 '小明：最近很忙'，也可能是对象 {target,content}。
      //   原来只认对象，字符串全被丢弃 —— 整理完印象就没了。
      let content = '';
      let tgt = '';
      if (typeof item === 'string') {
        const s = String(item);
        const m = /^([^：:]{1,20})[：:](.+)$/.exec(s);
        if (m) { tgt = m[1].trim(); content = cut(m[2].trim(), CONTENT_MAX); }
        else content = cut(s, CONTENT_MAX);
      } else {
        content = cut(item?.content, CONTENT_MAX);
        tgt = cut(item?.targetName ?? item?.target ?? '', 60);
      }
      if (!content) continue;
      norm.memberImpression.push({
        id: newId(), content,
        target: tgt,
        targetName: tgt,
        targetId: cut(item?.targetId ?? '', 32),
        createdAt: now, lastUsedAt: now,
      });
    }
    try {
      const backupDir = path.join(MEMORY_DIR, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const base = path.join(backupDir, path.basename(memoryFile(chatKey)));
      for (let i = 2; i >= 1; i--) {
        try { fs.renameSync(`${base}.${i}`, `${base}.${i + 1}`); } catch { /* 没有更旧的备份 */ }
      }
      try { fs.copyFileSync(memoryFile(chatKey), `${base}.1`); } catch { /* 原文件尚不存在 */ }
    } catch { /* 备份失败不阻塞整理 */ }
    save(chatKey, norm);
    this.cache.set(chatKey, norm);
    return norm;
  }
}
