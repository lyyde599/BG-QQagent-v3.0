// 表情包体系（移植自原版 sticker-lib.js）：本地表情知识库 + 搜索 + 提示词摘要。
// QQ 收藏表情（SnowLuma fetch_custom_face_detail）是"源"，本地库是 AI 认知层。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    url: String(entry.url || '').trim(),
    md5: String(entry.md5 || '').trim().toUpperCase(),
    desc: String(entry.desc ?? '').trim(),
    localNote: String(entry.localNote ?? '').trim(),
    tags,
    usage: String(entry.usage ?? '').trim(),
    source: entry.source === 'manual' ? 'manual' : (entry.source === 'ai' ? 'ai' : 'qq'),
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? '').slice(0, 200),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso())
  };
}

export function loadStickerStore(file = STICKER_FILE) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStickerEntry).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveStickerStore(entries, file = STICKER_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function mergeStickerLibrary(existing, fetched) {
  const out = existing.map(normalizeStickerEntry).filter(Boolean);
  const byId = new Map(out.map((e) => [e.id, e]));
  const fetchedIds = new Set();
  for (const item of Array.isArray(fetched) ? fetched : []) {
    const id = String(item?.emoji_id || item?.resId || item?.id || '').trim();
    if (id) fetchedIds.add(id);
  }
  for (const item of Array.isArray(fetched) ? fetched : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id) continue;
    const old = byId.get(id);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: String(item.url || old?.url || '').trim(),
      md5: String(item.md5 || old?.md5 || '').trim().toUpperCase(),
      desc: String(item.desc ?? old?.desc ?? '').trim(),
      localNote: old?.localNote || '',
      tags: old?.tags || [],
      usage: old?.usage || '',
      source: old?.source || 'qq',
      useCount: old?.useCount || 0,
      lastUsedAt: old?.lastUsedAt || 0,
      lastContext: old?.lastContext || '',
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso()
    });
    if (!merged) continue;
    if (!byId.has(id)) {
      out.push(merged);
      byId.set(id, merged);
    } else {
      const idx = out.findIndex((e) => e.id === id);
      if (idx >= 0) out[idx] = merged;
    }
  }
  return out.filter((e) => e.source !== 'qq' || fetchedIds.has(e.id));
}

export function findSticker(entries, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const md5 = raw.toUpperCase();
  const urlNormalized = raw.replace(/\/+$/, '').replace(/^https?:\/\//i, '');
  return (Array.isArray(entries) ? entries : []).find((e) => {
    if (!e) return false;
    if (e.id === raw || e.resId === raw) return true;
    if (e.md5 && e.md5 === md5) return true;
    const eUrl = String(e.url || '').replace(/\/+$/, '').replace(/^https?:\/\//i, '');
    if (eUrl && urlNormalized && (eUrl === urlNormalized || eUrl.includes(urlNormalized) || urlNormalized.includes(eUrl))) return true;
    return false;
  }) || null;
}

export function formatStickerList(entries, query = '', limit = 48) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const q = String(query ?? '').trim().toLowerCase();
  const filtered = q
    ? list.filter((e) => {
        const haystack = [e.desc, e.localNote, e.usage, e.id, e.resId, e.md5, ...(e.tags || [])].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : list;
  const max = Math.max(1, Math.min(500, Number(limit) || 48));
  const items = filtered.slice(0, max).map((e) => ({
    id: e.id,
    desc: e.desc || '',
    localNote: e.localNote || '',
    tags: e.tags || [],
    useCount: e.useCount || 0
  }));
  return { total: list.length, matched: filtered.length, truncated: filtered.length > max, stickers: items };
}

/** 提示词里的【可用表情包】摘要（不暴露完整 URL，控制上下文体积）。 */
export function buildStickerContext(entries, max = 10) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  if (!list.length) return '';
  // 🔴 2026-10-30 缓存优化 P3：不再按 useCount 排序、不再输出「用过 N 次」
  //
  // 原来：按使用次数排序 + 每条带「（用过 N 次）」。
  // 结果每用一次表情，提示词这一段就变一次 —— 尾部缓存失效。
  //
  // 现在：
  //   · 排序键改成「是否常用」的**布尔阈值**（用过 ≥3 次就算常用），
  //     这样常用/不常用的相对顺序稳定，不会因为 5 次变 6 次而重排
  //   · 输出里去掉具体次数，只保留稳定的标签/备注
  //
  // 代价：模型看不到「哪个用得最多」，但本来也只是参考，不影响选表情。
  const POPULAR_AT = 3;
  const top = [...list]
    .sort((a, b) => {
      const pa = (a.useCount || 0) >= POPULAR_AT ? 1 : 0;
      const pb = (b.useCount || 0) >= POPULAR_AT ? 1 : 0;
      if (pa !== pb) return pb - pa;                      // 常用的排前面
      const da = (a.desc || a.localNote) ? 1 : 0;
      const db = (b.desc || b.localNote) ? 1 : 0;
      if (da !== db) return db - da;                      // 有备注的优先
      return String(a.id || a.key || '').localeCompare(String(b.id || b.key || ''));  // 其余按 id 稳定排序
    })
    .slice(0, Math.max(1, Math.min(30, Number(max) || 10)));
  const lines = top.map((e) => {
    const label = e.desc || e.localNote || '（无备注，可先看图）';
    const extra = e.tags?.length ? ` [${e.tags.join('/')}]` : '';
    return `- ${label}${extra}`;
  });
  return `【可用表情包】你的 QQ 收藏表情里有 ${list.length} 个表情（以下为常用/有备注的 ${top.length} 个，完整列表可用 list_stickers 查询）：\n${lines.join('\n')}`;
}

/** 发送前的表情包策略提示（软策略）。 */
export function buildStickerStrategyHint() {
  return [
    '【表情包策略：像真人一样用，不刷屏】',
    '- 合适时机：被戳中笑点/槽点、接梗、怼人、赞同、自嘲、安慰、无语、赢了/输了、告别/晚安、别人发了表情时回一张，都可以自然用。',
    '- 频率：普通闲聊不用每条都配；热闹/玩梗时可以更密，但不要连续刷屏。系统有自动节流，你判断合适就发，到时间它才放行。',
    '- 选择：优先用备注（desc）和你的记忆（localNote/tags）能准确对上语境的；没有备注/不确定的表情，先 get_sticker_image 看图再决定，不要瞎发。',
    '- 发送：用 send_sticker；一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话先用 send_message 作为单独气泡发出，再单独发表情。',
    '- 不要：在严肃/正式/敏感话题硬塞表情；不要每次都用同一个；不要一条消息里塞多个表情；不要把文字和表情混在同一个气泡里。'
  ].join('\n');
}

export function applyStickerNote(entries, id, patch = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    localNote: patch.note !== undefined ? String(patch.note ?? '').trim() : target.localNote,
    // 🔴 desc 必须跟着 note 一起更新（2026-10-21 修）。
    //    原来这里漏了 desc，导致 desc 永远停在**第一次收藏时**的版本：
    //    collect() 首次写入 desc，之后再次收藏只调 note() 不碰 desc，
    //    于是同一条记录里 desc 是第 1 版、localNote 是第 3 版，
    //    而提示词读的是 desc —— 模型看到的是过期认知。
    desc: patch.note !== undefined ? String(patch.note ?? '').trim() : target.desc,
    tags: Array.isArray(patch.tags) ? patch.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : target.tags,
    usage: patch.usage !== undefined ? String(patch.usage ?? '').trim() : target.usage,
    source: patch.source || target.source || 'ai',
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

export function markStickerUsed(entries, id, context = '') {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context || '').slice(0, 200),
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}
