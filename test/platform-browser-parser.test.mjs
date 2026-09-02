import assert from 'node:assert/strict';
import test from 'node:test';

import { extractPayloadData } from '../electron/platform-browser.mjs';

test('browser network extraction keeps work metrics and generic comment ids', () => {
  const payloads = [
    {
      url: 'https://www.douyin.com/aweme/v1/web/aweme/post/',
      status: 200,
      body: {
        user: {
          sec_uid: 'MS4wLjABAAAA-demo-user',
          nickname: '演示抖音账号',
          follower_count: 56200,
        },
        aweme_list: [
          {
            aweme_id: '7550000000000000001',
            desc: '演示视频',
            create_time: 1788300000,
            statistics: {
              play_count: 68000,
              digg_count: 4300,
              collect_count: 1200,
              comment_count: 186,
              share_count: 760,
            },
          },
        ],
      },
    },
    {
      url: 'https://www.douyin.com/aweme/v1/web/comment/list/',
      status: 200,
      body: {
        comments: [
          {
            id: 'comment-generic-id',
            aweme_id: '7550000000000000001',
            text: '请问怎么使用？',
            create_time: 1788300200,
            user: { nickname: '访客 A', uid: 'visitor-a' },
            digg_count: 8,
            reply_comment_total: 2,
          },
        ],
      },
    },
  ];

  const result = extractPayloadData('douyin', payloads, 'https://www.douyin.com/user/MS4wLjABAAAA-demo-user');

  assert.equal(result.profile.nickname, '演示抖音账号');
  assert.equal(result.profileMetrics.follower_count, 56200);
  assert.equal(result.works.length, 1);
  assert.equal(result.works[0].metrics.play_count, 68000);
  assert.equal(result.works[0].metrics.like_count, 4300);
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0].externalId, 'comment-generic-id');
  assert.equal(result.comments[0].authorName, '访客 A');
  assert.equal(result.comments[0].workId, '7550000000000000001');
});

test('browser network relevance includes comment and statistics endpoints', async () => {
  const source = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const file = resolve(dirname(fileURLToPath(import.meta.url)), '../electron/platform-browser.mjs');
  const text = await source.readFile(file, 'utf8');
  assert.match(text, /comment\|statistics/);
  assert.match(text, /metricsFromWork/);
});
