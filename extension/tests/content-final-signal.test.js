'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../src/content.js'), 'utf8');
function nextTurn() { return new Promise((resolve) => setImmediate(resolve)); }

test('a DOM completion sends one metadata-only candidate after arming the detector cycle', async () => {
  const runtimeMessages = [];
  let runtimeListener = null;
  let steps = 0;
  let state = { phase: 'idle', cycleNumber: 0 };
  class FakeMutationObserver { observe() {} disconnect() {} }

  const assistantTurn = { text: 'private final answer', container: {} };
  const userTurn = { text: 'question', identity: 'user-1', container: {} };
  const context = {
    console, URL, Promise, Date, MutationObserver: FakeMutationObserver,
    location: { href: 'https://chatgpt.com/c/background', origin: 'https://chatgpt.com', pathname: '/c/background' },
    document: {
      documentElement: {}, title: 'Background research - ChatGPT', visibilityState: 'hidden', readyState: 'complete',
      querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {},
    },
    getComputedStyle() { return null; },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; },
    queueMicrotask(callback) { Promise.resolve().then(callback); }, addEventListener() {},
    GPTReplyDetector: {
      fingerprint(value) { return `fp-${String(value).length}`; },
      createDetector() {
        return {
          step() {
            steps += 1;
            if (steps === 1) return null;
            state = { phase: 'idle', cycleNumber: 1 };
            return {
              type: 'complete', replyText: 'private final answer', fingerprint: 'final-fp',
              durationMs: 2500, startedAt: 1000, completedAt: 3500,
            };
          },
          getState() { return state; }, reset() { state = { phase: 'idle', cycleNumber: 0 }; },
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
          evaluate() { return { action: 'ready', arm: false }; },
          activate() { return { action: 'activate', arm: true }; },
          noteMutation() {}, reset() {}, getState() { return { ready: true }; },
        };
      },
    },
    TurnBellDOMModel: {
      ASSISTANT_SELECTORS: [], USER_SELECTORS: [], FINAL_ACTION_SELECTORS: [],
      collectTurns(_doc, selectors) { return selectors === this.USER_SELECTORS ? [userTurn] : [assistantTurn]; },
      hasFinalAction() { return true; },
      fingerprint() { return 'final-fp'; },
      makeTurnKey({ cycleNumber }) { return `dom:turn:${cycleNumber}`; },
    },
  };
  context.chrome = {
    runtime: {
      id: 'test-extension', lastError: null,
      sendMessage(message, callback) { runtimeMessages.push(message); callback?.({ ok: true }); },
      onMessage: { addListener(listener) { runtimeListener = listener; } },
    },
    storage: {
      sync: { get(defaults, callback) { callback(defaults); } },
      onChanged: { addListener() {} },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'content.js' });
  await nextTurn();

  runtimeListener({ type: 'monitor-sample-now' }, {}, () => {});
  runtimeListener({ type: 'monitor-sample-now' }, {}, () => {});
  await nextTurn();

  const starts = runtimeMessages.filter((item) => item.type === 'turn-start');
  const candidates = runtimeMessages.filter((item) => item.type === 'dom-final-candidate');
  assert.equal(starts.length, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].payload.event.hasFinalAction, true);
  assert.equal(JSON.stringify(candidates[0]).includes('private final answer'), false);
  assert.equal(runtimeMessages.some((item) => item.type === 'stream-final'), false);
});

test('an explicitly sent Instant-style response forwards stable actionless final evidence', async () => {
  const runtimeMessages = [];
  const documentListeners = new Map();
  let runtimeListener = null;
  let state = { initialized: true, phase: 'idle', cycleNumber: 0 };
  let emitted = false;
  class FakeMutationObserver { observe() {} disconnect() {} }

  const assistantTurn = { text: 'fast final answer', container: {} };
  const userTurn = { text: 'fast question', identity: 'user-fast', container: {} };
  const context = {
    console, URL, Promise, Date, MutationObserver: FakeMutationObserver,
    location: { href: 'https://chatgpt.com/c/instant', origin: 'https://chatgpt.com', pathname: '/c/instant' },
    document: {
      documentElement: {}, title: 'Instant - ChatGPT', visibilityState: 'hidden', readyState: 'complete',
      querySelector() { return null; }, querySelectorAll() { return []; },
      addEventListener(type, listener) { documentListeners.set(type, listener); },
    },
    getComputedStyle() { return null; },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; },
    queueMicrotask(callback) { Promise.resolve().then(callback); }, addEventListener() {},
    GPTReplyDetector: {
      createDetector() {
        return {
          arm() { state = { initialized: true, phase: 'waiting', cycleNumber: 1 }; return state; },
          step() {
            if (emitted) return null;
            emitted = true;
            state = { initialized: true, phase: 'idle', cycleNumber: 1 };
            return {
              type: 'complete', replyText: 'fast final answer', fingerprint: 'instant-fp',
              durationMs: 3_000, startedAt: 1_000, completedAt: 4_000,
              hasFinalAction: false, finalEvidence: 'explicit-fast-stable',
            };
          },
          getState() { return state; }, reset() { state = { initialized: false, phase: 'idle', cycleNumber: 0 }; },
        };
      },
    },
    GPTReplyNotification: {
      DEFAULT_SETTINGS: Object.freeze({ enabled: true, debug: false, quietPeriodMs: 1_000 }),
      normalizeSettings(value = {}) { return { enabled: true, debug: false, quietPeriodMs: 1_000, ...value }; },
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
      collectTurns(_doc, selectors) { return selectors === this.USER_SELECTORS ? [userTurn] : [assistantTurn]; },
      collectAssistantTurns() { return [assistantTurn]; },
      hasFinalActionForTurn() { return false; },
      fingerprint() { return 'instant-fp'; },
      makeTurnKey({ cycleNumber }) { return `dom:instant:${cycleNumber}`; },
    },
  };
  context.chrome = {
    runtime: {
      id: 'test-extension', lastError: null,
      sendMessage(message, callback) { runtimeMessages.push(message); callback?.({ ok: true }); },
      onMessage: { addListener(listener) { runtimeListener = listener; } },
    },
    storage: {
      sync: { get(defaults, callback) { callback(defaults); } },
      onChanged: { addListener() {} },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'content.js' });
  await nextTurn();

  const composer = {
    matches(selector) { return selector.includes('textarea'); },
    closest(selector) { return selector.includes('textarea') || selector.includes('form') || selector.includes('main') ? this : null; },
  };
  documentListeners.get('keydown')({
    key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    isComposing: false, keyCode: 13, target: composer,
  });
  runtimeListener({ type: 'monitor-sample-now' }, {}, () => {});
  await nextTurn();

  const start = runtimeMessages.find((item) => item.type === 'turn-start');
  const candidate = runtimeMessages.find((item) => item.type === 'dom-final-candidate');
  assert.equal(start?.source, 'explicit');
  assert.equal(candidate?.payload?.event?.finalEvidence, 'explicit-fast-stable');
  assert.equal(candidate?.payload?.event?.hasFinalAction, false);
  assert.equal(JSON.stringify(candidate).includes('fast final answer'), false);
});
