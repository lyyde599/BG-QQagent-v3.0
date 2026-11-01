#!/usr/bin/env node
// ── 发布内核更新到市场（2026-10-25）──────────────────────────────────
//
// 用法：
//   node scripts/publish-kernel.mjs <内核包.tar.gz> [--notes "更新说明"] [--dry]
//
// 做的事：
//   ① 算 sha256 / size
//   ② 把包传到 R2 的 packages/kernel-<version>-<hash>.tar.gz
//   ③ 更新 kernel/index.json（保留历史版本，最新的排最前）
//
// 凭据读 /home/lyy/.secrets/market-r2/r2.env（与创造营共用，不落日志）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const R2_ENV = '/home/lyy/.secrets/market-r2/r2.env';
const BASE = 'https://market.baiguang211.top';
const UA = 'QQAgent-KernelPublisher/1.0';

const args = process.argv.slice(2);
const pkgPath = args.find((a) => !a.startsWith('--'));
const notes = (() => {
  const i = args.indexOf('--notes');
  return i >= 0 ? String(args[i + 1] || '') : '';
})();
const dry = args.includes('--dry');

if (!pkgPath) {
  console.error('用法: node scripts/publish-kernel.mjs <内核包.tar.gz> [--notes "说明"] [--dry]');
  process.exit(1);
}
if (!fs.existsSync(pkgPath)) {
  console.error('包不存在:', pkgPath);
  process.exit(1);
}

function loadR2() {
  const txt = fs.readFileSync(R2_ENV, 'utf8');
  const o = {};
  for (const line of txt.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.+)$/.exec(line.trim());
    if (m) o[m[1]] = m[2];
  }
  if (!o.R2_ENDPOINT || !o.R2_ACCESS_KEY_ID || !o.R2_SECRET_ACCESS_KEY || !o.R2_BUCKET) {
    throw new Error('R2 凭据不完整');
  }
  return o;
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
      'User-Agent': UA
    },
    body,
    signal: AbortSignal.timeout(180000)
  });
  return res.status;
}

/**
 * R2 删除对象（2026-11-01）
 *
 * 用途：版本超过保留上限时，把最老的包从存储里删掉，
 * 否则 R2 会无限累积（实测已堆到 82 个版本）。
 */
async function r2Delete(env, key) {
  const ep = env.R2_ENDPOINT.replace(/\/$/, '');
  const host = ep.replace(/^https:\/\//, '');
  const uri = `/${env.R2_BUCKET}/${key}`;
  const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const ds = amz.slice(0, 8);
  // DELETE 没有 body，空载荷哈希
  const ph = crypto.createHash('sha256').update('').digest('hex');
  const ch = `host:${host}\nx-amz-content-sha256:${ph}\nx-amz-date:${amz}\n`;
  const sh = 'host;x-amz-content-sha256;x-amz-date';
  const cr = ['DELETE', uri, '', ch, sh, ph].join('\n');
  const scope = `${ds}/auto/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amz, scope, crypto.createHash('sha256').update(cr).digest('hex')].join('\n');
  const h = (k, m) => crypto.createHmac('sha256', k).update(m).digest();
  let k = h('AWS4' + env.R2_SECRET_ACCESS_KEY, ds);
  k = h(k, 'auto'); k = h(k, 's3'); k = h(k, 'aws4_request');
  const sig = crypto.createHmac('sha256', k).update(sts).digest('hex');

  const res = await fetch(`${ep}${uri}`, {
    method: 'DELETE',
    headers: {
      Host: host,
      'x-amz-content-sha256': ph,
      'x-amz-date': amz,
      Authorization: `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${sh}, Signature=${sig}`,
      'User-Agent': UA
    },
    signal: AbortSignal.timeout(60000)
  });
  return res.status;
}

/** 版本保留上限（与 Worker 的 MAX_VERSIONS 保持一致） */
const KEEP_RELEASES = Number(process.env.WB_KEEP_RELEASES) || 50;

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function fetchIndex() {
  try {
    const res = await fetch(`${BASE}/kernel/index.json`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return { releases: [] };
    const d = await res.json();
    return { releases: Array.isArray(d.releases) ? d.releases : [] };
  } catch {
    return { releases: [] };
  }
}

const buf = fs.readFileSync(pkgPath);
const sha256 = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
const size = buf.length;
const version = readVersion();
const short = sha256.slice(0, 10);
const fname = `kernel-${version}-${short}.tar.gz`;

console.log('  包       :', path.basename(pkgPath));
console.log('  版本     :', version);
console.log('  大小     :', (size / 1024 / 1024).toFixed(2), 'MB');
console.log('  sha256   :', sha256.slice(0, 24) + '…');
console.log('  目标     : packages/' + fname);

if (dry) { console.log('\n  [dry] 不实际上传'); process.exit(0); }

const env = loadR2();

// ① 传包
console.log('\n  上传包体…');
const st = await r2Put(env, `packages/${fname}`, buf, 'application/gzip');
if (st !== 200) { console.error('  ❌ 上传失败 HTTP', st); process.exit(1); }
console.log('  ✅ 包已上传');

// ② 更新 index
const idx = await fetchIndex();
const download = `${BASE}/packages/${fname}`;
const item = {
  version,
  releasedAt: new Date().toISOString(),
  notes: notes || '',
  download,
  sha256,
  size
};
idx.releases = (idx.releases || []).filter((r) => r.version !== version);
idx.releases.push(item);
idx.releases.sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));

// ── 自动清理旧版本（2026-11-01）──
//
// 原来只往 index 里追加，从不删包 —— 实测已堆到 82 个版本，
// R2 存储一直涨。用户要求「后续每多一个版本删一个旧的」。
//
// 策略：按版本号从新到旧排序，保留前 KEEP_RELEASES(50) 个，
// 其余从 index 里移除 **并删掉 R2 上的包文件**。
// 注意：只删「多出来的最老的那些」，不会动刚发的这个。
const pruned = [];
if (idx.releases.length > KEEP_RELEASES) {
  const keep = idx.releases.slice(0, KEEP_RELEASES);
  const drop = idx.releases.slice(KEEP_RELEASES);
  console.log(`  版本数 ${idx.releases.length} > ${KEEP_RELEASES}，清理 ${drop.length} 个旧版本`);
  for (const d of drop) {
    // 从 download URL 反推 R2 key
    const key = (() => {
      const u = String(d.download || '');
      const m = u.match(/\/packages\/([^/?#]+)$/);
      return m ? `packages/${m[1]}` : '';
    })();
    if (key) {
      const st = await r2Delete(env, key);
      // 404 也算成功（可能之前已删）
      if (st >= 200 && st < 300) {
        console.log(`  🗑  已删 ${d.version}（${key}）`);
        pruned.push(d.version);
      } else if (st === 404) {
        console.log(`  🗑  ${d.version} 的包已不存在，仅从列表移除`);
        pruned.push(d.version);
      } else {
        console.log(`  ⚠️  ${d.version} 删除失败 HTTP ${st}，仍从列表移除`);
        pruned.push(d.version);
      }
    } else {
      console.log(`  ⚠️  ${d.version} 找不到下载地址，仅从列表移除`);
      pruned.push(d.version);
    }
  }
  idx.releases = keep;
}

const payload = Buffer.from(JSON.stringify({
  apiVersion: 1,
  updatedAt: new Date().toISOString(),
  releases: idx.releases
}, null, 2));

console.log('  更新 kernel/index.json…');
const st2 = await r2Put(env, 'kernel/index.json', payload, 'application/json');
if (st2 !== 200) { console.error('  ❌ index 上传失败 HTTP', st2); process.exit(1); }

console.log('  ✅ index 已更新，共', idx.releases.length, '个版本');
if (pruned.length) {
  console.log(`  🧹 已清理 ${pruned.length} 个旧版本：${pruned.join(', ')}`);
}
console.log('\n  下载地址:', download);
