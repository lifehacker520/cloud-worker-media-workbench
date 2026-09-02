import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));

async function waitForServer(port, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before becoming ready');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(400) });
      if (response.ok) return;
    } catch {
      // 等待 SQLite 和兼容数据初始化。
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('timed out waiting for server');
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  return { response, payload: await response.json() };
}

test('workspace backup API is admin-only and verifies a non-destructive snapshot', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-backup-api-'));
  const offsiteDir = await mkdtemp(join(tmpdir(), 'cloud-worker-backup-api-offsite-'));
  const port = 33100 + Math.floor(Math.random() * 200);
  await Promise.all([
    writeFile(join(dataDir, 'accounts.json'), '[]'),
    writeFile(join(dataDir, 'works.json'), '[]'),
    writeFile(join(dataDir, 'activity.json'), '[]'),
    writeFile(join(dataDir, 'feedback.json'), '[]'),
    writeFile(join(dataDir, 'content-tasks.json'), '[]'),
  ]);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      XHS_AUTH_REQUIRED: 'true',
      XHS_AUTH_SECRET: 'workspace-backup-api-secret',
      XHS_ADMIN_PASSWORD: 'admin-pass-123',
      XHS_CLIENT_PASSWORD: 'client-pass-123',
      XHS_ADMIN_TENANT_ID: 'tenant_admin',
      XHS_CLIENT_TENANT_ID: 'tenant_client',
      XHS_DATA_DIR: dataDir,
      XHS_BACKUP_ENCRYPTION_KEY: 'workspace-backup-api-encryption-key',
      XHS_BACKUP_OFFSITE_DIR: offsiteDir,
      XHS_BACKUP_RETENTION_COUNT: '5',
      XHS_MONITOR_PORT: String(port),
      XHS_REFRESH_MINUTES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(port, child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const adminLogin = await requestJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'admin-pass-123' }),
    });
    const adminCookie = adminLogin.response.headers.get('set-cookie');
    assert.equal(adminLogin.response.status, 200);

    const clientLogin = await requestJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'client', password: 'client-pass-123' }),
    });
    const clientCookie = clientLogin.response.headers.get('set-cookie');
    const forbidden = await requestJson(baseUrl, '/api/workspace/backups', { headers: { cookie: clientCookie } });
    assert.equal(forbidden.response.status, 403);

    const created = await requestJson(baseUrl, '/api/workspace/backups', {
      method: 'POST',
      headers: { cookie: adminCookie },
      body: JSON.stringify({ backupId: 'api-backup-test', includeMedia: false }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.backup.backupId, 'api-backup-test');
    assert.equal(created.payload.backup.includes.mediaFiles, false);
    assert.equal(created.payload.backup.includes.encrypted, true);
    assert.equal(created.payload.backup.offsite.status, 'PASS');
    assert.equal(Object.hasOwn(created.payload.backup, 'directory'), false);
    assert.equal(Object.hasOwn(created.payload.backup, 'manifestPath'), false);

    const listed = await requestJson(baseUrl, '/api/workspace/backups', { headers: { cookie: adminCookie } });
    assert.equal(listed.response.status, 200);
    assert.ok(listed.payload.backups.some((item) => item.backupId === 'api-backup-test'));

    const verified = await requestJson(baseUrl, '/api/workspace/backups/api-backup-test/verify', {
      method: 'POST',
      headers: { cookie: adminCookie },
      body: '{}',
    });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.payload.verification.status, 'PASS');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
    await rm(offsiteDir, { recursive: true, force: true });
  }
});
