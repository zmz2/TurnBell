'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ASSISTANT_SELECTORS,
  USER_SELECTORS,
  FINAL_ACTION_SELECTORS,
  collectTurns,
  hasFinalAction,
  hasFinalActionForTurn,
  makeTurnKey,
} = require('../src/dom-model-core.js');

function makeContainer(order, actions = []) {
  return {
    order,
    querySelector(selector) {
      return actions.some((token) => selector.includes(token)) ? { isConnected: true } : null;
    },
    querySelectorAll() { return []; },
    getAttribute(name) {
      if (name === 'data-testid') return `conversation-turn-${order}`;
      return '';
    },
    compareDocumentPosition(other) {
      if (this.order < other.order) return 4;
      if (this.order > other.order) return 2;
      return 0;
    },
  };
}

function makeNode(text, container, identity = '') {
  return {
    innerText: text,
    textContent: text,
    isConnected: true,
    getAttribute(name) {
      if (name === 'data-message-id') return identity;
      return '';
    },
    closest(selector) {
      if (selector.includes('conversation-turn') || selector === 'article' || selector === '[data-turn]') {
        return container;
      }
      return null;
    },
  };
}

function fakeDocument(map) {
  return {
    querySelectorAll(selector) {
      return map.get(selector) || [];
    },
  };
}

test('collectTurns unions layouts, de-duplicates one turn, and preserves document order', () => {
  const firstContainer = makeContainer(1);
  const secondContainer = makeContainer(2, ['copy-turn-action-button']);
  const firstOuter = makeNode('first answer', firstContainer, 'assistant-1');
  const secondOuter = makeNode('short', secondContainer, 'assistant-2');
  const secondInner = makeNode('second and final answer', secondContainer, 'assistant-2-inner');
  const map = new Map([
    [ASSISTANT_SELECTORS[0], [secondOuter, firstOuter]],
    [ASSISTANT_SELECTORS[1], [secondInner]],
  ]);

  const turns = collectTurns(fakeDocument(map), ASSISTANT_SELECTORS);

  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, 'first answer');
  assert.equal(turns[1].text, 'second and final answer');
  assert.equal(turns[1].container, secondContainer);
});

test('final completion accepts several stable action-row controls, not only copy', () => {
  for (const token of [
    'copy-turn-action-button',
    'good-response-turn-action-button',
    'bad-response-turn-action-button',
    'voice-play-turn-action-button',
  ]) {
    const container = makeContainer(1, [token]);
    assert.equal(hasFinalAction(container, FINAL_ACTION_SELECTORS), true, token);
  }
  assert.equal(hasFinalAction(makeContainer(1), FINAL_ACTION_SELECTORS), false);
});


test('a final action row rendered as a following sibling still belongs to the latest assistant turn', () => {
  const container = makeContainer(5);
  const assistant = makeNode('final answer', container, 'assistant-5');
  const followingAction = {
    order: 6,
    isConnected: true,
    closest() { return null; },
  };
  const precedingAction = {
    order: 4,
    isConnected: true,
    closest() { return null; },
  };
  const selector = 'button[data-testid="copy-turn-action-button"]';

  assert.equal(hasFinalActionForTurn(
    fakeDocument(new Map([[selector, [followingAction]]])),
    { element: assistant, container },
    [selector],
  ), true);
  assert.equal(hasFinalActionForTurn(
    fakeDocument(new Map([[selector, [precedingAction]]])),
    { element: assistant, container },
    [selector],
  ), false);
});

test('turn keys change across detector cycles even when the visible user turn is unchanged', () => {
  const container = makeContainer(7);
  const user = makeNode('same question', container, 'user-message-7');
  const turns = collectTurns(fakeDocument(new Map([[USER_SELECTORS[0], [user]]])), USER_SELECTORS);

  const first = makeTurnKey({ pathname: '/c/conversation', userTurns: turns, assistantCount: 4, cycleNumber: 1 });
  const second = makeTurnKey({ pathname: '/c/conversation', userTurns: turns, assistantCount: 5, cycleNumber: 2 });

  assert.match(first, /^dom:/u);
  assert.notEqual(first, second);
});

test('a live assistant turn can be recovered from its final action even without a role marker', () => {
  const userContainer = makeContainer(10);
  userContainer.getAttribute = (name) => name === 'data-testid' ? 'conversation-turn-10' : '';
  const assistantContainer = makeContainer(11, ['copy-turn-action-button']);
  assistantContainer.getAttribute = (name) => name === 'data-testid' ? 'conversation-turn-11' : '';
  const userMarker = makeNode('question', userContainer, 'user-live');
  const assistantBody = makeNode('new live answer', assistantContainer, '');
  const action = {
    order: 12,
    isConnected: true,
    closest(selector) {
      if (selector.includes('conversation-turn') || selector === 'article' || selector === '[data-turn]') return assistantContainer;
      return null;
    },
  };
  assistantContainer.querySelector = (selector) => {
    if (selector.includes('data-message-author-role="user"')) return null;
    if (selector.includes('data-message-author-role="assistant"')) return null;
    if (selector.includes('copy-turn-action-button')) return action;
    return null;
  };
  assistantContainer.innerText = 'new live answer';
  assistantContainer.textContent = 'new live answer';
  assistantContainer.isConnected = true;
  assistantContainer.closest = () => assistantContainer;

  const genericSelector = '[data-testid^="conversation-turn-"]';
  const map = new Map([
    [USER_SELECTORS[0], [userMarker]],
    [genericSelector, [userContainer, assistantContainer]],
    [FINAL_ACTION_SELECTORS[0], [action]],
  ]);
  const documentObject = fakeDocument(map);
  const turns = require('../src/dom-model-core.js').collectAssistantTurns(documentObject);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].container, assistantContainer);
  assert.equal(turns[0].text, 'new live answer');
});

test('a role-less live assistant turn is recovered when its final action is a following sibling', () => {
  const userContainer = makeContainer(20);
  const assistantContainer = makeContainer(21);
  const userMarker = makeNode('question', userContainer, 'user-20');
  assistantContainer.innerText = 'answer whose controls are outside the turn';
  assistantContainer.textContent = assistantContainer.innerText;
  assistantContainer.isConnected = true;
  assistantContainer.closest = () => assistantContainer;
  const followingAction = {
    order: 22,
    isConnected: true,
    closest() { return null; },
  };
  const genericSelector = '[data-testid^="conversation-turn-"]';
  const documentObject = fakeDocument(new Map([
    [USER_SELECTORS[0], [userMarker]],
    [genericSelector, [userContainer, assistantContainer]],
    [FINAL_ACTION_SELECTORS[0], [followingAction]],
  ]));

  const turns = require('../src/dom-model-core.js').collectAssistantTurns(documentObject);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].container, assistantContainer);
  assert.equal(turns[0].text, 'answer whose controls are outside the turn');
});

test('an external final action is assigned only to the nearest preceding role-less turn', () => {
  const earlier = makeContainer(30);
  const latest = makeContainer(31);
  for (const container of [earlier, latest]) {
    container.innerText = `answer-${container.order}`;
    container.textContent = container.innerText;
    container.isConnected = true;
    container.closest = () => container;
  }
  const action = { order: 32, isConnected: true, closest() { return null; } };
  const genericSelector = '[data-testid^="conversation-turn-"]';
  const documentObject = fakeDocument(new Map([
    [genericSelector, [earlier, latest]],
    [FINAL_ACTION_SELECTORS[0], [action]],
  ]));

  const turns = require('../src/dom-model-core.js').collectAssistantTurns(documentObject);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].container, latest);
});
