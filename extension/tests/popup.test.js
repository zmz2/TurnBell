'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('popup exposes DOM-only diagnostics, sound choices, and notification troubleshooting', () => {
  const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'src/popup.js'), 'utf8');

  assert.match(html, /TurnBell/u);
  assert.match(html, /无需\s*EXE/u);
  assert.match(html, /DOM/u);
  assert.match(html, /最多提醒一次/u);
  assert.match(html, /id=["']soundTheme["']/u);
  assert.match(html, /Windows 默认通知声/u);
  assert.match(html, /id=["']previewSound["']/u);
  assert.match(html, /id=["']notificationBackend["']/u);
  assert.match(html, /Web 通知兼容通道/u);
  assert.match(html, /id=["']persistentNotification["']/u);
  assert.match(html, /id=["']openNotificationSettings["']/u);
  assert.doesNotMatch(html, /最终流|网络请求|Windows\s*助手/u);
  assert.match(script, /preview-sound/u);
  assert.match(script, /open-edge-notification-settings/u);
  assert.match(script, /browserActive|webActive|diagnostic/u);
});
