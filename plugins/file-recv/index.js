// ── 插件：文件接收（补 receive_file 的本地路径短板）────────────────────────
//
// 需求（2026-10-22）：群里发来文件，机器人说"取不下来，只拿到名字"。
//
// ── 根因 ──
//   内核 tools.js 的 receive_file 只接受 NapCat `get_file` 返回的 **http(s) 地址**：
//       const urls = [info?.url, info?.file, ...].filter(u => /^https?:\/\//.test(u));
//   但 NapCat 对**群文件/本地文件**返回的是**本地绝对路径**，例如：
//       {"file": "/home/qqtest/.config/QQ/NapCat/temp/声音与歌唱v1.7.gz", "file_size": "80655"}
//   于是 urls 为空 → 报「NapCat 没有返回可下载地址」，文件永远取不下来。
//
// ── 本插件怎么补 ──
//   不改内核（遵守项目纪律），用插件注册一个同名覆盖不了的**新工具** `fetch_file`，
//   走另一条路：**用 root 权限直接读 NapCat 的本地文件**（机器人进程与 NapCat 同机）。
//   同时提供 copy_to_workspace，把文件搬到 agent 能读的工作区。
//
// ── 权限与安全 ──
//   只读 NapCat 的 temp/recv 目录 + 工作区，白名单校验，拒绝任意路径穿越。
import fs from 'node:fs';
import path from 'node:path';
import { ok, err, midHint } from '../../src/core/tool-kit.js';
import { ROOT } from '../../src/config.js';

/**
 * 允许读取的根目录（避免变成任意文件读取）
 *
 * 🔴 必须动态推导，不能写死（2026-10-28 修）
 *
 * 事故：机器人外包给 dshc 写出了报告，想用 send_local_file 发出来，
 * 一直报「路径不在白名单」。查下来白名单里全是**旧路径**：
 *   /root/qq-agent-v2/...        ← 早期部署位置
 *   /home/lyy/QQbot/qq-agent-v2/... ← 改名前的目录
 * 项目改名成 BG-QQagent-Linux 后，这些一个都不存在于白名单，
 * 于是项目内的文件、工作目录、插件素材**全都发不出去**。
 *
 * 现在改成跟着项目根走：换机器、改目录名、改工作目录都不用再动代码。
 */
const STATIC_ROOTS = [
  // 🔴 2026-10-31 补：本机真实路径（原来只有 qqtest 那台机器的，本机全不匹配）
  '/home/lyy/.config/QQ/NapCat/temp',
  '/home/lyy/.config/QQ/NapCat/recv',
  '/home/qqtest/.config/QQ/NapCat/temp',
  '/home/qqtest/.config/QQ/NapCat/recv',
  '/home/lyy/napcat',
  '/home/dshc',
  '/tmp',
];

/** 动态根目录：项目内所有"机器人可能产出的地方" */
function dynamicRoots() {
  const out = [];
  try {
    // ROOT 由 config 导出，指向当前项目根（不是写死的名字）
    const root = process.env.QQ_AGENT_ROOT || ROOT;
    if (root) {
      out.push(root);                              // 整个项目根（含 dsh-work / workspace / 插件素材）
      out.push(path.join(root, 'dsh-work'));
      out.push(path.join(root, 'workspace'));
    }
  } catch { /* ROOT 拿不到就只靠静态项 */ }

  // 工作目录（《鱼鱼的工作目录》——DSH 产物落这里）
  out.push(process.env.QQ_AGENT_YUYU_DIR || '/home/lyy/鱼鱼的工作目录');

  // 历史路径：老部署留着的文件仍然允许发（向后兼容）
  out.push('/root/qq-agent-v2', '/home/lyy/QQbot/qq-agent-v2');

  return out;
}

/**
 * 探测 NapCat 的收件目录（2026-10-28）
 *
 * 事故：list_napcat_files 报「/home/qqtest/... → 不存在」。
 * 那是历史部署的路径，本机 NapCat 跑在 /home/lyy/.config/QQ/NapCat/ 下。
 * 写死路径必然在换机器/换用户后失效，所以按候选列表探测。
 */
function napcatDirs() {
  const home = process.env.HOME || '/home/lyy';
  const candidates = [
    path.join(home, '.config/QQ/NapCat/temp'),
    path.join(home, '.config/QQ/NapCat/recv'),
    '/home/lyy/.config/QQ/NapCat/temp',
    '/home/lyy/.config/QQ/NapCat/recv',
    '/home/qqtest/.config/QQ/NapCat/temp',
    '/home/qqtest/.config/QQ/NapCat/recv',
  ];
  const exists = candidates.filter((d) => {
    try { return fs.existsSync(d); } catch { return false; }
  });
  // 一个都没有时返回候选的前两个，好让报错信息说清"试过哪些"
  return exists.length ? exists : candidates.slice(0, 2);
}

/** 允许读取的根目录（静态 + 动态） */
/**
 * 用户自定义的可读目录（2026-10-31 加）
 *
 * 原来白名单全是硬编码：本机路径一改就全废（曾只认 qqtest 那台机器的）。
 * 现在允许用户在插件设置里自己授权目录，用换行或逗号分隔。
 *
 * 安全约束：只接受**绝对路径**，且不能是 `/` 这种根目录 ——
 * 否则等于把整个文件系统交出去。
 */
let extraRootsCache = { raw: null, list: [] };
function userExtraRoots() {
  let raw;
  try { raw = configGetter?.()?.extraRoots; } catch { raw = ''; }
  // 兼容两种存法（2026-10-31）：
  //   · 界面用 list 控件 → 存成数组
  //   · 手改 config.json 可能写成字符串（换行/逗号分隔）
  // 统一归一化成路径数组。
  const arr = Array.isArray(raw)
    ? raw.map((s) => String(s ?? ''))
    : String(raw ?? '').split(/[\n,，;；]+/);
  const key = JSON.stringify(arr);
  if (extraRootsCache.raw === key) return extraRootsCache.list;
  const list = arr
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => path.isAbsolute(s))           // 只认绝对路径
    .filter((s) => path.resolve(s) !== path.sep) // 拒绝根目录本身
    .map((s) => path.resolve(s));
  extraRootsCache = { raw: key, list };
  return list;
}

/** 配置读取器（activate 时注入，避免模块级依赖 ctx） */
let configGetter = null;

function allowedRoots() {
  // 静态 + 动态（项目内产出）+ NapCat 实际探测 + **用户授权**
  //
  // 前两项是内置的安全范围；第三项让"换机器不用改代码"；
  // 第四项交给用户自己决定 —— 想让她读某个目录，加进来即可。
  let nacat = [];
  try { nacat = napcatDirs(); } catch { /* 探测失败不影响其他根 */ }
  return [...new Set([...STATIC_ROOTS, ...dynamicRoots(), ...nacat, ...userExtraRoots()])];
}

/** 判断路径是否在允许范围内 */
function isAllowed(p) {
  const real = path.resolve(p);
  // 「允许任意路径」是最危险的一档，必须显式开启（界面上有红字警告）
  try {
    if (configGetter?.()?.allowAll === true) return true;
  } catch { /* 读不到配置就按严格模式走 */ }
  return allowedRoots().some((root) => real === root || real.startsWith(root + path.sep));
}

/** 人类可读体积 */
function human(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const u = ['B', 'KB', 'MB', 'GB'];
  let n = bytes; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 ? 1 : 0)}${u[i]}`;
}

export async function activate(ctx) {
  const pluginDir = ctx.dir;
  // 让白名单函数能读到插件配置（模块级函数拿不到 ctx）
  configGetter = () => ctx.config.get();
  // 工作区目录（agent 可读的地方）
  const workspace = () => {
    const c = ctx.config.get();
    return String(c.workspaceDir || '') || path.join(ctx.dataDir, 'inbox');
  };

  /**
   * 从消息里挑出文件媒体项。
   * 兼容内核 store 的 media 结构：{kind:'file', fileId, file, name, size}
   */
  const filesOf = (entry) => {
    const media = Array.isArray(entry?.media) ? entry.media : [];
    return media.filter((m) => m && m.kind === 'file');
  };

  // 工具 1：按消息取文件信息（先侦察，再决定怎么拿）
  ctx.tools.register({
    name: 'fetch_file',
    description: '把群友/主人发来的文件取到本地（补 receive_file 的短板：NapCat 返回本地路径时它取不到）。'
      + '用法：messageId 传聊天记录里 #数字；不传则看最近消息里的文件。'
      + '返回 saved 本地路径后，可直接读取内容或转交 DSH 处理。',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字）' },
        fileIndex: { type: 'number', description: '同一消息多个文件时第几个，默认 0' }
      },
      required: []
    },
    async execute(toolCtx, args) {
      try {
        // ① 找消息
        let entry = null;
        if (args.messageId !== undefined && args.messageId !== null && String(args.messageId) !== '') {
          entry = toolCtx.store.findByMid(toolCtx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(toolCtx)}`);
        } else {
          // 没给 id：从最近消息里找最后一条带文件的
          const recent = toolCtx.store.recent(toolCtx.chatKey, { limit: 40 }) || [];
          for (let i = recent.length - 1; i >= 0; i--) {
            if (filesOf(recent[i]).length) { entry = recent[i]; break; }
          }
          if (!entry) return err('最近的聊天记录里没有带文件的消息');
        }

        const files = filesOf(entry);
        if (!files.length) return err('这条消息里没有文件（可能只有图片或文字）');
        const idx = Math.max(0, Math.min(Number(args.fileIndex) || 0, files.length - 1));
        const f = files[idx];

        // ② 候选路径：media 里可能有 file / path / url
        const cands = [f.localPath, f.file, f.path, f.url].filter((x) => typeof x === 'string' && x);

        // 没有本地路径时，问 NapCat（可能这次给了 http）
        if (!cands.length && f.fileId) {
          try {
            const info = await toolCtx.onebot.call('get_file', { file_id: f.fileId }, 30000);
            const flat = JSON.stringify(info || {});
            const m = /"(?:file|path|local_path)"\s*:\s*"([^"]+)"/.exec(flat);
            if (m) cands.push(m[1]);
            const http = /"(?:url)"\s*:\s*"(https?:[^"]+)"/.exec(flat);
            if (http) cands.push(http[1]);
            ctx.log('[fetch_file] get_file 返回:', flat.slice(0, 200));
          } catch (e) {
            ctx.log('[fetch_file] get_file 失败:', e?.message);
          }
        }
        if (!cands.length) return err('拿不到这个文件的路径（既无本地路径也无下载地址）');

        // ③ 逐个尝试：本地路径优先（同机直读，最快最稳）
        const inbox = workspace();
        fs.mkdirSync(inbox, { recursive: true });
        const safeName = String(f.name || path.basename(cands[0]) || 'file').replace(/[/:*?"<>|]/g, '_');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const dest = path.join(inbox, `${stamp}_${safeName}`);

        let lastErr = '';
        for (const c of cands) {
          // 本地路径：直接复制
          if (!/^https?:\/\//.test(c)) {
            if (!isAllowed(c)) { lastErr = `路径不在白名单：${c}`; continue; }
            try {
              if (!fs.existsSync(c)) { lastErr = `文件不存在：${c}`; continue; }
              fs.copyFileSync(c, dest);
              const st = fs.statSync(dest);
              return ok({
                saved: dest, name: safeName, size: st.size, sizeText: human(st.size),
                source: 'local',
                note: '文件已复制到工作区。可直接读取内容，或转交 DSH 处理（把 saved 路径写进任务）。'
              });
            } catch (e) { lastErr = `复制失败：${e?.message ?? e}`; continue; }
          }
          // http 地址：下载
          try {
            const res = await fetch(c, { signal: AbortSignal.timeout(180000) });
            if (!res.ok) { lastErr = `下载失败 HTTP ${res.status}`; continue; }
            const buf = Buffer.from(await res.arrayBuffer());
            fs.writeFileSync(dest, buf);
            return ok({
              saved: dest, name: safeName, size: buf.length, sizeText: human(buf.length),
              source: 'http',
              note: '文件已下载到工作区。可直接读取内容，或转交 DSH 处理。'
            });
          } catch (e) { lastErr = `下载异常：${e?.message ?? e}`; }
        }

        return err(`所有方式都失败：${lastErr}\n候选：${cands.map((c) => c.slice(0, 80)).join(' | ')}`);
      } catch (e) {
        return err(`取文件失败：${e?.message ?? e}`);
      }
    }
  });

  // 工具 2：列目录（排查 NapCat 临时文件在哪）
  ctx.tools.register({
    name: 'list_napcat_files',
    description: '列出 NapCat 接收文件的目录，找最近收到的文件（fetch_file 定位不到时用它排查）。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '可选：指定目录；默认扫 NapCat temp 与 recv' },
        limit: { type: 'number', description: '返回条数，默认 15' }
      },
      required: []
    },
    async execute(_toolCtx, args) {
      try {
        const dirs = args.dir ? [String(args.dir)] : napcatDirs();
        const limit = Math.max(1, Math.min(Number(args.limit) || 15, 50));
        const out = [];
        for (const d of dirs) {
          if (!isAllowed(d)) { out.push(`${d} → 不在白名单`); continue; }
          if (!fs.existsSync(d)) { out.push(`${d} → 不存在`); continue; }
          try {
            const items = fs.readdirSync(d)
              .map((n) => {
                const full = path.join(d, n);
                try {
                  const st = fs.statSync(full);
                  return { n, full, size: st.size, mtime: st.mtimeMs, isDir: st.isDirectory() };
                } catch { return null; }
              })
              .filter(Boolean)
              .filter((x) => !x.isDir)
              .sort((a, b) => b.mtime - a.mtime)
              .slice(0, limit);
            for (const it of items) {
              out.push(`${new Date(it.mtime).toLocaleString('zh-CN')}  ${human(it.size).padStart(8)}  ${it.full}`);
            }
          } catch (e) { out.push(`${d} → 读取失败：${e?.message ?? e}`); }
        }
        return ok(out.length ? out.join('\n') : '这些目录里没有文件');
      } catch (e) {
        return err(String(e?.message ?? e));
      }
    }
  });

  // 工具 3：发送本机任意白名单目录的图片/文件（补 send_image/send_file 的目录限制）
  ctx.tools.register({
    name: 'send_local_image',
    description: '发送本机上的图片（补 send_image 的目录限制：它只认 workspace/dsh-work/tmp）。'
      + '适合发 data/ 下的图片、NapCat 收件目录里的图、或路径更深的本地图片。'
      + 'path 传本地绝对路径；也可传目录 + 文件名。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本地图片绝对路径（png/jpg/jpeg/gif/webp/bmp）' },
        replyToMessageId: { type: ['integer', 'string'], description: '可选：引用消息 id' }
      },
      required: ['path']
    },
    async execute(toolCtx, args) {
      try {
        const raw = String(args.path || '').trim();
        if (!raw) return err('path 不能为空');
        const real = path.resolve(raw);
        if (!isAllowed(real)) return err(`路径不在白名单：${real}`);
        if (!fs.existsSync(real)) return err(`文件不存在：${real}`);
        const st = fs.statSync(real);
        if (!st.isFile()) return err('目标不是文件');
        if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(real)) return err('不是图片格式（png/jpg/gif/webp/bmp）');
        if (st.size > 20 * 1024 * 1024) return err(`图片过大（${human(st.size)}，上限 20MB）`);

        // 🔴 关键（2026-10-22 实测）：NapCat 可能以非 root 用户运行，
        //    而素材常在 /root 下（/root 是 dr-xr-x---，非 root 穿不透）→ EACCES。
        //    解法：先把文件复制到 NapCat 一定能读的 /tmp（0644）再发。
        let sendPath = real;
        let tempCopy = '';
        if (real.startsWith('/root/')) {
          try {
            tempCopy = path.join('/tmp', `send-${Date.now()}-${path.basename(real)}`);
            fs.copyFileSync(real, tempCopy);
            fs.chmodSync(tempCopy, 0o644);
            sendPath = tempCopy;
            ctx.log('[send_local_image] /root 路径，已中转 /tmp:', tempCopy);
          } catch (e) {
            ctx.log('[send_local_image] 中转失败，直接用原路径:', e?.message);
            tempCopy = '';
          }
        }

        let sent;
        try {
          sent = await toolCtx.sender.sendImage(toolCtx.chatKey, sendPath, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: null
          });
        } finally {
          if (tempCopy) { try { fs.unlinkSync(tempCopy); } catch { /* ignore */ } }
        }
        toolCtx.session.sent.push({
          type: 'image',
          text: `[图片:${path.basename(real).slice(0, 40)}]`,
          at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
        });
        toolCtx.emit('session-update', toolCtx.session.id);
        return ok({ sent: true, path: real, size: st.size, messageId: sent?.message_id ?? null });
      } catch (e) {
        return err(`发图失败：${e?.message ?? e}`);
      }
    }
  });

  // 工具 4：发送本机任意白名单目录的文件
  ctx.tools.register({
    name: 'send_local_file',
    description: '发送本机上的文件。允许范围是项目根、工作目录（鱼鱼的工作目录）、/tmp 等常见产物位置；越界的系统路径会被拒绝。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本地文件绝对路径' },
        fileName: { type: 'string', description: '可选：发送时显示的文件名' }
      },
      required: ['path']
    },
    async execute(toolCtx, args) {
      try {
        const raw = String(args.path || '').trim();
        if (!raw) return err('path 不能为空');
        const real = path.resolve(raw);
        if (!isAllowed(real)) return err(`路径不在白名单：${real}`);
        if (!fs.existsSync(real)) return err(`文件不存在：${real}`);
        const st = fs.statSync(real);
        if (!st.isFile()) return err('目标不是文件');
        if (st.size > 50 * 1024 * 1024) return err(`文件过大（${human(st.size)}，上限 50MB）`);

        // 同 send_local_image：/root 下的文件 NapCat 读不到，先中转 /tmp
        let sendPath = real;
        let tempCopy = '';
        if (real.startsWith('/root/')) {
          try {
            tempCopy = path.join('/tmp', `send-${Date.now()}-${path.basename(real)}`);
            fs.copyFileSync(real, tempCopy);
            fs.chmodSync(tempCopy, 0o644);
            sendPath = tempCopy;
          } catch { tempCopy = ''; }
        }

        const name = String(args.fileName || '').trim() || path.basename(real);
        let sent;
        try {
          sent = await toolCtx.sender.sendFile(toolCtx.chatKey, sendPath, name);
        } finally {
          if (tempCopy) { try { fs.unlinkSync(tempCopy); } catch { /* ignore */ } }
        }
        toolCtx.session.sent.push({
          type: 'file',
          text: `[文件:${name.slice(0, 40)}]`,
          at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
        });
        toolCtx.emit('session-update', toolCtx.session.id);
        return ok({ sent: true, path: real, name, size: st.size, fileId: sent?.file_id ?? null });
      } catch (e) {
        return err(`发文件失败：${e?.message ?? e}`);
      }
    }
  });

  // 工具 5：查从者立绘（圣杯战争素材）
  ctx.tools.register({
    name: 'find_servant_image',
    description: '查「圣杯战争」从者立绘的本地图片路径。主人问「发个XX从者的形象/立绘」时用它拿路径，'
      + '再用 send_local_image 发出去。不传 name 就列出全部 63 骑。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '从者名（可用简称，如「DeepSeek娘」「saber」「金闪闪」）' }
      },
      required: []
    },
    async execute(_toolCtx, args) {
      try {
        // 找 grail 的 cards/servants.json 与 assets/servants
        const bases = [
          '/root/qq-agent-v2/plugins/grail',
          '/home/lyy/QQbot/qq-agent-v2/plugins/grail'
        ];
        let base = '';
        for (const b of bases) {
          if (fs.existsSync(path.join(b, 'cards', 'servants.json'))) { base = b; break; }
        }
        if (!base) return err('找不到圣杯战争素材目录');

        const servants = JSON.parse(fs.readFileSync(path.join(base, 'cards', 'servants.json'), 'utf8'));
        const imgDir = path.join(base, 'assets', 'servants');

        const q = String(args.name || '').trim().toLowerCase();
        const rows = servants.map((s) => {
          const img = path.join(imgDir, `${s.id}.jpg`);
          return {
            id: s.id, name: s.name, cls: s.cls, from: s.from,
            image: fs.existsSync(img) ? img : '',
            size: fs.existsSync(img) ? fs.statSync(img).size : 0
          };
        }).filter((r) => r.image);

        if (!q) {
          const list = rows.map((r) => `${r.id}  ${r.name}（${r.cls}）`).join('\n');
          return ok({ total: rows.length, list, hint: '用 find_servant_image(name="从者名") 精确查路径' });
        }

        // 模糊匹配：名字包含 / id 包含
        const hits = rows.filter((r) =>
          r.name.toLowerCase().includes(q)
          || r.id.toLowerCase() === q
          || r.cls.toLowerCase().includes(q)
          || r.from.toLowerCase().includes(q)
        );
        if (!hits.length) {
          const similar = rows.filter((r) => r.name.toLowerCase().split('').some((ch) => q.includes(ch))).slice(0, 5);
          return err(`没有叫「${args.name}」的从者。`
            + (similar.length ? `相近的：${similar.map((r) => r.name).join('、')}` : '用 find_servant_image() 看全部名单'));
        }
        return ok({
          found: hits.length,
          matches: hits.map((r) => ({ name: r.name, cls: r.cls, from: r.from, image: r.image, sizeText: human(r.size) })),
          note: '拿到 image 路径后，用 send_local_image(path=image) 把立绘发出去。'
        });
      } catch (e) {
        return err(`查立绘失败：${e?.message ?? e}`);
      }
    }
  });

  // 提示词：让 agent 知道文件用哪个工具取
  ctx.promptSections.register('file-recv-guidance', () => {
    return [
      '【收到文件怎么办】',
      '消息里出现 `[文件：xxx]` 时，**先调 `fetch_file(messageId=#数字)`** 把文件取到本地。',
      '· 如果内核的 `receive_file` 报「NapCat 没有返回可下载地址」—— 别放弃、别说"取不下来"，',
      '  换成 `fetch_file` 再试：它直接读 NapCat 的本地目录，专门解决这种情况。',
      '· 不确定文件在哪时，先 `list_napcat_files()` 看 NapCat 收件目录里最近的文件。',
      '· 取到后返回的 `saved` 就是本地路径，可直接读内容或转交 DSH 处理。',
      '',
      '【要发本机文件/图片】',
      '· `send_image` / `send_file` 只能发 workspace、dsh-work、/tmp 三个目录。',
      '· 其他地方（data/、NapCat 收件目录、从者立绘、任意深度路径）用：',
      '  `send_local_image(path)` 发图、`send_local_file(path)` 发文件 —— 它们走白名单校验，范围更宽。',
      '',
      '【主人要「从者立绘 / 形象」时】（重要，别说发不出来）',
      '本机**有 63 张圣杯战争从者立绘**（含 DeepSeek娘 等），不要回答"我只有文字描述"：',
      '1. `find_servant_image(name="DeepSeek娘")` → 拿到本地图片路径',
      '2. `send_local_image(path=那个路径)` → 直接发出去',
      '不知道确切名字就先 `find_servant_image()` 列全部 63 骑再挑。'
    ].join('\n');
  });

  // 面板状态
  ctx.http.route('GET', '/api/plugins/file-recv/status', () => {
    const c = ctx.config.get();
    const ws = String(c.workspaceDir || '') || path.join(ctx.dataDir, 'inbox');
    const napcatFound = ['/home/qqtest/.config/QQ/NapCat/temp', '/home/qqtest/.config/QQ/NapCat/recv']
      .some((d) => { try { return fs.existsSync(d); } catch { return false; } });
    return { ok: true, config: c, env: { workspace: ws, napcatFound, allowed: ALLOWED_ROOTS } };
  }, { absolute: true, raw: false });

  ctx.log('[file-recv] 已启用：fetch_file / list_napcat_files');
  return { dispose() {} };
}
