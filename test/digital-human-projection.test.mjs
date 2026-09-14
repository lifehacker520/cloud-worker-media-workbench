/**
 * CE-DH-F5-02｜最小数据读取和状态投影
 *
 * 本测试只验证投影层本身（src/digital-human-projection.mjs）：
 *   - 一个单轴 item.status 如何拆成 生成 / 审核 / 交付 三轴；
 *   - allowed_actions、blocking_issues、next_action 如何从状态推导；
 *   - 投影永远是只读派生，不修改输入、不产生第二套批次真相。
 *
 * 它不启动服务，也不代替浏览器验收。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DH_DELIVERY_AXIS_WIRED,
  projectAssetCatalog,
  projectAssetOption,
  projectBatchItem,
  projectCenterSummary,
  projectContextStage,
  projectDigitalHumanProfiles,
  projectModeBStage,
  projectCopyCandidate,
  projectCopyCandidates,
  projectPackageView,
  projectProductionTask,
  projectResultBoard,
  projectTaskWorkspace,
  preflightGate,
  summarizeCopyText,
} from '../src/digital-human-projection.mjs';

test('6.7 生成轴：现有单轴 status 被如实拆解，而不是被改写', () => {
  const cases = [
    ['planned', 'planned'],
    ['queued', 'queued'],
    ['running', 'running'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
    ['blocked', 'blocked'],
    ['cancelled', 'cancelled'],
    /* approved / changes_requested 意味着“曾经生成成功，当前输出是那次生成的结果”。 */
    ['approved', 'succeeded'],
    ['changes_requested', 'succeeded'],
  ];
  for (const [status, expected] of cases) {
    const item = projectBatchItem({ id: 'i', status });
    assert.equal(item.generationStatus, expected, 'status=' + status);
  }
});

test('6.7 审核轴：review 记录是权威来源，其次才回退到单轴 status', () => {
  assert.equal(projectBatchItem({ status: 'succeeded', review: { decision: 'approved' } }).reviewStatus, 'approved');
  assert.equal(
    projectBatchItem({ status: 'approved', review: { decision: 'changes_requested' } }).reviewStatus,
    'changes_requested',
    'review 记录必须覆盖旧的单轴 status',
  );
  assert.equal(projectBatchItem({ status: 'succeeded' }).reviewStatus, 'waiting_review');
  assert.equal(projectBatchItem({ status: 'planned' }).reviewStatus, 'not_ready');
  assert.equal(projectBatchItem({ status: 'failed' }).reviewStatus, 'not_ready');
});

test('6.7 交付轴：现有数据里没有交付事实，只能如实报 not_selected 且明确标注未接入', () => {
  const item = projectBatchItem({ status: 'approved', review: { decision: 'approved' } });
  assert.equal(item.deliveryStatus, 'not_selected');
  assert.equal(DH_DELIVERY_AXIS_WIRED, false, '交付轴未接入必须在模块里显式声明，不能假装已经接了');
});

test('7.1 allowed_actions：生成成功且待审核 → 只允许验收或退回', () => {
  const item = projectBatchItem({
    status: 'succeeded',
    output: { verificationStatus: 'verified', playable: true },
  });
  assert.deepEqual(item.allowedActions, ['review_item', 'request_changes']);
  assert.deepEqual(item.blockingIssues, []);
});

test('7.1 allowed_actions：可重试失败 → 允许重试，且阻塞项带事实', () => {
  const item = projectBatchItem({
    status: 'failed',
    error: { code: 'TTS_TIMEOUT', message: '语音生成超时', retryable: true },
  });
  assert.deepEqual(item.allowedActions, ['retry_item']);
  assert.equal(item.blockingIssues.length, 1);
  assert.equal(item.blockingIssues[0].code, 'TTS_TIMEOUT');
  assert.equal(item.blockingIssues[0].retryable, true);
});

test('7.1 allowed_actions：不可重试失败 → 不允许自动重试', () => {
  const item = projectBatchItem({
    status: 'failed',
    error: { code: 'AUTH_MISSING', message: '授权缺失', retryable: false },
  });
  assert.deepEqual(item.allowedActions, ['regenerate_item']);
});

test('产品规则：模拟输出只能用于验证队列和状态，不能审核通过或计入交付', () => {
  const item = projectBatchItem({
    status: 'succeeded',
    output: { simulated: true, verificationStatus: 'verified', playable: true },
  });
  assert.deepEqual(item.allowedActions, []);
  assert.equal(item.blockingIssues.some((issue) => issue.code === 'OUTPUT_SIMULATED'), true);
});

test('7.1 allowed_actions：approved 且输出可播 → 允许进入内容包（F5-07）', () => {
  const item = projectBatchItem({
    status: 'approved',
    review: { decision: 'approved' },
    output: { verificationStatus: 'verified', playable: true },
  });
  assert.deepEqual(item.allowedActions, ['select_for_package']);
});

test('next_action 优先级：阻塞 > 可重试失败 > 待验收 > 需重新生成 > 可导出 > 继续配置', () => {
  const build = (items) => projectProductionTask({ id: 'b', items }).nextAction;
  assert.equal(build([{ status: 'blocked' }, { status: 'succeeded' }]), 'fix_blockers');
  assert.equal(build([{ status: 'failed', error: { retryable: true } }, { status: 'succeeded' }]), 'retry_failed_items');
  assert.equal(build([{ status: 'succeeded' }, { status: 'approved' }]), 'review_pending_items');
  assert.equal(build([{ status: 'changes_requested' }, { status: 'approved' }]), 'regenerate_items');
  /* 5.10：只有“approved + 输出可播”才允许导出；approved 但没有可播输出不能算可导出。 */
  assert.equal(build([{ status: 'approved' }]), 'nothing_pending');
  assert.equal(
    build([{ status: 'approved', review: { decision: 'approved' }, output: { verificationStatus: 'verified', playable: true } }]),
    'export_approved',
  );
  assert.equal(build([{ status: 'planned' }, { status: 'planned' }]), 'configure_items');
});

test('6.6 任务五组状态由明细计算，不允许手工写', () => {
  const task = projectProductionTask({
    id: 'b1',
    status: 'running',
    planCount: 3,
    items: [
      { id: 'a', status: 'approved', review: { decision: 'approved' }, output: { playable: true } },
      { id: 'b', status: 'succeeded' },
      { id: 'c', status: 'running' },
    ],
  });
  assert.equal(task.lifecycleStatus, 'ready');
  assert.equal(task.executionStatus, 'running');
  /* 6.6：partial 指“部分通过、部分需修改或驳回”；只有全部待审且无人判过才是 waiting。 */
  assert.equal(task.reviewSummary, 'partial');
  assert.equal(task.deliverySummary, 'not_started');
  assert.equal(task.itemCount, 3);
  assert.equal(task.axes.generation.succeeded, 2);
  assert.equal(task.axes.review.approved, 1);
  assert.equal(task.axes.review.waiting_review, 1);
  assert.equal(task.axes.delivery.not_selected, 3);
});

test('6.6 执行轴：有产出且没有在途条目时不得显示“未开始”', () => {
  const build = (status, items) => projectProductionTask({ id: 'b', status, items }).executionStatus;
  assert.equal(build('running', [{ status: 'running' }]), 'running');
  assert.equal(build('waiting_review', [{ status: 'planned' }, { status: 'succeeded' }]), 'queued');
  /* 2 条成功 + 1 失败 + 1 阻塞：本轮执行已经结束，结果是混合的。 */
  assert.equal(
    build('waiting_review', [{ status: 'approved' }, { status: 'succeeded' }, { status: 'failed', error: { retryable: true } }, { status: 'blocked' }]),
    'completed_with_results',
  );
  /* 全部失败 → failed */
  assert.equal(build('waiting_review', [{ status: 'failed', error: { retryable: false } }]), 'failed');
  /* 还没动过 → not_started */
  assert.equal(build('draft', [{ status: 'planned' }]), 'not_started');
});

test('投影是只读派生：不修改输入对象（不产生第二套批次真相）', () => {
  const batch = {
    id: 'b',
    taskId: 't',
    projectId: 'p',
    title: 'x',
    status: 'waiting_review',
    items: [{ id: 'a', status: 'succeeded' }],
  };
  const snapshot = JSON.stringify(batch);
  projectProductionTask(batch);
  assert.equal(JSON.stringify(batch), snapshot, 'projectProductionTask 不得改写输入 batch');
});

test('真实数据为空时：计数全 0、不伪造任务、下一步指向准备资产', () => {
  const summary = projectCenterSummary({
    batches: [],
    tasks: [],
    catalog: {
      project: { id: 'p', name: '内容编辑云员工', status: 'active' },
      avatars: [],
      voices: [],
      scripts: [],
      templates: [{ id: 't1' }],
      connectors: [],
    },
    readAt: '2026-09-11T00:00:00.000Z',
  });
  assert.equal(summary.counts.pendingConfigure, 0);
  assert.equal(summary.counts.waitingReview, 0);
  assert.equal(summary.tasks.length, 0, '不得用示例任务填充空数据');
  assert.equal(summary.nextAction, 'prepare_assets');
  assert.deepEqual(
    summary.assetGaps.map((gap) => gap.code),
    ['NO_AVATAR_VERSION', 'NO_VOICE_VERSION', 'NO_SCRIPT_VERSION', 'NO_READY_CONNECTOR'],
  );
  assert.equal(summary.source.batchCount, 0);
  assert.equal(summary.source.real, true);
  assert.deepEqual(summary.source.endpoints, [
    '/api/content/batches',
    '/api/content/tasks',
    '/api/content/batches/catalog',
  ]);
});

test('P01 摘要里的每个数字都能反查到真实来源', () => {
  const summary = projectCenterSummary({
    batches: [{
      id: 'batch_1',
      taskId: 'content_task_1',
      projectId: 'project_content_editor',
      title: '入职手机口播',
      status: 'waiting_review',
      planCount: 2,
      items: [
        { id: 'i1', status: 'approved', review: { decision: 'approved' }, output: { playable: true } },
        { id: 'i2', status: 'succeeded' },
      ],
    }],
    tasks: [{ id: 'content_task_1', title: '参考任务', status: 'paused', role: '内容编辑云员工', projectId: 'project_content_editor', completedNodes: 1, totalNodes: 26 }],
    catalog: {
      project: { id: 'project_content_editor', name: '内容编辑云员工' },
      avatars: [{ id: 'a' }],
      voices: [{ id: 'v' }],
      scripts: [{ id: 's' }],
      templates: [{ id: 't' }],
      connectors: [{ id: 'c', status: 'simulation', capabilities: ['talking_head'] }],
    },
  });
  /* 摘要计数 = 各任务明细计数之和 */
  const totalItems = summary.tasks.reduce((sum, item) => sum + item.itemCount, 0);
  assert.equal(
    summary.counts.pendingConfigure + summary.counts.generating + summary.counts.waitingReview +
      summary.counts.needsChanges + summary.counts.failedRetryable + summary.counts.blocked +
      summary.counts.approvedExportable,
    totalItems,
    '各分类计数之和必须等于明细总数，不能出现多算或漏算',
  );
  assert.equal(summary.tasks[0].parentContentTaskId, 'content_task_1');
  assert.equal(summary.project.id, 'project_content_editor');
  assert.equal(summary.assets.productionReadyConnectors, 1);
  assert.deepEqual(summary.assetGaps, [], '资产齐全时不得虚构阻塞项');
});

/* ---------------------------------------------------------------------------
   F5-03：P02 项目与文案
   --------------------------------------------------------------------------- */

test('F5-03 只有 confirmed（approved + 有正文）的文案可以进入生产任务', () => {
  const confirmed = projectCopyCandidate({ id: 'c1', title: 'A 版', status: 'approved', text: '正文内容' });
  assert.equal(confirmed.confirmed, true);
  assert.deepEqual(confirmed.allowedActions, ['select_copy']);
  assert.deepEqual(confirmed.blockingIssues, []);

  const draftOnly = projectCopyCandidate({ id: 'c2', title: 'B 版', status: 'draft', text: '正文内容' });
  assert.equal(draftOnly.confirmed, false);
  assert.deepEqual(draftOnly.allowedActions, []);
  assert.equal(draftOnly.blockingIssues[0].code, 'COPY_VERSION_NOT_CONFIRMED');

  const approvedButEmpty = projectCopyCandidate({ id: 'c3', title: 'C 版', status: 'approved', text: '   ' });
  assert.equal(approvedButEmpty.confirmed, false);
  assert.equal(approvedButEmpty.blockingIssues[0].code, 'COPY_VERSION_EMPTY');
});

test('F5-03 长文本默认摘要，不一次性铺开（10.2 第 4 条）', () => {
  const long = '这是一条很长很长的口播文案。'.repeat(30);
  const result = summarizeCopyText(long, 120);
  assert.equal(result.truncated, true);
  assert.equal(result.summary.length, 121, '120 字 + 省略号');
  assert.ok(result.summary.endsWith('…'));
  assert.equal(result.textLength, long.length, '全文长度必须保留，不能因为摘要丢失事实');
  const short = summarizeCopyText('短文案', 120);
  assert.equal(short.truncated, false);
  assert.equal(short.summary, '短文案');
});

test('F5-03 候选为空或全未确认时，必须阻塞并给出下一步', () => {
  const empty = projectCopyCandidates([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.blockingIssues[0].code, 'NO_SCRIPT_VERSION');
  assert.equal(empty.nextAction, 'prepare_copy');

  const allDraft = projectCopyCandidates([{ id: 'a', status: 'draft', text: 'x' }]);
  assert.equal(allDraft.confirmedCount, 0);
  assert.equal(allDraft.blockingIssues[0].code, 'NO_CONFIRMED_SCRIPT_VERSION');
  assert.equal(allDraft.nextAction, 'confirm_copy');

  const mixed = projectCopyCandidates([
    { id: 'a', status: 'draft', text: 'x' },
    { id: 'b', status: 'approved', text: 'y' },
  ]);
  assert.equal(mixed.confirmedCount, 1);
  assert.deepEqual(mixed.blockingIssues, []);
  assert.equal(mixed.nextAction, 'select_copy');
});

test('F5-03 选入草稿的文案必须是 confirmed 版本，否则要阻塞', () => {
  const ok = projectCopyCandidates([{ id: 'a', status: 'approved', text: 'x' }], 'a');
  assert.equal(ok.selectedScriptVersionId, 'a');
  assert.deepEqual(ok.blockingIssues, []);

  const notConfirmed = projectCopyCandidates([{ id: 'a', status: 'draft', text: 'x' }], 'a');
  assert.equal(notConfirmed.selectedScriptVersionId, null, '未确认版本不能被记为已选');
  assert.equal(notConfirmed.blockingIssues.some((issue) => issue.code === 'SELECTED_COPY_NOT_CONFIRMED'), true);

  const missing = projectCopyCandidates([{ id: 'a', status: 'approved', text: 'x' }], 'ghost');
  assert.equal(missing.selectedScriptVersionId, null);
  assert.equal(missing.blockingIssues.some((issue) => issue.code === 'SELECTED_COPY_VERSION_MISSING'), true);
});

/* ---------------------------------------------------------------------------
   F5-04：生产资产投影
   --------------------------------------------------------------------------- */

test('F5-04 只有 approved + batchAllowed 的资产可用于批量生产', () => {
  const m = projectAssetCatalog({
    project: { id: 'p', name: 'x' },
    avatars: [
      { id: 'a1', displayName: '可用形象', version: 1, status: 'approved', batchAllowed: true, canonicalImageRef: 'x' },
      { id: 'a2', displayName: '未审核', version: 1, status: 'draft', batchAllowed: true, canonicalImageRef: 'x' },
      { id: 'a3', displayName: '未开批量', version: 1, status: 'approved', batchAllowed: false, canonicalImageRef: 'x' },
    ],
    voices: [],
    templates: [],
  }, null);
  assert.equal(m.modeA.avatars.total, 3);
  assert.equal(m.modeA.avatars.usable, 1, '只有 approved+batchAllowed 可用');
  assert.equal(m.modeA.voices.usable, 0);
  assert.equal(m.modeA.ready, false);
  assert.equal(m.blockingIssues.some((issue) => issue.code === 'NO_USABLE_VOICE'), true);
  assert.equal(m.nextAction, 'prepare_assets');
});

test('F5-04 模式 B 未接入必须显式标注，不能用空列表冒充结论', () => {
  const m = projectAssetCatalog({ project: { id: 'p' }, avatars: [], voices: [], templates: [] }, null);
  assert.equal(m.modeB.wired, false);
  assert.equal(m.modeB.sourceVideos.total, 0);
  assert.ok(m.modeB.note.includes('未接入'));
});

test('F5-04 选中的资产必须是可用版本，否则阻塞', () => {
  const base = {
    project: { id: 'p' },
    avatars: [{ id: 'a1', displayName: 'A', version: 1, status: 'approved', batchAllowed: true, canonicalImageRef: 'x' }],
    voices: [{ id: 'v1', displayName: 'V', version: 1, status: 'approved', batchAllowed: true, referenceAudioRef: 'y' }],
    templates: [{ id: 't1', displayName: 'T', version: 1, status: 'approved', batchAllowed: true }],
  };
  const ok = projectAssetCatalog(base, { selectedAvatarVersionId: 'a1', selectedVoiceVersionId: 'v1', selectedTemplateVersionId: 't1' });
  assert.equal(ok.modeA.selectedReady, true);
  assert.deepEqual(ok.blockingIssues, []);
  assert.equal(ok.nextAction, 'nothing_pending');

  const ghost = projectAssetCatalog(base, { selectedAvatarVersionId: 'ghost' });
  assert.equal(ghost.blockingIssues.some((issue) => issue.code === 'SELECTED_ASSET_MISSING'), true);

  const notUsable = projectAssetCatalog(
    { ...base, avatars: [{ id: 'a2', displayName: 'B', version: 1, status: 'draft', batchAllowed: true }] },
    { selectedAvatarVersionId: 'a2' },
  );
  assert.equal(
    notUsable.blockingIssues.some((issue) => issue.code === 'SELECTED_ASSET_NOT_USABLE'),
    true,
    '选中了存在但不可用的版本，要报「不可用」而不是「缺失」',
  );
});

test('F5-04 形象缺标准图、声音缺参考音频时必须给出阻塞项', () => {
  const option = projectAssetOption({ id: 'a9', status: 'approved', batchAllowed: true }, 'avatar');
  assert.equal(option.usable, false);
  assert.equal(option.blockingIssues.some((issue) => issue.code === 'AVATAR_IMAGE_MISSING'), true);
  const voice = projectAssetOption({ id: 'v9', status: 'approved', batchAllowed: true }, 'voice');
  assert.equal(voice.blockingIssues.some((issue) => issue.code === 'VOICE_REFERENCE_MISSING'), true);
});

/* ---------------------------------------------------------------------------
   F5-05：P06 显式明细与 N17 生成前检查
   --------------------------------------------------------------------------- */

const f504Catalog = {
  project: { id: 'p', name: 'x' },
  avatars: [{ id: 'a1', displayName: 'A', version: 1, status: 'approved', batchAllowed: true, canonicalImageRef: 'x' }],
  voices: [{ id: 'v1', displayName: 'V', version: 1, status: 'approved', batchAllowed: true, referenceAudioRef: 'y' }],
  templates: [{ id: 't1', displayName: 'T', version: 1, status: 'approved', batchAllowed: true }],
};

function f504Assets() {
  return projectAssetCatalog(f504Catalog, {
    selectedAvatarVersionId: 'a1',
    selectedVoiceVersionId: 'v1',
    selectedTemplateVersionId: 't1',
  });
}

function f504Copy() {
  return projectCopyCandidates([{ id: 'c1', title: 'A 版', status: 'approved', text: '正文' }], 'c1');
}

test('F5-05 一行显式明细 = 单条生产，所有引用齐备时 N17 通过', () => {
  const ws = projectTaskWorkspace({
    draft: { mode: 'A', title: '口播', plannedItems: [{ mode: 'A', scriptVersionId: 'c1', avatarVersionId: 'a1', voiceVersionId: 'v1', templateVersionId: 't1', outputName: 'row-01' }] },
    copy: f504Copy(),
    assets: f504Assets(),
  });
  assert.equal(ws.rowCount, 1);
  assert.equal(ws.isSingle, true, '1 行就是单条生产，不额外出现单条模式');
  assert.deepEqual(ws.blockingIssues, []);
  assert.equal(ws.nextAction, 'run_preflight');
  assert.equal(preflightGate(ws).success, true);
  assert.equal(preflightGate(ws).allowed_actions.includes('start_execution'), true);
});

test('F5-05 明细行缺引用、文案未确认、命名冲突时必须逐行给出阻塞', () => {
  const ws = projectTaskWorkspace({
    draft: { mode: 'A', plannedItems: [
      { mode: 'A', scriptVersionId: null, avatarVersionId: 'a1', voiceVersionId: 'v1', templateVersionId: 't1', outputName: 'same' },
      { mode: 'A', scriptVersionId: 'c1', avatarVersionId: 'a1', voiceVersionId: 'v1', templateVersionId: 't1', outputName: 'same' },
    ] },
    copy: f504Copy(),
    assets: f504Assets(),
  });
  const codes = ws.blockingIssues.map((issue) => issue.code);
  assert.ok(codes.includes('ROW_COPY_MISSING'), '缺文案要阻塞');
  assert.ok(codes.includes('ROW_OUTPUT_NAME_CONFLICT'), '命名冲突要阻塞（N16）');
  assert.equal(ws.blockingIssues.filter((issue) => issue.code === 'ROW_OUTPUT_NAME_CONFLICT').length, 1, '只报后一行冲突');
  assert.equal(preflightGate(ws).success, false);
  assert.equal(preflightGate(ws).next_action, 'fix_blockers');
});

test('F5-05 禁止隐式 Cartesian：选择隐含组合多于显式行数时阻塞（N15）', () => {
  /* 选择区选了 a1+v1，但明细 0 行 → 缺行阻塞，而不是自动生成 1 行 */
  const empty = projectTaskWorkspace({ draft: { mode: 'A', plannedItems: [] }, copy: f504Copy(), assets: f504Assets() });
  assert.equal(empty.blockingIssues.some((issue) => issue.code === 'NO_PLANNED_ROWS'), true);
  /* 模式 B 行：已有视频未接入 → 必须阻塞，不能装作能生产 */
  const modeB = projectTaskWorkspace({
    draft: { mode: 'B', plannedItems: [{ mode: 'B', scriptVersionId: 'c1', sourceVideoAssetId: 'sv1', outputName: 'b1' }] },
    copy: f504Copy(),
    assets: f504Assets(),
  });
  assert.equal(modeB.blockingIssues.some((issue) => issue.code === 'ROW_MAPPING_NOT_READY'), true, '模式 B 行必须引用完整映射（S6-03 后语义）');
  assert.equal(modeB.executionWired, false);
});

test('F5-05 输出路径按行预览，子目录缺省取任务标题', () => {
  const ws = projectTaskWorkspace({
    draft: { mode: 'A', title: '入职手机口播', plannedItems: [{ mode: 'A', scriptVersionId: 'c1', avatarVersionId: 'a1', voiceVersionId: 'v1', templateVersionId: 't1', outputName: 'row-01' }] },
    copy: f504Copy(),
    assets: f504Assets(),
  });
  assert.equal(ws.rows[0].outputPath, '入职手机口播/row-01.mp4');
  assert.equal(ws.rows[0].blockingIssues.length, 0);
});

test('F5-05 文件名非法字符被拦截（N16）', () => {
  const ws = projectTaskWorkspace({
    draft: { mode: 'A', plannedItems: [{ mode: 'A', scriptVersionId: 'c1', avatarVersionId: 'a1', voiceVersionId: 'v1', templateVersionId: 't1', outputName: 'a/b:c' }] },
    copy: f504Copy(),
    assets: f504Assets(),
  });
  assert.equal(ws.blockingIssues.some((issue) => issue.code === 'ROW_OUTPUT_NAME_INVALID'), true);
});

/* ---------------------------------------------------------------------------
   F5-06/F5-07：结果验收与内容包资格
   --------------------------------------------------------------------------- */

test('F5-06 模拟输出的预览与通过都被诚实拦截', () => {
  const board = projectResultBoard([{ id: 'b', title: 't', status: 'waiting_review', items: [
    { id: 'i1', status: 'succeeded', output: { simulated: true, verificationStatus: 'verified' } },
  ] }]);
  const item = board.tasks[0].items[0];
  assert.equal(item.preview.available, false);
  assert.equal(item.preview.simulated, true);
  assert.equal(item.actions.approve, false, '模拟输出不能被审核通过');
  assert.equal(item.actions.requestChanges, true, '但可以退回修改');
  assert.ok((item.reviewBlockedReason || '').includes('模拟输出'));
});

test('F5-06 非模拟且待验收的结果允许通过/退回，失败可重试', () => {
  const board = projectResultBoard([{ id: 'b', title: 't', status: 'partial_failed', items: [
    { id: 'i1', status: 'succeeded', output: { simulated: false, verificationStatus: 'verified' } },
    { id: 'i2', status: 'failed', error: { retryable: true } },
  ] }]);
  const [ok, failed] = board.tasks[0].items;
  assert.equal(ok.actions.approve, true);
  assert.equal(failed.actions.retry, true);
  assert.equal(board.nextAction, 'review_pending_items');
});

test('F5-07 导出资格五条件：模拟、未通过、未生成都不合格（5.10）', () => {
  const view = projectPackageView([{ id: 'b', title: 't', status: 'waiting_review', items: [
    { id: 'i1', status: 'succeeded', output: { simulated: true, verificationStatus: 'verified' } },
    { id: 'i2', status: 'succeeded', output: { simulated: false, verificationStatus: 'verified' } },
    { id: 'i3', status: 'planned' },
  ] }]);
  const [sim, unreviewed, planned] = view.groups[0].items;
  assert.equal(sim.eligible, false);
  assert.ok(sim.failedChecks.includes('FILE_VERIFIED'), '模拟输出不满足文件 verified 条件');
  assert.equal(unreviewed.eligible, false);
  assert.ok(unreviewed.failedChecks.includes('REVIEW_APPROVED'));
  assert.equal(planned.eligible, false);
  assert.equal(view.exportableCount, 0);
  assert.ok((view.groups[0].blockedReason || '').includes('模拟输出'));
});

/* ---------------------------------------------------------------------------
   S6-01：N01–N02 项目上下文阶段投影
   --------------------------------------------------------------------------- */

test('S6-01 N01：无上下文/未选择/需求缺失分别给出可解释阻塞', () => {
  const empty = projectContextStage([], null, null);
  assert.equal(empty.blockingIssues[0].code, 'NO_PROJECT_CONTEXT');
  assert.equal(empty.nextAction, 'create_context');

  const one = [{ id: 'c1', contextKey: 'k1', version: 1, name: 'A', status: 'active', sellingPoints: [] }];
  const noSelect = projectContextStage(one, null, null);
  assert.equal(noSelect.nextAction, 'select_context');
  assert.deepEqual(noSelect.blockingIssues, []);

  const noRequest = projectContextStage(one, null, 'c1');
  assert.equal(noRequest.nextAction, 'configure_copy_request');
  assert.equal(noRequest.requestIssues[0].code, 'NO_COPY_REQUEST');

  const withRequest = projectContextStage(one, { count: 3, direction: 'x', platform: '抖音' }, 'c1');
  assert.equal(withRequest.nextAction, 'nothing_pending');
  assert.equal(withRequest.modelProviderConfigured, false, 'N03 模型提供方未配置必须显式声明');
});

test('S6-01 N01：多版本档案只显示每个档案的最新版本', () => {
  const stage = projectContextStage([
    { id: 'c1', contextKey: 'k1', version: 1, name: 'A v1', status: 'active', sellingPoints: [] },
    { id: 'c2', contextKey: 'k1', version: 2, name: 'A v2', status: 'active', sellingPoints: [] },
    { id: 'c3', contextKey: 'k2', version: 1, name: 'B v1', status: 'active', sellingPoints: [] },
  ], null, 'c2');
  assert.equal(stage.versions.length, 2, '同档案旧版本不再出现在选择列表');
  assert.equal(stage.selected.id, 'c2');
  assert.equal(stage.selectedContextId, 'c2');
});

/* ---------------------------------------------------------------------------
   S6-02/S6-03：数字人档案与模式 B 投影
   --------------------------------------------------------------------------- */

test('S6-02 档案就绪由绑定版本推导；未绑定给可解释阻塞；处理状态不伪造', () => {
  const assets = f504Assets();
  const bound = projectDigitalHumanProfiles([
    { id: 'p1', name: '张三', avatarVersionId: 'a1', voiceVersionId: 'v1' },
    { id: 'p2', name: '李四', avatarVersionId: null, voiceVersionId: null },
  ], assets);
  assert.equal(bound.profiles[0].ready, true);
  assert.equal(bound.profiles[0].status, 'ready_for_production');
  assert.equal(bound.profiles[0].processingStatus, 'pending_provider', '没有真实提供方，处理状态必须停在待处理');
  assert.equal(bound.profiles[1].ready, false);
  assert.ok(bound.profiles[1].blockingIssues.some((issue) => issue.code === 'PROFILE_AVATAR_UNBOUND'));
  assert.equal(bound.readyCount, 1);
  assert.equal(bound.nextAction, 'nothing_pending', '已有可生产档案时档案阶段不再阻塞');
});

test('S6-03 模式 B 映射四项齐全才算 ready', () => {
  const copy = f504Copy();
  const assets = f504Assets();
  const videos = [{ id: 'v-src', name: '旧拍摄', status: 'usable' }];
  const full = projectModeBStage(videos, [
    { id: 'm1', videoId: 'v-src', scriptVersionId: 'c1', voiceSource: 'original', templateVersionId: 't1' },
  ], copy, assets);
  assert.equal(full.readyMappingCount, 1);
  assert.deepEqual(full.blockingIssues, []);

  const incomplete = projectModeBStage(videos, [
    { id: 'm2', videoId: 'v-src', scriptVersionId: null, voiceSource: 'original', templateVersionId: null },
  ], copy, assets);
  assert.equal(incomplete.readyMappingCount, 0);
  const m = incomplete.mappings[0];
  assert.ok(m.missing.includes('SCRIPT_NOT_CONFIRMED') && m.missing.includes('TEMPLATE_MISSING'));
  assert.equal(incomplete.blockingIssues[0].code, 'NO_READY_VIDEO_MAPPING');
});

test('S6-03 模式 B 行引用完整映射后不再被阻塞', () => {
  const mappings = [{ id: 'm1', videoId: 'v-src', scriptVersionId: 'c1', voiceSource: 'original', templateVersionId: 't1', ready: true }];
  const ws = projectTaskWorkspace({
    draft: { mode: 'B', plannedItems: [{ mode: 'B', mappingVersionId: 'm1', outputName: 'b-01' }] },
    copy: f504Copy(),
    assets: f504Assets(),
    mappings,
    sourceVideos: [{ id: 'v-src', name: '旧拍摄', status: 'usable' }],
  });
  assert.equal(ws.blockingIssues.some((issue) => issue.code === 'ROW_MAPPING_NOT_READY'), false, '完整映射让模式 B 行可进入生产');
});
