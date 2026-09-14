/**
 * CE-DH-F5-01｜AI 数字人口播生产中心入口与 P01 页面骨架
 *
 * 本测试只做静态契约检查：入口、路由、页面挂载点、演示状态和“不做真实模型”的边界。
 * 它不启动服务，也不代表页面已经在浏览器里验收通过。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = await readFile(resolve(PROJECT_DIR, 'public/digital-human-workspace.js'), 'utf8');
const STYLES = await readFile(resolve(PROJECT_DIR, 'public/digital-human-workspace.css'), 'utf8');
const INDEX = await readFile(resolve(PROJECT_DIR, 'public/index.html'), 'utf8');
const APP = await readFile(resolve(PROJECT_DIR, 'public/app.js'), 'utf8');

test('F5-01 registers the digital human panel, module and stylesheet in the client shell', () => {
  assert.match(INDEX, /id="view-digital-human"/);
  assert.match(INDEX, /data-view-panel="digital-human"/);
  assert.match(INDEX, /src="\/digital-human-workspace\.js"/);
  assert.match(INDEX, /href="\/digital-human-workspace\.css"/);
  // 模块必须晚于 content-workspace.js 加载：入口卡要追加到已渲染的 #view-content 里。
  assert.ok(
    INDEX.indexOf('/content-workspace.js') < INDEX.indexOf('/digital-human-workspace.js'),
    'digital-human-workspace.js 必须晚于 content-workspace.js 加载',
  );
});

test('F5-01 registers the route in app.js and keeps it under the content editor nav', () => {
  assert.match(APP, /'digital-human'/);
  assert.match(APP, /AI 数字人口播生产中心/);
  assert.match(APP, /nextView === 'digital-human' && item\.dataset\.view === 'content'/);
});

test('P01 exposes the entry, the belonging context and the return action', () => {
  assert.match(SOURCE, /data-dh-open/);
  assert.match(SOURCE, /data-dh-back/);
  assert.match(SOURCE, /内容编辑云员工 \/ 生产入口/);
  assert.match(SOURCE, /返回内容编辑/);
  assert.match(SOURCE, /#view-digital-human/);
  assert.match(SOURCE, /#view-content/);
});

test('P01 states it is a batch production center where 1 item means a single video', () => {
  assert.match(SOURCE, /批量生产中心/);
  assert.match(SOURCE, /1 条明细 · 即单条生产/);
  assert.match(SOURCE, /不需要额外选择“单条模式”/);
  assert.match(SOURCE, /一条明细对应一个输出/);
});

test('P01 describes mode A and mode B without merging them', () => {
  assert.match(SOURCE, /文案 \+ 数字人形象\/声音生成视频/);
  assert.match(SOURCE, /已有视频 \+ 文案\/音频做口型同步/);
});

test('P01 provides the four required demo states', () => {
  assert.match(SOURCE, /id: 'empty'/);
  assert.match(SOURCE, /id: 'draft'/);
  assert.match(SOURCE, /id: 'waiting-review'/);
  assert.match(SOURCE, /id: 'partial-failed'/);
  assert.match(SOURCE, /空状态 \/ 待配置/);
  assert.match(SOURCE, /等待人工验收/);
  assert.match(SOURCE, /部分失败/);
});

test('demo data is labelled and cannot be mistaken for real generated video', () => {
  assert.match(SOURCE, /演示数据/);
  assert.match(SOURCE, /不代表任何真实视频已经生成/);
  assert.match(SOURCE, /未连接任何真实数字人/);
  assert.match(SOURCE, /演示数据/);
});

test('unimplemented actions give feedback instead of silent dead buttons', () => {
  assert.match(SOURCE, /data-dh-notice/);
  assert.match(SOURCE, /待实现/);
  assert.match(SOURCE, /未实现/);
  assert.match(SOURCE, /disabled/);
  assert.match(SOURCE, /不会生成真实视频文件/);
});

test('P01 refreshes and keeps page context across a reload', () => {
  assert.match(SOURCE, /data-dh-reset/);
  assert.match(SOURCE, /sessionStorage/);
  assert.match(SOURCE, /DH_SCENARIO_KEY/);
});

test('P01/P02 只允许调用数字人口播自己的端点 + 现有文案登记接口', () => {
  // F5-02 起 P01 可以读后端；F5-03 增加 P02 文案读取，并复用现有 /api/content/script-sets 登记候选。
  // 不允许直接改动批次（POST/PUT/DELETE /api/content/batches）。
  const endpoints = [...SOURCE.matchAll(/\/api\/[a-z0-9/_-]+/gi)].map((match) => match[0]);
  const allowed = new Set([
    '/api/content/digital-human/summary',
    '/api/content/digital-human/draft',
    '/api/content/digital-human/copy',
    '/api/content/digital-human/assets',
    '/api/content/digital-human/workspace',
    '/api/content/digital-human/preflight',
    '/api/content/digital-human/batches',
    '/api/content/digital-human/results',
    '/api/content/digital-human/package',
    '/api/content/digital-human/contexts',
    '/api/content/digital-human/copy-request',
    '/api/content/digital-human/profiles',
    '/api/content/digital-human/modeb',
    '/api/content/digital-human/source-videos',
    '/api/content/digital-human/video-mappings',
    '/api/content/digital-human/generate-real',
    '/api/content/digital-human/clone-voice-register',
    '/api/content/digital-human/heygem-health',
    '/api/content/batches/',
    '/api/content/script-sets',
  ]);
  for (const endpoint of endpoints) {
    assert.ok(allowed.has(endpoint), '数字人口播页面不允许调用未授权端点：' + endpoint);
  }
  assert.match(SOURCE, /DH_SUMMARY_ENDPOINT = '\/api\/content\/digital-human\/summary'/);
  assert.match(SOURCE, /DH_DRAFT_ENDPOINT = '\/api\/content\/digital-human\/draft'/);
  assert.match(SOURCE, /DH_COPY_ENDPOINT = '\/api\/content\/digital-human\/copy'/);
});

test('P01 永远不接触真实媒体能力，也不生成任何假视频引用', () => {
  assert.doesNotMatch(SOURCE, /XMLHttpRequest/);
  assert.doesNotMatch(SOURCE, /EventSource|WebSocket/);
  assert.doesNotMatch(SOURCE, /mediaDevices/);
  assert.doesNotMatch(SOURCE, /new Audio\(/);
  assert.doesNotMatch(SOURCE, /<video|<audio/);
  assert.doesNotMatch(SOURCE, /blob:/);
  assert.doesNotMatch(SOURCE, /\.mp4/);
});

test('digital human styles stay scoped to its own panel and the entry card', () => {
  assert.match(STYLES, /#view-digital-human/);
  assert.match(STYLES, /#view-content \.dh-entry/);
  for (const foreign of ['#view-monitor', '#view-downloads', '#view-settings', '#view-collab', '#view-planned']) {
    assert.ok(!STYLES.includes(foreign), 'digital-human 样式不得影响 ' + foreign);
  }
});
