// NapCat WebUI 客户端（账密登录 / 人机验证 / 快速登录）
//
// 背景：QQ 经常风控掉线，扫码恢复很麻烦。NapCat 本身提供账号密码登录，
// 但它的 WebUI 在 127.0.0.1:6099，用户从外部访问不到，且需要 sha256(token+'.napcat') 鉴权。
// 这里把它代理进控制台（控制台已有 Basic Auth 保护），让用户直接在面板里完成
// 「账号密码登录 + 人机验证」，不必再找管理员扫码。
//
// NapCat 侧接口契约（逆向自 static/assets/qq_login-*.js，2026-09-14）：
//   POST /api/auth/login            { hash: sha256(token + '.napcat') }  -> { data: { Credential } }
//   POST /api/QQLogin/PasswordLogin { uin, passwordMd5 }
//        -> { needCaptcha: true, proofWaterUrl } | { needNewDevice, jumpUrl, newDevicePullQrCodeSig } | null
//   POST /api/QQLogin/CaptchaLogin  { uin, passwordMd5, ticket, randstr, sid }
//   POST /api/QQLogin/NewDeviceLogin{ uin, passwordMd5, newDevicePullQrCodeSig }
//   POST /api/QQLogin/CheckLoginStatus | GetQuickLoginList | SetQuickLoginQQ | RefreshQRcode
//
// 安全：**密码只在浏览器里做 MD5，明文永不经过本服务**（与 NapCat 官方前端一致）。
//       本模块只接触 passwordMd5，且不写日志。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import QRCode from 'qrcode';

const HOME = process.env.HOME || '';

/** NapCat 注入目录的候选位置（与其 cache/qrcode.png 同级）。 */
function napcatDirCandidates(extraDir = '') {
  return [
    process.env.NAPCAT_DIR,
    extraDir || '',
    HOME ? path.join(HOME, 'napcat/opt/opt/QQ/resources/app/app_launcher/napcat') : '',
    '/opt/QQ/resources/app/app_launcher/napcat',
    HOME ? path.join(HOME, '.config/QQ/NapCat') : ''
  ].filter(Boolean);
}

/** 找到 NapCat 目录（含 config/webui.json 的那个）。 */
export function findNapcatDir(extraDir = '') {
  for (const d of napcatDirCandidates(extraDir)) {
    try {
      if (fs.existsSync(path.join(d, 'config', 'webui.json'))) return d;
    } catch { /* 继续 */ }
  }
  return '';
}

function readWebuiCfg(dir) {
  try {
    const p = path.join(dir, 'config', 'webui.json');
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { token: String(c.token || ''), host: String(c.host || '::'), port: Number(c.port) || 6099 };
  } catch {
    return null;
  }
}

/** WebUI 基址：host 是 '::'/'0.0.0.0' 时按 127.0.0.1 连。 */
function baseUrl(cfg) {
  const h = (cfg.host === '::' || cfg.host === '0.0.0.0' || !cfg.host) ? '127.0.0.1' : cfg.host;
  return `http://${h}:${cfg.port}`;
}

export class NapCatWebui {
  constructor({ napcatDir = '', log = () => {} } = {}) {
    this.napcatDir = napcatDir;
    this.log = log;
    this._cred = '';
    this._credAt = 0;
  }

  dir(extraDir = '') {
    return this.napcatDir || findNapcatDir(extraDir) || '';
  }

  /** 是否可用（能找到 webui.json 且有 token）。 */
  available(extraDir = '') {
    const d = this.dir(extraDir);
    if (!d) return false;
    const cfg = readWebuiCfg(d);
    return !!(cfg && cfg.token);
  }

  /** 详情（供前端展示，绝不返回 token 本身）。 */
  info(extraDir = '') {
    const d = this.dir(extraDir);
    const cfg = d ? readWebuiCfg(d) : null;
    return { dir: d, available: !!(cfg && cfg.token), port: cfg?.port || null };
  }

  /** 取 Credential（带缓存；401 时自动重取一次）。 */
  async credential(extraDir = '') {
    const d = this.dir(extraDir);
    const cfg = d ? readWebuiCfg(d) : null;
    if (!cfg || !cfg.token) throw new Error('找不到 NapCat WebUI 配置（webui.json）');
    // 缓存 5 分钟（NapCat 的 Credential 有效期未公开，取保守值；
    // 失效时 call() 会自动丢弃并重取，所以缓存过期不影响正确性）
    if (this._cred && Date.now() - this._credAt < 5 * 60 * 1000) return this._cred;
    const hash = crypto.createHash('sha256').update(cfg.token + '.napcat').digest('hex');
    const res = await fetch(baseUrl(cfg) + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json().catch(() => ({}));
    const cred = data?.data?.Credential;
    if (!cred) throw new Error('NapCat WebUI 登录失败：' + JSON.stringify(data).slice(0, 200));
    this._cred = cred;
    this._credAt = Date.now();
    return cred;
  }

  /** 调用 NapCat 的 /api/QQLogin/<ep>。返回 data 字段。 */
  async call(ep, body = {}, extraDir = '') {
    const d = this.dir(extraDir);
    const cfg = d ? readWebuiCfg(d) : null;
    if (!cfg) throw new Error('找不到 NapCat WebUI 配置');
    const doCall = async (cred) => {
      const res = await fetch(`${baseUrl(cfg)}/api/QQLogin/${ep}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cred },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(60000)
      });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    };
    // Credential 失效的判定（2026-09-15 修）：
    // ⚠️ NapCat 失败时返回的是 **HTTP 200** + body {"code":-1,"message":"Unauthorized"}，
    //    不是 401！旧代码只检查 status===401/code===401，于是永远不重试，
    //    表现为面板报 "Unauthorized" 且缓存一旦过期就再也调不通。
    const isAuthFail = (x) => {
      if (!x) return false;
      if (x.status === 401) return true;
      const c = x.data?.code;
      if (c === 401) return true;
      const msg = String(x.data?.message || '');
      return c === -1 && /unauthor/i.test(msg);
    };
    let r = await doCall(await this.credential(extraDir));
    if (isAuthFail(r)) {
      this._cred = '';                                  // 丢掉过期凭据
      r = await doCall(await this.credential(extraDir));
    }
    // NapCat 用 { code, data, message }；code!==0 视为失败
    if (r.data && typeof r.data.code === 'number' && r.data.code !== 0) {
      const err = new Error(r.data.message || ('NapCat 返回 code=' + r.data.code));
      err.napcatCode = r.data.code;
      throw err;
    }
    return r.data?.data ?? null;
  }

  // ── 业务封装 ──
  loginStatus(extraDir) { return this.call('CheckLoginStatus', {}, extraDir); }
  quickList(extraDir) { return this.call('GetQuickLoginList', {}, extraDir); }
  setQuickLogin(uin, extraDir) { return this.call('SetQuickLoginQQ', { uin: String(uin) }, extraDir); }
  refreshQr(extraDir) { return this.call('RefreshQRcode', {}, extraDir); }

  /** 账密登录。uin=QQ号，passwordMd5=浏览器算好的 32 位小写 MD5。 */
  passwordLogin(uin, passwordMd5, extraDir) {
    return this.call('PasswordLogin', { uin: String(uin), passwordMd5: String(passwordMd5) }, extraDir);
  }

  /** 人机验证通过后补交 ticket/randstr 完成登录。 */
  captchaLogin(uin, passwordMd5, ticket, randstr, sid, extraDir) {
    return this.call('CaptchaLogin', {
      uin: String(uin), passwordMd5: String(passwordMd5),
      ticket: String(ticket), randstr: String(randstr), sid: String(sid || '')
    }, extraDir);
  }

  /** 新设备验证第一步：提交登录（会返回 needNewDevice + jumpUrl + sig）。 */
  newDeviceLogin(uin, passwordMd5, sig, extraDir) {
    return this.call('NewDeviceLogin', {
      uin: String(uin), passwordMd5: String(passwordMd5), newDevicePullQrCodeSig: String(sig || '')
    }, extraDir);
  }

  // ── 新设备扫码验证（jumpUrl → 二维码 → 轮询 → 提交 token）──
  // 流程（逆向自 NapCat WebUI 前端）：
  //   1) GetNewDeviceQRCode { uin, jumpUrl }  -> { str_url, bytes_token, uint32_guarantee_status }
  //   2) 把 str_url 渲染成二维码，让用户用**手机 QQ** 扫
  //   3) PollNewDeviceQR { uin, bytesToken } 每 2.5 秒轮询：
  //        uint32_guarantee_status: 3=已扫码  1=已在手机确认 -> 返回 str_nt_succ_token
  //   4) NewDeviceLogin { uin, passwordMd5, newDevicePullQrCodeSig: str_nt_succ_token } 完成登录

  /**
   * 取新设备验证二维码（str_url 是给手机 QQ 扫的）。
   *
   * ⚠️ **必须补 bytes_token**（2026-09-15 修，用户报"扫码过了但不自动登录"）：
   *   NapCat 的 GetNewDeviceQRCode 有时只返回 str_url，**bytes_token 为空**；
   *   而后续的 PollNewDeviceQR 明确要求 bytesToken（空则报 "uin and bytesToken are required"）
   *   → 轮询永远失败 → 手机确认后**拿不到 str_nt_succ_token** → 不会自动登录。
   *   用户重新点登录时，QQ 已记住这次验证，于是"免验证"直接成功 —— 正是用户观察到的现象。
   *
   *   官方 WebUI 前端的做法（照抄）：bytes_token 为空时，从 str_url 的 query 里取
   *   str_url 参数并 base64 编码作为替代 token。
   */
  async getNewDeviceQr(uin, jumpUrl, extraDir) {
    const r = await this.call('GetNewDeviceQRCode', { uin: String(uin), jumpUrl: String(jumpUrl) }, extraDir);
    if (!r || !r.str_url) return r;
    let token = r.bytes_token || '';
    if (!token) {
      // 回退：从 str_url 里取 str_url 查询参数 → base64（与官方前端一致）
      try {
        const inner = new URL(r.str_url).searchParams.get('str_url') || '';
        token = inner ? Buffer.from(inner, 'utf8').toString('base64') : '';
      } catch {
        token = '';
      }
      if (token) r.bytes_token = token;
    }
    return r;
  }

  /** 轮询新设备验证状态。 */
  pollNewDeviceQr(uin, bytesToken, extraDir) {
    return this.call('PollNewDeviceQR', { uin: String(uin), bytesToken: String(bytesToken) }, extraDir);
  }

  // ── 设备指纹（缓解风控掉线）──
  /** 重置设备 ID（删 Registry20）。换设备指纹后 QQ 可能不再判定异常，但需重新验证。 */
  resetDeviceId(extraDir) { return this.call('ResetDeviceID', {}, extraDir); }
  getDeviceGuid(extraDir) { return this.call('GetDeviceGUID', {}, extraDir); }
  getGuidBackups(extraDir) { return this.call('GetGUIDBackups', {}, extraDir); }
  setDeviceGuid(guid, extraDir) { return this.call('SetDeviceGUID', { guid: String(guid) }, extraDir); }
  createGuidBackup(extraDir) { return this.call('CreateGUIDBackup', {}, extraDir); }
  restoreGuidBackup(name, extraDir) { return this.call('RestoreGUIDBackup', { name: String(name) }, extraDir); }
  /**
   * 把新设备验证的 str_url 渲染成二维码 dataURL（服务端生成，前端直接 <img src>）。
   * 用成熟库 qrcode（MIT）而不是自己实现编码 —— 二维码容错要求高，
   * 自研编码容易出现"看着对但扫不出来"的问题。
   */
  async newDeviceQrDataUrl(strUrl, { width = 260 } = {}) {
    return await QRCode.toDataURL(String(strUrl), {
      errorCorrectionLevel: 'M',
      margin: 2,
      width
    });
  }

  restartNapCat(extraDir) { return this.call('RestartNapCat', {}, extraDir); }
}
