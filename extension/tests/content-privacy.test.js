'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const content = fs.readFileSync(path.resolve(__dirname, '../src/content.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../manifest.json'), 'utf8'));

test('runtime never patches page networking or parses ChatGPT response streams', () => {
  assert.doesNotMatch(content, /MAIN_WORLD_SOURCE|stream-final|addEventListener\?\.\('message'/u);
  assert.equal(manifest.content_scripts.some((entry) => entry.world === 'MAIN'), false);
  assert.equal(manifest.permissions.includes('webRequest'), false);
});

test('final completion messages do not send reply text to the service worker', () => {
  const start = content.indexOf('function sendDomCandidate');
  const end = content.indexOf('function settleKey', start);
  const candidateBody = start >= 0 && end > start ? content.slice(start, end) : '';
  assert.doesNotMatch(candidateBody, /replyText|assistantText/u);
});
