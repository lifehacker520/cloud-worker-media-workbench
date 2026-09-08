import { normalizeConnectorError } from './digital-human-domain.mjs';

export const CONTENT_MEDIA_WORKER_PROTOCOL = 'content-media-worker-v1';

const DEFAULT_CAPABILITIES = Object.freeze(['tts', 'talking_head']);

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function publicEndpoint(value) {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  return url.toString();
}

function workerError(status, payload, fallback) {
  const body = object(payload);
  return {
    errorClass: status === 408 || status === 504
      ? 'timeout'
      : status === 429
        ? 'rate_limited'
        : status >= 500
          ? 'server_error'
          : 'connector_error',
    code: text(body.code, status >= 500 ? 'MEDIA_WORKER_ERROR' : 'MEDIA_WORKER_REJECTED'),
    message: text(body.message, fallback),
    retryable: body.retryable === true || status === 408 || status === 429 || status >= 500,
    status,
  };
}

export class HttpMediaGenerationConnector {
  constructor(options = {}) {
    const rawUrl = text(options.url);
    if (!rawUrl) throw new Error('媒体 worker 地址不能为空');
    const parsed = new URL(rawUrl.endsWith('/') ? rawUrl : rawUrl + '/');
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('媒体 worker 只支持 HTTP(S) 地址');
    this.id = text(options.id, 'connector_media_worker');
    this.name = text(options.name, '外部媒体模型 Worker');
    this.baseUrl = parsed;
    this.timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15_000;
    this.healthPath = text(options.healthPath, 'health');
    this.generatePath = text(options.generatePath, 'v1/media/generate');
    this.healthState = {
      status: 'unavailable',
      reason: 'not_checked',
      capabilities: [...DEFAULT_CAPABILITIES],
    };
  }

  endpoint(path) {
    return new URL(String(path).replace(/^\/+/, ''), this.baseUrl).toString();
  }

  descriptor(tenantId = 'tenant_local') {
    const health = this.healthState || {};
    return {
      id: this.id,
      tenantId,
      name: this.name,
      kind: 'media_worker',
      status: health.status === 'ready' ? 'ready' : 'unavailable',
      capabilities: Array.isArray(health.capabilities) && health.capabilities.length ? health.capabilities : [...DEFAULT_CAPABILITIES],
      config: {
        mode: 'http-worker',
        protocol: CONTENT_MEDIA_WORKER_PROTOCOL,
        endpoint: publicEndpoint(this.baseUrl),
      },
      allowed: true,
      health: {
        status: health.status,
        reason: health.reason || null,
        workerVersion: health.workerVersion || null,
        accelerator: health.accelerator || null,
        models: health.models || null,
        capabilities: health.capabilities || null,
        missingCapabilities: health.missingCapabilities || null,
        partial: health.partial === true,
        simulation: health.simulation === true,
        error: health.error || null,
      },
    };
  }

  async request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await fetch(this.endpoint(path), {
        ...options,
        headers: { accept: 'application/json', ...(options.headers || {}) },
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
      throw {
        errorClass: timedOut ? 'timeout' : 'network_error',
        code: timedOut ? 'MEDIA_WORKER_TIMEOUT' : 'MEDIA_WORKER_UNREACHABLE',
        message: timedOut ? '媒体 worker 请求超时' : '媒体 worker 无法连接',
        retryable: true,
        status: null,
      };
    } finally {
      clearTimeout(timeout);
    }
    const raw = await response.text();
    let payload = {};
    if (raw.trim()) {
      try { payload = JSON.parse(raw); } catch {
        if (!response.ok) throw workerError(response.status, {}, '媒体 worker 返回了无效错误响应');
        throw { errorClass: 'invalid_output', code: 'MEDIA_WORKER_INVALID_JSON', message: '媒体 worker 返回了无效 JSON', retryable: false, status: response.status };
      }
    }
    if (!response.ok) throw workerError(response.status, payload, '媒体 worker 请求失败');
    return payload;
  }

  async health() {
    try {
      const payload = await this.request(this.healthPath);
      if (payload.protocol && payload.protocol !== CONTENT_MEDIA_WORKER_PROTOCOL) {
        throw { errorClass: 'invalid_output', code: 'MEDIA_WORKER_PROTOCOL_MISMATCH', message: '媒体 worker 协议版本不匹配', retryable: false, status: 200 };
      }
      this.healthState = {
        ...payload,
        status: payload.status === 'ready' ? 'ready' : 'unavailable',
        reason: payload.simulation === true
          ? 'simulation_only'
          : payload.status === 'ready' ? null : text(payload.reason, 'worker_not_ready'),
        capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : [...DEFAULT_CAPABILITIES],
      };
    } catch (error) {
      this.healthState = {
        status: 'unavailable',
        reason: 'health_check_failed',
        capabilities: [...DEFAULT_CAPABILITIES],
        error: normalizeConnectorError(error),
      };
    }
    return { ...this.healthState, connector: this.descriptor() };
  }

  async generate(args = {}) {
    return this.generateOperation({ ...args, operation: 'batch_media' });
  }

  async generateAudio(args = {}) {
    return this.generateOperation({ ...args, operation: 'tts' });
  }

  async generateTalkingHead(args = {}) {
    return this.generateOperation({ ...args, operation: 'talking_head' });
  }

  async generateOperation({ batch, item, actor, workerId, operation = 'batch_media' } = {}) {
    if (!['batch_media', 'tts', 'talking_head'].includes(operation)) {
      throw { errorClass: 'invalid_input', code: 'MEDIA_WORKER_OPERATION_INVALID', message: '媒体 worker 操作类型不合法', retryable: false, status: 400 };
    }
    const input = object(item?.input);
    const payload = await this.request(this.generatePath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: CONTENT_MEDIA_WORKER_PROTOCOL,
        connectorId: this.id,
        workerId: text(workerId, null),
        operation,
        idempotencyKey: text(item?.idempotencyKey),
        batchId: text(batch?.id, null),
        taskId: text(batch?.taskId, null),
        actor: { username: text(actor?.username, 'system') },
        input: { ...input, batchId: text(batch?.id, null), taskId: text(batch?.taskId, null) },
      }),
    });
    const output = { ...object(payload.output), ...payload };
    delete output.output;
    const requiredRef = operation === 'tts' ? 'audioRef' : 'videoRef';
    if (!text(output[requiredRef])) {
      throw {
        errorClass: 'invalid_output',
        code: operation === 'tts' ? 'MEDIA_WORKER_AUDIO_REF_MISSING' : 'MEDIA_WORKER_VIDEO_REF_MISSING',
        message: operation === 'tts' ? '媒体 worker 未返回音频引用' : '媒体 worker 未返回视频引用',
        retryable: false,
        status: 200,
      };
    }
    return {
      ...output,
      operation,
      connectorId: this.id,
      requestId: text(payload.requestId, text(output.requestId, null)),
      workerTaskId: text(payload.taskId, text(payload.workerTaskId, null)),
      simulated: output.simulated === true,
      reviewRequired: output.reviewRequired !== false,
    };
  }
}

export function createHttpMediaGenerationConnector(options = {}) {
  const url = text(options.url);
  return url ? new HttpMediaGenerationConnector({ ...options, url }) : null;
}
