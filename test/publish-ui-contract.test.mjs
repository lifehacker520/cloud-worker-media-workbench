import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH_SOURCE = await readFile(resolve(ROOT, 'public/publish-workspace.js'), 'utf8');
const CONTENT_SOURCE = await readFile(resolve(ROOT, 'public/content-workspace.js'), 'utf8');

test('publish UI keeps approval and external execution as separate actions', () => {
  assert.match(PUBLISH_SOURCE, /data-approve-draft/);
  assert.match(PUBLISH_SOURCE, /data-execute-draft/);
  assert.match(PUBLISH_SOURCE, /PUBLISH_EXECUTOR_NOT_IMPLEMENTED|真实发布/);
  assert.match(CONTENT_SOURCE, /data-create-release-draft/);
});
