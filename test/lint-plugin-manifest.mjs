#!/usr/bin/env node
// 插件 manifest 体检（2026-10-28）
//
// 起因：rl-growth 和 auto-review 漏了 "ui": "ui.js" 与 uiTab.id，
// 内核登记 uiTab 时 file 为空 → 顶栏页签失效 → 回退到通用表单，
// 用户看到的是 startStage/learnGoal/moodWeight 这些英文键名。
//
// 这类问题不报错、不崩溃，只是"面板变英文"，很难被发现。
// 所以做成静态检查，进 npm test。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS = path.join(ROOT, 'plugins');

let errors = 0;
let warnings = 0;
let checked = 0;

function err(id, msg) { console.error(`  ✗ ${id}: ${msg}`); errors++; }
function warn(id, msg) { console.warn(`  ⚠ ${id}: ${msg}`); warnings++; }

if (!fs.existsSync(PLUGINS)) {
  console.error('  找不到 plugins/ 目录');
  process.exit(1);
}

for (const dir of fs.readdirSync(PLUGINS)) {
  const mf = path.join(PLUGINS, dir, 'manifest.json');
  if (!fs.existsSync(mf)) continue;
  checked++;

  let m;
  try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); }
  catch (e) { err(dir, 'manifest.json 不是合法 JSON：' + e.message); continue; }

  // ① 目录名必须等于 id
  if (m.id !== dir) err(dir, `id「${m.id}」与目录名不一致`);

  // ② 有 ui.js 就必须声明 ui
  const hasUi = fs.existsSync(path.join(PLUGINS, dir, 'ui.js'));
  if (hasUi && !m.ui) {
    err(dir, '有 ui.js 但 manifest 没写 "ui": "ui.js" —— 面板会退化成英文通用表单');
  }
  if (m.ui && !fs.existsSync(path.join(PLUGINS, dir, m.ui))) {
    err(dir, `manifest.ui 指向 ${m.ui}，但文件不存在`);
  }

  // ③ uiTab 必须有 id（否则登记出 file 为空的页签）
  if (m.uiTab) {
    if (!m.uiTab.id) err(dir, 'uiTab 缺 id —— 顶栏页签无法生成');
    if (!m.uiTab.label) warn(dir, 'uiTab 缺 label');
    if (!m.ui) err(dir, '有 uiTab 但没声明 ui，页签加载不到内容');
  }

  // ④ entry 必须存在
  const entry = m.entry || 'index.js';
  if (!fs.existsSync(path.join(PLUGINS, dir, entry))) {
    err(dir, `entry 指向 ${entry}，但文件不存在`);
  }

  // ⑤ 常用字段
  if (!m.version) warn(dir, '缺 version');
  if (!m.name) warn(dir, '缺 name');
}

if (errors === 0) {
  console.log(`  ✓ 插件 manifest 检查通过（${checked} 个插件${warnings ? `，${warnings} 条警告` : ''}）`);
  process.exit(0);
}
console.error(`\n  共 ${errors} 处错误、${warnings} 条警告`);
process.exit(1);
