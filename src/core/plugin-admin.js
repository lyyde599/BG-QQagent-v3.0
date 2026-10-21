// ── 插件内核 · 管理接口 ────────────────────────────────────────────────
//
// 端点（都挂在 /api/plugins 下，与业务插件自己的端点区分开）：
//   GET  /api/plugins                 列表（含状态/配置/工具/数据体积）
//   POST /api/plugins/enable          启用          {id}
//   POST /api/plugins/disable         停用          {id}
//   POST /api/plugins/reload          重新装载      {id}
//   POST /api/plugins/config          改配置        {id, patch}
//   POST /api/plugins/uninstall       卸载          {id, purgeData?}
//
//   GET  /api/plugins/data?id=X       盘点数据（文件清单 + 体积）
//   POST /api/plugins/data/clear      清空数据      {id}
//
//   GET  /api/plugins/export?id=X&mode=clean|config|full
//        clean  仅代码 + manifest（配置回默认、不含数据）← 开源给别人
//        config 代码 + 当前配置（不含运行数据）      ← 保留设置的干净分发
//        full   代码 + 当前配置 + 全部运行数据       ← 迁移/备份
//
//   POST /api/plugins/import          导入          {base64, mode:'replace'|'keep'}
//        mode=replace：覆盖已有插件（先卸载再装）
//        mode=keep   ：已存在则保留，只返回提示
//
// 设计原则：管理操作**不碰内核状态**——停用只摘注册，卸载只删 plugins/<id> 目录，
// 都不影响 OneBot 连接、消息存档、白名单等基础功能。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from '../config.js';
import { PLUGIN_API_VERSION, normalizeManifest } from './manifest.js';
import {
  pluginDataDir, inspectData, clearDirContents, collectDataEntries,
  restoreDataEntries, humanSize
} from './plugin-data.js';

const PLUGINS_DIR = path.join(ROOT, 'plugins');

/**
 * 导出时**永不打包**的目录/文件（2026-10-21 加）。
 *
 * 起因：voice 插件需要 edge-tts，我把虚拟环境建在了插件目录里（.venv，32MB/1403 文件）。
 * 原导出逻辑是裸遍历，会把它整包塞进去 —— 而这对接收方**纯粹是毒**：
 *   · 里面是 aarch64 的 .so 与绝对路径 shebang，到 x86 机器上根本不能用
 *   · 解压后覆盖他自己的环境，可能直接把他搞坏
 *   · 包体积从几十 KB 膨胀到几十 MB
 *
 * 原则：**插件包只该包含"源码与声明"**。
 * 依赖由接收方按 README（或 manifest.deps）自己装，这是分发的常识。
 */
const EXPORT_EXCLUDE_DIRS = new Set([
  'node_modules', '.venv', 'venv', '__pycache__', '.git', '.idea', '.vscode',
  'dist', 'build', '.cache', '.pytest_cache', '.mypy_cache', 'site-packages'
]);
const EXPORT_EXCLUDE_FILES = new Set([
  '.DS_Store', 'Thumbs.db', '.gitignore', '.env', '.env.local'
]);
// 这些扩展名是构建产物/字节码，跨平台无意义
const EXPORT_EXCLUDE_EXT = new Set(['.pyc', '.pyo', '.so', '.dylib', '.dll', '.log', '.map']);
const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

// ── 极简 tar 读写（不引第三方依赖）─────────────────────────────────────
//
// 为什么自己写：项目 dependencies 只有 4 个（js-yaml/qrcode/undici/ws），
// 为导出插件装 archiver 不值得。tar + Node 内置 zlib 就够。
// 限制：只处理普通文件（插件包不需要软链与设备文件）。
export function tarWrite(files) {
  const blocks = [];
  for (const [name, buf] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    if (nameBuf.length > 100) continue;              // ustar 短名限制
    const header = Buffer.alloc(512);
    nameBuf.copy(header, 0);
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(buf.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'ascii');
    header.write('        ', 148, 'ascii');           // checksum 先填空格
    header.write('0', 156, 'ascii');                  // typeflag: 普通文件
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    blocks.push(header, buf);
    const pad = (512 - (buf.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));                    // 两个全零块收尾
  return Buffer.concat(blocks);
}

export function tarRead(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;          // 全零 = 结束
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0;
    const type = String.fromCharCode(header[156]);
    off += 512;
    const data = buf.subarray(off, off + size);
    off += size + ((512 - (size % 512)) % 512);
    if ((type === '0' || type === '\0') && name) out.push([name, Buffer.from(data)]);
  }
  return out;
}

/** 导出模式定义（面板据此显示选项与说明） */
export const EXPORT_MODES = {
  clean: {
    id: 'clean',
    label: '干净包（推荐用于开源/分享）',
    desc: '只含代码与 manifest，配置回到默认值，不含任何运行数据 —— 别人导入后像刚装上一样',
    includeConfig: false,
    includeData: false
  },
  config: {
    id: 'config',
    label: '带配置（不含数据）',
    desc: '含代码与你当前的设置，但不含运行数据（无对局记录、无领取记录、无审计日志）',
    includeConfig: true,
    includeData: false
  },
  full: {
    id: 'full',
    label: '完整备份（含数据）',
    desc: '含代码、配置与全部运行数据 —— 用于迁移到另一台机器或整体备份',
    includeConfig: true,
    includeData: true
  }
};

/**
 * 注册管理路由到宿主。
 * @param {import('./plugin-host.js').PluginHost} host
 * @param {object} deps { getConfig, log }
 */
export function registerPluginAdmin(host, { getConfig, log }) {
  const add = (method, p, handler, raw = false) => host.routes.push({
    id: '__admin__', method, path: p, handler, raw, pluginId: null
  });

  // ── 列表 ──
  add('GET', '/api/plugins', () => ({
    ok: true,
    apiVersion: PLUGIN_API_VERSION,
    exportModes: Object.values(EXPORT_MODES).map(({ id, label, desc }) => ({ id, label, desc })),
    plugins: host.list().map((p) => {
      const d = inspectData(p.id);
      return {
        ...p,
        data: { exists: d.exists, fileCount: d.files.length, bytes: d.totalBytes, sizeText: humanSize(d.totalBytes) }
      };
    }),
    // inline=true 的页签内嵌在插件页渲染，不占顶栏
    // file: 插件前端入口（manifest.ui），前端据此动态 import
    // /plugin-ui/<pluginId>/<file>
    tabs: host.uiTabs.map((t) => ({
      id: t.id, label: t.label, pluginId: t.pluginId,
      inline: t.inline === true, file: t.file || ''
    }))
  }));

  // ── 启停 ──
  add('POST', '/api/plugins/enable', async (_req, body) => {
    const id = String(body?.id || '');
    const rec = host.records.get(id);
    if (!rec) return { ok: false, error: '没有该插件' };
    if (!rec.manifest) return { ok: false, error: 'manifest 缺失，无法启用' };
    const r = await host.enable(rec.manifest);
    if (r?.status === 'enabled') host.records.get(id)?.config?.set({ enabled: true });
    return { ok: r?.status === 'enabled', status: r?.status, error: r?.lastError };
  });

  add('POST', '/api/plugins/disable', async (_req, body) => {
    const id = String(body?.id || '');
    const rec = host.records.get(id);
    if (!rec) return { ok: false, error: '没有该插件' };
    const cfg = rec.config;
    await host.disable(id);
    cfg?.set({ enabled: false });
    return { ok: true, status: 'disabled' };
  });

  add('POST', '/api/plugins/reload', async (_req, body) => {
    const r = await host.reload(String(body?.id || ''));
    return { ok: r.ok, status: r.status, error: r.error };
  });

  add('POST', '/api/plugins/config', (_req, body) => {
    const rec = host.records.get(String(body?.id || ''));
    if (!rec?.config) return { ok: false, error: '没有该插件' };
    const patch = body?.patch;
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'patch 必须是对象' };
    return { ok: true, config: rec.config.set(patch) };
  });

  // ── 批量启停（2026-10-21）──
  // 一键全开/全关。为什么需要：插件多起来以后逐个点很烦，
  // 而且"我要测纯白版本"这种场景天然需要一次全关。
  //
  // ⚠️ 逐个处理而非并发：插件的 activate 可能注册路由/定时器，
  //    并发会打乱 priority 排序，也可能让两个插件抢同一个端点。
  add('POST', '/api/plugins/bulk', async (_req, body) => {
    const want = body?.enable === true;
    const only = Array.isArray(body?.ids) ? body.ids.map(String) : null;   // 可选：只作用于指定插件
    const done = [];
    const failed = [];

    for (const rec of [...host.records.values()]) {
      if (!rec.manifest) continue;
      if (only && !only.includes(rec.id)) continue;
      const isOn = rec.status === 'enabled';
      if (isOn === want) { done.push({ id: rec.id, status: rec.status, skipped: true }); continue; }
      try {
        if (want) {
          const r = await host.enable(rec.manifest);
          if (r?.status === 'enabled') {
            host.records.get(rec.id)?.config?.set({ enabled: true });
            done.push({ id: rec.id, status: 'enabled' });
          } else {
            failed.push({ id: rec.id, error: r?.lastError || '装载失败' });
          }
        } else {
          const cfg = rec.config;
          await host.disable(rec.id);
          cfg?.set({ enabled: false });
          done.push({ id: rec.id, status: 'disabled' });
        }
      } catch (error) {
        failed.push({ id: rec.id, error: String(error?.message ?? error) });
      }
    }

    log(`[plugins] 批量${want ? '启用' : '停用'}：成功 ${done.filter((d) => !d.skipped).length}，` +
        `跳过 ${done.filter((d) => d.skipped).length}，失败 ${failed.length}`);
    return {
      ok: failed.length === 0,
      action: want ? 'enable' : 'disable',
      done,
      failed,
      note: failed.length
        ? `${failed.length} 个失败：${failed.map((f) => f.id).join(', ')}`
        : `已${want ? '启用' : '停用'} ${done.filter((d) => !d.skipped).length} 个`
    };
  });

  // ── 卸载（可选连数据一起删）──
  add('POST', '/api/plugins/uninstall', async (_req, body) => {
    const id = String(body?.id || '');
    if (!ID_RE.test(id)) return { ok: false, error: 'id 不合法' };
    const purge = body?.purgeData === true;
    const rec = host.records.get(id);
    if (rec) await host.disable(id);

    const dir = path.join(PLUGINS_DIR, id);
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      return { ok: false, error: `删除目录失败：${error?.message ?? error}` };
    }
    host.records.delete(id);

    let dataNote = `私有数据保留在 data/plugins/${id}`;
    if (purge) {
      const r = clearDirContents(pluginDataDir(id));
      dataNote = r.failed.length
        ? `数据已清空（${r.removed} 项；${r.failed.length} 项删不掉：${r.failed.join(', ')}）`
        : `数据已清空（${r.removed} 项）`;
    }
    log(`[plugins] 已卸载 ${id}（${dataNote}）`);
    return { ok: true, note: `插件目录已删除；${dataNote}` };
  });

  // ── 数据盘点 ──
  add('GET', '/api/plugins/data', (_req, _body, url) => {
    const id = String(url?.searchParams?.get('id') || '');
    if (!ID_RE.test(id)) return { ok: false, error: 'id 不合法' };
    const d = inspectData(id);
    return {
      ok: true,
      id,
      dir: d.dir,
      exists: d.exists,
      totalBytes: d.totalBytes,
      sizeText: humanSize(d.totalBytes),
      files: d.files.slice(0, 200).map((f) => ({ ...f, sizeText: humanSize(f.size) })),
      fileCount: d.files.length
    };
  });

  // ── 清空数据 ──
  add('POST', '/api/plugins/data/clear', (_req, body) => {
    const id = String(body?.id || '');
    if (!ID_RE.test(id)) return { ok: false, error: 'id 不合法' };
    const dir = pluginDataDir(id);
    const r = clearDirContents(dir);
    log(`[plugins] ${id} 数据已清空（${r.removed} 项）`);
    return {
      ok: true,
      removed: r.removed,
      failed: r.failed,
      note: r.failed.length
        ? `${r.removed} 项已删；${r.failed.length} 项删不掉（可能被占用）：${r.failed.join(', ')}`
        : `已清空 ${r.removed} 项`
    };
  });

  // ── 导出（raw：直接吐 gzip 字节）──
  add('GET', '/api/plugins/export', async (_req, _body, url) => {
    const id = String(url?.searchParams?.get('id') || '');
    if (!ID_RE.test(id)) return { ok: false, error: 'id 不合法' };
    const dir = path.join(PLUGINS_DIR, id);
    if (!fs.existsSync(dir)) return { ok: false, error: '没有该插件目录' };

    const modeId = String(url?.searchParams?.get('mode') || 'config');
    const mode = EXPORT_MODES[modeId] || EXPORT_MODES.config;

    // ① 代码与资源（永远带上，但跳过导出过程本身生成的元文件）
    const files = [];
    const skipped = [];
    const walk = (d, rel = '') => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        const r = rel ? `${rel}/${ent.name}` : ent.name;

        // 排除依赖目录/构建产物 —— 见 EXPORT_EXCLUDE_DIRS 的说明
        if (ent.isDirectory()) {
          if (EXPORT_EXCLUDE_DIRS.has(ent.name)) { skipped.push(r + '/'); continue; }
          walk(full, r);
          continue;
        }
        if (!ent.isFile()) continue;
        if (r === 'config.json' || r === '_export.json') continue;   // 单独处理
        if (EXPORT_EXCLUDE_FILES.has(ent.name)) { skipped.push(r); continue; }
        if (EXPORT_EXCLUDE_EXT.has(path.extname(ent.name).toLowerCase())) { skipped.push(r); continue; }

        files.push([`${id}/${r}`, fs.readFileSync(full)]);
      }
    };
    walk(dir);
    if (skipped.length) {
      log(`[plugins] ${id} 导出已排除 ${skipped.length} 项依赖/构建产物：${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ' …' : ''}`);
    }

    // ② 配置
    //   clean → 写 manifest 默认值（等于"刚装上"的状态）
    //   其它  → 写当前实际配置
    const rec = host.records.get(id);
    const manifestPath = path.join(dir, 'manifest.json');
    let manifestDefaults = {};
    try { manifestDefaults = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).config || {}; } catch { /* ignore */ }
    const configOut = mode.includeConfig
      ? (rec?.config?.get() || {})
      : manifestDefaults;
    files.push([`${id}/config.json`, Buffer.from(JSON.stringify(configOut, null, 2))]);

    // ③ 数据
    const dataEntries = mode.includeData ? collectDataEntries(id, `${id}/data`) : [];
    for (const e of dataEntries) files.push(e);

    // ④ 元信息（导入方据此决定怎么处理）
    const dataInfo = inspectData(id);
    files.push([`${id}/_export.json`, Buffer.from(JSON.stringify({
      apiVersion: PLUGIN_API_VERSION,
      exportedAt: new Date().toISOString(),
      source: 'qq-agent',
      mode: mode.id,
      modeLabel: mode.label,
      includesConfig: mode.includeConfig,
      includesData: mode.includeData,
      dataFileCount: mode.includeData ? dataEntries.length : 0,
      sourceDataBytes: dataInfo.totalBytes,
      note: mode.includeData
        ? '含运行数据；导入时会一并还原'
        : '不含运行数据 —— 导入方得到的是干净插件'
    }, null, 2))]);

    const gz = zlib.gzipSync(tarWrite(files));
    const stamp = new Date().toISOString().slice(0, 10);
    const suffix = mode.id === 'clean' ? 'clean' : (mode.id === 'full' ? 'full' : 'cfg');
    return {
      __raw: true,
      buffer: gz,
      filename: `${id}-${suffix}-${stamp}.tar.gz`,
      contentType: 'application/gzip'
    };
  }, true);

  // ── 导入 ──
  add('POST', '/api/plugins/import', async (_req, body) => {
    const b64 = body?.base64;
    if (!b64) return { ok: false, error: '缺少 base64 数据' };
    const replaceMode = body?.mode === 'replace';

    let entries;
    try {
      entries = tarRead(zlib.gunzipSync(Buffer.from(String(b64), 'base64')));
    } catch (error) {
      return { ok: false, error: `解包失败：${error?.message ?? error}` };
    }
    if (!entries.length) return { ok: false, error: '包里没有文件' };

    const rootName = String(entries[0][0]).split('/')[0];
    if (!rootName) return { ok: false, error: '无法识别包内目录' };

    const manifestEntry = entries.find(([n]) => n === `${rootName}/manifest.json`);
    if (!manifestEntry) return { ok: false, error: '包里没有 manifest.json' };
    let raw;
    try {
      raw = JSON.parse(manifestEntry[1].toString('utf8'));
    } catch (error) {
      return { ok: false, error: `manifest.json 解析失败：${error?.message ?? error}` };
    }

    const norm = normalizeManifest(raw, { dirName: rootName });
    if (!norm.ok) return { ok: false, error: norm.error };
    const id = norm.manifest.id;

    const targetDir = path.join(PLUGINS_DIR, id);
    const existed = fs.existsSync(targetDir);
    if (existed && !replaceMode) {
      return { ok: false, error: `插件 ${id} 已存在；如需覆盖请勾选「覆盖安装」` };
    }
    if (existed) {
      // 覆盖安装：先优雅停用（保留数据目录），再删源码目录
      const rec = host.records.get(id);
      if (rec) await host.disable(id);
      try { fs.rmSync(targetDir, { recursive: true, force: true }); }
      catch (error) { return { ok: false, error: `清除旧版本失败：${error?.message ?? error}` }; }
      host.records.delete(id);
    }

    // 包里带了数据吗？（决定要不要清空现有数据，避免新旧数据混在一起）
    const hasData = entries.some(([n]) => n.startsWith(`${rootName}/data/`));

    fs.mkdirSync(targetDir, { recursive: true });
    for (const [name, buf] of entries) {
      const rel = name.slice(rootName.length + 1);
      if (!rel || rel === 'config.json' || rel === '_export.json' || rel.startsWith('data/')) continue;
      if (rel.includes('..') || path.isAbsolute(rel)) continue;   // 防路径穿越
      const dest = path.join(targetDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }

    // 配置：包内有就整体写入（这是"作者的设置"或"默认值"）
    const cfgEntry = entries.find(([n]) => n === `${rootName}/config.json`);
    if (cfgEntry) {
      try {
        const restored = JSON.parse(cfgEntry[1].toString('utf8'));
        const { createPluginConfig } = await import('./plugin-config.js');
        // 用 replace 语义：先用包里的配置整体覆盖该插件段落
        const handle = createPluginConfig(id, {});
        handle.set(restored);
      } catch { /* 配置坏不影响装插件 */ }
    }

    // 数据：包里没有 → 保持现有数据不动（干净包导入不该毁掉本地数据）
    //       包里有   → 清空后还原（避免新旧混）
    let dataRestore = null;
    if (hasData) {
      clearDirContents(pluginDataDir(id));
      dataRestore = restoreDataEntries(entries, rootName, id);
    }

    const reloaded = await host.enable(norm.manifest);

    // 🔴 把 enabled 落进配置（2026-10-21 修）
    // 之前只在内存里 enable 了，配置里没有 enabled 字段 →
    // 重启后回落到 manifest.defaultEnabled（多为 false），
    // 表现为「导入时是启用的，重启后自己关掉了」，非常困惑。
    // 导入是用户的明确动作，就当作"我要用它"，直接置为启用。
    if (reloaded?.status === 'enabled') {
      try { host.records.get(id)?.config?.set({ enabled: true }); }
      catch (e) { log(`[plugins] ${id} 写入 enabled 失败（不影响本次运行）:`, e?.message ?? e); }
    }

    log(`[plugins] 已导入 ${id}（状态：${reloaded?.status}，数据：${hasData ? '含 ' + (dataRestore?.written || 0) + ' 文件' : '不含'}）`);

    return {
      ok: true,
      id,
      status: reloaded?.status,
      replaced: existed,
      dataRestored: hasData ? dataRestore : null,
      note: reloaded?.status === 'failed'
        ? `已落盘但装载失败：${reloaded?.lastError}`
        : (existed ? '已覆盖安装' : '导入完成') + (hasData ? `，已还原 ${dataRestore?.written || 0} 个数据文件` : '，未含运行数据')
    };
  });

  return host;
}
