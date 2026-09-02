#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMediaAsset } from '../src/media-pipeline.mjs';
import {
  defaultQualityFixtures,
  runQualityEvaluation,
} from '../src/quality-evaluator.mjs';

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(join(PROJECT_DIR, '.env'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function usage() {
  return [
    '用法：',
    '  node tools/deepseek-quality-eval.mjs [选项]',
    '',
    '选项：',
    '  --media <绝对路径>     顺序解析并评测一个用户确认可用于评测的本地视频/图片，可重复',
    '  --fixture <JSON路径>   读取一个或多个评测样本 JSON，可重复',
    '  --include-draft        在 JSON 报告中包含模型草案（默认不包含）',
    '  --format json|markdown  输出格式，默认 markdown',
    '  --output <路径>        将报告写入指定路径；不指定时只输出到终端',
    '  --help                 显示帮助',
  ].join('\n');
}

function takeOptions(argv) {
  const options = { media: [], fixtures: [], format: 'markdown', includeDraft: false, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--include-draft') {
      options.includeDraft = true;
    } else if (['--media', '--fixture', '--format', '--output'].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要一个值`);
      index += 1;
      if (arg === '--media') options.media.push(value);
      if (arg === '--fixture') options.fixtures.push(value);
      if (arg === '--format') options.format = value;
      if (arg === '--output') options.output = value;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!['json', 'markdown'].includes(options.format)) throw new Error('--format 只能是 json 或 markdown');
  return options;
}

async function mediaFixture(mediaPath, tempDir, index) {
  const absolutePath = isAbsolute(mediaPath) ? mediaPath : resolve(process.cwd(), mediaPath);
  const parsed = await parseMediaAsset(absolutePath, {
    allowedRoots: [dirname(absolutePath)],
    previewDir: join(tempDir, `preview-${index}`),
    baseDir: tempDir,
  });
  const sourceReferences = [{
    id: `media_fixture_${index}`,
    filename: parsed.filename,
    kind: parsed.kind,
    transcriptSegments: parsed.transcriptResult?.segments || [],
  }];
  return {
    id: `media-${index}-${basename(parsed.filename, parsed.filename.includes('.') ? parsed.filename.slice(parsed.filename.lastIndexOf('.')) : '')}`,
    kind: 'copy',
    task: {
      title: `本地媒体来源评测：${parsed.filename}`,
      objective: '检查真实本地素材能否生成有来源边界的内部审核草案',
      audience: '内容编辑',
      platforms: ['小红书'],
      sourceBrief: '这是用户指定的本地媒体评测输入；版权、客户案例、效果数据和外部发布状态只能按素材明确内容判断，授权状态不由评测器推断。',
    },
    materialText: [parsed.textContent, parsed.transcript, parsed.ocrText].filter(Boolean).join('\n\n'),
    sourceReferences,
    expectations: {
      authorizationExpected: false,
      publishExpected: false,
      requireTimecode: sourceReferences[0].transcriptSegments.length > 0,
      // 长文件名可能被模型压缩为“素材1”；source_name 检查会同时校验稳定素材编号和文件名。
      mustContain: [],
    },
    parseEvidence: {
      path: parsed.path,
      kind: parsed.kind,
      status: parsed.status,
      transcriptStatus: parsed.transcriptResult?.status || null,
      transcriptFormat: parsed.transcriptResult?.format || null,
      transcriptSegments: parsed.transcriptResult?.segments?.length || 0,
      ocrStatus: parsed.ocrResult?.status || null,
      textChars: parsed.textContent?.length || 0,
      transcriptChars: parsed.transcript?.length || 0,
      ocrChars: parsed.ocrText?.length || 0,
    },
  };
}

async function loadFixture(path) {
  const absolutePath = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const value = JSON.parse(await readFile(absolutePath, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`评测样本必须是 JSON 对象：${path}`);
  }
  if (!value.id || !value.kind || !value.task) {
    throw new Error(`评测样本缺少 id/kind/task：${path}`);
  }
  return value;
}

function compactText(value, length = 180) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > length ? normalized.slice(0, length) + '…' : normalized;
}

function markdownReport(report, fixtures) {
  const lines = [
    `# DeepSeek 内容质量评测 ${report.evaluationVersion}`,
    '',
    `- 状态：${report.status}`,
    `- 模型：${report.provider || 'unknown'} / ${report.model || 'unknown'}`,
    `- 样本：${report.passedFixtures ?? 0}/${report.fixtureCount} 通过`,
    `- 检查项：${report.passedChecks ?? 0}/${report.totalChecks ?? 0} 通过，得分 ${report.score ?? 0}`,
    '- 评测器只输出结构化质量证据，不把模型返回当作已发布结果。',
    '',
  ];
  if (report.status === 'NOT_CONFIGURED') {
    lines.push(`- 未执行原因：${report.reason}`);
    return lines.join('\n') + '\n';
  }
  for (const result of report.results || []) {
    const fixture = fixtures.find((item) => item.id === result.id);
    lines.push(`## ${result.id}｜${result.status}｜${result.score}分`);
    if (fixture?.parseEvidence) {
      lines.push(`- 媒体解析：${compactText(JSON.stringify(fixture.parseEvidence), 300)}`);
    }
    lines.push(`- 请求证据：requestId=${result.metadata?.requestId || 'none'}；输出 ${result.metadata?.outputChars || 0} 字；耗时 ${result.durationMs || 0} ms`);
    for (const item of result.checks || []) {
      lines.push(`- ${item.status === 'PASS' ? '通过' : '失败'}｜${item.label}：${item.details}`);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const options = takeOptions(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const tempDir = await mkdtemp(join(tmpdir(), 'cloud-worker-quality-eval-'));
  try {
    const fixtures = options.fixtures.length
      ? await Promise.all(options.fixtures.map(loadFixture))
      : defaultQualityFixtures();
    for (let index = 0; index < options.media.length; index += 1) {
      fixtures.push(await mediaFixture(options.media[index], tempDir, index));
    }
    const report = await runQualityEvaluation({ fixtures, includeDraft: options.includeDraft });
    const output = options.format === 'json'
      ? JSON.stringify(report, null, 2) + '\n'
      : markdownReport(report, fixtures);
    if (options.output) {
      const outputPath = isAbsolute(options.output) ? options.output : resolve(process.cwd(), options.output);
      await writeFile(outputPath, output, 'utf8');
      console.log(`评测报告已写入：${outputPath}`);
    } else {
      process.stdout.write(output);
    }
    if (report.status === 'FAIL') process.exitCode = 1;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('评测器执行失败：' + (error?.message || error));
  process.exitCode = 1;
});
