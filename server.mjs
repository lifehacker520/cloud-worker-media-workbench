import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalizeInput,
  fetchProfile,
  fingerprintForWork,
  parseProfileHtml,
} from './src/xhs-parser.mjs';
import {
  authConfig,
  authenticate,
  clearSessionCookie,
  currentUser,
  isAdmin,
  sessionCookie,
} from './src/auth.mjs';

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
const SEED_FILE = join(CONFIG_DIR, 'accounts.seed.json');
const SERVER_HOST = process.env.XHS_MONITOR_HOST || '127.0.0.1';
const SERVER_PORT = Number(process.env.XHS_MONITOR_PORT || 3188);
const SERVER_REFRESH_MINUTES = Number(process.env.XHS_REFRESH_MINUTES || 0);

const appState = {
  accounts: [],
  works: [],
  activity: [],
  feedback: [],
  lastRefreshAt: null,
  lastRefreshSummary: null,
  refreshInProgress: false,
  refreshError: null,
};

let refreshPromise = null;

function nowIso() {
  return new Date().toISOString();
}

function accountIdFor(sourceUrl) {
  return 'acct_' + createHash('sha1').update(sourceUrl).digest('hex').slice(0, 12);
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

function migrateWorks(savedWorks) {
  const unique = new Map();
  for (const savedWork of savedWorks) {
    const fingerprint = fingerprintForWork({
      userId: savedWork.userId,
      title: savedWork.title,
      publishedAt: savedWork.publishedAt,
      noteId: savedWork.noteId,
      coverUrl: savedWork.coverUrl,
    });
    const migratedWork = {
      ...savedWork,
      id: 'work_' + fingerprint,
      fingerprint,
    };
    const existing = unique.get(fingerprint);
    if (!existing || (existing.seen && !migratedWork.seen)) {
      unique.set(fingerprint, migratedWork);
    }
  }
  return [...unique.values()];
}

function normalizeAccount(seed) {
  const normalized = canonicalizeInput(seed.sourceUrl);
  return {
    id: seed.id || accountIdFor(normalized.sourceUrl),
    name: seed.name?.trim() || '未命名账号',
    sourceUrl: normalized.sourceUrl,
    shortCode: normalized.shortCode,
    userId: seed.userId || normalized.userId || null,
    canonicalUrl: seed.canonicalUrl || normalized.canonicalUrl || null,
    nickname: seed.nickname || null,
    state: seed.state || 'pending',
    lastCheckedAt: seed.lastCheckedAt || null,
    lastError: null,
    workCount: Number(seed.workCount || 0),
    createdAt: seed.createdAt || nowIso(),
    createdBy: seed.createdBy || 'system',
  };
}

async function ensureData() {
  await mkdir(DATA_DIR, { recursive: true });
  const savedAccounts = await readJson(ACCOUNTS_FILE, null);
  if (Array.isArray(savedAccounts) && savedAccounts.length > 0) {
    appState.accounts = savedAccounts.map((account) => ({
      ...account,
      createdAt: account.createdAt || null,
      createdBy: account.createdBy || 'system',
    }));
  } else {
    const seeds = await readJson(SEED_FILE, []);
    appState.accounts = seeds.map(normalizeAccount);
    await writeJson(ACCOUNTS_FILE, appState.accounts);
  }

  const savedWorks = await readJson(WORKS_FILE, []);
  appState.works = Array.isArray(savedWorks) ? migrateWorks(savedWorks) : [];
  if (Array.isArray(savedWorks) && appState.works.length !== savedWorks.length) {
    await writeJson(WORKS_FILE, appState.works);
  }

  const savedActivity = await readJson(ACTIVITY_FILE, []);
  appState.activity = Array.isArray(savedActivity) ? savedActivity : [];
  const savedFeedback = await readJson(FEEDBACK_FILE, []);
  appState.feedback = Array.isArray(savedFeedback) ? savedFeedback : [];
}

function publicState(user = null) {
  const works = [...appState.works].sort((left, right) => {
    const leftTime = left.publishedAt || left.discoveredAt || '';
    const rightTime = right.publishedAt || right.discoveredAt || '';
    return rightTime.localeCompare(leftTime);
  });
  const activeAccounts = appState.accounts.filter((account) => account.state === 'active').length;
  const unseenWorks = works.filter((work) => !work.seen).length;

  return {
    accounts: appState.accounts,
    works,
    stats: {
      accountCount: appState.accounts.length,
      activeAccountCount: activeAccounts,
      workCount: works.length,
      unseenWorkCount: unseenWorks,
    },
    meta: {
      lastRefreshAt: appState.lastRefreshAt,
      lastRefreshSummary: appState.lastRefreshSummary,
      refreshInProgress: appState.refreshInProgress,
      refreshError: appState.refreshError,
    },
    viewer: user
      ? {
          username: user.username,
          role: user.role,
          displayName: user.displayName,
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
    .replace(/https?:\/\/[^\s)]+/gi, '小红书链接')
    .replace(/xsec_[^&\s]+/gi, 'xsec_token=已隐藏');
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function persist() {
  await Promise.all([
    writeJson(ACCOUNTS_FILE, appState.accounts),
    writeJson(WORKS_FILE, appState.works),
    writeJson(ACTIVITY_FILE, appState.activity),
    writeJson(FEEDBACK_FILE, appState.feedback),
  ]);
}

async function recordActivity(actor, type, detail) {
  appState.activity.unshift({
    id: 'activity_' + randomUUID(),
    createdAt: nowIso(),
    actor: actor?.username || 'system',
    actorName: actor?.displayName || '系统',
    type,
    detail,
  });
  appState.activity = appState.activity.slice(0, 500);
  await writeJson(ACTIVITY_FILE, appState.activity);
}

async function refreshOne(account) {
  const checkedAt = nowIso();
  try {
    const fetched = await fetchProfile(account.canonicalUrl || account.sourceUrl, {
      signal: AbortSignal.timeout(25000),
    });
    const parsed = parseProfileHtml(fetched.html, fetched.canonicalUrl, fetched.userId);
    const previousWorks = appState.works.filter((work) => work.accountId === account.id);
    const previousKeys = new Set(previousWorks.map((work) => work.fingerprint));
    const isBaseline = previousWorks.length === 0;
    let newWorks = 0;

    for (const parsedWork of parsed.works) {
      const fingerprint =
        parsedWork.fingerprint ||
        fingerprintForWork({
          userId: fetched.userId,
          title: parsedWork.title,
          publishedAt: parsedWork.publishedAt,
          noteId: parsedWork.noteId,
          coverUrl: parsedWork.coverUrl,
        });
      if (previousKeys.has(fingerprint)) {
        continue;
      }

      appState.works.push({
        id: 'work_' + fingerprint,
        accountId: account.id,
        userId: fetched.userId,
        title: parsedWork.title,
        publishedAt: parsedWork.publishedAt,
        noteId: parsedWork.noteId,
        likes: parsedWork.likes,
        coverUrl: parsedWork.coverUrl,
        link: parsedWork.link,
        fingerprint,
        discoveredAt: checkedAt,
        seen: isBaseline,
        extraction: parsedWork.extraction,
      });
      previousKeys.add(fingerprint);
      if (!isBaseline) {
        newWorks += 1;
      }
    }

    account.userId = fetched.userId;
    account.canonicalUrl = fetched.canonicalUrl;
    account.nickname = parsed.nickname || account.nickname || account.name;
    account.state = 'active';
    account.lastCheckedAt = checkedAt;
    account.lastError = null;
    account.workCount = appState.works.filter((work) => work.accountId === account.id).length;

    return {
      accountId: account.id,
      ok: true,
      parsedCount: parsed.works.length,
      newWorks,
      extraction: parsed.extraction,
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

async function refreshAll(actor = { username: 'system', displayName: '系统' }) {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const startedAt = Date.now();
    appState.refreshInProgress = true;
    appState.refreshError = null;
    const results = [];

    try {
      for (const account of appState.accounts) {
        results.push(await refreshOne(account));
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

  if (requestUrl.pathname === '/api/auth/logout' && request.method === 'POST') {
    return sendJson(response, { ok: true }, 200, {
      'set-cookie': clearSessionCookie(),
    });
  }

  if (requestUrl.pathname === '/api/health' && request.method === 'GET') {
    return sendJson(response, {
      ok: true,
      service: 'xhs-content-monitor-demo',
      time: nowIso(),
      refreshInProgress: appState.refreshInProgress,
      authRequired: authConfig().required,
      refreshIntervalMinutes: SERVER_REFRESH_MINUTES,
    });
  }

  if (requestUrl.pathname === '/api/state' && request.method === 'GET') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    return sendJson(response, publicState(user));
  }

  if (requestUrl.pathname === '/api/refresh' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    const summary = await refreshAll(user);
    return sendJson(response, { ok: true, summary, state: publicState(user) });
  }

  if (requestUrl.pathname === '/api/accounts' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    const body = await readRequestBody(request);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const sourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
    if (!name || !sourceUrl) {
      return sendJson(response, { ok: false, error: '账号名称和主页链接不能为空' }, 400);
    }

    let normalized;
    try {
      normalized = canonicalizeInput(sourceUrl);
    } catch (error) {
      return sendJson(response, { ok: false, error: safeError(error) }, 400);
    }

    const duplicate = appState.accounts.find(
      (account) =>
        account.sourceUrl === normalized.sourceUrl ||
        (normalized.userId && account.userId === normalized.userId),
    );
    if (duplicate) {
      return sendJson(response, { ok: false, error: '这个账号已经在监控列表中' }, 409);
    }

    const account = normalizeAccount({
      name,
      sourceUrl: normalized.sourceUrl,
      createdAt: nowIso(),
      createdBy: user.username,
    });
    appState.accounts.push(account);
    await persist();
    await recordActivity(user, 'account_added', '加入监控账号：' + name);
    return sendJson(response, { ok: true, account }, 201);
  }

  if (requestUrl.pathname === '/api/works/seen' && request.method === 'POST') {
    const user = authorizedUser(request, response);
    if (!user) {
      return null;
    }
    const body = await readRequestBody(request);
    const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : '';
    const work = appState.works.find((item) => item.fingerprint === fingerprint);
    if (!work) {
      return sendJson(response, { ok: false, error: '作品不存在' }, 404);
    }
    work.seen = true;
    await writeJson(WORKS_FILE, appState.works);
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
      '销售内容雷达已启动：http://' + SERVER_HOST + ':' + SERVER_PORT,
    );
    console.log('监控账号：' + appState.accounts.length + ' 个；首次刷新可能需要几十秒');
    if (SERVER_REFRESH_MINUTES > 0) {
      console.log('服务端自动刷新：每 ' + SERVER_REFRESH_MINUTES + ' 分钟');
      const refreshTimer = setInterval(() => {
        refreshAll().catch((error) => {
          console.error('[scheduled-refresh-error]', safeError(error));
        });
      }, SERVER_REFRESH_MINUTES * 60 * 1000);
      refreshTimer.unref();
    }
    refreshAll().catch((error) => {
      console.error('[startup-refresh-error]', safeError(error));
    });
  });
}

start().catch((error) => {
  console.error('[startup-error]', error);
  process.exitCode = 1;
});
