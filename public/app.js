const state = {
  accounts: [],
  works: [],
  platforms: [],
  stats: {},
  insights: null,
  meta: {},
  viewer: null,
  auth: {
    required: false,
    localDefaults: false,
  },
  platformSessions: null,
  feedback: [],
  activity: [],
};

const VIEW_META = {
  overview: {
    eyebrow: '当前工作区',
    title: '工作台',
    description: '查看今天的待处理事项和下一步。',
  },
  monitor: {
    eyebrow: '工具中心 / 账号监控',
    title: '监控中心',
    description: '查看平台信号、账号状态和需要处理的异常。',
  },
  content: {
    eyebrow: '云员工 / 内容编辑',
    title: '内容编辑云员工',
    description: '从目标和素材开始，形成可审核、可交付的内容任务。',
  },
  publish: {
    eyebrow: '兼容入口',
    title: '发布准备',
    description: '发布准备已收纳到内容编辑工作流，保留旧数据入口。',
  },
  insights: {
    eyebrow: '兼容入口',
    title: '数据洞察',
    description: '数据洞察将在内容任务积累真实结果后接入。',
  },
  ai: {
    eyebrow: '兼容入口',
    title: 'AI 工作区',
    description: 'AI 能力已收纳到内容编辑工作流。',
  },
  planned: {
    eyebrow: '云员工 / 规划中',
    title: '云员工正在规划',
    description: '这个岗位已登记，具体工作流接入后开放。',
  },
  collab: {
    eyebrow: '反馈与协作',
    title: '反馈与协作',
    description: '收集客户反馈，让每次使用都能推动下一版。',
  },
  settings: {
    eyebrow: '工作台设置',
    title: '设置',
    description: '按类别查看工作区、连接和客户端配置。',
  },
};

const PLANNED_ROLE_META = {
  账号运营: { icon: '◎', description: '账号策略、栏目与日常运营工作流正在设计中。' },
  私域跟单: { icon: '⌁', description: '线索跟进、提醒与交接工作流正在设计中。' },
  客户成功客服: { icon: '◌', description: '问题响应、回访与客户记录工作流正在设计中。' },
  'GEO 专员': { icon: '◇', description: '搜索可见性与问答场景工作流正在设计中。' },
  直播运营: { icon: '◉', description: '直播准备、脚本与复盘工作流正在设计中。' },
  电话销售: { icon: '⌕', description: '线索触达、话术与结果记录工作流正在设计中。' },
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
    mode: '需微信会话监控 · Beta',
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
let groupFilter = 'all';
let workPlatformFilter = 'all';
let selectedAccountId = null;
let currentView = 'overview';
let currentRole = '内容编辑云员工';
let currentSettingsPanel = 'general';
let monitorPeriod = 'month';
let insightsRequestId = 0;
let platformSessionRequestId = 0;
let isInsightsLoading = false;
let autoRefreshTimer = null;
let statePollTimer = null;
let isRefreshing = false;
let isAuthenticated = false;
let authRequired = false;
let updaterPhase = 'idle';
let updaterCheckTimer = null;
let updaterVersion = '';
const MONITOR_SPLIT_STORAGE_KEY = 'cloud-worker-monitor-split-width-v2';

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
  settingsUpdateState: document.querySelector('#settings-update-state'),
  settingsConnection: document.querySelector('#settings-connection-status'),
  platformSessionList: document.querySelector('#platform-session-list'),
  platformSessionNote: document.querySelector('#platform-session-note'),
  refreshPlatformSessions: document.querySelector('#refresh-platform-sessions'),
  settingsAutoRefresh: document.querySelector('#settings-auto-refresh'),
  refreshButton: document.querySelector('#refresh-all'),
  refreshLabel: document.querySelector('#refresh-label'),
  addForm: document.querySelector('#add-account-form'),
  addMessage: document.querySelector('#add-account-message'),
  filter: document.querySelector('#account-filter'),
  platformFilter: document.querySelector('#platform-filter'),
  groupFilter: document.querySelector('#group-filter'),
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
  monitorInsights: document.querySelector('#monitor-insights'),
  monitorPeriod: document.querySelector('#monitor-period'),
  monitorInsightsUpdated: document.querySelector('#monitor-insights-updated'),
  monitorInsightsNotice: document.querySelector('#monitor-insights-notice'),
  monitorInsightsKpis: document.querySelector('#monitor-insights-kpis'),
  monitorOperations: document.querySelector('#monitor-operations-grid'),
  monitorPlatformSummary: document.querySelector('#monitor-platform-summary'),
  monitorPlatformSummaryNote: document.querySelector('#monitor-platform-summary-note'),
  monitorTrend: document.querySelector('#monitor-trend'),
  monitorTopWorks: document.querySelector('#monitor-top-works'),
  monitorComments: document.querySelector('#monitor-comments'),
  monitorCommentsCount: document.querySelector('#monitor-comments-count'),
  workPlatformTabs: document.querySelector('#work-platform-tabs'),
  toolsNavToggle: document.querySelector('#tools-nav-toggle'),
  toolsNavSubmenu: document.querySelector('#tools-nav-submenu'),
  settingsNavItems: [...document.querySelectorAll('[data-settings-target]')],
  settingsCards: [...document.querySelectorAll('[data-settings-card]')],
  plannedRoleTitle: document.querySelector('#planned-role-title'),
  plannedRoleDescription: document.querySelector('#planned-role-description'),
  plannedRoleIcon: document.querySelector('#planned-role-icon'),
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

function formatWorkTime(value, fallback = '时间待解析') {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
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

function accountGroup(account) {
  const group = typeof account?.group === 'string' ? account.group.trim() : '';
  return group || '未分组';
}

function accountGroups() {
  return [...new Set(state.accounts.map(accountGroup))].sort((left, right) =>
    left.localeCompare(right, 'zh-CN'),
  );
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

function exactWorkUrl(work, platform) {
  const candidate = isHttpUrl(work?.link) ? work.link : '';
  if (candidate) {
    try {
      const url = new URL(candidate);
      const path = url.pathname;
      if (
        platform === 'xhs' &&
        /\/(?:explore|discovery\/item)\/[A-Za-z0-9_-]{8,100}/i.test(path)
      ) {
        return candidate;
      }
      if (platform === 'douyin' && /\/video\/\d{8,}/i.test(path)) {
        return candidate;
      }
      if (
        platform === 'channels' &&
        ((/weixin\.qq\.com$/i.test(url.hostname) && /\/sph\/[^/?#]+/i.test(path)) ||
          /finder\.video\.qq\.com$/i.test(url.hostname) ||
          (/channels\.weixin\.qq\.com$/i.test(url.hostname) &&
            /\/platform\/(?:post|video)\/[^/?#]+/i.test(path)) ||
          /\/(?:video|media)\/[^/?#]+/i.test(path))
      ) {
        return candidate;
      }
    } catch {
      // Keep the profile fallback when a saved platform URL is malformed.
    }
  }

  const contentId = String(work?.contentId || work?.noteId || '').trim();
  if (platform === 'xhs' && /^[A-Za-z0-9_-]{8,100}$/.test(contentId)) {
    return 'https://www.xiaohongshu.com/explore/' + encodeURIComponent(contentId);
  }
  if (platform === 'douyin' && /^\d{8,}$/.test(contentId)) {
    return 'https://www.douyin.com/video/' + contentId;
  }
  return null;
}

function workLinkTarget(work, account) {
  const platform = work?.platform || account?.platform || 'other';
  const exactUrl = exactWorkUrl(work, platform);
  return {
    exactUrl,
    fallbackUrl: isHttpUrl(work?.link)
      ? work.link
      : account?.canonicalUrl || account?.sourceUrl || '#',
  };
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
    const matchesGroup = groupFilter === 'all' || accountGroup(account) === groupFilter;
    return matchesState && matchesPlatform && matchesGroup;
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
      const matchesGroup = groupFilter === 'all' || accountGroup(account) === groupFilter;
      return matchesPlatform && matchesAccount && matchesGroup;
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
      const accountName = account?.name || '未知账号';
      const accountForAvatar = account || { name: accountName, platform };
      const target = workLinkTarget(work, account);
      const linkLabel = target.exactUrl ? '打开作品 ↗' : '打开账号主页 ↗';
      const linkFallbackNotice = target.exactUrl
        ? ''
        : '<span class="work-link-fallback">作品直链不可用</span>';
      const extractionLabel =
        work.extraction === 'embedded-profile-state'
          ? '内嵌状态'
          : work.extraction === 'page-text'
            ? '页面文本'
            : '页面解析';
      const title = escapeHtml(work.title || '未命名作品');
      const titleMarkup = target.exactUrl
        ? '<a class="work-title-link" href="' +
          escapeHtml(target.exactUrl) +
          '" target="_blank" rel="noreferrer">' +
          title +
          '</a>'
        : '<span class="work-title-missing" title="浏览器补采成功后可直达这条作品">' +
          title +
          '</span>';
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
        formatWorkTime(work.publishedAt) +
        '</span></div><h3>' +
        titleMarkup +
        '</h3><div class="work-bottomline"><span class="work-source">' +
        escapeHtml(extractionLabel) +
        (work.likes ? ' · ' + escapeHtml(work.likes) + ' 赞' : '') +
        '</span><span class="work-actions">' +
        linkFallbackNotice +
        '<a href="' +
        escapeHtml(target.fallbackUrl) +
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

const MONITOR_INSIGHT_METRICS = [
  { key: 'play_count', label: '播放', empty: '暂无播放数据' },
  { key: 'read_count', label: '阅读', empty: '暂无阅读数据' },
  { key: 'exposure_count', label: '曝光', empty: '暂无曝光数据' },
  { key: 'like_count', label: '点赞', empty: '暂无点赞数据' },
  { key: 'favorite_count', label: '收藏', empty: '暂无收藏数据' },
  { key: 'comment_count', label: '评论', empty: '暂无评论数据' },
  { key: 'share_count', label: '分享', empty: '暂无分享数据' },
  { key: 'follower_count', label: '粉丝', empty: '暂无粉丝数据' },
];

const MONITOR_PLATFORM_METRICS = [
  { key: 'play_count', label: '播放' },
  { key: 'read_count', label: '阅读' },
  { key: 'exposure_count', label: '曝光' },
  { key: 'like_count', label: '点赞' },
  { key: 'favorite_count', label: '收藏' },
  { key: 'comment_count', label: '评论' },
  { key: 'share_count', label: '分享' },
];

function formatMetricValue(value, fallback = '—') {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  if (number >= 100000000) {
    return (number / 100000000).toFixed(number >= 1000000000 ? 0 : 1).replace(/\.0$/, '') + '亿';
  }
  if (number >= 10000) {
    return (number / 10000).toFixed(number >= 100000 ? 0 : 1).replace(/\.0$/, '') + '万';
  }
  return Math.round(number).toLocaleString('zh-CN');
}

function insightMetric(insights, key) {
  return insights?.summary?.metrics?.[key] || { value: null, available: false, sampleCount: 0, label: key };
}

function insightMetricMarkup(insights, key, label, emptyText) {
  const metric = insightMetric(insights, key);
  const value = metric.available ? formatMetricValue(metric.value) : '—';
  const hint = metric.available
    ? metric.sampleCount + ' 条已保存快照'
    : emptyText;
  return '<article class="monitor-kpi-card' + (metric.available ? ' is-available' : ' is-unavailable') + '"><span>' +
    escapeHtml(label) +
    '</span><strong>' +
    escapeHtml(value) +
    '</strong><small>' +
    escapeHtml(hint) +
    '</small></article>';
}

function renderMonitoringInsightKpis(insights) {
  if (!elements.monitorInsightsKpis) return;
  const summary = insights?.summary || {};
  const cards = [
    '<article class="monitor-kpi-card is-available"><span>纳入监控账号</span><strong>' +
      escapeHtml(summary.accountCount ?? 0) +
      '</strong><small>' +
      escapeHtml((summary.activeAccountCount ?? 0) + ' 个已连接') +
      '</small></article>',
    '<article class="monitor-kpi-card is-available"><span>' +
      escapeHtml(insights?.period?.label || '本周期') +
      '发布</span><strong>' +
      escapeHtml(summary.publishedCount ?? 0) +
      '</strong><small>按作品发布时间统计</small></article>',
    ...MONITOR_INSIGHT_METRICS.map((metric) => insightMetricMarkup(insights, metric.key, metric.label, metric.empty)),
  ];
  elements.monitorInsightsKpis.innerHTML = cards.join('');
}

function renderMonitoringOperations(insights) {
  if (!elements.monitorOperations) return;
  const operations = insights?.operations || {};
  const refreshSummary = operations.lastRefreshSummary || {};
  const refreshDetail = operations.refreshStatus === 'refreshing'
    ? '正在读取平台快照'
    : operations.refreshError
      ? operations.refreshError
      : operations.lastRefreshAt
        ? '最近刷新 ' + formatTime(operations.lastRefreshAt) + (refreshSummary.failed ? ' · ' + refreshSummary.failed + ' 个失败' : '')
        : '等待首次刷新';
  const accountDetail = operations.attentionAccountCount
    ? operations.attentionAccountCount + ' 个账号需要处理'
    : operations.activeAccountCount + ' 个账号连接正常';
  const cards = [
    { label: insights?.period?.label + '发布', value: operations.publishedPeriodCount ?? insights?.summary?.publishedCount ?? 0, detail: '按作品发布时间统计' },
    { label: '本周发布', value: operations.publishedThisWeekCount ?? 0, detail: '周一至今新增作品' },
    { label: '今日发布', value: operations.publishedTodayCount ?? 0, detail: '今天已采集到的作品' },
    { label: '账号连接', value: (operations.activeAccountCount ?? 0) + '/' + (operations.accountCount ?? 0), detail: accountDetail },
    { label: '最近刷新', value: operations.lastRefreshAt ? formatTime(operations.lastRefreshAt) : '待刷新', detail: refreshDetail },
  ];
  elements.monitorOperations.innerHTML = cards.map((card) =>
    '<article class="monitor-operation-card"><span>' + escapeHtml(card.label || '运营状态') + '</span><strong>' +
    escapeHtml(String(card.value)) + '</strong><small>' + escapeHtml(card.detail) + '</small></article>',
  ).join('');
}

function insightStatusLabel(status) {
  return status === 'available' ? '已接入' : status === 'attention' ? '需处理' : '待采集';
}

function renderMonitoringPlatformSummary(insights) {
  if (!elements.monitorPlatformSummary) return;
  const rows = Array.isArray(insights?.platforms) ? insights.platforms : [];
  if (!rows.length) {
    elements.monitorPlatformSummary.innerHTML = '<div class="monitor-insights-empty"><strong>还没有平台数据</strong><span>加入监控账号并完成一次刷新后，这里会按平台拆分。</span></div>';
    if (elements.monitorPlatformSummaryNote) elements.monitorPlatformSummaryNote.textContent = '等待账号';
    return;
  }
  elements.monitorPlatformSummary.innerHTML = rows.map((row) => {
    const metrics = MONITOR_PLATFORM_METRICS.map((metric) => {
      const value = row.metrics?.[metric.key];
      const available = Boolean(value?.available);
      return '<div class="monitor-platform-metric' + (available ? ' is-available' : ' is-unavailable') + '"><span>' +
        escapeHtml(metric.label) + '</span><strong>' + escapeHtml(available ? formatMetricValue(value.value) : '—') +
        '</strong></div>';
    }).join('');
    const periodLabel = insights?.period?.label || '本周期';
    const latest = row.lastObservedAt ? '指标更新于 ' + formatTime(row.lastObservedAt) : '尚未获得表现快照';
    return '<article class="monitor-platform-card"><div class="monitor-platform-card-heading"><div class="monitor-platform-name"><strong>' +
      escapeHtml(row.platformLabel) + '</strong><small>' + escapeHtml(row.accountCount + ' 个账号 · ' + row.activeAccountCount + ' 个已连接') +
      '</small></div><span class="monitor-platform-status status-' + escapeHtml(row.status) + '">' +
      escapeHtml(insightStatusLabel(row.status)) + '<small>' + escapeHtml(row.coverage.observedMetricCount + '/' + row.coverage.expectedMetricCount + ' 项表现') +
      '</small></span></div><div class="monitor-platform-published"><span>' + escapeHtml(periodLabel + '发布') + '</span><strong>' +
      escapeHtml(String(row.publishedCount)) + '</strong><small> · 本周 ' + escapeHtml(String(row.publishedThisWeekCount ?? 0)) + ' · 今日 ' +
      escapeHtml(String(row.publishedTodayCount ?? 0)) + '</small></div><div class="monitor-platform-metrics">' + metrics +
      '</div><div class="monitor-platform-card-footer"><span>' + escapeHtml(latest) + '</span><small>各指标均为该平台内容最新快照总和</small></div></article>';
  }).join('');
  if (elements.monitorPlatformSummaryNote) {
    elements.monitorPlatformSummaryNote.textContent = rows.length + ' 个平台 · 原生口径';
  }
}

function renderMonitoringTrend(insights) {
  if (!elements.monitorTrend) return;
  const trend = Array.isArray(insights?.trend) ? insights.trend : [];
  if (!trend.length || !trend.some((item) => item.publishedCount > 0)) {
    elements.monitorTrend.innerHTML = '<div class="monitor-insights-empty"><strong>暂时没有发布趋势</strong><span>作品完成采集并带有发布时间后，会按天显示发布节奏。</span></div>';
    return;
  }
  const max = Math.max(...trend.map((item) => Number(item.publishedCount) || 0), 1);
  elements.monitorTrend.innerHTML = '<div class="monitor-trend-bars">' + trend.map((item) => {
    const count = Number(item.publishedCount) || 0;
    const height = Math.max(6, Math.round((count / max) * 100));
    return '<div class="monitor-trend-day" title="' + escapeHtml(item.date + ' 发布 ' + count + ' 条') + '"><div class="monitor-trend-bar-wrap"><i style="height:' + height + '%"></i></div><strong>' + escapeHtml(count) + '</strong><small>' + escapeHtml(item.label) + '</small></div>';
  }).join('') + '</div><div class="monitor-trend-legend"><span><i></i>每日发布作品数</span><small>指标表现按平台原生口径展示，不跨平台强行相加</small></div>';
}

function renderMonitoringTopWorks(insights) {
  if (!elements.monitorTopWorks) return;
  const works = Array.isArray(insights?.topWorks) ? insights.topWorks : [];
  if (!works.length) {
    elements.monitorTopWorks.innerHTML = '<div class="monitor-insights-empty"><strong>还没有本周期作品</strong><span>刷新监控账号后，作品会按发布时间进入这里。</span></div>';
    return;
  }
  elements.monitorTopWorks.innerHTML = works.map((work, index) => {
    const metric = work.primaryMetric?.value !== null && work.primaryMetric?.value !== undefined
      ? formatMetricValue(work.primaryMetric.value) + ' ' + work.primaryMetric.label
      : '表现指标未接入';
    const title = work.link
      ? '<a href="' + escapeHtml(work.link) + '" target="_blank" rel="noreferrer">' + escapeHtml(work.title) + '</a>'
      : '<span>' + escapeHtml(work.title) + '</span>';
    return '<div class="monitor-top-work"><b>' + escapeHtml(String(index + 1).padStart(2, '0')) + '</b><div><strong>' + title + '</strong><small>' + escapeHtml(work.platformLabel + ' · ' + formatWorkTime(work.publishedAt)) + '</small></div><span>' + escapeHtml(metric) + '</span></div>';
  }).join('');
}

function renderMonitoringComments(insights) {
  if (!elements.monitorComments) return;
  const comments = insights?.comments;
  if (!comments?.items?.length) {
    const isEmpty = comments?.status === 'empty';
    elements.monitorComments.innerHTML = '<div class="monitor-insights-empty"><strong>' +
      (isEmpty ? '本周期暂无最新评论' : '评论快照尚未接入') +
      '</strong><span>' + (isEmpty
        ? '已完成评论读取，但当前统计周期没有可展示的新评论。'
        : '完成平台授权或会话采集后，评论会出现在这里；缺失评论不会被伪装成 0。') +
      '</span></div>';
    if (elements.monitorCommentsCount) elements.monitorCommentsCount.textContent = isEmpty ? '0 条 · 已读取' : '只读 · 待接入';
    return;
  }
  elements.monitorComments.innerHTML = comments.items.map((comment) => {
    const work = state.works.find((item) => item.id === comment.workId);
    return '<article class="monitor-comment-item"><div class="monitor-comment-top"><strong>' + escapeHtml(comment.authorName || '匿名用户') + '</strong><time>' + escapeHtml(formatTime(comment.createdAt || comment.fetchedAt)) + '</time></div><p>' + escapeHtml(comment.text) + '</p><small>' + escapeHtml((work?.title || '未关联作品') + ' · ' + (comment.likeCount ?? 0) + ' 赞 · ' + (comment.replyCount ?? 0) + ' 回复') + '</small></article>';
  }).join('');
  if (elements.monitorCommentsCount) elements.monitorCommentsCount.textContent = comments.count + ' 条 · 只读';
}

function renderMonitoringInsights() {
  if (!elements.monitorInsights) return;
  if (elements.monitorPeriod && elements.monitorPeriod.value !== monitorPeriod) {
    elements.monitorPeriod.value = monitorPeriod;
  }
  const insights = state.insights;
  if (!insights) {
    if (elements.monitorInsightsNotice) elements.monitorInsightsNotice.textContent = '数据看板正在读取…';
    return;
  }
  renderMonitoringInsightKpis(insights);
  renderMonitoringOperations(insights);
  renderMonitoringPlatformSummary(insights);
  renderMonitoringTrend(insights);
  renderMonitoringTopWorks(insights);
  renderMonitoringComments(insights);
  const quality = insights.dataQuality || {};
  if (elements.monitorInsightsNotice) {
    const freshness = quality.latestObservedAt ? '最近指标 ' + formatTime(quality.latestObservedAt) : '尚无指标快照';
    const refreshState = insights.operations?.refreshStatus === 'attention'
      ? '刷新有失败账号'
      : insights.operations?.refreshStatus === 'refreshing'
        ? '正在刷新'
        : insights.operations?.refreshStatus === 'ready'
          ? '刷新正常'
          : '尚未刷新';
    elements.monitorInsightsNotice.className = 'monitor-insights-notice' + (quality.snapshotCount ? '' : ' is-muted');
    elements.monitorInsightsNotice.innerHTML = '<span class="monitor-insights-notice-mark">i</span><span>' + escapeHtml((quality.note || '') + ' ' + freshness + ' · ' + refreshState) + '</span>';
  }
  if (elements.monitorInsightsUpdated) {
    elements.monitorInsightsUpdated.textContent = quality.latestObservedAt
      ? '指标截至 ' + formatTime(quality.latestObservedAt)
      : insights.operations?.lastRefreshAt
        ? '最近刷新 ' + formatTime(insights.operations.lastRefreshAt)
        : '当前仅有台账数据';
  }
}

function renderOverview() {
  if (!elements.overviewHighlights) {
    return;
  }
  const attentionCount = state.accounts.filter((account) => account.state === 'error').length;
  const xhsCount = state.stats.platformCounts?.xhs || 0;
  const douyinCount = state.stats.platformCounts?.douyin || 0;
  const channelsCount = state.stats.platformCounts?.channels || 0;
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
        : '小红书 ' + xhsCount + ' · 抖音 ' + douyinCount + ' · 视频号 ' + channelsCount,
    },
    {
      icon: '↗',
      label: '下一步工作台动作',
      value: '先监控，再沉淀',
      tone: 'ink',
      detail: '进入内容编辑，把素材整理成可审核任务',
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

function renderGroupFilter() {
  if (!elements.groupFilter) {
    return;
  }
  const groups = accountGroups();
  if (groupFilter !== 'all' && !groups.includes(groupFilter)) {
    groupFilter = 'all';
  }
  elements.groupFilter.innerHTML = ['全部分组', ...groups]
    .map((group, index) => {
      const value = index === 0 ? 'all' : group;
      return '<option value="' + escapeHtml(value) + '">' + escapeHtml(group) + '</option>';
    })
    .join('');
  elements.groupFilter.value = groupFilter;
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
    const matchesGroup = groupFilter === 'all' || accountGroup(account) === groupFilter;
    return matchesState && matchesPlatform && matchesWorkTab && matchesGroup;
  });
  if (elements.monitorAccountCount) {
    elements.monitorAccountCount.textContent = visibleAccounts.length + ' 个';
  }
  const groups = accountGroups();

  const rows = visibleAccounts.map((account) => {
    const platform = platformFor(account.platform);
    const profileUrl = account.canonicalUrl || account.sourceUrl || '#';
    const accountWorks = state.works.filter((work) => work.accountId === account.id);
    const workCount = accountWorks.length;
    const unreadCount = accountWorks.filter((work) => !work.seen).length;
    const needsBrowserRefresh =
      account.platform === 'douyin' ||
      account.platform === 'channels' ||
      !isHttpUrl(account.avatarUrl) ||
      accountWorks.some((work) => !exactWorkUrl(work, account.platform));
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
    const groupOptions = groups
      .map(
        (group) =>
          '<option value="' +
          escapeHtml(group) +
          '"' +
          (group === accountGroup(account) ? ' selected' : '') +
          '>' +
          escapeHtml(group) +
          '</option>',
      )
      .join('');
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
      '</span><select class="monitor-account-group-select" data-account-group-id="' +
      escapeHtml(account.id) +
      '" aria-label="设置 ' +
      escapeHtml(account.name) +
      ' 的账号分组">' +
      groupOptions +
      '</select></small></div></div><div class="monitor-account-side"><div class="monitor-account-count"><b>' +
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
      '" target="_blank" rel="noreferrer">打开主页 ↗</a>' +
      (needsBrowserRefresh
        ? '<button class="monitor-browser-refresh" type="button" data-browser-refresh-account="' +
          escapeHtml(account.id) +
          '" aria-label="浏览器补采 ' +
          escapeHtml(account.name) +
          '">补采</button>'
        : '') +
      '<button class="monitor-delete-account" type="button" data-delete-account="' +
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

function platformSessionStatusMeta(platformSession) {
  if (platformSession?.windowOpen) {
    return { label: '窗口已打开', tone: 'is-working' };
  }
  if (platformSession?.status === 'cleared') {
    return { label: '已清除', tone: 'is-warning' };
  }
  return { label: '可复用', tone: 'is-ready' };
}

function renderPlatformSessions() {
  if (!elements.platformSessionList) {
    return;
  }
  const sessions = state.platformSessions;
  if (!sessions) {
    elements.platformSessionList.innerHTML =
      '<div class="settings-state is-neutral">正在读取桌面会话状态…</div>';
    return;
  }
  if (!sessions.available) {
    elements.platformSessionList.innerHTML =
      '<div class="settings-state is-neutral">网页模式不会保存本机平台登录态，请使用桌面客户端。</div>';
    if (elements.platformSessionNote) {
      elements.platformSessionNote.textContent = sessions.note || '平台登录态仅保存在桌面客户端。';
    }
    return;
  }

  const isAdmin = state.viewer?.role === 'admin';
  const platforms = Array.isArray(sessions.platforms) ? sessions.platforms : [];
  if (!platforms.length) {
    elements.platformSessionList.innerHTML =
      '<div class="settings-state is-warning">桌面端会话管理暂未返回平台配置。</div>';
    return;
  }

  elements.platformSessionList.innerHTML = platforms
    .map((platformSession) => {
      const platform = platformFor(platformSession.platform);
      const status = platformSessionStatusMeta(platformSession);
      const detail = platformSession.lastClearedAt && !platformSession.lastUsedAt
        ? '登录态已清除，需要重新登录'
        : platformSession.lastUsedAt
          ? '最近使用 ' + formatTime(platformSession.lastUsedAt)
          : '本次运行尚未打开';
      const actions = isAdmin
        ? '<div class="settings-platform-actions"><button class="text-action" type="button" data-platform-session-open="' +
          escapeHtml(platformSession.platform) +
          '">打开会话</button><button class="text-action is-danger" type="button" data-platform-session-clear="' +
          escapeHtml(platformSession.platform) +
          '">清除</button></div>'
        : '<small class="settings-platform-admin-only">管理员可管理</small>';
      return (
        '<article class="settings-platform-row"><span class="platform-logo ' +
        platform.className +
        '">' +
        escapeHtml(platform.symbol) +
        '</span><div><strong>' +
        escapeHtml(platformSession.label || platform.label) +
        '</strong><small>' +
        escapeHtml((platformSession.persistent ? '持久化配置 · 重启后复用' : '临时配置') + ' · ' + detail) +
        '</small></div><span class="settings-platform-status ' +
        status.tone +
        '">' +
        escapeHtml(status.label) +
        '</span>' +
        actions +
        '</article>'
      );
    })
    .join('');
  if (elements.platformSessionNote) {
    elements.platformSessionNote.textContent =
      sessions.note || '登录是否仍有效，以平台页面实际提示为准。';
  }
}

function renderSettings() {
  if (elements.settingsConnection) {
    elements.settingsConnection.textContent = authRequired
      ? state.viewer
        ? '已连接中央服务，账号和作品由服务端统一保存。'
        : '需要登录后才能读取中央服务。'
      : '当前使用本地服务，数据保存在本机 data/ 目录。';
  }
  renderPlatformSessions();
  if (elements.settingsAutoRefresh) {
    elements.settingsAutoRefresh.value = elements.autoRefresh.value;
  }
  setSettingsPanel(currentSettingsPanel);
}

function setSettingsPanel(panelName = 'general') {
  const hasPanel = elements.settingsCards.some(
    (card) => card.dataset.settingsCard === panelName,
  );
  const nextPanel = hasPanel ? panelName : 'general';
  currentSettingsPanel = nextPanel;
  elements.settingsNavItems.forEach((item) => {
    const active = item.dataset.settingsTarget === nextPanel;
    item.classList.toggle('is-active', active);
    item.setAttribute('aria-selected', String(active));
  });
  elements.settingsCards.forEach((card) => {
    const active = card.dataset.settingsCard === nextPanel;
    card.classList.toggle('is-active', active);
    card.hidden = !active;
  });
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
  if (nextView === 'content') {
    currentRole = options.role || '内容编辑云员工';
  } else if (nextView === 'planned') {
    currentRole = options.role || (currentRole === '内容编辑云员工' ? '账号运营' : currentRole);
  }
  const viewChanged = currentView !== nextView;
  currentView = nextView;
  const meta = VIEW_META[nextView];
  const plannedMeta = PLANNED_ROLE_META[currentRole] || PLANNED_ROLE_META['账号运营'];
  elements.currentViewEyebrow.textContent = nextView === 'planned' ? '云员工 / 规划中' : meta.eyebrow;
  elements.currentViewTitle.textContent = nextView === 'planned' ? currentRole + '云员工' : meta.title;
  elements.currentViewDescription.textContent = nextView === 'planned' ? plannedMeta.description : meta.description;
  if (nextView === 'planned') {
    elements.plannedRoleTitle.textContent = currentRole + '云员工正在规划';
    elements.plannedRoleDescription.textContent = plannedMeta.description;
    elements.plannedRoleIcon.textContent = plannedMeta.icon;
  }
  elements.viewPanels.forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.viewPanel === nextView);
  });
  elements.navItems.forEach((item) => {
    const isRoleMatch = !item.dataset.role || item.dataset.role === currentRole;
    item.classList.toggle('is-active', item.dataset.view === nextView && isRoleMatch);
  });
  if (options.updateHash !== false && window.location.hash !== '#' + nextView) {
    window.history.replaceState(null, '', '#' + nextView);
  }
  if (viewChanged && options.scroll !== false) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  if (nextView === 'monitor') {
    window.requestAnimationFrame(() => {
      const savedWidth = Number(
        window.localStorage.getItem(MONITOR_SPLIT_STORAGE_KEY),
      );
      applyMonitorSplitWidth(Number.isFinite(savedWidth) ? savedWidth : 410);
    });
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
      account_group_updated: '调整分组',
      browser_refresh: '浏览器补采',
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
  elements.refreshButton.querySelector('.button-icon')?.replaceChildren(
    document.createTextNode(inProgress ? '…' : '↻'),
  );
  if (elements.refreshLabel) {
    elements.refreshLabel.textContent = inProgress ? '刷新中…' : '刷新全部';
  }

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

function renderUpdaterState(message, tone = '') {
  if (!elements.settingsUpdateState) {
    return;
  }
  elements.settingsUpdateState.textContent = message;
  elements.settingsUpdateState.className = 'settings-state' + (tone ? ' ' + tone : '');
}

function renderUpdater(payload = {}) {
  if (!window.desktopUpdater) {
    clearUpdaterCheckTimer();
    elements.updateButton?.classList.add('is-hidden');
    if (elements.settingsUpdateButton) {
      elements.settingsUpdateButton.disabled = false;
      elements.settingsUpdateButton.textContent = '下载桌面客户端';
    }
    if (elements.settingsUpdateNote) {
      elements.settingsUpdateNote.textContent =
        '当前是网页模式；点击后打开 GitHub Releases，桌面客户端支持检查、下载并重启安装。';
    }
    renderUpdaterState('网页模式：可下载桌面客户端，当前不会自动更新代码。', 'is-neutral');
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
    renderUpdaterState('正在检查 GitHub Release…', 'is-working');
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
    renderUpdaterState('发现新版本' + (updaterVersion ? ' v' + updaterVersion : '') + '，确认后下载。', 'is-ready');
    return;
  }
  if (status === 'downloading') {
    clearUpdaterCheckTimer();
    updaterPhase = 'downloading';
    updateUpdaterControls('下载中 ' + percent + '%', true);
    renderUpdaterState('正在下载更新 ' + percent + '%…', 'is-working');
    return;
  }
  if (status === 'downloaded') {
    clearUpdaterCheckTimer();
    updaterPhase = 'downloaded';
    updateUpdaterControls('重启安装更新', false);
    renderUpdaterState('更新已下载，确认后重启安装。', 'is-ready');
    return;
  }
  if (status === 'not-available') {
    clearUpdaterCheckTimer();
    updaterPhase = 'idle';
    updateUpdaterControls('再次检查更新', false);
    renderUpdaterState('当前已是最新版本。', 'is-ready');
    return;
  }
  if (status === 'dev') {
    clearUpdaterCheckTimer();
    updaterPhase = 'idle';
    updateUpdaterControls('开发模式', false);
    renderUpdaterState('开发模式：打包后才会检查 GitHub Release。', 'is-neutral');
    return;
  }
  if (status === 'error') {
    clearUpdaterCheckTimer();
    updaterPhase = 'idle';
    updateUpdaterControls('更新失败，重试', false);
    renderUpdaterState('更新检查失败：' + (payload.message || '请稍后重试。'), 'is-warning');
    if (payload.message) {
      showToast('更新检查失败：' + payload.message, 'warning');
    }
    return;
  }

  updateUpdaterControls('检查更新', false);
  renderUpdaterState('尚未检查更新。', 'is-neutral');
}

async function downloadAndPromptInstall() {
  renderUpdater({ status: 'downloading', percent: 0 });
  const result = await window.desktopUpdater.downloadUpdate();
  if (result?.status) {
    renderUpdater(result);
  }
  if (result?.status !== 'downloaded' && updaterPhase !== 'downloaded') {
    return;
  }
  const confirmed = window.confirm(
    '新版本已经下载完成，是否立即重启并安装？\n\n安装时会关闭当前客户端，本地监控数据会保留。',
  );
  if (confirmed) {
    await window.desktopUpdater.installUpdate();
  } else {
    showToast('更新已下载，可稍后点击“重启安装更新”', 'normal');
  }
}

async function handleUpdaterClick() {
  if (updaterPhase === 'checking' || updaterPhase === 'downloading') {
    return;
  }
  if (!window.desktopUpdater) {
    window.open(
      'https://github.com/lifehacker520/cloud-worker-media-workbench/releases/latest',
      '_blank',
      'noopener,noreferrer',
    );
    showToast('已打开 GitHub Releases，请下载最新桌面客户端', 'normal');
    return;
  }

  try {
    if (updaterPhase === 'available') {
      const confirmed = window.confirm(
        '发现新版本 ' +
          (updaterVersion ? 'v' + updaterVersion : '') +
          '，是否立即下载？',
      );
      if (confirmed) {
        await downloadAndPromptInstall();
      }
      return;
    }
    if (updaterPhase === 'downloaded') {
      const confirmed = window.confirm(
        '更新已经下载完成，是否立即重启并安装？\n\n安装时会关闭当前客户端，本地监控数据会保留。',
      );
      if (confirmed) {
        await window.desktopUpdater.installUpdate();
      }
      return;
    }

    renderUpdater({ status: 'checking' });
    const result = await window.desktopUpdater.checkForUpdates();
    if (result?.status && result.status !== 'checking') {
      renderUpdater(result);
    }
    if (result?.status === 'available') {
      const confirmed = window.confirm(
        '发现新版本 ' +
          (result.version ? 'v' + result.version : '') +
          '，是否立即下载？',
      );
      if (confirmed) {
        await downloadAndPromptInstall();
      }
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
  renderGroupFilter();
  renderWorks();
  renderMonitoringInsights();
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
    await loadMonitoringInsights({ silent: true });
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

async function loadPlatformSessions(options = {}) {
  if (!isAuthenticated || !elements.platformSessionList) {
    return;
  }
  const requestId = ++platformSessionRequestId;
  if (!options.silent) {
    elements.platformSessionList.innerHTML =
      '<div class="settings-state is-working">正在读取桌面会话状态…</div>';
  }
  try {
    const payload = await apiRequest('/api/platform-sessions');
    if (requestId !== platformSessionRequestId) {
      return;
    }
    state.platformSessions = payload;
    renderPlatformSessions();
  } catch (error) {
    if (requestId !== platformSessionRequestId) {
      return;
    }
    elements.platformSessionList.innerHTML =
      '<div class="settings-state is-warning">' +
      escapeHtml(error.message || '桌面会话状态读取失败') +
      '</div>';
    if (!options.silent) {
      showToast(error.message || '桌面会话状态读取失败', 'warning');
    }
  }
}

async function loadMonitoringInsights(options = {}) {
  if (!isAuthenticated || !elements.monitorInsights) {
    return;
  }
  const requestId = ++insightsRequestId;
  const params = new URLSearchParams({
    period: monitorPeriod,
    platform: platformFilter,
    accountId: selectedAccountId || 'all',
  });
  isInsightsLoading = true;
  if (!options.silent && elements.monitorInsightsUpdated) {
    elements.monitorInsightsUpdated.textContent = '正在更新看板…';
  }
  try {
    const payload = await apiRequest('/api/monitoring/insights?' + params.toString());
    if (requestId !== insightsRequestId) return;
    state.insights = payload.insights || null;
    renderMonitoringInsights();
  } catch (error) {
    if (requestId !== insightsRequestId) return;
    if (elements.monitorInsightsNotice) {
      elements.monitorInsightsNotice.className = 'monitor-insights-notice is-error';
      elements.monitorInsightsNotice.textContent = error.message || '数据看板读取失败';
    }
  } finally {
    if (requestId === insightsRequestId) {
      isInsightsLoading = false;
    }
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
    await loadMonitoringInsights({ silent: true });
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
  const group = String(formData.get('group') || '').trim();
  const sourceUrl = String(formData.get('sourceUrl') || '').trim();
  elements.addMessage.textContent = '正在加入…';
  elements.addMessage.className = 'form-message is-working';

  try {
    await apiRequest('/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, group, sourceUrl }),
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

async function updateAccountGroup(accountId, group, select) {
  const account = accountFor(accountId);
  if (!account) {
    return;
  }
  const previousGroup = accountGroup(account);
  if (select) {
    select.disabled = true;
  }
  try {
    const payload = await apiRequest(
      '/api/accounts/' + encodeURIComponent(accountId),
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group }),
      },
    );
    const updated = payload.account;
    const index = state.accounts.findIndex((item) => item.id === accountId);
    if (updated && index >= 0) {
      state.accounts[index] = updated;
    } else {
      account.group = group;
    }
    render();
    showToast(
      '已将 ' + account.name + ' 调整到“' + accountGroup(updated || account) + '”',
      'success',
    );
  } catch (error) {
    if (select) {
      select.value = previousGroup;
      select.disabled = false;
    }
    showToast(error.message || '账号分组更新失败', 'error');
  }
}

async function browserRefreshAccount(accountId) {
  const account = accountFor(accountId);
  if (!account) {
    return;
  }
  const button = elements.accountHealth.querySelector(
    '[data-browser-refresh-account="' + CSS.escape(accountId) + '"]',
  );
  if (button) {
    button.disabled = true;
    button.textContent = '采集中…';
  }
  try {
    const payload = await apiRequest(
      '/api/accounts/' + encodeURIComponent(accountId) + '/browser-refresh',
      { method: 'POST' },
    );
    Object.assign(state, payload.state || {});
    render();
    showToast(
      '已补采 ' +
        account.name +
        '：读取 ' +
        (payload.result?.parsedCount || 0) +
        ' 条作品' +
        (payload.result?.removedStaleWorks
          ? '，清理 ' + payload.result.removedStaleWorks + ' 条异常链接'
          : ''),
      'success',
    );
    await loadAdminData();
    await loadPlatformSessions({ silent: true });
  } catch (error) {
    showToast(error.message || '浏览器补采失败，请检查弹出的平台窗口', 'warning');
    await loadState();
    await loadPlatformSessions({ silent: true });
  }
}

async function openPlatformSession(platform) {
  const button = elements.platformSessionList?.querySelector(
    '[data-platform-session-open="' + CSS.escape(platform) + '"]',
  );
  if (button) {
    button.disabled = true;
    button.textContent = '打开中…';
  }
  try {
    await apiRequest('/api/platform-sessions/' + encodeURIComponent(platform) + '/open', {
      method: 'POST',
    });
    await loadPlatformSessions({ silent: true });
    showToast('已打开 ' + platformLabel(platform) + ' 会话窗口', 'success');
  } catch (error) {
    showToast(error.message || '平台会话窗口打开失败', 'warning');
  } finally {
    renderPlatformSessions();
  }
}

async function clearPlatformSession(platform) {
  const label = platformLabel(platform);
  const confirmed = window.confirm(
    '确定清除“' +
      label +
      '”的桌面登录态吗？\n\n这会关闭该平台浏览器窗口并清除本机该平台的登录信息与站点数据，不会删除监控账号、作品或看板数据。清除后需要重新登录。',
  );
  if (!confirmed) {
    return;
  }
  const button = elements.platformSessionList?.querySelector(
    '[data-platform-session-clear="' + CSS.escape(platform) + '"]',
  );
  if (button) {
    button.disabled = true;
    button.textContent = '清除中…';
  }
  try {
    await apiRequest('/api/platform-sessions/' + encodeURIComponent(platform) + '/clear', {
      method: 'POST',
    });
    await loadPlatformSessions({ silent: true });
    showToast('已清除 ' + label + ' 登录态，请重新登录', 'success');
  } catch (error) {
    showToast(error.message || '平台登录态清除失败', 'error');
  } finally {
    renderPlatformSessions();
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
  loadMonitoringInsights({ silent: true });

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
  loadMonitoringInsights({ silent: true });
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
    window.dispatchEvent(new Event('workspace-auth-ready'));
    await loadState();
    await loadPlatformSessions({ silent: true });
    showToast('登录成功', 'success');
  } catch (error) {
    elements.addMessage.textContent = error.message || '账号加入失败';
    elements.addMessage.className = 'form-message is-error';
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
    window.dispatchEvent(new Event('workspace-auth-ready'));
    resetAutoRefresh();
    await loadState();
    await loadPlatformSessions({ silent: true });
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
  const availableMax = layoutWidth ? Math.max(320, layoutWidth - 420) : 640;
  const width = Math.round(
    Math.min(Math.max(Number(value) || 410, 320), Math.min(640, availableMax)),
  );
  elements.monitorLayout.style.setProperty('--monitor-accounts-width', width + 'px');
  elements.monitorSplitter?.setAttribute('aria-valuenow', String(width));
  window.localStorage.setItem(MONITOR_SPLIT_STORAGE_KEY, String(width));
}

function initMonitorSplitter() {
  const splitter = elements.monitorSplitter;
  if (!splitter || !elements.monitorLayout) {
    return;
  }

  const savedWidth = Number(
    window.localStorage.getItem(MONITOR_SPLIT_STORAGE_KEY),
  );
  applyMonitorSplitWidth(Number.isFinite(savedWidth) ? savedWidth : 410);

  let dragging = false;
  let pointerId = null;
  let startX = 0;
  let startWidth = 410;

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
      ) || 410;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      applyMonitorSplitWidth(current + (event.key === 'ArrowRight' ? 20 : -20));
      event.preventDefault();
    }
    if (event.key === 'Home' || event.key === 'End') {
      applyMonitorSplitWidth(event.key === 'Home' ? 320 : 640);
      event.preventDefault();
    }
  });
}

function init() {
  const savedFrequency = window.localStorage.getItem('xhs-monitor-auto-refresh');
  applyAutoRefreshFrequency(savedFrequency || '0');
  initMonitorSplitter();
  window.addEventListener('resize', () => {
    if (currentView !== 'monitor') {
      return;
    }
    const currentWidth =
      Number.parseFloat(
        getComputedStyle(elements.monitorLayout).getPropertyValue(
          '--monitor-accounts-width',
        ),
      ) || 410;
    applyMonitorSplitWidth(currentWidth);
  });

  elements.navItems.forEach((item) => {
    item.addEventListener('click', () =>
      setView(item.dataset.view, { role: item.dataset.role }),
    );
  });
  document.querySelectorAll('[data-view]:not(.nav-item)').forEach((item) => {
    item.addEventListener('click', (event) => {
      event.preventDefault();
      setView(item.dataset.view, { role: item.dataset.role });
    });
  });
  elements.toolsNavToggle?.addEventListener('click', () => {
    const expanded = elements.toolsNavToggle.getAttribute('aria-expanded') === 'true';
    elements.toolsNavToggle.setAttribute('aria-expanded', String(!expanded));
    if (elements.toolsNavSubmenu) {
      elements.toolsNavSubmenu.hidden = expanded;
    }
  });
  window.addEventListener('hashchange', () => {
    const [view] = window.location.hash.slice(1).split('/');
    setView(view, { updateHash: false });
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
    loadMonitoringInsights({ silent: true });
  });
  elements.groupFilter?.addEventListener('change', (event) => {
    groupFilter = event.target.value;
    selectedAccountId = null;
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
    loadMonitoringInsights({ silent: true });
  });
  elements.monitorPeriod?.addEventListener('change', (event) => {
    monitorPeriod = event.target.value || 'month';
    loadMonitoringInsights();
  });
  elements.autoRefresh.addEventListener('change', resetAutoRefresh);
  elements.settingsAutoRefresh?.addEventListener('change', resetAutoRefresh);
  elements.settingsNavItems.forEach((item) => {
    item.addEventListener('click', () => {
      setSettingsPanel(item.dataset.settingsTarget);
      if (item.dataset.settingsTarget === 'connection') {
        loadPlatformSessions({ silent: true });
      }
    });
  });
  elements.refreshPlatformSessions?.addEventListener('click', () => {
    loadPlatformSessions();
  });
  elements.platformSessionList?.addEventListener('click', (event) => {
    const openButton = event.target.closest('[data-platform-session-open]');
    if (openButton) {
      openPlatformSession(openButton.dataset.platformSessionOpen);
      return;
    }
    const clearButton = event.target.closest('[data-platform-session-clear]');
    if (clearButton) {
      clearPlatformSession(clearButton.dataset.platformSessionClear);
    }
  });
  elements.accounts.addEventListener('click', (event) => {
    if (event.target.closest('[data-account-group-id]')) {
      event.stopPropagation();
      return;
    }
    const deleteButton = event.target.closest('[data-delete-account]');
    if (deleteButton) {
      event.stopPropagation();
      deleteAccount(deleteButton.dataset.deleteAccount);
      return;
    }
    const browserRefreshButton = event.target.closest('[data-browser-refresh-account]');
    if (browserRefreshButton) {
      event.stopPropagation();
      browserRefreshAccount(browserRefreshButton.dataset.browserRefreshAccount);
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
    if (
      event.target.closest(
        '[data-delete-account], [data-browser-refresh-account], [data-account-group-id], a',
      )
    ) {
      return;
    }
    const row = event.target.closest('[data-monitor-account]');
    if (!row) {
      return;
    }
    event.preventDefault();
    selectMonitorAccount(row.dataset.monitorAccount);
  });
  elements.accounts.addEventListener('change', (event) => {
    const select = event.target.closest('[data-account-group-id]');
    if (!select) {
      return;
    }
    event.stopPropagation();
    updateAccountGroup(select.dataset.accountGroupId, select.value, select);
  });
  elements.monitorClearAccount?.addEventListener('click', clearSelectedMonitorAccount);
  elements.works.addEventListener('click', (event) => {
    const button = event.target.closest('[data-seen]');
    if (button) {
      markSeen(button.dataset.seen);
    }
  });

  const [initialView] = window.location.hash.slice(1).split('/');
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
