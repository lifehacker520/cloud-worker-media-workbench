/* F5-C2：内容编辑云员工已改为父级入口页，旧首页的批量长表单
   （批量登记 / 批量计划 / 批量审核 / 批量重试 / 批量导出 / 单条媒体选择 / 模板登记 /
     声音 A/B 试听）已整体下线。

   这些能力按 F5-C0 报告的 D 类结论必须保留在后端。为使保障不随 UI 下线而消失，
   断言目标从「内容编辑页暴露 X」下移到 server.mjs 与 src/，
   用于防止后续清理旧 UI 时误删后端实现。

   注：旧页的计划预算字段（budgetConfirmed / budgetEstimateAmount）在后端不存在同名实现，
   属于旧页专有前端字段，未纳入本文件断言。 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = await readFile(resolve(ROOT, 'server.mjs'), 'utf8');
const STORE = await readFile(resolve(ROOT, 'src/content-batch-store.mjs'), 'utf8');
const AUDIT = await readFile(resolve(ROOT, 'src/content-batch-audit.mjs'), 'utf8');
const MEDIA = await readFile(resolve(ROOT, 'src/media-pipeline.mjs'), 'utf8');
const CONTENT_UI = await readFile(resolve(ROOT, 'public/content-workspace.js'), 'utf8');

test('backend keeps the governed batch media workspace', () => {
  assert.match(SERVER, /\/api\/content\/batches\/catalog/);
  assert.match(SERVER, /\/api\/content\/batches\/plan/);
  assert.match(SERVER, /\/api\/content\/media-worker\/health/);
  assert.match(STORE, /http-worker/);
  assert.match(SERVER, /renderedVideoRef/);
  assert.match(SERVER, /postprocess/);
  assert.match(SERVER, /\/audit/);
  assert.match(AUDIT, /minimumIntegrityPass/);
  assert.match(SERVER, /kind=/);
});

test('backend keeps explicit single-media asset selection', () => {
  assert.match(SERVER, /avatarVersionId/);
  assert.match(SERVER, /voiceVersionId/);
  assert.match(SERVER, /templateVersionId/);
  assert.match(STORE, /avatarVersionId/);
});

test('backend keeps voice registration clone reference metadata', () => {
  assert.match(SERVER, /referenceTranscript/);
  assert.match(SERVER, /voiceName/);
  assert.match(STORE, /referenceTranscript/);
});

test('backend keeps versioned template brand layer and caption metadata', () => {
  assert.match(SERVER, /backgroundRef/);
  assert.match(SERVER, /logoRef/);
  assert.match(SERVER, /introRef/);
  assert.match(SERVER, /outroRef/);
  assert.match(SERVER, /musicRef/);
  assert.match(SERVER, /captionFontName/);
  assert.match(MEDIA, /logoRef/);
  assert.match(MEDIA, /captionFontName/);
});

test('backend keeps voice A/B audition and selection metadata', () => {
  assert.match(SERVER, /voice-comparison-test-set/);
  assert.match(SERVER, /backupVoiceVersionId/);
  assert.match(SERVER, /selectedVoiceVersionId/);
  assert.match(SERVER, /vramGiB/);
  assert.match(STORE, /selectedVoiceVersionId/);
});

/* F5-C2 新增：旧批量长表单必须已从内容编辑页移除，且后端能力仍在。 */
test('F5-C2：旧批量长表单已从内容编辑页移除，能力保留在后端', () => {
  assert.doesNotMatch(CONTENT_UI, /data-batch-register/);
  assert.doesNotMatch(CONTENT_UI, /data-start-batch/);
  assert.doesNotMatch(CONTENT_UI, /data-review-batch/);
  assert.doesNotMatch(CONTENT_UI, /data-export-batch/);
  assert.doesNotMatch(CONTENT_UI, /content-batch-panel/);
  assert.doesNotMatch(CONTENT_UI, /content-batch-matrix/);
  assert.doesNotMatch(CONTENT_UI, /data-voice-comparison-form/);
  /* 后端仍必须提供这些能力。 */
  assert.match(SERVER, /batches\/plan/);
  assert.match(SERVER, /batches\/catalog/);
});
