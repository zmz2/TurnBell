'use strict';

importScripts(
  'notification-core.js',
  'tab-monitor-core.js',
  'finalization-core.js',
);

const notificationAPI = globalThis.GPTReplyNotification;
const finalizationAPI = globalThis.GPTReplyFinalization;
const tabMonitor = globalThis.GPTReplyTabMonitor.createMonitor(chrome);

const NOTIFICATION_PREFIX = 'turnbell-';
const FINALIZATION_STORAGE_KEY = 'turnbellFinalizationV2';
const NOTIFICATION_OUTBOX_KEY_PREFIX = 'notification-outbox:';
const LAST_DIAGNOSTIC_KEY = 'turnbellLastNotificationDiagnostic';
const LIFECYCLE_DIAGNOSTICS_KEY = 'turnbellLifecycleDiagnosticsV1';
const WATCHDOG_ALARM = 'turnbell-active-turn-watchdog';
const LOCK_REPLAY_STORAGE_KEY = 'turnbellLockedReplayQueueV1';
const LOCK_REPLAY_TTL_MS = 24 * 60 * 60 * 1_000;
const LOCK_REPLAY_QUEUE_LIMIT = 20;
const NOTIFICATION_RETRY_BASE_MS = 60 * 1_000;
const NOTIFICATION_RETRY_MAX_MS = 15 * 60 * 1_000;
const DOCUMENT_BOUND_MESSAGE_TYPES = new Set([
  'turn-start', 'turn-progress', 'route-enter', 'turn-move', 'turn-suspend',
  'dom-final-candidate', 'schedule-settle-check',
]);
const settleChecks = new Map();
let offscreenCreation = null;
let finalizationStorePromise = null;
let finalizationMutation = Promise.resolve();
let diagnosticMutation = Promise.resolve();
let lockReplayMutation = Promise.resolve();
let lockReplayFlush = Promise.resolve();
let workerRecoveryPromise = null;
const lockInitialNotificationsInFlight = new Set();
const notificationDeliveriesInFlight = new Map();

function storageGet(defaults) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(defaults, (items) => {
      resolve(chrome.runtime.lastError ? defaults : items);
    });
  });
}

function storageSet(items) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(items, () => resolve(!chrome.runtime.lastError));
  });
}

function localGet(defaults) {
  return new Promise((resolve) => {
    chrome.storage.local.get(defaults, (items) => {
      resolve(chrome.runtime.lastError ? defaults : items);
    });
  });
}

function localSet(items) {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, () => resolve(!chrome.runtime.lastError));
  });
}

function sessionGet(defaults) {
  if (!chrome.storage.session) return Promise.resolve(defaults);
  return new Promise((resolve) => {
    chrome.storage.session.get(defaults, (items) => {
      resolve(chrome.runtime.lastError ? defaults : items);
    });
  });
}

function sessionSet(items) {
  if (!chrome.storage.session) return Promise.resolve(false);
  return new Promise((resolve) => {
    chrome.storage.session.set(items, () => resolve(!chrome.runtime.lastError));
  });
}

async function getSettings(overrides) {
  if (overrides) return notificationAPI.normalizeSettings(overrides);
  const stored = await storageGet({});
  return notificationAPI.migrateSettings(stored);
}

async function hasOffscreenDocument() {
  if (typeof chrome.offscreen?.hasDocument === 'function') return chrome.offscreen.hasDocument();
  const extensionUrl = chrome.runtime.getURL('offscreen.html');
  const matchedClients = await clients.matchAll();
  return matchedClients.some((client) => client.url === extensionUrl);
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return false;
  if (await hasOffscreenDocument()) return true;
  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play a short local completion sound selected by the user.',
    }).finally(() => { offscreenCreation = null; });
  }
  await offscreenCreation;
  return true;
}

async function playSound(theme, volume) {
  try {
    if (!await ensureOffscreenDocument()) return false;
    const normalized = notificationAPI.normalizeSettings({ soundTheme: theme, soundVolume: volume });
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'play-sound',
      theme: normalized.soundTheme,
      volume: normalized.soundVolume,
    });
    return response?.ok === true;
  } catch {
    return false;
  }
}

function getNotificationPermissionLevel() {
  return new Promise((resolve) => {
    if (typeof chrome.notifications.getPermissionLevel !== 'function') {
      resolve('granted');
      return;
    }
    chrome.notifications.getPermissionLevel((level) => {
      resolve(chrome.runtime.lastError ? 'denied' : String(level || 'denied'));
    });
  });
}

function getActiveNotifications() {
  return new Promise((resolve) => {
    if (typeof chrome.notifications.getAll !== 'function') {
      resolve({ ok: false, items: {} });
      return;
    }
    chrome.notifications.getAll((items) => {
      resolve(chrome.runtime.lastError
        ? { ok: false, items: {} }
        : { ok: true, items: items || {} });
    });
  });
}

function durationLabel(durationMs) {
  if (!durationMs) return '';
  if (durationMs < 60_000) return `用时 ${(durationMs / 1_000).toFixed(1)} 秒`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `用时 ${minutes} 分 ${seconds} 秒`;
}

async function showBrowserNotification(payload, settings) {
  const tabPart = Number.isInteger(payload.tabId) ? payload.tabId : 'unknown';
  const notificationId = String(payload.notificationId || `${NOTIFICATION_PREFIX}${tabPart}-${Date.now()}`);
  const activeBeforeCreate = await getActiveNotifications();
  if (activeBeforeCreate.ok && Object.hasOwn(activeBeforeCreate.items, notificationId)) {
    return {
      created: true,
      active: true,
      existing: true,
      id: notificationId,
      permission: 'granted',
      diagnostic: 'already-active',
      error: '',
      createdAt: 0,
    };
  }
  const permission = await getNotificationPermissionLevel();
  if (permission !== 'granted') {
    return {
      created: false,
      active: false,
      id: null,
      permission,
      diagnostic: 'permission-denied',
      error: 'Edge extension notification permission is denied.',
    };
  }

  const result = await new Promise((resolve) => {
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icons/icon-128.png'),
      title: payload.title,
      message: payload.message,
      contextMessage: durationLabel(payload.durationMs),
      priority: 2,
      requireInteraction: settings.persistentNotification,
      eventTime: Date.now(),
      silent: notificationAPI.notificationSilent(settings),
    }, (createdId) => {
      const error = chrome.runtime.lastError?.message || '';
      resolve({ createdId: error ? null : createdId || notificationId, error, createdAt: Date.now() });
    });
  });

  if (!result.createdId) {
    return {
      created: false,
      active: false,
      id: null,
      permission,
      diagnostic: 'create-failed',
      error: result.error || 'Edge did not accept the notification.',
      createdAt: result.createdAt,
    };
  }

  const activeItems = await getActiveNotifications();
  const active = activeItems.ok ? Object.hasOwn(activeItems.items, result.createdId) : null;
  return {
    created: true,
    active,
    existing: false,
    id: result.createdId,
    permission,
    diagnostic: activeItems.ok
      ? (active ? 'accepted-active' : 'accepted-not-active')
      : 'accepted-active-unverified',
    error: '',
    createdAt: result.createdAt,
  };
}

function webNotificationSupported() {
  return Boolean(globalThis.registration && typeof globalThis.registration.showNotification === 'function');
}

async function showServiceWorkerNotification(payload, settings) {
  const registrationObject = globalThis.registration;
  if (!registrationObject || typeof registrationObject.showNotification !== 'function') {
    return {
      created: false, active: false, permission: 'unsupported',
      diagnostic: 'web-unsupported', error: 'ServiceWorkerRegistration.showNotification is unavailable.',
    };
  }
  const tag = String(payload.webTag || `turnbell-web-${Number.isInteger(payload.tabId) ? payload.tabId : 'unknown'}-${Date.now()}`);
  try {
    if (typeof registrationObject.getNotifications === 'function') {
      const existing = await registrationObject.getNotifications({ tag });
      if (Array.isArray(existing) && existing.length > 0) {
        return {
          created: true, active: true, existing: true, permission: 'granted', tag,
          diagnostic: 'web-already-active', error: '', createdAt: 0,
        };
      }
    }
    await registrationObject.showNotification(payload.title, {
      body: payload.message,
      icon: chrome.runtime.getURL('assets/icons/icon-128.png'),
      badge: chrome.runtime.getURL('assets/icons/icon-48.png'),
      tag,
      requireInteraction: settings.persistentNotification,
      silent: notificationAPI.notificationSilent(settings),
      data: {
        tabId: payload.tabId,
        completionId: String(payload.completionId || ''),
        notificationKind: String(payload.notificationKind || ''),
      },
    });
    let active = true;
    if (typeof registrationObject.getNotifications === 'function') {
      const notifications = await registrationObject.getNotifications({ tag });
      active = Array.isArray(notifications) ? notifications.length > 0 : true;
    }
    return {
      created: true, active, existing: false, permission: 'granted', tag,
      diagnostic: active ? 'web-accepted-active' : 'web-accepted-not-active', error: '', createdAt: Date.now(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      created: false, active: false, permission: /denied|notallowed/iu.test(message) ? 'denied' : 'unknown',
      diagnostic: 'web-create-failed', error: message,
    };
  }
}

async function setCompletionBadge(tabId) {
  if (!Number.isInteger(tabId) || !chrome.action) return false;
  try {
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text: '✓' }),
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#2673dd' }),
      chrome.action.setTitle({ tabId, title: 'TurnBell：回复已完成' }),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function clearCompletionBadge(tabId) {
  if (!Number.isInteger(tabId) || !chrome.action) return false;
  try {
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text: '' }),
      chrome.action.setTitle({ tabId, title: 'TurnBell' }),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function routeNotification(payload, settings) {
  const actions = notificationAPI.chooseNotificationActions(settings);
  const extensionPromise = actions.includes('extension')
    ? showBrowserNotification(payload, settings)
    : Promise.resolve({ created: false, active: false, id: null, permission: 'skipped', diagnostic: 'skipped', error: '' });
  const webPromise = actions.includes('web')
    ? showServiceWorkerNotification(payload, settings)
    : Promise.resolve({ created: false, active: false, permission: 'skipped', diagnostic: 'skipped', error: '' });
  const [browserResult, webResult, badgeSet] = await Promise.all([
    extensionPromise,
    webPromise,
    setCompletionBadge(payload.tabId),
  ]);
  const hasNewNotification = browserResult.existing !== true
    && webResult.existing !== true
    && ((browserResult.created && browserResult.existing !== true)
    || (webResult.created && webResult.existing !== true));
  const soundPlayed = hasNewNotification && notificationAPI.shouldPlayCustomSound(settings)
    ? await playSound(settings.soundTheme, settings.soundVolume)
    : false;
  const systemSoundRequested = settings.sound && settings.soundTheme === 'system';
  const routes = {
    browser: browserResult.created,
    browserActive: browserResult.active,
    notificationId: browserResult.id,
    webTag: webResult.tag || String(payload.webTag || ''),
    notificationCreatedAt: browserResult.createdAt || webResult.createdAt || 0,
    permission: browserResult.permission,
    diagnostic: browserResult.diagnostic,
    error: browserResult.error,
    web: webResult.created,
    webActive: webResult.active,
    webPermission: webResult.permission,
    webDiagnostic: webResult.diagnostic,
    webError: webResult.error,
    systemSound: systemSoundRequested && hasNewNotification,
    sound: Boolean(soundPlayed),
    badge: Boolean(badgeSet),
  };
  await sessionSet({ [LAST_DIAGNOSTIC_KEY]: { ...routes, at: Date.now() } });
  return routes;
}

function getTab(tabId) {
  return new Promise((resolve) => {
    if (!Number.isInteger(tabId)) { resolve(null); return; }
    chrome.tabs.get(tabId, (tab) => resolve(chrome.runtime.lastError ? null : tab || null));
  });
}

function getWindow(windowId) {
  return new Promise((resolve) => {
    if (!Number.isInteger(windowId)) { resolve(null); return; }
    chrome.windows.get(windowId, (windowObject) => {
      resolve(chrome.runtime.lastError ? null : windowObject || null);
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    if (!Number.isInteger(tabId)) { resolve(null); return; }
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        resolve(chrome.runtime.lastError ? null : response || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function sendTabMessageBounded(tabId, message, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timerId);
      resolve(value);
    };
    const timerId = setTimeout(() => finish(null), timeoutMs);
    void sendTabMessage(tabId, message).then(finish, () => finish(null));
  });
}

async function resolvedContext(tabId, rawContext = {}, preserveCapturedVisibility = false) {
  const tab = await getTab(tabId);
  const windowObject = tab ? await getWindow(tab.windowId) : null;
  const context = { ...rawContext, tabId };
  if (preserveCapturedVisibility) context.tabHidden = Boolean(rawContext.tabHidden);
  else if (tab && windowObject) context.tabHidden = !(Boolean(tab.active) && Boolean(windowObject.focused));
  else context.tabHidden = Boolean(rawContext.tabHidden);
  delete context.preserveTabHidden;
  context.pageTitle = String(context.pageTitle || tab?.title || 'ChatGPT');
  context.url = String(context.url || tab?.url || 'https://chatgpt.com/');
  context.hasFinalAction = context.hasFinalAction === true;
  context.fingerprint = String(context.fingerprint || '');
  return context;
}

function withLockReplayMutation(updater) {
  const run = lockReplayMutation.then(async () => {
    const items = await localGet({ [LOCK_REPLAY_STORAGE_KEY]: [] });
    const queue = Array.isArray(items[LOCK_REPLAY_STORAGE_KEY])
      ? items[LOCK_REPLAY_STORAGE_KEY]
      : [];
    const result = await updater(queue);
    if (!await localSet({ [LOCK_REPLAY_STORAGE_KEY]: queue })) {
      throw new Error('locked-replay-store-write-failed');
    }
    return result;
  });
  lockReplayMutation = run.catch(() => undefined);
  return run;
}

function completionToken(completionId) {
  return String(completionId || '').replace(/[^a-z0-9-]/giu, '').slice(0, 72) || 'unknown';
}

function completionNotificationIds(tabId, completionId) {
  const tabPart = Number.isInteger(tabId) ? tabId : 'unknown';
  const token = completionToken(completionId);
  return {
    token,
    notificationId: `${NOTIFICATION_PREFIX}${tabPart}-completion-${token}`,
    webTag: `turnbell-web-${tabPart}-${token}`,
  };
}

function lockNotificationIds(tabId, completionId) {
  const token = completionToken(completionId);
  return {
    token,
    initial: `${NOTIFICATION_PREFIX}${Number.isInteger(tabId) ? tabId : 'unknown'}-lock-${token}-initial`,
    replay: `${NOTIFICATION_PREFIX}${Number.isInteger(tabId) ? tabId : 'unknown'}-lock-${token}-unlock`,
    initialWebTag: `turnbell-web-${token}-initial`,
    replayWebTag: `turnbell-web-${token}-unlock`,
  };
}

function pruneLockReplayQueue(queue, now = Date.now()) {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (!queue[index] || Number(queue[index].expiresAt) <= now) queue.splice(index, 1);
  }
  queue.sort((left, right) => Number(left.completedAt) - Number(right.completedAt));
  while (queue.length > LOCK_REPLAY_QUEUE_LIMIT) queue.shift();
}

async function queryIdleState() {
  if (typeof chrome.idle?.queryState !== 'function') return 'unknown';
  return new Promise((resolve) => {
    let finished = false;
    const done = (state) => {
      if (finished) return;
      finished = true;
      resolve(['active', 'idle', 'locked'].includes(String(state)) ? String(state) : 'unknown');
    };
    try {
      const possiblePromise = chrome.idle.queryState(15, done);
      if (possiblePromise && typeof possiblePromise.then === 'function') {
        possiblePromise.then(done, () => done('unknown'));
      }
    } catch {
      done('unknown');
    }
  });
}

async function enqueueLockedReplay(item) {
  if (!item?.completionId) return null;
  const now = Date.now();
  return withLockReplayMutation((queue) => {
    pruneLockReplayQueue(queue, now);
    let existing = queue.find((entry) => entry.completionId === item.completionId);
    if (!existing) {
      existing = {
        completionId: String(item.completionId),
        tabId: Number.isInteger(item.tabId) ? item.tabId : null,
        completedAt: Math.max(0, Number(item.completedAt) || now),
        durationMs: Math.max(0, Number(item.durationMs) || 0),
        initialNotificationId: String(item.initialNotificationId || ''),
        replayNotificationId: String(item.replayNotificationId || ''),
        initialWebTag: String(item.initialWebTag || ''),
        replayWebTag: String(item.replayWebTag || ''),
        notificationBackend: ['extension', 'web', 'both'].includes(String(item.notificationBackend || ''))
          ? String(item.notificationBackend)
          : 'extension',
        status: 'creating-initial',
        attempts: 0,
        expiresAt: now + LOCK_REPLAY_TTL_MS,
        tabClosed: false,
        initialClosed: false,
      };
      queue.push(existing);
    }
    pruneLockReplayQueue(queue, now);
    return { ...existing };
  });
}

async function updateLockedReplay(completionId, updater) {
  const id = String(completionId || '');
  return withLockReplayMutation((queue) => {
    const entry = queue.find((item) => item.completionId === id);
    if (!entry) return null;
    return updater(entry, queue);
  });
}

async function getLockedReplay(completionId) {
  const id = String(completionId || '');
  return withLockReplayMutation((queue) => {
    const entry = queue.find((item) => item.completionId === id);
    return entry ? { ...entry } : null;
  });
}

async function clearNotification(id) {
  if (!id || typeof chrome.notifications?.clear !== 'function') return false;
  return new Promise((resolve) => {
    try { chrome.notifications.clear(id, (cleared) => resolve(Boolean(cleared))); }
    catch { resolve(false); }
  });
}

async function closeWebNotification(tag) {
  if (!tag || typeof globalThis.registration?.getNotifications !== 'function') return;
  try {
    const notifications = await globalThis.registration.getNotifications({ tag });
    for (const notification of notifications || []) notification.close?.();
  } catch { /* unsupported by the current notification backend */ }
}

async function clearReplayPair(item) {
  await Promise.all([
    clearNotification(item.initialNotificationId),
    clearNotification(item.replayNotificationId),
    closeWebNotification(item.initialWebTag),
    closeWebNotification(item.replayWebTag),
  ]);
}

async function acknowledgeLockedReplay(completionId) {
  const item = await updateLockedReplay(completionId, (entry) => {
    const newlyAcknowledged = entry.status !== 'acknowledged';
    entry.status = 'acknowledged';
    if (newlyAcknowledged) entry.acknowledgedAt = Date.now();
    return { ...entry, newlyAcknowledged };
  });
  if (item?.newlyAcknowledged) {
    await markNotificationDeliveredByCompletion(item.tabId, completionId);
    await clearReplayPair(item);
    await refreshWatchdogAlarm();
  }
}

async function retryLockedReplayAfterInitialClose(completionId) {
  const item = await updateLockedReplay(completionId, (entry) => {
    if (['acknowledged', 'replayed'].includes(String(entry.status))) return null;
    entry.initialClosed = true;
    if (entry.status === 'initial-active') entry.status = 'pending';
    return { ...entry };
  });
  if (!item) return false;
  await refreshWatchdogAlarm();
  if (await queryIdleState() !== 'locked') await flushPendingLockedReplays();
  return true;
}

async function notificationWithTagExists(tag) {
  if (!tag || typeof globalThis.registration?.getNotifications !== 'function') {
    return { ok: false, exists: false };
  }
  try {
    const notifications = await globalThis.registration.getNotifications({ tag });
    return { ok: true, exists: Array.isArray(notifications) && notifications.length > 0 };
  } catch { return { ok: false, exists: false }; }
}

async function pendingReplayItems() {
  return withLockReplayMutation((queue) => {
    pruneLockReplayQueue(queue);
    return queue
      .filter((item) => ['creating-initial', 'pending', 'creating-replay'].includes(String(item.status)))
      .map((item) => ({ ...item }));
  });
}

async function flushPendingLockedReplays() {
  const run = lockReplayFlush.then(async () => {
    const result = await performPendingLockedReplayFlush();
    await refreshWatchdogAlarm();
    return result;
  });
  lockReplayFlush = run.catch(() => undefined);
  return run;
}

async function performPendingLockedReplayFlush() {
  if (await queryIdleState() === 'locked') return { replayed: 0, locked: true };
  const items = await pendingReplayItems();
  const settings = await getSettings();
  let replayed = 0;
  for (const snapshot of items) {
    if (await queryIdleState() === 'locked') return { replayed, locked: true };
    if (snapshot.expiresAt && snapshot.expiresAt <= Date.now()) continue;
    // A live request may still be creating the original notification. After a
    // worker restart this in-memory marker is gone, so the orphan is recovered.
    if (snapshot.status === 'creating-initial' && lockInitialNotificationsInFlight.has(snapshot.completionId)) continue;
    if (snapshot.status === 'pending'
      && Number(snapshot.lastAttemptAt) > 0
      && Date.now() - Number(snapshot.lastAttemptAt) < 10_000) continue;

    const backend = ['extension', 'web', 'both'].includes(String(snapshot.notificationBackend || ''))
      ? String(snapshot.notificationBackend)
      : settings.notificationBackend;
    const needsExtension = ['extension', 'both'].includes(backend);
    const needsWeb = ['web', 'both'].includes(backend);
    const [extensionState, webReplayState, webInitialState] = await Promise.all([
      needsExtension ? getActiveNotifications() : Promise.resolve({ ok: true, items: {} }),
      needsWeb ? notificationWithTagExists(snapshot.replayWebTag) : Promise.resolve({ ok: true, exists: false }),
      needsWeb ? notificationWithTagExists(snapshot.initialWebTag) : Promise.resolve({ ok: true, exists: false }),
    ]);
    const replayIsActive = (
      (extensionState.ok && Object.hasOwn(extensionState.items, snapshot.replayNotificationId))
      || (webReplayState.ok && webReplayState.exists)
    );
    if (replayIsActive) {
      await updateLockedReplay(snapshot.completionId, (entry) => {
        if (['acknowledged', 'replayed'].includes(String(entry.status))) return entry;
        entry.status = 'replayed';
        entry.replayedAt = entry.replayedAt || Date.now();
        return entry;
      });
      replayed += 1;
      continue;
    }

    const latestBeforeInitialCheck = await getLockedReplay(snapshot.completionId);
    const initialClosed = latestBeforeInitialCheck?.initialClosed === true || snapshot.initialClosed === true;
    const initialIsActive = !initialClosed && (
      (extensionState.ok && Object.hasOwn(extensionState.items, snapshot.initialNotificationId))
      || (webInitialState.ok && webInitialState.exists)
    );
    if (initialIsActive) {
      const markedActive = await updateLockedReplay(snapshot.completionId, (entry) => {
        if (['acknowledged', 'replayed'].includes(String(entry.status))) return entry;
        if (entry.initialClosed) return entry;
        entry.status = 'initial-active';
        entry.initialActiveAt = entry.initialActiveAt || Date.now();
        return { ...entry };
      });
      if (markedActive?.status === 'initial-active' && markedActive.initialClosed !== true) {
        await markNotificationDeliveredByCompletion(snapshot.tabId, snapshot.completionId);
        continue;
      }
    }

    // A failed activity query is unknown, not proof that a lock-screen alert
    // disappeared. Keep the replay pending until every used channel can be
    // checked successfully.
    if ((needsExtension && !extensionState.ok)
      || (needsWeb && (!webReplayState.ok || !webInitialState.ok))) continue;

    let tabClosed = snapshot.tabClosed === true;
    if (!tabClosed && Number.isInteger(snapshot.tabId)) tabClosed = !(await getTab(snapshot.tabId));
    const marked = await updateLockedReplay(snapshot.completionId, (entry) => {
      if (!['creating-initial', 'pending', 'creating-replay'].includes(String(entry.status))) return null;
      entry.status = 'creating-replay';
      entry.attempts = Math.max(0, Number(entry.attempts) || 0) + 1;
      entry.lastAttemptAt = Date.now();
      entry.tabClosed = tabClosed;
      return { ...entry };
    });
    if (!marked) continue;

    await clearNotification(marked.initialNotificationId);
    await closeWebNotification(marked.initialWebTag);
    const latest = await getLockedReplay(marked.completionId);
    if (!latest || latest.status === 'acknowledged' || latest.status === 'replayed') continue;
    if (await queryIdleState() === 'locked') {
      await updateLockedReplay(marked.completionId, (entry) => {
        if (entry.status === 'creating-replay') entry.status = 'pending';
        return entry;
      });
      return { replayed, locked: true };
    }
    const payload = notificationAPI.makeNotificationPayload({
      durationMs: marked.durationMs,
      fingerprint: '',
    }, {
      tabId: marked.tabId,
      pageTitle: '',
      url: 'https://chatgpt.com/',
      tabHidden: true,
    });
    payload.message = '锁屏期间有一轮回复完成';
    payload.notificationId = marked.replayNotificationId;
    payload.webTag = marked.replayWebTag;
    payload.completionId = marked.completionId;
    payload.notificationKind = 'unlock-replay';
    const routes = await routeNotification(payload, settings);
    if (routes.browser || routes.web) {
      await updateLockedReplay(marked.completionId, (entry) => {
        if (entry.status === 'acknowledged') return entry;
        entry.status = 'replayed';
        entry.replayedAt = Date.now();
        return entry;
      });
      await markNotificationDeliveredByCompletion(marked.tabId, marked.completionId);
      replayed += 1;
    } else {
      await updateLockedReplay(marked.completionId, (entry) => {
        if (entry.status === 'creating-replay') entry.status = 'pending';
        return entry;
      });
    }
  }
  return { replayed, locked: false };
}

async function handleIdleStateChanged(state) {
  if (state === 'locked') return { replayed: 0, locked: true };
  return flushPendingLockedReplays();
}

async function reconcileLockedReplayQueue() {
  const state = await queryIdleState();
  if (state === 'locked' || state === 'unknown') return { replayed: 0, locked: state === 'locked' };
  return flushPendingLockedReplays();
}

async function loadFinalizationStore() {
  if (!finalizationStorePromise) {
    finalizationStorePromise = sessionGet({ [FINALIZATION_STORAGE_KEY]: {} }).then((items) => {
      const value = items?.[FINALIZATION_STORAGE_KEY];
      return value && typeof value === 'object' ? value : {};
    });
  }
  return finalizationStorePromise;
}

function finalizationKey(tabId, pathHash) {
  const safePathHash = String(pathHash || 'legacy').slice(0, 128);
  return `${tabId}:${safePathHash}`;
}

function notificationOutboxKey(tabId, completionId) {
  return `${NOTIFICATION_OUTBOX_KEY_PREFIX}${tabId}:${encodeURIComponent(String(completionId || ''))}`;
}

function findNotificationState(store, tabId, pathHash, completionId) {
  const id = String(completionId || '');
  const routeKey = finalizationKey(tabId, pathHash);
  const routeState = finalizationAPI.normalizeState(store[routeKey]);
  if (routeState?.completionId === id) return { key: routeKey, state: routeState };

  const outboxKey = notificationOutboxKey(tabId, id);
  const outboxState = finalizationAPI.normalizeState(store[outboxKey]);
  if (
    outboxState?.completionId === id
    && outboxState.tabId === tabId
    && outboxState.pathHash === String(pathHash || '')
  ) return { key: outboxKey, state: outboxState };
  return null;
}

function preservePendingNotification(store, state) {
  const normalized = finalizationAPI.normalizeState(state);
  if (!normalized?.notified || normalized.notificationStatus !== 'pending') return false;
  if (!Number.isInteger(normalized.tabId) || !normalized.completionId) return false;
  const key = notificationOutboxKey(normalized.tabId, normalized.completionId);
  const existing = finalizationAPI.normalizeState(store[key]);
  if (existing?.completionId === normalized.completionId && existing.notificationStatus === 'pending') {
    return true;
  }
  store[key] = normalized;
  return true;
}

function pruneFinalizationStore(store, now = Date.now()) {
  for (const [key, rawState] of Object.entries(store)) {
    const state = finalizationAPI.normalizeState(rawState);
    if (!state || (state.expiresAt > 0 && state.expiresAt <= now)) delete store[key];
    else store[key] = state;
  }
}

async function mutableFinalizationStore() {
  const store = { ...(await loadFinalizationStore()) };
  pruneFinalizationStore(store);
  return store;
}

async function saveFinalizationStore(store) {
  if (!await sessionSet({ [FINALIZATION_STORAGE_KEY]: store })) {
    throw new Error('finalization-store-write-failed');
  }
  finalizationStorePromise = Promise.resolve(store);
}

function mutateFinalization(tabId, pathHash, updater) {
  const run = finalizationMutation.then(async () => {
    const store = await mutableFinalizationStore();
    const key = finalizationKey(tabId, pathHash);
    const previous = store[key] || null;
    const result = updater(previous, store, key);
    if (result?.state) store[key] = result.state;
    else delete store[key];
    await saveFinalizationStore(store);
    return { ...result, previous };
  });
  finalizationMutation = run.catch(() => undefined);
  return run;
}

function queueFinalizationMutation(updater) {
  const run = finalizationMutation.then(async () => {
    const store = await mutableFinalizationStore();
    const result = await updater(store);
    await saveFinalizationStore(store);
    return result;
  });
  finalizationMutation = run.catch(() => undefined);
  return run;
}

function pendingRouteSummary(state) {
  if (!state || state.notified || state.suspended) return null;
  if (state.expiresAt && state.expiresAt <= Date.now()) return null;
  return {
    completionId: String(state.completionId || ''),
    startedAt: Number(state.startedAt) || 0,
    baselineUserCount: Number(state.baselineUserCount) || 0,
    baselineAssistantCount: Number(state.baselineAssistantCount) || 0,
    startSource: String(state.startSource || 'implicit'),
    sawGenerating: state.sawGenerating === true,
    phase: String(state.phase || 'waiting'),
    expiresAt: Number(state.expiresAt) || 0,
  };
}

async function activeFinalizationEntries() {
  const store = { ...(await loadFinalizationStore()) };
  pruneFinalizationStore(store);
  const now = Date.now();
  return Object.entries(store).filter(([, state]) => (
    state
    && !state.notified
    && !state.suspended
    && (!Number(state.expiresAt) || Number(state.expiresAt) > now)
    && Number.isInteger(state.tabId)
    && String(state.pathHash || '')
    && String(state.completionId || '')
  ));
}

async function pendingNotificationEntries() {
  const store = { ...(await loadFinalizationStore()) };
  pruneFinalizationStore(store);
  const now = Date.now();
  return Object.entries(store).filter(([, state]) => (
    state
    && state.notified
    && state.notificationStatus === 'pending'
    && (!state.expiresAt || state.expiresAt > now)
    && Number.isInteger(state.tabId)
    && String(state.pathHash || '')
    && String(state.completionId || '')
  ));
}

async function markNotificationDeliveredByCompletion(tabId, completionId) {
  const id = String(completionId || '');
  if (!id) return false;
  return queueFinalizationMutation(async (store) => {
    let updated = false;
    for (const [key, rawState] of Object.entries(store)) {
      const state = finalizationAPI.normalizeState(rawState);
      if (!state || state.completionId !== id) continue;
      if (Number.isInteger(tabId) && state.tabId !== tabId) continue;
      if (key.startsWith(NOTIFICATION_OUTBOX_KEY_PREFIX)) {
        delete store[key];
        updated = true;
        continue;
      }
      if (state.notificationStatus !== 'delivered') {
        state.notificationStatus = 'delivered';
        state.notificationRetryAt = 0;
        store[key] = state;
        updated = true;
      }
    }
    return updated;
  });
}

async function markNotificationDeliveredById(notificationId) {
  const match = new RegExp(`^${NOTIFICATION_PREFIX}(\\d+)-completion-([a-z0-9-]+)$`, 'iu')
    .exec(String(notificationId || ''));
  if (!match) return false;
  const tabId = Number(match[1]);
  const token = String(match[2]);
  return queueFinalizationMutation(async (store) => {
    let updated = false;
    for (const [key, rawState] of Object.entries(store)) {
      const state = finalizationAPI.normalizeState(rawState);
      if (!state || state.tabId !== tabId || completionToken(state.completionId) !== token) continue;
      if (key.startsWith(NOTIFICATION_OUTBOX_KEY_PREFIX)) {
        delete store[key];
        updated = true;
        continue;
      }
      state.notificationStatus = 'delivered';
      state.notificationRetryAt = 0;
      store[key] = state;
      updated = true;
    }
    return updated;
  });
}

async function updateNotificationState(tabId, pathHash, completionId, update) {
  const result = await queueFinalizationMutation((store) => {
    const found = findNotificationState(store, tabId, pathHash, completionId);
    if (!found) return null;
    update(found.state);
    if (
      found.key.startsWith(NOTIFICATION_OUTBOX_KEY_PREFIX)
      && ['delivered', 'suppressed'].includes(found.state.notificationStatus)
    ) {
      delete store[found.key];
    } else {
      store[found.key] = found.state;
    }
    return found.state;
  });
  return result || null;
}

async function pruneExpiredFinalizationRecords() {
  const store = await loadFinalizationStore();
  const now = Date.now();
  const hasExpired = Object.values(store).some((rawState) => {
    const state = finalizationAPI.normalizeState(rawState);
    return !state || (state.expiresAt > 0 && state.expiresAt <= now);
  });
  if (!hasExpired) return false;
  return queueFinalizationMutation(async () => ({ pruned: true }));
}

async function refreshWatchdogAlarm() {
  if (!chrome.alarms?.create) return false;
  const pendingTurns = await activeFinalizationEntries();
  const pendingNotifications = await pendingNotificationEntries();
  const pendingLockedReplays = await pendingReplayItems();
  if (pendingTurns.length === 0 && pendingNotifications.length === 0 && pendingLockedReplays.length === 0) {
    try { await chrome.alarms.clear(WATCHDOG_ALARM); } catch { /* optional on older builds */ }
    return false;
  }
  try {
    // One minute also respects pre-Chrome-120 builds, whose packaged alarms
    // have a less predictable minimum period than current Chromium.
    await chrome.alarms.create(WATCHDOG_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
    return true;
  } catch (error) {
    console.warn('[TurnBell] watchdog alarm could not be scheduled', error);
    return false;
  }
}

async function runWatchdogAlarm() {
  await pruneExpiredFinalizationRecords();
  await flushPendingNotifications({ allowUnattempted: true });
  await flushPendingLockedReplays();
  const pending = await activeFinalizationEntries();
  if (pending.length === 0) {
    await refreshWatchdogAlarm();
    return;
  }
  for (const [, state] of pending) {
    const message = {
      type: 'monitor-sample-now',
      reason: 'watchdog',
      pathHash: state.pathHash,
      routeEpoch: state.routeEpoch,
      completionId: state.completionId,
    };
    const response = await sendTabMessageBounded(state.tabId, message);
    void recordLifecycleDiagnostic({
      type: 'watchdog-sample',
      at: Date.now(),
      pathHash: state.pathHash,
      routeEpoch: state.routeEpoch,
      lifecycle: response?.reason === 'route-not-mounted'
        ? 'route-not-mounted'
        : (response?.sampled === true ? 'sampled' : 'no-response'),
    }, { tab: { id: state.tabId }, documentId: state.documentId });
  }
  await refreshWatchdogAlarm();
}

async function recoverWorkerState() {
  try { await pruneExpiredFinalizationRecords(); }
  catch (error) { console.warn('[TurnBell] expired-state pruning failed', error); }
  try { await reconcileLockedReplayQueue(); }
  catch (error) { console.warn('[TurnBell] locked-replay recovery failed', error); }
  try { await flushPendingNotifications({ allowUnattempted: true }); }
  catch (error) { console.warn('[TurnBell] notification outbox recovery failed', error); }
  await refreshWatchdogAlarm();
}

function ensureWorkerRecovered() {
  if (!workerRecoveryPromise) {
    workerRecoveryPromise = recoverWorkerState().catch((error) => {
      workerRecoveryPromise = null;
      throw error;
    });
  }
  return workerRecoveryPromise;
}

function clearSettleChecksForTab(tabId) {
  for (const [key, pending] of settleChecks) {
    if (!key.startsWith(`${tabId}:`)) continue;
    clearTimeout(pending.timerId);
    pending.resolve({ ok: false, cancelled: true, reason: 'tab-removed' });
    settleChecks.delete(key);
  }
}

async function hashDiagnosticId(value) {
  const text = String(value || '');
  if (!text) return '';
  try {
    if (globalThis.crypto?.subtle?.digest && typeof globalThis.TextEncoder === 'function') {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(digest)].slice(0, 16)
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // Fall back to a short opaque diagnostic token in restricted runtimes.
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function recordLifecycleDiagnostic(event = {}, sender = {}) {
  const run = diagnosticMutation.then(async () => {
    const items = await sessionGet({ [LIFECYCLE_DIAGNOSTICS_KEY]: [] });
    const previous = Array.isArray(items[LIFECYCLE_DIAGNOSTICS_KEY])
      ? items[LIFECYCLE_DIAGNOSTICS_KEY]
      : [];
    const allowedTypes = new Set([
      'lifecycle-event', 'watchdog-sample', 'turn-start', 'turn-candidate', 'notification-created',
    ]);
    const allowedLifecycle = new Set([
      'freeze', 'resume', 'visibilitychange', 'pageshow', 'pagehide', 'focus',
      'sampled', 'no-response', 'route-not-mounted', 'candidate-sent', 'candidate-received',
      'created', 'suppressed', 'failed',
    ]);
    const eventType = allowedTypes.has(String(event.type)) ? String(event.type) : 'lifecycle-event';
    const safePathHash = /^[a-f0-9]{8,64}$/iu.test(String(event.pathHash || ''))
      ? String(event.pathHash).slice(0, 64)
      : '';
    const entry = {
      type: eventType,
      at: Math.max(0, Number(event.at) || Date.now()),
      observedAt: Math.max(0, Number(event.observedAt) || 0),
      notificationCreatedAt: Math.max(0, Number(event.notificationCreatedAt) || 0),
      tabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : null,
      documentIdHash: await hashDiagnosticId(sender?.documentId),
      pathHash: safePathHash,
      routeEpoch: Math.max(0, Math.trunc(Number(event.routeEpoch) || 0)),
      lifecycle: allowedLifecycle.has(String(event.lifecycle)) ? String(event.lifecycle) : '',
      visibilityState: ['visible', 'hidden', 'prerender'].includes(String(event.visibilityState))
        ? String(event.visibilityState)
        : 'unknown',
      wasDiscarded: event.wasDiscarded === true,
      sampleCount: Math.max(0, Math.trunc(Number(event.sampleCount) || 0)),
      mutationCount: Math.max(0, Math.trunc(Number(event.mutationCount) || 0)),
      textRevisionCount: Math.max(0, Math.trunc(Number(event.textRevisionCount) || 0)),
      timerTickCount: Math.max(0, Math.trunc(Number(event.timerTickCount) || 0)),
      sampleGapMs: Math.max(0, Math.trunc(Number(event.sampleGapMs) || 0)),
      assistantCount: Math.max(0, Math.trunc(Number(event.assistantCount) || 0)),
      userCount: Math.max(0, Math.trunc(Number(event.userCount) || 0)),
      isGenerating: event.isGenerating === true,
      hasFinalAction: event.hasFinalAction === true,
      detectorPhase: ['idle', 'waiting', 'generating', 'settling', 'complete'].includes(String(event.detectorPhase))
        ? String(event.detectorPhase)
        : '',
    };
    const next = [...previous, entry].slice(-200);
    await sessionSet({ [LIFECYCLE_DIAGNOSTICS_KEY]: next });
    return entry;
  });
  diagnosticMutation = run.catch(() => undefined);
  return run;
}

async function notifyFromFinal(tabId, action, event = {}, rawContext = {}) {
  const settings = await getSettings();
  const context = await resolvedContext(tabId, rawContext, rawContext.preserveTabHidden === true);
  const completionId = String(action?.completionId || event?.completionId || '');
  const completedAt = Number(action?.completedAt) || Date.now();
  const startedAt = Math.min(Number(action?.startedAt) || completedAt, completedAt);
  const durationMs = Math.max(0, completedAt - startedAt);
  if (!notificationAPI.shouldNotify(settings, context)) {
    return { ok: true, suppressed: true, reason: 'settings', notificationStatus: 'suppressed' };
  }

  const pendingLockItem = completionId ? await getLockedReplay(completionId) : null;
  const locked = await queryIdleState() === 'locked';
  const lockMode = locked || Boolean(pendingLockItem);
  const payload = notificationAPI.makeNotificationPayload({ durationMs }, context);
  let lockItem = pendingLockItem;
  let initialInFlight = false;

  if (lockMode && completionId) {
    if (['initial-active', 'replayed', 'acknowledged'].includes(String(lockItem?.status))) {
      return {
        ok: true,
        terminal: true,
        notificationStatus: 'delivered',
        routes: { browser: false, web: false },
      };
    }
    const ids = lockNotificationIds(tabId, completionId);
    payload.notificationId = ids.initial;
    payload.webTag = ids.initialWebTag;
    payload.completionId = completionId;
    payload.notificationKind = 'locked-initial';
    if (!lockItem) {
      lockInitialNotificationsInFlight.add(completionId);
      initialInFlight = true;
      try {
        lockItem = await enqueueLockedReplay({
          completionId,
          tabId,
          completedAt,
          durationMs,
          initialNotificationId: ids.initial,
          replayNotificationId: ids.replay,
          initialWebTag: ids.initialWebTag,
          replayWebTag: ids.replayWebTag,
          notificationBackend: settings.notificationBackend,
        });
      } catch (error) {
        lockInitialNotificationsInFlight.delete(completionId);
        throw error;
      }
    }
  } else {
    const ids = completionNotificationIds(tabId, completionId);
    payload.notificationId = ids.notificationId;
    payload.webTag = ids.webTag;
    payload.completionId = completionId;
    payload.notificationKind = 'completion';
  }

  let routes;
  try {
    routes = await routeNotification(payload, settings);
  } finally {
    if (initialInFlight) lockInitialNotificationsInFlight.delete(completionId);
  }
  if (lockItem) {
    await updateLockedReplay(completionId, (entry) => {
      if (entry.status === 'creating-initial') {
        entry.status = 'pending';
        entry.initialNotificationId = String(routes.notificationId || payload.notificationId || '');
        entry.initialWebTag = String(routes.webTag || payload.webTag || '');
      }
      return entry;
    });
    if (await queryIdleState() !== 'locked') await flushPendingLockedReplays();
    const latestLockItem = await getLockedReplay(completionId);
    if (lockedReplayIsTerminal(latestLockItem)) {
      await markNotificationDeliveredByCompletion(tabId, completionId);
      return { ok: true, terminal: true, notificationStatus: 'delivered', payload, routes };
    }
  }
  return { ok: true, payload, routes };
}

function notificationRetryDelay(attempts) {
  const exponent = Math.max(0, Math.min(8, Number(attempts) - 1));
  return Math.min(NOTIFICATION_RETRY_MAX_MS, NOTIFICATION_RETRY_BASE_MS * (2 ** exponent));
}

function lockedReplayIsTerminal(item) {
  return Boolean(item && ['initial-active', 'replayed', 'acknowledged'].includes(String(item.status)));
}

async function performPendingNotificationDelivery(tabId, pathHash, stateSnapshot, rawEventContext = {}, allowUnattempted = false) {
  const completionId = String(stateSnapshot?.completionId || '');
  if (!completionId) return { ok: false, reason: 'missing-completion-id' };

  let state = findNotificationState(
    await loadFinalizationStore(), tabId, pathHash, completionId,
  )?.state || null;
  if (!state || state.completionId !== completionId || !state.notified || state.notificationStatus !== 'pending') {
    return { ok: true, notificationStatus: state?.notificationStatus || 'none', terminal: true };
  }
  const now = Date.now();
  if (state.notificationRetryAt > now && !(allowUnattempted && state.notificationAttempts === 0)) {
    return { ok: true, notificationStatus: 'pending', deferred: true };
  }

  let lockItem = await getLockedReplay(completionId);
  if (lockItem && await queryIdleState() !== 'locked') {
    await flushPendingLockedReplays();
    lockItem = await getLockedReplay(completionId);
    if (lockedReplayIsTerminal(lockItem)) {
      await markNotificationDeliveredByCompletion(tabId, completionId);
      return { ok: true, terminal: true, notificationStatus: 'delivered' };
    }
    // An unlocked, still-pending lock record owns its retry path. Retrying the
    // original alert here could replace or race the generic unlock replay.
    if (lockItem) return { ok: true, notificationStatus: 'pending', deferred: true };
  }

  const claimed = await queueFinalizationMutation((store) => {
    const found = findNotificationState(store, tabId, pathHash, completionId);
    const current = found?.state || null;
    if (!current || current.completionId !== completionId || !current.notified
      || current.notificationStatus !== 'pending'
      || (current.notificationRetryAt > Date.now() && !(allowUnattempted && current.notificationAttempts === 0))) {
      return { state: current, action: { type: 'not-due' } };
    }
    current.notificationAttempts += 1;
    current.notificationRetryAt = Date.now() + notificationRetryDelay(current.notificationAttempts);
    store[found.key] = current;
    return { state: current, action: { type: 'claimed' } };
  });
  if (claimed.action.type !== 'claimed') {
    return { ok: true, notificationStatus: claimed.state?.notificationStatus || 'pending', deferred: true };
  }
  state = finalizationAPI.normalizeState(claimed.state);

  const retryContext = {
    tabId,
    pageTitle: 'ChatGPT',
    url: 'https://chatgpt.com/',
    tabHidden: state.tabHidden,
    preserveTabHidden: true,
  };
  const eventContext = Object.keys(rawEventContext || {}).length > 0
    ? { ...rawEventContext, preserveTabHidden: false }
    : retryContext;
  let response;
  try {
    const resolved = await resolvedContext(tabId, eventContext, eventContext.preserveTabHidden === true);
    await updateNotificationState(tabId, pathHash, completionId, (current) => {
      current.tabHidden = resolved.tabHidden;
    });
    response = await notifyFromFinal(tabId, {
      completionId,
      startedAt: state.startedAt,
      completedAt: state.notifiedAt || state.lastActivityAt,
    }, {}, resolved.preserveTabHidden === true
      ? resolved
      : { ...resolved, preserveTabHidden: true });
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (response?.notificationStatus === 'suppressed') {
    await updateNotificationState(tabId, pathHash, completionId, (current) => {
      current.notificationStatus = 'suppressed';
      current.notificationRetryAt = 0;
    });
    return { ...response, notificationStatus: 'suppressed' };
  }
  if (response?.terminal || response?.routes?.browser || response?.routes?.web) {
    await updateNotificationState(tabId, pathHash, completionId, (current) => {
      current.notificationStatus = 'delivered';
      current.notificationRetryAt = 0;
    });
    return { ...response, notificationStatus: 'delivered' };
  }
  return { ...response, notificationStatus: 'pending', deliveryPending: true };
}

function deliverPendingNotification(tabId, pathHash, state, rawEventContext = {}, allowUnattempted = false) {
  const completionId = String(state?.completionId || '');
  const key = `${tabId}:${pathHash}:${completionId}`;
  if (notificationDeliveriesInFlight.has(key)) return notificationDeliveriesInFlight.get(key);
  const work = performPendingNotificationDelivery(
    tabId, pathHash, state, rawEventContext, allowUnattempted,
  ).finally(() => notificationDeliveriesInFlight.delete(key));
  notificationDeliveriesInFlight.set(key, work);
  return work;
}

async function flushPendingNotifications({ allowUnattempted = true } = {}) {
  const entries = await pendingNotificationEntries();
  let delivered = 0;
  for (const [, state] of entries) {
    const tabId = Number(state.tabId);
    const pathHash = String(state.pathHash || '');
    if (!Number.isInteger(tabId) || !pathHash) continue;
    try {
      const response = await deliverPendingNotification(tabId, pathHash, state, {}, allowUnattempted);
      if (response?.notificationStatus === 'delivered') delivered += 1;
    } catch (error) {
      console.warn('[TurnBell] pending notification retry failed', error);
    }
  }
  return { delivered, remaining: Math.max(0, entries.length - delivered) };
}

async function handleTurnStart(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false, error: 'missing-tab' };
  const pathHash = String(message.pathHash || '');
  const completionId = String(message.completionId || '');
  if (!pathHash || !completionId) return { ok: false, error: 'missing-route-identity' };
  const result = await mutateFinalization(tabId, pathHash, (state, store) => {
    const previous = finalizationAPI.normalizeState(state);
    const next = finalizationAPI.beginTurn(state, {
      tabId,
      documentId: String(sender?.documentId || ''),
      pathHash,
      routeEpoch: Number(message.routeEpoch) || 0,
      completionId,
      at: Number(message.at) || Date.now(),
      startedAt: Number(message.startedAt) || Number(message.at) || Date.now(),
      userCount: Number(message.userCount) || 0,
      assistantCount: Number(message.assistantCount) || 0,
      tabHidden: message.tabHidden === true,
      source: String(message.source || 'implicit'),
    });
    if (next.action.type === 'new-turn') preservePendingNotification(store, previous);
    return next;
  });
  await refreshWatchdogAlarm();
  void recordLifecycleDiagnostic({
    type: 'turn-start', at: Number(message.at) || Date.now(), pathHash,
    routeEpoch: Number(message.routeEpoch) || 0, lifecycle: 'candidate-received',
  }, sender);
  return { ok: true, action: result.action.type, reason: result.action.reason || '' };
}

async function handleTurnProgress(message, sender) {
  const tabId = sender?.tab?.id;
  const pathHash = String(message.pathHash || '');
  if (!Number.isInteger(tabId) || !pathHash || !message.completionId) {
    return { ok: false, error: 'missing-route-identity' };
  }
  const result = await mutateFinalization(tabId, pathHash, (rawState) => {
    const state = finalizationAPI.normalizeState(rawState);
    if (!state || state.completionId !== String(message.completionId)) {
      return { state, action: { type: 'suppress', reason: 'completion-mismatch' } };
    }
    if (state.documentId && String(sender?.documentId || '') !== state.documentId) {
      return { state, action: { type: 'suppress', reason: 'document-mismatch' } };
    }
    if (state.routeEpoch !== (Number(message.routeEpoch) || 0)) {
      return { state, action: { type: 'suppress', reason: 'stale-route-epoch' } };
    }
    state.sawGenerating = state.sawGenerating || message.sawGenerating === true;
    if (state.sawGenerating) state.phase = String(message.phase || 'generating');
    state.lastActivityAt = Math.max(state.lastActivityAt, Number(message.at) || Date.now());
    return { state, action: { type: 'updated' } };
  });
  return { ok: true, action: result.action.type, reason: result.action.reason || '' };
}

async function handleRouteEnter(message, sender) {
  const tabId = sender?.tab?.id;
  const pathHash = String(message.pathHash || '');
  if (!Number.isInteger(tabId) || !pathHash) return { ok: false, error: 'missing-route-identity' };
  const now = Date.now();
  const result = await mutateFinalization(tabId, pathHash, (rawState) => {
    const state = finalizationAPI.normalizeState(rawState);
    if (!state || (state.expiresAt && state.expiresAt <= now)) {
      return { state: null, action: { type: 'no-pending' } };
    }
    if (state.notified) {
      return { state, action: { type: 'no-pending', previouslyCompleted: true } };
    }
    state.documentId = String(sender?.documentId || state.documentId);
    state.routeEpoch = Math.max(0, Math.trunc(Number(message.routeEpoch) || 0));
    state.suspended = false;
    state.lastActivityAt = Math.max(state.lastActivityAt, now);
    return { state, action: { type: 'pending', pending: pendingRouteSummary(state) } };
  });
  await refreshWatchdogAlarm();
  return {
    ok: true,
    pending: result.action.pending || null,
    previouslyCompleted: result.action.previouslyCompleted === true,
  };
}

async function handleRouteMove(message, sender) {
  const tabId = sender?.tab?.id;
  const fromPathHash = String(message.fromPathHash || '');
  const toPathHash = String(message.pathHash || '');
  const completionId = String(message.completionId || '');
  if (!Number.isInteger(tabId) || !fromPathHash || !toPathHash || !completionId) {
    return { ok: false, error: 'missing-route-identity' };
  }
  if (message.routeMoveEvidence !== 'shared-user-turn-node') {
    return { ok: false, reason: 'unverified-route-move', pending: null };
  }
  const result = await queueFinalizationMutation(async (store) => {
    const fromKey = finalizationKey(tabId, fromPathHash);
    const toKey = finalizationKey(tabId, toPathHash);
    const prior = finalizationAPI.normalizeState(store[fromKey]);
    const destination = finalizationAPI.normalizeState(store[toKey]);
    if (destination && destination.completionId !== completionId) {
      return { ok: false, reason: 'destination-owned', pending: pendingRouteSummary(destination) };
    }
    if (destination?.completionId === completionId) {
      if (!destination.notified) {
        destination.documentId = String(sender?.documentId || destination.documentId);
        destination.routeEpoch = Math.max(0, Math.trunc(Number(message.routeEpoch) || 0));
        destination.suspended = false;
        destination.lastActivityAt = Math.max(destination.lastActivityAt, Date.now());
        store[toKey] = destination;
      }
      if (fromKey !== toKey) delete store[fromKey];
      return { ok: true, pending: pendingRouteSummary(destination) };
    }
    if (prior?.completionId === completionId && !prior.notified) {
      prior.pathHash = toPathHash;
      prior.documentId = String(sender?.documentId || prior.documentId);
      prior.routeEpoch = Math.max(0, Math.trunc(Number(message.routeEpoch) || 0));
      prior.suspended = false;
      prior.lastActivityAt = Date.now();
      delete store[fromKey];
      store[toKey] = prior;
      return { ok: true, pending: pendingRouteSummary(prior) };
    }
    if (destination && !destination.notified) {
      destination.documentId = String(sender?.documentId || destination.documentId);
      destination.routeEpoch = Math.max(0, Math.trunc(Number(message.routeEpoch) || 0));
      destination.suspended = false;
      store[toKey] = destination;
      return { ok: true, pending: pendingRouteSummary(destination) };
    }
    return { ok: false, reason: 'source-turn-missing', pending: null };
  });
  await refreshWatchdogAlarm();
  return result;
}

async function handleRouteSuspend(message, sender) {
  const tabId = sender?.tab?.id;
  const pathHash = String(message.pathHash || '');
  if (!Number.isInteger(tabId) || !pathHash || !message.completionId) {
    return { ok: false, error: 'missing-route-identity' };
  }
  const result = await mutateFinalization(tabId, pathHash, (rawState) => {
    const state = finalizationAPI.normalizeState(rawState);
    if (!state || state.completionId !== String(message.completionId)) {
      return { state, action: { type: 'suppress', reason: 'completion-mismatch' } };
    }
    if (state.documentId && String(sender?.documentId || '') !== state.documentId) {
      return { state, action: { type: 'suppress', reason: 'document-mismatch' } };
    }
    if (state.routeEpoch !== (Number(message.routeEpoch) || 0)) {
      return { state, action: { type: 'suppress', reason: 'stale-route-epoch' } };
    }
    state.suspended = true;
    state.lastActivityAt = Date.now();
    return { state, action: { type: 'suspended' } };
  });
  await refreshWatchdogAlarm();
  return { ok: true, action: result.action.type, reason: result.action.reason || '' };
}

async function handleDomCandidate(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false, error: 'missing-tab' };
  const pathHash = String(message.pathHash || message?.payload?.pathHash || '');
  const completionId = String(message.completionId || '');
  if (!pathHash || !completionId) return { ok: false, error: 'missing-route-identity' };
  const event = message?.payload?.event || {};
  const context = message?.payload?.context || {};
  const hasFinalAction = event.hasFinalAction === true || context.hasFinalAction === true;
  const result = await mutateFinalization(tabId, pathHash, (state, store, currentKey) => {
    const completionIsRoutedElsewhere = Object.entries(store).some(([key, rawState]) => (
      key !== currentKey
      && (key.startsWith(`${tabId}:`) || key === notificationOutboxKey(tabId, completionId))
      && finalizationAPI.normalizeState(rawState)?.completionId === completionId
    ));
    if (completionIsRoutedElsewhere) {
      return { state, action: { type: 'suppress', reason: 'completion-route-mismatch' } };
    }
    return finalizationAPI.acceptDomCandidate(state, {
      tabId,
      documentId: String(sender?.documentId || ''),
      pathHash,
      routeEpoch: Number(message.routeEpoch) || 0,
      completionId,
      at: Number(event.completedAt) || Number(message.at) || Date.now(),
      startedAt: Number(event.startedAt) || 0,
      userCount: Number(context.userCount) || 0,
      assistantCount: Number(context.assistantCount) || 0,
      tabHidden: context.tabHidden === true,
      hasFinalAction,
      finalEvidence: String(event.finalEvidence || (hasFinalAction ? 'final-action' : '')),
    });
  });

  void recordLifecycleDiagnostic({
    type: 'turn-candidate', at: Date.now(), observedAt: Number(event.completedAt) || 0, pathHash,
    routeEpoch: Number(message.routeEpoch) || 0,
    lifecycle: result.action.type === 'notify' ? 'candidate-received' : 'suppressed',
  }, sender);

  if (result.action.type !== 'notify') {
    return { ok: true, suppressed: true, reason: result.action.reason || 'not-final' };
  }
  let response;
  try {
    response = await deliverPendingNotification(tabId, pathHash, result.state, context, true);
  } catch (error) {
    response = {
      ok: true,
      notificationStatus: 'pending',
      deliveryPending: true,
    };
  }
  void recordLifecycleDiagnostic({
    type: 'notification-created', at: Date.now(), observedAt: Number(event.completedAt) || 0,
    notificationCreatedAt: Number(response?.routes?.notificationCreatedAt) || 0,
    pathHash, routeEpoch: Number(message.routeEpoch) || 0,
    lifecycle: response?.notificationStatus === 'delivered'
      ? 'created'
      : (response?.notificationStatus === 'suppressed' ? 'suppressed' : 'failed'),
  }, sender);
  await refreshWatchdogAlarm();
  return response;
}

function scheduleSettleCheck(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return Promise.resolve({ ok: false, error: 'missing-tab' });
  const pathHash = String(message.pathHash || '');
  const routeKey = finalizationKey(tabId, pathHash);
  const previous = settleChecks.get(routeKey);
  if (previous) {
    clearTimeout(previous.timerId);
    previous.resolve({ ok: true, cancelled: true, reason: 'superseded' });
    settleChecks.delete(routeKey);
  }

  const rawDelay = Number(message.delayMs);
  const delayMs = Number.isFinite(rawDelay) ? Math.min(10_000, Math.max(200, Math.round(rawDelay))) : 1_200;
  return new Promise((resolve) => {
    const timerId = setTimeout(async () => {
      settleChecks.delete(routeKey);
      const response = await sendTabMessageBounded(tabId, {
        type: 'monitor-sample-now',
        pathHash,
        routeEpoch: Number(message.routeEpoch) || 0,
        completionId: String(message.completionId || ''),
        cycleNumber: Number.isInteger(message.cycleNumber) ? message.cycleNumber : null,
        settleKey: String(message.settleKey || ''),
      });
      resolve({ ok: true, sampled: response?.sampled === true, stale: response?.stale === true, response });
    }, delayMs);
    settleChecks.set(routeKey, { timerId, resolve });
  });
}

function openChatGPT(tabId) {
  if (Number.isInteger(tabId)) {
    chrome.tabs.update(tabId, { active: true }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        chrome.tabs.create({ url: 'https://chatgpt.com/' });
        return;
      }
      if (Number.isInteger(tab.windowId)) chrome.windows.update(tab.windowId, { focused: true });
    });
    return;
  }
  chrome.tabs.create({ url: 'https://chatgpt.com/' });
}

function openEdgeNotificationSettings() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.create({ url: 'edge://policy' }, () => {
        resolve({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message || '' });
      });
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function ensureDefaultSettings() {
  const stored = await storageGet({});
  await storageSet(notificationAPI.migrateSettings(stored));
}

async function injectExistingChatGPTTabs() {
  try {
    return await tabMonitor.injectExistingTabs();
  } catch (error) {
    console.warn('[TurnBell] existing-tab injection failed', error);
    return { total: 0, active: 0, failed: 0 };
  }
}

async function monitorStatus() {
  let status = await tabMonitor.getStatus();
  if (status.active < status.total) {
    await injectExistingChatGPTTabs();
    status = await tabMonitor.getStatus();
  }
  return {
    ok: true,
    domListener: true,
    finalEvidence: 'action-row-or-explicit-instant-stability',
    privacyMode: 'isolated-world-dom-only',
    nativeExecutableRequired: false,
    ...status,
  };
}

async function removeTabState(tabId) {
  await queueFinalizationMutation(async (store) => {
    for (const key of Object.keys(store)) {
      if (!key.startsWith(`${tabId}:`)) continue;
      const state = finalizationAPI.normalizeState(store[key]);
      if (state?.notified && state.notificationStatus === 'pending') {
        preservePendingNotification(store, state);
      }
      delete store[key];
    }
    return { ok: true };
  });
  clearSettleChecksForTab(tabId);
  await refreshWatchdogAlarm();
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await ensureDefaultSettings();
    await injectExistingChatGPTTabs();
    await ensureWorkerRecovered();
  })().catch((error) => console.warn('[TurnBell] install recovery failed', error));
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await ensureDefaultSettings();
    await injectExistingChatGPTTabs();
    await ensureWorkerRecovered();
  })().catch((error) => console.warn('[TurnBell] startup recovery failed', error));
});

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === WATCHDOG_ALARM) {
    void ensureWorkerRecovered().then(runWatchdogAlarm)
      .catch((error) => console.warn('[TurnBell] watchdog recovery failed', error));
  }
});

chrome.idle?.setDetectionInterval?.(15);
chrome.idle?.onStateChanged?.addListener((state) => {
  void ensureWorkerRecovered()
    .then(() => handleIdleStateChanged(String(state || 'unknown')))
    .catch((error) => console.warn('[TurnBell] idle recovery failed', error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return false;
  const work = (async () => {
    const documentLifecycle = sender?.documentLifecycle;
    if (DOCUMENT_BOUND_MESSAGE_TYPES.has(String(message.type || ''))
      && documentLifecycle !== undefined
      && documentLifecycle !== null
      && String(documentLifecycle) !== ''
      && String(documentLifecycle) !== 'active') {
      return { ok: false, error: 'inactive-document', documentLifecycle: String(documentLifecycle) };
    }
    await ensureWorkerRecovered();
    switch (message.type) {
      case 'turn-start':
        return handleTurnStart(message, sender);
      case 'turn-progress':
        return handleTurnProgress(message, sender);
      case 'route-enter':
        return handleRouteEnter(message, sender);
      case 'turn-move':
        return handleRouteMove(message, sender);
      case 'turn-suspend':
        return handleRouteSuspend(message, sender);
      case 'dom-final-candidate':
        return handleDomCandidate(message, sender);
      case 'schedule-settle-check':
        return scheduleSettleCheck(message, sender);
      case 'lifecycle-event':
        await recordLifecycleDiagnostic(message, sender);
        return { ok: true };
      case 'test-notification': {
        const settings = notificationAPI.normalizeSettings(message.settings || {});
        const context = await resolvedContext(sender?.tab?.id, {
          pageTitle: 'TurnBell 测试',
          url: 'https://chatgpt.com/',
          tabHidden: true,
        });
        const payload = notificationAPI.makeNotificationPayload({
          durationMs: 4_200,
          fingerprint: `test-${Date.now()}`,
        }, context);
        const routes = await routeNotification(payload, settings);
        return { ok: true, payload, routes };
      }
      case 'preview-sound':
        if (notificationAPI.normalizeSettings({ soundTheme: message.theme }).soundTheme === 'system') {
          return { ok: false, reason: 'system-managed' };
        }
        return { ok: await playSound(message.theme, message.volume) };
      case 'notification-permission':
        return {
          ok: true,
          level: await getNotificationPermissionLevel(),
          webSupported: webNotificationSupported(),
          webPermission: String(globalThis.Notification?.permission || 'unknown'),
        };
      case 'notification-diagnostics': {
        const items = await sessionGet({ [LAST_DIAGNOSTIC_KEY]: null, [LIFECYCLE_DIAGNOSTICS_KEY]: [] });
        return {
          ok: true,
          diagnostic: items[LAST_DIAGNOSTIC_KEY],
          lifecycleEvents: Array.isArray(items[LIFECYCLE_DIAGNOSTICS_KEY])
            ? items[LIFECYCLE_DIAGNOSTICS_KEY]
            : [],
        };
      }
      case 'monitor-status':
        return monitorStatus();
      case 'open-chatgpt':
        openChatGPT(sender?.tab?.id);
        return { ok: true };
      case 'open-edge-notification-settings':
        return openEdgeNotificationSettings();
      default:
        return { ok: false, error: 'unknown-message' };
    }
  })();

  work.then(sendResponse, (error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('notificationclick', (event) => {
    const data = event?.notification?.data || {};
    event?.notification?.close?.();
    const work = Promise.resolve().then(async () => {
      const tabId = Number(data.tabId);
      if (data.completionId && ['locked-initial', 'unlock-replay'].includes(String(data.notificationKind || ''))) {
        await acknowledgeLockedReplay(String(data.completionId));
      } else if (data.completionId) {
        await markNotificationDeliveredByCompletion(tabId, String(data.completionId));
      }
      if (Number.isInteger(tabId)) await clearCompletionBadge(tabId);
      openChatGPT(Number.isInteger(tabId) ? tabId : null);
      await recoverWorkerState();
    });
    event?.waitUntil?.(work);
  });

  globalThis.addEventListener('notificationclose', (event) => {
    const data = event?.notification?.data || {};
    const completionId = String(data.completionId || '');
    const tabId = Number(data.tabId);
    let work = Promise.resolve();
    if (completionId && data.notificationKind === 'completion') {
      work = markNotificationDeliveredByCompletion(Number.isInteger(tabId) ? tabId : null, completionId);
    } else if (completionId && data.notificationKind === 'unlock-replay') {
      work = acknowledgeLockedReplay(completionId);
    } else if (completionId && data.notificationKind === 'locked-initial') {
      // The Web Notifications API fires `notificationclose` for a user close;
      // treat it as acknowledgement instead of replaying a dismissed alert.
      work = acknowledgeLockedReplay(completionId);
    }
    event?.waitUntil?.(work.then(() => recoverWorkerState()));
  });
}

function parseLockedNotificationId(notificationId) {
  const match = new RegExp(`^${NOTIFICATION_PREFIX}(\\d+)-lock-([a-z0-9-]+)-(initial|unlock)$`, 'iu')
    .exec(String(notificationId || ''));
  return match
    ? { tabId: Number(match[1]), completionId: match[2], kind: match[3].toLowerCase() }
    : null;
}

chrome.notifications.onClicked.addListener((notificationId) => {
  const locked = parseLockedNotificationId(notificationId);
  const match = new RegExp(`^${NOTIFICATION_PREFIX}(\\d+)-`).exec(notificationId);
  const tabId = locked?.tabId ?? (match ? Number(match[1]) : null);
  void (async () => {
    if (locked) await acknowledgeLockedReplay(locked.completionId);
    else await markNotificationDeliveredById(notificationId);
    if (Number.isInteger(tabId)) await clearCompletionBadge(tabId);
    openChatGPT(tabId);
    await clearNotification(notificationId);
    await recoverWorkerState();
  })().catch((error) => console.warn('[TurnBell] notification-click recovery failed', error));
});

chrome.notifications.onClosed?.addListener((notificationId, byUser) => {
  const locked = parseLockedNotificationId(notificationId);
  void (async () => {
    if (locked?.kind === 'initial' && byUser === true) {
      await acknowledgeLockedReplay(locked.completionId);
    } else if (locked?.kind === 'initial') {
      await retryLockedReplayAfterInitialClose(locked.completionId);
    } else if (locked?.kind === 'unlock' && byUser === true) {
      await acknowledgeLockedReplay(locked.completionId);
    } else if (!locked) {
      await markNotificationDeliveredById(notificationId);
    }
    await recoverWorkerState();
  })().catch((error) => console.warn('[TurnBell] notification-close recovery failed', error));
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void ensureWorkerRecovered().then(() => {
    if (Number.isInteger(activeInfo?.tabId)) return clearCompletionBadge(activeInfo.tabId);
    return false;
  }).catch((error) => console.warn('[TurnBell] tab activation recovery failed', error));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void ensureWorkerRecovered().then(() => removeTabState(tabId))
    .catch((error) => console.warn('[TurnBell] tab removal recovery failed', error));
});
