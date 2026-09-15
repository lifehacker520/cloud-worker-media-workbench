import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileOfflineWorkerItems, OFFLINE_ERROR } from '../src/worker-offline-reconcile.mjs';
import { transitionContentBatchItem, createContentBatch } from '../src/digital-human-domain.mjs';

const actor = { username: 'reconciler', displayName: '对账器', role: 'admin' };

function seed(status, updatedAt) {
  const batch = createContentBatch({
    id: 'batch_reconcile', taskId: 'task_x', tenantId: 'tenant_local', projectId: 'project_x', title: '对账测试',
    plan: {
      count: 1, avatarVersionIds: ['a1'], scriptVersionIds: ['s1'], voiceVersionId: 'v1', templateVersionId: 't1', connectorId: 'c1',
      items: [{ id: 'item_1', maxAttempts: 3, attempt: 0, connectorId: 'c1', status: 'planned', stage: 'planned', input: {} }],
    },
  }, actor);
  batch.status = 'running';
  batch.items[0].status = status;
  batch.items[0].stage = status;
  batch.items[0].updatedAt = updatedAt;
  return batch;
}

const OFFLINE_NOW = () => '2026-09-15T10:40:00.000Z';

test('Worker 离线且条目超过阈值未更新 → 判为可重试失败（不再假死 running）', () => {
  const batch = seed('running', '2026-09-15T10:30:00.000Z'); // 10 分钟未更新
  const result = reconcileOfflineWorkerItems({
    batch, health: { ok: false, error: 'ssh closed' }, actor, transitionItem: transitionContentBatchItem, now: OFFLINE_NOW,
  });
  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0].itemId, result.batch.items[0].id);
  const item = result.batch.items[0];
  assert.equal(item.status, 'failed');
  assert.equal(item.error.code, OFFLINE_ERROR.code);
  assert.equal(item.error.retryable, true);
  assert.match(item.error.message, /最后活动距今 600 秒/);
});

test('Worker 离线但条目刚刚还在活动 → 不动（避免打断正在跑的生成）', () => {
  const batch = seed('running', '2026-09-15T10:39:30.000Z'); // 30 秒前
  const result = reconcileOfflineWorkerItems({
    batch, health: { ok: false }, actor, transitionItem: transitionContentBatchItem, now: OFFLINE_NOW,
  });
  assert.equal(result.changed.length, 0);
  assert.equal(result.batch.items[0].status, 'running');
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ['recently_active']);
});

test('Worker 在线 → 完全不对账', () => {
  const batch = seed('running', '2026-09-15T09:00:00.000Z');
  const result = reconcileOfflineWorkerItems({
    batch, health: { ok: true, gpu: 'RTX 4080 SUPER' }, actor, transitionItem: transitionContentBatchItem, now: OFFLINE_NOW,
  });
  assert.equal(result.changed.length, 0);
  assert.equal(result.batch.items[0].status, 'running');
  assert.ok(result.skipped.every((entry) => entry.reason === 'worker_online'));
});

test('终态条目不受影响', () => {
  const batch = seed('succeeded', '2026-09-15T08:00:00.000Z');
  const result = reconcileOfflineWorkerItems({
    batch, health: { ok: false }, actor, transitionItem: transitionContentBatchItem, now: OFFLINE_NOW,
  });
  assert.equal(result.changed.length, 0);
  assert.equal(result.batch.items[0].status, 'succeeded');
});
