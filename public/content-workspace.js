const root = document.querySelector('#view-content');

if (root) {
  const contentState = {
    tasks: [],
    details: {},
    assets: {},
    selectedTaskId: null,
    selectedNodeId: null,
    workflow: null,
    workspace: null,
    replays: {},
  };

  const statusLabels = {
    draft: '待整理',
    queued: '已排队',
    running: '执行中',
    waiting_review: '待审核',
    changes_requested: '待修改',
    approved: '已审核',
    packaged: '已打包',
    ready_for_publish: '待发布',
    failed: '执行失败',
    blocked: '已阻塞',
    cancelled: '已取消',
    pending: '未开始',
    ready: '待执行',
    succeeded: '已完成',
    skipped: '已跳过',
    not_started: '未启动',
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function labelForStatus(status) {
    return statusLabels[status] || status || '未知';
  }

  function formatTime(value) {
    if (!value) {
      return '—';
    }
    const time = new Date(value);
    return Number.isNaN(time.getTime()) ? '—' : time.toLocaleString('zh-CN', { hour12: false });
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
      const error = new Error(payload.error || '请求失败');
      error.httpStatus = response.status;
      throw error;
    }
    return payload;
  }

  const workflowControlPaths = {
    pause: '/pause',
    resume: '/resume',
    retry: '/retry',
  };

  root.innerHTML = `
    <div class="content-workspace-intro view-intro-row">
      <div><span class="view-context">云员工 / 内容编辑</span><p>从业务目标和原始素材开始，逐步形成可审核、可交接的内容包。首期只在本地/测试模式运行，不直接发布。</p></div>
      <span class="view-intro-status">P0 · 人工审核</span>
    </div>
    <div id="content-runtime-strip" class="content-runtime-strip">正在读取运行时能力…</div>
    <section class="content-workspace-grid">
      <section class="panel content-create-card">
        <div class="panel-heading">
          <div><div class="eyebrow">内容任务</div><h2>创建内容任务</h2></div>
          <span class="phase-label">本地测试</span>
        </div>
        <p class="section-intro">先登记目标、品牌上下文和素材说明，系统会创建完整的 26 节点工作流骨架。</p>
        <form id="content-task-form" class="content-task-form">
          <label><span>任务名称</span><input name="title" type="text" maxlength="120" placeholder="例如：AI 智能体客户案例口播" required /></label>
          <label><span>业务目标</span><textarea name="objective" rows="3" maxlength="2000" placeholder="这条内容要解决什么业务问题？"></textarea></label>
          <div class="content-form-row">
            <label><span>目标受众</span><input name="audience" type="text" maxlength="500" placeholder="例如：中小企业老板" /></label>
            <label><span>平台</span><input name="platforms" type="text" maxlength="200" placeholder="小红书, 抖音, 视频号" /></label>
          </div>
          <div class="content-form-row">
            <label><span>客户上下文</span><select name="customerId" aria-label="客户上下文"><option value="">未绑定客户</option></select></label>
            <label><span>品牌资料</span><select name="brandProfileId" aria-label="品牌资料"><option value="">未绑定品牌资料</option></select></label>
          </div>
          <label><span>本地素材路径（可选）</span><input name="sourceAssetPath" type="text" maxlength="1000" placeholder="例如：/Users/你的用户名/Downloads/宣传视频.mp4" /></label>
          <label><span>素材/参考说明</span><textarea name="sourceBrief" rows="5" maxlength="20000" placeholder="记录素材来源、已授权文件、参考作品或需要补充的资料。"></textarea></label>
          <div class="content-form-actions"><p id="content-form-message" class="form-message"></p><button class="button button-dark" type="submit">创建内容任务</button></div>
        </form>
      </section>
      <section class="panel content-task-list-card">
        <div class="panel-heading">
          <div><div class="eyebrow">任务队列</div><h2>内容任务</h2></div>
          <span id="content-task-count" class="count-label">0 个</span>
        </div>
        <div id="content-task-list" class="content-task-list"><div class="empty-state compact"><span>▧</span><p>正在读取内容任务…</p></div></div>
      </section>
    </section>
    <section id="content-task-detail" class="panel content-task-detail"></section>
  `;

  const elements = {
    form: root.querySelector('#content-task-form'),
    formMessage: root.querySelector('#content-form-message'),
    taskCount: root.querySelector('#content-task-count'),
    taskList: root.querySelector('#content-task-list'),
    detail: root.querySelector('#content-task-detail'),
    runtimeStrip: root.querySelector('#content-runtime-strip'),
  };

  function renderContextOptions() {
    const customers = contentState.workspace?.customers || [];
    const brandProfiles = contentState.workspace?.brandProfiles || [];
    const customerSelect = elements.form.querySelector('[name="customerId"]');
    const brandProfileSelect = elements.form.querySelector('[name="brandProfileId"]');
    if (customerSelect) {
      const selected = customerSelect.value;
      customerSelect.innerHTML = '<option value="">未绑定客户</option>' + customers.map((customer) => `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.name)}</option>`).join('');
      if (customers.some((customer) => customer.id === selected)) customerSelect.value = selected;
    }
    if (brandProfileSelect) {
      const selected = brandProfileSelect.value;
      brandProfileSelect.innerHTML = '<option value="">未绑定品牌资料</option>' + brandProfiles.map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`).join('');
      if (brandProfiles.some((profile) => profile.id === selected)) brandProfileSelect.value = selected;
    }
  }

  function selectedTask() {
    return contentState.details[contentState.selectedTaskId] || null;
  }

  function renderTaskList() {
    elements.taskCount.textContent = contentState.tasks.length + ' 个';
    if (!contentState.tasks.length) {
      elements.taskList.innerHTML = '<div class="empty-state compact"><span>▧</span><p>还没有内容任务，先创建第一条。</p></div>';
      return;
    }
    elements.taskList.innerHTML = contentState.tasks
      .map((task) => {
        const active = task.id === contentState.selectedTaskId;
        const progress = task.totalNodes
          ? Math.round((task.completedNodes / task.totalNodes) * 100)
          : 0;
        return `<button class="content-task-row${active ? ' is-selected' : ''}" type="button" data-content-task="${escapeHtml(task.id)}">
          <span class="content-task-row-mark">${active ? '●' : '○'}</span>
          <span class="content-task-row-copy"><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(labelForStatus(task.status))} · 负责人 ${escapeHtml(task.owner?.displayName || '未指定')} · ${task.completedNodes}/${task.totalNodes} 节点 · 更新 ${escapeHtml(formatTime(task.updatedAt))}</small><i><b style="width:${progress}%"></b></i></span>
          <span class="content-task-row-status">${escapeHtml(labelForStatus(task.status))}</span>
        </button>`;
      })
      .join('');
  }

  function renderNode(node) {
    const active = node.id === contentState.selectedNodeId;
    return `<button class="content-node-row${active ? ' is-selected' : ''}" type="button" data-content-node="${escapeHtml(node.id)}">
      <span class="content-node-order">${String(node.order).padStart(2, '0')}</span>
      <span class="content-node-copy"><strong>${escapeHtml(node.label)}</strong><small>${escapeHtml(node.key)} · ${node.humanGate ? '人工闸门' : '可自动执行'}</small></span>
      <span class="content-node-status status-${escapeHtml(node.status)}">${escapeHtml(labelForStatus(node.status))}</span>
    </button>`;
  }

  function renderDetail() {
    const task = selectedTask();
    if (!task) {
      elements.detail.innerHTML = '<div class="empty-workspace compact-empty"><div class="empty-orbit">▧</div><h3>选择或创建一个内容任务</h3><p>任务创建后，这里会展示完整工作流、节点状态和运行证据。</p></div>';
      return;
    }
    const activeNode = task.nodes.find((node) => node.id === contentState.selectedNodeId) || task.nodes.find((node) => node.status === 'ready') || task.nodes[0];
    contentState.selectedNodeId = activeNode?.id || null;
    const canStart = ['draft', 'changes_requested'].includes(task.status);
    const canRecord = task.run?.status && task.run.status !== 'not_started';
    const platforms = task.platforms.length ? task.platforms.join('、') : '未指定';
    const assets = contentState.assets[task.id] || [];
    const assetSummary = assets.length
      ? assets.map((asset) => `<li><strong>${escapeHtml(asset.filename)}</strong><span>${escapeHtml(asset.kind)} · ${escapeHtml(asset.status)} · ${Math.round(Number(asset.metadata?.media?.format?.size || 0) / 1024 / 1024 * 10) / 10 || '—'} MB</span></li>`).join('')
      : '<li class="is-empty">尚未解析本地素材</li>';
    const nodeStatus = (nodeId) => task.nodes.find((node) => node.id === nodeId)?.status;
    const nodeOutput = (nodeId) => task.nodes.find((node) => node.id === nodeId)?.output || null;
    const autoExecutableNodes = new Set(['CE-02', 'CE-03', 'CE-04', 'CE-05', 'CE-06', 'CE-07', 'CE-08', 'CE-09', 'CE-13', 'CE-14', 'CE-15', 'CE-17', 'CE-18', 'CE-19', 'CE-26']);
    const canExecuteActiveNode = canRecord && activeNode?.status === 'ready' && autoExecutableNodes.has(activeNode.id);
    const canPause = canRecord && !['paused', 'succeeded', 'failed', 'cancelled'].includes(task.run?.status);
    const canResume = task.run?.status === 'paused';
    const replay = contentState.replays[task.id] || null;
    const replaySummary = replay
      ? `回放 ${replay.events?.length || 0} 条事件 · ${replay.complete ? '快照完整' : '存在历史事件缺少快照'}`
      : '';
    elements.detail.innerHTML = `
      <div class="content-detail-heading">
        <div><div class="eyebrow">WORK ITEM / ${escapeHtml(task.workflowVersion)}</div><h2>${escapeHtml(task.title)}</h2><p>${escapeHtml(task.objective || '尚未填写业务目标')}</p></div>
        <div class="content-detail-actions">${canStart ? '<button class="button button-primary" type="button" data-start-content="' + escapeHtml(task.id) + '">启动本地测试工作流</button>' : ''}${canPause ? '<button class="button button-quiet" type="button" data-pause-content="' + escapeHtml(task.id) + '">暂停运行</button>' : ''}${canResume ? '<button class="button button-secondary" type="button" data-resume-content="' + escapeHtml(task.id) + '">继续运行</button>' : ''}<button class="button button-quiet" type="button" data-replay-content="${escapeHtml(task.id)}">查看运行回放</button><span class="phase-label">${escapeHtml(labelForStatus(task.status))}</span></div>
      </div>
      <div class="content-detail-meta"><span>负责人：<b>${escapeHtml(task.owner?.displayName || '未指定')}</b></span><span>受众：<b>${escapeHtml(task.audience || '未指定')}</b></span><span>平台：<b>${escapeHtml(platforms)}</b></span><span>审核：<b>${escapeHtml(labelForStatus(task.reviews?.at(-1)?.decision || (task.status === 'waiting_review' ? 'pending' : 'not_started')))}</b></span><span>运行：<b>${escapeHtml(labelForStatus(task.run?.status || 'not_started'))}</b></span><span>更新时间：<b>${escapeHtml(formatTime(task.updatedAt))}</b></span></div>
      <section class="content-material-toolbox"><div><div class="eyebrow">REAL MATERIAL PIPELINE</div><h3>本地素材与执行节点</h3><p>路径只读取允许的本地目录；解析结果会进入 SQLite 媒体资产和知识索引。ASR、OCR、渲染和发布连接器会显示真实能力状态；没有外部模型时可生成仅引用已读素材的本地模板草案。</p></div><form id="content-material-form" class="content-material-form"><input name="path" type="text" maxlength="1000" value="${escapeHtml(task.sourceAssets?.[0] || '')}" placeholder="/Users/你的用户名/Downloads/素材.mp4" required /><button class="button button-secondary" type="submit">解析素材</button></form><ul class="content-asset-list">${assetSummary}</ul><div class="content-runtime-actions">${nodeStatus('CE-09') === 'ready' ? '<button class="button button-quiet" type="button" data-analyze-content="' + escapeHtml(task.id) + '">分析内容结构</button>' : ''}${nodeStatus('CE-10') === 'ready' ? '<button class="button button-quiet" type="button" data-generate-content="topic">生成选题</button>' : ''}${nodeStatus('CE-11') === 'ready' ? '<button class="button button-quiet" type="button" data-generate-content="copy">生成脚本</button>' : ''}${nodeStatus('CE-12') === 'ready' ? '<button class="button button-quiet" type="button" data-generate-content="platform">生成平台版本</button>' : ''}${nodeStatus('CE-13') === 'ready' ? '<button class="button button-quiet" type="button" data-generate-content="shotlist">生成分镜</button>' : ''}${nodeStatus('CE-16') === 'ready' ? '<button class="button button-quiet" type="button" data-render-content="' + escapeHtml(task.id) + '">本地渲染</button>' : ''}${nodeStatus('CE-22') === 'ready' ? '<button class="button button-quiet" type="button" data-package-content="' + escapeHtml(task.id) + '">导出内容包</button>' : ''}${nodeStatus('CE-23') === 'ready' ? '<button class="button button-dark" type="button" data-create-release-draft="' + escapeHtml(task.id) + '">创建发布草稿</button>' : ''}</div></section>
      <div class="content-detail-layout">
        <section class="content-node-panel"><div class="panel-heading"><div><div class="eyebrow">26 NODE TRACE</div><h3>工作流节点</h3></div><span class="count-label">${task.nodes.filter((node) => ['succeeded', 'skipped'].includes(node.status)).length}/${task.nodes.length}</span></div><div class="content-node-list">${task.nodes.map(renderNode).join('')}</div></section>
        <section class="content-node-inspector">
          <div class="eyebrow">NODE INSPECTOR</div><h3>${escapeHtml(activeNode?.label || '未选择节点')}</h3><p class="node-key">${escapeHtml(activeNode?.id || '')} · ${escapeHtml(activeNode?.key || '')}</p>
          <div class="node-inspector-summary"><span>状态<strong>${escapeHtml(labelForStatus(activeNode?.status))}</strong></span><span>人工闸门<strong>${activeNode?.humanGate ? '是' : '否'}</strong></span><span>证据<strong>${activeNode?.evidence?.length || 0} 条</strong></span></div>
          <div class="node-output-box"><span>最近输出</span><pre>${escapeHtml(activeNode?.output ? JSON.stringify(activeNode.output, null, 2) : '尚未记录输出')}</pre></div>
          ${canExecuteActiveNode ? '<button class="button button-secondary node-execute-button" type="button" data-execute-node="' + escapeHtml(activeNode.id) + '">执行当前节点</button>' : ''}
          ${['failed', 'blocked'].includes(activeNode?.status) ? '<button class="button button-quiet node-execute-button" type="button" data-retry-content="' + escapeHtml(task.id) + '" data-retry-node="' + escapeHtml(activeNode.id) + '">重试当前节点</button>' : ''}
          ${canRecord ? `<form id="content-node-record-form" class="content-node-record-form"><div class="eyebrow">LOCAL TEST RECORD</div><label><span>节点结果</span><select name="status"><option value="succeeded">已完成</option><option value="blocked">已阻塞</option><option value="failed">执行失败</option><option value="skipped">已跳过</option></select></label><label><span>测试输出</span><textarea name="output" rows="4" placeholder="仅记录真实测试结果；不要把未执行的 AI 结果写成成功。" required></textarea></label><label><span>备注</span><input name="note" type="text" maxlength="500" placeholder="例如：使用本地测试素材完成解析" /></label><button class="button button-secondary" type="submit" data-record-node="${escapeHtml(activeNode?.id || '')}">登记节点结果</button></form>` : '<div class="node-blocked-hint">工作流尚未启动。启动后才能登记本地测试节点结果。</div>'}
          ${canRecord ? '<form id="content-review-form" class="content-review-form"><div class="eyebrow">HUMAN REVIEW GATE</div><label><span>审核决定</span><select name="decision"><option value="changes_requested">退回修改</option><option value="approved">审核通过</option><option value="rejected">拒绝</option></select></label><label><span>审核意见</span><textarea name="note" rows="3" maxlength="2000" placeholder="记录事实、品牌、版权、平台和内容质量判断。" required></textarea></label><button class="button button-dark" type="submit">保存审核记录</button></form>' : '<div class="node-blocked-hint">启动工作流后，才能提交人工审核记录。</div>'}
          ${canRecord && task.status === 'changes_requested' && nodeStatus('CE-21') === 'ready' ? '<form id="content-revision-form" class="content-review-form"><div class="eyebrow">VERSION REVISION</div><label><span>修改说明</span><textarea name="changes" rows="3" maxlength="5000" placeholder="填写审核意见对应的实际修改，例如补充来源、删除未经证实的承诺。" required></textarea></label><label><span>新版本内容（可选）</span><textarea name="content" rows="5" maxlength="30000" placeholder="粘贴修改后的脚本/文案；旧版本不会被覆盖。"></textarea></label><button class="button button-secondary" type="submit">应用修改并生成新版本</button></form>' : ''}
        </section>
      </div>
      ${replay ? `<details class="content-source-details" open><summary>运行回放：${escapeHtml(replaySummary)}</summary><pre>${escapeHtml(JSON.stringify(replay, null, 2))}</pre></details>` : ''}
      <details class="content-source-details"><summary>查看素材说明与版本证据</summary><p>${escapeHtml(task.sourceBrief || '尚未填写素材说明')}</p><pre>${escapeHtml(JSON.stringify({ run: task.run, reviews: task.reviews, versions: task.versions }, null, 2))}</pre></details>
    `;
  }

  function render() {
    renderTaskList();
    renderDetail();
  }

  async function loadTasks(options = {}) {
    try {
      const payload = await api('/api/content/tasks');
      contentState.tasks = payload.tasks || [];
      contentState.workflow = payload.workflow || null;
      try {
        contentState.workspace = await api('/api/workspace');
        renderContextOptions();
        const capabilities = contentState.workspace.capabilities || {};
        const ai = contentState.workspace.ai || {};
        const generationStatus = ai.configured ? 'DeepSeek 已配置' : ai.localDraftGenerator ? '本地模板可用（需人工审核）' : 'AI 生成未配置';
        elements.runtimeStrip.textContent = `SQLite 工作区 · ${capabilities.ffprobe && capabilities.ffmpeg ? '媒体探测/关键帧/渲染可用' : '媒体工具不完整'} · ${capabilities.transcription ? 'ASR 已配置' : 'ASR 未配置'} · ${capabilities.ocr ? 'OCR 已配置' : 'OCR 未配置'} · ${generationStatus}`;
        elements.runtimeStrip.className = 'content-runtime-strip' + (capabilities.ffprobe && capabilities.ffmpeg ? ' is-ready' : ' is-warning');
      } catch {
        elements.runtimeStrip.textContent = '工作区能力读取失败，请检查服务状态';
        elements.runtimeStrip.className = 'content-runtime-strip is-warning';
      }
      if (options.selectFirst !== false && (!contentState.selectedTaskId || !contentState.tasks.some((task) => task.id === contentState.selectedTaskId))) {
        contentState.selectedTaskId = contentState.tasks[0]?.id || null;
      }
      if (!contentState.tasks.some((task) => task.id === contentState.selectedTaskId)) {
        contentState.selectedTaskId = null;
      }
      if (contentState.selectedTaskId) {
        const detailPayload = await api('/api/content/tasks/' + encodeURIComponent(contentState.selectedTaskId));
        contentState.details[contentState.selectedTaskId] = detailPayload.task;
        const assetsPayload = await api('/api/content/tasks/' + encodeURIComponent(contentState.selectedTaskId) + '/assets');
        contentState.assets[contentState.selectedTaskId] = assetsPayload.assets || [];
      }
      render();
    } catch (error) {
      if (error.httpStatus === 401) {
        elements.taskList.innerHTML = '<div class="empty-state compact"><span>⌁</span><p>登录后读取内容任务。</p></div>';
        elements.detail.innerHTML = '<div class="empty-workspace compact-empty"><div class="empty-orbit">⌁</div><h3>需要登录</h3><p>内容任务与素材属于工作台数据，请先登录后继续。</p></div>';
        return;
      }
      elements.taskList.innerHTML = '<div class="empty-state compact"><span>!</span><p>' + escapeHtml(error.message || '内容任务读取失败') + '</p></div>';
    }
  }

  async function createTask(event) {
    event.preventDefault();
    const data = new FormData(elements.form);
    const platforms = String(data.get('platforms') || '')
      .split(/[，,]/)
      .map((item) => item.trim())
      .filter(Boolean);
    elements.formMessage.textContent = '正在创建…';
    elements.formMessage.className = 'form-message is-working';
    try {
      const payload = await api('/api/content/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: data.get('title'),
          objective: data.get('objective'),
              audience: data.get('audience'),
              platforms,
              customerId: data.get('customerId') || null,
              brandProfileId: data.get('brandProfileId') || null,
              sourceBrief: data.get('sourceBrief'),
          sourceAssets: String(data.get('sourceAssetPath') || '').trim() ? [String(data.get('sourceAssetPath')).trim()] : [],
        }),
      });
      contentState.selectedTaskId = payload.task.id;
      elements.form.reset();
      elements.formMessage.textContent = '已创建，下一步启动本地测试工作流';
      elements.formMessage.className = 'form-message is-success';
      await loadTasks({ selectFirst: false });
    } catch (error) {
      elements.formMessage.textContent = error.message || '创建失败';
      elements.formMessage.className = 'form-message is-error';
    }
  }

  async function startTask(taskId) {
    try {
      await api('/api/content/tasks/' + encodeURIComponent(taskId) + '/start', { method: 'POST' });
      await loadTasks({ selectFirst: false });
    } catch (error) {
      window.alert(error.message || '工作流启动失败');
    }
  }

  async function controlTask(taskId, action, body, errorMessage) {
    try {
      await api('/api/content/tasks/' + encodeURIComponent(taskId) + workflowControlPaths[action], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      await loadTasks({ selectFirst: false });
    } catch (error) {
      window.alert(error.message || errorMessage);
    }
  }

  async function replayTask(taskId) {
    try {
      const payload = await api('/api/content/tasks/' + encodeURIComponent(taskId) + '/replay');
      contentState.replays[taskId] = payload.replay;
      renderDetail();
    } catch (error) {
      window.alert(error.message || '运行回放读取失败');
    }
  }

  async function recordNode(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const task = selectedTask();
    const nodeId = form.querySelector('[data-record-node]')?.dataset.recordNode;
    if (!task || !nodeId) {
      return;
    }
    const data = new FormData(form);
    try {
      await api('/api/content/tasks/' + encodeURIComponent(task.id) + '/nodes/' + encodeURIComponent(nodeId) + '/record', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: data.get('status'),
          output: { text: String(data.get('output') || '') },
          note: data.get('note'),
        }),
      });
      await loadTasks({ selectFirst: false });
    } catch (error) {
      window.alert(error.message || '节点登记失败');
    }
  }

  async function parseMaterial(event) {
    event.preventDefault();
    const task = selectedTask();
    if (!task) return;
    const path = String(new FormData(event.currentTarget).get('path') || '').trim();
    try {
      await api('/api/content/tasks/' + encodeURIComponent(task.id) + '/materials/parse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      await loadTasks({ selectFirst: false });
    } catch (error) {
      window.alert(error.message || '素材解析失败');
    }
  }

  async function runContentAction(path, body, errorMessage) {
    const task = selectedTask();
    if (!task) return;
    try {
      await api('/api/content/tasks/' + encodeURIComponent(task.id) + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      if (path === '/release-drafts') {
        window.dispatchEvent(new CustomEvent('release-draft-created'));
      }
      await loadTasks({ selectFirst: false });
    } catch (error) {
      window.alert(error.message || errorMessage);
    }
  }

  async function reviewTask(event) {
    event.preventDefault();
    const task = selectedTask();
    if (!task) {
      return;
    }
    const data = new FormData(event.currentTarget);
    try {
      await api('/api/content/tasks/' + encodeURIComponent(task.id) + '/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: data.get('decision'), note: data.get('note') }),
      });
      await loadTasks({ selectFirst: false });
    } catch (error) {
      window.alert(error.message || '审核记录保存失败');
    }
  }

  async function applyRevision(event) {
    event.preventDefault();
    const task = selectedTask();
    if (!task) return;
    const data = new FormData(event.currentTarget);
    const content = String(data.get('content') || '').trim();
    try {
      await api('/api/content/tasks/' + encodeURIComponent(task.id) + '/revision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changes: data.get('changes'), ...(content ? { content: { text: content } } : {}) }),
      });
      await loadTasks({ selectFirst: false });
    } catch (error) {
      window.alert(error.message || '版本修改失败');
    }
  }

  elements.form.addEventListener('submit', createTask);
  root.addEventListener('click', (event) => {
    const taskButton = event.target.closest('[data-content-task]');
    if (taskButton) {
      contentState.selectedTaskId = taskButton.dataset.contentTask;
      contentState.selectedNodeId = null;
      loadTasks({ selectFirst: false });
      return;
    }
    const nodeButton = event.target.closest('[data-content-node]');
    if (nodeButton) {
      contentState.selectedNodeId = nodeButton.dataset.contentNode;
      renderDetail();
      return;
    }
    const startButton = event.target.closest('[data-start-content]');
    if (startButton) {
      startTask(startButton.dataset.startContent);
      return;
    }
    const pauseButton = event.target.closest('[data-pause-content]');
    if (pauseButton) {
      controlTask(pauseButton.dataset.pauseContent, 'pause', {}, '工作流暂停失败');
      return;
    }
    const resumeButton = event.target.closest('[data-resume-content]');
    if (resumeButton) {
      controlTask(resumeButton.dataset.resumeContent, 'resume', {}, '工作流继续失败');
      return;
    }
    const retryButton = event.target.closest('[data-retry-content]');
    if (retryButton) {
      controlTask(retryButton.dataset.retryContent, 'retry', { nodeId: retryButton.dataset.retryNode }, '节点重试失败');
      return;
    }
    const replayButton = event.target.closest('[data-replay-content]');
    if (replayButton) {
      replayTask(replayButton.dataset.replayContent);
      return;
    }
    const analyzeButton = event.target.closest('[data-analyze-content]');
    if (analyzeButton) {
      runContentAction('/analyze', {}, '内容结构分析失败');
      return;
    }
    const generateButton = event.target.closest('[data-generate-content]');
    if (generateButton) {
      runContentAction('/generate', { kind: generateButton.dataset.generateContent }, 'AI 生成失败');
      return;
    }
    const renderButton = event.target.closest('[data-render-content]');
    if (renderButton) {
      runContentAction('/render', {}, '本地渲染失败');
      return;
    }
    const packageButton = event.target.closest('[data-package-content]');
    if (packageButton) {
      runContentAction('/package', {}, '内容打包失败');
      return;
    }
    const releaseDraftButton = event.target.closest('[data-create-release-draft]');
    if (releaseDraftButton) {
      const task = selectedTask();
      if (!task) return;
      const copy = task.nodes.find((node) => node.id === 'CE-11')?.output || {};
      const packaged = task.nodes.find((node) => node.id === 'CE-22')?.output || {};
      runContentAction('/release-drafts', {
        platform: task.platforms[0] || 'xhs',
        title: task.title,
        text: copy.text || '',
        packagePath: packaged.path || '',
        requiresHumanApproval: true,
      }, '创建发布草稿失败');
      return;
    }
    const executeButton = event.target.closest('[data-execute-node]');
    if (executeButton) {
      const task = selectedTask();
      runContentAction('/execute-node', { nodeId: executeButton.dataset.executeNode, path: task?.sourceAssets?.[0] || '' }, '节点执行失败');
    }
  });
  root.addEventListener('submit', (event) => {
    if (event.target.matches('#content-material-form')) {
      parseMaterial(event);
    }
    if (event.target.matches('#content-node-record-form')) {
      recordNode(event);
    }
    if (event.target.matches('#content-review-form')) {
      reviewTask(event);
    }
    if (event.target.matches('#content-revision-form')) {
      applyRevision(event);
    }
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-view="content"]')) {
      loadTasks();
    }
  });

  render();
  loadTasks();
  window.setInterval(() => {
    if (window.location.hash === '#content') {
      loadTasks({ selectFirst: false });
    }
  }, 15_000);
}
