// ── 上下文策略（2026-10-28）──────────────────────────────────────
//
// 解决的问题：
//   群里积压 10+ 条未读时，内核默认把它们**全部**算作「本次唤醒」，
//   而 buildUserPrompt 会把触发批整个排除出【过去状态】。
//   结果模型看到的是「一堆孤立的本次唤醒消息 + 一段不连贯的历史」，
//   抓不住上下文。
//
// 本插件的做法：
//   只有「确实该回」的消息才算触发（@我 / 引用我 / 拍我 / 命中关键词），
//   其余留在过去状态里当背景 —— 模型能顺着读下来，理解发生了什么。
//
// 安全：本插件抛错时内核会自动回退 builtin（全部算触发），
//   机器人不会因此哑掉。

/** 判断一条消息是否直接指向机器人 */
function isDirectedAtMe(entry, selfId, keywords) {
  const text = String(entry?.text || '');
  const nickname = String(entry?.selfNickname || '');   // 消息里通常没有，保留兼容

  // ① @我：OneBot 里 @ 段通常已转成 [CQ:at,qq=<selfId>]
  //    内核格式是「@名字#QQ号」，两种都要认（2026-10-28）
  if (selfId) {
    if (text.includes(`[CQ:at,qq=${selfId}]`)) return true;
    if (text.includes(`@`) && text.includes(`#${selfId}`)) return true;
    if (nickname && text.includes(`@${nickname}`)) return true;
  }

  // ② 引用我：**必须看引用里的 #号**，不能见到"引用"两个字就算（2026-10-28 修）
  //
  // 原实现是 `/\[引用/.test(text)` —— 任何引用都算指向我。
  // 后果：群里两个人互引也唤醒机器人，白烧一次模型调用。
  // 现在按号判：`[引用 名字#3170037984：...]` 才是我。
  if (selfId) {
    const m = text.match(/\[引用\s+([^\]：]+)/);
    if (m) {
      const who = m[1];
      // 带号就比号；没带号（老数据）退回比 self 标记
      if (who.includes(`#${selfId}`)) return true;
      if (!/#\d+/.test(who) && entry?.reply?.self === true) return true;
    }
  }
  // ③ 拍一拍
  if (text.includes('[拍一拍]')) return true;
  // ④ 自定义关键词
  const lower = text.toLowerCase();
  for (const k of keywords) {
    if (k && lower.includes(String(k).toLowerCase())) return true;
  }
  return false;
}

export async function activate(ctx) {
  const log = (...a) => ctx.log(...a);
  const cfg = () => ctx.config.get() || {};

  // 内核能力探测：老内核没有这个 API，装上也别崩
  if (typeof ctx.context?.registerStrategy !== 'function') {
    log('[context-strategy] 当前内核不支持 context.registerStrategy（需要 3.1.0+），插件不生效');
    return { dispose() {} };
  }

  const strategy = async ({ chatKey, entries, selfId: selfIdFromKernel }) => {
    const c = cfg();
    const mode = String(c.mode || 'mention-only');
    const keywords = Array.isArray(c.customKeywords) ? c.customKeywords : [];
    const maxBg = Math.max(0, Number(c.maxBackground) || 50);
    const list = Array.isArray(entries) ? entries : [];

    // 🔴 私聊一律全触发（2026-10-28 修）
    //
    // 事故：私聊里连发几条「我是谁」全都石沉大海。
    // 根因：mention-only 模式找的是「@我 / 引用我 / 拍我 / 关键词」，
    //      而私聊里**没有 @ 也没有引用**（一对一不需要 @），
    //      于是全部被归为背景 → trigger 为空 → 内核直接 return 不唤醒。
    //
    // 私聊是"这个人单独找你说话"，不存在"要不要插话"的问题，
    // 所以策略不该在这里生效 —— 全部算触发，交给模型判断。
    if (String(chatKey || '').startsWith('private:')) {
      return { trigger: list, background: [] };
    }

    // all：全部算触发（等于内核 builtin 行为，用于对比/回退）
    if (mode === 'all') {
      return { trigger: list, background: [] };
    }

    // mention-only：只有直接指向我的才算触发
    //
    // selfId 来源（按优先级）：
    //   ① 策略入参里内核传的
    //   ② 插件自己配置的
    //   ③ 都没有 → 退化为只认 @<昵称> 和关键词
    //
    // 🔴 不能从消息对象的 m.selfId 取 —— 落库的消息只有
    //    id/mid/ts/senderId/senderName/text/self/read/reply/media，
    //    没有 selfId 字段（踩过）。
    const selfId = String(selfIdFromKernel || cfg().selfId || '');

    const trigger = [];
    const background = [];
    for (const m of list) {
      if (isDirectedAtMe(m, selfId, keywords)) trigger.push(m);
      else background.push(m);
    }

    // mention-fallback：按 @ 分流，但若一条都没命中（比如大家只是在闲聊
    // 而模型确实该参与），退回最近一条当触发，避免永远不开口
    if (mode === 'mention-fallback' && trigger.length === 0 && list.length > 0) {
      const last = list[list.length - 1];
      const i = background.findIndex((m) => m.id === last.id);
      if (i >= 0) background.splice(i, 1);
      trigger.push(last);
    }

    if (c.debug) {
      log(`[context-strategy] ${chatKey}: 触发 ${trigger.length} / 背景 ${background.length}（mode=${mode}）`);
    }

    // 背景太多时只保留最近的 N 条（过去状态本身还有条数预算，这里先削一道）
    const bg = background.length > maxBg ? background.slice(-maxBg) : background;
    return { trigger, background: bg };
  };

  ctx.context.registerStrategy(strategy);
  log(`[context-strategy] 已注册（模式：${cfg().mode || 'mention-only'}）`);

  return {
    dispose() {
      log('[context-strategy] 已卸载，上下文策略回到内核默认');
    }
  };
}
