import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { buildBatchPlan, createContentBatch } from '../src/digital-human-domain.mjs';
import { ContentBatchStore } from '../src/content-batch-store.mjs';
import { WorkbenchStore } from '../src/workbench-store.mjs';

const actor = { username: 'owner', displayName: '内容负责人', role: 'admin', tenantId: 'tenant_local' };

async function openFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-content-batch-store-'));
  const workbench = await WorkbenchStore.open(dataDir);
  const project = workbench.ensureProject(actor, {
    id: 'project_content_editor',
    slug: 'content-editor',
    name: '内容编辑云员工',
  });
  const batches = new ContentBatchStore(workbench);
  batches.ensureSchema();
  return { dataDir, workbench, batches, project };
}

async function closeFixture(fixture) {
  fixture.workbench.close();
  await rm(fixture.dataDir, { recursive: true, force: true });
}

async function seedCatalog(batches, projectId) {
  const avatar = batches.createAvatarProfile(actor, {
    projectId,
    id: 'avatar_profile_fixture',
    versionId: 'avatar_v1',
    name: '测试数字人',
    canonicalImageRef: 'fixture://avatar.png',
    baseVideoRef: 'fixture://avatar.mp4',
    authorizationStatus: 'approved',
    authorizationRef: 'consent://avatar-fixture',
    batchAllowed: true,
    approved: true,
  });
  const voice = batches.createVoiceProfile(actor, {
    projectId,
    id: 'voice_profile_fixture',
    versionId: 'voice_v1',
    name: '测试声音',
    referenceAudioRef: 'fixture://voice.wav',
    authorizationStatus: 'approved',
    authorizationRef: 'consent://voice-fixture',
    batchAllowed: true,
    approved: true,
  });
  const scripts = batches.createScriptSet(actor, {
    projectId,
    taskId: 'task_fixture',
    id: 'script_set_fixture',
    name: '测试脚本',
    approved: true,
    versions: [
      { id: 'script_v1', title: '第一条', text: '第一条测试口播。' },
      { id: 'script_v2', title: '第二条', text: '第二条测试口播。' },
    ],
  });
  const template = batches.ensureDefaultTemplate(actor, projectId);
  const connector = batches.ensureSimulationConnector(actor, projectId);
  return {
    avatar,
    voice,
    scripts,
    template,
    connector,
  };
}

test('voice profiles preserve the reference transcript needed by clone workers', async () => {
  const fixture = await openFixture();
  try {
    const voice = fixture.batches.createVoiceProfile(actor, {
      projectId: fixture.project.id,
      id: 'voice_profile_transcript',
      versionId: 'voice_transcript_v1',
      name: '带参考转写的声音',
      referenceAudioRef: 'file:///controlled/reference.wav',
      referenceTranscript: '这是参考音频对应的准确文字。',
      authorizationStatus: 'approved',
      authorizationRef: 'consent://voice-transcript',
      batchAllowed: true,
      approved: true,
    });
    assert.equal(voice.version.referenceTranscript, '这是参考音频对应的准确文字。');
  } finally {
    await closeFixture(fixture);
  }
});

test('template versions preserve brand layers and caption layout metadata', async () => {
  const fixture = await openFixture();
  try {
    const template = fixture.batches.createTemplate(actor, {
      projectId: fixture.project.id,
      id: 'template_profile_brand',
      versionId: 'template_brand_v1',
      name: '品牌竖屏模板',
      width: 1080,
      height: 1920,
      fps: 30,
      backgroundRef: 'file:///controlled/background.png',
      logoRef: 'file:///controlled/logo.png',
      introRef: 'file:///controlled/intro.mp4',
      outroRef: 'file:///controlled/outro.mp4',
      musicRef: 'file:///controlled/music.wav',
      captionFontName: 'PingFang SC',
      captionFontSize: 54,
      safeArea: { top: 120, bottom: 240, left: 72, right: 72 },
      approved: true,
      batchAllowed: true,
    });
    assert.equal(template.version.id, 'template_brand_v1');
    assert.equal(template.version.status, 'approved');
    assert.equal(template.version.batchAllowed, true);
    assert.equal(template.version.logoRef, 'file:///controlled/logo.png');
    assert.equal(template.version.safeArea.bottom, 240);
    assert.equal(fixture.batches.listTemplateVersions(actor, fixture.project.id).some((item) => item.id === 'template_brand_v1'), true);
  } finally {
    await closeFixture(fixture);
  }
});

test('catalog records create an authorized batch plan and survive restart', async () => {
  const fixture = await openFixture();
  try {
    const catalog = await seedCatalog(fixture.batches, fixture.project.id);
    const plan = buildBatchPlan({
      avatarVersionIds: ['avatar_v1'],
      voiceVersionId: 'voice_v1',
      scriptVersionIds: ['script_v1', 'script_v2'],
      templateVersionId: catalog.template.version.id,
      connectorId: catalog.connector.id,
      avatars: [catalog.avatar.version],
      voices: [catalog.voice.version],
      scripts: catalog.scripts.versions,
      templates: [catalog.template.version],
      connectors: [catalog.connector],
    });
    assert.equal(plan.count, 2);
    const batch = createContentBatch({
      id: 'batch_store_fixture',
      taskId: 'task_fixture',
      tenantId: actor.tenantId,
      projectId: fixture.project.id,
      plan,
      title: '持久化验收批次',
    }, actor);
    fixture.batches.saveBatch(actor, batch);
    const persisted = fixture.batches.getBatch(actor, batch.id);
    assert.deepEqual({ ...persisted, items: persisted.items.map(({ leaseOwner, ...item }) => item) }, batch);
    assert.equal(fixture.batches.listBatches(actor, fixture.project.id).length, 1);

    fixture.workbench.close();
    fixture.workbench = await WorkbenchStore.open(fixture.dataDir);
    fixture.batches = new ContentBatchStore(fixture.workbench);
    fixture.batches.ensureSchema();
    const restored = fixture.batches.getBatch(actor, batch.id);
    assert.deepEqual({ ...restored, items: restored.items.map(({ leaseOwner, ...item }) => item) }, batch);
    assert.equal(restored.items[1].idempotencyKey, batch.items[1].idempotencyKey);
  } finally {
    try { fixture.workbench.close(); } catch {}
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test('batch records stay inside the project tenant boundary', async () => {
  const fixture = await openFixture();
  try {
    const catalog = await seedCatalog(fixture.batches, fixture.project.id);
    const plan = buildBatchPlan({
      avatarVersionIds: ['avatar_v1'],
      scriptVersionIds: ['script_v1'],
      templateVersionId: catalog.template.version.id,
      connectorId: catalog.connector.id,
      avatars: [catalog.avatar.version],
      scripts: [catalog.scripts.versions[0]],
      templates: [catalog.template.version],
      connectors: [catalog.connector],
    });
    const batch = createContentBatch({
      id: 'batch_isolation_fixture',
      taskId: 'task_fixture',
      tenantId: actor.tenantId,
      projectId: fixture.project.id,
      plan,
    }, actor);
    fixture.batches.saveBatch(actor, batch);
    assert.throws(
      () => fixture.batches.getBatch({ username: 'other', displayName: '其他成员', role: 'client', tenantId: 'tenant_other' }, batch.id),
      /客户工作区|权限/,
    );
  } finally {
    await closeFixture(fixture);
  }
});
