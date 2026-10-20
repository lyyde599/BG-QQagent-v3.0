// ── 插件内核 · 配置命名空间 ───────────────────────────────────────────────
//
// 插件配置存放在 config.plugins.<id>，与全局配置物理隔离：
//   ① 插件卸载后残留一段死配置，不会影响其它插件；
//   ② 插件写配置只能写自己那一段，改不坏 api/allow/persona 这些核心项。
// 这是「卸载不影响基础功能」的第一道保证。
//
// ⚠️ 为什么不复用全局 updateConfig 的深合并（2026-10-20 实测教训）：
//   全局 deepMerge 对对象型配置是**递归合并**——传 `{}` 清不掉旧键，
//   传 `{a:1}` 也删不掉别的键。这在"全局配置打补丁"场景是对的，
//   但插件配置需要**用户能清空一个对象**（作用域覆盖表、广告列表）。
//   用深合并兜圈子会陷入"墓碑 / 复活 / 永远删不掉"的拉锯（本次实测反复三轮）。
//   结论：插件配置统一用**浅层键值替换**——每个键整体覆盖，语义直观、行为可预期。
//   需要合并的插件自己 merge 后整体写入即可（多一行代码，换一整类 bug 消失）。
import { getConfig, replacePluginsConfig } from '../config.js';

/** 深合并：只用于「默认值垫底 + 存盘值覆盖」的读取场景。数组与对象整体替换。 */
function mergeDefaults(base, patch) {
  if (patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (typeof base !== 'object' || base === null || typeof patch !== 'object' || patch === null) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = mergeDefaults(base?.[k], v);
  return out;
}

/**
 * 为单个插件创建配置句柄。
 * @param {string} id 插件 id
 * @param {object} defaults manifest.config（默认值，只读垫底）
 */
export function createPluginConfig(id, defaults) {
  /** 存盘段落原样（不含默认值） */
  const stored = () => (getConfig().plugins || {})[id] || {};

  /** 有效配置 = 默认值垫底 + 存盘值逐键替换 */
  const read = () => {
    const out = mergeDefaults(structuredClone(defaults || {}), stored());
    delete out._deleted;
    return out;
  };

  return {
    get: read,

    /**
     * 浅层键值替换。
     *  · `patch[k] = 值` → 该键**整体**替换（不做深度合并）
     *  · `patch[k] = null` → 删除该键（回落到默认值）
     *
     * @param {object} patch
     */
    set(patch) {
      const all = { ...(getConfig().plugins || {}) };
      const cur = { ...stored() };
      // 上一版遗留的墓碑元数据直接丢弃（现在不再需要墓碑机制）
      delete cur._deleted;
      for (const [k, v] of Object.entries(patch || {})) {
        if (v === null) delete cur[k];
        else cur[k] = structuredClone(v);
      }
      all[id] = cur;
      // 必须整段替换：updateConfig 的深合并删不掉键（见 config.js 注释）
      replacePluginsConfig(all);
      return read();
    },

    /** 清空该插件的全部用户配置（回到 manifest 默认值） */
    reset() {
      const all = { ...(getConfig().plugins || {}) };
      delete all[id];
      replacePluginsConfig(all);
      return read();
    }
  };
}

/**
 * 作用域判定：全局默认 + 按会话覆盖。
 *
 * 顺序：scopes[chatKey] → enabled → manifest.defaultEnabled
 * 为什么 chatKey 优先：用户对单个群的显式设置，语义上强于全局开关。
 *
 * @param {object} priv 插件配置（含 enabled / scopes）
 * @param {boolean} dflt manifest.defaultEnabled
 * @param {string} chatKey 形如 group:123 / private:456
 */
export function resolveEnabled(priv, dflt, chatKey) {
  const scopes = priv?.scopes;
  if (chatKey && scopes && typeof scopes === 'object'
      && Object.prototype.hasOwnProperty.call(scopes, chatKey)) {
    return scopes[chatKey] === true;
  }
  if (typeof priv?.enabled === 'boolean') return priv.enabled;
  return dflt === true;
}
