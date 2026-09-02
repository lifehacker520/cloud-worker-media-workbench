import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));

async function waitForServer(port, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before becoming ready: ' + (child.__stderr || 'no stderr'));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(400) });
      if (response.ok) return;
    } catch {
      // 等待旧 JSON 导入和 SQLite 初始化。
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('timed out waiting for server');
}

async function startServer(dataDir, port) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      XHS_AUTH_REQUIRED: 'false',
      XHS_AUTH_SECRET: 'monitoring-migration-secret',
      XHS_ADMIN_PASSWORD: 'admin-pass-123',
      XHS_CLIENT_PASSWORD: 'client-pass-123',
      XHS_DATA_DIR: dataDir,
      XHS_MONITOR_PORT: String(port),
      XHS_REFRESH_MINUTES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.__stderr = '';
  child.stderr.on('data', (chunk) => { child.__stderr += chunk.toString(); });
  await waitForServer(port, child);
  return child;
}

test('monitoring JSON migrates to SQLite and remains the source after a restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-monitoring-migration-'));
  const account = {
    id: 'account_migration_fixture',
    tenantId: 'tenant_local',
    name: '迁移测试账号',
    group: '迁移',
    platform: 'xhs',
    sourceUrl: 'https://www.xiaohongshu.com/user/profile/6a043b3d0000000002002000',
    canonicalUrl: 'https://www.xiaohongshu.com/user/profile/6a043b3d0000000002002000',
    userId: '6a043b3d0000000002002000',
    state: 'pending',
  };
  const work = {
    id: 'work_migration-fingerprint',
    fingerprint: 'migration-fingerprint',
    tenantId: 'tenant_local',
    accountId: account.id,
    platform: 'xhs',
    title: '迁移测试作品',
    publishedAt: '2026-08-30T00:00:00.000Z',
    discoveredAt: '2026-08-30T00:00:00.000Z',
    seen: false,
  };
  await Promise.all([
    writeFile(join(dataDir, 'accounts.json'), JSON.stringify([account])),
    writeFile(join(dataDir, 'works.json'), JSON.stringify([work])),
    writeFile(join(dataDir, 'activity.json'), JSON.stringify([{ id: 'activity_migration_fixture', tenantId: 'tenant_local', detail: '迁移活动', createdAt: '2026-08-30T00:00:00.000Z' }])),
    writeFile(join(dataDir, 'feedback.json'), JSON.stringify([{ id: 'feedback_migration_fixture', tenantId: 'tenant_local', message: '迁移反馈', createdAt: '2026-08-30T00:00:00.000Z' }])),
    writeFile(join(dataDir, 'content-tasks.json'), '[]'),
  ]);
  const port = 33300 + Math.floor(Math.random() * 200);
  let child = await startServer(dataDir, port);
  try {
    const first = await fetch(`http://127.0.0.1:${port}/api/state`);
    const firstState = await first.json();
    assert.equal(first.status, 200);
    assert.ok(firstState.accounts.some((item) => item.id === account.id));
    assert.ok(firstState.works.some((item) => item.id === work.id));

    const db = new DatabaseSync(join(dataDir, 'workbench.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM monitoring_accounts').get().count, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM monitoring_works').get().count, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM monitoring_activity').get().count, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM monitoring_feedback').get().count, 1);
    } finally {
      db.close();
    }
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  }

  // 旧 JSON 被清空后重启，验证运行时已经从 SQLite 读取而不是重新生成种子。
  await writeFile(join(dataDir, 'accounts.json'), '[]');
  await writeFile(join(dataDir, 'works.json'), '[]');
  child = await startServer(dataDir, port + 1);
  try {
    const second = await fetch(`http://127.0.0.1:${port + 1}/api/state`);
    const secondState = await second.json();
    assert.equal(second.status, 200);
    assert.ok(secondState.accounts.some((item) => item.id === account.id));
    assert.ok(secondState.works.some((item) => item.id === work.id));
    assert.equal(JSON.parse(await readFile(join(dataDir, 'accounts.json'), 'utf8')).length, 1);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
