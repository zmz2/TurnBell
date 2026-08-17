'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../src/content.js'), 'utf8');
function nextTurn() { return new Promise((resolve) => setImmediate(resolve)); }

function createHarness() {
  const documentListeners = new Map();
  const runtimeMessages = [];
  let armCalls = 0;
  let state = { initialized: true, phase: 'idle', cycleNumber: 0 };
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  }

  const context = {
    console, URL, Promise, Date, MutationObserver: FakeMutationObserver,
    location: { href: 'https://chatgpt.com/c/intent', origin: 'https://chatgpt.com', pathname: '/c/intent' },
    document: {
      documentElement: {}, title: 'Intent - ChatGPT', visibilityState: 'visible', readyState: 'complete',
      querySelector() { return null; }, querySelectorAll() { return []; },
      addEventListener(type, listener) { documentListeners.set(type, listener); },
    },
    getComputedStyle() { return null; },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; },
    queueMicrotask(callback) { Promise.resolve().then(callback); }, addEventListener() {},
    GPTReplyDetector: {
      createDetector() {
        return {
          step() { return null; },
          arm() { armCalls += 1; state = { initialized: true, phase: 'waiting', cycleNumber: state.cycleNumber + 1 }; return state; },
          getState() { return state; }, reset() { state = { initialized: false, phase: 'idle', cycleNumber: 0 }; },
        };
      },
    },
    GPTReplyNotification: {
      DEFAULT_SETTINGS: Object.freeze({ enabled: true, debug: false, quietPeriodMs: 1000 }),
      normalizeSettings(value = {}) { return { enabled: true, debug: false, quietPeriodMs: 1000, ...value }; },
    },
    GPTReplySampleScheduler: { createSampleScheduler() { return { schedule() {}, dispose() {} }; } },
    TurnBellBootstrap: {
      createBootstrapGate() {
        return {
          evaluate() { return { action: 'baseline', arm: false }; },
          activate() { return { action: 'activate', arm: true }; },
          noteMutation() {}, reset() {}, getState() { return { ready: true }; },
        };
      },
    },
    TurnBellDOMModel: {
      ASSISTANT_SELECTORS: [], USER_SELECTORS: [], FINAL_ACTION_SELECTORS: [],
      collectTurns() { return []; }, collectAssistantTurns() { return []; },
      hasFinalActionForTurn() { return false; }, fingerprint(value) { return String(value).length.toString(16); },
      makeTurnKey({ cycleNumber }) { return `dom:cycle:${cycleNumber}`; },
    },
  };
  context.chrome = {
    runtime: {
      id: 'test-extension', lastError: null,
      sendMessage(message, callback) { runtimeMessages.push(message); callback?.({ ok: true }); },
      onMessage: { addListener() {} },
    },
    storage: {
      sync: { get(defaults, callback) { callback(defaults); } },
      onChanged: { addListener() {} },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'content.js' });

  return { context, documentListeners, runtimeMessages, getArmCalls: () => armCalls };
}

test('pressing Enter in the ChatGPT composer explicitly arms a new turn', async () => {
  const h = createHarness();
  await nextTurn();

  const keydown = h.documentListeners.get('keydown');
  assert.equal(typeof keydown, 'function');

  const composer = {
    matches(selector) { return selector.includes('textarea') || selector.includes('contenteditable'); },
    closest(selector) { return selector.includes('form') || selector.includes('composer') ? this : null; },
  };
  keydown({ key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, target: composer });

  assert.equal(h.getArmCalls(), 1);
  assert.equal(h.runtimeMessages.some((message) => message.type === 'turn-start'), true);
});

test('Shift+Enter and IME composition do not arm a new turn', async () => {
  const h = createHarness();
  await nextTurn();
  const keydown = h.documentListeners.get('keydown');
  const composer = {
    matches(selector) { return selector.includes('textarea'); },
    closest() { return this; },
  };

  keydown({ key: 'Enter', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, target: composer });
  keydown({ key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: true, target: composer });
  assert.equal(h.getArmCalls(), 0);
});
