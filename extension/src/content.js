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
  let completionGeneration = 0;
  let currentCompletionStartedAt = 0;
  let lastReportedGeneratingCompletionId = '';
  let lastReportedGeneratingWithoutFinalActionCompletionId = '';
  let currentTurnSawGeneratingWithoutFinalAction = false;
  let pendingRouteRecovery = null;
  let routeHandshakePending = false;
  let currentRoutePreviouslyCompleted = false;
  let currentTurnEvidence = null;
  let pendingPlaceholderMigration = null;
  let routeMountGuard = null;
  let lastSampledSnapshot = null;
  let lastNonComposerInteractionAt = 0;
  let lastPopstateAt = 0;
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
  const recoveryBaselineFingerprints = new Map();
  const pendingDomCandidates = new Map();
  const progressMessagesInFlight = new Set();

  function routePath() {
    return `${String(location.pathname || '/')}${String(location.search || '')}`;
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

  function enterCurrentRoute() {
    const path = currentPath;
    const epoch = routeEpoch;
    const expectedCompletionGeneration = completionGeneration;
    routeHandshakePending = true;
    void sendRouteMessage({
      type: 'route-enter',
      at: Date.now(),
    }, path, epoch, (response) => {
      if (
        path !== routePath()
        || epoch !== routeEpoch
      ) return;
      if (expectedCompletionGeneration !== completionGeneration) {
        routeHandshakePending = false;
        currentRoutePreviouslyCompleted = false;
        scheduleSample(0);
        return;
      }
      const staleRouteClaim = ['stale-document-claim', 'stale-route-epoch'].includes(String(response?.reason || ''));
      currentRoutePreviouslyCompleted = response?.previouslyCompleted === true || staleRouteClaim;
      const pending = response?.pending && typeof response.pending === 'object'
        ? response.pending
        : null;
      pendingRouteRecovery = pending;
      recoveryLastFingerprint = '';
      recoveryStableSince = 0;
      recoveryStableSamples = 0;
      if (pending) {
        const pendingCompletionId = String(pending.completionId || '');
        if (pendingCompletionId !== currentCompletionId) completionGeneration += 1;
        currentCompletionId = pendingCompletionId;
        currentCompletionStartedAt = Number(pending.startedAt) || 0;
        currentTurnSawGeneratingWithoutFinalAction = pending.sawGeneratingWithoutFinalAction === true;
      }
      if (!pending && response?.previouslyCompleted !== true && !staleRouteClaim
        && tryBeginPlaceholderMigration(path, epoch)) return;
      routeHandshakePending = false;
      scheduleSample(0);
    });
  }

  function isPlaceholderPath(path) {
    return /^\/(?:|new|c\/new)\/?$/iu.test(String(path || '').split('?')[0]);
  }

  function isConversationPath(path) {
    return /^\/c\/[^/]+\/?$/iu.test(String(path || '').split('?')[0]);
  }

  function tryBeginPlaceholderMigration(path, epoch) {
    const migration = pendingPlaceholderMigration;
    if (!migration) return false;
    if (migration.expiresAt < Date.now() || migration.destinationPath !== path
      || !isPlaceholderPath(migration.sourcePath) || !isConversationPath(path)
      || lastNonComposerInteractionAt >= migration.startedAt
      || lastPopstateAt >= migration.startedAt) {
      pendingPlaceholderMigration = null;
      return false;
    }

    const snapshot = snapshotForCycle();
    const sameUserNodeIsMounted = snapshot.userTurns.some((turn) => (
      turn.container && turn.container === migration.userContainer
    ));
    if (!sameUserNodeIsMounted) {
      pendingPlaceholderMigration = null;
      return false;
    }

    const generation = completionGeneration;
    void routeHash(migration.sourcePath).then((fromPathHash) => {
      if (path !== routePath() || epoch !== routeEpoch || generation !== completionGeneration) {
        pendingPlaceholderMigration = null;
        routeHandshakePending = false;
        scheduleSample(0);
        return;
      }
      sendRouteMessage({
        type: 'turn-move',
        completionId: migration.completionId,
        fromPathHash,
        routeMoveEvidence: 'shared-user-turn-node',
        at: Date.now(),
      }, path, epoch, (response) => {
        if (path !== routePath() || epoch !== routeEpoch) return;
        pendingPlaceholderMigration = null;
        if (generation !== completionGeneration) {
          routeHandshakePending = false;
          scheduleSample(0);
          return;
        }
        const pending = response?.ok && response?.pending && typeof response.pending === 'object'
          ? response.pending
          : null;
        if (pending?.completionId === migration.completionId) {
          currentCompletionId = migration.completionId;
          currentCompletionStartedAt = Number(pending.startedAt) || migration.startedAt;
          pendingRouteRecovery = pending;
          currentRoutePreviouslyCompleted = false;
          currentTurnEvidence = {
            explicit: true,
            baselineUserCount: migration.baselineUserCount,
            userContainer: migration.userContainer,
            intentAt: migration.startedAt,
          };
          currentTurnSawGeneratingWithoutFinalAction = migration.sawGeneratingWithoutFinalAction
            || pending.sawGeneratingWithoutFinalAction === true;
          routeMountGuard = null;
          completionGeneration += 1;
        }
        routeHandshakePending = false;
        scheduleSample(0);
      });
    }).catch((error) => {
      log('placeholder route migration failed', error);
      pendingPlaceholderMigration = null;
      routeHandshakePending = false;
      scheduleSample(0);
    });
    return true;
  }

  function sourceRouteStillMounted(snapshot) {
    if (!routeMountGuard) return false;
    const contains = (turns, container) => Boolean(container && turns.some((turn) => turn.container === container));
    const sourceNodesMounted = contains(snapshot.userTurns, routeMountGuard.userContainer)
      || contains(snapshot.assistantTurns, routeMountGuard.assistantContainer);
    if (sourceNodesMounted) return true;
    if (routeMountGuard.sourceWasGenerating && snapshot.isGenerating && !routeMountGuard.newIntent) return true;
    routeMountGuard = null;
    return false;
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
      completionGeneration += 1;
      currentCompletionStartedAt = Number(pendingIntent?.at) || Number(snapshot?.now) || Date.now();
      lastReportedGeneratingCompletionId = '';
      lastReportedGeneratingWithoutFinalActionCompletionId = '';
      currentTurnSawGeneratingWithoutFinalAction = false;
      pendingRouteRecovery = null;
      recoveryLastFingerprint = '';
      recoveryStableSince = 0;
      recoveryStableSamples = 0;
      currentTurnEvidence = {
        explicit: source === 'explicit',
        baselineUserCount: Number(snapshot?.userCount) || 0,
        userContainer: source === 'explicit' ? null : (snapshot?.userTurns?.at(-1)?.container || null),
        intentAt: Number(pendingIntent?.at) || Number(snapshot?.now) || Date.now(),
      };
    }
    sendRouteMessage({
      type: 'turn-start',
      completionId: currentCompletionId,
      startedAt: currentCompletionStartedAt,
      userCount: Number(snapshot?.userCount) || 0,
      assistantCount: Number(snapshot?.assistantCount) || 0,
      tabHidden: document.visibilityState !== 'visible',
      source: source === 'explicit' ? 'explicit' : 'implicit',
      at: Date.now(),
    });
  }

  function noteUserIntent(kind) {
    const at = Date.now();
    currentRoutePreviouslyCompleted = false;
    if (pendingIntent && at - pendingIntent.at <= INTENT_DEDUPE_MS) {
      scheduleSample(0);
      return;
    }
    const snapshot = snapshotForCycle();
    if (routeMountGuard) routeMountGuard.newIntent = true;
    bootstrapGate.activate(at, 'user-intent');
    const key = `ui:${domAPI.fingerprint(location.pathname)}:${String(kind || 'request')}:${at}`;
    pendingIntent = { key, at, baselineUserCount: snapshot.userCount };
    currentTurnEvidence = {
      explicit: true,
      baselineUserCount: snapshot.userCount,
      userContainer: null,
      intentAt: at,
    };
    detector.arm?.({ ...snapshot, now: at });
    announceTurn(key, snapshot, 'explicit');
    scheduleSample(0);
  }

  function reportTurnProgress(snapshot, phase, completionId = currentCompletionId) {
    const id = String(completionId || '');
    if (!id) return;
    if (snapshot?.isGenerating && snapshot.hasFinalAction !== true) {
      currentTurnSawGeneratingWithoutFinalAction = true;
    }
    const sawWithoutFinalAction = currentTurnSawGeneratingWithoutFinalAction
      || pendingRouteRecovery?.sawGeneratingWithoutFinalAction === true;
    if (lastReportedGeneratingCompletionId === id
      && (!sawWithoutFinalAction || lastReportedGeneratingWithoutFinalActionCompletionId === id)) return;
    if (progressMessagesInFlight.has(id)) return;
    progressMessagesInFlight.add(id);
    sendRouteMessage({
      type: 'turn-progress',
      completionId: id,
      sawGenerating: true,
      sawGeneratingWithoutFinalAction: sawWithoutFinalAction,
      phase: String(phase || 'generating'),
      at: Number(snapshot?.now) || Date.now(),
    }, currentPath, routeEpoch, (response) => {
      progressMessagesInFlight.delete(id);
      if (currentCompletionId !== id) return;
      if (response?.ok) {
        lastReportedGeneratingCompletionId = id;
        if (sawWithoutFinalAction) lastReportedGeneratingWithoutFinalActionCompletionId = id;
      } else {
        globalThis.setTimeout(() => scheduleSample(0), 1_500);
      }
    });
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

  function observeCurrentTurnUser(snapshot) {
    if (!currentTurnEvidence || currentTurnEvidence.userContainer) return;
    const baseline = Math.max(0, Number(currentTurnEvidence.baselineUserCount) || 0);
    if (snapshot.userCount <= baseline) return;
    currentTurnEvidence.userContainer = snapshot.userTurns.at(-1)?.container || null;
  }

  function candidateIsDurablyHandled(response) {
    const terminalSuppression = response?.suppressed === true
      && ['already-notified', 'settings', 'expired-turn'].includes(String(response.reason || ''));
    return Boolean(response?.ok && (
      terminalSuppression
      || ['pending', 'delivered', 'suppressed'].includes(String(response.notificationStatus || ''))
    ));
  }

  function queueDomCandidate(candidate) {
    if (!candidate?.completionId) return;
    const existing = pendingDomCandidates.get(candidate.completionId);
    if (existing) {
      deliverDomCandidate(existing);
      return;
    }
    pendingDomCandidates.set(candidate.completionId, candidate);
    deliverDomCandidate(candidate);
  }

  function deliverDomCandidate(candidate) {
    if (!candidate || candidate.inFlight || candidate.retryAt > Date.now()) return;
    candidate.inFlight = true;
    candidate.attempts += 1;
    const message = {
      type: 'dom-final-candidate',
      completionId: candidate.completionId,
      at: candidate.event.completedAt,
      payload: {
        event: candidate.event,
        context: candidate.context,
      },
    };
    sendRouteMessage(message, candidate.path, candidate.epoch, (response) => {
      candidate.inFlight = false;
      if (candidateIsDurablyHandled(response)) {
        pendingDomCandidates.delete(candidate.completionId);
        if (candidate.completionId === currentCompletionId) pendingRouteRecovery = null;
        recoveryBaselineFingerprints.delete(candidate.completionId);
        return;
      }
      const delay = Math.min(60_000, 1_500 * (2 ** Math.min(5, candidate.attempts - 1)));
      candidate.retryAt = Date.now() + delay;
      log('candidate delivery deferred for retry', {
        completionId: candidate.completionId,
        attempts: candidate.attempts,
        reason: response?.reason || response?.error || 'no-response',
      });
      globalThis.setTimeout(() => scheduleSample(0), delay);
    }, true);
  }

  function retryPendingDomCandidates() {
    const now = Date.now();
    for (const candidate of pendingDomCandidates.values()) {
      if (!candidate.inFlight && candidate.retryAt <= now) deliverDomCandidate(candidate);
    }
  }

  function sendDomCandidate(event, snapshot, completionId = currentCompletionId, path = currentPath, epoch = routeEpoch) {
    reportLifecycle('candidate-sent', {
      at: snapshot.now,
      assistantCount: snapshot.assistantCount,
      userCount: snapshot.userCount,
      isGenerating: snapshot.isGenerating,
      hasFinalAction: snapshot.hasFinalAction,
      detectorPhase: detector.getState?.().phase || '',
    });
    queueDomCandidate({
      completionId: String(completionId || ''),
      path,
      epoch,
      attempts: 0,
      retryAt: 0,
      inFlight: false,
      event: {
        type: 'complete',
        durationMs: Number(event.durationMs) || 0,
        startedAt: Number(event.startedAt) || currentCompletionStartedAt || snapshot.now,
        completedAt: Number(event.completedAt) || snapshot.now,
        hasFinalAction: snapshot.hasFinalAction === true,
        finalEvidence: String(event.finalEvidence || (snapshot.hasFinalAction ? 'final-action' : '')),
      },
      context: pageContext(snapshot),
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
    const recoveryWasPending = pendingRouteRecovery?.completionId === currentCompletionId;
    const candidateWasPending = pendingDomCandidates.has(currentCompletionId);
    const sourceSnapshot = lastSampledSnapshot;
    const sourceWasGenerating = snapshotGeneratingEvidence(sourceSnapshot, state);
    const sourceSawGeneratingWithoutFinalAction = currentTurnSawGeneratingWithoutFinalAction;
    const turnEvidence = currentTurnEvidence;
    const sharedTurnUserContainer = turnEvidence?.explicit === true
      ? turnEvidence.userContainer
      : null;
    pendingPlaceholderMigration = null;
    if (currentCompletionId && isPlaceholderPath(oldPath) && isConversationPath(nextPath)
      && sharedTurnUserContainer && turnEvidence?.intentAt
      && lastNonComposerInteractionAt < Number(turnEvidence.intentAt)
      && lastPopstateAt < Number(turnEvidence.intentAt)) {
      pendingPlaceholderMigration = {
        completionId: currentCompletionId,
        sourcePath: oldPath,
        destinationPath: nextPath,
        userContainer: sharedTurnUserContainer,
        baselineUserCount: Number(turnEvidence.baselineUserCount) || 0,
        sawGeneratingWithoutFinalAction: sourceSawGeneratingWithoutFinalAction,
        startedAt: Number(turnEvidence.intentAt) || now,
        expiresAt: now + 10_000,
      };
    }
    if (currentCompletionId && (state.phase !== 'idle' || recoveryWasPending || sourceWasGenerating)) {
      routeMountGuard = {
        userContainer: sourceSnapshot?.userTurns?.at(-1)?.container || null,
        assistantContainer: sourceSnapshot?.assistantTurns?.at(-1)?.container || null,
        sourceWasGenerating,
        newIntent: false,
      };
    } else {
      routeMountGuard = null;
    }
    if (currentCompletionId && lastObservedFingerprint) {
      recoveryBaselineFingerprints.set(currentCompletionId, lastObservedFingerprint);
      while (recoveryBaselineFingerprints.size > 12) {
        recoveryBaselineFingerprints.delete(recoveryBaselineFingerprints.keys().next().value);
      }
    }
    currentPath = nextPath;
    routeEpoch += 1;
    currentRoutePreviouslyCompleted = false;
    lastSettleKey = '';
    pendingRouteRecovery = null;
    recoveryLastFingerprint = '';
    recoveryStableSince = 0;
    recoveryStableSamples = 0;

    if ((state.phase !== 'idle' || recoveryWasPending || candidateWasPending) && currentCompletionId) {
      sendRouteMessage({ type: 'turn-suspend', completionId: currentCompletionId, at: now }, oldPath, oldEpoch, null, true);
    }
    detector.reset();
    bootstrapGate.reset(now);
    currentTurnKey = '';
    lastSentTurnKey = '';
    lastDetectorCycle = 0;
    pendingIntent = null;
    completionGeneration += 1;
    currentCompletionId = '';
    currentCompletionStartedAt = 0;
    lastReportedGeneratingCompletionId = '';
    lastReportedGeneratingWithoutFinalActionCompletionId = '';
    currentTurnEvidence = null;
    currentTurnSawGeneratingWithoutFinalAction = false;
    enterCurrentRoute();
    log('SPA navigation entered an isolated silent baseline', { routeEpoch });
    return true;
  }

  function snapshotGeneratingEvidence(snapshot, state) {
    return Boolean(snapshot?.isGenerating || state?.sawGenerating === true);
  }

  function evaluateRouteRecovery(snapshot) {
    const pending = pendingRouteRecovery;
    if (!pending || !pending.completionId || pending.completionId !== currentCompletionId) return false;

    if (snapshot.isGenerating) {
      pending.sawGenerating = true;
      if (!snapshot.hasFinalAction) {
        pending.sawGeneratingWithoutFinalAction = true;
        currentTurnSawGeneratingWithoutFinalAction = true;
      }
      recoveryLastFingerprint = '';
      recoveryStableSince = 0;
      recoveryStableSamples = 0;
      reportTurnProgress(snapshot, 'generating');
      return true;
    }

    const baselineAssistantCount = Math.max(0, Number(pending.baselineAssistantCount) || 0);
    const baselineUserCount = Math.max(0, Number(pending.baselineUserCount) || 0);
    const baselineFingerprint = recoveryBaselineFingerprints.get(pending.completionId) || '';
    const sameCountFingerprintChanged = Boolean(
      snapshot.assistantCount === baselineAssistantCount
      && baselineFingerprint
      && snapshot.fingerprint
      && snapshot.fingerprint !== baselineFingerprint
    );
    const sameCountGenerationEvidence = snapshot.assistantCount === baselineAssistantCount
      && pending.sawGeneratingWithoutFinalAction === true;
    if (
      snapshot.userCount < baselineUserCount
      || snapshot.assistantCount < baselineAssistantCount
      || (snapshot.assistantCount === baselineAssistantCount
        && !sameCountFingerprintChanged
        && !sameCountGenerationEvidence)
    ) {
      recoveryLastFingerprint = '';
      recoveryStableSince = 0;
      recoveryStableSamples = 0;
      return true;
    }

    const recoverySignature = `${snapshot.fingerprint}:${snapshot.hasFinalAction ? 'action' : 'no-action'}`;
    if (recoverySignature !== recoveryLastFingerprint) {
      recoveryLastFingerprint = recoverySignature;
      recoveryStableSince = snapshot.now;
      recoveryStableSamples = 1;
    } else {
      recoveryStableSamples += 1;
    }

    const actionlessEligible = (
      snapshot.hasFinalAction !== true
      && pending.startSource === 'explicit'
      && pending.sawGenerating !== true
    );
    if (snapshot.hasFinalAction !== true && !actionlessEligible) return true;
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
      retryPendingDomCandidates();
      const oldPath = currentPath;
      resetForNavigation();
      if (oldPath !== currentPath) {
        // `resetForNavigation()` schedules a route handshake; this sample is only
        // a baseline for the new conversation and must not advance the old turn.
        return;
      }
      let snapshot = snapshotForCycle();
      lastSampledSnapshot = snapshot;
      observeCurrentTurnUser(snapshot);
      if (routeHandshakePending) return;
      sampleCount += 1;
      const sampleGapMs = lastSampleAt ? Math.max(0, snapshot.now - lastSampleAt) : 0;
      if (snapshot.fingerprint && snapshot.fingerprint !== lastObservedFingerprint) {
        if (lastObservedFingerprint) textRevisionCount += 1;
        lastObservedFingerprint = snapshot.fingerprint;
      }
      lastSampleAt = snapshot.now;
      if (sourceRouteStillMounted(snapshot)) {
        reportSampleState(snapshot, detector.getState(), sampleGapMs);
        return;
      }
      if (currentCompletionId && currentTurnSawGeneratingWithoutFinalAction
        && lastReportedGeneratingWithoutFinalActionCompletionId !== currentCompletionId) {
        reportTurnProgress(snapshot, detector.getState?.().phase || 'generating');
      }
      if (currentRoutePreviouslyCompleted && !pendingIntent && !pendingRouteRecovery) {
        detector.reset();
        currentTurnKey = '';
        lastSentTurnKey = '';
        lastDetectorCycle = 0;
        lastReportedGeneratingCompletionId = '';
        reportSampleState(snapshot, detector.getState(), sampleGapMs);
        return;
      }
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
      if (pendingRouteRecovery && evaluateRouteRecovery(snapshot)) {
        reportSampleState(snapshot, detector.getState(), sampleGapMs);
        return;
      }
      const event = detector.step(snapshot);
      const state = detector.getState();
      handleCycleTransition(snapshot, state);
      reportSampleState(snapshot, state, sampleGapMs);

      if (state.sawGenerating === true || snapshot.isGenerating || currentTurnSawGeneratingWithoutFinalAction) {
        reportTurnProgress(snapshot, state.phase);
      }

      if (event) {
        lastSettleKey = '';
        // Refresh once: action controls can be inserted in the same render batch.
        snapshot = snapshotForCycle(state.cycleNumber);
        lastSampledSnapshot = snapshot;
        observeCurrentTurnUser(snapshot);
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
      const rawTarget = event?.target;
      const intentTarget = rawTarget?.closest?.(USER_INTENT_SELECTOR);
      let composerTarget = false;
      try {
        composerTarget = Boolean(rawTarget?.closest?.(COMPOSER_SELECTOR)
          || rawTarget?.matches?.(COMPOSER_SELECTOR));
      } catch { composerTarget = false; }
      const anchor = rawTarget?.closest?.('a[href]');
      if (!intentTarget && !composerTarget
        && (anchor || rawTarget?.closest?.('button,[role="button"],[role="link"]'))) {
        lastNonComposerInteractionAt = Date.now();
      }
      if (intentTarget) noteUserIntent('button');
    }, true);
    globalThis.addEventListener?.('pageshow', (event) => {
      reportLifecycle('pageshow', { persisted: event?.persisted === true });
      lastSettleKey = '';
      scheduleSample(0);
    });
    globalThis.addEventListener?.('pagehide', (event) => {
      reportLifecycle('pagehide', { persisted: event?.persisted === true });
    });
    globalThis.addEventListener?.('popstate', () => {
      lastPopstateAt = Date.now();
      scheduleSample(0);
    });
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
        sendResponse({ ok: true, active: true, version: '1.5.1', mode: 'dom-only' });
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
