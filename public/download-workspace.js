const elements = {
  form: document.querySelector('#download-resolve-form'),
  url: document.querySelector('#download-url'),
  paste: document.querySelector('#download-paste'),
  submit: document.querySelector('#download-resolve-button'),
  message: document.querySelector('#download-form-message'),
  result: document.querySelector('#download-result'),
  resultStatus: document.querySelector('#download-result-status'),
  tasks: document.querySelector('#download-tasks'),
  taskCount: document.querySelector('#download-task-count'),
  note: document.querySelector('#download-center-note'),
};

const state = {
  tasks: [],
  selectedTaskId: null,
  loading: false,
  resolving: false,
};

const STATUS_META = {
  resolved: ['已解析', 'is-ready'],
  downloading: ['下载中', 'is-working'],
  completed: ['已完成', 'is-success'],
  partial_failed: ['部分失败', 'is-warning'],
  failed: ['下载失败', 'is-error'],
  expired: ['资源已过期', 'is-warning'],
  available: ['可下载', 'is-ready'],
  queued: ['排队中', 'is-working'],
  unavailable: ['暂不可用', 'is-muted'],
};

const PLATFORM_CLASS = {
  xhs: 'platform-xhs',
  douyin: 'platform-douyin',
  channels: 'platform-channels',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function statusMarkup(status) {
  const [label, className] = STATUS_META[status] || [status || '未知', 'is-muted'];
  return '<span class="download-status ' + className + '">' + escapeHtml(label) + '</span>';
}

function taskFor(id) {
  return state.tasks.find((task) => task.id === id) || null;
}

function fileFor(task, kind, index = null) {
  if (!task) return null;
  if (kind === 'video' || kind === 'cover') return task.files?.[kind] || null;
  if (kind === 'image' && Number.isInteger(index)) return task.files?.images?.[index] || null;
  return null;
}

function actionButton(task, kind, label, index = null) {
  const file = fileFor(task, kind, index);
  const available = task.available?.[kind] || (kind === 'image' && file);
  if (!available || file?.status === 'unavailable') return '';
  if (file?.status === 'completed') {
    const indexParam = kind === 'image' ? '&index=' + encodeURIComponent(index) : '';
    return '<a class="button button-secondary button-small" href="' + task.fileUrls[kind] + (indexParam || '') + '" download>' + escapeHtml(label) + '</a>';
  }
  if (file?.status === 'failed') {
    return '<button class="button button-secondary button-small" type="button" data-download-kind="' + kind + '" data-download-task="' + escapeHtml(task.id) + '"' + (kind === 'image' ? ' data-download-index="' + index + '"' : '') + '>重试' + escapeHtml(label) + '</button>';
  }
  return '<button class="button button-dark button-small" type="button" data-download-kind="' + kind + '" data-download-task="' + escapeHtml(task.id) + '"' + (kind === 'image' ? ' data-download-index="' + index + '"' : '') + '>' + escapeHtml(label) + '</button>';
}

function taskActions(task) {
  const actions = [];
  if (task.available?.video) actions.push(actionButton(task, 'video', '下载视频'));
  if (task.available?.cover) actions.push(actionButton(task, 'cover', '下载封面'));
  if (task.available?.images) {
    const imageStatuses = task.files?.images || [];
    const allCompleted = imageStatuses.length > 0 && imageStatuses.every((file) => file.status === 'completed');
    const someActive = imageStatuses.some((file) => ['queued', 'downloading'].includes(file.status));
    if (allCompleted) {
      actions.push('<span class="download-complete-note">图片已保存 ' + imageStatuses.length + ' 张</span>');
    } else if (!someActive) {
      actions.push('<button class="button button-secondary button-small" type="button" data-download-kind="images" data-download-task="' + escapeHtml(task.id) + '">下载图片 ' + imageStatuses.length + ' 张</button>');
    }
  }
  return actions.filter(Boolean).join('');
}

function renderResult(task) {
  if (!task) {
    elements.resultStatus.textContent = '等待链接';
    elements.result.innerHTML = '<div class="download-empty"><span>⇩</span><div><strong>粘贴链接开始</strong><p>解析成功后，这里会显示标题、作者、封面和下载动作。</p></div></div>';
    return;
  }
  elements.resultStatus.innerHTML = statusMarkup(task.status);
  const cover = task.previewUrls?.cover
    ? '<img src="' + escapeHtml(task.previewUrls.cover) + '" alt="' + escapeHtml(task.title) + ' 的封面" loading="lazy" />'
    : '<div class="download-cover-empty"><span>□</span><small>暂无封面</small></div>';
  const source = task.sourceUrl
    ? '<a href="' + escapeHtml(task.sourceUrl) + '" target="_blank" rel="noreferrer">打开原作品 ↗</a>'
    : '';
  const availability = [
    task.available?.video ? '视频' : '',
    task.available?.cover ? '封面' : '',
    task.available?.images ? task.available.images + ' 张图片' : '',
  ].filter(Boolean).join(' · ') || '没有可下载媒体';
  elements.result.innerHTML = '<article class="download-result-card"><div class="download-result-cover">' + cover + '</div><div class="download-result-copy"><div class="download-result-topline"><span class="download-platform-chip ' + (PLATFORM_CLASS[task.platform] || 'platform-other') + '">' + escapeHtml(task.platformLabel) + '</span><span class="muted-text">' + escapeHtml(availability) + '</span></div><h3>' + escapeHtml(task.title) + '</h3><p class="download-author">' + escapeHtml(task.author || '作者未提供') + '</p><p class="download-source-link">' + source + '</p><div class="download-actions">' + taskActions(task) + '</div>' + (task.error ? '<p class="download-inline-error">' + escapeHtml(task.error) + '</p>' : '') + '<small class="download-expiry">解析资源保留至 ' + escapeHtml(formatTime(task.expiresAt)) + '；过期后重新解析即可。</small></div></article>';
}

function renderTasks() {
  elements.taskCount.textContent = state.tasks.length + ' 条';
  if (!state.tasks.length) {
    elements.tasks.innerHTML = '<div class="download-empty compact"><span>⌁</span><div><strong>还没有下载任务</strong><p>解析后的作品会出现在这里。</p></div></div>';
    return;
  }
  elements.tasks.innerHTML = state.tasks.map((task) => {
    const files = [task.files?.video, task.files?.cover, ...(task.files?.images || [])].filter(Boolean);
    const completed = files.filter((file) => file.status === 'completed').length;
    const failed = files.filter((file) => file.status === 'failed').length;
    const summary = completed ? '已保存 ' + completed + ' 个文件' : failed ? '有 ' + failed + ' 个文件失败' : '等待选择下载内容';
    const active = state.selectedTaskId === task.id ? ' is-selected' : '';
    return '<article class="download-task-card' + active + '" data-download-select="' + escapeHtml(task.id) + '"><div class="download-task-heading"><div><span class="download-platform-chip ' + (PLATFORM_CLASS[task.platform] || 'platform-other') + '">' + escapeHtml(task.platformLabel) + '</span><h3>' + escapeHtml(task.title) + '</h3></div>' + statusMarkup(task.status) + '</div><div class="download-task-meta"><span>' + escapeHtml(summary) + '</span><time>' + escapeHtml(formatTime(task.updatedAt)) + '</time></div><div class="download-task-actions">' + taskActions(task) + '</div>' + (task.error ? '<p class="download-inline-error">' + escapeHtml(task.error) + '</p>' : '') + '</article>';
  }).join('');
}

function render() {
  const selected = taskFor(state.selectedTaskId) || state.tasks[0] || null;
  if (selected && !state.selectedTaskId) state.selectedTaskId = selected.id;
  renderResult(selected);
  renderTasks();
}

async function api(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || '下载中心请求失败');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function setMessage(message, kind = '') {
  elements.message.textContent = message || '';
  elements.message.className = 'form-message' + (kind ? ' is-' + kind : '');
}

async function loadCatalog() {
  try {
    const payload = await api('/api/download-center/catalog');
    if (payload.note && elements.note) elements.note.textContent = payload.note;
  } catch {
    // The task endpoint remains the source of truth; auth/login may not be ready yet.
  }
}

async function loadTasks(options = {}) {
  if (state.loading) return;
  state.loading = true;
  try {
    const payload = await api('/api/download-center/tasks');
    state.tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    if (state.selectedTaskId && !taskFor(state.selectedTaskId)) state.selectedTaskId = null;
    render();
  } catch (error) {
    if (error.status !== 401 && !options.silent) setMessage(error.message || '下载任务读取失败', 'error');
  } finally {
    state.loading = false;
  }
}

async function resolveLink(event) {
  event.preventDefault();
  if (state.resolving) return;
  const url = elements.url.value.trim();
  if (!url) {
    setMessage('先粘贴一条作品链接', 'error');
    return;
  }
  state.resolving = true;
  elements.submit.disabled = true;
  elements.submit.querySelector('span').textContent = '解析中…';
  setMessage('正在识别平台并解析媒体…', 'working');
  try {
    const payload = await api('/api/download-center/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    state.selectedTaskId = payload.task?.id || null;
    setMessage('解析完成，请选择要保存的文件', 'success');
    elements.url.value = payload.task?.sourceUrl || url;
    await loadTasks({ silent: true });
    render();
  } catch (error) {
    setMessage(error.message || '解析失败，请检查链接后重试', 'error');
  } finally {
    state.resolving = false;
    elements.submit.disabled = false;
    elements.submit.querySelector('span').textContent = '解析并准备下载';
  }
}

async function queueDownload(taskId, kind, index = null) {
  const button = document.querySelector('[data-download-task="' + CSS.escape(taskId) + '"][data-download-kind="' + CSS.escape(kind) + '"]');
  if (button) button.disabled = true;
  try {
    await api('/api/download-center/tasks/' + encodeURIComponent(taskId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, ...(index === null ? {} : { index }) }),
    });
    setMessage(kind === 'images' ? '图片已加入下载队列' : '已加入下载队列', 'success');
    await loadTasks({ silent: true });
  } catch (error) {
    setMessage(error.message || '加入下载队列失败', 'error');
    await loadTasks({ silent: true });
  }
}

async function pasteLink() {
  try {
    elements.url.value = (await navigator.clipboard.readText()).trim();
    setMessage('已从剪贴板粘贴', 'success');
    elements.url.focus();
  } catch {
    setMessage('浏览器未开放剪贴板权限，请直接粘贴到输入框', 'error');
  }
}

function init() {
  if (!elements.form) return;
  elements.form.addEventListener('submit', resolveLink);
  elements.paste?.addEventListener('click', pasteLink);
  elements.result.addEventListener('click', (event) => {
    const button = event.target.closest('[data-download-task]');
    if (!button) return;
    event.stopPropagation();
    const index = button.dataset.downloadIndex === undefined ? null : Number(button.dataset.downloadIndex);
    queueDownload(button.dataset.downloadTask, button.dataset.downloadKind, index);
  });
  elements.tasks.addEventListener('click', (event) => {
    const button = event.target.closest('[data-download-task]');
    if (button) {
      event.stopPropagation();
      const index = button.dataset.downloadIndex === undefined ? null : Number(button.dataset.downloadIndex);
      queueDownload(button.dataset.downloadTask, button.dataset.downloadKind, index);
      return;
    }
    const card = event.target.closest('[data-download-select]');
    if (card) {
      state.selectedTaskId = card.dataset.downloadSelect;
      render();
    }
  });
  window.addEventListener('workspace-auth-ready', () => {
    loadCatalog();
    loadTasks();
  });
  loadCatalog();
  loadTasks();
  window.setInterval(() => {
    if (state.tasks.some((task) => task.status === 'downloading')) loadTasks({ silent: true });
  }, 4000);
}

init();
