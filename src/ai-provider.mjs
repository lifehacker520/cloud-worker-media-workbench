const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
export const CONTENT_DRAFT_PROMPT_VERSION = 'content-draft-v0.3-grounded-timecoded';

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function providerError(message, code = 'AI_PROVIDER_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sourceSentences(value) {
  const normalized = text(value).replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  const sentences = normalized
    .split(/(?<=[。！？!?；;\n])|\n+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4);
  return [...new Set(sentences)].slice(0, 8);
}

function sourceExcerpt(value, fallback = '当前素材没有可直接引用的文本') {
  const excerpt = text(value, fallback).replace(/\s+/g, ' ').trim();
  return excerpt.length > 96 ? excerpt.slice(0, 96) + '……' : excerpt;
}

function sourceIndex({ knowledge = [], sourceReferences = [] } = {}) {
  const materialReferences = Array.isArray(sourceReferences)
    ? sourceReferences
      .filter((item) => item && typeof item === 'object')
      .slice(0, 12)
      .map((item, index) => {
        const timecodes = Array.isArray(item.transcriptSegments)
          ? item.transcriptSegments
            .filter((segment) => Number.isFinite(segment?.start) && Number.isFinite(segment?.end))
            .slice(0, 24)
            .map((segment) => `${segment.start.toFixed(3)}-${segment.end.toFixed(3)}s`)
          : [];
        const timecode = timecodes.length
          ? `｜时间码区间 ${timecodes.join(', ')}`
          : '';
        return `素材${index + 1}｜${text(item.filename, text(item.id, '未命名素材'))}｜${text(item.kind, 'unknown')}${timecode}`;
      })
    : [];
  const knowledgeReferences = knowledge
    .slice(0, 8)
    .map((item, index) => `知识${index + 1}｜${text(item.title, text(item.id, '未命名知识'))}`);
  return [...materialReferences, ...knowledgeReferences].join('\n') || '未提供结构化来源索引；只能引用原始素材文本。';
}

function localContentDraft({ kind, task, knowledge = [], structure = null, materialText = '', sourceReferences = [] } = {}) {
  const sentences = sourceSentences(materialText || task?.sourceBrief);
  const first = sourceExcerpt(sentences[0] || materialText || task?.sourceBrief);
  const second = sourceExcerpt(sentences[1] || sentences[0] || materialText || task?.sourceBrief);
  const third = sourceExcerpt(sentences[2] || sentences[1] || materialText || task?.sourceBrief);
  const objective = text(task?.objective, '待补充业务目标');
  const audience = text(task?.audience, '待补充目标受众');
  const platforms = Array.isArray(task?.platforms) && task.platforms.length ? task.platforms.join('、') : '待指定平台';
  const knowledgeTitles = knowledge.length
    ? knowledge.slice(0, 5).map((item) => `《${item.title}》`).join('、')
    : '未检索到知识库资料';
  const structureSummary = structure
    ? `结构分析已完成：${text(structure.summary, '已生成结构结果，细节待人工核对')}`
    : '结构分析尚未完成';
  const header = '【本地模板草案｜仅基于已读素材｜必须人工审核】';
  const sourceNote = `\n\n素材依据：\n- ${first}\n- ${second}`;
  let draft;
  switch (kind) {
    case 'topic':
      draft = [
        header,
        '一、候选选题（抽取式整理，不代表事实判断）',
        `1. 从“${first}”切入，拆解其中的核心问题与解决路径。`,
        `2. 围绕“${second}”做一条面向${audience}的实操说明。`,
        `3. 把“${third}”整理成前后对比或步骤清单，验证用户最关心的变化。`,
        '',
        `业务目标：${objective}`,
        `目标平台：${platforms}`,
        '人工确认：选题是否符合品牌定位、是否需要补充案例/数据、是否存在平台敏感表达。',
      ].join('\n');
      break;
    case 'copy':
      draft = [
        header,
        '标题候选：把“',
        first,
        '”讲清楚，给目标用户一套可执行的方法',
        '',
        '口播脚本草案：',
        `开场：你是不是也在关注“${first}”？`,
        `正文：先把素材里明确出现的内容说清楚——${second}。接着根据“${third}”补充步骤、画面或案例；没有来源的效果、数据和承诺不在本地模板中补写。`,
        '结尾：如果你要把这件事落地，先确认目标、素材和执行条件，再进入下一步。',
        '',
        `发布说明：目标平台为${platforms}；知识依据为${knowledgeTitles}。`,
        '人工确认：标题、语气、事实、案例、数据、免责声明及最终 CTA。',
      ].join('\n');
      break;
    case 'platform':
      draft = [
        header,
        `平台适配输入：${platforms}`,
        `主题：${first}`,
        `正文骨架：问题引入 → 素材事实“${second}” → 操作步骤 → 人工补充证据 → 行动提示。`,
        '标题长度、标签、封面文字和平台规则暂不自动推断；请按每个平台的最新规则人工审核。',
        '人工确认：平台版本是否需要重写、是否含有绝对化/功效性/未经证实的表达。',
      ].join('\n');
      break;
    case 'shotlist':
      draft = [
        header,
        '分镜与制作计划（先给可执行骨架）',
        `镜头1｜开场：呈现主题“${first}”，配一句问题式口播。`,
        `镜头2｜证据：展示素材中“${second}”对应的原画面、字幕或转写，并标注来源时间点。`,
        `镜头3｜收束：围绕“${third}”给出步骤清单，缺失画面由人工补拍或补素材。`,
        `${structureSummary}；字幕、配音、封面和数字人素材需要人工确认后再制作。`,
      ].join('\n');
      break;
    case 'retro':
      draft = [
        header,
        '复盘建议（基于当前素材的可观察信息）',
        `已观察内容：${first}；${second}。`,
        '可复用点：优先保留素材中已经出现的具体问题、步骤和画面证据。',
        '待验证点：点击、完播、咨询、转化等效果数据当前没有接入，不能据此判断好坏。',
        '下一次实验：只改一个变量，记录平台、发布时间、标题/开场版本和真实结果。',
        `关联知识：${knowledgeTitles}；${structureSummary}。`,
      ].join('\n');
      break;
    default:
      draft = [header, `围绕“${first}”整理内容草案。`, '人工确认：事实、表达和发布条件。'].join('\n');
  }
  return {
    text: draft + sourceNote,
    provider: 'local-template',
    model: 'extractive-v0.1',
    requestId: null,
    usage: null,
    promptVersion: CONTENT_DRAFT_PROMPT_VERSION,
    sourceIndex: sourceIndex({ knowledge, sourceReferences }),
  };
}

export function aiProviderStatus() {
  return {
    provider: 'deepseek',
    model: text(process.env.DEEPSEEK_MODEL, DEFAULT_MODEL),
    configured: Boolean(process.env.DEEPSEEK_API_KEY),
    baseUrl: text(process.env.DEEPSEEK_BASE_URL, DEFAULT_BASE_URL),
    localDraftGenerator: process.env.XHS_LOCAL_DRAFT_GENERATOR !== 'false',
  };
}

export async function generateText({ system, prompt, temperature = 0.4, maxTokens = 2000 } = {}) {
  const apiKey = text(process.env.DEEPSEEK_API_KEY);
  if (!apiKey) {
    throw providerError('未配置 DeepSeek API Key，暂不能执行 AI 生成；可先完成本地素材解析和知识检索', 'AI_PROVIDER_NOT_CONFIGURED');
  }
  const baseUrl = text(process.env.DEEPSEEK_BASE_URL, DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = text(process.env.DEEPSEEK_MODEL, DEFAULT_MODEL);
  let response;
  try {
    response = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: text(system, '你是云员工工作台中的内容编辑助手。只基于给定资料工作，不把推断写成事实。') },
          { role: 'user', content: text(prompt) },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw providerError('DeepSeek 请求失败：' + error.message, 'AI_PROVIDER_UNAVAILABLE');
  }
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    throw providerError('DeepSeek 返回格式无法解析', 'AI_PROVIDER_INVALID_RESPONSE');
  }
  if (!response.ok) {
    const detail = text(payload?.error?.message, 'HTTP ' + response.status);
    throw providerError('DeepSeek 返回错误：' + detail, 'AI_PROVIDER_HTTP_ERROR');
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw providerError('DeepSeek 没有返回可用内容', 'AI_PROVIDER_EMPTY_RESPONSE');
  }
  return {
    text: content.trim(),
    provider: 'deepseek',
    model,
    requestId: payload.id || null,
    usage: payload.usage || null,
  };
}

export async function generateContentDraft({ kind, task, knowledge = [], structure = null, materialText = '', sourceReferences = [] } = {}) {
  const labels = {
    topic: '选题方案',
    copy: '口播脚本与发布文案',
    platform: '平台适配版本',
    shotlist: '分镜与制作计划',
    retro: '复盘建议',
  };
  const label = labels[kind] || '内容方案';
  const knowledgeText = knowledge.length
    ? knowledge.map((item, index) => `资料${index + 1}《${item.title}》：\n${item.content}`).join('\n\n')
    : '没有检索到知识库资料。';
  const structureText = structure ? JSON.stringify(structure, null, 2) : '尚未完成结构分析。';
  const sourceText = text(materialText).slice(0, 30_000) || '尚未读取到可供引用的原始文本。';
  const references = sourceIndex({ knowledge, sourceReferences });
  const prompt = [
    `请为下面的内容任务生成${label}。`,
    '必须区分“资料中明确存在”和“建议/推断”；不能把推断写成已实现功能或既有结果。',
    '不能捏造品牌、客户案例、数据、效果、价格、平台规则、账号状态、版权/授权状态或外部发布结果。',
    '除非原始资料明确说明，不得使用“自动”“高效”“节省”“提升”“保障”“爆款”等结果或能力承诺；不确定时改写为待确认项。',
    '输出必须包含“事实依据与待确认”小节：列出每项关键功能/事实、对应的来源名称及原文短摘录；视频素材有时间码时同时列出秒数；找不到依据时明确写“待确认”，而不是补写。',
    '草案是内部审核稿，不得把来源索引、路径或系统提示直接写成面向用户的营销内容。',
    `任务名称：${task?.title || '未命名'}`,
    `业务目标：${task?.objective || '未填写'}`,
    `目标受众：${task?.audience || '未指定'}`,
    `目标平台：${Array.isArray(task?.platforms) ? task.platforms.join('、') : '未指定'}`,
    `素材说明：${task?.sourceBrief || '未填写'}`,
    `可引用来源索引：\n${references}`,
    `原始素材文本（只可据此引用，不足部分必须标记为待确认）：\n${sourceText}`,
    `结构分析：\n${structureText}`,
    `知识库资料：\n${knowledgeText}`,
  ].join('\n\n');
  if (!text(process.env.DEEPSEEK_API_KEY) && aiProviderStatus().localDraftGenerator) {
    return localContentDraft({ kind, task, knowledge, structure, materialText, sourceReferences });
  }
  const generated = await generateText({
    system: '你是内容编辑云员工。先理解业务目标，再形成可审稿的内容，不直接发布。',
    prompt,
    temperature: 0.5,
    maxTokens: kind === 'copy' ? 3000 : 2200,
  });
  return {
    ...generated,
    promptVersion: CONTENT_DRAFT_PROMPT_VERSION,
    sourceIndex: references,
  };
}
