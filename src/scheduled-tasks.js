// 通用定时任务（Reminder / Scheduled Task）
//
// 用途：主人在 QQ 里说「明天早上 8 点提醒我交作业」「每周一 9 点告诉我课表」
//   「3 小时后问我复习到哪了」，机器人用一个工具就能记下来，到点自动唤醒并主动发消息。
//
// 设计要点：
//   · 时间表达交给**模型**做自然语言理解（它比正则聪明），工具接收结构化结果，
//     但同时也接受"自然语言时间串"作为兜底（工具内部再做一层解析）。
//   · 持久化到 data/scheduled-tasks.json，重启不丢。
//   · 触发时走 orchestrator.wake(chatKey, { proactive:true, pushTask:{kind:'reminder'} })，
//     自动继承"私聊必回"等既有保障。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig } from './config.js';

const FILE = path.join(DATA_DIR, 'scheduled-tasks.json');

/** 本地日期 YYYY-MM-DD */
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const obj = JSON.parse(raw);
    return Array.isArray(obj?.tasks) ? obj.tasks : [];
  } catch { return []; }
}

function save(tasks) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ tasks, updatedAt: Date.now() }, null, 1), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch { /* 落盘失败不影响内存态 */ }
}

let tasks = load();

/** 重新从磁盘加载（多进程/外部工具写入后需要刷新）。
 *  ⚠️ 早期实现只在模块加载时读一次，导致：
 *     ① 服务重启前的任务丢失；② 外部进程写入的任务服务看不到。
 *     现在调度器每次检查前都会 reload，确保以磁盘为准。 */
export function reload() {
  const disk = load();
  // 合并：磁盘为准，但保留内存中"刚创建还没落盘"的（正常不会发生）
  tasks = disk;
  return tasks;
}

export function listTasks() { reload(); return tasks.slice(); }

/** 新增任务。at 必须是毫秒时间戳；repeat: 'none' | 'daily' | 'weekly' */
export function addTask({ chatKey, text, at, repeat = 'none', kind = 'reminder', meta = {} }) {
  const t = {
    id: 'task_' + crypto.randomBytes(4).toString('hex'),
    chatKey: String(chatKey || ''),
    text: String(text || '').slice(0, 500),
    at: Number(at) || 0,
    repeat: ['none', 'daily', 'weekly'].includes(repeat) ? repeat : 'none',
    kind,
    meta,
    createdAt: Date.now(),
    firedCount: 0,
    lastFiredAt: 0,
    enabled: true
  };
  tasks.push(t);
  save(tasks);
  return t;
}

export function removeTask(id) {
  const before = tasks.length;
  tasks = tasks.filter((t) => t.id !== id);
  save(tasks);
  return tasks.length < before;
}

export function clearTasks(chatKey = null) {
  const before = tasks.length;
  tasks = chatKey ? tasks.filter((t) => t.chatKey !== chatKey) : [];
  save(tasks);
  return before - tasks.length;
}

/** 取某个会话的任务 */
export function tasksOf(chatKey) {
  reload();
  return tasks.filter((t) => t.chatKey === chatKey && t.enabled);
}

/** 计算重复任务的下一次触发时间（本地时区，保持"当天几点"不变） */
function nextOccurrence(t, now) {
  const d = new Date(t.at);
  if (t.repeat === 'daily') {
    const next = new Date(now);
    next.setHours(d.getHours(), d.getMinutes(), d.getSeconds(), 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  if (t.repeat === 'weekly') {
    const next = new Date(now);
    next.setHours(d.getHours(), d.getMinutes(), d.getSeconds(), 0);
    const targetDow = d.getDay();
    let delta = (targetDow - next.getDay() + 7) % 7;
    if (delta === 0 && next.getTime() <= now) delta = 7;
    next.setDate(next.getDate() + delta);
    return next.getTime();
  }
  return 0;
}

/** 取出所有"到点该触发"的任务，并推进/清理它们。 */
export function dueTasks(now = Date.now()) {
  const due = [];
  let changed = false;
  for (const t of tasks) {
    if (!t.enabled) continue;
    if (t.at > now) continue;
    due.push({ ...t });
    t.firedCount = (t.firedCount || 0) + 1;
    t.lastFiredAt = now;
    if (t.repeat === 'none') {
      t.enabled = false;          // 一次性任务触发后失效
    } else {
      const next = nextOccurrence(t, now);
      if (next) t.at = next; else t.enabled = false;
    }
    changed = true;
  }
  if (changed) save(tasks);
  return due;
}

/** 人类可读的时间描述 */
export function describeTask(t, now = Date.now()) {
  const d = new Date(t.at);
  const diff = t.at - now;
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const dateStr = localDate(d);
  let when = `${dateStr}（${wd}）${hm}`;
  // 近的用相对时间更好懂
  if (diff > 0 && diff < 24 * 3600 * 1000) {
    const mins = Math.round(diff / 60000);
    if (mins < 60) when += `（约 ${mins} 分钟后）`;
    else when += `（约 ${Math.round(mins / 60)} 小时后）`;
  }
  const repeatText = t.repeat === 'daily' ? ' 每天重复' : (t.repeat === 'weekly' ? ' 每周重复' : '');
  return `${when}${repeatText}：${t.text}`;
}


// ── 调度器：定时检查到点任务并唤醒机器人 ────────────────────────────────
const TICK_MS = 30000;   // 30 秒检查一次（精度足够，负载低）

export class ScheduledTaskRunner {
  constructor({ orchestrator = null, log = console.log } = {}) {
    this.orchestrator = orchestrator;
    this.log = log;
    this.timer = null;
  }

  start() {
    this.stop();
    const tick = async () => {
      this.timer = setTimeout(() => { tick().catch(() => {}); }, TICK_MS);
      try { await this.#check(); } catch (e) { this.log('[定时任务] 检查出错:', e?.message || e); }
    };
    this.timer = setTimeout(() => { tick().catch(() => {}); }, 10000);
    const n = tasks.filter((t) => t.enabled).length;
    this.log('[定时任务] 调度器已启动（每 ' + (TICK_MS / 1000) + ' 秒检查一次；当前待触发 ' + n + ' 条）');
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** 运维/测试：立刻跑一次检查 */
  async tickNow() { return this.#check(); }

  async #check() {
    reload();   // 每次检查都以磁盘为准（外部写入/重启恢复都能看到）
    if (!this.orchestrator) return;
    const due = dueTasks();
    for (const t of due) {
      try {
        this.log('[定时任务] 触发：' + t.id + ' → ' + t.chatKey + ' | ' + String(t.text).slice(0, 50));
        await this.orchestrator.wake(t.chatKey, {
          proactive: true,
          pushTask: {
            kind: 'reminder',
            id: t.id,
            text: t.text,
            repeat: t.repeat,
            firedAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
            firedCount: t.firedCount
          }
        });
      } catch (e) {
        this.log('[定时任务] 触发失败 ' + t.id + ':', e?.message || e);
      }
    }
  }
}
