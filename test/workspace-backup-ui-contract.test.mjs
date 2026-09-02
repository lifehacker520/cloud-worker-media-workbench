import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SOURCE = await readFile(
  resolve(dirname(fileURLToPath(import.meta.url)), '../public/workspace-admin.js'),
  'utf8',
);

test('workspace admin UI exposes non-destructive backup creation and verification', () => {
  assert.match(SOURCE, /\/api\/workspace\/backups/);
  assert.match(SOURCE, /data-create-workspace-backup/);
  assert.match(SOURCE, /data-verify-workspace-backup/);
  assert.match(SOURCE, /includeMedia/);
});

test('workspace admin UI exposes invitation and directory synchronization controls', () => {
  assert.match(SOURCE, /\/api\/workspace\/invitations/);
  assert.match(SOURCE, /\/api\/workspace\/directory\/sync/);
  assert.match(SOURCE, /data-revoke-workspace-invitation/);
  assert.match(SOURCE, /data-sync-workspace-directory/);
});

test('workspace UI exposes customer and brand profile context controls', () => {
  assert.match(SOURCE, new RegExp('/api/workspace/customers'));
  assert.match(SOURCE, new RegExp('/api/workspace/brand-profiles'));
  assert.match(SOURCE, new RegExp('/api/workspace/projects'));
  assert.match(SOURCE, /workspace-project-form/);
  assert.match(SOURCE, /workspace-customer-form/);
  assert.match(SOURCE, /workspace-brand-profile-form/);
});
