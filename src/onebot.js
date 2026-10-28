// OneBot v11 客户端：WebSocket 只收事件，HTTP API 负责发送与查询。
// （原版经 @snowluma/sdk 收事件；这里直接实现标准 OneBot v11，去掉 SDK 补丁依赖。）
import WebSocket from 'ws';
import { sanitizeUserText, escapeCqText } from './util.js';

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;

export class OneBotClient {
  constructor({ wsUrl, httpUrl, accessToken, httpToken, onEvent }) {
    this.wsUrl = String(wsUrl || 'ws://127.0.0.1:3001');
    this.httpUrl = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.accessToken = String(accessToken || '');
    // SnowLuma 允许给 WS 与 HTTP 配不同令牌；httpToken 缺省沿用 accessToken
    this.httpToken = String(httpToken || accessToken || '');
    this.onEvent = onEvent || (() => {});
    this.socket = null;
    this.connected = false;
    this.everConnected = false;
    this.lastConnectError = '';
    this.selfInfo = null;      // { user_id, nickname }
    this.#closedByUs = false;
    this.statusListeners = new Set();
  }

  #closedByUs;

  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  #setStatus(connected) {
    this.connected = connected;
    if (connected) this.everConnected = true;
    for (const fn of this.statusListeners) {
      try { fn({ connected, everConnected: this.everConnected, error: this.lastConnectError }); } catch { /* ignore */ }
    }
  }

  async connect() {
    this.#closedByUs = false;
    this.#connectLoop();
  }

  /** 连接配置可能变了（比如从 SnowLuma 配置同步到了新令牌），重连一次。 */
  async reconnect() {
    // 关键：先作废旧 socket，再启新连接。否则旧 socket 的 close 事件稍后到达时
    // 会误以为需要再次重连，造成两个 WebSocket 同时连着 SnowLuma，所有事件收到两份。
    const old = this.socket;
    this.socket = null;
    this.#closedByUs = false;
    try { old?.close(); } catch { /* ignore */ }
    this.#connectLoop();
  }

  #connectLoop() {
    if (this.#closedByUs) return;
    let url = this.wsUrl;
    if (this.accessToken) url += (url.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(this.accessToken)}`;
    let socket;
    try {
      socket = new WebSocket(url, {
        headers: this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}
      });
    } catch (error) {
      this.lastConnectError = String(error?.message ?? error);
      this.#setStatus(false);
      setTimeout(() => this.#connectLoop(), RECONNECT_MIN_MS);
      return;
    }
    this.socket = socket;
    // 每个 socket 的事件处理器都先验证“我还是不是当前 socket”，
    // 旧连接被作废后其迟到事件直接忽略，避免重复重连/状态错乱。
    const isCurrent = (s) => this.socket === s;

    socket.on('open', async () => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = '';
      this.#setStatus(true);
      try {
        this.selfInfo = await this.call('get_login_info');
      } catch (error) {
        console.error('[onebot] 获取登录信息失败:', error?.message ?? error);
      }
    });
    socket.on('message', (data) => {
      if (!isCurrent(socket)) return;
      let event = null;
      try { event = JSON.parse(String(data)); } catch { return; }
      if (!event || typeof event !== 'object') return;
      try { this.onEvent(event); } catch (error) { console.error('[onebot] 事件处理出错:', error); }
    });
    socket.on('close', () => {
      if (!isCurrent(socket)) return; // 旧连接的迟到 close：新连接已在处理
      this.#setStatus(false);
      if (!this.#closedByUs) setTimeout(() => this.#connectLoop(), RECONNECT_MIN_MS);
    });
    socket.on('error', (error) => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = String(error?.message ?? error);
      if (!this.everConnected) {
        // 首连失败退避得久一点，避免刷屏
        this.#setStatus(false);
      }
    });
  }

  close() {
    this.#closedByUs = true;
    const old = this.socket;
    this.socket = null;
    try { old?.close(); } catch { /* ignore */ }
    this.#setStatus(false);
  }

  /** OneBot HTTP API（发送与查询都走这里）。 */
  async call(action, params = {}, timeoutMs = 15000) {
    const res = await fetch(`${this.httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.httpToken ? { authorization: `Bearer ${this.httpToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      const hint = res.status === 426
        ? '（HTTP 426：httpUrl 可能指向了 WebSocket 端口，请检查 snowluma.httpUrl 是否为 OneBot HTTP API 地址）'
        : '';
      throw new Error(`OneBot ${action} HTTP ${res.status}${hint}`);
    }
    const body = await res.json().catch(() => ({}));
    if (body.status !== 'ok' && body.retcode !== 0) {
      throw new Error(`OneBot ${action} 失败: retcode=${body.retcode ?? body.status} ${body.wording ?? ''}`);
    }
    return body.data;
  }

  get selfId() {
    return this.selfInfo?.user_id != null ? String(this.selfInfo.user_id) : '';
  }

  get selfNickname() {
    return this.selfInfo?.nickname ? String(this.selfInfo.nickname) : '';
  }

  /** 发送消息段。返回 OneBot 响应 data（含 message_id）。 */
  async sendSegments(kind, id, segments, { extraGroupId = null } = {}) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    // ── 群临时会话（2026-10-20）──
    // 问题：非好友的群成员，send_private_msg 会报
    //   "发送失败，请先添加对方为好友"（retcode=200, result=16）
    // 解法：带上 group_id 走"群临时会话"，QQ 允许在群内私聊该群成员。
    // ⚠️ 只在调用方明确给了 groupId 时才加，避免影响普通私聊。
    if (kind === 'private' && extraGroupId) {
      params.group_id = Number(extraGroupId);
    }
    return this.call(action, params);
  }

  async sendText(kind, id, text, { replyToMessageId = null, atUserId = null, extraGroupId = null } = {}) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'text', data: { text: escapeCqText(String(text ?? '')) } });
    return this.sendSegments(kind, id, segments, { extraGroupId });
  }

  async sendSticker(kind, id, imageUrl, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 🔴 表情要带这两个字段，否则 QQ 按**普通图片**渲染（2026-10-24 修）。
    //
    //   summary    = '[动画表情]'  消息摘要标记
    //   sub_type   = 1            子类型：表情
    //
    // 依据：plugins/sticker/index.js 的发送路径（走的 sendSegments）就带了这两个
    // 字段，同一个 NapCat 接口，差别只在这里 —— 它发出来是表情样式。
    //
    // ⚠️ 只改 sendSticker。sendImage 保持只传 file，图片仍然是图片。
    segments.push({
      type: 'image',
      data: { file: String(imageUrl), summary: '[动画表情]', sub_type: 1 }
    });
    return this.sendSegments(kind, id, segments);
  }

  /** 发送一张任意公网图片（URL 或本地路径）。**不带表情字段**，渲染成普通图片。 */
  async sendImage(kind, id, imageUrl, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'image', data: { file: String(imageUrl) } });
    return this.sendSegments(kind, id, segments);
  }

  /** 上传文件到群/私聊（NapCat upload_group_file / upload_private_file）。 */
  async sendFile(kind, id, filePath, fileName) {
    const action = kind === 'private' ? 'upload_private_file' : 'upload_group_file';
    const params = kind === 'private'
      ? { user_id: Number(id), file: String(filePath), name: String(fileName || String(filePath).split('/').pop()) }
      : { group_id: Number(id), file: String(filePath), name: String(fileName || String(filePath).split('/').pop()) };
    return this.call(action, params, 60000);
  }

  async sendPoke(kind, id, targetUserId) {
    if (kind === 'private') {
      return this.call('friend_poke', { user_id: Number(id) }).catch(() =>
        this.call('send_poke', { user_id: Number(id) }));
    }
    return this.call('group_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }).catch(() =>
      this.call('send_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }));
  }

  async getMsg(messageId) {
    return this.call('get_msg', { message_id: Number(messageId) });
  }

  async getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: Number(groupId) });
  }

  async getGroupMemberInfo(groupId, userId) {
    return this.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) });
  }
}

// ── 入站事件 → 文本（移植自原版 segmentsToText） ─────────────────────────

export function forwardIdFromData(d) {
  const raw = d?.id ?? d?.res_id ?? d?.forward_id ?? d?.data_id;
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw);
}

/**
 * 把 OneBot 消息段数组转成 AI 可读的纯文本。
 * resolveReply: async (mid) => { sender, text } | null —— 解析引用原文。
 * resolveAtName: async (qq) => string | null —— 把 @ 的 QQ 号解析成群名片。
 */
export async function segmentsToText(segments, { resolveReply = null, resolveAtName = null, includeReply = true } = {}) {
  if (typeof segments === 'string') return sanitizeUserText(segments.trim());
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          // 🔴 @ 文本必须带 QQ 号（2026-10-28 修）
          //
          // 事故：机器人有自己的群名片「鲸界魔王-白光-小鱼」，
          // 但身份块告诉模型"你的名字是小鲸鱼"。别人 @ 它时，
          // 渲染出来是「@鲸界魔王-白光-小鱼」——名字对不上，
          // 模型判定"@ 的不是我"，该回的不回。
          //
          // 带上号后，模型能直接比对：@xxx#3170037984 里那个号就是自己。
          out.push(name ? `@${name}#${d.qq}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': {
        // 带上文件名和大小；file_id 通过 media 单独传给模型（见 mediaHint），避免刷屏
        const fname = String(d.name ?? d.file ?? '未命名');
        const fsize = Number(d.file_size ?? d.size ?? 0);
        const sizeText = fsize ? ` ${Math.max(1, Math.round(fsize / 1024))}KB` : '';
        out.push(`[文件：${fname}${sizeText}]`);
        break;
      }
      case 'reply': {
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              // 🔴 引用必须带 QQ 号（2026-10-28 修）
              //
              // 事故：机器人把「引用自己」认成「别人在引用别人」，该接的话不接。
              // 根因：这里只取了 info.sender（群名片/昵称），
              // **把 resolveReply 已经拿到的 senderId 丢掉了**。
              // 于是引用文本里只有名字，名字又可能和人设名对不上 ——
              // 模型没法按号核对，只能猜。
              //
              // 现在统一写成「名字#QQ号」，与消息行、@ 的格式一致，
              // 模型只要比对数字就能确定是谁。
              const rs = String(info.sender || '').trim();
              const ru = String(info.senderId || '').trim();
              const rwho = rs && ru && rs !== ru ? `${rs}#${ru}` : (rs || ru || '');

              const parts = [];
              if (rwho) parts.push(rwho);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch { /* 解析失败降级 */ }
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': out.push('[卡片消息]'); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return sanitizeUserText(out.join('').trim());
}

/** 从消息段提取媒体定位信息（不下载）。 */
export function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({ kind: 'image', file: String(d.file ?? ''), url: String(d.url ?? ''), summary: String(d.summary ?? '') });
    } else if (seg.type === 'face') {
      media.push({ kind: 'face', faceId: String(d.id ?? '') });
    } else if (seg.type === 'file') {
      // 文件消息：file_id 是取回文件的唯一凭据（NapCat get_file 接口要用它）
      media.push({
        kind: 'file',
        fileId: String(d.file_id ?? d.id ?? ''),
        name: String(d.name ?? d.file ?? ''),
        size: Number(d.file_size ?? d.size ?? 0) || 0,
        url: String(d.url ?? '')
      });
    } else if (seg.type === 'video') {
      media.push({ kind: 'video', file: String(d.file ?? ''), url: String(d.url ?? '') });
    } else if (seg.type === 'record') {
      // 语音（2026-10-21 加）：此前只把语音转成 "[语音]" 文本，
      // **从未把媒体信息存进 media** —— 导致 voice 插件拿不到 file_id、
      // 永远无法识别群友的语音。这里补齐。
      // file_id 是 NapCat get_record 的取回凭据；file 是内部路径（兜底）。
      media.push({
        kind: 'record',
        fileId: String(d.file_id ?? d.id ?? ''),
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        durationSec: Number(d.duration ?? 0) || 0
      });
    }
  }
  return media;
}
