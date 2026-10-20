// ── 插件内核 · Manifest 契约 ────────────────────────────────────────────
//
// 这一层只做「声明式校验」：把 manifest.json 读成确定形状，非法就拒绝装载。
// 为什么先校验再装载：插件跑起来才发现字段缺失，会表现为「功能时有时无」，
// 排查成本极高（历史上 group-manager 空工具条目就是这么把自检搞崩的）。
//
// 契约详见 PLUGIN-ARCH.md 第二节。此处只保证「拿到的一定是合法对象」。

export const PLUGIN_API_VERSION = 1;

const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** 合法钩子名。新增钩子必须同时改这里和宿主，否则静默不生效。 */
// prefilter = 消息入库**之前**的拦截点（黑名单等需要"彻底不记录"的插件用）
export const HOOK_NAMES = new Set(['message', 'poke', 'notice', 'tick', 'prefilter']);

function asString(v, dflt = '') {
  return v === undefined || v === null ? dflt : String(v);
}

function asBool(v, dflt = false) {
  return v === undefined || v === null ? dflt : v === true;
}

function asInt(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

/**
 * 校验并规整 manifest。
 * @returns {{ok:true, manifest:object} | {ok:false, error:string}}
 */
export function normalizeManifest(raw, { dirName = '' } = {}) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'manifest 不是对象' };

  const id = asString(raw.id).trim();
  if (!id) return { ok: false, error: '缺少 id' };
  if (!ID_RE.test(id)) return { ok: false, error: `id 不合法（需 3~40 位小写字母/数字/连字符）：${id}` };
  // 目录名与 id 不一致 → 导出后换实例导入会错位，直接拒
  if (dirName && dirName !== id) {
    return { ok: false, error: `目录名 ${dirName} 与 id ${id} 不一致` };
  }

  const apiVersion = asInt(raw.apiVersion, 0);
  if (apiVersion !== PLUGIN_API_VERSION) {
    return {
      ok: false,
      error: `apiVersion 不兼容（插件 ${apiVersion || '未声明'}，内核 ${PLUGIN_API_VERSION}）`
    };
  }

  const hooks = Array.isArray(raw.hooks)
    ? raw.hooks.map((h) => asString(h).trim()).filter(Boolean)
    : [];
  const badHook = hooks.find((h) => !HOOK_NAMES.has(h));
  if (badHook) return { ok: false, error: `未知钩子 ${badHook}（可用：${[...HOOK_NAMES].join(' / ')}）` };

  const config = raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config)
    ? raw.config
    : {};

  let uiTab = null;
  if (raw.uiTab && typeof raw.uiTab === 'object') {
    const tabId = asString(raw.uiTab.id).trim();
    const label = asString(raw.uiTab.label).trim();
    // tab id 会成为 DOM id 的一部分，只允许字母数字与连字符
    if (tabId && /^[a-z0-9-]+$/.test(tabId) && label) uiTab = { id: tabId, label };
  }

  const scopes = Array.isArray(raw.scopes) ? raw.scopes.map(String).filter(Boolean) : ['all'];

  // ── 依赖声明（2026-10-21）──
  // 导出插件包时**不带**依赖（node_modules/.venv 一律排除），
  // 所以必须让 manifest 说清楚"我需要什么"，接收方才知道怎么装。
  //
  // 形状：{ pip: [...], system: [...], npm: [...] }
  //   pip    —— Python 包名（voice 插件用 edge-tts）
  //   system —— 系统级命令（如 ffmpeg）
  //   npm    —— Node 包
  // 这些**只用于提示**，内核不会自动安装（自动装依赖是安全与可复现性的雷区）。
  const deps = {};
  if (raw.deps && typeof raw.deps === 'object') {
    for (const k of ['pip', 'system', 'npm']) {
      if (Array.isArray(raw.deps[k])) deps[k] = raw.deps[k].map(String).filter(Boolean);
    }
  }

  // 安装说明（原样展示给用户，支持多行）
  const setup = asString(raw.setup);

  return {
    ok: true,
    manifest: {
      id,
      name: asString(raw.name, id),
      version: asString(raw.version, '0.0.0'),
      apiVersion,
      description: asString(raw.description),
      author: asString(raw.author),
      entry: asString(raw.entry, 'index.js'),
      ui: asString(raw.ui),
      priority: asInt(raw.priority, 100),
      defaultEnabled: asBool(raw.defaultEnabled, false),
      hooks,
      tools: asBool(raw.tools, false),
      promptSections: Array.isArray(raw.promptSections) ? raw.promptSections.map(String) : [],
      uiTab,
      config,
      permissions: Array.isArray(raw.permissions) ? raw.permissions.map(String) : [],
      scopes,
      deps,
      setup,
      // 分类与一句话简介：面板用来分组展示，纯展示字段
      category: asString(raw.category, '其他'),
      summary: asString(raw.summary)
    }
  };
}
