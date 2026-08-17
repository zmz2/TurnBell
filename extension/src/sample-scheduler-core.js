'use strict';

(function exposeSampleScheduler(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.GPTReplySampleScheduler = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function schedulerFactory() {
  function createSampleScheduler({
    sample,
    isHidden,
    setTimer,
    clearTimer,
    queueMicrotask,
  } = {}) {
    if (typeof sample !== 'function') throw new TypeError('sample function is required');
    if (typeof isHidden !== 'function') throw new TypeError('isHidden function is required');
    if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
      throw new TypeError('timer functions are required');
    }
    if (typeof queueMicrotask !== 'function') throw new TypeError('queueMicrotask function is required');

    let timerId = null;
    let microtaskQueued = false;
    let disposed = false;

    function runFromTimer() {
      timerId = null;
      if (!disposed) sample();
    }

    function runFromMicrotask() {
      microtaskQueued = false;
      if (!disposed) sample();
    }

    function schedule(delay = 0) {
      if (disposed) return;

      if (isHidden()) {
        if (timerId !== null) {
          clearTimer(timerId);
          timerId = null;
        }
        if (microtaskQueued) return;
        microtaskQueued = true;
        queueMicrotask(runFromMicrotask);
        return;
      }

      if (microtaskQueued || timerId !== null) return;
      const numericDelay = Number(delay);
      timerId = setTimer(
        runFromTimer,
        Number.isFinite(numericDelay) ? Math.max(0, numericDelay) : 0,
      );
    }

    function dispose() {
      disposed = true;
      microtaskQueued = false;
      if (timerId !== null) {
        clearTimer(timerId);
        timerId = null;
      }
    }

    return Object.freeze({ schedule, dispose });
  }

  return Object.freeze({ createSampleScheduler });
}));
