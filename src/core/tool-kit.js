// ── 插件内核 · 工具辅助函数 ────────────────────────────────────────────
//
// 从 tools.js 抽出来给插件共用。为什么单独一个文件：
//   内核工具要插件化后，每个插件都要写 execute(ctx, args)，
//   而 ok/err/midHint/memberHint/图片下载 这些是**所有工具都需要的公共件**。
//   留在 tools.js 里会让插件反向依赖内核工具表（循环依赖）。
//
// 这些函数是「模型可读的返回值格式」的唯一定义处 —— 改这里会同时影响
// 内核工具与所有插件工具的表现，务必保持输出契约稳定（content + isError）。
import path from 'node:path';
import { ROOT } from '../config.js';
import { validateImageUrl, safeFetchBinary } from '../safe-fetch.js';

/** 工具成功返回：对象会被 JSON 化，字符串原样 */
export function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

/** 工具失败返回：统一 `错误：` 前缀，模型据此判断该重试还是换路 */
export function err(message) {
  return { content: `错误：${message}`, isError: true };
}

/** 消息 id 提示：找不到时把当前会话真实可见的 id 列出来，避免模型瞎猜 */
export function midHint(ctx) {
  const mids = ctx.store.recent(ctx.chatKey, { limit: 60 })
    .map((m) => m.mid)
    .filter((v) => v !== null && v !== undefined && String(v) !== '');
  const uniq = [...new Set(mids.map(String))].slice(-8);
  return uniq.length
    ? `消息 id 只能用聊天记录里每条消息前的 #数字（最近可见：${uniq.join(' ')}），不要自己编`
    : '聊天记录里还没有带 #id 的消息';
}

/** 需要 QQ 号但模型传了名字时，列出当前会话真实可见的成员 */
export function memberHint(ctx) {
  const members = ctx.store.activeMembers(ctx.chatKey, 8);
  if (!members.length) return '当前没有可用的成员列表，请先等有群友发言后再试';
  const lines = members.map((m) => `- ${m.name}：${m.userId}`).join('\n');
  return `请从当前会话成员里选一个 QQ 号填进去：\n${lines}`;
}

/** 图片二进制嗅探（不信任 Content-Type） */
export function detectMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 8) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * 下载图片并转 dataURL（供视觉模型读图）。
 *
 * ⚠️ 为什么必须重试（2026-09-15 事故）：用户私聊发图后，机器人回了"图片还没同步出来"。
 *    消息入库到触发运行只隔 2.9 秒，此时 QQ 的 CDN 往往还没准备好，首次 GET 会失败；
 *    当时没有任何重试，一次失败就永久放弃，模型只能如实说"看不到图"。
 *    同一 URL 几分钟后手工再拉是成功的 —— 典型瞬时失败。指数退避 3 次足以覆盖。
 */
export async function downloadImageAsDataUrl(url, timeoutMs = 30000) {
  const safeUrl = await validateImageUrl(url);
  const delays = [600, 1500, 3000];
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const { buffer, contentType } = await safeFetchBinary(safeUrl);
      if (!buffer || !buffer.length) throw new Error('图片内容为空');
      const mime = detectMime(buffer) || String(contentType || 'image/jpeg').split(';')[0];
      return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch (e) {
      lastError = e;
      if (attempt < delays.length) await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastError ?? new Error('图片下载失败');
}

/** 组装多模态 user message 的 content（文本 + 图片） */
export function imageParts(text, dataUrls) {
  const parts = [{ type: 'text', text: String(text || '') }];
  for (const u of dataUrls) parts.push({ type: 'image_url', image_url: { url: u } });
  return parts;
}

/** 工具允许读发的本地目录（项目内 workspace/ 与 dsh-work/，外加系统临时目录） */
export const WORKSPACE_DIR = path.join(ROOT, 'workspace');
export const DSH_WORK_DIR = path.join(ROOT, 'dsh-work');
export const TEMP_DIRS = ['/tmp', ...(process.env.TMPDIR ? [process.env.TMPDIR] : [])];
export const LOCAL_PATH_PREFIXES = [WORKSPACE_DIR, DSH_WORK_DIR, ...TEMP_DIRS];
