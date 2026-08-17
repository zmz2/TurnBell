'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBootstrapGate } = require('../src/bootstrap-core.js');

test('progressive history hydration becomes a silent baseline instead of a new turn', () => {
  const gate = createBootstrapGate({ quietPeriodMs: 800, maxWaitMs: 10_000 });

  assert.deepEqual(gate.evaluate({ now: 0, readyState: 'loading' }).action, 'wait');
  gate.noteMutation(200);
  gate.noteMutation(600);
  assert.equal(gate.evaluate({ now: 1_000, readyState: 'complete' }).action, 'wait');

  const baseline = gate.evaluate({ now: 1_401, readyState: 'complete' });
  assert.equal(baseline.action, 'baseline');
  assert.equal(baseline.arm, false);
  assert.equal(gate.getState().ready, true);
});

test('explicit send intent activates detection immediately even before hydration settles', () => {
  const gate = createBootstrapGate({ quietPeriodMs: 800, maxWaitMs: 10_000 });
  gate.evaluate({ now: 0, readyState: 'loading' });
  gate.noteMutation(300);

  const activated = gate.activate(450, 'user-intent');
  assert.equal(activated.action, 'activate');
  assert.equal(activated.arm, true);
  assert.equal(activated.reason, 'user-intent');
  assert.equal(gate.getState().ready, true);
});

test('route reset returns to silent bootstrap and discards historical replay', () => {
  const gate = createBootstrapGate({ quietPeriodMs: 500, maxWaitMs: 10_000 });
  gate.evaluate({ now: 0, readyState: 'complete' });
  assert.equal(gate.evaluate({ now: 501, readyState: 'complete' }).action, 'baseline');

  gate.reset(1_000);
  gate.noteMutation(1_100);
  assert.equal(gate.evaluate({ now: 1_400, readyState: 'complete' }).action, 'wait');
  assert.equal(gate.evaluate({ now: 1_601, readyState: 'complete' }).action, 'baseline');
});

test('default bootstrap waits two quiet seconds before accepting hydrated history', () => {
  const gate = createBootstrapGate();
  assert.equal(gate.getState().options.quietPeriodMs, 2_000);
});
