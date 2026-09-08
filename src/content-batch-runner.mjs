import { randomUUID } from 'node:crypto';

import {
  normalizeConnectorError,
  summarizeBatch,
  transitionContentBatch,
  transitionContentBatchItem,
} from './digital-human-domain.mjs';

function now() {
  return new Date().toISOString();
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function snapshot(value) {
  try {
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function isSimulationReference(value) {
  return /^simulation:\/\//i.test(text(value));
}

function normalizeBatchOutput(output, item, run) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw { errorClass: 'invalid_output', code: 'BATCH_OUTPUT_INVALID', message: '媒体 worker 未返回对象结果', retryable: false, status: 200 };
  }
  if (!text(output.videoRef)) {
    throw { errorClass: 'invalid_output', code: 'BATCH_VIDEO_REF_MISSING', message: '媒体 worker 未返回视频引用', retryable: false, status: 200 };
  }
  const simulated = output.simulated === true || isSimulationReference(output.videoRef) || isSimulationReference(output.audioRef);
  const modelVersion = text(output.modelVersion)
    || text(item.input?.voice?.modelVersion)
    || text(item.input?.avatar?.modelVersion)
    || null;
  const requestId = text(output.requestId);
  return {
    ...output,
    simulated,
    simulationOnly: simulated,
    executionStatus: simulated ? 'simulation_only' : 'worker_output',
    reviewRequired: output.reviewRequired !== false,
    modelVersion,
    requestId: requestId || run.id,
    requestIdSource: requestId ? text(output.requestIdSource, 'worker') : 'local_run',
  };
}

export class FakeMediaGenerationConnector {
  constructor(options = {}) {
    this.id = text(options.id, 'connector_simulation');
    this.failOnceIds = new Set(options.failOnceIds || []);
    this.failIds = new Set(options.failIds || []);
    this.blockedIds = new Set(options.blockedIds || []);
  }

  async generate({ batch, item }) {
    if (this.blockedIds.has(item.id)) {
      throw { errorClass: 'worker_unavailable', code: 'FAKE_WORKER_UNAVAILABLE', message: '模拟 worker 暂不可用', retryable: true, status: 503 };
    }
    if (this.failIds.has(item.id) || (this.failOnceIds.has(item.id) && item.attempt === 1)) {
      throw { errorClass: 'timeout', code: 'FAKE_TIMEOUT', message: '模拟连接器超时', retryable: true, status: 504 };
    }
    return {
      simulated: true,
      outputKind: 'video_manifest',
      videoRef: `simulation://${batch.id}/${item.id}.mp4`,
      audioRef: item.voiceVersionId ? `simulation://${batch.id}/${item.id}.wav` : null,
      durationSeconds: 15,
      connectorId: this.id,
      modelVersion: 'fake-media-v1',
      cost: { amount: 0, currency: 'CNY', source: 'simulation' },
      reviewRequired: true,
    };
  }
}

export class ContentBatchRunner {
  constructor(options = {}) {
    if (!options.store) throw new Error('ContentBatchRunner 需要 ContentBatchStore');
    this.store = options.store;
    this.connectors = new Map((options.connectors || []).map((connector) => [connector.id, connector]));
    this.workerId = text(options.workerId, 'content-batch-worker-' + randomUUID().slice(0, 8));
    this.leaseMs = Number.isInteger(options.leaseMs) && options.leaseMs > 0 ? options.leaseMs : 5 * 60 * 1000;
    this.maxConcurrency = Number.isInteger(options.maxConcurrency) && options.maxConcurrency > 0 ? options.maxConcurrency : 1;
  }

  async runUntilIdle(actor, batchId) {
    let batch = this.store.getBatch(actor, batchId);
    if (!batch) throw new Error('批次不存在');
    batch = this.store.recoverExpiredLeases(actor, batchId) || batch;
    const activeRuns = new Map();
    const launch = (claimed, item) => {
      const claimedItem = claimed.items.find((candidate) => candidate.id === item.id);
      const startedAt = now();
      const queuedAt = claimedItem.queuedAt || claimedItem.createdAt || startedAt;
      const run = {
        id: `model_run_${item.id}_${claimedItem.attempt}`,
        batchId: claimed.id,
        itemId: item.id,
        connectorId: item.connectorId,
        status: 'running',
        attempt: claimedItem.attempt,
        workerId: this.workerId,
        concurrencyLimit: this.maxConcurrency,
        activeConcurrency: activeRuns.size + 1,
        queuedAt,
        queueDurationMs: Math.max(0, Date.parse(startedAt) - Date.parse(queuedAt)),
        startedAt,
        inputSnapshot: snapshot(claimedItem.input),
        createdAt: startedAt,
        updatedAt: startedAt,
      };
      this.store.saveModelRun(actor, run);
      const promise = this.executeItem(actor, batchId, claimed, claimedItem, run)
        .finally(() => activeRuns.delete(item.id));
      activeRuns.set(item.id, promise);
    };

    while (true) {
      batch = this.store.getBatch(actor, batchId);
      while (batch?.status === 'running' && activeRuns.size < this.maxConcurrency) {
        const item = batch.items.find((candidate) => ['planned', 'queued'].includes(candidate.status));
        if (!item) break;
        const leaseUntil = new Date(Date.now() + this.leaseMs).toISOString();
        const claimed = transitionContentBatchItem(batch, item.id, 'claim', actor, { leaseUntil });
        const claimedItem = claimed.items.find((candidate) => candidate.id === item.id);
        claimedItem.leaseOwner = this.workerId;
        this.store.saveBatch(actor, claimed);
        launch(claimed, item);
        batch = this.store.getBatch(actor, batchId);
      }
      if (!activeRuns.size) break;
      await Promise.race(activeRuns.values());
    }
    if (activeRuns.size) await Promise.all(activeRuns.values());
    batch = this.store.getBatch(actor, batchId);
    if (batch?.status === 'running' && !summarizeBatch(batch).planned && !summarizeBatch(batch).queued && !summarizeBatch(batch).running) {
      batch = transitionContentBatch(batch, 'refresh', actor);
      this.store.saveBatch(actor, batch);
    }
    return batch;
  }

  async executeItem(actor, batchId, claimed, item, run) {
    const connector = this.connectors.get(item.connectorId);
    try {
      if (!connector || typeof (connector.generate || connector.run) !== 'function') {
        throw { errorClass: 'worker_unavailable', code: 'CONNECTOR_NOT_REGISTERED', message: '执行器未登记该连接器', retryable: true, status: 503 };
      }
      const execute = connector.generate || connector.run;
      const output = normalizeBatchOutput(
        await execute.call(connector, { batch: claimed, item, actor, workerId: this.workerId }),
        item,
        run,
      );
      const completedAt = now();
      const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(run.startedAt));
      const current = this.store.getBatch(actor, batchId);
      const currentItem = current?.items.find((candidate) => candidate.id === item.id);
      if (!current || currentItem?.status !== 'running') {
        this.store.saveModelRun(actor, { ...run, status: 'cancelled', output, completedAt, durationMs, updatedAt: completedAt });
        return;
      }
      const next = transitionContentBatchItem(current, item.id, 'succeed', actor, { output });
      this.store.saveBatch(actor, next);
      const mediaChecks = Array.isArray(output?.mediaChecks) ? output.mediaChecks : [];
      const mediaCheckPassed = output?.simulated !== true
        && mediaChecks.length > 0
        && mediaChecks.every((check) => check?.status === 'succeeded');
      this.store.saveModelRun(actor, { ...run, status: 'succeeded', output, completedAt, durationMs, updatedAt: completedAt });
      this.store.saveQualityReport(actor, {
        id: `quality_report_${item.id}_${run.attempt}`,
        batchId: current.id,
        itemId: item.id,
        status: output.simulated ? 'simulation_only' : mediaCheckPassed ? 'passed_for_review' : 'media_check_pending',
        simulation: output?.simulated === true,
        durationMs,
        concurrencyLimit: this.maxConcurrency,
        checks: {
          outputManifest: Boolean(output?.videoRef),
          mediaChecks,
          mediaCheckPassed,
          simulationOnly: output?.simulated === true,
          modelVersion: output?.modelVersion || null,
          requestId: output?.requestId || null,
          connector: item.connectorId,
          humanReviewRequired: true,
        },
        createdAt: completedAt,
        updatedAt: completedAt,
      });
    } catch (error) {
      const normalized = normalizeConnectorError(error);
      const completedAt = now();
      const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(run.startedAt));
      const current = this.store.getBatch(actor, batchId);
      const currentItem = current?.items.find((candidate) => candidate.id === item.id);
      if (!current || currentItem?.status !== 'running') {
        this.store.saveModelRun(actor, { ...run, status: 'cancelled', error: normalized, completedAt, durationMs, updatedAt: completedAt });
        return;
      }
      const itemAction = normalized.errorClass === 'worker_unavailable' ? 'block' : 'fail';
      const next = transitionContentBatchItem(current, item.id, itemAction, actor, { error: normalized });
      this.store.saveBatch(actor, next);
      this.store.saveModelRun(actor, { ...run, status: 'failed', error: normalized, completedAt, durationMs, updatedAt: completedAt });
    }
  }
}
