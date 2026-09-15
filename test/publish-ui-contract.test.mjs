import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH_SOURCE = await readFile(resolve(ROOT, 'public/publish-workspace.js'), 'utf8');
const CONTENT_SOURCE = await readFile(resolve(ROOT, 'public/content-workspace.js'), 'utf8');
const SERVER_SOURCE = await readFile(resolve(ROOT, 'server.mjs'), 'utf8');

test('publish UI keeps approval and external execution as separate actions', () => {
  assert.match(PUBLISH_SOURCE, /data-approve-draft/);
  assert.match(PUBLISH_SOURCE, /data-execute-draft/);
  assert.match(PUBLISH_SOURCE, /PUBLISH_EXECUTOR_NOT_IMPLEMENTED|真实发布/);
  /* F5-C2：发布草稿入口已从内容编辑父级页下线（F5-C0 的 B7 未迁移），
     真实发布执行器仍未接入，能力必须保留在后端。 */
  assert.match(SERVER_SOURCE, /release-drafts/);
  assert.doesNotMatch(CONTENT_SOURCE, /data-create-release-draft/);
});
