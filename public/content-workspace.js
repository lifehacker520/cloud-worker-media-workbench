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
    batchCatalogs: {},
    mediaWorkerHealth: {},
    voiceComparisonTestSet: null,
    batches: {},
    batchPlans: {},
    batchPlanInputs: {},
  };

  const statusLabels = {
    draft: '待整理',
    queued: '已排队',
    running: '执行中',
    waiting_review: '待审核',
    waiting_approval: '待确认批量计划',
    changes_requested: '待修改',
    approved: '已审核',
    packaged: '已打包',
    ready_for_publish: '待发布',
    failed: '执行失败',
    blocked: '已阻塞',
    partial_failed: '部分失败',
    completed: '批次完成',
    cancelled: '已取消',
    pending: '未开始',
    ready: '待执行',
    waiting_selection: '待人工选择',
    selected: '已选定',
    simulation: '仅模拟（不可交付）',
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

  function catalogStatusLabel(record) {
    if (record?.status === 'simulation' || record?.simulation === true || record?.health?.simulation === true) return '仅模拟（不可交付）';
    if (record?.kind === 'media_worker') return record.status === 'ready' ? '可用' : '不可用';
    return labelForStatus(record?.status);
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
      error.payload = payload;
      if (payload.task?.id) {
        contentState.details[payload.task.id] = payload.task;
        if (contentState.selectedTaskId === payload.task.id) renderDetail();
      }
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
    <section class="panel content-flow-overview" aria-label="内容编辑完整工作流">
      <div class="panel-heading">
        <div><div class="eyebrow">CONTENT EDITOR FLOW</div><h2>一条任务，从素材到内容包</h2><p>下面是当前内容编辑云员工已经接入的操作路径；创建任务后，每一步都会留下状态、证据和人工确认。</p></div>
        <span class="phase-label">26 个节点</span>
      </div>
      <div class="content-flow-grid">
        <article class="content-flow-card is-ready"><div class="content-flow-card-head"><span class="content-flow-index">01</span><div><strong>任务与素材</strong><small>创建 → 授权 → 解析 → 结构分析</small></div><span class="content-flow-status is-ready">可操作</span></div><p>绑定目标、平台和品牌上下文，导入已授权素材并保留来源引用。</p></article>
        <article class="content-flow-card is-human"><div class="content-flow-card-head"><span class="content-flow-index">02</span><div><strong>选题与文案</strong><small>选题 → 脚本 → 平台版本 → 分镜</small></div><span class="content-flow-status is-human">人工确认</span></div><p>候选结果不能直接交付，负责人选择选题并审核事实、表达和平台规则。</p></article>
        <article class="content-flow-card is-blocked"><div class="content-flow-card-head"><span class="content-flow-index">03</span><div><strong>媒体与审核</strong><small>声音/数字人 → 字幕 → 封面 → 审核</small></div><span class="content-flow-status is-blocked">按能力执行</span></div><p>本地媒体工具可用；TTS、数字人没有真实模型时明确显示未配置/待接入。</p></article>
        <article class="content-flow-card is-human"><div class="content-flow-card-head"><span class="content-flow-index">04</span><div><strong>批量与交付</strong><small>矩阵 → 单条状态 → 重试 → 导出</small></div><span class="content-flow-status is-human">人工闸门</span></div><p>已审核数字人、文案和模板才能进入批次，最终输出内容包和发布草稿。</p></article>
      </div>
      <div class="content-flow-footer"><span class="content-flow-footer-label">当前能力</span><span class="content-flow-pill is-ready">解析/结构/本地渲染/字幕/封面</span><span class="content-flow-pill is-blocked">TTS/数字人：未配置/待接入</span><button class="button button-secondary button-small" type="button" data-content-create-focus>开始创建内容任务 <span>→</span></button></div>
    </section>
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
          <input name="sourceWorkFingerprint" type="hidden" />
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

  function applyWorkPrefill(prefill) {
    if (!prefill || !elements.form) {
      return;
    }
    elements.form.dataset.sourceWorkFingerprint = String(prefill.sourceWorkFingerprint || '');
    for (const [name, value] of Object.entries(prefill)) {
      const field = elements.form.elements.namedItem(name);
      if (field && typeof value === 'string') {
        field.value = value;
      }
    }
    elements.formMessage.textContent = '已带入监控作品来源；创建前请确认素材授权。';
    elements.formMessage.className = 'form-message is-working';
    elements.form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    elements.form.elements.namedItem('title')?.focus();
  }

  window.addEventListener('content-work-prefill', (event) => {
    applyWorkPrefill(event.detail);
  });

  try {
    const savedPrefill = window.sessionStorage.getItem('cloud-worker-content-prefill');
    if (savedPrefill) {
      applyWorkPrefill(JSON.parse(savedPrefill));
      window.sessionStorage.removeItem('cloud-worker-content-prefill');
    }
  } catch {
    // A prefill is optional; the regular empty form remains usable.
  }

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
      elements.taskList.innerHTML = '<div class="empty-state compact"><span>▧</span><p>还没有内容任务，先创建第一条。</p><button class="button button-quiet button-small" type="button" data-content-create-focus>开始创建任务</button></div>';
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

  function catalogOptions(records, selected = []) {
    const chosen = new Set(selected);
    return (records || []).map((record) => `<option value="${escapeHtml(record.id)}"${chosen.has(record.id) ? ' selected' : ''}>${escapeHtml(record.displayName || record.title || record.name || record.id)} · ${escapeHtml(catalogStatusLabel(record))}</option>`).join('');
  }

  function renderMvpStage(task, label, nodeIds, detail = '') {
    const nodes = nodeIds.map((id) => task.nodes.find((node) => node.id === id)).filter(Boolean);
    const node = nodes.find((item) => item.status === 'failed' || item.status === 'blocked')
      || nodes.find((item) => item.status === 'ready' || item.status === 'running' || item.status === 'waiting_review')
      || [...nodes].reverse().find((item) => ['succeeded', 'skipped'].includes(item.status))
      || nodes[0];
    const output = node?.output || {};
    const value = detail || output.text || output.summary || output.reason || output.path || output.packagePath || '';
    return `<div class="content-mvp-stage is-${escapeHtml(node?.status || 'pending')}"><div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(labelForStatus(node?.status || 'pending'))}</span></div>${value ? `<small>${escapeHtml(String(value).replace(/\s+/g, ' ').slice(0, 180))}</small>` : ''}</div>`;
  }

  function renderCapability(label, ready, detail) {
    return `<div class="content-capability ${ready ? 'is-ready' : 'is-blocked'}"><span class="signal-dot"></span><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></div></div>`;
  }

  function assetPreview(taskId, asset) {
    if (!['video', 'audio', 'image'].includes(asset?.kind)) return '';
    const url = '/api/content/tasks/' + encodeURIComponent(taskId) + '/assets/' + encodeURIComponent(asset.id) + '/file';
    if (asset.kind === 'video') return `<video class="content-asset-preview" controls preload="metadata" aria-label="${escapeHtml(asset.filename)}" src="${escapeHtml(url)}"></video>`;
    if (asset.kind === 'audio') return `<audio class="content-asset-preview" controls preload="metadata" aria-label="${escapeHtml(asset.filename)}" src="${escapeHtml(url)}"></audio>`;
    return `<img class="content-asset-preview content-asset-image" loading="lazy" alt="${escapeHtml(asset.filename)}" src="${escapeHtml(url)}" />`;
  }

  function transcriptConfidenceSummary(asset) {
    if (!['video', 'audio'].includes(asset?.kind)) return '';
    const transcript = asset.metadata?.transcriptResult;
    const confidence = transcript?.confidence;
    if (!confidence || transcript?.status === 'not_applicable') return '';
    if (confidence.requiresHumanReview || confidence.status === 'unavailable') {
      const flags = [];
      if ((confidence.lowConfidenceSegments || []).length) flags.push(`${confidence.lowConfidenceSegments.length} 个低置信度片段`);
      if ((confidence.missingConfidenceSegments || []).length) flags.push(`${confidence.missingConfidenceSegments.length} 个缺失置信度片段`);
      if (!flags.length) flags.push('未提供可校对的转写置信度/时间码');
      return `<small class="content-asset-confidence is-warning">转写置信度：${escapeHtml(flags.join('、'))} · 需人工校对</small>`;
    }
    return '<small class="content-asset-confidence is-ready">转写置信度已提供 · 可进入人工抽检</small>';
  }

  function mediaOrientationSummary(asset) {
    if (asset?.kind !== 'video') return '';
    const stream = (asset.metadata?.media?.streams || []).find((item) => item.codec_type === 'video');
    const degrees = Number(stream?.rotation?.degrees);
    if (!Number.isFinite(degrees) || degrees === 0) return '';
    return `<small class="content-asset-orientation">检测到显示旋转 ${escapeHtml(degrees)}° · 请确认画面方向</small>`;
  }

  function ocrEvidenceSummary(asset) {
    if (!['video', 'image'].includes(asset?.kind)) return '';
    const result = asset.metadata?.ocrResult;
    if (!result) return '';
    if (result.status === 'succeeded') {
      const detections = Array.isArray(result.detections) ? result.detections.length : 0;
      return detections
        ? `<small class="content-asset-ocr is-ready">OCR 已识别 ${detections} 个文字框 · 含位置/置信度证据</small>`
        : '<small class="content-asset-ocr is-ready">OCR 已完成 · 请人工校对识别文字</small>';
    }
    if (result.status === 'not_configured') {
      return '<small class="content-asset-ocr is-warning">OCR 未配置 · 可接入 Vision 或 XHS_OCR_COMMAND</small>';
    }
    return `<small class="content-asset-ocr is-warning">OCR ${escapeHtml(result.message || '未完成')} · 需人工处理</small>`;
  }

  function contentHashSummary(asset) {
    const hash = String(asset?.metadata?.contentHash || '').trim();
    if (!/^[a-f0-9]{64}$/i.test(hash)) return '';
    return `<small class="content-asset-hash">SHA-256 ${escapeHtml(hash.slice(0, 12))}…</small>`;
  }

  function contentAuthorizationSummary(asset) {
    if (asset?.metadata?.sourceType !== 'user_material') return '';
    const authorizationRef = String(asset.metadata.authorizationRef || '').trim();
    if (asset.metadata.authorizationStatus === 'approved' && authorizationRef) {
      return `<small class="content-asset-authorization is-ready">素材授权已确认 · ${escapeHtml(authorizationRef)}</small>`;
    }
    return '<small class="content-asset-authorization is-warning">素材授权未确认 · 不能进入内容包</small>';
  }

  function renderVoiceComparisonPanel(task, voices) {
    const comparisons = Array.isArray(task.voiceComparisons) ? [...task.voiceComparisons].reverse() : [];
    const assets = contentState.assets[task.id] || [];
    const testCases = contentState.voiceComparisonTestSet?.cases || [];
    const voiceLabel = (voiceVersionId) => {
      const voice = voices.find((item) => item.id === voiceVersionId);
      return voice?.displayName || voice?.name || voiceVersionId;
    };
    const candidatePreview = (candidate) => {
      const previewFor = (reference, assetIds, label) => {
        const asset = assets.find((item) => assetIds?.includes(item.id) && item.kind === 'audio');
        if (asset) return assetPreview(task.id, asset);
        return /^https?:\/\//i.test(String(reference || ''))
          ? `<audio class="content-voice-comparison-audio" controls preload="metadata" aria-label="${escapeHtml(label)}"><source src="${escapeHtml(reference)}" /></audio>`
          : `<small class="content-voice-comparison-ref">输出引用：${escapeHtml(reference || '暂无')}</small>`;
      };
      const segments = candidate.output?.segments || [];
      if (segments.length > 1) {
        return `<div class="content-voice-comparison-segments">${segments.map((segment) => `<div><small>第 ${segment.index + 1} 段 · ${segment.start ?? '—'}s–${segment.end ?? '—'}s</small>${previewFor(segment.audioRef, segment.assetIds, `第 ${segment.index + 1} 段声音`)}</div>`).join('')}</div>`;
      }
      return previewFor(candidate.output?.audioRef, candidate.output?.assetIds, candidate.displayName || candidate.voiceVersionId);
    };
    const ratingOptions = (value = 3) => [1, 2, 3, 4, 5].map((rating) => `<option value="${rating}"${Number(value) === rating ? ' selected' : ''}>${rating}</option>`).join('');
    const candidateReviewForm = (comparison, candidate) => {
      if (candidate.status !== 'succeeded') return '';
      const review = candidate.qualityReview || {};
      return `<form class="content-voice-review-form" data-voice-review-form data-voice-review-task="${escapeHtml(task.id)}" data-voice-review-comparison="${escapeHtml(comparison.id)}" data-voice-review-voice="${escapeHtml(candidate.voiceVersionId)}"><strong>人工质量评估</strong><label><span>固定验收样本</span><select name="testCaseId"><option value="">未指定样本</option>${testCases.map((item) => `<option value="${escapeHtml(item.id)}"${review.testCaseId === item.id ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}</select></label><div class="content-voice-review-ratings"><label><span>准确度</span><select name="accuracy" required>${ratingOptions(review.ratings?.accuracy)}</select></label><label><span>自然度</span><select name="naturalness" required>${ratingOptions(review.ratings?.naturalness)}</select></label><label><span>语速</span><select name="speed" required>${ratingOptions(review.ratings?.speed)}</select></label></div><div class="content-voice-review-metrics"><label><span>VRAM GiB（可选）</span><input name="vramGiB" type="number" min="0" step="0.1" value="${escapeHtml(review.resourceUsage?.vramGiB ?? '')}" /></label><label><span>耗时 ms（可选）</span><input name="elapsedMs" type="number" min="0" step="1" value="${escapeHtml(review.resourceUsage?.elapsedMs ?? '')}" /></label></div><textarea name="notes" rows="2" maxlength="5000" placeholder="记录发音、停顿、失败或许可证/授权检查结果">${escapeHtml(review.notes || '')}</textarea><button class="button button-quiet button-small" type="submit">保存质量评估</button>${review.reviewedAt ? `<small>最近评估：${escapeHtml(formatTime(review.reviewedAt))} · ${escapeHtml(review.simulated ? '模拟输出，不能替代真实模型结论' : '真实输出待人工复核')}</small>` : ''}</form>`;
    };
    const comparisonCards = comparisons.length
      ? comparisons.map((comparison) => `<article class="content-voice-comparison-card"><div class="content-voice-comparison-card-heading"><div><strong>${escapeHtml(comparison.status === 'selected' ? '已选定声音版本' : '声音 A/B 试听')}</strong><small>${escapeHtml(labelForStatus(comparison.status))} · ${escapeHtml(formatTime(comparison.updatedAt))}${comparison.defaultVoiceVersionId ? ` · 默认：${escapeHtml(voiceLabel(comparison.defaultVoiceVersionId))}` : ''}${comparison.backupVoiceVersionId ? ` · 备用：${escapeHtml(voiceLabel(comparison.backupVoiceVersionId))}` : ''}</small></div>${comparison.status === 'partial_failed' ? `<button class="button button-quiet button-small" type="button" data-retry-voice-comparison="${escapeHtml(comparison.id)}">仅重试失败候选</button>` : ''}</div><p class="content-voice-comparison-script">${escapeHtml(comparison.scriptText || '')}</p><div class="content-voice-comparison-candidates">${(comparison.candidates || []).map((candidate) => `<div class="content-voice-comparison-candidate${candidate.voiceVersionId === task.selectedVoiceVersionId || candidate.voiceVersionId === task.backupVoiceVersionId ? ' is-selected' : ''}"><div><strong>${escapeHtml(candidate.displayName || voiceLabel(candidate.voiceVersionId))}</strong><span class="content-batch-status status-${escapeHtml(candidate.status)}">${escapeHtml(labelForStatus(candidate.status))}</span><small>${escapeHtml(candidate.input?.voice?.provider || '未指定模型')} · 第 ${candidate.attempt || 0} 次 · ${escapeHtml(candidate.output?.modelVersion || candidate.input?.voice?.modelVersion || '模型版本待回传')} · 许可证：${escapeHtml(candidate.input?.voice?.licenseRef || '未登记')}</small></div>${candidate.status === 'succeeded' ? candidatePreview(candidate) : `<small class="content-voice-comparison-error">${escapeHtml(candidate.error || '候选生成失败')}</small>`}${candidate.status === 'succeeded' ? `<div class="content-voice-comparison-actions"><button class="button ${candidate.voiceVersionId === task.selectedVoiceVersionId ? 'button-dark' : 'button-secondary'} button-small" type="button" data-select-voice-comparison="${escapeHtml(comparison.id)}" data-select-voice-version="${escapeHtml(candidate.voiceVersionId)}" data-select-voice-role="default">${candidate.voiceVersionId === task.selectedVoiceVersionId ? '已是默认' : '设为默认'}</button><button class="button ${candidate.voiceVersionId === task.backupVoiceVersionId ? 'button-dark' : 'button-quiet'} button-small" type="button" data-select-voice-comparison="${escapeHtml(comparison.id)}" data-select-voice-version="${escapeHtml(candidate.voiceVersionId)}" data-select-voice-role="backup">${candidate.voiceVersionId === task.backupVoiceVersionId ? '已是备用' : '设为备用'}</button></div>${candidateReviewForm(comparison, candidate)}` : ''}</div>`).join('')}</div></article>`).join('')
      : '<div class="empty-state compact"><span>♬</span><p>还没有 A/B 试听记录。</p></div>';
    const selectionHint = task.selectedVoiceVersionId
      ? `当前默认：${escapeHtml(voiceLabel(task.selectedVoiceVersionId))}${task.backupVoiceVersionId ? `；备用：${escapeHtml(voiceLabel(task.backupVoiceVersionId))}` : '；尚未确认备用声线'}；仍可试听并改选。`
      : '先选两个已审核、已授权的声音版本，再用同一份 CE-11 脚本试听。';
    const testSet = testCases.length
      ? `<details class="content-voice-test-set"><summary>固定验收样本 · ${escapeHtml(contentState.voiceComparisonTestSet.version)}</summary><div class="content-voice-test-grid">${testCases.map((item) => `<div class="content-voice-test-case is-${escapeHtml(item.kind)}"><strong>${escapeHtml(item.label)}</strong><small>${item.kind === 'negative' ? '预期：阻断 · ' + escapeHtml(item.blockedReason) : escapeHtml(item.acceptance || '人工试听')}</small>${item.kind === 'positive' ? `<button class="button button-quiet button-small" type="button" data-apply-voice-test="${escapeHtml(item.id)}" data-voice-test-task="${escapeHtml(task.id)}">填入试听脚本</button>` : '<span class="content-voice-test-gate">应阻断</span>'}</div>`).join('')}</div></details>`
      : '';
    return `<section class="content-voice-comparison" data-voice-comparison="${escapeHtml(task.id)}"><div class="content-voice-comparison-heading"><div><div class="eyebrow">VOICE A/B / M5</div><h4>声音试听与人工选择</h4><p>${selectionHint}</p></div></div>${voices.length >= 2 ? `<form class="content-voice-comparison-form" data-voice-comparison-form="${escapeHtml(task.id)}"><label><span>选择两个声音版本</span><select name="voiceVersionIds" multiple size="${Math.min(4, Math.max(2, voices.length))}" required>${catalogOptions(voices, [])}</select></label><label><span>试听脚本（默认使用 CE-11）</span><textarea name="scriptText" rows="3" maxlength="30000" required>${escapeHtml(task.nodes.find((item) => item.id === 'CE-11')?.output?.text || '')}</textarea></label><button class="button button-secondary button-small" type="submit">生成两条试听</button></form>` : '<div class="node-blocked-hint">至少登记两个已审核、已授权且允许使用的声音版本后，才能进行 A/B 试听。</div>'}${testSet}<div class="content-voice-comparison-list">${comparisonCards}</div></section>`;
  }

  function renderBatchItem(batch, item) {
    const videoRef = item.output?.renderedVideoRef || item.output?.videoRef;
    const postprocess = item.output?.postprocess;
    const postprocessNote = postprocess?.status === 'succeeded'
      ? ' · 已完成模板后处理'
      : ['failed', 'blocked'].includes(postprocess?.status)
        ? ' · 模板后处理' + labelForStatus(postprocess.status) + '：' + (postprocess.error?.message || '请重试')
        : '';
    const output = videoRef ? `${item.output.simulated ? '模拟输出（不可交付）' : '模型成片'} · ${videoRef}${postprocessNote}` : item.error?.message || '等待执行';
    const preview = (ref, kind) => {
      const localPreview = /^file:/i.test(String(ref || ''))
        ? `/api/content/batches/${encodeURIComponent(batch.id)}/items/${encodeURIComponent(item.id)}/file?kind=${kind}`
        : null;
      const source = localPreview || ref;
      return (/^https?:\/\//i.test(String(source || '')) || Boolean(localPreview))
        ? kind === 'video'
          ? `<video class="content-batch-preview" controls preload="metadata" aria-label="数字人成片预览"><source src="${escapeHtml(source)}" /></video>`
          : `<audio class="content-batch-audio" controls preload="metadata" aria-label="声音预览"><source src="${escapeHtml(source)}" /></audio>`
        : '';
    };
    const previews = item.output ? `${preview(videoRef, 'video')}${preview(item.output.audioRef, 'audio')}` : '';
    const postprocessButton = item.status === 'succeeded' && /^file:/i.test(String(item.output?.videoRef || ''))
      ? `<button class="button button-secondary button-small" type="button" data-postprocess-batch="${escapeHtml(batch.id)}" data-postprocess-item="${escapeHtml(item.id)}">${item.output?.postprocess?.status === 'succeeded' ? '重新后处理' : '生成模板成片'}</button>`
      : '';
    const reviewButtons = item.status === 'succeeded'
      ? item.output?.simulated === true
        ? '<span class="node-blocked-hint">模拟结果不可批准</span>'
        : `${postprocessButton}<button class="button button-quiet button-small" type="button" data-review-batch="${escapeHtml(batch.id)}" data-review-item="${escapeHtml(item.id)}" data-review-decision="approved">通过</button><button class="button button-quiet button-small" type="button" data-review-batch="${escapeHtml(batch.id)}" data-review-item="${escapeHtml(item.id)}" data-review-decision="changes_requested">退回</button>`
      : ['failed', 'blocked', 'changes_requested'].includes(item.status)
        ? `<button class="button button-quiet button-small" type="button" data-retry-batch="${escapeHtml(batch.id)}" data-retry-item="${escapeHtml(item.id)}">${item.status === 'changes_requested' ? '重新生成' : '重试'}</button>`
        : '';
    return `<tr><td><strong>${escapeHtml(item.avatarVersionId)}</strong><small>${escapeHtml(item.voiceVersionId || '默认声音')}</small></td><td>${escapeHtml(item.scriptVersionId)}</td><td><span class="content-batch-status status-${escapeHtml(item.status)}">${escapeHtml(labelForStatus(item.status))}</span>${previews}<small>${escapeHtml(output)}</small></td><td>${reviewButtons}</td></tr>`;
  }

  function renderBatchPanel(task) {
    const catalog = contentState.batchCatalogs[task.id] || {};
    const batches = contentState.batches[task.id] || [];
    const plan = contentState.batchPlans[task.id] || null;
    const planInput = contentState.batchPlanInputs[task.id] || {};
    const avatars = (catalog.avatars || []).filter((item) => item.status === 'approved' && item.batchAllowed);
    const voices = (catalog.voices || []).filter((item) => item.status === 'approved' && item.batchAllowed);
    const scripts = (catalog.scripts || []).filter((item) => item.status === 'approved');
    const templates = (catalog.templates || []).filter((item) => ['approved', 'active'].includes(item.status) && item.batchAllowed !== false);
    const connectors = (catalog.connectors || []).filter((item) => ['ready', 'simulation'].includes(item.status) && item.capabilities?.includes('talking_head'));
    const remoteConnector = (catalog.connectors || []).find((item) => item.config?.mode === 'http-worker');
    const workerHealth = contentState.mediaWorkerHealth[task.id] || remoteConnector?.health || null;
    const workerSimulation = workerHealth?.status === 'simulation'
      || workerHealth?.simulation === true
      || remoteConnector?.status === 'simulation'
      || remoteConnector?.health?.simulation === true;
    const workerReady = !workerSimulation && (workerHealth?.status === 'ready' || remoteConnector?.status === 'ready');
    const workerHint = remoteConnector
      ? workerSimulation
        ? `已连接 ${remoteConnector.name}，但当前只返回模拟输出；不可审核通过或导出交付。`
        : workerReady
        ? `已接入 ${remoteConnector.name}；实际模型输出仍需负责人观看验收。`
        : `外部 worker 不可用（${workerHealth?.reason || '请检查地址、进程和模型环境'}）；当前不能选择真实模型执行。`
      : '当前使用本地模拟连接器；真实模型未接入。';
    const phaseLabel = remoteConnector
      ? workerSimulation ? '外部 worker 仅模拟' : workerReady ? '外部 worker 可用' : '外部 worker 不可用'
      : connectors.length ? '本地模拟连接器可用' : '连接器不可用';
    const planCount = plan?.count || 0;
    const controlsFor = (batch) => {
      const controls = [];
      if (['waiting_approval', 'queued'].includes(batch.status)) controls.push(`<button class="button button-primary button-small" type="button" data-start-batch="${escapeHtml(batch.id)}">启动批次</button>`);
      if (['queued', 'running'].includes(batch.status)) controls.push(`<button class="button button-quiet button-small" type="button" data-pause-batch="${escapeHtml(batch.id)}">暂停</button>`);
      if (batch.status === 'paused') controls.push(`<button class="button button-secondary button-small" type="button" data-resume-batch="${escapeHtml(batch.id)}">继续</button>`);
      if (!['completed', 'cancelled'].includes(batch.status)) controls.push(`<button class="button button-quiet button-small" type="button" data-cancel-batch="${escapeHtml(batch.id)}">取消未完成项</button>`);
      if (batch.items?.some((item) => item.status === 'approved' && item.output?.simulated !== true)) controls.push(`<button class="button button-dark button-small" type="button" data-export-batch="${escapeHtml(batch.id)}">导出已通过</button>`);
      return controls.join('');
    };
    const metricsFor = (batch) => {
      const metrics = batch.metrics || {};
      const duration = Number.isFinite(metrics.durationP50Ms) ? ` · 单条 P50 ${metrics.durationP50Ms} ms` : '';
      const queue = Number.isFinite(metrics.queueDurationP50Ms) ? ` · 排队 P50/P95 ${metrics.queueDurationP50Ms}/${metrics.queueDurationP95Ms ?? '—'} ms` : '';
      const cost = metrics.cost?.currency ? ` · 成本 ${metrics.cost.totalAmount} ${metrics.cost.currency}` : '';
      const elapsed = Number.isFinite(metrics.elapsedMs) ? ` · 总耗时 ${metrics.elapsedMs} ms` : '';
      return `并发 ${metrics.observedConcurrency || 0}/${metrics.concurrencyLimit || 1}${duration}${queue}${cost}${elapsed}`;
    };
    const auditFor = (batch) => {
      const audit = batch.audit || {};
      const coverage = audit.human?.sampleCoverage || {};
      const record = batch.auditRecord || {};
      const sampleIds = Array.isArray(record.sampling?.itemIds) ? record.sampling.itemIds.join(', ') : '';
      const status = audit.minimumIntegrityPass ? '完整性通过（仍需负责人决定交付）' : '待补证据或人工抽样';
      const cost = audit.cost?.currency ? `${audit.cost.totalAmount} ${audit.cost.currency}` : '未记录';
      const expansion = audit.human?.sampleCoverage?.expansionRequired ? ' · 抽样含硬失败，需扩大审查' : '';
      const exportStatus = audit.export?.status && audit.export.status !== 'not_run' ? ` · 导出 ${audit.export.status}` : '';
      return `<div class="content-batch-audit"><strong>批次审计：${escapeHtml(status)}</strong><span>矩阵 ${audit.plan?.actualCount || 0}/${audit.plan?.expectedCount || batch.items.length} · 自动媒体 ${audit.media?.checkedCount || 0}/${audit.media?.totalCount || batch.items.length} · 重试 ${audit.retries?.total || 0} · 成本 ${escapeHtml(cost)} · 样本 ${coverage.sampledCount || 0} · 审核通过率 ${audit.human?.passRate === null || audit.human?.passRate === undefined ? '—' : Math.round(audit.human.passRate * 100) + '%'}</span><small>缺件/孤儿：${(audit.media?.pendingItemIds || []).length + (audit.runs?.orphanItemIds || []).length + (audit.quality?.orphanItemIds || []).length} · 技术硬失败率：${audit.failures?.technicalHardFailureRate === null || audit.failures?.technicalHardFailureRate === undefined ? '—' : Math.round(audit.failures.technicalHardFailureRate * 100) + '%'}${escapeHtml(expansion + exportStatus)}</small><form class="content-batch-audit-form" data-batch-audit="${escapeHtml(batch.id)}"><label><span>抽样比例</span><input name="sampleRatio" type="number" min="0" max="1" step="0.01" value="${escapeHtml(record.sampling?.ratio ?? '')}" placeholder="0.1" /></label><label><span>抽样条目 ID（逗号分隔）</span><input name="sampleItemIds" maxlength="12000" value="${escapeHtml(sampleIds)}" placeholder="粘贴需要人工看的条目 ID" /></label><label><span>人工审核分钟</span><input name="reviewMinutes" type="number" min="0" step="1" value="${escapeHtml(record.humanReview?.durationMs ? record.humanReview.durationMs / 60000 : '')}" placeholder="例如 30" /></label><label><span>负责人结论</span><select name="ownerDecision"><option value="pending"${record.ownerDecision === 'pending' || !record.ownerDecision ? ' selected' : ''}>待决定</option><option value="accepted"${record.ownerDecision === 'accepted' ? ' selected' : ''}>接受基线</option><option value="optimize"${record.ownerDecision === 'optimize' ? ' selected' : ''}>下一轮优化</option><option value="blocked"${record.ownerDecision === 'blocked' ? ' selected' : ''}>阻塞交付</option></select></label><label class="content-batch-check"><input name="expandedReview" type="checkbox"${record.sampling?.expanded ? ' checked' : ''} /> 扩大同类审查</label><input name="expandedReason" maxlength="500" value="${escapeHtml(record.sampling?.expandedReason || '')}" placeholder="若扩大审查，填写原因" /><textarea name="reviewNotes" rows="2" maxlength="2000" placeholder="人工审核备注">${escapeHtml(record.humanReview?.notes || '')}</textarea><button class="button button-secondary button-small" type="submit">记录批次审计</button></form></div>`;
    };
    const batchCards = batches.length
      ? batches.map((batch) => `<article class="content-batch-card"><div class="content-batch-card-heading"><div><strong>${escapeHtml(batch.title)}</strong><small>${escapeHtml(labelForStatus(batch.status))} · ${batch.summary?.approved || 0}/${batch.summary?.total || batch.items.length} 条已通过 · 更新 ${escapeHtml(formatTime(batch.updatedAt))}</small></div><div class="content-batch-card-actions">${controlsFor(batch)}</div></div><div class="content-batch-progress"><i><b style="width:${batch.summary?.total ? Math.round(((batch.summary?.approved || 0) / batch.summary.total) * 100) : 0}%"></b></i><span>${batch.summary?.succeeded || 0} 条待审核 · ${batch.summary?.failed || 0} 条失败 · ${batch.summary?.changesRequested || 0} 条待修改${escapeHtml(metricsFor(batch))}</span></div><div class="content-batch-table-wrap"><table class="content-batch-table"><thead><tr><th>数字人/声音</th><th>脚本</th><th>输出</th><th>动作</th></tr></thead><tbody>${batch.items.map((item) => renderBatchItem(batch, item)).join('')}</tbody></table></div>${auditFor(batch)}</article>`).join('')
      : '<div class="empty-state compact"><span>◇</span><p>还没有批量生产批次。先登记已授权资产，再预览组合。</p></div>';
    return `<section class="content-batch-panel"><div class="content-batch-heading"><div><div class="eyebrow">BATCH MEDIA / CE-SG04</div><h3>数字人批量生产</h3><p>先登记已审核、已授权的数字人/声音和脚本，再生成可暂停、可重试、逐条审核的组合批次。${escapeHtml(workerHint)}</p></div><span class="phase-label">${escapeHtml(phaseLabel)}</span></div><div class="content-batch-registration"><form class="content-batch-mini-form" data-batch-register="avatar"><strong>登记数字人</strong><input name="name" maxlength="100" placeholder="名称，例如：品牌主理人" required /><input name="canonicalImageRef" maxlength="1000" placeholder="已授权头像路径或引用" required /><input name="baseVideoRef" maxlength="1000" placeholder="已授权基础视频路径或引用" required /><input name="authorizationRef" maxlength="500" placeholder="授权记录引用" required /><label class="content-batch-check"><input name="approved" type="checkbox" /> 资产审核通过</label><label class="content-batch-check"><input name="batchAllowed" type="checkbox" /> 允许批量使用</label><button class="button button-secondary button-small" type="submit">保存数字人</button></form><form class="content-batch-mini-form" data-batch-register="voice"><strong>登记声音</strong><input name="name" maxlength="100" placeholder="名称，例如：标准女声" required /><select name="provider"><option value="">模型候选（可选）</option><option value="cosyvoice-3">CosyVoice 3（主候选）</option><option value="openvoice-v2">OpenVoice V2（备用）</option><option value="qwen3-tts">Qwen3-TTS（对比）</option><option value="gpt-sovits">GPT-SoVITS（对比）</option></select><input name="modelVersion" maxlength="200" placeholder="模型/权重版本（可选）" /><input name="licenseRef" maxlength="500" placeholder="模型许可证记录引用（可选）" /><input name="weightsHash" maxlength="200" placeholder="权重 SHA256（可选）" /><input name="voiceName" maxlength="100" placeholder="CustomVoice 名称（可选）" /><input name="referenceAudioRef" maxlength="1000" placeholder="已授权参考音频路径或引用" required /><textarea name="referenceTranscript" rows="2" maxlength="30000" placeholder="声音克隆参考音频的准确文字（克隆模式必填）"></textarea><input name="authorizationRef" maxlength="500" placeholder="授权记录引用" required /><label class="content-batch-check"><input name="approved" type="checkbox" /> 资产审核通过</label><label class="content-batch-check"><input name="batchAllowed" type="checkbox" /> 允许批量使用</label><button class="button button-secondary button-small" type="submit">保存声音</button></form><form class="content-batch-mini-form" data-batch-register="script"><strong>登记脚本集</strong><textarea name="scriptLines" rows="5" maxlength="20000" placeholder="每行一条已审核脚本" required></textarea><label class="content-batch-check"><input name="approved" type="checkbox" /> 我已审核脚本内容</label><button class="button button-secondary button-small" type="submit">保存脚本</button></form></div><form id="content-batch-plan-form" class="content-batch-plan-form"><div class="content-batch-plan-fields"><label><span>数字人版本（可多选）</span><select name="avatarVersionIds" multiple size="4" required>${catalogOptions(avatars, planInput.avatarVersionIds)}</select></label><label><span>脚本版本（可多选）</span><select name="scriptVersionIds" multiple size="4" required>${catalogOptions(scripts, planInput.scriptVersionIds)}</select></label><label><span>声音版本（可选）</span><select name="voiceVersionId"><option value="">使用数字人默认声音</option>${catalogOptions(voices, planInput.voiceVersionId ? [planInput.voiceVersionId] : [])}</select></label><label><span>模板 / 连接器</span><select name="templateVersionId" required>${catalogOptions(templates, [planInput.templateVersionId || catalog.defaults?.templateVersionId])}</select><select name="connectorId" required>${catalogOptions(connectors, [planInput.connectorId || catalog.defaults?.connectorId])}</select></label></div><label><span>批次名称</span><input name="title" maxlength="120" value="${escapeHtml(planInput.title || '')}" placeholder="例如：9 月第一轮口播测试" /></label><div class="content-batch-plan-actions"><button class="button button-secondary" type="submit" data-plan-batch="${escapeHtml(task.id)}">预览组合计划</button>${plan ? `<button class="button button-primary" type="button" data-create-batch="${escapeHtml(task.id)}">创建批次（${planCount} 条）</button>` : ''}</div></form>${plan ? `<div id="content-batch-matrix" class="content-batch-matrix"><strong>计划预览：${planCount} 条全组合</strong><span>数字人 ${plan.avatarVersionIds.length} × 脚本 ${plan.scriptVersionIds.length} · 每条拥有独立幂等键，创建后可暂停/重试。</span><small>计划还未创建，确认后才会进入批次队列。</small></div>` : ''}<div class="content-batch-list">${batchCards}</div></section>`;
  }

  function mediaNodeForm(task, node) {
    if (!['CE-14', 'CE-15'].includes(node?.id)) return '';
    const catalog = contentState.batchCatalogs[task.id] || {};
    const voices = (catalog.voices || []).filter((item) => item.status === 'approved' && item.authorizationStatus === 'approved');
    const avatars = (catalog.avatars || []).filter((item) => item.status === 'approved' && item.authorizationStatus === 'approved');
    const templates = (catalog.templates || []).filter((item) => ['approved', 'active'].includes(item.status));
    const script = task.nodes.find((item) => item.id === 'CE-11')?.output?.text || '';
    const missing = node.id === 'CE-14' ? !voices.length : !voices.length || !avatars.length || !templates.length;
    if (missing) {
      const worker = contentState.mediaWorkerHealth[task.id] || {};
      const canSkipUnconfigured = worker.reason === 'not_configured';
      return `<div class="node-blocked-hint" data-media-node-form="${escapeHtml(node.id)}">${node.id === 'CE-14' ? '请先登记一个已审核且已授权的声音版本。' : '请先登记已审核且已授权的声音、数字人和模板版本。'}${canSkipUnconfigured ? `<button class="button button-quiet button-small" type="button" data-execute-node="${escapeHtml(node.id)}">跳过（Worker 未配置，保留未配置状态）</button>` : ''}</div>`;
    }
    const selectedVoiceId = task.selectedVoiceVersionId && voices.some((voice) => voice.id === task.selectedVoiceVersionId)
      ? task.selectedVoiceVersionId
      : voices[0].id;
    const form = `<form class="content-review-form content-media-node-form" data-media-node-form="${escapeHtml(node.id)}"><div class="eyebrow">SINGLE MEDIA / ${escapeHtml(node.id)}</div><label><span>口播稿（默认使用 CE-11）</span><textarea name="scriptText" rows="4" maxlength="30000" required>${escapeHtml(script)}</textarea></label><label><span>声音版本</span><select name="voiceVersionId" required>${catalogOptions(voices, [selectedVoiceId])}</select></label>${task.selectedVoiceVersionId ? `<p class="node-blocked-hint">将使用已人工选定的声音版本；如需替换，可在下方重新试听。</p>` : ''}${node.id === 'CE-15' ? `<label><span>数字人版本</span><select name="avatarVersionId" required>${catalogOptions(avatars, [avatars[0].id])}</select></label><label><span>模板版本</span><select name="templateVersionId" required>${catalogOptions(templates, [templates[0].id])}</select></label>` : ''}<button class="button button-secondary" type="submit">执行 ${escapeHtml(node.id)} 单条生成</button></form>`;
    return form + renderVoiceComparisonPanel(task, voices);
  }

  function templateRegistrationForm() {
    return `<form class="content-batch-mini-form" data-batch-register="template"><strong>登记剪辑模板</strong><input name="name" maxlength="100" placeholder="名称，例如：品牌竖屏模板" required /><input name="backgroundRef" maxlength="1000" placeholder="背景图片/视频路径（可选）" /><input name="logoRef" maxlength="1000" placeholder="Logo 图片路径（可选）" /><input name="introRef" maxlength="1000" placeholder="片头视频路径（可选）" /><input name="outroRef" maxlength="1000" placeholder="片尾视频路径（可选）" /><input name="musicRef" maxlength="1000" placeholder="背景音乐路径（可选）" /><input name="captionFontName" maxlength="100" value="Arial" placeholder="字幕字体" /><input name="captionFontSize" type="number" min="1" max="240" value="54" placeholder="字幕字号" /><input name="coverText" maxlength="300" placeholder="封面文字（本地 Sharp 渲染）" /><label class="content-batch-check"><input name="approved" type="checkbox" /> 模板审核通过</label><label class="content-batch-check"><input name="batchAllowed" type="checkbox" /> 允许批量使用</label><button class="button button-secondary button-small" type="submit">保存模板</button></form>`;
  }

  function renderDetail() {
    const task = selectedTask();
    if (!task) {
      elements.detail.innerHTML = '<div class="content-empty-detail"><div class="content-empty-detail-icon">→</div><div><div class="eyebrow">NEXT ACTION</div><h3>先创建一条内容任务</h3><p>任务创建后，这里会显示授权素材、解析结果、结构摘要、选题、文案、分镜、审核、内容包和批量生产入口。</p><ol class="content-next-steps"><li><b>01</b><span>登记目标、平台和素材说明</span></li><li><b>02</b><span>确认授权并解析本地素材</span></li><li><b>03</b><span>按节点推进到审核与内容包</span></li></ol><button class="button button-dark button-small" type="button" data-content-create-focus>创建第一条任务</button></div></div>';
      return;
    }
    const activeNode = task.nodes.find((node) => node.id === contentState.selectedNodeId) || task.nodes.find((node) => node.status === 'ready') || task.nodes[0];
    contentState.selectedNodeId = activeNode?.id || null;
    const canStart = ['draft', 'changes_requested'].includes(task.status);
    const canRecord = task.run?.status && task.run.status !== 'not_started';
    const platforms = task.platforms.length ? task.platforms.join('、') : '未指定';
    const assets = contentState.assets[task.id] || [];
    const runtimeCapabilities = contentState.workspace?.capabilities || {};
    const worker = contentState.mediaWorkerHealth[task.id] || {};
    const workerSimulation = worker.status === 'simulation' || worker.simulation === true;
    const workerReady = worker.status === 'ready' && !workerSimulation;
    const ttsReady = workerReady && worker.capabilities?.includes('tts');
    const avatarReady = workerReady && worker.capabilities?.includes('talking_head');
    const assetSummary = assets.length
      ? assets.map((asset) => `<li><div class="content-asset-copy"><strong>${escapeHtml(asset.filename)}</strong><span>${escapeHtml(asset.kind)} · ${escapeHtml(asset.status)} · ${Math.round(Number(asset.metadata?.media?.format?.size || 0) / 1024 / 1024 * 10) / 10 || '—'} MB</span>${contentHashSummary(asset)}${contentAuthorizationSummary(asset)}${mediaOrientationSummary(asset)}${ocrEvidenceSummary(asset)}${transcriptConfidenceSummary(asset)}</div>${assetPreview(task.id, asset)}</li>`).join('')
      : '<li class="is-empty">尚未解析本地素材</li>';
    const nodeStatus = (nodeId) => task.nodes.find((node) => node.id === nodeId)?.status;
    const nodeOutput = (nodeId) => task.nodes.find((node) => node.id === nodeId)?.output || null;
    const structureOutput = nodeOutput('CE-09');
    const structureGaps = Array.isArray(structureOutput?.evidenceGaps) ? structureOutput.evidenceGaps : [];
    const structurePanel = structureOutput?.analysisMode
      ? `<section class="content-structure-summary"><div class="content-structure-heading"><div><div class="eyebrow">CE-09 / STRUCTURE</div><h3>结构分析摘要</h3></div><span class="content-structure-mode">抽取式结果 · 需人工判断</span></div><p>${escapeHtml(structureOutput.summary || '暂无可分析文本')}</p><small>开场：${escapeHtml(structureOutput.opening?.text || '未识别')} · 分段：${escapeHtml(structureOutput.rhythm?.segmentCount ?? structureOutput.segmentCount ?? 0)} · 来源：${escapeHtml((structureOutput.sourceSegments?.length || 0) + (structureOutput.sourceFrames?.length || 0))}</small>${structureGaps.length ? `<div class="content-structure-gaps"><strong>需补证据</strong><span>${escapeHtml(structureGaps.join('；'))}</span></div>` : '<div class="content-structure-ready">语音/画面来源证据已接入，可进入人工审核。</div>'}</section>`
      : '';
    const mvpStages = `<section class="content-mvp-summary"><div class="content-mvp-heading"><div><div class="eyebrow">P0 MVP PATH</div><h3>一条内容的交付状态</h3></div><small>按顺序完成，任何失败/阻塞都保留原始原因</small></div><div class="content-mvp-grid">${renderMvpStage(task, '任务创建', ['CE-01'])}${renderMvpStage(task, '授权素材导入', ['CE-04'])}${renderMvpStage(task, '素材解析', ['CE-05', 'CE-06', 'CE-07', 'CE-08'])}${renderMvpStage(task, '结构分析', ['CE-09'])}${renderMvpStage(task, '选题', ['CE-10'], task.topicSelection?.text)}${renderMvpStage(task, '文案', ['CE-11'])}${renderMvpStage(task, '制作计划', ['CE-12', 'CE-13'])}${renderMvpStage(task, '审核', ['CE-19', 'CE-20'], task.reviews?.at(-1)?.note)}${renderMvpStage(task, '内容包', ['CE-22'])}</div></section>`;
    const topicNode = task.nodes.find((node) => node.id === 'CE-10');
    const needsTopicSelection = canRecord && topicNode?.status === 'succeeded' && !task.topicSelection?.text;
    const canRecordFeedback = canRecord && nodeStatus('CE-23') === 'succeeded' && !task.feedback?.length;
    const feedbackSummary = task.feedback?.length
      ? task.feedback.map((item) => `<li><strong>${escapeHtml(item.status || 'manual')}</strong><span>${escapeHtml(item.platform || '未指定平台')} · ${escapeHtml(item.note || item.nextAction || '已记录')}</span></li>`).join('')
      : '<li class="is-empty">尚未记录内容反馈</li>';
    const autoExecutableNodes = new Set(['CE-02', 'CE-03', 'CE-04', 'CE-05', 'CE-06', 'CE-07', 'CE-08', 'CE-09', 'CE-13', 'CE-14', 'CE-15', 'CE-16', 'CE-17', 'CE-18', 'CE-19', 'CE-26']);
    const canExecuteActiveNode = canRecord && activeNode?.status === 'ready' && autoExecutableNodes.has(activeNode.id);
    const reviewNodeReady = nodeStatus('CE-19') === 'succeeded';
    const firstReview = !task.reviews?.length;
    const canSubmitReview = canRecord && reviewNodeReady && (firstReview
      ? ['ready', 'waiting_review'].includes(nodeStatus('CE-20'))
      : task.status === 'waiting_review' && nodeStatus('CE-21') === 'succeeded');
    const reviewHint = !canRecord
      ? '启动工作流后，才能提交人工审核记录。'
      : !reviewNodeReady
        ? '请先完成 CE-19 审核单，审核入口会在就绪后开放。'
        : task.status === 'changes_requested'
          ? '审核已退回，请先在上方应用修改并生成新版本，再提交复审。'
          : task.status === 'approved' || task.status === 'packaged'
            ? '最近版本已通过审核；如需修改，请创建新的内容任务。'
            : '当前审核节点尚未就绪。';
    const canPause = canRecord && !['paused', 'succeeded', 'failed', 'cancelled'].includes(task.run?.status);
    const canResume = task.run?.status === 'paused';
    const replay = contentState.replays[task.id] || null;
    const replaySummary = replay
      ? `回放 ${replay.events?.length || 0} 条事件 · ${replay.complete ? '快照完整' : '存在历史事件缺少快照'}`
      : '';
    const singleMediaForm = canRecord && ['CE-14', 'CE-15'].includes(activeNode?.id)
      ? mediaNodeForm(task, activeNode)
      : '';
    elements.detail.innerHTML = `
      <div class="content-detail-heading">
        <div><div class="eyebrow">WORK ITEM / ${escapeHtml(task.workflowVersion)}</div><h2>${escapeHtml(task.title)}</h2><p>${escapeHtml(task.objective || '尚未填写业务目标')}</p></div>
        <div class="content-detail-actions">${canStart ? '<button class="button button-primary" type="button" data-start-content="' + escapeHtml(task.id) + '">启动本地测试工作流</button>' : ''}${canPause ? '<button class="button button-quiet" type="button" data-pause-content="' + escapeHtml(task.id) + '">暂停运行</button>' : ''}${canResume ? '<button class="button button-secondary" type="button" data-resume-content="' + escapeHtml(task.id) + '">继续运行</button>' : ''}<button class="button button-quiet" type="button" data-replay-content="${escapeHtml(task.id)}">查看运行回放</button><span class="phase-label">${escapeHtml(labelForStatus(task.status))}</span></div>
      </div>
      <div class="content-detail-meta"><span>负责人：<b>${escapeHtml(task.owner?.displayName || '未指定')}</b></span><span>受众：<b>${escapeHtml(task.audience || '未指定')}</b></span><span>平台：<b>${escapeHtml(platforms)}</b></span><span>审核：<b>${escapeHtml(labelForStatus(task.reviews?.at(-1)?.decision || (task.status === 'waiting_review' ? 'pending' : 'not_started')))}</b></span><span>运行：<b>${escapeHtml(labelForStatus(task.run?.status || 'not_started'))}</b></span><span>更新时间：<b>${escapeHtml(formatTime(task.updatedAt))}</b></span></div>
      ${mvpStages}
      <section class="content-material-toolbox"><div><div class="eyebrow">REAL MATERIAL PIPELINE</div><h3>本地素材与执行节点</h3><p>路径只读取允许的本地目录；解析结果会进入 SQLite 媒体资产和知识索引。素材必须先确认授权并填写授权记录引用；ASR、OCR、渲染和发布连接器会显示真实能力状态；没有外部模型时可生成仅引用已读素材的本地模板草案。</p></div><div class="content-capability-grid">${renderCapability('素材探测', runtimeCapabilities.ffprobe && runtimeCapabilities.ffmpeg, runtimeCapabilities.ffprobe && runtimeCapabilities.ffmpeg ? 'ffprobe / ffmpeg 可用' : '媒体工具未完整配置')}${renderCapability('TTS 语音', ttsReady, ttsReady ? 'Worker 已报告 tts 能力' : workerSimulation ? 'Worker 仅返回模拟输出，不可交付' : '未配置或 Worker 未就绪，生成会阻塞')}${renderCapability('数字人', avatarReady, avatarReady ? 'Worker 已报告 talking_head 能力' : workerSimulation ? 'Worker 仅返回模拟输出，不可交付' : '未配置或 Worker 未就绪，生成会阻塞')}${renderCapability('媒体 Worker', workerReady, workerReady ? '连接成功，仍需人工验收模型输出' : workerSimulation ? '仅模拟输出，不可作为真实成片' : worker.reason || '未配置或无法连接')}</div><form id="content-material-form" class="content-material-form"><input name="path" type="text" maxlength="1000" value="${escapeHtml(task.sourceAssets?.[0] || '')}" placeholder="/Users/你的用户名/Downloads/素材.mp4" required /><input name="sourceRef" type="text" maxlength="1000" placeholder="素材来源（URL、文件说明或采集记录）" required /><select name="authorizationStatus" aria-label="素材授权状态" required><option value="">请选择授权状态</option><option value="approved">已确认授权</option></select><input name="authorizationRef" type="text" maxlength="500" placeholder="授权记录引用" required /><button class="button button-secondary" type="submit">确认授权并解析</button></form><ul class="content-asset-list">${assetSummary}</ul><div class="content-runtime-actions">${nodeStatus('CE-09') === 'ready' ? '<button class="button button-quiet" type="button" data-analyze-content="' + escapeHtml(task.id) + '">分析内容结构</button>' : ''}${nodeStatus('CE-10') === 'ready' ? '<button class="button button-quiet" type="button" data-generate-content="topic">生成选题</button>' : ''}${nodeStatus('CE-11') === 'ready' ? '<button class="button button-quiet" type="button" data-generate-content="copy">生成脚本</button>' : ''}${nodeStatus('CE-12') === 'ready' ? '<button class="button button-quiet" type="button" data-generate-content="platform">生成平台版本</button>' : ''}${nodeStatus('CE-13') === 'ready' ? '<button class="button button-quiet" type="button" data-generate-content="shotlist">生成分镜</button>' : ''}${nodeStatus('CE-16') === 'ready' ? '<button class="button button-quiet" type="button" data-render-content="' + escapeHtml(task.id) + '">本地渲染</button>' : ''}${nodeStatus('CE-22') === 'ready' ? '<button class="button button-quiet" type="button" data-package-content="' + escapeHtml(task.id) + '">导出内容包</button>' : ''}${nodeStatus('CE-23') === 'ready' ? '<button class="button button-dark" type="button" data-create-release-draft="' + escapeHtml(task.id) + '">创建发布草稿</button>' : ''}${nodeStatus('CE-26') === 'ready' ? '<button class="button button-quiet" type="button" data-generate-content="retro">生成复盘建议</button>' : ''}</div></section>
      ${structurePanel}
      ${renderBatchPanel(task)}
      <section class="content-feedback-box"><div><div class="eyebrow">FEEDBACK LOOP</div><h3>反馈与下一步</h3></div><ul class="content-asset-list">${feedbackSummary}</ul></section>
      <div class="content-detail-layout">
        <section class="content-node-panel"><div class="panel-heading"><div><div class="eyebrow">26 NODE TRACE</div><h3>工作流节点</h3></div><span class="count-label">${task.nodes.filter((node) => ['succeeded', 'skipped'].includes(node.status)).length}/${task.nodes.length}</span></div><div class="content-node-list">${task.nodes.map(renderNode).join('')}</div></section>
        <section class="content-node-inspector">
          <div class="eyebrow">NODE INSPECTOR</div><h3>${escapeHtml(activeNode?.label || '未选择节点')}</h3><p class="node-key">${escapeHtml(activeNode?.id || '')} · ${escapeHtml(activeNode?.key || '')}</p>
          <div class="node-inspector-summary"><span>状态<strong>${escapeHtml(labelForStatus(activeNode?.status))}</strong></span><span>人工闸门<strong>${activeNode?.humanGate ? '是' : '否'}</strong></span><span>证据<strong>${activeNode?.evidence?.length || 0} 条</strong></span></div>
          <div class="node-output-box"><span>最近输出</span><pre>${escapeHtml(activeNode?.output ? JSON.stringify(activeNode.output, null, 2) : '尚未记录输出')}</pre></div>
          ${needsTopicSelection ? '<form id="content-topic-selection-form" class="content-review-form"><div class="eyebrow">HUMAN TOPIC GATE</div><label><span>最终选题</span><textarea name="selection" rows="4" maxlength="2000" placeholder="从上面的候选选题中选择一个，或改写成最终选题。" required></textarea></label><label><span>选择说明（可选）</span><input name="note" type="text" maxlength="500" placeholder="例如：符合本次业务目标且有素材依据" /></label><button class="button button-dark" type="submit">确认最终选题</button></form>' : ''}
          ${singleMediaForm || (canExecuteActiveNode ? '<button class="button button-secondary node-execute-button" type="button" data-execute-node="' + escapeHtml(activeNode.id) + '">执行当前节点</button>' : '')}
          ${['failed', 'blocked'].includes(activeNode?.status) ? '<button class="button button-quiet node-execute-button" type="button" data-retry-content="' + escapeHtml(task.id) + '" data-retry-node="' + escapeHtml(activeNode.id) + '">重试当前节点</button>' : ''}
          ${canRecord ? `<form id="content-node-record-form" class="content-node-record-form"><div class="eyebrow">LOCAL TEST RECORD</div><label><span>节点结果</span><select name="status"><option value="succeeded">已完成</option><option value="blocked">已阻塞</option><option value="failed">执行失败</option><option value="skipped">已跳过</option></select></label><label><span>测试输出</span><textarea name="output" rows="4" placeholder="仅记录真实测试结果；不要把未执行的 AI 结果写成成功。" required></textarea></label><label><span>备注</span><input name="note" type="text" maxlength="500" placeholder="例如：使用本地测试素材完成解析" /></label><button class="button button-secondary" type="submit" data-record-node="${escapeHtml(activeNode?.id || '')}">登记节点结果</button></form>` : '<div class="node-blocked-hint">工作流尚未启动。启动后才能登记本地测试节点结果。</div>'}
          ${canSubmitReview ? '<form id="content-review-form" class="content-review-form"><div class="eyebrow">HUMAN REVIEW GATE</div><label><span>审核决定</span><select name="decision"><option value="changes_requested">退回修改</option><option value="approved">审核通过</option><option value="rejected">拒绝</option></select></label><label><span>审核意见</span><textarea name="note" rows="3" maxlength="2000" placeholder="记录事实、品牌、版权、平台和内容质量判断。" required></textarea></label><button class="button button-dark" type="submit">保存审核记录</button></form>' : `<div class="node-blocked-hint">${escapeHtml(reviewHint)}</div>`}
          ${canRecord && task.status === 'changes_requested' && nodeStatus('CE-21') === 'ready' ? '<form id="content-revision-form" class="content-review-form"><div class="eyebrow">VERSION REVISION</div><label><span>修改说明</span><textarea name="changes" rows="3" maxlength="5000" placeholder="填写审核意见对应的实际修改，例如补充来源、删除未经证实的承诺。" required></textarea></label><label><span>新版本内容（可选）</span><textarea name="content" rows="5" maxlength="30000" placeholder="粘贴修改后的脚本/文案；旧版本不会被覆盖。"></textarea></label><button class="button button-secondary" type="submit">应用修改并生成新版本</button></form>' : ''}
          ${canRecordFeedback ? `<form id="content-feedback-form" class="content-review-form"><div class="eyebrow">LOCAL FEEDBACK RECORD</div><p class="node-blocked-hint">只记录人工提供的发布状态、指标或下一步；本地/测试闭环不会调用外部平台。</p><label><span>反馈状态</span><select name="status"><option value="manual">人工记录</option><option value="not_published">未发布</option><option value="observed">已观察</option><option value="failed">执行失败</option></select></label><label><span>平台</span><input name="platform" type="text" maxlength="80" value="${escapeHtml(task.platforms[0] || '')}" placeholder="例如：小红书" /></label><label><span>指标 JSON（可选）</span><textarea name="metrics" rows="2" placeholder='例如：{"views":1000,"likes":20}'></textarea></label><label><span>反馈说明</span><textarea name="note" rows="3" maxlength="5000" placeholder="记录真实观察或人工反馈；没有数据就明确写待观察。"></textarea></label><label><span>下一步</span><textarea name="nextAction" rows="2" maxlength="2000" placeholder="例如：下一轮只改开场，继续使用同一素材"></textarea></label><button class="button button-secondary" type="submit">保存反馈与下一步</button></form>` : ''}
        </section>
      </div>
      ${replay ? `<details class="content-source-details" open><summary>运行回放：${escapeHtml(replaySummary)}</summary><pre>${escapeHtml(JSON.stringify(replay, null, 2))}</pre></details>` : ''}
      <details class="content-source-details"><summary>查看素材说明与版本证据</summary><p>${escapeHtml(task.sourceBrief || '尚未填写素材说明')}</p><pre>${escapeHtml(JSON.stringify({ run: task.run, topicSelection: task.topicSelection, reviews: task.reviews, versions: task.versions, feedback: task.feedback }, null, 2))}</pre></details>
    `;
    const batchPlanForm = elements.detail.querySelector('#content-batch-plan-form');
    const batchRegistration = elements.detail.querySelector('.content-batch-registration');
    if (batchRegistration && !batchRegistration.querySelector('[data-batch-register="template"]')) {
      batchRegistration.insertAdjacentHTML('beforeend', templateRegistrationForm());
    }
    if (batchPlanForm) {
      const batchPlanInput = contentState.batchPlanInputs[task.id] || {};
      const estimate = batchPlanInput.budgetEstimate || {};
      batchPlanForm.insertAdjacentHTML('beforeend', `<div class="content-batch-budget"><label><span>预算估算金额（超过 6 条必填）</span><input name="budgetEstimateAmount" type="number" min="0" step="0.01" value="${escapeHtml(estimate.amount ?? '')}" placeholder="例如 120" /></label><label><span>币种</span><input name="budgetCurrency" maxlength="10" value="${escapeHtml(estimate.currency || 'CNY')}" /></label><label><span>估算依据</span><input name="budgetBasis" maxlength="300" value="${escapeHtml(estimate.basis || '')}" placeholder="模型/本地基线/供应商报价" /></label><label class="content-batch-check"><input name="budgetConfirmed" type="checkbox"${batchPlanInput.budgetConfirmed ? ' checked' : ''} /> 我确认已完成预算估算并允许负责人审核大批次</label></div>`);
    }
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
        const generationStatus = ai.localDraftOnly
          ? '本地模板锁定（不调用外部模型）'
          : ai.configured
            ? 'DeepSeek 已配置'
            : ai.localDraftGenerator
              ? '本地模板可用（需人工审核）'
              : 'AI 生成未配置';
        elements.runtimeStrip.textContent = `SQLite 工作区 · ${capabilities.ffprobe && capabilities.ffmpeg ? '媒体探测/关键帧/渲染可用' : '媒体工具不完整'} · ${capabilities.subtitleBurnIn ? '字幕烧录可用' : '字幕烧录不可用'} · ${capabilities.transcription ? 'ASR 已配置' : 'ASR 未配置'} · ${capabilities.ocr ? 'OCR 已配置' : 'OCR 未配置'} · ${generationStatus}`;
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
        const query = '?projectId=' + encodeURIComponent(detailPayload.task.projectId) + '&taskId=' + encodeURIComponent(detailPayload.task.id);
        try {
          const [catalogPayload, batchesPayload, workerPayload, testSetPayload] = await Promise.all([
            api('/api/content/batches/catalog' + query),
            api('/api/content/batches' + query),
            api('/api/content/media-worker/health'),
            api('/api/content/voice-comparison-test-set'),
          ]);
          contentState.batchCatalogs[contentState.selectedTaskId] = catalogPayload.catalog || {};
          contentState.batches[contentState.selectedTaskId] = batchesPayload.batches || [];
          contentState.mediaWorkerHealth[contentState.selectedTaskId] = workerPayload.worker || null;
          contentState.voiceComparisonTestSet = testSetPayload.testSet || null;
        } catch {
          contentState.batchCatalogs[contentState.selectedTaskId] = {};
          contentState.batches[contentState.selectedTaskId] = [];
          contentState.mediaWorkerHealth[contentState.selectedTaskId] = null;
          contentState.voiceComparisonTestSet = null;
        }
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
              sourceWorkFingerprint: elements.form.dataset.sourceWorkFingerprint || data.get('sourceWorkFingerprint') || null,
              sourceBrief: data.get('sourceBrief'),
          sourceAssets: String(data.get('sourceAssetPath') || '').trim() ? [String(data.get('sourceAssetPath')).trim()] : [],
        }),
      });
      contentState.selectedTaskId = payload.task.id;
      elements.form.reset();
      delete elements.form.dataset.sourceWorkFingerprint;
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
    const form = event.target;
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
    const data = new FormData(event.target);
    const path = String(data.get('path') || '').trim();
    try {
      await api('/api/content/tasks/' + encodeURIComponent(task.id) + '/materials/parse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path,
          sourceRef: String(data.get('sourceRef') || '').trim(),
          authorizationStatus: String(data.get('authorizationStatus') || '').trim(),
          authorizationRef: String(data.get('authorizationRef') || '').trim(),
        }),
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

  async function executeMediaNode(event) {
    event.preventDefault();
    const task = selectedTask();
    if (!task) return;
    const data = new FormData(event.target);
    const body = { nodeId: event.target.dataset.mediaNodeForm };
    for (const key of ['scriptText', 'voiceVersionId', 'avatarVersionId', 'templateVersionId']) {
      const value = String(data.get(key) || '').trim();
      if (value) body[key] = value;
    }
    await runContentAction('/execute-node', body, '单条媒体生成失败');
  }

  async function executeVoiceComparison(event) {
    event.preventDefault();
    const task = selectedTask();
    if (!task) return;
    const data = new FormData(event.target);
    const voiceVersionIds = data.getAll('voiceVersionIds').map((value) => String(value).trim()).filter(Boolean);
    if (voiceVersionIds.length !== 2) {
      window.alert('请选择两个不同的声音版本');
      return;
    }
    await runContentAction('/voice-comparisons', {
      voiceVersionIds,
      scriptText: String(data.get('scriptText') || '').trim(),
    }, '声音 A/B 试听失败');
  }

  async function selectVoiceComparison(comparisonId, voiceVersionId, role = 'default') {
    const task = selectedTask();
    if (!task) return;
    try {
      await api('/api/content/tasks/' + encodeURIComponent(task.id) + '/voice-comparisons/' + encodeURIComponent(comparisonId) + '/select', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voiceVersionId, role }),
      });
      await loadTasks({ selectFirst: false });
    } catch (error) {
      window.alert(error.message || '声音选择失败');
    }
  }

  async function reviewVoiceComparison(event) {
    event.preventDefault();
    const task = selectedTask();
    if (!task) return;
    const data = new FormData(event.target);
    try {
      await api('/api/content/tasks/' + encodeURIComponent(task.id) + '/voice-comparisons/' + encodeURIComponent(event.target.dataset.voiceReviewComparison) + '/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          voiceVersionId: event.target.dataset.voiceReviewVoice,
          testCaseId: data.get('testCaseId') || null,
          accuracy: data.get('accuracy'),
          naturalness: data.get('naturalness'),
          speed: data.get('speed'),
          vramGiB: data.get('vramGiB'),
          elapsedMs: data.get('elapsedMs'),
          notes: data.get('notes'),
        }),
      });
      await loadTasks({ selectFirst: false });
    } catch (error) {
      window.alert(error.message || '声音质量评估保存失败');
    }
  }

  async function selectTopic(event) {
    event.preventDefault();
    const task = selectedTask();
    if (!task) return;
    const data = new FormData(event.target);
    try {
      await api('/api/content/tasks/' + encodeURIComponent(task.id) + '/topic-selection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selection: data.get('selection'), note: data.get('note') }),
      });
      await loadTasks({ selectFirst: false });
    } catch (error) {
      window.alert(error.message || '选题确认失败');
    }
  }

  async function recordFeedback(event) {
    event.preventDefault();
    const task = selectedTask();
    if (!task) return;
    const data = new FormData(event.target);
    let metrics = {};
    const metricsText = String(data.get('metrics') || '').trim();
    if (metricsText) {
      try {
        metrics = JSON.parse(metricsText);
      } catch {
        window.alert('指标必须是合法 JSON');
        return;
      }
    }
    try {
      await api('/api/content/tasks/' + encodeURIComponent(task.id) + '/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: data.get('status'),
          platform: data.get('platform'),
          metrics,
          note: data.get('note'),
          nextAction: data.get('nextAction'),
          source: 'manual',
        }),
      });
      await loadTasks({ selectFirst: false });
    } catch (error) {
      window.alert(error.message || '反馈保存失败');
    }
  }

  async function reviewTask(event) {
    event.preventDefault();
    const task = selectedTask();
    if (!task) {
      return;
    }
    const data = new FormData(event.target);
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
    const data = new FormData(event.target);
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

  async function registerBatchAsset(event) {
    event.preventDefault();
    const task = selectedTask();
    const form = event.target;
    if (!task) return;
    const kind = form.dataset.batchRegister;
    const data = new FormData(form);
    const approved = data.get('approved') === 'on';
    const body = {
      projectId: task.projectId,
      name: data.get('name'),
      approved,
      batchAllowed: ['avatar', 'voice'].includes(kind)
        ? data.get('batchAllowed') === 'on'
        : kind === 'template'
          ? data.get('batchAllowed') === 'on'
          : false,
      authorizationStatus: approved ? 'approved' : 'pending',
      authorizationRef: data.get('authorizationRef'),
    };
    if (kind === 'avatar') {
      body.canonicalImageRef = data.get('canonicalImageRef');
      body.baseVideoRef = data.get('baseVideoRef');
    } else if (kind === 'voice') {
      body.provider = data.get('provider');
      body.modelVersion = data.get('modelVersion');
      body.licenseRef = data.get('licenseRef');
      body.weightsHash = data.get('weightsHash');
      body.referenceAudioRef = data.get('referenceAudioRef');
      body.referenceTranscript = data.get('referenceTranscript');
      body.voiceName = data.get('voiceName');
    } else if (kind === 'script') {
      body.taskId = task.id;
      body.approved = approved;
      body.versions = String(data.get('scriptLines') || '').split(/\r?\n/).map((text, index) => ({ id: `script_${Date.now()}_${index}`, title: `脚本 ${index + 1}`, text: text.trim() })).filter((item) => item.text);
      if (!body.versions.length) {
        window.alert('至少填写一条脚本');
        return;
      }
      delete body.batchAllowed;
      delete body.authorizationStatus;
      delete body.authorizationRef;
    } else if (kind === 'template') {
      for (const key of ['backgroundRef', 'logoRef', 'introRef', 'outroRef', 'musicRef', 'captionFontName', 'captionFontSize', 'coverText']) {
        const value = String(data.get(key) || '').trim();
        if (value) body[key] = key === 'captionFontSize' ? Number(value) : value;
      }
      delete body.authorizationStatus;
      delete body.authorizationRef;
    }
    try {
      const endpoint = kind === 'avatar'
        ? '/api/content/avatar-profiles'
        : kind === 'voice'
          ? '/api/content/voice-profiles'
          : kind === 'script'
            ? '/api/content/script-sets'
            : '/api/content/template-versions';
      await api(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      await loadTasks({ selectFirst: false });
    } catch (error) {
      window.alert(error.message || '资产登记失败');
    }
  }

  async function planBatch(event) {
    event.preventDefault();
    const task = selectedTask();
    if (!task) return;
    const data = new FormData(event.target);
    const budgetAmount = String(data.get('budgetEstimateAmount') || '').trim();
    const input = {
      projectId: task.projectId,
      taskId: task.id,
      avatarVersionIds: data.getAll('avatarVersionIds'),
      scriptVersionIds: data.getAll('scriptVersionIds'),
      voiceVersionId: data.get('voiceVersionId') || null,
      templateVersionId: data.get('templateVersionId'),
      connectorId: data.get('connectorId'),
      title: data.get('title') || '数字人批次',
      budgetConfirmed: data.get('budgetConfirmed') === 'on',
      budgetEstimate: budgetAmount
        ? {
            amount: Number(budgetAmount),
            currency: data.get('budgetCurrency') || 'CNY',
            basis: data.get('budgetBasis') || '',
          }
        : null,
    };
    if (!input.avatarVersionIds.length || !input.scriptVersionIds.length) {
      window.alert('至少选择一个数字人版本和一个脚本版本');
      return;
    }
    try {
      const payload = await api('/api/content/batches/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      contentState.batchPlans[task.id] = payload.plan;
      contentState.batchPlanInputs[task.id] = input;
      renderDetail();
    } catch (error) {
      window.alert(error.message || '批次计划生成失败');
    }
  }

  async function createBatch(taskId) {
    const task = contentState.details[taskId];
    const input = contentState.batchPlanInputs[taskId];
    if (!task || !input) return;
    try {
      await api('/api/content/batches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      contentState.batchPlans[taskId] = null;
      contentState.batchPlanInputs[taskId] = null;
      await loadTasks({ selectFirst: false });
    } catch (error) {
      window.alert(error.message || '批次创建失败');
    }
  }

  async function batchCommand(path, body, errorMessage) {
    try {
      const payload = await api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      if (payload.export?.package?.path) window.alert('已生成审核通过条目交付包：\n' + payload.export.package.path + '\n\n清单：' + payload.export.manifest);
      else if (payload.export?.manifest) window.alert('已导出审核通过条目清单：\n' + payload.export.manifest);
      await loadTasks({ selectFirst: false });
    } catch (error) {
      window.alert(error.message || errorMessage);
    }
  }

  async function reviewBatchItem(batchId, itemId, decision) {
    const note = decision === 'approved' ? '本地模拟成片审核通过' : '请根据审核意见修改后重新提交';
    await batchCommand('/api/content/batches/' + encodeURIComponent(batchId) + '/items/' + encodeURIComponent(itemId) + '/review', { decision, note }, '批次审核失败');
  }

  async function recordBatchAudit(event) {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const ratio = String(data.get('sampleRatio') || '').trim();
    const minutes = String(data.get('reviewMinutes') || '').trim();
    const sampling = {
      itemIds: String(data.get('sampleItemIds') || '').split(/[\s,，]+/).map((item) => item.trim()).filter(Boolean),
      expanded: data.get('expandedReview') === 'on',
      expandedReason: data.get('expandedReason') || '',
    };
    if (ratio) sampling.ratio = Number(ratio);
    const humanReview = {};
    if (minutes) humanReview.durationMs = Number(minutes) * 60 * 1000;
    humanReview.notes = data.get('reviewNotes') || '';
    const body = {
      sampling,
      humanReview,
      ownerDecision: data.get('ownerDecision') || 'pending',
    };
    const batchId = form.dataset.batchAudit;
    await batchCommand('/api/content/batches/' + encodeURIComponent(batchId) + '/audit', body, '批次审计记录失败');
  }

  elements.form.addEventListener('submit', createTask);
  root.addEventListener('click', (event) => {
    const createFocusButton = event.target.closest('[data-content-create-focus]');
    if (createFocusButton) {
      elements.form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      elements.form.querySelector('[name="title"]')?.focus();
      return;
    }
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
    const createBatchButton = event.target.closest('[data-create-batch]');
    if (createBatchButton) {
      createBatch(createBatchButton.dataset.createBatch);
      return;
    }
    const startBatchButton = event.target.closest('[data-start-batch]');
    if (startBatchButton) {
      batchCommand('/api/content/batches/' + encodeURIComponent(startBatchButton.dataset.startBatch) + '/start', {}, '批次启动失败');
      return;
    }
    const pauseBatchButton = event.target.closest('[data-pause-batch]');
    if (pauseBatchButton) {
      batchCommand('/api/content/batches/' + encodeURIComponent(pauseBatchButton.dataset.pauseBatch) + '/pause', {}, '批次暂停失败');
      return;
    }
    const resumeBatchButton = event.target.closest('[data-resume-batch]');
    if (resumeBatchButton) {
      batchCommand('/api/content/batches/' + encodeURIComponent(resumeBatchButton.dataset.resumeBatch) + '/resume', {}, '批次继续失败');
      return;
    }
    const cancelBatchButton = event.target.closest('[data-cancel-batch]');
    if (cancelBatchButton) {
      if (window.confirm('取消该批次的未完成条目？已完成和已审核结果会保留。')) {
        batchCommand('/api/content/batches/' + encodeURIComponent(cancelBatchButton.dataset.cancelBatch) + '/cancel', {}, '批次取消失败');
      }
      return;
    }
    const retryBatchButton = event.target.closest('[data-retry-batch]');
    if (retryBatchButton) {
      batchCommand('/api/content/batches/' + encodeURIComponent(retryBatchButton.dataset.retryBatch) + '/items/' + encodeURIComponent(retryBatchButton.dataset.retryItem) + '/retry', {}, '批次条目重试失败');
      return;
    }
    const postprocessBatchButton = event.target.closest('[data-postprocess-batch]');
    if (postprocessBatchButton) {
      batchCommand('/api/content/batches/' + encodeURIComponent(postprocessBatchButton.dataset.postprocessBatch) + '/items/' + encodeURIComponent(postprocessBatchButton.dataset.postprocessItem) + '/postprocess', {}, '批次模板后处理失败');
      return;
    }
    const reviewBatchButton = event.target.closest('[data-review-batch]');
    if (reviewBatchButton) {
      reviewBatchItem(reviewBatchButton.dataset.reviewBatch, reviewBatchButton.dataset.reviewItem, reviewBatchButton.dataset.reviewDecision);
      return;
    }
    const exportBatchButton = event.target.closest('[data-export-batch]');
    if (exportBatchButton) {
      batchCommand('/api/content/batches/' + encodeURIComponent(exportBatchButton.dataset.exportBatch) + '/export', {}, '批次导出失败');
      return;
    }
    const executeButton = event.target.closest('[data-execute-node]');
    if (executeButton) {
      const task = selectedTask();
      runContentAction('/execute-node', { nodeId: executeButton.dataset.executeNode, path: task?.sourceAssets?.[0] || '' }, '节点执行失败');
      return;
    }
    const applyVoiceTestButton = event.target.closest('[data-apply-voice-test]');
    if (applyVoiceTestButton) {
      const form = root.querySelector(`[data-voice-comparison-form="${applyVoiceTestButton.dataset.voiceTestTask}"]`);
      const testCase = (contentState.voiceComparisonTestSet?.cases || []).find((item) => item.id === applyVoiceTestButton.dataset.applyVoiceTest);
      if (form && testCase) form.elements.scriptText.value = testCase.text || '';
      return;
    }
    const selectVoiceButton = event.target.closest('[data-select-voice-comparison]');
    if (selectVoiceButton) {
      selectVoiceComparison(selectVoiceButton.dataset.selectVoiceComparison, selectVoiceButton.dataset.selectVoiceVersion, selectVoiceButton.dataset.selectVoiceRole);
      return;
    }
    const retryVoiceButton = event.target.closest('[data-retry-voice-comparison]');
    if (retryVoiceButton) {
      const task = selectedTask();
      const comparison = task?.voiceComparisons?.find((item) => item.id === retryVoiceButton.dataset.retryVoiceComparison);
      if (comparison) {
        runContentAction('/voice-comparisons', {
          voiceVersionIds: comparison.voiceVersionIds,
          scriptText: comparison.scriptText,
          language: comparison.language,
        }, '声音 A/B 失败候选重试失败');
      }
    }
  });
  root.addEventListener('submit', (event) => {
    if (event.target.matches('[data-media-node-form]')) {
      executeMediaNode(event);
    }
    if (event.target.matches('[data-voice-comparison-form]')) {
      executeVoiceComparison(event);
    }
    if (event.target.matches('[data-voice-review-form]')) {
      reviewVoiceComparison(event);
    }
    if (event.target.matches('[data-batch-register]')) {
      registerBatchAsset(event);
    }
    if (event.target.matches('#content-batch-plan-form')) {
      planBatch(event);
    }
    if (event.target.matches('[data-batch-audit]')) {
      recordBatchAudit(event);
    }
    if (event.target.matches('#content-material-form')) {
      parseMaterial(event);
    }
    if (event.target.matches('#content-node-record-form')) {
      recordNode(event);
    }
    if (event.target.matches('#content-topic-selection-form')) {
      selectTopic(event);
    }
    if (event.target.matches('#content-review-form')) {
      reviewTask(event);
    }
    if (event.target.matches('#content-revision-form')) {
      applyRevision(event);
    }
    if (event.target.matches('#content-feedback-form')) {
      recordFeedback(event);
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
