'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const contentSource = fs.readFileSync(path.resolve(__dirname, '../src/content.js'), 'utf8');
const detectorAPI = require('../src/detector-core.js');
const notificationAPI = require('../src/notification-core.js');
const bootstrapAPI = require('../src/bootstrap-core.js');

function nextTurn() { return new Promise((resolve) => setImmediate(resolve)); }

function makeTurn(text, identity) {
  return { text, identity, container: { identity } };
}

test('hydrated history stays silent, then regular and Instant Enter-sent turns each emit one final candidate', async () => {
  let now = 0;
  let runtimeListener = null;
  let observer = null;
  const documentListeners = new Map();
  const runtimeMessages = [];
  const page = {
    assistantTurns: [],
    userTurns: [],
    finalAction: false,
    generating: false,
  };

  class FakeDate extends Date {
    static now() { return now; }
  }
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {}
    disconnect() {}
  }

  const ASSISTANT_SELECTORS = Object.freeze(['assistant']);
  const USER_SELECTORS = Object.freeze(['user']);
  const FINAL_ACTION_SELECTORS = Object.freeze(['final']);
  const stopButton = {
    isConnected: true,
    hidden: false,
    disabled: false,
    getAttribute() { return ''; },
    getBoundingClientRect() { return { width: 20, height: 20 }; },
  };

  const context = {
    console,
    URL,
    Promise,
    Date: FakeDate,
    MutationObserver: FakeMutationObserver,
    location: { href: 'https://chatgpt.com/c/lifecycle', origin: 'https://chatgpt.com', pathname: '/c/lifecycle' },
    document: {
      documentElement: {},
      title: 'Lifecycle - ChatGPT',
      visibilityState: 'hidden',
      readyState: 'loading',
      querySelector(selector) {
        return page.generating && String(selector).includes('stop') ? stopButton : null;
      },
      querySelectorAll(selector) {
        if (selector === 'form button, main button') return [];
        return [];
      },
      addEventListener(type, listener) { documentListeners.set(type, listener); },
    },
    getComputedStyle() { return null; },
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    queueMicrotask(callback) { Promise.resolve().then(callback); },
    addEventListener() {},
    GPTReplyDetector: detectorAPI,
    GPTReplyNotification: notificationAPI,
    GPTReplySampleScheduler: {
      createSampleScheduler() { return { schedule() {}, dispose() {} }; },
    },
    TurnBellBootstrap: bootstrapAPI,
    TurnBellDOMModel: {
      ASSISTANT_SELECTORS,
      USER_SELECTORS,
      FINAL_ACTION_SELECTORS,
      collectTurns(_document, selectors) {
        return selectors === USER_SELECTORS ? page.userTurns : page.assistantTurns;
      },
      collectAssistantTurns() { return page.assistantTurns; },
      hasFinalActionForTurn() { return page.finalAction; },
      fingerprint(value) { return detectorAPI.fingerprint(String(value)); },
      makeTurnKey({ pathname, userTurns, assistantCount, cycleNumber }) {
        const latestUser = userTurns.at(-1)?.identity || 'none';
        return `dom:${pathname}:${latestUser}:a${assistantCount}:c${cycleNumber}`;
      },
    },
  };
  context.chrome = {
    runtime: {
      id: 'test-extension',
      lastError: null,
      sendMessage(message, callback) {
        runtimeMessages.push(message);
        callback?.({ ok: true });
      },
      onMessage: { addListener(listener) { runtimeListener = listener; } },
    },
    storage: {
      sync: { get(defaults, callback) { callback(defaults); } },
      onChanged: { addListener() {} },
    },
  };
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(contentSource, context, { filename: 'content.js' });
  await nextTurn();

  // Existing history hydrates after document_start. It must become a silent baseline.
  now = 100;
  context.document.readyState = 'complete';
  page.userTurns = [makeTurn('old question', 'user-old')];
  page.assistantTurns = [makeTurn('old final answer', 'assistant-old')];
  page.finalAction = true;
  observer.callback([]);
  now = 1_100;
  runtimeListener({ type: 'monitor-sample-now' }, {}, () => {});
  assert.equal(runtimeMessages.some((message) => message.type === 'turn-start'), false);
  assert.equal(runtimeMessages.some((message) => message.type === 'dom-final-candidate'), false);

  // A real Enter send explicitly arms a new turn before ChatGPT mutates the DOM.
  now = 2_000;
  const composer = {
    matches(selector) { return selector.includes('textarea'); },
    closest(selector) { return selector.includes('textarea') || selector.includes('form') || selector.includes('main') ? this : null; },
  };
  documentListeners.get('keydown')({
    key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    isComposing: false, keyCode: 13, target: composer,
  });

  now = 2_100;
  page.userTurns = [...page.userTurns, makeTurn('new question', 'user-new')];
  page.generating = true;
  page.finalAction = false;
  runtimeListener({ type: 'monitor-sample-now' }, {}, () => {});

  now = 2_300;
  page.assistantTurns = [...page.assistantTurns, makeTurn('partial answer', 'assistant-new')];
  runtimeListener({ type: 'monitor-sample-now' }, {}, () => {});

  now = 3_000;
  page.assistantTurns = [page.assistantTurns[0], makeTurn('complete answer', 'assistant-new')];
  page.generating = false;
  page.finalAction = true;
  runtimeListener({ type: 'monitor-sample-now' }, {}, () => {});

  now = 4_300;
  runtimeListener({ type: 'monitor-sample-now' }, {}, () => {});
  now = 5_000;
  runtimeListener({ type: 'monitor-sample-now' }, {}, () => {});

  let starts = runtimeMessages.filter((message) => message.type === 'turn-start');
  let candidates = runtimeMessages.filter((message) => message.type === 'dom-final-candidate');
  assert.equal(starts.length, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].payload.event.hasFinalAction, true);
  assert.equal(JSON.stringify(candidates[0]).includes('complete answer'), false);

  // Instant can skip the visible reasoning/generating state and may expose no
  // final action row. Explicit Enter intent plus a conservative 3-second
  // stable period is therefore the only actionless completion path.
  now = 6_000;
  documentListeners.get('keydown')({
    key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    isComposing: false, keyCode: 13, target: composer,
  });
  now = 6_100;
  page.userTurns = [...page.userTurns, makeTurn('instant question', 'user-instant')];
  page.assistantTurns = [...page.assistantTurns, makeTurn('instant final answer', 'assistant-instant')];
  page.generating = false;
  page.finalAction = false;
  runtimeListener({ type: 'monitor-sample-now' }, {}, () => {});

  const instantSettle = runtimeMessages
    .filter((message) => message.type === 'schedule-settle-check')
    .at(-1);
  assert.equal(instantSettle?.delayMs, 3_000);

  now = 9_099;
  runtimeListener({ type: 'monitor-sample-now' }, {}, () => {});
  assert.equal(runtimeMessages.filter((message) => message.type === 'dom-final-candidate').length, 1);
  now = 9_100;
  runtimeListener({ type: 'monitor-sample-now' }, {}, () => {});

  starts = runtimeMessages.filter((message) => message.type === 'turn-start');
  candidates = runtimeMessages.filter((message) => message.type === 'dom-final-candidate');
  assert.equal(starts.length, 2);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[1].payload.event.hasFinalAction, false);
  assert.equal(candidates[1].payload.event.finalEvidence, 'explicit-fast-stable');
  assert.equal(JSON.stringify(candidates[1]).includes('instant final answer'), false);
});
