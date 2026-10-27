#!/usr/bin/env node
// ── QQAgent 管理后台（独立服务，2026-10-25）────────────────────────
//
// 为什么独立成一个服务，而不是给控制台加个页面：
//
//   ① **职责隔离**：控制台是"日常操作"（聊天、会话、插件开关）；
//      管理后台是"运营视角"（全部作者、发布记录、市场状态）。
//      两者的使用者、使用频率、风险面都不同。
//
//   ② **攻击面最小化**：这个服务只暴露 4 个只读接口 + 1 个页面。
//      不转发任何写操作，拿不到聊天内容，碰不到配置。
//      即使它的认证被绕过，损失也限于"看到插件列表"。
//
//   ③ **不碰主控制台**：控制台的 server.token 保持为空（见
//      /etc/nginx/sites-enabled/qq-agent.conf 的说明），
//      那里刻意依赖 nginx Basic Auth。这个服务自己带 Basic Auth，
//      两者互不影响。
//
// 数据来源：只读 QQAgent 的本地 API（127.0.0.1:3210）和文件系统。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { md5crypt } from './apr1.mjs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.ADMIN_PORT || 8095);
const HOST = '127.0.0.1';

// Basic Auth：复用现有 qq-agent.htpasswd 的账号体系
// 用 .secrets 下的副本（/etc/nginx/auth/ 普通用户读不到，会导致认证永远失败）
const AUTH_FILE = '/home/lyy/.secrets/qqagent/admin.htpasswd';

const readAuthUsers = () => {
  const users = new Map();
  try {
    for (const line of fs.readFileSync(AUTH_FILE, 'utf8').split('\n')) {
      const [u, h] = line.split(':');
      if (u && h) users.set(u.trim(), h.trim());
    }
  } catch { /* 读不到就空着，等于谁都进不来 */ }
  return users;
};

/** 校验 Basic Auth（只比对用户名+哈希，不验证明文密码——交给 nginx 也行） */
const checkAuth = (req) => {
  const hdr = String(req.headers.authorization || '');
  if (!hdr.startsWith('Basic ')) return false;
  let dec = '';
  try { dec = Buffer.from(hdr.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const i = dec.indexOf(':');
  if (i < 0) return false;
  const user = dec.slice(0, i);
  const pass = dec.slice(i + 1);
  const users = readAuthUsers();
  const stored = users.get(user);
  if (!stored) return false;

  // {SHA} 格式可以直接验（base64(sha1(password))）
  if (stored.startsWith('{SHA}')) {
    return stored.slice(5) === crypto.createHash('sha1').update(pass).digest('base64');
  }

  // $apr1$（Apache MD5）：用本地实现的 md5crypt 校验
  if (stored.startsWith('$apr1$')) {
    const parts = stored.split('$');
    const salt = parts[2] || '';
    if (!salt) return false;
    return md5crypt(pass, salt) === parts[3];
  }

  // 未知格式：拒绝（宁可进不来，也不放行）
  return false;
};

// ── 数据聚合 ──
const readJson = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } };

const fetchQqagent = async (apiPath) => {
  try {
    const res = await fetch(`http://127.0.0.1:3210${apiPath}`, {
      headers: { 'User-Agent': 'QQAgent-Admin/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
};

/** 全部插件（本地清单） */
const collectPlugins = () => {
  const dir = path.join(ROOT, 'plugins');
  const out = [];
  let ids = [];
  try {
    ids = fs.readdirSync(dir).filter((d) => {
      try { return fs.statSync(path.join(dir, d, 'manifest.json')).isFile(); } catch { return false; }
    });
  } catch { return out; }

  for (const id of ids) {
    const m = readJson(path.join(dir, id, 'manifest.json'), null);
    if (!m) continue;
    out.push({
      id,
      name: m.name || id,
      version: m.version || '0.0.0',
      author: String(m.author || '未署名'),
      category: m.category || '未分类',
      summary: m.summary || '',
      permissions: m.permissions || [],
      license: m.license || '',
      core: m.core === true,
      enabled: m.defaultEnabled !== false,
    });
  }
  return out;
};

/** 发布记录 */
const collectPublished = () => {
  const f = path.join(ROOT, 'data', 'plugins', 'plugin-market', 'published.json');
  const d = readJson(f, { records: [] });
  return Array.isArray(d.records) ? d.records : [];
};

/** 作者档案 */
const collectAuthors = (plugins, records) => {
  const map = new Map();
  for (const p of plugins) {
    const name = p.author;
    if (!map.has(name)) {
      map.set(name, { name, plugins: 0, qq: '', license: '', published: 0 });
    }
    const a = map.get(name);
    a.plugins++;
    if (p.license && !a.license) a.license = p.license;
  }
  // 从发布记录里补 QQ
  const latest = new Map();
  for (const r of records) {
    if (!latest.has(r.id)) latest.set(r.id, r);
  }
  for (const p of plugins) {
    const r = latest.get(p.id);
    if (r && r.action !== 'unpublish' && !r.offline) {
      const a = map.get(p.author);
      if (a) a.published++;
    }
  }
  return [...map.values()].sort((x, y) => y.plugins - x.plugins);
};

// ── HTTP ──
const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': b.length,
    'cache-control': 'no-store',
  });
  res.end(b);
};

const server = http.createServer(async (req, res) => {
  const url0 = new URL(req.url, 'http://127.0.0.1');

  // /health 免认证（只回 ok，不含任何数据）
  // 为什么放行：监控/探活不该需要凭据；它也泄露不了任何东西。
  if (url0.pathname === '/health') {
    return json(res, 200, { ok: true });
  }

  // 认证
  if (!checkAuth(req)) {
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="QQAgent Admin"',
      'content-type': 'text/plain; charset=utf-8',
    });
    res.end('需要登录');
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  // 页面
  if (p === '/' || p === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(HERE, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('管理页面缺失');
    }
    return;
  }

  // 聚合数据（一次性返回全部，页面只请求这一次）
  if (p === '/api/overview') {
    const plugins = collectPlugins();
    const records = collectPublished();
    const authors = collectAuthors(plugins, records);

    const latest = new Map();
    for (let i = records.length - 1; i >= 0; i--) latest.set(records[i].id, records[i]);

    const enriched = plugins.map((pl) => {
      const r = latest.get(pl.id);
      const offline = r?.action === 'unpublish';
      const lastPub = records.find((x) => x.id === pl.id && x.action !== 'unpublish');
      return {
        ...pl,
        offline,
        publishedVersion: lastPub?.version || null,
        publishedAt: lastPub?.at || null,
        changelog: lastPub?.changelog || '',
      };
    });

    // 机器人状态
    const status = await fetchQqagent('/api/status');

    return json(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      stats: {
        plugins: plugins.length,
        authors: authors.length,
        published: enriched.filter((x) => x.publishedVersion && !x.offline).length,
        offline: enriched.filter((x) => x.offline).length,
        publishes: records.filter((r) => r.action !== 'unpublish').length,
      },
      connection: {
        onebot: !!status?.onebot?.connected,
        account: status?.onebot?.account?.online === true,
        model: status?.orchestrator?.model || '',
        todayRuns: status?.usage?.runs ?? null,
        todayTokens: status?.usage?.totalTokens ?? null,
      },
      authors,
      plugins: enriched,
      records: records.slice(0, 60),
    });
  }

  // 健康检查
  if (p === '/health') return json(res, 200, { ok: true });

  json(res, 404, { ok: false, error: '未知路径' });
});

server.listen(PORT, HOST, () => {
  console.log(`[admin] QQAgent 管理后台已启动 http://${HOST}:${PORT}`);
  console.log(`[admin] 认证：Basic Auth（${AUTH_FILE}）`);
});
