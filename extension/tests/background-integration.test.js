'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const srcRoot = path.resolve(__dirname, '../src');

function nextTurn() { return new Promise((resolve) => setImmediate(resolve)); }
async function flushTurns(count = 5) { for (let i = 0; i < count; i += 1) await nextTurn(); }

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    dispatch(...args) { return listeners.map((listener) => listener(...args)); },
    get listener() { return listeners[0]; },
  };
}

function createHarness(settingsOverrides = {}, environmentOverrides = {}) {
  let clock = Number(environmentOverrides.now) || 10_000;
  let nextTimerId = 1;
  const timers = new Map();
  const notifications = [];
  const deferredNotificationCreates = [];
  const activeNotifications = environmentOverrides.activeNotifications || {};
  const localStore = environmentOverrides.localStore || {};
  const alarmsStore = environmentOverrides.alarmsStore || {};
  const badgeCalls = [];
  const soundMessages = [];
  const tabMessages = [];
  const createdTabs = [];
  const webNotifications = [];
  const syncStore = {
    enabled: true,
    notificationMode: 'browser',
    sound: true,
    soundVolume: 0.55,
    soundTheme: 'system',
    soundBehaviorVersion: 2,
    persistentNotification: true,
    backgroundOnly: false,
    quietPeriodMs: 1_200,
    minGenerationMs: 0,
    debug: false,
    ...settingsOverrides,
  };
  const sessionStore = environmentOverrides.sessionStore || {};
  const globalEventListeners = new Map();
  let failedNotificationCreates = Math.max(0, Number(environmentOverrides.failedNotificationCreates) || 0);
  let failedNotificationQueries = Math.max(0, Number(environmentOverrides.failedNotificationQueries) || 0);
  let failedWebNotificationQueries = Math.max(0, Number(environmentOverrides.failedWebNotificationQueries) || 0);
  let failedSessionWrites = Math.max(0, Number(environmentOverrides.failedSessionWrites) || 0);
  let closeDuringNextGetAll = '';
  const tabActive = environmentOverrides.tabActive ?? false;
  const windowFocused = environmentOverrides.windowFocused ?? true;
  let idleState = environmentOverrides.idleState || 'active';

  const events = {
    onInstalled: createEvent(), onStartup: createEvent(), onMessage: createEvent(),
    onClicked: createEvent(), onClosed: createEvent(), onRemoved: createEvent(),
    onActivated: createEvent(), onBeforeRequest: createEvent(), onCompleted: createEvent(),
    onErrorOccurred: createEvent(), onAlarm: createEvent(),
    onIdleStateChanged: createEvent(),
  };

  const runtime = {
    id: 'background-test', lastError: null,
    getURL(value) { return `chrome-extension://background-test/${value}`; },
    async sendMessage(message) { soundMessages.push(message); return { ok: true }; },
    onInstalled: events.onInstalled, onStartup: events.onStartup, onMessage: events.onMessage,
  };

  const chrome = {
    runtime,
    storage: {
      sync: {
        get(defaults, callback) { callback({ ...(defaults || {}), ...syncStore }); },
        set(items, callback) { Object.assign(syncStore, items); callback?.(); },
      },
      session: {
        get(defaults, callback) {
          const result = {};
          for (const [key, fallback] of Object.entries(defaults || {})) {
            result[key] = Object.hasOwn(sessionStore, key) ? sessionStore[key] : fallback;
          }
          callback(result);
        },
        set(items, callback) {
          if (failedSessionWrites > 0) {
            failedSessionWrites -= 1;
            runtime.lastError = { message: 'test-session-write-failed' };
            callback?.();
            runtime.lastError = null;
            return;
          }
          Object.assign(sessionStore, items);
          callback?.();
        },
        remove(keys, callback) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionStore[key];
          callback?.();
        },
      },
      local: {
        get(defaults, callback) {
          const result = {};
          for (const [key, fallback] of Object.entries(defaults || {})) {
            result[key] = Object.hasOwn(localStore, key) ? localStore[key] : fallback;
          }
          callback(result);
        },
        set(items, callback) { Object.assign(localStore, items); callback?.(); },
      },
    },
    offscreen: {
      hasDocument() { return Promise.resolve(false); },
      createDocument() { return Promise.resolve(); },
    },
    notifications: {
      getPermissionLevel(callback) { callback(environmentOverrides.permission || 'granted'); },
      create(id, options, callback) {
        notifications.push({ id, options });
        const finish = () => {
          if (failedNotificationCreates > 0) {
            failedNotificationCreates -= 1;
            runtime.lastError = { message: 'test-create-failed' };
            callback(id);
            runtime.lastError = null;
            return;
          }
          activeNotifications[id] = options;
          callback(id);
        };
        if (environmentOverrides.deferNotificationCreate === true) {
          deferredNotificationCreates.push(finish);
        } else {
          finish();
        }
      },
      getAll(callback) {
        const snapshot = { ...activeNotifications };
        if (failedNotificationQueries > 0) {
          failedNotificationQueries -= 1;
          runtime.lastError = { message: 'test-notification-query-failed' };
          callback({});
          runtime.lastError = null;
        } else {
          callback(snapshot);
        }
        if (closeDuringNextGetAll) {
          const id = closeDuringNextGetAll;
          closeDuringNextGetAll = '';
          delete activeNotifications[id];
          events.onClosed.dispatch(id, false);
        }
      },
      clear(id, callback) { const existed = Boolean(activeNotifications[id]); delete activeNotifications[id]; callback?.(existed); },
      onClicked: events.onClicked,
      onClosed: events.onClosed,
    },
    action: {
      setBadgeText(details) { badgeCalls.push({ type: 'text', ...details }); return Promise.resolve(); },
      setBadgeBackgroundColor(details) { badgeCalls.push({ type: 'color', ...details }); return Promise.resolve(); },
      setTitle(details) { badgeCalls.push({ type: 'title', ...details }); return Promise.resolve(); },
    },
    tabs: {
      query(_query, callback) { callback([]); },
      sendMessage(tabId, message, callback) {
        tabMessages.push({ tabId, message });
        callback?.({ ok: true, active: true, sampled: true });
      },
      get(tabId, callback) {
        callback({ id: tabId, title: 'Background research - ChatGPT', url: 'https://chatgpt.com/c/background', active: tabActive, windowId: 7 });
      },
      update(_tabId, _properties, callback) { callback?.({ id: 42, windowId: 7 }); },
      create(details, callback) { createdTabs.push(details); callback?.({ id: 99, ...details }); },
      onRemoved: events.onRemoved,
      onActivated: events.onActivated,
    },
    windows: {
      get(_windowId, callback) { callback({ id: 7, focused: windowFocused }); },
      update() {},
    },
    scripting: { executeScript(_details, callback) { callback([]); } },
    // Old-build stubs keep the red test focused on behavior rather than setup errors.
    webRequest: { onBeforeRequest: events.onBeforeRequest, onCompleted: events.onCompleted, onErrorOccurred: events.onErrorOccurred },
    alarms: {
      onAlarm: events.onAlarm,
      create(name, info) { alarmsStore[name] = { name, ...info }; },
      clear(name) { const existed = Boolean(alarmsStore[name]); delete alarmsStore[name]; return Promise.resolve(existed); },
      getAll(callback) { callback(Object.values(alarmsStore)); },
    },
    idle: {
      setDetectionInterval() {},
      queryState(_threshold, callback) { callback(idleState); },
      onStateChanged: events.onIdleStateChanged,
    },
  };

  class FakeDate extends Date { static now() { return clock; } }
  const context = {
    chrome, console, URL, Map, Set, Promise, Object, Number, String, Boolean, RegExp, Math, Date: FakeDate,
    registration: {
      async showNotification(title, options) {
        for (const item of webNotifications) {
          if (item.options.tag === options.tag) item.closed = true;
        }
        webNotifications.push({ title, options, closed: false, close() { this.closed = true; } });
      },
      async getNotifications({ tag } = {}) {
        if (failedWebNotificationQueries > 0) {
          failedWebNotificationQueries -= 1;
          throw new Error('test-web-notification-query-failed');
        }
        return webNotifications.filter((item) => !item.closed && (!tag || item.options.tag === tag));
      },
    },
    addEventListener(type, listener) {
      if (!globalEventListeners.has(type)) globalEventListeners.set(type, []);
      globalEventListeners.get(type).push(listener);
    },
    clients: { matchAll() { return Promise.resolve([]); } },
    setTimeout(callback, delay = 0) {
      const id = nextTimerId++;
      timers.set(id, { callback, at: clock + Number(delay || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  context.globalThis = context;
  vm.createContext(context);
  context.importScripts = (...names) => {
    for (const name of names) {
      const source = fs.readFileSync(path.join(srcRoot, name), 'utf8');
      vm.runInContext(source, context, { filename: name });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(srcRoot, 'background.js'), 'utf8'), context, { filename: 'background.js' });

  return {
    activeNotificationIds() { return Object.keys(activeNotifications); },
    async completeNextNotificationCreate() {
      const complete = deferredNotificationCreates.shift();
      if (!complete) return false;
      complete();
      await flushTurns(12);
      return true;
    },
    alarmsStore, badgeCalls, createdTabs, events, localStore, notifications, sessionStore, soundMessages, tabMessages, webNotifications,
    setClock(value) { clock = value; },
    setFailedNotificationCreates(value) { failedNotificationCreates = Math.max(0, Number(value) || 0); },
    setFailedNotificationQueries(value) { failedNotificationQueries = Math.max(0, Number(value) || 0); },
    setFailedWebNotificationQueries(value) { failedWebNotificationQueries = Math.max(0, Number(value) || 0); },
    setFailedSessionWrites(value) { failedSessionWrites = Math.max(0, Number(value) || 0); },
    closeOnNextGetAll(id) { closeDuringNextGetAll = String(id || ''); },
    async setIdleState(value) {
      idleState = value;
      events.onIdleStateChanged.dispatch(value);
      await flushTurns(12);
    },
    async closeNotification(id, byUser = false) {
      delete activeNotifications[id];
      events.onClosed.dispatch(id, byUser);
      await flushTurns(12);
    },
    async dispatchGlobalNotificationEvent(type, notificationData) {
      const waits = [];
      for (const listener of globalEventListeners.get(type) || []) {
        listener({ notification: { data: notificationData, close() {} }, waitUntil(promise) { waits.push(promise); } });
      }
      await Promise.all(waits);
      await flushTurns(12);
    },
    async flush() { await flushTurns(12); },
    async runNextTimer() {
      const entry = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) return false;
      const [id, timer] = entry;
      timers.delete(id);
      clock = Math.max(clock, timer.at);
      timer.callback();
      await flushTurns();
      return true;
    },
    sendRuntimeMessage(message, sender = { tab: { id: 42 }, documentId: 'document-1' }) {
      return new Promise((resolve, reject) => {
        const listener = events.onMessage.listener;
        if (!listener) { reject(new Error('missing runtime listener')); return; }
        let settled = false;
        const sendResponse = (value) => { if (!settled) { settled = true; resolve(value); } };
        try {
          const keepOpen = listener(message, sender, sendResponse);
          if (keepOpen !== true && !settled) resolve(undefined);
        } catch (error) { reject(error); }
      });
    },
  };
}

const PATH_A = 'a'.repeat(32);
const PATH_B = 'b'.repeat(32);

function turnStart(completionId = 'completion-1', overrides = {}) {
  return {
    type: 'turn-start',
    completionId,
    pathHash: overrides.pathHash || PATH_A,
    routeEpoch: overrides.routeEpoch ?? 1,
    startedAt: overrides.startedAt ?? 10_000,
    userCount: overrides.userCount ?? 1,
    assistantCount: overrides.assistantCount ?? 0,
    source: overrides.source || 'explicit',
    at: overrides.at ?? 10_000,
  };
}

function domCandidate(completionId = 'completion-1', overrides = {}) {
  return {
    type: 'dom-final-candidate',
    completionId,
    pathHash: overrides.pathHash || PATH_A,
    routeEpoch: overrides.routeEpoch ?? 1,
    payload: {
      event: {
        type: 'complete', durationMs: 3_200, startedAt: 10_000, completedAt: 13_200,
        hasFinalAction: true, finalEvidence: 'final-action',
        replyText: 'must never enter persistent storage or a notification',
        fingerprint: 'private-fingerprint',
        ...(overrides.event || {}),
      },
      context: {
        pageTitle: 'Background research - ChatGPT',
        url: 'https://chatgpt.com/c/background', tabHidden: true,
        hasFinalAction: true,
        fingerprint: 'private-fingerprint',
        ...(overrides.context || {}),
      },
    },
  };
}

function turnMove(completionId, fromPathHash, pathHash, routeMoveEvidence = 'shared-user-turn-node') {
  return {
    type: 'turn-move',
    completionId,
    fromPathHash,
    pathHash,
    routeEpoch: 2,
    routeMoveEvidence,
  };
}

test('a final DOM turn uses the Windows default notification sound and sets a badge', async () => {
  const h = createHarness();
  await h.sendRuntimeMessage(turnStart());
  const response = await h.sendRuntimeMessage(domCandidate());

  assert.equal(response.ok, true);
  assert.equal(h.notifications.length, 1);
  const options = h.notifications[0].options;
  assert.equal(options.title, 'TurnBell · 回复完成');
  assert.equal(options.message.includes('must never enter'), false);
  assert.equal(JSON.stringify(h.sessionStore).includes('private-fingerprint'), false);
  assert.equal(JSON.stringify(h.sessionStore).includes('must never enter'), false);
  assert.equal(options.priority, 2);
  assert.equal(options.requireInteraction, true);
  assert.equal(options.silent, false);
  assert.match(options.iconUrl, /^chrome-extension:\/\//u);
  assert.equal(response.routes.browser, true);
  assert.equal(response.routes.browserActive, true);
  assert.equal(response.routes.diagnostic, 'accepted-active');
  assert.equal(response.routes.systemSound, true);
  assert.equal(h.soundMessages.some((item) => item.type === 'play-sound'), false);
  assert.equal(h.badgeCalls.some((item) => item.type === 'text' && item.tabId === 42 && item.text === '✓'), true);
});

test('a selected custom theme mutes the Windows notification sound and plays only the local audio', async () => {
  const h = createHarness({ sound: true, soundTheme: 'glass' });
  await h.sendRuntimeMessage(turnStart('completion-custom'));
  const response = await h.sendRuntimeMessage(domCandidate('completion-custom'));

  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].options.silent, true);
  assert.equal(response.routes.systemSound, false);
  assert.equal(response.routes.sound, true);
  assert.equal(h.soundMessages.some((item) => item.type === 'play-sound' && item.theme === 'glass'), true);
});

test('failed notification creation remains in the outbox and retries after a worker restart', async () => {
  const sessionStore = {};
  const activeNotifications = {};
  const alarmsStore = {};
  const localStore = {};
  const firstWorker = createHarness({ sound: false }, {
    sessionStore, activeNotifications, alarmsStore, localStore, failedNotificationCreates: 1,
  });
  await firstWorker.sendRuntimeMessage(turnStart('retry-after-restart'));
  const firstAttempt = await firstWorker.sendRuntimeMessage(domCandidate('retry-after-restart'));

  assert.equal(firstAttempt.ok, true);
  assert.equal(firstAttempt.notificationStatus, 'pending');
  assert.equal(firstWorker.notifications.length, 1);
  assert.equal(alarmsStore['turnbell-active-turn-watchdog']?.periodInMinutes, 1);
  const saved = Object.values(sessionStore.turnbellFinalizationV2)[0];
  assert.equal(saved.notificationStatus, 'pending');
  assert.equal(saved.notificationAttempts, 1);
  assert.ok(saved.notificationRetryAt > 10_000);
  assert.equal(JSON.stringify(sessionStore).includes('Private conversation title'), false);

  const restartedWorker = createHarness({ sound: false }, {
    sessionStore, activeNotifications, alarmsStore, localStore, now: saved.notificationRetryAt + 1,
  });
  await restartedWorker.sendRuntimeMessage({ type: 'monitor-status' }, {});

  assert.equal(restartedWorker.notifications.length, 1);
  assert.equal(restartedWorker.notifications[0].id, 'turnbell-42-completion-retry-after-restart');
  assert.deepEqual(restartedWorker.activeNotificationIds(), ['turnbell-42-completion-retry-after-restart']);
  assert.equal(Object.values(sessionStore.turnbellFinalizationV2)[0].notificationStatus, 'delivered');
  assert.equal(Object.hasOwn(alarmsStore, 'turnbell-active-turn-watchdog'), false);
});

test('a notification retry uses a generic title instead of the tab currently occupying its route', async () => {
  const h = createHarness({ sound: false }, { failedNotificationCreates: 1 });
  await h.sendRuntimeMessage(turnStart('generic-retry-title'));
  const firstAttempt = await h.sendRuntimeMessage(domCandidate('generic-retry-title', {
    context: {
      pageTitle: 'Conversation A private title',
      url: 'https://chatgpt.com/c/conversation-a',
    },
  }));
  assert.equal(firstAttempt.notificationStatus, 'pending');

  h.setClock(80_000);
  h.events.onAlarm.dispatch({ name: 'turnbell-active-turn-watchdog' });
  await h.flush();

  assert.equal(h.notifications.length, 2);
  assert.equal(h.notifications[1].options.message, '这一轮回复已全部完成');
  assert.equal(h.notifications[1].options.message.includes('Background research'), false);
  assert.equal(h.notifications[1].options.message.includes('Conversation A'), false);
});

test('notification-close wakes recovery of other pending outbox entries', async () => {
  const h = createHarness({ sound: false }, { failedNotificationCreates: 1 });
  await h.sendRuntimeMessage(turnStart('notification-event-wake'));
  const firstAttempt = await h.sendRuntimeMessage(domCandidate('notification-event-wake'));
  assert.equal(firstAttempt.notificationStatus, 'pending');
  h.setClock(80_000);

  h.events.onClosed.dispatch('turnbell-999-completion-unrelated', false);
  await h.flush();

  assert.equal(h.notifications.length, 2);
  assert.deepEqual(h.activeNotificationIds(), ['turnbell-42-completion-notification-event-wake']);
});

test('a pending completion survives a new turn on the same route', async () => {
  const h = createHarness({ sound: false }, { failedNotificationCreates: 1 });
  await h.sendRuntimeMessage(turnStart('same-route-first'));
  const firstAttempt = await h.sendRuntimeMessage(domCandidate('same-route-first'));
  assert.equal(firstAttempt.notificationStatus, 'pending');

  await h.sendRuntimeMessage(turnStart('same-route-second', {
    at: 20_000, startedAt: 20_000, userCount: 2, assistantCount: 1,
  }));
  const entries = Object.entries(h.sessionStore.turnbellFinalizationV2);
  const savedFirst = entries.find(([, state]) => state.completionId === 'same-route-first');
  const savedSecond = entries.find(([, state]) => state.completionId === 'same-route-second');
  assert.ok(savedFirst?.[0].startsWith('notification-outbox:'));
  assert.equal(savedFirst[1].notificationStatus, 'pending');
  assert.ok(savedSecond?.[0].startsWith(`42:${PATH_A}`));
  assert.equal(savedSecond[1].notified, false);

  h.setClock(80_000);
  h.events.onAlarm.dispatch({ name: 'turnbell-active-turn-watchdog' });
  await h.flush();

  assert.deepEqual(h.activeNotificationIds(), ['turnbell-42-completion-same-route-first']);
  assert.equal(h.notifications.filter((item) => item.id === 'turnbell-42-completion-same-route-first').length, 2);
  assert.equal(Object.values(h.sessionStore.turnbellFinalizationV2)
    .some((state) => state.completionId === 'same-route-first' && state.notificationStatus === 'pending'), false);
});

test('a pending completion is retained when its originating tab closes', async () => {
  const h = createHarness({ sound: false }, { failedNotificationCreates: 1 });
  await h.sendRuntimeMessage(turnStart('closed-tab-pending'));
  const firstAttempt = await h.sendRuntimeMessage(domCandidate('closed-tab-pending'));
  assert.equal(firstAttempt.notificationStatus, 'pending');

  h.events.onRemoved.dispatch(42);
  await h.flush();
  const outboxEntry = Object.entries(h.sessionStore.turnbellFinalizationV2)
    .find(([key, state]) => key.startsWith('notification-outbox:')
      && state.completionId === 'closed-tab-pending');
  assert.ok(outboxEntry);

  h.setClock(80_000);
  h.events.onAlarm.dispatch({ name: 'turnbell-active-turn-watchdog' });
  await h.flush();

  assert.deepEqual(h.activeNotificationIds(), ['turnbell-42-completion-closed-tab-pending']);
});

test('route movement cannot overwrite an existing conversation completion', async () => {
  const h = createHarness({ sound: false });
  await h.sendRuntimeMessage(turnStart('destination-b', { pathHash: PATH_B }));
  const destination = await h.sendRuntimeMessage(domCandidate('destination-b', { pathHash: PATH_B }));
  assert.equal(destination.notificationStatus, 'delivered');
  await h.sendRuntimeMessage(turnStart('placeholder-a', { pathHash: PATH_A }));

  const unverified = await h.sendRuntimeMessage(turnMove('placeholder-a', PATH_A, PATH_B, ''));
  assert.equal(unverified.ok, false);
  assert.equal(unverified.reason, 'unverified-route-move');

  const rejected = await h.sendRuntimeMessage(turnMove('placeholder-a', PATH_A, PATH_B));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'destination-owned');
  assert.equal(h.sessionStore.turnbellFinalizationV2[`42:${PATH_B}`].completionId, 'destination-b');
  assert.equal(h.sessionStore.turnbellFinalizationV2[`42:${PATH_A}`].completionId, 'placeholder-a');
  const destinationEnter = await h.sendRuntimeMessage({
    type: 'route-enter', pathHash: PATH_B, routeEpoch: 3,
  });
  assert.equal(destinationEnter.previouslyCompleted, true);
  assert.equal(destinationEnter.pending, null);

  const staleCandidate = await h.sendRuntimeMessage(domCandidate('placeholder-a', { pathHash: PATH_B }));
  assert.equal(staleCandidate.suppressed, true);
  assert.equal(h.notifications.length, 1);
});

test('a failed session write does not leak an unpersisted completion into the worker cache', async () => {
  const h = createHarness({ sound: false });
  await h.sendRuntimeMessage(turnStart('persisted-turn'));
  await h.flush();
  h.setFailedSessionWrites(1);

  const failedStart = await h.sendRuntimeMessage(turnStart('unpersisted-turn'));
  assert.equal(failedStart.ok, false, JSON.stringify(failedStart));
  assert.equal(h.sessionStore.turnbellFinalizationV2[`42:${PATH_A}`].completionId, 'persisted-turn');

  const candidate = await h.sendRuntimeMessage(domCandidate('unpersisted-turn'));
  assert.equal(candidate.suppressed, true);
  assert.equal(candidate.reason, 'completion-mismatch');
  assert.equal(h.notifications.length, 0);
  assert.equal(h.sessionStore.turnbellFinalizationV2[`42:${PATH_A}`].completionId, 'persisted-turn');
});

test('a cached document cannot rebind an active completion to its document id', async () => {
  const h = createHarness({ sound: false });
  const activeSender = { tab: { id: 42 }, documentId: 'active-document', documentLifecycle: 'active' };
  const cachedSender = { tab: { id: 42 }, documentId: 'cached-document', documentLifecycle: 'cached' };
  await h.sendRuntimeMessage(turnStart('lifecycle-bound'), activeSender);

  const staleEnter = await h.sendRuntimeMessage({
    type: 'route-enter', pathHash: PATH_A, routeEpoch: 2,
  }, cachedSender);
  assert.equal(staleEnter.ok, false);
  assert.equal(staleEnter.error, 'inactive-document');
  assert.equal(h.sessionStore.turnbellFinalizationV2[`42:${PATH_A}`].documentId, 'active-document');

  const staleCandidate = await h.sendRuntimeMessage(domCandidate('lifecycle-bound'), cachedSender);
  assert.equal(staleCandidate.ok, false);
  assert.equal(staleCandidate.error, 'inactive-document');
  assert.equal(h.notifications.length, 0);
  const activeCandidate = await h.sendRuntimeMessage(domCandidate('lifecycle-bound'), activeSender);
  assert.equal(activeCandidate.notificationStatus, 'delivered');
});

test('a notification created just before worker death is detected without recreating or chiming', async () => {
  const sessionStore = {};
  const activeNotifications = {};
  const firstWorker = createHarness({ sound: false }, { sessionStore, activeNotifications });
  await firstWorker.sendRuntimeMessage(turnStart('created-before-restart'));
  await firstWorker.sendRuntimeMessage(domCandidate('created-before-restart'));
  const notificationId = firstWorker.notifications[0].id;
  const stored = Object.values(sessionStore.turnbellFinalizationV2)[0];
  // Recreate the exact crash window: the OS accepted the alert but the status
  // write that follows it did not reach session storage.
  stored.notificationStatus = 'pending';
  stored.notificationAttempts = 1;
  stored.notificationRetryAt = 0;

  const restartedWorker = createHarness({ sound: false }, {
    sessionStore, activeNotifications, now: 80_000,
  });
  await restartedWorker.sendRuntimeMessage({ type: 'monitor-status' }, {});

  assert.equal(restartedWorker.notifications.length, 0);
  assert.deepEqual(restartedWorker.activeNotificationIds(), [notificationId]);
  assert.equal(Object.values(sessionStore.turnbellFinalizationV2)[0].notificationStatus, 'delivered');
  assert.equal(restartedWorker.soundMessages.some((message) => message.type === 'play-sound'), false);
});

test('ordinary worker startup restores the active-turn watchdog without startup events', async () => {
  const sessionStore = {};
  const alarmsStore = {};
  const firstWorker = createHarness({ sound: false }, { sessionStore, alarmsStore });
  await firstWorker.sendRuntimeMessage(turnStart('worker-recovery-turn'));
  assert.equal(alarmsStore['turnbell-active-turn-watchdog']?.periodInMinutes, 1);
  delete alarmsStore['turnbell-active-turn-watchdog'];

  const restartedWorker = createHarness({ sound: false }, { sessionStore, alarmsStore });
  await restartedWorker.sendRuntimeMessage({ type: 'monitor-status' }, {});

  assert.equal(alarmsStore['turnbell-active-turn-watchdog']?.periodInMinutes, 1);
});

test('watchdog alarms sample active turns on their original tab and route', async () => {
  const h = createHarness({ sound: false });
  await h.sendRuntimeMessage(turnStart('watchdog-sample'));
  h.events.onAlarm.dispatch({ name: 'turnbell-active-turn-watchdog' });
  await h.flush();

  const sample = h.tabMessages.find((item) => item.message.reason === 'watchdog');
  assert.equal(sample?.tabId, 42);
  assert.equal(sample?.message.type, 'monitor-sample-now');
  assert.equal(sample?.message.pathHash, PATH_A);
  assert.equal(sample?.message.completionId, 'watchdog-sample');
  assert.equal(sample?.message.routeEpoch, 1);
});

test('duplicate evidence is suppressed and a new completion id starts a fresh ledger entry', async () => {
  const h = createHarness({ sound: false });
  await h.sendRuntimeMessage(turnStart());
  await h.sendRuntimeMessage(domCandidate());
  const duplicate = await h.sendRuntimeMessage(domCandidate());
  await h.sendRuntimeMessage(turnStart('completion-2', { userCount: 2, at: 16_800 }));
  const next = await h.sendRuntimeMessage(domCandidate('completion-2', {
    event: { startedAt: 16_800, completedAt: 20_000 },
    context: { userCount: 2 },
  }));

  assert.equal(duplicate.suppressed, true);
  assert.equal(duplicate.reason, 'already-notified');
  assert.equal(next.ok, true);
  assert.equal(h.notifications.length, 2);
});

test('progress cards without final controls never notify', async () => {
  const h = createHarness();
  await h.sendRuntimeMessage(turnStart());
  const response = await h.sendRuntimeMessage(domCandidate('completion-1', {
    event: { hasFinalAction: false }, context: { hasFinalAction: false },
  }));
  assert.equal(response.suppressed, true);
  assert.equal(response.reason, 'not-final-render');
  assert.equal(h.notifications.length, 0);
});

test('final candidates require an exact completion, document, path, and route epoch', async () => {
  const h = createHarness({ sound: false });
  await h.sendRuntimeMessage(turnStart('route-turn'));
  const staleEpoch = await h.sendRuntimeMessage(domCandidate('route-turn', { routeEpoch: 2 }));
  const wrongPath = await h.sendRuntimeMessage(domCandidate('route-turn', { pathHash: PATH_B }));
  const wrongDocument = await h.sendRuntimeMessage(domCandidate('route-turn'), {
    tab: { id: 42 }, documentId: 'different-document',
  });

  assert.equal(staleEpoch.reason, 'stale-route-epoch');
  assert.equal(wrongPath.reason, 'completion-route-mismatch');
  assert.equal(wrongDocument.reason, 'document-mismatch');
  assert.equal(h.notifications.length, 0);
});

test('a switched-away route remains suspended until re-entered with a new epoch', async () => {
  const h = createHarness({ sound: false });
  await h.sendRuntimeMessage(turnStart('route-a'));
  await h.sendRuntimeMessage({
    type: 'turn-suspend', completionId: 'route-a', pathHash: PATH_A, routeEpoch: 1, at: 11_000,
  });
  await h.sendRuntimeMessage(turnStart('route-b', { pathHash: PATH_B, routeEpoch: 2, at: 12_000 }));

  const whileAway = await h.sendRuntimeMessage(domCandidate('route-a', {
    routeEpoch: 1, event: { completedAt: 15_000 },
  }));
  assert.equal(whileAway.reason, 'route-suspended');
  assert.equal(h.notifications.length, 0);

  const returned = await h.sendRuntimeMessage({
    type: 'route-enter', pathHash: PATH_A, routeEpoch: 3, at: 16_000,
  });
  assert.equal(returned.pending.completionId, 'route-a');
  const recovered = await h.sendRuntimeMessage(domCandidate('route-a', {
    routeEpoch: 3, event: { completedAt: 20_000 },
  }));
  assert.equal(recovered.ok, true);
  assert.equal(h.notifications.length, 1);
});

test('an active initial locked notification is not repeated after unlock', async () => {
  const h = createHarness({ sound: false }, { idleState: 'locked' });
  await h.sendRuntimeMessage(turnStart('locked-completion'));
  const initial = await h.sendRuntimeMessage(domCandidate('locked-completion', {
    context: {
      pageTitle: 'Private conversation title',
      url: 'https://chatgpt.com/c/private-conversation',
    },
  }));

  assert.equal(initial.ok, true);
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].id, /-lock-locked-completion-initial$/u);
  const queue = h.localStore.turnbellLockedReplayQueueV1;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, 'pending');
  assert.equal(JSON.stringify(queue).includes('Private conversation title'), false);
  assert.equal(JSON.stringify(queue).includes('private-conversation'), false);

  await h.setIdleState('active');
  assert.equal(h.notifications.length, 1);
  assert.deepEqual(h.activeNotificationIds(), ['turnbell-42-lock-locked-completion-initial']);
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'initial-active');

  await h.setIdleState('idle');
  assert.equal(h.notifications.length, 1);
});

test('a disappeared locked notification gets one generic replay after unlock', async () => {
  const h = createHarness({ sound: false }, { idleState: 'locked' });
  await h.sendRuntimeMessage(turnStart('disappeared-completion'));
  await h.sendRuntimeMessage(domCandidate('disappeared-completion'));
  const initialId = h.notifications[0].id;
  await h.closeNotification(initialId, false);

  await h.setIdleState('active');
  assert.equal(h.notifications.length, 2);
  assert.equal(h.notifications[1].id, 'turnbell-42-lock-disappeared-completion-unlock');
  assert.equal(h.notifications[1].options.message, '锁屏期间有一轮回复完成');
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'replayed');
});

test('a lock-screen close racing with the active-notification snapshot still produces one replay', async () => {
  const h = createHarness({ sound: false }, { idleState: 'locked' });
  await h.sendRuntimeMessage(turnStart('close-snapshot-race'));
  await h.sendRuntimeMessage(domCandidate('close-snapshot-race'));
  const initialId = h.notifications[0].id;
  h.closeOnNextGetAll(initialId);

  await h.setIdleState('active');

  assert.equal(h.notifications.length, 2);
  assert.equal(h.notifications[1].id, 'turnbell-42-lock-close-snapshot-race-unlock');
  assert.deepEqual(h.activeNotificationIds(), ['turnbell-42-lock-close-snapshot-race-unlock']);
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'replayed');
});

test('an extension notification query error keeps the locked replay queued for a later retry', async () => {
  const h = createHarness({ sound: false }, { idleState: 'locked' });
  await h.sendRuntimeMessage(turnStart('extension-query-error'));
  await h.sendRuntimeMessage(domCandidate('extension-query-error'));
  const initialId = h.notifications[0].id;
  h.setFailedNotificationQueries(1);

  await h.setIdleState('active');
  assert.equal(h.notifications.length, 1);
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'pending');
  assert.ok(h.alarmsStore['turnbell-active-turn-watchdog']);

  await h.closeNotification(initialId, false);
  assert.equal(h.notifications.length, 2);
  assert.equal(h.notifications[1].id, 'turnbell-42-lock-extension-query-error-unlock');
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'replayed');
});

test('a Web Notification tag-query error is not treated as proof that the locked alert disappeared', async () => {
  const h = createHarness({ sound: false, notificationBackend: 'web' }, { idleState: 'locked' });
  await h.sendRuntimeMessage(turnStart('web-query-error'));
  await h.sendRuntimeMessage(domCandidate('web-query-error'));
  const initial = h.webNotifications[0];
  initial.closed = true;
  h.setFailedWebNotificationQueries(1);

  await h.setIdleState('active');
  assert.equal(h.webNotifications.length, 1);
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'pending');
  assert.ok(h.alarmsStore['turnbell-active-turn-watchdog']);

  h.setClock(80_000);
  h.events.onAlarm.dispatch({ name: 'turnbell-active-turn-watchdog' });
  await h.flush();
  assert.equal(h.webNotifications.length, 2);
  assert.equal(h.webNotifications[1].options.data.notificationKind, 'unlock-replay');
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'replayed');
});

test('an initial notification that disappears after unlock triggers one replay', async () => {
  const h = createHarness({ sound: false }, { idleState: 'locked' });
  await h.sendRuntimeMessage(turnStart('late-disappeared-completion'));
  await h.sendRuntimeMessage(domCandidate('late-disappeared-completion'));
  const initialId = h.notifications[0].id;
  await h.setIdleState('active');
  assert.equal(h.notifications.length, 1);
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'initial-active');

  await h.closeNotification(initialId, false);
  assert.equal(h.notifications.length, 2);
  assert.equal(h.notifications[1].id, 'turnbell-42-lock-late-disappeared-completion-unlock');
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'replayed');
});

test('a failed unlock replay stays alarmed and retries without another user event', async () => {
  const h = createHarness({ sound: false }, { idleState: 'locked' });
  await h.sendRuntimeMessage(turnStart('replay-retry-completion'));
  await h.sendRuntimeMessage(domCandidate('replay-retry-completion'));
  const initialId = h.notifications[0].id;

  await h.setIdleState('active');
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'initial-active');
  h.setFailedNotificationCreates(1);
  await h.closeNotification(initialId, false);
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'pending');
  assert.equal(h.notifications.length, 2);
  assert.ok(h.alarmsStore['turnbell-active-turn-watchdog']);

  h.setFailedNotificationCreates(0);
  h.setClock(80_000);
  h.events.onAlarm.dispatch({ name: 'turnbell-active-turn-watchdog' });
  await h.flush();

  assert.equal(h.notifications.length, 3);
  assert.equal(h.notifications[2].id, 'turnbell-42-lock-replay-retry-completion-unlock');
  assert.deepEqual(h.activeNotificationIds(), ['turnbell-42-lock-replay-retry-completion-unlock']);
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'replayed');
});

test('unlock racing with initial notification creation waits and does not regress queue state', async () => {
  const h = createHarness({ sound: false }, {
    idleState: 'locked',
    deferNotificationCreate: true,
  });
  await h.sendRuntimeMessage(turnStart('racing-completion'));
  const completion = h.sendRuntimeMessage(domCandidate('racing-completion'));
  await h.flush();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'creating-initial');

  await h.setIdleState('active');
  assert.equal(h.notifications.length, 1);
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'creating-initial');

  assert.equal(await h.completeNextNotificationCreate(), true);
  assert.equal(h.notifications.length, 1);
  assert.equal(await h.completeNextNotificationCreate(), false);
  const response = await completion;
  assert.equal(response.ok, true);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'initial-active');
});

test('a user-dismissed locked notification acknowledges the replay record', async () => {
  const h = createHarness({ sound: false }, { idleState: 'locked' });
  await h.sendRuntimeMessage(turnStart('dismissed-completion'));
  await h.sendRuntimeMessage(domCandidate('dismissed-completion'));
  h.events.onClosed.dispatch(h.notifications[0].id, true);
  await h.flush();
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'acknowledged');
  await h.setIdleState('active');
  assert.equal(h.notifications.length, 1);
});

test('Web Notification click waits for locked-replay acknowledgement', async () => {
  const h = createHarness({ sound: false, notificationBackend: 'web' }, { idleState: 'locked' });
  await h.sendRuntimeMessage(turnStart('web-clicked-completion'));
  await h.sendRuntimeMessage(domCandidate('web-clicked-completion'));
  const webOptions = h.webNotifications[0].options;
  assert.equal(Object.hasOwn(webOptions.data, 'url'), false);

  await h.dispatchGlobalNotificationEvent('notificationclick', webOptions.data);
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'acknowledged');
  await h.setIdleState('active');
  assert.equal(h.webNotifications.length, 1);
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'acknowledged');
});

test('a user-closed locked Web Notification is acknowledged without replay', async () => {
  const h = createHarness({ sound: false, notificationBackend: 'web' }, { idleState: 'locked' });
  await h.sendRuntimeMessage(turnStart('web-dismissed-completion'));
  await h.sendRuntimeMessage(domCandidate('web-dismissed-completion'));
  const initial = h.webNotifications[0];
  assert.equal(initial.options.data.notificationKind, 'locked-initial');
  initial.closed = true;

  await h.dispatchGlobalNotificationEvent('notificationclose', initial.options.data);
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'acknowledged');
  await h.setIdleState('active');

  assert.equal(h.webNotifications.length, 1);
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'acknowledged');
});

test('an orphaned locked notification record recovers on an ordinary worker-start event', async () => {
  const localStore = {
    turnbellLockedReplayQueueV1: [{
      completionId: 'orphaned-completion',
      tabId: 42,
      completedAt: 11_000,
      durationMs: 1_000,
      initialNotificationId: 'turnbell-42-lock-orphaned-completion-initial',
      replayNotificationId: 'turnbell-42-lock-orphaned-completion-unlock',
      initialWebTag: 'turnbell-web-orphaned-completion-initial',
      replayWebTag: 'turnbell-web-orphaned-completion-unlock',
      status: 'creating-initial',
      attempts: 0,
      expiresAt: 90_000_000,
      tabClosed: false,
    }],
  };
  const h = createHarness({ sound: false }, { idleState: 'active', localStore });
  await h.sendRuntimeMessage({ type: 'monitor-status' }, {});
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].id, 'turnbell-42-lock-orphaned-completion-unlock');
  assert.equal(h.localStore.turnbellLockedReplayQueueV1[0].status, 'replayed');
});

test('background-only setting uses actual tab and window focus', async () => {
  const foreground = createHarness({ backgroundOnly: true }, { tabActive: true, windowFocused: true });
  await foreground.sendRuntimeMessage(turnStart());
  const suppressed = await foreground.sendRuntimeMessage(domCandidate());
  assert.equal(suppressed.suppressed, true);
  assert.equal(suppressed.reason, 'settings');
  assert.equal(foreground.notifications.length, 0);

  const background = createHarness({ backgroundOnly: true }, { tabActive: false, windowFocused: true });
  await background.sendRuntimeMessage(turnStart());
  await background.sendRuntimeMessage(domCandidate());
  assert.equal(background.notifications.length, 1);
});

test('test notification returns verifiable Edge diagnostics and sound preview uses the chosen theme', async () => {
  const h = createHarness();
  const tested = await h.sendRuntimeMessage({
    type: 'test-notification',
    settings: { sound: false, persistentNotification: true, soundTheme: 'glass' },
  }, {});
  assert.equal(tested.routes.browser, true);
  assert.equal(tested.routes.browserActive, true);
  assert.equal(tested.routes.diagnostic, 'accepted-active');

  const preview = await h.sendRuntimeMessage({ type: 'preview-sound', theme: 'glass', volume: 0.4 }, {});
  assert.equal(preview.ok, true);
  assert.equal(h.soundMessages.some((item) => item.type === 'play-sound' && item.theme === 'glass' && item.volume === 0.4), true);

  const permission = await h.sendRuntimeMessage({ type: 'notification-permission' }, {});
  assert.equal(permission.ok, true);
  assert.equal(permission.level, 'granted');
  assert.equal(permission.webSupported, true);
});

test('settle check keeps the message channel alive until it samples the hidden tab', async () => {
  const h = createHarness();
  const pending = h.sendRuntimeMessage({
    type: 'schedule-settle-check', pathHash: PATH_A, routeEpoch: 1,
    completionId: 'settle-completion', delayMs: 1_200, cycleNumber: 3, settleKey: '3:a:b:c',
  });
  await h.flush();
  assert.equal(h.tabMessages.length, 0);
  await h.runNextTimer();
  const response = await pending;
  assert.equal(response.ok, true);
  assert.equal(response.sampled, true);
  assert.equal(h.tabMessages[0].tabId, 42);
  assert.equal(h.tabMessages[0].message.type, 'monitor-sample-now');
  assert.equal(h.tabMessages[0].message.cycleNumber, 3);
  assert.equal(h.tabMessages[0].message.settleKey, '3:a:b:c');
});

test('notification diagnostics shortcut opens Edge policy page without native code', async () => {
  const h = createHarness();
  const response = await h.sendRuntimeMessage({ type: 'open-edge-notification-settings' }, {});
  assert.equal(response.ok, true);
  assert.equal(h.createdTabs.at(-1).url, 'edge://policy');
});

test('Web Notification compatibility backend bypasses chrome.notifications routing', async () => {
  const h = createHarness({ sound: false, notificationBackend: 'web' });
  await h.sendRuntimeMessage(turnStart('completion-web'));
  const response = await h.sendRuntimeMessage(domCandidate('completion-web'));

  assert.equal(response.ok, true);
  assert.equal(h.notifications.length, 0);
  assert.equal(response.routes.web, true);
  assert.equal(response.routes.webPermission, 'granted');
  assert.equal(h.webNotifications.length, 1);
  assert.equal(h.webNotifications[0].options.requireInteraction, true);
  assert.equal(Object.hasOwn(h.webNotifications[0].options.data, 'url'), false);
});
