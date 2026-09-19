'use strict';

(() => {
  const CONTENT_MARKER = '__TURNBELL_CONTENT_ACTIVE__';
  if (globalThis[CONTENT_MARKER]) return;

  const detectorAPI = globalThis.GPTReplyDetector;
  const notificationAPI = globalThis.GPTReplyNotification;
  const schedulerAPI = globalThis.GPTReplySampleScheduler;
  const domAPI = globalThis.TurnBellDOMModel;
  const bootstrapAPI = globalThis.TurnBellBootstrap;
  if (!detectorAPI || !notificationAPI || !schedulerAPI || !domAPI || !bootstrapAPI || !chrome?.runtime?.id) return;
  globalThis[CONTENT_MARKER] = true;
  // Compatibility marker prevents accidental double injection over older builds.
  globalThis.__GPT_REPLY_NOTIFIER_CONTENT_ACTIVE__ = true;

  const STOP_SELECTORS = [
    '[data-testid="stop-button"]',
    'button[data-testid*="stop" i]',
    'button[aria-label*="stop generating" i]',
    'button[aria-label*="stop streaming" i]',
    'button[aria-label="Stop" i]',
    'button[aria-label*="停止生成"]',
    'button[aria-label="停止"]',
    'button[aria-label*="终止"]',
    'button[aria-label*="中止"]',
  ];

  const USER_INTENT_SELECTOR = [
    'button[data-testid="send-button"]',
    'button[data-testid*="composer-submit" i]',
    'button[aria-label*="send message" i]',
    'button[aria-label="Send" i]',
    'button[aria-label*="发送"]',
    'button[data-testid*="regenerate" i]',
    'button[data-testid*="retry" i]',
    'button[aria-label*="regenerate" i]',
    'button[aria-label*="retry" i]',
    'button[aria-label*="重新生成"]',
    'button[aria-label*="重试"]',
    'button[aria-label*="continue generating" i]',
    'button[aria-label*="继续生成"]',
  ].join(',');

  const STOP_LABEL = /^(?:stop(?:\s+(?:generating|streaming|response))?|停止(?:生成|回复)?|终止(?:生成|回复)?|中止(?:生成|回复)?)$/iu;
  const SAMPLE_DEBOUNCE_MS = 90;
  const POLL_INTERVAL_MS = 1_500;
  const INTENT_COALESCE_MS = 8_000;
  const INTENT_DEDUPE_MS = 900;
  const BOOTSTRAP_QUIET_MS = 2_000;
  const BOOTSTRAP_MAX_WAIT_MS = 15_000;
  const COMPOSER_SELECTOR = [
    'textarea',
    '[contenteditable="true"]',
    '[role="textbox"]',
    '[data-testid*="composer" i]',
    '[id*="prompt" i]',
  ].join(',');

  let settings = notificationAPI.normalizeSettings();
  let detector = detectorAPI.createDetector(settings);
  let bootstrapGate = bootstrapAPI.createBootstrapGate({
    quietPeriodMs: BOOTSTRAP_QUIET_MS,
    maxWaitMs: BOOTSTRAP_MAX_WAIT_MS,
  });
  let observer = null;
  let scheduler = null;
  let pollTimer = null;
  let lastSettleKey = '';
  let currentTurnKey = '';
  let lastSentTurnKey = '';
  let lastDetectorCycle = 0;
  let pendingIntent = null;
  let currentPath = routePath();
  let routeEpoch = 1;
  let currentCompletionId = '';
  let currentCompletionStartedAt = 0;
  let lastReportedGeneratingCompletionId = '';
  let pendingRouteRecovery = null;
  let recoveryLastFingerprint = '';
  let recoveryStableSince = 0;
  let recoveryStableSamples = 0;
  let routeMessageQueue = Promise.resolve();
  let sampleCount = 0;
  let mutationCount = 0;
  let textRevisionCount = 0;
  let timerTickCount = 0;
  let lastSampleAt = 0;
  let lastObservedFingerprint = '';
  let lastReportedSampleSignature = '';
  let lastReportedRevisionBucket = 0;
  const routeHashCache = new Map();

  function routePath() {
    return `${String(location.pathname || '/')}${String(location.search || '')}`;
  }

  function isNewConversationPlaceholder(path) {
    const pathname = String(path || '/').split('?', 1)[0].replace(/\/$/u, '') || '/';
    return pathname === '/' || pathname === '/new' || pathname === '/c/new';
  }

  function fallbackRouteHash(value) {
    const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
    return seeds.map((seed) => {
      let hash = seed;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    }).join('');
  }

  function routeHash(path = currentPath) {
    const value = String(path || '/');
    if (!routeHashCache.has(value)) {
      const promise = (async () => {
        try {
          const cryptoObject = globalThis.crypto;
          const Encoder = globalThis.TextEncoder;
          if (cryptoObject?.subtle?.digest && typeof Encoder === 'function') {
            const digest = await cryptoObject.subtle.digest('SHA-256', new Encoder().encode(value));
            return [...new Uint8Array(digest)].slice(0, 16)
              .map((byte) => byte.toString(16).padStart(2, '0')).join('');
          }
        } catch {
          // Keep route isolation functional in older or restricted test contexts.
        }
        return fallbackRouteHash(value);
      })();
      routeHashCache.set(value, promise);
    }
    return routeHashCache.get(value);
  }

  function createCompletionId() {
    try {
      if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
      if (typeof globalThis.crypto?.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        globalThis.crypto.getRandomValues(bytes);
        return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      }
    } catch {
      // Fall through to a non-content-derived per-turn identifier.
    }
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  }

  function log(...args) {
    if (settings.debug) console.debug('[TurnBell]', ...args);
  }

  function storageGet(defaults) {
    return new Promise((resolve) => {
      chrome.storage.sync.get(defaults, (items) => {
        if (chrome.runtime.lastError) {
          log('settings read failed', chrome.runtime.lastError.message);
          resolve(defaults);
          return;
        }
        resolve(items);
      });
    });
  }

  function isUsable(element) {
    if (!element || element.isConnected === false || element.hidden || element.disabled) return false;
    if (element.getAttribute?.('aria-hidden') === 'true') return false;
    const style = globalThis.getComputedStyle?.(element);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    const rect = element.getBoundingClientRect?.();
    return !rect || rect.width > 0 || rect.height > 0;
  }

  function isGenerating() {
    for (const selector of STOP_SELECTORS) {
      let element = null;
      try { element = document.querySelector(selector); } catch { element = null; }
      if (isUsable(element)) return true;
    }

    let buttons = [];
    try { buttons = document.querySelectorAll('form button, main button'); } catch { buttons = []; }
    for (const button of buttons) {
      if (!isUsable(button)) continue;
      const label = [
        button.getAttribute?.('aria-label'),
        button.getAttribute?.('title'),
        button.textContent,
      ].filter(Boolean).join(' ').replace(/\s+/gu, ' ').trim();
      if (STOP_LABEL.test(label)) return true;
    }
    return false;
  }

  function snapshotForCycle(cycleNumber = detector.getState?.().cycleNumber || 0) {
    const assistantTurns = typeof domAPI.collectAssistantTurns === 'function'
      ? domAPI.collectAssistantTurns(document)
      : domAPI.collectTurns(document, domAPI.ASSISTANT_SELECTORS);
    const userTurns = domAPI.collectTurns(document, domAPI.USER_SELECTORS);
    const latestAssistant = assistantTurns.at(-1) || null;
    const finalAction = typeof domAPI.hasFinalActionForTurn === 'function'
      ? domAPI.hasFinalActionForTurn(document, latestAssistant, domAPI.FINAL_ACTION_SELECTORS)
      : domAPI.hasFinalAction(latestAssistant?.container, domAPI.FINAL_ACTION_SELECTORS);
    const assistantText = latestAssistant?.text || '';
    return {
      now: Date.now(),
      isGenerating: isGenerating(),
      assistantText,
      assistantCount: assistantTurns.length,
      userCount: userTurns.length,
      isFinalRenderable: finalAction,
      hasFinalAction: finalAction,
      assistantTurns,
      userTurns,
      turnKey: domAPI.makeTurnKey({
        pathname: location.pathname,
        userTurns,
        assistantCount: assistantTurns.length,
        cycleNumber,
      }),
      fingerprint: assistantText ? domAPI.fingerprint(assistantText) : '',
      // A refreshed page must never arm itself merely because historical turns
      // are still mounting. Live requests are armed by explicit UI intent or a
      // visible generation state instead.
      allowImplicitStart: false,
      // Instant-style replies can finish without exposing the usual action row.
      // The detector applies this only to explicitly armed, never-generating turns.
      allowActionlessFinal: true,
    };
  }

  function publicSnapshot(snapshot) {
    return {
      now: snapshot.now,
      isGenerating: snapshot.isGenerating,
      assistantCount: snapshot.assistantCount,
      userCount: snapshot.userCount,
      isFinalRenderable: snapshot.isFinalRenderable,
      hasFinalAction: snapshot.hasFinalAction,
    };
  }

  function pageContext(snapshot) {
    return {
      pageTitle: document.title,
      url: location.href,
      tabHidden: document.visibilityState !== 'visible',
      assistantCount: snapshot.assistantCount,
      userCount: snapshot.userCount,
      isGenerating: snapshot.isGenerating,
      hasFinalAction: snapshot.hasFinalAction,
    };
  }

  function sendRuntimeMessage(message, callback) {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) log('message delivery failed', chrome.runtime.lastError.message);
        callback?.(response);
      });
    } catch (error) {
      log('message delivery threw', error);
      callback?.(null);
    }
  }

  function sendRouteMessage(message, path = currentPath, epoch = routeEpoch, callback, allowStale = false) {
    routeMessageQueue = routeMessageQueue.then(async () => {
      const pathHash = await routeHash(path);
      if (!allowStale && (path !== routePath() || epoch !== routeEpoch)) {
        callback?.({ ok: false, stale: true, reason: 'route-changed' });
        return;
      }
      return new Promise((resolve) => {
        sendRuntimeMessage({ ...message, pathHash, routeEpoch: epoch }, (response) => {
          callback?.(response);
          resolve(response);
        });
      });
    }).catch((error) => {
      log('route message failed', error);
      callback?.({ ok: false, error: String(error) });
    });
    return routeMessageQueue;
  }

  function enterCurrentRoute({ fromPathHash = '', completionId = '' } = {}) {
    const path = currentPath;
    const epoch = routeEpoch;
    void sendRouteMessage({
      type: fromPathHash && completionId ? 'turn-move' : 'route-enter',
      fromPathHash,
      completionId,
      at: Date.now(),
    }, path, epoch, (response) => {
      if (path !== routePath() || epoch !== routeEpoch) return;
      const pending = response?.pending && typeof response.pending === 'object'
        ? response.pending
        : null;
      pendingRouteRecovery = pending;
      recoveryLastFingerprint = '';
      recoveryStableSince = 0;
      recoveryStableSamples = 0;
      if (pending) {
        currentCompletionId = String(pending.completionId || '');
        currentCompletionStartedAt = Number(pending.startedAt) || 0;
      }
      scheduleSample(0);
    });
  }

  function reportLifecycle(lifecycle, extra = {}) {
    const at = Date.now();
    const sampleGapMs = lastSampleAt ? Math.max(0, at - lastSampleAt) : 0;
    const details = {
      type: 'lifecycle-event',
      lifecycle: String(lifecycle || 'unknown'),
      at,
      visibilityState: String(document.visibilityState || 'unknown'),
      wasDiscarded: document.wasDiscarded === true,
      sampleCount,
      mutationCount,
      textRevisionCount,
      timerTickCount,
      sampleGapMs,
      ...extra,
    };
    log('lifecycle', details);
    sendRouteMessage(details);
  }

  function announceTurn(turnKey, snapshot, source = 'implicit') {
    const key = String(turnKey || '').trim();
    if (!key) return;
    currentTurnKey = key;
    if (key !== lastSentTurnKey || !currentCompletionId) {
      lastSentTurnKey = key;
      currentCompletionId = createCompletionId();
      currentCompletionStartedAt = Number(pendingIntent?.at) || Number(snapshot?.now) || Date.now();
      lastReportedGeneratingCompletionId = '';
      pendingRouteRecovery = null;
      recoveryLastFingerprint = '';
      recoveryStableSince = 0;
      recoveryStableSamples = 0;
    }
    sendRouteMessage({
      type: 'turn-start',
      completionId: currentCompletionId,
      startedAt: currentCompletionStartedAt,
      userCount: Number(snapshot?.userCount) || 0,
      assistantCount: Number(snapshot?.assistantCount) || 0,
      source: source === 'explicit' ? 'explicit' : 'implicit',
      at: Date.now(),
    });
  }

  function noteUserIntent(kind) {
    const at = Date.now();
    if (pendingIntent && at - pendingIntent.at <= INTENT_DEDUPE_MS) {
      scheduleSample(0);
      return;
    }
    const snapshot = snapshotForCycle();
    bootstrapGate.activate(at, 'user-intent');
    const key = `ui:${domAPI.fingerprint(location.pathname)}:${String(kind || 'request')}:${at}`;
    pendingIntent = { key, at };
    detector.arm?.({ ...snapshot, now: at });
    announceTurn(key, snapshot, 'explicit');
    scheduleSample(0);
  }

  function handleCycleTransition(snapshot, state) {
    if (!Number.isInteger(state.cycleNumber) || state.cycleNumber <= lastDetectorCycle) return;
    const pendingIsFresh = pendingIntent && snapshot.now - pendingIntent.at <= INTENT_COALESCE_MS;
    const key = pendingIsFresh
      ? pendingIntent.key
      : domAPI.makeTurnKey({
        pathname: location.pathname,
        userTurns: snapshot.userTurns,
        assistantCount: snapshot.assistantCount,
        cycleNumber: state.cycleNumber,
      });
    announceTurn(key, snapshot, pendingIsFresh ? 'explicit' : 'implicit');
    lastDetectorCycle = state.cycleNumber;
    pendingIntent = null;
  }

  function sendDomCandidate(event, snapshot, completionId = currentCompletionId) {
    reportLifecycle('candidate-sent', {
      at: snapshot.now,
      assistantCount: snapshot.assistantCount,
      userCount: snapshot.userCount,
      isGenerating: snapshot.isGenerating,
      hasFinalAction: snapshot.hasFinalAction,
      detectorPhase: detector.getState?.().phase || '',
    });
    sendRouteMessage({
      type: 'dom-final-candidate',
      completionId,
      payload: {
        event: {
          type: 'complete',
          durationMs: Number(event.durationMs) || 0,
          startedAt: Number(event.startedAt) || currentCompletionStartedAt || snapshot.now,
          completedAt: Number(event.completedAt) || snapshot.now,
          hasFinalAction: snapshot.hasFinalAction === true,
          finalEvidence: String(event.finalEvidence || (snapshot.hasFinalAction ? 'final-action' : '')),
        },
        context: pageContext(snapshot),
      },
    }, currentPath, routeEpoch, (response) => {
      if (response?.ok && (response.suppressed === true || response.routes)) {
        pendingRouteRecovery = null;
      }
    });
  }

  function settlePlan(state, snapshot) {
    const standardQuiet = Number(state.options?.quietPeriodMs) || settings.quietPeriodMs;
    const actionlessQuiet = Number(state.options?.actionlessQuietPeriodMs)
      || Math.max(3_000, standardQuiet);
    const actionlessEligible = (
      snapshot.hasFinalAction !== true
      && state.explicitlyArmed === true
      && state.sawGenerating !== true
    );
    const targetQuiet = actionlessEligible ? actionlessQuiet : standardQuiet;
    const stableSince = Math.max(
      Number(state.lastAssistantChangeAt) || Number(state.settleStartedAt) || snapshot.now,
      Number(state.settleStartedAt) || Number(state.lastAssistantChangeAt) || snapshot.now,
    );
    const elapsed = Math.max(0, snapshot.now - stableSince);
    return {
      mode: actionlessEligible ? 'instant-actionless' : 'standard',
      delayMs: Math.max(200, targetQuiet - elapsed),
    };
  }

  function requestBackgroundSettle(state, snapshot) {
    const plan = settlePlan(state, snapshot);
    const key = [
      currentCompletionId,
      routeEpoch,
      state.cycleNumber,
      state.cycleStartAt,
      state.lastAssistantChangeAt,
      state.settleStartedAt,
      plan.mode,
    ].join(':');
    if (key === lastSettleKey) return;
    lastSettleKey = key;
    sendRouteMessage({
      type: 'schedule-settle-check',
      delayMs: plan.delayMs,
      completionId: currentCompletionId,
      cycleNumber: state.cycleNumber,
      settleKey: key,
    }, currentPath, routeEpoch, (response) => {
      if (!response?.sampled || response?.stale) lastSettleKey = '';
    });
  }

  function resetForNavigation() {
    const nextPath = routePath();
    if (nextPath === currentPath) return false;
    const oldPath = currentPath;
    const oldEpoch = routeEpoch;
    const now = Date.now();
    const state = detector.getState?.() || { phase: 'idle' };
    const pendingIsFresh = pendingIntent && now - pendingIntent.at <= INTENT_COALESCE_MS;
    currentPath = nextPath;
    routeEpoch += 1;
    lastSettleKey = '';
    pendingRouteRecovery = null;
    recoveryLastFingerprint = '';
    recoveryStableSince = 0;
    recoveryStableSamples = 0;

    // A placeholder URL can become a real conversation after the first send.
    // Existing conversation routes changing within the intent window are treated
    // as task switches and must keep their completion attached to the old route.
    if (pendingIsFresh && currentCompletionId && isNewConversationPlaceholder(oldPath)) {
      const newEpoch = routeEpoch;
      void routeHash(oldPath).then((fromPathHash) => {
        if (nextPath !== routePath() || newEpoch !== routeEpoch) return;
        enterCurrentRoute({ fromPathHash, completionId: currentCompletionId });
        const snapshot = snapshotForCycle(state.cycleNumber);
        announceTurn(currentTurnKey, snapshot, 'explicit');
      });
      log('SPA navigation adopted a fresh explicit turn', { routeEpoch });
      return false;
    }

    if (state.phase !== 'idle' && currentCompletionId) {
      sendRouteMessage({ type: 'turn-suspend', completionId: currentCompletionId, at: now }, oldPath, oldEpoch, null, true);
    }
    detector.reset();
    bootstrapGate.reset(now);
    currentTurnKey = '';
    lastSentTurnKey = '';
    lastDetectorCycle = 0;
    pendingIntent = null;
    currentCompletionId = '';
    currentCompletionStartedAt = 0;
    lastReportedGeneratingCompletionId = '';
    enterCurrentRoute();
    log('SPA navigation entered an isolated silent baseline', { routeEpoch });
    return true;
  }

  function evaluateRouteRecovery(snapshot) {
    const pending = pendingRouteRecovery;
    if (!pending || !pending.completionId || pending.completionId !== currentCompletionId) return false;

    if (snapshot.isGenerating) {
      pending.sawGenerating = true;
      recoveryLastFingerprint = '';
      recoveryStableSince = 0;
      recoveryStableSamples = 0;
      if (lastReportedGeneratingCompletionId !== currentCompletionId) {
        lastReportedGeneratingCompletionId = currentCompletionId;
        sendRouteMessage({
          type: 'turn-progress', completionId: currentCompletionId,
          sawGenerating: true, phase: 'generating', at: snapshot.now,
        });
      }
      return true;
    }

    const baselineAssistantCount = Math.max(0, Number(pending.baselineAssistantCount) || 0);
    const baselineUserCount = Math.max(0, Number(pending.baselineUserCount) || 0);
    if (snapshot.userCount < baselineUserCount || snapshot.assistantCount <= baselineAssistantCount) {
      recoveryLastFingerprint = '';
      recoveryStableSince = 0;
      recoveryStableSamples = 0;
      return true;
    }

    const actionlessEligible = (
      snapshot.hasFinalAction !== true
      && pending.startSource === 'explicit'
      && pending.sawGenerating !== true
    );
    if (snapshot.hasFinalAction !== true && !actionlessEligible) return true;

    if (snapshot.fingerprint !== recoveryLastFingerprint) {
      recoveryLastFingerprint = snapshot.fingerprint;
      recoveryStableSince = snapshot.now;
      recoveryStableSamples = 1;
      return true;
    }

    recoveryStableSamples += 1;
    const quietMs = actionlessEligible
      ? Math.max(3_000, settings.quietPeriodMs)
      : settings.quietPeriodMs;
    if (recoveryStableSamples < 2 || snapshot.now - recoveryStableSince < quietMs) return true;

    sendDomCandidate({
      durationMs: Math.max(0, snapshot.now - (Number(pending.startedAt) || snapshot.now)),
      startedAt: Number(pending.startedAt) || snapshot.now,
      completedAt: snapshot.now,
      finalEvidence: actionlessEligible ? 'explicit-fast-stable' : 'final-action',
    }, snapshot, pending.completionId);
    return true;
  }

  function sample() {
    try {
      const oldPath = currentPath;
      resetForNavigation();
      if (oldPath !== currentPath) {
        // `resetForNavigation()` schedules a route handshake; this sample is only
        // a baseline for the new conversation and must not advance the old turn.
        return;
      }
      let snapshot = snapshotForCycle();
      sampleCount += 1;
      const sampleGapMs = lastSampleAt ? Math.max(0, snapshot.now - lastSampleAt) : 0;
      if (snapshot.fingerprint && snapshot.fingerprint !== lastObservedFingerprint) {
        if (lastObservedFingerprint) textRevisionCount += 1;
        lastObservedFingerprint = snapshot.fingerprint;
      }
      lastSampleAt = snapshot.now;
      const bootstrap = bootstrapGate.evaluate({
        now: snapshot.now,
        readyState: document.readyState,
        isGenerating: snapshot.isGenerating,
      });
      if (bootstrap.action === 'wait') return;
      if (bootstrap.action === 'baseline') {
        detector.reset();
        detector.step(snapshot);
        lastDetectorCycle = detector.getState().cycleNumber;
        currentTurnKey = '';
        lastSentTurnKey = '';
        if (!pendingRouteRecovery) {
          currentCompletionId = '';
          currentCompletionStartedAt = 0;
          lastReportedGeneratingCompletionId = '';
        }
        lastSettleKey = '';
        reportSampleState(snapshot, detector.getState(), sampleGapMs);
        log('historical DOM accepted as silent baseline', bootstrap.reason);
        evaluateRouteRecovery(snapshot);
        return;
      }
      const event = detector.step(snapshot);
      const state = detector.getState();
      handleCycleTransition(snapshot, state);
      reportSampleState(snapshot, state, sampleGapMs);

      if (pendingRouteRecovery && evaluateRouteRecovery(snapshot)) return;

      if (
        state.sawGenerating === true
        && currentCompletionId
        && lastReportedGeneratingCompletionId !== currentCompletionId
      ) {
        lastReportedGeneratingCompletionId = currentCompletionId;
        sendRouteMessage({
          type: 'turn-progress', completionId: currentCompletionId,
          sawGenerating: true, phase: state.phase, at: snapshot.now,
        });
      }

      if (event) {
        lastSettleKey = '';
        // Refresh once: action controls can be inserted in the same render batch.
        snapshot = snapshotForCycle(state.cycleNumber);
        const finalEvidence = String(event.finalEvidence || '');
        if (finalEvidence === 'final-action' && !snapshot.hasFinalAction) {
          log('candidate rejected: final action disappeared before confirmation');
          return;
        }
        if (finalEvidence === 'explicit-fast-stable') {
          const sameReply = snapshot.fingerprint && snapshot.fingerprint === String(event.fingerprint || '');
          if (snapshot.isGenerating || !sameReply) {
            log('candidate rejected: fast fallback changed before confirmation');
            return;
          }
        } else if (!snapshot.hasFinalAction) {
          log('candidate rejected: no trusted final evidence');
          return;
        }
        sendDomCandidate(event, snapshot);
        return;
      }

      if (state.phase === 'settling') requestBackgroundSettle(state, snapshot);
      else lastSettleKey = '';
    } catch (error) {
      log('sample failed', error);
    }
  }

  function reportSampleState(snapshot, state, sampleGapMs = 0) {
    const revisionBucket = Math.floor(textRevisionCount / 10);
    const signature = [
      state.phase,
      snapshot.isGenerating ? 1 : 0,
      snapshot.hasFinalAction ? 1 : 0,
      snapshot.assistantCount,
      snapshot.userCount,
      revisionBucket,
    ].join(':');
    if (signature === lastReportedSampleSignature && revisionBucket === lastReportedRevisionBucket) return;
    lastReportedSampleSignature = signature;
    lastReportedRevisionBucket = revisionBucket;
    reportLifecycle('sampled', {
      at: snapshot.now,
      assistantCount: snapshot.assistantCount,
      userCount: snapshot.userCount,
      isGenerating: snapshot.isGenerating,
      hasFinalAction: snapshot.hasFinalAction,
      detectorPhase: String(state.phase || ''),
      sampleGapMs,
    });
  }

  function scheduleSample(delay = SAMPLE_DEBOUNCE_MS) {
    scheduler?.schedule(delay);
  }

  function startObserver() {
    observer?.disconnect();
    observer = new MutationObserver(() => {
      mutationCount += 1;
      bootstrapGate.noteMutation(Date.now());
      scheduleSample();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'aria-label',
        'aria-hidden',
        'data-testid',
        'data-message-id',
        'data-message-author-role',
        'data-turn',
        'disabled',
        'hidden',
      ],
    });
  }

  async function initialize() {
    const stored = await storageGet(notificationAPI.DEFAULT_SETTINGS);
    settings = notificationAPI.normalizeSettings(stored);
    detector = detectorAPI.createDetector(settings);
    bootstrapGate = bootstrapAPI.createBootstrapGate({
      quietPeriodMs: BOOTSTRAP_QUIET_MS,
      maxWaitMs: BOOTSTRAP_MAX_WAIT_MS,
    });
    scheduler = schedulerAPI.createSampleScheduler({
      sample,
      isHidden: () => document.visibilityState !== 'visible',
      setTimer: (callback, delay) => globalThis.setTimeout(callback, delay),
      clearTimer: (timerId) => globalThis.clearTimeout(timerId),
      queueMicrotask: globalThis.queueMicrotask
        ? (callback) => globalThis.queueMicrotask(callback)
        : (callback) => Promise.resolve().then(callback),
    });

    startObserver();
    bootstrapGate.noteMutation(Date.now());
    scheduleSample(0);
    pollTimer = globalThis.setInterval(() => {
      timerTickCount += 1;
      sample();
    }, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      reportLifecycle('visibilitychange');
      lastSettleKey = '';
      scheduleSample(0);
    });
    document.addEventListener('freeze', () => reportLifecycle('freeze'));
    document.addEventListener('resume', () => {
      reportLifecycle('resume');
      lastSettleKey = '';
      recoveryLastFingerprint = '';
      recoveryStableSince = 0;
      recoveryStableSamples = 0;
      scheduleSample(0);
    });
    document.addEventListener('submit', () => noteUserIntent('submit'), true);
    document.addEventListener('keydown', (event) => {
      if (event?.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target;
      let composer = null;
      try { composer = target?.closest?.(COMPOSER_SELECTOR) || (target?.matches?.(COMPOSER_SELECTOR) ? target : null); } catch { composer = null; }
      if (!composer) return;
      const scope = composer.closest?.('form, [data-testid*="composer" i], [class*="composer" i], main');
      if (!scope) return;
      noteUserIntent('enter');
    }, true);
    document.addEventListener('click', (event) => {
      const target = event?.target?.closest?.(USER_INTENT_SELECTOR);
      if (target) noteUserIntent('button');
    }, true);
    globalThis.addEventListener?.('pageshow', (event) => {
      reportLifecycle('pageshow', { persisted: event?.persisted === true });
      lastSettleKey = '';
      scheduleSample(0);
    });
    globalThis.addEventListener?.('pagehide', (event) => {
      reportLifecycle('pagehide', { persisted: event?.persisted === true });
    });
    globalThis.addEventListener?.('popstate', () => scheduleSample(0));
    globalThis.addEventListener?.('focus', () => {
      reportLifecycle('focus');
      lastSettleKey = '';
      scheduleSample(0);
    });
    log('initialized: DOM-only final-evidence mode', settings);
    enterCurrentRoute();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'monitor-ping':
        sendResponse({ ok: true, active: true, version: '1.5.0', mode: 'dom-only' });
        return false;
      case 'monitor-sample-now': {
        const expectedPathHash = String(message.pathHash || '');
        const expectedEpoch = Number(message.routeEpoch);
        const expectedCompletionId = String(message.completionId || '');
        const observedPath = routePath();
        if (observedPath !== currentPath) {
          // Reconcile the SPA transition, but never report an old route's ping
          // as a successful sample of the newly mounted conversation.
          sample();
          sendResponse({ ok: true, stale: true, reason: 'route-not-mounted' });
          return true;
        }
        void routeHash(observedPath).then((activePathHash) => {
          if (observedPath !== routePath() || observedPath !== currentPath) {
            sample();
            sendResponse({ ok: true, stale: true, reason: 'route-not-mounted' });
            return;
          }
          if (
            (expectedPathHash && activePathHash !== expectedPathHash)
            || (Number.isInteger(expectedEpoch) && expectedEpoch !== routeEpoch)
            || (expectedCompletionId && expectedCompletionId !== currentCompletionId
              && expectedCompletionId !== String(pendingRouteRecovery?.completionId || ''))
          ) {
            sendResponse({ ok: true, stale: true, reason: 'route-not-mounted' });
            return;
          }
          const state = detector.getState();
          if (Number.isInteger(message.cycleNumber) && message.cycleNumber !== state.cycleNumber) {
            sendResponse({ ok: true, stale: true, reason: 'stale-cycle' });
            return;
          }
          sample();
          sendResponse({ ok: true, sampled: true });
        }).catch(() => sendResponse({ ok: false, stale: true, reason: 'route-hash-failed' }));
        return true;
      }
      case 'notification-context': {
        const snapshot = snapshotForCycle();
        sendResponse({ ok: true, snapshot: publicSnapshot(snapshot), context: pageContext(snapshot) });
        return false;
      }
      default:
        return false;
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    const next = { ...settings };
    for (const [key, change] of Object.entries(changes)) next[key] = change.newValue;
    settings = notificationAPI.normalizeSettings(next);
    const snapshot = snapshotForCycle();
    detector = detectorAPI.createDetector(settings);
    if (bootstrapGate.getState().ready) detector.step(snapshot);
    lastDetectorCycle = detector.getState().cycleNumber;
    lastSettleKey = '';
    scheduleSample(0);
    log('settings updated', settings);
  });

  if (document.documentElement) {
    void initialize();
  } else {
    document.addEventListener('DOMContentLoaded', () => void initialize(), { once: true });
  }
})();
