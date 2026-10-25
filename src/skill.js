// ── Skill 系统（2026-10-21）────────────────────────────────────────────
//
// Skill = 一段**按需加载的知识**。与工具的区别：
//   · 工具  → 模型调用后**做事**（发消息、查库、改配置）
//   · Skill → 模型读过之后**知道怎么做**（规范、套路、领域知识）
//
// 为什么需要它：
//   有些知识很长（插件开发规范、圣杯规则、教学法），常驻提示词会吃掉大量 token，
//   而模型大部分时间用不到。Skill 让模型**需要时才读**——
//   提示词里只留一行索引（名字 + 一句话说明），真正内容靠 load_skill 取。
//
// 三个内置来源：
//   ① 内核内置（BUILTIN_SKILLS）—— 与产品强绑定，随内核走
//   ② 插件注册（ctx.skill.register）—— 插件自带的知识，卸载即消失
//   ③ 用户目录（skills/*.md）—— 主人自己写的，改文件即生效，不用改代码
//
// 三者合并时按 id 去重：插件 > 用户 > 内核内置（后者可被覆盖）。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const USER_SKILL_DIR = path.join(ROOT, 'skills');

/**
 * 内核内置 skill。
 *
 * 判据：这段知识**离开本产品就没意义**，且大部分用户会需要。
 * 如果只是某个插件的事（比如圣杯规则），应该由插件自己注册。
 */
const BUILTIN_SKILLS = [
  {
    id: 'plugin-spec',
    name: '插件开发规范',
    summary: 'manifest 字段、权限分组、ctx 能力、打包发布与常见坑',
    when: '主人要求新增/修改插件，或问"插件怎么写"时',
    author: '白光',
    // 内容不内联：指向仓库里的文档，避免同一份规范维护两处
    file: '插件与Skill制作及使用规范.md'
  },
  {
    id: 'skill-spec',
    name: 'Skill 编写规范',
    summary: 'frontmatter 怎么写、when 怎么描述、什么样的知识适合做成 skill',
    when: '主人要求新增/修改 skill，或问"skill 怎么写"时',
    author: '白光',
    body: `# Skill 编写规范

## 什么是 skill
把"离开本产品就没意义、但机器人该知道"的知识写成 .md 放 skills/ 目录。
文件放进目录即生效，**不用重启**，下一轮运行就能看到。

## 文件格式（极简 frontmatter）

\`\`\`
---
name: 技能名（必填，缺了会退回文件名）
summary: 一句话说清这个技能是干什么的（必填）
when: 什么时候该读它（越具体越好）
author: 白光
version: 1.0.0
license: MIT
---

正文：真正的知识内容。
\`\`\`

## 三个字段的作用
| 字段 | 谁在看 | 写不好会怎样 |
|:--|:--|:--|
| name | 人 | 显示成文件名 |
| summary | **模型** | 模型不知道这技能干什么，永远不会读 |
| when | **模型** | 不知道什么时候该读，等于没写 |

**summary 和 when 是给模型判断用的**，不是给人看的简介。写"XX 相关"等于没写。

## 什么样的知识适合做成 skill
✅ 适合：
  · 操作步骤（"怎么改配置"、"怎么部署"）
  · 领域规则（"圣杯战争的结算规则"）
  · 排错手册（"出现 XXX 报错时怎么查"）

❌ 不适合：
  · 一次性的临时信息（写进对话就行）
  · 能直接查到的事实（模型自己知道或能搜）
  · 插件自己的私有逻辑（那该写在插件里）

## 好的 when 长什么样
- ❌ "需要时"              → 模型不知道什么时候算"需要"
- ❌ "关于学习"            → 太宽，天天都像"关于学习"
- ✅ "主人要求新增/修改插件，或问'插件怎么写'时"
- ✅ "主人说'改配置'时怎么改、哪些能改、哪些不能"

## 与插件的关系
| | skill | 插件 |
|:--|:--|:--|
| 形态 | 单个 .md | 目录（manifest + index.js） |
| 能力 | **只能被读取**（给模型知识） | 能执行代码、发消息、注册工具 |
| 生效 | 放进目录即生效 | 需要 enable + 可能需要重启 |
| 适用 | 知识、规范、步骤 | 功能、集成、外部交互 |

**能用 skill 表达的，优先用 skill** —— 它更轻、更安全、改完不用重启。`
  },
];

/** 插件注册的 skill（运行时填充） */
const pluginSkills = new Map();   // id → { ...def, source: 'plugin', pluginId }

/** 用户目录扫描缓存 */
let userCache = null;

/** 扫描 skills/ 目录下的 .md 文件 */
function scanUserSkills() {
  if (userCache) return userCache;
  const out = [];
  try {
    for (const f of fs.readdirSync(USER_SKILL_DIR)) {
      if (!f.endsWith('.md')) continue;
      // README 是给人看的说明，不是给模型的技能
      if (/^readme\.md$/i.test(f)) continue;
      const id = f.replace(/\.md$/, '');
      try {
        const raw = fs.readFileSync(path.join(USER_SKILL_DIR, f), 'utf8');
        // 支持极简 frontmatter：
        //   ---
        //   name: 名字
        //   summary: 一句话
        //   when: 什么时候用
        //   ---
        //   正文...
        let meta = {};
        let body = raw;
        const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
        if (fm) {
          body = raw.slice(fm[0].length);
          for (const line of fm[1].split('\n')) {
            const m = /^(\w+)\s*:\s*(.+)$/.exec(line.trim());
            if (m) meta[m[1]] = m[2].trim();
          }
        }
        out.push({
          id,
          name: meta.name || id,
          summary: meta.summary || '',
          when: meta.when || '',
          version: meta.version || '',      // 市场用它比版本
          author: meta.author || '',        // 作者归属
          license: meta.license || '',
          body: body.trim(),
          source: 'user'
        });
      } catch { /* 单个文件坏了不影响其它 */ }
    }
  } catch { /* 目录不存在 = 没有用户 skill */ }
  userCache = out;
  return out;
}

/** 用户技能目录（前端管理页要用它做增删改） */
export function userSkillDir() {
  return USER_SKILL_DIR;
}

/** 清空用户目录缓存（改完文件后可调用） */
export function reloadUserSkills() {
  userCache = null;
  return scanUserSkills().length;
}

/** 注册插件 skill（由插件宿主调用） */
export function registerPluginSkill(pluginId, def) {
  if (!def || !def.id) throw new Error('skill 需要 id');
  pluginSkills.set(def.id, { ...def, source: 'plugin', pluginId });
}

/** 卸载插件时摘掉它的 skill */
export function unregisterPluginSkills(pluginId) {
  for (const [id, s] of pluginSkills) if (s.pluginId === pluginId) pluginSkills.delete(id);
}

/**
 * 列出全部 skill（不含正文，只给索引）。
 * 优先级：插件 > 用户 > 内置。
 */
export function listSkills() {
  const merged = new Map();
  for (const s of BUILTIN_SKILLS) merged.set(s.id, s);
  for (const s of scanUserSkills()) merged.set(s.id, s);
  for (const [id, s] of pluginSkills) merged.set(id, s);
  return [...merged.values()].map((s) => ({
    id: s.id,
    name: s.name,
    summary: s.summary,
    when: s.when,
    version: s.version || '',
    // author 透出给界面（2026-10-25）：skill 也要能显示作者归属
    author: s.author || '',
    license: s.license || '',
    source: s.source || 'builtin'
  }));
}

/** 取单个 skill 的正文（延迟读取，读的时候才碰文件） */
export function getSkillBody(id) {
  const all = new Map();
  for (const s of BUILTIN_SKILLS) all.set(s.id, s);
  for (const s of scanUserSkills()) all.set(s.id, s);
  for (const [k, s] of pluginSkills) all.set(k, s);

  const s = all.get(id);
  if (!s) return null;

  // ① 直接给了 body
  if (s.body) return { ...s, content: s.body };
  // ② 指向仓库里的文件（内置 skill 常用）
  if (s.file) {
    try {
      return { ...s, content: fs.readFileSync(path.join(ROOT, s.file), 'utf8') };
    } catch (e) {
      return { ...s, content: `（内容读取失败：${e?.message ?? e}）` };
    }
  }
  return { ...s, content: '' };
}

/**
 * 生成提示词里的 skill 索引块。
 *
 * ⚠️ 只列**名字 + 一句话 + 何时用**，绝不放正文 ——
 * 那正是这套系统存在的意义（省 token）。
 * 没有 skill 时返回空串，调用方据此跳过插入。
 */
export function buildSkillIndex() {
  const skills = listSkills();
  if (!skills.length) return '';
  const lines = skills.map((s) => {
    const when = s.when ? ` ｜ 何时用：${s.when}` : '';
    return `- ${s.id}（${s.name}）：${s.summary}${when}`;
  });
  return [
    '【技能库】你有一批可按需加载的知识，**不要凭印象猜**，需要时先 load_skill 取正文：',
    ...lines,
    '调用方式：load_skill(id)。同一轮里可以只读需要的那一个，不要全读（浪费上下文）。'
  ].join('\n');
}
