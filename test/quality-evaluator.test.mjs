import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONTENT_DRAFT_PROMPT_VERSION,
  aiProviderStatus,
} from '../src/ai-provider.mjs';
import {
  defaultQualityFixtures,
  evaluateGeneratedDraft,
  runQualityEvaluation,
} from '../src/quality-evaluator.mjs';

function generated(textValue, overrides = {}) {
  return {
    text: textValue,
    provider: 'deepseek',
    model: 'deepseek-chat',
    requestId: 'eval-request-1',
    usage: { total_tokens: 20 },
    promptVersion: CONTENT_DRAFT_PROMPT_VERSION,
    sourceIndex: '素材1｜controlled-facts.txt｜text',
    ...overrides,
  };
}

test('quality evaluator passes a grounded review draft and checks source name', () => {
  const fixture = defaultQualityFixtures()[0];
  const result = evaluateGeneratedDraft({
    fixture,
    generated: generated([
      '内部审核稿。',
      '事实依据与待确认：',
      '来源：controlled-facts.txt；素材明确说明可以导入本地素材、生成内容草案。',
      '授权和发布结果：待确认；不可直接发布。',
      '人工审核：请确认事实、表达和发布条件。',
    ].join('\n')),
    provider: { provider: 'deepseek', model: 'deepseek-chat', configured: true },
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.failedChecks, 0);
});

test('quality evaluator rejects a draft that asserts authorization or publish success', () => {
  const fixture = defaultQualityFixtures()[1];
  const result = evaluateGeneratedDraft({
    fixture,
    generated: generated([
      '事实依据与待确认：',
      '来源：missing-evidence.txt。',
      '该素材已获得版权授权，发布成功。',
      '人工确认。',
    ].join('\n'), { sourceIndex: '素材1｜missing-evidence.txt｜text' }),
    provider: { provider: 'deepseek', model: 'deepseek-chat', configured: true },
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.checks.find((item) => item.id === 'boundary.authorization').status, 'FAIL');
  assert.equal(result.checks.find((item) => item.id === 'boundary.publish').status, 'FAIL');
});

test('quality evaluator does not treat a missing-evidence metric as publish success', () => {
  const fixture = defaultQualityFixtures()[1];
  const result = evaluateGeneratedDraft({
    fixture,
    generated: generated([
      '事实依据与待确认：',
      '来源：missing-evidence.txt。',
      '发布成功率、客户案例和效果数据均待确认。',
      '人工确认。',
    ].join('\n'), { sourceIndex: '素材1｜missing-evidence.txt｜text' }),
    provider: { provider: 'deepseek', model: 'deepseek-chat', configured: true },
  });
  assert.equal(result.checks.find((item) => item.id === 'boundary.publish').status, 'PASS');
});

test('quality evaluator requires timecode when source contains transcript segments', () => {
  const fixture = defaultQualityFixtures()[2];
  const noTimecode = evaluateGeneratedDraft({
    fixture,
    generated: generated([
      '事实依据与待确认：',
      '来源：timecoded-video.mp4。',
      '人工审核。',
    ].join('\n'), { sourceIndex: '素材1｜timecoded-video.mp4｜video' }),
    provider: { provider: 'deepseek', model: 'deepseek-chat', configured: true },
  });
  assert.equal(noTimecode.checks.find((item) => item.id === 'evidence.timecode').status, 'FAIL');

  const withTimecode = evaluateGeneratedDraft({
    fixture,
    generated: generated([
      '事实依据与待确认：',
      '来源：timecoded-video.mp4，0.000-2.500秒：开场；2.500-6.000秒：步骤。',
      '人工审核。',
    ].join('\n'), { sourceIndex: '素材1｜timecoded-video.mp4｜video' }),
    provider: { provider: 'deepseek', model: 'deepseek-chat', configured: true },
  });
  assert.equal(withTimecode.checks.find((item) => item.id === 'evidence.timecode').status, 'PASS');
});

test('quality evaluation refuses to use local template as DeepSeek evidence', async () => {
  const previousKey = process.env.DEEPSEEK_API_KEY;
  try {
    delete process.env.DEEPSEEK_API_KEY;
    const report = await runQualityEvaluation({
      fixtures: defaultQualityFixtures().slice(0, 1),
      providerStatus: aiProviderStatus(),
      generator: async () => { throw new Error('generator should not run'); },
    });
    assert.equal(report.status, 'NOT_CONFIGURED');
    assert.equal(report.results.length, 0);
  } finally {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});
