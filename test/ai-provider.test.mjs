import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

import { aiProviderStatus, generateContentDraft, generateText } from '../src/ai-provider.mjs';

test('DeepSeek adapter sends a real OpenAI-compatible request and keeps response metadata', async () => {
  const previous = {
    key: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
    model: process.env.DEEPSEEK_MODEL,
  };
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ headers: request.headers, body: JSON.parse(body) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'mock-request-1',
      choices: [{ message: { content: '这是可供人工审核的测试草案。' } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    process.env.DEEPSEEK_API_KEY = 'test-only-key';
    process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.DEEPSEEK_MODEL = 'test-model';
    assert.equal(aiProviderStatus().configured, true);
    const result = await generateText({ system: '测试系统提示词', prompt: '测试用户提示词' });
    assert.equal(result.text, '这是可供人工审核的测试草案。');
    assert.equal(result.requestId, 'mock-request-1');
    assert.equal(result.usage.total_tokens, 20);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.authorization, 'Bearer test-only-key');
    assert.equal(requests[0].body.model, 'test-model');
    assert.equal(requests[0].body.messages[1].content, '测试用户提示词');

    const generated = await generateContentDraft({
      kind: 'copy',
      task: { title: '来源约束测试', objective: '验证内容来源', audience: '测试用户', platforms: ['小红书'] },
      materialText: '素材只说明需要人工审核。',
      sourceReferences: [{ id: 'asset_fixture', filename: 'fixture.md', kind: 'text' }],
    });
    assert.equal(generated.promptVersion, 'content-draft-v0.3-grounded-timecoded');
    assert.match(generated.sourceIndex, /fixture\.md/);
    assert.match(requests.at(-1).body.messages[1].content, /事实依据与待确认/);
    assert.match(requests.at(-1).body.messages[1].content, /自动/);
  } finally {
    if (previous.key === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous.key;
    if (previous.baseUrl === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = previous.baseUrl;
    if (previous.model === undefined) delete process.env.DEEPSEEK_MODEL;
    else process.env.DEEPSEEK_MODEL = previous.model;
    server.close();
    await once(server, 'close');
  }
});

test('local draft generator produces a source-bounded reviewable draft without an API key', async () => {
  const previous = {
    key: process.env.DEEPSEEK_API_KEY,
    local: process.env.XHS_LOCAL_DRAFT_GENERATOR,
  };
  try {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.XHS_LOCAL_DRAFT_GENERATOR = 'true';
    assert.equal(aiProviderStatus().configured, false);
    assert.equal(aiProviderStatus().localDraftGenerator, true);
    const result = await generateContentDraft({
      kind: 'topic',
      task: {
        title: '本地模板验收',
        objective: '验证素材可进入草案',
        audience: '企业经营者',
        platforms: ['小红书'],
        sourceBrief: '素材说明：围绕销售和客服工作流进行说明。',
      },
      materialText: '销售助手可以持续回答问题。客服流程需要人工确认。',
    });
    assert.equal(result.provider, 'local-template');
    assert.equal(result.model, 'extractive-v0.1');
    assert.match(result.text, /候选选题/);
    assert.match(result.text, /销售助手可以持续回答问题/);
    assert.match(result.text, /人工确认/);
  } finally {
    if (previous.key === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous.key;
    if (previous.local === undefined) delete process.env.XHS_LOCAL_DRAFT_GENERATOR;
    else process.env.XHS_LOCAL_DRAFT_GENERATOR = previous.local;
  }
});
