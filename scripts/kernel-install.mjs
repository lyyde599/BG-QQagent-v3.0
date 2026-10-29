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

// 🔴 自我重定位：脱离内核的 cgroup（2026-10-26）
//
// 事故：不管内核侧怎么调（spawn / systemd-run），只要脚本最终跑在
//   服务的 cgroup 里，`systemctl stop <服务>` 就会连带把它 SIGTERM 掉。
//   证据：日志里 status=null signal=SIGTERM —— 那是脚本自己收到的信号，
//   不是服务的退出状态。
//
// 解法：脚本启动后先自检。如果自己被 systemd 管着（有 INVOCATION_ID），
//   且还没重定位过，就用 systemd-run 把自己挪到独立 unit，然后退出。
//   重定位后的进程有独立的 cgroup，stop 杀不到。
//
// 为什么放在脚本最前面：必须在任何 systemctl stop 之前完成。
//
// 用环境变量 QQAGENT_INSTALLER_DETACHED 防无限递归。
if (process.env.INVOCATION_ID && !process.env.QQAGENT_INSTALLER_DETACHED) {
  const self = fileURLToPath(import.meta.url);
  const logFile = path.join(ROOT, 'data', 'kernel-updates', 'install.log');
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    // 找 sudo 密码（与 runCtl 同一套策略）
    const pwFile = process.env.QQ_SUDO_PASSWORD_FILE
      || path.join(os.homedir(), '.secrets', 'sudo', 'password');
    let pw = '';
    try { if (fs.existsSync(pwFile)) pw = fs.readFileSync(pwFile, 'utf8').trim(); } catch { /* 无 */ }

    const unit = `qqagent-installer-${Date.now()}`;
    const runArgs = [
      'systemd-run', `--unit=${unit}`, '--collect',
      '--property=Type=oneshot',
      `--property=StandardOutput=append:${logFile}`,
      `--property=StandardError=append:${logFile}`,
      '--setenv=QQAGENT_INSTALLER_DETACHED=1',
      `--setenv=KERNEL_ROOT=${ROOT}`,
      process.execPath, self, ...process.argv.slice(2)
    ];

    const r = pw
      ? spawnSync('sudo', ['-S', ...runArgs], { input: pw + '\n', encoding: 'utf8', timeout: 30000 })
      : spawnSync('sudo', ['-n', ...runArgs], { encoding: 'utf8', timeout: 30000 });

    if (r.status === 0) {
      console.log('[kernel-install] 已重定位到独立 unit，本进程退出');
      process.exit(0);
    }
    console.log(`[kernel-install] ⚠️ 重定位失败（${String(r.stderr || '').slice(0, 120)}），在当前 cgroup 继续`);
  } catch (e) {
    console.log(`[kernel-install] ⚠️ 重定位异常：${e?.message ?? e}，继续`);
  }
}


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
  //
  // 顺序按"版本从新到旧"排（2026-10-28 补）：
  // 3.0 起改名 BG-QQagent-Linux，老的 qq-agent-v2 仍然保留在列表里 ——
  // 老用户升级后目录名变了但服务名可能还是旧的，两个都得能认出来。
  for (const n of ['BG-QQagent-Linux', 'qq-agent-v3', 'qq-agent-v2', 'qq-agent', 'bg-qqagent']) {
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

  // 🔴 诊断增强（2026-10-25 事故教训）
  //    上次出事时 err 是空字符串，status/signal 全没记 ——
  //    「出事了但没留下任何线索」，完全无法定位是哪一层骗了返回值。
  return {
    ok: false,
    via: 'none',
    status: r.status,
    signal: r.signal,
    errCode: r.error?.code || '',
    err: String(r.stderr || '').slice(0, 200)
  };
}

/**
 * 重启服务：同样以实际状态为准，不看返回码
 */
function restartService() {
  const u = detectUnit();
  if (!u) { LOG('⚠️ 识别不到服务名，跳过重启'); return false; }
  const before = servicePid();
  const r = runCtl(['restart', u]);
  if (!r.ok) {
    LOG(`⚠️ systemctl restart 返回异常（status=${r.status} signal=${r.signal} code=${r.errCode} err=${r.err || '空'}），改为验证状态…`);
  }
  // 等它起来（restart 会换 PID，这里只确认 active）
  for (let i = 0; i < 30; i++) {
    const s = spawnSync('systemctl', ['is-active', u], { timeout: 10000, encoding: 'utf8' });
    if (String(s.stdout || '').trim() === 'active') {
      const after = servicePid();
      LOG(`   重启完成：PID ${before || '无'} → ${after || '无'}`);
      return true;
    }
    sleepSync(1000);
  }
  return false;
}

/** 停服务（替换文件前必须停，否则文件被占用） */
/**
 * 同步睡眠（脚本是同步流程，这里不做异步等待）
 */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, ms);
}

/**
 * 停服务：**不看返回码，看进程是否真的没了**
 *
 * 🔴 2026-10-25 事故（第二次同类）：
 *   systemctl 明明记了 "Deactivated successfully"，runCtl 却返回 ok:false，
 *   于是脚本判定「停不下」→ fail() 退出 → 但服务其实已经停了 → 控制台 502。
 *
 *   根因不是返回值本身，而是**用返回值代表状态**这件事本身不可靠。
 *   进程表不会说谎 —— 所以改成「调用后轮询确认」。
 *
 * @returns {boolean} 进程是否真的没了
 */
function stopService() {
  const u = detectUnit();
  if (!u) { LOG('⚠️ 识别不到服务名，跳过停止'); return false; }

  const r = runCtl(['stop', u]);
  if (!r.ok) {
    // 不急着判失败 —— 返回值可能骗人，下面按进程状态为准
    LOG(`⚠️ systemctl stop 返回异常（status=${r.status} signal=${r.signal} code=${r.errCode} err=${r.err || '空'}），改为验证进程状态…`);
  }

  // 轮询确认：最多等 30 秒
  for (let i = 0; i < 30; i++) {
    if (!servicePid()) return true;          // 进程没了 = 真的停了
    sleepSync(1000);
  }
  LOG('⚠️ 等待 30 秒后进程仍在，判定停止失败');
  return false;
}

/** 启动服务 */
/**
 * 启服务：**不看返回码，看 is-active**
 *
 * 与 stopService 同理 —— 返回值不可靠，实际状态才可信。
 */
function startService() {
  const u = detectUnit();
  if (!u) { LOG('⚠️ 识别不到服务名，跳过启动'); return false; }

  const r = runCtl(['start', u]);
  if (!r.ok) {
    LOG(`⚠️ systemctl start 返回异常（status=${r.status} signal=${r.signal} code=${r.errCode} err=${r.err || '空'}），改为验证状态…`);
  }

  for (let i = 0; i < 30; i++) {
    const s = spawnSync('systemctl', ['is-active', u], { timeout: 10000, encoding: 'utf8' });
    if (String(s.stdout || '').trim() === 'active') return true;
    sleepSync(1000);
  }
  LOG('⚠️ 等待 30 秒后服务仍未 active，判定启动失败');
  return false;
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
  // 找包内的顶层目录
  //
  // 不写死名字（2026-10-28 改注释）：
  //   2.x 的包顶层叫 qq-agent-v2/，3.x 叫 BG-QQagent-Linux/，
  //   以后还可能改。所以这里只判断"是不是唯一的目录"，
  //   不认具体名字 —— 否则每改一次名，老用户的升级包就全废。
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

/**
 * 读用户在界面上删过的 skill id 清单
 *
 * 与 src/skill.js 共用 data/deleted-skills.json —— 那边负责界面隐藏，
 * 这边负责"更新时别写回来"。少了任何一半，用户都会看到"删了又回来"。
 */
function deletedSkillIds() {
  try {
    const f = path.join(ROOT, 'data', 'deleted-skills.json');
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch { return new Set(); }
}

/**
 * 合并 skills/：只补缺失的文件，不动已有的
 *
 * @returns {number} 实际补进来的文件数
 */
function mergeSkills(srcDir, dstDir, skipIds = new Set()) {
  let added = 0;
  let skipped = 0;
  const walk = (rel) => {
    const src = path.join(srcDir, rel);
    const dst = path.join(dstDir, rel);
    let entries;
    try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of entries) {
      const r = path.join(rel, ent.name);
      if (ent.isDirectory()) { walk(r); continue; }
      const base = path.basename(ent.name, '.md');
      if (skipIds.has(base)) { skipped++; continue; }   // 用户删过 → 别再写回来
      const target = path.join(dstDir, r);
      if (fs.existsSync(target)) continue;   // 已有 → 绝不覆盖（可能是用户改过/故意留着）
      try {
        fs.copyFileSync(path.join(srcDir, r), target);
        added++;
      } catch (e) { LOG(`  ⚠️ 补入 skill ${r} 失败：${e?.message ?? e}`); }
    }
  };
  walk('');
  LOG(`   skills/ 合并：新增 ${added} 个，沿用 ${skipped} 个已删除，其余保持不变`);
  return added;
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
      // 🔴 skills/ 走「合并拷贝」，其余走「先删再拷」（2026-10-29 修）
      //
      // 用户反馈：把用不上的内置技能（阿里云部署教程）删了，
      // 一更新内核它又回来了 —— 因为这里对 skills/ 也是先 rm 再 cp，
      // 用户删掉的文件被新包里的同名文件原样恢复。
      //
      // 现在对 skills/ 改成只补**缺失**文件：
      //   用户删掉的不会被写回来，已有文件也不覆盖（用户可能改过）。
      // 代价是新版本内置技能有更新时不会自动同步 —— 但内置技能本来就很少改，
      // 且"用户能删掉自己不想要的东西"比"自动拿到新技能"更重要。
      // 需要同步时可手动删掉旧文件，下次更新就会补回来。
      if (it === 'skills') {
        n += mergeSkills(src, dst, deletedSkillIds());
        continue;
      }
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

/**
 * 把替换后的文件属主还给服务运行用户（2026-10-26）
 *
 * 问题：安装脚本可能以 root 身份运行（sudo systemd-run / sudo node）。
 *   cpSync 复制出来的文件属主就是 root，之后普通用户编辑会 Permission denied，
 *   更糟的是 git checkout / 打包都会失败。
 *
 * 做法：
 *   ① 从 systemd 查服务实际以哪个用户跑（最权威）
 *   ② 查不到就看 ROOT 目录本身的属主（通常是部署者）
 *   ③ 把替换过的那几项递归 chown 回去
 *
 * 以 root 跑的话还要 chown 自己的 sudo 权限才做得到；不是 root 且属主本来就对 → 什么都不用做。
 */
function restoreOwnership() {
  const items = ['src', 'ui', 'skills', 'scripts', 'test', 'electron', 'docs',
    'package.json', 'package-lock.json',
    'README.md', 'PLUGIN-ARCH.md', 'VOICE-RESEARCH.md',
    '插件与Skill制作及使用规范.md', '内核发布说明.md', '安装说明.md',
    '.gitignore', 'LICENSE'];

  // ① 查服务用户
  let targetUser = '';
  try {
    const u = detectUnit();
    if (u) {
      const r = spawnSync('systemctl', ['show', u, '-p', 'User', '--value'], { timeout: 10000, encoding: 'utf8' });
      targetUser = String(r.stdout || '').trim();
    }
  } catch { /* 忽略 */ }

  // ② 退而求其次：用 ROOT 目录本身的属主
  if (!targetUser) {
    try {
      const st = fs.statSync(ROOT);
      const uid = st.uid;
      // 用 id 把 uid 翻成用户名
      const r = spawnSync('id', ['-nu', String(uid)], { timeout: 5000, encoding: 'utf8' });
      targetUser = String(r.stdout || '').trim();
    } catch { /* 忽略 */ }
  }

  if (!targetUser || targetUser === 'root') {
    LOG('   属主检查：目标用户是 root 或无法确定，跳过');
    return;
  }

  // ③ 已经对了就不用改
  let needFix = [];
  for (const it of items) {
    const p = path.join(ROOT, it);
    try {
      if (!fs.existsSync(p)) continue;
      const st = fs.statSync(p);
      const r = spawnSync('stat', ['-c', '%U', p], { timeout: 5000, encoding: 'utf8' });
      const owner = String(r.stdout || '').trim();
      if (owner && owner !== targetUser) needFix.push(it);
    } catch { /* 跳过 */ }
  }

  if (!needFix.length) {
    LOG(`   属主检查：已全部属于 ${targetUser}，无需调整`);
    return;
  }

  LOG(`   发现 ${needFix.length} 项属主不是 ${targetUser}，正在修正…`);
  for (const it of needFix) {
    const p = path.join(ROOT, it);
    // 优先直接用 chown（本来就是该用户就不用 sudo）
    let r = spawnSync('chown', ['-R', `${targetUser}:${targetUser}`, p], { timeout: 60000, encoding: 'utf8' });
    if (r.status !== 0) {
      // 权限不够时走 sudo（沿用 runCtl 同样的密码策略）
      const pwFile = process.env.QQ_SUDO_PASSWORD_FILE
        || path.join(os.homedir(), '.secrets', 'sudo', 'password');
      try {
        if (fs.existsSync(pwFile)) {
          const pw = fs.readFileSync(pwFile, 'utf8').trim();
          r = spawnSync('sudo', ['-S', 'chown', '-R', `${targetUser}:${targetUser}`, p], {
            timeout: 120000, encoding: 'utf8', input: pw + '\n'
          });
        }
      } catch { /* 忽略 */ }
    }
    LOG(r.status === 0 ? `   ${it} 属主已改为 ${targetUser}` : `   ⚠️ ${it} 属主修正失败`);
  }
}

/**
 * 「安装到一半」标记（2026-10-26）
 *
 * 事故背景：脚本被 SIGTERM 杀掉时，如果已经替换了一部分文件，
 *   就会出现「src/ 一半新一半旧」—— 这种情况下服务起不来，
 *   而且用户不知道发生了什么，只能手动翻备份。
 *
 * 做法：替换前写 .install-pending（记录备份目录路径），
 *   健康探测通过后删掉。下次启动时如果发现标记还在，
 *   说明上次没装完 → 自动回滚到标记里记的备份。
 */
function pendingFile() {
  return path.join(ROOT, '.install-pending');
}

function writePending(bakDir) {
  try {
    fs.writeFileSync(pendingFile(), JSON.stringify({
      at: new Date().toISOString(),
      backup: path.basename(bakDir),
      backupPath: bakDir,
      pid: process.pid
    }, null, 2), 'utf8');
    LOG('   已写 .install-pending 标记（装完会删）');
  } catch (e) {
    LOG(`   ⚠️ 写标记失败：${e?.message ?? e}`);
  }
}

function clearPending() {
  try { if (fs.existsSync(pendingFile())) fs.unlinkSync(pendingFile()); } catch { /* 忽略 */ }
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

// ③.5 残留标记检测：上次装到一半？（2026-10-26）
//
// 如果 .install-pending 还在，说明上次替换文件后没能走到「健康探测通过」那步。
// 这种情况下 src/ 可能是半新半旧的状态，继续安装有风险 ——
// 先把最近的备份还原回去，让现场回到已知可用的状态。
try {
  const pf = pendingFile();
  if (fs.existsSync(pf)) {
    const info = JSON.parse(fs.readFileSync(pf, 'utf8'));
    LOG(`⚠️ 发现上次未完成的安装标记（${info.at}，备份 ${info.backup}）`);
    const bakPath = info.backupPath || path.join(ROOT, info.backup);
    if (fs.existsSync(bakPath)) {
      LOG('   正在回滚到该备份…');
      stopService();
      const items = fs.readdirSync(bakPath);
      let n = 0;
      for (const it of items) {
        try {
          fs.rmSync(path.join(ROOT, it), { recursive: true, force: true });
          fs.cpSync(path.join(bakPath, it), path.join(ROOT, it), { recursive: true });
          n++;
        } catch { /* 单文件失败不中断 */ }
      }
      LOG(`   已还原 ${n} 项，重新启动服务…`);
      startService();
      await new Promise((r) => setTimeout(r, 8000));
      LOG(serviceActive() ? '   现场已恢复' : '   ⚠️ 恢复后服务仍未起来，请手动检查');
    } else {
      LOG(`   ⚠️ 备份目录不存在（${bakPath}），跳过自动回滚`);
    }
    clearPending();
  }
} catch (e) {
  LOG(`⚠️ 检查残留标记出错（继续安装）：${e?.message ?? e}`);
}

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
// 阶段标记：用来区分「自己停服务时收到的 SIGTERM」和「外部误杀」
// 如果安装脚本还在内核的 cgroup 里（老版本 / 非 systemd-run 场景），
// systemctl stop 会连带把脚本自己也 SIGTERM 掉。
// 这种情况不能直接退出 —— 要先把服务拉起来，否则就是 502。
let phase = 'init';   // init | stopping | replacing | starting | done

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    LOG(`⚠️ 收到 ${sig}（阶段：${phase}）`);
    if (sig === 'SIGTERM' && (phase === 'stopping' || phase === 'replacing')) {
      // 典型的「被 systemctl stop 连带」场景：服务已经被停了，
      // 自己也被打了信号。此时必须把服务拉回来再退出。
      LOG('   这是停服务阶段的连带信号，拉起服务后退出');
      try { startService(); } catch { /* 尽力而为 */ }
    } else {
      emergencyRestart(sig);
    }
    process.exit(1);
  });
}


// 记下停服务前的 PID —— 后面用它判断「进程到底换没换」
const pidBefore = servicePid();
phase = 'stopping';
LOG(`⑤ 停止服务…（服务名 ${detectUnit() || '未识别'}，当前 PID ${pidBefore || '无'}）`);

// 🔴 2026-10-25 事故修复（两件事缺一不可）：
//   ① 真正调用 stopService()（它按进程状态判定，不信返回码）
//   ② 不论结果如何，退出前按**实际进程状态**设置 serviceStopped，
//      否则 fail() 的 exit 钩子会被 !serviceStopped 挡掉，服务裸停。
const stopped = stopService();

if (!servicePid()) {
  // 进程确实没了 —— 不管 stopService 返回什么，都置位让兜底能接管
  serviceStopped = true;
  if (!stopped) LOG('⚠️ 停止判定失败，但进程确实已停 → 交给兜底拉起');
} else {
  serviceStopped = false;   // 进程还在，兜底别动它
}

if (!stopped) {
  releaseLock();
  fail('停不下服务，已中止。服务仍在运行。', 6);
}
if (serviceStopped && !servicePid()) {
  LOG('⚠️ 停止判定与实际状态不一致（已停），由兜底负责拉起');
}
await new Promise((r) => setTimeout(r, 2000));

phase = 'replacing';
writePending(bakDir);        // 先落标记：万一中途挂了，下次启动能自动回滚
replace(newDir);
syncInstallerFromPackage(newDir);
restoreOwnership();          // 把 root 属主还回去，否则用户后续编辑/打包会失败

phase = 'starting';
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
phase = 'done';
clearPending();              // 装成功了，删标记
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
