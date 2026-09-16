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

test('P01 exposes the entry, the belonging context and the return action', async () => {
  /* F5-C2：入口卡已移到内容编辑父级页（content-workspace.js），
     本模块只保留挂在 #view-content 上的 [data-dh-open] 点击委托，不再注入 DOM。 */
  const CONTENT_UI = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), '../public/content-workspace.js'),
    'utf8',
  );
  assert.match(CONTENT_UI, /data-dh-open/);
  assert.match(SOURCE, /data-dh-open/);
  assert.match(SOURCE, /data-dh-back/);
  assert.match(SOURCE, /内容编辑云员工/);
  assert.match(SOURCE, /返回内容编辑/);
  assert.match(SOURCE, /#view-digital-human/);
  assert.match(SOURCE, /#view-content/);
  /* 不得再向 #view-content 注入第二张入口卡。 */
  assert.doesNotMatch(SOURCE, /dhContentRoot\.prepend/);
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

test('V4-01 keeps the p02 route and builds a validated P02 shell without fake batch data', () => {
  const COPY_RENDER = SOURCE.slice(SOURCE.indexOf('function dhRenderCopy'), SOURCE.indexOf('function dhResultCard'));
  assert.match(SOURCE, /const DH_PAGE_KEY = 'cloud-worker-digital-human-page'/);
  assert.match(SOURCE, /const DH_COPY_TAB_KEY = 'cloud-worker-digital-human-copy-tab'/);
  assert.match(SOURCE, /function dhIsValidPage\(page\)[\s\S]*?\['p01','p02','assets'/);
  assert.match(SOURCE, /function dhIsValidCopyTab\(tab\)[\s\S]*?DH_COPY_TABS\.includes\(tab\)/);
  assert.match(COPY_RENDER, /dhFlowBar\(\)/);
  assert.match(COPY_RENDER, /dhCopyTabNav\(\)/);
  assert.doesNotMatch(COPY_RENDER, /dhLayout\(/);
  for (const label of ['项目中心', '项目档案', '文案需求', '文案批次', '爆款采集', 'AI 仿写']) {
    assert.ok(SOURCE.includes("label: '" + label + "'"), '缺少 P02 页签：' + label);
  }
  assert.match(SOURCE, /采集接口未接入/);
  assert.match(SOURCE, /生成流程未接入/);
  assert.match(SOURCE, /当前接口提供文案候选及确认状态，没有批次列表/);
  assert.match(SOURCE, /再次保存会更新该项目最近一条活动需求/);
});

test('V4-02 project center tab renders the real home page from live endpoints', () => {
  const HOME = SOURCE.slice(SOURCE.indexOf('function dhContextSwitchHint'), SOURCE.indexOf('function dhCopyTabNav'));
  assert.ok(HOME.length > 2000, '项目中心主页区切片为空，测不到东西');
  /* 主页必须有：当前档案概览、准备度、下一步与阻塞、六页入口、数据源说明。 */
  for (const marker of ['项目与文案中心', 'dh-home-current', 'dh-home-readiness', 'dh-home-metrics', 'dh-home-next', 'dh-home-entries', 'dh-home-source']) {
    assert.ok(HOME.includes(marker), '项目中心主页缺少：' + marker);
  }
  assert.match(HOME, /DH_COPY_TAB_META\.map/);
  assert.match(HOME, /dhNextActionText\(nextAction\)/);
  assert.match(HOME, /dhUserFacingReason\(item\.message\)/);
  /* 只有一个真实工作台项目时：禁用切换并说明原因，不得声称能在本页新建项目。 */
  assert.match(HOME, /新建项目不在这个页面负责/);
  assert.doesNotMatch(HOME, /projects\?|\/api\/content\/projects/);
  /* 未接入入口保持禁用，不注入示例数据。 */
  assert.match(HOME, /disabled aria-disabled="true"/);
  assert.match(HOME, /不注入示例数据/);
  /* 准备度卡片必须把 cta 渲染成可用动作，并复用既有导航委托，不能只算不用。 */
  assert.match(HOME, /dh-home-metric-cta/);
  assert.match(HOME, /data-dh-copy-tab="' \+ dhEscape\(item\.tab\)/);
  assert.match(HOME, /data-dh-page="' \+ dhEscape\(item\.page\)/);
});

test('V4-02 project context switching reuses existing endpoints and keeps pending state honest', () => {
  /* 切换状态只走已有的 draft / contexts 接口，不新建第二套存储。 */
  assert.match(SOURCE, /const DH_CONTEXTS_ENDPOINT = '\/api\/content\/digital-human\/contexts'/);
  assert.match(SOURCE, /DH_DRAFT_ENDPOINT, \{ method: 'PUT'[\s\S]{0,200}?selectedContextId/);
  assert.doesNotMatch(SOURCE, /\/api\/content\/digital-human\/(projects|current-project|context-select)/);
  /* 下拉选择先进入待提交态，确认后才写服务端；失败不伪装成功。 */
  assert.match(SOURCE, /dhState\.contextPick = ctxPick\.value \|\| null/);
  assert.match(SOURCE, /dhSwitchContext\(dhState\.contextPick \|\| dhContexts\.data\?\.selectedContextId \|\| null\)/);
  assert.match(SOURCE, /await Promise\.all\(\[dhLoadContexts\(\), dhLoadCopy\(\)\]\)/);
  assert.match(SOURCE, /尚未保存：确认后写入生产草稿/);
  assert.match(SOURCE, /切换失败：/);
  assert.match(SOURCE, /当前生产草稿已经使用这个项目档案/);
  /* 还没有选定当前档案时，下拉不得默认选中第一项、按钮不得可点，提示也不得写成已保存。 */
  assert.match(SOURCE, /未选择当前档案/);
  assert.match(SOURCE, /还没有选定当前档案/);
  assert.match(SOURCE, /canSwitchContext && pendingContextId \? '' : ' disabled aria-disabled="true"'/);
  /* 刷新按钮在 P02 同时重读三个数据源，避免准备度停在旧值。 */
  const refreshHandler = SOURCE.slice(SOURCE.indexOf("const refresh = event.target.closest('[data-dh-refresh]')"), SOURCE.indexOf("const ctxPickSave"));
  assert.match(refreshHandler, /dhLoadSummary\(\)/);
  assert.match(refreshHandler, /dhLoadContexts\(\)/);
  assert.match(refreshHandler, /dhLoadCopy\(\)/);
});

test('V4-01 P02 content area shows real blocking reasons without developer slice codes', () => {
  /* P02 从数据源栏到渲染入口的整个内容区不得出现切片/需求编号这类开发坐标；
     阻塞结论本身（未接入、不做假提交）仍必须在页面上可读。 */
  const P02 = SOURCE.slice(SOURCE.indexOf('function dhCopySourceBar'), SOURCE.indexOf('function dhResultCard'));
  assert.ok(P02.length > 2000, 'P02 渲染区切片为空，测不到东西');
  const codeComments = P02.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(codeComments, /F5-\d\d/, 'P02 可见代码不应再引用切片编号');
  assert.doesNotMatch(codeComments, /·\s*N\d\d|（N\d\d）/, 'P02 可见代码不应再引用 N0x 需求编号');
  assert.doesNotMatch(codeComments, /P02 · |next_action：|blocking_issues（|allowed_actions（/);
  assert.match(codeComments, /阻塞项（/);
  assert.match(codeComments, /现在可以做的事（/);
  assert.match(codeComments, /不做假提交/);
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
    '/api/content/digital-human/results/items',
    '/api/content/digital-human/package',
    '/api/content/digital-human/packages',
    '/api/content/digital-human/usage',
    '/api/content/digital-human/upload-asset',
    '/api/content/avatar-profiles',
    '/api/content/voice-profiles',
    '/api/content/digital-human/n18-providers',
    '/api/content/digital-human/heygem-health',
    '/api/content/digital-human/heygem-health',
    '/api/content/batches/',
    '/api/content/script-sets',
    /* V4-02b：工作台项目只读现有项目列表接口，用于把本页数据按项目隔离。 */
    '/api/workspace/projects',
  ]);
  for (const endpoint of endpoints) {
    assert.ok(allowed.has(endpoint), '数字人口播页面不允许调用未授权端点：' + endpoint);
  }
  assert.match(SOURCE, /DH_SUMMARY_ENDPOINT = '\/api\/content\/digital-human\/summary'/);
  assert.match(SOURCE, /DH_DRAFT_ENDPOINT = '\/api\/content\/digital-human\/draft'/);
  assert.match(SOURCE, /DH_COPY_ENDPOINT = '\/api\/content\/digital-human\/copy'/);
});

test('数字人口播模块不伪造视频引用，且不引入架构外通道', () => {
  /* 契约更新（2026-09-15，第九阶段）：本模块已是真实媒体生产中心——P07 预览真实成片、
     P03 支持在线录制（mediaDevices）、资产与产出都带 .mp4 真实引用。原「禁止出现 .mp4 / mediaDevices」
     的护栏已与产品现实冲突，故收敛为仍然有效的约束：不伪造引用、不走旁路通道。 */
  assert.doesNotMatch(SOURCE, /XMLHttpRequest/);
  assert.doesNotMatch(SOURCE, /EventSource|WebSocket/);
  assert.doesNotMatch(SOURCE, /blob:/);                 /* 禁假链接：blob: 引用不可作为交付物 */
  assert.doesNotMatch(SOURCE, /src="demo|假视频|fake\.mp4/i);
  assert.match(SOURCE, /mediaDevices/);                 /* 在线录制：真实麦克风采集 */
  assert.match(SOURCE, /upload-asset/);                 /* 素材必须真的上传，不允许只在本地引用假路径 */
});

test('digital human styles stay scoped to its own panel and the entry card', () => {
  assert.match(STYLES, /#view-digital-human/);
  assert.match(STYLES, /#view-content \.dh-entry/);
  for (const foreign of ['#view-monitor', '#view-downloads', '#view-settings', '#view-collab', '#view-planned']) {
    assert.ok(!STYLES.includes(foreign), 'digital-human 样式不得影响 ' + foreign);
  }
});
