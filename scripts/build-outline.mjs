// 从教材切片重建 _outline.json（章节 → 知识点层级）。
//
// 背景：src/knowledge.js 的 OUTLINES 表要求 textbook/<科目>/_outline.json，
// 但原包只带了「金融市场基础知识」那一份，生成脚本 build_outline.py 未随包发布。
// 本脚本用现有 chunk_*.json 重建缺失的大纲，供 chapterOutline()「按章浏览/覆盖检查」使用。
//
// 两本教材的排版不同，脚本对两种格式都做解析：
//   金融市场基础知识：知识点一/二/… 内联标记
//   证券市场基本法律法规：考点 1-1 内联标记（标题在下一行，尾巴带【掌握/熟悉/了解】）
//                         + 「考点/内容/考察要求」三列表格
//
// 用法：
//   node scripts/build-outline.mjs                 # 只生成缺失的科目（已存在则跳过）
//   node scripts/build-outline.mjs --force         # 全部重新生成
//   node scripts/build-outline.mjs --force 金融市场基础知识
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_ROOT = path.join(__dirname, '..', 'data', 'knowledge', 'securities');
const TEXTBOOK = path.join(KB_ROOT, 'textbook');

const ALL_SUBJECTS = ['金融市场基础知识', '证券市场基本法律法规'];
const REQ = /^(掌握|熟悉|了解)$/;

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const subjects = argv.filter((a) => !a.startsWith('--'));
const targets = subjects.length ? subjects : ALL_SUBJECTS;

// PDF 抽取的文本很碎：每页有页眉（科目名）与页脚（广告 + "n / m" 页码），
// 且同一行常被抽到两次（叠字）。先归一化成干净的行序列。
function normalize(text) {
  const raw = String(text || '').split('\n').map((s) => s.replace(/\u3000/g, ' ').trim());
  const dedup = [];
  for (const l of raw) {
    if (!l) continue;
    if (/考前绝密包过押题/.test(l)) continue;                 // 页脚广告
    if (/^证券从业-/.test(l)) continue;                       // 页眉科目名
    if (dedup.length && dedup[dedup.length - 1] === l) continue; // 叠字折叠
    dedup.push(l);
  }
  // 去页脚页码三连：<数字> / <数字>
  const out = [];
  for (let i = 0; i < dedup.length; i++) {
    const prev = out[out.length - 1] || '';
    if (dedup[i] === '/' && /^\d+$/.test(prev) && /^\d+$/.test(dedup[i + 1] || '')) {
      out.pop();
      i++;
      continue;
    }
    out.push(dedup[i]);
  }
  return out;
}

function loadLines(subject) {
  const dir = path.join(TEXTBOOK, subject);
  if (!fs.existsSync(dir)) throw new Error(`教材目录不存在: ${dir}`);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('chunk_') && f.endsWith('.json')).sort();
  if (!files.length) throw new Error(`没有 chunk_*.json: ${dir}`);
  const lines = [];
  for (const f of files) {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    lines.push(...normalize(c.text));
  }
  return lines;
}

// 同一行被抽成 "X" + "X"（如「第九节 其他业务第九节 其他业务」）时折叠成 X
function collapseDoubled(line) {
  const m = /^(.+?)\1$/.exec(line);
  return m ? m[1].trim() : line;
}

const isSectionTitle = (l) => /^第[一二三四五六七八九十]+节[\s\u3000]/.test(l) && collapseDoubled(l).length <= 40;
const cleanSection = (l) => collapseDoubled(l).replace(/\s+/g, ' ').trim();

// 知识点标题归一：去掉尾部【掌握/熟悉/了解】与首尾空白
const cleanPoint = (l) => String(l || '').replace(/【(掌握|熟悉|了解)】\s*$/, '').replace(/\s+/g, ' ').trim();

// 「考点 / 内容 / 考察要求」三列表格
function parseRequirementTable(lines, i) {
  const rows = [];
  if (lines[i] !== '考点' || lines[i + 1] !== '内容' || lines[i + 2] !== '考察要求') return { rows, next: i };
  let j = i + 3;
  while (j + 2 < lines.length) {
    if (!/^\d+$/.test(lines[j])) break;
    const title = cleanPoint(lines[j + 1]);
    if (!title || !REQ.test(lines[j + 2])) break;
    rows.push({ num: lines[j], title });
    j += 3;
  }
  return { rows, next: j };
}

function buildOutline(subject) {
  const lines = loadLines(subject);
  const entries = [];
  const seenChapter = new Set();
  const seenSection = new Set();
  const seenPoint = new Set();
  let curChapter = null;
  let curSection = null;

  const addPoint = (label, title) => {
    if (!curChapter || !curSection || !title) return;
    const key = `${curSection}|${title}`;
    if (seenPoint.has(key)) return;   // 同一知识点在表格与内联里各出现一次，去重
    seenPoint.add(key);
    entries.push({ type: 'point', title: `${label} ${title}`, chapter: curChapter, section: curSection });
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    // 章一：单独一行的「第N章」，标题在紧随的《…》里（法规教材）
    const chM = /^第([一二三四五六七八九十]+)章$/.exec(l);
    if (chM) {
      for (let k = i + 1; k < Math.min(i + 8, lines.length); k++) {
        if (lines[k] === '《') {
          const title = (lines[k + 1] || '').replace(/\s+/g, ' ').trim();
          if (title && lines[k + 2] === '》') {
            const name = `第${chM[1]}章 ${title}`;
            if (!seenChapter.has(name)) {
              seenChapter.add(name);
              entries.push({ type: 'chapter', title: name });
            }
            curChapter = name;
            curSection = null;
          }
          break;
        }
      }
      continue;
    }

    // 章二：内联「第N章 标题」（金融教材）
    const ch2 = /^(第[一二三四五六七八九十]+章)[\s\u3000]+(\S.*)$/.exec(l);
    if (ch2 && l.length <= 40) {
      const name = `${ch2[1]} ${ch2[2]}`.replace(/\s+/g, ' ').trim();
      if (!seenChapter.has(name)) {
        seenChapter.add(name);
        entries.push({ type: 'chapter', title: name });
      }
      curChapter = name;
      curSection = null;
      continue;
    }

    // 节（同一节会跨页重复出现，仅在内容变化时重新登记）
    if (isSectionTitle(l)) {
      const title = cleanSection(l);
      curSection = title;
      const key = `${curChapter}|${title}`;
      if (curChapter && !seenSection.has(key)) {
        seenSection.add(key);
        entries.push({ type: 'section', title, chapter: curChapter });
      }
      continue;
    }

    // 知识点一：内联「知识点N 标题」（金融教材）
    const kp = /^(知识点[一二三四五六七八九十百]+)[\s\u3000]+(\S.*)$/.exec(l);
    if (kp) {
      addPoint(kp[1], cleanPoint(kp[2]));
      continue;
    }

    // 知识点二：内联「考点 / N-M / 标题【要求】」（法规教材）
    if (l === '考点' && /^\d+-\d+$/.test(lines[i + 1] || '')) {
      addPoint(`考点${lines[i + 1]}`, cleanPoint(lines[i + 2]));
      i += 2;
      continue;
    }

    // 知识点三：「本节考点分布」后的三列表格（法规教材）
    if (l === '本节考点分布') {
      for (let k = i + 1; k < Math.min(i + 6, lines.length); k++) {
        if (lines[k] === '考点' && lines[k + 1] === '内容') {
          const { rows, next } = parseRequirementTable(lines, k);
          for (const r of rows) addPoint(`考点${r.num}`, r.title);
          i = Math.max(i, next - 1);
          break;
        }
      }
      continue;
    }
  }

  return entries;
}

for (const subject of targets) {
  const outFile = path.join(TEXTBOOK, subject, '_outline.json');
  if (fs.existsSync(outFile) && !force) {
    console.log(`${subject}: 已存在，跳过（--force 可覆盖）`);
    continue;
  }
  const outline = buildOutline(subject);
  if (!outline.length) throw new Error(`${subject}: 解析结果为空，请检查教材 chunk 格式`);
  fs.writeFileSync(outFile, JSON.stringify(outline, null, 1), 'utf8');
  const n = (t) => outline.filter((e) => e.type === t).length;
  const uniq = (t) => new Set(outline.filter((e) => e.type === t).map((e) => e.title)).size;
  console.log(
    `${subject}: chapter=${n('chapter')}(${uniq('chapter')} 唯一) ` +
    `section=${n('section')}(${uniq('section')} 唯一) point=${n('point')} -> ${outFile}`
  );
}
