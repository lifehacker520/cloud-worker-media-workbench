import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SOURCE = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../public/content-workspace.js'), 'utf8');

test('content task page exposes the governed batch media workspace', () => {
  assert.match(SOURCE, /content-batch-panel/);
  assert.match(SOURCE, new RegExp('/api/content/batches/catalog'));
  assert.match(SOURCE, new RegExp('/api/content/batches/plan'));
  assert.match(SOURCE, new RegExp('/api/content/media-worker/health'));
  assert.match(SOURCE, /http-worker/);
  assert.match(SOURCE, /<video/);
  assert.match(SOURCE, /data-start-batch/);
  assert.match(SOURCE, /data-pause-batch/);
  assert.match(SOURCE, /data-cancel-batch/);
  assert.match(SOURCE, /\/cancel/);
  assert.match(SOURCE, /window\.confirm/);
  assert.match(SOURCE, /data-retry-batch/);
  assert.match(SOURCE, /data-review-batch/);
  assert.match(SOURCE, /data-postprocess-batch/);
  assert.match(SOURCE, /renderedVideoRef/);
  assert.match(SOURCE, /postprocess\.error/);
  assert.match(SOURCE, /content-batch-matrix/);
  assert.match(SOURCE, /budgetConfirmed/);
  assert.match(SOURCE, /budgetEstimateAmount/);
  assert.match(SOURCE, /data-batch-audit/);
  assert.match(SOURCE, /\/audit/);
  assert.match(SOURCE, /minimumIntegrityPass/);
  assert.match(SOURCE, /items\/\$\{encodeURIComponent\(item\.id\)\}\/file\?kind=/);
  assert.match(SOURCE, /真实模型未接入/);
});

test('content task page exposes explicit single-media asset selection', () => {
  assert.match(SOURCE, /data-media-node-form/);
  assert.match(SOURCE, /name="avatarVersionId"/);
  assert.match(SOURCE, /name="voiceVersionId"/);
  assert.match(SOURCE, /name="templateVersionId"/);
  assert.match(SOURCE, /mediaNodeForm/);
});

test('voice registration exposes clone reference metadata', () => {
  assert.match(SOURCE, /name="referenceTranscript"/);
  assert.match(SOURCE, /name="voiceName"/);
  assert.match(SOURCE, /body\.referenceTranscript/);
  assert.match(SOURCE, /body\.voiceName/);
});

test('template registration exposes versioned brand layer and caption metadata', () => {
  assert.match(SOURCE, /data-batch-register="template"/);
  assert.match(SOURCE, /name="backgroundRef"/);
  assert.match(SOURCE, /name="logoRef"/);
  assert.match(SOURCE, /name="introRef"/);
  assert.match(SOURCE, /name="outroRef"/);
  assert.match(SOURCE, /name="musicRef"/);
  assert.match(SOURCE, /name="captionFontName"/);
  assert.match(SOURCE, /body\[key\]/);
});

test('single-media workspace exposes voice A/B audition and selection', () => {
  assert.match(SOURCE, /voice-comparisons/);
  assert.match(SOURCE, /voice-comparison-test-set/);
  assert.match(SOURCE, /data-apply-voice-test/);
  assert.match(SOURCE, /content-voice-test-set/);
  assert.match(SOURCE, /data-voice-comparison/);
  assert.match(SOURCE, /data-select-voice-comparison/);
  assert.match(SOURCE, /data-select-voice-role/);
  assert.match(SOURCE, /backupVoiceVersionId/);
  assert.match(SOURCE, /data-voice-review-form/);
  assert.match(SOURCE, /vramGiB/);
  assert.match(SOURCE, /selectedVoiceVersionId/);
  assert.match(SOURCE, /<audio/);
});
