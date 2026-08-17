'use strict';

(function exposeFinalizationCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.GPTReplyFinalization = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function finalizationFactory() {
  function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeSource(value) {
    return String(value || '').toLowerCase() === 'explicit' ? 'explicit' : 'implicit';
  }

  function normalizeState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      tabId: Number.isInteger(raw.tabId) ? raw.tabId : null,
      cycleNumber: Math.max(1, Math.trunc(finite(raw.cycleNumber, 1))),
      turnKey: String(raw.turnKey || ''),
      startSource: normalizeSource(raw.startSource),
      userCount: Math.max(0, Math.trunc(finite(raw.userCount, 0))),
      startedAt: Math.max(0, finite(raw.startedAt, 0)),
      lastActivityAt: Math.max(0, finite(raw.lastActivityAt, 0)),
      notified: Boolean(raw.notified),
      notifiedAt: Math.max(0, finite(raw.notifiedAt, 0)),
      fingerprint: String(raw.fingerprint || ''),
    };
  }

  function newState(previous, event = {}) {
    const prior = normalizeState(previous);
    const at = Math.max(0, finite(event.at, Date.now()));
    const suppliedStart = Math.max(0, finite(event.startedAt, at));
    const startedAt = Math.min(at, suppliedStart);
    return {
      tabId: Number.isInteger(event.tabId) ? event.tabId : prior?.tabId ?? null,
      cycleNumber: (prior?.cycleNumber || 0) + 1,
      turnKey: String(event.turnKey || ''),
      startSource: normalizeSource(event.source),
      userCount: Math.max(0, Math.trunc(finite(event.userCount, 0))),
      startedAt,
      lastActivityAt: at,
      notified: false,
      notifiedAt: 0,
      fingerprint: '',
    };
  }

  function beginTurn(rawState, event = {}) {
    const state = normalizeState(rawState);
    const turnKey = String(event.turnKey || '');
    if (state && turnKey && state.turnKey === turnKey) {
      return { state, action: { type: 'noop', reason: 'same-turn' } };
    }
    return { state: newState(state, event), action: { type: 'new-turn' } };
  }

  function ensureState(rawState, event = {}) {
    return normalizeState(rawState) || newState(null, event);
  }

  function acceptDomCandidate(rawState, event = {}) {
    let state = ensureState(rawState, event);
    const hasFinalAction = event.hasFinalAction === true;
    const finalEvidence = hasFinalAction ? 'final-action' : String(event.finalEvidence || '');
    const trustedActionlessFinal = (
      finalEvidence === 'explicit-fast-stable'
      && state.startSource === 'explicit'
    );
    if (!hasFinalAction && !trustedActionlessFinal) {
      return {
        state,
        action: {
          type: 'suppress',
          reason: finalEvidence === 'explicit-fast-stable'
            ? 'untrusted-actionless-final'
            : 'not-final-render',
        },
      };
    }

    const eventTurnKey = String(event.turnKey || '');
    if (state.turnKey && eventTurnKey && state.turnKey !== eventTurnKey) {
      const eventStartedAt = Math.max(0, finite(event.startedAt, 0));
      const eventUserCount = Math.max(0, Math.trunc(finite(event.userCount, 0)));
      const demonstrablyNewer = (eventStartedAt > state.startedAt) || (eventUserCount > state.userCount);
      if (!demonstrablyNewer) {
        return { state, action: { type: 'suppress', reason: 'stale-turn-key' } };
      }
      state = newState(state, event);
    }

    if (state.notified) {
      return { state, action: { type: 'suppress', reason: 'already-notified' } };
    }

    const at = Math.max(state.lastActivityAt, finite(event.at, Date.now()));
    if (!state.turnKey && eventTurnKey) state.turnKey = eventTurnKey;
    state.lastActivityAt = at;
    state.notified = true;
    state.notifiedAt = at;
    state.fingerprint = String(event.fingerprint || '');
    return {
      state,
      action: {
        type: 'notify',
        source: trustedActionlessFinal ? 'dom-fast-final' : 'dom-final',
        cycleNumber: state.cycleNumber,
        startedAt: state.startedAt,
        completedAt: at,
      },
    };
  }

  return Object.freeze({ acceptDomCandidate, beginTurn, normalizeState });
}));
