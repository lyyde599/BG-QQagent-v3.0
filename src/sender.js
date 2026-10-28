// 发送队列：所有对 QQ 的出站消息都经过这里。
// - 每会话串行（sendChain），真人化间隔（随机区间 + 按字数附加）
// - 分钟/小时限频（超限直接拒绝，工具会把错误告诉模型）
// - Markdown → 纯文本、QQ 硬长度切分、CQ 转义
// - 发出的每一条记进 ChatStore（self=true，供下一次运行当"自己的发言"）
import { getConfig } from './config.js';
import { sleep, randInt, createSendChain, escapeCqText, formatClockTime } from './util.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';

export class SendQueue {
  #memberCache = new Map();
  /**
   * 把文本里的「@昵称」转成真正的 at 段（2026-10-28）
   *
   * 问题：模型经常不调 atUserId 参数，而是在正文里手打「@云鸮#123」。
   *   发出去只是一段普通文字 —— 被 @ 的人**收不到提醒**，
   *   表现是「形式上对了，但对方没反应」。
   *
   * 做法：发送前把群成员名单拉下来，按昵称/群名片匹配文本里的 @xxx，
   *   命中就把那段文字替换成 { type:'at', data:{qq} } 段。
   *
   * 保守原则：
   *   · 只在群聊里做（私聊没有群成员概念，@ 无意义）
   *   · 昵称支持带 #数字后缀（QQ 客户端复制出来的格式）
   *   · 匹配不到就不动，保持原文本（宁可假 @ 也不误 @）
   *   · 名单拉取失败就跳过，不影响正常发送
   *
   * @returns {Array} OneBot 消息段数组
   */
  async #toSegments(kind, id, text) {
    const plainSeg = { type: 'text', data: { text: escapeCqText(String(text ?? '')) } };
    if (kind !== 'group') return [plainSeg];

    const src = String(text ?? '');
    if (!src.includes('@')) return [plainSeg];

    // 拉群成员名单（带短缓存，避免每条消息都请求一次）
    let members = null;
    try {
      members = await this.#groupMembersCached(id);
    } catch { /* 拉不到就按纯文本发 */ }
    if (!members || !members.length) return [plainSeg];

    // 昵称 → QQ 号（同一昵称多人时取第一个，并记下来避免歧义误伤）
    const byName = new Map();
    for (const m of members) {
      const card = String(m.card || '').trim();
      const nick = String(m.nickname || '').trim();
      const qq = String(m.user_id ?? '');
      if (!qq) continue;
      if (card) byName.set(card, qq);
      if (nick && !byName.has(nick)) byName.set(nick, qq);
    }

    // 逐个 @xxx 尝试替换。@ 后面允许：昵称（可含空格外的任意字符）、#数字
    const out = [];
    const re = /@([^\s@]{1,32})/g;
    let last = 0;
    let m;
    let replaced = 0;
    while ((m = re.exec(src)) !== null) {
      const raw = m[1];
      // 去掉 QQ 客户端复制时带的 #数字后缀
      const candidates = [raw, raw.replace(/#\d+$/, '')];
      let qq = null;
      for (const c of candidates) {
        if (byName.has(c)) { qq = byName.get(c); break; }
      }
      if (!qq) continue;   // 匹配不到：保留原文

      // 前面的普通文字
      if (m.index > last) {
        out.push({ type: 'text', data: { text: escapeCqText(src.slice(last, m.index)) } });
      }
      out.push({ type: 'at', data: { qq } });
      last = m.index + m[0].length;
      replaced++;
    }

    if (!replaced) return [plainSeg];
    if (last < src.length) {
      out.push({ type: 'text', data: { text: escapeCqText(src.slice(last)) } });
    }
    return out.length ? out : [plainSeg];
  }

  /** 群成员名单短缓存（60 秒），避免每条消息都打一次 API */
  async #groupMembersCached(groupId) {
    const now = Date.now();
    const c = this.#memberCache.get(groupId);
    if (c && now - c.at < 60000) return c.list;
    const list = await this.onebot.call('get_group_member_list', { group_id: groupId });
    const arr = Array.isArray(list) ? list : [];
    this.#memberCache.set(groupId, { at: now, list: arr });
    if (this.#memberCache.size > 50) this.#memberCache.clear();
    return arr;
  }

  constructor({ onebot, store, onSent = null }) {
    this.onebot = onebot;
    this.store = store;
    this.onSent = onSent;
    this.chains = new Map();      // chatKey -> enqueue fn
    this.minuteTimes = new Map(); // chatKey -> [ts]
    this.hourTimes = new Map();   // chatKey -> [ts]
  }

  #chain(chatKey) {
    if (!this.chains.has(chatKey)) this.chains.set(chatKey, createSendChain());
    return this.chains.get(chatKey);
  }

  #checkRate(chatKey) {
    const now = Date.now();
    const cfg = getConfig().send;
    const maxMin = Number(cfg.maxPerMinute) || 0;
    const maxHour = Number(cfg.maxPerHour) || 0;
    if (maxMin <= 0 && maxHour <= 0) return;   // 0/缺省 = 不限速（主人已取消频率限制）
    const minute = (this.minuteTimes.get(chatKey) || []).filter((t) => now - t < 60000);
    const hour = (this.hourTimes.get(chatKey) || []).filter((t) => now - t < 3600000);
    if (maxMin > 0 && minute.length >= maxMin) {
      throw new Error(`发送频率超限（每分钟最多 ${maxMin} 条），请等一会再发`);
    }
    if (maxHour > 0 && hour.length >= maxHour) {
      throw new Error(`发送频率超限（每小时最多 ${maxHour} 条）`);
    }
    minute.push(now);
    hour.push(now);
    this.minuteTimes.set(chatKey, minute);
    this.hourTimes.set(chatKey, hour);
  }

  #gap(text, isLast) {
    const cfg = getConfig().send;
    const min = Math.max(200, Number(cfg.minGapMs) || 1000);
    const max = Math.max(min, Number(cfg.maxGapMs) || 3000);
    if (isLast) return 0;
    const byLength = Math.min(8000, (String(text || '').length) * (Number(cfg.byLengthMs) || 20));
    return Math.min(15000, Math.max(min, randInt(min, max) * 0.5 + byLength * 0.5));
  }

  /**
   * 发送一批文本消息（一条或多条）。
   * options: { replyToMessageId, atUserId }
   * 返回 { sent: [{text, messageId}], failed: [{text, error}] }；全部失败时抛错。
   */
  async sendTextBatch(chatKey, messages, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') throw new Error(`非法会话 key：${chatKey}`);
    const list = Array.isArray(messages) ? messages : [messages];
    if (!list.length) throw new Error('消息列表为空');
    const hardSplitAt = Number(getConfig().send?.hardSplitAt) || 0;
    const parts = [];
    for (const m of list) {
      let plain = mdToPlain(String(m ?? ''));
      if (!plain) continue;
      // 统一清洗模型偶尔夹带的 XML 工具调用残留（</parameter></invoke></tool_calls> 等）
      plain = plain
        .replace(/<\/?[a-zA-Z][^>]*>/g, '')
        .replace(/<\/?parameter>|<\/?invoke>|<\/?tool_calls>|<\/?function_calls>|<\/?search_attempts>/gi, '')
        .replace(/^\s*<\/?[a-zA-Z]+/gm, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (!plain) continue;
      if (hardSplitAt > 0 && plain.length > hardSplitAt) parts.push(...splitForQQ(plain, hardSplitAt));
      else parts.push(plain);
    }
    if (!parts.length) throw new Error('消息内容为空');

    const chain = this.#chain(chatKey);
    const promises = [];
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      const isLast = i === parts.length - 1;
      const gap = this.#gap(text, isLast);
      promises.push(chain(async () => {
        this.#checkRate(chatKey);
        if (gap > 0) await sleep(gap);
        // 🔴 2026-10-28：把正文里的「@昵称」转成真正的 at 段
        //
        // 模型经常不调 atUserId，而是手打「@云鸮#123」—— 发出去只是普通文字，
        // 被 @ 的人收不到提醒。这里自动识别并转成 at 段。
        //
        // 显式传了 atUserId 时，仍把它排在最前面（保持原有语义）。
        let segments = await this.#toSegments(kind, id, text);

        // 引用与 atUserId 只挂在第一条上（回的就是那条）
        if (i === 0) {
          const prefix = [];
          if (options.replyToMessageId != null && String(options.replyToMessageId).trim() !== '') {
            prefix.push({ type: 'reply', data: { id: String(options.replyToMessageId).trim() } });
          }
          if (options.atUserId != null && String(options.atUserId).trim() !== '') {
            const at = String(options.atUserId).trim();
            if (/^\d+$/.test(at)) prefix.push({ type: 'at', data: { qq: at } });
          }
          if (prefix.length) segments = [...prefix, ...segments];
        }

        const data = await this.onebot.sendSegments(kind, id, segments, {
          // 群临时会话：非好友的群成员必须带 group_id 才能私聊
          extraGroupId: options.extraGroupId ?? null,
        });
        const ts = Date.now();
        this.store.appendSelf(chatKey, { text, ts });
        this.onSent?.({ chatKey, text, messageId: data?.message_id ?? null });
        return { text, messageId: data?.message_id ?? null, at: formatClockTime(ts) };
      }));
    }

    const settled = await Promise.allSettled(promises);
    const sent = [];
    const failed = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') sent.push(r.value);
      else failed.push({ error: String(r.reason?.message ?? r.reason) });
    }
    if (sent.length === 0 && failed.length > 0) {
      throw new Error(failed.map((f) => f.error).join('；'));
    }
    return { sent, failed };
  }

  /** 上传文件到当前会话（产物交付用）。 */
  sendFile(chatKey, filePath, fileName) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      const attemptAt = Date.now();
      try {
        const data = await this.onebot.sendFile(kind, id, filePath, fileName);
        const ts = Date.now();
        this.store.appendSelf(chatKey, { text: `[文件:${fileName || String(filePath).split('/').pop()}]`, ts });
        this.onSent?.({ chatKey, text: '[文件]', messageId: data?.file_id ?? null });
        return data;
      } catch (e) {
        const msg = String(e?.message ?? e);
        // 🔴 文件通道同样有「假性超时」（2026-10-27 用户反馈）
        //
        // 现象：一次「画个龙」请求，机器人发了 3 张图还说"图送不出"。
        // 根因是 sendImage 判超时 → 降级调 sendFile → sendFile 也超时 →
        // 整条降级路径抛错 → 插件返回 err() → 模型认为失败并重画。
        // 但用户明明收到了那几张图（文件形式）。
        //
        // 所以这里和 sendImage 一样：超时先查证，查到就是已送达。
        if (/Timeout|EventChecker Failed|rich media transfer failed/i.test(msg)) {
          await sleep(2500);
          const v = await this.#verifyImageDelivered(kind, id, attemptAt);
          if (v.found) {
            const ts = Date.now();
            const name = fileName || String(filePath).split('/').pop();
            this.store.appendSelf(chatKey, { text: `[文件:${name}]`, ts });
            this.onSent?.({ chatKey, text: '[文件]', messageId: v.messageId ?? null });
            return { file_id: null, message_id: v.messageId ?? null, receiptMissing: true, verified: true };
          }
        }
        throw e;
      }
    });
  }

  /**
   * 发图/发文件超时后，向 QQ 查证「到底送到了没有」。
   *
   * 🔴 为什么降级前必须先查证（2026-10-27 用户反馈修正）
   *
   * 之前直接"超时就降级发文件"，结果用户收到的是**文件**而不是图片，
   * 体验很差（QQ 里显示「3 个文件待下载」）。
   *
   * 但实际上 NapCat 的 Timeout 是「等确认信号超时」——
   * 图**往往已经送达了**，只是回执没回来。此时再降级发文件，
   * 用户会同时看到一张图和一个文件，或者只有文件（更糟）。
   *
   * 所以顺序必须是：
   *   图片超时 → 等 2.5 秒 → 查 QQ 消息记录
   *     ├─ 查到了 → 图已送达，返回正常结果，**不降级**
   *     └─ 没查到 → 才是真失败，此时降级发文件
   *
   * 判据三条（缺一不可）：
   *   ① 发送者是机器人自己
   *   ② 时间在本次发送之后（留 30 秒窗口容忍时钟差）
   *   ③ 消息里含 image 段
   */
  async #verifyImageDelivered(kind, id, sinceMs) {
    try {
      // ⚠️ onebot.call() 返回的**已经是 body.data**，不要再 .data 一次
      //    （2026-10-27 踩坑：多取一层导致 myId 恒为 0，查证永远返回 false，
      //      于是假性超时被判成真失败，模型以为没发出去反复重画）
      const me = await this.onebot.call('get_login_info', {});
      const myId = Number((me || {}).user_id || 0);
      if (!myId) return { found: false };

      const action = kind === 'private' ? 'get_friend_msg_history' : 'get_group_msg_history';
      const params = kind === 'private'
        ? { user_id: Number(id), count: 10 }
        : { group_id: Number(id), count: 10 };
      const r = await this.onebot.call(action, params);
      const msgs = (r || {}).messages || [];
      const lo = Math.floor((sinceMs - 5000) / 1000);

      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (Number((m.sender || {}).user_id) !== myId) continue;
        if (Number(m.time) < lo) continue;
        // 图片和文件都算「送达」—— 降级发文件时必须认 file（2026-10-27）
        if (!(m.message || []).some((s) => s && (s.type === 'image' || s.type === 'file'))) continue;
        return { found: true, messageId: String(m.message_id || '') };
      }
      return { found: false };
    } catch {
      return { found: false };
    }
  }

  /**
   * 发送一张任意图片（独立气泡，URL 或本地路径）。
   *
   * 🔴 图片通道失败自动降级为文件发送（2026-10-27 移到内核）
   *
   * 为什么放在这里而不是某个插件里：
   *   协议端（尤其 NapCat）跑久了图片通道会退化 —— 文字正常、图片 10 秒超时。
   *   实测不止一个插件受影响：image-gen / ad-inject / grail / astrbot-compat
   *   都各自调 sendImage。如果在每个插件里各写一套降级，等于重复四遍，
   *   以后新插件还会漏。
   *
   *   放在 sender 这一层，**所有调用方自动受益**，插件不用改一行。
   *
   * 降级条件：
   *   · 只在「本地路径」时降级 —— URL 形式的图片没法当文件发
   *   · 只在超时/富媒体失败类错误时降级，其它错误照常抛出
   *   · 降级成功则返回 { viaFile: true }，调用方可据此区分
   *
   * 关掉：配置 send.imageFallbackToFile = false
   */
  sendImage(chatKey, imageUrl, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      this.#checkRate(chatKey);
      await sleep(randInt(500, 1200));

      let data;
      const attemptAt = Date.now();   // 查证时用：只认这个时刻之后的消息
      try {
        data = await this.onebot.sendImage(kind, id, imageUrl, {
          replyToMessageId: options.replyToMessageId ?? null,
          atUserId: options.atUserId ?? null
        });
        const ts = Date.now();
        this.store.appendSelf(chatKey, { text: `[图片:${String(imageUrl).split('/').pop().slice(0, 60)}]`, ts });
        this.onSent?.({ chatKey, text: '[图片]', messageId: data?.message_id ?? null });
        return { message_id: data?.message_id ?? null };
      } catch (e) {
        const msg = String(e?.message ?? e);
        const isTimeoutLike = /Timeout|EventChecker Failed/i.test(msg);
        const isHardFail = /rich media transfer failed/i.test(msg);

        // 🔴 第一步：超时先查证，别急着降级（2026-10-27 用户反馈修正）
        //
        // 用户收到的是「3 个文件待下载」而不是图片 —— 因为之前一超时就降级。
        // 但 NapCat 的 Timeout 多数是**假性超时**：图已经送达，只是回执没回来。
        // 所以先等 2.5 秒，查 QQ 消息记录：
        //   查到 → 图到了，直接按成功返回，不降级
        //   查不到 → 才降级
        let delivered = null;
        if (isTimeoutLike && !isHardFail && options.verifyBeforeFallback !== false) {
          await sleep(2500);   // 给 QQ 侧入库留时间
          const v = await this.#verifyImageDelivered(kind, id, attemptAt);
          if (v.found) {
            delivered = v;
          }
        }
        if (delivered) {
          const ts = Date.now();
          this.store.appendSelf(chatKey, { text: `[图片:${String(imageUrl).split('/').pop().slice(0, 60)}]`, ts });
          this.onSent?.({ chatKey, text: '[图片]', messageId: delivered.messageId ?? null });
          return { message_id: delivered.messageId ?? null, receiptMissing: true, verified: true };
        }

        // 第二步：确认没送到，才降级
        const cfgSend = getConfig().send || {};
        const canFallback = options.fallbackToFile !== false
          && cfgSend.imageFallbackToFile !== false
          && !String(imageUrl).startsWith('http')
          && !String(imageUrl).startsWith('base64://')
          && (isTimeoutLike || isHardFail);

        if (!canFallback) throw e;

        // 降级为文件发送
        try {
          const p = String(imageUrl).replace(/^file:\/\//, '');
          const name = String(options.fileName || p.split('/').pop() || 'image.jpg');
          const fd = await this.onebot.sendFile(kind, id, p, name);
          const ts = Date.now();
          this.store.appendSelf(chatKey, { text: `[图片→文件:${name.slice(0, 40)}]`, ts });
          this.onSent?.({ chatKey, text: '[图片(文件形式)]', messageId: fd?.file_id ?? null });
          return { message_id: null, file_id: fd?.file_id ?? null, viaFile: true, originalError: msg.slice(0, 120) };
        } catch (fe) {
          // 降级也失败 → 抛原始错误，别把两条错误搅在一起
          throw e;
        }
      }
    });
  }

  /** 发送一个收藏表情（独立气泡）。 */
  sendSticker(chatKey, sticker, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      this.#checkRate(chatKey);
      await sleep(randInt(600, 1500)); // 发表情前真人式的短暂停顿
      const data = await this.onebot.sendSticker(kind, id, sticker.url, {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null
      });
      const ts = Date.now();
      this.store.appendSelf(chatKey, { text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, ts });
      this.onSent?.({ chatKey, text: `[表情包]`, messageId: data?.message_id ?? null, sticker: sticker.id });
      return { message_id: data?.message_id ?? null };
    });
  }

  /** 拍一拍。发送成功后留档（self 记录），否则下一次运行不知道自己拍过。 */
  poke(chatKey, targetUserId) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      await sleep(randInt(300, 900));
      const data = await this.onebot.sendPoke(kind, id, targetUserId);
      const ts = Date.now();
      const target = kind === 'group' && targetUserId != null ? ` ${targetUserId}` : '对方';
      this.store.appendSelf(chatKey, { text: `[拍一拍] 你拍了拍${target}`, ts });
      this.onSent?.({ chatKey, text: `[拍一拍]${target}`, messageId: null });
      return data;
    });
  }
}
