// ══════════════════════════════════════════════════════════════
//  file-recv · 配置面板
// ══════════════════════════════════════════════════════════════

export async function mountPanel(box, ctx) {
  const { $, api, bindPanelClose, esc, panelShell, savePluginConfig } = ctx;
  const d = await api('/api/plugins/file-recv/status');
  const c = d.config || {};
  const env = d.env || {};

  box.innerHTML = panelShell('file-recv', '文件接收', `
    <div class="row" style="gap:12px;flex-wrap:wrap;font-size:12.5px;margin-bottom:12px">
      <span>工作区：<code>${esc(env.workspace || '?')}</code></span>
      <span>NapCat 目录：${env.napcatFound ? '✅ 找到' : '<span style="color:#c00">❌ 未找到</span>'}</span>
    </div>
    <div class="muted" style="font-size:12px;line-height:1.8">
      本插件补的是内核 <code>receive_file</code> 的短板：<br>
      内核只认 NapCat 返回的 <b>http 下载地址</b>，但群文件通常只返回
      <b>本地路径</b>（如 <code>/home/qqtest/.config/QQ/NapCat/temp/xxx.gz</code>），
      于是永远取不到。本插件用<b>同机直读</b>把文件复制到工作区。<br><br>
      <b>工具：</b><br>
      · <code>fetch_file(messageId?)</code> —— 取文件（不给 id 就找最近的）<br>
      · <code>list_napcat_files()</code> —— 列 NapCat 收件目录，排查用
    </div>
    <div class="row" style="gap:12px;flex-wrap:wrap;margin-top:12px">
      <label>工作区目录
        <input id="fr-ws" value="${esc(c.workspaceDir || '')}"
               placeholder="留空用 data/inbox"
               style="width:280px" />
      </label>
    </div>

    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
      <div style="font-size:13px;font-weight:600;margin-bottom:6px">可读目录白名单</div>
      <div class="muted" style="font-size:12.5px;line-height:1.7;margin-bottom:8px">
        除了内置范围（项目目录、<code>data/inbox</code>、NapCat 收件目录、<code>/tmp</code>），
        你可以再授权几个目录让她读。<b>一行一个绝对路径</b>。
      </div>
      <textarea id="fr-roots" rows="4"
        placeholder="/home/lyy/鱼鱼的工作目录&#10;/mnt/disk2/share"
        style="width:100%;font-family:var(--mono,monospace);font-size:12.5px">${esc(c.extraRoots || '')}</textarea>
      <div class="muted" style="font-size:12px;margin-top:4px">
        只接受绝对路径；写 <code>/</code> 会被忽略（那等于把整个文件系统交出去）。
      </div>

      <div style="margin-top:14px;padding:10px 12px;border:1px solid var(--line);border-radius:var(--r)">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="fr-allowall" ${c.allowAll === true ? 'checked' : ''} />
          <span style="font-size:13px;font-weight:600">允许读取任意路径（不推荐）</span>
        </label>
        <div style="font-size:12px;color:var(--err);line-height:1.7;margin-top:6px">
          ⚠️ 打开后她可以读整台机器上的任何文件 —— 包括 SSH 私钥、
          其他项目的配置、浏览器数据。<b>只在完全信任的环境下开</b>，
          比如自己的测试机。公网部署或给别人用的机器，保持关闭。
        </div>
      </div>
    </div>

    <div class="row" style="gap:8px;margin-top:14px">
      <button class="btn primary" id="fr-save">保存</button>
      <span id="fr-out" class="muted" style="font-size:12px"></span>
    </div>`,
    '接收群文件到本地工作区；弥补内核 receive_file 只认 http 地址的短板');

  bindPanelClose(box);

  $('#fr-save')?.addEventListener('click', async () => {
    try {
      await savePluginConfig('file-recv', {
        workspaceDir: $('#fr-ws').value.trim(),
        extraRoots: $('#fr-roots')?.value.trim() || '',
        allowAll: $('#fr-allowall')?.checked === true
      });
      $('#fr-out').textContent = '✅ 已保存';
    } catch (e) {
      $('#fr-out').textContent = '❌ ' + e.message;
    }
  });
}

export default { mountPanel };
