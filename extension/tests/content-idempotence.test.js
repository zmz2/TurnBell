'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../src/content.js'), 'utf8');
function nextTurn() { return new Promise((resolve) => setImmediate(resolve)); }

test('content detector installs only once when scripts are injected repeatedly', async () => {
  const counts = { observers: 0, intervals: 0, storageListeners: 0, runtimeListeners: 0 };
  class FakeMutationObserver { constructor() { counts.observers += 1; } observe() {} disconnect() {} }
  const state = { phase: 'idle', cycleNumber: 0 };
  const context = {
    console, URL, Promise, Date,
    document: {
      documentElement: {}, title: 'Existing conversation - ChatGPT', visibilityState: 'hidden', readyState: 'complete',
      querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {},
    },
    location: { href: 'https://chatgpt.com/c/existing', pathname: '/c/existing' },
    MutationObserver: FakeMutationObserver,
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval() { counts.intervals += 1; return counts.intervals; },
    getComputedStyle() { return null; }, addEventListener() {},
    queueMicrotask(callback) { Promise.resolve().then(callback); },
    GPTReplyDetector: {
      createDetector() { return { step() { return null; }, getState() { return state; }, reset() {} }; },
    },
    GPTReplyNotification: {
      DEFAULT_SETTINGS: Object.freeze({ enabled: true, debug: false, quietPeriodMs: 1000 }),
      normalizeSettings(value = {}) { return { enabled: true, debug: false, quietPeriodMs: 1000, ...value }; },
    },
    GPTReplySampleScheduler: { createSampleScheduler() { return { schedule() {}, dispose() {} }; } },
    TurnBellBootstrap: {
      createBootstrapGate() {
        return {
          evaluate() { return { action: 'ready', arm: false }; },
          activate() { return { action: 'activate', arm: true }; },
          noteMutation() {}, reset() {}, getState() { return { ready: true }; },
        };
      },
    },
    TurnBellDOMModel: {
      ASSISTANT_SELECTORS: [], USER_SELECTORS: [], FINAL_ACTION_SELECTORS: [],
      collectTurns() { return []; }, hasFinalAction() { return false; }, fingerprint() { return '0'; },
      makeTurnKey() { return 'dom:empty'; },
    },
  };
  context.chrome = {
    runtime: {
      id: 'test-extension', lastError: null, sendMessage(_message, callback) { callback?.(); },
      onMessage: { addListener() { counts.runtimeListeners += 1; } },
    },
    storage: {
      sync: { get(defaults, callback) { callback(defaults); } },
      onChanged: { addListener() { counts.storageListeners += 1; } },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'content.js' });
  await nextTurn();
  vm.runInContext(source, context, { filename: 'content.js' });
  await nextTurn();

  assert.equal(context.__TURNBELL_CONTENT_ACTIVE__, true);
  assert.equal(context.__GPT_REPLY_NOTIFIER_CONTENT_ACTIVE__, true);
  assert.deepEqual(counts, { observers: 1, intervals: 1, storageListeners: 1, runtimeListeners: 1 });
});
