// 学习推送调度器（教师专用）
// 每天在配置的窗口内随机挑一个时刻，主动给主人推送一条证券从业学习内容。
// 防打扰：主人没回复时顺延；主人离线过久顺延到下一窗口。
import { getConfig } from './config.js';

// 主人 QQ 从配置读（不硬编码 —— 开源版本不能带上原作者的账号）
function masterQQ() {
  return String(getConfig().persona?.masterQQ || '');
}

// 窗口解析：['8-9','12-14','20-22'] → [{start:{h:8,m:0}, end:{h:9,m:0}}]
function parseWindows(list) {
  const out = [];
  for (const w of list || []) {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/.exec(String(w).trim());
    if (!m) continue;
    out.push({ start: { h: +m[1], m: +(m[2] || 0) }, end: { h: +m[3], m: +(m[4] || 0) } });
  }
  return out;
}
function minOfDay(h, m) { return h * 60 + m; }
function nowMin() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }

export class PushScheduler {
  constructor({ orchestrator, store, log = console.log } = {}) {
    this.orchestrator = orchestrator;
    this.store = store;
    this.log = log;
    this.timer = null;
    this.todayPushed = new Set(); // 当天已推送的 job 名
    this.lastPushAt = 0;
    this.lastPushText = '';
  }

  start() {
    this.stop();
    const tick = async () => {
      // 每分钟检查一次到点任务
      this.timer = setTimeout(() => { tick().catch(() => {}); }, 60 * 1000);
      try { await this.#check(); } catch (e) { this.log('[push] 检查出错:', e?.message || e); }
    };
    this.timer = setTimeout(() => { tick().catch(() => {}); }, 30 * 1000);
    this.log('[push] 学习推送调度器已启动（早8-9/午12-14/晚20-22 随机时刻推送）');
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  async #check() {
    const cfg = getConfig();
    const ps = cfg.pushScheduler;
    if (!ps?.enabled) return;
    if (!this.orchestrator) return;
    if (this.orchestrator.paused) return;
    const today = new Date().toISOString().slice(0, 10);
    if (this.todayPushed.has(today)) return;
    // 只在窗口内且到点触发
    const windows = parseWindows(ps.windows || ['20-22']);
    const now = nowMin();
    const nowStr = new Date().toTimeString().slice(0, 5);
    const cur = windows.find((w) => {
      const s = minOfDay(w.start.h, w.start.m), e = minOfDay(w.end.h, w.end.m);
      return now >= s && now <= e;
    });
    if (!cur) return;
    // 防打扰检查：
    // 1) 距上次推送 < 30 分钟不重复
    if (Date.now() - this.lastPushAt < 30 * 60 * 1000) return;
    // 2) 主人离线太久（最后消息 > 12h）不推
    const meta = this.store.getChatMeta(`private:${masterQQ()}`);
    if (meta?.lastTs && Date.now() - meta.lastTs > 12 * 3600 * 1000) return;
    // 3) 主人上一条还没回（距主人最后发言时间超过 6h 且距上次推送 > 5h，且主人没再说话）→ 等主人先开口
    if (meta?.lastTs) {
      const idleH = (Date.now() - meta.lastTs) / 3600000;
      if (idleH > 6) return; // 主人至少 6 小时内出现过
    }
    // 随机时刻：在窗口内随机选 5 分钟粒度（窗口前后 20% 边缘不触发）
    const span = minOfDay(cur.end.h, cur.end.m) - minOfDay(cur.start.h, cur.start.m);
    const margin = Math.max(0, Math.floor(span * 0.1));
    const fireMin = minOfDay(cur.start.h, cur.start.m) + margin;
    const lastMin = minOfDay(cur.end.h, cur.end.m) - margin;
    if (now < fireMin || now > lastMin) return;
    // 4) 随机性：每分钟通过概率 = 1/剩余窗口分钟数（保证窗口内均匀分布）
    const remain = Math.max(1, lastMin - now);
    if (Math.random() > 1 / Math.min(remain, 30)) return;

    this.todayPushed.add(today);
    this.lastPushAt = Date.now();
    this.log(`[push] 触发定时学习推送（${nowStr}）`);
    await this.orchestrator.wake(`private:${masterQQ()}`, { proactive: true, pushTask: { source: 'scheduler' } })
      .catch((e) => this.log('[push] wake 出错:', e?.message || e));
  }

  // 手动测试：立即推一条（忽略窗口/随机）
  async pushNow() {
    const today = new Date().toISOString().slice(0, 10);
    if (Date.now() - this.lastPushAt < 10 * 1000) return '距上次推送太近，稍后再试';
    this.lastPushAt = Date.now();
    this.todayPushed.add(today);
    await this.orchestrator.wake(`private:${masterQQ()}`, { proactive: true, pushTask: { source: 'manual' } })
      .catch((e) => console.error('[push] pushNow 出错:', e?.message || e));
    return '已触发一次主动推送';
  }
}