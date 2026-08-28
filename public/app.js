const state = {
  accounts: [],
  works: [],
  platforms: [],
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

const VIEW_META = {
  overview: {
    eyebrow: 'WORKSPACE / OVERVIEW',
    title: '总览',
    description: '先看今天的监控动态和需要处理的账号。',
  },
  monitor: {
    eyebrow: 'MONITOR CENTER',
    title: '监控中心',
    description: '按平台查看监控账号、最新作品和采集状态。',
  },
  content: {
    eyebrow: 'CONTENT CENTER',
    title: '内容中心',
    description: '把监控到的作品沉淀为选题、素材和案例。',
  },
  publish: {
    eyebrow: 'PUBLISH CENTER',
    title: '发布中心',
    description: '统一准备多平台版本，保留发布前人工确认。',
  },
  insights: {
    eyebrow: 'DATA INSIGHTS',
    title: '数据洞察',
    description: '比较账号、平台和内容表现，找到可复用动作。',
  },
  ai: {
    eyebrow: 'AI WORKSPACE',
    title: 'AI 工作区',
    description: '让 AI 整理与分析，人保留策略和最终判断。',
  },
  collab: {
    eyebrow: 'FEEDBACK LOOP',
    title: '反馈与协作',
    description: '收集客户反馈，让每次使用都能推动下一版。',
  },
  settings: {
    eyebrow: 'SETTINGS & RELEASES',
    title: '设置与更新',
    description: '管理客户端更新、服务连接和监控频率。',
  },
};

const PLATFORM_META = {
  xhs: {
    label: '小红书',
    symbol: '红',
    className: 'platform-xhs',
    mode: '公开主页监控',
  },
  douyin: {
    label: '抖音',
    symbol: '音',
    className: 'platform-douyin',
    mode: '公开主页监控 · Beta',
  },
  channels: {
    label: '视频号',
    symbol: '号',
    className: 'platform-channels',
    mode: '后续接入',
  },
  other: {
    label: '其他平台',
    symbol: '＋',
    className: 'platform-other',
    mode: '按需扩展',
  },
};

let accountFilter = 'all';
let platformFilter = 'all';
let workPlatformFilter = 'all';
let selectedAccountId = null;
let currentView = 'overview';
let autoRefreshTimer = null;
let statePollTimer = null;
let isRefreshing = false;
let isAuthenticated = false;
let authRequired = false;
let updaterPhase = 'idle';
let updaterCheckTimer = null;
let updaterVersion = '';

const elements = {
  stats: document.querySelector('#stats'),
  accounts: document.querySelector('#overview-account-health'),
  works: document.querySelector('#works-feed'),
  accountCount: document.querySelector('#monitor-account-count'),
  feedCount: document.querySelector('#feed-count-label'),
  lastRefresh: document.querySelector('#last-refresh'),
  runtimeStatus: document.querySelector('#runtime-status'),
  refreshError: document.querySelector('#refresh-error'),
  updateButton: document.querySelector('#update-app'),
  settingsUpdateButton: document.querySelector('#settings-update'),
  settingsUpdateNote: document.querySelector('#settings-update-note'),
  settingsConnection: document.querySelector('#settings-connection'),
  settingsAutoRefresh: document.querySelector('#settings-auto-refresh'),
  refreshButton: document.querySelector('#refresh-all'),
  addForm: document.querySelector('#add-account-form'),
  addMessage: document.querySelector('#add-account-message'),
  filter: document.querySelector('#account-filter'),
  platformFilter: document.querySelector('#platform-filter'),
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
  currentViewEyebrow: document.querySelector('#current-view-eyebrow'),
  currentViewTitle: document.querySelector('#current-view-title'),
  currentViewDescription: document.querySelector('#current-view-description'),
  overviewHighlights: document.querySelector('#overview-highlights'),
  accountHealth: document.querySelector('#overview-account-health'),
  monitorAccountCount: document.querySelector('#monitor-account-count'),
  monitorFeedLabel: document.querySelector('#monitor-feed-label'),
  monitorSelection: document.querySelector('#monitor-selection'),
  monitorClearAccount: document.querySelector('#monitor-clear-account'),
  monitorSplitter: document.querySelector('#monitor-splitter'),
  monitorLayout: document.querySelector('#monitor-layout'),
  workPlatformTabs: document.querySelector('#work-platform-tabs'),
  viewPanels: [...document.querySelectorAll('[data-view-panel]')],
  navItems: [...document.querySelectorAll('.nav-item[data-view]')],
  navBadges: [...document.querySelectorAll('[data-nav-badge]')],
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

function platformFor(platform) {
  return PLATFORM_META[platform] || PLATFORM_META.other;
}

function platformLabel(platform) {
  return platformFor(platform).label;
}

function accountInitial(account) {
  const source = String(account?.name || account?.nickname || '').trim();
  const first = [...source.replace(/\s+/g, '')][0];
  return first || platformFor(account?.platform).symbol;
}

function accountAvatarMarkup(account, className = 'account-avatar') {
  const platform = platformFor(account?.platform);
  const dataAttributes =
    ' data-platform-class="' +
    escapeHtml(platform.className) +
    '" data-initial="' +
    escapeHtml(accountInitial(account)) +
    '"';
  if (isHttpUrl(account?.avatarUrl)) {
    return (
      '<span class="' +
      escapeHtml(className) +
      '"' +
      dataAttributes +
      '><img src="' +
      escapeHtml(account.avatarUrl) +
      '" alt="' +
      escapeHtml((account?.name || platform.label) + '头像') +
      '" decoding="async" referrerpolicy="no-referrer" /></span>'
    );
  }
  return (
    '<span class="' +
    escapeHtml(className) +
    ' account-avatar-fallback ' +
    platform.className +
    '"' +
    dataAttributes +
    ' aria-hidden="true">' +
    escapeHtml(accountInitial(account)) +
    '</span>'
  );
}

function bindAvatarFallbacks(container) {
  container?.querySelectorAll('.account-avatar img, .work-account-avatar img').forEach((image) => {
    image.addEventListener(
      'error',
      () => {
        const avatar = image.closest('.account-avatar, .work-account-avatar');
        if (!avatar) {
          return;
        }
        const fallback = document.createElement('span');
        fallback.className =
          avatar.className + ' account-avatar-fallback ' +
          (avatar.dataset.platformClass || 'platform-other');
        fallback.textContent = avatar.dataset.initial || '＋';
        image.replaceWith(fallback);
      },
      { once: true },
    );
  });
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
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
  const visibleAccounts = state.accounts.filter((account) => {
    const matchesState = accountFilter === 'all' || account.state === accountFilter;
    const matchesPlatform =
      platformFilter === 'all' || (account.platform || 'other') === platformFilter;
    return matchesState && matchesPlatform;
  });
  elements.accountCount.textContent = state.accounts.length;

  if (visibleAccounts.length === 0) {
    elements.accounts.innerHTML =
      '<div class="empty-state compact"><span>◌</span><p>没有符合条件的账号</p></div>';
    return;
  }

  elements.accounts.innerHTML = visibleAccounts
    .map((account) => {
      const platform = platformFor(account.platform);
      const error =
        account.state === 'error' && account.lastError
          ? '<p class="account-error">' + escapeHtml(account.lastError) + '</p>'
          : '';
      const profileUrl = account.canonicalUrl || account.sourceUrl;
      const creator =
        account.createdBy && account.createdBy !== 'system'
          ? '加入者 ' + account.createdBy
          : '';
      const sourceKind = account.sourceKind === 'short' ? '分享短链' : '公开主页';
      return (
        '<article class="account-card state-' +
        escapeHtml(account.state) +
        '">' +
        '<div class="account-card-top">' +
        '<div class="account-title-wrap">' +
        accountAvatarMarkup(account) +
        '<span class="state-dot"></span><div>' +
        '<div class="account-platform-line"><span class="platform-chip ' +
        platform.className +
        '"><i>' +
        escapeHtml(platform.symbol) +
        '</i>' +
        escapeHtml(platform.label) +
        '</span><span class="source-kind">' +
        escapeHtml(sourceKind) +
        '</span></div><h3>' +
        escapeHtml(account.name) +
        '</h3><p>' +
        escapeHtml(account.nickname || '尚未读取主页名称') +
        '</p></div></div>' +
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
        '<div class="account-card-footer"><span class="source-mini">' +
        escapeHtml(platform.mode) +
        '</span><div class="account-card-actions"><a href="' +
        escapeHtml(profileUrl) +
        '" target="_blank" rel="noreferrer">打开主页 ↗</a><button class="account-delete" type="button" data-delete-account="' +
        escapeHtml(account.id) +
        '">删除</button></div></div>' +
        '</article>'
      );
    })
    .join('');
  bindAvatarFallbacks(elements.accounts);
}

function coverMarkup(work, platform) {
  if (isHttpUrl(work.coverUrl)) {
    return (
      '<div class="work-cover"><img src="' +
      escapeHtml(work.coverUrl) +
      '" alt="' +
      escapeHtml(platformLabel(platform) + '作品封面') +
      '" loading="lazy" referrerpolicy="no-referrer" /></div>'
    );
  }
  return (
    '<div class="work-cover is-placeholder"><span>' +
    escapeHtml(platformFor(platform).symbol) +
    '</span><small>暂无封面</small></div>'
  );
}

function workTimestamp(work) {
  const value = Date.parse(work?.publishedAt || work?.discoveredAt || '');
  return Number.isNaN(value) ? 0 : value;
}

function renderWorks() {
  const selectedAccount = selectedAccountId ? accountFor(selectedAccountId) : null;
  if (selectedAccountId && !selectedAccount) {
    selectedAccountId = null;
  }

  const visibleWorks = state.works
    .filter((work) => {
      const account = accountFor(work.accountId);
      const platform = work.platform || account?.platform || 'other';
      const matchesPlatform = workPlatformFilter === 'all' || platform === workPlatformFilter;
      const matchesAccount = !selectedAccountId || work.accountId === selectedAccountId;
      return matchesPlatform && matchesAccount;
    })
    .sort((left, right) => workTimestamp(right) - workTimestamp(left));

  elements.feedCount.textContent = visibleWorks.length + ' 条';
  if (elements.monitorFeedLabel) {
    elements.monitorFeedLabel.textContent = selectedAccount
      ? selectedAccount.name + ' · ' + visibleWorks.length + ' 条作品'
      : visibleWorks.length + ' 条公开作品';
  }
  if (elements.monitorSelection) {
    elements.monitorSelection.classList.toggle('is-hidden', !selectedAccount);
    elements.monitorSelection.textContent = selectedAccount
      ? '正在查看：' + selectedAccount.name + ' · 按发布时间倒序'
      : '';
  }
  if (elements.monitorClearAccount) {
    elements.monitorClearAccount.classList.toggle('is-hidden', !selectedAccount);
  }

  if (visibleWorks.length === 0) {
    const emptyTitle = selectedAccount
      ? '该账号暂时没有作品'
      : state.works.length === 0
        ? '还没有作品'
        : '该平台暂时没有作品';
    const emptyDescription = selectedAccount
      ? selectedAccount.state === 'error' && selectedAccount.lastError
        ? selectedAccount.lastError
        : '刷新该账号后，这里会显示作品封面、标题和发布时间。'
      : state.works.length === 0
        ? '点击右上角“刷新全部”，读取监控列表中的公开主页。'
        : '换一个平台筛选，或先刷新监控账号。';
    elements.works.innerHTML =
      '<div class="empty-state"><div class="empty-orbit">⌁</div><h3>' +
      escapeHtml(emptyTitle) +
      '</h3><p>' +
      escapeHtml(emptyDescription) +
      '</p></div>';
    return;
  }

  elements.works.innerHTML = visibleWorks
    .map((work) => {
      const account = accountFor(work.accountId);
      const platform = work.platform || account?.platform || 'other';
      const platformInfo = platformFor(platform);
      const isNew = !work.seen;
      const contentId = work.contentId || work.noteId;
      const linkLabel = contentId ? '打开作品 ↗' : '打开主页 ↗';
      const accountName = account?.name || '未知账号';
      const accountForAvatar = account || { name: accountName, platform };
      const extractionLabel =
        work.extraction === 'embedded-profile-state'
          ? '内嵌状态'
          : work.extraction === 'page-text'
            ? '页面文本'
            : '页面解析';
      const link = isHttpUrl(work.link)
        ? work.link
        : account?.canonicalUrl || account?.sourceUrl || '#';
      return (
        '<article class="work-card ' +
        (isNew ? 'is-new' : '') +
        '"><div class="work-cover-wrap">' +
        coverMarkup(work, platform) +
        (isNew ? '<span class="new-badge">新发现</span>' : '') +
        '</div><div class="work-card-body"><div class="work-topline"><span class="source-chip ' +
        platformInfo.className +
        '"><i>' +
        escapeHtml(platformInfo.symbol) +
        '</i>' +
        escapeHtml(platformInfo.label) +
        '</span><span class="work-account-name">' +
        accountAvatarMarkup(accountForAvatar, 'work-account-avatar') +
        '<span>' +
        escapeHtml(accountName) +
        '</span></span>' +
        '<span class="work-time">' +
        formatTime(work.publishedAt, '时间待解析') +
        '</span></div><h3>' +
        escapeHtml(work.title || '未命名作品') +
        '</h3><div class="work-bottomline"><span class="work-source">' +
        escapeHtml(extractionLabel) +
        (work.likes ? ' · ' + escapeHtml(work.likes) + ' 赞' : '') +
        '</span><span class="work-actions"><a href="' +
        escapeHtml(link) +
        '" target="_blank" rel="noreferrer">' +
        linkLabel +
        '</a>' +
        (isNew
          ? '<button type="button" data-seen="' +
            escapeHtml(work.fingerprint) +
            '">标为已读</button>'
          : '') +
        '</span></div></div>' +
        '</article>'
      );
    })
    .join('');

  bindAvatarFallbacks(elements.works);

  elements.works.querySelectorAll('.work-cover img').forEach((image) => {
    image.addEventListener(
      'error',
      () => {
        image.closest('.work-cover')?.classList.add('is-placeholder');
        const fallback = document.createElement('span');
        fallback.textContent = '封面暂不可用';
        image.replaceWith(fallback);
      },
      { once: true },
    );
  });
}

function renderOverview() {
  if (!elements.overviewHighlights) {
    return;
  }
  const attentionCount = state.accounts.filter((account) => account.state === 'error').length;
  const xhsCount = state.stats.platformCounts?.xhs || 0;
  const douyinCount = state.stats.platformCounts?.douyin || 0;
  const unseen = state.stats.unseenWorkCount || 0;
  const rows = [
    {
      icon: unseen ? '!' : '✓',
      label: unseen ? '有新作品待查看' : '暂无未读作品',
      value: unseen ? unseen + ' 条' : '已清空',
      tone: unseen ? 'orange' : 'green',
      detail: unseen ? '进入监控中心查看封面和链接' : '刷新后会自动建立新作品基线',
    },
    {
      icon: attentionCount ? '!' : '✓',
      label: attentionCount ? '有账号需要处理' : '账号状态正常',
      value: attentionCount ? attentionCount + ' 个' : '已连接',
      tone: attentionCount ? 'red' : 'blue',
      detail: attentionCount
        ? '查看账号卡片里的具体失败原因'
        : '小红书 ' + xhsCount + ' · 抖音 ' + douyinCount,
    },
    {
      icon: '↗',
      label: '下一步工作台动作',
      value: '先监控，再沉淀',
      tone: 'ink',
      detail: '内容、发布、洞察和 AI 模块已留好位置',
    },
  ];
  elements.overviewHighlights.innerHTML = rows
    .map(
      (row) =>
        '<div class=\"highlight-row\"><span class=\"highlight-icon tone-' +
        row.tone +
        '\">' +
        escapeHtml(row.icon) +
        '</span><div><strong>' +
        escapeHtml(row.label) +
        '</strong><small>' +
        escapeHtml(row.detail) +
        '</small></div><b>' +
        escapeHtml(row.value) +
        '</b></div>',
    )
    .join('');
}

function renderWorkPlatformTabs() {
  if (!elements.workPlatformTabs) {
    return;
  }
  elements.workPlatformTabs.querySelectorAll('[data-work-platform]').forEach((button) => {
    const active = button.dataset.workPlatform === workPlatformFilter;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
}

function renderAccountHealth() {
  if (!elements.accountHealth) {
    return;
  }
  const visibleAccounts = state.accounts.filter((account) => {
    const matchesState = accountFilter === 'all' || account.state === accountFilter;
    const matchesPlatform =
      platformFilter === 'all' || (account.platform || 'other') === platformFilter;
    const matchesWorkTab =
      workPlatformFilter === 'all' || (account.platform || 'other') === workPlatformFilter;
    return matchesState && matchesPlatform && matchesWorkTab;
  });
  if (elements.monitorAccountCount) {
    elements.monitorAccountCount.textContent = visibleAccounts.length + ' 个';
  }

  const rows = visibleAccounts.map((account) => {
    const platform = platformFor(account.platform);
    const profileUrl = account.canonicalUrl || account.sourceUrl || '#';
    const workCount = state.works.filter((work) => work.accountId === account.id).length;
    const unreadCount = state.works.filter(
      (work) => work.accountId === account.id && !work.seen,
    ).length;
    const isSelected = selectedAccountId === account.id;
    const statusClass =
      account.state === 'error'
        ? 'is-error'
        : account.state === 'active'
          ? 'is-ok'
          : 'is-pending';
    const statusText =
      account.state === 'error'
        ? '需处理'
        : account.state === 'active'
          ? '已连接'
          : '待刷新';
    const subtitle =
      account.state === 'error' && account.lastError
        ? account.lastError
        : account.nickname && !/^小红书 - 你的生活兴趣社区$/.test(account.nickname)
          ? account.nickname
          : platform.mode;
    return (
      '<article class="monitor-account-row state-' +
      escapeHtml(account.state) +
      (isSelected ? ' is-selected' : '') +
      '" data-monitor-account="' +
      escapeHtml(account.id) +
      '" role="button" tabindex="0" aria-pressed="' +
      String(isSelected) +
      '" title="点击查看 ' +
      escapeHtml(account.name) +
      ' 的作品"><div class="monitor-account-main">' +
      accountAvatarMarkup(account) +
      '<div class="monitor-account-copy"><strong>' +
      escapeHtml(account.name) +
      '</strong><small><span class="monitor-platform-label ' +
      platform.className +
      '"><i>' +
      escapeHtml(platform.symbol) +
      '</i>' +
      escapeHtml(platform.label) +
      '</span><span class="monitor-account-subtitle">' +
      escapeHtml(subtitle) +
      '</span></small></div></div><div class="monitor-account-side"><div class="monitor-account-count"><b>' +
      String(workCount) +
      '</b><small>作品数</small></div>' +
      (unreadCount
        ? '<span class="monitor-unread-badge" title="' +
          unreadCount +
          ' 条新作品待查看" aria-label="' +
          unreadCount +
          ' 条新作品待查看">!</span>'
        : '') +
      '<div class="monitor-account-actions"><span class="health-status ' +
      statusClass +
      '">' +
      statusText +
      '</span><a href="' +
      escapeHtml(profileUrl) +
      '" target="_blank" rel="noreferrer">打开 ↗</a><button class="monitor-delete-account" type="button" data-delete-account="' +
      escapeHtml(account.id) +
      '" aria-label="删除 ' +
      escapeHtml(account.name) +
      '">删除</button></div></div></article>'
    );
  });
  elements.accountHealth.innerHTML = rows.length
    ? rows.join('')
    : '<div class="empty-state compact"><span>◎</span><p>还没有符合条件的监控账号</p></div>';
  bindAvatarFallbacks(elements.accountHealth);
}

function renderSettings() {
  if (elements.settingsConnection) {
    elements.settingsConnection.textContent = authRequired
      ? state.viewer
        ? '已连接中央服务，账号和作品由服务端统一保存。'
        : '需要登录后才能读取中央服务。'
      : '当前使用本地服务，数据保存在本机 data/ 目录。';
  }
  if (elements.settingsAutoRefresh) {
    elements.settingsAutoRefresh.value = elements.autoRefresh.value;
  }
}

function renderNavigationBadges() {
  const values = {
    accounts: state.stats.accountCount ?? state.accounts.length,
    works: state.stats.unseenWorkCount ?? state.works.filter((work) => !work.seen).length,
  };
  elements.navBadges.forEach((badge) => {
    const value = values[badge.dataset.navBadge] ?? 0;
    badge.textContent = value;
    badge.classList.toggle('is-empty', value === 0);
  });
}

function setView(view, options = {}) {
  const requestedView = view === 'accounts' ? 'monitor' : view;
  const nextView = VIEW_META[requestedView] ? requestedView : 'overview';
  const viewChanged = currentView !== nextView;
  currentView = nextView;
  const meta = VIEW_META[nextView];
  elements.currentViewEyebrow.textContent = meta.eyebrow;
  elements.currentViewTitle.textContent = meta.title;
  elements.currentViewDescription.textContent = meta.description;
  elements.viewPanels.forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.viewPanel === nextView);
  });
  elements.navItems.forEach((item) => {
    item.classList.toggle('is-active', item.dataset.view === nextView);
  });
  if (options.updateHash !== false && window.location.hash !== '#' + nextView) {
    window.history.replaceState(null, '', '#' + nextView);
  }
  if (viewChanged && options.scroll !== false) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
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
      account_removed: '移除账号',
      account_seen: '查看账号',
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

function updateUpdaterControls(text, disabled) {
  [elements.updateButton, elements.settingsUpdateButton]
    .filter(Boolean)
    .forEach((button) => {
      button.textContent = text;
      button.disabled = disabled;
    });
}

function clearUpdaterCheckTimer() {
  if (updaterCheckTimer) {
    window.clearTimeout(updaterCheckTimer);
    updaterCheckTimer = null;
  }
}

function armUpdaterCheckTimer() {
  if (updaterCheckTimer) {
    return;
  }
  updaterCheckTimer = window.setTimeout(() => {
    updaterCheckTimer = null;
    if (updaterPhase === 'checking') {
      renderUpdater({
        status: 'error',
        message: '检查更新超时，请稍后重试',
      });
    }
  }, 20000);
}

function renderUpdater(payload = {}) {
  if (!window.desktopUpdater) {
    clearUpdaterCheckTimer();
    elements.updateButton?.classList.add('is-hidden');
    if (elements.settingsUpdateButton) {
      elements.settingsUpdateButton.disabled = true;
      elements.settingsUpdateButton.textContent = '桌面端检查更新';
    }
    if (elements.settingsUpdateNote) {
      elements.settingsUpdateNote.textContent =
        '当前是网页模式；打包后的桌面客户端可以下载并重启安装。';
    }
    return;
  }

  elements.updateButton?.classList.remove('is-hidden');
  if (elements.settingsUpdateNote) {
    elements.settingsUpdateNote.textContent =
      '桌面客户端通过 GitHub Release 下载，安装前会保留本地数据。';
  }
  const status = payload.status || updaterPhase;
  const percent = Number.isFinite(payload.percent) ? payload.percent : 0;

  if (status === 'checking') {
    updaterPhase = 'checking';
    updateUpdaterControls('检查中…', true);
    armUpdaterCheckTimer();
    return;
  }
  if (status === 'available') {
    clearUpdaterCheckTimer();
    updaterPhase = 'available';
    updaterVersion = payload.version || updaterVersion;
    updateUpdaterControls(
      updaterVersion ? '下载更新 v' + updaterVersion : '下载更新',
      false,
    );
    return;
  }
  if (status === 'downloading') {
    clearUpdaterCheckTimer();
    updaterPhase = 'downloading';
    updateUpdaterControls('下载中 ' + percent + '%', true);
    return;
  }
  if (status === 'downloaded') {
    clearUpdaterCheckTimer();
    updaterPhase = 'downloaded';
    updateUpdaterControls('重启安装更新', false);
    return;
  }
  if (status === 'not-available') {
    clearUpdaterCheckTimer();
    updaterPhase = 'idle';
    updateUpdaterControls('已是最新', false);
    return;
  }
  if (status === 'dev') {
    clearUpdaterCheckTimer();
    updaterPhase = 'idle';
    updateUpdaterControls('开发模式', false);
    return;
  }
  if (status === 'error') {
    clearUpdaterCheckTimer();
    updaterPhase = 'idle';
    updateUpdaterControls('更新失败，重试', false);
    if (payload.message) {
      showToast('更新检查失败：' + payload.message, 'warning');
    }
    return;
  }

  updateUpdaterControls('检查更新', false);
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
    if (result?.status && result.status !== 'checking') {
      renderUpdater(result);
    }
    if (result?.status === 'dev') {
      showToast('当前是开发模式，打包后可检查 GitHub Release', 'normal');
    }
  } catch (error) {
    renderUpdater({ status: 'error', message: error.message || String(error) });
  }
}

function render() {
  renderAuth();
  renderStats();
  renderWorkPlatformTabs();
  renderWorks();
  renderOverview();
  renderAccountHealth();
  renderSettings();
  renderRuntime();
  renderAdmin();
  renderNavigationBadges();
  setView(currentView, { updateHash: false });
  renderUpdater();
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

async function deleteAccount(accountId) {
  const account = accountFor(accountId);
  if (!account) {
    return;
  }
  const confirmed = window.confirm(
    '确定删除“' +
      account.name +
      '”吗？\n\n这会同时删除本地已抓取的该账号作品，且无法从工作台恢复。',
  );
  if (!confirmed) {
    return;
  }

  try {
    const payload = await apiRequest('/api/accounts/' + encodeURIComponent(accountId), {
      method: 'DELETE',
    });
    if (selectedAccountId === accountId) {
      selectedAccountId = null;
    }
    await loadState();
    showToast(
      '已删除 ' +
        account.name +
        (payload.removedWorks ? '，同步移除 ' + payload.removedWorks + ' 条作品' : ''),
      'success',
    );
  } catch (error) {
    showToast(error.message || '删除账号失败', 'error');
  }
}

async function selectMonitorAccount(accountId) {
  const account = accountFor(accountId);
  if (!account) {
    return;
  }

  selectedAccountId = accountId;
  renderWorks();
  renderAccountHealth();

  const unreadWorks = state.works.filter(
    (work) => work.accountId === accountId && !work.seen,
  );
  if (!unreadWorks.length) {
    return;
  }

  try {
    const payload = await apiRequest(
      '/api/accounts/' + encodeURIComponent(accountId) + '/seen',
      { method: 'POST' },
    );
    const markedCount = Number(payload.markedCount || unreadWorks.length);
    state.works.forEach((work) => {
      if (work.accountId === accountId) {
        work.seen = true;
      }
    });
    state.stats.unseenWorkCount = Math.max(
      0,
      (state.stats.unseenWorkCount || 0) - markedCount,
    );
    render();
    await loadAdminData();
  } catch (error) {
    showToast(error.message || '更新账号已读状态失败', 'error');
  }
}

function clearSelectedMonitorAccount() {
  selectedAccountId = null;
  renderWorks();
  renderAccountHealth();
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

function applyAutoRefreshFrequency(value) {
  const frequency = ['0', '30', '60'].includes(String(value)) ? String(value) : '0';
  elements.autoRefresh.value = frequency;
  if (elements.settingsAutoRefresh) {
    elements.settingsAutoRefresh.value = frequency;
  }
  window.clearInterval(autoRefreshTimer);
  const minutes = Number(frequency);
  if (minutes > 0 && isAuthenticated) {
    autoRefreshTimer = window.setInterval(refreshAll, minutes * 60 * 1000);
  }
  window.localStorage.setItem('xhs-monitor-auto-refresh', frequency);
}

function resetAutoRefresh(event) {
  applyAutoRefreshFrequency(event?.target?.value || elements.autoRefresh.value);
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

function applyMonitorSplitWidth(value) {
  if (!elements.monitorLayout) {
    return;
  }
  const layoutWidth = elements.monitorLayout.getBoundingClientRect().width;
  const availableMax = layoutWidth ? Math.max(280, layoutWidth - 360) : 560;
  const width = Math.round(
    Math.min(Math.max(Number(value) || 360, 280), Math.min(560, availableMax)),
  );
  elements.monitorLayout.style.setProperty('--monitor-accounts-width', width + 'px');
  elements.monitorSplitter?.setAttribute('aria-valuenow', String(width));
  window.localStorage.setItem('cloud-worker-monitor-split-width', String(width));
}

function initMonitorSplitter() {
  const splitter = elements.monitorSplitter;
  if (!splitter || !elements.monitorLayout) {
    return;
  }

  const savedWidth = Number(
    window.localStorage.getItem('cloud-worker-monitor-split-width'),
  );
  applyMonitorSplitWidth(Number.isFinite(savedWidth) ? savedWidth : 360);

  let dragging = false;
  let pointerId = null;
  let startX = 0;
  let startWidth = 360;

  const stopDragging = () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    pointerId = null;
    document.body.classList.remove('is-resizing');
  };

  splitter.addEventListener('pointerdown', (event) => {
    if (window.matchMedia('(max-width: 860px)').matches) {
      return;
    }
    dragging = true;
    pointerId = event.pointerId;
    startX = event.clientX;
    startWidth =
      Number.parseFloat(
        getComputedStyle(elements.monitorLayout).getPropertyValue(
          '--monitor-accounts-width',
        ),
      ) || elements.monitorLayout.getBoundingClientRect().width * 0.3;
    splitter.setPointerCapture?.(event.pointerId);
    document.body.classList.add('is-resizing');
    event.preventDefault();
  });

  splitter.addEventListener('pointermove', (event) => {
    if (!dragging || event.pointerId !== pointerId) {
      return;
    }
    applyMonitorSplitWidth(startWidth + event.clientX - startX);
  });

  splitter.addEventListener('pointerup', stopDragging);
  splitter.addEventListener('pointercancel', stopDragging);
  splitter.addEventListener('lostpointercapture', stopDragging);
  splitter.addEventListener('keydown', (event) => {
    const current =
      Number.parseFloat(
        getComputedStyle(elements.monitorLayout).getPropertyValue(
          '--monitor-accounts-width',
        ),
      ) || 360;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      applyMonitorSplitWidth(current + (event.key === 'ArrowRight' ? 20 : -20));
      event.preventDefault();
    }
    if (event.key === 'Home' || event.key === 'End') {
      applyMonitorSplitWidth(event.key === 'Home' ? 280 : 560);
      event.preventDefault();
    }
  });
}

function init() {
  const savedFrequency = window.localStorage.getItem('xhs-monitor-auto-refresh');
  applyAutoRefreshFrequency(savedFrequency || '0');
  initMonitorSplitter();

  elements.navItems.forEach((item) => {
    item.addEventListener('click', () => setView(item.dataset.view));
  });
  document.querySelectorAll('[data-view]:not(.nav-item)').forEach((item) => {
    item.addEventListener('click', (event) => {
      event.preventDefault();
      setView(item.dataset.view);
    });
  });
  window.addEventListener('hashchange', () => {
    setView(window.location.hash.slice(1), { updateHash: false });
  });

  elements.refreshButton.addEventListener('click', refreshAll);
  [elements.updateButton, elements.settingsUpdateButton]
    .filter(Boolean)
    .forEach((button) => button.addEventListener('click', handleUpdaterClick));
  if (window.desktopUpdater) {
    window.desktopUpdater.onStatus(renderUpdater);
  }
  renderUpdater();

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
    renderAccountHealth();
  });
  elements.platformFilter.addEventListener('change', (event) => {
    platformFilter = event.target.value;
    workPlatformFilter = platformFilter;
    selectedAccountId = null;
    renderWorkPlatformTabs();
    renderWorks();
    renderAccountHealth();
  });
  elements.workPlatformTabs?.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-work-platform]');
    if (!tab) {
      return;
    }
    workPlatformFilter = tab.dataset.workPlatform || 'all';
    platformFilter = workPlatformFilter;
    if (elements.platformFilter) {
      elements.platformFilter.value = platformFilter;
    }
    selectedAccountId = null;
    renderWorkPlatformTabs();
    renderWorks();
    renderAccountHealth();
  });
  elements.autoRefresh.addEventListener('change', resetAutoRefresh);
  elements.settingsAutoRefresh?.addEventListener('change', resetAutoRefresh);
  elements.accounts.addEventListener('click', (event) => {
    const deleteButton = event.target.closest('[data-delete-account]');
    if (deleteButton) {
      event.stopPropagation();
      deleteAccount(deleteButton.dataset.deleteAccount);
      return;
    }
    if (event.target.closest('a')) {
      return;
    }
    const row = event.target.closest('[data-monitor-account]');
    if (row) {
      selectMonitorAccount(row.dataset.monitorAccount);
    }
  });
  elements.accounts.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    if (event.target.closest('[data-delete-account], a')) {
      return;
    }
    const row = event.target.closest('[data-monitor-account]');
    if (!row) {
      return;
    }
    event.preventDefault();
    selectMonitorAccount(row.dataset.monitorAccount);
  });
  elements.monitorClearAccount?.addEventListener('click', clearSelectedMonitorAccount);
  elements.works.addEventListener('click', (event) => {
    const button = event.target.closest('[data-seen]');
    if (button) {
      markSeen(button.dataset.seen);
    }
  });

  const initialView = window.location.hash.slice(1);
  setView(initialView, { updateHash: true });
  render();
  applyAutoRefreshFrequency(elements.autoRefresh.value);
  loadSession();
  statePollTimer = window.setInterval(() => {
    if (isAuthenticated) {
      loadState();
    }
  }, 5000);
}

init();
