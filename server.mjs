import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  recordContentFeedback,
  retryContentNode,
  resumeContentTask,
  selectContentTopic,
  startContentTask,
  updateContentTask,
} from './src/content-workflow.mjs';
import {
  buildBatchPlan,
  createContentBatch,
  summarizeBatch,
  transitionContentBatch,
  transitionContentBatchItem,
} from './src/digital-human-domain.mjs';
import { ContentBatchRunner, FakeMediaGenerationConnector } from './src/content-batch-runner.mjs';
import { ContentBatchStore } from './src/content-batch-store.mjs';
import { buildContentBatchAudit } from './src/content-batch-audit.mjs';
import { createHttpMediaGenerationConnector } from './src/content-media-worker-connector.mjs';
import { voiceComparisonTestSet } from './src/voice-comparison-fixtures.mjs';
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
  probeMediaFile,
  renderCover,
  renderVideo,
  resolveLocalMediaPath,
  segmentsToAss,
  summarizeTranscriptConfidence,
  runtimeCapabilities,
  segmentsToSrt,
  transcribeMediaAsset,
} from './src/media-pipeline.mjs';
import { WorkbenchStore } from './src/workbench-store.mjs';
import {
  detectDownloadSource,
  downloadPlatformCatalog,
  isAllowedMediaUrl,
  normalizeDownloadMedia,
  resolveDownloadMedia,
  safeText as safeDownloadText,
} from './src/download-center.mjs';

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
const DOWNLOAD_TASKS_FILE = join(DATA_DIR, 'download-tasks.json');
const PREVIEW_DIR = join(DATA_DIR, 'content-previews');
const RENDER_DIR = join(DATA_DIR, 'content-renders');
const COVER_DIR = join(DATA_DIR, 'content-covers');
const PACKAGE_DIR = join(DATA_DIR, 'content-packages');
const SUBTITLE_DIR = join(DATA_DIR, 'content-subtitles');
const DOWNLOAD_DIR = resolve(
  process.env.XHS_DOWNLOAD_DIR || join(homedir(), 'Downloads', '云员工工作台', '下载中心'),
);
const SEED_FILE = join(CONFIG_DIR, 'accounts.seed.json');
const DEMO_FILE = join(CONFIG_DIR, 'monitoring.demo.json');
const SERVER_HOST = process.env.XHS_MONITOR_HOST || '127.0.0.1';
const SERVER_PORT = Number(process.env.XHS_MONITOR_PORT || 3188);
const SERVER_REFRESH_MINUTES = Number(process.env.XHS_REFRESH_MINUTES || 0);
const CONTENT_BATCH_MAX_CONCURRENCY = Number.isInteger(Number(process.env.XHS_CONTENT_BATCH_MAX_CONCURRENCY)) && Number(process.env.XHS_CONTENT_BATCH_MAX_CONCURRENCY) > 0
  ? Number(process.env.XHS_CONTENT_BATCH_MAX_CONCURRENCY)
  : 1;
const DEMO_MODE = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.XHS_MONITOR_DEMO || '').trim().toLowerCase(),
);
const DOWNLOAD_ASSET_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD_MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_MAX_IMAGE_BYTES = 32 * 1024 * 1024;

const appState = {
  accounts: [],
  works: [],
  activity: [],
  feedback: [],
  downloadTasks: [],
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
let contentBatchStore = null;
let contentBatchRunner = null;
let contentMediaWorkerConnector = null;
// ponytail: keep short-lived resolved media in memory; move to a bounded job store only if concurrent use requires it.
const downloadAssets = new Map();
const downloadRuns = new Map();

function nowIso() {
  return new Date().toISOString();
}

function actorSnapshot(actor) {
  return {
    username: actor?.username || 'system',
    displayName: actor?.displayName || '系统',
  };
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
  if (Array.isArray(savedAccounts)) {
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
  const savedDownloadTasks = await readJson(DOWNLOAD_TASKS_FILE, []);
  appState.downloadTasks = Array.isArray(savedDownloadTasks)
    ? savedDownloadTasks.map(normalizeDownloadTask).filter(Boolean)
    : [];
  workbenchStore.seedDefaultConnectors(migrationActor);
  contentBatchStore = new ContentBatchStore(workbenchStore);
  contentBatchStore.ensureSchema();
  const simulationConnector = contentBatchStore.ensureSimulationConnector(migrationActor, defaultProject.id);
  contentBatchStore.ensureDefaultTemplate(migrationActor, defaultProject.id);
  contentMediaWorkerConnector = createHttpMediaGenerationConnector({
    id: String(process.env.XHS_MEDIA_WORKER_ID || 'connector_media_worker').trim(),
    url: String(process.env.XHS_MEDIA_WORKER_URL || '').trim(),
    name: String(process.env.XHS_MEDIA_WORKER_NAME || '外部媒体模型 Worker').trim(),
    timeoutMs: Number(process.env.XHS_MEDIA_WORKER_TIMEOUT_MS || 15_000),
  });
  if (contentMediaWorkerConnector) await contentMediaWorkerConnector.health();
  contentBatchRunner = new ContentBatchRunner({
    store: contentBatchStore,
    connectors: [
      new FakeMediaGenerationConnector({ id: simulationConnector.id }),
      ...(contentMediaWorkerConnector ? [contentMediaWorkerConnector] : []),
    ],
    maxConcurrency: CONTENT_BATCH_MAX_CONCURRENCY,
  });
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
    downloadCenter: {
      taskCount: visibleDownloadTasks(user).length,
      activeTaskCount: visibleDownloadTasks(user).filter(
        (task) => ['resolved', 'downloading', 'partial_failed'].includes(task.status),
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

function normalizeDownloadFile(file, kind, index = null) {
  const statuses = new Set(['available', 'queued', 'downloading', 'completed', 'failed', 'unavailable']);
  return {
    kind,
    ...(index === null ? {} : { index }),
    status: statuses.has(file?.status) ? file.status : 'available',
    filename: typeof file?.filename === 'string' ? file.filename : null,
    localFilePath: typeof file?.localFilePath === 'string' ? file.localFilePath : null,
    bytes: Number.isFinite(Number(file?.bytes)) ? Number(file.bytes) : null,
    error: typeof file?.error === 'string' ? file.error : null,
  };
}

function normalizeDownloadTask(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) {
    return null;
  }
  const imageFiles = Array.isArray(raw.files?.images)
    ? raw.files.images.map((file, index) => normalizeDownloadFile(file, 'image', index))
    : [];
  const statuses = new Set(['resolved', 'downloading', 'completed', 'partial_failed', 'failed', 'expired']);
  return {
    id: raw.id,
    tenantId: raw.tenantId || 'tenant_local',
    platform: raw.platform || 'other',
    platformLabel: raw.platformLabel || raw.platform || '其他平台',
    sourceUrl: raw.sourceUrl || '',
    canonicalUrl: raw.canonicalUrl || raw.sourceUrl || '',
    contentId: raw.contentId || null,
    title: safeDownloadText(raw.title, '未命名作品'),
    author: safeDownloadText(raw.author, '作者未提供', 80),
    status: statuses.has(raw.status) ? raw.status : 'resolved',
    createdAt: raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || raw.createdAt || nowIso(),
    expiresAt: raw.expiresAt || null,
    error: typeof raw.error === 'string' ? raw.error : null,
    files: {
      video: normalizeDownloadFile(raw.files?.video, 'video'),
      cover: normalizeDownloadFile(raw.files?.cover, 'cover'),
      images: imageFiles,
    },
  };
}

function downloadTaskFor(taskId, user = null) {
  const task = appState.downloadTasks.find((item) => item.id === taskId) || null;
  if (!task || !user || user.role === 'admin' || task.tenantId === user.tenantId) {
    return task;
  }
  return null;
}

function visibleDownloadTasks(user) {
  return appState.downloadTasks.filter((task) => downloadTaskFor(task.id, user));
}

function downloadAssetFor(taskId) {
  const asset = downloadAssets.get(taskId);
  if (!asset || asset.expiresAt <= Date.now()) {
    downloadAssets.delete(taskId);
    return null;
  }
  return asset;
}

function downloadApiBase(taskId) {
  return '/api/download-center/tasks/' + encodeURIComponent(taskId);
}

function publicDownloadFile(file) {
  const { localFilePath, ...safe } = file || {};
  return safe;
}

function publicDownloadTask(task) {
  const asset = downloadAssetFor(task.id);
  const publicFiles = {
    video: publicDownloadFile(task.files.video),
    cover: publicDownloadFile(task.files.cover),
    images: task.files.images.map(publicDownloadFile),
  };
  const base = downloadApiBase(task.id);
  return {
    id: task.id,
    platform: task.platform,
    platformLabel: task.platformLabel,
    sourceUrl: task.sourceUrl,
    canonicalUrl: task.canonicalUrl,
    contentId: task.contentId,
    title: task.title,
    author: task.author,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expiresAt: task.expiresAt,
    error: task.error,
    files: publicFiles,
    available: {
      video: Boolean(asset?.media?.videoUrl),
      cover: Boolean(asset?.media?.coverUrl),
      images: Array.isArray(asset?.media?.imageUrls) ? asset.media.imageUrls.length : publicFiles.images.length,
    },
    previewUrls: {
      video: asset?.media?.videoUrl ? base + '/media?kind=video' : null,
      cover: asset?.media?.coverUrl ? base + '/media?kind=cover' : null,
    },
    fileUrls: {
      video: publicFiles.video.status === 'completed' ? base + '/file?kind=video' : null,
      cover: publicFiles.cover.status === 'completed' ? base + '/file?kind=cover' : null,
    },
  };
}

function downloadFileFor(task, kind, index = null) {
  if (kind === 'video') return task.files.video;
  if (kind === 'cover') return task.files.cover;
  if (kind === 'image' && Number.isInteger(index)) return task.files.images[index] || null;
  return null;
}

function downloadTargets(task, kind, index = null) {
  if (kind === 'video' || kind === 'cover') {
    const file = downloadFileFor(task, kind);
    return file?.status === 'unavailable' ? [] : [{ kind, index: null, file }];
  }
  if (kind === 'image' && Number.isInteger(index)) {
    const file = downloadFileFor(task, kind, index);
    return file?.status === 'unavailable' ? [] : [{ kind, index, file }];
  }
  if (kind === 'images') {
    return task.files.images
      .map((file, imageIndex) => ({ kind: 'image', index: imageIndex, file }))
      .filter(({ file }) => file.status !== 'unavailable');
  }
  return [];
}

function deriveDownloadStatus(task) {
  const files = [task.files.video, task.files.cover, ...task.files.images]
    .filter((file) => file.status !== 'unavailable');
  if (!files.length) return 'resolved';
  if (files.some((file) => ['queued', 'downloading'].includes(file.status))) return 'downloading';
  if (files.some((file) => file.status === 'failed')) {
    return files.some((file) => file.status === 'completed') ? 'partial_failed' : 'failed';
  }
  return files.some((file) => file.status === 'completed') ? 'completed' : 'resolved';
}

function fileExtension(kind, contentType, sourceUrl) {
  const type = String(contentType || '').split(';')[0].toLowerCase();
  const byType = {
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
  };
  if (byType[type]) return byType[type];
  try {
    const extension = extname(new URL(sourceUrl).pathname).toLowerCase();
    if (kind === 'video' && ['.mp4', '.mov', '.m4v', '.webm'].includes(extension)) return extension;
    if (kind !== 'video' && ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extension)) return extension === '.jpeg' ? '.jpg' : extension;
  } catch {
    // The URL was already validated before this helper is called.
  }
  return kind === 'video' ? '.mp4' : '.jpg';
}

function downloadFilename(task, kind, index, contentType, sourceUrl) {
  const title = safeDownloadText(task.title, '未命名作品', 80)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim() || '未命名作品';
  const suffix = kind === 'video' ? '视频' : kind === 'cover' ? '封面' : '图片-' + String(index + 1).padStart(2, '0');
  return title + '-' + suffix + '-' + task.id.slice(-8) + fileExtension(kind, contentType, sourceUrl);
}

async function persistDownloadTasks() {
  await writeJson(DOWNLOAD_TASKS_FILE, appState.downloadTasks);
}

async function createDownloadTask(source, media, user) {
  const now = nowIso();
  const task = {
    id: 'download_' + randomUUID(),
    tenantId: user?.tenantId || 'tenant_local',
    platform: source.platform,
    platformLabel: source.platformLabel,
    sourceUrl: source.sourceUrl,
    canonicalUrl: source.canonicalUrl,
    contentId: source.contentId || null,
    title: media.title,
    author: media.author,
    status: 'resolved',
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + DOWNLOAD_ASSET_TTL_MS).toISOString(),
    error: null,
    files: {
      video: normalizeDownloadFile({ status: media.videoUrl ? 'available' : 'unavailable' }, 'video'),
      cover: normalizeDownloadFile({ status: media.coverUrl ? 'available' : 'unavailable' }, 'cover'),
      images: (media.imageUrls || []).map((_url, index) => normalizeDownloadFile({ status: 'available' }, 'image', index)),
    },
  };
  appState.downloadTasks.unshift(task);
  appState.downloadTasks = appState.downloadTasks.slice(0, 100);
  downloadAssets.set(task.id, {
    expiresAt: Date.now() + DOWNLOAD_ASSET_TTL_MS,
    media,
  });
  await persistDownloadTasks();
  return task;
}

function mediaSourceFor(asset, platform, kind, index = null) {
  const media = asset?.media;
  if (kind === 'video') return media?.videoUrl || null;
  if (kind === 'cover') return media?.coverUrl || null;
  if (kind === 'image' && Number.isInteger(index)) return media?.imageUrls?.[index] || null;
  return null;
}

async function fetchRemoteMedia(sourceUrl, platform, kind, limit) {
  if (!isAllowedMediaUrl(sourceUrl, platform, kind === 'video' ? 'video' : 'cover')) {
    throw new Error('媒体地址不在平台白名单内');
  }
  let upstream;
  try {
    upstream = await fetch(sourceUrl, {
      redirect: 'follow',
      headers: { accept: kind === 'video' ? 'video/*' : 'image/*', 'user-agent': 'CloudWorkerDownloadCenter/0.1' },
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    throw new Error('媒体文件暂时无法访问：' + safeError(error));
  }
  if (!upstream.ok || !upstream.body) {
    throw new Error('媒体文件返回失败（HTTP ' + upstream.status + '）');
  }
  const finalUrl = upstream.url || sourceUrl;
  if (!isAllowedMediaUrl(finalUrl, platform, kind === 'video' ? 'video' : 'cover')) {
    throw new Error('媒体文件跳转到了不受支持的地址');
  }
  const contentType = upstream.headers.get('content-type') || '';
  const contentLength = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new Error('媒体文件超过下载大小限制');
  }
  if (kind === 'video' && contentType && !/^video\//i.test(contentType) && !/octet-stream/i.test(contentType)) {
    throw new Error('上游返回的不是视频文件');
  }
  if (kind !== 'video' && contentType && !/^image\//i.test(contentType) && !/octet-stream/i.test(contentType)) {
    throw new Error('上游返回的不是图片文件');
  }
  return { body: upstream.body, contentType, finalUrl };
}

function sizeLimiter(limit) {
  let bytes = 0;
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) {
        callback(new Error('媒体文件超过下载大小限制'));
        return;
      }
      callback(null, chunk, encoding);
    },
  });
  return { stream, getBytes: () => bytes };
}

async function runDownloadTarget(taskId, user, target) {
  const task = downloadTaskFor(taskId, user);
  if (!task) return;
  const asset = downloadAssetFor(taskId);
  const file = target.file;
  const sourceUrl = mediaSourceFor(asset, task.platform, target.kind, target.index);
  if (!asset || !sourceUrl || !file) {
    if (file) file.status = 'unavailable';
    task.status = 'expired';
    task.error = '解析资源已过期，请重新粘贴链接';
    task.updatedAt = nowIso();
    await persistDownloadTasks();
    return;
  }
  file.status = 'downloading';
  file.error = null;
  task.status = 'downloading';
  task.error = null;
  task.updatedAt = nowIso();
  await persistDownloadTasks();
  let tempPath = null;
  try {
    const limit = target.kind === 'video' ? DOWNLOAD_MAX_VIDEO_BYTES : DOWNLOAD_MAX_IMAGE_BYTES;
    const remote = await fetchRemoteMedia(sourceUrl, task.platform, target.kind, limit);
    await mkdir(DOWNLOAD_DIR, { recursive: true });
    const filename = downloadFilename(task, target.kind, target.index ?? 0, remote.contentType, remote.finalUrl);
    const destination = join(DOWNLOAD_DIR, filename);
    tempPath = destination + '.part-' + randomUUID();
    const limited = sizeLimiter(limit);
    await pipeline(Readable.fromWeb(remote.body), limited.stream, createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
    await rename(tempPath, destination);
    tempPath = null;
    file.status = 'completed';
    file.filename = filename;
    file.localFilePath = destination;
    file.bytes = limited.getBytes();
    task.status = deriveDownloadStatus(task);
    task.updatedAt = nowIso();
    await persistDownloadTasks();
    await recordActivity(user, 'download_completed', '下载完成：' + task.title + ' / ' + filename);
  } catch (error) {
    if (tempPath) await rm(tempPath, { force: true }).catch(() => {});
    file.status = 'failed';
    file.error = safeError(error);
    task.status = deriveDownloadStatus(task);
    task.updatedAt = nowIso();
    task.error = file.error;
    await persistDownloadTasks();
  }
}

async function queueDownload(task, user, kind, index = null) {
  const asset = downloadAssetFor(task.id);
  if (!asset) {
    task.status = 'expired';
    task.error = '解析资源已过期，请重新粘贴链接';
    task.updatedAt = nowIso();
    await persistDownloadTasks();
    const error = new Error(task.error);
    error.code = 'DOWNLOAD_ASSET_EXPIRED';
    throw error;
  }
  const targets = downloadTargets(task, kind, index);
  if (!targets.length) {
    const error = new Error('这条作品没有可下载的' + (kind === 'cover' ? '封面' : kind === 'video' ? '视频' : '图片'));
    error.code = 'DOWNLOAD_ASSET_NOT_FOUND';
    throw error;
  }
  targets.forEach(({ file }) => {
    if (!['completed', 'downloading'].includes(file.status)) {
      file.status = 'queued';
      file.error = null;
    }
  });
  task.status = 'downloading';
  task.error = null;
  task.updatedAt = nowIso();
  await persistDownloadTasks();
  for (const target of targets) {
    const key = task.id + ':' + target.kind + ':' + (target.index ?? '');
    if (downloadRuns.has(key) || target.file.status === 'completed') continue;
    const promise = runDownloadTarget(task.id, user, target);
    downloadRuns.set(key, promise);
    promise.finally(() => downloadRuns.delete(key)).catch(() => {});
  }
  return task;
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
    writeJson(DOWNLOAD_TASKS_FILE, appState.downloadTasks),
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

function contentBatchById(batchId, user) {
  return contentBatchStore?.getBatch(user, batchId) || null;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))];
}

function contentBatchMetrics(batch, modelRuns = []) {
  const summary = summarizeBatch(batch);
  const durations = modelRuns
    .map((run) => Number(run.durationMs))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  const queueDurations = modelRuns
    .map((run) => {
      const direct = Number(run.queueDurationMs);
      if (Number.isFinite(direct) && direct >= 0) return direct;
      const queued = Date.parse(run.queuedAt || '');
      const started = Date.parse(run.startedAt || '');
      return Number.isFinite(queued) && Number.isFinite(started) && started >= queued ? started - queued : null;
    })
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  const costByItem = {};
  const currencies = new Set();
  for (const run of modelRuns) {
    const source = run.output?.cost || run.cost;
    const amount = Number(source?.amount);
    const currency = typeof source?.currency === 'string' ? source.currency.trim() : '';
    if (!Number.isFinite(amount) || amount < 0 || !currency) continue;
    costByItem[run.itemId] = (costByItem[run.itemId] || 0) + amount;
    currencies.add(currency);
  }
  for (const item of batch.items || []) {
    if (costByItem[item.id] !== undefined) continue;
    const amount = Number(item.output?.cost?.amount);
    const currency = typeof item.output?.cost?.currency === 'string' ? item.output.cost.currency.trim() : '';
    if (!Number.isFinite(amount) || amount < 0 || !currency) continue;
    costByItem[item.id] = amount;
    currencies.add(currency);
  }
  const events = modelRuns.flatMap((run) => {
    const started = Date.parse(run.startedAt || '');
    const completed = Date.parse(run.completedAt || '');
    return Number.isFinite(started) && Number.isFinite(completed) && completed >= started
      ? [{ time: started, delta: 1 }, { time: completed, delta: -1 }]
      : [];
  }).sort((left, right) => left.time - right.time || left.delta - right.delta);
  let active = 0;
  let observedConcurrency = modelRuns.reduce((max, run) => Math.max(max, Number(run.activeConcurrency) || 0), 0);
  if (!observedConcurrency) {
    for (const event of events) {
      active += event.delta;
      observedConcurrency = Math.max(observedConcurrency, active);
    }
  }
  const startedAt = modelRuns.map((run) => Date.parse(run.startedAt || '')).filter(Number.isFinite).sort((left, right) => left - right)[0] || null;
  const completedAt = modelRuns.map((run) => Date.parse(run.completedAt || '')).filter(Number.isFinite).sort((left, right) => right - left)[0] || null;
  return {
    itemCount: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    blocked: summary.blocked,
    cancelled: summary.cancelled,
    concurrencyLimit: modelRuns.reduce((max, run) => Math.max(max, Number(run.concurrencyLimit) || 0), 0) || 1,
    observedConcurrency,
    durationP50Ms: percentile(durations, 0.5),
    durationP95Ms: percentile(durations, 0.95),
    queueDurationP50Ms: percentile(queueDurations, 0.5),
    queueDurationP95Ms: percentile(queueDurations, 0.95),
    generationDurationP50Ms: percentile(durations, 0.5),
    generationDurationP95Ms: percentile(durations, 0.95),
    retryCount: Math.max(0, modelRuns.length - new Set(modelRuns.map((run) => run.itemId)).size),
    cost: {
      currency: currencies.size === 1 ? [...currencies][0] : currencies.size ? 'mixed' : null,
      totalAmount: Object.values(costByItem).reduce((total, amount) => total + amount, 0),
      perItem: costByItem,
      missingCount: (batch.items || []).filter((item) => costByItem[item.id] === undefined).length,
    },
    elapsedMs: startedAt !== null && completedAt !== null ? Math.max(0, completedAt - startedAt) : null,
  };
}

function contentBatchResponse(batch, user) {
  const modelRuns = contentBatchStore.listModelRuns(user, batch.id);
  const qualityReports = contentBatchStore.listQualityReports(user, batch.id);
  return {
    ...batch,
    summary: summarizeBatch(batch),
    modelRuns,
    qualityReports,
    metrics: contentBatchMetrics(batch, modelRuns),
    audit: buildContentBatchAudit(batch, modelRuns, qualityReports),
    auditRecord: batch.audit || null,
  };
}

function recordContentBatchAudit(batch, user, body = {}) {
  const previous = batch.audit || {};
  const samplingInput = body.sampling && typeof body.sampling === 'object' ? body.sampling : {};
  const ratio = samplingInput.ratio === undefined ? previous.sampling?.ratio : Number(samplingInput.ratio);
  if (ratio !== null && ratio !== undefined && (!Number.isFinite(ratio) || ratio < 0 || ratio > 1)) {
    throw new Error('抽样比例必须在 0 到 1 之间');
  }
  const itemIds = samplingInput.itemIds === undefined ? previous.sampling?.itemIds || [] : samplingInput.itemIds;
  if (!Array.isArray(itemIds) || new Set(itemIds).size !== itemIds.length || itemIds.some((id) => !batch.items.some((item) => item.id === id))) {
    throw new Error('抽样条目必须来自当前批次且不能重复');
  }
  const expanded = samplingInput.expanded === undefined ? previous.sampling?.expanded === true : samplingInput.expanded === true;
  const expandedReason = String(samplingInput.expandedReason ?? previous.sampling?.expandedReason ?? '').trim();
  if (expanded && !expandedReason) throw new Error('扩大审查时必须填写原因');
  const reviewInput = body.humanReview && typeof body.humanReview === 'object' ? body.humanReview : {};
  const durationMs = reviewInput.durationMs === undefined ? previous.humanReview?.durationMs : Number(reviewInput.durationMs);
  if (durationMs !== null && durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs < 0)) {
    throw new Error('人工审核时长必须是非负数字');
  }
  const ownerDecision = body.ownerDecision === undefined ? previous.ownerDecision || 'pending' : String(body.ownerDecision).trim();
  if (!['pending', 'accepted', 'optimize', 'blocked'].includes(ownerDecision)) throw new Error('负责人结论不正确');
  const timestamp = nowIso();
  const updated = {
    ...batch,
    audit: {
      version: 'content-batch-audit-v1',
      sampling: {
        ratio: ratio ?? null,
        itemIds: [...itemIds],
        expanded,
        expandedReason: expanded ? expandedReason : null,
      },
      humanReview: {
        durationMs: durationMs ?? null,
        notes: String(reviewInput.notes ?? previous.humanReview?.notes ?? '').trim().slice(0, 2000),
      },
      ownerDecision,
      recordedBy: { username: user.username, displayName: user.displayName },
      recordedAt: timestamp,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  };
  contentBatchStore.saveBatch(user, updated);
  return updated;
}

function contentBatchCatalogFor(user, projectId, taskId = null) {
  const catalog = contentBatchStore.listCatalog(user, projectId, taskId);
  if (contentMediaWorkerConnector && !catalog.connectors.some((item) => item.id === contentMediaWorkerConnector.id)) {
    catalog.connectors = [
      ...catalog.connectors,
      contentMediaWorkerConnector.descriptor(catalog.project?.tenantId || user?.tenantId || 'tenant_local'),
    ];
  }
  return catalog;
}

function batchPlanFor(user, body = {}) {
  if (!contentBatchStore) throw new Error('批量生产存储尚未就绪');
  const task = contentTaskById(String(body.taskId || ''), user);
  if (!task) throw new Error('内容任务不存在');
  if (body.projectId && body.projectId !== task.projectId) throw new Error('批次项目必须和内容任务一致');
  const catalog = contentBatchCatalogFor(user, task.projectId, task.id);
  const plan = buildBatchPlan({
    ...body,
    avatars: catalog.avatars,
    voices: catalog.voices,
    scripts: catalog.scripts,
    templates: catalog.templates,
    connectors: catalog.connectors,
  });
  return { task, catalog, plan };
}

async function runContentBatch(user, batch) {
  const catalog = contentBatchCatalogFor(user, batch.projectId, batch.taskId);
  const connector = catalog.connectors.find((item) => item.id === batch.connectorId);
  const connectors = connector?.config?.mode === 'simulation'
    ? [new FakeMediaGenerationConnector({ id: connector.id })]
    : connector?.config?.mode === 'http-worker' && contentMediaWorkerConnector?.id === connector.id
      ? [normalizedBatchConnector(contentMediaWorkerConnector, async (output) => {
          const task = contentTaskById(batch.taskId, user);
          if (!task) throw mediaInputError('批次关联的内容任务不存在', 'MEDIA_INPUT_NOT_READY');
          if (output?.simulated === true) {
            return {
              ...output,
              assetIds: [],
              mediaChecks: [{ status: 'skipped_simulation', reason: '模拟 Worker 不产生可交付媒体资产' }],
            };
          }
          const assets = await saveWorkerOutputAssets(task, output, output.operation || 'batch_media', user);
          return {
            ...output,
            assetIds: [...new Set([
              ...(Array.isArray(output.assetIds) ? output.assetIds : []),
              ...assets.map((asset) => asset.id),
            ])],
            mediaChecks: assets
              .filter((asset) => ['audio', 'video'].includes(asset.kind))
              .map((asset) => ({ assetId: asset.id, ...asset.metadata.mediaCheck })),
          };
        })]
      : [];
  const runner = new ContentBatchRunner({ store: contentBatchStore, connectors, maxConcurrency: CONTENT_BATCH_MAX_CONCURRENCY });
  return runner.runUntilIdle(user, batch.id);
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

function contentContextAssets(assets = []) {
  return assets.filter((asset) => !(
    asset.kind === 'text'
    && asset.status === 'generated'
    && ['srt', 'ass'].includes(String(asset.metadata?.format || '').toLowerCase())
  ));
}

function taskText(task, assets = []) {
  const readableAssets = contentContextAssets(assets);
  return [
    task.sourceBrief,
    ...readableAssets.flatMap((asset) => [asset.textContent, asset.transcript, asset.ocrText]),
  ].filter((item) => typeof item === 'string' && item.trim()).join('\n\n');
}

function sourceAssetFor(assets = [], kind = null) {
  const candidates = kind ? assets.filter((asset) => asset.kind === kind) : assets;
  return candidates.find((asset) => ['parsed', 'partial'].includes(asset.status)) || candidates[0] || null;
}

function productionAssetFor(assets = [], kind) {
  const candidates = assets.filter((asset) => asset.kind === kind);
  return candidates.find((asset) => ['rendered', 'generated'].includes(asset.status)) || sourceAssetFor(candidates, kind);
}

function taskSourceReferences(assets = [], knowledge = []) {
  const readableAssets = contentContextAssets(assets);
  return [
    ...readableAssets.map((asset) => ({
      type: 'material',
      id: asset.id,
      filename: asset.filename,
      kind: asset.kind,
      transcriptStatus: asset.metadata?.transcriptResult?.status || null,
      ocrStatus: asset.metadata?.ocrResult?.status || null,
      transcriptSegments: asset.metadata?.transcriptResult?.segments || [],
      ocrFrames: (Array.isArray(asset.metadata?.ocrResult?.frames) ? asset.metadata.ocrResult.frames : [])
        .filter((frame) => !frame?.status || frame.status === 'succeeded')
        .map((frame) => {
          const rawTimeSeconds = Number(frame?.timeSeconds);
          const timeSeconds = Number.isFinite(rawTimeSeconds) && rawTimeSeconds >= 0
            ? Number(rawTimeSeconds.toFixed(3))
            : null;
          const frameText = typeof frame?.text === 'string' ? frame.text.trim().slice(0, 2_000) : '';
          const detectionCount = Array.isArray(frame?.items) ? frame.items.length : 0;
          return { timeSeconds, text: frameText, detectionCount };
        })
        .filter((frame) => frame.timeSeconds !== null || frame.text)
        .slice(0, 24),
    })),
    ...knowledge.map((item) => ({
      type: 'knowledge',
      id: item.id,
      title: item.title,
      sourceType: item.sourceType || null,
    })),
  ];
}

function taskSourceSegments(assets = []) {
  return contentContextAssets(assets).flatMap((asset) => (Array.isArray(asset.metadata?.transcriptResult?.segments) ? asset.metadata.transcriptResult.segments : [])
    .map((segment) => {
      const confidence = Number(segment?.confidence);
      return {
        assetId: asset.id,
        filename: asset.filename,
        start: segment.start,
        end: segment.end,
        text: segment.text,
        ...(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? { confidence } : {}),
      };
    })).slice(0, 200);
}

function taskSourceFrames(assets = []) {
  return contentContextAssets(assets).flatMap((asset) => (Array.isArray(asset.metadata?.ocrResult?.frames) ? asset.metadata.ocrResult.frames : [])
    .filter((frame) => !frame?.status || frame.status === 'succeeded')
    .map((frame) => ({
      assetId: asset.id,
      filename: asset.filename,
      timeSeconds: frame.timeSeconds,
      text: frame.text,
      detections: frame.items,
    }))).slice(0, 200);
}

function analyzeTaskStructure(task, assets = []) {
  return analyzeContentStructure(taskText(task, assets), {
    sourceSegments: taskSourceSegments(assets),
    sourceFrames: taskSourceFrames(assets),
  });
}

function mediaInputError(message, code = 'MEDIA_INPUT_NOT_READY') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function materialAuthorization(body = {}) {
  const authorizationStatus = String(body.authorizationStatus || '').trim().toLowerCase();
  const authorizationRef = String(body.authorizationRef || '').trim().slice(0, 500);
  if (authorizationStatus !== 'approved' || !authorizationRef) {
    throw mediaInputError('素材必须先确认授权，并填写授权记录引用', 'MEDIA_AUTHORIZATION_REQUIRED');
  }
  return { authorizationStatus, authorizationRef };
}

function assertContentMaterialReady(assets = []) {
  const imported = assets.filter((asset) => {
    if (asset.metadata?.sourceType === 'user_material') return true;
    if (asset.metadata?.sourceType || asset.metadata?.source || asset.metadata?.sourceAssetId) return false;
    // ponytail: infer legacy source assets from status; a migration can backfill sourceType later.
    return ['parsed', 'partial'].includes(asset.status);
  });
  const unauthorized = imported.filter((asset) => asset.metadata?.authorizationStatus !== 'approved'
    || !String(asset.metadata?.authorizationRef || '').trim());
  if (unauthorized.length) {
    throw mediaInputError('内容任务包含未确认授权的素材，不能继续', 'MEDIA_AUTHORIZATION_REQUIRED');
  }
  const failed = imported.filter((asset) => asset.status !== 'parsed' || asset.metadata?.parseMessage);
  if (failed.length) {
    throw mediaInputError('内容任务包含未通过媒体扫描的素材，不能继续', 'MEDIA_ASSET_SCAN_FAILED');
  }
}

function approvedMediaVersion(records, requestedId, label, requiredFields = []) {
  const requested = String(requestedId || '').trim();
  const isUsable = (item) => item?.status === 'approved'
    && item.authorizationStatus === 'approved'
    && Boolean(String(item.authorizationRef || '').trim())
    && requiredFields.every((field) => Boolean(String(item[field] || '').trim()));
  const record = requested ? records.find((item) => item.id === requested) : records.find(isUsable);
  if (!isUsable(record)) {
    throw mediaInputError(label + '必须是已审核且已授权的版本', 'MEDIA_ASSET_NOT_APPROVED');
  }
  return record;
}

function taskScriptForMedia(task, body = {}) {
  const script = String(body.scriptText || task.nodes.find((node) => node.id === 'CE-11')?.output?.text || '').trim();
  if (!script) throw mediaInputError('请先提供或生成 CE-11 脚本', 'MEDIA_SCRIPT_REQUIRED');
  return script.slice(0, 30_000);
}

function workerOutputPath(reference) {
  const value = String(reference || '').trim();
  if (!value.startsWith('file:')) return null;
  try {
    return fileURLToPath(new URL(value));
  } catch (error) {
    throw mediaInputError('媒体 worker 返回了无效本地文件引用', 'MEDIA_WORKER_OUTPUT_INVALID');
  }
}

async function workerMediaReference(reference, label) {
  const value = String(reference || '').trim();
  if (!value) return value;
  let filePath = null;
  if (/^file:/i.test(value)) {
    try {
      filePath = fileURLToPath(new URL(value));
    } catch {
      throw mediaInputError(label + '不是有效的 file:// 引用', 'MEDIA_WORKER_INPUT_INVALID');
    }
  } else if (isAbsolute(value)) {
    filePath = value;
  }
  if (!filePath) return value;
  try {
    return pathToFileURL(await resolveLocalMediaPath(filePath, mediaAllowedRoots())).toString();
  } catch {
    throw mediaInputError(label + '必须是允许目录内的本地文件', 'MEDIA_WORKER_INPUT_INVALID');
  }
}

const WORKER_MEDIA_REFERENCE_KEYS = new Set([
  'referenceAudioRef', 'canonicalImageRef', 'baseVideoRef', 'modelAssetRef',
  'referenceImageRefs', 'backgroundRef', 'logoRef', 'introRef', 'outroRef',
  'musicRef', 'audioRef', 'videoRef',
]);

async function normalizeWorkerInput(value, key = '') {
  if (Array.isArray(value)) {
    return WORKER_MEDIA_REFERENCE_KEYS.has(key)
      ? Promise.all(value.map((item) => workerMediaReference(item, key)))
      : Promise.all(value.map((item) => normalizeWorkerInput(item, key)));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([childKey, childValue]) => [
      childKey,
      await normalizeWorkerInput(childValue, childKey),
    ])));
  }
  return WORKER_MEDIA_REFERENCE_KEYS.has(key) ? workerMediaReference(value, key) : value;
}

function normalizedBatchConnector(connector, onOutput = null) {
  return {
    id: connector.id,
    async generate(args) {
      const output = await connector.generate({
        ...args,
        item: {
          ...args.item,
          input: await normalizeWorkerInput(args.item?.input),
        },
      });
      return typeof onOutput === 'function' ? onOutput(output, args) : output;
    },
  };
}

function mediaContentType(kind, filePath) {
  const extension = extname(String(filePath || '')).toLowerCase();
  const byExtension = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
  };
  return byExtension[extension] || (kind === 'audio' ? 'audio/wav' : 'video/mp4');
}

async function streamLocalMediaFile(request, response, filePath, contentType) {
  try {
    const resolvedPath = await resolveLocalMediaPath(filePath, mediaAllowedRoots());
    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile() || fileStat.size < 1) return false;
    const size = fileStat.size;
    const range = String(request.headers.range || '').trim();
    let start = 0;
    let end = size - 1;
    let statusCode = 200;
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match || (!match[1] && !match[2])) {
        response.writeHead(416, { 'content-range': `bytes */${size}` });
        response.end();
        return true;
      }
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
      } else {
        const suffixLength = Number(match[2]);
        if (!Number.isInteger(suffixLength) || suffixLength < 1) {
          response.writeHead(416, { 'content-range': `bytes */${size}` });
          response.end();
          return true;
        }
        start = Math.max(0, size - suffixLength);
        end = size - 1;
      }
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
        response.writeHead(416, { 'content-range': `bytes */${size}` });
        response.end();
        return true;
      }
      end = Math.min(end, size - 1);
      statusCode = 206;
    }
    const headers = {
      'content-type': contentType || mediaContentType(null, resolvedPath),
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    };
    if (statusCode === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    response.writeHead(statusCode, headers);
    const stream = createReadStream(resolvedPath, { start, end });
    stream.on('error', () => response.destroy());
    stream.pipe(response);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

async function buildBatchExport(batch, approvedItems) {
  const stagingRoot = await mkdtemp(join(PACKAGE_DIR, safeOutputId(batch.id) + '-staging-'));
  const mediaFiles = [];
  const missingFiles = [];
  const stagedPaths = [];
  try {
    for (const item of approvedItems) {
      for (const [kind, referenceKey, fallbackExtension] of [
        ['video', 'videoRef', '.mp4'],
        ['audio', 'audioRef', '.wav'],
        ['cover', 'coverRef', '.jpg'],
        ['subtitle', 'subtitleRef', '.srt'],
      ]) {
        const reference = kind === 'video'
          ? item.output?.renderedVideoRef || item.output?.videoRef
          : item.output?.[referenceKey];
        const sourcePath = workerOutputPath(reference);
        if (!reference) {
          if (kind === 'video') missingFiles.push({ itemId: item.id, kind, reason: 'missing_video_reference' });
          continue;
        }
        if (!sourcePath) {
          missingFiles.push({
            itemId: item.id,
            kind,
            sourceRef: reference,
            reason: item.output?.simulated === true ? 'simulation_output_not_packaged' : 'non_local_reference',
          });
          continue;
        }
        let resolvedPath;
        let sourceStat;
        try {
          resolvedPath = await resolveLocalMediaPath(sourcePath, mediaAllowedRoots());
        } catch {
          throw mediaInputError('批次成片文件不在允许目录内或不可读取', 'MEDIA_WORKER_OUTPUT_INVALID');
        }
        try {
          sourceStat = await stat(resolvedPath);
        } catch {
          missingFiles.push({ itemId: item.id, kind, sourceRef: reference, reason: 'missing_local_file' });
          continue;
        }
        if (!sourceStat.isFile() || sourceStat.size < 1) {
          missingFiles.push({ itemId: item.id, kind, sourceRef: reference, reason: 'empty_or_non_file' });
          continue;
        }
        const filename = safeOutputId(item.id) + '-' + kind + (extname(resolvedPath) || fallbackExtension).toLowerCase();
        const stagedPath = join(stagingRoot, filename);
        await copyFile(resolvedPath, stagedPath);
        stagedPaths.push(stagedPath);
        mediaFiles.push({ kind, filename, sourceRef: reference, sizeBytes: sourceStat.size, sha256: await sha256File(resolvedPath) });
      }
    }
    const manifestObject = {
      version: 'content-batch-export-v1',
      batchId: batch.id,
      taskId: batch.taskId,
      simulationOnly: approvedItems.every((item) => item.output?.simulated === true),
      missingFiles,
      items: approvedItems.map((item) => ({
        id: item.id,
        avatarVersionId: item.avatarVersionId,
        voiceVersionId: item.voiceVersionId,
        scriptVersionId: item.scriptVersionId,
        output: item.output,
        packageFiles: mediaFiles.filter((file) => file.filename.startsWith(safeOutputId(item.id) + '-')),
        missingFiles: missingFiles.filter((file) => file.itemId === item.id),
        review: item.review,
      })),
    };
    const manifest = JSON.stringify(manifestObject, null, 2) + '\n';
    const manifestPath = join(PACKAGE_DIR, safeOutputId(batch.id) + '-batch-manifest.json');
    const packagePath = join(PACKAGE_DIR, safeOutputId(batch.id) + '-batch-package.zip');
    await writeFile(manifestPath, manifest, 'utf8');
    const packaged = await packageFiles([manifestPath, ...stagedPaths], packagePath, { baseDir: DATA_DIR });
    return {
      manifestPath,
      package: {
        ...packaged,
        files: mediaFiles,
        missingFiles,
        manifestSha256: createHash('sha256').update(manifest).digest('hex'),
      },
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function saveWorkerOutputAssets(task, output, operation, actor) {
  const transcriptResult = output?.transcriptResult && typeof output.transcriptResult === 'object'
    ? output.transcriptResult
    : {
        status: Array.isArray(output?.segments) && output.segments.length ? 'succeeded' : 'not_configured',
        format: Array.isArray(output?.segments) && output.segments.length ? 'worker' : null,
        segments: Array.isArray(output?.segments) ? output.segments : [],
      };
  const transcriptSegments = Array.isArray(transcriptResult.segments) ? transcriptResult.segments : [];
  const transcriptConfidence = transcriptResult.confidence && typeof transcriptResult.confidence === 'object'
    ? transcriptResult.confidence
    : summarizeTranscriptConfidence(transcriptSegments);
  const transcript = typeof output?.transcript === 'string'
    ? output.transcript.trim()
    : transcriptSegments.map((segment) => String(segment?.text || '').trim()).filter(Boolean).join('\n');
  const definitions = [
    ['audioRef', 'audio', 'audio/wav'],
    ['videoRef', 'video', 'video/mp4'],
  ];
  const prepared = [];
  for (const [referenceKey, kind, fallbackMimeType] of definitions) {
    const reference = output?.[referenceKey];
    const filePath = workerOutputPath(reference);
    if (!filePath) continue;
    let resolvedPath;
    try {
      resolvedPath = await resolveLocalMediaPath(filePath, mediaAllowedRoots());
    } catch (error) {
      throw mediaInputError('媒体 worker 输出文件不在允许目录内或不可读取', 'MEDIA_WORKER_OUTPUT_INVALID');
    }
    let fileAsset;
    try {
      fileAsset = await stat(resolvedPath);
    } catch (error) {
      throw mediaInputError('媒体 worker 输出文件不可读取', 'MEDIA_WORKER_OUTPUT_INVALID');
    }
    let mediaCheck;
    if (output?.simulated === true) {
      mediaCheck = { status: 'skipped_simulation', kind, sizeBytes: fileAsset.size };
    } else {
      try {
        mediaCheck = await probeMediaFile(resolvedPath, { allowedRoots: mediaAllowedRoots(), expectedKind: kind });
      } catch (error) {
        throw mediaInputError('媒体 worker 输出未通过自动完整性检查', 'MEDIA_WORKER_OUTPUT_INVALID');
      }
    }
    prepared.push({ referenceKey, kind, fallbackMimeType, reference, resolvedPath, fileAsset, mediaCheck });
  }
  const requiredKind = operation === 'tts' ? 'audio' : 'video';
  if (!prepared.some((item) => item.kind === requiredKind)) {
    throw mediaInputError(
      `媒体 worker 必须返回可读取的本地 ${requiredKind} file:// 输出引用`,
      'MEDIA_WORKER_OUTPUT_INVALID',
    );
  }
  const assets = [];
  for (const { referenceKey, kind, fallbackMimeType, reference, resolvedPath, fileAsset, mediaCheck } of prepared) {
    const assetId = 'asset_worker_' + createHash('sha1')
      .update([task.id, operation, referenceKey, resolvedPath].join('\u0000'))
      .digest('hex')
      .slice(0, 20);
    assets.push(workbenchStore.saveMediaAsset({
      id: assetId,
      tenantId: task.tenantId,
      projectId: task.projectId,
      taskId: task.id,
      path: resolvedPath,
      filename: basename(resolvedPath),
      kind,
      mimeType: fallbackMimeType,
      status: 'generated',
      metadata: {
        source: 'media_worker',
        operation,
        reference,
        sizeBytes: fileAsset.size,
        mediaCheck,
        requestId: output.requestId || null,
        modelVersion: output.modelVersion || null,
        ...(transcript || transcriptSegments.length ? { transcriptResult: { ...transcriptResult, segments: transcriptSegments, confidence: transcriptConfidence } } : {}),
      },
      transcript,
    }, actor));
  }
  return assets;
}

function batchAssetId(batch, item, kind) {
  return 'asset_batch_' + createHash('sha1')
    .update([batch.id, item.id, kind].join('\u0000'))
    .digest('hex')
    .slice(0, 20);
}

function recordBatchPostprocessFailure(actor, batch, itemId, sourceAssetId, error, durationMs = null) {
  const latestBatch = contentBatchById(batch.id, actor);
  const latestItem = latestBatch?.items.find((candidate) => candidate.id === itemId);
  if (!latestBatch || latestItem?.status !== 'succeeded') return latestBatch || batch;
  const previousAttempt = Number(latestItem.output?.postprocess?.attempt) || 0;
  const postprocess = {
    status: error?.code === 'MEDIA_TIMECODES_REQUIRED' ? 'blocked' : 'failed',
    attempt: previousAttempt + 1,
    sourceAssetId: sourceAssetId || null,
    ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
    error: {
      code: typeof error?.code === 'string' && error.code ? error.code : 'MEDIA_POSTPROCESS_ERROR',
      message: safeError(error),
      retryable: false,
    },
    reviewRequired: true,
  };
  const updated = transitionContentBatchItem(latestBatch, itemId, 'attach_output', actor, {
    output: { ...(latestItem.output || {}), postprocess },
  });
  contentBatchStore.saveBatch(actor, updated);
  return updated;
}

async function postprocessBatchItem(actor, batch, itemId, body = {}) {
  const startedAt = Date.now();
  const task = contentTaskById(batch.taskId, actor);
  if (!task) throw mediaInputError('批次关联的内容任务不存在', 'MEDIA_INPUT_NOT_READY');
  const item = batch.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error('批次子任务不存在');
  if (item.status !== 'succeeded') throw mediaInputError('只有已生成的批次条目可以进入后处理', 'MEDIA_ITEM_NOT_READY');
  const assets = workbenchStore.listMediaAssets(actor, task.id);
  const itemAssetIds = new Set(Array.isArray(item.output?.assetIds) ? item.output.assetIds : []);
  const requestedSource = String(body.assetId || '').trim();
  const source = requestedSource
    ? assets.find((asset) => asset.id === requestedSource && itemAssetIds.has(asset.id) && asset.kind === 'video')
    : assets.find((asset) => asset.kind === 'video' && item.output?.assetIds?.includes(asset.id) && asset.metadata?.operation === 'batch_media')
      || assets.find((asset) => asset.kind === 'video' && item.output?.assetIds?.includes(asset.id));
  if (!source) throw mediaInputError('批次条目没有可后处理的本地视频资产', 'MEDIA_OUTPUT_NOT_READY');

  try {
    let transcript = source.transcript || String(item.output?.transcript || '').trim();
    let transcriptResult = source.metadata?.transcriptResult || item.output?.transcriptResult || null;
    let segments = Array.isArray(transcriptResult?.segments) ? transcriptResult.segments : [];
    if (!segments.length && Array.isArray(item.output?.segments)) segments = item.output.segments;
    let timecodeSource = transcriptResult?.format || 'worker';
    if (!segments.length && source.path) {
      const transcribed = await transcribeMediaAsset(source.path, { allowedRoots: mediaAllowedRoots() });
      if (transcribed.status === 'succeeded') {
        transcript = transcribed.text || transcript;
        transcriptResult = transcribed;
        segments = Array.isArray(transcribed.segments) ? transcribed.segments : [];
        timecodeSource = 'asr';
        workbenchStore.saveMediaAsset({
          ...source,
          transcript,
          metadata: { ...source.metadata, transcriptResult: transcribed },
        }, actor);
      }
    }
    const subtitle = subtitleText(transcript, segments);
    const template = item.input?.template || {};
    const width = Number.isInteger(template.width) ? template.width : 1080;
    const height = Number.isInteger(template.height) ? template.height : 1920;
    const assSubtitle = segmentsToAss(segments, {
      width,
      height,
      safeArea: template.safeArea,
      fontName: template.captionFontName,
      fontSize: template.captionFontSize,
    });
    const prefix = safeOutputId(batch.id) + '-' + safeOutputId(item.id);
    const renderPath = join(RENDER_DIR, prefix + '-render.mp4');
    const coverPath = join(COVER_DIR, prefix + '-cover.jpg');
    const subtitlePath = join(SUBTITLE_DIR, prefix + '.srt');
    const assSubtitlePath = join(SUBTITLE_DIR, prefix + '.ass');
    await mkdir(SUBTITLE_DIR, { recursive: true });
    await writeFile(subtitlePath, subtitle, 'utf8');
    await writeFile(assSubtitlePath, assSubtitle, 'utf8');
    const render = await renderVideo(source.path, renderPath, {
      allowedRoots: mediaAllowedRoots(),
      baseDir: DATA_DIR,
      template: { ...template, width, height },
      subtitleSegments: segments,
    });
    const cover = await renderCover(source.path, coverPath, {
      allowedRoots: mediaAllowedRoots(),
      baseDir: DATA_DIR,
      template: { ...template, width: 1080, height: 1440 },
      width: 1080,
      height: 1440,
    });
    const transcriptMetadata = transcriptResult ? { transcriptResult: { ...transcriptResult, segments } } : {};
    const renderMediaCheck = await probeMediaFile(render.path, { allowedRoots: mediaAllowedRoots(), expectedKind: 'video' });
    const coverMediaCheck = await probeMediaFile(cover.path, { allowedRoots: mediaAllowedRoots(), expectedKind: 'image' });
    const renderedAssetId = batchAssetId(batch, item, 'rendered-video');
    const coverAssetId = batchAssetId(batch, item, 'cover');
    const subtitleAssetId = batchAssetId(batch, item, 'subtitle');
    const renderedAsset = workbenchStore.saveMediaAsset({
    id: renderedAssetId,
    tenantId: task.tenantId,
    projectId: task.projectId,
    taskId: task.id,
    path: render.path,
    filename: render.filename,
    kind: 'video',
    mimeType: 'video/mp4',
    status: 'rendered',
    metadata: { source: 'batch_postprocess', batchId: batch.id, batchItemId: item.id, render, mediaCheck: renderMediaCheck, sourceAssetId: source.id, ...transcriptMetadata },
    transcript,
    }, actor);
    const coverAsset = workbenchStore.saveMediaAsset({
    id: coverAssetId,
    tenantId: task.tenantId,
    projectId: task.projectId,
    taskId: task.id,
    path: cover.path,
    filename: cover.filename,
    kind: 'image',
    mimeType: 'image/jpeg',
    status: 'generated',
    metadata: { source: 'batch_postprocess', batchId: batch.id, batchItemId: item.id, cover, mediaCheck: coverMediaCheck, sourceAssetId: source.id },
    }, actor);
    const subtitleAsset = workbenchStore.saveMediaAsset({
    id: subtitleAssetId,
    tenantId: task.tenantId,
    projectId: task.projectId,
    taskId: task.id,
    path: subtitlePath,
    filename: basename(subtitlePath),
    kind: 'text',
    mimeType: 'application/x-subrip',
    status: 'generated',
    metadata: { source: 'batch_postprocess', batchId: batch.id, batchItemId: item.id, format: 'srt', sourceAssetId: source.id, segments },
    textContent: subtitle,
    }, actor);
    const assSubtitleAsset = workbenchStore.saveMediaAsset({
    id: batchAssetId(batch, item, 'ass-subtitle'),
    tenantId: task.tenantId,
    projectId: task.projectId,
    taskId: task.id,
    path: assSubtitlePath,
    filename: basename(assSubtitlePath),
    kind: 'text',
    mimeType: 'text/x-ass',
    status: 'generated',
    metadata: { source: 'batch_postprocess', batchId: batch.id, batchItemId: item.id, format: 'ass', sourceAssetId: source.id, segments, safeArea: template.safeArea || null },
    textContent: assSubtitle,
    }, actor);
    const assetIds = [renderedAsset.id, coverAsset.id, subtitleAsset.id, assSubtitleAsset.id];
    const postprocess = {
    status: 'succeeded',
    sourceAssetId: source.id,
    renderedAssetId: renderedAsset.id,
    coverAssetId: coverAsset.id,
    subtitleAssetId: subtitleAsset.id,
    assSubtitleAssetId: assSubtitleAsset.id,
    subtitleFormats: ['srt', 'ass'],
    assetIds,
    mediaChecks: [
      { assetId: renderedAsset.id, ...renderMediaCheck },
      { assetId: coverAsset.id, ...coverMediaCheck },
    ],
    template: render.template,
    timecodeSource,
    durationMs: Math.max(0, Date.now() - startedAt),
    reviewRequired: true,
    };
    const latestBatch = contentBatchById(batch.id, actor);
    const latestItem = latestBatch?.items.find((candidate) => candidate.id === item.id);
    if (!latestBatch || latestItem?.status !== 'succeeded') throw mediaInputError('批次条目状态已变化，请重新读取后再后处理', 'MEDIA_ITEM_STATE_CHANGED');
    const updated = transitionContentBatchItem(latestBatch, item.id, 'attach_output', actor, {
    output: {
      ...(latestItem.output || {}),
      renderedVideoRef: pathToFileURL(render.path).toString(),
      coverRef: pathToFileURL(cover.path).toString(),
      subtitleRef: pathToFileURL(subtitlePath).toString(),
      assSubtitleRef: pathToFileURL(assSubtitlePath).toString(),
      assetIds: [...new Set([...(Array.isArray(latestItem.output?.assetIds) ? latestItem.output.assetIds : []), ...assetIds])],
      postprocess,
    },
    });
    contentBatchStore.saveBatch(actor, updated);
    return updated;
  } catch (error) {
    recordBatchPostprocessFailure(actor, batch, item.id, source.id, error, Math.max(0, Date.now() - startedAt));
    throw error;
  }
}

async function executeMediaWorkerNode(task, body, actor, nodeId) {
  const capability = nodeId === 'CE-14' ? 'tts' : 'talking_head';
  const health = await contentMediaWorkerConnector.health();
  if (health.status !== 'ready' || !health.capabilities?.includes(capability)) {
    throw mediaInputError('媒体 worker 未就绪或缺少 ' + capability + ' 能力', 'TOOL_UNAVAILABLE');
  }
  const catalog = contentBatchCatalogFor(actor, task.projectId, task.id);
  const voice = approvedMediaVersion(catalog.voices, body.voiceVersionId, '声音版本', ['referenceAudioRef']);
  const scriptText = taskScriptForMedia(task, body);
  const avatar = nodeId === 'CE-15'
    ? approvedMediaVersion(catalog.avatars, body.avatarVersionId, '数字人版本', ['canonicalImageRef', 'baseVideoRef'])
    : null;
  const templateVersionId = String(body.templateVersionId || catalog.defaults?.templateVersionId || '').trim() || null;
  const template = nodeId === 'CE-15'
    ? catalog.templates.find((item) => item.id === templateVersionId)
    : null;
  if (nodeId === 'CE-15' && (!template || !['approved', 'active'].includes(template.status))) {
    throw mediaInputError('模板版本必须审核通过且允许使用', 'MEDIA_ASSET_NOT_APPROVED');
  }
  const audioRef = nodeId === 'CE-15'
    ? String(body.audioRef || task.nodes.find((node) => node.id === 'CE-14')?.output?.audioRef || '').trim() || null
    : null;
  const referenceAudioRef = await workerMediaReference(voice.referenceAudioRef, '声音参考音频');
  const canonicalImageRef = avatar ? await workerMediaReference(avatar.canonicalImageRef, '数字人参考图') : null;
  const baseVideoRef = avatar ? await workerMediaReference(avatar.baseVideoRef, '数字人基础视频') : null;
  const normalizedAudioRef = await workerMediaReference(audioRef, '口播音频');
  const input = {
    scriptText,
    language: String(body.language || 'zh-CN').trim().slice(0, 20),
    voiceVersionId: voice.id,
    voice: {
      referenceAudioRef,
      ...(voice.referenceTranscript ? { referenceTranscript: voice.referenceTranscript } : {}),
      ...(voice.voiceName ? { voiceName: voice.voiceName } : {}),
      ...(voice.provider ? { provider: voice.provider } : {}),
      ...(voice.modelVersion ? { modelVersion: voice.modelVersion } : {}),
      ...(voice.licenseRef ? { licenseRef: voice.licenseRef } : {}),
      ...(voice.weightsHash ? { weightsHash: voice.weightsHash } : {}),
      authorizationRef: voice.authorizationRef,
    },
    ...(avatar ? {
      avatarVersionId: avatar.id,
      avatar: {
        canonicalImageRef,
        baseVideoRef,
        authorizationRef: avatar.authorizationRef,
      },
    } : {}),
    ...(normalizedAudioRef ? { audioRef: normalizedAudioRef } : {}),
    templateVersionId,
  };
  const node = taskNode(task, nodeId);
  const idempotencyKey = String(body.idempotencyKey || `content-node|${task.id}|${nodeId}|${node.attempts || 0}`).trim().slice(0, 512);
  const item = {
    id: 'content_node_item_' + createHash('sha1').update(idempotencyKey).digest('hex').slice(0, 20),
    idempotencyKey,
    input,
  };
  const generated = nodeId === 'CE-14'
    ? await contentMediaWorkerConnector.generateAudio({ batch: { id: `content-node-${task.id}`, taskId: task.id }, item, actor, workerId: contentMediaWorkerConnector.id })
    : await contentMediaWorkerConnector.generateTalkingHead({ batch: { id: `content-node-${task.id}`, taskId: task.id }, item, actor, workerId: contentMediaWorkerConnector.id });
  if (generated.simulated === true) {
    throw mediaInputError('媒体 worker 只返回模拟结果，不能作为真实音频/视频交付', 'MEDIA_WORKER_SIMULATION_ONLY');
  }
  const localAssets = await saveWorkerOutputAssets(task, generated, generated.operation, actor);
  return recordReadyTaskNode(task, nodeId, {
    status: 'succeeded',
    input: {
      ...input,
      idempotencyKey,
      execution: {
        inputRefs: [referenceAudioRef, canonicalImageRef, baseVideoRef, normalizedAudioRef].filter(Boolean),
        outputRefs: [generated.audioRef, generated.videoRef].filter(Boolean),
        toolVersion: health.workerVersion || null,
        modelVersion: generated.modelVersion || null,
        connectorVersion: 'content-media-worker-v1',
        permissions: [capability],
      },
    },
    output: {
      ...generated,
      assetIds: localAssets.map((asset) => asset.id),
      reviewRequired: true,
    },
    note: generated.simulated
      ? '已通过外部媒体 worker 的模拟能力生成，结果必须人工审核，不能视为真实模型验收'
      : '已通过外部媒体 worker 生成，结果必须人工审核后才能进入后续节点',
  }, actor);
}

function voiceComparisonDigest(taskId, voiceVersionIds, scriptText) {
  return createHash('sha256')
    .update([taskId, [...voiceVersionIds].sort().join('|'), scriptText].join('\u0000'))
    .digest('hex')
    .slice(0, 24);
}

const VOICE_SEGMENT_MAX_CHARS = 500;

function splitVoiceScript(scriptText, maxChars = VOICE_SEGMENT_MAX_CHARS) {
  let remaining = String(scriptText || '').replace(/\r\n?/g, '\n').trim();
  const segments = [];
  while (remaining) {
    if (remaining.length <= maxChars) {
      segments.push(remaining);
      break;
    }
    const minimumBoundary = Math.max(1, Math.floor(maxChars * 0.55));
    let boundary = maxChars;
    for (let index = maxChars; index >= minimumBoundary; index -= 1) {
      if (/[。！？!?；;\n]/.test(remaining[index - 1])) {
        boundary = index;
        break;
      }
    }
    if (boundary === maxChars) {
      for (let index = maxChars; index >= minimumBoundary; index -= 1) {
        if (/[,，、\s]/.test(remaining[index - 1])) {
          boundary = index;
          break;
        }
      }
    }
    const segment = remaining.slice(0, boundary).trim();
    if (!segment) {
      boundary = maxChars;
      segments.push(remaining.slice(0, boundary));
    } else {
      segments.push(segment);
    }
    remaining = remaining.slice(boundary).trimStart();
  }
  return segments;
}

function voiceComparisonCandidate(task, voice, scriptText, language, comparisonId, previous = null) {
  const idempotencyKey = [
    'content-voice-comparison',
    task.id,
    comparisonId,
    voice.id,
  ].join('|');
  const segmentTexts = splitVoiceScript(scriptText);
  const segments = segmentTexts.map((segmentText, index) => {
    const previousSegment = previous?.segments?.find((item) => item.index === index && item.text === segmentText) || null;
    const segmentKey = idempotencyKey + '|segment|' + index;
    return {
      id: previousSegment?.id || 'voice_segment_' + createHash('sha1').update(segmentKey).digest('hex').slice(0, 20),
      index,
      text: segmentText,
      status: previousSegment?.status === 'succeeded' ? 'succeeded' : previousSegment?.status === 'failed' ? 'failed' : 'pending',
      attempt: Number.isInteger(previousSegment?.attempt) && previousSegment.attempt >= 0 ? previousSegment.attempt : 0,
      idempotencyKey: segmentKey,
      start: Number.isFinite(previousSegment?.start) ? previousSegment.start : null,
      end: Number.isFinite(previousSegment?.end) ? previousSegment.end : null,
      durationSeconds: Number.isFinite(previousSegment?.durationSeconds) ? previousSegment.durationSeconds : null,
      timecodeSource: previousSegment?.timecodeSource || null,
      output: previousSegment?.output || null,
      assetIds: Array.isArray(previousSegment?.assetIds) ? previousSegment.assetIds : [],
      error: previousSegment?.error || null,
      errorCode: previousSegment?.errorCode || null,
      retryable: previousSegment?.retryable === true,
      startedAt: previousSegment?.startedAt || null,
      completedAt: previousSegment?.completedAt || null,
    };
  });
  return {
    id: previous?.id || 'voice_candidate_' + createHash('sha1').update(idempotencyKey).digest('hex').slice(0, 20),
    voiceVersionId: voice.id,
    displayName: voice.displayName || voice.name || voice.id,
    status: previous?.status === 'succeeded' ? 'succeeded' : previous?.status === 'failed' ? 'failed' : 'pending',
    attempt: Number.isInteger(previous?.attempt) && previous.attempt >= 0 ? previous.attempt : 0,
    idempotencyKey,
    input: {
      scriptText,
      segmentCount: segments.length,
      language,
      voiceVersionId: voice.id,
      voice: {
        referenceAudioRef: voice.referenceAudioRef,
        ...(voice.referenceTranscript ? { referenceTranscript: voice.referenceTranscript } : {}),
        ...(voice.voiceName ? { voiceName: voice.voiceName } : {}),
        ...(voice.provider ? { provider: voice.provider } : {}),
        ...(voice.modelVersion ? { modelVersion: voice.modelVersion } : {}),
        ...(voice.licenseRef ? { licenseRef: voice.licenseRef } : {}),
        ...(voice.weightsHash ? { weightsHash: voice.weightsHash } : {}),
        authorizationRef: voice.authorizationRef,
      },
    },
    output: previous?.output || null,
    segments,
    error: previous?.error || null,
    errorCode: previous?.errorCode || null,
    retryable: previous?.retryable === true,
    qualityReview: previous?.qualityReview || null,
    qualityReviewHistory: Array.isArray(previous?.qualityReviewHistory) ? previous.qualityReviewHistory.slice(-20) : [],
    startedAt: previous?.startedAt || null,
    completedAt: previous?.completedAt || null,
  };
}

function refreshVoiceCandidateOutput(candidate) {
  let cursor = 0;
  let allTimecodesMeasured = true;
  for (const segment of candidate.segments) {
    const reportedDuration = Number(segment.output?.durationSeconds);
    const durationSeconds = Number.isFinite(reportedDuration) && reportedDuration > 0
      ? Number(reportedDuration.toFixed(3))
      : Number(Math.max(0.25, segment.text.length / 8).toFixed(3));
    segment.durationSeconds = durationSeconds;
    segment.timecodeSource = Number.isFinite(reportedDuration) && reportedDuration > 0 ? 'worker' : 'estimated';
    if (segment.status === 'succeeded') {
      segment.start = Number(cursor.toFixed(3));
      segment.end = Number((cursor + durationSeconds).toFixed(3));
      cursor += durationSeconds;
      if (segment.timecodeSource !== 'worker') allTimecodesMeasured = false;
    } else {
      segment.start = null;
      segment.end = null;
      allTimecodesMeasured = false;
    }
  }
  const outputs = candidate.segments.filter((segment) => segment.status === 'succeeded' && segment.output).map((segment) => segment.output);
  const audioRefs = outputs.map((output) => output.audioRef).filter(Boolean);
  const assetIds = [...new Set(candidate.segments.flatMap((segment) => segment.assetIds || []))];
  const modelVersions = [...new Set(outputs.map((output) => output.modelVersion).filter(Boolean))];
  candidate.status = candidate.segments.every((segment) => segment.status === 'succeeded') ? 'succeeded' : candidate.segments.some((segment) => segment.status === 'failed') ? 'failed' : 'running';
  candidate.attempt = Math.max(0, ...candidate.segments.map((segment) => segment.attempt || 0));
  candidate.output = outputs.length
    ? {
        ...outputs[0],
        audioRef: candidate.segments.length === 1 ? audioRefs[0] || null : null,
        audioRefs,
        assetIds,
        segmentCount: candidate.segments.length,
        mergeOrder: candidate.segments.map((segment) => segment.index),
        mergeStrategy: candidate.segments.length === 1 ? 'single_audio' : 'ordered_segments',
        durationSeconds: Number(cursor.toFixed(3)),
        timecodeSource: allTimecodesMeasured ? 'worker' : 'estimated',
        segments: candidate.segments.map((segment) => ({
          index: segment.index,
          text: segment.text,
          start: segment.start,
          end: segment.end,
          durationSeconds: segment.durationSeconds,
          timecodeSource: segment.timecodeSource,
          audioRef: segment.output?.audioRef || null,
          assetIds: segment.assetIds || [],
          status: segment.status,
        })),
        modelVersion: modelVersions.length === 1 ? modelVersions[0] : modelVersions.join(' / ') || null,
        simulated: outputs.every((output) => output.simulated === true),
        reviewRequired: true,
      }
    : null;
  return candidate;
}

function comparisonCandidateStatus(comparison) {
  const candidates = Array.isArray(comparison?.candidates) ? comparison.candidates : [];
  return candidates.length && candidates.every((candidate) => candidate.status === 'succeeded')
    ? 'waiting_selection'
    : 'partial_failed';
}

async function executeVoiceComparison(task, body, actor) {
  if (task.run?.status === 'not_started') throw mediaInputError('请先启动内容工作流', 'MEDIA_INPUT_NOT_READY');
  if (!contentMediaWorkerConnector) throw mediaInputError('媒体 worker 未配置', 'TOOL_UNAVAILABLE');
  const health = await contentMediaWorkerConnector.health();
  if (health.status !== 'ready' || !health.capabilities?.includes('tts')) {
    throw mediaInputError('媒体 worker 未就绪或缺少 tts 能力', 'TOOL_UNAVAILABLE');
  }
  const voiceVersionIds = Array.isArray(body.voiceVersionIds)
    ? body.voiceVersionIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (voiceVersionIds.length !== 2 || new Set(voiceVersionIds).size !== 2) {
    throw mediaInputError('声音 A/B 试听必须选择两个不同的声音版本', 'VOICE_COMPARISON_REQUIRES_TWO_VOICES');
  }
  const scriptText = taskScriptForMedia(task, body);
  const language = String(body.language || 'zh-CN').trim().slice(0, 20);
  const catalog = contentBatchCatalogFor(actor, task.projectId, task.id);
  const voices = voiceVersionIds.map((id) => approvedMediaVersion(catalog.voices, id, '声音版本', ['referenceAudioRef']));
  const digest = voiceComparisonDigest(task.id, voiceVersionIds, scriptText);
  const comparisonId = 'voice_comparison_' + digest;
  const current = normalizeContentTask(task);
  const existing = current.voiceComparisons.find((item) => item.id === comparisonId);
  if (existing?.status === 'selected' || existing?.status === 'waiting_selection') {
    return { task: current, comparison: existing, idempotent: true };
  }
  const timestamp = nowIso();
  const comparison = {
    id: comparisonId,
    fingerprint: digest,
    taskId: task.id,
    tenantId: task.tenantId,
    projectId: task.projectId,
    scriptText,
    language,
    voiceVersionIds: [...voiceVersionIds],
    candidates: voices.map((voice) => voiceComparisonCandidate(
      task,
      voice,
      scriptText,
      language,
      comparisonId,
      existing?.candidates?.find((candidate) => candidate.voiceVersionId === voice.id),
    )),
    status: 'running',
    selectedVoiceVersionId: existing?.selectedVoiceVersionId || null,
    reviewRequired: true,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
  let workingTask = normalizeContentTask({
    ...current,
    voiceComparisons: [
      ...current.voiceComparisons.filter((item) => item.id !== comparison.id),
      comparison,
    ],
    updatedAt: timestamp,
    updatedBy: { username: actor.username || 'system', displayName: actor.displayName || '系统' },
    run: {
      ...current.run,
      lastAction: '开始声音 A/B 试听：' + voices.map((voice) => voice.displayName || voice.id).join(' / '),
    },
  });
  workingTask = await saveContentTask(workingTask, actor, 'content_voice_comparison_started', {
    comparisonId,
    voiceVersionIds,
  });

  const persistComparison = async (eventType, data = {}) => {
    comparison.updatedAt = nowIso();
    workingTask = await saveContentTask(normalizeContentTask({
      ...workingTask,
      voiceComparisons: workingTask.voiceComparisons.map((item) => item.id === comparison.id ? comparison : item),
      updatedAt: comparison.updatedAt,
      updatedBy: { username: actor.username || 'system', displayName: actor.displayName || '系统' },
    }), actor, eventType, { comparisonId, ...data });
  };

  for (const candidate of comparison.candidates) {
    refreshVoiceCandidateOutput(candidate);
    if (candidate.status === 'succeeded' && candidate.segments.every((segment) => segment.status === 'succeeded')) continue;
    candidate.error = null;
    candidate.errorCode = null;
    candidate.retryable = false;
    candidate.startedAt = candidate.startedAt || nowIso();
    for (const segment of candidate.segments) {
      if (segment.status === 'succeeded' && segment.output?.audioRef) continue;
      if (segment.status === 'failed' && segment.retryable !== true) continue;
      segment.status = 'running';
      segment.attempt += 1;
      segment.error = null;
      segment.errorCode = null;
      segment.startedAt = nowIso();
      segment.completedAt = null;
      try {
        const generated = await contentMediaWorkerConnector.generateAudio({
          batch: { id: `content-voice-comparison-${comparison.id}`, taskId: task.id },
          item: {
            id: segment.id,
            idempotencyKey: segment.idempotencyKey,
            input: {
              ...candidate.input,
              scriptText: segment.text,
              fullScriptText: candidate.input.scriptText,
              segment: { index: segment.index, count: candidate.segments.length },
            },
          },
          actor,
          workerId: contentMediaWorkerConnector.id,
        });
        if (generated.simulated === true) {
          throw mediaInputError('媒体 worker 只返回模拟结果，不能作为声音试听或真实音频交付', 'MEDIA_WORKER_SIMULATION_ONLY');
        }
        const localAssets = await saveWorkerOutputAssets(task, generated, generated.operation, actor);
        segment.status = 'succeeded';
        segment.output = generated;
        segment.assetIds = localAssets.map((asset) => asset.id);
        segment.retryable = false;
        segment.completedAt = nowIso();
      } catch (error) {
        segment.status = 'failed';
        segment.error = safeError(error?.message || error?.code || error);
        segment.errorCode = error?.code || error?.errorClass || 'VOICE_COMPARISON_GENERATION_FAILED';
        segment.retryable = error?.retryable === true;
        candidate.error = segment.error;
        candidate.errorCode = segment.errorCode;
        candidate.retryable = segment.retryable;
        segment.completedAt = nowIso();
      }
      refreshVoiceCandidateOutput(candidate);
      await persistComparison(segment.status === 'succeeded' ? 'content_voice_comparison_segment_completed' : 'content_voice_comparison_segment_failed', {
        candidateId: candidate.id,
        segmentId: segment.id,
        segmentIndex: segment.index,
        status: segment.status,
        errorCode: segment.errorCode,
      });
    }
    refreshVoiceCandidateOutput(candidate);
    candidate.completedAt = nowIso();
    if (candidate.status === 'succeeded') {
      candidate.error = null;
      candidate.errorCode = null;
      candidate.retryable = false;
    }
    await persistComparison(candidate.status === 'succeeded' ? 'content_voice_comparison_candidate_completed' : 'content_voice_comparison_candidate_failed', {
      candidateId: candidate.id,
      status: candidate.status,
      errorCode: candidate.errorCode,
    });
  }
  comparison.status = comparisonCandidateStatus(comparison);
  comparison.updatedAt = nowIso();
  workingTask = await saveContentTask(normalizeContentTask({
    ...workingTask,
    voiceComparisons: workingTask.voiceComparisons.map((item) => item.id === comparison.id ? comparison : item),
    updatedAt: comparison.updatedAt,
    updatedBy: { username: actor.username || 'system', displayName: actor.displayName || '系统' },
    run: {
      ...workingTask.run,
      lastAction: comparison.status === 'waiting_selection'
        ? '声音 A/B 试听完成，等待人工选择'
        : '声音 A/B 试听部分失败，可仅重试失败候选',
    },
  }), actor, 'content_voice_comparison_completed', {
    comparisonId,
    status: comparison.status,
  });
  return { task: workingTask, comparison, retried: Boolean(existing) };
}

async function selectVoiceComparison(task, comparisonId, body, actor) {
  const current = normalizeContentTask(task);
  if (current.run?.status === 'not_started') throw mediaInputError('请先启动内容工作流', 'MEDIA_INPUT_NOT_READY');
  const comparison = current.voiceComparisons.find((item) => item.id === comparisonId);
  if (!comparison) throw mediaInputError('声音 A/B 试听记录不存在', 'VOICE_COMPARISON_NOT_FOUND');
  const voiceVersionId = String(body.voiceVersionId || '').trim();
  const role = String(body.role || 'default').trim();
  if (!['default', 'backup'].includes(role)) {
    throw mediaInputError('声音选择角色必须是 default 或 backup', 'VOICE_COMPARISON_ROLE_INVALID');
  }
  const candidate = comparison.candidates.find((item) => item.voiceVersionId === voiceVersionId);
  if (!candidate) throw mediaInputError('只能选择本次 A/B 试听中的声音版本', 'VOICE_COMPARISON_CANDIDATE_INVALID');
  if (candidate.status !== 'succeeded' || !candidate.segments?.length || !candidate.segments.every((segment) => segment.status === 'succeeded')) {
    throw mediaInputError('只能选择生成成功的声音候选', 'VOICE_COMPARISON_CANDIDATE_NOT_READY');
  }
  const catalog = contentBatchCatalogFor(actor, current.projectId, current.id);
  approvedMediaVersion(catalog.voices, voiceVersionId, '声音版本', ['referenceAudioRef']);
  const existingDefault = comparison.defaultVoiceVersionId || comparison.selectedVoiceVersionId || null;
  const existingBackup = comparison.backupVoiceVersionId || null;
  const defaultVoiceVersionId = role === 'default' ? voiceVersionId : existingDefault;
  const backupVoiceVersionId = role === 'backup' ? voiceVersionId : existingBackup;
  if (defaultVoiceVersionId && backupVoiceVersionId && defaultVoiceVersionId === backupVoiceVersionId) {
    throw mediaInputError('默认声线和备用声线必须是两个不同的版本', 'VOICE_COMPARISON_ROLES_MUST_DIFFER');
  }
  const timestamp = nowIso();
  comparison.status = 'selected';
  comparison.defaultVoiceVersionId = defaultVoiceVersionId;
  comparison.backupVoiceVersionId = backupVoiceVersionId;
  comparison.selectedVoiceVersionId = defaultVoiceVersionId;
  comparison.selectionConfirmed = Boolean(defaultVoiceVersionId && backupVoiceVersionId);
  if (comparison.selectionConfirmed) comparison.selectionConfirmedAt = timestamp;
  comparison.selectedAt = timestamp;
  comparison.selectedBy = { username: actor.username || 'system', displayName: actor.displayName || '系统' };
  comparison.updatedAt = timestamp;
  const selected = normalizeContentTask({
    ...current,
    selectedVoiceVersionId: defaultVoiceVersionId,
    backupVoiceVersionId,
    voiceComparisons: current.voiceComparisons.map((item) => item.id === comparisonId ? comparison : item),
    updatedAt: timestamp,
    updatedBy: comparison.selectedBy,
    run: {
      ...current.run,
      lastAction: `已人工设定${role === 'default' ? '默认' : '备用'}声线：${voiceVersionId}`,
    },
  });
  const saved = await saveContentTask(selected, actor, 'content_voice_comparison_selected', {
    comparisonId,
    voiceVersionId,
    role,
    selectionConfirmed: comparison.selectionConfirmed,
  });
  return { task: saved, comparison: saved.voiceComparisons.find((item) => item.id === comparisonId) };
}

function requiredVoiceRating(value, label) {
  const rating = Number(value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw mediaInputError(`${label}必须是 1 到 5 的整数`, 'VOICE_REVIEW_RATING_INVALID');
  }
  return rating;
}

function optionalVoiceMetric(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const metric = Number(value);
  if (!Number.isFinite(metric) || metric < 0) {
    throw mediaInputError(`${label}必须是非负数字`, 'VOICE_REVIEW_METRIC_INVALID');
  }
  return Number(metric.toFixed(3));
}

async function reviewVoiceComparison(task, comparisonId, body, actor) {
  const current = normalizeContentTask(task);
  const comparison = current.voiceComparisons.find((item) => item.id === comparisonId);
  if (!comparison) throw mediaInputError('声音 A/B 试听记录不存在', 'VOICE_COMPARISON_NOT_FOUND');
  const voiceVersionId = String(body.voiceVersionId || '').trim();
  const candidate = comparison.candidates.find((item) => item.voiceVersionId === voiceVersionId);
  if (!candidate) throw mediaInputError('只能评估本次 A/B 试听中的声音版本', 'VOICE_COMPARISON_CANDIDATE_INVALID');
  if (candidate.status !== 'succeeded' || !candidate.segments?.length || !candidate.segments.every((segment) => segment.status === 'succeeded')) {
    throw mediaInputError('只能评估生成成功的声音候选', 'VOICE_COMPARISON_CANDIDATE_NOT_READY');
  }
  const testCaseId = String(body.testCaseId || '').trim() || null;
  if (testCaseId && !voiceComparisonTestSet().cases.some((item) => item.id === testCaseId)) {
    throw mediaInputError('固定验收样本不存在', 'VOICE_REVIEW_TEST_CASE_INVALID');
  }
  const timestamp = nowIso();
  const review = {
    id: 'voice_review_' + randomUUID(),
    comparisonId,
    testSetVersion: voiceComparisonTestSet().version,
    testCaseId,
    voiceVersionId,
    provider: candidate.input?.voice?.provider || null,
    modelVersion: candidate.output?.modelVersion || candidate.input?.voice?.modelVersion || null,
    weightsHash: candidate.input?.voice?.weightsHash || null,
    ratings: {
      accuracy: requiredVoiceRating(body.accuracy, '准确度评分'),
      naturalness: requiredVoiceRating(body.naturalness, '自然度评分'),
      speed: requiredVoiceRating(body.speed, '语速评分'),
    },
    resourceUsage: {
      vramGiB: optionalVoiceMetric(body.vramGiB, 'VRAM'),
      elapsedMs: optionalVoiceMetric(body.elapsedMs, '耗时'),
    },
    failures: {
      count: candidate.segments.filter((segment) => segment.status === 'failed').length,
      attempts: candidate.segments.reduce((sum, segment) => sum + (segment.attempt || 0), 0),
    },
    license: {
      licenseRef: candidate.input?.voice?.licenseRef || null,
      authorizationRef: candidate.input?.voice?.authorizationRef || null,
      weightsHash: candidate.input?.voice?.weightsHash || null,
    },
    simulated: candidate.output?.simulated === true,
    notes: String(body.notes || '').trim().slice(0, 5_000),
    reviewedAt: timestamp,
    reviewedBy: { username: actor.username || 'system', displayName: actor.displayName || '系统' },
  };
  candidate.qualityReviewHistory = [...(candidate.qualityReviewHistory || []), review].slice(-20);
  candidate.qualityReview = review;
  comparison.updatedAt = timestamp;
  const saved = await saveContentTask(normalizeContentTask({
    ...current,
    voiceComparisons: current.voiceComparisons.map((item) => item.id === comparisonId ? comparison : item),
    updatedAt: timestamp,
    updatedBy: review.reviewedBy,
  }), actor, 'content_voice_comparison_reviewed', {
    comparisonId,
    voiceVersionId,
    testCaseId,
    reviewId: review.id,
  });
  return { task: saved, comparison: saved.voiceComparisons.find((item) => item.id === comparisonId), review };
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

async function recordTaskNodeFailure(task, nodeId, error, actor) {
  if (error?.code === 'TOPIC_SELECTION_REQUIRED') return task;
  const node = task?.nodes?.find((item) => item.id === nodeId);
  if (!node || !['ready', 'running', 'waiting_review'].includes(node.status)) return task;
  const blockedCodes = new Set([
    'TOOL_UNAVAILABLE',
    'TRANSCRIPTION_NOT_CONFIGURED',
    'OCR_NOT_CONFIGURED',
    'AI_PROVIDER_NOT_CONFIGURED',
    'PUBLISH_CONNECTOR_NOT_CONFIGURED',
    'MEDIA_ASSET_NOT_APPROVED',
    'MEDIA_SCRIPT_REQUIRED',
    'MEDIA_INPUT_NOT_READY',
    'MEDIA_TIMECODES_REQUIRED',
    'MEDIA_WORKER_INPUT_INVALID',
    'MEDIA_WORKER_OUTPUT_INVALID',
    'MEDIA_WORKER_SIMULATION_ONLY',
    'MEDIA_AUTHORIZATION_REQUIRED',
    'MEDIA_ASSET_SCAN_FAILED',
    'CONTENT_REVIEW_REQUIRED',
  ]);
  const status = blockedCodes.has(error?.code) ? 'blocked' : 'failed';
  try {
    const recorded = recordContentNode(task, nodeId, {
      status,
      error: safeError(error),
      note: status === 'blocked'
        ? '能力未配置或不可用，已保留阻塞证据；配置后可重试或转人工'
        : '执行失败已保留证据；可重试或转人工补录',
    }, actor);
    return await saveContentTask(recorded, actor, 'content_node_failed', {
      nodeId,
      status,
      code: error?.code || null,
    });
  } catch {
    return task;
  }
}

async function parseTaskMaterial(task, body, actor) {
  if (task.run?.status === 'not_started') {
    const error = new Error('请先启动内容工作流，再导入授权素材');
    error.code = 'CONTENT_WORKFLOW_NOT_STARTED';
    throw error;
  }
  const importNode = taskNode(task, 'CE-04');
  if (!['ready', 'running', 'waiting_review', 'succeeded'].includes(importNode.status)) {
    const error = new Error('节点 CE-04 尚未到达可执行状态');
    error.code = 'CONTENT_NODE_NOT_READY';
    throw error;
  }
  const authorization = materialAuthorization(body);
  const sourceRef = String(body.sourceRef || '').trim().slice(0, 1_000) || null;
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
      sourceType: 'user_material',
      sourceRef,
      ...authorization,
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
    metadata: {
      assetId: asset.id,
      status: parsed.status,
      sourceRef,
      ...authorization,
    },
  }, actor);

  const sourceAssets = [...new Set([...(task.sourceAssets || []), parsed.path])].slice(0, 20);
  let currentTask = normalizeContentTask({
    ...task,
    sourceAssets,
    updatedAt: nowIso(),
    updatedBy: actorSnapshot(actor),
    run: {
      ...task.run,
      inputRefs: {
        ...(task.run?.inputRefs || {}),
        sourceAssets,
      },
    },
  });
  if (taskNode(currentTask, 'CE-04').status !== 'succeeded') {
    currentTask = await recordReadyTaskNode(currentTask, 'CE-04', {
      status: 'succeeded',
      input: { path: parsed.path, assetId: asset.id, sourceRef, ...authorization },
      output: {
        assetId: asset.id,
        filename: parsed.filename,
        kind: parsed.kind,
        sizeBytes: parsed.sizeBytes,
        sourceRef,
        ...authorization,
        knowledgeDocumentId: document.id,
      },
      note: '已读取已确认授权素材并写入媒体资产与知识索引',
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
  if (provider.configured && !provider.localDraftOnly) connectorForCapability(actor, config.capability, task.tenantId);
  const assets = workbenchStore.listMediaAssets(actor, task.id);
  assertContentMaterialReady(assets);
  const query = String(body.query || task.title || '').trim().slice(0, 200);
  const knowledge = workbenchStore.searchKnowledge(actor, query, { limit: 8 });
  const structure = task.nodes.find((node) => node.id === 'CE-09')?.output || null;
  const brandProfile = task.brandProfileId
    ? workbenchStore.getBrandProfile(actor, task.brandProfileId)
    : null;
  if (task.brandProfileId && !brandProfile) {
    throw new Error('绑定的品牌资料不存在或当前成员无权访问');
  }
  if (body.kind === 'copy' && !task.topicSelection?.text) {
    const error = new Error('请先人工选择 CE-10 生成的最终选题');
    error.code = 'TOPIC_SELECTION_REQUIRED';
    throw error;
  }
  const generated = await generateContentDraft({
    kind: body.kind,
    task,
    knowledge,
    structure,
    brandProfile,
    materialText: taskText(task, assets),
    sourceReferences: taskSourceReferences(assets, knowledge),
  });
  const nextTask = await recordReadyTaskNode(task, config.nodeId, {
    status: 'succeeded',
    input: {
      kind: body.kind,
      knowledgeIds: knowledge.map((item) => item.id),
      brandProfileId: brandProfile?.id || null,
      topicSelectionId: task.topicSelection?.id || null,
    },
    output: {
      text: generated.text,
      provider: generated.provider,
      model: generated.model,
      requestId: generated.requestId,
      usage: generated.usage,
      promptVersion: generated.promptVersion,
      sourceIndex: generated.sourceIndex,
      sourceReferences: taskSourceReferences(assets, knowledge),
      brandProfile: brandProfile
        ? {
            id: brandProfile.id,
            name: brandProfile.name,
            voice: brandProfile.voice,
            constraints: brandProfile.constraints,
            sourceDocumentIds: brandProfile.sourceDocumentIds,
          }
        : null,
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

function subtitleText(transcript, segments = []) {
  const timedSubtitle = segmentsToSrt(segments);
  if (timedSubtitle) return timedSubtitle;
  const error = new Error('字幕生成需要真实 ASR 或 TTS 时间码，不能按文本行估算');
  error.code = 'MEDIA_TIMECODES_REQUIRED';
  throw error;
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
  const requestedNode = task.nodes.find((node) => node.id === nodeId);
  if (!requestedNode) throw new Error('工作流节点不存在');
  if (requestedNode.status === 'succeeded') return task;
  if (!['ready', 'running', 'waiting_review'].includes(requestedNode.status)) {
    const error = new Error('节点 ' + nodeId + ' 尚未到达可执行状态');
    error.code = 'CONTENT_NODE_NOT_READY';
    throw error;
  }

  if (nodeId === 'CE-02') {
    const brandProfile = task.brandProfileId
      ? workbenchStore.getBrandProfile(actor, task.brandProfileId)
      : null;
    if (task.brandProfileId && !brandProfile) {
      throw new Error('绑定的品牌资料不存在或当前成员无权访问');
    }
    const output = {
      sourceType: brandProfile ? 'brand_profile' : 'task_context',
      brandProfile: brandProfile
        ? {
            id: brandProfile.id,
            name: brandProfile.name,
            voice: brandProfile.voice,
            constraints: brandProfile.constraints,
            sourceDocumentIds: brandProfile.sourceDocumentIds,
            status: brandProfile.status,
          }
        : null,
      sourceBrief: task.sourceBrief || '',
      sourceAssets: task.sourceAssets || [],
      loadedAt: nowIso(),
      requiresHumanConfirmation: true,
      confirmationPrompt: brandProfile
        ? '请确认品牌资料、语气和约束适用于当前内容任务'
        : '当前任务未绑定品牌资料，请人工确认是否可以继续',
    };
    return recordReadyTaskNode(task, nodeId, {
      status: 'succeeded',
      input: { brandProfileId: brandProfile?.id || null },
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
    return (await parseTaskMaterial(task, {
      path: body.path || task.sourceAssets?.[0],
      sourceRef: body.sourceRef,
      authorizationStatus: body.authorizationStatus,
      authorizationRef: body.authorizationRef,
    }, actor)).task;
  }

  const assets = workbenchStore.listMediaAssets(actor, task.id);
  let asset = body.assetId
    ? assets.find((item) => item.id === body.assetId)
    : ['CE-16', 'CE-17', 'CE-18'].includes(nodeId)
      ? productionAssetFor(assets, 'video') || sourceAssetFor(assets)
      : sourceAssetFor(assets);
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
    const confidence = result.confidence && typeof result.confidence === 'object'
      ? result.confidence
      : summarizeTranscriptConfidence(result.segments);
    return recordReadyTaskNode(task, nodeId, {
      status: 'succeeded',
      input: { assetId: asset.id },
      output: {
        text: asset.transcript,
        status: result.status,
        format: result.format || null,
        segments: Array.isArray(result.segments) ? result.segments : [],
        confidence,
      },
      note: confidence.requiresHumanReview
        ? '使用已配置 ASR 生成转写；置信度缺失或偏低，需人工校对'
        : '使用已配置 ASR 生成转写',
    }, actor);
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
    return recordReadyTaskNode(task, nodeId, {
      status: 'succeeded',
      input: { assetId: asset.id },
      output: {
        text: asset.ocrText,
        status: result.status,
        format: result.format || null,
        detections: Array.isArray(result.detections) ? result.detections : [],
        frames: Array.isArray(result.frames) ? result.frames : [],
      },
      note: '使用 macOS Vision 或已配置 OCR 连接器识别画面文字；结构化结果保留位置和置信度',
    }, actor);
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
    const structure = analyzeTaskStructure(task, assets);
    return recordReadyTaskNode(task, nodeId, { status: 'succeeded', input: { assetIds: assets.map((item) => item.id) }, output: structure, note: '基于任务素材执行本地结构分析' }, actor);
  }

  const generationKind = nodeIdToGenerationKind(nodeId);
  if (generationKind) {
    return (await generateTaskContent(task, { ...body, kind: generationKind }, actor)).task;
  }

  if (nodeId === 'CE-14' || nodeId === 'CE-15') {
    if (contentMediaWorkerConnector) {
      return executeMediaWorkerNode(task, body, actor, nodeId);
    }
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
    let transcript = asset.transcript || '';
    let segments = asset.metadata?.transcriptResult?.segments || [];
    if (!segments.length && ['generated', 'rendered'].includes(asset.status) && asset.path) {
      const transcribed = await transcribeMediaAsset(asset.path, { allowedRoots: mediaAllowedRoots() });
      if (transcribed.status === 'succeeded') {
        transcript = transcribed.text || transcript;
        segments = Array.isArray(transcribed.segments) ? transcribed.segments : [];
        asset = workbenchStore.saveMediaAsset({
          ...asset,
          transcript,
          metadata: { ...asset.metadata, transcriptResult: transcribed },
        }, actor);
      }
    }
    if (!transcript) throw new Error('没有可生成字幕的转写文本');
    const subtitle = subtitleText(transcript, segments);
    const template = contentBatchCatalogFor(actor, task.projectId, task.id).templates?.[0] || {};
    const assSubtitle = segmentsToAss(segments, {
      width: Number.isInteger(template.width) ? template.width : 1080,
      height: Number.isInteger(template.height) ? template.height : 1920,
      safeArea: template.safeArea,
      fontName: template.captionFontName,
      fontSize: template.captionFontSize,
    });
    await mkdir(SUBTITLE_DIR, { recursive: true });
    const path = join(SUBTITLE_DIR, safeOutputId(task.id) + '-' + asset.id + '.srt');
    const assPath = join(SUBTITLE_DIR, safeOutputId(task.id) + '-' + asset.id + '.ass');
    await writeFile(path, subtitle, 'utf8');
    await writeFile(assPath, assSubtitle, 'utf8');
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
    const assAsset = workbenchStore.saveMediaAsset({
      id: 'asset_ass_subtitle_' + randomUUID(),
      tenantId: task.tenantId,
      projectId: task.projectId,
      taskId: task.id,
      path: assPath,
      filename: basename(assPath),
      kind: 'text',
      mimeType: 'text/x-ass',
      status: 'generated',
      metadata: { sourceAssetId: asset.id, format: 'ass', safeArea: template.safeArea || null, segments },
      textContent: assSubtitle,
    }, actor);
    return recordReadyTaskNode(task, nodeId, {
      status: 'succeeded',
      input: { assetId: asset.id },
      output: {
        ...subtitleAsset,
        assAssetId: assAsset.id,
        assPath: assAsset.path,
        assFilename: assAsset.filename,
        subtitleFormats: ['srt', 'ass'],
        templateVersionId: template.id || template.versionId || null,
      },
      note: '根据真实转写时间码生成 SRT 与 ASS 字幕文件，等待人工校对',
    }, actor);
  }

  if (nodeId === 'CE-18') {
    const keyframe = asset.metadata?.keyframe;
    const coverSource = keyframe?.status === 'succeeded' && keyframe.path ? keyframe.path : asset.path;
    if (!coverSource) throw new Error('没有可用视频或关键帧，不能生成封面候选');
    const outputPath = join(COVER_DIR, safeOutputId(task.id) + '-' + safeOutputId(asset.id) + '-cover.jpg');
    const template = contentBatchCatalogFor(actor, task.projectId, task.id).templates?.[0] || {};
    const cover = await renderCover(coverSource, outputPath, {
      allowedRoots: mediaAllowedRoots(),
      baseDir: DATA_DIR,
      template: { ...template, width: 1080, height: 1440 },
      width: 1080,
      height: 1440,
    });
    const coverAsset = workbenchStore.saveMediaAsset({
      id: 'asset_cover_' + randomUUID(),
      tenantId: task.tenantId,
      projectId: task.projectId,
      taskId: task.id,
      path: cover.path,
      filename: cover.filename,
      kind: 'image',
      mimeType: 'image/jpeg',
      status: 'generated',
      metadata: { cover, sourceAssetId: asset.id },
    }, actor);
    return recordReadyTaskNode(task, nodeId, {
      status: 'succeeded',
      input: { assetId: asset.id },
      output: { assetId: coverAsset.id, ...cover, source: keyframe?.status === 'succeeded' ? 'keyframe' : 'video_first_frame', sourceAssetId: asset.id },
      note: keyframe?.status === 'succeeded'
        ? '基于真实关键帧生成独立封面候选，等待人工审核'
        : '原视频没有关键帧缓存，基于首帧生成独立封面候选，等待人工审核',
    }, actor);
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
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
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

  if (requestUrl.pathname === '/api/content/media-worker/health' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    if (!contentMediaWorkerConnector) {
      return sendJson(response, {
        ok: true,
        configured: false,
        worker: {
          status: 'unavailable',
          reason: 'not_configured',
          protocol: 'content-media-worker-v1',
          accelerator: { type: 'unknown', available: false },
          capabilities: [],
        },
      });
    }
    return sendJson(response, {
      ok: true,
      configured: true,
      worker: await contentMediaWorkerConnector.health(),
    });
  }

  if (requestUrl.pathname === '/api/content/voice-comparison-test-set' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    return sendJson(response, { ok: true, testSet: voiceComparisonTestSet() });
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

  if (requestUrl.pathname === '/api/download-center/catalog' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    return sendJson(response, {
      ok: true,
      platforms: downloadPlatformCatalog(),
      note: '下载资源默认保存在本机下载中心；解析链接不会发送 Cookie 或平台登录态。',
    });
  }

  if (requestUrl.pathname === '/api/download-center/tasks' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    return sendJson(response, {
      ok: true,
      tasks: visibleDownloadTasks(user).slice(0, 50).map(publicDownloadTask),
    });
  }

  if (requestUrl.pathname === '/api/download-center/resolve' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    try {
      const body = await readRequestBody(request);
      const source = detectDownloadSource(body.url);
      const existing = visibleDownloadTasks(user).find(
        (task) => task.canonicalUrl === source.canonicalUrl && downloadAssetFor(task.id),
      );
      if (existing) {
        return sendJson(response, { ok: true, task: publicDownloadTask(existing), idempotent: true });
      }
      const media = await resolveDownloadMedia(source, {
        signal: AbortSignal.timeout(25_000),
        browserSession: desktopPlatformSession(),
      });
      const task = await createDownloadTask(source, normalizeDownloadMedia(media, source.platform), user);
      await recordActivity(user, 'download_resolved', '解析下载链接：' + task.platformLabel + ' / ' + task.title);
      return sendJson(response, { ok: true, task: publicDownloadTask(task) }, 201);
    } catch (error) {
      const status = ['DOWNLOAD_LINK_REQUIRED', 'DOWNLOAD_LINK_INVALID', 'DOWNLOAD_LINK_UNSUPPORTED', 'DOWNLOAD_PLATFORM_UNSUPPORTED'].includes(error?.code)
        ? 400
        : 422;
      return sendJson(response, { ok: false, error: safeError(error), code: error?.code || 'DOWNLOAD_RESOLVE_FAILED' }, status);
    }
  }

  const downloadTaskMatch = requestUrl.pathname.match(/^\/api\/download-center\/tasks\/([^/]+)$/);
  if (downloadTaskMatch && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const task = downloadTaskFor(decodeURIComponent(downloadTaskMatch[1]), user);
    if (!task) return sendJson(response, { ok: false, error: '下载任务不存在' }, 404);
    try {
      const body = await readRequestBody(request);
      const kind = String(body.kind || '').trim();
      const index = body.index === undefined || body.index === null || body.index === '' ? null : Number(body.index);
      if (index !== null && (!Number.isInteger(index) || index < 0)) {
        return sendJson(response, { ok: false, error: '图片序号不正确' }, 400);
      }
      const queued = await queueDownload(task, user, kind, index);
      await recordActivity(user, 'download_queued', '加入下载队列：' + task.platformLabel + ' / ' + task.title + ' / ' + kind);
      return sendJson(response, { ok: true, task: publicDownloadTask(queued) }, 202);
    } catch (error) {
      const status = error?.code === 'DOWNLOAD_ASSET_EXPIRED' ? 410 : 409;
      return sendJson(response, { ok: false, error: safeError(error), code: error?.code || 'DOWNLOAD_QUEUE_FAILED' }, status);
    }
  }

  const downloadMediaMatch = requestUrl.pathname.match(/^\/api\/download-center\/tasks\/([^/]+)\/media$/);
  if (downloadMediaMatch && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const task = downloadTaskFor(decodeURIComponent(downloadMediaMatch[1]), user);
    const asset = task && downloadAssetFor(task.id);
    if (!task || !asset) return sendJson(response, { ok: false, error: '解析资源已过期，请重新解析链接' }, 410);
    const kind = requestUrl.searchParams.get('kind') || '';
    const index = Number(requestUrl.searchParams.get('index'));
    const sourceUrl = mediaSourceFor(asset, task.platform, kind, Number.isInteger(index) ? index : null);
    if (!sourceUrl) return sendJson(response, { ok: false, error: '媒体资源不存在' }, 404);
    try {
      const remote = await fetchRemoteMedia(sourceUrl, task.platform, kind === 'video' ? 'video' : 'cover', kind === 'video' ? DOWNLOAD_MAX_VIDEO_BYTES : DOWNLOAD_MAX_IMAGE_BYTES);
      response.writeHead(200, {
        'cache-control': 'private, max-age=60',
        'content-type': remote.contentType || (kind === 'video' ? 'video/mp4' : 'image/jpeg'),
        'x-content-type-options': 'nosniff',
      });
      const limited = sizeLimiter(kind === 'video' ? DOWNLOAD_MAX_VIDEO_BYTES : DOWNLOAD_MAX_IMAGE_BYTES);
      pipeline(Readable.fromWeb(remote.body), limited.stream, response).catch(() => {
        if (!response.writableEnded) response.end();
      });
      return null;
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error), code: error?.code || 'DOWNLOAD_PREVIEW_FAILED' }, 502);
    }
  }

  const downloadFileMatch = requestUrl.pathname.match(/^\/api\/download-center\/tasks\/([^/]+)\/file$/);
  if (downloadFileMatch && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const task = downloadTaskFor(decodeURIComponent(downloadFileMatch[1]), user);
    if (!task) return sendJson(response, { ok: false, error: '下载任务不存在' }, 404);
    const kind = requestUrl.searchParams.get('kind') || '';
    const index = Number(requestUrl.searchParams.get('index'));
    const file = downloadFileFor(task, kind, Number.isInteger(index) ? index : null);
    if (!file || file.status !== 'completed' || !file.localFilePath) {
      return sendJson(response, { ok: false, error: '文件尚未下载完成' }, 409);
    }
    const resolvedPath = resolve(file.localFilePath);
    const downloadRoot = resolve(DOWNLOAD_DIR);
    if (!(resolvedPath === downloadRoot || resolvedPath.startsWith(downloadRoot + sep))) {
      return sendJson(response, { ok: false, error: '下载文件路径不受支持' }, 403);
    }
    try {
      const fileStat = await stat(resolvedPath);
      response.writeHead(200, {
        'cache-control': 'private, max-age=60',
        'content-disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(file.filename || basename(resolvedPath)),
        'content-length': fileStat.size,
        'content-type': kind === 'video' ? 'video/mp4' : 'image/jpeg',
        'x-content-type-options': 'nosniff',
      });
      createReadStream(resolvedPath).pipe(response);
      return null;
    } catch (error) {
      return sendJson(response, { ok: false, error: '本地下载文件不可读取：' + safeError(error) }, 404);
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
    const sourceWorkFingerprint = typeof body.sourceWorkFingerprint === 'string'
      ? body.sourceWorkFingerprint.trim().slice(0, 256)
      : '';
    let task;
    try {
      const context = workbenchStore.ensureContext(user, body.projectId || null);
      if (sourceWorkFingerprint) {
        const sourceWork = appState.works.find(
          (work) => work.fingerprint === sourceWorkFingerprint,
        );
        if (!sourceWork || (user.role !== 'admin' && sourceWork.tenantId !== user.tenantId)) {
          return sendJson(response, { ok: false, error: '来源作品不存在或当前成员无权使用' }, 404);
        }
        const duplicate = visibleContentTasks(user).find(
          (item) =>
            item.projectId === context.project.id &&
            item.sourceWorkFingerprint === sourceWorkFingerprint,
        );
        if (duplicate) {
          return sendJson(
            response,
            { ok: false, error: '该监控作品已创建内容任务', task: duplicate },
            409,
          );
        }
      }
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

  if (requestUrl.pathname === '/api/content/batches/catalog' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    try {
      const taskId = requestUrl.searchParams.get('taskId');
      const task = taskId ? contentTaskById(taskId, user) : null;
      if (taskId && !task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
      const catalog = contentBatchCatalogFor(user, task?.projectId || requestUrl.searchParams.get('projectId'), task?.id || taskId);
      return sendJson(response, { ok: true, catalog });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/content/avatar-profiles' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    try {
      const profile = contentBatchStore.createAvatarProfile(user, await readRequestBody(request));
      await recordActivity(user, 'content_avatar_profile_created', '登记数字人资产：' + profile.profile.name);
      return sendJson(response, { ok: true, ...profile }, 201);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/content/voice-profiles' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    try {
      const profile = contentBatchStore.createVoiceProfile(user, await readRequestBody(request));
      await recordActivity(user, 'content_voice_profile_created', '登记声音资产：' + profile.profile.name);
      return sendJson(response, { ok: true, ...profile }, 201);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/content/script-sets' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    try {
      const scriptSet = contentBatchStore.createScriptSet(user, await readRequestBody(request));
      await recordActivity(user, 'content_script_set_created', '登记批量脚本：' + scriptSet.name);
      return sendJson(response, { ok: true, scriptSet }, 201);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/content/template-versions' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    try {
      const template = contentBatchStore.createTemplate(user, await readRequestBody(request));
      await recordActivity(user, 'content_template_version_created', '登记剪辑模板：' + template.profile.name);
      return sendJson(response, { ok: true, ...template }, 201);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/content/batches' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    try {
      const taskId = requestUrl.searchParams.get('taskId');
      const task = taskId ? contentTaskById(taskId, user) : null;
      if (taskId && !task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
      const batches = contentBatchStore.listBatches(user, task?.projectId || requestUrl.searchParams.get('projectId'), task?.id || taskId);
      return sendJson(response, { ok: true, batches: batches.map((batch) => contentBatchResponse(batch, user)) });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/content/batches/plan' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    try {
      const { plan } = batchPlanFor(user, await readRequestBody(request));
      return sendJson(response, { ok: true, plan });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  if (requestUrl.pathname === '/api/content/batches' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    try {
      const body = await readRequestBody(request);
      if (body.id) {
        const existing = contentBatchById(body.id, user);
        if (existing) return sendJson(response, { ok: true, batch: contentBatchResponse(existing, user), idempotent: true });
      }
      const { task, plan } = batchPlanFor(user, body);
      const batch = createContentBatch({
        id: body.id || 'content_batch_' + randomUUID(),
        taskId: task.id,
        tenantId: task.tenantId,
        projectId: task.projectId,
        plan,
        title: body.title,
      }, user);
      const saved = contentBatchStore.saveBatch(user, batch);
      await recordActivity(user, 'content_batch_created', '创建数字人批次：' + saved.title);
      return sendJson(response, { ok: true, batch: contentBatchResponse(saved, user) }, 201);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
  }

  const batchFilePath = requestUrl.pathname.match(/^\/api\/content\/batches\/([^/]+)\/items\/([^/]+)\/file$/);
  if (batchFilePath && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const batch = contentBatchById(decodeURIComponent(batchFilePath[1]), user);
    if (!batch) return sendJson(response, { ok: false, error: '批次不存在' }, 404);
    const item = batch.items.find((candidate) => candidate.id === decodeURIComponent(batchFilePath[2]));
    if (!item) return sendJson(response, { ok: false, error: '批次子任务不存在' }, 404);
    const kind = String(requestUrl.searchParams.get('kind') || 'video').trim();
    const referenceKey = kind === 'audio' ? 'audioRef' : kind === 'video' ? 'videoRef' : null;
    if (!referenceKey) return sendJson(response, { ok: false, error: '媒体类型不受支持' }, 400);
    const filePath = workerOutputPath(kind === 'video' ? item.output?.renderedVideoRef || item.output?.videoRef : item.output?.[referenceKey]);
    if (!filePath || !await streamLocalMediaFile(request, response, filePath, mediaContentType(kind, filePath))) {
      return sendJson(response, { ok: false, error: '批次媒体文件不可读取' }, 404);
    }
    return;
  }

  if (requestUrl.pathname.startsWith('/api/content/batches/') && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const auditPath = requestUrl.pathname.match(/^\/api\/content\/batches\/([^/]+)\/audit$/);
    const batchId = decodeURIComponent(auditPath ? auditPath[1] : requestUrl.pathname.slice('/api/content/batches/'.length));
    const batch = contentBatchById(batchId, user);
    if (!batch) return sendJson(response, { ok: false, error: '批次不存在' }, 404);
    const current = contentBatchResponse(batch, user);
    if (auditPath) return sendJson(response, { ok: true, batch: current, audit: current.audit });
    return sendJson(response, { ok: true, batch: current });
  }

  if (requestUrl.pathname.startsWith('/api/content/batches/') && request.method === 'POST') {
    const parts = requestUrl.pathname.slice('/api/content/batches/'.length).split('/').map((part) => decodeURIComponent(part));
    const batchId = parts[0];
    const action = parts[1];
    const user = authorizedUser(request, response);
    if (!user) return null;
    let batch = contentBatchById(batchId, user);
    if (!batch) return sendJson(response, { ok: false, error: '批次不存在' }, 404);
    try {
      const body = await readRequestBody(request);
      if (parts.length === 2 && action === 'audit') {
        batch = recordContentBatchAudit(batch, user, body);
        await recordActivity(user, 'content_batch_audit_recorded', '记录批次审计：' + batch.title);
        const current = contentBatchResponse(batch, user);
        return sendJson(response, { ok: true, batch: current, audit: current.audit });
      }
      if (parts.length === 2 && action === 'export') {
        const summary = summarizeBatch(batch);
        if (!summary.approved) throw new Error('至少审核通过一条成片后才能导出');
        const approvedItems = batch.items.filter((item) => item.status === 'approved');
        if (approvedItems.some((item) => item.output?.simulated === true)) {
          throw new Error('模拟输出不能导出为审核通过的生产内容包');
        }
        await mkdir(PACKAGE_DIR, { recursive: true });
        const exported = await buildBatchExport(batch, approvedItems);
        const pendingCount = summary.total - summary.approved - summary.failed - summary.blocked - summary.cancelled;
        const exportStatus = exported.package.missingFiles.length
          ? 'incomplete'
          : summary.approved === summary.total ? 'complete' : 'partial';
        const exportedBatch = contentBatchStore.saveBatch(user, {
          ...batch,
          exportRecord: {
            version: 'content-batch-export-record-v1',
            status: exportStatus,
            approvedCount: summary.approved,
            pendingCount,
            failedCount: summary.failed + summary.blocked,
            manifest: exported.manifestPath,
            package: exported.package,
            exportedAt: nowIso(),
          },
          updatedAt: nowIso(),
        });
        await recordActivity(user, 'content_batch_exported', '导出批次内容包：' + batch.title);
        return sendJson(response, {
          ok: true,
          batch: contentBatchResponse(exportedBatch, user),
          export: {
            status: exportStatus,
            approvedCount: summary.approved,
            pendingCount,
            failedCount: summary.failed + summary.blocked,
            manifest: exported.manifestPath,
            package: exported.package,
          },
        });
      }
      if (parts.length === 2) {
        const actionOptions = { now: nowIso() };
        if (action === 'start') {
          if (batch.status === 'waiting_approval') batch = transitionContentBatch(batch, 'approve', user, actionOptions);
          batch = transitionContentBatch(batch, 'start', user, actionOptions);
          contentBatchStore.saveBatch(user, batch);
          if (body.run !== false) batch = await runContentBatch(user, batch);
        } else if (['pause', 'cancel'].includes(action)) {
          batch = transitionContentBatch(batch, action, user, actionOptions);
          contentBatchStore.saveBatch(user, batch);
        } else if (action === 'resume') {
          batch = transitionContentBatch(batch, 'resume', user, actionOptions);
          contentBatchStore.saveBatch(user, batch);
          if (body.run !== false) batch = await runContentBatch(user, batch);
        } else {
          throw new Error('不支持的批次动作：' + action);
        }
        await recordActivity(user, 'content_batch_' + action, '批次操作：' + batch.title + ' / ' + action);
        return sendJson(response, { ok: true, batch: contentBatchResponse(batch, user) });
      }
      if (parts.length === 4 && parts[1] === 'items') {
        const itemId = parts[2];
        const itemAction = parts[3];
        if (itemAction === 'retry') {
          batch = transitionContentBatchItem(batch, itemId, 'retry', user, body);
          if (['partial_failed', 'blocked', 'waiting_review'].includes(batch.status) && summarizeBatch(batch).queued) {
            batch = transitionContentBatch(batch, 'start', user);
          }
          contentBatchStore.saveBatch(user, batch);
          if (body.run !== false) batch = await runContentBatch(user, batch);
        } else if (itemAction === 'postprocess') {
          batch = await postprocessBatchItem(user, batch, itemId, body);
          await recordActivity(user, 'content_batch_item_postprocessed', '批次子任务后处理：' + batch.title + ' / ' + itemId);
        } else if (itemAction === 'review') {
          batch = transitionContentBatchItem(batch, itemId, 'review', user, body);
          batch = transitionContentBatch(batch, 'refresh', user);
          contentBatchStore.saveBatch(user, batch);
        } else {
          throw new Error('不支持的子任务动作：' + itemAction);
        }
        await recordActivity(user, 'content_batch_item_' + itemAction, '批次子任务操作：' + batch.title + ' / ' + itemId);
        return sendJson(response, { ok: true, batch: contentBatchResponse(batch, user) });
      }
      throw new Error('批次接口路径不正确');
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 409);
    }
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
    if (nodeId === 'CE-24' && body.status === 'succeeded') {
      return sendJson(response, {
        ok: false,
        error: '本地/测试闭环不允许把 CE-24 记录为真实发布成功；请使用反馈入口明确跳过外部发布',
        code: 'PUBLISH_OUTSIDE_P0',
      }, 409);
    }
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
    !requestUrl.pathname.includes('/voice-comparisons/') &&
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
    requestUrl.pathname.endsWith('/topic-selection') &&
    request.method === 'POST'
  ) {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(
      requestUrl.pathname.slice('/api/content/tasks/'.length, -'/topic-selection'.length),
    );
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    const body = await readRequestBody(request);
    try {
      const selected = selectContentTopic(task, body, user, {
        selectionId: 'topic_selection_' + randomUUID(),
      });
      await saveContentTask(selected, user, 'content_topic_selected', {
        selectionId: selected.topicSelection?.id,
        candidateIndex: selected.topicSelection?.candidateIndex,
      });
      await recordActivity(user, 'content_topic_selected', '选择内容选题：' + selected.title);
      return sendJson(response, { ok: true, task: selected, selection: selected.topicSelection }, 200);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error), code: error.code || 'TOPIC_SELECTION_ERROR' }, 409);
    }
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

  const voiceComparisonPath = requestUrl.pathname.match(/^\/api\/content\/tasks\/([^/]+)\/voice-comparisons$/);
  if (voiceComparisonPath && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const task = contentTaskById(decodeURIComponent(voiceComparisonPath[1]), user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    const body = await readRequestBody(request);
    try {
      const result = await executeVoiceComparison(task, body, user);
      await recordActivity(user, 'content_voice_comparison', '执行声音 A/B 试听：' + task.title);
      return sendJson(response, { ok: true, ...result }, result.idempotent || result.retried ? 200 : 201);
    } catch (error) {
      const status = error?.code === 'TOOL_UNAVAILABLE' ? 503 : 409;
      return sendJson(response, { ok: false, error: safeError(error), code: error?.code || 'VOICE_COMPARISON_ERROR' }, status);
    }
  }

  const voiceSelectionPath = requestUrl.pathname.match(/^\/api\/content\/tasks\/([^/]+)\/voice-comparisons\/([^/]+)\/select$/);
  if (voiceSelectionPath && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const task = contentTaskById(decodeURIComponent(voiceSelectionPath[1]), user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    const comparisonId = decodeURIComponent(voiceSelectionPath[2]);
    const body = await readRequestBody(request);
    try {
      const result = await selectVoiceComparison(task, comparisonId, body, user);
      await recordActivity(user, 'content_voice_comparison_selected', '选定声音版本：' + task.title);
      return sendJson(response, { ok: true, ...result });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error), code: error?.code || 'VOICE_SELECTION_ERROR' }, 409);
    }
  }

  const voiceReviewPath = requestUrl.pathname.match(/^\/api\/content\/tasks\/([^/]+)\/voice-comparisons\/([^/]+)\/review$/);
  if (voiceReviewPath && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const task = contentTaskById(decodeURIComponent(voiceReviewPath[1]), user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    const comparisonId = decodeURIComponent(voiceReviewPath[2]);
    const body = await readRequestBody(request);
    try {
      const result = await reviewVoiceComparison(task, comparisonId, body, user);
      await recordActivity(user, 'content_voice_comparison_reviewed', '登记声音 A/B 质量评估：' + task.title);
      return sendJson(response, { ok: true, ...result });
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error), code: error?.code || 'VOICE_REVIEW_ERROR' }, 409);
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
      const failedTask = await recordTaskNodeFailure(task, body.nodeId, error, user);
      const status = ['TOOL_UNAVAILABLE', 'TRANSCRIPTION_NOT_CONFIGURED', 'OCR_NOT_CONFIGURED'].includes(error.code) ? 503 : 409;
      return sendJson(response, { ok: false, error: safeError(error), code: error.code || 'NODE_EXECUTION_ERROR', task: failedTask }, status);
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
      const failedTask = await recordTaskNodeFailure(task, 'CE-04', error, user);
      return sendJson(response, { ok: false, error: safeError(error), code: error.code || 'MEDIA_PARSE_ERROR', task: failedTask }, error.code === 'TOOL_UNAVAILABLE' ? 503 : 409);
    }
  }

  if (/^\/api\/content\/tasks\/[^/]+\/assets\/[^/]+\/file$/.test(requestUrl.pathname) && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const pathAfterTasks = requestUrl.pathname.slice('/api/content/tasks/'.length).split('/');
    const taskId = decodeURIComponent(pathAfterTasks[0]);
    const assetId = decodeURIComponent(pathAfterTasks[2]);
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    const asset = workbenchStore.listMediaAssets(user, task.id).find((item) => item.id === assetId);
    if (!asset) return sendJson(response, { ok: false, error: '媒体资产不存在' }, 404);
    const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(asset.mimeType || '') ? asset.mimeType : 'application/octet-stream';
    if (!await streamLocalMediaFile(request, response, asset.path, contentType)) {
      return sendJson(response, { ok: false, error: '媒体文件不可读取' }, 404);
    }
    return;
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
      assertContentMaterialReady(assets);
      const sourceText = taskText(task, assets);
      if (!sourceText) throw new Error('没有可分析的文本、转写或 OCR 内容');
      const structure = analyzeTaskStructure(task, assets);
      const analyzed = await recordReadyTaskNode(task, 'CE-09', {
        status: 'succeeded',
        input: { assetIds: assets.map((asset) => asset.id) },
        output: structure,
        note: '基于当前任务素材和知识索引执行本地结构分析',
      }, user, 'content_structure_analyzed');
      return sendJson(response, { ok: true, task: analyzed, structure });
    } catch (error) {
      const failedTask = await recordTaskNodeFailure(task, 'CE-09', error, user);
      return sendJson(response, { ok: false, error: safeError(error), task: failedTask }, 409);
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
      const nodeId = generationNodeForKind(body.kind)?.nodeId || null;
      const failedTask = nodeId ? await recordTaskNodeFailure(task, nodeId, error, user) : task;
      return sendJson(response, { ok: false, error: safeError(error), code: error.code || 'AI_GENERATION_ERROR', task: failedTask }, status);
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
      assertContentMaterialReady(assets);
      const source = body.assetId ? assets.find((asset) => asset.id === body.assetId) : productionAssetFor(assets, 'video');
      if (!source || source.kind !== 'video') throw new Error('没有可渲染的视频素材');
      const outputPath = join(RENDER_DIR, safeOutputId(task.id) + '-render.mp4');
      const template = contentBatchCatalogFor(user, task.projectId, task.id).templates?.[0] || {};
      const subtitleSegments = Array.isArray(source.metadata?.transcriptResult?.segments)
        ? source.metadata.transcriptResult.segments
        : [];
      const render = await renderVideo(source.path, outputPath, {
        allowedRoots: mediaAllowedRoots(),
        baseDir: DATA_DIR,
        template,
        subtitleSegments,
      });
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
        metadata: {
          render,
          sourceAssetId: source.id,
          transcriptResult: source.metadata?.transcriptResult || null,
        },
        transcript: source.transcript || '',
      }, user);
      const renderedTask = await recordReadyTaskNode(task, 'CE-16', {
        status: 'succeeded',
        input: { sourceAssetId: source.id },
        output: { assetId: renderedAsset.id, ...render, sourceAssetId: source.id },
        note: '使用本地 ffmpeg 完成本地渲染，尚未发布',
      }, user, 'content_render_completed');
      await recordActivity(user, 'content_rendered', '渲染内容：' + task.title);
      return sendJson(response, { ok: true, task: renderedTask, asset: renderedAsset, render });
    } catch (error) {
      const failedTask = await recordTaskNodeFailure(task, 'CE-16', error, user);
      return sendJson(response, { ok: false, error: safeError(error), code: error.code || 'MEDIA_RENDER_ERROR', task: failedTask }, error.code === 'TOOL_UNAVAILABLE' ? 503 : 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && requestUrl.pathname.endsWith('/package') && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(requestUrl.pathname.slice('/api/content/tasks/'.length, -'/package'.length));
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    try {
      const assets = workbenchStore.listMediaAssets(user, task.id);
      assertContentMaterialReady(assets);
      const reviewNode = task.nodes.find((node) => node.id === 'CE-20');
      const latestReview = task.reviews.at(-1);
      if (reviewNode?.status !== 'succeeded' || latestReview?.decision !== 'approved') {
        throw mediaInputError('内容包必须先完成并通过人工审核', 'CONTENT_REVIEW_REQUIRED');
      }
      connectorForCapability(user, 'package.export', task.tenantId);
      const outputPath = join(PACKAGE_DIR, safeOutputId(task.id) + '-content.zip');
      const manifestPath = join(PACKAGE_DIR, safeOutputId(task.id) + '-manifest.json');
      await mkdir(PACKAGE_DIR, { recursive: true });
      await writeFile(manifestPath, JSON.stringify(contentPackageManifest(task, assets), null, 2), 'utf8');
      const files = [...assets.map((asset) => asset.path).filter(Boolean), manifestPath];
      const packaged = await packageFiles(files, outputPath, { baseDir: DATA_DIR });
      let packagedTask = await recordReadyTaskNode(task, 'CE-22', {
        status: 'succeeded',
        input: { assetIds: assets.map((asset) => asset.id) },
        output: { ...packaged, manifest: manifestPath },
        note: '已将素材与选题/脚本/平台版本/分镜/审核/版本信息写入本地交付包，等待人工确认后再进入发布草稿',
      }, user, 'content_package_exported');
      packagedTask = await saveContentTask(normalizeContentTask({
        ...packagedTask,
        status: 'packaged',
        updatedAt: nowIso(),
        updatedBy: actorSnapshot(user),
        run: {
          ...packagedTask.run,
          status: 'succeeded',
          completedAt: nowIso(),
          lastAction: '内容包已导出，等待发布准备',
        },
      }), user, 'content_task_packaged', { packagePath: packaged.path, manifestPath });
      await recordActivity(user, 'content_package_exported', '打包内容：' + task.title);
      return sendJson(response, { ok: true, task: packagedTask, package: { ...packaged, manifest: manifestPath } });
    } catch (error) {
      const failedTask = await recordTaskNodeFailure(task, 'CE-22', error, user);
      return sendJson(response, { ok: false, error: safeError(error), code: error.code || 'PACKAGE_ERROR', task: failedTask }, error.code === 'TOOL_UNAVAILABLE' ? 503 : 409);
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
      const failedTask = await recordTaskNodeFailure(task, 'CE-23', error, user);
      return sendJson(response, { ok: false, error: safeError(error), task: failedTask }, 409);
    }
  }

  if (requestUrl.pathname.startsWith('/api/content/tasks/') && requestUrl.pathname.endsWith('/feedback') && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) return null;
    const taskId = decodeURIComponent(requestUrl.pathname.slice('/api/content/tasks/'.length, -'/feedback'.length));
    const task = contentTaskById(taskId, user);
    if (!task) return sendJson(response, { ok: false, error: '内容任务不存在' }, 404);
    const body = await readRequestBody(request);
    if (typeof body.note === 'string' && body.note.length > 5_000) {
      return sendJson(response, { ok: false, error: '反馈说明不能超过 5000 个字' }, 400);
    }
    if (typeof body.nextAction === 'string' && body.nextAction.length > 2_000) {
      return sendJson(response, { ok: false, error: '下一步不能超过 2000 个字' }, 400);
    }
    if (body.metrics !== undefined && JSON.stringify(body.metrics).length > 10_000) {
      return sendJson(response, { ok: false, error: '反馈指标不能超过 10000 个字符' }, 400);
    }
    try {
      const recorded = recordContentFeedback(task, body, user, {
        feedbackId: 'content_feedback_' + randomUUID(),
      });
      await saveContentTask(recorded, user, 'content_feedback_recorded', {
        feedbackId: recorded.feedback.at(-1)?.id,
        nodeId: 'CE-25',
      });
      await recordActivity(user, 'content_feedback_recorded', '记录内容反馈：' + recorded.title);
      return sendJson(response, { ok: true, task: recorded, feedback: recorded.feedback.at(-1) }, 200);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error), code: error.code || 'CONTENT_FEEDBACK_ERROR' }, 409);
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

  if (requestUrl.pathname === '/api/works/seen-batch' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    const body = await readRequestBody(request);
    const fingerprints = Array.isArray(body.fingerprints)
      ? [...new Set(body.fingerprints.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))]
      : [];
    if (!fingerprints.length) {
      return sendJson(response, { ok: false, error: '至少选择一条作品' }, 400);
    }
    if (fingerprints.length > 500) {
      return sendJson(response, { ok: false, error: '一次最多标记 500 条作品' }, 400);
    }
    const matchedWorks = appState.works.filter(
      (work) => fingerprints.includes(work.fingerprint) && (user.role === 'admin' || work.tenantId === user.tenantId),
    );
    const unreadWorks = matchedWorks.filter((work) => !work.seen);
    unreadWorks.forEach((work) => {
      work.seen = true;
    });
    if (unreadWorks.length) {
      await persist();
      await recordActivity(user, 'work_seen', '批量标记作品已读：' + unreadWorks.length + ' 条');
    }
    return sendJson(response, {
      ok: true,
      markedCount: unreadWorks.length,
      markedFingerprints: unreadWorks.map((work) => work.fingerprint),
    });
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

    const inputContext = body.context && typeof body.context === 'object' ? body.context : {};
    const context = {
      view: typeof inputContext.view === 'string' ? inputContext.view.slice(0, 80) : null,
      route: typeof inputContext.route === 'string' ? inputContext.route.slice(0, 120) : null,
    };

    const feedback = {
      id: 'feedback_' + randomUUID(),
      tenantId: user.tenantId,
      category,
      message,
      state: 'open',
      createdAt: nowIso(),
      createdBy: user.username,
      createdByName: user.displayName,
      context,
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
