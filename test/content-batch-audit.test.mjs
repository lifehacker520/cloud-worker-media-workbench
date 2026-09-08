import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildContentBatchAudit } from '../src/content-batch-audit.mjs';

function item(id, avatarVersionId, scriptVersionId, status = 'succeeded', extra = {}) {
  return {
    id,
    idempotencyKey: `${avatarVersionId}|${scriptVersionId}`,
    avatarVersionId,
    scriptVersionId,
    status,
    attempt: extra.attempt || 1,
    input: { script: { text: extra.text || '短文案', estimatedDurationSeconds: extra.duration || 15 } },
    output: { simulated: true, cost: { amount: 0, currency: 'CNY', source: 'simulation' } },
    ...extra,
  };
}

test('batch audit explains matrix integrity, runtime, costs, media checks and sample coverage', () => {
  const items = [
    item('item-a-short', 'avatar-a', 'script-short', 'approved', { duration: 15, review: { decision: 'approved' } }),
    item('item-a-long', 'avatar-a', 'script-long', 'succeeded', { duration: 90, text: '长'.repeat(500) }),
    item('item-b-mid', 'avatar-a', 'script-mid', 'succeeded', { duration: 45, text: '中'.repeat(220), attempt: 2 }),
  ];
  const batch = {
    id: 'batch_audit_fixture',
    planCount: 3,
    avatarVersionIds: ['avatar-a'],
    scriptVersionIds: ['script-short', 'script-mid', 'script-long'],
    templateVersionId: 'template-v1',
    connectorId: 'connector-sim',
    items,
    audit: {
      sampling: {
        ratio: 1,
        itemIds: items.map((candidate) => candidate.id),
        expanded: true,
        expandedReason: '覆盖每个人物和每种文案长度',
      },
      humanReview: { durationMs: 180000 },
    },
    exportRecord: { status: 'complete', package: { missingFiles: [] }, manifest: '/tmp/manifest.json' },
  };
  const modelRuns = items.flatMap((candidate, index) => [
    {
      id: `run-${candidate.id}-1`,
      itemId: candidate.id,
      status: index === 2 ? 'failed' : 'succeeded',
      attempt: 1,
      queuedAt: '2026-09-07T00:00:00.000Z',
      startedAt: '2026-09-07T00:00:01.000Z',
      completedAt: '2026-09-07T00:00:03.000Z',
      queueDurationMs: 1000,
      durationMs: 2000,
      output: index === 2 ? undefined : candidate.output,
      error: index === 2 ? { errorClass: 'timeout' } : undefined,
    },
    ...(index === 2 ? [{
      id: `run-${candidate.id}-2`,
      itemId: candidate.id,
      status: 'succeeded',
      attempt: 2,
      queuedAt: '2026-09-07T00:00:04.000Z',
      startedAt: '2026-09-07T00:00:05.000Z',
      completedAt: '2026-09-07T00:00:08.000Z',
      queueDurationMs: 1000,
      durationMs: 3000,
      output: candidate.output,
    }] : []),
  ]);
  const qualityReports = items.map((candidate) => ({
    itemId: candidate.id,
    status: 'passed_for_review',
    simulation: true,
    checks: { mediaCheckPassed: true, mediaChecks: [{ status: 'skipped_simulation', kind: 'video' }] },
  }));
  const audit = buildContentBatchAudit(batch, modelRuns, qualityReports);

  assert.equal(audit.plan.complete, true);
  assert.equal(audit.plan.duplicateItemIds.length, 0);
  assert.equal(audit.plan.duplicateIdempotencyKeys.length, 0);
  assert.equal(audit.terminal.allExplainable, true);
  assert.equal(audit.runs.orphanItemIds.length, 0);
  assert.equal(audit.retries.total, 1);
  assert.equal(audit.media.allAutoChecked, true);
  assert.equal(audit.media.simulatedCount, 3);
  assert.equal(audit.cost.totalAmount, 0);
  assert.equal(audit.cost.missingCount, 0);
  assert.equal(audit.failures.types.timeout, 1);
  assert.equal(audit.human.sampleCoverage.coversRequired, true);
  assert.equal(audit.human.reviewDurationMs, 180000);
  assert.equal(audit.minimumIntegrityPass, true);
  assert.equal(audit.metrics.queue.durationP50Ms, 1000);
  assert.equal(audit.metrics.generation.durationP95Ms, 3000);
  assert.equal(audit.export.complete, true);
});

test('batch audit marks missing runtime evidence and sample coverage explicitly', () => {
  const batch = {
    id: 'batch_audit_incomplete',
    planCount: 2,
    avatarVersionIds: ['avatar-a'],
    scriptVersionIds: ['script-short', 'script-long'],
    items: [item('item-only', 'avatar-a', 'script-short')],
  };
  const audit = buildContentBatchAudit(batch, [], []);
  assert.equal(audit.plan.complete, false);
  assert.equal(audit.terminal.allExplainable, false);
  assert.equal(audit.media.allAutoChecked, false);
  assert.equal(audit.human.sampleCoverage.coversRequired, false);
  assert.equal(audit.export.status, 'not_run');
  assert.equal(audit.minimumIntegrityPass, false);
});

test('batch audit requires expanded review when a sampled item has a hard failure', () => {
  const failed = item('item-failed', 'avatar-a', 'script-short', 'failed');
  failed.error = { errorClass: 'render_failed', retryable: false };
  const batch = {
    id: 'batch_audit_failure',
    planCount: 1,
    avatarVersionIds: ['avatar-a'],
    scriptVersionIds: ['script-short'],
    items: [failed],
    audit: { sampling: { ratio: 1, itemIds: [failed.id], expanded: false } },
  };
  const audit = buildContentBatchAudit(batch, [{ itemId: failed.id, status: 'failed', attempt: 1, error: failed.error }], []);
  assert.equal(audit.human.sampleCoverage.expansionRequired, true);
  assert.equal(audit.human.sampleCoverage.coversRequired, false);
  assert.equal(audit.minimumIntegrityPass, false);
});
