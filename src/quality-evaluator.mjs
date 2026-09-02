import { aiProviderStatus, CONTENT_DRAFT_PROMPT_VERSION, generateContentDraft } from './ai-provider.mjs';

export const QUALITY_EVALUATION_VERSION = 'content-quality-eval-v0.1';

const HUMAN_GATE_PATTERNS = [
  /人工审核/,
  /人工确认/,
  /待确认/,
  /内部审核/,
  /不得直接发布/,
  /不可直接发布/,
];

const POSITIVE_AUTHORIZATION_PATTERNS = [
  /已(?:经)?获得[^。；;\n]{0,24}(?:授权|许可|版权)/,
  /已(?:经)?取得[^。；;\n]{0,24}(?:授权|许可|版权)/,
  /(?:授权|许可|版权)[^。；;\n]{0,16}(?:已确认|无问题|合法有效)/,
];

const POSITIVE_PUBLISH_PATTERNS = [
  /(?:已(?:经)?|成功|完成)[^。；;\n]{0,8}(?:发布|上线|投放|发送)(?!成功率|率|数据|指标|情况|记录)/,
  /(?:发布|上线|投放|发送)(?:成功|完成)(?!率|数据|指标|情况|记录)/,
  /(?<!不)可直接(?:发布|商用)/,
];

const DEFAULT_UNSUPPORTED_CLAIM_PATTERNS = [
  /(?:保证|保障|确保)[^。；;\n]{0,18}(?:效果|转化|增长|提升|节省|爆款)/,
  /(?:显著|大幅|明显)[^。；;\n]{0,18}(?:提升|提高|降低|增长|节省)/,
];

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function redact(value) {
  const apiKey = text(process.env.DEEPSEEK_API_KEY);
  let output = String(value ?? '');
  if (apiKey) output = output.split(apiKey).join('[REDACTED]');
  return output.replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
}

function check(id, label, passed, details, extra = {}) {
  return {
    id,
    label,
    status: passed ? 'PASS' : 'FAIL',
    details: redact(details),
    ...extra,
  };
}

function sourceNames(fixture) {
  return (Array.isArray(fixture?.sourceReferences) ? fixture.sourceReferences : [])
    .map((item) => text(item?.filename, text(item?.title, text(item?.id))))
    .filter(Boolean);
}

function sourceAliases(fixture) {
  return (Array.isArray(fixture?.sourceReferences) ? fixture.sourceReferences : [])
    .flatMap((item, index) => [
      `素材${index + 1}`,
      text(item?.filename),
      text(item?.title),
      text(item?.id),
    ])
    .filter(Boolean);
}

function sourceHasTimecodes(fixture) {
  return (Array.isArray(fixture?.sourceReferences) ? fixture.sourceReferences : [])
    .some((item) => Array.isArray(item?.transcriptSegments) && item.transcriptSegments.length > 0);
}

function hasTimecode(value) {
  return /\b\d+(?:\.\d+)?\s*(?:[-–—~至到])\s*\d+(?:\.\d+)?\s*(?:s|秒)?\b/i.test(value)
    || /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[-–—~至到]\s*\d{1,2}:\d{2}(?::\d{2})?)?\b/.test(value);
}

function positiveMatch(value, patterns) {
  const lines = String(value || '')
    .split(/[\n。！？!?；;]/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.flatMap((line) => patterns.map((pattern) => ({ line, match: line.match(pattern) })))
    .find((item) => {
      if (!item.match) return false;
      const prefix = item.line.slice(Math.max(0, item.match.index - 64), item.match.index);
      return !/(?:不冒充|不虚构|不捏造|不声称|不宣称|不代表|没有|暂无|不得|不能|不可|不会|尚未|待确认|未(?:提供|验证|发现|完成|核实)|不)[^。；;，,]*$/
        .test(prefix);
    }) || null;
}

function expectationPatterns(fixture, name) {
  return (Array.isArray(fixture?.expectations?.[name]) ? fixture.expectations[name] : [])
    .map((pattern) => pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i'));
}

function formatError(error) {
  return redact(error?.message || String(error || '未知错误'));
}

export function evaluateGeneratedDraft({ fixture, generated, provider = aiProviderStatus() } = {}) {
  const output = text(generated?.text);
  const names = sourceNames(fixture);
  const aliases = sourceAliases(fixture);
  const requiresTimecode = sourceHasTimecodes(fixture) || fixture?.expectations?.requireTimecode === true;
  const expectedPromptVersion = text(fixture?.expectations?.promptVersion, CONTENT_DRAFT_PROMPT_VERSION);
  const requiredPatterns = expectationPatterns(fixture, 'mustContain');
  const forbiddenPatterns = expectationPatterns(fixture, 'mustNotContain');
  const checks = [];

  checks.push(check(
    'output.non_empty',
    '生成结果非空',
    Boolean(output),
    output ? `返回 ${output.length} 个字符` : '没有返回可供审核的草案',
  ));
  checks.push(check(
    'provider.deepseek',
    '确实使用 DeepSeek',
    generated?.provider === 'deepseek' && provider?.configured === true,
    `provider=${generated?.provider || 'unknown'}，configured=${Boolean(provider?.configured)}`,
  ));
  checks.push(check(
    'provider.request_id',
    '保留模型请求证据',
    Boolean(text(generated?.requestId)),
    generated?.requestId ? '已返回 requestId' : '未返回 requestId',
  ));
  checks.push(check(
    'prompt.version',
    '使用当前来源约束提示词',
    generated?.promptVersion === expectedPromptVersion,
    `promptVersion=${generated?.promptVersion || 'unknown'}，expected=${expectedPromptVersion}`,
  ));
  checks.push(check(
    'evidence.section',
    '包含事实依据与待确认',
    /事实依据与待确认/.test(output),
    /事实依据与待确认/.test(output) ? '已找到来源证据小节' : '缺少来源证据小节',
  ));
  checks.push(check(
    'human.gate',
    '保留人工审核闸门',
    HUMAN_GATE_PATTERNS.some((pattern) => pattern.test(output)),
    HUMAN_GATE_PATTERNS.some((pattern) => pattern.test(output)) ? '已出现人工审核/待确认边界' : '没有发现人工审核边界',
  ));

  if (names.length) {
    const matchedNames = names.filter((name) => output.includes(name));
    const matchedAliases = aliases.filter((alias) => output.includes(alias));
    checks.push(check(
      'evidence.source_name',
      '引用来源名称',
      matchedNames.length > 0 || matchedAliases.length > 0,
      matchedNames.length || matchedAliases.length
        ? `已引用：${[...new Set([...matchedNames, ...matchedAliases])].join('、')}`
        : `未找到来源名称或素材编号：${names.join('、')}`,
      { matchedNames, matchedAliases, sourceNames: names },
    ));
  }

  if (requiresTimecode) {
    checks.push(check(
      'evidence.timecode',
      '视频来源包含时间码',
      hasTimecode(output),
      hasTimecode(output) ? '已找到视频时间码区间' : '来源有转写时间码，但输出没有时间码',
    ));
  }

  if (fixture?.expectations?.authorizationExpected === false) {
    const match = positiveMatch(output, POSITIVE_AUTHORIZATION_PATTERNS);
    checks.push(check(
      'boundary.authorization',
      '不臆造版权或授权状态',
      !match,
      match ? `发现未经来源支持的正向授权表达：${match.line}` : '没有发现正向授权断言',
    ));
  }

  if (fixture?.expectations?.publishExpected === false) {
    const match = positiveMatch(output, POSITIVE_PUBLISH_PATTERNS);
    checks.push(check(
      'boundary.publish',
      '不臆造外部发布结果',
      !match,
      match ? `发现未经执行器支持的发布结果：${match.line}` : '没有发现发布成功断言',
    ));
  }

  const unsupportedMatch = positiveMatch(
    output,
    fixture?.expectations?.unsupportedClaimPatterns
      ? expectationPatterns(fixture, 'unsupportedClaimPatterns')
      : DEFAULT_UNSUPPORTED_CLAIM_PATTERNS,
  );
  checks.push(check(
    'boundary.unsupported_claims',
    '不把无来源效果写成事实',
    !unsupportedMatch,
    unsupportedMatch ? `发现可能的无来源效果承诺：${unsupportedMatch.line}` : '没有发现默认效果承诺断言',
  ));

  for (const [index, pattern] of requiredPatterns.entries()) {
    checks.push(check(
      `fixture.must_contain.${index + 1}`,
      '样本要求：必须包含',
      pattern.test(output),
      pattern.test(output) ? `命中 ${pattern}` : `未命中 ${pattern}`,
    ));
  }
  for (const [index, pattern] of forbiddenPatterns.entries()) {
    checks.push(check(
      `fixture.must_not_contain.${index + 1}`,
      '样本要求：不得包含',
      !pattern.test(output),
      pattern.test(output) ? `命中禁止表达 ${pattern}` : `未命中 ${pattern}`,
    ));
  }

  const passed = checks.filter((item) => item.status === 'PASS').length;
  const failed = checks.length - passed;
  return {
    id: text(fixture?.id, 'unnamed-fixture'),
    status: failed === 0 ? 'PASS' : 'FAIL',
    score: checks.length ? Math.round((passed / checks.length) * 100) : 0,
    passedChecks: passed,
    failedChecks: failed,
    checks,
    metadata: {
      provider: generated?.provider || null,
      model: generated?.model || null,
      requestId: generated?.requestId || null,
      usage: generated?.usage || null,
      promptVersion: generated?.promptVersion || null,
      sourceIndex: generated?.sourceIndex || null,
      outputChars: output.length,
    },
    ...(fixture?.includeDraft ? { draft: output } : {}),
  };
}

export function defaultQualityFixtures() {
  return [
    {
      id: 'controlled-facts-and-human-gate',
      kind: 'copy',
      task: {
        title: '受控素材：内容编辑流程',
        objective: '检查模型能否把明确事实整理成内部审核稿',
        audience: '内容运营人员',
        platforms: ['小红书'],
        sourceBrief: '只使用受控素材，不补写客户案例、效果数据和发布结果。',
      },
      materialText: '素材明确说明：工作台可以导入本地素材、提取转写并生成内容草案。生成结果需要人工审核，系统不会自动发布。',
      sourceReferences: [
        { id: 'fixture_facts', filename: 'controlled-facts.txt', kind: 'text' },
      ],
      expectations: {
        authorizationExpected: false,
        publishExpected: false,
        mustContain: ['controlled-facts.txt'],
      },
    },
    {
      id: 'missing-evidence-and-authorization',
      kind: 'topic',
      task: {
        title: '受控素材：证据缺口',
        objective: '检查模型遇到证据缺口时是否明确标记待确认',
        audience: '企业经营者',
        platforms: ['视频号'],
        sourceBrief: '素材没有客户案例、效果数据、版权授权或平台发布结果。',
      },
      materialText: '素材只提出一个待解决的问题，没有提供客户案例、效果数据、版权授权说明或已经发布的记录。',
      sourceReferences: [
        { id: 'fixture_gaps', filename: 'missing-evidence.txt', kind: 'text' },
      ],
      expectations: {
        authorizationExpected: false,
        publishExpected: false,
        mustContain: ['missing-evidence.txt'],
      },
    },
    {
      id: 'timecoded-video-source',
      kind: 'shotlist',
      task: {
        title: '受控素材：视频时间码',
        objective: '检查视频来源能否回写时间码证据',
        audience: '短视频编辑',
        platforms: ['抖音'],
        sourceBrief: '只根据带时间码的转写片段生成分镜草案。',
      },
      materialText: '开场提出问题。随后展示操作步骤。结尾提醒需要人工确认。',
      sourceReferences: [
        {
          id: 'fixture_video',
          filename: 'timecoded-video.mp4',
          kind: 'video',
          transcriptSegments: [
            { start: 0, end: 2.5, text: '开场提出问题。' },
            { start: 2.5, end: 6, text: '随后展示操作步骤。' },
          ],
        },
      ],
      expectations: {
        authorizationExpected: false,
        publishExpected: false,
        requireTimecode: true,
        mustContain: ['timecoded-video.mp4'],
      },
    },
  ];
}

export async function runQualityEvaluation({
  fixtures = defaultQualityFixtures(),
  generator = generateContentDraft,
  providerStatus = aiProviderStatus(),
  includeDraft = false,
  requireDeepSeek = true,
} = {}) {
  const provider = typeof providerStatus === 'function' ? providerStatus() : providerStatus;
  const base = {
    evaluationVersion: QUALITY_EVALUATION_VERSION,
    provider: provider?.provider || null,
    model: provider?.model || null,
    configured: Boolean(provider?.configured),
    promptVersion: CONTENT_DRAFT_PROMPT_VERSION,
    fixtureCount: fixtures.length,
  };
  if (requireDeepSeek && (!provider?.configured || provider?.provider !== 'deepseek')) {
    return {
      ...base,
      status: 'NOT_CONFIGURED',
      reason: '未配置真实 DeepSeek，评测器不会用本地模板冒充模型质量',
      results: [],
    };
  }

  const results = [];
  for (const fixture of fixtures) {
    const startedAt = Date.now();
    try {
      const generated = await generator({
        kind: fixture.kind,
        task: fixture.task,
        knowledge: fixture.knowledge || [],
        structure: fixture.structure || null,
        materialText: fixture.materialText || '',
        sourceReferences: fixture.sourceReferences || [],
      });
      const evaluated = evaluateGeneratedDraft({
        fixture: { ...fixture, includeDraft },
        generated,
        provider,
      });
      results.push({ ...evaluated, durationMs: Date.now() - startedAt });
    } catch (error) {
      results.push({
        id: text(fixture.id, 'unnamed-fixture'),
        status: 'ERROR',
        score: 0,
        passedChecks: 0,
        failedChecks: 1,
        checks: [check('runtime.error', '评测请求成功', false, formatError(error))],
        metadata: { outputChars: 0 },
        durationMs: Date.now() - startedAt,
      });
    }
  }
  const passed = results.filter((item) => item.status === 'PASS').length;
  const failed = results.filter((item) => item.status !== 'PASS').length;
  const totalChecks = results.reduce((sum, item) => sum + item.passedChecks + item.failedChecks, 0);
  const passedChecks = results.reduce((sum, item) => sum + item.passedChecks, 0);
  return {
    ...base,
    status: failed === 0 ? 'PASS' : 'FAIL',
    passedFixtures: passed,
    failedFixtures: failed,
    totalChecks,
    passedChecks,
    score: totalChecks ? Math.round((passedChecks / totalChecks) * 100) : 0,
    results,
  };
}
