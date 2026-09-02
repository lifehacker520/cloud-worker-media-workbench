import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const APP_SOURCE = await readFile(
  resolve(dirname(fileURLToPath(import.meta.url)), '../public/app.js'),
  'utf8',
);

test('work cards render a full calendar timestamp', () => {
  assert.match(APP_SOURCE, /function formatWorkTime\(/);
  assert.match(APP_SOURCE, /year:\s*['"]numeric['"]/);
  assert.match(APP_SOURCE, /formatWorkTime\(work\.publishedAt/);
});

test('monitor center exposes a period-aware operations dashboard', async () => {
  const indexSource = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), '../public/index.html'),
    'utf8',
  );
  const stylesSource = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), '../public/styles.css'),
    'utf8',
  );
  assert.match(indexSource, /id="monitor-insights"/);
  assert.match(indexSource, /id="monitor-period"/);
  assert.match(indexSource, /id="monitor-insights-kpis"/);
  assert.match(indexSource, /id="monitor-operations-grid"/);
  assert.match(indexSource, /id="monitor-comments"/);
  assert.match(APP_SOURCE, /\/api\/monitoring\/insights\?/);
  assert.match(APP_SOURCE, /monitorPeriod/);
  assert.match(APP_SOURCE, /MONITOR_PLATFORM_METRICS/);
  assert.match(APP_SOURCE, /本周发布/);
  assert.match(APP_SOURCE, /本周期暂无最新评论/);
  assert.match(stylesSource, /\.monitor-kpi-grid\s*\{/);
  assert.match(stylesSource, /\.monitor-platform-card\s*\{/);
  assert.match(stylesSource, /@media \(max-width: 680px\)/);
});
