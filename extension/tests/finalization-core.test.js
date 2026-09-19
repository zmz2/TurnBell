'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  acceptDomCandidate,
  beginTurn,
  normalizeState,
} = require('../src/finalization-core.js');

const IDENTITY = {
  tabId: 42,
  documentId: 'document-1',
  pathHash: 'a'.repeat(32),
  routeEpoch: 3,
  completionId: 'completion-1',
};

function firstTurn(source = 'explicit') {
  return beginTurn(null, {
    ...IDENTITY,
    at: 1_000,
    startedAt: 900,
    userCount: 1,
    assistantCount: 0,
    source,
  }).state;
}

function candidate(overrides = {}) {
  return {
    ...IDENTITY,
    at: 3_000,
    hasFinalAction: true,
    finalEvidence: 'final-action',
    ...overrides,
  };
}

test('beginTurn stores route-scoped opaque identity and reuses the same completion id', () => {
  const first = beginTurn(null, { ...IDENTITY, at: 1_000, startedAt: 900, userCount: 1 });
  const same = beginTurn(first.state, {
    ...IDENTITY, at: 1_100, startedAt: 950, userCount: 2, assistantCount: 1,
  });

  assert.equal(first.state.cycleNumber, 1);
  assert.equal(first.state.completionId, 'completion-1');
  assert.equal(same.action.reason, 'same-completion');
  assert.equal(same.state.cycleNumber, 1);
  assert.equal(same.state.startedAt, 900);
  assert.equal(same.state.baselineUserCount, 2);
  assert.equal(same.state.baselineAssistantCount, 0);
});

test('a candidate requires matching document, path, route epoch, and completion id', () => {
  const state = firstTurn();
  for (const [override, reason] of [
    [{ documentId: 'other-document' }, 'document-mismatch'],
    [{ pathHash: 'b'.repeat(32) }, 'route-mismatch'],
    [{ routeEpoch: 2 }, 'stale-route-epoch'],
    [{ completionId: 'other-completion' }, 'completion-mismatch'],
  ]) {
    const result = acceptDomCandidate(state, candidate(override));
    assert.equal(result.action.type, 'suppress');
    assert.equal(result.action.reason, reason);
    assert.equal(result.state.notified, false);
  }
});

test('progress without trusted final evidence never completes a turn', () => {
  const result = acceptDomCandidate(firstTurn(), candidate({ hasFinalAction: false, finalEvidence: '' }));
  assert.equal(result.action.type, 'suppress');
  assert.equal(result.action.reason, 'not-final-render');
  assert.equal(result.state.notified, false);
});

test('actionless final evidence is accepted only for explicit turns without generation evidence', () => {
  const explicit = acceptDomCandidate(firstTurn('explicit'), candidate({
    hasFinalAction: false,
    finalEvidence: 'explicit-fast-stable',
  }));
  assert.equal(explicit.action.type, 'notify');
  assert.equal(explicit.action.source, 'dom-fast-final');

  const implicit = acceptDomCandidate(firstTurn('implicit'), candidate({
    hasFinalAction: false,
    finalEvidence: 'explicit-fast-stable',
  }));
  assert.equal(implicit.action.reason, 'untrusted-actionless-final');

  const generated = firstTurn('explicit');
  generated.sawGenerating = true;
  const generatedResult = acceptDomCandidate(generated, candidate({
    hasFinalAction: false,
    finalEvidence: 'explicit-fast-stable',
  }));
  assert.equal(generatedResult.action.reason, 'untrusted-actionless-final');
});

test('one final candidate notifies once and duplicate evidence stays suppressed', () => {
  const first = acceptDomCandidate(firstTurn(), candidate());
  const duplicate = acceptDomCandidate(first.state, candidate({ at: 3_200 }));

  assert.equal(first.action.type, 'notify');
  assert.equal(first.action.source, 'dom-final');
  assert.equal(first.state.notified, true);
  assert.equal(first.state.notificationStatus, 'pending');
  assert.equal(duplicate.action.type, 'notify');
  assert.equal(duplicate.action.reason, 'notification-pending');

  const delivered = acceptDomCandidate({ ...first.state, notificationStatus: 'delivered' }, candidate({ at: 3_300 }));
  assert.equal(delivered.action.type, 'suppress');
  assert.equal(delivered.action.reason, 'already-notified');
});

test('suspended and expired turns cannot be finalized', () => {
  const suspended = firstTurn();
  suspended.suspended = true;
  const suspendedResult = acceptDomCandidate(suspended, candidate());
  assert.equal(suspendedResult.action.reason, 'route-suspended');

  const expired = firstTurn();
  expired.expiresAt = 2_000;
  const expiredResult = acceptDomCandidate(expired, candidate({ at: 3_000 }));
  assert.equal(expiredResult.action.reason, 'expired-turn');
});

test('normalizeState retains only minimal completion metadata', () => {
  assert.equal(normalizeState(null), null);
  const state = normalizeState({
    ...IDENTITY,
    cycleNumber: -2,
    source: 'explicit',
    baselineUserCount: -1,
    baselineAssistantCount: 2,
    startedAt: 'bad',
    notified: 1,
    notifiedAt: 9,
    turnKey: 'must-not-survive',
    fingerprint: 'must-not-survive',
    answer: 'must-not-survive',
    title: 'must-not-survive',
    activeRequestIds: ['must-not-survive'],
  });
  assert.deepEqual(state, {
    tabId: 42,
    cycleNumber: 1,
    documentId: 'document-1',
    pathHash: 'a'.repeat(32),
    routeEpoch: 3,
    completionId: 'completion-1',
    startSource: 'implicit',
    baselineUserCount: 0,
    baselineAssistantCount: 2,
    startedAt: 0,
    lastActivityAt: 0,
    phase: 'waiting',
    sawGenerating: false,
    suspended: false,
    expiresAt: 0,
    notified: true,
    notifiedAt: 9,
    notificationStatus: 'delivered',
    notificationAttempts: 0,
    notificationRetryAt: 0,
    tabHidden: false,
  });
  assert.equal(JSON.stringify(state).includes('must-not-survive'), false);
});
