import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildMonitoringEvidence,
  buildMonitoringInsights,
  normalizeComments,
  parseMetricValue,
} from '../src/monitoring-insights.mjs';

const now = '2026-09-02T04:00:00.000Z';

test('metric values keep Chinese units and unknown values separate', () => {
  assert.equal(parseMetricValue('1.2万+'), 12000);
  assert.equal(parseMetricValue('3,200'), 3200);
  assert.equal(parseMetricValue('0'), 0);
  assert.equal(parseMetricValue('暂无'), null);
  assert.equal(parseMetricValue('待获取'), null);
});

test('monitoring evidence creates work snapshots without inventing missing metrics', () => {
  const evidence = buildMonitoringEvidence({
    account: { id: 'account_douyin', tenantId: 'tenant_demo', platform: 'douyin' },
    works: [
      {
        id: 'work_douyin_1',
        contentId: 'video-1',
        likes: '1.2万',
        metrics: { play_count: 56000, comment_count: 32 },
      },
    ],
    observedAt: now,
    source: 'official-fixture',
    comments: [
      {
        id: 'comment-1',
        workId: 'work_douyin_1',
        content: '请问怎么使用？',
        nickname: '访客 A',
        createTime: now,
        diggCount: 4,
      },
    ],
  });

  assert.deepEqual(
    evidence.snapshots.map((item) => [item.workId, item.metricKey, item.value]),
    [
      ['work_douyin_1', 'play_count', 56000],
      ['work_douyin_1', 'like_count', 12000],
      ['work_douyin_1', 'comment_count', 32],
    ],
  );
  assert.equal(evidence.comments.length, 1);
  assert.equal(evidence.comments[0].authorName, '访客 A');
  assert.equal(evidence.comments[0].likeCount, 4);
});

test('monitoring insights aggregate by period and preserve platform-native metrics', () => {
  const accounts = [
    { id: 'account_douyin', tenantId: 'tenant_demo', platform: 'douyin', state: 'active' },
    { id: 'account_xhs', tenantId: 'tenant_demo', platform: 'xhs', state: 'pending' },
  ];
  const works = [
    {
      id: 'work_douyin_1',
      accountId: 'account_douyin',
      platform: 'douyin',
      title: '抖音作品一',
      publishedAt: '2026-09-01T02:00:00.000Z',
      link: 'https://www.douyin.com/video/video-1',
    },
    {
      id: 'work_xhs_1',
      accountId: 'account_xhs',
      platform: 'xhs',
      title: '小红书笔记一',
      publishedAt: '2026-08-31T02:00:00.000Z',
    },
  ];
  const snapshots = [
    { id: 'metric-play', tenantId: 'tenant_demo', platform: 'douyin', accountId: 'account_douyin', workId: 'work_douyin_1', metricKey: 'play_count', value: 56000, observedAt: now, source: 'official-fixture', status: 'available' },
    { id: 'metric-like', tenantId: 'tenant_demo', platform: 'douyin', accountId: 'account_douyin', workId: 'work_douyin_1', metricKey: 'like_count', value: 12000, observedAt: now, source: 'official-fixture', status: 'available' },
  ];
  const comments = normalizeComments([
    { id: 'comment-1', workId: 'work_douyin_1', content: '请问怎么使用？', createTime: now },
  ], { account: accounts[0], works, source: 'official-fixture', fetchedAt: now });

  const insights = buildMonitoringInsights({
    accounts,
    works,
    snapshots,
    comments,
    period: 'month',
    now,
  });

  assert.equal(insights.period.key, 'month');
  assert.equal(insights.summary.accountCount, 2);
  assert.equal(insights.summary.publishedCount, 1);
  assert.equal(insights.summary.metrics.play_count.value, 56000);
  assert.equal(insights.summary.metrics.like_count.value, 12000);
  assert.equal(insights.summary.metrics.read_count.value, null);
  assert.equal(insights.platforms.find((item) => item.platform === 'douyin').primaryMetric.value, 56000);
  assert.equal(insights.comments.count, 1);
  assert.equal(insights.topWorks[0].title, '抖音作品一');
  assert.ok(insights.dataQuality.missingMetrics.includes('阅读'));
});

test('monitoring totals sum the latest snapshot of every work without double counting account aggregates', () => {
  const accounts = [
    { id: 'account_douyin_total', tenantId: 'tenant_demo', platform: 'douyin', state: 'active', commentStatus: 'empty', commentLastFetchedAt: now },
  ];
  const works = [
    {
      id: 'work_douyin_total_1',
      accountId: 'account_douyin_total',
      platform: 'douyin',
      title: '第一条',
      publishedAt: '2026-09-01T01:00:00.000Z',
    },
    {
      id: 'work_douyin_total_2',
      accountId: 'account_douyin_total',
      platform: 'douyin',
      title: '第二条',
      publishedAt: '2026-09-02T01:00:00.000Z',
    },
  ];
  const snapshots = [
    { id: 'account-play', platform: 'douyin', accountId: 'account_douyin_total', metricKey: 'play_count', value: 999999, observedAt: now, status: 'available' },
    { id: 'work-play-1', platform: 'douyin', accountId: 'account_douyin_total', workId: works[0].id, metricKey: 'play_count', value: 100, observedAt: now, status: 'available' },
    { id: 'work-play-2-old', platform: 'douyin', accountId: 'account_douyin_total', workId: works[1].id, metricKey: 'play_count', value: 50, observedAt: '2026-09-01T04:00:00.000Z', status: 'available' },
    { id: 'work-play-2-new', platform: 'douyin', accountId: 'account_douyin_total', workId: works[1].id, metricKey: 'play_count', value: 200, observedAt: now, status: 'available' },
    { id: 'work-like-1', platform: 'douyin', accountId: 'account_douyin_total', workId: works[0].id, metricKey: 'like_count', value: 10, observedAt: now, status: 'available' },
    { id: 'work-like-2', platform: 'douyin', accountId: 'account_douyin_total', workId: works[1].id, metricKey: 'like_count', value: 20, observedAt: now, status: 'available' },
  ];

  const insights = buildMonitoringInsights({
    accounts,
    works,
    snapshots,
    period: 'month',
    now,
    refreshState: { lastRefreshAt: now, lastRefreshSummary: { checked: 1, succeeded: 1, failed: 0 } },
  });

  assert.equal(insights.summary.metrics.play_count.value, 300);
  assert.equal(insights.summary.metrics.play_count.sampleCount, 2);
  assert.equal(insights.summary.metrics.like_count.value, 30);
  assert.equal(insights.operations.publishedThisWeekCount, 2);
  assert.equal(insights.operations.lastRefreshAt, now);
  assert.equal(insights.comments.status, 'empty');
  assert.equal(insights.platforms[0].metrics.play_count.value, 300);
});
