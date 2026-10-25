// ── 外部作者投稿：GitHub 仓库直链（2026-10-25）────────────────────
//
// 需求：原来的「发布」按钮硬依赖 R2 凭据 + 写死 contact/trust，
//       等于只有市场所有者自己能用。外部作者无法投稿。
//
// 本模块解决这件事，走 GitHub 仓库直链模式：
//
//   作者在自己仓库里放好插件（plugins/<id>/ + 可能还有 qqagent-market.json 描述文件）
//   → 把仓库地址填进创造营
//   → 市场从头到尾**只读**拉取 manifest 和包，不要求作者有任何密钥
//
// 🔴 与「发布」的区别：
//   发布   = 市场所有者把包推到 R2，trust=official
//   投稿   = 外部作者提供 GitHub 地址，市场只读抓取，trust=verified
//
// 安全性：
//   · 只接受 github.com / gitee.com 的公开仓库
//   · 下载后校验大小上限，防止拉个几百 MB 把内存撑爆
//   · 插件仍需作者在本地声明 author，市场不代填

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MARKET_BASE = process.env.BG_MARKET_BASE || 'https://market.baiguang211.top';

/** 单包大小上限（默认 20MB，超出拒绝） */
const MAX_PKG_BYTES = 20 * 1024 * 1024;

/**
 * 把各种写法的仓库地址归一成 { owner, repo, branch, subdir }。
 *
 * 支持：
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch/sub/dir
 *   https://gitee.com/owner/repo
 *   owner/repo
 */
export function parseRepoUrl(input) {
  const s = String(input || '').trim();
  if (!s) return { ok: false, error: '仓库地址为空' };

  // 简写 owner/repo
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) {
    const [owner, repo] = s.split('/');
    return { ok: true, host: 'github.com', owner, repo: repo.replace(/\.git$/, ''), branch: '', subdir: '' };
  }

  let u;
  try { u = new URL(s); } catch { return { ok: false, error: '地址格式不对' }; }

  const host = u.hostname.toLowerCase();
  if (!/^(www\.)?(github\.com|gitee\.com)$/.test(host)) {
    return { ok: false, error: '只支持 github.com 或 gitee.com 的公开仓库' };
  }
  const parts = u.pathname.replace(/^\//, '').split('/').filter(Boolean);
  if (parts.length < 2) return { ok: false, error: '地址里缺少 owner/repo' };

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  let branch = '';
  let subdir = '';
  // /tree/<branch>/<subdir...>
  if (parts[2] === 'tree' && parts[3]) {
    branch = parts[3];
    subdir = parts.slice(4).join('/');
  }
  return { ok: true, host: host.replace(/^www\./, ''), owner, repo, branch, subdir };
}

/** 候选分支（不指定时按顺序试） */
const FALLBACK_BRANCHES = ['main', 'master'];

/** 拼 raw 地址 */
function rawUrl(host, owner, repo, branch, file) {
  if (host === 'gitee.com') {
    return `https://gitee.com/${owner}/${repo}/raw/${branch}/${file}`;
  }
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file}`;
}

/** 拼打包下载地址（GitHub 有 codeload，Gitee 有 zip） */
function archiveUrl(host, owner, repo, branch) {
  if (host === 'gitee.com') {
    return `https://gitee.com/${owner}/${repo}/repository/archive/${branch}.zip`;
  }
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${branch}`;
}

/** 取一个文本文件，返回 null 表示不存在 */
async function fetchText(url, timeout = 20000) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'QQAgent-Market/1.0' },
      signal: AbortSignal.timeout(timeout)
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * 探测仓库里的插件。
 *
 * 约定（按优先级）：
 *   ① 仓库根有 qqagent-market.json —— 里面写 { plugins: [{ id, path }] }
 *   ② 仓库根有 manifest.json —— 整个仓库就是一个插件
 *   ③ 仓库根有 plugins/ 目录 —— 读其中的 manifest.json（无法列目录时靠 ①）
 */
export async function probeRepo(input) {
  const p = parseRepoUrl(input);
  if (!p.ok) return p;

  const branches = p.branch ? [p.branch] : FALLBACK_BRANCHES;
  let usedBranch = '';
  let index = null;

  // ① 找 qqagent-market.json
  for (const b of branches) {
    const f = p.subdir ? `${p.subdir}/qqagent-market.json` : 'qqagent-market.json';
    const txt = await fetchText(rawUrl(p.host, p.owner, p.repo, b, f));
    if (txt) {
      try { index = JSON.parse(txt); usedBranch = b; } catch { /* 格式错，继续试 */ }
      if (index) break;
    }
  }

  // ② 根目录 manifest.json —— 整仓一个插件
  if (!index) {
    for (const b of branches) {
      const f = p.subdir ? `${p.subdir}/manifest.json` : 'manifest.json';
      const txt = await fetchText(rawUrl(p.host, p.owner, p.repo, b, f));
      if (!txt) continue;
      try {
        const mf = JSON.parse(txt);
        if (mf.id) {
          index = { plugins: [{ id: mf.id, path: p.subdir || '.' }] };
          usedBranch = b;
          break;
        }
      } catch { /* ignore */ }
    }
  }

  if (!index) {
    return {
      ok: false,
      error: `仓库里既没有 qqagent-market.json，根目录也没有 manifest.json（试过 ${branches.join('/')}）`
    };
  }
  if (!Array.isArray(index.plugins) || !index.plugins.length) {
    return { ok: false, error: 'qqagent-market.json 里的 plugins 是空的' };
  }

  const branch = usedBranch || p.branch || 'main';

  // 逐个读 manifest，拼出市场条目
  const found = [];
  for (const item of index.plugins.slice(0, 50)) {
    const pid = String(item.id || '').trim();
    if (!pid) continue;
    const dir = String(item.path || pid).replace(/^\.\/|\/$/g, '');
    const mfPath = dir === '.' ? 'manifest.json' : `${dir}/manifest.json`;
    const txt = await fetchText(rawUrl(p.host, p.owner, p.repo, branch, mfPath));
    if (!txt) { found.push({ id: pid, ok: false, error: '读不到 manifest.json' }); continue; }
    let mf;
    try { mf = JSON.parse(txt); } catch { found.push({ id: pid, ok: false, error: 'manifest.json 不是合法 JSON' }); continue; }
    if (mf.id !== pid) {
      found.push({ id: pid, ok: false, error: `manifest 里的 id(${mf.id}) 与声明(${pid}) 不一致` });
      continue;
    }
    found.push({
      ok: true,
      id: pid,
      name: mf.name || pid,
      version: mf.version || '0.0.0',
      author: mf.author || '',
      summary: mf.summary || '',
      description: mf.description || '',
      category: mf.category || '其他',
      apiVersion: mf.apiVersion || 1,
      dir
    });
  }

  return {
    ok: true,
    host: p.host,
    owner: p.owner,
    repo: p.repo,
    branch,
    subdir: p.subdir,
    repoUrl: `${p.host === 'gitee.com' ? 'https://gitee.com' : 'https://github.com'}/${p.owner}/${p.repo}`,
    plugins: found
  };
}

/**
 * 从仓库拉一个插件的包体（整仓 tar.gz / zip）。
 *
 * 为什么不用逐个文件拉：一个插件几十个文件，逐个拉既慢又容易漏。
 * 但整仓下载也要防炸 —— 超过 MAX_PKG_BYTES 直接拒绝。
 */
export async function downloadRepoPackage(input, { branch = '' } = {}) {
  const p = parseRepoUrl(input);
  if (!p.ok) return p;
  const br = branch || p.branch || 'main';
  const url = archiveUrl(p.host, p.owner, p.repo, br);

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'QQAgent-Market/1.0' },
      signal: AbortSignal.timeout(120000),
      redirect: 'follow'
    });
  } catch (e) {
    return { ok: false, error: `下载失败：${e?.message ?? e}` };
  }
  if (!res.ok) return { ok: false, error: `下载失败 HTTP ${res.status}` };

  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > MAX_PKG_BYTES) {
    return { ok: false, error: `包太大（${(len / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_PKG_BYTES / 1024 / 1024}MB）` };
  }

  let buf;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, error: `读取失败：${e?.message ?? e}` };
  }
  if (buf.length > MAX_PKG_BYTES) {
    return { ok: false, error: `包太大（${(buf.length / 1024 / 1024).toFixed(1)}MB）` };
  }

  return {
    ok: true,
    url,
    bytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex').toUpperCase(),
    buffer: buf
  };
}
