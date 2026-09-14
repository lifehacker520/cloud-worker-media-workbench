/**
 * S8-04/05（N22）：内容包构建——只收「人工通过 + 真实文件可播放」的条目。
 * 纯函数，不做 IO，便于单测；落盘由 server 调用方负责。
 */

export function evaluatePackageEligibility(item = {}) {
  const output = item.output || null;
  if (!output) return { eligible: false, reason: 'NO_OUTPUT' };
  if (output.simulated === true) return { eligible: false, reason: 'SIMULATED_OUTPUT' };
  if (!output.videoRef) return { eligible: false, reason: 'VIDEO_REF_MISSING' };
  if (item.status !== 'approved') return { eligible: false, reason: 'NOT_APPROVED' };
  if (item.review?.decision !== 'approved') return { eligible: false, reason: 'REVIEW_NOT_APPROVED' };
  if (item.review?.simulatedApproval === true) return { eligible: false, reason: 'SIMULATED_APPROVAL' };
  return { eligible: true, reason: null };
}

export function buildContentPackage({ batch = {}, packageId, createdAt, title = null } = {}) {
  const items = Array.isArray(batch.items) ? batch.items : [];
  const included = [];
  const blocked = [];
  for (const item of items) {
    const verdict = evaluatePackageEligibility(item);
    if (!verdict.eligible) {
      blocked.push({ itemId: item.id, status: item.status, reason: verdict.reason });
      continue;
    }
    included.push({
      itemId: item.id,
      outputName: item.outputName || null,
      videoRef: item.output.videoRef,
      audioRef: item.output.audioRef || null,
      provider: item.output.provider || item.output.modelVersion || null,
      modelVersion: item.output.modelVersion || null,
      requestId: item.output.requestId || null,
      attempt: item.attempt || null,
      verificationStatus: item.output.verificationStatus || 'passed_for_review',
      review: {
        decision: item.review.decision,
        reviewer: item.review.reviewer?.displayName || item.review.reviewer?.username || null,
        note: item.review.note || '',
        createdAt: item.review.createdAt || null,
      },
    });
  }
  return {
    packageId,
    batchId: batch.id || null,
    taskId: batch.taskId || null,
    title,
    createdAt,
    schemaVersion: 'content-package-v1',
    includedCount: included.length,
    blockedCount: blocked.length,
    included,
    blocked,
  };
}

export function summarizePackage(pkg = {}) {
  return {
    packageId: pkg.packageId,
    batchId: pkg.batchId || null,
    includedCount: Number(pkg.includedCount) || 0,
    blockedCount: Number(pkg.blockedCount) || 0,
    createdAt: pkg.createdAt || null,
    title: pkg.title || null,
  };
}
