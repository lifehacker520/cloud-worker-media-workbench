import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { test } from 'node:test';
import sharp from 'sharp';

import { analyzeContentStructure, extractKeyframes, mediaKindForPath, parseMediaAsset, parseSrtSegments, probeMediaFile, renderCover, renderVideo, segmentsToAss, segmentsToSrt, transcribeMediaAsset } from '../src/media-pipeline.mjs';

const execFileAsync = promisify(execFile);

async function hasFfmpeg() {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

test('local text material is parsed into searchable signals without fake AI output', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-media-'));
  const filePath = join(dataDir, 'brief.md');
  try {
    await writeFile(filePath, '# 业务目标\n让销售客服智能体持续工作\n\n## 受众\n中小企业老板\n', 'utf8');
    const parsed = await parseMediaAsset(filePath, { allowedRoots: [dataDir], baseDir: dataDir });
    assert.equal(mediaKindForPath(filePath), 'text');
    assert.equal(parsed.kind, 'text');
    assert.equal(parsed.status, 'parsed');
    assert.equal(parsed.transcriptResult.status, 'not_applicable');
    assert.match(parsed.textContent, /销售客服智能体/);
    assert.ok(parsed.metadata.textStats.headings.length >= 2);
    const expectedHash = createHash('sha256').update(await readFile(filePath)).digest('hex');
    assert.equal(parsed.contentHash, expectedHash);
    assert.equal(parsed.metadata.contentHash, expectedHash);
    assert.equal(analyzeContentStructure(parsed.textContent).segmentCount, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('local material parser rejects paths outside the configured root', async () => {
  const allowedDir = await mkdtemp(join(tmpdir(), 'cloud-worker-media-allowed-'));
  const outsideDir = await mkdtemp(join(tmpdir(), 'cloud-worker-media-outside-'));
  const filePath = join(outsideDir, 'brief.txt');
  try {
    await writeFile(filePath, '不应读取', 'utf8');
    await assert.rejects(
      () => parseMediaAsset(filePath, { allowedRoots: [allowedDir] }),
      /允许的本地目录/,
    );
  } finally {
    await Promise.all([
      rm(allowedDir, { recursive: true, force: true }),
      rm(outsideDir, { recursive: true, force: true }),
    ]);
  }
});

test('whisper SRT output is parsed into source timecoded segments', () => {
  const segments = parseSrtSegments(`1\n00:00:01,250 --> 00:00:03,500\n第一段口播\n\n2\n00:00:04.000 --> 00:00:05.750\n第二段口播`);
  assert.deepEqual(segments, [
    { start: 1.25, end: 3.5, text: '第一段口播' },
    { start: 4, end: 5.75, text: '第二段口播' },
  ]);
});

test('configured ASR SRT output is retained as timed transcript segments', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-transcript-command-'));
  const mediaPath = join(dataDir, 'voice.mp3');
  const commandPath = join(dataDir, 'transcribe.mjs');
  const previousCommand = process.env.XHS_TRANSCRIBE_COMMAND;
  const srt = `1\n00:00:00,250 --> 00:00:01,750\n第一句\n\n2\n00:00:02,000 --> 00:00:04,125\n第二句`;
  try {
    await writeFile(mediaPath, 'fixture', 'utf8');
    await writeFile(commandPath, `process.stdout.write(${JSON.stringify(srt)});\n`, 'utf8');
    process.env.XHS_TRANSCRIBE_COMMAND = `${process.execPath} ${commandPath}`;
    const parsed = await parseMediaAsset(mediaPath, { allowedRoots: [dataDir], baseDir: dataDir });
    assert.equal(parsed.transcriptResult.status, 'succeeded');
    assert.equal(parsed.transcriptResult.format, 'srt');
    assert.equal(parsed.transcript, '第一句\n第二句');
    assert.deepEqual(parsed.transcriptResult.segments, [
      { start: 0.25, end: 1.75, text: '第一句' },
      { start: 2, end: 4.125, text: '第二句' },
    ]);
    assert.equal(parsed.transcriptResult.confidence.status, 'unavailable');
    assert.equal(parsed.transcriptResult.confidence.requiresHumanReview, true);
    assert.deepEqual(parsed.transcriptResult.confidence.missingConfidenceSegments.map((item) => item.index), [0, 1]);
  } finally {
    if (previousCommand === undefined) delete process.env.XHS_TRANSCRIBE_COMMAND;
    else process.env.XHS_TRANSCRIBE_COMMAND = previousCommand;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('structured ASR output preserves confidence and marks segments for human review', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-transcript-confidence-'));
  const mediaPath = join(dataDir, 'voice.mp3');
  const commandPath = join(dataDir, 'transcribe.mjs');
  const previousCommand = process.env.XHS_TRANSCRIBE_COMMAND;
  const transcript = {
    segments: [
      { start: 0.25, end: 1.25, text: '高置信片段', confidence: 0.92 },
      { start: 1.5, end: 2.4, text: '低置信片段', confidence: 0.41 },
    ],
  };
  try {
    await writeFile(mediaPath, 'fixture', 'utf8');
    await writeFile(commandPath, `process.stdout.write(${JSON.stringify(JSON.stringify(transcript))});\n`, 'utf8');
    process.env.XHS_TRANSCRIBE_COMMAND = `${process.execPath} ${commandPath}`;
    const parsed = await parseMediaAsset(mediaPath, { allowedRoots: [dataDir], baseDir: dataDir });
    assert.equal(parsed.transcriptResult.format, 'json');
    assert.deepEqual(parsed.transcriptResult.segments, [
      { start: 0.25, end: 1.25, text: '高置信片段', confidence: 0.92 },
      { start: 1.5, end: 2.4, text: '低置信片段', confidence: 0.41 },
    ]);
    assert.equal(parsed.transcriptResult.confidence.status, 'low');
    assert.equal(parsed.transcriptResult.confidence.available, true);
    assert.equal(parsed.transcriptResult.confidence.requiresHumanReview, true);
    assert.deepEqual(parsed.transcriptResult.confidence.lowConfidenceSegments.map((item) => item.index), [1]);
  } finally {
    if (previousCommand === undefined) delete process.env.XHS_TRANSCRIBE_COMMAND;
    else process.env.XHS_TRANSCRIBE_COMMAND = previousCommand;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('generated media can request a focused ASR pass without re-running visual analysis', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-focused-transcript-'));
  const mediaPath = join(dataDir, 'generated.mp4');
  const commandPath = join(dataDir, 'transcribe.mjs');
  const previousCommand = process.env.XHS_TRANSCRIBE_COMMAND;
  const srt = `1\n00:00:00,500 --> 00:00:01,250\n生成视频时间码\n`;
  try {
    await writeFile(mediaPath, 'fixture', 'utf8');
    await writeFile(commandPath, `process.stdout.write(${JSON.stringify(srt)});\n`, 'utf8');
    process.env.XHS_TRANSCRIBE_COMMAND = `${process.execPath} ${commandPath}`;
    const result = await transcribeMediaAsset(mediaPath, { allowedRoots: [dataDir] });
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.segments, [{ start: 0.5, end: 1.25, text: '生成视频时间码' }]);
  } finally {
    if (previousCommand === undefined) delete process.env.XHS_TRANSCRIBE_COMMAND;
    else process.env.XHS_TRANSCRIBE_COMMAND = previousCommand;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('video keyframe extraction samples a bounded set of timestamps instead of only the first frame', async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-keyframes-'));
  const videoPath = join(dataDir, 'scene.mp4');
  const outputDir = join(dataDir, 'previews');
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1',
      '-f', 'lavfi', '-i', 'color=c=green:s=320x240:d=1',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]',
      '-map', '[v]', '-r', '10', videoPath,
    ], { timeout: 30_000 });
    const result = await extractKeyframes(videoPath, outputDir, 'asset_scene', { durationSeconds: 3, count: 3, sceneDetect: false });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.strategy, 'uniform');
    assert.equal(result.frames.length, 3);
    assert.deepEqual(result.frames.map((frame) => frame.timeSeconds), [0, 1, 2]);
    assert.equal(result.path, result.frames[0].path);
    assert.equal(new Set(result.frames.map((frame) => frame.path)).size, 3);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('video keyframe extraction prefers detected scene changes and keeps their timestamps', async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-keyframes-scene-'));
  const videoPath = join(dataDir, 'scene.mp4');
  const outputDir = join(dataDir, 'previews');
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1',
      '-f', 'lavfi', '-i', 'color=c=green:s=320x240:d=1',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]',
      '-map', '[v]', '-r', '10', videoPath,
    ], { timeout: 30_000 });
    const result = await extractKeyframes(videoPath, outputDir, 'asset_scene', { durationSeconds: 3, count: 3 });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.strategy, 'scene');
    assert.ok(result.sceneTimes.length >= 1);
    assert.ok(result.sceneTimes.every((timeSeconds) => result.frames.some((frame) => frame.timeSeconds === timeSeconds)));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('video OCR command receives the bounded keyframe set and combines frame text', async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-ocr-frames-'));
  const videoPath = join(dataDir, 'scene.mp4');
  const previewDir = join(dataDir, 'previews');
  const ocrCommand = join(dataDir, 'ocr.mjs');
  const previousCommand = process.env.XHS_OCR_COMMAND;
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=orange:s=320x240:d=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
    ], { timeout: 30_000 });
    await writeFile(ocrCommand, [
      "const input = process.argv.at(-1) || '';",
      "process.stdout.write(input.includes('keyframe-02') ? '第二帧文字' : '第一帧文字');",
    ].join(String.fromCharCode(10)), 'utf8');
    process.env.XHS_OCR_COMMAND = `${process.execPath} ${ocrCommand}`;
    const parsed = await parseMediaAsset(videoPath, {
      allowedRoots: [dataDir],
      previewDir,
      baseDir: dataDir,
    });
    assert.match(parsed.ocrText, /第一帧文字/);
    assert.match(parsed.ocrText, /第二帧文字/);
    assert.ok(parsed.ocrResult.frames.length >= 2);
  } finally {
    if (previousCommand === undefined) delete process.env.XHS_OCR_COMMAND;
    else process.env.XHS_OCR_COMMAND = previousCommand;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('structured OCR output preserves text confidence and bounding boxes per frame', async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-ocr-structured-'));
  const videoPath = join(dataDir, 'scene.mp4');
  const previewDir = join(dataDir, 'previews');
  const ocrCommand = join(dataDir, 'ocr.mjs');
  const previousCommand = process.env.XHS_OCR_COMMAND;
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=orange:s=320x240:d=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
    ], { timeout: 30_000 });
    await writeFile(ocrCommand, `process.stdout.write(${JSON.stringify(JSON.stringify({ items: [
      { text: '品牌标题', confidence: 0.94, box: { x: 12, y: 24, width: 200, height: 50 }, coordinateSystem: 'pixel_top_left' },
      { text: '副标题', confidence: 0.72, box: [[20, 100], [120, 100], [120, 130], [20, 130]] },
    ] }))});\n`, 'utf8');
    process.env.XHS_OCR_COMMAND = `${process.execPath} ${ocrCommand}`;
    const parsed = await parseMediaAsset(videoPath, {
      allowedRoots: [dataDir],
      previewDir,
      baseDir: dataDir,
    });
    assert.match(parsed.ocrText, /品牌标题/);
    assert.match(parsed.ocrText, /副标题/);
    assert.equal(parsed.ocrResult.format, 'json');
    assert.ok(parsed.ocrResult.detections.length >= 2);
    assert.deepEqual(parsed.ocrResult.frames[0].items[0], {
      text: '品牌标题',
      confidence: 0.94,
      box: { x: 12, y: 24, width: 200, height: 50 },
      coordinateSystem: 'pixel_top_left',
    });
    assert.deepEqual(parsed.ocrResult.frames[0].items[1], {
      text: '副标题',
      confidence: 0.72,
      box: { x: 20, y: 100, width: 100, height: 30 },
    });
  } finally {
    if (previousCommand === undefined) delete process.env.XHS_OCR_COMMAND;
    else process.env.XHS_OCR_COMMAND = previousCommand;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('video rendering applies the standard vertical canvas and preserves an optional audio track', async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-render-'));
  const sourcePath = join(dataDir, 'source.mp4');
  const outputPath = join(dataDir, 'rendered.mp4');
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=1',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath,
    ], { timeout: 30_000 });
    const result = await (await import('../src/media-pipeline.mjs')).renderVideo(sourcePath, outputPath, {
      allowedRoots: [dataDir],
      width: 1080,
      height: 1920,
    });
    assert.equal(result.width, 1080);
    assert.equal(result.height, 1920);
    const probe = JSON.parse((await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', outputPath,
    ])).stdout);
    assert.deepEqual(probe.streams.filter((stream) => stream.codec_type === 'video')[0] && {
      codec_type: probe.streams.find((stream) => stream.codec_type === 'video').codec_type,
      width: probe.streams.find((stream) => stream.codec_type === 'video').width,
      height: probe.streams.find((stream) => stream.codec_type === 'video').height,
    }, { codec_type: 'video', width: 1080, height: 1920 });
    assert.equal(probe.streams.some((stream) => stream.codec_type === 'audio'), true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('video rendering burns trusted timed subtitles when libass is unavailable', async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-render-subtitle-'));
  const sourcePath = join(dataDir, 'source.mp4');
  const outputPath = join(dataDir, 'rendered.mp4');
  const framePath = join(dataDir, 'caption-frame.png');
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:rate=10:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath,
    ], { timeout: 30_000 });
    const result = await renderVideo(sourcePath, outputPath, {
      allowedRoots: [dataDir],
      template: { id: 'caption_overlay_v1', width: 320, height: 640, captionFontName: 'Arial', captionFontSize: 28, safeArea: { left: 16, right: 16, bottom: 48 } },
      subtitleSegments: [{ start: 0.2, end: 0.8, text: '本地字幕烧录验收' }],
    });
    assert.equal(result.subtitleBurnIn, 'sharp_overlay');
    assert.equal(result.subtitleSegmentCount, 1);
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', '0.5', '-i', outputPath, '-frames:v', '1', framePath,
    ], { timeout: 30_000 });
    const stats = await sharp(framePath).stats();
    assert.ok(stats.channels.some((channel) => channel.max > 180), 'burned subtitle should add bright caption pixels');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('video rendering applies versioned background and logo template layers', async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-template-render-'));
  const sourcePath = join(dataDir, 'source.mp4');
  const backgroundPath = join(dataDir, 'background.png');
  const logoPath = join(dataDir, 'logo.png');
  const outputPath = join(dataDir, 'rendered.mp4');
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath,
    ], { timeout: 30_000 });
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=blue:s=640x360', '-frames:v', '1', backgroundPath,
    ], { timeout: 30_000 });
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=120x80', '-frames:v', '1', logoPath,
    ], { timeout: 30_000 });
    const sourceDigest = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
    const result = await renderVideo(sourcePath, outputPath, {
      allowedRoots: [dataDir],
      baseDir: dataDir,
      template: {
        id: 'brand_vertical_v2',
        width: 360,
        height: 640,
        backgroundRef: backgroundPath,
        logoRef: logoPath,
        logoWidth: 72,
        logoX: 12,
        logoY: 18,
      },
    });
    assert.equal(result.templateVersionId, 'brand_vertical_v2');
    assert.equal(result.layers.background, true);
    assert.equal(result.layers.logo, true);
    assert.equal(result.width, 360);
    assert.equal(result.height, 640);
    assert.notEqual(createHash('sha256').update(await readFile(outputPath)).digest('hex'), sourceDigest);
    const probe = JSON.parse((await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', outputPath,
    ])).stdout);
    assert.deepEqual(probe.streams.find((stream) => stream.codec_type === 'video') && {
      codec_type: probe.streams.find((stream) => stream.codec_type === 'video').codec_type,
      width: probe.streams.find((stream) => stream.codec_type === 'video').width,
      height: probe.streams.find((stream) => stream.codec_type === 'video').height,
    }, { codec_type: 'video', width: 360, height: 640 });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('video rendering concatenates intro and outro and mixes template music', async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-template-sequence-'));
  const introPath = join(dataDir, 'intro.mp4');
  const sourcePath = join(dataDir, 'source.mp4');
  const outroPath = join(dataDir, 'outro.mp4');
  const musicPath = join(dataDir, 'music.wav');
  const outputPath = join(dataDir, 'rendered.mp4');
  try {
    for (const [color, output] of [['green', introPath], ['blue', outroPath]]) {
      await execFileAsync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:rate=10:duration=0.4`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output,
      ], { timeout: 30_000 });
    }
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x180:rate=10:duration=0.6',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=0.6',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath,
    ], { timeout: 30_000 });
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:duration=0.5',
      '-c:a', 'pcm_s16le', musicPath,
    ], { timeout: 30_000 });
    const result = await renderVideo(sourcePath, outputPath, {
      allowedRoots: [dataDir],
      template: {
        id: 'brand_sequence_v1',
        width: 320,
        height: 640,
        fps: 10,
        introRef: introPath,
        outroRef: outroPath,
        musicRef: musicPath,
        musicVolume: 0.08,
      },
      subtitleSegments: [{ start: 0.1, end: 0.3, text: '片头偏移后的字幕' }],
    });
    assert.deepEqual(result.layers, {
      intro: true,
      outro: true,
      background: false,
      logo: false,
      music: true,
    });
    assert.equal(result.audioNormalization, 'ebu_r128_loudnorm');
    assert.equal(result.subtitleBurnIn, 'sharp_overlay');
    assert.equal(result.subtitleSegmentCount, 1);
    assert.ok(result.subtitleTimecodeOffsetSeconds > 0);
    const probe = JSON.parse((await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', outputPath,
    ])).stdout);
    assert.equal(probe.streams.some((stream) => stream.codec_type === 'audio'), true);
    assert.ok(Number(probe.format.duration) >= 1.1, `expected concatenated duration, got ${probe.format.duration}`);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('subtitle output preserves trusted ASR segment timecodes', () => {
  assert.equal(segmentsToSrt([
    { start: 0.25, end: 1.75, text: '第一句' },
    { start: 2, end: 4.125, text: '第二句，包含品牌词' },
  ]), '1\n00:00:00,250 --> 00:00:01,750\n第一句\n\n2\n00:00:02,000 --> 00:00:04,125\n第二句，包含品牌词\n');
});

test('ASS subtitle output keeps trusted timecodes and template safe-area style', () => {
  const ass = segmentsToAss([
    { start: 0.25, end: 1.75, text: '第一句 {品牌词}' },
    { start: 2, end: 4.125, text: '第二句\n继续' },
  ], {
    width: 1080,
    height: 1920,
    safeArea: { bottom: 240 },
    fontName: 'PingFang SC',
    fontSize: 54,
  });
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /Style: Default,PingFang SC,54/);
  assert.match(ass, /,2,72,72,240,1$/m);
  assert.match(ass, /Dialogue: 0,0:00:00\.25,0:00:01\.75,Default,,0,0,0,,第一句 \(品牌词\)/);
  assert.match(ass, /Dialogue: 0,0:00:02\.00,0:00:04\.13,Default,,0,0,0,,第二句\\N继续/);
});

test('structure analysis carries source transcript timecodes for later citation', () => {
  const result = analyzeContentStructure('第一句\n第二句', {
    sourceSegments: [
      { assetId: 'asset_video', filename: 'source.mp4', start: 0.25, end: 1.75, text: '第一句', confidence: 0.88 },
    ],
    sourceFrames: [
      {
        assetId: 'asset_video',
        filename: 'source.mp4',
        timeSeconds: 1.25,
        text: '画面文字',
        detections: [{ text: '画面文字', confidence: 0.91, box: { x: 10, y: 20, width: 100, height: 30 }, coordinateSystem: 'pixel_top_left' }],
      },
    ],
  });
  assert.deepEqual(result.sourceSegments, [
    { assetId: 'asset_video', filename: 'source.mp4', start: 0.25, end: 1.75, text: '第一句', confidence: 0.88 },
  ]);
  assert.deepEqual(result.sourceFrames, [
    {
      assetId: 'asset_video',
      filename: 'source.mp4',
      timeSeconds: 1.25,
      text: '画面文字',
      detections: [{ text: '画面文字', confidence: 0.91, box: { x: 10, y: 20, width: 100, height: 30 }, coordinateSystem: 'pixel_top_left' }],
    },
  ]);
});

test('structure analysis returns a reviewable extractive summary and evidence gaps', () => {
  const result = analyzeContentStructure('# 开场\n先说一个问题\n## 方法\n给出三个步骤');
  assert.equal(result.analysisMode, 'deterministic-extractive');
  assert.equal(result.summary, '开场：先说一个问题；方法：给出三个步骤');
  assert.deepEqual(result.opening, { text: '先说一个问题', source: 'text' });
  assert.deepEqual(result.rhythm, { segmentCount: 2, characterCounts: [6, 6] });
  assert.deepEqual(result.evidenceGaps, ['未提供可定位的语音或画面来源']);
});

test('cover rendering creates a separate 1080x1440 still from a keyframe', async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-cover-'));
  const sourcePath = join(dataDir, 'keyframe.png');
  const outputPath = join(dataDir, 'cover.jpg');
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=orange:s=640x360', '-frames:v', '1', sourcePath,
    ], { timeout: 30_000 });
    const result = await renderCover(sourcePath, outputPath, { allowedRoots: [dataDir], width: 1080, height: 1440 });
    assert.equal(result.width, 1080);
    assert.equal(result.height, 1440);
    const probe = JSON.parse((await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', outputPath,
    ])).stdout);
    assert.deepEqual(probe.streams[0], { codec_name: 'mjpeg', width: 1080, height: 1440 });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('cover rendering rasterizes template title inside the safe area', async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-cover-text-'));
  const sourcePath = join(dataDir, 'keyframe.png');
  const outputPath = join(dataDir, 'cover.jpg');
  const plainOutputPath = join(dataDir, 'plain-cover.jpg');
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=orange:s=640x360', '-frames:v', '1', sourcePath,
    ], { timeout: 30_000 });
    const result = await renderCover(sourcePath, outputPath, {
      allowedRoots: [dataDir],
      template: {
        id: 'cover_text_v1',
        width: 360,
        height: 480,
        coverText: '封面标题安全区验收',
        captionFontName: 'Arial',
        captionFontSize: 32,
        safeArea: { left: 24, right: 24, bottom: 36 },
      },
    });
    assert.equal(result.text, '封面标题安全区验收');
    assert.equal(result.textRendered, true);
    await renderCover(sourcePath, plainOutputPath, { allowedRoots: [dataDir], width: 360, height: 480 });
    assert.notEqual(
      createHash('sha256').update(await readFile(outputPath)).digest('hex'),
      createHash('sha256').update(await readFile(plainOutputPath)).digest('hex'),
    );
    const probe = JSON.parse((await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', outputPath,
    ])).stdout);
    assert.deepEqual(probe.streams[0], { codec_name: 'mjpeg', width: 360, height: 480 });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('media output probe requires a readable expected stream and records ffprobe evidence', async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-media-probe-'));
  const videoPath = join(dataDir, 'output.mp4');
  const brokenPath = join(dataDir, 'broken.mp4');
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
    ], { timeout: 30_000 });
    const result = await probeMediaFile(videoPath, { allowedRoots: [dataDir], expectedKind: 'video' });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.kind, 'video');
    assert.equal(result.streams.some((stream) => stream.codec_type === 'video'), true);
    assert.equal(result.streams.find((stream) => stream.codec_type === 'video').width, 320);
    await writeFile(brokenPath, Buffer.from('not a media file'));
    await assert.rejects(
      () => probeMediaFile(brokenPath, { allowedRoots: [dataDir], expectedKind: 'video' }),
      (error) => error.code === 'MEDIA_PROBE_FAILED',
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('media probe preserves video rotation metadata for portrait sources', async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-worker-probe-rotation-'));
  const videoPath = join(dataDir, 'rotated.mkv');
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1',
      '-metadata:s:v:0', 'rotate=90',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
    ], { timeout: 30_000 });
    const result = await probeMediaFile(videoPath, { allowedRoots: [dataDir], expectedKind: 'video' });
    const stream = result.streams.find((item) => item.codec_type === 'video');
    assert.deepEqual(stream?.rotation, { degrees: 90, source: 'tag' });
    assert.equal(stream?.display_aspect_ratio, '4:3');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
