'use strict';

(() => {
  const notificationAPI = globalThis.GPTReplyNotification;
  const audioByTheme = new Map();

  function audioFor(theme) {
    const settings = notificationAPI.normalizeSettings({ soundTheme: theme });
    const file = notificationAPI.soundFile(settings.soundTheme);
    if (!file) return null;
    if (audioByTheme.has(settings.soundTheme)) return audioByTheme.get(settings.soundTheme);

    const audio = new Audio(chrome.runtime.getURL(`assets/sounds/${file}`));
    audio.preload = 'auto';
    audioByTheme.set(settings.soundTheme, audio);
    return audio;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'offscreen' || message?.type !== 'play-sound') return false;

    const settings = notificationAPI.normalizeSettings({
      soundTheme: message.theme,
      soundVolume: message.volume,
    });
    const audio = audioFor(settings.soundTheme);
    if (!audio) {
      sendResponse({ ok: false, reason: 'system-managed', theme: settings.soundTheme });
      return true;
    }
    audio.volume = settings.soundVolume;
    audio.currentTime = 0;
    audio.play().then(
      () => sendResponse({ ok: true, theme: settings.soundTheme }),
      (error) => sendResponse({ ok: false, error: String(error) }),
    );
    return true;
  });
})();
