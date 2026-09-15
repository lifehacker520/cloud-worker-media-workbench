/* F5-C2：内容编辑云员工已从 26 节点长页面改为父级入口页（public/content-workspace.js）。

   旧首页 UI 的交互入口（任务详情、素材解析、选题/审核闸门、声音 A/B、节点回放、
   资产卡片证据展示等）已按 F5-C2 下线，因此本文件不再断言「内容编辑工作区暴露 X」。

   这些能力按 F5-C0 报告的 D 类结论必须保留在后端。为使保障不随 UI 下线而消失，
   断言目标整体下移到 server.mjs 与 src/，用于防止后续清理旧 UI 时误删后端实现。

   UI 侧的新契约由 test/digital-human-ui-contract.test.mjs 与本文件最后一个用例承担。 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = await readFile(resolve(ROOT, 'server.mjs'), 'utf8');
const WORKFLOW = await readFile(resolve(ROOT, 'src/content-workflow.mjs'), 'utf8');
const MEDIA = await readFile(resolve(ROOT, 'src/media-pipeline.mjs'), 'utf8');
const CONTENT_UI = await readFile(resolve(ROOT, 'public/content-workspace.js'), 'utf8');

test('backend keeps pause, resume, retry and replay for content tasks', () => {
  assert.match(SERVER, /\/pause/);
  assert.match(SERVER, /\/resume/);
  assert.match(SERVER, /\/retry/);
  assert.match(SERVER, /\/replay/);
});

test('backend keeps reusable customer and brand profile context on tasks', () => {
  assert.match(WORKFLOW, /brandProfileId/);
  assert.match(WORKFLOW, /customerId/);
  assert.match(SERVER, /brandProfileId/);
});

test('backend keeps topic selection and local feedback gates', () => {
  assert.match(SERVER, /topic-selection/);
  assert.match(SERVER, /\/feedback/);
});

test('backend keeps authenticated local media file delivery', () => {
  assert.match(SERVER, /\/assets/);
  assert.match(SERVER, /\/file/);
});

test('backend keeps local subtitle burn-in capability', () => {
  assert.match(MEDIA, /subtitleBurnIn/);
});

test('backend keeps transcript confidence evidence', () => {
  assert.match(MEDIA, /confidence/);
  assert.match(MEDIA, /transcript/);
});

test('backend keeps media display rotation evidence', () => {
  assert.match(MEDIA, /rotation/);
});

test('backend keeps OCR evidence on media analysis', () => {
  assert.match(MEDIA, /ocr/i);
});

test('backend keeps a content hash for asset traceability', () => {
  assert.match(MEDIA, /contentHash/);
  assert.match(MEDIA, /sha256/i);
});

test('backend keeps source authorization gating for imported assets', () => {
  assert.match(SERVER, /authorizationStatus/);
  assert.match(SERVER, /authorization/);
});

test('backend keeps the CE-09 extractive summary and evidence gaps', () => {
  assert.match(MEDIA, /analysisMode/);
  assert.match(MEDIA, /evidenceGaps/);
});

/* F5-C2 新增：内容编辑云员工必须是父级入口页，且不再渲染旧 26 节点长页面。 */
test('F5-C2：内容编辑云员工只保留父级入口，不再渲染 26 节点长页面', () => {
  /* 必须保留：职责说明、唯一入口、带入桥接、真实状态读取。 */
  assert.match(CONTENT_UI, /data-dh-open/);
  assert.match(CONTENT_UI, /content-work-prefill/);
  assert.match(CONTENT_UI, /\/api\/content\/digital-human\/summary/);
  assert.match(CONTENT_UI, /内容编辑云员工/);
  /* 必须不再出现：旧节点追踪、旧状态机操作、旧批量与解析表单。 */
  assert.doesNotMatch(CONTENT_UI, /26 NODE TRACE/);
  assert.doesNotMatch(CONTENT_UI, /data-content-create-focus/);
  assert.doesNotMatch(CONTENT_UI, /data-start-content/);
  assert.doesNotMatch(CONTENT_UI, /data-pause-content/);
  assert.doesNotMatch(CONTENT_UI, /data-create-batch/);
  assert.doesNotMatch(CONTENT_UI, /content-batch-panel/);
  assert.doesNotMatch(CONTENT_UI, /content-topic-selection-form/);
  assert.doesNotMatch(CONTENT_UI, /content-material-form/);
  assert.doesNotMatch(CONTENT_UI, /data-media-node-form/);
  assert.doesNotMatch(CONTENT_UI, /data-voice-comparison-form/);
});
