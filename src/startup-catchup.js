// 启动补偿（2026-10-28）
//
// 要解决的问题：
//   服务重启的那几十秒里，群消息**永久丢失** ——
//   既没入库，也不会被补处理。用户看到的现象是
//   "刚才明明有人说话，机器人装没看见"。
//
//   今天为了改代码重启了十几次，每次都断一段。
//   不能只靠"少重启"，要从机制上兜住。
//
// 做法：服务起来后，回看最近 N 分钟的群消息，把库里没有的补进去。
//
// 三条克制：
//   ① **只补库，不强制回复**。补进来的消息标记为已读，
//      不触发模型 —— 否则一启动就一口气回十条，比丢消息更糟。
//   ② 只补白名单里的群/人，不碰别的会话。
//   ③ 去重靠 message_id：库里已有的跳过，重启多次也不会重复。

/** 默认参数 */
export const CATCHUP_DEFAULTS = {
  windowMinutes: 10,     // 回看多久
  maxMessages: 30,       // 每个会话最多补几条
  enabled: true
};

/**
 * 把一条 OneBot 历史消息转成 store 需要的结构。
 *
 * 只做最小转换：文本 + 发送者 + 时间。
 * 图片/文件等媒体只留占位符 —— 补偿的目的是"语境不断"，
 * 不是完整复原当时的多媒体。
 */
function toEntry(raw, selfId) {
  const uid = String(raw?.sender?.user_id ?? raw?.user_id ?? '');
  if (!uid) return null;
  if (uid === String(selfId)) return null;    // 自己发的不补

  const name = String(raw?.sender?.card || raw?.sender?.nickname || uid);
  const ts = Number(raw?.time) ? Number(raw.time) * 1000 : Date.now();

  // 消息段 → 文本（够用即可，不复刻完整的 segmentsToText）
  let text = '';
  const segs = raw?.message;
  if (Array.isArray(segs)) {
    text = segs.map((s) => {
      if (!s || !s.type) return '';
      if (s.type === 'text') return s.data?.text ?? '';
      if (s.type === 'at') return `@${s.data?.qq ?? ''}`;
      if (s.type === 'image') return '[图片]';
      if (s.type === 'face') return '[表情]';
      if (s.type === 'file') return `[文件：${s.data?.file ?? ''}]`;
      if (s.type === 'reply') return '[引用]';
      return `[${s.type}]`;
    }).join('');
  } else if (typeof segs === 'string') {
    text = segs;
  } else if (raw?.raw_message) {
    text = String(raw.raw_message);
  }

  text = String(text || '').trim();
  if (!text) return null;

  return {
    mid: raw?.message_id ?? null,
    ts,
    senderId: uid,
    senderName: name,
    text
  };
}

/**
 * 执行一次启动补偿。
 *
 * @param {object} deps
 * @param {object} deps.onebot    OneBot 客户端
 * @param {object} deps.store     消息库
 * @param {Array}  deps.targets   要补的会话 [{ kind:'group', id:'1127...' }]
 * @param {object} deps.config    覆盖默认参数
 * @param {Function} deps.log     日志
 * @returns {Promise<{added:number, scanned:number, sessions:number}>}
 */
export async function runStartupCatchup({ onebot, store, targets = [], config = {}, log = () => {} }) {
  const cfg = { ...CATCHUP_DEFAULTS, ...(config || {}) };
  if (!cfg.enabled) return { added: 0, scanned: 0, sessions: 0, skipped: 'disabled' };

  const now = Date.now();
  const since = now - Math.max(1, Number(cfg.windowMinutes) || 10) * 60000;
  const selfId = String(onebot?.selfId || '');

  let added = 0;
  let scanned = 0;
  let sessions = 0;

  for (const t of targets) {
    if (!t || t.kind !== 'group') continue;
    const chatKey = `group:${t.id}`;
    sessions += 1;

    let history = [];
    try {
      history = await onebot.getGroupMsgHistory(t.id, Number(cfg.maxMessages) || 30);
    } catch (e) {
      log(`[补偿] ${chatKey} 拉历史失败：${String(e?.message ?? e).slice(0, 60)}`);
      continue;
    }

    for (const raw of history) {
      scanned += 1;
      const entry = toEntry(raw, selfId);
      if (!entry) continue;

      // 只补时间窗内的（更早的是历史，不该当新消息塞进来）
      if (entry.ts < since) continue;

      // 去重：库里已有这个 message_id 就跳过
      if (entry.mid != null) {
        try {
          if (store.findByMid(chatKey, entry.mid)) continue;
        } catch { /* 查不到就按没有处理 */ }
      }

      try {
        // 🔴 直接以 read:true 写入（2026-10-28）
        //    早先是写库后再改 entry.read —— 没用，appendIncoming 已经落盘了。
        //    补进来的消息必须标已读，否则会被当成未读触发一堆回复。
        store.appendIncoming(chatKey, { ...entry, read: true });
        added += 1;
      } catch { /* 单条失败不影响其它 */ }
    }
  }

  if (added > 0) {
    log(`[补偿] 启动回看 ${cfg.windowMinutes} 分钟：补进 ${added} 条消息（扫描 ${scanned} 条，${sessions} 个会话）`);
  }
  return { added, scanned, sessions };
}
