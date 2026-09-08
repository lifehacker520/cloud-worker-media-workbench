import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { buildBatchPlan, createContentBatch, transitionContentBatch, transitionContentBatchItem } from '../src/digital-human-domain.mjs';
import { ContentBatchRunner, FakeMediaGenerationConnector } from '../src/content-batch-runner.mjs';
import { ContentBatchStore } from '../src/content-batch-store.mjs';
import { WorkbenchStore } from '../src/workbench-store.mjs';

const actor = { username: 'owner', displayName: '内容负责人', role: 'admin', tenantId: 'tenant_local' };

async function fixture(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-content-batch-runner-'));
  const workbench = await WorkbenchStore.open(dataDir);
  const project = workbench.ensureProject(actor, { id: 'project_content_editor', slug: 'content-editor', name: '内容编辑云员工' });
  const store = new ContentBatchStore(workbench);
  store.ensureSchema();
  const avatarCount = Number.isInteger(options.avatarCount) && options.avatarCount > 0 ? options.avatarCount : 1;
  const avatars = Array.from({ length: avatarCount }, (_, index) => store.createAvatarProfile(actor, {
    projectId: project.id,
    id: `avatar_profile_runner_${index + 1}`,
    versionId: `avatar_runner_v${index + 1}`,
    name: `测试数字人${index + 1}`,
    canonicalImageRef: `fixture://avatar-${index + 1}.png`,
    baseVideoRef: `fixture://avatar-${index + 1}.mp4`,
    authorizationStatus: 'approved', authorizationRef: `consent://avatar-${index + 1}`,
    batchAllowed: true, approved: true,
  }));
  const scripts = store.createScriptSet(actor, {
    projectId: project.id, taskId: 'task_runner', id: 'script_set_runner', name: '测试脚本', approved: true,
    versions: [{ id: 'script_runner_v1', text: '第一条' }, { id: 'script_runner_v2', text: '第二条' }, { id: 'script_runner_v3', text: '第三条' }],
  });
  const template = store.ensureDefaultTemplate(actor, project.id);
  const connector = store.ensureSimulationConnector(actor, project.id);
  const plan = buildBatchPlan({
    avatarVersionIds: avatars.map((item) => item.version.id), scriptVersionIds: scripts.versions.map((item) => item.id),
    templateVersionId: template.version.id, connectorId: connector.id,
    avatars: avatars.map((item) => item.version), scripts: scripts.versions, templates: [template.version], connectors: [connector],
  });
  const batch = createContentBatch({ id: 'batch_runner_fixture', taskId: 'task_runner', tenantId: actor.tenantId, projectId: project.id, plan }, actor);
  let started = transitionContentBatch(batch, 'approve', actor);
  started = transitionContentBatch(started, 'start', actor);
  store.saveBatch(actor, started);
  return { dataDir, workbench, store, project, batch: started, connector };
}

async function cleanup(value) {
  try { value.workbench.close(); } catch {}
  await rm(value.dataDir, { recursive: true, force: true });
}

test('runner isolates a failed item, records runs and allows one retry', async () => {
  const value = await fixture();
  try {
    const failedId = value.batch.items[1].id;
    const connector = new FakeMediaGenerationConnector({ id: value.connector.id, failOnceIds: [failedId] });
    const runner = new ContentBatchRunner({ store: value.store, connectors: [connector], workerId: 'runner-test' });
    let result = await runner.runUntilIdle(actor, value.batch.id);
    assert.equal(result.status, 'partial_failed');
    assert.equal(result.items.filter((item) => item.status === 'succeeded').length, 2);
    assert.equal(result.items.find((item) => item.id === failedId).status, 'failed');
    assert.equal(value.store.listModelRuns(actor, value.batch.id).length, 3);

    result = transitionContentBatchItem(result, failedId, 'retry', actor);
    result = transitionContentBatch(result, 'start', actor);
    value.store.saveBatch(actor, result);
    result = await runner.runUntilIdle(actor, value.batch.id);
    assert.equal(result.status, 'waiting_review');
    assert.equal(result.items.filter((item) => item.status === 'succeeded').length, 3);
    assert.equal(value.store.listModelRuns(actor, value.batch.id).length, 4);
    assert.equal(value.store.listQualityReports(actor, value.batch.id).length, 3);
  } finally {
    await cleanup(value);
  }
});

test('runner respects pause and requeues expired leases after restart', async () => {
  const value = await fixture();
  try {
    let paused = transitionContentBatch(value.batch, 'pause', actor);
    value.store.saveBatch(actor, paused);
    const runner = new ContentBatchRunner({ store: value.store, connectors: [new FakeMediaGenerationConnector({ id: value.connector.id })] });
    let result = await runner.runUntilIdle(actor, paused.id);
    assert.equal(result.status, 'paused');
    assert.equal(value.store.listModelRuns(actor, paused.id).length, 0);

    let running = transitionContentBatch(paused, 'resume', actor);
    running = transitionContentBatchItem(running, running.items[0].id, 'claim', actor, {
      leaseUntil: '2000-01-01T00:00:00.000Z',
    });
    value.store.saveBatch(actor, running);
    result = await runner.runUntilIdle(actor, running.id);
    assert.equal(result.status, 'waiting_review');
    assert.equal(result.items[0].status, 'succeeded');
  } finally {
    await cleanup(value);
  }
});

test('runner marks an unavailable media worker as blocked instead of hiding the dependency as a failure', async () => {
  const value = await fixture();
  try {
    const connector = new FakeMediaGenerationConnector({
      id: value.connector.id,
      blockedIds: value.batch.items.map((item) => item.id),
    });
    const runner = new ContentBatchRunner({ store: value.store, connectors: [connector], workerId: 'blocked-worker-test' });
    const result = await runner.runUntilIdle(actor, value.batch.id);
    assert.equal(result.status, 'blocked');
    assert.equal(result.items.every((item) => item.status === 'blocked'), true);
    assert.equal(result.items[0].error.errorClass, 'worker_unavailable');
  } finally {
    await cleanup(value);
  }
});

test('runner enforces the configured concurrency ceiling without losing item results', async () => {
  const value = await fixture();
  try {
    let active = 0;
    let maxActive = 0;
    const connector = {
      id: value.connector.id,
      async generate({ batch, item }) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 35));
        active -= 1;
        return {
          simulated: true,
          outputKind: 'video_manifest',
          videoRef: `simulation://${batch.id}/${item.id}.mp4`,
          durationSeconds: 15,
          connectorId: this.id,
          reviewRequired: true,
        };
      },
    };
    const runner = new ContentBatchRunner({
      store: value.store,
      connectors: [connector],
      workerId: 'concurrency-runner',
      maxConcurrency: 2,
    });
    const result = await runner.runUntilIdle(actor, value.batch.id);
    assert.equal(maxActive, 2);
    assert.equal(result.status, 'waiting_review');
    assert.equal(result.items.length, 3);
    assert.equal(result.items.every((item) => item.status === 'succeeded'), true);
    const runs = value.store.listModelRuns(actor, result.id);
    assert.equal(runs.length, 3);
    assert.equal(runs.every((run) => run.concurrencyLimit === 2 && Number.isFinite(run.durationMs)), true);
    assert.equal(Math.max(...runs.map((run) => run.activeConcurrency)), 2);
  } finally {
    await cleanup(value);
  }
});

test('runner fault-isolates one timeout in a governed 2x3 matrix and retries only that item', async () => {
  const value = await fixture({ avatarCount: 2 });
  try {
    const failedId = value.batch.items[1].id;
    const connector = new FakeMediaGenerationConnector({ id: value.connector.id, failOnceIds: [failedId] });
    const runner = new ContentBatchRunner({
      store: value.store,
      connectors: [connector],
      workerId: 'm7-2x3-fault-runner',
      maxConcurrency: 2,
    });

    let result = await runner.runUntilIdle(actor, value.batch.id);
    assert.equal(result.status, 'partial_failed');
    assert.equal(result.items.length, 6);
    assert.equal(result.items.filter((item) => item.status === 'failed').length, 1);
    assert.equal(result.items.filter((item) => item.status === 'succeeded').length, 5);
    assert.equal(result.items.find((item) => item.id === failedId).error.code, 'FAKE_TIMEOUT');
    assert.equal(value.store.listModelRuns(actor, result.id).length, 6);
    assert.equal(value.store.listQualityReports(actor, result.id).length, 5);
    assert.equal(new Set(result.items.map((item) => item.idempotencyKey)).size, 6);

    result = transitionContentBatchItem(result, failedId, 'retry', actor);
    result = transitionContentBatch(result, 'start', actor);
    value.store.saveBatch(actor, result);
    result = await runner.runUntilIdle(actor, value.batch.id);
    assert.equal(result.status, 'waiting_review');
    assert.equal(result.items.every((item) => item.status === 'succeeded'), true);
    assert.equal(value.store.listModelRuns(actor, result.id).length, 7);
    assert.equal(value.store.listQualityReports(actor, result.id).length, 6);
  } finally {
    await cleanup(value);
  }
});

test('runner keeps a non-simulated remote artifact pending until media checks exist', async () => {
  const value = await fixture();
  try {
    const connector = {
      id: value.connector.id,
      async generate({ batch, item }) {
        return { simulated: false, videoRef: `https://worker.example/${batch.id}/${item.id}.mp4`, reviewRequired: true };
      },
    };
    const runner = new ContentBatchRunner({ store: value.store, connectors: [connector], workerId: 'remote-check-runner' });
    const result = await runner.runUntilIdle(actor, value.batch.id);
    const report = value.store.listQualityReports(actor, result.id)[0];
    assert.equal(report.status, 'media_check_pending');
    assert.equal(report.checks.mediaCheckPassed, false);
    assert.deepEqual(report.checks.mediaChecks, []);
  } finally {
    await cleanup(value);
  }
});

test('runner does not resurrect a cancelled item after an in-flight connector returns', async () => {
  const value = await fixture();
  try {
    let release;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const connector = {
      id: value.connector.id,
      async generate({ batch, item }) {
        markStarted();
        await new Promise((resolve) => { release = resolve; });
        return { simulated: true, videoRef: `simulation://${batch.id}/${item.id}.mp4`, reviewRequired: true };
      },
    };
    const runner = new ContentBatchRunner({ store: value.store, connectors: [connector], workerId: 'cancel-race-runner' });
    const runPromise = runner.runUntilIdle(actor, value.batch.id);
    await started;
    const cancelled = transitionContentBatch(value.store.getBatch(actor, value.batch.id), 'cancel', actor);
    value.store.saveBatch(actor, cancelled);
    release();
    const result = await runPromise;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.items[0].status, 'cancelled');
    assert.equal(value.store.listModelRuns(actor, result.id)[0].status, 'cancelled');
  } finally {
    await cleanup(value);
  }
});
