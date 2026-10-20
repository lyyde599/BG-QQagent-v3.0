// 课表查询（机器人原生能力，不依赖 DSH）
// 数据源：data/schedule/schedule.json（schema_version=2，section 为连排区间如 "6-9"）
//
// 设计原则：
//   · 按需筛选，绝不把整份 298K 课表塞进上下文——只返回查询结果
//   · 复用 schedule-notify.js 的日期工具，保持口径一致（本地时区）
//   · 无数据/超范围时给出明确说明，不编造
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const WD_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
// 课表数据（2026-10-21 插件化）：
// 插件可通过 globalThis.__qqScheduleFile 注入自己的数据位置，
// 未注入时用历史位置 data/schedule/schedule.json（兼容老部署）。
export const DEFAULT_SCHEDULE_FILE = path.join(DATA_DIR, 'schedule', 'schedule.json');
function scheduleFile() {
  return globalThis.__qqScheduleFile || DEFAULT_SCHEDULE_FILE;
}

let cache = null;   // { file, mtimeMs, data }

/** 读取课表（带 mtime 缓存，文件更新自动失效）。 */
export function loadSchedule(file = null) {
  file = file || scheduleFile();
  try {
    const st = fs.statSync(file);
    if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.data;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache = { file, mtimeMs: st.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

/** 本地日期 YYYY-MM-DD（避免 toISOString 的 UTC 偏移）。 */
export function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 在基准日期上偏移天数。 */
export function shiftDate(days = 0, base = new Date()) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

/** 把 "6-9" / "6" 解析成节次数组 */
function parseSections(sec) {
  const s = String(sec || '').trim();
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(s);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    const out = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? [n] : [];
}

/** 取某一天的课程（按节次排序）。 */
export function getDaySchedule(dateStr, file = null) {
  file = file || scheduleFile();
  const data = loadSchedule(file);
  if (!data) return { ok: false, error: '课表数据读取失败（文件不存在或格式错误）', date: dateStr };
  const byDate = data.by_date || {};
  const items = Array.isArray(byDate[dateStr]) ? byDate[dateStr].slice() : [];
  items.sort((a, b) => (parseSections(a.section)[0] || 0) - (parseSections(b.section)[0] || 0));
  const range = Array.isArray(data.date_range) && data.date_range.length === 2
    ? data.date_range
    : (() => { const k = Object.keys(byDate).sort(); return k.length ? [k[0], k[k.length - 1]] : null; })();
  const inRange = range ? (dateStr >= range[0] && dateStr <= range[1]) : true;
  return { ok: true, date: dateStr, weekday: WD_CN[new Date(dateStr + 'T00:00:00').getDay()], items, count: items.length, range, inRange, data };
}

/** 渲染单日课表文本（简洁，适合直接发给主人）。 */
export function renderDay(dateStr, result) {
  const { weekday, items, count, range, inRange } = result;
  const head = `【${dateStr}（${weekday || ''}）】`;
  if (!inRange) {
    return `${head} 不在课表覆盖范围（${range ? range[0] + ' ~ ' + range[1] : '未知'}）内——新课表可能还没来。`;
  }
  if (!count) return `${head} 没有课，可以安心休息～`;
  const lines = items.map((it) => {
    const sec = it.section ? `第${it.section}节` : '';
    // 完整时段优先（time_span），避免连排课只显示第一小节时间
    const span = it.time_span || (it.time_start && it.time_end ? it.time_start + '-' + it.time_end : '') || it.time || '';
    const time = span ? ' ' + span : '';
    const room = it.room || (Array.isArray(it.rooms) ? it.rooms[0] : '') || '';
    const teacher = it.teacher || (Array.isArray(it.teachers) ? it.teachers.join('/') : '') || '';
    const parts = [it.course || '（未命名课程）'];
    if (sec || time) parts.push(`${sec}${time}`.trim());
    if (teacher) parts.push(teacher);
    if (room) parts.push(room);
    return '· ' + parts.join('｜');
  });
  const total = items.reduce((n, it) => n + Math.max(1, parseSections(it.section).length), 0);
  return `${head} 共 ${count} 门课（${total} 节）\n` + lines.join('\n');
}

/** 取一段日期范围的课程 */
export function getRangeSchedule(startDate, endDate, file = null) {
  file = file || scheduleFile();
  const data = loadSchedule(file);
  if (!data) return { ok: false, error: '课表数据读取失败' };
  const byDate = data.by_date || {};
  const days = [];
  let cur = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (cur <= end) {
    const ds = localDate(cur);
    const items = Array.isArray(byDate[ds]) ? byDate[ds].slice() : [];
    items.sort((a, b) => (parseSections(a.section)[0] || 0) - (parseSections(b.section)[0] || 0));
    days.push({ date: ds, weekday: WD_CN[cur.getDay()], items, count: items.length });
    cur.setDate(cur.getDate() + 1);
  }
  return { ok: true, startDate, endDate, days };
}

/** 列出所有课程及统计 */
export function getCourseList(file = null) {
  file = file || scheduleFile();
  const data = loadSchedule(file);
  if (!data) return { ok: false, error: '课表数据读取失败' };
  const courses = data.courses || {};
  const list = Object.values(courses).map((c) => ({
    course: c.course,
    teachers: c.teachers || [],
    rooms: c.rooms || [],
    weekdays: c.weekdays || [],
    sections: c.sections || [],
    totalSessions: Array.isArray(c.sessions) ? c.sessions.length : (c.total_sessions || 0)
  }));
  return { ok: true, count: list.length, courses: list, range: data.date_range, generatedAt: data.generated_at };
}

/**
 * 渲染一天的多门课（周视图用）。
 * 优化点：
 *   ① 同课程、同教师、同教室、且节次相邻的段自动合并显示
 *      （如 6-7 节 + 8-9 节 → 显示为 第6-9节）；教师/教室不同则保留分段，不强行合并。
 *   ② 每门课都带教室（之前周视图漏了地点）。
 */
export function renderWeekDayItems(items) {
  if (!Array.isArray(items) || !items.length) return '  （无课）';

  const secStart = (it) => { const m = /^(\d+)/.exec(String(it.section || '')); return m ? Number(m[1]) : 0; };
  const secEnd = (it) => {
    const s = String(it.section || '');
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(s);
    if (m) return Number(m[2]);
    const n = /^(\d+)/.exec(s);
    return n ? Number(n[1]) : 0;
  };

  const sorted = items.slice().sort((a, b) => secStart(a) - secStart(b));
  const merged = [];
  for (const it of sorted) {
    const prev = merged[merged.length - 1];
    const sameCourse = prev && prev.course === it.course;
    const sameRoom = prev && String(prev.room || '') === String(it.room || '');
    const sameTeacher = prev && String(prev.teacher || '') === String(it.teacher || '');
    const contiguous = prev && secStart(it) <= secEnd(prev) + 1;
    if (sameCourse && sameRoom && sameTeacher && contiguous) {
      prev.__end = Math.max(secEnd(prev), secEnd(it));
      prev.__parts = prev.__parts || [{ t: prev.time }];
      prev.__parts.push({ t: it.time });
      continue;
    }
    merged.push({ ...it, __end: secEnd(it) });
  }

  const out = [];
  for (const it of merged) {
    const a = secStart(it);
    const b = it.__end || secEnd(it);
    const secText = (a && b) ? (a === b ? '第' + a + '节' : '第' + a + '-' + b + '节') : '';
    let timeText = String(it.time_span || it.time || '');
    if (it.__parts && it.__parts.length > 1) {
      const t0 = /(\d{2}:\d{2})/.exec(String(it.__parts[0].t || ''));
      const t1 = /(\d{2}:\d{2})$/.exec(String(it.__parts[it.__parts.length - 1].t || ''));
      if (t0 && t1) timeText = t0[1] + '-' + t1[1];
    }
    const meta = [];
    if (secText) meta.push(secText);
    if (timeText) meta.push(timeText);
    const teacher = it.teacher || (Array.isArray(it.teachers) ? it.teachers.join('/') : '');
    const room = it.room || (Array.isArray(it.rooms) ? it.rooms[0] : '');
    if (teacher) meta.push(teacher);
    if (room) meta.push('📍' + room);
    out.push('  · ' + String(it.course || '（未命名课程）') + (meta.length ? '｜' + meta.join('｜') : ''));
  }

  // 同一门课若出现多个节次段，补一句说明：分段是真实安排（通常教师不同），不是数据拆错
  const byCourse = new Map();
  for (const it of merged) {
    const k = String(it.course || '');
    if (!byCourse.has(k)) byCourse.set(k, []);
    byCourse.get(k).push(it);
  }
  const notes = [];
  for (const [course, list] of byCourse) {
    if (list.length > 1) {
      const segs = list.map((x) => {
        const a = secStart(x);
        const b = x.__end || secEnd(x);
        return (a === b ? '第' + a + '节' : '第' + a + '-' + b + '节');
      }).join(' + ');
      const teachers = [...new Set(list.map((x) => String(x.teacher || '')).filter(Boolean))];
      const why = teachers.length > 1 ? '（教师不同：' + teachers.join('、') + '）' : '';
      notes.push('    ↳ ' + course + ' 分 ' + list.length + ' 段：' + segs + why);
    }
  }
  if (notes.length) out.push(...notes);
  return out.join('\n');
}