// 配置管理：data/config.json，UI 可写。所有字段都有默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAS } from './personas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

/**
 * 读环境变量，新旧前缀都认（2026-10-30 改名鲸界Bridge）
 *
 * 项目原名 QQAgent，环境变量前缀是 QQ_AGENT_* / QQAGENT_*。
 * 改名后新前缀是 WB_*，但**旧的必须继续有效** ——
 * 老用户的 systemd 单元、启动脚本、docker-compose 里都写着旧名，
 * 直接换掉会让他们的部署起不来。
 *
 * 优先级：WB_XXX  >  QQ_AGENT_XXX  >  QQAGENT_XXX
 * （新名优先，但旧名永不失效）
 *
 * @param {string} name 不带前缀的名字，如 'DATA_DIR'
 * @param {string} [fallback]
 */
export function envAny(name, fallback = undefined) {
  const v = process.env['WB_' + name]
    ?? process.env['QQ_AGENT_' + name]
    ?? process.env['QQAGENT_' + name];
  return v === undefined || v === '' ? fallback : v;
}

// 测试/便携场景可重定向数据目录（新旧前缀都认）
export const DATA_DIR = envAny('DATA_DIR', path.join(ROOT, 'data'));
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  // OpenAI 兼容 API（必填才能跑）
  api: {
    baseUrl: 'http://127.0.0.1:8787/v1',   // 例如本机 buddy2api 网关或任何 OpenAI 兼容端点
    apiKey: '',
    model: '',                              // UI 里选择/填写
    // 输出 token 上限（2026-10-27 整合）：思考型模型给太小会只剩空正文，
    // 不设则完全交给上游默认，不可控。0 或 null 表示不显式传。
    maxTokens: 2000,
    // 计费方式（2026-10-27 整合）：'token' 按 token 折算金额；'credit' 按积分，
    // credit 模式下 estimateCost 恒返回 0，面板不再显示误导性金额。
    billing: 'token',
    provider: '',                           // 当前模型所属提供商（多提供商目录的选中项）
    vision: true,                           // 模型是否支持图片输入（关掉则移除看图工具）
    temperature: 0.8,
    maxRounds: 12,                          // 单次运行的最多工具轮数
    timeoutMs: 180000,
    // 展示用单价（元 / 百万 token），不参与任何请求
    priceInputPerM: 0,
    priceOutputPerM: 0
  },
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  providersSourceYaml: '',
  providersImported: true,
  // 联网搜索
  //   provider: 'auto'      = 有 AnySearch key 就用它，失败自动回退 Bing（推荐）
  //             'anysearch' = 只用 AnySearch（需配置 key，结果更全）
  //             'bing'      = 只用 Bing 网页抓取（无需 key）
  webSearch: {
    enabled: true,
    provider: 'auto',
    searchUrl: 'https://cn.bing.com/search',
    maxResults: 6,
    // AnySearch 的 API key（可选；也可用环境变量 ANYSEARCH_API_KEY / _2 注入，env 优先）
    // 支持多个 key 轮换：某个 key 返回 429 时自动换下一个
    anysearchKeys: []
  },
  // 安全例外（默认全部关闭）
  security: {
    allowPrivateImageHosts: false           // true 时图片下载允许内网地址（仅本地测试/自建图床）
  },
  // SnowLuma / OneBot v11
  snowluma: {
    dir: '',                   // SnowLuma 程序目录；留空 = 自动探测项目内 ./snowluma
    autoLaunch: false,         // 应用启动时自动拉起 SnowLuma（未运行时）
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: '',           // WebSocket 令牌
    httpAccessToken: ''        // HTTP API 令牌（SnowLuma 可与 WS 不同；留空沿用 accessToken）
  },
  // 人设与行为
  persona: {
    botName: '小鲸鱼',
    selfNickname: '',                       // 在群里的展示名（留空用 QQ 昵称）
    roleText: PERSONAS.xiaojingyu.text,     // 默认人设：原版"小鲸鱼"角色卡（适配版）
    participation: 'medium',                // low | medium | high —— 参与度参考
    customRules: '',                        // 追加自定义规则（可选）
    // 主人专属关系段（2026-10-30）
    //
    // 之前内核里硬编码了一份作者本人的关系设定（谁造的你、怎么称呼、
    // 你在他面前是什么位置），随核心包分发给所有人 —— 已移除。
    // 现在由使用者自己写，留空则不注入。
    masterBond: ''
  },
  // 用户自定义人设库（保存在配置里，可在设置页添加/选择）
  customPersonas: [],
  // 多身份：按会话绑定人设。key = chatKey（可含模式后缀，如 private:123456:tutor），
  // value = 人设 id（'builtin:xxx' 内置 / 'persona:<name>' 自定义人设名，见 resolvePersona）
  personaBindings: {},
  // 身份模式（学习模式等）：按会话记录当前激活的身份
  // { "<chatKey>": { "mode": "tutor"|"assistant", "personaRef": "...", "switchedAt": 123 } }
  personaModes: {},
  // 身份模式定义：每个模式一套完整配置（人设 + 工具 + 提示注入）
  identityModes: {
    // 示例（默认留空，由实际项目配置填充）：
    // tutor: { label: '教师模式', personaRef: '', extraPrompt: '', masterOnly: true }
  },
  // 接入白名单
  // ── 群聊行为（2026-10-27 整合）──
  group: {
    // 群里没 @ 机器人 = 只入库、不调模型（省钱 + 不抢话）。
    // 设成 false 可恢复「所有消息都交给模型判断」的旧行为。
    requireAt: true,
    // @ 硬门的判定者（2026-10-28 新增）：
    //   'builtin' → 内核按「有没有 at 段」硬判（默认，老行为）
    //   'plugin'  → 跳过硬判，交给 context-strategy 插件综合判断
    //               （@我 / 引用我 / 拍我 / 关键词，规则归插件）
    // 配成 plugin 但没插件注册策略时，自动回退 builtin，
    // 避免群里每句话都触发一次模型调用。
    requireAtBy: 'builtin'
  },
  allow: { groups: [], private: [] },
  deny: { groups: [], private: [] },
  allowAllWhenEmpty: false,
  // 群聊未提及机器人时的触发概率（0.05 = 5%；@/提及/图片/提问必触发）
  groupMentionProbability: 0.05,
  // 运行节奏
  wakeDelayMs: 2000,        // 空闲时收到消息到发起运行的防抖窗口（等连发聚成一批）
  drainDelayMs: 1200,       // 一次运行结束后发现还有未读，到下一次运行的间隔
  maxConcurrentRuns: 2,     // 全局同时进行的 agent 运行数
  // 发送保护
  send: {
    minGapMs: 1000,         // 相邻两条消息最小间隔
    maxGapMs: 3000,         // 最大间隔
    byLengthMs: 20,         // 按字数附加的间隔（毫秒/字）
    maxPerMinute: 0,   // 0 = 不限速（已取消频率限制）
    maxPerHour: 0,    // 0 = 不限速（已取消频率限制）
    hardSplitAt: 4000       // QQ 硬限制切分（0 = 不限制）
  },
  // 主动开话题（可选）
  proactive: {
    enabled: false,
    checkIntervalMinMs: 1800000,
    checkIntervalMaxMs: 5400000,
    idleThresholdMs: 1800000,   // 群里静默多久才算"冷场"
    probability: 0.25
  },
  // 表情包
  sticker: {
    enabled: true,
    promptMaxStickers: 10,
    collectEnabled: true,
    maxCollectPerHour: 10
  },
  // 存储
  store: {
    maxMessagesPerChat: 2000,   // 单群 JSON 最大保留条数（0 = 无限）
    pastStateLimit: 80,         // 提示词里"过去状态"最多带多少条
    pastStateMaxChars: 6000,    // "过去状态"文本预算
    keepSessionFiles: 300       // 保留最近多少个会话记录文件
  },
  // 记忆自动整理：条数超阈值且距上次超过冷却时间时，在运行结束后后台合并/去重/删过时
  memory: {
    consolidateEnabled: true,
    consolidateMinIntervalMs: 21600000  // 默认 6 小时
  },
  // 桌面端/控制台
  server: {
    port: 3210,
    token: '',                // 留空 = 只监听 127.0.0.1
    autoStart: false,         // 开机自启（仅 Electron 桌面端生效）
    closeToTray: true         // 点关闭 = 最小化到托盘
  },
  // 外观（2026-10-21）：皮肤 + 自定义背景
  //
  // skin 取值：default（纸墨灰原色）| paper-warm | midnight | forest | sakura | ocean
  // 皮肤只是**覆盖令牌**，不改任何组件规则 —— 见 ui/skins/*.css
  //
  // background：自定义背景图。dataUrl 存 base64（避免额外静态目录与权限问题），
  // opacity 控制"背景透过面板的程度"：0 = 完全看不见背景，1 = 面板不透明（同默认）。
  appearance: {
    skin: 'default',
    background: {
      dataUrl: '',      // 空 = 不启用背景图
      opacity: 0.92,    // 面板不透明度（0.30~1.00）；越小背景越透
      blur: 0,          // 背景模糊 px（0~20）
      mode: 'cover'     // cover | contain | repeat
    }
  },
  // ── 界面（2026-10-25）──────────────────────────────
  //
  // hidePluginPage：隐藏顶栏内置的「插件」页。
  //
  // 背景：装上 plugin-center 之后，它的功能是内置「插件」页的**超集**
  // （多了按 category 分组、黑名单、救援列表、bulk 开关）。
  // 两个入口做同一件事，顶栏显得啰嗦。
  //
  // 为什么做成开关而不是直接删：没装 plugin-center 的用户会失去插件管理入口。
  // 默认 false —— 行为与之前完全一致，想清的人自己打开。
  ui: {
    hidePluginPage: false
  },
  // 内核更新（2026-10-25）
  //
  // autoCheck  ：启动后定期查有没有新版本，有就在面板角标提示（不打扰）
  // autoDownload：查到新版自动下载并校验（**不安装**）
  // 真正的替换永远由人手动做 —— 见 src/kernel-update.js 顶部的说明。
  kernelUpdate: {
    // 内核作者归属（2026-10-30）
    //
    // 判定「谁能发布内核更新」。原来写死在 src/app.js 里（作者昵称 + QQ 号），
    // 随核心包分发就等于把作者身份公开了。现在配置化：
    //   · 留空 → 只有创造营 admin 角色能发
    //   · 填了 → 昵称或 QQ 匹配即可
    publisherNickname: '',
    publisherQQ: '',
    autoCheck: true,
    checkIntervalHours: 24,
    autoDownload: false,
    // 🔴 autoInstall=true：查到新版自动装（会重启服务一次）
    //    流程与手动「下载并自动安装」完全一致：
    //    备份 → 语法自检 → 替换 → 重启 → 健康探测 → 失败自动回滚
    //    默认关 —— 自动重启对正在用的人有影响，得用户自己开
    autoInstall: false,
    // 自动安装前的等待分钟数：避开刚启动时的忙碌期
    installDelayMinutes: 5,
    lastCheckAt: null,
    lastSeenVersion: null,
    lastInstallAt: null
  },
  // 预算保险丝：今日估算成本达到上限（元）自动暂停；0 = 不限制
  budget: {
    dailyCostYuan: 0
  },
  // 广告/推广自动禁言（2026-10-03）。默认关闭：禁言影响真实群友，
  // 建议先开 dryRun 观察一段时间再正式开启。详见 src/anti-ad.js 顶部说明。
  antiAd: {
    enabled: false,             // 总开关
    dryRun: false,              // true = 只记录不处罚（正式开启前观察用）
    muteSeconds: 600,           // 禁言时长：10 分钟
    exemptUsers: [],            // 豁免名单（永不处理）
    cooldownMs: 1800000,        // 同一人冷却期 30 分钟（避免重复处罚）
    windowMs: 600000,           // 频率窗口 10 分钟
    maxPerWindow: 5             // 窗口内最多处罚人数（防批量误伤）
  },
  // 关键词广告注入（2026-10-20）。默认关闭：命中即自动发预设内容，
  // 配错会刷屏。建议先开 dryRun 观察。
  // 与 antiAd 相反：antiAd 是"检测群友发广告→禁言"，adInject 是"检测关键词→机器人发内容"。
  adInject: {
    enabled: false,
    dryRun: false,
    cooldownMs: 300000,          // 同一人同一广告冷却 5 分钟
    maxPerDayPerGroup: 3,        // 同一广告单群每天最多 3 次
    maxPerHourPerChat: 10,       // 单会话每小时上限
    maxAdsPerMessage: 1,         // 一条消息最多触发几条广告
    maxTextLength: 240,          // 超长文本不匹配
    allowPrivate: false,
    skipWhenAtBot: true,
    failureBackoffMs: 60000,
    regexMaxLength: 200,
    ads: [],                     // 广告列表（面板 CRUD）
  },
  // 群友福利发放（2026-10-04）。默认关闭 —— 开启即意味着发放真实权益。
  // 领取走确定性代码路径（welfare.js），入群满 minJoinHours 小时 + 每人限一次。
  welfare: {
    enabled: false,
    sourceGroups: [],           // 哪些群的成员可领（通常填白名单群）
    minJoinHours: 24,           // 入群满多少小时才可领
    tokenKeys: [],              // 可发放的 API key（轮询分配）
    tokenQuota: 20000000,       // 名义额度（本地记账用，上游无法强制）
    baseUrl: 'https://zp.597457.xyz/v1',
    model: 'GLM-5.3-Flash',
    coupons: [],                // 优惠券码（先到先得，发完为止）
    shopUrl: 'https://www.16688.com.cn/shop/XYGPT'
  }
};

function deepMerge(base, override) {
  if (override === null || override === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(override);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

export function loadConfig() {
  let cfg;
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    cfg = deepMerge(DEFAULT_CONFIG, parsed);
  } catch {
    cfg = structuredClone(DEFAULT_CONFIG);
  }
  return withPersonaSwitchModes(cfg);
}

/**
 * 自动补齐「人设切换」用的 identityModes（2026-10-05）。
 *
 * 设计：16 个可选人设不逐个手写进 config.json，而是**由代码按需生成**：
 *   每个人设 → 一个 mode（id = `persona:<key>`），带 label / personaRef / enter 口令。
 * 好处：
 *   · 新增人设只改 personas.js，切换能力自动跟着有，不会漏配
 *   · config.json 保持干净（不用塞 16 段重复的 enter/exit）
 *   · 面板下拉切换与群内口令切换走**同一套 mode 机制**，行为一致
 *
 * 口令设计原则：
 *   · enter 用「切换X」「换X」「X模式」等自然说法；短口令（如"傻妞"）也收，
 *     但要过下面的一致性检查，避免和日常聊天撞车。
 *   · 已显式配置过的同名 mode 不覆盖（以用户在面板/配置里的为准）。
 *   · kind:'persona' 标记用于切换时区分文案（见 orchestrator 的"换人设"分支）。
 */
function withPersonaSwitchModes(cfg) {
  const modes = { ...(cfg.identityModes || {}) };
  // 只在开启「可选人设」时才注入，避免用户没这个需求时空增 16 个 mode
  const enabled = cfg.features?.personaSwitch !== false;
  if (!enabled) return cfg;
  for (const [key, p] of Object.entries(PERSONAS)) {
    if (key === 'blank') continue;              // 空白模板不作为可切换人设
    const modeId = `persona:${key}`;
    if (modes[modeId]) continue;                // 已有显式配置 → 不覆盖
    const short = String(p.name || '').replace(/（.*?）/g, '').trim();
    modes[modeId] = {
      kind: 'persona',
      label: `人设·${short}`,
      personaRef: `builtin:${key}`,
      extraPrompt: '',
      // 口令：切换X / 换X / X模式 / 用人设X
      enter: [`切换${short}`, `换${short}`, `${short}模式`, `用人设${short}`, `切到${short}`],
      exit: ['换回来', '恢复默认', '回到默认', '切换默认', '退出人设', '换回小白鲸']
    };
    // 小白鲸（默认人设）用「换回来」即可，不需要"切换小白鲸"
    if (key === 'xiaojingyu') {
      modes[modeId].enter = ['切换小白鲸', '换小白鲸', '小白鲸模式', '回到小白鲸'];
    }
  }
  return { ...cfg, identityModes: modes };
}

let currentConfig = null;
let saveTimers = new Map();

/** 取当前生效配置（未初始化时从磁盘读）。 */
// ── 关于 / 交流群（2026-10-24）────────────────────────────────────
//
// 需求：控制面板里让人知道有这个 QQ 群，但**只做静态展示**，不打扰使用。
//
// 三条自我约束（避免变成骚扰式推广）：
//   ① 只出现在「设置 → 关于」，不弹窗、不轮播、不挡住操作
//   ② 不写进提示词 —— 模型不知道这个群，不会被诱导在聊天里拉人
//   ③ 不写进任何一个 Tab 的首屏，用户不主动看就看不到
//
// 想改群号/群名只需要动这里一处。
//
// 2026-10-30：项目更名「鲸界Bridge」。
// 为避免与腾讯产生不必要的误会，原名中的 QQagent 字样逐步退出，
// 但**仓库地址保持不变**（GitHub/Gitee 仍是 BG-QQagent-v3.0，
// 改名迁移成本高于收益，且地址变更会打断已发布的下载链接）。
export const COMMUNITY = {
  name: '白光AI技术交流群（鲸界Bridge-Linux）',
  number: '1127063335',
  intro: '插件开发、部署踩坑、模型接入，都在这里聊',
  // 加群链接：QQ 群的分享链接，手机点开可直接跳转
  joinUrl: 'https://qm.qq.com/q/RDq35J6PQu',   // 群分享短链（群号拼出来的 /q/<群号> 是无效的，实测 404）
  // 项目主页（两个平台都放，国内访问 Gitee 更稳）
  repo: 'https://github.com/lyyde599/BG-QQagent-v3.0',
  gitee: 'https://gitee.com/liu-yuyu599/BG-QQagent-v3.0',
  // 市场地址（插件 / skill / 内核更新都走这一套）
  market: 'https://market.baiguang211.top'
};

export function getConfig() {
  if (!currentConfig) currentConfig = loadConfig();
  return currentConfig;
}

/**
 * 整段替换 config.plugins（插件配置专用出口）。
 *
 * 为什么需要单独一个函数：`updateConfig` 走 deepMerge，对对象型字段是**递归合并**，
 * 无法表达"删除一个键"（deepMerge 里 null 被当作"不覆盖"）。
 * 而插件配置必须能被清空（作用域覆盖表、广告列表）——否则用户改回不了默认。
 * 这里直接**整段替换**，语义干净，且不影响其它任何配置项。
 *
 * @param {object} nextPlugins 完整的新 plugins 段落（调用方负责基于旧值构造）
 */
export function replacePluginsConfig(nextPlugins) {
  const cur = getConfig();
  currentConfig = { ...cur, plugins: nextPlugins || {} };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(currentConfig, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return currentConfig;
}

/** 更新并持久化配置（浅合并到当前值；patch 里传对象字段则整体替换该字段）。 */
export function updateConfig(patch) {
  currentConfig = deepMerge(getConfig(), patch);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(currentConfig, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return currentConfig;
}

/** 内存态改动（不落盘）——用于运行期覆盖（如自测注入 mock）。 */
export function setRuntimeConfig(cfg) {
  currentConfig = cfg;
}

/** 防抖保存：高频小改动合并写盘。 */
export function scheduleConfigSave() {
  clearTimeout(saveTimers.get('cfg'));
  saveTimers.set('cfg', setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${CONFIG_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(getConfig(), null, 2), 'utf8');
      fs.renameSync(tmp, CONFIG_FILE);
    } catch (error) {
      console.error('[config] 保存失败:', error);
    }
  }, 400));
}

// ── 多身份（身份模式 Identity Mode）──────────────────────────────────────
// 设计要点：
//   物理会话键 baseChatKey（如 private:123456）= 消息"从哪来"；
//   有效会话键 = baseChatKey + ':' + mode（如 private:123456:tutor）；
//   不同身份的历史/记忆/进度天然隔离（store/memory 都按 chatKey 分文件）。

export const DEFAULT_MODE = 'assistant';

/** 拆解 chatKey：kind / id / mode / base。 */
export function parseChatKey(chatKey) {
  const parts = String(chatKey || '').split(':');
  const kind = parts[0] || '';
  const id = parts[1] || '';
  const mode = parts[2] || '';
  return { kind, id, mode, base: `${kind}:${id}` };
}

/** 取某物理会话当前激活的身份模式（未配置或已删除的模式回退默认）。 */
export function getIdentityMode(baseChatKey) {
  const cfg = getConfig();
  const rec = cfg.personaModes?.[baseChatKey];
  const mode = rec?.mode || DEFAULT_MODE;
  if (mode !== DEFAULT_MODE && !cfg.identityModes?.[mode]) return DEFAULT_MODE;
  return mode;
}

/** 设置某物理会话的身份模式并持久化。
 *  注意：deepMerge 对同名字段做"深层合并"，删除 key 会失效，因此显式重建整个对象后整体覆盖。 */
export function setIdentityMode(baseChatKey, mode) {
  const cfg = getConfig();
  // 'default' 是口语化写法，归一成真正的 DEFAULT_MODE（'assistant'）。
  // ⚠️ 2026-09-20 踩过：传入 'default' 不等于 DEFAULT_MODE，delete 分支不生效，
  //    反而写入了 {mode:'default'} 这种无意义状态（虽因回退侥幸表现正确，但语义脏）。
  const raw = String(mode || DEFAULT_MODE);
  const m = (raw === 'default' || raw === 'daily' || raw === 'normal') ? DEFAULT_MODE : raw;
  const next = { ...(cfg.personaModes || {}) };
  if (m === DEFAULT_MODE) delete next[baseChatKey];
  else next[baseChatKey] = { mode: m, switchedAt: Date.now() };
  // 先清空再写入，绕开 deepMerge 的"保留旧键"行为
  getConfig().personaModes = {};
  updateConfig({ personaModes: next });
  return m;
}

/** 物理会话键 → 有效会话键（按当前身份模式追加后缀）。 */
export function resolveChatKey(baseChatKey) {
  const { mode } = parseChatKey(baseChatKey);
  if (mode) return String(baseChatKey);
  const m = getIdentityMode(baseChatKey);
  return m === DEFAULT_MODE ? String(baseChatKey) : `${baseChatKey}:${m}`;
}

/** personaRef → 完整 persona 对象。支持 builtin:<id> / custom:<名或custom_N>。 */
export function resolvePersonaRef(ref) {
  if (!ref) return null;
  const cfg = getConfig();
  const s = String(ref).trim();
  if (s.startsWith('builtin:')) {
    const key = s.slice(8);
    const p = PERSONAS[key];
    if (!p) return null;
    return { botName: p.name, selfNickname: '', roleText: p.text, participation: 'medium', customRules: '', ref: s, key };
  }
  const key = s.startsWith('custom:') ? s.slice(7) : (s.startsWith('persona:') ? s.slice(8) : s);
  const list = cfg.customPersonas || [];
  let found = list.find((p) => p && p.name === key);
  if (!found && /^custom_\d+$/.test(key)) found = list[Number(key.slice(7))];
  if (!found) return null;
  return {
    botName: found.botName || found.name || cfg.persona.botName,
    selfNickname: found.selfNickname ?? '',
    roleText: found.text || '',
    participation: found.participation || cfg.persona.participation,
    customRules: found.customRules || '',
    ref: s.startsWith('custom:') ? s : `custom:${key}`
  };
}

/**
 * 解析某会话键应使用的人设与模式信息。
 * 优先级：personaBindings[有效键] > personaBindings[物理键] > 模式映射表 > 模式人设 > 全局默认。
 */
export function resolvePersona(chatKey) {
  const cfg = getConfig();
  const { base, mode } = parseChatKey(chatKey);
  const activeMode = mode || getIdentityMode(base);
  const modeDef = activeMode === DEFAULT_MODE ? null : (cfg.identityModes?.[activeMode] || null);

  const bindings = cfg.personaBindings || {};
  const ref = bindings[String(chatKey)] || bindings[base] || modeDef?.personaRef || '';
  const fromRef = resolvePersonaRef(ref);

  const persona = fromRef || {
    botName: cfg.persona.botName,
    selfNickname: cfg.persona.selfNickname,
    roleText: cfg.persona.roleText,
    participation: cfg.persona.participation,
    customRules: cfg.persona.customRules,
    ref: ''
  };
  return { persona, mode: activeMode, modeDef, baseChatKey: base };
}
