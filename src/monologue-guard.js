// 内心独白检测：判断模型的 content 到底是「对主人说的话」还是「自己的思考」。
//
// 背景（2026-09-13 建立，2026-09-14 重写）：
//   私聊场景有多个 content 兜底发送路径，而 content 有两种截然不同的含义——
//     ① 模型"边说边做"：content = 给主人的话（该发）
//     ② 模型"先想再做"：content = 内心独白/决策过程（不该发，发出去就是自言自语）
//
// 2026-09-14 事故：用户反馈机器人"经常把思考内容发给我"（如"已出题，等学生作答"、
// 工具状态、自己的状态）。复盘发现**旧版拦截器对真实泄漏文本拦截率 0/9**——
// 它只匹配"以第三人称自指开头"等句式，而实际泄漏是**第一人称教学叙述**
// （"让我看这题""先登记""还剩两项"），完全没覆盖。
//
// 本次重写的关键：**先用 160 条真实记录统计了各候选词的区分度**，
// 只保留"泄漏里常见、正文里罕见"的特征。踩过的坑：
//   ✗ "回炉/进度/队列/档/工具/先/还剩/主人" 这些看似像内部术语，
//     实际是**教学口语**（正文里出现 14/7/5/7/20/32/6/13 次），拿它们当特征会大面积误伤。
//   ✓ 真正有区分度的是："学生"作第三人称、工具字段名（key/qid/today/plan）、
//     "本轮/已出题/等学生作答"、报错重试叙述。
//
// 判别核心（实测最有效）：
//   ★ 泄漏文本把**学生当第三人称**叙述（"学生答了 D""等学生作答"），
//     而真正对主人说话必然用**第二人称**（"你""同学"）。
//
// 策略：命中强信号直接判思考；其余加权累计达阈值判思考；
//       第二人称/称呼/颜文字等正文特征给负分抵消，宁可漏判也不误伤正文。

/** 强信号1：把学生当第三人称叙述（对主人说话不会这样讲） */
const THIRD_PERSON_STUDENT = /(学生|学员)(答|选|说|问|没答|未答|作答|已答|回答|掌握|表现|状态|回来|主动)/;

/** 强信号2：内部工具/字段名（正文里不会出现） */
const TOOL_JARGON = /\b(study_plan|kb_[a-z]+|qid|today|plan\b|section-done|action\s*=)/i;

/** 强信号3：内部运行收尾语 */
const RUN_WRAPUP = /(已出题|出题完毕|等学生作答|等待作答|等待学生|待学生|本轮结束|本轮已|本次处理结束|这条会话|这轮就)/;

/** 加权信号：自我叙述 / 内部流程（区分度已验证） */
const THINK_PATTERNS = [
  { re: /(登记|进第\s*\d+\s*[/／]?\s*\d*\s*档)/, w: 3, why: '内部进度登记' },
  { re: /\b(key|qid)\b/i, w: 3, why: '内部字段名' },
  { re: /(本轮|这轮|本次运行|当前会话)/, w: 3, why: '内部运行术语' },
  { re: /(调用|参数|返回值|报错|重试|定位不到|拿不到|取不到|失败了|没有返回)/, w: 3, why: '工具执行叙述' },
  { re: /(让我|我先|我得先|我要先|我该)(看|查|确认|登记|处理|推进|试|停)/, w: 2, why: '第一人称计划' },
  { re: /^(先|让我|我)(看看|查一下|确认一下|看一眼|把|用|试|停止|直接)/, w: 2, why: '第一人称计划（句首）' },
  { re: /(^|[。！？\s])(Master|master|主人)\s*(说|让|在|问|的|明确|已经|发|这|要求|想|点|是|同意|回复|答)/, w: 4, why: '第三人称自指主人' },
  { re: /按(角色卡|流程|规则)/, w: 3, why: '引用自身规则' },
  { re: /(已经发问|已发问|已经提了|等主人作答|等主人回复|留给他|留给明天)/, w: 3, why: '内部等待语' },
];

/** 正文特征（命中则抵消，防误伤） */
const HUMAN_PATTERNS = [
  { re: /(你|您)(的|了|要|是|来|看|答|选|想|觉得|能|可以|再|把|这个|那个|这题|那题|错题|本|刚刚|刚才|之前|上一条)/, w: -5, why: '第二人称对话' },
  { re: /同学/, w: -5, why: '称呼同学' },
  { re: /^(主人|master|同学|宝子)[～~]?[，,！!]/i, w: -4, why: '对主人称呼开场' },
  { re: /[（(](๑|ᗜ|｡|°ω|✧|ᴗ|•̀|￣|－)/, w: -4, why: '颜文字' },
  { re: /[～~✧♪]$/, w: -2, why: '语气词收尾' },
  { re: /^(答完|写完|直接发我|来，|请|下列|以下|下列关于)/, w: -3, why: '出题/指令口吻' },
  { re: /[（(]\s*(提示|答案|解析|选)/, w: -3, why: '讲解答题口吻' },
  { re: /^(【(明日课程|模型与产品|资本与巨头|安全与监管|今日))/, w: -5, why: '系统内容块' },
];

/**
 * 判断 content 是否为「内心独白」（不该发到 QQ）。
 * @param {string} text  模型的 content
 * @param {object} opts  { hasSendMessage: boolean } 本轮是否已调用 send_message
 * @returns {{ think: boolean, score: number, why: string[] }}
 */
export function looksLikeMonologue(text, { hasSendMessage = false } = {}) {
  const s = String(text || '').trim();
  if (!s) return { think: false, score: 0, why: ['空文本'] };

  const why = [];
  let score = 0;

  // 信号A：本轮已用 send_message 说过话 → content 基本是思考（正文已单独发出）
  if (hasSendMessage) {
    score += 5;
    why.push('本轮已调用 send_message');
  }

  // 强信号：命中即基本可判思考
  if (THIRD_PERSON_STUDENT.test(s)) { score += 6; why.push('第三人称叙述学生'); }
  if (TOOL_JARGON.test(s)) { score += 5; why.push('内部工具/字段名'); }
  if (RUN_WRAPUP.test(s)) { score += 5; why.push('内部收尾语'); }

  for (const p of THINK_PATTERNS) if (p.re.test(s)) { score += p.w; why.push(p.why); }
  for (const p of HUMAN_PATTERNS) if (p.re.test(s)) { score += p.w; why.push(p.why); }

  // 阈值 4：正文特征会显著拉低分数。宁可漏判（少发一条）也不误伤正文。
  return { think: score >= 4, score, why };
}

/**
 * 严格正向判定：这段文本**明确是在对主人说话**吗？
 *
 * 与 looksLikeMonologue 的区别：那个是"排除法"（像思考就拦），本函数是"确认法"
 * （必须找到明确的对人说话特征才放行）。用于**工具调用轮次的 content 兜底**——
 * 该场景实测 33 条里只有 2 条含第二人称且仍是思考，所以默认不发，只放行铁证。
 *
 * 放行条件（需同时满足）：
 *   1. 含第二人称对话特征（你/您/同学 + 动词），或对主人称呼开场
 *   2. 不含任何内部术语/工具字段/第三人称叙述学生
 *   3. 长度合理（≥6 字，≤2000 字）
 */
export function looksSpokenToUser(text) {
  const s = String(text || '').trim();
  if (!s || s.length < 6 || s.length > 2000) return false;

  // 条件2：任何内部特征 → 一票否决
  if (THIRD_PERSON_STUDENT.test(s)) return false;
  if (TOOL_JARGON.test(s)) return false;
  if (RUN_WRAPUP.test(s)) return false;
  if (/(登记|进第\s*\d+\s*[/／]?\s*\d*\s*档|本轮|这轮|本次运行|当前会话)/.test(s)) return false;
  if (/(调用|参数|返回值|报错|重试|定位不到|拿不到|取不到|失败了|没有返回)/.test(s)) return false;
  if (/(让我|我先|我得先|我要先|我该)(看|查|确认|登记|处理|推进|试|停)/.test(s)) return false;
  if (/(^|[。！？\s])(Master|master|主人)\s*(说|让|在|问|的|明确|已经|发|这|要求|想|点|是|同意|回复|答)/.test(s)) return false;
  if (/按(角色卡|流程|规则)/.test(s)) return false;
  if (/(已经发问|已发问|已经提了|等主人作答|等主人回复|留给他|留给明天|还剩|还差)/.test(s)) return false;
  if (/^(先|让我|我)(看看|查一下|确认一下|看一眼|把|用|试|停止|直接)/.test(s)) return false;
  if (/(取到了|拿到了|拿到了|找到了|搜到了|读到了|看到了|没找到|没搜到|没有找到)/.test(s)) return false;
  if (/(继续往下|接着往下|往下读|往下讲|下一步|接下来|然后开|现在可以进入|可以进入第)/.test(s)) return false;
  if (/^(开始上课|继续|好，|好的，|嗯，)/.test(s) && !/(你|您|同学)/.test(s)) return false;

  // 条件1：必须有明确的对人说话特征
  const hasSecondPerson = /(你|您)(的|了|要|是|来|看|答|选|想|觉得|能|可以|再|把|这个|那个|这题|那题|错题|本|刚刚|刚才|之前|上一条|呢|吗|吧)/.test(s);
  const hasAddress = /(^|[，。！？\s])(同学|主人|宝子)/.test(s);
  return hasSecondPerson || hasAddress;
}

