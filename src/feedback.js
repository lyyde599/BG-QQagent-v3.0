// ── 内核 BUG 反馈 / 优化建议（2026-10-25）────────────────────────
//
// 需求：设置最下面加一个「内核包 BUG 反馈」页，允许提交错误日志和优化 .md，
//       需要创造营登录后才能用。
//
// 设计要点：
//   ① 提交要登录 —— 复用创造营的作者身份（author.json），不另建账号体系
//   ② 落本地磁盘 —— data/feedback/<id>/，不进 R2（先落在自己服务器）
//   ③ 自动附带环境信息 —— 内核版本、Node 版本、插件数、最近错误
//   ④ 支持附件 .md —— 优化建议通常是长文，允许直接传文件
//   ⑤ 限流 —— 同一个人每小时最多 5 条，防刷

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig } from './config.js';

const MAX_BODY = 200 * 1024;        // 正文 200KB
const MAX_ATTACH = 2 * 1024 * 1024; // 单个附件 2MB
const RATE_PER_HOUR = 5;

function rootDir() {
  return path.join(DATA_DIR, 'feedback');
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 本条反馈的目录：data/feedback/<yyyy-mm-dd>/<id>/ */
function itemDir(id) {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(rootDir(), day, String(id).replace(/[^a-zA-Z0-9-]/g, ''));
}

/** 限流：按邮箱计数，存 data/feedback/.rate.json */
function rateCheck(email) {
  const f = path.join(rootDir(), '.rate.json');
  ensureDir(rootDir());
  let db = {};
  try { db = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* 首次 */ }
  const hourAgo = Date.now() - 3600 * 1000;
  const hits = (db[email] || []).filter((t) => t > hourAgo);
  if (hits.length >= RATE_PER_HOUR) {
    return { ok: false, error: `提交太频繁（每小时最多 ${RATE_PER_HOUR} 条），请稍后再试` };
  }
  hits.push(Date.now());
  db[email] = hits;
  try { fs.writeFileSync(f, JSON.stringify(db), 'utf8'); } catch { /* 忽略 */ }
  return { ok: true };
}

/** 收集环境信息（帮作者定位问题，用户不用手填） */
export function collectEnv() {
  const cfg = getConfig();
  let pkgVersion = 'unknown';
  try {
    pkgVersion = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version;
  } catch { /* 忽略 */ }

  return {
    kernelVersion: pkgVersion,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    tz: process.env.TZ || '',
    uptimeMinutes: Math.round(process.uptime() / 60),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    model: cfg?.api?.model || '',
    at: new Date().toISOString()
  };
}

/**
 * 提交一条反馈。
 *
 * @param {object} author  创造营作者档案（含 email/nickname）
 * @param {object} payload { type, title, body, attachName, attachBase64 }
 */
export function submitFeedback(author, payload = {}) {
  const email = String(author?.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: '需要先登录（创造营作者账号）' };

  const rl = rateCheck(email);
  if (!rl.ok) return rl;

  const type = ['bug', 'feature', 'other'].includes(payload.type) ? payload.type : 'bug';
  const title = String(payload.title || '').trim().slice(0, 120);
  if (!title) return { ok: false, error: '请填标题' };

  const body = String(payload.body || '');
  if (body.length > MAX_BODY) return { ok: false, error: `正文太长（上限 ${MAX_BODY / 1024}KB）` };

  // 附件（.md / .txt / .log）
  let attach = null;
  const b64 = String(payload.attachBase64 || '');
  if (b64) {
    const name = String(payload.attachName || 'attachment.md').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 80);
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch { return { ok: false, error: '附件 base64 解码失败' }; }
    if (buf.length > MAX_ATTACH) {
      return { ok: false, error: `附件太大（${(buf.length / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_ATTACH / 1024 / 1024}MB）` };
    }
    attach = { name, bytes: buf.length, buf };
  }

  const id = 'fb-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const dir = ensureDir(itemDir(id));

  const record = {
    id,
    type,
    title,
    body,
    submittedAt: new Date().toISOString(),
    submitter: { email, nickname: String(author?.nickname || ''), qq: String(author?.qq || '') },
    env: collectEnv(),
    attach: attach ? { name: attach.name, bytes: attach.bytes } : null,
    status: 'open'
  };

  fs.writeFileSync(path.join(dir, 'feedback.json'), JSON.stringify(record, null, 2), 'utf8');
  if (attach) fs.writeFileSync(path.join(dir, attach.name), attach.buf);

  return { ok: true, id, dir, record };
}

/** 列出反馈（管理员看全部，普通作者只看自己的） */
export function listFeedback({ email = '', all = false } = {}) {
  const base = rootDir();
  const out = [];
  try {
    if (!fs.existsSync(base)) return out;
    for (const day of fs.readdirSync(base)) {
      if (day.startsWith('.')) continue;
      const dayDir = path.join(base, day);
      if (!fs.statSync(dayDir).isDirectory()) continue;
      for (const id of fs.readdirSync(dayDir)) {
        const f = path.join(dayDir, id, 'feedback.json');
        if (!fs.existsSync(f)) continue;
        try {
          const r = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (!all && email && String(r.submitter?.email || '').toLowerCase() !== email) continue;
          out.push({ ...r, dir: path.join(dayDir, id) });
        } catch { /* 坏文件跳过 */ }
      }
    }
  } catch { /* 目录读不了当空 */ }
  out.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
  return out;
}

/** 统计 */
export function feedbackStats(email = '') {
  const mine = listFeedback({ email });
  return {
    total: mine.length,
    open: mine.filter((x) => x.status === 'open').length
  };
}

/** 管理员改反馈状态（open / resolved / ignored） */
export function setFeedbackStatus(id, status, by = '') {
  if (!['open', 'resolved', 'ignored'].includes(status)) {
    return { ok: false, error: 'status 不合法' };
  }
  const base = rootDir();
  const safeId = String(id || '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!safeId) return { ok: false, error: 'id 为空' };

  // 反馈按日期分目录，得扫一遍找
  try {
    if (!fs.existsSync(base)) return { ok: false, error: '没有反馈记录' };
    for (const day of fs.readdirSync(base)) {
      if (day.startsWith('.')) continue;
      const f = path.join(base, day, safeId, 'feedback.json');
      if (!fs.existsSync(f)) continue;
      const r = JSON.parse(fs.readFileSync(f, 'utf8'));
      r.status = status;
      r.reviewedAt = new Date().toISOString();
      r.reviewedBy = String(by || '');
      fs.writeFileSync(f, JSON.stringify(r, null, 2), 'utf8');
      return { ok: true, id: safeId, status };
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
  return { ok: false, error: '没有这条反馈' };
}

// ── 多附件反馈（2026-10-25）──────────────────────────────────────
//
// 用户要求："注册用户点击反馈按钮，出弹窗，可以提交 0-3 张图片
// 和 0-3 个日志或 md 文件，及文字描述内容"
//
// 与 submitFeedback 的区别：那个只支持单个任意附件。
// 这个专门支持两类：
//   images  —— 最多 3 张（png/jpg/webp/gif），单张 ≤ 5MB
//   files   —— 最多 3 个（.log/.txt/.md/.json），单个 ≤ 2MB
//
// 分开存目录，方便管理端按类型展示。

const MAX_IMAGES = 3;
// 日志与文档**分开计数**（2026-10-26）
// 用户要求："3图 + 3日志 + 3md 上限"
// 原来混在一个 files 数组里共 3 个名额，日志多了就没法再传 md。
const MAX_LOG_FILES = 3;
const MAX_DOC_FILES = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const FILE_EXT = new Set(['.log', '.txt', '.md', '.json']);

/** 安全文件名：只保留字母数字下划线连字符点与中文 */
const safeName = (n) => String(n || 'file')
  .replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
  .replace(/^\.+/, '')
  .slice(0, 80) || 'file';

/**
 * 提交带多附件的反馈
 *
 * @param {{email,nickname,qq}} author 已登录作者
 * @param {object} payload { type, title, body, images:[{name,base64}], files:[{name,base64}] }
 */
export function submitFeedbackRich(author, payload = {}) {
  const email = String(author?.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: '需要先登录（创造营作者账号）' };

  const rl = rateCheck(email);
  if (!rl.ok) return rl;

  const type = ['bug', 'feature', 'other'].includes(payload.type) ? payload.type : 'bug';
  const title = String(payload.title || '').trim().slice(0, 120);
  if (!title) return { ok: false, error: '请填标题' };

  const body = String(payload.body || '');
  if (body.length > MAX_BODY) return { ok: false, error: `正文太长（上限 ${MAX_BODY / 1024}KB）` };

  const images = Array.isArray(payload.images) ? payload.images : [];
  // 兼容两种入参：
  //   payload.files        —— 老格式，混在一起
  //   payload.logFiles / payload.docFiles —— 新格式，日志与文档分开
  const rawFiles = [
    ...(Array.isArray(payload.logFiles) ? payload.logFiles : []),
    ...(Array.isArray(payload.docFiles) ? payload.docFiles : []),
    ...(Array.isArray(payload.files) ? payload.files : []),
  ];
  if (images.length > MAX_IMAGES) return { ok: false, error: `图片最多 ${MAX_IMAGES} 张` };

  // 先全部解码校验，任何一项不合格就整体拒绝（不留半成品目录）
  const decodedImages = [];
  for (const it of images) {
    const b64 = String(it?.base64 || '');
    if (!b64) continue;
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch { return { ok: false, error: '图片 base64 解码失败' }; }
    if (buf.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: `图片太大（${(buf.length / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB）` };
    }
    const name = safeName(it?.name || 'image.png');
    const ext = path.extname(name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) return { ok: false, error: `不支持的图片类型：${ext || '(无扩展名)'}` };
    decodedImages.push({ name, bytes: buf.length, buf });
  }

  // 日志与文档分开校验、分开计数（2026-10-26）
  const LOG_EXT = new Set(['.log', '.txt', '.json']);
  const DOC_EXT = new Set(['.md']);

  const decodedLogs = [];
  const decodedDocs = [];
  for (const it of rawFiles) {
    const b64 = String(it?.base64 || '');
    if (!b64) continue;
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch { return { ok: false, error: '附件 base64 解码失败' }; }
    if (buf.length > MAX_FILE_BYTES) {
      return { ok: false, error: `附件太大（${(buf.length / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_FILE_BYTES / 1024 / 1024}MB）` };
    }
    const name = safeName(it?.name || 'log.txt');
    const ext = path.extname(name).toLowerCase();
    const target = LOG_EXT.has(ext) ? decodedLogs : (DOC_EXT.has(ext) ? decodedDocs : null);
    if (!target) {
      return { ok: false, error: `不支持的附件类型：${ext || '(无扩展名)'}（日志收 .log/.txt/.json，文档收 .md）` };
    }
    target.push({ name, bytes: buf.length, buf });
  }

  if (decodedLogs.length > MAX_LOG_FILES) return { ok: false, error: `日志最多 ${MAX_LOG_FILES} 个` };
  if (decodedDocs.length > MAX_DOC_FILES) return { ok: false, error: `文档（.md）最多 ${MAX_DOC_FILES} 个` };

  const decodedFiles = [...decodedLogs, ...decodedDocs];

  const id = 'fb-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const dir = ensureDir(itemDir(id));

  // 针对具体插件的反馈（2026-10-26）
  const pluginId = String(payload?.pluginId || '').trim().slice(0, 64);
  const pluginName = String(payload?.pluginName || '').trim().slice(0, 64);
  const pluginVersion = String(payload?.pluginVersion || '').trim().slice(0, 32);

  const record = {
    id,
    type,
    title,
    body,
    // 从哪个插件卡片点的「反馈」；null 表示通用反馈
    plugin: pluginId ? { id: pluginId, name: pluginName, version: pluginVersion } : null,
    submittedAt: new Date().toISOString(),
    submitter: { email, nickname: String(author?.nickname || ''), qq: String(author?.qq || '') },
    env: collectEnv(),
    // 附件清单（实际文件落在同目录）
    images: decodedImages.map((x) => ({ name: x.name, bytes: x.bytes })),
    // 分开存：日志 / 文档，便于管理端按类型展示
    logFiles: decodedLogs.map((x) => ({ name: x.name, bytes: x.bytes })),
    docFiles: decodedDocs.map((x) => ({ name: x.name, bytes: x.bytes })),
    files: decodedFiles.map((x) => ({ name: x.name, bytes: x.bytes })),
    status: 'open',
  };

  fs.writeFileSync(path.join(dir, 'feedback.json'), JSON.stringify(record, null, 2), 'utf8');
  decodedImages.forEach((x) => fs.writeFileSync(path.join(dir, x.name), x.buf));
  decodedFiles.forEach((x) => fs.writeFileSync(path.join(dir, x.name), x.buf));

  return { ok: true, id, dir, record };
}
