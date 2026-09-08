import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildBatchPlan,
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
