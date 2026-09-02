import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

test('admin invitations create one-time members and directory sync updates the same tenant', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-directory-'));
  const port = 32700 + Math.floor(Math.random() * 200);
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
      XHS_AUTH_SECRET: 'directory-test-secret',
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

    const project = await requestJson(baseUrl, '/api/workspace/projects', {
      method: 'POST',
      headers: { cookie: adminCookie },
      body: JSON.stringify({ tenantId: 'tenant_client', tenantName: '目录测试客户', slug: 'directory-project', name: '目录同步项目' }),
    });
    assert.equal(project.response.status, 201);
    const projectId = project.payload.project.id;

    const invitation = await requestJson(baseUrl, '/api/workspace/invitations', {
      method: 'POST',
      headers: { cookie: adminCookie },
      body: JSON.stringify({
        tenantId: 'tenant_client',
        username: 'invitee01',
        displayName: '邀请成员',
        projectId,
        memberRole: 'member',
        expiresInHours: 48,
      }),
    });
    assert.equal(invitation.response.status, 201);
    assert.ok(invitation.payload.invitation.token);
    assert.equal(invitation.payload.invitation.status, 'pending');

    const listedInvitations = await requestJson(baseUrl, '/api/workspace/invitations', { headers: { cookie: adminCookie } });
    assert.equal(listedInvitations.response.status, 200);
    assert.equal(listedInvitations.payload.invitations.length, 1);
    assert.equal('token' in listedInvitations.payload.invitations[0], false);

    const accepted = await requestJson(baseUrl, '/api/auth/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token: invitation.payload.invitation.token, password: 'invite-pass-123' }),
    });
    assert.equal(accepted.response.status, 201);
    assert.equal(accepted.payload.user.username, 'invitee01');
    assert.equal(accepted.payload.user.tenantId, 'tenant_client');

    const inviteeLogin = await requestJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'invitee01', password: 'invite-pass-123' }),
    });
    assert.equal(inviteeLogin.response.status, 200);
    const inviteeCookie = inviteeLogin.response.headers.get('set-cookie');
    const inviteeWorkspace = await requestJson(baseUrl, '/api/workspace', { headers: { cookie: inviteeCookie } });
    assert.equal(inviteeWorkspace.response.status, 200);
    assert.ok(inviteeWorkspace.payload.projectMembers.some((member) => member.username === 'invitee01'));

    const reused = await requestJson(baseUrl, '/api/auth/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token: invitation.payload.invitation.token, password: 'another-pass-123' }),
    });
    assert.equal(reused.response.status, 409);

    const dryRun = await requestJson(baseUrl, '/api/workspace/directory/sync', {
      method: 'POST',
      headers: { cookie: adminCookie },
      body: JSON.stringify({
        tenantId: 'tenant_client',
        source: 'test-directory-preview',
        mode: 'dry_run',
        members: [{ username: 'preview01', displayName: '预览成员', role: 'client', status: 'active', projects: [{ projectId, memberRole: 'member' }] }],
      }),
    });
    assert.equal(dryRun.response.status, 200);
    assert.equal(dryRun.payload.mode, 'dry_run');
    const afterDryRun = await requestJson(baseUrl, '/api/workspace/users?tenantId=tenant_client', { headers: { cookie: adminCookie } });
    assert.equal(afterDryRun.response.status, 200);
    assert.equal(afterDryRun.payload.users.some((user) => user.username === 'preview01'), false);

    const synced = await requestJson(baseUrl, '/api/workspace/directory/sync', {
      method: 'POST',
      headers: { cookie: adminCookie },
      body: JSON.stringify({
        tenantId: 'tenant_client',
        source: 'test-directory',
        members: [
          { username: 'invitee01', displayName: '目录更新成员', role: 'client', status: 'active', projects: [{ projectId, memberRole: 'manager' }] },
          { username: 'sync02', displayName: '目录新增成员', role: 'client', status: 'active', projects: [{ projectId, memberRole: 'reviewer' }] },
        ],
      }),
    });
    assert.equal(synced.response.status, 200);
    assert.equal(synced.payload.summary.created, 1);
    assert.equal(synced.payload.summary.updated, 1);
    assert.equal(synced.payload.summary.projectBindings, 2);

    const users = await requestJson(baseUrl, '/api/workspace/users?tenantId=tenant_client', { headers: { cookie: adminCookie } });
    assert.equal(users.response.status, 200);
    assert.ok(users.payload.users.some((user) => user.username === 'sync02'));
    assert.equal(users.payload.users.find((user) => user.username === 'invitee01').displayName, '目录更新成员');

    const disabled = await requestJson(baseUrl, '/api/workspace/users/invitee01', {
      method: 'PATCH',
      headers: { cookie: adminCookie },
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(disabled.response.status, 200);
    const disabledSessionAccess = await requestJson(baseUrl, '/api/workspace', { headers: { cookie: inviteeCookie } });
    assert.equal(disabledSessionAccess.response.status, 401);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
