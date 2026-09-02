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
