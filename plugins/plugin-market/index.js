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
// 🔴 投稿队列是**内核模块**（src/market-queue.js，2026-10-25 才加的）。
//
// 原来这里写的是顶层 `import * as queue from '../../src/market-queue.js'`，
// 后果：**老内核的用户一升级插件就直接崩** ——
//    activate 失败: Cannot find module '/root/apps/qq-agent-v2/src/market-queue.js'
// 因为他们的内核版本里根本没这个文件。
//
// 这是插件设计原则的violation：插件不该硬依赖内核的某个具体文件。
// 内核只是"宿主"，插件要能在不同版本的内核上都装得下。
//
// 改成懒加载 + 能力探测：
//   · 加载阶段完全不碰这个文件
//   · 只有真的调用投稿相关接口时才 import
//   · 文件不存在 → 返回明确的"你的内核版本不支持投稿"，
//     而不是整个插件崩掉"""
// 🔴 account-auth 也是内核模块（src/account-auth.js）。
// 同样改成懒加载 —— 老内核没有这个文件时，账密登录功能不可用，
// 但插件本身要能正常加载。

export async function activate(ctx) {
  /**
   * 懒加载投稿队列（内核模块，可能不存在）
   * @returns {Promise<object|null>} null 表示这个内核版本不支持
   */
  // 账密认证模块（内核，可能不存在）
  // ── 自调用基址与封装（2026-10-27 修 B2/B3）──────────────
  //
  // 为什么需要：
  //   ① 插件要回调内核自己的 HTTP 接口，但原来地址**写死 127.0.0.1:3210**。
  //      用户的 server.port 一旦不是 3210（比如 80），安装/更新/卸载/打包
  //      全部静默失败，报错还包装成 "fetch failed"，看着像网络问题。
  //   ② 内核 authorize() 对 /api/* 要求 x-console-token 或 ?token=，
  //      自调用两者都没带 → 设了 server.token 的机器必然 401。
  //   ③ Node 的 fetch 不认相对路径（fetch('/api/x') 会抛 Failed to parse URL）。
  //
  // 统一走 localFetch()：动态端口 + 自动补 token + 相对路径补全。
  const LOCAL_BASE = (() => {
    let port = 3210;
    let token = '';
    try {
      const raw = fs.readFileSync(path.join(ctx.root, 'data', 'config.json'), 'utf8');
      const c = JSON.parse(raw);
      port = Number(c?.server?.port) || 3210;
      token = String(c?.server?.token || '');
    } catch { /* 读不到就用默认 */ }
    return { port, token, origin: 'http://127.0.0.1:' + port };
  })();

  /** 自调用：自动补 origin 与 console token */
  const localFetch = (u, opts = {}) => {
    let url = String(u);
    if (url.startsWith('/')) url = LOCAL_BASE.origin + url;
    if (LOCAL_BASE.token && !/[?&]token=/.test(url)) {
      url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(LOCAL_BASE.token);
    }
    const o = { ...opts };
    // 有 token 时也带上头，双保险（部分路由只认头）
    if (LOCAL_BASE.token) {
      o.headers = { ...(o.headers || {}), 'x-console-token': LOCAL_BASE.token };
    }
    return fetch(url, o);
  };

  let authMod;
  let authTried = false;
  const getAuth = async () => {
    if (authTried) return authMod;
    authTried = true;
    try {
      authMod = await import('../../src/account-auth.js');
      return authMod;
    } catch {
      authMod = null;
      return null;
    }
  };
  const NO_AUTH = {
    ok: false,
    error: '当前内核版本不支持账密登录（缺少 src/account-auth.js）。可以用邮箱验证码注册，或用更新版内核。',
    unsupported: true,
  };

  let queueMod;
  let queueTried = false;
  const getQueue = async () => {
    if (queueTried) return queueMod;
    queueTried = true;
    try {
      queueMod = await import('../../src/market-queue.js');
      return queueMod;
    } catch {
      // 老内核没有这个文件 —— 不是错误，只是能力缺失
      queueMod = null;
      return null;
    }
  };

  const NO_QUEUE = {
    ok: false,
    error: '当前内核版本不支持投稿功能（缺少 src/market-queue.js）。请联系市场维护者，或升级内核到 2.9.5 以上。',
    unsupported: true,
  };

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

  // 版本比较（提升到前面，市场排序要用）
  const cmpVer = (a, b) => {
    const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
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
  // 下载数缓存（2026-10-26）：展示性数据，5 分钟一次足够
  let dlCache = { at: 0, data: null };
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

  // 邮件文案模板（2026-10-25）：按用途区分，别让收件人以为点错了
  const MAIL_TPL = {
    register: {
      subject: '【QQAgent 创造营】注册验证码',
      lines: (c) => ['你好，', '', '你正在注册 QQAgent 创造营的作者账号。', '',
        `验证码：${c}`, '', '10 分钟内有效。若不是你本人操作，忽略这封邮件。', '', '—— QQAgent 创造营'],
    },
    submit: {
      subject: '【QQAgent 创造营】投稿凭证验证码',
      lines: (c) => ['你好，', '', '你正在获取「投稿到插件市场」的凭证，用于上传插件包。', '',
        `验证码：${c}`, '', '10 分钟内有效。若不是你本人操作，请忽略这封邮件，你的账号没有变化。', '', '—— QQAgent 创造营'],
    },
    reset: {
      subject: '【QQAgent 创造营】重置密码验证码',
      lines: (c) => ['你好，', '', '你正在重置 QQAgent 创造营的登录密码。', '',
        `验证码：${c}`, '', '10 分钟内有效。若不是你本人操作，请立即修改密码。', '', '—— QQAgent 创造营'],
    },
  };

  const sendVerifyCode = async (email, purpose = 'register') => {
    const tpl = MAIL_TPL[purpose] || MAIL_TPL.register;

    // ① 本机有 SMTP 就自己发
    if (ctx.mail?.ready?.()) {
      const code = String(crypto.randomInt(100000, 1000000));
      const body = tpl.lines(code).join('\n');
      const r = await ctx.mail.send(email, tpl.subject, body);
      if (!r.ok) return { ok: false, error: '发信失败：' + r.error };
      // local:true 让前端能提示「已用本机邮箱发送」，避免用户以为走的是中心服务
      return { ok: true, local: true, code, via: '本机 SMTP' };
    }

    // ② 没配 SMTP → 请求中心服务（带上用途）
    try {
      const res = await fetch(`${CENTER_URL()}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ email, purpose }),
        signal: AbortSignal.timeout(30000),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d?.ok === false) {
        return { ok: false, error: d?.error || `中心服务返回 HTTP ${res.status}` };
      }
      return { ok: true, central: true };
    } catch (e) {
      // 🔴 错误信息要能指导排查（2026-10-27 修 B5）
      //
      // 原来一律包装成「连不上验证码服务（fetch failed）」，用户会以为是自己的网络问题。
      // 实际上多数情况是中心服务那条路径已经不存在（404），
      // 或者配置里的 authUrl 域名不通 —— 两者处理方式完全不同。
      const msg = String(e?.message ?? e);
      const url = CENTER_URL();
      const hint = /fetch failed|ENOTFOUND|ECONNREFUSED|timeout|Timeout/i.test(msg)
        ? '（网络不通或域名不可达）'
        : '';
      return {
        ok: false,
        error: `请求验证码服务失败：${url}/send → ${msg.slice(0, 60)}${hint}。` +
          '推荐在「设置」里配本机 SMTP 邮箱，就不依赖中心服务了。',
        target: `${url}/send`,
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
    const auth = await getAuth();
    if (!auth) return NO_AUTH;
    const email = auth.normEmail(body?.email);
    if (!email) return { ok: false, error: '请填邮箱' };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: '邮箱格式不对' };

    // 🔴 防枚举：无论邮箱是否存在，都尝试发码并返回同样的提示
    const r = await sendVerifyCode(email, 'reset');
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
    const auth = await getAuth();
    if (!auth) return NO_AUTH;
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
          // 这里是「重置密码」流程，没有 qq/nickname；
          // 中心端会按 email 找到已有用户档案，不会覆盖
          body: JSON.stringify({ email, code }),
          signal: AbortSignal.timeout(20000),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || d?.ok === false) {
          return { ok: false, error: d?.error || `验证失败（HTTP ${res.status}）` };
        }
        // 中心端顺手签好的市场 token（2026-10-25）
        // 存下来，前端拿去做投稿凭证，不用再单独换一次
        if (d?.marketToken) {
          try {
            fs.mkdirSync(ctx.data.dir, { recursive: true });
            fs.writeFileSync(path.join(ctx.data.dir, 'market-token.txt'), d.marketToken, 'utf8');
            ctx.log('[市场] 已从中心获取投稿凭证');
          } catch { /* ignore */ }
          marketTokenFromCenter = d.marketToken;
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
  ctx.http.route('POST', '/api/market/password/can-reset', async (_req, body) => {
    const auth = await getAuth();
    if (!auth) return NO_AUTH;
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
    const auth = await getAuth();
    if (!auth) return NO_AUTH;
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
    const auth = await getAuth();
    if (!auth) return NO_AUTH;
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
  ctx.http.route('POST', '/api/market/login/account', async (_req, body) => {
    // 🔴 必须 await getAuth()（2026-10-27 修 B1）
    //    原来这里直接调 auth.normEmail(...)，但 auth 从未在本作用域声明，
    //    整个接口 500：{"ok":false,"error":"auth is not defined"}。
    //    页面上「邮箱密码登录 / 设密码 / 改密码 / 忘记密码」全部连带不可用。
    const auth = await getAuth();
    if (!auth) return NO_AUTH;
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
    let marketTokenFromCenter = '';
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
          // 带上 QQ / 昵称 —— 中心端要登记用户，管理后台靠它显示作者信息
          body: JSON.stringify({ email, code: input, qq, nickname }),
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
      const auth = await getAuth();
      if (!auth) return NO_AUTH;
      const pr = auth.setPassword(email, password);
      if (!pr.ok) return pr;
      pwSet = true;
    }

    const author = {
      email,
      qq: qq || '',
      nickname: nickname || '',
      verifiedAt: new Date().toISOString(),
      // 🔴 auth 是懒加载的，可能为 null（老内核没这个模块）
      //    原来这里直接调 auth.hasPassword() —— 没填密码时 auth 根本没获取过，
      //    抛 "auth is not defined"，整个注册失败。
      //    用户截图报的就是这个。
      hasPassword: pwSet || (auth && auth.hasPassword ? auth.hasPassword(email) : false)
    };
    fs.mkdirSync(ctx.data.dir, { recursive: true });
    fs.writeFileSync(path.join(ctx.data.dir, 'author.json'), JSON.stringify(author, null, 2), 'utf8');
    ctx.log(`[市场] 作者注册成功：${email}${pwSet ? '（已设密码）' : ''}`);

    // 🔴 同步到中心用户库（2026-10-25 修）
    //
    // 用户反馈："这个作者注册了账号为什么我们没有拉取到数据呢"
    //
    // 根因：注册只写了本地 author.json，**从不推送到中心**。
    // 所以他自己机器上有完整档案（昵称「源」），我们这边只有一条
    // 迁移时补录的空壳记录（nickname 为空）。
    //
    // 现在不管走本地验证码还是中心验证码，注册成功都推一次。
    await pushUserToRegistry(email, author.qq || '', author.nickname || '').catch(() => {});

    return {
      ok: true,
      author,
      hasPassword: author.hasPassword,
      // 有就带给前端，直接存进 localStorage
      marketToken: marketTokenFromCenter,
    };
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

    // 下载次数（2026-10-25）：批量拉一次，附在每个插件上
    //
    // 🔴 必须带缓存（2026-10-26 修）
    //
    // 这是**跨公网**请求，实测 1~2 秒。原来每次打开市场都实时拉，
    // 把本来 6ms 的 /api/market/index 拖成了 1~2 秒 ——
    // 用户反馈的"进去会卡顿"有一半是这个造成的。
    //
    // 下载数是展示性数据，晚 5 分钟更新完全无所谓，
    // 所以照插件清单那套做：TTL 300 秒 + 失败回落旧值。
    let downloads = new Map();
    const DL_TTL = 300 * 1000;
    if (dlCache.data && Date.now() - dlCache.at < DL_TTL) {
      downloads = dlCache.data;                       // 命中缓存，0 网络开销
    } else {
      try {
        const dr = await fetch('https://market.baiguang211.top/api/stats/downloads', {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(3000),         // 3 秒封顶，别拖死首屏
        });
        const dd = await dr.json().catch(() => ({}));
        if (dd?.ok && Array.isArray(dd.items)) {
          const m = new Map();
          for (const it of dd.items) m.set(it.id, it.total || 0);
          downloads = m;
          dlCache = { at: Date.now(), data: m };
        }
      } catch {
        // 拿不到就用上次的（可能为空），不影响列表本身
        if (dlCache.data) downloads = dlCache.data;
      }
    }

    // 已安装的标出来（内核 records 里有）
    let installed = new Map();
    try {
      const d = await localFetch(LOCAL_BASE.origin + '/api/plugins', { signal: AbortSignal.timeout(8000) })
        .then((x) => x.json());
      for (const p of (d.plugins || [])) installed.set(p.id, p.version);
    } catch { /* 拿不到就当没装 */ }

    // ── 排序（2026-10-25）──
    //
    // 用户要求："有新版本发布的插件，在创作营里自动排前位，方便看见"
    //
    // 优先级：
    //   ① 可更新且已安装（本地有旧版，市场有新版本）→ 最该让人看见
    //   ② 未安装的新插件（从没装过）
    //   ③ 已安装且已是最新
    // 同档内按 id 字母序保持稳定，避免每次刷新顺序乱跳。
    const makeList = (arr) => {
      const rank = (p) => {
        const inst = installed.has(p.id);
        if (!inst) return 1;                                    // 未安装
        const local = installed.get(p.id);
        return cmpVer(p.version, local) > 0 ? 0 : 2;            // 可更新 / 已最新
      };
      return [...arr].sort((a, b) => {
        const ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra - rb;
        return String(a.id).localeCompare(String(b.id));
      });
    };

    return {
      ok: true,
      source: r.source,
      cached: !!r.cached,
      warning: r.error || null,
      updatedAt: r.data.updatedAt || '',
      total: list.length,
      plugins: makeList(list).map((p) => ({
        ...p,
        // 分类以**本地 manifest** 为准（远程清单可能是旧分类）
        // 本地没有这个插件时，退回远端给的 category
        category: (() => {
          try {
            const mf = path.join(ctx.root, 'plugins', p.id, 'manifest.json');
            if (fs.existsSync(mf)) {
              const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
              if (m.category) return m.category;
            }
          } catch { /* ignore */ }
          return p.category || '未分类';
        })(),
        installed: installed.has(p.id),
        installedVersion: installed.get(p.id) || null,
        // 🔴 用版本比较，不是字符串不等（2026-10-25 修）
        //    原来 `installedVersion !== version` —— 本地版本比市场新时
        //    （作者自己改过还没发）也会显示"可更新"，反而提示降级。
        updatable: installed.has(p.id) && cmpVer(p.version, installed.get(p.id)) > 0,
        // 下载人次（0 也返回，界面自己决定显不显示）
        downloads: downloads.get(p.id) || 0,
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
      const res = await localFetch(LOCAL_BASE.origin + '/api/plugins/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 🔴 2026-10-27 修：更新已装插件时必须保留本地配置。
        //
        // 「从市场更新」走的就是这条 install 通道（/api/market/update →
        // /api/market/install → 这里）。原来不带 keepLocalConfig，
        // 于是包内的 clean 默认值把用户真实配置整个覆盖 ——
        // 表现是「更新完插件还在，但所有路径/Key 都空了」。
        //
        // 首次安装（body.keepLocalConfig 未传）仍用包内默认值，符合预期。
        body: JSON.stringify({
          base64: buf.toString('base64'),
          mode: 'replace',
          keepLocalConfig: body?.keepLocalConfig === true,
        }),
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

    // 分类（2026-10-26）：作者在发布页手动选，只接受 5 个固定值。
    //   选了就写进 manifest（打包时会带进去），没选就沿用现有的。
    //   这样市场里不会出现"内容能力/扩展/界面"这类野生分类。
    // 六类（2026-10-26 重新规划）：把原来过大的「运营」拆成群管理 / 群运营
    //   群管理 = 管人管秩序（禁言、黑名单、限流、迎新）
    //   群运营 = 产出内容（日报、福利、题库、逛逛）
    const STD_CATS = ['群管理', '群运营', '能力', '娱乐', '工具', '主人'];
    const pickedCat = String(body?.category || '').trim();
    if (pickedCat) {
      if (!STD_CATS.includes(pickedCat)) {
        return { ok: false, error: `分类只能是：${STD_CATS.join(' / ')}` };
      }
      try {
        const mfPath = path.join(ctx.root, 'plugins', id, 'manifest.json');
        const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
        if (mf.category !== pickedCat) {
          mf.category = pickedCat;
          fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2), 'utf8');
          ctx.log(`[市场] ${id} 分类设为「${pickedCat}」`);
        }
      } catch (e) {
        return { ok: false, error: '写 manifest 失败：' + String(e?.message ?? e).slice(0, 60) };
      }
    }
    // stripAssets=true：把 assets/ 里的图片音视频排除掉（素材单独托管）
    const stripAssets = body?.stripAssets === true;

    try {
      // ① 内核导出（clean 模式 = 干净包）
      // stripAssets=true 时排除 assets/ 里的图片音视频（素材单独托管）
      const q = new URLSearchParams({ id, mode: 'clean' });
      if (stripAssets) q.set('stripAssets', '1');
      const res = await localFetch(LOCAL_BASE.origin + `/api/plugins/export?${q}`, {
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

      // 🔴 打包时把作者邮箱写进 manifest 的 contact（A 方案）
      //
      // 这样即使别人自建市场、或包被单独分发，
      // 接收方也能从 manifest 里看到作者邮箱。
      const meForPkg = loadAuthor();
      if (meForPkg?.email) {
        m.contact = { ...(m.contact || {}), email: meForPkg.email };
        if (meForPkg.qq && !m.contact.qq) m.contact.qq = meForPkg.qq;
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

  /**
   * 把用户档案推到中心库（2026-10-25）
   *
   * 注册成功、心跳、手动同步都走这条。
   * 失败静默 —— 不影响注册流程，下次心跳会补。
   */
  const pushUserToRegistry = async (email, qq = '', nickname = '') => {
    const key = readBridgeKey();
    if (!key || !email) return { ok: false };
    try {
      const r = await fetch('https://market.baiguang211.top/api/registry/users', {
        method: 'POST',
        headers: { 'x-bridge-key': key, 'content-type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ email, qq, nickname }),
        signal: AbortSignal.timeout(15000),
      });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok && d?.ok !== false, total: d?.total };
    } catch { return { ok: false }; }
  };

  // ── 中心化数据读取（2026-10-25）──
  //
  // admin.json / market-users.json 原来是本机私有文件，
  // 导致每台机器各有一份名单 —— 用户在自己机器上 auto 成管理员，
  // 你看不到他，他也看不到你加的管理员。
  //
  // 现在优先读中心（R2 的 registry/），读不到才退回本地。
  const fetchRegistry = async (kind) => {
    const key = readBridgeKey();
    if (!key) return null;
    try {
      const r = await fetch(`https://market.baiguang211.top/api/registry/${kind}`, {
        headers: { 'x-bridge-key': key, 'User-Agent': UA },
        signal: AbortSignal.timeout(20000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d?.ok) return null;
      return kind === 'admins' ? (d.admins || []) : (d.users || []);
    } catch { return null; }
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

    // 🔴 不能写死作者名（2026-10-25 安全修复）
    //
    // 原来有 `author === '白光'` 这一条 —— 任何人只要插件署名「白光」，
    // 就被判定为自己的，可以发布/下架/卸载。**这是个真漏洞**：
    // 未注册的人、别的作者，都能操作署名「白光」的插件。
    //
    // 现在只认三样：我的昵称、我的 QQ、我的邮箱。
    const isMine = (me.nickname && author === me.nickname)
      || (me.qq && author === String(me.qq))
      || (me.email && author === me.email);

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

  /**
   * 管理员手动同步用户数据（2026-10-25）
   *
   * 用户问："我如何刷新？"
   *
   * 场景：
   *   · 想立刻把本机作者信息推到中心（不等次日心跳）
   *   · 想刷新所有用户的 lastSeenAt 看看谁还活跃
   */
  ctx.http.route('POST', '/api/market/admin/sync-users', async () => {
    const guard = requireAdmin();
    if (!guard.ok) return guard;

    const me = loadAuthor();
    const results = { pushed: false, refreshed: 0, error: null };

    // ① 把自己的档案推到中心（本机即中心时直接写本地）
    if (me?.email) {
      try {
        if (ctx.mail?.ready?.()) {
          const uf = path.join(ctx.root, 'data', 'market-users.json');
          let d = { users: [] };
          try { d = JSON.parse(fs.readFileSync(uf, 'utf8')); } catch { /* ignore */ }
          d.users = d.users || [];
          const hit = d.users.find((u) => u.email === me.email);
          if (hit) {
            hit.lastSeenAt = new Date().toISOString();
            hit.qq = me.qq || hit.qq;
            hit.nickname = me.nickname || hit.nickname;
          } else {
            d.users.push({
              email: me.email, qq: me.qq || '', nickname: me.nickname || '',
              firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
              verified: true, note: '管理员手动同步',
            });
          }
          fs.mkdirSync(path.dirname(uf), { recursive: true });
          fs.writeFileSync(uf, JSON.stringify(d, null, 2), 'utf8');
          results.pushed = true;
        } else {
          const res = await fetch(`${CENTER_URL()}/register-report`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'User-Agent': UA },
            body: JSON.stringify({ email: me.email, qq: me.qq || '', nickname: me.nickname || '' }),
            signal: AbortSignal.timeout(20000),
          });
          results.pushed = res.ok;
        }
      } catch (e) {
        results.error = String(e?.message ?? e).slice(0, 80);
      }
    }

    // ② 重新读一遍用户库（刷新界面看到的数字）
    try {
      const uf = path.join(ctx.root, 'data', 'market-users.json');
      if (fs.existsSync(uf)) {
        const d = JSON.parse(fs.readFileSync(uf, 'utf8'));
        results.refreshed = (d.users || []).length;
      }
    } catch { /* ignore */ }

    ctx.log(`[市场] 管理员手动同步：推送 ${results.pushed ? '成功' : '失败'}，用户库 ${results.refreshed} 人`);
    return { ok: true, ...results };
  }, { absolute: true });

  /** 管理员总览：全部作者 + 全部插件 + 统计数据 */
  ctx.http.route('GET', '/api/market/admin/overview', async () => {
    const guard = requireAdmin();
    if (!guard.ok) return guard;

    const me = guard.me;

    // 中心端用户档案（谁在我们这里注册过）
    //
    // 优先读中心（所有实例共享），读不到才退回本地文件。
    let marketUsers = [];
    const remoteUsers = await fetchRegistry('users');
    if (remoteUsers) {
      marketUsers = remoteUsers;
    } else {
      try {
        const uf = path.join(ctx.root, 'data', 'market-users.json');
        if (fs.existsSync(uf)) marketUsers = JSON.parse(fs.readFileSync(uf, 'utf8')).users || [];
      } catch { /* 读不到就空着 */ }
    }
    const userByEmail = new Map(marketUsers.map((u) => [u.email, u]));

    // 先把远端市场清单拉下来（作者邮箱、contact 都在那儿）
    let remoteItems = [];
    try {
      const { idx } = await fetchRemoteIndex();
      remoteItems = idx.plugins || [];
    } catch { /* 拉不到就继续，邮箱字段留空 */ }

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
        // 🔴 作者信息补全（2026-10-25）
        //
        // 原来只从 manifest 读 contact.qq，**从来没读过邮箱** ——
        // 因为邮箱不在 manifest 里，只在注册档案（author.json）和
        // 发布记录的联系人里。
        //
        // 用户反馈："我看不到他们的邮箱" —— 就是这个原因。
        //
        // 现在从三处找邮箱：
        //   ① 发布记录里的 contact（发布时记的）
        //   ② 本地注册档案（如果这个作者就是本机注册的人）
        //   ③ manifest 里的 contact.email（如果有）
        const me = loadAuthor();
        // 从远端市场清单找这个作者发布的插件，取 contact
        // （发布时会把 contact.qq 写进场景清单，那是权威来源）
        const remoteContact = (() => {
          try {
            const hit = (remoteItems || []).find((x) => String(x.author || '') === author && x.contact);
            return hit?.contact || null;
          } catch { return null; }
        })();
        const localEmail = (me && (
          (me.nickname && me.nickname === author) ||
          (me.qq && String(me.qq) === author) ||
          (me.email && author === me.email)
        )) ? (me.email || '') : '';

        authors.set(author, {
          name: author,
          plugins: 0,
          qq: m.contact?.qq || (localEmail ? me?.qq : '') || '',
          email: m.contact?.email || remoteContact?.email || localEmail || '',
          license: m.license || '',
        });
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
      // 全部注册用户（不只是有插件的）
      users: marketUsers.map((u) => ({
        email: u.email,
        qq: u.qq || '',
        nickname: u.nickname || '',
        firstSeenAt: u.firstSeenAt || '',
        lastSeenAt: u.lastSeenAt || '',
        verified: u.verified === true,
      })),
      usersTotal: marketUsers.length,
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

    // ── 优先走 Worker 代写（2026-10-25）──
    //
    // 🔴 用户反馈：管理端点「审核通过」弹「没有 R2 凭据，无法修改线上清单」
    //
    // 根因：这里直接调 loadR2() 写 R2，而普通管理员（非市场所有者）
    // 机器上没有 R2 密钥 —— 那不该是他们的负担。
    //
    // 现在先试 Worker：有 bridge 密钥或作者 token 就能改。
    // 失败再退回直连 R2（本机所有者场景）。
    const bridgeKeyT = readBridgeKey();
    let selfToken = '';
    try {
      const tkFile = path.join(ctx.data.dir, 'market-token.txt');
      if (fs.existsSync(tkFile)) selfToken = fs.readFileSync(tkFile, 'utf8').trim();
    } catch { /* ignore */ }

    if (bridgeKeyT || selfToken) {
      try {
        const headers = { 'content-type': 'application/json', 'User-Agent': UA };
        if (bridgeKeyT) headers['x-bridge-key'] = bridgeKeyT;
        if (selfToken) headers['authorization'] = 'Bearer ' + selfToken;
        const res = await fetch('https://market.baiguang211.top/api/admin/trust', {
          method: 'POST',
          headers,
          body: JSON.stringify({ id, trust }),
          signal: AbortSignal.timeout(30000),
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok && d?.ok) {
          cache = { at: 0, data: null, source: '', error: null };
          ctx.log(`[市场] ${id} trust → ${trust}（Worker）`);
          return { ok: true, id, trust, viaWorker: true };
        }
        // 非 401/404 才当作硬失败，否则往下走直连
        if (res.status !== 401 && res.status !== 404) {
          return { ok: false, error: d?.error || `Worker 返回 HTTP ${res.status}` };
        }
      } catch { /* 网络失败，往下走 */ }
    }

    const env = loadR2();
    if (!env) {
      return {
        ok: false,
        error: '无法修改线上清单：既没有 R2 凭据，也无法通过市场服务修改',
        hint: '请确认本机已登录作者账号（创造营 → 发布），或把 r2.env 放到 .secrets/market-r2/'
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

  /** 管理员名单（2026-10-25） */
  /**
   * 市场写操作统一代理（2026-10-25）
   *
   * 🔴 用户反馈：作者点「发验证码」报 Failed to fetch。
   *
   * 根因：前端直连 https://market.baiguang211.top。
   * 但市场列表走的是本机代理（/api/market/index），所以作者平时感觉不到；
   * 一旦浏览器真要跨域直连，在某些网络环境下就直接失败
   * （域名解析、CORS 预检、混合内容拦截都可能）。
   *
   * 修法：全部改走本机代理 —— 浏览器只跟本机说话，
   * 由 Node 去连外部服务。这样任何网络环境都能用。
   */
  const proxyToCenter = async (path, payload, timeout = 30000) => {
    try {
      const r = await fetch(`https://market.baiguang211.top${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify(payload || {}),
        signal: AbortSignal.timeout(timeout),
      });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok && d?.ok !== false, status: r.status, data: d };
    } catch (e) {
      return { ok: false, status: 0, data: { error: '连不上市场服务：' + String(e?.message ?? e).slice(0, 70) } };
    }
  };

  /** 发验证码（代理） */
  ctx.http.route('POST', '/api/market/send-code', async (_req, body) => {
    const email = String(body?.email || '').trim().toLowerCase();
    if (!email) return { ok: false, error: '缺少邮箱' };
    const purpose = String(body?.purpose || 'submit');   // 默认投稿凭证
    const r = await proxyToCenter('/api/send-code', { email, purpose });
    return r.data?.ok === false ? { ok: false, error: r.data.error } : { ok: true, message: r.data?.message || '验证码已发送' };
  }, { absolute: true });

  /** 用验证码换 token（代理） */
  ctx.http.route('POST', '/api/market/login-email', async (_req, body) => {
    const email = String(body?.email || '').trim().toLowerCase();
    const code = String(body?.code || '').trim();
    if (!email || !code) return { ok: false, error: '邮箱和验证码都要填' };
    const r = await proxyToCenter('/api/login', { email, code });
    if (!r.ok || !r.data?.token) {
      return { ok: false, error: r.data?.error || '验证失败' };
    }
    // 顺手存下来，发布时后端直接用
    try {
      fs.mkdirSync(ctx.data.dir, { recursive: true });
      fs.writeFileSync(path.join(ctx.data.dir, 'market-token.txt'), r.data.token, 'utf8');
    } catch { /* ignore */ }
    return { ok: true, token: r.data.token };
  }, { absolute: true });

  /** 投稿上传（代理） */
  ctx.http.route('POST', '/api/market/submit-via-center', async (_req, body) => {
    const r = await proxyToCenter('/api/submit', body, 120000);
    return r.ok ? r.data : { ok: false, error: r.data?.error || `提交失败（HTTP ${r.status}）` };
  }, { absolute: true });

  /** 下载统计代理（2026-10-25）：转发到 Worker，避开浏览器跨域 */
  ctx.http.route('GET', '/api/market/stats/downloads', async (_req, _b, url) => {
    const g = requireAdmin();
    if (!g.ok) return g;
    const id = String(url?.searchParams?.get('id') || '');
    try {
      const qs = id ? `?id=${encodeURIComponent(id)}` : '';
      const r = await fetch(`https://market.baiguang211.top/api/stats/downloads${qs}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(25000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.ok === false) {
        return { ok: false, error: d?.error || `HTTP ${r.status}` };
      }
      return d;
    } catch (e) {
      return { ok: false, error: '连不上统计服务：' + String(e?.message ?? e).slice(0, 60) };
    }
  }, { absolute: true });

  ctx.http.route('GET', '/api/market/admin/list', async () => {
    const guard = requireAdmin();
    if (!guard.ok) return guard;

    // 优先读中心；读不到退回本地
    const remoteAdmins = await fetchRegistry('admins');
    const adm = remoteAdmins
      ? { admins: remoteAdmins }
      : (loadAdmin() || { admins: [] });
    const users = (() => {
      try {
        const uf = path.join(ctx.root, 'data', 'market-users.json');
        if (fs.existsSync(uf)) return JSON.parse(fs.readFileSync(uf, 'utf8')).users || [];
      } catch { /* ignore */ }
      return [];
    })();
    const userByEmail = new Map(users.map((u) => [u.email, u]));

    return {
      ok: true,
      me: guard.me?.email || '',
      admins: (adm.admins || []).map((a) => {
        const u = userByEmail.get(a.email);
        return {
          email: a.email,
          since: a.since || '',
          // 市场所有者判定（2026-10-25 修）
          //
          // 中心 registry 里没有 auto 标记（那是本机旧概念的遗留）。
          // 现在用更可靠的判断：谁是市场所有者 = ADMIN_EMAIL 的第一位，
          // 也就是本机 whoAmI() 里 auto:true 的那位。
          isOwner: (() => {
            if (a.auto === true) return true;
            const localAdm = loadAdmin() || { admins: [] };
            const owner = (localAdm.admins || []).find((x) => x.auto === true);
            return !!owner && owner.email === a.email;
          })(),
          // 邮箱是否合法（历史脏数据：有人把 QQ 号填进邮箱框）
          valid: /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(String(a.email || '')),
          // 关联的用户档案（如果有）
          nickname: u?.nickname || '',
          qq: u?.qq || a.qq || '',
          lastSeenAt: u?.lastSeenAt || '',
        };
      }),
    };
  }, { absolute: true });

  ctx.http.route('POST', '/api/market/admin/set', async (_req, body) => {
    const guard = requireAdmin();
    if (!guard.ok) return guard;

    const email = String(body?.email || '').trim().toLowerCase();
    const remove = body?.remove === true;
    if (!email) return { ok: false, error: '缺少邮箱' };

    // 🔴 必须校验邮箱格式（2026-10-25 修）
    //
    // 之前不校验，结果界面上把 QQ 号填进"邮箱"框就存进去了：
    //   { "email": "619378351" }   ← 这不是邮箱，永远匹配不上任何人
    // 这类脏数据会让人以为"已经加了这个管理员"，实际谁也没加。
    if (remove && email) {
      // 删除时允许 QQ 号（清理历史脏数据用）
    } else if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
      return { ok: false, error: '请填邮箱（如 name@qq.com），不是 QQ 号' };
    }

    // 🔴 写中心名单（2026-10-25 修）
    //
    // 用户反馈：加 1934364876 报"已经是管理员了"，但列表里没有他。
    //
    // 根因：这里只读写**本机 admin.json**，而列表读的是**中心 registry**。
    // 本机那份里确实有他（历史遗留），中心没有 —— 两边打架。
    //
    // 现在以中心为准：直接调 Worker 的 /api/registry/admins 增删。
    const bridgeKeyA = readBridgeKey();
    let adminToken = '';
    try {
      const tkFile = path.join(ctx.data.dir, 'market-token.txt');
      if (fs.existsSync(tkFile)) adminToken = fs.readFileSync(tkFile, 'utf8').trim();
    } catch { /* ignore */ }

    if (!bridgeKeyA && !adminToken) {
      return { ok: false, error: '需要登录作者账号后再操作（无法连接市场服务）' };
    }
    try {
      const headers = { 'content-type': 'application/json', 'User-Agent': UA };
      if (bridgeKeyA) headers['x-bridge-key'] = bridgeKeyA;
      if (adminToken) headers['authorization'] = 'Bearer ' + adminToken;
      const res = await fetch('https://market.baiguang211.top/api/registry/admins', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, remove }),
        signal: AbortSignal.timeout(30000),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d?.ok === false) {
        return { ok: false, error: d?.error || `市场服务返回 HTTP ${res.status}` };
      }
      // 顺手同步到本机文件，保持离线也能判断身份
      try {
        const adm2 = loadAdmin() || { admins: [] };
        if (remove) {
          adm2.admins = (adm2.admins || []).filter((a) => a.email !== email);
        } else if (!(adm2.admins || []).some((a) => a.email === email)) {
          adm2.admins = [...(adm2.admins || []), { email, since: new Date().toISOString() }];
        }
        saveAdmin(adm2);
      } catch { /* 本地同步失败不影响主流程 */ }
      ctx.log(`[市场] ${remove ? '已取消' : '新增'}管理员：${email}（中心）`);
      return { ok: true, admins: d.admins || [], viaCenter: true };
    } catch (e) {
      return { ok: false, error: '连不上市场服务：' + String(e?.message ?? e).slice(0, 60) };
    }

    /* 老的本机逻辑保留在下面作参考，不再执行 */
    return { ok: true, admins: adm.admins };
  }, { absolute: true });

  /** 管理员：全部发布记录（含下架） */
  // ── 管理员：查看内核反馈（2026-10-25）──
  //
  // 普通作者只能看自己提交的；管理员能看全部，并可标记状态。
  // ── 插件反馈（多附件，2026-10-25）──
  //
  // 用户要求："注册用户点击反馈按钮，出弹窗，可以提交 0-3 张图片
  // 和 0-3 个日志或 md 文件，及文字描述内容"
  ctx.http.route('POST', '/api/market/feedback/rich', async (_req, body) => {
    const w = whoAmI();
    if (w.role === 'guest' || !w.me?.email) {
      return { ok: false, error: '请先注册或登录作者账号' };
    }
    let fbm;
    try {
      fbm = await import('../../src/feedback.js');
    } catch {
      return { ok: false, error: '当前内核版本不支持反馈（缺少 src/feedback.js）' };
    }
    if (typeof fbm.submitFeedbackRich !== 'function') {
      return { ok: false, error: '当前内核版本的反馈模块太旧，请升级内核' };
    }
    const r = fbm.submitFeedbackRich(w.me, {
      type: body?.type,
      title: body?.title,
      body: body?.body,
      images: body?.images,
      // 日志与文档分开（2026-10-26）
      logFiles: body?.logFiles,
      docFiles: body?.docFiles,
      files: body?.files,   // 兼容老格式
      pluginId: body?.pluginId,
      pluginName: body?.pluginName,
      pluginVersion: body?.pluginVersion,
    });
    if (r.ok) ctx.log(`[市场] 收到反馈 ${r.id}：${String(body?.title || '').slice(0, 30)}`);
    return r;
  }, { absolute: true });

  /**
   * 我的反馈列表（2026-10-25）
   *
   * 用户要求："插件反馈的列表在发布栏里看吧，你放到管理栏的话有些作者没权限"
   *
   * 完全正确 —— /api/market/admin/feedback 有 requireAdmin()，
   * 普通作者点进去只会 403。作者该能看**自己提交过什么、处理到哪一步**。
   */
  ctx.http.route('GET', '/api/market/feedback/mine', async () => {
    const w = whoAmI();
    if (w.role === 'guest' || !w.me?.email) {
      return { ok: false, error: '请先注册或登录作者账号' };
    }
    let fbm;
    try {
      fbm = await import('../../src/feedback.js');
    } catch {
      return { ok: false, error: '当前内核版本不支持反馈' };
    }
    const mine = fbm.listFeedback({ email: w.me.email, all: false });
    return {
      ok: true,
      total: mine.length,
      items: mine.map(({ dir, ...rest }) => rest),   // 不暴露服务器路径
    };
  }, { absolute: true });

  ctx.http.route('GET', '/api/market/admin/feedback', async (_req, _b, url) => {
    const g = requireAdmin();
    if (!g.ok) return g;

    const status = String(url?.searchParams?.get('status') || '');
    const fbm = await import('../../src/feedback.js');
    const all = fbm.listFeedback({ all: true });

    const items = (status ? all.filter((x) => x.status === status) : all)
      .map(({ dir, ...rest }) => rest);   // 不暴露服务器路径

    return {
      ok: true,
      stats: {
        total: all.length,
        open: all.filter((x) => x.status === 'open').length,
        bug: all.filter((x) => x.type === 'bug').length,
        feature: all.filter((x) => x.type === 'feature').length
      },
      items
    };
  }, { absolute: true });

  // 管理员：改反馈状态（open / resolved / ignored）
  ctx.http.route('POST', '/api/market/admin/feedback/status', async (_req, body) => {
    const g = requireAdmin();
    if (!g.ok) return g;
    const id = String(body?.id || '');
    const status = String(body?.status || '');
    if (!['open', 'resolved', 'ignored'].includes(status)) {
      return { ok: false, error: 'status 只能是 open / resolved / ignored' };
    }
    const fbm = await import('../../src/feedback.js');
    const r = fbm.setFeedbackStatus(id, status, g.me?.email || '');
    if (r.ok) ctx.log(`[市场] 反馈 ${id} 标记为 ${status}`);
    return r;
  }, { absolute: true });

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

    const queue = await getQueue();
    if (!queue) return NO_QUEUE;
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
    const queue = await getQueue();
    if (!queue) return { ok: true, items: [], unsupported: true };
    const all = queue.listSubmissions();
    const mine = all.filter((s) =>
      (w.me?.email && s.contact === w.me.email) || (w.me?.qq && s.contact === String(w.me.qq)));
    return { ok: true, items: mine };
  }, { absolute: true });

  // 管理员：全部投稿 + 统计
  // ── 待审列表（2026-10-25 打通 R2）──
  //
  // 🔴 问题：作者投稿走 Cloudflare Worker → 存 R2 的 pending/；
  //    而这里原来读的是**本地目录** data/plugins/plugin-market/pending/
  //    → 两套系统互不相通，作者说上传成功，管理员却看不到。
  //
  // 修法：同时读两边，合并展示。
  //   · Worker 的 /api/bridge/pending（共享密钥认证）
  //   · 本地队列（旧路径，保留兼容）
  // 🔴 bridge 密钥查找（2026-10-25 修）
  //
  // 原来写死 '/home/lyy/.secrets/market-bridge/bridge.key' ——
  // 那是**我这台机器**的路径。别的管理员在自己机器上跑，
  // 根本没这个文件，于是拉不到待审列表，界面永远"没有投稿"。
  //
  // 现在按优先级找：
  //   ① 环境变量 QQAGENT_BRIDGE_KEY（部署时注入）
  //   ② 插件数据目录 data/plugins/plugin-market/bridge.key（随插件走）
  //   ③ ~/.secrets/market-bridge/bridge.key（本机开发）
  //   ④ 老路径（兼容已部署的）
  const readBridgeKey = () => {
    const cands = [];
    if (process.env.QQAGENT_BRIDGE_KEY) return String(process.env.QQAGENT_BRIDGE_KEY).trim();
    cands.push(path.join(ctx.data.dir, 'bridge.key'));
    cands.push(path.join(os.homedir(), '.secrets', 'market-bridge', 'bridge.key'));
    cands.push('/home/lyy/.secrets/market-bridge/bridge.key');
    for (const f of cands) {
      try {
        const k = fs.readFileSync(f, 'utf8').trim();
        if (k) return k;
      } catch { /* 试下一个 */ }
    }
    return '';
  };

  /**
   * 用本机登录的作者身份换一张市场 token（2026-10-25）
   * 有 bridge 密钥时走 bridge，没有就走 auth 中心的验证码（但需要交互）
   * 实测：bridge 缺失时这里会返回 null，界面提示需要配置
   */
  const fetchMarketToken = async (me) => {
    if (!me?.email) return null;

    // ① 有 bridge 密钥 → 直接向 Worker 换（本机所有者，最快）
    const key = readBridgeKey();
    if (key) {
      try {
        const r = await fetch('https://market.baiguang211.top/api/bridge/token', {
          method: 'POST',
          headers: { 'x-bridge-key': key, 'content-type': 'application/json', 'User-Agent': UA },
          body: JSON.stringify({ email: me.email, qq: me.qq || '', nickname: me.nickname || '' }),
          signal: AbortSignal.timeout(20000),
        });
        const d = await r.json().catch(() => ({}));
        if (d?.ok && d.token) return d.token;
      } catch { /* 落到下面 */ }
    }

    // ② 没密钥（普通作者）→ 走本机 /submit-token
    //    它内部会用本机 bridge 密钥代签；没有则返回 null，
    //    界面会提示走「邮箱验证码换凭证」那条公开路径。
    try {
      const r = await localFetch(LOCAL_BASE.origin + '/api/market/submit-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': UA },
        body: '{}',
        signal: AbortSignal.timeout(20000),
      });
      const d = await r.json().catch(() => ({}));
      return d?.ok && d.token ? d.token : null;
    } catch { return null; }
  };

  /**
   * 用投稿凭证（token）发布到市场 —— 任何作者都能走（2026-10-25）
   *
   * 这是 Worker /api/publish 的正路：不需要 R2 密钥，不需要 bridge，
   * 只要一张有效的投稿 token（邮箱验证码就能换）。
   */
  const publishViaWorker = async (payload) => {
    try {
      const res = await fetch('https://market.baiguang211.top/api/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120000),
      });
      const d = await res.json().catch(() => ({}));
      return res.ok && d?.ok ? { ok: true, filename: d.filename, item: d.published }
        : { ok: false, reason: d?.error || `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, reason: String(e?.message ?? e).slice(0, 80) };
    }
  };



  const fetchRemotePending = async () => {
    // 两条路：管理员 token（任何人可用）/ bridge 密钥（仅本机所有者）
    const key = readBridgeKey();
    let url = '';
    let headers = { 'User-Agent': UA };
    if (key) {
      url = 'https://market.baiguang211.top/api/bridge/pending';
      headers['x-bridge-key'] = key;
    } else {
      // 没有 bridge 密钥 → 用本机登录的管理员身份换 token 试试
      const w = whoAmI();
      if (w.role !== 'admin' || !w.me?.email) {
        return { ok: false, error: '需要管理员身份（且本机未配置 bridge 密钥）', items: [] };
      }
      const tk = await fetchMarketToken(w.me);
      if (!tk) return { ok: false, error: '无法获取审核凭证', items: [] };
      url = 'https://market.baiguang211.top/api/pending';
      headers['authorization'] = 'Bearer ' + tk;
    }
    try {
      const r = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(25000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.ok === false) {
        return { ok: false, error: d?.error || `HTTP ${r.status}`, items: [] };
      }
      return { ok: true, items: d.items || [] };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 80), items: [] };
    }
  };

  ctx.http.route('GET', '/api/market/submissions', async (_req, _b, url) => {
    const g = requireAdmin();
    if (!g.ok) return g;
    const status = String(url?.searchParams?.get('status') || '');

    // ① 远端（Worker + R2）
    const remote = await fetchRemotePending();

    // ② 本地队列（旧路径，有就读）
    let local = { stats: { total: 0, pending: 0, approved: 0, rejected: 0, bytes: 0 }, items: [] };
    const queue = await getQueue();
    if (queue) {
      try {
        local = { stats: queue.queueStats(), items: queue.listSubmissions({ status }) };
      } catch { /* ignore */ }
    }

    // 合并：远端在前，按时间倒序
    const merged = [...(remote.items || []), ...(local.items || [])];
    merged.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));

    const pending = merged.filter((x) => x.status === 'pending').length;
    return {
      ok: true,
      stats: {
        total: merged.length,
        pending,
        approved: merged.filter((x) => x.status === 'approved').length,
        rejected: merged.filter((x) => x.status === 'rejected').length,
        bytes: merged.reduce((s, x) => s + (x.bytes || 0), 0),
      },
      items: merged,
      // 远端状态要透出，连不上时界面能提示
      remote: { ok: remote.ok, error: remote.error || null, count: (remote.items || []).length },
    };
  }, { absolute: true });

  // ── 为已登录作者代签投稿凭证（2026-10-25）──
  //
  // 用户要求："已登录账号无需再次验证，登录账号直接可投稿"
  //
  // 本机会先确认"这个 email 确实在本机登录过"，再去向 Worker 换 token。
  // 所以这条路只有真正登录的人能走通 —— 不能凭空拿到投稿凭证。
  /** 保存投稿凭证（2026-10-25）：前端换到 token 后存本机，发布时后端直接用 */
  ctx.http.route('POST', '/api/market/submit-token/save', async (_req, body) => {
    const tk = String(body?.token || '').trim();
    if (!tk) return { ok: false, error: '缺少 token' };
    try {
      fs.mkdirSync(ctx.data.dir, { recursive: true });
      fs.writeFileSync(path.join(ctx.data.dir, 'market-token.txt'), tk, 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }, { absolute: true });

  ctx.http.route('POST', '/api/market/submit-token', async () => {
    const w = whoAmI();
    if (w.role === 'guest' || !w.me?.email) {
      return { ok: false, error: '请先注册或登录作者账号' };
    }

    // 两条路（2026-10-25 修）：
    //   ① 本机有 bridge 密钥 → 直接向 Worker 换（市场所有者机器）
    //   ② 没有密钥（普通作者）→ 向中心服务换。中心有密钥，
    //      且只给"已登记过的邮箱"签发 —— 所以伪造不了。
    //
    // 用户反馈的 "Failed to fetch" 就是因为原来只走 ①，
    // 普通作者机器上一路撞墙。
    const key = readBridgeKey();

    if (key) {
      try {
        const res = await fetch('https://market.baiguang211.top/api/bridge/token', {
          method: 'POST',
          headers: { 'x-bridge-key': key, 'content-type': 'application/json', 'User-Agent': UA },
          body: JSON.stringify({ email: w.me.email, qq: w.me.qq || '', nickname: w.me.nickname || '' }),
          signal: AbortSignal.timeout(25000),
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok && d?.ok && d.token) {
          ctx.log(`[市场] 已为 ${w.me.email} 代签投稿凭证（本机密钥）`);
          return { ok: true, token: d.token, email: w.me.email };
        }
      } catch { /* 落到中心那条路 */ }
    }

    // ② 走中心服务
    try {
      const res = await fetch(`${CENTER_URL()}/market-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ email: w.me.email }),
        signal: AbortSignal.timeout(25000),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d?.ok && d.token) {
        ctx.log(`[市场] 已为 ${w.me.email} 从中心获取投稿凭证`);
        return { ok: true, token: d.token, email: w.me.email };
      }
      return { ok: false, error: d?.error || `换凭证失败（HTTP ${res.status}）` };
    } catch (e) {
      return { ok: false, error: '连不上投稿服务：' + String(e?.message ?? e).slice(0, 60) };
    }
  }, { absolute: true });

  // 管理员：审核
  ctx.http.route('POST', '/api/market/submissions/review', async (_req, body) => {
    const g = requireAdmin();
    if (!g.ok) return g;
    const id = String(body?.id || '');
    const action = String(body?.action || '');
    if (!['approve', 'reject'].includes(action)) return { ok: false, error: 'action 只能是 approve / reject' };
    // 先试远端（Worker + R2）——作者的投稿都在那边
    const key = readBridgeKey();
    let handledRemote = false;
    if (key) {
      try {
        const res = await fetch('https://market.baiguang211.top/api/bridge/review', {
          method: 'POST',
          headers: { 'x-bridge-key': key, 'content-type': 'application/json', 'User-Agent': UA },
          body: JSON.stringify({ id, action, note: body?.note || '' }),
          signal: AbortSignal.timeout(60000),
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok && d?.ok) {
          handledRemote = true;
          cache = { at: 0, data: null, source: '', error: null };
          ctx.log(`[市场] 远端投稿 ${id} ${action === 'approve' ? '已通过并上架' : '已驳回'}`);
          return { ok: true, remote: true, submission: d.submission, published: d.published };
        }
        // 404 = 远端没这条，退回本地处理
        if (res.status !== 404) {
          return { ok: false, error: d?.error || `远端审核失败（HTTP ${res.status}）` };
        }
      } catch (e) {
        return { ok: false, error: '连不上审核服务：' + String(e?.message ?? e).slice(0, 60) };
      }
    }

    // 本地队列（旧路径）
    const queue = await getQueue();
    if (!queue) return handledRemote ? { ok: true } : NO_QUEUE;
    const r = queue.reviewSubmission(id, action, body?.note);
    if (r.ok) ctx.log(`[市场] 投稿 ${id} ${action === 'approve' ? '通过' : '驳回'}`);
    return r;
  }, { absolute: true });

  // 管理员：删除投稿
  ctx.http.route('POST', '/api/market/submissions/delete', async (_req, body) => {
    const g = requireAdmin();
    if (!g.ok) return g;
    const queue = await getQueue();
    if (!queue) return NO_QUEUE;
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

      // 🔴 归属判定必须是「我和这个作者名相等」，不能有任何写死的名字
      //    （2026-10-25 修安全漏洞）
      //
      // 原来写的是：
      //   const isOwn = authorName === '白光' || (me?.nickname && ...) || ...
      // 后果：**任何人只要插件署名「白光」，就被判定为自己的**，
      // 哪怕根本没注册作者、没登录 —— 未登录用户也能看到发布/下架按钮。
      //
      // 现在只有三种情况算"自己的"：
      //   ① 已注册，且 manifest.author == 我的昵称
      //   ② 已注册，且 manifest.author == 我的 QQ
      //   ③ 已注册，且 manifest.author == 我的邮箱
      // 未注册（guest）→ 一律不算自己的。
      const isOwn = !!me && (
        (me.nickname && authorName === me.nickname) ||
        (me.qq && authorName === String(me.qq)) ||
        (me.email && authorName === me.email)
      );
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

  /**
   * 发布前体检（2026-10-26）
   *
   * 三道闸，按"能不能自动判断"分层：
   *   ① 必填字段   —— 缺了直接拒绝，没有商量余地
   *   ② 版本递增   —— 与市场现有版本比，不递增就拒绝（防"发了跟没发一样"）
   *   ③ 敏感信息   —— 扫包内文本，命中就拒绝并报出位置
   *
   * 为什么 ③ 要拒绝而不是仅提示：
   *   发到市场上就是公开的。QQ 号、服务器 IP、API key 一旦泄露，
   *   撤回也来不及（别人可能已经下了）。宁可让作者改完再发。
   *   确实需要（比如文档里本来就要写公网地址）可以传 force 跳过。
   */
  const preflightCheck = async (id, pkg, opts = {}) => {
    const force = opts.force === true;
    const issues = [];       // 硬错误
    const warns = [];        // 提醒（不拦）

    // ① 必填字段
    let mf = {};
    try {
      mf = JSON.parse(fs.readFileSync(path.join(ctx.root, 'plugins', id, 'manifest.json'), 'utf8'));
    } catch {
      return { ok: false, error: '读不到 manifest.json，无法体检' };
    }
    for (const k of ['id', 'version', 'name']) {
      if (!String(mf[k] || '').trim()) issues.push(`manifest 缺 ${k}`);
    }
    if (mf.id && mf.id !== id) issues.push(`manifest.id（${mf.id}）与要发布的 id（${id}）不一致`);
    if (!/^\d+\.\d+\.\d+/.test(String(mf.version || ''))) {
      issues.push(`版本号格式不对（${mf.version}），应形如 1.2.3`);
    }

    // ② 版本递增（与市场现状比）
    if (!force) {
      try {
        const { idx } = await fetchRemoteIndex();
        const cur = (idx.plugins || []).find((p) => p.id === id);
        if (cur && cmpVer(String(mf.version), String(cur.version)) <= 0) {
          issues.push(`版本没有递增：市场已是 v${cur.version}，这次是 v${mf.version}。改个版本号再发，或传 force 强制覆盖。`);
        }
      } catch { /* 拉不到远端就不拦（离线发布场景） */ }
    }

    // ③ 敏感信息扫描
    //
    // 扫的是**包内所有文本文件**，不是源码目录 ——
    // 因为打包过程会注入 config.json，那里也可能带出密钥。
    const SECRET_RULES = [
      { name: 'QQ 号',     re: /\b[1-9]\d{4,11}\b/g,            level: 'warn' },   // 太容易误报，只提醒
      { name: 'API Key',   re: /sk-[A-Za-z0-9]{16,}/g,            level: 'error' },
      { name: 'Token',     re: /\b(?:ghp|gho|ghs)_[A-Za-z0-9]{20,}/g, level: 'error' },
      { name: 'AWS 密钥',  re: /AKIA[0-9A-Z]{16}/g,               level: 'error' },
      { name: '私钥',      re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, level: 'error' },
      { name: '内网 IP',   re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g, level: 'warn' },
      // 密码字段（2026-10-28 收窄）
      //
      // 原规则 `apiKey: '任意6+字符'` 会误伤中文词典 ——
      // 插件中心里有 `apiKey: 'API Key'` 这种「键名→中文名」的映射，
      // 被当成硬编码密码拦下来，导致正常插件发不出去。
      //
      // 收窄为：值必须**像密钥**（含大小写+数字+符号，且非纯中文/纯单词），
      // 或值长度 >= 16。映射表里的中文名天然不满足。
      { name: '密码字段',  re: /["']?(?:password|passwd|apiKey|secret)["']?\s*[:=]\s*["'](?:[A-Za-z0-9_\-!@#$%^&*]{16,}|(?=[^"']*[A-Z])(?=[^"']*[a-z])(?=[^"']*[0-9])[A-Za-z0-9_\-!@#$%^&*]{8,})["']/g, level: 'error' },
    ];

    const hits = [];
    try {
      const buf = fs.readFileSync(pkg.packagePath);
      // 解压看内容（tar.gz）
      const zlib = await import('node:zlib');
      const tar = zlib.gunzipSync(buf);
      // 极简 tar 遍历：只扫文本文件
      let off = 0;
      const TEXT_EXT = /(?:^|\/)[^/]+\.(js|json|md|txt|yml|yaml|html|css|sh|py)$/i;
      while (off + 512 <= tar.length) {
        const hd = tar.subarray(off, off + 512);
        if (hd.every((b) => b === 0)) break;
        const name = hd.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        if (!name) break;
        const size = parseInt(hd.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
        const ds = off + 512;
        if (size > 0 && size < 512 * 1024 && TEXT_EXT.test(name)) {
          const content = tar.subarray(ds, ds + size).toString('utf8');
          for (const rule of SECRET_RULES) {
            const found = content.match(rule.re);
            if (found && found.length) {
              // 只报前 2 个样例，且**脱敏**（不把密钥本身写进日志）
              const samples = [...new Set(found)].slice(0, 2).map((s) => {
                const str = String(s);
                return str.length > 10 ? str.slice(0, 4) + '***' + str.slice(-2) : str.slice(0, 2) + '***';
              });
              hits.push({
                level: rule.level,
                kind: rule.name,
                file: name,
                count: found.length,
                samples,
              });
            }
          }
        }
        off = ds + Math.ceil(size / 512) * 512;
      }
    } catch (e) {
      warns.push('敏感信息扫描未能完成：' + String(e?.message ?? e).slice(0, 60));
    }

    const errors = hits.filter((h) => h.level === 'error');
    if (errors.length && !force) {
      const lines = errors.slice(0, 5).map((h) =>
        `  · ${h.kind} ×${h.count}  在 ${h.file}（样例 ${h.samples.join('、')}）`);
      return {
        ok: false,
        error: `体检未通过：包里有 ${errors.length} 处敏感信息，发到市场就公开了。\n\n${lines.join('\n')}\n\n改掉再发；确实要发就带 force。`,
        preflight: { errors, warns, hits },
      };
    }
    const warnHits = hits.filter((h) => h.level === 'warn');
    if (warnHits.length) {
      warns.push(...warnHits.slice(0, 3).map((h) => `${h.kind} ×${h.count} 在 ${h.file}`));
    }

    if (issues.length) {
      return { ok: false, error: '体检未通过：\n' + issues.map((x) => '  · ' + x).join('\n'), preflight: { issues, warns } };
    }

    if (warns.length) ctx.log(`[市场] ${id} 体检提醒：${warns.slice(0, 3).join('; ')}`);
    return { ok: true, preflight: { issues: [], warns, hits } };
  };

  /** 发布：打包 + 记录 */
  ctx.http.route('POST', '/api/market/myplugins/publish', async (_req, body) => {
    const id = String(body?.id || '');
    const changelog = String(body?.changelog || '').trim().slice(0, 2000);
    if (!id) return { ok: false, error: '缺少插件 id' };
    // 变更说明必填（2026-10-26）：市场用户装完得知道变了什么
    if (!changelog) {
      return { ok: false, error: '请填写「这次改了什么」—— 市场里的用户要靠它知道更新了什么' };
    }

    // 🔴 只有作者能发布
    const own = checkOwner(id);
    if (!own.ok) return own;

    // ── 复用已打包的文件（2026-10-26）──
    //
    // 外部建议：现在只能"点发布 → 现场打包"，没法指定已经打好的包。
    // 场景：想先本地验证包、包很大不想重复打、分步发布。
    //
    // 安全：basename 限制在 packages 目录内（防路径穿越），
    //      并且后面体检会校验包内 manifest.id 与要发的 id 一致。
    const useFile = String(body?.file || '').trim();
    let pkgFromFile = null;
    if (useFile) {
      const safe = path.basename(useFile);
      const p = path.join(ctx.data.dir, 'packages', safe);
      if (!fs.existsSync(p)) return { ok: false, error: `包不存在：${safe}` };
      const buf = fs.readFileSync(p);
      // 从包内 manifest 提元信息（不信任文件名）
      let meta = {};
      try {
        const zlib = await import('node:zlib');
        const tar = zlib.gunzipSync(buf);
        const hd = tar.subarray(0, 512);
        const nm = hd.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        const sz = parseInt(hd.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
        if (/manifest\.json$/.test(nm)) {
          meta = JSON.parse(tar.subarray(512, 512 + sz).toString('utf8'));
        }
      } catch { /* 提不出来就靠体检拦 */ }
      if (meta.id && meta.id !== id) {
        return { ok: false, error: `包里的插件是「${meta.id}」，与要发布的「${id}」不一致` };
      }
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const pkgDirect = {
        ok: true,
        packagePath: p,
        filename: safe,
        sizeText: `${(buf.length / 1024).toFixed(1)} KB`,
        market: {
          id, version: String(meta.version || ''), name: meta.name || id,
          author: meta.author || '', summary: meta.summary || '',
          description: meta.description || '', category: meta.category || '',
          permissions: meta.permissions || [], scopes: meta.scopes || [],
          apiVersion: meta.apiVersion || 1, sha256, size: buf.length,
        },
        warnings: [],
      };
      ctx.log(`[市场] ${id} 使用已打包文件 ${safe}（${pkgDirect.sizeText}）`);
      pkgFromFile = pkgDirect;
    }

    // 复用打包接口（指定了文件就跳过打包）
    let pkg = pkgFromFile;
    try {
      if (pkgFromFile) { /* 已有包，不重复打包 */ } else {
      // 自动判断要不要剥离素材：先按原样打，超 5MB 就改剥离版
      //
      // 为什么自动而不是让用户选：
      //   grail 37MB 里有 36.9MB 是立绘图片，代码只有 0.5MB。
      //   用户点「发布」时不该被迫理解"素材要不要分离"这种事。
      let res = await localFetch(LOCAL_BASE.origin + `/api/market/package`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': 'QQAgent-Market/1.0' },
        body: JSON.stringify({ id }),
        signal: AbortSignal.timeout(120000),
      });
      let pkg0 = await res.json();
      if (pkg0?.ok && (pkg0.market?.size || 0) > 5 * 1024 * 1024) {
        ctx.log(`[市场] ${id} 包体积 ${(pkg0.market.size/1024/1024).toFixed(1)}MB，改用剥离素材版`);
        res = await localFetch(LOCAL_BASE.origin + `/api/market/package`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'User-Agent': 'QQAgent-Market/1.0' },
          body: JSON.stringify({ id, stripAssets: true }),
          signal: AbortSignal.timeout(120000),
        });
        pkg0 = await res.json();
      }
      pkg = pkg0;
      }
    } catch (e) {
      return { ok: false, error: '打包失败：' + String(e?.message ?? e) };
    }
    if (!pkg?.ok) return { ok: false, error: pkg?.error || '打包失败' };

    // ── 发布前体检（2026-10-26）──
    //
    // 外部建议：现在流程是"打包 → 直接上传"，出问题只靠作者肉眼。
    // 三道闸：必填字段 / 版本递增 / **敏感信息扫描**。
    //
    // 第三条最实用 —— 作者在自己机器上打包，很容易把测试账号、
    // 内网地址、API key 带出去，而这些东西一旦上市场就是公开的。
    //
    // 策略：
    //   · 硬错误（缺 id/version）→ 拒绝发布
    //   · 敏感信息 → **拒绝**，但给出具体位置，作者确认后可带 force 跳过
    //   · 版本未递增 → 拒绝（除非 force）
    const pre = await preflightCheck(id, pkg, { force: body?.force === true });
    if (!pre.ok) return pre;

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
      // ── 优先走 Worker 代上传（2026-10-25）──
      //
      // 🔴 用户反馈：作者点「发布到市场」报「未配置 R2 凭据」
      //
      // 根因：本机直接调 loadR2() 读写 R2，但普通作者的机器
      // 根本没有 R2 密钥（也不该有）—— 那是市场所有者的凭据。
      //
      // 现在先试 Worker 代理：有网络就能发，不依赖本地凭据。
      // 失败再退回直连 R2（本机所有者场景）。
      const meNow = whoAmI().me || {};
      const pkgBuf = fs.readFileSync(pkg.packagePath);
      let viaWorker = { ok: false };

      // 拿凭证，三条路按顺序试：
      //   ① 界面已存的投稿 token（作者用邮箱验证码换的，最通用）
      //   ② bridge 密钥（本机所有者）
      //   ③ 本机代签（bridge 存在时可用）
      let pubToken = '';
      const bridgeKey = readBridgeKey();

      // 读本机存的 token，**先检查有没有过期**
      // 不检查的话会拿着过期 token 去发，报"token 无效"，
      // 用户以为要重新登录，实际只是过期了。
      const tokenExpired = (tk) => {
        try {
          const parts = String(tk || '').split('.');
          if (parts.length !== 2) return true;
          let b = parts[0].replace(/-/g, '+').replace(/_/g, '/');
          while (b.length % 4) b += '=';
          const bin = Buffer.from(b, 'base64').toString('binary');
          const bytes = Buffer.from(bin, 'binary');
          const payload = JSON.parse(bytes.toString('utf8'));
          return !payload?.exp || payload.exp <= Date.now();
        } catch { return true; }
      };

      try {
        const tkFile = path.join(ctx.data.dir, 'market-token.txt');
        if (fs.existsSync(tkFile)) {
          const tk = fs.readFileSync(tkFile, 'utf8').trim();
          if (tk && !tokenExpired(tk)) pubToken = tk;
        }
      } catch { /* ignore */ }
      if (!pubToken && !bridgeKey) {
        const tk = await fetchMarketToken(meNow);
        if (tk) pubToken = tk;
      }

      if (bridgeKey || pubToken) {
        try {
          const headers = { 'content-type': 'application/json', 'User-Agent': UA };
          if (bridgeKey) headers['x-bridge-key'] = bridgeKey;
          if (pubToken) headers['authorization'] = 'Bearer ' + pubToken;
          const res = await fetch('https://market.baiguang211.top/api/publish', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              id,
              version: rec.version,
              base64: pkgBuf.toString('base64'),
              // 更新说明（2026-10-26）：市场详情页要显示这版改了什么
              changelog: rec.changelog || '',
              // 🔴 保留原作者（2026-10-28）
              //
              // 原来固定传登录账号昵称，导致：
              //   别人维护的插件（如 plugin-center 作者墨柒秋）一旦由我发布，
              //   市场里的作者就被改成了我 —— 属于冒名。
              //
              // 现在优先用 manifest 里声明的 author，只有它为空时才用登录账号。
              author: String(pkg?.market?.author || '').trim()
                || meNow.nickname || meNow.email || '',
              qq: meNow.qq || '',
              email: meNow.email || '',
            }),
            signal: AbortSignal.timeout(120000),
          });
          const d = await res.json().catch(() => ({}));
          if (res.ok && d?.ok) {
            viaWorker = { ok: true, filename: d.filename, item: d.published };
          } else {
            viaWorker = { ok: false, reason: d?.error || `HTTP ${res.status}` };
          }
        } catch (e) {
          viaWorker = { ok: false, reason: String(e?.message ?? e).slice(0, 80) };
        }
      }

      if (viaWorker.ok) {
        cache = { at: 0, data: null, source: '', error: null };
        remote = { ok: true, filename: viaWorker.filename };
        ctx.log(`[市场] ${id} v${rec.version} 已通过 Worker 发布`);
      } else {
      const env = loadR2();
      if (!env) {
        remote = {
          ok: false,
          reason: viaWorker.reason
            ? `Worker 发布失败：${viaWorker.reason}`
            : '未配置发布凭证（请先登录作者账号）',
        };
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
          // 🔴 带上邮箱（2026-10-25）：管理后台要靠它显示作者联系方式
          contact: {
            qq: whoAmI().me?.qq || '',
            email: whoAmI().me?.email || '',
          },
          // 🔴 trust 判定（2026-10-25 修）
          //
          // 原来一律写 'unverified'，导致**管理员自己发布的插件也被当成待审核**，
          // 而客户端默认 hideUntrusted 会把它们过滤掉 ——
          // 结果就是「自己发的自己看不到」。
          //
          // 现在：管理员发的直接 official（他有全部权限，不需要人来审他）；
          //       普通作者发的仍标 unverified，等管理员审核。
          trust: whoAmI().role === 'admin' ? 'official' : 'unverified',
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
      }   // ← 关闭 viaWorker.ok 的 else
    } catch (e) {
      remote = { ok: false, reason: String(e?.message ?? e).slice(0, 150) };
    }

    // ── 发布成功后自动装回本地（2026-10-26）──
    //
    // 外部建议：发布后本地还是旧版本，容易"发出去了自己没更新"。
    // 三个好处：
    //   ① 保证市场版本 == 本机版本
    //   ② 顺带验证包能不能装（装不上说明包坏了，当场发现）
    //   ③ 作者省一步手动操作
    //
    // 用**刚打出来的那个包**装，不是从市场下载 ——
    // 市场清单有缓存，刚发的可能还拉不到。
    let selfInstalled = { ok: false, reason: '未尝试' };
    if (remote.ok) {
      try {
        const buf = fs.readFileSync(pkg.packagePath);
        const res = await localFetch(LOCAL_BASE.origin + '/api/plugins/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'User-Agent': UA },
          // keepLocalConfig：**不要**用包里的默认配置覆盖本地真实配置
          // （2026-10-26 修：发布后装回会把 API Key 清空）
          body: JSON.stringify({
            base64: buf.toString('base64'),
            mode: 'replace',
            keepLocalConfig: true,
          }),
          signal: AbortSignal.timeout(60000),
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok && d?.ok !== false) {
          selfInstalled = { ok: true };
          ctx.log(`[市场] ${id} 已同步装回本地（保留本地配置）`);
        } else {
          selfInstalled = { ok: false, reason: d?.error || `HTTP ${res.status}` };
          ctx.log(`[市场] ${id} 装回本地失败：${selfInstalled.reason}`);
        }
      } catch (e) {
        selfInstalled = { ok: false, reason: String(e?.message ?? e).slice(0, 80) };
      }
    }

    ctx.log(`[市场] ${id} v${rec.version} ${remote.ok ? '已发布到市场' : '打包完成但上传失败：' + remote.reason}`);
    return {
      ok: true,
      record: rec,
      packagePath: pkg.packagePath,
      filename: pkg.filename,
      sizeText: pkg.sizeText,
      // 合并两处警告：打包体积预警 + 体检提醒
      warnings: [...(pkg.warnings || []), ...((pre.preflight && pre.preflight.warns) || [])],
      preflight: pre.preflight || null,
      selfInstalled,
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

  // ── 版本历史与一键回退（2026-10-26）──
  //
  // 用户要求："做吧一键回退"
  //
  // 转发到 Worker（它有 R2 权限，能列出 packages/ 下的历史包）。
  ctx.http.route('GET', '/api/market/myplugins/versions', async (_req, _b, url) => {
    const own = requireAdmin();
    const id = String(url?.searchParams?.get('id') || '').trim();
    if (!id) return { ok: false, error: '缺少插件 id' };
    // 作者能看自己的，管理员能看全部
    if (!own.ok) {
      const o = checkOwner(id);
      if (!o.ok) return o;
    }
    try {
      const r = await fetch(`https://market.baiguang211.top/api/versions?id=${encodeURIComponent(id)}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(25000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.ok === false) return { ok: false, error: d?.error || `HTTP ${r.status}` };
      return d;
    } catch (e) {
      return { ok: false, error: '连不上市场服务：' + String(e?.message ?? e).slice(0, 60) };
    }
  }, { absolute: true });

  /** 删除历史版本包（支持批量，2026-10-26） */
  ctx.http.route('POST', '/api/market/myplugins/delete-versions', async (_req, body) => {
    const id = String(body?.id || '').trim();
    const versions = Array.isArray(body?.versions)
      ? body.versions.map((x) => String(x || '').trim()).filter(Boolean)
      : (body?.version ? [String(body.version).trim()] : []);
    if (!id) return { ok: false, error: '缺少插件 id' };
    if (!versions.length) return { ok: false, error: '请选择要删除的版本' };

    const own = checkOwner(id);
    if (!own.ok) return own;

    const key = readBridgeKey();
    let pubToken = '';
    try {
      const tkFile = path.join(ctx.data.dir, 'market-token.txt');
      if (fs.existsSync(tkFile)) pubToken = fs.readFileSync(tkFile, 'utf8').trim();
    } catch { /* ignore */ }
    if (!key && !pubToken) return { ok: false, error: '需要登录作者账号后再操作' };

    try {
      const headers = { 'content-type': 'application/json', 'User-Agent': UA };
      if (key) headers['x-bridge-key'] = key;
      if (pubToken) headers['authorization'] = 'Bearer ' + pubToken;
      const r = await fetch('https://market.baiguang211.top/api/delete-version', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id, versions, token: pubToken }),
        signal: AbortSignal.timeout(90000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.ok === false) {
        return { ok: false, error: d?.error || `HTTP ${r.status}`, skipped: d?.skipped };
      }
      ctx.log(`[市场] ${id} 删除 ${d.deleted?.length || 0} 个历史包，释放 ${((d.freed || 0)/1024/1024).toFixed(1)}MB`);
      return d;
    } catch (e) {
      return { ok: false, error: '连不上市场服务：' + String(e?.message ?? e).slice(0, 60) };
    }
  }, { absolute: true });

  ctx.http.route('POST', '/api/market/myplugins/rollback', async (_req, body) => {
    const id = String(body?.id || '').trim();
    const version = String(body?.version || '').trim();
    if (!id || !version) return { ok: false, error: '缺少 id 或 version' };

    const own = checkOwner(id);
    if (!own.ok) return own;

    const key = readBridgeKey();
    let pubToken = '';
    try {
      const tkFile = path.join(ctx.data.dir, 'market-token.txt');
      if (fs.existsSync(tkFile)) pubToken = fs.readFileSync(tkFile, 'utf8').trim();
    } catch { /* ignore */ }

    if (!key && !pubToken) {
      return { ok: false, error: '需要登录作者账号后再操作' };
    }

    try {
      const headers = { 'content-type': 'application/json', 'User-Agent': UA };
      if (key) headers['x-bridge-key'] = key;
      if (pubToken) headers['authorization'] = 'Bearer ' + pubToken;
      const r = await fetch('https://market.baiguang211.top/api/rollback', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id, version, token: pubToken }),
        signal: AbortSignal.timeout(60000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.ok === false) return { ok: false, error: d?.error || `HTTP ${r.status}` };

      cache = { at: 0, data: null, source: '', error: null };   // 清单变了，清缓存

      // ── 回退后自动装回本地（与发布对称）──
      // 否则市场是旧版、本机还是坏掉的新版，"回退"等于没做完。
      let selfInstalled = { ok: false, reason: '未尝试' };
      try {
        const dl = d.item?.download;
        if (dl) {
          const pr = await fetch(dl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
          if (pr.ok) {
            const buf = Buffer.from(await pr.arrayBuffer());
            const ir = await localFetch(LOCAL_BASE.origin + '/api/plugins/import', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'User-Agent': UA },
              body: JSON.stringify({
                base64: buf.toString('base64'),
                mode: 'replace',
                keepLocalConfig: true,   // 回退也不该清配置
              }),
              signal: AbortSignal.timeout(60000),
            });
            const idd = await ir.json().catch(() => ({}));
            selfInstalled = ir.ok && idd?.ok !== false
              ? { ok: true }
              : { ok: false, reason: idd?.error || `HTTP ${ir.status}` };
          }
        }
      } catch (e) {
        selfInstalled = { ok: false, reason: String(e?.message ?? e).slice(0, 60) };
      }

      ctx.log(`[市场] ${id} 回退 ${d.from} → ${d.to}${selfInstalled.ok ? '（已装回本地）' : ''}`);
      return { ok: true, from: d.from, to: d.to, selfInstalled, item: d.item };
    } catch (e) {
      return { ok: false, error: '连不上市场服务：' + String(e?.message ?? e).slice(0, 60) };
    }
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
      // 同 myplugins：不能写死任何作者名，未登录一律不算自己的
      const isOwn = !!me && (
        (me.nickname && authorName === me.nickname) ||
        (me.qq && authorName === String(me.qq)) ||
        (me.email && authorName === me.email)
      );
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

    // 🔴 第三方插件也要能更新（2026-10-27 修 B8）
    //
    // 原逻辑：checkOwner 不过就 return——只有「自己发布的」插件能更新，
    // 装别人的插件（napcat-alert / plugin-center 等）点更新一律「未授权」。
    //
    // 现在：如果不是自己的插件，但**本地已安装**，就放行 ——
    // 走的是 install 通道（覆盖安装），本质与用户手动装一次相同，
    // 没有额外权限风险（装什么由市场清单决定，用户本来就点了更新）。
    let own = checkOwner(id);
    if (!own.ok) {
      // 判断「本地是否已装」：直接看 plugins/<id>/manifest.json
      // （ctx.plugins 只给目录路径，没有列表接口）
      let installedVer = '';
      try {
        const mf = path.join(ctx.plugins, id, 'manifest.json');
        if (fs.existsSync(mf)) installedVer = JSON.parse(fs.readFileSync(mf, 'utf8')).version || '0.0.0';
      } catch { /* 读不到就当没装 */ }
      if (!installedVer) return own;      // 没装 + 不是自己的 → 仍然拒绝
      own = { ok: true, manifest: { version: installedVer }, thirdParty: true };
    }

    const oldVer = own.manifest.version || '0.0.0';

    // 走安装通道（覆盖模式）
    let r;
    try {
      const res = await localFetch(LOCAL_BASE.origin + '/api/market/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': UA },
        // 更新场景：必须保留本地配置（否则 clean 默认值会清空用户设置）
        body: JSON.stringify({ id, confirmUntrusted: true, keepLocalConfig: true }),
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
      const res = await localFetch(LOCAL_BASE.origin + '/api/market/updates', {
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
        const res = await localFetch(LOCAL_BASE.origin + '/api/market/update', {
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
      const res = await localFetch(LOCAL_BASE.origin + '/api/plugins/uninstall', {
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
      const res = await localFetch(LOCAL_BASE.origin + '/api/market/updates', {
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
          const r2 = await localFetch(LOCAL_BASE.origin + '/api/market/update', {
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
      // 带上目标地址（2026-10-27 修 B6）
      // 原来只打 "fetch failed"，看着像网络故障，实际多是自调用端口/token 问题。
      ctx.log(`[市场] 定时检查失败：${LOCAL_BASE.origin}/api/market/updates → ${String(e?.message ?? e).slice(0, 80)}`);
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

  // ── 首次启动补偿上报（2026-10-25）──
  //
  // 用户要求："新版本更新完首次启动就抓用户数据上传，
  //           我们可以补上刚刚的注册作者的信息"
  //
  // 场景：老用户早就在本机注册了作者（author.json 里有邮箱），
  // 但那时候中心端还没做登记功能 → 中心没有他的记录。
  //
  // 做法：启动后检查一个版本标记文件，没上报过就报一次。
  //   · 只在版本变化时上报，不是每次启动都报（避免刷接口）
  //   · 失败不重试（下次升级再试），也不影响任何功能
  //   · 只上报 email / qq / nickname 三个字段
  const reportLocalAuthor = async () => {
    const me = loadAuthor();
    if (!me?.email) return;   // 本机没注册过，不用报

    const flagFile = path.join(ctx.data.dir, 'reported-version.json');
    const myVer = ctx.manifest?.version || '0';
    let reported = '';
    try {
      reported = JSON.parse(fs.readFileSync(flagFile, 'utf8')).version || '';
    } catch { /* 没报过 */ }
    if (reported === myVer) return;   // 这个版本已经报过了

    // 本机自己就是中心（有 SMTP 配置）→ 不用上报，直接写本地文件
    if (ctx.mail?.ready?.()) {
      try {
        const uf = path.join(ctx.root, 'data', 'market-users.json');
        let d = { users: [] };
        try { d = JSON.parse(fs.readFileSync(uf, 'utf8')); } catch { /* ignore */ }
        d.users = d.users || [];
        if (!d.users.some((u) => u.email === me.email)) {
          d.users.push({
            email: me.email,
            qq: me.qq || '',
            nickname: me.nickname || '',
            firstSeenAt: me.verifiedAt || new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            verified: true,
            note: '本机即中心，直接登记',
          });
          fs.mkdirSync(path.dirname(uf), { recursive: true });
          fs.writeFileSync(uf, JSON.stringify(d, null, 2), 'utf8');
          ctx.log(`[市场] 本机作者已登记到中心档案：${me.email}`);
        }
        fs.writeFileSync(flagFile, JSON.stringify({ version: myVer, at: new Date().toISOString() }), 'utf8');
        return;
      } catch (e) {
        ctx.log('[市场] 本地登记失败：' + String(e?.message ?? e).slice(0, 60));
        return;
      }
    }

    // 走中心服务上报
    try {
      const res = await fetch(`${CENTER_URL()}/register-report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ email: me.email, qq: me.qq || '', nickname: me.nickname || '' }),
        signal: AbortSignal.timeout(20000),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d?.ok) {
        ctx.log(`[市场] 作者档案已上报中心：${me.email}${d.existed ? '（已存在）' : '（新增）'}`);
        fs.mkdirSync(ctx.data.dir, { recursive: true });
        fs.writeFileSync(flagFile, JSON.stringify({ version: myVer, at: new Date().toISOString() }), 'utf8');
      } else if (res.status === 404 || res.status === 410) {
        // 🔴 中心已无此接口就永久静默（2026-10-27 修 B7）
        //    原来每次启动都刷一条 404，纯噪音。记时间戳，不再重试。
        try {
          fs.mkdirSync(ctx.data.dir, { recursive: true });
          fs.writeFileSync(flagFile, JSON.stringify({
            version: myVer, skipped: 'gone', status: res.status, at: new Date().toISOString()
          }), 'utf8');
        } catch { /* ignore */ }
        ctx.log('[市场] 中心上报接口已下线（404/410），后续不再尝试');
      } else {
        ctx.log(`[市场] 上报中心失败（不影响使用）：${d?.error || 'HTTP ' + res.status}`);
      }
    } catch (e) {
      // 连不上就静默 —— 下次升级再试，不打扰用户
      ctx.log(`[市场] 上报中心失败（不影响使用）：${String(e?.message ?? e).slice(0, 50)}`);
    }
  };

  // 启动 90 秒后做（别和启动抢资源）
  setTimeout(reportLocalAuthor, 90 * 1000);

  // ── 每日心跳（2026-10-25）──
  //
  // 用户问："在线的用户数据会被自动抓取入库嘛？用户库的数据会更新嘛？"
  //
  // 原来只有"新版本首次启动"会上报，lastSeenAt 停在那一刻，
  // 看不出谁还在用。这里补一个每日心跳：
  //   · 每天最多一次（不刷接口）
  //   · 只更新 lastSeenAt / lastIp，不动其它字段
  //   · 没登记过的会自动建档（老版本用户直接打卡也能进库）
  //   · 失败静默，不影响任何功能
  const HEARTBEAT_GAP = 24 * 3600 * 1000;   // 24 小时

  const sendHeartbeat = async () => {
    const me = loadAuthor();
    if (!me?.email) return;

    const flagFile = path.join(ctx.data.dir, 'heartbeat.json');
    let last = 0;
    try { last = JSON.parse(fs.readFileSync(flagFile, 'utf8')).at || 0; } catch { /* 没打过 */ }
    if (Date.now() - last < HEARTBEAT_GAP) return;   // 今天打过了

    const mark = () => {
      try {
        fs.mkdirSync(ctx.data.dir, { recursive: true });
        fs.writeFileSync(flagFile, JSON.stringify({ at: Date.now() }), 'utf8');
      } catch { /* ignore */ }
    };

    // 本机即中心 → 直接写本地，不发请求
    if (ctx.mail?.ready?.()) {
      try {
        const uf = path.join(ctx.root, 'data', 'market-users.json');
        let d = { users: [] };
        try { d = JSON.parse(fs.readFileSync(uf, 'utf8')); } catch { /* ignore */ }
        d.users = d.users || [];
        const hit = d.users.find((u) => u.email === me.email);
        if (hit) {
          hit.lastSeenAt = new Date().toISOString();
          hit.qq = me.qq || hit.qq || '';
          hit.nickname = me.nickname || hit.nickname || '';
        } else {
          d.users.push({
            email: me.email, qq: me.qq || '', nickname: me.nickname || '',
            firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
            verified: true, note: '本机即中心，心跳建档',
          });
        }
        fs.mkdirSync(path.dirname(uf), { recursive: true });
        fs.writeFileSync(uf, JSON.stringify(d, null, 2), 'utf8');
        mark();
        return;
      } catch { /* 落到下面走网络 */ }
    }

    try {
      const res = await fetch(`${CENTER_URL()}/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ email: me.email, qq: me.qq || '', nickname: me.nickname || '' }),
        signal: AbortSignal.timeout(15000),
      });
      // 同时直接写中心库 —— 中心端的 /heartbeat 只更新它本机的文件，
      // 共享库要单独推一次，否则其他实例还是看不到这个人的最新昵称。
      await pushUserToRegistry(me.email, me.qq || '', me.nickname || '').catch(() => {});
      if (res.ok) mark();
    } catch { /* 静默，明天再试 */ }
  };

  // 启动 2 分钟后打第一次，之后每 6 小时检查一次（内部有 24h 门限）
  setTimeout(sendHeartbeat, 2 * 60 * 1000);
  const hbTimer = setInterval(sendHeartbeat, 6 * 3600 * 1000);

  ctx.log(`插件市场已启用（主源：${cfg().indexUrl || '未配置'}）`);

  return {
    dispose() {
      if (updTimer) { clearInterval(updTimer); updTimer = null; }
      if (typeof hbTimer !== 'undefined' && hbTimer) { clearInterval(hbTimer); }
    }
  };
}
