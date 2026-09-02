import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fingerprintForWork } from './src/xhs-parser.mjs';
import {
  adapterFor,
  normalizeSource,
  platformCatalog,
} from './src/platforms.mjs';
import {
  authConfig,
  authenticate,
  clearSessionCookie,
  currentUser,
  isAdmin,
  sessionCookie,
  configureUserDirectory,
} from './src/auth.mjs';
import {
  addContentReview,
  applyContentRevision,
  buildContentRunReplay,
  contentTaskSummary,
  CONTENT_NODE_CATALOG,
  CONTENT_WORKFLOW_VERSION,
  createContentTask,
  normalizeContentTask,
  pauseContentTask,
  recordContentNode,
  retryContentNode,
  resumeContentTask,
  startContentTask,
  updateContentTask,
} from './src/content-workflow.mjs';
import {
  aiProviderStatus,
  generateContentDraft,
} from './src/ai-provider.mjs';
import {
  buildMonitoringEvidence,
  buildMonitoringInsights,
} from './src/monitoring-insights.mjs';
import {
  analyzeContentStructure,
  packageFiles,
  parseMediaAsset,
  renderVideo,
  runtimeCapabilities,
} from './src/media-pipeline.mjs';
import { WorkbenchStore } from './src/workbench-store.mjs';

const PROJECT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(PROJECT_DIR, 'public');
const DATA_DIR = resolve(
  process.env.XHS_DATA_DIR || join(PROJECT_DIR, 'data'),
);
const CONFIG_DIR = resolve(PROJECT_DIR, 'config');
const ACCOUNTS_FILE = join(DATA_DIR, 'accounts.json');
const WORKS_FILE = join(DATA_DIR, 'works.json');
const ACTIVITY_FILE = join(DATA_DIR, 'activity.json');
const FEEDBACK_FILE = join(DATA_DIR, 'feedback.json');
const CONTENT_TASKS_FILE = join(DATA_DIR, 'content-tasks.json');
const PREVIEW_DIR = join(DATA_DIR, 'content-previews');
const RENDER_DIR = join(DATA_DIR, 'content-renders');
const PACKAGE_DIR = join(DATA_DIR, 'content-packages');
const SUBTITLE_DIR = join(DATA_DIR, 'content-subtitles');
const SEED_FILE = join(CONFIG_DIR, 'accounts.seed.json');
const DEMO_FILE = join(CONFIG_DIR, 'monitoring.demo.json');
const SERVER_HOST = process.env.XHS_MONITOR_HOST || '127.0.0.1';
const SERVER_PORT = Number(process.env.XHS_MONITOR_PORT || 3188);
const SERVER_REFRESH_MINUTES = Number(process.env.XHS_REFRESH_MINUTES || 0);
const DEMO_MODE = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.XHS_MONITOR_DEMO || '').trim().toLowerCase(),
);

const appState = {
  accounts: [],
  works: [],
  activity: [],
  feedback: [],
  metricSnapshots: [],
  comments: [],
  contentTasks: [],
  lastRefreshAt: null,
  lastRefreshSummary: null,
  refreshInProgress: false,
  refreshError: null,
};

let refreshPromise = null;
let workbenchStore = null;

function nowIso() {
  return new Date().toISOString();
}

function positionValue(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function accountIdFor(platform, sourceUrl, tenantId = 'tenant_local') {
  return (
    'acct_' +
    createHash('sha1')
      .update(String(tenantId || 'tenant_local') + '\u0000' + String(platform || 'unknown') + '\u0000' + sourceUrl)
      .digest('hex')
      .slice(0, 12)
  );
}

function normalizeAccountGroup(value) {
  const group = typeof value === 'string' ? value.trim() : '';
  return group ? group.slice(0, 60) : '未分组';
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function migrateWorks(savedWorks, accounts = []) {
  const unique = new Map();
  const accountTenants = new Map(accounts.map((account) => [account.id, account.tenantId || 'tenant_local']));
  for (const savedWork of savedWorks) {
    const fingerprint =
      savedWork.fingerprint ||
      fingerprintForWork({
        userId: savedWork.userId,
        title: savedWork.title,
        publishedAt: savedWork.publishedAt,
        noteId: savedWork.noteId,
        coverUrl: savedWork.coverUrl,
      });
    const migratedWork = {
      ...savedWork,
      id: 'work_' + fingerprint,
      tenantId: savedWork.tenantId || accountTenants.get(savedWork.accountId) || 'tenant_local',
      fingerprint,
      platform: savedWork.platform || 'xhs',
      contentId: savedWork.contentId || savedWork.noteId || null,
      isPinned: Boolean(savedWork.isPinned),
      position: positionValue(savedWork.position),
    };
    const existing = unique.get(fingerprint);
    if (!existing || (existing.seen && !migratedWork.seen)) {
      unique.set(fingerprint, migratedWork);
    }
  }
  return [...unique.values()];
}

function normalizeAccount(seed) {
  const normalized = normalizeSource(seed.sourceUrl || seed.canonicalUrl);
  const platform = seed.platform || normalized.platform;
  const adapter = adapterFor(platform);
  return {
    id: seed.id || accountIdFor(platform, normalized.sourceUrl, seed.tenantId),
    tenantId: seed.tenantId || 'tenant_local',
    name: seed.name?.trim() || '未命名账号',
    group: normalizeAccountGroup(seed.group),
    platform,
    platformLabel: adapter.label,
    sourceKind: normalized.kind,
    sourceUrl: normalized.sourceUrl,
    shortCode: normalized.shortCode,
    userId: seed.userId || normalized.userId || normalized.secUid || null,
    canonicalUrl: seed.canonicalUrl || normalized.canonicalUrl || null,
    nickname: seed.nickname || null,
    avatarUrl: seed.avatarUrl || null,
    state: seed.state || 'pending',
    lastCheckedAt: seed.lastCheckedAt || null,
    lastError: seed.lastError || null,
    workCount: Number(seed.workCount || 0),
    metricStatus: seed.metricStatus || 'not_connected',
    metricLastObservedAt: seed.metricLastObservedAt || null,
    commentStatus: seed.commentStatus || 'not_connected',
    commentLastFetchedAt: seed.commentLastFetchedAt || null,
    profileMetrics: seed.profileMetrics && typeof seed.profileMetrics === 'object'
      ? seed.profileMetrics
      : null,
    createdAt: seed.createdAt || nowIso(),
    createdBy: seed.createdBy || 'system',
  };
}

function evidenceGroupKey(item) {
  return [item.accountId, item.workId || 'account', item.metricKey].join('\u0000');
}

async function backfillLegacyMonitoringEvidence(accounts, works) {
  if (!workbenchStore) {
    return;
  }
  const existingGroups = new Set(appState.metricSnapshots.map(evidenceGroupKey));
  const nextSnapshots = [];
  for (const account of accounts) {
    const accountWorks = works.filter((work) => work.accountId === account.id);
    const observedAt = account.metricLastObservedAt || account.lastCheckedAt || account.createdAt ||
      accountWorks.map((work) => work.discoveredAt || work.publishedAt).filter(Boolean).sort().at(-1) || nowIso();
    const evidence = buildMonitoringEvidence({
      account,
      works: accountWorks,
      profileMetrics: account.profileMetrics,
      observedAt,
      source: 'legacy-work-fields',
    });
    for (const snapshot of evidence.snapshots) {
      const key = evidenceGroupKey(snapshot);
      if (!existingGroups.has(key)) {
        existingGroups.add(key);
        nextSnapshots.push(snapshot);
      }
    }
  }
  if (!nextSnapshots.length) {
    return;
  }
  workbenchStore.saveMonitoringMetricSnapshots(nextSnapshots);
  appState.metricSnapshots = workbenchStore.listMonitoringMetricSnapshots({ role: 'admin' });
}

async function loadDemoMonitoringEvidence(demoData, accounts, works) {
  if (!DEMO_MODE || !workbenchStore || !demoData) {
    return;
  }
  const demoComments = Array.isArray(demoData.comments) ? demoData.comments : [];
  const snapshots = [];
  const comments = [];
  for (const account of accounts) {
    const accountWorks = works.filter((work) => work.accountId === account.id);
    const evidence = buildMonitoringEvidence({
      account,
      works: accountWorks,
      profileMetrics: account.profileMetrics,
      observedAt: account.metricLastObservedAt || account.lastCheckedAt || nowIso(),
      source: 'demo-fixture',
      comments: demoComments.filter((comment) => comment.accountId === account.id),
    });
    snapshots.push(...evidence.snapshots);
    comments.push(...evidence.comments);
  }
  if (snapshots.length) {
    workbenchStore.saveMonitoringMetricSnapshots(snapshots);
  }
  if (comments.length) {
    workbenchStore.saveMonitoringComments(comments);
  }
  appState.metricSnapshots = workbenchStore.listMonitoringMetricSnapshots({ role: 'admin' });
  appState.comments = workbenchStore.listMonitoringComments({ role: 'admin' });
}

async function ensureData() {
  await mkdir(DATA_DIR, { recursive: true });
  workbenchStore = await WorkbenchStore.open(DATA_DIR);
  configureUserDirectory((username) => workbenchStore?.findAuthUser(username) || null);
  const migrationActor = {
    username: 'migration',
    role: 'admin',
    displayName: '数据迁移',
    tenantId: 'tenant_local',
  };
  const defaultProject = workbenchStore.ensureProject(migrationActor, {
    id: 'project_content_editor',
    slug: 'content-editor',
    name: '内容编辑云员工',
  });
  const savedAccounts = await readJson(ACCOUNTS_FILE, null);
  const demoData = DEMO_MODE ? await readJson(DEMO_FILE, null) : null;
  let legacyAccounts;
  if (Array.isArray(savedAccounts) && savedAccounts.length > 0) {
    legacyAccounts = savedAccounts.map((account) => normalizeAccount(account));
  } else {
    const seeds = await readJson(SEED_FILE, []);
    legacyAccounts = seeds.map(normalizeAccount);
  }

  const savedWorks = await readJson(WORKS_FILE, []);
  const legacyWorks = Array.isArray(savedWorks) ? migrateWorks(savedWorks, legacyAccounts) : [];
  const initialAccounts = Array.isArray(demoData?.accounts) && demoData.accounts.length
    ? demoData.accounts.map(normalizeAccount)
    : legacyAccounts;
  const initialWorks = Array.isArray(demoData?.works) && demoData.works.length
    ? migrateWorks(demoData.works, initialAccounts)
    : legacyWorks;

  const savedActivity = await readJson(ACTIVITY_FILE, []);
  const legacyActivity = Array.isArray(savedActivity)
    ? savedActivity.map((item) => ({ ...item, tenantId: item.tenantId || 'tenant_local' }))
    : [];
  const savedFeedback = await readJson(FEEDBACK_FILE, []);
  const legacyFeedback = Array.isArray(savedFeedback)
    ? savedFeedback.map((item) => ({ ...item, tenantId: item.tenantId || 'tenant_local' }))
    : [];
  if (workbenchStore.monitoringCounts().total === 0) {
    workbenchStore.replaceMonitoringData({
      accounts: initialAccounts,
      works: initialWorks,
      activity: legacyActivity,
      feedback: legacyFeedback,
    });
  }
  const monitoring = workbenchStore.listMonitoringData(migrationActor);
  appState.accounts = monitoring.accounts;
  appState.works = monitoring.works;
  appState.activity = monitoring.activity;
  appState.feedback = monitoring.feedback;
  appState.metricSnapshots = workbenchStore.listMonitoringMetricSnapshots(migrationActor);
  appState.comments = workbenchStore.listMonitoringComments(migrationActor);
  if (DEMO_MODE && demoData) {
    await loadDemoMonitoringEvidence(demoData, appState.accounts, appState.works);
  } else {
    await backfillLegacyMonitoringEvidence(appState.accounts, appState.works);
  }
  const savedContentTasks = await readJson(CONTENT_TASKS_FILE, []);
  if (Array.isArray(savedContentTasks)) {
    for (const rawTask of savedContentTasks) {
      const task = normalizeContentTask({
        ...rawTask,
        projectId: rawTask?.projectId || defaultProject.id,
        tenantId: rawTask?.tenantId || migrationActor.tenantId,
      });
      workbenchStore.migrateContentTask(task, migrationActor);
    }
  }
  workbenchStore.seedDefaultConnectors(migrationActor);
  appState.contentTasks = workbenchStore.listContentTasks(migrationActor);
  await persist();
}

function publicState(user = null) {
  const visibleAccounts = user && user.role !== 'admin'
    ? appState.accounts.filter((account) => account.tenantId === user.tenantId)
    : appState.accounts;
  const visibleAccountIds = new Set(visibleAccounts.map((account) => account.id));
  const works = appState.works.filter((work) => visibleAccountIds.has(work.accountId) || user?.role === 'admin').sort((left, right) => {
    const leftPublished = Date.parse(left.publishedAt || '');
    const rightPublished = Date.parse(right.publishedAt || '');
    if (Number.isFinite(leftPublished) && Number.isFinite(rightPublished) && leftPublished !== rightPublished) {
      return rightPublished - leftPublished;
    }
    if (left.accountId === right.accountId) {
      if (left.isPinned !== right.isPinned) {
        return left.isPinned ? 1 : -1;
      }
      if (Number.isFinite(left.position) && Number.isFinite(right.position) && left.position !== right.position) {
        return left.position - right.position;
      }
    }
    const leftTime = left.publishedAt || left.discoveredAt || '';
    const rightTime = right.publishedAt || right.discoveredAt || '';
    return rightTime.localeCompare(leftTime);
  });
  const activeAccounts = visibleAccounts.filter((account) => account.state === 'active').length;
  const unseenWorks = works.filter((work) => !work.seen).length;
  const platformCounts = visibleAccounts.reduce((counts, account) => {
    const platform = account.platform || 'other';
    counts[platform] = (counts[platform] || 0) + 1;
    return counts;
  }, {});

  const visibleContentTasks = user
    ? appState.contentTasks.filter(
        (task) =>
          user.role === 'admin' ||
          (task.tenantId === user.tenantId &&
            (!workbenchStore || workbenchStore.canAccessProject(user, task.projectId))),
      )
      : appState.contentTasks;

  const visibleSnapshots = appState.metricSnapshots.filter((snapshot) => visibleAccountIds.has(snapshot.accountId));
  const visibleComments = appState.comments.filter((comment) => visibleAccountIds.has(comment.accountId));

  return {
    accounts: visibleAccounts,
    works,
    platforms: platformCatalog(),
    stats: {
      accountCount: visibleAccounts.length,
      activeAccountCount: activeAccounts,
      workCount: works.length,
      unseenWorkCount: unseenWorks,
      platformCounts,
    },
    insights: buildMonitoringInsights({
      accounts: visibleAccounts,
      works,
      snapshots: visibleSnapshots,
      comments: visibleComments,
      period: 'month',
      now: new Date(),
      refreshState: {
        lastRefreshAt: appState.lastRefreshAt,
        lastRefreshSummary: appState.lastRefreshSummary,
        refreshInProgress: appState.refreshInProgress,
        refreshError: appState.refreshError,
      },
    }),
    meta: {
      lastRefreshAt: appState.lastRefreshAt,
      lastRefreshSummary: appState.lastRefreshSummary,
      refreshInProgress: appState.refreshInProgress,
      refreshError: appState.refreshError,
    },
    content: {
      taskCount: visibleContentTasks.length,
      waitingReviewCount: visibleContentTasks.filter(
        (task) => task.status === 'waiting_review',
      ).length,
    },
    viewer: user
      ? {
          username: user.username,
          role: user.role,
          displayName: user.displayName,
          tenantId: user.tenantId,
          permissions: user.permissions || [],
        }
      : null,
    auth: authConfig(),
  };
}

function safeError(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return '请求超时，可能触发平台限流';
  }
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s)]+/gi, '平台链接')
    .replace(/(?:xsec|ms|ttwid)_[^&\s]+/gi, '平台参数=已隐藏');
}

function monitoringInsightsForUser(user, options = {}) {
  const accounts = user?.role === 'admin'
    ? appState.accounts
    : appState.accounts.filter((account) => account.tenantId === user?.tenantId);
  const accountIds = new Set(accounts.map((account) => account.id));
  const works = appState.works.filter((work) => accountIds.has(work.accountId));
  const snapshots = appState.metricSnapshots.filter((snapshot) => accountIds.has(snapshot.accountId));
  const comments = appState.comments.filter((comment) => accountIds.has(comment.accountId));
  return buildMonitoringInsights({
    accounts,
    works,
    snapshots,
    comments,
    period: options.period || 'month',
    platform: options.platform || 'all',
    accountId: options.accountId || 'all',
    now: options.now || new Date(),
    refreshState: {
      lastRefreshAt: appState.lastRefreshAt,
      lastRefreshSummary: appState.lastRefreshSummary,
      refreshInProgress: appState.refreshInProgress,
      refreshError: appState.refreshError,
    },
  });
}

function publicBackup(backup) {
  if (!backup || typeof backup !== 'object') return backup;
  const { directory, manifestPath, ...safe } = backup;
  return safe;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function persist() {
  workbenchStore?.replaceMonitoringData({
    accounts: appState.accounts,
    works: appState.works,
    activity: appState.activity,
    feedback: appState.feedback,
  });
  await Promise.all([
    writeJson(ACCOUNTS_FILE, appState.accounts),
    writeJson(WORKS_FILE, appState.works),
    writeJson(ACTIVITY_FILE, appState.activity),
    writeJson(FEEDBACK_FILE, appState.feedback),
    writeJson(CONTENT_TASKS_FILE, appState.contentTasks),
  ]);
}

async function recordActivity(actor, type, detail) {
  appState.activity.unshift({
    id: 'activity_' + randomUUID(),
    createdAt: nowIso(),
    tenantId: actor?.tenantId || 'tenant_local',
    actor: actor?.username || 'system',
    actorName: actor?.displayName || '系统',
    type,
    detail,
  });
  appState.activity = appState.activity.slice(0, 500);
  workbenchStore?.replaceMonitoringData({
    accounts: appState.accounts,
    works: appState.works,
    activity: appState.activity,
    feedback: appState.feedback,
  });
  await writeJson(ACTIVITY_FILE, appState.activity);
}

function normalizedWorkTitle(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function sameWorkWithoutId(existing, parsedWork) {
  if (existing.contentId || existing.noteId) {
    return false;
  }
  if (normalizedWorkTitle(existing.title) !== normalizedWorkTitle(parsedWork.title)) {
    return false;
  }
  return (
    !existing.publishedAt ||
    !parsedWork.publishedAt ||
    existing.publishedAt === parsedWork.publishedAt
  );
}

function mergeParsedWork(existing, parsedWork, fingerprint, accountId, platform, userId, discoveredAt) {
  const contentId = parsedWork.contentId || parsedWork.noteId || existing.contentId || existing.noteId || null;
  existing.accountId = accountId;
  existing.tenantId = existing.tenantId || appState.accounts.find((account) => account.id === accountId)?.tenantId || 'tenant_local';
  existing.platform = platform;
  existing.userId = userId || existing.userId || null;
  existing.title = parsedWork.title || existing.title;
  existing.publishedAt = parsedWork.publishedAt || existing.publishedAt || null;
  existing.noteId = parsedWork.noteId || contentId;
  existing.contentId = contentId;
  existing.likes = parsedWork.likes || existing.likes || null;
  if (parsedWork.metrics && Object.keys(parsedWork.metrics).length) {
    existing.metrics = parsedWork.metrics;
  } else if (!existing.metrics) {
    existing.metrics = null;
  }
  existing.coverUrl = parsedWork.coverUrl || existing.coverUrl || null;
  if (Object.prototype.hasOwnProperty.call(parsedWork, 'isPinned')) {
    existing.isPinned = Boolean(parsedWork.isPinned);
  }
  if (Object.prototype.hasOwnProperty.call(parsedWork, 'position')) {
      existing.position = positionValue(parsedWork.position);
  }
  if (parsedWork.link && (contentId || !existing.link)) {
    existing.link = parsedWork.link;
  }
  existing.fingerprint = fingerprint;
  existing.id = 'work_' + fingerprint;
  existing.discoveredAt = existing.discoveredAt || discoveredAt;
  existing.extraction = parsedWork.extraction || existing.extraction;
}

function shouldUseBrowserSession(platform) {
  return (
    (platform === 'douyin' || platform === 'channels') &&
    typeof globalThis.__CLOUD_WORKER_BROWSER_SESSION__?.collectProfile === 'function'
  );
}

function mergeEvidenceItems(existingItems, nextItems) {
  const byId = new Map((Array.isArray(existingItems) ? existingItems : []).map((item) => [item.id, item]));
  for (const item of Array.isArray(nextItems) ? nextItems : []) {
    if (item?.id) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()].sort((left, right) => String(right.observedAt || right.fetchedAt || '').localeCompare(String(left.observedAt || left.fetchedAt || '')));
}

async function captureMonitoringEvidence(account, checkedAt, parsed, fetched) {
  if (!workbenchStore || !account) {
    return { snapshots: [], comments: [] };
  }
  const accountWorks = appState.works.filter((work) => work.accountId === account.id);
  const evidence = buildMonitoringEvidence({
    account,
    works: accountWorks,
    profileMetrics: fetched?.profileMetrics || parsed?.profileMetrics || account.profileMetrics || null,
    observedAt: checkedAt,
    source: parsed?.extraction || fetched?.source || 'profile-parser',
    comments: fetched?.comments || parsed?.comments || [],
  });
  if (evidence.snapshots.length) {
    workbenchStore.saveMonitoringMetricSnapshots(evidence.snapshots);
    appState.metricSnapshots = mergeEvidenceItems(appState.metricSnapshots, evidence.snapshots);
    account.metricStatus = 'available';
    account.metricLastObservedAt = checkedAt;
  } else {
    account.metricStatus = 'not_connected';
  }
  if (evidence.comments.length) {
    workbenchStore.saveMonitoringComments(evidence.comments);
    appState.comments = mergeEvidenceItems(appState.comments, evidence.comments);
    account.commentStatus = 'available';
    account.commentLastFetchedAt = checkedAt;
  } else {
    const commentCollectionAttempted = Array.isArray(fetched?.comments) || Array.isArray(parsed?.comments);
    account.commentStatus = commentCollectionAttempted ? 'empty' : 'not_connected';
    account.commentLastFetchedAt = commentCollectionAttempted ? checkedAt : account.commentLastFetchedAt || null;
  }
  return evidence;
}

async function refreshOne(account, options = {}) {
  const checkedAt = nowIso();
  try {
    const platform = account.platform || normalizeSource(account.sourceUrl).platform;
    const adapter = adapterFor(platform);
    const fetched = await adapter.fetchProfile(account.canonicalUrl || account.sourceUrl, {
      signal: AbortSignal.timeout(25000),
      browserSession: globalThis.__CLOUD_WORKER_BROWSER_SESSION__,
      useBrowser: Boolean(options.browser),
    });
    const parsed = fetched.browserSnapshot && typeof adapter.parseBrowserSnapshot === 'function'
      ? adapter.parseBrowserSnapshot(
          fetched.browserSnapshot,
          fetched.canonicalUrl || account.canonicalUrl || account.sourceUrl,
          fetched.userId || fetched.secUid,
        )
      : adapter.parseProfileHtml(
          fetched.html,
          fetched.canonicalUrl,
          fetched.userId || fetched.secUid,
        );
    const staleDouyinSeoWorks =
      options.browser &&
      platform === 'douyin' &&
      appState.works.filter(
        (work) =>
          work.accountId === account.id &&
          /[?&](?:source|from)=Baiduspider(?:-sdc)?/i.test(work.link || ''),
      ).length;
    if (staleDouyinSeoWorks) {
      appState.works = appState.works.filter(
        (work) =>
          work.accountId !== account.id ||
          !/[?&](?:source|from)=Baiduspider(?:-sdc)?/i.test(work.link || ''),
      );
    }
    const previousWorks = appState.works.filter((work) => work.accountId === account.id);
    const isBaseline = previousWorks.length === 0;
    const resolvedUserId = fetched.userId || fetched.secUid || parsed.userId || account.userId;
    let newWorks = 0;

    for (const parsedWork of parsed.works) {
      const fingerprint =
        parsedWork.fingerprint ||
        (typeof adapter.fingerprintForWork === 'function'
          ? adapter.fingerprintForWork({
              userId: resolvedUserId,
              title: parsedWork.title,
              publishedAt: parsedWork.publishedAt,
              noteId: parsedWork.noteId,
              contentId: parsedWork.contentId,
              coverUrl: parsedWork.coverUrl,
            })
          : fingerprintForWork({
              userId: resolvedUserId,
              title: parsedWork.title,
              publishedAt: parsedWork.publishedAt,
              noteId: parsedWork.noteId,
              coverUrl: parsedWork.coverUrl,
            }));
      const parsedContentId = parsedWork.contentId || parsedWork.noteId || null;
      const existing = previousWorks.find(
        (work) =>
          work.fingerprint === fingerprint ||
          (parsedContentId &&
            (work.contentId === parsedContentId || work.noteId === parsedContentId)) ||
          sameWorkWithoutId(work, parsedWork),
      );
      if (existing) {
        mergeParsedWork(
          existing,
          parsedWork,
          fingerprint,
          account.id,
          platform,
          resolvedUserId,
          checkedAt,
        );
        continue;
      }

      appState.works.push({
        id: 'work_' + fingerprint,
        accountId: account.id,
        tenantId: account.tenantId || 'tenant_local',
        platform,
        userId: resolvedUserId,
        title: parsedWork.title,
        publishedAt: parsedWork.publishedAt,
        noteId: parsedWork.noteId,
        contentId: parsedWork.contentId || parsedWork.noteId || null,
        likes: parsedWork.likes,
        metrics: parsedWork.metrics || null,
        coverUrl: parsedWork.coverUrl,
        link: parsedWork.link,
        isPinned: Boolean(parsedWork.isPinned),
        position: positionValue(parsedWork.position),
        fingerprint,
        discoveredAt: checkedAt,
        seen: isBaseline,
        extraction: parsedWork.extraction,
      });
      if (!isBaseline) {
        newWorks += 1;
      }
    }

    account.userId = resolvedUserId;
    account.platform = platform;
    account.platformLabel = adapter.label;
    account.canonicalUrl = fetched.canonicalUrl || account.canonicalUrl;
    account.nickname = parsed.nickname || account.nickname || account.name;
    account.avatarUrl = parsed.avatarUrl || account.avatarUrl || null;
    account.state = 'active';
    account.lastCheckedAt = checkedAt;
    account.lastError = null;
    account.workCount = appState.works.filter((work) => work.accountId === account.id).length;
    const evidence = await captureMonitoringEvidence(account, checkedAt, parsed, fetched);

    return {
      accountId: account.id,
      ok: true,
      parsedCount: parsed.works.length,
      newWorks,
      removedStaleWorks: staleDouyinSeoWorks,
      extraction: parsed.extraction,
      metricSnapshotCount: evidence.snapshots.length,
      commentCount: evidence.comments.length,
    };
  } catch (error) {
    account.state = 'error';
    account.lastCheckedAt = checkedAt;
    account.lastError = safeError(error);
    return {
      accountId: account.id,
      ok: false,
      parsedCount: 0,
      newWorks: 0,
      error: account.lastError,
    };
  }
}

async function refreshAll(
  actor = { username: 'system', displayName: '系统' },
  options = {},
) {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const startedAt = Date.now();
    appState.refreshInProgress = true;
    appState.refreshError = null;
    const results = [];

    try {
      const accounts = actor?.role === 'admin'
        ? appState.accounts
        : appState.accounts.filter((account) => account.tenantId === actor?.tenantId);
      for (const account of accounts) {
        const platform = account.platform || normalizeSource(account.sourceUrl).platform;
        results.push(
          await refreshOne(account, {
            browser: options.browser !== false && shouldUseBrowserSession(platform),
          }),
        );
        await sleep(280);
      }

      const failed = results.filter((result) => !result.ok);
      const newWorks = results.reduce((total, result) => total + result.newWorks, 0);
      appState.lastRefreshAt = nowIso();
      appState.lastRefreshSummary = {
        checked: results.length,
        succeeded: results.length - failed.length,
        failed: failed.length,
        newWorks,
        durationMs: Date.now() - startedAt,
      };
      if (failed.length > 0) {
        appState.refreshError =
          failed.length + ' 个账号获取失败，可查看账号卡片中的错误信息';
      }
      await persist();
      await recordActivity(
        actor,
        'refresh',
        '刷新 ' +
          results.length +
          ' 个账号，成功 ' +
          (results.length - failed.length) +
          ' 个，新增 ' +
          newWorks +
          ' 条作品',
      );
      return appState.lastRefreshSummary;
    } finally {
      appState.refreshInProgress = false;
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function readRequestBody(request) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > 1024 * 1024) {
      throw new Error('请求内容过大');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求 JSON 格式不正确');
  }
}

function sendJson(response, payload, httpCode = 200, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(httpCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(body);
}

function sendText(response, body, httpCode = 200, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(httpCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  response.end(body);
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function authorizedUser(request, response) {
  const user = currentUser(request);
  if (!user) {
    sendJson(response, { ok: false, error: '请先登录' }, 401);
    return null;
  }
  return user;
}

function adminUser(request, response) {
  const user = authorizedUser(request, response);
  if (!user) {
    return null;
  }
  if (!isAdmin(user)) {
    sendJson(response, { ok: false, error: '只有管理员可以查看这里' }, 403);
    return null;
  }
  return user;
}

function desktopPlatformSession() {
  return globalThis.__CLOUD_WORKER_BROWSER_SESSION__ || null;
}

async function platformSessionStatus() {
  const browserSession = desktopPlatformSession();
  if (typeof browserSession?.getStatus !== 'function') {
    return {
      available: false,
      mode: 'web',
      persistent: false,
      platforms: [],
      note: '当前是网页模式；平台登录态只保存在桌面客户端，不会保存在服务端。',
    };
  }
  return await browserSession.getStatus();
}

function contentTaskById(taskId, user = null) {
  const task = appState.contentTasks.find((item) => item.id === taskId) || null;
  if (!task || !user || user.role === 'admin') {
    return task;
  }
  if (task.tenantId !== user.tenantId) {
    return null;
  }
  if (workbenchStore && !workbenchStore.canAccessProject(user, task.projectId)) {
    return null;
  }
  return task;
}

function visibleContentTasks(user) {
  return appState.contentTasks.filter((task) => contentTaskById(task.id, user));
}

function accountById(accountId, user = null) {
  const account = appState.accounts.find((item) => item.id === accountId) || null;
  if (!account || !user || user.role === 'admin' || account.tenantId === user.tenantId) {
    return account;
  }
  return null;
}

async function saveContentTask(task, actor, eventType, eventData = {}) {
  const saved = workbenchStore
    ? workbenchStore.saveContentTask(task, actor)
    : normalizeContentTask(task);
  const index = appState.contentTasks.findIndex((item) => item.id === saved.id);
  if (index >= 0) {
    appState.contentTasks[index] = saved;
  } else {
    appState.contentTasks.unshift(saved);
  }
  if (workbenchStore && eventType) {
    workbenchStore.recordContentEvent(saved, actor, eventType, eventData);
  }
  await persist();
  return saved;
}

function mediaAllowedRoots() {
  const configured = String(process.env.XHS_MEDIA_ROOTS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (configured.length) {
    return [DATA_DIR, ...configured];
  }
  const roots = [DATA_DIR];
  if (authConfig().localDefaults) {
    roots.push(join(homedir(), 'Downloads'));
  }
  return roots;
}

function safeOutputId(value) {
  return String(value || 'item').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
}

function connectorForCapability(user, capability, tenantId = null) {
  const connectors = workbenchStore.seedDefaultConnectors(user);
  const connector = connectors.find((item) => item.capabilities.includes(capability) && (!tenantId || item.tenantId === tenantId));
  if (!connector) {
    throw new Error('没有登记支持该能力的连接器：' + capability);
  }
  if (!workbenchStore.hasConnectorPermission(user, connector.id, capability)) {
    throw new Error('当前成员没有使用连接器的权限：' + connector.name);
  }
  return connector;
}

function taskNode(task, nodeId) {
  const node = task.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error('工作流节点不存在');
  return node;
}

function taskText(task, assets = []) {
  return [
    task.sourceBrief,
    ...assets.flatMap((asset) => [asset.textContent, asset.transcript, asset.ocrText]),
  ].filter((item) => typeof item === 'string' && item.trim()).join('\n\n');
}

function taskSourceReferences(assets = [], knowledge = []) {
  return [
    ...assets.map((asset) => ({
      type: 'material',
      id: asset.id,
      filename: asset.filename,
      kind: asset.kind,
      transcriptStatus: asset.metadata?.transcriptResult?.status || null,
      ocrStatus: asset.metadata?.ocrResult?.status || null,
      transcriptSegments: asset.metadata?.transcriptResult?.segments || [],
    })),
    ...knowledge.map((item) => ({
      type: 'knowledge',
      id: item.id,
      title: item.title,
      sourceType: item.sourceType || null,
    })),
  ];
}

async function recordReadyTaskNode(task, nodeId, input, actor, eventType = 'content_node_executed') {
  const node = taskNode(task, nodeId);
  if (node.status === 'succeeded') return task;
  if (!['ready', 'running', 'waiting_review'].includes(node.status)) {
    throw new Error('节点 ' + nodeId + ' 尚未到达可执行状态');
  }
  const recorded = recordContentNode(task, nodeId, input, actor);
  return saveContentTask(recorded, actor, eventType, {
    nodeId,
    status: recorded.nodes.find((item) => item.id === nodeId)?.status,
  });
}

async function parseTaskMaterial(task, body, actor) {
  connectorForCapability(actor, 'media.probe', task.tenantId);
  const parsed = await parseMediaAsset(body.path, {
    allowedRoots: mediaAllowedRoots(),
    previewDir: PREVIEW_DIR,
    baseDir: DATA_DIR,
  });
  const asset = workbenchStore.saveMediaAsset({
    ...parsed,
    tenantId: task.tenantId,
    projectId: task.projectId,
    taskId: task.id,
    metadata: {
      ...parsed.metadata,
      transcriptResult: parsed.transcriptResult,
      ocrResult: parsed.ocrResult,
    },
    mimeType: parsed.mimeType,
    textContent: parsed.textContent,
    transcript: parsed.transcript,
    ocrText: parsed.ocrText,
  }, actor);
  let document = null;
  const searchableContent = [parsed.textContent, parsed.transcript, parsed.ocrText].filter(Boolean).join('\n\n');
  document = workbenchStore.saveKnowledgeDocument({
    id: 'knowledge_' + asset.id,
    tenantId: task.tenantId,
    projectId: task.projectId,
    taskId: task.id,
    title: '素材：' + parsed.filename,
    content: searchableContent || JSON.stringify({
      filename: parsed.filename,
      kind: parsed.kind,
      metadata: parsed.metadata,
      transcript: parsed.transcriptResult,
      ocr: parsed.ocrResult,
    }, null, 2),
    sourceType: 'local_media',
    sourcePath: parsed.path,
    metadata: { assetId: asset.id, status: parsed.status },
  }, actor);

  let currentTask = task;
  if (taskNode(currentTask, 'CE-04').status !== 'succeeded') {
    currentTask = await recordReadyTaskNode(currentTask, 'CE-04', {
      status: 'succeeded',
      input: { path: parsed.path, assetId: asset.id },
      output: {
        assetId: asset.id,
        filename: parsed.filename,
        kind: parsed.kind,
        sizeBytes: parsed.sizeBytes,
        knowledgeDocumentId: document.id,
      },
      note: '已读取本地授权素材并写入媒体资产与知识索引',
    }, actor);
  }
  if (taskNode(currentTask, 'CE-05').status !== 'succeeded') {
    currentTask = await recordReadyTaskNode(currentTask, 'CE-05', {
      status: parsed.metadata.media || parsed.status === 'parsed' ? 'succeeded' : 'failed',
      output: {
        media: parsed.metadata.media,
        mimeType: parsed.mimeType,
        sizeBytes: parsed.sizeBytes,
        parseStatus: parsed.status,
        parseMessage: parsed.metadata.parseMessage,
      },
      error: parsed.metadata.parseMessage,
      note: 'ffprobe/本地文件解析结果已登记',
    }, actor);
  }
  return { task: currentTask, asset, document, parsed };
}

function generationNodeForKind(kind) {
  const mapping = {
    topic: { nodeId: 'CE-10', capability: 'topic.generate' },
    copy: { nodeId: 'CE-11', capability: 'copy.generate' },
    platform: { nodeId: 'CE-12', capability: 'platform.adapt' },
    shotlist: { nodeId: 'CE-13', capability: 'shotlist.generate' },
    retro: { nodeId: 'CE-26', capability: 'retro.generate' },
  };
  return mapping[kind] || null;
}

async function generateTaskContent(task, body, actor) {
  const config = generationNodeForKind(body.kind);
  if (!config) throw new Error('不支持的生成类型：' + body.kind);
  const provider = aiProviderStatus();
  if (!provider.configured && !provider.localDraftGenerator) {
    const error = new Error('未配置 DeepSeek API Key，AI 生成节点暂不可执行');
    error.code = 'AI_PROVIDER_NOT_CONFIGURED';
    throw error;
  }
  if (provider.configured) connectorForCapability(actor, config.capability, task.tenantId);
  const assets = workbenchStore.listMediaAssets(actor, task.id);
  const query = String(body.query || task.title || '').trim().slice(0, 200);
  const knowledge = workbenchStore.searchKnowledge(actor, query, { limit: 8 });
  const structure = task.nodes.find((node) => node.id === 'CE-09')?.output || null;
  const generated = await generateContentDraft({
    kind: body.kind,
    task,
    knowledge,
    structure,
    materialText: taskText(task, assets),
    sourceReferences: taskSourceReferences(assets, knowledge),
  });
  const nextTask = await recordReadyTaskNode(task, config.nodeId, {
    status: 'succeeded',
    input: { kind: body.kind, knowledgeIds: knowledge.map((item) => item.id) },
    output: {
      text: generated.text,
      provider: generated.provider,
      model: generated.model,
      requestId: generated.requestId,
      usage: generated.usage,
      promptVersion: generated.promptVersion,
      sourceIndex: generated.sourceIndex,
      sourceReferences: taskSourceReferences(assets, knowledge),
    },
    note: generated.provider === 'deepseek'
      ? '通过已授权的模型连接器生成，等待人工审核'
      : '通过本地抽取式模板生成，未补写未知事实，等待人工审核',
  }, actor, 'ai_generation_completed');
  return { task: nextTask, output: generated, knowledge };
}

function nodeIdToGenerationKind(nodeId) {
  return {
    'CE-10': 'topic',
    'CE-11': 'copy',
    'CE-12': 'platform',
    'CE-13': 'shotlist',
    'CE-26': 'retro',
  }[nodeId] || null;
}

function srtTimestamp(totalSeconds) {
  const milliseconds = Math.max(0, Math.round(totalSeconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':') + ',' + String(millis).padStart(3, '0');
}

function subtitleText(transcript) {
  const lines = String(transcript || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => {
    const start = index * 4;
    const end = start + 4;
    return `${index + 1}\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\n${line}\n`;
  }).join('\n');
}

function contentPackageManifest(task, assets) {
  const packageSafeValue = (value, key = '') => {
    if (Array.isArray(value)) return value.map((item) => packageSafeValue(item, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, packageSafeValue(childValue, childKey)]));
    }
    if (typeof value === 'string' && /path/i.test(key)) return value ? basename(value) : value;
    return value;
  };
  return {
    schemaVersion: 'content-package-v0.1',
    generatedAt: nowIso(),
    task: {
      id: task.id,
      title: task.title,
      objective: task.objective,
      audience: task.audience,
      platforms: task.platforms,
      workflowVersion: task.workflowVersion,
      status: task.status,
    },
    nodes: task.nodes
      .filter((node) => ['succeeded', 'skipped'].includes(node.status))
      .map((node) => ({
        id: node.id,
        key: node.key,
        label: node.label,
        status: node.status,
        input: packageSafeValue(node.input),
        output: packageSafeValue(node.output),
        error: node.error,
      })),
    assets: assets.map((asset) => ({
      id: asset.id,
      filename: asset.filename,
      kind: asset.kind,
      mimeType: asset.mimeType,
      status: asset.status,
      metadata: packageSafeValue(asset.metadata),
    })),
    versions: packageSafeValue(task.versions),
    reviews: packageSafeValue(task.reviews),
    delivery: {
      externalPublishExecuted: false,
      note: '本内容包只代表本地交付准备，外部平台发布必须单独授权并取得真实回执。',
    },
  };
}

async function executeTaskNode(task, body, actor) {
  const nodeId = String(body.nodeId || '').trim();
  if (!nodeId) throw new Error('节点 ID 不能为空');
  if (task.run?.status === 'not_started') throw new Error('请先启动内容工作流');

  if (nodeId === 'CE-02') {
    const output = {
      sourceType: 'task_context',
      sourceBrief: task.sourceBrief || '',
      sourceAssets: task.sourceAssets || [],
      loadedAt: nowIso(),
      requiresHumanConfirmation: true,
    };
    return recordReadyTaskNode(task, nodeId, {
      status: 'succeeded',
      output,
      note: '加载任务中已登记的品牌/业务上下文；事实仍需人工确认',
    }, actor);
  }

  if (nodeId === 'CE-03') {
    connectorForCapability(actor, 'knowledge.search', task.tenantId);
    const query = String(body.query || task.title || task.sourceBrief || '').trim().slice(0, 200);
    const results = workbenchStore.searchKnowledge(actor, query, { limit: 8 });
    return recordReadyTaskNode(task, nodeId, {
      status: 'succeeded',
      input: { query },
      output: { query, results },
      note: '按当前租户和项目权限检索 SQLite 知识文档',
    }, actor);
  }

  if (nodeId === 'CE-04') {
    return (await parseTaskMaterial(task, { path: body.path || task.sourceAssets?.[0] }, actor)).task;
  }

  const assets = workbenchStore.listMediaAssets(actor, task.id);
  const asset = body.assetId ? assets.find((item) => item.id === body.assetId) : assets[0];
  if (['CE-05', 'CE-06', 'CE-07', 'CE-08', 'CE-16', 'CE-17', 'CE-18'].includes(nodeId) && !asset) {
    throw new Error('当前任务没有媒体资产，请先执行素材解析');
  }

  if (nodeId === 'CE-05') {
    return recordReadyTaskNode(task, nodeId, {
      status: 'succeeded',
      input: { assetId: asset.id },
      output: asset.metadata?.media || { kind: asset.kind, mimeType: asset.mimeType, sizeBytes: asset.metadata?.sizeBytes || null },
      note: '读取已登记媒体资产的探测结果',
    }, actor);
  }

  if (nodeId === 'CE-06') {
    if (asset.kind === 'text') {
      return recordReadyTaskNode(task, nodeId, { status: 'succeeded', output: { status: 'not_applicable', assetId: asset.id }, note: '文本素材不需要音频转写' }, actor);
    }
    const result = asset.metadata?.transcriptResult;
    if (result?.status !== 'succeeded' || !asset.transcript) {
      const error = new Error(result?.message || '转写连接器未配置');
      error.code = 'TRANSCRIPTION_NOT_CONFIGURED';
      throw error;
    }
    return recordReadyTaskNode(task, nodeId, { status: 'succeeded', input: { assetId: asset.id }, output: { text: asset.transcript, status: result.status }, note: '使用已配置 ASR 生成转写' }, actor);
  }

  if (nodeId === 'CE-07') {
    if (asset.kind === 'text' || asset.kind === 'audio') {
      return recordReadyTaskNode(task, nodeId, { status: 'succeeded', output: { status: 'not_applicable', assetId: asset.id }, note: '当前素材类型不需要画面 OCR' }, actor);
    }
    const result = asset.metadata?.ocrResult;
    if (result?.status !== 'succeeded') {
      const error = new Error(result?.message || 'OCR 连接器未配置');
      error.code = 'OCR_NOT_CONFIGURED';
      throw error;
    }
    return recordReadyTaskNode(task, nodeId, { status: 'succeeded', input: { assetId: asset.id }, output: { text: asset.ocrText, status: result.status }, note: '使用 macOS Vision 或已配置 OCR 连接器识别画面文字' }, actor);
  }

  if (nodeId === 'CE-08') {
    if (['text', 'audio'].includes(asset.kind)) {
      return recordReadyTaskNode(task, nodeId, { status: 'skipped', input: { assetId: asset.id }, output: { status: 'not_applicable', assetId: asset.id }, note: '当前素材类型没有可提取的视频关键帧' }, actor);
    }
    const keyframe = asset.metadata?.keyframe;
    if (keyframe?.status !== 'succeeded') throw new Error(keyframe?.message || '关键帧尚未生成');
    return recordReadyTaskNode(task, nodeId, { status: 'succeeded', input: { assetId: asset.id }, output: keyframe, note: '关键帧已从原始视频提取，不覆盖原素材' }, actor);
  }

  if (nodeId === 'CE-09') {
    const sourceText = taskText(task, assets);
    if (!sourceText) throw new Error('没有可分析的文本、转写或 OCR 内容');
    const structure = analyzeContentStructure(sourceText);
    return recordReadyTaskNode(task, nodeId, { status: 'succeeded', input: { assetIds: assets.map((item) => item.id) }, output: structure, note: '基于任务素材执行本地结构分析' }, actor);
  }

  const generationKind = nodeIdToGenerationKind(nodeId);
  if (generationKind) {
    return (await generateTaskContent(task, { ...body, kind: generationKind }, actor)).task;
  }

  if (nodeId === 'CE-14' || nodeId === 'CE-15') {
    return recordReadyTaskNode(task, nodeId, {
      status: 'skipped',
      output: {
        status: 'not_configured',
        optional: true,
        reason: nodeId === 'CE-14' ? '未配置语音连接器' : '未配置数字人连接器',
      },
      note: '可选媒体能力暂未配置，明确跳过，不伪造生成结果',
    }, actor);
  }

  if (nodeId === 'CE-16' && asset.kind !== 'video') {
    return recordReadyTaskNode(task, nodeId, {
      status: 'skipped',
      input: { assetId: asset.id },
      output: { status: 'not_applicable', assetId: asset.id, reason: '当前素材不是视频' },
      note: '当前素材没有可渲染的视频轨道，明确跳过本地渲染',
    }, actor);
  }

  if (nodeId === 'CE-17' && asset.kind === 'text') {
    return recordReadyTaskNode(task, nodeId, {
      status: 'skipped',
      input: { assetId: asset.id },
      output: { status: 'not_applicable', assetId: asset.id, reason: '文本素材无需生成字幕文件' },
      note: '文本素材明确跳过字幕生成',
    }, actor);
  }

  if (nodeId === 'CE-18' && asset.kind !== 'video') {
    return recordReadyTaskNode(task, nodeId, {
      status: 'skipped',
      input: { assetId: asset.id },
      output: { status: 'not_applicable', assetId: asset.id, reason: '当前素材没有视频关键帧' },
      note: '当前素材明确跳过封面候选生成',
    }, actor);
  }

  if (nodeId === 'CE-17') {
    if (!asset.transcript) throw new Error('没有可生成字幕的转写文本');
    const subtitle = subtitleText(asset.transcript);
    await mkdir(SUBTITLE_DIR, { recursive: true });
    const path = join(SUBTITLE_DIR, safeOutputId(task.id) + '-' + asset.id + '.srt');
    await writeFile(path, subtitle, 'utf8');
    const subtitleAsset = workbenchStore.saveMediaAsset({
      id: 'asset_subtitle_' + randomUUID(),
      tenantId: task.tenantId,
      projectId: task.projectId,
      taskId: task.id,
      path,
      filename: basename(path),
      kind: 'text',
      mimeType: 'application/x-subrip',
      status: 'generated',
      metadata: { sourceAssetId: asset.id, format: 'srt' },
      textContent: subtitle,
    }, actor);
    return recordReadyTaskNode(task, nodeId, { status: 'succeeded', input: { assetId: asset.id }, output: subtitleAsset, note: '根据真实转写文本生成字幕文件' }, actor);
  }

  if (nodeId === 'CE-18') {
    const keyframe = asset.metadata?.keyframe;
    if (keyframe?.status !== 'succeeded') throw new Error('没有可用关键帧，不能生成封面候选');
    return recordReadyTaskNode(task, nodeId, { status: 'succeeded', input: { assetId: asset.id }, output: { path: keyframe.path, source: 'keyframe', assetId: asset.id }, note: '使用真实关键帧作为封面候选，等待人工审核' }, actor);
  }

  if (nodeId === 'CE-19') {
    return recordReadyTaskNode(task, nodeId, { status: 'succeeded', output: { checklist: ['事实来源', '品牌表达', '版权/授权', '字幕/画面', 'CTA/平台约束'], createdAt: nowIso() }, note: '创建内容审核检查单，后续由人工提交决定' }, actor);
  }

  throw new Error('该节点需要人工输入或专用连接器：' + nodeId);
}

async function serveStatic(requestUrl, response) {
  const requestPath = decodeURIComponent(
    requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname,
  );
  const target = resolve(PUBLIC_DIR, '.' + requestPath);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + '/')) {
    return sendText(response, 'Not found', 404);
  }

  try {
    const body = await readFile(target);
    return sendText(
      response,
      body,
      200,
      MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      return sendText(response, 'Not found', 404);
    }
    throw error;
  }
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, 'http://' + SERVER_HOST + ':' + SERVER_PORT);

  if (requestUrl.pathname === '/api/auth/config' && request.method === 'GET') {
    return sendJson(response, { ok: true, auth: authConfig() });
  }

  if (requestUrl.pathname === '/api/auth/me' && request.method === 'GET') {
    const user = currentUser(request);
    if (!user) {
      return sendJson(response, { ok: false, error: '请先登录' }, 401);
    }
    return sendJson(response, { ok: true, user });
  }

  if (requestUrl.pathname === '/api/auth/login' && request.method === 'POST') {
    const body = await readRequestBody(request);
    const user = authenticate(body.username, body.password);
    if (!user) {
      return sendJson(response, { ok: false, error: '账号或密码不正确' }, 401);
    }
    return sendJson(response, { ok: true, user }, 200, {
      'set-cookie': sessionCookie(user),
    });
  }

  if (requestUrl.pathname === '/api/auth/invitations/accept' && request.method === 'POST') {
    const body = await readRequestBody(request);
    try {
      const accepted = workbenchStore.acceptInvitation(body.token, body.password);
      return sendJson(response, { ok: true, user: accepted.user, invitation: accepted.invitation }, 201);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/auth/logout' && request.method === 'POST') {
    return sendJson(response, { ok: true }, 200, {
      'set-cookie': clearSessionCookie(),
    });
  }

  if (requestUrl.pathname === '/api/health' && request.method === 'GET') {
    return sendJson(response, {
      ok: true,
      service: 'cloud-worker-media-workbench',
      time: nowIso(),
      refreshInProgress: appState.refreshInProgress,
      authRequired: authConfig().required,
      refreshIntervalMinutes: SERVER_REFRESH_MINUTES,
    });
  }

  if (requestUrl.pathname === '/api/platform-sessions' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    try {
      return sendJson(response, { ok: true, ...(await platformSessionStatus()) });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (
    requestUrl.pathname.startsWith('/api/platform-sessions/') &&
    requestUrl.pathname.endsWith('/open') &&
    request.method === 'POST'
  ) {
    const user = adminUser(request, response);
    if (!user) {
      return null;
    }
    const browserSession = desktopPlatformSession();
    if (typeof browserSession?.open !== 'function') {
      return sendJson(response, { ok: false, error: '平台登录窗口仅在桌面客户端可用，请打开桌面版后重试' }, 409);
    }
    const platform = decodeURIComponent(
      requestUrl.pathname.slice('/api/platform-sessions/'.length, -'/open'.length),
    );
    try {
      const status = await browserSession.open(platform);
      await recordActivity(user, 'platform_session_opened', '打开平台登录窗口：' + platform);
      return sendJson(response, { ok: true, status });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (
    requestUrl.pathname.startsWith('/api/platform-sessions/') &&
    requestUrl.pathname.endsWith('/clear') &&
    request.method === 'POST'
  ) {
    const user = adminUser(request, response);
    if (!user) {
      return null;
    }
    const browserSession = desktopPlatformSession();
    if (typeof browserSession?.clear !== 'function') {
      return sendJson(response, { ok: false, error: '平台登录态只能在桌面客户端清除，请打开桌面版后重试' }, 409);
    }
    const platform = decodeURIComponent(
      requestUrl.pathname.slice('/api/platform-sessions/'.length, -'/clear'.length),
    );
    try {
      const status = await browserSession.clear(platform);
      await recordActivity(user, 'platform_session_cleared', '清除平台登录态：' + platform);
      return sendJson(response, { ok: true, status });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/monitoring/insights' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    const requestedPeriod = requestUrl.searchParams.get('period') || 'month';
    const period = ['realtime', 'week', 'month', 'all'].includes(requestedPeriod)
      ? requestedPeriod
      : 'month';
    const platform = requestUrl.searchParams.get('platform') || 'all';
    const accountId = requestUrl.searchParams.get('accountId') || 'all';
    if (accountId !== 'all' && !accountById(accountId, user)) {
      return sendJson(response, { ok: false, error: '监控账号不存在或当前成员无权查看' }, 404);
    }
    return sendJson(response, {
      ok: true,
      insights: monitoringInsightsForUser(user, { period, platform, accountId }),
    });
  }

  if (requestUrl.pathname === '/api/state' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    return sendJson(response, publicState(user));
  }

  if (requestUrl.pathname === '/api/workspace' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    try {
      const context = workbenchStore.ensureContext(user);
      const connectors = workbenchStore.seedDefaultConnectors(user);
      return sendJson(response, {
        ok: true,
        storage: { type: 'sqlite', file: 'workbench.sqlite' },
        user: context.user,
        tenant: workbenchStore.listTenants(user).find((item) => item.id === context.tenantId) || null,
        project: context.project,
        projects: workbenchStore.listProjects(user),
        customers: workbenchStore.listCustomers(user),
        brandProfiles: workbenchStore.listBrandProfiles(user, context.project.id),
        users: user.role === 'admin' ? workbenchStore.listUsers(user) : undefined,
        projectMembers: workbenchStore.listProjectMembers(user, context.project.id),
        connectors,
        grants: workbenchStore.listConnectorGrants(user),
        capabilities: await runtimeCapabilities(),
        ai: aiProviderStatus(),
      });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/workspace/backups' && request.method === 'GET') {
    const user = adminUser(request, response);
    if (!user) return null;
    try {
      const backups = await workbenchStore.listBackups();
      return sendJson(response, { ok: true, backups: backups.map(publicBackup) });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/workspace/backups' && request.method === 'POST') {
    const user = adminUser(request, response);
    if (!user) return null;
    const body = await readRequestBody(request);
    try {
      const backup = await workbenchStore.createBackup({
        backupId: body.backupId,
        includeMedia: body.includeMedia === true,
      });
      await recordActivity(user, 'workspace_backup_created', '创建工作台备份：' + backup.backupId);
      return sendJson(response, { ok: true, backup: publicBackup(backup) }, 201);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/workspace/backups/') && requestUrl.pathname.endsWith('/verify') && request.method === 'POST') {
    const user = adminUser(request, response);
    if (!user) return null;
    const backupId = decodeURIComponent(requestUrl.pathname.slice('/api/workspace/backups/'.length, -'/verify'.length));
    try {
      const verification = await workbenchStore.verifyBackup(backupId);
      await recordActivity(user, 'workspace_backup_verified', '校验工作台备份：' + backupId + ' / ' + verification.status);
      return sendJson(response, { ok: verification.status === 'PASS', verification }, verification.status === 'PASS' ? 200 : 409);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/workspace/projects' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    return sendJson(response, { ok: true, projects: workbenchStore.listProjects(user) });
  }

  if (requestUrl.pathname === '/api/workspace/projects' && request.method === 'POST') {
    const user = adminUser(request, response);
    if (!user) return null;
    const body = await readRequestBody(request);
    try {
      const project = workbenchStore.createProject(user, body);
      await recordActivity(user, 'project_created', '创建工作台项目：' + project.name);
      return sendJson(response, { ok: true, project }, 201);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/workspace/customers' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    try {
      return sendJson(response, { ok: true, customers: workbenchStore.listCustomers(user, requestUrl.searchParams.get('tenantId')) });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/workspace/customers' && request.method === 'POST') {
    const user = adminUser(request, response);
    if (!user) return null;
    const body = await readRequestBody(request);
    try {
      const customer = workbenchStore.createCustomer(user, body);
      await recordActivity(user, 'workspace_customer_created', '创建客户上下文：' + customer.name);
      return sendJson(response, { ok: true, customer }, 201);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/workspace/brand-profiles' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    try {
      return sendJson(response, {
        ok: true,
        brandProfiles: workbenchStore.listBrandProfiles(
          user,
          requestUrl.searchParams.get('projectId'),
          requestUrl.searchParams.get('tenantId'),
        ),
      });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/workspace/brand-profiles' && request.method === 'POST') {
    const user = adminUser(request, response);
    if (!user) return null;
    const body = await readRequestBody(request);
    try {
      const brandProfile = workbenchStore.createBrandProfile(user, body);
      await recordActivity(user, 'workspace_brand_profile_created', '创建品牌资料：' + brandProfile.name);
      return sendJson(response, { ok: true, brandProfile }, 201);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/workspace/users' && request.method === 'GET') {
    const user = adminUser(request, response);
    if (!user) return null;
    try {
      return sendJson(response, { ok: true, users: workbenchStore.listUsers(user, requestUrl.searchParams.get('tenantId')) });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/workspace/users' && request.method === 'POST') {
    const user = adminUser(request, response);
    if (!user) return null;
    const body = await readRequestBody(request);
    try {
      const member = workbenchStore.createUser(user, body);
      await recordActivity(user, 'workspace_member_created', '创建工作台成员：' + member.username);
      return sendJson(response, { ok: true, user: member }, 201);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/workspace/users/') && request.method === 'PATCH') {
    const user = adminUser(request, response);
    if (!user) return null;
    const username = decodeURIComponent(requestUrl.pathname.slice('/api/workspace/users/'.length));
    const body = await readRequestBody(request);
    try {
      const member = workbenchStore.updateUser(user, username, body);
      await recordActivity(user, 'workspace_member_updated', '更新工作台成员：' + member.username);
      return sendJson(response, { ok: true, user: member });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/workspace/invitations' && request.method === 'GET') {
    const user = adminUser(request, response);
    if (!user) return null;
    try {
      return sendJson(response, { ok: true, invitations: workbenchStore.listInvitations(user, requestUrl.searchParams.get('tenantId')) });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/workspace/invitations' && request.method === 'POST') {
    const user = adminUser(request, response);
    if (!user) return null;
    const body = await readRequestBody(request);
    try {
      const invitation = workbenchStore.createInvitation(user, body);
      await recordActivity(user, 'workspace_invitation_created', '创建工作台成员邀请：' + invitation.username);
      return sendJson(response, { ok: true, invitation }, 201);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/workspace/invitations/') && requestUrl.pathname.endsWith('/revoke') && request.method === 'POST') {
    const user = adminUser(request, response);
    if (!user) return null;
    const invitationId = decodeURIComponent(requestUrl.pathname.slice('/api/workspace/invitations/'.length, -'/revoke'.length));
    try {
      const invitation = workbenchStore.revokeInvitation(user, invitationId);
      await recordActivity(user, 'workspace_invitation_revoked', '撤销工作台成员邀请：' + invitation.username);
      return sendJson(response, { ok: true, invitation }, 200);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/workspace/directory/sync' && request.method === 'GET') {
    const user = adminUser(request, response);
    if (!user) return null;
    try {
      return sendJson(response, { ok: true, syncs: workbenchStore.listDirectorySyncRuns(user, requestUrl.searchParams.get('tenantId')) });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/workspace/directory/sync' && request.method === 'POST') {
    const user = adminUser(request, response);
    if (!user) return null;
    const body = await readRequestBody(request);
    try {
      const result = workbenchStore.syncDirectory(user, body);
      if (result.mode === 'apply') {
        await recordActivity(user, 'workspace_directory_synced', '同步组织目录：' + result.source + ' / ' + result.summary.created + ' 新增');
      }
      return sendJson(response, { ok: true, ...result }, 200);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/workspace/projects/') && requestUrl.pathname.endsWith('/members') && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const projectId = decodeURIComponent(requestUrl.pathname.slice('/api/workspace/projects/'.length, -'/members'.length));
    try {
      return sendJson(response, { ok: true, members: workbenchStore.listProjectMembers(user, projectId) });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/workspace/projects/') && requestUrl.pathname.endsWith('/members') && request.method === 'POST') {
    const user = adminUser(request, response);
    if (!user) return null;
    const projectId = decodeURIComponent(requestUrl.pathname.slice('/api/workspace/projects/'.length, -'/members'.length));
    const body = await readRequestBody(request);
    try {
      const members = workbenchStore.addProjectMember(user, projectId, body.username, body.memberRole);
      await recordActivity(user, 'project_member_updated', '更新项目成员：' + projectId);
      return sendJson(response, { ok: true, members });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/workspace/projects/') && requestUrl.pathname.includes('/members/') && request.method === 'DELETE') {
    const user = adminUser(request, response);
    if (!user) return null;
    const prefix = '/api/workspace/projects/';
    const marker = '/members/';
    const rest = requestUrl.pathname.slice(prefix.length);
    const markerIndex = rest.indexOf(marker);
    const projectId = decodeURIComponent(rest.slice(0, markerIndex));
    const username = decodeURIComponent(rest.slice(markerIndex + marker.length));
    try {
      const members = workbenchStore.removeProjectMember(user, projectId, username);
      await recordActivity(user, 'project_member_removed', '移除项目成员：' + username);
      return sendJson(response, { ok: true, members });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/workspace/connectors' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    try {
      return sendJson(response, {
        ok: true,
        connectors: workbenchStore.seedDefaultConnectors(user),
        grants: workbenchStore.listConnectorGrants(user),
      });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/workspace/connectors/') && requestUrl.pathname.endsWith('/grants') && request.method === 'POST') {
    const user = adminUser(request, response);
    if (!user) return null;
    const connectorId = decodeURIComponent(requestUrl.pathname.slice('/api/workspace/connectors/'.length, -'/grants'.length));
    const body = await readRequestBody(request);
    try {
      const grants = workbenchStore.grantConnector(user, connectorId, body.permissions, body.effect || 'allow', body.subjectUsername || '*');
      await recordActivity(user, 'connector_grant_updated', '更新连接器授权：' + connectorId);
      return sendJson(response, { ok: true, grants });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/workspace/connectors/') && request.method === 'PATCH') {
    const user = adminUser(request, response);
    if (!user) return null;
    const connectorId = decodeURIComponent(requestUrl.pathname.slice('/api/workspace/connectors/'.length));
    const body = await readRequestBody(request);
    try {
      const connector = workbenchStore.updateConnector(user, connectorId, body);
      await recordActivity(user, 'connector_updated', '配置连接器：' + connector.name);
      return sendJson(response, { ok: true, connector });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/knowledge/search' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    try {
      connectorForCapability(user, 'knowledge.search');
      const results = workbenchStore.searchKnowledge(user, requestUrl.searchParams.get('q'), {
        limit: requestUrl.searchParams.get('limit'),
      });
      return sendJson(response, { ok: true, query: requestUrl.searchParams.get('q') || '', results });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/knowledge/documents' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const body = await readRequestBody(request);
    try {
      connectorForCapability(user, 'knowledge.write');
      if (!body.title || !body.content) throw new Error('知识文档标题和内容不能为空');
      const document = workbenchStore.saveKnowledgeDocument({
        id: body.id || 'knowledge_' + randomUUID(),
        tenantId: user.tenantId,
        projectId: body.projectId,
        taskId: body.taskId || null,
        title: String(body.title).trim().slice(0, 200),
        content: String(body.content).trim().slice(0, 100_000),
        sourceType: body.sourceType || 'manual',
        sourcePath: body.sourcePath || '',
        metadata: body.metadata || {},
      }, user);
      await recordActivity(user, 'knowledge_document_saved', '写入知识文档：' + document.title);
      return sendJson(response, { ok: true, document }, 201);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/content/tasks' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    const status = requestUrl.searchParams.get('status');
    const tasks = visibleContentTasks(user)
      .filter((task) => !status || task.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(contentTaskSummary);
    return sendJson(response, {
      ok: true,
      workflow: {
        version: CONTENT_WORKFLOW_VERSION,
        nodeCount: CONTENT_NODE_CATALOG.length,
        mode: 'local_test',
      },
      tasks,
    });
  }

  if (requestUrl.pathname === '/api/content/tasks' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    const body = await readRequestBody(request);
    if (typeof body.objective === 'string' && body.objective.length > 2000) {
      return sendJson(response, { ok: false, error: '业务目标不能超过 2000 个字' }, 400);
    }
    if (typeof body.sourceBrief === 'string' && body.sourceBrief.length > 20_000) {
      return sendJson(response, { ok: false, error: '素材说明不能超过 20000 个字' }, 400);
    }
    let task;
    try {
      const context = workbenchStore.ensureContext(user, body.projectId || null);
      task = createContentTask(body, user, {
        id: 'content_task_' + randomUUID(),
        tenantId: context.tenantId,
        projectId: context.project.id,
      });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 400);
    }
    await saveContentTask(task, user, 'content_task_created', { title: task.title });
    await recordActivity(user, 'content_task_created', '创建内容任务：' + task.title);
    return sendJson(response, { ok: true, task }, 201);
  }

  if (
    requestUrl.pathname.startsWith('/api/content/tasks/') &&
    requestUrl.pathname.endsWith('/start') &&
    request.method === 'POST'
  ) {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    const taskId = decodeURIComponent(
      requestUrl.pathname.slice('/api/content/tasks/'.length, -'/start'.length),
    );
    const task = contentTaskById(taskId, user);
    if (!task) {
      return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    }
    let started;
    try {
      started = startContentTask(task, user, {
        runId: 'content_run_' + randomUUID(),
        mode: 'local_test',
      });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
    await saveContentTask(started, user, 'workflow_started', { runId: started.run.id });
    await recordActivity(user, 'content_task_started', '启动内容工作流：' + started.title);
    return sendJson(response, { ok: true, task: started }, 200);
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && requestUrl.pathname.endsWith('/pause') && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(requestUrl.pathname.slice('/api/content/tasks/'.length, -'/pause'.length));
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    try {
      const paused = pauseContentTask(task, user);
      await saveContentTask(paused, user, 'workflow_paused', { runId: paused.run?.id, nodeId: paused.run?.pausedNodeId });
      await recordActivity(user, 'content_task_paused', '暂停内容工作流：' + paused.title);
      return sendJson(response, { ok: true, task: paused }, 200);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && requestUrl.pathname.endsWith('/resume') && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(requestUrl.pathname.slice('/api/content/tasks/'.length, -'/resume'.length));
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    try {
      const pausedNodeId = task.run?.pausedNodeId || null;
      const resumed = resumeContentTask(task, user);
      await saveContentTask(resumed, user, 'workflow_resumed', { runId: resumed.run?.id, nodeId: pausedNodeId });
      await recordActivity(user, 'content_task_resumed', '继续内容工作流：' + resumed.title);
      return sendJson(response, { ok: true, task: resumed }, 200);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && requestUrl.pathname.endsWith('/retry') && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(requestUrl.pathname.slice('/api/content/tasks/'.length, -'/retry'.length));
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    const body = await readRequestBody(request);
    try {
      const retried = retryContentNode(task, body.nodeId, user);
      await saveContentTask(retried, user, 'content_node_retry_requested', { runId: retried.run?.id, nodeId: body.nodeId });
      await recordActivity(user, 'content_node_retry_requested', '重试内容节点：' + retried.title + ' / ' + body.nodeId);
      return sendJson(response, { ok: true, task: retried }, 200);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (
    requestUrl.pathname.startsWith('/api/content/tasks/') &&
    requestUrl.pathname.includes('/nodes/') &&
    requestUrl.pathname.endsWith('/record') &&
    request.method === 'POST'
  ) {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    const taskPrefix = '/api/content/tasks/';
    const nodeMarker = '/nodes/';
    const pathAfterTask = requestUrl.pathname.slice(taskPrefix.length);
    const nodeOffset = pathAfterTask.indexOf(nodeMarker);
    const taskId = decodeURIComponent(pathAfterTask.slice(0, nodeOffset));
    const nodeId = decodeURIComponent(
      pathAfterTask.slice(nodeOffset + nodeMarker.length, -'/record'.length),
    );
    const task = contentTaskById(taskId, user);
    if (!task) {
      return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    }
    if (task.run.status === 'not_started') {
      return sendJson(response, { ok: false, error: '请先启动内容工作流' }, 409);
    }
    const body = await readRequestBody(request);
    let recorded;
    try {
      recorded = recordContentNode(task, nodeId, body, user);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 400);
    }
    await saveContentTask(recorded, user, 'content_node_recorded', { nodeId, status: recorded.nodes.find((node) => node.id === nodeId)?.status });
    await recordActivity(
      user,
      'content_node_recorded',
      '记录内容节点：' + recorded.title + ' / ' + nodeId,
    );
    return sendJson(response, { ok: true, task: recorded }, 200);
  }

  if (
    requestUrl.pathname.startsWith('/api/content/tasks/') &&
    requestUrl.pathname.endsWith('/review') &&
    request.method === 'POST'
  ) {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    const taskId = decodeURIComponent(
      requestUrl.pathname.slice('/api/content/tasks/'.length, -'/review'.length),
    );
    const task = contentTaskById(taskId, user);
    if (!task) {
      return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    }
    const body = await readRequestBody(request);
    let reviewed;
    try {
      reviewed = addContentReview(task, body, user, {
        reviewId: 'content_review_' + randomUUID(),
      });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 400);
    }
    await saveContentTask(reviewed, user, 'content_review_recorded', { decision: reviewed.reviews.at(-1)?.decision });
    await recordActivity(user, 'content_review_recorded', '记录内容审核：' + reviewed.title);
    return sendJson(response, { ok: true, task: reviewed }, 200);
  }

  if (
    requestUrl.pathname.startsWith('/api/content/tasks/') &&
    requestUrl.pathname.endsWith('/revision') &&
    request.method === 'POST'
  ) {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(
      requestUrl.pathname.slice('/api/content/tasks/'.length, -'/revision'.length),
    );
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    const body = await readRequestBody(request);
    if (typeof body.changes === 'string' && body.changes.length > 5000) {
      return sendJson(response, { ok: false, error: '修改说明不能超过 5000 个字' }, 400);
    }
    if (body.content !== undefined && JSON.stringify(body.content).length > 30_000) {
      return sendJson(response, { ok: false, error: '修改内容不能超过 30000 个字符' }, 400);
    }
    try {
      const revised = applyContentRevision(task, body, user, {
        versionId: 'content_version_' + randomUUID(),
      });
      await saveContentTask(revised, user, 'content_revision_applied', {
        versionId: revised.versions.at(-1)?.id,
      });
      await recordActivity(user, 'content_revision_applied', '应用内容修改：' + revised.title);
      return sendJson(response, { ok: true, task: revised, version: revised.versions.at(-1) }, 200);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && requestUrl.pathname.endsWith('/execute-node') && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(requestUrl.pathname.slice('/api/content/tasks/'.length, -'/execute-node'.length));
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    const body = await readRequestBody(request);
    try {
      const executed = await executeTaskNode(task, body, user);
      await recordActivity(user, 'content_node_executed', '执行内容节点：' + task.title + ' / ' + body.nodeId);
      return sendJson(response, { ok: true, task: executed });
    } catch (error) {
      const status = error.code === 'TRANSCRIPTION_NOT_CONFIGURED' || error.code === 'OCR_NOT_CONFIGURED' ? 503 : 409;
      return sendJson(response, { ok: false, error: safeError(error), code: error.code || 'NODE_EXECUTION_ERROR' }, status);
    }
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && requestUrl.pathname.endsWith('/materials/parse') && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(requestUrl.pathname.slice('/api/content/tasks/'.length, -'/materials/parse'.length));
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    const body = await readRequestBody(request);
    try {
      const result = await parseTaskMaterial(task, body, user);
      await recordActivity(user, 'content_material_parsed', '解析本地素材：' + result.asset.filename);
      return sendJson(response, {
        ok: true,
        task: result.task,
        asset: result.asset,
        document: result.document,
        parse: result.parsed,
      });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error), code: error.code || 'MEDIA_PARSE_ERROR' }, error.code === 'TOOL_UNAVAILABLE' ? 503 : 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && requestUrl.pathname.endsWith('/assets') && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(requestUrl.pathname.slice('/api/content/tasks/'.length, -'/assets'.length));
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    return sendJson(response, { ok: true, assets: workbenchStore.listMediaAssets(user, task.id) });
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && requestUrl.pathname.endsWith('/events') && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(requestUrl.pathname.slice('/api/content/tasks/'.length, -'/events'.length));
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    return sendJson(response, { ok: true, events: workbenchStore.listContentEvents(user, task.id) });
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && requestUrl.pathname.endsWith('/replay') && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(requestUrl.pathname.slice('/api/content/tasks/'.length, -'/replay'.length));
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    const runId = String(requestUrl.searchParams.get('runId') || task.run?.id || '').trim() || null;
    const events = workbenchStore.listContentEvents(user, task.id, runId);
    const latestSnapshot = [...events].reverse().find((event) => event.data?.taskSnapshot)?.data?.taskSnapshot;
    const replay = buildContentRunReplay(latestSnapshot || task, events);
    return sendJson(response, { ok: true, replay });
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && requestUrl.pathname.endsWith('/analyze') && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(requestUrl.pathname.slice('/api/content/tasks/'.length, -'/analyze'.length));
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    try {
      const assets = workbenchStore.listMediaAssets(user, task.id);
      const sourceText = taskText(task, assets);
      if (!sourceText) throw new Error('没有可分析的文本、转写或 OCR 内容');
      const structure = analyzeContentStructure(sourceText);
      const analyzed = await recordReadyTaskNode(task, 'CE-09', {
        status: 'succeeded',
        input: { assetIds: assets.map((asset) => asset.id) },
        output: structure,
        note: '基于当前任务素材和知识索引执行本地结构分析',
      }, user, 'content_structure_analyzed');
      return sendJson(response, { ok: true, task: analyzed, structure });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && requestUrl.pathname.endsWith('/generate') && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(requestUrl.pathname.slice('/api/content/tasks/'.length, -'/generate'.length));
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    const body = await readRequestBody(request);
    try {
      const result = await generateTaskContent(task, body, user);
      await recordActivity(user, 'ai_content_generated', '生成内容草案：' + task.title + ' / ' + body.kind);
      return sendJson(response, { ok: true, task: result.task, output: result.output, knowledge: result.knowledge });
    } catch (error) {
      const status = error.code?.startsWith('AI_PROVIDER_') ? 503 : 409;
      return sendJson(response, { ok: false, error: safeError(error), code: error.code || 'AI_GENERATION_ERROR' }, status);
    }
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && requestUrl.pathname.endsWith('/render') && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(requestUrl.pathname.slice('/api/content/tasks/'.length, -'/render'.length));
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    const body = await readRequestBody(request);
    try {
      connectorForCapability(user, 'media.render', task.tenantId);
      const assets = workbenchStore.listMediaAssets(user, task.id);
      const source = body.assetId ? assets.find((asset) => asset.id === body.assetId) : assets.find((asset) => asset.kind === 'video');
      if (!source || source.kind !== 'video') throw new Error('没有可渲染的视频素材');
      const outputPath = join(RENDER_DIR, safeOutputId(task.id) + '-render.mp4');
      const render = await renderVideo(source.path, outputPath, { allowedRoots: mediaAllowedRoots(), baseDir: DATA_DIR });
      const renderedAsset = workbenchStore.saveMediaAsset({
        id: 'asset_render_' + randomUUID(),
        tenantId: task.tenantId,
        projectId: task.projectId,
        taskId: task.id,
        path: render.path,
        filename: render.filename,
        kind: 'video',
        mimeType: 'video/mp4',
        status: 'rendered',
        metadata: { render, sourceAssetId: source.id },
      }, user);
      const renderedTask = await recordReadyTaskNode(task, 'CE-16', {
        status: 'succeeded',
        input: { sourceAssetId: source.id },
        output: { assetId: renderedAsset.id, ...render },
        note: '使用本地 ffmpeg 完成本地渲染，尚未发布',
      }, user, 'content_render_completed');
      await recordActivity(user, 'content_rendered', '渲染内容：' + task.title);
      return sendJson(response, { ok: true, task: renderedTask, asset: renderedAsset, render });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error), code: error.code || 'MEDIA_RENDER_ERROR' }, error.code === 'TOOL_UNAVAILABLE' ? 503 : 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && requestUrl.pathname.endsWith('/package') && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(requestUrl.pathname.slice('/api/content/tasks/'.length, -'/package'.length));
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    try {
      connectorForCapability(user, 'package.export', task.tenantId);
      const assets = workbenchStore.listMediaAssets(user, task.id);
      const outputPath = join(PACKAGE_DIR, safeOutputId(task.id) + '-content.zip');
      const manifestPath = join(PACKAGE_DIR, safeOutputId(task.id) + '-manifest.json');
      await mkdir(PACKAGE_DIR, { recursive: true });
      await writeFile(manifestPath, JSON.stringify(contentPackageManifest(task, assets), null, 2), 'utf8');
      const files = [...assets.map((asset) => asset.path).filter(Boolean), manifestPath];
      const packaged = await packageFiles(files, outputPath, { baseDir: DATA_DIR });
      const packagedTask = await recordReadyTaskNode(task, 'CE-22', {
        status: 'succeeded',
        input: { assetIds: assets.map((asset) => asset.id) },
        output: { ...packaged, manifest: manifestPath },
        note: '已将素材与选题/脚本/平台版本/分镜/审核/版本信息写入本地交付包，等待人工确认后再进入发布草稿',
      }, user, 'content_package_exported');
      await recordActivity(user, 'content_package_exported', '打包内容：' + task.title);
      return sendJson(response, { ok: true, task: packagedTask, package: { ...packaged, manifest: manifestPath } });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error), code: error.code || 'PACKAGE_ERROR' }, error.code === 'TOOL_UNAVAILABLE' ? 503 : 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && requestUrl.pathname.endsWith('/release-drafts') && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(requestUrl.pathname.slice('/api/content/tasks/'.length, -'/release-drafts'.length));
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    const body = await readRequestBody(request);
    try {
      if (!['ready', 'succeeded'].includes(taskNode(task, 'CE-23').status)) {
        throw new Error('发布草稿节点尚未就绪，请先完成打包和人工审核');
      }
      const draft = workbenchStore.createReleaseDraft({ taskId: task.id, payload: body }, user);
      const nextTask = taskNode(task, 'CE-23').status === 'ready'
        ? await recordReadyTaskNode(task, 'CE-23', {
            status: 'succeeded',
            input: { releaseDraftId: draft.id },
            output: draft,
            note: '已创建发布草稿，执行发布仍需连接器和人工授权',
          }, user, 'release_draft_created')
        : task;
      return sendJson(response, { ok: true, task: nextTask, draft }, 201);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/release-drafts' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    return sendJson(response, { ok: true, drafts: workbenchStore.listReleaseDrafts(user, requestUrl.searchParams.get('taskId')) });
  }

  if (requestUrl.pathname.startsWith('/api/release-drafts/') && requestUrl.pathname.endsWith('/execute') && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const draftId = decodeURIComponent(requestUrl.pathname.slice('/api/release-drafts/'.length, -'/execute'.length));
    try {
      const draft = workbenchStore.getReleaseDraft(user, draftId);
      if (!draft) return sendJson(response, { ok: false, error: '发布草稿不存在' }, 404);
      if (draft.status !== 'approved') return sendJson(response, { ok: false, error: '发布草稿尚未获得管理员批准' }, 409);
      const platform = String(draft.payload?.platform || '').trim();
      const connectors = workbenchStore.seedDefaultConnectors(user);
      const publishConnector = connectors.find((connector) => connector.kind === 'platform' && connector.tenantId === draft.tenantId && connector.status === 'ready' && (!platform || connector.config?.platform === platform));
      if (!publishConnector || !workbenchStore.hasConnectorPermission(user, publishConnector.id, 'publish.execute')) {
        return sendJson(response, { ok: false, error: '发布连接器尚未配置或当前成员没有发布权限；草稿已保留，未执行外部发布', code: 'PUBLISH_CONNECTOR_NOT_CONFIGURED' }, 409);
      }
      return sendJson(response, { ok: false, error: '当前版本尚未实现该平台的真实发布执行器', code: 'PUBLISH_EXECUTOR_NOT_IMPLEMENTED' }, 501);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/release-drafts/') && request.method === 'PATCH') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const draftId = decodeURIComponent(requestUrl.pathname.slice('/api/release-drafts/'.length));
    const body = await readRequestBody(request);
    try {
      const draft = workbenchStore.updateReleaseDraft(user, draftId, body);
      await recordActivity(user, 'release_draft_updated', '更新发布草稿：' + draft.id);
      return sendJson(response, { ok: true, draft });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    const taskId = decodeURIComponent(
      requestUrl.pathname.slice('/api/content/tasks/'.length),
    );
    const task = contentTaskById(taskId, user);
    if (!task) {
      return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    }
    return sendJson(response, {
      ok: true,
      task,
      workflow: {
        version: CONTENT_WORKFLOW_VERSION,
        nodeCount: CONTENT_NODE_CATALOG.length,
        mode: 'local_test',
      },
    });
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && request.method === 'PATCH') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    const taskId = decodeURIComponent(
      requestUrl.pathname.slice('/api/content/tasks/'.length),
    );
    const task = contentTaskById(taskId, user);
    if (!task) {
      return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    }
    const body = await readRequestBody(request);
    let updated;
    try {
      updated = updateContentTask(task, body, user);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
    await saveContentTask(updated, user, 'content_task_updated', { title: updated.title });
    await recordActivity(user, 'content_task_updated', '更新内容任务：' + updated.title);
    return sendJson(response, { ok: true, task: updated }, 200);
  }

  if (requestUrl.pathname === '/api/refresh' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    if (appState.refreshInProgress) {
      return sendJson(response, { ok: false, error: '刷新进行中，请稍后再试' }, 409);
    }
    const summary = await refreshAll(user, { browser: true });
    return sendJson(response, { ok: true, summary, state: publicState(user) });
  }

  if (requestUrl.pathname === '/api/accounts' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    const body = await readRequestBody(request);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const group = typeof body.group === 'string' ? body.group.trim() : '';
    const sourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
    if (!name || !sourceUrl) {
      return sendJson(response, { ok: false, error: '账号名称和主页链接不能为空' }, 400);
    }

    let normalized;
    try {
      normalized = normalizeSource(sourceUrl);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 400);
    }

    const duplicate = appState.accounts.find(
      (account) =>
        (user.role === 'admin' || account.tenantId === user.tenantId) &&
        (account.sourceUrl === normalized.sourceUrl ||
          (normalized.userId &&
            account.platform === normalized.platform &&
            account.userId === normalized.userId)),
    );
    if (duplicate) {
      return sendJson(response, { ok: false, error: '这个账号已经在监控列表中' }, 409);
    }

    const account = normalizeAccount({
      name,
      group,
      sourceUrl: normalized.sourceUrl,
      platform: normalized.platform,
      tenantId: user.tenantId,
      createdAt: nowIso(),
      createdBy: user.username,
    });
    appState.accounts.push(account);
    await persist();
    await recordActivity(user, 'account_added', '加入监控账号：' + name);
    return sendJson(response, { ok: true, account }, 201);
  }

  if (
    requestUrl.pathname.startsWith('/api/accounts/') &&
    request.method === 'PATCH'
  ) {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }

    const accountId = decodeURIComponent(
      requestUrl.pathname.slice('/api/accounts/'.length),
    );
    const account = accountById(accountId, user);
    if (!account) {
      return sendJson(response, { ok: false, error: '监控账号不存在' }, 404);
    }

    const body = await readRequestBody(request);
    if (!Object.prototype.hasOwnProperty.call(body, 'group')) {
      return sendJson(response, { ok: false, error: '账号分组不能为空' }, 400);
    }
    const previousGroup = account.group;
    account.group = normalizeAccountGroup(body.group);
    await persist();
    if (previousGroup !== account.group) {
      await recordActivity(
        user,
        'account_group_updated',
        '调整账号分组：' + account.name + '（' + previousGroup + ' → ' + account.group + '）',
      );
    }
    return sendJson(response, { ok: true, account });
  }

  if (
    requestUrl.pathname.startsWith('/api/accounts/') &&
    requestUrl.pathname.endsWith('/seen') &&
    request.method === 'POST'
  ) {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }

    const accountId = decodeURIComponent(
      requestUrl.pathname.slice(
        '/api/accounts/'.length,
        -'/seen'.length,
      ),
    );
    const account = accountById(accountId, user);
    if (!account) {
      return sendJson(response, { ok: false, error: '监控账号不存在' }, 404);
    }

    const accountWorks = appState.works.filter((work) => work.accountId === accountId);
    const unreadWorks = accountWorks.filter((work) => !work.seen);
    if (unreadWorks.length) {
      unreadWorks.forEach((work) => {
        work.seen = true;
      });
      await persist();
      await recordActivity(
        user,
        'account_seen',
        '查看账号并标记已读：' + account.name + '，共 ' + unreadWorks.length + ' 条作品',
      );
    }
    return sendJson(response, {
      ok: true,
      accountId,
      markedCount: unreadWorks.length,
    });
  }

  if (
    requestUrl.pathname.startsWith('/api/accounts/') &&
    requestUrl.pathname.endsWith('/browser-refresh') &&
    request.method === 'POST'
  ) {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    if (appState.refreshInProgress || refreshPromise) {
      return sendJson(response, { ok: false, error: '刷新进行中，请稍后再补采账号' }, 409);
    }
    if (typeof globalThis.__CLOUD_WORKER_BROWSER_SESSION__?.collectProfile !== 'function') {
      return sendJson(
        response,
        { ok: false, error: '浏览器补采仅在桌面客户端可用，请打开桌面版后重试' },
        409,
      );
    }

    const accountId = decodeURIComponent(
      requestUrl.pathname.slice('/api/accounts/'.length, -'/browser-refresh'.length),
    );
    const account = accountById(accountId, user);
    if (!account) {
      return sendJson(response, { ok: false, error: '监控账号不存在' }, 404);
    }

    appState.refreshInProgress = true;
    try {
      const result = await refreshOne(account, { browser: true });
      await persist();
      await recordActivity(
        user,
        'browser_refresh',
        '浏览器补采账号：' +
          account.name +
          (result.ok
            ? '，读取 ' +
              result.parsedCount +
              ' 条作品' +
              (result.removedStaleWorks ? '，清理 ' + result.removedStaleWorks + ' 条异常链接' : '')
          : '，失败：' + result.error),
      );
      appState.refreshInProgress = false;
      return sendJson(response, { ok: result.ok, result, state: publicState(user) }, result.ok ? 200 : 422);
    } finally {
      appState.refreshInProgress = false;
    }
  }

  if (requestUrl.pathname.startsWith('/api/accounts/') && request.method === 'DELETE') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    if (appState.refreshInProgress) {
      return sendJson(response, { ok: false, error: '刷新进行中，请稍后再删除账号' }, 409);
    }

    const accountId = decodeURIComponent(
      requestUrl.pathname.slice('/api/accounts/'.length),
    );
    const accountIndex = appState.accounts.findIndex((account) => account.id === accountId && (user.role === 'admin' || account.tenantId === user.tenantId));
    if (accountIndex < 0) {
      return sendJson(response, { ok: false, error: '监控账号不存在' }, 404);
    }

    const [account] = appState.accounts.splice(accountIndex, 1);
    const removedWorks = appState.works.filter(
      (work) => work.accountId === account.id,
    ).length;
    appState.works = appState.works.filter((work) => work.accountId !== account.id);
    await persist();
    await recordActivity(
      user,
      'account_removed',
      '移除监控账号：' + account.name + '，同时删除 ' + removedWorks + ' 条已抓取作品',
    );
    return sendJson(response, {
      ok: true,
      account,
      removedWorks,
    });
  }

  if (requestUrl.pathname === '/api/works/seen' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    const body = await readRequestBody(request);
    const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : '';
    const work = appState.works.find((item) => item.fingerprint === fingerprint && (user.role === 'admin' || item.tenantId === user.tenantId));
    if (!work) {
      return sendJson(response, { ok: false, error: '作品不存在' }, 404);
    }
    work.seen = true;
    await persist();
    await recordActivity(user, 'work_seen', '标记作品已读：' + work.title.slice(0, 70));
    return sendJson(response, { ok: true });
  }

  if (requestUrl.pathname === '/api/feedback' && request.method === 'GET') {
    const user = adminUser(request, response);
    if (!user) {
      return null;
    }
    return sendJson(response, {
      ok: true,
      feedback: appState.feedback.slice(0, 100),
    });
  }

  if (requestUrl.pathname === '/api/feedback' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    const body = await readRequestBody(request);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const category =
      typeof body.category === 'string' &&
      ['bug', 'feature', 'content', 'other'].includes(body.category)
        ? body.category
        : 'other';
    if (message.length < 2 || message.length > 2000) {
      return sendJson(response, { ok: false, error: '反馈内容请控制在 2 到 2000 字' }, 400);
    }

    const feedback = {
      id: 'feedback_' + randomUUID(),
      tenantId: user.tenantId,
      category,
      message,
      state: 'open',
      createdAt: nowIso(),
      createdBy: user.username,
      createdByName: user.displayName,
    };
    appState.feedback.unshift(feedback);
    appState.feedback = appState.feedback.slice(0, 200);
    await persist();
    await recordActivity(user, 'feedback', '提交反馈：' + message.replace(/\s+/g, ' ').slice(0, 80));
    return sendJson(response, { ok: true, feedback });
  }

  if (requestUrl.pathname === '/api/activity' && request.method === 'GET') {
    const user = adminUser(request, response);
    if (!user) {
      return null;
    }
    return sendJson(response, {
      ok: true,
      activity: appState.activity.slice(0, 100),
    });
  }

  if (request.method === 'GET') {
    return serveStatic(requestUrl, response);
  }

  return sendJson(response, { ok: false, error: '接口不存在' }, 404);
}

async function start() {
  await ensureData();
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error('[request-error]', error);
      if (!response.headersSent) {
        sendJson(response, { ok: false, error: safeError(error) }, 500);
      } else {
        response.end();
      }
    });
  });

  server.listen(SERVER_PORT, SERVER_HOST, () => {
    console.log(
      '云员工媒体已启动：http://' + SERVER_HOST + ':' + SERVER_PORT,
    );
    console.log('监控账号：' + appState.accounts.length + ' 个；首次刷新可能需要几十秒');
    if (DEMO_MODE) {
      console.log('监控演示模式：使用 config/monitoring.demo.json，已跳过真实平台刷新');
      return;
    }
    if (SERVER_REFRESH_MINUTES > 0) {
      console.log('服务端自动刷新：每 ' + SERVER_REFRESH_MINUTES + ' 分钟');
      const refreshTimer = setInterval(() => {
        refreshAll({ username: 'system', role: 'admin', displayName: '系统', tenantId: 'tenant_local' }, { browser: false }).catch((error) => {
          console.error('[scheduled-refresh-error]', safeError(error));
        });
      }, SERVER_REFRESH_MINUTES * 60 * 1000);
      refreshTimer.unref();
    }
    refreshAll({ username: 'system', role: 'admin', displayName: '系统', tenantId: 'tenant_local' }, { browser: false }).catch((error) => {
      console.error('[startup-refresh-error]', safeError(error));
    });
  });
}

start().catch((error) => {
  console.error('[startup-error]', error);
  process.exitCode = 1;
});
