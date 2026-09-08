import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

test('desktop updater bridge, release metadata, and one-click UI stay wired together', async () => {
  const [mainSource, preloadSource, appSource, indexSource, packageSource, afterPackSource] = await Promise.all([
    readFile(resolve(ROOT, 'electron/main.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'electron/preload.cjs'), 'utf8'),
    readFile(resolve(ROOT, 'public/app.js'), 'utf8'),
    readFile(resolve(ROOT, 'public/index.html'), 'utf8'),
    readFile(resolve(ROOT, 'package.json'), 'utf8'),
    readFile(resolve(ROOT, 'electron/after-sign.cjs'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(mainSource, /preload\.cjs/);
  assert.match(mainSource, /scheduleAutomaticUpdateCheck/);
  assert.match(preloadSource, /contextBridge\.exposeInMainWorld\('desktopUpdater'/);
  assert.match(preloadSource, /ipcRenderer\.invoke\('updater:check'\)/);
  assert.match(appSource, /下载并安装/);
  const updaterUiSource = appSource.slice(
    appSource.indexOf('async function downloadAndInstall'),
    appSource.indexOf('function render()'),
  );
  assert.doesNotMatch(updaterUiSource, /window\.confirm/);
  assert.match(indexSource, /自动检查 GitHub Release/);
  assert.equal(packageJson.build.publish[0].provider, 'github');
  assert.equal(packageJson.build.mac.identity, '-');
  assert.equal(packageJson.build.mac.hardenedRuntime, false);
  assert.equal(packageJson.build.afterSign, 'electron/after-sign.cjs');
  assert.match(afterPackSource, /designated => identifier/);
  assert.ok(packageJson.build.mac.target.some((target) => target.target === 'zip'));
});
