import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalizeInput,
  parseBrowserSnapshot,
} from '../src/channels-parser.mjs';

test('canonicalizeInput accepts a video account link without dropping finderUsername', () => {
  const result = canonicalizeInput(
    'https://channels.weixin.qq.com/web/pages/profile?finderUsername=示例账号&from=share',
  );
  assert.equal(result.kind, 'creator');
  assert.equal(result.userId, '示例账号');
  assert.match(result.canonicalUrl, /finderUsername=/);
});

test('canonicalizeInput accepts a single video share link', () => {
  const result = canonicalizeInput('https://weixin.qq.com/sph/AbCdEf123?scene=25');
  assert.equal(result.kind, 'share');
  assert.equal(result.shortCode, 'AbCdEf123');
  assert.equal(result.sourceUrl, 'https://weixin.qq.com/sph/AbCdEf123');
});

test('parseBrowserSnapshot keeps video covers and direct work links', () => {
  const result = parseBrowserSnapshot(
    {
      profile: {
        userId: 'finder-demo',
        nickname: '视频号作者',
        avatarUrl: 'https://img.example.com/finder-avatar.jpg',
      },
      works: [
        {
          objectId: 'object-demo-123',
          title: '第一条视频号内容',
          createTime: 1777000000,
          coverUrl: 'https://img.example.com/finder-cover.jpg',
          link: 'https://weixin.qq.com/sph/WorkShare123',
        },
      ],
    },
    'https://channels.weixin.qq.com/web/pages/profile?finderUsername=finder-demo',
  );
  assert.equal(result.nickname, '视频号作者');
  assert.equal(result.avatarUrl, 'https://img.example.com/finder-avatar.jpg');
  assert.equal(result.works[0].contentId, 'object-demo-123');
  assert.equal(result.works[0].link, 'https://weixin.qq.com/sph/WorkShare123');
  assert.equal(result.works[0].coverUrl, 'https://img.example.com/finder-cover.jpg');
});

test('parseBrowserSnapshot can retain a single public share without a creator id', () => {
  const result = parseBrowserSnapshot(
    {
      works: [
        {
          title: '单条视频号分享',
          link: 'https://weixin.qq.com/sph/WorkShare456',
        },
      ],
    },
    'https://weixin.qq.com/sph/WorkShare456',
  );
  assert.match(result.userId, /^share:https:\/\/weixin\.qq\.com\/sph\//);
  assert.equal(result.works[0].link, 'https://weixin.qq.com/sph/WorkShare456');
});
