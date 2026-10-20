// 联网搜索（移植自原版 bingSearch）：Bing 中文搜索，无需 API key。
// 搜索请求本身用普通 fetch（搜索 URL 是管理端配置的可信地址，只需清洗查询词）；
// 对外抓取网页正文一律走 safe-fetch（web_fetch 工具）。
import { getConfig } from './config.js';
import { safeFetch } from './safe-fetch.js';

/** 查询词清洗：去 CQ 码、控制字符、超长截断。 */
export function sanitizeQuery(query) {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bing 搜索（解析 b_algo 结果块）。searchUrl 可在配置中替换（测试/换引擎）。 */
export async function bingSearch(query) {
  const cfg = getConfig().webSearch ?? {};
  const searchUrl = String(cfg.searchUrl || 'https://cn.bing.com/search');
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const url = new URL(searchUrl);
  url.searchParams.set('q', query);
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= maxResults) break;
  }
  return { query, results };
}

/** 给工具用的统一入口：搜索 + 紧凑序列化。 */
export async function webSearch(query) {
  const clean = sanitizeQuery(query);
  if (!clean) throw new Error('查询词为空');
  return bingSearch(clean);
}

/** 抓取网页正文（走 safe-fetch 的 SSRF 全防护）。 */
export async function webFetch(url) {
  const result = await safeFetch(url);
  return result;
}

// ── AnySearch 后端（2026-09-04 接入，双 key 轮换）────────────────────────
// 主 key 和备用 key 从环境变量读取（ANYSEARCH_API_KEY / ANYSEARCH_API_KEY_2），
// 由 systemd 或启动脚本注入；两者都没有时回退 Bing。
const ANYSEARCH_BASE = 'https://api.anysearch.com';

/**
 * 读取 AnySearch 的 key（双 key 轮换）。
 * 优先级：环境变量 > 配置文件（config.webSearch.anysearchKeys）。
 * 环境变量方式更适合生产（钥匙不落进 config.json）；
 * 配置方式方便在控制台直接填，两者都支持。
 */
// 判断一个 key 是否真的可用：非空、且不是脱敏占位符。
// ⚠️ 2026-09-17 事故：发布包把 key 脱敏成 __REPLACE_ME__ 写进 .env.anysearch，
//    而本函数原逻辑是「env 有值就不再读 config」—— 占位符让 keys.length 变成 2，
//    于是 config.json 里的**真 key 永远读不到**，搜索恒 401 失败。
//    现在改为：占位符一律视为无效，自然回退到 config 里的真 key。
function isUsableKey(k) {
  const v = String(k || '').trim();
  if (!v) return false;
  if (/^__.*__$/.test(v)) return false;          // __REPLACE_ME__ 之类
  if (/^(your|xxx|todo|changeme|placeholder)/i.test(v)) return false;
  return true;
}

function anysearchKeys() {
  const keys = [];
  const env1 = process.env.ANYSEARCH_API_KEY || '';
  const env2 = process.env.ANYSEARCH_API_KEY_2 || '';
  // 只收「真正可用」的 env key；占位符不算，从而能回退到 config
  for (const k of [env1, env2]) {
    if (isUsableKey(k) && !keys.includes(k.trim())) keys.push(k.trim());
  }
  {  // 始终也读 config 作为补充（env 与 config 都可用时，env 优先、config 兜底）
    try {
      const cfg = getConfig().webSearch || {};
      const arr = Array.isArray(cfg.anysearchKeys) ? cfg.anysearchKeys : [];
      for (const k of arr) {
        const v = String(k || '').trim();
        if (isUsableKey(v) && !keys.includes(v)) keys.push(v);
      }
    } catch { /* config 不可用时忽略 */ }
  }
  return keys;
}

/** key 来源说明（供控制台展示，绝不返回 key 本身）。 */
export function anysearchKeyStatus() {
  const envCount = [process.env.ANYSEARCH_API_KEY, process.env.ANYSEARCH_API_KEY_2].filter(Boolean).length;
  let cfgCount = 0;
  try {
    const arr = getConfig().webSearch?.anysearchKeys;
    cfgCount = Array.isArray(arr) ? arr.filter((x) => String(x || '').trim()).length : 0;
  } catch { /* ignore */ }
  return {
    envCount,
    cfgCount,
    total: envCount + cfgCount,
    source: envCount ? (cfgCount ? 'env+config' : 'env') : (cfgCount ? 'config' : 'none')
  };
}

/** AnySearch 搜索：返回 null 表示不可用/失败（由调用方决定是否回退 Bing）。 */
export async function anysearchSearch(query, { maxResults = 8, tag = '', zone = '' } = {}) {
  const keys = anysearchKeys();
  if (!keys.length) return null;
  let lastErr = null;
  for (const key of keys) {
    try {
      const body = {
        query: sanitizeQuery(query),
        ...(maxResults ? { max_results: Math.min(20, Math.max(1, maxResults)) } : {}),
        ...(tag ? { tag } : {}),
        ...(zone ? { zone } : {})
      };
      const res = await fetch(ANYSEARCH_BASE + '/v1/search', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {})
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000)
      });
      if (res.status === 429) { lastErr = new Error('429 rate limited'); continue; }  // 429 → 换备用 key
      if (!res.ok) { lastErr = new Error(`AnySearch HTTP ${res.status}`); continue; }
      const json = await res.json();
      // AnySearch 实际结构：{ code, message, data: { results: [...] } }
      const payload = json?.data && Array.isArray(json.data.results) ? json.data : json;
      const results = (payload?.results || []).map((r) => ({
        title: String(r.title || '').trim(),
        url: String(r.url || '').trim(),
        snippet: String(r.snippet || r.content || '').trim().slice(0, 300)
      })).filter((r) => r.url && r.title).slice(0, maxResults);
      return { query, results, engine: 'anysearch' };
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}
