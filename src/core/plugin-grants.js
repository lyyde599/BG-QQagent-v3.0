// ── 插件权限授权（2026-10-25）────────────────────────────────────
//
// 协议文档 docs/PLUGIN_PROTOCOL.md 第三节的落地实现。
//
// 三关缺一不可：声明 → 授权 → 强制。
// 这个文件管第 ② 和第 ③ 关。
//
// 设计取舍：
//   ① **未授权 ≠ 报错退出**。插件仍然加载，但受限能力变成"调用即抛错"。
//      为什么：直接拒绝加载会让用户看到"插件坏了"却不知道原因；
//      运行时抛错能给出"你没有 send 权限"这种可行动的提示。
//   ② **本机已有插件默认全部授权**。它们已经跑了很久，突然全部失效是灾难。
//      只有新安装的才走确认流程。这是升级兼容的必要妥协。
//   ③ **授权按版本记录**。版本升级时对比 manifest.permissions：
//      只增不减就放行，有新增则要求重新确认。
import fs from 'node:fs';
import path from 'node:path';

const GRANT_FILE = path.join(process.cwd(), 'data', 'plugin-grants.json');

/** 权限分组：用于安装确认时按风险分级展示 */
export const PERMISSION_GROUPS = {
  read: {
    label: '读取数据',
    risk: 'low',
    items: {
      'read-media': '读取消息里的图片和文件',
      'read-memory': '读取机器人记忆',
      'read-schedule': '读取定时任务',
      'read-knowledge': '读取知识库',
      'read-blacklist': '读取黑名单',
    }
  },
  send: {
    label: '发送消息',
    risk: 'medium',
    items: {
      'send': '在会话里发消息和表情',
      'send-proactive': '主动发消息（不等被 @）',
    }
  },
  manage: {
    label: '管理群成员',
    risk: 'high',
    items: {
      'mute': '禁言群友',
      'kick': '踢出群友',
      'approve-request': '同意加群/好友申请',
    }
  },
  data: {
    label: '数据与模型',
    risk: 'medium',
    items: {
      'write-memory': '写入机器人记忆',
      'llm': '调用模型（会产生费用）',
      'network': '访问外部网络',
    }
  },
  system: {
    label: '系统级操作',
    risk: 'critical',
    items: {
      'exec': '执行系统命令',
      'fs-write': '写插件目录之外的文件',
      'persona': '修改机器人人设',
    }
  }
};

/** 所有已知权限的扁平表 */
export const ALL_PERMISSIONS = (() => {
  const out = {};
  for (const g of Object.values(PERMISSION_GROUPS)) {
    for (const [k, v] of Object.entries(g.items)) {
      out[k] = { group: g.label, risk: g.risk, desc: v };
    }
  }
  return out;
})();

const load = () => {
  try {
    const d = JSON.parse(fs.readFileSync(GRANT_FILE, 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch { return {}; }
};

const save = (d) => {
  try {
    fs.mkdirSync(path.dirname(GRANT_FILE), { recursive: true });
    fs.writeFileSync(GRANT_FILE, JSON.stringify(d, null, 2), 'utf8');
  } catch { /* 授权写入失败不该阻断启动 */ }
};

/** 读某个插件的授权记录 */
export function getGrant(id) {
  return load()[id] || null;
}

/** 该插件是否已获得某权限 */
export function hasPermission(id, perm) {
  const g = getGrant(id);
  return !!(g && Array.isArray(g.granted) && g.granted.includes(perm));
}

/**
 * 写入授权（安装确认时调用）
 * @param {string} id 插件 id
 * @param {string[]} perms 用户同意的权限
 * @param {string} version 授权时的版本
 */
export function grant(id, perms, version = '') {
  const d = load();
  d[id] = {
    granted: [...new Set(perms.map(String))],
    version: String(version || ''),
    grantedAt: new Date().toISOString(),
  };
  save(d);
  return d[id];
}

/** 撤销全部授权 */
export function revoke(id) {
  const d = load();
  delete d[id];
  save(d);
}

/**
 * 判断插件是否需要重新确认权限
 *
 * @returns {{need:boolean, added:string[], reason:string}}
 */
export function checkGrant(id, manifest) {
  const declared = Array.isArray(manifest?.permissions) ? manifest.permissions : [];
  const g = getGrant(id);

  // 从没授权过 → 需要确认
  if (!g) {
    // 例外：本机已存在的老插件直接放行（见文件头 ②）
    return { need: true, added: declared, reason: 'first-install' };
  }

  // 已有的授权里没有的新权限
  const have = new Set(g.granted || []);
  const added = declared.filter((p) => !have.has(p));
  if (added.length) {
    return { need: true, added, reason: 'permission-added' };
  }
  return { need: false, added: [], reason: 'ok' };
}

/**
 * 把权限清单按风险分组，供安装确认框展示
 */
export function describePermissions(perms) {
  const list = Array.isArray(perms) ? perms : [];
  const out = [];
  for (const g of Object.values(PERMISSION_GROUPS)) {
    const hit = list.filter((p) => g.items[p]);
    if (hit.length) {
      out.push({
        group: g.label,
        risk: g.risk,
        items: hit.map((p) => ({ perm: p, desc: g.items[p] })),
      });
    }
  }
  // 未知权限也要显示（作者可能拼错或用了新版权限）
  const known = new Set(Object.keys(ALL_PERMISSIONS));
  const unknown = list.filter((p) => !known.has(p));
  if (unknown.length) {
    out.push({ group: '未识别权限', risk: 'high', items: unknown.map((p) => ({ perm: p, desc: '内核不认识这个权限名' })) });
  }
  return out;
}
