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
  let currentPath = location.pathname;

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
      turnKey: currentTurnKey || snapshot.turnKey || '',
      fingerprint: snapshot.fingerprint,
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
      turnKey: currentTurnKey || snapshot.turnKey || '',
      fingerprint: snapshot.fingerprint,
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

  function announceTurn(turnKey, userCount, source = 'implicit') {
    const key = String(turnKey || '').trim();
    if (!key) return;
    currentTurnKey = key;
    if (key === lastSentTurnKey) return;
    lastSentTurnKey = key;
    sendRuntimeMessage({
      type: 'turn-start',
      turnKey: key,
      userCount,
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
    announceTurn(key, snapshot.userCount, 'explicit');
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
    announceTurn(key, snapshot.userCount, pendingIsFresh ? 'explicit' : 'implicit');
    lastDetectorCycle = state.cycleNumber;
    pendingIntent = null;
  }

  function sendDomCandidate(event, snapshot) {
    sendRuntimeMessage({
      type: 'dom-final-candidate',
      turnKey: currentTurnKey || snapshot.turnKey || '',
      payload: {
        event: {
          type: 'complete',
          durationMs: Number(event.durationMs) || 0,
          startedAt: Number(event.startedAt) || snapshot.now,
          completedAt: Number(event.completedAt) || snapshot.now,
          fingerprint: String(event.fingerprint || snapshot.fingerprint || ''),
          hasFinalAction: snapshot.hasFinalAction === true,
          finalEvidence: String(event.finalEvidence || (snapshot.hasFinalAction ? 'final-action' : '')),
        },
        context: pageContext(snapshot),
      },
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
      state.cycleNumber,
      state.cycleStartAt,
      state.lastAssistantChangeAt,
      state.settleStartedAt,
      plan.mode,
    ].join(':');
    if (key === lastSettleKey) return;
    lastSettleKey = key;
    sendRuntimeMessage({
      type: 'schedule-settle-check',
      delayMs: plan.delayMs,
      cycleNumber: state.cycleNumber,
      settleKey: key,
    });
  }

  function resetForNavigation() {
    const nextPath = location.pathname;
    if (nextPath === currentPath) return false;
    const now = Date.now();
    const state = detector.getState?.() || { phase: 'idle' };
    const pendingIsFresh = pendingIntent && now - pendingIntent.at <= INTENT_COALESCE_MS;
    const preserveActiveTurn = pendingIsFresh || state.phase !== 'idle';
    currentPath = nextPath;
    if (preserveActiveTurn) {
      log('SPA navigation preserved active turn', nextPath);
      return false;
    }

    detector.reset();
    bootstrapGate.reset(now);
    lastSettleKey = '';
    currentTurnKey = '';
    lastSentTurnKey = '';
    lastDetectorCycle = 0;
    pendingIntent = null;
    log('SPA navigation entered silent hydration baseline', nextPath);
    return true;
  }

  function sample() {
    try {
      resetForNavigation();
      let snapshot = snapshotForCycle();
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
        lastSettleKey = '';
        log('historical DOM accepted as silent baseline', bootstrap.reason);
        return;
      }
      const event = detector.step(snapshot);
      const state = detector.getState();
      handleCycleTransition(snapshot, state);

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

  function scheduleSample(delay = SAMPLE_DEBOUNCE_MS) {
    scheduler?.schedule(delay);
  }

  function startObserver() {
    observer?.disconnect();
    observer = new MutationObserver(() => {
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
    pollTimer = globalThis.setInterval(sample, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => scheduleSample(0));
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
    globalThis.addEventListener?.('pageshow', () => scheduleSample(0));
    globalThis.addEventListener?.('popstate', () => scheduleSample(0));
    log('initialized: DOM-only final-evidence mode', settings);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'monitor-ping':
        sendResponse({ ok: true, active: true, version: '1.5.0', mode: 'dom-only' });
        return false;
      case 'monitor-sample-now': {
        const state = detector.getState();
        if (Number.isInteger(message.cycleNumber) && message.cycleNumber !== state.cycleNumber) {
          sendResponse({ ok: true, stale: true });
          return false;
        }
        sample();
        sendResponse({ ok: true, sampled: true });
        return false;
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
