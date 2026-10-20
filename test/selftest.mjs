// 端到端审计：mock OneBot（WS 收事件 + HTTP 发送）+ mock OpenAI 兼容 API，
// 完整跑一遍核心需求流程，逐项断言。不触碰真实 QQ / 真实模型。
//
// 运行：node test/selftest.mjs（DEBUG_TESTS=1 输出诊断）
import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';

// ── 基础设施 ──
async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(text)); } catch { resolve(text); }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 8000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* 继续等 */ }
    await sleep(40);
  }
  throw new Error(`等待超时：${label}`);
}

// ── Mock OneBot（HTTP + WS） ──
function createMockOneBotHttp() {
  const state = { sends: [], pokes: [] };
  const TINY_PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const action = req.url.replace(/^\//, '');
    const reply = (data) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    };
    if (action === 'get_login_info') return reply({ user_id: 888, nickname: '审计Bot' });
    if (action === 'get_group_info') return reply({ group_id: body.group_id, group_name: `审计群${body.group_id}` });
    if (action === 'get_group_member_info') return reply({ card: `名片${body.user_id}`, nickname: `昵称${body.user_id}` });
    if (action === 'get_group_list') return reply([{ group_id: 456, group_name: '审计群456' }, { group_id: 789, group_name: '备用群789' }]);
    if (action === 'get_friend_list') return reply([{ user_id: 777, nickname: '好友777', remark: '老友' }]);
    if (action === 'get_msg') return reply({ sender: { card: '被引用者', nickname: '被引用者' }, message: [{ type: 'text', data: { text: '被引用的原话' } }] });
    if (action === 'fetch_custom_face_detail') return reply([{ emoji_id: 'st1', res_id: 'st1', md5: 'aaa', desc: '滑稽', url: `http://127.0.0.1:${PORTS.onebotHttp}/img.png` }]);
    if (action.startsWith('search')) {
      // 模拟 Bing 结果页（b_algo 块结构）
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body>
        <li class="b_algo"><h2><a href="https://example.com/a">审计梗的完整解释</a></h2><p>审计梗是指……的完整解释内容。</p></li>
        <li class="b_algo"><h2><a href="https://example.com/b">第二个结果</a></h2><p>摘要二。</p></li>
      </body></html>`);
      return;
    }
    if (action === 'group_poke' || action === 'send_poke') {
      state.pokes.push(body);
      return reply({});
    }
    if (action === 'send_group_msg' || action === 'send_private_msg') {
      state.sends.push({ action, body, at: Date.now() });
      return reply({ message_id: 5000 + state.sends.length });
    }
    if (action === 'img.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(TINY_PNG);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: '未知动作' }));
  });
  return { server, state };
}

function createMockOneBotWs() {
  const state = { client: null, events: [] };
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const ready = new Promise((r) => wss.once('listening', r));
  wss.on('connection', (socket) => { state.client = socket; });
  return {
    server: wss,
    state,
    async ready() { await ready; return wss.address().port; },
    push(event) {
      state.events.push(event);
      if (state.client && state.client.readyState === WebSocket.OPEN) {
        state.client.send(JSON.stringify(event));
      } else {
        throw new Error('Mock OneBot WS 尚无客户端连接');
      }
    },
    close() { return new Promise((r) => wss.close(r)); }
  };
}

// ── Mock OpenAI 兼容 API：脚本化响应 + 全量请求记录 ──
function createMockLLM() {
  const state = { requests: [], script: [] };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model-a' }, { id: 'test-model-b' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = await readBody(req);
      // 图片输入探测请求（vision scan）：不进脚本队列，按模型名给固定答案。
      // 用探测专属提问文本识别，避免误伤真实运行里"模型看图"的请求（同样带 image_url）。
      const isProbe = (body.messages || []).some((m) => Array.isArray(m.content)
        && m.content.some((c) => c.type === 'text' && String(c.text || '').includes('这张图片里是什么')));
      if (isProbe) {
        state.probes = state.probes || [];
        state.probes.push(body.model);
        if (String(body.model).includes('vision-no')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'image input is not supported for this model' } }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '一个红色像素点' } }] }));
        }
        return;
      }
      const step = state.requests.length;
      state.requests.push(body);
      let scripted = state.script[step];
      if (!scripted) scripted = { content: '（默认：无动作）' };
      if (scripted.delayMs) await sleep(scripted.delayMs);
      const message = { role: 'assistant', content: scripted.content ?? null };
      if (scripted.toolCalls) {
        message.tool_calls = scripted.toolCalls.map((tc, i) => ({
          id: `call_${step}_${i}`,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) }
        }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `chatcmpl_${step}`,
        model: 'test-model-a',
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100 + step * 10, completion_tokens: 20, total_tokens: 120 + step * 10 }
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { server, state };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// ── 主流程 ──
const PORTS = {};
const results = [];
function pass(name, extra = '') {
  results.push({ name, ok: true, extra });
  console.log(`  ✓ ${name}${extra ? ` —— ${extra}` : ''}`);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-test-'));
  process.env.QQ_AGENT_DATA_DIR = dataDir;

  const onebotHttp = createMockOneBotHttp();
  PORTS.onebotHttp = await listen(onebotHttp.server);
  const onebotWs = createMockOneBotWs();
  PORTS.onebotWs = await onebotWs.ready();
  const llm = createMockLLM();
  PORTS.llm = await listen(llm.server);

  // fixture：模拟 DSH settings.yaml + .credentials.yaml（密钥优先级：凭据文件 > 环境变量）
  const fixtureYaml = path.join(dataDir, 'dsh-settings.yaml');
  fs.writeFileSync(fixtureYaml, `
agent-default-model:
  provider: openrouter
  model: z-ai/glm-5.3-flash
llm-pi-ai:
  providers:
    a6api:
      displayName: A6API中转站
      apiKeyEnv: A6API_API_KEY
      api: anthropic-messages
      baseURL: https://api.a6api.com/v1
      models:
        - glm-5.3-flash
        - DeepSeek-V4-Flash-0731
    a6apiforclaude:
      displayName: A6API-Claude
      apiKeyEnv: A6API_API_KEY
      api: anthropic-messages
      baseURL: https://api.a6api.com
      models:
        - claude-fable-5
    openrouter:
      apiKeyEnv: OPENROUTER_API_KEY
      models:
        - z-ai/glm-5.3-flash
    local-8787:
      displayName: 本地中转8787
      apiKeyEnv: LOCAL_8787_API_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:8787/v1
      models:
        - hy4-preview
        - glm-5.3-flash
    visiontest:
      displayName: 视觉探测测试
      apiKeyEnv: VISIONTEST_API_KEY
      baseURL: http://127.0.0.1:${PORTS.llm}/v1
      models:
        - vision-ok-model
        - vision-no-model
`);
  process.env.A6API_APIKEY = 'test-a6api-key'; // 模拟环境变量别名解析（应被凭据文件覆盖）
  fs.writeFileSync(path.join(dataDir, '.credentials.yaml'), `version: 1
refs:
  A6API_API_KEY: cred-a6api-key
  LOCAL_8787_API_KEY: cred-local-key
  VISIONTEST_API_KEY: cred-visiontest-key
`);

  const cfg = {
    api: { baseUrl: `http://127.0.0.1:${PORTS.llm}/v1`, apiKey: 'test-key', model: 'test-model-a', vision: true, temperature: 0.7, maxRounds: 6, priceInputPerM: 2, priceOutputPerM: 8 },
    providersSourceYaml: fixtureYaml,
    webSearch: { enabled: true, searchUrl: `http://127.0.0.1:${PORTS.onebotHttp}/search`, maxResults: 6 },
    security: { allowPrivateImageHosts: false },
    snowluma: { wsUrl: `ws://127.0.0.1:${PORTS.onebotWs}`, httpUrl: `http://127.0.0.1:${PORTS.onebotHttp}`, accessToken: '' },
    persona: { botName: '审计Bot', participation: 'medium', roleText: '你是审计群里的机器人。' },
    allow: { groups: ['456'], private: ['777'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    wakeDelayMs: 300,
    drainDelayMs: 200,
    maxConcurrentRuns: 2,
    send: { minGapMs: 10, maxGapMs: 20, byLengthMs: 0, maxPerMinute: 100, maxPerHour: 1000, hardSplitAt: 4000 },
    proactive: { enabled: false },
    sticker: { enabled: true, collectEnabled: true },
    store: { maxMessagesPerChat: 0, pastStateLimit: 80, pastStateMaxChars: 6000, keepSessionFiles: 100 },
    server: { port: await freePort(), token: '' }
  };
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg));

  const { createApp } = await import('../src/app.js');
  const app = createApp({ log: () => {} });
  await app.start();

  // 同步原语
  const waitSessionDone = async (triggerSubstring, timeout = 9000) => {
    const s = await waitFor(() => {
      const found = app.sessions.listSummaries(10).find((e) => (e.trigger || '').includes(triggerSubstring));
      if (found && found.status !== 'running') return found;
      return null;
    }, timeout, `会话(${triggerSubstring})结束`);
    return app.sessions.get(s.id);
  };
  const pushGroupMsg = (userId, name, text, mid, extra = {}) => onebotWs.push({
    post_type: 'message',
    message_type: 'group',
    group_id: 456,
    user_id: userId,
    self_id: 888,
    message_id: mid,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userId, card: name, nickname: name },
    message: [{ type: 'text', data: { text } }],
    ...extra
  });

  // ── 场景 0：OneBot 已连接 ──
  await waitFor(() => app.onebot.connected, 5000, 'OneBot WS 连接');
  pass('OneBot WebSocket 已连接并取得登录信息', `self=${app.onebot.selfId}`);

  // ── 场景 1：消息触发运行，模型用工具发言 ──
  llm.state.script.push(
    { delayMs: 400, toolCalls: [{ name: 'send_message', args: { messages: ['在的', '咋了 [CQ:at,qq=1]'] } }] },
    { content: '（第一轮处理完毕）' }
  );
  pushGroupMsg(111, '张三', '在吗？', 9001);

  await waitFor(() => llm.state.requests.length >= 1, 5000, '第一次 LLM 调用');
  const req1 = llm.state.requests[0];
  assert.strictEqual(req1.messages.length, 2, '第一次运行只应有 system+user 两条消息（零 LLM 历史）');
  assert.strictEqual(req1.messages[0].role, 'system');
  assert.strictEqual(req1.messages[1].role, 'user');
  const user1 = req1.messages[1].content;
  assert.ok(user1.includes('【本次唤醒】') && user1.includes('在吗？'), '用户消息含本次唤醒与触发文本');
  assert.ok(user1.includes('【当前时间】') && user1.includes('【过去状态】'), '用户消息含时间与过去状态');
  assert.ok(req1.tools?.some((t) => t.function.name === 'send_message'), 'send_message 工具已暴露');
  const toolNames = req1.tools.map((t) => t.function.name);
  assert.ok(!toolNames.some((n) => n.includes('qq_')), '工具名不带 qq_ 前缀');
  assert.ok(!toolNames.includes('wait_for_messages') && !toolNames.includes('set_wake_config'), '无等待/唤醒类工具');
  pass('运行 1：零历史提示词 + 工具集正确', `${user1.length} 字符用户消息`);

  const session1 = await waitSessionDone('在吗？');
  await waitFor(() => onebotHttp.state.sends.length >= 2, 5000, '两条 QQ 消息已发出');
  const send1 = onebotHttp.state.sends[0];
  const send2 = onebotHttp.state.sends[1];
  assert.strictEqual(send1.body.message[0].data.text, '在的');
  assert.strictEqual(send2.body.message[0].data.text, '咋了 [CQ：at,qq=1]', 'CQ 码已转义');
  pass('发送：分条 + 顺序 + CQ 转义正确');

  assert.ok(session1.status === 'done', `运行 1 状态应为 done，实际 ${session1.status}`);
  assert.strictEqual(session1.usage.totalTokens, 250, 'usage 已累计两次调用（120+130）');
  assert.strictEqual(session1.sent.length, 2, '会话记录了 2 条已发送');
  assert.ok(session1.systemPrompt && session1.userPrompt, '会话记录含完整提示词');
  pass('会话记录：状态/用量/已发送/提示词留档完整', `totalTokens=${session1.usage.totalTokens}`);

  // ── 场景 2：处理期间插入新消息 → 结束后 drain 新开会话（需求 5 核心流程） ──
  llm.state.script.push(
    { delayMs: 600, content: '（看看再说）' },          // 运行 A：只有一轮，人为拖慢
    { content: '（看了下是闲聊，不用回）' }             // drain 运行
  );
  const reqsBeforeA = llm.state.requests.length;
  pushGroupMsg(113, '王五', '看看这个', 9010);
  await waitFor(() => llm.state.requests.length >= reqsBeforeA + 1, 5000, '运行 A 开始');
  await sleep(250);                                    // 处于 600ms 延迟中 = 运行 A 进行中
  pushGroupMsg(111, '张三', '处理期间插进来的新消息', 9011);  // ← 关键注入

  const sessionA = await waitSessionDone('看看这个');
  assert.strictEqual(sessionA.status, 'noreply', '运行 A 没有发言（正常选项）');
  assert.ok(onebotHttp.state.sends.every((s) => s.body.message.at(-1).data.text !== '（看看再说）'), '思考文本不会发到 QQ');

  // drain：运行 A 结束后自动开新会话处理 9011
  await waitFor(() => llm.state.requests.length >= reqsBeforeA + 2, 6000, 'drain 运行开始');
  const drainReq = llm.state.requests.at(-1);
  assert.strictEqual(drainReq.messages.length, 2, 'drain 运行同样是全新会话（零历史）');
  assert.ok(drainReq.messages[1].content.includes('处理期间插进来的新消息'), 'drain 运行的【本次唤醒】是处理期间插入的消息');
  assert.ok(!drainReq.messages[1].content.includes('在的"') || drainReq.messages[1].content.includes('我：在的'), '此前发言只以存档形式出现');
  await waitSessionDone('处理期间插进来的新消息');
  pass('drain 循环：运行中新消息 → 结束后自动新开会话处理，每次 messages.length=2');

  const meta = app.store.getChatMeta('group:456');
  assert.strictEqual(meta.unread, 0, '所有消息已标记已读');
  assert.strictEqual(meta.total, 5, '存档 = 3 条收到的 + 2 条自己发的');
  pass('已读/未读驱动：处理完全部标记已读，自己的发言入档', `total=${meta.total}`);

  // ── 场景 3：白名单外完全忽略 ──
  const llmCallsBefore = llm.state.requests.length;
  onebotWs.push({
    post_type: 'message', message_type: 'group', group_id: 999, user_id: 111, self_id: 888,
    message_id: 9100, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 111, card: '外人', nickname: '外人' },
    message: [{ type: 'text', data: { text: '白名单外' } }]
  });
  await sleep(800);
  assert.strictEqual(llm.state.requests.length, llmCallsBefore, '白名单外不触发 LLM');
  assert.strictEqual(app.store.listChats().includes('group:999'), false, '白名单外不写入存档');
  pass('白名单：群 999 被完全忽略');

  // ── 场景 4：引用消息解析 + reply 段 ──
  llm.state.script.push(
    { toolCalls: [{ name: 'send_message', args: { messages: ['收到'], replyToMessageId: 9001 } }] },
    { content: 'ok' }
  );
  onebotWs.push({
    post_type: 'message', message_type: 'group', group_id: 456, user_id: 113, self_id: 888,
    message_id: 9003, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 113, card: '王五', nickname: '王五' },
    message: [
      { type: 'reply', data: { id: 9001 } },
      { type: 'text', data: { text: '张三说的对' } }
    ]
  });
  await waitSessionDone('张三说的对');
  await waitFor(() => onebotHttp.state.sends.length >= 3, 5000, '引用场景的发送');
  const send3 = onebotHttp.state.sends[2];
  assert.strictEqual(send3.body.message[0].type, 'reply', '第一条带 reply 段');
  assert.strictEqual(send3.body.message[0].data.id, '9001');
  assert.strictEqual(send3.body.message[1].data.text, '收到');
  const replyRunReq = llm.state.requests.at(-2);
  assert.ok(replyRunReq.messages[1].content.includes('[引用 被引用者：被引用的原话]'), '引用原文被解析进上下文');
  pass('引用解析与 reply 段发送正确');

  // ── 场景 5：记忆跨运行持久（无状态但记忆保留） ──
  llm.state.script.push(
    { toolCalls: [{ name: 'memory_append', args: { category: 'activeTopic', content: '今晚吃什么' } }, { name: 'send_message', args: { messages: ['记下了'] } }] },
    { content: 'ok' }
  );
  pushGroupMsg(111, '张三', '帮我记一下今晚吃什么', 9004);
  const session5 = await waitSessionDone('帮我记一下');
  assert.strictEqual(session5.status, 'done');
  assert.ok(app.memory.query('group:456', 'activeTopic').activeTopic.some((e) => e.content === '今晚吃什么'), '记忆已写入存储');

  llm.state.script.push({ content: '（看过了）' });
  const reqs5b = llm.state.requests.length;
  pushGroupMsg(112, '李四', '随便说说', 9005);
  await waitFor(() => llm.state.requests.length >= reqs5b + 1, 5000, '带记忆的后续运行开始');
  const memPrompt = llm.state.requests.at(-1).messages[1].content;
  assert.ok(memPrompt.includes('今晚吃什么'), '【记忆】跨运行出现在新会话的提示词里');
  await waitSessionDone('随便说说');
  pass('轻量记忆跨运行持久化');

  // ── 场景 6：表情包同步 + SSRF 拦截 + 发表情机制 ──
  const stickers = await app.stickers.sync(true);
  assert.ok(stickers.entries.length >= 1, '从 mock OneBot 同步到收藏表情');
  // 6a. 本地/内网地址的图片必须被拒绝（防护生效即"不发送"）
  llm.state.script.push(
    { toolCalls: [{ name: 'send_sticker', args: { stickerId: 'st1' } }] },
    { content: 'ok' }
  );
  pushGroupMsg(111, '张三', '来个表情', 9006);
  const stickerSession = await waitSessionDone('来个表情');
  assert.ok(
    stickerSession.messages.some((m) => m.toolCall?.isError && String(m.toolCall.result).includes('不合法')),
    '内网图片地址被 SSRF 防护拦截并回传模型'
  );
  pass('表情包安全：内网/本机图片地址被拒绝');
  // 6b. 发送机制本身：绕过工具直接走发送队列，验证 image 段
  const sendsBeforeSticker = onebotHttp.state.sends.length;
  await app.sender.sendSticker('group:456', { id: 'st1', desc: '直发测试', url: `http://127.0.0.1:${PORTS.onebotHttp}/img.png` }, {});
  await waitFor(() => onebotHttp.state.sends.length >= sendsBeforeSticker + 1, 5000, '表情发送');
  const stickerSend = onebotHttp.state.sends.at(-1);
  assert.strictEqual(stickerSend.body.message.at(-1).type, 'image', '表情以 image 段发送');
  assert.ok(stickerSend.body.message.at(-1).data.file.includes('/img.png'), '表情 URL 正确');
  pass('表情包发送：image 段 + 存档记录');

  // ── 场景 7：限频保护 ──
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ send: { maxPerMinute: 1, minGapMs: 5, maxGapMs: 10, byLengthMs: 0, maxPerHour: 1000, hardSplitAt: 4000 } })
  });
  await sleep(80);
  llm.state.script.push(
    { toolCalls: [{ name: 'send_message', args: { messages: ['一条', '两条', '三条'] } }] },
    { content: 'ok' }
  );
  pushGroupMsg(111, '张三', '刷屏测试', 9007);
  const limited = await waitSessionDone('刷屏测试');
  assert.ok(limited.messages.some((m) => m.toolCall?.isError && String(m.toolCall.result).includes('频率超限')), '超限的发送被拒绝并反馈给模型');
  pass('发送限频：超额部分被拒绝，错误回传模型');
  // 恢复限频配置
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ send: { maxPerMinute: 100 } })
  });

  // ── 场景 8：暂停开关 + 手动唤醒 ──
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/pause`, { method: 'POST', body: JSON.stringify({ paused: true }) });
  const callsBeforePause = llm.state.requests.length;
  pushGroupMsg(111, '张三', '暂停期间的消息', 9008);
  await sleep(900);
  assert.strictEqual(llm.state.requests.length, callsBeforePause, '暂停期间不触发运行');
  assert.ok(app.store.getChatMeta('group:456').unread >= 1, '暂停期间消息仍入档为未读');
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/pause`, { method: 'POST', body: JSON.stringify({ paused: false }) });
  llm.state.script.push({ content: '（恢复后检查一遍，不用回）' }); // 显式脚本，保证后续索引不漂移
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/chats/group_456/wake`, { method: 'POST', body: '{}' });
  await waitSessionDone('暂停期间的消息');
  pass('暂停/恢复 + 手动唤醒（暂停期间消息积压为未读）');

  // ── 场景 9：私聊 ──
  llm.state.script.push(
    { toolCalls: [{ name: 'send_message', args: { messages: '私聊回复' } }] },
    { content: 'ok' }
  );
  onebotWs.push({
    post_type: 'message', message_type: 'private', user_id: 777, self_id: 888,
    message_id: 9200, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 777, nickname: '好友' },
    message: [{ type: 'text', data: { text: '单独找你' } }]
  });
  try {
    await waitFor(() => onebotHttp.state.sends.some((s) => s.action === 'send_private_msg'), 6000, '私聊发送');
  } catch (error) {
    if (process.env.DEBUG_TESTS) {
      console.log('[debug] newest session:', JSON.stringify(app.sessions.listSummaries(3), null, 1));
      const latest = app.sessions.get(app.sessions.listSummaries()[0]?.id);
      console.log('[debug] latest detail error:', latest?.error, 'status:', latest?.status);
      console.log('[debug] store chats:', app.store.listChats());
    }
    throw error;
  }
  const privSend = onebotHttp.state.sends.find((s) => s.action === 'send_private_msg');
  assert.strictEqual(privSend.body.user_id, 777);
  assert.strictEqual(privSend.body.message.at(-1).data.text, '私聊回复');
  await waitSessionDone('单独找你');
  pass('私聊流程正常');

  // ── 场景 10：拍一拍触发 ──
  llm.state.script.push({ content: '（拍一下而已，不回）' });
  onebotWs.push({
    post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
    group_id: 456, user_id: 114, target_id: 888, self_id: 888,
    time: Math.floor(Date.now() / 1000)
  });
  await waitFor(() => {
    const latest = llm.state.requests.at(-1);
    return latest?.messages?.[1]?.content?.includes('拍一拍');
  }, 8000, '拍一拍触发运行');
  await waitSessionDone('拍一拍');
  pass('拍一拍事件触发处理');

  // ── 场景 10b：自己拍一拍的 OneBot 回显不触发（自回环防护）──
  const pokesBefore = onebotHttp.state.pokes.length;
  llm.state.script.push(
    { toolCalls: [{ name: 'send_poke', args: { targetUserId: 114 } }] },
    { content: '（戳一下而已，不说话）' }
  );
  pushGroupMsg(115, '阿五', '戳我一下试试', 9025);
  await waitSessionDone('戳我一下试试');
  await waitFor(() => onebotHttp.state.pokes.length > pokesBefore, 6000, '拍一拍发送');
  const selfPoke = app.store.recent('group:456', { limit: 10 }).find((m) => m.self && String(m.text).includes('拍一拍'));
  assert.ok(selfPoke, '自己的拍一拍已留档为 self 记录');
  assert.strictEqual(selfPoke.read, true, '自己的拍一拍为已读');
  const callsBeforePokeEcho = llm.state.requests.length;
  onebotWs.push({
    post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
    group_id: 456, user_id: 888, target_id: 114, self_id: 888,
    time: Math.floor(Date.now() / 1000)
  });
  await sleep(2500);
  assert.strictEqual(llm.state.requests.length, callsBeforePokeEcho, '自己拍的拍回显不触发新会话');
  assert.strictEqual(app.store.getChatMeta('group:456').unread, 0, '回显不产生未读');
  pass('拍一拍自回环防护：自拍回显不触发 + 自拍留档');

  // ── 场景 10c：消息 id 引导（报错带可用 id）+ send_poke 参数校验 + recent 带 messageId ──
  const pokesBeforeC = onebotHttp.state.pokes.length;
  llm.state.script.push(
    { toolCalls: [{ name: 'send_poke', args: { targetUserId: '张三' } }] },
    { toolCalls: [{ name: 'get_message_detail', args: { messageId: 999999 } }] },
    { toolCalls: [{ name: 'get_recent_messages', args: { limit: 10 } }] },
    { content: '（知道了）' }
  );
  pushGroupMsg(116, '阿六', '测试工具报错', 9026);
  const toolErrSession = await waitSessionDone('测试工具报错');
  const pokeErr = toolErrSession.messages.find((m) => m.toolCall?.name === 'send_poke');
  assert.ok(pokeErr?.toolCall?.isError && String(pokeErr.toolCall.result).includes('正整数'), 'send_poke 非法参数返回人话报错');
  assert.strictEqual(onebotHttp.state.pokes.length, pokesBeforeC, '非法 targetUserId 不透传 OneBot');
  const detailErr = toolErrSession.messages.find((m) => m.toolCall?.name === 'get_message_detail');
  assert.ok(detailErr?.toolCall?.isError && String(detailErr.toolCall.result).includes('不要自己编'), '找不到消息时报错带引导');
  assert.ok(/\d{4,}/.test(String(detailErr.toolCall.result)), '报错里列出真实可见的消息 id');
  const recentTool = toolErrSession.messages.find((m) => m.toolCall?.name === 'get_recent_messages');
  assert.ok(!recentTool?.toolCall?.isError && String(recentTool.toolCall.result).includes('messageId'), 'get_recent_messages 返回真实消息 id');
  pass('消息 id 引导：报错带可用 id + send_poke 校验 + recent 带 messageId');

  // ── 场景 12：联网搜索 ──
  llm.state.script.push(
    { toolCalls: [{ name: 'web_search', args: { query: '审计梗 是什么' } }] },
    { content: '（搜到了，不用回）' }
  );
  pushGroupMsg(111, '张三', '审计梗是什么意思', 9020);
  const searchSession = await waitSessionDone('审计梗是什么意思');
  assert.ok(searchSession.messages.some((m) => m.toolCall?.name === 'web_search' && !m.toolCall.isError), 'web_search 调用成功');
  const searchReq = llm.state.requests.at(-1);
  const searchToolMsg = searchReq.messages.find((m) => m.role === 'tool' && m.name === 'web_search');
  assert.ok(searchToolMsg && String(searchToolMsg.content).includes('审计梗的完整解释'), '搜索结果以文本进入模型上下文');
  pass('联网搜索：web_search 结果回传模型');

  // ── 场景 13：web_fetch SSRF 防护 ──
  llm.state.script.push(
    { toolCalls: [{ name: 'web_fetch', args: { url: `http://127.0.0.1:${PORTS.onebotHttp}/img.png` } }] },
    { content: '（知道了）' }
  );
  pushGroupMsg(112, '李四', '帮我抓内网页面', 9021);
  const fetchSession = await waitSessionDone('帮我抓内网页面');
  assert.ok(fetchSession.messages.some((m) => m.toolCall?.isError && String(m.toolCall.result).includes('内网')), 'web_fetch 拒绝内网地址');
  pass('web_fetch SSRF 防护：内网地址被拒绝');

  // ── 场景 14：图片输入链路（vision） ──
  // 14a. 图片作为图像输入到达模型：tool 消息带文本，图片以 user 消息(image_url)补发
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ security: { allowPrivateImageHosts: true } }) // 测试例外：允许下载 mock 服务器上的本地图
  });
  llm.state.script.push(
    { toolCalls: [{ name: 'get_message_images', args: { messageId: 9022 } }] },
    { content: '（图看到了）' }
  );
  onebotWs.push({
    post_type: 'message', message_type: 'group', group_id: 456, user_id: 115, self_id: 888,
    message_id: 9022, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 115, card: '赵六', nickname: '赵六' },
    message: [
      { type: 'text', data: { text: '看这个图' } },
      { type: 'image', data: { file: 'a.png', url: `http://127.0.0.1:${PORTS.onebotHttp}/img.png` } }
    ]
  });
  const visionSession = await waitSessionDone('看这个图');
  assert.ok(visionSession.messages.some((m) => m.toolImages?.count === 1), '会话记录了图片注入');
  const visReq = llm.state.requests.at(-1);
  const visToolMsg = visReq.messages.find((m) => m.role === 'tool' && m.name === 'get_message_images');
  assert.ok(visToolMsg && typeof visToolMsg.content === 'string' && !visToolMsg.content.includes('base64'), 'tool 消息只带文本，不塞 base64');
  const imgUserIdx = visReq.messages.findIndex((m) => m.role === 'user' && Array.isArray(m.content));
  assert.ok(imgUserIdx > -1, '图片以 user 消息注入');
  const imgPart = visReq.messages[imgUserIdx].content.find((p) => p.type === 'image_url');
  assert.ok(imgPart && String(imgPart.image_url.url).startsWith('data:image/png;base64,'), '图片为 PNG data URL');
  const visToolIdx = visReq.messages.findIndex((m) => m.role === 'tool' && m.name === 'get_message_images');
  assert.ok(visToolIdx > -1 && visToolIdx < imgUserIdx, '消息顺序合法：tool 结果在前，图片 user 消息在后');
  pass('图片输入：tool 文本 + user 消息 image_url 补发，结构兼容 OpenAI 校验');

  // 14b. vision=false 时看图工具被移除、搜索工具保留
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api: { vision: false } })
  });
  llm.state.script.push({ content: '（看不了图，不回）' });
  pushGroupMsg(111, '张三', '再来一张图', 9023);
  await waitSessionDone('再来一张图');
  const visOffReq = llm.state.requests.at(-1);
  assert.ok(!visOffReq.tools.some((t) => t.function.name === 'get_message_images'), 'vision=false 时看图工具被移除');
  assert.ok(visOffReq.tools.some((t) => t.function.name === 'web_search'), '搜索工具不受影响');
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api: { vision: true }, security: { allowPrivateImageHosts: false } })
  });
  pass('vision 开关：关闭后移除看图工具，提示词同步变化');

  // ── 场景 15：群/好友列表 + 手动测试消息 ──
  const groupsRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/onebot/groups`)).json();
  assert.ok(groupsRes.groups.some((g) => g.id === '456' && g.name === '审计群456'), '群列表可供白名单勾选');
  const friendsRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/onebot/friends`)).json();
  assert.ok(friendsRes.friends.some((f) => f.id === '777'), '好友列表可供白名单勾选');
  const testSendRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/chats/group_456/test-send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '手动测试消息' })
  })).json();
  assert.ok(testSendRes.ok, '测试消息发送成功');
  assert.ok(onebotHttp.state.sends.some((s) => s.body.message.at(-1).data.text === '手动测试消息'), '测试消息到达 OneBot');
  assert.ok(app.store.recent('group:456', { limit: 5 }).some((m) => m.self && m.text === '手动测试消息'), '测试消息入档为自己的发言');
  const tplRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/persona-templates`)).json();
  assert.ok(tplRes.templates.some((t) => t.id === 'xiaojingyu' && t.text.includes('DeepSeek 小鲸鱼')), '原版小鲸鱼人设模板在内');
  pass('引导助手：群/好友列表 + 手动测试消息 + 人设模板');

  // ── 场景 16：预算保险丝 ──
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ budget: { dailyCostYuan: 0.000001 } }) // 必然已超（前面已跑了十几次）
  });
  const reqsBeforeBudget = llm.state.requests.length;
  pushGroupMsg(111, '张三', '预算测试', 9030);
  await sleep(900);
  assert.strictEqual(llm.state.requests.length, reqsBeforeBudget, '预算超限后不再发起 LLM 调用');
  const budgetStatus = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/status`)).json();
  assert.ok(budgetStatus.paused && budgetStatus.pauseReason === 'budget', '自动暂停且原因标记为 budget');
  // 解除预算并恢复，确认还能继续处理
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ budget: { dailyCostYuan: 0 } })
  });
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/pause`, { method: 'POST', body: JSON.stringify({ paused: false }) });
  llm.state.script.push({ content: '（预算恢复检查）' });
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/chats/group_456/wake`, { method: 'POST', body: '{}' });
  await waitSessionDone('预算测试');
  pass('预算保险丝：超限自动暂停 → 解除后恢复运行');

  // ── 场景 17：手动模型目录（添加提供商 + 模型管理 + 切换） ──
  // 通过新 API 手动添加两个提供商（等价于设置页“确认添加”），再验证模型追加/删除/切换。
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: 'https://api.a6api.com/v1',
      apiKey: 'cred-a6api-key',
      models: [
        { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
        { id: 'DeepSeek-V4-Flash-0731', name: 'DS Flash' }
      ]
    })
  });
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: 'http://127.0.0.1:8787/v1',
      apiKey: 'local-key-1',
      models: [{ id: 'hy4-preview', name: '混元 Preview' }]
    })
  });
  const provRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`)).json();
  assert.strictEqual(provRes.providers.length, 2, `应存在 2 个手动添加的提供商（实际 ${provRes.providers.length}）`);
  const a6 = provRes.providers.find((p) => p.baseURL === 'https://api.a6api.com/v1');
  assert.ok(a6 && a6.hasKey && a6.apiKey === 'cred-a6api-key', '手动添加的提供商保存了密钥');
  assert.ok(a6.models.includes('glm-5.3-flash'), '模型列表完整');
  const local = provRes.providers.find((p) => p.baseURL === 'http://127.0.0.1:8787/v1');
  assert.ok(local && local.models.includes('hy4-preview'), '本地网关模型已添加');
  // 追加模型
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers/models`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: local.id, models: [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }] })
  });
  const provRes2 = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`)).json();
  const local2 = provRes2.providers.find((p) => p.id === local.id);
  assert.ok(local2.models.includes('glm-5.3-flash'), '追加模型成功');
  // 切换到目录里的模型（等价于 UI 选中后的字段填充）
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api: { provider: local.id, baseUrl: 'http://127.0.0.1:8787/v1', apiKey: 'local-key-1', model: 'hy4-preview' } })
  });
  const cfgAfter = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`)).json();
  assert.strictEqual(cfgAfter.api.provider, local.id);
  assert.strictEqual(cfgAfter.api.model, 'hy4-preview');
  // 删除模型
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers/models`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: local.id, modelId: 'glm-5.3-flash' })
  });
  const provRes3 = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`)).json();
  const local3 = provRes3.providers.find((p) => p.id === local.id);
  assert.ok(!local3.models.includes('glm-5.3-flash'), '删除模型成功');
  // 切回测试模型，保证后续场景正常
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api: { provider: '', baseUrl: `http://127.0.0.1:${PORTS.llm}/v1`, apiKey: 'test-key', model: 'test-model-a' } })
  });
  pass('手动模型目录：添加提供商 + 追加/删除模型 + 切换');

  // ── 场景 11：HTTP API 完整性 ──
  const statusRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/status`)).json();
  assert.ok(statusRes.onebot.connected === true);
  assert.ok(statusRes.usage.totalTokens > 0, '今日 token 统计 > 0');
  assert.ok(statusRes.usage.cost > 0, '成本折算 > 0');
  const modelsRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/models`)).json();
  assert.strictEqual(modelsRes.models.length, 2, '模型列表 API');
  const sessRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/sessions`)).json();
  assert.ok(sessRes.sessions.length >= 8, `会话列表有记录（${sessRes.sessions.length}）`);
  const oneSession = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/sessions/${sessRes.sessions[0].id}`)).json();
  assert.ok(oneSession.messages && oneSession.systemPrompt);
  const chatsRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/chats`)).json();
  assert.ok(chatsRes.chats.some((c) => c.key === 'group:456'));
  const uiRes = await fetch(`http://127.0.0.1:${cfg.server.port}/`);
  assert.ok((await uiRes.text()).includes('QQ Agent'), 'UI 首页可访问');
  pass('HTTP API：status/models/sessions/chats/UI 全部可用', `今日 cost=¥${statusRes.usage.cost}`);

  // ── 场景 26：记忆自动整理（超阈值触发 + LLM 合并写回 + 备份 + 冷却）──
  let i = 0;
  while (app.memory.consolidationState('group:456').counts.activeTopic <= 8) {
    app.memory.append('group:456', 'activeTopic', `进行中话题${++i}——测试整理用的独特内容`);
  }
  assert.ok(app.memory.consolidationState('group:456').counts.activeTopic > 8, '记忆已灌到超阈值');
  llm.state.script.push(
    { content: '（继续聊天，不说话）' },   // 触发运行本身
    { content: JSON.stringify({           // 运行结束后整理调用的返回
        activeTopic: ['合并后的唯一话题（来自整理测试）'],
        pendingThought: [],
        memberImpression: [{ target: '114', content: '合并后的综合印象' }]
      }) }
  );
  pushGroupMsg(117, '阿七', '触发记忆整理', 9027);
  await waitSessionDone('触发记忆整理');
  await waitFor(() => app.memory.consolidationState('group:456').lastConsolidatedAt > 0, 10000, '记忆整理完成');
  const memAfter = app.memory.query('group:456');
  assert.strictEqual(memAfter.activeTopic.length, 1, '整理后话题条数收敛');
  assert.ok(String(memAfter.activeTopic[0].content).includes('合并后的唯一话题'), '整理结果写回存储');
  const backupDir = path.join(dataDir, 'memory', 'backups');
  assert.ok(fs.existsSync(path.join(backupDir, 'group_456.json.1')), '整理前原记忆已备份');
  const consCount = () => llm.state.requests.filter((r) => String(r.messages?.[0]?.content || '').includes('记忆整理模块')).length;
  const consBefore = consCount();
  llm.state.script.push({ content: '（冷却期随便聊聊）' });
  pushGroupMsg(118, '阿八', '冷却验证', 9028);
  await waitSessionDone('冷却验证');
  await sleep(1500);
  assert.strictEqual(consCount(), consBefore, '冷却期内不重复整理');
  pass('记忆自动整理：超阈值触发 + LLM 合并写回 + 备份 + 冷却');

  // ── 场景 27：模型图片输入探测 + 按模型门控看图工具 ──
  // 先通过手动添加提供商 API 创建视觉探测专用提供商（baseUrl 指向 mock LLM）
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: `http://127.0.0.1:${PORTS.llm}/v1`,
      apiKey: 'cred-visiontest-key',
      models: [
        { id: 'vision-ok-model', name: '视觉正常' },
        { id: 'vision-no-model', name: '视觉拒绝' }
      ]
    })
  });
  const visionProv = (await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`)).json())
    .providers.find((p) => p.baseURL === `http://127.0.0.1:${PORTS.llm}/v1`);
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/vision/scan`, {
    method: 'POST', body: JSON.stringify({ providerIds: [visionProv.id] })
  });
  let visionRes = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    visionRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/vision/results`)).json();
    if (!visionRes.scanning
      && visionRes.results[`${visionProv.id}|||vision-ok-model`]
      && visionRes.results[`${visionProv.id}|||vision-no-model`]) break;
  }
  assert.strictEqual(visionRes.results[`${visionProv.id}|||vision-ok-model`].verdict, 'vision', '接受图片的模型判定为 vision');
  assert.strictEqual(visionRes.results[`${visionProv.id}|||vision-no-model`].verdict, 'no-vision', '拒绝图片的模型判定为 no-vision');
  assert.ok(visionRes.results[`${visionProv.id}|||vision-no-model`].note.includes('image'), 'no-vision 结论带原始报错说明');

  // 切到无视觉模型：请求里不应再有看图工具
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST',
    body: JSON.stringify({ api: { provider: visionProv.id, model: 'vision-no-model', baseUrl: `http://127.0.0.1:${PORTS.llm}/v1`, apiKey: 'cred-visiontest-key' } })
  });
  llm.state.script.push({ content: '（安静）' });
  pushGroupMsg(119, '阿九', '看看无视觉模型', 9029);
  await waitSessionDone('看看无视觉模型');
  const noVisionReq = llm.state.requests.at(-1);
  assert.ok(!noVisionReq.tools?.some((t) => t.function?.name === 'get_message_images'), 'no-vision 模型不带看图工具');

  // 切到视觉模型：看图工具恢复
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST',
    body: JSON.stringify({ api: { provider: visionProv.id, model: 'vision-ok-model' } })
  });
  llm.state.script.push({ content: '（安静2）' });
  pushGroupMsg(120, '阿十', '看看有视觉模型', 9030);
  await waitSessionDone('看看有视觉模型');
  const visionReq = llm.state.requests.at(-1);
  assert.ok(visionReq.tools?.some((t) => t.function?.name === 'get_message_images'), 'vision 模型带看图工具');
  pass('模型图片输入探测 + 按模型门控看图工具');

  // ── 收尾 ──
  await app.stop();
  onebotWs.close();
  onebotHttp.server.close();
  llm.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log(`\n全部 ${results.length} 项审计通过 ✅`);
  process.exit(0);
}

main().catch((error) => {
  console.error('\n❌ 审计失败：', error);
  process.exit(1);
});
