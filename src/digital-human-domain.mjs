import { createHash } from 'node:crypto';

export const BATCH_STATUSES = Object.freeze([
  'draft',
  'waiting_approval',
  'queued',
  'running',
  'paused',
  'waiting_review',
  'completed',
  'partial_failed',
  'blocked',
  'cancelled',
]);

export const BATCH_ITEM_STATUSES = Object.freeze([
  'planned',
  'queued',
  'running',
  'succeeded',
  'approved',
  'changes_requested',
  'failed',
  'blocked',
  'cancelled',
]);

const TERMINAL_ITEM_STATUSES = new Set(['approved', 'failed', 'blocked', 'cancelled']);
const ACTIVE_ITEM_STATUSES = new Set(['planned', 'queued', 'running', 'changes_requested']);

function clone(value) {
  return value && typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function ids(value, label) {
  const values = Array.isArray(value) ? value : [value];
  const normalized = values.map((item) => text(item)).filter(Boolean);
  if (!normalized.length) throw new Error(label + '不能为空');
  if (new Set(normalized).size !== normalized.length) throw new Error(label + '不能重复');
  return normalized.sort();
}

function actorSnapshot(actor) {
  return {
    username: text(actor?.username, 'system'),
    displayName: text(actor?.displayName, '系统'),
  };
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function recordMap(records, label) {
  const map = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const id = text(record?.id);
    if (!id) continue;
    if (map.has(id)) throw new Error(label + '存在重复版本：' + id);
    map.set(id, record);
  }
  return map;
}

function inputSnapshot(record, fields) {
  const snapshot = { versionId: record.id };
  for (const field of fields) {
    if (record[field] !== undefined && record[field] !== null && record[field] !== '') {
      snapshot[field] = clone(record[field]);
    }
  }
  return snapshot;
}

function ensureApprovedAsset(record, label) {
  if (!record) throw new Error(label + '不存在');
  if (record.status !== 'approved') throw new Error(label + '必须审核通过');
  if (record.authorizationStatus !== undefined && record.authorizationStatus !== 'approved') {
    throw new Error(label + '授权状态不是已确认');
  }
  if (record.batchAllowed !== true) throw new Error(label + '未开启批量使用权限');
}

function budgetFor(count, input) {
  if (count <= 6) return { required: false, confirmed: false, estimate: null };
  if (input.budgetConfirmed !== true) throw new Error('超过 M7 小批次的计划必须先完成预算估算并由负责人确认');
  const amount = Number(input.budgetEstimate?.amount);
  const currency = text(input.budgetEstimate?.currency);
  if (!Number.isFinite(amount) || amount < 0 || !currency) throw new Error('预算估算必须填写有效金额和币种');
  return {
    required: true,
    confirmed: true,
    estimate: {
      amount,
      currency,
      basis: text(input.budgetEstimate?.basis, null),
    },
  };
}

/* ---------------------------------------------------------------------------
   显式批次计划（F5-05/F5-06 结构性调整，负责人 2026-09-11 确认采用 A 方案）
   ---------------------------------------------------------------------------
   与 buildBatchPlan（全组合）并存：
     - buildBatchPlan：avatarVersionIds × scriptVersionIds 全组合，保持兼容；
     - buildExplicitBatchPlan：按显式明细行逐行生成 item，一行对应一个输出，
       绝不做隐藏的笛卡尔积（N15）。
   两者的校验规则一致：资产 approved + batchAllowed、文案 approved + 有正文、
   连接器具备口播能力、超过 M7 小批次必须先确认预算。
   --------------------------------------------------------------------------- */

export function buildExplicitBatchPlan(input = {}) {
  const rows = Array.isArray(input.rows) ? input.rows.slice(0, 300) : [];
  if (!rows.length) throw new Error('显式明细至少要有 1 行');

  const templateVersionId = text(input.templateVersionId);
  const connectorId = text(input.connectorId);
  if (!connectorId) throw new Error('视频连接器不能为空');

  const avatars = recordMap(input.avatars, '数字人');
  const scripts = recordMap(input.scripts, '文案');
  const templates = recordMap(input.templates, '模板');
  const connectors = recordMap(input.connectors, '连接器');
  const voices = recordMap(input.voices, '声音');

  const connector = connectors.get(connectorId);
  if (!connector || !['ready', 'simulation'].includes(connector.status)) {
    throw new Error('连接器不可用：' + connectorId);
  }
  if (!Array.isArray(connector.capabilities) || !connector.capabilities.includes('talking_head')) {
    throw new Error('连接器缺少数字人口播能力：' + connectorId);
  }
  const globalTemplate = templateVersionId ? templates.get(templateVersionId) : null;
  if (templateVersionId && (!globalTemplate || !['approved', 'active'].includes(globalTemplate.status) || globalTemplate.batchAllowed === false)) {
    throw new Error('模板版本不可用于批量生产：' + templateVersionId);
  }

  const maxItems = Number.isInteger(input.maxItems) && input.maxItems > 0 ? input.maxItems : 300;
  if (rows.length > maxItems) throw new Error(`显式明细 ${rows.length} 行超过批次上限 ${maxItems} 行`);
  const budget = budgetFor(rows.length, input);

  const items = [];
  const seenKeys = new Set();
  for (const [index, row] of rows.entries()) {
    const rowMode = text(row.mode, 'A') === 'B' ? 'B' : 'A';
    if (rowMode !== 'A') {
      throw new Error(`第 ${index + 1} 行：模式 B 的已有视频目录尚未接入，不能创建批次`);
    }
    const rowTemplateId = text(row.templateVersionId, templateVersionId);
    if (!rowTemplateId) throw new Error(`第 ${index + 1} 行：模板版本不能为空`);
    const rowTemplate = templates.get(rowTemplateId);
    if (!rowTemplate || !['approved', 'active'].includes(rowTemplate.status) || rowTemplate.batchAllowed === false) {
      throw new Error(`第 ${index + 1} 行：模板版本不可用于批量生产：` + rowTemplateId);
    }

    const scriptId = text(row.scriptVersionId);
    const script = scripts.get(scriptId);
    if (!script) throw new Error(`第 ${index + 1} 行：文案版本不存在：` + scriptId);
    if (script.status !== 'approved') throw new Error(`第 ${index + 1} 行：文案版本必须审核通过：` + scriptId);
    if (!text(script.text)) throw new Error(`第 ${index + 1} 行：文案版本缺少正文：` + scriptId);

    const avatarId = text(row.avatarVersionId);
    const avatar = avatars.get(avatarId);
    ensureApprovedAsset(avatar, `第 ${index + 1} 行数字人版本 ` + avatarId);
    const effectiveVoiceVersionId = text(row.voiceVersionId, text(avatar?.voiceVersionId, null));
    if (!effectiveVoiceVersionId) throw new Error(`第 ${index + 1} 行：声音版本不能为空`);
    ensureApprovedAsset(voices.get(effectiveVoiceVersionId), `第 ${index + 1} 行声音版本 ` + effectiveVoiceVersionId);

    const voice = voices.get(effectiveVoiceVersionId);
    const key = [avatarId, effectiveVoiceVersionId, scriptId, rowTemplateId, connectorId].join('|');
    if (seenKeys.has(key)) throw new Error(`第 ${index + 1} 行与前面的行完全重复（幂等键冲突）：` + key);
    seenKeys.add(key);

    items.push({
      id: 'batch_item_' + hash(key),
      idempotencyKey: key,
      avatarVersionId: avatarId,
      voiceVersionId: effectiveVoiceVersionId,
      scriptVersionId: scriptId,
      templateVersionId: rowTemplateId,
      connectorId,
      status: 'planned',
      attempt: 0,
      maxAttempts: Number.isInteger(input.maxAttempts) && input.maxAttempts > 0 ? input.maxAttempts : 3,
      stage: 'planned',
      rowNo: index + 1,
      outputName: text(row.outputName, null),
      outputSubdirectory: text(row.outputSubdirectory, null),
      input: {
        avatarVersionId: avatarId,
        voiceVersionId: effectiveVoiceVersionId,
        scriptVersionId: scriptId,
        templateVersionId: rowTemplateId,
        avatar: inputSnapshot(avatar, [
          'displayName', 'canonicalImageRef', 'baseVideoRef', 'referenceImageRefs', 'modelAssetRef', 'authorizationRef',
        ]),
        voice: inputSnapshot(voice, [
          'displayName', 'referenceAudioRef', 'referenceTranscript', 'voiceName', 'provider', 'modelVersion', 'licenseRef', 'weightsHash', 'modelAssetRef', 'authorizationRef',
        ]),
        script: inputSnapshot(script, [
          'title', 'text', 'platform', 'language', 'estimatedDurationSeconds',
        ]),
        template: inputSnapshot(rowTemplate, [
          'displayName', 'width', 'height', 'fps', 'durationLimitSeconds', 'captionPreset',
          'safeArea', 'backgroundRef', 'logoRef', 'introRef', 'outroRef', 'musicRef',
        ]),
      },
      output: null,
      error: null,
      review: null,
      queuedAt: null,
      leaseUntil: null,
      createdAt: null,
      updatedAt: null,
    });
  }

  return {
    version: 'content-batch-plan-explicit-v1',
    combinationMode: 'explicit',
    /* 兼容 createContentBatch 需要的字段：从显式行汇总，不代表全组合语义。 */
    avatarVersionIds: [...new Set(items.map((item) => item.avatarVersionId))],
    scriptVersionIds: [...new Set(items.map((item) => item.scriptVersionId))],
    voiceVersionId: null,
    templateVersionId: templateVersionId || null,
    connectorId,
    count: items.length,
    maxItems,
    budget,
    items,
  };
}

/* ---------------------------------------------------------------------------
   S7-01：N18 稳定契约（第七阶段规划 §7.1）与 Provider 能力闸门
   契约原则：客户端只提交业务级输入；模型差异（Python/CUDA/权重路径）只存在于
   provider 配置与运行记录，绝不进入页面字段或批次数据。
   --------------------------------------------------------------------------- */

export const N18_SCHEMA_VERSION = 'content-digital-human-n18-v1';

function n18Issue(code, field, message, extra = {}) {
  return { code, field, message, retryable: extra.retryable === true };
}


export function buildN18Request(input = {}) {
  const mode = text(input.mode, 'A') === 'B' ? 'B' : 'A';
  const errors = [];
  const script = input.script || null;
  if (!script || script.confirmed !== true) {
    errors.push(n18Issue('N18_SCRIPT_NOT_CONFIRMED', 'script_version_id', 'N18 请求必须引用已确认（confirmed）的文案版本', { retryable: false }));
  }
  if (!text(input.templateVersionId)) {
    errors.push(n18Issue('N18_TEMPLATE_MISSING', 'scene_template_version_id', 'N18 请求必须引用场景模板版本', { retryable: false }));
  }

  const digitalHuman = mode === 'A'
    ? {
        profile_id: text(input.profileId, null),
        avatar_version_id: text(input.avatarVersionId, null),
        voice_version_id: text(input.voiceVersionId, null),
      }
    : { profile_id: text(input.profileId, null) || null, avatar_version_id: null, voice_version_id: text(input.voiceVersionId, null) };

  if (mode === 'A') {
    if (!digitalHuman.profile_id || !digitalHuman.avatar_version_id || !digitalHuman.voice_version_id) {
      errors.push(n18Issue('N18_DIGITAL_HUMAN_INCOMPLETE', 'digital_human', '模式 A 必须提供完整的数字人档案：profile_id + avatar_version_id + voice_version_id', { retryable: false }));
    }
  }

  const sourceVideoAssetId = mode === 'B' ? text(input.sourceVideoAssetId, null) || null : null;
  if (mode === 'B' && !sourceVideoAssetId) {
    errors.push(n18Issue('N18_SOURCE_VIDEO_MISSING', 'source_video_asset_id', '模式 B 必须提供已有视频资产', { retryable: false }));
  }

  const targetAudioAssetId = text(input.targetAudioAssetId, null) || null;
  const hasVoice = mode === 'A' ? Boolean(digitalHuman.voice_version_id) : Boolean(digitalHuman.voice_version_id) && !targetAudioAssetId;
  if (mode === 'B' && targetAudioAssetId && digitalHuman.voice_version_id) {
    errors.push(n18Issue('N18_DUAL_AUDIO_SOURCE', 'target_audio_asset_id', '模式 B 的目标配音只能二选一：已有目标音频 或 声音版本，不允许同时传入', { retryable: false }));
  }
  if (mode === 'B' && !targetAudioAssetId && !digitalHuman.voice_version_id) {
    errors.push(n18Issue('N18_AUDIO_SOURCE_MISSING', 'target_audio_asset_id', '模式 B 必须二选一提供：目标音频 或 声音版本', { retryable: false }));
  }

  const output = input.outputPolicy && typeof input.outputPolicy === 'object' ? input.outputPolicy : {};
  if (!text(output.directory)) {
    errors.push(n18Issue('N18_OUTPUT_DIRECTORY_MISSING', 'output_policy_snapshot', 'N18 请求必须携带输出目录快照（受控目录内）', { retryable: false }));
  }

  return {
    schema_version: N18_SCHEMA_VERSION,
    task_id: text(input.taskId, null),
    item_id: text(input.itemId, null),
    mode,
    project_context_version_id: text(input.projectContextVersionId, null),
    script_version_id: text(input.scriptVersionId, null),
    script_text: script ? text(script.text, null) : text(input.scriptText, null),
    digital_human: digitalHuman,
    source_video_asset_id: sourceVideoAssetId,
    target_audio_asset_id: targetAudioAssetId,
    has_voice_source: hasVoice,
    scene_template_version_id: text(input.templateVersionId, null),
    output_policy_snapshot: {
      directory: text(output.directory, null),
      folder: text(output.folder, null),
      file_name: text(output.fileName, null),
      container: text(output.container, 'mp4'),
    },
    blocking_issues: errors,
    buildable: errors.length === 0,
  };
}

export const N18_CAPABILITIES = Object.freeze({
  A: ['tts', 'talking_head'],
  B: ['lipsync'],
});

export function projectN18Providers(providers = [], mode = 'A') {
  const list = Array.isArray(providers) ? providers : [];
  const required = N18_CAPABILITIES[mode] || [];
  const byCapability = {};
  for (const capability of ['tts', 'talking_head', 'lipsync']) {
    byCapability[capability] = list.filter((item) => item.capability === capability);
  }
  const blockingIssues = [];
  const readiness = {};
  for (const capability of required) {
    const candidates = byCapability[capability] || [];
    const preferred = candidates.find((item) => item.status === 'preferred');
    const blocked = candidates.filter((item) => item.status === 'blocked');
    readiness[capability] = {
      required: true,
      preferred: preferred || null,
      candidateCount: candidates.filter((item) => item.status === 'candidate').length,
      blockedCount: blocked.length,
      simulationCount: candidates.filter((item) => item.status === 'simulation').length,
      ready: Boolean(preferred),
    };
    if (!preferred) {
      blockingIssues.push(n18Issue(
        'N18_PROVIDER_NOT_READY_' + capability.toUpperCase(),
        'n18_providers',
        capability === 'tts'
          ? '还没有通过验证（preferred）的 TTS 提供方：当前只有候选/模拟登记，不能开始真实生成（N18）'
          : capability === 'talking_head'
            ? '还没有通过验证（preferred）的数字人视频提供方：Duix.Avatar 等候选需要先在 NVIDIA GPU Worker 上完成真实样片验收'
            : '还没有通过验证（preferred）的口型同步提供方：MuseTalk 等候选需要先在 NVIDIA GPU Worker 上完成真实样片验收',
        { retryable: false },
      ));
    }
  }
  return {
    mode,
    required,
    byCapability,
    readiness,
    blockingIssues,
    allReady: required.every((capability) => readiness[capability] && readiness[capability].ready),
    note: 'Provider 状态只允许负责人在真实样片验收后由 candidate 升级为 preferred；任何模拟结果都不能触发升级。',
  };
}

export function buildBatchPlan(input = {}) {
  if (input.combinationMode && input.combinationMode !== 'cartesian') {
    throw new Error('当前只支持全组合批次');
  }
  const avatarVersionIds = ids(input.avatarVersionIds, '数字人版本');
  const scriptVersionIds = ids(input.scriptVersionIds, '文案版本');
  const templateVersionId = text(input.templateVersionId);
  const connectorId = text(input.connectorId);
  const voiceVersionId = text(input.voiceVersionId, null);
  if (!templateVersionId) throw new Error('模板版本不能为空');
  if (!connectorId) throw new Error('视频连接器不能为空');

  const avatars = recordMap(input.avatars, '数字人');
  const scripts = recordMap(input.scripts, '文案');
  const templates = recordMap(input.templates, '模板');
  const connectors = recordMap(input.connectors, '连接器');
  const voices = recordMap(input.voices, '声音');

  for (const id of avatarVersionIds) {
    const avatar = avatars.get(id);
    ensureApprovedAsset(avatar, '数字人版本 ' + id);
    const defaultVoiceVersionId = text(avatar?.voiceVersionId, null);
    if (!voiceVersionId && defaultVoiceVersionId) {
      ensureApprovedAsset(voices.get(defaultVoiceVersionId), '默认声音版本 ' + defaultVoiceVersionId);
    }
  }
  for (const id of scriptVersionIds) {
    const record = scripts.get(id);
    if (!record) throw new Error('文案版本不存在：' + id);
    if (record.status !== 'approved') throw new Error('文案版本必须审核通过：' + id);
    if (!text(record.text)) throw new Error('文案版本缺少正文：' + id);
  }
  const template = templates.get(templateVersionId);
  if (!template) throw new Error('模板版本不存在：' + templateVersionId);
  if (!['approved', 'active'].includes(template.status) || template.batchAllowed === false) {
    throw new Error('模板版本不可用于批量生产：' + templateVersionId);
  }
  const connector = connectors.get(connectorId);
  if (!connector || !['ready', 'simulation'].includes(connector.status)) {
    throw new Error('连接器不可用：' + connectorId);
  }
  if (!Array.isArray(connector.capabilities) || !connector.capabilities.includes('talking_head')) {
    throw new Error('连接器缺少数字人口播能力：' + connectorId);
  }
  if (voiceVersionId) ensureApprovedAsset(voices.get(voiceVersionId), '声音版本 ' + voiceVersionId);

  const count = avatarVersionIds.length * scriptVersionIds.length;
  const maxItems = Number.isInteger(input.maxItems) && input.maxItems > 0 ? input.maxItems : 300;
  if (count > maxItems) throw new Error(`批次计划 ${count} 条超过批次上限 ${maxItems} 条`);
  const budget = budgetFor(count, input);

  const items = [];
  for (const avatarId of avatarVersionIds) {
    const avatar = avatars.get(avatarId);
    const effectiveVoiceVersionId = voiceVersionId || text(avatar?.voiceVersionId, null);
    const voice = effectiveVoiceVersionId ? voices.get(effectiveVoiceVersionId) : null;
    for (const scriptId of scriptVersionIds) {
      const script = scripts.get(scriptId);
      const key = [avatarId, effectiveVoiceVersionId || '', scriptId, templateVersionId, connectorId].join('|');
      items.push({
        id: 'batch_item_' + hash(key),
        idempotencyKey: key,
        avatarVersionId: avatarId,
        voiceVersionId: effectiveVoiceVersionId,
        scriptVersionId: scriptId,
        templateVersionId,
        connectorId,
        status: 'planned',
        attempt: 0,
        maxAttempts: Number.isInteger(input.maxAttempts) && input.maxAttempts > 0 ? input.maxAttempts : 3,
        stage: 'planned',
        input: {
          avatarVersionId: avatarId,
          voiceVersionId: effectiveVoiceVersionId,
          scriptVersionId: scriptId,
          templateVersionId,
          avatar: inputSnapshot(avatar, [
            'displayName', 'canonicalImageRef', 'baseVideoRef', 'referenceImageRefs', 'modelAssetRef', 'authorizationRef',
          ]),
          voice: voice ? inputSnapshot(voice, [
            'displayName', 'referenceAudioRef', 'referenceTranscript', 'voiceName', 'provider', 'modelVersion', 'licenseRef', 'weightsHash', 'modelAssetRef', 'authorizationRef',
          ]) : null,
          script: inputSnapshot(script, [
            'title', 'text', 'platform', 'language', 'estimatedDurationSeconds',
          ]),
          template: inputSnapshot(template, [
            'displayName', 'width', 'height', 'fps', 'durationLimitSeconds', 'captionPreset',
            'safeArea', 'backgroundRef', 'logoRef', 'introRef', 'outroRef', 'musicRef',
          ]),
        },
        output: null,
        error: null,
        review: null,
        queuedAt: null,
        leaseUntil: null,
        createdAt: null,
        updatedAt: null,
      });
    }
  }
  return {
    version: 'content-batch-plan-v1',
    combinationMode: 'cartesian',
    avatarVersionIds,
    voiceVersionId,
    scriptVersionIds,
    templateVersionId,
    connectorId,
    count,
    maxItems,
    budget,
    items,
  };
}

function appendHistory(batch, action, actor, timestamp, data = {}) {
  batch.history = Array.isArray(batch.history) ? batch.history : [];
  batch.history.push({ action, actor: actorSnapshot(actor), createdAt: timestamp, ...data });
  batch.history = batch.history.slice(-200);
}

export function summarizeBatch(batch) {
  const items = Array.isArray(batch?.items) ? batch.items : [];
  const counts = Object.fromEntries(BATCH_ITEM_STATUSES.map((status) => [status, 0]));
  for (const item of items) {
    if (counts[item.status] === undefined) counts[item.status] = 0;
    counts[item.status] += 1;
  }
  return {
    total: items.length,
    planned: counts.planned || 0,
    queued: counts.queued || 0,
    running: counts.running || 0,
    succeeded: counts.succeeded || 0,
    approved: counts.approved || 0,
    changesRequested: counts.changes_requested || 0,
    failed: counts.failed || 0,
    blocked: counts.blocked || 0,
    cancelled: counts.cancelled || 0,
    reviewable: (counts.succeeded || 0) + (counts.changes_requested || 0),
    terminal: items.filter((item) => TERMINAL_ITEM_STATUSES.has(item.status) || item.status === 'succeeded').length,
  };
}

export function createContentBatch(input, actor, options = {}) {
  const plan = input?.plan;
  if (!plan || !Array.isArray(plan.items) || !plan.items.length) throw new Error('批次计划不能为空');
  const timestamp = options.now || new Date().toISOString();
  /* 修复：item id 必须绑定批次。此前 id = hash(组合) 全局唯一，
     同一组合第二次建批次时 upsert 会命中旧批次的条目（batch_id 不迁移），
     导致新批次 0 条、旧批次条目被复用。现在 id = 批次前缀 + 组合哈希，
     幂等语义由 (batch_id, idempotency_key) 唯一约束承担。 */
  const batchId = text(input.id);
  const batch = {
    id: batchId,
    taskId: text(input.taskId),
    tenantId: text(input.tenantId),
    projectId: text(input.projectId),
    title: text(input.title, '数字人批次'),
    status: 'waiting_approval',
    planVersion: plan.version,
    combinationMode: plan.combinationMode,
    avatarVersionIds: [...plan.avatarVersionIds],
    voiceVersionId: plan.voiceVersionId || null,
    scriptVersionIds: [...plan.scriptVersionIds],
    templateVersionId: plan.templateVersionId,
    connectorId: plan.connectorId,
    planCount: plan.count,
    budget: plan.budget?.required
      ? { ...clone(plan.budget), confirmedBy: actorSnapshot(actor), confirmedAt: timestamp }
      : clone(plan.budget || { required: false, confirmed: false, estimate: null }),
    items: plan.items.map((item) => ({
      ...clone(item),
      id: batchId ? batchId + '::' + item.id : item.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
    history: [],
    createdBy: actorSnapshot(actor),
    approvedBy: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (!batch.id || !batch.taskId || !batch.tenantId || !batch.projectId) throw new Error('批次缺少工作区上下文');
  appendHistory(batch, 'created', actor, timestamp, { count: batch.planCount });
  return batch;
}

function batchTransitionError(action, status) {
  return new Error('批次不能在 ' + status + ' 状态执行：' + action);
}

export function transitionContentBatch(batch, action, actor, options = {}) {
  const current = clone(batch);
  const timestamp = options.now || new Date().toISOString();
  if (action === 'start' && Number(current.planCount) > 6 && current.budget?.confirmed !== true) {
    throw new Error('超过 M7 小批次的计划必须先完成预算估算并由负责人确认');
  }
  switch (action) {
    case 'approve':
      if (current.status !== 'waiting_approval') throw batchTransitionError(action, current.status);
      current.status = 'queued';
      current.approvedBy = actorSnapshot(actor);
      current.approvedAt = timestamp;
      for (const item of current.items) {
        if (['planned', 'queued'].includes(item.status) && !item.queuedAt) item.queuedAt = timestamp;
      }
      break;
    case 'start':
      if (!['queued', 'paused', 'partial_failed', 'blocked'].includes(current.status)) {
        const summary = summarizeBatch(current);
        if (current.status !== 'waiting_review' || (!summary.queued && !summary.planned)) {
          throw batchTransitionError(action, current.status);
        }
      }
      current.status = 'running';
      break;
    case 'pause':
      if (!['queued', 'running'].includes(current.status)) throw batchTransitionError(action, current.status);
      current.status = 'paused';
      break;
    case 'resume':
      if (current.status !== 'paused') throw batchTransitionError(action, current.status);
      current.status = 'running';
      break;
    case 'cancel':
      if (['completed', 'cancelled'].includes(current.status)) throw batchTransitionError(action, current.status);
      current.status = 'cancelled';
      for (const item of current.items) {
        if (!['approved', 'failed', 'blocked', 'cancelled'].includes(item.status)) item.status = 'cancelled';
        item.updatedAt = timestamp;
      }
      break;
    case 'complete': {
      const summary = summarizeBatch(current);
      if (summary.approved !== summary.total || summary.failed || summary.blocked || summary.cancelled) {
        throw new Error('批次仍有未审核或失败条目，不能完成');
      }
      current.status = 'completed';
      break;
    }
    case 'refresh':
      current.status = deriveBatchStatus(current);
      break;
    default:
      throw new Error('不支持的批次动作：' + action);
  }
  current.updatedAt = timestamp;
  appendHistory(current, action, actor, timestamp, { status: current.status });
  return current;
}

function deriveBatchStatus(batch) {
  const summary = summarizeBatch(batch);
  if (!summary.total || summary.cancelled === summary.total) return 'cancelled';
  if (summary.running || summary.queued || summary.planned) {
    return batch.status === 'paused' ? 'paused' : 'running';
  }
  if (summary.blocked === summary.total && !summary.failed) return 'blocked';
  if (summary.failed || summary.blocked) return 'partial_failed';
  if (summary.changesRequested) return 'waiting_review';
  if (summary.approved === summary.total) return 'completed';
  return 'waiting_review';
}

export function transitionContentBatchItem(batch, itemId, action, actor, options = {}) {
  const current = clone(batch);
  const item = current.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error('批次子任务不存在');
  const timestamp = options.now || new Date().toISOString();
  if (action === 'claim') {
    if (current.status !== 'running') throw new Error('批次当前未运行，不能领取子任务');
    if (!['planned', 'queued'].includes(item.status)) throw new Error('当前子任务不能领取');
    item.status = 'running';
    item.stage = 'running';
    item.attempt = (Number(item.attempt) || 0) + 1;
    item.startedAt = timestamp;
    item.queuedAt = item.queuedAt || timestamp;
    item.leaseUntil = options.leaseUntil || null;
    item.error = null;
  } else if (action === 'succeed') {
    if (item.status !== 'running') throw new Error('只有运行中的子任务可以完成');
    item.status = 'succeeded';
    item.stage = 'quality_check';
    item.output = clone(options.output ?? {});
    item.error = null;
    item.leaseUntil = null;
    item.completedAt = timestamp;
  } else if (action === 'fail' || action === 'block') {
    if (item.status !== 'running') throw new Error('只有运行中的子任务可以失败');
    item.status = action === 'block' ? 'blocked' : 'failed';
    item.stage = action === 'block' ? 'blocked' : 'failed';
    item.error = clone(options.error || { errorClass: action, message: '子任务未完成', retryable: false });
    item.leaseUntil = null;
    item.completedAt = timestamp;
  } else if (action === 'retry') {
    if (!['failed', 'blocked', 'changes_requested'].includes(item.status)) throw new Error('只有失败、阻塞或退回修改子任务可以重试');
    if (options.error?.retryable === false || item.error?.retryable === false) throw new Error('该子任务错误不可自动重试');
    if ((Number(item.attempt) || 0) >= (Number(item.maxAttempts) || 3)) throw new Error('子任务已达到最大重试次数');
    item.status = 'queued';
    item.stage = 'queued';
    item.error = null;
    item.completedAt = null;
    item.queuedAt = timestamp;
    item.leaseUntil = null;
    item.review = null;
  } else if (action === 'review') {
    if (!['succeeded', 'changes_requested'].includes(item.status)) throw new Error('当前子任务没有可审核成片');
    const decision = text(options.decision);
    if (!['approved', 'changes_requested'].includes(decision)) throw new Error('子任务审核决定不正确');
    if (decision === 'approved' && item.output?.simulated === true) {
      throw new Error('模拟输出只能用于验证队列和状态，不能审核通过或作为生产内容交付');
    }
    item.status = decision;
    item.stage = decision === 'approved' ? 'approved' : 'changes_requested';
    item.review = { decision, note: text(options.note), reviewer: actorSnapshot(actor), createdAt: timestamp };
  } else if (action === 'attach_output') {
    if (!['succeeded', 'approved'].includes(item.status)) throw new Error('只有已完成的子任务可以补充输出');
    if (!options.output || typeof options.output !== 'object' || Array.isArray(options.output)) throw new Error('补充输出不能为空');
    item.output = clone(options.output);
  } else if (action === 'cancel') {
    if (!['approved', 'failed', 'blocked', 'cancelled'].includes(item.status)) item.status = 'cancelled';
    item.stage = 'cancelled';
    item.leaseUntil = null;
  } else {
    throw new Error('不支持的子任务动作：' + action);
  }
  item.updatedAt = timestamp;
  current.updatedAt = timestamp;
  appendHistory(current, 'item_' + action, actor, timestamp, { itemId, status: item.status, attempt: item.attempt });
  return current;
}

export function normalizeConnectorError(error) {
  const source = error && typeof error === 'object' ? error : { message: String(error) };
  const status = Number(source.status || source.statusCode);
  const errorClass = text(source.errorClass, status === 429 ? 'rate_limited' : status >= 500 ? 'server_error' : text(source.code, 'connector_error'));
  const retryable = source.retryable === true || ['timeout', 'rate_limited', 'server_error', 'worker_unavailable', 'callback_lost', 'network_error'].includes(errorClass);
  return {
    errorClass,
    code: text(source.code, errorClass),
    message: text(source.message, '连接器执行失败'),
    retryable,
    status: Number.isFinite(status) ? status : null,
  };
}
