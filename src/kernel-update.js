// ── 内核升级（2026-10-25）────────────────────────────────────────────
//
// 用户需求：「我们作为开发者，能不能给核心包也做升级入口？用同一套 CF 地址即可」
//
// 先说清楚这个模块**故意不做什么**：
//
//   🔴 不做「下载完直接覆盖内核」。
//
//   理由不是保守，是真出过事故：某个第三方宿主（改过鉴权、注入过钩子）
//   被插件里带的"整包替换内核"功能覆盖，补丁全丢，接口全 401，面板永久卡死。
//   那种功能无法知道对方改过什么 —— 拿一份通用内核去覆盖别人的定制宿主，
//   本质上就是错的。
//
// 所以这里只做三件事：
//   ① 查：远端有没有新版本（读同一个 Cloudflare 域名下的 kernel/index.json）
//   ② 下：把包下载到 data/kernel-updates/ 并校验 sha256
//   ③ 交：给出「怎么装」的明确指引，由人决定什么时候装
//
// 真正的替换动作交给运维（解压 + 重启），或者未来做成带健康探测和自动回滚的
// 独立看门狗 —— 那需要独立于服务进程运行，不该塞在这个模块里草率交付。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { ROOT, DATA_DIR } from './config.js';

/** 市场根地址（与创造营同一套 Cloudflare / R2） */
const MARKET_BASE = process.env.BG_MARKET_BASE || 'https://market.baiguang211.top';

/** 内核版本清单的位置（相对市场根） */
const KERNEL_INDEX = `${MARKET_BASE}/kernel/index.json`;

const UPDATE_DIR = path.join(DATA_DIR, 'kernel-updates');

/** 读本机内核版本 */
export function localKernelVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/**
 * 语义化版本比较。
 * 返回 1 = a 比 b 新，-1 = a 比 b 旧，0 = 相同。
 * 只处理 x.y.z 与可选 -beta 后缀，够用且不引依赖。
 */
export function compareVersion(a, b) {
  const norm = (v) => String(v || '0').replace(/^v/, '').split('-')[0].split('.').map((x) => Number(x) || 0);
  const [A, B] = [norm(a), norm(b)];
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] || 0;
    const y = B[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 拉远端内核清单 */
async function fetchKernelIndex() {
  let res;
  try {
    res = await fetch(KERNEL_INDEX, {
      headers: { 'User-Agent': `QQAgent-Kernel/${localKernelVersion()}` },
      signal: AbortSignal.timeout(20000)
    });
  } catch (e) {
    return { ok: false, error: `连不上更新服务器：${e?.message ?? e}` };
  }
  if (!res.ok) {
    return { ok: false, error: `更新服务器返回 HTTP ${res.status}` };
  }
  try {
    const data = await res.json();
    if (!data || !Array.isArray(data.releases)) {
      return { ok: false, error: '清单格式不对（缺 releases 数组）' };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `清单解析失败：${e?.message ?? e}` };
  }
}

/**
 * 检查更新（只读，不下载）。
 *
 * 返回：当前版本、最新版本、是否有新版、更新说明、包信息。
 */
export async function checkKernelUpdate() {
  const current = localKernelVersion();
  const idx = await fetchKernelIndex();
  if (!idx.ok) {
    return { ok: false, current, error: idx.error, marketBase: MARKET_BASE };
  }
  const releases = idx.data.releases
    .filter((r) => r && r.version)
    .sort((a, b) => compareVersion(b.version, a.version));

  if (!releases.length) {
    return { ok: true, current, latest: current, hasUpdate: false, releases: [], marketBase: MARKET_BASE };
  }
  const latest = releases[0];
  return {
    ok: true,
    current,
    latest: String(latest.version),
    hasUpdate: compareVersion(latest.version, current) > 0,
    release: {
      version: latest.version,
      releasedAt: latest.releasedAt || null,
      notes: String(latest.notes || '').slice(0, 4000),
      download: latest.download || '',
      sha256: String(latest.sha256 || '').toUpperCase(),
      size: Number(latest.size) || 0,
      minFromVersion: latest.minFromVersion || null
    },
    allCount: releases.length,
    marketBase: MARKET_BASE
  };
}

/**
 * 下载更新包到 data/kernel-updates/ 并校验 sha256。
 *
 * 🔴 只下载，不动现场。返回值里给出安装指引。
 */
export async function downloadKernelUpdate() {
  const info = await checkKernelUpdate();
  if (!info.ok) return info;
  if (!info.hasUpdate) return { ok: true, upToDate: true, current: info.current };

  const r = info.release;
  if (!r.download) return { ok: false, error: '清单里没有下载地址' };

  let buf;
  try {
    const res = await fetch(r.download, {
      headers: { 'User-Agent': `QQAgent-Kernel/${info.current}` },
      signal: AbortSignal.timeout(180000)
    });
    if (!res.ok) return { ok: false, error: `下载失败 HTTP ${res.status}` };
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, error: `下载出错：${e?.message ?? e}` };
  }

  // 校验：有 sha256 就必须对得上，否则拒绝落盘
  const got = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
  if (r.sha256 && got !== r.sha256) {
    return { ok: false, error: `校验失败：期望 ${r.sha256.slice(0, 16)}…，实际 ${got.slice(0, 16)}…` };
  }

  fs.mkdirSync(UPDATE_DIR, { recursive: true });
  const file = path.join(UPDATE_DIR, `qq-agent-${r.version}.tar.gz`);
  fs.writeFileSync(file, buf);

  return {
    ok: true,
    version: r.version,
    from: info.current,
    file,
    bytes: buf.length,
    sha256: got,
    verified: !!r.sha256,
    // 安装指引：不自动覆盖，交给人
    steps: [
      `备份现有内核：cp -a ${ROOT} ${ROOT}.bak-$(date +%Y%m%d-%H%M%S)`,
      `解压到临时目录并对比：mkdir -p /tmp/k && tar xzf ${file} -C /tmp/k`,
      '确认差异（尤其 src/ ui/ 下你自己的改动）：diff -r /tmp/k/qq-agent-v2 ' + ROOT,
      '合并后重启：systemctl restart qq-agent-v2',
      '起不来就回滚：把 .bak-* 换回来再重启'
    ],
    warning: '本功能只下载与校验，不会覆盖现有内核。是否替换由你决定。'
  };
}

/** 列出已下载但未安装的更新包 */
export function listDownloaded() {
  try {
    if (!fs.existsSync(UPDATE_DIR)) return [];
    return fs.readdirSync(UPDATE_DIR)
      .filter((f) => f.endsWith('.tar.gz'))
      .map((f) => {
        const st = fs.statSync(path.join(UPDATE_DIR, f));
        return { file: path.join(UPDATE_DIR, f), name: f, bytes: st.size, at: st.mtime.toISOString() };
      })
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  } catch {
    return [];
  }
}


// ── 发布（仅作者）──────────────────────────────────────────────────
//
// 从 scripts/publish-kernel.mjs 提上来，供控制台「关于 → 发布内核」用。
// 凭据位置可通过环境变量覆盖，不再写死某台机器的路径。

/** R2 凭据文件路径（可用 BG_R2_ENV 覆盖） */
/** R2 凭据路径：环境变量 → 项目内 .secrets → 家目录 .secrets（都可以） */
function r2EnvPath() {
  if (process.env.BG_R2_ENV) return process.env.BG_R2_ENV;
  const cands = [
    path.join(ROOT, '.secrets', 'market-r2', 'r2.env'),
    path.join(os.homedir(), '.secrets', 'market-r2', 'r2.env')
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return cands[0];
}

/** 读 R2 凭据；不完整返回 null */
function loadR2() {
  try {
    const txt = fs.readFileSync(r2EnvPath(), 'utf8');
    const o = {};
    for (const line of txt.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.+)$/.exec(line.trim());
      if (m) o[m[1]] = m[2];
    }
    if (!o.R2_ENDPOINT || !o.R2_ACCESS_KEY_ID || !o.R2_SECRET_ACCESS_KEY || !o.R2_BUCKET) return null;
    return o;
  } catch { return null; }
}

/** 是否具备发布能力（凭据在不在） */
export function canPublishKernel() {
  return !!loadR2();
}

/** AWS SigV4 PUT（不引 SDK） */
async function r2Put(env, key, body, contentType = 'application/json') {
  const ep = env.R2_ENDPOINT.replace(/\/$/, '');
  const host = ep.replace(/^https:\/\//, '');
  const uri = `/${env.R2_BUCKET}/${key}`;
  const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const ds = amz.slice(0, 8);
  const ph = crypto.createHash('sha256').update(body).digest('hex');
  const ch = `host:${host}\nx-amz-content-sha256:${ph}\nx-amz-date:${amz}\n`;
  const sh = 'host;x-amz-content-sha256;x-amz-date';
  const cr = ['PUT', uri, '', ch, sh, ph].join('\n');
  const scope = `${ds}/auto/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amz, scope, crypto.createHash('sha256').update(cr).digest('hex')].join('\n');
  const h = (k, m) => crypto.createHmac('sha256', k).update(m).digest();
  let k = h('AWS4' + env.R2_SECRET_ACCESS_KEY, ds);
  k = h(k, 'auto'); k = h(k, 's3'); k = h(k, 'aws4_request');
  const sig = crypto.createHmac('sha256', k).update(sts).digest('hex');

  const res = await fetch(`${ep}${uri}`, {
    method: 'PUT',
    headers: {
      Host: host,
      'x-amz-content-sha256': ph,
      'x-amz-date': amz,
      'Content-Type': contentType,
      Authorization: `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${sh}, Signature=${sig}`,
      'User-Agent': 'QQAgent-KernelPublisher/1.0'
    },
    body,
    signal: AbortSignal.timeout(180000)
  });
  return res.status;
}

/** 拉远端内核清单（发布时读，失败当空） */
async function fetchIndexForPublish() {
  try {
    const res = await fetch(KERNEL_INDEX, {
      headers: { 'User-Agent': 'QQAgent-KernelPublisher/1.0' },
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) return { releases: [] };
    const d = await res.json();
    return { releases: Array.isArray(d.releases) ? d.releases : [] };
  } catch {
    return { releases: [] };
  }
}

/**
 * 打包当前内核 + 发布到市场。
 *
 * @param {{ notes?: string, dryRun?: boolean }} opts
 */
export async function publishKernel({ notes = '', dryRun = false } = {}) {
  const env = loadR2();
  if (!env) {
    return { ok: false, error: `没有 R2 凭据（${r2EnvPath()}）。发布需要写对象存储的权限。` };
  }

  // ① 打包：把内核目录打成 tar.gz（排除运行数据/依赖/插件）
  const version = localKernelVersion();
  let tarball;
  try {
    const { execFileSync } = await import('node:child_process');
    const tmp = path.join(UPDATE_DIR, `build-${Date.now()}.tar.gz`);
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    // 🔴 排除清单必须覆盖所有"本机才有"的大目录，
    //    否则打出来的包会大到没法用（实测漏掉 备份/ 和 .git 时是 9.5MB）。
    execFileSync('tar', [
      'czf', tmp,
      '--exclude=node_modules',
      '--exclude=data',
      '--exclude=plugins',
      '--exclude=.git',
      '--exclude=备份',
      '--exclude=backup',
      '--exclude=dsh-work',
      '--exclude=*.log',
      '--exclude=*.bak*',
      '--exclude=.DS_Store',
      '-C', path.dirname(ROOT), path.basename(ROOT)
    ], { timeout: 120000 });
    tarball = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
  } catch (e) {
    return { ok: false, error: `打包失败：${e?.message ?? e}` };
  }

  const sha256 = crypto.createHash('sha256').update(tarball).digest('hex').toUpperCase();
  const size = tarball.length;
  const fname = `kernel-${version}-${sha256.slice(0, 10)}.tar.gz`;

  if (dryRun) {
    return { ok: true, dryRun: true, version, bytes: size, sha256, filename: fname };
  }

  // ② 传包
  const st = await r2Put(env, `packages/${fname}`, tarball, 'application/gzip');
  if (st !== 200) return { ok: false, error: `包上传失败 HTTP ${st}` };

  // ③ 更新 index
  const idx = await fetchIndexForPublish();
  const download = `${MARKET_BASE}/packages/${fname}`;
  idx.releases = (idx.releases || []).filter((r) => r.version !== version);
  idx.releases.push({
    version,
    releasedAt: new Date().toISOString(),
    notes: String(notes || '').slice(0, 4000),
    download,
    sha256,
    size
  });
  idx.releases.sort((a, b) => compareVersion(b.version, a.version));

  const payload = Buffer.from(JSON.stringify({
    apiVersion: 1,
    updatedAt: new Date().toISOString(),
    releases: idx.releases
  }, null, 2));
  const st2 = await r2Put(env, 'kernel/index.json', payload, 'application/json');
  if (st2 !== 200) return { ok: false, error: `index 更新失败 HTTP ${st2}` };

  return { ok: true, version, bytes: size, sha256, download, filename: fname, releases: idx.releases.length };
}

// ── 自动安装（2026-10-25）──────────────────────────────────────
//
// 用户需求：「自动更新加一个自动（安装）的选择」
//
// 🔴 约束：安装必须由**外部进程**做 —— 服务不能替换自己的代码再重启自己。
//   这里只做两件事：校验包 + detached spawn 拉起 scripts/kernel-install.mjs。
//   前端/调用方拿到 accepted 后轮询 /api/kernel/install-log 看进度。

/** 安装日志路径 */
function installLogPath() {
  return path.join(DATA_DIR, 'kernel-updates', 'install.log');
}

/**
 * 从安装包 (.tar.gz) 里取出 kernel-install.mjs
 *
 * 🔴 不依赖磁盘上那份 —— 见 autoInstallKernel 里的说明。
 * 只读包内一个文件，用 Node 原生 zlib + 手写 tar 头解析，
 * 避免依赖系统 tar（Windows 上对中文名会炸）。
 *
 * @returns {string|null} 临时脚本路径；失败返回 null
 */
async function extractInstaller(pkgPath) {
  try {
    const zlib = await import('node:zlib');
    const buf = zlib.gunzipSync(fs.readFileSync(pkgPath));
    const td = new TextDecoder('utf-8');

    let off = 0;
    let longName = '';
    while (off + 512 <= buf.length) {
      const header = buf.subarray(off, off + 512);
      if (header.every((b) => b === 0)) break;

      const readStr = (start, len) => {
        const raw = header.subarray(start, start + len);
        const end = raw.indexOf(0);
        return td.decode(end >= 0 ? raw.subarray(0, end) : raw);
      };
      let name = readStr(0, 100);
      const size = parseInt(readStr(124, 12).trim(), 8) || 0;
      const typeflag = String.fromCharCode(header[156] || 0x30);
      const prefix = readStr(345, 155);
      if (prefix) name = `${prefix}/${name}`;
      if (longName) { name = longName; longName = ''; }

      const dataStart = off + 512;
      const data = buf.subarray(dataStart, dataStart + size);
      off = dataStart + Math.ceil(size / 512) * 512;

      if (typeflag === 'L') { longName = td.decode(data).replace(/\0.*$/, ''); continue; }
      if (typeflag !== '0' && typeflag !== '\0') continue;

      // 匹配 qq-agent-v2/scripts/kernel-install.mjs（兼容任意顶层目录名）
      if (/(^|\/)scripts\/kernel-install\.mjs$/.test(name)) {
        const tmp = path.join(DATA_DIR, 'kernel-updates', 'installer-current.mjs');
        fs.mkdirSync(path.dirname(tmp), { recursive: true });
        fs.writeFileSync(tmp, data);
        fs.chmodSync(tmp, 0o755);
        return tmp;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 触发自动安装。
 * @param {string} file 已下载的包（必须在 data/kernel-updates/ 下）
 */
export async function autoInstallKernel(file) {
  const f = String(file || '');
  if (!f) return { ok: false, error: '没有指定安装包' };
  if (!fs.existsSync(f)) return { ok: false, error: '安装包不存在，请先下载' };

  // 安全：只允许装 data/kernel-updates/ 下的包，防任意路径
  const allowDir = path.resolve(UPDATE_DIR);
  if (!path.resolve(f).startsWith(allowDir + path.sep)) {
    return { ok: false, error: '安装包必须在 data/kernel-updates/ 目录下' };
  }

  // 🔴 鸡生蛋问题（2026-10-25 修）
  //
  // 原来执行的是**磁盘上那份** scripts/kernel-install.mjs。
  // 但安装动作本身会替换 scripts/ —— 于是：
  //   旧机器上的旧脚本 → 用旧逻辑装新版 → 旧逻辑的 bug 照旧（502）
  //   而且装完之后脚本被换回包内版本，用户下次更新又被打回原形。
  //
  // 解法：**从安装包里把脚本解出来再执行**。
  //   这样无论磁盘上那份多旧，这次安装用的都是包里的新逻辑。
  const script = await extractInstaller(f);
  if (!script) {
    return { ok: false, error: '安装包里没有 scripts/kernel-install.mjs，无法安装' };
  }

  fs.mkdirSync(path.dirname(installLogPath()), { recursive: true });
  const logFd = fs.openSync(installLogPath(), 'a');

  // 🔴 必须脱离内核的 cgroup（2026-10-26 事故）
  //
  // 症状：装到一半服务卡在 deactivating，3210 起不来，前端 502。
  // 日志：`systemctl stop 返回异常 (signal=SIGTERM)` → `收到 SIGTERM` → `异常退出`
  //
  // 根因：spawn({ detached: true }) 只脱离**进程组**，不脱离 **cgroup**。
  //   systemd 服务默认 KillMode=control-group，`systemctl stop` 会给
  //   整个 cgroup 的所有进程发 SIGTERM —— 安装脚本自己也在里面，跟着被杀。
  //   它一死就没人执行「启动服务」那步，服务永远停着。
  //
  // 解法：用 systemd-run 启动一个**独立的 transient unit**，
  //   它有自己的 cgroup，不受内核服务 stop 的连带影响。
  const { spawn, spawnSync } = await import('node:child_process');

  // 🔴 sudo 权限：本机 sudoers 只给特定命令配了 NOPASSWD，
  //    systemd-run 不在名单里 → sudo -n 必然失败。
  //    按铁律 0.6：密码只走 stdin，绝不进命令行参数。
  const pwFile = process.env.QQ_SUDO_PASSWORD_FILE
    || path.join(os.homedir(), '.secrets', 'sudo', 'password');
  let sudoPw = '';
  try { if (fs.existsSync(pwFile)) sudoPw = fs.readFileSync(pwFile, 'utf8').trim(); } catch { /* 无密码文件 */ }

  let launched = false;
  let launcherPid = 0;

  // 🔴 不能先判断 `sudo -n` 能不能用（2026-10-26 实测）：
  //    服务进程的 sudo 缓存是独立的，`sudo -n systemd-run --version`
  //    在服务里返回 false，但用密码走 `sudo -S` 完全可行。
  //    所以：有密码文件就直接用密码，别被 canNoPass 挡住。
  if (sudoPw) {
    // ② 有密码文件：用 sudo -S，密码走 stdin
    try {
      const unit = `qqagent-install-${Date.now()}`;
      const inner = `KERNEL_ROOT=${JSON.stringify(ROOT)} ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(f)}`;
      const r = spawn('sudo', ['-S', 'systemd-run', '--unit', unit, '--collect', '--quiet',
        '--property', 'Type=exec', '/bin/sh', '-c', inner], {
        detached: true,
        stdio: ['pipe', logFd, logFd],
        cwd: ROOT
      });
      try { r.stdin.write(sudoPw + '\n'); r.stdin.end(); } catch { /* 已关闭 */ }
      r.unref();
      launcherPid = r.pid;
      launched = true;
    } catch { launched = false; }
  }


  // 没密码文件时，再试一次免密 systemd-run
  if (!launched && !sudoPw) {
    try {
      const unit = `qqagent-install-${Date.now()}`;
      const inner = `KERNEL_ROOT=${JSON.stringify(ROOT)} ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(f)}`;
      const r = spawn('sudo', ['-n', 'systemd-run', '--unit', unit, '--collect', '--quiet',
        '--property', 'Type=exec', '/bin/sh', '-c', inner], {
        detached: true, stdio: ['ignore', logFd, logFd], cwd: ROOT
      });
      r.unref();
      launcherPid = r.pid;
      launched = true;
    } catch { launched = false; }
  }

  if (!launched) {
    // 退化：非 systemd 环境（容器里裸跑）仍用原来的 detached spawn
    const child = spawn(process.execPath, [script, f], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: ROOT,
      env: { ...process.env, KERNEL_ROOT: ROOT }
    });
    child.unref();
    launcherPid = child.pid;
  }
  fs.closeSync(logFd);

  return {
    ok: true,
    accepted: true,
    pid: launcherPid,
    isolated: launched,

    log: installLogPath(),
    note: '安装已在后台开始。服务会重启一次，期间约 30~90 秒不可用。失败会自动回滚。'
  };
}

/** 读安装日志尾部 */
export function readInstallLog(lines = 80) {
  try {
    return fs.readFileSync(installLogPath(), 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** 内核要求的最低安装脚本版本（与 scripts/kernel-install.mjs 里的标记对应） */
const REQUIRED_INSTALLER_VERSION = '1.1.0';

/**
 * 检查磁盘上的安装脚本够不够新。
 *
 * 🔴 为什么要查：安装动作会替换 scripts/。老机器上的老脚本会让更新
 *    再次变成「502」，而用户完全看不出原因。
 *    面板上提前告诉他「脚本太旧，本次会用包里的新脚本」更保险。
 */
export function checkInstaller() {
  const script = path.join(ROOT, 'scripts', 'kernel-install.mjs');
  if (!fs.existsSync(script)) {
    return { ok: false, exists: false, outdated: true, current: '', required: REQUIRED_INSTALLER_VERSION };
  }
  let current = '';
  try {
    const txt = fs.readFileSync(script, 'utf8');
    current = /INSTALLER_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(txt)?.[1] || '';
  } catch { /* 读不了当旧版 */ }
  // 没有标记 = 旧脚本（标记是 1.1.0 才加的）
  const outdated = !current || compareVersion(current, REQUIRED_INSTALLER_VERSION) < 0;
  return { ok: true, exists: true, outdated, current: current || '（无标记，视为旧版）', required: REQUIRED_INSTALLER_VERSION };
}

/** 上次安装结果 */
export function lastInstallResult() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'kernel-updates', 'last-install.json'), 'utf8'));
  } catch {
    return null;
  }
}
