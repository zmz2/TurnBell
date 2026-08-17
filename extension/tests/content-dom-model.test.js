'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const domSource = fs.readFileSync(path.resolve(__dirname, '../src/dom-model-core.js'), 'utf8');
const contentSource = fs.readFileSync(path.resolve(__dirname, '../src/content.js'), 'utf8');

function nextTurn() { return new Promise((resolve) => setImmediate(resolve)); }

function makeContainer(order, final = false) {
  return {
    order,
    getAttribute(name) { return name === 'data-testid' ? `conversation-turn-${order}` : ''; },
    querySelector(selector) {
      return final && selector.includes('copy-turn-action-button') ? { isConnected: true } : null;
    },
    compareDocumentPosition(other) {
      if (order < other.order) return 4;
      if (order > other.order) return 2;
      return 0;
    },
  };
}

function makeNode(text, container, identity) {
  return {
    innerText: text,
    textContent: text,
    isConnected: true,
    hidden: false,
    disabled: false,
    getAttribute(name) { return name === 'data-message-id' ? identity : ''; },
    getBoundingClientRect() { return { width: 100, height: 20 }; },
    closest(selector) {
      if (selector.includes('conversation-turn') || selector.startsWith('article') || selector === '[data-turn]') return container;
      return null;
    },
  };
}

test('content context uses canonical DOM turns and never exposes assistant text', async () => {
  let runtimeListener = null;
  const recapContainer = makeContainer(1, false);
  const finalContainer = makeContainer(2, true);
  const recap = makeNode('intermediate reasoning recap', recapContainer, 'assistant-recap');
  const finalShort = makeNode('short', finalContainer, 'assistant-final');
  const finalInner = makeNode('final answer', finalContainer, 'assistant-final-inner');
  const user = makeNode('question', makeContainer(0), 'user-1');

  class FakeMutationObserver { observe() {} disconnect() {} }
  const context = {
    console, URL, Promise, Date, MutationObserver: FakeMutationObserver,
    location: { href: 'https://chatgpt.com/c/dom', origin: 'https://chatgpt.com', pathname: '/c/dom' },
    document: {
      documentElement: {}, title: 'DOM variant - ChatGPT', visibilityState: 'hidden', readyState: 'complete',
      querySelector() { return null; },
      querySelectorAll(selector) {
        if (selector === '[data-message-author-role="assistant"]') return [finalShort, recap];
        if (selector === 'article[data-turn="assistant"]') return [finalInner];
        if (selector === '[data-message-author-role="user"]') return [user];
        return [];
      },
      addEventListener() {},
    },
    getComputedStyle() { return null; },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; },
    queueMicrotask(callback) { Promise.resolve().then(callback); }, addEventListener() {},
    GPTReplyDetector: {
      fingerprint(value) { return `fp-${String(value).length}`; },
      createDetector() {
        return { step() { return null; }, getState() { return { phase: 'idle', cycleNumber: 0 }; }, reset() {} };
      },
    },
    GPTReplyNotification: {
      DEFAULT_SETTINGS: Object.freeze({ enabled: true, debug: false }),
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
  };
  context.chrome = {
    runtime: {
      id: 'test-extension', lastError: null,
      sendMessage(_message, callback) { callback?.(); },
      onMessage: { addListener(listener) { runtimeListener = listener; } },
    },
    storage: {
      sync: { get(defaults, callback) { callback(defaults); } },
      onChanged: { addListener() {} },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(domSource, context, { filename: 'dom-model-core.js' });
  vm.runInContext(contentSource, context, { filename: 'content.js' });
  await nextTurn();

  let response;
  runtimeListener({ type: 'notification-context' }, {}, (value) => { response = value; });

  assert.equal(response.context.hasFinalAction, true);
  assert.equal(response.context.assistantCount, 2);
  assert.equal(response.context.userCount, 1);
  assert.equal(response.context.assistantText, undefined);
  assert.equal(response.snapshot.assistantText, undefined);
});
