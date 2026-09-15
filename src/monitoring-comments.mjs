/**
 * 监控评论 · 归一化与采集编排（VIS-14）
 *
 * 职责边界：
 *   - 本模块只做「纯数据变换」：挑选待采集作品、把浏览器层抓到的评论
 *     映射成监听台评论模型、去重与统计。不做任何网络/浏览器/存储调用，
 *     因此可被 node --test 直接覆盖。
 *   - 真实抓取由 electron 侧 PlatformBrowserSession.collectWorkComments 负责；
 *     落库由 server.mjs 端点调用 workbenchStore.saveMonitoringComments 完成。
 *
 * 数据真实性边界：抓不到评论时返回空数组，绝不生成占位评论；调用方据
 * 空结果把账号 commentStatus 标为 empty（已尝试）而不是伪造数据。
 */

const DEFAULT_PER_ACCOUNT = 3;
const DEFAULT_PER_WORK_LIMIT = 20;
const MAX_PER_ACCOUNT = 10;
const MAX_PER_WORK_LIMIT = 50;

function text(value, fallback = null) {
  if (value === null || value === undefined) {
    return fallback;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : fallback;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function workTimestamp(work) {
  return text(work?.publishedAt) || text(work?.discoveredAt) || text(work?.fetchedAt) || '';
}

/**
 * 从账号作品里挑选待采集评论的目标：优先有直链、按发布时间（缺省发现时间）倒序。
 */
export function planCommentCollection({ works = [], perAccount = DEFAULT_PER_ACCOUNT } = {}) {
  const size = Math.min(
    Math.max(Math.round(Number(perAccount) || DEFAULT_PER_ACCOUNT), 1),
    MAX_PER_ACCOUNT,
  );
  const eligible = (Array.isArray(works) ? works : [])
    .filter((work) => text(work?.link))
    .slice()
    .sort((left, right) => workTimestamp(right).localeCompare(workTimestamp(left)));
  const selected = eligible.slice(0, size);
  return {
    selected,
    eligibleCount: eligible.length,
    skippedMissingLink: (Array.isArray(works) ? works : []).filter((work) => !text(work?.link)).length,
  };
}

/**
 * 把浏览器层的作品 id（noteId/contentId/短链）映射到监听台内部作品 id。
 * 匹配顺序：外部 id 精确匹配 → 作品直链包含外部 id → 直链完全相等。
 */
export function matchWorkId({ comment, works = [], workUrl = null } = {}) {
  const external = text(comment?.workId);
  const list = Array.isArray(works) ? works : [];
  if (external) {
    const bare = external.split('?')[0].split('#')[0];
    const candidates = bare && bare !== external ? [external, bare] : [external];
    for (const candidate of candidates) {
      const direct = list.find((work) =>
        [work?.noteId, work?.contentId, work?.externalId, work?.id].some((value) => text(value) === candidate),
      );
      if (direct) {
        return direct.id;
      }
      const byLink = list.find((work) => text(work?.link)?.includes(candidate));
      if (byLink) {
        return byLink.id;
      }
    }
  }
  const url = text(workUrl);
  if (url) {
    const byUrl = list.find((work) => text(work?.link) === url);
    if (byUrl) {
      return byUrl.id;
    }
  }
  return null;
}

/**
 * 单条评论 → 监听台评论模型。
 * id 采用 accountId + externalId 组合，保证重复采集时落库幂等（upsert 同一条）。
 */
export function normalizeWorkComment({ comment, account, workId = null, fetchedAt }) {
  const externalId = text(comment?.externalId ?? comment?.id);
  const body = text(comment?.text);
  const accountId = text(account?.id);
  if (!externalId || !body || !accountId) {
    return null;
  }
  return {
    id: 'comment_' + accountId + '_' + externalId,
    tenantId: text(account?.tenantId, 'tenant_local'),
    platform: text(comment?.platform, text(account?.platform, 'xhs')),
    accountId,
    workId: workId || null,
    externalId,
    text: body,
    authorName: text(comment?.authorName, '匿名用户'),
    authorId: text(comment?.authorId),
    createdAt: text(comment?.createdAt ?? comment?.commentCreatedAt),
    likeCount: numeric(comment?.likeCount),
    replyCount: numeric(comment?.replyCount),
    source: text(comment?.source, 'browser-network'),
    fetchedAt: text(fetchedAt, new Date().toISOString()),
    status: 'available',
    metadata: {
      ipLocation: text(comment?.ipLocation),
      collectedBy: 'browser-work-page',
    },
  };
}

/**
 * 批量归一化 + 去重（同一 externalId 只保留点赞更高的那条）。
 * 返回按点赞数倒序的评论数组；空输入返回空数组。
 */
export function normalizeBrowserComments({ comments = [], account, works = [], workUrl = null, fetchedAt } = {}) {
  const byId = new Map();
  for (const comment of Array.isArray(comments) ? comments : []) {
    const workId = matchWorkId({ comment, works, workUrl });
    const normalized = normalizeWorkComment({ comment, account, workId, fetchedAt });
    if (!normalized) {
      continue;
    }
    const existing = byId.get(normalized.id);
    if (!existing || (normalized.likeCount ?? 0) > (existing.likeCount ?? 0)) {
      byId.set(normalized.id, normalized);
    }
  }
  return [...byId.values()].sort((left, right) => (right.likeCount ?? 0) - (left.likeCount ?? 0));
}

/**
 * 汇总一次采集结果，供端点回传与前端提示使用。
 */
export function summarizeCommentCollection(results = []) {
  const list = Array.isArray(results) ? results : [];
  const collected = list.reduce((sum, item) => sum + (Array.isArray(item?.comments) ? item.comments.length : 0), 0);
  return {
    worksAttempted: list.length,
    worksSucceeded: list.filter((item) => item?.ok).length,
    worksFailed: list.filter((item) => !item?.ok).length,
    collected,
    failures: list
      .filter((item) => !item?.ok)
      .map((item) => ({ workId: item?.workId || null, workUrl: item?.workUrl || null, error: item?.error || '采集失败' })),
  };
}

export const COMMENT_COLLECTION_LIMITS = {
  defaultPerAccount: DEFAULT_PER_ACCOUNT,
  defaultPerWork: DEFAULT_PER_WORK_LIMIT,
  maxPerAccount: MAX_PER_ACCOUNT,
  maxPerWork: MAX_PER_WORK_LIMIT,
};
