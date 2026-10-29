// ── 上下文策略 · 配置面板 ──────────────────────────────────────

const MODES = [
  ['mention-only', '只回指向我的', '@我 / 引用我 / 拍我 / 关键词才算触发，其余当背景（推荐）'],
  ['mention-fallback', '指向我的优先，没有则回最后一条', '同上，但一条都没命中时退而回最近一条，避免一直不开口'],
  ['all', '全部算触发（内核默认）', '等于不启用本插件，用于对比或临时关闭']
];

export async function mountPanel(box, ctx) {
  const { api, esc } = ctx;

  let cfg = {};
  try {
    const d = await api('/api/plugins');
    const me = (d.plugins || []).find((x) => x.id === 'context-strategy');
    cfg = me?.config || {};
  } catch { /* 用默认 */ }

  const mode = String(cfg.mode || 'mention-only');
  const keywords = Array.isArray(cfg.customKeywords) ? cfg.customKeywords : [];
  const maxBg = Number(cfg.maxBackground) || 50;
  const debug = cfg.debug === true;

  box.innerHTML = `
    <style>
      .cs-field { margin-bottom:12px; }
      .cs-field label { display:block; font-size:12px; color:var(--muted,#888); margin-bottom:4px; }
      .cs-hint { font-size:11.5px; color:var(--muted,#888); line-height:1.7; margin-top:4px; }
    </style>

    <div style="padding:4px 0 12px">
      <div style="font-size:13.5px;font-weight:600;margin-bottom:4px">上下文策略</div>
      <div class="cs-hint">
        群里积压十几条消息时，内核默认把它们全算「本次唤醒」并排除出【过去状态】，<br>
        模型只看到一堆孤立消息、抓不住上下文。本插件改成只把「确实该回」的算触发，<br>
        <b>其余留在过去状态里当背景</b>，模型能顺着读下来。
      </div>
    </div>

    <div class="cs-field">
      <label>分流方式</label>
      <select id="cs-mode" style="width:100%">
        ${MODES.map(([v, label]) => `<option value="${v}" ${v === mode ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select>
      <div class="cs-hint" id="cs-mode-desc">${esc((MODES.find((m) => m[0] === mode) || MODES[0])[2])}</div>
    </div>

    <div class="cs-field">
      <label>额外触发关键词（逗号分隔，命中就算触发）</label>
      <input id="cs-keywords" style="width:100%" value="${esc(keywords.join(', '))}" placeholder="小鲸鱼, 机器人, 助手" />
      <div class="cs-hint">除了 @/引用/拍一拍，这些词出现也会触发回复。</div>
    </div>

    <div class="cs-field">
      <label>背景消息最多保留条数</label>
      <input id="cs-maxbg" type="number" min="0" max="500" style="width:120px" value="${maxBg}" />
      <div class="cs-hint">超过这个数量的旧消息不塞进过去状态（过去状态本身还有字数预算）。</div>
    </div>

    <div class="cs-field">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" id="cs-debug" ${debug ? 'checked' : ''} />
        <span>日志里打印分流结果（排查用）</span>
      </label>
    </div>

    <div style="display:flex;gap:8px;align-items:center;margin-top:16px">
      <button class="btn btn-primary" id="cs-save">保存</button>
      <span id="cs-msg" class="cs-hint"></span>
    </div>
  `;

  const msg = (s, ok = true) => {
    const el = box.querySelector('#cs-msg');
    if (!el) return;
    el.textContent = s;
    el.style.color = ok ? '#2f855a' : '#b91c1c';
  };

  box.querySelector('#cs-mode')?.addEventListener('change', (ev) => {
    const d = MODES.find((m) => m[0] === ev.target.value);
    const desc = box.querySelector('#cs-mode-desc');
    if (desc && d) desc.textContent = d[2];
  });

  box.querySelector('#cs-save')?.addEventListener('click', async () => {
    try {
      const patch = {
        mode: box.querySelector('#cs-mode')?.value || 'mention-only',
        customKeywords: (box.querySelector('#cs-keywords')?.value || '')
          .split(',').map((s) => s.trim()).filter(Boolean),
        maxBackground: Number(box.querySelector('#cs-maxbg')?.value) || 50,
        debug: box.querySelector('#cs-debug')?.checked === true
      };
      await api('/api/plugins/config', {
        method: 'POST',
        body: { id: 'context-strategy', patch }
      });
      msg('已保存 ✓（下一条消息起生效）');
    } catch (e) {
      msg('保存失败：' + e.message, false);
    }
  });
}
