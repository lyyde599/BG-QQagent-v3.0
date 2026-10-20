// 学习计划与间隔复习调度（学习模式/教师专用）
//
// 解决的三个问题：
//   1) 原来只有「开新」，没有复习 —— 学过的会忘（温故而知新）
//   2) 两本教材实际只讲了《金融市场基础知识》，法规一直没开
//   3) config.identityModes.tutor.extraPrompt 里的「学生进度」是写死的快照，
//      注释声称「系统自动注入」，但没有任何代码更新它 → 越用越失真
//
// 本模块提供：以「节」为单位的进度指针 + 艾宾浩斯式间隔复习队列。
// 由 study_plan 工具暴露给模型；进入学习模式时也会自动注入「今日任务」。
import fs from 'node:fs';
import path from 'node:path';
import { KB_ROOT, loadProgress } from './knowledge.js';

const PLAN_VERSION = 1;
export const SUBJECTS = ['金融市场基础知识', '证券市场基本法律法规'];
// 复习间隔（天）：复习通过则进下一档；失败回到第 0 档
const INTERVALS = [1, 3, 7, 15, 30];
const DAY = 24 * 3600 * 1000;

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(d, null, 1), 'utf8'); };

function planFile(uin) { return path.join(KB_ROOT, 'progress', `plan_${uin}.json`); }

// ── 教材「节」清单（计划骨架，从 _outline.json 提取有序唯一节）──
const _sectionsCache = new Map();
export function sectionsOf(subject) {
  if (_sectionsCache.has(subject)) return _sectionsCache.get(subject);
  const outline = readJson(path.join(KB_ROOT, 'textbook', subject, '_outline.json')) || [];
  const out = [];
  const seen = new Set();
  let curChapter = '';
  for (const e of outline) {
    if (!e) continue;
    if (e.type === 'chapter') { curChapter = e.title; continue; }
    if (e.type !== 'section') continue;
    const chapter = e.chapter || curChapter || '';
    const key = `${chapter}|${e.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ chapter, section: e.title });
  }
  _sectionsCache.set(subject, out);
  return out;
}

function newPlan(uin) {
  const pointers = {};
  const totals = {};
  for (const s of SUBJECTS) { pointers[s] = 0; totals[s] = sectionsOf(s).length; }
  return {
    version: PLAN_VERSION,
    uin,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    lastTaught: null,        // 上次讲的是哪一科 → 用于两本教材交替
    current: null,           // { subject, chapter, section, startedAt } 正在讲但未讲完的节
    pointers,                // 各科下一个待讲节的索引
    totals,
    queue: [],               // 复习队列
    doneSections: [],        // 已讲完的节（历史留档）
    stats: { reviewsPassed: 0, reviewsFailed: 0 }
  };
}

export function loadPlan(uin) {
  const p = readJson(planFile(uin));
  if (p && p.version === PLAN_VERSION) return p;
  return newPlan(uin);
}

export function savePlan(uin, plan) {
  plan.updatedAt = new Date().toISOString();
  writeJson(planFile(uin), plan);
  return plan;
}

// 把错题本同步进复习队列（错题随时可能新增）
function syncWrongQuestions(plan, uin) {
  const prog = loadProgress(uin);
  const existing = new Set(plan.queue.filter((q) => q.kind === 'wrong').map((q) => q.key));
  for (const w of (prog.wrongIds || [])) {
    const key = `wrong:${w.subject || ''}:${w.chapter || ''}:${w.qid || ''}`;
    if (existing.has(key)) continue;
    plan.queue.push({
      kind: 'wrong', key, subject: w.subject || '', chapter: w.chapter || '',
      qid: w.qid || '', stage: 0, lapses: 0, dueAt: Date.now(), addedAt: new Date().toISOString()
    });
  }
  return plan;
}

// ── 今日任务：先温故（到期复习），后知新（下一节）──
export function todayTasks(uin, { now = Date.now() } = {}) {
  const plan = syncWrongQuestions(loadPlan(uin), uin);

  const due = plan.queue
    .filter((q) => (q.dueAt || 0) <= now)
    .sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0))
    .map((q) => ({
      kind: q.kind, subject: q.subject, chapter: q.chapter, section: q.section || '',
      qid: q.qid || '', stage: q.stage, lapses: q.lapses,
      overdueDays: Math.max(0, Math.round((now - (q.dueAt || now)) / DAY)),
      stageLabel: `第${q.stage + 1}/${INTERVALS.length}档`
    }));

  // 知新：优先把「正在讲但没讲完」的节讲完，否则按两科交替取下一节
  let next = null;
  if (plan.current) {
    next = { ...plan.current, isContinue: true };
  } else {
    const remaining = SUBJECTS.filter((s) => plan.pointers[s] < sectionsOf(s).length);
    let pick = remaining[0] || null;
    if (remaining.length > 1 && plan.lastTaught) {
      const other = remaining.find((s) => s !== plan.lastTaught);
      if (other) pick = other;                       // 交替：换另一本
    }
    if (pick) {
      const sec = sectionsOf(pick)[plan.pointers[pick]];
      next = { subject: pick, chapter: sec.chapter, section: sec.section, isContinue: false };
    }
  }

  const done = SUBJECTS.reduce((n, s) => n + (plan.doneSections || []).filter((d) => d.subject === s).length, 0);
  const total = SUBJECTS.reduce((n, s) => n + sectionsOf(s).length, 0);

  return {
    dueReviews: due,
    totalDue: due.length,
    nextSection: next,
    progress: { done, total, percent: total ? Math.round((done / total) * 100) : 0 },
    perBook: SUBJECTS.map((s) => ({
      subject: s,
      done: (plan.doneSections || []).filter((d) => d.subject === s).length,
      total: sectionsOf(s).length
    })),
    wrongCount: plan.queue.filter((q) => q.kind === 'wrong').length,
    pendingCount: plan.queue.length
  };
}

/** 标记一节讲完：推进指针 + 排入首次复习（+1 天）+ 立即复习提示。 */
export function completeSection(uin, { subject, chapter, section } = {}) {
  const plan = syncWrongQuestions(loadPlan(uin), uin);
  if (!subject || !sectionsOf(subject).length) throw new Error('subject 无效：' + subject);
  const list = sectionsOf(subject);

  // 定位该节（允许只给 section 名）
  let idx = list.findIndex((x) => x.section === section && (!chapter || x.chapter === chapter));
  if (idx < 0) idx = list.findIndex((x) => x.section === section);
  if (idx < 0) throw new Error(`在《${subject}》里找不到这一节：${section}`);

  const hit = list[idx];
  const key = `section:${subject}:${hit.chapter}:${hit.section}`;
  if (!(plan.doneSections || []).some((d) => d.key === key)) {
    plan.doneSections.push({ key, subject, chapter: hit.chapter, section: hit.section, at: new Date().toISOString() });
  }
  // 指针推到该节之后（若讲的是更靠前的节，不倒退）
  if (idx + 1 > plan.pointers[subject]) plan.pointers[subject] = idx + 1;
  plan.lastTaught = subject;
  plan.current = null;

  // 排入复习队列（同一节只保留一条，重讲则重置档位）
  plan.queue = plan.queue.filter((q) => q.key !== key);
  plan.queue.push({
    kind: 'section', key, subject, chapter: hit.chapter, section: hit.section,
    stage: 0, lapses: 0, dueAt: Date.now() + INTERVALS[0] * DAY, addedAt: new Date().toISOString()
  });

  savePlan(uin, plan);
  return { done: { subject, chapter: hit.chapter, section: hit.section }, tasks: todayTasks(uin) };
}

/** 记录一次复习结果；通过则进档，失败回到第 0 档（间隔复习核心）。 */
export function recordReviewResult(uin, { key, kind, subject, chapter, section, qid, ok } = {}) {
  const plan = syncWrongQuestions(loadPlan(uin), uin);
  const k = key || (kind === 'wrong'
    ? `wrong:${subject || ''}:${chapter || ''}:${qid || ''}`
    : `section:${subject || ''}:${chapter || ''}:${section || ''}`);
  const item = plan.queue.find((q) => q.key === k);
  if (!item) throw new Error('复习队列里没有这一项：' + k);

  if (ok) {
    item.stage += 1;
    plan.stats.reviewsPassed += 1;
    if (item.stage >= INTERVALS.length) {
      plan.queue = plan.queue.filter((q) => q.key !== k);      // 已掌握，出队
      savePlan(uin, plan);
      return { mastered: true, item, tasks: todayTasks(uin) };
    }
  } else {
    item.stage = 0;
    item.lapses = (item.lapses || 0) + 1;
    plan.stats.reviewsFailed += 1;
  }
  item.dueAt = Date.now() + INTERVALS[item.stage] * DAY;
  item.lastAt = new Date().toISOString();
  savePlan(uin, plan);
  return { mastered: false, item, tasks: todayTasks(uin) };
}

// ── 渲染（给模型看，务必精简）──
export function formatToday(t) {
  const L = [];
  L.push(`【今日学习任务】进度 ${t.progress.done}/${t.progress.total} 节（${t.progress.percent}%）`);
  L.push(`  两科进度：${t.perBook.map((b) => `${b.subject.slice(0, 4)}… ${b.done}/${b.total}`).join('｜')}`);

  if (t.dueReviews.length) {
    L.push(`\n一、温故（到期复习 ${t.totalDue} 项）—— 先做这个`);
    t.dueReviews.slice(0, 8).forEach((r, i) => {
      if (r.kind === 'wrong') {
        L.push(`  ${i + 1}. [错题回炉] 《${r.subject}》${r.chapter}${r.qid ? ' · ' + r.qid : ''}（${r.stageLabel}${r.lapses ? ' 错' + r.lapses + '次' : ''}）`);
      } else {
        L.push(`  ${i + 1}. [复习] 《${r.subject}》${r.chapter} · ${r.section}（${r.stageLabel}${r.overdueDays ? '，逾期' + r.overdueDays + '天' : ''}）`);
      }
    });
    if (t.totalDue > 8) L.push(`  …还有 ${t.totalDue - 8} 项，做不完顺延明天`);
    L.push('  复习做法：抽 1-2 个该节核心知识点让他复述 → 出 2-3 题验收（含该节错题）→ 完成后调 study_plan(action=review, ...) 记录结果');
  } else {
    L.push('\n一、温故：今天没有到期复习项 ✔');
  }

  if (t.nextSection) {
    const n = t.nextSection;
    L.push(`\n二、知新（1 节）`);
    L.push(`  《${n.subject}》${n.chapter} · ${n.section}${n.isContinue ? '（上次讲到一半，先收尾）' : ''}`);
    L.push('  做法：kb_textbook(mode=section) 取正文 → 逐知识点讲透 → 本节讲完先做「即时复习」（复述要点+出验收题）→ 调 study_plan(action=section-done) 登记，系统会自动排下次复习');
  } else {
    L.push('\n二、知新：两本教材都讲完了 ✔');
  }
  L.push('\n纪律：先复习后开新；复习量大（>5 项）时优先做逾期最久的，其余顺延，不要一次堆太多。');
  return L.join('\n');
}

export function formatPlan(uin) {
  const plan = loadPlan(uin);
  const t = todayTasks(uin);
  const L = [formatToday(t)];
  L.push('\n【复习队列】共 ' + plan.queue.length + ' 项：');
  const byStage = {};
  for (const q of plan.queue) byStage[q.stage] = (byStage[q.stage] || 0) + 1;
  L.push('  档位分布：' + Object.entries(byStage).map(([s, n]) => `第${Number(s) + 1}档 ${n}项`).join('，') || '（空）');
  L.push(`  累计复习：通过 ${plan.stats.reviewsPassed} / 未过 ${plan.stats.reviewsFailed}`);
  L.push('\n【各科下一个待讲】');
  for (const s of SUBJECTS) {
    const list = sectionsOf(s);
    const p = plan.pointers[s];
    L.push(`  《${s}》：${p < list.length ? list[p].chapter + ' · ' + list[p].section : '已全部讲完'}`);
  }
  return L.join('\n');
}

export const REVIEW_INTERVALS = INTERVALS;
