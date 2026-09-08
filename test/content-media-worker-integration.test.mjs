import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { resolve } from 'node:path';

import { HttpMediaGenerationConnector } from '../src/content-media-worker-connector.mjs';

const PROJECT_DIR = resolve(import.meta.dirname, '..');
const WORKER = resolve(PROJECT_DIR, 'tools/media-model-worker/app.py');

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForWorker(url, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('media worker exited before becoming ready');
    try {
      const response = await fetch(url + '/health', { signal: AbortSignal.timeout(250) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error('timed out waiting for media worker');
}

test('Python fake media worker satisfies the Node connector contract and refuses unsafe paths', async () => {
  const port = await freePort();
  const child = spawn('python3', [WORKER, '--port', String(port)], {
    cwd: PROJECT_DIR,
    env: { ...process.env, MEDIA_WORKER_MODE: 'fake' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForWorker(baseUrl, child);
    const connector = new HttpMediaGenerationConnector({ id: 'connector_python_fake', url: baseUrl, timeoutMs: 1_000 });
    const health = await connector.health();
    assert.equal(health.status, 'ready');
    assert.equal(health.simulation, true);
    assert.equal(health.accelerator.available, false);

    const output = await connector.generate({
      batch: { id: 'batch-python', taskId: 'task-python' },
      item: { idempotencyKey: 'avatar|voice|script|template|python', input: { voiceVersionId: 'voice-v1' } },
    });
    assert.equal(output.simulated, true);
    assert.match(output.videoRef, /^simulation:\/\//);
    assert.match(output.requestId, /^fake-request-/);

    await assert.rejects(
      connector.generate({
        batch: { id: 'batch-python' },
        item: { idempotencyKey: 'unsafe', input: { canonicalImageRef: 'file:///etc/passwd' } },
      }),
      (error) => error.code === 'MEDIA_WORKER_INVALID_INPUT' && error.status === 400 && error.retryable === false,
    );
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  }
});
