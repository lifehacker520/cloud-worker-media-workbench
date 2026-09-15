/* ===========================================================================
   内容编辑云员工 · 父级入口页（F5-C2）

   本文件不再是 26 节点内容编辑长页面。
   它只负责三件事：
     1. 说明内容编辑云员工的职责；
     2. 说明 AI 数字人口播生产中心属于内容编辑云员工，并提供唯一入口；
     3. 显示生产中心的真实状态，以及从监控中心带入的作品参考。

   已下线的旧首页能力（改由 AI 数字人口播生产中心或后端承担，见 F5-C0 / F5-C1 报告）：
     - 26 节点工作流清单与节点检视器
     - 内容任务长详情与状态机操作（启动 / 暂停 / 继续 / 重试 / 回放）
     - 素材解析与授权表单
     - 选题闸门、审核闸门、版本修订表单
     - 声音 A/B 对比表单
     - 单条媒体生成表单
     - 批量登记 / 批量计划 / 批量审核 / 批量重试 / 批量导出表单
     - 反馈登记与版本证据长页
   后端接口与 src/ 公共模块全部保留，未随本页下线而删除。

   保留的唯一桥接：监控中心「从作品创建内容任务」带出的作品来源，
   经 sessionStorage + content-work-prefill 事件转交给生产中心 P02。
   =========================================================================== */

const root = document.querySelector('#view-content');

if (root) {
  /* 与 app.js 约定的带入键，两边必须一致。 */
  const CW_PREFILL_KEY = 'cloud-worker-content-prefill';
  const CW_SUMMARY_ENDPOINT = '/api/content/digital-human/summary';

  const cwState = {
    status: 'idle',
    summary: null,
    error: null,
    prefill: readPrefill(),
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatTime(value) {
    if (!value) {
      return '—';
    }
    const time = new Date(value);
    return Number.isNaN(time.getTime()) ? '—' : time.toLocaleString('zh-CN', { hour12: false });
  }

  function readPrefill() {
    try {
      const raw = window.sessionStorage.getItem(CW_PREFILL_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function clearPrefill() {
    try {
      window.sessionStorage.removeItem(CW_PREFILL_KEY);
    } catch {
      /* 存储不可用时只清内存态。 */
    }
    cwState.prefill = null;
  }

  async function api(path, options = {}) {
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
      throw new Error(payload.error || '请求失败');
    }
    return payload;
  }

  /* -------------------------------------------------------------------------
     渲染：监控中心带入的作品参考（唯一桥接的可见部分）
     ------------------------------------------------------------------------- */

  function prefillBlock() {
    const prefill = cwState.prefill;
    if (!prefill) {
      return '';
    }
    const title = prefill.title || '未命名作品';
    const platform = prefill.platforms || '未记录平台';
    const source = prefill.sourceWorkFingerprint || '未记录来源标识';
    return (
      '<section class="panel cw-prefill" role="status">' +
      '<div class="panel-heading"><div><div class="eyebrow">自监控中心带入</div>' +
      '<h2>' + escapeHtml(title) + '</h2></div><span class="count-label">待确认</span></div>' +
      '<p>平台：' + escapeHtml(platform) + ' · 来源标识：' + escapeHtml(source) + '</p>' +
      '<p>监控来源只是公开平台元数据，不会自动视为已授权素材。进入生产中心后会打开 P02，' +
      '带入信息会保留在那里供你确认来源与授权边界。</p>' +
      '<div class="cw-prefill-actions">' +
      '<button class="button button-dark button-small" type="button" data-dh-open>带入生产中心 P02<span aria-hidden="true"> →</span></button>' +
      '<button class="button button-quiet button-small" type="button" data-cw-clear-prefill>清除带入</button>' +
      '</div></section>'
    );
  }

  /* -------------------------------------------------------------------------
     渲染：生产中心真实状态（只读投影，失败就如实显示失败，不编造数字）
     ------------------------------------------------------------------------- */

  function statusBlock() {
    if (cwState.status === 'loading' || cwState.status === 'idle') {
      return (
        '<section class="panel cw-status" role="status">' +
        '<div class="panel-heading"><div><div class="eyebrow">当前状态</div><h2>生产中心</h2></div></div>' +
        '<p>正在读取生产中心状态…</p></section>'
      );
    }
    if (cwState.status === 'error') {
      return (
        '<section class="panel cw-status" role="alert">' +
        '<div class="panel-heading"><div><div class="eyebrow">当前状态</div><h2>生产中心</h2></div>' +
        '<span class="count-label">读取失败</span></div>' +
        '<p>状态读取失败：' + escapeHtml(cwState.error || '未知错误') + '</p>' +
        '<p>本页不会用示例数字冒充真实状态。</p>' +
        '<button class="button button-secondary button-small" type="button" data-cw-reload>重新读取</button></section>'
      );
    }
    const summary = cwState.summary || {};
    const counts = summary.counts || {};
    const assets = summary.assets || {};
    const tasks = Array.isArray(summary.tasks) ? summary.tasks : [];
    const project = summary.project || {};
    return (
      '<section class="panel cw-status">' +
      '<div class="panel-heading"><div><div class="eyebrow">当前状态</div><h2>生产中心</h2></div>' +
      '<span class="count-label">真实数据</span></div>' +
      '<div class="cw-status-grid">' +
      '<div><span>当前项目</span><strong>' + escapeHtml(project.name || '未选择项目') + '</strong></div>' +
      '<div><span>生产任务</span><strong>' + escapeHtml(String(tasks.length)) + ' 个</strong></div>' +
      '<div><span>待人工验收</span><strong>' + escapeHtml(String(counts.waitingReview ?? 0)) + ' 条</strong></div>' +
      '<div><span>可导出结果</span><strong>' + escapeHtml(String(counts.approvedExportable ?? 0)) + ' 条</strong></div>' +
      '<div><span>形象版本</span><strong>' + escapeHtml(String(assets.avatars ?? 0)) + '</strong></div>' +
      '<div><span>声音版本</span><strong>' + escapeHtml(String(assets.voices ?? 0)) + '</strong></div>' +
      '<div><span>场景模板</span><strong>' + escapeHtml(String(assets.templates ?? 0)) + '</strong></div>' +
      '</div>' +
      '<p class="cw-status-foot">更新于 ' + escapeHtml(formatTime(summary.readAt || summary.updatedAt)) +
      ' · 数字来自生产中心后端接口，不是本页推断。</p>' +
      '<button class="button button-secondary button-small" type="button" data-cw-reload>重新读取</button></section>'
    );
  }

  /* -------------------------------------------------------------------------
     渲染：页面
     ------------------------------------------------------------------------- */

  function render() {
    root.innerHTML =
      '<div class="view-intro-row cw-parent-intro">' +
      '<div><span class="view-context">云员工 / 内容编辑</span>' +
      '<p>内容编辑云员工负责把业务目标、监控线索和原始素材整理成可审核、可交接的内容；' +
      '口播视频的批量生产由它的下级生产中心承担。本页只是入口，具体工作在生产中心内完成。</p></div>' +
      '<span class="view-intro-status">父级入口</span>' +
      '</div>' +
      '<section class="dh-entry" aria-label="内容编辑云员工下级 · AI 数字人口播生产中心入口">' +
      '<div class="dh-entry-mark" aria-hidden="true">◉</div>' +
      '<div class="dh-entry-body">' +
      '<span class="dh-entry-context">内容编辑云员工 / 下级生产中心</span>' +
      '<h2>AI 数字人口播生产中心</h2>' +
      '<p>用已确认文案、数字人资产或已有视频，批量生成并人工验收口播视频。' +
      '一行生产明细就是一个输出：1 行是单条生产，多行是批量生产。</p>' +
      '<div class="dh-entry-tags">' +
      '<span class="dh-chip">P01 生产中心</span>' +
      '<span class="dh-chip">P02 项目与文案</span>' +
      '<span class="dh-chip">P03–P05 生产资产</span>' +
      '<span class="dh-chip">P06 生产任务</span>' +
      '<span class="dh-chip">P07 人工验收</span>' +
      '<span class="dh-chip">P08 内容包</span>' +
      '</div></div>' +
      '<div class="dh-entry-actions">' +
      '<button class="button button-dark" type="button" data-dh-open>进入生产中心<span aria-hidden="true"> →</span></button>' +
      '<small>生产中心属于内容编辑云员工，返回后回到本页。</small>' +
      '</div></section>' +
      prefillBlock() +
      statusBlock() +
      '<footer class="cw-parent-foot">' +
      '<span>内容编辑云员工 · 父级入口页</span>' +
      '<span>口播视频生产在 AI 数字人口播生产中心完成</span>' +
      '</footer>';
  }

  async function loadStatus() {
    cwState.status = 'loading';
    render();
    try {
      const payload = await api(CW_SUMMARY_ENDPOINT);
      cwState.summary = payload.summary || payload;
      cwState.status = 'ready';
    } catch (error) {
      cwState.error = error.message;
      cwState.status = 'error';
    }
    render();
  }

  /* -------------------------------------------------------------------------
     事件
     ------------------------------------------------------------------------- */

  root.addEventListener('click', (event) => {
    /* 进入生产中心：与 digital-human-workspace.js 既有委托行为一致（幂等）。 */
    if (event.target.closest('[data-dh-open]')) {
      event.preventDefault();
      window.location.hash = '#digital-human';
      return;
    }
    if (event.target.closest('[data-cw-clear-prefill]')) {
      clearPrefill();
      render();
      return;
    }
    if (event.target.closest('[data-cw-reload]')) {
      loadStatus();
    }
  });

  /* 唯一桥接：监控中心带入作品。
     app.js 会写入同一份 prefill 到 sessionStorage 并派发本事件；
     这里只负责记录与展示，不创建内容任务，也不恢复旧首页表单。 */
  window.addEventListener('content-work-prefill', (event) => {
    const detail = event.detail;
    if (detail && typeof detail === 'object') {
      try {
        window.sessionStorage.setItem(CW_PREFILL_KEY, JSON.stringify(detail));
      } catch {
        /* 存储不可用时降级为仅内存保留。 */
      }
      cwState.prefill = detail;
    } else {
      cwState.prefill = readPrefill();
    }
    render();
  });

  render();
  loadStatus();
}
