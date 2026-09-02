import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { WorkbenchStore } from '../src/workbench-store.mjs';

const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));

function runCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['tools/workbench-backup.mjs', ...args], {
      cwd: PROJECT_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

test('workbench backup CLI exposes retention pruning and removes old local copies', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-backup-cli-'));
  const store = await WorkbenchStore.open(dataDir);
  try {
    await store.createBackup({ backupId: 'backup-cli-old', now: '2026-08-29T12:00:00.000Z' });
    await store.createBackup({ backupId: 'backup-cli-latest', now: '2026-08-31T12:00:00.000Z' });
  } finally {
    store.close();
  }
  try {
    const help = await runCli(['--help'], { XHS_DATA_DIR: dataDir });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /prune/);

    const pruned = await runCli(['prune', '--keep', '1'], { XHS_DATA_DIR: dataDir });
    assert.equal(pruned.code, 0, pruned.stderr);
    const payload = JSON.parse(pruned.stdout);
    assert.deepEqual(payload.deleted, ['backup-cli-old']);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
