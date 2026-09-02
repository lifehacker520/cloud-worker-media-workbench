import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { WorkbenchStore } from '../src/workbench-store.mjs';

const workerSource = `
  import { WorkbenchStore } from './src/workbench-store.mjs';
  const store = await WorkbenchStore.open(process.env.XHS_DATA_DIR);
  const actor = { username: 'admin', displayName: '并发测试管理员', role: 'admin', tenantId: 'tenant_concurrency_test' };
  try {
    for (let index = 0; index < 20; index += 1) {
      const task = store.saveContentTask({
        id: 'task_concurrency_' + process.env.WORKER_ID + '_' + index,
        tenantId: actor.tenantId,
        projectId: 'project_concurrency_test',
        title: '并发写入任务 ' + process.env.WORKER_ID + '-' + index,
        status: 'draft',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, actor);
      store.recordContentEvent(task, actor, 'concurrency_write', { worker: process.env.WORKER_ID, index });
    }
    const sharedTask = {
      id: 'task_concurrency_shared',
      tenantId: actor.tenantId,
      projectId: 'project_concurrency_test',
      title: '共享运行事件任务',
      status: 'running',
      run: { id: 'run_concurrency_shared' },
    };
    for (let index = 0; index < 10; index += 1) {
      store.recordContentEvent(sharedTask, actor, 'shared_concurrency_write', { worker: process.env.WORKER_ID, index });
    }
  } finally {
    store.close();
  }
`;

function runWorker(dataDir, workerId) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', workerSource], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, XHS_DATA_DIR: dataDir, WORKER_ID: String(workerId) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ code, signal, stderr }));
  });
}

test('SQLite workbench tolerates concurrent task and event writers without losing rows', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-concurrency-'));
  const actor = { username: 'admin', displayName: '并发测试管理员', role: 'admin', tenantId: 'tenant_concurrency_test' };
  const store = await WorkbenchStore.open(dataDir);
  try {
    store.ensureProject(actor, { id: 'project_concurrency_test', slug: 'concurrency-test', name: '并发测试项目' });
    store.saveContentTask({
      id: 'task_concurrency_shared',
      tenantId: actor.tenantId,
      projectId: 'project_concurrency_test',
      title: '共享运行事件任务',
      status: 'running',
      run: { id: 'run_concurrency_shared' },
    }, actor);
  } finally {
    store.close();
  }
  try {
    const workers = await Promise.all([1, 2, 3, 4].map((workerId) => runWorker(dataDir, workerId)));
    for (const worker of workers) assert.equal(worker.code, 0, worker.stderr);

    const verifiedStore = await WorkbenchStore.open(dataDir);
    try {
      const tasks = verifiedStore.listContentTasks(actor);
      assert.equal(tasks.length, 81);
      assert.equal(verifiedStore.listContentEvents(actor, 'task_concurrency_3_7').length, 1);
      const sharedEvents = verifiedStore.listContentEvents(actor, 'task_concurrency_shared', 'run_concurrency_shared');
      assert.equal(sharedEvents.length, 40);
      assert.deepEqual(sharedEvents.map((event) => event.sequence), Array.from({ length: 40 }, (_, index) => index + 1));
      const integrity = verifiedStore.db.prepare('PRAGMA integrity_check').get();
      assert.equal(integrity?.integrity_check || integrity?.['integrity_check(1)'], 'ok');
    } finally {
      verifiedStore.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
