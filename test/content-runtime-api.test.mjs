import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));
const execFileAsync = promisify(execFile);

async function hasFfmpeg() {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before becoming ready');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(400) });
      if (response.ok) return;
    } catch {
      // Startup refresh may still be initializing.
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
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

test('content runtime parses a real local text asset, writes SQLite and indexes knowledge', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-runtime-'));
  const port = 32600 + Math.floor(Math.random() * 200);
  const materialPath = join(dataDir, 'source.md');
  await Promise.all([
    writeFile(join(dataDir, 'accounts.json'), '[]'),
    writeFile(join(dataDir, 'works.json'), '[]'),
    writeFile(join(dataDir, 'activity.json'), '[]'),
    writeFile(join(dataDir, 'feedback.json'), '[]'),
    writeFile(join(dataDir, 'content-tasks.json'), '[]'),
    writeFile(materialPath, '# 目标\n验证知识库检索和素材解析\n', 'utf8'),
  ]);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: '',
      XHS_LOCAL_DRAFT_GENERATOR: 'true',
      XHS_DATA_DIR: dataDir,
      XHS_MONITOR_PORT: String(port),
      XHS_MEDIA_ROOTS: dataDir,
      XHS_REFRESH_MINUTES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(port, child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const workspace = await jsonRequest(baseUrl + '/api/workspace');
    assert.equal(workspace.response.status, 200);
    assert.equal(workspace.payload.storage.type, 'sqlite');
    const state = await jsonRequest(baseUrl + '/api/state');
    assert.equal(state.response.status, 200);
    assert.equal(state.payload.accounts.length, 0);
    assert.ok(workspace.payload.connectors.some((connector) => connector.capabilities.includes('media.probe')));
    assert.equal(workspace.payload.capabilities.subtitleBurnIn, await hasFfmpeg());

    const customer = await jsonRequest(baseUrl + '/api/workspace/customers', {
      method: 'POST',
      body: JSON.stringify({ name: '运行时验收客户', industry: '内容服务', metadata: { source: 'runtime-test' } }),
    });
    assert.equal(customer.response.status, 201, JSON.stringify(customer.payload));
    const brandProfile = await jsonRequest(baseUrl + '/api/workspace/brand-profiles', {
      method: 'POST',
      body: JSON.stringify({
        projectId: workspace.payload.project.id,
        customerId: customer.payload.customer.id,
        name: '运行时品牌资料',
        voice: '清晰可信',
        constraints: { forbiddenClaims: ['绝对化承诺'] },
      }),
    });
    assert.equal(brandProfile.response.status, 201, JSON.stringify(brandProfile.payload));
    const contextWorkspace = await jsonRequest(baseUrl + '/api/workspace');
    assert.ok(contextWorkspace.payload.customers.some((item) => item.id === customer.payload.customer.id));
    assert.ok(contextWorkspace.payload.brandProfiles.some((item) => item.id === brandProfile.payload.brandProfile.id));

    const created = await jsonRequest(baseUrl + '/api/content/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: '运行时素材任务',
        objective: '验证真实文件进入内容工作流',
        customerId: customer.payload.customer.id,
        brandProfileId: brandProfile.payload.brandProfile.id,
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.task.customerId, customer.payload.customer.id);
    assert.equal(created.payload.task.brandProfileId, brandProfile.payload.brandProfile.id);
    const taskId = created.payload.task.id;
    const taskList = await jsonRequest(baseUrl + '/api/content/tasks');
    assert.equal(taskList.response.status, 200);
    assert.equal(taskList.payload.tasks.find((task) => task.id === taskId).projectId, workspace.payload.project.id);
    const registeredTemplate = await jsonRequest(baseUrl + '/api/content/template-versions', {
      method: 'POST',
      body: JSON.stringify({
        projectId: taskList.payload.tasks.find((task) => task.id === taskId).projectId,
        name: '运行时模板登记',
        approved: true,
        batchAllowed: true,
        coverText: '运行时封面',
      }),
    });
    assert.equal(registeredTemplate.response.status, 201, JSON.stringify(registeredTemplate.payload));
    assert.equal(registeredTemplate.payload.version.batchAllowed, true);
    await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/start`, { method: 'POST', body: '{}' });
    const brandNode = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/execute-node`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'CE-02' }),
    });
    assert.equal(brandNode.response.status, 200, JSON.stringify(brandNode.payload));
    assert.equal(brandNode.payload.task.nodes.find((node) => node.id === 'CE-02').output.brandProfile.name, '运行时品牌资料');
    const knowledgeNode = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/execute-node`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'CE-03', query: '运行时' }),
    });
    assert.equal(knowledgeNode.response.status, 200, JSON.stringify(knowledgeNode.payload));
    assert.equal(knowledgeNode.payload.task.nodes.find((node) => node.id === 'CE-03').status, 'succeeded');
    const authorizationMissing = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/materials/parse`, {
      method: 'POST',
      body: JSON.stringify({ path: materialPath }),
    });
    assert.equal(authorizationMissing.response.status, 409);
    assert.equal(authorizationMissing.payload.code, 'MEDIA_AUTHORIZATION_REQUIRED');
    assert.equal(authorizationMissing.payload.task.nodes.find((node) => node.id === 'CE-04').status, 'blocked');
    const retriedImport = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/retry`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'CE-04' }),
    });
    assert.equal(retriedImport.response.status, 200, JSON.stringify(retriedImport.payload));
    const approvedParsed = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/materials/parse`, {
      method: 'POST',
      body: JSON.stringify({
        path: materialPath,
        sourceRef: 'runtime-test://source-material',
        authorizationStatus: 'approved',
        authorizationRef: 'runtime-test://consent/source-material',
      }),
    });
    assert.equal(approvedParsed.response.status, 200, JSON.stringify(approvedParsed.payload));
    assert.equal(approvedParsed.payload.asset.kind, 'text');
    assert.equal(approvedParsed.payload.asset.metadata.sourceType, 'user_material');
    assert.equal(approvedParsed.payload.asset.metadata.sourceRef, 'runtime-test://source-material');
    assert.equal(approvedParsed.payload.asset.metadata.authorizationStatus, 'approved');
    assert.equal(approvedParsed.payload.asset.metadata.authorizationRef, 'runtime-test://consent/source-material');
    assert.equal(approvedParsed.payload.asset.metadata.contentHash.length, 64);
    const parsed = approvedParsed;
    assert.equal(parsed.payload.asset.kind, 'text');
    assert.match(parsed.payload.asset.metadata.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(parsed.payload.task.nodes.find((node) => node.id === 'CE-04').status, 'succeeded');
    const duplicate = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/materials/parse`, {
      method: 'POST',
      body: JSON.stringify({
        path: materialPath,
        sourceRef: 'runtime-test://source-material',
        authorizationStatus: 'approved',
        authorizationRef: 'runtime-test://consent/source-material',
      }),
    });
    assert.equal(duplicate.response.status, 200, JSON.stringify(duplicate.payload));
    assert.equal(duplicate.payload.asset.id, parsed.payload.asset.id);
    const assetsAfterDuplicate = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/assets`);
    assert.equal(assetsAfterDuplicate.payload.assets.filter((asset) => asset.id === parsed.payload.asset.id).length, 1);
    assert.equal(parsed.payload.task.nodes.find((node) => node.id === 'CE-05').status, 'succeeded');

    for (const nodeId of ['CE-06', 'CE-07', 'CE-08']) {
      const executed = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/execute-node`, {
        method: 'POST',
        body: JSON.stringify({ nodeId }),
      });
      assert.equal(executed.response.status, 200);
      assert.ok(['succeeded', 'skipped'].includes(executed.payload.task.nodes.find((node) => node.id === nodeId).status));
    }
    const analyzed = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/analyze`, { method: 'POST', body: '{}' });
    assert.equal(analyzed.response.status, 200);
    assert.equal(analyzed.payload.task.nodes.find((node) => node.id === 'CE-09').status, 'succeeded');
    assert.equal(analyzed.payload.structure.analysisMode, 'deterministic-extractive');
    assert.ok(analyzed.payload.structure.summary);
    assert.deepEqual(analyzed.payload.structure.evidenceGaps, ['未提供可定位的语音或画面来源']);

    const topic = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'topic', query: '知识库' }),
    });
    assert.equal(topic.response.status, 200);
    assert.equal(topic.payload.output.provider, 'local-template');
    assert.match(topic.payload.output.text, /候选选题/);
    assert.equal(topic.payload.task.nodes.find((node) => node.id === 'CE-10').status, 'succeeded');

    const selectedTopic = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/topic-selection`, {
      method: 'POST',
      body: JSON.stringify({
        selection: '围绕知识库中的实操方向做一条内容',
        candidateIndex: 1,
        note: '本地测试人工选题',
      }),
    });
    assert.equal(selectedTopic.response.status, 200, JSON.stringify(selectedTopic.payload));
    assert.equal(selectedTopic.payload.selection.candidateIndex, 1);
    assert.equal(
      selectedTopic.payload.task.nodes.find((node) => node.id === 'CE-10').trace.confirmation.confirmedBy,
      selectedTopic.payload.task.owner.username,
    );

    const copy = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'copy', query: '知识库' }),
    });
    assert.equal(copy.response.status, 200);
    assert.equal(copy.payload.output.provider, 'local-template');
    assert.equal(copy.payload.task.nodes.find((node) => node.id === 'CE-11').status, 'succeeded');

    for (const [kind, nodeId] of [['platform', 'CE-12'], ['shotlist', 'CE-13']]) {
      const generated = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/generate`, {
        method: 'POST',
        body: JSON.stringify({ kind, query: '知识库' }),
      });
      assert.equal(generated.response.status, 200);
      assert.equal(generated.payload.output.provider, 'local-template');
      assert.equal(generated.payload.task.nodes.find((node) => node.id === nodeId).status, 'succeeded');
    }

    for (const nodeId of ['CE-14', 'CE-15', 'CE-16', 'CE-17', 'CE-18']) {
      const executed = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/execute-node`, {
        method: 'POST',
        body: JSON.stringify({ nodeId }),
      });
      assert.equal(executed.response.status, 200);
      assert.equal(executed.payload.task.nodes.find((node) => node.id === nodeId).status, 'skipped');
    }

    const reviewChecklist = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/execute-node`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'CE-19' }),
    });
    assert.equal(reviewChecklist.response.status, 200);
    assert.equal(reviewChecklist.payload.task.nodes.find((node) => node.id === 'CE-19').status, 'succeeded');

    const approved = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', note: '本地测试内容通过审核' }),
    });
    assert.equal(approved.response.status, 200);
    assert.equal(approved.payload.task.nodes.find((node) => node.id === 'CE-22').status, 'ready');

    const authorizationDatabase = new DatabaseSync(join(dataDir, 'workbench.sqlite'));
    const sourceRow = authorizationDatabase.prepare('SELECT metadata_json FROM media_assets WHERE id = ?').get(parsed.payload.asset.id);
    const revokedMetadata = JSON.parse(sourceRow.metadata_json);
    revokedMetadata.authorizationStatus = 'revoked';
    delete revokedMetadata.sourceType;
    authorizationDatabase.prepare('UPDATE media_assets SET metadata_json = ? WHERE id = ?').run(JSON.stringify(revokedMetadata), parsed.payload.asset.id);
    authorizationDatabase.close();
    const blockedPackage = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/package`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(blockedPackage.response.status, 409, JSON.stringify(blockedPackage.payload));
    assert.equal(blockedPackage.payload.code, 'MEDIA_AUTHORIZATION_REQUIRED');
    assert.equal(blockedPackage.payload.task.nodes.find((node) => node.id === 'CE-22').status, 'blocked');
    const retryPackage = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/retry`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'CE-22' }),
    });
    assert.equal(retryPackage.response.status, 200, JSON.stringify(retryPackage.payload));
    const authorizationRestoredDatabase = new DatabaseSync(join(dataDir, 'workbench.sqlite'));
    revokedMetadata.authorizationStatus = 'approved';
    authorizationRestoredDatabase.prepare('UPDATE media_assets SET metadata_json = ? WHERE id = ?').run(JSON.stringify(revokedMetadata), parsed.payload.asset.id);
    authorizationRestoredDatabase.close();
    const packaged = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/package`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(packaged.response.status, 200);
    assert.equal(packaged.payload.task.nodes.find((node) => node.id === 'CE-22').status, 'succeeded');
    assert.ok(packaged.payload.package.path);
    assert.ok(packaged.payload.package.manifest.endsWith('-manifest.json'));
    const packageBytes = await readFile(packaged.payload.package.path);
    assert.ok(packageBytes.includes(Buffer.from('-manifest.json')));
    const manifest = JSON.parse(await readFile(packaged.payload.package.manifest, 'utf8'));
    assert.equal(manifest.schemaVersion, 'content-package-v0.1');
    assert.match(manifest.nodes.find((node) => node.id === 'CE-10').output.text, /候选选题/);
    assert.equal(manifest.reviews.length, 1);

    const releaseDraft = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/release-drafts`, {
      method: 'POST',
      body: JSON.stringify({ platform: 'xhs', title: '本地测试草稿', text: '仅供测试，不直接发布' }),
    });
    assert.equal(releaseDraft.response.status, 201);
    assert.equal(releaseDraft.payload.task.nodes.find((node) => node.id === 'CE-23').status, 'succeeded');

    const forbiddenPublishRecord = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/nodes/CE-24/record`, {
      method: 'POST',
      body: JSON.stringify({ status: 'succeeded', output: { published: true } }),
    });
    assert.equal(forbiddenPublishRecord.response.status, 409);
    assert.equal(forbiddenPublishRecord.payload.code, 'PUBLISH_OUTSIDE_P0');

    const feedback = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({
        status: 'not_published',
        platform: 'xhs',
        note: '仅完成本地内容包和发布草稿，未执行外部发布',
        nextAction: '等待负责人验收内容包，再单独规划 N1',
      }),
    });
    assert.equal(feedback.response.status, 200, JSON.stringify(feedback.payload));
    assert.equal(feedback.payload.task.nodes.find((node) => node.id === 'CE-24').status, 'skipped');
    assert.equal(feedback.payload.task.nodes.find((node) => node.id === 'CE-25').status, 'succeeded');
    assert.equal(feedback.payload.task.feedback.length, 1);

    const knowledge = await jsonRequest(baseUrl + '/api/knowledge/search?q=知识库');
    assert.equal(knowledge.response.status, 200);
    assert.equal(knowledge.payload.results.length, 1);
    const dbStat = await readFile(join(dataDir, 'workbench.sqlite'));
    assert.ok(dbStat.length > 0);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('content runtime renders a vertical video and creates an independent cover asset', async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-media-runtime-'));
  const port = 32800 + Math.floor(Math.random() * 200);
  const materialPath = join(dataDir, 'source.mp4');
  const generatedPath = join(dataDir, 'generated.mp4');
  const plainAudioPath = join(dataDir, 'plain.wav');
  const transcribeCommand = join(dataDir, 'transcribe.mjs');
  const ocrCommand = join(dataDir, 'ocr.mjs');
  const transcriptSrt = ['1', '00:00:00,250 --> 00:00:01,750', '第一句', '', '2', '00:00:02,000 --> 00:00:02,900', '第二句'].join(String.fromCharCode(10));
  await Promise.all([
    writeFile(join(dataDir, 'accounts.json'), '[]'),
    writeFile(join(dataDir, 'works.json'), '[]'),
    writeFile(join(dataDir, 'activity.json'), '[]'),
    writeFile(join(dataDir, 'feedback.json'), '[]'),
    writeFile(join(dataDir, 'content-tasks.json'), '[]'),
    writeFile(transcribeCommand, `const path = process.argv[2] || ''; process.stdout.write(path.endsWith('plain.wav') ? '只有文字没有时间码' : ${JSON.stringify(transcriptSrt)});\n`, 'utf8'),
    writeFile(ocrCommand, "process.stdout.write(JSON.stringify({items: [{text: '画面文字', confidence: 0.88, box: {x: 18, y: 24, width: 160, height: 42}}]}));\n", 'utf8'),
  ]);
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=orange:s=640x360:d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', materialPath,
  ], { timeout: 30_000 });
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', plainAudioPath,
  ], { timeout: 30_000 });
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', generatedPath,
  ], { timeout: 30_000 });
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: '',
      XHS_LOCAL_DRAFT_GENERATOR: 'true',
      XHS_DATA_DIR: dataDir,
      XHS_MONITOR_PORT: String(port),
      XHS_MEDIA_ROOTS: dataDir,
      XHS_REFRESH_MINUTES: '0',
      XHS_TRANSCRIBE_COMMAND: `${process.execPath} ${transcribeCommand}`,
      XHS_OCR_COMMAND: `${process.execPath} ${ocrCommand}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(port, child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await jsonRequest(baseUrl + '/api/content/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '视频媒体链路验收', objective: '验证渲染、字幕和独立封面产物' }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    const taskId = created.payload.task.id;
    const started = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/start`, { method: 'POST', body: '{}' });
    assert.equal(started.response.status, 200);
    for (const nodeId of ['CE-02', 'CE-03']) {
      const recorded = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/nodes/${nodeId}/record`, {
        method: 'POST',
        body: JSON.stringify({ status: 'succeeded', output: { fixture: nodeId }, note: '媒体链路测试准备' }),
      });
      assert.equal(recorded.response.status, 200, `${nodeId}: ${JSON.stringify(recorded.payload)}`);
    }

    const parsed = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/materials/parse`, {
      method: 'POST',
      body: JSON.stringify({
        path: materialPath,
        sourceRef: 'runtime-test://video-material',
        authorizationStatus: 'approved',
        authorizationRef: 'runtime-test://consent/video-material',
      }),
    });
    assert.equal(parsed.response.status, 200, JSON.stringify(parsed.payload));
    const sourceAsset = parsed.payload.asset;
    assert.equal(sourceAsset.kind, 'video');
    assert.ok(sourceAsset.metadata.keyframe.frames.length >= 2);
    assert.equal(sourceAsset.transcript, '第一句\n第二句');
    assert.equal(sourceAsset.metadata.transcriptResult.segments[0].start, 0.25);
    assert.equal(sourceAsset.metadata.ocrResult.format, 'json');
    assert.equal(sourceAsset.metadata.ocrResult.detections[0].box.width, 160);

    for (const nodeId of ['CE-06', 'CE-07', 'CE-08']) {
      const recorded = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/nodes/${nodeId}/record`, {
        method: 'POST',
        body: JSON.stringify({ status: 'succeeded', output: { fixture: nodeId }, note: '媒体链路测试准备' }),
      });
      assert.equal(recorded.response.status, 200, `${nodeId}: ${JSON.stringify(recorded.payload)}`);
    }

    const analyzed = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/analyze`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(analyzed.response.status, 200, JSON.stringify(analyzed.payload));
    assert.equal(analyzed.payload.structure.analysisMode, 'deterministic-extractive');
    assert.ok(analyzed.payload.structure.summary);
    assert.deepEqual(analyzed.payload.structure.evidenceGaps, ['部分转写片段缺少置信度，需人工校对']);
    assert.equal(analyzed.payload.structure.sourceSegments[0].assetId, sourceAsset.id);
    assert.equal(analyzed.payload.structure.sourceSegments[0].start, 0.25);
    assert.equal(analyzed.payload.structure.sourceFrames[0].assetId, sourceAsset.id);
    assert.ok(analyzed.payload.structure.sourceFrames[0].timeSeconds >= 0);
    assert.equal(analyzed.payload.structure.sourceFrames[0].detections[0].box.width, 160);

    for (const nodeId of ['CE-10', 'CE-11', 'CE-12', 'CE-13', 'CE-14', 'CE-15']) {
      const recorded = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/nodes/${nodeId}/record`, {
        method: 'POST',
        body: JSON.stringify({ status: 'succeeded', output: { fixture: nodeId }, note: '媒体链路测试准备' }),
      });
      assert.equal(recorded.response.status, 200, `${nodeId}: ${JSON.stringify(recorded.payload)}`);
    }

    const generatedParsed = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/materials/parse`, {
      method: 'POST',
      body: JSON.stringify({
        path: generatedPath,
        sourceRef: 'runtime-test://generated-video',
        authorizationStatus: 'approved',
        authorizationRef: 'runtime-test://consent/generated-video',
      }),
    });
    assert.equal(generatedParsed.response.status, 200, JSON.stringify(generatedParsed.payload));
    const timedTranscript = {
      status: 'succeeded',
      format: 'srt',
      segments: [
        { start: 0.25, end: 1.75, text: '数字人生成视频第一句' },
        { start: 2, end: 2.9, text: '数字人生成视频第二句' },
      ],
    };
    const database = new DatabaseSync(join(dataDir, 'workbench.sqlite'));
    database.prepare('UPDATE media_assets SET status = ?, metadata_json = ?, transcript = ? WHERE id = ?').run(
      'generated',
      JSON.stringify({ source: 'media_worker', operation: 'talking_head', transcriptResult: timedTranscript }),
      '数字人生成视频第一句\n数字人生成视频第二句',
      generatedParsed.payload.asset.id,
    );
    database.close();

    const rendered = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/render`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(rendered.response.status, 200, JSON.stringify(rendered.payload));
    assert.equal(rendered.payload.task.nodes.find((node) => node.id === 'CE-16').output.sourceAssetId, generatedParsed.payload.asset.id);
    assert.equal(rendered.payload.render.width, 1080);
    assert.equal(rendered.payload.render.height, 1920);
    assert.equal(rendered.payload.render.subtitleBurnIn, 'sharp_overlay');
    assert.equal(rendered.payload.render.subtitleSegmentCount, 2);

    const subtitles = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/execute-node`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'CE-17' }),
    });
    assert.equal(subtitles.response.status, 200, JSON.stringify(subtitles.payload));
    assert.equal(subtitles.payload.task.nodes.find((node) => node.id === 'CE-17').status, 'succeeded');
    assert.equal(subtitles.payload.task.nodes.find((node) => node.id === 'CE-17').input.assetId, rendered.payload.asset.id);
    const subtitleOutput = subtitles.payload.task.nodes.find((node) => node.id === 'CE-17').output;
    assert.match(await readFile(subtitleOutput.path, 'utf8'), /00:00:00,250 --> 00:00:01,750/);
    assert.ok(subtitleOutput.assAssetId);
    assert.match(await readFile(subtitleOutput.assPath, 'utf8'), /\[V4\+ Styles\]/);

    const cover = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/execute-node`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'CE-18' }),
    });
    assert.equal(cover.response.status, 200, JSON.stringify(cover.payload));
    const coverOutput = cover.payload.task.nodes.find((node) => node.id === 'CE-18').output;
    assert.notEqual(coverOutput.assetId, sourceAsset.id);
    assert.equal(coverOutput.sourceAssetId, rendered.payload.asset.id);
    assert.equal(coverOutput.width, 1080);
    assert.equal(coverOutput.height, 1440);
    assert.equal(coverOutput.templateVersionId, 'edit_template_vertical_default_v1');
    const assets = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/assets`);
    assert.equal(assets.response.status, 200);
    const coverAsset = assets.payload.assets.find((asset) => asset.id === coverOutput.assetId);
    assert.equal(coverAsset.kind, 'image');
    assert.equal(coverAsset.mimeType, 'image/jpeg');
    assert.notEqual(coverAsset.path, sourceAsset.metadata.keyframe.path);
    const coverFileUrl = `${baseUrl}/api/content/tasks/${taskId}/assets/${encodeURIComponent(coverAsset.id)}/file`;
    const coverFile = await fetch(coverFileUrl);
    assert.equal(coverFile.status, 200);
    assert.match(coverFile.headers.get('content-type') || '', /^image\/jpeg/);
    assert.ok((await coverFile.arrayBuffer()).byteLength > 100);
    const coverRange = await fetch(coverFileUrl, { headers: { range: 'bytes=0-15' } });
    assert.equal(coverRange.status, 206);
    assert.equal((await coverRange.arrayBuffer()).byteLength, 16);

    const reviewChecklist = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/execute-node`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'CE-19' }),
    });
    assert.equal(reviewChecklist.response.status, 200, JSON.stringify(reviewChecklist.payload));
    const approved = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', note: '真实媒体产物回归测试通过' }),
    });
    assert.equal(approved.response.status, 200, JSON.stringify(approved.payload));
    const packaged = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/package`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(packaged.response.status, 200, JSON.stringify(packaged.payload));
    const releaseDraft = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/release-drafts`, {
      method: 'POST',
      body: JSON.stringify({ platform: 'xhs', title: '本地媒体回归草稿', text: '仅供测试，不直接发布' }),
    });
    assert.equal(releaseDraft.response.status, 201, JSON.stringify(releaseDraft.payload));
    const feedback = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ status: 'not_published', platform: 'xhs', note: '仅验证本地媒体闭环' }),
    });
    assert.equal(feedback.response.status, 200, JSON.stringify(feedback.payload));
    const retro = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'retro' }),
    });
    assert.equal(retro.response.status, 200, JSON.stringify(retro.payload));
    assert.doesNotMatch(retro.payload.output.text, /\[Script Info\]/);
    assert.match(retro.payload.output.sourceIndex, /\.mp4\b/);
    assert.match(retro.payload.output.sourceIndex, /画面帧/);
    assert.doesNotMatch(retro.payload.output.sourceIndex, /\.(?:srt|ass)\b/i);
    const retroNodeOutput = retro.payload.task.nodes.find((node) => node.id === 'CE-26').output;
    assert.ok(retroNodeOutput.sourceReferences.some((item) => item.filename === generatedParsed.payload.asset.filename));
    assert.doesNotMatch(JSON.stringify(retroNodeOutput.sourceReferences), /\.(?:srt|ass)\b/i);
    assert.doesNotMatch(JSON.stringify(retroNodeOutput.sourceReferences), /framePath|content-previews/);

    const plainTask = await jsonRequest(`${baseUrl}/api/content/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: '无时间码字幕阻断', objective: '验证字幕不使用固定估算时间码' }),
    });
    assert.equal(plainTask.response.status, 201);
    const plainTaskId = plainTask.payload.task.id;
    assert.equal((await jsonRequest(`${baseUrl}/api/content/tasks/${plainTaskId}/start`, { method: 'POST', body: '{}' })).response.status, 200);
    for (const nodeId of ['CE-02', 'CE-03']) {
      const recorded = await jsonRequest(`${baseUrl}/api/content/tasks/${plainTaskId}/nodes/${nodeId}/record`, {
        method: 'POST',
        body: JSON.stringify({ status: 'succeeded', output: { fixture: nodeId }, note: '无时间码字幕测试前置节点' }),
      });
      assert.equal(recorded.response.status, 200, JSON.stringify(recorded.payload));
    }
    const parsedPlain = await jsonRequest(`${baseUrl}/api/content/tasks/${plainTaskId}/materials/parse`, {
      method: 'POST',
      body: JSON.stringify({
        path: plainAudioPath,
        sourceRef: 'runtime-test://plain-audio',
        authorizationStatus: 'approved',
        authorizationRef: 'runtime-test://consent/plain-audio',
      }),
    });
    assert.equal(parsedPlain.response.status, 200, JSON.stringify(parsedPlain.payload));
    assert.equal(parsedPlain.payload.asset.transcript, '只有文字没有时间码');
    assert.equal(parsedPlain.payload.asset.metadata.transcriptResult.segments.length, 0);
    for (const nodeId of ['CE-06', 'CE-07', 'CE-08', 'CE-09', 'CE-10', 'CE-11', 'CE-12', 'CE-13', 'CE-14', 'CE-15', 'CE-16']) {
      const recorded = await jsonRequest(`${baseUrl}/api/content/tasks/${plainTaskId}/nodes/${nodeId}/record`, {
        method: 'POST',
        body: JSON.stringify({ status: 'succeeded', output: { fixture: nodeId }, note: '无时间码字幕测试前置节点' }),
      });
      assert.equal(recorded.response.status, 200, JSON.stringify(recorded.payload));
    }
    const subtitleBlocked = await jsonRequest(`${baseUrl}/api/content/tasks/${plainTaskId}/execute-node`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'CE-17' }),
    });
    assert.equal(subtitleBlocked.response.status, 409, JSON.stringify(subtitleBlocked.payload));
    assert.equal(subtitleBlocked.payload.code, 'MEDIA_TIMECODES_REQUIRED');
    assert.equal(subtitleBlocked.payload.task.nodes.find((node) => node.id === 'CE-17').status, 'blocked');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
