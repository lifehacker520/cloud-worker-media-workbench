import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { WorkbenchStore } from '../src/workbench-store.mjs';

test('workbench backup creates a consistent SQLite snapshot and verifies copied media', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-backup-test-'));
  const actor = {
    username: 'admin',
    displayName: '测试管理员',
    role: 'admin',
    tenantId: 'tenant_backup_test',
  };
  const store = await WorkbenchStore.open(dataDir);
  try {
    const project = store.ensureProject(actor, {
      id: 'project_backup_test',
      slug: 'backup-test',
      name: '备份测试项目',
    });
    const mediaPath = join(dataDir, 'sample.txt');
    await writeFile(mediaPath, '仅用于备份校验的媒体内容\n', 'utf8');
    await writeFile(join(dataDir, 'accounts.json'), JSON.stringify([{ id: 'account_backup_test' }]), 'utf8');
    store.saveMediaAsset({
      id: 'asset_backup_test',
      tenantId: actor.tenantId,
      projectId: project.id,
      path: mediaPath,
      filename: 'sample.txt',
      kind: 'text',
      mimeType: 'text/plain',
      status: 'parsed',
    }, actor);

    const backup = await store.createBackup({
      backupId: 'backup-test',
      now: '2026-08-30T12:00:00.000Z',
      includeMedia: true,
    });
    assert.equal(backup.backupId, 'backup-test');
    assert.equal(backup.includes.mediaFiles, true);
    assert.equal(backup.mediaAssets[0].copied, true);
    const manifest = JSON.parse(await readFile(backup.manifestPath, 'utf8'));
    assert.equal(manifest.backupVersion, 'workbench-backup-v0.1');
    assert.deepEqual(manifest.includes.compatibilityFiles, ['accounts.json']);

    const verification = await store.verifyBackup('backup-test');
    assert.equal(verification.status, 'PASS');
    assert.ok(verification.checks.some((item) => item.id === 'database.integrity' && item.status === 'PASS'));
    assert.ok(verification.checks.some((item) => item.id === 'media.asset_backup_test' && item.status === 'PASS'));

    const backups = await store.listBackups();
    assert.equal(backups.length, 1);
    assert.equal(backups[0].backupId, 'backup-test');
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('workbench backup restores into a new empty directory and rewrites media references', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-backup-restore-source-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'cloud-worker-backup-restore-target-'));
  const actor = {
    username: 'admin',
    displayName: '测试管理员',
    role: 'admin',
    tenantId: 'tenant_backup_restore_test',
  };
  const store = await WorkbenchStore.open(dataDir);
  try {
    const project = store.ensureProject(actor, {
      id: 'project_backup_restore_test',
      slug: 'backup-restore-test',
      name: '备份恢复测试项目',
    });
    const mediaPath = join(dataDir, 'source', 'sample.txt');
    await mkdir(join(dataDir, 'source'), { recursive: true });
    await writeFile(mediaPath, '用于恢复路径重写的媒体内容\n', 'utf8');
    const task = store.saveContentTask({
      id: 'task_backup_restore_test',
      tenantId: actor.tenantId,
      projectId: project.id,
      title: '恢复测试任务',
      status: 'draft',
      sourcePath: mediaPath,
      createdAt: '2026-08-31T01:00:00.000Z',
      updatedAt: '2026-08-31T01:00:00.000Z',
    }, actor);
    store.recordContentEvent(task, actor, 'restore_test', { sourcePath: mediaPath });
    store.saveMediaAsset({
      id: 'asset_backup_restore_test',
      tenantId: actor.tenantId,
      projectId: project.id,
      taskId: task.id,
      path: mediaPath,
      filename: 'sample.txt',
      kind: 'text',
      mimeType: 'text/plain',
      status: 'parsed',
      metadata: { sourcePath: mediaPath },
    }, actor);
    store.saveKnowledgeDocument({
      id: 'knowledge_backup_restore_test',
      tenantId: actor.tenantId,
      projectId: project.id,
      taskId: task.id,
      title: '恢复测试知识',
      content: '原始素材路径：' + mediaPath,
      sourcePath: mediaPath,
      metadata: { sourcePath: mediaPath },
    }, actor);
    await writeFile(join(dataDir, 'content-tasks.json'), JSON.stringify([{ sourcePath: mediaPath }]), 'utf8');

    const backup = await store.createBackup({
      backupId: 'backup-restore-test',
      now: '2026-08-31T02:00:00.000Z',
      includeMedia: true,
    });
    assert.equal((await store.verifyBackup('backup-restore-test')).status, 'PASS');

    const restored = await store.restoreBackup('backup-restore-test', targetDir);
    assert.equal(restored.status, 'PASS');
    assert.deepEqual(restored.missingMedia, []);
    assert.equal(restored.copiedMedia.length, 1);
    assert.notEqual(restored.copiedMedia[0].path, mediaPath);
    assert.equal(await readFile(restored.copiedMedia[0].path, 'utf8'), '用于恢复路径重写的媒体内容\n');

    const restoredDb = new DatabaseSync(join(targetDir, 'workbench.sqlite'), { readOnly: true });
    try {
      const integrity = restoredDb.prepare('PRAGMA integrity_check').get();
      assert.equal(integrity?.integrity_check || integrity?.['integrity_check(1)'], 'ok');
      const media = restoredDb.prepare('SELECT path, metadata_json FROM media_assets WHERE id = ?').get('asset_backup_restore_test');
      assert.equal(media.path, restored.copiedMedia[0].path);
      assert.equal(JSON.parse(media.metadata_json).sourcePath, restored.copiedMedia[0].path);
      const knowledge = restoredDb.prepare('SELECT source_path, content, metadata_json FROM knowledge_documents WHERE id = ?').get('knowledge_backup_restore_test');
      assert.equal(knowledge.source_path, restored.copiedMedia[0].path);
      assert.ok(knowledge.content.includes(restored.copiedMedia[0].path));
      assert.equal(JSON.parse(knowledge.metadata_json).sourcePath, restored.copiedMedia[0].path);
      const indexedKnowledge = restoredDb.prepare('SELECT content FROM knowledge_documents_fts WHERE id = ?').get('knowledge_backup_restore_test');
      assert.ok(indexedKnowledge.content.includes(restored.copiedMedia[0].path));
      const event = restoredDb.prepare('SELECT data_json FROM content_task_events WHERE id LIKE ?').get('event_%');
      assert.equal(JSON.parse(event.data_json).sourcePath, restored.copiedMedia[0].path);
    } finally {
      restoredDb.close();
    }

    const restoredCompatibility = JSON.parse(await readFile(join(targetDir, 'content-tasks.json'), 'utf8'));
    assert.equal(restoredCompatibility[0].sourcePath, restored.copiedMedia[0].path);
    assert.ok(await readFile(join(targetDir, 'restore-manifest.json'), 'utf8'));
    assert.equal(store.listMediaAssets(actor)[0].path, mediaPath);
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test('workbench backup restore refuses a non-empty target directory', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-backup-empty-source-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'cloud-worker-backup-non-empty-target-'));
  const store = await WorkbenchStore.open(dataDir);
  try {
    store.ensureProject({ username: 'admin', displayName: '管理员', role: 'admin', tenantId: 'tenant_empty_test' }, {
      id: 'project_empty_test',
      slug: 'empty-test',
      name: '空目录测试项目',
    });
    await writeFile(join(dataDir, 'accounts.json'), '[]', 'utf8');
    await store.createBackup({ backupId: 'backup-empty-target-test', includeMedia: false });
    await writeFile(join(targetDir, 'do-not-overwrite.txt'), 'existing', 'utf8');
    await assert.rejects(
      () => store.restoreBackup('backup-empty-target-test', targetDir),
      /恢复目标目录必须为空/,
    );
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test('encrypted backups replicate to an independent directory, prune old copies and restore', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-backup-encrypted-source-'));
  const offsiteDir = await mkdtemp(join(tmpdir(), 'cloud-worker-backup-encrypted-offsite-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'cloud-worker-backup-encrypted-target-'));
  const actor = { username: 'admin', displayName: '测试管理员', role: 'admin', tenantId: 'tenant_encrypted_test' };
  const encryptionKey = 'test-encryption-key-that-is-long-enough';
  const store = await WorkbenchStore.open(dataDir);
  try {
    const project = store.ensureProject(actor, { id: 'project_encrypted_test', slug: 'encrypted-test', name: '加密备份测试项目' });
    const customer = store.createCustomer(actor, { id: 'customer_encrypted_test', name: '加密备份客户' });
    store.createBrandProfile(actor, { id: 'brand_encrypted_test', projectId: project.id, customerId: customer.id, name: '加密备份品牌资料' });
    await writeFile(join(dataDir, 'accounts.json'), JSON.stringify([{ id: 'account_encrypted_test' }]), 'utf8');

    await store.createBackup({
      backupId: 'backup-encrypted-old',
      now: '2026-08-29T12:00:00.000Z',
      includeMedia: false,
      encryptionKey,
      offsiteDir,
      retention: { keep: 2 },
    });
    await store.createBackup({
      backupId: 'backup-encrypted-middle',
      now: '2026-08-30T12:00:00.000Z',
      includeMedia: false,
      encryptionKey,
      offsiteDir,
      retention: { keep: 2 },
    });
    const latest = await store.createBackup({
      backupId: 'backup-encrypted-latest',
      now: '2026-08-31T12:00:00.000Z',
      includeMedia: false,
      encryptionKey,
      offsiteDir,
      retention: { keep: 2 },
    });

    const manifest = JSON.parse(await readFile(latest.manifestPath, 'utf8'));
    assert.equal(manifest.encryption.algorithm, 'aes-256-gcm');
    assert.equal(manifest.database.path, 'workbench.sqlite.enc');
    assert.equal(manifest.includes.encrypted, true);
    assert.equal(JSON.stringify(manifest).includes(encryptionKey), false);
    await assert.rejects(() => readFile(join(latest.directory, 'workbench.sqlite')));
    await readFile(join(latest.directory, 'workbench.sqlite.enc'));
    await assert.rejects(() => readFile(join(latest.directory, 'accounts.json')));
    await readFile(join(latest.directory, 'accounts.json.enc'));
    await readFile(join(offsiteDir, 'backup-encrypted-latest', 'manifest.json'));
    assert.ok(latest.retention.deleted.includes('backup-encrypted-old'));
    await assert.rejects(() => readFile(join(dataDir, 'backups', 'backup-encrypted-old', 'manifest.json')));
    await assert.rejects(() => readFile(join(offsiteDir, 'backup-encrypted-old', 'manifest.json')));

    const verification = await store.verifyBackup('backup-encrypted-latest', { encryptionKey });
    assert.equal(verification.status, 'PASS');
    assert.equal(verification.counts.customers, 1);
    assert.equal(verification.counts.brand_profiles, 1);
    assert.ok(verification.checks.some((item) => item.id === 'database.decrypted' && item.status === 'PASS'));
    const restored = await store.restoreBackup('backup-encrypted-latest', targetDir, { encryptionKey });
    assert.equal(restored.status, 'PASS');
    await readFile(join(targetDir, 'workbench.sqlite'));
    await readFile(join(targetDir, 'restore-manifest.json'));
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(offsiteDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test('production backup controls pass an encrypted restore drill in a new empty directory', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-backup-production-source-'));
  const offsiteDir = await mkdtemp(join(tmpdir(), 'cloud-worker-backup-production-offsite-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'cloud-worker-backup-production-target-'));
  const drillSource = `
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { WorkbenchStore } from './src/workbench-store.mjs';
    const dataDir = process.env.XHS_DATA_DIR;
    const actor = { username: 'admin', displayName: '生产恢复演练管理员', role: 'admin', tenantId: 'tenant_production_restore' };
    const store = await WorkbenchStore.open(dataDir);
    try {
      const project = store.ensureProject(actor, { id: 'project_production_restore', slug: 'production-restore', name: '生产恢复演练项目' });
      const mediaPath = join(dataDir, 'production-drill.txt');
      await writeFile(mediaPath, 'production restore drill media\\n', 'utf8');
      store.saveMediaAsset({ id: 'asset_production_restore', tenantId: actor.tenantId, projectId: project.id, path: mediaPath, filename: 'production-drill.txt', kind: 'text', mimeType: 'text/plain', status: 'parsed' }, actor);
      const backup = await store.createBackup({ backupId: 'backup-production-restore-drill', includeMedia: true });
      const verification = await store.verifyBackup(backup.backupId);
      const restored = await store.restoreBackup(backup.backupId, process.env.XHS_TARGET_DIR);
      console.log(JSON.stringify({ backup: { backupId: backup.backupId, includes: backup.includes, offsite: backup.offsite }, verification: { status: verification.status, checks: verification.checks }, restored }));
    } finally {
      store.close();
    }
  `;
  try {
    const result = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', drillSource], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          ...process.env,
          NODE_ENV: 'production',
          XHS_DATA_DIR: dataDir,
          XHS_TARGET_DIR: targetDir,
          XHS_BACKUP_ENCRYPTION_KEY: 'production-restore-drill-encryption-key',
          XHS_BACKUP_OFFSITE_DIR: offsiteDir,
          XHS_BACKUP_RETENTION_COUNT: '3',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.backup.includes.encrypted, true);
    assert.equal(payload.backup.offsite.status, 'PASS');
    assert.equal(payload.verification.status, 'PASS');
    assert.ok(payload.verification.checks.some((item) => item.id === 'database.decrypted' && item.status === 'PASS'));
    assert.equal(payload.restored.status, 'PASS');
    assert.equal(payload.restored.copiedMedia.length, 1);
    await readFile(join(targetDir, 'workbench.sqlite'));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(offsiteDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test('production backup creation fails closed when a mandatory control is missing', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-backup-production-gate-'));
  const offsiteDir = await mkdtemp(join(tmpdir(), 'cloud-worker-backup-production-gate-offsite-'));
  const source = `
    import { WorkbenchStore } from './src/workbench-store.mjs';
    const store = await WorkbenchStore.open(process.env.XHS_DATA_DIR);
    try {
      await store.createBackup({ backupId: 'backup-production-gate-test' });
      console.error('unexpected production backup success');
      process.exitCode = 2;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    } finally {
      store.close();
    }
  `;
  const cases = [
    { expected: 'XHS_BACKUP_ENCRYPTION_KEY', env: { XHS_BACKUP_ENCRYPTION_KEY: '', XHS_BACKUP_OFFSITE_DIR: '', XHS_BACKUP_RETENTION_COUNT: '0', XHS_BACKUP_RETENTION_DAYS: '0' } },
    { expected: 'XHS_BACKUP_OFFSITE_DIR', env: { XHS_BACKUP_ENCRYPTION_KEY: 'production-gate-encryption-key', XHS_BACKUP_OFFSITE_DIR: '', XHS_BACKUP_RETENTION_COUNT: '3', XHS_BACKUP_RETENTION_DAYS: '0' } },
    { expected: 'XHS_BACKUP_RETENTION', env: { XHS_BACKUP_ENCRYPTION_KEY: 'production-gate-encryption-key', XHS_BACKUP_OFFSITE_DIR: offsiteDir, XHS_BACKUP_RETENTION_COUNT: '0', XHS_BACKUP_RETENTION_DAYS: '0' } },
  ];
  try {
    for (const gate of cases) {
      const result = await new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          env: { ...process.env, NODE_ENV: 'production', XHS_DATA_DIR: dataDir, ...gate.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', (code, signal) => resolvePromise({ code, signal, stderr }));
      });
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, new RegExp(gate.expected));
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(offsiteDir, { recursive: true, force: true });
  }
});
