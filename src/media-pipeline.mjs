import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);
const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT = 120_000;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const NATIVE_OCR_SCRIPT_CANDIDATES = [
  resolve(MODULE_DIR, '../tools/vision-ocr.swift'),
  ...(process.resourcesPath ? [resolve(process.resourcesPath, 'tools/vision-ocr.swift')] : []),
];

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.srt', '.vtt', '.html', '.htm',
]);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg', '.opus']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.ts']);

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function mimeTypeForPath(filePath) {
  const extension = extname(filePath).toLowerCase();
  const types = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.srt': 'application/x-subrip',
    '.vtt': 'text/vtt',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.heic': 'image/heic',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.ts': 'video/mp2t',
  };
  return types[extension] || 'application/octet-stream';
}

export function mediaKindForPath(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return 'file';
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function existingRealPath(candidate) {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function isWithinRoot(candidate, root) {
  return candidate === root || candidate.startsWith(root + sep);
}

export async function resolveLocalMediaPath(inputPath, allowedRoots = []) {
  const candidate = text(inputPath);
  if (!candidate || !isAbsolute(candidate)) {
    throw new Error('素材路径必须是绝对路径');
  }
  const resolved = await existingRealPath(candidate);
  if (!resolved) throw new Error('素材文件不存在');
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) throw new Error('素材路径不是文件');
  const roots = [];
  for (const root of allowedRoots) {
    const resolvedRoot = await existingRealPath(root);
    if (resolvedRoot) roots.push(resolvedRoot);
  }
  if (roots.length > 0 && !roots.some((root) => isWithinRoot(resolved, root))) {
    throw new Error('素材路径不在允许的本地目录内');
  }
  return resolved;
}

async function runCommand(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      const unavailable = new Error('本机未安装或未配置命令：' + command);
      unavailable.code = 'TOOL_UNAVAILABLE';
      throw unavailable;
    }
    throw error;
  }
}

async function commandExists(command) {
  try {
    await runCommand(process.platform === 'win32' ? 'where.exe' : 'which', [command], { timeout: 5_000, maxBuffer: 32_000 });
    return true;
  } catch {
    return false;
  }
}

async function executableAvailable(command) {
  if (isAbsolute(command)) return access(command).then(() => true).catch(() => false);
  return commandExists(command);
}

async function findWhisperModel() {
  const candidates = [
    process.env.XHS_WHISPER_MODEL,
    resolve(MODULE_DIR, '../data/models/ggml-base.bin'),
    join(homedir(), '.cache/whisper.cpp/ggml-base.bin'),
    join(homedir(), 'Library/Application Support/whisper.cpp/ggml-base.bin'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return null;
}

async function resolveWhisperRuntime() {
  const executable = text(process.env.XHS_WHISPER_COMMAND, 'whisper-cli');
  const [available, model] = await Promise.all([
    executableAvailable(executable),
    findWhisperModel(),
  ]);
  return { executable, model, available };
}

export async function runtimeCapabilities() {
  const [ffprobe, ffmpeg, zip, swift, nativeOcrScript, whisper] = await Promise.all([
    commandExists('ffprobe'),
    commandExists('ffmpeg'),
    process.platform === 'win32' ? commandExists('powershell.exe') : commandExists('zip'),
    commandExists('swift'),
    findNativeOcrScript(),
    resolveWhisperRuntime(),
  ]);
  const nativeOcr = swift && Boolean(nativeOcrScript);
  return {
    ffprobe,
    ffmpeg,
    zip,
    transcription: Boolean(process.env.XHS_TRANSCRIBE_COMMAND) || Boolean(whisper.available && whisper.model),
    whisperCli: whisper.available,
    whisperModel: Boolean(whisper.model),
    ocr: Boolean(process.env.XHS_OCR_COMMAND) || nativeOcr,
    nativeOcr,
    subtitleBurnIn: ffmpeg,
    aiGeneration: Boolean(process.env.DEEPSEEK_API_KEY),
  };
}

async function findNativeOcrScript() {
  for (const candidate of NATIVE_OCR_SCRIPT_CANDIDATES) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return null;
}

function normalizedRotation(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const degrees = ((numeric % 360) + 360) % 360;
  const rounded = Math.round(degrees * 1_000) / 1_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function enrichStreamMetadata(stream) {
  const sideData = Array.isArray(stream?.side_data_list)
    ? stream.side_data_list.find((item) => item?.side_data_type === 'Display Matrix' || item?.rotation !== undefined || item?.displaymatrix)
    : null;
  const tagRotation = stream?.tags?.rotate ?? stream?.tags?.ROTATE;
  const sideRotation = sideData?.rotation;
  const tagDegrees = normalizedRotation(tagRotation);
  const sideDegrees = normalizedRotation(sideRotation);
  const rotationDegrees = tagDegrees ?? sideDegrees;
  const rotation = rotationDegrees === null
    ? null
    : { degrees: rotationDegrees, source: tagDegrees !== null ? 'tag' : 'side_data' };
  const displayMatrix = typeof sideData?.displaymatrix === 'string' && sideData.displaymatrix.trim()
    ? sideData.displaymatrix
    : null;
  return {
    ...stream,
    ...(rotation ? { rotation } : {}),
    ...(displayMatrix ? { displayMatrix } : {}),
  };
}

async function probeWithFfprobe(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=format_name,duration,size,bit_rate:stream=index,codec_name,codec_type,width,height,display_aspect_ratio,sample_aspect_ratio,r_frame_rate,sample_rate,channels,channel_layout:stream_tags=rotate:stream_side_data=rotation,displaymatrix',
    '-of', 'json',
    filePath,
  ], { maxBuffer: 2 * 1024 * 1024 });
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('ffprobe 返回的数据无法解析');
  }
  return {
    format: parsed.format || {},
    streams: Array.isArray(parsed.streams) ? parsed.streams.map(enrichStreamMetadata) : [],
  };
}

export async function probeMediaFile(inputPath, options = {}) {
  const filePath = await resolveLocalMediaPath(inputPath, options.allowedRoots || []);
  const fileStat = await stat(filePath);
  const kind = text(options.expectedKind, mediaKindForPath(filePath));
  if (!['audio', 'video', 'image'].includes(kind)) {
    const error = new Error('媒体输出类型不受支持');
    error.code = 'MEDIA_KIND_UNSUPPORTED';
    throw error;
  }
  if (fileStat.size < 1) {
    const error = new Error('媒体输出文件为空');
    error.code = 'MEDIA_EMPTY';
    throw error;
  }
  let media;
  try {
    media = await probeWithFfprobe(filePath);
  } catch (error) {
    const probeError = new Error('媒体输出探测失败：' + error.message);
    probeError.code = error.code === 'TOOL_UNAVAILABLE' ? 'TOOL_UNAVAILABLE' : 'MEDIA_PROBE_FAILED';
    throw probeError;
  }
  const expectedStream = kind === 'audio' ? 'audio' : 'video';
  if (!media.streams.some((stream) => stream.codec_type === expectedStream)) {
    const error = new Error('媒体输出缺少 ' + expectedStream + ' 流');
    error.code = 'MEDIA_STREAM_MISSING';
    throw error;
  }
  return {
    status: 'succeeded',
    kind,
    sizeBytes: fileStat.size,
    format: media.format,
    streams: media.streams,
  };
}

function textSignals(content) {
  const normalized = String(content || '').replace(/\r\n?/g, '\n').trim();
  const lines = normalized ? normalized.split('\n').map((line) => line.trim()).filter(Boolean) : [];
  const headings = lines.filter((line) => /^#{1,6}\s+/.test(line) || /^\d+[.、)]\s*/.test(line)).slice(0, 30);
  const tokens = normalized
    .toLowerCase()
    .match(/[\p{L}\p{N}_-]{2,}/gu) || [];
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  const topTerms = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 30)
    .map(([term, count]) => ({ term, count }));
  return {
    characterCount: normalized.length,
    lineCount: lines.length,
    headings,
    topTerms,
  };
}

async function readTextMaterial(filePath, fileStat) {
  if (fileStat.size > MAX_TEXT_BYTES) {
    throw new Error('文本素材超过 10 MB，暂不直接读取');
  }
  const buffer = await readFile(filePath);
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function splitConfiguredCommand(value) {
  // Commands are deliberately not executed through a shell. Keep this setting
  // to an executable path plus plain arguments; the input path is appended.
  return String(value || '').trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^['"]|['"]$/g, '')) || [];
}

async function optionalTextCommand(envName, filePath) {
  const commandParts = splitConfiguredCommand(process.env[envName]);
  if (!commandParts.length) {
    return { status: 'not_configured', text: '', message: '未配置 ' + envName };
  }
  const [command, ...args] = commandParts;
  try {
    const { stdout, stderr } = await runCommand(command, [...args, filePath], {
      timeout: 15 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const output = String(stdout || '').trim();
    const parsed = envName === 'XHS_TRANSCRIBE_COMMAND'
      ? parseTranscriptOutput(output)
      : { format: 'text', text: output, segments: [] };
    return {
      status: 'succeeded',
      text: parsed.text,
      message: String(stderr || '').trim().slice(0, 500),
      format: parsed.format,
      segments: parsed.segments,
      confidence: summarizeTranscriptConfidence(parsed.segments),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      text: '',
      message: error.code === 'TOOL_UNAVAILABLE' ? error.message : '本地命令执行失败：' + error.message,
      confidence: summarizeTranscriptConfidence([]),
    };
  }
}

function roundedCoordinate(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(3)) : null;
}

function normalizedOcrBox(value) {
  if (Array.isArray(value) && value.length === 4 && value.every((item) => Number.isFinite(Number(item)))) {
    const [x, y, width, height] = value.map(roundedCoordinate);
    return width >= 0 && height >= 0 ? { x, y, width, height } : null;
  }
  if (Array.isArray(value) && value.length >= 2) {
    const points = value.map((point) => {
      if (Array.isArray(point) && point.length >= 2) return { x: roundedCoordinate(point[0]), y: roundedCoordinate(point[1]) };
      if (point && typeof point === 'object') return { x: roundedCoordinate(point.x), y: roundedCoordinate(point.y) };
      return null;
    }).filter((point) => point && point.x !== null && point.y !== null);
    if (points.length >= 2) {
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: roundedCoordinate(Math.max(...xs) - x), height: roundedCoordinate(Math.max(...ys) - y) };
    }
  }
  if (value && typeof value === 'object') {
    const x = roundedCoordinate(value.x);
    const y = roundedCoordinate(value.y);
    const width = roundedCoordinate(value.width);
    const height = roundedCoordinate(value.height);
    if ([x, y, width, height].every((item) => item !== null) && width >= 0 && height >= 0) {
      return { x, y, width, height };
    }
    const x1 = roundedCoordinate(value.x1);
    const y1 = roundedCoordinate(value.y1);
    const x2 = roundedCoordinate(value.x2);
    const y2 = roundedCoordinate(value.y2);
    if ([x1, y1, x2, y2].every((item) => item !== null)) {
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    }
  }
  return null;
}

function structuredOcrItems(content) {
  let parsed;
  try {
    parsed = JSON.parse(String(content || '').trim());
  } catch {
    return null;
  }
  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed?.items ?? parsed?.detections ?? parsed?.results ?? parsed?.result;
  if (!Array.isArray(candidates)) return null;
  return candidates.map((candidate) => {
    let value = candidate;
    let legacyBox = null;
    let legacyRecognition = null;
    if (Array.isArray(candidate)) {
      [legacyBox, legacyRecognition] = candidate;
      value = legacyRecognition;
    }
    const candidateText = Array.isArray(value)
      ? value[0]
      : value && typeof value === 'object'
        ? value.text ?? value.label ?? value.content
        : value;
    const confidenceValue = Array.isArray(value)
      ? value[1]
      : value && typeof value === 'object'
        ? value.confidence ?? value.score ?? value.probability
        : null;
    const itemText = text(candidateText);
    if (!itemText) return null;
    const box = normalizedOcrBox(legacyBox || (value && typeof value === 'object'
      ? value.box ?? value.bbox ?? value.boundingBox ?? value.points
      : null));
    const confidence = normalizedConfidence(confidenceValue);
    const coordinateSystem = text(value && typeof value === 'object'
      ? value.coordinateSystem ?? value.boxSpace ?? value.box?.coordinateSystem
      : '');
    return {
      text: itemText,
      ...(confidence === null ? {} : { confidence }),
      ...(box ? { box } : {}),
      ...(coordinateSystem ? { coordinateSystem } : {}),
    };
  }).filter(Boolean).slice(0, 500);
}

function parseOcrOutput(content) {
  const items = structuredOcrItems(content);
  if (items !== null) {
    return { format: 'json', text: items.map((item) => item.text).join('\n'), items };
  }
  return { format: 'text', text: String(content || '').trim(), items: [] };
}

async function optionalOcrCommand(filePath) {
  const commandParts = splitConfiguredCommand(process.env.XHS_OCR_COMMAND);
  if (!commandParts.length) {
    return { status: 'not_configured', text: '', message: '未配置 XHS_OCR_COMMAND', format: null, items: [] };
  }
  const [command, ...args] = commandParts;
  try {
    const { stdout, stderr } = await runCommand(command, [...args, filePath], {
      timeout: 15 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = parseOcrOutput(stdout);
    return {
      status: 'succeeded',
      text: parsed.text,
      message: String(stderr || '').trim().slice(0, 500),
      format: parsed.format,
      items: parsed.items,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      text: '',
      message: error.code === 'TOOL_UNAVAILABLE' ? error.message : '本地 OCR 命令执行失败：' + error.message,
      format: null,
      items: [],
    };
  }
}

function srtTimestampToSeconds(value) {
  const match = String(value || '').trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

export function parseSrtSegments(content) {
  return String(content || '')
    .replace(/^\uFEFF/, '')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex < 0) return null;
      const [startValue, endValue] = lines[timingIndex].split('-->').map((value) => value.trim().split(/\s+/)[0]);
      const start = srtTimestampToSeconds(startValue);
      const end = srtTimestampToSeconds(endValue);
      const textValue = lines.slice(timingIndex + 1).join('\n').trim();
      if (start === null || end === null || !textValue) return null;
      return { start, end, text: textValue };
    })
    .filter(Boolean)
    .slice(0, 2_000);
}

const DEFAULT_TRANSCRIPT_CONFIDENCE_THRESHOLD = 0.6;

function normalizedConfidence(value) {
  const confidence = Number(value);
  return Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null;
}

export function summarizeTranscriptConfidence(segments, options = {}) {
  const thresholdValue = Number(options.threshold);
  const threshold = Number.isFinite(thresholdValue)
    ? Math.min(1, Math.max(0, thresholdValue))
    : DEFAULT_TRANSCRIPT_CONFIDENCE_THRESHOLD;
  const input = Array.isArray(segments) ? segments : [];
  const lowConfidenceSegments = [];
  const missingConfidenceSegments = [];
  for (const [index, segment] of input.entries()) {
    const confidence = normalizedConfidence(segment?.confidence);
    const evidence = {
      index,
      start: Number(segment?.start),
      end: Number(segment?.end),
      text: text(segment?.text),
      confidence,
    };
    if (confidence === null) {
      missingConfidenceSegments.push({ ...evidence, reason: 'not_provided' });
    } else if (confidence < threshold) {
      lowConfidenceSegments.push({ ...evidence, reason: 'below_threshold' });
    }
  }
  const hasSegments = input.length > 0;
  const available = hasSegments && missingConfidenceSegments.length === 0;
  return {
    available,
    status: !hasSegments ? 'unavailable' : !available ? 'unavailable' : lowConfidenceSegments.length ? 'low' : 'available',
    threshold,
    requiresHumanReview: lowConfidenceSegments.length > 0 || missingConfidenceSegments.length > 0,
    lowConfidenceSegments,
    missingConfidenceSegments,
    reviewSegments: [...lowConfidenceSegments, ...missingConfidenceSegments],
  };
}

function structuredTranscriptSegments(content) {
  let parsed;
  try {
    parsed = JSON.parse(String(content || '').trim());
  } catch {
    return null;
  }
  const candidates = Array.isArray(parsed) ? parsed : parsed?.segments;
  if (!Array.isArray(candidates)) return null;
  const segments = candidates.map((segment) => {
    const start = Number(segment?.start ?? segment?.startSeconds);
    const end = Number(segment?.end ?? segment?.endSeconds);
    const segmentText = text(segment?.text);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !segmentText) return null;
    const confidence = normalizedConfidence(segment?.confidence ?? segment?.probability);
    return {
      start,
      end,
      text: segmentText,
      ...(confidence === null ? {} : { confidence }),
    };
  }).filter(Boolean).slice(0, 2_000);
  return segments.length ? segments : null;
}

function parseTranscriptOutput(content) {
  const structured = structuredTranscriptSegments(content);
  if (structured) {
    return {
      format: 'json',
      text: structured.map((segment) => segment.text).join('\n'),
      segments: structured,
    };
  }
  const segments = parseSrtSegments(content);
  return {
    format: segments.length ? 'srt' : 'text',
    text: segments.length ? segments.map((segment) => segment.text).join('\n') : String(content || '').trim(),
    segments,
  };
}

function timedSubtitleSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => ({
      start: Number(segment?.start),
      end: Number(segment?.end),
      text: typeof segment?.text === 'string' ? segment.text.trim() : '',
    }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.end > segment.start && segment.text)
    .slice(0, 2_000);
}

function formatSrtTimestamp(totalSeconds) {
  const milliseconds = Math.max(0, Math.round(totalSeconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':') + ',' + String(millis).padStart(3, '0');
}

export function segmentsToSrt(segments) {
  return timedSubtitleSegments(segments)
    .map((segment, index) => `${index + 1}\n${formatSrtTimestamp(segment.start)} --> ${formatSrtTimestamp(segment.end)}\n${segment.text}\n`)
    .join('\n');
}

function formatAssTimestamp(totalSeconds) {
  const centiseconds = Math.max(0, Math.round(Number(totalSeconds) * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const seconds = Math.floor((centiseconds % 6000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`;
}

function assText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/[{}]/g, (character) => character === '{' ? '(' : ')')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '\\N');
}

export function segmentsToAss(segments, options = {}) {
  const width = Number.isInteger(options.width) && options.width > 0 ? options.width : 1080;
  const height = Number.isInteger(options.height) && options.height > 0 ? options.height : 1920;
  const safeArea = options.safeArea && typeof options.safeArea === 'object' ? options.safeArea : {};
  const fontName = String(options.fontName || 'Arial').replace(/[\r\n,]/g, ' ').trim() || 'Arial';
  const fontSize = Number.isFinite(Number(options.fontSize)) && Number(options.fontSize) > 0
    ? Math.round(Number(options.fontSize))
    : 54;
  const margin = (value, fallback) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value)) : fallback;
  const marginL = margin(safeArea.left, 72);
  const marginR = margin(safeArea.right, 72);
  const marginV = margin(safeArea.bottom, 240);
  const outline = margin(options.outline, 3);
  const shadow = margin(options.shadow, 1);
  const lines = timedSubtitleSegments(segments)
    .map((segment) => ({
      start: segment.start,
      end: segment.end,
      text: assText(segment.text),
    }))
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'Collisions: Normal',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${fontName},${fontSize},&H00FFFFFF,&H0000FFFF,&H00000000,&H99000000,0,0,0,0,100,100,0,0,1,${outline},${shadow},2,${marginL},${marginR},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...lines.map((segment) => `Dialogue: 0,${formatAssTimestamp(segment.start)},${formatAssTimestamp(segment.end)},Default,,0,0,0,,${segment.text}`),
    '',
  ].join('\n');
}

async function whisperCliTranscript(filePath, kind, runtime) {
  if (!runtime.available || !runtime.model) {
    return { status: 'not_configured', text: '', message: '未配置 XHS_WHISPER_MODEL，且没有可用的 whisper-cli 模型', confidence: summarizeTranscriptConfidence([]) };
  }
  let tempDir = null;
  let inputPath = filePath;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'cloud-worker-whisper-'));
    // whisper-cli consumes wav/flac/mp3/ogg. Convert video and less common audio
    // formats first, without modifying the original source asset.
    if (kind === 'video' || !['.wav', '.flac', '.mp3', '.ogg'].includes(extname(filePath).toLowerCase())) {
      inputPath = join(tempDir, 'audio.wav');
      await runCommand('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', filePath,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', inputPath,
      ], { timeout: 15 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 });
    }
    const language = text(process.env.XHS_WHISPER_LANGUAGE, 'zh');
    const transcriptBase = join(tempDir, 'transcript');
    const { stdout, stderr } = await runCommand(runtime.executable, [
      '-m', runtime.model,
      '-l', language,
      '-nt', '-np', '-otxt', '-osrt', '-of', transcriptBase,
      '-f', inputPath,
    ], {
      timeout: 30 * 60 * 1000,
      maxBuffer: 50 * 1024 * 1024,
    });
    const transcriptText = await readFile(transcriptBase + '.txt', 'utf8').catch(() => String(stdout || ''));
    const srt = await readFile(transcriptBase + '.srt', 'utf8').catch(() => '');
    const segments = parseSrtSegments(srt);
    return {
      status: 'succeeded',
      text: transcriptText.trim(),
      message: String(stderr || '').trim().slice(-1_000),
      format: srt ? 'srt' : 'text',
      segments,
      confidence: summarizeTranscriptConfidence(segments),
    };
  } catch (error) {
    return {
      status: error.code === 'TOOL_UNAVAILABLE' ? 'not_configured' : 'unavailable',
      text: '',
      message: error.code === 'TOOL_UNAVAILABLE' ? error.message : 'whisper-cli 转写失败：' + error.message,
      format: null,
      segments: [],
      confidence: summarizeTranscriptConfidence([]),
    };
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function transcribeMediaAsset(inputPath, options = {}) {
  const filePath = await resolveLocalMediaPath(inputPath, options.allowedRoots || []);
  const kind = mediaKindForPath(filePath);
  if (!['video', 'audio'].includes(kind)) {
    return { status: 'not_applicable', text: '', message: '当前素材类型不支持语音转写', format: null, segments: [], confidence: summarizeTranscriptConfidence([]) };
  }
  const whisperRuntime = await resolveWhisperRuntime();
  return splitConfiguredCommand(process.env.XHS_TRANSCRIBE_COMMAND).length
    ? optionalTextCommand('XHS_TRANSCRIBE_COMMAND', filePath)
    : whisperCliTranscript(filePath, kind, whisperRuntime);
}

async function nativeOcr(filePath, scriptPath) {
  try {
    const { stdout, stderr } = await runCommand('swift', [scriptPath, filePath], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = parseOcrOutput(stdout);
    return {
      status: 'succeeded',
      text: parsed.text,
      message: String(stderr || '').trim().slice(0, 500),
      format: parsed.format,
      items: parsed.items,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      text: '',
      message: error.code === 'TOOL_UNAVAILABLE' ? error.message : 'Vision OCR 执行失败：' + error.message,
      format: null,
      items: [],
    };
  }
}

async function ocrFrameSet(frames, scriptPath = null) {
  const inputs = (Array.isArray(frames) ? frames : [])
    .filter((frame) => frame?.path)
    .slice(0, 6);
  if (!inputs.length) {
    return { status: 'not_configured', text: '', message: '没有可供 OCR 的关键帧', frames: [] };
  }
  if (!process.env.XHS_OCR_COMMAND && !scriptPath) {
    return { status: 'not_configured', text: '', message: '未配置 OCR 命令，且当前运行环境没有 macOS Vision', frames: [] };
  }
  // ponytail: keep OCR on the same bounded keyframe set used by the rest of the pipeline.
  const results = [];
  for (const frame of inputs) {
    const result = process.env.XHS_OCR_COMMAND
      ? await optionalOcrCommand(frame.path)
      : await nativeOcr(frame.path, scriptPath);
    results.push({
      path: frame.path,
      timeSeconds: Number.isFinite(frame.timeSeconds) ? frame.timeSeconds : null,
      status: result.status,
      text: result.text || '',
      message: result.message || '',
      format: result.format || null,
      items: Array.isArray(result.items) ? result.items : [],
    });
  }
  const successful = results.filter((result) => result.status === 'succeeded');
  const textValues = [...new Set(successful.map((result) => result.text.trim()).filter(Boolean))];
  const formats = [...new Set(successful.map((result) => result.format).filter(Boolean))];
  const detections = successful.flatMap((result) => result.items.map((item) => ({
    ...item,
    framePath: result.path,
    timeSeconds: result.timeSeconds,
  })));
  return {
    status: successful.length ? 'succeeded' : results[0].status,
    text: textValues.join('\n'),
    message: results.find((result) => result.message)?.message || '',
    format: formats.length === 1 ? formats[0] : formats.length ? 'mixed' : null,
    detections,
    frames: results,
  };
}

function frameTimesWithinDuration(values, durationSeconds) {
  const duration = Number(durationSeconds);
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0 && (!Number.isFinite(duration) || duration <= 0 || value < duration))
    .map((value) => Number(value.toFixed(3))))].sort((left, right) => left - right);
}

function uniformFrameTimes(durationSeconds, count) {
  return frameTimesWithinDuration(
    Array.from({ length: count }, (_, index) => Number(((durationSeconds * index) / count).toFixed(3))),
    durationSeconds,
  );
}

async function detectSceneChangeTimes(filePath, durationSeconds, options = {}) {
  const duration = Number(durationSeconds);
  const configuredThreshold = Number(options.sceneThreshold);
  const threshold = Number.isFinite(configuredThreshold)
    ? Math.min(1, Math.max(0, configuredThreshold))
    : 0.35;
  const configuredMaxDuration = Number(options.maxSceneDetectionSeconds);
  const maxDuration = Number.isFinite(configuredMaxDuration) && configuredMaxDuration > 0
    ? configuredMaxDuration
    : 300;
  if (!Number.isFinite(duration) || duration <= 0) {
    return { status: 'skipped', threshold, times: [], message: '缺少有效时长，跳过场景检测' };
  }
  if (duration > maxDuration) {
    return { status: 'bounded', threshold, times: [], message: `视频超过 ${maxDuration} 秒场景检测上限，使用均匀采样` };
  }
  try {
    const { stderr } = await runCommand('ffmpeg', [
      '-hide_banner', '-loglevel', 'info',
      '-i', filePath,
      '-vf', `select='gt(scene,${threshold})',showinfo`,
      '-an', '-f', 'null', '-',
    ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const matches = String(stderr || '').matchAll(/pts_time:([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g);
    const times = frameTimesWithinDuration(
      [...matches].map((match) => Number(match[1])).filter((value) => value > 0),
      duration,
    );
    return {
      status: times.length ? 'succeeded' : 'no_changes',
      threshold,
      times,
      message: times.length ? '' : '未检测到超过阈值的镜头变化',
    };
  } catch (error) {
    return {
      status: error.code === 'TOOL_UNAVAILABLE' ? 'unavailable' : 'failed',
      threshold,
      times: [],
      message: error.message || '场景检测失败，使用均匀采样',
    };
  }
}

function selectSceneFrameTimes(sceneTimes, fallbackTimes, count) {
  const detected = frameTimesWithinDuration([0, ...sceneTimes], null);
  if (count < 2 || detected.length < 2) return { strategy: 'uniform', times: fallbackTimes };
  if (detected.length >= count) {
    const indexes = count === 1
      ? [0]
      : Array.from({ length: count }, (_, index) => Math.round((detected.length - 1) * index / (count - 1)));
    return { strategy: 'scene', times: frameTimesWithinDuration(indexes.map((index) => detected[index]), null) };
  }
  const extras = fallbackTimes
    .filter((timeSeconds) => !detected.includes(timeSeconds))
    .slice(0, Math.max(0, count - detected.length));
  return {
    strategy: 'scene',
    times: frameTimesWithinDuration([...detected, ...extras], null).slice(0, count),
  };
}

export async function extractKeyframes(filePath, outputDir, assetId, options = {}) {
  await mkdir(outputDir, { recursive: true });
  const durationSeconds = Number(options.durationSeconds);
  const requestedCount = Number.isInteger(options.count) && options.count > 0 ? options.count : 6;
  const count = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.min(requestedCount, Math.max(1, Math.ceil(durationSeconds)))
    : 1;
  const fallbackTimes = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? uniformFrameTimes(durationSeconds, count)
    : [0];
  const sceneDetection = options.sceneDetect === false
    ? { status: 'disabled', threshold: null, times: [], message: '已禁用场景检测' }
    : await detectSceneChangeTimes(filePath, durationSeconds, options);
  const selected = selectSceneFrameTimes(sceneDetection.times, fallbackTimes, count);
  const times = selected.times;
  const frames = [];
  for (const [index, timeSeconds] of times.entries()) {
    const outputPath = join(outputDir, `${assetId}-keyframe-${String(index + 1).padStart(2, '0')}.jpg`);
    await runCommand('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(timeSeconds), '-i', filePath,
      '-frames:v', '1', '-q:v', '2', outputPath,
    ], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    frames.push({ path: outputPath, timeSeconds });
  }
  return {
    status: 'succeeded',
    strategy: selected.strategy,
    sceneDetection: {
      status: sceneDetection.status,
      threshold: sceneDetection.threshold,
      message: sceneDetection.message,
    },
    sceneTimes: sceneDetection.times,
    count: frames.length,
    path: frames[0].path,
    paths: frames.map((frame) => frame.path),
    frames,
  };
}

export async function extractKeyframe(filePath, outputDir, assetId) {
  return (await extractKeyframes(filePath, outputDir, assetId, { count: 1 })).path;
}

export async function parseMediaAsset(inputPath, options = {}) {
  const filePath = await resolveLocalMediaPath(inputPath, options.allowedRoots || []);
  const fileStat = await stat(filePath);
  const kind = mediaKindForPath(filePath);
  const mimeType = mimeTypeForPath(filePath);
  const digest = await hashFile(filePath);
  const assetId = 'asset_' + digest.slice(0, 20);
  let media = null;
  let textContent = '';
  let parseMessage = '';

  if (kind === 'text') {
    textContent = await readTextMaterial(filePath, fileStat);
  } else {
    try {
      media = await probeWithFfprobe(filePath);
    } catch (error) {
      parseMessage = error.code === 'TOOL_UNAVAILABLE' ? error.message : '媒体探测失败：' + error.message;
    }
  }

  let keyframe = { status: 'not_applicable', path: '', message: '' };
  if (['video', 'image'].includes(kind) && options.previewDir) {
    try {
      keyframe = await extractKeyframes(filePath, options.previewDir, assetId, {
        durationSeconds: media?.format?.duration,
        count: kind === 'image' ? 1 : 6,
      });
      keyframe.message = '';
    } catch (error) {
      keyframe = {
        status: 'unavailable',
        path: '',
        message: error.code === 'TOOL_UNAVAILABLE' ? error.message : '关键帧提取失败：' + error.message,
      };
    }
  }

  const capabilities = await runtimeCapabilities();
  let transcriptResult = { status: 'not_applicable', text: '', message: '' };
  if (['video', 'audio'].includes(kind)) {
    transcriptResult = await transcribeMediaAsset(filePath, { allowedRoots: options.allowedRoots });
  }
  const ocrFrames = keyframe.status === 'succeeded' && keyframe.path
    ? (Array.isArray(keyframe.frames) && keyframe.frames.length ? keyframe.frames : [{ path: keyframe.path, timeSeconds: 0 }])
    : [{ path: filePath, timeSeconds: null }];
  const ocrResult = ['video', 'image'].includes(kind)
    ? await ocrFrameSet(ocrFrames, process.env.XHS_OCR_COMMAND ? null : capabilities.nativeOcr ? await findNativeOcrScript() : null)
    : { status: 'not_applicable', text: '', message: '' };

  const transcript = transcriptResult.text || '';
  const ocrText = ocrResult.text || '';
  const transcriptConfidence = transcriptResult.confidence && typeof transcriptResult.confidence === 'object'
    ? transcriptResult.confidence
    : summarizeTranscriptConfidence(transcriptResult.segments);
  const searchableText = [textContent, transcript, ocrText].filter(Boolean).join('\n\n');
  return {
    id: assetId,
    path: filePath,
    relativePath: options.baseDir ? relative(options.baseDir, filePath) : filePath,
    filename: basename(filePath),
    kind,
    mimeType,
    contentHash: digest,
    sizeBytes: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    status: parseMessage ? 'partial' : 'parsed',
    metadata: {
      media,
      contentHash: digest,
      keyframe,
      textStats: textSignals(searchableText),
      capabilities,
      parseMessage,
    },
    textContent,
    transcript,
    transcriptResult: {
      status: transcriptResult.status,
      message: transcriptResult.message,
      format: transcriptResult.format || null,
      segments: Array.isArray(transcriptResult.segments) ? transcriptResult.segments : [],
      confidence: transcriptConfidence,
    },
    ocrText,
    ocrResult: {
      status: ocrResult.status,
      message: ocrResult.message,
      format: ocrResult.format || null,
      detections: Array.isArray(ocrResult.detections) ? ocrResult.detections : [],
      frames: Array.isArray(ocrResult.frames) ? ocrResult.frames : [],
    },
  };
}

export function analyzeContentStructure(textContent, options = {}) {
  const normalized = String(textContent || '').replace(/\r\n?/g, '\n').trim();
  const sourceSegments = (Array.isArray(options.sourceSegments) ? options.sourceSegments : [])
    .map((segment) => {
      const confidence = normalizedConfidence(segment?.confidence);
      return {
        assetId: text(segment?.assetId),
        filename: text(segment?.filename),
        start: Number(segment?.start),
        end: Number(segment?.end),
        text: text(segment?.text),
        ...(confidence === null ? {} : { confidence }),
      };
    })
    .filter((segment) => segment.assetId && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.end > segment.start && segment.text)
    .slice(0, 200);
  const sourceFrames = (Array.isArray(options.sourceFrames) ? options.sourceFrames : [])
    .map((frame) => {
      const assetId = text(frame?.assetId);
      const filename = text(frame?.filename);
      const rawTimeSeconds = Number(frame?.timeSeconds);
      const timeSeconds = Number.isFinite(rawTimeSeconds) && rawTimeSeconds >= 0
        ? Number(rawTimeSeconds.toFixed(3))
        : null;
      const detections = (Array.isArray(frame?.detections) ? frame.detections : [])
        .map((detection) => {
          const detectionText = text(detection?.text);
          if (!detectionText) return null;
          const confidence = normalizedConfidence(detection?.confidence);
          const box = normalizedOcrBox(detection?.box);
          const coordinateSystem = text(detection?.coordinateSystem);
          return {
            text: detectionText,
            ...(confidence === null ? {} : { confidence }),
            ...(box ? { box } : {}),
            ...(coordinateSystem ? { coordinateSystem } : {}),
          };
        })
        .filter(Boolean)
        .slice(0, 500);
      const frameText = text(frame?.text) || detections.map((detection) => detection.text).join('\n');
      if (!assetId || (timeSeconds === null && !frameText && !detections.length)) return null;
      return {
        assetId,
        filename,
        timeSeconds,
        text: frameText,
        detections,
      };
    })
    .filter(Boolean)
    .slice(0, 200);
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const segments = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^(?:#{1,6}\s+|\d+[.、)]\s*)(.+)$/);
    if (heading) {
      current = { title: heading[1].trim(), lines: [] };
      segments.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      current = { title: '开场/未命名段落', lines: [line] };
      segments.push(current);
    }
  }
  const summary = segments.slice(0, 6).map((segment) => {
    const body = segment.lines.join(' ').replace(/\s+/g, ' ').trim();
    const excerpt = body.length > 96 ? body.slice(0, 96) + '…' : body;
    return excerpt ? `${segment.title}：${excerpt}` : segment.title;
  }).join('；') || (normalized ? normalized.replace(/\s+/g, ' ').slice(0, 160) : '');
  const evidenceGaps = [];
  if (!sourceSegments.length && !sourceFrames.length) evidenceGaps.push('未提供可定位的语音或画面来源');
  if (sourceSegments.some((segment) => segment.confidence === undefined)) evidenceGaps.push('部分转写片段缺少置信度，需人工校对');
  if (sourceFrames.some((frame) => frame.text && !frame.detections.length)) evidenceGaps.push('部分画面文字缺少位置框，需人工校对');
  if (!normalized) evidenceGaps.push('没有可分析文本');
  const openingText = segments[0]?.lines.join('\n').trim() || segments[0]?.title || '';
  return {
    analysisMode: 'deterministic-extractive',
    segmentCount: segments.length,
    summary,
    opening: openingText ? { text: openingText, source: 'text' } : null,
    rhythm: {
      segmentCount: segments.length,
      characterCounts: segments.map((segment) => segment.lines.join('').length),
    },
    evidenceGaps,
    sourceSegments,
    sourceFrames,
    segments: segments.map((segment, index) => ({
      order: index + 1,
      title: segment.title,
      text: segment.lines.join('\n'),
      characterCount: segment.lines.join('').length,
    })),
    signals: textSignals(normalized),
  };
}

async function resolveTemplateMediaPath(reference, options, label, expectedKinds = []) {
  const value = String(reference || '').trim();
  if (!value) return null;
  let candidate = value;
  if (/^file:/i.test(value)) {
    try {
      candidate = fileURLToPath(new URL(value));
    } catch {
      const error = new Error(label + '不是有效的 file:// 引用');
      error.code = 'MEDIA_TEMPLATE_INPUT_INVALID';
      throw error;
    }
  }
  if (!isAbsolute(candidate)) {
    const error = new Error(label + '必须是允许目录内的本地文件');
    error.code = 'MEDIA_TEMPLATE_INPUT_INVALID';
    throw error;
  }
  try {
    const resolved = await resolveLocalMediaPath(candidate, options.allowedRoots || []);
    if (expectedKinds.length && !expectedKinds.includes(mediaKindForPath(resolved))) {
      const error = new Error(label + '的媒体类型不正确');
      error.code = 'MEDIA_TEMPLATE_INPUT_INVALID';
      throw error;
    }
    return resolved;
  } catch (error) {
    if (error.code === 'MEDIA_TEMPLATE_INPUT_INVALID') throw error;
    const wrapped = new Error(label + '必须是允许目录内的可读文件');
    wrapped.code = 'MEDIA_TEMPLATE_INPUT_INVALID';
    throw wrapped;
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 1 ? number : fallback;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function logoCoordinate(value, fallback) {
  return Number.isFinite(Number(value)) ? String(Math.round(Number(value))) : fallback;
}

function templateFor(options) {
  return options.template && typeof options.template === 'object' ? options.template : options;
}

function templateVersionId(template) {
  return text(template.versionId || template.id, 'standard_vertical_v1');
}

function templateLogoSettings(template, width, height) {
  return {
    width: positiveInteger(template.logoWidth, Math.min(240, Math.max(2, Math.round(width * 0.22)))),
    x: logoCoordinate(template.logoX, `main_w-overlay_w-${Math.max(0, Math.round(width * 0.067))}`),
    y: logoCoordinate(template.logoY, String(Math.max(0, Math.round(height * 0.038)))),
    opacity: boundedNumber(template.logoOpacity, 1, 0, 1),
  };
}

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function coverTextLines(value, maxCharacters) {
  const lines = [];
  for (const rawLine of String(value || '').replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    for (const character of Array.from(rawLine.trim())) {
      if (line.length >= maxCharacters) {
        lines.push(line);
        line = '';
      }
      line += character;
    }
    if (line || !lines.length) lines.push(line);
  }
  return lines.slice(0, 8);
}

function coverTextSvg(template, width, height) {
  const coverText = text(template.coverText, '');
  if (!coverText) return null;
  const safeArea = template.safeArea && typeof template.safeArea === 'object' ? template.safeArea : {};
  const safeNumber = (value, fallback) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value)) : fallback;
  const left = safeNumber(safeArea.left, 72);
  const right = safeNumber(safeArea.right, 72);
  const bottom = safeNumber(safeArea.bottom, 240);
  const fontSize = Math.round(boundedNumber(template.coverFontSize || template.captionFontSize, Math.max(44, Math.round(width * 0.07)), 24, 240));
  const maxCharacters = Math.max(1, Math.floor(Math.max(1, width - left - right) / Math.max(1, fontSize * 0.95)));
  const lines = coverTextLines(coverText, maxCharacters);
  const lineHeight = Math.round(fontSize * 1.2);
  const firstBaseline = Math.max(fontSize, height - bottom - (lines.length - 1) * lineHeight);
  const fontName = xmlEscape(text(template.coverFontName || template.captionFontName, 'Arial').replace(/[\r\n]/g, ' '));
  const fill = /^#[0-9a-f]{6}$/i.test(String(template.coverTextColor || '')) ? template.coverTextColor : '#ffffff';
  const stroke = /^#[0-9a-f]{6}$/i.test(String(template.coverTextStroke || '')) ? template.coverTextStroke : '#000000';
  const tspans = lines.map((line, index) => `<tspan x="${left}" dy="${index ? lineHeight : 0}">${xmlEscape(line)}</tspan>`).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="${left}" y="${firstBaseline}" font-family="${fontName}" font-size="${fontSize}" font-weight="700" fill="${fill}" stroke="${stroke}" stroke-width="${Math.max(2, Math.round(fontSize / 14))}" paint-order="stroke" stroke-linejoin="round">${tspans}</text></svg>`);
}

function captionTextSvg(template, width, height, segment) {
  const safeArea = template.safeArea && typeof template.safeArea === 'object' ? template.safeArea : {};
  const safeNumber = (value, fallback) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value)) : fallback;
  const left = safeNumber(safeArea.left, 72);
  const right = safeNumber(safeArea.right, 72);
  const bottom = safeNumber(safeArea.bottom, 240);
  const fontSize = Math.round(boundedNumber(template.captionFontSize, Math.max(30, Math.round(width * 0.05)), 18, 180));
  const maxCharacters = Math.max(1, Math.floor(Math.max(1, width - left - right) / Math.max(1, fontSize * 0.95)));
  const lines = coverTextLines(segment.text, maxCharacters);
  const lineHeight = Math.round(fontSize * 1.2);
  const paddingX = Math.max(8, Math.round(fontSize * 0.45));
  const paddingY = Math.max(6, Math.round(fontSize * 0.28));
  const firstBaseline = Math.max(fontSize, height - bottom - paddingY - (lines.length - 1) * lineHeight);
  const boxX = Math.max(0, left - paddingX);
  const boxRight = Math.min(width, width - right + paddingX);
  const boxY = Math.max(0, firstBaseline - fontSize - paddingY);
  const boxHeight = Math.max(2, Math.min(height - boxY, lines.length * lineHeight + paddingY * 2));
  const fontName = xmlEscape(text(template.captionFontName, 'Arial').replace(/[\r\n]/g, ' '));
  const fill = /^#[0-9a-f]{6}$/i.test(String(template.captionTextColor || '')) ? template.captionTextColor : '#ffffff';
  const stroke = /^#[0-9a-f]{6}$/i.test(String(template.captionTextStroke || '')) ? template.captionTextStroke : '#000000';
  const background = /^#[0-9a-f]{6}$/i.test(String(template.captionBackgroundColor || '')) ? template.captionBackgroundColor : '#000000';
  const backgroundOpacity = boundedNumber(template.captionBackgroundOpacity, 0.72, 0, 1);
  const tspans = lines.map((line, index) => `<tspan x="${left}" dy="${index ? lineHeight : 0}">${xmlEscape(line)}</tspan>`).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${boxX}" y="${boxY}" width="${Math.max(2, boxRight - boxX)}" height="${boxHeight}" rx="${Math.round(fontSize * 0.22)}" fill="${background}" fill-opacity="${backgroundOpacity}"/><text x="${left}" y="${firstBaseline}" font-family="${fontName}, sans-serif" font-size="${fontSize}" font-weight="700" fill="${fill}" stroke="${stroke}" stroke-width="${Math.max(1.5, Math.round(fontSize / 18))}" paint-order="stroke" stroke-linejoin="round">${tspans}</text></svg>`);
}

async function coverFrame(inputPath, outputDir, label) {
  if (mediaKindForPath(inputPath) === 'image') return inputPath;
  const outputPath = join(outputDir, label + '.png');
  await runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath, '-map', '0:v:0', '-frames:v', '1', '-vf', 'format=rgba', outputPath,
  ], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  return outputPath;
}

function coverLogoPosition(template, width, height, logoWidth) {
  const defaultMarginX = Math.max(0, Math.round(width * 0.067));
  const x = Number.isFinite(Number(template.logoX)) ? Math.round(Number(template.logoX)) : width - logoWidth - defaultMarginX;
  const y = Number.isFinite(Number(template.logoY)) ? Math.round(Number(template.logoY)) : Math.max(0, Math.round(height * 0.038));
  return {
    left: Math.max(0, Math.min(Math.max(0, width - logoWidth), x)),
    top: Math.max(0, Math.min(Math.max(0, height - 2), y)),
  };
}

export async function renderVideo(inputPath, outputPath, options = {}) {
  const filePath = await resolveLocalMediaPath(inputPath, options.allowedRoots || []);
  const template = templateFor(options);
  const width = positiveInteger(template.width || options.width, 1080);
  const height = positiveInteger(template.height || options.height, 1920);
  const fps = boundedNumber(template.fps, 30, 1, 120);
  const backgroundColor = text(template.backgroundColor || options.backgroundColor, 'black');
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('渲染画布必须是大于 2 的偶数尺寸');
  if (!/^[a-zA-Z0-9#]+$/.test(backgroundColor)) throw new Error('渲染背景色格式不正确');

  const backgroundPath = await resolveTemplateMediaPath(template.backgroundRef, options, '模板背景', ['image', 'video']);
  const logoPath = await resolveTemplateMediaPath(template.logoRef, options, '模板 Logo', ['image', 'video']);
  const musicPath = await resolveTemplateMediaPath(template.musicRef, options, '模板音乐', ['audio']);
  const introPath = await resolveTemplateMediaPath(template.introRef, options, '模板片头', ['video']);
  const outroPath = await resolveTemplateMediaPath(template.outroRef, options, '模板片尾', ['video']);
  const segmentPaths = [introPath, filePath, outroPath].filter(Boolean);
  const segmentProbes = await Promise.all(segmentPaths.map((path) => probeWithFfprobe(path)));
  if (segmentProbes.some((probe) => !probe.streams.some((stream) => stream.codec_type === 'video'))) {
    const error = new Error('模板片段缺少视频流');
    error.code = 'MEDIA_TEMPLATE_INPUT_INVALID';
    throw error;
  }
  const subtitleOffsetSeconds = introPath && Number.isFinite(Number(segmentProbes[0]?.format?.duration))
    ? Math.max(0, Number(segmentProbes[0].format.duration))
    : 0;
  const subtitleSegments = timedSubtitleSegments(options.subtitleSegments).map((segment) => ({
    ...segment,
    start: segment.start + subtitleOffsetSeconds,
    end: segment.end + subtitleOffsetSeconds,
  }));

  const segmentHasAudio = segmentProbes.map((probe) => probe.streams.some((stream) => stream.codec_type === 'audio'));
  const hasAudioSegments = segmentHasAudio.some(Boolean);
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const path of segmentPaths) args.push('-i', path);
  let nextInput = segmentPaths.length;
  const audioInputIndexes = segmentHasAudio.map((hasAudio, index) => {
    if (hasAudio) return index;
    if (!hasAudioSegments) return null;
    const duration = Number(segmentProbes[index].format?.duration);
    args.push('-f', 'lavfi', '-t', String(Number.isFinite(duration) && duration > 0 ? duration : 1), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    return nextInput++;
  });

  let backgroundIndex = null;
  if (backgroundPath) {
    const backgroundKind = mediaKindForPath(backgroundPath);
    args.push(backgroundKind === 'image' ? '-loop' : '-stream_loop', '1', '-i', backgroundPath);
    backgroundIndex = nextInput++;
  }
  let logoIndex = null;
  if (logoPath) {
    const logoKind = mediaKindForPath(logoPath);
    args.push(logoKind === 'image' ? '-loop' : '-stream_loop', '1', '-i', logoPath);
    logoIndex = nextInput++;
  }
  let musicIndex = null;
  if (musicPath) {
    args.push('-stream_loop', '-1', '-i', musicPath);
    musicIndex = nextInput++;
  }

  let subtitleOverlayDir = null;
  const subtitleInputIndexes = [];
  if (subtitleSegments.length) {
    subtitleOverlayDir = await mkdtemp(join(tmpdir(), 'cloud-worker-caption-'));
    try {
      for (const [index, segment] of subtitleSegments.entries()) {
        const overlayPath = join(subtitleOverlayDir, `caption-${String(index + 1).padStart(4, '0')}.png`);
        const overlay = await sharp(captionTextSvg(template, width, height, segment)).png().toBuffer();
        await writeFile(overlayPath, overlay);
        args.push(
          '-loop', '1',
          '-framerate', String(Math.max(1, Math.round(fps))),
          '-t', String(Math.max(0.1, segment.end + 0.05)),
          '-i', overlayPath,
        );
        subtitleInputIndexes.push(nextInput++);
      }
    } catch (error) {
      await rm(subtitleOverlayDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  const filters = [];
  const videoLabels = [];
  const audioLabels = [];
  for (const [index, path] of segmentPaths.entries()) {
    const videoLabel = `segment_video_${index}`;
    filters.push(`[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${backgroundColor},fps=${fps},setsar=1,format=yuv420p,setpts=PTS-STARTPTS[${videoLabel}]`);
    videoLabels.push(videoLabel);
    if (hasAudioSegments) {
      const audioLabel = `segment_audio_${index}`;
      filters.push(`[${audioInputIndexes[index]}:a]aresample=48000,asetpts=PTS-STARTPTS[${audioLabel}]`);
      audioLabels.push(audioLabel);
    }
  }

  let videoLabel;
  let audioLabel = null;
  if (videoLabels.length > 1) {
    const concatOutputs = audioLabels.length ? '[concatenated_video][concatenated_audio]' : '[concatenated_video]';
    const concatInputs = videoLabels.map((label, index) => `[${label}]${audioLabels.length ? `[${audioLabels[index]}]` : ''}`).join('');
    filters.push(concatInputs + `concat=n=${videoLabels.length}:v=1:a=${audioLabels.length ? 1 : 0}${concatOutputs}`);
    videoLabel = 'concatenated_video';
    audioLabel = audioLabels.length ? 'concatenated_audio' : null;
  } else {
    videoLabel = videoLabels[0];
    audioLabel = audioLabels[0] || null;
  }

  if (backgroundIndex !== null) {
    const backgroundLabel = 'template_background';
    filters.push(`[${backgroundIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},setsar=1,format=yuv420p[${backgroundLabel}]`);
    filters.push(`[${backgroundLabel}][${videoLabel}]overlay=shortest=1:eof_action=repeat:format=auto[background_composite]`);
    videoLabel = 'background_composite';
  }
  if (logoIndex !== null) {
    const logo = templateLogoSettings(template, width, height);
    const logoLabel = 'template_logo';
    const opacityFilter = logo.opacity < 1 ? `,colorchannelmixer=aa=${logo.opacity}` : '';
    filters.push(`[${logoIndex}:v]scale=${logo.width}:-2:force_original_aspect_ratio=decrease,format=rgba${opacityFilter}[${logoLabel}]`);
    filters.push(`[${videoLabel}][${logoLabel}]overlay=x=${logo.x}:y=${logo.y}:shortest=1:eof_action=repeat:format=auto[logo_composite]`);
    videoLabel = 'logo_composite';
  }

  if (musicIndex !== null) {
    const musicVolume = boundedNumber(template.musicVolume, 0.12, 0, 2);
    filters.push(`[${musicIndex}:a]aresample=48000,volume=${musicVolume}[template_music]`);
    if (audioLabel) {
      filters.push(`[${audioLabel}][template_music]amix=inputs=2:duration=first:dropout_transition=2,loudnorm=I=-16:TP=-1.5:LRA=11[rendered_audio]`);
    } else {
      filters.push('[template_music]loudnorm=I=-16:TP=-1.5:LRA=11[rendered_audio]');
    }
    audioLabel = 'rendered_audio';
  } else if (audioLabel) {
    filters.push(`[${audioLabel}]loudnorm=I=-16:TP=-1.5:LRA=11[rendered_audio]`);
    audioLabel = 'rendered_audio';
  }

  for (const [index, inputIndex] of subtitleInputIndexes.entries()) {
    const segment = subtitleSegments[index];
    const captionLabel = `caption_${index}`;
    const compositeLabel = `caption_composite_${index}`;
    filters.push(`[${inputIndex}:v]format=rgba[${captionLabel}]`);
    filters.push(`[${videoLabel}][${captionLabel}]overlay=shortest=0:eof_action=pass:repeatlast=0:format=auto:enable='between(t,${segment.start},${segment.end})'[${compositeLabel}]`);
    videoLabel = compositeLabel;
  }

  try {
    await mkdir(dirname(outputPath), { recursive: true });
    args.push('-filter_complex', filters.join(';'), '-map', `[${videoLabel}]`);
    if (audioLabel) args.push('-map', `[${audioLabel}]`, '-c:a', 'aac');
    args.push(
      '-c:v', 'libx264', '-preset', options.preset || 'veryfast', '-crf', String(options.crf || 23),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    );
    if ((backgroundIndex !== null || logoIndex !== null || musicIndex !== null) && !subtitleSegments.length) args.push('-shortest');
    args.push(outputPath);
    await runCommand('ffmpeg', args, { timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
  } finally {
    if (subtitleOverlayDir) await rm(subtitleOverlayDir, { recursive: true, force: true }).catch(() => {});
  }
  const outputStat = await stat(outputPath);
  return {
    path: outputPath,
    filename: basename(outputPath),
    sizeBytes: outputStat.size,
    relativePath: options.baseDir ? relative(options.baseDir, outputPath) : outputPath,
    width,
    height,
    template: templateVersionId(template),
    templateVersionId: templateVersionId(template),
    layers: {
      intro: Boolean(introPath),
      outro: Boolean(outroPath),
      background: Boolean(backgroundPath),
      logo: Boolean(logoPath),
      music: Boolean(musicPath),
    },
    audioNormalization: audioLabel ? 'ebu_r128_loudnorm' : 'none',
    subtitleBurnIn: subtitleSegments.length ? 'sharp_overlay' : 'none',
    subtitleSegmentCount: subtitleSegments.length,
    subtitleTimecodeOffsetSeconds: subtitleOffsetSeconds,
  };
}

export async function renderCover(inputPath, outputPath, options = {}) {
  const filePath = await resolveLocalMediaPath(inputPath, options.allowedRoots || []);
  const template = templateFor(options);
  const width = positiveInteger(template.width || options.width, 1080);
  const height = positiveInteger(template.height || options.height, 1440);
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('封面画布必须是大于 2 的偶数尺寸');
  if (!['image', 'video'].includes(mediaKindForPath(filePath))) {
    const error = new Error('封面输入必须是图片或视频');
    error.code = 'MEDIA_COVER_INPUT_INVALID';
    throw error;
  }
  const backgroundPath = await resolveTemplateMediaPath(template.backgroundRef, options, '模板背景', ['image', 'video']);
  const logoPath = await resolveTemplateMediaPath(template.logoRef, options, '模板 Logo', ['image', 'video']);
  const workDir = await mkdtemp(join(tmpdir(), 'cloud-worker-cover-'));
  const coverText = text(template.coverText, '');
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    const sourceFrame = await coverFrame(filePath, workDir, 'source');
    const sourceImage = await sharp(sourceFrame)
      .resize({
        width,
        height,
        fit: backgroundPath ? 'contain' : 'cover',
        position: 'centre',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    const composites = [];
    let baseImage = sharp(sourceImage);
    if (backgroundPath) {
      const backgroundFrame = await coverFrame(backgroundPath, workDir, 'background');
      const backgroundImage = await sharp(backgroundFrame).resize(width, height, { fit: 'cover', position: 'centre' }).png().toBuffer();
      baseImage = sharp(backgroundImage);
      composites.push({ input: sourceImage, left: 0, top: 0 });
    }
    if (logoPath) {
      const logo = templateLogoSettings(template, width, height);
      const logoFrame = await coverFrame(logoPath, workDir, 'logo');
      const logoRaw = await sharp(logoFrame).resize({ width: Math.min(width, logo.width), fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (logo.opacity < 1) {
        for (let index = 3; index < logoRaw.data.length; index += logoRaw.info.channels) {
          logoRaw.data[index] = Math.round(logoRaw.data[index] * logo.opacity);
        }
      }
      const logoBuffer = await sharp(logoRaw.data, { raw: logoRaw.info }).png().toBuffer();
      const position = coverLogoPosition(template, width, height, logoRaw.info.width);
      composites.push({ input: logoBuffer, left: position.left, top: position.top });
    }
    const textOverlay = coverTextSvg(template, width, height);
    if (textOverlay) composites.push({ input: textOverlay, left: 0, top: 0 });
    await baseImage.composite(composites).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toFile(outputPath);
    const outputStat = await stat(outputPath);
    return {
      path: outputPath,
      filename: basename(outputPath),
      sizeBytes: outputStat.size,
      relativePath: options.baseDir ? relative(options.baseDir, outputPath) : outputPath,
      width,
      height,
      format: 'jpeg',
      template: templateVersionId(template),
      templateVersionId: templateVersionId(template),
      layers: { background: Boolean(backgroundPath), logo: Boolean(logoPath), text: Boolean(coverText) },
      text: coverText,
      textRendered: Boolean(textOverlay),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function packageFiles(files, outputPath, options = {}) {
  const validFiles = files.filter((file) => typeof file === 'string' && file.trim());
  if (!validFiles.length) throw new Error('没有可打包的文件');
  await mkdir(dirname(outputPath), { recursive: true });
  if (process.platform === 'win32') {
    const powershellLiteral = (value) => "'" + String(value).replaceAll("'", "''") + "'";
    const literalFiles = validFiles.map(powershellLiteral).join(', ');
    const command = [
      "$ErrorActionPreference = 'Stop'",
      `Compress-Archive -LiteralPath @(${literalFiles}) -DestinationPath ${powershellLiteral(outputPath)} -Force`,
    ].join('; ');
    await runCommand('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } else {
    await runCommand('zip', ['-j', '-q', '-FS', outputPath, ...validFiles], {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  }
  const outputStat = await stat(outputPath);
  return {
    path: outputPath,
    filename: basename(outputPath),
    sizeBytes: outputStat.size,
    relativePath: options.baseDir ? relative(options.baseDir, outputPath) : outputPath,
  };
}
