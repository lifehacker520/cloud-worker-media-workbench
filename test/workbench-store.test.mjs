import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { test } from 'node:test';

import { createContentTask, recordContentNode, startContentTask } from '../src/content-workflow.mjs';
import { WorkbenchStore } from '../src/workbench-store.mjs';

test('workbench store keeps tenant and project content isolated', async () => {
  const dataDir = await mkdtemp('/tmp/cloud-worker-store-');
  const store = await WorkbenchStore.open(dataDir);
  const alpha = { username: 'alpha', displayName: '客户 A', role: 'client', tenantId: 'tenant_alpha' };
  const beta = { username: 'beta', displayName: '客户 B', role: 'client', tenantId: 'tenant_beta' };
  try {
    const alphaProject = store.ensureProject(alpha, { slug: 'content-editor', name: 'A 内容项目' });
    const betaProject = store.ensureProject(beta, { slug: 'content-editor', name: 'B 内容项目' });
    store.saveContentTask({ id: 'task_alpha', tenantId: alpha.tenantId, projectId: alphaProject.id, title: 'A 任务', status: 'draft', createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z' }, alpha);
    store.saveContentTask({ id: 'task_beta', tenantId: beta.tenantId, projectId: betaProject.id, title: 'B 任务', status: 'draft', createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z' }, beta);

    assert.deepEqual(store.listContentTasks(alpha).map((task) => task.id), ['task_alpha']);
    assert.deepEqual(store.listContentTasks(beta).map((task) => task.id), ['task_beta']);
    assert.throws(() => store.getContentTask(alpha, 'task_beta'), /客户工作区|内容任务/);

    store.saveKnowledgeDocument({ id: 'knowledge_alpha', projectId: alphaProject.id, title: 'A 资料', content: '销售智能体转化话术' }, alpha);
    assert.equal(store.searchKnowledge(alpha, '转化').length, 1);
    assert.equal(store.searchKnowledge(beta, '转化').length, 0);
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('workbench store migrates monitoring ledgers into SQLite and keeps tenant scope', async () => {
  const dataDir = await mkdtemp('/tmp/cloud-worker-monitoring-store-');
  const store = await WorkbenchStore.open(dataDir);
  const admin = { username: 'admin', displayName: '管理员', role: 'admin', tenantId: 'tenant_alpha' };
  const alpha = { username: 'alpha', displayName: '客户 A', role: 'client', tenantId: 'tenant_alpha' };
  const beta = { username: 'beta', displayName: '客户 B', role: 'client', tenantId: 'tenant_beta' };
  try {
    const counts = store.replaceMonitoringData({
      accounts: [
        { id: 'account_alpha', tenantId: 'tenant_alpha', name: 'A 账号' },
        { id: 'account_beta', tenantId: 'tenant_beta', name: 'B 账号' },
      ],
      works: [
        { id: 'work_alpha', fingerprint: 'alpha-fingerprint', accountId: 'account_alpha', tenantId: 'tenant_alpha', title: 'A 作品' },
        { id: 'work_beta', fingerprint: 'beta-fingerprint', accountId: 'account_beta', tenantId: 'tenant_beta', title: 'B 作品' },
      ],
      activity: [{ id: 'activity_alpha', tenantId: 'tenant_alpha', detail: 'A 活动' }],
      feedback: [{ id: 'feedback_beta', tenantId: 'tenant_beta', message: 'B 反馈' }],
    });
    assert.equal(counts.total, 6);
    assert.equal(store.monitoringCounts().monitoring_accounts, 2);
    assert.deepEqual(store.listMonitoringData(alpha).accounts.map((item) => item.id), ['account_alpha']);
    assert.deepEqual(store.listMonitoringData(alpha).works.map((item) => item.id), ['work_alpha']);
    assert.deepEqual(store.listMonitoringData(beta).feedback.map((item) => item.id), ['feedback_beta']);
    assert.equal(store.listMonitoringData(admin).accounts.length, 2);
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('content run events persist ordered task snapshots for replay', async () => {
  const dataDir = await mkdtemp('/tmp/cloud-worker-run-replay-');
  const store = await WorkbenchStore.open(dataDir);
  const actor = { username: 'replay-user', displayName: '回放用户', role: 'client', tenantId: 'tenant_replay' };
  try {
    const project = store.ensureProject(actor, { slug: 'content-editor', name: '回放项目' });
    const task = createContentTask(
      { title: '可回放运行', sourceBrief: '带来源的回放测试' },
      actor,
      { id: 'task_replay_store', tenantId: actor.tenantId, projectId: project.id, now: '2026-08-31T00:00:00.000Z' },
    );
    const started = startContentTask(task, actor, { runId: 'run_replay_store', now: '2026-08-31T00:01:00.000Z' });
    store.saveContentTask(started, actor);
    store.recordContentEvent(started, actor, 'workflow_started', { runId: started.run.id });
    const recorded = recordContentNode(
      started,
      'CE-02',
      { status: 'succeeded', output: { source: '回放来源' } },
      actor,
      { now: '2026-08-31T00:02:00.000Z' },
    );
    store.saveContentTask(recorded, actor);
    store.recordContentEvent(recorded, actor, 'content_node_recorded', { nodeId: 'CE-02' });

    const events = store.listContentEvents(actor, task.id, started.run.id);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
    assert.deepEqual(events.map((event) => event.runId), ['run_replay_store', 'run_replay_store']);
    assert.equal(events[1].data.taskSnapshot.nodes[1].output.source, '回放来源');
    assert.equal(events[1].data.taskSnapshot.run.id, 'run_replay_store');
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('workbench store models customer and brand profile context and links it to tasks', async () => {
  const dataDir = await mkdtemp('/tmp/cloud-worker-context-store-');
  const store = await WorkbenchStore.open(dataDir);
  const admin = { username: 'context-admin', displayName: '上下文管理员', role: 'admin', tenantId: 'tenant_context' };
  const member = { username: 'context-member', displayName: '上下文成员', role: 'client', tenantId: 'tenant_context' };
  const otherAdmin = { username: 'other-context-admin', displayName: '其他管理员', role: 'admin', tenantId: 'tenant_other_context' };
  try {
    const project = store.createProject(admin, {
      tenantId: admin.tenantId,
      slug: 'brand-content',
      name: '品牌内容项目',
    });
    store.ensureProject(member, { slug: 'brand-content' });
    const customer = store.createCustomer(admin, {
      tenantId: admin.tenantId,
      id: 'customer_context',
      name: '上下文客户',
      industry: '教育服务',
      metadata: { source: 'acceptance-test' },
    });
    const brandProfile = store.createBrandProfile(admin, {
      tenantId: admin.tenantId,
      id: 'brand_context',
      projectId: project.id,
      customerId: customer.id,
      name: '上下文品牌资料',
      voice: '清晰、可信、克制',
      constraints: { forbiddenClaims: ['绝对化承诺'] },
    });

    const task = createContentTask(
      {
        title: '关联品牌上下文的任务',
        customerId: customer.id,
        brandProfileId: brandProfile.id,
      },
      admin,
      { id: 'task_context_store', tenantId: admin.tenantId, projectId: project.id },
    );
    const saved = store.saveContentTask(task, admin);

    assert.equal(saved.customerId, customer.id);
    assert.equal(saved.brandProfileId, brandProfile.id);
    assert.equal(store.getContentTask(member, task.id).brandProfileId, brandProfile.id);
    assert.deepEqual(store.listCustomers(member).map((item) => item.id), [customer.id]);
    assert.deepEqual(store.listBrandProfiles(member, project.id).map((item) => item.id), [brandProfile.id]);

    const otherCustomer = store.createCustomer(otherAdmin, {
      tenantId: otherAdmin.tenantId,
      id: 'customer_other_context',
      name: '其他客户',
    });
    assert.throws(
      () => store.createBrandProfile(otherAdmin, {
        tenantId: otherAdmin.tenantId,
        projectId: project.id,
        customerId: otherCustomer.id,
        name: '跨租户品牌资料',
      }),
      /同一客户工作区|项目不存在|没有访问/,
    );
    const otherMember = { username: 'other-context-member', displayName: '其他成员', role: 'client', tenantId: otherAdmin.tenantId };
    assert.deepEqual(store.listCustomers(otherMember).map((item) => item.id), [otherCustomer.id]);
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
