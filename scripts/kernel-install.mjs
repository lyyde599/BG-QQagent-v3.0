#!/usr/bin/env node
// ── 内核自动安装 + 健康探测 + 失败回滚（2026-10-25）──────────────
//
// 用户需求：「我希望下个版本更新有自动安装」
//
// 🔴 为什么必须做成**独立进程**而不是在服务内部做：
//   安装要替换 src/ ui/，而正在运行的进程自己就在用这些文件；
//   而且装完要重启服务 —— 服务不能重启自己（进程杀了就停了）。
//   所以由这个脚本在服务**外面**跑，服务只是发起它。
//
// 流程（任何一步失败都自动回滚）：
//   ① 备份现有内核（src ui skills scripts test + package.json + 顶层 md）
//   ② 解压新包到临时目录
//   ③ 语法自检（node --check 关键文件）
//   ④ 替换文件
//   ⑤ 重启服务
//   ⑥ 健康探测（轮询 http://127.0.0.1:<port>/api/status）
//   ⑦ 探测失败 → 回滚 → 再重启 → 再探测
//
// 用法：
//   node scripts/kernel-install.mjs <包路径> [--port 3210] [--dry]
//
// 为什么要独立文件：服务内部调它时用 detached spawn，装完即使服务退出也不影响。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import * as zlibMod from 'node:zlib';
import { fileURLToPath } from 'node:url';

// 🔴 安装脚本版本标记（2026-10-25）
//
// 用途：内核端检查「磁盘上的脚本是不是够新」。
// 老脚本没有这个标记 → 说明是旧版，装之前要先用包里的新脚本。
// 新版安装完成后会写上自己的标记。
export const INSTALLER_VERSION = '1.1.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 从 /tmp 副本运行时，HERE 是 /tmp，必须用参数或环境变量指明真实根目录
const ROOT = process.env.KERNEL_ROOT
  ? path.resolve(process.env.KERNEL_ROOT)
  : path.resolve(HERE, '..');

const args = process.argv.slice(2);
const pkgPath = args.find((a) => !a.startsWith('--'));
const dry = args.includes('--dry');
const portArg = (() => {
  const i = args.indexOf('--port');
  return i >= 0 ? Number(args[i + 1]) : 0;
})();

const LOG = (msg) => console.log(`[kernel-install] ${msg}`);

function fail(msg, code = 1) {
  LOG(`❌ ${msg}`);
  process.exit(code);
}

if (!pkgPath) fail('用法: node scripts/kernel-install.mjs <包路径> [--port 3210] [--dry]');
if (!fs.existsSync(pkgPath)) fail(`包不存在：${pkgPath}`);

/** 读当前端口 */
function readPort() {
  if (portArg) return portArg;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
    return Number(cfg?.server?.port) || 3210;
  } catch {
    return 3210;
  }
}

/** 健康探测：轮询 /api/status，超时算失败 */
async function healthCheck(port, timeoutMs = 60000) {
  const url = `http://127.0.0.1:${port}/api/status`;
  const deadline = Date.now() + timeoutMs;
  let tries = 0;
  while (Date.now() < deadline) {
    tries++;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const d = await res.json().catch(() => ({}));
        if (d && typeof d === 'object') {
          LOG(`✅ 健康探测通过（第 ${tries} 次，${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s）`);
          return true;
        }
      }
    } catch { /* 还没起来，继续等 */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  LOG(`❌ 健康探测超时（${timeoutMs / 1000}s，试了 ${tries} 次）`);
  return false;
}

/** 重启服务 */
// ── 服务名识别（2026-10-25）──────────────────────────────────
//
// 🔴 真实事故：脚本把服务名写死成 qq-agent-v2（那是**打包目录名**）。
//    用户机器上服务可能叫 qq-agent / bg-qqagent / 自定义名。
//    于是 stop/start 全部失败，但返回码没人看；文件照样替换；
//    健康探测又被**旧进程**应答 200 → 判定成功 → 「全绿但没生效」。
//
// 对策：自动识别 + 显式可覆盖 + PID 前后对比。
let UNIT = '';
let unitResolved = false;

function detectUnit() {
  if (unitResolved) return UNIT;
  unitResolved = true;

  // ① 显式指定最优先
  if (process.env.QQ_AGENT_UNIT) {
    UNIT = String(process.env.QQ_AGENT_UNIT).replace(/\.service$/, '');
    return UNIT;
  }

  // ② 扫 unit 文件：找 WorkingDirectory 或 ExecStart 指向本安装目录的那个
  //
  // 🔴 关键（2026-10-25 实测）：很多部署的 ExecStart 写的是**相对路径**
  //    （ExecStart=/usr/local/bin/node src/server.js），真正的定位靠
  //    WorkingDirectory。所以**必须同时看 WorkingDirectory**，
  //    只匹配 ExecStart 会漏掉一大半机器。
  for (const d of ['/etc/systemd/system', '/lib/systemd/system', '/usr/lib/systemd/system']) {
    let names = [];
    try { names = fs.readdirSync(d).filter((f) => f.endsWith('.service')); } catch { continue; }
    for (const f of names) {
      try {
        const txt = fs.readFileSync(path.join(d, f), 'utf8');
        // WorkingDirectory 匹配最准；ExecStart 里含绝对路径也算
        const wd = /WorkingDirectory=([^\s]+)/.exec(txt)?.[1] || '';
        if (wd && path.resolve(wd) === path.resolve(ROOT)) return (UNIT = f.replace(/\.service$/, ''));
        if (/ExecStart=/.test(txt) && txt.includes(ROOT)) return (UNIT = f.replace(/\.service$/, ''));
      } catch { /* 跳过 */ }
    }
  }

  // ③ 问 systemd：比对每个 unit 的 WorkingDirectory / ExecStart
  try {
    const r = spawnSync('systemctl', ['list-units', '--type=service', '--all', '--no-legend', '--plain'],
      { encoding: 'utf8', timeout: 20000 });
    for (const line of String(r.stdout || '').split('\n')) {
      const name = line.trim().split(/\s+/)[0];
      if (!name) continue;
      const wd = spawnSync('systemctl', ['show', name, '-p', 'WorkingDirectory', '--value'],
        { encoding: 'utf8', timeout: 10000 });
      const wdVal = String(wd.stdout || '').trim();
      if (wdVal && path.resolve(wdVal) === path.resolve(ROOT)) return (UNIT = name.replace(/\.service$/, ''));
      const s = spawnSync('systemctl', ['show', name, '-p', 'ExecStart', '--value'], { encoding: 'utf8', timeout: 10000 });
      if (String(s.stdout || '').includes(ROOT)) return (UNIT = name.replace(/\.service$/, ''));
    }
  } catch { /* ignore */ }

  // ④ 兜底：常见的几个名字
  for (const n of ['qq-agent', 'qq-agent-v2', 'bg-qqagent']) {
    const s = spawnSync('systemctl', ['show', n, '-p', 'LoadState', '--value'], { encoding: 'utf8', timeout: 10000 });
    if (String(s.stdout || '').trim() === 'loaded') return (UNIT = n);
  }
  return (UNIT = '');
}

/** 服务主进程 PID（识别不到服务名或服务没跑时返回空串） */
function servicePid() {
  const u = detectUnit();
  if (!u) return '';
  const r = spawnSync('systemctl', ['show', u, '-p', 'MainPID', '--value'], { timeout: 10000, encoding: 'utf8' });
  const v = String(r.stdout || '').trim();
  return v && v !== '0' ? v : '';
}

/**
 * 执行 systemctl（自动处理 sudo）
 *
 * 🔴 真实事故（2026-10-25 阿里云 502）：
 *   脚本里直接 spawnSync('systemctl', ...)，普通用户调用需要交互式认证 → 失败。
 *   停服务若恰好有 sudo 缓存能成，启动就失败 → 服务一直停着，网页 502。
 *   统一走 runCtl()：优先免密 sudo，不行再退回直接调用。
 */
function runCtl(args, timeout = 60000) {
  // ① sudo -n（免密或缓存有效时最省事）
  let r = spawnSync('sudo', ['-n', 'systemctl', ...args], { timeout, encoding: 'utf8' });
  if (r.status === 0) return { ok: true, via: 'sudo-n' };

  // ② sudo + 密码走 stdin
  //
  // 🔴 很多机器上 sudoers 只给了特定命令的 NOPASSWD（比如 chrome-browser），
  //    停自己的服务不在名单里 → sudo -n 直接失败。
  //    这里用密码文件认证（铁律 0.6：密码只走 stdin，绝不进命令行参数）。
  const pwFile = process.env.QQ_SUDO_PASSWORD_FILE
    || path.join(os.homedir(), '.secrets', 'sudo', 'password');
  try {
    if (fs.existsSync(pwFile)) {
      const pw = fs.readFileSync(pwFile, 'utf8').trim();
      r = spawnSync('sudo', ['-S', 'systemctl', ...args], {
        timeout, encoding: 'utf8',
        input: pw + '\n'          // ← 密码只走 stdin
      });
      if (r.status === 0) return { ok: true, via: 'sudo-stdin' };
    }
  } catch (e) {
    LOG(`⚠️ 密码认证失败：${e?.message ?? e}`);
  }

  // ③ 直接调用（服务若是 user unit，或当前用户有权限）
  r = spawnSync('systemctl', args, { timeout, encoding: 'utf8' });
  if (r.status === 0) return { ok: true, via: 'direct' };

  return { ok: false, via: 'none', err: String(r.stderr || '').slice(0, 200) };
}

function restartService() {
  const u = detectUnit();
  if (!u) { LOG('⚠️ 识别不到服务名，跳过重启'); return false; }
  const r = runCtl(['restart', u]);
  if (!r.ok) { LOG(`⚠️ 重启服务失败：${r.err}`); return false; }
  return true;
}

/** 停服务（替换文件前必须停，否则文件被占用） */
function stopService() {
  const u = detectUnit();
  if (!u) { LOG('⚠️ 识别不到服务名，跳过停止'); return false; }
  const r = runCtl(['stop', u]);
  if (!r.ok) LOG(`⚠️ 停止服务失败：${r.err}`);
  return r.ok;
}

/** 启动服务 */
function startService() {
  const u = detectUnit();
  if (!u) { LOG('⚠️ 识别不到服务名，跳过启动'); return false; }
  const r = runCtl(['start', u]);
  if (!r.ok) LOG(`⚠️ 启动服务失败：${r.err}`);
  return r.ok;
}

/** 备份：把内核文件拷到 .bak-<时间戳>/ */
function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(ROOT, `.bak-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });

  const items = ['src', 'ui', 'skills', 'scripts', 'test', 'electron', 'docs',
    'package.json', 'package-lock.json',
    'README.md', 'PLUGIN-ARCH.md', 'VOICE-RESEARCH.md',
    '插件与Skill制作及使用规范.md', '内核发布说明.md', '安装说明.md',
    '.gitignore', 'LICENSE'];

  let n = 0;
  for (const it of items) {
    const src = path.join(ROOT, it);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dir, it);
    try {
      fs.cpSync(src, dst, { recursive: true });
      n++;
    } catch (e) {
      LOG(`  ⚠️ 备份 ${it} 失败：${e?.message ?? e}`);
    }
  }
  LOG(`① 已备份 ${n} 项 → ${path.basename(dir)}`);
  return dir;
}

/** 解压 */
function extract(pkg, dest) {
  fs.mkdirSync(dest, { recursive: true });

  // 🔴 Windows 兼容（2026-10-25 实踩）
  //
  // 现象：tar: qq-agent-v2/插件与Skill...md: Invalid empty pathname: Unknown error
  // 原因：包内中文文件名是 UTF-8 字节，Windows 上的 tar 按系统代码页解析，
  //       把多字节序列拆错，生成非法路径。
  //
  // 对策：Windows 下用 Node 原生解压 —— 逐条读 tar 头自己写文件，
  //       完全绕开系统 tar 的编码问题。Linux 上仍走 tar（更快）。
  const isWin = process.platform === 'win32';
  if (isWin) {
    try {
      extractWithNode(pkg, dest);
      LOG('   已用 Node 原生解压（Windows 兼容模式）');
    } catch (e) {
      fail(`解压失败（Node 原生）：${e?.message ?? e}`);
    }
  } else {
    const r = spawnSync('tar', ['xzf', pkg, '-C', dest], { timeout: 180000, encoding: 'utf8' });
    if (r.status !== 0) fail(`解压失败：${(r.stderr || '').slice(0, 300)}`);
  }
  return afterExtract(dest);
}

/**
 * 纯 Node 解压 .tar.gz（Windows 用，避开系统 tar 的编码问题）
 *
 * 只实现 tar 的常规格式：512 字节头 + 内容 + 512 对齐填充。
 * 支持 ustar 前缀字段与 GNU longname（中文长文件名会用到）。
 */
function extractWithNode(pkg, dest) {
  const zlib = zlibMod;
  const buf = zlib.gunzipSync(fs.readFileSync(pkg));
  const td = new TextDecoder('utf-8');

  let off = 0;
  let longName = '';

  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    // 全零块 = 结束
    if (header.every((b) => b === 0)) break;

    const readStr = (start, len) => {
      const raw = header.subarray(start, start + len);
      const end = raw.indexOf(0);
      return td.decode(end >= 0 ? raw.subarray(0, end) : raw);
    };

    let name = readStr(0, 100);
    const sizeStr = readStr(124, 12).trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const prefix = readStr(345, 155);

    // ustar 前缀（路径 >100 字节时用）
    if (prefix) name = `${prefix}/${name}`;
    // GNU longname：上一条记录的真名
    if (longName) { name = longName; longName = ''; }

    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;

    // GNU long name 记录：内容是下一条的文件名
    if (typeflag === 'L') {
      longName = td.decode(data).replace(/\0.*$/, '');
      continue;
    }
    if (name === 'pax_global_header' || typeflag === 'g') continue;
    // 只处理普通文件与目录
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '5') continue;

    // 防路径穿越
    const safe = name.replace(/^\.\//, '').replace(/\\/g, '/');
    if (safe.includes('..') || path.isAbsolute(safe)) continue;

    const target = path.join(dest, safe);
    if (typeflag === '5' || safe.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
  }
}

/** 解压后定位内核根目录 */
function afterExtract(dest) {
  // 找包内的顶层目录（约定是 qq-agent-v2/）
  const entries = fs.readdirSync(dest).filter((x) => !x.startsWith('.'));
  const dirs = entries.filter((x) => fs.statSync(path.join(dest, x)).isDirectory());
  if (dirs.length === 1) return path.join(dest, dirs[0]);
  if (entries.includes('src')) return dest;   // 包内直接就是内核
  fail(`包结构不认识：顶层是 ${entries.join(', ')}`);
}

/** 语法自检 */
function syntaxCheck(dir) {
  const files = [];
  for (const sub of ['src', 'ui']) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    const walk = (p) => {
      for (const x of fs.readdirSync(p)) {
        const full = path.join(p, x);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (x.endsWith('.js') || x.endsWith('.mjs')) files.push(full);
      }
    };
    walk(d);
  }
  let bad = 0;
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { timeout: 30000, encoding: 'utf8' });
    if (r.status !== 0) {
      LOG(`  ❌ 语法错：${path.relative(dir, f)}`);
      bad++;
    }
  }
  if (bad) fail(`语法自检失败（${bad} 个文件）`);
  LOG(`③ 语法自检通过（${files.length} 个文件）`);
}

/** 用新文件覆盖旧文件（保留 data/ plugins/ 等运行时目录） */
function replace(newDir) {
  const items = ['src', 'ui', 'skills', 'scripts', 'test', 'electron', 'docs',
    'package.json', 'package-lock.json',
    'README.md', 'PLUGIN-ARCH.md', 'VOICE-RESEARCH.md',
    '插件与Skill制作及使用规范.md', '内核发布说明.md', '安装说明.md',
    '.gitignore', 'LICENSE'];

  let n = 0;
  for (const it of items) {
    const src = path.join(newDir, it);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(ROOT, it);
    try {
      // 先删再拷，避免旧文件残留（比如已删除的模块）
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(src, dst, { recursive: true });
      n++;
    } catch (e) {
      LOG(`  ⚠️ 替换 ${it} 失败：${e?.message ?? e}`);
    }
  }
  LOG(`④ 已替换 ${n} 项`);
}

/**
 * 把安装脚本本身标记为「已是最新」
 *
 * 为什么需要：安装动作会替换 scripts/。如果这次装的是老包，
 * 磁盘上的脚本就被换回老版本了 —— 下次更新又是老逻辑（502）。
 *
 * 这里在替换完成后，**从新包里再取一次脚本**盖回去，
 * 保证「装完之后的脚本」一定是这次这个版本带来的。
 */
function syncInstallerFromPackage(newDir) {
  const src = path.join(newDir, 'scripts', 'kernel-install.mjs');
  if (!fs.existsSync(src)) return;
  const dst = path.join(ROOT, 'scripts', 'kernel-install.mjs');
  try {
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
    LOG('   安装脚本已同步为本次版本');
  } catch (e) {
    LOG(`   ⚠️ 安装脚本同步失败：${e?.message ?? e}`);
  }
}

/** 回滚 */
function rollback(bakDir) {
  LOG('⏪ 开始回滚…');
  stopService();
  const items = fs.readdirSync(bakDir);
  let n = 0;
  for (const it of items) {
    const src = path.join(bakDir, it);
    const dst = path.join(ROOT, it);
    try {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(src, dst, { recursive: true });
      n++;
    } catch (e) {
      LOG(`  ⚠️ 回滚 ${it} 失败：${e?.message ?? e}`);
    }
  }
  LOG(`   已还原 ${n} 项`);
  startService();
}

// ── 主流程 ──
const port = readPort();
LOG(`目标目录：${ROOT}`);
LOG(`安装包：${pkgPath}`);
LOG(`服务端口：${port}`);

// 🔴 自我保护：把自己复制到 /tmp 再执行后续（2026-10-25 实踩）
//
// 症状：替换 scripts/ 时把本脚本自己也删了（新包里可能没这个文件），
//       于是跑到一半 MODULE_NOT_FOUND。
// 对策：一开始就把自己拷到 /tmp 的固定位置；如果当前不是从那里跑的，
//       就重新以那份身份启动，然后退出。
const SELF_COPY = path.join('/tmp', `kernel-install-runtime-${process.getuid?.() ?? 'x'}.mjs`);
const runningFromCopy = path.resolve(process.argv[1] || '') === path.resolve(SELF_COPY);

if (!runningFromCopy) {
  try {
    fs.copyFileSync(path.resolve(process.argv[1]), SELF_COPY);
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [SELF_COPY, ...process.argv.slice(2)], {
      stdio: 'inherit',
      detached: false,
      env: { ...process.env, KERNEL_ROOT: ROOT }
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    await new Promise(() => {});   // 等子进程
  } catch (e) {
    LOG(`⚠️ 无法自拷贝，继续用当前路径执行：${e?.message ?? e}`);
  }
} else {
  // 已经是从 /tmp 跑的，把真正的 ROOT 传进来
  LOG(`已在自拷贝中运行（${SELF_COPY}）`);
}

// ── 前置守卫（2026-10-25）──────────────────────────────────
//
// 🔴 阿里云事故三条教训：
//   ① 1.8G 内存跑多个 chromium，安装到一半 OOM，脚本被 kill → 服务停摆
//   ② 上次停在「停服务」之后，这次安装也不会先把服务拉起来
//   ③ 两个安装并发会互相踩文件

/** 可用内存（MB），-1 表示读不到 */
function availableMB() {
  try {
    const mem = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = /MemAvailable:\s+(\d+) kB/.exec(mem);
    return m ? Math.round(Number(m[1]) / 1024) : -1;
  } catch { return -1; }
}

const LOCK_FILE = path.join('/tmp', 'kernel-install.lock');

function serviceActive() {
  const u = detectUnit();
  if (!u) return false;
  const r = spawnSync('systemctl', ['is-active', u], { timeout: 10000, encoding: 'utf8' });
  return String(r.stdout || '').trim() === 'active';
}

// ① 内存门槛（铁律 0.9：没余量不许动服务）
const avail = availableMB();
if (avail >= 0 && avail < 300) {
  fail(`可用内存只有 ${avail}MB（需 ≥300MB）。\n` +
       `  安装过程可能被 OOM 打断，导致服务停摆（502）。已中止。\n` +
       `  建议先释放内存（关掉不必要的 chromium 等）再重试。`, 5);
}
if (avail >= 0) LOG(`① 内存检查通过（可用 ${avail}MB）`);

// ② 互斥锁
try {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    let alive = false;
    try { if (pid) { process.kill(pid, 0); alive = true; } } catch { /* 进程没了 */ }
    if (alive) fail(`已有安装在进行中（pid ${pid}）。如确认没有，删掉 ${LOCK_FILE} 再试`, 4);
    LOG(`⚠️ 清理上次残留锁（pid ${pid} 已退出）`);
    fs.unlinkSync(LOCK_FILE);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
} catch (e) {
  LOG(`⚠️ 锁处理异常（继续）：${e?.message ?? e}`);
}
const releaseLock = () => {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch { /* 忽略 */ }
};
process.on('exit', releaseLock);

// ③ 中断自愈：先把现场恢复到能用的状态
if (!serviceActive()) {
  LOG('⚠️ 服务当前不是 active（可能上次安装被打断），先拉起…');
  startService();
  await new Promise((r) => setTimeout(r, 8000));
  LOG(serviceActive() ? '   已恢复运行，继续安装' : '   仍未起来，继续尝试（装完再探）');
}

const tmp = path.join('/tmp', `kernel-install-${Date.now()}`);
let newDir;
try {
  newDir = extract(pkgPath, tmp);
  LOG(`② 已解压到 ${tmp}`);
} catch (e) {
  fail(String(e?.message ?? e));
}

syntaxCheck(newDir);

if (dry) {
  LOG('--dry：到此为止，不替换');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

const bakDir = backup();

// 替换前必须停服务，否则正在运行的代码占用文件
// 🔴 退出保护（2026-10-25）：从停服务开始，任何异常退出都先拉起服务。
//    SIGKILL 捕不到 —— 那种情况靠前面的「中断自愈」兜底。
let serviceStopped = false;
let finished = false;

const emergencyRestart = (why) => {
  if (finished || !serviceStopped) return;
  try {
    LOG(`⚠️ 异常退出（${why}），紧急拉起服务…`);
    startService();
  } catch (e) {
    LOG(`   紧急启动失败：${e?.message ?? e}`);
  }
};
process.on('exit', (code) => { if (code !== 0) emergencyRestart(`exit ${code}`); });
process.on('uncaughtException', (e) => {
  LOG(`❌ 未捕获异常：${e?.message ?? e}`);
  emergencyRestart('uncaughtException');
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  LOG(`❌ 未处理的 Promise 拒绝：${e?.message ?? e}`);
  emergencyRestart('unhandledRejection');
  process.exit(1);
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { LOG(`⚠️ 收到 ${sig}`); emergencyRestart(sig); process.exit(1); });
}

// 记下停服务前的 PID —— 后面用它判断「进程到底换没换」
const pidBefore = servicePid();
LOG(`⑤ 停止服务…（服务名 ${detectUnit() || '未识别'}，当前 PID ${pidBefore || '无'}）`);
if (!stopService()) {
  releaseLock();
  fail('停不下服务（权限不足？），已中止。服务仍保持运行。', 6);
}
serviceStopped = true;
await new Promise((r) => setTimeout(r, 2000));

replace(newDir);
syncInstallerFromPackage(newDir);

LOG('⑥ 启动服务…');
startService();

const ok = await healthCheck(port, 60000);

// 🔴 最关键的兜底（2026-10-25）：健康探测只能证明「端口上有人应答」，
//    证明不了「应答的是新进程」。旧进程还活着时它会返回 200，
//    于是「文件换了但代码没换」被误判成成功。
const pidAfter = servicePid();
const unit = detectUnit();
let pidChanged = true;
if (unit && pidBefore && pidAfter && pidBefore === pidAfter) {
  pidChanged = false;
  LOG(`⚠️⚠️ 服务没有真正重启（MainPID 仍是 ${pidAfter}），新代码未生效！`);
  LOG(`      请手动执行：sudo systemctl restart ${unit}`);
} else if (unit && pidAfter) {
  LOG(`   进程已换：PID ${pidBefore || '无'} → ${pidAfter}`);
} else if (!unit) {
  LOG('⚠️ 识别不到 systemd 服务（可能是容器/裸进程部署），请手动重启以生效');
}

if (!ok || !pidChanged) {
  if (!ok) LOG('健康探测失败，回滚…');
  if (!pidChanged) LOG('进程未重启，视为失败，回滚…');
  rollback(bakDir);
  await new Promise((r) => setTimeout(r, 3000));
  const back = await healthCheck(port, 45000);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (back) {
    fail(`安装失败已回滚（备份保留在 ${path.basename(bakDir)}）`, 2);
  } else {
    fail(`安装失败且回滚后仍不健康！请手动检查，备份在 ${bakDir}`, 3);
  }
}

// 成功：清理临时目录，保留备份供手动回退
finished = true;
fs.rmSync(tmp, { recursive: true, force: true });
LOG(`🎉 安装成功，备份保留在 ${path.basename(bakDir)}（确认无误后可删）`);

// 把备份路径写到文件，方便前端展示
try {
  fs.writeFileSync(path.join(ROOT, 'data', 'kernel-updates', 'last-install.json'), JSON.stringify({
    at: new Date().toISOString(),
    pkg: pkgPath,
    backup: path.basename(bakDir),
    ok: true
  }, null, 2));
} catch { /* 忽略 */ }

process.exit(0);
