import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  detectDownloadSource,
  isAllowedMediaUrl,
  normalizeDownloadMedia,
} from '../src/download-center.mjs';

test('download center identifies supported work links and rejects non-work pages', () => {
  assert.deepEqual(detectDownloadSource('https://www.xiaohongshu.com/explore/65f123456789abcdef012345?x=1'), {
    platform: 'xhs',
    platformLabel: '小红书',
    sourceUrl: 'https://www.xiaohongshu.com/explore/65f123456789abcdef012345',
    canonicalUrl: 'https://www.xiaohongshu.com/explore/65f123456789abcdef012345',
    contentId: '65f123456789abcdef012345',
    linkKind: 'content',
  });
  assert.equal(detectDownloadSource('https://xhslink.com/m/Abc_1234').platform, 'xhs');
  assert.equal(detectDownloadSource('https://www.douyin.com/video/7345678901234567890').platform, 'douyin');
  assert.equal(detectDownloadSource('https://v.douyin.com/Abc_1234').linkKind, 'share');
  assert.equal(detectDownloadSource('https://weixin.qq.com/sph/Abc_1234').platform, 'channels');
  assert.equal(detectDownloadSource('https://channels.weixin.qq.com/finder-preview/pages/sph?id=Abc_1234').contentId, 'Abc_1234');

  for (const input of [
    'http://www.douyin.com/video/7345678901234567890',
    'https://www.xiaohongshu.com/user/profile/123456',
    'https://www.douyin.com/discover',
    'https://evil.example/video/7345678901234567890',
  ]) {
    assert.throws(() => detectDownloadSource(input));
  }
});

test('download center only exposes approved direct media URLs', () => {
  const normalized = normalizeDownloadMedia({
    title: '视频号测试作品',
    author: '作者',
    nested: {
      video_url: 'https://finder.video.qq.com/251/20350/stodownload?encfilekey=test',
      cover_url: 'https://qpic.cn/cover/test.jpg',
      image_urls: [
        'https://wximg.com/image/1.jpg',
        'https://not-allowed.example/image/2.jpg',
      ],
      h265_url: 'https://finder.video.qq.com/251/20350/stodownload/test.mp4',
    },
  }, 'channels');

  assert.equal(normalized.videoUrl, 'https://finder.video.qq.com/251/20350/stodownload?encfilekey=test');
  assert.equal(normalized.coverUrl, 'https://qpic.cn/cover/test.jpg');
  assert.deepEqual(normalized.imageUrls, ['https://wximg.com/image/1.jpg']);
  assert.equal(normalized.codec, 'H.265');
  assert.equal(isAllowedMediaUrl('https://finder.video.qq.com/video.m3u8', 'channels', 'video'), false);
  assert.equal(isAllowedMediaUrl('https://not-allowed.example/video.mp4', 'channels', 'video'), false);
  assert.throws(() => normalizeDownloadMedia({ videoUrl: 'https://not-allowed.example/video.mp4' }, 'channels'));

  const imageOnly = normalizeDownloadMedia({ images: ['https://qpic.cn/cover/image-only.jpg'] }, 'channels');
  assert.equal(imageOnly.coverUrl, 'https://qpic.cn/cover/image-only.jpg');
  assert.deepEqual(imageOnly.imageUrls, []);
});

test('download center extracts Douyin playback URLs from nested aweme video payloads', () => {
  const normalized = normalizeDownloadMedia({
    aweme_detail: {
      desc: '抖音测试视频',
      author: { nickname: '测试作者' },
      video: {
        play_addr: {
          uri: 'https://v3-web.douyinvod.com/aweme/demo/playwm/demo.mp4',
          url_list: ['https://v3-web.douyinvod.com/aweme/demo/playwm/demo.mp4'],
        },
        origin_cover: {
          url_list: ['https://p3.douyinpic.com/aweme/demo/cover.jpeg'],
        },
      },
    },
  }, 'douyin');

  assert.equal(normalized.title, '抖音测试视频');
  assert.equal(normalized.author, '测试作者');
  assert.equal(normalized.videoUrl, 'https://v3-web.douyinvod.com/aweme/demo/play/demo.mp4');
  assert.equal(normalized.coverUrl, 'https://p3.douyinpic.com/aweme/demo/cover.jpeg');
});
