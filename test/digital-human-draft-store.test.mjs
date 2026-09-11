/**
 * CE-DH-F5-02｜最小任务草稿的持久化
 *
 * 草稿落在 content_batch_store 自己的 SQLite 表（digital_human_drafts）里，
 * 不是第二套批次真相：草稿没有明细、没有状态机、不会变成批次，
 * 真正的批次仍然只由 buildBatchPlan + createContentBatch 产生。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { ContentBatchStore } from '../src/content-batch-store.mjs';
import { WorkbenchStore } from '../src/workbench-store.mjs';

const actor = { username: 'owner', displayName: '内容负责人', role: 'admin', tenantId: 'tenant_local' };

async function openFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-dh-draft-'));
  const workbench = await WorkbenchStore.open(dataDir);
  workbench.ensureProject(actor, {
    id: 'project_content_editor',
    slug: 'content-editor',
    name: '内容编辑云员工',
  });
  const batches = new ContentBatchStore(workbench);
  batches.ensureSchema();
  return { dataDir, workbench, batches };
}

async function closeFixture(fixture) {
  fixture.workbench.close();
  await rm(fixture.dataDir, { recursive: true, force: true });
}

test('草稿可以保存、回读，刷新（重新打开存储）后仍然存在', async () => {
  const fixture = await openFixture();
  try {
    const saved = fixture.batches.saveDraft(actor, {
      projectId: 'project_content_editor',
      taskId: 'content_task_1',
      mode: 'A',
      title: '入职手机口播（草稿）',
      note: '先试单条',
      plannedItemCount: 2,
    });
    assert.equal(saved.mode, 'A');
    assert.equal(saved.title, '入职手机口播（草稿）');
    assert.equal(saved.taskId, 'content_task_1');

    const read = fixture.batches.getDraft(actor, 'project_content_editor', 'content_task_1');
    assert.equal(read.id, saved.id);
    assert.equal(read.note, '先试单条');
    assert.equal(read.plannedItemCount, 2);
    assert.equal(read.createdBy, 'owner');

    /* 模拟客户端刷新：关掉再打开同一个数据目录。 */
    const dataDir = fixture.dataDir;
    fixture.workbench.close();
    const reopened = await WorkbenchStore.open(dataDir);
    const batches = new ContentBatchStore(reopened);
    batches.ensureSchema();
    const afterReopen = batches.getDraft(actor, 'project_content_editor', 'content_task_1');
    assert.ok(afterReopen, '刷新后草稿必须仍然存在');
    assert.equal(afterReopen.title, '入职手机口播（草稿）');
    reopened.close();
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('草稿按内容任务隔离，重复保存是更新而不是新建第二份', async () => {
  const fixture = await openFixture();
  try {
    fixture.batches.saveDraft(actor, { projectId: 'project_content_editor', taskId: 'task_a', mode: 'A', title: '任务 A' });
    const second = fixture.batches.saveDraft(actor, { projectId: 'project_content_editor', taskId: 'task_b', mode: 'B', title: '任务 B' });
    assert.equal(fixture.batches.getDraft(actor, 'project_content_editor', 'task_a').title, '任务 A');
    assert.equal(fixture.batches.getDraft(actor, 'project_content_editor', 'task_b').title, '任务 B');

    const updated = fixture.batches.saveDraft(actor, { projectId: 'project_content_editor', taskId: 'task_b', mode: 'B', title: '任务 B（改）' });
    assert.equal(updated.id, second.id, '同一任务重复保存必须更新同一行');
    const allForProject = fixture.batches.getDraft(actor, 'project_content_editor');
    assert.ok(['任务 A', '任务 B（改）'].includes(allForProject.title));
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('F5-03 草稿保存选定的文案版本，刷新后仍然保留（返回 P06 时保留选择）', async () => {
  const fixture = await openFixture();
  try {
    fixture.batches.saveDraft(actor, {
      projectId: 'project_content_editor',
      taskId: 'task_copy',
      mode: 'A',
      title: '口播草稿',
      selectedScriptVersionId: 'script_version_abc',
    });
    const dataDir = fixture.dataDir;
    fixture.workbench.close();
    const reopened = await WorkbenchStore.open(dataDir);
    const batches = new ContentBatchStore(reopened);
    batches.ensureSchema();
    const draft = batches.getDraft(actor, 'project_content_editor', 'task_copy');
    assert.equal(draft.selectedScriptVersionId, 'script_version_abc', '刷新（重开存储）后选定的文案版本必须仍然保留');
    reopened.close();
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('草稿不接受非法模式，也不允许脱离内容任务存在', async () => {
  const fixture = await openFixture();
  try {
    assert.throws(
      () => fixture.batches.saveDraft(actor, { projectId: 'project_content_editor', taskId: 'task_x', mode: 'C' }),
      /草稿模式只能是 A 或 B/,
    );
    assert.throws(
      () => fixture.batches.saveDraft(actor, { projectId: 'project_content_editor', mode: 'A' }),
      /草稿必须关联一个内容任务/,
    );
    assert.equal(fixture.batches.getDraft(actor, 'project_content_editor'), null);
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
