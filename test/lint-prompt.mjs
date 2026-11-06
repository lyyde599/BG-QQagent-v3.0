#!/usr/bin/env node
// ── prompt lint（2026-11-06 P2-17）────────────────────────────────
//
// 用户清单："system 约 9.5k + user 约 7k；重复规则多；
//   persona/prompt 可能提到未挂载的工具。指令过载 + 假能力。"
//
// 这个脚本只**检查不改**，四类问题：
//   ① 重复：同一句话（长度 ≥ 12）出现两次以上
//   ② 假能力：提到某工具名，但本轮没挂载
//   ③ 否定堆叠：一段里"不要/别/禁止"超过 N 次（模型抓不住重点）
//   ④ 体积：system prompt 超过阈值就提醒
//
// 退出码：0 通过 | 1 有问题 | 2 前置不满足

import { buildSystemPrompt } from '../src/prompt.js';

// 已知工具名（用于"提到但没挂载"检测）
const KNOWN_TOOLS = [
  'send_message', 'send_sticker', 'send_poke', 'send_image', 'send_local_image',
  'get_message_images', 'get_recent_messages', 'web_search', 'web_fetch',
  'memory_append', 'memory_query', 'memory_remove', 'memory_update',
  'memory_search', 'memory_forget', 'load_skill', 'write_file', 'read_file',
];

const LIMITS = {
  systemMaxChars: 26000,     // 单 system prompt 上限（字符）
  dupMinLen: 12,             // 视为"重复句"的最短长度
  negPerBlock: 6,            // 单段落里"不要/别/禁止"最多几次
};

function normalizeLine(s) {
  return String(s || '')
    .replace(/^[\s·•\-*\d.、]+/, '')
    .replace(/\s+/g, '')
    .trim();
}

function lint(systemText, availableTools) {
  const problems = [];
  const warns = [];
  const text = String(systemText || '');

  // ④ 体积
  if (text.length > LIMITS.systemMaxChars) {
    problems.push(`system prompt 过长：${text.length} 字符（上限 ${LIMITS.systemMaxChars}）`);
  }

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // ① 重复句
  const seen = new Map();
  for (const ln of lines) {
    const n = normalizeLine(ln);
    if (n.length < LIMITS.dupMinLen) continue;
    seen.set(n, (seen.get(n) || 0) + 1);
  }
  for (const [n, c] of seen) {
    if (c > 1) problems.push(`重复出现 ${c} 次：「${n.slice(0, 30)}…」`);
  }

  // ② 假能力：提到工具但没挂载
  //
  // 🔴 判据要收紧（2026-11-06 实测）
  //   第一版把"提到名字"就算问题，结果 9 处全是误报 ——
  //   像"要发图就调工具"这种通用说明也提到 send_image，但不会误导模型。
  //
  // 真正会误导的只有两类：
  //   ⓐ 祈使句：「用 X」「调 X」「先 X 再」 —— 在命令模型去调它
  //   ⓑ 能力断言：「你能 X」「可以 X」 —— 在告诉模型它有这个能力
  const set = availableTools instanceof Set ? availableTools
    : new Set(Array.isArray(availableTools) ? availableTools : []);
  for (const tool of KNOWN_TOOLS) {
    if (set.has(tool)) continue;
    const id = `(?<![a-z0-9_])${tool}(?![a-z0-9_])`;
    const imperative = new RegExp(`(用|调|调用|使用|先)\s*[「\"]?${id}`, 'i');
    const assertion = new RegExp(`(你(能|可以)|(可|能)以?用)\s*[「\"]?${id}`, 'i');
    if (imperative.test(text) || assertion.test(text)) {
      problems.push(`要求使用「${tool}」，但本轮没挂载它 —— 模型会去调一个不存在的工具`);
    }
  }

  // ③ 否定堆叠（按自然段 = 空行分隔）
  for (const block of text.split(/\n\s*\n/)) {
    const negs = (block.match(/不要|别|禁止|不许|不准|绝不/g) || []).length;
    if (negs > LIMITS.negPerBlock) {
      const head = block.trim().slice(0, 24).replace(/\n/g, ' ');
      warns.push(`一段里有 ${negs} 处否定，模型会抓不住重点：「${head}…」`);
    }
  }

  return { problems, warns, chars: text.length, lines: lines.length };
}

// ── 跑三种典型配置 ─────────────────────────────────
const CASES = [
  { name: '全工具（含记忆 + vision）', tools: new Set([
    'send_message', 'get_message_images', 'web_search', 'memory_append',
    'send_sticker', 'send_poke', 'get_recent_messages', 'load_skill',
  ]) },
  { name: '最小工具（只有发送）', tools: new Set(['send_message']) },
  { name: '无工具', tools: new Set([]) },
];

let bad = 0;
for (const c of CASES) {
  let sys = '';
  try {
    sys = buildSystemPrompt({ availableTools: c.tools });
  } catch (e) {
    console.log(`  ✗ ${c.name}：构建失败 ${e.message}`);
    bad += 1;
    continue;
  }
  const r = lint(sys, c.tools);
  if (r.problems.length) {
    bad += 1;
    console.log(`  ✗ ${c.name}（${r.chars} 字符）`);
    for (const p of r.problems.slice(0, 6)) console.log(`      · ${p}`);
    if (r.problems.length > 6) console.log(`      … 另有 ${r.problems.length - 6} 条`);
  } else {
    console.log(`  ✓ ${c.name}（${r.chars} 字符 / ${r.lines} 行）`);
  }
  for (const w of r.warns.slice(0, 3)) console.log(`      ⚠ ${w}`);
}

if (bad) {
  console.log(`\n❌ prompt lint 未通过：${bad} 个配置有问题`);
  process.exit(1);
}
console.log('\n✅ prompt lint 通过');
