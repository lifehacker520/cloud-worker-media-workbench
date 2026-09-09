import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const PROJECT_DIR = resolve(import.meta.dirname, '..');
const WORKER = resolve(PROJECT_DIR, 'tools/media-model-worker/app.py');
const MACOS_SAY_WRAPPER = resolve(PROJECT_DIR, 'tools/media-model-worker/wrappers/macos_say_tts.py');
const PYTHON = process.env.CLOUD_WORKER_PYTHON || 'python3';
const execFileAsync = promisify(execFile);

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitFor(url, child, label) {
  child.once('error', (error) => { child.startupError = error; });
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited before becoming ready${childOutput(child)}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(300) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
  }
  throw new Error(`timed out waiting for ${label}${childOutput(child)}`);
}

function childOutput(child) {
  const output = [child.startupError && `${child.startupError.code}: ${child.startupError.message}`, child.stdout?.read(), child.stderr?.read()]
    .filter(Boolean)
    .map((chunk) => chunk.toString().trim())
    .filter(Boolean)
    .join(' | ');
  return output ? `: ${output}` : '';
}

async function stop(child) {
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  return { response, payload: await response.json() };
}

async function commandAvailable(command, args = ['--version']) {
  try {
    await execFileAsync(command, args, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

test('configured media worker is visible in the catalog and executes a real HTTP batch boundary', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-media-worker-api-'));
  const workerPort = await freePort();
  const appPort = await freePort();
  for (const file of ['accounts.json', 'works.json', 'activity.json', 'feedback.json', 'content-tasks.json']) {
    await writeFile(join(dataDir, file), '[]');
  }
  const worker = spawn(PYTHON, [WORKER, '--port', String(workerPort)], {
    cwd: PROJECT_DIR,
    env: { ...process.env, MEDIA_WORKER_MODE: 'fake' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const app = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      XHS_DATA_DIR: dataDir,
      XHS_MONITOR_PORT: String(appPort),
      XHS_REFRESH_MINUTES: '0',
      XHS_MEDIA_WORKER_URL: `http://127.0.0.1:${workerPort}`,
      XHS_MEDIA_WORKER_ID: 'connector_test_http_worker',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitFor(`http://127.0.0.1:${workerPort}/health`, worker, 'media worker');
    await waitFor(`http://127.0.0.1:${appPort}/api/health`, app, 'app');
    const baseUrl = `http://127.0.0.1:${appPort}`;
    const health = await jsonRequest(baseUrl + '/api/content/media-worker/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.payload.worker.status, 'ready');
    assert.equal(health.payload.worker.simulation, true);

    const taskResult = await jsonRequest(baseUrl + '/api/content/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'HTTP worker 边界测试', objective: '验证外部 worker 接入' }),
    });
    assert.equal(taskResult.response.status, 201);
    const task = taskResult.payload.task;
    const avatar = await jsonRequest(baseUrl + '/api/content/avatar-profiles', {
      method: 'POST',
      body: JSON.stringify({
        projectId: task.projectId, id: 'avatar_http_worker', versionId: 'avatar_http_worker_v1', name: 'HTTP 测试人物',
        canonicalImageRef: 'fixture://avatar.png', baseVideoRef: 'fixture://avatar.mp4',
        authorizationStatus: 'approved', authorizationRef: 'consent://avatar', batchAllowed: true, approved: true,
      }),
    });
    assert.equal(avatar.response.status, 201);
    const scripts = await jsonRequest(baseUrl + '/api/content/script-sets', {
      method: 'POST',
      body: JSON.stringify({
        projectId: task.projectId, taskId: task.id, id: 'script_http_worker', name: 'HTTP 测试脚本', approved: true,
        versions: [{ id: 'script_http_worker_v1', text: '这是 HTTP worker 的测试文案' }],
      }),
    });
    assert.equal(scripts.response.status, 201);
    const catalog = await jsonRequest(baseUrl + `/api/content/batches/catalog?projectId=${task.projectId}&taskId=${task.id}`);
    const remote = catalog.payload.catalog.connectors.find((item) => item.id === 'connector_test_http_worker');
    assert.equal(remote.status, 'ready');
    const planInput = {
      projectId: task.projectId,
      taskId: task.id,
      avatarVersionIds: [avatar.payload.version.id],
      scriptVersionIds: [scripts.payload.scriptSet.versions[0].id],
      templateVersionId: catalog.payload.catalog.defaults.templateVersionId,
      connectorId: remote.id,
    };
    const plan = await jsonRequest(baseUrl + '/api/content/batches/plan', { method: 'POST', body: JSON.stringify(planInput) });
    assert.equal(plan.response.status, 200);
    const batch = await jsonRequest(baseUrl + '/api/content/batches', { method: 'POST', body: JSON.stringify({ ...planInput, id: 'batch_http_worker' }) });
    assert.equal(batch.response.status, 201);
    const started = await jsonRequest(baseUrl + `/api/content/batches/${batch.payload.batch.id}/start`, { method: 'POST', body: '{}' });
    assert.equal(started.response.status, 200, started.payload.error || JSON.stringify(started.payload));
    assert.equal(started.payload.batch.items[0].status, 'succeeded');
    assert.equal(started.payload.batch.items[0].output.connectorId, remote.id);
    assert.match(started.payload.batch.items[0].output.requestId, /^fake-request-/);
  } finally {
    await stop(app);
    await stop(worker);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('configured simulated media worker blocks CE-14 and keeps CE-15 unstarted', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-media-node-api-'));
  const workerPort = await freePort();
  const appPort = await freePort();
  for (const file of ['accounts.json', 'works.json', 'activity.json', 'feedback.json', 'content-tasks.json']) {
    await writeFile(join(dataDir, file), '[]');
  }
  const worker = spawn(PYTHON, [WORKER, '--port', String(workerPort)], {
    cwd: PROJECT_DIR,
    env: { ...process.env, MEDIA_WORKER_MODE: 'fake' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const app = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: '',
      XHS_LOCAL_DRAFT_GENERATOR: 'true',
      XHS_DATA_DIR: dataDir,
      XHS_MEDIA_ROOTS: dataDir,
      XHS_MONITOR_PORT: String(appPort),
      XHS_REFRESH_MINUTES: '0',
      XHS_MEDIA_WORKER_URL: `http://127.0.0.1:${workerPort}`,
      XHS_MEDIA_WORKER_ID: 'connector_test_http_node_worker',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitFor(`http://127.0.0.1:${workerPort}/health`, worker, 'media worker');
    await waitFor(`http://127.0.0.1:${appPort}/api/health`, app, 'app');
    const baseUrl = `http://127.0.0.1:${appPort}`;
    const taskResult = await jsonRequest(baseUrl + '/api/content/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'HTTP worker 节点测试', objective: '验证 CE-14 和 CE-15 的外部 Worker 路由' }),
    });
    assert.equal(taskResult.response.status, 201);
    const taskId = taskResult.payload.task.id;
    const projectId = taskResult.payload.task.projectId;
    const voice = await jsonRequest(baseUrl + '/api/content/voice-profiles', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        id: 'voice_http_node',
        versionId: 'voice_http_node_v1',
        name: 'HTTP 节点测试声音',
        referenceAudioRef: 'fixture://voice.wav',
        authorizationStatus: 'approved',
        authorizationRef: 'consent://voice-http-node',
        batchAllowed: true,
        approved: true,
      }),
    });
    assert.equal(voice.response.status, 201, JSON.stringify(voice.payload));
    const avatar = await jsonRequest(baseUrl + '/api/content/avatar-profiles', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        id: 'avatar_http_node',
        versionId: 'avatar_http_node_v1',
        name: 'HTTP 节点测试数字人',
        canonicalImageRef: 'fixture://avatar.png',
        baseVideoRef: 'fixture://avatar.mp4',
        authorizationStatus: 'approved',
        authorizationRef: 'consent://avatar-http-node',
        batchAllowed: true,
        approved: true,
      }),
    });
    assert.equal(avatar.response.status, 201, JSON.stringify(avatar.payload));
    await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/start`, { method: 'POST', body: '{}' });
    for (const nodeId of ['CE-02', 'CE-03', 'CE-04', 'CE-05', 'CE-06', 'CE-07', 'CE-08', 'CE-09', 'CE-10', 'CE-11', 'CE-12', 'CE-13']) {
      const recorded = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/nodes/${nodeId}/record`, {
        method: 'POST',
        body: JSON.stringify({
          status: 'succeeded',
          output: { text: nodeId === 'CE-11' ? '这是外部 Worker 节点测试脚本。' : nodeId + ' test output' },
          note: '集成测试前置节点结果',
        }),
      });
      assert.equal(recorded.response.status, 200, JSON.stringify(recorded.payload));
    }

    const audio = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/execute-node`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'CE-14', voiceVersionId: voice.payload.version.id }),
    });
    assert.equal(audio.response.status, 409, JSON.stringify(audio.payload));
    assert.equal(audio.payload.code, 'MEDIA_WORKER_SIMULATION_ONLY');
    const audioNode = audio.payload.task.nodes.find((node) => node.id === 'CE-14');
    assert.equal(audioNode.status, 'blocked');
    assert.equal(audioNode.output, null);

    const video = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/execute-node`, {
      method: 'POST',
      body: JSON.stringify({
        nodeId: 'CE-15',
        avatarVersionId: avatar.payload.version.id,
        voiceVersionId: voice.payload.version.id,
      }),
    });
    assert.equal(video.response.status, 409, JSON.stringify(video.payload));
    assert.equal(video.payload.code, 'CONTENT_NODE_NOT_READY');
    const videoNode = video.payload.task.nodes.find((node) => node.id === 'CE-15');
    assert.equal(videoNode.status, 'pending');
    assert.equal(videoNode.output, null);
  } finally {
    await stop(app);
    await stop(worker);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('macOS say baseline travels from CE-14 through HTTP worker into protected audio asset', {
  skip: process.platform !== 'darwin',
}, async () => {
  if (!(await commandAvailable('/usr/bin/say', ['-v', '?'])) || !(await commandAvailable('ffmpeg'))) return;
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-macos-say-api-'));
  const workerPort = await freePort();
  const appPort = await freePort();
  for (const file of ['accounts.json', 'works.json', 'activity.json', 'feedback.json', 'content-tasks.json']) {
    await writeFile(join(dataDir, file), '[]');
  }
  const worker = spawn(PYTHON, [WORKER, '--port', String(workerPort)], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      MEDIA_WORKER_MODE: 'command',
      MEDIA_WORKER_DATA_DIR: dataDir,
      MEDIA_WORKER_TTS_COMMAND: `${PYTHON} ${MACOS_SAY_WRAPPER}`,
      MEDIA_WORKER_AVATAR_COMMAND: '',
      MEDIA_WORKER_MACOS_SAY_VOICE: 'Ting-Ting',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const app = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: '',
      XHS_LOCAL_DRAFT_GENERATOR: 'true',
      XHS_DATA_DIR: dataDir,
      XHS_MEDIA_ROOTS: dataDir,
      XHS_MONITOR_PORT: String(appPort),
      XHS_REFRESH_MINUTES: '0',
      XHS_MEDIA_WORKER_URL: `http://127.0.0.1:${workerPort}`,
      XHS_MEDIA_WORKER_ID: 'connector_macos_say_baseline',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitFor(`http://127.0.0.1:${workerPort}/health`, worker, 'macOS say worker');
    await waitFor(`http://127.0.0.1:${appPort}/api/health`, app, 'app');
    const baseUrl = `http://127.0.0.1:${appPort}`;
    const created = await jsonRequest(baseUrl + '/api/content/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '本机真实音频基线', objective: '验证 CE-14 真实文件回流' }),
    });
    assert.equal(created.response.status, 201);
    const taskId = created.payload.task.id;
    const projectId = created.payload.task.projectId;
    const voice = await jsonRequest(baseUrl + '/api/content/voice-profiles', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        id: 'voice_macos_say',
        versionId: 'voice_macos_say_v1',
        name: '本机系统基线声音',
        referenceAudioRef: 'fixture://system-voice-reference.wav',
        authorizationStatus: 'approved',
        authorizationRef: 'test-consent://system-voice',
        batchAllowed: true,
        approved: true,
      }),
    });
    assert.equal(voice.response.status, 201, JSON.stringify(voice.payload));
    const started = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/start`, { method: 'POST', body: '{}' });
    assert.equal(started.response.status, 200);
    for (const nodeId of ['CE-02', 'CE-03', 'CE-04', 'CE-05', 'CE-06', 'CE-07', 'CE-08', 'CE-09', 'CE-10', 'CE-11', 'CE-12', 'CE-13']) {
      const recorded = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/nodes/${nodeId}/record`, {
        method: 'POST',
        body: JSON.stringify({
          status: 'succeeded',
          output: { text: nodeId === 'CE-11' ? '这是本机真实音频基线测试。' : nodeId + ' fixture' },
          note: '端到端测试前置节点结果',
        }),
      });
      assert.equal(recorded.response.status, 200, JSON.stringify(recorded.payload));
    }
    const audio = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/execute-node`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'CE-14', voiceVersionId: voice.payload.version.id }),
    });
    assert.equal(audio.response.status, 200, JSON.stringify(audio.payload));
    const node = audio.payload.task.nodes.find((item) => item.id === 'CE-14');
    assert.equal(node.status, 'succeeded');
    assert.equal(node.output.simulated, false);
    assert.match(node.output.audioRef, /^file:\/\//);
    assert.equal(node.output.assetIds.length, 1);
    const asset = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/assets`);
    const generated = asset.payload.assets.find((item) => item.id === node.output.assetIds[0]);
    assert.equal(generated.kind, 'audio');
    const file = await fetch(`${baseUrl}/api/content/tasks/${taskId}/assets/${encodeURIComponent(generated.id)}/file`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-type') || '', /^audio\/wav/);
    assert.ok((await file.arrayBuffer()).byteLength > 1_000);
  } finally {
    await stop(app);
    await stop(worker);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('CE-14 forwards the approved voice reference transcript before blocking simulation output', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-media-worker-transcript-'));
  const appPort = await freePort();
  const referenceAudioPath = join(dataDir, 'voice-reference.wav');
  const received = [];
  const worker = createHttpServer((request, response) => {
    const send = (status, payload) => {
      const body = Buffer.from(JSON.stringify(payload));
      response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': body.length,
      });
      response.end(body);
    };
    if (request.method === 'GET' && request.url === '/health') {
      send(200, {
        protocol: 'content-media-worker-v1',
        status: 'ready',
        capabilities: ['tts'],
        workerVersion: 'capture-worker-v1',
        accelerator: { type: 'test', available: true },
        simulation: true,
      });
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
      received.push(JSON.parse(body));
      send(200, {
        protocol: 'content-media-worker-v1',
        requestId: 'capture-request-1',
        output: {
          outputKind: 'audio',
          audioRef: pathToFileURL(referenceAudioPath).toString(),
          transcript: '参考转写第一句\n参考转写第二句',
          segments: [
            { start: 0.2, end: 1.1, text: '参考转写第一句' },
            { start: 1.3, end: 2.2, text: '参考转写第二句' },
          ],
          modelVersion: 'capture-model',
          simulated: true,
          reviewRequired: true,
        },
      });
    });
  });
  worker.listen(0, '127.0.0.1');
  await once(worker, 'listening');
  const workerPort = worker.address().port;
  const app = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: '',
      XHS_LOCAL_DRAFT_GENERATOR: 'true',
      XHS_DATA_DIR: dataDir,
      XHS_MEDIA_ROOTS: dataDir,
      XHS_MONITOR_PORT: String(appPort),
      XHS_REFRESH_MINUTES: '0',
      XHS_MEDIA_WORKER_URL: `http://127.0.0.1:${workerPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await writeFile(referenceAudioPath, 'RIFF' + '0'.repeat(2048), 'utf8');
    await waitFor(`http://127.0.0.1:${appPort}/api/health`, app, 'app');
    const baseUrl = `http://127.0.0.1:${appPort}`;
    const created = await jsonRequest(baseUrl + '/api/content/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '参考转写传递测试', objective: '验证声音克隆输入证据' }),
    });
    assert.equal(created.response.status, 201);
    const taskId = created.payload.task.id;
    const voice = await jsonRequest(baseUrl + '/api/content/voice-profiles', {
      method: 'POST',
      body: JSON.stringify({
        projectId: created.payload.task.projectId,
        id: 'voice_transcript_api',
        versionId: 'voice_transcript_api_v1',
        name: '参考转写测试声音',
        referenceAudioRef: referenceAudioPath,
        referenceTranscript: '参考音频的准确转写。',
        authorizationStatus: 'approved',
        authorizationRef: 'consent://voice-transcript-api',
        batchAllowed: true,
        approved: true,
      }),
    });
    assert.equal(voice.response.status, 201, JSON.stringify(voice.payload));
    assert.equal(voice.payload.version.referenceTranscript, '参考音频的准确转写。');
    assert.equal((await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/start`, { method: 'POST', body: '{}' })).response.status, 200);
    for (const nodeId of ['CE-02', 'CE-03', 'CE-04', 'CE-05', 'CE-06', 'CE-07', 'CE-08', 'CE-09', 'CE-10', 'CE-11', 'CE-12', 'CE-13']) {
      const recorded = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/nodes/${nodeId}/record`, {
        method: 'POST',
        body: JSON.stringify({
          status: 'succeeded',
          output: { text: nodeId === 'CE-11' ? '需要克隆的测试脚本。' : nodeId + ' fixture' },
          note: '参考转写传递测试前置节点结果',
        }),
      });
      assert.equal(recorded.response.status, 200, JSON.stringify(recorded.payload));
    }
    const audio = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/execute-node`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'CE-14', voiceVersionId: voice.payload.version.id }),
    });
    assert.equal(audio.response.status, 409, JSON.stringify(audio.payload));
    assert.equal(audio.payload.code, 'MEDIA_WORKER_SIMULATION_ONLY');
    assert.equal(received.length, 1);
    assert.equal(received[0].input.voice.referenceTranscript, '参考音频的准确转写。');
    assert.equal(received[0].input.voice.referenceAudioRef, pathToFileURL(await realpath(referenceAudioPath)).toString());
    const assets = await jsonRequest(`${baseUrl}/api/content/tasks/${taskId}/assets`);
    assert.equal(assets.payload.assets.some((item) => item.kind === 'audio'), false);
  } finally {
    await stop(app);
    await new Promise((resolvePromise, reject) => worker.close((error) => error ? reject(error) : resolvePromise()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('voice comparison API preserves two blocked candidates when the worker is simulated', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-voice-comparison-api-'));
  const workerPort = await freePort();
  const appPort = await freePort();
  for (const file of ['accounts.json', 'works.json', 'activity.json', 'feedback.json', 'content-tasks.json']) {
    await writeFile(join(dataDir, file), '[]');
  }
  const worker = spawn(PYTHON, [WORKER, '--port', String(workerPort)], {
    cwd: PROJECT_DIR,
    env: { ...process.env, MEDIA_WORKER_MODE: 'fake' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const app = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: '',
      XHS_LOCAL_DRAFT_GENERATOR: 'true',
      XHS_DATA_DIR: dataDir,
      XHS_MEDIA_ROOTS: dataDir,
      XHS_MONITOR_PORT: String(appPort),
      XHS_REFRESH_MINUTES: '0',
      XHS_MEDIA_WORKER_URL: `http://127.0.0.1:${workerPort}`,
      XHS_MEDIA_WORKER_ID: 'connector_voice_comparison_worker',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitFor(`http://127.0.0.1:${workerPort}/health`, worker, 'voice comparison worker');
    await waitFor(`http://127.0.0.1:${appPort}/api/health`, app, 'app');
    const baseUrl = `http://127.0.0.1:${appPort}`;
    const testSet = await jsonRequest(baseUrl + '/api/content/voice-comparison-test-set');
    assert.equal(testSet.response.status, 200, JSON.stringify(testSet.payload));
    assert.equal(testSet.payload.testSet.version, 'm5-voice-eval-v1');
    assert.equal(testSet.payload.testSet.cases.find((item) => item.id === 'long-script-60-120s').durationTargetSeconds.min, 60);
    const created = await jsonRequest(baseUrl + '/api/content/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '双声线试听验收', objective: '验证 M5 声音 A/B 试听与人工选择' }),
    });
    assert.equal(created.response.status, 201);
    const task = created.payload.task;
    const auditionScript = '这是声音 A/B 试听的测试脚本，包含中文数字 2026、日期 9 月 7 日、金额 99 元和品牌词。'.repeat(28);
    const voices = [];
    for (const [index, label] of ['CosyVoice 主声线', 'OpenVoice 备选声线'].entries()) {
      const voice = await jsonRequest(baseUrl + '/api/content/voice-profiles', {
        method: 'POST',
        body: JSON.stringify({
          projectId: task.projectId,
          id: `voice_comparison_${index + 1}`,
          versionId: `voice_comparison_${index + 1}_v1`,
          name: label,
          provider: index === 0 ? 'cosyvoice-3' : 'openvoice-v2',
          modelVersion: index === 0 ? 'CosyVoice-3-approved' : 'OpenVoice-V2-approved',
          licenseRef: `license://voice-model-${index + 1}`,
          weightsHash: `sha256:voice-model-${index + 1}`,
          referenceAudioRef: `fixture://voice-${index + 1}.wav`,
          referenceTranscript: `参考音频 ${index + 1} 的准确文字。`,
          authorizationStatus: 'approved',
          authorizationRef: `consent://voice-comparison-${index + 1}`,
          batchAllowed: true,
          approved: true,
        }),
      });
      assert.equal(voice.response.status, 201, JSON.stringify(voice.payload));
      assert.equal(voice.payload.version.provider, index === 0 ? 'cosyvoice-3' : 'openvoice-v2');
      assert.equal(voice.payload.version.modelVersion, index === 0 ? 'CosyVoice-3-approved' : 'OpenVoice-V2-approved');
      voices.push(voice.payload.version);
    }
    await jsonRequest(baseUrl + `/api/content/tasks/${task.id}/start`, { method: 'POST', body: '{}' });
    for (const nodeId of ['CE-02', 'CE-03', 'CE-04', 'CE-05', 'CE-06', 'CE-07', 'CE-08', 'CE-09', 'CE-10', 'CE-11', 'CE-12', 'CE-13']) {
      const recorded = await jsonRequest(baseUrl + `/api/content/tasks/${task.id}/nodes/${nodeId}/record`, {
        method: 'POST',
        body: JSON.stringify({
          status: 'succeeded',
          output: { text: nodeId === 'CE-11' ? auditionScript : nodeId + ' fixture' },
          note: '声音 A/B 试听测试前置节点结果',
        }),
      });
      assert.equal(recorded.response.status, 200, JSON.stringify(recorded.payload));
    }

    const comparison = await jsonRequest(baseUrl + `/api/content/tasks/${task.id}/voice-comparisons`, {
      method: 'POST',
      body: JSON.stringify({ voiceVersionIds: voices.map((voice) => voice.id) }),
    });
    assert.equal(comparison.response.status, 201, JSON.stringify(comparison.payload));
    assert.equal(comparison.payload.comparison.status, 'partial_failed');
    assert.equal(comparison.payload.comparison.candidates.length, 2);
    assert.deepEqual(comparison.payload.comparison.candidates.map((candidate) => candidate.voiceVersionId), voices.map((voice) => voice.id));
    assert.ok(comparison.payload.comparison.candidates[0].segments.length > 1);
    assert.deepEqual(comparison.payload.comparison.candidates[0].segments.map((segment) => segment.index), comparison.payload.comparison.candidates[0].segments.map((_, index) => index));
    assert.equal(comparison.payload.comparison.candidates.every((candidate) => candidate.status === 'failed'), true);
    assert.equal(comparison.payload.comparison.candidates.every((candidate) => candidate.output === null), true);
    assert.equal(comparison.payload.comparison.candidates.every((candidate) => candidate.errorCode === 'MEDIA_WORKER_SIMULATION_ONLY'), true);
    assert.equal(comparison.payload.comparison.candidates.every((candidate) => candidate.segments.every((segment) => segment.status === 'failed')), true);
    assert.equal(comparison.payload.comparison.candidates.every((candidate) => candidate.segments.every((segment) => segment.errorCode === 'MEDIA_WORKER_SIMULATION_ONLY')), true);
    assert.notEqual(
      comparison.payload.comparison.candidates[0].idempotencyKey,
      comparison.payload.comparison.candidates[1].idempotencyKey,
    );

    const selected = await jsonRequest(baseUrl + `/api/content/tasks/${task.id}/voice-comparisons/${comparison.payload.comparison.id}/select`, {
      method: 'POST',
      body: JSON.stringify({ voiceVersionId: voices[1].id, role: 'default' }),
    });
    assert.equal(selected.response.status, 409, JSON.stringify(selected.payload));
    assert.equal(selected.payload.code, 'VOICE_COMPARISON_CANDIDATE_NOT_READY');
  } finally {
    await stop(app);
    await stop(worker);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('voice comparison retries only the explicitly retryable failed segment', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-voice-comparison-retry-'));
  const appPort = await freePort();
  const requests = [];
  let injectedFailure = false;
  const worker = createHttpServer((request, response) => {
    const send = (status, payload) => {
      const body = Buffer.from(JSON.stringify(payload));
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
      response.end(body);
    };
    if (request.method === 'GET' && request.url === '/health') {
      send(200, { protocol: 'content-media-worker-v1', status: 'ready', capabilities: ['tts'], workerVersion: 'retry-capture-v1', simulation: true });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/media/generate') {
      send(404, { message: 'not found' });
      return;
    }
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(raw);
      requests.push(payload);
      if (!injectedFailure && payload.input.segment?.index === 1 && payload.input.voiceVersionId === 'voice_comparison_retry_1_v1') {
        injectedFailure = true;
        send(503, { code: 'SEGMENT_TIMEOUT', message: '测试段超时', retryable: true });
        return;
      }
      send(200, {
        protocol: 'content-media-worker-v1',
        requestId: 'retry-request-' + requests.length,
        output: {
          outputKind: 'audio',
          audioRef: `simulation://retry/${payload.input.voiceVersionId}/${payload.input.segment?.index}.wav`,
          modelVersion: 'retry-capture-model',
          durationSeconds: 2,
          simulated: true,
          reviewRequired: true,
        },
      });
    });
  });
  worker.listen(0, '127.0.0.1');
  await once(worker, 'listening');
  const workerPort = worker.address().port;
  for (const file of ['accounts.json', 'works.json', 'activity.json', 'feedback.json', 'content-tasks.json']) {
    await writeFile(join(dataDir, file), '[]');
  }
  const app = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: '',
      XHS_LOCAL_DRAFT_GENERATOR: 'true',
      XHS_DATA_DIR: dataDir,
      XHS_MEDIA_ROOTS: dataDir,
      XHS_MONITOR_PORT: String(appPort),
      XHS_REFRESH_MINUTES: '0',
      XHS_MEDIA_WORKER_URL: `http://127.0.0.1:${workerPort}`,
      XHS_MEDIA_WORKER_ID: 'connector_voice_comparison_retry',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitFor(`http://127.0.0.1:${appPort}/api/health`, app, 'app');
    const baseUrl = `http://127.0.0.1:${appPort}`;
    const created = await jsonRequest(baseUrl + '/api/content/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '长稿分段重试', objective: '验证失败段独立重试' }),
    });
    assert.equal(created.response.status, 201);
    const task = created.payload.task;
    for (const [index, id] of ['voice_comparison_retry_1', 'voice_comparison_retry_2'].entries()) {
      const voice = await jsonRequest(baseUrl + '/api/content/voice-profiles', {
        method: 'POST',
        body: JSON.stringify({
          projectId: task.projectId,
          id,
          versionId: `${id}_v1`,
          name: `重试声音 ${index + 1}`,
          referenceAudioRef: `fixture://retry-${index + 1}.wav`,
          referenceTranscript: `重试参考音频 ${index + 1}。`,
          authorizationStatus: 'approved',
          authorizationRef: `consent://retry-${index + 1}`,
          batchAllowed: true,
          approved: true,
        }),
      });
      assert.equal(voice.response.status, 201, JSON.stringify(voice.payload));
    }
    const scriptText = '长稿分段测试。'.repeat(120);
    await jsonRequest(baseUrl + `/api/content/tasks/${task.id}/start`, { method: 'POST', body: '{}' });
    for (const nodeId of ['CE-02', 'CE-03', 'CE-04', 'CE-05', 'CE-06', 'CE-07', 'CE-08', 'CE-09', 'CE-10', 'CE-11', 'CE-12', 'CE-13']) {
      const recorded = await jsonRequest(baseUrl + `/api/content/tasks/${task.id}/nodes/${nodeId}/record`, {
        method: 'POST',
        body: JSON.stringify({ status: 'succeeded', output: { text: nodeId === 'CE-11' ? scriptText : nodeId }, note: '长稿分段测试前置节点' }),
      });
      assert.equal(recorded.response.status, 200, JSON.stringify(recorded.payload));
    }

    const input = { voiceVersionIds: ['voice_comparison_retry_1_v1', 'voice_comparison_retry_2_v1'] };
    const first = await jsonRequest(baseUrl + `/api/content/tasks/${task.id}/voice-comparisons`, { method: 'POST', body: JSON.stringify(input) });
    assert.equal(first.response.status, 201, JSON.stringify(first.payload));
    assert.equal(first.payload.comparison.status, 'partial_failed');
    const failedCandidate = first.payload.comparison.candidates.find((candidate) => candidate.voiceVersionId === 'voice_comparison_retry_1_v1');
    assert.equal(failedCandidate.segments.filter((segment) => segment.status === 'failed').length, 2);
    assert.equal(failedCandidate.segments[0].attempt, 1);
    assert.equal(failedCandidate.segments[1].attempt, 1);
    const requestCountBeforeRetry = requests.length;

    const second = await jsonRequest(baseUrl + `/api/content/tasks/${task.id}/voice-comparisons`, { method: 'POST', body: JSON.stringify(input) });
    assert.equal(second.response.status, 200, JSON.stringify(second.payload));
    assert.equal(second.payload.comparison.status, 'partial_failed');
    assert.equal(requests.length, requestCountBeforeRetry + 1);
    assert.equal(requests.at(-1).input.voiceVersionId, 'voice_comparison_retry_1_v1');
    assert.equal(requests.at(-1).input.segment.index, 1);
    const recovered = second.payload.comparison.candidates.find((candidate) => candidate.voiceVersionId === 'voice_comparison_retry_1_v1');
    assert.equal(recovered.segments.every((segment) => segment.status === 'failed'), true);
    assert.equal(recovered.segments[0].attempt, 1);
    assert.equal(recovered.segments[1].attempt, 2);
  } finally {
    await stop(app);
    await new Promise((resolvePromise, reject) => worker.close((error) => error ? reject(error) : resolvePromise()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
