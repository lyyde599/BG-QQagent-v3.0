// ── 圣杯战争 · 规则引擎（纯函数，可单测）──────────────────────────
//
// 这里不碰网络、不碰文件、不碰 LLM。输入数字，输出数字。
// 为什么这样：结算一旦算错，一整局就废了。纯函数才能写单测锁死。

// ── 六参数 → 指数 ───────────────────────────────────────────────
// 系数来自内容库 §0.1，**非线性**：B+ = 55 比 A = 50 还高
export const RANK_VALUE = {
  E: 10, D: 20, C: 30, B: 40, 'B+': 55,
  A: 50, 'A+': 60, 'A++': 70, EX: 80,
};
const WEIGHT = { str: 0.9, end: 0.8, agi: 0.7, mag: 0.8, luck: 0.5, np: 1.4 };

/** 战力指数（用于档位校验） */
export function powerIndex(stats) {
  let sum = 0;
  for (const [k, w] of Object.entries(WEIGHT)) {
    const v = RANK_VALUE[stats[k]];
    if (v === undefined) continue;      // 无等级（如宝具"—"）按 0 计
    sum += v * w;
  }
  return Math.round(sum * 10) / 10;
}

/**
 * 档位（按内容库 §2.6 的区间）
 *
 * ⚠️ 这是**纯指数推算**，用于校验新数据。
 * 已有从者以 `servant.tier` 字段为准——因为内容库允许"机制破格"：
 * 指数不够但机制极强的从者可以保留在原档（如山之翁 187→T1、ChatGPT娘 203→T1）。
 * 所以读档时**不要用 tierOf 覆盖已标注的 tier**。
 */
export function tierOf(index) {
  if (index >= 205) return 'T1';
  if (index >= 160) return 'T2';
  return 'T3';
}

// ── 职阶克制（FGO 式，单向 1.3；Berserker 双向 1.25）──────────────
const COUNTER = {
  Saber: 'Lancer',
  Archer: 'Saber',
  Lancer: 'Archer',
  Rider: 'Caster',
  Caster: 'Assassin',
  Assassin: 'Rider',
};

/**
 * 职阶倍率。
 * 注意：**被克是 1.0，不是 0.67**——FGO 只有优势没有劣势。
 * 唯一的例外是 Berserker：打人 1.25，被打也 1.25。
 */
export function classMultiplier(attacker, defender) {
  if (attacker === 'Berserker' || defender === 'Berserker') return 1.25;
  if (COUNTER[attacker] === defender) return 1.3;
  return 1.0;
}

// ── 战斗：命中 / 伤害 ────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * 命中判定。
 * @param skill 技能（含 acc）
 * @param attacker 攻击方状态（含 agi）
 * @param defender 防御方状态
 * @param opts { evading: bool } 对方本回合是否闪避
 */
export function rollHit(skill, attacker, defender, opts = {}) {
  if (opts.evading) return false;                       // 闪避直接失败
  if (skill.acc == null || skill.power === 0) return true;
  const roll = Math.random() * 100;
  return roll <= skill.acc;
}

/**
 * 伤害计算。
 * 顺序很重要（踩过的坑）：
 *   先算 威力 × 克制 × 克制修正 → 再乘随机浮动 → 最后取整
 * 随机浮动放在最后，避免被反复放大。
 */
export function calcDamage(skill, attackerCls, defenderCls, opts = {}) {
  if (!skill || !skill.power) return 0;
  let dmg = skill.power;
  dmg *= classMultiplier(attackerCls, defenderCls);
  if (opts.weaknessKnown) dmg *= 1.5;                  // 知道弱点
  if (opts.stance === 'guard') dmg *= 0.6;             // 对方守点
  dmg *= 0.85 + Math.random() * 0.15;                  // 随机浮动
  return Math.max(1, Math.round(dmg));
}

// ── 令咒 ────────────────────────────────────────────────────────
export const SEAL_COST = {
  strengthen: 1,   // 强化：本场命中 +20
  revive: 1,       // 续命：从者倒下时救回 25%
  transfer: 1,     // 转移：瞬移脱战
  rescale: 2,      // 重召：从者阵亡后召回
  custom: 2,       // 定制：自己指名从者
};

/**
 * 令咒消耗。
 * ⚠️ 关键规则：**令咒归零不会出局**，只是失去强制命令权。
 * 这条与原作一致，也是数值文档实测后修正的（旧规则会让第 1 划变成废物）。
 */
export function spendSeals(player, kind) {
  const cost = SEAL_COST[kind];
  if (cost === undefined) throw new Error(`未知令咒用法: ${kind}`);
  if (player.seals < cost) return { ok: false, reason: '令咒不足' };
  player.seals -= cost;
  return {
    ok: true,
    sealsLeft: player.seals,
    // 归零 ≠ 出局，只是失去强制力
    lostAuthority: player.seals === 0,
  };
}

// ── 服从判定 ────────────────────────────────────────────────────
/**
 * 从者是否执行命令。
 * 公式：基础 60% + 忠诚度 × 0.4（实测曲线见 从者忠诚度系统.md）
 * 有令咒时必听（这就是令咒的意义）。
 */
export function rollObedience(loyalty, seals) {
  if (seals > 0) return { obey: true, forced: true };
  const p = 60 + loyalty * 0.4;
  const roll = Math.random() * 100;
  if (roll <= p) return { obey: true };
  return { obey: false, forced: false };
}

/** 忠诚度变化（带有上下限） */
export function adjustLoyalty(player, delta) {
  player.loyalty = clamp(player.loyalty + delta, 0, 100);
  return player.loyalty;
}

/** 好感度变化 */
export function adjustAffinity(player, delta) {
  player.affinity = clamp(player.affinity + delta, 0, 100);
  return player.affinity;
}

/** 是否背叛（三重条件必须同时满足） */
export function canBetray(player, triggered) {
  return player.seals === 0 && player.loyalty <= 10 && triggered === true;
}

// ── 行动预算（时间制）───────────────────────────────────────────
/**
 * 每种行动的耗时（单位：小时）。
 * 设计要点：侦查变便宜了（0.5h），鼓励情报流。
 */
export const ACTION_COST = {
  investigate: 0.5,   // 侦查
  scout: 0.5,         // 查看地点
  explore: 1,         // 探索
  negotiate: 1,       // 交涉
  item: 1,            // 用道具
  attack: 2,          // 袭击（全押）
  rest: 0,            // 休整
  guard: 0,           // 守点
};

/** 能否执行某行动（预算检查） */
export function canAfford(player, kind, budget = 2) {
  const cost = ACTION_COST[kind];
  if (cost === undefined) return { ok: false, reason: '未知行动' };
  const used = player.nightSpent || 0;
  if (used + cost > budget) {
    return { ok: false, reason: `时间不够（已用 ${used}h，需要 ${cost}h）` };
  }
  return { ok: true, cost };
}

// ── 圣杯分 ──────────────────────────────────────────────────────
export const SCORE = {
  defeat: 3,          // 击破一组
  revealName: 2,      // 勘破真名
  leyPerNight: 1,     // 占据灵脉（每夜）
  itemSuccess: 1,     // 道具成功
  survive: 1,         // 存活（每夜）
};

export function addScore(player, kind, times = 1) {
  const v = SCORE[kind];
  if (v === undefined) return player.grailPoints;
  player.grailPoints += v * times;
  return player.grailPoints;
}

// ── 情报阶梯 ────────────────────────────────────────────────────
// L0 一无所知 / L1 职阶 / L2 真名 / L3 弱点
export const INTEL_BONUS = { 0: 0, 1: 0.10, 2: 0.20, 3: 0.40 };

/** 情报等级 → 命中/伤害加成 */
export function intelBonus(level) {
  return INTEL_BONUS[level] || 0;
}

/** 是否知道弱点（只有 L3 才算） */
export function knowsWeakness(intel) {
  return (intel?.level || 0) >= 3;
}

export default {
  RANK_VALUE, powerIndex, tierOf, classMultiplier,
  rollHit, calcDamage, SEAL_COST, spendSeals,
  rollObedience, adjustLoyalty, adjustAffinity, canBetray,
  ACTION_COST, canAfford, SCORE, addScore,
  INTEL_BONUS, intelBonus, knowsWeakness,
};
