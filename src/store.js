// 每个会话（group:xxx / private:xxx）一个不断增长的 JSON 消息存储。
// 这是新架构的核心数据结构：模型不携带对话历史，每次运行都从这里拼接"过去状态"。
//
// 条目格式：
// {
//   id:        本地递增序号（自 1 起，同群唯一，用于 UI 定位）
//   mid:       QQ 消息 id（可为负数；自己主动发送的本地记录可能没有）
//   ts:        时间戳毫秒
//   senderId:  QQ 号（自己发送的为 selfId）
//   senderName:群名片/昵称（自己发送的为 botName）
//   text:      解析后的纯文本（[图片] 等占位符已内联）
//   self:      是否是机器人自己发的
//   read:      已读状态（运行开始时批量置 true）
//   reply:     可选 { sender, text }：该消息引用/回复的对象摘要
//   media:     可选 [{ kind, url, file, faceId, summary }] 原始媒体定位信息
// }
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');

// 🔴 消息存档一律按「**基础会话键**」读写（2026-09-15 修）。
//
// 背景（用户报告"发图 agent 取不到"）：chatKey 有两种形态——
//   · 事件入库：'private:123456'          （基础键，来自 OneBot 事件）
//   · 会话上下文：'private:123456:tutor'   （带身份模式后缀）
// 旧实现把 chatKey 直接当文件名，于是**同一个人的消息被写进两个文件**：
//   private_123456.json（有图）  vs  private_123456_tutor.json（没图）
// 学习模式下 ctx.chatKey 带 ':tutor'，工具去查后者 → 报"当前会话找不到消息"，
// 图片/表情/历史一概取不到。
//
// 修法：抽一个 canonicalChatKey()，剥掉第三段身份模式后缀，保证读写同一个文件。
// 这样无论调用方传哪种形态，看到的都是同一份完整聊天记录。
export function canonicalChatKey(chatKey) {
  const s = String(chatKey || '');
  const parts = s.split(':');
  // group:123 / private:456            → 原样
  // group:123:tutor / private:456:tutor → 去掉第三段
  if (parts.length >= 3 && parts[0] && parts[1]) return `${parts[0]}:${parts[1]}`;
  return s;
}

function chatFile(chatKey) {
  // chatKey 形如 group:123 / private:456（身份模式后缀已被剥掉）
  const safe = canonicalChatKey(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return path.join(MESSAGES_DIR, `${safe}.json`);
}

function loadChat(chatKey) {
  try {
    let text = fs.readFileSync(chatFile(chatKey), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.messages)) return parsed;
  } catch { /* 新会话 */ }
  return { chatKey, nextLocalId: 1, messages: [] };
}

function saveChat(state) {
  fs.mkdirSync(MESSAGES_DIR, { recursive: true });
  const tmp = `${chatFile(state.chatKey)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  fs.renameSync(tmp, chatFile(state.chatKey));
}

export class ChatStore {
  constructor(maxPerChat = 0) {
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    this.chats = new Map(); // chatKey -> state
  }

  setMaxPerChat(cap) {
    this.maxPerChat = Math.max(0, Number(cap) || 0);
  }

  #state(chatKey) {
    // 统一归一到基础键：这样 'private:x:tutor' 与 'private:x' 命中同一份内存态与磁盘文件，
    // 学习模式下也能看到完整聊天记录（含图片）。详见文件头 canonicalChatKey 的说明。
    const key = canonicalChatKey(chatKey);
    if (!this.chats.has(key)) this.chats.set(key, loadChat(key));
    return this.chats.get(key);
  }

  listChats() {
    // 从磁盘文件名还原（group_123.json -> group:123），已加载的直接带上
    try {
      const files = fs.readdirSync(MESSAGES_DIR).filter((f) => /^(group|private)_\d+\.json$/.test(f));
      for (const f of files) {
        const m = /^(group|private)_(\d+)\.json$/.exec(f);
        if (m) this.#state(`${m[1]}:${m[2]}`);
      }
    } catch { /* 目录不存在 */ }
    return [...this.chats.keys()];
  }

  getChatMeta(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read).length;
    const last = st.messages[st.messages.length - 1] || null;
    return { chatKey, total: st.messages.length, unread, lastTs: last?.ts ?? 0, lastText: last?.text ?? '' };
  }

  /** 追加一条收到的消息（未读）。返回写入的条目。 */
  appendIncoming(chatKey, { mid, ts, senderId, senderName, text, reply = null, media = [] }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: String(senderId ?? ''),
      senderName: String(senderName ?? ''),
      text: String(text ?? ''),
      self: false,
      read: false,
      reply: reply || null,
      media: Array.isArray(media) ? media : []
    };
    st.messages.push(entry);
    this.#trim(st);
    saveChat(st);
    return entry;
  }

  /** 记录机器人自己发出的消息（已读）。 */
  appendSelf(chatKey, { text, ts }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: null,
      ts: ts || Date.now(),
      senderId: 'self',
      senderName: '我',
      text: String(text ?? ''),
      self: true,
      read: true,
      reply: null,
      media: []
    };
    st.messages.push(entry);
    this.#trim(st);
    saveChat(st);
    return entry;
  }

  /** 快照当前未读并全部置为已读（运行开始时调用）。 */
  drainUnread(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    for (const m of st.messages) m.read = true;
    saveChat(st);
    return unread;
  }

  unreadCount(chatKey) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).length;
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true } = {}) {
    const st = this.#state(chatKey);
    const all = includeSelf ? st.messages : st.messages.filter((m) => !m.self);
    // offset = 跳过最近 N 条（用于工具翻页）。只读，绝不能修改 st.messages！
    const start = Math.max(0, all.length - Math.max(0, Number(offset) || 0));
    return all.slice(0, start).slice(-Math.max(1, Number(limit) || 1));
  }

  findByMid(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    return st.messages.find((m) => String(m.mid) === target) || null;
  }

  findByLocalId(chatKey, localId) {
    const st = this.#state(chatKey);
    return st.messages.find((m) => m.id === Number(localId)) || null;
  }

  /** 最近 senderId 出现过的活跃成员（带最后发言时间）。 */
  /**
   * 活跃成员排行。
   *
   * @param {string} chatKey
   * @param {number} limit
   * @param {{sortBy?: 'count'|'recent'}} [opts]
   *   count  = 按**发言条数**排（判断"谁最活跃"用这个）
   *   recent = 按最后发言时间排（默认，保持旧行为）
   *
   * 🔴 修一个计数 bug（2026-10-21）：
   *   旧实现 `if (!prev || prev.lastTs < m.ts)` 分支里 count 只取 prev.count+1，
   *   但**新消息时间总是更大** → 几乎总走这个分支 → count 永远等于 1，
   *   实际是按"最后时间"排序而已，根本拿不到发言量。
   */
  activeMembers(chatKey, limit = 10, opts = {}) {
    const st = this.#state(chatKey);
    const map = new Map();
    // ⏱ 时间窗口（2026-10-21 加）
    // 原来统计的是**全部存档**，不分时间。存档上限 2000 条，
    // 群聊冷的时候能覆盖好几天，于是"三周前发了 50 条的人"会被算成活跃。
    // 现在按 sinceTs（毫秒）或 windowHours（小时）过滤。
    const since = Number(opts.sinceTs)
      || (Number(opts.windowHours) > 0 ? Date.now() - Number(opts.windowHours) * 3600 * 1000 : 0);

    for (const m of st.messages) {
      if (m.self || !m.senderId) continue;
      // 拍一拍不算"发言"：它没有真实内容，只是互动动作。
      // 计入会让"爱拍一拍的人"被误判为活跃（2026-10-21）。
      if (String(m.text || '').startsWith('[拍一拍]')) continue;
      // 时间窗口外的不计入
      if (since > 0 && Number(m.ts || 0) < since) continue;
      const prev = map.get(m.senderId);
      if (!prev) {
        map.set(m.senderId, { userId: m.senderId, name: m.senderName, lastTs: m.ts, count: 1 });
      } else {
        prev.count += 1;                                  // 计数独立累加
        if (m.ts > prev.lastTs) { prev.lastTs = m.ts; prev.name = m.senderName || prev.name; }
      }
    }
    const list = [...map.values()];
    if (opts.sortBy === 'count') {
      list.sort((a, b) => (b.count - a.count) || (b.lastTs - a.lastTs));
    } else {
      list.sort((a, b) => b.lastTs - a.lastTs);
    }
    return list.slice(0, Math.max(1, limit));
  }

  #trim(st) {
    if (this.maxPerChat > 0 && st.messages.length > this.maxPerChat) {
      st.messages.splice(0, st.messages.length - this.maxPerChat);
    }
  }
}
