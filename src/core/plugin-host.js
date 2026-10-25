// ── 插件内核 · 宿主（PluginHost）──────────────────────────────────────────
//
// 职责：发现插件 → 校验 manifest → 注入 ctx → 调 activate → 管生命周期。
//
// 三条硬保证（对应"装卸不影响基础功能"）：
//   ① activate 抛错 = 该插件标记 failed，内核照常启动（绝不让插件拖垮机器人）；
//   ② 任何插件回调抛错只写日志、不冒泡（钩子链继续跑）；
//   ③ dispose 后该插件注册的钩子/工具/路由/tab 全部摘除（不留悬挂引用）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA_DIR } from '../config.js';
import { normalizeManifest, PLUGIN_API_VERSION, HOOK_NAMES } from './manifest.js';
import { createPluginConfig, resolveEnabled } from './plugin-config.js';
import { registerPluginSkill, unregisterPluginSkills } from '../skill.js';

const PLUGINS_DIR = path.join(ROOT, 'plugins');

/** 插件私有数据目录（每个插件一个子目录，互不可见） */
export function pluginStateDir(id) {
  const dir = path.join(DATA_DIR, 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 极简 KV 落盘：一个插件一个 state.json。
 * 为什么不做数据库：插件状态量小（计数、审计尾巴），JSON 够用且好导。
 */
function createStateHandle(id) {
  const file = path.join(pluginStateDir(id), 'state.json');
  let cache = null;
  const load = () => {
    if (cache) return cache;
    try {
      cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      cache = {};
    }
    return cache;
  };
  const flush = () => {
    try {
      fs.writeFileSync(file, JSON.stringify(cache ?? {}, null, 1));
    } catch { /* 落盘失败绝不影响主流程 */ }
  };
  return {
    file,
    get(key, dflt = undefined) {
      const all = load();
      return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : dflt;
    },
    set(key, value) {
      const all = load();
      all[key] = value;
      flush();
      return value;
    },
    all: load,
    clear() {
      cache = {};
      flush();
    }
  };
}

export class PluginHost {
  /** 插件增删改订阅者（P1 公开 API） */
  #changeListeners;

  constructor({ log = console.log, deps = {} } = {}) {
    this.log = log;
    this.deps = deps;                 // { store, sender, onebot, getConfig, ... }
    /** @type {Map<string, object>} id -> record */
    this.records = new Map();
    this.hooks = { message: [], poke: [], notice: [], tick: [], prefilter: [] };
    this.routes = [];                 // { id, method, pattern, handler }
    this.toolDefs = [];               // { id, def }
    this.promptSections = [];         // { id, name, fn }
    this.uiTabs = [];                 // { id, label, pluginId, file }
    this.schedulerTimers = new Map(); // key -> timer
    this.#changeListeners = new Set();  // 装卸/重载订阅者（P1 公开 API 用）
    this.kbDeclared = new Map();      // pluginId -> Set(教学工具名)，供按身份过滤
  }

  // ── 发现 ────────────────────────────────────────────────────────────

  /** 扫描 plugins/ 目录，返回已装载记录（含装载失败的，便于面板展示） */
  async loadAll() {
    if (!fs.existsSync(PLUGINS_DIR)) {
      this.log('[plugins] 没有 plugins/ 目录，跳过');
      return [];
    }
    let names = [];
    try {
      names = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch (error) {
      this.log('[plugins] 读目录失败:', error?.message ?? error);
      return [];
    }

    for (const dirName of names) {
      const dir = path.join(PLUGINS_DIR, dirName);
      const manifestFile = path.join(dir, 'manifest.json');
      if (!fs.existsSync(manifestFile)) {
        this.log(`[plugins] 跳过 ${dirName}：没有 manifest.json`);
        continue;
      }
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      } catch (error) {
        this.#fail(dirName, `manifest.json 解析失败：${error?.message ?? error}`);
        continue;
      }
      const norm = normalizeManifest(raw, { dirName });
      if (!norm.ok) {
        this.#fail(dirName, norm.error);
        continue;
      }

      // 🔴 尊重配置里的启用状态（2026-10-21 修）：
      //    此前 loadAll 无条件 enable 所有插件 → 用户在面板停用后，
      //    一重启又全回来了，"停用"形同虚设（做"纯白数据"时暴露）。
      //    判定顺序：config.plugins.<id>.enabled → manifest.defaultEnabled。
      const wanted = this.#isEnabledInConfig(norm.manifest);
      if (!wanted) {
        // 不激活，但仍登记一条记录，面板才能显示"已停用"并可一键启用
        this.records.set(norm.manifest.id, {
          id: norm.manifest.id,
          manifest: norm.manifest,
          status: 'disabled',
          lastError: null,
          handle: null,
          config: createPluginConfig(norm.manifest.id, norm.manifest.config),
          loadedAt: null
        });
        continue;
      }

      await this.enable(norm.manifest);
    }
    this.#sortHooks();
    return this.list();
  }

  /**
   * 从配置判断某插件是否应当启用。
   * 配置里有显式 enabled 就以它为准；没有则回落到 manifest.defaultEnabled。
   */
  #isEnabledInConfig(manifest) {
    try {
      const stored = (this.deps.getConfig?.()?.plugins || {})[manifest.id] || {};
      if (typeof stored.enabled === 'boolean') return stored.enabled;
    } catch { /* 配置读不到 → 用默认值 */ }
    return manifest.defaultEnabled === true;
  }

  #fail(id, error) {
    this.log(`[plugins] ${id} 装载失败：${error}`);
    this.records.set(id, {
      id, manifest: null, status: 'failed', lastError: String(error),
      handle: null, config: null, loadedAt: Date.now()
    });
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  /** 装载并激活单个插件（幂等：已启用则先停） */
  async enable(manifest) {
    const id = manifest.id;
    if (this.records.has(id) && this.records.get(id).status === 'enabled') {
      await this.disable(id);
    }

    const dir = path.join(PLUGINS_DIR, id);
    const entryFile = path.join(dir, manifest.entry);
    if (!fs.existsSync(entryFile)) {
      this.#fail(id, `入口文件不存在：${manifest.entry}`);
      return this.records.get(id);
    }

    // 子注册表：dispose 时按这些清单精确摘除，不误伤其它插件
    const sub = {
      hooks: [], routes: [], tools: [], promptSections: [], timers: [], uiTab: null
    };
    const priv = createPluginConfig(id, manifest.config);
    const state = createStateHandle(id);
    const pluginLog = (...args) => this.log(`[plugin:${id}]`, ...args);

    const ctx = this.#buildCtx(manifest, { priv, state, sub, pluginLog, dir, id });

    let handle = null;
    try {
      const mod = await import(pathToFileURL(entryFile).href + `?v=${Date.now()}`);
      const activate = mod.activate || mod.default;
      if (typeof activate !== 'function') throw new Error('没有导出 activate(ctx) 函数');
      handle = await activate(ctx);
    } catch (error) {
      this.#rollback(sub, id);
      this.#fail(id, `activate 失败：${error?.message ?? error}`);
      return this.records.get(id);
    }

    this.records.set(id, {
      id, manifest, status: 'enabled', lastError: null,
      handle: handle && typeof handle.dispose === 'function' ? handle : null,
      config: priv, loadedAt: Date.now(),
      // 🔴 必须存 sub（2026-10-24 修）
      //
      // disable() 里靠 rec.sub 精确摘除钩子/路由/工具/定时器：
      //   this.#rollback(rec.sub || 空清单, id)
      // 原来这里漏了 sub → 永远拿到空清单 → 停用只改状态，资源全留着。
      //
      // 后果（实测）：面板每点一次「重载」就泄漏一整套定时器，
      // 课程表会同一节课提醒两遍（两个实例各发一次）。
      // 不只课程表 —— 任何插件的钩子都会重复执行。
      sub
    });
    this.#sortHooks();

    // manifest 里声明的 uiTab 自动登记（插件不必重复调 ctx.ui.register）
    if (manifest.uiTab) {
      this.uiTabs.push({
        id: manifest.uiTab.id,
        label: manifest.uiTab.label,
        pluginId: id,
        file: manifest.ui || '',
        dir,
        inline: manifest.uiTab.inline === true   // true = 内嵌在插件页，不占顶栏
      });
    }
    pluginLog('已启用', manifest.version);
    return this.records.get(id);
  }

  /** 停用：调 dispose、摘注册、保留目录（卸载才删文件） */
  async disable(id) {
    const rec = this.records.get(id);
    if (!rec) return { ok: false, error: '没有该插件' };
    if (rec.status === 'enabled') {
      try {
        if (rec.handle?.dispose) await rec.handle.dispose();
      } catch (error) {
        this.log(`[plugins] ${id} dispose 抛错（已忽略）：${error?.message ?? error}`);
      }
      this.#rollback(rec.sub || { hooks: [], routes: [], tools: [], promptSections: [], timers: [] }, id);
    }
    this.uiTabs = this.uiTabs.filter((t) => t.pluginId !== id);
    rec.status = 'disabled';
    rec.handle = null;
    this.log(`[plugins] ${id} 已停用`);
    return { ok: true };
  }

  /** 重新启用（面板用） */
  async reload(id) {
    const rec = this.records.get(id);
    // manifest 可能为空（首次装载就失败、或从未装载过的新插件）——
    // 此时不能直接报错，要回磁盘重读一份再试，否则"修复后重载"永远走不通。
    let manifest = rec?.manifest;
    if (!manifest) {
      manifest = this.#readManifest(id);
      if (!manifest) return { ok: false, error: '没有该插件的 manifest（文件缺失或校验失败）' };
    }
    if (rec) await this.disable(id);
    const again = await this.enable(manifest);
    return { ok: again?.status === 'enabled', status: again?.status, error: again?.lastError };
  }

  /** 从磁盘读并校验单个插件的 manifest。失败返回 null。 */
  #readManifest(id) {
    const dir = path.join(PLUGINS_DIR, id);
    const file = path.join(dir, 'manifest.json');
    if (!fs.existsSync(file)) return null;
    try {
      const norm = normalizeManifest(JSON.parse(fs.readFileSync(file, 'utf8')), { dirName: id });
      return norm.ok ? norm.manifest : null;
    } catch {
      return null;
    }
  }

  /** 精确摘除子注册（按清单，不扫全表） */
  #rollback(sub, id) {
    for (const h of sub.hooks || []) {
      const arr = this.hooks[h.name];
      if (arr) this.hooks[h.name] = arr.filter((x) => x !== h.entry);
    }
    this.routes = this.routes.filter((r) => r.id !== id);
    this.toolDefs = this.toolDefs.filter((t) => t.id !== id);
    this.promptSections = this.promptSections.filter((s) => s.id !== id);
    // 摘掉该插件注册的 skill（否则卸载后模型还能 load 到孤儿技能）
    unregisterPluginSkills(id);
    for (const t of sub.timers || []) clearInterval(t);
    this.uiTabs = this.uiTabs.filter((t) => t.pluginId !== id);
  }

  #sortHooks() {
    for (const name of Object.keys(this.hooks)) {
      this.hooks[name].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    }
  }

  // ── ctx 构造 ────────────────────────────────────────────────────────

  #buildCtx(manifest, { priv, state, sub, pluginLog, dir, id }) {
    const host = this;
    const cfg = priv.get();

    /**
     * 权限守卫：未授权时返回 undefined，并记一条 warn 日志。
     *
     * 为什么不直接 throw：
     *   插件在 activate 阶段可能只是"探测能力是否存在"（if (ctx.sender) ...），
     *   抛错会让它整个起不来。返回 undefined 让插件自己决定怎么退让。
     */
    const permit = (perm, real) => {
      const declared = Array.isArray(manifest.permissions) ? manifest.permissions : [];
      // 没声明该权限 → 老插件，按兼容策略放行（见文件头说明）
      if (!declared.includes(perm)) return real;
      const g = host.deps.grantCheck
        ? host.deps.grantCheck(id, perm)
        : true;   // 宿主没接授权系统时默认放行（向后兼容）
      if (!g) {
        pluginLog(`缺少权限「${perm}」，相关能力不可用。到「插件」页重新授权。`);
        return undefined;
      }
      return real;
    };

    return {
      id,
      version: manifest.version,
      manifest,
      dir,

      log: pluginLog,

      config: {
        get: priv.get,
        set: (patch) => priv.set(patch),
        reset: () => priv.reset()
      },

      // 作用域判定：manifest.defaultEnabled 垫底
      isEnabled: (chatKey) => resolveEnabled(priv.get(), manifest.defaultEnabled, chatKey),

      state: {
        get: (k, d) => state.get(k, d),
        set: (k, v) => state.set(k, v),
        all: () => state.all(),
        clear: () => state.clear(),
        file: state.file
      },

      /**
       * 插件私有数据目录（data/plugins/<id>/）。
       *
       * 提供 **adopt()** 用来把历史遗留的顶层数据文件搬进来：
       * 插件化之前，ad-inject.json / welfare-claims.json 等都写在 data/ 根下。
       * 直接搬家会让老数据"消失"，所以 adopt 是**复制**语义：
       *   老文件存在且新位置没有 → 复制过来（老文件保留，作为回滚保险）
       * 这样"含数据导出"才真的导得出东西，且老数据不丢。
       */
      data: (() => {
        const dir = pluginStateDir(id);
        return {
          dir,
          file: (name) => path.join(dir, name),
          ensure: () => { fs.mkdirSync(dir, { recursive: true }); return dir; },
          adopt(legacyRelativeName) {
            const legacy = path.join(DATA_DIR, legacyRelativeName);
            const target = path.join(dir, path.basename(legacyRelativeName));
            try {
              if (fs.existsSync(legacy) && !fs.existsSync(target)) {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.copyFileSync(legacy, target);
                pluginLog(`已接管历史数据 ${legacyRelativeName} → data/plugins/${id}/`);
                return true;
              }
            } catch (error) {
              pluginLog('接管历史数据失败（继续用旧路径）:', error?.message ?? error);
            }
            return false;
          }
        };
      })(),

      // ── 权限裁剪（2026-10-25，见 docs/PLUGIN_PROTOCOL.md 第三节）──
      //
      // 三关：声明 → 授权 → 强制。这里是第 ③ 关。
      //
      // 未授权时**不把该能力挂上去**，插件调用会得到 undefined 而不是
      // 一个"看似能用但偷偷失败"的假对象 —— 后者最难调试。
      // 需要明确报错的场合，用一个会抛函数替代（见 guarded）。
      //
      // 🔴 兼容策略：本机老插件没有授权记录时，**默认放行全部声明权限**。
      //    原因：它们已经跑了很久，突然全部失效是灾难。
      //    只对"新安装"走确认流程。这个妥协写在 plugin-grants.js 文件头。
      store: this.deps.store,
      sender: permit('send', this.deps.sender),
      onebot: permit('send', this.deps.onebot),
      // 表情库：sticker 插件要读它；对它做增删的能力只在这里暴露只读面 + 必要写方法
      stickers: this.deps.stickers,
      // 记忆库：memory 插件要读写它；prompt.js 也会直接读（属于内核共享数据）
      memory: this.deps.memory,
      log2: this.deps.log,
      chatCompletion: permit('llm', this.deps.chatCompletion),

      // ── 邮件（内核基础设施，2026-10-25）──
      //
      // 🔴 发信能力**必须在内核**，不能随插件分发。
      //    插件包是公开的，把 send_mail.py 放进去等于把整套发信实现公开。
      //    这里只暴露一个 sendMail 函数，插件看不到 SMTP 细节和凭据。
      mail: {
        ready: () => !!(host.deps.mailReady && host.deps.mailReady()),
        send: (to, subject, body) => host.deps.sendMail
          ? host.deps.sendMail(to, subject, body)
          : Promise.resolve({ ok: false, error: '内核未提供邮件能力' }),
      },
      // orchestrator 用于"主动唤醒"类能力（课程播报、定时提醒到点启动一次运行）。
      // 用 getter 是为了避开构造期循环依赖（宿主先建，orchestrator 后建再回填）。
      get orchestrator() { return host.deps.orchestrator; },
      root: ROOT,
      dataDir: DATA_DIR,

      // ── P3：统一路径（2026-10-24）──
      //
      // 插件原来靠 path.resolve(HERE, '../..') 推路径 ——
      // 装到别的布局就全错，数据甚至可能写到不该写的地方。
      // 这里由内核给准，插件不用再猜。
      paths: {
        root: ROOT,
        plugins: PLUGINS_DIR,
        data: DATA_DIR,
        get pluginData() { return pluginStateDir(id); },
        /** 插件私有文件路径（等价于 ctx.data.file） */
        store: (name) => path.join(pluginStateDir(id), String(name || ''))
      },

      // ── P2：manifest 归一化（2026-10-24）──
      //
      // 原来插件要 import '../../src/core/manifest.js' 自己归一化 ——
      // 相对路径写死，换布局就 ERR_MODULE_NOT_FOUND。
      // 现在内核直接给函数，插件不用碰内核源码。
      normalizeManifest: (raw, opts = {}) => {
        const r = normalizeManifest(raw, { dirName: opts.dirName || id });
        return r.ok
          ? { ok: true, manifest: r.manifest }
          : { ok: false, error: r.error || 'manifest 校验失败' };
      },

      // ── P6：能力探测（2026-10-24）──
      //
      // 插件原来读内核源码文本找关键字（kernelHas('hideCard')）——
      // 内核改个注释就误判。改成声明式：内核说自己有什么，插件照着判断。
      capabilities: {
        apiVersion: PLUGIN_API_VERSION,
        inlinePanel: true,      // uiTab.inline 生效
        hotLoad: true,          // enableFromDir 热装载
        pluginHostApi: true,    // ctx.pluginHost 公开
        pathsApi: true,         // ctx.paths
        normalizeApi: true,     // ctx.normalizeManifest
        kernelUpgrade: false,   // 内核不做整包自升级（有意为之，见需求文档 P4）
        onChange: true,
        hooks: [...HOOK_NAMES]
      },

      // ── P1：插件宿主公开 API（2026-10-24）──
      //
      // 市场类插件需要"装/卸/查"，但原来只能摸 host.records（内部 Map）。
      // 这里给稳定契约，内核内部随便改都不影响插件。
      pluginHost: {
        list: () => host.listInstalled(),
        enableFromDir: (dir) => host.enableFromDir(dir),
        disable: (targetId) => host.disable(targetId),
        reload: (targetId) => host.reload(targetId),
        onChange: (cb) => host.onChange(cb)
      },

      hooks: {
        on(name, fn) {
          if (!host.hooks[name]) throw new Error(`未知钩子 ${name}`);
          const entry = { id, priority: manifest.priority ?? 100, fn };
          host.hooks[name].push(entry);
          sub.hooks.push({ name, entry });
          return () => {
            host.hooks[name] = host.hooks[name].filter((x) => x !== entry);
          };
        }
      },

      http: {
        /**
         * 注册 HTTP 路由。
         * @param {string} method GET/POST/...
         * @param {string} routePath 以 / 开头
         * @param {Function} handler (req, body, url) => object|undefined
         * @param {object} [opts]
         * @param {boolean} [opts.absolute] true = 用原样路径注册（如 /api/anti-ad）。
         *   保留给「历史上已有前端调用」的端点——插件化只想换实现，不想连带改前端。
         *   默认 false = 挂到 /api/plugins/<id><path> 下，避免插件之间抢路径。
         * @param {boolean} [opts.raw] true = 自行处理响应（流 / 文件 / 状态码），内核不包装
         */
        route(method, routePath, handler, opts = {}) {
          const m = String(method || 'GET').toUpperCase();
          const raw = routePath.startsWith('/') ? routePath : `/${routePath}`;
          const p = opts.absolute ? raw : `/api/plugins/${id}${raw}`;
          const entry = { id, method: m, path: p, handler, pluginId: id, raw: opts.raw === true };
          // 同一路径重复注册 = 插件之间抢端点，必须显式报出来，不能静默覆盖
          const clash = host.routes.find((r) => r.path === p && r.method === m);
          if (clash) {
            pluginLog(`路由冲突：${m} ${p} 已被插件 ${clash.id} 注册，本次注册被忽略`);
            return () => {};
          }
          host.routes.push(entry);
          sub.routes.push(p);
          return () => {
            host.routes = host.routes.filter((r) => r !== entry);
          };
        }
      },

      tools: {
        register(def) {
          if (!def?.name) throw new Error('工具缺少 name');
          if (typeof def.execute !== 'function') throw new Error(`工具 ${def.name} 缺少 execute`);
          host.toolDefs.push({ id, def });
          sub.tools.push(def.name);
          return () => {
            host.toolDefs = host.toolDefs.filter((t) => !(t.id === id && t.def.name === def.name));
          };
        }
      },

      promptSections: {
        register(name, fn) {
          if (typeof fn !== 'function') throw new Error('promptSection 必须是函数');
          host.promptSections.push({ id, name, fn });
          sub.promptSections.push(name);
          return () => {
            host.promptSections = host.promptSections.filter((s) => !(s.id === id && s.name === name));
          };
        }
      },

      // ── Skill 注册（2026-10-21）──
      //
      // 插件自带的知识块。与 promptSections 的区别：
      //   promptSections → **每轮都拼进提示词**（常驻，吃 token）
      //   skill          → 只在【技能库】里留一行索引，模型按需 load_skill 取正文
      //
      // 插件卸载时自动摘除，不会留下"孤儿 skill"。
      skill: {
        register(def) {
          if (!def?.id) throw new Error('skill 需要 id');
          if (!def.body && !def.file) throw new Error(`skill ${def.id} 需要 body 或 file`);
          registerPluginSkill(id, def);
          return () => unregisterPluginSkills(id);
        }
      },

      ui: {
        /** 等价于 manifest.uiTab，供动态场景使用 */
        register(tab) {
          if (!tab?.id || !tab?.label) throw new Error('ui.register 需要 id 与 label');
          host.uiTabs.push({ id: tab.id, label: tab.label, pluginId: id, file: tab.file || manifest.ui || '', dir });
          sub.uiTab = tab.id;
        }
      },

      scheduler: {
        every(ms, fn) {
          const t = setInterval(() => {
            try { fn(); } catch (error) { pluginLog('定时回调出错:', error?.message ?? error); }
          }, Math.max(1000, Number(ms) || 60000));
          if (typeof t.unref === 'function') t.unref();
          sub.timers.push(t);
          return () => clearInterval(t);
        }
      },

      // 声明"这些工具属于教学工具，非学习身份时应当隐藏"
      declareKbTools(names) {
        host.kbDeclared.set(id, new Set(names || []));
        return () => host.kbDeclared.delete(id);
      },

      // 本轮消息共享标志位（由 dispatch 每轮新建并注入）
      chain: null,

      // 事件总线（插件可自行 emit，面板可订阅）
      emit: this.deps.emit || (() => {})
    };
  }

  // ── 分发 ────────────────────────────────────────────────────────────

  /**
   * 跑消息链。
   * @returns {{handled:boolean, by:string|null, flags:Set<string>}}
   */
  async dispatchMessage(msg) {
    const flags = new Set();
    const chain = {
      flags,
      has: (f) => flags.has(f),
      add: (f) => { flags.add(f); return chain; }
    };
    const list = this.hooks.message;
    for (const entry of list) {
      const rec = this.records.get(entry.id);
      if (!rec || rec.status !== 'enabled') continue;
      // 内核层先做作用域过滤，插件无需自己判
      try {
        const dflt = rec.manifest?.defaultEnabled === true;
        if (!resolveEnabled(rec.config.get(), dflt, msg.chatKey)) continue;
      } catch { /* 配置读取异常视为启用，宁跑不漏 */ }

      try {
        const fn = entry.fn;
        const out = await fn(msg, { chain, pluginId: entry.id });
        if (out && out.handled === true) return { handled: true, by: entry.id, flags };
        if (out && Array.isArray(out.flags)) for (const f of out.flags) flags.add(f);
      } catch (error) {
        this.log(`[plugin:${entry.id}] message 钩子出错（已隔离）：${error?.message ?? error}`);
      }
    }
    return { handled: false, by: null, flags };
  }

  /**
   * 入库前过滤（黑名单等）。
   *
   * 为什么单独一条链：message 钩子在**消息入库之后**跑，
   * 而"彻底忽略某人"要求消息连存档都不进 —— 否则控制台还能翻到他的话，
   * 等于没屏蔽。所以给内核一个入库前的拦截点。
   *
   * 返回 { drop: true } 表示丢弃这条消息（不入库、不触发 LLM）。
   * 任何一个插件抛出 drop 即生效；抛错视为不拦截（宁可放过，不可误杀）。
   */
  async dispatchPrefilter(msg) {
    for (const entry of this.hooks.prefilter) {
      const rec = this.records.get(entry.id);
      if (!rec || rec.status !== 'enabled') continue;
      try {
        if (!resolveEnabled(rec.config.get(), rec.manifest?.defaultEnabled === true, msg.chatKey)) continue;
      } catch { /* 配置异常 → 照常检查 */ }
      try {
        const out = await entry.fn(msg, { pluginId: entry.id });
        if (out && out.drop === true) return { drop: true, by: entry.id, reason: out.reason || '' };
      } catch (error) {
        this.log(`[plugin:${entry.id}] prefilter 出错（已隔离，放行）：${error?.message ?? error}`);
      }
    }
    return { drop: false, by: null, reason: '' };
  }

  /** 通用钩子分发（poke / notice / tick） */
  async dispatch(name, payload) {
    for (const entry of this.hooks[name] || []) {
      const rec = this.records.get(entry.id);
      if (!rec || rec.status !== 'enabled') continue;
      try {
        await entry.fn(payload, { pluginId: entry.id });
      } catch (error) {
        this.log(`[plugin:${entry.id}] ${name} 钩子出错（已隔离）：${error?.message ?? error}`);
      }
    }
  }

  // ── 对外查询 ────────────────────────────────────────────────────────

  /** 面板列表用 */
  // ── 公开插件管理 API（2026-10-24 · P1）──────────────────────
  //
  // 为什么要有这一层：插件市场（以及其他管理类插件）需要"装/卸/查"，
  // 但原来只能直接摸 this.records（内部 Map）和 this.enable（要求调用方
  // 自己先归一化 manifest）。内核一重构就崩，而且逼着插件抄内核的活。
  //
  // 这里给出的都是**稳定契约**：签名和语义保证不变，内部实现随便改。
  // 全部失败返回 { ok:false, error }，不抛异常 —— 让调用方好处理。

  /** 已装插件清单（市场用来判断"装没装/什么版本"） */
  listInstalled() {
    return [...this.records.values()].map((r) => ({
      id: r.id,
      name: r.manifest?.name || r.id,
      version: r.manifest?.version || '?',
      status: r.status,
      dir: path.join(PLUGINS_DIR, r.id),
      lastError: r.lastError || null
    }));
  }

  /**
   * 按目录装载：内核自己读 manifest、归一化、校验、enable。
   *
   * 与 enable(rawManifest) 的区别：调用方不需要懂 manifest 格式，
   * 也不用自己归一化。传个目录路径就行。
   */
  async enableFromDir(dir) {
    try {
      const abs = path.resolve(String(dir || ''));
      if (!fs.existsSync(path.join(abs, 'manifest.json'))) {
        return { ok: false, error: '目录里没有 manifest.json' };
      }
      const dirName = path.basename(abs);
      const raw = JSON.parse(fs.readFileSync(path.join(abs, 'manifest.json'), 'utf8'));
      const norm = normalizeManifest(raw, { dirName });
      if (!norm.ok) return { ok: false, error: norm.error || 'manifest 校验失败' };

      // 🔴 目录必须在 plugins/ 下 —— 内核只从那里装载
      const expect = path.join(PLUGINS_DIR, norm.manifest.id);
      if (path.resolve(abs) !== path.resolve(expect)) {
        return { ok: false, error: `插件目录必须是 ${expect}，实际是 ${abs}` };
      }

      const rec = await this.enable(norm.manifest);
      if (!rec || rec.status !== 'enabled') {
        return { ok: false, id: norm.manifest.id, error: rec?.lastError || '装载失败' };
      }
      this.#emitChange('add', norm.manifest.id);
      return { ok: true, id: norm.manifest.id, version: norm.manifest.version };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** 装卸/重载后通知订阅者（市场列表要跟着刷新） */
  onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    this.#changeListeners.add(cb);
    return () => this.#changeListeners.delete(cb);
  }
  #emitChange(type, id) {
    for (const cb of this.#changeListeners) {
      try { cb({ type, id }); } catch (e) { this.log('[plugins] onChange 回调出错:', e?.message ?? e); }
    }
  }

  list() {
    return [...this.records.values()]
      .map((r) => ({
        id: r.id,
        name: r.manifest?.name || r.id,
        version: r.manifest?.version || '?',
        status: r.status,
        description: r.manifest?.description || '',
        author: r.manifest?.author || '',       // 作者（面板展示用）
        category: r.manifest?.category || '其他',
        summary: r.manifest?.summary || '',
        lastError: r.lastError,
        priority: r.manifest?.priority ?? 100,
        ui: r.manifest?.ui || '',            // 插件前端入口（plugins/<id>/<ui>）
        defaultEnabled: r.manifest?.defaultEnabled ?? false,
        hooks: r.manifest?.hooks || [],
        tools: (this.toolDefs.filter((t) => t.id === r.id).map((t) => t.def.name)),
        uiTab: r.manifest?.uiTab || null,
        uiTabInline: r.manifest?.uiTab?.inline === true,
        config: r.config ? r.config.get() : null,
        loadedAt: r.loadedAt || null
      }))
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  /** 全部插件注册的工具（供 orchestrator 合并） */
  allToolDefs() {
    return this.toolDefs.map((t) => t.def);
  }

  /**
   * 教学工具名单（供 orchestrator 按身份过滤）。
   * study 插件 activate 时可调用 ctx.declareKbTools([...]) 声明自己的教学工具名。
   * 插件未装 = 空集 = 该过滤不生效（也不会误暴露，因为工具本身就不存在）。
   */
  kbToolNames() {
    const out = new Set();
    for (const names of this.kbDeclared.values()) for (const n of names) out.add(n);
    return out;
  }

  /** 全部插件提示词段（按插件 priority 排序，结果拼进系统提示） */
  buildPromptBlocks(info) {
    const out = [];
    const owner = new Map();
    for (const t of this.toolDefs) owner.set(t.id, this.records.get(t.id)?.manifest?.priority ?? 100);
    const sorted = [...this.promptSections].sort(
      (a, b) => (owner.get(a.id) ?? 100) - (owner.get(b.id) ?? 100)
    );
    for (const s of sorted) {
      const rec = this.records.get(s.id);
      if (!rec || rec.status !== 'enabled') continue;
      try {
        const text = s.fn(info);
        if (text) out.push(String(text));
      } catch (error) {
        this.log(`[plugin:${s.id}] 提示词段 ${s.name} 出错（已隔离）：${error?.message ?? error}`);
      }
    }
    return out;
  }

  /** 静态校验：内核版本等元信息 */
  static get apiVersion() { return PLUGIN_API_VERSION; }
}
