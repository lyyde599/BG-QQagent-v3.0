// 静态检查：禁止用「WS 连接状态」判断「账号是否可用」
//
// 背景：同一个坑在本项目**出现过三次**（2026-09-14 / 09-16 / 09-17），每次都是把
//   onebot.connected（WS 是否连着）误当成"账号可用/已登录"：
//     1) 控制台状态栏       → 掉线显示"已连接"，5 小时无人发现
//     2) 二维码面板/侧栏    → 离线时显示"✅ 已登录"，不显示二维码
//     3) 二维码刷新守护     → 误判"已登录"直接跳过检查，二维码永不刷新
//   根因：NapCat 的 **WS 在账号离线时依然在监听**，connected 恒为 true。
//
// 与其靠"记得别写错"，不如让错误写不出来：本检查扫描源码，
// 凡是在"判断是否已登录/可用"的语境里使用 connected，就直接报错阻断。
//
// 用法：node test/lint-account-check.mjs   （已接入 npm test 的 selftest 前）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');

// 允许出现的例外（确实是"判断 WS 连接"本身的场景，不是"判断账号可用"）
const ALLOW = [
  // 连接状态上报给前端（前端会再看 account.online）
  /connected:\s*onebot\.connected/,
  // OneBot 重连触发条件
  /!status\.connected\s*&&/,
  // 传给前端由前端自行结合 account 判断
  /everConnected/
];

// 危险模式：在这些语境里出现 connected，说明是"把 WS 连接当成账号可用"
const DANGER = [
  { re: /isLoggedIn\s*:\s*\(\)\s*=>\s*!?!?\s*\w+\.connected/, why: 'isLoggedIn 判据用了 connected' },
  { re: /loggedIn\s*:\s*!?!?\s*\w+\.connected/, why: 'loggedIn 判据用了 connected' },
  { re: /if\s*\(\s*!?!?\s*\w+\.connected\s*\)\s*return\s*\{[^}]*logged-in/, why: '把 connected 当已登录直接返回' }
];

let bad = 0;
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));
for (const f of files) {
  const p = path.join(SRC, f);
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  lines.forEach((line, idx) => {
    const code = line.replace(/\/\/.*$/, '');   // 去注释
    if (!code.includes('connected')) return;
    if (ALLOW.some((a) => a.test(code))) return;
    for (const d of DANGER) {
      if (d.re.test(code)) {
        console.log(`❌ ${f}:${idx + 1}  ${d.why}`);
        console.log(`     ${line.trim()}`);
        console.log('     → 账号是否可用请用 onebotHealth.snapshot().online；仅"WS 是否连着"才用 connected');
        bad += 1;
      }
    }
  });
}

if (bad) {
  console.log(`\n发现 ${bad} 处「用 WS 连接状态冒充账号可用」的写法。`);
  console.log('这是本项目反复出现三次的事故模式（见记忆系统 23「五点二十」），请修正后再提交。');
  process.exit(1);
}
console.log('✔ 账号可用性判据检查通过（未发现 connected 误用）');
