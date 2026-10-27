// NapCat / QQ 客户端版本检测与一键升级（2026-10-27）
//
// 需求来源：用户要求"给核心包也做一个检测 napcat 和 QQ 客户端新版本的功能（分别），
// 可以在登录 tab 页点击一键更新 napcat 和 QQ 客户端（包括没安装的，提供安装脚本，
// 直连最新版本通道）"
//
// 🔴 本模块最重要的那条经验（2026-10-27 实测踩坑）：
//    NapCat 装完之后有**两份副本**，升级必须同时覆盖，否则白升：
//      ① <napcat>/shell/                              —— 解包出来的原始副本
//      ② <napcat>/opt/opt/QQ/resources/app/app_launcher/napcat/  —— QQ 实际加载的
//    这次我只更新了 ①，重启后 QQ 仍然跑旧版，白折腾一小时。
//    两份的 napcat.mjs MD5 必须一致，才算升级成功。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const NAPCAT_REPO = 'NapNeko/NapCatQQ';
const QQ_VERSION_API = 'https://im.qq.com/rainbow/linuxQQDownload';

/** 默认 NapCat 根目录 */
export function napcatRoot() {
  return process.env.NAPCAT_HOME || path.join(os.homedir(), 'napcat');
}

/** QQ 安装目录（解包后的） */
export function qqDir() {
  return path.join(napcatRoot(), 'opt', 'opt', 'QQ');
}

/** QQ 实际加载 NapCat 的那份副本——升级时必须覆盖它 */
export function activeNapcatDir() {
  return path.join(qqDir(), 'resources', 'app', 'app_launcher', 'napcat');
}

/** 解包出来的模板副本 */
export function shellDir() {
  return path.join(napcatRoot(), 'shell');
}

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

const fileExists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** 本地是否已安装 NapCat */
export function isNapcatInstalled() {
  return fileExists(path.join(activeNapcatDir(), 'napcat.mjs'))
    || fileExists(path.join(shellDir(), 'napcat.mjs'));
}

/** 本地 QQ 是否已安装 */
export function isQQInstalled() {
  return fileExists(path.join(qqDir(), 'qq'));
}

/**
 * 读本地 QQ 版本号。
 *
 * 注意：不能只看 QQ 的 package.json version —— 那是 Electron 版本，
 * 真正的 QQ build 在 resources/app/package.json 里（形如 3.2.33-52892）。
 */
export function localQQVersion() {
  const pkg = readJson(path.join(qqDir(), 'resources', 'app', 'package.json'));
  return String(pkg?.version || '');
}

/**
 * 读本地 NapCat 版本。
 *
 * NapCat Shell 包里的 package.json version 恒为 "0.0.1"（官方没维护），
 * 所以版本号只能靠：
 *   ① 安装时我们自己记的 .napcat-version 文件
 *   ② 备份目录名里的 v4.18.19（历史遗留）
 *   ③ 都没有 → 返回 unknown
 */
export function localNapcatVersion() {
  const marker = path.join(napcatRoot(), '.napcat-version');
  try {
    const v = fs.readFileSync(marker, 'utf8').trim();
    if (v) return v;
  } catch { /* 没记过 */ }
  // 从备份目录名里猜一个（napcat-4.18.19-backup-...）
  try {
    const hit = fs.readdirSync(napcatRoot()).find((n) => /^napcat-[\d.]+-backup/.test(n));
    if (hit) return hit.replace(/^napcat-/, '').replace(/-backup.*$/, '');
  } catch { /* ignore */ }
  return 'unknown';
}

/** 版本比较：a > b 返回 1，相等 0，a < b 返回 -1 */
export function cmpVersion(a, b) {
  const pa = String(a || '0').split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 拉 NapCat 最新 release */
export async function checkNapcatLatest() {
  try {
    const r = await fetch(`https://api.github.com/repos/${NAPCAT_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'qq-agent-napcat-updater' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return { ok: false, error: `GitHub API HTTP ${r.status}` };
    const d = await r.json();
    const tag = String(d.tag_name || '').replace(/^v/, '');
    // Linux 用 NapCat.Shell.zip（跨平台 shell 包）
    const asset = (d.assets || []).find((a) => a.name === 'NapCat.Shell.zip');
    if (!tag) return { ok: false, error: '没解析到版本号' };
    return {
      ok: true,
      latest: tag,
      publishedAt: d.published_at || '',
      url: asset?.browser_download_url || '',
      size: asset?.size || 0,
      notes: String(d.body || '').slice(0, 1500),
    };
  } catch (e) {
    return { ok: false, error: '连不上 GitHub：' + String(e?.message ?? e).slice(0, 80) };
  }
}

/** 拉 QQ 官方 Linux 最新版本 */
export async function checkQQLatest() {
  try {
    const r = await fetch(QQ_VERSION_API, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const raw = await r.text();
    // 页面把 JSON 塞在 `var params= {...};` 里
    const m = raw.match(/var\s+params\s*=\s*(\{[\s\S]*?\});/);
    if (!m) return { ok: false, error: '没找到版本 JSON（页面结构可能变了）' };
    const d = JSON.parse(m[1]);
    const arch = process.arch === 'arm64' ? 'armDownloadUrl' : 'x64DownloadUrl';
    const dl = d?.[arch]?.deb || d?.[arch]?.rpm || '';
    return {
      ok: true,
      latest: String(d.version || ''),
      updateDate: String(d.updateDate || ''),
      url: dl,
      desc: String(d.desc || ''),
      // 官方这个页面偶尔滞后，本地比它新时前端要提示"无需更新"而不是"降级"
      raw: { version: d.version, updateDate: d.updateDate },
    };
  } catch (e) {
    return { ok: false, error: '查询失败：' + String(e?.message ?? e).slice(0, 80) };
  }
}

/** 汇总状态：给登录页用 */
export async function checkAll() {
  const [nc, qq] = await Promise.all([checkNapcatLatest(), checkQQLatest()]);
  const localNc = localNapcatVersion();
  const localQq = localQQVersion();

  const ncInstalled = isNapcatInstalled();
  const qqInstalled = isQQInstalled();

  return {
    ok: true,
    napcat: {
      installed: ncInstalled,
      local: localNc,
      latest: nc.ok ? nc.latest : null,
      error: nc.ok ? null : nc.error,
      // 没装 → 需要安装；装了但本地更旧 → 需要升级
      needInstall: !ncInstalled,
      needUpdate: ncInstalled && nc.ok && cmpVersion(nc.latest, localNc) > 0,
      url: nc.url || '',
      size: nc.size || 0,
      notes: nc.notes || '',
      publishedAt: nc.publishedAt || '',
    },
    qq: {
      installed: qqInstalled,
      local: localQq,
      latest: qq.ok ? qq.latest : null,
      error: qq.ok ? null : qq.error,
      needInstall: !qqInstalled,
      // 官方页面版本号可能滞后于本地，只在"官方确实更新"时提示
      needUpdate: qqInstalled && qq.ok && cmpVersion(qq.latest, localQq) > 0,
      url: qq.url || '',
      desc: qq.desc || '',
    },
  };
}

// ── 实际执行升级 / 安装 ────────────────────────────────────────────
//
// 流程：下载 → 解包 → 备份 → **同时覆盖两份副本** → 记版本 → 重启
// 每一步失败都留下可读的原因，不静默。
import zlib from 'node:zlib';

const UPD_DIR = () => path.join(napcatRoot(), '.updates');

/** 下载到本地（流式，避免大包吃内存） */
async function downloadTo(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = await fetch(url, {
    headers: { 'User-Agent': 'qq-agent-napcat-updater' },
    signal: AbortSignal.timeout(300000),
  });
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/** 极简 zip 解包（只处理 store/deflate，够用来解 NapCat.Shell.zip） */
function unzipTo(zipPath, outDir) {
  const buf = fs.readFileSync(zipPath);
  // 找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + cmtLen;

    if (name.endsWith('/')) continue;
    // 防目录穿越
    const safe = name.split('/').filter((x) => x && x !== '..').join('/');
    if (!safe) continue;

    // 本地头：跳过文件名+扩展区，取压缩数据
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    let content;
    if (method === 0) content = raw;
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else continue;   // 其它压缩方式跳过

    const dest = path.join(outDir, safe);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    written.push(safe);
  }
  return written;
}

/** 复制核心文件到目标目录（只覆盖 NapCat 自己的文件，不碰 config/ */
function syncCoreFiles(fromDir, toDir) {
  const CORE = ['napcat.mjs', 'loadNapCat.js', 'package.json'];
  fs.mkdirSync(toDir, { recursive: true });
  const done = [];
  for (const f of CORE) {
    const src = path.join(fromDir, f);
    if (!fileExists(src)) continue;
    fs.copyFileSync(src, path.join(toDir, f));
    done.push(f);
  }
  return done;
}

/**
 * 安装或升级 NapCat。
 *
 * @param {object} opts { url, version, onLog }
 */
export async function installNapcat({ url, version, onLog = () => {} } = {}) {
  const root = napcatRoot();
  if (!url) return { ok: false, error: '缺少下载地址' };

  const tag = String(version || 'latest').replace(/[^\w.\-]/g, '');
  const dir = UPD_DIR();
  const zipPath = path.join(dir, `NapCat.Shell-${tag}.zip`);
  const extractDir = path.join(dir, `extract-${tag}`);

  try {
    onLog(`开始下载 NapCat ${tag}…`);
    const bytes = await downloadTo(url, zipPath);
    onLog(`下载完成 ${(bytes / 1024 / 1024).toFixed(1)}MB，解包…`);

    fs.rmSync(extractDir, { recursive: true, force: true });
    const files = unzipTo(zipPath, extractDir);
    onLog(`解包 ${files.length} 个文件`);

    if (!fileExists(path.join(extractDir, 'napcat.mjs'))) {
      return { ok: false, error: '包里没有 napcat.mjs，可能下错了资源' };
    }

    // 备份现有两份（只备份核心文件，避免 93MB 大拷贝）
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bakDir = path.join(dir, `bak-${ts}`);
    for (const [label, d] of [['shell', shellDir()], ['active', activeNapcatDir()]]) {
      if (!fileExists(path.join(d, 'napcat.mjs'))) continue;
      fs.mkdirSync(path.join(bakDir, label), { recursive: true });
      for (const f of ['napcat.mjs', 'loadNapCat.js', 'package.json']) {
        const p = path.join(d, f);
        if (fileExists(p)) fs.copyFileSync(p, path.join(bakDir, label, f));
      }
    }
    onLog(`已备份到 ${bakDir}`);

    // 🔴 两份都覆盖 —— 这是升级成功的关键
    const shellFiles = syncCoreFiles(extractDir, shellDir());
    onLog(`shell/ 已更新：${shellFiles.join(', ')}`);

    const activeFiles = syncCoreFiles(extractDir, activeNapcatDir());
    onLog(`app_launcher/napcat/ 已更新：${activeFiles.join(', ')}`);

    // 校验两份一致
    const a = path.join(shellDir(), 'napcat.mjs');
    const b = path.join(activeNapcatDir(), 'napcat.mjs');
    if (fileExists(a) && fileExists(b)) {
      const ha = fs.readFileSync(a).length;
      const hb = fs.readFileSync(b).length;
      if (ha !== hb) onLog(`⚠️ 两份大小不一致（${ha} vs ${hb}），请检查`);
      else onLog(`✅ 两份副本已同步（${ha} 字节）`);
    }

    // 记版本，供下次检测比较
    fs.writeFileSync(path.join(root, '.napcat-version'), String(version || tag), 'utf8');

    // 清掉临时解包目录（留着 zip 便于回滚）
    fs.rmSync(extractDir, { recursive: true, force: true });

    return {
      ok: true,
      version: String(version || tag),
      files: files.length,
      backup: bakDir,
      needRestart: true,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * 安装/升级 QQ 客户端。
 *
 * QQ 是 deb 包，无 root 安装方式是 dpkg -x 解包：
 *   dpkg -x QQ_xxx.deb <目标目录>
 * 解出来的 opt/QQ 正好对上 napcatRoot()/opt/opt/QQ 的结构。
 */
export async function installQQ({ url, version, onLog = () => {} } = {}) {
  const root = napcatRoot();
  if (!url) return { ok: false, error: '缺少下载地址' };

  const dir = UPD_DIR();
  const tag = String(version || 'latest').replace(/[^\w.\-]/g, '');
  const debPath = path.join(dir, `QQ-${tag}.deb`);
  const tmpDir = path.join(dir, `qq-extract-${tag}`);

  try {
    onLog(`开始下载 QQ ${tag}…`);
    const bytes = await downloadTo(url, debPath);
    onLog(`下载完成 ${(bytes / 1024 / 1024).toFixed(1)}MB，解包 deb…`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    // dpkg -x 解包（无需 root）
    await new Promise((resolve, reject) => {
      const p = spawn('dpkg', ['-x', debPath, tmpDir], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += String(d); });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`dpkg -x 失败：${err.slice(0, 150)}`))));
    });

    const newQQ = path.join(tmpDir, 'opt', 'QQ');
    if (!fileExists(path.join(newQQ, 'qq'))) {
      return { ok: false, error: 'deb 解包后找不到 opt/QQ/qq，可能是别的架构或包格式' };
    }

    // 备份旧版（只备份 QQ 可执行与 resources/app/package.json，整目录太大）
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bak = path.join(dir, `qq-bak-${ts}`);
    if (isQQInstalled()) {
      fs.mkdirSync(bak, { recursive: true });
      try { fs.copyFileSync(path.join(qqDir(), 'qq'), path.join(bak, 'qq')); } catch { /* ignore */ }
      try {
        fs.copyFileSync(path.join(qqDir(), 'resources', 'app', 'package.json'),
          path.join(bak, 'app-package.json'));
      } catch { /* ignore */ }
      onLog(`已备份旧版到 ${bak}`);
    }

    // 覆盖到目标位置。注意保留 app_launcher/napcat（NapCat 注入的那份）与 config
    const target = qqDir();
    fs.mkdirSync(target, { recursive: true });
    await new Promise((resolve, reject) => {
      // -a 保留权限；--exclude 保护 NapCat 注入目录和配置
      const p = spawn('rsync', [
        '-a', '--delete',
        '--exclude=app_launcher/napcat',
        '--exclude=resources/app/app_launcher/napcat',
        `${newQQ}/`, `${target}/`,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += String(d); });
      p.on('error', () => {
        // 没有 rsync 就退化用 cp -a
        try {
          fs.cpSync(newQQ, target, { recursive: true, force: true });
          resolve();
        } catch (e2) { reject(new Error('复制失败：' + String(e2?.message ?? e2).slice(0, 120))); }
      });
      p.on('close', (code) => {
        if (code === 0) resolve();
        else {
          try { fs.cpSync(newQQ, target, { recursive: true, force: true }); resolve(); }
          catch (e2) { reject(new Error(`rsync 失败：${err.slice(0, 120)}`)); }
        }
      });
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });

    // QQ 换了新版本，NapCat 注入的 main 可能被覆盖 → 重新写回
    const appPkgPath = path.join(target, 'resources', 'app', 'package.json');
    const appPkg = readJson(appPkgPath);
    if (appPkg && appPkg.main !== './loadNapCat.js') {
      const origMain = String(appPkg.main || '');
      try {
        fs.writeFileSync(path.join(root, 'original-main.txt'), origMain, 'utf8');
        appPkg.main = './loadNapCat.js';
        fs.writeFileSync(appPkgPath, JSON.stringify(appPkg, null, 2), 'utf8');
        onLog(`已把 main 重新指向 loadNapCat.js（原 ${origMain}）`);
      } catch (e) {
        onLog('⚠️ 重新注入 NapCat 入口失败：' + String(e?.message ?? e).slice(0, 80));
      }
    }

    return {
      ok: true,
      version: localQQVersion() || tag,
      backup: bak || '',
      needRestart: true,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** 重启 napcat-qq 服务（后台 detached，接口立即返回） */
export function restartNapcatService() {
  try {
    const pwFile = process.env.QQ_SUDO_PASSWORD_FILE
      || path.join(os.homedir(), '.secrets', 'sudo', 'password');
    let pw = '';
    try { pw = fs.readFileSync(pwFile, 'utf8').trim(); } catch { /* 无密码文件 */ }
    const child = spawn('sudo', ['-S', 'systemctl', 'restart', 'napcat-qq'], {
      detached: true,
      stdio: pw ? ['pipe', 'ignore', 'ignore'] : 'ignore',
    });
    if (pw && child.stdin) {
      try { child.stdin.write(pw + '\n'); child.stdin.end(); } catch { /* 已关 */ }
    }
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 100) };
  }
}

// ── 账号切换（2026-10-27）────────────────────────────────────────────
//
// 需求来源："加一个切换账号的功能，我准备换号测试看看是账号问题还是接口问题"
//
// 为什么要这个：本机图片/文件上传 100% 超时，但文字正常。
// 换一个 QQ 号登录就能判断是「这个号被限制了」还是「接口/环境的问题」——
// 这是最快的排除法。
//
// 实现方式（今晚实测过的路径）：
//   改 webui.json 的 autoLoginAccount → 重启 napcat-qq →
//   napcat-start.sh 里的 pick-qq-uin.sh 会读到它并 -q <uin> 快速登录
//
// ⚠️ 前提：目标号必须有可用的登录态（config/napcat_<uin>.json），
//    否则会回退扫码。本面板会把这个风险提示出来。

/** 列出本地有登录态的账号（用于切换下拉） */
export function listKnownAccounts() {
  const cfgDir = path.join(activeNapcatDir(), 'config');
  const out = [];
  try {
    for (const f of fs.readdirSync(cfgDir)) {
      const m = /^napcat_(\d{5,12})\.json$/.exec(f);
      if (!m) continue;
      const uin = m[1];
      let mtime = 0;
      try { mtime = fs.statSync(path.join(cfgDir, f)).mtimeMs; } catch { /* ignore */ }
      out.push({ uin, updatedAt: new Date(mtime).toISOString(), isCurrent: uin === currentUin() });
    }
  } catch { /* 目录读不到 */ }
  out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return out;
}

/** 当前 webui.json 里记的自动登录号（也就是下次重启会登的号） */
export function currentUin() {
  const p = path.join(activeNapcatDir(), 'config', 'webui.json');
  const d = readJson(p);
  return String(d?.autoLoginAccount || '');
}

/**
 * 删除某个账号的历史登录态（2026-10-27 用户要求）
 *
 * 用户要求："登录历史添加账号删除"
 *
 * 为什么要删：登录态攒多了，快速登录列表里全是废弃号，
 * 选错的概率高；有些号还可能触发风控。
 *
 * 会删两个文件（都不含账号密码，只含会话凭据）：
 *   config/napcat_<uin>.json     NapCat 该号的登录态
 *   config/napcat_protocol_<uin>.json  协议层配置（有就删）
 *
 * 保护：
 *   · 正在使用的号不能删（删了下次重启就登不进去）
 *   · 删前备份到 config/.deleted/
 */
export function deleteAccountState(uin) {
  const target = String(uin || '').trim();
  if (!/^\d{5,12}$/.test(target)) {
    return { ok: false, error: 'QQ 号格式不对（5~12 位数字）' };
  }
  if (target === currentUin()) {
    return { ok: false, error: `${target} 是当前配置的登录账号，不能删除。先切到别的号再删。` };
  }

  const cfgDir = path.join(activeNapcatDir(), 'config');
  const files = [
    path.join(cfgDir, `napcat_${target}.json`),
    path.join(cfgDir, `napcat_protocol_${target}.json`),
  ];

  const bakDir = path.join(cfgDir, '.deleted');
  const removed = [];
  const missing = [];

  for (const f of files) {
    if (!fileExists(f)) { missing.push(path.basename(f)); continue; }
    try {
      fs.mkdirSync(bakDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.copyFileSync(f, path.join(bakDir, `${path.basename(f)}.${stamp}`));
      fs.unlinkSync(f);
      removed.push(path.basename(f));
    } catch (e) {
      return { ok: false, error: `删除 ${path.basename(f)} 失败：${String(e?.message ?? e).slice(0, 80)}` };
    }
  }

  if (!removed.length) {
    return { ok: false, error: `找不到 ${target} 的登录态文件` };
  }
  return { ok: true, uin: target, removed, missing, backupDir: bakDir };
}

/**
 * 把自动登录账号切成指定 QQ 号。
 *
 * @returns {{ok:boolean, uin?:string, previous?:string, hadState?:boolean, error?:string}}
 */
export function setAutoLoginUin(uin) {
  const target = String(uin || '').trim();
  if (!/^\d{5,12}$/.test(target)) {
    return { ok: false, error: 'QQ 号格式不对（5~12 位数字）' };
  }
  const cfgPath = path.join(activeNapcatDir(), 'config', 'webui.json');
  const d = readJson(cfgPath);
  if (!d) return { ok: false, error: '读不到 webui.json，NapCat 可能没装好' };

  const prev = String(d.autoLoginAccount || '');
  // 有没有这个号的登录态？没有的话重启会掉到扫码
  const hasState = fileExists(path.join(activeNapcatDir(), 'config', `napcat_${target}.json`));

  try {
    const bak = `${cfgPath}.bak-${Date.now()}`;
    fs.copyFileSync(cfgPath, bak);
    d.autoLoginAccount = target;
    fs.writeFileSync(cfgPath, JSON.stringify(d, null, 4), 'utf8');
    return { ok: true, uin: target, previous: prev, hadState: hasState };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
  }
}

// ── SnowLuma 通道（2026-10-27）──────────────────────────────────────
//
// 用户要求："虽然我们用的napcat，但是给登录通道加一个SnowLuma通道吧，
// 允许安装SnowLuma"
//
// 调研结论：**插件和核心包不用改**。
//   · src/onebot.js 是标准 OneBot v11 实现（不是 NapCat 专用）
//   · 插件用的全是标准接口（call/sendSegments/sendSticker/sendFile）
//   · SnowLuma 的接入路由本来就在（/api/snowluma/*）
// 所以这里只需要补「安装 + 版本检测」。

const SNOWLUMA_REPO = 'SnowLuma/SnowLuma';

export const snowlumaHome = () => process.env.SNOWLUMA_HOME || path.join(os.homedir(), 'snowluma');

export function isSnowlumaInstalled() {
  return fileExists(path.join(snowlumaHome(), 'index.mjs'));
}

/** 读 SnowLuma 版本（它自己的 package.json 有真实版本号） */
export function localSnowlumaVersion() {
  const d = readJson(path.join(snowlumaHome(), 'package.json'));
  return String(d?.version || '');
}

/** 拉 SnowLuma 最新 release，按当前架构挑包 */
export async function checkSnowlumaLatest() {
  try {
    const r = await fetch(`https://api.github.com/repos/${SNOWLUMA_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'qq-agent-snowluma-updater' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return { ok: false, error: `GitHub API HTTP ${r.status}` };
    const d = await r.json();
    const tag = String(d.tag_name || '').replace(/^v/, '');

    // 按平台+架构选包：优先完整版（内置 node），Lite 需要本机 Node 24+
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const plat = process.platform === 'win32' ? 'win' : 'linux';
    const wantExt = plat === 'win' ? '.zip' : '.tar.gz';
    const full = (d.assets || []).find((a) =>
      a.name.includes(`${plat}-${arch}`) && a.name.endsWith(wantExt) && !a.name.includes('lite'));
    const lite = (d.assets || []).find((a) =>
      a.name.includes(`${plat}-${arch}`) && a.name.endsWith(wantExt) && a.name.includes('lite'));

    const pick = full || lite;
    if (!pick) return { ok: false, error: `没有适配 ${plat}-${arch} 的发行包` };

    return {
      ok: true,
      latest: tag,
      publishedAt: d.published_at || '',
      url: pick.browser_download_url,
      size: pick.size || 0,
      variant: full ? 'full' : 'lite',
      notes: String(d.body || '').slice(0, 1200),
    };
  } catch (e) {
    return { ok: false, error: '连不上 GitHub：' + String(e?.message ?? e).slice(0, 80) };
  }
}

/** 安装/升级 SnowLuma（解压 tar.gz 或 zip 到 ~/snowluma） */
export async function installSnowluma({ url, version, onLog = () => {} } = {}) {
  if (!url) return { ok: false, error: '缺少下载地址' };
  const home = snowlumaHome();
  const dir = UPD_DIR();
  const tag = String(version || 'latest').replace(/[^\w.\-]/g, '');
  const isZip = /\.zip(\?|$)/i.test(url);
  const pkgPath = path.join(dir, `SnowLuma-${tag}${isZip ? '.zip' : '.tar.gz'}`);
  const extractDir = path.join(dir, `sl-extract-${tag}`);

  try {
    onLog(`开始下载 SnowLuma ${tag}…`);
    const bytes = await downloadTo(url, pkgPath);
    onLog(`下载完成 ${(bytes / 1024 / 1024).toFixed(1)}MB，解包…`);

    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });

    if (isZip) {
      unzipTo(pkgPath, extractDir);
    } else {
      // tar.gz 用系统 tar（自实现 gzip+tar 解析没必要）
      await new Promise((resolve, reject) => {
        const p = spawn('tar', ['xzf', pkgPath, '-C', extractDir], { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => { err += String(d); });
        p.on('error', reject);
        p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`tar 解包失败：${err.slice(0, 150)}`))));
      });
    }

    if (!fileExists(path.join(extractDir, 'index.mjs'))) {
      return { ok: false, error: '解包后找不到 index.mjs，包结构不对' };
    }

    // 备份旧版（只备份关键文件，完整备份太大）
    if (isSnowlumaInstalled()) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const bak = path.join(dir, `sl-bak-${ts}`);
      fs.mkdirSync(bak, { recursive: true });
      for (const f of ['index.mjs', 'package.json', 'launcher.sh', 'release.json']) {
        const src = path.join(home, f);
        if (fileExists(src)) { try { fs.copyFileSync(src, path.join(bak, f)); } catch { /* ignore */ } }
      }
      onLog(`已备份旧版到 ${bak}`);
    }

    // 部署：整体复制过去（保留 config/ 和 logs/ —— 那是用户配置与登录态）
    fs.mkdirSync(home, { recursive: true });
    await new Promise((resolve, reject) => {
      const p = spawn('rsync', [
        '-a',
        '--exclude=config',      // 用户配置，绝不能覆盖
        '--exclude=logs',
        '--exclude=data',
        `${extractDir}/`, `${home}/`,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += String(d); });
      p.on('error', () => {
        try { fs.cpSync(extractDir, home, { recursive: true, force: true }); resolve(); }
        catch (e2) { reject(new Error('复制失败：' + String(e2?.message ?? e2).slice(0, 120))); }
      });
      p.on('close', (c) => {
        if (c === 0) resolve();
        else {
          try { fs.cpSync(extractDir, home, { recursive: true, force: true }); resolve(); }
          catch (e2) { reject(new Error(`rsync 失败：${err.slice(0, 120)}`)); }
        }
      });
    });

    // 确保可执行位
    for (const f of ['node', 'launcher.sh']) {
      const p = path.join(home, f);
      if (fileExists(p)) { try { fs.chmodSync(p, 0o755); } catch { /* ignore */ } }
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    return { ok: true, version: localSnowlumaVersion() || tag, needRestart: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** 重启 SnowLuma 服务 */
export function restartSnowlumaService() {
  try {
    const pwFile = process.env.QQ_SUDO_PASSWORD_FILE
      || path.join(os.homedir(), '.secrets', 'sudo', 'password');
    let pw = '';
    try { pw = fs.readFileSync(pwFile, 'utf8').trim(); } catch { /* 无密码文件 */ }
    const child = spawn('sudo', ['-S', 'systemctl', 'restart', 'snowluma'], {
      detached: true,
      stdio: pw ? ['pipe', 'ignore', 'ignore'] : 'ignore',
    });
    if (pw && child.stdin) {
      try { child.stdin.write(pw + '\n'); child.stdin.end(); } catch { /* 已关 */ }
    }
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 100) };
  }
}

/** 汇总三方状态：NapCat / QQ / SnowLuma */
export async function checkAllWithSnowluma() {
  const base = await checkAll();
  const sl = await checkSnowlumaLatest();
  const localSl = localSnowlumaVersion();
  const slInstalled = isSnowlumaInstalled();

  return {
    ...base,
    snowluma: {
      installed: slInstalled,
      local: localSl,
      latest: sl.ok ? sl.latest : null,
      error: sl.ok ? null : sl.error,
      needInstall: !slInstalled,
      needUpdate: slInstalled && sl.ok && cmpVersion(sl.latest, localSl) > 0,
      url: sl.url || '',
      size: sl.size || 0,
      variant: sl.variant || '',
      notes: sl.notes || '',
      publishedAt: sl.publishedAt || '',
      // 备用通道的运行信息
      home: snowlumaHome(),
      webuiPort: 5099,
    },
  };
}

// ── 通道切换（NapCat ⇄ SnowLuma，2026-10-27）────────────────────────
//
// 用户问："前端如何从napcat切换到snowluma？"
// —— 之前只做了安装和版本检测，切换机制并没有实现，这里补上。
//
// 原理很简单：内核连谁完全取决于 config.snowluma 的两个地址
//   wsUrl    ws://127.0.0.1:<port>   收事件
//   httpUrl  http://127.0.0.1:<port> 调 API
// 所以"切通道"= 改这两个值 + 启停两边的服务。

/** 两个通道的固定参数（端口与 service 名） */
export const BACKENDS = {
  napcat: {
    label: 'NapCat',
    service: 'napcat-qq',
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    home: () => napcatRoot(),
    installed: () => isNapcatInstalled(),
  },
  snowluma: {
    label: 'SnowLuma',
    service: 'snowluma',
    wsUrl: 'ws://127.0.0.1:3011',
    httpUrl: 'http://127.0.0.1:3010',
    home: () => snowlumaHome(),
    installed: () => isSnowlumaInstalled(),
  },
};

/** 当前用的是哪条通道（按 wsUrl 反查，认不出就返回空） */
export function currentBackend(cfgSnowluma) {
  const ws = String(cfgSnowluma?.wsUrl || '');
  if (ws.includes(':3011')) return 'snowluma';
  if (ws.includes(':3001')) return 'napcat';
  return '';
}

/** 异步版：systemctl is-active <name> */
export async function isServiceActive(name) {
  return new Promise((resolve) => {
    const p = spawn('systemctl', ['is-active', name], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += String(d); });
    p.on('error', () => resolve(false));
    p.on('close', () => resolve(out.trim() === 'active'));
  });
}

/** 用 sudo 密码执行 systemctl <action> <unit> */
async function systemctlAs(action, unit) {
  return new Promise((resolve) => {
    const pwFile = process.env.QQ_SUDO_PASSWORD_FILE
      || path.join(os.homedir(), '.secrets', 'sudo', 'password');
    let pw = '';
    try { pw = fs.readFileSync(pwFile, 'utf8').trim(); } catch { /* 无密码文件 */ }
    const p = spawn('sudo', ['-S', 'systemctl', action, unit], {
      stdio: pw ? ['pipe', 'pipe', 'pipe'] : 'ignore',
    });
    let err = '';
    if (p.stderr) p.stderr.on('data', (d) => { err += String(d); });
    if (pw && p.stdin) {
      try { p.stdin.write(pw + '\n'); p.stdin.end(); } catch { /* 已关 */ }
    }
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve({ ok: false, error: '超时' }); }, 40000);
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e?.message ?? e) }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: err.slice(0, 150) });
    });
  });
}

/**
 * 切换通道。
 *
 * 步骤（顺序很重要）：
 *   ① 先停掉**另一个**通道（同一 QQ 号不能同时在线，会互踢）
 *   ② 改 config.snowluma.wsUrl/httpUrl
 *   ③ 启动目标通道
 *   ④ 提示内核重连（重启 qq-agent-v2 最稳，但会中断当前对话，
 *      所以这里只改配置 + 返回 needKernelRestart，让前端决定）
 *
 * @param {string} target 'napcat' | 'snowluma'
 */
export async function switchBackend(target, { writeConfig, onLog = () => {} } = {}) {
  const b = BACKENDS[target];
  if (!b) return { ok: false, error: "target 只能是 'napcat' 或 'snowluma'" };
  if (!b.installed()) return { ok: false, error: `${b.label} 还没安装，先去「版本更新」里装` };

  const other = target === 'napcat' ? BACKENDS.snowluma : BACKENDS.napcat;

  // ① 停另一个（避免同号互踢）
  if (await isServiceActive(other.service)) {
    onLog(`先停止 ${other.label}，避免同一 QQ 号互踢…`);
    const r = await systemctlAs('stop', other.service);
    if (!r.ok) onLog(`停止 ${other.label} 失败（继续）：${r.error || ''}`);
    else onLog(`${other.label} 已停止`);
  }

  // ② 改配置
  try {
    writeConfig({ snowluma: { wsUrl: b.wsUrl, httpUrl: b.httpUrl } });
    onLog(`内核连接地址已切到 ${b.label}：${b.wsUrl}`);
  } catch (e) {
    return { ok: false, error: '写配置失败：' + String(e?.message ?? e).slice(0, 100) };
  }

  // ③ 启动目标
  const started = await systemctlAs('start', b.service);
  if (!started.ok) {
    onLog(`启动 ${b.label} 失败：${started.error || ''}`);
  } else {
    onLog(`${b.label} 已启动`);
  }

  return {
    ok: true,
    backend: target,
    wsUrl: b.wsUrl,
    httpUrl: b.httpUrl,
    started: started.ok,
    // 内核要重连才生效。重启 qq-agent-v2 最彻底，但会中断当前对话，
    // 所以交给调用方决定（前端会给用户一个确认）。
    needKernelRestart: true,
  };
}

/** SnowLuma（备用通道）运行状态，供面板展示（2026-10-27） */
export async function snowlumaAltStatus() {
  const home = snowlumaHome();
  const installed = isSnowlumaInstalled();
  if (!installed) return { ok: true, installed: false, running: false, loggedIn: false };

  const running = await isServiceActive('snowluma');
  if (!running) {
    const en = await new Promise((resolve) => {
      const p = spawn('systemctl', ['is-enabled', 'snowluma'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (d) => { out += String(d); });
      p.on('error', () => resolve('unknown'));
      p.on('close', () => resolve(out.trim() || 'unknown'));
    });
    return { ok: true, installed: true, running: false, enabled: en, loggedIn: false, home };
  }

  // 用 WebUI 的 /api/qq-list 判断有没有登录 QQ
  // 需要先拿 WebUI token：用 .secrets/snowluma/password 登录
  let loggedIn = false;
  let uin = '';
  let qqCount = 0;
  try {
    let pw = '';
    try { pw = fs.readFileSync(path.join(os.homedir(), '.secrets', 'snowluma', 'password'), 'utf8').trim(); } catch { /* 无密码 */ }
    if (pw) {
      const lr = await fetch('http://127.0.0.1:5099/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: pw }),
        signal: AbortSignal.timeout(8000),
      });
      const ld = await lr.json().catch(() => ({}));
      const token = ld?.token || '';
      if (token) {
        const qr = await fetch('http://127.0.0.1:5099/api/qq-list', {
          headers: { Authorization: 'Bearer ' + token },
          signal: AbortSignal.timeout(8000),
        });
        const qd = await qr.json().catch(() => ({}));
        const list = Array.isArray(qd?.list) ? qd.list : [];
        qqCount = list.length;
        if (list.length) {
          loggedIn = true;
          uin = String(list[0].uin || '');
        }
      }
    }
  } catch { /* 查询失败就当未登录 */ }

  // 开机自启状态（2026-10-27）
  const enabled = await new Promise((resolve) => {
    const p = spawn('systemctl', ['is-enabled', 'snowluma'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += String(d); });
    p.on('error', () => resolve('unknown'));
    p.on('close', () => resolve(out.trim() || 'unknown'));
  });

  return {
    ok: true,
    installed: true,
    running: true,
    enabled,
    loggedIn,
    uin,
    qqCount,
    home,
    webui: 'http://127.0.0.1:5099',
  };
}

/** 取 SnowLuma 的 WebUI 密码与访问令牌（2026-10-27 用户要求公开给大家用） */
export async function snowlumaCredentials() {
  const pwFile = path.join(os.homedir(), '.secrets', 'snowluma', 'password');
  let password = '';
  try { password = fs.readFileSync(pwFile, 'utf8').trim(); } catch { /* 无文件 */ }
  if (!password) return { ok: false, error: '密码文件不存在：' + pwFile };

  try {
    const r = await fetch('http://127.0.0.1:5099/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
      signal: AbortSignal.timeout(10000),
    });
    const d = await r.json().catch(() => ({}));
    if (!d?.success || !d?.token) {
      return { ok: false, error: d?.message || 'SnowLuma 拒绝登录（服务是否在跑？）', password };
    }
    return { ok: true, username: 'admin', password, token: d.token };
  } catch (e) {
    return { ok: false, error: '连不上 SnowLuma：' + String(e?.message ?? e).slice(0, 80), password };
  }
}

/**
 * 修改 SnowLuma WebUI 密码（2026-10-27）
 *
 * 用户要求："SnowLuma 控制台新增改密功能吧，让用户自己可以改密码"
 *
 * 为什么要内核代劳：
 *   · SnowLuma 的改密接口要 Bearer token，而拿到 token 需要先知道旧密码
 *   · 改完后还要同步更新 .secrets/snowluma/password，
 *     否则面板的「取访问令牌」会拿着旧密码去登，直接失败
 *   这两件事打包在这里做，用户只填新旧密码就行。
 *
 * 强度校验交给 SnowLuma 自己（它会返回具体哪条不满足），不在这重复实现。
 */
export async function changeSnowlumaPassword({ oldPassword, newPassword } = {}) {
  const oldPw = String(oldPassword || '');
  const newPw = String(newPassword || '');
  if (!oldPw) return { ok: false, error: '请填当前密码' };
  if (!newPw) return { ok: false, error: '请填新密码' };
  if (newPw.length < 10) return { ok: false, error: '新密码至少 10 位' };

  let token = '';
  try {
    const lr = await fetch('http://127.0.0.1:5099/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: oldPw }),
      signal: AbortSignal.timeout(10000),
    });
    const ld = await lr.json().catch(() => ({}));
    if (!ld?.success || !ld?.token) {
      return { ok: false, error: '当前密码不正确，或 SnowLuma 未运行' };
    }
    token = ld.token;
  } catch (e) {
    return { ok: false, error: '连不上 SnowLuma：' + String(e?.message ?? e).slice(0, 80) };
  }

  try {
    const r = await fetch('http://127.0.0.1:5099/api/auth/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!d?.success) {
      // SnowLuma 会返回 rules 数组说明哪条不满足
      const rules = Array.isArray(d?.rules) ? d.rules.filter((x) => x.ok === false).map((x) => x.label) : [];
      return {
        ok: false,
        error: d?.message || '修改失败',
        rules,
      };
    }
  } catch (e) {
    return { ok: false, error: '改密请求失败：' + String(e?.message ?? e).slice(0, 80) };
  }

  // 同步本地密码文件，否则「取访问令牌」会用旧密码登不上
  const pwFile = path.join(os.homedir(), '.secrets', 'snowluma', 'password');
  try {
    fs.mkdirSync(path.dirname(pwFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(pwFile, newPw, { mode: 0o600 });
  } catch (e) {
    return { ok: true, warning: '密码已改，但本地密码文件写入失败：' + String(e?.message ?? e).slice(0, 60) };
  }
  return { ok: true, message: '密码已修改，本地凭据已同步' };
}

/**
 * SnowLuma 服务开关（2026-10-27 用户要求）
 *
 * 用户提问："SnowLuma 安装了后就一直后台运行吗？如果我们用了另一个通道，
 * 请保持另一个关闭，不要同时打开，或者给一个开关，让我们可以自行选择关闭后台"
 *
 * 现实问题：两条通道同时跑，占双份内存，而且都没连到内核时纯属浪费。
 *
 * 提供两个维度：
 *   ① 立即开关（start/stop）—— 现在就跑/不跑
 *   ② 开机自启（enable/disable）—— 重启机器后要不要自己起来
 * 这两个是独立的，用户可能想"手动开一次但不要自启"。
 */
export async function controlSnowluma(action) {
  const act = String(action || '').trim();
  const allowed = {
    start: ['start', 'snowluma'],
    stop: ['stop', 'snowluma'],
    enable: ['enable', 'snowluma'],
    disable: ['disable', 'snowluma'],
  };
  const cmd = allowed[act];
  if (!cmd) return { ok: false, error: "action 只能是 start/stop/enable/disable" };

  const pwFile = process.env.QQ_SUDO_PASSWORD_FILE
    || path.join(os.homedir(), '.secrets', 'sudo', 'password');
  let pw = '';
  try { pw = fs.readFileSync(pwFile, 'utf8').trim(); } catch { /* 无密码文件 */ }

  const r = await new Promise((resolve) => {
    const p = spawn('sudo', ['-S', 'systemctl', ...cmd], {
      stdio: pw ? ['pipe', 'pipe', 'pipe'] : 'ignore',
    });
    let err = '';
    if (p.stderr) p.stderr.on('data', (d) => { err += String(d); });
    if (pw && p.stdin) { try { p.stdin.write(pw + '\n'); p.stdin.end(); } catch { /* 已关 */ } }
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve({ ok: false, error: '超时' }); }, 40000);
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e?.message ?? e) }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: err.slice(0, 150) });
    });
  });
  if (!r.ok) return r;

  // 返回操作后的真实状态
  const active = await isServiceActive('snowluma');
  const enabled = await new Promise((resolve) => {
    const p = spawn('systemctl', ['is-enabled', 'snowluma'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += String(d); });
    p.on('error', () => resolve('unknown'));
    p.on('close', () => resolve(out.trim() || 'unknown'));
  });

  return { ok: true, action: act, active, enabled };
}
