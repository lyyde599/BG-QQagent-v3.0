// ── 圣杯战争 · 骨架数据 ──────────────────────────────────────────
//
// 把设计文档里的静态内容搬进代码：从者池、地点、事件、相性。
// 数据源是插件数据目录下的 json 与 md，这里做一次加载 + 内存缓存。
//
// 为什么单独一层：规则引擎要的是"纯数据"，不希望它去读文件。
// 这一层负责 IO 与清洗，上层只拿对象。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR as BASE_DATA_DIR } from '../config.js';

// 卡池：**属于插件资产，不属于运行数据**（2026-10-21 修正）。
//
// 踩过的坑：卡池原来放 data/grail/cards/，而"清空数据"会把整个 data/grail 删掉，
// 于是 63 骑从者卡跟着没了（虽然能恢复，但纯属设计错误）。
// 从者卡是静态内容、跟代码一起版本管理的东西，正确位置是 plugins/grail/cards/。
// 查找顺序：插件目录 → 旧位置（兼容旧的 data/grail/cards/）。
const PLUGIN_CARDS = path.join(import.meta.dirname, '..', '..', 'plugins', 'grail', 'cards');
const LEGACY_CARDS = path.join(BASE_DATA_DIR, 'grail', 'cards');
const SRC_DIR = fs.existsSync(path.join(PLUGIN_CARDS, 'servants.json')) ? PLUGIN_CARDS : LEGACY_CARDS;

let _servants = null;
let _byId = null;

/** 加载全部 63 骑（首次调用读盘，之后走缓存） */
export function loadServants() {
  if (_servants) return _servants;
  const file = path.join(SRC_DIR, 'servants.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  _servants = raw.map((s) => ({
    id: s.id,
    name: s.name,
    cls: s.cls,
    from: s.from,
    tier: s.tier,                 // 以标注为准，不重算
    stats: { str: s.str, end: s.end, agi: s.agi, mag: s.mag, luck: s.luck, np: s.np },
    npName: s.npName || '',
    weak: s.weak || '',
    quotes: s.quotes || '',
    wish: s.wish || '',
    respects: s.respects || '',
    lore: s.lore || '',
  }));
  _byId = new Map(_servants.map((s) => [s.id, s]));
  return _servants;
}

export function getServant(id) {
  if (!_byId) loadServants();
  return _byId.get(id) || null;
}

/** 按档位分桶（发牌用） */
export function byTier() {
  const out = { T1: [], T2: [], T3: [] };
  for (const s of loadServants()) (out[s.tier] ||= []).push(s);
  return out;
}

// ── 地点 ────────────────────────────────────────────────────────
// 与 cards/places.js 保持一致
export const PLACES = [
  // ley: 'strong' = 强力灵脉（宝具消耗 −10）；'weak' = 弱灵脉（−5）；false = 无
  { id: 'L-01', name: '柳洞寺',   zone: '山手', ley: 'strong', risk: '山门遭遇战' },
  { id: 'L-09', name: '大空洞',   zone: '山手', ley: false,    risk: '高危·易被围', parent: 'L-01' },
  { id: 'L-02', name: '远坂邸',   zone: '山手', ley: 'strong', risk: '结界陷阱' },
  { id: 'L-03', name: '教会',     zone: '中央', ley: false,    risk: '禁战区' },
  { id: 'L-06', name: '穗群原学园', zone: '中央', ley: false,  risk: '人多眼杂' },
  { id: 'L-04', name: '冬木大桥', zone: '河岸', ley: false,    risk: '桥上无遮蔽' },
  { id: 'L-10', name: '未远川河岸', zone: '河岸', ley: 'weak', risk: '夜间无人', parent: 'L-04' },
  { id: 'L-05', name: '商店街',   zone: '新都', ley: false,    risk: '容易被跟踪' },
  { id: 'L-07', name: '仓库街',   zone: '新都', ley: 'strong', risk: '易遭伏击' },
  { id: 'L-08', name: '卫宫邸',   zone: '新都', ley: 'weak',   risk: '位置暴露' },
];

export const PLACE_BY_ID = new Map(PLACES.map((p) => [p.id, p]));

export function getPlace(idOrName) {
  if (!idOrName) return null;
  return PLACES.find((p) => p.id === idOrName || p.name === idOrName || p.name.includes(idOrName)) || null;
}

/** 相邻地点（移动/追击判定用） */
export function neighborsOf(idOrName) {
  const p = getPlace(idOrName);
  if (!p) return [];
  const same = PLACES.filter((x) => x.zone === p.zone && x.id !== p.id);
  const linked = PLACES.filter((x) => x.parent === p.id || p.parent === x.id);
  return [...new Map([...same, ...linked].map((x) => [x.id, x])).values()];
}

/** 灵脉地点（5 处：3 强 + 2 弱） */
export function leyPlaces() {
  return PLACES.filter((p) => p.ley);
}

/** 灵脉强度 → 宝具消耗减免 */
export function leyDiscount(place) {
  if (!place || !place.ley) return 0;
  return place.ley === 'strong' ? 10 : 5;
}

// ── 随机事件（30 类，含效果定义）────────────────────────────────
// 每条都带"钩子"——它留下一个下一步，而不是句号
export const EVENTS = [
  // 环境类
  { id: 'mist',      name: '迷雾降临', cls: 'env',   desc: '侦查全部失效 1 夜', hook: '有人会趁雾偷袭' },
  { id: 'ley_surge', name: '灵脉暴走', cls: 'env',   desc: '宝具威力 +30%，用后暴露位置', hook: '弱者想赌一把' },
  { id: 'lockdown',  name: '教会封锁', cls: 'env',   desc: '只剩 3 处可进', hook: '被封的地方一定有人' },
  { id: 'blood_moon',name: '血月',     cls: 'env',   desc: 'Berserker 变强，狂化风险上升', hook: '有人想利用它' },
  { id: 'ley_back',  name: '灵脉逆流', cls: 'env',   desc: '灵脉点本夜无效', hook: '靠灵脉的人被迫移动' },
  { id: 'frost',     name: '霜降',     cls: 'env',   desc: '野外恢复 −50%', hook: '逼玩家往城里靠' },
  { id: 'resonance', name: '地脉共鸣', cls: 'env',   desc: '全场魔力恢复', hook: '强弱被拉平' },
  // 人物类
  { id: 'girl',      name: '迷之少女', cls: 'npc',   desc: '中立 NPC 出现', hook: '她为什么不怕？' },
  { id: 'lone_master', name: '落单的御主', cls: 'npc', desc: '某御主与从者分离', hook: '袭击还是拉拢？' },
  { id: 'survivor',  name: '上届残影', cls: 'npc',   desc: '带来一条旧情报', hook: '真假？他想要什么？' },
  { id: 'spy',       name: '双面间谍', cls: 'npc',   desc: '某从者同时向两边传话', hook: '谁在说谎？' },
  { id: 'old_friend',name: '从者的旧识', cls: 'npc', desc: '遇到因缘对象', hook: '见不见？' },
  // 情报类
  { id: 'fake_seal', name: '伪令咒',   cls: 'intel', desc: '黑市出现假令咒', hook: '谁信了？' },
  { id: 'memory_fragment', name: '记忆碎片', cls: 'intel', desc: '某真名线索泄露一半', hook: '谁的真名？' },
  { id: 'black_market', name: '黑市开张', cls: 'intel', desc: '可用情报/道具交易', hook: '你拿什么换？' },
  { id: 'anon_report', name: '匿名举报', cls: 'intel', desc: '有人向教会告密', hook: '谁写的？' },
  { id: 'rumor',     name: '市井谣言', cls: 'intel', desc: '群里流传真假参半的消息', hook: '验证要花行动' },
  { id: 'steal',     name: '失窃',     cls: 'intel', desc: '随机失去 1 件道具', hook: '谁偷的？' },
  // 道具类
  { id: 'relic_emerge', name: '圣遗物出土', cls: 'item', desc: '出现一件传说道具', hook: '谁去抢？' },
  { id: 'parcel',    name: '匿名包裹', cls: 'item',   desc: '收到随机道具', hook: '是不是陷阱？' },
  // 教会类
  { id: 'summon',    name: '教会传唤', cls: 'church', desc: '被要求去教会说明情况', hook: '去了可能被套话' },
  { id: 'curse',     name: '魔术回路灼烧', cls: 'church', desc: '本夜不能使用宝具', hook: '逼他换打法' },
  // 个人类
  { id: 'echo',      name: '结界残响', cls: 'personal', desc: '某地点无法进入', hook: '里面一定有人' },
  { id: 'whisper',   name: '圣杯的低语', cls: 'personal', desc: '可选择代价换强化', hook: '纯赌博' },
  { id: 'seventh',   name: '第七位',   cls: 'plot',   desc: '出现没有记号的痕迹', hook: '长线伏笔' },
];

export const EVENT_BY_ID = new Map(EVENTS.map((e) => [e.id, e]));

/** 第一场的固定事件表（见 每周目的差异化设计.md） */
export const FIRST_GAME_EVENTS = {
  2: 'memory_fragment',
  3: 'ley_surge',
  4: 'black_mist',      // 注意：文档里叫黑雾，这里映射到 mist
  5: 'lockdown',
  6: 'relic_emerge',
};

// ── 职阶克制表（供 UI 展示用）──────────────────────────────────
export const CLASS_TABLE = ['Saber', 'Archer', 'Lancer', 'Rider', 'Caster', 'Assassin', 'Berserker'];

export function counterOf(cls) {
  const map = {
    Saber: 'Lancer', Archer: 'Saber', Lancer: 'Archer',
    Rider: 'Caster', Caster: 'Assassin', Assassin: 'Rider',
  };
  return map[cls] || null;
}

/** 谁克这个职阶 */
export function counteredBy(cls) {
  const all = ['Saber', 'Archer', 'Lancer', 'Rider', 'Caster', 'Assassin', 'Berserker'];
  return all.filter((c) => counterOf(c) === cls);
}

export default {
  loadServants, getServant, byTier,
  PLACES, PLACE_BY_ID, getPlace, neighborsOf, leyPlaces, leyDiscount,
  EVENTS, EVENT_BY_ID, FIRST_GAME_EVENTS,
  CLASS_TABLE, counterOf, counteredBy,
};
