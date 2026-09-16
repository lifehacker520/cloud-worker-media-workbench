import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function waitForServer(port, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before becoming ready');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(400) });
      if (response.ok) return;
    } catch {}
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

/* V4-02b：工作台项目与本页数据作用域。
   全程使用临时数据目录里的隔离副本，创建两个真实工作台项目，验证：
   项目列表只来自 /api/workspace/projects、四个读取接口按 projectId 隔离、
   切换项目后草稿/档案不串数据，以及不存在的 projectId 如实报错而不是回落默认项目。 */
test('digital human endpoints scope by workbench project without leaking across projects', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-dh-scope-'));
  const port = 33100 + Math.floor(Math.random() * 150);
  await Promise.all([
    writeFile(join(dataDir, 'accounts.json'), '[]'),
    writeFile(join(dataDir, 'works.json'), '[]'),
    writeFile(join(dataDir, 'activity.json'), '[]'),
    writeFile(join(dataDir, 'feedback.json'), '[]'),
    writeFile(join(dataDir, 'content-tasks.json'), '[]'),
  ]);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: { ...process.env, XHS_DATA_DIR: dataDir, XHS_MONITOR_PORT: String(port), XHS_REFRESH_MINUTES: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(port, child);
    const baseUrl = `http://127.0.0.1:${port}`;

    /* 1. 先创建一个不指定项目的内容任务，让默认工作台项目真实存在。 */
    const defaultTask = await jsonRequest(`${baseUrl}/api/content/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: '默认项目任务', objective: '作用域验收基线' }),
    });
    assert.equal(defaultTask.payload.ok, true, '默认任务创建失败');
    const defaultProjectId = defaultTask.payload.task.projectId;
    assert.ok(defaultProjectId, '默认任务没有归属项目');

    /* 2. 建两个项目，每个项目一条内容任务 + 一条文案候选 + 一个项目档案。 */
    const projects = {};
    for (const slug of ['scope-alpha', 'scope-beta']) {
      const created = await jsonRequest(`${baseUrl}/api/workspace/projects`, {
        method: 'POST',
        body: JSON.stringify({ slug, name: '作用域项目 ' + slug, description: 'V4-02b 隔离验收' }),
      });
      assert.equal(created.payload.ok, true, '项目创建失败：' + slug);
      projects[slug] = created.payload.project;
      const task = await jsonRequest(`${baseUrl}/api/content/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          projectId: projects[slug].id,
          title: slug + ' 的口播任务',
          objective: '验证按项目隔离',
        }),
      });
      assert.equal(task.payload.ok, true, slug + ' 任务创建失败');
      projects[slug].taskId = task.payload.task.id;
      assert.equal(task.payload.task.projectId, projects[slug].id, slug + ' 任务挂到了别的项目');

      const scriptSet = await jsonRequest(`${baseUrl}/api/content/script-sets`, {
        method: 'POST',
        body: JSON.stringify({
          projectId: projects[slug].id,
          name: slug + ' 文案集',
          approved: true,
          versions: [{ id: 'script_' + slug, title: slug + ' 的文案', text: slug + ' 专属口播正文。' }],
        }),
      });
      assert.equal(scriptSet.payload.ok, true, slug + ' 文案登记失败：' + JSON.stringify(scriptSet.payload));
      projects[slug].scriptVersionId = scriptSet.payload.scriptSet.versions[0].id;

      const context = await jsonRequest(`${baseUrl}/api/content/digital-human/contexts`, {
        method: 'POST',
        body: JSON.stringify({
          projectId: projects[slug].id,
          name: slug + ' 项目档案',
          industry: '行业 ' + slug,
          product: '产品 ' + slug,
        }),
      });
      assert.equal(context.payload.ok, true, slug + ' 档案创建失败');
      projects[slug].contextId = context.payload.context.id;
    }

    /* 3. 项目列表：三个项目都真实可读，字段足够前端展示与选择。 */
    const list = await jsonRequest(`${baseUrl}/api/workspace/projects`);
    assert.equal(list.payload.ok, true);
    const listed = list.payload.projects;
    for (const slug of ['scope-alpha', 'scope-beta']) {
      const row = listed.find((item) => item.id === projects[slug].id);
      assert.ok(row, '项目列表里没有 ' + slug);
      for (const field of ['name', 'slug', 'status', 'updatedAt']) {
        assert.ok(row[field], '项目列表缺少字段 ' + field);
      }
    }
    assert.ok(listed.some((item) => item.id === defaultProjectId), '项目列表里没有默认项目');

    /* 4. summary：内容任务与生产批次都必须属于选中项目。 */
    for (const slug of ['scope-alpha', 'scope-beta']) {
      const summary = await jsonRequest(
        `${baseUrl}/api/content/digital-human/summary?projectId=${encodeURIComponent(projects[slug].id)}`,
      );
      assert.equal(summary.payload.ok, true);
      assert.equal(summary.payload.summary.project.id, projects[slug].id, slug + ' summary 项目不对');
      const taskIds = summary.payload.summary.contentTasks.map((item) => item.id);
      assert.deepEqual(taskIds, [projects[slug].taskId], slug + ' 的内容任务没有按项目隔离');
      assert.ok(summary.payload.summary.source.batchCount >= 0);
    }

    /* 5. copy 与 contexts：候选与档案版本都只来自本项目。 */
    for (const slug of ['scope-alpha', 'scope-beta']) {
      const copy = await jsonRequest(
        `${baseUrl}/api/content/digital-human/copy?projectId=${encodeURIComponent(projects[slug].id)}`,
      );
      assert.equal(copy.payload.ok, true);
      assert.deepEqual(copy.payload.copy.candidates.map((item) => item.id), [projects[slug].scriptVersionId],
        slug + ' 的文案候选串了项目');
      assert.equal(copy.payload.copy.source.projectId, projects[slug].id);

      const contexts = await jsonRequest(
        `${baseUrl}/api/content/digital-human/contexts?projectId=${encodeURIComponent(projects[slug].id)}`,
      );
      assert.equal(contexts.payload.ok, true);
      assert.deepEqual(contexts.payload.stage.versions.map((item) => item.id), [projects[slug].contextId],
        slug + ' 的项目档案串了项目');
    }

    /* 6. 切换作用域下的草稿：写入 A 的档案选择后，A 读得到、B 读不到。 */
    const saveDraft = await jsonRequest(`${baseUrl}/api/content/digital-human/draft`, {
      method: 'PUT',
      body: JSON.stringify({
        taskId: projects['scope-alpha'].taskId,
        title: 'alpha 草稿',
        selectedContextId: projects['scope-alpha'].contextId,
      }),
    });
    assert.equal(saveDraft.payload.ok, true, '草稿保存失败');
    assert.equal(saveDraft.payload.draft.projectId, projects['scope-alpha'].id, '草稿挂到了别的项目');

    const draftA = await jsonRequest(
      `${baseUrl}/api/content/digital-human/draft?projectId=${encodeURIComponent(projects['scope-alpha'].id)}`,
    );
    assert.equal(draftA.payload.draft?.selectedContextId, projects['scope-alpha'].contextId, 'A 没读到自己选的档案');
    const draftB = await jsonRequest(
      `${baseUrl}/api/content/digital-human/draft?projectId=${encodeURIComponent(projects['scope-beta'].id)}`,
    );
    assert.notEqual(draftB.payload.draft?.selectedContextId, projects['scope-alpha'].contextId,
      'B 读到了 A 的草稿选择（切换后没有隔离）');

    /* contexts 里的 selectedContextId 来自草稿，必须跟着项目走。 */
    const ctxA = await jsonRequest(
      `${baseUrl}/api/content/digital-human/contexts?projectId=${encodeURIComponent(projects['scope-alpha'].id)}`,
    );
    const ctxB = await jsonRequest(
      `${baseUrl}/api/content/digital-human/contexts?projectId=${encodeURIComponent(projects['scope-beta'].id)}`,
    );
    assert.equal(ctxA.payload.stage.selectedContextId, projects['scope-alpha'].contextId);
    assert.notEqual(ctxB.payload.stage.selectedContextId, projects['scope-alpha'].contextId,
      'B 的当前档案显示成了 A 的档案');

    /* 7. 不存在的 projectId 必须如实报错，不能静默回落到默认项目（防止页面把默认项目数据当成新项目数据）。 */
    const missing = await jsonRequest(`${baseUrl}/api/content/digital-human/summary?projectId=project_does_not_exist`);
    assert.equal(missing.payload.ok, false, '不存在的项目被静默接受');
    assert.match(missing.payload.error, /项目不存在|没有访问该项目的权限/);

    /* 8. 不传 projectId 时保持服务端既有默认项目行为（未选定项目 = 默认项目），不伪造空列表。 */
    const unscoped = await jsonRequest(`${baseUrl}/api/content/digital-human/summary`);
    assert.equal(unscoped.payload.ok, true);
    assert.equal(unscoped.payload.summary.project.id, defaultProjectId, '未指定项目时的默认作用域发生变化');
    assert.deepEqual(unscoped.payload.summary.contentTasks.map((item) => item.id), [defaultTask.payload.task.id]);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
  }
});

function once(target, event) {
  return new Promise((resolvePromise) => target.once(event, () => resolvePromise()));
}
