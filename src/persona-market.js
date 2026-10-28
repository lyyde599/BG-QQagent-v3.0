// ── 角色卡市场（2026-10-25）──────────────────────────────────────────
//
// 用户要求："创作营支持上传自定义角色卡功能，同样保留作者信息，
//           走类似 skill 和插件的投稿和审核投稿"
//
// 与 skill 市场的区别只是目录和路径前缀：
//   skill  → skills/<id>.md    + skills/index.json
//   角色卡 → personas/<id>.md  + personas/index.json
//
// 所以这个文件刻意保持和 skill-market.js 同构 —— 少一份心智负担。
// 装进来的角色卡进 config.customPersonas，与面板里手填的完全等价。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { ROOT, DATA_DIR } from './config.js';

const MARKET_BASE = process.env.BG_MARKET_BASE || 'https://market.baiguang211.top';
const PERSONA_INDEX = `${MARKET_BASE}/personas/index.json`;

/** 角色卡目录（用户自建） */
export function userPersonaDir() {
  const d = path.join(DATA_DIR, 'personas');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** R2 凭据（与插件/skill 共用同一套） */
function r2EnvPath() {
  if (process.env.BG_R2_ENV) return process.env.BG_R2_ENV;
  const cands = [
    path.join(ROOT, '.secrets', 'market-r2', 'r2.env'),
    path.join(os.homedir(), '.secrets', 'market-r2', 'r2.env')
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return cands[0];
}
/** R2 凭据缺失时的统一提示（2026-10-28）——给出可直接执行的解法，而不是只报路径 */
function r2MissingError() {
  const p = r2EnvPath();
  return [
    `没有 R2 凭据：${p} 不存在。`,
    '发布人设需要写对象存储的权限。',
    '三个办法任选：',
    '  ① 放到 ~/.secrets/market-r2/r2.env（推荐）',
    '  ② 放到 <项目根>/.secrets/market-r2/r2.env',
    '  ③ 设环境变量 BG_R2_ENV=/path/to/r2.env',
    '文件需含：R2_ENDPOINT / R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET'
  ].join('\n');
}

function loadR2() {
  try {
    const txt = fs.readFileSync(r2EnvPath(), 'utf8');
    const o = {};
    for (const line of txt.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.+)$/.exec(line.trim());
      if (m) o[m[1]] = m[2];
    }
    if (!o.R2_ENDPOINT || !o.R2_ACCESS_KEY_ID || !o.R2_SECRET_ACCESS_KEY || !o.R2_BUCKET) return null;
    return o;
  } catch { return null; }
}

async function r2Put(env, key, body, contentType = 'application/json') {
  const ep = env.R2_ENDPOINT.replace(/\/$/, '');
  const host = ep.replace(/^https:\/\//, '');
  const uri = `/${env.R2_BUCKET}/${key}`;
  const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const ds = amz.slice(0, 8);
  const ph = crypto.createHash('sha256').update(body).digest('hex');
  const ch = `host:${host}\nx-amz-content-sha256:${ph}\nx-amz-date:${amz}\n`;
  const sh = 'host;x-amz-content-sha256;x-amz-date';
  const cr = ['PUT', uri, '', ch, sh, ph].join('\n');
  const scope = `${ds}/auto/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amz, scope, crypto.createHash('sha256').update(cr).digest('hex')].join('\n');
  const h = (k, m) => crypto.createHmac('sha256', k).update(m).digest();
  let k = h('AWS4' + env.R2_SECRET_ACCESS_KEY, ds);
  k = h(k, 'auto'); k = h(k, 's3'); k = h(k, 'aws4_request');
  const sig = crypto.createHmac('sha256', k).update(sts).digest('hex');

  const res = await fetch(`${ep}${uri}`, {
    method: 'PUT',
    headers: {
      Host: host,
      'x-amz-content-sha256': ph,
      'x-amz-date': amz,
      'Content-Type': contentType,
      Authorization: `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${sh}, Signature=${sig}`,
      'User-Agent': 'QQAgent-PersonaMarket/1.0'
    },
    body,
    signal: AbortSignal.timeout(60000)
  });
  return res.status;
}

/** 从 md 正文里解析 frontmatter（与 skill 同规则） */
function parseFrontmatter(raw) {
  let meta = {};
  let body = String(raw || '');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (fm) {
    body = body.slice(fm[0].length);
    for (const line of fm[1].split('\n')) {
      const m = /^(\w+)\s*:\s*(.+)$/.exec(line.trim());
      if (m) meta[m[1]] = m[2].trim();
    }
  }
  return { meta, body: body.trim() };
}

/** 拉市场角色卡清单 */
export async function fetchPersonaIndex() {
  try {
    const res = await fetch(PERSONA_INDEX, {
      headers: { 'User-Agent': 'QQAgent-PersonaMarket/1.0' },
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) {
      if (res.status === 404) return { ok: true, personas: [], empty: true };
      return { ok: false, error: `清单返回 HTTP ${res.status}` };
    }
    const d = await res.json();
    return { ok: true, personas: Array.isArray(d.personas) ? d.personas : [] };
  } catch (e) {
    return { ok: false, error: `连不上市场：${e?.message ?? e}` };
  }
}

/** 列出本地自己写的角色卡（personas/*.md） */
export function listLocalPersonas() {
  const dir = userPersonaDir();
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md'); } catch { return out; }
  for (const f of names) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      out.push({
        id: f.replace(/\.md$/, ''),
        name: meta.name || f.replace(/\.md$/, ''),
        summary: meta.summary || '',
        when: meta.when || '',
        author: meta.author || '',
        version: meta.version || '1.0.0',
        license: meta.license || 'MIT',
        group: meta.group || '',
        bytes: Buffer.byteLength(raw, 'utf8'),
        text: body,
      });
    } catch { /* 跳过坏文件 */ }
  }
  return out;
}

/**
 * 发布本地角色卡到市场
 *
 * @param {string} id   personas/<id>.md
 */
export async function publishPersona(id, { version = '', notes = '', dryRun = false } = {}) {
  const pid = String(id || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(pid)) {
    return { ok: false, error: '角色卡 id 只能用小写字母/数字/连字符（2~41 位）' };
  }
  const file = path.join(userPersonaDir(), `${pid}.md`);
  if (!fs.existsSync(file)) return { ok: false, error: `找不到 personas/${pid}.md` };

  const raw = fs.readFileSync(file, 'utf8');
  const { meta } = parseFrontmatter(raw);
  if (!meta.name) return { ok: false, error: '角色卡缺 name（frontmatter 里必须有）' };
  if (!meta.summary) return { ok: false, error: '角色卡缺 summary（市场列表靠它展示）' };
  if (!meta.author) return { ok: false, error: '角色卡缺 author（市场要显示作者）' };

  const buf = Buffer.from(raw, 'utf8');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
  const ver = String(version || meta.version || '1.0.0').trim();
  const fname = `${pid}-${ver}.md`;

  if (dryRun) {
    return { ok: true, dryRun: true, id: pid, version: ver, bytes: buf.length, sha256, filename: fname };
  }

  const env = loadR2();
  if (!env) return { ok: false, error: r2MissingError(), needR2: true };

  const st = await r2Put(env, `personas/${fname}`, buf, 'text/markdown; charset=utf-8');
  if (st !== 200) return { ok: false, error: `正文上传失败 HTTP ${st}` };

  const cur = await fetchPersonaIndex();
  const list = cur.ok ? cur.personas : [];
  const download = `${MARKET_BASE}/personas/${fname}`;
  const item = {
    id: pid,
    name: meta.name,
    summary: meta.summary,
    when: meta.when || '',
    group: meta.group || '',
    version: ver,
    author: meta.author,
    license: meta.license || 'MIT',
    updatedAt: new Date().toISOString(),
    notes: String(notes || '').slice(0, 1000),
    download,
    sha256,
    size: buf.length,
  };
  const next = list.filter((s) => s.id !== pid);
  next.push(item);
  next.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const st2 = await r2Put(env, 'personas/index.json', Buffer.from(JSON.stringify({
    apiVersion: 1,
    updatedAt: new Date().toISOString(),
    personas: next
  }, null, 2)), 'application/json');
  if (st2 !== 200) return { ok: false, error: `清单更新失败 HTTP ${st2}` };

  return { ok: true, id: pid, version: ver, bytes: buf.length, download, total: next.length };
}

/** 下架角色卡（从远端清单移除，本地 .md 保留） */
export async function unpublishPersona(id, { reason = '' } = {}) {
  const pid = String(id || '').trim();
  if (!pid) return { ok: false, error: '缺少角色卡 id' };

  const env = loadR2();
  if (!env) return { ok: false, error: r2MissingError(), needR2: true };

  const cur = await fetchPersonaIndex();
  if (!cur.ok) return { ok: false, error: `拉不到清单：${cur.error || ''}` };

  const before = (cur.personas || []).length;
  const next = (cur.personas || []).filter((s) => s.id !== pid);
  if (next.length === before) return { ok: false, error: `市场里没有 ${pid}` };

  const st = await r2Put(env, 'personas/index.json', Buffer.from(JSON.stringify({
    apiVersion: 1,
    updatedAt: new Date().toISOString(),
    personas: next
  }, null, 2)), 'application/json');
  if (st !== 200) return { ok: false, error: `清单更新失败 HTTP ${st}` };

  return { ok: true, id: pid, reason: String(reason || '').slice(0, 200), remaining: next.length };
}

/**
 * 从市场装一个角色卡到本地
 *
 * 装完写进 config.customPersonas，与面板里手填的完全等价 ——
 * 用户在「设置 → 人设模板」下拉里能直接选到。
 */
export async function installPersona(id, { overwrite = false } = {}) {
  const pid = String(id || '').trim();
  if (!pid) return { ok: false, error: '缺少角色卡 id' };

  const cur = await fetchPersonaIndex();
  if (!cur.ok) return { ok: false, error: `拉不到清单：${cur.error || ''}` };
  const meta = (cur.personas || []).find((s) => s.id === pid);
  if (!meta) return { ok: false, error: `市场里没有 ${pid}` };

  // 下载正文
  let raw;
  try {
    const res = await fetch(meta.download, {
      headers: { 'User-Agent': 'QQAgent-PersonaMarket/1.0' },
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) return { ok: false, error: `下载失败 HTTP ${res.status}` };
    raw = await res.text();
  } catch (e) {
    return { ok: false, error: `下载失败：${e?.message ?? e}` };
  }

  // sha256 校验
  if (meta.sha256) {
    const got = crypto.createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex');
    if (got.toLowerCase() !== String(meta.sha256).toLowerCase()) {
      return { ok: false, error: '文件校验失败（sha256 不匹配），已丢弃' };
    }
  }

  // 写进 config.customPersonas
  const cfg = await import('./config.js');
  const people = cfg.getConfig().customPersonas || [];
  const { meta: fm, body } = parseFrontmatter(raw);
  const name = fm.name || meta.name || pid;

  const idx = people.findIndex((p) => p.name === name);
  if (idx >= 0 && !overwrite) {
    return { ok: false, error: `已有同名角色「${name}」，勾选覆盖再来一次` };
  }

  const entry = {
    name,
    text: body,
    // 记下来源，方便以后显示「来自市场」
    sourceId: pid,
    sourceVersion: meta.version || '1.0.0',
    author: meta.author || fm.author || '',
  };
  const next = [...people];
  if (idx >= 0) next[idx] = entry; else next.push(entry);
  cfg.updateConfig({ customPersonas: next });

  // 同时落一份 .md 到本地 personas/，便于以后改完重新发布
  try {
    fs.writeFileSync(path.join(userPersonaDir(), `${pid}.md`), raw, 'utf8');
  } catch { /* 落盘失败不影响安装 */ }

  return { ok: true, id: pid, name, version: meta.version, author: meta.author, replaced: idx >= 0 };
}

/** 检查角色卡更新（比对本地已装的 version 与市场最新） */
export async function checkPersonaUpdates() {
  const cur = await fetchPersonaIndex();
  if (!cur.ok) return { ok: false, error: cur.error };
  const cfg = await import('./config.js');
  const people = cfg.getConfig().customPersonas || [];
  const installed = new Map(people.filter((p) => p.sourceId).map((p) => [p.sourceId, p.sourceVersion || '0']));

  const cmp = (a, b) => {
    const pa = String(a || '0').split(/[.\-]/).map(Number);
    const pb = String(b || '0').split(/[.\-]/).map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  };

  const updates = [];
  for (const mp of (cur.personas || [])) {
    const local = installed.get(mp.id);
    if (!local) continue;                                    // 没装，不算更新
    if (cmp(mp.version, local) > 0) {
      updates.push({ id: mp.id, name: mp.name, from: local, to: mp.version, author: mp.author });
    }
  }
  return { ok: true, updates, total: updates.length };
}

// ── 本地已有内容的导入（2026-10-25）────────────────────────────────
//
// 用户要求："角色卡请支持本地导出发布，不可能让大家每次都重新填写信息吧"
//
// 完全对。用户可能：
//   ① 已经在「设置 → 人设模板」里手写过自定义人设（config.customPersonas）
//   ② 电脑上本来就有角色卡 .md 文件
// 这两种情况都该能直接变成可发布的角色卡，而不是从头打字。

/**
 * 列出可导入的本地人设
 *
 * 来源：config.customPersonas（面板里手写的人设）
 * 排除：已经导出成 personas/<id>.md 的（避免重复）
 */
export function listImportable() {
  const dir = userPersonaDir();
  const existing = new Set(
    (() => {
      try {
        return fs.readdirSync(dir)
          .filter((f) => f.endsWith('.md') && f !== 'README.md')
          .map((f) => f.replace(/\.md$/, ''));
      } catch { return []; }
    })()
  );

  const out = [];
  try {
    const cfgMod = require_config();
    const people = cfgMod.getConfig().customPersonas || [];
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      // 从名字生成 id：中文转不了 id，用 custom-N + 拼音兜底
      const guessed = guessId(p.name, i);
      if (existing.has(guessed)) continue;
      out.push({
        key: `custom_${i}`,
        name: p.name || `未命名 ${i + 1}`,
        text: p.text || '',
        customRules: p.customRules || '',
        suggestedId: guessed,
        bytes: Buffer.byteLength(p.text || '', 'utf8'),
        // 已经从市场装来的，标记出来（不重复导入）
        sourceId: p.sourceId || '',
      });
    }
  } catch { /* 配置读不到就返回空 */ }
  return out;
}

/** 循环引用 config，用 lazy require 避免顶层循环依赖 */
function require_config() {
  // 动态同步拿不到 ESM export，改由调用方注入；这里从缓存文件直接读
  const cfgFile = path.join(DATA_DIR, 'config.json');
  return {
    getConfig: () => {
      try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { return {}; }
    },
  };
}

/** 从中文名字猜一个合法 id（猜不出就用 custom-N） */
function guessId(name, idx) {
  const s = String(name || '').toLowerCase();
  // 有英文就用英文
  const en = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (en.length >= 2) return en.slice(0, 40);
  return `custom-${idx + 1}`;
}

/**
 * 把一条本地人设导出成 personas/<id>.md
 *
 * @param {object} opts { key | text+name, id, author, summary, version, group }
 */
export function exportLocalPersona(opts = {}) {
  const id = String(opts.id || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) {
    return { ok: false, error: 'id 只能用小写字母/数字/连字符（2~41 位）' };
  }

  let name = String(opts.name || '').trim();
  let text = String(opts.text || '').trim();

  // 从 config 里按 key 取（前端只需要传 key）
  if (!text && opts.key) {
    const people = require_config().getConfig().customPersonas || [];
    const idx = Number(String(opts.key).replace('custom_', ''));
    const p = people[idx];
    if (!p) return { ok: false, error: `找不到 ${opts.key}` };
    name = name || String(p.name || '').trim();
    text = String(p.text || '').trim();
    if (!text) return { ok: false, error: '这条人设没有正文' };
  }

  if (!name) return { ok: false, error: '角色名不能为空' };
  if (!text) return { ok: false, error: '角色设定不能为空' };

  const author = String(opts.author || '').trim() || '未署名';
  const summary = String(opts.summary || '').trim() || `${name}（从本地人设导入）`;
  const version = String(opts.version || '1.0.0').trim();
  const group = String(opts.group || '').trim();

  // 正文若自带一级标题，就不再补一个（避免「# 名字」出现两次）
  const hasH1 = /^#\s+\S/m.test(text);

  const md = [
    '---',
    `name: ${name}`,
    `summary: ${summary}`,
    `author: ${author}`,
    `version: ${version}`,
    'license: MIT',
    group ? `group: ${group}` : '',
    '---',
    '',
    hasH1 ? text : `# ${name}\n\n${text}`,
    '',
  ].filter((x) => x !== '').join('\n');

  try {
    const f = path.join(userPersonaDir(), `${id}.md`);
    fs.writeFileSync(f, md, 'utf8');
    return { ok: true, id, path: `personas/${id}.md`, bytes: Buffer.byteLength(md, 'utf8'), name };
  } catch (e) {
    return { ok: false, error: '写入失败：' + String(e?.message ?? e).slice(0, 80) };
  }
}

/**
 * 导入一个本地 .md 文件内容（用户从电脑上选的）
 *
 * 支持两种：
 *   ① 已经有 frontmatter 的 → 直接用
 *   ② 纯正文（没有 frontmatter）→ 自动补一个
 */
export function importPersonaFile(id, raw, defaults = {}) {
  const pid = String(id || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(pid)) {
    return { ok: false, error: 'id 只能用小写字母/数字/连字符（2~41 位）' };
  }
  const content = String(raw || '').trim();
  if (!content) return { ok: false, error: '文件是空的' };
  if (content.length > 200 * 1024) return { ok: false, error: '文件太大（上限 200KB）' };

  const { meta, body } = parseFrontmatter(content);
  let md = content;

  // 没有 frontmatter → 自动补
  if (!meta.name) {
    const name = String(defaults.name || pid).trim();
    const summary = String(defaults.summary || `${name}（导入的角色卡）`).trim();
    const author = String(defaults.author || '未署名').trim();
    md = [
      '---',
      `name: ${name}`,
      `summary: ${summary}`,
      `author: ${author}`,
      `version: ${String(defaults.version || '1.0.0').trim()}`,
      'license: MIT',
      '---',
      '',
      body || content,
      '',
    ].join('\n');
  }

  try {
    fs.writeFileSync(path.join(userPersonaDir(), `${pid}.md`), md, 'utf8');
    const parsed = parseFrontmatter(md);
    return { ok: true, id: pid, name: parsed.meta.name || pid, path: `personas/${pid}.md` };
  } catch (e) {
    return { ok: false, error: '写入失败：' + String(e?.message ?? e).slice(0, 80) };
  }
}
