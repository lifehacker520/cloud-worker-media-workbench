import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const browserSource = await readFile(resolve(TEST_DIR, '../electron/platform-browser.mjs'), 'utf8');
const mainSource = await readFile(resolve(TEST_DIR, '../electron/main.mjs'), 'utf8');
const appSource = await readFile(resolve(TEST_DIR, '../public/app.js'), 'utf8');
const indexSource = await readFile(resolve(TEST_DIR, '../public/index.html'), 'utf8');

test('desktop platform sessions keep stable persistent partitions and an explicit reset path', () => {
  assert.match(browserSource, /partition: 'persist:cloud-worker-xhs-monitor'/);
  assert.match(browserSource, /partition: 'persist:cloud-worker-douyin-monitor'/);
  assert.match(browserSource, /partition: 'persist:cloud-worker-channels-monitor'/);
  assert.match(browserSource, /getStatus\(\)/);
  assert.match(browserSource, /session\.fromPartition\(config\.partition\)/);
  assert.match(browserSource, /clearStorageData\(\{ storages: SESSION_STORAGE_TYPES \}\)/);
  assert.match(browserSource, /flushStorageData\(\)/);
  assert.doesNotMatch(browserSource, /cookies\.getAll\(/);
  assert.doesNotMatch(browserSource, /JSON\.stringify\([^)]*cookie/i);
  assert.match(mainSource, /platformBrowserSession\?\.flushStorageData\(\)/);
});

test('settings exposes safe platform session management without exposing cookie values', () => {
  assert.match(indexSource, /id="platform-session-list"/);
  assert.match(indexSource, /id="refresh-platform-sessions"/);
  assert.match(appSource, /\/api\/platform-sessions/);
  assert.match(appSource, /data-platform-session-open/);
  assert.match(appSource, /data-platform-session-clear/);
  assert.match(indexSource, /登录是否仍有效，以平台页面实际提示为准/);
  assert.doesNotMatch(appSource, /document\.cookie/);
});
