// 原生工具集（OpenAI function calling 格式）。
// 与原版 MCP 工具的关键区别：每个工具自动绑定本次运行对应的会话（chatKey），
// 不再需要 key/token 参数 —— 模型物理上无法把消息发到别的群/私聊，安全性反而更强。
//
// 工具命名去掉了 qq_ 前缀（更短，省 token）。
import path from 'node:path';
import { getConfig, updateConfig, ROOT } from './config.js';
import { listSkills, getSkillBody } from './skill.js';
import { normalizeMessageList, unquoteJsonString } from './util.js';
import { formatStickerList } from './stickers.js';
import { validateImageUrl, safeFetchBinary } from './safe-fetch.js';

// 本工具允许读发的本地目录：项目内的 workspace/ 与 dsh-work/，外加系统临时目录。
// 不写死部署路径（历史上是 /root/qq-agent-v2/...），换机器/换目录自动跟着走。
const WORKSPACE_DIR = path.join(ROOT, 'workspace');
const DSH_WORK_DIR = path.join(ROOT, 'dsh-work');
const TEMP_DIRS = ['/tmp', ...(process.env.TMPDIR ? [process.env.TMPDIR] : [])];
// 工作目录（2026-10-28）：DSH 产物现在落这里，send_file 必须认
const YUYU_DIR = process.env.QQ_AGENT_YUYU_DIR || '/home/lyy/鱼鱼的工作目录';
const LOCAL_PATH_PREFIXES = [WORKSPACE_DIR, DSH_WORK_DIR, ...TEMP_DIRS];

// 下载图片并转成 dataURL（供视觉模型读图）。
//
// ⚠️ 为什么要重试（2026-09-15 事故）：用户在私聊发图后，机器人回了"图片还没同步出来"。
//    复盘发现：消息入库到触发运行只隔 **2.9 秒**，此时 QQ 的 CDN（multimedia.nt.qq.com.cn）
//    往往还没把图片准备好，首次 GET 会失败；而当时**没有任何重试**，一次失败就永久放弃，
//    于是模型只能如实说"看不到图"。同一 URL 几分钟后手工再拉是成功的 —— 典型的瞬时失败。
//    现在改为指数退避重试 3 次（0.6s / 1.5s / 3s），足以覆盖 CDN 就绪延迟。
async function downloadImageAsDataUrl(url, timeoutMs = 30000) {
  const safeUrl = await validateImageUrl(url);
  const delays = [600, 1500, 3000];
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const { buffer, contentType } = await safeFetchBinary(safeUrl);
      if (!buffer || !buffer.length) throw new Error("图片内容为空");
      const mime = detectMime(buffer) || String(contentType || "image/jpeg").split(";")[0];
      return `data:${mime};base64,${buffer.toString("base64")}`;
    } catch (e) {
      lastError = e;
      if (attempt < delays.length) await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastError ?? new Error("图片下载失败");
}

function detectMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 8) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

// 找不到消息 id 时，把当前会话真实可见的 id 告诉模型，避免它继续瞎猜。
function midHint(ctx) {
  const mids = ctx.store.recent(ctx.chatKey, { limit: 60 })
    .map((m) => m.mid)
    .filter((v) => v !== null && v !== undefined && String(v) !== '');
  const uniq = [...new Set(mids.map(String))].slice(-8);
  return uniq.length
    ? `消息 id 只能用聊天记录里每条消息前的 #数字（最近可见：${uniq.join(' ')}），不要自己编`
    : '聊天记录里还没有带 #id 的消息';
}

// 需要数字 QQ 号但模型传了名字时，把当前会话真实可见的成员列出来，让它选一个。
function memberHint(ctx) {
  const members = ctx.store.activeMembers(ctx.chatKey, 8);
  if (!members.length) return '当前没有可用的成员列表，请先等有群友发言后再试';
  const lines = members.map((m) => `- ${m.name}：${m.userId}`).join('\n');
  return `请从当前会话成员里选一个 QQ 号填进去：\n${lines}`;
}

function imageParts(text, dataUrls) {
  const parts = [{ type: 'text', text }];
  for (const url of dataUrls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/**
 * 构建绑定一次运行的工具集。
 * ctx: {
 *   chatKey, kind, chatId, selfId, selfNickname, botName,
 *   onebot, store, memory, stickers, sender, session,
 *   emit  (事件上报给 UI/日志)
 * }
 */
/**
 * 配置脱敏：把密钥类字段换成 "长度 N"。
 *
 * 用途：主人通过对话查看配置时，模型能看到"有没有配、多长"，
 * 但**看不到原文** —— 与密钥零披露纪律一致（记忆 00 第二节第 4 条）。
 * 即使是主人，也不该让 API Key 经过模型上下文。
 */
function redactSecrets(v, depth = 0) {
  if (depth > 8 || v == null) return v;
  if (Array.isArray(v)) return v.map((x) => redactSecrets(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (/apikey|apiKeyFrom|accessToken|secret|password|^token$|keys$/i.test(k)
          && typeof val === 'string' && val) {
        out[k] = `[已隐藏，长度 ${val.length}]`;
      } else if (/anysearchKeys$/i.test(k) && Array.isArray(val)) {
        out[k] = val.map((s) => `[已隐藏，长度 ${String(s).length}]`);
      } else {
        out[k] = redactSecrets(val, depth + 1);
      }
    }
    return out;
  }
  return v;
}

export function buildToolDefs() {
  return [
    {
      name: 'send_message',
      description: '发送消息到当前聊天（本工具只能发到本次会话对应的群/私聊）。messages 传字符串=发一条；传字符串数组=分多条发送（推荐，更像真人）。只有需要明确"我回的是哪条"时才传 replyToMessageId 引用；需要点名某人才传 atUserId。不要在字符串内部用空格分句。',
      parameters: {
        type: 'object',
        properties: {
          messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          replyToMessageId: { type: ['integer', 'string'], description: '要引用/回复的消息 id（聊天记录里每条消息前的 #数字，可选）' },
          atUserId: { type: ['integer', 'string'], description: '要 @ 的群成员 QQ 号（可选，与引用二选一，不要滥用）' }
        },
        required: ['messages']
      },
      async execute(ctx, args) {
        try {
          const messages = normalizeMessageList(args.messages);
          if (!messages.length) return err('消息内容为空');
          const result = await ctx.sender.sendTextBatch(ctx.chatKey, messages, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, at: s.at })));
          ctx.emit('session-update', ctx.session.id);
          const note = ['已发送。不要输出"已发送"类汇报，继续思考下一步或直接结束。'];
          if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}——成功的不需要重发，失败的请稍后再试或减少条数）`);
          return ok({ sent: result.sent.length, messageIds: result.sent.map((s) => s.messageId), note: note.join('') });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_sticker',
      description: '发送一个 QQ 收藏表情（一条消息只能一张表情，不能附带文字；想说的话先用 send_message 单独发）。stickerId 从 list_stickers 获取。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string', description: '表情 id' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const sticker = await ctx.stickers.find(unquoteJsonString(args.stickerId));
          if (!sticker) return err(`找不到表情 ${args.stickerId}，请先用 list_stickers 获取有效 id`);
          if (!sticker.url) return err(`表情 ${sticker.id} 没有可发送的图片地址`);
          try {
            await validateImageUrl(sticker.url); // 只允许公网 http(s)，防止本地库被污染后诱导 OneBot 抓内网
          } catch (error) {
            return err(`表情 ${sticker.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
          }
          const result = await ctx.sender.sendSticker(ctx.chatKey, sticker, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          ctx.stickers.markUsed(sticker.id, String(ctx.session.triggerText || '').slice(0, 100));
          ctx.session.sent.push({ type: 'sticker', text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, messageId: result?.message_id ?? null, note: '表情已发送。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_image',
      description: '发送一张图片到当前聊天（URL 或本地 workspace/ 下的路径）。图片来自网页搜索/群友要求/本地生成时用。发送前会校验公网地址安全（拒绝内网）。',
      parameters: {
        type: 'object',
        properties: {
          imageUrl: { type: 'string', description: '图片地址：公网 http(s) URL 或本地文件绝对路径（限 workspace/ 或 dsh-work/ 或 /tmp）' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        },
        required: ['imageUrl']
      },
      async execute(ctx, args) {
        try {
          const raw = String(args.imageUrl ?? '').trim();
          if (!raw) return err('imageUrl 不能为空');
          // 本地路径检查（workspace 内）
          const isLocal = raw.startsWith('/');
          if (isLocal) {
            const allowedPrefixes = LOCAL_PATH_PREFIXES;
            const okPath = allowedPrefixes.some((p) => raw.startsWith(p)) && !raw.includes('..');
            if (!okPath) return err('本地图片路径不在允许范围（仅 workspace 或 /tmp）');
            try {
              const fs2 = await import('node:fs');
              if (!fs2.existsSync(raw)) return err(`图片文件不存在: ${raw}`);
            } catch (e) { return err('无法访问本地文件: ' + (e?.message || e)); }
          } else {
            try {
              await validateImageUrl(raw); // 公网 http(s) 校验（拒绝内网）
            } catch (error) {
              return err(`图片地址不合法，已拒绝发送：${error?.message ?? error}`);
            }
          }
          const result = await ctx.sender.sendImage(ctx.chatKey, raw, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          ctx.session.sent.push({ type: 'image', text: `[图片:${String(raw).split('/').pop().slice(0, 50)}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, messageId: result?.message_id ?? null, note: '图片已发送。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    
    
    {
      name: 'receive_file',
      description: '把主人发来的 QQ 文件（[文件：xxx] 占位符的消息）下载到工作目录，得到本地路径后就可以读取/解析/转交 DSH。id 用聊天记录里每条消息前的 #数字（没有 #数字时先用 get_recent_messages 查）。传了 messageId 会列出该消息里所有文件。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' },
          fileIndex: { type: 'number', description: '同一条消息里有多个文件时指定第几个（从 0 开始），默认 0' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const files = (entry.media || []).filter((m) => m.kind === 'file');
          if (!files.length) return err('这条消息里没有文件（可能只有图片或文字）');
          const idx = Math.max(0, Math.min(Number(args.fileIndex) || 0, files.length - 1));
          const f = files[idx];
          if (!f.fileId) return err('这个文件缺少 file_id，无法下载（可能是旧消息或 NapCat 未提供）');

          // 下载目录：工作区固定子目录，方便交给 DSH
          const fsmod = await import('node:fs');
          const pathmod = await import('node:path');
          const cfgmod = await import('./config.js');
          const inbox = pathmod.join(cfgmod.DATA_DIR, 'inbox');
          fsmod.mkdirSync(inbox, { recursive: true });
          const safeName = String(f.name || 'file').replace(/[\/:*?"<>|]/g, '_');
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const dest = pathmod.join(inbox, `${stamp}_${safeName}`);

          // NapCat get_file：拿下载地址，再取回文件
          const info = await ctx.onebot.call('get_file', { file_id: f.fileId }, 30000).catch((e) => {
            throw new Error('get_file 失败：' + (e?.message || e));
          });
          const urls = [info?.url, info?.file, info?.data?.url, info?.data?.file].filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
          if (!urls.length) return err('NapCat 没有返回可下载地址：' + JSON.stringify(info).slice(0, 200));
          const res = await fetch(urls[0], { signal: AbortSignal.timeout(120000) });
          if (!res.ok) return err('下载失败 HTTP ' + res.status);
          const buf = Buffer.from(await res.arrayBuffer());
          fsmod.writeFileSync(dest, buf);

          return ok({
            saved: dest,
            name: f.name || safeName,
            size: buf.length,
            note: '文件已下载到本地。可以直接读取内容，或用 dsh_task 让 DSH 处理（把上面这个 saved 路径写进任务描述）。'
          });
        } catch (error) {
          return err(`接收文件失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'send_file',
      masterOnly: true,
      description: '【主人专属】把本地文件作为文件消息发送到当前聊天。允许项目内产物、工作目录（鱼鱼的工作目录）、workspace、/tmp。主人任务完成后要文件时用。',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '本地文件绝对路径（限项目目录 / 鱼鱼的工作目录 / workspace / /tmp）' },
          fileName: { type: 'string', description: '可选：发送时显示的文件名' }
        },
        required: ['filePath']
      },
      async execute(ctx, args) {
        try {
          const raw = String(args.filePath ?? '').trim();
          if (!raw) return err('filePath 不能为空');
          // 🔴 工作目录也要认（2026-10-28）
          // 事故：DSH 产出的报告落在《鱼鱼的工作目录》，send_file 报"不在允许范围"，
          // 她只好改用 send_local_file。两个工具的范围应当一致。
          const allowedPrefixes = [DSH_WORK_DIR, WORKSPACE_DIR, YUYU_DIR, ROOT, ...TEMP_DIRS];
          const okPath = allowedPrefixes.some((p) => raw.startsWith(p)) && !raw.includes('..');
          if (!okPath) return err(`文件路径不在允许范围（仅 ${[DSH_WORK_DIR, WORKSPACE_DIR, YUYU_DIR].join(' / ')} / tmp）`);
          const fs2 = await import('node:fs');
          if (!fs2.existsSync(raw)) return err(`文件不存在: ${raw}`);
          const stat = fs2.statSync(raw);
          if (!stat.isFile()) return err('目标不是文件');
          if (stat.size > 50 * 1024 * 1024) return err('文件超过 50MB 上限');
          const result = await ctx.sender.sendFile(ctx.chatKey, raw, String(args.fileName || '').trim() || undefined);
          ctx.session.sent.push({ type: 'file', text: `[文件:${String(args.fileName || raw.split('/').pop())}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, fileId: result?.file_id ?? null, note: '文件已发送。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    
    
    
    
    {
      name: 'send_poke',
      description: '拍一拍（群聊传 targetUserId；私聊默认拍对方）。targetUserId 必须是数字 QQ 号：不知道对方 QQ 号时，先调 get_active_members 或 get_recent_messages 查到再拍，绝对不要传名字、昵称或"未知"。适合用"戳一下"代替一句废话、回应别人的拍一拍，或偶尔逗一下正在聊的人。别频繁。',
      parameters: {
        type: 'object',
        properties: { targetUserId: { type: ['integer', 'string'], description: '要拍的群友 QQ 号（数字，群聊必填；不知道就先查 get_active_members）' } }
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind === 'group' && (args.targetUserId === undefined || args.targetUserId === null || String(args.targetUserId).trim() === '')) {
            return err(`群聊拍一拍必须传 targetUserId（数字 QQ 号）。${memberHint(ctx)}`);
          }
          let target = args.targetUserId;
          if (target !== undefined && target !== null && String(target).trim() !== '') {
            target = Number(target);
            if (!Number.isInteger(target) || target <= 0) {
              return err(`targetUserId 必须是正整数的 QQ 号（收到：${JSON.stringify(args.targetUserId)}）。${memberHint(ctx)}`);
            }
            await ctx.sender.poke(ctx.chatKey, target);
          } else {
            await ctx.sender.poke(ctx.chatKey, null);
          }
          return ok({ poked: true });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    
    {
      name: 'get_current_time',
      masterOnly: false,
      description: '查现在几点。有人问"现在几点/几号/今天星期几"时直接调它，**不要外派给 dshc**（那是几秒能答的事，派出去反而慢）。',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() {
        const now = new Date();
        // 统一北京时间（铁律 0.5）
        const fmt = (opt) => now.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', ...opt });
        return ok({
          time: fmt({ hour: '2-digit', minute: '2-digit' }),
          date: fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-'),
          weekday: new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: 'Asia/Shanghai' }).format(now),
          full: fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'long' }),
          timezone: 'Asia/Shanghai (UTC+8)',
          note: '这是北京时间。直接把这个时间告诉对方即可，不需要再做任何查询，也不要外派。'
        });
      }
    },
    {
      name: 'get_recent_messages',
      description: '往前翻当前会话的更多历史消息（提示词里只带了最近一段；需要更早的上下文时用）。返回带 messageId（就是聊天记录里的 #数字），可用于引用或看图。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '最多返回条数，默认 30，最大 100' },
          offset: { type: 'integer', description: '跳过最近 N 条，用于翻更早的消息' }
        }
      },
      async execute(ctx, args) {
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
        const offset = Math.max(0, Number(args.offset) || 0);
        const messages = ctx.store.recent(ctx.chatKey, { limit, offset: offset + (ctx.session.pastStateCount || 0) });
        return ok({
          count: messages.length,
          messages: messages.map((m) => ({
            messageId: m.mid ?? undefined,
            time: new Date(m.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            sender: m.self ? '我' : m.senderName,
            text: m.text
          }))
        });
      }
    },
    {
      name: 'get_active_members',
      description: '查看当前会话最近活跃的成员（QQ 号、名字、最近发言时间、发言数），用于 @ 或拍一拍时找人。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '默认 10，最大 20' } }
      },
      async execute(ctx, args) {
        const members = ctx.store.activeMembers(ctx.chatKey, Math.min(20, Math.max(1, Number(args.limit) || 10)));
        return ok({
          members: members.map((m) => ({
            userId: m.userId,
            name: m.name,
            lastSeen: new Date(m.lastTs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            recentCount: m.count
          }))
        });
      }
    },
    {
      name: 'get_message_detail',
      description: '按 QQ 消息 id 查看单条消息详情（完整文本、发送者、时间）。id 用聊天记录里每条消息前的 #数字，不要自己编。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        return ok({
          messageId: entry.mid,
          time: new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
          sender: entry.self ? '我' : entry.senderName,
          senderId: entry.senderId,
          text: entry.text,
          reply: entry.reply
        });
      }
    },
    
    
    
    
    
    {
      name: 'finish',
      description: '明确结束本次处理（表示你看完了、决定了下一步）。看完不打算说话时调用它（summary 写一句给自己看的理由）；说完话想收尾时也可以调用。不调用也可以——直接结束文本输出同样代表结束。',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: '一句话说明你这次的决定（只记录给管理端看，不会发送）' } },
        required: ['summary']
      },
      async execute(ctx, args) {
        ctx.session.finishReason = String(args.summary ?? '').slice(0, 300);
        return ok({ finished: true });
      }
    },

    // ── Skill：按需加载知识（2026-10-21）────────────────────
    //
    // 与工具的区别：工具**做事**，skill 让模型**知道怎么做**。
    // 提示词里只留索引（id + 一句话），正文靠这个工具取 —— 省 token。
    {
      name: 'load_skill',
      description: '读取一个技能（skill）的完整内容。提示词里的【技能库】列出了所有可用 skill 及其 id。需要具体规范/套路/领域知识时先读，不要凭印象猜。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '技能 id（见【技能库】列表）' }
        },
        required: ['id']
      },
      async execute(ctx, args) {
        try {
          const id = String(args.id ?? '').trim();
          if (!id) return err('id 不能为空。可用：' + listSkills().map((s) => s.id).join(' / '));
          const s = getSkillBody(id);
          if (!s) {
            return err(`没有这个 skill：${id}。可用：` + listSkills().map((x) => x.id).join(' / '));
          }
          // 截断保护：再长的规范也不该一次灌爆上下文
          const MAX = 20000;
          const content = s.content.length > MAX
            ? s.content.slice(0, MAX) + `\n\n…（内容过长，已截断到 ${MAX} 字，完整内容见 ${s.file || '对应文件'}）`
            : s.content;
          return ok({ id: s.id, name: s.name, source: s.source || 'builtin', content });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    // ── 主人专属控制工具（2026-10-21）────────────────────────
    //
    // 用户要求：主人的要求一律答应，且**可以通过对话让 Agent 改内核与插件的任意参数**。
    //
    // 三个工具各管一段，边界清晰：
    //   • master_list_capabilities  看：有什么插件、什么工具、可调哪些配置项
    //   • master_get_config         读：任意配置路径的值
    //   • master_set_config         写：任意配置路径（内核 + 插件都行）
    //
    // 🔴 安全边界（写在工具内部，不靠模型自觉）：
    //   1. 三个都是 masterOnly —— 群友触发时模型根本看不到
    //   2. 禁写字段黑名单：allow / deny（白名单）、persona.masterQQ（主人身份）、
    //      api.apiKey 等凭据 —— 这些改了会把人锁在外面，或让群友自封主人
    //   3. 路径白名单校验：必须落在 config 里真实存在的键上，防止凭空造字段
    {
      name: 'master_list_capabilities',
      masterOnly: true,
      description: '【主人专属】列出当前所有插件、每个插件提供的工具、以及可调整的配置项。想"看看它能做什么"或"某个功能对应哪个插件"时先调它。',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(ctx) {
        try {
          const host = ctx.pluginHost;
          if (!host) return err('插件宿主未就绪');
          const cfg = getConfig();
          const rows = [];
          for (const [id, rec] of host.records) {
            const m = rec.manifest || {};
            const tools = (host.allToolDefs?.() || [])
              .filter((d) => d.pluginId === id)
              .map((d) => d.name);
            rows.push({
              plugin: id,
              name: m.name || id,
              status: rec.status,
              enabled: cfg.plugins?.[id]?.enabled === true,
              tools,
              configKeys: Object.keys(cfg.plugins?.[id] || {}),
              hasPanel: !!m.ui
            });
          }
          return ok({
            plugins: rows,
            kernelConfigKeys: Object.keys(cfg).filter((k) => k !== 'plugins'),
            note: '改配置用 master_set_config(path, value)；读用 master_get_config(path)。'
              + ' 例如 path=plugins.voice.config.enabled，或 path=persona.participation。'
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'master_get_config',
      masterOnly: true,
      description: '【主人专属】读取配置。path 用点号分隔，如 persona.botName / plugins.graal.enabled / api.model。不传 path 返回全部（脱敏：密钥只显示长度）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '配置路径，点号分隔；省略=返回全部' }
        },
        required: []
      },
      async execute(ctx, args) {
        try {
          const cfg = getConfig();
          const pathStr = String(args.path ?? '').trim();
          const pick = (obj, p) => p.split('.').filter(Boolean)
            .reduce((o, k) => (o == null ? undefined : o[k]), obj);
          if (!pathStr) {
            return ok({ config: redactSecrets(cfg), note: '密钥已脱敏，只显示长度。' });
          }
          const v = pick(cfg, pathStr);
          if (v === undefined) {
            // 🔴 报错要可操作（2026-10-28）
            //
            // 事故：她想读 dsh 的配置，猜了个 `plugins.dsh` → 报"没有这一项"，
            // 她只好放弃。真相是那个插件的 id 叫 self-capability，
            // 配置在 plugins['self-capability'] 下。
            //
            // 报错时把**同级可用的键**列出来，她就能自己找对。
            const segs = String(pathStr).split('.');
            const parentPath = segs.slice(0, -1).join('.');
            const parent = parentPath ? pick(cfg, parentPath) : cfg;
            let hint = '';
            if (parent && typeof parent === 'object') {
              const keys = Object.keys(parent).slice(0, 40);
              if (keys.length) {
                hint = `。${parentPath || '顶层'} 下可用的键：${keys.join(', ')}`;
              }
            }
            return err(`配置里没有这一项：${pathStr}${hint}`);
          }
          return ok({ path: pathStr, value: redactSecrets(v) });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'master_set_config',
      masterOnly: true,
      description: '【主人专属】修改配置。path 点号分隔（如 plugins.study.enabled / persona.participation / api.temperature）。value 传新值（字符串会按原类型尝试解析 JSON）。支持内核配置与任意插件配置。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '配置路径，点号分隔' },
          value: { description: '新值（数字/布尔/字符串/对象均可）' },
          reason: { type: 'string', description: '可选：为什么改（会写进日志，便于回溯）' }
        },
        required: ['path', 'value']
      },
      async execute(ctx, args) {
        try {
          const pathStr = String(args.path ?? '').trim();
          if (!pathStr) return err('path 不能为空');

          // 🔴 禁写字段：这些改了会出安全问题或把人锁在外面
          const FORBIDDEN = [
            /^allow(\.|$)/, /^deny(\.|$)/,           // 白名单：改错=陌生人可操控机器人
            /^persona\.masterQQ$/,                    // 主人身份：改=群友可自封主人
            /^server\.token$/,                        // 控制台令牌
            /apiKey|apiKeyFrom|accessToken|token$/i   // 任何凭据
          ];
          const hit = FORBIDDEN.find((re) => re.test(pathStr));
          if (hit) {
            return err(`拒绝修改 ${pathStr}：这是受保护字段。`
              + '（白名单、主人身份、密钥只能由主人在面板里改，不允许模型代改）');
          }

          // 只允许"已存在"的路径或 plugins.<id>.* —— 防止凭空造键
          const cfg = getConfig();
          const segs = pathStr.split('.').filter(Boolean);
          const exists = segs.reduce((o, k) => (o == null ? undefined : o[k]), cfg) !== undefined;
          const isPluginPath = segs[0] === 'plugins' && segs.length >= 2;
          if (!exists && !isPluginPath) {
            return err(`配置里没有 ${pathStr}，不能凭空新增。`
              + '先用 master_get_config 确认现有键名。');
          }

          // 值解析：传进来是字符串时尝试 JSON 解析（"true"→true / "0.5"→0.5）
          let val = args.value;
          if (typeof val === 'string') {
            const s = val.trim();
            if (s === 'true') val = true;
            else if (s === 'false') val = false;
            else if (s === 'null') val = null;
            else if (s !== '' && !Number.isNaN(Number(s))) val = Number(s);
            else if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
              try { val = JSON.parse(s); } catch { /* 保持字符串 */ }
            }
          }

          // 构造增量补丁并写入
          const patch = {};
          let cur = patch;
          for (let i = 0; i < segs.length - 1; i++) {
            cur[segs[i]] = {};
            cur = cur[segs[i]];
          }
          cur[segs[segs.length - 1]] = val;
          updateConfig(patch);

          return ok({
            ok: true,
            path: pathStr,
            value: redactSecrets(val),
            reason: String(args.reason || ''),
            note: '已写入。绝大多数配置下一轮运行即生效；插件级开关可能需要重载插件。'
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

  ];
}

/** 转成 OpenAI tools 参数格式。 */
export function toOpenAiTools(defs) {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters
    }
  }));
}

/** 找到并执行一个工具调用。返回 { content, isError }，content 为 string 或 parts 数组。 */
export async function executeTool(defs, ctx, name, argsJson) {
  const def = defs.find((d) => d.name === name);
  if (!def) return { content: `错误：未知工具 ${name}`, isError: true };
  let args = {};
  const raw = argsJson ?? '{}';
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { content: `错误：工具 ${name} 的参数不是合法 JSON：${String(raw).slice(0, 200)}`, isError: true };
  }
  try {
    const raw = await def.execute(ctx, args ?? {});

    // 🔴 统一兜底：插件直接 return 普通对象时补成 { content }
    //    （2026-10-28 修）
    //
    // 事故：heybox_ops_status / heybox_feed / heybox_ops_draft 全部返回 undefined，
    // 模型据此断言"这些工具都用不了"，转而抓网页、编解释。
    //
    // 根因：工具契约要求返回 `{ content, isError? }`，
    //      但内核的 ok() 包装不是强制的 —— 插件写 `return { ok:true, ... }`
    //      也完全不报错。执行器读 `result.content` 得到 undefined，
    //      String(undefined) 就是字面量 "undefined"，模型看到的就是它。
    //
    //      受影响的插件：heybox-ops / auto-review / errata / rl-growth
    //      （都是直接 return 对象，没有走 ok()）。
    //
    // 与其逐个改插件，不如在这里统一兜住 —— 插件怎么写都不会丢结果。
    if (raw == null) {
      return { content: '', isError: false };
    }
    if (typeof raw === 'string') {
      return { content: raw, isError: false };
    }
    if (typeof raw === 'object' && raw.content !== undefined) {
      return raw;                       // 已经合规
    }
    if (Array.isArray(raw)) {
      return { content: raw, isError: false };
    }
    if (typeof raw === 'object') {
      // 普通对象 → 序列化成 JSON 文本（模型能读）
      let text;
      try {
        text = JSON.stringify(raw, null, 1);
      } catch {
        text = String(raw);
      }
      return { content: text, isError: raw.ok === false || raw.isError === true };
    }
    // 数字/布尔等
    return { content: String(raw), isError: false };
  } catch (error) {
    return { content: `错误：${error?.message ?? error}`, isError: true };
  }
}




// ── 知识库工具（教学身份用；从 qq-agent-tutor 移植并修复）────────────────
// 说明：本数组在 buildToolDefs 的 return 中被展开。因 const 提升限制，
// 定义位置需在 buildToolDefs 之后（函数调用时已初始化）。
const KB_TOOLS = [];  // 2026-10-21 已迁往 plugins/study/;

/** 知识库工具名集合（供按身份过滤用）。 */
export const KB_TOOL_NAMES = new Set(KB_TOOLS.map((t) => t.name));
