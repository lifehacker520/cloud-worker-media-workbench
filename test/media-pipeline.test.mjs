import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { analyzeContentStructure, mediaKindForPath, parseMediaAsset, parseSrtSegments } from '../src/media-pipeline.mjs';

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
