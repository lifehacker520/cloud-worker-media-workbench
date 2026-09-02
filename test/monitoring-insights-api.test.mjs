import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildMonitoringEvidence } from '../src/monitoring-insights.mjs';
import { WorkbenchStore } from '../src/workbench-store.mjs';

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

test('monitoring insights endpoint returns period-filtered metrics and comments', async () => {
  const dataDir = await mkdtemp('/tmp/cloud-worker-monitoring-insights-api-');
  const port = 34000 + Math.floor(Math.random() * 500);
  const account = {
    id: 'account_insights_api',
    tenantId: 'tenant_local',
    name: '看板接口测试账号',
    group: '接口测试',
    platform: 'douyin',
    sourceUrl: 'https://www.douyin.com/user/aweme_test_user_123',
    canonicalUrl: 'https://www.douyin.com/user/aweme_test_user_123',
    userId: 'aweme_test_user_123',
    state: 'active',
  };
  const work = {
    id: 'work_insights_api',
    fingerprint: 'insights-api-fingerprint',
    tenantId: account.tenantId,
    accountId: account.id,
    platform: account.platform,
    contentId: 'video_insights_api',
    title: '看板接口测试作品',
    publishedAt: '2026-09-01T02:00:00.000Z',
    discoveredAt: '2026-09-01T02:00:00.000Z',
    link: 'https://www.douyin.com/video/video_insights_api',
    seen: true,
  };
  const evidence = buildMonitoringEvidence({
    account,
    works: [
      {
        ...work,
        metrics: { play_count: 56000, like_count: 12000, comment_count: 32 },
      },
    ],
    observedAt: '2026-09-01T23:00:00.000Z',
    source: 'official-fixture',
    comments: [
      {
        id: 'comment_insights_api',
        workId: work.id,
        content: '请问怎么使用？',
        nickname: '访客 A',
        createTime: '2026-09-01T22:00:00.000Z',
      },
    ],
  });
  const store = await WorkbenchStore.open(dataDir);
  store.replaceMonitoringData({ accounts: [account], works: [work], activity: [], feedback: [] });
  store.saveMonitoringMetricSnapshots(evidence.snapshots);
  store.saveMonitoringComments(evidence.comments);
  store.close();

  const child = spawn(process.execPath, ['server.mjs'], {
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
    const response = await fetch(`http://127.0.0.1:${port}/api/monitoring/insights?period=month&platform=douyin`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.insights.summary.publishedCount, 1);
    assert.equal(payload.insights.summary.metrics.play_count.value, 56000);
    assert.equal(payload.insights.summary.metrics.like_count.value, 12000);
    assert.equal(payload.insights.comments.count, 1);
    assert.equal(payload.insights.comments.items[0].text, '请问怎么使用？');
    assert.equal(payload.insights.platforms[0].platform, 'douyin');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('demo monitoring mode provides three platform dashboards without touching real platform sessions', async () => {
  const dataDir = await mkdtemp('/tmp/cloud-worker-monitoring-demo-api-');
  const port = 34500 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      XHS_AUTH_REQUIRED: 'false',
      XHS_MONITOR_DEMO: 'true',
      XHS_DATA_DIR: dataDir,
      XHS_MONITOR_PORT: String(port),
      XHS_REFRESH_MINUTES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(port, child);
    const response = await fetch(`http://127.0.0.1:${port}/api/monitoring/insights?period=all`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.insights.summary.accountCount, 3);
    assert.equal(payload.insights.platforms.length, 3);
    assert.equal(payload.insights.summary.metrics.play_count.value, 142000);
    assert.equal(payload.insights.summary.metrics.read_count.value, 23200);
    assert.equal(payload.insights.summary.metrics.like_count.value, 10100);
    assert.equal(payload.insights.summary.metrics.follower_count.value, 111700);
    assert.equal(payload.insights.comments.count, 3);
    assert.deepEqual(
      payload.insights.platforms.map((item) => item.platform),
      ['xhs', 'douyin', 'channels'],
    );
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
