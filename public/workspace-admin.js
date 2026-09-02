const panel = document.querySelector('#workspace-admin-panel');
const root = document.querySelector('#workspace-admin-root');

if (panel && root) {
  const state = {
    workspace: null,
    backups: [],
    invitations: [],
    syncs: [],
    message: '',
    loading: false,
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.error || `请求失败（${response.status}）`);
      error.httpStatus = response.status;
      throw error;
    }
    return payload;
  }

  function render() {
    const workspace = state.workspace;
    const isAdmin = workspace?.user?.role === 'admin';
    panel.classList.toggle('is-hidden', !isAdmin);
    if (!isAdmin) return;
    if (state.loading) {
      root.innerHTML = '<div class="panel workspace-admin-card"><div class="empty-state compact"><span>↻</span><p>正在读取工作区成员、邀请、连接器和备份……</p></div></div>';
      return;
    }

    const users = workspace.users || [];
    const projects = workspace.projects || [];
    const customers = workspace.customers || [];
    const brandProfiles = workspace.brandProfiles || [];
    const connectors = workspace.connectors || [];
    const backups = Array.isArray(state.backups) ? state.backups : [];
    const invitations = Array.isArray(state.invitations) ? state.invitations : [];
    const syncs = Array.isArray(state.syncs) ? state.syncs : [];
    const projectOptions = ['<option value="">不绑定项目</option>', ...projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`)].join('');
    const customerOptions = ['<option value="">选择客户上下文</option>', ...customers.map((customer) => `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.name)}</option>`)].join('');
    const customerRows = customers.length
      ? customers.map((customer) => `<tr><td><strong>${escapeHtml(customer.name)}</strong><small>${escapeHtml(customer.id)}</small></td><td>${escapeHtml(customer.industry || '—')}</td><td>${escapeHtml(customer.status)}</td></tr>`).join('')
      : '<tr><td colspan="3" class="admin-empty">暂无客户上下文</td></tr>';
    const brandProfileRows = brandProfiles.length
      ? brandProfiles.map((profile) => `<tr><td><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(profile.id)}</small></td><td>${escapeHtml(projects.find((project) => project.id === profile.projectId)?.name || profile.projectId)}</td><td>${escapeHtml(customers.find((customer) => customer.id === profile.customerId)?.name || profile.customerId)}</td></tr>`).join('')
      : '<tr><td colspan="3" class="admin-empty">当前项目暂无品牌资料</td></tr>';
    const memberRows = users.length
      ? users.map((user) => `<tr><td><strong>${escapeHtml(user.displayName || user.username)}</strong><small>${escapeHtml(user.username)}</small></td><td>${escapeHtml(user.role === 'admin' ? '管理员' : '客户成员')}</td><td>${escapeHtml(user.tenantId)}</td><td>${escapeHtml(user.status)}</td><td><button class="button button-quiet" type="button" data-toggle-member="${escapeHtml(user.username)}" data-next-status="${user.status === 'disabled' ? 'active' : 'disabled'}">${user.status === 'disabled' ? '启用' : '停用'}</button></td></tr>`).join('')
      : '<tr><td colspan="5" class="admin-empty">暂无持久化成员</td></tr>';
    const projectMemberRows = (workspace.projectMembers || []).length
      ? workspace.projectMembers.map((member) => `<tr><td>${escapeHtml(member.displayName || member.username)}</td><td>${escapeHtml(member.memberRole)}</td><td><button class="button button-quiet" type="button" data-remove-project-member="${escapeHtml(member.username)}">移除</button></td></tr>`).join('')
      : '<tr><td colspan="3" class="admin-empty">当前项目暂无成员</td></tr>';
    const connectorCards = connectors.length
      ? connectors.map((connector) => {
          const platform = connector.config?.platform || '';
          const permissions = [...new Set(['use', ...(connector.capabilities || [])])];
          return `<article class="workspace-connector-card"><div class="workspace-admin-card-heading"><div><strong>${escapeHtml(connector.name)}</strong><small>${escapeHtml(connector.kind)} · ${escapeHtml(connector.id)}</small></div><span class="phase-label">${escapeHtml(connector.status)}</span></div><form data-connector-form="${escapeHtml(connector.id)}" class="workspace-inline-form"><select name="status" aria-label="连接器状态"><option value="not_configured"${connector.status === 'not_configured' ? ' selected' : ''}>未配置</option><option value="ready"${connector.status === 'ready' ? ' selected' : ''}>可用</option><option value="degraded"${connector.status === 'degraded' ? ' selected' : ''}>降级</option><option value="revoked"${connector.status === 'revoked' ? ' selected' : ''}>撤销</option></select>${connector.kind === 'platform' ? `<input name="platform" value="${escapeHtml(platform)}" placeholder="平台标识" maxlength="40" />` : ''}<button class="button button-quiet" type="submit">保存状态</button></form><small class="workspace-capabilities">能力：${escapeHtml((connector.capabilities || []).join('、'))}</small><form data-grant-form="${escapeHtml(connector.id)}" class="workspace-inline-form"><input name="subjectUsername" value="*" placeholder="成员账号或 *" maxlength="64" /><select name="permission" aria-label="授权能力">${permissions.map((permission) => `<option value="${escapeHtml(permission)}">${escapeHtml(permission)}</option>`).join('')}</select><button class="button button-quiet" type="submit">授权</button></form></article>`;
        }).join('')
      : '<div class="admin-empty">暂无连接器</div>';
    const invitationRows = invitations.length
      ? invitations.map((invitation) => `<tr><td><strong>${escapeHtml(invitation.displayName || invitation.username)}</strong><small>${escapeHtml(invitation.username)} · ${escapeHtml(invitation.tenantId)}</small></td><td>${escapeHtml(invitation.status)}</td><td>${escapeHtml(invitation.expiresAt || '—')}</td><td>${invitation.status === 'pending' ? `<button class="button button-quiet" type="button" data-revoke-workspace-invitation="${escapeHtml(invitation.id)}">撤销</button>` : '—'}</td></tr>`).join('')
      : '<tr><td colspan="4" class="admin-empty">暂无邀请记录</td></tr>';
    const syncRows = syncs.length
      ? syncs.slice(0, 8).map((sync) => `<tr><td><strong>${escapeHtml(sync.source)}</strong><small>${escapeHtml(sync.createdAt || '—')}</small></td><td>${escapeHtml(sync.mode)}</td><td>${escapeHtml(JSON.stringify(sync.summary || {}))}</td></tr>`).join('')
      : '<tr><td colspan="3" class="admin-empty">暂无目录同步记录</td></tr>';
    const backupRows = backups.length
      ? backups.map((backup) => `<tr><td><strong>${escapeHtml(backup.backupId)}</strong><small>${escapeHtml(backup.createdAt || '创建时间未知')}</small></td><td>${backup.includes?.encrypted ? '加密' : '未加密'} · ${backup.includes?.mediaFiles ? '含媒体副本' : '仅数据快照'} · 异地 ${escapeHtml(backup.includes?.offsite ? '已配置' : '未配置')}</td><td>${escapeHtml(String(backup.counts?.content_tasks ?? 0))} 个内容任务</td><td><button class="button button-quiet" type="button" data-verify-workspace-backup="${escapeHtml(backup.backupId)}">校验</button></td></tr>`).join('')
      : '<tr><td colspan="4" class="admin-empty">还没有工作台备份</td></tr>';

    const contextPanel = `<section class="panel workspace-admin-card workspace-context-card"><div class="panel-heading"><div><div class="eyebrow">CUSTOMER CONTEXT</div><h3>客户与品牌上下文</h3></div><span class="count-label">${customers.length} 客户 · ${brandProfiles.length} 品牌</span></div><p class="workspace-admin-help">先登记客户，再创建项目并绑定品牌资料；内容任务创建时会把这些对象写入任务上下文。</p><form id="workspace-project-form" class="workspace-admin-form"><input name="name" placeholder="项目名称" maxlength="200" required /><input name="slug" placeholder="项目标识（可选）" maxlength="80" /><input name="description" placeholder="项目说明（可选）" maxlength="500" /><button class="button button-dark" type="submit">创建项目</button></form><div class="workspace-context-forms"><form id="workspace-customer-form" class="workspace-admin-form"><input name="name" placeholder="客户名称" maxlength="200" required /><input name="industry" placeholder="行业（可选）" maxlength="120" /><button class="button button-dark" type="submit">创建客户上下文</button></form><form id="workspace-brand-profile-form" class="workspace-admin-form"><input name="name" placeholder="品牌资料名称" maxlength="200" required /><select name="projectId" required>${projectOptions.replace('<option value="">不绑定项目</option>', '<option value="">选择项目</option>')}</select><select name="customerId" required>${customerOptions}</select><input name="voice" placeholder="品牌语气（可选）" maxlength="500" /><textarea name="constraints" rows="2" placeholder='约束 JSON，例如 {"forbiddenClaims":["绝对化承诺"]}'></textarea><button class="button button-dark" type="submit">创建品牌资料</button></form></div><div class="workspace-table-wrap"><table class="workspace-admin-table"><thead><tr><th>客户</th><th>行业</th><th>状态</th></tr></thead><tbody>${customerRows}</tbody></table></div><div class="workspace-table-wrap"><table class="workspace-admin-table"><thead><tr><th>品牌资料</th><th>项目</th><th>客户</th></tr></thead><tbody>${brandProfileRows}</tbody></table></div></section>`;

    root.innerHTML = `<div class="workspace-admin-heading"><div><div class="eyebrow">WORKSPACE ADMIN</div><h2>成员、项目与连接器</h2><p>管理员在这里维护客户成员、邀请和能力授权；密钥、Token、Cookie 不写入工作台数据库。</p></div><button class="button button-quiet" type="button" data-refresh-workspace>刷新</button></div>${state.message ? `<p class="form-message is-warning workspace-admin-message">${escapeHtml(state.message)}</p>` : ''}<div class="workspace-admin-grid"><section class="panel workspace-admin-card"><div class="panel-heading"><div><div class="eyebrow">MEMBERS</div><h3>成员目录</h3></div><span class="count-label">${users.length} 个</span></div><form id="workspace-member-form" class="workspace-admin-form"><input name="username" placeholder="登录账号" maxlength="64" required /><input name="displayName" placeholder="显示名称" maxlength="120" required /><input name="password" type="password" placeholder="初始密码（至少 8 位）" minlength="8" maxlength="200" required /><select name="role"><option value="client">客户成员</option><option value="admin">管理员</option></select><select name="projectId">${projectOptions}</select><button class="button button-dark" type="submit">创建成员</button></form><div class="workspace-table-wrap"><table class="workspace-admin-table"><thead><tr><th>成员</th><th>角色</th><th>租户</th><th>状态</th><th>操作</th></tr></thead><tbody>${memberRows}</tbody></table></div></section><section class="panel workspace-admin-card"><div class="panel-heading"><div><div class="eyebrow">PROJECT MEMBERS</div><h3>当前项目成员</h3></div><span class="count-label">${escapeHtml(workspace.project?.name || '默认项目')}</span></div><form id="workspace-project-member-form" class="workspace-admin-form"><select name="username" required><option value="">选择成员</option>${users.filter((user) => user.role !== 'admin').map((user) => `<option value="${escapeHtml(user.username)}">${escapeHtml(user.displayName || user.username)}</option>`).join('')}</select><select name="memberRole"><option value="member">成员</option><option value="manager">项目经理</option><option value="reviewer">审核人</option><option value="owner">负责人</option></select><button class="button button-dark" type="submit">加入当前项目</button></form><div class="workspace-table-wrap"><table class="workspace-admin-table"><thead><tr><th>成员</th><th>项目角色</th><th>操作</th></tr></thead><tbody>${projectMemberRows}</tbody></table></div></section></div><section class="panel workspace-admin-card"><div class="panel-heading"><div><div class="eyebrow">CONNECTORS & GRANTS</div><h3>连接器权限</h3></div><span class="count-label">${connectors.length} 个</span></div><div class="workspace-connector-list">${connectorCards}</div></section><div class="workspace-admin-grid"><section class="panel workspace-admin-card"><div class="panel-heading"><div><div class="eyebrow">INVITATIONS</div><h3>一次性成员邀请</h3></div><span class="count-label">${invitations.length} 条</span></div><p class="workspace-admin-help">创建后只显示一次邀请 Token；数据库只保存哈希。请通过受控渠道交给成员，并要求成员设置自己的密码。</p><form id="workspace-invitation-form" class="workspace-admin-form"><input name="username" placeholder="成员登录账号" maxlength="64" required /><input name="displayName" placeholder="显示名称" maxlength="120" required /><select name="role"><option value="client">客户成员</option><option value="admin">管理员</option></select><select name="projectId">${projectOptions}</select><select name="memberRole"><option value="member">项目成员</option><option value="manager">项目经理</option><option value="reviewer">审核人</option><option value="owner">负责人</option></select><input name="expiresInHours" type="number" min="1" max="720" value="72" aria-label="邀请有效期小时数" /><button class="button button-dark" type="submit">创建邀请</button></form><div class="workspace-table-wrap"><table class="workspace-admin-table"><thead><tr><th>成员</th><th>状态</th><th>有效期</th><th>操作</th></tr></thead><tbody>${invitationRows}</tbody></table></div></section><section class="panel workspace-admin-card"><div class="panel-heading"><div><div class="eyebrow">DIRECTORY SYNC</div><h3>组织目录同步</h3></div><span class="count-label">${syncs.length} 次</span></div><p class="workspace-admin-help">粘贴目录成员 JSON 数组，先用 dry-run 预览，再切换 apply。同步不会生成密码；新成员需通过邀请或外部身份系统完成登录凭据。</p><form id="workspace-directory-form" class="workspace-admin-form"><input name="source" value="manual-directory" placeholder="目录来源" maxlength="120" required /><select name="mode"><option value="dry_run">预览（dry-run）</option><option value="apply">应用同步</option></select><label class="workspace-backup-option"><input name="deactivateMissing" type="checkbox" />停用目录中缺失的客户成员</label><textarea name="members" rows="6" spellcheck="false">[{"username":"client01","displayName":"客户成员","role":"client","status":"active","projects":[]}]</textarea><button class="button button-dark" type="submit" data-sync-workspace-directory>执行目录同步</button></form><div class="workspace-table-wrap"><table class="workspace-admin-table"><thead><tr><th>来源</th><th>模式</th><th>摘要</th></tr></thead><tbody>${syncRows}</tbody></table></div></section></div>`;
    root.insertAdjacentHTML('afterbegin', contextPanel);
    root.insertAdjacentHTML('beforeend', `<section class="panel workspace-admin-card workspace-backup-card"><div class="panel-heading"><div><div class="eyebrow">BACKUP & VERIFY</div><h3>数据备份与校验</h3></div><button class="button button-dark" type="button" data-create-workspace-backup>创建备份</button></div><p class="workspace-admin-help">生产环境由服务端强制使用加密、独立异地目录和保留策略；备份不会覆盖当前数据。需要完整带走媒体时再勾选，创建后必须点击校验。</p><label class="workspace-backup-option"><input id="workspace-backup-include-media" type="checkbox" />包含媒体文件副本</label><div class="workspace-table-wrap"><table class="workspace-admin-table"><thead><tr><th>备份</th><th>内容</th><th>数据量</th><th>操作</th></tr></thead><tbody>${backupRows}</tbody></table></div></section>`);
  }

  async function load() {
    state.loading = true;
    render();
    try {
      const [workspace, backupPayload, invitationPayload, syncPayload] = await Promise.all([
        api('/api/workspace'),
        api('/api/workspace/backups'),
        api('/api/workspace/invitations'),
        api('/api/workspace/directory/sync'),
      ]);
      state.workspace = workspace;
      state.backups = backupPayload.backups || [];
      state.invitations = invitationPayload.invitations || [];
      state.syncs = syncPayload.syncs || [];
      state.message = '';
    } catch (error) {
      state.workspace = null;
      state.backups = [];
      state.invitations = [];
      state.syncs = [];
      state.message = error.httpStatus === 401 ? '登录管理员账号后才能维护工作区。' : (error.message || '工作区读取失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function refreshAfter(action, successMessage = '已保存。') {
    let message = '';
    let result = null;
    try {
      result = await action();
      message = successMessage;
    } catch (error) {
      message = error.message || '保存失败';
    }
    await load();
    state.message = message;
    render();
    return result;
  }

  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-refresh-workspace]')) load();
    const createBackup = event.target.closest('[data-create-workspace-backup]');
    if (createBackup) {
      const includeMedia = root.querySelector('#workspace-backup-include-media')?.checked === true;
      refreshAfter(() => api('/api/workspace/backups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ includeMedia }) }), '备份已创建；请点击校验确认指纹和 SQLite 完整性。');
    }
    const verifyBackup = event.target.closest('[data-verify-workspace-backup]');
    if (verifyBackup) refreshAfter(() => api('/api/workspace/backups/' + encodeURIComponent(verifyBackup.dataset.verifyWorkspaceBackup) + '/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), '备份校验已完成。');
    const toggle = event.target.closest('[data-toggle-member]');
    if (toggle) refreshAfter(() => api('/api/workspace/users/' + encodeURIComponent(toggle.dataset.toggleMember), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: toggle.dataset.nextStatus }) }));
    const remove = event.target.closest('[data-remove-project-member]');
    if (remove && state.workspace?.project?.id) refreshAfter(() => api('/api/workspace/projects/' + encodeURIComponent(state.workspace.project.id) + '/members/' + encodeURIComponent(remove.dataset.removeProjectMember), { method: 'DELETE' }));
    const revoke = event.target.closest('[data-revoke-workspace-invitation]');
    if (revoke) refreshAfter(() => api('/api/workspace/invitations/' + encodeURIComponent(revoke.dataset.revokeWorkspaceInvitation) + '/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), '邀请已撤销。');
  });

  root.addEventListener('submit', (event) => {
      const form = event.target;
      if (form.matches('#workspace-project-form')) {
        event.preventDefault();
        const data = new FormData(form);
        refreshAfter(() => api('/api/workspace/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: data.get('name'), slug: data.get('slug'), description: data.get('description') }) }), '项目已创建。');
      }
      if (form.matches('#workspace-customer-form')) {
        event.preventDefault();
        const data = new FormData(form);
        refreshAfter(() => api('/api/workspace/customers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: data.get('name'), industry: data.get('industry') }) }), '客户上下文已创建。');
      }
      if (form.matches('#workspace-brand-profile-form')) {
        event.preventDefault();
        const data = new FormData(form);
        refreshAfter(() => {
          let constraints = {};
          const rawConstraints = String(data.get('constraints') || '').trim();
          if (rawConstraints) {
            constraints = JSON.parse(rawConstraints);
            if (!constraints || typeof constraints !== 'object' || Array.isArray(constraints)) throw new Error('品牌约束必须是 JSON 对象');
          }
          return api('/api/workspace/brand-profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: data.get('name'), projectId: data.get('projectId'), customerId: data.get('customerId'), voice: data.get('voice'), constraints }) });
        }, '品牌资料已创建。');
      }
      if (form.matches('#workspace-member-form')) {
      event.preventDefault();
      const data = new FormData(form);
      const payload = { username: data.get('username'), displayName: data.get('displayName'), role: data.get('role'), password: data.get('password') };
      if (data.get('projectId')) payload.projectId = data.get('projectId');
      refreshAfter(() => api('/api/workspace/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
    }
    if (form.matches('#workspace-project-member-form')) {
      event.preventDefault();
      const data = new FormData(form);
      if (!state.workspace?.project?.id) return;
      refreshAfter(() => api('/api/workspace/projects/' + encodeURIComponent(state.workspace.project.id) + '/members', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: data.get('username'), memberRole: data.get('memberRole') }) }));
    }
    if (form.matches('#workspace-invitation-form')) {
      event.preventDefault();
      const data = new FormData(form);
      const payload = { username: data.get('username'), displayName: data.get('displayName'), role: data.get('role'), memberRole: data.get('memberRole'), expiresInHours: Number(data.get('expiresInHours')) };
      if (data.get('projectId')) payload.projectId = data.get('projectId');
      void refreshAfter(() => api('/api/workspace/invitations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }), '邀请已创建。请把下面的 Token 或路径通过受控渠道交给成员。').then((result) => {
        if (result?.invitation?.token) {
          state.message = '邀请 Token（只显示本次）：' + result.invitation.token + '；路径：' + result.invitation.invitePath;
          render();
        }
      });
    }
    if (form.matches('#workspace-directory-form')) {
      event.preventDefault();
      const data = new FormData(form);
      void refreshAfter(() => {
        const parsed = JSON.parse(String(data.get('members') || '[]'));
        const members = Array.isArray(parsed) ? parsed : parsed.members;
        if (!Array.isArray(members)) throw new Error('目录 JSON 必须是成员数组或包含 members 数组的对象');
        return api('/api/workspace/directory/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: data.get('source'), mode: data.get('mode'), members, deactivateMissing: data.get('deactivateMissing') === 'on' }) });
      }, '组织目录同步已完成。');
    }
    const connectorForm = form.closest('[data-connector-form]');
    if (connectorForm) {
      event.preventDefault();
      const data = new FormData(form);
      const config = data.get('platform') ? { platform: data.get('platform') } : {};
      refreshAfter(() => api('/api/workspace/connectors/' + encodeURIComponent(connectorForm.dataset.connectorForm), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: data.get('status'), config }) }));
    }
    const grantForm = form.closest('[data-grant-form]');
    if (grantForm) {
      event.preventDefault();
      const data = new FormData(form);
      refreshAfter(() => api('/api/workspace/connectors/' + encodeURIComponent(grantForm.dataset.grantForm) + '/grants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subjectUsername: data.get('subjectUsername') || '*', permissions: [data.get('permission')], effect: 'allow' }) }));
    }
  });

  window.addEventListener('workspace-auth-ready', load);
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-view="settings"]')) load();
  });
  render();
}
