'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSampleScheduler } = require('../src/sample-scheduler-core.js');

function harness(initialHidden = false) {
  let hidden = initialHidden;
  let nextTimerId = 1;
  const timers = new Map();
  const microtasks = [];
  let samples = 0;
  const cleared = [];

  const scheduler = createSampleScheduler({
    sample() { samples += 1; },
    isHidden() { return hidden; },
    setTimer(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      cleared.push(id);
      timers.delete(id);
    },
    queueMicrotask(callback) { microtasks.push(callback); },
  });

  return {
    scheduler,
    timers,
    microtasks,
    cleared,
    get samples() { return samples; },
    setHidden(value) { hidden = value; },
    runMicrotask() { microtasks.shift()?.(); },
    runTimer(id = [...timers.keys()][0]) {
      const entry = timers.get(id);
      timers.delete(id);
      entry?.callback();
    },
  };
}

test('hidden scheduling cancels a foreground timer and samples through a microtask', () => {
  const state = harness(false);

  state.scheduler.schedule(120);
  assert.equal(state.timers.size, 1);

  state.setHidden(true);
  state.scheduler.schedule(120);

  assert.equal(state.timers.size, 0);
  assert.deepEqual(state.cleared, [1]);
  assert.equal(state.microtasks.length, 1);

  state.runMicrotask();
  assert.equal(state.samples, 1);
});

test('multiple hidden mutations are coalesced without relying on timers', () => {
  const state = harness(true);

  state.scheduler.schedule();
  state.scheduler.schedule();
  state.scheduler.schedule();

  assert.equal(state.microtasks.length, 1);
  assert.equal(state.timers.size, 0);
  state.runMicrotask();
  assert.equal(state.samples, 1);
});

test('visible mutations remain debounced and dispose clears pending work', () => {
  const state = harness(false);

  state.scheduler.schedule(90);
  state.scheduler.schedule(90);
  assert.equal(state.timers.size, 1);
  assert.equal([...state.timers.values()][0].delay, 90);

  state.scheduler.dispose();
  assert.equal(state.timers.size, 0);
  assert.deepEqual(state.cleared, [1]);
});
