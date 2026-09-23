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
const LAST_DIAGNOSTIC_KEY = 'turnbellLastNotificationDiagnostic';
const LOCK_REPLAY_STORAGE_KEY = 'turnbellLockedReplayQueueV1';
const LOCK_REPLAY_TTL_MS = 24 * 60 * 60 * 1_000;
const LOCK_REPLAY_QUEUE_LIMIT = 20;
const settleChecks = new Map();
const lockInitialNotificationsInFlight = new Set();
const lockReplayAttemptsInFlight = new Set();
let offscreenCreation = null;
let finalizationStorePromise = null;
let finalizationMutation = Promise.resolve();
let lockReplayMutation = Promise.resolve();
let lockReplayFlush = Promise.resolve();

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

function pruneLockReplayQueue(queue, now = Date.now()) {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const item = queue[index];
    if (!item || Number(item.expiresAt) <= now) queue.splice(index, 1);
  }
  queue.sort((left, right) => Number(left.completedAt) - Number(right.completedAt));
  while (queue.length > LOCK_REPLAY_QUEUE_LIMIT) queue.shift();
}

function mutateLockReplayQueue(updater) {
  const run = lockReplayMutation.then(async () => {
    const items = await sessionGet({ [LOCK_REPLAY_STORAGE_KEY]: [] });
    const queue = Array.isArray(items?.[LOCK_REPLAY_STORAGE_KEY])
      ? items[LOCK_REPLAY_STORAGE_KEY]
      : [];
    pruneLockReplayQueue(queue);
    const result = await updater(queue);
    pruneLockReplayQueue(queue);
    if (!await sessionSet({ [LOCK_REPLAY_STORAGE_KEY]: queue })) {
      throw new Error('locked-replay-store-write-failed');
    }
    return result;
  });
  lockReplayMutation = run.catch(() => undefined);
  return run;
}

function queryIdleState() {
  if (typeof chrome.idle?.queryState !== 'function') return Promise.resolve('unknown');
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

function createLockReplayEntry(tabId, completedAt, payload) {
  const tabPart = Number.isInteger(tabId) ? tabId : 'unknown';
  const token = `${Math.max(0, Math.trunc(Number(completedAt) || Date.now())).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const id = `${tabPart}-${token}`;
  const now = Date.now();
  return {
    id,
    tabId: Number.isInteger(tabId) ? tabId : null,
    completedAt: Math.max(0, Number(completedAt) || now),
    durationMs: Math.max(0, Number(payload.durationMs) || 0),
    // Retain only the already-formatted notification, never the reply body.
    title: payload.title,
    message: payload.message,
    url: notificationAPI.safeChatGPTUrl(payload.url),
    notificationId: `${NOTIFICATION_PREFIX}${tabPart}-unlock-${token}`,
    webTag: `turnbell-lock-${tabPart}-${token}`,
    status: 'initializing',
    createdAt: now,
    lastAttemptAt: 0,
    attempts: 0,
    expiresAt: now + LOCK_REPLAY_TTL_MS,
  };
}

async function enqueueLockReplay(item) {
  return mutateLockReplayQueue((queue) => {
    if (!queue.some((entry) => entry.id === item.id)) queue.push({ ...item });
    return true;
  });
}

async function markLockReplayReady(id) {
  return mutateLockReplayQueue((queue) => {
    const item = queue.find((entry) => entry.id === id);
    if (item?.status === 'initializing') item.status = 'pending';
    return Boolean(item);
  });
}

async function pendingLockReplays() {
  return mutateLockReplayQueue((queue) => {
    for (const item of queue) {
      if (item.status === 'initializing' && !lockInitialNotificationsInFlight.has(item.id)) {
        item.status = 'pending';
      } else if (item.status === 'replaying' && !lockReplayAttemptsInFlight.has(item.id)) {
        item.status = 'pending';
      }
    }
    return queue.filter((item) => item.status === 'pending').map((item) => ({ ...item }));
  });
}

async function claimLockReplay(id) {
  return mutateLockReplayQueue((queue) => {
    const item = queue.find((entry) => entry.id === id);
    if (!item || item.status !== 'pending') return null;
    item.status = 'replaying';
    item.lastAttemptAt = Date.now();
    item.attempts = Math.max(0, Number(item.attempts) || 0) + 1;
    return { ...item };
  });
}

async function finishLockReplay(id, delivered) {
  return mutateLockReplayQueue((queue) => {
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return false;
    if (delivered) queue.splice(index, 1);
    else {
      queue[index].status = 'pending';
      queue[index].lastAttemptAt = 0;
    }
    return true;
  });
}

async function discardLockReplays() {
  return mutateLockReplayQueue((queue) => {
    queue.length = 0;
    return true;
  });
}

async function acknowledgeLockReplay(id) {
  if (!id) return false;
  return mutateLockReplayQueue((queue) => {
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return false;
    queue.splice(index, 1);
    return true;
  });
}

async function acknowledgeLockReplayByNotificationId(notificationId) {
  if (!notificationId) return false;
  return mutateLockReplayQueue((queue) => {
    const index = queue.findIndex((item) => item.notificationId === notificationId);
    if (index < 0) return false;
    queue.splice(index, 1);
    return true;
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
      resolve({});
      return;
    }
    chrome.notifications.getAll((items) => {
      resolve(chrome.runtime.lastError ? {} : items || {});
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

async function clearNotification(notificationId) {
  if (!notificationId || typeof chrome.notifications?.clear !== 'function') return false;
  return new Promise((resolve) => {
    try {
      chrome.notifications.clear(notificationId, (cleared) => resolve(Boolean(cleared)));
    } catch {
      resolve(false);
    }
  });
}

async function closeWebNotification(tag) {
  if (!tag || typeof globalThis.registration?.getNotifications !== 'function') return false;
  try {
    const notifications = await globalThis.registration.getNotifications({ tag });
    if (!Array.isArray(notifications)) return false;
    for (const notification of notifications) notification.close?.();
    return notifications.length > 0;
  } catch {
    return false;
  }
}

async function showBrowserNotification(payload, settings) {
  const permission = await getNotificationPermissionLevel();
  if (permission !== 'granted') {
    return {
      created: false,
      active: false,
      id: null,
      permission,
      diagnostic: 'permission-denied',
      error: 'Browser extension notification permission is denied.',
    };
  }

  const tabPart = Number.isInteger(payload.tabId) ? payload.tabId : 'unknown';
  const notificationId = String(payload.notificationId || `${NOTIFICATION_PREFIX}${tabPart}-${Date.now()}`);
  const result = await new Promise((resolve) => {
    // Chromium routes this extension API to macOS Notification Center on macOS.
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
      resolve({ createdId: error ? null : createdId || notificationId, error });
    });
  });

  if (!result.createdId) {
    return {
      created: false,
      active: false,
      id: null,
      permission,
      diagnostic: 'create-failed',
      error: result.error || 'The browser did not accept the notification.',
    };
  }

  const activeItems = await getActiveNotifications();
  const active = Object.hasOwn(activeItems, result.createdId);
  return {
    created: true,
    active,
    id: result.createdId,
    permission,
    diagnostic: active ? 'accepted-active' : 'accepted-not-active',
    error: '',
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
  const tag = String(payload.webTag
    || `turnbell-web-${Number.isInteger(payload.tabId) ? payload.tabId : 'unknown'}-${Date.now()}`);
  try {
    await registrationObject.showNotification(payload.title, {
      body: payload.message,
      icon: chrome.runtime.getURL('assets/icons/icon-128.png'),
      badge: chrome.runtime.getURL('assets/icons/icon-48.png'),
      tag,
      requireInteraction: settings.persistentNotification,
      silent: notificationAPI.notificationSilent(settings),
      data: { tabId: payload.tabId, url: payload.url, lockReplayId: String(payload.lockReplayId || '') },
    });
    let active = true;
    if (typeof registrationObject.getNotifications === 'function') {
      const notifications = await registrationObject.getNotifications({ tag });
      active = Array.isArray(notifications) ? notifications.length > 0 : true;
    }
    return {
      created: true, active, permission: 'granted', tag,
      diagnostic: active ? 'web-accepted-active' : 'web-accepted-not-active', error: '',
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
  const customSound = notificationAPI.shouldPlayCustomSound(settings);
  const systemSoundRequested = settings.sound && settings.soundTheme === 'system';
  const [browserResult, webResult, soundPlayed, badgeSet] = await Promise.all([
    extensionPromise,
    webPromise,
    customSound ? playSound(settings.soundTheme, settings.soundVolume) : Promise.resolve(false),
    setCompletionBadge(payload.tabId),
  ]);
  const routes = {
    browser: browserResult.created,
    browserActive: browserResult.active,
    notificationId: browserResult.id,
    permission: browserResult.permission,
    diagnostic: browserResult.diagnostic,
    error: browserResult.error,
    web: webResult.created,
    webActive: webResult.active,
    webPermission: webResult.permission,
    webDiagnostic: webResult.diagnostic,
    webError: webResult.error,
    systemSound: systemSoundRequested && (browserResult.created || webResult.created),
    sound: Boolean(soundPlayed),
    badge: Boolean(badgeSet),
  };
  await sessionSet({ [LAST_DIAGNOSTIC_KEY]: { ...routes, at: Date.now() } });
  return routes;
}

async function performLockedReplayFlush() {
  if (await queryIdleState() === 'locked') return { replayed: 0, locked: true };
  const settings = await getSettings();
  if (!settings.enabled) {
    await discardLockReplays();
    return { replayed: 0, disabled: true };
  }

  const items = await pendingLockReplays();
  let replayed = 0;
  for (const snapshot of items) {
    if (await queryIdleState() === 'locked') return { replayed, locked: true };
    const item = await claimLockReplay(snapshot.id);
    if (!item) continue;
    lockReplayAttemptsInFlight.add(item.id);

    let delivered = false;
    try {
      await Promise.all([
        clearNotification(item.notificationId),
        closeWebNotification(item.webTag),
      ]);
      if (await queryIdleState() === 'locked') continue;

      const payload = notificationAPI.makeNotificationPayload({
        durationMs: item.durationMs,
        fingerprint: '',
      }, {
        tabId: item.tabId,
        pageTitle: 'ChatGPT',
        url: notificationAPI.safeChatGPTUrl(item.url),
        tabHidden: true,
      });
      // Older queued entries have no display snapshot; keep their fallback.
      payload.title = item.title || payload.title;
      payload.message = item.message || '锁屏期间有一轮回复完成';
      payload.notificationId = item.notificationId;
      payload.webTag = item.webTag;
      payload.lockReplayId = item.id;
      const routes = await routeNotification(payload, settings);
      delivered = routes.browser || routes.web;
    } catch (error) {
      console.warn('[TurnBell] locked notification replay failed', error);
    } finally {
      lockReplayAttemptsInFlight.delete(item.id);
      try { await finishLockReplay(item.id, delivered); }
      catch (error) { console.warn('[TurnBell] locked replay state update failed', error); }
    }
    if (delivered) replayed += 1;
  }
  return { replayed, locked: false };
}

function flushLockedReplays() {
  const run = lockReplayFlush.then(() => performLockedReplayFlush());
  lockReplayFlush = run.catch(() => undefined);
  return run;
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

async function resolvedContext(tabId, rawContext = {}) {
  const tab = await getTab(tabId);
  const windowObject = tab ? await getWindow(tab.windowId) : null;
  const context = { ...rawContext, tabId };
  if (tab && windowObject) context.tabHidden = !(Boolean(tab.active) && Boolean(windowObject.focused));
  else context.tabHidden = Boolean(rawContext.tabHidden);
  context.pageTitle = String(context.pageTitle || tab?.title || 'ChatGPT');
  context.url = String(context.url || tab?.url || 'https://chatgpt.com/');
  context.hasFinalAction = context.hasFinalAction === true;
  context.fingerprint = String(context.fingerprint || '');
  return context;
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

function mutateFinalization(tabId, updater) {
  const run = finalizationMutation.then(async () => {
    const store = await loadFinalizationStore();
    const key = String(tabId);
    const previous = store[key] || null;
    const result = updater(previous);
    if (result?.state) store[key] = result.state;
    else delete store[key];
    await sessionSet({ [FINALIZATION_STORAGE_KEY]: store });
    return { ...result, previous };
  });
  finalizationMutation = run.catch(() => undefined);
  return run;
}

async function notifyFromFinal(tabId, action, event = {}, rawContext = {}, force = false) {
  const settings = await getSettings();
  const context = await resolvedContext(tabId, rawContext);
  if (!force && !notificationAPI.shouldNotify(settings, context)) {
    return { ok: true, suppressed: true, reason: 'settings' };
  }
  const completedAt = Number(action?.completedAt) || Date.now();
  const startedAt = Math.min(Number(action?.startedAt) || completedAt, completedAt);
  const payload = notificationAPI.makeNotificationPayload({
    durationMs: Math.max(0, completedAt - startedAt),
    fingerprint: String(event.fingerprint || ''),
  }, context);

  let lockReplay = null;
  if (await queryIdleState() === 'locked') {
    lockReplay = createLockReplayEntry(tabId, completedAt, payload);
    lockInitialNotificationsInFlight.add(lockReplay.id);
    try {
      await enqueueLockReplay(lockReplay);
      payload.notificationId = lockReplay.notificationId;
      payload.webTag = lockReplay.webTag;
      payload.lockReplayId = lockReplay.id;
    } catch (error) {
      lockInitialNotificationsInFlight.delete(lockReplay.id);
      lockReplay = null;
      console.warn('[TurnBell] could not queue locked notification replay', error);
    }
  }

  try {
    const routes = await routeNotification(payload, settings);
    return { ok: true, payload, routes };
  } finally {
    if (lockReplay) {
      try { await markLockReplayReady(lockReplay.id); }
      catch (error) { console.warn('[TurnBell] could not ready locked notification replay', error); }
      lockInitialNotificationsInFlight.delete(lockReplay.id);
      try {
        if (await queryIdleState() !== 'locked') await flushLockedReplays();
      } catch (error) {
        console.warn('[TurnBell] could not replay unlocked notification', error);
      }
    }
  }
}

async function handleTurnStart(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false, error: 'missing-tab' };
  const result = await mutateFinalization(tabId, (state) => finalizationAPI.beginTurn(state, {
    tabId,
    at: Number(message.at) || Date.now(),
    turnKey: String(message.turnKey || ''),
    userCount: Number(message.userCount) || 0,
    source: String(message.source || 'implicit'),
  }));
  return { ok: true, action: result.action.type, reason: result.action.reason || '' };
}

async function handleDomCandidate(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false, error: 'missing-tab' };
  const event = message?.payload?.event || {};
  const context = message?.payload?.context || {};
  const hasFinalAction = event.hasFinalAction === true || context.hasFinalAction === true;
  const result = await mutateFinalization(tabId, (state) => finalizationAPI.acceptDomCandidate(state, {
    tabId,
    at: Number(event.completedAt) || Number(message.at) || Date.now(),
    startedAt: Number(event.startedAt) || 0,
    turnKey: String(message.turnKey || context.turnKey || ''),
    userCount: Number(context.userCount) || 0,
    hasFinalAction,
    finalEvidence: String(event.finalEvidence || (hasFinalAction ? 'final-action' : '')),
    fingerprint: String(event.fingerprint || context.fingerprint || ''),
  }));

  if (result.action.type !== 'notify') {
    return { ok: true, suppressed: true, reason: result.action.reason || 'not-final' };
  }
  return notifyFromFinal(tabId, result.action, event, context);
}

function scheduleSettleCheck(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return Promise.resolve({ ok: false, error: 'missing-tab' });
  const previous = settleChecks.get(tabId);
  if (previous) {
    clearTimeout(previous.timerId);
    previous.resolve({ ok: true, cancelled: true, reason: 'superseded' });
    settleChecks.delete(tabId);
  }

  const rawDelay = Number(message.delayMs);
  const delayMs = Number.isFinite(rawDelay) ? Math.min(10_000, Math.max(200, Math.round(rawDelay))) : 1_200;
  return new Promise((resolve) => {
    const timerId = setTimeout(async () => {
      settleChecks.delete(tabId);
      const response = await sendTabMessage(tabId, {
        type: 'monitor-sample-now',
        cycleNumber: Number.isInteger(message.cycleNumber) ? message.cycleNumber : null,
        settleKey: String(message.settleKey || ''),
      });
      resolve({ ok: true, sampled: Boolean(response?.ok), response });
    }, delayMs);
    settleChecks.set(tabId, { timerId, resolve });
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

function browserNotificationSettingsUrl() {
  const userAgent = String(globalThis.navigator?.userAgent || '');
  return /\bEdg\//u.test(userAgent)
    ? 'edge://settings/content/notifications'
    : 'chrome://settings/content/notifications';
}

function openBrowserNotificationSettings() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.create({ url: browserNotificationSettingsUrl() }, () => {
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
    finalEvidence: 'action-row-or-explicit-stability',
    privacyMode: 'isolated-world-dom-only',
    nativeExecutableRequired: false,
    ...status,
  };
}

async function removeTabState(tabId) {
  await mutateFinalization(tabId, () => ({ state: null, action: { type: 'removed' } }));
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await ensureDefaultSettings();
    await injectExistingChatGPTTabs();
    await flushLockedReplays();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await ensureDefaultSettings();
    await injectExistingChatGPTTabs();
    await flushLockedReplays();
  })();
});

try { chrome.idle?.setDetectionInterval?.(15); } catch { /* optional in older Chromium builds */ }
chrome.idle?.onStateChanged?.addListener((state) => {
  if (String(state) === 'locked') return;
  void flushLockedReplays().catch((error) => {
    console.warn('[TurnBell] unlocked notification replay failed', error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return false;
  const work = (async () => {
    switch (message.type) {
      case 'turn-start':
        return handleTurnStart(message, sender);
      case 'dom-final-candidate':
        return handleDomCandidate(message, sender);
      case 'schedule-settle-check':
        return scheduleSettleCheck(message, sender);
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
        const items = await sessionGet({ [LAST_DIAGNOSTIC_KEY]: null });
        return { ok: true, diagnostic: items[LAST_DIAGNOSTIC_KEY] };
      }
      case 'monitor-status':
        return monitorStatus();
      case 'open-chatgpt':
        openChatGPT(sender?.tab?.id);
        return { ok: true };
      case 'open-browser-notification-settings':
        return openBrowserNotificationSettings();
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
      if (data.lockReplayId) await acknowledgeLockReplay(String(data.lockReplayId));
      const tabId = Number(data.tabId);
      if (Number.isInteger(tabId)) void clearCompletionBadge(tabId);
      openChatGPT(Number.isInteger(tabId) ? tabId : null);
    });
    event?.waitUntil?.(work);
  });
}

chrome.notifications.onClicked.addListener((notificationId) => {
  const match = new RegExp(`^${NOTIFICATION_PREFIX}(\\d+)-`).exec(notificationId);
  const tabId = match ? Number(match[1]) : null;
  void (async () => {
    await acknowledgeLockReplayByNotificationId(notificationId);
    if (Number.isInteger(tabId)) void clearCompletionBadge(tabId);
    openChatGPT(tabId);
    await clearNotification(notificationId);
  })();
});

chrome.notifications.onClosed?.addListener((notificationId, byUser) => {
  if (byUser === true) {
    void acknowledgeLockReplayByNotificationId(notificationId);
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (Number.isInteger(activeInfo?.tabId)) void clearCompletionBadge(activeInfo.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const pending = settleChecks.get(tabId);
  if (pending) {
    clearTimeout(pending.timerId);
    pending.resolve({ ok: false, cancelled: true, reason: 'tab-removed' });
    settleChecks.delete(tabId);
  }
  void removeTabState(tabId);
});
