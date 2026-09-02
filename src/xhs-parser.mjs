import { createHash } from 'node:crypto';

const XHS_SHORT_HOSTS = new Set([
  'xhslink.cn',
  'www.xhslink.cn',
  'xhslink.com',
  'www.xhslink.com',
]);

const XHS_PROFILE_HOSTS = new Set([
  'xiaohongshu.com',
  'www.xiaohongshu.com',
]);

const USER_ID_PATTERN = /^[A-Za-z0-9]{24}$/;
const USER_ID_IN_URL = /\/user\/profile\/([A-Za-z0-9]{24})(?:[\/?#]|$)/i;

const REQUEST_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
};

export function canonicalProfileUrl(userId) {
  if (!USER_ID_PATTERN.test(userId)) {
    throw new Error('小红书用户 ID 格式不正确');
  }
  return 'https://www.xiaohongshu.com/user/profile/' + userId;
}

export function extractUserId(value) {
  if (!value) {
    return null;
  }

  const text = String(value);
  const match = text.match(USER_ID_IN_URL);
  if (match) {
    return match[1];
  }

  if (USER_ID_PATTERN.test(text.trim())) {
    return text.trim();
  }

  return null;
}

function cleanUrl(url) {
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function canonicalizeInput(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('请提供小红书主页或分享链接');
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
  const pathParts = url.pathname.split('/').filter(Boolean);

  if (XHS_SHORT_HOSTS.has(hostname)) {
    if (pathParts[0]?.toLowerCase() !== 'm' || !pathParts[1]) {
      throw new Error('不是可识别的小红书短链，短链格式应为 /m/短码');
    }

    const normalizedUrl = new URL('https://xhslink.cn/m/' + pathParts[1]);
    return {
      kind: 'short',
      sourceUrl: cleanUrl(normalizedUrl),
      shortCode: pathParts[1],
      userId: null,
      canonicalUrl: null,
    };
  }

  if (XHS_PROFILE_HOSTS.has(hostname)) {
    const userId = extractUserId(url.pathname);
    if (!userId) {
      throw new Error('没有从链接中识别出小红书用户 ID');
    }

    return {
      kind: 'profile',
      sourceUrl: cleanUrl(url),
      shortCode: null,
      userId,
      canonicalUrl: canonicalProfileUrl(userId),
    };
  }

  throw new Error('链接不是小红书主页或 xhslink.cn 分享短链');
}

function responseError(response, kind) {
  return new Error(kind + '请求失败（HTTP ' + response.status + '）');
}

function findUserIdInHtml(html) {
  return extractUserId(html.match(USER_ID_IN_URL)?.[0] ?? '') ?? extractUserId(html);
}

export async function resolveReference(input, options = {}) {
  const normalized = canonicalizeInput(input);
  if (normalized.kind === 'profile') {
    return {
      ...normalized,
      html: null,
    };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前 Node 环境没有可用的 fetch');
  }

  const response = await fetchImpl(normalized.sourceUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: REQUEST_HEADERS,
    signal: options.signal,
  });

  const html = await response.text();
  if (!response.ok) {
    throw responseError(response, '短链');
  }

  const userId = extractUserId(response.url) ?? findUserIdInHtml(html);
  if (!userId) {
    throw new Error('短链已打开，但没有识别出对应的小红书用户 ID');
  }

  return {
    ...normalized,
    userId,
    canonicalUrl: canonicalProfileUrl(userId),
    resolvedUrl: canonicalProfileUrl(userId),
    html,
  };
}

export async function fetchProfile(input, options = {}) {
  if (options.useBrowser) {
    if (typeof options.browserSession?.collectProfile !== 'function') {
      throw new Error('小红书浏览器补采仅在桌面客户端可用，请打开桌面版后重试');
    }
    let browserInput = input;
    try {
      const normalized = canonicalizeInput(input);
      if (normalized.kind === 'short') {
        const reference = await resolveReference(input, { ...options, useBrowser: false });
        browserInput = reference.canonicalUrl || input;
      }
    } catch {
      // The persistent browser can still resolve a short link with its own session.
    }
    return options.browserSession.collectProfile('xhs', browserInput, options);
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const reference = await resolveReference(input, { ...options, fetchImpl });

  if (reference.kind === 'profile' && reference.html && reference.html.length > 1000) {
    return reference;
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('当前 Node 环境没有可用的 fetch');
  }

  const response = await fetchImpl(reference.canonicalUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: REQUEST_HEADERS,
    signal: options.signal,
  });
  const html = await response.text();
  if (!response.ok) {
    throw responseError(response, '主页');
  }

  return {
    ...reference,
    html,
  };
}

function decodeJsonString(raw) {
  try {
    return JSON.parse('"' + raw + '"');
  } catch {
    return raw
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(value) {
  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>(\s*)/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function normalizeTimestamp(raw) {
  if (!raw) {
    return null;
  }
  const number = Number(raw);
  if (!Number.isFinite(number)) {
    return null;
  }
  const milliseconds = String(raw).length <= 10 ? number * 1000 : number;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeNoteId(value) {
  return value && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
}

function workLink(canonicalUrl, noteId) {
  return noteId
    ? 'https://www.xiaohongshu.com/explore/' + noteId
    : canonicalUrl;
}

function metricFromSegment(segment, keys) {
  for (const key of keys) {
    const pattern = new RegExp('"' + key + '"\\s*:\\s*"?([^",}]+)"?');
    const match = segment.match(pattern);
    if (match?.[1]) {
      return decodeJsonString(match[1]);
    }
  }
  return null;
}

function metricsFromSegment(segment) {
  const aliases = {
    read_count: ['viewCount', 'view_count', 'readCount', 'read_count', 'reads', '阅读', '阅读量'],
    like_count: ['likedCount', 'liked_count', 'likeCount', 'like_count', 'likes', '点赞', '点赞量'],
    favorite_count: ['collectedCount', 'collected_count', 'collectCount', 'collect_count', 'favorites', '收藏', '收藏量'],
    comment_count: ['commentCount', 'comment_count', 'comments', '评论', '评论量'],
    share_count: ['shareCount', 'share_count', 'shares', '分享', '分享量'],
    exposure_count: ['exposureCount', 'exposure_count', 'exposures', '曝光', '曝光量'],
  };
  const metrics = {};
  for (const [metricKey, keys] of Object.entries(aliases)) {
    const value = metricFromSegment(segment, keys);
    if (value !== null) {
      metrics[metricKey] = value;
    }
  }
  return metrics;
}

export function fingerprintForWork({ userId, title, publishedAt, noteId, coverUrl }) {
  const stableKey = noteId
    ? 'note:' + noteId
    : 'title:' + String(title ?? '').replace(/\s+/g, ' ').trim();
  return createHash('sha1')
    .update(
      [userId ?? '', stableKey].join('\u0000'),
    )
    .digest('hex');
}

function profileNameFromTitle(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!titleMatch) {
    return null;
  }
  const title = stripTags(titleMatch[1]).replace(/\s*-\s*小红书\s*$/, '').trim();
  return title && title !== '小红书' ? title : null;
}

function normalizeImageUrl(raw) {
  if (!raw) {
    return null;
  }
  let value = decodeJsonString(String(raw))
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
  if (value.startsWith('//')) {
    value = 'https:' + value;
  }
  return /^https?:\/\//i.test(value) ? value : null;
}

function avatarUrlFromHtml(html) {
  const patterns = [
    /"(?:avatar|avatarUrl|avatar_url|avatarLarger|avatar_larger|avatarThumb|avatar_thumb|userAvatar|user_avatar)"\s*:\s*"((?:\\.|[^"\\])*)"/gi,
    /"(?:avatar|avatarUrl|avatar_url|avatarLarger|avatar_larger|avatarThumb|avatar_thumb|userAvatar|user_avatar)"\s*:\s*\{[\s\S]{0,1000}?"(?:urlDefault|url_default|urlPre|url_pre|url|src)"\s*:\s*"((?:\\.|[^"\\])*)"/gi,
    /(?:class|id)=["'][^"']*(?:avatar|user-avatar|avatar-image)[^"']*["'][^>]*(?:src|data-src)=["']([^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const url = normalizeImageUrl(match[1]);
      if (url) {
        return url;
      }
    }
  }
  return null;
}

function extractEmbeddedWorks(html, canonicalUrl, userId) {
  const titleRegex = /"displayTitle":"((?:\\.|[^"\\])*)"/g;
  const titleMatches = [...html.matchAll(titleRegex)];
  const works = [];

  for (let index = 0; index < titleMatches.length; index += 1) {
    const match = titleMatches[index];
    const start = match.index ?? 0;
    const nextStart = titleMatches[index + 1]?.index ?? html.length;
    const end = Math.min(nextStart, start + 12000);
    const segment = html.slice(start, end);
    const title = decodeJsonString(match[1]).replace(/\s+/g, ' ').trim();
    const timestampMatch = segment.match(/"time"\s*:\s*"?([0-9]{10,13})"?/);
    const publishedAt = normalizeTimestamp(timestampMatch?.[1]);

    if (!title || !publishedAt) {
      continue;
    }

    const noteId = safeNoteId(segment.match(/"noteId"\s*:\s*"([^"]*)"/)?.[1] ?? '');
    const likes = segment.match(/"likedCount"\s*:\s*"([^"]*)"/)?.[1] ?? null;
    const metrics = metricsFromSegment(segment);
    const coverRaw = segment.match(/"urlDefault"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1] ?? null;
    const coverUrl = coverRaw ? decodeJsonString(coverRaw) : null;
    const fingerprint = fingerprintForWork({
      userId,
      title,
      publishedAt,
      noteId,
      coverUrl,
    });

    works.push({
      title,
      publishedAt,
      noteId,
      likes,
      metrics,
      coverUrl,
      link: workLink(canonicalUrl, noteId),
      fingerprint,
      extraction: 'embedded-profile-state',
    });
  }

  const unique = new Map();
  for (const work of works) {
    const key = work.title + '\u0000' + work.publishedAt;
    if (!unique.has(key)) {
      unique.set(key, work);
    }
  }

  return [...unique.values()]
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
    .slice(0, 30);
}

function extractVisibleTitles(html, canonicalUrl, userId) {
  const titleRegex =
    /<span[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
  const titles = [];
  for (const match of html.matchAll(titleRegex)) {
    const title = stripTags(match[1]);
    if (!title || title.length < 2 || title.length > 200) {
      continue;
    }
    titles.push({
      title,
      publishedAt: null,
      noteId: null,
      likes: null,
      metrics: {},
      coverUrl: null,
      link: canonicalUrl,
      fingerprint: fingerprintForWork({
        userId,
        title,
        publishedAt: null,
        noteId: null,
        coverUrl: null,
      }),
      extraction: 'visible-profile-html',
    });
  }

  const unique = new Map();
  for (const work of titles) {
    if (!unique.has(work.title)) {
      unique.set(work.title, work);
    }
  }
  return [...unique.values()].slice(0, 30);
}

export function parseProfileHtml(html, canonicalUrl, userId) {
  if (typeof html !== 'string' || !html) {
    throw new Error('主页返回内容为空');
  }

  const safeUserId = userId ?? extractUserId(canonicalUrl);
  if (!safeUserId) {
    throw new Error('缺少小红书用户 ID');
  }

  const embeddedWorks = extractEmbeddedWorks(html, canonicalUrl, safeUserId);
  const works =
    embeddedWorks.length > 0
      ? embeddedWorks
      : extractVisibleTitles(html, canonicalUrl, safeUserId);

  return {
    userId: safeUserId,
    nickname: profileNameFromTitle(html),
    avatarUrl: avatarUrlFromHtml(html),
    works,
    extraction:
      embeddedWorks.length > 0
        ? 'embedded-profile-state'
        : works.length > 0
          ? 'visible-profile-html'
          : 'no-public-works-found',
  };
}

export function parseBrowserSnapshot(snapshot, canonicalUrl, userId = null) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('小红书浏览器会话没有返回页面数据');
  }
  const snapshotUserId = snapshot.profile?.userId || snapshot.userId;
  const safeUserId =
    extractUserId(canonicalUrl) ||
    [snapshotUserId, userId].find((candidate) => USER_ID_PATTERN.test(String(candidate || '').trim())) ||
    null;
  if (!safeUserId) {
    throw new Error('浏览器会话没有识别出小红书用户 ID');
  }

  const works = Array.isArray(snapshot.works)
    ? snapshot.works
        .map((work) => {
          const title = String(work?.title || '').replace(/\s+/g, ' ').trim();
          if (!title) {
            return null;
          }
          const noteId = safeNoteId(work.contentId || work.noteId || work.note_id || '');
          const publishedAt = normalizeTimestamp(work.publishedAt || work.publishTime || work.createTime);
          const coverUrl = normalizeImageUrl(work.coverUrl || work.cover_url || '');
          return {
            title,
            publishedAt,
            noteId,
            likes: work.likes || null,
            metrics: work.metrics || {},
            coverUrl,
            link: work.link && /^https?:\/\//i.test(work.link)
              ? work.link
              : workLink(canonicalUrl, noteId),
            fingerprint: fingerprintForWork({
              userId: safeUserId,
              title,
              publishedAt,
              noteId,
              coverUrl,
            }),
            extraction: 'browser-session',
          };
        })
        .filter(Boolean)
    : [];

  const unique = new Map();
  for (const work of works) {
    const key = work.noteId || work.title + '\u0000' + (work.publishedAt || '');
    if (!unique.has(key)) {
      unique.set(key, work);
    }
  }
  if (!unique.size) {
    throw new Error(
      '小红书浏览器会话没有读取到作品；请确认页面已加载并完成登录或人工验证',
    );
  }

  return {
    userId: safeUserId,
    nickname: snapshot.profile?.nickname || snapshot.nickname || null,
    avatarUrl: normalizeImageUrl(snapshot.profile?.avatarUrl || snapshot.avatarUrl || ''),
    works: [...unique.values()]
      .sort((left, right) => (right.publishedAt || '').localeCompare(left.publishedAt || ''))
      .slice(0, 50),
    extraction: 'browser-session',
  };
}

export { REQUEST_HEADERS };
