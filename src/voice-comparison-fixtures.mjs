const LONG_SCRIPT_UNIT = '今天我们用同一份口播稿验证声音稳定性：云员工 Cloud Employee 要准确读出 2026 年 9 月 7 日、99 元和 AIOS，并在停顿、转折和重点表达之间保持自然。';

export const VOICE_COMPARISON_TEST_SET = Object.freeze({
  version: 'm5-voice-eval-v1',
  title: 'M5 声音 A/B 固定验收集',
  qualityDimensions: Object.freeze([
    'accuracy',
    'naturalness',
    'speed',
    'resource_usage',
    'failures',
    'license_and_authorization',
  ]),
  cases: Object.freeze([
    {
      id: 'short-script',
      kind: 'positive',
      label: '短稿基线',
      text: '欢迎来到云员工工作台，今天用一句短稿检查声音清晰度和起止是否稳定。',
      acceptance: '完整生成并人工试听。',
    },
    {
      id: 'long-script-60-120s',
      kind: 'positive',
      label: '长稿 60–120 秒',
      text: Array.from({ length: 8 }, () => LONG_SCRIPT_UNIT).join(''),
      durationTargetSeconds: Object.freeze({ min: 60, max: 120 }),
      acceptance: '按稳定顺序分段，保留每段时间码和 attempt；失败段可独立重试。',
    },
    {
      id: 'numbers-date-money',
      kind: 'positive',
      label: '中文数字、日期与金额',
      text: '订单编号是 2026-0907，活动日期为 9 月 7 日，原价 1,299 元，限时价 99 元。',
      acceptance: '人工核对数字、日期、货币单位和停顿。',
    },
    {
      id: 'bilingual-brand-terms',
      kind: 'positive',
      label: '中英文品牌词',
      text: '云员工 Cloud Employee 连接 AIOS 工作台，发布前请核对品牌大小写、英文读法和中文名称。',
      acceptance: '人工核对中英文品牌词读法，不以模型默认发音作为事实。',
    },
    {
      id: 'pauses-punctuation-emotion',
      kind: 'positive',
      label: '停顿、标点与情绪',
      text: '先别急——听我说完。真的？当然！这一段要有克制的停顿、清楚的转折，以及可信而不过度的强调。',
      acceptance: '人工试听停顿、标点边界、情绪强度和语速。',
    },
    {
      id: 'reference-too-short',
      kind: 'negative',
      label: '参考音频过短',
      expectedGate: 'blocked',
      blockedReason: 'reference_audio_too_short',
      acceptance: '没有达到部署方规定的最短参考音频时，拒绝进入克隆生成。',
    },
    {
      id: 'reference-noise',
      kind: 'negative',
      label: '参考音频噪声过高',
      expectedGate: 'blocked',
      blockedReason: 'reference_audio_noise_too_high',
      acceptance: '噪声或人声不可分离时，拒绝进入克隆生成并说明补救方式。',
    },
    {
      id: 'reference-bad-format',
      kind: 'negative',
      label: '参考音频格式不可用',
      expectedGate: 'blocked',
      blockedReason: 'reference_audio_format_invalid',
      acceptance: '格式、采样率或文件损坏不符合 Worker 合约时，拒绝进入生成。',
    },
    {
      id: 'unauthorized-voice',
      kind: 'negative',
      label: '未授权声音',
      expectedGate: 'blocked',
      blockedReason: 'voice_authorization_missing',
      acceptance: '没有 approved 授权、授权引用或 batchAllowed 时，拒绝进入生成。',
    },
  ]),
});

export function voiceComparisonTestSet() {
  return VOICE_COMPARISON_TEST_SET;
}
