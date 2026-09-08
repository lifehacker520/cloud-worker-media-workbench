const PLATFORM_DEFINITIONS = {
  xhs: {
    label: '小红书',
    resolverEnv: 'XHS_DOWNLOAD_RESOLVER_URL',
    mediaHosts: ['xiaohongshu.com', 'xhscdn.com', 'xhslink.com'],
  },
  douyin: {
    label: '抖音',
    resolverEnv: 'DOUYIN_DOWNLOAD_RESOLVER_URL',
    mediaHosts: [
      'douyin.com',
      'douyincdn.com',
      'douyinvod.com',
      'byteimg.com',
      'ibytedtos.com',
      'zijieapi.com',
      'snssdk.com',
    ],
  },
  channels: {
    label: '视频号',
    resolverEnv: 'WEIXIN_RESOLVER_URL',
    mediaHosts: ['finder.video.qq.com', 'qpic.cn', 'wximg.com', 'weixin.qq.com'],
    defaultResolver: 'https://v.mtotech.com/api/resolve',
  },
};

const GENERIC_RESOLVER_ENV = 'MEDIA_DOWNLOAD_RESOLVER_URL';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{4,120}$/;
const CONTENT_ID_PATTERN = /^[A-Za-z0-9_-]{6,120}$/;

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isHttpsUrl(value) {
  return typeof value === 'string' && /^https:\/\//i.test(value.trim());
}

function hostMatches(hostname, allowedHosts) {
  const host = String(hostname || '').toLowerCase();
  return allowedHosts.some((allowed) => host === allowed || host.endsWith('.' + allowed));
}

function parseHttpsUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw downloadError('DOWNLOAD_LINK_REQUIRED', '请粘贴小红书、抖音或视频号作品链接');
  }
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw downloadError('DOWNLOAD_LINK_INVALID', '链接格式不正确，请粘贴完整的 HTTPS 链接');
  }
  if (url.protocol !== 'https:') {
    throw downloadError('DOWNLOAD_LINK_INVALID', '下载中心只接受 HTTPS 平台链接');
  }
  return url;
}

function cleanUrl(url) {
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function downloadError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function detectDownloadSource(input) {
  const url = parseHttpsUrl(input);
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'xiaohongshu.com' || host === 'www.xiaohongshu.com') {
    const isExplore = parts[0]?.toLowerCase() === 'explore';
    const isDiscoveryItem = parts[0]?.toLowerCase() === 'discovery' && parts[1]?.toLowerCase() === 'item';
    const id = isExplore ? parts[1] : isDiscoveryItem ? parts[2] : null;
    if (!id || !CONTENT_ID_PATTERN.test(id)) {
      throw downloadError('DOWNLOAD_LINK_UNSUPPORTED', '请粘贴小红书具体笔记链接，例如 /explore/笔记ID');
    }
    return {
      platform: 'xhs',
      platformLabel: PLATFORM_DEFINITIONS.xhs.label,
      sourceUrl: cleanUrl(url),
      canonicalUrl: 'https://www.xiaohongshu.com/explore/' + id,
      contentId: id,
      linkKind: 'content',
    };
  }

  if (host === 'xhslink.cn' || host === 'www.xhslink.cn' || host === 'xhslink.com' || host === 'www.xhslink.com') {
    const code = parts[0]?.toLowerCase() === 'm' ? parts[1] : null;
    if (!code || !TOKEN_PATTERN.test(code)) {
      throw downloadError('DOWNLOAD_LINK_UNSUPPORTED', '请粘贴可识别的小红书分享短链');
    }
    return {
      platform: 'xhs',
      platformLabel: PLATFORM_DEFINITIONS.xhs.label,
      sourceUrl: 'https://' + host + '/m/' + code,
      canonicalUrl: 'https://' + host + '/m/' + code,
      contentId: null,
      linkKind: 'share',
    };
  }

  if (host === 'douyin.com' || host === 'www.douyin.com') {
    if (parts[0]?.toLowerCase() !== 'video' || !parts[1] || !/^\d{8,}$/.test(parts[1])) {
      throw downloadError('DOWNLOAD_LINK_UNSUPPORTED', '请粘贴抖音具体视频链接，例如 /video/视频ID');
    }
    return {
      platform: 'douyin',
      platformLabel: PLATFORM_DEFINITIONS.douyin.label,
      sourceUrl: 'https://www.douyin.com/video/' + parts[1],
      canonicalUrl: 'https://www.douyin.com/video/' + parts[1],
      contentId: parts[1],
      linkKind: 'content',
    };
  }

  if (host === 'v.douyin.com') {
    const code = parts[0];
    if (!code || !TOKEN_PATTERN.test(code)) {
      throw downloadError('DOWNLOAD_LINK_UNSUPPORTED', '请粘贴可识别的抖音分享短链');
    }
    return {
      platform: 'douyin',
      platformLabel: PLATFORM_DEFINITIONS.douyin.label,
      sourceUrl: 'https://v.douyin.com/' + code,
      canonicalUrl: 'https://v.douyin.com/' + code,
      contentId: null,
      linkKind: 'share',
    };
  }

  if (host === 'weixin.qq.com' || host === 'www.weixin.qq.com') {
    const token = parts[0]?.toLowerCase() === 'sph' ? parts[1] : null;
    if (!token || !TOKEN_PATTERN.test(token)) {
      throw downloadError('DOWNLOAD_LINK_UNSUPPORTED', '请粘贴形如 weixin.qq.com/sph/... 的视频号分享链接');
    }
    return {
      platform: 'channels',
      platformLabel: PLATFORM_DEFINITIONS.channels.label,
      sourceUrl: 'https://weixin.qq.com/sph/' + token,
      canonicalUrl: 'https://weixin.qq.com/sph/' + token,
      contentId: token,
      linkKind: 'share',
    };
  }

  if (host === 'channels.weixin.qq.com' && /\/finder-preview\/pages\/sph\/?$/i.test(url.pathname)) {
    const token = url.searchParams.get('id') || '';
    if (!TOKEN_PATTERN.test(token)) {
      throw downloadError('DOWNLOAD_LINK_UNSUPPORTED', '视频号 finder-preview 链接缺少有效的作品 ID');
    }
    return {
      platform: 'channels',
      platformLabel: PLATFORM_DEFINITIONS.channels.label,
      sourceUrl: 'https://weixin.qq.com/sph/' + token,
      canonicalUrl: 'https://weixin.qq.com/sph/' + token,
      contentId: token,
      linkKind: 'share',
    };
  }

  throw downloadError('DOWNLOAD_PLATFORM_UNSUPPORTED', '只支持小红书、抖音或视频号的具体作品链接');
}

function firstText(records, keys, fallback = '') {
  for (const record of records) {
    for (const key of keys) {
      const value = record?.[key];
      if (typeof value === 'string' && compact(value)) return compact(value);
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
  }
  return fallback;
}

function urlsFromValue(value, output = []) {
  if (typeof value === 'string' && isHttpsUrl(value)) {
    output.push(value.trim());
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => urlsFromValue(item, output));
    return output;
  }
  if (value && typeof value === 'object') {
    for (const key of ['url', 'url_list', 'urlList', 'src', 'uri', 'playAddr', 'downloadAddr', 'origin']) {
      urlsFromValue(value[key], output);
    }
  }
  return output;
}

function nestedRecords(value, output = [], depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return output;
  seen.add(value);
  output.push(value);
  if (Array.isArray(value)) {
    value.forEach((item) => nestedRecords(item, output, depth + 1, seen));
  } else {
    for (const child of Object.values(value)) nestedRecords(child, output, depth + 1, seen);
  }
  return output;
}

function urlsFromRecords(records, keys) {
  return [...new Set(records.flatMap((record) => keys.flatMap((key) => urlsFromValue(record?.[key]))))];
}

function firstAllowedUrl(urls, platform, kind) {
  return urls.find((url) => isAllowedMediaUrl(url, platform, kind)) || null;
}

export function isAllowedMediaUrl(value, platform, kind = 'video') {
  if (!isHttpsUrl(value)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const definition = PLATFORM_DEFINITIONS[platform];
  if (!definition || !hostMatches(url.hostname, definition.mediaHosts)) return false;
  if (kind === 'video' && /\.(?:m3u8|mpd)(?:$|\?)/i.test(url.pathname)) return false;
  return true;
}

export function normalizeDownloadMedia(value, platform) {
  const definition = PLATFORM_DEFINITIONS[platform];
  if (!definition) throw downloadError('DOWNLOAD_PLATFORM_UNSUPPORTED', '平台暂未接入下载中心');
  const records = nestedRecords(value);
  const videoCandidates = urlsFromRecords(records, [
    'videoUrl', 'video_url', 'downloadUrl', 'download_url', 'playUrl', 'play_url',
    'h264_url', 'h264Url', 'h265_url', 'h265Url', 'video', 'play', 'download',
  ]);
  const coverCandidates = urlsFromRecords(records, [
    'coverUrl', 'cover_url', 'originCover', 'origin_cover', 'dynamicCover', 'dynamic_cover',
    'poster', 'thumbnail', 'thumbnailUrl', 'thumb_url', 'cover',
  ]);
  const imageCandidates = urlsFromRecords(records, [
    'imageUrls', 'image_urls', 'imageList', 'image_list', 'images', 'noteImages', 'note_images',
  ]);
  const videoUrl = firstAllowedUrl(videoCandidates, platform, 'video');
  const coverUrl = firstAllowedUrl(coverCandidates, platform, 'cover');
  const candidateImageUrls = [...new Set(imageCandidates.filter((url) => isAllowedMediaUrl(url, platform, 'cover')))];
  const resolvedCoverUrl = coverUrl || candidateImageUrls[0] || null;
  const imageUrls = candidateImageUrls
    .filter((url) => url !== resolvedCoverUrl)
    .slice(0, 30);
  if (!videoUrl && !resolvedCoverUrl && !imageUrls.length) {
    throw downloadError('DOWNLOAD_MEDIA_NOT_FOUND', '解析服务没有返回可下载的视频或图片资源');
  }
  const h264 = firstAllowedUrl(urlsFromRecords(records, ['h264_url', 'h264Url']), platform, 'video');
  const h265 = firstAllowedUrl(urlsFromRecords(records, ['h265_url', 'h265Url']), platform, 'video');
  const title = firstText(records, ['title', 'name', 'desc', 'description', 'text'], definition.label + '作品');
  const author = firstText(records, ['author', 'author_name', 'authorName', 'nickname', 'nickName'], '作者未提供');
  return {
    title: safeText(title, definition.label + '作品'),
    author: safeText(author, '作者未提供', 80),
    videoUrl,
    coverUrl: resolvedCoverUrl,
    imageUrls,
    codec: h264 ? 'H.264' : h265 ? 'H.265' : null,
  };
}

function configuredResolverUrl(platform) {
  const definition = PLATFORM_DEFINITIONS[platform];
  const configured = String(
    process.env[definition?.resolverEnv] || process.env[GENERIC_RESOLVER_ENV] || '',
  ).trim();
  const value = configured || definition?.defaultResolver || '';
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw downloadError('DOWNLOAD_RESOLVER_CONFIG_INVALID', '下载解析服务地址配置不正确');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw downloadError('DOWNLOAD_RESOLVER_CONFIG_INVALID', '下载解析服务必须使用 HTTP(S) 地址');
  }
  return url.toString();
}

async function resolveWithEndpoint(source, resolverUrl, signal) {
  let response;
  try {
    response = await fetch(resolverUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        url: source.sourceUrl,
        platform: source.platform,
        canonicalUrl: source.canonicalUrl,
      }),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw downloadError('DOWNLOAD_RESOLVER_TIMEOUT', '解析服务响应超时，请稍后重试');
    }
    throw downloadError('DOWNLOAD_RESOLVER_UNAVAILABLE', '解析服务暂时不可用，请检查连接或稍后重试');
  }
  if (!response.ok) {
    throw downloadError('DOWNLOAD_UPSTREAM_REJECTED', '解析服务没有接受这条链接，可能需要登录或人工验证');
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw downloadError('DOWNLOAD_UPSTREAM_INVALID', '解析服务返回了无法识别的结果');
  }
  if (body?.ok === false) {
    throw downloadError('DOWNLOAD_UPSTREAM_REJECTED', safeText(body.error || body.message, '平台没有返回可下载资源'));
  }
  return normalizeDownloadMedia(body?.data || body?.result || body, source.platform);
}

export async function resolveDownloadMedia(source, options = {}) {
  const normalized = source?.platform ? source : detectDownloadSource(source);
  const resolverUrl = configuredResolverUrl(normalized.platform);
  const errors = [];
  if (resolverUrl) {
    try {
      return {
        ...normalized,
        ...(await resolveWithEndpoint(normalized, resolverUrl, options.signal)),
        resolver: 'configured-endpoint',
      };
    } catch (error) {
      errors.push(error);
    }
  }
  if (typeof options.browserSession?.resolveMedia === 'function') {
    try {
      const browserResult = await options.browserSession.resolveMedia(
        normalized.platform,
        normalized.canonicalUrl || normalized.sourceUrl,
        options,
      );
      return {
        ...normalized,
        ...normalizeDownloadMedia(browserResult, normalized.platform),
        resolver: 'desktop-browser-session',
      };
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw errors.at(-1);
  throw downloadError(
    'DOWNLOAD_PROVIDER_UNAVAILABLE',
    normalized.platformLabel + '下载解析尚未配置；桌面客户端可使用平台浏览器会话，网页模式请配置解析服务',
  );
}

export function safeText(value, fallback, max = 140) {
  const text = compact(value).replace(/[<>]/g, '').replace(/\p{Cc}/gu, '');
  return text ? text.slice(0, max) : fallback;
}

export function platformDefinition(platform) {
  const definition = PLATFORM_DEFINITIONS[platform];
  return definition ? { platform, label: definition.label } : null;
}

export function downloadPlatformCatalog() {
  return Object.entries(PLATFORM_DEFINITIONS).map(([id, definition]) => ({
    id,
    label: definition.label,
    status: 'active',
  }));
}
