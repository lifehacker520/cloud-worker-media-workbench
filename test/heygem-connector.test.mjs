import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HeyGemSshConnector, HEYGEM_CONNECTOR_ID } from '../src/heygem-connector.mjs';

function tempVideo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heygem-'));
  const file = path.join(dir, 'avatar.mp4');
  fs.writeFileSync(file, 'fake');
  return file;
}

function makeConnector(overrides = {}) {
  const avatarVideo = tempVideo();
  const calls = { tts: 0, generate: 0 };
  const connector = new HeyGemSshConnector({
    speakerFallback: 'S_TEST123',
    defaultAvatarVideo: avatarVideo,
    ttsGenerate: async () => { calls.tts += 1; return { ok: true }; },
    heygemGenerateImpl: async () => { calls.generate += 1; return { ok: true, localFile: avatarVideo }; },
    probe: async () => [{ code: 'DECODABLE', status: 'succeeded' }],
    ...overrides,
  });
  return { connector, calls, avatarVideo };
}

test('HeyGem 连接器：成功路径产出真实输出（simulated=false，含媒体校验与厂商信息）', async () => {
  const { connector, calls } = makeConnector();
  assert.equal(connector.id, HEYGEM_CONNECTOR_ID);
  const output = await connector.generate({ item: { id: 'item_1', attempt: 2, input: { script: { text: '大家好' }, avatarVersionId: 'a1' } }, workerId: 'w1' });
  assert.equal(output.simulated, false);
  assert.equal(output.verificationStatus, undefined);
  assert.equal(output.provider, 'heygem-autodl-ssh');
  assert.equal(output.modelVersion, 'heygem-autodl-ssh');
  assert.equal(output.attempt, 2);
  assert.equal(output.reviewRequired, true);
  assert.match(output.videoRef, /avatar\.mp4$/);
  assert.equal(output.mediaChecks[0].status, 'succeeded');
  assert.equal(calls.tts, 1);
  assert.equal(calls.generate, 1);
});

test('HeyGem 连接器：缺文案/声音/视频时给出可分类错误且不产出模拟结果', async () => {
  const { connector } = makeConnector();
  await assert.rejects(
    () => connector.generate({ item: { id: 'x', input: { avatarVersionId: 'a1' } } }),
    (error) => error.code === 'HEYGEM_SCRIPT_TEXT_MISSING' && error.retryable === false,
  );
  const noFallback = makeConnector({ speakerFallback: null });
  await assert.rejects(
    () => noFallback.connector.generate({ item: { id: 'x', input: { script: { text: '你好' }, avatarVersionId: 'a1' } } }),
    (error) => error.code === 'HEYGEM_SPEAKER_MISSING',
  );
  const noVideo = makeConnector({ defaultAvatarVideo: '/nonexistent/avatar.mp4' });
  await assert.rejects(
    () => noVideo.connector.generate({ item: { id: 'x2', input: { script: { text: '你好' } } } }),
    (error) => error.code === 'HEYGEM_AVATAR_VIDEO_MISSING',
  );
});

test('HeyGem 连接器：媒体校验不通过时按可重试失败处理', async () => {
  const { connector } = makeConnector({ probe: async () => [{ code: 'DECODABLE', status: 'failed' }] });
  await assert.rejects(
    () => connector.generate({ item: { id: 'y', input: { script: { text: '你好' } } } }),
    (error) => error.code === 'HEYGEM_MEDIA_CHECK_FAILED' && error.retryable === true,
  );
});

test('HeyGem 连接器：worker 失败归类为可重试的 worker_error', async () => {
  const { connector } = makeConnector({ heygemGenerateImpl: async () => ({ ok: false, error: 'ssh timeout' }) });
  await assert.rejects(
    () => connector.generate({ item: { id: 'z', input: { script: { text: '你好' } } } }),
    (error) => error.code === 'HEYGEM_GENERATE_FAILED' && error.errorClass === 'worker_error',
  );
});
