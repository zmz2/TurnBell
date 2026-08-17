'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHATGPT_PATTERNS,
  isChatGPTURL,
  contentScriptFiles,
  summarizeInjectionResults,
  createMonitor,
} = require('../src/tab-monitor-core.js');

test('recognizes only supported HTTPS ChatGPT URLs', () => {
  for (const value of [
    'https://chatgpt.com/',
    'https://chatgpt.com/c/abc?model=gpt-5',
    'https://chat.openai.com/c/legacy',
  ]) {
    assert.equal(isChatGPTURL(value), true, value);
  }

  for (const value of [
    'http://chatgpt.com/',
    'https://chatgpt.com.evil.test/',
    'https://foo.chatgpt.com/path',
    'https://openai.com/',
    'edge://extensions/',
    'not a URL',
    '',
    null,
  ]) {
    assert.equal(isChatGPTURL(value), false, String(value));
  }
});

test('returns isolated-world scripts in dependency order and defensive copies', () => {
  const isolatedExpected = [
    'src/detector-core.js',
    'src/notification-core.js',
    'src/sample-scheduler-core.js',
    'src/bootstrap-core.js',
    'src/dom-model-core.js',
    'src/content.js',
  ];
  assert.deepEqual(contentScriptFiles(), isolatedExpected);
  const isolatedCopy = contentScriptFiles();
  isolatedCopy.pop();
  assert.deepEqual(contentScriptFiles(), isolatedExpected);
  assert.deepEqual(CHATGPT_PATTERNS, [
    'https://chatgpt.com/*',
    'https://chat.openai.com/*',
  ]);
});

test('summarizes full, partial, and invalid-tab injection results', () => {
  const tabs = [
    { id: 1, url: 'https://chatgpt.com/c/a' },
    { id: 2, url: 'https://chat.openai.com/c/b' },
    { id: undefined, url: 'https://chatgpt.com/c/c' },
    { id: 4, url: 'https://example.com/' },
  ];
  assert.deepEqual(
    summarizeInjectionResults(tabs, [{ tabId: 1, ok: true }, { tabId: 2, ok: false }]),
    { total: 2, active: 1, failed: 1 },
  );
  assert.deepEqual(summarizeInjectionResults([], []), { total: 0, active: 0, failed: 0 });
});

function fakeChrome({ tabs, injectionFailures = new Set(), inactiveTabs = new Set() }) {
  const calls = { query: [], execute: [], send: [] };
  const runtime = { lastError: null };
  return {
    calls,
    runtime,
    tabs: {
      query(queryInfo, callback) {
        calls.query.push(queryInfo);
        runtime.lastError = null;
        callback(tabs);
      },
      sendMessage(tabId, message, callback) {
        calls.send.push({ tabId, message });
        if (inactiveTabs.has(tabId)) {
          runtime.lastError = { message: 'Receiving end does not exist' };
          callback(undefined);
          runtime.lastError = null;
          return;
        }
        runtime.lastError = null;
        callback({ ok: true, active: true });
      },
    },
    scripting: {
      executeScript(details, callback) {
        calls.execute.push(details);
        const tabId = details.target.tabId;
        if (injectionFailures.has(tabId)) {
          runtime.lastError = { message: 'tab closed' };
          callback(undefined);
          runtime.lastError = null;
          return;
        }
        runtime.lastError = null;
        callback([{ frameId: 0, result: null }]);
      },
    },
  };
}

test('injects all already-open matching tabs and isolates partial failures', async () => {
  const chromeAPI = fakeChrome({
    tabs: [
      { id: 11, url: 'https://chatgpt.com/c/a' },
      { id: 12, url: 'https://chat.openai.com/c/b' },
      { id: 13, url: 'https://example.com/' },
    ],
    injectionFailures: new Set([12]),
  });
  const monitor = createMonitor(chromeAPI);

  const status = await monitor.injectExistingTabs();

  assert.deepEqual(status, { total: 2, active: 1, failed: 1 });
  assert.deepEqual(chromeAPI.calls.query, [{ url: CHATGPT_PATTERNS }]);
  assert.deepEqual(chromeAPI.calls.execute, [
    { target: { tabId: 11 }, files: contentScriptFiles(), world: 'ISOLATED', injectImmediately: true },
    { target: { tabId: 12 }, files: contentScriptFiles(), world: 'ISOLATED', injectImmediately: true },
  ]);
});

test('reports how many matching tabs currently answer the detector ping', async () => {
  const chromeAPI = fakeChrome({
    tabs: [
      { id: 21, url: 'https://chatgpt.com/c/a' },
      { id: 22, url: 'https://chatgpt.com/c/b' },
    ],
    inactiveTabs: new Set([22]),
  });
  const monitor = createMonitor(chromeAPI);

  const status = await monitor.getStatus();

  assert.deepEqual(status, { total: 2, active: 1, failed: 1 });
  assert.deepEqual(chromeAPI.calls.send, [
    { tabId: 21, message: { type: 'monitor-ping' } },
    { tabId: 22, message: { type: 'monitor-ping' } },
  ]);
});
