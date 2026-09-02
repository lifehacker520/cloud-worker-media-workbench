import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONTENT_NODE_CATALOG,
  addContentReview,
  applyContentRevision,
  buildContentRunReplay,
  contentTaskSummary,
  createContentTask,
  pauseContentTask,
  recordContentNode,
  retryContentNode,
  resumeContentTask,
  startContentTask,
} from '../src/content-workflow.mjs';

const actor = { username: 'tester', displayName: '测试人员' };

function completeWorkflowThrough(task, lastNodeId, now = '2026-08-30T00:02:00.000Z') {
  let current = task;
  for (const node of current.nodes.slice(1)) {
    current = recordContentNode(
      current,
      node.id,
      { status: 'succeeded', output: { fixture: node.id }, note: '测试完成 ' + node.id },
      actor,
      { now },
    );
    if (node.id === lastNodeId) return current;
  }
  throw new Error('找不到测试节点：' + lastNodeId);
}

test('content task creates the complete 26-node workflow contract', () => {
  const task = createContentTask(
    {
      title: '内容编辑测试任务',
      objective: '验证从素材到审核准备的工作流',
      platforms: ['小红书', '抖音'],
      sourceBrief: '已授权的本地测试素材',
    },
    actor,
    { id: 'content_task_fixture', now: '2026-08-30T00:00:00.000Z' },
  );

  assert.equal(task.status, 'draft');
  assert.equal(task.nodes.length, CONTENT_NODE_CATALOG.length);
  assert.equal(task.nodes.length, 26);
  assert.equal(task.nodes[0].status, 'ready');
  assert.equal(task.nodes.at(-1).id, 'CE-26');
  assert.deepEqual(task.owner, { username: actor.username, displayName: actor.displayName });
  assert.deepEqual(contentTaskSummary(task).owner, task.owner);
  assert.equal(contentTaskSummary(task).completedNodes, 0);
});

test('starting and recording a node keeps the run trace and advances the next node', () => {
  const task = createContentTask(
    { title: '节点状态测试' },
    actor,
    { id: 'content_task_state', now: '2026-08-30T00:00:00.000Z' },
  );
  const started = startContentTask(task, actor, {
    runId: 'content_run_fixture',
    now: '2026-08-30T00:01:00.000Z',
  });

  assert.equal(started.status, 'queued');
  assert.equal(started.run.id, 'content_run_fixture');
  assert.equal(started.nodes[0].status, 'succeeded');
  assert.equal(started.nodes[1].status, 'ready');

  const recorded = recordContentNode(
    started,
    'CE-02',
    {
      status: 'succeeded',
      output: { brand: '测试品牌' },
      note: '本地测试结果',
    },
    actor,
    { now: '2026-08-30T00:02:00.000Z' },
  );

  assert.equal(recorded.nodes[1].status, 'succeeded');
  assert.equal(recorded.nodes[2].status, 'ready');
  assert.equal(recorded.nodes[1].evidence.length, 1);
  assert.equal(recorded.nodes[1].output.brand, '测试品牌');
  assert.equal(recorded.status, 'waiting_review');
});

test('node execution trace keeps refs, versions, permissions and human confirmation fields', () => {
  const task = createContentTask(
    { title: '统一运行协议测试' },
    actor,
    { id: 'content_task_trace', now: '2026-08-30T00:00:00.000Z' },
  );
  const started = startContentTask(task, actor, {
    runId: 'content_run_trace',
    now: '2026-08-30T00:01:00.000Z',
  });
  const recorded = recordContentNode(
    started,
    'CE-02',
    {
      status: 'succeeded',
      input: { brandId: 'brand_trace' },
      output: { brand: '追踪品牌' },
      execution: {
        inputRefs: ['brand_trace'],
        outputRefs: ['brand_profile_trace'],
        sensitive: true,
        permissions: ['brand.read'],
        toolVersion: 'knowledge-store@1',
        modelVersion: 'none',
        promptVersion: 'prompt@1',
        connectorVersion: 'local-knowledge@1',
        environmentVersion: 'node22-sqlite',
        confirmation: { required: true, confirmedBy: 'tester', content: '已确认品牌资料范围' },
        humanAction: '确认品牌资料来源',
      },
    },
    actor,
    { now: '2026-08-30T00:02:00.000Z' },
  );

  assert.equal(recorded.run.workflowVersion, recorded.workflowVersion);
  assert.deepEqual(recorded.nodes[1].trace.inputRefs, ['brand_trace']);
  assert.deepEqual(recorded.nodes[1].trace.outputRefs, ['brand_profile_trace']);
  assert.equal(recorded.nodes[1].trace.sensitive, true);
  assert.deepEqual(recorded.nodes[1].trace.permissions, ['brand.read']);
  assert.equal(recorded.nodes[1].trace.toolVersion, 'knowledge-store@1');
  assert.equal(recorded.nodes[1].trace.confirmation.confirmedBy, 'tester');
  assert.equal(recorded.nodes[1].trace.humanAction, '确认品牌资料来源');
  assert.deepEqual(recorded.nodes[1].trace.actions, {
    pause: false,
    retry: false,
    skip: false,
    rollback: false,
    transfer: false,
  });
});

test('failed nodes can be retried and a paused run can resume from its ready node', () => {
  const task = createContentTask(
    { title: '重试与暂停测试' },
    actor,
    { id: 'content_task_retry_pause', now: '2026-08-30T00:00:00.000Z' },
  );
  const started = startContentTask(task, actor, {
    runId: 'content_run_retry_pause',
    now: '2026-08-30T00:01:00.000Z',
  });
  const failed = recordContentNode(
    started,
    'CE-02',
    { status: 'failed', error: '测试连接器暂时失败', note: '记录失败证据' },
    actor,
    { now: '2026-08-30T00:02:00.000Z' },
  );

  assert.equal(failed.status, 'failed');
  assert.equal(failed.run.status, 'failed');
  assert.equal(failed.nodes.find((node) => node.id === 'CE-02').trace.actions.retry, true);
  const retried = retryContentNode(
    failed,
    'CE-02',
    actor,
    { now: '2026-08-30T00:03:00.000Z' },
  );
  assert.equal(retried.status, 'running');
  assert.equal(retried.run.status, 'retrying');
  assert.equal(retried.nodes.find((node) => node.id === 'CE-02').status, 'ready');
  assert.equal(retried.nodes.find((node) => node.id === 'CE-02').attempts, 1);

  const paused = pauseContentTask(retried, actor, { now: '2026-08-30T00:04:00.000Z' });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.run.status, 'paused');
  assert.equal(paused.run.pausedNodeId, 'CE-02');
  const resumed = resumeContentTask(paused, actor, { now: '2026-08-30T00:05:00.000Z' });
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.run.status, 'running');
  assert.equal(resumed.nodes.find((node) => node.id === 'CE-02').status, 'ready');
});

test('run replay exposes ordered snapshots and the final run summary', () => {
  const task = createContentTask(
    { title: '运行回放测试' },
    actor,
    { id: 'content_task_replay', now: '2026-08-30T00:00:00.000Z' },
  );
  const started = startContentTask(task, actor, {
    runId: 'content_run_replay',
    now: '2026-08-30T00:01:00.000Z',
  });
  const recorded = recordContentNode(
    started,
    'CE-02',
    { status: 'succeeded', output: { brand: '回放品牌' } },
    actor,
    { now: '2026-08-30T00:02:00.000Z' },
  );
  const replay = buildContentRunReplay(recorded, [
    { sequence: 2, type: 'content_node_recorded', taskSnapshot: recorded },
    { sequence: 1, type: 'workflow_started', taskSnapshot: started },
  ]);

  assert.equal(replay.runId, 'content_run_replay');
  assert.deepEqual(replay.events.map((event) => event.sequence), [1, 2]);
  assert.equal(replay.events[1].taskSnapshot.nodes[1].output.brand, '回放品牌');
  assert.equal(replay.final.status, 'waiting_review');
  assert.equal(replay.final.completedNodes, 2);
});

test('pending nodes and reviews cannot bypass the workflow start gate', () => {
  const task = createContentTask(
    { title: '闸门测试' },
    actor,
    { id: 'content_task_gate', now: '2026-08-30T00:00:00.000Z' },
  );

  assert.throws(
    () => recordContentNode(task, 'CE-03', { status: 'succeeded', output: { text: '不应通过' } }, actor),
    /节点尚未到达可登记状态/,
  );
  const started = startContentTask(task, actor, { runId: 'content_run_gate' });
  assert.throws(
    () => addContentReview(started, { decision: 'approved', note: '不应通过' }, actor, { reviewId: 'review_gate' }),
    /请先完成 CE-19 审核单/,
  );
  assert.throws(
    () => addContentReview(task, { decision: 'approved', note: '不应通过' }, actor, { reviewId: 'review_not_started' }),
    /请先启动内容工作流/,
  );
});

test('review decisions are versioned as evidence and do not execute publishing', () => {
  const task = createContentTask(
    { title: '审核闸门测试' },
    actor,
    { id: 'content_task_review', now: '2026-08-30T00:00:00.000Z' },
  );
  const started = startContentTask(task, actor, {
    runId: 'content_run_review',
    now: '2026-08-30T00:01:00.000Z',
  });
  const readyForReview = completeWorkflowThrough(started, 'CE-19');
  const reviewed = addContentReview(
    readyForReview,
    { decision: 'approved', note: '测试审核通过' },
    actor,
    { reviewId: 'content_review_fixture', now: '2026-08-30T00:03:00.000Z' },
  );

  assert.equal(reviewed.status, 'approved');
  assert.equal(reviewed.reviews.length, 1);
  assert.equal(reviewed.nodes.find((node) => node.id === 'CE-20').status, 'succeeded');
  assert.equal(reviewed.nodes.find((node) => node.id === 'CE-20').trace.confirmation.decision, 'approved');
  assert.notEqual(reviewed.status, 'published');
  assert.equal(reviewed.nodes.find((node) => node.id === 'CE-21').status, 'skipped');
  assert.equal(reviewed.nodes.find((node) => node.id === 'CE-22').status, 'ready');
});

test('changes requested opens a revision gate and preserves the previous version', () => {
  const task = createContentTask(
    { title: '版本修改测试' },
    actor,
    { id: 'content_task_revision', now: '2026-08-30T00:00:00.000Z' },
  );
  const started = startContentTask(task, actor, {
    runId: 'content_run_revision',
    now: '2026-08-30T00:01:00.000Z',
  });
  const readyForReview = completeWorkflowThrough(started, 'CE-19');
  const changesRequested = addContentReview(
    readyForReview,
    { decision: 'changes_requested', note: '补充事实来源' },
    actor,
    { reviewId: 'content_review_revision', now: '2026-08-30T00:02:00.000Z' },
  );
  assert.equal(changesRequested.nodes.find((node) => node.id === 'CE-21').status, 'ready');
  const revised = applyContentRevision(
    changesRequested,
    { changes: '补充事实来源', content: { text: '修订后的脚本' } },
    actor,
    { versionId: 'content_version_revision', now: '2026-08-30T00:03:00.000Z' },
  );
  assert.equal(revised.status, 'waiting_review');
  assert.equal(revised.nodes.find((node) => node.id === 'CE-21').status, 'succeeded');
  assert.equal(revised.nodes.find((node) => node.id === 'CE-22').status, 'ready');
  assert.equal(revised.versions.length, 1);
  assert.equal(revised.versions[0].id, 'content_version_revision');
  assert.equal(revised.versions[0].content.text, '修订后的脚本');
  const approved = addContentReview(
    revised,
    { decision: 'approved', note: '修订后通过' },
    actor,
    { reviewId: 'content_review_revision_approved', now: '2026-08-30T00:04:00.000Z' },
  );
  assert.equal(approved.status, 'approved');
  assert.equal(approved.nodes.find((node) => node.id === 'CE-22').status, 'ready');
});
