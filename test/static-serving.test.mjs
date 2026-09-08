import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const PROJECT_DIR = resolve(import.meta.dirname, '..');

async function waitForServer(port, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before becoming ready');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(400),
      });
      if (response.ok) return;
    } catch {
      // The server may still be initializing.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
  }
  throw new Error('timed out waiting for server');
}

test('desktop server serves the packaged homepage on every platform', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'cloud-worker-static-'));
  const port = 32700 + Math.floor(Math.random() * 200);
  await writeFile(resolve(dataDir, 'accounts.json'), '[]');
  await writeFile(resolve(dataDir, 'works.json'), '[]');
  await writeFile(resolve(dataDir, 'activity.json'), '[]');
  await writeFile(resolve(dataDir, 'feedback.json'), '[]');
  await writeFile(resolve(dataDir, 'content-tasks.json'), '[]');
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      XHS_DATA_DIR: dataDir,
      XHS_MONITOR_PORT: String(port),
      XHS_MONITOR_DEMO: 'true',
      XHS_REFRESH_MINUTES: '0',
    },
    stdio: 'ignore',
  });

  try {
    await waitForServer(port, child);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /<!doctype html/i);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
    await rm(dataDir, { recursive: true, force: true });
  }
});
