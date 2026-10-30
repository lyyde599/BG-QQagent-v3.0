// ── 邮件发信服务（内核，2026-10-25）────────────────────────────────
//
// 为什么放在内核而不是插件里：
//
//   🔴 发信能力会随插件包分发出去。
//      插件包是公开的（别人下载就能拿到全部文件），
//      把 send_mail.py 放进去等于把"我们怎么发验证码"整套实现公开。
//      虽然授权码不在包里（读的是 .secrets/），但实现暴露本身就是风险：
//      别人可以照着改一个自己的发信器，拿去发垃圾邮件。
//
//   邮件通道属于**基础设施**，和 OneBot、数据库同级 ——
//   它不该跟着某个业务插件走。插件只表达"我要发一封信"，
//   怎么发、用什么账号、走哪个 SMTP，都是内核的事。
//
// 依赖：走本机 python3 的 smtplib（标准库），不引 npm 依赖。
// 凭据：界面填写 / 环境变量 / .secrets/smtp/ 三种来源，见下方 SECRET_DIR。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'mail', 'send_mail.py');
// 凭据目录查找顺序（不写死某台机器的路径）：
//   ① QQAGENT_SECRETS_DIR 环境变量
//   ② <项目根>/.secrets/smtp        —— 部署时把凭据放这里
//   ③ ~/.secrets/smtp               —— 本机开发时的位置
const SECRET_DIR = (() => {
  const secretsDir = process.env.WB_SECRETS_DIR || process.env.QQAGENT_SECRETS_DIR;
  if (secretsDir) return path.join(secretsDir, 'smtp');
  const cands = [
    path.join(HERE, '..', '..', '.secrets', 'smtp'),
    path.join(os.homedir(), '.secrets', 'smtp')
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return cands[0];
})();

// ── 凭据来源（2026-10-25 重做）──
//
// 🔴 原来只从 .secrets/smtp/ 读，别人部署后没有这个目录，
//    注册就报"邮件通道未配置"，市场功能等于残废。
//
// 现在的顺序（先到先用）：
//   ① 环境变量 QQ_MAIL_USER / QQ_MAIL_CODE —— 容器/云平台友好
//   ② data/config.json 的 mail.user / mail.code —— **界面里填**
//   ③ .secrets/smtp/ 文件 —— 本机部署的老位置，保持兼容
//
// 为什么把②放前面：绝大多数用户不懂命令行，
// 让他们在「创造营 → 设置」里填两个框，比教他们建 .secrets 目录现实得多。
const fromConfig = () => {
  try {
    const cf = path.join(HERE, '..', '..', 'data', 'config.json');
    const d = JSON.parse(fs.readFileSync(cf, 'utf8'));
    return { user: String(d?.mail?.user || '').trim(), code: String(d?.mail?.code || '').trim() };
  } catch { return { user: '', code: '' }; }
};

/** 读凭据（每次现读，改了不用重启） */
const readSecret = (name) => {
  // ① 环境变量
  if (name === 'qq-user' && process.env.QQ_MAIL_USER) return String(process.env.QQ_MAIL_USER).trim();
  if (name === 'qq-authcode' && process.env.QQ_MAIL_CODE) return String(process.env.QQ_MAIL_CODE).trim();
  // ② config.json（界面填的）
  const c = fromConfig();
  if (name === 'qq-user' && c.user) return c.user;
  if (name === 'qq-authcode' && c.code) return c.code;
  // ③ 文件
  try { return fs.readFileSync(path.join(SECRET_DIR, name), 'utf8').trim(); }
  catch { return ''; }
};

/** 邮件通道是否可用 */
export function mailReady() {
  return !!(readSecret('qq-authcode') && readSecret('qq-user') && fs.existsSync(SCRIPT));
}

/** 凭据状态（给界面显示用，不含密钥本体） */
export function mailStatus() {
  const user = readSecret('qq-user');
  const code = readSecret('qq-authcode');
  // 邮箱只显示前 3 位 + 域名，不暴露完整地址
  const masked = user ? user.replace(/^(.{3}).*(@.*)$/, '$1***$2') : '';
  return {
    ready: !!(user && code && fs.existsSync(SCRIPT)),
    user: masked,
    hasCode: !!code,
    source: process.env.QQ_MAIL_CODE ? 'env' : (fromConfig().code ? 'config' : (code ? 'file' : '')),
  };
}

/**
 * 发一封信。
 *
 * @param {string} to    收件人
 * @param {string} subject 主题
 * @param {string} body  正文（纯文本）
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export function sendMail(to, subject, body) {
  return new Promise((resolve) => {
    if (!mailReady()) {
      return resolve({ ok: false, error: '邮件通道未配置' });
    }
    const user = readSecret('qq-user') || '';
    const code = readSecret('qq-authcode');
    if (!user) return resolve({ ok: false, error: '未配置发件邮箱地址' });

    const tmp = path.join(os.tmpdir(), `mail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    try {
      fs.writeFileSync(tmp, String(body ?? ''), 'utf8');
    } catch (e) {
      return resolve({ ok: false, error: '临时文件写入失败：' + e.message });
    }

    const py = spawn('python3', [SCRIPT, to, subject, tmp], {
      // 凭据只走环境变量，不进命令行参数（ps 看不到）
      env: { ...process.env, QQ_MAIL_USER: user, QQ_MAIL_CODE: code },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    py.stdout.on('data', (b) => { out += b.toString(); });
    py.stderr.on('data', (b) => { out += b.toString(); });

    const timer = setTimeout(() => {
      try { py.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ ok: false, error: '发信超时（40 秒）' });
    }, 40000);

    py.on('close', (c) => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      if (c === 0 && out.includes('OK')) resolve({ ok: true });
      else resolve({ ok: false, error: (out.match(/ERR: (.+)/) || [])[1] || out.slice(0, 150) || `退出码 ${c}` });
    });
  });
}

// ── 配置读写（2026-10-25）──────────────────────────────────────────
//
// 邮件通道属于**后端基础设施**，配置入口也在内核，不归任何插件。
// 理由：它和 OneBot token、模型 key 同级 —— 谁能发信是部署方的事，
// 不该由某个业务插件替部署方决定。
//
// 存放位置：data/config.json 的 mail 段
//   { "mail": { "user": "xxx@qq.com", "code": "授权码" } }
//
// 为什么不用 .secrets/：绝大多数用户不懂命令行。
// 让他们在设置页填两个框，比教他们建目录现实得多。
// 权限敏感度由 data/config.json 本身的 600 权限保证。

const CONFIG_PATH = path.join(HERE, '..', '..', 'data', 'config.json');

const readMain = () => {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
};

const writeMain = (d) => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(d, null, 2), 'utf8');
};

/**
 * 保存邮件配置。
 * @param {{user?:string, code?:string}} patch code 为空表示不修改原值
 */
export function saveMailConfig(patch) {
  const user = String(patch?.user ?? '').trim();
  const code = String(patch?.code ?? '').trim();

  if (user && !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(user)) {
    return { ok: false, error: '邮箱格式不对' };
  }
  if (code && code.length < 8) {
    return { ok: false, error: '授权码看起来不对（QQ 邮箱一般是 16 位）' };
  }

  const d = readMain();
  d.mail = d.mail || {};
  if (user) d.mail.user = user;
  if (code) d.mail.code = code;
  writeMain(d);

  return { ok: true, ...mailStatus() };
}

/** 清空邮件配置 */
export function clearMailConfig() {
  const d = readMain();
  if (d.mail) { delete d.mail; writeMain(d); }
  return { ok: true, ...mailStatus() };
}
