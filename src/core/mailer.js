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
// 凭据：/home/lyy/.secrets/smtp/（qq-user / qq-authcode），600。
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
  if (process.env.QQAGENT_SECRETS_DIR) return path.join(process.env.QQAGENT_SECRETS_DIR, 'smtp');
  const cands = [
    path.join(HERE, '..', '..', '.secrets', 'smtp'),
    path.join(os.homedir(), '.secrets', 'smtp')
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return cands[0];
})();

/** 读凭据（每次现读，改了不用重启） */
const readSecret = (name) => {
  try { return fs.readFileSync(path.join(SECRET_DIR, name), 'utf8').trim(); }
  catch { return ''; }
};

/** 邮件通道是否可用 */
export function mailReady() {
  return !!(readSecret('qq-authcode') && fs.existsSync(SCRIPT));
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
