export const CONTENT_WORKFLOW_VERSION = 'ce-p0-v0.2';

export const CONTENT_NODE_CATALOG = [
  { id: 'CE-01', key: 'work_item.create', label: '创建内容任务', kind: 'system', humanGate: false },
  { id: 'CE-02', key: 'brand_profile.load', label: '加载品牌资料', kind: 'knowledge', humanGate: true },
  { id: 'CE-03', key: 'knowledge.search', label: '检索知识', kind: 'knowledge', humanGate: false },
  { id: 'CE-04', key: 'asset.import', label: '导入素材', kind: 'asset', humanGate: true },
  { id: 'CE-05', key: 'media.probe', label: '读取媒体信息', kind: 'media', humanGate: false },
  { id: 'CE-06', key: 'transcript.create', label: '生成转写', kind: 'media', humanGate: false },
  { id: 'CE-07', key: 'ocr.extract', label: '提取画面文字', kind: 'media', humanGate: true },
  { id: 'CE-08', key: 'keyframe.extract', label: '提取关键帧', kind: 'media', humanGate: false },
  { id: 'CE-09', key: 'content.structure_analyze', label: '分析内容结构', kind: 'analysis', humanGate: true },
  { id: 'CE-10', key: 'topic.generate', label: '生成选题', kind: 'generation', humanGate: true },
  { id: 'CE-11', key: 'copy.generate', label: '生成脚本与文案', kind: 'generation', humanGate: true },
  { id: 'CE-12', key: 'platform.adapt', label: '生成平台版本', kind: 'generation', humanGate: true },
  { id: 'CE-13', key: 'shotlist.generate', label: '生成分镜与制作计划', kind: 'generation', humanGate: true },
  { id: 'CE-14', key: 'tts.create', label: '生成语音', kind: 'media', humanGate: true },
  { id: 'CE-15', key: 'avatar.create', label: '生成数字人', kind: 'media', humanGate: true },
  { id: 'CE-16', key: 'timeline.render', label: '渲染视频', kind: 'media', humanGate: false },
  { id: 'CE-17', key: 'subtitle.generate', label: '生成字幕', kind: 'media', humanGate: true },
  { id: 'CE-18', key: 'cover.generate', label: '生成封面', kind: 'media', humanGate: true },
  { id: 'CE-19', key: 'review.create', label: '创建审核单', kind: 'review', humanGate: false },
  { id: 'CE-20', key: 'review.submit', label: '提交审核意见', kind: 'review', humanGate: true },
  { id: 'CE-21', key: 'revision.apply', label: '应用修改并生成新版本', kind: 'revision', humanGate: true },
  { id: 'CE-22', key: 'package.export', label: '打包内容', kind: 'delivery', humanGate: true },
  { id: 'CE-23', key: 'publish.draft', label: '创建发布草稿', kind: 'publish', humanGate: true },
  { id: 'CE-24', key: 'publish.execute', label: '执行发布', kind: 'publish', humanGate: true },
  { id: 'CE-25', key: 'feedback.record', label: '记录反馈', kind: 'feedback', humanGate: false },
  { id: 'CE-26', key: 'retro.generate', label: '生成复盘建议', kind: 'feedback', humanGate: true },
];

const EDITABLE_STATUSES = new Set(['draft', 'changes_requested']);
const NODE_STATUSES = new Set(['pending', 'ready', 'running', 'waiting_review', 'succeeded', 'failed', 'blocked', 'skipped']);

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function list(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 20)
    : [];
}

function nowIso() {
  return new Date().toISOString();
}

function actorSnapshot(actor) {
  return {
    username: actor?.username || 'system',
    displayName: actor?.displayName || '系统',
  };
}

function personSnapshot(value, fallback = actorSnapshot()) {
  if (typeof value === 'string' && value.trim()) {
    return { username: value.trim(), displayName: value.trim() };
  }
  return {
    username: text(value?.username, fallback.username),
    displayName: text(value?.displayName, fallback.displayName),
  };
}

function personList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => personSnapshot(item, { username: '', displayName: '' }))
    .filter((item) => item.username)
    .slice(0, 20);
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function buildNodeExecutionTrace(node, task, input, status, actor, timestamp) {
  const execution = objectOrNull(input?.execution) || {};
  return {
    nodeId: node.id,
    nodeType: node.kind,
    workflowVersion: task.workflowVersion,
    inputRefs: execution.inputRefs ?? input?.inputRefs ?? input?.input ?? null,
    outputRefs: execution.outputRefs ?? input?.outputRefs ?? input?.output ?? null,
    sensitive: execution.sensitive === true,
    permissions: list(execution.permissions),
    toolVersion: text(execution.toolVersion, null),
    modelVersion: text(execution.modelVersion, null),
    promptVersion: text(execution.promptVersion, null),
    connectorVersion: text(execution.connectorVersion, null),
    environmentVersion: text(execution.environmentVersion, null),
    startedAt: text(execution.startedAt, node.startedAt || timestamp),
    completedAt: ['succeeded', 'failed', 'blocked', 'skipped'].includes(status) ? timestamp : null,
    status,
    error: status === 'succeeded' || status === 'skipped' ? null : text(input?.error, '节点未完成'),
    retryCount: node.attempts,
    humanAction: text(execution.humanAction, text(input?.note, null)),
    requiresConfirmation: Boolean(node.humanGate),
    confirmation: objectOrNull(execution.confirmation),
    actions: {
      pause: ['ready', 'running', 'waiting_review'].includes(status),
      retry: ['failed', 'blocked'].includes(status),
      skip: ['ready', 'running', 'waiting_review'].includes(status),
      rollback: false,
      transfer: node.humanGate && ['ready', 'running', 'waiting_review'].includes(status),
    },
    actor: actorSnapshot(actor),
  };
}

function nodeFromCatalog(catalogNode, index, timestamp) {
  return {
    ...catalogNode,
    order: index + 1,
    status: 'pending',
    attempts: 0,
    input: null,
    output: null,
    error: null,
    evidence: [],
    trace: null,
    startedAt: null,
    completedAt: null,
    updatedAt: timestamp,
  };
}

export function normalizeContentTask(raw, options = {}) {
  const timestamp = options.now || nowIso();
  const source = raw && typeof raw === 'object' ? raw : {};
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const nodes = CONTENT_NODE_CATALOG.map((catalogNode, index) => {
    const saved = rawNodes.find((node) => node?.id === catalogNode.id) || {};
    const normalized = nodeFromCatalog(catalogNode, index, saved.updatedAt || timestamp);
    return {
      ...normalized,
      ...saved,
      id: catalogNode.id,
      key: catalogNode.key,
      label: catalogNode.label,
      kind: catalogNode.kind,
      humanGate: catalogNode.humanGate,
      order: index + 1,
      status: NODE_STATUSES.has(saved.status) ? saved.status : 'pending',
      attempts: Number.isInteger(saved.attempts) && saved.attempts >= 0 ? saved.attempts : 0,
      evidence: Array.isArray(saved.evidence) ? saved.evidence : [],
      trace: objectOrNull(saved.trace),
    };
  });
  const createdAt = text(source.createdAt, timestamp);
  const createdBy = personSnapshot(source.createdBy);
  return {
    id: text(source.id, ''),
    tenantId: text(source.tenantId, 'tenant_local'),
    projectId: text(source.projectId, 'project_content_editor'),
    type: 'content_editing',
    role: '内容编辑云员工',
    workflowVersion: text(source.workflowVersion, CONTENT_WORKFLOW_VERSION),
    title: text(source.title, '未命名内容任务'),
    customerId: text(source.customerId, null),
    brandProfileId: text(source.brandProfileId, null),
    objective: text(source.objective),
    audience: text(source.audience),
    platforms: list(source.platforms),
    sourceBrief: text(source.sourceBrief),
    sourceAssets: list(source.sourceAssets),
    status: text(source.status, 'draft'),
    createdAt,
    updatedAt: text(source.updatedAt, createdAt),
    owner: personSnapshot(source.owner, createdBy),
    collaborators: personList(source.collaborators || source.collaboratorUsernames),
    dueAt: text(source.dueAt, null),
    createdBy,
    updatedBy: personSnapshot(source.updatedBy, createdBy),
    run: source.run && typeof source.run === 'object'
      ? {
          id: source.run.id || null,
          status: source.run.status || 'not_started',
          mode: source.run.mode || 'local_test',
          startedAt: source.run.startedAt || null,
          completedAt: source.run.completedAt || null,
          lastAction: source.run.lastAction || null,
          pausedFrom: source.run.pausedFrom || null,
          pausedNodeId: source.run.pausedNodeId || null,
          workflowVersion: source.run.workflowVersion || text(source.workflowVersion, CONTENT_WORKFLOW_VERSION),
          inputRefs: source.run.inputRefs ?? null,
          outputRefs: source.run.outputRefs ?? null,
          sensitive: source.run.sensitive === true,
          permissions: list(source.run.permissions),
          toolVersion: text(source.run.toolVersion, null),
          modelVersion: text(source.run.modelVersion, null),
          promptVersion: text(source.run.promptVersion, null),
          connectorVersion: text(source.run.connectorVersion, null),
          environmentVersion: text(source.run.environmentVersion, null),
          confirmation: objectOrNull(source.run.confirmation),
        }
      : {
          id: null,
          status: 'not_started',
          mode: 'local_test',
          startedAt: null,
          completedAt: null,
          lastAction: null,
          pausedFrom: null,
          pausedNodeId: null,
          workflowVersion: text(source.workflowVersion, CONTENT_WORKFLOW_VERSION),
          inputRefs: null,
          outputRefs: null,
          sensitive: false,
          permissions: [],
          toolVersion: null,
          modelVersion: null,
          promptVersion: null,
          connectorVersion: null,
          environmentVersion: null,
          confirmation: null,
        },
    nodes,
    reviews: Array.isArray(source.reviews) ? source.reviews : [],
    versions: Array.isArray(source.versions) ? source.versions : [],
  };
}

export function createContentTask(input, actor, options = {}) {
  const timestamp = options.now || nowIso();
  const id = text(options.id);
  const title = text(input?.title);
  if (!id) {
    throw new Error('内容任务 ID 不能为空');
  }
  if (!title) {
    throw new Error('内容任务名称不能为空');
  }
  if (title.length > 120) {
    throw new Error('内容任务名称不能超过 120 个字');
  }
  const task = normalizeContentTask(
    {
      id,
      title,
      owner: actorSnapshot(actor),
      collaborators: personList(input?.collaborators || input?.collaboratorUsernames),
      dueAt: text(input?.dueAt, null),
      customerId: text(input?.customerId, null),
      brandProfileId: text(input?.brandProfileId, null),
      objective: text(input?.objective),
      audience: text(input?.audience),
      platforms: list(input?.platforms),
      sourceBrief: text(input?.sourceBrief),
      sourceAssets: list(input?.sourceAssets),
      tenantId: text(options.tenantId, 'tenant_local'),
      projectId: text(options.projectId, 'project_content_editor'),
      status: 'draft',
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: actorSnapshot(actor),
      updatedBy: actorSnapshot(actor),
    },
    { now: timestamp },
  );
  task.nodes[0].status = 'ready';
  task.nodes[0].input = {
    taskId: task.id,
    createdBy: task.createdBy,
  };
  return task;
}

export function updateContentTask(task, patch, actor, options = {}) {
  const current = normalizeContentTask(task, options);
  if (!EDITABLE_STATUSES.has(current.status)) {
    throw new Error('当前状态不可编辑，请先退回修改或创建新任务');
  }
  const next = normalizeContentTask(
    {
      ...current,
      title: Object.prototype.hasOwnProperty.call(patch || {}, 'title') ? text(patch.title) : current.title,
      objective: Object.prototype.hasOwnProperty.call(patch || {}, 'objective') ? text(patch.objective) : current.objective,
      audience: Object.prototype.hasOwnProperty.call(patch || {}, 'audience') ? text(patch.audience) : current.audience,
      platforms: Object.prototype.hasOwnProperty.call(patch || {}, 'platforms') ? list(patch.platforms) : current.platforms,
      sourceBrief: Object.prototype.hasOwnProperty.call(patch || {}, 'sourceBrief') ? text(patch.sourceBrief) : current.sourceBrief,
      sourceAssets: Object.prototype.hasOwnProperty.call(patch || {}, 'sourceAssets') ? list(patch.sourceAssets) : current.sourceAssets,
      updatedAt: options.now || nowIso(),
      updatedBy: actorSnapshot(actor),
    },
    options,
  );
  if (!next.title) {
    throw new Error('内容任务名称不能为空');
  }
  return next;
}

export function startContentTask(task, actor, options = {}) {
  const timestamp = options.now || nowIso();
  const current = normalizeContentTask(task, { now: timestamp });
  if (!['draft', 'changes_requested'].includes(current.status)) {
    throw new Error('当前状态不可启动工作流');
  }
  current.status = 'queued';
  current.updatedAt = timestamp;
  current.updatedBy = actorSnapshot(actor);
  current.run = {
    id: text(options.runId),
    status: 'queued',
    mode: options.mode || 'local_test',
    startedAt: timestamp,
    completedAt: null,
    lastAction: '工作流已创建，等待节点执行',
    workflowVersion: current.workflowVersion,
    inputRefs: { taskId: current.id, sourceAssets: current.sourceAssets },
    outputRefs: null,
    sensitive: options.sensitive === true,
    permissions: list(options.permissions),
    toolVersion: text(options.toolVersion, null),
    modelVersion: text(options.modelVersion, null),
    promptVersion: text(options.promptVersion, null),
    connectorVersion: text(options.connectorVersion, null),
    environmentVersion: text(options.environmentVersion, null),
    confirmation: objectOrNull(options.confirmation),
  };
  current.nodes[0] = {
    ...current.nodes[0],
    status: 'succeeded',
    output: { taskId: current.id, workflowVersion: current.workflowVersion },
    completedAt: timestamp,
    updatedAt: timestamp,
    trace: buildNodeExecutionTrace(
      { ...current.nodes[0], startedAt: timestamp, attempts: 0 },
      current,
      {
        input: current.nodes[0].input,
        output: current.nodes[0].output,
        execution: {
          inputRefs: [current.id],
          outputRefs: [current.id],
          toolVersion: options.toolVersion,
          modelVersion: options.modelVersion,
          promptVersion: options.promptVersion,
          connectorVersion: options.connectorVersion,
          environmentVersion: options.environmentVersion,
          sensitive: options.sensitive,
          permissions: options.permissions,
          confirmation: options.confirmation,
        },
      },
      'succeeded',
      actor,
      timestamp,
    ),
    evidence: [
      ...current.nodes[0].evidence,
      {
        type: 'system_event',
        action: 'workflow_started',
        actor: actorSnapshot(actor),
        createdAt: timestamp,
      },
    ],
  };
  if (current.nodes[1]?.status === 'pending') {
    current.nodes[1].status = 'ready';
    current.nodes[1].updatedAt = timestamp;
  }
  return current;
}

export function recordContentNode(task, nodeId, input, actor, options = {}) {
  const timestamp = options.now || nowIso();
  const current = normalizeContentTask(task, { now: timestamp });
  const node = current.nodes.find((item) => item.id === nodeId);
  if (!node) {
    throw new Error('工作流节点不存在');
  }
  if (!['ready', 'running', 'waiting_review'].includes(node.status)) {
    throw new Error('节点尚未到达可登记状态');
  }
  const status = text(input?.status);
  if (!['succeeded', 'failed', 'blocked', 'skipped'].includes(status)) {
    throw new Error('节点结果状态不正确');
  }
  if (status === 'succeeded' && input?.output === undefined) {
    throw new Error('节点成功时必须记录输出');
  }
  node.status = status;
  node.input = input?.input ?? node.input;
  node.output = input?.output ?? null;
  node.error = status === 'succeeded' ? null : text(input?.error, '节点未完成');
  node.completedAt = timestamp;
  node.updatedAt = timestamp;
  node.trace = buildNodeExecutionTrace(node, current, input, status, actor, timestamp);
  node.evidence = [
    ...node.evidence,
    {
      type: 'manual_test_record',
      actor: actorSnapshot(actor),
      note: text(input?.note),
      createdAt: timestamp,
    },
  ];
  const next = current.nodes.find((item) => item.order === node.order + 1);
  if (['succeeded', 'skipped'].includes(status) && next && next.status === 'pending') {
    next.status = 'ready';
    next.updatedAt = timestamp;
  }
  current.status = ['succeeded', 'skipped'].includes(status)
    ? node.humanGate
      ? 'waiting_review'
      : 'running'
    : status === 'blocked'
      ? 'blocked'
      : 'failed';
  current.updatedAt = timestamp;
  current.updatedBy = actorSnapshot(actor);
  current.run = {
    ...current.run,
    status: ['succeeded', 'skipped'].includes(status) ? 'running' : status,
    lastAction: node.label + '：' + status,
  };
  return current;
}

export function retryContentNode(task, nodeId, actor, options = {}) {
  const timestamp = options.now || nowIso();
  const current = normalizeContentTask(task, { now: timestamp });
  const node = current.nodes.find((item) => item.id === nodeId);
  if (!node) {
    throw new Error('工作流节点不存在');
  }
  if (current.run.status === 'not_started') {
    throw new Error('请先启动内容工作流');
  }
  if (!['failed', 'blocked'].includes(node.status)) {
    throw new Error('只有失败或阻塞节点可以重试');
  }
  const previousError = node.error;
  node.status = 'ready';
  node.attempts = (Number.isInteger(node.attempts) ? node.attempts : 0) + 1;
  node.input = null;
  node.output = null;
  node.error = null;
  node.startedAt = null;
  node.completedAt = null;
  node.updatedAt = timestamp;
  node.trace = buildNodeExecutionTrace(
    node,
    current,
    { execution: { humanAction: '请求重试' } },
    'ready',
    actor,
    timestamp,
  );
  node.evidence = [
    ...node.evidence,
    {
      type: 'retry_requested',
      actor: actorSnapshot(actor),
      attempt: node.attempts,
      previousError,
      createdAt: timestamp,
    },
  ];
  current.status = 'running';
  current.updatedAt = timestamp;
  current.updatedBy = actorSnapshot(actor);
  current.run = {
    ...current.run,
    status: 'retrying',
    pausedFrom: null,
    pausedNodeId: null,
    lastAction: node.label + '：已请求第 ' + node.attempts + ' 次重试',
  };
  return current;
}

export function pauseContentTask(task, actor, options = {}) {
  const timestamp = options.now || nowIso();
  const current = normalizeContentTask(task, { now: timestamp });
  if (current.run.status === 'not_started') {
    throw new Error('请先启动内容工作流');
  }
  if (current.run.status === 'paused') {
    throw new Error('内容工作流已经暂停');
  }
  if (['succeeded', 'failed', 'cancelled'].includes(current.run.status) || ['approved', 'rejected', 'completed'].includes(current.status)) {
    throw new Error('当前状态不能暂停内容工作流');
  }
  const pausedNode = current.nodes.find((node) => ['running', 'ready', 'waiting_review'].includes(node.status));
  const previousStatus = current.status;
  if (pausedNode?.status === 'running') {
    pausedNode.status = 'ready';
    pausedNode.updatedAt = timestamp;
    pausedNode.evidence = [
      ...pausedNode.evidence,
      { type: 'run_paused', actor: actorSnapshot(actor), createdAt: timestamp },
    ];
  } else if (pausedNode) {
    pausedNode.evidence = [
      ...pausedNode.evidence,
      { type: 'run_paused', actor: actorSnapshot(actor), createdAt: timestamp },
    ];
    pausedNode.updatedAt = timestamp;
  }
  if (pausedNode) {
    pausedNode.trace = buildNodeExecutionTrace(
      pausedNode,
      current,
      { execution: { humanAction: '暂停运行' } },
      pausedNode.status,
      actor,
      timestamp,
    );
  }
  current.status = 'paused';
  current.updatedAt = timestamp;
  current.updatedBy = actorSnapshot(actor);
  current.run = {
    ...current.run,
    status: 'paused',
    pausedFrom: previousStatus,
    pausedNodeId: pausedNode?.id || null,
    lastAction: '工作流已暂停' + (pausedNode ? '，等待从 ' + pausedNode.id + ' 继续' : ''),
  };
  return current;
}

export function resumeContentTask(task, actor, options = {}) {
  const timestamp = options.now || nowIso();
  const current = normalizeContentTask(task, { now: timestamp });
  if (current.run.status !== 'paused' || current.status !== 'paused') {
    throw new Error('只有已暂停的内容工作流可以继续');
  }
  const pausedNode = current.run.pausedNodeId
    ? current.nodes.find((node) => node.id === current.run.pausedNodeId)
    : current.nodes.find((node) => ['ready', 'running', 'waiting_review'].includes(node.status));
  if (pausedNode?.status === 'running') {
    pausedNode.status = 'ready';
    pausedNode.updatedAt = timestamp;
  }
  const previousStatus = current.run.pausedFrom;
  current.status = previousStatus === 'waiting_review' || previousStatus === 'changes_requested'
    ? previousStatus
    : 'running';
  current.updatedAt = timestamp;
  current.updatedBy = actorSnapshot(actor);
  current.run = {
    ...current.run,
    status: 'running',
    pausedFrom: null,
    pausedNodeId: null,
    lastAction: '工作流已继续' + (pausedNode ? '，从 ' + pausedNode.id + ' 开始' : ''),
  };
  if (pausedNode) {
    pausedNode.trace = buildNodeExecutionTrace(
      pausedNode,
      current,
      { execution: { humanAction: '继续运行' } },
      pausedNode.status,
      actor,
      timestamp,
    );
    pausedNode.evidence = [
      ...pausedNode.evidence,
      { type: 'run_resumed', actor: actorSnapshot(actor), createdAt: timestamp },
    ];
    pausedNode.updatedAt = timestamp;
  }
  return current;
}

export function addContentReview(task, input, actor, options = {}) {
  const timestamp = options.now || nowIso();
  const current = normalizeContentTask(task, { now: timestamp });
  if (current.run.status === 'not_started') {
    throw new Error('请先启动内容工作流，再登记审核');
  }
  const decision = text(input?.decision);
  if (!['approved', 'changes_requested', 'rejected'].includes(decision)) {
    throw new Error('审核决定不正确');
  }
  const reviewChecklistNode = current.nodes.find((node) => node.id === 'CE-19');
  const reviewSubmitNode = current.nodes.find((node) => node.id === 'CE-20');
  const revisionNode = current.nodes.find((node) => node.id === 'CE-21');
  const latestReview = current.reviews.at(-1) || null;
  const isFirstReview = current.reviews.length === 0;
  const reviewSubmissionReady = reviewChecklistNode?.status === 'succeeded' &&
    ['ready', 'waiting_review'].includes(reviewSubmitNode?.status);
  const revisionReviewReady = current.status === 'waiting_review' &&
    revisionNode?.status === 'succeeded' &&
    latestReview?.decision === 'changes_requested';
  if (isFirstReview && !reviewSubmissionReady) {
    throw new Error('请先完成 CE-19 审核单，再提交审核意见');
  }
  if (!isFirstReview && !revisionReviewReady) {
    throw new Error('退回修改后请先完成 CE-21 新版本，再提交复审意见');
  }
  const review = {
    id: text(options.reviewId),
    decision,
    note: text(input?.note),
    createdAt: timestamp,
    createdBy: actorSnapshot(actor),
  };
  if (!review.id) {
    throw new Error('审核记录 ID 不能为空');
  }
  current.reviews = [...current.reviews, review];
  current.status = decision === 'approved' ? 'approved' : decision;
  current.updatedAt = timestamp;
  current.updatedBy = actorSnapshot(actor);
  current.nodes = current.nodes.map((node) =>
    node.id === 'CE-20'
      ? {
          ...node,
          status: 'succeeded',
          output: review,
          completedAt: timestamp,
          updatedAt: timestamp,
          trace: buildNodeExecutionTrace(
            { ...node, startedAt: node.startedAt || timestamp },
            current,
            {
              input: { decision },
              output: review,
              execution: {
                inputRefs: [current.id],
                outputRefs: [review.id],
                humanAction: '人工审核：' + decision,
                confirmation: {
                  confirmedBy: review.createdBy.username,
                  confirmedAt: timestamp,
                  decision,
                  note: review.note,
                },
              },
            },
            'succeeded',
            actor,
            timestamp,
          ),
          evidence: [
            ...node.evidence,
            { type: 'review', reviewId: review.id, actor: review.createdBy, createdAt: timestamp },
          ],
        }
      : node,
  );
  const deliveryNode = current.nodes.find((node) => node.id === 'CE-22');
  if (decision === 'changes_requested' && revisionNode?.status === 'pending') {
    revisionNode.status = 'ready';
    revisionNode.updatedAt = timestamp;
  }
  if (decision === 'approved' && revisionNode?.status === 'ready') {
    throw new Error('请先应用修改并生成新版本，再提交审核通过');
  }
  if (decision === 'approved' && revisionNode?.status === 'pending') {
    revisionNode.status = 'skipped';
    revisionNode.output = { status: 'not_required', reason: '审核通过，无需修改版本' };
    revisionNode.completedAt = timestamp;
    revisionNode.updatedAt = timestamp;
    revisionNode.evidence = [
      ...revisionNode.evidence,
      { type: 'workflow_skip', reason: 'review_approved', actor: actorSnapshot(actor), createdAt: timestamp },
    ];
  }
  if (decision === 'approved' && deliveryNode?.status === 'pending') {
    deliveryNode.status = 'ready';
    deliveryNode.updatedAt = timestamp;
  }
  return current;
}

export function applyContentRevision(task, input, actor, options = {}) {
  const timestamp = options.now || nowIso();
  const current = normalizeContentTask(task, { now: timestamp });
  if (current.status !== 'changes_requested') {
    throw new Error('只有退回修改的内容任务才能生成新版本');
  }
  const changes = text(input?.changes);
  const content = input?.content && typeof input.content === 'object'
    ? input.content
    : text(input?.text)
      ? { text: text(input.text) }
      : null;
  if (!changes && !content) {
    throw new Error('请填写修改内容或修改说明');
  }
  const revisionNode = current.nodes.find((node) => node.id === 'CE-21');
  if (revisionNode?.status === 'pending') {
    const reviewNode = current.nodes.find((node) => node.id === 'CE-20');
    if (reviewNode?.status === 'succeeded') {
      revisionNode.status = 'ready';
      revisionNode.updatedAt = timestamp;
    }
  }
  if (!revisionNode || !['ready', 'running', 'waiting_review'].includes(revisionNode.status)) {
    throw new Error('修改节点尚未就绪，请先提交退回修改的审核意见');
  }
  const previousVersion = current.versions.at(-1) || null;
  const version = {
    id: text(options.versionId, 'content_version_' + timestamp.replace(/[^0-9]/g, '').slice(-18)),
    number: current.versions.length + 1,
    basedOn: previousVersion?.id || null,
    changes,
    content,
    createdAt: timestamp,
    createdBy: actorSnapshot(actor),
    status: 'draft',
  };
  const revised = recordContentNode(
    current,
    'CE-21',
    {
      status: 'succeeded',
      input: { changes, basedOnVersion: version.basedOn },
      output: version,
      note: '已保留旧版本并登记人工修改后的新版本，等待重新审核',
    },
    actor,
    { now: timestamp },
  );
  revised.versions = [...revised.versions, version];
  revised.status = 'waiting_review';
  revised.updatedAt = timestamp;
  revised.updatedBy = actorSnapshot(actor);
  revised.run = {
    ...revised.run,
    status: 'running',
    lastAction: '已生成第 ' + version.number + ' 个内容版本，等待重新审核',
  };
  return revised;
}

export function contentTaskSummary(task) {
  const current = normalizeContentTask(task);
  const completedNodes = current.nodes.filter((node) => ['succeeded', 'skipped'].includes(node.status)).length;
  const failedNodes = current.nodes.filter((node) => ['failed', 'blocked'].includes(node.status)).length;
  const nextNode = current.nodes.find((node) => ['ready', 'running', 'waiting_review'].includes(node.status));
  return {
    id: current.id,
    title: current.title,
    role: current.role,
    status: current.status,
    workflowVersion: current.workflowVersion,
    owner: current.owner,
    collaborators: current.collaborators,
    dueAt: current.dueAt,
    reviewStatus: current.reviews.at(-1)?.decision || (current.status === 'waiting_review' ? 'pending' : null),
    error: current.nodes.find((node) => ['failed', 'blocked'].includes(node.status))?.error || null,
    platformCount: current.platforms.length,
    completedNodes,
    totalNodes: current.nodes.length,
    failedNodes,
    nextNode: nextNode ? { id: nextNode.id, label: nextNode.label, status: nextNode.status } : null,
    updatedAt: current.updatedAt,
    createdAt: current.createdAt,
  };
}

export function buildContentRunReplay(task, events = []) {
  const current = normalizeContentTask(task);
  const runId = current.run?.id || null;
  const orderedEvents = (Array.isArray(events) ? events : [])
    .filter((event) => !runId || !event?.runId || event.runId === runId)
    .map((event, index) => ({
      ...event,
      sequence: Number.isInteger(event?.sequence) ? event.sequence : index + 1,
      taskSnapshot: event?.taskSnapshot
        ? normalizeContentTask(event.taskSnapshot)
        : event?.data?.taskSnapshot
          ? normalizeContentTask(event.data.taskSnapshot)
          : null,
    }))
    .sort((left, right) => left.sequence - right.sequence || String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || String(left.id || '').localeCompare(String(right.id || '')));
  return {
    taskId: current.id,
    runId,
    workflowVersion: current.workflowVersion,
    status: current.run?.status || 'not_started',
    events: orderedEvents,
    final: contentTaskSummary(current),
    complete: orderedEvents.length > 0 && orderedEvents.every((event) => event.taskSnapshot),
    missingSnapshotCount: orderedEvents.filter((event) => !event.taskSnapshot).length,
  };
}
