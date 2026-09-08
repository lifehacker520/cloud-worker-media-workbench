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
  const batch = {
    id: text(input.id),
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
    items: plan.items.map((item) => ({ ...clone(item), createdAt: timestamp, updatedAt: timestamp })),
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
