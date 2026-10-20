// 编排器：事件驱动的"无状态运行"核心。
//
// 流程（对应需求）：
//   机器人空闲 → 用户发言 → 防抖聚批(wakeDelayMs) → 新开会话（一次独立的 agent 处理）
//   → 开始时把所有消息标记为已读（触发批作为【本次唤醒】）→ agent 用工具发言/决定不发言
//   → 会话弃置（不留 LLM 历史）→ 发现 JSON 里有未读 → drainDelayMs 后再新开会话 → …
//   → 直到没有未读 → 回到空闲。
//
// 同一会话（群/私聊）同时最多一个运行；运行期间新消息只写 JSON（未读），不叠加触发。
// 不同会话之间并行，受 maxConcurrentRuns 全局限流。
import { getConfig, resolvePersona, resolveChatKey, parseChatKey, setIdentityMode, getIdentityMode, DEFAULT_MODE } from './config.js';
import { sleep, randInt, createEventBus, todayKey } from './util.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { chatCompletion, addUsage, estimateCost } from './llm.js';
import { buildToolDefs, toOpenAiTools, executeTool, KB_TOOL_NAMES } from './tools.js';
// KB_TOOL_NAMES 迁到了 study 插件；这里做一次兼容取值——插件没装/没启用时为空集，
// 教学工具自然不存在，不会有"该隐藏却暴露"的问题。
import { looksLikeMonologue, looksSpokenToUser } from './monologue-guard.js';
import { modelVisionVerdict } from './vision-scan.js';

/**
 * 去重护栏：判断这段文本是否已在本会话发出过（归一化后比较）。
 * 背景：私聊场景存在多个内容兜底路径（无 toolCalls / 工具前 / finish 后），
 * 同一段 content 可能被多条路径各发一次，造成"同样的消息发两遍"。
 * 独立成模块级函数便于单测。
 */
export function alreadySent(session, text) {
  const norm = String(text || '').replace(/\s+/g, '').trim();
  if (!norm) return true;
  const sent = session?.sent || [];
  for (const item of sent) {
    const prev = String(item?.text || '').replace(/\s+/g, '').trim();
    if (!prev) continue;
    // 完全相同，或一方包含另一方（兜底路径常对同一段文本做不同截断/清理）即视为重复
    if (prev === norm) return true;
    if (norm.length >= 20 && prev.includes(norm)) return true;
    if (prev.length >= 20 && norm.includes(prev)) return true;
  }
  return false;
}

export class Orchestrator {
  constructor({ store, memory, stickers, sender, sessions, onebot, emit = null, pluginHost = null }) {
    this.store = store;
    this.memory = memory;
    this.stickers = stickers;
    this.sender = sender;
    this.sessions = sessions;
    this.onebot = onebot;
    this.emit = typeof emit === 'function' ? emit : ((b) => b.emit.bind(b))(createEventBus());
    // 插件宿主（可空）。工具与提示词段在**每次运行**时向宿主现取，
    // 不用启动时快照 —— 否则面板装/卸插件后必须重启才生效。
    this.pluginHost = pluginHost;
    this.toolDefs = buildToolDefs();

    this.identityPending = new Map();  // baseChatKey -> { to, label, at } 待确认的身份切换
    this.chatNameCache = new Map();    // groupId -> name
    this.wakeTimers = new Map();       // chatKey -> timer
    this.pendingWake = new Set();      // 防抖中等待聚批的 chatKey
    this.consolidating = new Set();    // 正在整理记忆的 chatKey
    this.runningChats = new Set();     // 正在运行的 chatKey
    this.activeRuns = new Map();       // chatKey -> sessionId
    this.runSeq = new Map();           // chatKey -> 第几次处理（跨重启清零即可）
    this.paused = false;
    this.pauseReason = null;
    this.proactiveTimer = null;
    this.aborted = false;
  }

  /**
   * 恢复后处理：所有当前有未读消息的会话都安排一次唤醒，把积压消息补处理掉。
   * 如果模型未配置，wake 会自然跳过（消息保留未读，不丢失）。
   */
  drainBacklogAfterResume() {
    for (const chatKey of this.store.listChats()) {
      if (this.store.unreadCount(chatKey) <= 0) continue;
      // 积压消息同样要先过身份口令检测，否则重启期间发的"开始学习"会被当成普通聊天
      try {
        const intent = this.#detectIdentityIntent(chatKey);
        if (intent) {
          this.#handleIdentityIntent(chatKey, intent).catch((e) =>
            console.error('[identity] 积压处理出错:', e?.message || e));
          continue;
        }
      } catch (e) {
        console.error('[identity] 积压检测出错:', e?.message || e);
      }
      this.scheduleWake(chatKey, 0);
    }
  }

  // ── 入站接口 ───────────────────────────────────────────────────────────

  /** 收到新消息（已通过白名单校验并写入 store）。 */
  onIncoming(chatKey) {
    if (this.paused || this.aborted) return;
    // 身份切换口令：在聚批前拦截（切换本身不消耗 LLM，但会主动回一句确认/结果）
    try {
      const intent = this.#detectIdentityIntent(chatKey);
      if (intent) {
        this.#handleIdentityIntent(chatKey, intent).catch((e) =>
          console.error('[identity] 处理出错:', e?.message || e));
        return;   // 已由切换流程接管，不再交给模型
      }
    } catch (e) {
      console.error('[identity] 切换检测出错:', e?.message || e);
    }
    if (this.runningChats.has(chatKey)) return;   // 运行结束后 drain 会接管
    this.scheduleWake(chatKey);
  }

  /** 执行身份切换意图：发确认问句 / 完成切换 / 取消。 */
  async #handleIdentityIntent(chatKey, intent) {
    const { base: baseKey, kind, id } = parseChatKey(chatKey);
    this.emit('log', { text: '[identity] ' + baseKey + ' ' + intent.action + ' → ' + intent.mode });
    this.store.appendSelf(baseKey, { text: intent.reply, ts: Date.now() });
    this.emit('chat-update', baseKey);
    if (kind && id && this.sender) {
      try {
        await this.sender.sendTextBatch(baseKey, [intent.reply], {});
      } catch (e) {
        console.error('[identity] 发送确认语失败:', e?.message || e);
      }
    }
    // 把已读推进（这条消息由切换到流程消化，不再留给模型）
    this.store.drainUnread(baseKey);
  }

  /**
   * 身份切换口令检测（三段式）：
   *   ① 口令 → 需要确认：记下待确认请求，回复确认问句（由模型/兜底发出）
   *   ② 确认词（好/是/确认…）→ 真正切换
   *   ③ 否定词（不/算了/取消…）→ 放弃切换
   * 匹配用「包含」而非完全相等，并做归一化（去空格/标点），避免"开始学习吧"这类说话方式漏判。
   * 返回：{ action, mode, label, reply } 供调用方决定如何回应；未命中返回 null。
   */
  #detectIdentityIntent(chatKey) {
    const cfg = getConfig();
    const { base: baseKey } = parseChatKey(chatKey);
    // 身份模式表：过滤掉因功能开关而禁用的模式。
    //
    // ⚠️ 2026-10-05 修：原实现是「tutorMode 关闭 → 直接 return null」，
    //    这会把**所有**人设切换一起挡死。当时机器人只当纯群机器人、
    //    唯一模式就是学习模式，所以粗暴 return 没暴露问题。
    //    但现在要用同一套机制做「可选人设」切换（16 个人设靠它切），
    //    再整表禁用就等于人设切换完全失效。
    //    改为**按模式粒度**过滤：只跳过被禁用的那类模式（tutor 系），
    //    其它模式（人设切换等）照常工作。
    const rules = Object.fromEntries(
      Object.entries(cfg.identityModes || {}).filter(([mode, def]) => {
        const isTutor = mode === 'tutor' || def?.tutorMode === true;
        if (isTutor && cfg.features?.tutorMode === false) return false;
        return true;
      })
    );
    if (!Object.keys(rules).length) return null;
    const pending = this.store.recent(baseKey, { limit: 8 }).filter((m) => !m.self && !m.read);
    if (!pending.length) return null;
    const last = pending[pending.length - 1];
    const raw = String(last.text || '').trim();
    // 归一化：去掉空白与常见标点，便于包含匹配
    const norm = raw.replace(/[\s，。！？、,.!?~～…]/g, '');
    if (!norm) return null;

    // 否定/取消优先判断（避免"我不想开始学习"被误判为进入）
    const NEG = ['不', '别', '算了', '取消', '先不', '暂时不'];
    const CANCEL = ['取消', '算了', '不用了', '先不', '不切换'];
    // ⚠️ 必须包含「流程自己教用户说的词」——2026-09-20 事故：
    //    确认问句让用户回「暂停」或「结束」，但列表里没有这两个词，
    //    于是系统从未真正切换，模型却自行编了句"这就退出学习模式"（假成功）。
    //    凡是在 reply 文案里引导用户说的词，都必须在这里可识别。
    const CONFIRM = ['好', '好的', '是', '是的', '确认', '可以', '行', '嗯', '对', '开始吧', '进入吧', '来吧',
      '暂停', '结束', '退出', '下课', '停止', '结束学习', '退出学习', '停止学习', '好嘞'];

    const curMode = getIdentityMode(baseKey);
    const pendingReq = this.identityPending.get(baseKey) || null;

    // ── 阶段②③：存在待确认请求时，先处理确认/取消 ──
    if (pendingReq) {
      // 取消
      if (CANCEL.some((w) => norm.includes(w))) {
        this.identityPending.delete(baseKey);
        return { action: 'cancelled', mode: curMode, label: pendingReq.label, reply: '好的，那就先不切换啦，本鲸继续当前的相处模式～' };
      }
      // 确认（词短且命中，避免长句误判）
      // 匹配放宽：完全相等 / 前缀 / 短句内包含（如"那就结束吧"）
      if (norm.length <= 12 && CONFIRM.some((w) => {
        const nw = w.replace(/[\s，。！？、,.!?~～…]/g, '');
        return norm === nw || norm.startsWith(nw) || (nw.length >= 2 && norm.includes(nw));
      })) {
        this.identityPending.delete(baseKey);
        // 文案按模式类型区分：人设切换说"换人设"，教学类说"上课/下课"。
        // （原实现写死"本鲸/上课"，用在 16 个人设切换上会很怪）
        //
        // ⚠️ 退出时不能只看 pendingReq.to —— 那是 DEFAULT_MODE，rules 里查不到，
        //    于是 isPersona=false，人设退出会错用教学口吻"本鲸先下课"（实测出现）。
        //    所以进入时就把"来源是哪种模式"记下来（fromPersona），退出时据此选文案。
        const isPersona = pendingReq.fromPersona === true
          || (rules[pendingReq.to]?.kind === 'persona')
          || String(pendingReq.to).startsWith('persona:');
        if (pendingReq.to === DEFAULT_MODE) {
          setIdentityMode(baseKey, DEFAULT_MODE);
          return { action: 'switched', mode: DEFAULT_MODE, label: pendingReq.label,
            reply: isPersona ? '好，换回来了～' : '好，那本鲸先下课啦，日常模式回来咯(๑•̀ㅂ•́)و✧' };
        }
        setIdentityMode(baseKey, pendingReq.to);
        return { action: 'switched', mode: pendingReq.to, label: pendingReq.label,
          reply: isPersona ? '好，这就换～' : '好，本鲸这就上课！' };
      }
      // 待确认期间又说了别的 → 清掉待确认，按新消息继续走下面的检测
      this.identityPending.delete(baseKey);
    }

    // ── 阶段①：检测进入/退出口令 ──
    for (const [mode, def] of Object.entries(rules)) {
      const label = def.label || mode;
      const enterHit = (def.enter || []).map(String).filter(Boolean).find((t) => {
        const nt = t.replace(/[\s，。！？、,.!?~～…]/g, '');
        if (!nt || !norm.includes(nt)) return false;
        // 否定词保护：否定词出现在口令词之前 → 视为否定意图
        // 例："我不想开始学习"（不…在"开始学习"之前）→ 不触发
        //     "开始学习吧，别磨蹭"（别…在之后）→ 仍触发
        const at = norm.indexOf(nt);
        const before = norm.slice(0, at);
        if (NEG.some((n) => before.includes(n))) return false;
        return true;
      });
      if (enterHit && curMode !== mode) {
        this.identityPending.set(baseKey, { to: mode, label, at: Date.now() });
        // 文案按类型区分：人设切换说"换人设"（不要用"本鲸/开始"这种教学口吻）
        const isPersonaMode = def?.kind === 'persona' || String(mode).startsWith('persona:');
        return { action: 'ask-enter', mode, label,
          reply: isPersonaMode
            ? '要切成【' + label + '】吗？回一句"好"就换～'
            : '要进入【' + label + '】吗？回一句"好"本鲸就开始～' };
      }
      // 退出口令：仅当当前处于该模式时才问
      const exitHit = (def.exit || []).map(String).filter(Boolean).find((t) => {
        const nt = t.replace(/[\s，。！？、,.!?~～…]/g, '');
        return nt && norm.includes(nt);
      });
      if (exitHit && curMode === mode) {
        const isPersonaMode2 = def?.kind === 'persona' || String(mode).startsWith('persona:');
        // 记下来源：退出时 pendingReq.to 是 DEFAULT_MODE，查不到 rules，只能靠这个标记
        this.identityPending.set(baseKey, { to: DEFAULT_MODE, label, at: Date.now(), fromPersona: isPersonaMode2 });
        return { action: 'ask-exit', mode: DEFAULT_MODE, label,
          reply: isPersonaMode2
            ? '要换回默认人设吗？回一句"好"就换～'
            : '要结束【' + label + '】了吗？回一句"好"本鲸就下课～' };
      }
    }
    return null;
  }

  /** 防抖聚批：等待 wakeDelayMs，期间每来一条消息重置计时。 */
  scheduleWake(chatKey, delay = null) {
    if (this.pendingWake.has(chatKey)) clearTimeout(this.wakeTimers.get(chatKey));
    this.pendingWake.add(chatKey);
    const ms = delay ?? Math.max(0, Number(getConfig().wakeDelayMs) || 2000);
    const timer = setTimeout(() => {
      this.pendingWake.delete(chatKey);
      this.wake(chatKey).catch((error) => console.error(`[orchestrator] wake ${chatKey} 出错:`, error));
    }, ms);
    this.wakeTimers.set(chatKey, timer);
  }

  /** 手动触发一次处理（UI 按钮）。 */
  forceWake(chatKey) {
    if (this.runningChats.has(chatKey)) return false;
    this.scheduleWake(chatKey, 0);
    return true;
  }

  // ── 核心循环 ───────────────────────────────────────────────────────────

  async wake(chatKey, { proactive = false, taskContext = null, pushTask = null } = {}) {
    if (this.aborted) return;
    if (this.paused && !proactive) return;
    // 身份模式：物理键（消息来源）→ 有效键（含身份后缀），实现历史/记忆按身份隔离
    const physKey = String(chatKey);
    const runKey = resolveChatKey(physKey);
    if (this.runningChats.has(runKey)) return;

    // 模型未设置：不产生报错会话，消息保留为未读；设置模型后（下一条消息或手动唤醒）自动补处理
    if (!String(getConfig().api.model || '').trim()) return;

    // 预算保险丝：今日成本达到上限 → 自动暂停，不再发起任何 LLM 调用
    if (this.overBudget()) {
      if (!this.paused) {
        this.setPaused(true, 'budget');
      }
      return;
    }

    // 全局并发限制：满了就稍后重试
    if (this.runningChats.size >= Math.max(1, Number(getConfig().maxConcurrentRuns) || 2)) {
      setTimeout(() => {
        if (!this.runningChats.has(chatKey) && !this.paused && !this.aborted) {
          this.scheduleWake(chatKey, 0);
        }
      }, 3000);
      return;
    }

    // 触发批：当前所有未读（含之前积压的）
    // 触发批必须从「物理键」取——消息总是写入物理键（app.js 落库），
    // 有效键只用于历史/记忆隔离，不存放未读。
    let triggerEntries = proactive ? [] : this.store.drainUnread(physKey);
    if (proactive) {
      // 主动机会：不打扰、无触发批，只带状态
      this.store.drainUnread(physKey); // 把可能的零星未读一并处理掉
    }
    if (!proactive && triggerEntries.length === 0) return; // 没有未读就不空跑

    this.runningChats.add(runKey);
    const seq = (this.runSeq.get(runKey) || 0) + 1;
    this.runSeq.set(runKey, seq);
    const { kind, id: chatId } = parseChatKey(runKey);

    // 触发摘要
    const first = triggerEntries[0];
    const triggerSummary = proactive
      ? '主动机会（冷场开话题）'
      : (first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '');

    const session = this.sessions.create({ chatKey: runKey, trigger: triggerEntries, triggerSummary });
    this.activeRuns.set(runKey, session.id);
    this.emit('session-start', { sessionId: session.id, chatKey: runKey, triggerSummary });
    this.emit('chat-update', runKey);

    try {
      await this.#runAgent(session, { kind, chatId, chatKey: runKey, triggerEntries, proactive, seq, taskContext, pushTask });
    } catch (error) {
      session.error = String(error?.message ?? error);
      this.sessions.finish(session.id, 'error');
      this.emit('session-end', { sessionId: session.id, chatKey: runKey, status: 'error', error: session.error });
      console.error(`[orchestrator] 运行 ${session.id} 出错:`, error);
    } finally {
      this.activeRuns.delete(runKey);
      this.runningChats.delete(runKey);
      this.emit('chat-update', runKey);
    }

    // drain：运行期间来的新消息 → 再次新开会话处理（这是"确保看到所有发言"的关键）
    if (!this.aborted && !this.paused) {
      // 本次运行刚花了钱：结束后再查一次预算，超限就地熔断
      if (this.overBudget()) {
        this.setPaused(true, 'budget');
        return;
      }
      const unread = this.store.unreadCount(physKey);
      if (unread > 0) {
        const drainDelay = Math.max(200, Number(getConfig().drainDelayMs) || 1200);
        setTimeout(() => {
          if (!this.runningChats.has(runKey) && !this.paused && !this.aborted) {
            this.wake(runKey).catch((error) => console.error(`[orchestrator] drain ${runKey} 出错:`, error));
          }
        }, drainDelay);
      }
    }

    // 记忆自动整理（后台静默，绝不阻塞/影响聊天主流程）
    this.#maybeConsolidateMemory(chatKey);
  }

  async #runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, taskContext = null, pushTask = null }) {
    const cfg = getConfig();
    const chatName = kind === 'group' ? await this.#chatName(chatId) : '';
    const ident0 = resolvePersona(chatKey);
    const p0 = ident0.persona;
    const selfNickname = kind === 'group' ? (p0.selfNickname || this.onebot.selfNickname || p0.botName) : p0.botName;

    // 上下文统计
    const tenMinAgo = Date.now() - 600000;
    const recentCount = this.store.recent(chatKey, { limit: 200 }).filter((m) => m.ts >= tenMinAgo).length;
    const myMessages = this.store.recent(chatKey, { limit: 100 }).filter((m) => m.self);
    const selfLastMessageAt = myMessages.length ? myMessages[myMessages.length - 1].ts : 0;
    const lastMessageAt = (() => {
      const all = this.store.recent(chatKey, { limit: 10 });
      return all.length ? all[all.length - 1].ts : Date.now();
    })();

    // 表情库快照（提示词用）
    let stickerEntries = [];
    if (cfg.sticker?.enabled !== false) {
      try { stickerEntries = (await this.stickers.sync(false)).entries ?? []; } catch { stickerEntries = []; }
    }

    // 身份解析：按会话键决定人设（多身份核心接线）
    const ident = resolvePersona(chatKey);
    const persona = ident.persona;
    if (ident.modeDef && String(ident.modeDef.extraPrompt || '').trim()) {
      persona.customRules = [persona.customRules, ident.modeDef.extraPrompt].filter(Boolean).join('\n\n');
    }
    // 学习模式：每次运行实时注入「今日学习任务」（先温故、后知新）。
    // 原先进度是写死在 extraPrompt 里的快照（注释声称自动注入，实际无人更新），越用越失真。
    if (ident.mode === 'tutor') {
      try {
        const { todayTasks, formatToday } = await import('./study-plan.js');
        const uin = String(chatId || '');
        persona.customRules = String(persona.customRules || '') + '\n\n' + formatToday(todayTasks(uin));
      } catch (e) {
        this.log?.('[study-plan] 注入今日任务失败：' + (e?.message ?? e));
      }
    }

    // 组装提示词（无 LLM 历史）
    // 插件提示词段现取：面板装卸插件后下一次运行即生效。
    const pluginSections = this.pluginHost ? this.pluginHost.buildPromptBlocks({ chatKey, kind, chatId }) : [];
    const systemPrompt = buildSystemPrompt({ persona, extraSections: pluginSections });
    const userPrompt = buildUserPrompt({
      chatKey, kind, chatId, chatName,
      triggerEntries,
      store: this.store,
      memory: this.memory,
      stickerEntries,
      selfNickname: persona.selfNickname || selfNickname,
      persona,
      mode: ident.mode,
      modeDef: ident.modeDef,
      taskContext,
      pushTask,
      selfLastMessageAt,
      lastMessageAt,
      recentCount,
      runSeq: seq,
      moreUnreadDuringRun: this.store.unreadCount(chatKey) > 0,
      proactive
    });

    session.systemPrompt = systemPrompt;
    session.userPrompt = userPrompt;
    session.promptChars = systemPrompt.length + userPrompt.length;
    session.model = cfg.api.model;
    session.chatName = chatName;
    this.sessions.update(session.id);
    this.emit('session-update', session.id);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: proactive
        ? `${userPrompt}\n\n【本次唤醒】（主动机会）群里已经安静了一会儿。你可以主动抛一个自然的话题（像随口说的，不要像播报），也可以判断没必要说话就安静结束。`
        : userPrompt }
    ];

    // 工具集按配置过滤：无视觉模型 → 移除看图工具；搜索关闭 → 移除联网工具
    // 视觉判定 = 全局开关 && 选中模型未被探测为"明确不支持图片"（未探测/unknown 时保持开关行为）
    const visionEnabled = cfg.api.vision !== false
      && modelVisionVerdict(cfg.api.provider, cfg.api.model) !== 'no-vision';
    // 主人判断：私聊（master QQ）或触发消息来自主人（在工具过滤前计算）
    const MASTER_QQ = String(getConfig().persona?.masterQQ || '');
    const triggerSender = (triggerEntries[0] && (triggerEntries[0].senderId || '')) || '';
    const isMaster = kind === 'private' ? String(chatId) === MASTER_QQ : String(triggerSender) === MASTER_QQ;
    const searchEnabled = cfg.webSearch?.enabled !== false;
    // 插件工具现取（面板装卸后即时生效，无需重启）。宿主为空则等同旧行为。
    const pluginTools = this.pluginHost ? this.pluginHost.allToolDefs() : [];
    const toolDefs = [...this.toolDefs, ...pluginTools].filter((d) => {
      if (!visionEnabled && (d.name === 'get_message_images' || d.name === 'get_sticker_image')) return false;
      if (!searchEnabled && (d.name === 'web_search' || d.name === 'web_fetch')) return false;
      // 主人专属工具：仅主人触发时挂载（群友/他人触发时模型看不到这些工具）
      if (d.masterOnly && !isMaster) return false;
      // 工具自带可用性判定（插件可用它做细粒度开关，如 teacher_control 的双开关）。
      // 判定函数抛错一律视为"不可用"——宁可少给一个工具，也不让坏插件把整轮运行搞崩。
      if (typeof d.available === 'function') {
        try { if (!d.available(cfg)) return false; }
        catch { return false; }
      }
      // 知识库工具：仅在「学习模式」身份下挂载（日常身份不暴露教学工具，省 token 防误用）
      // 知识库工具在「学习模式」或全局 tutorMode 开启时才挂载
      // 教学工具按身份过滤（名单来自 study 插件；插件未装则为空集，此判断自然不生效）
      const kbNames = this.pluginHost?.kbToolNames?.() || KB_TOOL_NAMES;
      if (kbNames.has(d.name) && ident.mode !== 'tutor' && cfg.features?.tutorMode !== true) return false;
      return true;
    });
    const openAiTools = toOpenAiTools(toolDefs);

    const ctx = {
      chatKey, kind, chatId,
      selfId: this.onebot.selfId,
      selfNickname,
      botName: persona.botName,
      persona,
      mode: ident.mode,
      modeDef: ident.modeDef,
      pushTask,
      onebot: this.onebot,
      store: this.store,
      memory: this.memory,
      stickers: this.stickers,
      sender: this.sender,
      session,
      emit: (type, payload) => this.emit(type, payload),
      isMaster
    };

    const maxRounds = Math.max(1, Number(cfg.api.maxRounds) || 12);
    let finish = false;
    for (let round = 0; round < maxRounds && !finish; round++) {
      if (this.aborted) { this.sessions.finish(session.id, 'aborted'); return; }
      const response = await chatCompletion({ messages, tools: openAiTools });
      session.model = response.model || session.model;
      addUsage(session.usage, response.usage);
      session.usage.calls += 1;

      const msg = response.message;
      const assistantEntry = {
        role: 'assistant',
        content: typeof msg.content === 'string' ? msg.content : (msg.content ?? null),
        tool_calls: msg.tool_calls ?? undefined
      };
      messages.push(assistantEntry);
      session.messages.push(structuredClone(assistantEntry));
      session.rounds = round + 1;
      this.sessions.update(session.id);
      this.emit('session-update', session.id);

      let toolCalls = msg.tool_calls ?? [];
      // 兼容：少数模型把工具调用写成文本而不是原生 tool_calls。解析成功后需要把
      // 该 assistant 消息改成 tool_calls 形态回填 messages，并追加真正的 tool 结果。
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      let inlineCalls = [];
      if (!toolCalls.length && rawContent) {
        inlineCalls = parseInlineToolCalls(rawContent);
      }
      if (inlineCalls.length) {
        toolCalls = inlineCalls.map((c, i) => ({
          id: `inline_${round}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
        }));
        // 替换最后一条 assistant 消息：文本清空、附加 tool_calls，避免后续请求报错
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
          last.content = null;
          last.tool_calls = toolCalls;
        }
        const uiLast = session.messages[session.messages.length - 1];
        if (uiLast?.role === 'assistant') {
          uiLast.content = null;
          uiLast.tool_calls = structuredClone(toolCalls);
          uiLast.inlineParsed = true;
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }

      if (!toolCalls.length) {
        // 兜底（仅私聊）：模型把回复写在 content 里没调 send_message 时自动发出（清理 XML 残留）。
        // 群聊不兜底——模型看到消息后若决定回复会主动调 send_message；不调 = 自主选择不回复（正常），
        // 若把它的内心独白/决策文本兜底发出去，就会变成"每条都回/自言自语刷屏"。
        const isPrivateChat = String(ctx.chatKey || '').startsWith('private:');
        const directText = isPrivateChat ? (typeof msg?.content === 'string' ? msg.content : '').trim() : '';
        const monoA = directText ? looksLikeMonologue(directText, { hasSendMessage: false }) : { think: false };
        if (monoA.think) this.emit('log', { text: '[独白拦截/A] ' + directText.slice(0, 50) });
        if (!monoA.think && directText && directText.length <= 2000 && !/^[\[\]{}()<>\s]+$/.test(directText)) {
          const cleaned = directText
            .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
            .replace(/<\/?parameter>|<\/?invoke>|<\/?function_calls>/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (cleaned && cleaned.length >= 1 && !/^<\/?/.test(cleaned)
              && !alreadySent(ctx.session, cleaned)) {
            try {
              const r = await ctx.sender.sendTextBatch(ctx.chatKey, cleaned, {});
              ctx.session.sent.push(...r.sent.map((x) => ({ type: 'text', text: x.text })));
              ctx.emit('session-update', ctx.session.id);
              this.emit('log', { text: '[兜底发送] 模型直接输出已发出: ' + cleaned.slice(0, 60) });
            } catch (e) {
              this.emit('log', { text: '[兜底发送失败] ' + (e?.message || e) });
            }
          }
        }
        // 没有工具调用 = 模型结束思考
        // 没有工具调用 = 模型结束思考（文本不会发给 QQ）
        break;
      }

      // ── 每轮工具调用前：content 兜底（2026-09-14 收紧）──
      // 🔴 事故复盘：用户反馈机器人"经常把思考内容发给我"（"已出题，等学生作答"、
      //    "让我查看复习队列的 key"、工具状态等）。
      //    统计 160 条真实记录 / 33 个"调了工具且带 content"的轮次后发现：
      //      · 其中含第二人称（你/同学）的只有 2 条，**且那 2 条也是思考**
      //      · 结论：**模型调工具时写的 content 几乎必然是思考，不是对主人说的话**
      //    旧逻辑把它当"边说边做"直接发出 → 大量独白泄漏到聊天。
      // 现在的规则：有工具调用时，**只发严格判定为"确实在对主人说话"的文本**；
      //    其余一律不发（模型要说话就该调 send_message）。
      {
        const privateChat = String(ctx.chatKey || '').startsWith('private:');
        const roundText = (typeof msg?.content === 'string' ? msg.content : '').trim();
        const roundHasSend = toolCalls.some((c) => (c?.function?.name ?? '') === 'send_message');
        const monoC = roundText ? looksLikeMonologue(roundText, { hasSendMessage: roundHasSend }) : { think: false };
        // 严格正向判定：必须"明确在对主人说话"才允许兜底发出。
        // 注意这里与 monoC.think 是两道独立闸门——只要任一认为可疑就不发。
        const spokenOk = roundText ? looksSpokenToUser(roundText) : false;
        if (monoC.think || (roundText && !spokenOk)) {
          this.emit('log', { text: '[独白拦截/C] ' + roundText.slice(0, 50) });
        }
        if (spokenOk && !monoC.think && privateChat && roundText && roundText.length <= 2000) {
          const cleanedRound = roundText
            .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
            .replace(/<\/?parameter>|<\/?invoke>|<\/?function_calls>/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (cleanedRound && cleanedRound.length >= 1 && !/^<\/?/.test(cleanedRound)
              && !alreadySent(ctx.session, cleanedRound)) {
            try {
              const rRound = await ctx.sender.sendTextBatch(ctx.chatKey, cleanedRound, {});
              ctx.session.sent.push(...rRound.sent.map((x) => ({ type: 'text', text: x.text })));
              this.emit('log', { text: '[工具前兜底] content 已发出: ' + cleanedRound.slice(0, 50) });
            } catch (e) {
              this.emit('log', { text: '[工具前兜底失败] ' + (e?.message || e) });
            }
          }
        }
      }

      const toolResults = [];
      const imageUserMessages = [];
      for (const call of toolCalls) {
        const name = call?.function?.name ?? '';
        const argsRaw = call?.function?.arguments ?? '{}';
        const result = await executeTool(toolDefs, ctx, name, argsRaw);
        // 工具结果：文本走 tool 消息；图片（parts 数组）不能塞进 tool 消息——
        // 很多 OpenAI 兼容端点不接受。做法：tool 消息只带文本，图片随后以 user 消息补发
        // （[{type:'text'},{type:'image_url'}]），这是兼容面最广的视觉输入方式。
        let contentStr = '';
        let images = [];
        if (Array.isArray(result.content)) {
          contentStr = result.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          images = result.content.filter((p) => p.type === 'image_url');
        } else {
          contentStr = String(result.content);
        }
        toolResults.push({ role: 'tool', tool_call_id: call.id, name, content: contentStr, isError: !!result.isError });
        session.messages.push({ toolCall: { name, args: safeParse(argsRaw), result: contentStr.slice(0, 2000), isError: !!result.isError } });
        if (images.length) {
          imageUserMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[系统：以下是工具 ${name} 返回的 ${images.length} 张图片，请直接"看图"回应]` },
              ...images
            ]
          });
          session.messages.push({ toolImages: { tool: name, count: images.length } });
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
        if (name === 'finish') {
          finish = true;
          // 修复：模型调 finish 收尾时，若它把话写在 content 里没走 send_message → 私聊兜底发出
          const privateChat = String(ctx.chatKey || '').startsWith('private:');
          const finContent = (typeof msg?.content === 'string' ? msg.content : '').trim();
          // finish 轮若同时调了 send_message，content 同样是内心独白（该轮常伴随"总结收尾"式独白）
          const finHasSend = toolCalls.some((c) => (c?.function?.name ?? '') === 'send_message');
          const monoB = finContent ? looksLikeMonologue(finContent, { hasSendMessage: finHasSend }) : { think: false };
          // 同路径C：finish 轮的 content 也多为独白（"本轮结束"之类），需严格正向判定
          const spokenOkB = finContent ? looksSpokenToUser(finContent) : false;
          if (monoB.think || (finContent && !spokenOkB)) this.emit('log', { text: '[独白拦截/B] ' + finContent.slice(0, 50) });
          if (spokenOkB && !monoB.think && privateChat && finContent && finContent.length <= 2000) {
            const cleanedFin = finContent
              .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
              .replace(/<\/?parameter>|<\/?invoke>|<\/?function_calls>/gi, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            if (cleanedFin && cleanedFin.length >= 1 && !/^<\/?/.test(cleanedFin)
                && !alreadySent(ctx.session, cleanedFin)) {
              try {
                const rFin = await ctx.sender.sendTextBatch(ctx.chatKey, cleanedFin, {});
                ctx.session.sent.push(...rFin.sent.map((x) => ({ type: 'text', text: x.text })));
                this.emit('log', { text: '[finish兜底] content 已发出: ' + cleanedFin.slice(0, 60) });
              } catch (e) {
                this.emit('log', { text: '[finish兜底失败] ' + (e?.message || e) });
              }
            }
          }
        }
      }
      messages.push(...toolResults.map(({ role, tool_call_id, name, content }) => ({ role, tool_call_id, content, name })));
      // 图片消息跟随在全部 tool 结果之后（OpenAI 校验要求每个 tool_call 都有对应 tool 消息）
      messages.push(...imageUserMessages);
      // 给 UI 的简化消息流（跳过纯 tool 结果的重复展示）
    }

    // 收尾：发过话 = done；没发 = noreply（这是正常选项）
    let status = session.error ? 'error' : (session.sent.length > 0 ? 'done' : 'noreply');
    // ── 私聊必回铁律（兜底重试）────────────────────────────
    // 私聊且模型本轮思考了却什么都没发（没调 send_message、content 也空）：
    // 再给一次机会强制让它回复，避免"私聊了却不回复"。最多重试 2 次。
    if (!session.error && status === 'noreply' && String(ctx.chatKey || '').startsWith('private:')) {
      const MASTER_QQ = String(getConfig().persona?.masterQQ || '');
      if (String(ctx.chatId || '') === MASTER_QQ) {
        let retried = 0;
        while (retried < 2 && session.sent.length === 0 && !this.aborted && !this.paused) {
          retried++;
          try {
            const retryMsg = [
              { role: 'system', content: buildSystemPrompt({
                persona: ctx.persona,
                extraSections: this.pluginHost ? this.pluginHost.buildPromptBlocks({ chatKey: ctx.chatKey, kind: ctx.kind, chatId: ctx.chatId }) : []
              }) },
              { role: 'user', content: '【系统提醒】你刚才收到主人的私聊消息，但没有给出任何回复就结束了。私聊规则：主人私聊你时必须回复，不能不吭声。请立即补上回复：如果刚才在查资料/思考，现在把结论发给主人（用 send_message）；如果没什么可说的，也至少要回一句简短的回应（比如"收到~刚在查，马上给你说"）。' }
            ];
            const { chatCompletion } = await import('./llm.js');
            const resp = await chatCompletion({ messages: retryMsg, temperature: 0.6 });
            const retryText = String(resp?.message?.content || '').trim();
            if (retryText) {
              const cleaned = retryText.replace(/<\/?[a-zA-Z][^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
              if (cleaned && cleaned.length >= 1 && cleaned.length <= 2000) {
                const r2 = await ctx.sender.sendTextBatch(ctx.chatKey, cleaned, {});
                ctx.session.sent.push(...r2.sent.map((x) => ({ type: 'text', text: x.text })));
                status = 'done';
                this.emit('log', { text: '[必回重试] 已补发回复: ' + cleaned.slice(0, 60) });
              }
            }
          } catch (e) {
            console.error('[必回重试] 出错:', e?.message || e);
            break;
          }
        }
      }
    }


    this.sessions.finish(session.id, status);
    this.emit('session-end', {
      sessionId: session.id,
      chatKey,
      status,
      sent: session.sent.length,
      finishReason: session.finishReason,
      usage: session.usage,
      cost: estimateCost(session.usage)
    });
  }

  async #chatName(groupId) {
    if (this.chatNameCache.has(groupId)) return this.chatNameCache.get(groupId);
    try {
      const info = await this.onebot.getGroupInfo(groupId);
      if (info?.group_name) {
        this.chatNameCache.set(groupId, String(info.group_name));
        return String(info.group_name);
      }
    } catch { /* 拿不到就用群号 */ }
    return '';
  }

  // ── 主动开话题 ─────────────────────────────────────────────────────────

  startProactiveLoop() {
    this.stopProactiveLoop();
    const tick = async () => {
      const cfg = getConfig();
      const next = randInt(
        Math.max(60000, Number(cfg.proactive?.checkIntervalMinMs) || 1800000),
        Math.max(120000, Number(cfg.proactive?.checkIntervalMaxMs) || 5400000)
      );
      this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, next);
      if (this.aborted || this.paused || cfg.proactive?.enabled !== true) return;
      if (this.runningChats.size >= Math.max(1, Number(cfg.maxConcurrentRuns) || 2)) return;
      if (Math.random() > (Number(cfg.proactive?.probability) || 0.25)) return;
      // 挑一个"安静且允许"的群
      const candidates = this.#proactiveCandidates(cfg);
      if (!candidates.length) return;
      const chatKey = candidates[Math.floor(Math.random() * candidates.length)];
      this.wake(chatKey, { proactive: true }).catch((error) => console.error('[orchestrator] proactive 出错:', error));
    };
    this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, 15000);
  }

  #proactiveCandidates(cfg) {
    const idleMs = Math.max(300000, Number(cfg.proactive?.idleThresholdMs) || 1800000);
    const allowGroups = (cfg.allow?.groups ?? []).map(String);
    const out = [];
    for (const chatKey of this.store.listChats()) {
      const [kind, id] = chatKey.split(':');
      if (kind !== 'group') continue;
      if (allowGroups.length > 0 ? !allowGroups.includes(id) : !cfg.allowAllWhenEmpty) continue;
      const meta = this.store.getChatMeta(chatKey);
      if (meta.unread > 0) continue;
      if (Date.now() - meta.lastTs < idleMs) continue;
      if (this.runningChats.has(chatKey)) continue;
      out.push(chatKey);
    }
    return out;
  }

  // ── 记忆自动整理 ──
  // 触发条件（二者同时满足）：某类记忆超过阈值，且距上次整理超过冷却时间。
  // 频率与方法的权衡：整理本身是一次便宜的 LLM 调用，但没必要频繁跑——
  // 记忆只在 agent 使用 memory_append 时增长，阈值触发 + 6 小时冷却足够防止膨胀。
  static MEMORY_THRESHOLDS = { activeTopic: 8, pendingThought: 8, memberImpression: 18 };

  #maybeConsolidateMemory(chatKey) {
    try {
      const cfg = getConfig();
      if (cfg.memory?.consolidateEnabled === false) return;
      if (this.paused || this.aborted) return;
      if (!cfg.api?.model || !cfg.api?.baseUrl) return;   // 没选模型就不整理
      if (this.consolidating.has(chatKey)) return;
      const st = this.memory.consolidationState(chatKey);
      const T = Orchestrator.MEMORY_THRESHOLDS;
      const over = st.counts.activeTopic > T.activeTopic
        || st.counts.pendingThought > T.pendingThought
        || st.counts.memberImpression > T.memberImpression;
      if (!over) return;
      const minInterval = Math.max(30 * 60 * 1000, Number(cfg.memory?.consolidateMinIntervalMs) || 6 * 60 * 60 * 1000);
      if (Date.now() - (st.lastConsolidatedAt || 0) < minInterval) return;
      this.consolidating.add(chatKey);
      this.#consolidateMemory(chatKey)
        .catch((error) => console.error(`[memory] 整理 ${chatKey} 失败:`, error?.message ?? error))
        .finally(() => this.consolidating.delete(chatKey));
    } catch { /* 整理是锦上添花，绝不影响聊天主流程 */ }
  }

  async #consolidateMemory(chatKey) {
    const st = this.memory.query(chatKey);
    const total = st.activeTopic.length + st.pendingThought.length + st.memberImpression.length;
    if (total === 0) return;
    const fmtTs = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    const lines = ['【进行中的话题】'];
    for (const e of st.activeTopic) lines.push(`- (${fmtTs(e.createdAt)}) ${e.content}`);
    lines.push('【想说但还没说的话】');
    for (const e of st.pendingThought) lines.push(`- (${fmtTs(e.createdAt)}) ${e.content}`);
    lines.push('【对群友的印象】');
    for (const e of st.memberImpression) lines.push(`- ${e.target || '某人'}：${e.content} (${fmtTs(e.createdAt)})`);

    const messages = [
      {
        role: 'system',
        content: '你是聊天机器人的记忆整理模块。你只做合并、改写与删除，绝不发明任何新事实。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"activeTopic":["…"],"pendingThought":["…"],"memberImpression":[{"target":"群友QQ号或名字","content":"…"}]}'
      },
      {
        role: 'user',
        content: [
          '下面是机器人对某个聊天的长期记忆，请整理：',
          '1. 进行中的话题：同属一个话题的多条记录合并成一条最新的；明显已经聊完的、或超过 3 天且已过时的删除；最多保留 6 条，每条不超过 120 字。',
          '2. 想说但还没说的话：合并重复的；超过 1 天的旧念头删除；最多保留 6 条。',
          '3. 对群友的印象：同一个人有多条印象时合并成一条综合印象（target 保留原值），以最新观感为主；最多 15 条，每条不超过 120 字。',
          '原则：所有信息只能来自原文，语义不变，宁少勿错；空类别输出空数组。',
          '',
          ...lines
        ].join('\n')
      }
    ];
    const res = await chatCompletion({ messages, temperature: 0.2 });
    const text = String(res?.message?.content ?? '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn('[memory] 整理结果不是合法 JSON，本轮放弃（原记忆未动）');
      return;
    }
    const afterCount = (Array.isArray(parsed.activeTopic) ? parsed.activeTopic.length : 0)
      + (Array.isArray(parsed.pendingThought) ? parsed.pendingThought.length : 0)
      + (Array.isArray(parsed.memberImpression) ? parsed.memberImpression.length : 0);
    if (afterCount > total) {
      console.warn(`[memory] 整理结果条数（${afterCount}）比原来（${total}）还多，疑似幻觉，本轮放弃`);
      return;
    }
    const norm = this.memory.replaceConsolidated(chatKey, parsed);
    const n = norm.activeTopic.length + norm.pendingThought.length + norm.memberImpression.length;
    console.log(`[memory] 记忆整理 ${chatKey}：${total} 条 → ${n} 条（原记忆已备份到 data/memory/backups/）`);
  }

  stopProactiveLoop() {
    clearTimeout(this.proactiveTimer);
    this.proactiveTimer = null;
  
  
}

  // ── 控制接口 ───────────────────────────────────────────────────────────

  /** 今日估算成本是否已达到预算上限（budget.dailyCostYuan=0 时不限制）。 */
  overBudget() {
    const cap = Number(getConfig().budget?.dailyCostYuan) || 0;
    if (cap <= 0) return false;
    const usage = this.sessions.todayUsage(todayKey());
    return estimateCost(usage) >= cap;
  }

  setPaused(paused, reason = 'manual') {
    this.paused = !!paused;
    this.pauseReason = this.paused ? reason : null;
    this.emit('status', { paused: this.paused, pauseReason: this.pauseReason });
  }

  async abortAll() {
    this.aborted = true;
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    this.pendingWake.clear();
    this.stopProactiveLoop();
  }

  /** DSH 任务完成 watcher：轮询 pendingDshTasks，完成后主动向主人汇报。 */
  startDshWatcher() {
    if (this.dshWatcherTimer) return;
    const tick = async () => {
      try {
        const { pendingDshTasks, pollDshTask, markTaskCompleted, cleanupExpiredProducts, unregisterDshTask, markDshReported, savePendingTasks } = await import('./dsh-task.js');
        for (const [sessionId, entry] of [...pendingDshTasks]) {
          if (entry.reported) { pendingDshTasks.delete(sessionId); continue; }
          // 放宽单次窗口：避免 DSH 刚建目录、会话还没 running 起来就被判"完成"
          const res = await pollDshTask(sessionId, entry.workDir, { timeoutMs: 20000, intervalMs: 5000 });
          const chatKey = String(entry.chatKey || '');
          const canReport = chatKey.startsWith('group:') || chatKey.startsWith('private:');

          // ── 未完成：只按 DSH 的**真实状态**处理，绝不靠"超时"猜失败 ──
          if (!res.done) {
            // res.state: running | idle | missing | unreachable | finished
            // 只要 DSH 说还在跑，就安静等待（这是正常状态，不累计失败）
            if (res.state === 'running') continue;

            // 查询失败（DSH 忙/超时）：同样不做失败推断，下轮再看
            if (res.state === 'unreachable') continue;

            // 只有「会话不存在」或「长期未开跑」才是真异常，且给出充分的等待时间
            const cur = pendingDshTasks.get(sessionId) || entry;
            if (cur.failedReported) continue;                  // 已报过就永不再报
            const ageMs = Date.now() - (cur.submittedAt || Date.now());
            const longEnough = ageMs > 5 * 60 * 1000;          // 给足 5 分钟
            if (!longEnough || !canReport) continue;

            cur.failedReported = true;
            cur.reported = true;
            pendingDshTasks.set(sessionId, cur);
            savePendingTasks();
            try {
              const why = res.state === 'missing'
                ? 'DSH 侧找不到这个任务会话'
                : '任务提交后一直没有开始执行';
              await this.sender.sendTextBatch(chatKey, [
                '⚠️ 刚才那个 DSH 任务好像没跑起来：' + why + '。',
                '要不要本鲸重新提交一次？'
              ], {});
              this.emit('log', { text: '[DSH任务] 已汇报异常(仅此一次): ' + cur.workDir });
            } catch (e) {
              this.emit('log', { text: '[DSH任务] 异常汇报失败: ' + (e?.message || e) });
            }
            continue;
          }

          // ── 判定完成：先落盘标记（幂等且重启不丢），再唤起白鲸本人汇报 ──
          markDshReported(sessionId);
          if (!canReport) { unregisterDshTask(sessionId); continue; }
          try {
            const files = res.files || [];
            const real = files.filter((f) => (f.dir ? (f.entries || 0) > 0 : (f.size || 0) > 0));
            const normFiles = real.map((f) => ({ name: f.name, size: f.size || 0, dir: !!f.dir }));
            // 找 DSH 写好的"回给主人"稿件（约定文件名含「回给主人」）
            let reportFile = '', reportText = '';
            try {
              const fsmod = await import('node:fs');
              const pathmod = await import('node:path');
              const cand = real.find((f) => !f.dir && /回给主人|汇报|report|summary/i.test(f.name) && /\.(txt|md)$/i.test(f.name));
              if (cand) {
                reportFile = cand.name;
                reportText = fsmod.readFileSync(pathmod.join(entry.workDir, cand.name), 'utf8').slice(0, 2500);
              }
            } catch { /* 读不到就算了 */ }

            // 唤起白鲸本人：把任务回执注入上下文，让它用自己的话精简汇报
            this.emit('log', { text: '[DSH任务] 完成，唤起白鲸汇报: ' + entry.workDir + ' 依据=' + (res.reason || '') });
            // 注意：这里 await——汇报成功后才把条目从待汇报表移除，
            // 若汇报失败则保留条目，下一轮 tick 会重试（避免"跑完了但没人说"）。
            await this.wake(chatKey, {
              proactive: true,
              taskContext: {
                kind: 'DSH 后台任务',
                name: entry.taskName || '',
                taskText: entry.taskText || '',
                workDir: entry.workDir,
                files: normFiles,
                empty: !real.length,
                reportFile,
                reportText
              }
            });
            unregisterDshTask(sessionId);
            if (real.length) markTaskCompleted(entry.workDir);
          } catch (e) {
            this.emit('log', { text: '[DSH任务] 汇报失败（下轮重试）: ' + (e?.message || e) });
          }
        }
      } catch (e) {
        this.emit('log', { text: '[DSH watcher] ' + (e?.message || e) });
      }
      // 产物时效：清理超过 1 小时的已完成任务目录
      try {
        const removed = cleanupExpiredProducts();
        if (removed.length) this.emit('log', { text: '[DSH产物清理] 已删除过期产物: ' + removed.join(', ') });
      } catch (e) {
        this.emit('log', { text: '[DSH产物清理] ' + (e?.message || e) });
      }
    };
    this.dshWatcherTimer = setInterval(tick, 10000);
    if (this.dshWatcherTimer.unref) this.dshWatcherTimer.unref();
  }

  stopDshWatcher() {
    if (this.dshWatcherTimer) { clearInterval(this.dshWatcherTimer); this.dshWatcherTimer = null; }
  }

  statusSummary() {
    const cfg = getConfig();
    return {
      paused: this.paused,
      pauseReason: this.pauseReason ?? null,
      overBudget: this.overBudget(),
      running: [...this.runningChats],
      activeSessions: [...this.activeRuns.entries()].map(([chatKey, sessionId]) => ({ chatKey, sessionId })),
      onebotConnected: this.onebot.connected,
      model: cfg.api.model,
      maxConcurrentRuns: cfg.maxConcurrentRuns
    };
  }
}

function safeParse(text) {
  try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return { raw: String(text).slice(0, 500) }; }
}

// ── 内联工具调用解析（少数模型不返回原生 tool_calls，而是把调用写进文本） ──
// 支持的格式：
//   1. <tool_call> <function=send_message> <parameter=messages>…</parameter> </function> </tool_call>
//   2. <tool_call> {"name":"send_message","arguments":{...}} </tool_call>
//   3. <tool_call> send_message \n {"messages":"..."} </tool_call>
// 返回 [{ name, args }]；没有解析到则返回 []。
export function parseInlineToolCalls(text) {
  const out = [];
  const blockRe = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
  let match;
  while ((match = blockRe.exec(String(text || ''))) !== null) {
    const block = match[1].trim();
    if (!block) continue;
    const call = parseInlineBlock(block);
    if (call) out.push(call);
  }
  return out;
}

function parseInlineBlock(block) {
  // 1) 整个块是 JSON：{"name": "...", "arguments": {...}}（部分模型用 parameters/args）
  const jsonMatch = block.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const name = obj.name || obj.function || obj.tool;
      const args = obj.arguments || obj.parameters || obj.args || obj.input || {};
      if (name) return { name: String(name), args: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {} };
    } catch { /* 不是 JSON，继续按 XML 解析 */ }
  }

  // 2) <function=send_message> + <parameter=key>value</parameter>
  const fnMatch = block.match(/<function\s*=\s*([^>]+)>/i);
  let name = fnMatch ? fnMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  const args = {};
  const paramRe = /<parameter\s*=\s*([^>]+)>([\s\S]*?)<\/parameter>/gi;
  let pm;
  while ((pm = paramRe.exec(block)) !== null) {
    const key = pm[1].trim().replace(/^["']|["']$/g, '');
    let value = pm[2].trim();
    try { value = JSON.parse(value); } catch { /* 保持原始文本 */ }
    args[key] = value;
  }
  if (name && fnMatch) return { name, args };

  // 3) 首行是函数名，其余是 JSON 参数（GLM/Qwen 部分格式）
  const lines = block.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!name && lines.length >= 2 && /^[a-zA-Z_][\w.-]*$/.test(lines[0])) {
    name = lines[0];
    try {
      const parsed = JSON.parse(lines.slice(1).join('\n'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { name, args: parsed };
    } catch { /* ignore */ }
  }
  return null;
}
