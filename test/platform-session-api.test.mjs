import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const PROJECT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

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
      if (response.ok) return;
    } catch {
      // 等待 SQLite 初始化和本地服务监听。
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
  }
  throw new Error('timed out waiting for server');
}

test('platform session API exposes safe status and delegates open/clear to desktop runtime', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-platform-session-api-'));
  const fixturePath = join(dataDir, 'desktop-session-fixture.mjs');
  const port = 34500 + Math.floor(Math.random() * 400);
  await writeFile(
    fixturePath,
    `globalThis.__CLOUD_WORKER_BROWSER_SESSION__ = {
  getStatus() {
    return {
      available: true,
      mode: 'desktop-persistent',
      persistent: true,
      note: 'safe fixture',
      platforms: [
        { platform: 'xhs', label: '小红书', persistent: true, windowOpen: false, status: 'ready', loginState: 'unknown', lastUsedAt: null, lastClearedAt: null },
      ],
    };
  },
  async open(platform) {
    if (platform !== 'xhs') throw new Error('暂不支持浏览器补采的平台：' + platform);
    return { platform, persistent: true, windowOpen: true, loginState: 'unknown' };
  },
  async clear(platform) {
    if (platform !== 'xhs') throw new Error('暂不支持浏览器补采的平台：' + platform);
    return { platform, persistent: true, windowOpen: false, status: 'cleared', loginState: 'unknown' };
  },
};
`,
    'utf8',
  );

  const child = spawn(process.execPath, ['--import', fixturePath, 'server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      XHS_AUTH_REQUIRED: 'false',
      XHS_DATA_DIR: dataDir,
      XHS_MONITOR_PORT: String(port),
      XHS_REFRESH_MINUTES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(port, child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const statusResponse = await fetch(baseUrl + '/api/platform-sessions');
    const statusPayload = await statusResponse.json();
    assert.equal(statusResponse.status, 200);
    assert.equal(statusPayload.ok, true);
    assert.equal(statusPayload.available, true);
    assert.equal(statusPayload.platforms[0].persistent, true);
    assert.equal(statusPayload.platforms[0].loginState, 'unknown');
    assert.equal(JSON.stringify(statusPayload).includes('cookieValue'), false);

    const openResponse = await fetch(baseUrl + '/api/platform-sessions/xhs/open', { method: 'POST' });
    const openPayload = await openResponse.json();
    assert.equal(openResponse.status, 200);
    assert.equal(openPayload.ok, true);
    assert.equal(openPayload.status.windowOpen, true);

    const clearResponse = await fetch(baseUrl + '/api/platform-sessions/xhs/clear', { method: 'POST' });
    const clearPayload = await clearResponse.json();
    assert.equal(clearResponse.status, 200);
    assert.equal(clearPayload.ok, true);
    assert.equal(clearPayload.status.status, 'cleared');

    const webModeResponse = await fetch(baseUrl + '/api/platform-sessions/not-a-platform/open', { method: 'POST' });
    assert.equal(webModeResponse.status, 409, 'unknown platform should be rejected by the desktop controller');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
