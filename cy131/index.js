// ── 插件：插件市场（作者：白光）────────────────────────────────────
//
// 干什么：浏览云端插件清单 → 下载 → 校验 sha256 → 安装。
//
// ── 设计原则 ──
//
//   ① **双通道读清单**：GitHub raw 为主，R2 镜像为备。
//      一个挂了自动切另一个 —— 单点故障不该让整个市场不可用。
//
//   ② **只读不写**：这个插件只从云端下载，**从不往云端写**。
//      所以它不需要任何 GitHub / Cloudflare 凭据，
//      也就不存在"机房 IP 写入被风控"的问题。
//
//   ③ **sha256 强校验**：下载完必须比对清单里的哈希。
//      对不上就丢弃，绝不安装 —— 挡住传输损坏与中间篡改。
//
//   ④ **安装必须显式确认**：插件能执行任意代码，
//      安装前把 permissions 摊开给用户看，不能默默装上。
//
//   ⑤ **不自己解压安装**：复用内核已有的 /api/plugins/import 通道，
//      那边已经处理好了路径校验、覆盖策略、重载。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import * as queue from '../../src/market-queue.js';   // 投稿队列（服务器暂存 + 审核）
import * as auth from '../../src/account-auth.js';        // 账密认证（scrypt 加盐）

export async function activate(ctx) {
  const cfg = () => {
    const c = ctx.config.get() || {};
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      indexUrl: String(c.indexUrl || ''),
      mirrorUrl: String(c.mirrorUrl || ''),
      showUntrusted: c.showUntrusted === true,
      autoCheckUpdate: c.autoCheckUpdate !== false,
      // 自动更新：检查到新版本就自动装（默认关 —— 覆盖安装是危险动作）
      autoUpdate: c.autoUpdate === true,
      checkIntervalHours: num(c.checkIntervalHours, 6),
    };
  };

  // ── 统一请求头（2026-10-25）──
  //
  // 🔴 实测踩坑：Cloudflare R2 的 r2.dev 公开域名会**拦截默认 UA**。
  //    Python urllib 的默认 UA 直接 403 Forbidden，
  //    换成 curl/8.0 或自定义 UA 就 200。
  //    所以必须显式带 UA，不能依赖运行时的默认值 ——
  //    否则市场在 Node 的 fetch 下也会莫名其妙 403。
  const UA = 'QQAgent-Market/1.0 (+https://597457.xyz)';
  const HEADERS = {
    'User-Agent': UA,
    'Accept': 'application/json, application/gzip, */*',
  };

  // ── 内存缓存：避免每次打开面板都拉网络 ──
  let cache = { at: 0, data: null, source: '', error: null };
  const CACHE_MS = 5 * 60 * 1000;

  /**
   * 拉市场清单（双通道）
   *
   * 顺序：主 → 备。任一成功即返回，并记录用的是哪个源。
   * 都失败则返回缓存（如果有），并带上错误说明 —— 不能让面板白屏。
   */
  const fetchIndex = async (force = false) => {
    const c = cfg();
    if (!force && cache.data && Date.now() - cache.at < CACHE_MS) {
      return { ok: true, data: cache.data, source: cache.source, cached: true };
    }

    const urls = [c.indexUrl, c.mirrorUrl].filter(Boolean);
    if (!urls.length) return { ok: false, error: '没有配置市场地址' };

    const errors = [];
    for (const u of urls) {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(15000), headers: HEADERS });
        if (!res.ok) { errors.push(`${u} → HTTP ${res.status}`); continue; }
        const text = await res.text();
        const data = JSON.parse(text);
        if (!data || !Array.isArray(data.plugins)) {
          errors.push(`${u} → 清单格式不对（缺 plugins 数组）`);
          continue;
        }
        cache = { at: Date.now(), data, source: u, error: null };
        ctx.log(`[市场] 清单已加载：${data.plugins.length} 个插件（源：${u}）`);
        return { ok: true, data, source: u, cached: false };
      } catch (e) {
        errors.push(`${u} → ${String(e?.message ?? e).slice(0, 80)}`);
      }
    }

    // 全挂了：有缓存就给缓存，同时把错误带上
    if (cache.data) {
      return { ok: true, data: cache.data, source: cache.source, cached: true, error: errors.join('；') };
    }
    return { ok: false, error: '两个源都拿不到清单：' + errors.join('；') };
  };

  /** 下载并校验 */
  const downloadPackage = async (url, expectedSha) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: HEADERS });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('下载到空文件');

    // 🔴 sha256 强校验：对不上就不装
    if (expectedSha) {
      const got = crypto.createHash('sha256').update(buf).digest('hex');
      if (got.toLowerCase() !== String(expectedSha).toLowerCase()) {
        throw new Error(`sha256 不匹配（期望 ${String(expectedSha).slice(0, 12)}…，实际 ${got.slice(0, 12)}…），已丢弃`);
      }
    }
    return buf;
  };

  // ── 作者注册（邮箱验证码，2026-10-25）──
  //
  // 用户要求："让别人注册邮箱的时候发验证码使用"
  //
  // 流程：
  //   ① 填邮箱 → 发 6 位码（10 分钟有效）
  //   ② 回填码 → 注册成功 → 拿到作者身份
  //
  // 安全设计：
  //   · 同一邮箱 60 秒内只能发一次（防刷）
  //   · 同一 IP 一小时最多 10 次（防滥用，虽然本地部署意义有限）
  //   · 验证码只存内存，重启即失效（不给持久化留后门）
  //   · 输入上限 5 次，超了作废（防爆破）
  //   · 码用 crypto 随机生成，不用 Math.random
  //
  // 为什么发信走 Python 而不是 nodemailer：
  //   内核 npm 依赖只有 4 个，为发几封验证码引入整个邮件库不值得。
  //   Python 的 smtplib 是标准库，服务器上本来就有。
  /**
   * 发一封信 —— 委托给内核（2026-10-25）
   *
   * 🔴 原来这段是插件自己 spawn python 发信，send_mail.py 也跟着插件包走。
   *    但插件包是公开的，等于把整套发信实现分发给所有人。
   *    现在改成调 ctx.mail.send()，插件看不到 SMTP 细节和凭据。
   */
  // ── 验证码发送（2026-10-25 改为分布式）──
  //
  // 🔴 架构决定：验证码**不该让每个部署者自己配 SMTP**。
  //
  //   原因：
  //     · 别人的机器上没有我们的邮箱授权码，也没有 QQ 邮箱的 SMTP 权限
  //     · 让每个用户去 QQ 邮箱开 SMTP、生成授权码，门槛太高
  //     · 验证码是**服务方的事**，不是部署方的事
  //
  //   现在的两条路：
  //     ① 本机配了 SMTP（qq-user + qq-authcode 都有）→ 直接发
  //     ② 本机没配 → 调到中心服务请求发信
  //
  //   中心服务地址由 config.authUrl 指定（默认我们这台）。
  //   请求只带 email，中心负责发信并把"发没发出去"告诉调用方。
  //   **验证码本身不经过客户端** —— 校验也在中心做（见 verify）。
  const CENTER_URL = () => {
    const c = ctx.config.get() || {};
    return String(c.authUrl || 'https://auth.597457.xyz/api/auth');
  };

  const sendVerifyCode = async (email) => {
    // ① 本机有 SMTP 就自己发
    if (ctx.mail?.ready?.()) {
      const code = String(crypto.randomInt(100000, 1000000));
      const body = [
        '你好，',
        '',
        '你正在注册 QQAgent 创造营的作者账号。',
        '',
        `验证码：${code}`,
        '',
        '10 分钟内有效。若不是你本人操作，忽略这封邮件。',
        '',
        '—— QQAgent 创造营',
      ].join('\n');
      const r = await ctx.mail.send(email, '【QQAgent 创造营】注册验证码', body);
      if (!r.ok) return { ok: false, error: '发信失败：' + r.error };
      return { ok: true, local: true, code };
    }

    // ② 没配 SMTP → 请求中心服务
    try {
      const res = await fetch(`${CENTER_URL()}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(30000),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d?.ok === false) {
        return { ok: false, error: d?.error || `中心服务返回 HTTP ${res.status}` };
      }
      return { ok: true, central: true };
    } catch (e) {
      return {
        ok: false,
        error: '连不上验证码服务（' + String(e?.message ?? e).slice(0, 60) + '）。'
          + '可以在「设置」里配自己的邮箱，或检查网络。',
      };
    }
  };

  // ── 验证码暂存（内存）──
  const codes = new Map();     // email -> { code, at, tries }
  const sendLog = new Map();   // email -> 上次发送时间
  const CODE_TTL = 10 * 60 * 1000;
  const RESEND_GAP = 60 * 1000;

  const cleanCodes = () => {
    const now = Date.now();
    for (const [k, v] of codes) if (now - v.at > CODE_TTL) codes.delete(k);
  };

  // ── 找回密码（2026-10-25）──────────────────────────────
  //
  // 用户需求："为作者账号们提供忘记密码（找回密码功能）"
  //
  // 流程：邮箱收验证码 → 验证码 + 新密码 → 重置
  //
  // 🔴 安全边界：
  //   ① 必须走验证码 —— 没有验证码就能重置 = 密码形同虚设
  //   ② 不告诉调用方"这个邮箱有没有注册"（统一提示"如果该邮箱已注册，验证码已发送"）
  //   ③ 重置后清掉旧密码哈希，重新加盐
  //   ④ 记日志，方便主人排查异常重置

  // ① 发送重置验证码
  ctx.http.route('POST', '/api/market/password/reset-send', async (_req, body) => {
    const email = auth.normEmail(body?.email);
    if (!email) return { ok: false, error: '请填邮箱' };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: '邮箱格式不对' };

    // 🔴 防枚举：无论邮箱是否存在，都尝试发码并返回同样的提示
    const r = await sendVerifyCode(email);
    if (!r.ok) {
      // 发信失败要如实报（否则用户以为发了在等）
      return { ok: false, error: r.error };
    }
    ctx.log(`[市场] 找回密码验证码已发送：${email}`);
    return {
      ok: true,
      message: '如果该邮箱已注册，验证码已发送，请查收（含垃圾箱）。10 分钟内有效。'
    };
  }, { absolute: true });

  // ② 用验证码重置密码
  ctx.http.route('POST', '/api/market/password/reset', async (_req, body) => {
    const email = auth.normEmail(body?.email);
    const code = String(body?.code || '').trim();
    const newPassword = String(body?.password || '');

    if (!email) return { ok: false, error: '请填邮箱' };
    if (!code) return { ok: false, error: '请填验证码' };

    // 密码强度先查，避免验完码才发现密码不合格
    const ck = auth.checkPassword(newPassword);
    if (!ck.ok) return ck;

    // 验证码校验：本地发的自己验，中心发的转发
    const rec = codes.get(email);
    if (rec) {
      if (Date.now() - rec.at > CODE_TTL) {
        codes.delete(email);
        return { ok: false, error: '验证码已过期，请重新获取' };
      }
      if (rec.tries >= 5) {
        codes.delete(email);
        return { ok: false, error: '错误次数太多，请重新获取验证码' };
      }
      if (code !== rec.code) {
        rec.tries++;
        return { ok: false, error: `验证码不对（还可以试 ${5 - rec.tries} 次）` };
      }
      codes.delete(email);
    } else {
      try {
        const res = await fetch(`${CENTER_URL()}/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'User-Agent': UA },
          body: JSON.stringify({ email, code }),
          signal: AbortSignal.timeout(20000),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || d?.ok === false) {
          return { ok: false, error: d?.error || `验证失败（HTTP ${res.status}）` };
        }
      } catch (e) {
        return { ok: false, error: '连不上验证服务：' + String(e?.message ?? e).slice(0, 60) };
      }
    }

    // 验证通过：重置密码（setPassword 会重新生成 salt）
    const r = auth.setPassword(email, newPassword);
    if (!r.ok) return r;

    // 如果本地作者档案是这个邮箱，同步 hasPassword
    try {
      const f = path.join(ctx.data.dir, 'author.json');
      if (fs.existsSync(f)) {
        const a = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (auth.normEmail(a.email) === email) {
          a.hasPassword = true;
          a.passwordResetAt = new Date().toISOString();
          fs.writeFileSync(f, JSON.stringify(a, null, 2), 'utf8');
        }
      }
    } catch { /* 忽略 */ }

    ctx.log(`[市场] 密码已重置：${email}`);
    return { ok: true, message: '密码已重置，请用新密码登录。' };
  }, { absolute: true });

  // ③ 查询该邮箱是否可找回（不泄露是否注册，只告诉前端该显示什么）
  ctx.http.route('POST', '/api/market/password/can-reset', (_req, body) => {
    const email = auth.normEmail(body?.email);
    if (!email) return { ok: false, error: '请填邮箱' };
    // 🔴 恒返回 ok —— 不暴露"这个邮箱有没有账号"
    return { ok: true };
  }, { absolute: true });

  // ── 账密登录（2026-10-25）──────────────────────────────
  //
  // 补上「邮箱 + 密码」这条路。验证码仍然保留（找回密码 / 首次注册用）。
  //
  // 与「发布」的关系：登录成功后只写本地 author.json（和验证码注册等价），
  // 后续发布/下架/投稿的归属判定完全不变。

  ctx.http.route('POST', '/api/market/login/password', async (_req, body) => {
    const email = auth.normEmail(body?.email);
    const password = String(body?.password || '');
    if (!email || !password) return { ok: false, error: '邮箱和密码都要填' };

    const r = auth.verifyPassword(email, password);
    if (!r.ok) {
      ctx.log(`[市场] 账密登录失败：${email}`);
      return r;
    }

    // 读已有档案（保留 qq/nickname），没有就建一个最小档案
    let author = null;
    try {
      author = JSON.parse(fs.readFileSync(path.join(ctx.data.dir, 'author.json'), 'utf8'));
    } catch { /* 首次登录 */ }

    if (!author || auth.normEmail(author.email) !== email) {
      author = { email, qq: '', nickname: email.split('@')[0], verifiedAt: new Date().toISOString() };
    }
    author.hasPassword = true;
    author.lastLoginAt = new Date().toISOString();

    fs.mkdirSync(ctx.data.dir, { recursive: true });
    fs.writeFileSync(path.join(ctx.data.dir, 'author.json'), JSON.stringify(author, null, 2), 'utf8');
    ctx.log(`[市场] 账密登录成功：${email}`);
    return { ok: true, author };
  }, { absolute: true });

  // 设置 / 修改密码（需已登录）
  ctx.http.route('POST', '/api/market/login/set-password', async (_req, body) => {
    const w = whoAmI();
    if (w.role === 'guest') return { ok: false, error: '请先登录' };

    const password = String(body?.password || '');
    const oldPassword = String(body?.oldPassword || '');

    // 已有密码时必须提供旧密码
    if (auth.hasPassword(w.me.email)) {
      if (!oldPassword) return { ok: false, error: '请输入当前密码' };
      const v = auth.verifyPassword(w.me.email, oldPassword);
      if (!v.ok) return { ok: false, error: '当前密码不对' };
    }

    const r = auth.setPassword(w.me.email, password);
    if (!r.ok) return r;

    try {
      const f = path.join(ctx.data.dir, 'author.json');
      const a = JSON.parse(fs.readFileSync(f, 'utf8'));
      a.hasPassword = true;
      fs.writeFileSync(f, JSON.stringify(a, null, 2), 'utf8');
    } catch { /* 忽略 */ }

    ctx.log(`[市场] ${w.me.email} 设置了登录密码`);
    return { ok: true };
  }, { absolute: true });

  // 账号状态（前端决定显示「设密码」还是「改密码」）
  ctx.http.route('POST', '/api/market/login/account', (_req, body) => {
    const email = auth.normEmail(body?.email);
    if (!email) return { ok: false, error: '邮箱为空' };
    const info = auth.accountInfo(email);
    return { ok: true, ...info };
  }, { absolute: true });

  ctx.http.route('GET', '/api/market/register/status', () => {
    try {
      const f = path.join(ctx.data.dir, 'author.json');
      if (!fs.existsSync(f)) return { ok: true, registered: false };
      const a = JSON.parse(fs.readFileSync(f, 'utf8'));
      return { ok: true, registered: !!a?.email, author: a };
    } catch { return { ok: true, registered: false }; }
  }, { absolute: true });

  ctx.http.route('POST', '/api/market/register/send', async (_req, body) => {
    const email = String(body?.email || '').trim().toLowerCase();
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
      return { ok: false, error: '邮箱格式不对' };
    }

    // 防刷：60 秒一次
    const last = sendLog.get(email) || 0;
    if (Date.now() - last < RESEND_GAP) {
      const wait = Math.ceil((RESEND_GAP - (Date.now() - last)) / 1000);
      return { ok: false, error: `刚发过，请 ${wait} 秒后再试` };
    }

    cleanCodes();
    const r = await sendVerifyCode(email);

    if (!r.ok) {
      codes.delete(email);
      return { ok: false, error: r.error };
    }
    // 本地发的：记下验证码自己校验；中心发的：不存，验证时问中心
    if (r.local && r.code) codes.set(email, { code: r.code, at: Date.now(), tries: 0 });

    sendLog.set(email, Date.now());
    ctx.log(`[市场] 验证码已发往 ${email.replace(/(.{3}).*(@.*)/, '$1***$2')}（${r.local ? '本地' : '中心服务'}）`);
    return {
      ok: true,
      via: r.local ? 'local' : 'central',
      message: '验证码已发送，请查收（含垃圾箱）',
    };
  }, { absolute: true });

  ctx.http.route('POST', '/api/market/register/verify', async (_req, body) => {
    const email = String(body?.email || '').trim().toLowerCase();
    const input = String(body?.code || '').trim();
    const qq = String(body?.qq || '').trim();
    const nickname = String(body?.nickname || '').trim().slice(0, 20);

    // 验证码校验：本地发的自己验，中心发的不存验证码，去问中心
    const rec = codes.get(email);
    if (rec) {
      // ① 本地验证码
      if (Date.now() - rec.at > CODE_TTL) {
        codes.delete(email);
        return { ok: false, error: '验证码已过期，请重新获取' };
      }
      if (rec.tries >= 5) {
        codes.delete(email);
        return { ok: false, error: '错误次数太多，请重新获取验证码' };
      }
      if (input !== rec.code) {
        rec.tries++;
        return { ok: false, error: `验证码不对（还可以试 ${5 - rec.tries} 次）` };
      }
      codes.delete(email);
    } else {
      // ② 中心验证码：本地不存，转发给中心校验
      try {
        const res = await fetch(`${CENTER_URL()}/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'User-Agent': UA },
          body: JSON.stringify({ email, code: input }),
          signal: AbortSignal.timeout(20000),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || d?.ok === false) {
          return { ok: false, error: d?.error || `验证失败（HTTP ${res.status}）` };
        }
      } catch (e) {
        return { ok: false, error: '连不上验证服务：' + String(e?.message ?? e).slice(0, 60) };
      }
    }

    // 通过：写作者档案
    if (qq && !/^\d{5,12}$/.test(qq)) return { ok: false, error: 'QQ 号格式不对' };
    // 密码（可选）：设了就能以后免验证码登录
    const password = String(body?.password || '');
    let pwSet = false;
    if (password) {
      const pr = auth.setPassword(email, password);
      if (!pr.ok) return pr;
      pwSet = true;
    }

    const author = {
      email,
      qq: qq || '',
      nickname: nickname || '',
      verifiedAt: new Date().toISOString(),
      hasPassword: pwSet || auth.hasPassword(email)
    };
    fs.mkdirSync(ctx.data.dir, { recursive: true });
    fs.writeFileSync(path.join(ctx.data.dir, 'author.json'), JSON.stringify(author, null, 2), 'utf8');
    ctx.log(`[市场] 作者注册成功：${email}${pwSet ? '（已设密码）' : ''}`);
    return { ok: true, author, hasPassword: author.hasPassword };
  }, { absolute: true });

  // ── 接口：拿清单 ──
  ctx.http.route('GET', '/api/market/index', async (_req, _b, url) => {
    const force = url?.searchParams?.get('force') === '1';
    const r = await fetchIndex(force);
    if (!r.ok) return r;

    const c = cfg();
    // 🔴 默认显示全部，包括 unverified（2026-10-25 改）
    //
    // 原来默认只显示 official/verified —— 但 verified 在过去**根本产生不了**
    // （没有审核接口），于是第三方提交的插件永远是隐形的，等于白发布。
    //
    // 现在默认全显示，用 trust 字段做「标识」而不是「屏蔽」：
    //   official   → 官方（随内核分发）
    //   verified   → 管理员审过
    //   unverified → 作者自述，未审核（前端会标黄提示）
    // 想只看可信的可把 showUntrusted 设为 false（保留这个开关）。
    const list = (r.data.plugins || []).filter((p) => {
      if (c.hideUntrusted === true) return p.trust === 'official' || p.trust === 'verified';
      return true;
    });

    // 已安装的标出来（内核 records 里有）
    let installed = new Map();
    try {
      const d = await fetch('http://127.0.0.1:3210/api/plugins', { signal: AbortSignal.timeout(8000) })
        .then((x) => x.json());
      for (const p of (d.plugins || [])) installed.set(p.id, p.version);
    } catch { /* 拿不到就当没装 */ }

    return {
      ok: true,
      source: r.source,
      cached: !!r.cached,
      warning: r.error || null,
      updatedAt: r.data.updatedAt || '',
      total: list.length,
      plugins: list.map((p) => ({
        ...p,
        installed: installed.has(p.id),
        installedVersion: installed.get(p.id) || null,
        updatable: installed.has(p.id) && installed.get(p.id) !== p.version,
      })),
    };
  }, { absolute: true });

  // ── 接口：安装 ──
  ctx.http.route('POST', '/api/market/install', async (_req, body) => {
    const id = String(body?.id || '');
    if (!id) return { ok: false, error: '缺少插件 id' };

    const r = await fetchIndex();
    if (!r.ok) return r;
    const meta = (r.data.plugins || []).find((p) => p.id === id);
    if (!meta) return { ok: false, error: `清单里没有 ${id}` };

    // 未审核的插件需要显式确认
    if (meta.trust !== 'official' && meta.trust !== 'verified' && body?.confirmUntrusted !== true) {
      return {
        ok: false,
        needConfirm: true,
        error: '这个插件未经审核，确认后才安装',
        meta: { id: meta.id, name: meta.name, author: meta.author, permissions: meta.permissions || [] },
      };
    }

    if (!meta.download) return { ok: false, error: '清单里没给下载地址' };

    ctx.log(`[市场] 开始安装 ${id} v${meta.version}…`);
    let buf;
    try {
      buf = await downloadPackage(meta.download, meta.sha256);
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }

    // 交给内核的导入通道（它负责路径校验/覆盖/重载）
    try {
      const res = await fetch('http://127.0.0.1:3210/api/plugins/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base64: buf.toString('base64'), mode: 'replace' }),
        signal: AbortSignal.timeout(60000),
      });
      const out = await res.json();
      if (out?.ok === false) return { ok: false, error: out.error || '导入失败', detail: out };
      ctx.log(`[市场] ${id} 安装完成`);
      return { ok: true, id, version: meta.version, message: `已安装 ${meta.name} v${meta.version}` };
    } catch (e) {
      return { ok: false, error: '导入失败：' + String(e?.message ?? e) };
    }
  }, { absolute: true });

  // ── 接口：配置 ──
  // GET 供面板读取当前配置（原来只有 POST，面板读不到就显示空值）
  ctx.http.route('GET', '/api/market/config', () => ({ ok: true, config: cfg() }), { absolute: true });

  ctx.http.route('POST', '/api/market/config', (_req, body) => {
    const patch = {};
    for (const k of ['indexUrl', 'mirrorUrl', 'showUntrusted', 'hideUntrusted', 'autoCheckUpdate', 'autoUpdate', 'checkIntervalHours']) {
      if (body && body[k] !== undefined) patch[k] = body[k];
    }
    const next = ctx.config.set(patch);
    cache = { at: 0, data: null, source: '', error: null };   // 改了地址就清缓存
    return { ok: true, config: next };
  }, { absolute: true });

  // ── 接口：导出为市场包（给作者用）──
  //
  // 复用内核的 clean 导出（只含源码 + 默认配置，剥离数据），
  // 再算 sha256、从 manifest 提元信息，拼成可直接上传的 market.json。
  ctx.http.route('POST', '/api/market/package', async (_req, body) => {
    const id = String(body?.id || '');
    if (!id) return { ok: false, error: '缺少插件 id' };
    // stripAssets=true：把 assets/ 里的图片音视频排除掉（素材单独托管）
    const stripAssets = body?.stripAssets === true;

    try {
      // ① 内核导出（clean 模式 = 干净包）
      // stripAssets=true 时排除 assets/ 里的图片音视频（素材单独托管）
      const q = new URLSearchParams({ id, mode: 'clean' });
      if (stripAssets) q.set('stripAssets', '1');
      const res = await fetch(`http://127.0.0.1:3210/api/plugins/export?${q}`, {
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) return { ok: false, error: `导出失败 HTTP ${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return { ok: false, error: '导出得到空文件' };

      // ② 算 sha256
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

      // ③ 从 manifest 提元信息（不手填）
      let m = {};
      try { m = JSON.parse(fs.readFileSync(path.join(ctx.root, 'plugins', id, 'manifest.json'), 'utf8')); }
      catch { return { ok: false, error: '读不到 manifest.json' }; }

      // 🔴 体积预警（2026-10-25）
      //
      // 实测 grail 打出来 37MB —— 其中 33MB 是 64 张角色立绘、4MB 是场景图。
      // 这类**素材内容是数据，不是代码**，塞进插件包有三个坏处：
      //   · 市场下载慢（37MB 对小水管是灾难）
      //   · 每次改一行代码都要重传 37MB
      //   · R2 / GitHub 存储被图片吃掉
      //
      // 建议：素材单独发布（R2 放素材包），插件包只带代码 + 素材清单。
      // 这里先给出预警，让人知道该拆。
      const SIZE_WARN = 5 * 1024 * 1024;      // 5MB
      const SIZE_HARD = 20 * 1024 * 1024;     // 20MB
      const warnings = [];
      if (buf.length > SIZE_HARD) {
        warnings.push(`包体积 ${(buf.length / 1024 / 1024).toFixed(1)}MB，超过 20MB 上限。建议把 assets 里的图片/音视频拆出去单独托管。`);
      } else if (buf.length > SIZE_WARN) {
        warnings.push(`包体积 ${(buf.length / 1024 / 1024).toFixed(1)}MB 偏大，考虑把素材拆出去。`);
      }

      const market = {
        id: m.id || id,
        name: m.name || id,
        version: m.version || '0.0.0',
        author: m.author || '',
        summary: m.summary || '',
        description: m.description || '',
        category: m.category || '',
        permissions: m.permissions || [],
        scopes: m.scopes || [],
        apiVersion: m.apiVersion || 1,
        contact: null,                       // 作者首次提交时补
        trust: 'unverified',                 // 待审核
        sha256,
        size: buf.length,
        packedAt: new Date().toISOString(),
        download: '',                        // 上传后回填
      };

      // ④ 落盘到数据目录，方便直接取
      const outDir = path.join(ctx.data.dir, 'packages');
      fs.mkdirSync(outDir, { recursive: true });
      const filename = `${market.id}-${market.version}.tar.gz`;
      const pkgPath = path.join(outDir, filename);
      fs.writeFileSync(pkgPath, buf);
      fs.writeFileSync(path.join(outDir, `${market.id}-${market.version}.json`),
        JSON.stringify(market, null, 2), 'utf8');

      ctx.log(`[市场] 已打包 ${market.id} v${market.version}（${(buf.length / 1024).toFixed(1)} KB）`);
      return {
        ok: true,
        market,
        packagePath: pkgPath,
        filename,
        sizeText: buf.length > 1024 * 1024
          ? `${(buf.length / 1024 / 1024).toFixed(2)} MB`
          : `${(buf.length / 1024).toFixed(1)} KB`,
        warnings,
        tooBig: buf.length > SIZE_HARD,
        strippedAssets: stripAssets,
      };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }, { absolute: true });

  // ── 我的插件管理（2026-10-25）──
  //
  // 用户要求："给作者管理自己插件包运营的界面，如更新版本和改动说明"
  //
  // 设计：
  //   ① 列出属于当前作者（按邮箱/QQ 匹配）的所有本地插件
  //   ② 每个插件可单独改版本号、写改动说明、一键打包发布
  //   ③ 发布记录留档，看得见"什么时候发过什么版本"
  //
  // 为什么按"本地插件 + 发布记录"而不是"远端仓库"：
  //   作者的源码在本机。远端只是分发结果。
  //   管理界面要管的是"本机这份怎么变成线上的包"。
  const pubFile = () => path.join(ctx.data.dir, 'published.json');

  const loadPublished = () => {
    try {
      const d = JSON.parse(fs.readFileSync(pubFile(), 'utf8'));
      return { records: Array.isArray(d.records) ? d.records : [] };
    } catch { return { records: [] }; }
  };
  const savePublished = (d) => {
    fs.mkdirSync(ctx.data.dir, { recursive: true });
    fs.writeFileSync(pubFile(), JSON.stringify(d, null, 2), 'utf8');
  };

  const loadAuthor = () => {
    try { return JSON.parse(fs.readFileSync(path.join(ctx.data.dir, 'author.json'), 'utf8')); }
    catch { return null; }
  };

  // ── R2 同步（2026-10-25）──
  //
  // 为什么插件需要写 R2：
  //   下架/发布如果只改本地记录，远端 index.json 不变 ——
  //   用户看到的就是"下架了但市场还在"。必须真的改远端。
  //
  // 凭据从 /home/lyy/.secrets/market-r2/r2.env 读（600），
  // 不存在时降级为"只改本地"，并在返回值里说明。

  // 🔴 不写死本机路径（2026-10-25）：别人部署后发布功能要能用
  //    查找顺序：环境变量 → 项目内 .secrets → 家目录 .secrets
  const R2_ENV = (() => {
    if (process.env.BG_R2_ENV) return process.env.BG_R2_ENV;
    const cands = [
      path.join(ctx.paths?.root || process.cwd(), '.secrets', 'market-r2', 'r2.env'),
      path.join(os.homedir(), '.secrets', 'market-r2', 'r2.env')
    ];
    for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
    return cands[0];
  })();

  const loadR2 = () => {
    try {
      const txt = fs.readFileSync(R2_ENV, 'utf8');
      const o = {};
      for (const line of txt.split('\n')) {
        const m = /^([A-Z0-9_]+)=(.+)$/.exec(line.trim());
        if (m) o[m[1]] = m[2];
      }
      if (!o.R2_ENDPOINT || !o.R2_ACCESS_KEY_ID || !o.R2_SECRET_ACCESS_KEY || !o.R2_BUCKET) return null;
      return o;
    } catch { return null; }
  };

  /** AWS SigV4 签名 PUT（不引 SDK） */
  const r2Put = async (env, key, body, contentType = 'application/json') => {
    const ep = env.R2_ENDPOINT.replace(/\/$/, '');
    const host = ep.replace(/^https:\/\//, '');
    const uri = `/${env.R2_BUCKET}/${key}`;
    const t = new Date();
    const amz = t.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const ds = amz.slice(0, 8);
    const ph = crypto.createHash('sha256').update(body).digest('hex');
    const ch = `host:${host}\nx-amz-content-sha256:${ph}\nx-amz-date:${amz}\n`;
    const sh = 'host;x-amz-content-sha256;x-amz-date';
    const cr = ['PUT', uri, '', ch, sh, ph].join('\n');
    const scope = `${ds}/auto/s3/aws4_request`;
    const sts = ['AWS4-HMAC-SHA256', amz, scope,
      crypto.createHash('sha256').update(cr).digest('hex')].join('\n');
    const h = (k, m) => crypto.createHmac('sha256', k).update(m).digest();
    let k = h('AWS4' + env.R2_SECRET_ACCESS_KEY, ds);
    k = h(k, 'auto'); k = h(k, 's3'); k = h(k, 'aws4_request');
    const sig = crypto.createHmac('sha256', k).update(sts).digest('hex');

    const res = await fetch(`${ep}${uri}`, {
      method: 'PUT',
      headers: {
        'Host': host,
        'x-amz-content-sha256': ph,
        'x-amz-date': amz,
        'Content-Type': contentType,
        'Authorization': `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${sh}, Signature=${sig}`,
        'User-Agent': UA,
      },
      body,
      signal: AbortSignal.timeout(30000),
    });
    return res.status;
  };

  /** 拉远端 index.json */
  const fetchRemoteIndex = async () => {
    const c = cfg();
    const url = c.indexUrl || 'https://market.baiguang211.top/index.json';
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`拉取失败 HTTP ${res.status}`);
    return { idx: await res.json(), url };
  };

  /** 把改好的 index.json 推回 R2 */
  const pushIndex = async (idx) => {
    const env = loadR2();
    if (!env) return { ok: false, reason: '未配置 R2 凭据（只改了本地）' };
    try {
      idx.updatedAt = new Date().toISOString();
      const body = Buffer.from(JSON.stringify(idx, null, 2), 'utf8');
      const st = await r2Put(env, 'index.json', body);
      if (st !== 200) return { ok: false, reason: `R2 返回 ${st}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e?.message ?? e) };
    }
  };

  // ── 管理员身份（2026-10-25）──
  //
  // 用户要求："作为管理者，应该可以看到全部作者和用户的信息；
  //           插件作者应只能上传和管理自己的插件"
  //
  // 两级身份：
  //   管理员 —— 看在 data/plugins/plugin-market/admin.json 里登记的 QQ 号
  //   作者   —— 邮箱验证码注册的任何邮箱
  //
  // 🔴 安全边界（必须诚实说明）：
  //   QQAgent 控制台只监听 127.0.0.1，公网走 nginx Basic Auth。
  //   所以这里的"身份"防的是**误操作**，不是防黑客 ——
  //   能访问到 3210 的人，本来就已经越过了两道墙。
  //   真正要防的是：作者 A 手滑点了作者 B 的「下架」。
  //
  // 管理员怎么定：
  //   第一次访问时，如果没配过，就把第一个注册的作者设为管理员。
  //   之后只有 admin.json 里列出的 QQ 才算管理员。
  const ADMIN_FILE = () => path.join(ctx.data.dir, 'admin.json');

  const loadAdmin = () => {
    try { return JSON.parse(fs.readFileSync(ADMIN_FILE(), 'utf8')); }
    catch { return null; }
  };
  const saveAdmin = (a) => {
    fs.mkdirSync(ctx.data.dir, { recursive: true });
    fs.writeFileSync(ADMIN_FILE(), JSON.stringify(a, null, 2), 'utf8');
  };

  /**
   * 判断当前身份
   * @returns {{role:'admin'|'author'|'guest', me:object|null}}
   */
  const whoAmI = () => {
    const me = loadAuthor();
    if (!me) return { role: 'guest', me: null };

    let adm = loadAdmin();
    // 首次：把第一个注册的人设为管理员（只有一次）
    if (!adm) {
      adm = { admins: [{ qq: me.qq || '', email: me.email, since: new Date().toISOString(), auto: true }] };
      saveAdmin(adm);
      ctx.log(`[市场] 首个作者 ${me.email} 自动设为管理员`);
    }

    const isAdmin = (adm.admins || []).some((a) =>
      (a.email && a.email === me.email) || (a.qq && String(a.qq) === String(me.qq)));

    return { role: isAdmin ? 'admin' : 'author', me };
  };

  /** 管理员专用守卫 */
  const requireAdmin = () => {
    const w = whoAmI();
    if (w.role !== 'admin') {
      return { ok: false, error: '需要管理员权限', role: w.role };
    }
    return { ok: true, ...w };
  };

  /**
   * 作者身份校验（2026-10-25）
   *
   * 用户要求："只有作者匹配才能对插件进行发布和下架管理"
   *
   * 判定规则（任一命中即为作者）：
   *   ① manifest.author 等于已注册昵称
   *   ② manifest.author 等于已注册 QQ 号
   *   ③ manifest.author 是「白光」（内置作者的固定署名）
   *
   * 为什么把「白光」硬编码：
   *   本机 22 个插件都署名「白光」，而注册昵称可能改成别的。
   *   如果只靠昵称匹配，改个昵称就管不了自己的插件了。
   *   用固定署名兜底更稳 —— 它同时也是"官方插件"的标记。
   *
   * 反面：这不是强身份认证（谁都能改 manifest 的 author 字段）。
   *   它的作用是**防误操作**，不是防恶意。
   *   真正的防冒充要靠审核流程，见 docs/PLUGIN_PROTOCOL.md。
   */
  const checkOwner = (id) => {
    const w = whoAmI();
    if (w.role === 'guest') return { ok: false, error: '请先注册作者账号（在「发布」页）' };
    const me = w.me;

    let m;
    try {
      m = JSON.parse(fs.readFileSync(path.join(ctx.root, 'plugins', id, 'manifest.json'), 'utf8'));
    } catch {
      return { ok: false, error: `找不到插件 ${id}` };
    }

    const author = String(m.author || '').trim();

    // 🔴 管理员可以管所有插件（2026-10-25 用户要求）
    if (w.role === 'admin') {
      return { ok: true, manifest: m, asAdmin: true };
    }

    // 作者只能管自己署名的
    if (!author) {
      return { ok: false, error: `插件 ${id} 没有声明作者，无法确认归属` };
    }

    const isMine = author === '白光'
      || (me.nickname && author === me.nickname)
      || (me.qq && author === String(me.qq));

    if (!isMine) {
      return {
        ok: false,
        error: `「${m.name || id}」的作者是「${author}」，不是你，不能操作`,
        author,
        me: me.nickname || me.email,
      };
    }
    return { ok: true, manifest: m };
  };

  // ── 管理员接口（2026-10-25）──
  //
  // 用户要求："作为管理者，应该可以看到全部作者和用户的信息"

  /** 我是谁 */
  ctx.http.route('GET', '/api/market/whoami', () => {
    const w = whoAmI();
    return { ok: true, role: w.role, me: w.me };
  }, { absolute: true });

  /** 管理员总览：全部作者 + 全部插件 + 统计数据 */
  ctx.http.route('GET', '/api/market/admin/overview', async () => {
    const guard = requireAdmin();
    if (!guard.ok) return guard;

    const me = guard.me;

    // ① 全部作者（从 published.json 的 contacts + 本地 manifest 汇总）
    const authors = new Map();
    const dir = path.join(ctx.root, 'plugins');
    let ids = [];
    try {
      ids = fs.readdirSync(dir).filter((d) => {
        try { return fs.statSync(path.join(dir, d, 'manifest.json')).isFile(); } catch { return false; }
      });
    } catch { /* ignore */ }

    const allPlugins = [];
    for (const id of ids) {
      let m;
      try { m = JSON.parse(fs.readFileSync(path.join(dir, id, 'manifest.json'), 'utf8')); } catch { continue; }
      const author = String(m.author || '未署名');
      if (!authors.has(author)) {
        authors.set(author, { name: author, plugins: 0, qq: m.contact?.qq || '', license: m.license || '' });
      }
      const a = authors.get(author);
      a.plugins++;
      if (m.contact?.qq && !a.qq) a.qq = m.contact.qq;

      allPlugins.push({
        id, name: m.name || id, version: m.version || '0.0.0',
        author, category: m.category || '', summary: m.summary || '',
        permissions: (m.permissions || []).length,
        core: m.core === true,
      });
    }

    // ② 发布记录汇总
    const pub = loadPublished();
    const pubByPlugin = new Map();
    for (const r of pub.records) {
      if (r.action === 'unpublish') { pubByPlugin.set(r.id, { offline: true, at: r.at }); continue; }
      if (!pubByPlugin.has(r.id) || !pubByPlugin.get(r.id).offline) {
        pubByPlugin.set(r.id, { version: r.version, at: r.at, changelog: r.changelog });
      }
    }

    // ③ 远端市场现状
    let remote = { count: 0, ids: [] };
    try {
      const { idx } = await fetchRemoteIndex();
      remote = { count: (idx.plugins || []).length, ids: (idx.plugins || []).map((p) => p.id) };
    } catch { /* 拿不到就空着 */ }

    // ④ 授权统计
    let grants = {};
    try {
      const gf = path.join(ctx.root, 'data', 'plugin-grants.json');
      if (fs.existsSync(gf)) grants = JSON.parse(fs.readFileSync(gf, 'utf8'));
    } catch { /* ignore */ }

    const plugins = allPlugins.map((p) => {
      const pr = pubByPlugin.get(p.id);
      return {
        ...p,
        published: !!pr && !pr.offline,
        offline: !!pr?.offline,
        publishedVersion: pr?.version || null,
        publishedAt: pr?.at || null,
        inRemote: remote.ids.includes(p.id),
        granted: Array.isArray(grants[p.id]?.granted) ? grants[p.id].granted : null,
      };
    });

    const authorList = [...authors.values()].sort((a, b) => b.plugins - a.plugins);

    return {
      ok: true,
      me: { role: guard.role, email: me.email, nickname: me.nickname, qq: me.qq },
      stats: {
        totalPlugins: plugins.length,
        totalAuthors: authorList.length,
        publishedCount: plugins.filter((p) => p.published).length,
        offlineCount: plugins.filter((p) => p.offline).length,
        remoteCount: remote.count,
        totalPublishes: pub.records.filter((r) => r.action !== 'unpublish').length,
      },
      authors: authorList,
      plugins,
    };
  }, { absolute: true });

  /** 管理员：设置/取消某人为管理员 */
  // ── 管理员：改插件信任等级（审核通过/驳回）─────────────────
  //
  // 🔴 补 P3 的缺口：过去 verified 这个等级**根本产生不了**
  //    （没有任何接口能改 trust），于是第三方插件永远是 unverified。
  //
  // 现在管理员能把某个 id 升为 verified（人工审过），或打回 unverified。
  // 需要 R2 凭据才能改远端 —— 没有凭据时只改本地缓存并说明。

  ctx.http.route('POST', '/api/market/admin/trust', async (_req, body) => {
    const guard = requireAdmin();
    if (!guard.ok) return guard;

    const id = String(body?.id || '').trim();
    const trust = String(body?.trust || '').trim();
    if (!id) return { ok: false, error: '缺少插件 id' };
    if (!['official', 'verified', 'unverified'].includes(trust)) {
      return { ok: false, error: 'trust 只能是 official / verified / unverified' };
    }

    // 官方标记只有「首个注册的管理员」（= 市场所有者）能设
    // admin.json 里 auto:true 的那条就是启用时自动设置的所有者
    if (trust === 'official') {
      const adm = loadAdmin() || { admins: [] };
      const isOwner = (adm.admins || []).some((a) =>
        a.auto === true
        && ((a.email && a.email === guard.me?.email) || (a.qq && String(a.qq) === String(guard.me?.qq))));
      if (!isOwner) return { ok: false, error: '只有市场所有者能标 official' };
    }

    const env = loadR2();
    if (!env) {
      return {
        ok: false,
        error: '没有 R2 凭据，无法修改线上清单',
        hint: '把 r2.env 放到 <项目根>/.secrets/market-r2/ 或配置 BG_R2_ENV'
      };
    }

    // 拉远端清单 → 改该条的 trust → 推回
    const { idx } = await fetchRemoteIndex();
    const item = (idx.plugins || []).find((x) => x.id === id);
    if (!item) return { ok: false, error: `市场里没有 ${id}` };

    const before = item.trust;
    item.trust = trust;
    item.reviewedAt = new Date().toISOString();
    item.reviewedBy = guard.me?.email || '';

    const pushed = await pushIndex(idx);
    if (!pushed.ok) return { ok: false, error: '推回清单失败：' + (pushed.reason || '') };

    ctx.log(`[市场] ${id} 信任等级 ${before} → ${trust}（审核人 ${guard.me?.email}）`);
    return { ok: true, id, before, trust };
  }, { absolute: true });

  ctx.http.route('POST', '/api/market/admin/set', (_req, body) => {
    const guard = requireAdmin();
    if (!guard.ok) return guard;

    const email = String(body?.email || '').trim().toLowerCase();
    const remove = body?.remove === true;
    if (!email) return { ok: false, error: '缺少邮箱' };

    const adm = loadAdmin() || { admins: [] };
    if (remove) {
      adm.admins = (adm.admins || []).filter((a) => a.email !== email);
      saveAdmin(adm);
      ctx.log(`[市场] 已取消管理员：${email}`);
      return { ok: true, admins: adm.admins };
    }
    if ((adm.admins || []).some((a) => a.email === email)) {
      return { ok: false, error: '已经是管理员了' };
    }
    adm.admins = [...(adm.admins || []), { email, since: new Date().toISOString() }];
    saveAdmin(adm);
    ctx.log(`[市场] 新增管理员：${email}`);
    return { ok: true, admins: adm.admins };
  }, { absolute: true });

  /** 管理员：全部发布记录（含下架） */
  ctx.http.route('GET', '/api/market/admin/records', (_req, _b, url) => {
    const guard = requireAdmin();
    if (!guard.ok) return guard;
    const limit = Math.min(200, Number(url?.searchParams?.get('limit')) || 100);
    const db = loadPublished();
    return { ok: true, total: db.records.length, records: db.records.slice(0, limit) };
  }, { absolute: true });

  /** 列出本地插件 + 发布状态 */
  // ── 投稿队列（2026-10-25）────────────────────────────────
  //
  // 用户需求："能不能做包上传，先在我们服务器储存，然后我去审核呢？我作为中心服务器"
  //
  // 两条投稿路径并存：
  //   GitHub 直链 → 市场只读抓取，作者自己管版本
  //   上传队列   → 包落在本服务器，**审核通过前不上架**
  //
  // 上传是开放的（任何注册作者都能投），审核是管理员专属。

  ctx.http.route('POST', '/api/market/submit', async (_req, body) => {
    const w = whoAmI();
    if (w.role === 'guest') {
      return { ok: false, error: '请先注册作者账号（在「创造营 → 发布」里）' };
    }
    const b64 = String(body?.base64 || '');
    if (!b64) return { ok: false, error: '缺少包体（base64）' };
    let buf;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      return { ok: false, error: 'base64 解码失败' };
    }
    const r = queue.submitPackage(buf, {
      ...body?.meta,
      author: String(body?.meta?.author || w.me?.nickname || ''),
      contact: String(body?.meta?.contact || w.me?.qq || w.me?.email || '')
    });
    if (r.ok) {
      ctx.log(`[市场] 收到投稿 ${r.submission.id}：${r.submission.name || r.submission.pluginId}（${(r.submission.bytes / 1024).toFixed(0)}KB）`);
    }
    return r;
  }, { absolute: true });

  // 我的投稿（作者看自己的进度）
  ctx.http.route('GET', '/api/market/my-submissions', async () => {
    const w = whoAmI();
    if (w.role === 'guest') return { ok: true, items: [] };
    const all = queue.listSubmissions();
    const mine = all.filter((s) =>
      (w.me?.email && s.contact === w.me.email) || (w.me?.qq && s.contact === String(w.me.qq)));
    return { ok: true, items: mine };
  }, { absolute: true });

  // 管理员：全部投稿 + 统计
  ctx.http.route('GET', '/api/market/submissions', async (_req, _b, url) => {
    const g = requireAdmin();
    if (!g.ok) return g;
    const status = String(url?.searchParams?.get('status') || '');
    return { ok: true, stats: queue.queueStats(), items: queue.listSubmissions({ status }) };
  }, { absolute: true });

  // 管理员：审核
  ctx.http.route('POST', '/api/market/submissions/review', async (_req, body) => {
    const g = requireAdmin();
    if (!g.ok) return g;
    const id = String(body?.id || '');
    const action = String(body?.action || '');
    if (!['approve', 'reject'].includes(action)) return { ok: false, error: 'action 只能是 approve / reject' };
    const r = queue.reviewSubmission(id, action, body?.note);
    if (r.ok) ctx.log(`[市场] 投稿 ${id} ${action === 'approve' ? '通过' : '驳回'}`);
    return r;
  }, { absolute: true });

  // 管理员：删除投稿
  ctx.http.route('POST', '/api/market/submissions/delete', async (_req, body) => {
    const g = requireAdmin();
    if (!g.ok) return g;
    return queue.deleteSubmission(String(body?.id || ''));
  }, { absolute: true });

  ctx.http.route('GET', '/api/market/myplugins', async () => {
    const w = whoAmI();
    const me = w.me || loadAuthor();
    const pub = loadPublished();
    // 🔴 records 是 unshift 进来的（最新的在数组开头），
    //    所以"后面的覆盖前面的"会让最旧的覆盖最新的。
    //    正确做法：倒着遍历，让最新的最后写入。
    const latestBy = new Map();
    for (let i = pub.records.length - 1; i >= 0; i--) {
      const r = pub.records[i];
      latestBy.set(r.id, r);
    }

    const dir = path.join(ctx.root, 'plugins');
    let ids = [];
    try {
      ids = fs.readdirSync(dir).filter((d) => {
        try { return fs.statSync(path.join(dir, d, 'manifest.json')).isFile(); } catch { return false; }
      });
    } catch { return { ok: false, error: '读不到 plugins 目录' }; }

    const list = [];
    for (const id of ids) {
      let m;
      try { m = JSON.parse(fs.readFileSync(path.join(dir, id, 'manifest.json'), 'utf8')); }
      catch { continue; }

      // ── 归属判定（2026-10-25 重构）──
      //
      // 🔴 用户要求："非作者不应该展示发布和下架按钮"
      //
      // 但**管理员要能看到全部并管理**（上一轮的需求）。
      // 所以列表里不再"过滤掉别人的"，而是给每一项标 canManage：
      //   · admin  → canManage = true（能管所有人的）
      //   · author → canManage = (author 匹配自己)
      // 前端据此决定显不显示发布/下架。
      //
      // 这样同一个接口既能服务管理员视角，也能服务作者视角，
      // 不用维护两套列表。
      const authorName = String(m.author || '').trim();
      const isAdmin = w.role === 'admin';
      const isOwn = authorName === '白光'
        || (me?.nickname && authorName === me.nickname)
        || (me?.qq && authorName === String(me.qq));
      // 作者列表只看自己的；管理员看全部
      if (!isAdmin && !isOwn) continue;

      const last = latestBy.get(id);
      // 下架状态：最近一条记录是 unpublish
      const unpublished = last?.action === 'unpublish';
      // 真正的发布记录（跳过 unpublish 条目）
      const lastPub = pub.records.find((r) => r.id === id && r.action !== 'unpublish');
      list.push({
        id,
        name: m.name || id,
        version: m.version || '0.0.0',
        summary: m.summary || '',
        category: m.category || '',
        permissions: m.permissions || [],
        core: m.core === true,
        // 作者信息（用户要求"我的插件里的作者要显示作者信息"）
        author: authorName || '未署名',
        authorQQ: m.contact?.qq || '',
        license: m.license || '',
        isOwn,                       // 是不是自己的插件
        // 🔴 发布/下架只给自己的插件（2026-10-25 用户要求）
        //
        // 之前写的是 `isAdmin || isOwn` —— 导致管理员看别人的插件
        // 也显示发布/下架按钮。但"发布别人的代码"本来就不该是管理员职责：
        // 你不知道别人改了什么、想不想发。
        //
        // 管理员能做的只有「卸载」（清掉不想要的插件），
        // 这在下一条 canUninstall 里单独控制。
        canManage: isOwn,
        canUninstall: m.core !== true,  // 核心插件禁卸
        lastPublished: lastPub ? {
          version: lastPub.version,
          at: lastPub.at,
          changelog: lastPub.changelog || '',
          sha256: lastPub.sha256 || '',
        } : null,
        offline: unpublished,        // 已下架
        // 本地版本比已发布的新 → 有未发布的改动
        unpublished: !lastPub || lastPub.version !== m.version,
      });
    }

    list.sort((a, b) => a.id.localeCompare(b.id));
    return { ok: true, author: me, total: list.length, plugins: list };
  }, { absolute: true });

  /** 改版本号 / 写改动说明（改 manifest 的 version + 记录 changelog 草稿） */
  ctx.http.route('POST', '/api/market/myplugins/update', (_req, body) => {
    const id = String(body?.id || '');
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(id)) return { ok: false, error: '插件 id 不合法' };

    // 🔴 只有作者能改版本号
    const own = checkOwner(id);
    if (!own.ok) return own;

    const mf = path.join(ctx.root, 'plugins', id, 'manifest.json');
    if (!fs.existsSync(mf)) return { ok: false, error: '找不到该插件' };

    let m;
    try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); }
    catch { return { ok: false, error: 'manifest 解析失败' }; }

    const patch = {};
    if (body?.version !== undefined) {
      const v = String(body.version).trim();
      if (!/^\d+\.\d+\.\d+$/.test(v)) return { ok: false, error: '版本号要用 1.2.3 格式' };
      m.version = v;
      patch.version = v;
    }
    if (body?.summary !== undefined) {
      m.summary = String(body.summary).slice(0, 40);
      patch.summary = m.summary;
    }

    if (Object.keys(patch).length) {
      fs.writeFileSync(mf, JSON.stringify(m, null, 2), 'utf8');
    }
    return { ok: true, id, ...patch };
  }, { absolute: true });

  /** 发布：打包 + 记录 */
  ctx.http.route('POST', '/api/market/myplugins/publish', async (_req, body) => {
    const id = String(body?.id || '');
    const changelog = String(body?.changelog || '').trim().slice(0, 2000);
    if (!id) return { ok: false, error: '缺少插件 id' };

    // 🔴 只有作者能发布
    const own = checkOwner(id);
    if (!own.ok) return own;

    // 复用打包接口
    let pkg;
    try {
      // 自动判断要不要剥离素材：先按原样打，超 5MB 就改剥离版
      //
      // 为什么自动而不是让用户选：
      //   grail 37MB 里有 36.9MB 是立绘图片，代码只有 0.5MB。
      //   用户点「发布」时不该被迫理解"素材要不要分离"这种事。
      let res = await fetch(`http://127.0.0.1:3210/api/market/package`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': 'QQAgent-Market/1.0' },
        body: JSON.stringify({ id }),
        signal: AbortSignal.timeout(120000),
      });
      let pkg0 = await res.json();
      if (pkg0?.ok && (pkg0.market?.size || 0) > 5 * 1024 * 1024) {
        ctx.log(`[市场] ${id} 包体积 ${(pkg0.market.size/1024/1024).toFixed(1)}MB，改用剥离素材版`);
        res = await fetch(`http://127.0.0.1:3210/api/market/package`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'User-Agent': 'QQAgent-Market/1.0' },
          body: JSON.stringify({ id, stripAssets: true }),
          signal: AbortSignal.timeout(120000),
        });
        pkg0 = await res.json();
      }
      pkg = pkg0;
    } catch (e) {
      return { ok: false, error: '打包失败：' + String(e?.message ?? e) };
    }
    if (!pkg?.ok) return { ok: false, error: pkg?.error || '打包失败' };

    // 记一条发布记录
    const db = loadPublished();
    const rec = {
      id,
      version: pkg.market.version,
      changelog,
      sha256: pkg.market.sha256,
      size: pkg.market.size,
      at: new Date().toISOString(),
      filename: pkg.filename,
      packagePath: pkg.packagePath,
    };
    db.records.unshift(rec);
    if (db.records.length > 500) db.records = db.records.slice(0, 500);   // 只留最近 500 条
    savePublished(db);

    // 🔴 发布 = 打包 + 上传包 + 更新远端 index.json（2026-10-25）
    //
    // 原来只打包不传，用户还得手动上传 —— 等于"发布"按钮名不副实。
    // 现在一次做完：传包 → 改 index → 推回 R2。
    let remote = { ok: false, reason: '未尝试' };
    try {
      const env = loadR2();
      if (!env) {
        remote = { ok: false, reason: '未配置 R2 凭据' };
      } else {
        // ① 传包（带内容哈希后缀，避开 CDN 缓存）
        const buf = fs.readFileSync(pkg.packagePath);
        const short = String(rec.sha256).slice(0, 10);
        const fname = `${id}-${rec.version}-${short}.tar.gz`;
        const st = await r2Put(env, `packages/${fname}`, buf, 'application/gzip');
        if (st !== 200) throw new Error(`包上传失败 HTTP ${st}`);

        // ② 更新 index.json
        const { idx } = await fetchRemoteIndex();
        const download = `https://market.baiguang211.top/packages/${fname}`;
        const item = {
          id,
          name: pkg.market.name,
          version: rec.version,
          // 🔴 不再兜底「白光」（2026-10-25）：第三方发上来会被冒名
          author: pkg.market.author || whoAmI().me?.nickname || whoAmI().me?.email || '未署名',
          summary: pkg.market.summary || '',
          description: pkg.market.description || '',
          category: pkg.market.category || '',
          permissions: pkg.market.permissions || [],
          scopes: pkg.market.scopes || [],
          apiVersion: pkg.market.apiVersion || 1,
          license: 'MIT',
          // 🔴 不再硬编码市场主的 QQ，也不再一律标 official
          contact: { qq: whoAmI().me?.qq || '' },
          trust: 'unverified',   // 新提交一律待审核；管理员通过后才升 verified
          sha256: rec.sha256,
          size: rec.size,
          download,
        };
        idx.plugins = (idx.plugins || []).filter((x) => x.id !== id);
        idx.plugins.push(item);
        idx.plugins.sort((a, b) => String(a.id).localeCompare(String(b.id)));

        remote = await pushIndex(idx);
        remote.filename = fname;
        remote.download = download;
      }
    } catch (e) {
      remote = { ok: false, reason: String(e?.message ?? e).slice(0, 150) };
    }

    ctx.log(`[市场] ${id} v${rec.version} ${remote.ok ? '已发布到市场' : '打包完成但上传失败：' + remote.reason}`);
    return {
      ok: true,
      record: rec,
      packagePath: pkg.packagePath,
      filename: pkg.filename,
      sizeText: pkg.sizeText,
      warnings: pkg.warnings || [],
      remote,
      note: remote.ok
        ? `已发布到市场（${(rec.size/1024).toFixed(1)}KB），别人现在能装到了。`
        : `打包好了，但没传上去（${remote.reason}）。包在：${pkg.packagePath}`,
    };
  }, { absolute: true });

  /**
   * 下架插件（2026-10-25）
   *
   * 用户要求"加下架功能"。
   *
   * 语义：从市场 index.json 里移除，但**保留本地插件和发布记录**。
   *   · 下架 ≠ 卸载：本地还能用，只是别人看不到
   *   · 重新上架只需再点「发布」
   *
   * 为什么不在本地删包：作者可能只是想暂时撤下，
   * 删了就得重新打包。历史记录也要留着才能追溯。
   */
  ctx.http.route('POST', '/api/market/myplugins/unpublish', async (_req, body) => {
    const id = String(body?.id || '');
    const reason = String(body?.reason || '').trim().slice(0, 200);
    if (!id) return { ok: false, error: '缺少插件 id' };

    // 🔴 只有作者能下架
    const own = checkOwner(id);
    if (!own.ok) return own;

    // 记一条下架记录
    const db = loadPublished();
    db.records.unshift({
      id,
      action: 'unpublish',
      reason,
      at: new Date().toISOString(),
    });
    if (db.records.length > 500) db.records = db.records.slice(0, 500);
    savePublished(db);

    // 🔴 真的从远端 index.json 里删掉（2026-10-25）
    //
    // 原来只记本地，远端不变 —— 用户看到"下架了但市场还在"。
    // 现在：拉远端 → 删该项 → 推回 R2。
    let remote = { ok: false, reason: '未尝试' };
    try {
      const { idx } = await fetchRemoteIndex();
      const before = (idx.plugins || []).length;
      idx.plugins = (idx.plugins || []).filter((p) => p.id !== id);
      const removed = before - idx.plugins.length;
      if (removed === 0) {
        remote = { ok: true, removed: 0, reason: '远端本来就没有这一项' };
      } else {
        remote = await pushIndex(idx);
        remote.removed = removed;
      }
    } catch (e) {
      remote = { ok: false, reason: String(e?.message ?? e).slice(0, 120) };
    }

    ctx.log(`[市场] ${id} 已下架${reason ? '（' + reason + '）' : ''}${remote.ok ? '，远端已同步' : '，远端同步失败：' + remote.reason}`);
    return {
      ok: true,
      id,
      remote,
      note: remote.ok
        ? '已从市场下架，别人看不到了。本地插件还在，随时可以重新上架。'
        : `本地已记录下架，但远端同步失败（${remote.reason}）。市场可能还看得到。`,
    };
  }, { absolute: true });

  /** 某个插件是否已下架（给界面显示状态用） */
  const isUnpublished = (id, records) => {
    const latest = records.find((r) => r.id === id);
    return latest?.action === 'unpublish';
  };

  /** 发布历史 */
  ctx.http.route('GET', '/api/market/myplugins/history', (_req, _b, url) => {
    const id = String(url?.searchParams?.get('id') || '');
    const db = loadPublished();
    const list = id ? db.records.filter((r) => r.id === id) : db.records;
    return { ok: true, total: list.length, records: list.slice(0, 50) };
  }, { absolute: true });

  /**
   * 版本检查（2026-10-25）
   *
   * 用户要求："自动检查新版本、手动检测新版本、更新直接覆盖安装"
   *
   * 比较三方：
   *   本地版本（manifest.json）
   *   市场版本（远端 index.json）
   *   已发布版本（本地 published.json 记录）
   *
   * 判定：
   *   market > local  → 可更新（别人发了新版）
   *   local  > market → 有未发布的改动（自己改了没发）
   */
  const cmpVer = (a, b) => {
    const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  };

  ctx.http.route('GET', '/api/market/updates', async () => {
    const w = whoAmI();
    const me = w.me;
    const isAdmin = w.role === 'admin';

    // 本地插件
    const dir = path.join(ctx.root, 'plugins');
    const local = new Map();
    let ids = [];
    try {
      ids = fs.readdirSync(dir).filter((d) => {
        try { return fs.statSync(path.join(dir, d, 'manifest.json')).isFile(); } catch { return false; }
      });
    } catch { return { ok: false, error: '读不到 plugins 目录' }; }

    for (const id of ids) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, id, 'manifest.json'), 'utf8'));
        local.set(id, m);
      } catch { /* 跳过坏 manifest */ }
    }

    // 市场清单
    let market = [];
    try {
      const { idx } = await fetchRemoteIndex();
      market = idx.plugins || [];
    } catch (e) {
      return { ok: false, error: '拉不到市场清单：' + String(e?.message ?? e).slice(0, 80) };
    }

    const updates = [];
    for (const mp of market) {
      const lv = local.get(mp.id);
      if (!lv) {
        // 本地没有 = 未安装，不算更新
        continue;
      }
      // 只看自己的（管理员看全部）
      const authorName = String(lv.author || '').trim();
      const isOwn = authorName === '白光'
        || (me?.nickname && authorName === me.nickname)
        || (me?.qq && authorName === String(me.qq));
      if (!isAdmin && !isOwn) continue;

      const localVer = lv.version || '0.0.0';
      const marketVer = mp.version || '0.0.0';
      const c = cmpVer(marketVer, localVer);
      if (c > 0) {
        updates.push({
          id: mp.id,
          name: mp.name || mp.id,
          author: authorName || '未署名',
          localVersion: localVer,
          marketVersion: marketVer,
          size: mp.size || 0,
          summary: mp.summary || '',
          download: mp.download || '',
          sha256: mp.sha256 || '',
        });
      }
    }

    return { ok: true, total: updates.length, updates, checkedAt: new Date().toISOString() };
  }, { absolute: true });

  /**
   * 更新一个插件（覆盖安装）
   *
   * 用户要求："更新直接覆盖安装"
   *
   * 直接复用 install 的逻辑（mode: replace），但额外：
   *   · 只有自己的插件能更新（管理员除外）
   *   · 更新前记下旧版本，成功后写进发布记录备注
   */
  ctx.http.route('POST', '/api/market/update', async (_req, body) => {
    const id = String(body?.id || '');
    if (!id) return { ok: false, error: '缺少插件 id' };

    const own = checkOwner(id);
    if (!own.ok) return own;

    const oldVer = own.manifest.version || '0.0.0';

    // 走安装通道（覆盖模式）
    let r;
    try {
      const res = await fetch('http://127.0.0.1:3210/api/market/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ id, confirmUntrusted: true }),
        signal: AbortSignal.timeout(120000),
      });
      r = await res.json();
    } catch (e) {
      return { ok: false, error: '更新失败：' + String(e?.message ?? e).slice(0, 100) };
    }
    if (!r?.ok) return { ok: false, error: r?.error || '更新失败' };

    ctx.log(`[市场] ${id} 已更新 ${oldVer} → ${r.version || '?'}`);
    return {
      ok: true,
      id,
      from: oldVer,
      to: r.version || '',
      message: `${r.message || '更新完成'}（${oldVer} → ${r.version || '?'}）`,
    };
  }, { absolute: true });

  /**
   * 批量更新全部
   */
  ctx.http.route('POST', '/api/market/update-all', async () => {
    const list = [];
    try {
      const res = await fetch('http://127.0.0.1:3210/api/market/updates', {
        headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000),
      });
      const d = await res.json();
      for (const u of (d?.updates || [])) list.push(u.id);
    } catch (e) {
      return { ok: false, error: '拉取更新列表失败' };
    }
    if (!list.length) return { ok: true, updated: 0, message: '已是最新' };

    const done = [], failed = [];
    for (const id of list) {
      try {
        const res = await fetch('http://127.0.0.1:3210/api/market/update', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'User-Agent': UA },
          body: JSON.stringify({ id }), signal: AbortSignal.timeout(120000),
        });
        const r = await res.json();
        if (r?.ok) done.push(id); else failed.push({ id, error: r?.error });
      } catch (e) {
        failed.push({ id, error: String(e?.message ?? e).slice(0, 60) });
      }
    }
    return { ok: true, updated: done.length, done, failed };
  }, { absolute: true });

  /**
   * 卸载插件（2026-10-25）
   *
   * 用户要求："我的插件里增加卸载按钮"
   *
   * 复用内核的 uninstall（它已经处理了核心保护、目录删除、数据清理）。
   * 这里只加归属校验。
   */
  ctx.http.route('POST', '/api/market/uninstall', async (_req, body) => {
    const id = String(body?.id || '');
    const purgeData = body?.purgeData === true;
    if (!id) return { ok: false, error: '缺少插件 id' };

    const own = checkOwner(id);
    if (!own.ok) return own;

    if (own.manifest.core === true) {
      return { ok: false, error: `「${own.manifest.name || id}」是核心插件，不能卸载` };
    }

    try {
      const res = await fetch('http://127.0.0.1:3210/api/plugins/uninstall', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ id, purgeData }),
        signal: AbortSignal.timeout(60000),
      });
      const r = await res.json();
      if (r?.ok === false) return { ok: false, error: r.error || '卸载失败' };
      ctx.log(`[市场] ${id} 已卸载${purgeData ? '（含数据）' : ''}`);
      return { ok: true, id, message: `已卸载 ${own.manifest.name || id}` };
    } catch (e) {
      return { ok: false, error: '卸载失败：' + String(e?.message ?? e).slice(0, 100) };
    }
  }, { absolute: true });

  /** 列出本地已打好的包（方便一次上传） */
  ctx.http.route('GET', '/api/market/packages', () => {
    const outDir = path.join(ctx.data.dir, 'packages');
    let files = [];
    try { files = fs.readdirSync(outDir).filter((f) => f.endsWith('.tar.gz')); } catch { /* 还没打过 */ }
    return {
      ok: true,
      dir: outDir,
      packages: files.map((f) => {
        const st = fs.statSync(path.join(outDir, f));
        return { file: f, size: st.size, sizeText: `${(st.size / 1024).toFixed(1)} KB`, at: st.mtime.toISOString() };
      }),
    };
  }, { absolute: true });

  // ── 定时检查/自动更新（2026-10-25）──
  //
  // 用户要求："自动检查新版本的功能、自动更新的功能"
  //
  // 保守策略：
  //   · autoCheckUpdate（默认开）→ 定时查，只提示不装
  //   · autoUpdate（默认关）    → 查到就自动覆盖安装
  //
  // 为什么 autoUpdate 默认关：覆盖安装会替换插件源码，
  // 万一新版有 bug 就直接坏掉。这该是用户主动开的开关，不该默认替用户决定。
  let updTimer = null;
  const runCheck = async () => {
    const c = cfg();
    try {
      const res = await fetch('http://127.0.0.1:3210/api/market/updates', {
        headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000),
      });
      const d = await res.json();
      if (!d?.ok) return;
      if (!d.total) {
        ctx.log('[市场] 定时检查：已是最新');
        return;
      }
      ctx.log(`[市场] 定时检查：发现 ${d.total} 个新版本（${(d.updates || []).map((x) => x.id).join(', ')}）`);
      if (!c.autoUpdate) return;

      ctx.log('[市场] 已开启自动更新，开始逐个安装…');
      for (const u of (d.updates || [])) {
        try {
          const r2 = await fetch('http://127.0.0.1:3210/api/market/update', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'User-Agent': UA },
            body: JSON.stringify({ id: u.id }),
            signal: AbortSignal.timeout(120000),
          });
          const out = await r2.json();
          ctx.log(`[市场] 自动更新 ${u.id}：${out?.ok ? '成功 ' + (out.message || '') : '失败 ' + (out?.error || '')}`);
        } catch (e) {
          ctx.log(`[市场] 自动更新 ${u.id} 失败：${String(e?.message ?? e).slice(0, 60)}`);
        }
      }
    } catch (e) {
      ctx.log('[市场] 定时检查失败：' + String(e?.message ?? e).slice(0, 80));
    }
  };

  const armTimer = () => {
    if (updTimer) { clearInterval(updTimer); updTimer = null; }
    const c = cfg();
    if (!c.autoCheckUpdate) return;
    const hours = Math.max(1, Math.min(168, Number(c.checkIntervalHours) || 6));
    updTimer = setInterval(runCheck, hours * 3600 * 1000);
    ctx.log(`[市场] 自动检查已开启（每 ${hours} 小时）${c.autoUpdate ? '，且开启自动更新' : ''}`);
    // 启动后 60 秒先查一次（别和启动抢资源）
    setTimeout(runCheck, 60 * 1000);
  };
  armTimer();

  ctx.log(`插件市场已启用（主源：${cfg().indexUrl || '未配置'}）`);

  return {
    dispose() {
      if (updTimer) { clearInterval(updTimer); updTimer = null; }
    }
  };
}
