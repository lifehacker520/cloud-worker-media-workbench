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
  accounts: {
    eyebrow: 'ACCOUNT MATRIX',
    title: '账号矩阵',
    description: '统一管理需要观察的平台主页。',
  },
  monitor: {
    eyebrow: 'MONITOR CENTER',
    title: '监控中心',
    description: '按平台查看新作品、封面和采集状态。',
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
    description: '管理客户端版本、服务连接和平台接入边界。',
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
let currentView = 'overview';
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
  settingsUpdateButton: document.querySelector('#settings-update'),
  settingsUpdateNote: document.querySelector('#settings-update-note'),
  settingsConnection: document.querySelector('#settings-connection'),
  settingsPlatforms: document.querySelector('#settings-platforms'),
  refreshButton: document.querySelector('#refresh-all'),
  addForm: document.querySelector('#add-account-form'),
  addMessage: document.querySelector('#add-account-message'),
  filter: document.querySelector('#account-filter'),
  platformFilter: document.querySelector('#platform-filter'),
  workPlatformFilter: document.querySelector('#work-platform-filter'),
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
  monitorFeedLabel: document.querySelector('#monitor-feed-label'),
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
        '<div class="account-title-wrap"><span class="state-dot"></span><div>' +
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

function renderWorks() {
  const visibleWorks = state.works.filter((work) => {
    const platform = work.platform || accountFor(work.accountId)?.platform || 'other';
    return workPlatformFilter === 'all' || platform === workPlatformFilter;
  });
  elements.feedCount.textContent = visibleWorks.length + ' 条';
  if (elements.monitorFeedLabel) {
    elements.monitorFeedLabel.textContent =
      visibleWorks.length === state.works.length
        ? '公开作品'
        : '筛选后 ' + visibleWorks.length + ' / ' + state.works.length;
  }

  if (visibleWorks.length === 0) {
    elements.works.innerHTML =
      state.works.length === 0
        ? '<div class="empty-state"><div class="empty-orbit">↻</div><h3>还没有作品</h3><p>点击右上角“刷新全部”，读取监控列表中的公开主页。</p></div>'
        : '<div class="empty-state"><div class="empty-orbit">⌁</div><h3>该平台暂时没有作品</h3><p>换一个平台筛选，或先刷新监控账号。</p></div>';
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
        escapeHtml(accountName) +
        '</span><span class="work-time">' +
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

  elements.works.querySelectorAll('img').forEach((image) => {
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

function renderAccountHealth() {
  if (!elements.accountHealth) {
    return;
  }
  const rows = ['xhs', 'douyin']
    .map((platform) => {
      const accounts = state.accounts.filter((account) => account.platform === platform);
      if (!accounts.length) {
        return null;
      }
      const info = platformFor(platform);
      const active = accounts.filter((account) => account.state === 'active').length;
      const error = accounts.filter((account) => account.state === 'error').length;
      const pending = accounts.length - active - error;
      const stateText = error ? error + ' 个需处理' : pending ? pending + ' 个待刷新' : '全部已连接';
      return (
        '<div class=\"health-row\"><span class=\"platform-logo ' +
        info.className +
        '\">' +
        escapeHtml(info.symbol) +
        '</span><div class=\"health-copy\"><strong>' +
        escapeHtml(info.label) +
        '</strong><small>' +
        escapeHtml(stateText) +
        '</small></div><div class=\"health-numbers\"><b>' +
        accounts.length +
        '</b><small>账号</small></div><span class=\"health-status ' +
        (error ? 'is-error' : pending ? 'is-pending' : 'is-ok') +
        '\">' +
        (error ? '注意' : pending ? '待刷新' : '正常') +
        '</span></div>'
      );
    })
    .filter(Boolean);
  elements.accountHealth.innerHTML = rows.length
    ? rows.join('')
    : '<div class=\"empty-state compact\"><span>◎</span><p>还没有监控账号</p></div>';
}

function renderSettings() {
  if (elements.settingsConnection) {
    elements.settingsConnection.textContent = authRequired
      ? state.viewer
        ? '已连接中央服务，账号和作品由服务端统一保存。'
        : '需要登录后才能读取中央服务。'
      : '当前使用本地服务，数据保存在本机 data/ 目录。';
  }
  if (!elements.settingsPlatforms) {
    return;
  }
  const platforms = state.platforms.length
    ? state.platforms
    : Object.entries(PLATFORM_META).map(([id, info]) => ({
        id,
        label: info.label,
        mode: info.mode,
        status: id === 'xhs' ? 'active' : id === 'douyin' ? 'beta' : 'planned',
      }));
  elements.settingsPlatforms.innerHTML = platforms
    .map((platform) => {
      const info = platformFor(platform.id);
      const statusLabel =
        platform.status === 'active'
          ? '已接入'
          : platform.status === 'beta'
            ? 'Beta'
            : '规划中';
      return (
        '<div class=\"settings-platform-row\"><span class=\"platform-logo ' +
        info.className +
        '\">' +
        escapeHtml(info.symbol) +
        '</span><div><strong>' +
        escapeHtml(platform.label || info.label) +
        '</strong><small>' +
        escapeHtml(platform.mode || info.mode) +
        '</small></div><b class=\"adapter-status is-' +
        escapeHtml(platform.status || 'planned') +
        '\">' +
        statusLabel +
        '</b></div>'
      );
    })
    .join('');
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
  const nextView = VIEW_META[view] ? view : 'overview';
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
  window.scrollTo({ top: 0, behavior: 'smooth' });
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

function renderUpdater(payload = {}) {
  if (!window.desktopUpdater) {
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
    return;
  }
  if (status === 'available') {
    updaterPhase = 'available';
    updateUpdaterControls('下载更新 v' + payload.version, false);
    return;
  }
  if (status === 'downloading') {
    updaterPhase = 'downloading';
    updateUpdaterControls('下载中 ' + percent + '%', true);
    return;
  }
  if (status === 'downloaded') {
    updaterPhase = 'downloaded';
    updateUpdaterControls('重启安装更新', false);
    return;
  }
  if (status === 'not-available') {
    updaterPhase = 'idle';
    updateUpdaterControls('已是最新', false);
    return;
  }
  if (status === 'dev') {
    updaterPhase = 'idle';
    updateUpdaterControls('开发模式', false);
    return;
  }
  if (status === 'error') {
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
    renderAccounts();
  });
  elements.platformFilter.addEventListener('change', (event) => {
    platformFilter = event.target.value;
    renderAccounts();
  });
  elements.workPlatformFilter.addEventListener('change', (event) => {
    workPlatformFilter = event.target.value;
    renderWorks();
  });
  elements.autoRefresh.addEventListener('change', resetAutoRefresh);
  elements.accounts.addEventListener('click', (event) => {
    const deleteButton = event.target.closest('[data-delete-account]');
    if (deleteButton) {
      deleteAccount(deleteButton.dataset.deleteAccount);
    }
  });
  elements.works.addEventListener('click', (event) => {
    const button = event.target.closest('[data-seen]');
    if (button) {
      markSeen(button.dataset.seen);
    }
  });

  const initialView = window.location.hash.slice(1);
  setView(VIEW_META[initialView] ? initialView : 'overview', { updateHash: true });
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
