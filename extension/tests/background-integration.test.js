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
  let clock = 10_000;
  let nextTimerId = 1;
  const timers = new Map();
  const notifications = [];
  const activeNotifications = {};
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
  const sessionStore = {};
  const tabActive = environmentOverrides.tabActive ?? false;
  const windowFocused = environmentOverrides.windowFocused ?? true;

  const events = {
    onInstalled: createEvent(), onStartup: createEvent(), onMessage: createEvent(),
    onClicked: createEvent(), onClosed: createEvent(), onRemoved: createEvent(),
    onActivated: createEvent(), onBeforeRequest: createEvent(), onCompleted: createEvent(),
    onErrorOccurred: createEvent(), onAlarm: createEvent(),
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
        set(items, callback) { Object.assign(sessionStore, items); callback?.(); },
        remove(keys, callback) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionStore[key];
          callback?.();
        },
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
        activeNotifications[id] = options;
        callback(id);
      },
      getAll(callback) { callback({ ...activeNotifications }); },
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
    alarms: { onAlarm: events.onAlarm, create() {}, clear() {}, getAll(callback) { callback([]); } },
  };

  class FakeDate extends Date { static now() { return clock; } }
  const context = {
    chrome, console, URL, Map, Set, Promise, Object, Number, String, Boolean, RegExp, Math, Date: FakeDate,
    registration: {
      async showNotification(title, options) { webNotifications.push({ title, options }); },
      async getNotifications({ tag } = {}) { return webNotifications.filter((item) => !tag || item.options.tag === tag); },
    },
    addEventListener() {},
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
    badgeCalls, createdTabs, events, notifications, sessionStore, soundMessages, tabMessages, webNotifications,
    setClock(value) { clock = value; },
    async flush() { await flushTurns(); },
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
    sendRuntimeMessage(message, sender = { tab: { id: 42 } }) {
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

function domCandidate(turnKey = 'turn-1', overrides = {}) {
  return {
    type: 'dom-final-candidate', turnKey,
    payload: {
      event: {
        type: 'complete', durationMs: 3_200, startedAt: 10_000, completedAt: 13_200,
        fingerprint: `fp-${turnKey}`, hasFinalAction: true,
        replyText: 'must never enter a notification',
        ...(overrides.event || {}),
      },
      context: {
        pageTitle: 'Background research - ChatGPT',
        url: 'https://chatgpt.com/c/background', tabHidden: true,
        hasFinalAction: true, fingerprint: `fp-${turnKey}`,
        ...(overrides.context || {}),
      },
    },
  };
}

test('a final DOM turn uses the Windows default notification sound and sets a badge', async () => {
  const h = createHarness();
  await h.sendRuntimeMessage({ type: 'turn-start', turnKey: 'turn-1', userCount: 1, at: 10_000 });
  const response = await h.sendRuntimeMessage(domCandidate());

  assert.equal(response.ok, true);
  assert.equal(h.notifications.length, 1);
  const options = h.notifications[0].options;
  assert.equal(options.title, 'TurnBell · 回复完成');
  assert.equal(options.message.includes('must never'), false);
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
  await h.sendRuntimeMessage({ type: 'turn-start', turnKey: 'turn-custom', userCount: 1, at: 10_000, source: 'explicit' });
  const response = await h.sendRuntimeMessage(domCandidate('turn-custom'));

  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].options.silent, true);
  assert.equal(response.routes.systemSound, false);
  assert.equal(response.routes.sound, true);
  assert.equal(h.soundMessages.some((item) => item.type === 'play-sound' && item.theme === 'glass'), true);
});

test('duplicate evidence is suppressed, but a new key can recover a missed turn-start', async () => {
  const h = createHarness({ sound: false });
  await h.sendRuntimeMessage({ type: 'turn-start', turnKey: 'turn-1', userCount: 1, at: 10_000 });
  await h.sendRuntimeMessage(domCandidate('turn-1'));
  const duplicate = await h.sendRuntimeMessage(domCandidate('turn-1'));
  const next = await h.sendRuntimeMessage(domCandidate('turn-2', {
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
  await h.sendRuntimeMessage({ type: 'turn-start', turnKey: 'turn-1', userCount: 1, at: 10_000 });
  const response = await h.sendRuntimeMessage(domCandidate('turn-1', {
    event: { hasFinalAction: false }, context: { hasFinalAction: false },
  }));
  assert.equal(response.suppressed, true);
  assert.equal(response.reason, 'not-final-render');
  assert.equal(h.notifications.length, 0);
});

test('background-only setting uses actual tab and window focus', async () => {
  const foreground = createHarness({ backgroundOnly: true }, { tabActive: true, windowFocused: true });
  await foreground.sendRuntimeMessage({ type: 'turn-start', turnKey: 'turn-1', userCount: 1, at: 10_000 });
  const suppressed = await foreground.sendRuntimeMessage(domCandidate());
  assert.equal(suppressed.suppressed, true);
  assert.equal(suppressed.reason, 'settings');
  assert.equal(foreground.notifications.length, 0);

  const background = createHarness({ backgroundOnly: true }, { tabActive: false, windowFocused: true });
  await background.sendRuntimeMessage({ type: 'turn-start', turnKey: 'turn-1', userCount: 1, at: 10_000 });
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
    type: 'schedule-settle-check', delayMs: 1_200, cycleNumber: 3, settleKey: '3:a:b:c',
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
  await h.sendRuntimeMessage({ type: 'turn-start', turnKey: 'turn-web', userCount: 1, at: 10_000 });
  const response = await h.sendRuntimeMessage(domCandidate('turn-web'));

  assert.equal(response.ok, true);
  assert.equal(h.notifications.length, 0);
  assert.equal(response.routes.web, true);
  assert.equal(response.routes.webPermission, 'granted');
  assert.equal(h.webNotifications.length, 1);
  assert.equal(h.webNotifications[0].options.requireInteraction, true);
});
