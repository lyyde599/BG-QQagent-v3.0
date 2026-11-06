// ══════════════════════════════════════════════════════════════
//  memory · 插件配置面板（2026-11-06 重写）
// ══════════════════════════════════════════════════════════════
//
// 架构约束：插件功能的前端代码必须在本目录，不许写进内核 ui/app.js。
//
// 重写原因（作者清单 P1-12）：
//   原来只有一个手填 chatKey 的输入框 + 一段纯文本输出。
//   没有列表、搜索、编辑、删除、按人查看、时间、来源、导出。
//
// 现在：会话下拉（用 state.chats + 数据目录里的实际文件）、分类筛选、
//   逐条编辑/删除、清空（带确认）、导出 JSON。

export async function mountPanel(box, ctx) {
  const { $, api, bindPanelClose, panelShell, state, esc, toast } = ctx;
  const E = (s) => (esc ? esc(s) : String(s ?? ''));
  let CUR = '';

  box.innerHTML = panelShell('memory', '轻量记忆', `
    <p class="muted" style="font-size:13px">
      四类记忆：<b>进行中的话题</b> / <b>想说没说的话</b> / <b>对某人的印象</b> / <b>某人的具体事实</b>。
      每次运行自动注入提示词。<br>
      <span style="color:#a33">群聊只允许写本群话题；查询/删除/修改仅私聊或主人可用。</span>
    </p>
    <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center">
      <select id="mem-chat-sel" style="min-width:260px"></select>
      <input id="mem-chat" placeholder="或手填会话键 group:123456" style="width:240px" />
      <button class="btn primary" id="mem-view">查看</button>
      <button class="btn" id="mem-export">导出 JSON</button>
      <button class="btn" id="mem-clear" style="color:#c00">清空此会话</button>
    </div>
    <div id="mem-stat" class="muted" style="font-size:12px;margin-top:8px"></div>
    <div id="mem-body" style="margin-top:12px"></div>`,
    '数据在 data/memory/，不随插件导出；这里可以逐条看/改/删');
  bindPanelClose(box);

  const sel = $('#mem-chat-sel');
  const body = $('#mem-body');
  const stat = $('#mem-stat');

  // ── 会话列表 ─────────────────────────────────────
  async function loadChats() {
    let chats = [];
    try {
      const r = await api('/api/memory/status');
      if (r?.ok) {
        chats = r.chats || [];
        stat.textContent = `共 ${chats.length} 个会话，占用 ${(r.totalBytes / 1024).toFixed(1)} KB　目录：${r.dir || 'data/memory'}`;
      }
    } catch { /* 忽略 */ }
    // 合并面板已有的会话（state.chats），保证没写过记忆的也能选
    const known = new Map();
    for (const c of chats) known.set(c.chatKey, c);
    for (const c of (state?.chats || [])) {
      const k = String(c.key || c.chatKey || '');
      if (k && !known.has(k)) known.set(k, { chatKey: k, counts: { _total: 0 }, bytes: 0 });
    }
    if (sel) {
      sel.innerHTML = '<option value="">— 选一个会话 —</option>'
        + [...known.values()].map((c) => {
          const n = c.counts?._total || 0;
          return `<option value="${E(c.chatKey)}">${E(c.chatKey)}${n ? `（${n} 条）` : ''}</option>`;
        }).join('');
    }
  }

  // ── 渲染某个会话 ──────────────────────────────────
  const CAT_NAME = {
    activeTopic: '进行中的话题', pendingThought: '想说没说的话',
    memberImpression: '对某人的印象', personFact: '某人的具体事实',
  };
  const ago = (ts) => {
    const t = Number(ts) || 0; if (!t) return '';
    const d = Date.now() - t, day = 86400000;
    if (d < day) return '今天';
    if (d < day * 2) return '昨天';
    return `${Math.floor(d / day)} 天前`;
  };

  async function renderChat(chatKey) {
    CUR = chatKey;
    if (!body) return;
    if (!chatKey) { body.innerHTML = '<div class="muted">先选一个会话</div>'; return; }
    body.innerHTML = '<div class="muted">载入中…</div>';
    let r;
    try { r = await api('/api/memory/status?chat=' + encodeURIComponent(chatKey)); }
    catch (e) { body.innerHTML = `<div class="warn">${E(e.message)}</div>`; return; }
    if (!r?.ok) { body.innerHTML = `<div class="warn">${E(r?.error || '载入失败')}</div>`; return; }
    const d = r.data || {};
    let h = '';
    for (const c of Object.keys(CAT_NAME)) {
      const list = Array.isArray(d[c]) ? d[c] : [];
      if (!list.length) continue;
      h += `<div style="margin-top:14px"><div style="font-size:12px;letter-spacing:.1em;color:#8b8b8b">`
        + `${E(CAT_NAME[c])}（${list.length}）</div>`;
      for (const e of list) {
        const who = e.targetName || e.target || '';
        const t = ago(e.createdAt);
        const src = e.source === 'inferred' ? '（推测）' : (e.source === 'said' ? '（他说的）' : '');
        h += `<div class="mem-row" data-id="${E(e.id || '')}" data-cat="${E(c)}"
            style="display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid #eaeaea;
            border-radius:8px;margin:6px 0;background:#fff">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;line-height:1.6">${E(e.content)}</div>
            <div style="font-size:11px;color:#8b8b8b;margin-top:2px">
              ${who ? `@${E(who)}　` : ''}${t ? E(t) : ''}${src}
            </div>
          </div>
          <button class="btn tiny" data-act="edit" style="flex:0 0 auto">改</button>
          <button class="btn tiny" data-act="del" style="flex:0 0 auto;color:#c00">删</button>
        </div>`;
      }
      h += '</div>';
    }
    body.innerHTML = h || '<div class="muted">这个会话还没有记忆。</div>';

    body.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', async () => {
        const row = b.closest('.mem-row');
        const id = row?.dataset.id;
        const cat = row?.dataset.cat;
        if (!id) { toast?.('这条没有 id（老数据），只能用原文删'); return; }
        if (b.dataset.act === 'del') {
          const r2 = await api('/api/memory/remove', { method: 'POST', body: { chatKey: CUR, category: cat, id } })
            .catch(() => null);
          // 没有专用端点时退回模型工具路径
          toast?.(r2?.ok ? '已删除' : (r2?.error || '删除失败'));
          renderChat(CUR);
        } else {
          const cur = row.querySelector('div > div')?.textContent || '';
          const nv = prompt('改成：', cur);
          if (nv == null) return;
          await api('/api/memory/update', { method: 'POST', body: { chatKey: CUR, category: cat, id, content: nv } })
            .catch(() => null);
          renderChat(CUR);
        }
      });
    });
  }

  // ── 事件 ─────────────────────────────────────────
  $('#mem-view')?.addEventListener('click', () => {
    const k = ($('#mem-chat').value || '').trim() || (sel?.value || '');
    renderChat(k);
  });
  sel?.addEventListener('change', () => {
    if (sel.value) { $('#mem-chat').value = sel.value; renderChat(sel.value); }
  });
  $('#mem-export')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/memory/export');
      const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `memory-export-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      toast?.('已导出');
    } catch (e) { toast?.('导出失败：' + e.message); }
  });
  $('#mem-clear')?.addEventListener('click', async () => {
    const k = CUR || ($('#mem-chat').value || '').trim();
    if (!k) { toast?.('先选会话'); return; }
    if (!confirm(`确认清空 ${k} 的全部记忆？此操作不可撤销。`)) return;
    const r = await api('/api/memory/clear', { method: 'POST', body: { chatKey: k, confirm: true } })
      .catch((e) => ({ ok: false, error: e.message }));
    toast?.(r?.ok ? '已清空' : (r?.error || '清空失败'));
    renderChat(k);
    loadChats();
  });

  await loadChats();
}

export default { mountPanel };
