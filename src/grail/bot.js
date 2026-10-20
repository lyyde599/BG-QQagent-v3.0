// ── 圣杯战争 · QQ 接入层 ────────────────────────────────────────
//
// 把 QQ 消息（文本）翻译成游戏指令，调用引擎，再把结果发回去。
//
// 为什么单独一层：
//   · app.js 只负责"有消息来了"这一个钩子，不该塞进游戏逻辑
//   · 这一层可以脱离 QQ 单测（传入假 sender）
//
// 与 LLM 的关系：
//   游戏判定**不走 LLM**（数值必须确定性）；
//   但"从者说话"可以交给 LLM 润色——这部分在 bot 层做，不在引擎里。
import fs from 'node:fs';
import path from 'node:path';
import * as State from './state.js';
import * as Engine from './engine.js';
import * as Render from './render.js';
import { buildProposals, drawPack, assignServant, resolveNight } from './engine.js';
import { getPlace, PLACES, neighborsOf, leyPlaces } from './data.js';
import { DATA_DIR as BASE_DATA_DIR } from '../config.js';

// 部署目录不写死，跟着项目根走。
// 2026-10-21 插件化：用取值函数而非常量，插件可注入私有目录。
const FALLBACK_DATA_DIR = path.join(BASE_DATA_DIR, 'grail');
function D() { return globalThis.__qqGrailDataDir || FALLBACK_DATA_DIR; }

// ── 指令表 ──────────────────────────────────────────────────────
// 数字优先（转化率最高），同时接受中文
const NUM_ACTION = {
  1: 'explore', 2: 'investigate', 3: 'attack', 4: 'negotiate',
  5: 'rest', 6: 'guard', 7: 'item',
};

/** 解析一条消息，返回 {cmd, args} 或 null（不是游戏指令） */
export function parse(text, { isGroup, isPrivate, selfId }) {
  if (!text) return null;
  // 清洗：
  //  ① 群里 @机器人 会被 segmentsToText 转成 "@小鲸鱼 "，要去掉
  //  ② 各种空白与零宽字符
  let t = String(text)
    .replace(/\u200b/g, '')                       // 零宽空格
    .replace(/^[\s@\u3000]+/, '')                 // 开头空白/@
    .replace(/^[^\s]{1,20}\s+(?=圣杯)/, '')        // 开头的 @昵称
    .trim();

  // 群里必须 @ 机器人，或带前缀
  // （私聊直接认）
  const all = [
    [/^圣杯\s*(状态|我的状态)$/i, 'status'],
    [/^圣杯\s*排行(榜)?$/i, 'rank'],
    [/^圣杯\s*地图$/i, 'map'],
    [/^圣杯\s*令咒$/i, 'seals'],
    [/^圣杯\s*(帮助|指令|help)$/i, 'help'],
    [/^圣杯\s*结算$/i, 'settle'],
    [/^圣杯\s*加入$/i, 'join'],
    [/^圣杯\s*不参加$/i, 'decline'],
    [/^圣杯\s*稍后$/i, 'later'],
    [/^圣杯\s*定制\s*(.+)$/i, 'custom', 1],
    [/^圣杯\s*今晚(做什么|怎么办)?$/i, 'propose'],
    [/^圣杯\s*再想想$/i, 'rethink'],
    [/^圣杯\s*查\s*(.+)$/i, 'investigate', 1],
    [/^圣杯\s*去\s*(.+)$/i, 'explore', 1],
    [/^圣杯\s*打\s*(.+)$/i, 'attack', 1],
    [/^圣杯\s*谈\s*(.+)$/i, 'negotiate', 1],
    [/^圣杯\s*休整$/i, 'rest'],
    [/^圣杯\s*守点$/i, 'guard'],
  ];

  for (const [re, cmd, g] of all) {
    const m = t.match(re);
    if (m) return { cmd, arg: g ? m[g].trim() : null };
  }

  // 纯数字：**只在"期待输入"时才认**，避免抢走正常聊天
  // 判断交给 handleNumber（它会检查玩家有没有 pending 的候选包/提案）
  if (/^[1-7]$/.test(t)) return { cmd: 'number', arg: t };

  return null;
}

// ── 游戏实例 ────────────────────────────────────────────────────
const cache = new Map();   // groupId -> game（避免频繁读盘）

export function loadOrCreate(groupId) {
  if (cache.has(groupId)) return cache.get(groupId);
  let g = State.activeGameOf(D(), groupId);
  if (!g) {
    g = State.newGame({ gameId: `g${Date.now()}`, groupId, hostId: '' });
    State.saveGame(D(), g);
  }
  cache.set(groupId, g);
  return g;
}

export function save(game) {
  State.saveGame(D(), game);
  cache.set(game.groupId, game);
}

// ── 主处理函数 ──────────────────────────────────────────────────
/**
 * 处理一条游戏相关消息。
 * @returns { ok, messages: [{chatKey, text}] } 或 { ok:false } 表示"不是游戏指令"
 *
 * 注意：**不发消息**，只返回要发的内容。发送由 app.js 用 sender 执行，
 * 这样可测，也避免这一层依赖网络。
 */
export async function handle({ kind, chatId, userId, userName, text, selfId }) {
  const game = kind === 'group' ? loadOrCreate(chatId) : findPrivateGame(userId, chatId);

  // 在群里：只有游戏指令才处理（避免抢正常聊天）
  let parsed = parse(text, { isGroup: kind === 'group', isPrivate: kind === 'private' });
  if (!parsed) return { ok: false };

  // 数字指令：只有在"确实有等待中的选择"时才接管
  // 否则放行给正常聊天（有人在私聊里说「1」不该被抢走）
  if (parsed.cmd === 'number') {
    const p = game.players?.[userId];
    const waiting = !!(p?._pack || p?._lastProposals);
    if (!waiting) return { ok: false };
    return handleNumber(game, userId, Number(parsed.arg), kind, chatId);
  }

  const out = [];
  const push = (t) => out.push({ chatKey: `${kind}:${chatId}`, text: t });
  const dm = (uid, t) => out.push({ chatKey: `private:${uid}`, text: t });

  switch (parsed.cmd) {
    // ── 开局 ──
    case 'start': {
      if (kind !== 'group') return { ok: true, messages: [] };
      if (game.phase === 'running') {
        push('这一场已经开始了。等它结束吧。');
        break;
      }
      game.phase = 'recruit';
      game.day = 0;
      save(game);
      push([
        '【圣杯战争】',
        '',
        '这个群里，有些东西要醒了。',
        '第七届圣杯战争，即将开始。',
        '',
        '需要 5 到 9 个人。不公开报名——我会一个一个问。',
        '被问到的人可以拒绝。没被问到的，也可以主动回「圣杯 加入」。',
        '',
        '这几天，谁会参加，你们不会知道。',
      ].join('\n'));
      break;
    }

    case 'join': {
      if (game.phase !== 'recruit' && game.phase !== 'draft') {
        push('现在不是报名的时候。');
        break;
      }
      if (game.players[userId]) {
        dm(userId, '你已经在里面了。');
        break;
      }
      const count = Object.keys(game.players).length;
      if (count >= 9) { dm(userId, '满了。九个人，一个不多。'); break; }

      game.players[userId] = State.newPlayer({ uid: userId, name: userName });
      State.pushLog(game, { type: 'join', uid: userId });
      save(game);
      dm(userId, '记下了。你是第 ' + (count + 1) + ' 个。');
      break;
    }

    case 'decline': {
      if (game.invites?.[userId]) {
        game.invites[userId].status = 'declined';
        save(game);
      }
      dm(userId, '好。');
      break;
    }

    // ── 选牌 ──
    case 'custom': {
      const name = parsed.arg;
      dm(userId, '【系统 · 核查中】\n\n查询：' + name + '\n\n（这一步需要人工审核或接入搜索接口）');
      break;
    }

    // ── 每夜 ──
    case 'propose': {
      const p = game.players[userId];
      if (!p?.servant) { dm(userId, '你还没有从者。'); break; }
      const props = buildProposals(game, userId);
      dm(userId, Render.renderProposals(p.servant, props, p.servantHp));
      p._lastProposals = props;   // 缓存，供数字选择用
      save(game);
      break;
    }

    case 'rethink': {
      const p = game.players[userId];
      if (!p?.servant) break;
      p._rethink = (p._rethink || 0) + 1;
      if (p._rethink > 2) { dm(userId, '它不说话了。（每夜最多重想 2 次）'); break; }
      const props = buildProposals(game, userId);
      dm(userId, Render.renderProposals(p.servant, props, p.servantHp));
      p._lastProposals = props;
      save(game);
      break;
    }

    case 'investigate':
    case 'explore':
    case 'attack':
    case 'negotiate':
    case 'rest':
    case 'guard': {
      const p = game.players[userId];
      if (!p?.servant) { dm(userId, '你还没有从者。'); break; }
      const act = buildAction(parsed.cmd, parsed.arg, game, userId);
      if (!act.ok) { dm(userId, act.reason); break; }
      p.nightAction = act.action;
      p.nightSpent = (p.nightSpent || 0) + act.action.cost;
      dm(userId, `记下了。${act.desc}（已用 ${p.nightSpent}/2 小时）`);
      save(game);
      break;
    }

    // ── 查询 ──
    case 'status': {
      const p = game.players[userId];
      dm(userId, Render.renderStatus(p));
      break;
    }
    case 'rank': {
      const list = Render.renderStandings(Object.values(game.players));
      push('【当前名次】\n' + (list || '还没有人。'));
      break;
    }
    case 'map': {
      const L = ['🗺 冬木市（10 处）', ''];
      for (const z of ['山手', '中央', '河岸', '新都']) {
        L.push(`【${z}】`);
        PLACES.filter((p) => p.zone === z).forEach((p) => {
          L.push(`${p.parent ? '　└ ' : ''}${p.name}${p.ley ? ' ▸灵脉' : ''}`);
        });
        L.push('');
      }
      L.push('▸灵脉 = 宝具消耗减免');
      push(L.join('\n'));
      break;
    }
    case 'seals': dm(userId, Render.renderSeals()); break;
    case 'help': dm(userId, Render.renderHelp()); break;

    // ── 结算（暂由主人手动触发）──
    case 'settle': {
      if (game.phase !== 'running') { push('还没开始。'); break; }
      const res = resolveNight(game);
      // 公开播报
      push(Render.renderWarReport({
        day: game.day,
        broadcasts: res.broadcasts,
        standings: Render.renderStandings(Object.values(game.players)),
      }));
      // 私密结果
      for (const [uid, msgs] of Object.entries(res.privates)) {
        dm(uid, msgs.join('\n'));
      }
      game.day += 1;
      if (game.day > game.maxDays) endGame(game);
      save(game);
      break;
    }

    default:
      return { ok: false };
  }

  return { ok: true, messages: out };
}

// ── 数字选择（需要上下文）──────────────────────────────────────
function handleNumber(game, userId, n, kind, chatId) {
  const out = [];
  const dm = (uid, t) => out.push({ chatKey: `private:${uid}`, text: t });
  const p = game.players[userId];

  // 选牌阶段：1/2/3 选候选
  if (game.phase === 'draft' && p?._pack) {
    const s = p._pack[n - 1];
    if (!s) return { ok: true, messages: [] };
    assignServant(game, userId, s.id);
    delete p._pack;
    const sv = p.servant;
    dm(userId, [
      `契约成立。`,
      '',
      `${sv.name}（${sv.cls}）`,
      `耐久 ${p.servantHp}`,
      `令咒 3 划`,
      '',
      '明天开始，我每天会找你。',
    ].join('\n'));
    save(game);
    return { ok: true, messages: out };
  }

  // 行动阶段：从者的提案
  if (p?._lastProposals?.[n - 1]) {
    const prop = p._lastProposals[n - 1];
    p.nightAction = {
      kind: prop.kind,
      targetUid: prop.targetUid,
      placeId: prop.placeId,
      cost: prop.cost,
    };
    p.nightSpent = (p.nightSpent || 0) + prop.cost;
    delete p._lastProposals;
    dm(userId, `记下了。${prop.label}（已用 ${p.nightSpent}/2 小时）`);
    save(game);
    return { ok: true, messages: out };
  }

  return { ok: false };
}

// ── 行动构造 ────────────────────────────────────────────────────
function buildAction(kind, arg, game, userId) {
  const p = game.players[userId];
  const cost = { investigate: 0.5, explore: 1, attack: 2, negotiate: 1, rest: 0, guard: 0 }[kind] ?? 1;

  if ((p.nightSpent || 0) + cost > 2) {
    return { ok: false, reason: `时间不够了（已用 ${p.nightSpent || 0}/2 小时）` };
  }

  if (kind === 'explore') {
    const place = getPlace(arg);
    if (!place) return { ok: false, reason: `没有这个地点：${arg}` };
    return { ok: true, action: { kind, placeId: place.id, cost }, desc: `去${place.name}。` };
  }

  if (kind === 'investigate' || kind === 'attack' || kind === 'negotiate') {
    // arg 可能是 QQ 号或名字
    const target = findPlayer(game, arg, userId);
    if (!target) return { ok: false, reason: '找不到这个人（可能没参战）。' };
    return {
      ok: true,
      action: { kind, targetUid: target.uid, cost },
      desc: kind === 'investigate' ? `查 ${target.servant?.cls || '?'}。`
           : kind === 'attack' ? `打 ${target.servant?.cls || '?'}。`
           : `找 ${target.servant?.cls || '?'} 谈。`,
    };
  }

  return { ok: true, action: { kind, cost }, desc: kind === 'rest' ? '休整。' : '守点。' };
}

function findPlayer(game, arg, selfUid) {
  const key = String(arg).replace(/^@/, '');
  for (const p of Object.values(game.players)) {
    if (p.uid === selfUid) continue;
    if (p.uid === key || p.name === key) return p;
  }
  return null;
}

// ── 私聊找局：玩家在哪个群参战，就归哪场 ───────────────────────
function findPrivateGame(userId, chatId) {
  // 先看缓存里有没有以他为参战者的局
  for (const g of cache.values()) {
    if (g.players?.[userId]) return g;
  }
  // 扫盘
  for (const info of State.listGames(D())) {
    const g = State.loadGame(D(), info.gameId);
    if (g?.players?.[userId]) { cache.set(g.groupId, g); return g; }
  }
  // 兜底：造一个空局（让指令不会崩）
  return { groupId: 'private:' + chatId, phase: 'idle', players: {}, day: 0, maxDays: 7, config: {}, daily: {}, log: [] };
}

// ── 结束 ────────────────────────────────────────────────────────
function endGame(game) {
  game.phase = 'ended';
  const sorted = Object.values(game.players)
    .filter((p) => p.alive && !p.eliminated)
    .sort((a, b) => b.grailPoints - a.grailPoints);
  const winner = sorted[0];
  State.pushLog(game, { type: 'end', winner: winner?.uid, score: winner?.grailPoints });
}

export default { parse, handle, loadOrCreate, save };
