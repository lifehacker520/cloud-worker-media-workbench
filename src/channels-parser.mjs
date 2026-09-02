import { createHash } from 'node:crypto';

const WECHAT_HOSTS = new Set(['weixin.qq.com', 'www.weixin.qq.com']);
const CHANNELS_HOSTS = new Set(['channels.weixin.qq.com']);
const FINDER_HOSTS = new Set(['finder.video.qq.com']);
const SHARE_PATH_PATTERN = /^\/sph\/([^/?#]+)/i;

function cleanUrl(url) {
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function validHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim())
    ? value.trim()
    : null;
}

function firstUrl(value) {
  if (typeof value === 'string') {
    return validHttpUrl(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstUrl(item);
      if (url) {
        return url;
      }
    }
  }
  if (value && typeof value === 'object') {
    for (const key of ['url', 'url_list', 'urlList', 'src', 'cover_url']) {
      const url = firstUrl(value[key]);
      if (url) {
        return url;
      }
    }
  }
  return null;
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const milliseconds = String(value).length <= 10 ? number * 1000 : number;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizePosition(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function textValue(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function workId(value) {
  const text = textValue(value);
  return text && /^[A-Za-z0-9_@:-]{6,180}$/.test(text) ? text : null;
}

function workLink(work, fallback) {
  const direct = validHttpUrl(work?.link || work?.url || work?.shareUrl);
  return direct || fallback;
}

function metricsFromWork(work) {
  const statistics = [work?.statistics, work?.stats, work?.statisticsInfo, work?.statistics_info]
    .filter((item) => item && typeof item === 'object');
  const source = Object.assign({}, work, ...statistics);
  const aliases = {
    play_count: ['playCount', 'play_count', 'plays', 'play', '播放', '播放量'],
    like_count: ['likes', 'likeCount', 'like_count', 'diggCount', '点赞', '点赞量'],
    favorite_count: ['favorites', 'favoriteCount', 'favorite_count', 'collectCount', '收藏', '收藏量'],
    comment_count: ['comments', 'commentCount', 'comment_count', '评论', '评论量'],
    share_count: ['shares', 'shareCount', 'share_count', '分享', '分享量'],
    exposure_count: ['exposureCount', 'exposure_count', 'exposures', '曝光', '曝光量'],
  };
  const metrics = {};
  for (const [metricKey, keys] of Object.entries(aliases)) {
    const value = keys.map((key) => source[key]).find((candidate) => candidate !== null && candidate !== undefined && candidate !== '');
    if (value !== undefined) {
      metrics[metricKey] = value;
    }
  }
  return metrics;
}

export function canonicalizeInput(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('请提供视频号主页、创作者助手或作品分享链接');
  }

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('链接格式不正确，请粘贴 http(s) 链接');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('只支持 http(s) 链接');
  }

  const hostname = url.hostname.toLowerCase();
  const shareMatch = url.pathname.match(SHARE_PATH_PATTERN);
  if (WECHAT_HOSTS.has(hostname) && shareMatch?.[1]) {
    const normalizedUrl = new URL('https://weixin.qq.com/sph/' + shareMatch[1]);
    return {
      kind: 'share',
      sourceUrl: cleanUrl(normalizedUrl),
      shortCode: shareMatch[1],
      userId: null,
      canonicalUrl: cleanUrl(normalizedUrl),
    };
  }

  if (CHANNELS_HOSTS.has(hostname)) {
    const finderUsername = textValue(url.searchParams.get('finderUsername'));
    return {
      kind: 'creator',
      sourceUrl: url.toString().replace(/#.*$/, '').replace(/\/$/, ''),
      shortCode: null,
      userId: finderUsername,
      canonicalUrl: url.toString().replace(/#.*$/, '').replace(/\/$/, ''),
    };
  }

  if (FINDER_HOSTS.has(hostname)) {
    return {
      kind: 'share',
      sourceUrl: cleanUrl(url),
      shortCode: null,
      userId: null,
      canonicalUrl: cleanUrl(url),
    };
  }

  throw new Error('链接不是视频号分享链接或创作者助手地址');
}

export function fingerprintForWork({ userId, title, contentId, publishedAt }) {
  const stableKey = contentId
    ? 'video:' + contentId
    : 'title:' + String(title ?? '').replace(/\s+/g, ' ').trim();
  return createHash('sha1')
    .update(['channels', userId ?? '', stableKey, publishedAt ?? ''].join('\u0000'))
    .digest('hex');
}

function normalizeWork(work, fallbackUrl, userId) {
  const title = textValue(work?.title || work?.description || work?.desc || work?.text);
  if (!title) {
    return null;
  }
  const contentId = workId(
    work?.contentId ||
      work?.objectId ||
      work?.object_id ||
      work?.objectNonceId ||
      work?.object_nonce_id ||
      work?.id,
  );
  const publishedAt = normalizeTimestamp(
    work?.publishedAt || work?.published_at || work?.pubTime || work?.pub_time || work?.createTime || work?.create_time,
  );
  const coverUrl = firstUrl(work?.coverUrl || work?.cover_url || work?.cover || work?.images);
  const link = workLink(work, fallbackUrl);
  return {
    title,
    publishedAt,
    contentId,
    noteId: contentId,
    likes: textValue(work?.likes || work?.likeCount || work?.like_count),
    metrics: metricsFromWork(work),
    coverUrl,
    link,
    isPinned: Boolean(work?.isPinned || work?.pinned),
    position: normalizePosition(work?.position),
    fingerprint: fingerprintForWork({ userId, title, contentId, publishedAt }),
    extraction: 'browser-session',
  };
}

export async function fetchProfile(input, options = {}) {
  if (typeof options.browserSession?.collectProfile !== 'function') {
    throw new Error(
      '视频号没有可供服务端轮询的公开他人主页接口；请在桌面客户端打开微信会话，或粘贴单条视频号分享链接进行补采',
    );
  }
  return options.browserSession.collectProfile('channels', input, options);
}

export function parseBrowserSnapshot(snapshot, canonicalUrl, userId = null) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('视频号浏览器会话没有返回页面数据');
  }
  const resolvedUserId = textValue(
    snapshot.profile?.userId ||
      snapshot.userId ||
      userId ||
      (canonicalUrl ? 'share:' + canonicalUrl : null),
  );
  const works = Array.isArray(snapshot.works)
    ? snapshot.works
        .map((work) => normalizeWork(work, canonicalUrl, resolvedUserId))
        .filter(Boolean)
    : [];
  if (!works.length) {
    throw new Error(
      '视频号浏览器会话没有读取到作品；请确认微信已登录，并打开创作者助手的作品列表或一条公开分享链接',
    );
  }

  const unique = new Map();
  for (const work of works) {
    const key = work.contentId || work.title + '\u0000' + (work.publishedAt || '');
    if (!unique.has(key)) {
      unique.set(key, work);
    }
  }

  return {
    userId: resolvedUserId,
    nickname: textValue(snapshot.profile?.nickname || snapshot.nickname),
    avatarUrl: firstUrl(snapshot.profile?.avatarUrl || snapshot.avatarUrl),
    works: [...unique.values()]
      .sort((left, right) => (right.publishedAt || '').localeCompare(left.publishedAt || ''))
      .slice(0, 50),
    extraction: 'browser-session',
  };
}

export function parseProfileHtml() {
  throw new Error(
    '视频号不支持通过公开 HTML 读取他人作品；请使用桌面客户端浏览器会话采集',
  );
}
