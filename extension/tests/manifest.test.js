'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');

function readJSON(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(extensionRoot, relativePath), 'utf8'));
}

test('manifest is a local-code Manifest V3 extension for ChatGPT', () => {
  const manifest = readJSON('manifest.json');

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, '111');
  assert.equal(manifest.version, '1.5.0');
  assert.equal(manifest.background.service_worker, 'src/background.js');
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.ok(manifest.permissions.includes('notifications'));
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.permissions.includes('offscreen'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(!manifest.permissions.includes('webRequest'));
  assert.ok(!manifest.permissions.includes('alarms'));
  assert.ok(!manifest.host_permissions.includes('http://127.0.0.1/*'));

  const matches = manifest.content_scripts.flatMap((entry) => entry.matches);
  assert.ok(matches.includes('https://chatgpt.com/*'));
  assert.ok(matches.includes('https://chat.openai.com/*'));

  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0].js, [
    'src/detector-core.js',
    'src/notification-core.js',
    'src/sample-scheduler-core.js',
    'src/bootstrap-core.js',
    'src/dom-model-core.js',
    'src/content.js',
  ]);
  assert.equal(manifest.content_scripts[0].world, 'ISOLATED');
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
});

test('all manifest-referenced files and user-facing assets exist', () => {
  const manifest = readJSON('manifest.json');
  const files = new Set([
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((entry) => entry.js),
    'offscreen.html',
    'src/offscreen.js',
    'src/tab-monitor-core.js',
    'src/finalization-core.js',
    'src/sample-scheduler-core.js',
    'src/popup.js',
    'popup.css',
    'assets/sounds/soft-chime.wav',
    'assets/sounds/warm-bell.wav',
    'assets/sounds/glass.wav',
    'assets/sounds/gentle-pop.wav',
    'assets/sounds/digital.wav',
  ]);

  for (const relativePath of files) {
    assert.ok(fs.existsSync(path.join(extensionRoot, relativePath)), `${relativePath} is missing`);
  }

  for (const name of ['soft-chime.wav', 'warm-bell.wav', 'glass.wav', 'gentle-pop.wav', 'digital.wav']) {
    const wav = fs.readFileSync(path.join(extensionRoot, 'assets/sounds', name));
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF', name);
    assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE', name);
  }
});

test('background loads only DOM completion and notification cores', () => {
  const background = fs.readFileSync(path.join(extensionRoot, 'src/background.js'), 'utf8');
  assert.match(background, /importScripts\([^)]*tab-monitor-core\.js/);
  assert.match(background, /importScripts\([^)]*finalization-core\.js/);
  assert.doesNotMatch(background, /network-core\.js|stream-final|webRequest|main-world-stream|chrome\.alarms/u);
});

test('extension HTML does not load remote code', () => {
  for (const relativePath of ['popup.html', 'offscreen.html']) {
    const html = fs.readFileSync(path.join(extensionRoot, relativePath), 'utf8');
    assert.doesNotMatch(html, /<script[^>]+src=["']https?:\/\//iu);
    assert.doesNotMatch(html, /<link[^>]+href=["']https?:\/\//iu);
  }
});


test('legacy response interception modules are absent from the distributable source tree', () => {
  for (const relativePath of [
    'src/main-world-stream.js',
    'src/stream-metadata-core.js',
    'src/network-core.js',
    'src/completion-ledger-core.js',
    'assets/sounds/done.wav',
  ]) {
    assert.equal(fs.existsSync(path.join(extensionRoot, relativePath)), false, `${relativePath} must be removed`);
  }
});
