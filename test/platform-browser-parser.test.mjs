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

test('xhs comment payloads use content.message and survive extraction', () => {
  /* 真实小红书 /api/sns/web/v2/comment/page 响应形状：正文在 content.message
     （content 是对象），回复数在 sub_comment_count，IP 属地在 ip_location。
     回归背景：VIS-14 评论采集上线后 XHS 评论一直为 0，根因是
     scalarText(object.content) 遇到对象返回 null，全部评论被丢弃。 */
  const payloads = [
    {
      url: 'https://www.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=67d3fb1a000000000f021ad8&cursor=',
      status: 200,
      body: {
        code: 0,
        success: true,
        data: {
          comments: [
            {
              id: '67f12345abc0000001234567',
              ip_location: '江西',
              create_time: 1757900000000,
              like_count: '16',
              sub_comment_count: '2',
              content: { message: '请问训练营还能报名吗？', scenes: [] },
              user_info: {
                user_id: '65abc1230000000012345678',
                nickname: '山风与海',
                avatar: 'https://sns-avatar.xhscdn.com/demo.jpg',
              },
              sub_comments: [
                {
                  id: '67f12345abc0000001234568',
                  ip_location: '广东',
                  create_time: 1757900300000,
                  like_count: '1',
                  content: { message: '可以的支持一下', scenes: [] },
                  user_info: { user_id: '65abc9990000000012345678', nickname: '作者本人' },
                },
              ],
            },
          ],
        },
      },
    },
  ];

  const result = extractPayloadData('xhs', payloads, 'https://www.xiaohongshu.com/user/profile/65abc');

  assert.equal(result.comments.length, 2);
  const top = result.comments.find((comment) => comment.externalId === '67f12345abc0000001234567');
  assert.ok(top, '主评论必须被提取');
  assert.equal(top.text, '请问训练营还能报名吗？');
  assert.equal(top.authorName, '山风与海');
  assert.equal(top.likeCount, '16');
  assert.equal(top.replyCount, '2');
  assert.equal(top.ipLocation, '江西');
  assert.equal(top.create_time instanceof Date, false);
  const reply = result.comments.find((comment) => comment.externalId === '67f12345abc0000001234568');
  assert.ok(reply, '子评论必须被提取');
  assert.equal(reply.text, '可以的支持一下');
});

test('browser network relevance includes comment and statistics endpoints', async () => {
  const source = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const file = resolve(dirname(fileURLToPath(import.meta.url)), '../electron/platform-browser.mjs');
  const text = await source.readFile(file, 'utf8');
  assert.match(text, /comment\|statistics/);
  assert.match(text, /metricsFromWork/);
  assert.match(text, /MEDIA_ACTIVATION_SCRIPT/);
  assert.match(text, /normalizeDownloadMedia\(payloads\.map/);
  assert.match(text, /async fetchMedia\(platform, input/);
});
