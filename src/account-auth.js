// ── 账号密码认证（2026-10-25）────────────────────────────────────
//
// 用户需求："现在只有注册，没有密码没有账密登录功能吧？补上"
//
// 现状：作者注册只能走邮箱验证码，每次登录都要收码。
//       频繁发布的人体验很差，而且验证码中心挂了就完全进不去。
//
// 本模块补上密码这条路：
//   注册时设密码 → 之后可以「邮箱 + 密码」直接登录
//   验证码仍然保留（找回密码用）
//
// 🔴 密码存储三条铁律：
//   ① 绝不存明文
//   ② 用 scrypt 加盐（比 sha256 抗暴力破解强得多）
//   ③ 比较用 timingSafeEqual（防时序攻击）
//
// 存储：data/plugins/plugin-market/accounts.json
//   { "<email>": { salt, hash, algo, updatedAt } }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const ACCOUNTS_FILE = () => path.join(DATA_DIR, 'plugins', 'plugin-market', 'accounts.json');

/** scrypt 参数：N=16384 大概 50ms，手机上也不会太慢 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** 读全部账号 */
function loadAccounts() {
  try {
    const f = ACCOUNTS_FILE();
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, 'utf8')) || {};
  } catch {
    return {};
  }
}

/** 写账号表（权限 600，只有服务进程能读） */
function saveAccounts(db) {
  const f = ACCOUNTS_FILE();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(db, null, 2), { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch { /* 忽略 */ }
}

/** 邮箱归一化（统一小写去空格，避免同一人建两个账号） */
export function normEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** 密码强度校验 */
export function checkPassword(pw) {
  const s = String(pw || '');
  if (s.length < 8) return { ok: false, error: '密码至少 8 位' };
  if (s.length > 128) return { ok: false, error: '密码太长（上限 128 位）' };
  // 至少两类字符，避免纯数字
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((re) => re.test(s)).length;
  if (kinds < 2) return { ok: false, error: '密码需包含字母、数字、符号中的至少两类' };
  return { ok: true };
}

/** 生成 scrypt 哈希 */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p
  }).toString('hex');
}

/** 设置/修改密码 */
export function setPassword(email, password) {
  const e = normEmail(email);
  if (!e) return { ok: false, error: '邮箱为空' };
  const ck = checkPassword(password);
  if (!ck.ok) return ck;

  const db = loadAccounts();
  const salt = crypto.randomBytes(16).toString('hex');
  db[e] = {
    salt,
    hash: hashPassword(password, salt),
    algo: `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}`,
    updatedAt: new Date().toISOString()
  };
  saveAccounts(db);
  return { ok: true, email: e };
}

/** 删除密码（撤销账密登录） */
export function clearPassword(email) {
  const e = normEmail(email);
  const db = loadAccounts();
  if (!db[e]) return { ok: false, error: '该邮箱没有设置密码' };
  delete db[e];
  saveAccounts(db);
  return { ok: true };
}

/** 是否已设密码 */
export function hasPassword(email) {
  return !!loadAccounts()[normEmail(email)];
}

/**
 * 校验密码。
 *
 * 🔴 无论如何都跑一次 scrypt —— 即使邮箱不存在。
 *    否则响应时间差异会泄露「这个邮箱有没有注册」。
 */
export function verifyPassword(email, password) {
  const e = normEmail(email);
  const db = loadAccounts();
  const rec = db[e];

  // 账号不存在时也做一次等价计算，抹平时间差
  if (!rec) {
    hashPassword(password, 'dummy-salt-for-timing');
    return { ok: false, error: '邮箱或密码不对' };
  }

  const got = Buffer.from(hashPassword(password, rec.salt), 'hex');
  const want = Buffer.from(rec.hash, 'hex');
  if (got.length !== want.length) return { ok: false, error: '邮箱或密码不对' };

  if (!crypto.timingSafeEqual(got, want)) {
    return { ok: false, error: '邮箱或密码不对' };
  }
  return { ok: true, email: e };
}

/** 账号概况（给前端判断「该显示登录还是注册」） */
export function accountInfo(email) {
  const e = normEmail(email);
  if (!e) return { exists: false, hasPassword: false };
  const db = loadAccounts();
  return { exists: !!db[e], hasPassword: !!db[e] };
}

/** 列已设密码的邮箱数（不含密码本身，管理面板用） */
export function accountStats() {
  const db = loadAccounts();
  return { total: Object.keys(db).length };
}
