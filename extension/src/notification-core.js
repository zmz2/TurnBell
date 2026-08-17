'use strict';

(function exposeNotificationCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.GPTReplyNotification = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function notificationFactory() {
  const SOUND_THEMES = Object.freeze({
    system: Object.freeze({ label: 'Windows 默认通知声', file: null, system: true }),
    'soft-chime': Object.freeze({ label: '柔和双音', file: 'soft-chime.wav' }),
    'warm-bell': Object.freeze({ label: '温暖铃声', file: 'warm-bell.wav' }),
    glass: Object.freeze({ label: '玻璃轻响', file: 'glass.wav' }),
    'gentle-pop': Object.freeze({ label: '轻柔气泡', file: 'gentle-pop.wav' }),
    digital: Object.freeze({ label: '数字提示', file: 'digital.wav' }),
  });

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    notificationMode: 'browser',
    notificationBackend: 'extension',
    sound: true,
    soundVolume: 0.55,
    soundTheme: 'system',
    soundBehaviorVersion: 2,
    persistentNotification: true,
    backgroundOnly: false,
    quietPeriodMs: 1_200,
    minGenerationMs: 500,
    debug: false,
  });

  function boundedNumber(value, fallback, minimum, maximum, round = true) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const bounded = Math.min(maximum, Math.max(minimum, number));
    return round ? Math.round(bounded) : bounded;
  }

  function normalizeSettings(raw = {}) {
    const soundTheme = Object.hasOwn(SOUND_THEMES, raw.soundTheme)
      ? raw.soundTheme
      : DEFAULT_SETTINGS.soundTheme;
    return {
      enabled: raw.enabled === undefined ? DEFAULT_SETTINGS.enabled : Boolean(raw.enabled),
      notificationMode: 'browser',
      notificationBackend: ['extension', 'web', 'both'].includes(raw.notificationBackend)
        ? raw.notificationBackend
        : DEFAULT_SETTINGS.notificationBackend,
      sound: raw.sound === undefined ? DEFAULT_SETTINGS.sound : Boolean(raw.sound),
      soundVolume: boundedNumber(raw.soundVolume, DEFAULT_SETTINGS.soundVolume, 0, 1, false),
      soundTheme,
      soundBehaviorVersion: boundedNumber(
        raw.soundBehaviorVersion,
        DEFAULT_SETTINGS.soundBehaviorVersion,
        0,
        DEFAULT_SETTINGS.soundBehaviorVersion,
      ),
      persistentNotification: raw.persistentNotification === undefined
        ? DEFAULT_SETTINGS.persistentNotification
        : Boolean(raw.persistentNotification),
      backgroundOnly: raw.backgroundOnly === undefined
        ? DEFAULT_SETTINGS.backgroundOnly
        : Boolean(raw.backgroundOnly),
      quietPeriodMs: boundedNumber(raw.quietPeriodMs, DEFAULT_SETTINGS.quietPeriodMs, 200, 10_000),
      minGenerationMs: boundedNumber(raw.minGenerationMs, DEFAULT_SETTINGS.minGenerationMs, 0, 600_000),
      debug: raw.debug === undefined ? DEFAULT_SETTINGS.debug : Boolean(raw.debug),
    };
  }

  function migrateSettings(raw = {}) {
    const storedVersion = boundedNumber(raw.soundBehaviorVersion, 0, 0, DEFAULT_SETTINGS.soundBehaviorVersion);
    const migrated = {
      ...raw,
      soundBehaviorVersion: DEFAULT_SETTINGS.soundBehaviorVersion,
    };
    if (storedVersion < DEFAULT_SETTINGS.soundBehaviorVersion) {
      migrated.sound = raw.sound === undefined ? DEFAULT_SETTINGS.sound : Boolean(raw.sound);
      migrated.soundTheme = 'system';
    }
    return normalizeSettings(migrated);
  }

  function collapseWhitespace(value) {
    return String(value ?? '').replace(/\s+/gu, ' ').trim();
  }

  function cleanPageTitle(value) {
    const title = collapseWhitespace(value)
      .replace(/\s*(?:[-|·—])\s*ChatGPT\s*$/iu, '')
      .trim();
    return /^ChatGPT$/iu.test(title) ? '' : title;
  }

  function truncate(value, maximum) {
    if (value.length <= maximum) return value;
    return `${value.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
  }

  function safeChatGPTUrl(value) {
    try {
      const url = new URL(String(value ?? ''));
      const host = url.hostname.toLowerCase();
      const allowedHost = host === 'chatgpt.com' || host === 'chat.openai.com';
      if (url.protocol === 'https:' && allowedHost) return url.href;
    } catch {
      // Fall through to the canonical homepage.
    }
    return 'https://chatgpt.com/';
  }

  function makeNotificationPayload(event = {}, context = {}) {
    const conversation = cleanPageTitle(context.pageTitle);
    const message = conversation
      ? `${truncate(conversation, 90)}：这一轮回复已全部完成`
      : '这一轮回复已全部完成';
    const rawTabId = Number(context.tabId);
    const rawDuration = Number(event.durationMs);

    return {
      title: 'TurnBell · 回复完成',
      message: truncate(message, 180),
      url: safeChatGPTUrl(context.url),
      tabHidden: Boolean(context.tabHidden),
      tabId: Number.isInteger(rawTabId) && rawTabId >= 0 ? rawTabId : null,
      durationMs: Number.isFinite(rawDuration) ? Math.max(0, Math.round(rawDuration)) : 0,
      fingerprint: truncate(collapseWhitespace(event.fingerprint), 64),
    };
  }

  function shouldNotify(settings, context = {}) {
    const normalized = normalizeSettings(settings);
    if (!normalized.enabled) return false;
    return !(normalized.backgroundOnly && !Boolean(context.tabHidden));
  }

  function chooseNotificationActions(settings) {
    const normalized = normalizeSettings(settings);
    if (!normalized.enabled) return [];
    if (normalized.notificationBackend === 'web') return ['web'];
    if (normalized.notificationBackend === 'both') return ['extension', 'web'];
    return ['extension'];
  }

  function notificationSilent(settings) {
    const normalized = normalizeSettings(settings);
    return !(normalized.sound && normalized.soundTheme === 'system');
  }

  function shouldPlayCustomSound(settings) {
    const normalized = normalizeSettings(settings);
    return normalized.sound && normalized.soundTheme !== 'system';
  }

  function soundFile(theme) {
    return SOUND_THEMES[Object.hasOwn(SOUND_THEMES, theme) ? theme : DEFAULT_SETTINGS.soundTheme].file;
  }

  return Object.freeze({
    DEFAULT_SETTINGS,
    SOUND_THEMES,
    chooseNotificationActions,
    collapseWhitespace,
    makeNotificationPayload,
    migrateSettings,
    notificationSilent,
    normalizeSettings,
    safeChatGPTUrl,
    shouldNotify,
    shouldPlayCustomSound,
    soundFile,
  });
}));
