/* ===========================================================================
   AI 数字人口播生产中心 · DH-P01 生产中心（F5-01 骨架 + F5-02 真实数据投影）
   ---------------------------------------------------------------------------
   归属：云员工 / 内容编辑云员工
   路由：#digital-human（由 public/app.js 的 VIEW_META 注册）

   当前进度：
     F5-01 建立入口与页面骨架，四种演示状态可切换；
     F5-02 P01 默认从后端真实数据源读取任务摘要，按数据与状态设计 V1 的
           三轴规则（生成 / 审核 / 交付）显示状态，并显示服务端返回的
           allowed_actions、blocking_issues、next_action；支持保存最小任务草稿。

   数据来源（真实）：
     GET  /api/content/digital-human/summary   → 读 batches + tasks + catalog 后投影
     GET  /api/content/digital-human/draft     → 读取最小草稿
     PUT  /api/content/digital-human/draft     → 保存最小草稿

   仍然不做：
     - 不连接任何真实模型（TTS / 声音训练 / 形象训练 / 口型同步 / 视频渲染）；
     - 不生成任何视频文件，不创建可下载的假链接；
     - 不实现 P06/P07/P08 的闸门动作（它们只以 disabled + 原因出现）。

   后续切片：F5-03 P02 项目与文案 → F5-04 P03/P04/P05 资产 →
             F5-05 P06 生产任务与明细 → F5-06 P07 结果与人工验收 → F5-07 P08 内容包
   =========================================================================== */

const DH_VIEW = 'digital-human';
const DH_HOME_VIEW = 'content';
const DH_SCENARIO_KEY = 'cloud-worker-digital-human-demo-scenario';
const DH_MODE_REAL = 'real';
const DH_DEFAULT_SCENARIO = DH_MODE_REAL;

/* V4-02b：工作台项目列表复用现有只读接口，不新建第二套项目存储。 */
const DH_WORKBENCH_PROJECTS_ENDPOINT = '/api/workspace/projects';
const DH_SUMMARY_ENDPOINT = '/api/content/digital-human/summary';
const DH_DRAFT_ENDPOINT = '/api/content/digital-human/draft';
const DH_COPY_ENDPOINT = '/api/content/digital-human/copy';
const DH_ASSETS_ENDPOINT = '/api/content/digital-human/assets';
const DH_WORKSPACE_ENDPOINT = '/api/content/digital-human/workspace';
const DH_PREFLIGHT_ENDPOINT = '/api/content/digital-human/preflight';
const DH_BATCH_CREATE_ENDPOINT = '/api/content/digital-human/batches';
const DH_RESULTS_ENDPOINT = '/api/content/digital-human/results';
const DH_CONTEXTS_ENDPOINT = '/api/content/digital-human/contexts';
const DH_COPY_REQUEST_ENDPOINT = '/api/content/digital-human/copy-request';
const DH_PACKAGE_ENDPOINT = '/api/content/digital-human/package';
const DH_PROFILES_ENDPOINT = '/api/content/digital-human/profiles';
const DH_MODEB_ENDPOINT = '/api/content/digital-human/modeb';
const DH_SOURCE_VIDEO_ENDPOINT = '/api/content/digital-human/source-videos';
const DH_MAPPING_ENDPOINT = '/api/content/digital-human/video-mappings';
const DH_BATCH_ACTIONS_BASE = '/api/content/batches/';
const DH_SCRIPT_SETS_ENDPOINT = '/api/content/script-sets';

/* 子页面：P01 生产中心 / P02 项目与文案 / P03–P05 生产资产 / P06 生产任务。 */
const DH_PAGE_KEY = 'cloud-worker-digital-human-page';
const DH_COPY_TAB_KEY = 'cloud-worker-digital-human-copy-tab';
/* V4-02b：选中的工作台项目在刷新后保持；它只影响读取作用域，不代表创建了项目。 */
const DH_PROJECT_SCOPE_KEY = 'cloud-worker-digital-human-project-scope';
/* V4-02：页签元数据只有一份，页签导航与「项目中心」主页入口共用，避免两处口径不一致。 */
const DH_COPY_TAB_META = [
  { id: 'overview', label: '项目中心', slice: '项目与文案主页：当前档案、生产准备度、真实指标与页面入口' },
  { id: 'profile', label: '项目档案', slice: '创建与编辑项目档案，选择本次生产使用的档案版本' },
  { id: 'request', label: '文案需求', slice: '保存批量候选的数量、方向、平台与时长' },
  { id: 'candidates', label: '文案批次', slice: '逐条查看、确认候选并登记手动文案' },
  { id: 'collection', label: '爆款采集', reason: '采集接口未接入' },
  { id: 'rewrite', label: 'AI 仿写', reason: '生成流程未接入' },
];
const DH_COPY_TABS = DH_COPY_TAB_META.map((tab) => tab.id);
/* F5-C2：与 app.js / content-workspace.js 约定的监控作品带入键，三处必须一致。 */
const DH_PREFILL_KEY = 'cloud-worker-content-prefill';
const DH_PAGE_P01 = 'p01';
const DH_PAGE_P02 = 'p02';
const DH_PAGE_ASSETS = 'assets';
const DH_PAGE_TASK = 'task';
const DH_PAGE_RESULTS = 'results';
const DH_PAGE_PACKAGE = 'package';

const dhRoot = document.querySelector('#view-digital-human');
const dhContentRoot = document.querySelector('#view-content');

/* ---------------------------------------------------------------------------
   演示状态元数据
   --------------------------------------------------------------------------- */

const DH_TASK_STATUS = {
  draft: { label: '草稿', tone: 'draft', hint: '明细尚未配置完整' },
  waiting_review: { label: '等待人工验收', tone: 'review', hint: '已有结果等待人工判断' },
  partial_failed: { label: '部分失败', tone: 'failed', hint: '存在失败明细，可单独重试' },
  completed: { label: '已完成', tone: 'done', hint: '已通过明细可进入内容包' },
};

const DH_ITEM_STATUS = {
  planned: { label: '待配置', tone: 'draft' },
  queued: { label: '已排队', tone: 'draft' },
  generating: { label: '生成中', tone: 'running' },
  waiting_review: { label: '等待人工验收', tone: 'review' },
  approved: { label: '已通过', tone: 'done' },
  failed: { label: '失败', tone: 'failed' },
};

const DH_MODE = {
  A: {
    label: '模式 A',
    full: '模式 A · 文案 + 数字人形象/声音生成视频',
    detail: '输入已确认文案与一个已启用数字人（形象 + 声音），生成新的口播视频。',
  },
  B: {
    label: '模式 B',
    full: '模式 B · 已有视频 + 文案/音频做口型同步',
    detail: '输入之前拍好的员工/数字人视频，再匹配文案或音频完成口型同步。',
  },
};

/* ---------------------------------------------------------------------------
   演示 fixture（全部为示例数据，不代表任何真实生产结果）
   --------------------------------------------------------------------------- */

const DH_SCENARIOS = [
  {
    id: 'empty',
    label: '空状态 / 待配置',
    intent: '第一次进入生产中心，还没有任何生产任务。',
    context: { industry: '职业技能培训', project: '（尚未选择项目）', owner: '内容运营（示例）' },
    tasks: [],
  },
  {
    id: 'draft',
    label: '草稿',
    intent: '任务已创建，明细还没配置完整，需要继续补全。',
    context: { industry: '职业技能培训', project: '秋季新品推广', owner: '内容运营（示例）' },
    tasks: [
      {
        id: 'DH-DEMO-1001',
        name: '秋季新品口播（示例）',
        project: '秋季新品推广',
        mode: 'A',
        status: 'draft',
        nextAction: '继续配置明细',
        updatedAt: '2026-09-11 09:20',
        items: [
          {
            index: 1,
            status: 'planned',
            persona: '小雅（示例形象）',
            script: '秋季新品卖点 · A 版',
            source: '—',
            note: '还没有选择场景模板',
          },
        ],
      },
    ],
  },
  {
    id: 'waiting-review',
    label: '等待人工验收',
    intent: '已有结果完成生成，等待人工判断通过或退回修改。',
    context: { industry: '职业技能培训', project: '品牌故事', owner: '内容运营（示例）' },
    tasks: [
      {
        id: 'DH-DEMO-1002',
        name: '品牌故事系列（第 1 批 · 示例）',
        project: '品牌故事',
        mode: 'A',
        status: 'waiting_review',
        nextAction: '进入人工验收',
        updatedAt: '2026-09-11 08:40',
        items: [
          { index: 1, status: 'approved', persona: '小雅（示例形象）', script: '品牌故事 · 开场篇', source: '—', note: '已完成人工确认' },
          { index: 2, status: 'waiting_review', persona: '小雅（示例形象）', script: '品牌故事 · 师资篇', source: '—', note: '等待人工判断' },
          { index: 3, status: 'waiting_review', persona: '林晨（示例形象）', script: '品牌故事 · 学员篇', source: '—', note: '等待人工判断' },
        ],
      },
    ],
  },
  {
    id: 'partial-failed',
    label: '部分失败',
    intent: '批次里只有一部分明细失败，其余可以通过，失败明细需要单独重试。',
    context: { industry: '职业技能培训', project: '产品培训', owner: '内容运营（示例）' },
    tasks: [
      {
        id: 'DH-DEMO-1003',
        name: '产品使用教程（第 2 批 · 示例）',
        project: '产品培训',
        mode: 'B',
        status: 'partial_failed',
        nextAction: '重试失败明细',
        updatedAt: '2026-09-10 18:05',
        items: [
          { index: 1, status: 'approved', persona: '林晨（示例形象）', script: '教程 · 第 1 节', source: '已拍摄视频 A（示例）', note: '已通过人工验收' },
          { index: 2, status: 'failed', persona: '林晨（示例形象）', script: '教程 · 第 2 节', source: '已拍摄视频 B（示例）', note: '失败原因：待同步的音频输入缺失（示例）' },
          { index: 3, status: 'waiting_review', persona: '小雅（示例形象）', script: '教程 · 第 3 节', source: '已拍摄视频 C（示例）', note: '等待人工判断' },
          { index: 4, status: 'approved', persona: '小雅（示例形象）', script: '教程 · 第 4 节', source: '已拍摄视频 D（示例）', note: '已通过人工验收' },
        ],
      },
    ],
  },
];

/* ---------------------------------------------------------------------------
   工具函数
   --------------------------------------------------------------------------- */

function dhEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function dhScenarioById(id) {
  return DH_SCENARIOS.find((item) => item.id === id) || null;
}

function dhIsRealMode() {
  return dhState.scenarioId === DH_MODE_REAL;
}

function dhIsValidMode(id) {
  return id === DH_MODE_REAL || Boolean(dhScenarioById(id));
}

function dhReadStoredPage() {
  try {
    const stored = window.sessionStorage.getItem(DH_PAGE_KEY);
    return dhIsValidPage(stored) ? stored : DH_PAGE_P01;
  } catch {
    return DH_PAGE_P01;
  }
}

function dhIsValidPage(page) {
  return ['p01','p02','assets','task','results','package'].includes(page);
}

function dhIsValidCopyTab(tab) {
  return DH_COPY_TABS.includes(tab);
}

function dhReadStoredCopyTab() {
  try {
    const stored = window.sessionStorage.getItem(DH_COPY_TAB_KEY);
    return dhIsValidCopyTab(stored) ? stored : 'overview';
  } catch {
    return 'overview';
  }
}

function dhWriteStoredCopyTab(tab) {
  try {
    if (dhIsValidCopyTab(tab)) window.sessionStorage.setItem(DH_COPY_TAB_KEY, tab);
  } catch {
    // 存储不可用时只影响刷新后停留的页签，不影响功能。
  }
}

function dhWriteStoredPage(page) {
  try {
    window.sessionStorage.setItem(DH_PAGE_KEY, page);
  } catch {
    // 存储不可用时只影响刷新后停留的子页面，不影响功能。
  }
}

function dhReadStoredProjectScope() {
  try {
    return window.sessionStorage.getItem(DH_PROJECT_SCOPE_KEY) || null;
  } catch {
    return null;
  }
}

function dhWriteStoredProjectScope(projectId) {
  try {
    if (projectId) window.sessionStorage.setItem(DH_PROJECT_SCOPE_KEY, projectId);
    else window.sessionStorage.removeItem(DH_PROJECT_SCOPE_KEY);
  } catch {
    // 存储不可用时只影响刷新后的项目保留，不影响数据读取。
  }
}

function dhReadStoredScenario() {
  try {
    const stored = window.sessionStorage.getItem(DH_SCENARIO_KEY);
    return dhIsValidMode(stored) ? stored : null;
  } catch {
    return null;
  }
}

function dhWriteStoredScenario(id) {
  try {
    window.sessionStorage.setItem(DH_SCENARIO_KEY, id);
  } catch {
    // 存储不可用时仅影响刷新后的上下文保留，不阻塞页面。
  }
}

function dhClearStoredScenario() {
  try {
    window.sessionStorage.removeItem(DH_SCENARIO_KEY);
  } catch {
    // 同上。
  }
}

function dhCountItems(tasks, statuses) {
  return tasks.reduce(
    (total, task) =>
      total + task.items.filter((item) => statuses.includes(item.status)).length,
    0,
  );
}

function dhCountTasks(tasks, statuses) {
  return tasks.filter((task) => statuses.includes(task.status)).length;
}

/* ---------------------------------------------------------------------------
   页面状态
   --------------------------------------------------------------------------- */

/* F5-C2：监控中心带入的作品来源。只读展示，不创建内容任务，也不恢复旧首页表单。 */
const dhWorkPrefill = { record: null };

function dhReadWorkPrefill() {
  try {
    const raw = window.sessionStorage.getItem(DH_PREFILL_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const dhState = {
  scenarioId: dhReadStoredScenario() || DH_DEFAULT_SCENARIO,
  filter: 'all',
  notice: null,
  page: dhReadStoredPage() || DH_PAGE_P01,
  copyTab: dhReadStoredCopyTab(),
  /* V4-02：项目档案下拉的待提交选择；不等于已生效，生效以服务端的 selectedContextId 为准。 */
  contextPick: null,
  /* V4-02b：当前选定的工作台项目 id。它只决定“读哪个项目的数据”，
     与项目档案（project_contexts）是两个层级，也不代表新建了项目。 */
  projectScope: dhReadStoredProjectScope(),
  /* V4-02b：工作台项目下拉的待提交选择；不等于已切换，生效以 projectScope 为准。 */
  projectPick: null,
};

/* F5-04：生产资产状态。 */
const dhAssets = {
  status: 'idle', /* idle | loading | ready | error */
  data: null,
  error: null,
};

/* F5-05：P06 任务工作区状态。 */
const dhWorkspace = {
  status: 'idle', /* idle | loading | ready | error */
  data: null,
  error: null,
};

/* 明细行的本地编辑副本；「保存明细」才写入草稿。 */
const dhTaskRows = [];
const dhResults = { status: 'idle', data: null, error: null };
const dhContexts = { status: 'idle', data: null, error: null, requestHydrated: false };
const dhContextForm = { contextKey: '', name: '', industry: '', product: '', audience: '', sellingPoints: '', contentGoal: '' };
const dhCopyRequestForm = { count: 3, direction: '', platform: '抖音', durationSeconds: 45 };
const dhPackage = { status: 'idle', data: null, error: null, lastError: null };
const dhModeB = { status: 'idle', data: null, error: null };
const dhProfileForm = { name: '', subjectRole: '', avatarVersionId: '', voiceVersionId: '' };
const dhVideoForm = { name: '', fileRef: '', durationSeconds: '', aspect: '9:16' };
const dhMappingForm = { videoId: '', scriptVersionId: '', voiceSource: 'original', templateVersionId: '' };
const dhPreflight = {
  running: false,
  gate: null,
  error: null,
};

/* F5-03：P02 文案候选状态。 */
const dhCopy = {
  status: 'idle', /* idle | loading | ready | error */
  data: null,
  error: null,
};

const dhCopyForm = {
  title: '',
  text: '',
  approved: false,
  platform: '抖音',
};

/* 展开全文的候选 id 集合（长文本默认摘要，10.2 第 4 条）。 */
const dhCopyUi = {
  expanded: new Set(),
  registerOpen: false,
};

/* F5-02 真实数据读取状态。页面永远区分“真实读取结果”和“演示 fixture”。 */
const dhReal = {
  status: 'idle', /* idle | loading | ready | error */
  summary: null,
  error: null,
};

/* V4-02b：工作台项目列表（GET /api/workspace/projects）。与项目档案分开维护。 */
const dhProjects = {
  status: 'idle', /* idle | loading | ready | error */
  list: [],
  error: null,
};

const dhDraft = {
  status: 'idle', /* idle | loading | ready | error */
  record: null,
  error: null,
  saveState: 'idle', /* idle | saving | saved | error */
  saveMessage: null,
};

/* 草稿表单。默认关联真实数据里第一条可见内容任务。 */
const dhDraftForm = {
  taskId: '',
  mode: 'A',
  title: '',
  note: '',
  plannedItemCount: 1,
};

function dhCurrentScenario() {
  return dhScenarioById(dhState.scenarioId) || DH_SCENARIOS[0];
}

/* ---------------------------------------------------------------------------
   真实数据访问
   --------------------------------------------------------------------------- */

/* V4-02b：一个统一的作域参数拼接器。未选定项目时不传参，保持服务端默认行为。 */
function dhScopedEndpoint(endpoint, extraParams = {}) {
  const params = new URLSearchParams();
  if (dhState.projectScope) params.set('projectId', dhState.projectScope);
  for (const [key, value] of Object.entries(extraParams)) {
    if (value) params.set(key, String(value));
  }
  const query = params.toString();
  return endpoint + (query ? (endpoint.includes('?') ? '&' : '?') + query : '');
}

/* 内容任务的归属以服务端为准：同一任务 id 不会因为前端传了另一个 projectId 而返另一项目的数据。 */
async function dhApi(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || '请求失败（HTTP ' + response.status + '）');
    error.httpStatus = response.status;
    throw error;
  }
  return payload;
}

async function dhLoadSummary() {
  dhReal.status = 'loading';
  dhReal.error = null;
  dhRender();
  try {
    const payload = await dhApi(dhScopedEndpoint(DH_SUMMARY_ENDPOINT));
    dhReal.summary = payload.summary || null;
    dhReal.status = 'ready';
    const firstTask = dhReal.summary?.contentTasks?.[0];
    if (firstTask && !dhDraftForm.taskId) {
      dhDraftForm.taskId = firstTask.id;
      dhDraftForm.title = (firstTask.title || '口播生产') + ' · 草稿';
    }
  } catch (error) {
    dhReal.summary = null;
    dhReal.error = {
      message: error.message,
      httpStatus: error.httpStatus || null,
    };
    dhReal.status = 'error';
  }
  dhRender();
}

/* V4-02b：工作台项目列表。只读现有接口，失败时保留真实错误，不伪造项目。 */
async function dhLoadProjects() {
  dhProjects.status = 'loading';
  dhProjects.error = null;
  dhRender();
  try {
    const payload = await dhApi(DH_WORKBENCH_PROJECTS_ENDPOINT);
    dhProjects.list = Array.isArray(payload.projects) ? payload.projects : [];
    dhProjects.status = 'ready';
  } catch (error) {
    dhProjects.list = [];
    dhProjects.status = 'error';
    dhProjects.error = { message: error.message, httpStatus: error.httpStatus || null };
  }
  dhNormalizeProjectScope();
  dhRender();
}

/* V4-02b：把刷新前恢复的项目选择归一到真实列表：
   只有一个项目时直接锁到它；选中项目已不可访问时清空，不拿错 id 去读数据。 */
function dhNormalizeProjectScope() {
  if (dhProjects.status !== 'ready') {
    return;
  }
  const exists = dhProjects.list.some((item) => item.id === dhState.projectScope);
  if (dhState.projectScope && !exists) {
    dhState.projectScope = null;
    dhWriteStoredProjectScope(null);
  }
  if (!dhState.projectScope && dhProjects.list.length === 1) {
    dhState.projectScope = dhProjects.list[0].id;
    dhWriteStoredProjectScope(dhState.projectScope);
  }
  dhState.projectPick = null;
}

/* V4-02b：切换工作台项目。先清空上一个项目的全部读取态与待提交选择，
   再按新项目重读，避免旧数据在新项目下短暂可见（跨项目串数据）。 */
async function dhSwitchProject(projectId) {
  /* 只接受列表里真实存在的项目，不把错的 id 当作作用域去读数据。 */
  const next = dhProjects.list.some((item) => item.id === projectId) ? projectId : null;
  if (next === (dhState.projectScope || null)) {
    return;
  }
  dhState.projectScope = next;
  dhWriteStoredProjectScope(next);
  dhState.contextPick = null;
  dhState.projectPick = null;
  dhState.notice = null;
  dhReal.summary = null;
  dhReal.error = null;
  dhReal.status = 'idle';
  dhDraft.record = null;
  dhDraft.status = 'idle';
  dhDraft.error = null;
  dhDraft.saveState = 'idle';
  dhDraft.saveMessage = null;
  dhDraftForm.taskId = '';
  dhDraftForm.selectedContextId = null;
  dhDraftForm.mode = 'A';
  dhDraftForm.title = '';
  dhDraftForm.note = '';
  dhDraftForm.plannedItemCount = 1;
  dhCopy.data = null;
  dhCopy.status = 'idle';
  dhCopy.error = null;
  dhContexts.data = null;
  dhContexts.status = 'idle';
  dhContexts.error = null;
  dhContexts.requestHydrated = false;
  /* 其他页签/子页的读取态也一并失效：切页时 lazy reload 会带新项目作用域。 */
  dhAssets.data = null;
  dhAssets.status = 'idle';
  dhAssets.error = null;
  dhWorkspace.data = null;
  dhWorkspace.status = 'idle';
  dhWorkspace.error = null;
  dhResults.data = null;
  dhResults.status = 'idle';
  dhResults.error = null;
  dhPackage.data = null;
  dhPackage.status = 'idle';
  dhPackage.error = null;
  dhTaskRows.length = 0;
  /* 未提交的表单属于上一个项目，不带到新项目里。 */
  Object.assign(dhContextForm, {
    contextKey: '', name: '', industry: '', product: '', audience: '', sellingPoints: '', contentGoal: '',
  });
  Object.assign(dhCopyRequestForm, { count: 3, direction: '', platform: '抖音', durationSeconds: 45 });
  dhPreflight.gate = null;
  dhPreflight.error = null;
  dhRender();
  /* 工作台项目、草稿、摘要、档案与文案一起重读：主页与 P01 共用这些状态。 */
  await Promise.all([dhLoadDraft(), dhLoadSummary(), dhLoadContexts(), dhLoadCopy()]);
  const project = dhProjects.list.find((item) => item.id === next);
  dhNoticeSet(project
    ? '已切到工作台项目「' + project.name + '」，本页数据已全部重新读取。'
    : '已改为不指定工作台项目，本页数据已重新读取。');
}

async function dhLoadDraft() {
  dhDraft.status = 'loading';
  dhDraft.error = null;
  try {
    const payload = await dhApi(dhScopedEndpoint(DH_DRAFT_ENDPOINT));
    dhDraft.record = payload.draft || null;
    dhDraft.status = 'ready';
    if (dhDraft.record) {
      dhDraftForm.taskId = dhDraft.record.taskId || dhDraftForm.taskId;
      dhDraftForm.mode = dhDraft.record.mode || 'A';
      dhDraftForm.title = dhDraft.record.title || dhDraftForm.title;
      dhDraftForm.note = dhDraft.record.note || '';
      dhDraftForm.plannedItemCount = dhDraft.record.plannedItemCount || 1;
    }
  } catch (error) {
    dhDraft.record = null;
    dhDraft.status = 'error';
    dhDraft.error = { message: error.message, httpStatus: error.httpStatus || null };
  }
  dhRender();
}

async function dhSaveDraft() {
  if (!dhDraftForm.taskId) {
    dhDraft.saveState = 'error';
    dhDraft.saveMessage = '请先选择一个内容任务，草稿必须挂在真实内容任务下面。';
    dhRender();
    return;
  }
  dhDraft.saveState = 'saving';
  dhDraft.saveMessage = null;
  dhRender();
  try {
    const payload = await dhApi(DH_DRAFT_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: dhDraftForm.taskId,
        mode: dhDraftForm.mode,
        title: dhDraftForm.title,
        note: dhDraftForm.note,
        plannedItemCount: Number(dhDraftForm.plannedItemCount) || 1,
      }),
    });
    dhDraft.record = payload.draft || null;
    dhDraft.status = 'ready';
    dhDraft.saveState = 'saved';
    dhDraft.saveMessage = '草稿已保存到本地数据存储（digital_human_drafts），刷新后仍然存在。';
  } catch (error) {
    dhDraft.saveState = 'error';
    dhDraft.saveMessage = '草稿保存失败：' + error.message;
  }
  dhRender();
}

function dhSyncDraftFormFromDom() {
  if (!dhRoot) {
    return;
  }
  const taskSelect = dhRoot.querySelector('[data-dh-draft-field="taskId"]');
  const modeSelect = dhRoot.querySelector('[data-dh-draft-field="mode"]');
  const titleInput = dhRoot.querySelector('[data-dh-draft-field="title"]');
  const noteInput = dhRoot.querySelector('[data-dh-draft-field="note"]');
  const countInput = dhRoot.querySelector('[data-dh-draft-field="plannedItemCount"]');
  if (taskSelect) dhDraftForm.taskId = taskSelect.value;
  if (modeSelect) dhDraftForm.mode = modeSelect.value;
  if (titleInput) dhDraftForm.title = titleInput.value;
  if (noteInput) dhDraftForm.note = noteInput.value;
  if (countInput) dhDraftForm.plannedItemCount = Number(countInput.value) || 1;
}

/* ---------------------------------------------------------------------------
   F5-03：P02 项目与文案
   --------------------------------------------------------------------------- */

async function dhLoadCopy() {
  dhCopy.status = 'loading';
  dhCopy.error = null;
  dhRender();
  try {
    const payload = await dhApi(dhScopedEndpoint(DH_COPY_ENDPOINT));
    dhCopy.data = payload.copy || null;
    dhCopy.status = 'ready';
  } catch (error) {
    dhCopy.data = null;
    dhCopy.status = 'error';
    dhCopy.error = { message: error.message, httpStatus: error.httpStatus || null };
  }
  dhRender();
}

async function dhSelectCopy(scriptVersionId) {
  if (!dhDraftForm.taskId) {
    dhDraft.saveState = 'error';
    dhDraft.saveMessage = '请先在 P01 选择关联的内容任务，文案选择必须挂在真实草稿上。';
    dhRender();
    return;
  }
  dhDraft.saveState = 'saving';
  dhDraft.saveMessage = null;
  dhRender();
  try {
    const payload = await dhApi(DH_DRAFT_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: dhDraftForm.taskId,
        mode: dhDraftForm.mode,
        title: dhDraftForm.title,
        note: dhDraftForm.note,
        plannedItemCount: Number(dhDraftForm.plannedItemCount) || 1,
        selectedScriptVersionId: scriptVersionId,
      }),
    });
    dhDraft.record = payload.draft || null;
    dhDraft.status = 'ready';
    dhDraft.saveState = 'saved';
    dhDraft.saveMessage = '已把选定文案写入生产草稿，返回生产中心或刷新后仍然保留。';
    if (dhCopy.data) {
      dhCopy.data = await dhApi(dhScopedEndpoint(DH_COPY_ENDPOINT)).then((result) => result.copy);
    }
  } catch (error) {
    dhDraft.saveState = 'error';
    dhDraft.saveMessage = '文案选择保存失败：' + error.message;
  }
  dhRender();
}

async function dhRegisterCopy() {
  if (!dhDraftForm.taskId) {
    dhCopy.status = 'error';
    dhCopy.error = { message: '请先在 P01 选择关联的内容任务，文案必须登记到真实任务下。' };
    dhRender();
    return;
  }
  if (!dhCopyForm.text.trim()) {
    dhCopy.status = 'error';
    dhCopy.error = { message: '文案正文不能为空。' };
    dhRender();
    return;
  }
  dhCopy.status = 'loading';
  dhRender();
  try {
    await dhApi(DH_SCRIPT_SETS_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: dhReal.summary?.project?.id || undefined,
        taskId: dhDraftForm.taskId,
        name: dhCopyForm.title.trim() || '未命名脚本',
        approved: dhCopyForm.approved === true,
        versions: [
          {
            title: dhCopyForm.title.trim() || '未命名文案',
            text: dhCopyForm.text.trim(),
            platform: dhCopyForm.platform,
            language: 'zh-CN',
          },
        ],
      }),
    });
    dhCopyForm.title = '';
    dhCopyForm.text = '';
    dhCopyForm.approved = false;
    dhCopyUi.registerOpen = false;
    const payload = await dhApi(dhScopedEndpoint(DH_COPY_ENDPOINT));
    dhCopy.data = payload.copy || null;
    dhCopy.status = 'ready';
    dhCopy.error = null;
  } catch (error) {
    dhCopy.status = 'error';
    dhCopy.error = { message: '文案登记失败：' + error.message };
  }
  dhRender();
}

function dhSyncAssetFormsFromDom() {
  if (!dhRoot) return;
  dhRoot.querySelectorAll('[data-dh-profile-field]').forEach((el) => { dhProfileForm[el.dataset.dhProfileField] = el.value; });
  dhRoot.querySelectorAll('[data-dh-video-field]').forEach((el) => { dhVideoForm[el.dataset.dhVideoField] = el.value; });
  dhRoot.querySelectorAll('[data-dh-map-field]').forEach((el) => { dhMappingForm[el.dataset.dhMapField] = el.value; });
}

function dhSyncContextFormsFromDom() {
  if (!dhRoot) return;
  dhRoot.querySelectorAll('[data-dh-ctx-field]').forEach((el) => {
    const key = el.dataset.dhCtxField;
    if (key === 'count' || key === 'durationSeconds') dhCopyRequestForm[key] = Number(el.value) || 0;
    else if (key === 'direction' || key === 'platform') dhCopyRequestForm[key] = el.value;
    else dhContextForm[key] = el.value;
  });
}

function dhSyncCopyFormFromDom() {
  if (!dhRoot) {
    return;
  }
  const title = dhRoot.querySelector('[data-dh-copy-field="title"]');
  const body = dhRoot.querySelector('[data-dh-copy-field="text"]');
  const approved = dhRoot.querySelector('[data-dh-copy-field="approved"]');
  const platform = dhRoot.querySelector('[data-dh-copy-field="platform"]');
  if (title) dhCopyForm.title = title.value;
  if (body) dhCopyForm.text = body.value;
  if (approved) dhCopyForm.approved = approved.checked === true;
  if (platform) dhCopyForm.platform = platform.value;
}

/* ---------------------------------------------------------------------------
   F5-05：P06 生产任务工作区（显式明细 + 输出设置 + N17 生成前检查）
   --------------------------------------------------------------------------- */

function dhSyncRowsFromDraft(draft) {
  dhTaskRows.length = 0;
  const rows = Array.isArray(draft?.plannedItems) ? draft.plannedItems : [];
  for (const row of rows) {
    dhTaskRows.push({
      mode: row.mode || 'A',
      scriptVersionId: row.scriptVersionId || null,
      avatarVersionId: row.avatarVersionId || null,
      voiceVersionId: row.voiceVersionId || null,
      templateVersionId: row.templateVersionId || null,
      sourceVideoAssetId: row.sourceVideoAssetId || null,
      outputName: row.outputName || '',
      outputSubdirectory: row.outputSubdirectory || '',
    });
  }
}

async function dhLoadWorkspace() {
  dhWorkspace.status = 'loading';
  dhWorkspace.error = null;
  dhRender();
  try {
    /* 行编辑器需要文案候选和资产选项，先保证它们已加载。 */
    if (dhCopy.status !== 'ready') {
      await dhLoadCopy();
    }
    if (dhAssets.status !== 'ready') {
      await dhLoadAssets();
    }
    /* 明细行的权威来源是服务端草稿：每次进入工作区都重读，不能用页面初始化时的旧副本。 */
    await dhLoadDraft();
    const payload = await dhApi(dhScopedEndpoint(DH_WORKSPACE_ENDPOINT));
    dhWorkspace.data = payload.workspace || null;
    dhWorkspace.status = 'ready';
    dhSyncRowsFromDraft(dhDraft.record);
  } catch (error) {
    dhWorkspace.data = null;
    dhWorkspace.status = 'error';
    dhWorkspace.error = { message: error.message, httpStatus: error.httpStatus || null };
  }
  dhRender();
}

function dhAddTaskRow() {
  const mode = dhWorkspace.data?.mode || 'A';
  const used = new Set(dhTaskRows.map((row) => row.outputName));
  let index = dhTaskRows.length + 1;
  let name = 'row-' + String(index).padStart(2, '0');
  while (used.has(name)) {
    index += 1;
    name = 'row-' + String(index).padStart(2, '0');
  }
  dhTaskRows.push({
    mode,
    scriptVersionId: dhCopy.data?.selectedScriptVersionId || dhDraft.record?.selectedScriptVersionId || null,
    avatarVersionId: dhDraft.record?.selectedAvatarVersionId || null,
    voiceVersionId: dhDraft.record?.selectedVoiceVersionId || null,
    templateVersionId: dhDraft.record?.selectedTemplateVersionId || null,
    sourceVideoAssetId: null,
    outputName: name,
    outputSubdirectory: '',
  });
  dhRender();
}

function dhRemoveTaskRow(index) {
  if (index >= 0 && index < dhTaskRows.length) {
    dhTaskRows.splice(index, 1);
    dhRender();
  }
}

function dhSyncTaskRowsFromDom() {
  if (!dhRoot) {
    return;
  }
  /* 遍历的是字段（data-dh-row-field），行号从最近的行容器（data-dh-row）上取。
     之前遍历容器本身导致所有编辑都被丢弃——这是被验收抓出来的真实缺陷。 */
  dhRoot.querySelectorAll('[data-dh-row-field]').forEach((element) => {
    const container = element.closest('[data-dh-row]');
    if (!container) {
      return;
    }
    const index = Number(container.dataset.dhRow);
    if (!Number.isInteger(index) || !dhTaskRows[index]) {
      return;
    }
    const field = element.dataset.dhRowField;
    if (element.type === 'checkbox') {
      dhTaskRows[index][field] = element.checked === true;
      return;
    }
    dhTaskRows[index][field] = element.value && element.value.trim ? element.value : element.value || null;
    if (dhTaskRows[index][field] === '') {
      dhTaskRows[index][field] = null;
    }
  });
}


async function dhRunRealGenerate(rowNo) {
  const taskId = dhDraft.record?.taskId || dhDraftForm.taskId;
  if (!taskId) {
    dhWorkspace.error = { message: '请先在 P01 选择关联的内容任务。' };
    dhRender();
    return;
  }
  if (!window.confirm('真实生成会调用豆包克隆音色 + HeyGem 云 GPU（约 2-4 分钟，消耗少量额度），确定开始？')) return;
  dhWorkspace.status = 'loading';
  dhWorkspace.error = null;
  dhRender();
  try {
    const payload = await dhApi('/api/content/digital-human/generate-real', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, rowNo: rowNo + 1 }),
    });
    dhWorkspace.status = 'ready';
    dhWorkspace.error = { message: '真实生成完成：' + (payload.file || '') + '（音频：' + (payload.audio || '') + '）', kind: 'ok' };
  } catch (error) {
    dhWorkspace.status = 'ready';
    dhWorkspace.error = { message: '真实生成失败：' + (error.message || '未知错误') };
  }
  dhRender();
}



/* 真实能力状态：页面必须如实反映"接了没有"，不得保留 S6 时代的静态免责声明 */
const dhCapability = { status: 'idle', providers: [], worker: null, error: null };

async function dhLoadCapability() {
  dhCapability.status = 'loading';
  dhRender();
  try {
    const payload = await dhApi('/api/content/digital-human/n18-providers');
    dhCapability.providers = payload.providers || [];
    dhCapability.status = 'ready';
  } catch (error) {
    dhCapability.providers = [];
    dhCapability.status = 'ready';
    dhCapability.error = error.message;
  }
  dhRender();
  /* GPU Worker 探测不阻塞主渲染 */
  try {
    const health = await dhApi('/api/content/digital-human/heygem-health');
    dhCapability.worker = health.worker || { ok: false };
  } catch (error) {
    dhCapability.worker = { ok: false, error: error.message };
  }
  dhRender();
}

function dhCapabilitySentence() {
  const preferred = (dhCapability.providers || []).filter((item) => item.status === 'preferred');
  const tts = preferred.find((item) => item.capability === 'tts');
  const head = preferred.find((item) => item.capability === 'talking_head');
  if (dhCapability.status === 'loading') return '正在检测已接入的真实能力…';
  const parts = [];
  parts.push(tts ? '声音合成 TTS 已接入（' + tts.providerKey + '）' : '声音合成 TTS 未接入');
  parts.push(head ? '数字人视频已接入（' + head.providerKey + '）' : '数字人视频未接入');
  const worker = dhCapability.worker;
  const workerText = !worker ? '云 GPU Worker 状态检测中' : worker.ok ? '云 GPU Worker 在线（' + (worker.gpu || 'GPU 已就绪') + '）' : '云 GPU Worker 当前离线，需先在算力平台开机';
  return parts.join('；') + '；' + workerText + '。';
}

/* S8-02~S8-04：第八阶段面板——批次结果逐条查看、人工验收、重试、导出内容包 */
async function dhLoadStage8() {
  const batchId = dhDraft.record?.createdBatchId || dhDraftForm.createdBatchId || '';
  if (!batchId) {
    dhStage8.data = { batchId: null, items: [], packages: [], note: '尚未创建批次：先在 P06 保存明细并创建批次' };
    dhStage8.status = 'ready';
    dhRender();
    return;
  }
  dhStage8.status = 'loading';
  dhRender();
  try {
    const results = await dhApi('/api/content/digital-human/results/items?batchId=' + encodeURIComponent(batchId));
    const packages = await dhApi('/api/content/digital-human/packages').catch(() => ({ packages: [] }));
    const usage = await dhApi('/api/content/digital-human/usage').catch(() => null);
    dhStage8.data = { batchId, batchStatus: results.batchStatus, items: results.items || [], packages: packages.packages || [], usage: usage?.summary || null };
    dhStage8.status = 'ready';
  } catch (error) {
    dhStage8.status = 'ready';
    dhStage8.data = { batchId, items: [], packages: [], note: error.message };
  }
  dhRender();
}

async function dhRunBatch() {
  const batchId = dhDraft.record?.createdBatchId;
  if (!batchId) { window.alert('尚未创建批次'); return; }
  if (!window.confirm('执行批次将调用真实连接器（云 GPU）逐条生成，确定开始？')) return;
  try {
    await dhApi('/api/content/batches/' + encodeURIComponent(batchId) + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await dhLoadStage8();
  } catch (error) {
    window.alert('执行失败：' + error.message);
  }
}

async function dhReviewItem(itemId, decision) {
  const batchId = dhStage8.data?.batchId;
  if (!batchId) return;
  const note = decision === 'changes_requested' ? (window.prompt('退回原因（会记录在验收记录里）') || '') : '';
  try {
    await dhApi('/api/content/batches/' + encodeURIComponent(batchId) + '/items/' + encodeURIComponent(itemId) + '/review', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, note }),
    });
    await dhLoadStage8();
  } catch (error) {
    window.alert('验收失败：' + error.message);
  }
}

async function dhRetryItem(itemId) {
  const batchId = dhStage8.data?.batchId;
  if (!batchId) return;
  try {
    await dhApi('/api/content/batches/' + encodeURIComponent(batchId) + '/items/' + encodeURIComponent(itemId) + '/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await dhLoadStage8();
  } catch (error) {
    window.alert('重试失败：' + error.message);
  }
}

async function dhExportPackage() {
  const batchId = dhStage8.data?.batchId;
  if (!batchId) return;
  try {
    const payload = await dhApi('/api/content/digital-human/package', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ batchId }) });
    window.alert('内容包已生成：' + payload.dir + '（' + payload.package.includedCount + ' 条，未通过 ' + payload.package.blockedCount + ' 条）');
    await dhLoadStage8();
  } catch (error) {
    window.alert('导出失败：' + error.message);
  }
}

function dhRenderStage8() {
  const data = dhStage8.data;
  if (!data) {
    return '<section class="dh-block"><h3>第八阶段：结果、验收与内容包</h3><p class="dh-muted">尚未加载。</p>' +
      '<button class="button button-dark button-small" type="button" data-dh-stage8-load>加载结果</button></section>';
  }
  const items = data.items || [];
  return '<section class="dh-block"><h3>第八阶段：结果、验收与内容包</h3>' +
    (data.note ? '<p class="dh-muted">' + dhEscape(data.note) + '</p>' : '') +
    '<div class="dh-stage8-actions">' +
    '<button class="button button-dark button-small" type="button" data-dh-stage8-load>刷新结果</button>' +
    '<button class="button button-small" type="button" data-dh-stage8-run>执行批次（真实）</button>' +
    '<button class="button button-small" type="button" data-dh-stage8-package>导出内容包</button>' +
    '</div>' +
    (items.length ? '<ul class="dh-stage8-list">' + items.map((item) => {
      const output = item.output || {};
      const state = item.review?.decision ? ('已验收：' + item.review.decision) : (output.simulated ? '模拟输出（不可通过）' : (output.playable ? '待人工验收' : '无可用成片'));
      return '<li class="dh-stage8-row"><code>' + dhEscape(item.itemId) + '</code>' +
        '<span>状态 ' + dhEscape(item.status) + ' · 第 ' + dhEscape(String(item.attempt || 0)) + ' 次 · ' + dhEscape(state) + '</span>' +
        (output.videoRef ? '<span class="dh-muted">' + dhEscape(output.videoRef) + '</span>' : '<span class="dh-muted">' + dhEscape(item.failure ? (item.failure.message || JSON.stringify(item.failure)) : '尚无产出') + '</span>') +
        '<span class="dh-stage8-buttons">' +
        '<button class="button-link" type="button" data-dh-stage8-approve="' + dhEscape(item.itemId) + '">通过</button>' +
        '<button class="button-link" type="button" data-dh-stage8-reject="' + dhEscape(item.itemId) + '">退回</button>' +
        '<button class="button-link" type="button" data-dh-stage8-retry="' + dhEscape(item.itemId) + '">重试</button>' +
        '</span></li>';
    }).join('') + '</ul>' : '<p class="dh-muted">该批次没有条目。</p>') +
    (data.usage ? '<p class="dh-muted">用量：条目 ' + Number(data.usage.itemCount || 0) + ' · 真实文件 ' + Number(data.usage.realFiles || 0) + ' · 模拟 ' + Number(data.usage.simulated || 0) + ' · 已通过 ' + Number(data.usage.approved || 0) + ' · 最大尝试 ' + Number(data.usage.maxAttempts || 0) + ' 次</p>' : '') +
    '<p class="dh-muted">内容包：' + ((data.packages || []).length ? dhEscape((data.packages || []).map((item) => item.packageId + '(' + item.includedCount + '条)').join('、')) : '尚无') + '</p>' +
    '</section>';
}

const dhStage8 = { status: 'idle', data: null };


/** 明细列在所有行取值一致时返回该值，否则返回 null（不一致时不做草稿级锁定） */
function dhUniqueRowValue(field) {
  const values = (dhTaskRows || []).map((row) => (row[field] || '').trim()).filter(Boolean);
  if (!values.length) return null;
  return values.every((value) => value === values[0]) ? values[0] : null;
}

/** 一键按当前明细锁定资产：解决 HIDDEN_CARTESIAN_RISK（多资产 + 少量明细被判隐藏全组合） */
async function dhLockAssetsFromRows() {
  dhSyncTaskRowsFromDom();
  dhWorkspace.status = 'loading';
  dhRender();
  try {
    await dhApi(DH_DRAFT_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: dhDraft.record?.taskId || dhDraftForm.taskId,
        mode: dhDraftForm.mode,
        title: dhDraftForm.title,
        plannedItems: dhTaskRows,
        selectedScriptVersionId: dhUniqueRowValue('scriptVersionId') || undefined,
        selectedAvatarVersionId: dhUniqueRowValue('avatarVersionId') || undefined,
        selectedVoiceVersionId: dhUniqueRowValue('voiceVersionId') || undefined,
        selectedTemplateVersionId: dhUniqueRowValue('templateVersionId') || undefined,
      }),
    });
    const refreshed = await dhApi(dhScopedEndpoint(DH_WORKSPACE_ENDPOINT));
    dhWorkspace.data = refreshed.workspace || null;
    dhWorkspace.status = 'ready';
    dhWorkspace.error = null;
  } catch (error) {
    dhWorkspace.status = 'error';
    dhWorkspace.error = { message: '锁定资产失败：' + error.message };
  }
  dhRender();
}


/* 创建生产批次（不执行）：N15 显式明细 → 批次，随后在 P07 启动真实生成 */
let dhBatchBusy = false;
let dhBatchMessage = null;

async function dhCreateProductionBatch() {
  const taskId = dhDraft.record?.taskId || dhDraftForm.taskId;
  if (!taskId) { dhBatchMessage = '请先在 P01 选择关联的内容任务。'; dhRender(); return; }
  dhBatchBusy = true;
  dhBatchMessage = '正在创建批次…';
  dhRender();
  try {
    const payload = await dhApi(DH_BATCH_CREATE_ENDPOINT, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId }),
    });
    dhBatchBusy = false;
    dhBatchMessage = '批次已创建：' + payload.batch.id + '（连接器 ' + payload.batch.connectorId + '）。到 P07 结果页点「执行批次（真实）」即可生成。';
    dhDraft.record = { ...(dhDraft.record || {}), createdBatchId: payload.batch.id };
  } catch (error) {
    dhBatchBusy = false;
    dhBatchMessage = '创建批次失败：' + (error.message || '未知错误');
  }
  dhRender();
}

async function dhSaveTaskRows() {
  if (!dhDraftForm.taskId && !dhDraft.record?.taskId) {
    dhWorkspace.error = { message: '请先在 P01 选择关联的内容任务。' };
    dhRender();
    return;
  }
  dhSyncTaskRowsFromDom();
  dhWorkspace.status = 'loading';
  dhRender();
  try {
    const payload = await dhApi(DH_DRAFT_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: dhDraft.record?.taskId || dhDraftForm.taskId,
        mode: dhDraftForm.mode,
        title: dhDraftForm.title,
        plannedItems: dhTaskRows,
        selectedScriptVersionId: dhUniqueRowValue('scriptVersionId') || dhCopy.data?.selectedScriptVersionId || undefined,
        /* 草稿级锁定：明细里所有行一致时同步选择，避免「N 个可用资产 × 1 行」被判定为隐藏全组合（N15） */
        selectedAvatarVersionId: dhUniqueRowValue('avatarVersionId') || undefined,
        selectedVoiceVersionId: dhUniqueRowValue('voiceVersionId') || undefined,
        selectedTemplateVersionId: dhUniqueRowValue('templateVersionId') || undefined,
      }),
    });
    dhDraft.record = payload.draft || null;
    dhDraft.status = 'ready';
    dhSyncRowsFromDraft(dhDraft.record);
    const refreshed = await dhApi(dhScopedEndpoint(DH_WORKSPACE_ENDPOINT));
    dhWorkspace.data = refreshed.workspace || null;
    dhWorkspace.status = 'ready';
    dhWorkspace.error = null;
  } catch (error) {
    dhWorkspace.status = 'error';
    dhWorkspace.error = { message: '明细保存失败：' + error.message };
  }
  dhRender();
}


async function dhLoadContexts() {
  dhContexts.status = 'loading';
  dhContexts.error = null;
  dhRender();
  try {
    const payload = await dhApi(dhScopedEndpoint(DH_CONTEXTS_ENDPOINT));
    dhContexts.data = payload.stage || null;
    dhContexts.status = 'ready';
    if (!dhContexts.requestHydrated) {
      const request = dhContexts.data?.request;
      if (request) {
        dhCopyRequestForm.count = request.count || dhCopyRequestForm.count;
        dhCopyRequestForm.direction = request.direction || '';
        dhCopyRequestForm.platform = request.platform || '抖音';
        dhCopyRequestForm.durationSeconds = request.durationSeconds || dhCopyRequestForm.durationSeconds;
      }
      dhContexts.requestHydrated = true;
    }
    if (dhContexts.data?.selectedContextId) {
      dhDraftForm.selectedContextId = dhContexts.data.selectedContextId;
    }
  } catch (error) {
    dhContexts.data = null;
    dhContexts.status = 'error';
    dhContexts.error = { message: error.message };
  }
  dhRender();
}

async function dhSaveContext(asEdit) {
  if (!dhContextForm.name.trim()) {
    dhContexts.status = 'error';
    dhContexts.error = { message: '项目档案名称不能为空。' };
    dhRender();
    return;
  }
  dhContexts.status = 'loading';
  dhRender();
  try {
    const payload = await dhApi(DH_CONTEXTS_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: dhReal.summary?.project?.id || undefined,
        contextKey: asEdit ? dhContextForm.contextKey : undefined,
        name: dhContextForm.name,
        industry: dhContextForm.industry,
        product: dhContextForm.product,
        audience: dhContextForm.audience,
        sellingPoints: dhContextForm.sellingPoints.split(/[；;\n]/).map((point) => point.trim()).filter(Boolean),
        contentGoal: dhContextForm.contentGoal,
      }),
    });
    if (payload.context) {
      await dhApi(DH_DRAFT_ENDPOINT, { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: dhDraft.record?.taskId || dhDraftForm.taskId, selectedContextId: payload.context.id }) });
      dhDraftForm.selectedContextId = payload.context.id;
    }
    dhContextForm.contextKey = '';
    dhContextForm.name = '';
    dhContextForm.industry = '';
    dhContextForm.product = '';
    dhContextForm.audience = '';
    dhContextForm.sellingPoints = '';
    dhContextForm.contentGoal = '';
    await dhLoadContexts();
  } catch (error) {
    dhContexts.status = 'error';
    dhContexts.error = { message: '项目上下文保存失败：' + error.message };
  }
  dhRender();
}

async function dhSwitchContext(contextId) {
  const currentId = dhContexts.data?.selectedContextId || null;
  if (!contextId) {
    dhNoticeSet('先在档案下拉中选择一个项目档案。');
    return;
  }
  if (contextId === currentId) {
    dhNoticeSet('当前生产草稿已经使用这个项目档案。');
    return;
  }
  try {
    await dhApi(DH_DRAFT_ENDPOINT, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: dhDraft.record?.taskId || dhDraftForm.taskId, selectedContextId: contextId }) });
    dhState.contextPick = null;
    /* 文案需求与候选都挂在项目档案下，切换后一并重读，主页不会停在旧准备度。 */
    await Promise.all([dhLoadContexts(), dhLoadCopy()]);
    const picked = (dhContexts.data?.versions || []).find((item) => item.id === contextId);
    dhNoticeSet(picked ? '当前项目档案已切为「' + picked.name + ' · v' + picked.version + '」，刷新后仍保留。' : '已切换项目档案，刷新后仍保留。');
  } catch (error) {
    dhNoticeSet('切换失败：' + error.message);
    await dhLoadContexts();
  }
  dhRender();
}

/* 保留原有入口：从档案列表里直接选入生产草稿。 */
async function dhSelectContext(contextId) {
  await dhSwitchContext(contextId);
}

async function dhSaveCopyRequest() {
  dhContexts.status = 'loading';
  dhRender();
  try {
    await dhApi(DH_COPY_REQUEST_ENDPOINT, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: dhReal.summary?.project?.id || undefined,
        contextId: dhDraftForm.selectedContextId || undefined,
        count: Number(dhCopyRequestForm.count) || undefined,
        direction: dhCopyRequestForm.direction,
        platform: dhCopyRequestForm.platform,
        durationSeconds: Number(dhCopyRequestForm.durationSeconds) || undefined,
      }) });
    dhNoticeSet('文案生成需求已保存。');
    await dhLoadContexts();
  } catch (error) {
    dhContexts.status = 'error';
    dhContexts.error = { message: '需求保存失败：' + error.message };
  }
  dhRender();
}

async function dhLoadResults() {
  dhResults.status = 'loading';
  dhRender();
  try {
    const payload = await dhApi(dhScopedEndpoint(DH_RESULTS_ENDPOINT));
    dhResults.data = payload.board || null;
    dhResults.status = 'ready';
  } catch (error) {
    dhResults.data = null;
    dhResults.status = 'error';
    dhResults.error = { message: error.message };
  }
  dhRender();
}

async function dhLoadPackage() {
  dhPackage.status = 'loading';
  dhRender();
  try {
    const payload = await dhApi(dhScopedEndpoint(DH_PACKAGE_ENDPOINT));
    dhPackage.data = payload.package || null;
    dhPackage.status = 'ready';
  } catch (error) {
    dhPackage.data = null;
    dhPackage.status = 'error';
    dhPackage.error = { message: error.message };
  }
  dhRender();
}

async function dhBatchAction(batchId, action, body = {}) {
  try {
    await dhApi(DH_BATCH_ACTIONS_BASE + encodeURIComponent(batchId) + '/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    dhNoticeSet('批次操作完成：' + action);
  } catch (error) {
    dhNoticeSet('批次操作失败：' + error.message);
  }
  await dhLoadResults();
}

async function dhItemReview(batchId, itemId, decision, note) {
  try {
    const payload = await dhApi(DH_BATCH_ACTIONS_BASE + encodeURIComponent(batchId) + '/items/' + encodeURIComponent(itemId) + '/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, note }),
    });
    dhNoticeSet(decision === 'approved' ? '已通过人工验收。' : decision === 'changes_requested' ? '已退回修改。' : '已驳回。');
    if (payload.batch) {
      dhResults.data = null;
    }
  } catch (error) {
    dhNoticeSet('审核失败：' + error.message);
  }
  await dhLoadResults();
}

async function dhBatchExport(batchId) {
  try {
    const payload = await dhApi(DH_BATCH_ACTIONS_BASE + encodeURIComponent(batchId) + '/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    dhNoticeSet('内容包导出完成：' + (payload.export?.status || 'done'));
  } catch (error) {
    dhNoticeSet('导出被拒绝：' + error.message);
  }
  await dhLoadPackage();
}

function dhNoticeSet(message) {
  dhState.notice = { title: message, detail: '操作走的是真实批次接口；模拟输出不能审核通过或导出。' };
}

async function dhCreateBatch() {
  if (!dhDraft.record?.taskId && !dhDraftForm.taskId) {
    dhPreflight.error = '请先在 P01 选择关联的内容任务。';
    dhRender();
    return;
  }
  dhPreflight.running = true;
  dhPreflight.error = null;
  dhRender();
  try {
    const payload = await dhApi(DH_BATCH_CREATE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: dhDraft.record?.taskId || dhDraftForm.taskId }),
    });
    dhPreflight.running = false;
    dhPreflight.createdBatch = payload.batch || null;
    dhPreflight.createdNote = payload.note || '';
    await dhLoadDraft();
  } catch (error) {
    dhPreflight.running = false;
    dhPreflight.error = '创建批次失败：' + error.message;
  }
  dhRender();
}

async function dhRunPreflight() {
  if (!dhDraft.record?.taskId && !dhDraftForm.taskId) {
    dhPreflight.error = '请先在 P01 选择关联的内容任务。';
    dhRender();
    return;
  }
  dhSyncTaskRowsFromDom();
  dhPreflight.running = true;
  dhPreflight.error = null;
  dhRender();
  try {
    const payload = await dhApi(DH_PREFLIGHT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: dhDraft.record?.taskId || dhDraftForm.taskId,
        plannedItems: dhTaskRows,
      }),
    });
    dhPreflight.gate = payload.gate || null;
    dhPreflight.running = false;
    const refreshed = await dhApi(dhScopedEndpoint(DH_WORKSPACE_ENDPOINT));
    dhWorkspace.data = refreshed.workspace || null;
    dhWorkspace.status = 'ready';
  } catch (error) {
    dhPreflight.running = false;
    dhPreflight.error = error.message;
  }
  dhRender();
}

/* ---------------------------------------------------------------------------
   F5-04：生产资产（P03 形象/声音、P04 已有视频、P05 模板）
   --------------------------------------------------------------------------- */

async function dhLoadAssets() {
  dhAssets.status = 'loading';
  dhAssets.error = null;
  dhRender();
  try {
    const payload = await dhApi(dhScopedEndpoint(DH_ASSETS_ENDPOINT));
    dhAssets.data = payload.assets || null;
    dhAssets.status = 'ready';
    const draft = dhDraft.record;
    if (draft) {
      dhAssets.data.selected = {
        ...dhAssets.data.selected,
        avatarVersionId: draft.selectedAvatarVersionId || null,
        voiceVersionId: draft.selectedVoiceVersionId || null,
        templateVersionId: draft.selectedTemplateVersionId || null,
      };
    }
  } catch (error) {
    dhAssets.data = null;
    dhAssets.status = 'error';
    dhAssets.error = { message: error.message, httpStatus: error.httpStatus || null };
  }
  dhRender();
}

async function dhSelectAsset(kind, versionId) {
  if (!dhDraftForm.taskId) {
    dhDraft.saveState = 'error';
    dhDraft.saveMessage = '请先在 P01 选择关联的内容任务，资产选择必须挂在真实草稿上。';
    dhRender();
    return;
  }
  const field = { avatar: 'selectedAvatarVersionId', voice: 'selectedVoiceVersionId', template: 'selectedTemplateVersionId' }[kind];
  if (!field) {
    return;
  }
  dhDraft.saveState = 'saving';
  dhDraft.saveMessage = null;
  dhRender();
  try {
    const payload = await dhApi(DH_DRAFT_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: dhDraftForm.taskId,
        mode: dhDraftForm.mode,
        title: dhDraftForm.title,
        note: dhDraftForm.note,
        plannedItemCount: Number(dhDraftForm.plannedItemCount) || 1,
        selectedScriptVersionId: dhCopy.data?.selectedScriptVersionId || dhDraft.record?.selectedScriptVersionId || undefined,
        [field]: versionId,
      }),
    });
    dhDraft.record = payload.draft || null;
    dhDraft.status = 'ready';
    dhDraft.saveState = 'saved';
    dhDraft.saveMessage = '资产选择已写入生产草稿（' + field + '），刷新后仍然保留。';
    if (dhAssets.status === 'ready') {
      const refreshed = await dhApi(dhScopedEndpoint(DH_ASSETS_ENDPOINT));
      dhAssets.data = refreshed.assets || null;
    }
  } catch (error) {
    dhDraft.saveState = 'error';
    dhDraft.saveMessage = '资产选择保存失败：' + error.message;
  }
  dhRender();
}

/* ---------------------------------------------------------------------------
   渲染：状态徽标（文字 + 颜色，不使用只有颜色的表达）
   --------------------------------------------------------------------------- */

function dhBadgeMeta(meta) {
  return meta || { label: '未知状态', tone: 'draft' };
}

function dhStatusBadge(meta, extraClass = '') {
  const resolved = dhBadgeMeta(meta);
  return (
    '<span class="dh-badge dh-badge-' +
    dhEscape(resolved.tone) +
    (extraClass ? ' ' + extraClass : '') +
    '">' +
    dhEscape(resolved.label) +
    '</span>'
  );
}

function dhItemCountText(task) {
  const count = task.items.length;
  return count === 1 ? '1 条明细 · 即单条生产' : count + ' 条明细 · 批量生产';
}

/* ---------------------------------------------------------------------------
   F5-C2：入口卡不再由本模块注入 #view-content。

   内容编辑云员工已改为父级入口页（content-workspace.js），由它提供唯一入口卡；
   本模块若继续 prepend，会出现两张重复入口卡。
   这里只保留 dhInit 中挂在 #view-content 上的 [data-dh-open] 事件委托，
   用于响应父级页上的「进入生产中心」按钮，模块内部仍保留自己的 P01 入口与流程导航。
   --------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   渲染：P01 生产中心
   --------------------------------------------------------------------------- */

function dhSummaryCards(scenario) {
  const tasks = scenario.tasks;
  const cards = [
    { key: 'pending_config', label: '待配置', value: dhCountItems(tasks, ['planned', 'queued']), tone: 'draft', hint: '明细还没补齐' },
    { key: 'generating', label: '生成中', value: dhCountItems(tasks, ['generating']), tone: 'running', hint: '等待生成完成' },
    { key: 'review', label: '待人工验收', value: dhCountItems(tasks, ['waiting_review']), tone: 'review', hint: '需要人工判断' },
    { key: 'failed', label: '需修改', value: dhCountItems(tasks, ['failed']), tone: 'failed', hint: '失败明细待重试' },
    { key: 'exportable', label: '可导出', value: dhCountTasks(tasks, ['completed']), tone: 'done', hint: '已完成的任务' },
  ];
  return (
    '<div class="dh-summary" aria-label="当前待处理摘要">' +
    cards
      .map(
        (card) =>
          '<article class="dh-summary-card dh-tone-' +
          card.tone +
          '">' +
          '<span class="dh-summary-value">' +
          card.value +
          '</span>' +
          '<strong class="dh-summary-label">' +
          dhEscape(card.label) +
          '</strong>' +
          '<small class="dh-summary-hint">' +
          dhEscape(card.hint) +
          '</small>' +
          '</article>',
      )
      .join('') +
    '</div>'
  );
}

function dhNoticeBlock() {
  if (!dhState.notice) {
    return '';
  }
  return (
    '<div class="dh-notice" role="status" aria-live="polite">' +
    '<span class="dh-notice-icon" aria-hidden="true">!</span>' +
    '<div class="dh-notice-body"><strong>' +
    dhEscape(dhState.notice.title) +
    '</strong><p>' +
    dhEscape(dhState.notice.detail) +
    '</p><small>现在不会产生任何真实视频文件。</small></div>' +
    '<button class="button button-secondary button-small" type="button" data-dh-notice-close>关闭提示</button>' +
    '</div>'
  );
}

function dhContinueCard(scenario) {
  const task = scenario.tasks.find((item) => item.status !== 'completed');
  if (!task) {
    return '';
  }
  const meta = DH_TASK_STATUS[task.status];
  const done = task.items.filter((item) => item.status === 'approved').length;
  return (
    '<section class="panel dh-continue" aria-label="继续处理">' +
    '<div class="dh-continue-head">' +
    '<div><div class="eyebrow">继续处理</div><h2>' +
    dhEscape(task.name) +
    '</h2></div>' +
    dhStatusBadge(meta) +
    '</div>' +
    '<p class="dh-continue-line">任务 ' +
    dhEscape(task.id) +
    ' · 项目 ' +
    dhEscape(task.project) +
    ' · ' +
    dhEscape(DH_MODE[task.mode].label) +
    ' · ' +
    dhEscape(dhItemCountText(task)) +
    '</p>' +
    '<div class="dh-continue-foot">' +
    '<span class="dh-progress" aria-hidden="true"><i style="width:' +
    Math.round((done / Math.max(task.items.length, 1)) * 100) +
    '%"></i></span>' +
    '<small>已通过 ' +
    done +
    ' / ' +
    task.items.length +
    ' 条 · 下一步：' +
    dhEscape(task.nextAction) +
    '</small>' +
    '</div>' +
    '<div class="dh-continue-actions">' +
    '<button class="button button-dark button-small" type="button" data-dh-task="' +
    dhEscape(task.id) +
    '">继续处理</button>' +
    '<button class="button button-secondary button-small" type="button" data-dh-task="' +
    dhEscape(task.id) +
    '">查看详情</button>' +
    '</div>' +
    '</section>'
  );
}

function dhModeCards() {
  return (
    '<section class="panel dh-modes" aria-label="后续支持的生产模式">' +
    '<div class="panel-heading"><div><div class="eyebrow">后续支持的生产模式</div>' +
    '<h2>模式 A / 模式 B</h2><p>两种模式共用同一套生产任务和明细规则，区别只在人物视觉输入的来源。</p></div>' +
    '<span class="phase-label">待接入</span></div>' +
    '<div class="dh-mode-grid">' +
    Object.entries(DH_MODE)
      .map(
        ([key, item]) =>
          '<article class="dh-mode-card"><span class="dh-mode-key">' +
          dhEscape(key) +
          '</span><div><strong>' +
          dhEscape(item.full) +
          '</strong><p>' +
          dhEscape(item.detail) +
          '</p></div></article>',
      )
      .join('') +
    '</div>' +
    '<p class="dh-mode-note">无论模式 A 还是模式 B，都是一条明细对应一个输出。数量为 1 就是单条生产，不需要额外选择“单条模式”。</p>' +
    '</section>'
  );
}

function dhStartCards() {
  const steps = [
    { index: '01', title: '项目与文案', detail: '选择行业/项目上下文，确认可以进入生产的文案。', tone: 'indigo', page: DH_PAGE_P02, ready: true },
    { index: '02', title: '数字人资产', detail: '选择已启用的数字人形象和对应声音版本。', tone: 'amber', page: DH_PAGE_ASSETS, ready: true },
    { index: '03', title: '视频与场景模板', detail: '模式 B 导入已有视频并校对映射，选择场景模板。', tone: 'mint', page: DH_PAGE_ASSETS, ready: true },
    { index: '04', title: '内容包', detail: '只把已通过人工验收的结果打包导出。', tone: 'slate' },
  ];
  return (
    '<section class="dh-start" aria-label="开始新的生产流程">' +
    '<div class="dh-start-head"><div><div class="eyebrow">开始新的生产流程</div>' +
    '<h2>生产前的四步准备</h2><p>已实现的步骤可以直接进入；还没实现的点击只会看到明确的“待实现”说明，不会伪造可用控制。</p></div></div>' +
    '<div class="dh-start-grid">' +
    steps
      .map((step) => {
        const inner =
          '<span class="dh-start-index">' + dhEscape(step.index) + '</span>' +
          '<strong>' + dhEscape(step.title) + '</strong>' +
          '<small>' + dhEscape(step.detail) + '</small>' +
          '<span class="dh-start-slice">' + (step.ready ? '已实现' : '待实现') + '</span>';
        if (step.page) {
          return '<button class="dh-start-card dh-tone-' + step.tone + '" type="button" data-dh-page="' + step.page + '">' + inner + '</button>';
        }
        return (
          '<button class="dh-start-card dh-tone-' + step.tone + '" type="button" data-dh-notice="' +
          dhEscape(step.title) + '">' + inner + '</button>'
        );
      })
      .join('') +
    '</div></section>'
  );
}

function dhFilterTabs(scenario) {
  const tasks = scenario.tasks;
  const tabs = [
    { id: 'all', label: '全部', count: tasks.length },
    { id: 'draft', label: '待配置', count: dhCountTasks(tasks, ['draft']) },
    { id: 'waiting_review', label: '待人工验收', count: dhCountTasks(tasks, ['waiting_review']) },
    { id: 'partial_failed', label: '部分失败', count: dhCountTasks(tasks, ['partial_failed']) },
    { id: 'completed', label: '已完成', count: dhCountTasks(tasks, ['completed']) },
  ];
  return (
    '<div class="dh-filters" role="tablist" aria-label="生产任务筛选">' +
    tabs
      .map(
        (tab) =>
          '<button class="dh-filter' +
          (dhState.filter === tab.id ? ' is-active' : '') +
          '" type="button" role="tab" aria-selected="' +
          String(dhState.filter === tab.id) +
          '" data-dh-filter="' +
          dhEscape(tab.id) +
          '">' +
          dhEscape(tab.label) +
          ' (' +
          tab.count +
          ')</button>',
      )
      .join('') +
    '</div>'
  );
}

function dhItemRow(item, mode) {
  const meta = DH_ITEM_STATUS[item.status] || DH_ITEM_STATUS.planned;
  return (
    '<li class="dh-item">' +
    '<span class="dh-item-index">#' +
    dhEscape(item.index) +
    '</span>' +
    '<span class="dh-item-cell"><small>数字人</small><strong>' +
    dhEscape(item.persona) +
    '</strong></span>' +
    '<span class="dh-item-cell"><small>文案</small><strong>' +
    dhEscape(item.script) +
    '</strong></span>' +
    '<span class="dh-item-cell"><small>' +
    (mode === 'B' ? '已有视频' : '场景模板') +
    '</small><strong>' +
    dhEscape(item.source) +
    '</strong></span>' +
    '<span class="dh-item-cell dh-item-status">' +
    dhStatusBadge(meta) +
    '<small>' +
    dhEscape(item.note) +
    '</small></span>' +
    '</li>'
  );
}

function dhTaskCard(task) {
  const meta = DH_TASK_STATUS[task.status];
  const done = task.items.filter((item) => item.status === 'approved').length;
  return (
    '<article class="panel dh-task dh-tone-' +
    meta.tone +
    '">' +
    '<header class="dh-task-head">' +
    '<div><h3>' +
    dhEscape(task.name) +
    '</h3><p>' +
    dhEscape(task.id) +
    ' · 项目 ' +
    dhEscape(task.project) +
    ' · ' +
    dhEscape(DH_MODE[task.mode].full) +
    '</p></div>' +
    '<div class="dh-task-badges">' +
    '<span class="dh-chip dh-chip-demo">演示数据</span>' +
    dhStatusBadge(meta) +
    '</div>' +
    '</header>' +
    '<dl class="dh-task-meta">' +
    '<div><dt>明细数量</dt><dd>' +
    dhEscape(dhItemCountText(task)) +
    '</dd></div>' +
    '<div><dt>已生成 / 已通过</dt><dd>' +
    task.items.filter((item) => item.status !== 'planned').length +
    ' / ' +
    done +
    ' 条</dd></div>' +
    '<div><dt>当前下一步</dt><dd>' +
    dhEscape(task.nextAction) +
    '</dd></div>' +
    '<div><dt>最近更新</dt><dd>' +
    dhEscape(task.updatedAt) +
    '</dd></div>' +
    '</dl>' +
    '<details class="dh-task-items">' +
    '<summary>展开 ' +
    task.items.length +
    ' 条生产明细（一条明细对应一个输出）</summary>' +
    '<ul>' +
    task.items.map((item) => dhItemRow(item, task.mode)).join('') +
    '</ul>' +
    '</details>' +
    '<footer class="dh-task-foot">' +
    '<button class="button button-dark button-small" type="button" data-dh-task="' +
    dhEscape(task.id) +
    '">' +
    dhEscape(task.nextAction) +
    '</button>' +
    '<button class="button button-secondary button-small" type="button" data-dh-task="' +
    dhEscape(task.id) +
    '">查看详情</button>' +
    '<button class="button button-secondary button-small dh-is-disabled" type="button" disabled aria-disabled="true" ' +
    'title="下载视频需要的能力还没接入，也不会生成真实视频文件">下载视频（未实现）</button>' +
    '</footer>' +
    '</article>'
  );
}

function dhTaskList(scenario) {
  if (!scenario.tasks.length) {
    return (
      '<div class="dh-empty" role="status">' +
      '<span aria-hidden="true">◌</span>' +
      '<strong>还没有任何生产任务</strong>' +
      '<p>生产中心会按“一条明细对应一个输出”的方式管理单条和批量任务。先准备项目与文案、数字人资产和场景模板，再创建第一个生产任务。</p>' +
      '<button class="button button-dark button-small" type="button" data-dh-notice="新建生产任务">' +
      '新建生产任务（待实现）</button>' +
      '</div>'
    );
  }
  const visible =
    dhState.filter === 'all'
      ? scenario.tasks
      : scenario.tasks.filter((task) => task.status === dhState.filter);
  if (!visible.length) {
    return (
      '<div class="dh-empty dh-empty-filter" role="status">' +
      '<span aria-hidden="true">◌</span>' +
      '<strong>当前筛选下没有任务</strong>' +
      '<p>换一个筛选条件，或切换到“全部”查看当前演示场景里的任务。</p>' +
      '</div>'
    );
  }
  return '<div class="dh-task-list">' + visible.map(dhTaskCard).join('') + '</div>';
}

/* ---------------------------------------------------------------------------
   F5-02：真实数据的展示映射
   判定权威在服务端（src/digital-human-projection.mjs），页面只负责把
   服务端已经算好的 generationStatus / reviewStatus / deliveryStatus /
   allowedActions / blockingIssues / nextAction 显示出来，不自己猜状态。
   --------------------------------------------------------------------------- */

const DH_AXIS_LABELS = {
  generation: {
    planned: { label: '待生成', tone: 'draft' },
    queued: { label: '已排队', tone: 'draft' },
    running: { label: '生成中', tone: 'running' },
    succeeded: { label: '已生成', tone: 'done' },
    failed: { label: '生成失败', tone: 'failed' },
    blocked: { label: '生成阻塞', tone: 'failed' },
    cancelled: { label: '已取消', tone: 'draft' },
  },
  review: {
    not_ready: { label: '暂无可验收结果', tone: 'draft' },
    waiting_review: { label: '待人工验收', tone: 'review' },
    approved: { label: '人工已通过', tone: 'done' },
    changes_requested: { label: '需修改', tone: 'failed' },
    rejected: { label: '已驳回', tone: 'failed' },
  },
  delivery: {
    not_selected: { label: '未选择交付', tone: 'draft' },
    selected: { label: '已选择交付', tone: 'review' },
    exporting: { label: '导出中', tone: 'running' },
    exported: { label: '已导出', tone: 'done' },
    export_failed: { label: '导出失败', tone: 'failed' },
  },
};

const DH_EXECUTION_LABELS = {
  not_started: { label: '未开始', tone: 'draft' },
  queued: { label: '已排队', tone: 'draft' },
  running: { label: '执行中', tone: 'running' },
  paused: { label: '已暂停', tone: 'review' },
  completed_with_results: { label: '已有结果', tone: 'done' },
  failed: { label: '执行失败', tone: 'failed' },
  cancelled: { label: '已取消', tone: 'draft' },
};

const DH_REVIEW_SUMMARY_LABELS = {
  not_ready: '还没有可审核结果',
  waiting: '有结果待人工验收',
  partial: '部分通过、部分需修改',
  all_approved: '全部已通过人工验收',
  has_rejected: '存在已驳回明细',
};

const DH_ACTION_LABELS = {
  create_context: { label: '创建项目档案' },
  select_context: { label: '选择本次生产使用的项目档案' },
  configure_copy_request: { label: '设置文案生成需求' },
  configure_items: { label: '继续配置明细' },
  fix_blockers: { label: '修复阻塞项' },
  retry_item: { label: '重试本条' },
  regenerate_item: { label: '修改输入后重新生成' },
  review_item: { label: '进行人工验收' },
  request_changes: { label: '退回修改' },
  select_for_package: { label: '加入内容包' },
  export_approved: { label: '导出已通过结果' },
};

const DH_NEXT_ACTION_LABELS = {
  create_context: '先创建项目档案',
  select_context: '先选择项目档案',
  configure_copy_request: '先补齐文案生成需求',
  configure_items: '继续配置明细',
  fix_blockers: '修复阻塞项',
  retry_failed_items: '重试失败明细',
  review_pending_items: '进入人工验收',
  regenerate_items: '修改输入后重新生成',
  export_approved: '导出已通过结果',
  prepare_assets: '先准备可用的数字人、文案与模板资产',
  nothing_pending: '暂无待处理项',
};

const DH_GAP_LABELS = {
  NO_AVATAR_VERSION: '缺数字人形象版本',
  NO_VOICE_VERSION: '缺数字人声音版本',
  NO_SCRIPT_VERSION: '缺已确认文案版本',
  NO_TEMPLATE_VERSION: '缺场景模板',
  NO_READY_CONNECTOR: '缺具备口播能力的连接器',
  TASK_HAS_BLOCKED_ITEMS: '存在阻塞明细',
  TASK_HAS_RETRYABLE_ITEMS: '存在可重试失败明细',
};

function dhLabel(map, key, fallbackTone = 'draft') {
  return map[key] || { label: key || '未知状态', tone: fallbackTone };
}

function dhAxisBadge(axis, status) {
  return dhStatusBadge(dhLabel(DH_AXIS_LABELS[axis] || {}, status), 'dh-axis-badge');
}

function dhNextActionText(code) {
  return DH_NEXT_ACTION_LABELS[code] || code || '暂无待处理项';
}

/* 服务端阻塞原因里带的内部编号（如「（N02）」）属于开发坐标，
   面向用户只保留真实原因本身；只删后缀编号，不改写阻塞结论。 */
function dhUserFacingReason(text) {
  return String(text || '').replace(/\s*[（(](?:N|F5|S\d)[A-Za-z0-9-]*[）)]/g, '').trim();
}

function dhFormatTime(value) {
  if (!value) {
    return '—';
  }
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? '—'
    : time.toLocaleString('zh-CN', { hour12: false });
}

/* 真实数据横幅：明确本页数字来自后端真实接口，而不是页面示例。 */
function dhRealBanner() {
  return (
    '<div class="dh-real-banner" role="note">' +
    '<strong>真实数据</strong>' +
    '<span>当前显示的数字来自后端真实接口（生产批次、内容任务、资产目录）。' +
    dhEscape(dhCapabilitySentence()) + '</span>' +
    '</div>'
  );
}

function dhSourceBar() {
  const summary = dhReal.summary;
  const source = summary?.source || {};
  const readAt = source.readAt || null;
  return (
    '<section class="dh-source" aria-label="数据来源">' +
    '<div class="dh-source-head">' +
    '<div><span class="dh-source-tag">数据源</span>' +
    '<strong>本页数字可直接反查到下面三个真实接口</strong></div>' +
    '<button class="button button-secondary button-small" type="button" data-dh-refresh' +
    (dhReal.status === 'loading' ? ' disabled aria-disabled="true"' : '') +
    '>' +
    (dhReal.status === 'loading' ? '正在重新读取…' : '重新读取真实数据') +
    '</button>' +
    '</div>' +
    '<dl class="dh-source-list">' +
    (source.endpoints || [DH_SUMMARY_ENDPOINT])
      .map((endpoint) => '<div><dt>接口</dt><dd><code>' + dhEscape(endpoint) + '</code></dd></div>')
      .join('') +
    '<div><dt>读取时间</dt><dd>' + dhEscape(dhFormatTime(readAt)) + '</dd></div>' +
    '<div><dt>生产批次</dt><dd>' + Number(source.batchCount || 0) + ' 条</dd></div>' +
    '<div><dt>内容任务</dt><dd>' + Number(source.contentTaskCount || 0) + ' 条</dd></div>' +
    '</dl>' +
    '</section>'
  );
}

/* 摘要卡：全部取自服务端 counts（有事实才显示数字，缺数据就是 0）。 */
function dhRealSummaryCards() {
  const counts = dhReal.summary?.counts || {};
  const cards = [
    { label: '待配置', value: counts.pendingConfigure || 0, tone: 'draft', hint: '明细还没补齐' },
    { label: '生成中', value: counts.generating || 0, tone: 'running', hint: '排队或正在生成' },
    { label: '待人工验收', value: counts.waitingReview || 0, tone: 'review', hint: '需要人工判断' },
    { label: '需修改', value: (counts.needsChanges || 0) + (counts.failedRetryable || 0), tone: 'failed', hint: '需修改或可重试失败' },
    { label: '可导出', value: counts.approvedExportable || 0, tone: 'done', hint: '已通过人工验收' },
  ];
  return (
    '<div class="dh-summary" aria-label="真实数据摘要">' +
    cards
      .map(
        (card) =>
          '<article class="dh-summary-card dh-tone-' + card.tone + '">' +
          '<span class="dh-summary-value">' + card.value + '</span>' +
          '<strong class="dh-summary-label">' + dhEscape(card.label) + '</strong>' +
          '<small class="dh-summary-hint">' + dhEscape(card.hint) + '</small>' +
          '</article>',
      )
      .join('') +
    '</div>'
  );
}

/* 资产就绪度：直接读 catalog 的真实计数，不推断。 */
function dhAssetReadiness() {
  const assets = dhReal.summary?.assets || {};
  const rows = [
    { key: 'avatars', label: '数字人形象版本' },
    { key: 'voices', label: '数字人声音版本' },
    { key: 'scripts', label: '已确认文案版本' },
    { key: 'templates', label: '场景模板' },
    { key: 'connectors', label: '生产连接器（含口播能力：' + Number(assets.productionReadyConnectors || 0) + '）' },
  ];
  return (
    '<section class="panel dh-ready" aria-label="资产就绪度">' +
    '<div class="panel-heading"><div><div class="eyebrow">资产就绪度</div>' +
    '<h2>生产前还缺什么</h2>' +
    '<p>这些数字直接来自资产目录接口，不是页面推断。缺项可以在生产资产页补齐。</p></div></div>' +
    '<ul class="dh-ready-list">' +
    rows
      .map((row) => {
        const value = Number(assets[row.key] || 0);
        return (
          '<li class="dh-ready-row' + (value ? ' is-ok' : ' is-gap') + '">' +
          '<span class="dh-ready-mark" aria-hidden="true">' + (value ? '✓' : '!') + '</span>' +
          '<span class="dh-ready-label">' + dhEscape(row.label) + '</span>' +
          '<strong class="dh-ready-value">' + value + '</strong>' +
          '<small>' + (value ? '可用' : '缺失') + '</small>' +
          '</li>'
        );
      })
      .join('') +
    '</ul>' +
    '</section>'
  );
}

/* 状态闸门：blocking_issues + allowed_actions + next_action（7.1 / 10.1）。 */
function dhGateBlock() {
  const summary = dhReal.summary || {};
  const issues = Array.isArray(summary.blockingIssues) ? summary.blockingIssues : [];
  const actions = Array.isArray(summary.allowedActions) ? summary.allowedActions : [];
  const nextAction = summary.nextAction || 'nothing_pending';
  return (
    '<section class="panel dh-gate" aria-label="进入生产的条件">' +
    '<div class="panel-heading"><div><div class="eyebrow">进入生产的条件</div>' +
    '<h2>阻塞项与下一步</h2>' +
    '<p>下一步来自服务端的判定结果，页面不根据按钮是否报错猜测状态。' +
    '本页只做数据读取与任务草稿，没接入的动作会直接标成未接入。</p></div>' +
    '<span class="phase-label">下一步：' + dhEscape(dhNextActionText(nextAction)) + '</span></div>' +
    '<div class="dh-gate-grid">' +
    '<div class="dh-gate-col">' +
    '<h3>阻塞项（' + issues.length + '）</h3>' +
    (issues.length
      ? '<ul class="dh-gate-issues">' +
        issues
          .map(
            (item) =>
              '<li><code>' + dhEscape(item.code) + '</code>' +
              '<span>' + dhEscape(dhUserFacingReason(DH_GAP_LABELS[item.code] || item.message || '')) + '</span>' +
              (item.field ? '<small>字段：' + dhEscape(item.field) + '</small>' : '') +
              '</li>',
          )
          .join('') +
        '</ul>'
      : '<p class="dh-gate-empty">当前没有阻塞项。</p>') +
    '</div>' +
    '<div class="dh-gate-col">' +
    '<h3>现在可以做的事（' + actions.length + '）</h3>' +
    (actions.length
      ? '<div class="dh-gate-actions">' +
        actions
          .map((action) => {
            const meta = DH_ACTION_LABELS[action] || { label: action };
            return (
              '<button class="button button-secondary button-small dh-is-disabled" type="button"' +
              ' disabled aria-disabled="true"' +
              ' title="' + dhEscape(meta.label + '需要的能力尚未接入，本阶段只做数据读取与草稿，不做假提交') + '">' +
              dhEscape(meta.label) + '<small>（未接入）</small></button>'
            );
          })
          .join('') +
        '</div>' +
        '<p class="dh-gate-note">未实现的动作以 disabled 显示，不会出现点了没反应的假按钮。</p>'
      : '<p class="dh-gate-empty">当前没有可执行动作。</p>') +
    '</div>' +
    '</div>' +
    '<p class="dh-axis-note">交付轴（未选择 / 已选择 / 已导出）在现有数据里还没有事实来源，' +
    '因此明细统一显示“未选择交付”，接入点在后一阶段的内容包导出。</p>' +
    '</section>'
  );
}

/* 真实批次卡：每条明细分开显示生成 / 审核 / 交付三轴。 */
function dhRealItemRow(item) {
  return (
    '<li class="dh-item dh-item-real">' +
    '<span class="dh-item-index">#' + dhEscape(item.rowNo ?? '—') + '</span>' +
    '<span class="dh-item-cell"><small>生成轴</small>' + dhAxisBadge('generation', item.generationStatus) +
    (item.attempt ? '<small>第 ' + item.attempt + ' 次尝试</small>' : '') + '</span>' +
    '<span class="dh-item-cell"><small>审核轴</small>' + dhAxisBadge('review', item.reviewStatus) + '</span>' +
    '<span class="dh-item-cell"><small>交付轴</small>' + dhAxisBadge('delivery', item.deliveryStatus) + '</span>' +
    '<span class="dh-item-cell dh-item-actions">' +
    (item.allowedActions.length
      ? item.allowedActions
          .map((action) => {
            const meta = DH_ACTION_LABELS[action] || { label: action };
            return '<button class="button button-secondary button-small dh-is-disabled" type="button" disabled' +
              ' aria-disabled="true" title="' + dhEscape(meta.label + '需要的能力尚未接入，本阶段不做假提交') + '">' +
              dhEscape(meta.label) + '</button>';
          })
          .join('')
      : '<small>当前没有可执行动作</small>') +
    '</span>' +
    (item.blockingIssues.length
      ? '<span class="dh-item-blockers">' +
        item.blockingIssues
          .map((issue) => '<small><code>' + dhEscape(issue.code) + '</code>' + dhEscape(issue.message) + '</small>')
          .join('') +
        '</span>'
      : '') +
    '</li>'
  );
}

function dhRealTaskCard(task) {
  const execution = dhLabel(DH_EXECUTION_LABELS, task.executionStatus);
  return (
    '<article class="panel dh-task dh-tone-' + execution.tone + '">' +
    '<header class="dh-task-head">' +
    '<div><h3>' + dhEscape(task.title) + '</h3>' +
    '<p>' + dhEscape(task.id) + ' · 批次状态 ' + dhEscape(task.batchStatus || '—') + '</p></div>' +
    '<div class="dh-task-badges">' +
    '<span class="dh-chip dh-chip-real">真实数据</span>' +
    dhStatusBadge(execution) +
    '</div>' +
    '</header>' +
    '<dl class="dh-task-meta">' +
    '<div><dt>明细数量</dt><dd>' + (task.itemCount === 1 ? '1 条明细 · 即单条生产' : task.itemCount + ' 条明细 · 批量生产') + '</dd></div>' +
    '<div><dt>生成轴</dt><dd>已生成 ' + (task.axes.generation.succeeded || 0) + ' · 失败 ' +
    ((task.axes.generation.failed || 0) + (task.axes.generation.blocked || 0)) + ' · 待处理 ' +
    ((task.axes.generation.planned || 0) + (task.axes.generation.queued || 0)) + '</dd></div>' +
    '<div><dt>审核轴</dt><dd>' + dhEscape(DH_REVIEW_SUMMARY_LABELS[task.reviewSummary] || task.reviewSummary) + '</dd></div>' +
    '<div><dt>交付轴</dt><dd>未接入</dd></div>' +
    '<div><dt>当前下一步</dt><dd>' + dhEscape(dhNextActionText(task.nextAction)) + '</dd></div>' +
    '<div><dt>最近更新</dt><dd>' + dhEscape(dhFormatTime(task.updatedAt)) + '</dd></div>' +
    '</dl>' +
    (task.items.length
      ? '<details class="dh-task-items">' +
        '<summary>展开 ' + task.items.length + ' 条生产明细（一条明细对应一个输出）</summary>' +
        '<ul>' + task.items.map(dhRealItemRow).join('') + '</ul>' +
        '</details>'
      : '') +
    '<footer class="dh-task-foot">' +
    task.allowedActions
      .map((action) => {
        const meta = DH_ACTION_LABELS[action] || { label: action };
        return '<button class="button button-secondary button-small dh-is-disabled" type="button" disabled' +
          ' aria-disabled="true" title="' + dhEscape(meta.label + '需要的能力尚未接入，本阶段不做假提交') + '">' +
          dhEscape(meta.label) + '（未接入）</button>';
      })
      .join('') +
    '<span class="dh-task-foot-note">本页不提供任何成片下载：还没有真实视频，也不会生成假的下载链接。</span>' +
    '</footer>' +
    '</article>'
  );
}

function dhRealTaskList() {
  const tasks = dhReal.summary?.tasks || [];
  if (!tasks.length) {
    return (
      '<div class="dh-empty" role="status">' +
      '<span aria-hidden="true">◌</span>' +
      '<strong>真实数据里还没有生产任务</strong>' +
      '<p>这不是加载失败：后端生产批次接口当前返回 0 条批次，所以摘要里的计数全部为 0。' +
      '生产任务由“项目与文案 + 数字人资产 + 场景模板”组合出来，该能力尚未接入。</p>' +
      '</div>'
    );
  }
  return '<div class="dh-task-list">' + tasks.map(dhRealTaskCard).join('') + '</div>';
}

/* 内容任务上下文：说明 P01 属于哪个内容任务，来自后端内容任务真实接口。 */
function dhContentTaskContext() {
  const tasks = dhReal.summary?.contentTasks || [];
  if (!tasks.length) {
    return '';
  }
  return (
    '<section class="panel dh-ctx" aria-label="所属内容任务">' +
    '<div class="panel-heading"><div><div class="eyebrow">所属内容任务</div>' +
    '<h2>口播生产挂在哪个内容任务下面</h2>' +
    '<p>来自后端内容任务真实接口，用于说明生产中心不是独立产品。</p></div></div>' +
    '<ul class="dh-ctx-list">' +
    tasks
      .map(
        (task) =>
          '<li><strong>' + dhEscape(task.title) + '</strong>' +
          '<small>' + dhEscape(task.id) + ' · ' + dhEscape(task.role || '') + ' · 节点 ' +
          task.completedNodes + '/' + task.totalNodes +
          (task.nextNode ? ' · 下一个节点 ' + dhEscape(task.nextNode.label) : '') +
          ' · 更新 ' + dhEscape(dhFormatTime(task.updatedAt)) + '</small></li>',
      )
      .join('') +
    '</ul>' +
    '</section>'
  );
}

/* 最小任务草稿：本页唯一的写入动作，落在 digital_human_drafts 表。 */
function dhDraftCard() {
  const tasks = dhReal.summary?.contentTasks || [];
  const record = dhDraft.record;
  const hasTask = Boolean(dhDraftForm.taskId);
  return (
    '<section class="panel dh-draft" aria-label="最小任务草稿">' +
    '<div class="panel-heading"><div><div class="eyebrow">最小任务草稿</div>' +
    '<h2>先保存这次生产想做什么</h2>' +
    '<p>草稿只保存意图，不产生明细、不进入状态机、不会生成视频。' +
    '真正的批次仍然由生成前检查与批次计划产生。</p></div>' +
    '<span class="phase-label">只写入草稿</span></div>' +
    '<div class="dh-draft-form">' +
    '<label class="dh-field"><span>关联内容任务</span>' +
    '<select data-dh-draft-field="taskId">' +
    '<option value="">（请选择）</option>' +
    tasks
      .map(
        (task) =>
          '<option value="' + dhEscape(task.id) + '"' +
          (task.id === dhDraftForm.taskId ? ' selected' : '') + '>' +
          dhEscape(task.title) + '</option>',
      )
      .join('') +
    '</select></label>' +
    '<label class="dh-field"><span>模式</span>' +
    '<select data-dh-draft-field="mode">' +
    '<option value="A"' + (dhDraftForm.mode === 'A' ? ' selected' : '') + '>模式 A · 文案 + 数字人生成视频</option>' +
    '<option value="B"' + (dhDraftForm.mode === 'B' ? ' selected' : '') + '>模式 B · 已有视频 + 文案/音频口型同步</option>' +
    '</select></label>' +
    '<label class="dh-field"><span>草稿标题</span>' +
    '<input type="text" data-dh-draft-field="title" value="' + dhEscape(dhDraftForm.title) + '" placeholder="例如：入职手机口播 · 第 1 条" /></label>' +
    '<label class="dh-field"><span>计划条数</span>' +
    '<input type="number" min="1" max="300" data-dh-draft-field="plannedItemCount" value="' +
    dhEscape(String(dhDraftForm.plannedItemCount || 1)) + '" /></label>' +
    '<label class="dh-field dh-field-wide"><span>备注</span>' +
    '<textarea rows="2" data-dh-draft-field="note" placeholder="例如：先用 1 条试生产，确认后再批量">' +
    dhEscape(dhDraftForm.note) + '</textarea></label>' +
    '</div>' +
    '<div class="dh-draft-foot">' +
    '<button class="button button-dark button-small" type="button" data-dh-save-draft' +
    (dhDraft.saveState === 'saving' || !hasTask ? ' disabled aria-disabled="true"' : '') +
    (hasTask ? '' : ' title="请先选择关联的内容任务"') + '>' +
    (dhDraft.saveState === 'saving' ? '正在保存…' : '保存最小草稿') + '</button>' +
    '<small>草稿保存在本地数据存储（digital_human_drafts），刷新后仍然存在。' +
    '数量为 1 就是单条生产，不额外提供“单条模式”。</small>' +
    '</div>' +
    (dhDraft.saveMessage
      ? '<p class="dh-draft-message' + (dhDraft.saveState === 'error' ? ' is-error' : '') + '" role="status">' +
        dhEscape(dhDraft.saveMessage) + '</p>'
      : '') +
    (record
      ? '<p class="dh-draft-record">已保存草稿：<strong>' + dhEscape(record.title) + '</strong>' +
        ' · 模式 ' + dhEscape(record.mode) + ' · 计划 ' + dhEscape(String(record.plannedItemCount || '—')) +
        ' 条 · 更新 ' + dhEscape(dhFormatTime(record.updatedAt)) + '</p>'
      : '<p class="dh-draft-record dh-draft-record-empty">当前没有任何已保存草稿。</p>') +
    '</section>'
  );
}

function dhErrorBlock() {
  const error = dhReal.error || {};
  return (
    '<section class="dh-error" role="alert">' +
    '<span class="dh-error-mark" aria-hidden="true">!</span>' +
    '<div><strong>真实数据读取失败，因此这里不显示任何任务数字</strong>' +
    '<p>' + dhEscape(error.message || '未知错误') +
    (error.httpStatus ? '（HTTP ' + error.httpStatus + '）' : '') + '</p>' +
    '<small>页面不会用示例数据冒充真实结果，也不会把空数据说成“全部完成”。修好数据源后可以重新读取。</small></div>' +
    '<button class="button button-secondary button-small" type="button" data-dh-refresh>重新读取</button>' +
    '</section>'
  );
}

function dhLoadingBlock() {
  return (
    '<section class="dh-loading" role="status">' +
    '<span aria-hidden="true">◌</span>' +
    '<div><strong>正在读取真实数据</strong>' +
    '<p>正在请求生产批次、内容任务和资产目录三个真实来源，然后由服务端投影成状态。</p></div>' +
    '</section>'
  );
}

function dhRenderReal() {
  const ready = dhReal.status === 'ready' && dhReal.summary;
  dhRoot.innerHTML =
    dhRealBanner() +
    '<div class="view-intro-row">' +
    '<div><span class="view-context">云员工 / 内容编辑 · AI 数字人口播</span>' +
    '<p>用已确认文案、员工数字人或已有视频，生成并人工验收口播视频。这是内容编辑云员工下面的批量生产中心，不是独立产品。</p></div>' +
    '<span class="view-intro-status">生产中心</span>' +
    '</div>' +
    dhRenderCreatePanel() +
    '<div class="dh-toolbar">' +
    '<div class="dh-context" aria-label="当前行业与项目上下文">' +
    '<span><small>项目</small><strong>' +
    dhEscape(dhReal.summary?.project?.name || '（读取中）') + '</strong></span>' +
    '<span><small>项目状态</small><strong>' + dhEscape(dhReal.summary?.project?.status || '—') + '</strong></span>' +
    '<span><small>生产批次</small><strong>' + Number(dhReal.summary?.source?.batchCount || 0) + ' 条</strong></span>' +
    '</div>' +
    '<div class="dh-toolbar-actions">' +
    '<button class="button button-secondary button-small" type="button" data-dh-back>← 返回内容编辑</button>' +
    '<button class="button button-secondary button-small" type="button" data-dh-refresh>重新读取</button>' +
    '</div>' +
    '</div>' +
    dhNoticeBlock() +
    (dhReal.status === 'loading'
      ? dhLoadingBlock()
      : dhReal.status === 'error'
        ? dhErrorBlock()
        : '') +
    (ready
      ? dhLayout(
          /* 主栏：流程位置 + 下一步 + 关键状态 + 该做的事 */
          dhFlowBar() +
          dhRealSummaryCards() +
          dhNextActionCard() +
          '<section class="panel dh-queue" aria-label="生产任务队列">' +
          '<div class="panel-heading"><div><div class="eyebrow">生产任务队列</div>' +
          '<h2>任务列表</h2><p>这里只显示后端真实返回的批次，页面不补充任何示例任务。</p></div></div>' +
          dhRealTaskList() +
          '</section>' +
          dhContentTaskContext() +
          dhDraftCard(),
          /* 侧栏：参考信息（资产就绪度 / 数据源 / 进入生产的条件 / 演示与说明） */
          dhAssetReadiness() +
          dhSourceBar() +
          dhGateBlock() +
          '<details class="dh-side-details"><summary>演示状态切换（验收用）</summary>' +
          '<p class="dh-side-note">演示 fixture 用于验收页面骨架，始终标记为演示数据，不是真实生产结果。</p>' +
          dhModeSwitcher() +
          '</details>' +
          '<details class="dh-side-details"><summary>模式 A / 模式 B 说明</summary>' + dhModeCards() + '</details>',
        )
      : dhModeSwitcher()) +
    '<footer class="dh-footnote">' +
    '<span>当前步骤：00 生产中心总览</span>' +
    '<span>流程：01 项目与文案 → 02 生产资产 → 03 生产任务 → 04 人工验收 → 05 内容包</span>' +
    '</footer>';
}

/* ---------------------------------------------------------------------------
   流程导航条：一眼看清「我在哪、还差什么」。
   五步流程：01 项目与文案 → 02 生产资产 → 03 生产任务 → 04 人工验收 → 05 内容包。
   每一步的状态和数字都来自真实数据，不允许页面编造进度。
   --------------------------------------------------------------------------- */

const DH_FLOW_STATUS_LABELS = {
  done: { label: '已就绪', tone: 'done' },
  active: { label: '进行中', tone: 'review' },
  todo: { label: '未开始', tone: 'draft' },
  blocked: { label: '有阻塞', tone: 'failed' },
};

function dhFlowSteps() {
  const summary = dhReal.summary || {};
  const copy = dhCopy.data || {};
  const assets = dhAssets.data || {};
  const counts = summary.counts || {};
  const tasks = Array.isArray(summary.tasks) ? summary.tasks : [];
  const assetMetrics = {
    avatars: assets.modeA?.avatars?.usable ?? summary.assets?.avatars ?? 0,
    voices: assets.modeA?.voices?.usable ?? summary.assets?.voices ?? 0,
    templates: assets.templates?.usable ?? summary.assets?.templates ?? 0,
  };

  const selectedScript = Boolean(copy.selectedScriptVersionId);
  const copyReady = (copy.confirmedCount || 0) > 0;
  const assetsReady = assetMetrics.avatars > 0 && assetMetrics.voices > 0 && assetMetrics.templates > 0;
  const assetsSelected = Boolean(assets.modeA?.selectedReady);

  return [
    {
      no: '01',
      label: '项目与文案',
      page: DH_PAGE_P02,
      wired: true,
      status: selectedScript ? 'done' : copyReady ? 'active' : 'todo',
      metric: '已确认 ' + (copy.confirmedCount || 0) + '/' + (copy.total || 0) + (selectedScript ? ' · 已选 1 条' : ''),
    },
    {
      no: '02',
      label: '生产资产',
      page: DH_PAGE_ASSETS,
      wired: true,
      status: assetsSelected ? 'done' : assetsReady ? 'active' : 'todo',
      metric: '形象 ' + assetMetrics.avatars + ' · 声音 ' + assetMetrics.voices + ' · 模板 ' + assetMetrics.templates,
    },
    {
      no: '03',
      label: '生产任务',
      page: DH_PAGE_TASK,
      wired: true,
      status: tasks.length || dhWorkspace.data?.rowCount ? 'active' : 'todo',
      metric: tasks.length + ' 批次' + (dhWorkspace.data?.rowCount ? ' · ' + dhWorkspace.data.rowCount + ' 行明细' : ''),
    },
    {
      no: '04',
      label: '人工验收',
      page: DH_PAGE_RESULTS,
      wired: true,
      status: (counts.waitingReview || 0) > 0 ? 'active' : 'todo',
      metric: '待验收 ' + (counts.waitingReview || 0),
    },
    {
      no: '05',
      label: '内容包',
      page: DH_PAGE_PACKAGE,
      wired: true,
      status: 'todo',
      metric: '可导出 ' + (counts.approvedExportable || 0),
    },
  ];
}

function dhFlowBar() {
  const steps = dhFlowSteps();
  const current = steps.find((step) => step.page === dhState.page) || steps.find((step) => step.status !== 'done') || steps[steps.length - 1];
  return (
    '<nav class="dh-flow" aria-label="口播生产流程位置">' +
    '<div class="dh-flow-head">' +
    '<span class="dh-flow-title">口播生产流程</span>' +
    '<strong class="dh-flow-current">当前：' + dhEscape(current.no + ' ' + current.label) + '</strong>' +
    '</div>' +
    '<ol class="dh-flow-steps">' +
    steps
      .map((step) => {
        const meta = dhLabel(DH_FLOW_STATUS_LABELS, step.status);
        const clickable = step.page && dhIsRealMode();
        const inner =
          '<span class="dh-flow-no">' + dhEscape(step.no) + '</span>' +
          '<span class="dh-flow-label">' + dhEscape(step.label) + '</span>' +
          '<small class="dh-flow-metric">' + dhEscape(step.metric) + '</small>' +
          '<span class="dh-flow-state">' +
          (step.wired ? '' : '<small class="dh-flow-unwired">待接入</small>') +
          dhStatusBadge(meta, 'dh-flow-badge') +
          '</span>';
        return (
          '<li class="dh-flow-step is-' + step.status + (step.page === dhState.page ? ' is-here' : '') + '">' +
          (clickable
            ? '<button type="button" class="dh-flow-step-btn" data-dh-page="' + dhEscape(step.page) + '"' +
              ' title="进入' + dhEscape(step.label) + '">' + inner + '</button>'
            : '<div class="dh-flow-step-btn" role="presentation"' +
              (step.wired ? '' : ' title="' + dhEscape(step.label + '需要的能力尚未接入') + '"') + '>' + inner + '</div>') +
          '</li>'
        );
      })
      .join('') +
    '</ol>' +
    '</nav>'
  );
}

/* 双栏布局：主栏放“现在要做的事”，侧栏放参考信息。参考信息不再和主流程抢权重。 */
function dhLayout(mainHtml, sideHtml) {
  return (
    '<div class="dh-layout">' +
    '<div class="dh-layout-main">' + mainHtml + '</div>' +
    '<aside class="dh-layout-side" aria-label="参考信息">' + sideHtml + '</aside>' +
    '</div>'
  );
}

/* P01 的“下一步”行动卡：整页唯一的主行动，来自服务端判定结果与阻塞项。 */
function dhNextActionCard() {
  const summary = dhReal.summary || {};
  const nextAction = summary.nextAction || 'nothing_pending';
  const issues = Array.isArray(summary.blockingIssues) ? summary.blockingIssues : [];
  const map = {
    prepare_assets: {
      title: '先把生产资产补齐',
      detail: '当前没有可用于批量生产的数字人形象和声音版本，生产任务无法创建。',
      action: { page: DH_PAGE_ASSETS, label: '去 02 生产资产查看缺口' },
    },
    configure_items: {
      title: '先把流程前两步补齐',
      detail: '还没有可执行的生产任务。先确认文案、选好资产，再到生产任务里配置明细。',
      action: { page: DH_PAGE_P02, label: '去 01 项目与文案' },
    },
    fix_blockers: {
      title: '有明细被阻塞，先处理',
      detail: '生产任务里存在阻塞明细，必须先修复才能继续。',
      action: null,
    },
    retry_failed_items: {
      title: '有失败明细可以重试',
      detail: '失败明细可以单条重试，不需要整批重来。',
      action: null,
    },
    review_pending_items: {
      title: '有结果等待人工验收',
      detail: '生成成功的明细需要人工判断通过或退回。',
      action: null,
    },
  };
  const resolved = map[nextAction] || {
    title: dhNextActionText(nextAction),
    detail: '下一步由服务端的状态判定给出。',
    action: null,
  };
  return (
    '<section class="dh-next card-primary" aria-label="当前下一步">' +
    '<div class="dh-next-head"><span class="dh-next-tag">下一步</span>' +
    '<h2>' + dhEscape(resolved.title) + '</h2></div>' +
    '<p>' + dhEscape(resolved.detail) + '</p>' +
    (issues.length
      ? '<ul class="dh-next-issues">' +
        issues.slice(0, 4).map((issue) => '<li><code>' + dhEscape(issue.code) + '</code>' + dhEscape(issue.message) + '</li>').join('') +
        '</ul>'
      : '') +
    (resolved.action
      ? '<button class="button button-dark" type="button" data-dh-page="' + dhEscape(resolved.action.page) + '">' +
        dhEscape(resolved.action.label) + ' →</button>'
      : '<button class="button button-dark dh-is-disabled" type="button" disabled aria-disabled="true"' +
        ' title="该动作需要的能力尚未接入，本页不提供假入口">处理入口待接入</button>') +
    '</section>'
  );
}



/* ---------------------------------------------------------------------------
   P02：项目与文案（本模块内部子页面）
   --------------------------------------------------------------------------- */

const DH_COPY_STATUS_LABELS = {
  approved: { label: '已确认', tone: 'done' },
  draft: { label: '未确认', tone: 'draft' },
};

function dhCopySourceBar() {
  const source = dhCopy.data?.source || {};
  return (
    '<section class="dh-source" aria-label="文案数据来源">' +
    '<div class="dh-source-head">' +
    '<div><span class="dh-source-tag">数据源</span>' +
    '<strong>文案候选来自资产目录真实接口，页面不补任何示例文案</strong></div>' +
    '<button class="button button-secondary button-small" type="button" data-dh-copy-reload' +
    (dhCopy.status === 'loading' ? ' disabled aria-disabled="true"' : '') +
    '>' + (dhCopy.status === 'loading' ? '正在重新读取…' : '重新读取文案') + '</button>' +
    '</div>' +
    '<dl class="dh-source-list">' +
    '<div><dt>接口</dt><dd><code>' + dhEscape((source.endpoints || [DH_COPY_ENDPOINT])[0]) + '</code></dd></div>' +
    '<div><dt>读取时间</dt><dd>' + dhEscape(dhFormatTime(source.readAt)) + '</dd></div>' +
    '<div><dt>项目</dt><dd>' + dhEscape(source.projectName || '—') + '</dd></div>' +
    '<div><dt>候选 / 已确认</dt><dd>' + Number(dhCopy.data?.total || 0) + ' / ' + Number(dhCopy.data?.confirmedCount || 0) + '</dd></div>' +
    '</dl>' +
    '</section>'
  );
}

function dhCopyGate() {
  const data = dhCopy.data || {};
  const issues = Array.isArray(data.blockingIssues) ? data.blockingIssues : [];
  const actions = Array.isArray(data.allowedActions) ? data.allowedActions : [];
  return (
    '<section class="panel dh-gate" aria-label="文案进入生产的条件">' +
    '<div class="panel-heading"><div><div class="eyebrow">进入生产的条件</div>' +
    '<h2>文案能不能进入生产任务</h2>' +
    '<p>只有已确认且有正文的文案版本可以被生产任务引用。' +
    '这一条由服务端判定，页面只负责显示真实结论。</p></div>' +
    '<span class="phase-label">下一步：' + dhEscape(dhNextActionText(data.nextAction)) + '</span></div>' +
    '<div class="dh-gate-grid">' +
    '<div class="dh-gate-col">' +
    '<h3>阻塞项（' + issues.length + '）</h3>' +
    (issues.length
      ? '<ul class="dh-gate-issues">' +
        issues
          .map((item) => '<li><code>' + dhEscape(item.code) + '</code><span>' +
            dhEscape(dhUserFacingReason(DH_GAP_LABELS[item.code] || item.message || '')) + '</span></li>')
          .join('') + '</ul>'
      : '<p class="dh-gate-empty">当前没有阻塞项。</p>') +
    '</div>' +
    '<div class="dh-gate-col">' +
    '<h3>现在可以做的事（' + actions.length + '）</h3>' +
    '<div class="dh-gate-actions">' +
    actions
      .map((action) => {
        if (action === 'select_copy') {
          return '<button class="button button-secondary button-small" type="button" data-dh-copy-focus-select>在下方候选中选择一条已确认文案</button>';
        }
        const meta = DH_ACTION_LABELS[action] || { label: action, slice: '后续能力' };
        return '<button class="button button-secondary button-small dh-is-disabled" type="button" disabled aria-disabled="true"' +
          ' title="' + dhEscape(meta.label + '需要的能力尚未接入，本阶段不做假提交、不写入演示数据') + '">' +
          dhEscape(meta.label) + '<small>（未接入）</small></button>';
      })
      .join('') +
    '</div>' +
    '</div>' +
    '</div>' +
    '</section>'
  );
}

function dhCopyCard(candidate) {
  const meta = dhLabel(DH_COPY_STATUS_LABELS, candidate.status);
  const expanded = dhCopyUi.expanded.has(candidate.id);
  const selected = dhCopy.data?.selectedScriptVersionId === candidate.id;
  return (
    '<article class="dh-copy-card' + (selected ? ' is-selected' : '') + (candidate.confirmed ? ' is-ok' : ' is-gap') + '">' +
    '<header class="dh-copy-head">' +
    '<div class="dh-copy-title"><strong>' + dhEscape(candidate.title) + '</strong>' +
    '<small>' + dhEscape(candidate.id) + ' · v' + dhEscape(String(candidate.version ?? '—')) +
    (candidate.platform ? ' · ' + dhEscape(candidate.platform) : '') +
    (candidate.estimatedDurationSeconds ? ' · 约 ' + candidate.estimatedDurationSeconds + 's' : '') + '</small></div>' +
    '<div class="dh-task-badges">' +
    (selected ? '<span class="dh-chip dh-chip-real">已选入草稿</span>' : '') +
    dhStatusBadge(meta) +
    '</div>' +
    '</header>' +
    '<p class="dh-copy-summary">' + dhEscape(candidate.textSummary) + '</p>' +
    (candidate.textTruncated
      ? '<button class="button-link" type="button" data-dh-copy-expand="' + dhEscape(candidate.id) + '">' +
        (expanded ? '收起全文' : '展开全文（' + candidate.textLength + ' 字）') + '</button>' +
        (expanded ? '<pre class="dh-copy-full">' + dhEscape(candidate.textSummary.replace(/…$/, '')) + '</pre>' : '')
      : '') +
    '<footer class="dh-copy-foot">' +
    (candidate.confirmed
      ? '<button class="button button-dark button-small" type="button" data-dh-copy-select="' + dhEscape(candidate.id) + '"' +
        (selected ? ' disabled aria-disabled="true" title="这条文案已经选入当前生产草稿"' : '') + '>' +
        (selected ? '已选入草稿' : '选入生产草稿') + '</button>'
      : '<button class="button button-secondary button-small dh-is-disabled" type="button" disabled aria-disabled="true"' +
        ' title="' + dhEscape(candidate.blockingIssues.map((issue) => issue.message).join('；') || '该文案未确认') + '">不可进入生产（未确认）</button>') +
    '<small>' + dhEscape(candidate.confirmed ? '可进入生产任务' : '需要先确认这条文案（10.2）') + '</small>' +
    '</footer>' +
    '</article>'
  );
}

function dhCopyRegisterForm() {
  return (
    '<section class="panel dh-draft" aria-label="登记文案候选">' +
    '<div class="panel-heading"><div><div class="eyebrow">登记新文案候选</div>' +
    '<h2>把一条文案写进当前任务的文案库</h2>' +
    '<p>复用现有文案登记接口，不新建第二套文案存储。是否确认由你决定：' +
    '未确认的候选会显示为不可进入生产，确认后才会出现在可用列表里。</p></div>' +
    '<button class="button button-secondary button-small" type="button" data-dh-copy-toggle-register>' +
    (dhCopyUi.registerOpen ? '收起表单' : '展开表单') + '</button></div>' +
    (dhCopyUi.registerOpen
      ? '<div class="dh-draft-form">' +
        '<label class="dh-field"><span>标题</span>' +
        '<input type="text" data-dh-copy-field="title" value="' + dhEscape(dhCopyForm.title) + '" placeholder="例如：入职手机口播 · A 版" /></label>' +
        '<label class="dh-field"><span>平台</span>' +
        '<select data-dh-copy-field="platform">' +
        ['抖音', '视频号', '小红书', 'B 站']
          .map((item) => '<option value="' + dhEscape(item) + '"' + (dhCopyForm.platform === item ? ' selected' : '') + '>' + dhEscape(item) + '</option>')
          .join('') +
        '</select></label>' +
        '<label class="dh-field dh-field-wide"><span>正文</span>' +
        '<textarea rows="5" data-dh-copy-field="text" placeholder="粘贴或输入口播文案正文，页面默认只显示摘要">' +
        dhEscape(dhCopyForm.text) + '</textarea></label>' +
        '<label class="dh-field dh-field-wide dh-copy-check">' +
        '<input type="checkbox" data-dh-copy-field="approved"' + (dhCopyForm.approved ? ' checked' : '') + ' />' +
        '<span>确认这条文案（confirmed）——只有确认后的版本可以进入生产任务</span></label>' +
        '</div>' +
        '<div class="dh-draft-foot">' +
        '<button class="button button-dark button-small" type="button" data-dh-copy-register' +
        (dhCopy.status === 'loading' ? ' disabled aria-disabled="true"' : '') + '>' +
        (dhCopy.status === 'loading' ? '正在登记…' : '登记这条文案') + '</button>' +
        '<small>登记后立即重新读取文案目录，不刷新整页。</small>' +
        '</div>'
      : '<p class="dh-gate-note">表单收起中。展开后可以登记新候选。</p>') +
    (dhCopy.error
      ? '<p class="dh-draft-message is-error" role="alert">' + dhEscape(dhCopy.error.message || '') + '</p>'
      : '') +
    '</section>'
  );
}

/* ---------------------------------------------------------------------------
   S6-01：N01 项目上下文 + N02 文案生成需求（P02 渲染块）
   --------------------------------------------------------------------------- */

function dhContextBlock() {
  const stage = dhContexts.data;
  const versions = stage?.versions || [];
  const selectedId = stage?.selectedContextId;
  return (
    '<section class="panel dh-queue" aria-label="项目上下文">' +
    '<div class="panel-heading"><div><div class="eyebrow">项目上下文</div>' +
    '<h2>这次文案为哪个行业、哪类受众服务</h2>' +
    '<p>行业、产品、受众、卖点和内容目标决定文案方向。编辑会产生新版本，旧版本永远可以回溯。</p></div>' +
    '<button class="button button-secondary button-small" type="button" data-dh-contexts-reload>重新读取</button></div>' +
    (versions.length
      ? '<ul class="dh-ctx-list">' +
        versions
          .map((item) =>
            '<li class="dh-copy-card' + (item.id === selectedId ? ' is-selected' : '') + '">' +
            '<div class="dh-copy-head"><div class="dh-copy-title"><strong>' + dhEscape(item.name) + ' · v' + item.version + '</strong>' +
            '<small>' + dhEscape([item.industry, item.product, item.audience].filter(Boolean).join(' · ') || item.id) + '</small></div>' +
            '<div class="dh-task-badges">' + (item.id === selectedId ? '<span class="dh-chip dh-chip-real">已选入草稿</span>' : '') + '</div></div>' +
            '<p class="dh-copy-summary"><strong>卖点：</strong>' + dhEscape((item.sellingPoints || []).join('；') || '—') +
            '　<strong>内容目标：</strong>' + dhEscape(item.contentGoal || '—') + '</p>' +
            '<footer class="dh-copy-foot">' +
            (item.id === selectedId
              ? '<button class="button button-secondary button-small dh-is-disabled" type="button" disabled aria-disabled="true">已选入草稿</button>'
              : '<button class="button button-dark button-small" type="button" data-dh-ctx-select="' + dhEscape(item.id) + '">选入生产草稿</button>') +
            '<button class="button-link" type="button" data-dh-ctx-edit>载入表单并编辑（产生 v' + (item.version + 1) + '）</button>' +
            '<small>编辑不改旧版本</small>' +
            '</footer></li>').join('') +
        '</ul>'
      : '<div class="dh-empty" role="status"><span aria-hidden="true">◌</span><strong>还没有项目上下文</strong>' +
        '<p>行业、产品、受众、卖点、内容目标是文案和生产的前提。在下方创建第一个档案。</p></div>') +
    '</section>'
  );
}

function dhContextFormBlock() {
  return (
    '<section class="panel dh-draft" aria-label="项目上下文表单">' +
    '<div class="panel-heading"><div><div class="eyebrow">项目上下文表单</div>' +
    '<h2>新建档案，或编辑已选档案（产生新版本）</h2>' +
    '<p>编辑不会改写旧版本：旧生产任务引用的上下文永远可以回溯。</p></div></div>' +
    '<div class="dh-draft-form">' +
    '<label class="dh-field"><span>档案名称（必填）</span><input type="text" data-dh-ctx-field="name" value="' + dhEscape(dhContextForm.name) + '" placeholder="例如：职业技能培训 · 秋季课程" /></label>' +
    '<label class="dh-field"><span>行业</span><input type="text" data-dh-ctx-field="industry" value="' + dhEscape(dhContextForm.industry) + '" /></label>' +
    '<label class="dh-field"><span>产品 / 服务</span><input type="text" data-dh-ctx-field="product" value="' + dhEscape(dhContextForm.product) + '" /></label>' +
    '<label class="dh-field"><span>目标受众</span><input type="text" data-dh-ctx-field="audience" value="' + dhEscape(dhContextForm.audience) + '" /></label>' +
    '<label class="dh-field dh-field-wide"><span>卖点（用「；」分隔多条）</span><input type="text" data-dh-ctx-field="sellingPoints" value="' + dhEscape(dhContextForm.sellingPoints) + '" /></label>' +
    '<label class="dh-field dh-field-wide"><span>内容目标</span><input type="text" data-dh-ctx-field="contentGoal" value="' + dhEscape(dhContextForm.contentGoal) + '" /></label>' +
    '</div>' +
    '<div class="dh-draft-foot">' +
    '<button class="button button-dark button-small" type="button" data-dh-ctx-save-new>保存为新档案</button>' +
    '<button class="button button-secondary button-small" type="button" data-dh-ctx-save-edit' + (dhContextForm.contextKey ? '' : ' disabled aria-disabled="true" title="先用「载入表单并编辑」载入一个档案"') + '>保存为所选档案的新版本</button>' +
    '<small>' + dhEscape(dhContextForm.contextKey ? '将产生 ' + dhContextForm.contextKey + ' 的新版本' : '尚未载入已有档案') + '</small>' +
    '</div></section>'
  );
}

function dhCopyRequestBlock() {
  const stage = dhContexts.data;
  const request = stage?.request;
  const issues = stage?.requestIssues || [];
  return (
    '<section class="panel dh-draft" aria-label="文案生成需求">' +
    '<div class="panel-heading"><div><div class="eyebrow">文案生成需求</div>' +
    '<h2>批量候选要多少、往哪个方向、发在哪</h2>' +
    '<p>AI 批量生成需要的模型提供方尚未配置——本阶段先保存需求，并用手动登记候选补位，生成按钮只会明确阻塞。</p>' +
    '<p class="dh-copy-request-note">再次保存会更新该项目最近一条活动需求；此处不展示需求历史或生成批次。</p></div></div>' +
    '<div class="dh-draft-form">' +
    '<label class="dh-field"><span>数量（1–50）</span><input type="number" min="1" max="50" data-dh-ctx-field="count" value="' + dhEscape(String(dhCopyRequestForm.count || 3)) + '" /></label>' +
    '<label class="dh-field"><span>方向</span><input type="text" data-dh-ctx-field="direction" value="' + dhEscape(dhCopyRequestForm.direction) + '" placeholder="例如：破除「发手机是福利」的误解" /></label>' +
    '<label class="dh-field"><span>平台</span><select data-dh-ctx-field="platform">' +
    ['抖音', '视频号', '小红书', 'B 站'].map((item) => '<option value="' + dhEscape(item) + '"' + (dhCopyRequestForm.platform === item ? ' selected' : '') + '>' + dhEscape(item) + '</option>').join('') +
    '</select></label>' +
    '<label class="dh-field"><span>时长（秒，可选）</span><input type="number" min="5" data-dh-ctx-field="durationSeconds" value="' + dhEscape(String(dhCopyRequestForm.durationSeconds || 45)) + '" /></label>' +
    '</div>' +
    '<div class="dh-draft-foot">' +
    '<button class="button button-dark button-small" type="button" data-dh-req-save>保存需求</button>' +
    '<button class="button button-secondary button-small dh-is-disabled" type="button" disabled aria-disabled="true" title="模型提供方未配置：本阶段不接真实生成，页面不做假提交">AI 批量生成（未接入）</button>' +
    '<small>' + (request ? '当前需求已保存：' + (request.count || '—') + ' 条 · ' + dhEscape(request.direction || '—') + ' · ' + dhEscape(request.platform || '—') : '尚未保存需求') + '</small>' +
    '</div>' +
    (issues.length ? '<ul class="dh-gate-issues">' + issues.map((issue) => '<li><code>' + dhEscape(issue.code) + '</code><span>' + dhEscape(dhUserFacingReason(issue.message)) + '</span></li>').join('') + '</ul>' : '') +
    '</section>'
  );
}

function dhCopyContextsFeedback() {
  if (dhContexts.status === 'error') {
    return (
      '<section class="dh-error" role="alert"><span class="dh-error-mark" aria-hidden="true">!</span>' +
      '<div><strong>项目档案与文案需求读取失败</strong>' +
      '<p>' + dhEscape(dhContexts.error?.message || '未知错误') + '</p></div>' +
      '<button class="button button-secondary button-small" type="button" data-dh-contexts-reload>重新读取</button></section>'
    );
  }
  return (
    '<section class="dh-loading" role="status"><span aria-hidden="true">◌</span>' +
    '<div><strong>正在读取项目档案与文案需求</strong>' +
    '<p>数据来自现有项目上下文接口；不会用演示内容替代真实记录。</p></div></section>'
  );
}

/* 项目切换的读写：当前值来自草稿接口的 selectedContextId（服务端持久化），
   下拉只负责提交选择，未保存前不会假装已切换。 */
function dhContextReadiness(stage, copy, assets) {
  const versions = stage?.versions || [];
  const selected = versions.find((item) => item.id === stage?.selectedContextId) || null;
  const requestIssues = stage?.requestIssues || [];
  const request = stage?.request || null;
  return [
    {
      key: 'profile',
      label: '项目档案',
      done: Boolean(selected),
      detail: selected
        ? selected.name + ' · v' + selected.version
        : versions.length ? '已有 ' + versions.length + ' 个档案，但本次生产还没选定' : '还没有项目档案',
      tab: 'profile',
      cta: versions.length ? '选择项目档案' : '创建项目档案',
    },
    {
      key: 'request',
      label: '文案需求',
      done: Boolean(request) && !requestIssues.length,
      detail: request
        ? (requestIssues.length
          ? dhUserFacingReason(requestIssues[0].message)
          : request.count + ' 条 · ' + (request.direction || '未填方向') + ' · ' + (request.platform || '未填平台'))
        : '还没有保存文案生成需求',
      tab: 'request',
      cta: request ? '调整文案需求' : '设置文案需求',
    },
    {
      key: 'candidates',
      label: '可生产文案',
      done: Number(copy.confirmedCount || 0) > 0,
      detail: (copy.total || 0) + ' 条候选，其中已确认 ' + (copy.confirmedCount || 0) + ' 条',
      tab: 'candidates',
      cta: '查看文案候选',
    },
    {
      key: 'draft',
      label: '已选入生产草稿',
      done: Boolean(copy.selectedScriptVersionId),
      detail: copy.selectedScriptVersionId ? '生产任务已引用一条已确认文案' : '还没有把已确认文案选入生产草稿',
      tab: 'candidates',
      cta: '去选一条文案',
    },
    {
      key: 'assets',
      label: '生产资产',
      done: Number(assets.avatars || 0) > 0 && Number(assets.voices || 0) > 0 && Number(assets.templates || 0) > 0,
      detail: '形象 ' + (assets.avatars || 0) + ' · 声音 ' + (assets.voices || 0) + ' · 模板 ' + (assets.templates || 0),
      page: DH_PAGE_ASSETS,
      cta: '进入 02 生产资产',
    },
  ];
}

/* 切换控件的提示文案：只描述真实可执行情形，不提前写成功。 */
function dhContextSwitchHint(hasVersions, canSubmit, hasPendingChange, failed, hasSelection) {
  if (failed) return '项目档案读取失败，暂时无法切换';
  if (!hasVersions) return '先创建一个项目档案，才能切换当前档案';
  if (!hasSelection) return '还没有选定当前档案：在下拉里选一个，再点「切换档案」写入生产草稿';
  if (!canSubmit) return '当前还没有可关联的内容任务，无法保存选择';
  if (hasPendingChange) return '尚未保存：确认后写入生产草稿，刷新与切换页签后仍保持一致';
  return '当前档案已写入生产草稿，刷新与切换页签后仍保持一致';
}

/* 工作台项目切换提示：只描述真实可执行情形，不把待提交选择写成已切换。 */
function dhProjectSwitchHint(status, count, canSwitch, hasPendingChange, error) {
  if (status === 'loading') return '正在读取当前用户可访问的工作台项目…';
  if (status === 'error') return '工作台项目读取失败：' + (error || '未知错误');
  if (!count) return '当前账号还没有可访问的工作台项目，因此暂时无法按项目隔离数据';
  if (count === 1) return '只有一个可访问项目，因此切换保持禁用（新建项目不在这个页面负责）';
  if (hasPendingChange) return canSwitch
    ? '尚未切换：确认后重新拉取该项目的档案、文案与任务'
    : '项目数据读取中，完成后可切换';
  return '已按当前项目隔离读取；项目档案与工作台项目是两个层级';
}

/* V4-02b：工作台项目（/api/workspace/projects）与下面的项目档案（contexts）分开展示、分别选择。 */
function dhWorkbenchProjectBlock() {
  const list = dhProjects.list;
  const currentId = dhState.projectScope;
  const current = list.find((item) => item.id === currentId) || null;
  const pendingId = list.some((item) => item.id === dhState.projectPick) ? dhState.projectPick : currentId;
  const canSwitch = dhProjects.status === 'ready' && list.length > 1;
  const projectName = current?.name
    || (dhReal.summary?.project?.id === currentId ? dhReal.summary?.project?.name : null)
    || (dhProjects.status === 'loading' ? '读取中'
      : dhProjects.status === 'error' ? '读取失败'
        : list.length ? '未选择项目' : '暂无可访问项目');
  return (
    '<div class="dh-home-scope">' +
    '<div class="dh-home-scope-main">' +
    '<small>工作台项目</small>' +
    '<strong>' + dhEscape(projectName) + '</strong>' +
    (current
      ? '<p>' + dhEscape([current.slug, current.status].filter(Boolean).join(' · ')) + '</p>' +
        '<p class="dh-home-facts"><strong>说明：</strong>' + dhEscape(current.description || '未填写') +
        '　<strong>更新于：</strong>' + dhEscape(dhFormatTime(current.updatedAt)) + '</p>'
      : '<p>' + (dhProjects.status === 'error'
        ? dhEscape(dhProjects.error?.message || '未知错误')
        : '工作台项目决定本页读取哪个项目的档案、文案与生产任务。') + '</p>') +
    '</div>' +
    '<div class="dh-scope-switch">' +
    '<label class="dh-field"><span>切换工作台项目</span>' +
    (list.length
      ? '<select data-dh-project-pick' + (canSwitch ? '' : ' disabled aria-disabled="true"') + '>' +
        list.map((item) =>
          '<option value="' + dhEscape(item.id) + '"' + (item.id === pendingId ? ' selected' : '') + '>' +
          dhEscape(item.name) + '</option>').join('') + '</select>'
      : '<select data-dh-project-pick disabled aria-disabled="true"><option value="">暂无可访问项目</option></select>') +
    '</label>' +
    '<button class="button button-secondary button-small" type="button" data-dh-project-pick-save' +
    (canSwitch && pendingId && pendingId !== currentId ? '' : ' disabled aria-disabled="true"') +
    (canSwitch
      ? (pendingId && pendingId !== currentId ? '' : ' title="先在上方下拉里选择另一个工作台项目"')
      : ' title="' + dhEscape(list.length > 1 ? '项目列表还在读取' : '只有一个项目时无需切换') + '"') +
    '>切换项目</button>' +
    '<small>' + dhEscape(dhProjectSwitchHint(
      dhProjects.status,
      list.length,
      canSwitch,
      Boolean(pendingId) && pendingId !== currentId,
      dhProjects.error?.message,
    )) + '</small>' +
    '</div></div>'
  );
}

/* V4-02b：最近文案预览。只展示接口真实返回的候选与确认状态，不把它们当成生成批次。 */
function dhRecentCopyBlock() {
  const copy = dhCopy.data || {};
  const candidates = [...(copy.candidates || [])]
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 3);
  return (
    '<section class="dh-home-recent" aria-label="最近文案预览">' +
    '<div class="dh-home-recent-head">' +
    '<div><small>最近文案</small><strong>' + dhEscape(String(copy.total ?? 0)) + ' 条候选 · 已确认 ' +
    dhEscape(String(copy.confirmedCount ?? 0)) + ' 条</strong></div>' +
    '<button class="button-link" type="button" data-dh-copy-tab="candidates">查看全部文案批次</button>' +
    '</div>' +
    (dhCopy.status === 'error'
      ? '<p class="dh-gate-note">文案读取失败，因此这里不展示任何候选：' +
        dhEscape(dhCopy.error?.message || '未知错误') + '</p>'
      : candidates.length
        ? '<ul class="dh-home-recent-list">' + candidates.map((item) =>
          '<li><div><strong>' + dhEscape(item.title) + '</strong>' +
          '<small>更新于 ' + dhEscape(dhFormatTime(item.updatedAt)) +
          ' · v' + dhEscape(String(item.version ?? '—')) + '</small></div>' +
          '<span class="dh-chip ' + (item.confirmed ? 'dh-chip-real' : '') + '">' +
          dhEscape(item.confirmed ? '已确认' : '未确认') +
          (copy.selectedScriptVersionId === item.id ? ' · 已选入草稿' : '') + '</span></li>').join('') + '</ul>'
        : '<p class="dh-gate-empty">这个项目下还没有真实文案候选。</p>') +
    '<p class="dh-gate-note">以上是现有接口返回的文案候选（script_versions）按更新时间的预览；'
    + '当前接口没有真实的文案生成批次列表，因此这里不代表批次，批次管理仍待后续文案批次切片接入。</p>' +
    '</section>'
  );
}

function dhProjectCenterBlock() {
  const project = dhReal.summary?.project;
  const stage = dhContexts.data;
  const copy = dhCopy.data || {};
  const assets = dhReal.summary?.assets || {};
  const versions = stage?.versions || [];
  const selected = versions.find((item) => item.id === stage?.selectedContextId) || null;
  const checks = dhContextReadiness(stage, copy, assets);
  const readyCount = checks.filter((item) => item.done).length;
  const nextAction = stage?.nextAction || 'nothing_pending';
  const blocking = stage?.blockingIssues || [];
  const currentContextId = stage?.selectedContextId || null;
  /* 下拉只展示待提交的选择；未确认前不假装已切换。 */
  const pendingContextId = versions.some((item) => item.id === dhState.contextPick)
    ? dhState.contextPick
    : currentContextId;
  const canSwitchContext = versions.length > 0 && Boolean(dhDraft.record?.taskId || dhDraftForm.taskId);
  return (
    '<section class="panel dh-home" aria-label="项目与文案中心">' +
    '<div class="panel-heading"><div><div class="eyebrow">项目与文案中心</div>' +
    '<h2>' + dhEscape(dhProjects.list.find((item) => item.id === dhState.projectScope)?.name
      || (project?.id && project?.id === dhState.projectScope ? project.name : null)
      || (dhProjects.status === 'loading' ? '正在读取工作台项目'
        : dhProjects.status === 'error' ? '工作台项目读取失败'
          : dhProjects.list.length ? '未选择工作台项目' : '暂无可访问项目')) + '</h2>' +
    '<p>本页分两层：工作台项目决定读哪个项目的数据；项目档案决定这项目的行业、产品、受众与卖点。</p></div>' +
    '<div class="dh-home-head-actions">' +
    '<span class="dh-home-readiness">准备度 ' + readyCount + ' / ' + checks.length + '</span>' +
    '<button class="button button-secondary button-small" type="button" data-dh-refresh' +
    (dhReal.status === 'loading' ? ' disabled aria-disabled="true"' : '') + '>重新读取</button>' +
    '</div></div>' +

    dhWorkbenchProjectBlock() +

    '<div class="dh-home-current">' +
    '<div class="dh-home-current-main">' +
    '<small>当前项目档案</small>' +
    (selected
      ? '<strong>' + dhEscape(selected.name) + ' · v' + selected.version + '</strong>' +
        '<p>' + dhEscape([selected.industry, selected.product, selected.audience].filter(Boolean).join(' · ') || '未填写行业 / 产品 / 受众') + '</p>' +
        '<p class="dh-home-facts"><strong>卖点：</strong>' + dhEscape((selected.sellingPoints || []).join('；') || '—') +
        '　<strong>内容目标：</strong>' + dhEscape(selected.contentGoal || '—') + '</p>'
      : '<strong>未选择项目档案</strong>' +
        '<p>' + (versions.length
          ? '已有 ' + versions.length + ' 个可用档案，选定后文案与生产任务才会挂到它下面。'
          : '项目档案决定行业、产品、受众与卖点，是文案与生产的前提；先创建第一个档案。') + '</p>') +
    '</div>' +
    '<div class="dh-ctx-switch">' +
    '<label class="dh-field"><span>切换当前项目档案</span>' +
    (versions.length
      ? '<select data-dh-ctx-pick>' +
        /* 没选定当前档案时给一个真实存在的空选项，避免浏览器默认选中第一项造成「已切换」假象。 */
        (currentContextId ? '' : '<option value=""' + (pendingContextId ? '' : ' selected') + '>未选择当前档案</option>') +
        versions.map((item) =>
          '<option value="' + dhEscape(item.id) + '"' + (item.id === pendingContextId ? ' selected' : '') + '>' +
          dhEscape(item.name + ' · v' + item.version) + '</option>').join('') + '</select>'
      : '<select data-dh-ctx-pick disabled aria-disabled="true"><option value="">暂无可切换档案</option></select>') +
    '</label>' +
    '<button class="button button-dark button-small" type="button" data-dh-ctx-pick-save' +
    (canSwitchContext && pendingContextId ? '' : ' disabled aria-disabled="true"') +
    (canSwitchContext
      ? (pendingContextId ? '' : ' title="先在上方下拉里选择一个项目档案"')
      : ' title="' + dhEscape(versions.length ? '还需要一个内容任务来承载选择' : '先创建一个项目档案') + '"') +
    '>切换档案</button>' +
    '<small>' + dhEscape(dhContextSwitchHint(
      versions.length,
      canSwitchContext,
      Boolean(pendingContextId) && pendingContextId !== currentContextId,
      dhContexts.status === 'error',
      Boolean(pendingContextId),
    )) + '</small>' +
    '</div></div>' +

    '<div class="dh-home-metrics" role="list">' +
    checks.map((item) =>
      '<div class="dh-home-metric' + (item.done ? ' is-done' : '') + '" role="listitem">' +
      '<span class="dh-home-metric-state" aria-hidden="true">' + (item.done ? '✓' : '○') + '</span>' +
      '<div><strong>' + dhEscape(item.label) + '</strong><small>' + dhEscape(item.detail) + '</small>' +
      /* 每张卡都带一个可执行的去处：页签内动作走页签切换，资产页走页面导航，复用既有事件委托。 */
      '<button class="dh-home-metric-cta" type="button"' +
      (item.page
        ? ' data-dh-page="' + dhEscape(item.page) + '"'
        : ' data-dh-copy-tab="' + dhEscape(item.tab) + '"') + '>' +
      dhEscape(item.cta) + '</button></div></div>').join('') +
    '</div>' +

    dhRecentCopyBlock() +

    '<div class="dh-home-next">' +
    '<div><small>下一步</small><strong>' + dhEscape(dhNextActionText(nextAction)) + '</strong></div>' +
    (blocking.length
      ? '<ul class="dh-gate-issues">' + blocking.map((item) =>
        '<li><span>' + dhEscape(dhUserFacingReason(item.message)) + '</span></li>').join('') + '</ul>'
      : '<p class="dh-gate-empty">当前没有阻塞项。</p>') +
    '</div>' +

    (dhReal.status === 'error'
      ? '<p class="dh-gate-note">项目状态读取失败：' + dhEscape(dhReal.error?.message || '未知错误') + '</p>'
      : '') +
    (dhCopy.status === 'error'
      ? '<p class="dh-gate-note">文案数据读取失败：' + dhEscape(dhCopy.error?.message || '未知错误') + '</p>'
      : '') +
    (dhContexts.status === 'error'
      ? '<p class="dh-gate-note">项目档案读取失败：' + dhEscape(dhContexts.error?.message || '未知错误') + '</p>'
      : '') +

    '<div class="dh-home-entries" aria-label="项目与文案页面入口">' +
    DH_COPY_TAB_META.map((tab) => {
      const disabled = Boolean(tab.reason);
      return '<button class="dh-home-entry' + (disabled ? ' is-disabled' : '') + '" type="button"' +
        (disabled
          ? ' disabled aria-disabled="true" title="' + dhEscape(tab.reason) + '"'
          : ' data-dh-copy-tab="' + tab.id + '"') + '>' +
        '<strong>' + dhEscape(tab.label) + '</strong>' +
        '<small>' + dhEscape(disabled ? '待接入 · ' + tab.reason : tab.slice) + '</small></button>';
    }).join('') +
    '</div>' +

    '<p class="dh-home-source">本页数据来自 /api/workspace/projects（工作台项目）、/api/content/digital-human/summary、/api/content/digital-human/contexts 与 /api/content/digital-human/copy；未接入的能力保持禁用，不注入示例数据。</p>' +
    '</section>'
  );
}

function dhCopyTabNav() {
  return (
    '<nav class="dh-copy-tabs" aria-label="项目与文案页面">' +
    DH_COPY_TAB_META.map((tab) => {
      const disabled = Boolean(tab.reason);
      const active = dhState.copyTab === tab.id;
      return (
        '<button class="dh-copy-tab' + (active ? ' is-active' : '') + (disabled ? ' is-disabled' : '') + '" type="button"' +
        (disabled
          ? ' disabled aria-disabled="true" title="' + dhEscape(tab.reason) + '"'
          : ' data-dh-copy-tab="' + tab.id + '"' + (active ? ' aria-current="page"' : '')) + '>' +
        '<span>' + dhEscape(tab.label) + '</span>' +
        (disabled ? '<small>待接入 · ' + dhEscape(tab.reason) + '</small>' : '') +
        '</button>'
      );
    }).join('') +
    '</nav>'
  );
}

function dhCopyCandidatesBlock() {
  if (dhCopy.status === 'loading' || dhCopy.status === 'idle') {
    return (
      '<section class="dh-loading" role="status"><span aria-hidden="true">◌</span>' +
      '<div><strong>正在读取真实文案</strong><p>候选与确认状态来自现有文案接口。</p></div></section>'
    );
  }
  if (dhCopy.status === 'error') {
    return (
      '<section class="dh-error" role="alert"><span class="dh-error-mark" aria-hidden="true">!</span>' +
      '<div><strong>文案数据读取失败，因此这里不显示任何候选</strong>' +
      '<p>' + dhEscape(dhCopy.error?.message || '未知错误') + '</p>' +
      '<small>页面不会用示例文案冒充真实文案库。</small></div>' +
      '<button class="button button-secondary button-small" type="button" data-dh-copy-reload>重新读取</button></section>'
    );
  }
  const candidates = dhCopy.data?.candidates || [];
  return (
    '<section class="panel dh-queue" aria-label="文案候选列表">' +
    '<div class="panel-heading"><div><div class="eyebrow">文案候选</div>' +
    '<h2>选择或登记可用于生产的文案</h2>' +
    '<p>当前接口提供文案候选及确认状态，没有批次列表；此处不代表批量生成结果。</p></div>' +
    '<button class="button button-secondary button-small" type="button" data-dh-copy-reload>重新读取文案</button></div>' +
    (candidates.length
      ? '<div class="dh-copy-list">' + candidates.map(dhCopyCard).join('') + '</div>'
      : '<div class="dh-empty" role="status"><span aria-hidden="true">◌</span>' +
        '<strong>真实文案库里还没有任何候选</strong>' +
        '<p>在下方登记第一条文案，或回到内容编辑工作流里生成文案。</p></div>') +
    '</section>' + dhCopyRegisterForm() + dhCopyGate() + dhCopySourceBar()
  );
}

function dhCopyTabContent() {
  if (dhState.copyTab === 'overview') {
    if (dhContexts.status === 'loading' || dhContexts.status === 'idle') return dhCopyContextsFeedback();
    return dhProjectCenterBlock();
  }
  if (dhState.copyTab === 'candidates') return dhCopyCandidatesBlock();
  if (dhContexts.status !== 'ready') return dhCopyContextsFeedback();
  if (dhState.copyTab === 'profile') return dhContextBlock() + dhContextFormBlock();
  if (dhState.copyTab === 'request') return dhCopyRequestBlock();
  return dhProjectCenterBlock();
}

/* F5-C2：监控中心带入的作品来源。只读展示，不自动视为已授权素材，也不创建内容任务。 */
function dhWorkPrefillBlock() {
  const record = dhWorkPrefill.record || dhReadWorkPrefill();
  if (!record) {
    return '';
  }
  const briefLines = String(record.sourceBrief || '').split('\n').filter(Boolean);
  return (
    '<section class="dh-prefill" role="status" aria-label="监控中心带入的作品来源">' +
    '<div class="dh-prefill-head">' +
    '<span class="dh-chip">来自监控中心</span>' +
    '<strong>' + dhEscape(record.workTitle || record.title || '未命名作品') + '</strong>' +
    '<button class="button button-quiet button-small" type="button" data-dh-prefill-clear>清除带入</button>' +
    '</div>' +
    '<dl class="dh-prefill-meta">' +
    '<div><dt>平台</dt><dd>' + dhEscape(record.platforms || '未记录') + '</dd></div>' +
    '<div><dt>来源标识</dt><dd>' + dhEscape(record.sourceWorkFingerprint || '未记录') + '</dd></div>' +
    (record.sourceUrl ? '<div><dt>来源链接</dt><dd>' + dhEscape(record.sourceUrl) + '</dd></div>' : '') +
    '</dl>' +
    (briefLines.length
      ? '<details class="dh-prefill-brief"><summary>素材引用与来源说明（' + briefLines.length + ' 条）</summary>' +
        '<pre>' + dhEscape(briefLines.join('\n')) + '</pre></details>'
      : '') +
    '<p class="dh-gate-note">监控来源是公开平台元数据，不会自动视为已授权素材；授权与素材解析仍需人工确认。</p>' +
    '</section>'
  );
}

function dhRenderCopy() {
  /* V4-02b：工具条展示工作台项目名；项目档案在页内单独展示，不与项目混为一个字段。 */
  const projectName = dhProjects.list.find((item) => item.id === dhState.projectScope)?.name
    || dhReal.summary?.project?.name
    || (
      dhProjects.status === 'loading' || dhReal.status === 'loading'
        ? '读取中'
        : dhProjects.status === 'error' || dhReal.status === 'error' ? '读取失败' : '未关联项目'
    );
  const candidates = dhCopy.status === 'ready' && dhCopy.data
    ? String(dhCopy.data.total ?? dhCopy.data.candidates?.length ?? 0) + ' 条'
    : dhCopy.status === 'error' ? '读取失败' : '读取中';
  const confirmed = dhCopy.status === 'ready' && dhCopy.data
    ? String(dhCopy.data.confirmedCount ?? 0) + ' 条'
    : dhCopy.status === 'error' ? '读取失败' : '读取中';
  dhRoot.innerHTML =
    '<div class="dh-real-banner" role="note"><strong>真实数据</strong>' +
    '<span>项目概览、项目档案、文案需求和候选均读取现有服务端数据；没有的能力会保持未接入状态。</span></div>' +
    dhWorkPrefillBlock() +
    '<div class="view-intro-row">' +
    '<div><span class="view-context">云员工 / 内容编辑 · AI 数字人口播</span>' +
    '<p>项目与文案：确认这次口播生产挂在哪个项目下，并从真实文案库里选出可进入生产的文案版本。</p></div>' +
    '<span class="view-intro-status">第 01 步 · 项目与文案</span>' +
    '</div>' +
    '<div class="dh-toolbar">' +
    '<div class="dh-context" aria-label="当前项目上下文">' +
    '<span><small>工作台项目</small><strong>' + dhEscape(projectName) + '</strong></span>' +
    '<span><small>候选</small><strong>' + dhEscape(candidates) + '</strong></span>' +
    '<span><small>已确认</small><strong>' + dhEscape(confirmed) + '</strong></span>' +
    '</div>' +
    '<div class="dh-toolbar-actions">' +
    '<button class="button button-secondary button-small" type="button" data-dh-page="' + DH_PAGE_P01 + '">← 返回生产中心</button>' +
    '<button class="button button-secondary button-small" type="button" data-dh-copy-reload>重新读取文案</button>' +
    '</div>' +
    '</div>' +
    dhNoticeBlock() +
    '<div class="dh-copy-shell">' +
    dhFlowBar() +
    dhCopyTabNav() +
    '<section class="dh-copy-tab-panel" id="dh-copy-panel" aria-label="项目与文案内容">' +
    dhCopyTabContent() +
    '</section></div>' +
    '<footer class="dh-footnote">' +
    '<span>当前步骤：01 项目与文案</span>' +
    '<span>流程：02 生产资产 → 03 生产任务 → 04 人工验收 → 05 内容包</span>' +
    '</footer>';
}

/* ---------------------------------------------------------------------------
   第 04 步：结果与人工验收（本模块内部子页面）
   --------------------------------------------------------------------------- */

function dhResultCard(task, item) {
  const sim = item.preview.simulated;
  return (
    '<article class="dh-asset-card' + (item.reviewStatus === 'approved' ? ' is-ok' : '') + '">' +
    '<div class="dh-asset-main"><strong>第 ' + dhEscape(String(item.rowNo ?? '—')) + ' 行 · ' + dhEscape(item.id.slice(0, 18)) + '…</strong>' +
    '<small>第 ' + item.attempts.current + '/' + (item.attempts.max || '—') + ' 次尝试</small></div>' +
    '<div class="dh-asset-side">' + dhAxisBadge('generation', item.generationStatus) + dhAxisBadge('review', item.reviewStatus) + '</div>' +
    '<div class="dh-row-fields">' +
    '<div class="dh-asset-main" style="grid-column:1/-1"><small><strong>预览：</strong>' + dhEscape(item.preview.reason) + '</small></div>' +
    '</div>' +
    '<div class="dh-asset-actions">' +
    '<button class="button ' + (item.actions.approve ? 'button-dark' : 'button-secondary') + ' button-small' + (item.actions.approve ? '' : ' dh-is-disabled') + '" type="button"' +
    (item.actions.approve ? ' data-dh-review="' + dhEscape(task.id) + '|' + dhEscape(item.id) + '|approved"' : ' disabled aria-disabled="true" title="' + dhEscape(item.reviewBlockedReason || '当前状态不可通过') + '"') + '>通过</button>' +
    '<button class="button button-secondary button-small' + (item.actions.requestChanges ? '' : ' dh-is-disabled') + '" type="button"' +
    (item.actions.requestChanges ? ' data-dh-review="' + dhEscape(task.id) + '|' + dhEscape(item.id) + '|changes_requested"' : ' disabled aria-disabled="true"') + '>需修改</button>' +
    '<button class="button button-secondary button-small' + (item.actions.retry ? '' : ' dh-is-disabled') + '" type="button"' +
    (item.actions.retry ? ' data-dh-retry="' + dhEscape(task.id) + '|' + dhEscape(item.id) + '"' : ' disabled aria-disabled="true" title="只有失败或被退回的明细可以重试"') + '>重试本条</button>' +
    '</div>' +
    (item.blockingIssues.length
      ? '<div class="dh-asset-actions"><small>' + item.blockingIssues.map((issue) => dhEscape(issue.code + ' ' + issue.message)).join('；') + '</small></div>'
      : '') +
    '</article>'
  );
}

function dhRenderResults() {
  const ready = dhResults.status === 'ready' && dhResults.data;
  const data = ready ? dhResults.data : null;
  dhRoot.innerHTML =
    dhRealBanner() +
    '<div class="view-intro-row"><div><span class="view-context">云员工 / 内容编辑 · AI 数字人口播</span>' +
    '<p>人工验收：每条结果独立显示生成/审核/交付三轴；没有真实文件就如实显示没有。</p></div>' +
    '<span class="view-intro-status">第 04 步 · 人工验收</span></div>' +
    '<div class="dh-toolbar"><div class="dh-context">' +
    '<span><small>批次</small><strong>' + Number(data?.batchCount || 0) + '</strong></span>' +
    '<span><small>结果</small><strong>' + Number(data?.itemCount || 0) + '</strong></span>' +
    '<span><small>待验收</small><strong>' + Number(data?.counts?.waitingReview || 0) + '</strong></span>' +
    '</div><div class="dh-toolbar-actions">' +
    '<button class="button button-secondary button-small" type="button" data-dh-page="' + DH_PAGE_P01 + '">← 返回生产中心</button>' +
    '<button class="button button-secondary button-small" type="button" data-dh-results-reload>重新读取</button>' +
    '</div></div>' +
    dhNoticeBlock() +
    (dhResults.status === 'error'
      ? '<section class="dh-error" role="alert"><span class="dh-error-mark" aria-hidden="true">!</span><div><strong>结果数据读取失败</strong><p>' + dhEscape(dhResults.error?.message || '') + '</p></div><button class="button button-secondary button-small" type="button" data-dh-results-reload>重新读取</button></section>'
      : '') +
    (ready
      ? dhLayout(
          dhFlowBar() +
          (data.tasks.length
            ? data.tasks.map((task) =>
              '<section class="panel dh-queue" aria-label="批次结果"><div class="panel-heading"><div><div class="eyebrow">批次结果</div><h2>' + dhEscape(task.title) + '</h2>' +
              '<p>' + dhEscape(task.id) + ' · 状态 ' + dhEscape(task.batchStatus || '—') + ' · 审核摘要 ' + dhEscape(DH_REVIEW_SUMMARY_LABELS[task.reviewSummary] || task.reviewSummary) + '</p></div>' +
              (task.canRun ? '<button class="button button-dark button-small" type="button" data-dh-run="' + dhEscape(task.id) + '">执行批次（模拟连接器）</button>' : '') +
              '</div>' +
              '<div class="dh-asset-list">' + task.items.map((item) => dhResultCard(task, item)).join('') + '</div>' +
              '</section>').join('')
            : '<div class="dh-empty" role="status"><span aria-hidden="true">◌</span><strong>真实数据里还没有生产批次</strong><p>先到第 03 步生产任务创建批次，再回来验收结果。</p></div>') +
          '<p class="dh-axis-note">领域规则：模拟输出只能用于验证队列和状态，不能审核通过或作为生产内容交付——「通过」按钮会因此被禁用。</p>',
          '<section class="panel dh-side-block"><div class="panel-heading"><div><div class="eyebrow">结果统计</div><h2>当前真实结果</h2></div></div>' +
          '<dl class="dh-source-list">' +
          '<div><dt>已生成</dt><dd>' + Number(data?.counts?.generated || 0) + '</dd></div>' +
          '<div><dt>待验收</dt><dd>' + Number(data?.counts?.waitingReview || 0) + '</dd></div>' +
          '<div><dt>已通过</dt><dd>' + Number(data?.counts?.approved || 0) + '</dd></div>' +
          '<div><dt>可真实预览</dt><dd>' + Number(data?.previewableCount || 0) + '（模拟 ' + Number(data?.simulatedCount || 0) + ' 条不算）</dd></div>' +
          '</dl></section>' +
          '<section class="dh-source"><dl class="dh-source-list"><div><dt>接口</dt><dd><code>' + dhEscape(DH_RESULTS_ENDPOINT) + '</code></dd></div>' +
          '<div><dt>读取时间</dt><dd>' + dhEscape(dhFormatTime(data?.source?.readAt)) + '</dd></div></dl></section>',
        )
      : '') +
    dhRenderStage8() +
    '<footer class="dh-footnote"><span>当前步骤：04 人工验收</span><span>流程：05 内容包</span></footer>';
}

/* ---------------------------------------------------------------------------
   第 05 步：内容包（本模块内部子页面）
   --------------------------------------------------------------------------- */

function dhRenderPackage() {
  const ready = dhPackage.status === 'ready' && dhPackage.data;
  const data = ready ? dhPackage.data : null;
  dhRoot.innerHTML =
    dhRealBanner() +
    '<div class="view-intro-row"><div><span class="view-context">云员工 / 内容编辑 · AI 数字人口播</span>' +
    '<p>内容包：只允许导出「生成成功 + 文件已校验 + 人工通过」的结果。模拟输出永远不能导出。</p></div>' +
    '<span class="view-intro-status">第 05 步 · 内容包</span></div>' +
    '<div class="dh-toolbar"><div class="dh-context">' +
    '<span><small>批次</small><strong>' + Number(data?.batchCount || 0) + '</strong></span>' +
    '<span><small>可导出结果</small><strong>' + Number(data?.exportableCount || 0) + '</strong></span>' +
    '<span><small>下一步</small><strong>' + dhEscape(dhNextActionText(data?.nextAction)) + '</strong></span>' +
    '</div><div class="dh-toolbar-actions">' +
    '<button class="button button-secondary button-small" type="button" data-dh-page="' + DH_PAGE_P01 + '">← 返回生产中心</button>' +
    '<button class="button button-secondary button-small" type="button" data-dh-package-reload>重新读取</button>' +
    '</div></div>' +
    dhNoticeBlock() +
    (dhPackage.status === 'error'
      ? '<section class="dh-error" role="alert"><span class="dh-error-mark" aria-hidden="true">!</span><div><strong>内容包数据读取失败</strong><p>' + dhEscape(dhPackage.error?.message || '') + '</p></div><button class="button button-secondary button-small" type="button" data-dh-package-reload>重新读取</button></section>'
      : '') +
    (ready
      ? dhLayout(
          dhFlowBar() +
          (data.groups.length
            ? data.groups.map((group) =>
              '<section class="panel dh-queue" aria-label="内容包资格"><div class="panel-heading"><div><div class="eyebrow">批次内容包</div><h2>' + dhEscape(group.title) + '</h2>' +
              '<p>' + dhEscape(group.id) + ' · ' + group.eligibleCount + '/' + group.itemCount + ' 条满足导出资格</p></div>' +
              (group.eligibleCount ? '<button class="button button-dark button-small" type="button" data-dh-export="' + dhEscape(group.id) + '">导出内容包</button>' : '') +
              '</div>' +
              (group.exportRecord
                ? '<dl class="dh-source-list"><div><dt>上次导出</dt><dd>' + dhEscape(group.exportRecord.status) + ' · 清单 ' + dhEscape(group.exportRecord.manifest || '—') + '</dd></div>' +
                  '<div><dt>导出时间</dt><dd>' + dhEscape(dhFormatTime(group.exportRecord.exportedAt)) + '</dd></div></dl>'
                : '<p class="dh-gate-note">' + dhEscape(group.blockedReason || '') + '</p>') +
              '<div class="dh-asset-list">' +
              group.items.map((item) =>
                '<article class="dh-asset-card' + (item.eligible ? ' is-ok' : ' is-gap') + '">' +
                '<div class="dh-asset-main"><strong>第 ' + dhEscape(String(item.rowNo ?? '—')) + ' 行</strong><small>' + dhEscape(item.id.slice(0, 18)) + '…</small></div>' +
                '<div class="dh-asset-side">' + (item.eligible ? '<span class="dh-chip dh-chip-real">可导出</span>' : '<span class="dh-chip">不可导出</span>') + '</div>' +
                '<div class="dh-asset-actions"><small>' + (item.eligible ? '满足全部导出条件' : '缺：' + item.failedChecks.map((code) => DH_GAP_LABELS[code] || code).join('、')) + '</small></div>' +
                '</article>').join('') +
              '</div></section>').join('')
            : '<div class="dh-empty" role="status"><span aria-hidden="true">◌</span><strong>还没有生产批次</strong><p>内容包从批次结果里来。先创建并执行批次。</p></div>') +
          '<p class="dh-axis-note">' + dhEscape(data.note) + '</p>',
          '<section class="panel dh-side-block"><div class="panel-heading"><div><div class="eyebrow">导出规则</div><h2>5.10 五个条件</h2></div></div>' +
          '<ul class="dh-gate-issues"><li><span>生成状态 succeeded</span></li><li><span>输出文件 verified 且可读取</span></li><li><span>人工审核 approved</span></li><li><span>用户明确选择进入内容包</span></li><li><span>当前输出未被新版本替代</span></li></ul></section>',
        )
      : '') +
    '<footer class="dh-footnote"><span>当前切片：F5-07 P08 内容包</span><span>导出走既有批次导出接口，模拟输出会被领域层拒绝</span></footer>';
}

/* ---------------------------------------------------------------------------
   F5-05：P06 生产任务工作区（本模块内部子页面）
   --------------------------------------------------------------------------- */

const DH_STEP_STATUS_LABELS = {
  done: { label: '完成', tone: 'done' },
  passed: { label: '已通过', tone: 'done' },
  blocked: { label: '有阻塞', tone: 'failed' },
  todo: { label: '未开始', tone: 'draft' },
  not_run: { label: '未检查', tone: 'draft' },
  unwired: { label: '未接入', tone: 'draft' },
};

function dhTaskRowEditor(row, index, workspace) {
  const candidates = dhCopy.data?.candidates || [];
  const avatars = dhAssets.data?.modeA?.avatars?.options || [];
  const voices = dhAssets.data?.modeA?.voices?.options || [];
  const templates = dhAssets.data?.templates?.options || [];
  const options = (list, selected, emptyLabel) =>
    '<option value="">' + dhEscape(emptyLabel) + '</option>' +
    list
      .map((item) => {
        const id = item.versionId || item.id;
        const label = (item.title || item.name || item.id) + (item.confirmed === false ? '（未确认）' : item.usable === false ? '（不可用）' : '');
        return '<option value="' + dhEscape(id) + '"' + (id === selected ? ' selected' : '') + '>' + dhEscape(label) + '</option>';
      })
      .join('');
  const projected = workspace?.rows?.[index] || null;
  const rowIssues = projected?.blockingIssues || [];
  return (
    '<article class="dh-row-editor" data-dh-row="' + index + '">' +
    '<header class="dh-row-head"><strong>第 ' + (index + 1) + ' 行</strong>' +
    '<span class="dh-row-output"><code>' + dhEscape(projected?.outputPath || '（输出路径待保存后生成）') + '</code></span>' +
    '<button class="button-link" type="button" data-dh-row-real-gen="' + index + '">⚡ 真实生成（云GPU）</button>\n' +
    '<button class="button-link" type="button" data-dh-row-remove="' + index + '">删除本行</button></header>' +
    '<div class="dh-row-fields">' +
    '<label class="dh-field"><span>文案版本（模式 A 必填）</span>' +
    '<select data-dh-row-field="scriptVersionId">' + options(candidates, row.scriptVersionId, '（选择已确认文案）') + '</select></label>' +
    '<label class="dh-field"><span>数字人形象版本</span>' +
    '<select data-dh-row-field="avatarVersionId">' + options(avatars, row.avatarVersionId, '（选择形象）') + '</select></label>' +
    '<label class="dh-field"><span>数字人声音版本</span>' +
    '<select data-dh-row-field="voiceVersionId">' + options(voices, row.voiceVersionId, '（选择声音）') + '</select></label>' +
    '<label class="dh-field"><span>场景模板版本</span>' +
    '<select data-dh-row-field="templateVersionId">' + options(templates, row.templateVersionId, '（选择模板）') + '</select></label>' +
    '<label class="dh-field"><span>输出文件名（不含扩展名，同一个任务里不能重复）</span>' +
    '<input type="text" data-dh-row-field="outputName" value="' + dhEscape(row.outputName) + '" placeholder="例如 row-01" /></label>' +
    '<label class="dh-field"><span>输出子目录（留空用任务默认）</span>' +
    '<input type="text" data-dh-row-field="outputSubdirectory" value="' + dhEscape(row.outputSubdirectory) + '" placeholder="' + dhEscape(workspace?.outputPolicy?.subdirectory || '') + '" /></label>' +
    '</div>' +
    (rowIssues.length
      ? '<ul class="dh-row-issues">' +
        rowIssues.map((issue) => '<li><code>' + dhEscape(issue.code) + '</code>' + dhEscape(issue.message) + '</li>').join('') +
        '</ul>'
      : '<p class="dh-row-ok">本行引用齐备，输出命名未冲突。</p>') +
    '</article>'
  );
}

function dhRenderTask() {
  const ready = dhWorkspace.status === 'ready' && dhWorkspace.data;
  const data = ready ? dhWorkspace.data : null;
  const gate = dhPreflight.gate || data?.preflight || null;
  dhRoot.innerHTML =
    dhRealBanner() +
    '<div class="view-intro-row">' +
    '<div><span class="view-context">云员工 / 内容编辑 · AI 数字人口播</span>' +
    '<p>P06 生产任务：把前面选好的文案和资产，显式逐行组成生产明细。一行对应一个输出，1 行就是单条生产。</p></div>' +
    '<span class="view-intro-status">第 03 步 · 生产任务</span>' +
    '</div>' +
    '<div class="dh-toolbar">' +
    '<div class="dh-context" aria-label="当前任务上下文">' +
    '<span><small>模式</small><strong>模式 ' + dhEscape(data?.mode || 'A') + '</strong></span>' +
    '<span><small>明细行</small><strong>' + dhTaskRows.length + ' 行' + (dhTaskRows.length === 1 ? ' · 单条生产' : dhTaskRows.length > 1 ? ' · 批量生产' : '') + '</strong></span>' +
    '<span><small>检查</small><strong>' + dhEscape(gate ? (gate.success ? '已通过' : '被阻塞') : '未检查') + '</strong></span>' +
    '</div>' +
    '<div class="dh-toolbar-actions">' +
    '<button class="button button-secondary button-small" type="button" data-dh-page="' + DH_PAGE_P01 + '">← 返回生产中心</button>' +
    '<button class="button button-secondary button-small" type="button" data-dh-workspace-reload>重新读取</button>' +
    '</div>' +
    '</div>' +
    dhNoticeBlock() +
    (dhWorkspace.status === 'loading'
      ? dhLoadingBlock()
      : dhWorkspace.status === 'error'
        ? '<section class="dh-error" role="alert"><span class="dh-error-mark" aria-hidden="true">!</span>' +
          '<div><strong>工作区数据读取失败，因此这里不显示任何明细</strong>' +
          '<p>' + dhEscape(dhWorkspace.error?.message || '未知错误') + '</p>' +
          '<small>页面不会用示例明细冒充真实数据。</small></div>' +
          '<button class="button button-secondary button-small" type="button" data-dh-workspace-reload>重新读取</button></section>'
        : '') +
    (ready
      ? dhLayout(
          dhFlowBar() +
          /* 五步工作区 */
          '<section class="panel dh-steps-panel" aria-label="五步任务工作区">' +
          '<div class="panel-heading"><div><div class="eyebrow">五步任务工作区</div>' +
          '<h2>从选择到执行</h2>' +
          '<p>执行环节已接入：通过生成前检查后，可在本页创建批次，并在人工验收页启动真实生成。</p></div></div>' +
          '<ol class="dh-wsteps">' +
          data.steps
            .map((step) => {
              const meta = dhLabel(DH_STEP_STATUS_LABELS, step.status);
              return '<li class="dh-wstep is-' + step.status + '">' +
                '<span class="dh-wstep-no">' + dhEscape(step.no) + '</span>' +
                '<strong>' + dhEscape(step.label) + '</strong>' +
                dhStatusBadge(meta) +
                '</li>';
            })
            .join('') +
          '</ol>' +
          '</section>' +
          /* 明细配置 */
          '<section class="panel dh-queue" aria-label="显式明细配置">' +
          '<div class="panel-heading"><div><div class="eyebrow">明细配置</div>' +
          '<h2>显式逐行添加，禁止隐式全组合</h2>' +
          '<p>一行对应一个输出；想要几条就加几行，系统不会把多个形象和多个文案自动相乘。</p></div>' +
          '<button class="button button-dark button-small" type="button" data-dh-row-add>+ 添加一行明细</button>' +
          '</div>' +
          (dhTaskRows.length
            ? dhTaskRows.map((row, index) => dhTaskRowEditor(row, index, data)).join('')
            : '<div class="dh-empty" role="status"><span aria-hidden="true">◌</span>' +
              '<strong>还没有任何明细行</strong>' +
              '<p>1 行 = 单条生产；多行 = 批量生产。添加后记得保存到草稿。</p></div>') +
          '<div class="dh-draft-foot">' +
          '<button class="button button-dark button-small" type="button" data-dh-rows-save' +
          (dhWorkspace.status === 'loading' ? ' disabled aria-disabled="true"' : '') + '>保存明细到草稿</button>' +
          '<button class="button button-secondary button-small" type="button" data-dh-preflight-run' +
          (dhPreflight.running || !dhTaskRows.length ? ' disabled aria-disabled="true"' : '') +
          (!dhTaskRows.length ? ' title="至少要有 1 行明细才能做生成前检查"' : '') + '>' +
          (dhPreflight.running ? '正在检查…' : '运行生成前检查') + '</button>' +
          '<button class="button button-primary button-small" type="button" data-dh-create-batch' +
          (dhBatchBusy ? ' disabled aria-disabled="true"' : '') + '>' + (dhBatchBusy ? '正在创建批次…' : '创建生产批次（不执行）') + '</button>' +
          '<small>明细保存在生产草稿里，刷新后仍在；生成前检查只判定、不执行。创建批次后到 P07 结果页点「执行批次（真实）」才会真正生成。</small>' +
          '</div>' +
          (dhBatchMessage ? '<p class="dh-draft-message" role="status">' + dhEscape(dhBatchMessage) + '</p>' : '') +
          '</section>' +
          /* 生成前检查结果 */
          (gate
            ? '<section class="panel ' + (gate.success ? 'dh-gate' : 'dh-gate') + '" aria-label="生成前检查结果">' +
              '<div class="panel-heading"><div><div class="eyebrow">生成前检查</div>' +
              '<h2>' + (gate.success ? '通过：允许进入执行' : '被阻塞：还不能执行') + '</h2>' +
              '<p>判定来自服务端，页面不自己猜结论。</p></div>' +
              '<span class="phase-label">下一步：' + dhEscape(dhNextActionText(gate.next_action)) + '</span></div>' +
              (gate.blocking_issues?.length
                ? '<ul class="dh-gate-issues">' +
                  gate.blocking_issues.map((item) => '<li><code>' + dhEscape(item.code) + '</code><span>' + dhEscape(item.message) + '</span></li>').join('') +
                  '</ul>'
                : '<div class="dh-gate-empty">' +
                  '<p>没有阻塞项。可以按当前显式明细创建生产批次（一行对应一个输出，不做全组合）。</p>' +
                  '<button class="button button-dark button-small" type="button" data-dh-batch-create' +
                  (dhPreflight.running ? ' disabled aria-disabled="true"' : '') + '>' +
                  (dhPreflight.running ? '正在创建…' : '按显式明细创建生产批次') + '</button>' +
                  '<small>批次创建后处于「待批准」，不会自动开始生成，也不会产生任何视频文件。</small>' +
                  '</div>') +
              (dhPreflight.createdBatch
                ? '<dl class="dh-source-list">' +
                  '<div><dt>已创建批次</dt><dd><code>' + dhEscape(dhPreflight.createdBatch.id) + '</code></dd></div>' +
                  '<div><dt>状态</dt><dd>' + dhEscape(dhPreflight.createdBatch.status) + '</dd></div>' +
                  '<div><dt>明细数</dt><dd>' + Number(dhPreflight.createdBatch.planCount || 0) + ' 行（显式，无全组合）</dd></div>' +
                  '</dl>' +
                  (dhPreflight.createdNote ? '<p class="dh-axis-note">' + dhEscape(dhPreflight.createdNote) + '</p>' : '')
                : '') +
              '<p class="dh-axis-note">' + dhEscape(gate.note || '') + '</p>' +
              '</section>'
            : '') +
          dhOutputPolicyCard(data),
          dhTaskSidePanel(data),
        )
      : '') +
    '<footer class="dh-footnote">' +
    '<span>当前步骤：03 生产任务</span>' +
    '<span>流程：04 人工验收 → 05 内容包</span>' +
    '</footer>';
}

function dhOutputPolicyCard(data) {
  return (
    '<section class="panel dh-side-block" aria-label="输出设置">' +
    '<div class="panel-heading"><div><div class="eyebrow">输出设置</div>' +
    '<h2>目录与命名规则</h2>' +
    '<p>生成出来的视频保存位置由用户设置；这里显示当前任务的目录策略和每行输出路径预览。</p></div></div>' +
    '<dl class="dh-source-list">' +
    '<div><dt>输出根目录</dt><dd>' + dhEscape(data.outputPolicy.directory) + '</dd></div>' +
    '<div><dt>子目录</dt><dd>' + dhEscape(data.outputPolicy.subdirectory) + '</dd></div>' +
    '<div><dt>命名规则</dt><dd>' + dhEscape(data.outputPolicy.namePattern) + '</dd></div>' +
    '</dl>' +
    '</section>'
  );
}

function dhN18ProvidersBlock(data) {
  const readiness = data?.providers?.readiness || {};
  const rows = Object.entries(readiness).map(([capability, info]) => ({
    capability,
    label: capability === 'tts' ? 'TTS 声音' : capability === 'talking_head' ? '数字人视频' : '口型同步',
    preferred: info.preferred ? info.preferred.providerKey : null,
    ready: info.ready,
    counts: '候选 ' + info.candidateCount + ' · 阻塞 ' + info.blockedCount + ' · 模拟 ' + info.simulationCount,
  }));
  return (
    '<section class="panel dh-side-block" aria-label="N18 提供方就绪度">' +
    '<div class="panel-heading"><div><div class="eyebrow">N18 提供方（S7）</div>' +
    '<h2>真实生成能力登记</h2>' +
    '<p>只有 preferred（真实样片验收通过）的能力才允许开始生成；候选/模拟一律如实阻塞。</p></div></div>' +
    (rows.length
      ? '<dl class="dh-source-list">' +
        rows.map((row) => '<div><dt>' + dhEscape(row.label) + '</dt><dd>' +
          (row.ready ? '<strong>' + dhEscape(row.preferred) + ' ✓</strong>' : '<strong>未就绪</strong>（' + dhEscape(row.counts) + '）') +
          '</dd></div>').join('') +
        '</dl>'
      : '<p class="dh-gate-note">尚无提供方登记。</p>') +
    '</section>'
  );
}

function dhTaskSidePanel(data) {
  const issues = Array.isArray(data.blockingIssues) ? data.blockingIssues : [];
  return (
    dhAssetSelectionSummary() +
    '<section class="panel dh-gate" aria-label="任务进入生产的条件">' +
    '<div class="panel-heading"><div><div class="eyebrow">进入生产的条件</div>' +
    '<h2>阻塞项与下一步</h2>' +
    '<p>来自服务端对显式明细的判定：引用可用、命名唯一、至少 1 行。</p></div>' +
    '<span class="phase-label">next_action：' + dhEscape(dhNextActionText(data.nextAction)) + '</span></div>' +
    '<div class="dh-gate-col">' +
    '<h3>blocking_issues（' + issues.length + '）</h3>' +
    (issues.length
      ? '<ul class="dh-gate-issues">' +
        issues.map((item) => '<li><code>' + dhEscape(item.code) + '</code><span>' + dhEscape(item.message) + '</span></li>').join('') +
        '</ul>'
      : '<p class="dh-gate-empty">当前没有阻塞项。</p>') +
    '</div>' +
    '<p class="dh-axis-note">明细由用户显式逐行添加，系统不提供「全组合一键生成」：' +
    '那是规则明令禁止的隐式全组合。</p>' +
    '</section>' +
    '<section class="dh-source" aria-label="工作区数据来源">' +
    '<div class="dh-source-head"><div><span class="dh-source-tag">数据源</span>' +
    '<strong>明细、文案与资产都来自真实草稿与目录</strong></div></div>' +
    '<dl class="dh-source-list">' +
    (data.source.endpoints || []).map((endpoint) => '<div><dt>接口</dt><dd><code>' + dhEscape(endpoint) + '</code></dd></div>').join('') +
    '<div><dt>读取时间</dt><dd>' + dhEscape(dhFormatTime(data.source.readAt)) + '</dd></div>' +
    '</dl>' +
    '</section>'
  );
}



/* ---------------------------------------------------------------------------
   F5-04：生产资产页（P03 形象/声音 + P04 已有视频 + P05 模板，按模式 A/B 分区）
   --------------------------------------------------------------------------- */

const DH_ASSET_STATUS_LABELS = {
  approved: { label: '已审核', tone: 'done' },
  draft: { label: '未审核', tone: 'draft' },
  active: { label: '启用中', tone: 'done' },
};

function dhAssetGroupBlock(title, group, kind, selectedId, emptyHint) {
  return (
    '<section class="dh-asset-group">' +
    '<div class="dh-asset-group-head"><h3>' + dhEscape(title) + '</h3>' +
    '<span class="dh-asset-count">可用 ' + group.usable + ' / ' + group.total + '</span></div>' +
    (group.options.length
      ? '<div class="dh-asset-list">' +
        group.options
          .map((option) => {
            const selected = selectedId && (option.id === selectedId || option.versionId === selectedId);
            return (
              '<article class="dh-asset-card' + (selected ? ' is-selected' : '') + (option.usable ? ' is-ok' : ' is-gap') + '">' +
              '<div class="dh-asset-main"><strong>' + dhEscape(option.name) + '</strong>' +
              '<small>' + dhEscape(option.id) + ' · v' + dhEscape(String(option.version ?? '—')) +
              (option.provider ? ' · ' + dhEscape(option.provider) : '') + '</small></div>' +
              '<div class="dh-asset-side">' +
              dhStatusBadge(dhLabel(DH_ASSET_STATUS_LABELS, option.status)) +
              (selected ? '<span class="dh-chip dh-chip-real">已选入草稿</span>' : '') +
              '</div>' +
              '<div class="dh-asset-actions">' +
              (option.usable
                ? '<button class="button button-dark button-small" type="button" data-dh-asset-select="' + dhEscape(kind) + '"' +
                  ' data-dh-asset-id="' + dhEscape(option.versionId || option.id) + '"' +
                  (selected ? ' disabled aria-disabled="true" title="已选入当前生产草稿"' : '') + '>' +
                  (selected ? '已选入草稿' : '选入草稿') + '</button>'
                : '<button class="button button-secondary button-small dh-is-disabled" type="button" disabled aria-disabled="true"' +
                  ' title="' + dhEscape(option.blockingIssues.map((issue) => issue.message).join('；') || '该资产当前不可用') + '">不可用</button>') +
              '<small>' + dhEscape(option.usable ? '可进入批量生产' : option.blockingIssues.map((issue) => issue.code).join('、') || '不可用') + '</small>' +
              '</div>' +
              '</article>'
            );
          })
          .join('') +
        '</div>'
      : '<div class="dh-empty" role="status"><span aria-hidden="true">◌</span>' +
        '<strong>' + dhEscape(emptyHint) + '</strong>' +
        '<p>本切片只做选择、版本、状态和阻塞显示，不提供资产登记与模型训练。</p></div>') +
    '</section>'
  );
}

/* ---------------------------------------------------------------------------
   S6-02/S6-03：数字人档案（P03）与模式 B 已有视频/映射（P04）渲染块
   --------------------------------------------------------------------------- */

async function dhLoadModeB() {
  dhModeB.status = 'loading';
  dhRender();
  try {
    const payload = await dhApi(DH_MODEB_ENDPOINT);
    dhModeB.data = payload.stage || null;
    dhModeB.status = 'ready';
  } catch (error) {
    dhModeB.data = null;
    dhModeB.status = 'error';
    dhModeB.error = { message: error.message };
  }
  dhRender();
}

async function dhSaveProfile() {
  if (!dhProfileForm.name.trim()) {
    dhModeB.error = { message: '档案名称不能为空。' };
    dhRender();
    return;
  }
  dhModeB.status = 'loading';
  dhRender();
  try {
    await dhApi(DH_PROFILES_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: dhReal.summary?.project?.id || undefined,
        name: dhProfileForm.name,
        subjectRole: dhProfileForm.subjectRole,
        avatarVersionId: dhProfileForm.avatarVersionId || undefined,
        voiceVersionId: dhProfileForm.voiceVersionId || undefined,
      }),
    });
    dhProfileForm.name = '';
    dhProfileForm.subjectRole = '';
    await dhLoadAssets();
    await dhLoadModeB();
  } catch (error) {
    dhModeB.status = 'error';
    dhModeB.error = { message: '档案保存失败：' + error.message };
  }
  dhRender();
}

async function dhImportVideo() {
  if (!dhVideoForm.name.trim()) {
    dhModeB.error = { message: '视频名称不能为空。' };
    dhRender();
    return;
  }
  dhModeB.status = 'loading';
  dhRender();
  try {
    await dhApi(DH_SOURCE_VIDEO_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: dhReal.summary?.project?.id || undefined,
        name: dhVideoForm.name,
        fileRef: dhVideoForm.fileRef,
        durationSeconds: Number(dhVideoForm.durationSeconds) || undefined,
        aspect: dhVideoForm.aspect,
      }),
    });
    dhVideoForm.name = '';
    dhVideoForm.fileRef = '';
    dhVideoForm.durationSeconds = '';
    dhVideoForm.aspect = '9:16';
    await dhLoadModeB();
  } catch (error) {
    dhModeB.status = 'error';
    dhModeB.error = { message: '视频导入失败：' + error.message };
  }
  dhRender();
}

async function dhSaveMapping() {
  if (!dhMappingForm.videoId) {
    dhModeB.error = { message: '映射必须选择一个已有视频。' };
    dhRender();
    return;
  }
  dhModeB.status = 'loading';
  dhRender();
  try {
    await dhApi(DH_MAPPING_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: dhReal.summary?.project?.id || undefined,
        videoId: dhMappingForm.videoId,
        scriptVersionId: dhMappingForm.scriptVersionId || undefined,
        voiceSource: dhMappingForm.voiceSource,
        templateVersionId: dhMappingForm.templateVersionId || undefined,
      }),
    });
    dhMappingForm.videoId = '';
    dhMappingForm.scriptVersionId = '';
    dhMappingForm.voiceSource = 'original';
    dhMappingForm.templateVersionId = '';
    await dhLoadModeB();
  } catch (error) {
    dhModeB.status = 'error';
    dhModeB.error = { message: '映射保存失败：' + error.message };
  }
  dhRender();
}

function dhProfilesBlock() {
  const ready = dhAssets.status === 'ready' && dhAssets.data;
  const profiles = ready ? dhAssets.data?.profiles : null;
  const list = profiles?.profiles || [];
  return (
    '<section class="panel dh-asset-panel" aria-label="员工数字人档案">' +
    '<div class="panel-heading"><div><div class="eyebrow">员工数字人档案 · N05–N10</div>' +
    '<h2>档案 = 员工主体 + 形象版本 + 声音版本</h2>' +
    '<p>处理状态在没有真实训练提供方时只能停在「待处理-提供方未配置」，绝不显示为已训练；能否生产由绑定版本的审核状态推导。</p></div>' +
    '<span class="phase-label">' + (list.length ? '可生产 ' + (profiles.readyCount || 0) + '/' + list.length : '无档案') + '</span></div>' +
    (list.length
      ? '<div class="dh-asset-list">' +
        list.map((profile) =>
          '<article class="dh-asset-card' + (profile.ready ? ' is-ok' : ' is-gap') + '">' +
          '<div class="dh-asset-main"><strong>' + dhEscape(profile.name) + '</strong>' +
          '<small>' + dhEscape(profile.subjectRole || '未填岗位') + ' · ' + dhEscape(profile.id.slice(0, 14)) + '…</small></div>' +
          '<div class="dh-asset-side"><span class="dh-chip' + (profile.ready ? ' dh-chip-real' : '') + '">' + (profile.ready ? '可生产' : '未就绪') + '</span></div>' +
          '<div class="dh-asset-actions"><small>形象：' + dhEscape(profile.avatar ? profile.avatar.name : '未绑定') +
          ' · 声音：' + dhEscape(profile.voice ? profile.voice.name : '未绑定') + '</small></div>' +
          (profile.blockingIssues.length
            ? '<div class="dh-asset-actions"><small>' + profile.blockingIssues.map((issue) => dhEscape(issue.message)).join('；') + '</small></div>'
            : '') +
          '</article>').join('') +
        '</div>'
      : '<div class="dh-empty" role="status"><span aria-hidden="true">◌</span><strong>还没有员工数字人档案</strong>' +
        '<p>档案把员工主体和它的形象、声音版本绑在一起（N05）。在下方创建。</p></div>') +
    '<div class="dh-draft-form">' +
    '<label class="dh-field"><span>员工姓名（必填）</span><input type="text" data-dh-profile-field="name" value="' + dhEscape(dhProfileForm.name) + '" /></label>' +
    '<label class="dh-field"><span>岗位</span><input type="text" data-dh-profile-field="subjectRole" value="' + dhEscape(dhProfileForm.subjectRole) + '" /></label>' +
    '<label class="dh-field"><span>绑定形象版本</span><select data-dh-profile-field="avatarVersionId">' +
    '<option value="">（选择形象）</option>' +
    (dhAssets.data?.modeA?.avatars?.options || []).map((item) => '<option value="' + dhEscape(item.id) + '">' + dhEscape(item.name) + (item.usable ? '' : '（不可用）') + '</option>').join('') +
    '</select></label>' +
    '<label class="dh-field"><span>绑定声音版本</span><select data-dh-profile-field="voiceVersionId">' +
    '<option value="">（选择声音）</option>' +
    (dhAssets.data?.modeA?.voices?.options || []).map((item) => '<option value="' + dhEscape(item.id) + '">' + dhEscape(item.name) + (item.usable ? '' : '（不可用）') + '</option>').join('') +
    '</select></label>' +
    '</div>' +
    '<div class="dh-draft-foot">' +
    '<button class="button button-dark button-small" type="button" data-dh-profile-save' + (dhModeB.status === 'loading' ? ' disabled aria-disabled="true"' : '') + '>保存档案</button>' +
    '<small>处理状态：真实能力已接入（S7）：豆包克隆音色 + HeyGem 云 GPU，均通过真实样片验收</small>' +
    '</div>' +
    (dhModeB.error ? '<p class="dh-draft-message is-error" role="alert">' + dhEscape(dhModeB.error.message) + '</p>' : '') +
    '</section>'
  );
}

function dhModeBBlock() {
  const ready = dhModeB.status === 'ready' && dhModeB.data;
  const videos = ready ? dhModeB.data.videos : [];
  const mappings = ready ? dhModeB.data.mappings : [];
  return (
    '<section class="panel dh-asset-panel" aria-label="模式 B 已有视频与映射">' +
    '<div class="panel-heading"><div><div class="eyebrow">模式 B · 已有视频与映射 · N11–N12</div>' +
    '<h2>导入旧视频，显式映射到文案与模板</h2>' +
    '<p>导入只登记元信息（本阶段不解析真实文件）；映射必须四项齐全才算 ready，模式 B 行才能进入生产。</p></div>' +
    '<span class="phase-label">' + (mappings.length ? '完整映射 ' + (dhModeB.data.readyMappingCount || 0) + '/' + mappings.length : '无映射') + '</span></div>' +
    (videos.length
      ? '<div class="dh-asset-list">' +
        videos.map((video) =>
          '<article class="dh-asset-card' + (video.status === 'usable' ? ' is-ok' : ' is-gap') + '">' +
          '<div class="dh-asset-main"><strong>' + dhEscape(video.name) + '</strong>' +
          '<small>' + dhEscape(video.id.slice(0, 14)) + '…' + (video.durationSeconds ? ' · ' + video.durationSeconds + 's' : '') + (video.aspect ? ' · ' + dhEscape(video.aspect) : '') + '</small></div>' +
          '<div class="dh-asset-side"><span class="dh-chip">' + dhEscape(video.status) + '</span></div>' +
          '</article>').join('') +
        '</div>'
      : '<p class="dh-gate-note">还没有导入任何已有视频（N11）。</p>') +
    (mappings.length
      ? '<div class="dh-asset-list">' +
        mappings.map((mapping) =>
          '<article class="dh-asset-card' + (mapping.ready ? ' is-ok' : ' is-gap') + '">' +
          '<div class="dh-asset-main"><strong>' + dhEscape(mapping.video ? mapping.video.name : '（视频缺失）') + '</strong>' +
          '<small>文案：' + dhEscape(mapping.script ? mapping.script.title : '未映射') + ' · 模板：' + dhEscape(mapping.template ? mapping.template.name : '未映射') + '</small></div>' +
          '<div class="dh-asset-side">' + (mapping.ready ? '<span class="dh-chip dh-chip-real">映射完整</span>' : '<span class="dh-chip">不完整</span>') + '</div>' +
          (mapping.missing.length ? '<div class="dh-asset-actions"><small>缺：' + dhEscape(mapping.missing.join('、')) + '</small></div>' : '') +
          '</article>').join('') +
        '</div>'
      : '') +
    '<div class="dh-draft-form">' +
    '<label class="dh-field"><span>导入视频（名称，必填）</span><input type="text" data-dh-video-field="name" value="' + dhEscape(dhVideoForm.name) + '" /></label>' +
    '<label class="dh-field"><span>文件引用（可选）</span><input type="text" data-dh-video-field="fileRef" value="' + dhEscape(dhVideoForm.fileRef) + '" placeholder="例如 source/old-take" /></label>' +
    '<label class="dh-field"><span>时长（秒）</span><input type="number" min="1" data-dh-video-field="durationSeconds" value="' + dhEscape(String(dhVideoForm.durationSeconds || '')) + '" /></label>' +
    '<label class="dh-field"><span>画幅</span><select data-dh-video-field="aspect">' +
    ['9:16', '16:9', '1:1'].map((item) => '<option value="' + dhEscape(item) + '"' + (dhVideoForm.aspect === item ? ' selected' : '') + '>' + dhEscape(item) + '</option>').join('') +
    '</select></label>' +
    '<label class="dh-field"><span>映射：视频</span><select data-dh-map-field="videoId"><option value="">（选择视频）</option>' +
    videos.map((video) => '<option value="' + dhEscape(video.id) + '">' + dhEscape(video.name) + '</option>').join('') +
    '</select></label>' +
    '<label class="dh-field"><span>映射：文案（需已确认）</span><select data-dh-map-field="scriptVersionId"><option value="">（选择文案）</option>' +
    (dhCopy.data?.candidates || []).map((item) => '<option value="' + dhEscape(item.id) + '">' + dhEscape(item.title) + (item.confirmed ? '' : '（未确认）') + '</option>').join('') +
    '</select></label>' +
    '<label class="dh-field"><span>映射：声音来源</span><select data-dh-map-field="voiceSource">' +
    '<option value="original"' + (dhMappingForm.voiceSource === 'original' ? ' selected' : '') + '>视频原声</option>' +
    '<option value="voice_version"' + (dhMappingForm.voiceSource === 'voice_version' ? ' selected' : '') + '>指定声音版本</option>' +
    '</select></label>' +
    '<label class="dh-field"><span>映射：模板</span><select data-dh-map-field="templateVersionId"><option value="">（选择模板）</option>' +
    (dhAssets.data?.templates?.options || []).map((item) => '<option value="' + dhEscape(item.id) + '">' + dhEscape(item.name) + '</option>').join('') +
    '</select></label>' +
    '</div>' +
    '<div class="dh-draft-foot">' +
    '<button class="button button-dark button-small" type="button" data-dh-video-import>导入视频</button>' +
    '<button class="button button-secondary button-small" type="button" data-dh-map-save>保存映射</button>' +
    '<button class="button button-secondary button-small" type="button" data-dh-modeb-reload>重新读取</button>' +
    '<small>完整映射的 id 可以被 P06 的模式 B 明细行引用。</small>' +
    '</div></section>'
  );
}


/* ---------------------------------------------------------------------------
   资产创建（P03）：创建数字人 / 克隆声音——参照云客数字人的交互，落到我们的资产接口
   --------------------------------------------------------------------------- */

/* 在线录制（浏览器 MediaRecorder）：录制 → 变成可上传的音频，无需先存文件 */
const dhRecorder = { mediaRecorder: null, chunks: [], seconds: 0, timer: null, state: 'idle', error: null };

function dhRecorderText() {
  if (dhRecorder.state === 'recording') return '录制中 ' + dhRecorder.seconds + ' 秒（建议 30 秒以上，至少 10 秒）';
  if (dhRecorder.state === 'ready') return '已录制 ' + dhRecorder.seconds + ' 秒，可直接保存';
  return '点「开始录制」使用麦克风（需浏览器允许麦克风权限）';
}

async function dhToggleRecording() {
  dhRecorder.error = null;
  if (dhRecorder.state === 'recording') {
    dhRecorder.mediaRecorder?.stop();
    dhRecorder.state = 'ready';
    if (dhRecorder.timer) { clearInterval(dhRecorder.timer); dhRecorder.timer = null; }
    dhRender();
    return;
  }
  if (dhRecorder.state === 'ready') {
    dhRecorder.chunks = [];
    dhRecorder.seconds = 0;
    dhRecorder.state = 'idle';
    dhRender();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    dhRecorder.chunks = [];
    dhRecorder.seconds = 0;
    recorder.ondataavailable = (event) => { if (event.data && event.data.size) dhRecorder.chunks.push(event.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      dhCreate.recordedAudio = new Blob(dhRecorder.chunks, { type: dhRecorder.chunks[0]?.type || 'audio/webm' });
      dhRender();
    };
    recorder.start();
    dhRecorder.mediaRecorder = recorder;
    dhRecorder.state = 'recording';
    dhRecorder.timer = setInterval(() => { dhRecorder.seconds += 1; dhRender(); }, 1000);
    dhRender();
  } catch (error) {
    dhRecorder.state = 'idle';
    dhRecorder.error = '无法访问麦克风：' + (error.message || '权限被拒绝') + '（可在浏览器设置里允许麦克风，或改用上传音频）';
    dhRender();
  }
}

const dhCreate = { tab: 'avatar', kind: 'video', busy: false, message: null, error: null };

function dhRenderCreatePanel() {
  const busy = dhCreate.busy ? ' disabled aria-disabled="true"' : '';
  const message = dhCreate.error
    ? '<p class="dh-draft-message is-error" role="alert">' + dhEscape(dhCreate.error) + '</p>'
    : dhCreate.message
      ? '<p class="dh-draft-message" role="status">' + dhEscape(dhCreate.message) + '</p>'
      : '';
  const tabs = '<div class="dh-scenario-tabs" role="tablist">' +
    '<button class="dh-scenario-tab' + (dhCreate.tab === 'avatar' ? ' is-active' : '') + '" type="button" data-dh-create-tab="avatar">创建数字人</button>' +
    '<button class="dh-scenario-tab' + (dhCreate.tab === 'voice' ? ' is-active' : '') + '" type="button" data-dh-create-tab="voice">克隆声音</button>' +
    '</div>';
  if (dhCreate.tab === 'avatar') {
    return '<section class="dh-block" aria-label="创建数字人">' +
      '<h3>创建数字人</h3>' + tabs +
      '<div class="dh-draft-form">' +
      '<label class="dh-field"><span>数字人名称（必填）</span><input type="text" data-dh-create-field="avatarName" placeholder="例如 侯云龙" /></label>' +
      '<label class="dh-field"><span>类型</span><select data-dh-create-field="avatarKind">' +
      '<option value="video"' + (dhCreate.kind === 'video' ? ' selected' : '') + '>视频数字人（上传一段真实视频，口型与动作随视频）</option>' +
      '<option value="photo"' + (dhCreate.kind === 'photo' ? ' selected' : '') + '>照片数字人（上传一张清晰正脸照）</option>' +
      '</select></label>' +
      '<label class="dh-field"><span>素材文件（必需）</span><input type="file" data-dh-create-field="avatarFile" accept="video/*,image/*" /></label>' +
      '<label class="dh-field"><span>绑定声音版本（可留空，稍后在档案里绑定）</span><select data-dh-create-field="avatarVoice">' +
      '<option value="">（不绑定）</option>' +
      ((dhAssets.data?.modeA?.voices?.options) || []).map((item) => '<option value="' + dhEscape(item.id) + '">' + dhEscape(item.name) + '</option>').join('') +
      '</select></label>' +
      '<label class="dh-field dh-field-inline"><input type="checkbox" data-dh-create-field="avatarAuthorized" /> <span>素材由本人提供并已获授权（勾选后立即可用于批量；不勾选则保存为待确认）</span></label>' +
      '</div>' +
      '<div class="dh-draft-foot">' +
      '<button class="button button-dark button-small" type="button" data-dh-create-avatar' + busy + '>保存数字人</button>' +
      '<small>保存后进入下方形象版本列表；用于批量生产还需「审核通过 + 开启批量」。</small>' +
      '</div>' + message + '</section>';
  }
  return '<section class="dh-block" aria-label="克隆声音">' +
    '<h3>克隆声音</h3>' + tabs +
    '<div class="dh-draft-form">' +
    '<label class="dh-field"><span>声音名称（必填）</span><input type="text" data-dh-create-field="voiceName" placeholder="例如 侯云龙声音" /></label>' +
    '<label class="dh-field"><span>声音模型</span><select data-dh-create-field="voiceModel">' +
    '<option value="seed-tts-2.0-standard">情感版（推荐）</option>' +
    '<option value="seed-tts-1.0">标准版</option>' +
    '</select></label>' +
    '<div class="dh-field"><span>参考音频（二选一：在线录制 或 上传文件）</span>' +
    '<div class="dh-draft-foot">' +
    '<button class="button button-small" type="button" data-dh-record>' + (dhRecorder.state === 'recording' ? '■ 停止录制' : (dhRecorder.state === 'ready' ? '↻ 重新录制' : '● 开始录制')) + '</button>' +
    '<small>' + dhEscape(dhRecorder.error || dhRecorderText()) + '</small>' +
    '</div></div>' +
    '<label class="dh-field"><span>参考音频文件（选填；已录音则忽略此项）</span><input type="file" data-dh-create-field="voiceFile" accept="audio/*" /></label>' +
    '<label class="dh-field"><span>参考文本（音频里说的内容，用于复刻比对）</span><input type="text" data-dh-create-field="voiceTranscript" placeholder="例如：大家好，今天讲讲工作手机" /></label>' +
    '<label class="dh-field"><span>豆包复刻槽位 S_ ID（可选，填了才会触发训练；没填先登记待复刻）</span><input type="text" data-dh-create-field="voiceSpeaker" placeholder="例如 S_C8a62LEV1" /></label>' +
    '<label class="dh-field dh-field-inline"><input type="checkbox" data-dh-create-field="voiceAuthorized" /> <span>声音由本人提供并已获授权（勾选后立即可用于批量）</span></label>' +
    '</div>' +
    '<div class="dh-draft-foot">' +
    '<button class="button button-dark button-small" type="button" data-dh-create-voice' + busy + '>保存声音</button>' +
    '<small>复刻训练由豆包声音复刻 2.0 完成，分钟级生效；训练与登记都会写入活动记录。</small>' +
    '</div>' + message + '</section>';
}

function dhCreateField(name) {
  const node = dhRoot ? dhRoot.querySelector('[data-dh-create-field="' + name + '"]') : null;
  return node ? node.value.trim() : '';
}

async function dhReadFileAsBase64(input) {
  const file = input?.files?.[0];
  if (!file) return null;
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, data: String(reader.result) });
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

async function dhUploadAsset(input, kind) {
  const file = await dhReadFileAsBase64(input);
  if (!file) throw new Error('请先选择文件');
  const payload = await dhApi('/api/content/digital-human/upload-asset', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, filename: file.name, dataBase64: file.data }),
  });
  return payload.ref;
}

async function dhSubmitAvatarCreate() {
  const name = dhCreateField('avatarName');
  const kind = dhCreateField('avatarKind') || 'video';
  if (!name) { dhCreate.error = '请填写数字人名称'; dhRender(); return; }
  dhCreate.busy = true; dhCreate.error = null; dhCreate.message = '正在上传素材…'; dhRender();
  try {
    const ref = await dhUploadAsset(dhRoot.querySelector('[data-dh-create-field="avatarFile"]'), kind === 'photo' ? 'image' : 'video');
    const authorized = Boolean(dhRoot.querySelector('[data-dh-create-field="avatarAuthorized"]')?.checked);
    dhCreate.message = '正在登记资产…'; dhRender();
    const created = await dhApi('/api/content/avatar-profiles', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        displayName: name + '形象 V1',
        canonicalImageRef: kind === 'photo' ? ref : null,
        baseVideoRef: kind === 'video' ? ref : null,
        provider: 'heygem-autodl-ssh',
        modelVersion: 'heygem-autodl-ssh',
        authorizationStatus: authorized ? 'approved' : 'pending',
        authorizationRef: authorized ? 'user-confirmed:' + new Date().toISOString() : null,
        approved: authorized,
        batchAllowed: authorized,
        notes: kind === 'photo' ? '照片数字人（单图驱动，待 provider 支持后启用）' : '视频数字人（真实素材）',
      }),
    });
    dhCreate.busy = false;
    dhCreate.message = '数字人已创建：' + (created.profile?.name || name) + '（' + (authorized ? '已授权，可用于批量' : '待确认授权') + '）';
    await dhLoadAssets();
  } catch (error) {
    dhCreate.busy = false;
    dhCreate.error = '创建数字人失败：' + (error.message || '未知错误');
    dhRender();
  }
}

async function dhSubmitVoiceCreate() {
  const name = dhCreateField('voiceName');
  const model = dhCreateField('voiceModel') || 'seed-tts-2.0-standard';
  const transcript = dhCreateField('voiceTranscript');
  const speaker = dhCreateField('voiceSpeaker');
  if (!name) { dhCreate.error = '请填写声音名称'; dhRender(); return; }
  dhCreate.busy = true; dhCreate.error = null; dhCreate.message = '正在上传音频…'; dhRender();
  try {
    let ref = null;
    if (dhCreate.recordedAudio) {
      const blob = dhCreate.recordedAudio;
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('读取录音失败'));
        reader.readAsDataURL(blob);
      });
      const uploaded = await dhApi('/api/content/digital-human/upload-asset', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'audio', filename: 'recorded-' + Date.now() + '.webm', dataBase64: base64 }),
      });
      ref = uploaded.ref;
    } else {
      ref = await dhUploadAsset(dhRoot.querySelector('[data-dh-create-field="voiceFile"]'), 'audio');
    }
    const authorized = Boolean(dhRoot.querySelector('[data-dh-create-field="voiceAuthorized"]')?.checked);
    if (speaker) {
      dhCreate.message = '正在提交复刻训练…'; dhRender();
      await dhApi('/api/content/digital-human/clone-voice-register', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, audioFile: ref, referenceText: transcript || name, speakerId: speaker }),
      });
    }
    dhCreate.message = '正在登记声音资产…'; dhRender();
    const created = await dhApi('/api/content/voice-profiles', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        displayName: name + ' V1',
        referenceAudioRef: ref,
        referenceTranscript: transcript || null,
        voiceName: speaker || null,
        provider: 'doubao-voice-clone-2.0',
        modelVersion: model,
        authorizationStatus: authorized ? 'approved' : 'pending',
        authorizationRef: authorized ? 'user-confirmed:' + new Date().toISOString() : null,
        approved: authorized,
        batchAllowed: authorized,
        notes: speaker ? '复刻已提交（槽位 ' + speaker + '）' : '已登记参考音频，待创建复刻槽位后训练',
      }),
    });
    dhCreate.busy = false;
    dhCreate.message = '声音已创建：' + (created.profile?.name || name) + (speaker ? '（复刻训练已提交）' : '（待复刻槽位）');
    await dhLoadAssets();
  } catch (error) {
    dhCreate.busy = false;
    dhCreate.error = '创建声音失败：' + (error.message || '未知错误');
    dhRender();
  }
}

function dhRenderAssets() {
  const ready = dhAssets.status === 'ready' && dhAssets.data;
  const data = ready ? dhAssets.data : null;
  dhRoot.innerHTML =
    dhRealBanner() +
    '<div class="view-intro-row">' +
    '<div><span class="view-context">云员工 / 内容编辑 · AI 数字人口播</span>' +
    '<p>P03 数字人资产 · P04 已有视频 · P05 场景模板：按模式 A / 模式 B 分区选择生产资产。可在本页创建数字人、克隆声音，并选择资产用于批量生产。</p></div>' +
    '<span class="view-intro-status">P03–P05 · 生产资产</span>' +
    '</div>' +
    '<div class="dh-toolbar">' +
    '<div class="dh-context" aria-label="当前项目上下文">' +
    '<span><small>项目</small><strong>' + dhEscape(dhReal.summary?.project?.name || '（读取中）') + '</strong></span>' +
    '<span><small>模式 A</small><strong>' + (data?.modeA?.ready ? '资产齐全' : '资产不齐') + '</strong></span>' +
    '<span><small>模式 B</small><strong>未接入</strong></span>' +
    '</div>' +
    '<div class="dh-toolbar-actions">' +
    '<button class="button button-secondary button-small" type="button" data-dh-page="' + DH_PAGE_P01 + '">← 返回生产中心</button>' +
    '<button class="button button-secondary button-small" type="button" data-dh-assets-reload' +
    (dhAssets.status === 'loading' ? ' disabled aria-disabled="true"' : '') + '>重新读取资产</button>' +
    '</div>' +
    '</div>' +
    dhNoticeBlock() +
    (dhAssets.status === 'loading'
      ? dhLoadingBlock()
      : dhAssets.status === 'error'
        ? '<section class="dh-error" role="alert"><span class="dh-error-mark" aria-hidden="true">!</span>' +
          '<div><strong>资产数据读取失败，因此这里不显示任何资产</strong>' +
          '<p>' + dhEscape(dhAssets.error?.message || '未知错误') + '</p>' +
          '<small>页面不会用示例资产冒充真实资产库。</small></div>' +
          '<button class="button button-secondary button-small" type="button" data-dh-assets-reload>重新读取</button></section>'
        : '') +
    (ready
      ? dhLayout(
          dhFlowBar() +
          '<section class="panel dh-asset-panel" aria-label="模式 A 资产">' +
          '<div class="panel-heading"><div><div class="eyebrow">模式 A · 文案 + 数字人生成视频</div>' +
          '<h2>数字人形象与声音</h2>' +
          '<p>只有「已审核 + 已开启批量使用」的版本可以进入批量生产；选择会写入生产草稿。</p></div>' +
          '<span class="phase-label">' + (data.modeA.ready ? '资产齐全' : '资产不齐') + '</span></div>' +
          dhProfilesBlock() +
          dhAssetGroupBlock('数字人形象版本（P03）', data.modeA.avatars, 'avatar', data.selected.avatarVersionId, '还没有任何数字人形象版本') +
          dhAssetGroupBlock('数字人声音版本（P03）', data.modeA.voices, 'voice', data.selected.voiceVersionId, '还没有任何数字人声音版本') +
          '</section>' +
          dhModeBBlock() +
          '<section class="panel dh-asset-panel" aria-label="场景模板">' +
          '<div class="panel-heading"><div><div class="eyebrow">共用 · 模式 A 与模式 B 都使用</div>' +
          '<h2>场景模板（P05）</h2>' +
          '<p>模板决定背景、布局、字幕、比例、片头片尾等真实配置。</p></div></div>' +
          dhAssetGroupBlock('场景模板版本（P05）', data.templates, 'template', data.selected.templateVersionId, '还没有任何场景模板') +
          '</section>',
          dhAssetGate() +
          dhAssetSourceBar() +
          dhN18ProvidersBlock(data) +
          dhAssetSelectionSummary() +
          (dhDraft.saveMessage
            ? '<p class="dh-draft-message' + (dhDraft.saveState === 'error' ? ' is-error' : '') + '" role="status">' +
              dhEscape(dhDraft.saveMessage) + '</p>'
            : '')
        )
      : '') +
    '<footer class="dh-footnote">' +
    '<span>当前切片：F5-04 生产资产（P03/P04/P05）</span>' +
    '<span>后续：F5-05 P06 生产任务 → F5-06 P07 人工验收 → F5-07 P08 内容包</span>' +
    '</footer>';
}

function dhAssetGate() {
  const data = dhAssets.data || {};
  const issues = Array.isArray(data.blockingIssues) ? data.blockingIssues : [];
  const nextAction = data.nextAction || 'nothing_pending';
  return (
    '<section class="panel dh-gate" aria-label="资产状态闸门">' +
    '<div class="panel-heading"><div><div class="eyebrow">状态闸门</div>' +
    '<h2>资产能不能进入批量生产</h2>' +
    '<p>判定来自服务端投影：approved + batchAllowed 才可用，与 buildBatchPlan 同一规则。</p></div>' +
    '<span class="phase-label">next_action：' + dhEscape(dhNextActionText(nextAction)) + '</span></div>' +
    '<div class="dh-gate-col">' +
    '<h3>blocking_issues（' + issues.length + '）</h3>' +
    (issues.length
      ? '<ul class="dh-gate-issues">' +
        issues.map((item) => '<li><code>' + dhEscape(item.code) + '</code><span>' +
          dhEscape(item.message) + '</span></li>').join('') + '</ul>'
      : '<p class="dh-gate-empty">当前没有阻塞项。</p>') +
    '</div>' +
    '</section>'
  );
}

function dhAssetSourceBar() {
  const source = dhAssets.data?.source || {};
  return (
    '<section class="dh-source" aria-label="资产数据来源">' +
    '<div class="dh-source-head"><div><span class="dh-source-tag">数据源</span>' +
    '<strong>资产来自目录真实接口</strong></div>' +
    '<button class="button button-secondary button-small" type="button" data-dh-assets-reload>重新读取</button></div>' +
    '<dl class="dh-source-list">' +
    '<div><dt>接口</dt><dd><code>' + dhEscape((source.endpoints || [DH_ASSETS_ENDPOINT])[0]) + '</code></dd></div>' +
    '<div><dt>读取时间</dt><dd>' + dhEscape(dhFormatTime(source.readAt)) + '</dd></div>' +
    '<div><dt>项目</dt><dd>' + dhEscape(source.projectName || '—') + '</dd></div>' +
    '</dl>' +
    '</section>'
  );
}

function dhAssetSelectionSummary() {
  const selected = dhAssets.data?.selected || {};
  const rows = [
    { label: '形象版本', value: selected.avatar?.name || selected.avatarVersionId },
    { label: '声音版本', value: selected.voice?.name || selected.voiceVersionId },
    { label: '模板版本', value: selected.template?.name || selected.templateVersionId },
    { label: '文案版本', value: dhCopy.data?.selectedScriptVersionId || null },
  ];
  const filled = rows.filter((row) => row.value);
  return (
    '<section class="panel dh-side-block" aria-label="已选资产汇总">' +
    '<div class="panel-heading"><div><div class="eyebrow">已选资产</div>' +
    '<h2>这次生产会用什么</h2>' +
    '<p>所有选择都写入同一条生产草稿，P01 可以看到，刷新不丢。</p></div></div>' +
    (filled.length
      ? '<dl class="dh-source-list">' +
        rows.map((row) => '<div><dt>' + dhEscape(row.label) + '</dt><dd>' + dhEscape(row.value || '未选择') + '</dd></div>').join('') +
        '</dl>'
      : '<p class="dh-gate-note">还没有选择任何资产。可用资产右侧有「选入草稿」按钮。</p>') +
    '</section>'
  );
}

/* 模式切换：真实数据 / 四种演示状态。 */
function dhModeSwitcher() {
  const options = [{ id: DH_MODE_REAL, label: '真实数据' }].concat(
    DH_SCENARIOS.map((item) => ({ id: item.id, label: item.label })),
  );
  const active = dhState.scenarioId;
  const isDemo = active !== DH_MODE_REAL;
  return (
    '<section class="dh-scenario panel" aria-label="数据来源切换">' +
    '<div class="dh-scenario-head"><div><div class="eyebrow">数据来源</div>' +
    '<h2>真实数据 / 演示状态</h2>' +
    '<p>' +
    (isDemo
      ? '当前显示的是<strong>演示 fixture</strong>，用来验收页面能完整表达空状态、草稿、等待人工验收和部分失败；它不是真实生产结果。'
      : '当前显示的是<strong>后端真实数据</strong>。演示状态仍然保留，用于验收页面骨架，且始终标记为演示数据。') +
    '</p></div></div>' +
    '<div class="dh-scenario-tabs" role="tablist" aria-label="数据来源切换">' +
    options
      .map(
        (item) =>
          '<button class="dh-scenario-tab' + (item.id === active ? ' is-active' : '') +
          '" type="button" role="tab" aria-selected="' + String(item.id === active) +
          '" data-dh-scenario="' + dhEscape(item.id) + '">' +
          dhEscape(item.label) + '</button>',
      )
      .join('') +
    '</div>' +
    '</section>'
  );
}

function dhRender() {
  if (!dhRoot) {
    return;
  }
  if (dhState.page === DH_PAGE_P02) {
    dhRenderCopy();
    return;
  }
  if (dhState.page === DH_PAGE_ASSETS) {
    dhRenderAssets();
    return;
  }
  if (dhState.page === DH_PAGE_TASK) {
    dhRenderTask();
    return;
  }
  if (dhState.page === DH_PAGE_RESULTS) {
    dhRenderResults();
    return;
  }
  if (dhState.page === DH_PAGE_PACKAGE) {
    dhRenderPackage();
    return;
  }
  if (dhIsRealMode()) {
    dhRenderReal();
    return;
  }
  dhRenderDemo();
}

function dhGoToPage(page) {
  if (!dhIsValidPage(page)) {
    return;
  }
  if (dhState.page === DH_PAGE_P02 && page !== DH_PAGE_P02) {
    dhSyncContextFormsFromDom();
    dhSyncCopyFormFromDom();
  }
  dhState.page = page;
  dhWriteStoredPage(page);
  dhState.notice = null;
  dhRender();
  if (!dhIsRealMode()) {
    return;
  }
  if (page === DH_PAGE_P02) {
    if (dhProjects.status === 'idle') dhLoadProjects();
    if (dhCopy.status !== 'ready') dhLoadCopy();
    if (dhContexts.status !== 'ready') dhLoadContexts();
  }
  if (page === DH_PAGE_ASSETS && dhAssets.status !== 'ready') {
    dhLoadAssets();
  dhLoadCapability();
  }
  if (page === DH_PAGE_TASK && dhWorkspace.status !== 'ready') {
    dhLoadWorkspace();
  }
  if (page === DH_PAGE_RESULTS && dhResults.status !== 'ready') {
    dhLoadResults();
  }
  if (page === DH_PAGE_PACKAGE && dhPackage.status !== 'ready') {
    dhLoadPackage();
  }
}

function dhRenderDemo() {
  const scenario = dhCurrentScenario();
  dhRoot.innerHTML =
    '<div class="dh-demo-banner" role="note">' +
    '<strong>演示数据</strong>' +
    '<span>本页未连接任何真实数字人 / TTS / 口型同步 / 视频渲染能力，下面所有任务、明细、进度和结果都是本地示例，不代表任何真实视频已经生成，也不能作为交付物。真实能力已接入，切到「真实数据」即可查看实际状态。</span>' +
    '</div>' +
    '<div class="view-intro-row">' +
    '<div><span class="view-context">云员工 / 内容编辑 · AI 数字人口播</span>' +
    '<p>用已确认文案、员工数字人或已有视频，生成并人工验收口播视频。这是内容编辑云员工下面的批量生产中心，不是独立产品。</p></div>' +
    '<span class="view-intro-status">P01 · 页面骨架</span>' +
    '</div>' +
    '<div class="dh-toolbar">' +
    '<div class="dh-context" aria-label="当前行业与项目上下文">' +
    '<span><small>行业</small><strong>' +
    dhEscape(scenario.context.industry) +
    '</strong></span>' +
    '<span><small>项目</small><strong>' +
    dhEscape(scenario.context.project) +
    '</strong></span>' +
    '<span><small>负责人</small><strong>' +
    dhEscape(scenario.context.owner) +
    '</strong></span>' +
    '</div>' +
    '<div class="dh-toolbar-actions">' +
    '<button class="button button-secondary button-small" type="button" data-dh-back>← 返回内容编辑</button>' +
    '<button class="button button-secondary button-small" type="button" data-dh-reset>重置演示状态</button>' +
    '<button class="button button-dark" type="button" data-dh-notice="F5-05" data-dh-notice-title="新建生产任务">' +
    '+ 新建生产任务</button>' +
    '</div>' +
    '</div>' +
    dhNoticeBlock() +
    dhSummaryCards(scenario) +
    dhModeSwitcher() +
    dhContinueCard(scenario) +
    dhStartCards() +
    dhModeCards() +
    '<section class="panel dh-queue" aria-label="生产任务队列">' +
    '<div class="panel-heading"><div><div class="eyebrow">生产任务队列</div>' +
    '<h2>任务列表</h2><p>单条和批量共用同一套任务结构；这里显示的是演示数据。</p></div>' +
    dhFilterTabs(scenario) +
    '</div>' +
    dhTaskList(scenario) +
    '</section>' +
    '<footer class="dh-footnote">' +
    '<span>当前切片：F5-02 最小数据读取与状态投影（本页为演示状态）</span>' +
    '<span>后续：F5-03 P02 项目与文案 → F5-04 P03/P04/P05 资产 → F5-05 P06 生产任务 → F5-06 P07 人工验收 → F5-07 P08 内容包</span>' +
    '</footer>';
}

/* ---------------------------------------------------------------------------
   交互
   --------------------------------------------------------------------------- */

function dhGoHome() {
  if (window.location.hash === '#' + DH_HOME_VIEW) {
    return;
  }
  window.location.hash = '#' + DH_HOME_VIEW;
}

function dhSetNotice(slice, title) {
  dhState.notice = {
    title: title ? title + '：待实现' : '该能力待实现',
    detail:
      '这个动作属于 ' +
      slice +
      '，当前切片只建立入口和页面骨架，因此不会执行任何真实生产动作。',
    slice,
  };
  dhRender();
  dhRoot.querySelector('.dh-notice')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function dhHandleClick(event) {
  const open = event.target.closest('[data-dh-open]');
  if (open) {
    window.location.hash = '#' + DH_VIEW;
    return;
  }
  const prefillClear = event.target.closest('[data-dh-prefill-clear]');
  if (prefillClear) {
    /* F5-C2：只清除带入的监控作品参考，不影响任何生产数据。 */
    dhWorkPrefill.record = null;
    try {
      window.sessionStorage.removeItem(DH_PREFILL_KEY);
    } catch {
      /* 存储不可用时仅清内存态。 */
    }
    dhRender();
    return;
  }
  const back = event.target.closest('[data-dh-back]');
  if (back) {
    dhGoHome();
    return;
  }
  const copyTab = event.target.closest('[data-dh-copy-tab]');
  if (copyTab) {
    const tab = copyTab.dataset.dhCopyTab;
    if (dhIsValidCopyTab(tab)) {
      dhSyncContextFormsFromDom();
      dhSyncCopyFormFromDom();
      dhState.copyTab = tab;
      dhWriteStoredCopyTab(tab);
      dhRender();
      if ((tab === 'profile' || tab === 'request') && ['idle', 'error'].includes(dhContexts.status)) {
        dhLoadContexts();
      }
    }
    return;
  }
  const pageButton = event.target.closest('[data-dh-page]');
  if (pageButton) {
    dhGoToPage(pageButton.dataset.dhPage);
    return;
  }
  const copySelect = event.target.closest('[data-dh-copy-select]');
  if (copySelect) {
    dhSelectCopy(copySelect.dataset.dhCopySelect);
    return;
  }
  const copyExpand = event.target.closest('[data-dh-copy-expand]');
  if (copyExpand) {
    const id = copyExpand.dataset.dhCopyExpand;
    if (dhCopyUi.expanded.has(id)) dhCopyUi.expanded.delete(id);
    else dhCopyUi.expanded.add(id);
    dhRender();
    return;
  }
  const copyReload = event.target.closest('[data-dh-copy-reload]');
  if (copyReload) {
    dhSyncCopyFormFromDom();
    dhLoadCopy();
    return;
  }
  const assetsReload = event.target.closest('[data-dh-assets-reload]');
  if (assetsReload) {
    dhLoadAssets();
    return;
  }
  const rowAdd = event.target.closest('[data-dh-row-add]');
  if (rowAdd) {
    dhAddTaskRow();
    return;
  }
  const rowRealGen = event.target.closest('[data-dh-row-real-gen]');
  if (rowRealGen) {
    dhRunRealGenerate(Number(rowRealGen.dataset.dhRowRealGen));
    return;
  }
  const rowRemove = event.target.closest('[data-dh-row-remove]');
  if (rowRemove) {
    dhRemoveTaskRow(Number(rowRemove.dataset.dhRowRemove));
    return;
  }
  const rowsSave = event.target.closest('[data-dh-rows-save]');
  if (rowsSave) {
    dhSaveTaskRows();
    return;
  }
  const recordBtn = event.target.closest('[data-dh-record]');
  if (recordBtn) { dhToggleRecording(); return; }
  const createBatch = event.target.closest('[data-dh-create-batch]');
  if (createBatch) { dhCreateProductionBatch(); return; }
  const lockAssets = event.target.closest('[data-dh-lock-assets]');
  if (lockAssets) { dhLockAssetsFromRows(); return; }
  const createTab = event.target.closest('[data-dh-create-tab]');
  if (createTab) { dhCreate.tab = createTab.dataset.dhCreateTab; dhCreate.error = null; dhCreate.message = null; dhRender(); return; }
  const createAvatar = event.target.closest('[data-dh-create-avatar]');
  if (createAvatar) { dhSubmitAvatarCreate(); return; }
  const createVoice = event.target.closest('[data-dh-create-voice]');
  if (createVoice) { dhSubmitVoiceCreate(); return; }
  const createKind = event.target.closest('[data-dh-create-field="avatarKind"]');
  if (createKind) { dhCreate.kind = createKind.value; return; }
  const stage8Load = event.target.closest('[data-dh-stage8-load]');
  if (stage8Load) { dhLoadStage8(); return; }
  const stage8Run = event.target.closest('[data-dh-stage8-run]');
  if (stage8Run) { dhRunBatch(); return; }
  const stage8Package = event.target.closest('[data-dh-stage8-package]');
  if (stage8Package) { dhExportPackage(); return; }
  const stage8Approve = event.target.closest('[data-dh-stage8-approve]');
  if (stage8Approve) { dhReviewItem(stage8Approve.dataset.dhStage8Approve, 'approved'); return; }
  const stage8Reject = event.target.closest('[data-dh-stage8-reject]');
  if (stage8Reject) { dhReviewItem(stage8Reject.dataset.dhStage8Reject, 'changes_requested'); return; }
  const stage8Retry = event.target.closest('[data-dh-stage8-retry]');
  if (stage8Retry) { dhRetryItem(stage8Retry.dataset.dhStage8Retry); return; }
  const preflightRun = event.target.closest('[data-dh-preflight-run]');
  if (preflightRun) {
    dhRunPreflight();
    return;
  }
  const ctxSelect = event.target.closest('[data-dh-ctx-select]');
  if (ctxSelect) {
    dhSelectContext(ctxSelect.dataset.dhCtxSelect);
    return;
  }
  const ctxSaveNew = event.target.closest('[data-dh-ctx-save-new]');
  if (ctxSaveNew) {
    dhSyncContextFormsFromDom();
    dhSaveContext(false);
    return;
  }
  const ctxSaveEdit = event.target.closest('[data-dh-ctx-save-edit]');
  if (ctxSaveEdit) {
    dhSyncContextFormsFromDom();
    dhSaveContext(true);
    return;
  }
  const ctxEdit = event.target.closest('[data-dh-ctx-edit]');
  if (ctxEdit) {
    const selected = (dhContexts.data?.versions || []).find((c) => c.id === dhContexts.data?.selectedContextId) || (dhContexts.data?.versions || [])[0];
    if (selected) {
      dhContextForm.contextKey = selected.contextKey;
      dhContextForm.name = selected.name || '';
      dhContextForm.industry = selected.industry || '';
      dhContextForm.product = selected.product || '';
      dhContextForm.audience = selected.audience || '';
      dhContextForm.sellingPoints = (selected.sellingPoints || []).join('；');
      dhContextForm.contentGoal = selected.contentGoal || '';
    }
    dhRender();
    return;
  }
  const reqSave = event.target.closest('[data-dh-req-save]');
  if (reqSave) {
    dhSyncContextFormsFromDom();
    dhSaveCopyRequest();
    return;
  }
  const contextsReload = event.target.closest('[data-dh-contexts-reload]');
  if (contextsReload) {
    dhSyncContextFormsFromDom();
    dhLoadContexts();
    return;
  }
  const profileSave = event.target.closest('[data-dh-profile-save]');
  if (profileSave) {
    dhSyncAssetFormsFromDom();
    dhSaveProfile();
    return;
  }
  const videoImport = event.target.closest('[data-dh-video-import]');
  if (videoImport) {
    dhSyncAssetFormsFromDom();
    dhImportVideo();
    return;
  }
  const mapSave = event.target.closest('[data-dh-map-save]');
  if (mapSave) {
    dhSyncAssetFormsFromDom();
    dhSaveMapping();
    return;
  }
  const modebReload = event.target.closest('[data-dh-modeb-reload]');
  if (modebReload) {
    dhLoadModeB();
    return;
  }
  const reviewBtn = event.target.closest('[data-dh-review]');
  if (reviewBtn) {
    const [batchId, itemId, decision] = reviewBtn.dataset.dhReview.split('|');
    dhItemReview(batchId, itemId, decision, '');
    return;
  }
  const retryBtn = event.target.closest('[data-dh-retry]');
  if (retryBtn) {
    const [batchId, itemId] = retryBtn.dataset.dhRetry.split('|');
    dhBatchAction(batchId, 'items/' + encodeURIComponent(itemId) + '/retry');
    return;
  }
  const runBtn = event.target.closest('[data-dh-run]');
  if (runBtn) {
    dhBatchAction(runBtn.dataset.dhRun, 'start');
    return;
  }
  const exportBtn = event.target.closest('[data-dh-export]');
  if (exportBtn) {
    dhBatchExport(exportBtn.dataset.dhExport);
    return;
  }
  const resultsReload = event.target.closest('[data-dh-results-reload]');
  if (resultsReload) {
    dhLoadResults();
    return;
  }
  const packageReload = event.target.closest('[data-dh-package-reload]');
  if (packageReload) {
    dhLoadPackage();
    return;
  }
  const batchCreate = event.target.closest('[data-dh-batch-create]');
  if (batchCreate) {
    dhCreateBatch();
    return;
  }
  const workspaceReload = event.target.closest('[data-dh-workspace-reload]');
  if (workspaceReload) {
    dhLoadWorkspace();
    return;
  }
  const assetSelect = event.target.closest('[data-dh-asset-select]');
  if (assetSelect) {
    dhSelectAsset(assetSelect.dataset.dhAssetSelect, assetSelect.dataset.dhAssetId);
    return;
  }
  if (event.target.closest('[data-dh-copy-toggle-register]')) {
    dhCopyUi.registerOpen = !dhCopyUi.registerOpen;
    dhRender();
    return;
  }
  if (event.target.closest('[data-dh-copy-focus-select]')) {
    dhRoot.querySelector('.dh-copy-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const copyRegister = event.target.closest('[data-dh-copy-register]');
  if (copyRegister) {
    dhSyncCopyFormFromDom();
    dhRegisterCopy();
    return;
  }
  const refresh = event.target.closest('[data-dh-refresh]');
  if (refresh) {
    dhLoadProjects();
    dhLoadSummary();
    /* 项目中心主页汇总三个接口，重新读取必须一起刷新，否则准备度会停在旧值。 */
    if (dhState.page === DH_PAGE_P02) {
      dhLoadContexts();
      dhLoadCopy();
    }
    return;
  }
  const projectPickSave = event.target.closest('[data-dh-project-pick-save]');
  if (projectPickSave) {
    /* 只接受下拉里真实存在的项目；空选择不触发切换。 */
    if (dhState.projectPick) dhSwitchProject(dhState.projectPick);
    return;
  }
  const ctxPickSave = event.target.closest('[data-dh-ctx-pick-save]');
  if (ctxPickSave) {
    dhSwitchContext(dhState.contextPick || dhContexts.data?.selectedContextId || null);
    return;
  }
  const saveDraft = event.target.closest('[data-dh-save-draft]');
  if (saveDraft) {
    dhSyncDraftFormFromDom();
    dhSaveDraft();
    return;
  }
  const reset = event.target.closest('[data-dh-reset]');
  if (reset) {
    dhState.scenarioId = DH_DEFAULT_SCENARIO;
    dhState.filter = 'all';
    dhState.notice = null;
    dhClearStoredScenario();
    dhRender();
    if (dhIsRealMode()) {
      dhLoadSummary();
    }
    return;
  }
  const scenarioButton = event.target.closest('[data-dh-scenario]');
  if (scenarioButton) {
    const id = scenarioButton.dataset.dhScenario;
    if (dhIsValidMode(id)) {
      dhState.scenarioId = id;
      dhState.filter = 'all';
      dhState.notice = null;
      dhWriteStoredScenario(id);
      dhRender();
      if (id === DH_MODE_REAL && dhReal.status !== 'ready') {
        dhLoadSummary();
      }
    }
    return;
  }
  const filterButton = event.target.closest('[data-dh-filter]');
  if (filterButton) {
    dhState.filter = filterButton.dataset.dhFilter;
    dhRender();
    return;
  }
  const taskButton = event.target.closest('[data-dh-task]');
  if (taskButton) {
    dhSetNotice('F5-05（P06 生产任务与显式明细）', '任务详情与继续处理');
    return;
  }
  const noticeButton = event.target.closest('[data-dh-notice]');
  if (noticeButton) {
    dhSetNotice(
      noticeButton.dataset.dhNotice,
      noticeButton.dataset.dhNoticeTitle,
    );
    return;
  }
  if (event.target.closest('[data-dh-notice-close]')) {
    dhState.notice = null;
    dhRender();
  }
}

/* 草稿表单的输入只改本地表单状态，不重新渲染，避免输入过程中丢焦点。 */
function dhHandleDraftInput(event) {
  const field = event.target.closest('[data-dh-draft-field]');
  if (!field) {
    return;
  }
  const key = field.dataset.dhDraftField;
  if (key === 'plannedItemCount') {
    dhDraftForm.plannedItemCount = Number(field.value) || 1;
  } else {
    dhDraftForm[key] = field.value;
  }
  dhDraft.saveState = 'idle';
  dhDraft.saveMessage = null;
}

/* ---------------------------------------------------------------------------
   初始化
   --------------------------------------------------------------------------- */

/* V4-02b：真实数据的引导顺序。项目列表必须第一批完成，
   因为它会归一 projectScope（单项目锁定 / 失效 id 清洗），后面的读取都带这个作用域。 */
async function dhBootRealData() {
  await dhLoadProjects();
  dhLoadSummary();
  dhLoadDraft();
  if (dhState.page === DH_PAGE_P02) {
    dhLoadCopy();
    dhLoadContexts();
  }
  if (dhState.page === DH_PAGE_ASSETS) {
    dhLoadAssets();
  }
  if (dhState.page === DH_PAGE_TASK) {
    dhLoadWorkspace();
  }
  if (dhState.page === DH_PAGE_RESULTS) {
    dhLoadResults();
  }
  if (dhState.page === DH_PAGE_PACKAGE) {
    dhLoadPackage();
  }
}

function dhInit() {
  if (!dhRoot) {
    return;
  }
  /* F5-C2：不再注入入口卡，入口由内容编辑父级页提供。 */
  dhRender();

  /* F5-02/F5-03：真实数据只在真实模式下读取。
     V4-02b：先读工作台项目并归一作用域，再按作用域读其余数据；
     否则单项目锁定或失效 id 清洗会让第一批请求带错（或空）projectId。 */
  if (dhIsRealMode()) {
    dhBootRealData();
  }

  /* F5-C2：入口按钮在内容编辑父级页上，这里只处理它的点击委托，不再注入 DOM。 */
  dhContentRoot?.addEventListener('click', (event) => {
    if (event.target.closest('[data-dh-open]')) {
      event.preventDefault();
      window.location.hash = '#' + DH_VIEW;
    }
  });

  /* F5-C2：接收监控中心带入的作品来源（唯一桥接的接收端）。
     不创建内容任务，只在 P02 显示来源供人工确认授权边界。 */
  dhWorkPrefill.record = dhReadWorkPrefill();
  window.addEventListener('content-work-prefill', (event) => {
    if (event.detail && typeof event.detail === 'object') {
      dhWorkPrefill.record = event.detail;
      try {
        window.sessionStorage.setItem(DH_PREFILL_KEY, JSON.stringify(event.detail));
      } catch {
        /* 存储不可用时仅保留内存态。 */
      }
    } else {
      dhWorkPrefill.record = dhReadWorkPrefill();
    }
    dhGoToPage(DH_PAGE_P02);
  });

  dhRoot.addEventListener('click', dhHandleClick);
  dhRoot.addEventListener('input', dhHandleDraftInput);
  dhRoot.addEventListener('change', (event) => {
    dhHandleDraftInput(event);
    if (event.target.closest('[data-dh-copy-field]')) {
      dhSyncCopyFormFromDom();
    }
    if (event.target.closest('[data-dh-row]')) {
      dhSyncTaskRowsFromDom();
    }
    if (event.target.closest('[data-dh-ctx-field]')) {
      dhSyncContextFormsFromDom();
    }
    const ctxPick = event.target.closest('[data-dh-ctx-pick]');
    if (ctxPick) {
      /* 只暂存待提交选择，页面不提前把它当成已生效的当前档案。 */
      dhState.contextPick = ctxPick.value || null;
      dhRender();
    }
    const projectPick = event.target.closest('[data-dh-project-pick]');
    if (projectPick) {
      /* 工作台项目同理：选择只暂存，点「切换项目」后才重新拉取该项目的数据。 */
      dhState.projectPick = projectPick.value || null;
      dhRender();
    }
    if (event.target.closest('[data-dh-profile-field]') || event.target.closest('[data-dh-video-field]') || event.target.closest('[data-dh-map-field]')) {
      dhSyncAssetFormsFromDom();
    }
  });
}

dhInit();
