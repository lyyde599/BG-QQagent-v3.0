// ── 圣杯战争 · 状态层 ──────────────────────────────────────────────
//
// 一场战争 = 一个 state 对象，全部落盘到 data/grail/<gameId>.json。
//
// 设计原则（为什么这样组织）：
//   ① **单一真相源**：所有进度都在 state 里，不散落在各模块内存中。
//      进程重启后从文件恢复，不丢局。
//   ② **纯数据 + 纯函数**：state 只存数据，结算逻辑在 rules.js 里做纯计算。
//      这样结算可以单测，不依赖网络/LLM。
//   ③ **按人隔离**：每个玩家只能看到自己的部分（信息隔离），
//      所以 state 里所有"别人不该知道的"都要标记 knownBy。
import fs from 'node:fs';
import path from 'node:path';

const PHASES = ['idle', 'recruit', 'draft', 'running', 'ended'];

const DEFAULT_TIME_BUDGET = 2;      // 每夜 2 单位
const DEFAULT_COMMAND_SEALS = 3;    // 令咒 3 划
const DEFAULT_HP = 100;

/** 新建一场战争 */
export function newGame({ gameId, groupId, hostId }) {
  return {
    gameId,
    groupId,
    hostId,
    phase: 'idle',
    day: 0,                  // 0 = 未开始，1..7 = 第 N 夜
    maxDays: 7,
    createdAt: Date.now(),
    updatedAt: Date.now(),

    // 开局配置（第一场固定，见 每周目的差异化设计.md）
    config: {
      tone: 'standard',
      draft: 'balanced',
      mapVariant: 'standard',
      scenario: 'eighth_seat',
      events: {
        2: 'memory_fragment',
        3: 'ley_surge',
        4: 'black_mist',
        5: 'church_lockdown',
        6: 'relic_emerge',
      },
    },

    players: {},             // uid -> PlayerState
    invites: {},             // uid -> { status, sentAt, quote }
    log: [],                 // 事件日志（复盘用）
    daily: {},               // day -> { events: [], publicLog: [], privateLog: {} }
  };
}

/** 玩家状态 */
export function newPlayer({ uid, name }) {
  return {
    uid,
    name,
    joinedAt: Date.now(),
    alive: true,
    eliminated: false,       // 彻底出局（御主死亡）
    surrendered: false,      // 主动投降

    // 从者
    servant: null,           // { id, name, cls, tier, stats, skills, npName, weak, wish, respects }
    servantHp: DEFAULT_HP,
    hpMax: DEFAULT_HP,

    // 资源
    seals: DEFAULT_COMMAND_SEALS,
    items: [],               // 道具 id 列表（最多 3）
    grailPoints: 0,

    // 忠诚 / 好感
    loyalty: 60,
    affinity: 50,

    // 情报（自己掌握的）
    intel: {
      // targetUid -> { level: 0-3, fragments: [], weaknessKnown: bool }
    },

    // 位置
    location: null,          // 当前所在地点 id
    traces: [],              // 自己留下的痕迹 [{ placeId, type, day }]

    // 夜行动
    nightAction: null,       // { kind, target, spent } 当夜已下的指令
    nightSpent: 0,           // 已用时间预算

    // 姿态（第二道选择题）
    stance: null,            // 'guard' | 'wander' | 'hide' | 'seek'

    // 连续未响应次数（用于从者自主行动的升级）
    idleNights: 0,
  };
}

/** 落盘 */
export function saveGame(dir, game) {
  game.updatedAt = Date.now();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${game.gameId}.json`);
  // 先写临时文件再 rename，避免写一半断电导致损坏
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(game, null, 1));
  fs.renameSync(tmp, file);
}

/** 读盘 */
export function loadGame(dir, gameId) {
  const file = path.join(dir, `${gameId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

/** 列出所有进行中的局 */
export function listGames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
    .map((f) => {
      try {
        const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { gameId: g.gameId, phase: g.phase, day: g.day, players: Object.keys(g.players || {}).length };
      } catch { return null; }
    })
    .filter(Boolean);
}

/** 只有进行中的局（一个群同时只能有一场） */
export function activeGameOf(dir, groupId) {
  for (const info of listGames(dir)) {
    const g = loadGame(dir, info.gameId);
    if (g && g.groupId === groupId && g.phase !== 'ended') return g;
  }
  return null;
}

/** 追加日志（保留最近 500 条，防文件膨胀） */
export function pushLog(game, entry) {
  game.log.push({ ts: Date.now(), ...entry });
  if (game.log.length > 500) game.log = game.log.slice(-500);
}

/** 当前夜的数据容器 */
export function dailyOf(game, day = game.day) {
  if (!game.daily[day]) game.daily[day] = { events: [], publicLog: [], privateLog: {} };
  return game.daily[day];
}

export { PHASES, DEFAULT_TIME_BUDGET, DEFAULT_COMMAND_SEALS, DEFAULT_HP };
