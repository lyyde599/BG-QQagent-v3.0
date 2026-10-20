// ── 插件内核 · 配置向后兼容层 ────────────────────────────────────────────
//
// 背景：插件化之前，antiAd / adInject / welfare 等配置直接放在 config.json 顶层，
// 前端大量代码读的是 `cfg.adInject`、`cfg.welfare`。插件化后权威位置变成
// config.plugins.<id>，但**不该为此改整个前端**（改动面大、回归成本高）。
//
// 做法：内核在 GET/POST /api/config 时做一层"视图映射"：
//   · 读：config.plugins.<id> 同时以旧键名（adInject 等）暴露一份镜像
//   · 写：前端提交的旧键名自动落到 plugins.<id>，不污染顶层
//
// 这就是迁移期的软着陆：前端一行不改，配置存储已经插件化。
// 将来前端全部改用 cfg.plugins.<id> 后，本层可以删掉。
import { getConfig } from '../config.js';

/** 旧顶层键 → 插件 id。新增插件若历史上占过顶层键，在此登记即可。 */
export const LEGACY_CONFIG_KEYS = {
  antiAd: 'anti-ad',
  adInject: 'ad-inject',
  welfare: 'welfare',
  // 群管理（迎新/自动同意）也是插件能力，但它的配置历史上就在顶层 groupManager 键上，
  // 前端设置页读的也是这个键 —— 同样走兼容映射，保存才能落到插件命名空间。
  groupManager: 'group-manager'
};

/**
 * 把插件配置投影成旧顶层键，供前端读取。
 * @param {object} cfg 原始配置
 * @returns {object} 附加了旧键的副本（不修改原对象）
 */
export function projectLegacyConfig(cfg) {
  const plugins = cfg.plugins || {};
  const out = { ...cfg };
  for (const [legacyKey, pluginId] of Object.entries(LEGACY_CONFIG_KEYS)) {
    const priv = plugins[pluginId];
    if (priv && typeof priv === 'object') out[legacyKey] = priv;
  }
  return out;
}

/**
 * 把前端提交的旧键翻译成 plugins.<id>，其余字段原样透传。
 * @param {object} patch 前端提交的配置补丁
 * @returns {{core: object, plugins: object}}
 */
export function splitLegacyPatch(patch) {
  const core = {};
  const plugins = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const pluginId = LEGACY_CONFIG_KEYS[k];
    if (pluginId) {
      // 旧键写进来 → 落到插件命名空间
      const cur = (getConfig().plugins || {})[pluginId] || {};
      plugins[pluginId] = { ...cur, ...(v && typeof v === 'object' ? v : {}) };
    } else if (k === 'plugins') {
      // 直接传 plugins 也支持（新版前端用）
      for (const [pid, pv] of Object.entries(v || {})) {
        const cur = (getConfig().plugins || {})[pid] || {};
        plugins[pid] = { ...cur, ...(pv && typeof pv === 'object' ? pv : {}) };
      }
    } else {
      core[k] = v;
    }
  }
  return { core, plugins };
}
