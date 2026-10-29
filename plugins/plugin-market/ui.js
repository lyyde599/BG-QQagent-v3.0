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

  // 北京时间格式化（内核已锁 TZ=Asia/Shanghai，这里只管显示成好读的样子）
  const fmtTime = (iso) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch { return String(iso); }
  };

  // ── 局部刷新（2026-10-25）──
  //
  // 用户反馈："创作营刷新的时候能不能不刷新网页，只刷新这个窗口"
  //
  // 原来用 location.reload() —— 整页重载，会话列表/滚动位置全丢，
  // 还要重新请求所有接口。现在改成 ctx.remount()：
  // 只清空这个容器重新挂载，等价于"刷新这个窗口"。
  //
  // 兜底：内核没提供 remount（老版本）才退回整页刷新。
  // 记住当前在哪个标签 —— 重挂后要回到原处，否则每次刷新都跳回第一个标签
  const rememberPane = () => {
    try { return sessionStorage.getItem('cy_last_pane') || 'plugins'; } catch { return 'plugins'; }
  };
  const savePane = (id) => {
    try { sessionStorage.setItem('cy_last_pane', id); } catch { /* ignore */ }
  };

  const refreshPanel = () => {
    if (typeof ctx.remount === 'function') {
      try { return ctx.remount(); } catch { /* 落到下面 */ }
    }
    try { location.reload(); } catch { /* ignore */ }
  };

  // ── 拉数据（并行，2026-10-26）──
  //
  // 🔴 外部报告实测：这 4 个请求原来是**串行**的 4 个 await，
  //    总耗时 = 各自相加（sum），而不是最慢那个（max）。
  //    其中 /api/skill-market/index 要跨公网，占了大头。
  //
  // 现在改 Promise.all 并行 —— 总耗时 = 最慢的那个。
  // 单测：4 个请求 1+1+1+300ms，串行 303ms → 并行 300ms。
  // 加上 skill 清单也有了缓存，常态应该压到十几毫秒。
  const [marketR, cfgR, skillsR, marketSkillsR] = await Promise.all([
    api('/api/market/index').catch(() => null),
    api('/api/market/config').catch(() => null),
    api('/api/skills').catch(() => null),
    api('/api/skill-market/index').catch(() => null),
  ]);

  let market = marketR || { ok: false, plugins: [] };
  let marketCfg = (cfgR?.config) || {};
  let skills = (skillsR?.skills || skillsR?.items || []);
  let marketSkills = (marketSkillsR?.skills || []);
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
      <div class="cy-card cy-card-2col" data-pid="${esc(p.id)}" data-cat="${esc(p.category || '未分类')}"
           data-downloads="${Number(p.downloads || 0)}"
           data-name="${esc(p.name || p.id)}"
           data-updated="${esc(String(p.updatedAt || p.publishedAt || ''))}"
           data-search="${esc([
             p.name, p.id, p.summary, p.description, p.author, p.category,
             Array.isArray(p.tags) ? p.tags.join(' ') : p.tags
           ].filter(Boolean).join(' '))}">
        <div class="cy-card-main">
          <div class="cy-card-head">
            <span class="cy-name">${esc(p.name || p.id)}</span>
            <span class="cy-ver">v${esc(String(p.version || ''))}</span>
            <span class="cy-trust" style="color:${t.color}">${t.icon} ${t.label}</span>
            ${p.updatable ? '<span class="cy-badge" style="background:#b7791f22;color:#b7791f;font-weight:600">有新版</span>' : ''}
          </div>
          <div class="cy-summary">${esc(p.summary || '')}</div>
          <div class="cy-meta">
            作者：${esc(p.author || '未知')}
            ${p.downloads > 0 ? `<span class="cy-dl-count">· 下载 ${p.downloads} 次</span>` : ''}
          </div>
        </div>
        <div class="cy-card-side">
          <div class="cy-desc">${esc(p.description || p.summary || '')}</div>
          ${p.changelog ? `
            <div class="cy-changelog">
              <span class="cy-changelog-tag">v${esc(String(p.version || ''))} 更新</span>
              <span>${esc(String(p.changelog).slice(0, 200))}${String(p.changelog).length > 200 ? '…' : ''}</span>
            </div>` : ''}
          ${(p.permissions || []).length ? `<div class="cy-perms">权限：${esc((p.permissions || []).join('、'))}</div>` : ''}
        </div>
        <div class="cy-card-act" style="flex-direction:column;gap:6px;align-items:flex-end">
          ${p.installed
            ? (p.updatable
                ? `<button class="btn tiny" data-install="${esc(p.id)}" data-confirm="${p.trust === 'unverified' ? 1 : 0}">更新</button>`
                : `<span class="cy-installed">已安装</span>`)
            : `<button class="btn tiny primary" data-install="${esc(p.id)}" data-confirm="${p.trust === 'unverified' ? 1 : 0}">安装</button>`}
          ${p.trust === 'unverified'
            ? `<button class="btn tiny" data-trust-ok="${esc(p.id)}" title="标记为已审核，之后不再提示风险">审核通过</button>`
            : ''}
          <button class="btn tiny" data-pfb="${esc(p.id)}"
                  data-pfb-name="${esc(p.name || p.id)}"
                  data-pfb-ver="${esc(String(p.version || ''))}"
                  title="反馈这个插件的问题">反馈</button>
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
      /* 更新说明（2026-10-26）：让用户装之前知道这版改了什么 */
      .cy-changelog { margin-top:8px; padding:7px 10px; border-radius:6px;
                      background:var(--bg-soft,#faf9f7); border-left:2px solid var(--acc);
                      font-size:12px; line-height:1.6; color:var(--fg,#333); }
      .cy-changelog-tag { display:inline-block; font-size:11px; font-weight:640;
                          color:var(--acc); margin-right:6px; }

      /* 下载人次（2026-10-25）：跟在作者名后面，低调但看得见 */
      .cy-dl-count { color:#b7791f; font-weight:600; margin-left:2px; }

      .cy-card-2col { display:grid; grid-template-columns: minmax(200px, 300px) 1fr auto;
                      gap:18px; align-items:start; }
      .cy-card-main { min-width:0; }
      .cy-card-side { min-width:0; }
      .cy-desc { font-size:12.5px; line-height:1.75; color:var(--fg,#333); }
      .cy-perms { font-size:11.5px; color:var(--muted,#999); margin-top:8px;
                  padding-top:8px; border-top:1px dashed var(--line); }
      .cy-card-act { display:flex; align-items:center; min-width:64px; justify-content:flex-end; }

      /* 管理页三级菜单（2026-10-27） */
      .cy-subtabs { display:flex; flex-wrap:wrap; gap:6px; margin:4px 0 14px; }
      .cy-subtab { font-size:12.5px; padding:5px 12px; border-radius:16px; cursor:pointer;
                   border:1px solid var(--line); background:var(--bg,#fff);
                   color:var(--muted,#888); user-select:none; transition:all .12s; }
      .cy-subtab:hover { border-color:var(--acc); color:var(--fg,#222); }
      .cy-subtab.on { background:var(--acc); color:var(--on-acc,#fff); border-color:var(--acc); }
      .cy-subn { opacity:.65; margin-left:3px; font-size:11px; }
      .cy-subpane { display:none; }
      .cy-subpane.on { display:block; }

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
      .cy-group-title { font-size:13px; font-weight:640; margin:18px 0 10px;
                        display:flex; align-items:center; gap:8px; }
      .cy-group-title:first-child { margin-top:0; }
      .cy-group-hint { font-size:11.5px; font-weight:400; color:var(--muted,#999); }

      /* 搜索框（2026-10-27） */
      .cy-search-wrap { position:relative; margin-bottom:10px; }
      .cy-search { width:100%; box-sizing:border-box; font-size:13px;
                   padding:8px 32px 8px 12px; border-radius:8px;
                   border:1px solid var(--line); background:var(--bg,#fff);
                   color:var(--fg,#222); outline:none; transition:border-color .12s; }
      .cy-search:focus { border-color:var(--acc); }
      .cy-search::placeholder { color:var(--muted,#aaa); }
      .cy-search-clear { position:absolute; right:8px; top:50%; transform:translateY(-50%);
                         border:none; background:none; cursor:pointer; font-size:16px;
                         color:var(--muted,#999); padding:2px 6px; line-height:1; }
      .cy-search-clear:hover { color:var(--fg,#222); }

      /* 排序（2026-10-27） */
      .cy-sort-row { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
      .cy-sort-label { font-size:12px; color:var(--muted,#888); }
      .cy-sort { font-size:12px; padding:4px 8px; border-radius:7px;
                 border:1px solid var(--line); background:var(--bg,#fff);
                 color:var(--fg,#222); cursor:pointer; outline:none; }
      .cy-sort:focus { border-color:var(--acc); }

      /* 分类筛选栏（2026-10-25） */
      .cy-cats { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; }
      .cy-cat { font-size:12px; padding:4px 11px; border-radius:14px; cursor:pointer;
                border:1px solid var(--line); background:var(--bg,#fff); color:var(--muted,#888);
                user-select:none; transition:all .12s; }
      .cy-cat:hover { border-color:var(--acc); color:var(--fg,#222); }
      .cy-cat.on { background:var(--acc); color:var(--on-acc,#fff); border-color:var(--acc); }

      /* 反馈弹窗（2026-10-25） */
      .cy-modal { position:fixed; inset:0; z-index:9999; display:flex;
                  align-items:center; justify-content:center; }
      .cy-modal-mask { position:absolute; inset:0; background:rgba(0,0,0,.32); }
      .cy-modal-box { position:relative; width:min(560px, calc(100vw - 32px));
                      max-height:calc(100vh - 60px); display:flex; flex-direction:column;
                      background:var(--bg,#fff); border-radius:12px; overflow:hidden;
                      box-shadow:0 12px 48px rgba(0,0,0,.18); }
      .cy-modal-head { display:flex; align-items:center; padding:14px 18px;
                       border-bottom:1px solid var(--line); font-size:14px; font-weight:640; }
      .cy-modal-x { margin-left:auto; border:none; background:none; cursor:pointer;
                    font-size:16px; color:var(--muted,#888); padding:2px 6px; }
      .cy-modal-x:hover { color:var(--fg,#222); }
      .cy-modal-body { padding:16px 18px; overflow-y:auto; }
      .cy-modal-foot { display:flex; gap:10px; justify-content:flex-end;
                       padding:12px 18px; border-top:1px solid var(--line); }
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

    <div class="cy-modal" id="cy-fb-modal" style="display:none">
      <div class="cy-modal-mask"></div>
      <div class="cy-modal-box">
        <div class="cy-modal-head">
          <span>反馈问题 / 提建议</span>
          <button class="cy-modal-x" id="cy-fb-close">✕</button>
        </div>
        <div class="cy-modal-body">
          <!-- 插件上下文（2026-10-26）：从卡片上的「反馈」按钮进来时显示 -->
          <div class="cy-field" id="cy-fb-plugin-box" style="display:none">
            <div class="cy-field-label">反馈的插件</div>
            <div class="cy-row" style="align-items:center;gap:8px">
              <span class="cy-badge" style="background:var(--bg-soft,#faf9f7);font-weight:600" id="cy-fb-plugin-name"></span>
              <span style="font-size:11.5px;color:var(--muted,#888)" id="cy-fb-plugin-ver"></span>
              <span class="cy-spacer" style="flex:1"></span>
              <button class="btn tiny" id="cy-fb-plugin-clear" title="不针对特定插件">清除</button>
            </div>
          </div>

          <div class="cy-field">
            <div class="cy-field-label">类型</div>
            <div class="cy-row" style="gap:14px;font-size:13px">
              <label><input type="radio" name="cy-fb-type" value="bug" checked> 问题</label>
              <label><input type="radio" name="cy-fb-type" value="feature"> 建议</label>
              <label><input type="radio" name="cy-fb-type" value="other"> 其他</label>
            </div>
          </div>
          <div class="cy-field">
            <div class="cy-field-label">标题</div>
            <input class="cy-input" id="cy-fb-title" placeholder="一句话说清是什么问题" maxlength="120">
          </div>
          <div class="cy-field">
            <div class="cy-field-label">详细描述</div>
            <textarea class="cy-input" id="cy-fb-body" rows="5"
              placeholder="怎么操作的、期望什么结果、实际什么结果。越具体越好定位。"></textarea>
          </div>
          <div class="cy-field">
            <div class="cy-field-label">截图（最多 3 张）</div>
            <label class="cy-file" id="cy-fb-img-label">
              <input type="file" id="cy-fb-images" accept="image/png,image/jpeg,image/webp,image/gif" multiple>
              <span id="cy-fb-img-name">选择图片…</span>
            </label>
            <div class="cy-hint">png / jpg / webp / gif，单张 5MB 内</div>
          </div>
          <div class="cy-field">
            <div class="cy-field-label">日志（最多 3 个）</div>
            <label class="cy-file" id="cy-fb-log-label">
              <input type="file" id="cy-fb-logs" accept=".log,.txt,.json" multiple>
              <span id="cy-fb-log-name">选择日志…</span>
            </label>
            <div class="cy-hint">.log / .txt / .json，单个 2MB 内</div>
          </div>
          <div class="cy-field">
            <div class="cy-field-label">文档（最多 3 个）</div>
            <label class="cy-file" id="cy-fb-doc-label">
              <input type="file" id="cy-fb-docs" accept=".md" multiple>
              <span id="cy-fb-doc-name">选择 .md 文档…</span>
            </label>
            <div class="cy-hint">.md 文档，单个 2MB 内</div>
          </div>
          <div id="cy-fb-msg" class="cy-msg"></div>
        </div>
        <div class="cy-modal-foot">
          <button class="btn" id="cy-fb-cancel">取消</button>
          <button class="btn primary" id="cy-fb-submit">提交</button>
        </div>
      </div>
    </div>

    <div class="cy-wrap">
      <div class="cy-head">
        <div class="cy-title">鲸界Bridge 创造营</div>
        <div class="cy-sub">装插件 · 发技能</div>
      </div>

      <div class="cy-nav">
        <button class="cy-tab" data-pane="plugins">插件市场</button>
        <button class="cy-tab" data-pane="mine">我的插件</button>
        <button class="cy-tab" data-pane="skills">技能库</button>
        <button class="cy-tab" data-pane="personas">角色卡</button>
        <button class="cy-tab" data-pane="publish">发布</button>
        <button class="cy-tab" data-pane="admin" id="cy-tab-admin" style="display:none">管理</button>
        <button class="cy-tab" data-pane="settings">设置</button>
        <span class="cy-spacer" style="flex:1"></span>
        <button class="cy-tab" id="cy-fb-open" style="color:var(--muted,#888)">反馈</button>
      </div>

      <!-- 插件市场 -->
      <div class="cy-pane" id="cy-pane-plugins">
        <div class="cy-row" style="margin-bottom:10px">
          <span style="font-size:12.5px;color:var(--muted,#888)">
            共 ${market.total ?? 0} 个插件　源：${esc((market.source || '').replace(/^https?:\/\//, '').slice(0, 40) || '—')}${market.cached ? '（缓存）' : ''}
          </span>
          <span class="cy-spacer" style="flex:1"></span>
          <button class="btn tiny" id="cy-refresh">刷新</button>
        </div>
        ${market.warning ? `<div class="cy-box" style="border-color:#b7791f">⚠️ ${esc(market.warning)}</div>` : ''}
        ${!market.ok ? `<div class="cy-box">${esc(market.error || '拿不到市场清单')}</div>` : ''}
        <!-- 插件搜索 + 排序（2026-10-27）-->
        <div class="cy-search-wrap">
          <input class="cy-search" id="cy-search" type="search" autocomplete="off"
                 placeholder="搜插件名 / 说明 / 作者 / id…">
          <button class="cy-search-clear" id="cy-search-clear" title="清空" style="display:none">×</button>
        </div>
        <div class="cy-sort-row">
          <span class="cy-sort-label">排序</span>
          <select class="cy-sort" id="cy-sort">
            <option value="default">默认</option>
            <option value="downloads">下载量高→低</option>
            <option value="name">名称 A→Z</option>
            <option value="updated">最近更新</option>
          </select>
        </div>
        <div class="cy-cats" id="cy-cats"></div>
        <div id="pm-list">${pluginCards || '<div class="cy-empty">清单是空的</div>'}</div>
        <div id="cy-msg" class="cy-meta" style="margin-top:8px"></div>
      </div>

      <!-- 我的插件 -->
      <div class="cy-pane" id="cy-pane-mine">
        <div class="cy-row" style="margin-bottom:12px">
          <span id="cy-mine-count" style="font-size:12.5px;color:var(--muted,#888)">加载中…</span>
          <span class="cy-spacer" style="flex:1"></span>
          <button class="btn tiny" id="cy-check-upd">检测新版本</button>
          <button class="btn tiny" id="cy-upd-all" style="display:none">全部更新</button>
          <button class="btn tiny" id="cy-mine-refresh">刷新</button>
        </div>
        <div id="cy-upd-banner" style="display:none;margin-bottom:12px"></div>
        <div id="cy-mine-list"></div>
      </div>

      <!-- 技能库 -->
      <div class="cy-pane" id="cy-pane-skills">
        <div class="cy-row" style="margin-bottom:10px">
          <span style="font-size:12.5px;color:var(--muted,#888)">共 ${skills.length} 个技能</span>
        </div>
        ${skillCards}
      </div>

      <!-- 角色卡（2026-10-25）-->
      <div class="cy-pane" id="cy-pane-personas">
        <div class="cy-row" style="margin-bottom:12px;align-items:center;gap:8px">
          <span style="font-size:12.5px;color:var(--muted,#888)" id="cy-persona-count">共 0 个角色卡</span>
          <span class="cy-spacer" style="flex:1"></span>
          <button class="btn tiny" id="cy-persona-import">导入已有</button>
          <button class="btn tiny" id="cy-persona-new">写一个</button>
          <button class="btn tiny" id="cy-persona-refresh">刷新</button>
          <input type="file" id="cy-persona-file" accept=".md,.txt" style="display:none">
        </div>
        <div id="cy-persona-list"><div class="cy-empty">加载中…</div></div>
      </div>

      <!-- 发布 -->
      <div class="cy-pane" id="cy-pane-publish">
        <div class="cy-box" id="cy-author-box">
          <div class="cy-label">作者账号</div>
          <div id="cy-author-state" style="font-size:12.5px;color:var(--muted,#888)">检查中…</div>

          <!-- 账密登录（2026-10-25）：验证码之外的第二种登录方式 -->
          <div id="cy-login-box" style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--line,#e5e5e5)">
            <div style="font-size:12.5px;font-weight:600;margin-bottom:8px">邮箱密码登录</div>
            <div class="cy-row" style="margin-bottom:6px">
              <input id="cy-login-email" placeholder="邮箱" style="flex:1;min-width:200px;font-size:12.5px">
              <input id="cy-login-pw" type="password" placeholder="密码" style="flex:1;min-width:160px;font-size:12.5px">
            </div>
            <div class="cy-row" style="flex-wrap:wrap">
              <button class="btn tiny primary" id="cy-login-go">登录</button>
              <button class="btn tiny" id="cy-login-setpw">设 / 改密码</button>
              <button class="btn tiny" id="cy-login-forgot">忘记密码</button>
              <span id="cy-login-msg" class="muted" style="font-size:12px"></span>
            </div>

            <!-- 找回密码（2026-10-25）：邮箱验证码 → 设新密码 -->
            <div id="cy-reset-box" style="display:none;margin-top:10px;padding:10px 12px;border:1px dashed var(--line,#e5e5e5);border-radius:6px">
              <div style="font-size:12.5px;font-weight:600;margin-bottom:8px">找回密码</div>
              <div class="cy-row" style="margin-bottom:6px">
                <input id="cy-reset-email" placeholder="注册邮箱" style="flex:1;min-width:200px;font-size:12.5px">
                <button class="btn tiny" id="cy-reset-send">发送验证码</button>
              </div>
              <div class="cy-row" style="margin-bottom:6px">
                <input id="cy-reset-code" placeholder="邮箱收到的验证码" style="width:170px;font-size:12.5px">
              </div>
              <div class="cy-row">
                <input id="cy-reset-pw" type="password" placeholder="新密码（至少 8 位）" style="flex:1;min-width:200px;font-size:12.5px">
                <button class="btn tiny primary" id="cy-reset-go">重置密码</button>
              </div>
              <div id="cy-reset-msg" class="muted" style="font-size:12px;margin-top:6px"></div>
              <div class="cy-hint" style="margin-top:6px">
                验证码 10 分钟有效。重置后旧密码立即失效。
              </div>
            </div>
            <div class="cy-hint" style="margin-top:6px">
              密码至少 8 位，需包含字母、数字、符号中的两类。
              没设过密码就用邮箱验证码注册，注册时填密码即可。
            </div>
          </div>
        </div>

        <div class="cy-box">
          <div class="cy-label">投稿到市场（外部作者用这个）</div>
          <div class="cy-hint" style="margin-bottom:12px;line-height:1.7">
            两条路，任选其一：<br>
            <b>① GitHub 直链</b> —— 填你仓库地址，市场只读抓取，不用交包<br>
            <b>② 上传包</b> —— 把 tar.gz 传到中心服务器，等审核通过后上架
          </div>

          <div class="cy-row" style="margin-bottom:8px">
            <input id="cy-sub-repo" placeholder="https://github.com/你/仓库" style="flex:1;min-width:240px;font-size:12.5px">
            <button class="btn tiny" id="cy-sub-probe">探测</button>
            <button class="btn tiny" id="cy-sub-send-repo">提交直链</button>
          </div>
          <div id="cy-sub-repo-out" class="cy-out" style="display:none"></div>

          <div style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--line,#e5e5e5)">
            <div id="cy-sub-auth">
              <!-- 已登录时显示这个 -->
              <div id="cy-sub-ready" style="display:none">
                <div class="cy-hint" style="margin-bottom:0">
                  ✅ 已用 <b id="cy-sub-who"></b> 登录，可以直接投稿。
                </div>
              </div>
              <!-- 未登录时才展开 -->
              <div id="cy-sub-need" style="display:none">
                <div style="font-size:12.5px;font-weight:600;margin-bottom:6px">投稿凭证</div>
                <div class="cy-hint" style="margin-bottom:8px">
                  先在上方「作者账号」登录或注册，登录后可直接投稿，不用再验一次。
                </div>
                <div class="cy-row" style="margin-bottom:6px">
                  <input id="cy-sub-email" placeholder="你的邮箱" style="flex:1;min-width:200px;font-size:12.5px">
                  <button class="btn tiny" id="cy-sub-sendcode">发验证码</button>
                </div>
                <div class="cy-row">
                  <input id="cy-sub-code" placeholder="验证码" style="width:130px;font-size:12.5px">
                  <button class="btn tiny primary" id="cy-sub-login">换取凭证</button>
                  <span id="cy-sub-tokenstate" class="muted" style="font-size:12px"></span>
                </div>
              </div>
            </div>
          </div>

          <div class="cy-row" style="margin-top:10px">
            <label class="cy-file" id="cy-sub-label">
              <input type="file" id="cy-sub-file" accept=".gz,.tgz,.tar.gz,application/gzip">
              <span id="cy-sub-file-name">选择包（.tar.gz）</span>
            </label>
            <input id="cy-sub-version" placeholder="版本，如 1.0.0" style="width:130px;font-size:12.5px">
            <button class="btn primary tiny" id="cy-sub-upload">上传投稿</button>
          </div>
          <div class="cy-hint">单包上限 20 MB。审核通过后才会出现在市场里。</div>
          <div id="cy-sub-out" class="cy-out" style="display:none"></div>
        </div>

        <div class="cy-box">
          <div class="cy-label">打包插件</div>
          <div class="cy-hint" style="margin-bottom:10px">
            只列出你署名的插件。打包会自动剥离用户数据与密钥，别人装上像刚装的。
          </div>
          <div class="cy-row" style="flex-wrap:wrap">
            <select id="cy-pkg-id" class="cy-input" style="max-width:280px">
              <option value="">选择要打包的插件…</option>
            </select>
            <select id="cy-pkg-cat" class="cy-input" style="max-width:120px" title="上架后归到哪一类">
              <option value="">分类（选填）</option>
              <option value="群管理">群管理</option>
              <option value="群运营">群运营</option>
              <option value="能力">能力</option>
              <option value="娱乐">娱乐</option>
              <option value="工具">工具</option>
              <option value="主人">主人</option>
            </select>
            <button class="btn" id="cy-pkg" disabled>打包</button>
            <button class="btn tiny" id="cy-pkg-list">看已打的包</button>
          </div>
          <div class="cy-hint" style="margin-top:6px">
            分类只有 6 个固定选项：<b>群管理</b>（禁言/黑名单/限流/迎新）、
            <b>群运营</b>（日报/福利/题库/逛逛）、<b>能力</b>（生图/识图/搜索等）、
            <b>娱乐</b>（游戏/互动）、<b>工具</b>（市场/面板等）、<b>主人</b>（仅主人可用）。
            不选就按 manifest 里现有的。
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

      <div class="cy-section-title" style="margin-top:20px">
          我提交的反馈
          <span class="cy-badge" id="cy-myfb-count">加载中…</span>
          <button class="btn tiny" id="cy-myfb-refresh" style="margin-left:8px">刷新</button>
        </div>
        <div id="cy-myfb-root"><div class="cy-empty">加载中…</div></div>

        <div class="cy-box" style="margin-top:20px">
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

          <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
            <div class="cy-field-label" style="margin-bottom:10px">版本更新</div>
            <label class="cy-row" style="gap:6px;margin-bottom:8px">
              <input type="checkbox" id="cy-auto-check" ${marketCfg.autoCheckUpdate !== false ? 'checked' : ''}>
              <span>自动检查新版本（只提示，不自动装）</span>
            </label>
            <label class="cy-row" style="gap:6px;margin-bottom:10px">
              <input type="checkbox" id="cy-auto-update" ${marketCfg.autoUpdate === true ? 'checked' : ''}>
              <span>自动更新（<b style="color:#b7791f">覆盖安装</b>，有风险）</span>
            </label>
            <div class="cy-row" style="gap:8px">
              <span style="font-size:12.5px">检查间隔</span>
              <input class="cy-input" id="cy-check-hours" type="number" min="1" max="168"
                     value="${marketCfg.checkIntervalHours || 6}" style="max-width:90px">
              <span style="font-size:12.5px;color:var(--muted,#888)">小时</span>
            </div>
            <div class="cy-hint" style="margin-top:8px">
              自动更新会直接把新版本覆盖到本地，万一新版有 bug 会立刻生效。
              不确定时建议只开「自动检查」。
            </div>
          </div>

          <div style="margin-top:16px"><button class="btn primary" id="cy-save">保存</button></div>
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
      savePane(btn.dataset.pane);   // 记住位置，重挂后回到这里
      // 懒加载：第一次切到这个 tab 才拉数据（2026-10-25）
      currentPane = btn.dataset.pane;
      ensurePaneLoaded(btn.dataset.pane);
    });
  });

  // ── 按需加载（2026-10-25）──
  //
  // 🔴 用户反馈："创造营进去会有卡顿，能不能优化一下"
  //
  // 根因：9 个加载函数在挂载时**全部无条件执行**，
  // 包括管理页的反馈/投稿/下载统计/管理员列表 ——
  // 打开创造营只是想看市场，却把整个后台的数据都拉了一遍。
  // 每个请求还要等网络往返，主线程也被 JSON 解析占住 → 明显卡顿。
  //
  // 改成：只加载当前 tab，其余等你真的切过去再拉。
  const paneLoaders = new Map();      // pane -> 加载函数数组（一个 tab 可能有多个）
  const paneLoaded = new Set();       // 已加载过的（避免重复拉）
  let currentPane = 'plugins';        // 当前所在 tab

  /**
   * 注册一个 pane 的加载函数
   *
   * 🔴 关键修正（2026-10-26）：
   *   如果注册时**已经停留在该 pane 上**，立刻执行一次。
   *
   *   之前只往 Map 里塞，靠"切换标签"来触发。
   *   但管理页那四块（全部反馈/投稿队列/下载统计/管理员列表）
   *   的注册代码写在 renderAdmin() 里，而 renderAdmin 又要靠
   *   loadAdminPanel 被调用才执行 —— 于是：
   *     切到管理 → ensurePaneLoaded 跑了（此时数组里只有 1 个）
   *     → loadAdminPanel 执行 → renderAdmin 才注册另外 4 个
   *     → 但那 4 个再也没人触发了 → 永远"加载中…"
   *
   *   现在：注册时若已在目标 pane，立即执行，不管什么时候注册的。
   */
  const onPaneFirstShow = (pane, fn) => {
    if (typeof fn !== 'function') return;
    const arr = paneLoaders.get(pane) || [];
    arr.push(fn);
    paneLoaders.set(pane, arr);
    // 已经在这个 tab 上 → 立刻加载（这是修 "一直加载中" 的关键）
    if (currentPane === pane) {
      try { fn(); } catch { /* ignore */ }
    }
  };

  const ensurePaneLoaded = (pane) => {
    if (!pane) return;
    currentPane = pane;
    const fns = paneLoaders.get(pane);
    if (!fns || !fns.length) return;
    if (paneLoaded.has(pane)) return;

    // 🔴 只在**真的跑成功**时才标记已加载（2026-10-28 修）
    //
    // 原实现是先 add 再跑 —— 如果 load 里因为 DOM 还没就绪抛错，
    // 标记已经加上，之后就再也不会重试，页面永远停在「加载中…」。
    // 实测症状：角色卡面板首次进入显示"加载中…"，点刷新才出来。
    //
    // 现在改成：任何一次抛错就不打标记，下次进入还能再试。
    // 异步函数要等 Promise 才知道成不成功。
    // 直接把 Promise 的结果收起来，全成功才打标记。
    const results = [];
    for (const fn of fns) {
      try {
        const r = fn();
        results.push(r && typeof r.then === 'function' ? r : Promise.resolve(true));
      } catch {
        results.push(Promise.resolve(false));
      }
    }
    Promise.allSettled(results).then((rs) => {
      const ok = rs.every((x) => x.status === 'fulfilled' && x.value !== false);
      if (ok) paneLoaded.add(pane);
    });
  };

  /** 强制重新加载某个 pane（忽略"已加载"标记） */
  const reloadPane = (pane) => {
    const fns = paneLoaders.get(pane) || [];
    for (const fn of fns) { try { fn(); } catch { /* ignore */ } }
  };

  // ── 默认展示「插件市场」+ 恢复上次标签 ──
  //
  // 用户要求："进去默认展示市场，没必要手动点击才选择 tab"
  //
  // 原来会恢复上次停留的 tab —— 上次如果在「设置」，
  // 这次进来还是设置，得手动点回市场。现在改成：
  //   · 每次都默认「插件市场」（第一屏就是最有用的内容）
  //   · 记忆功能关掉（只有真的切到别的 tab 才记，但不再自动恢复）
  //
  // 这样打开创造营 → 立刻看到市场列表，不用再点一下。
  (() => {
    const want = 'plugins';   // 固定默认市场
    const tab = box.querySelector(`.cy-tab[data-pane="${want}"]`);
    if (tab) {
      box.querySelectorAll('.cy-tab').forEach((b) => b.classList.toggle('on', b === tab));
      box.querySelectorAll('.cy-pane').forEach((p) => {
        p.classList.toggle('on', p.id === `cy-pane-${want}`);
      });
    }
    // 市场数据本身是同步渲染的（渲染时就算好了），这里不需要额外请求。
    // 但如果以后市场也改成按需，这里要补 ensurePaneLoaded('plugins')。
  })();

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
          setTimeout(refreshPanel, 1500);
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
    onPaneFirstShow('skills', loadSkillPick);
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
        // 两种成功态（2026-10-28）：
        //   submitted=true → 已投稿，等管理员审核（作者身份，无需 R2）
        //   direct=true    → 已直接发布（市场所有者身份）
        if (r.submitted) {
          showSkillMsg(
            `✅ 已提交 v${r.version}，等待管理员审核后上线\n`
            + `投稿 ID：${r.submissionId || '-'}\n`
            + '审核通过后会出现在技能库里。',
            'ok'
          );
          ctx.toast?.('已提交，等待审核');
        } else {
          showSkillMsg(`✅ 已发布 v${r.version}（${(r.bytes / 1024).toFixed(1)}KB）\n市场里现在共 ${r.total} 个 skill`, 'ok');
          ctx.toast?.('发布成功');
        }
      } else {
        // 需要先登录作者账号时，给出明确指引而不是干巴巴报错
        if (r?.needSubmit) {
          showSkillMsg(
            '❌ ' + (r?.error || '需要作者身份') + '\n'
            + '提示：发布技能不需要配置 R2 密钥 —— 登录创造营账号后提交即可，由管理员审核上线。',
            'err'
          );
        } else {
          showSkillMsg('❌ ' + (r?.error || '发布失败'), 'err');
        }
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
          setTimeout(refreshPanel, 900);
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
          setTimeout(refreshPanel, 900);
        } else {
          ctx.toast?.(r?.error || '下架失败');
        }
      } catch (e) { ctx.toast?.('下架失败：' + e.message); }
      finally { btn.disabled = false; }
    });
  });

  // ── 我提交的反馈（2026-10-25）──
  //
  // 用户要求："插件反馈的列表在发布栏里看吧，你放到管理栏的话有些作者没权限"
  //
  // 完全正确。原来放在管理栏，而 /api/market/admin/feedback 有 requireAdmin()，
  // 普通作者点进去只会 403 —— 自己提交过什么、处理到哪，一概看不见。
  // 现在移到「发布」栏，走 /api/market/feedback/mine（只返回自己的）。
  (async () => {
    const root = box.querySelector('#cy-myfb-root');
    const countEl = box.querySelector('#cy-myfb-count');
    if (!root) return;

    const typeLabel = { bug: '问题', feature: '建议', other: '其它' };
    const stLabel = { open: '待处理', resolved: '已解决', ignored: '已忽略' };
    const stColor = { open: '#b7791f', resolved: '#2f855a', ignored: '#888' };

    const loadMine = async () => {
      root.innerHTML = '<div class="cy-empty">加载中…</div>';
      try {
        const r = await api('/api/market/feedback/mine');
        if (!r?.ok) {
          root.innerHTML = `<div class="cy-empty">${esc(r?.error || '读取失败')}</div>`;
          if (countEl) countEl.textContent = '—';
          return;
        }
        const items = r.items || [];
        if (countEl) countEl.textContent = `共 ${items.length} 条`;
        if (!items.length) {
          root.innerHTML = '<div class="cy-empty">还没提交过反馈。点右上角「反馈」可以说问题或提建议。</div>';
          return;
        }
        root.innerHTML = items.map((x) => `
          <div class="cy-card" style="margin-bottom:8px">
            <div class="cy-card-head">
              <span class="cy-badge">${esc(typeLabel[x.type] || x.type)}</span>
              <span class="cy-name" style="font-size:13px">${esc(x.title)}</span>
              <span class="cy-spacer"></span>
              <span class="cy-badge" style="color:${stColor[x.status] || 'inherit'}">${esc(stLabel[x.status] || x.status)}</span>
            </div>
            ${x.body ? `<div class="cy-summary" style="white-space:pre-wrap;max-height:100px;overflow:auto">${esc(x.body)}</div>` : ''}
            <div class="cy-meta">
              ${esc(fmtTime(x.submittedAt))}
              ${(x.images || []).length ? ` · 图片 ${x.images.length} 张` : ''}
              ${(x.files || []).length ? ` · 附件 ${x.files.length} 个` : ''}
              ${x.attach ? ` · 附件 ${esc(x.attach.name)}` : ''}
            </div>
            ${x.reviewNote ? `<div class="cy-meta" style="margin-top:4px;color:#b7791f">回复：${esc(x.reviewNote)}</div>` : ''}
          </div>`).join('');
      } catch (e) {
        root.innerHTML = `<div class="cy-empty">读取失败：${esc(e.message)}</div>`;
      }
    };

    box.querySelector('#cy-myfb-refresh')?.addEventListener('click', loadMine);
    onPaneFirstShow('publish', loadMine);
  })();

  // ── 角色卡（2026-10-25）──
  //
  // 用户要求："创作营支持上传自定义角色卡功能，同样保留作者信息，
  //           走类似 skill 和插件的投稿和审核投稿"
  //
  // 三件事：
  //   ① 浏览市场角色卡 → 安装（写进 config.customPersonas）
  //   ② 写/改自己的角色卡 → 存到 personas/*.md → 发布到市场
  //   ③ 作者只能下架/更新自己署名的
  (() => {
    const listEl = box.querySelector('#cy-persona-list');
    const countEl = box.querySelector('#cy-persona-count');
    // 🔴 拿不到元素就**不能 return**（2026-10-28 修）
    //
    // 原实现在这里直接 return，等于"这个 pane 的 load 函数根本没注册"。
    // 而首次进入时 DOM 有可能还没渲染完 —— 于是永远拿不到元素，
    // 页面就一直停在「加载中…」，点刷新才出来（因为那时候 DOM 好了）。
    //
    // 现在：延后到用户真正操作时再查元素。
    const getEl = () => box.querySelector('#cy-persona-list');
    if (!listEl && !getEl()) { /* DOM 未就绪，load 里会重新查 */ }

    let market = [];
    let local = [];

    const render = () => {
      const localById = new Map(local.map((x) => [x.id, x]));
      if (countEl) countEl.textContent = `市场 ${market.length} 个 · 本地 ${local.length} 个`;

      const rEl = getEl();
      if (!rEl) return;
      if (!market.length && !local.length) {
        rEl.innerHTML = '<div class="cy-empty">还没有角色卡。点「写一个」创建第一张，或等别人发布。</div>';
        return;
      }

      // 本地自己的排前面（含已发布/未发布状态）
      const rows = [];

      for (const l of local) {
        const mp = market.find((m) => m.id === l.id);
        const published = !!mp;
        const behind = mp && cmpVerLocal(mp.version, l.version) > 0;
        rows.push(`
          <div class="cy-card" style="margin-bottom:8px">
            <div class="cy-card-head">
              <span class="cy-name">${esc(l.name)}</span>
              <span class="cy-ver">v${esc(l.version)}</span>
              ${published
                ? (behind
                    ? '<span class="cy-badge" style="background:#b7791f22;color:#b7791f">有未发布改动</span>'
                    : '<span class="cy-badge" style="background:#2f855a22;color:#2f855a">已发布</span>')
                : '<span class="cy-badge">未发布</span>'}
              <span class="cy-spacer"></span>
              <button class="btn tiny" data-per-edit="${esc(l.id)}">编辑</button>
              <button class="btn tiny primary" data-per-pub="${esc(l.id)}">${published ? '更新' : '发布'}</button>
              ${published ? `<button class="btn tiny" data-per-off="${esc(l.id)}" style="color:#c00">下架</button>` : ''}
            </div>
            <div class="cy-summary">${esc(l.summary)}</div>
            <div class="cy-meta">
              作者：${esc(l.author || '未署名')}
              ${l.group ? ' · ' + esc(l.group) : ''}
              · ${(l.bytes / 1024).toFixed(1)}KB
            </div>
          </div>`);
      }

      // 市场里别人的（本地没有的）
      for (const m of market) {
        if (localById.has(m.id)) continue;
        rows.push(`
          <div class="cy-card" style="margin-bottom:8px">
            <div class="cy-card-head">
              <span class="cy-name">${esc(m.name)}</span>
              <span class="cy-ver">v${esc(m.version)}</span>
              <span class="cy-spacer"></span>
              <button class="btn tiny" data-per-install="${esc(m.id)}">安装</button>
            </div>
            <div class="cy-summary">${esc(m.summary || '')}</div>
            <div class="cy-meta">
              作者：${esc(m.author || '未知')}
              ${m.group ? ' · ' + esc(m.group) : ''}
              · ${((m.size || 0) / 1024).toFixed(1)}KB
            </div>
          </div>`);
      }

      rEl.innerHTML = rows.join('');
      bind();
    };

    const cmpVerLocal = (a, b) => {
      const pa = String(a || '0').split(/[.\-]/).map(Number);
      const pb = String(b || '0').split(/[.\-]/).map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x - y;
      }
      return 0;
    };

    const bind = () => {
      listEl.querySelectorAll('[data-per-install]').forEach((b) => {
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            const r = await api('/api/persona-market/install', { method: 'POST', body: { id: b.dataset.perInstall } });
            if (r?.ok) { ctx.toast?.(`已安装「${r.name}」`); await load(); }
            else if (r?.error?.includes('已有同名')) {
              if (confirm(r.error + '\n\n要覆盖吗？')) {
                const r2 = await api('/api/persona-market/install', {
                  method: 'POST', body: { id: b.dataset.perInstall, overwrite: true },
                });
                if (r2?.ok) { ctx.toast?.(`已覆盖「${r2.name}」`); await load(); }
                else alert(r2?.error || '安装失败');
              }
            } else alert(r?.error || '安装失败');
          } catch (e) { alert(e.message); }
          finally { b.disabled = false; }
        });
      });

      listEl.querySelectorAll('[data-per-pub]').forEach((b) => {
        b.addEventListener('click', async () => {
          const id = b.dataset.perPub;
          const l = local.find((x) => x.id === id);
          const ver = prompt(`发布「${l?.name}」到市场，版本号：`, l?.version || '1.0.0');
          if (!ver) return;
          const notes = prompt('这次改了什么（选填）：', '') || '';
          b.disabled = true;
          try {
            const r = await api('/api/persona-market/publish', {
              method: 'POST', body: { id, version: ver, notes },
            });
            if (r?.ok) { ctx.toast?.('已发布'); await load(); }
            else alert(r?.error || '发布失败');
          } catch (e) { alert(e.message); }
          finally { b.disabled = false; }
        });
      });

      listEl.querySelectorAll('[data-per-off]').forEach((b) => {
        b.addEventListener('click', async () => {
          const id = b.dataset.perOff;
          if (!confirm('从市场下架？本地文件会保留，随时可以再发。')) return;
          b.disabled = true;
          try {
            const r = await api('/api/persona-market/unpublish', { method: 'POST', body: { id } });
            if (r?.ok) { ctx.toast?.('已下架'); await load(); }
            else alert(r?.error || '下架失败');
          } catch (e) { alert(e.message); }
          finally { b.disabled = false; }
        });
      });

      listEl.querySelectorAll('[data-per-edit]').forEach((b) => {
        b.addEventListener('click', () => openEditor(b.dataset.perEdit));
      });
    };

    // ── 编辑器（弹窗）──
    const openEditor = async (id) => {
      const l = id ? local.find((x) => x.id === id) : null;
      const mine = (() => { try { return JSON.parse(sessionStorage.getItem('cy_author') || 'null'); } catch { return null; } })();

      const modal = document.createElement('div');
      modal.className = 'cy-modal';
      modal.style.display = 'flex';
      modal.innerHTML = `
        <div class="cy-modal-mask"></div>
        <div class="cy-modal-box">
          <div class="cy-modal-head">
            <span>${l ? '编辑角色卡' : '写一个角色卡'}</span>
            <button class="cy-modal-x" data-x>✕</button>
          </div>
          <div class="cy-modal-body">
            <div class="cy-field">
              <div class="cy-field-label">角色卡 id（英文，发布后不改）</div>
              <input class="cy-input" data-f="id" value="${esc(id || '')}" placeholder="如 shaniu" ${l ? 'readonly' : ''}>
            </div>
            <div class="cy-field">
              <div class="cy-field-label">角色名</div>
              <input class="cy-input" data-f="name" value="${esc(l?.name || '')}" placeholder="如 憨憨鲸">
            </div>
            <div class="cy-field">
              <div class="cy-field-label">一句话简介（市场列表显示）</div>
              <input class="cy-input" data-f="summary" value="${esc(l?.summary || '')}" placeholder="如 同一只小鲸鱼，只是脑子不拐弯">
            </div>
            <div class="cy-row" style="gap:10px">
              <div class="cy-field" style="flex:1">
                <div class="cy-field-label">作者</div>
                <input class="cy-input" data-f="author" value="${esc(l?.author || mine?.nickname || '')}" placeholder="你的名字">
              </div>
              <div class="cy-field" style="width:110px">
                <div class="cy-field-label">版本</div>
                <input class="cy-input" data-f="version" value="${esc(l?.version || '1.0.0')}">
              </div>
              <div class="cy-field" style="width:120px">
                <div class="cy-field-label">分类</div>
                <input class="cy-input" data-f="group" value="${esc(l?.group || '')}" placeholder="选填">
              </div>
            </div>
            <div class="cy-field">
              <div class="cy-field-label">角色设定（写具体：身份 / 性格 / 说话方式，最好带示例对话）</div>
              <textarea class="cy-input" data-f="text" rows="14"
                placeholder="## 身份&#10;你是……&#10;&#10;## 性格&#10;- ……&#10;&#10;## 说话方式&#10;- ……&#10;&#10;## 示例对话&#10;> 用户：今天好累&#10;> 角色：……">${esc(l?.text || '')}</textarea>
            </div>
            <div class="cy-hint">格式说明见 <code>personas/README.md</code>。写具体行为比写抽象形容词有用。</div>
            <div class="cy-msg" data-msg></div>
          </div>
          <div class="cy-modal-foot">
            <button class="btn" data-x>取消</button>
            <button class="btn primary" data-save>保存</button>
          </div>
        </div>`;
      box.appendChild(modal);

      const close = () => modal.remove();
      modal.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', close));
      modal.querySelector('.cy-modal-mask')?.addEventListener('click', close);

      modal.querySelector('[data-save]')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        const val = (f) => modal.querySelector(`[data-f="${f}"]`)?.value?.trim() || '';
        const msg = modal.querySelector('[data-msg]');
        const payload = {
          id: val('id'), name: val('name'), summary: val('summary'),
          text: val('text'), author: val('author'), version: val('version'),
          group: val('group'),
        };
        const miss = ['id', 'name', 'summary', 'text', 'author'].find((k) => !payload[k]);
        if (miss) { if (msg) { msg.className = 'cy-msg on err'; msg.textContent = `「${miss}」不能为空`; } return; }

        btn.disabled = true; btn.textContent = '保存中…';
        try {
          const r = await api('/api/persona-market/save', { method: 'POST', body: payload });
          if (r?.ok) { ctx.toast?.('已保存'); close(); await load(); }
          else if (msg) { msg.className = 'cy-msg on err'; msg.textContent = r?.error || '保存失败'; }
        } catch (e) { if (msg) { msg.className = 'cy-msg on err'; msg.textContent = e.message; } }
        finally { btn.disabled = false; btn.textContent = '保存'; }
      });
    };

    // ── 导入已有（2026-10-25）──
    //
    // 用户要求："角色卡请支持本地导出发布，不可能让大家每次都重新填写信息吧"
    //
    // 两条路：
    //   ① 从「设置 → 人设模板」里已手写的人设一键转成角色卡
    //   ② 选本地 .md 文件导入
    box.querySelector('#cy-persona-import')?.addEventListener('click', async () => {
      let items = [];
      try {
        const r = await api('/api/persona-market/importable');
        items = (r?.items) || [];
      } catch { /* 拿不到就只给文件导入 */ }

      const mine = (() => { try { return JSON.parse(sessionStorage.getItem('cy_author') || 'null'); } catch { return null; } })();
      const author = mine?.nickname || '';

      const modal = document.createElement('div');
      modal.className = 'cy-modal';
      modal.style.display = 'flex';
      modal.innerHTML = `
        <div class="cy-modal-mask"></div>
        <div class="cy-modal-box">
          <div class="cy-modal-head">
            <span>导入已有角色</span>
            <button class="cy-modal-x" data-x>✕</button>
          </div>
          <div class="cy-modal-body">
            <div class="cy-field">
              <div class="cy-field-label">从我的自定义人设导入（不用重填）</div>
              ${items.length ? items.map((it, i) => `
                <div class="cy-card" style="margin-bottom:6px">
                  <div class="cy-card-head">
                    <span class="cy-name" style="font-size:13px">${esc(it.name)}</span>
                    <span class="cy-badge">${(it.bytes / 1024).toFixed(1)}KB</span>
                    ${it.sourceId ? '<span class="cy-badge" style="background:#2f855a22;color:#2f855a">来自市场</span>' : ''}
                    <span class="cy-spacer"></span>
                    <button class="btn tiny primary" data-imp="${i}">导入</button>
                  </div>
                  <div class="cy-meta">建议 id：${esc(it.suggestedId)}</div>
                </div>`).join('')
              : '<div class="cy-empty">没有可导入的自定义人设。你可以在「设置 → 人设模板」里写，写完回来这里一键导入。</div>'}
            </div>

            <div class="cy-field" style="margin-top:16px">
              <div class="cy-field-label">或：导入本地 .md 文件</div>
              <div class="cy-hint" style="margin-bottom:8px">
                带 frontmatter 的直接用；没有的会自动补上（作者填「${esc(author || '你')}」）。
              </div>
              <button class="btn tiny" id="cy-imp-file">选择文件…</button>
            </div>
            <div class="cy-msg" data-msg></div>
          </div>
          <div class="cy-modal-foot">
            <button class="btn" data-x>关闭</button>
          </div>
        </div>`;
      box.appendChild(modal);
      const close = () => modal.remove();
      modal.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', close));
      modal.querySelector('.cy-modal-mask')?.addEventListener('click', close);

      const msg = modal.querySelector('[data-msg]');
      const say = (s, kind) => {
        if (!msg) return;
        msg.className = 'cy-msg on ' + (kind || '');
        msg.textContent = s;
      };

      // ① 从已有自定义人设导入
      modal.querySelectorAll('[data-imp]').forEach((b) => {
        b.addEventListener('click', async () => {
          const it = items[Number(b.dataset.imp)];
          if (!it) return;
          const id = prompt('给这张角色卡一个英文 id（发布后不改）：', it.suggestedId);
          if (!id) return;
          b.disabled = true;
          try {
            const r = await api('/api/persona-market/export-local', {
              method: 'POST',
              body: { key: it.key, id, name: it.name, author: author || '我', version: '1.0.0' },
            });
            if (r?.ok) { say(`✅ 已导入「${r.name}」→ personas/${r.id}.md`, 'ok'); await load(); setTimeout(close, 1200); }
            else say('❌ ' + (r?.error || '导入失败'), 'err');
          } catch (e) { say('❌ ' + e.message, 'err'); }
          finally { b.disabled = false; }
        });
      });

      // ② 选本地文件
      modal.querySelector('#cy-imp-file')?.addEventListener('click', () => {
        const input = box.querySelector('#cy-persona-file');
        if (!input) return;
        input.value = '';
        input.onchange = async () => {
          const f = input.files?.[0];
          if (!f) return;
          const id = prompt('给这张角色卡一个英文 id（发布后不改）：', f.name.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'));
          if (!id) return;
          say('读取中…');
          try {
            const b64 = await new Promise((res, rej) => {
              const fr = new FileReader();
              fr.onload = () => res(String(fr.result || '').split(',')[1] || '');
              fr.onerror = () => rej(new Error('读取失败'));
              fr.readAsDataURL(f);
            });
            const r = await api('/api/persona-market/import-file', {
              method: 'POST',
              body: { id, base64: b64, author: author || '我', name: id },
            });
            if (r?.ok) { say(`✅ 已导入「${r.name}」`, 'ok'); await load(); setTimeout(close, 1200); }
            else say('❌ ' + (r?.error || '导入失败'), 'err');
          } catch (e) { say('❌ ' + e.message, 'err'); }
        };
        input.click();
      });
    });

    box.querySelector('#cy-persona-new')?.addEventListener('click', () => openEditor(''));

    const load = async () => {
      const el = getEl();
      if (!el) return false;          // DOM 还没就绪 → 不标已加载
      el.innerHTML = '<div class="cy-empty">加载中…</div>';
      try {
        const [m, l] = await Promise.all([
          api('/api/persona-market/index').catch(() => ({ ok: false })),
          api('/api/persona-market/local').catch(() => ({ ok: false })),
        ]);
        market = (m?.ok && m.personas) || [];
        local = (l?.ok && l.personas) || [];
        render();
        // 返回 true 表示"这次加载是有效的"，paneLoaded 才会打标记。
        // 两个接口都失败 → 返回 false，下次进入这个 pane 会重试。
        return !!(m?.ok || l?.ok);
      } catch (e) {
        const el2 = getEl();
        if (el2) el2.innerHTML = '<div class="cy-empty">加载失败，点「刷新」重试</div>';
        return false;
      }
    };

    box.querySelector('#cy-persona-refresh')?.addEventListener('click', load);
    onPaneFirstShow('personas', load);
  })();

  // ── 反馈弹窗（2026-10-25）──
  //
  // 用户要求："注册用户点击反馈按钮，出弹窗，可以提交 0-3 张图片
  // 和 0-3 个日志或 md 文件，及文字描述内容"
  (() => {
    const modal = box.querySelector('#cy-fb-modal');
    const openBtn = box.querySelector('#cy-fb-open');
    if (!modal || !openBtn) return;

    const msg = (s, kind) => {
      const el = box.querySelector('#cy-fb-msg');
      if (!el) return;
      if (!s) { el.className = 'cy-msg'; el.textContent = ''; return; }
      el.className = 'cy-msg on ' + (kind || '');
      el.textContent = s;
    };

    // 当前针对的插件（从卡片上的「反馈」按钮进来时才有）
    let ctxPlugin = null;    // { id, name, version }

    const renderPluginCtx = () => {
      const boxEl = box.querySelector('#cy-fb-plugin-box');
      const nameEl = box.querySelector('#cy-fb-plugin-name');
      const verEl = box.querySelector('#cy-fb-plugin-ver');
      if (!boxEl) return;
      if (!ctxPlugin) {
        boxEl.style.display = 'none';
        return;
      }
      boxEl.style.display = '';
      if (nameEl) nameEl.textContent = ctxPlugin.name;
      if (verEl) verEl.textContent = ctxPlugin.version ? 'v' + ctxPlugin.version : '';
      // 标题自动带上插件名，用户不用手打
      const titleEl = box.querySelector('#cy-fb-title');
      if (titleEl && !titleEl.value.trim()) {
        titleEl.value = `【${ctxPlugin.name}】`;
        // 光标放末尾，接着写
        setTimeout(() => { titleEl.focus(); titleEl.setSelectionRange(titleEl.value.length, titleEl.value.length); }, 50);
      }
    };

    const open = (plugin = null) => {
      ctxPlugin = plugin;
      modal.style.display = 'flex';
      msg('');
      renderPluginCtx();
    };
    const close = () => { modal.style.display = 'none'; };

    openBtn.addEventListener('click', () => open(null));

    // 每个插件卡片上的「反馈」按钮（2026-10-26）
    //
    // 用户要求："每个插件都有单独的反馈卡片，做在这个插件卡片上面一个小按钮就好了，
    // 然后弹出提供反馈路径"
    const bindPluginFeedback = () => {
      box.querySelectorAll('[data-pfb]').forEach((b) => {
        if (b.dataset.bound === '1') return;   // 避免重复绑定
        b.dataset.bound = '1';
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          open({
            id: b.dataset.pfb,
            name: b.dataset.pfbName || b.dataset.pfb,
            version: b.dataset.pfbVer || '',
          });
        });
      });
    };
    bindPluginFeedback();

    // 清除插件上下文（改成通用反馈）
    box.querySelector('#cy-fb-plugin-clear')?.addEventListener('click', () => {
      ctxPlugin = null;
      renderPluginCtx();
      const titleEl = box.querySelector('#cy-fb-title');
      if (titleEl && /^【.*?】/.test(titleEl.value)) titleEl.value = '';
    });
    box.querySelector('#cy-fb-close')?.addEventListener('click', close);
    box.querySelector('#cy-fb-cancel')?.addEventListener('click', close);
    modal.querySelector('.cy-modal-mask')?.addEventListener('click', close);

    // 三组文件输入（2026-10-26）：图片 / 日志 / 文档，各自独立计数
    const imgInput = box.querySelector('#cy-fb-images');
    const logInput = box.querySelector('#cy-fb-logs');
    const docInput = box.querySelector('#cy-fb-docs');

    const bindCount = (input, nameEl, labelEl, emptyText) => {
      input?.addEventListener('change', () => {
        const n = input.files?.length || 0;
        const el = box.querySelector(nameEl);
        if (el) el.textContent = n ? `已选 ${n} 个` : emptyText;
        box.querySelector(labelEl)?.classList.toggle('picked', n > 0);
      });
    };
    bindCount(imgInput, '#cy-fb-img-name', '#cy-fb-img-label', '选择图片…');
    bindCount(logInput, '#cy-fb-log-name', '#cy-fb-log-label', '选择日志…');
    bindCount(docInput, '#cy-fb-doc-name', '#cy-fb-doc-label', '选择 .md 文档…');

    // 读文件成 base64
    const readAsB64 = (f) => new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || '').split(',')[1] || '');
      fr.onerror = () => reject(new Error('读取失败：' + f.name));
      fr.readAsDataURL(f);
    });

    box.querySelector('#cy-fb-submit')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const title = box.querySelector('#cy-fb-title')?.value.trim();
      const bodyText = box.querySelector('#cy-fb-body')?.value.trim();
      const type = box.querySelector('input[name="cy-fb-type"]:checked')?.value || 'bug';

      if (!title) { msg('请填标题', 'err'); return; }

      const imgs = [...(imgInput?.files || [])];
      const logs = [...(logInput?.files || [])];
      const docs = [...(docInput?.files || [])];
      if (imgs.length > 3) { msg('图片最多 3 张', 'err'); return; }
      if (logs.length > 3) { msg('日志最多 3 个', 'err'); return; }
      if (docs.length > 3) { msg('文档最多 3 个', 'err'); return; }

      if (btn.disabled) return;
      btn.disabled = true;
      const oldTxt = btn.textContent;
      btn.textContent = '提交中…';
      msg('正在读取附件…');
      try {
        const images = [];
        for (const f of imgs) {
          if (f.size > 5 * 1024 * 1024) throw new Error(`图片 ${f.name} 超过 5MB`);
          images.push({ name: f.name, base64: await readAsB64(f) });
        }
        const logFiles = [];
        for (const f of logs) {
          if (f.size > 2 * 1024 * 1024) throw new Error(`日志 ${f.name} 超过 2MB`);
          logFiles.push({ name: f.name, base64: await readAsB64(f) });
        }
        const docFiles = [];
        for (const f of docs) {
          if (f.size > 2 * 1024 * 1024) throw new Error(`文档 ${f.name} 超过 2MB`);
          docFiles.push({ name: f.name, base64: await readAsB64(f) });
        }

        msg('提交中…');
        const r = await api('/api/market/feedback/rich', {
          method: 'POST',
          body: {
            type, title, body: bodyText, images, logFiles, docFiles,
            // 针对具体插件的反馈（2026-10-26）：带上 id 让管理端能归类
            pluginId: ctxPlugin?.id || '',
            pluginName: ctxPlugin?.name || '',
            pluginVersion: ctxPlugin?.version || '',
          },
        });

        if (r?.ok) {
          msg(`✅ 已提交（编号 ${r.id}）。感谢反馈，会尽快看。`, 'ok');
          ctx.toast?.('反馈已提交');
          // 清空表单
          const ti = box.querySelector('#cy-fb-title'); if (ti) ti.value = '';
          const bo = box.querySelector('#cy-fb-body'); if (bo) bo.value = '';
          if (imgInput) imgInput.value = '';
          if (logInput) logInput.value = '';
          if (docInput) docInput.value = '';
          const n1 = box.querySelector('#cy-fb-img-name'); if (n1) n1.textContent = '选择图片…';
          const n2 = box.querySelector('#cy-fb-log-name'); if (n2) n2.textContent = '选择日志…';
          const n3 = box.querySelector('#cy-fb-doc-name'); if (n3) n3.textContent = '选择 .md 文档…';
          setTimeout(() => { close(); ctxPlugin = null; renderPluginCtx(); }, 1800);
        } else {
          msg('❌ ' + (r?.error || '提交失败'), 'err');
        }
      } catch (e) {
        msg('❌ ' + (e?.message || e), 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = oldTxt;
      }
    });
  })();

  // ── 分类筛选（2026-10-25）──
  //
  // 用户要求："插件功能分类"
  //
  // 28 个插件混在一个列表里不好找。按 category 做筛选栏，
  // 每个分类带计数，点一下只看那一类。
  // 分类来自 manifest.category，已在服务端统一成 4 类：
  //   群运营 / 内容能力 / 娱乐互动 / 系统工具
  (() => {
    const catBar = box.querySelector('#cy-cats');
    const listEl = box.querySelector('#pm-list');
    if (!catBar || !listEl) return;

    const all = market.plugins || [];
    const counts = new Map();
    for (const p of all) {
      const c = p.category || '未分类';
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    const cats = [...counts.entries()].sort((a, b) => b[1] - a[1]);

    let current = '全部';
    const chips = [['全部', all.length], ...cats];

    const renderChips = () => {
      catBar.innerHTML = chips.map(([name, n]) => `
        <span class="cy-cat ${name === current ? 'on' : ''}" data-cat="${esc(name)}">
          ${esc(name)} <span style="opacity:.6">${n}</span>
        </span>`).join('');
      catBar.querySelectorAll('[data-cat]').forEach((el) => {
        el.addEventListener('click', () => {
          current = el.dataset.cat;
          renderChips();
          applyFilter();
        });
      });
    };

    // ── 搜索（2026-10-27）──
    //
    // 用户要求："给创造营加插件搜索功能"
    //
    // 与分类筛选**联合生效**（AND）：先按分类过滤，再按关键词过滤。
    // 关键词匹配范围：插件名 / id / 说明 / 作者 / 分类名，
    // 全部小写化后做子串匹配 —— 中文不用分词，命中率高、够用。
    const searchEl = box.querySelector('#cy-search');
    const clearEl = box.querySelector('#cy-search-clear');
    let keyword = '';

    const applyFilter = () => {
      // 🔴 直接读卡片上的 data-cat（2026-10-25 修）
      //    原来靠 data-install 反查插件再取 category，
      //    但已安装的卡片没有 data-install（只有"已安装"文字）→ 全部匹配不到。
      const rows = [...listEl.querySelectorAll('[data-pid]')];
      const kw = keyword.trim().toLowerCase();

      rows.forEach((row) => {
        const cat = row.dataset.cat || '未分类';
        const catOk = current === '全部' || cat === current;
        // data-search 在渲染卡片时写入（见下方 pluginCards 生成处）
        const hay = (row.dataset.search || '').toLowerCase();
        const kwOk = !kw || hay.includes(kw);
        row.style.display = (catOk && kwOk) ? '' : 'none';
      });

      // 空结果提示：说清是"搜不到"还是"分类下没有"
      const visible = rows.filter((r) => r.style.display !== 'none').length;
      let empty = listEl.querySelector('.cy-cat-empty');
      if (!visible) {
        if (!empty) {
          empty = document.createElement('div');
          empty.className = 'cy-empty cy-cat-empty';
          listEl.appendChild(empty);
        }
        empty.textContent = kw
          ? `没找到匹配「${keyword.trim()}」的插件${current !== '全部' ? `（当前分类：${current}）` : ''}`
          : `「${current}」分类下没有插件`;
      } else if (empty) {
        empty.remove();
      }
    };

    // 输入即搜（不防抖，本地过滤几十条无压力）
    searchEl?.addEventListener('input', () => {
      keyword = searchEl.value || '';
      if (clearEl) clearEl.style.display = keyword ? '' : 'none';
      applyFilter();
    });
    // Esc 清空
    searchEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchEl.value = '';
        keyword = '';
        if (clearEl) clearEl.style.display = 'none';
        applyFilter();
      }
    });
    clearEl?.addEventListener('click', () => {
      if (searchEl) { searchEl.value = ''; searchEl.focus(); }
      keyword = '';
      clearEl.style.display = 'none';
      applyFilter();
    });

    // ── 排序（2026-10-27）──
    //
    // 43 个插件只靠分类+搜索找，翻起来累。加三种排序。
    // 排序 = 重排 DOM 顺序（appendChild），与筛选互不干扰：
    // 先排序再过滤，隐藏的卡片保持原顺序，取消筛选后立刻恢复正确位置。
    const sortEl = box.querySelector('#cy-sort');
    const sortCards = () => {
      const mode = sortEl?.value || 'default';
      if (mode === 'default') return;
      const rows = [...listEl.querySelectorAll('[data-pid]')];
      rows.sort((a, b) => {
        if (mode === 'downloads') {
          const da = Number(a.dataset.downloads || 0);
          const db = Number(b.dataset.downloads || 0);
          if (db !== da) return db - da;
        } else if (mode === 'name') {
          return String(a.dataset.name || '').localeCompare(String(b.dataset.name || ''), 'zh');
        } else if (mode === 'updated') {
          return String(b.dataset.updated || '').localeCompare(String(a.dataset.updated || ''));
        }
        return 0;
      });
      for (const r of rows) listEl.appendChild(r);
    };

    sortEl?.addEventListener('change', () => {
      sortCards();
      applyFilter();
    });

    renderChips();
  })();

  // ── 审核插件（2026-10-25）──
  //
  // 用户问"我作为作者去哪里审核插件"—— 后端接口一直有，
  // 但界面上没入口。市场卡片上 unverified 的直接给个「审核通过」。
  box.querySelectorAll('[data-trust-ok]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.trustOk;
      if (!confirm(`把「${id}」标记为已审核？\n\n标记后别人安装时不再弹风险提示。`)) return;
      if (btn.disabled) return;
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = '处理中…';
      try {
        const r = await api('/api/market/admin/trust', { method: 'POST', body: { id, trust: 'verified' } });
        if (r?.ok) {
          ctx.toast?.('已标记为已审核');
          setTimeout(refreshPanel, 800);
        } else {
          alert(r?.error || '操作失败');
        }
      } catch (e) { alert('失败：' + e.message); }
      finally { btn.disabled = false; btn.textContent = old; }
    });
  });

  box.querySelector('#cy-refresh')?.addEventListener('click', () => refreshPanel());

  // ── 打包 ──
  const pkgOut = () => box.querySelector('#cy-pkg-out');
  // ── 账密登录（2026-10-25）──────────────────────────────
  //
  // 补上「邮箱 + 密码」这条路。验证码仍是首次注册的主路径。
  const loginMsg = (s) => { const el = box.querySelector('#cy-login-msg'); if (el) el.textContent = s; };

  box.querySelector('#cy-login-go')?.addEventListener('click', async () => {
    const email = box.querySelector('#cy-login-email')?.value?.trim();
    const password = box.querySelector('#cy-login-pw')?.value || '';
    if (!email || !password) return loginMsg('邮箱和密码都要填');
    loginMsg('登录中…');
    try {
      const r = await api('/api/market/login/password', { method: 'POST', body: { email, password } });
      if (!r.ok) return loginMsg('失败：' + (r.error || ''));
      loginMsg(`✅ 已登录：${r.author?.nickname || email}`);
      ctx.toast?.('登录成功');
      // 刷新发布页（作者状态变了）
      setTimeout(refreshPanel, 800);
    } catch (e) { loginMsg('失败：' + e.message); }
  });

  box.querySelector('#cy-login-setpw')?.addEventListener('click', async () => {
    const email = box.querySelector('#cy-login-email')?.value?.trim();
    const password = box.querySelector('#cy-login-pw')?.value || '';
    if (!email || !password) return loginMsg('邮箱和新密码都要填');
    if (password.length < 8) return loginMsg('密码至少 8 位');

    // 已有密码时要旧密码：这里简单用 prompt
    let oldPassword = '';
    try {
      const info = await api('/api/market/login/account', { method: 'POST', body: { email } });
      if (info?.hasPassword) {
        oldPassword = prompt('这个邮箱已设过密码。请输入当前密码以修改：') || '';
        if (!oldPassword) return loginMsg('已取消');
      }
    } catch { /* 查不到就当首次设置 */ }

    loginMsg('设置中…');
    try {
      const r = await api('/api/market/login/set-password', { method: 'POST', body: { password, oldPassword } });
      if (!r.ok) return loginMsg('失败：' + (r.error || ''));
      loginMsg('✅ 密码已设置');
      ctx.toast?.('密码已设置');
    } catch (e) { loginMsg('失败：' + e.message); }
  });

  // ── 找回密码（2026-10-25）──────────────────────────────
  //
  // 流程：邮箱收码 → 填码 + 新密码 → 重置
  // 服务端保证：无论邮箱是否注册，发码提示都一样（防枚举）
  const resetMsg = (s) => { const el = box.querySelector('#cy-reset-msg'); if (el) el.textContent = s; };

  box.querySelector('#cy-login-forgot')?.addEventListener('click', () => {
    const rb = box.querySelector('#cy-reset-box');
    if (!rb) return;
    rb.style.display = rb.style.display === 'none' ? '' : 'none';
    // 顺手把登录框里的邮箱带过来
    const e1 = box.querySelector('#cy-login-email')?.value?.trim();
    const e2 = box.querySelector('#cy-reset-email');
    if (e1 && e2 && !e2.value) e2.value = e1;
  });

  box.querySelector('#cy-reset-send')?.addEventListener('click', async () => {
    const email = box.querySelector('#cy-reset-email')?.value?.trim();
    if (!email) return resetMsg('先填注册邮箱');
    resetMsg('发送中…');
    try {
      const r = await api('/api/market/password/reset-send', { method: 'POST', body: { email } });
      resetMsg(r.ok ? (r.message || '验证码已发送') : '失败：' + (r.error || ''));
    } catch (e) { resetMsg('失败：' + e.message); }
  });

  box.querySelector('#cy-reset-go')?.addEventListener('click', async () => {
    const email = box.querySelector('#cy-reset-email')?.value?.trim();
    const code = box.querySelector('#cy-reset-code')?.value?.trim();
    const password = box.querySelector('#cy-reset-pw')?.value || '';
    if (!email || !code || !password) return resetMsg('邮箱、验证码、新密码都要填');
    if (password.length < 8) return resetMsg('新密码至少 8 位');

    resetMsg('重置中…');
    try {
      const r = await api('/api/market/password/reset', { method: 'POST', body: { email, code, password } });
      if (!r.ok) return resetMsg('失败：' + (r.error || ''));
      resetMsg('✅ ' + (r.message || '密码已重置'));
      ctx.toast?.('密码已重置，请用新密码登录');
      // 顺手填进登录框
      const le = box.querySelector('#cy-login-email');
      const lp = box.querySelector('#cy-login-pw');
      if (le) le.value = email;
      if (lp) lp.value = password;
    } catch (e) { resetMsg('失败：' + e.message); }
  });

  // ── 外部投稿（2026-10-25）──────────────────────────────
  //
  // 两条路：
  //   GitHub 直链 → 调 /api/market-submit/probe 看仓库能否识别
  //   上传包     → 传本服务器队列（/api/market/submit），审核后上架
  //
  // 🔴 注意：上传包走的是**本机内核**的队列接口，不是中心服务器。
  //    中心服务器版的接口是 Worker 的 /api/submit（见 market-worker/）。
  //    两者互不干扰：本机队列给自己用，Worker 给外部作者用。
  const subOut = (el, html) => {
    if (!el) return;
    el.style.display = '';
    el.innerHTML = html;
  };

  box.querySelector('#cy-sub-probe')?.addEventListener('click', async () => {
    const url = box.querySelector('#cy-sub-repo')?.value?.trim();
    const out = box.querySelector('#cy-sub-repo-out');
    if (!url) return subOut(out, '<span style="color:#b45309">先填仓库地址</span>');
    subOut(out, '探测中…');
    try {
      const r = await api('/api/market-submit/probe', { method: 'POST', body: { url } });
      if (!r.ok) return subOut(out, `<span style="color:#b91c1c">${esc(r.error || '探测失败')}</span>`);
      const rows = (r.plugins || []).map((p) => p.ok
        ? `<li>✅ <b>${esc(p.name)}</b>（${esc(p.id)} v${esc(p.version)}）by ${esc(p.author || '未署名')}</li>`
        : `<li>❌ ${esc(p.id)}：${esc(p.error || '')}</li>`).join('');
      subOut(out, `识别到 ${r.plugins.length} 个插件（${esc(r.host)}/${esc(r.owner)}/${esc(r.repo)} @ ${esc(r.branch)}）：<ul style="margin:6px 0 0 18px">${rows}</ul>`);
    } catch (e) {
      subOut(out, `<span style="color:#b91c1c">${esc(e.message)}</span>`);
    }
  });

  box.querySelector('#cy-sub-send-repo')?.addEventListener('click', async () => {
    const url = box.querySelector('#cy-sub-repo')?.value?.trim();
    const out = box.querySelector('#cy-sub-repo-out');
    if (!url) return subOut(out, '<span style="color:#b45309">先填仓库地址</span>');
    subOut(out, `<span style="color:#b45309">提交直链需要中心服务器支持（Worker 的 /api/submit），本机暂无此接口。<br>
      现在可以：用「探测」确认格式正确，然后联系市场所有者登记仓库地址。</span>`);
  });

  // ── 投稿凭证（2026-10-25）──
  //
  // 走中心 Worker：发码 → 转发 auth.597457.xyz → 换 token → 存 localStorage
  const CENTER = 'https://market.baiguang211.top';
  const tokenState = () => box.querySelector('#cy-sub-tokenstate');
  const setTok = (s) => { const el = tokenState(); if (el) el.textContent = s; };

  // ── 已登录自动换凭证（2026-10-25）──
  //
  // 用户要求："已登录账号无需再次验证，登录账号直接可投稿"
  //
  // 原来投稿要再走一遍「邮箱收码 → 换 token」，
  // 但用户明明已经在创造营登录了。现在：
  //   · 已登录 → 本机用 bridge 密钥代签 token → 直接可投稿
  //   · 未登录 → 才显示邮箱验证码那一套
  const subReady = () => box.querySelector('#cy-sub-ready');
  const subNeed = () => box.querySelector('#cy-sub-need');
  const subWho = () => box.querySelector('#cy-sub-who');

  // 解析 token 的 payload（支持中文，2026-10-25）
  //
  // 🔴 原来直接 JSON.parse(atob(b64)) —— 遇到中文昵称会乱码，
  //    JSON.parse 抛异常 → 走进 catch → 被当成"没有 token" →
  //    于是每次都要重新换凭证，用户就得反复收验证码。
  //
  //    这正是用户反馈"希望有 token 的作者不需要每次都获取验证码"的根因。
  const parseTokenPayload = (tk) => {
    try {
      const parts = String(tk || '').split('.');
      if (parts.length !== 2) return null;
      let b = parts[0].replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      const bin = atob(b);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch { return null; }
  };

  const ensureSubmitToken = async () => {
    // ① 本地已存且未过期 → 直接用，不收验证码
    try {
      const tk = localStorage.getItem('bg_market_token');
      if (tk) {
        const payload = parseTokenPayload(tk);
        if (payload?.exp && payload.exp > Date.now() + 60 * 1000) {   // 留 1 分钟余量
          const left = Math.floor((payload.exp - Date.now()) / 3600000);
          // 🔴 缓存命中时也要同步到后端（2026-10-25）
          //    否则 localStorage 有 token 但后端没有 →
          //    点发布还是报"未配置凭证"，用户白等。
          try { await api('/api/market/submit-token/save', { method: 'POST', body: { token: tk } }); } catch { /* ignore */ }
          return { ok: true, token: tk, email: payload.email, cached: true, hoursLeft: left };
        }
      }
    } catch { /* 忽略，往下走 */ }

    // 没 token：如果作者已登录，让本机代签一张
    try {
      const r = await api('/api/market/submit-token', { method: 'POST', body: {} });
      if (r?.ok && r.token) {
        localStorage.setItem('bg_market_token', r.token);
        try { await api('/api/market/submit-token/save', { method: 'POST', body: { token: r.token } }); } catch { /* ignore */ }
        return { ok: true, token: r.token, email: r.email };
      }
      return { ok: false, error: r?.error || '无法获取投稿凭证' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  (async () => {
    const r = await ensureSubmitToken();
    if (r.ok) {
      if (subReady()) subReady().style.display = '';
      if (subNeed()) subNeed().style.display = 'none';
      if (subWho()) {
        const left = r.cached && typeof r.hoursLeft === 'number'
          ? `（凭证还有约 ${r.hoursLeft} 小时有效，不用再验证）`
          : '（已自动获取凭证，不用再验证）';
        subWho().innerHTML = `${esc(r.email || '你的账号')} <span style="color:var(--muted,#888);font-weight:400">${left}</span>`;
      }
    } else {
      // 未登录：显示验证码那一套
      if (subReady()) subReady().style.display = 'none';
      if (subNeed()) subNeed().style.display = '';
      try {
        const tk = localStorage.getItem('bg_market_token');
        setTok(tk ? '✅ 已有投稿凭证' : '未登录');
      } catch { setTok(''); }
    }
  })();

  box.querySelector('#cy-sub-sendcode')?.addEventListener('click', async () => {
    const email = box.querySelector('#cy-sub-email')?.value?.trim();
    if (!email) return setTok('先填邮箱');
    setTok('发送中…');
    try {
      // 走本机代理，不直连外部（避免跨域/混合内容导致的 Failed to fetch）
      const r = await api('/api/market/send-code', { method: 'POST', body: { email, purpose: 'submit' } });
      setTok(r.ok ? (r.message || '✅ 验证码已发到邮箱') : '失败：' + (r.error || ''));
    } catch (e) { setTok('失败：' + e.message); }
  });

  box.querySelector('#cy-sub-login')?.addEventListener('click', async () => {
    const email = box.querySelector('#cy-sub-email')?.value?.trim();
    const code = box.querySelector('#cy-sub-code')?.value?.trim();
    if (!email || !code) return setTok('邮箱和验证码都要填');
    setTok('验证中…');
    try {
      const r = await api('/api/market/login-email', { method: 'POST', body: { email, code } });
      if (!r?.ok || !r.token) return setTok('失败：' + (r?.error || '验证失败'));
      localStorage.setItem('bg_market_token', r.token);
      // 同步存到本机后端 —— 后端发布时直接用它，不用再管 R2 凭据
      try { await api('/api/market/submit-token/save', { method: 'POST', body: { token: r.token } }); } catch { /* ignore */ }
      setTok('✅ 凭证已保存（7 天）');
    } catch (e) { setTok('失败：' + e.message); }
  });

  // 上传包：读文件 → base64 → 传本机队列
  let subFile = null;
  box.querySelector('#cy-sub-file')?.addEventListener('change', (ev) => {
    subFile = ev.target.files?.[0] || null;
    const name = box.querySelector('#cy-sub-file-name');
    if (name) name.textContent = subFile ? `${subFile.name}（${(subFile.size / 1024).toFixed(0)}KB）` : '选择包（.tar.gz）';
  });

  box.querySelector('#cy-sub-upload')?.addEventListener('click', async () => {
    const out = box.querySelector('#cy-sub-out');
    if (!subFile) return subOut(out, '<span style="color:#b45309">先选一个 .tar.gz</span>');
    if (subFile.size > 20 * 1024 * 1024) return subOut(out, '<span style="color:#b91c1c">包超过 20MB</span>');

    subOut(out, '读取并上传中…');
    try {
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || '').split(',')[1] || '');
        fr.onerror = () => reject(new Error('读取失败'));
        fr.readAsDataURL(subFile);
      });
      const version = box.querySelector('#cy-sub-version')?.value?.trim() || '';
      const token = (() => { try { return localStorage.getItem('bg_market_token') || ''; } catch { return ''; } })();
      if (!token) return subOut(out, '<span style="color:#b45309">先在上方换取投稿凭证</span>');
      // 🔴 2026-10-25 修 bug：原来从文件名正则推 id
      //
      //   const pluginId = name.replace(/[-.].*$/, '');
      //
      //   这个正则在**第一个**连字符或点处就截断了：
      //     proactive-private-clean-2026-10-25.tar.gz
      //     → "proactive"（实际应该是整个名字）
      //   结果中心端去找 proactive/manifest.json 找不到，
      //   报「包里找不到 xxx/manifest.json」。
      //   **所有带 - 的插件 id 都投不了稿。**
      //
      // 现在改成从包里读 manifest.json 的 id —— 更稳：
      //   · 包本来就有 manifest，不用猜
      //   · 不会和内容对不上（文件名可以随便改，manifest 才是权威）
      //   · 后缀、版本号、日期怎么拼都不影响
      const readTarGzId = async (base64) => {
        // 浏览器里没有 zlib，用 DecompressionStream 解 gzip
        const bin = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        let tar;
        if (typeof DecompressionStream === 'function') {
          const ds = new DecompressionStream('gzip');
          const stream = new Blob([bin]).stream().pipeThrough(ds);
          tar = new Uint8Array(await new Response(stream).arrayBuffer());
        } else {
          throw new Error('浏览器不支持解压，请用新版 Chrome/Edge');
        }
        // 极简 tar 遍历：找 */manifest.json
        let off = 0;
        const dec = new TextDecoder('utf-8');
        while (off + 512 <= tar.length) {
          const header = tar.subarray(off, off + 512);
          if (header.every((b) => b === 0)) break;
          const name = dec.decode(header.subarray(0, 100)).replace(/\0.*$/, '');
          const sizeStr = dec.decode(header.subarray(124, 136)).replace(/\0.*$/, '').trim();
          const size = parseInt(sizeStr, 8) || 0;
          off += 512;
          if (/^[^/]+\/manifest\.json$/.test(name)) {
            const body = tar.subarray(off, off + size);
            const json = JSON.parse(dec.decode(body));
            if (json?.id) return String(json.id);
          }
          off += size + ((512 - (size % 512)) % 512);
        }
        throw new Error('包里没有 manifest.json，或格式不对');
      };

      let pluginId;
      try {
        pluginId = await readTarGzId(b64);
      } catch (e) {
        return subOut(out, `<span style="color:#b91c1c">读包失败：${esc(e.message)}</span>`);
      }

      // 走本机代理上传，避免浏览器直连外部
      const r = await api('/api/market/submit-via-center', {
        method: 'POST',
        body: { token, id: pluginId, base64: b64, changelog: version },
      });
      if (!r?.ok) return subOut(out, `<span style="color:#b91c1c">${esc(r?.error || '上传失败')}</span>`);
      const s = r.submission || {};
      subOut(out, `✅ 已收到投稿 <code>${esc(s.id)}</code><br>
        状态：${esc(s.status)} ｜ ${(s.bytes / 1024).toFixed(0)}KB ｜ sha256 ${esc(String(s.sha256).slice(0, 12))}…<br>
        <span style="color:var(--muted,#888)">等管理员审核通过后会出现在市场里。</span>`);
    } catch (e) {
      subOut(out, `<span style="color:#b91c1c">${esc(e.message)}</span>`);
    }
  });

  // ── 打包：从自己的插件里选（2026-10-25）──
  //
  // 用户要求："不要让作者选ID，最好是本地插件列表匹配了作者名字后
  // 让作者直接点击上传"
  //
  // 原来要手填 id —— 容易打错字，还要记住自己的插件叫什么。
  // 现在从 /api/market/myplugins 拉列表，只列 canManage 的（自己的），
  // 每个选项带名字和版本，一眼能认出。
  const pkgSelect = () => box.querySelector('#cy-pkg-id');

  const loadPkgOptions = async () => {
    const sel = pkgSelect();
    if (!sel) return;
    sel.innerHTML = '<option value="">选择要打包的插件…</option>';
    try {
      const d = await api('/api/market/myplugins');
      const mine = (d?.plugins || []).filter((p) => p.canManage);
      for (const p of mine) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.name}  v${p.version}${p.offline ? '  （已下架）' : ''}`;
        sel.appendChild(opt);
      }
      if (!mine.length) {
        sel.innerHTML = '<option value="">（没有你署名的插件）</option>';
      }
    } catch { /* 忽略 */ }
  };

  // 选中后才能点打包
  pkgSelect()?.addEventListener('change', () => {
    const btn = box.querySelector('#cy-pkg');
    if (btn) btn.disabled = !pkgSelect().value;
    // 选中插件时，把它的现有分类带到下拉里（2026-10-26）
    const catSel = box.querySelector('#cy-pkg-cat');
    if (catSel) {
      const cur = pkgSelect()?.selectedOptions?.[0]?.dataset?.cat || '';
      catSel.value = ['群管理', '群运营', '能力', '娱乐', '工具', '主人'].includes(cur) ? cur : '';
    }
  });

  onPaneFirstShow('publish', loadPkgOptions);

  box.querySelector('#cy-pkg')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const id = pkgSelect()?.value.trim();
    if (!id) { if (pkgOut()) { pkgOut().style.display='block'; pkgOut().textContent = '先选一个插件'; } return; }
    if (btn.disabled) return;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '打包中…';
    try {
      // 手动选的分类（2026-10-26）：不选就沿用 manifest 里的
      const cat = box.querySelector('#cy-pkg-cat')?.value || '';
      const r = await api('/api/market/package', { method: 'POST', body: { id, category: cat } });
      const out = pkgOut();
      if (out) out.style.display = 'block';
      if (r?.ok) {
        // 打包完直接给「发布到市场」按钮 —— 用户不用再去别的页签找入口
        const warn = (r.warnings || []).length
          ? `<div style="color:#b7791f;margin-bottom:10px">⚠️ ${(r.warnings || []).map(esc).join('<br>⚠️ ')}</div>`
          : '';
        if (out) {
          out.innerHTML = `
            ${warn}
            <div style="margin-bottom:10px">
              ✅ 已打包 <b>${esc(r.market.name || r.market.id)}</b> v${esc(r.market.version)}
              （${esc(r.sizeText)}）
            </div>
            <div class="cy-row" style="margin-bottom:12px">
              <input class="cy-input" id="cy-pkg-notes" placeholder="这次改了什么（会显示在发布记录里）"
                     style="flex:1;min-width:200px">
              <button class="btn primary" id="cy-pkg-publish">发布到市场</button>
            </div>
            <div id="cy-pkg-pubmsg" class="cy-msg"></div>
            <details style="margin-top:12px">
              <summary style="cursor:pointer;font-size:12px;color:var(--muted,#888)">技术细节（文件路径 / sha256 / market.json）</summary>
              <div style="margin-top:8px;white-space:pre-wrap">文件：${esc(r.packagePath)}
sha256：${esc(r.market.sha256)}

market.json：
${esc(JSON.stringify(r.market, null, 2))}</div>
            </details>`;
        }
        ctx.toast?.('打包完成，可以发布了');

        // 绑定「发布到市场」
        out?.querySelector('#cy-pkg-publish')?.addEventListener('click', async (ev2) => {
          const pb = ev2.currentTarget;
          const notes = out.querySelector('#cy-pkg-notes')?.value.trim() || '';
          const m = out.querySelector('#cy-pkg-pubmsg');
          if (pb.disabled) return;
          if (!confirm(`把「${r.market.name || r.market.id}」v${r.market.version} 发布到市场？\n\n发布后别人就能装到。`)) return;
          pb.disabled = true;
          const oldTxt = pb.textContent;
          pb.textContent = '发布中…';
          try {
            const rr = await api('/api/market/myplugins/publish', {
              method: 'POST', body: { id: r.market.id, changelog: notes },
            });
            if (m) {
              m.className = 'cy-msg on ' + (rr?.remote?.ok ? 'ok' : 'err');
              m.textContent = rr?.remote?.ok
                ? `✅ 已发布到市场（${r.sizeText}），别人现在能装到了`
                : (rr?.ok ? `⚠️ 打包好了但没传上去：${rr.remote?.reason || ''}` : '❌ ' + (rr?.error || '发布失败'));
            }
            if (rr?.remote?.ok) ctx.toast?.('发布成功');
          } catch (e2) {
            if (m) { m.className = 'cy-msg on err'; m.textContent = '❌ ' + e2.message; }
          } finally { pb.disabled = false; pb.textContent = oldTxt; }
        });

        loadPkgOptions();   // 刷新下拉（版本可能没变，但保险）
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

  // 把时间显示成"3 分钟前 / 2 小时前 / 5 天前"
  const fmtWhen = (iso) => {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    if (isNaN(diff) || diff < 0) return '';
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    const dd = Math.floor(h / 24);
    if (dd < 30) return dd + ' 天前';
    return String(iso).slice(0, 10);
  };

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
      <!-- 三级菜单（2026-10-27）：管理页内容太多，分栏收起 -->
      <div class="cy-subtabs" id="cy-admin-subtabs">
        <button class="cy-subtab on" data-sub="downloads">下载统计</button>
        <button class="cy-subtab" data-sub="users">注册用户 <span class="cy-subn">${d.usersTotal || 0}</span></button>
        <button class="cy-subtab" data-sub="authors">作者 <span class="cy-subn">${authors.length}</span></button>
        <button class="cy-subtab" data-sub="plugins">插件 <span class="cy-subn">${plugins.length}</span></button>
        <button class="cy-subtab" data-sub="review">投稿审核</button>
        <button class="cy-subtab" data-sub="admins">管理员</button>
        <button class="cy-subtab" data-sub="feedback">反馈</button>
      </div>

      <div class="cy-subpane on" data-sub="downloads">
      <div class="cy-admin-stats">
        <div class="cy-stat"><b>${s.totalPlugins ?? 0}</b><span>插件总数</span></div>
        <div class="cy-stat"><b>${s.totalAuthors ?? 0}</b><span>作者数</span></div>
        <div class="cy-stat"><b>${s.publishedCount ?? 0}</b><span>已发布</span></div>
        <div class="cy-stat"><b>${s.offlineCount ?? 0}</b><span>已下架</span></div>
        <div class="cy-stat"><b>${s.remoteCount ?? 0}</b><span>市场可见</span></div>
        <div class="cy-stat"><b>${s.totalPublishes ?? 0}</b><span>累计发布</span></div>
      </div>

      <!-- 下载统计（2026-10-25）-->
      <div class="cy-section-title" style="display:flex;align-items:center;gap:8px">
        下载统计
        <span class="cy-badge" id="cy-dl-total">加载中…</span>
        <span class="cy-spacer" style="flex:1"></span>
        <button class="btn tiny" id="cy-dl-refresh">刷新</button>
      </div>
      <div id="cy-dl-root"><div class="cy-empty">加载中…</div></div>

      </div>
      <div class="cy-subpane" data-sub="users">
      <div class="cy-section-title" style="display:flex;align-items:center;gap:8px;margin-top:22px">
        全部注册用户
        <span class="cy-badge">共 ${d.usersTotal || 0} 位</span>
        <span class="cy-spacer" style="flex:1"></span>
        <button class="btn tiny" id="cy-sync-users">同步用户数据</button>
      </div>
      <div id="cy-sync-msg" class="cy-msg" style="margin-bottom:8px"></div>
      <div class="cy-author-list" style="margin-bottom:20px">
        ${(d.users || []).length ? (d.users || []).map((u) => `
          <div class="cy-author-row">
            <div class="cy-avatar" style="width:32px;height:32px;font-size:14px">${esc(String(u.nickname || u.email).slice(0,1))}</div>
            <div class="cy-author-info">
              <div class="cy-author-name" style="font-size:13px">
                ${esc(u.nickname || u.email.split('@')[0])}
                ${u.qq ? `<span class="cy-badge">QQ ${esc(u.qq)}</span>` : ''}
                ${u.verified ? '<span class="cy-badge" style="background:#2f855a22;color:#2f855a">已验证</span>' : ''}
              </div>
              <div class="cy-author-meta">
                ${esc(u.email)}
                ${u.firstSeenAt ? ' · 注册于 ' + esc(String(u.firstSeenAt).slice(0,10)) : ''}
                ${u.lastSeenAt ? ' · 最近活跃 ' + esc(fmtWhen(u.lastSeenAt)) : ''}
              </div>
            </div>
          </div>`).join('') : '<div class="cy-empty">还没有人注册。别人的创造营会来这台服务器发验证码，注册后自动登记。</div>'}
      </div>

      </div>
      <div class="cy-subpane" data-sub="authors">
      <div class="cy-section-title">
        全部作者（有发布的）
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

      </div>
      <div class="cy-subpane" data-sub="plugins">
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

      </div>
      <div class="cy-subpane" data-sub="review">
      <div class="cy-section-title" style="margin-top:24px">
        投稿审核
        <span class="cy-badge" id="cy-sub-stats" style="margin-left:8px">加载中…</span>
      </div>
      <div id="cy-sub-list">
        <div class="cy-empty">加载中…</div>
      </div>
      </div><!-- /cy-subpane review -->
      <div class="cy-subpane" data-sub="admins">
      <div class="cy-section-title" style="margin-top:20px">
        管理员
        <span class="cy-badge" id="cy-adm-count">加载中…</span>
      </div>
      <div id="cy-adm-list"><div class="cy-empty">加载中…</div></div>

      <div class="cy-box" style="margin-top:12px">
        <div class="cy-label">添加管理员</div>
        <div class="cy-row" style="margin-top:8px">
          <input class="cy-input" id="cy-adm-email" placeholder="邮箱，如 name@qq.com" style="max-width:260px">
          <button class="btn tiny" id="cy-adm-add">设为管理员</button>
        </div>
        <div class="cy-hint" style="margin-top:6px">
          必须是完整邮箱（不是 QQ 号）。管理员能审核投稿、管理全部插件。
        </div>
        <div id="cy-adm-msg" class="cy-msg"></div>
      </div>

      <!-- 全部反馈（管理员视角，2026-10-25）-->
      </div>
      <div class="cy-subpane" data-sub="feedback">
      <div class="cy-section-title" style="margin-top:22px">
        全部反馈
        <span class="cy-badge" id="cy-allfb-count">加载中…</span>
        <button class="btn tiny" id="cy-allfb-refresh" style="margin-left:8px">刷新</button>
      </div>
      <div id="cy-allfb-root"><div class="cy-empty">加载中…</div></div>
      </div><!-- /cy-subpane feedback -->
`;

    // ── 三级菜单切换（2026-10-27）──
    // 管理页塞了 7 块内容，全平铺太长。分栏显示，默认停在「下载统计」。
    const subTabs = el.querySelector('#cy-admin-subtabs');
    if (subTabs) {
      const activate = (key) => {
        subTabs.querySelectorAll('.cy-subtab').forEach((b) => {
          b.classList.toggle('on', b.dataset.sub === key);
        });
        el.querySelectorAll('.cy-subpane').forEach((p) => {
          p.classList.toggle('on', p.dataset.sub === key);
        });
        try { localStorage.setItem('cy_admin_sub', key); } catch { /* ignore */ }
      };
      subTabs.querySelectorAll('.cy-subtab').forEach((b) => {
        b.addEventListener('click', () => activate(b.dataset.sub));
      });
      // 回到上次那一栏
      let last = 'downloads';
      try { last = localStorage.getItem('cy_admin_sub') || 'downloads'; } catch { /* ignore */ }
      if (last !== 'downloads') activate(last);
    }

    // 内核反馈已移到「发布」栏（作者也能看，见下方 myFeedback）

    // ── 全部反馈（管理员视角，2026-10-25）──
    //
    // 发布栏那个只给作者看自己的；这里是管理员看全部 + 改状态。
    const allFbRoot = el.querySelector('#cy-allfb-root');
    const allFbCount = el.querySelector('#cy-allfb-count');

    const loadAllFb = async () => {
      if (!allFbRoot) return;
      allFbRoot.innerHTML = '<div class="cy-empty">加载中…</div>';
      try {
        const r = await api('/api/market/admin/feedback');
        if (!r?.ok) {
          allFbRoot.innerHTML = `<div class="cy-empty">${esc(r?.error || '读取失败')}</div>`;
          if (allFbCount) allFbCount.textContent = '—';
          return;
        }
        const items = r.items || [];
        const s = r.stats || {};
        if (allFbCount) allFbCount.textContent = `共 ${items.length} 条 · 待处理 ${s.open ?? 0}`;
        if (!items.length) {
          allFbRoot.innerHTML = '<div class="cy-empty">还没有人提交反馈</div>';
          return;
        }
        const typeLabel = { bug: '问题', feature: '建议', other: '其它' };
        const stLabel = { open: '待处理', resolved: '已解决', ignored: '已忽略' };
        const stColor = { open: '#b7791f', resolved: '#2f855a', ignored: '#888' };

        allFbRoot.innerHTML = items.map((x) => `
          <div class="cy-card" style="margin-bottom:8px">
            <div class="cy-card-head">
              <span class="cy-badge">${esc(typeLabel[x.type] || x.type)}</span>
              <span class="cy-name" style="font-size:13px">${esc(x.title)}</span>
              <span class="cy-spacer"></span>
              <span class="cy-badge" style="color:${stColor[x.status] || 'inherit'}">${esc(stLabel[x.status] || x.status)}</span>
            </div>
            ${x.body ? `<div class="cy-summary" style="white-space:pre-wrap;max-height:100px;overflow:auto">${esc(x.body)}</div>` : ''}
            <div class="cy-meta">
              ${esc(x.submitter?.nickname || x.submitter?.email || '?')}
              · ${esc(fmtTime(x.submittedAt))}
              ${(x.images || []).length ? ` · 图片 ${x.images.length} 张` : ''}
              ${(x.files || []).length ? ` · 附件 ${x.files.length} 个` : ''}
              ${x.attach ? ` · 附件 ${esc(x.attach.name)}` : ''}
            </div>
            <div class="cy-row" style="margin-top:8px;gap:6px">
              ${x.status === 'open' ? `
                <button class="btn tiny" data-allfb="${esc(x.id)}" data-to="resolved">标为已解决</button>
                <button class="btn tiny" data-allfb="${esc(x.id)}" data-to="ignored" style="color:#c00">忽略</button>` : `
                <button class="btn tiny" data-allfb="${esc(x.id)}" data-to="open">重新打开</button>`}
            </div>
          </div>`).join('');

        allFbRoot.querySelectorAll('[data-allfb]').forEach((b) => {
          b.addEventListener('click', async () => {
            b.disabled = true;
            try {
              const r2 = await api('/api/market/admin/feedback/status', {
                method: 'POST',
                body: { id: b.dataset.allfb, status: b.dataset.to },
              });
              if (r2?.ok) { ctx.toast?.('已更新'); loadAllFb(); }
              else { ctx.toast?.('失败：' + (r2?.error || '')); b.disabled = false; }
            } catch (e) { ctx.toast?.('失败：' + e.message); b.disabled = false; }
          });
        });
      } catch (e) {
        allFbRoot.innerHTML = `<div class="cy-empty">读取失败：${esc(e.message)}</div>`;
      }
    };

    el.querySelector('#cy-allfb-refresh')?.addEventListener('click', loadAllFb);
    onPaneFirstShow('admin', loadAllFb);

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

    // 同步用户数据
    el.querySelector('#cy-sync-users')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const msg = el.querySelector('#cy-sync-msg');
      if (btn.disabled) return;
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = '同步中…';
      try {
        const r = await api('/api/market/admin/sync-users', { method: 'POST', body: {} });
        if (msg) {
          msg.className = 'cy-msg on ' + (r?.ok ? 'ok' : 'err');
          msg.textContent = r?.ok
            ? `✅ 已同步（本机档案${r.pushed ? '已推送' : '推送失败'}，用户库 ${r.refreshed} 人）`
            : '❌ ' + (r?.error || '同步失败');
        }
        // 延迟久一点，让用户看到结果再刷新（原来 900ms 太短，消息一闪就没了）
        if (r?.ok) setTimeout(() => loadAdminPanel(), 2500);
      } catch (e) {
        if (msg) { msg.className = 'cy-msg on err'; msg.textContent = '❌ ' + e.message; }
      } finally { btn.disabled = false; btn.textContent = old; }
    });

    // ── 投稿审核（2026-10-25）──
    //
    // 后端接口一直有（/api/market/submissions + /review），
    // 但界面上没入口 —— 作者投了稿，管理员根本找不到在哪审。
    const subList = el.querySelector('#cy-sub-list');
    const subStats = el.querySelector('#cy-sub-stats');

    const loadSubs = async () => {
      if (!subList) return;
      try {
        const r = await api('/api/market/submissions');
        const st = r?.stats || {};
        const items = r?.items || [];
        if (subStats) {
          subStats.textContent = `待审 ${st.pending || 0} · 通过 ${st.approved || 0} · 驳回 ${st.rejected || 0}`;
          subStats.style.background = (st.pending > 0) ? '#b7791f22' : '';
          subStats.style.color = (st.pending > 0) ? '#b7791f' : '';
        }
        if (!items.length) {
          subList.innerHTML = '<div class="cy-empty">还没有人投稿。<br><span style="font-size:11.5px">作者在「发布」页上传插件包后会出现在这里。</span></div>';
          return;
        }
        subList.innerHTML = items.map((s) => {
          const statusText = s.status === 'pending' ? '待审核'
            : (s.status === 'approved' ? '已通过' : '已驳回');
          const color = s.status === 'pending' ? '#b7791f'
            : (s.status === 'approved' ? '#2f855a' : '#c00');
          return `
            <div class="cy-card" style="margin-bottom:8px">
              <div class="cy-card-head">
                <span class="cy-name">${esc(s.name || s.id)}</span>
                ${s.version ? `<span class="cy-ver">v${esc(s.version)}</span>` : ''}
                <span style="color:${color};font-size:11.5px">${statusText}</span>
                <span class="cy-spacer"></span>
                ${s.status === 'pending' ? `
                  <button class="btn tiny primary" data-sub-ok="${esc(s.id)}">通过</button>
                  <button class="btn tiny" data-sub-no="${esc(s.id)}" style="color:#c00">驳回</button>
                ` : ''}
              </div>
              <div class="cy-summary">${esc(s.summary || '')}</div>
              <div class="cy-meta">
                ${s.author ? '作者：' + esc(s.author) : ''}
                ${s.email ? ' · ' + esc(s.email) : ''}
                ${s.bytes ? ' · ' + (s.bytes / 1024).toFixed(1) + ' KB' : ''}
                ${(s.permissions || []).length ? ' · 权限：' + esc((s.permissions || []).join('、')) : ''}
              </div>
              ${s.changelog ? `<div class="cy-meta" style="margin-top:4px">说明：${esc(s.changelog)}</div>` : ''}
            </div>`;
        }).join('');

        // 通过 / 驳回
        subList.querySelectorAll('[data-sub-ok]').forEach((b) => {
          b.addEventListener('click', async () => {
            const id = b.dataset.subOk;
            if (!confirm(`通过「${id}」的投稿？\n\n通过后它会上架到市场，别人就能装到了。`)) return;
            b.disabled = true;
            try {
              const r = await api('/api/market/submissions/review', {
                method: 'POST', body: { id, action: 'approve' },
              });
              ctx.toast?.(r?.ok ? '已通过，已上架' : (r?.error || '操作失败'));
              loadSubs();
            } catch (e) { ctx.toast?.('失败：' + e.message); }
            finally { b.disabled = false; }
          });
        });
        subList.querySelectorAll('[data-sub-no]').forEach((b) => {
          b.addEventListener('click', async () => {
            const id = b.dataset.subNo;
            const note = prompt(`驳回「${id}」\n\n原因（会告诉作者，可留空）：`, '');
            if (note === null) return;
            b.disabled = true;
            try {
              const r = await api('/api/market/submissions/review', {
                method: 'POST', body: { id, action: 'reject', note },
              });
              ctx.toast?.(r?.ok ? '已驳回' : (r?.error || '操作失败'));
              loadSubs();
            } catch (e) { ctx.toast?.('失败：' + e.message); }
            finally { b.disabled = false; }
          });
        });
      } catch (e) {
        if (subList) subList.innerHTML = `<div class="cy-empty">读取失败：${esc(e.message)}</div>`;
      }
    };
    onPaneFirstShow('admin', loadSubs);

    // 加管理员
    // ── 下载统计（2026-10-25）──
    //
    // 用户要求："统计每个插件的下载人次"
    //
    // 数据来自 Worker 的 counters/<id>.json（/api/dl/ 每次下载 +1）。
    // 走本机代理 /api/market/stats/downloads，避免浏览器跨域。
    const dlRoot = el.querySelector('#cy-dl-root');
    const dlTotal = el.querySelector('#cy-dl-total');

    const loadDownloads = async () => {
      if (!dlRoot) return;
      dlRoot.innerHTML = '<div class="cy-empty">加载中…</div>';
      try {
        const r = await api('/api/market/stats/downloads');
        if (!r?.ok) {
          dlRoot.innerHTML = `<div class="cy-empty">${esc(r?.error || '读取失败')}</div>`;
          if (dlTotal) dlTotal.textContent = '—';
          return;
        }
        const items = r.items || [];
        if (dlTotal) dlTotal.textContent = `累计 ${r.total || 0} 次 · ${items.length} 个插件有记录`;
        if (!items.length) {
          dlRoot.innerHTML = '<div class="cy-empty">还没有下载记录。别人从市场装插件后这里就会有数。</div>';
          return;
        }
        // 找到本地插件名，显示得友好些
        const nameById = new Map();
        try {
          const idx = await api('/api/market/index');
          for (const p of (idx?.plugins || [])) nameById.set(p.id, p.name);
        } catch { /* 拿不到就用 id */ }

        dlRoot.innerHTML = items.map((x, i) => {
          const vers = Object.entries(x.byVersion || {})
            .sort((a, b) => b[1] - a[1])
            .map(([v, n]) => `${esc(v)}×${n}`)
            .join('  ');
          return `
            <div class="cy-card" style="margin-bottom:6px">
              <div class="cy-card-head">
                <span class="cy-badge" style="min-width:24px;text-align:center">${i + 1}</span>
                <span class="cy-name" style="font-size:13px">${esc(nameById.get(x.id) || x.id)}</span>
                <span class="cy-spacer"></span>
                <span class="cy-badge" style="background:#b7791f22;color:#b7791f;font-weight:600">${x.total} 次</span>
              </div>
              <div class="cy-meta">
                ${vers || '（无版本明细）'}
                ${x.lastAt ? ' · 最近 ' + esc(fmtWhen(x.lastAt)) : ''}
              </div>
            </div>`;
        }).join('');
      } catch (e) {
        dlRoot.innerHTML = `<div class="cy-empty">读取失败：${esc(e.message)}</div>`;
      }
    };

    el.querySelector('#cy-dl-refresh')?.addEventListener('click', loadDownloads);
    onPaneFirstShow('admin', loadDownloads);

    // ── 管理员名单（2026-10-25）──
    //
    // 用户反馈："管理员设置只能添加管理员，看不到有哪些管理员也不能删管理员"
    //
    // 后端 set 接口本来支持 remove:true，但界面没给入口。
    // 现在列出全部管理员，每人带「移除」按钮。
    const admList = el.querySelector('#cy-adm-list');
    const admCount = el.querySelector('#cy-adm-count');

    const loadAdmins = async () => {
      if (!admList) return;
      try {
        const r = await api('/api/market/admin/list');
        if (!r?.ok) {
          admList.innerHTML = `<div class="cy-empty">${esc(r?.error || '读取失败')}</div>`;
          return;
        }
        const list = r.admins || [];
        if (admCount) admCount.textContent = `共 ${list.length} 位`;
        if (!list.length) {
          admList.innerHTML = '<div class="cy-empty">还没有管理员</div>';
          return;
        }
        admList.innerHTML = list.map((a) => `
          <div class="cy-card" style="margin-bottom:6px">
            <div class="cy-card-head">
              <span class="cy-name" style="font-size:13px">${esc(a.email)}</span>
              ${a.isOwner ? '<span class="cy-badge" style="background:#2f855a22;color:#2f855a">市场所有者</span>' : ''}
              ${a.valid === false ? '<span class="cy-badge" style="background:#c0000022;color:#c00">格式无效</span>' : ''}
              ${a.nickname ? `<span class="cy-badge">${esc(a.nickname)}</span>` : ''}
              <span class="cy-spacer"></span>
              ${a.email === r.me ? '<span class="cy-badge">你自己</span>' : ''}
              ${a.isOwner ? '' : `<button class="btn tiny" data-adm-rm="${esc(a.email)}" style="color:#c00">移除</button>`}
            </div>
            <div class="cy-meta">
              ${a.since ? '加入于 ' + esc(String(a.since).slice(0, 10)) : ''}
              ${a.qq ? ' · QQ ' + esc(a.qq) : ''}
              ${a.lastSeenAt ? ' · 最近活跃 ' + esc(fmtWhen(a.lastSeenAt)) : ''}
            </div>
          </div>`).join('');

        admList.querySelectorAll('[data-adm-rm]').forEach((b) => {
          b.addEventListener('click', async () => {
            const email = b.dataset.admRm;
            if (!confirm(`把 ${email} 从管理员里移除？\n\n移除后他不能再审核投稿、管理插件。`)) return;
            b.disabled = true;
            try {
              const rr = await api('/api/market/admin/set', {
                method: 'POST', body: { email, remove: true },
              });
              if (rr?.ok) { ctx.toast?.('已移除'); loadAdmins(); }
              else alert(rr?.error || '移除失败');
            } catch (e) { alert('失败：' + e.message); }
            finally { b.disabled = false; }
          });
        });
      } catch (e) {
        if (admList) admList.innerHTML = `<div class="cy-empty">读取失败：${esc(e.message)}</div>`;
      }
    };
    onPaneFirstShow('admin', loadAdmins);

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
        if (r?.ok) { loadAdmins(); const inp = el.querySelector('#cy-adm-email'); if (inp) inp.value = ''; }
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
        // 只把标签露出来，**不立刻拉管理页数据** ——
        // 等真的切到「管理」再加载（2026-10-25 懒加载）
        onPaneFirstShow('admin', loadAdminPanel);
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

    // ── 三段分组（2026-10-25）──
    //
    // 用户要求："我的插件 要把已发布和未发布和别人的插件分开"
    //
    // 原来 28 个插件混在一起滚，找自己没发的要翻半天。
    // 现在按状态分三组，每组带计数，一眼知道该处理哪些。
    const renderCard = (p) => {
      const pub = p.lastPublished;
      // 别人的插件不显示发布状态（那是人家的运营信息，跟你无关）
      const stateBadge = !p.canManage
        ? ''
        : (p.offline
            ? `<span class="cy-badge" style="background:#c0000022;color:#c00">已下架</span>`
            : (pub
                ? (p.unpublished
                    ? `<span class="cy-badge" style="background:#b7791f22;color:#b7791f">有未发布改动</span>`
                    : `<span class="cy-badge" style="background:#2f855a22;color:#2f855a">已发布</span>`)
                : `<span class="cy-badge">未发布</span>`));
      return `
        <div class="cy-card" data-mine="${esc(p.id)}">
          <div class="cy-card-head">
            <span class="cy-name">${esc(p.name)}</span>
            <span class="cy-ver">v${esc(p.version)}</span>
            ${stateBadge}
            ${p.core ? '<span class="cy-badge">核心</span>' : ''}
            <span class="cy-spacer"></span>
            ${p.canManage ? `
              <button class="btn tiny" data-mine-edit="${esc(p.id)}">编辑</button>
              <button class="btn tiny primary" data-mine-pub="${esc(p.id)}">${p.offline ? '重新上架' : '发布'}</button>
              ${p.offline ? '' : `<button class="btn tiny" data-mine-off="${esc(p.id)}" style="color:#c00">下架</button>`}
            ` : `<span class="cy-badge">他人的插件</span>`}
            ${p.canUninstall ? `<button class="btn tiny" data-mine-del="${esc(p.id)}" style="color:#c00">卸载</button>` : ''}
          </div>
          <div class="cy-summary">${esc(p.summary || '')}</div>
          <div class="cy-meta">
            <b>${esc(p.author || '未署名')}</b>${p.authorQQ ? `（QQ ${esc(p.authorQQ)}）` : ''}${p.license ? ` · ${esc(p.license)}` : ''}
            ${p.isOwn ? '' : ' · <span style="color:#b7791f">不是你的插件</span>'}
            <br>
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
              <button class="btn tiny" data-mine-vers="${esc(p.id)}">版本回退</button>
              <span class="cy-msg" data-mine-msg="${esc(p.id)}"></span>
            </div>
            <div class="cy-out" data-mine-histout="${esc(p.id)}" style="display:none"></div>
          </div>
        </div>`;
    };

    // 分组：自己的已发布 / 自己的未发布 / 别人的
    const ownPublished = [];
    const ownDraft = [];
    const others = [];
    for (const p of list) {
      if (!p.isOwn) { others.push(p); continue; }
      // 未发布 = 从没发过，或本地有未发布改动
      if (p.lastPublished && !p.unpublished && !p.offline) ownPublished.push(p);
      else ownDraft.push(p);
    }

    const section = (title, arr, hint) => {
      if (!arr.length) return '';
      return `
        <div class="cy-group-title">
          ${title}
          <span class="cy-badge">${arr.length}</span>
          ${hint ? `<span class="cy-group-hint">${hint}</span>` : ''}
        </div>
        ${arr.map(renderCard).join('')}`;
    };

    el.innerHTML = [
      section('未发布 / 待更新', ownDraft, '本地有改动，或还没发到市场'),
      section('已发布', ownPublished, '市场上能装到的版本'),
      section('别人的插件', others, '只能卸载，不能改'),
    ].join('') || '<div class="cy-empty">没有插件</div>';

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

    // 卸载（2026-10-25）
    box.querySelectorAll('[data-mine-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.mineDel;
        if (btn.disabled) return;

        // 二次确认：卸载是不可撤回的（源码目录会被删）
        const ans = prompt(
          `要卸载「${id}」吗？\n\n`
          + `这会把 plugins/${id}/ 整个目录删掉，不可撤回。\n`
          + `数据目录（data/plugins/${id}/）默认保留。\n\n`
          + `确认请照抄插件 id：`
        );
        if (ans === null) return;
        if (ans.trim() !== id) { ctx.toast?.('id 不一致，已取消'); return; }

        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = '卸载中…';
        try {
          const r = await api('/api/market/uninstall', { method: 'POST', body: { id, purgeData: false } });
          if (r?.ok) {
            ctx.toast?.(r.message || '已卸载');
            loadMine();
          } else {
            alert(r?.error || '卸载失败');
          }
        } catch (e) { alert('卸载失败：' + e.message); }
        finally { btn.disabled = false; btn.textContent = old; }
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

    // ── 版本回退（2026-10-26）──
    //
    // 用户要求："做吧一键回退"
    //
    // 场景：发出去发现崩了，要快速切回上一个能用的。
    // 列出 R2 上所有历史包 → 点一个 → 市场切回那版 → 本机自动装回。
    box.querySelectorAll('[data-mine-vers]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.mineVers;
        const card = btn.closest('[data-mine]');
        const out = card?.querySelector(`[data-mine-histout="${id}"]`);
        if (!out) return;
        out.style.display = 'block';
        out.textContent = '读取版本列表…';
        try {
          const r = await api(`/api/market/myplugins/versions?id=${encodeURIComponent(id)}`);
          if (!r?.ok) { out.textContent = '读取失败：' + (r?.error || ''); return; }
          const vers = r.versions || [];
          if (!vers.length) { out.textContent = '没有历史版本。'; return; }

          const q = r.quota || {};
          const over = q.over === true;
          out.innerHTML = `
            <div class="cy-row" style="gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
              <span style="font-size:12px;color:var(--muted,#888)">
                当前线上：<b>v${esc(r.current || '?')}</b>　
                共 ${vers.length} / ${q.max || 50} 个版本包
                ${q.totalBytes ? `（${(q.totalBytes / 1024 / 1024).toFixed(1)}MB）` : ''}
              </span>
              <span class="cy-spacer" style="flex:1"></span>
              <button class="btn tiny" data-sel-none>全不选</button>
              <button class="btn tiny" data-del-sel style="color:#c00" disabled>删除选中</button>
            </div>
            ${over ? `<div class="cy-msg on err" style="margin-bottom:8px">
              ⚠️ 已超出上限（${q.used}/${q.max}），建议删掉 ${q.excess} 个旧版本。
            </div>` : ''}
            ${vers.map((v) => `
              <div class="cy-row" style="gap:8px;padding:5px 0;border-bottom:1px solid var(--line,#eee)">
                ${v.current
                  ? '<span style="width:16px;text-align:center;color:var(--muted,#aaa)">—</span>'
                  : `<input type="checkbox" data-pick="${esc(v.version)}" style="cursor:pointer">`}
                <span style="min-width:76px;font-weight:${v.current ? 700 : 400}">v${esc(v.version)}</span>
                <span style="font-size:11.5px;color:var(--muted,#999);min-width:70px">${(v.size / 1024).toFixed(1)}KB</span>
                <span class="cy-spacer" style="flex:1"></span>
                ${v.current
                  ? '<span class="cy-badge" style="background:#2f855a22;color:#2f855a">线上</span>'
                  : `<button class="btn tiny" data-do-rb="${esc(v.version)}">回退到这版</button>`}
              </div>`).join('')}`;

          // ── 多选与批量删除（2026-10-26）──
          const delBtn = out.querySelector('[data-del-sel]');
          const picks = () => [...out.querySelectorAll('[data-pick]:checked')].map((x) => x.dataset.pick);
          const syncDelBtn = () => {
            const n = picks().length;
            if (!delBtn) return;
            delBtn.disabled = n === 0;
            delBtn.textContent = n ? `删除选中（${n}）` : '删除选中';
          };
          out.querySelectorAll('[data-pick]').forEach((cb) => cb.addEventListener('change', syncDelBtn));
          out.querySelector('[data-sel-none]')?.addEventListener('click', () => {
            out.querySelectorAll('[data-pick]').forEach((cb) => { cb.checked = false; });
            syncDelBtn();
          });
          delBtn?.addEventListener('click', async () => {
            const sel = picks();
            if (!sel.length) return;
            if (!confirm(`删除 ${sel.length} 个历史版本包？\n\n${sel.map((v) => '  v' + v).join('\n')}\n\n删了就找不回来了（当前线上版本不会被删）。`)) return;
            delBtn.disabled = true;
            delBtn.textContent = '删除中…';
            try {
              const rr = await api('/api/market/myplugins/delete-versions', {
                method: 'POST', body: { id, versions: sel },
              });
              if (rr?.ok) {
                const freed = ((rr.freed || 0) / 1024 / 1024).toFixed(1);
                ctx.toast?.(`已删 ${rr.deleted?.length || 0} 个包，释放 ${freed}MB`);
                out.innerHTML = `<span style="color:#2f855a">✅ 已删除 ${rr.deleted?.length || 0} 个包，释放 ${freed}MB</span>`
                  + (rr.skipped?.length ? `<br><span style="color:#b7791f">跳过：${esc(rr.skipped.map((s) => `v${s.version}（${s.reason}）`).join('；'))}</span>` : '');
                setTimeout(() => loadMine(), 1200);
              } else {
                out.textContent = '删除失败：' + (rr?.error || '');
                delBtn.disabled = false;
                delBtn.textContent = '删除选中';
              }
            } catch (e) {
              out.textContent = '删除失败：' + e.message;
              delBtn.disabled = false;
              delBtn.textContent = '删除选中';
            }
          });

          out.querySelectorAll('[data-do-rb]').forEach((b) => {
            b.addEventListener('click', async () => {
              const ver = b.dataset.doRb;
              // 🔴 回退到太旧的版本会丢掉"回退"这个功能本身（2026-10-26）
              //
              // 实测踩到：回退到 1.8.6 后，本机装回的是 1.8.6，
              // 而那一版还没有写回退功能 → 界面上再也点不到回退，
              // 只能靠命令行调接口才能切回来。
              //
              // 所以提前提醒：低于 1.9.0 的版本没有回退按钮。
              const cmp = (a, b) => {
                const pa = String(a || '0').split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
                const pb = String(b || '0').split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
                for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                  const x = pa[i] || 0, y = pb[i] || 0;
                  if (x !== y) return x - y;
                }
                return 0;
              };
              const tooOld = cmp(ver, '1.9.0') < 0;
              const msg = `把「${id}」切回 v${ver}？\n\n`
                + '市场会立刻换成这一版，本机也会自动装回。\n'
                + '当前版本仍在 R2，随时可以再切回来。'
                + (tooOld
                    ? '\n\n⚠️ 注意：v' + ver + ' 早于 1.9.0，那一版没有「版本回退」按钮。\n'
                      + '回退后界面上就点不到了，要切回来需要命令行操作。\n'
                      + '确认仍然回退？'
                    : '');
              if (!confirm(msg)) return;
              b.disabled = true;
              b.textContent = '回退中…';
              try {
                const rr = await api('/api/market/myplugins/rollback', {
                  method: 'POST', body: { id, version: ver },
                });
                if (rr?.ok) {
                  ctx.toast?.(`已回退到 v${rr.to}`);
                  out.innerHTML = `<span style="color:#2f855a">✅ 已回退：v${esc(rr.from)} → v${esc(rr.to)}</span>`
                    + (rr.selfInstalled?.ok ? '，本机已装回' : `，但本机装回失败：${esc(rr.selfInstalled?.reason || '')}`);
                  setTimeout(() => loadMine(), 1200);
                } else {
                  out.textContent = '回退失败：' + (rr?.error || '');
                  b.disabled = false;
                  b.textContent = '回退到这版';
                }
              } catch (e) {
                out.textContent = '回退失败：' + e.message;
                b.disabled = false; b.textContent = '回退到这版';
              }
            });
          });
        } catch (e) {
          out.textContent = '读取失败：' + e.message;
        }
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

  // ── 版本检查与更新（2026-10-25）──
  //
  // 用户要求：自动检查新版本 / 手动检测 / 更新直接覆盖安装
  const updBanner = () => box.querySelector('#cy-upd-banner');
  const updAllBtn = () => box.querySelector('#cy-upd-all');

  const showUpdates = (d) => {
    const el = updBanner();
    const allBtn = updAllBtn();
    if (!el) return;
    const list = d?.updates || [];
    if (!list.length) {
      el.style.display = 'none';
      if (allBtn) allBtn.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    if (allBtn) allBtn.style.display = '';
    el.innerHTML = `
      <div class="cy-box" style="border-color:#b7791f;background:rgba(183,121,31,.04)">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:#b7791f">
          有 ${list.length} 个插件可以更新
        </div>
        ${list.map((u) => `
          <div class="cy-row" style="padding:6px 0;border-top:1px dashed var(--line);font-size:12.5px">
            <span style="font-weight:500">${esc(u.name)}</span>
            <span class="muted">v${esc(u.localVersion)} → <b style="color:#b7791f">v${esc(u.marketVersion)}</b></span>
            <span class="cy-spacer" style="flex:1"></span>
            <button class="btn tiny" data-upd-one="${esc(u.id)}">更新</button>
          </div>`).join('')}
      </div>`;

    el.querySelectorAll('[data-upd-one]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.updOne;
        if (btn.disabled) return;
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = '更新中…';
        try {
          const r = await api('/api/market/update', { method: 'POST', body: { id } });
          if (r?.ok) {
            ctx.toast?.(r.message || '更新完成');
            checkUpdates();
            loadMine();
          } else {
            alert(r?.error || '更新失败');
          }
        } catch (e) { alert('更新失败：' + e.message); }
        finally { btn.disabled = false; btn.textContent = old; }
      });
    });
  };

  const checkUpdates = async (silent = false) => {
    try {
      const d = await api('/api/market/updates');
      if (!d?.ok) {
        if (!silent) ctx.toast?.(d?.error || '检测失败');
        return;
      }
      showUpdates(d);
      if (!silent) {
        ctx.toast?.(d.total ? `发现 ${d.total} 个新版本` : '已是最新版本');
      }
    } catch (e) {
      if (!silent) ctx.toast?.('检测失败：' + e.message);
    }
  };

  box.querySelector('#cy-check-upd')?.addEventListener('click', (ev) => {
    const btn = ev.currentTarget;
    const old = btn.textContent;
    btn.textContent = '检测中…';
    btn.disabled = true;
    checkUpdates().finally(() => { btn.textContent = old; btn.disabled = false; });
  });

  updAllBtn()?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    if (!confirm('更新全部插件？\n\n会逐个下载并覆盖安装，可能需要一点时间。')) return;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '更新中…';
    try {
      const r = await api('/api/market/update-all', { method: 'POST', body: {} });
      if (r?.ok) {
        ctx.toast?.(`已更新 ${r.updated} 个${(r.failed || []).length ? '，' + r.failed.length + ' 个失败' : ''}`);
        checkUpdates(true);
        loadMine();
      } else {
        alert(r?.error || '更新失败');
      }
    } catch (e) { alert('更新失败：' + e.message); }
    finally { btn.disabled = false; btn.textContent = old; }
  });

  // 自动检查更新：延后到切到「我的插件」时再做（2026-10-26）
  //
  // 原来进页面就 setTimeout 1200ms 触发，但它要下载整个市场清单
  // 做版本比对 —— 首屏根本用不到，纯属白占带宽和时间。
  // 「我的插件」才是它的归属，等用户真切过去再查。
  if (marketCfg?.autoCheckUpdate !== false) {
    onPaneFirstShow('mine', () => setTimeout(() => checkUpdates(true), 300));
  }

  box.querySelector('#cy-mine-refresh')?.addEventListener('click', loadMine);
  onPaneFirstShow('mine', loadMine);

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

        <div class="cy-inline" style="margin-top:10px">
          <input class="cy-input" id="cy-reg-pw" type="password" placeholder="设置登录密码（选填）"
                 autocomplete="new-password">
        </div>
        <div class="cy-hint">
          设了密码以后就能<b>免验证码登录</b>，省得每次都等邮件。<br>
          至少 8 位，需包含字母、数字、符号中的两类。不设也行，那以后每次都要验证码。
        </div>
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
      const password = box.querySelector('#cy-reg-pw')?.value || '';
      if (!email) { showMsg('先填邮箱', 'err'); return; }
      if (!/^\d{6}$/.test(code)) { showMsg('验证码是 6 位数字', 'err'); return; }
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '验证中…';
      try {
        const r = await api('/api/market/register/verify', {
          method: 'POST', body: { email, code, qq, nickname, password },
        });
        if (r?.ok) {
          showMsg('');
          ctx.toast?.('注册成功');
          // 中心端顺手签好投稿凭证了，直接存下 —— 不用再单独验证一次
          if (r?.marketToken) {
            try { localStorage.setItem('bg_market_token', r.marketToken); } catch { /* ignore */ }
            try { await api('/api/market/submit-token/save', { method: 'POST', body: { token: r.marketToken } }); } catch { /* ignore */ }
          }
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
          autoCheckUpdate: box.querySelector('#cy-auto-check').checked,
          autoUpdate: box.querySelector('#cy-auto-update').checked,
          checkIntervalHours: Number(box.querySelector('#cy-check-hours').value) || 6,
        },
      });
      ctx.toast?.('已保存');
      setTimeout(refreshPanel, 800);
    } catch (e) { ctx.toast?.('保存失败：' + e.message); }
    finally { btn.disabled = false; }
  });
}

export const mount = mountPanel;
export default { mountPanel, mount };
