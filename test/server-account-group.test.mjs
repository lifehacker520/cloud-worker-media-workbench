import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function waitForServer(port, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('server exited before becoming ready');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(400),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // The server may still be loading its first refresh.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
  }
  throw new Error('timed out waiting for server');
}

test('adding an account preserves its monitoring group', async () => {
  const dataDir = await mkdtemp('/tmp/cloud-worker-account-group-');
  const port = 32000 + Math.floor(Math.random() * 500);
  const seedAccount = {
    id: 'acct_group_fixture',
    name: '分组测试账号',
    platform: 'xhs',
    sourceUrl: 'https://www.xiaohongshu.com/user/profile/6a043b3d0000000002002000',
    canonicalUrl: 'https://www.xiaohongshu.com/user/profile/6a043b3d0000000002002000',
    userId: '6a043b3d0000000002002000',
    state: 'pending',
  };
  await Promise.all([
    writeFile(join(dataDir, 'accounts.json'), JSON.stringify([seedAccount])),
    writeFile(join(dataDir, 'works.json'), '[]'),
    writeFile(join(dataDir, 'activity.json'), '[]'),
    writeFile(join(dataDir, 'feedback.json'), '[]'),
  ]);

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      XHS_DATA_DIR: dataDir,
      XHS_MONITOR_PORT: String(port),
      XHS_REFRESH_MINUTES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(port, child);
    const response = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '销售线索账号',
        group: '销售线索',
        sourceUrl:
          'https://www.xiaohongshu.com/user/profile/6a744a1f0000000013031405',
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 201);
    assert.equal(payload.account.group, '销售线索');

    const savedAccounts = JSON.parse(
      await readFile(join(dataDir, 'accounts.json'), 'utf8'),
    );
    assert.equal(
      savedAccounts.find((account) => account.name === '销售线索账号').group,
      '销售线索',
    );

    const updateResponse = await fetch(
      `http://127.0.0.1:${port}/api/accounts/${encodeURIComponent(payload.account.id)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group: '重点客户' }),
      },
    );
    const updatePayload = await updateResponse.json();
    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.account.group, '重点客户');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
