import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  backupDirectory,
  createWorkbenchBackup,
  listWorkbenchBackups,
  pruneWorkbenchBackups,
  restoreWorkbenchBackupToDirectory,
  verifyWorkbenchBackup,
} from './workbench-backup.mjs';

const DEFAULT_TENANT_ID = 'tenant_local';
const DEFAULT_PROJECT_SLUG = 'content-editor';
const MEMBER_USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const PROJECT_MEMBER_ROLES = new Set(['owner', 'manager', 'member', 'reviewer']);
const DIRECTORY_MEMBER_ROLES = new Set(['client', 'admin']);
const DIRECTORY_MEMBER_STATUSES = new Set(['active', 'disabled']);

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS brand_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  voice TEXT NOT NULL DEFAULT '',
  constraints_json TEXT NOT NULL DEFAULT '{}',
  source_document_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_configured',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  subject_username TEXT NOT NULL,
  permission TEXT NOT NULL,
  effect TEXT NOT NULL DEFAULT 'allow',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, connector_id, subject_username, permission)
);

CREATE TABLE IF NOT EXISTS workspace_invitations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'client',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  member_role TEXT NOT NULL DEFAULT 'member',
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  accepted_by TEXT NOT NULL DEFAULT '',
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS directory_sync_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  source TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'apply',
  summary_json TEXT NOT NULL DEFAULT '{}',
  actor_username TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  brand_profile_id TEXT REFERENCES brand_profiles(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES content_tasks(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  run_id TEXT,
  sequence INTEGER,
  type TEXT NOT NULL,
  actor_username TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT REFERENCES content_tasks(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'parsed',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  text_content TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL DEFAULT '',
  ocr_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT REFERENCES content_tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_path TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS release_drafts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES content_tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  approved_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitoring_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitoring_works (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  account_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitoring_activity (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitoring_feedback (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitoring_metric_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  work_id TEXT,
  metric_key TEXT NOT NULL,
  value_numeric REAL NOT NULL,
  observed_at TEXT NOT NULL,
  as_of TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'available',
  coverage TEXT NOT NULL DEFAULT 'observed',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitoring_comments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  work_id TEXT,
  external_id TEXT,
  comment_text TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '匿名用户',
  author_id TEXT,
  comment_created_at TEXT,
  like_count REAL,
  reply_count REAL,
  source TEXT NOT NULL DEFAULT 'unknown',
  fetched_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function nowIso() {
  return new Date().toISOString();
}

function jsonParse(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function jsonStringify(value, fallback = '{}') {
  try {
    return JSON.stringify(value ?? JSON.parse(fallback));
  } catch {
    return fallback;
  }
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function userIdFor(username) {
  return 'user_' + createHash('sha1').update(username).digest('hex').slice(0, 16);
}

function projectIdFor(tenantId, slug) {
  return 'project_' + createHash('sha1').update(tenantId + '\u0000' + slug).digest('hex').slice(0, 16);
}

function connectorIdFor(tenantId, slug) {
  return 'connector_' + createHash('sha1').update(tenantId + '\u0000' + slug).digest('hex').slice(0, 16);
}

function tenantIdFor(actor) {
  return text(actor?.tenantId, DEFAULT_TENANT_ID);
}

function actorUsername(actor) {
  return text(actor?.username, 'system');
}

function actorDisplayName(actor) {
  return text(actor?.displayName, actorUsername(actor));
}

function normalizeUsername(value) {
  return text(value).toLowerCase();
}

function normalizeMemberUsername(value) {
  const username = normalizeUsername(value);
  if (!MEMBER_USERNAME_PATTERN.test(username)) {
    throw new Error('成员账号需使用 2 到 64 位字母、数字、点、下划线或短横线');
  }
  if (['admin', 'client', 'local', 'migration'].includes(username)) {
    throw new Error('admin、client、local、migration 是保留账号，请继续使用环境变量或系统迁移管理');
  }
  return username;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new Error('成员密码长度需为 8 到 200 位');
  }
  return password;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return {
    salt,
    hash: scryptSync(validatePassword(password), salt, 32).toString('hex'),
  };
}

function invitationTokenHash(token) {
  const normalized = text(token);
  if (normalized.length < 32 || normalized.length > 300) throw new Error('邀请令牌无效');
  return createHash('sha256').update(normalized).digest('hex');
}

function publicUserRow(row) {
  return row
    ? {
        id: row.id,
        username: row.username,
        displayName: row.display_name ?? row.displayName,
        role: row.role,
        tenantId: row.tenant_id ?? row.tenantId,
        status: row.status,
        createdAt: row.created_at ?? row.createdAt,
        updatedAt: row.updated_at ?? row.updatedAt,
      }
    : null;
}

function publicInvitationRow(row) {
  return row
    ? {
        id: row.id,
        tenantId: row.tenant_id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        projectId: row.project_id,
        memberRole: row.member_role,
        status: row.status,
        expiresAt: row.expires_at,
        invitedBy: row.invited_by,
        acceptedBy: row.accepted_by || null,
        acceptedAt: row.accepted_at || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function rowToProject(row) {
  return row
    ? {
        id: row.id,
        tenantId: row.tenant_id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function rowToCustomer(row) {
  return row
    ? {
        id: row.id,
        tenantId: row.tenant_id,
        name: row.name,
        industry: row.industry,
        status: row.status,
        metadata: jsonParse(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function rowToBrandProfile(row) {
  return row
    ? {
        id: row.id,
        tenantId: row.tenant_id,
        projectId: row.project_id,
        customerId: row.customer_id,
        name: row.name,
        voice: row.voice,
        constraints: jsonParse(row.constraints_json, {}),
        sourceDocumentIds: jsonParse(row.source_document_ids_json, []),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function rowToContentTask(row) {
  if (!row) return null;
  const payload = jsonParse(row.payload_json, null);
  if (!payload) return null;
  return {
    ...payload,
    customerId: payload.customerId ?? row.customer_id ?? null,
    brandProfileId: payload.brandProfileId ?? row.brand_profile_id ?? null,
  };
}

function rowToConnector(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    capabilities: jsonParse(row.capabilities_json, []),
    config: jsonParse(row.config_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkbenchStore {
  constructor(db, dataDir) {
    this.db = db;
    this.dataDir = dataDir;
    this.ftsEnabled = false;
  }

  static async open(dataDir) {
    await mkdir(dataDir, { recursive: true });
    const db = new DatabaseSync(join(dataDir, 'workbench.sqlite'), { timeout: 30_000 });
    db.exec('PRAGMA busy_timeout = 30000;');
    db.exec(SCHEMA);
    const store = new WorkbenchStore(db, dataDir);
    store.ensureSchemaMigrations();
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_documents_fts
        USING fts5(id UNINDEXED, tenant_id UNINDEXED, project_id UNINDEXED, title, content);
      `);
      store.ftsEnabled = true;
    } catch {
      store.ftsEnabled = false;
    }
    return store;
  }

  ensureSchemaMigrations() {
    const columns = new Set(this.db.prepare('PRAGMA table_info(content_task_events)').all().map((row) => row.name));
    if (!columns.has('run_id')) this.db.exec('ALTER TABLE content_task_events ADD COLUMN run_id TEXT');
    if (!columns.has('sequence')) this.db.exec('ALTER TABLE content_task_events ADD COLUMN sequence INTEGER');
    const taskColumns = new Set(this.db.prepare('PRAGMA table_info(content_tasks)').all().map((row) => row.name));
    if (!taskColumns.has('customer_id')) this.db.exec('ALTER TABLE content_tasks ADD COLUMN customer_id TEXT');
    if (!taskColumns.has('brand_profile_id')) this.db.exec('ALTER TABLE content_tasks ADD COLUMN brand_profile_id TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_content_task_events_replay ON content_task_events (task_id, run_id, sequence, created_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers (tenant_id, updated_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_brand_profiles_project ON brand_profiles (project_id, updated_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_monitoring_metric_tenant_time ON monitoring_metric_snapshots (tenant_id, observed_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_monitoring_metric_account_work ON monitoring_metric_snapshots (account_id, work_id, metric_key, observed_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_monitoring_comments_tenant_time ON monitoring_comments (tenant_id, comment_created_at, fetched_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_monitoring_comments_account_work ON monitoring_comments (account_id, work_id, comment_created_at)');
  }

  close() {
    this.db.close();
  }

  createBackup(options = {}) {
    return createWorkbenchBackup({ ...options, dataDir: this.dataDir, db: this.db });
  }

  listBackups() {
    return listWorkbenchBackups(this.dataDir);
  }

  verifyBackup(backupId, options = {}) {
    return verifyWorkbenchBackup(backupDirectory(this.dataDir, backupId), options);
  }

  restoreBackup(backupId, targetDir, options = {}) {
    return restoreWorkbenchBackupToDirectory({
      backupDir: backupDirectory(this.dataDir, backupId),
      targetDir,
      ...options,
    });
  }

  pruneBackups(options = {}) {
    return pruneWorkbenchBackups(this.dataDir, options);
  }

  monitoringCounts() {
    const tables = ['monitoring_accounts', 'monitoring_works', 'monitoring_activity', 'monitoring_feedback'];
    const counts = Object.fromEntries(tables.map((table) => [
      table,
      Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count || 0),
    ]));
    return { ...counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0) };
  }

  replaceMonitoringData(data = {}) {
    const timestamp = nowIso();
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const works = Array.isArray(data.works) ? data.works : [];
    const activity = Array.isArray(data.activity) ? data.activity : [];
    const feedback = Array.isArray(data.feedback) ? data.feedback : [];
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM monitoring_accounts; DELETE FROM monitoring_works; DELETE FROM monitoring_activity; DELETE FROM monitoring_feedback;');
      const accountStatement = this.db.prepare(`INSERT INTO monitoring_accounts (id, tenant_id, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
      for (const item of accounts) {
        const id = text(item?.id, 'account_' + randomUUID());
        const tenantId = text(item?.tenantId, DEFAULT_TENANT_ID);
        const createdAt = text(item?.createdAt, timestamp);
        accountStatement.run(id, tenantId, JSON.stringify({ ...item, id, tenantId }), createdAt, text(item?.updatedAt, createdAt));
      }
      const workStatement = this.db.prepare(`INSERT INTO monitoring_works (id, tenant_id, fingerprint, account_id, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const item of works) {
        const id = text(item?.id, 'work_' + randomUUID());
        const tenantId = text(item?.tenantId, DEFAULT_TENANT_ID);
        const fingerprint = text(item?.fingerprint, id);
        const accountId = text(item?.accountId, 'unknown');
        const createdAt = text(item?.discoveredAt, text(item?.createdAt, timestamp));
        workStatement.run(id, tenantId, fingerprint, accountId, JSON.stringify({ ...item, id, tenantId, fingerprint, accountId }), createdAt, text(item?.updatedAt, createdAt));
      }
      const activityStatement = this.db.prepare(`INSERT INTO monitoring_activity (id, tenant_id, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
      for (const item of activity) {
        const id = text(item?.id, 'activity_' + randomUUID());
        const tenantId = text(item?.tenantId, DEFAULT_TENANT_ID);
        const createdAt = text(item?.createdAt, timestamp);
        activityStatement.run(id, tenantId, JSON.stringify({ ...item, id, tenantId }), createdAt, createdAt);
      }
      const feedbackStatement = this.db.prepare(`INSERT INTO monitoring_feedback (id, tenant_id, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
      for (const item of feedback) {
        const id = text(item?.id, 'feedback_' + randomUUID());
        const tenantId = text(item?.tenantId, DEFAULT_TENANT_ID);
        const createdAt = text(item?.createdAt, timestamp);
        feedbackStatement.run(id, tenantId, JSON.stringify({ ...item, id, tenantId }), createdAt, createdAt);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.monitoringCounts();
  }

  listMonitoringData(actor) {
    const userTenant = text(actor?.tenantId, DEFAULT_TENANT_ID);
    const scope = actor?.role === 'admin' ? '' : ' WHERE tenant_id = ?';
    const params = actor?.role === 'admin' ? [] : [userTenant];
    const read = (table) => this.db.prepare(`SELECT payload_json FROM ${table}${scope} ORDER BY created_at DESC`).all(...params)
      .map((row) => jsonParse(row.payload_json, null)).filter(Boolean);
    return {
      accounts: read('monitoring_accounts'),
      works: read('monitoring_works'),
      activity: read('monitoring_activity'),
      feedback: read('monitoring_feedback'),
    };
  }

  saveMonitoringMetricSnapshots(items = []) {
    const timestamp = nowIso();
    const statement = this.db.prepare(`
      INSERT INTO monitoring_metric_snapshots (
        id, tenant_id, platform, account_id, work_id, metric_key, value_numeric,
        observed_at, as_of, source, status, coverage, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        value_numeric = excluded.value_numeric,
        observed_at = excluded.observed_at,
        as_of = excluded.as_of,
        source = excluded.source,
        status = excluded.status,
        coverage = excluded.coverage,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `);
    this.db.exec('BEGIN');
    try {
      for (const item of Array.isArray(items) ? items : []) {
        if (!item?.id || !item?.accountId || !item?.metricKey || !Number.isFinite(Number(item.value))) {
          continue;
        }
        const observedAt = text(item.observedAt, timestamp);
        statement.run(
          text(item.id, 'metric_' + randomUUID()),
          text(item.tenantId, DEFAULT_TENANT_ID),
          text(item.platform, 'other'),
          text(item.accountId, 'unknown'),
          item.workId ? text(item.workId) : null,
          text(item.metricKey, 'unknown'),
          Number(item.value),
          observedAt,
          text(item.asOf, observedAt),
          text(item.source, 'unknown'),
          text(item.status, 'available'),
          text(item.coverage, 'observed'),
          JSON.stringify(item.metadata && typeof item.metadata === 'object' ? item.metadata : {}),
          text(item.createdAt, timestamp),
          text(item.updatedAt, timestamp),
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listMonitoringMetricSnapshots({ role: 'admin' });
  }

  listMonitoringMetricSnapshots(actor, options = {}) {
    const userTenant = text(actor?.tenantId, DEFAULT_TENANT_ID);
    const conditions = [];
    const params = [];
    if (actor?.role !== 'admin') {
      conditions.push('tenant_id = ?');
      params.push(userTenant);
    }
    if (options.accountId && options.accountId !== 'all') {
      conditions.push('account_id = ?');
      params.push(options.accountId);
    }
    if (options.platform && options.platform !== 'all') {
      conditions.push('platform = ?');
      params.push(options.platform);
    }
    const limit = Math.min(Math.max(Number(options.limit) || 5000, 1), 20000);
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    return this.db.prepare(`SELECT * FROM monitoring_metric_snapshots${where} ORDER BY observed_at DESC LIMIT ${limit}`).all(...params).map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      platform: row.platform,
      accountId: row.account_id,
      workId: row.work_id,
      metricKey: row.metric_key,
      value: row.value_numeric,
      observedAt: row.observed_at,
      asOf: row.as_of,
      source: row.source,
      status: row.status,
      coverage: row.coverage,
      metadata: jsonParse(row.metadata_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  saveMonitoringComments(items = []) {
    const timestamp = nowIso();
    const statement = this.db.prepare(`
      INSERT INTO monitoring_comments (
        id, tenant_id, platform, account_id, work_id, external_id, comment_text,
        author_name, author_id, comment_created_at, like_count, reply_count,
        source, fetched_at, status, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        work_id = excluded.work_id,
        comment_text = excluded.comment_text,
        author_name = excluded.author_name,
        author_id = excluded.author_id,
        comment_created_at = excluded.comment_created_at,
        like_count = excluded.like_count,
        reply_count = excluded.reply_count,
        source = excluded.source,
        fetched_at = excluded.fetched_at,
        status = excluded.status,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `);
    this.db.exec('BEGIN');
    try {
      for (const item of Array.isArray(items) ? items : []) {
        if (!item?.id || !item?.accountId || !item?.text) {
          continue;
        }
        statement.run(
          text(item.id, 'comment_' + randomUUID()),
          text(item.tenantId, DEFAULT_TENANT_ID),
          text(item.platform, 'other'),
          text(item.accountId, 'unknown'),
          item.workId ? text(item.workId) : null,
          item.externalId ? text(item.externalId) : null,
          text(item.text),
          text(item.authorName, '匿名用户'),
          item.authorId ? text(item.authorId) : null,
          item.createdAt ? text(item.createdAt) : null,
          Number.isFinite(Number(item.likeCount)) ? Number(item.likeCount) : null,
          Number.isFinite(Number(item.replyCount)) ? Number(item.replyCount) : null,
          text(item.source, 'unknown'),
          text(item.fetchedAt, timestamp),
          text(item.status, 'available'),
          JSON.stringify(item.metadata && typeof item.metadata === 'object' ? item.metadata : {}),
          text(item.createdAt, timestamp),
          text(item.updatedAt, timestamp),
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listMonitoringComments({ role: 'admin' });
  }

  listMonitoringComments(actor, options = {}) {
    const userTenant = text(actor?.tenantId, DEFAULT_TENANT_ID);
    const conditions = [];
    const params = [];
    if (actor?.role !== 'admin') {
      conditions.push('tenant_id = ?');
      params.push(userTenant);
    }
    if (options.accountId && options.accountId !== 'all') {
      conditions.push('account_id = ?');
      params.push(options.accountId);
    }
    if (options.platform && options.platform !== 'all') {
      conditions.push('platform = ?');
      params.push(options.platform);
    }
    const limit = Math.min(Math.max(Number(options.limit) || 2000, 1), 10000);
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    return this.db.prepare(`SELECT * FROM monitoring_comments${where} ORDER BY COALESCE(comment_created_at, fetched_at) DESC LIMIT ${limit}`).all(...params).map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      platform: row.platform,
      accountId: row.account_id,
      workId: row.work_id,
      externalId: row.external_id,
      text: row.comment_text,
      authorName: row.author_name,
      authorId: row.author_id,
      createdAt: row.comment_created_at,
      likeCount: row.like_count,
      replyCount: row.reply_count,
      source: row.source,
      fetchedAt: row.fetched_at,
      status: row.status,
      metadata: jsonParse(row.metadata_json, {}),
      createdAtRow: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  ensureTenant(actor, options = {}) {
    const timestamp = options.now || nowIso();
    const id = tenantIdFor(actor);
    const name = text(options.name, text(actor?.tenantName, id === DEFAULT_TENANT_ID ? '本地客户工作区' : id));
    this.db.prepare(`
      INSERT INTO tenants (id, name, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
    `).run(id, name, timestamp, timestamp);
    return { id, name, status: 'active' };
  }

  ensureUser(actor, options = {}) {
    const timestamp = options.now || nowIso();
    const tenant = this.ensureTenant(actor, options);
    const username = actorUsername(actor);
    const id = userIdFor(username);
    const existing = this.db.prepare('SELECT status FROM users WHERE username = ?').get(username);
    if (existing?.status === 'disabled') throw new Error('成员已停用');
    this.db.prepare(`
      INSERT INTO users (id, username, display_name, role, tenant_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        display_name = excluded.display_name,
        role = excluded.role,
        tenant_id = excluded.tenant_id,
        updated_at = excluded.updated_at
    `).run(id, username, actorDisplayName(actor), text(actor?.role, 'client'), tenant.id, timestamp, timestamp);
    return { id, username, displayName: actorDisplayName(actor), role: text(actor?.role, 'client'), tenantId: tenant.id };
  }

  ensureProject(actor, options = {}) {
    const timestamp = options.now || nowIso();
    const user = this.ensureUser(actor, options);
    const slug = text(options.slug, DEFAULT_PROJECT_SLUG).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || DEFAULT_PROJECT_SLUG;
    const existing = this.db.prepare('SELECT * FROM projects WHERE tenant_id = ? AND slug = ?').get(user.tenantId, slug);
    const id = existing?.id || text(options.id, projectIdFor(user.tenantId, slug));
    const name = text(options.name, slug === DEFAULT_PROJECT_SLUG ? '内容编辑云员工' : slug);
    this.db.prepare(`
      INSERT INTO projects (id, tenant_id, slug, name, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, updated_at = excluded.updated_at
    `).run(id, user.tenantId, slug, name, text(options.description), timestamp, timestamp);
    this.db.prepare(`
      INSERT INTO project_members (project_id, user_id, member_role, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET member_role = excluded.member_role
    `).run(id, user.id, user.role === 'admin' ? 'owner' : 'member', timestamp);
    return rowToProject(this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
  }

  ensureContext(actor, projectId = null) {
    const user = this.ensureUser(actor);
    const project = projectId
      ? rowToProject(this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId))
      : this.ensureProject(actor);
    if (!project) {
      throw new Error('项目不存在');
    }
    this.assertTenantAccess(actor, project.tenantId);
    if (!this.canAccessProject(actor, project.id)) {
      throw new Error('没有访问该项目的权限');
    }
    return { user, project, tenantId: project.tenantId };
  }

  assertTenantAccess(actor, tenantId) {
    if (actor?.role === 'admin') return true;
    if (tenantId !== tenantIdFor(actor)) {
      throw new Error('没有访问该客户工作区的权限');
    }
    return true;
  }

  canAccessProject(actor, projectId) {
    if (actor?.role === 'admin') return true;
    const user = this.ensureUser(actor);
    return Boolean(this.db.prepare(`
      SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?
    `).get(projectId, user.id));
  }

  listTenants(actor) {
    if (actor?.role === 'admin') {
      return this.db.prepare('SELECT id, name, status, created_at AS createdAt, updated_at AS updatedAt FROM tenants ORDER BY created_at').all();
    }
    this.assertTenantAccess(actor, tenantIdFor(actor));
    return this.db.prepare('SELECT id, name, status, created_at AS createdAt, updated_at AS updatedAt FROM tenants WHERE id = ?').all(tenantIdFor(actor));
  }

  listProjects(actor) {
    const user = this.ensureUser(actor);
    const rows = actor?.role === 'admin'
      ? this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all()
      : this.db.prepare(`
          SELECT p.* FROM projects p
          JOIN project_members pm ON pm.project_id = p.id
          WHERE pm.user_id = ? AND p.tenant_id = ?
          ORDER BY p.updated_at DESC
        `).all(user.id, user.tenantId);
    return rows.map(rowToProject);
  }

  createProject(actor, input = {}) {
    if (actor?.role !== 'admin') {
      throw new Error('只有管理员可以创建项目');
    }
    const tenantId = text(input.tenantId, tenantIdFor(actor));
    this.assertTenantAccess(actor, tenantId);
    if (!this.db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(tenantId)) {
      this.ensureTenant({ ...actor, tenantId }, { name: input.tenantName || tenantId });
    }
    const timestamp = nowIso();
    const slug = text(input.slug, input.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) throw new Error('项目标识不能为空');
    const id = text(input.id, projectIdFor(tenantId, slug));
    const project = rowToProject(this.db.prepare(`
      INSERT INTO projects (id, tenant_id, slug, name, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      RETURNING *
    `).get(id, tenantId, slug, text(input.name, slug), text(input.description), timestamp, timestamp));
    return project;
  }

  createCustomer(actor, input = {}) {
    if (actor?.role !== 'admin') throw new Error('只有管理员可以创建客户上下文');
    const tenantId = text(input.tenantId, tenantIdFor(actor));
    this.assertTenantAccess(actor, tenantId);
    if (!this.db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(tenantId)) {
      this.ensureTenant({ ...actor, tenantId }, { name: input.tenantName || tenantId });
    }
    const name = text(input.name);
    if (!name) throw new Error('客户名称不能为空');
    if (name.length > 200) throw new Error('客户名称不能超过 200 个字');
    const status = ['active', 'archived', 'disabled'].includes(input.status) ? input.status : 'active';
    const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata
      : {};
    const timestamp = nowIso();
    const id = text(input.id, 'customer_' + randomUUID());
    const existing = this.db.prepare('SELECT tenant_id FROM customers WHERE id = ?').get(id);
    if (existing && existing.tenant_id !== tenantId) throw new Error('客户上下文已经属于其他客户工作区');
    const row = this.db.prepare(`
      INSERT INTO customers (id, tenant_id, name, industry, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        industry = excluded.industry,
        status = excluded.status,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
      RETURNING *
    `).get(
      id,
      tenantId,
      name,
      text(input.industry),
      status,
      JSON.stringify(metadata),
      existing ? this.db.prepare('SELECT created_at FROM customers WHERE id = ?').get(id).created_at : timestamp,
      timestamp,
    );
    return rowToCustomer(row);
  }

  listCustomers(actor, tenantId = null) {
    const user = this.ensureUser(actor);
    const targetTenant = text(tenantId, actor?.role === 'admin' ? '' : user.tenantId);
    if (actor?.role !== 'admin') this.assertTenantAccess(actor, targetTenant || user.tenantId);
    return this.db.prepare(`
      SELECT * FROM customers ${targetTenant ? 'WHERE tenant_id = ?' : ''} ORDER BY updated_at DESC, created_at DESC
    `).all(...(targetTenant ? [targetTenant] : [])).map(rowToCustomer);
  }

  getCustomer(actor, customerId) {
    const row = this.db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!row) return null;
    this.assertTenantAccess(actor, row.tenant_id);
    return rowToCustomer(row);
  }

  createBrandProfile(actor, input = {}) {
    if (actor?.role !== 'admin') throw new Error('只有管理员可以创建品牌资料');
    const projectId = text(input.projectId);
    const customerId = text(input.customerId);
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) throw new Error('项目不存在');
    const tenantId = text(input.tenantId, project.tenant_id);
    this.assertTenantAccess(actor, tenantId);
    if (project.tenant_id !== tenantId) throw new Error('品牌资料和项目不属于同一客户工作区');
    const customer = this.db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) throw new Error('客户上下文不存在');
    if (customer.tenant_id !== tenantId) throw new Error('品牌资料和客户不属于同一客户工作区');
    const name = text(input.name);
    if (!name) throw new Error('品牌资料名称不能为空');
    if (name.length > 200) throw new Error('品牌资料名称不能超过 200 个字');
    const constraints = input.constraints && typeof input.constraints === 'object' && !Array.isArray(input.constraints)
      ? input.constraints
      : {};
    const sourceDocumentIds = Array.isArray(input.sourceDocumentIds)
      ? input.sourceDocumentIds.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, 100)
      : [];
    const timestamp = nowIso();
    const id = text(input.id, 'brand_profile_' + randomUUID());
    const existing = this.db.prepare('SELECT tenant_id, created_at FROM brand_profiles WHERE id = ?').get(id);
    if (existing && existing.tenant_id !== tenantId) throw new Error('品牌资料已经属于其他客户工作区');
    const row = this.db.prepare(`
      INSERT INTO brand_profiles (
        id, tenant_id, project_id, customer_id, name, voice, constraints_json,
        source_document_ids_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        customer_id = excluded.customer_id,
        name = excluded.name,
        voice = excluded.voice,
        constraints_json = excluded.constraints_json,
        source_document_ids_json = excluded.source_document_ids_json,
        status = excluded.status,
        updated_at = excluded.updated_at
      RETURNING *
    `).get(
      id,
      tenantId,
      projectId,
      customerId,
      name,
      text(input.voice),
      JSON.stringify(constraints),
      JSON.stringify(sourceDocumentIds),
      existing?.created_at || timestamp,
      timestamp,
    );
    return rowToBrandProfile(row);
  }

  listBrandProfiles(actor, projectId = null, tenantId = null) {
    const user = this.ensureUser(actor);
    const project = projectId ? this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) : null;
    if (projectId && !project) throw new Error('项目不存在');
    if (project) {
      this.assertTenantAccess(actor, project.tenant_id);
      if (!this.canAccessProject(actor, project.id)) throw new Error('没有访问该项目的权限');
    }
    const targetTenant = text(tenantId, project?.tenant_id || (actor?.role === 'admin' ? '' : user.tenantId));
    if (targetTenant) this.assertTenantAccess(actor, targetTenant);
    const conditions = [];
    const params = [];
    if (targetTenant) {
      conditions.push('tenant_id = ?');
      params.push(targetTenant);
    }
    if (projectId) {
      conditions.push('project_id = ?');
      params.push(projectId);
    }
    return this.db.prepare(`
      SELECT * FROM brand_profiles ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY updated_at DESC, created_at DESC
    `).all(...params).map(rowToBrandProfile);
  }

  getBrandProfile(actor, brandProfileId) {
    const row = this.db.prepare('SELECT * FROM brand_profiles WHERE id = ?').get(brandProfileId);
    if (!row) return null;
    this.assertTenantAccess(actor, row.tenant_id);
    if (!this.canAccessProject(actor, row.project_id)) throw new Error('没有访问该项目的权限');
    return rowToBrandProfile(row);
  }

  listUsers(actor, tenantId = null) {
    const user = this.ensureUser(actor);
    if (actor?.role !== 'admin') {
      this.assertTenantAccess(actor, user.tenantId);
      return this.db.prepare(`
        SELECT id, username, display_name AS displayName, role, tenant_id AS tenantId, status,
               created_at AS createdAt, updated_at AS updatedAt
        FROM users WHERE id = ?
      `).all(user.id);
    }
    const targetTenant = text(tenantId);
    if (targetTenant) this.assertTenantAccess(actor, targetTenant);
    return this.db.prepare(`
      SELECT id, username, display_name AS displayName, role, tenant_id AS tenantId, status,
             created_at AS createdAt, updated_at AS updatedAt
      FROM users ${targetTenant ? 'WHERE tenant_id = ?' : ''} ORDER BY created_at
    `).all(...(targetTenant ? [targetTenant] : []));
  }

  createUser(actor, input = {}) {
    if (actor?.role !== 'admin') throw new Error('只有管理员可以创建工作台成员');
    const username = normalizeMemberUsername(input.username);
    const role = ['client', 'admin'].includes(input.role) ? input.role : 'client';
    const tenantId = text(input.tenantId, tenantIdFor(actor));
    this.assertTenantAccess(actor, tenantId);
    if (input.password !== undefined) validatePassword(input.password);
    if (!this.db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(tenantId)) {
      this.ensureTenant({ ...actor, tenantId }, { name: input.tenantName || tenantId });
    }
    if (input.projectId) {
      const project = this.db.prepare('SELECT tenant_id FROM projects WHERE id = ?').get(input.projectId);
      if (!project) throw new Error('项目不存在');
      if (project.tenant_id !== tenantId) throw new Error('成员和项目不属于同一客户工作区');
    }
    const timestamp = nowIso();
    const existing = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (existing && existing.tenant_id !== tenantId) throw new Error('该成员账号已属于其他客户工作区');
    const id = existing?.id || userIdFor(username);
    this.db.prepare(`
      INSERT INTO users (id, username, display_name, role, tenant_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        display_name = excluded.display_name,
        role = excluded.role,
        tenant_id = excluded.tenant_id,
        status = 'active',
        updated_at = excluded.updated_at
    `).run(id, username, text(input.displayName, username), role, tenantId, existing?.created_at || timestamp, timestamp);
    if (input.password !== undefined) this.setUserPassword(actor, username, input.password);
    if (input.projectId) this.addProjectMember(actor, input.projectId, username, input.memberRole || 'member');
    return this.db.prepare(`
      SELECT id, username, display_name AS displayName, role, tenant_id AS tenantId, status,
             created_at AS createdAt, updated_at AS updatedAt
      FROM users WHERE id = ?
    `).get(id);
  }

  updateUser(actor, username, patch = {}) {
    if (actor?.role !== 'admin') throw new Error('只有管理员可以修改工作台成员');
    const normalized = normalizeMemberUsername(username);
    const existing = this.db.prepare('SELECT * FROM users WHERE username = ?').get(normalized);
    if (!existing) throw new Error('成员不存在');
    this.assertTenantAccess(actor, existing.tenant_id);
    if (patch.password !== undefined) validatePassword(patch.password);
    const role = ['client', 'admin'].includes(patch.role) ? patch.role : existing.role;
    const status = ['active', 'disabled'].includes(patch.status) ? patch.status : existing.status;
    this.db.prepare(`
      UPDATE users SET display_name = ?, role = ?, status = ?, updated_at = ? WHERE id = ?
    `).run(text(patch.displayName, existing.display_name), role, status, nowIso(), existing.id);
    if (patch.password !== undefined) this.setUserPassword(actor, normalized, patch.password);
    return this.db.prepare(`
      SELECT id, username, display_name AS displayName, role, tenant_id AS tenantId, status,
             created_at AS createdAt, updated_at AS updatedAt
      FROM users WHERE id = ?
    `).get(existing.id);
  }

  findAuthUser(username) {
    const normalized = normalizeUsername(username);
    if (!normalized) return null;
    return this.db.prepare(`
      SELECT u.username, u.display_name AS displayName, u.role, u.tenant_id AS tenantId, u.status,
             uc.password_salt AS passwordSalt, uc.password_hash AS passwordHash
      FROM users u LEFT JOIN user_credentials uc ON uc.user_id = u.id
      WHERE u.username = ?
    `).get(normalized) || null;
  }

  setUserPassword(actor, username, password) {
    if (actor?.role !== 'admin') throw new Error('只有管理员可以设置成员密码');
    validatePassword(password);
    const normalized = normalizeUsername(username);
    const user = this.db.prepare('SELECT id, tenant_id FROM users WHERE username = ?').get(normalized);
    if (!user) throw new Error('成员不存在');
    this.assertTenantAccess(actor, user.tenant_id);
    const { salt, hash } = hashPassword(password);
    this.db.prepare(`
      INSERT INTO user_credentials (user_id, password_salt, password_hash, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET password_salt = excluded.password_salt, password_hash = excluded.password_hash, updated_at = excluded.updated_at
    `).run(user.id, salt, hash, nowIso());
    return true;
  }

  writeUserCredential(userId, password, timestamp = nowIso()) {
    const { salt, hash } = hashPassword(password);
    this.db.prepare(`
      INSERT INTO user_credentials (user_id, password_salt, password_hash, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET password_salt = excluded.password_salt, password_hash = excluded.password_hash, updated_at = excluded.updated_at
    `).run(userId, salt, hash, timestamp);
  }

  createInvitation(actor, input = {}) {
    if (actor?.role !== 'admin') throw new Error('只有管理员可以创建邀请');
    const username = normalizeMemberUsername(input.username);
    const displayName = text(input.displayName, username);
    const tenantId = text(input.tenantId, tenantIdFor(actor));
    this.assertTenantAccess(actor, tenantId);
    if (!this.db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(tenantId)) {
      this.ensureTenant({ ...actor, tenantId }, { name: input.tenantName || tenantId });
    }
    if (this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      throw new Error('该成员账号已经存在，请直接管理现有成员');
    }
    const role = DIRECTORY_MEMBER_ROLES.has(input.role) ? input.role : 'client';
    const memberRole = PROJECT_MEMBER_ROLES.has(input.memberRole) ? input.memberRole : 'member';
    if (input.projectId) {
      const project = this.db.prepare('SELECT tenant_id FROM projects WHERE id = ?').get(input.projectId);
      if (!project) throw new Error('项目不存在');
      if (project.tenant_id !== tenantId) throw new Error('邀请成员和项目不属于同一客户工作区');
    }
    const expiresInHours = Number(input.expiresInHours ?? 72);
    if (!Number.isFinite(expiresInHours) || expiresInHours < 1 || expiresInHours > 24 * 30) {
      throw new Error('邀请有效期需为 1 到 720 小时');
    }
    const timestamp = nowIso();
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
    const token = 'inv_' + randomBytes(32).toString('base64url');
    const id = 'invitation_' + randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE workspace_invitations SET status = 'revoked', updated_at = ?
        WHERE tenant_id = ? AND username = ? AND status = 'pending'
      `).run(timestamp, tenantId, username);
      this.db.prepare(`
        INSERT INTO workspace_invitations (
          id, tenant_id, username, display_name, role, project_id, member_role, token_hash,
          status, expires_at, invited_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(
        id,
        tenantId,
        username,
        displayName,
        role,
        input.projectId || null,
        memberRole,
        invitationTokenHash(token),
        expiresAt,
        actorUsername(actor),
        timestamp,
        timestamp,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      ...publicInvitationRow(this.db.prepare('SELECT * FROM workspace_invitations WHERE id = ?').get(id)),
      token,
      invitePath: '/invite/accept?token=' + encodeURIComponent(token),
    };
  }

  listInvitations(actor, tenantId = null) {
    if (actor?.role !== 'admin') throw new Error('只有管理员可以查看邀请');
    const targetTenant = text(tenantId);
    if (targetTenant) this.assertTenantAccess(actor, targetTenant);
    const rows = this.db.prepare(`
      SELECT * FROM workspace_invitations
      ${targetTenant ? 'WHERE tenant_id = ?' : ''}
      ORDER BY created_at DESC
    `).all(...(targetTenant ? [targetTenant] : []));
    return rows.map(publicInvitationRow);
  }

  revokeInvitation(actor, invitationId) {
    if (actor?.role !== 'admin') throw new Error('只有管理员可以撤销邀请');
    const row = this.db.prepare('SELECT * FROM workspace_invitations WHERE id = ?').get(invitationId);
    if (!row) throw new Error('邀请不存在');
    this.assertTenantAccess(actor, row.tenant_id);
    if (row.status === 'pending') {
      this.db.prepare("UPDATE workspace_invitations SET status = 'revoked', updated_at = ? WHERE id = ?").run(nowIso(), invitationId);
    }
    return publicInvitationRow(this.db.prepare('SELECT * FROM workspace_invitations WHERE id = ?').get(invitationId));
  }

  acceptInvitation(token, password) {
    validatePassword(password);
    const tokenHash = invitationTokenHash(token);
    const timestamp = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invitation = this.db.prepare('SELECT * FROM workspace_invitations WHERE token_hash = ?').get(tokenHash);
      if (!invitation || invitation.status !== 'pending') throw new Error('邀请不存在、已使用或已撤销');
      if (Date.parse(invitation.expires_at) <= Date.now()) {
        this.db.prepare("UPDATE workspace_invitations SET status = 'expired', updated_at = ? WHERE id = ?").run(timestamp, invitation.id);
        throw new Error('邀请已过期');
      }
      if (this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(invitation.username)) {
        throw new Error('该成员账号已经存在，无法重复接受邀请');
      }
      const userId = userIdFor(invitation.username);
      this.db.prepare(`
        INSERT INTO users (id, username, display_name, role, tenant_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(userId, invitation.username, invitation.display_name, invitation.role, invitation.tenant_id, timestamp, timestamp);
      this.writeUserCredential(userId, password, timestamp);
      if (invitation.project_id) {
        this.db.prepare(`
          INSERT INTO project_members (project_id, user_id, member_role, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(project_id, user_id) DO UPDATE SET member_role = excluded.member_role
        `).run(invitation.project_id, userId, invitation.member_role, timestamp);
      }
      this.db.prepare(`
        UPDATE workspace_invitations
        SET status = 'accepted', accepted_by = ?, accepted_at = ?, updated_at = ?
        WHERE id = ?
      `).run(invitation.username, timestamp, timestamp, invitation.id);
      this.db.exec('COMMIT');
      const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      return { user: publicUserRow(row), invitation: publicInvitationRow(this.db.prepare('SELECT * FROM workspace_invitations WHERE id = ?').get(invitation.id)) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  syncDirectory(actor, input = {}) {
    if (actor?.role !== 'admin') throw new Error('只有管理员可以同步组织目录');
    const tenantId = text(input.tenantId, tenantIdFor(actor));
    this.assertTenantAccess(actor, tenantId);
    if (!this.db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(tenantId)) {
      this.ensureTenant({ ...actor, tenantId }, { name: input.tenantName || tenantId });
    }
    if (!Array.isArray(input.members) || input.members.length > 1000) {
      throw new Error('组织目录成员必须是 0 到 1000 个成员的数组');
    }
    const seen = new Set();
    const members = input.members.map((raw) => {
      const username = normalizeMemberUsername(raw?.username);
      if (seen.has(username)) throw new Error('组织目录中存在重复成员：' + username);
      seen.add(username);
      const projects = [];
      if (Array.isArray(raw?.projects)) projects.push(...raw.projects);
      if (raw?.projectId) projects.push({ projectId: raw.projectId, memberRole: raw.memberRole });
      const bindings = projects.map((binding) => {
        const projectId = text(binding?.projectId);
        const project = this.db.prepare('SELECT tenant_id FROM projects WHERE id = ?').get(projectId);
        if (!project) throw new Error('组织目录绑定的项目不存在：' + projectId);
        if (project.tenant_id !== tenantId) throw new Error('组织目录成员和项目不属于同一客户工作区');
        return { projectId, memberRole: PROJECT_MEMBER_ROLES.has(binding?.memberRole) ? binding.memberRole : 'member' };
      });
      return {
        username,
        displayName: text(raw?.displayName, username),
        role: DIRECTORY_MEMBER_ROLES.has(raw?.role) ? raw.role : 'client',
        status: DIRECTORY_MEMBER_STATUSES.has(raw?.status) ? raw.status : 'active',
        bindings,
      };
    });
    const dryRun = input.dryRun === true || input.mode === 'dry_run';
    const summary = { created: 0, updated: 0, disabled: 0, projectBindings: members.reduce((count, member) => count + member.bindings.length, 0), unchanged: 0 };
    const currentRows = new Map(this.db.prepare('SELECT * FROM users WHERE tenant_id = ?').all(tenantId).map((row) => [row.username, row]));
    for (const member of members) {
      const existing = currentRows.get(member.username);
      if (!existing) summary.created += 1;
      else if (existing.display_name !== member.displayName || existing.role !== member.role || existing.status !== member.status) summary.updated += 1;
      else summary.unchanged += 1;
    }
    const deactivateMissing = input.deactivateMissing === true;
    if (deactivateMissing) {
      for (const row of currentRows.values()) {
        if (row.role === 'client' && !seen.has(row.username) && row.status !== 'disabled') summary.disabled += 1;
      }
    }
    if (dryRun) {
      return { syncId: null, tenantId, source: text(input.source, 'directory-manifest'), mode: 'dry_run', summary };
    }
    const timestamp = nowIso();
    const syncId = 'directory_sync_' + randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const member of members) {
        const existing = this.db.prepare('SELECT * FROM users WHERE username = ?').get(member.username);
        if (existing && existing.tenant_id !== tenantId) throw new Error('组织目录成员已经属于其他客户工作区：' + member.username);
        const id = existing?.id || userIdFor(member.username);
        this.db.prepare(`
          INSERT INTO users (id, username, display_name, role, tenant_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, role = excluded.role, tenant_id = excluded.tenant_id, status = excluded.status, updated_at = excluded.updated_at
        `).run(id, member.username, member.displayName, member.role, tenantId, member.status, existing?.created_at || timestamp, timestamp);
        for (const binding of member.bindings) {
          this.db.prepare(`
            INSERT INTO project_members (project_id, user_id, member_role, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(project_id, user_id) DO UPDATE SET member_role = excluded.member_role
          `).run(binding.projectId, id, binding.memberRole, timestamp);
        }
      }
      if (deactivateMissing && seen.size > 0) {
        const placeholders = [...seen].map(() => '?').join(', ');
        this.db.prepare(`UPDATE users SET status = 'disabled', updated_at = ? WHERE tenant_id = ? AND role = 'client' AND username NOT IN (${placeholders})`).run(timestamp, tenantId, ...seen);
      }
      this.db.prepare(`
        INSERT INTO directory_sync_runs (id, tenant_id, source, mode, summary_json, actor_username, created_at)
        VALUES (?, ?, ?, 'apply', ?, ?, ?)
      `).run(syncId, tenantId, text(input.source, 'directory-manifest'), JSON.stringify(summary), actorUsername(actor), timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { syncId, tenantId, source: text(input.source, 'directory-manifest'), mode: 'apply', summary };
  }

  listDirectorySyncRuns(actor, tenantId = null) {
    if (actor?.role !== 'admin') throw new Error('只有管理员可以查看组织目录同步记录');
    const targetTenant = text(tenantId);
    if (targetTenant) this.assertTenantAccess(actor, targetTenant);
    return this.db.prepare(`
      SELECT id, tenant_id AS tenantId, source, mode, summary_json AS summaryJson, actor_username AS actorUsername, created_at AS createdAt
      FROM directory_sync_runs ${targetTenant ? 'WHERE tenant_id = ?' : ''} ORDER BY created_at DESC
    `).all(...(targetTenant ? [targetTenant] : [])).map((row) => ({ ...row, summary: jsonParse(row.summaryJson, {}) }));
  }

  listProjectMembers(actor, projectId) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) throw new Error('项目不存在');
    this.assertTenantAccess(actor, project.tenant_id);
    if (!this.canAccessProject(actor, projectId)) throw new Error('没有访问该项目的权限');
    return this.db.prepare(`
      SELECT u.id, u.username, u.display_name AS displayName, u.role, u.tenant_id AS tenantId,
             u.status, pm.member_role AS memberRole, pm.created_at AS joinedAt
      FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = ? ORDER BY pm.created_at
    `).all(projectId);
  }

  addProjectMember(actor, projectId, username, memberRole = 'member') {
    if (actor?.role !== 'admin') throw new Error('只有管理员可以管理项目成员');
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) throw new Error('项目不存在');
    this.assertTenantAccess(actor, project.tenant_id);
    const user = this.db.prepare('SELECT * FROM users WHERE username = ?').get(normalizeUsername(username));
    if (!user) throw new Error('成员不存在，请先创建成员');
    if (user.tenant_id !== project.tenant_id) throw new Error('成员和项目不属于同一客户工作区');
    const role = ['owner', 'manager', 'member', 'reviewer'].includes(memberRole) ? memberRole : 'member';
    this.db.prepare(`
      INSERT INTO project_members (project_id, user_id, member_role, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET member_role = excluded.member_role
    `).run(projectId, user.id, role, nowIso());
    return this.listProjectMembers(actor, projectId);
  }

  removeProjectMember(actor, projectId, username) {
    if (actor?.role !== 'admin') throw new Error('只有管理员可以管理项目成员');
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) throw new Error('项目不存在');
    this.assertTenantAccess(actor, project.tenant_id);
    const user = this.db.prepare('SELECT id FROM users WHERE username = ?').get(normalizeUsername(username));
    if (user) this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, user.id);
    return this.listProjectMembers(actor, projectId);
  }

  updateConnector(actor, connectorId, patch = {}) {
    if (actor?.role !== 'admin') throw new Error('只有管理员可以配置连接器');
    const row = this.db.prepare('SELECT * FROM connectors WHERE id = ?').get(connectorId);
    if (!row) throw new Error('连接器不存在');
    this.assertTenantAccess(actor, row.tenant_id);
    const statuses = ['not_configured', 'ready', 'degraded', 'revoked'];
    const status = statuses.includes(patch.status) ? patch.status : row.status;
    const config = patch.config && typeof patch.config === 'object' && !Array.isArray(patch.config)
      ? patch.config
      : jsonParse(row.config_json, {});
    const serialized = JSON.stringify(config);
    if (/(password|secret|token|api.?key|cookie)/i.test(serialized)) {
      throw new Error('连接器配置不得把密码、Token、API Key 或 Cookie 写入工作台数据库，请使用环境变量或密钥管理');
    }
    this.db.prepare('UPDATE connectors SET status = ?, config_json = ?, updated_at = ? WHERE id = ?').run(status, serialized, nowIso(), connectorId);
    return rowToConnector(this.db.prepare('SELECT * FROM connectors WHERE id = ?').get(connectorId));
  }

  seedDefaultConnectors(actor) {
    const context = this.ensureContext(actor);
    const timestamp = nowIso();
    const configuredDeepSeek = Boolean(process.env.DEEPSEEK_API_KEY);
    const defaults = [
      ['local-media', '本地媒体工具', 'runtime', 'ready', ['media.probe', 'media.keyframe', 'media.render', 'package.export'], {}],
      ['local-knowledge', '本地知识库', 'knowledge', 'ready', ['knowledge.search', 'knowledge.write'], {}],
      ['deepseek', 'DeepSeek 生成器', 'model', configuredDeepSeek ? 'ready' : 'not_configured', ['topic.generate', 'copy.generate', 'platform.adapt', 'shotlist.generate', 'retro.generate'], {}],
      ['publish-xhs', '小红书发布连接器', 'platform', 'not_configured', ['publish.execute'], { platform: 'xhs' }],
      ['publish-douyin', '抖音发布连接器', 'platform', 'not_configured', ['publish.execute'], { platform: 'douyin' }],
      ['publish-channels', '视频号发布连接器', 'platform', 'not_configured', ['publish.execute'], { platform: 'channels' }],
    ];
    for (const [slug, name, kind, status, capabilities, config] of defaults) {
      const id = connectorIdFor(context.tenantId, slug);
      const existing = this.db.prepare('SELECT status, config_json FROM connectors WHERE id = ?').get(id);
      const existingConfig = jsonParse(existing?.config_json, {});
      const hasExistingConfig = Object.keys(existingConfig).length > 0;
      const effectiveStatus = existing && existing.status !== 'not_configured' ? existing.status : status;
      const effectiveConfig = hasExistingConfig ? existingConfig : config;
      this.db.prepare(`
        INSERT INTO connectors (id, tenant_id, name, kind, status, capabilities_json, config_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, capabilities_json = excluded.capabilities_json, config_json = excluded.config_json, updated_at = excluded.updated_at
      `).run(id, context.tenantId, name, kind, effectiveStatus, JSON.stringify(capabilities), JSON.stringify(effectiveConfig), timestamp, timestamp);
      if (actor?.role !== 'admin' && ['local-media', 'local-knowledge'].includes(slug)) {
        this.grantConnector(actor, id, ['use', ...capabilities], 'allow');
      }
    }
    return this.listConnectors(actor);
  }

  listConnectors(actor) {
    const user = this.ensureUser(actor);
    const rows = actor?.role === 'admin'
      ? this.db.prepare('SELECT * FROM connectors ORDER BY kind, name').all()
      : this.db.prepare('SELECT * FROM connectors WHERE tenant_id = ? ORDER BY kind, name').all(user.tenantId);
    return rows.map((row) => {
      const connector = rowToConnector(row);
      return {
        ...connector,
        allowed: actor?.role === 'admin' || this.hasConnectorPermission(actor, connector.id, 'use'),
      };
    });
  }

  grantConnector(actor, connectorId, permissions, effect = 'allow', subjectUsername = null) {
    if (actor?.role !== 'admin' && subjectUsername && subjectUsername !== actor.username) {
      throw new Error('只有管理员可以为其他成员授权');
    }
    const user = this.ensureUser(actor);
    const connector = this.db.prepare('SELECT * FROM connectors WHERE id = ?').get(connectorId);
    if (!connector) throw new Error('连接器不存在');
    this.assertTenantAccess(actor, connector.tenant_id);
    const subject = text(subjectUsername, actor?.role === 'admin' ? '*' : user.username);
    const list = Array.isArray(permissions) ? permissions : [permissions];
    const timestamp = nowIso();
    for (const permission of list.filter((item) => typeof item === 'string' && item.trim())) {
      this.db.prepare(`
        INSERT INTO connector_grants (id, tenant_id, connector_id, subject_username, permission, effect, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, connector_id, subject_username, permission)
        DO UPDATE SET effect = excluded.effect, updated_at = excluded.updated_at
      `).run('grant_' + randomUUID(), connector.tenant_id, connectorId, subject, permission.trim(), effect, timestamp, timestamp);
    }
    return this.listConnectorGrants(actor, connectorId);
  }

  listConnectorGrants(actor, connectorId = null) {
    const user = this.ensureUser(actor);
    const rows = actor?.role === 'admin'
      ? this.db.prepare(`SELECT * FROM connector_grants ${connectorId ? 'WHERE connector_id = ?' : ''} ORDER BY created_at DESC`).all(...(connectorId ? [connectorId] : []))
      : this.db.prepare(`SELECT * FROM connector_grants WHERE tenant_id = ? ${connectorId ? 'AND connector_id = ?' : ''} ORDER BY created_at DESC`).all(...(connectorId ? [user.tenantId, connectorId] : [user.tenantId]));
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      connectorId: row.connector_id,
      subjectUsername: row.subject_username,
      permission: row.permission,
      effect: row.effect,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  hasConnectorPermission(actor, connectorId, permission) {
    if (actor?.role === 'admin') return true;
    const user = this.ensureUser(actor);
    const row = this.db.prepare(`
      SELECT c.tenant_id AS tenantId, c.status, c.capabilities_json AS capabilitiesJson,
             g.effect, g.permission
      FROM connectors c
      LEFT JOIN connector_grants g
        ON g.connector_id = c.id AND g.tenant_id = c.tenant_id
       AND g.permission IN (?, 'use')
       AND g.subject_username IN (?, '*')
      WHERE c.id = ? AND c.tenant_id = ?
      ORDER BY CASE WHEN g.subject_username = ? THEN 0 ELSE 1 END
      LIMIT 1
    `).get(permission, user.username, connectorId, user.tenantId, user.username);
    if (!row || row.status === 'not_configured') return false;
    const capabilities = jsonParse(row.capabilitiesJson, []);
    if (permission !== 'use' && !capabilities.includes(permission)) return false;
    return row.effect === 'allow';
  }

  resolveContentContext(actor, input = {}) {
    const tenantId = text(input.tenantId);
    const projectId = text(input.projectId);
    let customerId = text(input.customerId, null);
    const brandProfileId = text(input.brandProfileId, null);
    if (!tenantId || !projectId) throw new Error('内容任务缺少客户工作区或项目上下文');
    const customer = customerId
      ? this.db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId)
      : null;
    if (customerId && !customer) throw new Error('客户上下文不存在');
    if (customer) {
      this.assertTenantAccess(actor, customer.tenant_id);
      if (customer.tenant_id !== tenantId) throw new Error('内容任务和客户上下文不属于同一客户工作区');
    }
    const brandProfile = brandProfileId
      ? this.db.prepare('SELECT * FROM brand_profiles WHERE id = ?').get(brandProfileId)
      : null;
    if (brandProfileId && !brandProfile) throw new Error('品牌资料不存在');
    if (brandProfile) {
      this.assertTenantAccess(actor, brandProfile.tenant_id);
      if (brandProfile.tenant_id !== tenantId || brandProfile.project_id !== projectId) {
        throw new Error('内容任务和品牌资料不属于同一客户工作区或项目');
      }
      if (customerId && brandProfile.customer_id !== customerId) {
        throw new Error('内容任务的客户和品牌资料不匹配');
      }
      customerId = customerId || brandProfile.customer_id;
    }
    return { customerId, brandProfileId };
  }

  saveContentTask(task, actor, options = {}) {
    const context = this.ensureContext(actor, task.projectId);
    const tenantId = text(task.tenantId, context.tenantId);
    this.assertTenantAccess(actor, tenantId);
    if (tenantId !== context.tenantId) {
      throw new Error('内容任务租户边界不一致');
    }
    const linkedContext = this.resolveContentContext(actor, {
      tenantId,
      projectId: context.project.id,
      customerId: task.customerId,
      brandProfileId: task.brandProfileId,
    });
    const timestamp = options.now || task.updatedAt || nowIso();
    const payload = {
      ...task,
      tenantId,
      projectId: context.project.id,
      customerId: linkedContext.customerId,
      brandProfileId: linkedContext.brandProfileId,
    };
    this.db.prepare(`
      INSERT INTO content_tasks (id, tenant_id, project_id, customer_id, brand_profile_id, status, payload_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        project_id = excluded.project_id,
        customer_id = excluded.customer_id,
        brand_profile_id = excluded.brand_profile_id,
        status = excluded.status,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      payload.id,
      tenantId,
      context.project.id,
      linkedContext.customerId,
      linkedContext.brandProfileId,
      payload.status || 'draft',
      JSON.stringify(payload),
      text(payload.createdBy?.username, actorUsername(actor)),
      payload.createdAt || timestamp,
      timestamp,
    );
    return payload;
  }

  migrateContentTask(task, actor) {
    const existing = this.getContentTask(actor, task.id, { allowAdmin: true });
    if (existing) return existing;
    return this.saveContentTask(task, actor);
  }

  getContentTask(actor, taskId, options = {}) {
    const row = this.db.prepare('SELECT * FROM content_tasks WHERE id = ?').get(taskId);
    if (!row) return null;
    if (actor?.role === 'admin' && options.allowAdmin !== false) return rowToContentTask(row);
    this.assertTenantAccess(actor, row.tenant_id);
    if (!this.canAccessProject(actor, row.project_id)) throw new Error('没有访问该内容任务的权限');
    return rowToContentTask(row);
  }

  listContentTasks(actor, options = {}) {
    const user = this.ensureUser(actor);
    const rows = actor?.role === 'admin'
      ? this.db.prepare('SELECT * FROM content_tasks ORDER BY updated_at DESC').all()
      : this.db.prepare('SELECT ct.* FROM content_tasks ct JOIN project_members pm ON pm.project_id = ct.project_id WHERE ct.tenant_id = ? AND pm.user_id = ? ORDER BY ct.updated_at DESC').all(user.tenantId, user.id);
    const tasks = rows.map(rowToContentTask).filter(Boolean);
    return options.status ? tasks.filter((task) => task.status === options.status) : tasks;
  }

  recordContentEvent(task, actor, type, data = {}) {
    const timestamp = nowIso();
    const row = this.db.prepare('SELECT tenant_id FROM content_tasks WHERE id = ?').get(task.id);
    if (!row) throw new Error('内容任务不存在');
    this.assertTenantAccess(actor, row.tenant_id);
    const eventData = {
      ...data,
      taskSnapshot: JSON.parse(JSON.stringify(task)),
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const runId = text(task.run?.id);
      const sequenceRow = runId
        ? this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS next FROM content_task_events WHERE task_id = ? AND run_id = ?').get(task.id, runId)
        : this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS next FROM content_task_events WHERE task_id = ? AND run_id IS NULL').get(task.id);
      const sequence = Number(sequenceRow?.next || 0) + 1;
      this.db.prepare(`
        INSERT INTO content_task_events (id, task_id, tenant_id, run_id, sequence, type, actor_username, data_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('event_' + randomUUID(), task.id, row.tenant_id, runId || null, sequence, type, actorUsername(actor), JSON.stringify(eventData), timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listContentEvents(actor, taskId, runId = null) {
    const task = this.getContentTask(actor, taskId);
    if (!task) return [];
    const normalizedRunId = text(runId);
    const rows = normalizedRunId
      ? this.db.prepare(`
          SELECT id, task_id AS taskId, tenant_id AS tenantId, run_id AS runId, sequence, type, actor_username AS actorUsername,
                 data_json AS dataJson, created_at AS createdAt
          FROM content_task_events WHERE task_id = ? AND run_id = ? ORDER BY sequence ASC, created_at ASC, id ASC
        `).all(taskId, normalizedRunId)
      : this.db.prepare(`
          SELECT id, task_id AS taskId, tenant_id AS tenantId, run_id AS runId, sequence, type, actor_username AS actorUsername,
                 data_json AS dataJson, created_at AS createdAt
          FROM content_task_events WHERE task_id = ? ORDER BY COALESCE(sequence, 2147483647) ASC, created_at ASC, id ASC
        `).all(taskId);
    return rows.map((row, index) => ({
      ...row,
      sequence: Number.isInteger(row.sequence) ? row.sequence : index + 1,
      data: jsonParse(row.dataJson, {}),
    }));
  }

  saveMediaAsset(asset, actor) {
    const context = this.ensureContext(actor, asset.projectId);
    const tenantId = text(asset.tenantId, context.tenantId);
    this.assertTenantAccess(actor, tenantId);
    const timestamp = nowIso();
    const payload = {
      ...asset,
      tenantId,
      projectId: context.project.id,
      createdAt: asset.createdAt || timestamp,
      updatedAt: timestamp,
    };
    this.db.prepare(`
      INSERT INTO media_assets (id, tenant_id, project_id, task_id, path, filename, kind, mime_type, status, metadata_json, text_content, transcript, ocr_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        metadata_json = excluded.metadata_json,
        text_content = excluded.text_content,
        transcript = excluded.transcript,
        ocr_text = excluded.ocr_text,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      payload.id,
      tenantId,
      context.project.id,
      payload.taskId || null,
      payload.path,
      payload.filename,
      payload.kind,
      payload.mimeType || '',
      payload.status || 'parsed',
      jsonStringify(payload.metadata),
      payload.textContent || '',
      payload.transcript || '',
      payload.ocrText || '',
      payload.createdAt,
      payload.updatedAt,
    );
    return payload;
  }

  listMediaAssets(actor, taskId = null) {
    const user = this.ensureUser(actor);
    const rows = actor?.role === 'admin'
      ? this.db.prepare(`SELECT * FROM media_assets ${taskId ? 'WHERE task_id = ?' : ''} ORDER BY created_at DESC`).all(...(taskId ? [taskId] : []))
      : this.db.prepare(`SELECT ma.* FROM media_assets ma JOIN project_members pm ON pm.project_id = ma.project_id WHERE ma.tenant_id = ? AND pm.user_id = ? ${taskId ? 'AND ma.task_id = ?' : ''} ORDER BY ma.created_at DESC`).all(...(taskId ? [user.tenantId, user.id, taskId] : [user.tenantId, user.id]));
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      projectId: row.project_id,
      taskId: row.task_id,
      path: row.path,
      filename: row.filename,
      kind: row.kind,
      mimeType: row.mime_type,
      status: row.status,
      metadata: jsonParse(row.metadata_json, {}),
      textContent: row.text_content,
      transcript: row.transcript,
      ocrText: row.ocr_text,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  saveKnowledgeDocument(document, actor) {
    const context = this.ensureContext(actor, document.projectId);
    const tenantId = text(document.tenantId, context.tenantId);
    this.assertTenantAccess(actor, tenantId);
    const timestamp = nowIso();
    const payload = {
      ...document,
      tenantId,
      projectId: context.project.id,
      createdAt: document.createdAt || timestamp,
      updatedAt: timestamp,
    };
    this.db.prepare(`
      INSERT INTO knowledge_documents (id, tenant_id, project_id, task_id, title, content, source_type, source_path, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        source_type = excluded.source_type,
        source_path = excluded.source_path,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(payload.id, tenantId, context.project.id, payload.taskId || null, payload.title, payload.content || '', payload.sourceType || 'manual', payload.sourcePath || '', jsonStringify(payload.metadata), payload.createdAt, payload.updatedAt);
    if (this.ftsEnabled) {
      this.db.prepare('DELETE FROM knowledge_documents_fts WHERE id = ?').run(payload.id);
      this.db.prepare('INSERT INTO knowledge_documents_fts (id, tenant_id, project_id, title, content) VALUES (?, ?, ?, ?, ?)').run(payload.id, tenantId, context.project.id, payload.title, payload.content || '');
    }
    return payload;
  }

  searchKnowledge(actor, query, options = {}) {
    const user = this.ensureUser(actor);
    const normalizedQuery = text(query);
    if (!normalizedQuery) return [];
    const limit = Math.min(Math.max(Number(options.limit || 8), 1), 50);
    let rows;
    if (this.ftsEnabled) {
      const match = normalizedQuery.replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim().split(/\s+/).filter(Boolean).map((part) => `"${part.replaceAll('"', '""')}"`).join(' OR ');
      rows = actor?.role === 'admin'
        ? this.db.prepare(`SELECT kd.* FROM knowledge_documents_fts f JOIN knowledge_documents kd ON kd.id = f.id WHERE knowledge_documents_fts MATCH ? ORDER BY rank LIMIT ?`).all(match, limit)
        : this.db.prepare(`SELECT kd.* FROM knowledge_documents_fts f JOIN knowledge_documents kd ON kd.id = f.id WHERE f.tenant_id = ? AND knowledge_documents_fts MATCH ? ORDER BY rank LIMIT ?`).all(user.tenantId, match, limit);
    }
    if (!rows?.length) {
      const pattern = '%' + normalizedQuery.replaceAll('%', '') + '%';
      rows = actor?.role === 'admin'
        ? this.db.prepare('SELECT * FROM knowledge_documents WHERE title LIKE ? OR content LIKE ? ORDER BY updated_at DESC LIMIT ?').all(pattern, pattern, limit)
        : this.db.prepare('SELECT * FROM knowledge_documents WHERE tenant_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY updated_at DESC LIMIT ?').all(user.tenantId, pattern, pattern, limit);
    }
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      projectId: row.project_id,
      taskId: row.task_id,
      title: row.title,
      content: row.content,
      sourceType: row.source_type,
      sourcePath: row.source_path,
      metadata: jsonParse(row.metadata_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createReleaseDraft(input, actor) {
    const task = this.getContentTask(actor, input.taskId);
    if (!task) throw new Error('内容任务不存在');
    const context = this.ensureContext(actor, task.projectId);
    const timestamp = nowIso();
    const id = text(input.id, 'release_draft_' + randomUUID());
    this.db.prepare(`
      INSERT INTO release_drafts (id, tenant_id, project_id, task_id, status, payload_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(id, context.project.tenantId, context.project.id, task.id, JSON.stringify(input.payload || {}), actorUsername(actor), timestamp, timestamp);
    return this.getReleaseDraft(actor, id);
  }

  getReleaseDraft(actor, draftId) {
    const row = this.db.prepare('SELECT * FROM release_drafts WHERE id = ?').get(draftId);
    if (!row) return null;
    this.assertTenantAccess(actor, row.tenant_id);
    return {
      id: row.id,
      tenantId: row.tenant_id,
      projectId: row.project_id,
      taskId: row.task_id,
      status: row.status,
      payload: jsonParse(row.payload_json, {}),
      createdBy: row.created_by,
      approvedBy: row.approved_by || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listReleaseDrafts(actor, taskId = null) {
    const user = this.ensureUser(actor);
    const rows = actor?.role === 'admin'
      ? this.db.prepare(`SELECT * FROM release_drafts ${taskId ? 'WHERE task_id = ?' : ''} ORDER BY updated_at DESC`).all(...(taskId ? [taskId] : []))
      : this.db.prepare(`SELECT rd.* FROM release_drafts rd JOIN project_members pm ON pm.project_id = rd.project_id WHERE rd.tenant_id = ? AND pm.user_id = ? ${taskId ? 'AND rd.task_id = ?' : ''} ORDER BY rd.updated_at DESC`).all(...(taskId ? [user.tenantId, user.id, taskId] : [user.tenantId, user.id]));
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      projectId: row.project_id,
      taskId: row.task_id,
      status: row.status,
      payload: jsonParse(row.payload_json, {}),
      createdBy: row.created_by,
      approvedBy: row.approved_by || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  updateReleaseDraft(actor, draftId, patch = {}) {
    const draft = this.getReleaseDraft(actor, draftId);
    if (!draft) throw new Error('发布草稿不存在');
    const timestamp = nowIso();
    let status = draft.status;
    let approvedBy = draft.approvedBy || '';
    if (patch.status === 'approved') {
      if (actor?.role !== 'admin') throw new Error('只有管理员可以通过发布草稿');
      status = 'approved';
      approvedBy = actorUsername(actor);
    } else if (patch.status && ['draft', 'cancelled'].includes(patch.status)) {
      status = patch.status;
    }
    const payload = patch.payload && typeof patch.payload === 'object' ? patch.payload : draft.payload;
    this.db.prepare('UPDATE release_drafts SET status = ?, payload_json = ?, approved_by = ?, updated_at = ? WHERE id = ?').run(status, JSON.stringify(payload), approvedBy, timestamp, draftId);
    return this.getReleaseDraft(actor, draftId);
  }
}

export { DEFAULT_TENANT_ID, DEFAULT_PROJECT_SLUG };
