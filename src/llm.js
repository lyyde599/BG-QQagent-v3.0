// OpenAI 兼容 Chat Completions 客户端（非流式；QQ 本身不支持流式，没必要）。
// 支持工具调用、usage 统计、可自选模型 —— 这是与 DSH 解耦后的"大脑"接口。
import { getConfig } from './config.js';

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/**
 * 单次对话请求。messages 为 OpenAI 格式；tools 为 OpenAI function 格式（可为空）。
 * 返回 { message, usage, raw }；usage 形如 { prompt_tokens, completion_tokens, total_tokens }。
 */
export async function chatCompletion({ messages, tools = null, toolChoice = 'auto', temperature = null, signal = null }) {
  const cfg = getConfig().api;
  const body = {
    model: cfg.model,
    messages,
    stream: false
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }
  const temp = temperature === null ? (cfg.temperature ?? 0.8) : temperature;
  if (temp !== null && temp !== undefined && Number.isFinite(Number(temp))) body.temperature = Number(temp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), Math.max(5000, Number(cfg.timeoutMs) || 180000));
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason ?? new Error('aborted'));
    else signal.addEventListener('abort', () => controller.abort(signal.reason ?? new Error('aborted')), { once: true });
  }

  let res;
  try {
    res = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(cfg.apiKey) },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'AbortError') throw new Error(`模型请求超时（${cfg.timeoutMs}ms）`);
    throw new Error(`模型请求失败：${error?.cause?.message ?? error?.message ?? error}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`模型 API HTTP ${res.status}：${text.slice(0, 500)}`);
  }
  const data = await res.json().catch(() => { throw new Error('模型 API 返回了无法解析的 JSON'); });
  const choice = data?.choices?.[0];
  if (!choice) throw new Error(`模型 API 响应缺少 choices：${JSON.stringify(data).slice(0, 300)}`);
  return {
    message: choice.message ?? {},
    finishReason: choice.finish_reason ?? null,
    usage: data.usage ?? null,
    model: data.model ?? cfg.model,
    raw: data
  };
}

/** 获取模型列表（GET /models）。返回 [{ id }]；失败抛错。 */
export async function listModels() {
  const cfg = getConfig().api;
  const res = await fetch(joinUrl(cfg.baseUrl, '/models'), {
    headers: authHeaders(cfg.apiKey),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list.map((m) => ({ id: String(m.id ?? m.model ?? m) })).filter((m) => m.id);
}

/** 累加 usage。 */
/**
 * 累加 token 用量。
 *
 * 🔴 2026-10-26 修：原来只累加 prompt/completion/total，
 *    **把缓存字段整个丢了** —— 于是运营面板只能估算缓存命中，
 *    拿不到真实数字。
 *
 * 各家的字段名不统一，这里都认：
 *   · OpenAI / DeepSeek 新版：prompt_tokens_details.cached_tokens
 *   · DeepSeek 旧版：          prompt_cache_hit_tokens / prompt_cache_miss_tokens
 *   · Anthropic 风格：         cache_read_input_tokens / cache_creation_input_tokens
 *
 * 语义约定：
 *   cachedTokens   = 命中缓存的 prompt token 数
 *   cacheMissTokens = 未命中的 prompt token 数（拿不到时用 prompt - cached 推算）
 */
export function addUsage(target, usage) {
  if (!usage) return target;

  const num = (v) => Number(v) || 0;
  const prompt = num(usage.prompt_tokens);
  const completion = num(usage.completion_tokens);

  target.promptTokens += prompt;
  target.completionTokens += completion;
  target.totalTokens += num(usage.total_tokens) || (prompt + completion);

  // ── 缓存命中（多方言兼容）──
  const det = usage.prompt_tokens_details || usage.prompt_tokens_details_v2 || {};
  const cached = num(
    usage.prompt_cache_hit_tokens
    ?? det.cached_tokens
    ?? usage.cache_read_input_tokens
    ?? 0
  );
  const miss = num(
    usage.prompt_cache_miss_tokens
    ?? det.uncached_tokens
    ?? (cached > 0 ? Math.max(0, prompt - cached) : 0)
  );

  if (cached) target.cachedTokens = (target.cachedTokens || 0) + cached;
  if (miss) target.cacheMissTokens = (target.cacheMissTokens || 0) + miss;

  // 记录最近一次的真实命中情况，方便面板显示「上一次请求命中了没」
  if (cached || miss) {
    target.lastCache = { cached, miss, at: Date.now() };
  }

  return target;
}

export function emptyUsage() {
  return {
    promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0,
    // 缓存统计（2026-10-26 加）：字段缺省为 0，老的 session 文件照样能读
    cachedTokens: 0, cacheMissTokens: 0, lastCache: null
  };
}

/** 按配置单价折算成本（元）。 */
export function estimateCost(usage) {
  const cfg = getConfig().api;
  const cost = (usage.promptTokens / 1e6) * (Number(cfg.priceInputPerM) || 0)
    + (usage.completionTokens / 1e6) * (Number(cfg.priceOutputPerM) || 0);
  return Math.round(cost * 1e4) / 1e4;
}
