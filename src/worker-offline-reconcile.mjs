/**
 * Worker 离线对账（P0 缺陷修复，2026-09-15 实例被停机事件驱动）
 *
 * 问题：云实例被停机（余额耗尽 / 被抢占 / 崩溃）时，正在跑的条目会永远停在 `running`，
 *       页面显示假死状态，只能靠人工补偿标记失败。
 *
 * 本模块把「对账规则」抽成纯函数，便于单测；由 server 在以下时机调用：
 *   1) 启动时；
 *   2) Worker 健康检查返回离线时；
 *   3) 定时轮询（可选）。
 *
 * 安全边界：
 *   - 只处理 `running` 状态的条目；
 *   - 只处理「最后更新时间早于 staleMs」的条目，避免把刚启动、正在跑的条目误判为失败；
 *   - 失败标记为可重试（retryable: true），保留 attempt 历史，不删除产物引用。
 */

export const OFFLINE_ERROR = {
  errorClass: 'worker_unavailable',
  code: 'INSTANCE_OFFLINE',
  message: '云实例已离线（停机/被抢占/异常退出），生成中断；恢复算力后可重试',
  retryable: true,
};

/**
 * @param {object}   input
 * @param {object}   input.batch       批次记录（含 items）
 * @param {object}   input.health      Worker 健康结果，形如 { ok: boolean, error?: string }
 * @param {string}   input.actor       操作者快照
 * @param {function} input.transitionItem 注入的状态机（batch, itemId, action, actor, options) => batch
 * @param {function} input.now         注入时钟（返回 ISO 字符串），便于测试
 * @param {number}   [input.staleMs]   判定阈值，默认 3 分钟
 * @returns {{ changed: Array<{itemId: string, previousStatus: string, ageMs: number}>, batch: object, skipped: Array<{itemId: string, reason: string}> }}
 */
export function reconcileOfflineWorkerItems(input = {}) {
  const { batch, health, actor, transitionItem, now, staleMs = 3 * 60 * 1000 } = input;
  if (!batch || !Array.isArray(batch.items)) return { changed: [], batch, skipped: [] };
  if (typeof transitionItem !== 'function') throw new Error('reconcileOfflineWorkerItems 需要 transitionItem');
  const nowMs = Date.parse(typeof now === 'function' ? now() : new Date().toISOString());

  const changed = [];
  const skipped = [];
  let current = batch;

  /* Worker 在线时不做任何对账（避免打断正常生成） */
  if (health?.ok === true) {
    return { changed, batch, skipped: batch.items.map((item) => ({ itemId: item.id, reason: 'worker_online' })) };
  }

  for (const item of batch.items) {
    if (item.status !== 'running') {
      skipped.push({ itemId: item.id, reason: 'not_running' });
      continue;
    }
    const updatedMs = Date.parse(item.updatedAt || item.startedAt || item.createdAt || '');
    const ageMs = Number.isFinite(updatedMs) ? nowMs - updatedMs : Number.POSITIVE_INFINITY;
    if (ageMs < staleMs) {
      skipped.push({ itemId: item.id, reason: 'recently_active' });
      continue;
    }
    current = transitionItem(current, item.id, 'fail', actor, {
      error: { ...OFFLINE_ERROR, message: OFFLINE_ERROR.message + '（最后活动距今 ' + Math.round(ageMs / 1000) + ' 秒）' },
    });
    changed.push({ itemId: item.id, previousStatus: 'running', ageMs });
  }

  return { changed, batch: current, skipped };
}
