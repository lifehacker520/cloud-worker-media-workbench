import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
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
      // The first refresh can still be initializing.
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

test('persistent members, project membership and connector configuration are tenant-scoped', async () => {
  const dataDir = await mkdtemp('/tmp/cloud-worker-admin-');
  const port = 32900 + Math.floor(Math.random() * 200);
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
      XHS_AUTH_SECRET: 'workspace-admin-test-secret',
      XHS_ADMIN_PASSWORD: 'admin-pass-123',
      XHS_CLIENT_PASSWORD: 'client-pass-123',
      XHS_ADMIN_TENANT_ID: 'tenant_admin',
      XHS_CLIENT_TENANT_ID: 'tenant_client',
      XHS_DATA_DIR: dataDir,
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
    assert.equal(adminLogin.response.status, 200);
    const adminCookie = adminLogin.response.headers.get('set-cookie');
    assert.ok(adminCookie);

    const project = await requestJson(baseUrl, '/api/workspace/projects', {
      method: 'POST',
      headers: { cookie: adminCookie },
      body: JSON.stringify({ tenantId: 'tenant_client', tenantName: '测试客户', slug: 'content-editor', name: '客户内容项目' }),
    });
    assert.equal(project.response.status, 201);
    const projectId = project.payload.project.id;

    const member = await requestJson(baseUrl, '/api/workspace/users', {
      method: 'POST',
      headers: { cookie: adminCookie },
      body: JSON.stringify({ username: 'editor01', password: 'editor-pass-123', displayName: '编辑成员', tenantId: 'tenant_client', projectId }),
    });
    assert.equal(member.response.status, 201);
    assert.equal(member.payload.user.tenantId, 'tenant_client');

    const members = await requestJson(baseUrl, `/api/workspace/projects/${encodeURIComponent(projectId)}/members`, {
      headers: { cookie: adminCookie },
    });
    assert.equal(members.response.status, 200);
    assert.ok(members.payload.members.some((item) => item.username === 'editor01'));

    const editorLogin = await requestJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'editor01', password: 'editor-pass-123' }),
    });
    assert.equal(editorLogin.response.status, 200);
    assert.equal(editorLogin.payload.user.tenantId, 'tenant_client');
    const editorCookie = editorLogin.response.headers.get('set-cookie');
    const editorWorkspace = await requestJson(baseUrl, '/api/workspace', { headers: { cookie: editorCookie } });
    assert.equal(editorWorkspace.response.status, 200);
    assert.equal(editorWorkspace.payload.tenant.id, 'tenant_client');
    assert.equal(editorWorkspace.payload.project.id, projectId);

    const adminConnectors = await requestJson(baseUrl, '/api/workspace/connectors', { headers: { cookie: adminCookie } });
    const publish = adminConnectors.payload.connectors.find((item) => item.tenantId === 'tenant_client' && item.config?.platform === 'xhs');
    assert.ok(publish);
    const configured = await requestJson(baseUrl, `/api/workspace/connectors/${encodeURIComponent(publish.id)}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie },
      body: JSON.stringify({ status: 'ready', config: { platform: 'xhs', executor: 'manual-browser' } }),
    });
    assert.equal(configured.response.status, 200);
    assert.equal(configured.payload.connector.status, 'ready');

    const forbidden = await requestJson(baseUrl, '/api/workspace/users', { headers: { cookie: editorCookie } });
    assert.equal(forbidden.response.status, 403);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
