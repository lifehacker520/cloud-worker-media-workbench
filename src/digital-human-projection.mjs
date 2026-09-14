/* ===========================================================================
   AI 数字人口播生产中心 · 状态投影层（F5-02 切片）
   ---------------------------------------------------------------------------
   目的：把现有的一份单轴数据（content_batch_items.status）投影成页面需要的
        三轴状态 + allowed_actions + blocking_issues + next_action。

   依据：`02-内容编辑云员工-...-数据与状态设计V1.md`
     - 6.7 生产明细状态：生成轴 / 审核轴 / 交付轴 必须分开；
     - 7.1 闸门统一返回格式：allowed_actions / blocking_issues / next_action；
     - 10.1 页面主按钮必须来自 allowed_actions，不允许页面自己猜。

   边界（重要）：
     - 本模块是**只读派生**，不产生新的权威数据，不写库，不调用模型。
     - 不新增第二套批次真相：输入就是 `contentBatchStore` 已有的 batch 对象。
     - 页面上出现的每个数字都必须能反查到 batches / tasks / catalog 三个真实来源。
   =========================================================================== */

/* ---------------------------------------------------------------------------
   6.7 三轴词表
   --------------------------------------------------------------------------- */

export const DH_GENERATION_STATUSES = Object.freeze([
  'planned',
  'queued',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
]);

export const DH_REVIEW_STATUSES = Object.freeze([
  'not_ready',
  'waiting_review',
  'approved',
  'changes_requested',
  'rejected',
]);

export const DH_DELIVERY_STATUSES = Object.freeze([
  'not_selected',
  'selected',
  'exporting',
  'exported',
  'export_failed',
]);

/* 6.6 生产任务五组状态 */
export const DH_TASK_LIFECYCLE_STATUSES = Object.freeze(['draft', 'ready', 'archived']);
export const DH_TASK_PREFLIGHT_STATUSES = Object.freeze(['not_run', 'running', 'passed', 'blocked']);
export const DH_TASK_EXECUTION_STATUSES = Object.freeze([
  'not_started',
  'queued',
  'running',
  'paused',
  'completed_with_results',
  'failed',
  'cancelled',
]);
export const DH_TASK_REVIEW_SUMMARIES = Object.freeze([
  'not_ready',
  'waiting',
  'partial',
  'all_approved',
  'has_rejected',
]);
export const DH_TASK_DELIVERY_SUMMARIES = Object.freeze([
  'not_started',
  'partially_selected',
  'exporting',
  'exported',
  'export_failed',
]);

/* ---------------------------------------------------------------------------
   中文标签（页面只读这张表，不自己拼状态文案）
   --------------------------------------------------------------------------- */

export const DH_GENERATION_LABELS = Object.freeze({
  planned: { label: '待生成', tone: 'draft' },
  queued: { label: '已排队', tone: 'draft' },
  running: { label: '生成中', tone: 'running' },
  succeeded: { label: '已生成', tone: 'done' },
  failed: { label: '生成失败', tone: 'failed' },
  blocked: { label: '生成阻塞', tone: 'failed' },
  cancelled: { label: '已取消', tone: 'draft' },
});

export const DH_REVIEW_LABELS = Object.freeze({
  not_ready: { label: '暂无可验收结果', tone: 'draft' },
  waiting_review: { label: '待人工验收', tone: 'review' },
  approved: { label: '人工已通过', tone: 'done' },
  changes_requested: { label: '需修改', tone: 'failed' },
  rejected: { label: '已驳回', tone: 'failed' },
});

export const DH_DELIVERY_LABELS = Object.freeze({
  not_selected: { label: '未选择交付', tone: 'draft' },
  selected: { label: '已选择交付', tone: 'review' },
  exporting: { label: '导出中', tone: 'running' },
  exported: { label: '已导出', tone: 'done' },
  export_failed: { label: '导出失败', tone: 'failed' },
});

export const DH_TASK_LIFECYCLE_LABELS = Object.freeze({
  draft: { label: '草稿', tone: 'draft' },
  ready: { label: '可执行', tone: 'review' },
  archived: { label: '已归档', tone: 'draft' },
});

export const DH_TASK_EXECUTION_LABELS = Object.freeze({
  not_started: { label: '未开始', tone: 'draft' },
  queued: { label: '已排队', tone: 'draft' },
  running: { label: '执行中', tone: 'running' },
  paused: { label: '已暂停', tone: 'review' },
  completed_with_results: { label: '已有结果', tone: 'done' },
  failed: { label: '执行失败', tone: 'failed' },
  cancelled: { label: '已取消', tone: 'draft' },
});

export const DH_ACTION_LABELS = Object.freeze({
  configure_items: { label: '继续配置明细', slice: 'F5-05' },
  fix_blockers: { label: '修复阻塞项', slice: 'F5-05' },
  retry_item: { label: '重试本条', slice: 'F5-06' },
  regenerate_item: { label: '修改输入后重新生成', slice: 'F5-06' },
  review_item: { label: '进行人工验收', slice: 'F5-06' },
  request_changes: { label: '退回修改', slice: 'F5-06' },
  select_for_package: { label: '加入内容包', slice: 'F5-07' },
  export_approved: { label: '导出已通过结果', slice: 'F5-07' },
});

export const DH_NEXT_ACTION_LABELS = Object.freeze({
  configure_items: '继续配置明细',
  fix_blockers: '修复阻塞项',
  retry_failed_items: '重试失败明细',
  review_pending_items: '进入人工验收',
  regenerate_items: '修改输入后重新生成',
  export_approved: '导出已通过结果',
  prepare_assets: '先准备可用的数字人、文案与模板资产',
  nothing_pending: '暂无待处理项',
});

/* 交付轴在 F5-02 尚未接入（F5-07 才实现），必须如实标注为未接入而不是假装 not_selected 是结论。 */
export const DH_DELIVERY_AXIS_WIRED = false;

/* ---------------------------------------------------------------------------
   工具
   --------------------------------------------------------------------------- */

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function toIsoOrNull(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function issue(code, field, message, extra = {}) {
  return { code, field, message, ...extra };
}

/* ---------------------------------------------------------------------------
   明细投影：一条 production_item → 三轴 + 动作 + 阻塞
   --------------------------------------------------------------------------- */

export function projectBatchItem(item = {}, rowNo = null) {
  const status = text(item.status, 'planned');
  const review = item.review && typeof item.review === 'object' ? item.review : null;
  const output = item.output && typeof item.output === 'object' ? item.output : null;
  const error = item.error && typeof item.error === 'object' ? item.error : null;

  /* ---- 生成轴：描述“当前这次尝试的结果” ---- */
  let generationStatus = 'planned';
  if (status === 'queued') generationStatus = 'queued';
  else if (status === 'running') generationStatus = 'running';
  else if (status === 'succeeded' || status === 'approved' || status === 'changes_requested') generationStatus = 'succeeded';
  else if (status === 'failed') generationStatus = 'failed';
  else if (status === 'blocked') generationStatus = 'blocked';
  else if (status === 'cancelled') generationStatus = 'cancelled';

  /* ---- 审核轴：authoritative 来源是 review 记录，其次才回退到 status ---- */
  let reviewStatus = 'not_ready';
  if (review) {
    const decision = text(review.decision);
    if (decision === 'approved') reviewStatus = 'approved';
    else if (decision === 'changes_requested') reviewStatus = 'changes_requested';
    else if (decision === 'rejected') reviewStatus = 'rejected';
    else if (decision === 'waiting_review') reviewStatus = 'waiting_review';
  }
  if (reviewStatus === 'not_ready') {
    if (status === 'succeeded') reviewStatus = 'waiting_review';
    else if (status === 'approved') reviewStatus = 'approved';
    else if (status === 'changes_requested') reviewStatus = 'changes_requested';
  }

  /* ---- 交付轴：现有模型里还没有交付事实，F5-02 只能如实报 not_selected ---- */
  const deliveryStatus = 'not_selected';

  const simulated = output?.simulated === true;
  const verified = text(output?.verificationStatus || output?.verification_status);
  const hasPlayableOutput = Boolean(output) && output?.playable !== false;

  /* ---- 阻塞项（有事实才写，不写猜测） ---- */
  const blockingIssues = [];
  if (generationStatus === 'blocked') {
    blockingIssues.push(issue(
      text(error?.code || error?.errorClass, 'ITEM_BLOCKED'),
      'input_snapshot',
      text(error?.message, '该明细被阻塞，需要先补齐输入或权限'),
      { retryable: error?.retryable === true },
    ));
  }
  if (generationStatus === 'failed') {
    blockingIssues.push(issue(
      text(error?.code || error?.errorClass, 'ITEM_FAILED'),
      'generation',
      text(error?.message, '该明细生成失败'),
      { retryable: error?.retryable !== false },
    ));
  }
  if (simulated) {
    blockingIssues.push(issue(
      'OUTPUT_SIMULATED',
      'output',
      '当前输出标记为模拟结果，只能用于验证队列与状态，不能审核通过，也不能计入交付',
      { retryable: false },
    ));
  }
  if (reviewStatus === 'waiting_review' && output && !verified) {
    blockingIssues.push(issue(
      'OUTPUT_NOT_VERIFIED',
      'output',
      '输出文件还没有经过文件存在性与可播放性检查，暂不能作为验收依据',
      { retryable: false },
    ));
  }

  /* ---- allowed_actions：页面主按钮的唯一来源（7.1 / 10.1 / N21） ---- */
  const allowedActions = [];
  if (generationStatus === 'blocked') {
    allowedActions.push('fix_blockers');
  }
  if (generationStatus === 'failed' && error?.retryable !== false) {
    allowedActions.push('retry_item');
  }
  /* 不可重试的失败只能走“修改输入后重新生成”（N21：changes_requested 或 retryable failed）。 */
  if (generationStatus === 'failed' && error?.retryable === false) {
    allowedActions.push('regenerate_item');
  }
  if (reviewStatus === 'waiting_review' && !simulated) {
    allowedActions.push('review_item', 'request_changes');
  }
  if (reviewStatus === 'changes_requested' || reviewStatus === 'rejected') {
    allowedActions.push('regenerate_item');
  }
  if (reviewStatus === 'approved' && hasPlayableOutput && !simulated) {
    allowedActions.push('select_for_package');
  }
  if (generationStatus === 'planned') {
    allowedActions.push('configure_items');
  }

  return {
    id: text(item.id),
    rowNo: Number.isInteger(rowNo) ? rowNo : null,
    generationStatus,
    reviewStatus,
    deliveryStatus,
    attempt: Number(item.attempt) || 0,
    maxAttempts: Number(item.maxAttempts) || 0,
    inputRefs: {
      avatarVersionId: text(item.avatarVersionId) || null,
      voiceVersionId: text(item.voiceVersionId) || null,
      scriptVersionId: text(item.scriptVersionId) || null,
      templateVersionId: text(item.templateVersionId) || null,
    },
    currentOutput: output
      ? {
          simulated,
          playable: output.playable === undefined ? null : output.playable === true,
          verificationStatus: verified || 'created',
        }
      : null,
    review: review
      ? {
          decision: text(review.decision) || null,
          note: text(review.note) || null,
          reviewer: text(review.reviewer?.displayName || review.reviewer?.username) || null,
          createdAt: toIsoOrNull(review.createdAt),
        }
      : null,
    error: error
      ? {
          code: text(error.code || error.errorClass) || null,
          message: text(error.message) || null,
          retryable: error.retryable === true,
        }
      : null,
    allowedActions,
    blockingIssues,
  };
}

/* ---------------------------------------------------------------------------
   任务投影：一个 content batch → 生产任务（含五组状态 + 任务级动作）
   --------------------------------------------------------------------------- */

function summarizeAxes(items) {
  const summary = {
    total: items.length,
    generation: Object.fromEntries(DH_GENERATION_STATUSES.map((status) => [status, 0])),
    review: Object.fromEntries(DH_REVIEW_STATUSES.map((status) => [status, 0])),
    delivery: Object.fromEntries(DH_DELIVERY_STATUSES.map((status) => [status, 0])),
  };
  for (const item of items) {
    if (summary.generation[item.generationStatus] !== undefined) summary.generation[item.generationStatus] += 1;
    if (summary.review[item.reviewStatus] !== undefined) summary.review[item.reviewStatus] += 1;
    if (summary.delivery[item.deliveryStatus] !== undefined) summary.delivery[item.deliveryStatus] += 1;
  }
  return summary;
}

/* 6.6 审核摘要：由明细 review_status 计算，不允许手工写。 */
function deriveReviewSummary(axes) {
  if (!axes.total) return 'not_ready';
  const { review } = axes;
  const actioned = review.approved + review.changes_requested + review.rejected;
  if (review.rejected > 0) return 'has_rejected';
  if (review.approved === axes.total) return 'all_approved';
  if (actioned > 0) return 'partial';
  if (review.waiting_review > 0) return 'waiting';
  return 'not_ready';
}

/* 6.6 生命周期：现有批次没有 archived 概念，只区分“还没有明细的草稿”和“可以执行”。 */
function deriveLifecycleStatus(axes) {
  if (!axes.total) return 'draft';
  if (axes.generation.planned === axes.total) return 'draft';
  return 'ready';
}

function deriveExecutionStatus(batchStatus, axes) {
  if (axes.generation.running > 0) return 'running';
  if (batchStatus === 'paused') return 'paused';
  if (batchStatus === 'cancelled') return 'cancelled';
  if (batchStatus === 'blocked') return 'failed';
  /* 一条都没动过 → 未开始（planned 不等于已排队，6.7 里 planned → queued 是两步）；
     还有待处理条目 → 排队中；已经有产出且没有在途条目 → 本轮执行已结束。 */
  const attempted = axes.generation.succeeded + axes.generation.failed + axes.generation.blocked + axes.generation.cancelled;
  if (attempted === 0) return 'not_started';
  if (axes.generation.planned > 0 || axes.generation.queued > 0) return 'queued';
  if (axes.generation.failed + axes.generation.blocked > 0 && axes.generation.succeeded === 0) return 'failed';
  return 'completed_with_results';
}

export function projectProductionTask(batch = {}) {
  const rawItems = Array.isArray(batch.items) ? batch.items : [];
  const items = rawItems.map((item, index) => projectBatchItem(item, index + 1));
  const axes = summarizeAxes(items);

  const blockingIssues = [];
  const retryable = items.filter((item) => item.allowedActions.includes('retry_item'));
  const blocked = items.filter((item) => item.generationStatus === 'blocked');
  const waitingReview = items.filter((item) => item.reviewStatus === 'waiting_review');
  /* needsRegenerate 以 allowed_actions 为准，而不是只看 generation_status === 'failed'：
     changes_requested / rejected 的明细同样只能走“修改输入后重新生成”。 */
  const needsRegenerate = items.filter((item) => item.allowedActions.includes('regenerate_item'));
  const approvable = items.filter((item) => item.allowedActions.includes('select_for_package'));

  if (blocked.length) {
    blockingIssues.push(issue('TASK_HAS_BLOCKED_ITEMS', 'items', blocked.length + ' 条明细被阻塞，必须先处理'));
  }
  if (retryable.length) {
    blockingIssues.push(issue('TASK_HAS_RETRYABLE_ITEMS', 'items', retryable.length + ' 条明细失败但可以重试'));
  }

  const allowedActions = [];
  if (blocked.length) allowedActions.push('fix_blockers');
  if (retryable.length) allowedActions.push('retry_item');
  if (waitingReview.length) allowedActions.push('review_item');
  if (items.some((item) => item.allowedActions.includes('regenerate_item'))) allowedActions.push('regenerate_item');
  if (approvable.length) allowedActions.push('export_approved');
  if (axes.generation.planned === axes.total && axes.total > 0) allowedActions.push('configure_items');

  /* next_action 优先级：阻塞 > 可重试失败 > 待验收 > 需重新生成 > 可导出 > 继续配置 */
  let nextAction = 'nothing_pending';
  if (blocked.length) nextAction = 'fix_blockers';
  else if (retryable.length) nextAction = 'retry_failed_items';
  else if (waitingReview.length) nextAction = 'review_pending_items';
  else if (needsRegenerate.length) nextAction = 'regenerate_items';
  else if (approvable.length && axes.review.approved === axes.total) nextAction = 'export_approved';
  else if (axes.generation.planned === axes.total && axes.total > 0) nextAction = 'configure_items';

  return {
    id: text(batch.id),
    parentContentTaskId: text(batch.taskId) || null,
    projectId: text(batch.projectId) || null,
    title: text(batch.title, '未命名生产任务'),
    mode: 'A',
    modeNote: '现有批次模型只有全组合生成一种输入形态，模式 B 的输入契约在 F5-04 接入',
    batchStatus: text(batch.status) || null,
    lifecycleStatus: deriveLifecycleStatus(axes),
    preflightStatus: 'not_run',
    executionStatus: deriveExecutionStatus(text(batch.status), axes),
    reviewSummary: deriveReviewSummary(axes),
    deliverySummary: 'not_started',
    requestedItemCount: Number(batch.planCount) || axes.total,
    itemCount: axes.total,
    axes,
    items,
    allowedActions,
    blockingIssues,
    nextAction,
    rowVersion: Array.isArray(batch.history) ? batch.history.length : 0,
    updatedAt: toIsoOrNull(batch.updatedAt),
    createdAt: toIsoOrNull(batch.createdAt),
  };
}

/* ---------------------------------------------------------------------------
   F5-03：P02 文案候选投影
   规则（产品规格 V1 / 数据与状态设计 V1 §10.2）：
     - 只有 confirmed（status === 'approved' 且有正文）的文案可以进入生产任务；
     - 页面默认展示摘要，不把长文本一次性铺开；
     - 未确认文案必须带着原因显示，不能混进可用列表。
   --------------------------------------------------------------------------- */

export const DH_COPY_SUMMARY_LENGTH = 120;

export function summarizeCopyText(value, maxLength = DH_COPY_SUMMARY_LENGTH) {
  const raw = text(value).replace(/\s+/g, ' ').trim();
  if (raw.length <= maxLength) return { summary: raw, truncated: false, textLength: raw.length };
  return { summary: raw.slice(0, maxLength) + '…', truncated: true, textLength: raw.length };
}

export function projectCopyCandidate(script = {}) {
  const status = text(script.status, 'draft');
  const body = text(script.text);
  const confirmed = status === 'approved' && Boolean(body);
  const { summary, truncated, textLength } = summarizeCopyText(body);

  const blockingIssues = [];
  if (status !== 'approved') {
    blockingIssues.push(issue(
      'COPY_VERSION_NOT_CONFIRMED',
      'copy_version_id',
      '该文案尚未确认，不能进入生产任务（10.2：只有 confirmed 的具体版本可以被生产任务引用）',
      { retryable: false },
    ));
  }
  if (status === 'approved' && !body) {
    blockingIssues.push(issue('COPY_VERSION_EMPTY', 'text', '该文案版本缺少正文，不能进入生产任务', { retryable: false }));
  }

  return {
    id: text(script.id),
    scriptSetId: text(script.scriptSetId) || null,
    title: text(script.title, '未命名文案'),
    version: Number(script.version) || null,
    status,
    confirmed,
    platform: text(script.platform) || null,
    language: text(script.language) || null,
    estimatedDurationSeconds: Number(script.estimatedDurationSeconds) || null,
    textLength,
    textSummary: summary,
    textTruncated: truncated,
    hasFullText: Boolean(body),
    allowedActions: confirmed ? ['select_copy'] : [],
    blockingIssues,
    updatedAt: toIsoOrNull(script.updatedAt),
  };
}

export function projectCopyCandidates(scripts = [], selectedScriptVersionId = null) {
  const list = Array.isArray(scripts) ? scripts : [];
  const candidates = list.map((script) => projectCopyCandidate(script));
  const confirmedList = candidates.filter((candidate) => candidate.confirmed);

  const blockingIssues = [];
  if (!candidates.length) {
    blockingIssues.push(issue('NO_SCRIPT_VERSION', 'catalog.scripts', '还没有任何文案候选，生产任务无法引用文案', { retryable: false }));
  } else if (!confirmedList.length) {
    blockingIssues.push(issue('NO_CONFIRMED_SCRIPT_VERSION', 'catalog.scripts', '有文案候选但全部未确认，生产任务只能引用 confirmed 版本', { retryable: false }));
  }

  const selected = selectedScriptVersionId
    ? candidates.find((candidate) => candidate.id === selectedScriptVersionId) || null
    : null;
  if (selectedScriptVersionId && !selected) {
    blockingIssues.push(issue('SELECTED_COPY_VERSION_MISSING', 'selectedScriptVersionId', '已选择的文案版本在当前目录里不存在', { retryable: false }));
  } else if (selected && !selected.confirmed) {
    blockingIssues.push(issue('SELECTED_COPY_NOT_CONFIRMED', 'selectedScriptVersionId', '已选择的文案版本未确认，必须先确认才能进入生产', { retryable: false }));
  }

  let nextAction = 'nothing_pending';
  if (!candidates.length) nextAction = 'prepare_copy';
  else if (!confirmedList.length) nextAction = 'confirm_copy';
  else if (!selected) nextAction = 'select_copy';
  else if (selected.confirmed) nextAction = 'nothing_pending';

  return {
    total: candidates.length,
    confirmedCount: confirmedList.length,
    draftCount: candidates.length - confirmedList.length,
    selectedScriptVersionId: selected && selected.confirmed ? selected.id : null,
    candidates,
    allowedActions: selected && selected.confirmed ? ['configure_items'] : ['select_copy'],
    blockingIssues,
    nextAction,
  };
}



/* ---------------------------------------------------------------------------
   F5-04：生产资产投影（P03 数字人 / P04 已有视频 / P05 场景模板）
   规则：
     - 模式 A 需要 形象版本 + 声音版本；模式 B 需要已有视频；两者共用场景模板；
     - 只有 approved 且 batchAllowed 的资产可用于批量生产（buildBatchPlan 同一规则）；
     - 本切片只做 选择 / 版本 / 状态 / 阻塞显示，不做登记与模型训练。
   --------------------------------------------------------------------------- */

export function projectAssetOption(record = {}, kind = 'asset') {
  const status = text(record.status, 'draft');
  const batchAllowed = record.batchAllowed === true;
  const blockingIssues = [];
  if (status !== 'approved') {
    blockingIssues.push(issue('ASSET_NOT_APPROVED', 'status', '该资产版本未审核通过，不能用于批量生产', { retryable: false }));
  } else if (!batchAllowed) {
    blockingIssues.push(issue('ASSET_NOT_BATCH_ALLOWED', 'batchAllowed', '该资产版本未开启批量使用权限', { retryable: false }));
  }
  /* 生成可用性还要求素材引用齐备：形象没有标准图、声音没有参考音频，都无法参与生成。 */
  if (kind === 'avatar' && !text(record.canonicalImageRef)) {
    blockingIssues.push(issue('AVATAR_IMAGE_MISSING', 'canonicalImageRef', '该形象版本缺少标准形象图引用', { retryable: false }));
  }
  if (kind === 'voice' && !text(record.referenceAudioRef)) {
    blockingIssues.push(issue('VOICE_REFERENCE_MISSING', 'referenceAudioRef', '该声音版本缺少参考音频引用', { retryable: false }));
  }
  const usable = status === 'approved' && batchAllowed && blockingIssues.length === 0;
  return {
    id: text(record.id),
    name: text(record.displayName, text(record.name, '未命名资产')),
    version: Number(record.version) || null,
    versionId: text(record.versionId) || text(record.id),
    status,
    batchAllowed,
    usable,
    authorizationStatus: text(record.authorizationStatus) || null,
    provider: text(record.provider) || null,
    allowedActions: usable ? ['select_asset'] : [],
    blockingIssues,
    updatedAt: toIsoOrNull(record.updatedAt),
  };
}

function groupAssetVersions(records = [], kind = 'asset') {
  const list = Array.isArray(records) ? records : [];
  const options = list.map((record) => projectAssetOption(record, kind));
  return {
    total: options.length,
    usable: options.filter((option) => option.usable).length,
    options,
  };
}

export function projectAssetCatalog(catalog = {}, draft = null) {
  const modeA = {
    avatars: groupAssetVersions(catalog.avatars, 'avatar'),
    voices: groupAssetVersions(catalog.voices, 'voice'),
  };
  const templates = groupAssetVersions(catalog.templates, 'template');

  /* 模式 B：现有目录里没有“已有视频 / 映射”这一类资产，必须如实标注未接入，而不是给一个空列表假装是结论。 */
  const modeB = {
    wired: false,
    sourceVideos: { total: 0, usable: 0, options: [] },
    note: '模式 B 的已有视频与映射目录尚未接入，接入点在后续切片',
  };

  const blockingIssues = [];
  if (!modeA.avatars.usable) {
    blockingIssues.push(issue('NO_USABLE_AVATAR', 'catalog.avatars', '没有可用于批量生产的数字人形象版本（需 approved 且开启批量）', { retryable: false }));
  }
  if (!modeA.voices.usable) {
    blockingIssues.push(issue('NO_USABLE_VOICE', 'catalog.voices', '没有可用于批量生产的数字人声音版本（需 approved 且开启批量）', { retryable: false }));
  }
  if (!templates.usable) {
    blockingIssues.push(issue('NO_USABLE_TEMPLATE', 'catalog.templates', '没有可用于批量生产的场景模板', { retryable: false }));
  }

  const selected = {
    avatarVersionId: text(draft?.selectedAvatarVersionId, null),
    voiceVersionId: text(draft?.selectedVoiceVersionId, null),
    templateVersionId: text(draft?.selectedTemplateVersionId, null),
  };
  const findOption = (group, id) => (id ? group.options.find((option) => option.id === id || option.versionId === id) || null : null);
  const selectedAvatar = findOption(modeA.avatars, selected.avatarVersionId);
  const selectedVoice = findOption(modeA.voices, selected.voiceVersionId);
  const selectedTemplate = findOption(templates, selected.templateVersionId);
  if (selected.avatarVersionId && !selectedAvatar) {
    blockingIssues.push(issue('SELECTED_ASSET_MISSING', 'selectedAvatarVersionId', '已选择的形象版本在当前目录里不存在', { retryable: false }));
  } else if (selectedAvatar && !selectedAvatar.usable) {
    blockingIssues.push(issue('SELECTED_ASSET_NOT_USABLE', 'selectedAvatarVersionId', '已选择的形象版本当前不可用于批量生产', { retryable: false }));
  }
  if (selected.voiceVersionId && !selectedVoice) {
    blockingIssues.push(issue('SELECTED_ASSET_MISSING', 'selectedVoiceVersionId', '已选择的声音版本在当前目录里不存在', { retryable: false }));
  } else if (selectedVoice && !selectedVoice.usable) {
    blockingIssues.push(issue('SELECTED_ASSET_NOT_USABLE', 'selectedVoiceVersionId', '已选择的声音版本当前不可用于批量生产', { retryable: false }));
  }
  if (selected.templateVersionId && !selectedTemplate) {
    blockingIssues.push(issue('SELECTED_ASSET_MISSING', 'selectedTemplateVersionId', '已选择的模板版本在当前目录里不存在', { retryable: false }));
  } else if (selectedTemplate && !selectedTemplate.usable) {
    blockingIssues.push(issue('SELECTED_ASSET_NOT_USABLE', 'selectedTemplateVersionId', '已选择的模板版本当前不可用于批量生产', { retryable: false }));
  }

  const modeAReady = modeA.avatars.usable > 0 && modeA.voices.usable > 0;
  const selectedModeAReady = Boolean(selectedAvatar?.usable && selectedVoice?.usable);

  let nextAction = 'nothing_pending';
  if (!modeAReady) nextAction = 'prepare_assets';
  else if (!selectedModeAReady) nextAction = 'select_assets';
  else nextAction = 'nothing_pending';

  return {
    modeA: { ...modeA, ready: modeAReady, selectedReady: selectedModeAReady },
    modeB,
    templates: { ...templates, selectedReady: Boolean(selectedTemplate?.usable) },
    selected: {
      ...selected,
      avatar: selectedAvatar,
      voice: selectedVoice,
      template: selectedTemplate,
    },
    allowedActions: modeAReady ? ['select_assets'] : [],
    blockingIssues,
    nextAction,
    source: {
      endpoints: ['/api/content/batches/catalog'],
      readAt: null,
      projectId: text(catalog.project?.id) || null,
      projectName: text(catalog.project?.name) || null,
      real: true,
    },
  };
}



/* ---------------------------------------------------------------------------
   F5-05：P06 生产任务工作区（五步 + 显式明细 + N17 生成前检查）
   规则：
     - 单条和批量共用一套任务：1 行明细就是单条生产；
     - production_item 一行对应一个输出，明细必须显式逐行添加（N15 禁止隐藏全组合）；
     - 模式 A 行需要 文案 + 形象 + 声音；模式 B 行需要 已有视频 + 文案 + 声音来源；
     - 输出设置：子目录 + 文件名，必须唯一且不含非法字符（N16）；
     - N17 生成前检查：所有必需引用可用且输入冻结后才允许执行。
   本切片不创建批次、不执行生成——把显式行转成真批次需要新的领域函数，
   这是对现有全组合 buildBatchPlan 的结构性调整，需要负责人确认（7.3）。
   --------------------------------------------------------------------------- */

export const DH_WORKSPACE_STEPS = Object.freeze([
  { no: '1', key: 'scope', label: '模式与范围' },
  { no: '2', key: 'rows', label: '明细配置' },
  { no: '3', key: 'output', label: '输出设置' },
  { no: '4', key: 'preflight', label: '生成前检查' },
  { no: '5', key: 'execute', label: '开始执行' },
]);

const DH_OUTPUT_NAME_FORBIDDEN = /[/\\:*?"<>|]/;

export function sanitizeOutputName(value) {
  return text(value).replace(/\s+/g, '-');
}

function normalizePlannedRows(input, copyIndex, assets, mode) {
  const rows = Array.isArray(input) ? input : [];
  return rows.slice(0, 300).map((raw, index) => {
    const rowMode = text(raw?.mode, mode) || 'A';
    const scriptVersionId = text(raw?.scriptVersionId, null);
    const avatarVersionId = text(raw?.avatarVersionId, null);
    const voiceVersionId = text(raw?.voiceVersionId, null);
    const templateVersionId = text(raw?.templateVersionId, null);
    const mappingVersionId = text(raw?.mappingVersionId, null);
    const outputName = sanitizeOutputName(raw?.outputName);
    const outputSubdirectory = sanitizeOutputName(raw?.outputSubdirectory);
    const script = scriptVersionId ? copyIndex.get(scriptVersionId) || null : null;
    const avatar = avatarVersionId ? assets.avatarIndex.get(avatarVersionId) || null : null;
    const voice = voiceVersionId ? assets.voiceIndex.get(voiceVersionId) || null : null;
    const template = templateVersionId ? assets.templateIndex.get(templateVersionId) || null : null;
    return {
      rowNo: index + 1,
      mode: rowMode,
      scriptVersionId,
      avatarVersionId,
      voiceVersionId,
      templateVersionId,
      sourceVideoAssetId: text(raw?.sourceVideoAssetId, null),
      mappingVersionId,
      outputName,
      outputSubdirectory,
      refs: {
        script,
        avatar,
        voice,
        template,
      },
    };
  });
}

/* N15：禁止隐藏全组合。选择区里勾了多个形象/多个文案，但明细没有显式覆盖，
   系统绝不能自动相乘，必须作为阻塞项提示用户逐行添加。 */
function detectHiddenCartesian(rows, assets, mode) {
  if (mode !== 'A') return null;
  const avatars = new Set(rows.map((row) => row.avatarVersionId).filter(Boolean));
  const scripts = new Set(rows.map((row) => row.scriptVersionId).filter(Boolean));
  const selectedAvatars = assets.selected?.avatarVersionId ? [assets.selected.avatarVersionId] : [];
  const selectedScripts = assets.selectedScriptIds || [];
  const impliedAvatars = new Set([...avatars, ...selectedAvatars]);
  const impliedScripts = new Set([...scripts, ...selectedScripts]);
  const implied = impliedAvatars.size * impliedScripts.size;
  if (implied > rows.length) {
    return issue(
      'HIDDEN_CARTESIAN_RISK',
      'plannedItems',
      '当前选择隐含 ' + implied + ' 种组合，但明细只有 ' + rows.length + ' 行。' +
        '系统不会自动全组合，需要哪几条就显式加哪几行（N15 禁止隐藏全组合）',
      { retryable: false },
    );
  }
  return null;
}

export function projectTaskWorkspace(input = {}) {
  const draft = input.draft && typeof input.draft === 'object' ? input.draft : {};
  const mappings = Array.isArray(input.mappings) ? input.mappings : [];
  const sourceVideos = Array.isArray(input.sourceVideos) ? input.sourceVideos : [];
  const copy = input.copy && typeof input.copy === 'object' ? input.copy : { candidates: [] };
  const assets = input.assets && typeof input.assets === 'object' ? input.assets : null;
  const mode = text(draft.mode, 'A') === 'B' ? 'B' : 'A';

  const copyIndex = new Map((copy.candidates || []).map((candidate) => [candidate.id, candidate]));
  const assetIndex = (list) => new Map((list || []).map((option) => [option.id, option]));
  const avatarIndex = assetIndex(assets?.modeA?.avatars?.options);
  const voiceIndex = assetIndex(assets?.modeA?.voices?.options);
  const templateIndex = assetIndex(assets?.templates?.options);
  const lookupAssets = { avatarIndex, voiceIndex, templateIndex };

  const rows = normalizePlannedRows(draft.plannedItems, copyIndex, lookupAssets, mode);
  const requestedItemCount = Number(draft.plannedItemCount) || rows.length || null;

  /* ---- 每行校验（N15 / N16 / N17 的事实来源） ---- */
  const blockingIssues = [];
  const seenNames = new Map();
  for (const row of rows) {
    const prefix = '第 ' + row.rowNo + ' 行';
    const rowMapping = row.mode === 'B' ? mappings.find((item) => item.id === row.mappingVersionId) || null : null;
    /* 映射就绪在工作区里就地判定（原始 mapping 没有 ready 字段）：
       视频可读 + 文案已确认 + 模板存在 + 声音来源齐全。 */
    const mappingReady = (mapping) => {
      if (!mapping) return false;
      const video = sourceVideos.find((item) => item.id === mapping.videoId) || null;
      const script = mapping.scriptVersionId ? copyIndex.get(mapping.scriptVersionId) || null : null;
      const template = mapping.templateVersionId ? templateIndex.get(mapping.templateVersionId) || null : null;
      return Boolean(video && video.status === 'usable' && script && script.confirmed && template);
    };
    if (row.mode === 'B') {
      if (!rowMapping || !mappingReady(rowMapping)) {
        blockingIssues.push(issue('ROW_MAPPING_NOT_READY', 'plannedItems[' + (row.rowNo - 1) + ']', prefix + '：模式 B 行必须引用一条完整映射（视频 + 已确认文案 + 声音来源 + 模板，N12）', { retryable: false }));
      }
    } else {
      if (!row.scriptVersionId || !row.refs.script) {
        blockingIssues.push(issue('ROW_COPY_MISSING', 'plannedItems[' + (row.rowNo - 1) + ']', prefix + '：还没有引用已确认的文案版本', { retryable: false }));
      } else if (!row.refs.script.confirmed) {
        blockingIssues.push(issue('ROW_COPY_NOT_CONFIRMED', 'plannedItems[' + (row.rowNo - 1) + ']', prefix + '：引用的文案未确认，不能进入生产', { retryable: false }));
      }
      if (!row.avatarVersionId || !row.refs.avatar) {
        blockingIssues.push(issue('ROW_AVATAR_MISSING', 'plannedItems[' + (row.rowNo - 1) + ']', prefix + '：还没有引用数字人形象版本', { retryable: false }));
      } else if (!row.refs.avatar.usable) {
        blockingIssues.push(issue('ROW_AVATAR_NOT_USABLE', 'plannedItems[' + (row.rowNo - 1) + ']', prefix + '：引用的形象版本当前不可用于批量生产', { retryable: false }));
      }
      if (!row.voiceVersionId || !row.refs.voice) {
        blockingIssues.push(issue('ROW_VOICE_MISSING', 'plannedItems[' + (row.rowNo - 1) + ']', prefix + '：还没有引用数字人声音版本', { retryable: false }));
      } else if (!row.refs.voice.usable) {
        blockingIssues.push(issue('ROW_VOICE_NOT_USABLE', 'plannedItems[' + (row.rowNo - 1) + ']', prefix + '：引用的声音版本当前不可用于批量生产', { retryable: false }));
      }
    }
    /* 模式 B 行的模板来自映射本身；模板缺失已在映射检查里报过，这里只在模式 A 检查。 */
    const rowTemplateResolved = row.mode === 'B' ? (mappingReady(rowMapping) ? { usable: true } : null) : row.refs.template;
    if (row.mode !== 'B' && (!row.templateVersionId || !rowTemplateResolved)) {
      blockingIssues.push(issue('ROW_TEMPLATE_MISSING', 'plannedItems[' + (row.rowNo - 1) + ']', prefix + '：还没有引用场景模板版本', { retryable: false }));
    } else if (row.mode !== 'B' && !rowTemplateResolved.usable) {
      blockingIssues.push(issue('ROW_TEMPLATE_NOT_USABLE', 'plannedItems[' + (row.rowNo - 1) + ']', prefix + '：引用的模板版本当前不可用于批量生产', { retryable: false }));
    }
    if (!row.outputName) {
      blockingIssues.push(issue('ROW_OUTPUT_NAME_MISSING', 'plannedItems[' + (row.rowNo - 1) + ']', prefix + '：缺少输出文件名（N16 输出设置）', { retryable: false }));
    } else if (DH_OUTPUT_NAME_FORBIDDEN.test(row.outputName)) {
      blockingIssues.push(issue('ROW_OUTPUT_NAME_INVALID', 'plannedItems[' + (row.rowNo - 1) + ']', prefix + '：输出文件名含有非法字符 / \\ : * ? " < > |', { retryable: false }));
    } else if (seenNames.has(row.outputName)) {
      blockingIssues.push(issue('ROW_OUTPUT_NAME_CONFLICT', 'plannedItems[' + (row.rowNo - 1) + ']', prefix + '：输出文件名与第 ' + seenNames.get(row.outputName) + ' 行重复（N16 命名冲突）', { retryable: false }));
    } else {
      seenNames.set(row.outputName, row.rowNo);
    }
  }
  const hiddenCartesian = detectHiddenCartesian(rows, assets, mode);
  if (hiddenCartesian) blockingIssues.push(hiddenCartesian);
  if (!rows.length) {
    blockingIssues.push(issue('NO_PLANNED_ROWS', 'plannedItems', '明细至少要有 1 行；1 行就是单条生产（N15）', { retryable: false }));
  }

  /* ---- 五步状态 ---- */
  const stepStates = {
    scope: 'done',
    rows: rows.length ? (blockingIssues.some((item) => item.code.startsWith('ROW_')) ? 'blocked' : 'done') : 'todo',
    output: rows.length && rows.every((row) => row.outputName && !DH_OUTPUT_NAME_FORBIDDEN.test(row.outputName)) ? 'done' : 'todo',
    preflight: blockingIssues.length ? 'blocked' : 'not_run',
    execute: 'unwired',
  };
  if (draft.preflightResult?.passed === true && !blockingIssues.length) {
    stepStates.preflight = 'passed';
  }

  const outputDir = sanitizeOutputName(text(draft.title, '口播生产') || '口播生产');

  return {
    mode,
    title: text(draft.title, '未命名口播生产草稿'),
    requestedItemCount,
    rowCount: rows.length,
    isSingle: rows.length === 1,
    rows: rows.map((row) => ({
      rowNo: row.rowNo,
      mode: row.mode,
      refs: {
        script: row.refs.script ? { id: row.refs.script.id, title: row.refs.script.title, confirmed: row.refs.script.confirmed } : null,
        avatar: row.refs.avatar ? { id: row.refs.avatar.id, name: row.refs.avatar.name, usable: row.refs.avatar.usable } : null,
        voice: row.refs.voice ? { id: row.refs.voice.id, name: row.refs.voice.name, usable: row.refs.voice.usable } : null,
        template: row.refs.template ? { id: row.refs.template.id, name: row.refs.template.name, usable: row.refs.template.usable } : null,
      },
      outputName: row.outputName,
      outputSubdirectory: row.outputSubdirectory || outputDir,
      outputPath: (row.outputSubdirectory || outputDir) + '/' + (row.outputName || '未命名') + '.mp4',
      blockingIssues: blockingIssues.filter((item) => item.field === 'plannedItems[' + (row.rowNo - 1) + ']'),
    })),
    steps: DH_WORKSPACE_STEPS.map((step) => ({ ...step, status: stepStates[step.key] })),
    outputPolicy: {
      directory: text(input.outputRoot, '（由输出策略决定，首版本地目录）'),
      writeable: input.outputWriteable === true,
      subdirectory: outputDir,
      namePattern: '行号或自定义文件名 + .mp4，同一任务内必须唯一（N16）',
      note: '生成出来的视频保存位置由用户设置；生产任务保存目录策略、命名规则和实际文件记录。',
    },
    allowedActions: rows.length ? ['run_preflight'] : [],
    blockingIssues,
    nextAction: blockingIssues.length ? 'fix_blockers' : rows.length ? 'run_preflight' : 'add_rows',
    preflight: draft.preflightResult || null,
    preflightHistory: Array.isArray(draft.preflightHistory) ? draft.preflightHistory.slice(-20).reverse() : [],
    executionWired: false,
    source: {
      endpoints: ['/api/content/digital-human/draft', '/api/content/digital-human/copy', '/api/content/digital-human/assets'],
      readAt: null,
      real: true,
    },
  };
}

/* N17 闸门：统一返回格式（7.1）。只判定，不执行。 */
export function preflightGate(workspace) {
  const blockingIssues = Array.isArray(workspace.blockingIssues) ? workspace.blockingIssues : [];
  const passed = blockingIssues.length === 0;
  return {
    success: passed,
    entity_id: text(workspace.title, 'draft') || 'draft',
    previous_state: { preflight: 'not_run', rows: workspace.rowCount },
    current_state: { preflight: passed ? 'passed' : 'blocked', rows: workspace.rowCount },
    allowed_actions: passed ? ['start_execution'] : ['fix_blockers'],
    blocking_issues: blockingIssues,
    next_action: passed ? 'start_execution' : 'fix_blockers',
    event_id: null,
    version: 'dh-preflight-v1',
    note: '生成执行（N18）尚未接入：通过生成前检查也不代表会开始生成，更不会产生任何视频文件。',
  };
}



/* ---------------------------------------------------------------------------
   F5-06/F5-07：P07 结果验收 + P08 内容包投影
   规则：
     - 每条结果独立三轴状态（复用 projectBatchItem）；
     - 预览：没有真实文件就如实显示没有，模拟输出不得作为可预览成片；
     - 导出资格（5.10）：生成 succeeded + 文件 verified + 审核 approved + 非模拟；
     - 审核动作由领域层执行，这里只标注哪条规则会拦住它。
   --------------------------------------------------------------------------- */

export function projectResultItem(item = {}, rowNo = null) {
  const projected = projectBatchItem(item, rowNo);
  const simulated = projected.currentOutput?.simulated === true;
  const hasRealFile = Boolean(item.output?.fileRef || item.output?.videoUrl || item.output?.path);
  const reviewBlockedReason = simulated
    ? '领域规则：模拟输出只能用于验证队列和状态，不能审核通过或作为生产内容交付'
    : projected.reviewStatus === 'approved'
      ? '该结果已经人工通过'
      : null;

  return {
    ...projected,
    preview: {
      available: hasRealFile && !simulated,
      simulated,
      reason: simulated
        ? '这是模拟输出，没有真实视频文件，不能预览也不能交付'
        : hasRealFile
          ? '可预览'
          : '该结果还没有可预览的文件',
    },
    attempts: {
      current: Number(item.attempt) || 0,
      max: Number(item.maxAttempts) || 0,
      historyCount: Array.isArray(item.history) ? item.history.length : null,
    },
    reviewBlockedReason,
    actions: {
      approve: projected.reviewStatus === 'waiting_review' && !simulated,
      requestChanges: projected.reviewStatus === 'waiting_review',
      reject: projected.reviewStatus === 'waiting_review',
      retry: projected.allowedActions.includes('retry_item'),
    },
  };
}

export function projectResultBoard(batches = []) {
  const list = Array.isArray(batches) ? batches : [];
  const tasks = list.map((batch) => {
    const task = projectProductionTask(batch);
    return {
      ...task,
      items: task.items.map((item, index) => projectResultItem((batch.items || [])[index], index + 1)),
      canRun: ['waiting_approval', 'queued', 'paused', 'partial_failed', 'blocked'].includes(text(batch.status)) &&
        !(task.items || []).some((item) => item.generationStatus === 'running'),
    };
  });
  const items = tasks.flatMap((task) => task.items);
  return {
    batchCount: tasks.length,
    itemCount: items.length,
    counts: {
      generated: items.filter((item) => item.generationStatus === 'succeeded').length,
      failed: items.filter((item) => ['failed', 'blocked'].includes(item.generationStatus)).length,
      approved: items.filter((item) => item.reviewStatus === 'approved').length,
      waitingReview: items.filter((item) => item.reviewStatus === 'waiting_review').length,
      changesRequested: items.filter((item) => ['changes_requested', 'rejected'].includes(item.reviewStatus)).length,
    },
    previewableCount: items.filter((item) => item.preview.available).length,
    simulatedCount: items.filter((item) => item.preview.simulated).length,
    tasks,
    allowedActions: [
      ...(tasks.some((task) => task.canRun) ? ['start_execution'] : []),
      ...(items.some((item) => item.actions.requestChanges) ? ['request_changes'] : []),
      ...(items.some((item) => item.actions.retry) ? ['retry_item'] : []),
    ],
    nextAction: items.some((item) => item.reviewStatus === 'waiting_review')
      ? 'review_pending_items'
      : items.some((item) => item.actions.retry)
        ? 'retry_failed_items'
        : tasks.some((task) => task.canRun)
          ? 'start_execution'
          : 'nothing_pending',
    source: { endpoints: ['/api/content/batches'], readAt: null, real: true },
  };
}

export function projectPackageView(batches = []) {
  const list = Array.isArray(batches) ? batches : [];
  const groups = list.map((batch) => {
    const task = projectProductionTask(batch);
    const items = (batch.items || []).map((item, index) => {
      const projected = projectResultItem(item, index + 1);
      /* 5.10 导出资格五条件 */
      const checks = [
        { code: 'GENERATION_SUCCEEDED', ok: projected.generationStatus === 'succeeded', label: '生成状态 succeeded' },
        { code: 'FILE_VERIFIED', ok: Boolean(projected.currentOutput) && projected.currentOutput.verificationStatus === 'verified' && !projected.preview.simulated, label: '输出文件 verified 且非模拟' },
        { code: 'REVIEW_APPROVED', ok: projected.reviewStatus === 'approved', label: '人工审核 approved' },
        { code: 'OUTPUT_CURRENT', ok: Boolean(projected.currentOutput), label: '存在当前输出（未被替代）' },
      ];
      return {
        rowNo: projected.rowNo,
        id: projected.id,
        eligible: checks.every((check) => check.ok),
        failedChecks: checks.filter((check) => !check.ok).map((check) => check.code),
        checks,
        outputName: text(item.outputName, null),
      };
    });
    const eligible = items.filter((item) => item.eligible);
    const exportRecord = batch.exportRecord && typeof batch.exportRecord === 'object' ? batch.exportRecord : null;
    return {
      id: text(batch.id),
      title: text(batch.title, '未命名生产任务'),
      batchStatus: text(batch.status),
      itemCount: items.length,
      eligibleCount: eligible.length,
      items,
      blockedReason: eligible.length
        ? null
        : (batch.items || []).some((item) => item.output?.simulated === true)
          ? '当前结果都是模拟输出：模拟输出不能导出为审核通过的生产内容包'
          : '没有同时满足「生成成功 + 文件 verified + 人工通过」的结果',
      exportRecord: exportRecord
        ? {
            status: text(exportRecord.status),
            approvedCount: Number(exportRecord.approvedCount) || 0,
            manifest: text(exportRecord.manifest) || null,
            packageDir: text(exportRecord.package?.packageDir || exportRecord.package?.directory) || null,
            missingFiles: Array.isArray(exportRecord.package?.missingFiles) ? exportRecord.package.missingFiles.length : null,
            exportedAt: toIsoOrNull(exportRecord.exportedAt),
          }
        : null,
    };
  });
  const exportableCount = groups.reduce((sum, group) => sum + group.eligibleCount, 0);
  return {
    batchCount: groups.length,
    exportableCount,
    groups,
    allowedActions: exportableCount ? ['export_package'] : [],
    nextAction: exportableCount ? 'export_package' : groups.length ? 'review_pending_items' : 'prepare_assets',
    note: '导出只引用：生成 succeeded、文件 verified、人工 approved、明确选择、未被替代（5.10）。模拟输出永远不能导出。',
    source: { endpoints: ['/api/content/batches'], readAt: null, real: true },
  };
}



/* ---------------------------------------------------------------------------
   S6-01：N01–N02 项目上下文与文案生成需求投影
   --------------------------------------------------------------------------- */

export const DH_COPY_REQUEST_FIELDS = Object.freeze([
  { key: 'count', label: '数量', required: true },
  { key: 'direction', label: '方向', required: true },
  { key: 'platform', label: '平台', required: true },
  { key: 'durationSeconds', label: '时长（秒）', required: false },
]);

export function projectContextStage(contexts = [], request = null, selectedContextId = null) {
  const list = Array.isArray(contexts) ? contexts : [];
  const latestByKey = new Map();
  for (const item of list) {
    if (!latestByKey.has(item.contextKey) || (item.version || 0) > (latestByKey.get(item.contextKey).version || 0)) {
      latestByKey.set(item.contextKey, item);
    }
  }
  const versions = [...latestByKey.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const selected = selectedContextId ? list.find((item) => item.id === selectedContextId) || null : null;
  const blockingIssues = [];
  if (!versions.length) {
    blockingIssues.push(issue('NO_PROJECT_CONTEXT', 'project_contexts', '还没有项目上下文：行业、产品、受众、卖点、内容目标是文案和生产的前提（N01）', { retryable: false }));
  } else if (selected && selected.status !== 'active') {
    blockingIssues.push(issue('SELECTED_CONTEXT_ARCHIVED', 'selectedContextId', '已选择的项目上下文已归档，请重新选择', { retryable: false }));
  }
  const requestIssues = [];
  if (!request) {
    requestIssues.push(issue('NO_COPY_REQUEST', 'copy_generation_requests', '还没有文案生成需求：数量、方向、平台是批量候选的前提（N02）', { retryable: false }));
  } else {
    if (!request.count) requestIssues.push(issue('COPY_REQUEST_COUNT_MISSING', 'count', '生成数量缺失', { retryable: false }));
    if (!text(request.direction)) requestIssues.push(issue('COPY_REQUEST_DIRECTION_MISSING', 'direction', '生成方向缺失', { retryable: false }));
    if (!text(request.platform)) requestIssues.push(issue('COPY_REQUEST_PLATFORM_MISSING', 'platform', '目标平台缺失', { retryable: false }));
  }

  let nextAction = 'nothing_pending';
  if (!versions.length) nextAction = 'create_context';
  else if (!selected) nextAction = 'select_context';
  else if (requestIssues.length) nextAction = 'configure_copy_request';
  else nextAction = 'nothing_pending';

  return {
    versions,
    selected,
    selectedContextId: selected ? selected.id : null,
    request: request || null,
    requestIssues,
    blockingIssues,
    allowedActions: versions.length ? ['select_context', 'configure_copy_request'] : ['create_context'],
    nextAction,
    modelProviderConfigured: false,
    note: 'N03 AI 批量生成的模型提供方尚未配置：本阶段用手动登记候选 + 状态机占位，生成按钮只会返回明确阻塞。',
  };
}

/* ---------------------------------------------------------------------------
   S6-02：N05–N10 数字人档案阶段投影；S6-03：N11–N12 模式 B 阶段投影
   规则：
     - 档案 = 员工主体 + 形象版本绑定 + 声音版本绑定；
     - 处理状态没有真实提供方时只能停在 pending_provider，绝不显示已训练；
     - 档案 ready_for_production 由绑定版本的 approved+batchAllowed 推导；
     - 模式 B 映射必须显式包含 视频/文案/声音来源/模板 四项才算 ready。
   --------------------------------------------------------------------------- */

export function projectDigitalHumanProfiles(profiles = [], assets = null) {
  const list = Array.isArray(profiles) ? profiles : [];
  const avatarIndex = new Map((assets?.modeA?.avatars?.options || []).map((item) => [item.id, item]));
  const voiceIndex = new Map((assets?.modeA?.voices?.options || []).map((item) => [item.id, item]));
  const profilesView = list.map((profile) => {
    const avatar = profile.avatarVersionId ? avatarIndex.get(profile.avatarVersionId) || null : null;
    const voice = profile.voiceVersionId ? voiceIndex.get(profile.voiceVersionId) || null : null;
    const bindingIssues = [];
    if (!avatar) bindingIssues.push(issue('PROFILE_AVATAR_UNBOUND', 'avatar_version_id', '该档案还没有绑定可用的形象版本（N06–N07）', { retryable: false }));
    if (!voice) bindingIssues.push(issue('PROFILE_VOICE_UNBOUND', 'voice_version_id', '该档案还没有绑定可用的声音版本（N08–N09）', { retryable: false }));
    const ready = Boolean(avatar && voice);
    return {
      id: profile.id,
      name: profile.name,
      subjectRole: profile.subjectRole || null,
      status: ready ? 'ready_for_production' : 'draft',
      processingStatus: 'pending_provider',
      processingNote: '真实形象/声音训练的提供方尚未配置：状态停在「待处理-提供方未配置」，不显示为已训练。',
      avatar: avatar ? { id: avatar.id, name: avatar.name, usable: avatar.usable } : null,
      voice: voice ? { id: voice.id, name: voice.name, usable: voice.usable } : null,
      ready,
      allowedActions: ready ? ['use_in_production'] : ['complete_binding'],
      blockingIssues: bindingIssues,
    };
  });
  const blockingIssues = [];
  if (!profilesView.length) {
    blockingIssues.push(issue('NO_DIGITAL_HUMAN_PROFILE', 'digital_human_profiles', '还没有员工数字人档案：模式 A 的生产以档案为主体绑定形象与声音（N05）', { retryable: false }));
  } else if (!profilesView.some((profile) => profile.ready)) {
    blockingIssues.push(issue('NO_READY_DIGITAL_HUMAN_PROFILE', 'digital_human_profiles', '有档案但没有任何一个完成形象/声音绑定，不能进入生产（N10）', { retryable: false }));
  }
  return {
    profiles: profilesView,
    readyCount: profilesView.filter((profile) => profile.ready).length,
    totalCount: profilesView.length,
    blockingIssues,
    nextAction: profilesView.some((profile) => profile.ready) ? 'nothing_pending' : profilesView.length ? 'complete_binding' : 'create_profile',
    source: { endpoints: ['/api/content/digital-human/profiles'], readAt: null, real: true },
  };
}

export function projectModeBStage(sourceVideos = [], mappings = [], copy = null, assets = null) {
  const videos = Array.isArray(sourceVideos) ? sourceVideos : [];
  const maps = Array.isArray(mappings) ? mappings : [];
  const scriptIndex = new Map((copy?.candidates || []).map((item) => [item.id, item]));
  const templateIndex = new Map((assets?.templates?.options || []).map((item) => [item.id, item]));

  const mappingsView = maps.map((mapping) => {
    const video = videos.find((item) => item.id === mapping.videoId) || null;
    const script = mapping.scriptVersionId ? scriptIndex.get(mapping.scriptVersionId) || null : null;
    const template = mapping.templateVersionId ? templateIndex.get(mapping.templateVersionId) || null : null;
    const missing = [];
    if (!video) missing.push('VIDEO_MISSING');
    if (!script || !script.confirmed) missing.push('SCRIPT_NOT_CONFIRMED');
    if (mapping.voiceSource === 'voice_version' && !mapping.voiceVersionId) missing.push('VOICE_SOURCE_MISSING');
    if (!template) missing.push('TEMPLATE_MISSING');
    if (video && video.status !== 'usable') missing.push('VIDEO_NOT_USABLE');
    return {
      id: mapping.id,
      video: video ? { id: video.id, name: video.name, status: video.status } : null,
      script: script ? { id: script.id, title: script.title, confirmed: script.confirmed } : null,
      voiceSource: mapping.voiceSource || 'original',
      voiceVersionId: mapping.voiceVersionId || null,
      template: template ? { id: template.id, name: template.name, usable: template.usable } : null,
      ready: missing.length === 0,
      missing,
    };
  });
  const blockingIssues = [];
  if (!videos.length) {
    blockingIssues.push(issue('NO_SOURCE_VIDEO', 'source_videos', '模式 B 还没有导入任何已有视频（N11）。导入是登记元信息，本阶段不解析真实文件。', { retryable: false }));
  } else if (!mappingsView.some((mapping) => mapping.ready)) {
    blockingIssues.push(issue('NO_READY_VIDEO_MAPPING', 'video_mappings', '有视频但没有任何完整映射：视频、已确认文案、声音来源、模板四项缺一不可（N12）', { retryable: false }));
  }
  return {
    videos,
    mappings: mappingsView,
    readyMappingCount: mappingsView.filter((mapping) => mapping.ready).length,
    mappingCount: mappingsView.length,
    blockingIssues,
    nextAction: mappingsView.some((mapping) => mapping.ready) ? 'nothing_pending' : videos.length ? 'complete_mapping' : 'import_video',
    source: { endpoints: ['/api/content/digital-human/modeb'], readAt: null, real: true },
  };
}

export function projectCenterSummary(input = {}) {
  const batches = Array.isArray(input.batches) ? input.batches : [];
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const catalog = input.catalog && typeof input.catalog === 'object' ? input.catalog : {};
  const productionTasks = batches.map((batch) => projectProductionTask(batch));
  const items = productionTasks.flatMap((task) => task.items);

  const counts = {
    pendingConfigure: items.filter((item) => item.generationStatus === 'planned').length,
    generating: items.filter((item) => ['queued', 'running'].includes(item.generationStatus)).length,
    waitingReview: items.filter((item) => item.reviewStatus === 'waiting_review').length,
    needsChanges: items.filter((item) => ['changes_requested', 'rejected'].includes(item.reviewStatus)).length,
    failedRetryable: items.filter((item) => item.allowedActions.includes('retry_item')).length,
    blocked: items.filter((item) => item.generationStatus === 'blocked').length,
    approvedExportable: items.filter((item) => item.allowedActions.includes('select_for_package')).length,
  };

  /* 资产就绪度：直接来自 catalog 的真实计数，不推断。 */
  const avatars = Array.isArray(catalog.avatars) ? catalog.avatars.length : 0;
  const voices = Array.isArray(catalog.voices) ? catalog.voices.length : 0;
  const scripts = Array.isArray(catalog.scripts) ? catalog.scripts.length : 0;
  const templates = Array.isArray(catalog.templates) ? catalog.templates.length : 0;
  const connectors = Array.isArray(catalog.connectors) ? catalog.connectors.length : 0;
  const productionReadyConnectors = (Array.isArray(catalog.connectors) ? catalog.connectors : [])
    .filter((connector) => ['ready', 'simulation'].includes(text(connector.status)))
    .filter((connector) => Array.isArray(connector.capabilities) && connector.capabilities.includes('talking_head'))
    .length;

  const assetGaps = [];
  if (!avatars) assetGaps.push(issue('NO_AVATAR_VERSION', 'catalog.avatars', '还没有可用的数字人形象版本'));
  if (!voices) assetGaps.push(issue('NO_VOICE_VERSION', 'catalog.voices', '还没有可用的数字人声音版本'));
  if (!scripts) assetGaps.push(issue('NO_SCRIPT_VERSION', 'catalog.scripts', '还没有可用的已确认文案版本'));
  if (!templates) assetGaps.push(issue('NO_TEMPLATE_VERSION', 'catalog.templates', '还没有可用的场景模板'));
  if (!productionReadyConnectors) assetGaps.push(issue('NO_READY_CONNECTOR', 'catalog.connectors', '还没有具备口播能力的可用连接器'));

  const blockingIssues = [];
  const allowedActions = [];

  if (!productionTasks.length) {
    /* 没有任何生产任务：唯一有事实依据的下一步就是先准备资产 / 建立任务。 */
    if (assetGaps.length) {
      blockingIssues.push(...assetGaps);
      allowedActions.push('configure_items');
    } else {
      allowedActions.push('configure_items');
    }
  } else {
    for (const task of productionTasks) {
      if (task.allowedActions.includes('fix_blockers')) allowedActions.push('fix_blockers');
      if (task.allowedActions.includes('retry_item')) allowedActions.push('retry_item');
      if (task.allowedActions.includes('review_item')) allowedActions.push('review_item');
      if (task.allowedActions.includes('export_approved')) allowedActions.push('export_approved');
    }
    blockingIssues.push(...productionTasks.flatMap((task) => task.blockingIssues));
  }

  let nextAction = 'nothing_pending';
  if (!productionTasks.length) {
    nextAction = assetGaps.length ? 'prepare_assets' : 'configure_items';
  } else if (productionTasks.some((task) => task.nextAction === 'fix_blockers')) {
    nextAction = 'fix_blockers';
  } else if (productionTasks.some((task) => task.nextAction === 'retry_failed_items')) {
    nextAction = 'retry_failed_items';
  } else if (productionTasks.some((task) => task.nextAction === 'review_pending_items')) {
    nextAction = 'review_pending_items';
  } else if (productionTasks.some((task) => task.nextAction === 'regenerate_items')) {
    nextAction = 'regenerate_items';
  } else if (productionTasks.some((task) => task.nextAction === 'export_approved')) {
    nextAction = 'export_approved';
  } else if (productionTasks.some((task) => task.nextAction === 'configure_items')) {
    nextAction = 'configure_items';
  }

  /* 去重后保持稳定顺序，避免页面按钮顺序抖动。 */
  const uniqueActions = [...new Set(allowedActions)];

  return {
    source: {
      endpoints: [
        '/api/content/batches',
        '/api/content/tasks',
        '/api/content/batches/catalog',
      ],
      readAt: input.readAt || null,
      batchCount: batches.length,
      contentTaskCount: tasks.length,
      real: input.real !== false,
    },
    project: {
      id: text(catalog.project?.id) || null,
      name: text(catalog.project?.name) || null,
      status: text(catalog.project?.status) || null,
    },
    counts,
    assets: { avatars, voices, scripts, templates, connectors, productionReadyConnectors },
    assetGaps,
    tasks: productionTasks,
    contentTasks: tasks.map((task) => ({
      id: text(task.id),
      title: text(task.title),
      status: text(task.status),
      role: text(task.role),
      projectId: text(task.projectId) || null,
      completedNodes: Number(task.completedNodes) || 0,
      totalNodes: Number(task.totalNodes) || 0,
      nextNode: task.nextNode ? { id: text(task.nextNode.id), label: text(task.nextNode.label), status: text(task.nextNode.status) } : null,
      updatedAt: toIsoOrNull(task.updatedAt),
    })),
    allowedActions: uniqueActions,
    blockingIssues,
    nextAction,
    deliveryAxisWired: DH_DELIVERY_AXIS_WIRED,
  };
}
