// ── 插件内核 · 数据生命周期 ──────────────────────────────────────────────
//
// 需求（用户 2026-10-20）：
//   「插件有清楚数据和导出导入数据功能（如圣杯战争运行后就会有数据，
//     想开源给别人一般都要带干净的插件）」
//
// 两种味道完全不同的问题，必须分开建模：
//   · **数据（data）**  = 插件运行时产生的业务记录（对局、领取记录、审计尾巴）
//   · **配置（config）** = 用户对插件的设置（开关、参数、广告条目）
//
// 导出时必须能选择带不带数据，且「不带数据」要导出一份**可用的干净插件**
// —— 不是删掉数据的残骸，而是**像刚装上一样**（配置回到 manifest 默认值）。
//
// 三个层级（scope）：
//   config  仅代码 + manifest + 默认配置   ← 开源给别人用这个
//   config  含当前配置（保留用户设置，不含运行数据）
//   full    当前配置 + 全部运行数据         ← 迁移/备份用
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

/** 插件私有数据目录（与 plugins/<id> 源码目录物理分离） */
export function pluginDataDir(id) {
  return path.join(DATA_DIR, 'plugins', id);
}

/**
 * 递归清空一个目录内的**内容**（保留目录本身）。
 * 删不掉的文件（占用/权限）不抛错 —— 数据清理是尽力而为，不能因此让面板报 500。
 * @returns {{removed:number, failed:string[]}}
 */
export function clearDirContents(dir) {
  let removed = 0;
  const failed = [];
  if (!fs.existsSync(dir)) return { removed, failed };
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { removed, failed }; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    } catch {
      failed.push(ent.name);
    }
  }
  return { removed, failed };
}

/**
 * 盘点插件数据：给面板显示"这个插件到底存了哪些东西、多大"。
 * 用户点「清除数据」前必须看得见清的是什么。
 */
export function inspectData(id) {
  const dir = pluginDataDir(id);
  const out = { dir, exists: false, files: [], totalBytes: 0 };
  if (!fs.existsSync(dir)) return out;
  out.exists = true;

  const walk = (d, rel = '') => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { walk(full, r); continue; }
      let size = 0;
      let mtime = null;
      try {
        const st = fs.statSync(full);
        size = st.size;
        mtime = st.mtimeMs;
      } catch { /* 读不到就记 0，不影响展示 */ }
      out.totalBytes += size;
      out.files.push({ name: r, size, mtime });
    }
  };
  walk(dir);
  out.files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return out;
}

/**
 * 收集插件数据文件为 tar 条目（用于 full 导出）。
 * @param {string} id 插件 id
 * @param {string} prefix tar 内的目录前缀（通常是 `<id>/data`）
 */
export function collectDataEntries(id, prefix) {
  const dir = pluginDataDir(id);
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d, rel = '') => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { walk(full, r); continue; }
      try { out.push([`${prefix}/${r}`, fs.readFileSync(full)]); } catch { /* 跳过坏文件 */ }
    }
  };
  walk(dir);
  return out;
}

/**
 * 把导入包里 <root>/data/** 的文件写回插件数据目录。
 * @returns {{written:number, skipped:string[]}}
 */
export function restoreDataEntries(entries, rootName, id) {
  const dir = pluginDataDir(id);
  const prefix = `${rootName}/data/`;
  let written = 0;
  const skipped = [];
  for (const [name, buf] of entries) {
    if (!name.startsWith(prefix)) continue;
    const rel = name.slice(prefix.length);
    // 防路径穿越：任何 .. / 绝对路径一律跳过
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) { skipped.push(name); continue; }
    try {
      const dest = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      written++;
    } catch (error) {
      skipped.push(name);
    }
  }
  return { written, skipped };
}

/** 人读的体积 */
export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
