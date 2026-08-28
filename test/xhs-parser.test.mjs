import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalProfileUrl,
  canonicalizeInput,
  fingerprintForWork,
  parseProfileHtml,
  resolveReference,
} from '../src/xhs-parser.mjs';

const userId = '6a043b3d0000000002002000';
const canonicalUrl = canonicalProfileUrl(userId);
const fixture = [
  '<title>今天也在上班 - 小红书</title>',
  '<script>',
  '{"avatar":"https://img.example.com/xhs-avatar.jpg"},',
  '{"displayTitle":"第二篇内容","time":1777000000000,"noteId":"","likedCount":"18"},',
  '{"displayTitle":"第一篇内容","time":1776000000000,"noteId":"65abcdef12345678","likedCount":"9"}',
  '</script>',
].join('');

test('canonicalizeInput strips temporary profile query parameters', () => {
  const result = canonicalizeInput(
    'https://www.xiaohongshu.com/user/profile/' + userId + '?xsec_token=secret&xsec_source=app_share',
  );
  assert.equal(result.kind, 'profile');
  assert.equal(result.userId, userId);
  assert.equal(result.sourceUrl, canonicalUrl);
  assert.equal(result.canonicalUrl, canonicalUrl);
});

test('canonicalizeInput keeps a short-code source without storing a token', () => {
  const result = canonicalizeInput('https://xhslink.cn/m/7gaup7QcqSc?xsec_token=secret');
  assert.equal(result.kind, 'short');
  assert.equal(result.shortCode, '7gaup7QcqSc');
  assert.equal(result.sourceUrl, 'https://xhslink.cn/m/7gaup7QcqSc');
});

test('resolveReference reads the user id from a followed short link', async () => {
  const result = await resolveReference('https://xhslink.cn/m/7gaup7QcqSc', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: canonicalUrl + '?xsec_token=temporary',
      text: async () => fixture,
    }),
  });
  assert.equal(result.userId, userId);
  assert.equal(result.canonicalUrl, canonicalUrl);
  assert.equal(result.sourceUrl, 'https://xhslink.cn/m/7gaup7QcqSc');
});

test('parseProfileHtml extracts recent titles, times, likes and stable links', () => {
  const result = parseProfileHtml(fixture, canonicalUrl, userId);
  assert.equal(result.nickname, '今天也在上班');
  assert.equal(result.avatarUrl, 'https://img.example.com/xhs-avatar.jpg');
  assert.equal(result.extraction, 'embedded-profile-state');
  assert.equal(result.works.length, 2);
  assert.equal(result.works[0].title, '第二篇内容');
  assert.equal(result.works[0].likes, '18');
  assert.equal(result.works[0].noteId, null);
  assert.equal(result.works[0].link, canonicalUrl);
  assert.equal(result.works[1].title, '第一篇内容');
  assert.equal(result.works[1].noteId, '65abcdef12345678');
  assert.equal(result.works[1].link, 'https://www.xiaohongshu.com/explore/65abcdef12345678');
  assert.match(result.works[0].publishedAt, /^2026-/);
});

test('fingerprint stays stable when a title-only work receives a different timestamp', () => {
  const first = fingerprintForWork({
    userId,
    title: '同一个标题',
    publishedAt: '2026-08-01T10:00:00.000Z',
    noteId: null,
  });
  const second = fingerprintForWork({
    userId,
    title: '同一个标题',
    publishedAt: '2026-08-02T10:00:00.000Z',
    noteId: null,
  });
  assert.equal(first, second);
});
