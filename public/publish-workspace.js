const root = document.querySelector('#view-publish');

if (root) {
  const state = { drafts: [], viewer: null, loading: false, message: '' };
  const labels = {
    draft: '待管理员批准',
    approved: '已批准，等待执行器',
    cancelled: '已取消',
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function platformLabel(platform) {
    return { xhs: '小红书', douyin: '抖音', channels: '视频号' }[platform] || platform || '未指定平台';
  }

  function formatTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `请求失败（${response.status}）`);
      error.httpStatus = response.status;
      throw error;
    }
    return payload;
  }

  function render() {
    const body = state.loading
      ? '<div class="empty-workspace panel compact-empty"><div class="empty-orbit">↻</div><h3>正在读取发布草稿</h3><p>草稿、批准状态和平台执行器状态来自当前工作区。</p></div>'
      : !state.drafts.length
        ? '<div class="empty-workspace panel compact-empty"><div class="empty-orbit">↗</div><h3>还没有发布草稿</h3><p>完成内容任务的审核和打包后，在内容中心创建发布草稿。</p></div>'
        : `<section class="publish-draft-list">${state.drafts.map((draft) => {
            const payload = draft.payload || {};
            const canApprove = state.viewer?.role === 'admin' && draft.status === 'draft';
            const canExecute = draft.status === 'approved';
            return `<article class="panel publish-draft-card"><div class="publish-draft-card-top"><div><div class="eyebrow">${escapeHtml(platformLabel(payload.platform))} / ${escapeHtml(draft.id)}</div><h3>${escapeHtml(payload.title || '未命名发布草稿')}</h3></div><span class="phase-label">${escapeHtml(labels[draft.status] || draft.status)}</span></div><p>${escapeHtml(String(payload.text || '暂无正文').slice(0, 500))}</p><div class="publish-draft-meta"><span>创建：${escapeHtml(formatTime(draft.createdAt))}</span><span>任务：${escapeHtml(draft.taskId)}</span><span>默认不自动发布</span></div><div class="publish-draft-actions">${canApprove ? '<button class="button button-dark" type="button" data-approve-draft="' + escapeHtml(draft.id) + '">管理员批准</button>' : ''}${canExecute ? '<button class="button button-secondary" type="button" data-execute-draft="' + escapeHtml(draft.id) + '">尝试执行发布</button>' : ''}</div></article>`;
          }).join('')}</section>`;
    root.innerHTML = `<div class="section-banner"><div><div class="eyebrow">PUBLISH CENTER / HUMAN GATE</div><h2>发布中心</h2><p>统一查看内容发布草稿；批准和真实发布是两个独立动作。</p></div><span class="section-banner-mark">↗</span></div><div class="publish-toolbar"><div><strong>${state.drafts.length} 个发布草稿</strong><small>${state.viewer?.role === 'admin' ? '当前为管理员，可批准草稿。' : '客户成员只能查看自己项目的草稿。'}</small></div><button class="button button-quiet" type="button" data-refresh-drafts>刷新列表</button></div>${state.message ? '<p class="form-message is-warning publish-message">' + escapeHtml(state.message) + '</p>' : ''}${body}`;
  }

  async function load() {
    state.loading = true;
    render();
    try {
      const [draftPayload, mePayload] = await Promise.all([
        api('/api/release-drafts'),
        api('/api/auth/me'),
      ]);
      state.drafts = draftPayload.drafts || [];
      state.viewer = mePayload.user || null;
      state.message = '';
    } catch (error) {
      state.drafts = [];
      state.message = error.httpStatus === 401 ? '登录后才能查看发布草稿。' : (error.message || '发布草稿读取失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function updateDraft(draftId, action) {
    let message = '';
    try {
      if (action === 'approve') {
        await api('/api/release-drafts/' + encodeURIComponent(draftId), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'approved' }),
        });
        message = '草稿已批准；真实发布仍需平台执行器和人工确认。';
      } else {
        await api('/api/release-drafts/' + encodeURIComponent(draftId) + '/execute', { method: 'POST' });
      }
    } catch (error) {
      message = error.message || '发布动作未完成；草稿仍被保留。';
    }
    await load();
    state.message = message;
    render();
  }

  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-refresh-drafts]')) load();
    const approve = event.target.closest('[data-approve-draft]');
    if (approve) updateDraft(approve.dataset.approveDraft, 'approve');
    const execute = event.target.closest('[data-execute-draft]');
    if (execute) updateDraft(execute.dataset.executeDraft, 'execute');
  });
  window.addEventListener('release-draft-created', load);
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-view="publish"]')) load();
  });

  render();
  load();
}
