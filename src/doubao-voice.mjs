/**
 * S8-01：豆包克隆音色合成（v3 单向流式）共享模块。
 * generate-real 与 HeyGem 连接器共用，避免两处协议实现分叉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function loadDoubaoTtsConfig(configPath = null) {
  const candidate = configPath || process.env.DOUBAO_TTS_CONFIG || path.join(process.cwd(), 'data', 'secrets', 'doubao-tts.json');
  if (!fs.existsSync(candidate)) throw new Error('缺少豆包 TTS 配置：data/secrets/doubao-tts.json');
  return { configPath: candidate, ...JSON.parse(fs.readFileSync(candidate, 'utf-8')) };
}

/**
 * 用克隆音色合成语音，落盘 mp3。返回 { ok, file, bytes }。
 * 响应是分块 JSON 流：拼接全部 data 字段再 base64 解码（单块截断是已知坑）。
 */
export async function synthesizeCloneVoice({ text, speaker, outFile, config = null, resourceId = 'seed-icl-2.0' }) {
  const payloadText = String(text || '').trim();
  if (!payloadText) throw new Error('TTS 文本为空');
  const cfg = config || loadDoubaoTtsConfig();
  const voice = String(speaker || cfg.clonedSpeakerId || '').trim();
  if (!voice) throw new Error('缺少克隆音色 speaker（S_ ID）');
  const response = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': cfg.token,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': randomUUID(),
    },
    body: JSON.stringify({
      user: { uid: 'cloud-worker-content-editor' },
      req_params: { model: 'seed-tts-2.0-standard', text: payloadText, speaker: voice, audio_params: { format: 'mp3', sample_rate: 24000 } },
    }),
  });
  const raw = Buffer.from(await response.arrayBuffer());
  const parts = [...raw.toString('utf-8').matchAll(/"data":"([^"]*)"/g)].map((match) => match[1]);
  if (!parts.length) throw new Error('TTS 失败：' + raw.toString('utf-8').slice(0, 200));
  const audio = Buffer.from(parts.join(''), 'base64');
  const target = outFile || path.join('data', 'media-output', `tts-${randomUUID().slice(0, 8)}.mp3`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, audio);
  return { ok: true, file: target, bytes: audio.length };
}
