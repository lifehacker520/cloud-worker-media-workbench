import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SOURCE = await readFile(
  resolve(dirname(fileURLToPath(import.meta.url)), '../public/content-workspace.js'),
  'utf8',
);

test('content workspace exposes pause, resume, retry and replay controls', () => {
  assert.match(SOURCE, /\/pause/);
  assert.match(SOURCE, /\/resume/);
  assert.match(SOURCE, /\/retry/);
  assert.match(SOURCE, /\/replay/);
  assert.match(SOURCE, /data-pause-content/);
  assert.match(SOURCE, /data-resume-content/);
  assert.match(SOURCE, /data-retry-content/);
});

test('content task form exposes reusable customer and brand profile context', () => {
  assert.match(SOURCE, /name="customerId"/);
  assert.match(SOURCE, /name="brandProfileId"/);
  assert.match(SOURCE, /customerId/);
  assert.match(SOURCE, /brandProfileId/);
});

test('content workspace exposes topic selection and local feedback gates', () => {
  assert.match(SOURCE, /topic-selection/);
  assert.match(SOURCE, /content-topic-selection-form/);
  assert.match(SOURCE, /确认最终选题/);
  assert.match(SOURCE, /\/feedback/);
  assert.match(SOURCE, /content-feedback-form/);
  assert.match(SOURCE, /不会调用外部平台/);
});

test('content workspace exposes authenticated local media previews', () => {
  assert.match(SOURCE, /\/assets\//);
  assert.match(SOURCE, /\/file/);
  assert.match(SOURCE, /content-asset-preview/);
});

test('content workspace exposes local subtitle burn-in capability', () => {
  assert.match(SOURCE, /字幕烧录可用/);
  assert.match(SOURCE, /subtitleBurnIn/);
});

test('content workspace exposes transcript confidence review status', () => {
  assert.match(SOURCE, /content-asset-confidence/);
  assert.match(SOURCE, /转写置信度/);
  assert.match(SOURCE, /需人工校对/);
});

test('content workspace exposes media display rotation status', () => {
  assert.match(SOURCE, /content-asset-orientation/);
  assert.match(SOURCE, /显示旋转/);
});

test('content workspace exposes OCR evidence status on asset cards', () => {
  assert.match(SOURCE, /content-asset-ocr/);
  assert.match(SOURCE, /文字框/);
  assert.match(SOURCE, /OCR 未配置/);
});

test('content workspace exposes a content hash for asset traceability', () => {
  assert.match(SOURCE, /contentHash/);
  assert.match(SOURCE, /content-asset-hash/);
  assert.match(SOURCE, /SHA-256/);
});

test('content workspace exposes source authorization fields and review status', () => {
  assert.match(SOURCE, /authorizationStatus/);
  assert.match(SOURCE, /authorizationRef/);
  assert.match(SOURCE, /content-asset-authorization/);
  assert.match(SOURCE, /已确认授权/);
});

test('content workspace exposes the CE-09 extractive summary and evidence gaps', () => {
  assert.match(SOURCE, /analysisMode/);
  assert.match(SOURCE, /evidenceGaps/);
  assert.match(SOURCE, /结构分析摘要/);
  assert.match(SOURCE, /需补证据/);
});
