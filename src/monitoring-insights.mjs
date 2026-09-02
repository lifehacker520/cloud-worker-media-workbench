import { createHash } from 'node:crypto';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export const MONITORING_METRIC_DEFINITIONS = {
  play_count: { label: '播放', shortLabel: '播放', unit: '次' },
  read_count: { label: '阅读', shortLabel: '阅读', unit: '次' },
  exposure_count: { label: '曝光', shortLabel: '曝光', unit: '次' },
  like_count: { label: '点赞', shortLabel: '点赞', unit: '次' },
  favorite_count: { label: '收藏', shortLabel: '收藏', unit: '次' },
  comment_count: { label: '评论', shortLabel: '评论', unit: '条' },
  share_count: { label: '分享', shortLabel: '分享', unit: '次' },
  follower_count: { label: '粉丝', shortLabel: '粉丝', unit: '人' },
};

const METRIC_ALIASES = {
  play_count: ['play_count', 'playCount', 'plays', 'play', '播放', '播放量'],
  read_count: ['read_count', 'readCount', 'reads', 'read', '阅读', '阅读量'],
  exposure_count: ['exposure_count', 'exposureCount', 'exposures', 'exposure', '曝光', '曝光量'],
  like_count: ['like_count', 'likeCount', 'likes', 'like', 'digg_count', 'diggCount', '点赞', '点赞量'],
  favorite_count: ['favorite_count', 'favoriteCount', 'favorites', 'favorite', 'collect_count', 'collectCount', '收藏', '收藏量'],
  comment_count: ['comment_count', 'commentCount', 'comments', 'comment', '评论', '评论量'],
  share_count: ['share_count', 'shareCount', 'shares', 'share', '分享', '分享量'],
  follower_count: ['follower_count', 'followerCount', 'followers', 'fans', 'fans_count', '粉丝', '粉丝数'],
};

const PLATFORM_LABELS = {
  xhs: '小红书',
  douyin: '抖音',
  channels: '视频号',
  other: '其他平台',
};

const PLATFORM_ORDER = ['xhs', 'douyin', 'channels', 'other'];

const PLATFORM_PRIMARY_METRICS = {
  xhs: ['read_count', 'exposure_count', 'like_count'],
  douyin: ['play_count', 'exposure_count', 'like_count'],
  channels: ['play_count', 'exposure_count', 'like_count'],
  other: ['play_count', 'read_count', 'exposure_count', 'like_count'],
};

const SUMMARY_METRICS = [
  'play_count',
  'read_count',
  'exposure_count',
  'like_count',
  'favorite_count',
  'comment_count',
  'share_count',
];

function text(value, fallback = '') {
  const result = String(value ?? '').trim();
  return result || fallback;
}

function dateValue(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function iso(value, fallback = null) {
  const date = dateValue(value);
  return date ? date.toISOString() : fallback;
}

function stableId(prefix, parts) {
  return (
    prefix + '_' +
    createHash('sha1').update(parts.map((part) => String(part ?? '')).join('\u0000')).digest('hex')
  );
}

function firstValue(source, aliases) {
  if (!source || typeof source !== 'object') {
    return null;
  }
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(source, alias)) {
      const value = parseMetricValue(source[alias]);
      if (value !== null) {
        return value;
      }
    }
  }
  return null;
}

export function parseMetricValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.replace(/[\s,，]/g, '').trim();
  if (!normalized || /^(?:-|—|暂无|未知|待解析|未获取|n\/a)$/i.test(normalized)) {
    return null;
  }
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*(亿|万|千|w|k|m)?/i);
  if (!match) {
    return null;
  }
  const base = Number(match[1]);
  if (!Number.isFinite(base)) {
    return null;
  }
  const unit = String(match[2] || '').toLowerCase();
  const multiplier = unit === '亿'
    ? 100000000
    : unit === '万' || unit === 'w'
      ? 10000
      : unit === '千' || unit === 'k'
        ? 1000
        : unit === 'm'
          ? 1000000
          : 1;
  return base * multiplier;
}

export function normalizeMetricMap(metrics = {}) {
  const result = {};
  for (const [metricKey, aliases] of Object.entries(METRIC_ALIASES)) {
    const value = firstValue(metrics, aliases);
    if (value !== null) {
      result[metricKey] = value;
    }
  }
  return result;
}

function dateKey(value) {
  const date = dateValue(value);
  if (!date) {
    return null;
  }
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function startOfShanghaiDate(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key || '')) {
    return null;
  }
  return new Date(Date.parse(key + 'T00:00:00.000Z') - SHANGHAI_OFFSET_MS);
}

function addDays(key, amount) {
  const date = new Date(Date.parse(key + 'T00:00:00.000Z'));
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function periodWindow(period, now) {
  const current = dateValue(now) || new Date();
  const today = dateKey(current);
  if (period === 'month') {
    const monthStart = today.slice(0, 7) + '-01';
    return {
      key: 'month',
      label: '本月',
      startKey: monthStart,
      startAt: startOfShanghaiDate(monthStart),
      endAt: current,
      trendStartKey: monthStart,
    };
  }
  if (period === 'week') {
    const todayUtc = new Date(Date.parse(today + 'T00:00:00.000Z'));
    const day = todayUtc.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = addDays(today, mondayOffset);
    return {
      key: 'week',
      label: '本周',
      startKey: monday,
      startAt: startOfShanghaiDate(monday),
      endAt: current,
      trendStartKey: monday,
    };
  }
  return {
    key: period === 'realtime' ? 'realtime' : 'all',
    label: period === 'realtime' ? '当前快照' : '当前台账',
    startKey: null,
    startAt: null,
    endAt: current,
    trendStartKey: addDays(today, -13),
  };
}

function withinWindow(value, window) {
  const date = dateValue(value);
  if (!date || (window.startAt && date < window.startAt) || (window.endAt && date > window.endAt)) {
    return false;
  }
  return true;
}

function platformLabel(platform) {
  return PLATFORM_LABELS[platform] || PLATFORM_LABELS.other;
}

function metricLabel(metricKey) {
  return MONITORING_METRIC_DEFINITIONS[metricKey]?.label || metricKey;
}

function primaryMetric(platform, metrics) {
  for (const key of PLATFORM_PRIMARY_METRICS[platform] || PLATFORM_PRIMARY_METRICS.other) {
    if (metrics[key]?.value !== null && metrics[key]?.value !== undefined) {
      return { key, label: metricLabel(key), value: metrics[key].value };
    }
  }
  return { key: null, label: '暂无平台主指标', value: null };
}

function snapshotGroupKey(snapshot) {
  return [snapshot.accountId, snapshot.workId || 'account', snapshot.metricKey].join('\u0000');
}

function snapshotDateGroupKey(snapshot) {
  return [dateKey(snapshot.observedAt), snapshot.accountId, snapshot.workId || 'account', snapshot.metricKey].join('\u0000');
}

function usableSnapshots(snapshots, endAt) {
  return (Array.isArray(snapshots) ? snapshots : [])
    .filter((snapshot) => snapshot?.status !== 'unavailable')
    .map((snapshot) => ({ ...snapshot, value: parseMetricValue(snapshot.value) }))
    .filter((snapshot) => snapshot.value !== null && withinWindow(snapshot.observedAt, { startAt: null, endAt }));
}

function latestByGroup(snapshots) {
  const latest = new Map();
  for (const snapshot of snapshots) {
    const key = snapshotGroupKey(snapshot);
    const existing = latest.get(key);
    if (!existing || Date.parse(snapshot.observedAt || '') > Date.parse(existing.observedAt || '')) {
      latest.set(key, snapshot);
    }
  }
  return [...latest.values()];
}

function metricsFromSnapshots(snapshots) {
  const result = {};
  for (const key of Object.keys(MONITORING_METRIC_DEFINITIONS)) {
    result[key] = {
      key,
      label: metricLabel(key),
      value: null,
      available: false,
      sampleCount: 0,
    };
  }
  for (const snapshot of snapshots) {
    if (!result[snapshot.metricKey]) {
      continue;
    }
    result[snapshot.metricKey].value = (result[snapshot.metricKey].value || 0) + snapshot.value;
    result[snapshot.metricKey].available = true;
    result[snapshot.metricKey].sampleCount += 1;
  }
  return result;
}

function latestSnapshotTotals(snapshots, workIds, accountIds) {
  const filtered = snapshots.filter((snapshot) => {
    if (snapshot.workId) {
      return workIds.has(snapshot.workId);
    }
    return accountIds.has(snapshot.accountId);
  });
  return metricsFromSnapshots(selectMetricTotals(latestByGroup(filtered)));
}

function selectMetricTotals(snapshots) {
  const latest = Array.isArray(snapshots) ? snapshots : [];
  const selected = [];
  for (const metricKey of Object.keys(MONITORING_METRIC_DEFINITIONS)) {
    const candidates = latest.filter((snapshot) => snapshot.metricKey === metricKey);
    if (!candidates.length) {
      continue;
    }
    // 作品级表现是“所有内容加起来”的真实口径；如果平台只返回账号级
    // 汇总，则回退到账号级。两种口径同时存在时不能重复相加。
    const workLevel = candidates.filter((snapshot) => snapshot.workId);
    const accountLevel = candidates.filter((snapshot) => !snapshot.workId);
    if (metricKey === 'follower_count') {
      selected.push(...accountLevel);
    } else {
      selected.push(...(workLevel.length ? workLevel : accountLevel));
    }
  }
  return selected;
}

function publishedWorks(works, window) {
  return works.filter((work) => window.key === 'all' || window.key === 'realtime' || withinWindow(work.publishedAt, window));
}

function trendFor({ works, snapshots, window, platform }) {
  const today = dateKey(window.endAt);
  const start = window.trendStartKey;
  const days = [];
  let cursor = start;
  while (cursor && cursor <= today && days.length < 31) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days.map((key) => {
    const dayWorks = works.filter((work) => dateKey(work.publishedAt) === key);
    const daySnapshots = snapshots.filter((snapshot) => dateKey(snapshot.observedAt) === key);
    const metrics = metricsFromSnapshots(
      selectMetricTotals(latestByGroup(daySnapshots.filter((snapshot) => {
          if (!platform || platform === 'all') return true;
          return snapshot.platform === platform;
        }))),
    );
    const primary = primaryMetric(platform && platform !== 'all' ? platform : 'other', metrics);
    return {
      date: key,
      label: key.slice(5).replace('-', '/'),
      publishedCount: dayWorks.length,
      primaryMetric: primary,
      metrics,
    };
  });
}

function topWorks({ works, snapshots, platform }) {
  return works
    .map((work) => {
      const workSnapshots = latestByGroup(snapshots.filter((snapshot) => snapshot.workId === work.id));
      const metrics = metricsFromSnapshots(workSnapshots);
      const primary = primaryMetric(work.platform || platform || 'other', metrics);
      return {
        id: work.id,
        title: text(work.title, '未命名作品'),
        platform: work.platform || platform || 'other',
        platformLabel: platformLabel(work.platform || platform || 'other'),
        publishedAt: work.publishedAt || work.discoveredAt || null,
        link: work.link || null,
        primaryMetric: primary,
        metrics,
      };
    })
    .sort((left, right) => {
      if (left.primaryMetric.value !== null && right.primaryMetric.value !== null) {
        return right.primaryMetric.value - left.primaryMetric.value;
      }
      if (left.primaryMetric.value !== null) return -1;
      if (right.primaryMetric.value !== null) return 1;
      return Date.parse(right.publishedAt || '') - Date.parse(left.publishedAt || '');
    })
    .slice(0, 5);
}

export function buildMonitoringEvidence({ account, works = [], profileMetrics = null, observedAt = new Date(), source = 'profile-parser', comments = [] } = {}) {
  const tenantId = text(account?.tenantId, 'tenant_local');
  const platform = text(account?.platform, 'other');
  const checkedAt = iso(observedAt, new Date().toISOString());
  const snapshots = [];
  const addSnapshot = ({ workId = null, metricKey, value, metadata = {} }) => {
    const numericValue = parseMetricValue(value);
    if (numericValue === null || !MONITORING_METRIC_DEFINITIONS[metricKey]) {
      return;
    }
    snapshots.push({
      id: stableId('metric', [tenantId, platform, account?.id, workId, metricKey, checkedAt]),
      tenantId,
      platform,
      accountId: text(account?.id, 'unknown'),
      workId: workId || null,
      metricKey,
      value: numericValue,
      observedAt: checkedAt,
      asOf: checkedAt,
      source: text(source, 'unknown'),
      status: 'available',
      coverage: 'observed',
      metadata,
    });
  };

  for (const [metricKey, value] of Object.entries(normalizeMetricMap(profileMetrics || {}))) {
    addSnapshot({ metricKey, value, metadata: { scope: 'account' } });
  }

  for (const work of Array.isArray(works) ? works : []) {
    const metrics = normalizeMetricMap({ ...(work.metrics || {}), likes: work.likes });
    for (const [metricKey, value] of Object.entries(metrics)) {
      addSnapshot({ workId: work.id, metricKey, value, metadata: { scope: 'work', contentId: work.contentId || work.noteId || null } });
    }
  }

  return {
    snapshots,
    comments: normalizeComments(comments, { account, works, source, fetchedAt: checkedAt }),
  };
}

export function normalizeComments(comments, { account = {}, works = [], source = 'unknown', fetchedAt = new Date() } = {}) {
  const workByExternalId = new Map();
  for (const work of Array.isArray(works) ? works : []) {
    for (const key of [work.id, work.contentId, work.noteId, work.externalId]) {
      if (key) workByExternalId.set(String(key), work);
    }
  }
  return (Array.isArray(comments) ? comments : [])
    .map((comment) => {
      const externalId = text(comment?.externalId || comment?.commentId || comment?.comment_id || comment?.id, '');
      const work = workByExternalId.get(String(comment?.workId || comment?.contentId || comment?.itemId || comment?.item_id || ''));
      const commentText = text(comment?.text || comment?.content || comment?.comment, '');
      if (!commentText) return null;
      const createdAt = iso(comment?.createdAt || comment?.createTime || comment?.create_time, null);
      const tenantId = text(account?.tenantId, 'tenant_local');
      const platform = text(account?.platform, 'other');
      return {
        id: stableId('comment', [tenantId, platform, externalId, work?.id, commentText, createdAt]),
        tenantId,
        platform,
        accountId: text(account?.id, 'unknown'),
        workId: work?.id || comment?.workId || null,
        externalId: externalId || null,
        text: commentText,
        authorName: text(comment?.authorName || comment?.nickname || comment?.userName, '匿名用户'),
        authorId: text(comment?.authorId || comment?.userId || comment?.user_id, '') || null,
        createdAt,
        likeCount: parseMetricValue(comment?.likeCount ?? comment?.diggCount ?? comment?.digg_count),
        replyCount: parseMetricValue(comment?.replyCount ?? comment?.reply_count),
        source: text(comment?.source || source, 'unknown'),
        fetchedAt: iso(fetchedAt, new Date().toISOString()),
        status: text(comment?.status, 'available'),
        metadata: comment?.metadata && typeof comment.metadata === 'object' ? comment.metadata : {},
      };
    })
    .filter(Boolean);
}

export function buildMonitoringInsights({ accounts = [], works = [], snapshots = [], comments = [], period = 'month', platform = 'all', accountId = 'all', now = new Date(), refreshState = null } = {}) {
  const window = periodWindow(period, now);
  const normalizedPlatform = platform && platform !== 'all' ? platform : 'all';
  const accountList = (Array.isArray(accounts) ? accounts : []).filter((account) => {
    const matchesPlatform = normalizedPlatform === 'all' || account.platform === normalizedPlatform;
    const matchesAccount = accountId === 'all' || account.id === accountId;
    return matchesPlatform && matchesAccount;
  });
  const accountIds = new Set(accountList.map((account) => account.id));
  const workList = (Array.isArray(works) ? works : []).filter((work) => {
    const account = accountList.find((item) => item.id === work.accountId);
    return Boolean(account) && (normalizedPlatform === 'all' || (work.platform || account.platform) === normalizedPlatform);
  });
  const periodWorks = publishedWorks(workList, window);
  const periodWorkIds = new Set(periodWorks.map((work) => work.id));
  const visibleSnapshots = usableSnapshots(snapshots, window.endAt).filter((snapshot) => {
    if (!accountIds.has(snapshot.accountId)) return false;
    if (normalizedPlatform !== 'all' && snapshot.platform !== normalizedPlatform) return false;
    return !snapshot.workId || periodWorkIds.has(snapshot.workId) || window.key === 'all' || window.key === 'realtime';
  });
  const currentSnapshots = latestByGroup(visibleSnapshots);
  const summaryMetrics = latestSnapshotTotals(visibleSnapshots, periodWorkIds, accountIds);
  const platformNames = [...new Set(accountList.map((account) => account.platform || 'other'))]
    .sort((left, right) => {
      const leftIndex = PLATFORM_ORDER.indexOf(left);
      const rightIndex = PLATFORM_ORDER.indexOf(right);
      return (leftIndex === -1 ? PLATFORM_ORDER.length : leftIndex)
        - (rightIndex === -1 ? PLATFORM_ORDER.length : rightIndex);
    });
  const platformRows = platformNames.map((rowPlatform) => {
    const rowAccounts = accountList.filter((account) => (account.platform || 'other') === rowPlatform);
    const rowAccountIds = new Set(rowAccounts.map((account) => account.id));
    const rowWorks = periodWorks.filter((work) => rowAccountIds.has(work.accountId));
    const rowWorkIds = new Set(rowWorks.map((work) => work.id));
    const rowSnapshots = currentSnapshots.filter((snapshot) => rowAccountIds.has(snapshot.accountId) && (!snapshot.workId || rowWorkIds.has(snapshot.workId)));
    const metrics = metricsFromSnapshots(selectMetricTotals(rowSnapshots));
    const primary = primaryMetric(rowPlatform, metrics);
    const observedMetricCount = SUMMARY_METRICS.filter((key) => metrics[key].available).length;
    const lastObservedAt = rowSnapshots.reduce((latest, snapshot) => (!latest || snapshot.observedAt > latest ? snapshot.observedAt : latest), null);
    return {
      platform: rowPlatform,
      platformLabel: platformLabel(rowPlatform),
      accountCount: rowAccounts.length,
      activeAccountCount: rowAccounts.filter((account) => account.state === 'active').length,
      publishedCount: rowWorks.length,
      publishedTodayCount: rowWorks.filter((work) => dateKey(work.publishedAt) === dateKey(window.endAt)).length,
      publishedThisWeekCount: rowWorks.filter((work) => withinWindow(work.publishedAt, periodWindow('week', window.endAt))).length,
      metrics,
      primaryMetric: primary,
      coverage: { observedMetricCount, expectedMetricCount: SUMMARY_METRICS.length, percent: Math.round((observedMetricCount / SUMMARY_METRICS.length) * 100) },
      lastObservedAt,
      status: rowAccounts.some((account) => account.state === 'error') ? 'attention' : rowSnapshots.length ? 'available' : 'unavailable',
    };
  });
  const latestObservedAt = visibleSnapshots.reduce((latest, snapshot) => (!latest || snapshot.observedAt > latest ? snapshot.observedAt : latest), null);
  const commentsVisible = (Array.isArray(comments) ? comments : [])
    .filter((comment) => accountIds.has(comment.accountId))
    .filter((comment) => normalizedPlatform === 'all' || comment.platform === normalizedPlatform)
    .filter((comment) => !comment.createdAt || withinWindow(comment.createdAt, window))
    .sort((left, right) => Date.parse(right.createdAt || right.fetchedAt || '') - Date.parse(left.createdAt || left.fetchedAt || ''))
    .slice(0, 20);
  const hasCommentCollection = commentsVisible.length > 0 || accountList.some((account) =>
    ['available', 'empty'].includes(account.commentStatus) || account.commentLastFetchedAt,
  );
  const todayKey = dateKey(window.endAt);
  const weekWindow = periodWindow('week', window.endAt);
  const publishedTodayCount = workList.filter((work) => dateKey(work.publishedAt) === todayKey).length;
  const publishedThisWeekCount = workList.filter((work) => withinWindow(work.publishedAt, weekWindow)).length;
  const attentionAccountCount = accountList.filter((account) => account.state === 'error').length;
  const refreshStatus = refreshState?.refreshInProgress
    ? 'refreshing'
    : refreshState?.refreshError
      ? 'attention'
      : refreshState?.lastRefreshAt
        ? 'ready'
        : 'idle';
  const missingMetrics = SUMMARY_METRICS.filter((key) => !summaryMetrics[key].available).map((key) => metricLabel(key));
  return {
    period: {
      key: window.key,
      label: window.label,
      startAt: window.startAt?.toISOString() || null,
      endAt: window.endAt?.toISOString() || null,
    },
    filter: { platform: normalizedPlatform, accountId },
    summary: {
      accountCount: accountList.length,
      activeAccountCount: accountList.filter((account) => account.state === 'active').length,
      publishedCount: periodWorks.length,
      metrics: summaryMetrics,
    },
    operations: {
      publishedTodayCount,
      publishedThisWeekCount,
      publishedPeriodCount: periodWorks.length,
      accountCount: accountList.length,
      activeAccountCount: accountList.filter((account) => account.state === 'active').length,
      attentionAccountCount,
      lastRefreshAt: refreshState?.lastRefreshAt || null,
      lastRefreshSummary: refreshState?.lastRefreshSummary || null,
      refreshStatus,
      refreshError: refreshState?.refreshError || null,
    },
    platforms: platformRows,
    trend: trendFor({ works: periodWorks, snapshots: visibleSnapshots, window, platform: normalizedPlatform }),
    topWorks: topWorks({ works: periodWorks, snapshots: visibleSnapshots, platform: normalizedPlatform }),
    comments: {
      available: commentsVisible.length > 0,
      count: commentsVisible.length,
      items: commentsVisible,
      status: commentsVisible.length ? 'available' : hasCommentCollection ? 'empty' : 'not_connected',
    },
    dataQuality: {
      snapshotCount: visibleSnapshots.length,
      currentSnapshotCount: currentSnapshots.length,
      availableMetricCount: SUMMARY_METRICS.filter((key) => summaryMetrics[key].available).length,
      expectedMetricCount: SUMMARY_METRICS.length,
      missingMetrics,
      latestObservedAt,
      sources: [...new Set(visibleSnapshots.map((snapshot) => snapshot.source).filter(Boolean))],
      note: visibleSnapshots.length && missingMetrics.length < SUMMARY_METRICS.length
        ? '指标来自已保存的采集快照；表现指标按作品最新快照求和，账号级指标不与作品重复相加。'
        : visibleSnapshots.length
          ? '已获得账号级快照，但作品表现指标尚未接入；完成平台会话采集后会显示播放、阅读、曝光等总和。'
        : '当前只有账号与作品台账，尚未获得可用于表现统计的指标快照。',
    },
  };
}
