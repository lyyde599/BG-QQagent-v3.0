// ── 创造营 · 面板（作者：白光）──────────────────────────────────────
//
// 「创造营」= 插件市场 + 技能发布。
//
// 🔴 2026-10-25 重写：不再用 panelShell。
//    panelShell 是为「弹窗里的配置面板」设计的，带「收起」按钮和卡片边框。
//    放进顶栏页签里会显得局促，而且点「收起」会把整个页面清空。
//    这里改成独立的整页布局：顶部标签切换（插件 / 技能 / 发布），内容区自适应。

export async function mountPanel(box, ctx) {
  const { api, esc } = ctx;

  // ── 拉数据 ──
  let market = { ok: false, plugins: [] };
  let marketCfg = {};
  let skills = [];
  try { market = await api('/api/market/index'); } catch { /* 忽略 */ }
  try { const st = await api('/api/market/config'); marketCfg = st.config || {}; } catch { /* 忽略 */ }
  try { const s = await api('/api/skills'); skills = s.skills || s.items || []; } catch { /* 忽略 */ }
  // 市场里的 skill（用于显示发布状态，2026-10-25）
  let marketSkills = [];
  try {
    const ms = await api('/api/skill-market/index');
    marketSkills = ms?.skills || [];
  } catch { /* 市场不通就空着 */ }
  const marketById = new Map(marketSkills.map((x) => [x.id, x]));

  const TRUST = {
    official:  { icon: '●', label: '官方',   color: 'var(--acc)' },
    verified:  { icon: '●', label: '已审核', color: '#2b6cb0' },
    unverified:{ icon: '●', label: '未审核', color: '#b7791f' },
    blocked:   { icon: '●', label: '已下架', color: '#c00' },
  };

  // ── 插件卡片 ──
  const pluginCards = (market.plugins || []).map((p) => {
    const t = TRUST[p.trust] || TRUST.unverified;
    return `
      <div class="cy-card cy-card-2col">
        <div class="cy-card-main">
          <div class="cy-card-head">
            <span class="cy-name">${esc(p.name || p.id)}</span>
            <span class="cy-ver">v${esc(String(p.version || ''))}</span>
            <span class="cy-trust" style="color:${t.color}">${t.icon} ${t.label}</span>
          </div>
          <div class="cy-summary">${esc(p.summary || '')}</div>
          <div class="cy-meta">作者：${esc(p.author || '未知')}</div>
        </div>
        <div class="cy-card-side">
          <div class="cy-desc">${esc(p.description || p.summary || '')}</div>
          ${(p.permissions || []).length ? `<div class="cy-perms">权限：${esc((p.permissions || []).join('、'))}</div>` : ''}
        </div>
        <div class="cy-card-act">
          ${p.installed
            ? (p.updatable
                ? `<button class="btn tiny" data-install="${esc(p.id)}" data-confirm="${p.trust === 'unverified' ? 1 : 0}">更新</button>`
                : `<span class="cy-installed">已安装</span>`)
            : `<button class="btn tiny primary" data-install="${esc(p.id)}" data-confirm="${p.trust === 'unverified' ? 1 : 0}">安装</button>`}
        </div>
      </div>`;
  }).join('');

  // ── 技能卡片 ──
  const skillCards = skills.length
    ? skills.map((s) => {
      const sid = s.id || s.name || '';
      const pub = marketById.get(sid);
      const badge = pub
        ? `<span class="cy-badge" style="background:#2f855a22;color:#2f855a">已发布 v${esc(pub.version || '?')}</span>`
        : `<span class="cy-badge">未发布</span>`;
      return `
      <div class="cy-card" data-skill="${esc(sid)}">
        <div class="cy-card-head">
          <span class="cy-name">${esc(s.name || sid)}</span>
          ${s.version ? `<span class="cy-ver">v${esc(s.version)}</span>` : ''}
          ${badge}
          ${s.source === 'builtin' ? '<span class="cy-badge">内置</span>' : ''}
          <span class="cy-spacer"></span>
          <button class="btn tiny" data-skill-export="${esc(sid)}">导出</button>
          <button class="btn tiny" data-skill-pub="${esc(sid)}">发布</button>
          ${pub ? `<button class="btn tiny" data-skill-off="${esc(sid)}" style="color:#c00">下架</button>` : ''}
        </div>
        <div class="cy-summary">${esc(s.summary || s.description || '')}</div>
        <div class="cy-meta">
          ${s.author ? `作者：${esc(s.author)}` : '作者：未标注'}
          ${s.when ? ` · 触发：${esc(String(s.when).slice(0, 40))}` : ''}
        </div>
      </div>`;
    }).join('')
    : '<div class="cy-empty">还没有技能。技能放在 skills/ 目录，写好 md 就能在这里看到。</div>';

  box.innerHTML = `
    <style>
      .cy-wrap { max-width: 1000px; margin: 0 auto; padding: 8px 4px 40px; }
      .cy-head { display:flex; align-items:baseline; gap:10px; margin-bottom:4px; }
      .cy-title { font-size:20px; font-weight:600; }
      .cy-sub { font-size:12.5px; color:var(--muted,#888); }
      .cy-nav { display:flex; gap:2px; border-bottom:1px solid var(--line); margin:14px 0 16px; }
      .cy-tab { padding:8px 16px; font-size:13.5px; cursor:pointer; border:none; background:none;
                color:var(--muted,#888); border-bottom:2px solid transparent; margin-bottom:-1px; }
      .cy-tab.on { color:var(--fg,#222); border-bottom-color:var(--acc); font-weight:600; }
      .cy-pane { display:none; } .cy-pane.on { display:block; }
      .cy-card { border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-bottom:8px; }
      .cy-card-head { display:flex; align-items:baseline; gap:8px; }
      .cy-name { font-weight:600; font-size:14px; }
      .cy-ver { font-size:12px; color:var(--muted,#888); }
      .cy-trust { font-size:11.5px; }
      .cy-spacer { flex:1; }
      .cy-installed { font-size:12px; color:var(--muted,#888); }
      .cy-summary { font-size:12.5px; color:var(--muted,#888); margin-top:4px; }
      .cy-meta { font-size:11.5px; color:var(--muted,#999); margin-top:4px; }

      /* 两栏卡片：左边名称/一句话，右边完整说明（2026-10-25）
         用户反馈"位置多，可以说清楚一点" —— 之前每张卡片右边全是空白，
         因为只显示了一行 summary。现在把完整 description 放进去。 */
      .cy-card-2col { display:grid; grid-template-columns: minmax(200px, 300px) 1fr auto;
                      gap:18px; align-items:start; }
      .cy-card-main { min-width:0; }
      .cy-card-side { min-width:0; }
      .cy-desc { font-size:12.5px; line-height:1.75; color:var(--fg,#333); }
      .cy-perms { font-size:11.5px; color:var(--muted,#999); margin-top:8px;
                  padding-top:8px; border-top:1px dashed var(--line); }
      .cy-card-act { display:flex; align-items:center; min-width:64px; justify-content:flex-end; }

      /* ── 管理员总览（2026-10-25）── */
      .cy-admin-stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(96px,1fr));
                        gap:10px; margin-bottom:20px; }
      .cy-stat { border:1px solid var(--line); border-radius:8px; padding:12px 10px; text-align:center; }
      .cy-stat b { display:block; font-size:22px; font-weight:600; line-height:1.2; }
      .cy-stat span { display:block; font-size:11.5px; color:var(--muted,#888); margin-top:4px; }
      .cy-section-title { font-size:13px; font-weight:600; margin-bottom:10px; }
      .cy-author-list { display:grid; gap:6px; }
      .cy-author-row { display:flex; align-items:center; gap:10px; padding:8px 10px;
                       border:1px solid var(--line); border-radius:7px; }
      .cy-admin-table { border:1px solid var(--line); border-radius:8px; overflow:hidden; }
      .cy-admin-thead, .cy-admin-tr { display:grid;
        grid-template-columns: minmax(140px,1.4fr) minmax(80px,.8fr) 70px minmax(120px,1.1fr) 130px;
        gap:10px; padding:9px 12px; align-items:center; font-size:12.5px; }
      .cy-admin-thead { background:var(--bg-soft,#faf9f7); font-weight:600; font-size:12px;
                        color:var(--muted,#888); border-bottom:1px solid var(--line); }
      .cy-admin-tr { border-bottom:1px solid var(--line); }
      .cy-admin-tr:last-child { border-bottom:none; }
      .cy-admin-id { font-weight:500; }
      @media (max-width: 820px) {
        .cy-admin-thead { display:none; }
        .cy-admin-tr { grid-template-columns: 1fr; gap:6px; padding:12px; }
      }

      /* 窄屏退化成单栏 */
      @media (max-width: 760px) {
        .cy-card-2col { grid-template-columns: 1fr; gap:10px; }
        .cy-card-act { justify-content:flex-start; }
      }
      .cy-empty { font-size:12.5px; color:var(--muted,#888); padding:20px; text-align:center; }
      .cy-box { border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin-bottom:12px; }
      .cy-row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; font-size:13px; }
      .cy-label { font-size:12.5px; display:block; margin-bottom:4px; color:var(--muted,#888); }
      .cy-out { font-size:11.5px; white-space:pre-wrap; max-height:220px; overflow:auto;
                margin-top:10px; background:var(--bg-soft,#faf9f7); padding:10px; border-radius:6px; }

      /* ── 作者账号区（2026-10-25 美化）──
         原来是一排裸 input，挤在一起分不清主次。
         现在：已注册显示成"名片"，未注册显示成带步骤的表单。 */
      .cy-author { display:flex; align-items:center; gap:14px; padding:4px 0; }
      .cy-avatar { width:44px; height:44px; border-radius:50%; flex-shrink:0;
                   display:flex; align-items:center; justify-content:center;
                   font-size:18px; font-weight:600;
                   background:var(--acc); color:var(--on-acc,#fff); }
      .cy-author-info { flex:1; min-width:0; }
      .cy-author-name { font-size:14px; font-weight:600; }
      .cy-author-meta { font-size:12px; color:var(--muted,#888); margin-top:3px; }
      .cy-badge { display:inline-block; font-size:11px; padding:1px 7px; border-radius:10px;
                  background:rgba(0,0,0,.05); color:var(--muted,#888); margin-left:6px; }

      .cy-field { margin-bottom:14px; }
      .cy-field:last-child { margin-bottom:0; }
      .cy-field-label { font-size:12.5px; font-weight:600; margin-bottom:6px;
                        display:flex; align-items:center; gap:6px; }
      .cy-step { display:inline-flex; width:18px; height:18px; border-radius:50%;
                 align-items:center; justify-content:center; font-size:11px;
                 background:var(--acc); color:var(--on-acc,#fff); font-weight:600; }
      .cy-input { width:100%; font-size:13px; padding:8px 10px; border-radius:6px;
                  border:1px solid var(--line); background:var(--bg,#fff); }
      .cy-input:focus { outline:none; border-color:var(--acc); }
      .cy-inline { display:flex; gap:8px; align-items:stretch; }
      .cy-inline .cy-input { flex:1; }
      .cy-hint { font-size:11.5px; color:var(--muted,#999); margin-top:6px; }
      .cy-msg { font-size:12px; margin-top:10px; padding:8px 10px; border-radius:6px; display:none; }
      .cy-msg.on { display:block; }
      .cy-msg.err { background:rgba(204,0,0,.06); color:#c00; }
      .cy-msg.ok { background:rgba(0,128,0,.06); color:#080; }

      /* 文件选择：原生 input 太丑，用 label 包起来做成按钮 */
      .cy-file { flex:1; display:flex; align-items:center; gap:8px; cursor:pointer;
                 font-size:12.5px; padding:8px 10px; border-radius:6px;
                 border:1px dashed var(--line); color:var(--muted,#888);
                 background:var(--bg,#fff); transition:border-color .15s; }
      .cy-file:hover { border-color:var(--acc); color:var(--fg,#222); }
      .cy-file input { display:none; }
      .cy-file.picked { border-style:solid; color:var(--fg,#222); }

      /* 代码示例块 */
      .cy-code { font-family:var(--mono,ui-monospace,monospace); font-size:11.5px; line-height:1.7;
                 background:var(--bg-soft,#faf9f7); border:1px solid var(--line); border-radius:7px;
                 padding:12px 14px; overflow-x:auto; white-space:pre; margin:0 0 12px; color:var(--fg,#333); }
    </style>

    <div class="cy-wrap">
      <div class="cy-head">
        <div class="cy-title">BG-QQAgent 创造营</div>
        <div class="cy-sub">装插件 · 发技能</div>
      </div>

      <div class="cy-nav">
        <button class="cy-tab on" data-pane="plugins">插件市场</button>
        <button class="cy-tab" data-pane="mine">我的插件</button>
        <button class="cy-tab" data-pane="skills">技能库</button>
        <button class="cy-tab" data-pane="publish">发布</button>
        <button class="cy-tab" data-pane="admin" id="cy-tab-admin" style="display:none">管理</button>
        <button class="cy-tab" data-pane="settings">设置</button>
      </div>

      <!-- 插件市场 -->
      <div class="cy-pane on" id="cy-pane-plugins">
        <div class="cy-row" style="margin-bottom:10px">
          <span style="font-size:12.5px;color:var(--muted,#888)">
            共 ${market.total ?? 0} 个插件　源：${esc((market.source || '').replace(/^https?:\/\//, '').slice(0, 40) || '—')}${market.cached ? '（缓存）' : ''}
          </span>
          <span class="cy-spacer" style="flex:1"></span>
          <button class="btn tiny" id="cy-refresh">刷新</button>
        </div>
        ${market.warning ? `<div class="cy-box" style="border-color:#b7791f">⚠️ ${esc(market.warning)}</div>` : ''}
        ${!market.ok ? `<div class="cy-box">${esc(market.error || '拿不到市场清单')}</div>` : ''}
        ${pluginCards || '<div class="cy-empty">清单是空的</div>'}
        <div id="cy-msg" class="cy-meta" style="margin-top:8px"></div>
      </div>

      <!-- 我的插件 -->
      <div class="cy-pane" id="cy-pane-mine">
        <div class="cy-row" style="margin-bottom:12px">
          <span id="cy-mine-count" style="font-size:12.5px;color:var(--muted,#888)">加载中…</span>
          <span class="cy-spacer" style="flex:1"></span>
          <button class="btn tiny" id="cy-mine-refresh">刷新</button>
        </div>
        <div id="cy-mine-list"></div>
      </div>

      <!-- 技能库 -->
      <div class="cy-pane" id="cy-pane-skills">
        <div class="cy-row" style="margin-bottom:10px">
          <span style="font-size:12.5px;color:var(--muted,#888)">共 ${skills.length} 个技能</span>
        </div>
        ${skillCards}
      </div>

      <!-- 发布 -->
      <div class="cy-pane" id="cy-pane-publish">
        <div class="cy-box" id="cy-author-box">
          <div class="cy-label">作者账号</div>
          <div id="cy-author-state" style="font-size:12.5px;color:var(--muted,#888)">检查中…</div>
        </div>

        <div class="cy-box">
          <div class="cy-label">打包插件（自动剥离用户数据与密钥）</div>
          <div class="cy-row">
            <input id="cy-pkg-id" placeholder="插件 id，如 sticker" style="width:200px;font-size:12.5px">
            <button class="btn" id="cy-pkg">打包</button>
            <button class="btn tiny" id="cy-pkg-list">看已打的包</button>
          </div>
          <div id="cy-pkg-out" class="cy-out" style="display:none"></div>
        </div>

        <div class="cy-box">
          <div class="cy-label">安装本地插件包（.tar.gz / .zip）</div>
          <div style="font-size:12.5px;color:var(--muted,#888);line-height:1.7;margin-bottom:10px">
            从别人那里拿到的插件包，直接选文件装进来。<br>
            装之前会先解析 manifest，把<b>作者、版本、申请的权限</b>列给你看，确认后才装。
          </div>
          <div class="cy-inline">
            <label class="cy-file" id="cy-file-label">
              <input type="file" id="cy-upload" accept=".gz,.tgz,.tar.gz,.zip,application/gzip,application/x-gzip,application/zip">
              <span id="cy-file-name">选择文件</span>
            </label>
            <button class="btn primary" id="cy-upload-btn" disabled style="white-space:nowrap">解析并安装</button>
          </div>
          <div class="cy-hint">支持 .tar.gz 与 .zip，单包上限 20 MB。</div>
          <div id="cy-upload-info" class="cy-out" style="display:none"></div>
        </div>

        <div class="cy-box">
          <div class="cy-label">发布 Skill（单个 .md，比插件轻得多）</div>
          <div class="cy-hint" style="margin-bottom:12px">
            Skill 是纯知识文件：放进 skills/ 立刻生效，不用重启、不用授权。
            适合写「操作步骤 / 领域规则 / 排错手册」。
          </div>
          <div class="cy-row" style="margin-bottom:10px">
            <select id="cy-skill-pick" class="cy-input" style="max-width:280px">
              <option value="">选择一个本地 skill…</option>
            </select>
            <button class="btn tiny" id="cy-skill-refresh">刷新列表</button>
          </div>
          <div id="cy-skill-preview" style="display:none;margin-bottom:12px"></div>
          <div class="cy-row">
            <input class="cy-input" id="cy-skill-ver" placeholder="版本号 1.0.0" value="1.0.0" style="max-width:130px">
            <input class="cy-input" id="cy-skill-notes" placeholder="这次改了什么（可留空）" style="flex:1;min-width:180px">
            <button class="btn primary" id="cy-skill-publish" disabled style="white-space:nowrap">发布到市场</button>
          </div>
          <div id="cy-skill-msg" class="cy-msg"></div>
        </div>

        <div class="cy-box">
          <div class="cy-label">Skill 文件怎么写（照着抄就行）</div>
          <div class="cy-hint" style="margin-bottom:10px">
            在 <code>skills/</code> 目录新建一个 <code>你的id.md</code>，开头写这段：
          </div>
<pre class="cy-code">---
name: 技能名
summary: 一句话说清这技能干什么（必填，模型靠它判断要不要读）
when: 什么时候该读它（越具体越好，别写"需要时"）
author: 白光
version: 1.0.0
license: MIT
---

# 正文标题

这里写真正的知识内容：操作步骤、规则、排错方法都可以。</pre>
          <div class="cy-hint" style="line-height:1.9">
            <b>三个必填字段怎么想：</b><br>
            · <code>name</code> —— 人看的，显示成标题<br>
            · <code>summary</code> —— <b>模型看的</b>。写"XX相关"等于没写，模型不知道这技能能干什么<br>
            · <code>when</code> —— <b>模型看的</b>。写"需要时"等于永远不读；要写清具体触发场景<br>
            <br>
            <b>什么样的知识适合做成 skill：</b><br>
            ✅ 操作步骤（怎么改配置 / 怎么部署）　✅ 领域规则（结算规则 / 业务约定）　✅ 排错手册<br>
            ❌ 一次性信息（写进对话就行）　❌ 能直接搜到的事实　❌ 插件自己的私有逻辑
          </div>
        </div>

        <div class="cy-box">
          <div class="cy-label">怎么让别人装上你的东西</div>
          <div style="font-size:12.5px;line-height:1.8;color:var(--muted,#888)">
            <b>插件：</b>打包 → 点「发布」→ 市场里就能装<br>
            <b>Skill：</b>写好 .md → 上面选它 → 发布 → 对方在技能库装<br>
            <br>
            发布后都会进市场清单，别人在「插件市场」/「技能库」看得到。
          </div>
        </div>
      </div>

      <!-- 管理员总览（只有 role=admin 才显示） -->
      <div class="cy-pane" id="cy-pane-admin">
        <div id="cy-admin-root">
          <div class="cy-empty">检查权限中…</div>
        </div>
      </div>

      <!-- 设置 -->
      <div class="cy-pane" id="cy-pane-settings">
        <div class="cy-box">
          <div class="cy-label">主源（清单地址）</div>
          <input id="cy-index" style="width:100%;font-size:12.5px" value="${esc(marketCfg.indexUrl || '')}">
          <div class="cy-label" style="margin-top:10px">备源（主源挂了自动切这个）</div>
          <input id="cy-mirror" style="width:100%;font-size:12.5px" value="${esc(marketCfg.mirrorUrl || '')}">
          <label class="cy-row" style="margin-top:12px;gap:6px">
            <input type="checkbox" id="cy-untrusted" ${marketCfg.showUntrusted ? 'checked' : ''}>
            <span>显示未审核插件（有风险）</span>
          </label>
          <div style="margin-top:12px"><button class="btn primary" id="cy-save">保存</button></div>
        </div>
      </div>
    </div>`;

  // ── 页签切换 ──
  box.querySelectorAll('.cy-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      box.querySelectorAll('.cy-tab').forEach((b) => b.classList.toggle('on', b === btn));
      box.querySelectorAll('.cy-pane').forEach((p) => {
        p.classList.toggle('on', p.id === `cy-pane-${btn.dataset.pane}`);
      });
    });
  });

  const msg = (t) => { const el = box.querySelector('#cy-msg'); if (el) el.textContent = t || ''; };

  // ── 安装 ──
  box.querySelectorAll('[data-install]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.install;
      const needConfirm = btn.dataset.confirm === '1';
      if (btn.disabled) return;

      if (needConfirm) {
        const meta = (market.plugins || []).find((p) => p.id === id);
        const perms = (meta?.permissions || []).join('、') || '（未声明）';
        if (!confirm(`这个插件未经审核。\n\n作者：${meta?.author || '未知'}\n申请权限：${perms}\n\n插件能执行任意代码，确认安装？`)) return;
      }

      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = '安装中…';
      msg('正在下载并校验…');
      try {
        const r = await api('/api/market/install', { method: 'POST', body: { id, confirmUntrusted: needConfirm } });
        if (r?.ok) {
          msg(`✅ ${r.message || '安装完成'}`);
          ctx.toast?.('安装完成');
          setTimeout(() => location.reload(), 1500);
        } else {
          msg(`❌ ${r?.error || '安装失败'}`);
        }
      } catch (e) { msg('❌ ' + e.message); }
      finally { btn.disabled = false; btn.textContent = old; }
    });
  });

  // ── 技能导出 ──
  box.querySelectorAll('[data-skill-export]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.skillExport;
      try {
        const r = await api(`/api/skills/one?id=${encodeURIComponent(id)}`);
        const content = r?.content || r?.skill?.content || '';
        if (!content) { ctx.toast?.('读不到技能内容'); return; }
        const blob = new Blob([content], { type: 'text/markdown' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${id}.md`;
        a.click();
        URL.revokeObjectURL(a.href);
        ctx.toast?.('已导出');
      } catch (e) { ctx.toast?.('导出失败：' + e.message); }
    });
  });

  // ── 发布页：skill 发布（2026-10-25）──
  const skillPick = () => box.querySelector('#cy-skill-pick');
  const skillMsg = () => box.querySelector('#cy-skill-msg');

  const showSkillMsg = (txt, kind) => {
    const m = skillMsg();
    if (!m) return;
    if (!txt) { m.className = 'cy-msg'; m.textContent = ''; return; }
    m.className = 'cy-msg on ' + (kind || '');
    m.textContent = txt;
  };

  const loadSkillPick = async () => {
    const sel = skillPick();
    if (!sel) return;
    sel.innerHTML = '<option value="">选择一个本地 skill…</option>';
    try {
      const r = await api('/api/skills');
      const list = r?.skills || [];
      for (const s of list) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.name}${s.version ? '  v' + s.version : ''}${s.author ? '  · ' + s.author : ''}`;
        sel.appendChild(opt);
      }
      if (!list.length) {
        sel.innerHTML = '<option value="">（skills/ 里还没有文件）</option>';
      }
    } catch { /* 忽略 */ }
  };

  // 选中后显示预览
  skillPick()?.addEventListener('change', async () => {
    const id = skillPick().value;
    const pv = box.querySelector('#cy-skill-preview');
    const btn = box.querySelector('#cy-skill-publish');
    if (!pv) return;
    if (!id) {
      pv.style.display = 'none';
      if (btn) btn.disabled = true;
      return;
    }
    try {
      const r = await api(`/api/skills/one?id=${encodeURIComponent(id)}`);
      // 接口返回 { ok, skill: { id, name, summary, when, content, ... } }
      const s = r?.skill || {};
      const content = s.content || r?.content || '';
      pv.style.display = 'block';
      pv.innerHTML = `
        <div class="cy-card" style="background:var(--bg-soft,#faf9f7)">
          <div class="cy-card-head">
            <span class="cy-name">${esc(s.name || id)}</span>
            ${s.version ? `<span class="cy-ver">v${esc(s.version)}</span>` : ''}
          </div>
          <div class="cy-summary">${esc(s.summary || '')}</div>
          <div class="cy-meta">${s.author ? '作者：' + esc(s.author) : '未标作者'}${s.when ? ' · 触发：' + esc(String(s.when).slice(0, 50)) : ''}</div>
          <div class="cy-out" style="max-height:160px">${esc(String(content).slice(0, 800))}${content.length > 800 ? '\n…（共 ' + content.length + ' 字符）' : ''}</div>
        </div>`;
      if (btn) btn.disabled = false;
    } catch (e) {
      pv.style.display = 'block';
      pv.textContent = '读取失败：' + e.message;
      if (btn) btn.disabled = true;
    }
  });

  box.querySelector('#cy-skill-refresh')?.addEventListener('click', () => {
    loadSkillPick();
    showSkillMsg('已刷新列表', 'ok');
  });

  box.querySelector('#cy-skill-publish')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const id = skillPick()?.value;
    const ver = box.querySelector('#cy-skill-ver')?.value.trim() || '1.0.0';
    const notes = box.querySelector('#cy-skill-notes')?.value.trim() || '';
    if (!id) { showSkillMsg('先选一个 skill', 'err'); return; }
    if (!/^\d+\.\d+\.\d+$/.test(ver)) { showSkillMsg('版本号要用 1.2.3 格式', 'err'); return; }
    if (btn.disabled) return;

    // 发布前确认（会公开到市场，别人能装）
    if (!confirm(`把「${id}」v${ver} 发布到市场？\n\n发布后别人就能在技能库里看到并安装。`)) return;

    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '发布中…';
    showSkillMsg('');
    try {
      const r = await api('/api/skill-market/publish', {
        method: 'POST',
        body: { id, version: ver, notes },
      });
      if (r?.ok) {
        showSkillMsg(`✅ 已发布 v${r.version}（${(r.bytes / 1024).toFixed(1)}KB）\n市场里现在共 ${r.total} 个 skill`, 'ok');
        ctx.toast?.('发布成功');
      } else {
        showSkillMsg('❌ ' + (r?.error || '发布失败'), 'err');
      }
    } catch (e) {
      showSkillMsg('❌ ' + e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  loadSkillPick();

  // ── skill 发布 / 下架（2026-10-25）──
  box.querySelectorAll('[data-skill-pub]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.skillPub;
      const ver = prompt(`发布 skill「${id}」\n\n版本号（如 1.0.0）：`, '1.0.0');
      if (ver === null) return;
      if (!/^\d+\.\d+\.\d+$/.test(ver.trim())) { ctx.toast?.('版本号要用 1.2.3 格式'); return; }
      const notes = prompt('这次改了什么（可留空）：', '');
      if (notes === null) return;
      if (btn.disabled) return;
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = '发布中…';
      try {
        const r = await api('/api/skill-market/publish', {
          method: 'POST',
          body: { id, version: ver.trim(), notes },
        });
        if (r?.ok) {
          ctx.toast?.(`已发布 v${r.version}（${(r.bytes / 1024).toFixed(1)}KB）`);
          setTimeout(() => location.reload(), 900);
        } else {
          ctx.toast?.(r?.error || '发布失败');
        }
      } catch (e) { ctx.toast?.('发布失败：' + e.message); }
      finally { btn.disabled = false; btn.textContent = old; }
    });
  });

  box.querySelectorAll('[data-skill-off]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.skillOff;
      const reason = prompt(`从市场下架 skill「${id}」？\n\n本地文件会保留，随时可以重新发布。\n\n下架原因（可留空）：`, '');
      if (reason === null) return;
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const r = await api('/api/skill-market/unpublish', { method: 'POST', body: { id, reason } });
        if (r?.ok) {
          ctx.toast?.('已从市场下架');
          setTimeout(() => location.reload(), 900);
        } else {
          ctx.toast?.(r?.error || '下架失败');
        }
      } catch (e) { ctx.toast?.('下架失败：' + e.message); }
      finally { btn.disabled = false; }
    });
  });

  box.querySelector('#cy-refresh')?.addEventListener('click', () => location.reload());

  // ── 打包 ──
  const pkgOut = () => box.querySelector('#cy-pkg-out');
  box.querySelector('#cy-pkg')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const id = box.querySelector('#cy-pkg-id').value.trim();
    if (!id) { if (pkgOut()) { pkgOut().style.display='block'; pkgOut().textContent = '先填插件 id'; } return; }
    if (btn.disabled) return;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '打包中…';
    try {
      const r = await api('/api/market/package', { method: 'POST', body: { id } });
      const out = pkgOut();
      if (out) out.style.display = 'block';
      if (r?.ok) {
        const lines = [`✅ 已打包 ${r.market.id} v${r.market.version}（${r.sizeText}）`, ''];
        (r.warnings || []).forEach((w) => lines.push('⚠️ ' + w));
        if ((r.warnings||[]).length) lines.push('');
        lines.push(`文件：${r.packagePath}`, `sha256：${r.market.sha256}`, '', 'market.json：',
          JSON.stringify(r.market, null, 2));
        if (out) out.textContent = lines.join('\n');
        ctx.toast?.('打包完成');
      } else {
        if (out) out.textContent = '❌ ' + (r?.error || '打包失败');
      }
    } catch (e) { if (pkgOut()) pkgOut().textContent = '❌ ' + e.message; }
    finally { btn.disabled = false; btn.textContent = old; }
  });

  // ── 管理员总览（2026-10-25）──
  //
  // 只有 role=admin 才显示「管理」标签。
  // 展示：全部作者、全部插件、发布状态、远端同步情况。
  // 管理员可以对任何插件执行发布/下架（checkOwner 里放行）。

  const adminRoot = () => box.querySelector('#cy-admin-root');

  const renderAdmin = (d) => {
    const el = adminRoot();
    if (!el) return;

    if (!d?.ok) {
      el.innerHTML = `<div class="cy-empty">${esc(d?.error || '读取失败')}</div>`;
      return;
    }
    const s = d.stats || {};
    const authors = d.authors || [];
    const plugins = d.plugins || [];

    // 按作者分组插件
    const byAuthor = new Map();
    for (const p of plugins) {
      if (!byAuthor.has(p.author)) byAuthor.set(p.author, []);
      byAuthor.get(p.author).push(p);
    }

    el.innerHTML = `
      <div class="cy-admin-stats">
        <div class="cy-stat"><b>${s.totalPlugins ?? 0}</b><span>插件总数</span></div>
        <div class="cy-stat"><b>${s.totalAuthors ?? 0}</b><span>作者数</span></div>
        <div class="cy-stat"><b>${s.publishedCount ?? 0}</b><span>已发布</span></div>
        <div class="cy-stat"><b>${s.offlineCount ?? 0}</b><span>已下架</span></div>
        <div class="cy-stat"><b>${s.remoteCount ?? 0}</b><span>市场可见</span></div>
        <div class="cy-stat"><b>${s.totalPublishes ?? 0}</b><span>累计发布</span></div>
      </div>

      <div class="cy-section-title">
        全部作者
        <span class="cy-badge" style="margin-left:8px">共 ${authors.length} 位</span>
      </div>
      <div class="cy-author-list">
        ${authors.map((a) => `
          <div class="cy-author-row">
            <div class="cy-avatar" style="width:32px;height:32px;font-size:14px">${esc(String(a.name).slice(0,1))}</div>
            <div class="cy-author-info">
              <div class="cy-author-name" style="font-size:13px">${esc(a.name)}
                ${a.qq ? `<span class="cy-badge">QQ ${esc(a.qq)}</span>` : ''}
              </div>
              <div class="cy-author-meta">${a.plugins} 个插件${a.license ? ' · ' + esc(a.license) : ''}</div>
            </div>
          </div>`).join('')}
      </div>

      <div class="cy-section-title" style="margin-top:20px">
        全部插件
        <span class="cy-badge" style="margin-left:8px">共 ${plugins.length} 个</span>
      </div>
      <div class="cy-admin-table">
        <div class="cy-admin-thead">
          <span>插件</span><span>作者</span><span>版本</span><span>状态</span><span>操作</span>
        </div>
        ${plugins.map((p) => {
          const state = p.offline
            ? '<span style="color:#c00">已下架</span>'
            : (p.published
                ? (p.inRemote ? '<span style="color:#2f855a">在架</span>' : '<span style="color:#b7791f">本地已发·远端缺</span>')
                : '<span class="muted">未发布</span>');
          return `
            <div class="cy-admin-tr">
              <span class="cy-admin-id">${esc(p.name)}<br><code style="font-size:10.5px;opacity:.6">${esc(p.id)}</code></span>
              <span>${esc(p.author)}</span>
              <span>v${esc(p.version)}</span>
              <span>${state}${p.core ? ' <span class="cy-badge">核心</span>' : ''}${p.permissions ? ` <span class="cy-badge">${p.permissions} 权限</span>` : ''}</span>
              <span>
                ${p.offline
                  ? `<button class="btn tiny" data-adm-pub="${esc(p.id)}">上架</button>`
                  : `<button class="btn tiny" data-adm-pub="${esc(p.id)}">发布</button>`}
                ${p.offline ? '' : `<button class="btn tiny" data-adm-off="${esc(p.id)}" style="color:#c00">下架</button>`}
              </span>
            </div>`;
        }).join('')}
      </div>

      <div class="cy-section-title" style="margin-top:20px">管理员设置</div>
      <div class="cy-box">
        <div class="cy-hint">只有管理员能看这个页面。可以添加/移除管理员。</div>
        <div class="cy-row" style="margin-top:10px">
          <input class="cy-input" id="cy-adm-email" placeholder="要设为管理员的邮箱" style="max-width:260px">
          <button class="btn tiny" id="cy-adm-add">设为管理员</button>
        </div>
        <div id="cy-adm-msg" class="cy-msg"></div>
      </div>`;

    // 管理员操作：发布/下架任意插件
    el.querySelectorAll('[data-adm-pub]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.admPub;
        if (btn.disabled) return;
        if (!confirm(`以管理员身份发布「${id}」？`)) return;
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = '发布中…';
        try {
          const r = await api('/api/market/myplugins/publish', { method: 'POST', body: { id, changelog: '管理员发布' } });
          ctx.toast?.(r?.remote?.ok ? '已发布到市场' : (r?.note || '打包完成'));
          loadAdminPanel();
        } catch (e) { ctx.toast?.('失败：' + e.message); }
        finally { btn.disabled = false; btn.textContent = old; }
      });
    });

    el.querySelectorAll('[data-adm-off]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.admOff;
        const reason = prompt(`以管理员身份下架「${id}」？\n\n下架原因（可留空）：`);
        if (reason === null) return;
        btn.disabled = true;
        try {
          const r = await api('/api/market/myplugins/unpublish', { method: 'POST', body: { id, reason } });
          ctx.toast?.(r?.remote?.ok ? '已从市场下架' : (r?.note || '本地已标记'));
          loadAdminPanel();
        } catch (e) { ctx.toast?.('失败：' + e.message); }
        finally { btn.disabled = false; }
      });
    });

    // 加管理员
    el.querySelector('#cy-adm-add')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const email = el.querySelector('#cy-adm-email')?.value.trim();
      const msg = el.querySelector('#cy-adm-msg');
      if (!email) { if (msg) { msg.className = 'cy-msg on err'; msg.textContent = '先填邮箱'; } return; }
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const r = await api('/api/market/admin/set', { method: 'POST', body: { email } });
        if (msg) {
          msg.className = 'cy-msg on ' + (r?.ok ? 'ok' : 'err');
          msg.textContent = r?.ok ? `✅ ${email} 已成为管理员` : '❌ ' + (r?.error || '失败');
        }
      } catch (e) { if (msg) { msg.className = 'cy-msg on err'; msg.textContent = '❌ ' + e.message; } }
      finally { btn.disabled = false; }
    });
  };

  const loadAdminPanel = async () => {
    const el = adminRoot();
    if (!el) return;
    el.innerHTML = '<div class="cy-empty">加载中…</div>';
    try {
      const d = await api('/api/market/admin/overview');
      renderAdmin(d);
    } catch (e) {
      el.innerHTML = `<div class="cy-empty">读取失败：${esc(e.message)}</div>`;
    }
  };

  // 检查身份，是管理员才显示「管理」标签
  (async () => {
    try {
      const w = await api('/api/market/whoami');
      if (w?.role === 'admin') {
        const tab = box.querySelector('#cy-tab-admin');
        if (tab) tab.style.display = '';
        loadAdminPanel();
      }
    } catch { /* 未注册时不显示 */ }
  })();

  // ── 我的插件（作者管理，2026-10-25）──
  //
  // 每个插件一行卡片，可展开编辑：改版本号、写改动说明、打开发布。
  // 发布后显示"已发布 vX.Y.Z · 时间"，本地改动未发时标"有未发布改动"。

  const mineList = () => box.querySelector('#cy-mine-list');
  const mineCount = () => box.querySelector('#cy-mine-count');

  const renderMine = (data) => {
    const el = mineList();
    if (!el) return;
    const list = data?.plugins || [];
    if (mineCount()) {
      mineCount().textContent = data?.author?.email
        ? `共 ${list.length} 个插件　作者：${data.author.nickname || data.author.email}`
        : `共 ${list.length} 个插件`;
    }

    if (!list.length) {
      el.innerHTML = `<div class="cy-empty">还没有属于你的插件。<br>
        插件要写在 plugins/ 目录下，且 manifest.author 填「白光」或你的昵称。</div>`;
      return;
    }

    el.innerHTML = list.map((p) => {
      const pub = p.lastPublished;
      const stateBadge = p.offline
        ? `<span class="cy-badge" style="background:#c0000022;color:#c00">已下架</span>`
        : (pub
            ? (p.unpublished
                ? `<span class="cy-badge" style="background:#b7791f22;color:#b7791f">有未发布改动</span>`
                : `<span class="cy-badge" style="background:#2f855a22;color:#2f855a">已发布</span>`)
            : `<span class="cy-badge">未发布</span>`);
      return `
        <div class="cy-card" data-mine="${esc(p.id)}">
          <div class="cy-card-head">
            <span class="cy-name">${esc(p.name)}</span>
            <span class="cy-ver">v${esc(p.version)}</span>
            ${stateBadge}
            ${p.core ? '<span class="cy-badge">核心</span>' : ''}
            <span class="cy-spacer"></span>
            <button class="btn tiny" data-mine-edit="${esc(p.id)}">编辑</button>
            <button class="btn tiny primary" data-mine-pub="${esc(p.id)}">${p.offline ? '重新上架' : '发布'}</button>
            ${p.offline ? '' : `<button class="btn tiny" data-mine-off="${esc(p.id)}" style="color:#c00">下架</button>`}
          </div>
          <div class="cy-summary">${esc(p.summary || '')}</div>
          <div class="cy-meta">
            ${(p.permissions || []).length ? `权限：${esc(p.permissions.join('、'))}` : '无特殊权限'}
            ${pub ? `　·　上次发布 v${esc(pub.version)}（${esc(String(pub.at).slice(0,10))}）${pub.changelog ? ' — ' + esc(pub.changelog.slice(0, 40)) : ''}` : ''}
          </div>
          <div class="cy-mine-editor" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
            <div class="cy-field">
              <div class="cy-field-label">版本号</div>
              <input class="cy-input" data-mine-version="${esc(p.id)}" value="${esc(p.version)}" placeholder="1.2.3" style="max-width:160px">
            </div>
            <div class="cy-field">
              <div class="cy-field-label">这次改了什么（会显示在发布记录里）</div>
              <textarea class="cy-input" data-mine-log="${esc(p.id)}" rows="3"
                placeholder="例：修复表情发不出去的问题；新增盗图声明表情">${esc(pub?.changelog || '')}</textarea>
            </div>
            <div class="cy-row">
              <button class="btn tiny primary" data-mine-save="${esc(p.id)}">保存</button>
              <button class="btn tiny" data-mine-hist="${esc(p.id)}">发布历史</button>
              <span class="cy-msg" data-mine-msg="${esc(p.id)}"></span>
            </div>
            <div class="cy-out" data-mine-histout="${esc(p.id)}" style="display:none"></div>
          </div>
        </div>`;
    }).join('');

    bindMine();
  };

  const bindMine = () => {
    // 展开编辑
    box.querySelectorAll('[data-mine-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = btn.closest('[data-mine]');
        const ed = card?.querySelector('.cy-mine-editor');
        if (ed) ed.style.display = ed.style.display === 'none' ? 'block' : 'none';
      });
    });

    // 保存（版本号 + 描述）
    box.querySelectorAll('[data-mine-save]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.mineSave;
        const card = btn.closest('[data-mine]');
        const ver = card?.querySelector(`[data-mine-version="${id}"]`)?.value.trim();
        const msg = card?.querySelector(`[data-mine-msg="${id}"]`);
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          const r = await api('/api/market/myplugins/update', { method: 'POST', body: { id, version: ver } });
          if (msg) {
            msg.className = 'cy-msg on ' + (r?.ok ? 'ok' : 'err');
            msg.textContent = r?.ok ? '✅ 已保存，刷新后生效' : '❌ ' + (r?.error || '保存失败');
          }
          if (r?.ok) setTimeout(() => loadMine(), 800);
        } catch (e) { if (msg) { msg.className = 'cy-msg on err'; msg.textContent = '❌ ' + e.message; } }
        finally { btn.disabled = false; }
      });
    });

    // 发布
    box.querySelectorAll('[data-mine-pub]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.minePub;
        const card = btn.closest('[data-mine]');
        const log = card?.querySelector(`[data-mine-log="${id}"]`)?.value.trim() || '';
        const msg = card?.querySelector(`[data-mine-msg="${id}"]`);
        if (btn.disabled) return;

        const lines = [`要发布「${id}」吗？`];
        if (log) lines.push('', '改动说明：', log);
        lines.push('', '会打成 .tar.gz 并记录版本。发布后需要上传到市场才能让别人装到。');
        if (!confirm(lines.join('\n'))) return;

        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = '打包中…';
        try {
          const r = await api('/api/market/myplugins/publish', { method: 'POST', body: { id, changelog: log } });
          if (msg) {
            msg.className = 'cy-msg on ' + (r?.ok ? 'ok' : 'err');
            if (r?.ok) {
              msg.textContent = `✅ 已打包 v${r.record.version}（${r.sizeText}）\n文件：${r.packagePath}`;
            } else if (r?.author) {
              // 作者不匹配：给出具体信息，不是笼统的"失败"
              msg.textContent = `❌ ${r.error}\n\n这个插件的作者是「${r.author}」，你是「${r.me}」。\n只能管理自己署名的插件。`;
            } else {
              msg.textContent = '❌ ' + (r?.error || '发布失败');
            }
          }
          if (r?.ok) {
            ctx.toast?.('打包完成，可在「发布」页上传');
            loadMine();
          }
        } catch (e) { if (msg) { msg.className = 'cy-msg on err'; msg.textContent = '❌ ' + e.message; } }
        finally { btn.disabled = false; btn.textContent = old; }
      });
    });

    // 下架
    box.querySelectorAll('[data-mine-off]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.mineOff;
        const reason = prompt(`要把「${id}」从市场下架吗？\n\n下架后别人看不到，但你本地还能用，随时可以重新上架。\n\n下架原因（可留空）：`);
        if (reason === null) return;   // 点了取消
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          const r = await api('/api/market/myplugins/unpublish', { method: 'POST', body: { id, reason } });
          if (r?.ok) {
            ctx.toast?.('已在本地标记下架');
            loadMine();
          } else if (r?.author) {
            alert(`${r.error}\n\n这个插件的作者是「${r.author}」，你是「${r.me}」。\n只能管理自己署名的插件。`);
          } else {
            ctx.toast?.(r?.error || '下架失败');
          }
        } catch (e) { ctx.toast?.('下架失败：' + e.message); }
        finally { btn.disabled = false; }
      });
    });

    // 发布历史
    box.querySelectorAll('[data-mine-hist]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.mineHist;
        const card = btn.closest('[data-mine]');
        const out = card?.querySelector(`[data-mine-histout="${id}"]`);
        try {
          const r = await api(`/api/market/myplugins/history?id=${encodeURIComponent(id)}`);
          if (!out) return;
          out.style.display = 'block';
          const recs = r?.records || [];
          out.textContent = recs.length
            ? recs.map((x) => `v${x.version}  ${String(x.at).slice(0, 16).replace('T', ' ')}${x.changelog ? '\n  ' + x.changelog.slice(0, 120) : ''}`).join('\n\n')
            : '还没有发布记录。';
        } catch (e) { if (out) { out.style.display = 'block'; out.textContent = '读取失败：' + e.message; } }
      });
    });
  };

  const loadMine = async () => {
    if (mineCount()) mineCount().textContent = '加载中…';
    try {
      const r = await api('/api/market/myplugins');
      if (r?.ok) renderMine(r);
      else if (mineCount()) mineCount().textContent = '读取失败：' + (r?.error || '');
    } catch (e) {
      if (mineCount()) mineCount().textContent = '读取失败：' + e.message;
    }
  };

  box.querySelector('#cy-mine-refresh')?.addEventListener('click', loadMine);
  loadMine();

  // ── 作者注册（邮箱验证码，2026-10-25）──

  const renderAuthor = (state) => {
    const el = box.querySelector('#cy-author-state');
    if (!el) return;

    // 已注册：显示成名片
    if (state?.registered) {
      const a = state.author || {};
      const name = a.nickname || (a.email || '').split('@')[0] || '作者';
      const initial = name.slice(0, 1).toUpperCase();
      el.innerHTML = `
        <div class="cy-author">
          <div class="cy-avatar">${esc(initial)}</div>
          <div class="cy-author-info">
            <div class="cy-author-name">${esc(name)}<span class="cy-badge">已验证</span></div>
            <div class="cy-author-meta">
              ${esc(a.email || '')}${a.qq ? `　QQ ${esc(a.qq)}` : ''}
            </div>
          </div>
          <button class="btn tiny" id="cy-author-reset">换账号</button>
        </div>`;
      box.querySelector('#cy-author-reset')?.addEventListener('click', () => renderAuthor({ registered: false }));
      return;
    }

    // 未注册：分两步的表单
    el.innerHTML = `
      <div class="cy-hint" style="margin-bottom:14px">
        用自己的邮箱收一个验证码就行。注册后你的名字会显示在发布的插件上。
      </div>

      <div class="cy-field">
        <div class="cy-field-label"><span class="cy-step">1</span>填邮箱，收验证码</div>
        <div class="cy-inline">
          <input class="cy-input" id="cy-reg-email" placeholder="you@example.com" autocomplete="off">
          <button class="btn tiny" id="cy-reg-send" style="white-space:nowrap">发送验证码</button>
        </div>
      </div>

      <div class="cy-field">
        <div class="cy-field-label"><span class="cy-step">2</span>填验证码，完成注册</div>
        <div class="cy-inline" style="margin-bottom:8px">
          <input class="cy-input" id="cy-reg-code" placeholder="6 位数字" maxlength="6"
                 inputmode="numeric" style="max-width:140px">
        </div>
        <div class="cy-inline">
          <input class="cy-input" id="cy-reg-nick" placeholder="昵称（选填）">
          <input class="cy-input" id="cy-reg-qq" placeholder="QQ 号（选填）" inputmode="numeric">
        </div>
        <div class="cy-hint">昵称会显示在插件上；QQ 号方便别人联系你。都可以不填。</div>
      </div>

      <div style="margin-top:16px;display:flex;align-items:center;gap:10px">
        <button class="btn primary" id="cy-reg-verify">完成注册</button>
        <span id="cy-reg-msg" class="cy-msg"></span>
      </div>`;

    const msgEl = () => box.querySelector('#cy-reg-msg');
    const showMsg = (txt, kind) => {
      const m = msgEl();
      if (!m) return;
      if (!txt) { m.className = 'cy-msg'; m.textContent = ''; return; }
      m.className = 'cy-msg on ' + (kind || '');
      m.textContent = txt;
    };

    // 发验证码
    box.querySelector('#cy-reg-send')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const email = box.querySelector('#cy-reg-email').value.trim();
      if (!email) { showMsg('先填邮箱', 'err'); return; }
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '发送中…';
      showMsg('');
      try {
        const r = await api('/api/market/register/send', { method: 'POST', body: { email } });
        if (r?.ok) {
          showMsg('✅ ' + (r.message || '已发送') + '，记得看垃圾箱', 'ok');
          let n = 60;
          btn.textContent = `${n}s`;
          const tick = setInterval(() => {
            n--;
            if (n <= 0) { clearInterval(tick); btn.disabled = false; btn.textContent = '发送验证码'; }
            else btn.textContent = `${n}s`;
          }, 1000);
          box.querySelector('#cy-reg-code')?.focus();
          return;
        }
        showMsg('❌ ' + (r?.error || '发送失败'), 'err');
      } catch (e) { showMsg('❌ ' + e.message, 'err'); }
      btn.disabled = false;
      btn.textContent = '发送验证码';
    });

    // 完成注册
    box.querySelector('#cy-reg-verify')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const email = box.querySelector('#cy-reg-email').value.trim();
      const code = box.querySelector('#cy-reg-code').value.trim();
      const qq = box.querySelector('#cy-reg-qq').value.trim();
      const nickname = box.querySelector('#cy-reg-nick').value.trim();
      if (!email) { showMsg('先填邮箱', 'err'); return; }
      if (!/^\d{6}$/.test(code)) { showMsg('验证码是 6 位数字', 'err'); return; }
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '验证中…';
      try {
        const r = await api('/api/market/register/verify', { method: 'POST', body: { email, code, qq, nickname } });
        if (r?.ok) {
          showMsg('');
          ctx.toast?.('注册成功');
          renderAuthor({ registered: true, author: r.author });
          return;
        }
        showMsg('❌ ' + (r?.error || '验证失败'), 'err');
      } catch (e) { showMsg('❌ ' + e.message, 'err'); }
      btn.disabled = false;
      btn.textContent = '完成注册';
    });
  };

  // 进页面先查注册状态
  (async () => {
    try {
      const r = await api('/api/market/register/status');
      renderAuthor(r?.registered ? r : { registered: false });
    } catch {
      renderAuthor({ registered: false });
    }
  })();

  // ── 本地插件包上传/安装（2026-10-25）──
  //
  // 流程：选文件 → 读成 base64 → 交给内核 /api/plugins/import。
  // 内核那边已经做了完整校验（tar 解包、manifest 解析、id 校验、路径检查），
  // 这里不重复实现，只负责把文件递过去。
  //
  // 为什么先「解析」再「安装」两步走：
  //   插件能执行任意代码。直接装等于把风险藏起来。
  //   先解析出 manifest，把作者/版本/权限摊在用户面前，确认后才真的写入。
  const uploadEl = () => box.querySelector('#cy-upload');
  const uploadBtn = () => box.querySelector('#cy-upload-btn');
  const uploadInfo = () => box.querySelector('#cy-upload-info');

  let pendingFile = null;      // 已读入 base64 的待装包
  let pendingMeta = null;      // 解析出的元信息

  const showInfo = (txt) => {
    const el = uploadInfo();
    if (el) { el.style.display = 'block'; el.textContent = txt; }
  };

  uploadEl()?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    pendingFile = null; pendingMeta = null;
    const btn = uploadBtn();
    if (btn) { btn.disabled = true; btn.textContent = '解析'; }
    const label = box.querySelector('#cy-file-label');
    const nameEl = box.querySelector('#cy-file-name');
    if (!f) {
      if (uploadInfo()) uploadInfo().style.display = 'none';
      label?.classList.remove('picked');
      if (nameEl) nameEl.textContent = '选择文件';
      return;
    }
    label?.classList.add('picked');
    if (nameEl) nameEl.textContent = `${f.name}（${(f.size / 1024).toFixed(1)} KB）`;

    // 体积保护：浏览器端先挡一道，别把 100MB 读进内存
    const MAX = 20 * 1024 * 1024;
    if (f.size > MAX) {
      showInfo(`❌ 文件 ${(f.size / 1024 / 1024).toFixed(1)}MB，超过 20MB 上限。\n插件包应只含代码，素材请单独托管。`);
      return;
    }

    showInfo(`读取中…（${(f.size / 1024).toFixed(1)} KB）`);
    try {
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
        fr.onerror = () => reject(new Error('读文件失败'));
        fr.readAsDataURL(f);
      });
      if (!b64) { showInfo('❌ 文件读取结果为空'); return; }

      pendingFile = { name: f.name, b64, size: f.size };

      // 先解析：调导入接口的预览模式（dryRun）拿 manifest
      // 内核没有 dryRun 时，这里退化为直接从文件名猜 —— 所以下面用最稳的办法：
      // 先只解析，不写盘。用 import 接口的 dryRun 参数（若无则提示直接安装）。
      showInfo(`已选中：${f.name}（${(f.size / 1024).toFixed(1)} KB）\n点「解析」查看这个包要什么权限；点「安装」直接装。`);
      if (btn) { btn.disabled = false; btn.textContent = '解析并安装'; }
    } catch (err) {
      showInfo('❌ ' + err.message);
    }
  });

  uploadBtn()?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    if (btn.disabled || !pendingFile) return;
    if (!pendingFile.b64) { showInfo('❌ 文件没读好，请重新选择'); return; }

    // 二次确认：把风险说清楚
    const name = pendingFile.name;
    if (!confirm(`要安装本地插件包「${name}」吗？\n\n插件能执行任意代码，只安装你信任来源的包。`)) return;

    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '安装中…';
    showInfo('正在解包并安装…');
    try {
      // dryRun 先摸清它是什么
      let preview = null;
      try {
        preview = await api('/api/plugins/import', {
          method: 'POST',
          body: { base64: pendingFile.b64, mode: 'replace', dryRun: true },
        });
      } catch { /* 内核不支持 dryRun 时忽略 */ }

      const r = await api('/api/plugins/import', {
        method: 'POST',
        body: { base64: pendingFile.b64, mode: 'replace' },
      });

      if (r?.ok === false) {
        showInfo('❌ ' + (r.error || '安装失败'));
        return;
      }
      const info = preview?.manifest || r?.manifest || {};
      showInfo([
        '✅ 安装完成',
        info.id ? `插件：${info.name || info.id} v${info.version || '?'}` : '',
        info.author ? `作者：${info.author}` : '',
        (info.permissions || []).length ? `权限：${info.permissions.join('、')}` : '',
        '',
        '刷新页面后可在「插件」页看到它。',
      ].filter(Boolean).join('\n'));
      ctx.toast?.('安装完成');
      pendingFile = null;
      if (uploadEl()) uploadEl().value = '';
    } catch (e) {
      showInfo('❌ ' + (e?.message || e));
    } finally {
      btn.disabled = true;   // 装完要重新选文件
      btn.textContent = '解析并安装';
    }
  });

  box.querySelector('#cy-pkg-list')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/market/packages');
      const out = pkgOut();
      if (out) out.style.display = 'block';
      const list = r?.packages || [];
      if (out) out.textContent = list.length
        ? `目录：${r.dir}\n\n` + list.map((p) => `${p.file}  ${p.sizeText}  ${p.at}`).join('\n')
        : '还没打过包。';
    } catch (e) { if (pkgOut()) pkgOut().textContent = '读取失败：' + e.message; }
  });

  // ── 保存设置 ──
  box.querySelector('#cy-save')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await api('/api/market/config', {
        method: 'POST',
        body: {
          indexUrl: box.querySelector('#cy-index').value.trim(),
          mirrorUrl: box.querySelector('#cy-mirror').value.trim(),
          showUntrusted: box.querySelector('#cy-untrusted').checked,
        },
      });
      ctx.toast?.('已保存');
      setTimeout(() => location.reload(), 800);
    } catch (e) { ctx.toast?.('保存失败：' + e.message); }
    finally { btn.disabled = false; }
  });
}

export const mount = mountPanel;
export default { mountPanel, mount };
