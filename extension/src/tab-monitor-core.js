'use strict';

(function exposeTabMonitorCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.GPTReplyTabMonitor = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function tabMonitorFactory() {
  const CHATGPT_PATTERNS = Object.freeze([
    'https://chatgpt.com/*',
    'https://chat.openai.com/*',
  ]);

  const CONTENT_SCRIPT_FILES = Object.freeze([
    'src/detector-core.js',
    'src/notification-core.js',
    'src/sample-scheduler-core.js',
    'src/bootstrap-core.js',
    'src/dom-model-core.js',
    'src/content.js',
  ]);

  function isChatGPTURL(value) {
    try {
      const parsed = new URL(String(value ?? ''));
      const host = parsed.hostname.toLowerCase();
      return parsed.protocol === 'https:' && (
        host === 'chatgpt.com' || host === 'chat.openai.com'
      );
    } catch {
      return false;
    }
  }

  function contentScriptFiles() {
    return [...CONTENT_SCRIPT_FILES];
  }

  function matchingTabs(tabs) {
    return Array.isArray(tabs)
      ? tabs.filter((tab) => (
        Number.isInteger(tab?.id)
        && tab.id >= 0
        && (tab.url === undefined || isChatGPTURL(tab.url))
      ))
      : [];
  }

  function summarizeInjectionResults(tabs, results) {
    const validTabs = matchingTabs(tabs);
    const successful = new Set(
      (Array.isArray(results) ? results : [])
        .filter((result) => result?.ok === true && Number.isInteger(result.tabId))
        .map((result) => result.tabId),
    );
    const active = validTabs.reduce((count, tab) => count + (successful.has(tab.id) ? 1 : 0), 0);
    return { total: validTabs.length, active, failed: Math.max(0, validTabs.length - active) };
  }

  function createMonitor(chromeAPI) {
    if (!chromeAPI?.tabs?.query || !chromeAPI?.tabs?.sendMessage || !chromeAPI?.scripting?.executeScript) {
      throw new TypeError('Chrome tabs and scripting APIs are required');
    }

    function lastErrorMessage() {
      return chromeAPI.runtime?.lastError?.message
        ? String(chromeAPI.runtime.lastError.message)
        : '';
    }

    function queryMatchingTabs() {
      return new Promise((resolve) => {
        try {
          chromeAPI.tabs.query({ url: [...CHATGPT_PATTERNS] }, (tabs) => {
            resolve(lastErrorMessage() ? [] : matchingTabs(tabs));
          });
        } catch {
          resolve([]);
        }
      });
    }

    function injectTab(tabId) {
      return new Promise((resolve) => {
        try {
          chromeAPI.scripting.executeScript({
            target: { tabId },
            files: contentScriptFiles(),
            world: 'ISOLATED',
            injectImmediately: true,
          }, () => {
            const error = lastErrorMessage();
            resolve({ tabId, ok: !error, error });
          });
        } catch (error) {
          resolve({ tabId, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    }

    function pingTab(tabId) {
      return new Promise((resolve) => {
        try {
          chromeAPI.tabs.sendMessage(tabId, { type: 'monitor-ping' }, (response) => {
            const error = lastErrorMessage();
            resolve({
              tabId,
              ok: !error && response?.ok === true && response?.active === true,
              error,
            });
          });
        } catch (error) {
          resolve({ tabId, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    }

    async function injectExistingTabs() {
      const tabs = await queryMatchingTabs();
      const results = await Promise.all(tabs.map((tab) => injectTab(tab.id)));
      return summarizeInjectionResults(tabs, results);
    }

    async function getStatus() {
      const tabs = await queryMatchingTabs();
      const results = await Promise.all(tabs.map((tab) => pingTab(tab.id)));
      return summarizeInjectionResults(tabs, results);
    }

    return Object.freeze({ queryMatchingTabs, injectExistingTabs, getStatus });
  }

  return Object.freeze({
    CHATGPT_PATTERNS,
    contentScriptFiles,
    createMonitor,
    isChatGPTURL,
    summarizeInjectionResults,
  });
}));
