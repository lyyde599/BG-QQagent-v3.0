// ── 圣杯战争 · 管理接口（面板用）────────────────────────────────
//
// 开局、推进、结算都由面板触发，不在群里 @ 机器人。
// 理由：① 群里 @ 启动太随意，误触会毁掉一局
//       ② 开局需要选人、发牌、私聊邀请，是一串动作，不是一条消息能表达的
//       ③ 主人需要在开始前检查配置
import path from 'node:path';
import * as State from './state.js';
import * as Engine from './engine.js';
import * as Render from './render.js';
import { drawPack, assignServant, buildProposals, resolveNight } from './engine.js';
import { loadServants, PLACES, CLASS_TABLE, counterOf, counteredBy } from './data.js';
import { SEAL_COST, SCORE } from './rules.js';
import { DATA_DIR as BASE_DATA_DIR } from '../config.js';

// 部署目录不写死，跟着项目根走。
// 2026-10-21 插件化：用**取值函数**而非常量 —— 插件可在装载时注入私有目录
// （globalThis.__qqGrailDataDir），常量会在模块加载时被冻死、注入不生效。
const FALLBACK_DATA_DIR = path.join(BASE_DATA_DIR, 'grail');
function D() { return globalThis.__qqGrailDataDir || FALLBACK_DATA_DIR; }

/** 开局：创建 game，进入招募阶段 */
export function startGame({ groupId, hostId, config }) {
  const existing = State.activeGameOf(D(), groupId);
  if (existing) {
    return { ok: false, error: '这个群已有一场进行中的战争', gameId: existing.gameId };
  }
  const g = State.newGame({
    gameId: `g${Date.now()}`,
    groupId,
    hostId: hostId || '',
  });
  if (config) g.config = { ...g.config, ...config };
  g.phase = 'recruit';
  State.saveGame(D(), g);
  return { ok: true, game: summarize(g) };
}

/** 读取当前局 */
export function getGame(groupId) {
  const g = State.activeGameOf(D(), groupId);
  return g ? summarize(g) : null;
}

/** 拿到原始 state（内部用） */
export function rawGame(groupId) {
  return State.activeGameOf(D(), groupId);
}

/** 手动加一个玩家（面板点选） */
export function addPlayer(groupId, { uid, name }) {
  const g = rawGame(groupId);
  if (!g) return { ok: false, error: '没有进行中的局' };
  if (g.players[uid]) return { ok: false, error: '已经在名单里' };
  if (Object.keys(g.players).length >= 9) return { ok: false, error: '满员（最多 9 人）' };
  g.players[uid] = State.newPlayer({ uid, name });
  State.saveGame(D(), g);
  return { ok: true, players: Object.keys(g.players).length };
}

/** 移除玩家 */
export function removePlayer(groupId, uid) {
  const g = rawGame(groupId);
  if (!g) return { ok: false, error: '没有进行中的局' };
  delete g.players[uid];
  State.saveGame(D(), g);
  return { ok: true };
}

/** 开始发牌：给所有玩家生成候选包 */
export function dealAll(groupId) {
  const g = rawGame(groupId);
  if (!g) return { ok: false, error: '没有进行中的局' };
  if (Object.keys(g.players).length < 5) {
    return { ok: false, error: `人数不足（当前 ${Object.keys(g.players).length}，需要 5~9）` };
  }
  const results = [];
  for (const p of Object.values(g.players)) {
    const pack = drawPack(g);
    p._pack = pack;
    // 先不放 servant，等玩家选
    results.push({
      uid: p.uid,
      name: p.name,
      pack: pack.map((s) => Engine.publicServantInfo(s)),
    });
  }
  g.phase = 'draft';
  State.saveGame(D(), g);
  return { ok: true, results };
}

/** 自动分配（测试 / 玩家没回应用时用） */
export function autoAssign(groupId) {
  const g = rawGame(groupId);
  if (!g) return { ok: false, error: '没有进行中的局' };
  const out = [];
  // 已分配的从者 ID（跨玩家去重，避免两人拿到同一个从者）
  const taken = new Set(
    Object.values(g.players).map((x) => x.servant?.id).filter(Boolean)
  );
  for (const p of Object.values(g.players)) {
    if (p.servant) continue;
    // 优先用他自己的候选包里没被占的；全被占了就从全池抽
    let pick = (p._pack || []).find((s) => !taken.has(s.id));
    if (!pick) {
      const fresh = drawPack(g).find((s) => !taken.has(s.id));
      pick = fresh || null;
    }
    if (!pick) continue;            // 池子空了，跳过
    assignServant(g, p.uid, pick.id);
    taken.add(pick.id);
    delete p._pack;
    out.push({ uid: p.uid, servant: p.servant.name, cls: p.servant.cls });
  }
  g.phase = 'running';
  g.day = 1;
  State.saveGame(D(), g);
  return { ok: true, assigned: out };
}

/** 推进一夜（结算） */
export function settleNight(groupId) {
  const g = rawGame(groupId);
  if (!g) return { ok: false, error: '没有进行中的局' };
  if (g.phase !== 'running') return { ok: false, error: '还没进入进行阶段' };

  const res = resolveNight(g);
  const standings = Render.renderStandings(Object.values(g.players));
  const report = Render.renderWarReport({ day: g.day, broadcasts: res.broadcasts, standings: standings });

  g.day += 1;
  const ended = g.day > g.maxDays;
  if (ended) endGame(g);
  State.saveGame(D(), g);

  return {
    ok: true,
    day: g.day - 1,
    report,                    // 群公告用
    privates: res.privates,    // uid -> [msg]
    ended,
  };
}

/** 玩家提案（面板预览 / 私聊触发） */
export function propose(groupId, uid) {
  const g = rawGame(groupId);
  if (!g) return { ok: false, error: '没有进行中的局' };
  const p = g.players[uid];
  if (!p?.servant) return { ok: false, error: '这个玩家还没有从者' };
  const props = buildProposals(g, uid);
  p._lastProposals = props;
  State.saveGame(D(), g);
  return { ok: true, proposals: props, text: Render.renderProposals(p.servant, props, p.servantHp) };
}

/** 下达行动 */
export function setAction(groupId, uid, action) {
  const g = rawGame(groupId);
  if (!g) return { ok: false, error: '没有进行中的局' };
  const p = g.players[uid];
  if (!p?.servant) return { ok: false, error: '这个玩家还没有从者' };
  const cost = { investigate: 0.5, explore: 1, attack: 2, negotiate: 1, rest: 0, guard: 0 }[action.kind] ?? 1;
  if ((p.nightSpent || 0) + cost > 2) {
    return { ok: false, error: `时间不够（已用 ${p.nightSpent || 0}/2 小时）` };
  }
  p.nightAction = { ...action, cost };
  p.nightSpent = (p.nightSpent || 0) + cost;
  State.saveGame(D(), g);
  return { ok: true, spent: p.nightSpent };
}

/** 结束 */
export function endGame(g) {
  g.phase = 'ended';
  const sorted = Object.values(g.players)
    .filter((p) => p.alive && !p.eliminated)
    .sort((a, b) => b.grailPoints - a.grailPoints);
  g.winner = sorted[0] ? { uid: sorted[0].uid, name: sorted[0].name, score: sorted[0].grailPoints } : null;
  State.pushLog(g, { type: 'end', winner: g.winner?.uid });
}

/**
 * 生成"开局要发给玩家的私聊消息"。
 * 面板点"开局"后，这些消息由 app.js 依次发出（走 sendTextBatch）。
 */
export function buildInvites(groupId) {
  const g = rawGame(groupId);
  if (!g) return { ok: false, error: '没有进行中的局' };
  const out = [];
  for (const p of Object.values(g.players)) {
    out.push({
      uid: p.uid,
      chatKey: `private:${p.uid}`,
      text: Render.renderInvite({ quote: p._quote || '', playerCount: Object.keys(g.players).length }),
    });
  }
  return { ok: true, invites: out };
}

/** 生成"三选一候选"的私聊消息 */
export function buildDraftMessages(groupId) {
  const g = rawGame(groupId);
  if (!g) return { ok: false, error: '没有进行中的局' };
  const out = [];
  for (const p of Object.values(g.players)) {
    if (!p._pack) continue;
    out.push({
      uid: p.uid,
      chatKey: `private:${p.uid}`,
      text: Render.renderDraft(p._pack),
    });
  }
  return { ok: true, messages: out };
}

/** 列表（面板首页） */
export function listAll() {
  return State.listGames(D());
}

/** 摘要（给面板的 JSON） */
function summarize(g) {
  return {
    gameId: g.gameId,
    groupId: g.groupId,
    phase: g.phase,
    day: g.day,
    maxDays: g.maxDays,
    config: g.config,
    players: Object.values(g.players).map((p) => ({
      uid: p.uid,
      name: p.name,
      alive: p.alive,
      eliminated: p.eliminated,
      surrendered: p.surrendered === true,
      servant: p.servant ? {
        id: p.servant.id, name: p.servant.name, cls: p.servant.cls, tier: p.servant.tier,
        // 2026-10-21 面板补全：原来只给 4 个字段，面板看不到从者到底什么水平。
        // publicServantInfo 是引擎的公开信息投影（不泄露真名等隐藏项之外的内部值）。
        // 字段名是 index 不是 power（powerIndex() 的返回值）——第一次写错，实测纠正
        power: (() => { try { return Engine.publicServantInfo(p.servant).index; } catch { return null; } })(),
        npName: p.servant.npName || '',
        stats: p.servant.stats || null,
        weak: p.servant.weak || '',
      } : null,
      hp: p.servantHp,
      hpMax: p.hpMax || p.servantHp,
      seals: p.seals,
      items: Array.isArray(p.items) ? p.items : [],
      points: p.grailPoints,
      loyalty: p.loyalty,
      affinity: p.affinity,
      spent: p.nightSpent || 0,
      action: p.nightAction?.kind || null,
      // 情报等级：面板要能看到"谁掌握了谁多少情报"（原来完全不可见）
      intel: Object.fromEntries(
        Object.entries(p.intel || {}).map(([uid, v]) => [uid, {
          level: v?.level ?? 0,
          weaknessKnown: v?.weaknessKnown === true
        }])
      )
    })),
    // 最近战报（面板"战况"视图的数据源）
    log: Array.isArray(g.log) ? g.log.slice(-40) : [],
    winner: g.winner || null,
  };
}

/**
 * 面板用的静态规则表（2026-10-21）。
 *
 * 为什么单独一个接口：地点/职阶克制/行动耗时这些是**规则常量**，
 * 不随对局变化。塞进每个对局响应里浪费带宽，但面板确实需要展示
 * （玩家问"去哪灵脉强""什么克 Caster"时，主人得能查到）。
 */
export function rulebook() {
  return {
    places: PLACES.map((p) => ({
      id: p.id, name: p.name, zone: p.zone, ley: p.ley || false, risk: p.risk || ''
    })),
    classes: CLASS_TABLE,
    counters: Object.fromEntries(CLASS_TABLE.map((c) => [c, counterOf(c)])),
    counteredBy: Object.fromEntries(CLASS_TABLE.map((c) => [c, counteredBy(c)])),
    actionCost: { investigate: 0.5, explore: 1, attack: 2, negotiate: 1, rest: 0, guard: 0 },
    sealCost: SEAL_COST,
    score: SCORE
  };
}

export default {
  startGame, getGame, rawGame, addPlayer, removePlayer,
  dealAll, autoAssign, settleNight, propose, setAction, listAll, endGame,
  buildInvites, buildDraftMessages, rulebook,
};
