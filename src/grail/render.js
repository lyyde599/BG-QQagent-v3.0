// ── 圣杯战争 · 消息渲染 ──────────────────────────────────────────
//
// 把引擎的指令对象渲染成玩家能读的中文。
// **不发送**——只返回字符串/数组，由 bot.js 决定发到哪。
//
// 排版原则（在 QQ 比例字体下验证过）：
//   · 不用闭合框线（emoji 宽度不稳定，边框必歪）
//   · 用整行分隔符和缩进分区
//   · 每段不超过 3 行，超了就拆

const STAR = { T1: '★★★★★', T2: '★★★★', T3: '★★★' };
const CLASS_ICON = {
  Saber: '⚔️', Archer: '🏹', Lancer: '🔱', Rider: '🐎',
  Caster: '🔮', Assassin: '🗡️', Berserker: '⚡',
  Ruler: '👑', Shielder: '🛡️', Avenger: '🔥',
  AlterEgo: '🎭', Foreigner: '🌌',
};

// ── 招募邀请 ────────────────────────────────────────────────────
// 格式：系统通告。分条、冒号、无修辞。
// ❌ 不要写成"我在找七个人…"这种文学化叙事——那是角色在说话，不是系统在通知。
export function renderInvite({ quote, playerCount }) {
  return [
    '圣杯战争 · 邀请',
    '',
    '本群将进行一场为期 7 天的圣杯战争。',
    '你是被选中的御主候选人之一。',
    '',
    '参与者：5~9 人',
    '周期：7 天，每晚约 10~15 分钟',
    '机制：每人获得 1 名从者，通过探索、侦查、战斗争夺圣杯',
    '奖励：胜者获得 5000 万 token 额度（deepseek-v4.1f）',
    '',
    '参与的代价：',
    '· 每晚需要分配 2 小时行动预算',
    '· 令咒共 3 划，用尽后失去对从者的强制命令权',
    '· 可能在早期出局',
    '',
    '请注意：',
    '· 你的身份不会公开',
    '· 其他参与者是谁，也不会公开',
    '· 一旦开始，中途退出需要正式投降',
    '',
    '要参加，回复：1',
    '不参加，回复：2',
    '稍后决定，回复：3',
    '',
    '（24 小时内有效）',
  ].join('\n');
}

// ── 三选一 ──────────────────────────────────────────────────────
export function renderDraft(pack) {
  const L = ['圣杯战争 · 从者选定', '', '以下 3 名从者供你选择。', '选定后不可更换。', ''];
  pack.forEach((s, i) => {
    const icon = CLASS_ICON[s.cls] || '◆';
    const st = s.stats;
    L.push(`【${i + 1}】${icon} ${s.cls} · ${s.tier}`);
    L.push(`　${s.name}`);
    L.push(`　筋${st.str} 耐${st.end} 敏${st.agi} 魔${st.mag} 幸${st.luck} 宝${st.np}`);
    L.push(`　宝具：${(s.npName || '').replace(/\*\*/g, '').split('（')[0]}`);
    L.push('');
  });
  L.push('回复数字选定：1 / 2 / 3');
  L.push('（弱点信息不在候选内，需自行侦查）');
  L.push('');
  L.push('── 其他选项 ──');
  L.push('');
  L.push('可消耗 2 划令咒，自行指定一名角色。');
  L.push('');
  L.push('限制：');
  L.push('· 维基百科可查');
  L.push('· 不可为已有从者');
  L.push('· 不可为主神级');
  L.push('');
  L.push('说明：');
  L.push('· 数值、技能、宝具、弱点由系统判定');
  L.push('· 仅可选择角色，不可指定强度');
  L.push('· 系统会将其削弱至与其他从者相当');
  L.push('· 消耗后剩余 1 划令咒');
  L.push('');
  L.push('回复：定制 <角色名>');
  return L.join('\n');
}

// ── 令咒说明 ────────────────────────────────────────────────────
export function renderSeals() {
  return [
    '📜 令咒：每人 3 划，用一划少一划',
    '',
    '强化 —— 1 划：本场战斗命中率 +20%',
    '续命 —— 1 划：从者倒下时救回 25% 耐久',
    '转移 —— 1 划：从者瞬移脱战',
    '定制 —— 2 划：跳过抽卡，自己指名从者',
    '',
    '⚠️ 令咒用尽不会出局，但会失去强制命令权。',
    '从者是否继续听命，取决于它的忠诚度。',
  ].join('\n');
}

// ── 从者汇报 + 提案 ─────────────────────────────────────────────
// 注意：这里**可以**有从者的话（它是角色），但列表部分必须是系统格式。
export function renderProposals(servant, proposals, hp) {
  const L = [];
  L.push(`【第 N 夜 · 行动选择】`);
  L.push('');
  L.push(`从者：${servant.name}（${servant.cls}）`);
  L.push(`耐久：${hp}/100`);
  L.push('');
  L.push('可选行动：');
  L.push('');
  proposals.forEach((p, i) => {
    L.push(`${i + 1}. [${ACTION_LABEL[p.kind] || p.kind}] ${p.label}`);
    L.push(`   耗时 ${p.cost} 小时`);
    L.push('');
  });
  L.push('回复数字选定。');
  L.push('可用预算：2 小时/夜，不累积。');
  return L.join('\n');
}

export const ACTION_LABEL = {
  investigate: '侦查',
  explore: '探索',
  attack: '袭击',
  negotiate: '交涉',
  rest: '休整',
  guard: '守点',
  item: '用道具',
};

// ── 战报 ────────────────────────────────────────────────────────
export function renderWarReport({ day, broadcasts, standings }) {
  const L = [];
  L.push(`【第 ${day} 夜 · 战报】`);
  L.push('');
  if (broadcasts.length) {
    broadcasts.forEach((b) => L.push(b));
  } else {
    L.push('本夜无公开事件。');
  }
  L.push('');
  L.push(`当前名次：${standings}`);
  return L.join('\n');
}

// ── 排行（只显示名次，不显示分数）──────────────────────────────
export function renderStandings(players) {
  const sorted = [...players]
    .filter((p) => p.alive && !p.eliminated && !p.surrendered)
    .sort((a, b) => b.grailPoints - a.grailPoints);
  const marks = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
  return sorted
    .map((p, i) => `${marks[i] || i + 1} ${CLASS_ICON[p.servant?.cls] || '◆'}`)
    .join('　');
}

// ── 状态卡（玩家自查）──────────────────────────────────────────
export function renderStatus(player) {
  if (!player?.servant) return '你还没有从者。';
  const s = player.servant;
  const L = [];
  L.push(`${CLASS_ICON[s.cls] || '◆'} ${s.name}`);
  L.push(`${s.cls} · ${STAR[s.tier] || ''}`);
  L.push('');
  L.push(`耐久 ${player.servantHp}/${player.hpMax}`);
  L.push(`令咒 ${'✦'.repeat(player.seals)}${'✧'.repeat(3 - player.seals)}（${player.seals}）`);
  L.push(`圣杯分 ${player.grailPoints}`);
  L.push('');
  L.push(`忠诚 ${player.loyalty}　好感 ${player.affinity}`);
  if (player.loyalty < 40) L.push('⚠️ 忠诚低于 40：从者可能拒绝命令，且不再汇报。');
  L.push('');
  L.push(`愿望：${s.wish || '——'}`);
  if (s.respects) L.push(`在意：${s.respects}`);
  return L.join('\n');
}

// ── 定制从者的推演结果 ─────────────────────────────────────────
export function renderCustomServant({ name, from, cls, stats, index, tier, npName, skills, weak, boosted }) {
  const L = [];
  L.push(`【灵基推演完成】`);
  L.push('');
  L.push(`${name}`);
  L.push(`出处：${from}`);
  L.push(`职阶：${cls}　档位：${tier}`);
  L.push('');
  L.push('━━ 能力参数 ━━');
  const rows = [['筋力', stats.str], ['耐久', stats.end], ['敏捷', stats.agi],
                ['魔力', stats.mag], ['幸运', stats.luck], ['宝具', stats.np]];
  rows.forEach(([k, v]) => L.push(`${k} ${v}`));
  L.push('');
  L.push(`指数：${index}`);
  if (boosted) {
    L.push('');
    L.push('※ 此人本非战士，圣杯强行补足了灵基。');
    L.push('※ 强度仍低于抽卡池中位——这是厨力的代价。');
  }
  if (skills?.length) {
    L.push('');
    L.push('━━ 技能 ━━');
    skills.forEach((s) => L.push(`${s.name}（${s.pp} PP）${s.effect || ''}`));
  }
  if (npName) {
    L.push('');
    L.push('━━ 宝具 ━━');
    L.push(npName.replace(/\*\*/g, ''));
  }
  if (weak) {
    L.push('');
    L.push('━━ 弱点 ━━');
    L.push(weak.replace(/\*\*/g, '').split('勘破后')[0].trim());
  }
  return L.join('\n');
}

// ── 通用提示 ────────────────────────────────────────────────────
export function renderHelp() {
  return [
    '圣杯战争 · 指令表',
    '',
    '【每夜行动】（预算 2 小时，不累积）',
    '圣杯 查 <玩家>      侦查 · 0.5h',
    '圣杯 去 <地点>      探索 · 1h',
    '圣杯 打 <玩家>      袭击 · 2h',
    '圣杯 谈 <玩家>      交涉 · 1h',
    '圣杯 休整           恢复耐久 · 0h',
    '圣杯 守点           驻守灵脉 · 0h',
    '',
    '【提案】',
    '圣杯 今晚做什么     由从者提供可执行提案',
    '圣杯 再想想         重新生成提案（每夜最多 2 次）',
    '',
    '【查询】',
    '圣杯 状态           从者、耐久、令咒、圣杯分',
    '圣杯 排行           当前名次',
    '圣杯 地图           地点列表',
    '圣杯 令咒           令咒用法',
    '',
    '【选牌阶段】',
    '回复 1 / 2 / 3      选定从者',
    '圣杯 定制 <角色名>   消耗 2 划令咒自行指定',
  ].join('\n');
}

export default {
  renderInvite, renderDraft, renderSeals, renderProposals,
  renderWarReport, renderStandings, renderStatus, renderCustomServant,
  renderHelp, ACTION_LABEL,
};
