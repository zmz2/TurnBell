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
const settleChecks = new Map();
let offscreenCreation = null;
let finalizationStorePromise = null;
let finalizationMutation = Promise.resolve();

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

async function showBrowserNotification(payload, settings) {
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

  const tabPart = Number.isInteger(payload.tabId) ? payload.tabId : 'unknown';
  const notificationId = `${NOTIFICATION_PREFIX}${tabPart}-${Date.now()}`;
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
      error: result.error || 'Edge did not accept the notification.',
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
  const tag = `turnbell-web-${Number.isInteger(payload.tabId) ? payload.tabId : 'unknown'}-${Date.now()}`;
  try {
    await registrationObject.showNotification(payload.title, {
      body: payload.message,
      icon: chrome.runtime.getURL('assets/icons/icon-128.png'),
      badge: chrome.runtime.getURL('assets/icons/icon-48.png'),
      tag,
      requireInteraction: settings.persistentNotification,
      silent: notificationAPI.notificationSilent(settings),
      data: { tabId: payload.tabId, url: payload.url },
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
  const routes = await routeNotification(payload, settings);
  return { ok: true, payload, routes };
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
  await mutateFinalization(tabId, () => ({ state: null, action: { type: 'removed' } }));
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => { await ensureDefaultSettings(); await injectExistingChatGPTTabs(); })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => { await ensureDefaultSettings(); await injectExistingChatGPTTabs(); })();
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
    const work = Promise.resolve().then(() => {
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
  if (Number.isInteger(tabId)) void clearCompletionBadge(tabId);
  openChatGPT(tabId);
  chrome.notifications.clear(notificationId);
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
