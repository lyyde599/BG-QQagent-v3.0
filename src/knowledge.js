// 知识库模块：证券从业考试资料检索 + 学习进度管理
// 目录：data/knowledge/securities/
//   bank/by-chapter/<科目>/<章节>.json — 按章节分桶的题目
//   bank/by-type/<题型>.json — 按题型分桶
//   bank/真题全集.json — 历年真题
//   textbook/<科目>/chunk_*.json — 教材切片
//   progress/ — 学习进度/错题本
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ── 知识库根目录（2026-10-21 插件化）──
//
// 三种东西的归属必须分清：
//   bank/ + textbook/  = **资产**（题库 6701 题、教材切片），跟插件走，可随插件导出
//   progress/          = **运行数据**（学习进度、错题本、学习档案），走插件私有数据
//
// 所以根目录有两个：资产根（插件目录下）+ 进度根（data/plugins/study/）。
// 查找顺序：插件目录 → 旧位置 data/knowledge/securities（兼容老部署）。
const PLUGIN_KB = path.join(__dirname, '..', 'plugins', 'study', 'kb');
const LEGACY_KB = path.join(__dirname, '..', 'data', 'knowledge', 'securities');
export const KB_ROOT = fs.existsSync(path.join(PLUGIN_KB, 'bank')) ? PLUGIN_KB : LEGACY_KB;

// 学习进度：插件可注入私有目录（globalThis.__qqStudyProgressDir）
function progressRoot() {
  // 优先级：插件注入的私有目录 → 内核 data/plugins/study/progress → KB_ROOT/progress（最后兜底）
  // ⚠️ 中间这层很关键：KB_ROOT 是**资产目录**（题库/教材），把进度写进去等于
  //    把运行数据混进可导出的资产里 —— 导出插件就带走别人的学习记录了。
  if (globalThis.__qqStudyProgressDir) return globalThis.__qqStudyProgressDir;
  const priv = path.join(__dirname, '..', 'data', 'plugins', 'study', 'progress');
  try { fs.mkdirSync(priv, { recursive: true }); } catch { /* ignore */ }
  return priv;
}
export { progressRoot };

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(d, null, 1), 'utf8'); };

// chapter-index.json 的 file 字段历史上被写成绝对路径，
// 一旦换机器或换部署目录就静默读不到：真题之外的分桶题库全部取不到，题量被卡死在真题条数。
// 统一在此解析：相对路径按 KB_ROOT 拼；绝对路径不存在时，用「bank/ 之后的部分」回退到当前 KB_ROOT。
// 这样旧数据也能自愈，不再依赖部署路径。
function resolveBankFile(file) {
  const raw = String(file || '').trim();
  if (!raw) return null;
  if (!path.isAbsolute(raw)) return path.join(KB_ROOT, raw);
  if (fs.existsSync(raw)) return raw;
  const m = /(?:^|[\\/])bank[\\/](.+)$/.exec(raw);
  if (m) {
    const candidate = path.join(KB_ROOT, 'bank', m[1]);
    if (fs.existsSync(candidate)) return candidate;
  }
  return raw;
}

export function listOverview() {
  const bank = readJson(path.join(KB_ROOT, 'bank', 'chapter-index.json')) || [];
  const subs = {};
  for (const c of bank) {
    subs[c.subject] = subs[c.subject] || { chapters: [], total: 0 };
    subs[c.subject].chapters.push({ chapter: c.chapter, file: resolveBankFile(c.file) ?? c.file, count: c.count, types: c.types });
    subs[c.subject].total += c.count;
  }
  const out = { subjects: [], totalQuestions: 0 };
  for (const [name, v] of Object.entries(subs)) {
    out.subjects.push({ subject: name, total: v.total, chapters: v.chapters });
    out.totalQuestions += v.total;
  }
  // 教材信息
  out.textbooks = [];
  for (const subj of ['金融市场基础知识', '证券市场基本法律法规']) {
    const meta = readJson(path.join(KB_ROOT, 'textbook', subj, '_meta.json'));
    if (meta) out.textbooks.push({ subject: subj, pages: meta.pages, chunks: meta.chunks, chars: meta.chars });
  }
  return out;
}

export function listChapters(subject) {
  const bank = readJson(path.join(KB_ROOT, 'bank', 'chapter-index.json')) || [];
  return bank.filter((c) => !subject || c.subject === subject);
}

// 取一章节题目（可限制数量，优先真题，可指定题型过滤）
export function pickQuestions({ subject, chapter, type, count = 5, preferZhenti = true, excludeIds = [] }) {
  const all = [];
  const zhen = readJson(path.join(KB_ROOT, 'bank', '真题全集.json')) || [];
  if (preferZhenti) {
    for (const q of zhen) {
      if (chapter && !String(q.chapter || '').includes(String(chapter).replace(/^第[一二三四五六七八九十]+章\s*/, '').trim() === '' ? q.chapter || '' : q.chapter || '')) {}
      if (subject && q.subject !== subject) continue;
      if (type && q.type !== type) continue;
      if (excludeIds.includes(q.id)) continue;
      if (chapter && !String(q.chapter || '').includes(chapter)) continue;
      all.push(q);
    }
  }
  if (all.length < count) {
    const bank = readJson(path.join(KB_ROOT, 'bank', 'chapter-index.json')) || [];
    const hit = bank.find((c) => c.subject === subject && c.chapter === chapter);
    if (hit) {
      const qs = readJson(resolveBankFile(hit.file)) || [];
      for (const q of qs) {
        if (all.length >= count) break;
        if (type && q.type !== type) continue;
        if (excludeIds.includes(q.id)) continue;
        if (!all.some((x) => x.id === q.id)) all.push(q);
      }
    }
  }
  // 随机取 count
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, count);
}

// 题型标签：发给模型时**必须带题型**，否则模型不知道是单选/多选/判断，
// 容易把多选题当单选出（"选一个"），或漏掉判断题只能答"对/错"。
const TYPE_LABEL = {
  '单选题': '单选题（只有一个正确选项）',
  '多选题': '多选题（有两个或以上正确选项，全对才得分）',
  '判断题': '判断题（只能答 对/错 或 √/×）',
  '组合型选择题': '组合型选择题（Ⅰ~Ⅳ 是材料项，从 A~D 组合里选一个）'
};

/** 罗马数字前缀：题库里 stem_romans 已自带 "I. " 前缀，不能再加一遍（否则出现 "Ⅰ. I. xxx"） */
const ROMAN_PREFIX = /^[\u2160-\u2169IVXivx]+\s*[.、．)）]\s*/;

export function formatQuestion(q, showAnswer = false) {
  const lines = [];
  // 题型放最前（模型据此决定怎么问、学生怎么答）
  const label = TYPE_LABEL[q.type] || q.type || '';
  if (label) lines.push('【题型】' + label);
  if (q.year) lines.push('【' + q.year + '年' + (q.source || '') + '】');
  if (q.chapter) lines.push('（' + q.chapter + '）');
  lines.push(q.stem);
  if (q.stem_romans && q.stem_romans.length) {
    // 已带前缀的原样输出；没带的才补 Ⅰ Ⅱ Ⅲ …
    const hasOwn = q.stem_romans.every((x) => ROMAN_PREFIX.test(String(x).trim()));
    lines.push(q.stem_romans
      .map((x, i) => {
        const t = String(x).trim();
        return hasOwn ? t : String.fromCharCode(0x2160 + i) + '. ' + t;
      })
      .join('\n'));
  }
  (q.options || []).forEach((o) => lines.push(o));
  if (showAnswer) {
    lines.push('');
    lines.push('【答案】' + q.answer);
    if (q.analysis) lines.push('【解析】' + q.analysis);
  }
  return lines.join('\n');
}

// 按关键词检索教材切片
// 智能检索：先查干净文本(text_clean)，再回退原文；支持多关键词（同义词组），按命中评分排序
const SYNONYMS = {
  '注册制': ['注册制', '注册'],
  '核准制': ['核准制', '核准'],
  '科创板': ['科创板', '科创板注册'],
  '创业板': ['创业板'],
  '北交所': ['北交所', '北京证券交易所'],
  'iosco': ['IOSCO', '国际证监会组织', '证监会组织'],
  '证监会': ['证监会', '中国证监会'],
  '巴塞尔': ['巴塞尔', '巴塞尔委员会', '巴塞尔银行监管委员会'],
  '一级市场': ['一级市场', '发行市场'],
  '二级市场': ['二级市场', '流通市场', '交易市场'],
  '直接融资': ['直接融资'],
  '间接融资': ['间接融资'],
  '基金': ['基金', '证券投资基金'],
  '债券': ['债券'],
  '股票': ['股票'],
  '衍生': ['衍生工具', '金融衍生', '期货', '期权'],
  '做市商': ['做市商', '做市'],
  '投资者保护': ['投资者保护', '投服中心', '投资者保护机构'],
  '自律': ['自律组织', '证券业协会', '交易所自律'],
  '信息披露': ['信息披露', '信息批露'],
  '回购': ['回购', '逆回购'],
  '存款准备金': ['存款准备金', '准备金率'],
  '货币乘数': ['货币乘数'],
  '科创板做市': ['科创板做市', '做市商制度'],
  '债券通': ['债券通'],
  '沪港通': ['沪港通'],
  '深港通': ['深港通'],
  '融资融券': ['融资融券', '两融', '融券'],
  '退市': ['退市', '退市制度'],
  '科创板退市': ['退市制度', '科创板退市'],
  '新三板': ['新三板', '全国中小企业股份转让'],
  '区域性股权': ['区域性股权', '四板', '区域股权'],
  '场外市场': ['场外', '场外市场', '柜台市场', '银行间市场'],
  '场内市场': ['场内', '场内市场', '交易所市场']
};



// 基于知识点分段索引的精准检索（_segments.json）
function searchSegments(subject, keyword, maxSegs = 3) {
  const segFile = path.join(KB_ROOT, 'textbook', subject || '', '_segments.json');
  if (!fs.existsSync(segFile)) return null;
  let segs;
  try { segs = JSON.parse(fs.readFileSync(segFile, 'utf8')); } catch { return null; }
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const lowerKw = kw.toLowerCase();
  const kws = SYNONYMS[lowerKw] ? SYNONYMS[lowerKw] : [kw];
  const scored = [];
  for (const sg of segs) {
    const text = sg.text || '';
    let score = 0;
    for (const k of kws) {
      const kk = String(k).trim();
      if (!kk) continue;
      let pos = 0, cnt = 0;
      while ((pos = text.indexOf(kk, pos)) >= 0 && cnt < 30) { cnt++; pos += kk.length; }
      // 标题命中加权更高
      const inTitle = (sg.title || '').includes(kk) ? 5 : 0;
      score += cnt * 2 + (cnt > 0 ? inTitle : 0);
    }
    // 关键词出现在标题里即使正文没有也给分（代表该段主题）
    for (const k of kws) {
      if ((sg.title || '').includes(String(k).trim())) score += 3;
    }
    if (score > 0) scored.push({ sg, score });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => b.score - a.score);
  const out = [];
  const added = new Set();
  for (const { sg } of scored) {
    if (out.length >= maxSegs) break;
    if (added.has(sg.pages + sg.title)) continue;
    added.add(sg.pages + sg.title);
    // 附带下一段（知识点通常跨段）
    let text = sg.text;
    const idx = segs.indexOf(sg);
    if (idx >= 0 && idx + 1 < segs.length && segs[idx + 1].pages === sg.pages) {
      text += '\n' + segs[idx + 1].text.slice(0, 800);
    }
    out.push({ pages: sg.pages, title: sg.title, text: text.slice(0, 3000) });
  }
  return out;
}

export function searchTextbook(subject, keyword, maxChunks = 3) {
  const dir = path.join(KB_ROOT, 'textbook', subject || '');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('chunk_') && f.endsWith('.json'));
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  // 同义词组展开
  const lowerKw = kw.toLowerCase();
  let kws = SYNONYMS[lowerKw] ? SYNONYMS[lowerKw] : [kw];
  // 若关键词是短语，也尝试整句匹配 + 首词匹配
  if (kws.length === 1 && kw.includes(' ')) kws = [kw, kw.split(' ')[0]];
  const scored = [];
  for (const f of files) {
    const c = readJson(path.join(dir, f));
    if (!c) continue;
    const text = c.text_clean || c.text || '';
    let score = 0;
    const hits = [];
    for (const k of kws) {
      const kk = String(k).trim();
      if (!kk) continue;
      let count = 0;
      let pos = text.indexOf(kk);
      while (pos >= 0 && count < 20) {
        count++;
        if (hits.length < 6) hits.push(pos);
        pos = text.indexOf(kk, pos + kk.length);
      }
      if (count > 0) score += count * 3;
    }
    if (score > 0) {
      scored.push({ pages: c.pages, text, score, hits: hits.sort((a, b) => a - b) });
    }
  }
  if (!scored.length) return [];
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxChunks).map((x) => {
    // 按命中点取精准窗口：优先找"标题行"锚点（知识点/第X节），把整段正文返回
    const lines = x.text.split('\n');
    // 找离首个命中最近的标题行
    const firstHit = x.hits[0] || 0;
    let startLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const acc = lines.slice(0, i).join('\n').length;
      if (acc > firstHit) { startLine = Math.max(0, i - 1); break; }
    }
    // 从标题行开始收集，直到下一个同级标题或 3000 字
    const outLines = [];
    let chars = 0;
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];
      if (outLines.length > 3 && /^(知识点[一二三四五六七八九十]+|第[一二三四五六七八九十]+[章节])/.test(line)) break;
      outLines.push(line);
      chars += line.length + 1;
      if (chars > 3000) break;
    }
    // 若没找到标题行（startLine=0），退回窗口截取
    const text = outLines.join('\n') || x.text.slice(Math.max(0, firstHit - 300), firstHit + 900);
    return { pages: x.pages, text };
  });
}

// ── 学习进度 ──
function progressFile(uin) { return path.join(progressRoot(), `${uin}.json`); }
export function loadProgress(uin) { return readJson(progressFile(uin)) || { chaptersDone: [], wrongIds: [], quizHistory: [], updatedAt: null }; }
export function saveProgress(uin, data) { data.updatedAt = new Date().toISOString(); writeJson(progressFile(uin), data); }
export function markChapterDone(uin, subject, chapter) {
  const p = loadProgress(uin);
  if (!p.chaptersDone.some((c) => c.subject === subject && c.chapter === chapter)) p.chaptersDone.push({ subject, chapter, at: new Date().toISOString() });
  saveProgress(uin, p);
  return p;
}
export function recordQuiz(uin, { qid, subject, chapter, correct, userAnswer }) {
  const p = loadProgress(uin);
  p.quizHistory.push({ qid, subject, chapter, correct, userAnswer, at: new Date().toISOString() });
  if (p.quizHistory.length > 500) p.quizHistory = p.quizHistory.slice(-500);
  if (correct) p.wrongIds = p.wrongIds.filter((w) => w.qid !== qid);
  else if (!p.wrongIds.some((w) => w.qid === qid)) p.wrongIds.push({ qid, subject, chapter, at: new Date().toISOString() });
  saveProgress(uin, p);
  return p;
}
export function formatProgress(p) {
  if (!p) return '暂无学习记录';
  const lines = [`已学完章节：${p.chaptersDone.length ? p.chaptersDone.map((c) => c.chapter).join('、') : '无'}`];
  lines.push(`错题数：${p.wrongIds.length}`);
  if (p.quizHistory.length) {
    const total = p.quizHistory.length;
    const correct = p.quizHistory.filter((h) => h.correct).length;
    lines.push(`答题记录：${total} 题，正确 ${correct}（${Math.round((correct / total) * 100)}%）`);
  }
  return lines.join('\n');
}


// ── 学习记录（长期记忆）────────────────────────────
// 学习记录.md 是跨会话的长期教学档案：每次会话结束后把本轮教学内容总结追加进去，
// 教师每次上课前读摘要即可掌握主人长期进度。
const STUDY_LOG = () => path.join(progressRoot(), '学习记录.md');

export function readStudyLog(maxChars = 6000) {
  try {
    const txt = fs.readFileSync(STUDY_LOG(), 'utf8');
    return txt.length > maxChars ? txt.slice(-maxChars) : txt;
  } catch { return ''; }
}

export function readStudyLogHead(maxLines = 200) {
  try {
    const lines = fs.readFileSync(STUDY_LOG(), 'utf8').split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch { return ''; }
}

export function appendStudyLog(section) {
  const t = new Date();
  const ts = t.toLocaleString('zh-CN', { hour12: false });
  const entry = '\n\n---\n\n## 📅 ' + ts + '\n' + String(section || '').trim();
  fs.mkdirSync(path.dirname(STUDY_LOG()), { recursive: true });
  fs.appendFileSync(STUDY_LOG(), entry, 'utf8');
  return true;
}


// ── 教材大纲（结构浏览/覆盖检查）────────────────────────
// _outline.json 由 build_outline.py 生成：章节→知识点层级。用于：
//  1) 教师"按章浏览"教材结构（不依赖关键词）
//  2) 章节讲完前对照大纲做覆盖检查，避免漏知识点
const OUTLINES = {
  '金融市场基础知识': path.join(KB_ROOT, 'textbook', '金融市场基础知识', '_outline.json'),
  '证券市场基本法律法规': path.join(KB_ROOT, 'textbook', '证券市场基本法律法规', '_outline.json')
};

export function chapterOutline(subject, chapterNum) {
  const f = OUTLINES[subject];
  if (!f || !fs.existsSync(f)) return [];
  const outline = JSON.parse(fs.readFileSync(f, 'utf8'));
  const cn = String(chapterNum).replace('第', '').replace('章', '');
  const nums = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  const cval = nums[cn] || Number(cn) || cn;
  // 目标章匹配：'第一章'/'1'/'一' 都能命中
  const isTargetChapter = (title) => {
    const m = /^第([一二三四五六七八九十]+)章/.exec(title || '');
    if (!m) return false;
    const n = nums[m[1]] || m[1];
    return String(n) === String(cval);
  };
  // 只取"正文大纲"（最后一段完整章节序列，特征：section 后跟 point）。策略：
  // 1) 找所有目标章出现位置；2) 对每个出现，向后收集直到下一章；3) 选 point 数量最多的那次。
  let best = null;
  let bestScore = -1;
  for (let i = 0; i < outline.length; i++) {
    if (outline[i].type !== 'chapter' || !isTargetChapter(outline[i].title)) continue;
    const collected = { chapter: outline[i].title, sections: [], curSec: null, secSeen: new Set(), ptSeen: new Set() };
    for (let j = i + 1; j < outline.length; j++) {
      const e = outline[j];
      if (e.type === 'chapter') break;
      if (e.type === 'section') {
        // 同一节名已收过则复用（正文可能出现多次小节重复），否则新开
        const exist = collected.sections.find((x) => x.section === e.title);
        if (exist) { collected.curSec = exist; }
        else if (!collected.secSeen.has(e.title)) {
          collected.secSeen.add(e.title);
          const sec = { section: e.title, points: [] };
          collected.sections.push(sec);
          collected.curSec = sec;
        } else { collected.curSec = collected.sections.find((x) => x.section === e.title) || null; }
        continue;
      }
      if (e.type === 'point') {
        if (collected.curSec && !collected.ptSeen.has(e.title)) {
          collected.ptSeen.add(e.title);
          collected.curSec.points.push(e.title);
        }
      }
    }
    const score = collected.sections.reduce((n, x) => n + x.points.length, 0);
    if (score > bestScore) { best = collected; bestScore = score; }
  }
  if (!best) return { chapter: '第' + cval + '章', sections: [] };
  return best;
}

// 从学习记录/教学档案提取"已讲知识点"关键词，粗比对大纲（教师人工判断用）
export function formatOutline(o) {
  if (!o || !o.chapter) return '（未找到该章大纲）';
  const lines = ['【' + o.chapter + ' 教材大纲】'];
  for (const sec of o.sections) {
    lines.push('\n' + sec.section + '：');
    if (sec.points.length) sec.points.forEach((pt) => lines.push('  ☐ ' + pt));
    else lines.push('  （本节无细分知识点）');
  }
  return lines.join('\n');
}


// 按章/节标题取正文切片（讲某节内容时用，返回匹配的原文块）
export function searchTextbookBySection(subject, sectionKeyword, maxChunks = 4) {
  const dir = path.join(KB_ROOT, 'textbook', subject || '');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('chunk_') && f.endsWith('.json'));
  const kw = String(sectionKeyword || '').trim();
  const scored = [];
  for (const f of files) {
    const c = readJson(path.join(dir, f));
    if (!c) continue;
    const text = c.text;
    let score = 0;
    if (kw) {
      if (text.includes(kw)) score += 2;
      // 该节的关键词常出现（去重后的行数）
      const hits = text.split('\n').filter((l) => l.includes(kw)).length;
      score += hits;
    }
    if (score > 0) scored.push({ pages: c.pages, text, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxChunks).map((x) => ({ pages: x.pages, text: x.text.slice(0, 3500) }));
}
