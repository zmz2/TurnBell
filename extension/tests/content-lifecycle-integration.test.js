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
  failedCandidateResponses = 0,
  suppressedCandidateResponses = 0,
  failedRouteEnterResponses = 0,
} = {}) {
  let now = 0;
  let runtimeListener = null;
  let observer = null;
  let deferredRouteEnter = null;
  let remainingFailedCandidateResponses = Math.max(0, Number(failedCandidateResponses) || 0);
  let remainingSuppressedCandidateResponses = Math.max(0, Number(suppressedCandidateResponses) || 0);
  let remainingFailedRouteEnterResponses = Math.max(0, Number(failedRouteEnterResponses) || 0);
  let nextTimerId = 1;
  const timers = new Map();
  let storageChangeListener = null;
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
    setTimeout(callback, delay = 0) {
      const id = nextTimerId++;
      timers.set(id, { callback, at: now + Number(delay || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
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
        let response;
        if (message.type === 'route-enter' && remainingFailedRouteEnterResponses > 0) {
          remainingFailedRouteEnterResponses -= 1;
          response = { ok: false, error: 'temporary-route-storage-error' };
        } else if (message.type === 'route-enter' && routeEnterResponder) {
          response = routeEnterResponder(message);
        } else if (message.type === 'turn-move') {
          response = {
            ok: true,
            pending: {
              completionId: message.completionId,
              startedAt: 2_000,
              baselineUserCount: 0,
              baselineAssistantCount: 0,
              startSource: 'explicit',
              sawGenerating: false,
            },
          };
        } else if (message.type === 'dom-final-candidate' && remainingFailedCandidateResponses > 0) {
          remainingFailedCandidateResponses -= 1;
          response = { ok: false, error: 'temporary-storage-error' };
        } else if (message.type === 'dom-final-candidate' && remainingSuppressedCandidateResponses > 0) {
          remainingSuppressedCandidateResponses -= 1;
          response = {
            ok: true, suppressed: true, reason: 'stale-route-epoch', notificationStatus: 'suppressed',
          };
        } else if (message.type === 'dom-final-candidate') {
          response = { ok: true, notificationStatus: 'delivered' };
        } else {
          response = { ok: true, pending: null };
        }
        callback?.(response);
      },
      onMessage: { addListener(listener) { runtimeListener = listener; } },
    },
    storage: {
      sync: { get(defaults, callback) { callback(defaults); } },
      onChanged: { addListener(listener) { storageChangeListener = listener; } },
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
    setFailedCandidateResponses(value) {
      remainingFailedCandidateResponses = Math.max(0, Number(value) || 0);
    },
    setFailedRouteEnterResponses(value) {
      remainingFailedRouteEnterResponses = Math.max(0, Number(value) || 0);
    },
    changeSyncSettings(changes) { storageChangeListener?.(changes, 'sync'); },
    async runTimers() {
      let ran = false;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        timer.callback();
        ran = true;
        await flushEffects(8);
      }
      return ran;
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
        callback?.(message.type === 'dom-final-candidate'
          ? { ok: true, notificationStatus: 'delivered' }
          : { ok: true });
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

test('a placeholder route assignment migrates the explicitly submitted turn with its shared user node', async () => {
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

  const migration = h.runtimeMessages.find((message) => message.type === 'turn-move');
  assert.equal(migration?.completionId, original.completionId);
  assert.equal(migration?.routeMoveEvidence, 'shared-user-turn-node');
  assert.equal(h.runtimeMessages.some((message) => (
    message.type === 'turn-suspend'
    && message.completionId === original.completionId
    && message.pathHash === original.pathHash
  )), true);
  assert.equal(h.runtimeMessages.filter((message) => message.type === 'turn-move').length, 1);
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

test('same-count route recovery trusts persisted evidence that generation replaced the old final action', async () => {
  let routeEnterCount = 0;
  const pending = {
    completionId: 'same-count-with-live-generation',
    startedAt: 1_000,
    baselineUserCount: 1,
    baselineAssistantCount: 1,
    startSource: 'explicit',
    sawGenerating: true,
    sawGeneratingWithoutFinalAction: true,
  };
  const h = await createContentHarness({
    pathname: '/c/a',
    routeEnterResponder() {
      routeEnterCount += 1;
      return { ok: true, pending: routeEnterCount === 1 || routeEnterCount === 3 ? pending : null };
    },
  });
  h.page.userTurns = [makeTurn('question', 'user-a')];
  h.page.assistantTurns = [makeTurn('same final answer', 'assistant-a')];
  h.page.finalAction = true;
  h.setNow(5_000);
  await h.sampleNow();
  await h.flush();
  assert.equal(h.runtimeMessages.some((message) => message.type === 'dom-final-candidate'), false);

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

  const candidate = h.runtimeMessages.find((message) => message.type === 'dom-final-candidate');
  assert.equal(candidate?.completionId, pending.completionId);
  assert.equal(routeEnterCount, 3);
});

test('a changed no-action answer breaks route-recovery stability before an old answer returns', async () => {
  let routeEnterCount = 0;
  const pending = {
    completionId: 'recovery-stability-reset',
    startedAt: 1_000,
    baselineUserCount: 1,
    baselineAssistantCount: 0,
    startSource: 'explicit',
    sawGenerating: true,
  };
  const h = await createContentHarness({
    pathname: '/c/a',
    routeEnterResponder() {
      routeEnterCount += 1;
      return { ok: true, pending: routeEnterCount === 3 ? pending : null };
    },
  });
  h.page.userTurns = [makeTurn('question', 'user-a')];
  h.page.assistantTurns = [makeTurn('answer X', 'assistant-a')];
  h.page.finalAction = true;
  h.setNow(5_000);
  await h.sampleNow();
  await h.flush();

  h.setNow(5_100);
  h.setPath('/c/b');
  await h.sampleNow();
  await h.flush();
  h.setNow(7_100);
  h.page.assistantTurns = [makeTurn('answer Y', 'assistant-a')];
  h.page.finalAction = false;
  h.setPath('/c/a');
  await h.sampleNow();
  await h.flush();
  await h.sampleNow();
  h.setNow(9_101);
  await h.sampleNow();
  assert.equal(h.runtimeMessages.some((message) => message.type === 'dom-final-candidate'), false);

  h.setNow(9_301);
  h.page.assistantTurns = [makeTurn('answer X', 'assistant-a')];
  h.page.finalAction = true;
  await h.sampleNow();
  h.setNow(10_401);
  await h.sampleNow();
  assert.equal(h.runtimeMessages.some((message) => message.type === 'dom-final-candidate'), false);
  h.setNow(10_501);
  await h.sampleNow();

  assert.equal(h.runtimeMessages.some((message) => (
    message.type === 'dom-final-candidate' && message.completionId === pending.completionId
  )), true);
  assert.equal(routeEnterCount, 3);
});

test('a source conversation stop control cannot start a turn on a new route while its DOM is still mounted', async () => {
  const h = await createContentHarness({ pathname: '/c/source' });
  h.setNow(1_000);
  h.pressEnter();
  h.setNow(1_100);
  h.page.userTurns = [makeTurn('source question', 'source-user')];
  h.page.assistantTurns = [makeTurn('partial source answer', 'source-assistant')];
  h.page.generating = true;
  await h.sampleNow();
  await h.flush();
  const sourceStart = h.runtimeMessages.find((message) => message.type === 'turn-start');
  assert.ok(sourceStart?.completionId);

  h.setNow(1_500);
  h.setPath('/c/destination');
  await h.sampleNow();
  await h.flush();
  h.setNow(2_000);
  await h.sampleNow();
  assert.equal(new Set(h.runtimeMessages
    .filter((message) => message.type === 'turn-start')
    .map((message) => message.completionId)).size, 1);
  assert.equal(h.runtimeMessages.some((message) => message.type === 'dom-final-candidate'), false);

  h.page.userTurns = [makeTurn('destination history', 'destination-user')];
  h.page.assistantTurns = [makeTurn('destination history answer', 'destination-assistant')];
  h.page.generating = false;
  h.page.finalAction = true;
  h.setNow(4_000);
  await h.sampleNow();
  h.setNow(4_101);
  await h.sampleNow();
  assert.equal(new Set(h.runtimeMessages
    .filter((message) => message.type === 'turn-start')
    .map((message) => message.completionId)).size, 1);

  h.setNow(4_200);
  h.pressEnter();
  h.setNow(4_300);
  h.page.userTurns = [...h.page.userTurns, makeTurn('destination live question', 'destination-live-user')];
  h.page.generating = true;
  h.page.finalAction = false;
  await h.sampleNow();
  assert.equal(new Set(h.runtimeMessages
    .filter((message) => message.type === 'turn-start')
    .map((message) => message.completionId)).size, 2);
});

test('an explicit destination turn releases the route guard while source DOM remains mounted', async () => {
  const h = await createContentHarness({ pathname: '/c/source-explicit' });
  h.setNow(1_000);
  h.pressEnter();
  h.setNow(1_100);
  const sourceUser = makeTurn('source question', 'source-explicit-user');
  const sourceAssistant = makeTurn('source partial answer', 'source-explicit-assistant');
  h.page.userTurns = [sourceUser];
  h.page.assistantTurns = [sourceAssistant];
  h.page.generating = true;
  await h.sampleNow();
  await h.flush();

  h.setNow(1_500);
  h.setPath('/c/destination-explicit');
  await h.sampleNow();
  await h.flush();
  h.setNow(2_000);
  h.pressEnter();
  await h.flush();
  const destinationCompletionId = h.runtimeMessages
    .filter((message) => message.type === 'turn-start')
    .at(-1)?.completionId;
  assert.ok(destinationCompletionId);

  const destinationUser = makeTurn('destination question', 'destination-explicit-user');
  const destinationAssistant = makeTurn('destination answer', 'destination-explicit-assistant');
  h.page.userTurns = [sourceUser, destinationUser];
  h.page.assistantTurns = [sourceAssistant, destinationAssistant];
  h.page.generating = true;
  h.page.finalAction = false;
  h.setNow(2_100);
  await h.sampleNow();
  assert.equal(h.runtimeMessages.some((message) => (
    message.type === 'turn-progress' && message.completionId === destinationCompletionId
  )), true);

  h.page.generating = false;
  h.page.finalAction = true;
  h.setNow(3_000);
  await h.sampleNow();
  h.setNow(4_201);
  await h.sampleNow();
  assert.equal(h.runtimeMessages.some((message) => (
    message.type === 'dom-final-candidate' && message.completionId === destinationCompletionId
  )), true);
});

test('a stale route document claim keeps its DOM silent after the background rejects it', async () => {
  const h = await createContentHarness({
    pathname: '/c/stale-document',
    routeEnterResponder() {
      return { ok: true, pending: null, reason: 'stale-document-claim' };
    },
  });
  h.setNow(1_000);
  h.page.userTurns = [makeTurn('old route question', 'old-route-user')];
  h.page.assistantTurns = [makeTurn('old route answer', 'old-route-assistant')];
  h.page.generating = true;
  await h.sampleNow();
  await h.flush();

  assert.equal(h.runtimeMessages.some((message) => message.type === 'turn-start'), false);
  assert.equal(h.runtimeMessages.some((message) => message.type === 'dom-final-candidate'), false);
});

test('a failed first candidate handoff is retried with its original completion id', async () => {
  const h = await createContentHarness({ pathname: '/c/retry-candidate', failedCandidateResponses: 1 });
  h.setNow(1_000);
  h.pressEnter();
  h.setNow(1_100);
  h.page.userTurns = [makeTurn('retry question', 'retry-user')];
  h.page.generating = true;
  await h.sampleNow();
  h.setNow(1_300);
  h.page.assistantTurns = [makeTurn('partial answer', 'retry-assistant')];
  await h.sampleNow();
  h.setNow(2_000);
  h.page.assistantTurns = [makeTurn('final answer', 'retry-assistant')];
  h.page.generating = false;
  h.page.finalAction = true;
  await h.sampleNow();
  h.setNow(3_201);
  await h.sampleNow();
  await h.flush();

  const first = h.runtimeMessages.filter((message) => message.type === 'dom-final-candidate');
  assert.equal(first.length, 1);
  const completionId = first[0].completionId;
  h.setNow(4_701);
  await h.sampleNow();
  await h.flush();

  const retries = h.runtimeMessages.filter((message) => message.type === 'dom-final-candidate');
  assert.equal(retries.length, 2);
  assert.equal(retries[1].completionId, completionId);
  assert.equal(new Set(h.runtimeMessages
    .filter((message) => message.type === 'turn-start')
    .map((message) => message.completionId)).size, 1);
});

test('placeholder Instant replies migrate when the submitted user node survives URL assignment', async () => {
  const h = await createContentHarness({ pathname: '/' });
  h.setNow(1_000);
  h.pressEnter();
  h.setNow(1_100);
  h.page.userTurns = [makeTurn('instant question', 'instant-user')];
  h.page.assistantTurns = [makeTurn('instant answer', 'instant-assistant')];
  h.page.generating = false;
  h.page.finalAction = false;
  await h.sampleNow();
  await h.flush();
  const sourceStart = h.runtimeMessages.find((message) => message.type === 'turn-start');
  assert.ok(sourceStart?.completionId);

  h.setNow(1_300);
  h.setPath('/c/generated-instant');
  await h.sampleNow();
  await h.flush();
  const migration = h.runtimeMessages.find((message) => message.type === 'turn-move');
  assert.equal(migration?.completionId, sourceStart.completionId);

  h.setNow(1_400);
  await h.sampleNow();
  h.setNow(7_401);
  await h.sampleNow();
  h.setNow(10_401);
  await h.sampleNow();
  const candidate = h.runtimeMessages.find((message) => message.type === 'dom-final-candidate');
  assert.equal(candidate?.completionId, sourceStart.completionId);
  assert.equal(candidate?.payload.event.finalEvidence, 'explicit-fast-stable');
});

test('placeholder turns do not migrate when a conversation link was clicked', async () => {
  const h = await createContentHarness({ pathname: '/' });
  h.setNow(1_000);
  h.pressEnter();
  h.setNow(1_100);
  h.page.userTurns = [makeTurn('instant question', 'instant-user')];
  h.page.generating = true;
  await h.sampleNow();
  await h.flush();
  h.setNow(1_200);
  h.clickConversationLink('https://chatgpt.com/c/existing');
  h.setPath('/c/existing');
  await h.sampleNow();
  await h.flush();
  assert.equal(h.runtimeMessages.some((message) => message.type === 'turn-move'), false);
});

test('returning to a pending route waits for departed historical DOM to be replaced', async () => {
  let routeEnterCount = 0;
  const pendingA = {
    completionId: 'pending-a',
    startedAt: 1_000,
    baselineUserCount: 1,
    baselineAssistantCount: 1,
    startSource: 'implicit',
    sawGenerating: true,
    sawGeneratingWithoutFinalAction: true,
  };
  const h = await createContentHarness({
    pathname: '/c/B',
    routeEnterResponder() {
      routeEnterCount += 1;
      return { ok: true, pending: routeEnterCount === 2 ? pendingA : null };
    },
  });
  h.setNow(3_000);
  h.page.userTurns = [makeTurn('B question', 'b-user')];
  h.page.assistantTurns = [makeTurn('same historical reply', 'b-assistant')];
  h.page.finalAction = true;
  await h.sampleNow();

  h.setNow(4_000);
  h.setPath('/c/A');
  await h.sampleNow();
  await h.flush();
  h.setNow(6_500);
  await h.sampleNow();
  assert.equal(h.runtimeMessages.some((message) => message.type === 'dom-final-candidate'), false);

  // A has the same counts and visible reply text as B, but distinct DOM nodes.
  h.page.userTurns = [makeTurn('A question', 'a-user')];
  h.page.assistantTurns = [makeTurn('same historical reply', 'a-assistant')];
  h.page.finalAction = true;
  h.setNow(7_000);
  await h.sampleNow();
  h.setNow(9_000);
  await h.sampleNow();
  const candidate = h.runtimeMessages.find((message) => message.type === 'dom-final-candidate');
  assert.equal(candidate?.completionId, pendingA.completionId);
});

test('a departed generating route does not mask the destination route generation', async () => {
  let routeEnterCount = 0;
  const pendingA = {
    completionId: 'pending-generating-a',
    startedAt: 1_000,
    baselineUserCount: 1,
    baselineAssistantCount: 1,
    startSource: 'implicit',
    sawGenerating: false,
    sawGeneratingWithoutFinalAction: false,
  };
  const h = await createContentHarness({
    pathname: '/c/B',
    routeEnterResponder() {
      routeEnterCount += 1;
      return { ok: true, pending: routeEnterCount === 2 ? pendingA : null };
    },
  });
  h.setNow(3_000);
  h.page.userTurns = [makeTurn('B question', 'b-user')];
  h.page.assistantTurns = [makeTurn('B active answer', 'b-assistant')];
  h.page.generating = true;
  await h.sampleNow();

  h.setPath('/c/A');
  h.setNow(3_100);
  await h.sampleNow();
  await h.flush();
  h.page.userTurns = [makeTurn('A question', 'a-user')];
  h.page.assistantTurns = [makeTurn('same reply', 'a-assistant')];
  h.page.generating = true;
  h.page.finalAction = false;
  h.setNow(6_000);
  await h.sampleNow();

  assert.equal(h.runtimeMessages.some((message) => (
    message.type === 'turn-progress'
    && message.completionId === pendingA.completionId
    && message.sawGeneratingWithoutFinalAction === true
  )), true);

  h.setNow(7_000);
  h.page.generating = false;
  h.page.finalAction = true;
  await h.sampleNow();
  h.setNow(9_000);
  await h.sampleNow();
  assert.equal(h.runtimeMessages.some((message) => (
    message.type === 'dom-final-candidate' && message.completionId === pendingA.completionId
  )), true);
});

test('a stale-epoch candidate rejection remains queued and is rebased on route recovery', async () => {
  let routeEnterCount = 0;
  let completionId = '';
  const h = await createContentHarness({
    pathname: '/c/A',
    suppressedCandidateResponses: 1,
    routeEnterResponder() {
      routeEnterCount += 1;
      if (routeEnterCount === 3 && completionId) {
        return {
          ok: true,
          pending: {
            completionId,
            startedAt: 1_000,
            baselineUserCount: 0,
            baselineAssistantCount: 0,
            startSource: 'explicit',
            sawGenerating: true,
            sawGeneratingWithoutFinalAction: true,
          },
        };
      }
      return { ok: true, pending: null };
    },
  });
  h.setNow(1_000);
  h.pressEnter();
  h.setNow(1_100);
  h.page.userTurns = [makeTurn('A question', 'a-user')];
  h.page.generating = true;
  await h.sampleNow();
  completionId = h.runtimeMessages.find((message) => message.type === 'turn-start')?.completionId || '';
  assert.ok(completionId);

  h.setNow(1_300);
  h.page.assistantTurns = [makeTurn('partial A reply', 'a-assistant')];
  await h.sampleNow();
  h.setNow(2_000);
  h.page.assistantTurns = [makeTurn('final A reply', 'a-assistant')];
  h.page.generating = false;
  h.page.finalAction = true;
  await h.sampleNow();
  h.setNow(3_300);
  await h.sampleNow();
  const firstCandidate = h.runtimeMessages.filter((message) => message.type === 'dom-final-candidate')[0];
  assert.equal(firstCandidate?.completionId, completionId);
  assert.equal(firstCandidate?.routeEpoch, 1);

  h.setNow(3_400);
  h.setPath('/c/B');
  await h.sampleNow();
  await h.flush();
  h.page.userTurns = [makeTurn('B history', 'b-user')];
  h.page.assistantTurns = [makeTurn('B answer', 'b-assistant')];
  h.page.finalAction = true;
  h.setNow(3_500);
  await h.sampleNow();

  h.setNow(3_600);
  h.setPath('/c/A');
  await h.sampleNow();
  await h.flush();
  const candidates = h.runtimeMessages.filter((message) => message.type === 'dom-final-candidate');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[1].completionId, completionId);
  assert.equal(candidates[1].routeEpoch, 3);
});

test('placeholder Instant completion migrates when user, answer, and URL appear in one sample', async () => {
  const h = await createContentHarness({ pathname: '/' });
  h.setNow(1_000);
  h.pressEnter();
  await h.flush();
  const start = h.runtimeMessages.find((message) => message.type === 'turn-start');
  assert.ok(start?.completionId);

  h.setNow(1_100);
  h.page.userTurns = [makeTurn('instant question', 'instant-user')];
  h.page.assistantTurns = [makeTurn('instant answer', 'instant-assistant')];
  h.page.finalAction = false;
  h.setPath('/c/instant-batch');
  await h.sampleNow();
  await h.flush();
  const move = h.runtimeMessages.find((message) => message.type === 'turn-move');
  assert.equal(move?.completionId, start.completionId);

  h.setNow(4_200);
  await h.sampleNow();
  h.setNow(7_300);
  await h.sampleNow();
  const candidate = h.runtimeMessages.find((message) => message.type === 'dom-final-candidate');
  assert.equal(candidate?.completionId, start.completionId);
  assert.equal(candidate?.payload.event.finalEvidence, 'explicit-fast-stable');
});

test('a failed route-enter handshake retries instead of baselining a pending completion away', async () => {
  const pending = {
    completionId: 'pending-after-handshake-error',
    startedAt: 1_000,
    baselineUserCount: 0,
    baselineAssistantCount: 0,
    startSource: 'implicit',
    sawGenerating: false,
    sawGeneratingWithoutFinalAction: false,
  };
  const h = await createContentHarness({
    pathname: '/c/retry-handshake',
    failedRouteEnterResponses: 1,
    routeEnterResponder: () => ({ ok: true, pending }),
  });
  h.page.userTurns = [makeTurn('question', 'question')];
  h.page.assistantTurns = [makeTurn('answer', 'answer')];
  h.page.finalAction = true;
  h.setNow(5_000);
  await h.sampleNow();
  assert.equal(h.runtimeMessages.filter((message) => message.type === 'route-enter').length, 1);
  assert.equal(h.runtimeMessages.some((message) => message.type === 'dom-final-candidate'), false);

  assert.equal(await h.runTimers(), true);
  await h.flush();
  assert.equal(h.runtimeMessages.filter((message) => message.type === 'route-enter').length, 2);
  h.setNow(6_500);
  await h.sampleNow();
  h.setNow(8_000);
  await h.sampleNow();
  assert.equal(h.runtimeMessages.some((message) => (
    message.type === 'dom-final-candidate'
    && message.completionId === pending.completionId
  )), true);
});

test('changing an unrelated setting keeps an explicitly armed Instant wait alive', async () => {
  const h = await createContentHarness({ pathname: '/c/settings-wait' });
  h.setNow(1_000);
  h.pressEnter();
  await h.flush();
  h.setNow(1_100);
  h.page.userTurns = [makeTurn('instant question', 'settings-user')];
  await h.sampleNow();

  h.changeSyncSettings({ sound: { newValue: false } });
  h.setNow(5_000);
  h.page.assistantTurns = [makeTurn('instant answer', 'settings-assistant')];
  h.page.finalAction = false;
  await h.sampleNow();
  h.setNow(8_100);
  await h.sampleNow();

  const candidate = h.runtimeMessages.find((message) => message.type === 'dom-final-candidate');
  assert.ok(candidate?.completionId);
  assert.equal(candidate.payload.event.finalEvidence, 'explicit-fast-stable');
});
