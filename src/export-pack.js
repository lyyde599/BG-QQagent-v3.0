// 一键打包（2026-10-31）
//
// 需求：设置 → 关于里能一键导出「部署包 / 插件 / 用户数据」，可分别打包。
//
// 设计要点：
// ① 三类包分开，用户按需选，不强制一起打
// ② **数据包默认脱敏** —— data/config.json 里的 API Key、token 必须替换成
//    占位符，否则导出的包一旦外发就是密钥泄漏（这里踩过教训，见 3.2.15）
// ③ 用系统 tar（GNU 1.35，支持 zstd），不引第三方库
// ④ 输出到 data/exports/，可在界面直接列出和下载
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT, DATA_DIR, getConfig } from './config.js';

const EXPORT_DIR = path.join(DATA_DIR, 'exports');

// 包内容清单（与 scripts/kernel-install.mjs 的发布包保持一致）
const CODE_ITEMS = [
  'src', 'ui', 'electron', 'skills', 'scripts', 'test', 'assets', 'docs',
  'package.json', 'package-lock.json',
  'README.md', 'PLUGIN-ARCH.md', 'VOICE-RESEARCH.md',
  '插件与Skill制作及使用规范.md', '内核发布说明.md', '安装说明.md',
  // 每次发版必带（2026-11-02）：用户要求"部署包请内置更新说明"
  '更新说明.md',
  '.gitignore', 'LICENSE'
];

// 数据包里**默认不打包**的（2026-10-31 实测体积后定的）
//
// 本机实测：data 总计 508M，其中
//   exports 308M（导出产物本身）/ inbox 304M（收到的文件）/ plugins 180M（venv）
//   sessions 23M（会话记录）
// 全都打进去会得到一个 300M+ 的包，既慢又没意义。
//
// 策略：默认只打**真正的配置与记忆**（config/memory/feedback 等，约 1-2M），
// 大块凭据性数据由用户在界面上按需勾选。
const DATA_EXCLUDE = [
  'exports',           // 导出产物本身（否则会把自己打进去）
  'sessions',          // 会话记录，默认不打（可选）
  'inbox',             // 收到的文件（图/视频/压缩包），默认不打（可选）
  'dsh-work',          // 任务中间产物
  'kernel-updates',    // 内核更新缓存
  'Qzone/cache'
];

// 插件数据里这些是第三方依赖，永远不打（可重建）
const PLUGIN_DATA_EXCLUDE = /(node_modules|__pycache__|\.venv|\/venv|\/lib64)$/;

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 读版本号 */
function kernelVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
}

/**
 * 脱敏：把 config.json 里的密钥替换成占位符。
 * 只处理已知的敏感字段，其余原样保留（保证导出的包还能直接用）。
 */
function sanitizeConfig(srcFile, dstFile) {
  const raw = fs.readFileSync(srcFile, 'utf8');
  let cfg;
  try { cfg = JSON.parse(raw); } catch { fs.copyFileSync(srcFile, dstFile); return { sanitized: false }; }
  const MARK = '__REPLACE_ME__';
  let n = 0;
  const scrub = (obj, keyPath = '') => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const lower = k.toLowerCase();
      const isSecret = /apikey|token|secret|password|passwd|credential/i.test(lower);
      if (isSecret && typeof v === 'string' && v.trim()) {
        obj[k] = MARK;
        n++;
      } else if (Array.isArray(v)) {
        // anysearchKeys / endpoints 这类数组，元素可能是密钥
        if (/keys?$/i.test(lower)) {
          const arr = v.filter((x) => String(x || '').trim());
          if (arr.length) { obj[k] = arr.map(() => MARK); n += arr.length; }
        } else {
          v.forEach((it) => scrub(it));
        }
      } else if (v && typeof v === 'object') {
        scrub(v);
      }
    }
  };
  scrub(cfg);
  fs.writeFileSync(dstFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { sanitized: n > 0, count: n };
}

/** 跑 tar，返回 { ok, err } */
function runTar(args, cwd) {
  const r = spawnSync('tar', args, { cwd, encoding: 'utf8', timeout: 10 * 60 * 1000 });
  if (r.status !== 0) {
    return { ok: false, err: String(r.stderr || r.error?.message || 'tar 失败').slice(0, 400) };
  }
  return { ok: true };
}

/**
 * 打包「部署包」= 代码 + 指定插件
 * @param {{plugins?:string[]}} opts
 */
// 🔴 内置插件名单必须和 scripts/install-local.sh 对齐（2026-11-06）
//
// 安装脚本第 155 行写死了：
//   case "$pname" in
//     plugin-market|file-recv) 强制覆盖 ;;   ← 这两个是"内置"
//     *) 保留用户自己的 ;;
//
// 而这里的默认值只有 plugin-market —— 于是 file-recv 连续两个版本没进包。
// 用户装完发现"收文件的功能没了"，而实际上它压根没被打进包。
//
// 现在两边用同一份名单。改这里时**必须同步改 install-local.sh**。
export const BUILTIN_PLUGINS = ['plugin-market', 'file-recv'];

export function buildDeployPack({ plugins = BUILTIN_PLUGINS } = {}) {
  ensureDir(EXPORT_DIR);
  const ver = kernelVersion();
  const name = `部署包-鲸界Bridge-${ver}-${stamp()}.tar.gz`;
  const out = path.join(EXPORT_DIR, name);

  // 先把要打的东西收拢到临时目录，避免 tar 的复杂 exclude 规则出错
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-deploy-'));
  const stage = path.join(tmp, 'whalebridge');
  ensureDir(stage);

  const missing = [];
  for (const item of CODE_ITEMS) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) { missing.push(item); continue; }
    const dst = path.join(stage, item);
    ensureDir(path.dirname(dst));
    fs.cpSync(src, dst, { recursive: true, dereference: true });
  }

  // 插件：只带用户选的
  //
  // 🔴 但**内置插件必须在内**（2026-11-06）
  //   调用方手写列表时漏掉 file-recv → 连续两版没进包，用户装完"收文件功能没了"。
  //   这里硬性拦截：缺一个就报错，不生成残包。
  const missingBuiltin = BUILTIN_PLUGINS.filter((x) => !plugins.includes(x));
  if (missingBuiltin.length) {
    return {
      ok: false,
      error: `内置插件没被打进包：${missingBuiltin.join(', ')}。`
        + `必须包含 ${BUILTIN_PLUGINS.join(' / ')}（和 scripts/install-local.sh 对齐）。`,
      missing: missingBuiltin,
    };
  }
  const plugDir = path.join(stage, 'plugins');
  ensureDir(plugDir);
  const bundled = [];
  for (const pid of plugins) {
    const src = path.join(ROOT, 'plugins', pid);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(plugDir, pid);
    // 插件下的 node_modules / .venv 不进包（跟发布包口径一致）
    fs.cpSync(src, dst, {
      recursive: true,
      dereference: true,
      filter: (s) => !/(node_modules|\.venv|__pycache__)$/.test(path.basename(s))
    });
    bundled.push(pid);
  }
  // 插件说明
  const pReadme = path.join(ROOT, 'plugins', 'README.md');
  if (fs.existsSync(pReadme)) fs.copyFileSync(pReadme, path.join(plugDir, 'README.md'));

  // 顺手清掉打包目录里的 .bak-*
  const cleanBak = (dir) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (f.startsWith('.bak-')) { fs.rmSync(p, { recursive: true, force: true }); continue; }
        try { if (fs.statSync(p).isDirectory()) cleanBak(p); } catch { /* 忽略 */ }
      }
    } catch { /* 忽略 */ }
  };
  cleanBak(stage);

  const r = runTar(['czf', out, 'whalebridge'], tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!r.ok) throw new Error(r.err);

  const stat = fs.statSync(out);
  return {
    ok: true, kind: 'deploy', file: name, path: out,
    size: stat.size, version: ver, plugins: bundled, missing
  };
}

/**
 * 打包「用户数据」
 * @param {{sanitize?:boolean, includeSessions?:boolean}} opts
 */
export function buildDataPack({ sanitize = true, includeSessions = false, includeInbox = false, includePluginData = true } = {}) {
  ensureDir(EXPORT_DIR);
  const ver = kernelVersion();
  const tag = sanitize ? '脱敏' : '原样';
  const name = `用户数据-鲸界Bridge-${ver}-${tag}-${stamp()}.tar.gz`;
  const out = path.join(EXPORT_DIR, name);

  // 🔴 临时目录必须放在 data/ **外面**（2026-10-31 踩坑）
  //
  // 一开始放在 data/.pack-tmp-data，结果 copyTree 递归拷贝自己 →
  // 目录无限嵌套，报 ENAMETOOLONG。
  // 现在建在系统临时区，跟被拷贝的源目录彻底分开。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-export-'));
  const stage = path.join(tmp, 'data');
  ensureDir(stage);

  const skip = new Set(DATA_EXCLUDE);
  if (includeSessions) skip.delete('sessions');
  if (includeInbox) skip.delete('inbox');
  // 插件数据整块是可选（里面常带 venv/node_modules）
  if (!includePluginData) skip.add('plugins');
  // 兜底：任何 .pack-tmp* 都不打（历史残留）
  skip.add('.pack-tmp');
  skip.add('.pack-tmp-data');

  // 🔴 用 fs.cpSync 递归，不要手写 copyFileSync（2026-10-31 踩坑）
  //
  // 手写版在遇到符号链接（如 venv/lib64 -> lib）时会报
  // EISDIR: illegal operation on a directory ——
  // 因为 dirent.isDirectory() 对符号链接返回 false，走到 copyFileSync 就炸。
  // cpSync 内部正确处理软链与目录。
  let fileCount = 0;
  for (const ent of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    const s = path.join(DATA_DIR, ent.name);
    const d = path.join(stage, ent.name);

    // config.json 单独走脱敏通道
    if (ent.name === 'config.json' && ent.isFile() && sanitize) {
      sanitizeConfig(s, d);
      fileCount++;
      continue;
    }

    // venv / node_modules 这类第三方依赖不进数据包（体积大且可重建）
    fs.cpSync(s, d, {
      recursive: true,
      dereference: false,
      filter: (src) => !PLUGIN_DATA_EXCLUDE.test(src)
    });
    const count = (dir) => {
      let c = 0;
      const walk = (p) => {
        let ents;
        try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (e.isDirectory()) walk(path.join(p, e.name));
          else c++;
        }
      };
      walk(dir);
      return c;
    };
    try { fileCount += count(d); } catch { /* 忽略统计失败 */ }
  }

  // 附一份说明，告诉用户包里有什么、哪些被脱敏
  fs.writeFileSync(path.join(stage, '导出说明.txt'), [
    `鲸界Bridge 用户数据导出  ${stamp()}`,
    `内核版本：${ver}`,
    `脱敏：${sanitize ? '是（API Key / Token 已替换为 __REPLACE_ME__）' : '否（含真实密钥，请勿外发）'}`,
    `会话记录：${includeSessions ? '包含' : '未包含（体积大，如需请单独勾选）'}`,
    '',
    '还原方法：把本包里的内容覆盖回 项目目录/data/ 即可。',
    sanitize ? '注意：还原后需要重新填写 API Key。' : '注意：本包含真实密钥，妥善保管。'
  ].join('\n'), 'utf8');

  const r = runTar(['czf', out, 'data'], tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!r.ok) throw new Error(r.err);

  const stat = fs.statSync(out);
  return {
    ok: true, kind: 'data', file: name, path: out,
    size: stat.size, version: ver, sanitized: sanitize,
    includeSessions, includeInbox, includePluginData, fileCount
  };
}

/** 列出已有导出包 */
export function listExports() {
  ensureDir(EXPORT_DIR);
  return fs.readdirSync(EXPORT_DIR)
    .filter((f) => f.endsWith('.tar.gz'))
    .map((f) => {
      const p = path.join(EXPORT_DIR, f);
      let size = 0, mtime = 0;
      try { const st = fs.statSync(p); size = st.size; mtime = st.mtimeMs; } catch { /* 忽略 */ }
      return { file: f, size, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function exportDir() { return EXPORT_DIR; }

/**
 * 删除一个导出包（2026-10-31 补）。
 *
 * 导出目录会一直累积，用户需要能清理。
 * 安全约束：只允许删 exports/ 下的 *.tar.gz，文件名不含路径分隔符 ——
 * 防止借这个接口删到别处去。
 *
 * @param {string} file
 * @returns {{ok:boolean, file?:string, size?:number, error?:string}}
 */
export function removeExport(file) {
  const name = String(file || '').trim();
  if (!name) return { ok: false, error: '缺少文件名' };
  // 只认 exports 目录下的 tar.gz，且不能带路径
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { ok: false, error: '文件名不合法' };
  }
  if (!/\.tar\.gz$/.test(name)) {
    return { ok: false, error: '只允许删除 .tar.gz 导出包' };
  }
  const full = path.join(EXPORT_DIR, name);
  // 二次确认落在真实路径上（防符号链接绕过）
  const real = path.resolve(full);
  if (path.dirname(real) !== path.resolve(EXPORT_DIR)) {
    return { ok: false, error: '目标不在导出目录内' };
  }
  if (!fs.existsSync(real)) return { ok: false, error: '文件不存在' };
  let size = 0;
  try { size = fs.statSync(real).size; } catch { /* 忽略 */ }
  try {
    fs.rmSync(real, { force: true });
    return { ok: true, file: name, size };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * 清空所有导出包。
 * @returns {{ok:boolean, removed:number, freed:number}}
 */
export function clearExports() {
  const list = listExports();
  let removed = 0, freed = 0;
  for (const f of list) {
    if (removeExport(f.file).ok) { removed++; freed += f.size || 0; }
  }
  return { ok: true, removed, freed };
}
