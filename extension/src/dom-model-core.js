'use strict';

(function exposeDOMModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.TurnBellDOMModel = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function domModelFactory() {
  const ASSISTANT_SELECTORS = Object.freeze([
    '[data-message-author-role="assistant"]',
    'article[data-turn="assistant"]',
    '[data-author="assistant"]',
    '[data-testid^="conversation-turn-"] [data-message-author-role="assistant"]',
    'article [data-message-author-role="assistant"]',
  ]);

  const USER_SELECTORS = Object.freeze([
    '[data-message-author-role="user"]',
    'article[data-turn="user"]',
    '[data-author="user"]',
    '[data-testid^="conversation-turn-"] [data-message-author-role="user"]',
    'article [data-message-author-role="user"]',
  ]);

  const FINAL_ACTION_SELECTORS = Object.freeze([
    'button[data-testid="copy-turn-action-button"]',
    'button[data-testid="good-response-turn-action-button"]',
    'button[data-testid="bad-response-turn-action-button"]',
    'button[data-testid="voice-play-turn-action-button"]',
    'button[data-testid$="turn-action-button"]',
    'button[data-testid*="copy" i]',
    'button[aria-label*="copy response" i]',
    'button[aria-label="Copy" i]',
    'button[aria-label*="复制"]',
    'button[aria-label*="read aloud" i]',
    'button[aria-label*="朗读"]',
    'button[aria-label*="good response" i]',
    'button[aria-label*="bad response" i]',
    'button[aria-label*="赞"]',
    'button[aria-label*="踩"]',
  ]);

  const TURN_CONTAINER_SELECTORS = Object.freeze([
    'article[data-testid^="conversation-turn-"]',
    '[data-testid^="conversation-turn-"]',
    'article[data-turn]',
    'article',
    '[data-turn]',
  ]);

  function normalizeText(value, maximum = 50_000) {
    return String(value ?? '')
      .replace(/\u00a0/gu, ' ')
      .replace(/[ \t]+\n/gu, '\n')
      .trim()
      .slice(-maximum);
  }

  function textOf(element) {
    return normalizeText(element?.innerText || element?.textContent || '');
  }

  function fingerprint(value) {
    const text = String(value ?? '');
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function turnContainer(element) {
    if (!element?.closest) return element || null;
    for (const selector of TURN_CONTAINER_SELECTORS) {
      const container = element.closest(selector);
      if (container) return container;
    }
    return element || null;
  }

  function identityOf(element, container = turnContainer(element)) {
    for (const candidate of [element, container]) {
      if (!candidate?.getAttribute) continue;
      for (const name of ['data-message-id', 'id', 'data-testid']) {
        const value = normalizeText(candidate.getAttribute(name), 180);
        if (value) return `${name}:${value}`;
      }
    }
    return '';
  }

  function compareContainers(left, right) {
    if (left === right) return 0;
    if (typeof left?.compareDocumentPosition === 'function') {
      const relation = left.compareDocumentPosition(right);
      if (relation & 4) return -1; // DOCUMENT_POSITION_FOLLOWING
      if (relation & 2) return 1; // DOCUMENT_POSITION_PRECEDING
    }
    const leftOrder = Number(left?.order);
    const rightOrder = Number(right?.order);
    if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder)) return leftOrder - rightOrder;
    return 0;
  }

  function collectTurns(documentObject, selectors) {
    const grouped = new Map();
    let discoveryIndex = 0;
    for (const selector of selectors || []) {
      let elements = [];
      try {
        elements = [...(documentObject?.querySelectorAll?.(selector) || [])];
      } catch {
        elements = [];
      }
      for (const element of elements) {
        if (!element || element.isConnected === false) continue;
        const container = turnContainer(element) || element;
        const text = textOf(element);
        const existing = grouped.get(container);
        if (!existing) {
          grouped.set(container, {
            container,
            element,
            text,
            identity: identityOf(element, container),
            discoveryIndex: discoveryIndex++,
          });
          continue;
        }
        if (text.length > existing.text.length) {
          existing.element = element;
          existing.text = text;
          existing.identity = identityOf(element, container) || existing.identity;
        }
      }
    }

    return [...grouped.values()].sort((left, right) => {
      const byDOM = compareContainers(left.container, right.container);
      return byDOM || left.discoveryIndex - right.discoveryIndex;
    });
  }

  function roleFromContainer(container) {
    if (!container) return '';
    for (const name of ['data-message-author-role', 'data-author', 'data-turn']) {
      const value = normalizeText(container.getAttribute?.(name), 40).toLowerCase();
      if (value === 'assistant' || value === 'user') return value;
    }
    for (const role of ['assistant', 'user']) {
      const selectors = [
        `[data-message-author-role="${role}"]`,
        `[data-author="${role}"]`,
        `[data-turn="${role}"]`,
      ];
      for (const selector of selectors) {
        try {
          if (container.querySelector?.(selector)) return role;
        } catch {
          // Ignore selectors unsupported by an older browser.
        }
      }
    }
    return '';
  }

  function collectContainers(documentObject) {
    const containers = new Map();
    let discoveryIndex = 0;
    for (const selector of TURN_CONTAINER_SELECTORS) {
      let elements = [];
      try {
        elements = [...(documentObject?.querySelectorAll?.(selector) || [])];
      } catch {
        elements = [];
      }
      for (const element of elements) {
        if (!element || element.isConnected === false) continue;
        const container = turnContainer(element) || element;
        if (!containers.has(container)) containers.set(container, { container, discoveryIndex: discoveryIndex++ });
      }
    }
    return [...containers.values()].sort((left, right) => {
      const byDOM = compareContainers(left.container, right.container);
      return byDOM || left.discoveryIndex - right.discoveryIndex;
    });
  }

  function collectAssistantTurns(documentObject) {
    const explicit = collectTurns(documentObject, ASSISTANT_SELECTORS);
    const byContainer = new Map(explicit.map((turn) => [turn.container, turn]));
    const knownUsers = new Set(collectTurns(documentObject, USER_SELECTORS).map((turn) => turn.container));

    for (const { container, discoveryIndex } of collectContainers(documentObject)) {
      if (byContainer.has(container) || knownUsers.has(container)) continue;
      const role = roleFromContainer(container);
      if (role === 'user') continue;
      const hasAssociatedFinalAction = hasFinalActionForTurn(
        documentObject,
        { container, element: container },
        FINAL_ACTION_SELECTORS,
      );
      if (role !== 'assistant' && !hasAssociatedFinalAction) continue;
      const text = textOf(container);
      if (!text) continue;
      byContainer.set(container, {
        container,
        element: container,
        text,
        identity: identityOf(container, container),
        discoveryIndex,
      });
    }

    return [...byContainer.values()].sort((left, right) => {
      const byDOM = compareContainers(left.container, right.container);
      return byDOM || (left.discoveryIndex || 0) - (right.discoveryIndex || 0);
    });
  }

  function hasFinalAction(container, selectors = FINAL_ACTION_SELECTORS) {
    if (!container?.querySelector) return false;
    for (const selector of selectors) {
      try {
        if (container.querySelector(selector)) return true;
      } catch {
        // A future selector unsupported by an older browser must not break detection.
      }
    }
    return false;
  }

  function closestKnownTurnContainer(element) {
    if (!element?.closest) return null;
    for (const selector of TURN_CONTAINER_SELECTORS) {
      try {
        const container = element.closest(selector);
        if (container) return container;
      } catch {
        // Ignore selectors unsupported by an older browser.
      }
    }
    return null;
  }

  function nearestPrecedingTurnContainer(documentObject, action) {
    let nearest = null;
    for (const { container } of collectContainers(documentObject)) {
      if (!container || container === action || container.contains?.(action)) continue;
      const relation = typeof container.compareDocumentPosition === 'function'
        ? container.compareDocumentPosition(action)
        : compareContainers(container, action) < 0 ? 4 : 0;
      if (!(relation & 4)) continue;
      if (!nearest || compareContainers(nearest, container) < 0) nearest = container;
    }
    return nearest;
  }

  function hasFinalActionForTurn(documentObject, turn, selectors = FINAL_ACTION_SELECTORS) {
    const container = turn?.container || turn?.element || null;
    if (!container) return false;
    if (hasFinalAction(container, selectors)) return true;

    // Some ChatGPT layouts render the action row immediately after the turn
    // container rather than inside it. Accept only a matching action that
    // follows this turn and is not owned by a different turn container.
    for (const selector of selectors) {
      let actions = [];
      try {
        actions = [...(documentObject?.querySelectorAll?.(selector) || [])];
      } catch {
        actions = [];
      }
      for (const action of actions) {
        if (!action || action.isConnected === false) continue;
        if (container.contains?.(action)) return true;
        const owner = closestKnownTurnContainer(action);
        if (
          owner
          && owner !== container
          && !owner.contains?.(container)
          && !container.contains?.(owner)
        ) {
          continue;
        }
        const relation = typeof container.compareDocumentPosition === 'function'
          ? container.compareDocumentPosition(action)
          : compareContainers(container, action) < 0 ? 4 : 0;
        if (!(relation & 4)) continue;
        const nearest = nearestPrecedingTurnContainer(documentObject, action);
        if (
          !nearest
          || nearest === container
          || nearest.contains?.(container)
          || container.contains?.(nearest)
        ) return true;
      }
    }
    return false;
  }

  function makeTurnKey({ pathname = '', userTurns = [], assistantCount = 0, cycleNumber = 0 } = {}) {
    const latestUser = Array.isArray(userTurns) ? userTurns.at(-1) : null;
    const path = normalizeText(pathname, 240) || '/';
    const identity = normalizeText(latestUser?.identity, 180);
    const textHash = fingerprint(latestUser?.text || '');
    const users = Array.isArray(userTurns) ? userTurns.length : 0;
    const assistants = Math.max(0, Math.trunc(Number(assistantCount) || 0));
    const cycle = Math.max(0, Math.trunc(Number(cycleNumber) || 0));
    return `dom:${fingerprint(path)}:${identity || `user-${users}-${textHash}`}:a${assistants}:c${cycle}`;
  }

  return Object.freeze({
    ASSISTANT_SELECTORS,
    USER_SELECTORS,
    FINAL_ACTION_SELECTORS,
    TURN_CONTAINER_SELECTORS,
    collectTurns,
    collectAssistantTurns,
    fingerprint,
    hasFinalAction,
    hasFinalActionForTurn,
    identityOf,
    makeTurnKey,
    normalizeText,
    textOf,
    turnContainer,
  });
}));
