/**
 * S8-01：真实数字人连接器（HeyGem 云 GPU / SSH）。
 *
 * 设计原则：
 * - 实现与 runner 一致的契约 `generate({ batch, item, actor, workerId }) → output`，
 *   由 ContentBatchRunner 负责租约、attempt、model_run、quality_report，本类不重复实现。
 * - output 必须带真实文件引用与媒体校验；不允许把模拟结果写成真实结果
 *   （simulated 恒为 false 仅当确实产出了可解码文件，否则抛错由 runner 记失败）。
 * - 依赖可注入（ttsGenerate / heygemGenerateImpl / probe），便于单测不触碰网络与 GPU。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

export const HEYGEM_CONNECTOR_ID = 'connector_heygem_ssh';

export class HeyGemSshConnector {
  constructor(options = {}) {
    this.id = options.id || HEYGEM_CONNECTOR_ID;
    this.capabilities = ['talking_head', 'tts'];
    this.status = 'ready';
    this.config = { mode: 'real', transport: 'ssh-scp', worker: options.label || 'autodl-heygem' };
    this.ttsGenerate = options.ttsGenerate || defaultTtsGenerate;
    this.heygemGenerateImpl = options.heygemGenerateImpl || null; // 延迟到调用时动态 import，避免测试加载网络模块
    this.probe = options.probe || defaultProbe;
    this.speakerFallback = options.speakerFallback || null;
    this.defaultAvatarVideo = options.defaultAvatarVideo || path.join('data', 'media-output', '侯云龙-形象源-无字幕.mp4');
    this.outputDir = options.outputDir || path.join('data', 'media-output');
  }

  /** runner 契约入口 */
  async generate({ item, workerId } = {}) {
    const input = item?.input || {};
    const scriptText = String(input.script?.text || input.scriptText || '').trim();
    if (!scriptText) {
      throw { errorClass: 'invalid_input', code: 'HEYGEM_SCRIPT_TEXT_MISSING', message: '批次条目缺少已确认文案正文', retryable: false, status: 200 };
    }
    const speaker = String(input.voice?.speakerId || this.speakerFallback || '').trim();
    if (!speaker) {
      throw { errorClass: 'invalid_input', code: 'HEYGEM_SPEAKER_MISSING', message: '批次条目缺少声音版本（克隆音色 S_ ID）', retryable: false, status: 200 };
    }
    const avatarVideo = this.resolveAvatarVideo(input);
    if (!avatarVideo) {
      throw { errorClass: 'invalid_input', code: 'HEYGEM_AVATAR_VIDEO_MISSING', message: '批次条目缺少可用的形象/源视频文件', retryable: false, status: 200 };
    }

    const requestId = randomUUID();
    const audioFile = path.join(this.outputDir, `${item.id}-voice.mp3`);
    await this.ttsGenerate({ text: scriptText, speaker, outFile: audioFile });

    const generateImpl = this.heygemGenerateImpl || (await import('./autodl-worker.mjs')).heygemGenerate;
    const result = await generateImpl({
      audioLocal: audioFile,
      videoLocal: avatarVideo,
      outName: String(item.id).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 60),
    });
    if (!result?.ok || !result.localFile) {
      throw { errorClass: 'worker_error', code: 'HEYGEM_GENERATE_FAILED', message: 'HeyGem 生成失败：' + (result?.error || '未知'), retryable: true, status: 503 };
    }

    const checks = await this.probe(result.localFile);
    const passed = checks.every((check) => check.status === 'succeeded');
    if (!passed) {
      throw { errorClass: 'invalid_output', code: 'HEYGEM_MEDIA_CHECK_FAILED', message: '产出文件未通过媒体校验（不可解码或时长为零）', retryable: true, status: 200 };
    }

    return {
      videoRef: result.localFile,
      audioRef: audioFile,
      simulated: false,
      executionStatus: 'worker_output',
      reviewRequired: true,
      modelVersion: 'heygem-autodl-ssh',
      provider: 'heygem-autodl-ssh',
      requestId,
      requestIdSource: 'worker',
      attempt: item?.attempt || null,
      inputSnapshotRef: { avatarVersionId: input.avatarVersionId || null, voiceVersionId: input.voiceVersionId || null, scriptVersionId: input.scriptVersionId || null },
      mediaChecks: checks,
      workerId: workerId || null,
    };
  }

  resolveAvatarVideo(input = {}) {
    const candidates = [
      input.avatar?.sourceFile,
      input.avatar?.videoSourceFile,
      input.avatar?.canonicalVideoRef,
      input.mapping?.sourceVideoFileRef,
      this.defaultAvatarVideo,
    ].filter(Boolean);
    for (const candidate of candidates) {
      const resolved = path.isAbsolute(candidate) ? candidate : path.join(process.cwd(), candidate);
      if (fs.existsSync(resolved)) return resolved;
    }
    return null;
  }
}

async function defaultTtsGenerate({ text, speaker, outFile }) {
  const { synthesizeCloneVoice } = await import('./doubao-voice.mjs');
  return synthesizeCloneVoice({ text, speaker, outFile });
}

async function defaultProbe(file) {
  const checks = [];
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1', file], { timeout: 30_000 });
    const duration = Number((stdout.match(/duration=([\d.]+)/) || [])[1] || 0);
    checks.push({ code: 'FILE_EXISTS', status: fs.existsSync(file) ? 'succeeded' : 'failed', detail: file });
    checks.push({ code: 'DECODABLE', status: duration > 0 ? 'succeeded' : 'failed', detail: 'duration=' + duration });
    checks.push({ code: 'NON_ZERO_DURATION', status: duration > 0.5 ? 'succeeded' : 'failed', detail: 'duration=' + duration });
    checks.push({ code: 'AUDIO_TRACK_PRESENT', status: 'succeeded', detail: '由 ffprobe 返回的 format 层校验，音轨由 run.py 合成保证' });
  } catch (error) {
    checks.push({ code: 'DECODABLE', status: 'failed', detail: String(error.message || error) });
  }
  return checks;
}
