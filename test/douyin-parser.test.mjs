import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalProfileUrl,
  canonicalizeInput,
  fetchProfile,
  parseBrowserSnapshot,
  parseProfileHtml,
  resolveReference,
} from '../src/douyin-parser.mjs';

const secUid =
  'MS4wLjABAAAAEEFwx4s0Y6ddV1Wvb7v_5jIavKjOMXfxUPLOb0cV_HR7PyYG1jAAewYbSuaXMpmL';
const canonicalUrl = canonicalProfileUrl(secUid);
const fixture = [
  '<title>星枢AI的抖音 - 抖音</title>',
  '<script type="application/json">',
  JSON.stringify({
    user: {
      nickname: '星枢AI',
      avatar_larger: {
        url_list: ['https://img.example.com/douyin-avatar.jpg'],
      },
    },
    aweme_list: [
      {
        aweme_id: '7550000000000000001',
        desc: 'AI 员工系统，让运营更轻松',
        create_time: 1777000000,
        statistics: { digg_count: 128 },
        video: {
          origin_cover: {
            url_list: ['https://p.example.com/cover-1.jpg'],
          },
        },
      },
    ],
  }),
  '</script>',
].join('');

test('canonicalizeInput accepts a Douyin profile URL and removes tracking params', () => {
  const result = canonicalizeInput(canonicalUrl + '?from_tab_name=main');
  assert.equal(result.kind, 'profile');
  assert.equal(result.secUid, secUid);
  assert.equal(result.sourceUrl, canonicalUrl);
  assert.equal(result.canonicalUrl, canonicalUrl);
});

test('canonicalizeInput accepts a Douyin share short link without retaining params', () => {
  const result = canonicalizeInput('https://v.douyin.com/abc123/?from=share');
  assert.equal(result.kind, 'short');
  assert.equal(result.shortCode, 'abc123');
  assert.equal(result.sourceUrl, 'https://v.douyin.com/abc123');
});

test('resolveReference follows a share link to a Douyin profile', async () => {
  const result = await resolveReference('https://v.douyin.com/abc123', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: canonicalUrl + '?from=share',
      text: async () => '<html></html>',
    }),
  });
  assert.equal(result.secUid, secUid);
  assert.equal(result.canonicalUrl, canonicalUrl);
});

test('parseProfileHtml extracts Douyin works, metrics and covers', () => {
  const result = parseProfileHtml(fixture, canonicalUrl, secUid);
  assert.equal(result.nickname, '星枢AI');
  assert.equal(result.avatarUrl, 'https://img.example.com/douyin-avatar.jpg');
  assert.equal(result.works.length, 1);
  assert.equal(result.works[0].title, 'AI 员工系统，让运营更轻松');
  assert.equal(result.works[0].contentId, '7550000000000000001');
  assert.equal(result.works[0].likes, '128');
  assert.equal(result.works[0].coverUrl, 'https://p.example.com/cover-1.jpg');
  assert.equal(
    result.works[0].link,
    'https://www.douyin.com/video/7550000000000000001',
  );
});

test('parseProfileHtml reports a platform security challenge instead of false success', () => {
  assert.throws(
    () =>
      parseProfileHtml(
        '<html><body></body><script>HNOJ@?RC _$jsvmprt</script></html>',
        canonicalUrl,
        secUid,
      ),
    /安全校验/,
  );
});

test('parseBrowserSnapshot returns an avatar and direct video link', () => {
  const result = parseBrowserSnapshot(
    {
      profile: {
        userId: secUid,
        nickname: '星枢AI',
        avatarUrl: 'https://img.example.com/browser-avatar.jpg',
      },
      works: [
        {
          contentId: '7550000000000000002',
          title: '浏览器补采到的抖音作品',
          createTime: 1777000000,
          coverUrl: 'https://img.example.com/browser-cover.jpg',
        },
      ],
    },
    canonicalUrl,
    secUid,
  );
  assert.equal(result.avatarUrl, 'https://img.example.com/browser-avatar.jpg');
  assert.equal(result.works[0].link, 'https://www.douyin.com/video/7550000000000000002');
  assert.equal(result.works[0].coverUrl, 'https://img.example.com/browser-cover.jpg');
});

test('parseBrowserSnapshot keeps ISO timestamps and sorts newest works first', () => {
  const result = parseBrowserSnapshot(
    {
      profile: { userId: secUid },
      works: [
        {
          contentId: '7550000000000000003',
          title: '较早的作品',
          publishedAt: '2026-08-01T10:00:00.000Z',
          position: 1,
        },
        {
          contentId: '7550000000000000004',
          title: '最新的作品',
          publishedAt: '2026-08-28T10:00:00.000Z',
          position: 0,
        },
      ],
    },
    canonicalUrl,
    secUid,
  );
  assert.equal(result.works[0].title, '最新的作品');
  assert.equal(result.works[0].publishedAt, '2026-08-28T10:00:00.000Z');
  assert.equal(result.works[1].position, 1);
});

test('fetchProfile routes browser mode to the desktop session', async () => {
  const result = await fetchProfile(canonicalUrl, {
    useBrowser: true,
    browserSession: {
      collectProfile: async (platform, input) => ({ platform, input, browserSnapshot: {} }),
    },
  });
  assert.deepEqual(result, { platform: 'douyin', input: canonicalUrl, browserSnapshot: {} });
});
