'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDetector } = require('../src/detector-core.js');

function snapshot({
  now,
  isGenerating = false,
  assistantText = '',
  assistantCount = assistantText ? 1 : 0,
  userCount = 0,
  isFinalRenderable = true,
  allowImplicitStart = true,
  allowActionlessFinal = false,
} = {}) {
  return {
    now,
    isGenerating,
    assistantText,
    assistantCount,
    userCount,
    isFinalRenderable,
    allowImplicitStart,
    allowActionlessFinal,
  };
}

function detector(overrides = {}) {
  return createDetector({
    quietPeriodMs: 800,
    minGenerationMs: 0,
    maxWaitMs: 60_000,
    ...overrides,
  });
}

test('initial historical conversation does not emit a completion', () => {
  const d = detector();

  assert.equal(d.step(snapshot({ now: 0, assistantText: 'old answer', userCount: 1 })), null);
  assert.equal(d.step(snapshot({ now: 10_000, assistantText: 'old answer', userCount: 1 })), null);
  assert.equal(d.getState().phase, 'idle');
});

test('emits once after generation stops and the reply stays quiet', () => {
  const d = detector();

  d.step(snapshot({ now: 0, assistantText: 'old answer', userCount: 1 }));
  d.step(snapshot({ now: 100, assistantText: 'old answer', userCount: 2 }));
  d.step(snapshot({ now: 150, isGenerating: true, assistantText: 'old answer', userCount: 2 }));
  d.step(snapshot({ now: 900, isGenerating: true, assistantText: 'new answer', userCount: 2 }));

  assert.equal(d.step(snapshot({ now: 1_000, assistantText: 'new answer', userCount: 2 })), null);
  assert.equal(d.step(snapshot({ now: 1_799, assistantText: 'new answer', userCount: 2 })), null);

  const event = d.step(snapshot({ now: 1_800, assistantText: 'new answer', userCount: 2 }));
  assert.equal(event.type, 'complete');
  assert.equal(event.replyText, 'new answer');
  assert.equal(event.durationMs, 1_700);
  assert.equal(event.startedAt, 100);
  assert.equal(event.completedAt, 1_800);
  assert.match(event.fingerprint, /^[a-f0-9]{8}$/);

  assert.equal(d.step(snapshot({ now: 3_000, assistantText: 'new answer', userCount: 2 })), null);
  assert.equal(d.getState().phase, 'idle');
});

test('quiet period starts again when text changes after the stop control disappears', () => {
  const d = detector({ quietPeriodMs: 500 });

  d.step(snapshot({ now: 0, userCount: 1 }));
  d.step(snapshot({ now: 10, userCount: 2 }));
  d.step(snapshot({ now: 20, isGenerating: true, assistantText: 'A', userCount: 2 }));
  d.step(snapshot({ now: 100, assistantText: 'A', userCount: 2 }));
  d.step(snapshot({ now: 450, assistantText: 'A plus citation', userCount: 2 }));

  assert.equal(d.step(snapshot({ now: 949, assistantText: 'A plus citation', userCount: 2 })), null);
  assert.equal(d.step(snapshot({ now: 950, assistantText: 'A plus citation', userCount: 2 })).type, 'complete');
});

test('minimum duration delays notification even when the reply is already quiet', () => {
  const d = detector({ quietPeriodMs: 100, minGenerationMs: 1_000 });

  d.step(snapshot({ now: 0, userCount: 1 }));
  d.step(snapshot({ now: 10, userCount: 2 }));
  d.step(snapshot({ now: 20, isGenerating: true, assistantText: 'fast', userCount: 2 }));
  d.step(snapshot({ now: 100, assistantText: 'fast', userCount: 2 }));

  assert.equal(d.step(snapshot({ now: 999, assistantText: 'fast', userCount: 2 })), null);
  assert.equal(d.step(snapshot({ now: 1_010, assistantText: 'fast', userCount: 2 })).type, 'complete');
});

test('falls back to user-turn and assistant-text changes when no stop button is observed', () => {
  const d = detector({ quietPeriodMs: 300 });

  d.step(snapshot({ now: 0, assistantText: 'old', userCount: 1 }));
  d.step(snapshot({ now: 100, assistantText: 'old', userCount: 2 }));
  d.step(snapshot({ now: 200, assistantText: 'new partial', userCount: 2 }));
  d.step(snapshot({ now: 400, assistantText: 'new final', userCount: 2 }));

  assert.equal(d.step(snapshot({ now: 699, assistantText: 'new final', userCount: 2 })), null);
  assert.equal(d.step(snapshot({ now: 700, assistantText: 'new final', userCount: 2 })).type, 'complete');
});

test('generation indicator alone re-arms regenerate and edit flows', () => {
  const d = detector({ quietPeriodMs: 200 });

  d.step(snapshot({ now: 0, assistantText: 'first', userCount: 1 }));
  d.step(snapshot({ now: 100, isGenerating: true, assistantText: 'first', userCount: 1 }));
  d.step(snapshot({ now: 300, isGenerating: true, assistantText: 'second', userCount: 1 }));
  d.step(snapshot({ now: 400, assistantText: 'second', userCount: 1 }));

  const event = d.step(snapshot({ now: 600, assistantText: 'second', userCount: 1 }));
  assert.equal(event.type, 'complete');
  assert.equal(event.replyText, 'second');
});

test('a stopped cycle with no assistant change does not notify', () => {
  const d = detector({ quietPeriodMs: 100 });

  d.step(snapshot({ now: 0, assistantText: 'same', userCount: 1 }));
  d.step(snapshot({ now: 10, isGenerating: true, assistantText: 'same', userCount: 1 }));
  d.step(snapshot({ now: 100, assistantText: 'same', userCount: 1 }));

  assert.equal(d.step(snapshot({ now: 1_000, assistantText: 'same', userCount: 1 })), null);
  assert.equal(d.getState().phase, 'idle');
});

test('an armed cycle expires instead of notifying stale mutations', () => {
  const d = detector({ quietPeriodMs: 100, maxWaitMs: 500 });

  d.step(snapshot({ now: 0, assistantText: 'old', userCount: 1 }));
  d.step(snapshot({ now: 10, assistantText: 'old', userCount: 2 }));
  d.step(snapshot({ now: 600, assistantText: 'old', userCount: 2 }));
  assert.equal(d.getState().phase, 'idle');

  assert.equal(d.step(snapshot({ now: 700, assistantText: 'unrelated DOM update', userCount: 2 })), null);
});

test('normalizes non-string assistant text and non-monotonic timestamps defensively', () => {
  const d = detector({ quietPeriodMs: 0 });

  d.step(snapshot({ now: 100, assistantText: null, userCount: 0 }));
  d.step(snapshot({ now: 90, isGenerating: true, assistantText: 42, userCount: 0 }));
  d.step(snapshot({ now: 95, assistantText: 42, userCount: 0 }));

  const event = d.step(snapshot({ now: 100, assistantText: 42, userCount: 0 }));
  assert.equal(event.replyText, '42');
  assert.ok(event.durationMs >= 0);
});

test('does not complete on a stable reasoning recap and waits for a final-render signal', () => {
  const detector = createDetector({ quietPeriodMs: 500, minGenerationMs: 0 });

  detector.step({
    now: 0,
    isGenerating: false,
    assistantText: '',
    assistantCount: 0,
    userCount: 0,
    isFinalRenderable: false,
  });
  detector.step({
    now: 100,
    isGenerating: true,
    assistantText: '正在处理',
    assistantCount: 1,
    userCount: 1,
    isFinalRenderable: false,
  });
  detector.step({
    now: 1_000,
    isGenerating: false,
    assistantText: '你的补充基本排除了窗口失焦误判',
    assistantCount: 1,
    userCount: 1,
    isFinalRenderable: false,
  });

  const recapResult = detector.step({
    now: 2_000,
    isGenerating: false,
    assistantText: '你的补充基本排除了窗口失焦误判',
    assistantCount: 1,
    userCount: 1,
    isFinalRenderable: false,
  });
  assert.equal(recapResult, null);
  assert.equal(detector.getState().phase, 'settling');

  detector.step({
    now: 2_100,
    isGenerating: false,
    assistantText: '最终完整回答',
    assistantCount: 2,
    userCount: 1,
    isFinalRenderable: true,
  });
  const finalResult = detector.step({
    now: 2_700,
    isGenerating: false,
    assistantText: '最终完整回答',
    assistantCount: 2,
    userCount: 1,
    isFinalRenderable: true,
  });

  assert.equal(finalResult?.type, 'complete');
  assert.equal(finalResult?.replyText, '最终完整回答');
});

test('a newly added assistant turn starts detection even when user and stop selectors are missed', () => {
  const d = detector({ quietPeriodMs: 500 });

  d.step(snapshot({ now: 0, assistantText: '', assistantCount: 0, userCount: 1 }));
  d.step({
    now: 1_000,
    isGenerating: false,
    assistantText: 'final answer',
    assistantCount: 1,
    userCount: 1,
    isFinalRenderable: true,
  });
  const event = d.step({
    now: 1_500,
    isGenerating: false,
    assistantText: 'final answer',
    assistantCount: 1,
    userCount: 1,
    isFinalRenderable: true,
  });

  assert.equal(event?.type, 'complete');
  assert.equal(event?.replyText, 'final answer');
});

test('a long tool run remains armed until the final assistant turn appears', () => {
  const d = createDetector({ quietPeriodMs: 500, minGenerationMs: 0 });

  d.step(snapshot({ now: 0, assistantText: '', assistantCount: 0, userCount: 0 }));
  d.step(snapshot({ now: 100, assistantText: '', assistantCount: 0, userCount: 1 }));
  d.step(snapshot({ now: 10 * 60_000, assistantText: '', assistantCount: 0, userCount: 1 }));
  d.step({
    now: 20 * 60_000,
    isGenerating: false,
    assistantText: 'long research result',
    assistantCount: 1,
    userCount: 1,
    isFinalRenderable: true,
  });
  const event = d.step({
    now: 20 * 60_000 + 500,
    isGenerating: false,
    assistantText: 'long research result',
    assistantCount: 1,
    userCount: 1,
    isFinalRenderable: true,
  });

  assert.equal(event?.type, 'complete');
  assert.equal(event?.replyText, 'long research result');
});

test('explicit user intent arms a cycle when page variants hide user, stop, and new-turn selectors', () => {
  const d = detector({ quietPeriodMs: 300 });

  d.step(snapshot({ now: 0, assistantText: 'old answer', assistantCount: 1, userCount: 1 }));
  d.arm(snapshot({ now: 100, assistantText: 'old answer', assistantCount: 1, userCount: 1 }));
  d.step({
    now: 400,
    isGenerating: false,
    assistantText: 'replacement final answer',
    assistantCount: 1,
    userCount: 1,
    isFinalRenderable: true,
  });
  const event = d.step({
    now: 700,
    isGenerating: false,
    assistantText: 'replacement final answer',
    assistantCount: 1,
    userCount: 1,
    isFinalRenderable: true,
  });

  assert.equal(event?.type, 'complete');
  assert.equal(event?.replyText, 'replacement final answer');
});


test('an explicitly armed Instant-style turn completes after a conservative quiet period without an action row', () => {
  const d = detector({ quietPeriodMs: 500, actionlessQuietPeriodMs: 2_500 });

  d.step(snapshot({ now: 0, assistantText: 'old answer', userCount: 1 }));
  d.arm(snapshot({ now: 100, assistantText: 'old answer', userCount: 1 }));
  d.step(snapshot({
    now: 300,
    assistantText: 'instant final answer',
    userCount: 2,
    isFinalRenderable: false,
    allowImplicitStart: false,
    allowActionlessFinal: true,
  }));

  assert.equal(d.step(snapshot({
    now: 2_799,
    assistantText: 'instant final answer',
    userCount: 2,
    isFinalRenderable: false,
    allowImplicitStart: false,
    allowActionlessFinal: true,
  })), null);

  const event = d.step(snapshot({
    now: 2_800,
    assistantText: 'instant final answer',
    userCount: 2,
    isFinalRenderable: false,
    allowImplicitStart: false,
    allowActionlessFinal: true,
  }));
  assert.equal(event?.type, 'complete');
  assert.equal(event?.finalEvidence, 'explicit-fast-stable');
  assert.equal(event?.hasFinalAction, false);
});

test('late hydrated history cannot arm a cycle when implicit DOM starts are disabled', () => {
  const d = detector({ quietPeriodMs: 300 });

  d.step(snapshot({
    now: 0,
    assistantText: '',
    assistantCount: 0,
    userCount: 0,
    allowImplicitStart: false,
  }));
  d.step(snapshot({
    now: 20_000,
    assistantText: 'historical answer loaded late',
    assistantCount: 1,
    userCount: 1,
    isFinalRenderable: false,
    allowImplicitStart: false,
    allowActionlessFinal: true,
  }));
  const result = d.step(snapshot({
    now: 21_000,
    assistantText: 'historical answer loaded late',
    assistantCount: 1,
    userCount: 1,
    isFinalRenderable: true,
    allowImplicitStart: false,
    allowActionlessFinal: true,
  }));

  assert.equal(result, null);
  assert.equal(d.getState().phase, 'idle');
});

test('actionless fallback never completes a cycle that exposed a generating state', () => {
  const d = detector({ quietPeriodMs: 300, actionlessQuietPeriodMs: 1_000 });

  d.step(snapshot({ now: 0, assistantText: 'old', userCount: 1 }));
  d.arm(snapshot({ now: 100, assistantText: 'old', userCount: 1 }));
  d.step(snapshot({
    now: 200,
    isGenerating: true,
    assistantText: 'reasoning progress',
    userCount: 2,
    isFinalRenderable: false,
    allowActionlessFinal: true,
  }));
  d.step(snapshot({
    now: 500,
    assistantText: 'reasoning recap',
    userCount: 2,
    isFinalRenderable: false,
    allowActionlessFinal: true,
  }));
  assert.equal(d.step(snapshot({
    now: 5_000,
    assistantText: 'reasoning recap',
    userCount: 2,
    isFinalRenderable: false,
    allowActionlessFinal: true,
  })), null);

  d.step(snapshot({
    now: 5_100,
    assistantText: 'real final answer',
    userCount: 2,
    isFinalRenderable: true,
    allowActionlessFinal: true,
  }));
  const final = d.step(snapshot({
    now: 5_400,
    assistantText: 'real final answer',
    userCount: 2,
    isFinalRenderable: true,
    allowActionlessFinal: true,
  }));
  assert.equal(final?.type, 'complete');
  assert.equal(final?.finalEvidence, 'final-action');
});
