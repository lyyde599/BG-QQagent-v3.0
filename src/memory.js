// 轻量记忆：每会话一个 JSON（activeTopic / pendingThought / memberImpression）。
// 移植自原版 qq_memory_* 工具的数据模型，去掉令牌机制。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');

function memoryFile(chatKey) {
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return path.join(MEMORY_DIR, `${safe}.json`);
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
        lastConsolidatedAt: Number(parsed.lastConsolidatedAt) || 0
      };
    }
  } catch { /* 新记忆 */ }
  return { activeTopic: [], pendingThought: [], memberImpression: [], lastConsolidatedAt: 0 };
}

function save(chatKey, state) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const tmp = `${memoryFile(chatKey)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  fs.renameSync(tmp, memoryFile(chatKey));
}

export class MemoryStore {
  constructor() {
    this.cache = new Map();
  }

  #state(chatKey) {
    if (!this.cache.has(chatKey)) this.cache.set(chatKey, load(chatKey));
    return this.cache.get(chatKey);
  }

  append(chatKey, category, content, extra = {}) {
    const st = this.#state(chatKey);
    if (!st[category]) return null;
    const entry = {
      content: String(content ?? '').slice(0, 500),
      createdAt: Date.now(),
      ...extra
    };
    if (category === 'pendingThought') {
      entry.expiresAt = Date.now() + Math.max(10 * 60 * 1000, Number(extra.expiresInMs) || 2 * 60 * 60 * 1000);
    }
    // 去重：同类别同内容不重复记
    if (!st[category].some((e) => e.content === entry.content)) {
      st[category].push(entry);
    }
    save(chatKey, st);
    return entry;
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
    if (category && st[category]) return { [category]: st[category] };
    return { activeTopic: st.activeTopic, pendingThought: st.pendingThought, memberImpression: st.memberImpression };
  }

  remove(chatKey, category, { content = '', target = '' } = {}) {
    const st = this.#state(chatKey);
    if (!st[category]) return false;
    const before = st[category].length;
    if (category === 'memberImpression') {
      if (target) st[category] = st[category].filter((e) => e.target !== target);
    } else if (content) {
      st[category] = st[category].filter((e) => e.content !== content);
    }
    const removed = before !== st[category].length;
    if (removed) save(chatKey, st);
    return removed;
  }

  clear(chatKey, category = '') {
    const st = this.#state(chatKey);
    if (category && st[category]) {
      st[category] = [];
    } else {
      st.activeTopic = [];
      st.pendingThought = [];
      st.memberImpression = [];
    }
    save(chatKey, st);
  }

  /** 生成提示词里的【记忆】摘要（空的类别不出现）。 */
  formatForPrompt(chatKey) {
    const mem = this.query(chatKey);
    const lines = [];
    if (mem.activeTopic.length) {
      lines.push('【进行中的话题】');
      for (const e of mem.activeTopic.slice(-5)) lines.push(`- ${e.content}`);
    }
    if (mem.pendingThought.length) {
      lines.push('【想说但还没说的话】');
      for (const e of mem.pendingThought.slice(-5)) lines.push(`- ${e.content}`);
    }
    if (mem.memberImpression.length) {
      lines.push('【对群友的印象】');
      for (const e of mem.memberImpression.slice(-12)) lines.push(`- ${e.target || '某人'}：${e.content}`);
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
      lastConsolidatedAt: now
    };
    for (const item of Array.isArray(next?.activeTopic) ? next.activeTopic.slice(0, 6) : []) {
      const content = cut(item, 300);
      if (content) norm.activeTopic.push({ content, createdAt: now });
    }
    for (const item of Array.isArray(next?.pendingThought) ? next.pendingThought.slice(0, 6) : []) {
      const content = cut(item, 300);
      if (content) norm.pendingThought.push({ content, createdAt: now, expiresAt: now + 2 * 60 * 60 * 1000 });
    }
    for (const item of Array.isArray(next?.memberImpression) ? next.memberImpression.slice(0, 15) : []) {
      const content = cut(item?.content, 300);
      if (!content) continue;
      norm.memberImpression.push({ target: cut(item?.target ?? '', 60), content, createdAt: now });
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
