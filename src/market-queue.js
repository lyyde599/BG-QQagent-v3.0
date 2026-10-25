// ── 投稿队列：服务器暂存 + 人工审核（2026-10-25）──────────────────
//
// 用户需求："能不能做包上传，先在我们服务器储存，然后我去审核呢？我作为中心服务器"
//
// 与 GitHub 直链投稿的区别：
//   GitHub 直链 → 市场只读抓取，作者自己管版本，随时可变
//   上传队列   → 包落在中心服务器，**审核通过前不上架**，审核后固定版本
//
// 为什么要有这条：外部作者不一定有公开仓库，或者不想把源码公开。
// 上传队列让他们把包交给你，你审完再放出去。
//
// 存储：data/plugins/plugin-market/pending/
//    <submissionId>/
//        package.tar.gz    包体
//        meta.json         作者填写的信息 + 审核状态
//
// 🔴 安全约束：
//   · 包大小上限 50MB（服务器磁盘有限，不能让人往这扔大文件）
//   · submissionId 用随机串，不用作者提供的名字（防路径穿越）
//   · 只落盘不解压 —— 解压有 zip slip 风险，审核时人工看结构

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

/** 包大小上限 */
const MAX_BYTES = 50 * 1024 * 1024;

/** 队列根目录 */
function queueRoot() {
  return path.join(DATA_DIR, 'plugins', 'plugin-market', 'pending');
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 生成 submission id（随机，不含用户输入） */
function newId() {
  return 'sub-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

/** 列出全部投稿（元数据，不含包体） */
export function listSubmissions({ status = '' } = {}) {
  const root = queueRoot();
  const out = [];
  try {
    if (!fs.existsSync(root)) return out;
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      const metaFile = path.join(dir, 'meta.json');
      if (!fs.existsSync(metaFile)) continue;
      let meta;
      try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { continue; }
      if (status && meta.status !== status) continue;
      const pkg = path.join(dir, 'package.tar.gz');
      out.push({
        ...meta,
        bytes: fs.existsSync(pkg) ? fs.statSync(pkg).size : 0
      });
    }
  } catch { /* 目录读不了当空 */ }
  out.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
  return out;
}

/**
 * 接收一份投稿。
 *
 * @param {Buffer} buffer      包体
 * @param {object} meta        作者填写的信息
 */
export function submitPackage(buffer, meta = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return { ok: false, error: '包体为空' };
  }
  if (buffer.length > MAX_BYTES) {
    return { ok: false, error: `包太大（${(buffer.length / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_BYTES / 1024 / 1024}MB）` };
  }
  // 最少校验：tar.gz 魔数
  if (!(buffer[0] === 0x1f && buffer[1] === 0x8b)) {
    return { ok: false, error: '不是 gzip 包（请传 .tar.gz）' };
  }

  const id = newId();
  const dir = ensureDir(path.join(queueRoot(), id));
  fs.writeFileSync(path.join(dir, 'package.tar.gz'), buffer);

  const record = {
    id,
    status: 'pending',                 // pending | approved | rejected
    submittedAt: new Date().toISOString(),
    // 作者自述（都不信任，仅作参考，审核时以实际内容为准）
    pluginId: String(meta.pluginId || '').slice(0, 64),
    name: String(meta.name || '').slice(0, 100),
    version: String(meta.version || '').slice(0, 32),
    author: String(meta.author || '').slice(0, 64),
    contact: String(meta.contact || '').slice(0, 120),
    summary: String(meta.summary || '').slice(0, 300),
    notes: String(meta.notes || '').slice(0, 2000),
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase(),
    reviewedAt: null,
    reviewNote: ''
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(record, null, 2));

  return { ok: true, submission: record };
}

/** 读单个投稿的完整信息 */
export function getSubmission(id) {
  const safe = String(id || '').replace(/[^a-zA-Z0-9-]/g, '');
  const dir = path.join(queueRoot(), safe);
  const metaFile = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaFile)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    return { ...meta, dir, packagePath: path.join(dir, 'package.tar.gz') };
  } catch {
    return null;
  }
}

/** 审核：approve / reject */
export function reviewSubmission(id, action, note = '') {
  const sub = getSubmission(id);
  if (!sub) return { ok: false, error: '没有这条投稿' };
  if (sub.status !== 'pending') return { ok: false, error: `已经处理过了（当前 ${sub.status}）` };

  const status = action === 'approve' ? 'approved' : 'rejected';
  const next = {
    ...sub,
    status,
    reviewedAt: new Date().toISOString(),
    reviewNote: String(note || '').slice(0, 500)
  };
  delete next.dir;
  delete next.packagePath;
  fs.writeFileSync(path.join(queueRoot(), sub.id, 'meta.json'), JSON.stringify(next, null, 2));
  return { ok: true, submission: next };
}

/** 删除投稿（连同包体） */
export function deleteSubmission(id) {
  const sub = getSubmission(id);
  if (!sub) return { ok: false, error: '没有这条投稿' };
  try {
    fs.rmSync(sub.dir, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** 队列概况（管理面板顶部统计） */
export function queueStats() {
  const all = listSubmissions();
  return {
    total: all.length,
    pending: all.filter((s) => s.status === 'pending').length,
    approved: all.filter((s) => s.status === 'approved').length,
    rejected: all.filter((s) => s.status === 'rejected').length,
    bytes: all.reduce((n, s) => n + (s.bytes || 0), 0)
  };
}
