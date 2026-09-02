import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return { response, payload: await response.json() };
}

test('content workflow endpoints persist task, node evidence and review state', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-content-workflow-'));
  const port = 32500 + Math.floor(Math.random() * 400);
  await Promise.all([
    writeFile(join(dataDir, 'accounts.json'), JSON.stringify([{ id: 'acct_fixture', name: '内容测试账号', platform: 'xhs', sourceUrl: 'https://www.xiaohongshu.com/user/profile/6a043b3d0000000002002000', userId: '6a043b3d0000000002002000', state: 'pending' }])),
    writeFile(join(dataDir, 'works.json'), '[]'),
    writeFile(join(dataDir, 'activity.json'), '[]'),
    writeFile(join(dataDir, 'feedback.json'), '[]'),
    writeFile(join(dataDir, 'content-tasks.json'), '[]'),
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
    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await jsonRequest(`${baseUrl}/api/content/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'API 内容任务',
        objective: '验证内容编辑工作流骨架',
        platforms: ['小红书'],
        sourceBrief: '测试素材说明',
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.task.nodes.length, 26);
    assert.equal(created.payload.task.status, 'draft');

    const taskId = created.payload.task.id;
    const started = await jsonRequest(`${baseUrl}/api/content/tasks/${encodeURIComponent(taskId)}/start`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(started.response.status, 200);
    assert.equal(started.payload.task.run.status, 'queued');
    assert.equal(started.payload.task.nodes[1].status, 'ready');

    const recorded = await jsonRequest(`${baseUrl}/api/content/tasks/${encodeURIComponent(taskId)}/nodes/CE-02/record`, {
      method: 'POST',
      body: JSON.stringify({
        status: 'succeeded',
        output: { brand: '测试品牌' },
        note: '本地测试节点结果',
      }),
    });
    assert.equal(recorded.response.status, 200);
    assert.equal(recorded.payload.task.status, 'waiting_review');
    assert.equal(recorded.payload.task.nodes[2].status, 'ready');

    const replay = await jsonRequest(`${baseUrl}/api/content/tasks/${encodeURIComponent(taskId)}/replay`, {
      method: 'GET',
    });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.payload.replay.runId, recorded.payload.task.run.id);
    assert.equal(replay.payload.replay.complete, true);
    assert.equal(replay.payload.replay.events.length, 2);
    assert.equal(replay.payload.replay.events[1].taskSnapshot.nodes[1].output.brand, '测试品牌');

    const bypassedReview = await jsonRequest(`${baseUrl}/api/content/tasks/${encodeURIComponent(taskId)}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', note: '不应允许绕过审核单' }),
    });
    assert.equal(bypassedReview.response.status, 400);
    assert.match(bypassedReview.payload.error, /请先完成 CE-19 审核单/);

    for (const nodeId of Array.from({ length: 17 }, (_, index) => `CE-${String(index + 3).padStart(2, '0')}`)) {
      const completed = await jsonRequest(`${baseUrl}/api/content/tasks/${encodeURIComponent(taskId)}/nodes/${nodeId}/record`, {
        method: 'POST',
        body: JSON.stringify({ status: 'succeeded', output: { fixture: nodeId }, note: '为审核准备完成节点' }),
      });
      assert.equal(completed.response.status, 200);
    }

    const reviewed = await jsonRequest(`${baseUrl}/api/content/tasks/${encodeURIComponent(taskId)}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'changes_requested', note: '请补充品牌事实来源' }),
    });
    assert.equal(reviewed.response.status, 200);
    assert.equal(reviewed.payload.task.status, 'changes_requested');
    assert.equal(reviewed.payload.task.reviews.length, 1);
    assert.equal(reviewed.payload.task.nodes.find((node) => node.id === 'CE-21').status, 'ready');

    const revised = await jsonRequest(`${baseUrl}/api/content/tasks/${encodeURIComponent(taskId)}/revision`, {
      method: 'POST',
      body: JSON.stringify({ changes: '补充品牌事实来源', content: { text: '修订后的内容草案' } }),
    });
    assert.equal(revised.response.status, 200);
    assert.equal(revised.payload.task.nodes.find((node) => node.id === 'CE-21').status, 'succeeded');
    assert.equal(revised.payload.task.nodes.find((node) => node.id === 'CE-22').status, 'ready');
    assert.equal(revised.payload.version.content.text, '修订后的内容草案');
    assert.equal(revised.payload.task.versions.length, 1);

    const approved = await jsonRequest(`${baseUrl}/api/content/tasks/${encodeURIComponent(taskId)}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', note: '修订后通过' }),
    });
    assert.equal(approved.response.status, 200);
    assert.equal(approved.payload.task.status, 'approved');

    const listed = await jsonRequest(`${baseUrl}/api/content/tasks`, { method: 'GET' });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.payload.tasks.length, 1);
    assert.equal(listed.payload.tasks[0].id, taskId);
    assert.equal(listed.payload.workflow.nodeCount, 26);

    const savedTasks = JSON.parse(await readFile(join(dataDir, 'content-tasks.json'), 'utf8'));
    assert.equal(savedTasks.length, 1);
    assert.equal(savedTasks[0].nodes[1].evidence.length, 1);
    assert.equal(savedTasks[0].reviews[0].decision, 'changes_requested');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('workflow control endpoints pause, resume, retry and replay the same run', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-content-controls-'));
  const port = 32900 + Math.floor(Math.random() * 300);
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
      XHS_DATA_DIR: dataDir,
      XHS_MONITOR_PORT: String(port),
      XHS_REFRESH_MINUTES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(port, child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await jsonRequest(`${baseUrl}/api/content/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: '运行控制测试', sourceBrief: '控制链路测试素材' }),
    });
    assert.equal(created.response.status, 201);
    const taskId = created.payload.task.id;

    const started = await jsonRequest(`${baseUrl}/api/content/tasks/${encodeURIComponent(taskId)}/start`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(started.response.status, 200);

    const paused = await jsonRequest(`${baseUrl}/api/content/tasks/${encodeURIComponent(taskId)}/pause`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(paused.response.status, 200);
    assert.equal(paused.payload.task.status, 'paused');
    assert.equal(paused.payload.task.run.status, 'paused');

    const resumed = await jsonRequest(`${baseUrl}/api/content/tasks/${encodeURIComponent(taskId)}/resume`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(resumed.response.status, 200);
    assert.equal(resumed.payload.task.status, 'running');
    assert.equal(resumed.payload.task.run.status, 'running');

    const failed = await jsonRequest(`${baseUrl}/api/content/tasks/${encodeURIComponent(taskId)}/nodes/CE-02/record`, {
      method: 'POST',
      body: JSON.stringify({ status: 'failed', error: '测试连接器失败' }),
    });
    assert.equal(failed.response.status, 200);
    assert.equal(failed.payload.task.run.status, 'failed');

    const retried = await jsonRequest(`${baseUrl}/api/content/tasks/${encodeURIComponent(taskId)}/retry`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'CE-02' }),
    });
    assert.equal(retried.response.status, 200);
    assert.equal(retried.payload.task.run.status, 'retrying');
    assert.equal(retried.payload.task.nodes[1].status, 'ready');
    assert.equal(retried.payload.task.nodes[1].attempts, 1);

    const replay = await jsonRequest(`${baseUrl}/api/content/tasks/${encodeURIComponent(taskId)}/replay`, {
      method: 'GET',
    });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.payload.replay.complete, true);
    assert.deepEqual(
      replay.payload.replay.events.map((event) => event.type),
      ['workflow_started', 'workflow_paused', 'workflow_resumed', 'content_node_recorded', 'content_node_retry_requested'],
    );
    assert.equal(replay.payload.replay.events[2].data.nodeId, 'CE-02');
    assert.equal(replay.payload.replay.events[4].taskSnapshot.run.status, 'retrying');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
