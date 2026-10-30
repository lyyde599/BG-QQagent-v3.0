// ── Skill 市场（2026-10-25）──────────────────────────────────────────
//
// 与插件市场的区别：
//   插件市场 → 装卸代码包（.tar.gz），需要重启/重载
//   Skill 市场 → 收发单个 .md 文件，丢进 skills/ 即生效
//
// 所以这边简单得多：没有依赖、没有安装脚本、没有版本冲突。
// 一个 skill = 一个 md 文件 + index 里的一条元数据。
//
// 存储沿用创造营那套 R2（同一个桶，不同路径）：
//   skills/index.json            清单
//   skills/<id>-<version>.md     正文

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { ROOT, DATA_DIR } from './config.js';
import { userSkillDir, reloadUserSkills, listSkills } from './skill.js';

const MARKET_BASE = process.env.BG_MARKET_BASE || 'https://market.baiguang211.top';
const SKILL_INDEX = `${MARKET_BASE}/skills/index.json`;

/** R2 凭据（与插件/内核共用） */
/** R2 凭据路径：环境变量 → 项目内 .secrets → 家目录 .secrets（都可以） */
function r2EnvPath() {
  if (process.env.BG_R2_ENV) return process.env.BG_R2_ENV;
  const cands = [
    path.join(ROOT, '.secrets', 'market-r2', 'r2.env'),
    path.join(os.homedir(), '.secrets', 'market-r2', 'r2.env')
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return cands[0];
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
      'User-Agent': 'WhaleBridge-SkillMarket/1.0'
    },
    body,
    signal: AbortSignal.timeout(60000)
  });
  return res.status;
}

/** 拉远端 skill 清单 */
// ── 技能清单缓存（2026-10-26）──
//
// 🔴 外部报告指出的真问题：
//   "面板首屏被一个每次都实时跨公网拉取的接口串行挡住"
//
// 实测（服务器本机直连，各 3 次）：
//   /api/market/index       1.0~2.0s  ← 当时还没修下载统计缓存
//   /api/skill-market/index 0.25~0.36s
//   /api/skills             0.001s
//
// fetchSkillIndex 是**唯一一个完全没有缓存**的远端接口：
// 无内存缓存、无 TTL、无备用源、无旧值回落，超时还写着 20 秒。
// 面板打开时它串在渲染之前，等于把整屏拖慢。
//
// 对照组：plugins/plugin-market/index.js 的 fetchIndex() 有
// 5 分钟 TTL + 主备双源 + 失败回落旧缓存 —— 所以那边很快。
//
// 现在照那套补齐：TTL 300s / 超时降到 4s / 失败回落旧值。
let skillIdxCache = { at: 0, data: null, error: null };
const SKILL_TTL = 300 * 1000;

/**
 * 拉技能市场清单
 *
 * @param {object} opts { force } force=true 时跳过缓存（手动刷新用）
 */
export async function fetchSkillIndex(opts = {}) {
  const force = opts && opts.force === true;

  // ① 命中缓存直接返回，零网络开销
  if (!force && skillIdxCache.data && Date.now() - skillIdxCache.at < SKILL_TTL) {
    return { ...skillIdxCache.data, cached: true };
  }

  try {
    const res = await fetch(SKILL_INDEX, {
      headers: { 'User-Agent': 'WhaleBridge-SkillMarket/1.0' },
      // 原来 20000：域名卡住时面板要空白 20 秒。
      // 清单只是个 json，4 秒足够；超了就用旧的。
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) {
      if (res.status === 404) {
        const r = { ok: true, skills: [], empty: true };
        skillIdxCache = { at: Date.now(), data: r, error: null };
        return r;
      }
      throw new Error(`清单返回 HTTP ${res.status}`);
    }
    const d = await res.json();
    const r = { ok: true, skills: Array.isArray(d.skills) ? d.skills : [] };
    skillIdxCache = { at: Date.now(), data: r, error: null };
    return r;
  } catch (e) {
    const msg = `连不上市场：${e?.message ?? e}`;
    // ② 失败回落旧缓存 —— 界面能显示内容，并注明可能过期
    if (skillIdxCache.data) {
      return { ...skillIdxCache.data, cached: true, stale: true, error: msg };
    }
    return { ok: false, error: msg };
  }
}

/** 清技能清单缓存（发布/下架后调用，保证立刻看到变化） */
export function clearSkillIndexCache() {
  skillIdxCache = { at: 0, data: null, error: null };
}

/** 从 md 正文里解析 frontmatter */
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

/**
 * 发布本地 skill 到市场。
 *
 * @param {string} id      skill id（对应 skills/<id>.md）
 * @param {object} opts    { version, notes, dryRun }
 */
/**
 * 读创造营里登录后保存的作者 token（2026-10-28）
 * 与 plugin-market 共用同一份凭据，不另立文件。
 */
function readMarketToken() {
  const cands = [
    path.join(DATA_DIR, 'plugins', 'plugin-market', 'market-token.txt'),
    path.join(ROOT, 'data', 'plugins', 'plugin-market', 'market-token.txt')
  ];
  for (const f of cands) {
    try {
      const k = fs.readFileSync(f, 'utf8').trim();
      if (k) return k;
    } catch { /* 试下一个 */ }
  }
  return '';
}

export async function publishSkill(id, { version = '1.0.0', notes = '', dryRun = false } = {}) {
  const file = path.join(userSkillDir(), `${id}.md`);
  if (!fs.existsSync(file)) return { ok: false, error: `找不到 skills/${id}.md` };

  const raw = fs.readFileSync(file, 'utf8');
  const { meta } = parseFrontmatter(raw);
  if (!meta.name) return { ok: false, error: 'skill 缺 name（frontmatter 里必须有）' };
  if (!meta.summary) return { ok: false, error: 'skill 缺 summary（模型靠它判断要不要读）' };

  const buf = Buffer.from(raw, 'utf8');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
  const ver = String(version || '1.0.0').trim();
  const fname = `${id}-${ver}.md`;

  if (dryRun) {
    return { ok: true, dryRun: true, id, version: ver, bytes: buf.length, sha256, filename: fname };
  }

  // ── 投稿给中心，由中心审核上线（2026-10-28）──
  //
  // 🔴 设计修正：
  //   原来作者本机必须有 R2 密钥才能发布技能 —— 这不该是作者的负担，
  //   也是"报错甩出 /root/agent-new/... 别人机器路径"的根源。
  //
  //   现在与插件投稿完全一致：
  //     作者带 token → 提交到中心 → 管理员审核 → 上线
  //   作者全程不接触对象存储。
  //
  //   例外：本机若是市场所有者（配了 R2），仍走直连（省一次往返）。

  const env = loadR2();
  if (env) {
    // 所有者路径：直连写 R2（保留原有能力）
    const st = await r2Put(env, `skills/${fname}`, buf, 'text/markdown; charset=utf-8');
    if (st !== 200) return { ok: false, error: `正文上传失败 HTTP ${st}` };
    const cur = await fetchSkillIndex();
    const skills = cur.ok ? cur.skills : [];
    const download = `${MARKET_BASE}/skills/${fname}`;
    const hit = skills.find((s) => s.id === id);
    const item = {
      id, name: meta.name || id, summary: meta.summary || '',
      // 🔴 2026-10-30 修：不能兜底成作者昵称
      //
      // 原来写死 '白光'，别人发布技能时若没填 author，就会被冒名成作者。
      // 与插件市场 2026-10-25 修的是同一类问题（那时改成了「未署名」）。
      author: meta.author || '未署名', version: ver,
      download, updatedAt: new Date().toISOString()
    };
    if (hit) Object.assign(hit, item); else skills.push(item);

    // 直接用 r2Put 写回清单（原 pushSkillIndex 未定义，2026-10-28 修）
    const idxBody = JSON.stringify({
      apiVersion: 1,
      updatedAt: new Date().toISOString(),
      skills
    }, null, 2);
    const st2 = await r2Put(env, 'skills/index.json', idxBody, 'application/json');
    if (st2 !== 200) return { ok: false, error: `清单更新失败 HTTP ${st2}` };
    return { ok: true, direct: true, id, version: ver, download, total: skills.length };
  }

  // ── 有作者 token：直传（Worker 代写，作者不接触密钥）──
  //
  // 2026-10-28 用户要求："有没有办法给她们（账号登录作者）r2 授权呢"
  //
  // 直接发 R2 密钥是错的 —— 那是桶级权限，拿到就能删光整个市场，
  // 而且散落在每个作者机器上，无法单独吊销、无法审计。
  //
  // 正确做法：**给能力，不给密钥**。
  // 作者带 token 调 /api/skills/direct-publish，Worker 用自己的绑定代写。
  // 作者得到的是"发布自己的技能"这一项权限，Worker 侧还会校验归属：
  // 同一个 id 只有原作者能覆盖。
  const token0 = readMarketToken();
  if (token0) {
    try {
      const r = await fetch(`${MARKET_BASE}/api/skills/direct-publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({
          token: token0,
          id,
          version: ver,
          name: meta.name || id,
          summary: meta.summary || '',
          content: raw
        }),
        signal: AbortSignal.timeout(60000)
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d?.ok) {
        return {
          ok: true,
          direct: true,
          via: 'author-token',
          id,
          version: ver,
          download: d.download,
          total: d.total
        };
      }
      // 403（id 被占）等业务错误直接返回，不再退到投稿
      if (r.status === 403) return { ok: false, error: d?.error || '这个 id 已被其他作者占用' };
      if (r.status !== 401) return { ok: false, error: d?.error || `发布失败 HTTP ${r.status}` };
      // 401 = token 失效，落到投稿路径给出明确提示
    } catch { /* 网络异常，继续尝试投稿 */ }
  }

  // 非所有者：投稿给中心
  const token = readMarketToken();
  if (!token) {
    return {
      ok: false,
      needSubmit: true,
      error: '请先在「创造营」注册作者账号并登录，然后重新发布（不需要 R2 密钥）。'
    };
  }

  try {
    const r = await fetch(`${MARKET_BASE}/api/skills/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        token,
        id,
        version: ver,
        name: meta.name || id,
        summary: meta.summary || '',
        notes: String(meta.notes || ''),
        content: raw
      }),
      signal: AbortSignal.timeout(60000)
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d?.ok) {
      return { ok: false, error: d?.error || `提交失败 HTTP ${r.status}`, needSubmit: true };
    }
    return {
      ok: true,
      submitted: true,
      id,
      version: ver,
      submissionId: d.submission?.id,
      message: '已提交，等待管理员审核后上线'
    };
  } catch (e) {
    return { ok: false, error: '连不上市场服务：' + String(e?.message ?? e).slice(0, 80), needSubmit: true };
  }
}


/**
 * 下架 skill（2026-10-25）
 *
 * 用户要求："skill 也做成和插件管理一样的发布下架功能"
 *
 * 语义与插件下架一致：
 *   · 从远端 skills/index.json 里移除，**本地 .md 保留**
 *   · 重新上架只需再调 publishSkill
 *
 * 为什么不删本地文件：作者可能只是暂时撤下，
 * 删了就得重写。本地保留也便于修改后再发。
 */
export async function unpublishSkill(id, { reason = '' } = {}) {
  const sid = String(id || '').trim();
  if (!sid) return { ok: false, error: '缺少 skill id' };

  const env = loadR2();
  if (!env) return { ok: false, error: `没有 R2 凭据（${r2EnvPath()}）` };

  const cur = await fetchSkillIndex();
  if (!cur.ok) return { ok: false, error: `拉不到清单：${cur.error || ''}` };

  const before = (cur.skills || []).length;
  const next = (cur.skills || []).filter((s) => s.id !== sid);
  if (next.length === before) {
    return { ok: true, removed: 0, note: '远端本来就没有这个 skill' };
  }

  const st = await r2Put(env, 'skills/index.json', Buffer.from(JSON.stringify({
    apiVersion: 1,
    updatedAt: new Date().toISOString(),
    skills: next,
  }, null, 2)), 'application/json');
  if (st !== 200) return { ok: false, error: `清单更新失败 HTTP ${st}` };

  return {
    ok: true,
    id: sid,
    removed: before - next.length,
    reason: String(reason || '').slice(0, 200),
    note: '已从市场下架，本地 skills/ 里的文件还在，随时可以重新发布。',
  };
}

/**
 * 从市场安装 skill 到本地 skills/。
 *
 * 🔴 只写 skills/<id>.md，不碰任何其它东西。
 *    已存在同名则拒绝（除非 overwrite），避免覆盖用户自己的版本。
 */
export async function installSkill(id, { overwrite = false } = {}) {
  const idx = await fetchSkillIndex();
  if (!idx.ok) return { ok: false, error: idx.error };
  const item = idx.skills.find((s) => s.id === id);
  if (!item) return { ok: false, error: `市场里没有 ${id}` };

  const target = path.join(userSkillDir(), `${id}.md`);
  if (fs.existsSync(target) && !overwrite) {
    return { ok: false, error: `本地已有 skills/${id}.md，未覆盖（勾选覆盖才会替换）` };
  }

  let raw;
  try {
    const res = await fetch(item.download, {
      headers: { 'User-Agent': 'WhaleBridge-SkillMarket/1.0' },
      signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) return { ok: false, error: `下载失败 HTTP ${res.status}` };
    raw = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, error: `下载出错：${e?.message ?? e}` };
  }

  // 校验：清单里有 sha256 就必须对得上
  const got = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
  if (item.sha256 && got !== item.sha256) {
    return { ok: false, error: `校验失败：期望 ${String(item.sha256).slice(0, 12)}…，实际 ${got.slice(0, 12)}…` };
  }

  fs.mkdirSync(userSkillDir(), { recursive: true });
  fs.writeFileSync(target, raw);
  reloadUserSkills();   // 立刻生效，不用重启

  return { ok: true, id, version: item.version, file: target, bytes: raw.length };
}

/** 对比本地与市场，列出哪些有更新 */
export async function checkSkillUpdates() {
  const idx = await fetchSkillIndex();
  if (!idx.ok) return { ok: false, error: idx.error };
  const remote = new Map(idx.skills.map((s) => [s.id, s]));
  const local = listSkills().filter((s) => s.source === 'user');

  const updates = [];
  for (const l of local) {
    const r = remote.get(l.id);
    if (r && String(r.version) !== String(l.version || '')) {
      updates.push({ id: l.id, name: l.name, local: l.version || '—', remote: r.version });
    }
  }
  return { ok: true, installed: local.length, available: idx.skills.length, updates };
}
