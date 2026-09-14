import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildBatchPlan,
  buildExplicitBatchPlan,
  buildN18Request,
  projectN18Providers,
  createContentBatch,
  summarizeBatch,
  transitionContentBatch,
  transitionContentBatchItem,
} from '../src/digital-human-domain.mjs';

const avatar = (id, overrides = {}) => ({
  id,
  displayName: id,
  status: 'approved',
  authorizationStatus: 'approved',
  batchAllowed: true,
  ...overrides,
});

const script = (id, overrides = {}) => ({
  id,
  text: '已审核文案 ' + id,
  status: 'approved',
  ...overrides,
});

function validPlanInput(overrides = {}) {
  return {
    avatarVersionIds: ['avatar-b', 'avatar-a'],
    scriptVersionIds: ['script-2', 'script-1'],
    templateVersionId: 'template-v1',
    connectorId: 'fake-media-v1',
    combinationMode: 'cartesian',
    avatars: [avatar('avatar-b'), avatar('avatar-a')],
    scripts: [script('script-2'), script('script-1')],
    templates: [{ id: 'template-v1', status: 'approved', batchAllowed: true }],
    connectors: [{ id: 'fake-media-v1', status: 'ready', capabilities: ['tts', 'talking_head'] }],
    ...overrides,
  };
}

test('batch plans are deterministic and produce the complete cartesian matrix', () => {
  const first = buildBatchPlan(validPlanInput());
  const second = buildBatchPlan(validPlanInput({
    avatarVersionIds: ['avatar-a', 'avatar-b'],
    scriptVersionIds: ['script-1', 'script-2'],
    avatars: [avatar('avatar-a'), avatar('avatar-b')],
    scripts: [script('script-1'), script('script-2')],
  }));

  assert.equal(first.count, 4);
  assert.deepEqual(first.items, second.items);
  assert.equal(new Set(first.items.map((item) => item.idempotencyKey)).size, 4);
  assert.deepEqual(
    first.items.map((item) => [item.avatarVersionId, item.scriptVersionId]),
    [
      ['avatar-a', 'script-1'],
      ['avatar-a', 'script-2'],
      ['avatar-b', 'script-1'],
      ['avatar-b', 'script-2'],
    ],
  );
});

test('batch items snapshot approved media inputs for an external worker', () => {
  const plan = buildBatchPlan(validPlanInput({
    avatarVersionIds: ['avatar-a'],
    voiceVersionId: 'voice-a',
    scriptVersionIds: ['script-1'],
    avatars: [avatar('avatar-a', {
      canonicalImageRef: 'fixture://avatar-a.png',
      baseVideoRef: 'fixture://avatar-a.mp4',
      authorizationRef: 'consent://avatar-a',
    })],
    voices: [{
      id: 'voice-a',
      displayName: '测试声音',
      status: 'approved',
      authorizationStatus: 'approved',
      batchAllowed: true,
      referenceAudioRef: 'fixture://voice-a.wav',
      referenceTranscript: '这是参考音频的准确文字。',
      voiceName: 'VoiceA',
      provider: 'cosyvoice-3',
      modelVersion: 'CosyVoice-3-approved',
      licenseRef: 'license://cosyvoice-3',
      weightsHash: 'sha256:cosyvoice-3',
      authorizationRef: 'consent://voice-a',
    }],
    scripts: [script('script-1', {
      language: 'zh-CN',
      platform: 'xiaohongshu',
      estimatedDurationSeconds: 15,
    })],
    templates: [{
      id: 'template-v1',
      displayName: '竖屏模板',
      status: 'approved',
      batchAllowed: true,
      width: 1080,
      height: 1920,
      fps: 30,
      backgroundRef: 'fixture://background.png',
    }],
  }));

  assert.deepEqual(plan.items[0].input, {
    avatarVersionId: 'avatar-a',
    voiceVersionId: 'voice-a',
    scriptVersionId: 'script-1',
    templateVersionId: 'template-v1',
    avatar: {
      versionId: 'avatar-a',
      displayName: 'avatar-a',
      canonicalImageRef: 'fixture://avatar-a.png',
      baseVideoRef: 'fixture://avatar-a.mp4',
      authorizationRef: 'consent://avatar-a',
    },
    voice: {
      versionId: 'voice-a',
      displayName: '测试声音',
      referenceAudioRef: 'fixture://voice-a.wav',
      referenceTranscript: '这是参考音频的准确文字。',
      voiceName: 'VoiceA',
      provider: 'cosyvoice-3',
      modelVersion: 'CosyVoice-3-approved',
      licenseRef: 'license://cosyvoice-3',
      weightsHash: 'sha256:cosyvoice-3',
      authorizationRef: 'consent://voice-a',
    },
    script: {
      versionId: 'script-1',
      text: '已审核文案 script-1',
      language: 'zh-CN',
      platform: 'xiaohongshu',
      estimatedDurationSeconds: 15,
    },
    template: {
      versionId: 'template-v1',
      displayName: '竖屏模板',
      width: 1080,
      height: 1920,
      fps: 30,
      backgroundRef: 'fixture://background.png',
    },
  });
});

test('batch planning fails closed for authorization, review, capability, and size gaps', () => {
  assert.throws(
    () => buildBatchPlan(validPlanInput({ avatars: [avatar('avatar-a', { batchAllowed: false })] })),
    /批量使用权限/,
  );
  assert.throws(
    () => buildBatchPlan(validPlanInput({ scripts: [script('script-1', { status: 'draft' }), script('script-2')] })),
    /审核通过/,
  );
  assert.throws(
    () => buildBatchPlan(validPlanInput({ connectors: [{ id: 'fake-media-v1', status: 'unavailable', capabilities: ['talking_head'] }] })),
    /连接器/,
  );
  assert.throws(
    () => buildBatchPlan(validPlanInput({ maxItems: 3 })),
    /超过批次上限/,
  );
  assert.throws(
    () => buildBatchPlan(validPlanInput({
      avatars: [avatar('avatar-a', { voiceVersionId: 'voice-unapproved' }), avatar('avatar-b')],
    })),
    /默认声音版本/,
  );
});

test('batch plans beyond the M7 small-batch boundary require an explicit budget confirmation', () => {
  const largeInput = validPlanInput({
    avatarVersionIds: ['avatar-a', 'avatar-b', 'avatar-c'],
    scriptVersionIds: ['script-1', 'script-2', 'script-3'],
    avatars: [avatar('avatar-a'), avatar('avatar-b'), avatar('avatar-c')],
    scripts: [script('script-1'), script('script-2'), script('script-3')],
  });
  assert.throws(
    () => buildBatchPlan(largeInput),
    /预算估算.*负责人确认/,
  );
  assert.throws(
    () => buildBatchPlan({
      ...largeInput,
      budgetConfirmed: true,
      budgetEstimate: { amount: 12.5, currency: '' },
    }),
    /预算估算.*金额.*币种/,
  );
  const plan = buildBatchPlan({
    ...largeInput,
    budgetConfirmed: true,
    budgetEstimate: { amount: 12.5, currency: 'CNY', basis: '本地模拟基线' },
  });
  assert.equal(plan.count, 9);
  assert.deepEqual(plan.budget, {
    required: true,
    confirmed: true,
    estimate: { amount: 12.5, currency: 'CNY', basis: '本地模拟基线' },
  });
  const batch = createContentBatch({
    id: 'batch_budget_gate',
    taskId: 'task_fixture',
    tenantId: 'tenant_fixture',
    projectId: 'project_fixture',
    plan,
  }, { username: 'tester' });
  const unconfirmed = transitionContentBatch(batch, 'approve', { username: 'tester' });
  assert.throws(
    () => transitionContentBatch({ ...unconfirmed, budget: { ...unconfirmed.budget, confirmed: false } }, 'start', { username: 'tester' }),
    /预算.*确认/,
  );
});

test('batch and item transitions preserve review gates and partial failure meaning', () => {
  const plan = buildBatchPlan(validPlanInput());
  const batch = createContentBatch(
    {
      id: 'batch_fixture',
      taskId: 'task_fixture',
      tenantId: 'tenant_fixture',
      projectId: 'project_fixture',
      plan,
      title: '批量口播验收',
    },
    { username: 'tester', displayName: '测试人员' },
    { now: '2026-09-07T00:00:00.000Z' },
  );

  assert.equal(batch.status, 'waiting_approval');
  assert.equal(batch.items.length, 4);
  assert.equal(summarizeBatch(batch).planned, 4);

  const queued = transitionContentBatch(batch, 'approve', { username: 'tester' }, { now: '2026-09-07T00:01:00.000Z' });
  assert.equal(queued.status, 'queued');
  const running = transitionContentBatch(queued, 'start', { username: 'tester' }, { now: '2026-09-07T00:02:00.000Z' });
  assert.equal(running.status, 'running');

  const claimed = transitionContentBatchItem(running, running.items[0].id, 'claim', { username: 'worker' }, { now: '2026-09-07T00:03:00.000Z' });
  assert.equal(claimed.items[0].status, 'running');
  assert.equal(claimed.items[0].attempt, 1);
  const failed = transitionContentBatchItem(claimed, claimed.items[0].id, 'fail', { username: 'worker' }, {
    now: '2026-09-07T00:04:00.000Z',
    error: { message: 'temporary timeout', errorClass: 'timeout', retryable: true },
  });
  assert.equal(failed.items[0].status, 'failed');
  assert.equal(summarizeBatch(failed).failed, 1);

  let finishedOthers = failed;
  for (const item of finishedOthers.items.slice(1)) {
    finishedOthers = transitionContentBatchItem(finishedOthers, item.id, 'claim', { username: 'worker' }, { now: '2026-09-07T00:04:30.000Z' });
    finishedOthers = transitionContentBatchItem(finishedOthers, item.id, 'succeed', { username: 'worker' }, { now: '2026-09-07T00:04:45.000Z', output: { simulated: true } });
  }
  const partial = transitionContentBatch(finishedOthers, 'refresh', { username: 'worker' }, { now: '2026-09-07T00:05:00.000Z' });
  assert.equal(partial.status, 'partial_failed');
  assert.throws(
    () => transitionContentBatch(partial, 'complete', { username: 'tester' }, { now: '2026-09-07T00:06:00.000Z' }),
    /未完成|失败|审核/,
  );
});

test('returned items can be regenerated and retry limits fail closed', () => {
  const plan = buildBatchPlan(validPlanInput({ avatarVersionIds: ['avatar-a'], scriptVersionIds: ['script-1'] }));
  const batch = createContentBatch(
    { id: 'batch_review_fixture', taskId: 'task_fixture', tenantId: 'tenant_fixture', projectId: 'project_fixture', plan },
    { username: 'tester' },
    { now: '2026-09-07T01:00:00.000Z' },
  );
  let state = transitionContentBatch(batch, 'approve', { username: 'tester' });
  state = transitionContentBatch(state, 'start', { username: 'tester' });
  state = transitionContentBatchItem(state, state.items[0].id, 'claim', { username: 'worker' });
  state = transitionContentBatchItem(state, state.items[0].id, 'succeed', { username: 'worker', output: { simulated: true } });
  state = transitionContentBatchItem(state, state.items[0].id, 'review', { username: 'tester' }, { decision: 'changes_requested', note: '需要修改' });
  state = transitionContentBatch(state, 'refresh', { username: 'tester' });
  assert.equal(state.status, 'waiting_review');

  state = transitionContentBatchItem(state, state.items[0].id, 'retry', { username: 'tester' });
  assert.equal(state.items[0].status, 'queued');
  assert.equal(state.items[0].review, null);
  state = transitionContentBatch(state, 'start', { username: 'tester' });
  assert.equal(state.status, 'running');

  const limitedPlan = buildBatchPlan(validPlanInput({ avatarVersionIds: ['avatar-a'], scriptVersionIds: ['script-1'], maxAttempts: 1 }));
  let limited = createContentBatch(
    { id: 'batch_limit_fixture', taskId: 'task_fixture', tenantId: 'tenant_fixture', projectId: 'project_fixture', plan: limitedPlan },
    { username: 'tester' },
  );
  limited = transitionContentBatch(limited, 'approve', { username: 'tester' });
  limited = transitionContentBatch(limited, 'start', { username: 'tester' });
  limited = transitionContentBatchItem(limited, limited.items[0].id, 'claim', { username: 'worker' });
  limited = transitionContentBatchItem(limited, limited.items[0].id, 'fail', { username: 'worker' }, { error: { retryable: true, message: '一次失败' } });
  assert.throws(
    () => transitionContentBatchItem(limited, limited.items[0].id, 'retry', { username: 'tester' }),
    /最大重试次数/,
  );
});

/* ---------------------------------------------------------------------------
   F5-05/A 方案：buildExplicitBatchPlan（显式行 → 批次，不做全组合）
   --------------------------------------------------------------------------- */

const explicitCatalog = {
  avatars: [{ id: 'a1', status: 'approved', batchAllowed: true, canonicalImageRef: 'x', authorizationStatus: 'approved' }],
  voices: [{ id: 'v1', status: 'approved', batchAllowed: true, referenceAudioRef: 'y', authorizationStatus: 'approved' }],
  scripts: [
    { id: 's1', status: 'approved', text: '正文一', title: 'A 版' },
    { id: 's2', status: 'approved', text: '正文二', title: 'B 版' },
  ],
  templates: [{ id: 't1', status: 'approved', batchAllowed: true }],
  connectors: [{ id: 'cx', status: 'simulation', capabilities: ['talking_head'] }],
};

test('显式批次计划：一行一个 item，绝不隐式相乘', () => {
  const plan = buildExplicitBatchPlan({
    ...explicitCatalog,
    connectorId: 'cx',
    rows: [
      { mode: 'A', scriptVersionId: 's1', avatarVersionId: 'a1', voiceVersionId: 'v1', templateVersionId: 't1', outputName: 'row-01' },
      { mode: 'A', scriptVersionId: 's2', avatarVersionId: 'a1', voiceVersionId: 'v1', templateVersionId: 't1', outputName: 'row-02' },
    ],
  });
  assert.equal(plan.combinationMode, 'explicit');
  assert.equal(plan.count, 2);
  assert.deepEqual(plan.items.map((item) => item.outputName), ['row-01', 'row-02']);
  assert.equal(new Set(plan.items.map((item) => item.idempotencyKey)).size, 2);
});

test('显式批次计划：拒绝重复行、未审核资产与模式 B 行', () => {
  const base = { ...explicitCatalog, connectorId: 'cx' };
  assert.throws(
    () => buildExplicitBatchPlan({ ...base, rows: [
      { mode: 'A', scriptVersionId: 's1', avatarVersionId: 'a1', voiceVersionId: 'v1', templateVersionId: 't1' },
      { mode: 'A', scriptVersionId: 's1', avatarVersionId: 'a1', voiceVersionId: 'v1', templateVersionId: 't1' },
    ] }),
    /幂等键冲突/,
  );
  /* 未审核的形象版本必须被拒 */
  const draftAvatarCatalog = {
    ...explicitCatalog,
    avatars: [{ id: 'a2', status: 'draft', batchAllowed: true, canonicalImageRef: 'x' }],
  };
  assert.throws(
    () => buildExplicitBatchPlan({ ...draftAvatarCatalog, connectorId: 'cx', rows: [
      { mode: 'A', scriptVersionId: 's1', avatarVersionId: 'a2', voiceVersionId: 'v1', templateVersionId: 't1' },
    ] }),
    /必须审核通过/,
  );
  assert.throws(
    () => buildExplicitBatchPlan({ ...base, rows: [{ mode: 'B', scriptVersionId: 's1', sourceVideoAssetId: 'sv' }] }),
    /模式 B/,
  );
});

test('显式批次计划：超过 M7 小批次必须先确认预算（与全组合同一规则）', () => {
  /* 预算用例需要 7 行互不相同的组合，否则会先被幂等键拦截（那是另一条规则）。 */
  const manyScripts = {
    ...explicitCatalog,
    scripts: Array.from({ length: 7 }, (_, index) => ({ id: 's' + (index + 1), status: 'approved', text: '正文' + (index + 1), title: '第' + (index + 1) + '版' })),
  };
  const rows = Array.from({ length: 7 }, (_, index) => ({
    mode: 'A', scriptVersionId: 's' + (index + 1), avatarVersionId: 'a1', voiceVersionId: 'v1', templateVersionId: 't1', outputName: 'row-' + String(index + 1).padStart(2, '0'),
  }));
  assert.throws(
    () => buildExplicitBatchPlan({ ...manyScripts, connectorId: 'cx', rows }),
    /预算/,
  );
  const ok = buildExplicitBatchPlan({
    ...manyScripts, connectorId: 'cx', rows,
    budgetConfirmed: true, budgetEstimate: { amount: 10, currency: 'CNY', basis: '验证' },
  });
  assert.equal(ok.count, 7);
  assert.equal(ok.budget.required, true);
});

/* ---------------------------------------------------------------------------
   S7-01：N18 稳定契约与 Provider 能力闸门
   --------------------------------------------------------------------------- */

test('N18 契约：模式 A 必须携带完整数字人档案，输出快照必须存在', () => {
  const ok = buildN18Request({
    mode: 'A', taskId: 't1', itemId: 'i1', scriptVersionId: 's1',
    script: { confirmed: true, text: '正文' }, profileId: 'p1', avatarVersionId: 'a1', voiceVersionId: 'v1',
    templateVersionId: 't1', projectContextVersionId: 'ctx', outputPolicy: { directory: '/out', folder: 'f', fileName: 'x.mp4' },
  });
  assert.equal(ok.buildable, true);
  assert.equal(ok.schema_version, 'content-digital-human-n18-v1');
  assert.deepEqual(ok.digital_human, { profile_id: 'p1', avatar_version_id: 'a1', voice_version_id: 'v1' });
  assert.equal(ok.output_policy_snapshot.container, 'mp4');

  const broken = buildN18Request({ mode: 'A', script: { confirmed: true, text: 'x' }, templateVersionId: 't1', outputPolicy: { directory: '/out' } });
  assert.ok(broken.blocking_issues.some((issue) => issue.code === 'N18_DIGITAL_HUMAN_INCOMPLETE'));
  assert.equal(broken.buildable, false);
});

test('N18 契约：模式 B 目标配音二选一，双来源必须拒绝', () => {
  const base = { mode: 'B', scriptVersionId: 's1', script: { confirmed: true, text: '正文' }, sourceVideoAssetId: 'sv1', templateVersionId: 't1', outputPolicy: { directory: '/out' } };
  const dual = buildN18Request({ ...base, targetAudioAssetId: 'au1', voiceVersionId: 'v1' });
  assert.ok(dual.blocking_issues.some((issue) => issue.code === 'N18_DUAL_AUDIO_SOURCE'));
  const byVoice = buildN18Request({ ...base, voiceVersionId: 'v1' });
  assert.equal(byVoice.buildable, true);
  assert.equal(byVoice.digital_human.voice_version_id, 'v1');
  const byAudio = buildN18Request({ ...base, targetAudioAssetId: 'au1' });
  assert.equal(byAudio.buildable, true);
  const none = buildN18Request({ ...base });
  assert.ok(none.blocking_issues.some((issue) => issue.code === 'N18_AUDIO_SOURCE_MISSING'));
});

test('N18 Provider 闸门：只有 preferred 放行；候选/模拟一律如实阻塞', () => {
  const providers = [
    { capability: 'tts', providerKey: 'qwen3', status: 'preferred' },
    { capability: 'talking_head', providerKey: 'duix', status: 'preferred' },
    { capability: 'lipsync', providerKey: 'latentsync', status: 'candidate' },
  ];
  const gateA = projectN18Providers(providers, 'A');
  assert.equal(gateA.allReady, true);
  const gateB = projectN18Providers(providers, 'B');
  assert.equal(gateB.allReady, false);
  assert.equal(gateB.blockingIssues[0].code, 'N18_PROVIDER_NOT_READY_LIPSYNC');
  const sim = projectN18Providers([
    { capability: 'tts', status: 'simulation' },
    { capability: 'talking_head', status: 'simulation' },
  ], 'A');
  assert.equal(sim.allReady, false);
  assert.deepEqual(sim.blockingIssues.map((issue) => issue.code), [
    'N18_PROVIDER_NOT_READY_TTS', 'N18_PROVIDER_NOT_READY_TALKING_HEAD',
  ]);
});
