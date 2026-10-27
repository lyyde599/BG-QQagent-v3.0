#!/usr/bin/env node
// 账号在线判定 lint（2026-10-27 重建）
//
// 背景：官方发布包里这个文件丢了，但 package.json 还在引用，导致 npm test 直接
// MODULE_NOT_FOUND。它原本拦的坑是真实的：
//
//   ⚠️ 不能用 onebot.connected（WS 是否连着）判断账号是否在线
//      NapCat 的 WS 在账号离线时依然在监听 —— 用 connected 会让面板显示
//      「✅ 已登录」，于是不显示二维码，用户想重登都没码可扫。
//      这个 bug 在 09-14 / 09-16 / 09-17 犯过三次。
//
// 正确判据：onebotHealth.snapshot().online === true
//
// 这里只做静态扫描，不连网、不启动服务，秒级完成。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// 需要检查的文件（面板与状态接口所在）
const TARGETS = [
  'src/app.js',
  'ui/app.js',
];

// 白名单：这些行提 connected 是合法的
const ALLOW = [
  /不能用.*connected/,          // 注释里的警示
  /不能.*onebot\.connected/,
  /healthy:/,                   // 综合健康判定（connected && online 一起看）
  /!status\.connected/,         // 401 重连逻辑
  /WebSocket/i,
  /isServiceActive/,
  /\$\{.*connected/,
  // 「等网关重启完成」的轮询：这里 connected 正是要判的对象（2026-10-27）
  /ob\.connected/,
];

// 上下文豁免：如果同一函数块里已经先判过账号在线（acctOffline / online === false），
// 再用 connected 判 WS 就是合法的 —— 460 行那种写法。
const NEEDS_ACCOUNT_CTX = [
  /s\.onebot\.connected/,
];

let errors = 0;
let checked = 0;

for (const rel of TARGETS) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  checked++;
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // 找「把 connected 当登录态用」的写法
    const suspicious =
      /if\s*\(\s*[a-zA-Z_.]*\.connected\s*\)/.test(line) ||
      /log+ed?In\s*[:=]\s*[a-zA-Z_.]*\.connected/.test(line) ||
      /online\s*:\s*[a-zA-Z_.]*\.connected/.test(line);
    if (!suspicious) return;
    if (ALLOW.some((re) => re.test(line))) return;
    // 上下文豁免：往上找 30 行，若有账号在线判定，则这条只是补充判 WS
    if (NEEDS_ACCOUNT_CTX.some((re) => re.test(line))) {
      const from = Math.max(0, i - 30);
      const ctx = lines.slice(from, i).join('\n');
      if (/acctOffline|online === false|acct\.online/.test(ctx)) return;
    }
    console.error(`  ✗ ${rel}:${i + 1}  疑似用 connected 判断账号在线`);
    console.error(`    ${line.trim().slice(0, 100)}`);
    console.error(`    应改用 onebotHealth.snapshot().online`);
    errors++;
  });
}

if (errors === 0) {
  console.log(`  ✓ 账号在线判定检查通过（扫描 ${checked} 个文件）`);
  process.exit(0);
}
console.error(`\n  共 ${errors} 处可疑写法，请改用 online 判定`);
process.exit(1);
