import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  VOICE_COMPARISON_TEST_SET,
  voiceComparisonTestSet,
} from '../src/voice-comparison-fixtures.mjs';

test('M5 voice comparison test set is fixed, covers positive samples, and keeps blocking cases explicit', () => {
  const fixture = voiceComparisonTestSet();
  assert.equal(fixture.version, 'm5-voice-eval-v1');
  assert.equal(fixture, VOICE_COMPARISON_TEST_SET);
  assert.deepEqual(
    fixture.cases.map((item) => item.id),
    [
      'short-script',
      'long-script-60-120s',
      'numbers-date-money',
      'bilingual-brand-terms',
      'pauses-punctuation-emotion',
      'reference-too-short',
      'reference-noise',
      'reference-bad-format',
      'unauthorized-voice',
    ],
  );
  const longCase = fixture.cases.find((item) => item.id === 'long-script-60-120s');
  assert.equal(longCase.kind, 'positive');
  assert.ok(longCase.text.length >= 480 && longCase.text.length <= 960);
  assert.deepEqual(longCase.durationTargetSeconds, { min: 60, max: 120 });
  assert.equal(fixture.cases.filter((item) => item.kind === 'negative').length, 4);
  assert.ok(fixture.cases.filter((item) => item.kind === 'positive').every((item) => item.text));
  assert.ok(fixture.cases.filter((item) => item.kind === 'negative').every((item) => item.expectedGate === 'blocked'));
});
