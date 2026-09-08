const TERMINAL_STATUSES = new Set(['succeeded', 'approved', 'failed', 'blocked', 'cancelled']);
const REVIEW_STATUSES = new Set(['approved', 'changes_requested']);
const SCRIPT_BUCKETS = ['short', 'mid', 'long'];

function number(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))];
}

function durationValues(runs, field, fallbackField = null) {
  return runs
    .map((run) => {
      const direct = number(run?.[field]);
      if (direct !== null && direct >= 0) return direct;
      if (!fallbackField) return null;
      const started = Date.parse(run?.startedAt || '');
      const fallback = Date.parse(run?.[fallbackField] || '');
      return Number.isFinite(started) && Number.isFinite(fallback) && started >= fallback ? started - fallback : null;
    })
    .filter((value) => value !== null && value >= 0)
    .sort((left, right) => left - right);
}

function stageMetrics(values) {
  return {
    count: values.length,
    durationP50Ms: percentile(values, 0.5),
    durationP95Ms: percentile(values, 0.95),
  };
}

function scriptBucket(item) {
  const estimated = number(item?.input?.script?.estimatedDurationSeconds);
  if (estimated !== null) {
    if (estimated <= 30) return 'short';
    if (estimated <= 60) return 'mid';
    return 'long';
  }
  const length = String(item?.input?.script?.text || '').length;
  if (length <= 120) return 'short';
  if (length <= 360) return 'mid';
  return 'long';
}

function latestByItem(records) {
  const latest = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const previous = latest.get(record?.itemId);
    const previousTime = Date.parse(previous?.createdAt || '');
    const currentTime = Date.parse(record?.createdAt || '');
    if (!previous || !Number.isFinite(currentTime) || !Number.isFinite(previousTime) || currentTime >= previousTime) {
      latest.set(record?.itemId, record);
    }
  }
  return latest;
}

function costFor(value) {
  const source = value?.cost && typeof value.cost === 'object' ? value.cost : value;
  const amount = number(source?.amount);
  const currency = typeof source?.currency === 'string' ? source.currency.trim() : '';
  return amount !== null && amount >= 0 && currency ? { amount, currency } : null;
}

function mediaCheckFor(item, report) {
  const checks = Array.isArray(report?.checks?.mediaChecks) ? report.checks.mediaChecks : [];
  const direct = report?.checks?.mediaCheckPassed === true;
  const simulated = item?.output?.simulated === true || report?.simulation === true || checks.some((check) => check?.status === 'skipped_simulation');
  const technicalChecksPassed = direct || (checks.length > 0 && checks.every((check) => check?.status === 'succeeded'));
  return {
    checked: simulated || technicalChecksPassed,
    passed: !simulated && technicalChecksPassed,
    simulated,
    disposition: simulated ? 'simulation_only' : technicalChecksPassed ? 'passed' : 'pending',
  };
}

export function buildContentBatchAudit(batch = {}, modelRuns = [], qualityReports = []) {
  const items = Array.isArray(batch.items) ? batch.items : [];
  const itemIds = items.map((item) => item?.id).filter(Boolean);
  const itemIdSet = new Set(itemIds);
  const idempotencyKeys = items.map((item) => item?.idempotencyKey).filter(Boolean);
  const duplicates = (values) => [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort();
  const duplicateItemIds = duplicates(itemIds);
  const duplicateIdempotencyKeys = duplicates(idempotencyKeys);
  const expectedCount = number(batch.planCount, null) ?? (Array.isArray(batch.avatarVersionIds) && Array.isArray(batch.scriptVersionIds)
    ? batch.avatarVersionIds.length * batch.scriptVersionIds.length
    : items.length);
  const expectedCombinations = new Set(
    Array.isArray(batch.avatarVersionIds) && Array.isArray(batch.scriptVersionIds)
      ? batch.avatarVersionIds.flatMap((avatarVersionId) => batch.scriptVersionIds.map((scriptVersionId) => `${avatarVersionId}|${scriptVersionId}`))
      : [],
  );
  const actualCombinations = items.map((item) => `${item?.avatarVersionId || ''}|${item?.scriptVersionId || ''}`);
  const duplicateCombinations = duplicates(actualCombinations);
  const missingCombinations = [...expectedCombinations].filter((key) => !actualCombinations.includes(key));
  const unexpectedCombinations = [...new Set(actualCombinations)].filter((key) => expectedCombinations.size && !expectedCombinations.has(key));
  const plan = {
    expectedCount,
    actualCount: items.length,
    duplicateItemIds,
    duplicateIdempotencyKeys,
    duplicateCombinations,
    missingCombinations,
    unexpectedCombinations,
    complete: items.length === expectedCount && !duplicateItemIds.length && !duplicateIdempotencyKeys.length && !duplicateCombinations.length && !missingCombinations.length && !unexpectedCombinations.length,
  };

  const terminalItemIds = items.filter((item) => TERMINAL_STATUSES.has(item?.status)).map((item) => item.id);
  const nonTerminalItemIds = items.filter((item) => !TERMINAL_STATUSES.has(item?.status)).map((item) => item.id);
  const statusCounts = {};
  for (const item of items) statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
  const terminal = {
    statusCounts,
    terminalCount: terminalItemIds.length,
    nonTerminalItemIds,
    allExplainable: items.length === expectedCount && nonTerminalItemIds.length === 0,
  };

  const runs = Array.isArray(modelRuns) ? modelRuns : [];
  const reports = Array.isArray(qualityReports) ? qualityReports : [];
  const latestRuns = latestByItem(runs);
  const runItemIds = new Set(runs.map((run) => run?.itemId).filter(Boolean));
  const reportItemIds = new Set(reports.map((report) => report?.itemId).filter(Boolean));
  const orphanRunItemIds = [...runItemIds].filter((id) => !itemIdSet.has(id)).sort();
  const orphanReportItemIds = [...reportItemIds].filter((id) => !itemIdSet.has(id)).sort();
  const expectedEvidenceItems = items.filter((item) => ['succeeded', 'approved', 'failed', 'blocked'].includes(item?.status));
  const missingRunItemIds = expectedEvidenceItems.filter((item) => !runItemIds.has(item.id)).map((item) => item.id);
  const missingReportItemIds = expectedEvidenceItems.filter((item) => !reportItemIds.has(item.id)).map((item) => item.id);
  const runComplete = !orphanRunItemIds.length && !missingRunItemIds.length;
  const reportComplete = !orphanReportItemIds.length && !missingReportItemIds.length;

  const runsByItem = new Map();
  for (const run of runs) {
    if (!runsByItem.has(run?.itemId)) runsByItem.set(run.itemId, []);
    runsByItem.get(run.itemId).push(run);
  }
  const retriesByItem = {};
  for (const [itemId, itemRuns] of runsByItem) {
    if (itemRuns.length > 1) retriesByItem[itemId] = itemRuns.length - 1;
  }
  const retries = {
    total: Object.values(retriesByItem).reduce((total, count) => total + count, 0),
    byItem: retriesByItem,
  };

  const latestReports = latestByItem(reports);
  const mediaByItem = items.map((item) => ({ item, ...mediaCheckFor(item, latestReports.get(item.id)) }));
  const checkedMedia = mediaByItem.filter((entry) => entry.checked);
  const passedMedia = mediaByItem.filter((entry) => entry.passed);
  const media = {
    checkedCount: checkedMedia.length,
    totalCount: items.length,
    pendingItemIds: mediaByItem.filter((entry) => !entry.checked).map((entry) => entry.item.id),
    passedCount: passedMedia.length,
    simulatedCount: mediaByItem.filter((entry) => entry.simulated).length,
    simulationOnlyItemIds: mediaByItem.filter((entry) => entry.simulated).map((entry) => entry.item.id),
    allAutoChecked: items.length === expectedCount && checkedMedia.length === items.length,
    allAutoPassed: items.length === expectedCount && items.length > 0 && passedMedia.length === items.length,
  };

  const modelEvidenceByItem = items.map((item) => {
    const run = latestRuns.get(item.id);
    const output = item.output || run?.output || {};
    const simulated = output?.simulated === true || run?.simulation === true;
    return {
      item,
      run,
      simulated,
      modelVersion: typeof output?.modelVersion === 'string' ? output.modelVersion.trim() : '',
      requestId: typeof output?.requestId === 'string' ? output.requestId.trim() : '',
    };
  });
  const simulationOnlyItemIds = modelEvidenceByItem.filter((entry) => entry.simulated).map((entry) => entry.item.id);
  const missingModelVersionItemIds = modelEvidenceByItem.filter((entry) => !entry.modelVersion).map((entry) => entry.item.id);
  const missingRequestIdItemIds = modelEvidenceByItem.filter((entry) => !entry.requestId).map((entry) => entry.item.id);
  const realModelCount = modelEvidenceByItem.filter((entry) => !entry.simulated && entry.modelVersion && entry.requestId).length;
  const model = {
    totalCount: items.length,
    realModelCount,
    simulatedCount: simulationOnlyItemIds.length,
    simulationOnlyItemIds,
    missingModelVersionItemIds,
    missingRequestIdItemIds,
    status: !items.length
      ? 'not_run'
      : simulationOnlyItemIds.length === items.length
        ? 'simulation_only'
        : simulationOnlyItemIds.length
          ? 'mixed'
          : missingModelVersionItemIds.length || missingRequestIdItemIds.length
            ? 'evidence_incomplete'
            : 'ready',
    productionReady: items.length > 0
      && simulationOnlyItemIds.length === 0
      && missingModelVersionItemIds.length === 0
      && missingRequestIdItemIds.length === 0,
  };

  const byItemCost = {};
  const costCurrencies = new Set();
  for (const run of runs) {
    const cost = costFor(run?.output?.cost || run?.cost);
    if (!cost || !itemIdSet.has(run?.itemId)) continue;
    byItemCost[run.itemId] = (byItemCost[run.itemId] || 0) + cost.amount;
    costCurrencies.add(cost.currency);
  }
  for (const item of items) {
    if (byItemCost[item.id] !== undefined) continue;
    const cost = costFor(item?.output?.cost);
    if (!cost) continue;
    byItemCost[item.id] = cost.amount;
    costCurrencies.add(cost.currency);
  }
  const cost = {
    currency: costCurrencies.size === 1 ? [...costCurrencies][0] : costCurrencies.size ? 'mixed' : null,
    totalAmount: Object.values(byItemCost).reduce((total, amount) => total + amount, 0),
    perItem: byItemCost,
    missingItemIds: items.filter((item) => byItemCost[item.id] === undefined).map((item) => item.id),
    missingCount: items.filter((item) => byItemCost[item.id] === undefined).length,
  };

  const failureTypes = {};
  const countedFailureKeys = new Set();
  for (const run of runs) {
    if (run?.status !== 'failed') continue;
    const errorClass = run?.error?.errorClass || run?.error?.code || 'unknown';
    const key = `${run.itemId}|${run.attempt}|${errorClass}`;
    if (countedFailureKeys.has(key)) continue;
    countedFailureKeys.add(key);
    failureTypes[errorClass] = (failureTypes[errorClass] || 0) + 1;
  }
  for (const item of items) {
    if (!['failed', 'blocked'].includes(item?.status) || !item?.error) continue;
    const errorClass = item.error.errorClass || item.error.code || 'unknown';
    const key = `${item.id}|${item.attempt}|${errorClass}`;
    if (countedFailureKeys.has(key)) continue;
    countedFailureKeys.add(key);
    failureTypes[errorClass] = (failureTypes[errorClass] || 0) + 1;
  }
  const hardFailureCount = items.filter((item) => ['failed', 'blocked'].includes(item?.status)).length;
  const failures = {
    hardFailureCount,
    technicalHardFailureRate: expectedCount ? hardFailureCount / expectedCount : null,
    types: failureTypes,
  };

  const reviewedItems = items.filter((item) => REVIEW_STATUSES.has(item?.review?.decision));
  const approvedItems = reviewedItems.filter((item) => item.review.decision === 'approved');
  const sampling = batch.audit?.sampling || {};
  const sampleItemIds = [...new Set(Array.isArray(sampling.itemIds) ? sampling.itemIds.filter((id) => itemIdSet.has(id)) : [])];
  const sampleItems = items.filter((item) => sampleItemIds.includes(item.id));
  const sampleAvatars = new Set(sampleItems.map((item) => item.avatarVersionId));
  const sampleBuckets = new Set(sampleItems.map(scriptBucket));
  const sampledHardFailureItemIds = sampleItems.filter((item) => ['failed', 'blocked'].includes(item?.status)).map((item) => item.id);
  const expansionRequired = sampledHardFailureItemIds.length > 0 && sampling.expanded !== true;
  const missingAvatarVersionIds = (Array.isArray(batch.avatarVersionIds) ? batch.avatarVersionIds : [])
    .filter((id) => !sampleAvatars.has(id));
  const missingScriptLengthBuckets = SCRIPT_BUCKETS.filter((bucket) => !sampleBuckets.has(bucket));
  const human = {
    reviewedCount: reviewedItems.length,
    approvedCount: approvedItems.length,
    changesRequestedCount: reviewedItems.filter((item) => item.review.decision === 'changes_requested').length,
    passRate: reviewedItems.length ? approvedItems.length / reviewedItems.length : null,
    sampleRatio: number(sampling.ratio, sampleItemIds.length && expectedCount ? sampleItemIds.length / expectedCount : null),
    sampleItemIds,
    expanded: sampling.expanded === true,
    expandedReason: typeof sampling.expandedReason === 'string' ? sampling.expandedReason : null,
    reviewDurationMs: number(batch.audit?.humanReview?.durationMs),
    sampleCoverage: {
      sampledCount: sampleItems.length,
      requiredAvatarVersionIds: Array.isArray(batch.avatarVersionIds) ? [...batch.avatarVersionIds] : [],
      sampledAvatarVersionIds: [...sampleAvatars],
      missingAvatarVersionIds,
      requiredScriptLengthBuckets: SCRIPT_BUCKETS,
      sampledScriptLengthBuckets: [...sampleBuckets],
      missingScriptLengthBuckets,
      sampledHardFailureItemIds,
      expansionRequired,
      coversRequired: sampleItems.length > 0 && !missingAvatarVersionIds.length && !missingScriptLengthBuckets.length && !expansionRequired,
    },
  };

  const queueDurations = durationValues(runs, 'queueDurationMs', 'queuedAt');
  const generationDurations = durationValues(runs, 'durationMs');
  const postprocessDurations = items
    .map((item) => number(item?.output?.postprocess?.durationMs))
    .filter((value) => value !== null && value >= 0)
    .sort((left, right) => left - right);
  const started = runs.map((run) => Date.parse(run?.startedAt || '')).filter(Number.isFinite);
  const completed = runs.map((run) => Date.parse(run?.completedAt || '')).filter(Number.isFinite);
  const metrics = {
    queue: stageMetrics(queueDurations),
    generation: stageMetrics(generationDurations),
    postprocess: stageMetrics(postprocessDurations),
    totalElapsedMs: started.length && completed.length ? Math.max(0, Math.max(...completed) - Math.min(...started)) : null,
    concurrencyLimit: runs.reduce((max, run) => Math.max(max, number(run?.concurrencyLimit, 0)), 0) || null,
    observedConcurrency: runs.reduce((max, run) => Math.max(max, number(run?.activeConcurrency, 0)), 0) || null,
  };
  const exportRecord = batch.exportRecord || null;
  const exportAudit = {
    status: exportRecord?.status || 'not_run',
    manifest: exportRecord?.manifest || null,
    missingFiles: Array.isArray(exportRecord?.package?.missingFiles) ? exportRecord.package.missingFiles : [],
    complete: exportRecord?.status === 'complete' && !(exportRecord?.package?.missingFiles || []).length,
  };

  const minimumIntegrityPass = plan.complete
    && terminal.allExplainable
    && runComplete
    && reportComplete
    && media.allAutoChecked
    && human.sampleCoverage.coversRequired;
  const productionReady = minimumIntegrityPass && model.productionReady && media.allAutoPassed;
  return {
    version: 'content-batch-audit-v1',
    batchId: batch.id || null,
    plan,
    terminal,
    runs: {
      total: runs.length,
      orphanItemIds: orphanRunItemIds,
      missingItemIds: missingRunItemIds,
      complete: runComplete,
    },
    quality: {
      total: reports.length,
      orphanItemIds: orphanReportItemIds,
      missingItemIds: missingReportItemIds,
      complete: reportComplete,
      simulationOnly: model.simulatedCount > 0,
    },
    retries,
    media,
    model,
    cost,
    failures,
    human,
    metrics,
    export: exportAudit,
    ownerDecision: batch.audit?.ownerDecision || 'pending',
    minimumIntegrityPass,
    productionReady,
  };
}
