import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, mkdtemp, readFile, realpath, rm, stat as statFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { test } from 'node:test';
import { promisify } from 'node:util';

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

async function waitForServer(port, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before becoming ready');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(400) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
  }
  throw new Error('timed out waiting for server');
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  return { response, payload: await response.json() };
}

test('content batch API runs a 2x3 plan through review and partial export', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-content-batch-api-'));
  const port = 32600 + Math.floor(Math.random() * 150);
  await Promise.all([
    writeFile(join(dataDir, 'accounts.json'), '[]'),
    writeFile(join(dataDir, 'works.json'), '[]'),
    writeFile(join(dataDir, 'activity.json'), '[]'),
    writeFile(join(dataDir, 'feedback.json'), '[]'),
    writeFile(join(dataDir, 'content-tasks.json'), '[]'),
  ]);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: { ...process.env, XHS_DATA_DIR: dataDir, XHS_MONITOR_PORT: String(port), XHS_REFRESH_MINUTES: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(port, child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const createdTask = await jsonRequest(`${baseUrl}/api/content/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: '批量数字人 API 验收', objective: '验证 2x3 批次闭环' }),
    });
    assert.equal(createdTask.response.status, 201);
    const task = createdTask.payload.task;

    const catalogBefore = await jsonRequest(`${baseUrl}/api/content/batches/catalog?projectId=${encodeURIComponent(task.projectId)}&taskId=${encodeURIComponent(task.id)}`);
    assert.equal(catalogBefore.response.status, 200);
    assert.equal(catalogBefore.payload.catalog.defaults.connectorId.startsWith('connector_'), true);

    const customTemplate = await jsonRequest(`${baseUrl}/api/content/template-versions`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: task.projectId,
        id: 'template_api_brand',
        versionId: 'template_api_brand_v1',
        name: '品牌模板',
        backgroundRef: 'fixture://background.png',
        logoRef: 'fixture://logo.png',
        captionFontName: 'PingFang SC',
        captionFontSize: 54,
        safeArea: { top: 120, bottom: 240, left: 72, right: 72 },
        approved: true,
        batchAllowed: true,
      }),
    });
    assert.equal(customTemplate.response.status, 201, JSON.stringify(customTemplate.payload));
    assert.equal(customTemplate.payload.version.id, 'template_api_brand_v1');

    const avatars = [];
    for (const [index, name] of ['甲', '乙'].entries()) {
      const result = await jsonRequest(`${baseUrl}/api/content/avatar-profiles`, {
        method: 'POST',
        body: JSON.stringify({
          projectId: task.projectId,
          id: `avatar_api_${index + 1}`,
          versionId: `avatar_api_v${index + 1}`,
          name: `数字人${name}`,
          canonicalImageRef: `fixture://avatar-${index + 1}.png`,
          baseVideoRef: `fixture://avatar-${index + 1}.mp4`,
          authorizationStatus: 'approved',
          authorizationRef: `consent://avatar-${index + 1}`,
          batchAllowed: true,
          approved: true,
        }),
      });
      assert.equal(result.response.status, 201);
      avatars.push(result.payload.version);
    }

    const voice = await jsonRequest(`${baseUrl}/api/content/voice-profiles`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: task.projectId,
        id: 'voice_api_1',
        versionId: 'voice_api_v1',
        name: '标准声音',
        referenceAudioRef: 'fixture://voice.wav',
        authorizationStatus: 'approved',
        authorizationRef: 'consent://voice',
        batchAllowed: true,
        approved: true,
      }),
    });
    assert.equal(voice.response.status, 201);

    const scripts = await jsonRequest(`${baseUrl}/api/content/script-sets`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: task.projectId,
        taskId: task.id,
        id: 'script_api_set',
        name: '三条脚本',
        approved: true,
        versions: [
          { id: 'script_api_v1', text: '第一条脚本' },
          { id: 'script_api_v2', text: '第二条脚本' },
          { id: 'script_api_v3', text: '第三条脚本' },
        ],
      }),
    });
    assert.equal(scripts.response.status, 201);

    const catalog = await jsonRequest(`${baseUrl}/api/content/batches/catalog?projectId=${encodeURIComponent(task.projectId)}&taskId=${encodeURIComponent(task.id)}`);
    const templateVersionId = customTemplate.payload.version.id;
    const connectorId = catalog.payload.catalog.defaults.connectorId;
    const planRequest = {
      projectId: task.projectId,
      taskId: task.id,
      avatarVersionIds: avatars.map((item) => item.id),
      voiceVersionId: voice.payload.version.id,
      scriptVersionIds: scripts.payload.scriptSet.versions.map((item) => item.id),
      templateVersionId,
      connectorId,
    };
    const plan = await jsonRequest(`${baseUrl}/api/content/batches/plan`, { method: 'POST', body: JSON.stringify(planRequest) });
    assert.equal(plan.response.status, 200);
    assert.equal(plan.payload.plan.count, 6);
    assert.equal(new Set(plan.payload.plan.items.map((item) => item.idempotencyKey)).size, 6);

    const createdBatch = await jsonRequest(`${baseUrl}/api/content/batches`, {
      method: 'POST',
      body: JSON.stringify({ ...planRequest, id: 'batch_api_fixture', title: '2x3 批量口播' }),
    });
    assert.equal(createdBatch.response.status, 201);
    assert.equal(createdBatch.payload.batch.status, 'waiting_approval');
    assert.equal(createdBatch.payload.batch.items.length, 6);

    const duplicateBatch = await jsonRequest(`${baseUrl}/api/content/batches`, {
      method: 'POST',
      body: JSON.stringify({ ...planRequest, id: 'batch_api_fixture', title: '重复提交不应覆盖' }),
    });
    assert.equal(duplicateBatch.response.status, 200);
    assert.equal(duplicateBatch.payload.batch.status, 'waiting_approval');
    assert.equal(duplicateBatch.payload.batch.items.length, 6);

    const started = await jsonRequest(`${baseUrl}/api/content/batches/${createdBatch.payload.batch.id}/start`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(started.response.status, 200, started.payload.error || JSON.stringify(started.payload));
    assert.equal(started.payload.batch.status, 'waiting_review');
    assert.equal(started.payload.batch.summary.succeeded, 6);
    assert.equal(started.payload.batch.items[0].output.simulated, true);
    assert.equal(started.payload.batch.modelRuns.length, 6);
    assert.equal(started.payload.batch.qualityReports.length, 6);
    assert.equal(started.payload.batch.metrics.concurrencyLimit, 1);
    assert.equal(started.payload.batch.metrics.observedConcurrency, 1);
    assert.equal(started.payload.batch.metrics.itemCount, 6);
    assert.equal(started.payload.batch.metrics.succeeded, 6);
    assert.equal(Number.isFinite(started.payload.batch.metrics.durationP50Ms), true);
    assert.equal(Number.isFinite(started.payload.batch.metrics.durationP95Ms), true);

    const auditBefore = await jsonRequest(`${baseUrl}/api/content/batches/${createdBatch.payload.batch.id}/audit`);
    assert.equal(auditBefore.response.status, 200);
    assert.equal(auditBefore.payload.audit.batchId, createdBatch.payload.batch.id);
    assert.equal(auditBefore.payload.audit.media.allAutoChecked, true);
    const auditRecorded = await jsonRequest(`${baseUrl}/api/content/batches/${createdBatch.payload.batch.id}/audit`, {
      method: 'POST',
      body: JSON.stringify({
        sampling: {
          ratio: 0.5,
          itemIds: started.payload.batch.items.slice(0, 3).map((item) => item.id),
          expanded: false,
        },
        humanReview: { durationMs: 120000, notes: '本地模拟批次抽样记录' },
      }),
    });
    assert.equal(auditRecorded.response.status, 200, auditRecorded.payload.error || JSON.stringify(auditRecorded.payload));
    assert.equal(auditRecorded.payload.batch.auditRecord.humanReview.durationMs, 120000);
    assert.equal(auditRecorded.payload.audit.human.sampleItemIds.length, 3);

    const itemId = started.payload.batch.items[0].id;
    const returned = await jsonRequest(`${baseUrl}/api/content/batches/${createdBatch.payload.batch.id}/items/${itemId}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'changes_requested', note: '需要重新生成' }),
    });
    assert.equal(returned.response.status, 200);
    assert.equal(returned.payload.batch.status, 'waiting_review');
    assert.equal(returned.payload.batch.items[0].status, 'changes_requested');

    const regenerated = await jsonRequest(`${baseUrl}/api/content/batches/${createdBatch.payload.batch.id}/items/${itemId}/retry`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(regenerated.response.status, 200, regenerated.payload.error || JSON.stringify(regenerated.payload));
    assert.equal(regenerated.payload.batch.status, 'waiting_review');
    assert.equal(regenerated.payload.batch.items[0].status, 'succeeded');

    const simulatedReview = await jsonRequest(`${baseUrl}/api/content/batches/${createdBatch.payload.batch.id}/items/${itemId}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', note: '首条本地模拟输出不可交付' }),
    });
    assert.equal(simulatedReview.response.status, 409);
    assert.match(simulatedReview.payload.error, /模拟输出/);

    const approvedVideoPath = join(dataDir, 'approved-video.mp4');
    await writeFile(approvedVideoPath, Buffer.concat([Buffer.from('0000ftypisom'), Buffer.alloc(2_048)]));
    const database = new DatabaseSync(join(dataDir, 'workbench.sqlite'));
    const itemRow = database.prepare('SELECT payload_json FROM content_batch_items WHERE id = ?').get(itemId);
    const itemPayload = JSON.parse(itemRow.payload_json);
    itemPayload.output = {
      ...itemPayload.output,
      simulated: false,
      simulationOnly: false,
      executionStatus: 'worker_output',
      videoRef: pathToFileURL(approvedVideoPath).href,
      audioRef: null,
    };
    database.prepare('UPDATE content_batch_items SET payload_json = ? WHERE id = ?').run(JSON.stringify(itemPayload), itemId);
    database.close();

    const reviewed = await jsonRequest(`${baseUrl}/api/content/batches/${createdBatch.payload.batch.id}/items/${itemId}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', note: '首条本地文件测试产物通过' }),
    });
    assert.equal(reviewed.response.status, 200, reviewed.payload.error || JSON.stringify(reviewed.payload));
    assert.equal(reviewed.payload.batch.items[0].status, 'approved');

    const videoFile = await fetch(`${baseUrl}/api/content/batches/${createdBatch.payload.batch.id}/items/${encodeURIComponent(itemId)}/file?kind=video`);
    assert.equal(videoFile.status, 200);
    assert.match(videoFile.headers.get('content-type') || '', /^video\/mp4/);
    assert.ok((await videoFile.arrayBuffer()).byteLength > 2_000);
    const videoRange = await fetch(`${baseUrl}/api/content/batches/${createdBatch.payload.batch.id}/items/${encodeURIComponent(itemId)}/file?kind=video`, {
      headers: { range: 'bytes=0-3' },
    });
    assert.equal(videoRange.status, 206);
    assert.equal(videoRange.headers.get('content-range'), 'bytes 0-3/2060');
    assert.equal((await videoRange.arrayBuffer()).byteLength, 4);

    const exported = await jsonRequest(`${baseUrl}/api/content/batches/${createdBatch.payload.batch.id}/export`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(exported.response.status, 200);
    assert.equal(exported.payload.export.status, 'partial');
    assert.equal(exported.payload.export.approvedCount, 1);
    assert.equal(exported.payload.export.pendingCount, 5);
    assert.match(exported.payload.export.manifest, /batch_api_fixture/);
    assert.match(exported.payload.export.package.filename, /\.zip$/);
    assert.ok((await statFile(exported.payload.export.package.path)).size > 0);
    assert.equal(exported.payload.export.package.files[0].kind, 'video');
    assert.match(exported.payload.export.package.files[0].sha256, /^[a-f0-9]{64}$/);
    assert.match(exported.payload.batch.exportRecord.package.manifestSha256, /^[a-f0-9]{64}$/);
    assert.equal(exported.payload.batch.exportRecord.package.missingFiles.length, 0);

    const rejected = await jsonRequest(`${baseUrl}/api/content/batches/plan`, {
      method: 'POST',
      body: JSON.stringify({ ...planRequest, avatarVersionIds: ['missing-avatar'] }),
    });
    assert.equal(rejected.response.status, 409);
    assert.match(rejected.payload.error, /数字人版本/);

    const cancelled = await jsonRequest(`${baseUrl}/api/content/batches/${createdBatch.payload.batch.id}/cancel`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.payload.batch.status, 'cancelled');
    assert.equal(cancelled.payload.batch.items.filter((item) => item.status === 'approved').length, 1);
    assert.equal(cancelled.payload.batch.items.filter((item) => item.status === 'cancelled').length, 5);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('content batch normalizes local media paths before calling an external worker and postprocesses its output', async (t) => {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5_000 });
  } catch {
    t.skip('ffmpeg is not installed');
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-content-batch-paths-'));
  const appPort = 32700 + Math.floor(Math.random() * 150);
  const generatedVideoPath = join(dataDir, 'generated.mp4');
  let received = null;
  const worker = createHttpServer((request, response) => {
    const send = (status, payload) => {
      const body = Buffer.from(JSON.stringify(payload));
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
      response.end(body);
    };
    if (request.method === 'GET' && request.url === '/health') {
      send(200, { protocol: 'content-media-worker-v1', status: 'ready', capabilities: ['talking_head'], workerVersion: 'path-test-worker', simulation: true });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/media/generate') {
      send(404, { message: 'not found' });
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received = JSON.parse(body);
      send(200, {
        protocol: 'content-media-worker-v1',
        requestId: 'path-test-request',
        output: {
          outputKind: 'video',
          videoRef: pathToFileURL(generatedVideoPath).toString(),
          transcript: '批次成片第一句\n批次成片第二句',
          segments: [
            { start: 0.0, end: 1.1, text: '批次成片第一句' },
            { start: 1.1, end: 2.4, text: '批次成片第二句' },
          ],
          modelVersion: 'path-test-model',
          simulated: false,
          reviewRequired: true,
        },
      });
    });
  });
  worker.listen(0, '127.0.0.1');
  await once(worker, 'listening');
  const workerPort = worker.address().port;
  await Promise.all([
    writeFile(join(dataDir, 'accounts.json'), '[]'),
    writeFile(join(dataDir, 'works.json'), '[]'),
    writeFile(join(dataDir, 'activity.json'), '[]'),
    writeFile(join(dataDir, 'feedback.json'), '[]'),
    writeFile(join(dataDir, 'content-tasks.json'), '[]'),
  ]);
  const avatarVideoPath = join(dataDir, 'avatar.mp4');
  const avatarImagePath = join(dataDir, 'avatar.png');
  const voicePath = join(dataDir, 'voice.wav');
  await Promise.all([
    writeFile(avatarVideoPath, 'video'),
    writeFile(avatarImagePath, 'image'),
    writeFile(voicePath, 'audio'),
  ]);
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', generatedVideoPath,
  ], { timeout: 30_000 });
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      XHS_DATA_DIR: dataDir,
      XHS_MEDIA_ROOTS: dataDir,
      XHS_MONITOR_PORT: String(appPort),
      XHS_REFRESH_MINUTES: '0',
      XHS_MEDIA_WORKER_URL: `http://127.0.0.1:${workerPort}`,
      XHS_MEDIA_WORKER_ID: 'connector_path_test_worker',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(appPort, child);
    const baseUrl = `http://127.0.0.1:${appPort}`;
    const taskResult = await jsonRequest(`${baseUrl}/api/content/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: '批次路径规范化', objective: '验证外部 Worker 收到受控 file 引用' }),
    });
    assert.equal(taskResult.response.status, 201);
    const task = taskResult.payload.task;
    const avatar = await jsonRequest(`${baseUrl}/api/content/avatar-profiles`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: task.projectId,
        id: 'avatar_path_test',
        versionId: 'avatar_path_test_v1',
        name: '路径测试人物',
        canonicalImageRef: avatarImagePath,
        baseVideoRef: avatarVideoPath,
        authorizationStatus: 'approved',
        authorizationRef: 'consent://path-avatar',
        batchAllowed: true,
        approved: true,
      }),
    });
    assert.equal(avatar.response.status, 201, JSON.stringify(avatar.payload));
    const voice = await jsonRequest(`${baseUrl}/api/content/voice-profiles`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: task.projectId,
        id: 'voice_path_test',
        versionId: 'voice_path_test_v1',
        name: '路径测试声音',
        referenceAudioRef: voicePath,
        licenseRef: 'license://path-test',
        authorizationStatus: 'approved',
        authorizationRef: 'consent://path-voice',
        batchAllowed: true,
        approved: true,
      }),
    });
    assert.equal(voice.response.status, 201, JSON.stringify(voice.payload));
    const scripts = await jsonRequest(`${baseUrl}/api/content/script-sets`, {
      method: 'POST',
      body: JSON.stringify({ projectId: task.projectId, taskId: task.id, id: 'script_path_test', name: '路径测试脚本', approved: true, versions: [{ id: 'script_path_test_v1', text: '路径规范化测试。' }] }),
    });
    assert.equal(scripts.response.status, 201, JSON.stringify(scripts.payload));
    const catalog = await jsonRequest(`${baseUrl}/api/content/batches/catalog?projectId=${encodeURIComponent(task.projectId)}&taskId=${encodeURIComponent(task.id)}`);
    const remote = catalog.payload.catalog.connectors.find((item) => item.id === 'connector_path_test_worker');
    const planRequest = {
      projectId: task.projectId,
      taskId: task.id,
      avatarVersionIds: [avatar.payload.version.id],
      voiceVersionId: voice.payload.version.id,
      scriptVersionIds: [scripts.payload.scriptSet.versions[0].id],
      templateVersionId: catalog.payload.catalog.defaults.templateVersionId,
      connectorId: remote.id,
    };
    const created = await jsonRequest(`${baseUrl}/api/content/batches`, { method: 'POST', body: JSON.stringify({ ...planRequest, id: 'path_test_batch' }) });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    const executed = await jsonRequest(`${baseUrl}/api/content/batches/path_test_batch/start`, { method: 'POST', body: '{}' });
    assert.equal(executed.response.status, 200, JSON.stringify(executed.payload));
    assert.ok(received);
    assert.equal(received.operation, 'batch_media');
    assert.equal(received.input.avatar.baseVideoRef, pathToFileURL(await realpath(avatarVideoPath)).toString());
    assert.equal(received.input.avatar.canonicalImageRef, pathToFileURL(await realpath(avatarImagePath)).toString());
    assert.equal(received.input.voice.referenceAudioRef, pathToFileURL(await realpath(voicePath)).toString());
    assert.equal(received.input.voice.authorizationRef, 'consent://path-voice');
    assert.equal(received.input.voice.licenseRef, 'license://path-test');
    const item = executed.payload.batch.items[0];
    assert.equal(item.output.assetIds.length, 1);
    const assets = await jsonRequest(`${baseUrl}/api/content/tasks/${encodeURIComponent(task.id)}/assets`);
    const generated = assets.payload.assets.find((asset) => asset.id === item.output.assetIds[0]);
    assert.equal(generated.kind, 'video');
    assert.equal(generated.status, 'generated');
    assert.equal(generated.metadata.source, 'media_worker');
    assert.equal(generated.metadata.mediaCheck.status, 'succeeded');
    assert.equal(generated.metadata.mediaCheck.kind, 'video');
    assert.equal(generated.metadata.mediaCheck.streams.some((stream) => stream.codec_type === 'video'), true);
    assert.deepEqual(generated.metadata.transcriptResult.segments, [
      { start: 0.0, end: 1.1, text: '批次成片第一句' },
      { start: 1.1, end: 2.4, text: '批次成片第二句' },
    ]);
    const validGeneratedVideoPath = join(dataDir, 'generated-valid.mp4');
    await copyFile(generatedVideoPath, validGeneratedVideoPath);
    await writeFile(generatedVideoPath, Buffer.from('broken media output'));
    const failedPostprocess = await jsonRequest(`${baseUrl}/api/content/batches/path_test_batch/items/${encodeURIComponent(item.id)}/postprocess`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(failedPostprocess.response.status, 409);
    const afterFailure = await jsonRequest(`${baseUrl}/api/content/batches/path_test_batch`);
    assert.equal(afterFailure.payload.batch.items[0].output.postprocess.status, 'failed');
    assert.equal(afterFailure.payload.batch.items[0].output.postprocess.sourceAssetId, generated.id);
    assert.equal(Number.isFinite(afterFailure.payload.batch.items[0].output.postprocess.durationMs), true);
    assert.match(afterFailure.payload.batch.items[0].output.postprocess.error.code, /^MEDIA_/);
    await copyFile(validGeneratedVideoPath, generatedVideoPath);
    const postprocessed = await jsonRequest(`${baseUrl}/api/content/batches/path_test_batch/items/${encodeURIComponent(item.id)}/postprocess`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(postprocessed.response.status, 200, JSON.stringify(postprocessed.payload));
    const postprocess = postprocessed.payload.batch.items[0].output.postprocess;
    assert.equal(postprocess.status, 'succeeded');
    assert.equal(postprocess.sourceAssetId, generated.id);
    assert.equal(Number.isFinite(postprocess.durationMs), true);
    assert.equal(postprocess.assetIds.length, 4);
    assert.ok(postprocess.assSubtitleAssetId);
    assert.equal(postprocessed.payload.batch.items[0].output.assetIds.length, 5);
    assert.equal(postprocessed.payload.batch.qualityReports.at(-1).checks.mediaChecks[0].status, 'succeeded');
    const postprocessedAssets = (await jsonRequest(`${baseUrl}/api/content/tasks/${encodeURIComponent(task.id)}/assets`)).payload.assets;
    const rendered = postprocessedAssets.find((asset) => asset.id === postprocess.renderedAssetId);
    const subtitle = postprocessedAssets.find((asset) => asset.id === postprocess.subtitleAssetId);
    const assSubtitle = postprocessedAssets.find((asset) => asset.id === postprocess.assSubtitleAssetId);
    const cover = postprocessedAssets.find((asset) => asset.id === postprocess.coverAssetId);
    assert.deepEqual([rendered.kind, rendered.status, rendered.metadata.render.width, rendered.metadata.render.height], ['video', 'rendered', 1080, 1920]);
    assert.equal(rendered.metadata.mediaCheck.status, 'succeeded');
    assert.equal(rendered.metadata.mediaCheck.kind, 'video');
    assert.equal(rendered.metadata.render.subtitleBurnIn, 'sharp_overlay');
    assert.equal(rendered.metadata.render.subtitleSegmentCount, 2);
    assert.equal(subtitle.mimeType, 'application/x-subrip');
    assert.match(subtitle.textContent, /00:00:01,100/);
    assert.equal(assSubtitle.mimeType, 'text/x-ass');
    assert.match(assSubtitle.textContent, /\[V4\+ Styles\]/);
    assert.deepEqual([cover.kind, cover.status, cover.metadata.cover.width, cover.metadata.cover.height], ['image', 'generated', 1080, 1440]);
    assert.equal(cover.metadata.mediaCheck.status, 'succeeded');
    assert.equal(cover.metadata.mediaCheck.kind, 'image');
    const reviewed = await jsonRequest(`${baseUrl}/api/content/batches/path_test_batch/items/${encodeURIComponent(item.id)}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', note: '模板后处理结果通过' }),
    });
    assert.equal(reviewed.response.status, 200, JSON.stringify(reviewed.payload));
    const exported = await jsonRequest(`${baseUrl}/api/content/batches/path_test_batch/export`, { method: 'POST', body: '{}' });
    assert.equal(exported.response.status, 200, JSON.stringify(exported.payload));
    assert.deepEqual(exported.payload.export.package.files.map((file) => file.kind).sort(), ['cover', 'subtitle', 'video']);
    assert.equal(exported.payload.export.package.missingFiles.length, 0);
    assert.equal(exported.payload.export.package.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)), true);
    assert.match(exported.payload.batch.exportRecord.package.manifestSha256, /^[a-f0-9]{64}$/);
    const manifest = JSON.parse(await readFile(exported.payload.export.manifest, 'utf8'));
    assert.equal(manifest.version, 'content-batch-export-v1');
    assert.equal(manifest.items[0].packageFiles.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)), true);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await new Promise((resolvePromise, reject) => worker.close((error) => error ? reject(error) : resolvePromise()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
