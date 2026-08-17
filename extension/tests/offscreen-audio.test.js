'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const notificationSource = fs.readFileSync(path.resolve(__dirname, '../src/notification-core.js'), 'utf8');
const offscreenSource = fs.readFileSync(path.resolve(__dirname, '../src/offscreen.js'), 'utf8');

test('offscreen audio selects a validated local sound theme and reuses audio objects', async () => {
  let listener = null;
  const instances = [];
  class FakeAudio {
    constructor(src) { this.src = src; this.volume = 0; this.currentTime = -1; this.preload = ''; this.plays = 0; instances.push(this); }
    play() { this.plays += 1; return Promise.resolve(); }
  }
  const context = {
    console, URL, Promise, Map, Object, Number, String, Boolean,
    Audio: FakeAudio,
    chrome: {
      runtime: {
        getURL(value) { return `chrome-extension://id/${value}`; },
        onMessage: { addListener(value) { listener = value; } },
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(notificationSource, context, { filename: 'notification-core.js' });
  vm.runInContext(offscreenSource, context, { filename: 'offscreen.js' });

  const send = (message) => new Promise((resolve) => {
    const keepOpen = listener(message, {}, resolve);
    assert.equal(keepOpen, true);
  });
  assert.equal((await send({ target: 'offscreen', type: 'play-sound', theme: 'glass', volume: 0.4 })).ok, true);
  assert.equal((await send({ target: 'offscreen', type: 'play-sound', theme: 'glass', volume: 0.7 })).ok, true);
  const system = await send({ target: 'offscreen', type: 'play-sound', theme: 'system', volume: 0.5 });
  const invalid = await send({ target: 'offscreen', type: 'play-sound', theme: 'not-real', volume: 0.5 });
  assert.equal(system.ok, false);
  assert.equal(system.reason, 'system-managed');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'system-managed');

  assert.equal(instances.length, 1);
  assert.match(instances[0].src, /assets\/sounds\/glass\.wav$/u);
  assert.equal(instances[0].plays, 2);
  assert.equal(instances[0].volume, 0.7);
});

test('offscreen document loads local settings core before audio runtime', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../offscreen.html'), 'utf8');
  assert.match(html, /notification-core\.js[\s\S]*offscreen\.js/u);
});
