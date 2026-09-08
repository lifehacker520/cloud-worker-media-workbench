import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const PROJECT_DIR = resolve(import.meta.dirname, '..');

async function freePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before becoming ready');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(400) });
      if (response.ok) return;
    } catch {
      // 等待服务完成本地数据初始化。
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
  }
  throw new Error('timed out waiting for server');
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  return { response, payload: await response.json() };
}

async function stop(child) {
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
}

test('download center exposes the three platforms and keeps resolved media server-side', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-download-center-api-'));
  const fixturePath = join(dataDir, 'download-session-fixture.mjs');
  const port = await freePort();
  await writeFile(
    fixturePath,
    `globalThis.__CLOUD_WORKER_BROWSER_SESSION__ = {
  async resolveMedia(platform) {
    if (platform !== 'channels') throw new Error('unexpected platform');
    return {
      title: '视频号测试作品',
      author: '测试作者',
      videoUrl: 'https://finder.video.qq.com/251/20350/stodownload/test.mp4',
      coverUrl: 'https://qpic.cn/cover/test.jpg',
    };
  },
};
`,
    'utf8',
  );
  const child = spawn(process.execPath, ['--import', pathToFileURL(fixturePath).href, 'server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      XHS_AUTH_REQUIRED: 'false',
      XHS_DATA_DIR: dataDir,
      XHS_MONITOR_PORT: String(port),
      XHS_REFRESH_MINUTES: '0',
      XHS_DOWNLOAD_RESOLVER_URL: 'http://127.0.0.1:1',
      DOUYIN_DOWNLOAD_RESOLVER_URL: 'http://127.0.0.1:1',
      WEIXIN_RESOLVER_URL: 'http://127.0.0.1:1',
      MEDIA_DOWNLOAD_RESOLVER_URL: 'http://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(port, child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const catalog = await jsonRequest(baseUrl + '/api/download-center/catalog');
    assert.equal(catalog.response.status, 200);
    assert.deepEqual(catalog.payload.platforms.map((platform) => platform.id), ['xhs', 'douyin', 'channels']);

    const invalid = await jsonRequest(baseUrl + '/api/download-center/resolve', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://www.xiaohongshu.com/user/profile/123456' }),
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.payload.code, 'DOWNLOAD_LINK_UNSUPPORTED');

    const resolved = await jsonRequest(baseUrl + '/api/download-center/resolve', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://weixin.qq.com/sph/Abc_1234' }),
    });
    assert.equal(resolved.response.status, 201);
    assert.equal(resolved.payload.task.platform, 'channels');
    assert.equal(resolved.payload.task.available.video, true);
    assert.equal(resolved.payload.task.available.cover, true);
    assert.match(resolved.payload.task.previewUrls.video, /\/api\/download-center\/tasks\//);

    const tasks = await jsonRequest(baseUrl + '/api/download-center/tasks');
    assert.equal(tasks.response.status, 200);
    assert.equal(tasks.payload.tasks.length, 1);
    assert.equal(JSON.stringify(tasks.payload).includes('finder.video.qq.com'), false);
    assert.equal(JSON.stringify(tasks.payload).includes('qpic.cn'), false);
    assert.equal(JSON.stringify(tasks.payload).includes('localFilePath'), false);

    const unsupportedKind = await jsonRequest(
      baseUrl + '/api/download-center/tasks/' + encodeURIComponent(resolved.payload.task.id),
      { method: 'POST', body: JSON.stringify({ kind: 'audio' }) },
    );
    assert.equal(unsupportedKind.response.status, 409);
    assert.equal(unsupportedKind.payload.code, 'DOWNLOAD_ASSET_NOT_FOUND');
  } finally {
    await stop(child);
    await rm(dataDir, { recursive: true, force: true });
  }
});
