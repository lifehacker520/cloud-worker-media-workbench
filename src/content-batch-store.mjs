import { createHash, randomUUID } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS avatar_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS avatar_profile_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES avatar_profiles(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  authorization_status TEXT NOT NULL,
  batch_allowed INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, version_number)
);
CREATE TABLE IF NOT EXISTS voice_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS voice_profile_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES voice_profiles(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  authorization_status TEXT NOT NULL,
  batch_allowed INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, version_number)
);
CREATE TABLE IF NOT EXISTS script_sets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS script_versions (
  id TEXT PRIMARY KEY,
  script_set_id TEXT NOT NULL REFERENCES script_sets(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT,
  version_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  batch_allowed INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(script_set_id, version_number)
);
CREATE TABLE IF NOT EXISTS edit_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edit_template_versions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES edit_templates(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  batch_allowed INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(template_id, version_number)
);
CREATE TABLE IF NOT EXISTS content_batches (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS content_batch_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES content_batches(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS model_runs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES content_batches(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES content_batch_items(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quality_reports (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES content_batches(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES content_batch_items(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- F5-02：AI 数字人口播生产任务的最小草稿。
-- 它不是 content_batches 的替代品，也不构成第二套批次真相：草稿里没有明细、没有状态机，
-- 只有在 F5-05 通过 preflight 之后才会由 buildBatchPlan + createContentBatch 变成真正的批次。
CREATE TABLE IF NOT EXISTS digital_human_drafts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_batches_project ON content_batches(project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_content_batch_items_ready ON content_batch_items(batch_id, status, lease_until);
CREATE INDEX IF NOT EXISTS idx_model_runs_item ON model_runs(item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quality_reports_item ON quality_reports(item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_digital_human_drafts_project ON digital_human_drafts(project_id, updated_at);
-- S6-01：N01 项目/行业上下文档案。每一行是一个不可变版本；编辑产生新版本行，
-- 旧任务引用旧版本 id，不会随编辑漂移（N17 要求输入可冻结）。
CREATE TABLE IF NOT EXISTS project_contexts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  context_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  industry TEXT,
  product TEXT,
  audience TEXT,
  selling_points_json TEXT,
  content_goal TEXT,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_contexts_project ON project_contexts(project_id, context_key, version);
-- S6-02：N05 员工数字人档案（形象与声音的绑定主体）。
CREATE TABLE IF NOT EXISTS digital_human_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  subject_role TEXT,
  avatar_version_id TEXT,
  voice_version_id TEXT,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dh_profiles_project ON digital_human_profiles(project_id);
-- S6-03：N11 已有视频（模式 B）。
CREATE TABLE IF NOT EXISTS source_videos (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  subject_id TEXT,
  name TEXT NOT NULL,
  file_ref TEXT,
  duration_seconds INTEGER,
  aspect TEXT,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- S7-01：N18 Provider Registry（能力登记，候选/首选/阻塞/模拟四种状态）。
CREATE TABLE IF NOT EXISTS n18_providers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  transport TEXT NOT NULL,
  endpoint TEXT,
  status TEXT NOT NULL,
  license_code TEXT,
  license_weights TEXT,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_n18_providers_capability ON n18_providers(capability, status);
-- S6-03：N12 视频素材映射（视频 + 文案 + 声音来源 + 模板）。
CREATE TABLE IF NOT EXISTS video_mappings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  script_version_id TEXT,
  voice_source TEXT,
  voice_version_id TEXT,
  template_version_id TEXT,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- S6-01：N02 文案生成需求。
CREATE TABLE IF NOT EXISTS copy_generation_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  context_id TEXT,
  count INTEGER,
  direction TEXT,
  platform TEXT,
  duration_seconds INTEGER,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function json(value, fallback = {}) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parse(value, fallback = {}) {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
}

function now() {
  return new Date().toISOString();
}

function actorName(actor) {
  return text(actor?.username, 'system');
}

const TERMINAL_ITEM_STATUSES = new Set(['succeeded', 'approved', 'failed', 'blocked', 'cancelled']);

function validateBatchItems(batch, context) {
  const items = Array.isArray(batch?.items) ? batch.items : [];
  if (batch?.planCount !== undefined && Number(batch.planCount) !== items.length) {
    throw new Error('批次计划数量与子任务数量不一致');
  }
  const itemIds = new Set();
  const idempotencyKeys = new Set();
  return items.map((item) => {
    const id = text(item?.id);
    const idempotencyKey = text(item?.idempotencyKey, id);
    if (!id) throw new Error('批次子任务缺少 ID');
    if (itemIds.has(id)) throw new Error('批次子任务 ID 不能重复：' + id);
    if (idempotencyKeys.has(idempotencyKey)) throw new Error('批次幂等键不能重复：' + idempotencyKey);
    if (item?.tenantId && item.tenantId !== context.tenantId) throw new Error('批次子任务租户边界不一致');
    if (item?.projectId && item.projectId !== context.project.id) throw new Error('批次子任务项目边界不一致');
    if (item?.taskId && item.taskId !== batch.taskId) throw new Error('批次子任务内容任务不一致');
    itemIds.add(id);
    idempotencyKeys.add(idempotencyKey);
    return { item, id, idempotencyKey };
  });
}

function publicVersion(row, extra = {}) {
  return row
    ? {
        ...parse(row.payload_json, {}),
        ...extra,
        id: row.id,
        profileId: row.profile_id || undefined,
        scriptSetId: row.script_set_id || undefined,
        templateId: row.template_id || undefined,
        projectId: row.project_id,
        tenantId: row.tenant_id,
        version: row.version_number,
        status: row.status,
        authorizationStatus: row.authorization_status || undefined,
        batchAllowed: Boolean(row.batch_allowed),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function publicConnector(row, allowed = true) {
  return row
    ? {
        id: row.id,
        tenantId: row.tenant_id,
        name: row.name,
        kind: row.kind,
        status: row.status,
        capabilities: parse(row.capabilities_json, []),
        config: parse(row.config_json, {}),
        allowed,
      }
    : null;
}

export class ContentBatchStore {
  constructor(workbench) {
    if (!workbench?.db) throw new Error('ContentBatchStore 需要 WorkbenchStore');
    this.workbench = workbench;
    this.db = workbench.db;
  }

  ensureSchema() {
    this.db.exec(SCHEMA);
  }

  context(actor, projectId) {
    return this.workbench.ensureContext(actor, text(projectId) || null);
  }

  assertExistingScope(actor, row) {
    if (!row) return null;
    const context = this.context(actor, row.project_id);
    if (context.tenantId !== row.tenant_id) throw new Error('批次租户边界不一致');
    return context;
  }

  createApprovedProfile(actor, input, kind) {
    const context = this.context(actor, input.projectId);
    const prefix = kind === 'avatar' ? 'avatar' : 'voice';
    const table = prefix + '_profiles';
    const versionTable = prefix + '_profile_versions';
    const name = text(input.name, kind === 'avatar' ? '未命名数字人' : '未命名声音');
    const id = text(input.id, `${prefix}_profile_${randomUUID()}`);
    const versionId = text(input.versionId, `${prefix}_version_${randomUUID()}`);
    const timestamp = now();
    const existing = this.db.prepare(`SELECT tenant_id, project_id, created_at FROM ${table} WHERE id = ?`).get(id);
    if (existing && (existing.tenant_id !== context.tenantId || existing.project_id !== context.project.id)) {
      throw new Error('资产已经属于其他项目或客户工作区');
    }
    const authorizationStatus = ['approved', 'pending', 'revoked'].includes(input.authorizationStatus)
      ? input.authorizationStatus
      : 'pending';
    const approved = input.approved === true;
    if (approved && (authorizationStatus !== 'approved' || !text(input.authorizationRef))) {
      throw new Error('审核通过的资产必须有已确认授权');
    }
    const status = approved ? 'approved' : 'draft';
    const batchAllowed = approved && input.batchAllowed === true;
    const payload = {
      displayName: text(input.displayName, name),
      canonicalImageRef: text(input.canonicalImageRef, null),
      baseVideoRef: text(input.baseVideoRef, null),
      referenceAudioRef: text(input.referenceAudioRef, null),
      referenceTranscript: text(input.referenceTranscript, null),
      voiceName: text(input.voiceName, null),
      provider: text(input.provider, null),
      modelVersion: text(input.modelVersion, null),
      licenseRef: text(input.licenseRef, null),
      weightsHash: text(input.weightsHash, null),
      authorizationRef: text(input.authorizationRef, null),
      notes: text(input.notes, null),
    };
    this.db.prepare(`
      INSERT INTO ${table} (id, tenant_id, project_id, name, status, payload_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status,
        payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(id, context.tenantId, context.project.id, name, status, json(payload), actorName(actor), existing?.created_at || timestamp, timestamp);
    const versionExisting = this.db.prepare(`SELECT tenant_id, project_id, created_at FROM ${versionTable} WHERE id = ?`).get(versionId);
    if (versionExisting && (versionExisting.tenant_id !== context.tenantId || versionExisting.project_id !== context.project.id)) {
      throw new Error('资产版本已经属于其他项目或客户工作区');
    }
    const versionNumber = Number(input.version || 1);
    this.db.prepare(`
      INSERT INTO ${versionTable} (
        id, profile_id, tenant_id, project_id, version_number, status,
        authorization_status, batch_allowed, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status,
        authorization_status = excluded.authorization_status, batch_allowed = excluded.batch_allowed,
        payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(
      versionId,
      id,
      context.tenantId,
      context.project.id,
      Number.isInteger(versionNumber) && versionNumber > 0 ? versionNumber : 1,
      status,
      authorizationStatus,
      batchAllowed ? 1 : 0,
      json(payload),
      versionExisting?.created_at || timestamp,
      timestamp,
    );
    const profile = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    const version = this.db.prepare(`SELECT * FROM ${versionTable} WHERE id = ?`).get(versionId);
    return {
      profile: { id, projectId: context.project.id, tenantId: context.tenantId, name, status, ...payload },
      version: publicVersion(version),
    };
  }

  createAvatarProfile(actor, input = {}) {
    return this.createApprovedProfile(actor, input, 'avatar');
  }

  createVoiceProfile(actor, input = {}) {
    return this.createApprovedProfile(actor, input, 'voice');
  }

  createScriptSet(actor, input = {}) {
    const context = this.context(actor, input.projectId);
    const name = text(input.name, '未命名脚本');
    const id = text(input.id, 'script_set_' + randomUUID());
    const versions = Array.isArray(input.versions) ? input.versions.slice(0, 100) : [];
    if (!versions.length) throw new Error('脚本版本不能为空');
    const approved = input.approved === true;
    const status = approved ? 'approved' : 'draft';
    const timestamp = now();
    const existing = this.db.prepare('SELECT tenant_id, project_id, created_at FROM script_sets WHERE id = ?').get(id);
    if (existing && (existing.tenant_id !== context.tenantId || existing.project_id !== context.project.id)) {
      throw new Error('脚本集已经属于其他项目或客户工作区');
    }
    this.db.prepare(`
      INSERT INTO script_sets (id, tenant_id, project_id, task_id, name, status, payload_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, name = excluded.name,
        status = excluded.status, payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(id, context.tenantId, context.project.id, text(input.taskId, null), name, status, json({ name }), actorName(actor), existing?.created_at || timestamp, timestamp);
    for (const [index, raw] of versions.entries()) {
      const versionId = text(raw?.id, `script_version_${randomUUID()}`);
      const scriptText = text(raw?.text);
      if (!scriptText) throw new Error('脚本正文不能为空');
      if (scriptText.length > 5000) throw new Error('脚本正文超过 5000 字上限（S6-01 长度控制），请拆分或精简后再登记');
      const scriptSummary = scriptText.replace(/\s+/g, ' ').trim().slice(0, 120);
      const versionExisting = this.db.prepare('SELECT tenant_id, project_id, created_at FROM script_versions WHERE id = ?').get(versionId);
      if (versionExisting && (versionExisting.tenant_id !== context.tenantId || versionExisting.project_id !== context.project.id)) {
        throw new Error('脚本版本已经属于其他项目或客户工作区');
      }
      const payload = {
        title: text(raw?.title, `脚本 ${index + 1}`),
        text: scriptText,
        summary: scriptSummary,
        textLength: scriptText.length,
        platform: text(raw?.platform, null),
        language: text(raw?.language, 'zh-CN'),
        estimatedDurationSeconds: Number(raw?.estimatedDurationSeconds) || null,
      };
      this.db.prepare(`
        INSERT INTO script_versions (
          id, script_set_id, tenant_id, project_id, task_id, version_number, status,
          batch_allowed, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, batch_allowed = excluded.batch_allowed,
          payload_json = excluded.payload_json, updated_at = excluded.updated_at
      `).run(
        versionId,
        id,
        context.tenantId,
        context.project.id,
        text(input.taskId, null),
        Number(raw?.version) > 0 ? Number(raw.version) : index + 1,
        status,
        approved ? 1 : 0,
        json(payload),
        versionExisting?.created_at || timestamp,
        timestamp,
      );
    }
    return {
      id,
      projectId: context.project.id,
      tenantId: context.tenantId,
      name,
      status,
      versions: this.listScriptVersions(actor, context.project.id, input.taskId, id),
    };
  }

  ensureDefaultTemplate(actor, projectId) {
    const context = this.context(actor, projectId);
    const id = 'edit_template_vertical_default';
    const versionId = 'edit_template_vertical_default_v1';
    const timestamp = now();
    const payload = {
      displayName: '竖屏口播标准模板',
      width: 1080,
      height: 1920,
      fps: 30,
      durationLimitSeconds: 180,
      captionPreset: 'high_contrast_bottom',
      safeArea: { top: 120, bottom: 240, left: 72, right: 72 },
    };
    this.db.prepare(`
      INSERT INTO edit_templates (id, tenant_id, project_id, name, status, payload_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(id, context.tenantId, context.project.id, payload.displayName, json(payload), actorName(actor), timestamp, timestamp);
    this.db.prepare(`
      INSERT INTO edit_template_versions (
        id, template_id, tenant_id, project_id, version_number, status, batch_allowed, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, 'approved', 1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, status = 'approved', batch_allowed = 1,
        payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(versionId, id, context.tenantId, context.project.id, json(payload), timestamp, timestamp);
    return {
      profile: { id, projectId: context.project.id, tenantId: context.tenantId, name: payload.displayName, status: 'approved' },
      version: publicVersion(this.db.prepare('SELECT * FROM edit_template_versions WHERE id = ?').get(versionId)),
    };
  }

  createTemplate(actor, input = {}) {
    const context = this.context(actor, input.projectId);
    const name = text(input.name, '未命名模板');
    const id = text(input.id, 'edit_template_' + randomUUID());
    const versionId = text(input.versionId, 'edit_template_version_' + randomUUID());
    const approved = input.approved === true;
    const status = approved ? 'approved' : 'draft';
    const batchAllowed = approved && input.batchAllowed === true;
    const dimension = (value, fallback, label) => {
      const number = Number(value ?? fallback);
      if (!Number.isInteger(number) || number < 2 || number > 4096 || number % 2 !== 0) throw new Error(label + '必须是 2–4096 的偶数');
      return number;
    };
    const positive = (value, fallback, label, maximum = 120) => {
      const number = Number(value ?? fallback);
      if (!Number.isFinite(number) || number <= 0 || number > maximum) throw new Error(label + '格式不正确');
      return number;
    };
    const safeAreaInput = input.safeArea && typeof input.safeArea === 'object' ? input.safeArea : {};
    const safeArea = Object.fromEntries(['top', 'bottom', 'left', 'right'].map((key) => {
      const number = Number(safeAreaInput[key] ?? (key === 'top' ? 120 : key === 'bottom' ? 240 : 72));
      if (!Number.isFinite(number) || number < 0 || number > 4096) throw new Error('模板安全区格式不正确');
      return [key, Math.round(number)];
    }));
    const timestamp = now();
    const existing = this.db.prepare('SELECT tenant_id, project_id, created_at FROM edit_templates WHERE id = ?').get(id);
    if (existing && (existing.tenant_id !== context.tenantId || existing.project_id !== context.project.id)) {
      throw new Error('模板已经属于其他项目或客户工作区');
    }
    const payload = {
      displayName: name,
      width: dimension(input.width, 1080, '模板宽度'),
      height: dimension(input.height, 1920, '模板高度'),
      fps: positive(input.fps, 30, '模板帧率'),
      durationLimitSeconds: positive(input.durationLimitSeconds, 180, '模板时长上限', 3600),
      captionPreset: text(input.captionPreset, 'high_contrast_bottom'),
      captionFontName: text(input.captionFontName, 'Arial'),
      captionFontSize: positive(input.captionFontSize, 54, '字幕字号', 240),
      safeArea,
      backgroundColor: text(input.backgroundColor, 'black'),
      backgroundRef: text(input.backgroundRef, null),
      logoRef: text(input.logoRef, null),
      logoWidth: positive(input.logoWidth, 240, 'Logo 宽度', 2048),
      logoX: Number.isFinite(Number(input.logoX)) ? Math.round(Number(input.logoX)) : null,
      logoY: Number.isFinite(Number(input.logoY)) ? Math.round(Number(input.logoY)) : null,
      logoOpacity: Number.isFinite(Number(input.logoOpacity)) ? Math.min(1, Math.max(0, Number(input.logoOpacity))) : 1,
      introRef: text(input.introRef, null),
      outroRef: text(input.outroRef, null),
      musicRef: text(input.musicRef, null),
      musicVolume: Number.isFinite(Number(input.musicVolume)) ? Math.min(2, Math.max(0, Number(input.musicVolume))) : 0.12,
      coverText: text(input.coverText, null),
      licenseRef: text(input.licenseRef, null),
      notes: text(input.notes, null),
    };
    this.db.prepare(`
      INSERT INTO edit_templates (id, tenant_id, project_id, name, status, payload_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status,
        payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(id, context.tenantId, context.project.id, name, status, json(payload), actorName(actor), existing?.created_at || timestamp, timestamp);
    const versionExisting = this.db.prepare('SELECT tenant_id, project_id, created_at FROM edit_template_versions WHERE id = ?').get(versionId);
    if (versionExisting && (versionExisting.tenant_id !== context.tenantId || versionExisting.project_id !== context.project.id)) {
      throw new Error('模板版本已经属于其他项目或客户工作区');
    }
    const versionNumber = Number(input.version || 1);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) throw new Error('模板版本号格式不正确');
    const conflictingVersion = this.db.prepare('SELECT id FROM edit_template_versions WHERE template_id = ? AND version_number = ? AND id != ?').get(id, versionNumber, versionId);
    if (conflictingVersion) throw new Error('模板版本号已经存在：' + versionNumber);
    this.db.prepare(`
      INSERT INTO edit_template_versions (
        id, template_id, tenant_id, project_id, version_number, status, batch_allowed, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, batch_allowed = excluded.batch_allowed,
        payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(
      versionId,
      id,
      context.tenantId,
      context.project.id,
      versionNumber,
      status,
      batchAllowed ? 1 : 0,
      json(payload),
      versionExisting?.created_at || timestamp,
      timestamp,
    );
    return {
      profile: { id, projectId: context.project.id, tenantId: context.tenantId, name, status, ...payload },
      version: publicVersion(this.db.prepare('SELECT * FROM edit_template_versions WHERE id = ?').get(versionId)),
    };
  }

  ensureSimulationConnector(actor, projectId) {
    const context = this.context(actor, projectId);
    const id = 'connector_' + createHash('sha1').update(context.tenantId + '\u0000digital-human-simulation').digest('hex').slice(0, 16);
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO connectors (id, tenant_id, name, kind, status, capabilities_json, config_json, created_at, updated_at)
      VALUES (?, ?, '本地数字人模拟连接器', 'simulation', 'simulation', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = 'simulation', capabilities_json = excluded.capabilities_json,
        config_json = excluded.config_json, updated_at = excluded.updated_at
    `).run(
      id,
      context.tenantId,
      json(['talking_head', 'tts', 'media.render', 'package.export']),
      json({ mode: 'simulation', output: 'manifest_only' }),
      timestamp,
      timestamp,
    );
    if (actor?.role !== 'admin') this.workbench.grantConnector(actor, id, ['use', 'talking_head'], 'allow');
    return publicConnector(this.db.prepare('SELECT * FROM connectors WHERE id = ?').get(id), true);
  }

  listAvatarVersions(actor, projectId) {
    const context = this.context(actor, projectId);
    return this.db.prepare('SELECT * FROM avatar_profile_versions WHERE project_id = ? ORDER BY updated_at DESC').all(context.project.id).map((row) => publicVersion(row));
  }

  listVoiceVersions(actor, projectId) {
    const context = this.context(actor, projectId);
    return this.db.prepare('SELECT * FROM voice_profile_versions WHERE project_id = ? ORDER BY updated_at DESC').all(context.project.id).map((row) => publicVersion(row));
  }

  listScriptVersions(actor, projectId, taskId = null, scriptSetId = null) {
    const context = this.context(actor, projectId);
    const conditions = ['project_id = ?'];
    const params = [context.project.id];
    if (scriptSetId) {
      conditions.push('script_set_id = ?');
      params.push(scriptSetId);
    } else if (taskId) {
      conditions.push('(task_id IS NULL OR task_id = ?)');
      params.push(taskId);
    }
    return this.db.prepare(`SELECT * FROM script_versions WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`).all(...params).map((row) => publicVersion(row));
  }

  listTemplateVersions(actor, projectId) {
    const context = this.context(actor, projectId);
    return this.db.prepare('SELECT * FROM edit_template_versions WHERE project_id = ? ORDER BY updated_at DESC').all(context.project.id).map((row) => publicVersion(row));
  }

  listCatalog(actor, projectId, taskId = null) {
    const context = this.context(actor, projectId);
    const template = this.ensureDefaultTemplate(actor, context.project.id);
    const connector = this.ensureSimulationConnector(actor, context.project.id);
    const connectors = this.workbench.listConnectors(actor)
      .filter((item) => item.capabilities.includes('talking_head') || item.capabilities.includes('tts'))
      .map((item) => ({ ...item, config: item.config || {} }));
    return {
      project: context.project,
      avatars: this.listAvatarVersions(actor, context.project.id),
      voices: this.listVoiceVersions(actor, context.project.id),
      scripts: this.listScriptVersions(actor, context.project.id, taskId),
      templates: this.listTemplateVersions(actor, context.project.id),
      connectors: connectors.length ? connectors : [connector],
      defaults: { templateVersionId: template.version.id, connectorId: connector.id },
    };
  }

  saveBatch(actor, batch) {
    const context = this.context(actor, batch?.projectId);
    if (text(batch?.tenantId) !== context.tenantId) throw new Error('批次租户边界不一致');
    const id = text(batch?.id);
    const taskId = text(batch?.taskId);
    if (!id || !taskId || !Array.isArray(batch.items) || !batch.items.length) throw new Error('批次数据不完整');
    const items = validateBatchItems(batch, context);
    const timestamp = text(batch.updatedAt, now());
    const existing = this.db.prepare('SELECT tenant_id, project_id, created_at FROM content_batches WHERE id = ?').get(id);
    if (existing && (existing.tenant_id !== context.tenantId || existing.project_id !== context.project.id)) {
      throw new Error('批次已经属于其他项目或客户工作区');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO content_batches (id, tenant_id, project_id, task_id, status, title, payload_json, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, title = excluded.title,
          payload_json = excluded.payload_json, updated_at = excluded.updated_at
      `).run(id, context.tenantId, context.project.id, taskId, text(batch.status, 'draft'), text(batch.title, '数字人批次'), json(batch), actorName(batch.createdBy || actor), text(batch.createdAt, existing?.created_at || timestamp), timestamp);
      const insert = this.db.prepare(`
        INSERT INTO content_batch_items (
          id, batch_id, tenant_id, project_id, task_id, idempotency_key, status, attempt,
          lease_owner, lease_until, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, attempt = excluded.attempt,
          lease_owner = excluded.lease_owner, lease_until = excluded.lease_until,
          payload_json = excluded.payload_json, updated_at = excluded.updated_at
      `);
      const itemIds = new Set();
      for (const { item, id: itemId, idempotencyKey } of items) {
        const terminal = TERMINAL_ITEM_STATUSES.has(item.status);
        const persistedItem = terminal ? { ...item, leaseOwner: null, leaseUntil: null } : item;
        itemIds.add(itemId);
        insert.run(
          itemId,
          id,
          context.tenantId,
          context.project.id,
          taskId,
          idempotencyKey,
          text(item.status, 'planned'),
          Number.isInteger(item.attempt) ? item.attempt : 0,
          text(persistedItem.leaseOwner, null),
          text(persistedItem.leaseUntil, null),
          json(persistedItem),
          text(item.createdAt, timestamp),
          text(item.updatedAt, timestamp),
        );
      }
      for (const existingItem of this.db.prepare('SELECT id FROM content_batch_items WHERE batch_id = ?').all(id)) {
        if (!itemIds.has(existingItem.id)) this.db.prepare('DELETE FROM content_batch_items WHERE id = ?').run(existingItem.id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getBatch(actor, id);
  }

  getBatch(actor, batchId) {
    const row = this.db.prepare('SELECT * FROM content_batches WHERE id = ?').get(text(batchId));
    if (!row) return null;
    this.assertExistingScope(actor, row);
    const batch = parse(row.payload_json, {});
    const items = this.db.prepare('SELECT * FROM content_batch_items WHERE batch_id = ? ORDER BY rowid').all(row.id).map((item) => ({
      ...parse(item.payload_json, {}),
      id: item.id,
      idempotencyKey: item.idempotency_key,
      status: item.status,
      attempt: item.attempt,
      leaseOwner: item.lease_owner,
      leaseUntil: item.lease_until,
      updatedAt: item.updated_at,
    }));
    return { ...batch, id: row.id, tenantId: row.tenant_id, projectId: row.project_id, taskId: row.task_id, status: row.status, title: row.title, items };
  }

  listBatches(actor, projectId, taskId = null) {
    const context = this.context(actor, projectId);
    const rows = taskId
      ? this.db.prepare('SELECT * FROM content_batches WHERE project_id = ? AND task_id = ? ORDER BY updated_at DESC').all(context.project.id, taskId)
      : this.db.prepare('SELECT * FROM content_batches WHERE project_id = ? ORDER BY updated_at DESC').all(context.project.id);
    return rows.map((row) => this.getBatch(actor, row.id));
  }

  /* -------------------------------------------------------------------------
     F5-02：最小任务草稿
     草稿只保存“这次生产想做什么”，不保存明细、不参与状态机、不进入交付。
     真正的批次仍然只由 buildBatchPlan + createContentBatch 产生。
     ------------------------------------------------------------------------- */

  getDraft(actor, projectId, taskId = null) {
    const context = this.context(actor, projectId);
    const row = taskId
      ? this.db.prepare('SELECT * FROM digital_human_drafts WHERE project_id = ? AND task_id = ? ORDER BY updated_at DESC LIMIT 1').get(context.project.id, taskId)
      : this.db.prepare('SELECT * FROM digital_human_drafts WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1').get(context.project.id);
    if (!row) return null;
    return this.publicDraft(row);
  }

  publicDraft(row) {
    return {
      ...parse(row.payload_json, {}),
      id: row.id,
      tenantId: row.tenant_id,
      projectId: row.project_id,
      taskId: row.task_id,
      mode: row.mode,
      title: row.title,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  saveDraft(actor, input = {}) {
    const context = this.context(actor, input.projectId);
    const taskId = text(input.taskId);
    if (!taskId) throw new Error('草稿必须关联一个内容任务');
    const existing = this.getDraft(actor, context.project.id, taskId);
    const mode = text(input.mode, existing?.mode || 'A');
    if (!['A', 'B'].includes(mode)) throw new Error('草稿模式只能是 A 或 B');
    const id = text(input.id, existing?.id || 'dh_draft_' + randomUUID());
    const timestamp = now();
    /* 合并语义：字段为 undefined 表示“保持原值”，null / 空串表示“清除”。
       这样客户端每次只提交它改动的字段，不会把别的选择意外抹掉。 */
    const pickText = (value, previous) => {
      if (value === undefined) return previous ?? null;
      const trimmed = typeof value === 'string' ? value.trim() : '';
      return trimmed ? trimmed : null;
    };
    const pickCount = (value, previous) => {
      if (value === undefined) return previous ?? null;
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    };
    const pickObject = (value, previous) => {
      if (value === undefined) return previous ?? null;
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    };
    /* F5-05：显式明细行。一行对应一个输出，系统不会自动全组合。 */
    const pickRows = (value, previous) => {
      if (value === undefined) return previous ?? null;
      if (!Array.isArray(value)) return null;
      return value.slice(0, 300).map((row, index) => ({
        rowNo: index + 1,
        mode: text(row?.mode, 'A') === 'B' ? 'B' : 'A',
        scriptVersionId: text(row?.scriptVersionId, null),
        avatarVersionId: text(row?.avatarVersionId, null),
        voiceVersionId: text(row?.voiceVersionId, null),
        templateVersionId: text(row?.templateVersionId, null),
        sourceVideoAssetId: text(row?.sourceVideoAssetId, null),
        mappingVersionId: text(row?.mappingVersionId, null),
        outputName: text(row?.outputName, null),
        outputSubdirectory: text(row?.outputSubdirectory, null),
      }));
    };
    const payload = {
      note: pickText(input.note, existing?.note),
      plannedItemCount: pickCount(input.plannedItemCount, existing?.plannedItemCount),
      plannedItems: pickRows(input.plannedItems, existing?.plannedItems),
      outputPolicy: pickObject(input.outputPolicy, existing?.outputPolicy),
      preflightResult: pickObject(input.preflightResult, existing?.preflightResult),
      preflightHistory: (function (value, previous) { if (value === undefined) return previous ?? null; if (!Array.isArray(value)) return previous ?? null; return value.slice(-20); })(input.preflightHistory, existing?.preflightHistory),
      /* F5-03/F5-04：P02 选定的文案版本、P03/P05 选定的形象/声音/模板版本。
         这里只做存储，不做业务判定（判定在投影层 + buildBatchPlan）。 */
      selectedScriptVersionId: pickText(input.selectedScriptVersionId, existing?.selectedScriptVersionId),
      selectedAvatarVersionId: pickText(input.selectedAvatarVersionId, existing?.selectedAvatarVersionId),
      selectedVoiceVersionId: pickText(input.selectedVoiceVersionId, existing?.selectedVoiceVersionId),
      selectedTemplateVersionId: pickText(input.selectedTemplateVersionId, existing?.selectedTemplateVersionId),
      createdBatchId: pickText(input.createdBatchId, existing?.createdBatchId),
      selectedContextId: pickText(input.selectedContextId, existing?.selectedContextId),
      contextSnapshot: pickObject(input.contextSnapshot, existing?.contextSnapshot),
    };
    this.db.prepare(`
      INSERT INTO digital_human_drafts (id, tenant_id, project_id, task_id, mode, title, payload_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, title = excluded.title,
        payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(
      id, context.tenantId, context.project.id, taskId, mode,
      text(input.title, existing?.title || '未命名口播生产草稿'),
      json(payload), actorName(actor), existing?.createdAt || timestamp, timestamp,
    );
    return this.publicDraft(this.db.prepare('SELECT * FROM digital_human_drafts WHERE id = ?').get(id));
  }

  recoverExpiredLeases(actor, batchId, timestamp = now()) {
    const batch = this.getBatch(actor, batchId);
    if (!batch) return null;
    let changed = false;
    for (const item of batch.items) {
      if (item.status !== 'running' || !item.leaseUntil || item.leaseUntil > timestamp) continue;
      item.status = 'queued';
      item.stage = 'queued';
      item.leaseOwner = null;
      item.leaseUntil = null;
      item.error = { errorClass: 'lease_expired', code: 'LEASE_EXPIRED', message: '执行器租约已过期，已回到队列', retryable: true };
      item.updatedAt = timestamp;
      changed = true;
    }
    return changed ? this.saveBatch(actor, batch) : batch;
  }

  saveModelRun(actor, run) {
    const batch = this.getBatch(actor, run.batchId);
    if (!batch || !batch.items.some((item) => item.id === run.itemId)) throw new Error('模型运行缺少可访问的批次条目');
    const context = this.context(actor, batch.projectId);
    const timestamp = text(run.updatedAt, now());
    this.db.prepare(`
      INSERT INTO model_runs (id, batch_id, item_id, tenant_id, project_id, task_id, connector_id, status, attempt, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, attempt = excluded.attempt,
        payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(
      text(run.id, 'model_run_' + randomUUID()), batch.id, run.itemId, context.tenantId, context.project.id,
      batch.taskId, text(run.connectorId, ''), text(run.status, 'queued'), Number(run.attempt) || 0,
      json(run), text(run.createdAt, timestamp), timestamp,
    );
    return run;
  }

  listModelRuns(actor, batchId) {
    const batch = this.getBatch(actor, batchId);
    if (!batch) return [];
    return this.db.prepare('SELECT * FROM model_runs WHERE batch_id = ? ORDER BY created_at, id').all(batch.id).map((row) => ({
      ...parse(row.payload_json, {}),
      id: row.id,
      batchId: row.batch_id,
      itemId: row.item_id,
      status: row.status,
      attempt: row.attempt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  saveQualityReport(actor, report) {
    const batch = this.getBatch(actor, report.batchId);
    if (!batch || !batch.items.some((item) => item.id === report.itemId)) throw new Error('质量报告缺少可访问的批次条目');
    const context = this.context(actor, batch.projectId);
    const timestamp = text(report.updatedAt, now());
    this.db.prepare(`
      INSERT INTO quality_reports (id, batch_id, item_id, tenant_id, project_id, task_id, status, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(
      text(report.id, 'quality_report_' + randomUUID()), batch.id, report.itemId, context.tenantId, context.project.id,
      batch.taskId, text(report.status, 'pending'), json(report), text(report.createdAt, timestamp), timestamp,
    );
    return report;
  }

  listQualityReports(actor, batchId) {
    const batch = this.getBatch(actor, batchId);
    if (!batch) return [];
    return this.db.prepare('SELECT * FROM quality_reports WHERE batch_id = ? ORDER BY created_at, id').all(batch.id).map((row) => ({
      ...parse(row.payload_json, {}),
      id: row.id,
      batchId: row.batch_id,
      itemId: row.item_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /* -------------------------------------------------------------------------
     S6-01：N01 项目上下文（带版本）与 N02 文案生成需求
     版本语义：同一 context_key 每次保存产生新版本行；旧行永不改写，
     所以旧任务/旧草稿引用的 context id 永远可以回溯（N17 输入冻结）。
     ------------------------------------------------------------------------- */

  publicProjectContext(row) {
    return {
      id: row.id,
      contextKey: row.context_key,
      version: row.version,
      name: row.name,
      industry: row.industry || null,
      product: row.product || null,
      audience: row.audience || null,
      sellingPoints: parse(row.selling_points_json, []),
      contentGoal: row.content_goal || null,
      status: row.status,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listProjectContexts(actor, projectId) {
    const context = this.context(actor, projectId);
    return this.db.prepare('SELECT * FROM project_contexts WHERE project_id = ? ORDER BY context_key, version DESC').all(context.project.id)
      .map((row) => this.publicProjectContext(row));
  }

  getProjectContext(actor, projectId, contextId) {
    const context = this.context(actor, projectId);
    const row = this.db.prepare('SELECT * FROM project_contexts WHERE project_id = ? AND id = ?').get(context.project.id, text(contextId));
    return row ? this.publicProjectContext(row) : null;
  }

  saveProjectContext(actor, input = {}) {
    const context = this.context(actor, input.projectId);
    const timestamp = now();
    const existingKey = text(input.contextKey, null);
    let contextKey = existingKey;
    let version = 1;
    if (contextKey) {
      const latest = this.db.prepare('SELECT version, status FROM project_contexts WHERE project_id = ? AND context_key = ? ORDER BY version DESC LIMIT 1').get(context.project.id, contextKey);
      if (!latest) throw new Error('项目上下文版本不存在：' + contextKey);
      version = latest.version + 1;
    } else {
      contextKey = 'ctx_' + randomUUID();
    }
    const id = 'pctx_' + randomUUID();
    const sellingPoints = Array.isArray(input.sellingPoints) ? input.sellingPoints.map((point) => text(point)).filter(Boolean).slice(0, 20) : [];
    this.db.prepare(`
      INSERT INTO project_contexts (id, tenant_id, project_id, context_key, version, name, industry, product, audience, selling_points_json, content_goal, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, context.tenantId, context.project.id, contextKey, version,
      text(input.name, '未命名项目档案'),
      text(input.industry, null), text(input.product, null), text(input.audience, null),
      json(sellingPoints), text(input.contentGoal, null),
      text(input.status, 'active'), actorName(actor), timestamp, timestamp,
    );
    return this.publicProjectContext(this.db.prepare('SELECT * FROM project_contexts WHERE id = ?').get(id));
  }

  listCopyRequests(actor, projectId) {
    const context = this.context(actor, projectId);
    return this.db.prepare('SELECT * FROM copy_generation_requests WHERE project_id = ? ORDER BY updated_at DESC LIMIT 20').all(context.project.id)
      .map((row) => ({
        id: row.id,
        contextId: row.context_id || null,
        count: row.count || null,
        direction: row.direction || null,
        platform: row.platform || null,
        durationSeconds: row.duration_seconds || null,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  saveCopyRequest(actor, input = {}) {
    const context = this.context(actor, input.projectId);
    const timestamp = now();
    const existing = this.db.prepare('SELECT id FROM copy_generation_requests WHERE project_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 1').get(context.project.id, 'ready');
    const id = existing?.id || 'copyreq_' + randomUUID();
    const count = Number.isInteger(Number(input.count)) && Number(input.count) > 0 && Number(input.count) <= 50 ? Number(input.count) : null;
    const duration = Number.isInteger(Number(input.durationSeconds)) && Number(input.durationSeconds) > 0 ? Number(input.durationSeconds) : null;
    this.db.prepare(`
      INSERT INTO copy_generation_requests (id, tenant_id, project_id, context_id, count, direction, platform, duration_seconds, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET context_id = excluded.context_id, count = excluded.count, direction = excluded.direction,
        platform = excluded.platform, duration_seconds = excluded.duration_seconds, updated_at = excluded.updated_at
    `).run(
      id, context.tenantId, context.project.id, text(input.contextId, null),
      count, text(input.direction, null), text(input.platform, null), duration,
      'ready', actorName(actor), existing?.created_at || timestamp, timestamp,
    );
    return this.listCopyRequests(actor, input.projectId)[0] || null;
  }

  /* -------------------------------------------------------------------------
     S6-02：N05–N10 数字人档案（绑定形象/声音版本）；S6-03：N11–N12 已有视频与映射。
     没有真实训练提供方时，处理状态停在 pending_provider（待处理-提供方未配置），
     绝不伪装成已训练。可用性由绑定版本的 approved/batchAllowed 推导。
     ------------------------------------------------------------------------- */

  listDigitalHumanProfiles(actor, projectId) {
    const context = this.context(actor, projectId);
    return this.db.prepare('SELECT * FROM digital_human_profiles WHERE project_id = ? ORDER BY updated_at DESC').all(context.project.id)
      .map((row) => ({
        id: row.id,
        name: row.name,
        subjectRole: row.subject_role || null,
        avatarVersionId: row.avatar_version_id || null,
        voiceVersionId: row.voice_version_id || null,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  saveDigitalHumanProfile(actor, input = {}) {
    const context = this.context(actor, input.projectId);
    const timestamp = now();
    const id = text(input.id, text(input.id, null) || 'dhp_' + randomUUID());
    const existing = this.db.prepare('SELECT id, created_at FROM digital_human_profiles WHERE id = ?').get(id);
    if (existing && existing.id && text(input.id) !== id) throw new Error('档案 ID 冲突');
    this.db.prepare(`
      INSERT INTO digital_human_profiles (id, tenant_id, project_id, name, subject_role, avatar_version_id, voice_version_id, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, subject_role = excluded.subject_role,
        avatar_version_id = excluded.avatar_version_id, voice_version_id = excluded.voice_version_id,
        status = excluded.status, updated_at = excluded.updated_at
    `).run(
      id, context.tenantId, context.project.id,
      text(input.name, '未命名员工'),
      text(input.subjectRole, null),
      text(input.avatarVersionId, null),
      text(input.voiceVersionId, null),
      text(input.status, 'draft'),
      actorName(actor), existing?.created_at || timestamp, timestamp,
    );
    return this.listDigitalHumanProfiles(actor, input.projectId).find((item) => item.id === id) || null;
  }

  listSourceVideos(actor, projectId) {
    const context = this.context(actor, projectId);
    return this.db.prepare('SELECT * FROM source_videos WHERE project_id = ? ORDER BY updated_at DESC').all(context.project.id)
      .map((row) => ({
        id: row.id,
        subjectId: row.subject_id || null,
        name: row.name,
        fileRef: row.file_ref || null,
        durationSeconds: row.duration_seconds || null,
        aspect: row.aspect || null,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  saveSourceVideo(actor, input = {}) {
    const context = this.context(actor, input.projectId);
    const timestamp = now();
    const id = 'srcvid_' + randomUUID();
    this.db.prepare(`
      INSERT INTO source_videos (id, tenant_id, project_id, subject_id, name, file_ref, duration_seconds, aspect, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, context.tenantId, context.project.id,
      text(input.subjectId, null), text(input.name, '未命名视频'), text(input.fileRef, null),
      Number.isInteger(Number(input.durationSeconds)) && Number(input.durationSeconds) > 0 ? Number(input.durationSeconds) : null,
      text(input.aspect, null),
      text(input.status, text(input.fileRef, null) ? 'usable' : 'pending_check'), actorName(actor), timestamp, timestamp,
    );
    return this.listSourceVideos(actor, input.projectId).find((item) => item.id === id) || null;
  }

  listVideoMappings(actor, projectId) {
    const context = this.context(actor, projectId);
    return this.db.prepare('SELECT * FROM video_mappings WHERE project_id = ? ORDER BY updated_at DESC').all(context.project.id)
      .map((row) => ({
        id: row.id,
        videoId: row.video_id || null,
        scriptVersionId: row.script_version_id || null,
        voiceSource: row.voice_source || null,
        voiceVersionId: row.voice_version_id || null,
        templateVersionId: row.template_version_id || null,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  saveVideoMapping(actor, input = {}) {
    const context = this.context(actor, input.projectId);
    const timestamp = now();
    if (!text(input.videoId)) throw new Error('映射必须关联一个已有视频');
    const id = text(input.id, null) || 'vmap_' + randomUUID();
    const existing = this.db.prepare('SELECT id, created_at FROM video_mappings WHERE id = ?').get(id);
    this.db.prepare(`
      INSERT INTO video_mappings (id, tenant_id, project_id, video_id, script_version_id, voice_source, voice_version_id, template_version_id, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET video_id = excluded.video_id, script_version_id = excluded.script_version_id,
        voice_source = excluded.voice_source, voice_version_id = excluded.voice_version_id,
        template_version_id = excluded.template_version_id, status = excluded.status, updated_at = excluded.updated_at
    `).run(
      id, context.tenantId, context.project.id,
      text(input.videoId), text(input.scriptVersionId, null),
      text(input.voiceSource, 'original'), text(input.voiceVersionId, null), text(input.templateVersionId, null),
      text(input.status, 'draft'), actorName(actor), existing?.created_at || timestamp, timestamp,
    );

    return this.listVideoMappings(actor, input.projectId).find((item) => item.id === id) || null;
  }

  /* -------------------------------------------------------------------------
     S7-01：N18 Provider Registry。
     status: candidate（候选，只登记不接入）| preferred（首选，通过验证）|
             blocked（许可/硬件/质量任一不过）| simulation（模拟占位）。
     N17 闸门只认 preferred；simulation/candidate 一律如实阻塞。
     ------------------------------------------------------------------------- */

  listN18Providers(actor) {
    const context = this.context(actor, null);
    return this.db.prepare('SELECT * FROM n18_providers WHERE tenant_id = ? ORDER BY capability, status').all(context.tenantId)
      .map((row) => ({
        id: row.id,
        capability: row.capability,
        providerKey: row.provider_key,
        transport: row.transport,
        endpoint: row.endpoint || null,
        status: row.status,
        licenseCode: row.license_code || null,
        licenseWeights: row.license_weights || null,
        notes: row.notes || null,
        updatedAt: row.updated_at,
      }));
  }

  saveN18Provider(actor, input = {}) {
    const context = this.context(actor, null);
    const timestamp = now();
    if (!['tts', 'talking_head', 'lipsync'].includes(input.capability)) throw new Error('未知的 N18 能力类型：' + input.capability);
    if (!['candidate', 'preferred', 'blocked', 'simulation'].includes(input.status)) throw new Error('未知的 Provider 状态：' + input.status);
    const id = text(input.id, 'n18p_' + randomUUID());
    const existing = this.db.prepare('SELECT id, created_at FROM n18_providers WHERE id = ?').get(id);
    this.db.prepare(`
      INSERT INTO n18_providers (id, tenant_id, capability, provider_key, transport, endpoint, status, license_code, license_weights, notes, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET capability = excluded.capability, provider_key = excluded.provider_key,
        transport = excluded.transport, endpoint = excluded.endpoint, status = excluded.status,
        license_code = excluded.license_code, license_weights = excluded.license_weights,
        notes = excluded.notes, updated_at = excluded.updated_at
    `).run(
      id, context.tenantId, input.capability, text(input.providerKey, 'unknown'),
      text(input.transport, 'http-worker'), text(input.endpoint, null), input.status,
      text(input.licenseCode, null), text(input.licenseWeights, null), text(input.notes, null),
      actorName(actor), existing?.created_at || timestamp, timestamp,
    );
    return this.listN18Providers(actor).find((item) => item.id === id) || null;
  }

  seedN18Providers(actor) {
    const existing = this.listN18Providers(actor);
    const knownKeys = new Set(existing.map((item) => item.providerKey));
    const seed = [
      { capability: 'tts', providerKey: 'fake-tts', transport: 'simulation', status: 'simulation', notes: 'fake adapter：只验证协议与队列' },
      { capability: 'talking_head', providerKey: 'fake-avatar', transport: 'simulation', status: 'simulation', notes: 'fake adapter：只验证协议与队列' },
      { capability: 'talking_head', providerKey: 'musetalk-1.5', transport: 'command', status: 'candidate', licenseCode: 'NOASSERTION（仓库许可需逐字核对）', notes: '受控 wrapper 已存在于 wrappers/musetalk_talking_head.py；需外部 NVIDIA Worker' },
      { capability: 'talking_head', providerKey: 'duix-avatar', transport: 'http-worker', status: 'candidate', licenseCode: 'DUIX Community License（署名/披露/MAU 条款）', notes: '模式 A 主候选；需外部 NVIDIA Worker + ~32GB 内存' },
      { capability: 'tts', providerKey: 'qwen3-tts', transport: 'command', status: 'candidate', licenseCode: 'Apache-2.0（代码）；权重按模型卡', notes: '声音首选；本机 MPS/MLX 可行性待验证（已有 mlx_audio wrapper）' },
      { capability: 'tts', providerKey: 'cosyvoice', transport: 'command', status: 'candidate', licenseCode: 'Apache-2.0（代码）；权重按模型卡', notes: '声音备用；CUDA 优先' },
      { capability: 'lipsync', providerKey: 'latentsync', transport: 'command', status: 'candidate', licenseCode: 'Apache-2.0（代码）', notes: 'LatentSync 质量对比候选；CUDA 重' },
      { capability: 'tts', providerKey: 'doubao-voice-clone-2.0', transport: 'http-worker', status: 'preferred', licenseCode: '商用 API（火山引擎声音复刻2.0，免费额度+按量）', notes: 'S7-02 真实样片验收通过（2026-09-14 负责人试听认可）。复刻走控制台/上传 wrapper，合成走 v3 unidirectional seed-icl-2.0。' },
      { capability: 'tts', providerKey: 'doubao-tts-api', transport: 'http-worker', status: 'candidate', licenseCode: '商用 API（火山引擎，按量 1.3 元/千字）', notes: 'S7-02 调研首选：抖音同款中文情感顶级；按量付费无需 GPU；需 API Key' },
      { capability: 'tts', providerKey: 'minimax-audio', transport: 'http-worker', status: 'candidate', licenseCode: '商用 API（MiniMax，约 $0.10/1K）', notes: '口碑最佳开箱自然度（听不出 AI）；需 API Key' },
      { capability: 'talking_head', providerKey: 'guiji-avatar-api', transport: 'http-worker', status: 'candidate', licenseCode: '商用 API（硅基智能官方，HeyGem 同厂云端版，按条/套餐计费）', notes: '零部署替代：与 HeyGem 同厂同技术栈的云端 API；适合低频阶段或不想管 GPU' },
      { capability: 'talking_head', providerKey: 'shanjian-api', transport: 'http-worker', status: 'candidate', licenseCode: '商用 API（闪剪，299 元/月起）', notes: '批量短视频友好；效果对比候选' },
    ];
    for (const item of seed) {
      if (!knownKeys.has(item.providerKey)) this.saveN18Provider(actor, item);
    }
    return this.listN18Providers(actor);
  }
}
