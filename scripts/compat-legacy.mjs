#!/usr/bin/env node
// 老版本兼容处理（2026-10-28）
//
// 背景：3.0 起项目改名为 BG-QQagent-Linux（原 qq-agent-v2）。
// 改名本身不影响老用户 —— 安装脚本是"逐项替换文件"，不改目录名。
// 但有三处会踩坑，这个脚本负责补上：
//
//   ① 服务名：老用户机器上叫 qq-agent-v2，新机器叫 BG-QQagent-Linux。
//      任何写死服务名的地方（文档、脚本、告警）都会失效。
//   ② 旧路径引用：data 里存的绝对路径、插件里写的路径，
//      换目录后全部找不到。
//   ③ 反向软链：老脚本/老文档里写死的 /path/qq-agent-v2 ，
//      在改名的机器上会 404。
//
// 用法：
//   node scripts/compat-legacy.mjs            # 检查并修复
//   node scripts/compat-legacy.mjs --check    # 只检查不修

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

const log = (m) => console.log(m);
const ok = (m) => console.log('  ✓ ' + m);
const warn = (m) => console.log('  ⚠️ ' + m);
const todo = (m) => console.log('  → ' + m);

// ── ① 探测当前服务名 ──
function detectUnit() {
  // 优先按 WorkingDirectory 匹配（不管叫什么名字都能认出来）
  try {
    const dirs = ['/etc/systemd/system', '/lib/systemd/system', '/usr/lib/systemd/system'];
    for (const d of dirs) {
      let files = [];
      try { files = fs.readdirSync(d).filter((f) => f.endsWith('.service')); } catch { continue; }
      for (const f of files) {
        let txt = '';
        try { txt = fs.readFileSync(path.join(d, f), 'utf8'); } catch { continue; }
        const wd = /WorkingDirectory=(.+)/.exec(txt);
        if (wd && path.resolve(wd[1].trim()) === ROOT) return f.replace(/\.service$/, '');
        if (txt.includes(ROOT)) return f.replace(/\.service$/, '');
      }
    }
  } catch { /* ignore */ }

  // 兜底：常见名（新的在前）
  for (const n of ['BG-QQagent-Linux', 'qq-agent-v3', 'qq-agent-v2', 'qq-agent', 'bg-qqagent']) {
    try {
      const s = execSync(`systemctl show ${n} -p LoadState --value 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (s === 'loaded') return n;
    } catch { /* ignore */ }
  }
  return '';
}

// ── ② 检查数据里的旧绝对路径 ──
function checkStalePaths() {
  const cfgFile = path.join(ROOT, 'data', 'config.json');
  if (!fs.existsSync(cfgFile)) return [];
  let raw = '';
  try { raw = fs.readFileSync(cfgFile, 'utf8'); } catch { return []; }

  // 找出所有 /xxx/qq-agent-v2/ 形式、且指向不存在位置的路径
  const hits = [];
  const re = /"(\/[^"]*qq-agent-v2[^"]*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const p = m[1];
    if (!fs.existsSync(p)) hits.push(p);
  }
  return [...new Set(hits)];
}

// ── ③ 反向软链：老路径 → 当前目录 ──
function ensureLegacyLink() {
  const parent = path.dirname(ROOT);
  const base = path.basename(ROOT);
  if (base === 'qq-agent-v2') return { skipped: '当前目录名就是 qq-agent-v2，无需软链' };

  const linkPath = path.join(parent, 'qq-agent-v2');
  if (fs.existsSync(linkPath)) {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(linkPath);
      if (path.resolve(parent, target) === ROOT) return { exists: true, path: linkPath };
      return { conflict: `已是软链但指向 ${target}` };
    }
    return { conflict: '同名目录/文件已存在，不是软链' };
  }

  if (CHECK_ONLY) return { missing: true, path: linkPath };
  try {
    fs.symlinkSync(base, linkPath);
    return { created: true, path: linkPath };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

// ── 主流程 ──
log('老版本兼容检查');
log(`  当前目录：${ROOT}`);
log('');

const unit = detectUnit();
if (unit) ok(`服务名：${unit}`);
else warn('没探测到服务名 —— 服务可能没装，或者 WorkingDirectory 不指向这里');

const stale = checkStalePaths();
if (!stale.length) {
  ok('data/config.json 里没有失效的旧路径');
} else {
  warn(`data/config.json 里有 ${stale.length} 条旧路径已失效：`);
  stale.slice(0, 5).forEach((p) => todo(p));
  if (stale.length > 5) todo(`……还有 ${stale.length - 5} 条`);
  if (!CHECK_ONLY) {
    log('  这些路径是历史遗留（旧目录/旧机器），需要手动改。');
    log('  常见处理：把 /xxx/qq-agent-v2 换成 ' + ROOT);
  }
}

const link = ensureLegacyLink();
if (link.exists) ok(`旧路径软链已存在：${link.path}`);
else if (link.created) ok(`已创建旧路径软链：${link.path} → ${path.basename(ROOT)}`);
else if (link.missing) todo(`建议创建软链：${link.path} → ${path.basename(ROOT)}`);
else if (link.skipped) ok(link.skipped);
else if (link.conflict) warn(`软链未创建：${link.conflict}`);
else if (link.error) warn(`软链创建失败：${link.error}`);

log('');
log(CHECK_ONLY ? '（--check 模式，没有改动任何东西）' : '检查完成');
