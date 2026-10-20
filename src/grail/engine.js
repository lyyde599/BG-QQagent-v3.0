// ── 圣杯战争 · 引擎（招募 / 选牌 / 夜结算）─────────────────────────
//
// 这一层把 state + rules + data 串起来，产出"该发什么消息"。
// **不发消息**——只返回指令对象，由 bot.js 负责实际发送。
// 这样引擎可以脱离 QQ 单测。
import {
  newPlayer, dailyOf, pushLog,
} from './state.js';
import {
  powerIndex, tierOf, classMultiplier, calcDamage, rollHit,
  rollObedience, adjustLoyalty, ACTION_COST, canAfford,
  addScore, SEAL_COST, spendSeals, SCORE,
} from './rules.js';
import {
  loadServants, byTier, getPlace, neighborsOf, leyPlaces, leyDiscount,
  EVENTS, EVENT_BY_ID, PLACES,
} from './data.js';

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── 选牌 ────────────────────────────────────────────────────────
/**
 * 给一个玩家发 3 个候选（1×T1 + 1×T2 + 1×T3）。
 *
 * 职阶平衡：如果 T2/T3 都是"被克池大"的职阶（Rider/Archer），重抽。
 * 原因：Caster 有 15 个，Rider 被它克；Saber 有 10 个，Archer 被它克。
 * 抽到两个吃亏职阶就是系统问题，不是运气。
 */
const WEAK_CLASSES = ['Rider', 'Archer'];

export function drawPack(game) {
  const tiers = byTier();
  const used = new Set(
    Object.values(game.players)
      .map((p) => p.servant?.id)
      .filter(Boolean)
  );

  for (let attempt = 0; attempt < 30; attempt++) {
    const pack = ['T1', 'T2', 'T3'].map((t) => {
      const pool = tiers[t].filter((s) => !used.has(s.id));
      return pool.length ? pick(pool) : null;
    });
    if (pack.some((s) => !s)) continue;

    // 职阶检查：三个候选不能有两骑同职阶（否则抽卡没意义）
    const classes = pack.map((s) => s.cls);
    if (new Set(classes).size < 3) continue;

    // 吃亏职阶检查：T2 和 T3 不能都是被克池大的
    const mid = pack.filter((s) => s.tier !== 'T1');
    if (mid.every((s) => WEAK_CLASSES.includes(s.cls))) continue;

    return pack;
  }

  // 兜底：不检查职阶，保证能发出
  return ['T1', 'T2', 'T3'].map((t) => {
    const pool = tiers[t].filter((s) => !used.has(s.id));
    return pool.length ? pick(pool) : tiers[t][0];
  });
}

/** 把候选从者转成给玩家看的信息（**不含弱点**） */
export function publicServantInfo(s) {
  const idx = powerIndex(s.stats);
  return {
    id: s.id,
    name: s.name,
    cls: s.cls,
    tier: s.tier,
    stats: s.stats,
    npName: s.npName,
    index: idx,
    // ⚠️ weak / wish / respects 一律不暴露——那是要玩家自己查的
  };
}

// ── 履约：玩家选定从者 ──────────────────────────────────────────
export function assignServant(game, uid, servantId) {
  const p = game.players[uid];
  if (!p) return { ok: false, reason: '未参战' };
  const s = loadServants().find((x) => x.id === servantId);
  if (!s) return { ok: false, reason: '没有这个从者' };

  p.servant = {
    id: s.id,
    name: s.name,
    cls: s.cls,
    tier: s.tier,
    stats: s.stats,
    npName: s.npName,
    weak: s.weak,
    wish: s.wish,
    respects: s.respects,
  };
  p.location = pick(PLACES).id;      // 随机起始位置
  p.nightSpent = 0;
  p.nightAction = null;

  pushLog(game, { type: 'assign', uid, servantId: s.id });
  return { ok: true, servant: p.servant };
}

// ── 从者提案（1~5 个）──────────────────────────────────────────
/**
 * 从者根据当前局势给出 1~5 个可执行提案。
 *
 * **只提议它"知道"的事**：不知道对手在哪，就不可能提议"去打他"。
 * 这样"情报"才有实际价值。
 */
export function buildProposals(game, uid) {
  const p = game.players[uid];
  if (!p?.servant) return [];

  const others = Object.values(game.players).filter(
    (o) => o.uid !== uid && o.alive && !o.eliminated && o.servant
  );
  const known = others.filter((o) => (p.intel?.[o.uid]?.level || 0) >= 1);
  const props = [];

  // ① 侦查：永远可做（而且便宜，0.5h）
  if (others.length) {
    const target = known.length ? pick(known) : pick(others);
    props.push({
      kind: 'investigate',
      targetUid: target.uid,
      cost: ACTION_COST.investigate,
      label: `查一下 ${target.servant.cls} 的底细`,
      reason: '我总觉得他不像表面那么强。',
    });
  }

  // ② 探索：有灵脉就去灵脉
  const leys = leyPlaces().filter((l) => !game.claimedLey?.[l.id]);
  if (leys.length) {
    const target = pick(leys);
    props.push({
      kind: 'explore',
      placeId: target.id,
      cost: ACTION_COST.explore,
      label: `去${target.name}看看`,
      reason: '那边有灵脉。',
    });
  } else {
    props.push({
      kind: 'explore',
      placeId: pick(PLACES).id,
      cost: ACTION_COST.explore,
      label: '随便找个地方探探',
      reason: '总比待着强。',
    });
  }

  // ③ 袭击：只有"知道是谁"且"打得过"才会提
  if (known.length) {
    const t = known[0];
    const myIdx = powerIndex(p.servant.stats);
    const hisIdx = powerIndex(t.servant.stats);
    if (myIdx >= hisIdx * 0.9) {
      props.push({
        kind: 'attack',
        targetUid: t.uid,
        cost: ACTION_COST.attack,
        label: `直接打 ${t.servant.cls}`,
        reason: '赌一把。',
      });
    }
  }

  // ④ 交涉：有盟友价值的才提
  if (others.length >= 2) {
    const t = pick(others);
    props.push({
      kind: 'negotiate',
      targetUid: t.uid,
      cost: ACTION_COST.negotiate,
      label: `找 ${t.servant.cls} 谈`,
      reason: '我们两个都打不过最强的那个。',
    });
  }

  // ⑤ 休整：血低于 50 才提
  if (p.servantHp < p.hpMax * 0.5) {
    props.push({
      kind: 'rest',
      cost: ACTION_COST.rest,
      label: '休整',
      reason: '你伤还没好。',
    });
  }

  // 最多 5 个，至少 1 个
  const shuffled = props.sort(() => Math.random() - 0.5).slice(0, 5);
  return shuffled.length ? shuffled : [{ kind: 'rest', cost: 0, label: '休整', reason: '今夜很安静。' }];
}

// ── 夜晚结算 ────────────────────────────────────────────────────
/**
 * 结算一夜。返回 { broadcasts: [], privates: { uid: [msg] }, events: [] }。
 *
 * 结算顺序（很重要）：
 *   ① 抽事件（先影响环境）
 *   ② 执行行动（侦查/探索/袭击）
 *   ③ 结算战斗
 *   ④ 计分 + 恢复
 *   ⑤ 生成播报
 */
export function resolveNight(game) {
  const day = game.day;
  const daily = dailyOf(game, day);
  const broadcasts = [];
  const privates = {};
  const say = (uid, msg) => { (privates[uid] ||= []).push(msg); };

  const players = Object.values(game.players).filter(
    (p) => p.alive && !p.eliminated && !p.surrendered && p.servant
  );

  // ① 事件
  const evId = game.config?.events?.[day];
  const event = evId ? EVENT_BY_ID.get(evId) : null;
  if (event) {
    daily.events.push(event.id);
    broadcasts.push(`【今夜】${event.name}：${event.desc}`);
  }
  const mist = event?.id === 'mist' || event?.id === 'black_mist';

  // ② 执行行动
  for (const p of players) {
    const act = p.nightAction;
    if (!act) {
      // 没下指令 → 按最稳的算
      p.idleNights = (p.idleNights || 0) + 1;
      continue;
    }
    p.idleNights = 0;

    if (act.kind === 'investigate') {
      const t = game.players[act.targetUid];
      if (!t?.servant) continue;
      if (mist) { say(p.uid, '雾太大了，什么都没查到。'); continue; }
      const intel = (p.intel[act.targetUid] ||= { level: 0, fragments: [] });
      // 职阶（L1）开局就公开，所以侦查第一次直接给 L2（事迹片段）
      intel.level = clamp(Math.max(intel.level, 1) + 1, 1, 3);
      const frag = intelFragment(t.servant, intel.level);
      intel.fragments.push(frag);
      say(p.uid, `【侦查】你查到了：${frag}`);
    }

    else if (act.kind === 'explore') {
      const place = getPlace(act.placeId);
      if (!place) continue;
      p.location = place.id;
      if (place.ley) {
        game.claimedLey ||= {};
        game.claimedLey[place.id] = p.uid;
        addScore(p, 'leyPerNight');
        say(p.uid, `你拿下了${place.name}的灵脉。（圣杯分 +1）`);
      } else {
        say(p.uid, `你在${place.name}转了一圈，没找到什么。`);
      }
    }

    else if (act.kind === 'rest') {
      p.servantHp = Math.min(p.hpMax, p.servantHp + 35);
      say(p.uid, `休整了一夜。（耐久 +35）`);
    }

    else if (act.kind === 'attack') {
      const t = game.players[act.targetUid];
      if (!t?.servant || !t.alive) { say(p.uid, '那人已经不在了。'); continue; }
      const battle = simulateBattle(p, t);
      const lines = describeBattle(battle, p, t);
      say(p.uid, lines.self);
      say(t.uid, lines.target);
      if (battle.winner === p.uid) {
        addScore(p, 'defeat');
        broadcasts.push(`【冲突】⚔️ 与 🔮 在${getPlace(p.location)?.name || '某处'}交手。有人退了。`);
      } else if (battle.winner === t.uid) {
        addScore(t, 'defeat');
        broadcasts.push(`【冲突】两骑在某处交手。先退的是另一方。`);
      } else {
        broadcasts.push(`【冲突】某处传来交手声，随后归于安静。`);
      }
    }
  }

  // ③ 存活计分
  for (const p of players) addScore(p, 'survive');

  // ④ 恢复
  for (const p of players) {
    p.servantHp = Math.min(p.hpMax, Math.round(p.servantHp + p.hpMax * 0.15));
  }

  // ⑤ 清空当夜
  for (const p of players) {
    p.nightAction = null;
    p.nightSpent = 0;
    p.stance = null;
  }

  return { broadcasts, privates, event };
}

/** 情报碎片（分级暴露，永远不直接给真名） */
function intelFragment(servant, level) {
  if (level <= 1) return `${servant.cls} 职阶（已知）`;
  if (level === 2) {
    // 给"事迹片段"，不给名字
    const hints = {
      Saber: '一把剑，和一段没能守住的誓言',
      Archer: '他站在远处，从不靠近',
      Lancer: '一杆枪，和一次必然的贯穿',
      Rider: '有什么东西在跑，很快',
      Caster: '他在算，一直在算',
      Assassin: '没有声音，没有影子',
      Berserker: '他在忍，忍得很辛苦',
    };
    return hints[servant.cls] || '看不清。';
  }
  return `似乎可以确定他的真名了。（但系统不会替你说出来）`;
}

// ── 战斗（简化版，单回合判定）──────────────────────────────────
/**
 * 一场战斗 = 3 回合模拟。
 * 完整版（异步 10 分钟响应）需要 bot 层维护回合状态，这里先做"自动结算"版，
 * 用于夜晚批量结算。玩家主动约战走另外的交互流程。
 */
export function simulateBattle(a, b, rounds = 3) {
  const A = { ...a, hp: a.servantHp };
  const B = { ...b, hp: b.servantHp };
  const log = [];

  for (let r = 0; r < rounds; r++) {
    if (A.hp <= 0 || B.hp <= 0) break;
    // 简单 AI：有 60% 概率攻击，40% 防守
    for (const [me, foe, tag] of [[A, B, 'A'], [B, A, 'B']]) {
      if (me.hp <= 0 || foe.hp <= 0) continue;
      const attacking = Math.random() < 0.6;
      if (!attacking) continue;
      // 威力基准 22（不是 40）：3 回合 × 2 人 × 22 ≈ 132，
      // 刚好能让一方掉到危险线，但不会一回合秒掉。
      const dmg = calcDamage(
        { power: 22 + rnd(12) },
        me.servant.cls, foe.servant.cls,
        { weaknessKnown: (me.intel?.[foe.uid]?.level || 0) >= 3 }
      );
      foe.hp -= dmg;
      log.push(`${tag} 造成 ${dmg} 伤害`);
    }
  }

  // 写回
  a.servantHp = Math.max(1, A.hp);
  b.servantHp = Math.max(1, B.hp);

  let winner = null;
  if (A.hp <= 0 && B.hp > 0) winner = b.uid;
  else if (B.hp <= 0 && A.hp > 0) winner = a.uid;
  else winner = A.hp > B.hp ? a.uid : B.hp > A.hp ? b.uid : null;

  return { winner, aHp: a.servantHp, bHp: b.servantHp, log };
}

function describeBattle(res, a, b) {
  if (res.winner === a.uid) {
    return {
      self: `你赢了。（你剩 ${res.aHp}，他剩 ${res.bHp}）`,
      target: `你打输了。退到了别处。（你剩 ${res.bHp}，他剩 ${res.aHp}）`,
    };
  }
  if (res.winner === b.uid) {
    return {
      self: `你打输了。（你剩 ${res.aHp}，他剩 ${res.bHp}）`,
      target: `你赢了。（你剩 ${res.bHp}，他剩 ${res.aHp}）`,
    };
  }
  return {
    self: `打了个平手，双方都退了。`,
    target: `打了个平手。`,
  };
}

export default {
  drawPack, publicServantInfo, assignServant, buildProposals,
  resolveNight, simulateBattle,
};
