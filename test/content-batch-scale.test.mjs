import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { ContentBatchRunner, FakeMediaGenerationConnector } from '../src/content-batch-runner.mjs';
import { ContentBatchStore } from '../src/content-batch-store.mjs';
import { buildContentBatchAudit } from '../src/content-batch-audit.mjs';
import { buildBatchPlan, createContentBatch, transitionContentBatch } from '../src/digital-human-domain.mjs';
import { WorkbenchStore } from '../src/workbench-store.mjs';

const actor = { username: 'scale-owner', displayName: '批次容量测试', role: 'admin', tenantId: 'tenant_local' };

test('fake worker executes the governed 10x30 matrix without duplicate or orphan items', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-content-batch-scale-'));
  const workbench = await WorkbenchStore.open(dataDir);
  try {
    const project = workbench.ensureProject(actor, { id: 'project_scale', slug: 'content-scale', name: '批次容量测试' });
    const store = new ContentBatchStore(workbench);
    store.ensureSchema();
    const avatars = [];
    for (let index = 0; index < 10; index += 1) {
      avatars.push(store.createAvatarProfile(actor, {
        projectId: project.id,
        id: `avatar_scale_${index + 1}`,
        versionId: `avatar_scale_v${index + 1}`,
        name: `测试人物 ${index + 1}`,
        canonicalImageRef: `fixture://avatar-${index + 1}.png`,
        baseVideoRef: `fixture://avatar-${index + 1}.mp4`,
        authorizationStatus: 'approved',
        authorizationRef: `consent://avatar-${index + 1}`,
        batchAllowed: true,
        approved: true,
      }));
    }
    const scripts = store.createScriptSet(actor, {
      projectId: project.id,
      taskId: 'task_scale',
      id: 'script_scale',
      name: '30 条测试文案',
      approved: true,
      versions: Array.from({ length: 30 }, (_, index) => ({
        id: `script_scale_v${index + 1}`,
        text: index < 10 ? `短稿 ${index + 1}` : index < 20 ? `中稿 ${index + 1}，${'内容'.repeat(100)}` : `长稿 ${index + 1}，${'内容'.repeat(250)}`,
        estimatedDurationSeconds: index < 10 ? 15 : index < 20 ? 45 : 90,
      })),
    });
    const template = store.ensureDefaultTemplate(actor, project.id);
    const connector = store.ensureSimulationConnector(actor, project.id);
    const plan = buildBatchPlan({
      avatarVersionIds: avatars.map((item) => item.version.id),
      scriptVersionIds: scripts.versions.map((item) => item.id),
      templateVersionId: template.version.id,
      connectorId: connector.id,
      avatars: avatars.map((item) => item.version),
      scripts: scripts.versions,
      templates: [template.version],
      connectors: [connector],
      budgetConfirmed: true,
      budgetEstimate: { amount: 0, currency: 'CNY', basis: 'fake worker 本地基线' },
    });
    assert.equal(plan.count, 300);
    assert.equal(plan.budget.confirmed, true);
    assert.equal(new Set(plan.items.map((item) => item.id)).size, 300);
    assert.equal(new Set(plan.items.map((item) => item.idempotencyKey)).size, 300);

    let batch = createContentBatch({ id: 'batch_scale_10x30', taskId: 'task_scale', tenantId: actor.tenantId, projectId: project.id, plan }, actor);
    assert.equal(batch.budget.confirmedBy.username, actor.username);
    batch = transitionContentBatch(batch, 'approve', actor);
    batch = transitionContentBatch(batch, 'start', actor);
    store.saveBatch(actor, batch);
    const runner = new ContentBatchRunner({ store, connectors: [new FakeMediaGenerationConnector({ id: connector.id })], workerId: 'scale-runner' });
    const result = await runner.runUntilIdle(actor, batch.id);
    assert.equal(result.status, 'waiting_review');
    assert.equal(result.items.length, 300);
    assert.equal(result.items.every((item) => item.status === 'succeeded'), true);
    assert.equal(result.items.every((item) => item.output?.simulated === true), true);
    assert.equal(store.listModelRuns(actor, result.id).length, 300);
    assert.equal(store.listQualityReports(actor, result.id).length, 300);
    const sampleScriptIds = new Set(['script_scale_v1', 'script_scale_v11', 'script_scale_v21']);
    const sampleItemIds = result.items
      .filter((item) => item.avatarVersionId && sampleScriptIds.has(item.scriptVersionId))
      .map((item) => item.id);
    const auditedBatch = {
      ...result,
      audit: {
        sampling: { ratio: sampleItemIds.length / result.items.length, itemIds: sampleItemIds, expanded: false },
        humanReview: { durationMs: 300000, notes: '10×30 本地基线抽样记录' },
      },
    };
    const audit = buildContentBatchAudit(
      auditedBatch,
      store.listModelRuns(actor, result.id),
      store.listQualityReports(actor, result.id),
    );
    assert.equal(audit.plan.complete, true);
    assert.equal(audit.terminal.allExplainable, true);
    assert.equal(audit.runs.complete, true);
    assert.equal(audit.quality.complete, true);
    assert.equal(audit.media.allAutoChecked, true);
    assert.equal(audit.cost.missingCount, 0);
    assert.equal(audit.failures.hardFailureCount, 0);
    assert.equal(audit.human.sampleCoverage.coversRequired, true);
    assert.equal(audit.minimumIntegrityPass, true);
  } finally {
    workbench.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
