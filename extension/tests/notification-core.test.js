'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SETTINGS,
  SOUND_THEMES,
  normalizeSettings,
  makeNotificationPayload,
  migrateSettings,
  chooseNotificationActions,
  notificationSilent,
  shouldNotify,
  shouldPlayCustomSound,
} = require('../src/notification-core.js');

test('normalizes settings, sound themes, and persistent notification defaults', () => {
  assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.soundTheme, 'system');
  assert.equal(DEFAULT_SETTINGS.persistentNotification, true);
  assert.deepEqual(Object.keys(SOUND_THEMES), [
    'system',
    'soft-chime',
    'warm-bell',
    'glass',
    'gentle-pop',
    'digital',
  ]);

  const settings = normalizeSettings({
    enabled: 0,
    sound: 'yes',
    soundVolume: 9,
    soundTheme: 'unknown',
    persistentNotification: 0,
    backgroundOnly: 1,
    quietPeriodMs: -5,
    minGenerationMs: 9_999_999,
    debug: true,
  });

  assert.equal(settings.enabled, false);
  assert.equal(settings.notificationMode, 'browser');
  assert.equal(settings.sound, true);
  assert.equal(settings.soundVolume, 1);
  assert.equal(settings.soundTheme, 'system');
  assert.equal(settings.persistentNotification, false);
  assert.equal(settings.backgroundOnly, true);
  assert.equal(settings.quietPeriodMs, 200);
  assert.equal(settings.minGenerationMs, 600_000);
  assert.equal(settings.debug, true);
});

test('notification payload is compact and never includes the assistant reply body', () => {
  const secretReply = 'private final answer that must stay inside the page';
  const payload = makeNotificationPayload(
    { replyText: secretReply, durationMs: 12_345, fingerprint: 'deadbeef' },
    {
      pageTitle: 'Research notes - ChatGPT',
      url: 'https://chatgpt.com/c/abc?model=gpt-5',
      tabHidden: true,
      tabId: 42,
    },
  );

  assert.equal(payload.title, 'TurnBell · 回复完成');
  assert.equal(payload.message, 'Research notes：这一轮回复已全部完成');
  assert.equal(payload.message.includes(secretReply), false);
  assert.equal(payload.url, 'https://chatgpt.com/c/abc?model=gpt-5');
  assert.equal(payload.tabHidden, true);
  assert.equal(payload.tabId, 42);
  assert.equal(payload.durationMs, 12_345);
  assert.equal(payload.fingerprint, 'deadbeef');
});

test('drops unsafe URLs and cleans generic page titles', () => {
  const payload = makeNotificationPayload(
    { replyText: 'done', durationMs: 10, fingerprint: 'a' },
    { pageTitle: 'ChatGPT', url: 'javascript:alert(1)', tabId: 'bad' },
  );
  assert.equal(payload.message, '这一轮回复已全部完成');
  assert.equal(payload.url, 'https://chatgpt.com/');
  assert.equal(payload.tabId, null);
});

test('suppresses alerts only when disabled or background-only is unmet', () => {
  assert.equal(shouldNotify(normalizeSettings({ enabled: false }), { tabHidden: true }), false);
  assert.equal(shouldNotify(normalizeSettings({ backgroundOnly: true }), { tabHidden: false }), false);
  assert.equal(shouldNotify(normalizeSettings({ backgroundOnly: true }), { tabHidden: true }), true);
  assert.equal(shouldNotify(normalizeSettings({ backgroundOnly: false }), { tabHidden: false }), true);
});

test('legacy notificationMode values stay compatible with the extension notification backend', () => {
  for (const legacyMode of ['browser', 'native-first', 'both', 'invalid']) {
    const settings = normalizeSettings({ notificationMode: legacyMode });
    assert.equal(settings.notificationMode, 'browser');
    assert.deepEqual(chooseNotificationActions(settings), ['extension']);
  }
});

test('notification backend can use the extension API, Web Notification API, or both', () => {
  assert.equal(DEFAULT_SETTINGS.notificationBackend, 'extension');
  assert.deepEqual(chooseNotificationActions(normalizeSettings({ notificationBackend: 'extension' })), ['extension']);
  assert.deepEqual(chooseNotificationActions(normalizeSettings({ notificationBackend: 'web' })), ['web']);
  assert.deepEqual(chooseNotificationActions(normalizeSettings({ notificationBackend: 'both' })), ['extension', 'web']);
  assert.equal(normalizeSettings({ notificationBackend: 'not-real' }).notificationBackend, 'extension');
});


test('Windows default sound is the default while custom themes mute the system notification', () => {
  const system = normalizeSettings({ sound: true, soundTheme: 'system' });
  const custom = normalizeSettings({ sound: true, soundTheme: 'glass' });
  const muted = normalizeSettings({ sound: false, soundTheme: 'system' });

  assert.equal(notificationSilent(system), false);
  assert.equal(shouldPlayCustomSound(system), false);
  assert.equal(notificationSilent(custom), true);
  assert.equal(shouldPlayCustomSound(custom), true);
  assert.equal(notificationSilent(muted), true);
  assert.equal(shouldPlayCustomSound(muted), false);
});

test('legacy bundled-sound settings migrate once to the Windows default sound', () => {
  const migrated = migrateSettings({
    sound: true,
    soundTheme: 'soft-chime',
    soundBehaviorVersion: 1,
  });
  assert.equal(migrated.soundTheme, 'system');
  assert.equal(migrated.soundBehaviorVersion, 2);

  const preserved = migrateSettings({
    sound: true,
    soundTheme: 'glass',
    soundBehaviorVersion: 2,
  });
  assert.equal(preserved.soundTheme, 'glass');
  assert.equal(preserved.soundBehaviorVersion, 2);
});
