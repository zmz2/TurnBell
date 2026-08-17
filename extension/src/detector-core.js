'use strict';

(function exposeDetector(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.GPTReplyDetector = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function detectorFactory() {
  const DEFAULTS = Object.freeze({
    quietPeriodMs: 1_000,
    actionlessQuietPeriodMs: 3_000,
    minGenerationMs: 500,
    maxWaitMs: 2 * 60 * 60_000,
  });

  function clampInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(number)));
  }

  function normalizeOptions(raw = {}) {
    const quietPeriodMs = clampInteger(raw.quietPeriodMs, DEFAULTS.quietPeriodMs, 0, 30_000);
    return {
      quietPeriodMs,
      actionlessQuietPeriodMs: clampInteger(
        raw.actionlessQuietPeriodMs,
        Math.max(DEFAULTS.actionlessQuietPeriodMs, quietPeriodMs),
        quietPeriodMs,
        60_000,
      ),
      minGenerationMs: clampInteger(raw.minGenerationMs, DEFAULTS.minGenerationMs, 0, 10 * 60_000),
      maxWaitMs: clampInteger(raw.maxWaitMs, DEFAULTS.maxWaitMs, 100, 8 * 60 * 60_000),
    };
  }

  function count(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
  }

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function fingerprint(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function createDetector(rawOptions = {}) {
    const options = normalizeOptions(rawOptions);
    let state;

    function initialState() {
      return {
        initialized: false,
        phase: 'idle',
        lastNow: 0,
        lastAssistantText: '',
        lastAssistantCount: 0,
        lastUserCount: 0,
        lastIsGenerating: false,
        cycleStartAt: null,
        baselineAssistantText: '',
        lastAssistantChangeAt: null,
        settleStartedAt: null,
        sawGenerating: false,
        explicitlyArmed: false,
        cycleNumber: 0,
      };
    }

    state = initialState();

    function clearCycle() {
      state.phase = 'idle';
      state.cycleStartAt = null;
      state.baselineAssistantText = state.lastAssistantText;
      state.lastAssistantChangeAt = null;
      state.settleStartedAt = null;
      state.sawGenerating = false;
      state.explicitlyArmed = false;
    }

    function beginCycle(now, baseline, isGenerating, source = 'implicit') {
      state.cycleNumber += 1;
      state.phase = isGenerating ? 'generating' : 'waiting';
      state.cycleStartAt = now;
      state.baselineAssistantText = baseline;
      state.lastAssistantChangeAt = null;
      state.settleStartedAt = null;
      state.sawGenerating = Boolean(isGenerating);
      state.explicitlyArmed = source === 'explicit';
    }

    function normalizeSnapshot(raw = {}) {
      const candidateNow = Number(raw.now);
      const suppliedNow = Number.isFinite(candidateNow) ? candidateNow : Date.now();
      const now = state.initialized ? Math.max(state.lastNow, suppliedNow) : suppliedNow;
      return {
        now,
        isGenerating: Boolean(raw.isGenerating),
        assistantText: text(raw.assistantText),
        assistantCount: count(raw.assistantCount),
        userCount: count(raw.userCount),
        isFinalRenderable: raw.isFinalRenderable !== false,
        allowImplicitStart: raw.allowImplicitStart !== false,
        allowActionlessFinal: raw.allowActionlessFinal === true,
      };
    }

    function remember(snapshot) {
      state.lastNow = snapshot.now;
      state.lastAssistantText = snapshot.assistantText;
      state.lastAssistantCount = snapshot.assistantCount;
      state.lastUserCount = snapshot.userCount;
      state.lastIsGenerating = snapshot.isGenerating;
    }

    function step(rawSnapshot = {}) {
      const snapshot = normalizeSnapshot(rawSnapshot);

      if (!state.initialized) {
        state.initialized = true;
        state.lastNow = snapshot.now;
        state.lastAssistantText = snapshot.assistantText;
        state.lastAssistantCount = snapshot.assistantCount;
        state.lastUserCount = snapshot.userCount;
        state.lastIsGenerating = snapshot.isGenerating;

        if (snapshot.isGenerating) {
          beginCycle(snapshot.now, snapshot.assistantText, true, 'generation');
        }
        return null;
      }

      const previousText = state.lastAssistantText;
      const previousGenerating = state.lastIsGenerating;
      const userTurnAdded = snapshot.userCount > state.lastUserCount;
      const assistantTurnAdded = snapshot.assistantCount > state.lastAssistantCount;
      const assistantTextChanged = snapshot.assistantText !== previousText;

      // DOM count changes are useful only after a live page has been armed.
      // Content scripts can disable these implicit starts while a refreshed
      // conversation is still hydrating, which prevents old turns from being
      // misclassified as a new response.
      if (snapshot.allowImplicitStart && userTurnAdded) {
        beginCycle(snapshot.now, previousText, snapshot.isGenerating, 'implicit-user');
      } else if (state.phase === 'idle' && snapshot.isGenerating) {
        beginCycle(snapshot.now, previousText, true, 'generation');
      } else if (snapshot.allowImplicitStart && state.phase === 'idle' && assistantTurnAdded) {
        beginCycle(snapshot.now, previousText, snapshot.isGenerating, 'implicit-assistant');
      }

      if (state.phase !== 'idle' && snapshot.isGenerating) {
        state.phase = 'generating';
        state.sawGenerating = true;
        state.settleStartedAt = null;
      }

      if (state.phase !== 'idle' && assistantTextChanged) {
        state.lastAssistantChangeAt = snapshot.now;
        if (!snapshot.isGenerating && state.phase === 'waiting') {
          state.phase = 'settling';
          state.settleStartedAt = snapshot.now;
        }
      }

      const generationJustStopped = (
        state.phase === 'generating'
        && !snapshot.isGenerating
        && (previousGenerating || state.sawGenerating)
      );

      if (generationJustStopped) {
        state.phase = 'settling';
        state.settleStartedAt = snapshot.now;
        remember(snapshot);
        return null;
      }

      // Never complete on the exact mutation that changed the reply. Requiring
      // one stable sample makes the quiet-period contract deterministic.
      if (assistantTextChanged && state.phase === 'settling') {
        remember(snapshot);
        return null;
      }

      if (
        state.phase === 'waiting'
        && state.cycleStartAt !== null
        && snapshot.now - state.cycleStartAt >= options.maxWaitMs
      ) {
        remember(snapshot);
        clearCycle();
        return null;
      }

      if (state.phase === 'settling') {
        const stableSince = Math.max(
          state.lastAssistantChangeAt ?? state.settleStartedAt ?? snapshot.now,
          state.settleStartedAt ?? state.lastAssistantChangeAt ?? snapshot.now,
        );
        const stableDurationMs = snapshot.now - stableSince;
        const quietEnough = stableDurationMs >= options.quietPeriodMs;
        const actionlessQuietEnough = stableDurationMs >= options.actionlessQuietPeriodMs;
        const durationMs = Math.max(0, snapshot.now - (state.cycleStartAt ?? snapshot.now));
        const longEnough = durationMs >= options.minGenerationMs;
        const replyChanged = snapshot.assistantText !== state.baselineAssistantText;
        const hasReply = snapshot.assistantText.trim().length > 0;

        if (quietEnough && longEnough) {
          const actionRowFinal = snapshot.isFinalRenderable;
          const explicitFastFinal = (
            !actionRowFinal
            && snapshot.allowActionlessFinal
            && state.explicitlyArmed
            && !state.sawGenerating
            && actionlessQuietEnough
          );
          if (!actionRowFinal && !explicitFastFinal) {
            remember(snapshot);
            return null;
          }

          remember(snapshot);
          if (!replyChanged || !hasReply) {
            clearCycle();
            return null;
          }

          const startedAt = state.cycleStartAt ?? snapshot.now;
          const event = {
            type: 'complete',
            durationMs,
            startedAt,
            completedAt: snapshot.now,
            replyText: snapshot.assistantText,
            fingerprint: fingerprint(snapshot.assistantText),
            hasFinalAction: actionRowFinal,
            finalEvidence: actionRowFinal ? 'final-action' : 'explicit-fast-stable',
          };
          clearCycle();
          return event;
        }
      }

      remember(snapshot);
      return null;
    }

    function arm(rawSnapshot = {}) {
      const snapshot = normalizeSnapshot(rawSnapshot);
      if (!state.initialized) {
        state.initialized = true;
        remember(snapshot);
      }
      beginCycle(snapshot.now, snapshot.assistantText, snapshot.isGenerating, 'explicit');
      remember(snapshot);
      return getState();
    }

    function getState() {
      return { ...state, options: { ...options } };
    }

    function reset() {
      state = initialState();
    }

    return Object.freeze({ step, arm, getState, reset });
  }

  return Object.freeze({ createDetector, fingerprint, normalizeOptions });
}));
