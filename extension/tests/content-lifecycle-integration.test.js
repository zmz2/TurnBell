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
async function flushEffects(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
    await nextTurn();
  }
}

function makeTurn(text, identity) {
  return { text, identity, container: { identity } };
}

async function createContentHarness({
  pathname = '/c/test',
  deferInitialRouteEnter = false,
  routeEnterResponder = null,
} = {}) {
  let now = 0;
  let runtimeListener = null;
  let observer = null;
  let deferredRouteEnter = null;
  const documentListeners = new Map();
  const globalListeners = new Map();
  const runtimeMessages = [];
  const page = { assistantTurns: [], userTurns: [], finalAction: false, generating: false };
  const location = {
    origin: 'https://chatgpt.com',
    pathname,
    search: '',
    get href() { return `${this.origin}${this.pathname}${this.search}`; },
  };

  class FakeDate extends Date { static now() { return now; } }
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
    location,
    document: {
      documentElement: {},
      title: 'TurnBell lifecycle test - ChatGPT',
      visibilityState: 'hidden',
      readyState: 'complete',
      querySelector(selector) {
        return page.generating && String(selector).includes('stop') ? stopButton : null;
      },
      querySelectorAll() { return []; },
      addEventListener(type, listener) { documentListeners.set(type, listener); },
    },
    getComputedStyle() { return null; },
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    queueMicrotask(callback) { Promise.resolve().then(callback); },
    addEventListener(type, listener) { globalListeners.set(type, listener); },
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
      makeTurnKey({ pathname: pathName, userTurns, assistantCount, cycleNumber }) {
        const latestUser = userTurns.at(-1)?.identity || 'none';
        return `dom:${pathName}:${latestUser}:a${assistantCount}:c${cycleNumber}`;
      },
    },
  };
  context.chrome = {
    runtime: {
      id: 'test-extension',
      lastError: null,
      sendMessage(message, callback) {
        runtimeMessages.push(message);
        if (deferInitialRouteEnter && message.type === 'route-enter' && !deferredRouteEnter) {
          deferredRouteEnter = callback;
          return;
        }
        const response = message.type === 'route-enter' && routeEnterResponder
          ? routeEnterResponder(message)
          : { ok: true, pending: null };
        callback?.(response);
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
  await flushEffects();

  return {
    context,
    documentListeners,
    globalListeners,
    location,
    page,
    runtimeMessages,
    setNow(value) { now = value; },
    setPath(value) { location.pathname = value; },
    resolveInitialRoute(pending) {
      assert.equal(typeof deferredRouteEnter, 'function');
      const callback = deferredRouteEnter;
      deferredRouteEnter = null;
      callback({ ok: true, pending });
    },
    async flush() { await flushEffects(8); },
    async sampleNow(message = { type: 'monitor-sample-now' }) {
      const result = await new Promise((resolve) => runtimeListener(message, {}, resolve));
      await flushEffects(8);
      return result;
    },
    pressEnter() {
      const composer = {
        matches(selector) { return selector.includes('textarea'); },
        closest(selector) {
          return selector.includes('textarea') || selector.includes('form') || selector.includes('main')
            ? this
            : null;
        },
      };
      documentListeners.get('keydown')?.({
        key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        isComposing: false, keyCode: 13, target: composer,
      });
    },
    clickConversationLink(href) {
      const anchor = { href };
      documentListeners.get('click')?.({
        target: { closest(selector) { return selector === 'a[href]' ? anchor : null; } },
      });
    },
  };
}

test('hydrated history stays silent, then regular and Instant Enter-sent turns each emit one final candidate', async () => {
  let now = 0;
  let runtimeListener = null;
  let observer = null;
  const documentListeners = new Map();
  const globalListeners = new Map();
  const runtimeMessages = [];
  const sampleScheduleCalls = [];
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
    addEventListener(type, listener) { globalListeners.set(type, listener); },
    GPTReplyDetector: detectorAPI,
    GPTReplyNotification: notificationAPI,
    GPTReplySampleScheduler: {
      createSampleScheduler() {
        return { schedule(delay) { sampleScheduleCalls.push(delay); }, dispose() {} };
      },
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
  await flushEffects();

  let schedulesBeforeResume = sampleScheduleCalls.length;
  globalListeners.get('focus')();
  assert.equal(sampleScheduleCalls.length, schedulesBeforeResume + 1);
  assert.equal(sampleScheduleCalls.at(-1), 0);
  schedulesBeforeResume = sampleScheduleCalls.length;
  documentListeners.get('resume')();
  assert.equal(sampleScheduleCalls.length, schedulesBeforeResume + 1);
  assert.equal(sampleScheduleCalls.at(-1), 0);
  await flushEffects();

  async function sampleNow(message = { type: 'monitor-sample-now' }) {
    const response = await new Promise((resolve) => {
      runtimeListener(message, {}, resolve);
    });
    await flushEffects();
    return response;
  }

  // Existing history hydrates after document_start. It must become a silent baseline.
  now = 100;
  context.document.readyState = 'complete';
  page.userTurns = [makeTurn('old question', 'user-old')];
  page.assistantTurns = [makeTurn('old final answer', 'assistant-old')];
  page.finalAction = true;
  observer.callback([]);
  now = 1_100;
  await sampleNow();
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
  await sampleNow();

  now = 2_300;
  page.assistantTurns = [...page.assistantTurns, makeTurn('partial answer', 'assistant-new')];
  await sampleNow();

  now = 3_000;
  page.assistantTurns = [page.assistantTurns[0], makeTurn('complete answer', 'assistant-new')];
  page.generating = false;
  page.finalAction = true;
  await sampleNow();

  now = 4_300;
  await sampleNow();
  now = 5_000;
  await sampleNow();

  let starts = runtimeMessages.filter((message) => message.type === 'turn-start');
  let candidates = runtimeMessages.filter((message) => message.type === 'dom-final-candidate');
  assert.ok(starts.length >= 1);
  assert.equal(new Set(starts.map((message) => message.completionId)).size, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].payload.event.hasFinalAction, true);
  assert.equal(JSON.stringify(candidates[0]).includes('complete answer'), false);
  assert.match(candidates[0].pathHash, /^[a-f0-9]{32}$/u);
  assert.equal(candidates[0].routeEpoch, 1);
  assert.ok(candidates[0].completionId);

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
  await sampleNow();

  const instantSettle = runtimeMessages
    .filter((message) => message.type === 'schedule-settle-check')
    .at(-1);
  assert.equal(instantSettle?.delayMs, 3_000);

  now = 9_099;
  await sampleNow();
  assert.equal(runtimeMessages.filter((message) => message.type === 'dom-final-candidate').length, 1);
  now = 9_100;
  await sampleNow();

  starts = runtimeMessages.filter((message) => message.type === 'turn-start');
  candidates = runtimeMessages.filter((message) => message.type === 'dom-final-candidate');
  assert.ok(starts.length >= 2);
  assert.equal(new Set(starts.map((message) => message.completionId)).size, 2);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[1].payload.event.hasFinalAction, false);
  assert.equal(candidates[1].payload.event.finalEvidence, 'explicit-fast-stable');
  assert.equal(JSON.stringify(candidates[1]).includes('instant final answer'), false);

  // A fast switch from an existing Codex conversation to another task must
  // suspend this turn on its original route instead of moving it to the new one.
  now = 10_000;
  documentListeners.get('keydown')({
    key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    isComposing: false, keyCode: 13, target: composer,
  });
  await flushEffects();
  const switchedTurn = runtimeMessages
    .filter((message) => message.type === 'turn-start')
    .at(-1);
  const switchedCompletionId = switchedTurn.completionId;
  context.location.pathname = '/c/another-task';
  const staleRouteSample = await sampleNow({
    type: 'monitor-sample-now',
    pathHash: switchedTurn.pathHash,
    routeEpoch: switchedTurn.routeEpoch,
    completionId: switchedCompletionId,
  });
  assert.equal(staleRouteSample.stale, true);
  assert.equal(staleRouteSample.reason, 'route-not-mounted');
  assert.equal(staleRouteSample.sampled, undefined);
  assert.equal(runtimeMessages.some((message) => message.type === 'turn-move'), false);
  assert.equal(runtimeMessages.some((message) => (
    message.type === 'turn-suspend'
    && message.completionId === switchedCompletionId
    && message.pathHash === candidates[0].pathHash
  )), true);
});

test('a delayed route-enter response cannot replace a completion created after the handshake', async () => {
  const h = await createContentHarness({ pathname: '/c/race', deferInitialRouteEnter: true });
  h.setNow(10_000);
  h.pressEnter();
  await h.flush();

  assert.equal(h.runtimeMessages.some((message) => message.type === 'turn-start'), false);
  h.resolveInitialRoute({
    completionId: 'stale-route-completion',
    startedAt: 9_000,
    baselineUserCount: 0,
    baselineAssistantCount: 0,
    startSource: 'implicit',
    sawGenerating: false,
  });
  await h.flush();
  const firstStart = h.runtimeMessages.find((message) => message.type === 'turn-start');
  assert.ok(firstStart?.completionId);
  assert.notEqual(firstStart.completionId, 'stale-route-completion');

  h.setNow(10_100);
  h.page.userTurns = [makeTurn('new question', 'new-user')];
  h.page.generating = true;
  await h.sampleNow();
  h.setNow(10_300);
  h.page.assistantTurns = [makeTurn('partial answer', 'new-assistant')];
  await h.sampleNow();
  h.setNow(11_000);
  h.page.assistantTurns = [makeTurn('final answer', 'new-assistant')];
  h.page.generating = false;
  h.page.finalAction = true;
  await h.sampleNow();
  h.setNow(12_300);
  await h.sampleNow();

  const candidate = h.runtimeMessages.find((message) => message.type === 'dom-final-candidate');
  assert.equal(candidate?.completionId, firstStart.completionId);
  assert.equal(candidate?.completionId === 'stale-route-completion', false);
});

test('a placeholder route assignment suspends the old route and starts generation under the destination', async () => {
  const h = await createContentHarness({ pathname: '/' });
  h.setNow(2_000);
  h.pressEnter();
  h.setNow(2_100);
  h.page.userTurns = [makeTurn('new question', 'placeholder-user')];
  h.page.generating = true;
  await h.sampleNow();
  await h.flush();

  const original = h.runtimeMessages.find((message) => message.type === 'turn-start');
  assert.ok(original?.completionId);
  h.setPath('/c/generated-conversation');
  await h.sampleNow();
  await h.flush();
  h.setNow(2_200);
  await h.sampleNow();
  await h.flush();

  const destinationStart = h.runtimeMessages.find((message) => (
    message.type === 'turn-start'
    && message.completionId !== original.completionId
    && message.pathHash !== original.pathHash
  ));
  assert.ok(destinationStart?.completionId);
  assert.equal(h.runtimeMessages.some((message) => (
    message.type === 'turn-suspend'
    && message.completionId === original.completionId
    && message.pathHash === original.pathHash
  )), true);
  assert.equal(h.runtimeMessages.some((message) => message.type === 'turn-move'), false);
});

test('a programmatic switch to an existing conversation never adopts the placeholder completion', async () => {
  const h = await createContentHarness({ pathname: '/' });
  h.setNow(3_000);
  h.pressEnter();
  h.setNow(3_100);
  h.page.userTurns = [makeTurn('question from A', 'placeholder-user-a')];
  h.page.generating = true;
  await h.sampleNow();
  await h.flush();
  const original = h.runtimeMessages.find((message) => message.type === 'turn-start');
  assert.ok(original?.completionId);

  h.setPath('/c/existing-b');
  h.page.userTurns = [makeTurn('old question from B', 'existing-user-b')];
  h.page.assistantTurns = [makeTurn('old answer from B', 'existing-assistant-b')];
  h.page.generating = false;
  h.page.finalAction = true;
  await h.sampleNow();
  await h.flush();
  h.setNow(5_200);
  await h.sampleNow();
  await h.flush();
  h.setNow(7_000);
  await h.sampleNow();

  assert.equal(h.runtimeMessages.some((message) => message.type === 'turn-move'), false);
  assert.equal(h.runtimeMessages.some((message) => (
    message.type === 'turn-suspend'
    && message.completionId === original.completionId
    && message.pathHash === original.pathHash
  )), true);
  assert.equal(h.runtimeMessages.some((message) => (
    message.type === 'dom-final-candidate' && message.completionId === original.completionId
  )), false);
});

test('a previously completed destination does not adopt a still-generating source DOM', async () => {
  let routeEnterCount = 0;
  const h = await createContentHarness({
    pathname: '/c/a',
    routeEnterResponder() {
      routeEnterCount += 1;
      return { ok: true, pending: null, previouslyCompleted: routeEnterCount > 1 };
    },
  });
  h.setNow(2_000);
  h.pressEnter();
  h.setNow(2_100);
  h.page.userTurns = [makeTurn('question from A', 'user-a')];
  h.page.generating = true;
  await h.sampleNow();
  await h.flush();
  const sourceStart = h.runtimeMessages.find((message) => message.type === 'turn-start');
  assert.ok(sourceStart?.completionId);

  h.setPath('/c/b');
  await h.sampleNow();
  await h.flush();
  h.setNow(2_300);
  await h.sampleNow();

  const startIds = new Set(h.runtimeMessages
    .filter((message) => message.type === 'turn-start')
    .map((message) => message.completionId));
  assert.equal(startIds.size, 1);
  assert.equal(h.runtimeMessages.some((message) => (
    message.type === 'dom-final-candidate' && message.completionId === sourceStart.completionId
  )), false);
  assert.equal(routeEnterCount, 2);
});

test('clicking an existing conversation from the placeholder is not mistaken for a new-turn route move', async () => {
  const h = await createContentHarness({ pathname: '/' });
  h.setNow(3_000);
  h.pressEnter();
  h.setNow(3_100);
  h.page.userTurns = [makeTurn('new question', 'placeholder-user')];
  h.page.generating = true;
  await h.sampleNow();
  await h.flush();
  const original = h.runtimeMessages.find((message) => message.type === 'turn-start');
  assert.ok(original?.completionId);

  h.clickConversationLink('https://chatgpt.com/c/existing-conversation');
  h.setPath('/c/existing-conversation');
  await h.sampleNow();
  await h.flush();

  assert.equal(h.runtimeMessages.some((message) => message.type === 'turn-move'), false);
  assert.equal(h.runtimeMessages.some((message) => (
    message.type === 'turn-suspend' && message.completionId === original.completionId
  )), true);
});

test('route recovery accepts a changed same-count retry reply after stable final evidence', async () => {
  let routeEnterCount = 0;
  const pending = {
    completionId: 'same-count-retry',
    startedAt: 1_000,
    baselineUserCount: 1,
    baselineAssistantCount: 1,
    startSource: 'explicit',
    sawGenerating: false,
  };
  const h = await createContentHarness({
    pathname: '/c/a',
    routeEnterResponder() {
      routeEnterCount += 1;
      return { ok: true, pending: routeEnterCount === 2 ? null : pending };
    },
  });
  h.page.userTurns = [makeTurn('retry question', 'user-a')];
  h.page.assistantTurns = [makeTurn('previous answer', 'assistant-a')];
  h.page.finalAction = true;
  h.setNow(5_000);
  await h.sampleNow();
  await h.flush();

  h.setNow(6_000);
  h.setPath('/c/b');
  await h.sampleNow();
  await h.flush();
  h.setNow(7_000);
  h.setPath('/c/a');
  h.page.assistantTurns = [makeTurn('regenerated answer', 'assistant-a')];
  h.page.finalAction = true;
  await h.sampleNow();
  await h.flush();

  h.setNow(9_001);
  await h.sampleNow();
  h.setNow(10_201);
  await h.sampleNow();

  const candidate = h.runtimeMessages.find((message) => message.type === 'dom-final-candidate');
  assert.equal(candidate?.completionId, 'same-count-retry');
  assert.equal(candidate?.payload.event.finalEvidence, 'final-action');
  assert.equal(routeEnterCount, 3);
});

test('an active recovered route keeps its persisted completion id while generation is visible', async () => {
  const pending = {
    completionId: 'recovered-active-completion',
    startedAt: 1_000,
    baselineUserCount: 1,
    baselineAssistantCount: 0,
    startSource: 'explicit',
    sawGenerating: false,
  };
  const h = await createContentHarness({
    pathname: '/c/recovered',
    routeEnterResponder() { return { ok: true, pending }; },
  });
  h.page.userTurns = [makeTurn('recovered question', 'user-recovered')];
  h.page.generating = true;
  h.setNow(5_000);
  await h.sampleNow();
  await h.flush();

  assert.equal(h.runtimeMessages.some((message) => (
    message.type === 'turn-progress'
    && message.completionId === 'recovered-active-completion'
    && message.sawGenerating === true
  )), true);
  assert.equal(h.runtimeMessages.some((message) => (
    message.type === 'turn-start' && message.completionId !== 'recovered-active-completion'
  )), false);

  h.page.generating = false;
  h.page.assistantTurns = [makeTurn('the recovered answer', 'assistant-recovered')];
  h.page.finalAction = true;
  h.setNow(6_000);
  await h.sampleNow();
  h.setNow(7_300);
  await h.sampleNow();

  const candidate = h.runtimeMessages.find((message) => message.type === 'dom-final-candidate');
  assert.equal(candidate?.completionId, 'recovered-active-completion');
});

test('route recovery does not reuse an old final action after same-count regeneration stops', async () => {
  let routeEnterCount = 0;
  const pending = {
    completionId: 'same-count-unchanged',
    startedAt: 1_000,
    baselineUserCount: 1,
    baselineAssistantCount: 1,
    startSource: 'explicit',
    sawGenerating: true,
  };
  const h = await createContentHarness({
    pathname: '/c/a',
    routeEnterResponder() {
      routeEnterCount += 1;
      return { ok: true, pending: routeEnterCount === 2 ? null : pending };
    },
  });
  h.page.userTurns = [makeTurn('retry question', 'user-a')];
  h.page.assistantTurns = [makeTurn('previous answer', 'assistant-a')];
  h.page.finalAction = true;
  h.setNow(5_000);
  await h.sampleNow();
  await h.flush();

  h.setNow(6_000);
  h.setPath('/c/b');
  await h.sampleNow();
  await h.flush();
  h.setNow(7_000);
  h.setPath('/c/a');
  await h.sampleNow();
  await h.flush();
  h.setNow(9_001);
  await h.sampleNow();
  h.setNow(10_201);
  await h.sampleNow();

  assert.equal(h.runtimeMessages.some((message) => (
    message.type === 'dom-final-candidate' && message.completionId === 'same-count-unchanged'
  )), false);
  assert.equal(routeEnterCount, 3);
});
