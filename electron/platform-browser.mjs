import * as electron from 'electron';

const { BrowserWindow, session } = electron;

const PLATFORM_CONFIG = {
  xhs: {
    label: '小红书',
    title: '小红书浏览器补采',
    loginUrl: 'https://www.xiaohongshu.com/',
    partition: 'persist:cloud-worker-xhs-monitor',
    patterns: [/xiaohongshu\.com/i, /xhscdn\.com/i],
  },
  douyin: {
    label: '抖音',
    title: '抖音浏览器采集',
    loginUrl: 'https://www.douyin.com/',
    partition: 'persist:cloud-worker-douyin-monitor',
    patterns: [/douyin\.com/i, /zijieapi\.com/i, /byteimg\.com/i],
  },
  channels: {
    label: '视频号',
    title: '视频号浏览器采集',
    loginUrl: 'https://channels.weixin.qq.com/platform',
    partition: 'persist:cloud-worker-channels-monitor',
    patterns: [/weixin\.qq\.com/i, /channels\.weixin\.qq\.com/i, /finder\.video\.qq\.com/i],
  },
};

const SESSION_STORAGE_TYPES = [
  'cookies',
  'filesystem',
  'indexdb',
  'localstorage',
  'serviceworkers',
  'cachestorage',
];

const WAIT_AFTER_LOAD_MS = 4200;
const NETWORK_BODY_RETRIES = 8;
const NAVIGATION_TIMEOUT_MS = 15000;
const SCRIPT_TIMEOUT_MS = 8000;
const DEBUGGER_TIMEOUT_MS = 10000;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function executeJavaScriptWithTimeout(browserWindow, script) {
  return Promise.race([
    browserWindow.webContents.executeJavaScript(script, true),
    wait(SCRIPT_TIMEOUT_MS).then(() => {
      throw new Error('平台页面脚本执行超时');
    }),
  ]);
}

async function withTimeout(operation, milliseconds, message) {
  return Promise.race([
    operation(),
    wait(milliseconds).then(() => {
      throw new Error(message);
    }),
  ]);
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function firstUrl(value) {
  if (typeof value === 'string' && isHttpUrl(value)) {
    return value;
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
    for (const key of ['url_list', 'urlList', 'url', 'src', 'cover_url', 'coverUrl']) {
      const url = firstUrl(value[key]);
      if (url) {
        return url;
      }
    }
  }
  return null;
}

function textValue(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function scalarText(value) {
  return typeof value === 'string' || typeof value === 'number' ? textValue(value) : null;
}

function timestampValue(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const date = new Date(String(value).length <= 10 ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function positionValue(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function workId(value) {
  const text = textValue(value);
  return text && /^[A-Za-z0-9_@:-]{6,180}$/.test(text) ? text : null;
}

function metricsFromWork(work) {
  const statistics = [
    work?.statistics,
    work?.stats,
    work?.statisticsInfo,
    work?.statistics_info,
    work?.interactInfo,
    work?.interact_info,
  ].filter((item) => item && typeof item === 'object');
  const source = Object.assign({}, work, ...statistics);
  const aliases = {
    play_count: ['playCount', 'play_count', 'plays', 'play', 'playNum', 'play_num', '播放', '播放量'],
    read_count: ['readCount', 'read_count', 'reads', 'read', '阅读', '阅读量'],
    exposure_count: ['exposureCount', 'exposure_count', 'exposures', 'exposure', '曝光', '曝光量'],
    like_count: ['likes', 'likeCount', 'like_count', 'digg_count', 'diggCount', 'liked_count', '点赞', '点赞量'],
    favorite_count: ['favorites', 'favoriteCount', 'favorite_count', 'collect_count', 'collectCount', '收藏', '收藏量'],
    comment_count: ['comments', 'commentCount', 'comment_count', 'commentNum', '评论', '评论量'],
    share_count: ['shares', 'shareCount', 'share_count', 'shareNum', '分享', '分享量'],
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

function profileMetricsFromObject(object) {
  const statistics = [
    object?.statistics,
    object?.stats,
    object?.statisticsInfo,
    object?.statistics_info,
    object?.userInfo,
    object?.user_info,
  ].filter((item) => item && typeof item === 'object');
  const source = Object.assign({}, object, ...statistics);
  const aliases = {
    follower_count: [
      'followerCount',
      'follower_count',
      'followers',
      'fans',
      'fansCount',
      'fans_count',
      'followerNum',
      'follower_num',
      '粉丝',
      '粉丝数',
    ],
  };
  const metrics = {};
  for (const [metricKey, keys] of Object.entries(aliases)) {
    const value = keys
      .map((key) => source[key])
      .find((candidate) => candidate !== null && candidate !== undefined && candidate !== '');
    if (value !== undefined) {
      metrics[metricKey] = value;
    }
  }
  return metrics;
}

function nestedObject(object, keys) {
  for (const key of keys) {
    if (object?.[key] && typeof object[key] === 'object') {
      return object[key];
    }
  }
  return null;
}

function commentFromObject(platform, object) {
  if (!object || typeof object !== 'object') {
    return null;
  }
  const commentText = scalarText(
    object.text || object.content || object.comment_text || object.commentText || object.comment,
  );
  const externalId = scalarText(
    object.cid || object.comment_id || object.commentId || object.commentIdStr || object.id,
  );
  const user = nestedObject(object, ['user', 'user_info', 'userInfo', 'author', 'authorInfo']);
  const workExternalId = scalarText(
    object.aweme_id || object.awemeId || object.item_id || object.itemId ||
      object.note_id || object.noteId || object.object_id || object.objectId ||
      object.video_id || object.videoId || object.group_id || object.groupId,
  );
  const hasCommentMarker = Boolean(
    object.cid ||
      object.comment_id ||
      object.commentId ||
      object.commentIdStr ||
      object.comment_text ||
      object.commentText ||
      object.reply_comment_total !== undefined ||
      object.replyCount !== undefined ||
      object.reply_count !== undefined ||
      (user && (object.text || object.content)) ||
      (object.id && (user || workExternalId || object.create_time || object.createTime)),
  );
  if (!commentText || !externalId || !hasCommentMarker || commentText.length > 4000) {
    return null;
  }
  const author = user || {};
  const createdAt = timestampValue(
    object.create_time || object.createTime || object.created_at || object.createdAt || object.time,
  );
  return {
    platform,
    externalId,
    workId: workExternalId,
    text: commentText,
    authorName: scalarText(
      author.nickname || author.nickName || author.name || object.nickname || object.nickName || object.user_name,
    ),
    authorId: scalarText(
      author.uid || author.user_id || author.userId || object.user_id || object.userId,
    ),
    createdAt,
    likeCount: scalarText(object.digg_count ?? object.diggCount ?? object.like_count ?? object.likeCount),
    replyCount: scalarText(
      object.reply_comment_total ?? object.replyCount ?? object.reply_count ?? object.reply_comment_count,
    ),
    metadata: {
      platform,
      sourceShape: Object.keys(object).slice(0, 30),
    },
  };
}

function normalizeWork(work, platform, fallbackUrl) {
  const contentId = workId(
    work.contentId ||
      work.content_id ||
      work.aweme_id ||
      work.awemeId ||
      work.noteId ||
      work.note_id ||
      work.objectId ||
      work.object_id ||
      work.objectNonceId ||
      work.object_nonce_id ||
      work.video_id ||
      work.videoId ||
      work.id,
  );
  const title = textValue(
    work.title ||
      work.description ||
      work.desc ||
      work.displayTitle ||
      work.display_title ||
      work.text,
  );
  if (!title) {
    return null;
  }

  const publishedAt = timestampValue(
    work.publishedAt ||
      work.published_at ||
      work.publishTime ||
      work.publish_time ||
      work.createTime ||
      work.create_time ||
      work.pubTime ||
      work.pub_time,
  );
  const coverUrl = firstUrl(
    work.coverUrl ||
      work.cover_url ||
      work.cover ||
      work.image ||
      work.images ||
      work.image_list ||
      work.video?.origin_cover ||
      work.video?.cover ||
      work.video?.dynamic_cover,
  );
  const link = isHttpUrl(work.link)
    ? work.link
    : contentId
      ? platform === 'douyin'
        ? 'https://www.douyin.com/video/' + contentId
        : platform === 'xhs'
          ? 'https://www.xiaohongshu.com/explore/' + contentId
          : fallbackUrl
      : fallbackUrl;
  return {
    title,
    contentId,
    noteId: contentId,
    publishedAt,
    likes: textValue(
      work.likes ||
        work.likeCount ||
        work.like_count ||
        work.statistics?.digg_count ||
        work.statistics?.liked_count,
    ),
    metrics: metricsFromWork(work),
    coverUrl,
    link,
    isPinned: Boolean(work.isPinned || work.pinned),
    position: positionValue(work.position),
  };
}

function pushUniqueWork(works, work, platform, fallbackUrl) {
  const normalized = normalizeWork(work, platform, fallbackUrl);
  if (!normalized) {
    return;
  }
  const key = normalized.contentId || normalized.link || normalized.title + '\u0000' + (normalized.publishedAt || '');
  const existing = works.find((item) => item.key === key);
  if (!existing) {
    works.push({ key, ...normalized });
    return;
  }
  existing.publishedAt = existing.publishedAt || normalized.publishedAt;
  existing.likes = normalized.likes || existing.likes || null;
  if (Object.keys(normalized.metrics || {}).length) {
    existing.metrics = normalized.metrics;
  }
  existing.coverUrl = normalized.coverUrl || existing.coverUrl || null;
  existing.link = normalized.link || existing.link;
  existing.isPinned = existing.isPinned || normalized.isPinned;
  existing.position = existing.position ?? normalized.position;
}

function walkObjects(value, callback, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 9 || seen.has(value)) {
    return;
  }
  seen.add(value);
  callback(value);
  if (Array.isArray(value)) {
    value.forEach((item) => walkObjects(item, callback, depth + 1, seen));
  } else {
    Object.values(value).forEach((item) => walkObjects(item, callback, depth + 1, seen));
  }
}

export function extractPayloadData(platform, payloads, fallbackUrl) {
  const works = [];
  const comments = new Map();
  let profile = {};
  const profileMetrics = {};
  for (const payload of payloads) {
    const body = payload?.body;
    if (!body || typeof body !== 'object') {
      continue;
    }
    walkObjects(body, (object) => {
      const comment = commentFromObject(platform, object);
      if (comment) {
        const key = comment.externalId + '\u0000' + (comment.workId || '') + '\u0000' + comment.text;
        if (!comments.has(key)) {
          comments.set(key, comment);
        }
      }
      const objectMetrics = profileMetricsFromObject(object);
      for (const [metricKey, value] of Object.entries(objectMetrics)) {
        if (!Object.prototype.hasOwnProperty.call(profileMetrics, metricKey)) {
          profileMetrics[metricKey] = value;
        }
      }
      if (comment) {
        return;
      }
      const nickname = textValue(
        object.nickname || object.nickName || object.user_name || object.username,
      );
      const avatarUrl = firstUrl(
        object.avatar_larger ||
          object.avatarLarger ||
          object.avatar_300x300 ||
          object.avatar_168x168 ||
          object.avatar ||
          object.avatarUrl,
      );
      const userId = textValue(
        object.sec_uid ||
          object.secUid ||
          object.user_id ||
          object.userId ||
          object.finderUsername ||
          object.username,
      );
      if (nickname || avatarUrl || userId) {
        profile = {
          userId: profile.userId || userId,
          nickname: profile.nickname || nickname,
          avatarUrl: profile.avatarUrl || avatarUrl,
        };
      }

      if (platform === 'douyin') {
        const id = object.aweme_id || object.awemeId || object.item_id || object.itemId || object.video_id;
        if (id && (object.desc || object.description || object.title || object.text)) {
          pushUniqueWork(works, object, platform, fallbackUrl);
        }
      } else if (platform === 'xhs') {
        const id = object.noteId || object.note_id || object.note_id_str;
        if (id && (object.displayTitle || object.display_title || object.title || object.desc)) {
          pushUniqueWork(works, object, platform, fallbackUrl);
        }
      } else if (platform === 'channels') {
        const id = object.object_id || object.objectId || object.object_nonce_id || object.video_id;
        if (id && (object.title || object.description || object.desc || object.text)) {
          pushUniqueWork(works, object, platform, fallbackUrl);
        }
      }
    });
  }
  return { profile, profileMetrics, works, comments: [...comments.values()] };
}

const DOM_SNAPSHOT_SCRIPT = `(() => {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const urlOf = (value) => /^https?:\\/\\//i.test(String(value || '')) ? String(value) : null;
  const images = Array.from(document.images || []);
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const dateFrom = (value) => {
    const match = clean(value).match(/(20\\d{2}[年\\/-]\\d{1,2}[月\\/-]\\d{1,2}[^\\n]{0,12}|\\d{1,2}[月\\/-]\\d{1,2}[^\\n]{0,12})/);
    return match ? match[1] : null;
  };
  const metricFromText = (value, labels) => {
    const textValue = clean(value);
    for (const label of labels) {
      const match = textValue.match(new RegExp(label + '[^0-9]{0,4}([0-9][0-9.,]*(?:亿|万|千|[kKmM])?[+]?)', 'i'));
      if (match?.[1]) return match[1];
    }
    return null;
  };
  const isDouyin = /(?:^|\\.)douyin\\.com$/i.test(location.hostname);
  const douyinWorkRegion = (() => {
    if (!isDouyin) return null;
    const activeWorksTab = Array.from(document.querySelectorAll('[role="tab"]'))
      .find((element) => {
        if (!visible(element) || element.getAttribute('aria-selected') === 'false') return false;
        return /^作品(?:\\s+\\d+)?$/.test(clean(element.innerText));
      });
    if (!activeWorksTab) return null;
    let node = activeWorksTab;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      const videoLinks = node.querySelectorAll('a[href*="/video/"]');
      if (videoLinks.length > 0 && /作品/.test(clean(node.innerText))) {
        return node;
      }
    }
    return null;
  })();
  // 抖音主页同时包含推荐、SEO 和页脚视频链接。只从当前激活的“作品”列表
  // 取卡片，找不到这个列表时宁可返回空，避免把推荐内容伪装成账号作品。
  const linkScope = isDouyin ? douyinWorkRegion : document;
  const directLinks = Array.from(linkScope?.querySelectorAll('a[href]') || [])
    .map((anchor) => {
      const href = anchor.href;
      const rect = anchor.getBoundingClientRect();
      if (!visible(anchor) || rect.width < 2 || rect.height < 2) return null;
      return { anchor, href, rect, text: clean(anchor.innerText || anchor.getAttribute('title') || '') };
    })
    .filter(Boolean);
  const douyinTitle = (root, itemText, rootText) => {
    const paragraphs = Array.from(root.querySelectorAll('p'))
      .map((element) => clean(element.innerText))
      .filter((text) => text && !/^置顶$/.test(text))
      .sort((left, right) => right.length - left.length);
    if (paragraphs[0]) return paragraphs[0];
    const imageAlt = clean(root.querySelector('img[alt]')?.getAttribute('alt') || '');
    if (imageAlt) {
      const separator = imageAlt.indexOf('：');
      return separator > 0 ? clean(imageAlt.slice(separator + 1)) : imageAlt;
    }
    return clean(itemText || rootText)
      .replace(/^置顶\\s*/i, '')
      .replace(/^\\d+(?:\\.\\d+)?\\s*(?:万|亿|k|m)?\\s*/i, '');
  };
  const works = [];
  for (const [position, item] of directLinks.entries()) {
    const douyin = item.href.match(/\\/video\\/(\\d{8,})/i);
    const xhs = item.href.match(/\\/(?:explore|discovery\\/item)\\/([A-Za-z0-9_-]{8,80})/i);
    const channels =
      item.href.match(/(?:sph\\/|finder\\/|platform\\/(?:post|video)\\/)[A-Za-z0-9_-]{5,180}/i) ||
      (/finder\\.video\\.qq\\.com/i.test(new URL(item.href).hostname) ? [item.href] : null);
    if (!douyin && !xhs && !channels) continue;
    if (douyin && /[?&](?:source|from)=Baiduspider(?:-sdc)?/i.test(item.href)) continue;
    const root = item.anchor.closest('li, article, [class*="card"], [class*="item"], [data-e2e]') || item.anchor;
    const rootText = clean(root.innerText || item.text);
    const cover = Array.from(root.querySelectorAll('img')).map((img) => urlOf(img.currentSrc || img.src)).find(Boolean);
    const metrics = {
      play_count: metricFromText(rootText, ['播放', '播放量']),
      read_count: metricFromText(rootText, ['阅读', '阅读量']),
      exposure_count: metricFromText(rootText, ['曝光', '曝光量']),
      like_count: metricFromText(rootText, ['点赞', '赞']),
      favorite_count: metricFromText(rootText, ['收藏']),
      comment_count: metricFromText(rootText, ['评论']),
      share_count: metricFromText(rootText, ['分享']),
    };
    works.push({
      contentId: douyin ? douyin[1] : xhs ? xhs[1] : null,
      title: douyin
        ? douyinTitle(root, item.text, rootText)
        : item.text || clean(root.querySelector('[title]')?.getAttribute('title') || '') || clean(rootText.split('\\n')[0]),
      publishedAt: dateFrom(rootText),
      coverUrl: cover,
      link: item.href,
      likes: metrics.like_count,
      metrics,
      isPinned: douyin ? /^置顶(?:\\s|$)/.test(rootText) : false,
      position,
    });
  }
  const nicknameElement = Array.from(document.querySelectorAll('h1,h2,[class*="nickname"],[class*="nick-name"],[class*="user-name"]'))
    .find((element) => visible(element) && clean(element.innerText).length > 0);
  const avatar = images
    .filter((image) => visible(image) && /avatar|头像|user-image|author-avatar/i.test(image.className + ' ' + image.src))
    .sort((left, right) => (right.naturalWidth * right.naturalHeight) - (left.naturalWidth * left.naturalHeight))[0];
  const userMatch = location.href.match(/\\/user\\/(?:profile\\/)?([A-Za-z0-9_@:-]{6,180})(?:[\\/?#]|$)/i);
  const channelUser = (() => {
    try {
      const url = new URL(location.href);
      return url.searchParams.get('finderUsername') || url.searchParams.get('finder_username') || null;
    } catch {
      return null;
    }
  })();
  return {
    currentUrl: location.href,
    title: document.title,
    bodyText: clean(document.body?.innerText || '').slice(0, 8000),
    profile: {
      userId: userMatch ? userMatch[1] : channelUser,
      nickname: nicknameElement ? clean(nicknameElement.innerText) : null,
      avatarUrl: avatar ? urlOf(avatar.currentSrc || avatar.src) : null,
    },
    works,
  };
})()`;

function parseJsonBody(body) {
  if (typeof body !== 'string' || !body.trim()) {
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function bodyLooksRelevant(platform, url) {
  if (platform === 'douyin') {
    return /(?:aweme\/v1\/web|aweme\/detail|web\/api)\/(?:aweme\/post|aweme\/detail|user\/profile|comment|statistics|relation|item|feed)/i.test(url) ||
      /(?:douyin\.com|zijieapi\.com)\/.*(?:comment|statistics|aweme|user)/i.test(url);
  }
  if (platform === 'xhs') {
    return /edith\.xiaohongshu\.com\/api|xiaohongshu\.com\/(?:api|web_api|explore)/i.test(url);
  }
  return /weixin\.qq\.com|channels\.weixin\.qq\.com|finder\.video\.qq\.com/i.test(url);
}

export class PlatformBrowserSession {
  constructor() {
    this.windows = new Map();
    this.metadata = new Map(
      Object.keys(PLATFORM_CONFIG).map((platform) => [
        platform,
        { lastUsedAt: null, lastClearedAt: null },
      ]),
    );
  }

  configFor(platform) {
    const config = PLATFORM_CONFIG[platform];
    if (!config) {
      throw new Error('暂不支持浏览器补采的平台：' + platform);
    }
    return config;
  }

  metadataFor(platform) {
    if (!this.metadata.has(platform)) {
      this.metadata.set(platform, { lastUsedAt: null, lastClearedAt: null });
    }
    return this.metadata.get(platform);
  }

  statusFor(platform) {
    const config = this.configFor(platform);
    const entry = this.windows.get(platform);
    const windowOpen = Boolean(entry && !entry.browserWindow.isDestroyed());
    const metadata = this.metadataFor(platform);
    return {
      platform,
      label: config.label,
      persistent: config.partition.startsWith('persist:'),
      windowOpen,
      status: windowOpen ? 'open' : metadata.lastClearedAt ? 'cleared' : 'ready',
      loginState: 'unknown',
      lastUsedAt: metadata.lastUsedAt,
      lastClearedAt: metadata.lastClearedAt,
    };
  }

  getStatus() {
    return {
      available: true,
      mode: 'desktop-persistent',
      persistent: true,
      note: '登录态保存在桌面端按平台隔离的持久化浏览器配置中；应用不读取或导出 Cookie，登录有效性需在平台页面验证。',
      platforms: Object.keys(PLATFORM_CONFIG).map((platform) => this.statusFor(platform)),
    };
  }

  createWindow(platform) {
    const config = this.configFor(platform);
    const browserWindow = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 980,
      minHeight: 680,
      show: true,
      title: config.title,
      backgroundColor: '#f5f6f8',
      webPreferences: {
        partition: config.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const context = { responses: [], responseByRequestId: new Map(), generation: 0 };
    const debuggerClient = browserWindow.webContents.debugger;
    debuggerClient.on('message', (_event, method, params) => {
      if (method !== 'Network.responseReceived' || !params?.response?.url) {
        return;
      }
      if (!bodyLooksRelevant(platform, params.response.url)) {
        return;
      }
      const record = {
        url: params.response.url,
        status: params.response.status,
        requestId: params.requestId,
        generation: context.generation,
      };
      context.responses.push(record);
      context.responseByRequestId.set(params.requestId, record);
      record.bodyPromise = this.readResponseBody(debuggerClient, record, context);
      record.bodyPromise.catch(() => {});
    });
    debuggerClient.on('message', (_event, method, params) => {
      if (method !== 'Network.loadingFinished' || !params?.requestId) {
        return;
      }
      const record = context.responseByRequestId.get(params.requestId);
      if (!record || record.generation !== context.generation || record.body) {
        return;
      }
      record.finished = true;
      record.bodyPromise = this.readResponseBody(debuggerClient, record, context);
      record.bodyPromise.catch(() => {});
    });
    browserWindow.on('closed', () => {
      this.windows.delete(platform);
    });
    this.windows.set(platform, { browserWindow, debuggerClient, context });
    return this.windows.get(platform);
  }

  readResponseBody(debuggerClient, record, context) {
    if (record.body) {
      return record.body;
    }
    if (record.bodyPromise) {
      return record.bodyPromise;
    }
    const bodyPromise = (async () => {
      try {
        for (let attempt = 0; attempt < NETWORK_BODY_RETRIES; attempt += 1) {
          await wait(160 * (attempt + 1));
          if (record.generation !== context.generation) {
            return null;
          }
          try {
            const result = await debuggerClient.sendCommand('Network.getResponseBody', {
              requestId: record.requestId,
            });
            const parsed = parseJsonBody(result?.body);
            if (parsed) {
              record.body = parsed;
              return parsed;
            }
          } catch {
            // The body is not available until Chromium completes the response.
          }
        }
        return null;
      } finally {
        if (!record.body && record.bodyPromise === bodyPromise) {
          record.bodyPromise = null;
        }
      }
    })();
    record.bodyPromise = bodyPromise;
    return bodyPromise;
  }

  async ensureWindow(platform) {
    this.configFor(platform);
    let entry = this.windows.get(platform);
    if (!entry || entry.browserWindow.isDestroyed()) {
      entry = this.createWindow(platform);
    }
    entry.browserWindow.show();
    entry.browserWindow.focus();
    this.metadataFor(platform).lastUsedAt = new Date().toISOString();
    return entry;
  }

  async open(platform) {
    const config = this.configFor(platform);
    const entry = await this.ensureWindow(platform);
    const currentUrl = entry.browserWindow.webContents.getURL();
    if (!isHttpUrl(currentUrl)) {
      try {
        await Promise.race([
          entry.browserWindow.loadURL(config.loginUrl),
          wait(NAVIGATION_TIMEOUT_MS).then(() => {
            throw new Error('平台登录页面加载超时');
          }),
        ]);
      } catch (error) {
        throw new Error('打开平台登录页面失败：' + error.message);
      }
    }
    return this.statusFor(platform);
  }

  async clear(platform) {
    const config = this.configFor(platform);
    const entry = this.windows.get(platform);
    const browserSession =
      entry?.browserWindow?.webContents?.session || session.fromPartition(config.partition);

    if (entry) {
      try {
        if (entry.debuggerClient.isAttached()) {
          entry.debuggerClient.detach();
        }
      } catch {
        // The platform window may already be closing; storage cleanup remains safe.
      }
      if (!entry.browserWindow.isDestroyed()) {
        entry.browserWindow.destroy();
      }
      this.windows.delete(platform);
    }

    await browserSession.clearStorageData({ storages: SESSION_STORAGE_TYPES });
    await browserSession.clearCache();
    if (typeof browserSession.clearAuthCache === 'function') {
      await browserSession.clearAuthCache();
    }
    if (typeof browserSession.flushStorageData === 'function') {
      browserSession.flushStorageData();
    }
    const metadata = this.metadataFor(platform);
    metadata.lastUsedAt = null;
    metadata.lastClearedAt = new Date().toISOString();
    return this.statusFor(platform);
  }

  flushStorageData() {
    for (const entry of this.windows.values()) {
      const browserSession = entry.browserWindow.webContents.session;
      if (typeof browserSession?.flushStorageData === 'function') {
        browserSession.flushStorageData();
      }
    }
  }

  async attachDebugger(entry) {
    if (entry.debuggerClient.isAttached()) {
      return;
    }
    try {
      await withTimeout(
        async () => {
          await entry.debuggerClient.attach('1.3');
          await entry.debuggerClient.sendCommand('Network.enable');
        },
        DEBUGGER_TIMEOUT_MS,
        '平台浏览器会话初始化超时',
      );
    } catch (error) {
      if (!entry.browserWindow.isDestroyed()) {
        entry.browserWindow.close();
      }
      throw new Error('无法启用平台浏览器会话：' + error.message);
    }
  }

  async collectProfile(platform, input, options = {}) {
    const target = String(input || '').trim();
    if (!isHttpUrl(target)) {
      throw new Error('浏览器补采需要完整的 http(s) 平台链接');
    }
    const entry = await this.ensureWindow(platform);
    entry.context.generation += 1;
    entry.context.responses = [];
    entry.context.responseByRequestId.clear();
    try {
      await Promise.race([
        entry.browserWindow.loadURL(target),
        wait(NAVIGATION_TIMEOUT_MS).then(() => {
          throw new Error('平台页面加载超时');
        }),
      ]);
    } catch (error) {
      const loadedUrl = entry.browserWindow.webContents.getURL();
      if (
        !/ERR_ABORTED|(-3)|加载超时/i.test(error.message || '') ||
        !isHttpUrl(loadedUrl)
      ) {
        throw new Error('打开平台页面失败：' + error.message);
      }
      // Short-link redirects may reject loadURL with ERR_ABORTED even though
      // Chromium has already landed on the final creator page.
    }
    // 先让页面完成一次导航，再 attach DevTools target。Electron 在新建的
    // about:blank 窗口上过早 attach 可能一直等待，导致补采请求卡死。
    await this.attachDebugger(entry);
    await wait(WAIT_AFTER_LOAD_MS);
    try {
      await executeJavaScriptWithTimeout(
        entry.browserWindow,
        'window.scrollTo(0, 0); document.body && document.body.click();',
      );
    } catch {
      // A page can be closed while the platform is redirecting.
    }
    await wait(800);
    try {
      await executeJavaScriptWithTimeout(
        entry.browserWindow,
        'window.scrollTo(0, Math.min(document.body?.scrollHeight || 0, window.innerHeight * 1.15));',
      );
    } catch {
      // Keep the first viewport snapshot if the page has gone away.
    }
    await wait(900);

    let snapshot;
    try {
      snapshot = await executeJavaScriptWithTimeout(entry.browserWindow, DOM_SNAPSHOT_SCRIPT);
    } catch (error) {
      throw new Error('读取平台页面失败：' + error.message);
    }
    const currentRecords = entry.context.responses.filter(
      (record) => record.generation === entry.context.generation,
    );
    await Promise.allSettled(
      currentRecords.map((record) =>
        record.body
          ? Promise.resolve(record.body)
          : this.readResponseBody(entry.debuggerClient, record, entry.context),
      ),
    );
    const payloads = entry.context.responses
      .filter((record) => record.generation === entry.context.generation && record.body)
      .map(({ url, status, body }) => ({ url, status, body }));
    const payloadData = extractPayloadData(platform, payloads, snapshot.currentUrl || target);
    const works = [];
    for (const work of payloadData.works) {
      pushUniqueWork(works, work, platform, snapshot.currentUrl || target);
    }
    for (const work of snapshot.works || []) {
      pushUniqueWork(works, work, platform, snapshot.currentUrl || target);
    }
    const profile = {
      ...(snapshot.profile || {}),
      ...payloadData.profile,
      nickname: payloadData.profile.nickname || snapshot.profile?.nickname || null,
      avatarUrl: payloadData.profile.avatarUrl || snapshot.profile?.avatarUrl || null,
      userId: payloadData.profile.userId || snapshot.profile?.userId || null,
    };
    if (!works.length && /安全限制|安全验证|验证码|服务异常|登录即可|请登录|需要登录/i.test(snapshot.bodyText || '')) {
      throw new Error(
        '平台页面需要登录或人工验证；请在弹出的' + this.configFor(platform).title + '窗口完成后，再点击“浏览器补采”',
      );
    }
    if (!works.length) {
      throw new Error(
        '浏览器会话暂未读取到公开作品；请确认已登录、打开的是作品列表，并在页面完成一次人工验证后重试',
      );
    }
    return {
      canonicalUrl: snapshot.currentUrl || target,
      userId: profile.userId,
      browserSnapshot: {
        profile,
        works: works.map(({ key, ...work }) => work),
        currentUrl: snapshot.currentUrl || target,
        diagnostics: {
          payloadCount: payloads.length,
          domWorkCount: Array.isArray(snapshot.works) ? snapshot.works.length : 0,
        },
      },
      profileMetrics: payloadData.profileMetrics,
      comments: payloadData.comments,
      source: 'browser-network',
      html: '',
    };
  }
}
