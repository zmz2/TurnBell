'use strict';

(function exposeBootstrap(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.TurnBellBootstrap = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function bootstrapFactory() {
  function bounded(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(number)));
  }

  function createBootstrapGate(rawOptions = {}) {
    const options = Object.freeze({
      quietPeriodMs: bounded(rawOptions.quietPeriodMs, 2_000, 100, 10_000),
      maxWaitMs: bounded(rawOptions.maxWaitMs, 15_000, 1_000, 60_000),
    });
    let state = {
      initialized: false,
      ready: false,
      startedAt: 0,
      lastActivityAt: 0,
      reason: '',
    };

    function nowValue(value) {
      const number = Number(value);
      return Number.isFinite(number) ? Math.max(0, number) : Date.now();
    }

    function ensureStarted(now) {
      if (state.initialized) return;
      state.initialized = true;
      state.startedAt = now;
      state.lastActivityAt = now;
    }

    function noteMutation(rawNow = Date.now()) {
      if (state.ready) return getState();
      const now = nowValue(rawNow);
      ensureStarted(now);
      state.lastActivityAt = Math.max(state.lastActivityAt, now);
      return getState();
    }

    function activate(rawNow = Date.now(), reason = 'explicit') {
      const now = nowValue(rawNow);
      ensureStarted(now);
      state.ready = true;
      state.reason = String(reason || 'explicit');
      state.lastActivityAt = Math.max(state.lastActivityAt, now);
      return { action: 'activate', arm: true, reason: state.reason, state: getState() };
    }

    function evaluate(raw = {}) {
      const now = nowValue(raw.now);
      ensureStarted(now);
      if (state.ready) return { action: 'ready', arm: false, reason: state.reason, state: getState() };
      if (raw.explicitIntent || raw.isGenerating) {
        return activate(now, raw.explicitIntent ? 'user-intent' : 'generation-visible');
      }

      const readyState = String(raw.readyState || 'loading');
      const documentReady = readyState !== 'loading';
      const quietEnough = now - state.lastActivityAt >= options.quietPeriodMs;
      const waitedTooLong = now - state.startedAt >= options.maxWaitMs;
      if (documentReady && (quietEnough || waitedTooLong)) {
        state.ready = true;
        state.reason = quietEnough ? 'hydration-stable' : 'bootstrap-timeout';
        return { action: 'baseline', arm: false, reason: state.reason, state: getState() };
      }
      return { action: 'wait', arm: false, reason: 'hydrating', state: getState() };
    }

    function reset(rawNow = Date.now()) {
      const now = nowValue(rawNow);
      state = {
        initialized: true,
        ready: false,
        startedAt: now,
        lastActivityAt: now,
        reason: '',
      };
      return getState();
    }

    function getState() {
      return { ...state, options: { ...options } };
    }

    return Object.freeze({ activate, evaluate, getState, noteMutation, reset });
  }

  return Object.freeze({ createBootstrapGate });
}));
