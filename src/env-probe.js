// 环境探测与适配（2026-10-28）
//
// 背景：群友反馈"按版本装完还是报错"。
// 深一层的原因是：**每个人的 Linux 机器都不一样** ——
//   · 发行版不同（Ubuntu / Debian / CentOS / Arch / Alpine）
//   · 架构不同（x86_64 / arm64）
//   · 包管理器不同（apt / dnf / pacman / apk）
//   · Node 版本不同（有的系统源里还是 16）
//   · 有没有 systemd、有没有 sudo、有没有图形环境（NapCat 要 Xvfb）
//
// 所以「装之前先探一遍环境」不是可选项，是必须的。
// 探完给出一份**可执行的适配方案**，而不是让用户自己去猜。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 安全执行命令，失败返回 null（不抛） */
function tryExec(cmd, args = [], timeout = 5000) {
  try {
    return String(execFileSync(cmd, args, {
      timeout, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8'
    }) || '').trim();
  } catch { return null; }
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

// ── 发行版识别 ────────────────────────────────────────────────
const DISTRO_MAP = {
  ubuntu: 'apt', debian: 'apt', raspbian: 'apt', linuxmint: 'apt', pop: 'apt',
  centos: 'dnf', rhel: 'dnf', fedora: 'dnf', rocky: 'dnf', almalinux: 'dnf',
  arch: 'pacman', manjaro: 'pacman', endeavouros: 'pacman',
  alpine: 'apk', opensuse: 'zypper', 'opensuse-leap': 'zypper', 'opensuse-tumbleweed': 'zypper'
};

export function detectDistro() {
  // /etc/os-release 是标准做法（systemd 系统都有）
  try {
    const raw = fs.readFileSync('/etc/os-release', 'utf8');
    const kv = {};
    for (const line of raw.split('\n')) {
      const m = /^([A-Z_]+)="?([^"]*)"?$/.exec(line.trim());
      if (m) kv[m[1]] = m[2];
    }
    const id = String(kv.ID || '').toLowerCase();
    const like = String(kv.ID_LIKE || '').toLowerCase().split(/\s+/);
    const name = kv.PRETTY_NAME || kv.NAME || id || 'unknown';

    // ID 不认识就看 ID_LIKE（如 EndeavourOS 是 arch 的 ID_LIKE）
    let pkg = DISTRO_MAP[id];
    if (!pkg) {
      for (const l of like) if (DISTRO_MAP[l]) { pkg = DISTRO_MAP[l]; break; }
    }
    return {
      id, name, version: kv.VERSION_ID || '',
      pkg: pkg || '',
      family: pkg === 'apt' ? 'debian' : pkg === 'dnf' ? 'rhel' : pkg === 'pacman' ? 'arch' : pkg === 'apk' ? 'alpine' : 'unknown'
    };
  } catch {
    return { id: 'unknown', name: 'unknown', version: '', pkg: '', family: 'unknown' };
  }
}

/** 探测 Node 情况 */
export function detectNode() {
  const v = process.version.replace(/^v/, '');
  const major = parseInt(v.split('.')[0], 10) || 0;
  const pkg = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')); } catch { return {}; } })();
  const need = String(pkg?.engines?.node || '>=20.0.0').replace(/[^\d.]/g, '');
  const needMajor = parseInt(need.split('.')[0], 10) || 20;
  return {
    version: v, major,
    ok: major >= needMajor,
    required: '>=' + needMajor,
    path: process.execPath,
    // nvm/fnm 装的和系统源装的，升级方式完全不同
    managed: /\.nvm|\.fnm|\.volta/.test(process.execPath)
  };
}

/** 探测系统能力 */
export function detectSystem() {
  const has = (cmd) => tryExec('which', [cmd]) !== null;
  return {
    arch: process.arch,                    // x64 / arm64
    platform: process.platform,            // linux / win32 / darwin
    kernel: tryExec('uname', ['-r']) || '',
    systemd: exists('/run/systemd/system'),
    sudo: has('sudo'),
    xvfb: has('Xvfb'),                     // NapCat 需要图形环境
    git: has('git'),
    pm2: has('pm2'),
    docker: has('docker'),
    memMB: Math.round(os.totalmem() / 1024 / 1024),
    cpuCount: os.cpus().length,
    diskFreeMB: (() => {
      try {
        const out = tryExec('df', ['-m', '/']) || '';
        const line = out.split('\n')[1] || '';
        return parseInt(line.split(/\s+/)[3], 10) || 0;
      } catch { return 0; }
    })(),
    // 时区（铁律 0.5：面向用户的时间要按北京时间）
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  };
}

// ── 依赖包名映射（不同发行版叫法不同） ──────────────────────────
const PKG_NAMES = {
  git: { apt: 'git', dnf: 'git', pacman: 'git', apk: 'git', zypper: 'git' },
  curl: { apt: 'curl', dnf: 'curl', pacman: 'curl', apk: 'curl', zypper: 'curl' },
  xvfb: { apt: 'xvfb', dnf: 'xorg-x11-server-Xvfb', pacman: 'xorg-server-xvfb', apk: 'xvfb', zypper: 'xvfb' },
  sudo: { apt: 'sudo', dnf: 'sudo', pacman: 'sudo', apk: 'sudo', zypper: 'sudo' },
  unzip: { apt: 'unzip', dnf: 'unzip', pacman: 'unzip', apk: 'unzip', zypper: 'unzip' },
  // Linux QQ 的运行时依赖（Electron 那套），漏一个就白屏
  qqlibs: {
    apt: 'libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libuuid1 libsecret-1-0',
    dnf: 'gtk3 libnotify nss libXScrnSaver libXtst xdg-utils at-spi2-atk libuuid libsecret',
    pacman: 'gtk3 libnotify nss libxss libxtst xdg-utils at-spi2-atk util-linux libsecret',
    apk: 'gtk+3.0 libnotify nss libxss libxtst xdg-utils at-spi2-atk libuuid libsecret',
    zypper: 'gtk3 libnotify4 mozilla-nss libXScrnSaver libXtst xdg-utils at-spi2-core libuuid1 libsecret-1-0'
  }
};

function pkgCmd(pkgMgr, names) {
  switch (pkgMgr) {
    case 'apt': return `sudo apt-get update && sudo apt-get install -y ${names}`;
    case 'dnf': return `sudo dnf install -y ${names}`;
    case 'pacman': return `sudo pacman -S --needed --noconfirm ${names}`;
    case 'apk': return `sudo apk add ${names}`;
    case 'zypper': return `sudo zypper install -y ${names}`;
    default: return '# 未知包管理器，请手动安装：' + names;
  }
}

/**
 * 完整探测 + 生成适配方案。
 *
 * 返回结构：
 *   ok            环境是否可直接跑
 *   issues[]      必须先解决的问题（阻塞）
 *   warnings[]    建议处理（不阻塞）
 *   plan[]        可执行的适配步骤
 */
export function probe() {
  const distro = detectDistro();
  const node = detectNode();
  const sys = detectSystem();
  const issues = [];
  const warnings = [];
  const plan = [];

  // ① 平台
  if (sys.platform !== 'linux') {
    issues.push(`当前系统是 ${sys.platform}，本项目按 Linux 设计（systemd + 包管理器）。非 Linux 建议用 Docker。`);
  }

  // ② Node 版本
  if (!node.ok) {
    issues.push(`Node 版本过低：当前 v${node.version}，需要 ${node.required}。`);
    if (distro.pkg === 'apt') {
      plan.push({
        step: '升级 Node',
        reason: 'Ubuntu/Debian 源里的 Node 通常版本偏低',
        cmds: [
          'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -',
          'sudo apt-get install -y nodejs'
        ]
      });
    } else if (distro.pkg === 'dnf') {
      plan.push({
        step: '升级 Node',
        reason: 'RHEL 系需要先启用 NodeSource 源',
        cmds: [
          'curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -',
          'sudo dnf install -y nodejs'
        ]
      });
    } else if (node.managed) {
      plan.push({
        step: '升级 Node',
        reason: '检测到你是用 nvm/fnm 管理的 Node',
        cmds: ['nvm install 20 && nvm use 20', '# 或：fnm install 20 && fnm use 20']
      });
    } else {
      plan.push({
        step: '升级 Node',
        reason: '无法自动判断升级方式',
        cmds: [`# 请把 Node 升到 ${node.required}，推荐用 nvm：`, 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash', 'nvm install 20']
      });
    }
  } else if (node.major > 22) {
    warnings.push(`Node v${node.version} 比验证过的版本新（20/22）。大概率可用，出问题先降到 22 试。`);
  }

  // ③ 内存
  if (sys.memMB < 900) {
    issues.push(`内存只有 ${sys.memMB}MB。QQ 客户端（Electron）本身要吃 500MB+，跑不动。建议 ≥2G。`);
  } else if (sys.memMB < 1900) {
    warnings.push(`内存 ${sys.memMB}MB 偏紧。建议加 swap（1~2G），否则容易 OOM。`);
    plan.push({
      step: '加 swap',
      reason: `${sys.memMB}MB 内存跑 QQ + 机器人容易崩`,
      cmds: [
        'sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile',
        'sudo mkswap /swapfile && sudo swapon /swapfile',
        'echo \'/swapfile none swap sw 0 0\' | sudo tee -a /etc/fstab'
      ]
    });
  }

  // ④ systemd
  if (!sys.systemd) {
    issues.push('没有检测到 systemd。本项目的进程守护、定时任务都依赖它。容器环境需要特殊处理。');
  }

  // ⑤ 磁盘
  if (sys.diskFreeMB > 0 && sys.diskFreeMB < 3000) {
    warnings.push(`根分区只剩 ${sys.diskFreeMB}MB。安装 QQ + NapCat 约需 1.5G，可能不够。`);
  }

  // ⑥ 图形环境（NapCat 需要）
  if (!sys.xvfb) {
    warnings.push('没装 Xvfb。NapCat 需要虚拟显示器才能启动 QQ 客户端。');
    const names = PKG_NAMES.xvfb[distro.pkg];
    if (names) {
      plan.push({
        step: '安装 Xvfb',
        reason: 'NapCat 依赖图形环境，无头服务器必须用虚拟显示器',
        cmds: [pkgCmd(distro.pkg, names)]
      });
    }
  }

  // ⑦ QQ 运行时依赖
  const qqLibs = PKG_NAMES.qqlibs[distro.pkg];
  if (qqLibs && distro.pkg) {
    // 抽查一个关键库：libnss3 / nss
    const probeLib = distro.pkg === 'apt' ? 'libnss3' : 'nss';
    const hasLib = tryExec(distro.pkg === 'apk' ? 'apk' : (distro.pkg === 'pacman' ? 'pacman' : 'dpkg'), 
      distro.pkg === 'apt' ? ['-l', probeLib] : ['-Q', probeLib].slice(0,1), 4000);
    if (hasLib === null) {
      warnings.push('QQ 客户端所需的系统库可能不全（缺 GUI 运行库会导致启动白屏）。');
      plan.push({
        step: '安装 QQ 运行库',
        reason: 'Linux QQ 是 Electron 应用，缺库会直接起不来',
        cmds: [pkgCmd(distro.pkg, qqLibs)]
      });
    }
  }

  // ⑧ 时区（铁律 0.5）
  if (!sys.tz || sys.tz === 'UTC') {
    warnings.push(`系统时区是 ${sys.tz || '未知'}。面向用户的时间要按北京时间显示，建议设 TZ=Asia/Shanghai。`);
  }

  // ⑨ 架构提示
  if (sys.arch === 'arm64') {
    warnings.push('arm64 架构。QQ/NapCat 的 arm64 包比 x64 少，版本选择更受限。');
  }

  return {
    ok: issues.length === 0,
    distro, node, sys,
    issues, warnings, plan,
    summary: issues.length
      ? `发现 ${issues.length} 个阻塞问题、${warnings.length} 个提醒`
      : `环境可用${warnings.length ? `（${warnings.length} 个提醒）` : ''}`
  };
}

/** 渲染成可读文本（给群/日志用） */
export function renderProbe(r) {
  const L = [];
  L.push('════ 环境检查 ════');
  L.push(`系统：${r.distro.name}（${r.sys.arch}，内核 ${r.sys.kernel}）`);
  L.push(`包管理：${r.distro.pkg || '未知'}`);
  L.push(`Node：v${r.node.version}（需要 ${r.node.required}）${r.node.ok ? ' ✓' : ' ✗'}`);
  L.push(`内存：${r.sys.memMB}MB　CPU：${r.sys.cpuCount} 核　磁盘余：${r.sys.diskFreeMB}MB`);
  L.push(`systemd：${r.sys.systemd ? '有' : '无'}　Xvfb：${r.sys.xvfb ? '有' : '无'}`);
  L.push('');

  if (r.issues.length) {
    L.push('【必须先解决】');
    for (const i of r.issues) L.push('　✗ ' + i);
    L.push('');
  }
  if (r.warnings.length) {
    L.push('【建议处理】');
    for (const w of r.warnings) L.push('　⚠ ' + w);
    L.push('');
  }
  if (r.plan.length) {
    L.push('【适配步骤】');
    r.plan.forEach((p, i) => {
      L.push(`　${i + 1}. ${p.step} —— ${p.reason}`);
      for (const c of p.cmds) L.push(`　　 ${c}`);
    });
  }
  if (!r.issues.length && !r.plan.length) {
    L.push('环境没有问题，可以直接装。');
  }
  return L.join('\n');
}
