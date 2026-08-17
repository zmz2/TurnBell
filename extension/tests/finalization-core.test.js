'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  acceptDomCandidate,
  beginTurn,
  normalizeState,
} = require('../src/finalization-core.js');

function firstTurn(source = 'explicit') {
  return beginTurn(null, {
    tabId: 42,
    at: 1_000,
    turnKey: 'turn-1',
    userCount: 1,
    source,
  }).state;
}

test('beginTurn creates a cycle, ignores the same key, and advances on a new key', () => {
  const first = beginTurn(null, { tabId: 42, at: 1_000, turnKey: 'turn-1', userCount: 1 });
  const same = beginTurn(first.state, { tabId: 42, at: 1_100, turnKey: 'turn-1', userCount: 1 });
  const second = beginTurn(first.state, { tabId: 42, at: 2_000, turnKey: 'turn-2', userCount: 2 });

  assert.equal(first.state.cycleNumber, 1);
  assert.equal(same.action.reason, 'same-turn');
  assert.equal(same.state.cycleNumber, 1);
  assert.equal(second.state.cycleNumber, 2);
  assert.equal(second.state.notified, false);
});

test('DOM progress without a final action row never completes a turn', () => {
  const result = acceptDomCandidate(firstTurn(), {
    at: 3_000,
    turnKey: 'turn-1',
    hasFinalAction: false,
    fingerprint: 'recap',
  });
  assert.equal(result.action.type, 'suppress');
  assert.equal(result.action.reason, 'not-final-render');
  assert.equal(result.state.notified, false);
});



test('an explicit Instant-style turn accepts stable actionless final evidence', () => {
  const result = acceptDomCandidate(firstTurn('explicit'), {
    at: 4_000,
    turnKey: 'turn-1',
    hasFinalAction: false,
    finalEvidence: 'explicit-fast-stable',
    fingerprint: 'instant-final',
  });
  assert.equal(result.action.type, 'notify');
  assert.equal(result.action.source, 'dom-fast-final');
  assert.equal(result.state.notified, true);
});

test('actionless final evidence is rejected unless the turn was explicitly started', () => {
  const result = acceptDomCandidate(firstTurn('implicit'), {
    at: 4_000,
    turnKey: 'turn-1',
    hasFinalAction: false,
    finalEvidence: 'explicit-fast-stable',
    fingerprint: 'historical-or-implicit',
  });
  assert.equal(result.action.type, 'suppress');
  assert.equal(result.action.reason, 'untrusted-actionless-final');
  assert.equal(result.state.notified, false);
});

test('one final DOM candidate notifies once and duplicate evidence is suppressed', () => {
  const first = acceptDomCandidate(firstTurn(), {
    at: 3_000,
    turnKey: 'turn-1',
    hasFinalAction: true,
    fingerprint: 'final-1',
  });
  const duplicate = acceptDomCandidate(first.state, {
    at: 3_200,
    turnKey: 'turn-1',
    hasFinalAction: true,
    fingerprint: 'final-1',
  });

  assert.equal(first.action.type, 'notify');
  assert.equal(first.action.source, 'dom-final');
  assert.equal(first.state.notified, true);
  assert.equal(duplicate.action.type, 'suppress');
  assert.equal(duplicate.action.reason, 'already-notified');
});

test('a different final turn key recovers when its explicit turn-start event was missed', () => {
  const notified = acceptDomCandidate(firstTurn(), {
    at: 3_000,
    turnKey: 'turn-1',
    hasFinalAction: true,
    fingerprint: 'final-1',
  }).state;
  const next = acceptDomCandidate(notified, {
    tabId: 42,
    at: 7_000,
    turnKey: 'turn-2',
    userCount: 2,
    hasFinalAction: true,
    fingerprint: 'final-2',
  });

  assert.equal(next.action.type, 'notify');
  assert.equal(next.state.cycleNumber, 2);
  assert.equal(next.state.turnKey, 'turn-2');
  assert.equal(next.state.fingerprint, 'final-2');
});

test('a delayed candidate from an older key cannot complete the currently active turn', () => {
  const activeSecond = beginTurn(firstTurn(), {
    tabId: 42,
    at: 4_000,
    turnKey: 'turn-2',
    userCount: 2,
  }).state;
  const stale = acceptDomCandidate(activeSecond, {
    startedAt: 1_000,
    at: 4_100,
    turnKey: 'turn-1',
    hasFinalAction: true,
    fingerprint: 'late-first',
  });

  assert.equal(stale.action.type, 'suppress');
  assert.equal(stale.action.reason, 'stale-turn-key');
  assert.equal(stale.state.notified, false);
  assert.equal(stale.state.turnKey, 'turn-2');
});

test('normalizeState strips malformed fields and preserves only the DOM ledger', () => {
  assert.equal(normalizeState(null), null);
  const state = normalizeState({
    tabId: 7,
    cycleNumber: -2,
    turnKey: 123,
    userCount: -1,
    startedAt: 'bad',
    notified: 1,
    notifiedAt: 9,
    fingerprint: 456,
    activeRequestIds: ['must-not-survive'],
  });
  assert.deepEqual(state, {
    tabId: 7,
    cycleNumber: 1,
    turnKey: '123',
    startSource: 'implicit',
    userCount: 0,
    startedAt: 0,
    lastActivityAt: 0,
    notified: true,
    notifiedAt: 9,
    fingerprint: '456',
  });
});


test('a newer final candidate recovers from an unnotified stale start record', () => {
  const staleStart = beginTurn(null, {
    tabId: 42,
    at: 1_000,
    turnKey: 'false-ui-intent',
    userCount: 1,
  }).state;
  const recovered = acceptDomCandidate(staleStart, {
    tabId: 42,
    startedAt: 5_000,
    at: 8_000,
    turnKey: 'real-turn-2',
    userCount: 1,
    hasFinalAction: true,
    fingerprint: 'final-real',
  });

  assert.equal(recovered.action.type, 'notify');
  assert.equal(recovered.state.turnKey, 'real-turn-2');
  assert.equal(recovered.state.startedAt, 5_000);
  assert.equal(recovered.action.startedAt, 5_000);
});


test('a different-key duplicate for an already notified turn stays suppressed', () => {
  const notified = acceptDomCandidate(firstTurn(), {
    startedAt: 1_000,
    at: 3_000,
    turnKey: 'turn-1',
    userCount: 1,
    hasFinalAction: true,
    fingerprint: 'final-1',
  }).state;
  const duplicateAlias = acceptDomCandidate(notified, {
    startedAt: 1_000,
    at: 3_200,
    turnKey: 'turn-1-alternate-dom-key',
    userCount: 1,
    hasFinalAction: true,
    fingerprint: 'final-1',
  });

  assert.equal(duplicateAlias.action.type, 'suppress');
  assert.equal(duplicateAlias.action.reason, 'stale-turn-key');
  assert.equal(duplicateAlias.state.cycleNumber, 1);
});
