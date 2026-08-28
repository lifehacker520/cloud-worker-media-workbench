const state = {
  accounts: [],
  works: [],
  stats: {},
  meta: {},
  viewer: null,
  auth: {
    required: false,
    localDefaults: false,
  },
  feedback: [],
  activity: [],
};

let accountFilter = 'all';
let autoRefreshTimer = null;
let statePollTimer = null;
let isRefreshing = false;
let isAuthenticated = false;
let authRequired = false;
let updaterPhase = 'idle';

const elements = {
  stats: document.querySelector('#stats'),
  accounts: document.querySelector('#accounts-list'),
  works: document.querySelector('#works-feed'),
  accountCount: document.querySelector('#account-count-label'),
  feedCount: document.querySelector('#feed-count-label'),
  lastRefresh: document.querySelector('#last-refresh'),
  runtimeStatus: document.querySelector('#runtime-status'),
  refreshError: document.querySelector('#refresh-error'),
  updateButton: document.querySelector('#update-app'),
  refreshButton: document.querySelector('#refresh-all'),
  addForm: document.querySelector('#add-account-form'),
  addMessage: document.querySelector('#add-account-message'),
  filter: document.querySelector('#account-filter'),
  autoRefresh: document.querySelector('#auto-refresh'),
  toast: document.querySelector('#toast'),
  authArea: document.querySelector('#auth-area'),
  loginScreen: document.querySelector('#login-screen'),
  loginForm: document.querySelector('#login-form'),
  loginUsername: document.querySelector('#login-username'),
  loginPassword: document.querySelector('#login-password'),
  loginMessage: document.querySelector('#login-message'),
  feedbackForm: document.querySelector('#feedback-form'),
  feedbackMessage: document.querySelector('#feedback-message'),
  adminConsole: document.querySelector('#admin-console'),
  feedbackList: document.querySelector('#feedback-list'),
  activityList: document.querySelector('#activity-list'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(value, fallback = '—') {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatDuration(milliseconds) {
  if (!milliseconds) {
    return '';
  }
  if (milliseconds < 1000) {
    return milliseconds + ' ms';
  }
  return (milliseconds / 1000).toFixed(1) + ' s';
}

function accountFor(id) {
  return state.accounts.find((account) => account.id === id);
}

function showToast(message, kind = 'normal') {
  elements.toast.textContent = message;
  elements.toast.className = 'toast is-visible ' + kind;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    elements.toast.className = 'toast';
  }, 3200);
}

function showLogin(message = '') {
  elements.loginScreen.classList.remove('is-hidden');
  elements.loginMessage.textContent = message;
  elements.loginMessage.className = 'form-message' + (message ? ' is-error' : '');
  if (elements.loginPassword) {
    elements.loginPassword.value = '';
  }
  window.setTimeout(() => elements.loginUsername?.focus(), 0);
}

function hideLogin() {
  elements.loginScreen.classList.add('is-hidden');
  elements.loginMessage.textContent = '';
  elements.loginMessage.className = 'form-message';
}

function renderAuth() {
  if (!state.viewer) {
    elements.authArea.innerHTML = authRequired
      ? '<span class="auth-required-label">需要登录</span>'
      : '';
    return;
  }

  const roleLabel = state.viewer.role === 'admin' ? '管理员' : '客户成员';
  const logoutButton = authRequired
    ? '<button class="auth-logout" type="button" data-logout>退出</button>'
    : '';
  elements.authArea.innerHTML =
    '<span class="auth-user"><i></i><span>' +
    escapeHtml(state.viewer.displayName) +
    '<small>' +
    roleLabel +
    '</small></span></span>' +
    logoutButton;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (response.status === 401) {
    isAuthenticated = false;
    if (authRequired) {
      showLogin('登录状态已失效，请重新登录');
      renderAuth();
    }
  }

  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || '请求失败');
    error.httpStatus = response.status;
    throw error;
  }
  return payload;
}

function renderStats() {
  const cards = [
    {
      label: '监控账号',
      value: state.stats.accountCount ?? 0,
      suffix: '个',
      hint: (state.stats.activeAccountCount ?? 0) + ' 个已连接',
      tone: 'blue',
    },
    {
      label: '已抓取作品',
      value: state.stats.workCount ?? 0,
      suffix: '条',
      hint: '本地去重后',
      tone: 'ink',
    },
    {
      label: '新发现',
      value: state.stats.unseenWorkCount ?? 0,
      suffix: '条',
      hint: '待你查看',
      tone: 'orange',
    },
    {
      label: '最近一次刷新',
      value: state.meta.lastRefreshAt ? formatTime(state.meta.lastRefreshAt) : '—',
      suffix: '',
      hint: state.meta.lastRefreshSummary
        ? '成功 ' +
          state.meta.lastRefreshSummary.succeeded +
          ' / ' +
          state.meta.lastRefreshSummary.checked +
          ' · ' +
          formatDuration(state.meta.lastRefreshSummary.durationMs)
        : '点击刷新开始',
      tone: 'green',
    },
  ];

  elements.stats.innerHTML = cards
    .map(
      (card) =>
        '<article class="stat-card tone-' +
        card.tone +
        '">' +
        '<div class="stat-label">' +
        escapeHtml(card.label) +
        '</div>' +
        '<div class="stat-value">' +
        escapeHtml(card.value) +
        '<small>' +
        escapeHtml(card.suffix) +
        '</small></div>' +
        '<div class="stat-hint">' +
        escapeHtml(card.hint) +
        '</div>' +
        '</article>',
    )
    .join('');
}

function stateLabel(account) {
  if (account.state === 'active') {
    return '已连接';
  }
  if (account.state === 'error') {
    return '需处理';
  }
  return '待刷新';
}

function renderAccounts() {
  const visibleAccounts = state.accounts.filter(
    (account) => accountFilter === 'all' || account.state === accountFilter,
  );
  elements.accountCount.textContent = state.accounts.length;

  if (visibleAccounts.length === 0) {
    elements.accounts.innerHTML =
      '<div class="empty-state compact"><span>◌</span><p>没有符合条件的账号</p></div>';
    return;
  }

  elements.accounts.innerHTML = visibleAccounts
    .map((account) => {
      const error =
        account.state === 'error' && account.lastError
          ? '<p class="account-error">' + escapeHtml(account.lastError) + '</p>'
          : '';
      const profileUrl = account.canonicalUrl || account.sourceUrl;
      const creator =
        account.createdBy && account.createdBy !== 'system'
          ? '加入者 ' + account.createdBy
          : '';
      return (
        '<article class="account-card state-' +
        escapeHtml(account.state) +
        '">' +
        '<div class="account-card-top">' +
        '<div class="account-title-wrap">' +
        '<span class="state-dot"></span>' +
        '<div><h3>' +
        escapeHtml(account.name) +
        '</h3><p>' +
        escapeHtml(account.nickname || '尚未读取主页名称') +
        '</p></div>' +
        '</div>' +
        '<span class="state-label">' +
        stateLabel(account) +
        '</span>' +
        '</div>' +
        '<div class="account-meta"><span>' +
        (account.workCount || 0) +
        ' 条作品</span><span>' +
        escapeHtml(creator || '公共台账') +
        '</span><span>检查 ' +
        formatTime(account.lastCheckedAt, '尚未') +
        '</span></div>' +
        error +
        '<div class="account-card-footer"><span class="source-mini">公开主页 HTML</span><a href="' +
        escapeHtml(profileUrl) +
        '" target="_blank" rel="noreferrer">打开主页 ↗</a></div>' +
        '</article>'
      );
    })
    .join('');
}

function renderWorks() {
  elements.feedCount.textContent = state.works.length + ' 条';
  if (state.works.length === 0) {
    elements.works.innerHTML =
      '<div class="empty-state"><div class="empty-orbit">↻</div><h3>还没有作品</h3><p>点击右上角“刷新全部”，读取监控列表中的公开主页。</p></div>';
    return;
  }

  elements.works.innerHTML = state.works
    .map((work) => {
      const account = accountFor(work.accountId);
      const isNew = !work.seen;
      const linkLabel = work.noteId ? '打开作品 ↗' : '打开主页 ↗';
      const accountName = account?.name || '未知账号';
      const extractionLabel =
        work.extraction === 'embedded-profile-state' ? '内嵌状态' : '页面文本';
      return (
        '<article class="work-card ' +
        (isNew ? 'is-new' : '') +
        '">' +
        '<div class="work-topline"><span class="source-chip">' +
        escapeHtml(accountName) +
        '</span>' +
        (isNew ? '<span class="new-badge">新发现</span>' : '') +
        '<span class="work-time">' +
        formatTime(work.publishedAt, '时间待解析') +
        '</span></div>' +
        '<h3>' +
        escapeHtml(work.title) +
        '</h3>' +
        '<div class="work-bottomline"><span class="work-source">' +
        extractionLabel +
        (work.likes ? ' · ' + escapeHtml(work.likes) + ' 赞' : '') +
        '</span><span class="work-actions"><a href="' +
        escapeHtml(work.link || account?.canonicalUrl || '#') +
        '" target="_blank" rel="noreferrer">' +
        linkLabel +
        '</a>' +
        (isNew
          ? '<button type="button" data-seen="' +
            escapeHtml(work.fingerprint) +
            '">标为已读</button>'
          : '') +
        '</span></div>' +
        '</article>'
      );
    })
    .join('');
}

function feedbackCategoryLabel(category) {
  return (
    {
      bug: '问题',
      feature: '功能',
      content: '内容',
      other: '其他',
    }[category] || '其他'
  );
}

function activityTypeLabel(type) {
  return (
    {
      refresh: '刷新',
      account_added: '加入账号',
      work_seen: '标记已读',
      feedback: '提交反馈',
    }[type] || type
  );
}

function renderAdmin() {
  const isAdmin = state.viewer?.role === 'admin';
  elements.adminConsole.classList.toggle('is-hidden', !isAdmin);
  if (!isAdmin) {
    return;
  }

  if (!state.feedback.length) {
    elements.feedbackList.innerHTML = '<p class="admin-empty">还没有客户反馈</p>';
  } else {
    elements.feedbackList.innerHTML = state.feedback
      .map(
        (feedback) =>
          '<article class="admin-item"><div class="admin-item-top"><span class="admin-tag">' +
          escapeHtml(feedbackCategoryLabel(feedback.category)) +
          '</span><small>' +
          escapeHtml(formatTime(feedback.createdAt)) +
          '</small></div><p>' +
          escapeHtml(feedback.message) +
          '</p><small>' +
          escapeHtml(feedback.createdByName || feedback.createdBy) +
          '</small></article>',
      )
      .join('');
  }

  if (!state.activity.length) {
    elements.activityList.innerHTML = '<p class="admin-empty">还没有使用活动</p>';
  } else {
    elements.activityList.innerHTML = state.activity
      .map(
        (activity) =>
          '<article class="admin-item"><div class="admin-item-top"><span class="admin-tag">' +
          escapeHtml(activityTypeLabel(activity.type)) +
          '</span><small>' +
          escapeHtml(formatTime(activity.createdAt)) +
          '</small></div><p>' +
          escapeHtml(activity.detail) +
          '</p><small>' +
          escapeHtml(activity.actorName || activity.actor) +
          '</small></article>',
      )
      .join('');
  }
}

function renderRuntime() {
  const inProgress = state.meta.refreshInProgress || isRefreshing;
  const hasError = Boolean(state.meta.refreshError);
  elements.runtimeStatus.className =
    'runtime-status ' + (inProgress ? 'is-loading' : hasError ? 'is-warning' : 'is-ready');
  elements.runtimeStatus.innerHTML =
    '<i></i>' +
    (inProgress ? '正在刷新' : hasError ? '部分账号需处理' : authRequired ? '在线服务正常' : '本地服务正常');
  elements.refreshButton.disabled = inProgress || !isAuthenticated;
  elements.refreshButton.classList.toggle('is-busy', inProgress);

  if (hasError) {
    elements.refreshError.className = 'alert-banner';
    elements.refreshError.innerHTML =
      '<strong>这次刷新有部分结果：</strong> ' + escapeHtml(state.meta.refreshError);
  } else {
    elements.refreshError.className = 'alert-banner is-hidden';
    elements.refreshError.textContent = '';
  }

  if (state.meta.lastRefreshAt) {
    elements.lastRefresh.textContent =
      '最近刷新 ' +
      formatTime(state.meta.lastRefreshAt) +
      (state.meta.lastRefreshSummary?.newWorks
        ? ' · 新增 ' + state.meta.lastRefreshSummary.newWorks + ' 条'
        : '');
  } else {
    elements.lastRefresh.textContent = inProgress ? '首次刷新进行中…' : '尚未刷新';
  }
}

function renderUpdater(payload = {}) {
  if (!window.desktopUpdater || !elements.updateButton) {
    return;
  }

  elements.updateButton.classList.remove('is-hidden');
  const status = payload.status || updaterPhase;
  const percent = Number.isFinite(payload.percent) ? payload.percent : 0;

  if (status === 'checking') {
    updaterPhase = 'checking';
    elements.updateButton.textContent = '检查中…';
    elements.updateButton.disabled = true;
    return;
  }
  if (status === 'available') {
    updaterPhase = 'available';
    elements.updateButton.textContent = '下载更新 v' + payload.version;
    elements.updateButton.disabled = false;
    return;
  }
  if (status === 'downloading') {
    updaterPhase = 'downloading';
    elements.updateButton.textContent = '下载中 ' + percent + '%';
    elements.updateButton.disabled = true;
    return;
  }
  if (status === 'downloaded') {
    updaterPhase = 'downloaded';
    elements.updateButton.textContent = '重启安装更新';
    elements.updateButton.disabled = false;
    return;
  }
  if (status === 'not-available') {
    updaterPhase = 'idle';
    elements.updateButton.textContent = '已是最新';
    elements.updateButton.disabled = false;
    return;
  }
  if (status === 'dev') {
    updaterPhase = 'idle';
    elements.updateButton.textContent = '开发模式';
    elements.updateButton.disabled = false;
    return;
  }
  if (status === 'error') {
    updaterPhase = 'idle';
    elements.updateButton.textContent = '更新失败，重试';
    elements.updateButton.disabled = false;
    if (payload.message) {
      showToast('更新检查失败：' + payload.message, 'warning');
    }
    return;
  }

  elements.updateButton.textContent = '检查更新';
  elements.updateButton.disabled = false;
}

async function handleUpdaterClick() {
  if (!window.desktopUpdater || updaterPhase === 'checking' || updaterPhase === 'downloading') {
    return;
  }

  try {
    if (updaterPhase === 'available') {
      renderUpdater({ status: 'downloading', percent: 0 });
      await window.desktopUpdater.downloadUpdate();
      return;
    }
    if (updaterPhase === 'downloaded') {
      await window.desktopUpdater.installUpdate();
      return;
    }

    renderUpdater({ status: 'checking' });
    const result = await window.desktopUpdater.checkForUpdates();
    if (result?.status === 'dev') {
      renderUpdater(result);
      showToast('当前是开发模式，打包后可检查 GitHub Release', 'normal');
    } else if (result?.status === 'error') {
      renderUpdater(result);
    }
  } catch (error) {
    renderUpdater({ status: 'error', message: error.message || String(error) });
  }
}

function render() {
  renderAuth();
  renderStats();
  renderAccounts();
  renderWorks();
  renderRuntime();
  renderAdmin();
}

async function loadAdminData() {
  if (state.viewer?.role !== 'admin') {
    state.feedback = [];
    state.activity = [];
    renderAdmin();
    return;
  }
  try {
    const results = await Promise.all([
      apiRequest('/api/feedback'),
      apiRequest('/api/activity'),
    ]);
    state.feedback = results[0].feedback || [];
    state.activity = results[1].activity || [];
    renderAdmin();
  } catch (error) {
    showToast(error.message || '管理员数据读取失败', 'warning');
  }
}

async function loadState() {
  if (!isAuthenticated) {
    return;
  }
  try {
    const payload = await apiRequest('/api/state');
    Object.assign(state, payload);
    render();
    await loadAdminData();
  } catch (error) {
    if (error.httpStatus === 401) {
      return;
    }
    elements.runtimeStatus.className = 'runtime-status is-warning';
    elements.runtimeStatus.innerHTML = '<i></i>服务连接失败';
    showToast(error.message || '读取状态失败', 'error');
  }
}

async function refreshAll() {
  if (isRefreshing || !isAuthenticated) {
    return;
  }
  isRefreshing = true;
  renderRuntime();
  try {
    const payload = await apiRequest('/api/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    Object.assign(state, payload.state);
    render();
    await loadAdminData();
    const summary = payload.summary;
    showToast(
      summary.failed
        ? '刷新完成：成功 ' + summary.succeeded + ' 个，失败 ' + summary.failed + ' 个'
        : '刷新完成：读取 ' + summary.succeeded + ' 个账号',
      summary.failed ? 'warning' : 'success',
    );
  } catch (error) {
    showToast(error.message || '刷新失败', 'error');
    await loadState();
  } finally {
    isRefreshing = false;
    renderRuntime();
  }
}

async function addAccount(event) {
  event.preventDefault();
  const formData = new FormData(elements.addForm);
  const name = String(formData.get('name') || '').trim();
  const sourceUrl = String(formData.get('sourceUrl') || '').trim();
  elements.addMessage.textContent = '正在加入…';
  elements.addMessage.className = 'form-message is-working';

  try {
    await apiRequest('/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, sourceUrl }),
    });
    elements.addForm.reset();
    elements.addMessage.textContent = '已加入，点击“刷新全部”读取内容';
    elements.addMessage.className = 'form-message is-success';
    await loadState();
    showToast('账号已加入监控列表', 'success');
  } catch (error) {
    elements.addMessage.textContent = error.message || '加入失败';
    elements.addMessage.className = 'form-message is-error';
  }
}

async function markSeen(fingerprint) {
  try {
    await apiRequest('/api/works/seen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint }),
    });
    const work = state.works.find((item) => item.fingerprint === fingerprint);
    if (work) {
      work.seen = true;
    }
    state.stats.unseenWorkCount = Math.max(0, (state.stats.unseenWorkCount || 0) - 1);
    render();
    await loadAdminData();
  } catch (error) {
    showToast(error.message || '标记失败', 'error');
  }
}

async function submitFeedback(event) {
  event.preventDefault();
  const formData = new FormData(elements.feedbackForm);
  const message = String(formData.get('message') || '').trim();
  const category = String(formData.get('category') || 'other');
  elements.feedbackMessage.textContent = '正在提交…';
  elements.feedbackMessage.className = 'form-message is-working';

  try {
    await apiRequest('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category, message }),
    });
    elements.feedbackForm.reset();
    elements.feedbackMessage.textContent = '已提交，感谢反馈';
    elements.feedbackMessage.className = 'form-message is-success';
    showToast('反馈已提交', 'success');
    await loadAdminData();
  } catch (error) {
    elements.feedbackMessage.textContent = error.message || '提交失败';
    elements.feedbackMessage.className = 'form-message is-error';
  }
}

async function login(event) {
  event.preventDefault();
  const formData = new FormData(elements.loginForm);
  const username = String(formData.get('username') || '').trim();
  const password = String(formData.get('password') || '');
  elements.loginMessage.textContent = '正在登录…';
  elements.loginMessage.className = 'form-message is-working';

  try {
    const payload = await apiRequest('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    state.viewer = payload.user;
    isAuthenticated = true;
    hideLogin();
    render();
    await loadState();
    showToast('登录成功', 'success');
  } catch (error) {
    elements.loginMessage.textContent = error.message || '登录失败';
    elements.loginMessage.className = 'form-message is-error';
  }
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', cache: 'no-store' });
  } finally {
    isAuthenticated = false;
    state.viewer = null;
    if (authRequired) {
      render();
      showLogin();
    }
  }
}

function resetAutoRefresh() {
  window.clearInterval(autoRefreshTimer);
  const minutes = Number(elements.autoRefresh.value);
  if (minutes > 0 && isAuthenticated) {
    autoRefreshTimer = window.setInterval(refreshAll, minutes * 60 * 1000);
  }
  window.localStorage.setItem('xhs-monitor-auto-refresh', String(minutes));
}

async function loadSession() {
  try {
    const configPayload = await apiRequest('/api/auth/config');
    Object.assign(state.auth, configPayload.auth || {});
    authRequired = Boolean(state.auth.required);

    let mePayload;
    try {
      mePayload = await apiRequest('/api/auth/me');
    } catch (error) {
      if (error.httpStatus === 401) {
        isAuthenticated = false;
        render();
        if (authRequired) {
          showLogin();
        }
        return;
      }
      throw error;
    }

    state.viewer = mePayload.user;
    isAuthenticated = true;
    hideLogin();
    render();
    resetAutoRefresh();
    await loadState();
  } catch (error) {
    elements.runtimeStatus.className = 'runtime-status is-warning';
    elements.runtimeStatus.innerHTML = '<i></i>服务连接失败';
    showToast(error.message || '无法连接服务', 'error');
  }
}

function init() {
  const savedFrequency = window.localStorage.getItem('xhs-monitor-auto-refresh');
  if (savedFrequency && ['0', '30', '60'].includes(savedFrequency)) {
    elements.autoRefresh.value = savedFrequency;
  }
  elements.refreshButton.addEventListener('click', refreshAll);
  if (window.desktopUpdater && elements.updateButton) {
    elements.updateButton.addEventListener('click', handleUpdaterClick);
    window.desktopUpdater.onStatus(renderUpdater);
    renderUpdater();
  }
  elements.addForm.addEventListener('submit', addAccount);
  elements.feedbackForm.addEventListener('submit', submitFeedback);
  elements.loginForm.addEventListener('submit', login);
  elements.authArea.addEventListener('click', (event) => {
    if (event.target.closest('[data-logout]')) {
      logout();
    }
  });
  elements.filter.addEventListener('change', (event) => {
    accountFilter = event.target.value;
    renderAccounts();
  });
  elements.autoRefresh.addEventListener('change', resetAutoRefresh);
  elements.works.addEventListener('click', (event) => {
    const button = event.target.closest('[data-seen]');
    if (button) {
      markSeen(button.dataset.seen);
    }
  });
  render();
  resetAutoRefresh();
  loadSession();
  statePollTimer = window.setInterval(() => {
    if (isAuthenticated) {
      loadState();
    }
  }, 5000);
}

init();
