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
