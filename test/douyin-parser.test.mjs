import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalProfileUrl,
  canonicalizeInput,
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
    user: { nickname: '星枢AI' },
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
    /安全校验页面/,
  );
});
