// 会话（运行）记录：每次 agent 处理 = 一个会话，完整留档供 UI 查看。
// 文件：data/sessions/<id>.json；索引在内存里维护（最近优先）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

export function newSessionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function sessionFile(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

export class SessionRegistry {
  constructor(keepFiles = 300) {
    this.keepFiles = Math.max(20, Number(keepFiles) || 300);
    this.index = [];   // [{ id, chatKey, startedAt, endedAt, status, outcome, usage, trigger, model, promptChars }]
    this.current = new Map(); // id -> session object（运行中的在内存里）
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    this.#loadIndex();
  }

  #loadIndex() {
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
      for (const f of files.slice(0, this.keepFiles)) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
          if (data?.id) this.index.push(this.#summary(data));
        } catch { /* 跳过坏文件 */ }
      }
    } catch { /* 目录还没建 */ }
  }

  #summary(s) {
    return {
      id: s.id,
      chatKey: s.chatKey,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      status: s.status,                      // running | done | noreply | error | aborted
      outcome: s.outcome ?? null,            // { sent: n, finishReason }
      usage: s.usage ?? null,
      model: s.model ?? '',
      trigger: s.triggerSummary ?? '',
      promptChars: s.promptChars ?? 0,
      rounds: s.rounds ?? 0
    };
  }

  create({ chatKey, trigger, triggerSummary }) {
    const session = {
      id: newSessionId(),
      chatKey,
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
      trigger,                                 // 'message' | 'proactive'
      triggerSummary: String(triggerSummary ?? '').slice(0, 120),
      triggerText: String(triggerEntriesToText(trigger) ?? ''),
      systemPrompt: '',
      userPrompt: '',
      promptChars: 0,
      model: '',
      rounds: 0,
      messages: [],                            // OpenAI 消息序列（含工具调用与结果）
      sent: [],                                // 实际发出的每一条
      feedbacks: [],
      finishReason: null,
      error: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 }
    };
    this.current.set(session.id, session);
    this.#persist(session);
    this.index.unshift(this.#summary(session));
    this.index = this.index.slice(0, this.keepFiles);
    return session;
  }

  get(id) {
    if (this.current.has(id)) return this.current.get(id);
    try {
      const data = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
      return data;
    } catch {
      return null;
    }
  }

  update(id) {
    const s = this.current.get(id);
    if (s) this.#persist(s);
    return s ?? null;
  }

  finish(id, status) {
    const s = this.current.get(id);
    if (!s) return null;
    s.status = status;
    s.endedAt = Date.now();
    this.current.delete(id);
    this.#persist(s);
    const idx = this.index.findIndex((e) => e.id === id);
    if (idx >= 0) this.index[idx] = this.#summary(s);
    // 清理超出保留数的旧文件
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort();
      if (files.length > this.keepFiles) {
        for (const f of files.slice(0, files.length - this.keepFiles)) {
          try { fs.unlinkSync(path.join(SESSIONS_DIR, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    return s;
  }

  listSummaries(limit = 100) {
    return this.index.slice(0, limit);
  }

  /** 今日 token 统计（含运行中的）。 */
  todayUsage(dayKey) {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let runs = 0;
    // 结束的会话记在汇总文件里
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (data?.dayKey === dayKey) {
        promptTokens = data.promptTokens || 0;
        completionTokens = data.completionTokens || 0;
        totalTokens = data.totalTokens || 0;
        runs = data.runs || 0;
      }
    } catch { /* 无记录 */ }
    // 加上运行中的
    for (const s of this.current.values()) {
      promptTokens += s.usage.promptTokens;
      completionTokens += s.usage.completionTokens;
      totalTokens += s.usage.totalTokens;
    }
    return { dayKey, promptTokens, completionTokens, totalTokens, runs };
  }

  /** 在会话结束时累加今日用量。 */
  #bumpTodayUsage(s) {
    const dayKey = localDayKey(s.startedAt);
    let data = { dayKey, promptTokens: 0, completionTokens: 0, totalTokens: 0, runs: 0 };
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (parsed?.dayKey === dayKey) data = parsed;
    } catch { /* 新的一天 */ }
    data.promptTokens += s.usage.promptTokens;
    data.completionTokens += s.usage.completionTokens;
    data.totalTokens += s.usage.totalTokens;
    data.runs += 1;
    const tmp = path.join(DATA_DIR, 'usage-today.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, path.join(DATA_DIR, 'usage-today.json'));
  }

  #persist(s) {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const tmp = `${sessionFile(s.id)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8');
      fs.renameSync(tmp, sessionFile(s.id));
      if (s.status !== 'running') this.#bumpTodayUsage(s);
    } catch (error) {
      console.error('[sessions] 持久化失败:', error?.message ?? error);
    }
  }
}

function localDayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function triggerEntriesToText(trigger) {
  // trigger 在创建时是数组（触发条目），这里只做摘要展示用
  if (Array.isArray(trigger)) {
    return trigger.map((m) => `${m.senderName || m.senderId || '?'}: ${String(m.text ?? '').slice(0, 80)}`).join(' | ');
  }
  return '';
}
