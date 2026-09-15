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

function dhWriteStoredPage(page) {
  try {
    window.sessionStorage.setItem(DH_PAGE_KEY, page);
  } catch {
    // 存储不可用时只影响刷新后停留的子页面，不影响功能。
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

const dhState = {
  scenarioId: dhReadStoredScenario() || DH_DEFAULT_SCENARIO,
  filter: 'all',
  notice: null,
  page: dhReadStoredPage() || DH_PAGE_P01,
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
const dhContexts = { status: 'idle', data: null, error: null };
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
    const payload = await dhApi(DH_SUMMARY_ENDPOINT);
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

async function dhLoadDraft() {
  dhDraft.status = 'loading';
  dhDraft.error = null;
  try {
    const payload = await dhApi(DH_DRAFT_ENDPOINT);
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
    const payload = await dhApi(DH_COPY_ENDPOINT);
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
    dhDraft.saveMessage = '已把选定文案写入生产草稿（selectedScriptVersionId），返回 P01 或刷新后仍然保留。';
    if (dhCopy.data) {
      dhCopy.data = await dhApi(DH_COPY_ENDPOINT).then((result) => result.copy);
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
    const payload = await dhApi(DH_COPY_ENDPOINT);
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
    const payload = await dhApi(DH_WORKSPACE_ENDPOINT);
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
        selectedScriptVersionId: dhCopy.data?.selectedScriptVersionId || undefined,
      }),
    });
    dhDraft.record = payload.draft || null;
    dhDraft.status = 'ready';
    dhSyncRowsFromDraft(dhDraft.record);
    const refreshed = await dhApi(DH_WORKSPACE_ENDPOINT);
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
  dhRender();
  try {
    const payload = await dhApi(DH_CONTEXTS_ENDPOINT);
    dhContexts.data = payload.stage || null;
    dhContexts.status = 'ready';
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

async function dhSelectContext(contextId) {
  try {
    await dhApi(DH_DRAFT_ENDPOINT, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: dhDraft.record?.taskId || dhDraftForm.taskId, selectedContextId: contextId }) });
    dhNoticeSet('已选择项目上下文版本，刷新后仍保留。');
  } catch (error) {
    dhNoticeSet('选择失败：' + error.message);
  }
  await dhLoadContexts();
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
    dhNoticeSet('文案生成需求已保存（N02）。');
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
    const payload = await dhApi(DH_RESULTS_ENDPOINT);
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
    const payload = await dhApi(DH_PACKAGE_ENDPOINT);
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
  dhState.notice = { title: message, detail: '操作走的是真实批次接口；模拟输出不能审核通过或导出。', slice: 'F5-06/F5-07' };
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
    const refreshed = await dhApi(DH_WORKSPACE_ENDPOINT);
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
    const payload = await dhApi(DH_ASSETS_ENDPOINT);
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
      const refreshed = await dhApi(DH_ASSETS_ENDPOINT);
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
   渲染：入口卡（注入到内容编辑云员工工作区顶部）
   --------------------------------------------------------------------------- */

function dhRenderEntryCard() {
  if (!dhContentRoot || dhContentRoot.querySelector('.dh-entry')) {
    return;
  }
  const entry = document.createElement('section');
  entry.className = 'dh-entry';
  entry.setAttribute('aria-label', '内容编辑云员工 · AI 数字人口播生产中心入口');
  entry.innerHTML =
    '<div class="dh-entry-mark" aria-hidden="true">◉</div>' +
    '<div class="dh-entry-body">' +
    '<span class="dh-entry-context">内容编辑云员工 / 生产入口</span>' +
    '<h2>AI 数字人口播生产中心</h2>' +
    '<p>用已确认文案、数字人资产或已有视频，批量生成并人工验收口播视频。单条和批量使用同一套生产任务，数量为 1 就是单条。</p>' +
    '<div class="dh-entry-tags">' +
    '<span class="dh-chip">批量生产中心</span>' +
    '<span class="dh-chip">模式 A · 文案 + 数字人</span>' +
    '<span class="dh-chip">模式 B · 已有视频口型同步</span>' +
    '<span class="dh-chip dh-chip-planned">模型能力待接入</span>' +
    '</div>' +
    '</div>' +
    '<div class="dh-entry-actions">' +
    '<button class="button button-dark" type="button" data-dh-open>' +
    '打开生产中心 <span aria-hidden="true">→</span></button>' +
    '<small>入口属于内容编辑云员工，返回后仍回到当前工作区。</small>' +
    '</div>';
  dhContentRoot.prepend(entry);
}

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
    '</p><small>所属切片：' +
    dhEscape(dhState.notice.slice) +
    ' · 现在不会产生任何真实视频文件。</small></div>' +
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
    { index: '01', title: '项目与文案', detail: '选择行业/项目上下文，确认可以进入生产的文案。', slice: 'F5-03', tone: 'indigo', page: DH_PAGE_P02, ready: true },
    { index: '02', title: '数字人资产', detail: '选择已启用的数字人形象和对应声音版本。', slice: 'F5-04', tone: 'amber', page: DH_PAGE_ASSETS, ready: true },
    { index: '03', title: '视频与场景模板', detail: '模式 B 导入已有视频并校对映射，选择场景模板。', slice: 'F5-04', tone: 'mint', page: DH_PAGE_ASSETS, ready: true },
    { index: '04', title: '内容包', detail: '只把已通过人工验收的结果打包导出。', slice: 'F5-07', tone: 'slate' },
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
          '<span class="dh-start-slice">' + dhEscape(step.slice) + (step.ready ? ' 已实现' : ' 待实现') + '</span>';
        if (step.page) {
          return '<button class="dh-start-card dh-tone-' + step.tone + '" type="button" data-dh-page="' + step.page + '">' + inner + '</button>';
        }
        return (
          '<button class="dh-start-card dh-tone-' + step.tone + '" type="button" data-dh-notice="' + step.slice +
          '" data-dh-notice-title="' + dhEscape(step.title) + '">' + inner + '</button>'
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
    'title="下载视频属于 F5-06/F5-07，本切片未实现，也不会生成真实视频文件">下载视频（未实现）</button>' +
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
      '<button class="button button-dark button-small" type="button" data-dh-notice="F5-05" ' +
      'data-dh-notice-title="新建生产任务">新建生产任务（F5-05 待实现）</button>' +
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
  configure_items: { label: '继续配置明细', slice: 'F5-05' },
  fix_blockers: { label: '修复阻塞项', slice: 'F5-05' },
  retry_item: { label: '重试本条', slice: 'F5-06' },
  regenerate_item: { label: '修改输入后重新生成', slice: 'F5-06' },
  review_item: { label: '进行人工验收', slice: 'F5-06' },
  request_changes: { label: '退回修改', slice: 'F5-06' },
  select_for_package: { label: '加入内容包', slice: 'F5-07' },
  export_approved: { label: '导出已通过结果', slice: 'F5-07' },
};

const DH_NEXT_ACTION_LABELS = {
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
    '<p>这些数字直接来自资产目录接口，不是页面推断。缺项的对应页面在 F5-03 / F5-04 实现。</p></div></div>' +
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
    '<section class="panel dh-gate" aria-label="状态闸门">' +
    '<div class="panel-heading"><div><div class="eyebrow">状态闸门</div>' +
    '<h2>阻塞项与下一步</h2>' +
    '<p>下一步来自服务端返回的 allowed_actions 和 next_action，页面不根据按钮是否报错猜测状态。' +
    '本切片只实现读取与草稿，动作本身在标注的切片里实现。</p></div>' +
    '<span class="phase-label">next_action：' + dhEscape(dhNextActionText(nextAction)) + '</span></div>' +
    '<div class="dh-gate-grid">' +
    '<div class="dh-gate-col">' +
    '<h3>blocking_issues（' + issues.length + '）</h3>' +
    (issues.length
      ? '<ul class="dh-gate-issues">' +
        issues
          .map(
            (item) =>
              '<li><code>' + dhEscape(item.code) + '</code>' +
              '<span>' + dhEscape(DH_GAP_LABELS[item.code] || item.message || '') + '</span>' +
              (item.field ? '<small>字段：' + dhEscape(item.field) + '</small>' : '') +
              '</li>',
          )
          .join('') +
        '</ul>'
      : '<p class="dh-gate-empty">当前没有阻塞项。</p>') +
    '</div>' +
    '<div class="dh-gate-col">' +
    '<h3>allowed_actions（' + actions.length + '）</h3>' +
    (actions.length
      ? '<div class="dh-gate-actions">' +
        actions
          .map((action) => {
            const meta = DH_ACTION_LABELS[action] || { label: action, slice: '后续切片' };
            return (
              '<button class="button button-secondary button-small dh-is-disabled" type="button"' +
              ' disabled aria-disabled="true"' +
              ' title="' + dhEscape(meta.label + '属于 ' + meta.slice + '，本切片（F5-02）只做数据读取和草稿，未实现该动作') + '">' +
              dhEscape(meta.label) + '<small>（' + dhEscape(meta.slice) + ' 待实现）</small></button>'
            );
          })
          .join('') +
        '</div>' +
        '<p class="dh-gate-note">未实现的动作以 disabled 显示，并把所属切片写在按钮上，不会出现点了没反应的假按钮。</p>'
      : '<p class="dh-gate-empty">当前没有可执行动作。</p>') +
    '</div>' +
    '</div>' +
    '<p class="dh-axis-note">交付轴（未选择 / 已选择 / 已导出）在现有数据里还没有事实来源，' +
    '因此明细统一显示“未选择交付”，接入点在 F5-07 的内容包。</p>' +
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
            const meta = DH_ACTION_LABELS[action] || { label: action, slice: '后续切片' };
            return '<button class="button button-secondary button-small dh-is-disabled" type="button" disabled' +
              ' aria-disabled="true" title="' + dhEscape(meta.label + '属于 ' + meta.slice + '，本切片未实现') + '">' +
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
    '<div><dt>交付轴</dt><dd>未接入（F5-07）</dd></div>' +
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
        const meta = DH_ACTION_LABELS[action] || { label: action, slice: '后续切片' };
        return '<button class="button button-secondary button-small dh-is-disabled" type="button" disabled' +
          ' aria-disabled="true" title="' + dhEscape(meta.label + '属于 ' + meta.slice + '，本切片未实现') + '">' +
          dhEscape(meta.label) + '（' + dhEscape(meta.slice) + ' 待实现）</button>';
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
      '生产任务会在 F5-05 由“项目与文案 + 数字人资产 + 场景模板”组合出来。</p>' +
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

/* 最小任务草稿：F5-02 唯一的写入动作，落在 digital_human_drafts 表。 */
function dhDraftCard() {
  const tasks = dhReal.summary?.contentTasks || [];
  const record = dhDraft.record;
  const hasTask = Boolean(dhDraftForm.taskId);
  return (
    '<section class="panel dh-draft" aria-label="最小任务草稿">' +
    '<div class="panel-heading"><div><div class="eyebrow">最小任务草稿</div>' +
    '<h2>先保存这次生产想做什么</h2>' +
    '<p>草稿只保存意图，不产生明细、不进入状态机、不会生成视频。' +
    '真正的批次仍然由 F5-05 的 preflight + 批次计划产生。</p></div>' +
    '<span class="phase-label">F5-02（本切片唯一写入）</span></div>' +
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
    '<span class="view-intro-status">P01 · 生产中心</span>' +
    '</div>' +
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
          /* 侧栏：参考信息（资产就绪度 / 数据源 / 状态闸门 / 演示与说明） */
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
    '<span>当前切片：F5-04 生产资产（P03/P04/P05）</span>' +
    '<span>后续：F5-05 P06 生产任务 → F5-06 P07 人工验收 → F5-07 P08 内容包</span>' +
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
  const current = steps.find((step) => step.status !== 'done') || steps[steps.length - 1];
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
          (step.wired ? '' : '<small class="dh-flow-unwired">' + dhEscape(step.slice) + ' 待接入</small>') +
          dhStatusBadge(meta, 'dh-flow-badge') +
          '</span>';
        return (
          '<li class="dh-flow-step is-' + step.status + (step.page === dhState.page ? ' is-here' : '') + '">' +
          (clickable
            ? '<button type="button" class="dh-flow-step-btn" data-dh-page="' + dhEscape(step.page) + '"' +
              ' title="进入' + dhEscape(step.label) + '">' + inner + '</button>'
            : '<div class="dh-flow-step-btn" role="presentation"' +
              (step.wired ? '' : ' title="' + dhEscape((step.slice || '') + ' 尚未接入，当前切片未实现') + '"') + '>' + inner + '</div>') +
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

/* P01 的“下一步”行动卡：整页唯一的主行动，来自服务端 next_action + 阻塞项。 */
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
    detail: '下一步由服务端状态闸门给出。',
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
        ' title="该动作属于后续切片，本切片未实现">处理入口待接入（F5-06）</button>') +
    '</section>'
  );
}



/* ---------------------------------------------------------------------------
   F5-03：P02 项目与文案（本模块内部子页面）
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
    '<section class="panel dh-gate" aria-label="文案状态闸门">' +
    '<div class="panel-heading"><div><div class="eyebrow">状态闸门</div>' +
    '<h2>文案能不能进入生产任务</h2>' +
    '<p>只有 confirmed（已确认且有正文）的文案版本可以被生产任务引用。' +
    '这一条由服务端投影判定，页面只负责显示。</p></div>' +
    '<span class="phase-label">next_action：' + dhEscape(dhNextActionText(data.nextAction)) + '</span></div>' +
    '<div class="dh-gate-grid">' +
    '<div class="dh-gate-col">' +
    '<h3>blocking_issues（' + issues.length + '）</h3>' +
    (issues.length
      ? '<ul class="dh-gate-issues">' +
        issues
          .map((item) => '<li><code>' + dhEscape(item.code) + '</code><span>' +
            dhEscape(DH_GAP_LABELS[item.code] || item.message || '') + '</span></li>')
          .join('') + '</ul>'
      : '<p class="dh-gate-empty">当前没有阻塞项。</p>') +
    '</div>' +
    '<div class="dh-gate-col">' +
    '<h3>allowed_actions（' + actions.length + '）</h3>' +
    '<div class="dh-gate-actions">' +
    actions
      .map((action) => {
        if (action === 'select_copy') {
          return '<button class="button button-secondary button-small" type="button" data-dh-copy-focus-select>在下方候选中选择一条已确认文案</button>';
        }
        const meta = DH_ACTION_LABELS[action] || { label: action, slice: '后续切片' };
        return '<button class="button button-secondary button-small dh-is-disabled" type="button" disabled aria-disabled="true"' +
          ' title="' + dhEscape(meta.label + '属于 ' + meta.slice + '，本切片未实现') + '">' +
          dhEscape(meta.label) + '<small>（' + dhEscape(meta.slice) + ' 待实现）</small></button>';
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
    '<div class="panel-heading"><div><div class="eyebrow">项目上下文 · N01</div>' +
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
        '<p>行业、产品、受众、卖点、内容目标是文案和生产的前提（N01）。在下方创建第一个档案。</p></div>') +
    '</section>'
  );
}

function dhContextFormBlock() {
  return (
    '<section class="panel dh-draft" aria-label="项目上下文表单">' +
    '<div class="panel-heading"><div><div class="eyebrow">项目上下文表单 · N01</div>' +
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
    '<div class="panel-heading"><div><div class="eyebrow">文案生成需求 · N02</div>' +
    '<h2>批量候选要多少、往哪个方向、发在哪</h2>' +
    '<p>N03 AI 批量生成的模型提供方尚未配置——本阶段先保存需求并用手动登记候选占位，生成按钮只会明确阻塞。</p></div></div>' +
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
    '<button class="button button-secondary button-small dh-is-disabled" type="button" disabled aria-disabled="true" title="N03 模型提供方未配置：本阶段不接真实生成">AI 批量生成（未配置）</button>' +
    '<small>' + (request ? '当前需求已保存：' + (request.count || '—') + ' 条 · ' + dhEscape(request.direction || '—') + ' · ' + dhEscape(request.platform || '—') : '尚未保存需求') + '</small>' +
    '</div>' +
    (issues.length ? '<ul class="dh-gate-issues">' + issues.map((issue) => '<li><code>' + dhEscape(issue.code) + '</code><span>' + dhEscape(issue.message) + '</span></li>').join('') + '</ul>' : '') +
    '</section>'
  );
}

function dhRenderCopy() {
  const ready = dhCopy.status === 'ready' && dhCopy.data;
  dhRoot.innerHTML =
    dhRealBanner() +
    '<div class="view-intro-row">' +
    '<div><span class="view-context">云员工 / 内容编辑 · AI 数字人口播</span>' +
    '<p>P02 项目与文案：确认这次口播生产挂在哪个项目下，并从真实文案库里选出可进入生产的文案版本。</p></div>' +
    '<span class="view-intro-status">P02 · 项目与文案</span>' +
    '</div>' +
    '<div class="dh-toolbar">' +
    '<div class="dh-context" aria-label="当前项目上下文">' +
    '<span><small>项目</small><strong>' + dhEscape(dhReal.summary?.project?.name || '（读取中）') + '</strong></span>' +
    '<span><small>候选</small><strong>' + Number(dhCopy.data?.total || 0) + ' 条</strong></span>' +
    '<span><small>已确认</small><strong>' + Number(dhCopy.data?.confirmedCount || 0) + ' 条</strong></span>' +
    '</div>' +
    '<div class="dh-toolbar-actions">' +
    '<button class="button button-secondary button-small" type="button" data-dh-page="' + DH_PAGE_P01 + '">← 返回 P01 生产中心</button>' +
    '<button class="button button-secondary button-small" type="button" data-dh-copy-reload>重新读取文案</button>' +
    '</div>' +
    '</div>' +
    dhNoticeBlock() +
    (dhCopy.status === 'loading'
      ? dhLoadingBlock()
      : dhCopy.status === 'error'
        ? '<section class="dh-error" role="alert"><span class="dh-error-mark" aria-hidden="true">!</span>' +
          '<div><strong>文案数据读取失败，因此这里不显示任何候选</strong>' +
          '<p>' + dhEscape(dhCopy.error?.message || '未知错误') + '</p>' +
          '<small>页面不会用示例文案冒充真实文案库。</small></div>' +
          '<button class="button button-secondary button-small" type="button" data-dh-copy-reload>重新读取</button></section>'
        : '') +
    (ready
      ? dhLayout(
          dhFlowBar() +
          dhContextBlock() +
          dhCopyRequestBlock() +
          '<section class="panel dh-queue" aria-label="文案候选列表">' +
          '<div class="panel-heading"><div><div class="eyebrow">文案候选</div>' +
          '<h2>从真实文案库中选择</h2>' +
          '<p>长文本默认只显示摘要，展开后才加载全文；未确认的候选永远不能进入生产。</p></div></div>' +
          (dhCopy.data.candidates.length
            ? '<div class="dh-copy-list">' + dhCopy.data.candidates.map(dhCopyCard).join('') + '</div>'
            : '<div class="dh-empty" role="status"><span aria-hidden="true">◌</span>' +
              '<strong>真实文案库里还没有任何候选</strong>' +
              '<p>在下方登记第一条文案，或回到内容编辑工作流里生成文案。</p></div>') +
          '</section>' +
          dhCopyRegisterForm(),
          dhCopyGate() +
          dhCopySourceBar() +
          (dhCopy.data.selectedScriptVersionId
            ? '<section class="panel dh-side-block"><div class="panel-heading"><div><div class="eyebrow">已选文案</div>' +
              '<h2>' + dhEscape((dhCopy.data.candidates.find((c) => c.id === dhCopy.data.selectedScriptVersionId)?.title) || '已选文案') + '</h2>' +
              '<p>已写入生产草稿，返回 P01 或刷新后仍然保留。</p></div></div></section>'
            : ''),
        )
      : '') +
    '<footer class="dh-footnote">' +
    '<span>当前切片：F5-03 P02 项目与文案最小闭环</span>' +
    '<span>后续：F5-04 P03/P04/P05 资产 → F5-05 P06 生产任务 → F5-06 P07 人工验收 → F5-07 P08 内容包</span>' +
    '</footer>';
}

/* ---------------------------------------------------------------------------
   F5-06：P07 结果与人工验收（本模块内部子页面）
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
    '<p>P07 结果与人工验收：每条结果独立显示生成/审核/交付三轴；没有真实文件就如实显示没有。</p></div>' +
    '<span class="view-intro-status">P07 · 结果与人工验收</span></div>' +
    '<div class="dh-toolbar"><div class="dh-context">' +
    '<span><small>批次</small><strong>' + Number(data?.batchCount || 0) + '</strong></span>' +
    '<span><small>结果</small><strong>' + Number(data?.itemCount || 0) + '</strong></span>' +
    '<span><small>待验收</small><strong>' + Number(data?.counts?.waitingReview || 0) + '</strong></span>' +
    '</div><div class="dh-toolbar-actions">' +
    '<button class="button button-secondary button-small" type="button" data-dh-page="' + DH_PAGE_P01 + '">← 返回 P01</button>' +
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
            : '<div class="dh-empty" role="status"><span aria-hidden="true">◌</span><strong>真实数据里还没有生产批次</strong><p>先到 P06 创建生产批次，再回来验收结果。</p></div>') +
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
    '<footer class="dh-footnote"><span>当前切片：S8-02~04 P07 结果 · 人工验收 · 版本重做</span><span>内容包见 P08</span></footer>';
}

/* ---------------------------------------------------------------------------
   F5-07：P08 内容包（本模块内部子页面）
   --------------------------------------------------------------------------- */

function dhRenderPackage() {
  const ready = dhPackage.status === 'ready' && dhPackage.data;
  const data = ready ? dhPackage.data : null;
  dhRoot.innerHTML =
    dhRealBanner() +
    '<div class="view-intro-row"><div><span class="view-context">云员工 / 内容编辑 · AI 数字人口播</span>' +
    '<p>P08 内容包：只允许导出「生成成功 + 文件 verified + 人工通过」的结果。模拟输出永远不能导出。</p></div>' +
    '<span class="view-intro-status">P08 · 内容包</span></div>' +
    '<div class="dh-toolbar"><div class="dh-context">' +
    '<span><small>批次</small><strong>' + Number(data?.batchCount || 0) + '</strong></span>' +
    '<span><small>可导出结果</small><strong>' + Number(data?.exportableCount || 0) + '</strong></span>' +
    '<span><small>下一步</small><strong>' + dhEscape(dhNextActionText(data?.nextAction)) + '</strong></span>' +
    '</div><div class="dh-toolbar-actions">' +
    '<button class="button button-secondary button-small" type="button" data-dh-page="' + DH_PAGE_P01 + '">← 返回 P01</button>' +
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
    '<label class="dh-field"><span>输出文件名（不含扩展名，N16 要求任务内唯一）</span>' +
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
    '<span class="view-intro-status">P06 · 生产任务与显式明细</span>' +
    '</div>' +
    '<div class="dh-toolbar">' +
    '<div class="dh-context" aria-label="当前任务上下文">' +
    '<span><small>模式</small><strong>模式 ' + dhEscape(data?.mode || 'A') + '</strong></span>' +
    '<span><small>明细行</small><strong>' + dhTaskRows.length + ' 行' + (dhTaskRows.length === 1 ? ' · 单条生产' : dhTaskRows.length > 1 ? ' · 批量生产' : '') + '</strong></span>' +
    '<span><small>检查</small><strong>' + dhEscape(gate ? (gate.success ? '已通过' : '被阻塞') : '未检查') + '</strong></span>' +
    '</div>' +
    '<div class="dh-toolbar-actions">' +
    '<button class="button button-secondary button-small" type="button" data-dh-page="' + DH_PAGE_P01 + '">← 返回 P01 生产中心</button>' +
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
          '<p>第 5 步执行（N18）尚未接入：通过生成前检查也不会开始生成，更不会产生任何视频文件。</p></div></div>' +
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
          '<div class="panel-heading"><div><div class="eyebrow">明细配置 · N15</div>' +
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
          (dhPreflight.running ? '正在检查…' : '运行 N17 生成前检查') + '</button>' +
          '<small>明细保存在生产草稿里，刷新后仍在；生成前检查只判定、不执行。</small>' +
          '</div>' +
          '</section>' +
          /* N17 结果 */
          (gate
            ? '<section class="panel ' + (gate.success ? 'dh-gate' : 'dh-gate') + '" aria-label="N17 生成前检查结果">' +
              '<div class="panel-heading"><div><div class="eyebrow">N17 生成前检查</div>' +
              '<h2>' + (gate.success ? '通过：允许进入执行' : '被阻塞：还不能执行') + '</h2>' +
              '<p>判定来自服务端闸门，格式为 allowed_actions / blocking_issues / next_action。</p></div>' +
              '<span class="phase-label">next_action：' + dhEscape(dhNextActionText(gate.next_action)) + '</span></div>' +
              (gate.blocking_issues?.length
                ? '<ul class="dh-gate-issues">' +
                  gate.blocking_issues.map((item) => '<li><code>' + dhEscape(item.code) + '</code><span>' + dhEscape(item.message) + '</span></li>').join('') +
                  '</ul>'
                : '<div class="dh-gate-empty">' +
                  '<p>没有阻塞项。可以按当前显式明细创建生产批次（一行对应一个输出，不做全组合）。</p>' +
                  '<button class="button button-dark button-small" type="button" data-dh-batch-create' +
                  (dhPreflight.running ? ' disabled aria-disabled="true"' : '') + '>' +
                  (dhPreflight.running ? '正在创建…' : '按显式明细创建生产批次') + '</button>' +
                  '<small>批次创建后处于 waiting_approval；生成执行（N18）尚未接入，不会开始生成，也不会产生任何视频文件。</small>' +
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
    '<span>当前切片：F5-05 P06 生产任务与显式明细</span>' +
    '<span>后续：F5-06 P07 结果与人工验收 → F5-07 P08 内容包</span>' +
    '</footer>';
}

function dhOutputPolicyCard(data) {
  return (
    '<section class="panel dh-side-block" aria-label="输出设置">' +
    '<div class="panel-heading"><div><div class="eyebrow">输出设置 · N16</div>' +
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
    '<section class="panel dh-gate" aria-label="任务状态闸门">' +
    '<div class="panel-heading"><div><div class="eyebrow">状态闸门</div>' +
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
    '那是规范明令禁止的隐式 Cartesian（N15）。</p>' +
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

function dhRenderAssets() {
  const ready = dhAssets.status === 'ready' && dhAssets.data;
  const data = ready ? dhAssets.data : null;
  dhRoot.innerHTML =
    dhRealBanner() +
    '<div class="view-intro-row">' +
    '<div><span class="view-context">云员工 / 内容编辑 · AI 数字人口播</span>' +
    '<p>P03 数字人资产 · P04 已有视频 · P05 场景模板：按模式 A / 模式 B 分区选择生产资产。本切片只做选择与状态显示，不做登记与训练。</p></div>' +
    '<span class="view-intro-status">P03–P05 · 生产资产</span>' +
    '</div>' +
    '<div class="dh-toolbar">' +
    '<div class="dh-context" aria-label="当前项目上下文">' +
    '<span><small>项目</small><strong>' + dhEscape(dhReal.summary?.project?.name || '（读取中）') + '</strong></span>' +
    '<span><small>模式 A</small><strong>' + (data?.modeA?.ready ? '资产齐全' : '资产不齐') + '</strong></span>' +
    '<span><small>模式 B</small><strong>未接入</strong></span>' +
    '</div>' +
    '<div class="dh-toolbar-actions">' +
    '<button class="button button-secondary button-small" type="button" data-dh-page="' + DH_PAGE_P01 + '">← 返回 P01 生产中心</button>' +
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
  dhState.page = page;
  dhWriteStoredPage(page);
  dhState.notice = null;
  dhRender();
  if (!dhIsRealMode()) {
    return;
  }
  if (page === DH_PAGE_P02 && dhCopy.status !== 'ready') {
    dhLoadCopy();
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
  const back = event.target.closest('[data-dh-back]');
  if (back) {
    dhGoHome();
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
    dhLoadSummary();
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

function dhInit() {
  if (!dhRoot) {
    return;
  }
  dhRenderEntryCard();
  dhRender();

  /* F5-02/F5-03：真实数据只在真实模式下读取；先读草稿，再读摘要（摘要用于回填内容任务下拉）。
     如果刷新后直接落在 P02，必须同时加载文案候选，否则 P02 会一直空着。 */
  if (dhIsRealMode()) {
    dhLoadSummary();
    dhLoadDraft();
    if (dhState.page === DH_PAGE_P02) {
      dhLoadCopy();
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

  /* 入口卡在内容编辑工作区内部，用事件委托处理，避免与 content-workspace.js 抢 DOM。 */
  dhContentRoot?.addEventListener('click', (event) => {
    if (event.target.closest('[data-dh-open]')) {
      event.preventDefault();
      window.location.hash = '#' + DH_VIEW;
    }
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
    if (event.target.closest('[data-dh-profile-field]') || event.target.closest('[data-dh-video-field]') || event.target.closest('[data-dh-map-field]')) {
      dhSyncAssetFormsFromDom();
    }
  });
}

dhInit();
