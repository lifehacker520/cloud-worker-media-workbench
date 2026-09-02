import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    aiGeneration: Boolean(process.env.DEEPSEEK_API_KEY),
  };
}

async function findNativeOcrScript() {
  for (const candidate of NATIVE_OCR_SCRIPT_CANDIDATES) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return null;
}

async function probeWithFfprobe(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=format_name,duration,size,bit_rate:stream=index,codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels,channel_layout',
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
    streams: Array.isArray(parsed.streams) ? parsed.streams : [],
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
    return {
      status: 'succeeded',
      text: output,
      message: String(stderr || '').trim().slice(0, 500),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      text: '',
      message: error.code === 'TOOL_UNAVAILABLE' ? error.message : '本地命令执行失败：' + error.message,
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

async function whisperCliTranscript(filePath, kind, runtime) {
  if (!runtime.available || !runtime.model) {
    return { status: 'not_configured', text: '', message: '未配置 XHS_WHISPER_MODEL，且没有可用的 whisper-cli 模型' };
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
    return {
      status: 'succeeded',
      text: transcriptText.trim(),
      message: String(stderr || '').trim().slice(-1_000),
      format: srt ? 'srt' : 'text',
      segments: parseSrtSegments(srt),
    };
  } catch (error) {
    return {
      status: error.code === 'TOOL_UNAVAILABLE' ? 'not_configured' : 'unavailable',
      text: '',
      message: error.code === 'TOOL_UNAVAILABLE' ? error.message : 'whisper-cli 转写失败：' + error.message,
      format: null,
      segments: [],
    };
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function nativeOcr(filePath, scriptPath) {
  try {
    const { stdout, stderr } = await runCommand('swift', [scriptPath, filePath], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      status: 'succeeded',
      text: String(stdout || '').trim(),
      message: String(stderr || '').trim().slice(0, 500),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      text: '',
      message: error.code === 'TOOL_UNAVAILABLE' ? error.message : 'Vision OCR 执行失败：' + error.message,
    };
  }
}

export async function extractKeyframe(filePath, outputDir, assetId) {
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, assetId + '-keyframe.jpg');
  await runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', '0', '-i', filePath,
    '-frames:v', '1', '-q:v', '2', outputPath,
  ], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  return outputPath;
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
      keyframe = {
        status: 'succeeded',
        path: await extractKeyframe(filePath, options.previewDir, assetId),
        message: '',
      };
    } catch (error) {
      keyframe = {
        status: 'unavailable',
        path: '',
        message: error.code === 'TOOL_UNAVAILABLE' ? error.message : '关键帧提取失败：' + error.message,
      };
    }
  }

  const capabilities = await runtimeCapabilities();
  const whisperRuntime = await resolveWhisperRuntime();
  let transcriptResult = { status: 'not_applicable', text: '', message: '' };
  if (['video', 'audio'].includes(kind)) {
    transcriptResult = splitConfiguredCommand(process.env.XHS_TRANSCRIBE_COMMAND).length
      ? await optionalTextCommand('XHS_TRANSCRIBE_COMMAND', filePath)
      : await whisperCliTranscript(filePath, kind, whisperRuntime);
  }
  const ocrInput = keyframe.status === 'succeeded' && keyframe.path ? keyframe.path : filePath;
  const ocrResult = ['video', 'image'].includes(kind)
    ? process.env.XHS_OCR_COMMAND
      ? await optionalTextCommand('XHS_OCR_COMMAND', ocrInput)
      : capabilities.nativeOcr
        ? await nativeOcr(ocrInput, await findNativeOcrScript())
        : { status: 'not_configured', text: '', message: '未配置 OCR 命令，且当前运行环境没有 macOS Vision' }
    : { status: 'not_applicable', text: '', message: '' };

  const transcript = transcriptResult.text || '';
  const ocrText = ocrResult.text || '';
  const searchableText = [textContent, transcript, ocrText].filter(Boolean).join('\n\n');
  return {
    id: assetId,
    path: filePath,
    relativePath: options.baseDir ? relative(options.baseDir, filePath) : filePath,
    filename: basename(filePath),
    kind,
    mimeType,
    sizeBytes: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    status: parseMessage ? 'partial' : 'parsed',
    metadata: {
      media,
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
    },
    ocrText,
    ocrResult: {
      status: ocrResult.status,
      message: ocrResult.message,
    },
  };
}

export function analyzeContentStructure(textContent) {
  const normalized = String(textContent || '').replace(/\r\n?/g, '\n').trim();
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
  return {
    segmentCount: segments.length,
    segments: segments.map((segment, index) => ({
      order: index + 1,
      title: segment.title,
      text: segment.lines.join('\n'),
      characterCount: segment.lines.join('').length,
    })),
    signals: textSignals(normalized),
  };
}

export async function renderVideo(inputPath, outputPath, options = {}) {
  const filePath = await resolveLocalMediaPath(inputPath, options.allowedRoots || []);
  await mkdir(dirname(outputPath), { recursive: true });
  await access(filePath);
  await runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', filePath,
    '-map', '0:v:0', '-map', '0:a?',
    '-vf', 'scale=trunc(min(1080\\,iw)/2)*2:-2',
    '-c:v', 'libx264', '-preset', options.preset || 'veryfast', '-crf', String(options.crf || 23),
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart',
    outputPath,
  ], { timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
  const outputStat = await stat(outputPath);
  return {
    path: outputPath,
    filename: basename(outputPath),
    sizeBytes: outputStat.size,
    relativePath: options.baseDir ? relative(options.baseDir, outputPath) : outputPath,
  };
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
