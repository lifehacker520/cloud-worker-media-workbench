import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const APP_SOURCE = await readFile(
  resolve(dirname(fileURLToPath(import.meta.url)), '../public/app.js'),
  'utf8',
);
const CONTENT_SOURCE = await readFile(
  resolve(dirname(fileURLToPath(import.meta.url)), '../public/content-workspace.js'),
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

test('M1 exposes one monitor center with monitor and dashboard sections', async () => {
  const indexSource = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), '../public/index.html'),
    'utf8',
  );
  const stylesSource = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), '../public/styles.css'),
    'utf8',
  );
  assert.match(indexSource, /<strong>云员工工作台<\/strong>/);
  assert.match(indexSource, /data-view="monitor"[^>]*>[\s\S]*?监控中心/);
  assert.doesNotMatch(indexSource, /nav-subitem[^>]*data-view="insights"/);
  assert.match(indexSource, /data-monitor-section="monitor"[^>]*>监控中心/);
  assert.match(indexSource, /data-monitor-section="insights"[^>]*>数据看板/);
  assert.match(indexSource, /id="view-insights"[\s\S]*?id="monitor-insights"/);
  assert.match(indexSource, /id="view-monitor"[\s\S]*?id="monitor-layout"/);
  assert.doesNotMatch(indexSource, /id="view-monitor"[\s\S]*?id="monitor-insights"/);
  assert.match(indexSource, /id="monitor-splitter"[^>]*aria-valuemin="280"[^>]*aria-valuemax="960"/);
  assert.match(indexSource, /title="拖动调整监控账号和作品流宽度"/);
  assert.match(APP_SOURCE, /history\.pushState/);
  assert.match(APP_SOURCE, /#monitor\/\' \+ monitorSection/);
  assert.match(APP_SOURCE, /routeStateFromHash/);
  assert.match(APP_SOURCE, /panel\.hidden\s*=/);
  assert.match(APP_SOURCE, /insightsPlatformFilter/);
  assert.match(APP_SOURCE, /function monitorSplitBounds\(/);
  assert.match(APP_SOURCE, /MONITOR_SPLIT_MIN_FEED/);
  assert.match(APP_SOURCE, /event\.key === 'Home' \? bounds\.min : bounds\.max/);
  assert.match(stylesSource, /grid-template-columns: minmax\(280px, var\(--monitor-accounts-width, 420px\)\) 18px/);
  assert.match(stylesSource, /\.monitor-splitter span::before/);
});

test('M2 exposes explicit monitor queue filtering and batch read controls', async () => {
  const indexSource = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), '../public/index.html'),
    'utf8',
  );
  assert.match(indexSource, /id="work-search"/);
  assert.match(indexSource, /id="work-read-filter"/);
  assert.match(indexSource, /id="works-select-all"/);
  assert.match(indexSource, /id="mark-selected-seen"/);
  assert.match(APP_SOURCE, /selectedWorkFingerprints/);
  assert.match(APP_SOURCE, /\/api\/works\/seen-batch/);
  assert.match(indexSource, /阅读状态只在你显式标记后改变/);
});

test('M3 carries a monitored work into the content task form without granting authorization', () => {
  assert.match(APP_SOURCE, /data-create-content-work/);
  assert.match(APP_SOURCE, /content-work-prefill/);
  assert.match(APP_SOURCE, /sourceWorkFingerprint/);
  assert.match(APP_SOURCE, /未自动视为已授权素材/);
  assert.match(CONTENT_SOURCE, /cloud-worker-content-prefill/);
  assert.match(CONTENT_SOURCE, /sourceWorkFingerprint/);
  assert.match(CONTENT_SOURCE, /已带入监控作品来源；创建前请确认素材授权/);
});

test('M4 sends only safe view context with feedback', () => {
  assert.match(APP_SOURCE, /feedbackContextLabel/);
  assert.match(APP_SOURCE, /context:\s*\{/);
  assert.match(APP_SOURCE, /route:\s*window\.location\.hash/);
});

test('M4 keeps administrator maintenance out of the default settings category', async () => {
  const indexSource = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), '../public/index.html'),
    'utf8',
  );
  assert.match(indexSource, /data-settings-target="advanced"/);
  assert.match(APP_SOURCE, /settingsAdminZone/);
  assert.match(APP_SOURCE, /nextPanel !== 'advanced'/);
});
