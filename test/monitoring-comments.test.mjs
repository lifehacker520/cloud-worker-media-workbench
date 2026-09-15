import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  planCommentCollection,
  matchWorkId,
  normalizeWorkComment,
  normalizeBrowserComments,
  summarizeCommentCollection,
  COMMENT_COLLECTION_LIMITS,
} from '../src/monitoring-comments.mjs';

const ACCOUNT = { id: 'acc_xhs_1', tenantId: 'tenant_local', platform: 'xhs' };

/* 与 electron 层 commentFromObject 输出结构保持一致（字段名即契约）。 */
function browserComment(overrides = {}) {
  return {
    platform: 'xhs',
    externalId: 'c_1001',
    workId: 'note_a',
    text: '这个功能真的是刚需',
    authorName: '小明',
    authorId: 'u_9',
    createdAt: '2026-09-15T02:00:00.000Z',
    likeCount: 12,
    replyCount: 3,
    ...overrides,
  };
}

const WORKS = [
  { id: 'work_new', noteId: 'note_c', link: 'https://www.xiaohongshu.com/explore/note_c', publishedAt: '2026-09-14T10:00:00.000Z' },
  { id: 'work_mid', noteId: 'note_b', link: 'https://www.xiaohongshu.com/explore/note_b', publishedAt: '2026-09-10T10:00:00.000Z' },
  { id: 'work_old', noteId: 'note_a', link: 'https://www.xiaohongshu.com/explore/note_a', publishedAt: '2026-09-01T10:00:00.000Z' },
  { id: 'work_nolink', noteId: 'note_d', publishedAt: '2026-09-15T10:00:00.000Z' },
];

test('planCommentCollection 取最新且带直链的作品，跳过无直链', () => {
  const plan = planCommentCollection({ works: WORKS, perAccount: 2 });
  assert.deepEqual(plan.selected.map((work) => work.id), ['work_new', 'work_mid']);
  assert.equal(plan.eligibleCount, 3);
  assert.equal(plan.skippedMissingLink, 1);
});

test('planCommentCollection 对越界参数做收敛', () => {
  const tooMany = planCommentCollection({ works: WORKS, perAccount: 999 });
  assert.ok(tooMany.selected.length <= COMMENT_COLLECTION_LIMITS.maxPerAccount);
  const zero = planCommentCollection({ works: WORKS, perAccount: 0 });
  assert.equal(zero.selected.length, COMMENT_COLLECTION_LIMITS.defaultPerAccount);
});

test('matchWorkId 支持外部 id 精确匹配、直链包含、直链相等三种解析', () => {
  assert.equal(matchWorkId({ comment: browserComment({ workId: 'note_a' }), works: WORKS }), 'work_old');
  assert.equal(matchWorkId({ comment: browserComment({ workId: null }), works: WORKS, workUrl: 'https://www.xiaohongshu.com/explore/note_b' }), 'work_mid');
  assert.equal(
    matchWorkId({ comment: browserComment({ workId: 'note_c?xsec_token=abc' }), works: WORKS }),
    'work_new',
  );
  assert.equal(matchWorkId({ comment: browserComment({ workId: 'unknown_note' }), works: WORKS }), null);
});

test('normalizeWorkComment 生成幂等 id 并保留真实字段', () => {
  const comment = normalizeWorkComment({
    comment: browserComment(),
    account: ACCOUNT,
    workId: 'work_old',
    fetchedAt: '2026-09-15T03:00:00.000Z',
  });
  assert.equal(comment.id, 'comment_acc_xhs_1_c_1001');
  assert.equal(comment.accountId, 'acc_xhs_1');
  assert.equal(comment.workId, 'work_old');
  assert.equal(comment.text, '这个功能真的是刚需');
  assert.equal(comment.authorName, '小明');
  assert.equal(comment.likeCount, 12);
  assert.equal(comment.replyCount, 3);
  assert.equal(comment.status, 'available');
  assert.equal(comment.source, 'browser-network');
  assert.equal(comment.fetchedAt, '2026-09-15T03:00:00.000Z');
});

test('normalizeWorkComment 拒绝缺外部 id / 缺正文 / 缺账号的脏数据', () => {
  assert.equal(normalizeWorkComment({ comment: browserComment({ externalId: null }), account: ACCOUNT }), null);
  assert.equal(normalizeWorkComment({ comment: browserComment({ text: '   ' }), account: ACCOUNT }), null);
  assert.equal(normalizeWorkComment({ comment: browserComment(), account: null }), null);
});

test('normalizeBrowserComments 去重取点赞更高者并按点赞倒序', () => {
  const comments = normalizeBrowserComments({
    comments: [
      browserComment({ externalId: 'c_1', likeCount: 3, text: '低赞' }),
      browserComment({ externalId: 'c_1', likeCount: 30, text: '同一条的高赞快照' }),
      browserComment({ externalId: 'c_2', likeCount: 10, workId: 'note_b', text: '另一条作品' }),
      browserComment({ externalId: 'c_3', likeCount: 99, workId: null, text: '无作品归属' }),
    ],
    account: ACCOUNT,
    works: WORKS,
    workUrl: 'https://www.xiaohongshu.com/explore/note_a',
    fetchedAt: '2026-09-15T03:00:00.000Z',
  });
  assert.equal(comments.length, 3);
  assert.deepEqual(comments.map((item) => item.likeCount), [99, 30, 10]);
  assert.equal(comments.find((item) => item.externalId === 'c_1').text, '同一条的高赞快照');
  assert.equal(comments.find((item) => item.externalId === 'c_2').workId, 'work_mid');
  /* c_3 未带作品 id，但本次采集的作品页是 note_a，评论天然归属该作品 */
  assert.equal(comments.find((item) => item.externalId === 'c_3').workId, 'work_old');
});

test('normalizeBrowserComments 空输入返回空数组（不伪造评论）', () => {
  assert.deepEqual(normalizeBrowserComments({ account: ACCOUNT, works: WORKS }), []);
  assert.deepEqual(normalizeBrowserComments({ comments: [], account: ACCOUNT }), []);
});

test('summarizeCommentCollection 汇总成功、失败与采集条数', () => {
  const summary = summarizeCommentCollection([
    { workId: 'work_new', ok: true, comments: [1, 2, 3] },
    { workId: 'work_mid', ok: false, error: '作品页需要登录或人工验证', workUrl: 'https://x/note_b' },
  ]);
  assert.equal(summary.worksAttempted, 2);
  assert.equal(summary.worksSucceeded, 1);
  assert.equal(summary.worksFailed, 1);
  assert.equal(summary.collected, 3);
  assert.equal(summary.failures.length, 1);
  assert.match(summary.failures[0].error, /登录|验证/);
});

/* ---- 源码契约：抓取与落库链路必须保持连通（防止后续重构断链） ---- */

test('契约：electron 侧提供 collectWorkComments 并透传 comments', () => {
  const source = readFileSync(new URL('../electron/platform-browser.mjs', import.meta.url), 'utf8');
  assert.match(source, /async collectWorkComments\(platform, input, options = \{\}\)/);
  assert.match(source, /comments: payloadData\.comments/);
  assert.match(source, /entry\.context\.responses/);
});

test('契约：server 侧评论采集端点走 browserSession 并落库', () => {
  const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(source, /\/collect-comments'/);
  assert.match(source, /collectWorkComments/);
  assert.match(source, /saveMonitoringComments\(/);
  assert.match(source, /commentStatus = 'available'/);
});

test('契约：captureMonitoringEvidence 仍消费 fetched.comments', () => {
  const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(source, /comments: fetched\?\.comments \|\| parsed\?\.comments \|\| \[\]/);
});
