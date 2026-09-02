import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { test } from 'node:test';

import { WorkbenchStore } from '../src/workbench-store.mjs';

test('monitoring metric snapshots and comments persist with tenant isolation', async () => {
  const dataDir = await mkdtemp('/tmp/cloud-worker-monitoring-evidence-');
  const store = await WorkbenchStore.open(dataDir);
  const alpha = { username: 'alpha', displayName: '客户 A', role: 'client', tenantId: 'tenant_alpha' };
  const beta = { username: 'beta', displayName: '客户 B', role: 'client', tenantId: 'tenant_beta' };
  try {
    store.saveMonitoringMetricSnapshots([
      {
        id: 'metric_alpha',
        tenantId: alpha.tenantId,
        platform: 'douyin',
        accountId: 'account_alpha',
        workId: 'work_alpha',
        metricKey: 'play_count',
        value: 128,
        observedAt: '2026-09-02T00:00:00.000Z',
        source: 'fixture',
      },
      {
        id: 'metric_beta',
        tenantId: beta.tenantId,
        platform: 'xhs',
        accountId: 'account_beta',
        workId: 'work_beta',
        metricKey: 'read_count',
        value: 256,
        observedAt: '2026-09-02T00:00:00.000Z',
        source: 'fixture',
      },
    ]);
    store.saveMonitoringComments([
      {
        id: 'comment_alpha',
        tenantId: alpha.tenantId,
        platform: 'douyin',
        accountId: 'account_alpha',
        workId: 'work_alpha',
        text: '请问怎么使用？',
        authorName: '访客 A',
        fetchedAt: '2026-09-02T00:00:00.000Z',
        source: 'fixture',
      },
    ]);

    assert.deepEqual(store.listMonitoringMetricSnapshots(alpha).map((item) => item.id), ['metric_alpha']);
    assert.deepEqual(store.listMonitoringMetricSnapshots(beta).map((item) => item.id), ['metric_beta']);
    assert.deepEqual(store.listMonitoringComments(alpha).map((item) => item.id), ['comment_alpha']);
    assert.equal(store.listMonitoringComments(beta).length, 0);
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
