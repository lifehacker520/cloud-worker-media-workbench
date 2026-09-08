import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

import { HttpMediaGenerationConnector } from '../src/content-media-worker-connector.mjs';

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

async function close(server) {
  if (server.listening) {
    server.close();
    await once(server, 'close');
  }
}

test('HTTP media worker connector checks health and forwards an idempotent generation request', async () => {
  let received = null;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        protocol: 'content-media-worker-v1',
        status: 'ready',
        workerVersion: 'test-worker-1',
        accelerator: { type: 'cuda', available: true, device: 'test-gpu' },
        models: { tts: 'cosyvoice-test', avatar: 'musetalk-test' },
        capabilities: ['tts', 'talking_head'],
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/media/generate') {
      received = await readJson(request);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        requestId: 'request-test-1',
        taskId: 'worker-task-1',
        output: {
          videoRef: 'file:///safe/output.mp4',
          audioRef: 'file:///safe/output.wav',
          modelVersion: 'musetalk-test',
        },
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    const connector = new HttpMediaGenerationConnector({
      id: 'connector_test_worker',
      url: `http://127.0.0.1:${address.port}`,
      timeoutMs: 500,
    });
    const health = await connector.health();
    assert.equal(health.status, 'ready');
    assert.equal(health.accelerator.device, 'test-gpu');

    const output = await connector.generate({
      batch: { id: 'batch-test', taskId: 'task-test' },
      item: {
        id: 'item-test',
        idempotencyKey: 'avatar|voice|script|template|worker',
        input: { avatarVersionId: 'avatar-v1', voiceVersionId: 'voice-v1', scriptVersionId: 'script-v1' },
      },
      actor: { username: 'owner' },
      workerId: 'runner-test',
    });
    assert.equal(output.videoRef, 'file:///safe/output.mp4');
    assert.equal(output.requestId, 'request-test-1');
    assert.equal(received.protocol, 'content-media-worker-v1');
    assert.equal(received.idempotencyKey, 'avatar|voice|script|template|worker');
    assert.deepEqual(received.input, {
      avatarVersionId: 'avatar-v1',
      voiceVersionId: 'voice-v1',
      scriptVersionId: 'script-v1',
      batchId: 'batch-test',
      taskId: 'task-test',
    });
  } finally {
    await close(server);
  }
});

test('HTTP media worker connector classifies a worker timeout as retryable', async () => {
  const server = createServer((request, response) => {
    response.statusCode = 503;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ code: 'GPU_BUSY', message: 'GPU worker busy', retryable: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    const connector = new HttpMediaGenerationConnector({ url: `http://127.0.0.1:${address.port}`, timeoutMs: 500 });
    await assert.rejects(
      connector.generate({ batch: { id: 'batch-test' }, item: { id: 'item-test', idempotencyKey: 'key', input: {} } }),
      (error) => error.errorClass === 'server_error' && error.code === 'GPU_BUSY' && error.retryable === true && error.status === 503,
    );
  } finally {
    await close(server);
  }
});

test('HTTP media worker connector supports audio-only TTS and talking-head operations', async () => {
  const operations = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/media/generate') {
      response.statusCode = 404;
      response.end();
      return;
    }
    const body = await readJson(request);
    operations.push(body.operation);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      requestId: `request-${body.operation}`,
      taskId: `task-${body.operation}`,
      output: body.operation === 'tts'
        ? { outputKind: 'audio', audioRef: 'file:///safe/voice.wav', modelVersion: 'tts-test' }
        : { outputKind: 'video_manifest', videoRef: 'file:///safe/talking-head.mp4', modelVersion: 'avatar-test' },
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    const connector = new HttpMediaGenerationConnector({ url: `http://127.0.0.1:${address.port}`, timeoutMs: 500 });
    const context = {
      batch: { id: 'batch-single', taskId: 'task-single' },
      item: { id: 'item-single', idempotencyKey: 'single-key', input: { scriptText: '测试文案' } },
      actor: { username: 'owner' },
    };
    const audio = await connector.generateAudio(context);
    assert.equal(audio.audioRef, 'file:///safe/voice.wav');
    assert.equal(audio.videoRef, undefined);
    const video = await connector.generateTalkingHead(context);
    assert.equal(video.videoRef, 'file:///safe/talking-head.mp4');
    assert.deepEqual(operations, ['tts', 'talking_head']);
  } finally {
    await close(server);
  }
});
