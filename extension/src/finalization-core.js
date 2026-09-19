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
    const notified = Boolean(raw.notified);
    const rawNotificationStatus = String(raw.notificationStatus || '');
    const notificationStatus = ['none', 'pending', 'delivered', 'suppressed'].includes(rawNotificationStatus)
      ? rawNotificationStatus
      : (notified ? 'delivered' : 'none');
    return {
      tabId: Number.isInteger(raw.tabId) ? raw.tabId : null,
      cycleNumber: Math.max(1, Math.trunc(finite(raw.cycleNumber, 1))),
      documentId: String(raw.documentId || ''),
      pathHash: String(raw.pathHash || ''),
      routeEpoch: Math.max(0, Math.trunc(finite(raw.routeEpoch, 0))),
      completionId: String(raw.completionId || ''),
      startSource: normalizeSource(raw.startSource),
      baselineUserCount: Math.max(0, Math.trunc(finite(raw.baselineUserCount, 0))),
      baselineAssistantCount: Math.max(0, Math.trunc(finite(raw.baselineAssistantCount, 0))),
      startedAt: Math.max(0, finite(raw.startedAt, 0)),
      lastActivityAt: Math.max(0, finite(raw.lastActivityAt, 0)),
      phase: String(raw.phase || 'waiting'),
      sawGenerating: Boolean(raw.sawGenerating),
      suspended: Boolean(raw.suspended),
      expiresAt: Math.max(0, finite(raw.expiresAt, 0)),
      notified,
      notifiedAt: Math.max(0, finite(raw.notifiedAt, 0)),
      notificationStatus,
      notificationAttempts: Math.max(0, Math.trunc(finite(raw.notificationAttempts, 0))),
      notificationRetryAt: Math.max(0, finite(raw.notificationRetryAt, 0)),
      tabHidden: Boolean(raw.tabHidden),
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
      documentId: String(event.documentId || ''),
      pathHash: String(event.pathHash || ''),
      routeEpoch: Math.max(0, Math.trunc(finite(event.routeEpoch, 0))),
      completionId: String(event.completionId || ''),
      startSource: normalizeSource(event.source),
      baselineUserCount: Math.max(0, Math.trunc(finite(event.userCount, 0))),
      baselineAssistantCount: Math.max(0, Math.trunc(finite(event.assistantCount, 0))),
      startedAt,
      lastActivityAt: at,
      phase: 'waiting',
      sawGenerating: false,
      suspended: false,
      expiresAt: Math.max(at, finite(event.expiresAt, at + 24 * 60 * 60 * 1_000)),
      notified: false,
      notifiedAt: 0,
      notificationStatus: 'none',
      notificationAttempts: 0,
      notificationRetryAt: 0,
      tabHidden: event.tabHidden === true,
    };
  }

  function beginTurn(rawState, event = {}) {
    const state = normalizeState(rawState);
    const completionId = String(event.completionId || '');
    if (state && completionId && state.completionId === completionId) {
      if (state.notified) return { state, action: { type: 'noop', reason: 'already-notified' } };
      state.documentId = String(event.documentId || state.documentId);
      state.pathHash = String(event.pathHash || state.pathHash);
      state.routeEpoch = Math.max(state.routeEpoch, Math.trunc(finite(event.routeEpoch, state.routeEpoch)));
      state.startSource = state.startSource === 'explicit' || normalizeSource(event.source) === 'explicit'
        ? 'explicit'
        : 'implicit';
      state.baselineUserCount = Math.max(state.baselineUserCount, Math.trunc(finite(event.userCount, state.baselineUserCount)));
      // Keep the original assistant baseline. Repeated turn-start messages can
      // arrive after ChatGPT has inserted an empty/streaming assistant shell;
      // folding that shell into the baseline makes A→B→A recovery impossible.
      state.startedAt = Math.min(state.startedAt || Number.MAX_SAFE_INTEGER, Math.max(0, finite(event.startedAt, state.startedAt)));
      if (!Number.isFinite(state.startedAt) || state.startedAt === Number.MAX_SAFE_INTEGER) state.startedAt = Math.max(0, finite(event.at, Date.now()));
      state.lastActivityAt = Math.max(state.lastActivityAt, Math.max(0, finite(event.at, Date.now())));
      state.tabHidden = event.tabHidden === true || state.tabHidden;
      state.suspended = false;
      return { state, action: { type: 'update', reason: 'same-completion' } };
    }
    return { state: newState(state, { ...event, completionId }), action: { type: 'new-turn' } };
  }

  function ensureState(rawState, event = {}) {
    return normalizeState(rawState) || newState(null, event);
  }

  function acceptDomCandidate(rawState, event = {}) {
    const state = ensureState(rawState, event);
    if (!state.completionId || !event.completionId || state.completionId !== String(event.completionId)) {
      return { state, action: { type: 'suppress', reason: 'completion-mismatch' } };
    }
    if (state.documentId && String(event.documentId || '') !== state.documentId) {
      return { state, action: { type: 'suppress', reason: 'document-mismatch' } };
    }
    if (state.pathHash && String(event.pathHash || '') !== state.pathHash) {
      return { state, action: { type: 'suppress', reason: 'route-mismatch' } };
    }
    if (state.routeEpoch && Math.trunc(finite(event.routeEpoch, 0)) !== state.routeEpoch) {
      return { state, action: { type: 'suppress', reason: 'stale-route-epoch' } };
    }
    if (state.suspended) return { state, action: { type: 'suppress', reason: 'route-suspended' } };
    const candidateAt = Math.max(0, finite(event.at, Date.now()));
    if (state.expiresAt && state.expiresAt <= candidateAt) {
      return { state, action: { type: 'suppress', reason: 'expired-turn' } };
    }

    const hasFinalAction = event.hasFinalAction === true;
    const finalEvidence = hasFinalAction ? 'final-action' : String(event.finalEvidence || '');
    const trustedActionlessFinal = (
      finalEvidence === 'explicit-fast-stable'
      && state.startSource === 'explicit'
      && state.sawGenerating !== true
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

    if (state.notified && state.notificationStatus === 'pending') {
      return {
        state,
        action: {
          type: 'notify',
          source: trustedActionlessFinal ? 'dom-fast-final' : 'dom-final',
          cycleNumber: state.cycleNumber,
          startedAt: state.startedAt,
          completedAt: Math.max(state.lastActivityAt, candidateAt),
          completionId: state.completionId,
          reason: 'notification-pending',
        },
      };
    }
    if (state.notified) {
      return { state, action: { type: 'suppress', reason: 'already-notified' } };
    }

    const at = Math.max(state.lastActivityAt, candidateAt);
    state.lastActivityAt = at;
    state.notified = true;
    state.notifiedAt = at;
    state.phase = 'complete';
    state.suspended = false;
    state.notificationStatus = 'pending';
    state.notificationRetryAt = 0;
    state.notificationAttempts = 0;
    state.tabHidden = event.tabHidden === true || state.tabHidden;
    return {
      state,
      action: {
        type: 'notify',
        source: trustedActionlessFinal ? 'dom-fast-final' : 'dom-final',
        cycleNumber: state.cycleNumber,
        startedAt: state.startedAt,
        completedAt: at,
        completionId: state.completionId,
      },
    };
  }

  return Object.freeze({ acceptDomCandidate, beginTurn, normalizeState });
}));
