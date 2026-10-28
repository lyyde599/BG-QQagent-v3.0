// NapCat × QQ 客户端 兼容表（2026-10-28）
//
// 要解决的问题：
//   群友按提示装了「最新 NapCat 4.18.41 + 最新 QQ 3.2.18」，
//   结果 DSH 报版本不兼容。
//
// 根因：**这两个东西不是独立升级的**。
//   NapCat 是注入到 QQ 客户端里的，它依赖 QQ 的内部结构；
//   QQ 一升级，NapCat 的注入点可能就变了。
//   所以"各自升到最新"恰恰是最容易出问题的组合。
//
// 做法：维护一份**已验证组合表**。
//   · 表里的组合 = 有人真机跑过、明确能用的
//   · 优先推荐表内的组合，而不是各自的最新版
//   · 表里没有时，退回"最新+最新"但明确标注"未验证"
//
// ⚠️ 为什么不自动爬取官方兼容矩阵：
//   NapCat 官方只给 Shell 安装说明，没有结构化的版本兼容 API。
//   硬爬页面来推规则既不可靠也不可维护 —— 不如老老实实记录实测结果。

/**
 * 已验证组合。
 *
 * verifiedAt  实测日期
 * note        谁在什么场景下验的
 * source      验证来源（本机 / 群友反馈 / 官方 issue）
 */
export const VERIFIED_PAIRS = [
  {
    napcat: '4.18.41',
    qq: '3.2.33-52892',
    qqPrefix: '3.2.33',          // 用于宽松匹配（QQ 版本常带 build 号）
    verifiedAt: '2026-10-28',
    note: '本机生产环境运行中，OneBot 连接正常',
    source: 'local'
  },
  {
    napcat: '4.18.19',
    qq: '3.2.19',
    qqPrefix: '3.2.19',
    verifiedAt: '2026-09-14',
    note: '历史备份版本，曾长期稳定运行',
    source: 'local-backup'
  }
];

/** 取 QQ 版本的主段（3.2.33-52892 → 3.2.33） */
export function qqMajor(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d+\.\d+\.\d+)/);
  return m ? m[1] : s;
}

/**
 * 找与给定 NapCat 版本配套的 QQ 版本。
 * @returns {{ qq:string, pair:object }|null}
 */
export function qqForNapcat(napcatVer) {
  const v = String(napcatVer || '').trim();
  const hit = VERIFIED_PAIRS.find((p) => p.napcat === v);
  return hit ? { qq: hit.qq, pair: hit } : null;
}

/**
 * 找与给定 QQ 版本配套的 NapCat 版本。
 * @returns {{ napcat:string, pair:object }|null}
 */
export function napcatForQQ(qqVer) {
  const major = qqMajor(qqVer);
  const hit = VERIFIED_PAIRS.find((p) => p.qqPrefix === major || p.qq === qqVer);
  return hit ? { napcat: hit.napcat, pair: hit } : null;
}

/**
 * 判断一个组合是否被验证过。
 * @returns {{ verified:boolean, expected?:object, hint?:string }}
 */
export function checkPair(napcatVer, qqVer) {
  const nv = String(napcatVer || '').trim();
  const qv = qqMajor(qqVer);

  const hit = VERIFIED_PAIRS.find((p) => p.napcat === nv && p.qqPrefix === qv);
  if (hit) return { verified: true, expected: hit };

  // 未命中：分别看两边应该配什么
  const needQq = qqForNapcat(nv);
  const needNc = napcatForQQ(qv);

  let hint = '这个组合没被验证过。';
  if (needQq && needQq.qq !== qqVer) {
    hint = `NapCat ${nv} 应该配 QQ ${needQq.qq}，不是 ${qqVer}。`;
  } else if (needNc && needNc.napcat !== nv) {
    hint = `QQ ${qv} 应该配 NapCat ${needNc.napcat}，不是 ${nv}。`;
  } else {
    hint = '两个版本都不在已验证列表里，可能都能用，也可能都不行。';
  }

  return { verified: false, expected: needQq?.pair || needNc?.pair || null, hint };
}

/**
 * 给出"该装什么"的建议。
 *
 * 关键立场：**优先推荐已验证组合，而不是各自的最新版**。
 * 群友要的是"能跑"，不是"最新"。
 */
export function recommend({ napcatLatest, qqLatest, napcatLocal, qqLocal } = {}) {
  // ① 本机已经是一个验证过的组合 → 别动它
  if (napcatLocal && qqLocal) {
    const cur = checkPair(napcatLocal, qqLocal);
    if (cur.verified) {
      return {
        action: 'keep',
        napcat: napcatLocal,
        qq: qqLocal,
        reason: '当前组合已验证可用，不建议改动。',
        pair: cur.expected
      };
    }
  }

  // ② 推荐表里最新的那一对
  const best = VERIFIED_PAIRS[0];
  return {
    action: 'install',
    napcat: best.napcat,
    qq: best.qq,
    reason: `推荐装已验证组合：NapCat ${best.napcat} + QQ ${best.qq}（${best.note}）`,
    pair: best,
    // 提醒用户：不要各自追最新
    warning: (napcatLatest && napcatLatest !== best.napcat) || (qqLatest && qqMajor(qqLatest) !== best.qqPrefix)
      ? `注意：最新版是 NapCat ${napcatLatest || '?'} / QQ ${qqLatest || '?'}，但它们没被验证过配套，不建议直接上。`
      : ''
  };
}
