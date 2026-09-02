import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
      // Startup refresh may still be initializing.
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
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

test('content runtime parses a real local text asset, writes SQLite and indexes knowledge', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-runtime-'));
  const port = 32600 + Math.floor(Math.random() * 200);
  const materialPath = join(dataDir, 'source.md');
  await Promise.all([
    writeFile(join(dataDir, 'accounts.json'), '[]'),
    writeFile(join(dataDir, 'works.json'), '[]'),
    writeFile(join(dataDir, 'activity.json'), '[]'),
    writeFile(join(dataDir, 'feedback.json'), '[]'),
    writeFile(join(dataDir, 'content-tasks.json'), '[]'),
    writeFile(materialPath, '# 目标\n验证知识库检索和素材解析\n', 'utf8'),
  ]);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: '',
      XHS_LOCAL_DRAFT_GENERATOR: 'true',
      XHS_DATA_DIR: dataDir,
      XHS_MONITOR_PORT: String(port),
      XHS_MEDIA_ROOTS: dataDir,
      XHS_REFRESH_MINUTES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(port, child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const workspace = await jsonRequest(baseUrl + '/api/workspace');
    assert.equal(workspace.response.status, 200);
    assert.equal(workspace.payload.storage.type, 'sqlite');
    const state = await jsonRequest(baseUrl + '/api/state');
    assert.equal(state.response.status, 200);
    assert.equal(state.payload.accounts.length, 0);
    assert.ok(workspace.payload.connectors.some((connector) => connector.capabilities.includes('media.probe')));

    const customer = await jsonRequest(baseUrl + '/api/workspace/customers', {
      method: 'POST',
      body: JSON.stringify({ name: '运行时验收客户', industry: '内容服务', metadata: { source: 'runtime-test' } }),
    });
    assert.equal(customer.response.status, 201, JSON.stringify(customer.payload));
    const brandProfile = await jsonRequest(baseUrl + '/api/workspace/brand-profiles', {
      method: 'POST',
      body: JSON.stringify({
        projectId: workspace.payload.project.id,
        customerId: customer.payload.customer.id,
        name: '运行时品牌资料',
        voice: '清晰可信',
        constraints: { forbiddenClaims: ['绝对化承诺'] },
      }),
    });
    assert.equal(brandProfile.response.status, 201, JSON.stringify(brandProfile.payload));
    const contextWorkspace = await jsonRequest(baseUrl + '/api/workspace');
    assert.ok(contextWorkspace.payload.customers.some((item) => item.id === customer.payload.customer.id));
    assert.ok(contextWorkspace.payload.brandProfiles.some((item) => item.id === brandProfile.payload.brandProfile.id));

    const created = await jsonRequest(baseUrl + '/api/content/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: '运行时素材任务',
        objective: '验证真实文件进入内容工作流',
        customerId: customer.payload.customer.id,
        brandProfileId: brandProfile.payload.brandProfile.id,
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.task.customerId, customer.payload.customer.id);
    assert.equal(created.payload.task.brandProfileId, brandProfile.payload.brandProfile.id);
    const taskId = created.payload.task.id;
    await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/start`, { method: 'POST', body: '{}' });
    for (const nodeId of ['CE-02', 'CE-03']) {
      const node = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/nodes/${nodeId}/record`, {
        method: 'POST',
        body: JSON.stringify({ status: 'succeeded', output: { source: 'runtime-test' } }),
      });
      assert.equal(node.response.status, 200);
    }
    const parsed = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/materials/parse`, {
      method: 'POST',
      body: JSON.stringify({ path: materialPath }),
    });
    assert.equal(parsed.response.status, 200);
    assert.equal(parsed.payload.asset.kind, 'text');
    assert.equal(parsed.payload.task.nodes.find((node) => node.id === 'CE-04').status, 'succeeded');
    assert.equal(parsed.payload.task.nodes.find((node) => node.id === 'CE-05').status, 'succeeded');

    for (const nodeId of ['CE-06', 'CE-07', 'CE-08']) {
      const executed = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/execute-node`, {
        method: 'POST',
        body: JSON.stringify({ nodeId }),
      });
      assert.equal(executed.response.status, 200);
      assert.ok(['succeeded', 'skipped'].includes(executed.payload.task.nodes.find((node) => node.id === nodeId).status));
    }
    const analyzed = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/analyze`, { method: 'POST', body: '{}' });
    assert.equal(analyzed.response.status, 200);
    assert.equal(analyzed.payload.task.nodes.find((node) => node.id === 'CE-09').status, 'succeeded');

    const topic = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'topic', query: '知识库' }),
    });
    assert.equal(topic.response.status, 200);
    assert.equal(topic.payload.output.provider, 'local-template');
    assert.match(topic.payload.output.text, /候选选题/);
    assert.equal(topic.payload.task.nodes.find((node) => node.id === 'CE-10').status, 'succeeded');

    const copy = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'copy', query: '知识库' }),
    });
    assert.equal(copy.response.status, 200);
    assert.equal(copy.payload.output.provider, 'local-template');
    assert.equal(copy.payload.task.nodes.find((node) => node.id === 'CE-11').status, 'succeeded');

    for (const [kind, nodeId] of [['platform', 'CE-12'], ['shotlist', 'CE-13']]) {
      const generated = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/generate`, {
        method: 'POST',
        body: JSON.stringify({ kind, query: '知识库' }),
      });
      assert.equal(generated.response.status, 200);
      assert.equal(generated.payload.output.provider, 'local-template');
      assert.equal(generated.payload.task.nodes.find((node) => node.id === nodeId).status, 'succeeded');
    }

    for (const nodeId of ['CE-14', 'CE-15', 'CE-16', 'CE-17', 'CE-18']) {
      const executed = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/execute-node`, {
        method: 'POST',
        body: JSON.stringify({ nodeId }),
      });
      assert.equal(executed.response.status, 200);
      assert.equal(executed.payload.task.nodes.find((node) => node.id === nodeId).status, 'skipped');
    }

    const reviewChecklist = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/execute-node`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'CE-19' }),
    });
    assert.equal(reviewChecklist.response.status, 200);
    assert.equal(reviewChecklist.payload.task.nodes.find((node) => node.id === 'CE-19').status, 'succeeded');

    const approved = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', note: '本地测试内容通过审核' }),
    });
    assert.equal(approved.response.status, 200);
    assert.equal(approved.payload.task.nodes.find((node) => node.id === 'CE-22').status, 'ready');

    const packaged = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/package`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(packaged.response.status, 200);
    assert.equal(packaged.payload.task.nodes.find((node) => node.id === 'CE-22').status, 'succeeded');
    assert.ok(packaged.payload.package.path);
    assert.ok(packaged.payload.package.manifest.endsWith('-manifest.json'));
    const packageBytes = await readFile(packaged.payload.package.path);
    assert.ok(packageBytes.includes(Buffer.from('-manifest.json')));
    const manifest = JSON.parse(await readFile(packaged.payload.package.manifest, 'utf8'));
    assert.equal(manifest.schemaVersion, 'content-package-v0.1');
    assert.match(manifest.nodes.find((node) => node.id === 'CE-10').output.text, /候选选题/);
    assert.equal(manifest.reviews.length, 1);

    const releaseDraft = await jsonRequest(baseUrl + `/api/content/tasks/${taskId}/release-drafts`, {
      method: 'POST',
      body: JSON.stringify({ platform: 'xhs', title: '本地测试草稿', text: '仅供测试，不直接发布' }),
    });
    assert.equal(releaseDraft.response.status, 201);
    assert.equal(releaseDraft.payload.task.nodes.find((node) => node.id === 'CE-23').status, 'succeeded');

    const knowledge = await jsonRequest(baseUrl + '/api/knowledge/search?q=知识库');
    assert.equal(knowledge.response.status, 200);
    assert.equal(knowledge.payload.results.length, 1);
    const dbStat = await readFile(join(dataDir, 'workbench.sqlite'));
    assert.ok(dbStat.length > 0);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
