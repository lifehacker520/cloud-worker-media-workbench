import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContentPackage, evaluatePackageEligibility, summarizePackage } from '../src/content-package.mjs';
import { transitionContentBatchItem, createContentBatch } from '../src/digital-human-domain.mjs';

const actor = { username: 'tester', displayName: '验收人', role: 'admin' };

function seedBatch(id) {
  const seeded = createContentBatch({
    id,
    taskId: 'task_test',
    tenantId: 'tenant_local',
    projectId: 'project_test',
    title: '测试批次',
    plan: {
      count: 1,
      avatarVersionIds: ['avatar_v_1'],
      scriptVersionIds: ['script_v_1'],
      voiceVersionId: 'voice_v_1',
      templateVersionId: 'template_v_1',
      connectorId: 'connector_heygem_ssh',
      items: [{
        id: id + '_item_1',
        maxAttempts: 3,
        attempt: 0,
        connectorId: 'connector_heygem_ssh',
        status: 'planned',
        stage: 'planned',
        input: { avatarVersionId: 'avatar_v_1', voiceVersionId: 'voice_v_1', scriptVersionId: 'script_v_1' },
      }],
    },
  }, actor);
  seeded.status = 'running';
  return seeded;
}

test('N22：只有「人工通过 + 真实文件」的条目能进内容包', () => {
  const batch = {
    id: 'b1',
    taskId: 't1',
    items: [
      { id: 'i1', status: 'approved', attempt: 1, outputName: 'r1', output: { videoRef: 'data/media-output/a.mp4', provider: 'heygem-autodl-ssh', modelVersion: 'heygem-autodl-ssh', simulated: false, requestId: 'req1' }, review: { decision: 'approved', reviewer: actor, note: 'ok', createdAt: 'x' } },
      { id: 'i2', status: 'succeeded', attempt: 1, output: { videoRef: 'data/media-output/b.mp4', simulated: false }, review: null },
      { id: 'i3', status: 'approved', attempt: 2, output: { videoRef: 'data/media-output/c.mp4', simulated: true }, review: { decision: 'approved', reviewer: actor } },
      { id: 'i4', status: 'failed', attempt: 3, output: null, review: null },
    ],
  };
  const pkg = buildContentPackage({ batch, packageId: 'pkg_1', createdAt: '2026-09-14T00:00:00Z' });
  assert.equal(pkg.includedCount, 1);
  assert.equal(pkg.included[0].itemId, 'i1');
  assert.equal(pkg.included[0].provider, 'heygem-autodl-ssh');
  assert.equal(pkg.schemaVersion, 'content-package-v1');
  assert.deepEqual(pkg.blocked.map((entry) => entry.reason).sort(), ['NOT_APPROVED', 'NO_OUTPUT', 'SIMULATED_OUTPUT']);
  assert.deepEqual(summarizePackage(pkg), { packageId: 'pkg_1', batchId: 'b1', includedCount: 1, blockedCount: 3, createdAt: '2026-09-14T00:00:00Z', title: null });
});

test('N22：模拟审批标记被拒绝（防止把模拟结果混入交付）', () => {
  const verdict = evaluatePackageEligibility({ status: 'approved', output: { videoRef: 'x.mp4', simulated: false }, review: { decision: 'approved', simulatedApproval: true } });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, 'SIMULATED_APPROVAL');
});

test('N20：审核动作拒绝模拟输出通过，且记录决定/备注/审核人', () => {
  const seeded = seedBatch('batch_review');
  const itemId = seeded.items[0].id;
  const running = transitionContentBatchItem(seeded, itemId, 'claim', actor, { leaseUntil: 'z' });
  const succeeded = transitionContentBatchItem(running, itemId, 'succeed', actor, { output: { videoRef: 'a.mp4', simulated: false } });
  const approved = transitionContentBatchItem(succeeded, itemId, 'review', actor, { decision: 'approved', note: '合格' });
  const item = approved.items.find((candidate) => candidate.id === itemId);
  assert.equal(item.status, 'approved');
  assert.equal(item.review.decision, 'approved');
  assert.equal(item.review.note, '合格');
  assert.equal(item.review.reviewer.displayName, '验收人');

  const sim = transitionContentBatchItem(running, itemId, 'succeed', actor, { output: { videoRef: 'sim.mp4', simulated: true } });
  assert.throws(() => transitionContentBatchItem(sim, itemId, 'review', actor, { decision: 'approved' }), /模拟输出/);
  const returned = transitionContentBatchItem(sim, itemId, 'review', actor, { decision: 'changes_requested', note: '口型不准' });
  assert.equal(returned.items.find((candidate) => candidate.id === itemId).status, 'changes_requested');
});

test('N21：退回修改/失败可重试并回到队列；不可重试错误被拒绝', () => {
  const seeded = seedBatch('batch_retry');
  const itemId = seeded.items[0].id;
  const running = transitionContentBatchItem(seeded, itemId, 'claim', actor, { leaseUntil: 'z' });
  const failed = transitionContentBatchItem(running, itemId, 'fail', actor, { error: { errorClass: 'worker_error', message: 'ssh', retryable: true } });
  const retried = transitionContentBatchItem(failed, itemId, 'retry', actor);
  const item = retried.items.find((candidate) => candidate.id === itemId);
  assert.equal(item.status, 'queued');
  assert.equal(item.error, null);

  const blocked = transitionContentBatchItem(running, itemId, 'block', actor, { error: { errorClass: 'invalid_input', message: '缺素材', retryable: false } });
  assert.throws(() => transitionContentBatchItem(blocked, itemId, 'retry', actor), /不可自动重试/);
});
