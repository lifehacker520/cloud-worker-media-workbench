import { createHash } from 'node:crypto';

const DOUYIN_PROFILE_HOSTS = new Set([
  'douyin.com',
  'www.douyin.com',
]);

const DOUYIN_SHORT_HOSTS = new Set([
  'v.douyin.com',
  'www.douyin.com',
]);

const SEC_UID_PATTERN = /^[A-Za-z0-9_-]{10,256}$/;

const REQUEST_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
  referer: 'https://www.douyin.com/',
};

export function canonicalProfileUrl(secUid) {
  if (!SEC_UID_PATTERN.test(secUid)) {
    throw new Error('抖音用户主页 ID 格式不正确');
  }
  return 'https://www.douyin.com/user/' + secUid;
}

export function extractSecUid(value) {
  if (!value) {
    return null;
  }

  const text = String(value);
  const match = text.match(/\/user\/([A-Za-z0-9_-]{10,256})(?:[/?#]|$)/i);
  if (match && SEC_UID_PATTERN.test(match[1])) {
    return match[1];
  }

  const queryMatch = text.match(/[?&]sec_uid=([A-Za-z0-9_-]{10,256})/i);
  if (queryMatch && SEC_UID_PATTERN.test(queryMatch[1])) {
    return queryMatch[1];
  }

  return SEC_UID_PATTERN.test(text.trim()) ? text.trim() : null;
}

function cleanUrl(url) {
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function canonicalizeInput(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('请提供抖音主页或分享链接');
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

  if (DOUYIN_SHORT_HOSTS.has(hostname) && hostname === 'v.douyin.com') {
    if (!pathParts[0]) {
      throw new Error('不是可识别的抖音分享短链');
    }
    return {
      kind: 'short',
      sourceUrl: cleanUrl(url),
      shortCode: pathParts[0],
      secUid: null,
      userId: null,
      canonicalUrl: null,
    };
  }

  if (DOUYIN_PROFILE_HOSTS.has(hostname)) {
    if (pathParts[0]?.toLowerCase() !== 'user' || !pathParts[1]) {
      throw new Error('不是可识别的抖音主页，主页格式应为 /user/用户 ID');
    }

    const secUid = decodeURIComponent(pathParts[1]);
    if (!SEC_UID_PATTERN.test(secUid)) {
      throw new Error('没有从链接中识别出抖音用户 ID');
    }

    return {
      kind: 'profile',
      sourceUrl: cleanUrl(url),
      shortCode: null,
      secUid,
      userId: secUid,
      canonicalUrl: canonicalProfileUrl(secUid),
    };
  }

  throw new Error('链接不是抖音主页或 v.douyin.com 分享短链');
}

function responseError(response, kind) {
  return new Error(kind + '请求失败（HTTP ' + response.status + '）');
}

function findSecUidInHtml(html) {
  return extractSecUid(html);
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

  const secUid = extractSecUid(response.url) ?? findSecUidInHtml(html);
  if (!secUid) {
    throw new Error('抖音短链已打开，但没有识别出对应的用户 ID');
  }

  return {
    ...normalized,
    secUid,
    userId: secUid,
    canonicalUrl: canonicalProfileUrl(secUid),
    resolvedUrl: canonicalProfileUrl(secUid),
    html,
  };
}

export async function fetchProfile(input, options = {}) {
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
      .replace(/\\\\/g, '\\')
      .replace(/\\\//g, '/');
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
  if (raw === null || raw === undefined || raw === '') {
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

function safeContentId(value) {
  const text = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(text) ? text : null;
}

function workLink(contentId, canonicalUrl) {
  return contentId
    ? 'https://www.douyin.com/video/' + contentId
    : canonicalUrl;
}

export function fingerprintForWork({ secUid, title, contentId, publishedAt, coverUrl }) {
  const stableKey = contentId
    ? 'video:' + contentId
    : 'title:' + String(title ?? '').replace(/\s+/g, ' ').trim();
  return createHash('sha1')
    .update(['douyin', secUid ?? '', stableKey].join('\u0000'))
    .digest('hex');
}

function valueFromObject(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function firstUrl(value) {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = firstUrl(item);
      if (result) {
        return result;
      }
    }
  }
  if (value && typeof value === 'object') {
    for (const key of ['url_list', 'urlList', 'url', 'src', 'uri']) {
      const result = firstUrl(value[key]);
      if (result) {
        return result;
      }
    }
  }
  return null;
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

function avatarUrlFromValue(value, depth = 0) {
  if (!value || depth > 8) {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = avatarUrlFromValue(item, depth + 1);
      if (url) {
        return url;
      }
    }
    return null;
  }
  if (typeof value !== 'object') {
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    if (/avatar/i.test(key)) {
      const url = normalizeImageUrl(firstUrl(child));
      if (url) {
        return url;
      }
    }
  }
  for (const child of Object.values(value)) {
    const url = avatarUrlFromValue(child, depth + 1);
    if (url) {
      return url;
    }
  }
  return null;
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

function coverFromObject(object) {
  return firstUrl(
    object?.coverUrl ||
      object?.cover_url ||
      object?.cover ||
      object?.video?.origin_cover ||
      object?.video?.cover ||
      object?.video?.dynamic_cover ||
      object?.video?.coverUrl,
  );
}

function likesFromObject(object) {
  const statistics = object?.statistics || object?.stats || object?.statisticsInfo;
  return valueFromObject(statistics, ['digg_count', 'like_count', 'liked_count'])
    || valueFromObject(object, ['digg_count', 'like_count', 'liked_count']);
}

function createWork(object, canonicalUrl, secUid) {
  if (!object || typeof object !== 'object') {
    return null;
  }

  const contentId = safeContentId(
    valueFromObject(object, ['aweme_id', 'awemeId', 'item_id', 'itemId', 'video_id', 'videoId']),
  );
  const title = valueFromObject(object, ['desc', 'description', 'title', 'text']);
  if (!contentId || !title) {
    return null;
  }

  const publishedAt = normalizeTimestamp(
    valueFromObject(object, ['create_time', 'createTime', 'publish_time', 'publishedAt']),
  );
  const coverUrl = coverFromObject(object);
  return {
    title: title.replace(/\s+/g, ' ').trim(),
    publishedAt,
    contentId,
    noteId: contentId,
    likes: likesFromObject(object),
    coverUrl,
    link: workLink(contentId, canonicalUrl),
    fingerprint: fingerprintForWork({ secUid, title, contentId, publishedAt, coverUrl }),
    extraction: 'embedded-profile-state',
  };
}

function parseJsonScripts(html) {
  const values = [];
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRegex)) {
    const raw = match[1].trim();
    if (!raw || raw.length < 2) {
      continue;
    }

    const candidates = [raw];
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(raw.slice(firstBrace, lastBrace + 1));
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') {
          values.push(parsed);
          break;
        }
      } catch {
        // Most regular script blocks are not JSON. Regex fallback handles those.
      }
    }
  }
  return values;
}

function extractObjectWorks(value, canonicalUrl, secUid, works, seen, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 9 || seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      extractObjectWorks(item, canonicalUrl, secUid, works, seen, depth + 1);
    }
    return;
  }

  const work = createWork(value, canonicalUrl, secUid);
  if (work) {
    works.push(work);
  }

  for (const child of Object.values(value)) {
    extractObjectWorks(child, canonicalUrl, secUid, works, seen, depth + 1);
  }
}

function matchFirst(pattern, segment) {
  const match = segment.match(pattern);
  return match ? decodeJsonString(match[1]) : null;
}

function extractRegexWorks(html, canonicalUrl, secUid) {
  const idRegex = /"(?:aweme_id|awemeId|item_id|itemId|video_id|videoId)"\s*:\s*"([^"\\]+)"/g;
  const works = [];
  const matches = [...html.matchAll(idRegex)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const contentId = safeContentId(match[1]);
    if (!contentId) {
      continue;
    }
    const start = Math.max(0, (match.index ?? 0) - 2200);
    const end = Math.min(
      html.length,
      Math.max(match.index ?? 0, matches[index + 1]?.index ?? html.length) + 7000,
    );
    const segment = html.slice(start, end);
    const title = matchFirst(/"(?:desc|description|title|text)"\s*:\s*"((?:\\.|[^"\\])*)"/, segment);
    if (!title) {
      continue;
    }
    const timestampRaw = matchFirst(
      /"(?:create_time|createTime|publish_time|publishedAt)"\s*:\s*"?([0-9]{10,13})"?/,
      segment,
    );
    const publishedAt = normalizeTimestamp(timestampRaw);
    const coverRaw = matchFirst(
      /"(?:origin_cover|cover_url|coverUrl|url_default|urlDefault)"[\s\S]{0,1800}?"(?:url_list|urlList|url|src)"\s*:\s*(?:\[\s*)?"((?:\\.|[^"\\])*)"/,
      segment,
    );
    const coverUrl = coverRaw ? coverRaw.replace(/\\\//g, '/') : null;
    works.push({
      title: title.replace(/\s+/g, ' ').trim(),
      publishedAt,
      contentId,
      noteId: contentId,
      likes: matchFirst(/"(?:digg_count|like_count|liked_count)"\s*:\s*"?([^",}]+)"?/, segment),
      coverUrl,
      link: workLink(contentId, canonicalUrl),
      fingerprint: fingerprintForWork({ secUid, title, contentId, publishedAt, coverUrl }),
      extraction: 'embedded-profile-state',
    });
  }

  return works;
}

function profileNameFromHtml(html) {
  const metaMatch = html.match(/<meta[^>]+(?:property|name)=["'](?:og:title|title)["'][^>]+content=["']([^"']+)["']/i);
  if (metaMatch) {
    return stripTags(metaMatch[1])
      .replace(/\s*(?:的抖音\s*-\s*抖音|的抖音|-\s*抖音)\s*$/i, '')
      .trim() || null;
  }

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!titleMatch) {
    return null;
  }
  return stripTags(titleMatch[1])
    .replace(/\s*(?:的抖音\s*-\s*抖音|的抖音|-\s*抖音)\s*$/i, '')
    .trim() || null;
}

function dedupeWorks(works) {
  const unique = new Map();
  for (const work of works) {
    const key = work.contentId || work.title + '\u0000' + (work.publishedAt || '');
    if (!unique.has(key)) {
      unique.set(key, work);
    }
  }
  return [...unique.values()]
    .sort((left, right) => (right.publishedAt || '').localeCompare(left.publishedAt || ''))
    .slice(0, 30);
}

function looksLikeSecurityChallenge(html) {
  return /HNOJ@\?RC|_\$jsvmprt|安全验证|verify\s*challenge/i.test(html);
}

export function parseProfileHtml(html, canonicalUrl, secUid = extractSecUid(canonicalUrl)) {
  if (typeof html !== 'string' || !html) {
    throw new Error('抖音主页返回内容为空');
  }
  if (!secUid) {
    throw new Error('缺少抖音用户 ID');
  }

  const scripts = parseJsonScripts(html);
  const avatarUrl =
    scripts.map((value) => avatarUrlFromValue(value)).find(Boolean) ||
    avatarUrlFromHtml(html);
  const works = [];
  const seen = new Set();
  for (const value of scripts) {
    extractObjectWorks(value, canonicalUrl, secUid, works, seen);
  }
  extractRegexWorks(html, canonicalUrl, secUid).forEach((work) => works.push(work));
  const uniqueWorks = dedupeWorks(works);

  if (uniqueWorks.length === 0 && looksLikeSecurityChallenge(html)) {
    throw new Error(
      '抖音主页触发了安全校验，当前公开 HTML 采集器无法读取作品；请后续改用浏览器会话采集或官方授权接口',
    );
  }

  return {
    userId: secUid,
    secUid,
    nickname: profileNameFromHtml(html),
    avatarUrl,
    works: uniqueWorks,
    extraction:
      uniqueWorks.length > 0
        ? 'embedded-profile-state'
        : 'no-public-works-found',
  };
}

export { REQUEST_HEADERS };
