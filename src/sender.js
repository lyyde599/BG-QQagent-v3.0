// 发送队列：所有对 QQ 的出站消息都经过这里。
// - 每会话串行（sendChain），真人化间隔（随机区间 + 按字数附加）
// - 分钟/小时限频（超限直接拒绝，工具会把错误告诉模型）
// - Markdown → 纯文本、QQ 硬长度切分、CQ 转义
// - 发出的每一条记进 ChatStore（self=true，供下一次运行当"自己的发言"）
import { getConfig } from './config.js';
import { sleep, randInt, createSendChain, escapeCqText, formatClockTime } from './util.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';

export class SendQueue {
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
        const data = await this.onebot.sendText(kind, id, text, {
          replyToMessageId: i === 0 ? options.replyToMessageId : null, // 引用挂在第一条上：回的就是那条
          atUserId: i === 0 ? options.atUserId : null,
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
      const data = await this.onebot.sendFile(kind, id, filePath, fileName);
      const ts = Date.now();
      this.store.appendSelf(chatKey, { text: `[文件:${fileName || String(filePath).split('/').pop()}]`, ts });
      this.onSent?.({ chatKey, text: '[文件]', messageId: data?.file_id ?? null });
      return data;
    });
  }

  /** 发送一张任意图片（独立气泡，URL 或本地路径）。 */
  sendImage(chatKey, imageUrl, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      this.#checkRate(chatKey);
      await sleep(randInt(500, 1200));
      const data = await this.onebot.sendImage(kind, id, imageUrl, {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null
      });
      const ts = Date.now();
      this.store.appendSelf(chatKey, { text: `[图片:${String(imageUrl).split('/').pop().slice(0, 60)}]`, ts });
      this.onSent?.({ chatKey, text: '[图片]', messageId: data?.message_id ?? null });
      return { message_id: data?.message_id ?? null };
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
