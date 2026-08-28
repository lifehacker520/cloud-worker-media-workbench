import * as douyin from './douyin-parser.mjs';
import * as xhs from './xhs-parser.mjs';

const ADAPTERS = new Map([
  [
    'xhs',
    {
      id: 'xhs',
      label: '小红书',
      mode: '公开主页监控',
      status: 'active',
      ...xhs,
    },
  ],
  [
    'douyin',
    {
      id: 'douyin',
      label: '抖音',
      mode: '公开主页监控',
      status: 'beta',
      ...douyin,
    },
  ],
]);

export function adapterFor(platform) {
  const adapter = ADAPTERS.get(platform);
  if (!adapter) {
    throw new Error('暂不支持的平台：' + String(platform || '未知'));
  }
  return adapter;
}

export function normalizeSource(input) {
  const errors = [];
  for (const adapter of ADAPTERS.values()) {
    try {
      return {
        ...adapter.canonicalizeInput(input),
        platform: adapter.id,
        platformLabel: adapter.label,
      };
    } catch (error) {
      errors.push(error);
    }
  }

  const lastError = errors.at(-1);
  throw new Error(
    lastError?.message || '只支持小红书或抖音公开主页链接',
  );
}

export function adapterForInput(input) {
  const normalized = normalizeSource(input);
  return {
    adapter: adapterFor(normalized.platform),
    normalized,
  };
}

export function platformCatalog() {
  return [
    ...ADAPTERS.values(),
    {
      id: 'channels',
      label: '视频号',
      mode: '待接入',
      status: 'planned',
    },
    {
      id: 'other',
      label: '其他平台',
      mode: '按需扩展',
      status: 'planned',
    },
  ].map(({ id, label, mode, status }) => ({ id, label, mode, status }));
}

export { ADAPTERS };
