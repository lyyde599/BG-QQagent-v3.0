// ── 插件：轻量记忆 ─────────────────────────────────────────────────────
//
// 工具从内核搬出。数据仍在内核 MemoryStore（data/memory/），
// 因为记忆会出现在每轮提示词的【记忆】段（prompt.js 直接读它）。
//
// 结论：**工具归插件，数据归内核**。
//
// ══════════════════════════════════════════════════════════════
// 2026-11-06 按作者优化清单重写
//
// P0-1 群聊权限边界：query/remove/update 只允许私聊或 master
//       （群友可以诱导机器人"说说你对 A 的印象"→ 隐私泄露；
//         还能让它删记忆 → 恶意删除。代码守卫比提示词可靠。）
// P0-2 修"假成功"：非法类别/空内容/重复 → 返回真实结果
// P0-3 数据端点对齐真实路径（data/memory）
// P0-4（内核）整理不动 personFact
// P1-5 新增 personFact（具体事实，和"印象"分开）
// P1-6 target 用 QQ 号（targetId），名字只作显示
// P1-7/8 时间与来源：createdAt / lastUsedAt / source(said|inferred)
// P1-9 memory_remove 支持按 id；新增 memory_update / memory_search
// P1-10 promptSections：告诉模型"什么时候该记"
// ══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { ok, err } from '../../src/core/tool-kit.js';

const CATS = ['activeTopic', 'pendingThought', 'memberImpression', 'personFact'];
const CAT_DESC = {
  activeTopic: '进行中的话题（这几天在聊什么）',
  pendingThought: '想说但还没说的话',
  memberImpression: '对某人的印象（形容词、感觉）',
  personFact: '关于某人的具体事实（他明天去党校 / 他说手冷 / 他养了只猫）',
};

/** 群聊里允许调用的工具（只有"写当前话题"这一种） */
const GROUP_SAFE = new Set(['memory_append']);

export async function activate(ctx) {
  const cfg = () => {
    try {
      return ctx.config.get().memory || {};
    } catch { return {}; }
  };

  /**
   * 🔴 P0-1 权限边界
   *
   * 群聊：只允许写 activeTopic / pendingThought（本群话题），
   *       不许 query / remove / update（读别人的印象、删记忆）。
   * 私聊 / master：全部允许。
   */
  const guard = (toolCtx, toolName, category) => {
    const isGroup = String(toolCtx?.chatKey || '').startsWith('group:');
    if (!isGroup) return null;                       // 私聊全放行
    if (cfg().masterOnly === false) return null;     // 用户明确关掉限制
    const isMaster = toolCtx?.isMaster === true;
    if (isMaster) return null;                       // 主人例外
    if (!GROUP_SAFE.has(toolName)) {
      return '这个操作只能在私聊里做。';
    }
    if (category && (category === 'personFact' || category === 'memberImpression')) {
      return '群里不记关于个人的内容 —— 私聊跟我说。';
    }
    return null;
  };

  // ── 记一条 ──────────────────────────────────────────
  ctx.tools.register({
    name: 'memory_append',
    description: [
      '记一条轻量记忆（下次运行自动看到）。',
      `· activeTopic：${CAT_DESC.activeTopic}`,
      `· pendingThought：${CAT_DESC.pendingThought}`,
      `· memberImpression：${CAT_DESC.memberImpression}`,
      `· personFact：${CAT_DESC.personFact}`,
      '判据：具体、以后可能用到、不是客套 → 记；泛泛情绪/重复 → 不记。',
      '没真调这个工具，不许说"我记下了"。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: CATS },
        content: { type: 'string', description: '记忆内容（具体一点）' },
        targetId: { type: 'string', description: 'memberImpression / personFact 时的 QQ 号（推荐，稳定）' },
        target: { type: 'string', description: 'memberImpression / personFact 时的名字（仅显示）' },
        source: { type: 'string', enum: ['said', 'inferred'], description: 'said=他说的；inferred=我推测的' },
        expiresInMs: { type: 'number', description: 'pendingThought 的有效期（毫秒，默认 2 小时）' },
      },
      required: ['category', 'content'],
    },
    async execute(toolCtx, args) {
      try {
        const category = String(args.category || '');
        const block = guard(toolCtx, 'memory_append', category);
        if (block) return err(block);
        if (!CATS.includes(category)) {
          return err(`不认识的记忆类别：${category}。可选：${CATS.join(' / ')}`);
        }
        const extra = {};
        if (args.targetId) extra.targetId = String(args.targetId).trim();
        if (args.target) extra.target = String(args.target).trim();
        if (args.source) extra.source = String(args.source);
        if (args.expiresInMs) extra.expiresInMs = Number(args.expiresInMs);
        // memberImpression / personFact 必须有 targetId 或 target（P2：条件必填）
        if ((category === 'personFact' || category === 'memberImpression')
            && !extra.targetId && !extra.target) {
          return err('这一类要说明是**谁**：给 targetId（QQ 号）或 target（名字）。');
        }

        const r = toolCtx.memory.append(toolCtx.chatKey, category, String(args.content ?? ''), extra);
        // 🔴 P0-2 返回真实结果
        if (!r?.ok) return err(r?.error || '没记上');
        if (r.duplicate) return ok({ saved: false, duplicate: true, note: '这条已经记过了，没有重复写。' });
        return ok({ saved: true, entry: r.entry });
      } catch (error) {
        return err(error?.message ?? error);
      }
    },
  });

  // ── 查 ────────────────────────────────────────────
  ctx.tools.register({
    name: 'memory_query',
    description: '查看当前会话的轻量记忆（含时间与来源）。只能在私聊用。',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: CATS, description: '可选：只看某一类' },
        keyword: { type: 'string', description: '可选：按关键词搜' },
      },
    },
    async execute(toolCtx, args) {
      try {
        const block = guard(toolCtx, 'memory_query', '');
        if (block) return err(block);
        if (args.keyword) {
          return ok({ items: toolCtx.memory.search(toolCtx.chatKey, String(args.keyword)) });
        }
        const category = args.category ? String(args.category) : '';
        if (category && !CATS.includes(category)) {
          return err(`不认识的记忆类别：${category}`);
        }
        const r = toolCtx.memory.query(toolCtx.chatKey, category);
        if (r?.__error) return err(r.__error);
        return ok(r);
      } catch (error) {
        return err(error?.message ?? error);
      }
    },
  });

  // ── 删 ────────────────────────────────────────────
  ctx.tools.register({
    name: 'memory_remove',
    description: '删掉某条/某人的记忆。优先用 id（memory_query 能看到）。只能在私聊用。',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: CATS },
        id: { type: 'string', description: '条目 id（最精确，推荐）' },
        targetId: { type: 'string', description: '按 QQ 号删这个人的全部' },
        target: { type: 'string', description: '按名字删这个人的全部' },
        content: { type: 'string', description: '按原文删某一条' },
      },
      required: ['category'],
    },
    async execute(toolCtx, args) {
      try {
        const block = guard(toolCtx, 'memory_remove', '');
        if (block) return err(block);
        const category = String(args.category || '');
        if (!CATS.includes(category)) return err(`不认识的记忆类别：${category}`);
        const r = toolCtx.memory.remove(toolCtx.chatKey, category, {
          id: String(args.id || ''),
          targetId: String(args.targetId || ''),
          target: String(args.target || ''),
          content: String(args.content || ''),
        });
        if (!r?.ok) return err(r?.error || '删除失败');
        return ok({ removed: r.removed });
      } catch (error) {
        return err(error?.message ?? error);
      }
    },
  });

  // ── 改 ────────────────────────────────────────────
  ctx.tools.register({
    name: 'memory_update',
    description: '改一条记错的记忆（给 id + 新内容）。只能在私聊用。',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: CATS },
        id: { type: 'string' },
        content: { type: 'string', description: '新的内容' },
      },
      required: ['category', 'id', 'content'],
    },
    async execute(toolCtx, args) {
      try {
        const block = guard(toolCtx, 'memory_update', '');
        if (block) return err(block);
        const r = toolCtx.memory.update(toolCtx.chatKey, String(args.category || ''),
          String(args.id || ''), String(args.content ?? ''));
        if (!r?.ok) return err(r?.error || '改不了');
        return ok({ entry: r.entry });
      } catch (error) {
        return err(error?.message ?? error);
      }
    },
  });

  // ── 忘掉某人（P2）──────────────────────────────────
  ctx.tools.register({
    name: 'memory_forget',
    description: '忘掉某个人的全部记忆（印象 + 事实）。只能在私聊用。',
    parameters: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'QQ 号' },
        target: { type: 'string', description: '名字' },
      },
    },
    async execute(toolCtx, args) {
      try {
        const block = guard(toolCtx, 'memory_forget', '');
        if (block) return err(block);
        let total = 0;
        for (const c of ['personFact', 'memberImpression']) {
          const r = toolCtx.memory.remove(toolCtx.chatKey, c, {
            targetId: String(args.targetId || ''),
            target: String(args.target || ''),
          });
          total += Number(r?.removed) || 0;
        }
        return ok({ removed: total });
      } catch (error) {
        return err(error?.message ?? error);
      }
    },
  });

  // ── P1-10 告诉模型"什么时候该记" ────────────────────
  try {
    ctx.promptSections?.register?.('memory:howto', () => [
      '【关于记忆】',
      '值得记的：具体、以后可能用到、不是客套（他明天去党校 / 他说手冷 / 他养了只猫）。',
      '不值得记的：泛泛情绪、客套、重复内容。',
      '记具体事实用 personFact（要带 targetId）；记感觉用 memberImpression。',
      '真调了 memory_append 才能说"我记下了"；没调就别说。',
    ].join('\n'));
  } catch { /* 内核不支持 promptSections 就跳过 */ }

  // ══════════════════════════════════════════════════
  // P0-3 数据端点：读的是**真实路径** data/memory
  // ══════════════════════════════════════════════════
  const memDir = () => {
    try { return path.join(ctx.root, 'data', 'memory'); } catch { return ''; }
  };

  /** 列出所有会话的记忆文件 */
  const listChats = () => {
    const dir = memDir();
    if (!dir) return [];
    try {
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const full = path.join(dir, f);
          const st = fs.statSync(full);
          let counts = {};
          try {
            const j = JSON.parse(fs.readFileSync(full, 'utf8'));
            for (const c of CATS) counts[c] = Array.isArray(j[c]) ? j[c].length : 0;
            counts._total = CATS.reduce((s, c) => s + counts[c], 0);
            counts._lastConsolidatedAt = Number(j.lastConsolidatedAt) || 0;
          } catch { counts._total = 0; }
          return { file: f, chatKey: f.replace(/-[a-z0-9]+\.json$/, '').replace(/_/g, ':'),
            bytes: st.size, mtime: st.mtimeMs, counts };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch { return []; }
  };

  ctx.http.route('GET', '/api/memory/status', async (_req, _b, url) => {
    try {
      const chatKey = String(url?.searchParams?.get('chat') || '');
      if (chatKey) {
        const fmt = ctx.memory.formatForPrompt(chatKey);
        const raw = ctx.memory.query(chatKey);
        return { ok: true, chatKey, text: fmt || '', empty: !fmt, data: raw };
      }
      const chats = listChats();
      let totalBytes = 0;
      for (const c of chats) totalBytes += c.bytes;
      return { ok: true, chats, totalBytes, dir: memDir() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }, { absolute: true });

  /** P0-3 清空（原来面板清的是 data/plugins/memory，清不掉真实记忆） */
  ctx.http.route('POST', '/api/memory/clear', async (_req, body) => {
    try {
      const chatKey = String(body?.chatKey || '');
      const category = String(body?.category || '');
      const confirm = body?.confirm === true;
      if (!chatKey) return { ok: false, error: '缺少会话键' };
      if (!confirm) return { ok: false, error: '要传 confirm:true 才会真清' };
      const r = ctx.memory.clear(chatKey, category);
      if (!r?.ok) return { ok: false, error: r?.error || '清空失败' };
      return { ok: true, chatKey, category: category || '（全部）' };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }, { absolute: true });

  /** 删一条（UI 用，P1-12） */
  ctx.http.route('POST', '/api/memory/remove', async (_req, body) => {
    try {
      const chatKey = String(body?.chatKey || '');
      const category = String(body?.category || '');
      if (!chatKey) return { ok: false, error: '缺少会话键' };
      if (!CATS.includes(category)) return { ok: false, error: `不认识的类别：${category}` };
      const r = ctx.memory.remove(chatKey, category, {
        id: String(body?.id || ''),
        targetId: String(body?.targetId || ''),
        target: String(body?.target || ''),
        content: String(body?.content || ''),
      });
      return r?.ok ? { ok: true, removed: r.removed } : { ok: false, error: r?.error || '删除失败' };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }, { absolute: true });

  /** 改一条（UI 用，P1-12） */
  ctx.http.route('POST', '/api/memory/update', async (_req, body) => {
    try {
      const chatKey = String(body?.chatKey || '');
      const category = String(body?.category || '');
      const id = String(body?.id || '');
      const content = String(body?.content ?? '');
      if (!chatKey || !id) return { ok: false, error: '缺少会话键或 id' };
      if (!CATS.includes(category)) return { ok: false, error: `不认识的类别：${category}` };
      const r = ctx.memory.update(chatKey, category, id, content);
      return r?.ok ? { ok: true, entry: r.entry } : { ok: false, error: r?.error || '改不了' };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }, { absolute: true });

  /** P0-3 导出（卸载/迁移不丢记忆） */
  ctx.http.route('GET', '/api/memory/export', async (_req, _b, url) => {
    try {
      const chatKey = String(url?.searchParams?.get('chat') || '');
      if (chatKey) {
        return { ok: true, chatKey, data: ctx.memory.query(chatKey) };
      }
      // 全量导出
      const out = {};
      for (const c of listChats()) {
        const key = c.chatKey;
        out[key] = ctx.memory.query(key);
      }
      return { ok: true, all: out, exportedAt: Date.now() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }, { absolute: true });

  return { dispose() {} };
}
