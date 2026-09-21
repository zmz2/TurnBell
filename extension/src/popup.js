'use strict';

(() => {
  const api = globalThis.GPTReplyNotification;
  const ids = [
    'enabled',
    'notificationBackend',
    'sound',
    'soundTheme',
    'soundVolume',
    'persistentNotification',
    'backgroundOnly',
    'quietPeriodMs',
    'minGenerationSeconds',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  const monitorDot = document.getElementById('monitorDot');
  const monitorStatus = document.getElementById('monitorStatus');
  const notificationDot = document.getElementById('notificationDot');
  const notificationStatus = document.getElementById('notificationStatus');
  const diagnosticStatus = document.getElementById('diagnosticStatus');
  const refreshStatus = document.getElementById('refreshStatus');
  const testButton = document.getElementById('testButton');
  const previewSound = document.getElementById('previewSound');
  const openButton = document.getElementById('openButton');
  const openNotificationSettings = document.getElementById('openNotificationSettings');
  const saveStatus = document.getElementById('saveStatus');
  const volumeValue = document.getElementById('soundVolumeValue');
  const platformNotificationHint = document.getElementById('platformNotificationHint');
  const systemSoundOption = document.getElementById('systemSoundOption');
  const systemSoundHint = document.getElementById('systemSoundHint');
  const notificationBackendHint = document.getElementById('notificationBackendHint');
  const userAgent = String(globalThis.navigator?.userAgent || '');
  const rawPlatform = String(globalThis.navigator?.userAgentData?.platform
    || globalThis.navigator?.platform || '').toLowerCase();
  const platformName = rawPlatform.includes('mac')
    ? 'macOS'
    : rawPlatform.includes('win') ? 'Windows' : '当前系统';
  const soundPlatformName = platformName === '当前系统' ? '操作系统' : platformName;
  const browserName = /\bEdg\//u.test(userAgent)
    ? 'Microsoft Edge'
    : /\bChrome\//u.test(userAgent) ? 'Google Chrome' : '当前浏览器';
  let saveTimer = null;

  function configurePlatformCopy() {
    systemSoundOption.textContent = platformName === '当前系统'
      ? '系统默认通知声（推荐）'
      : `${platformName} 系统默认通知声（推荐）`;
    systemSoundHint.textContent = `系统默认通知声音由 ${soundPlatformName} 和浏览器控制，请用下方测试通知试听。`;
    notificationBackendHint.textContent = '推荐使用扩展通知 API；浏览器会按当前操作系统显示原生通知。';
    platformNotificationHint.textContent = platformName === 'macOS'
      ? `macOS 使用系统通知中心。若未显示，请在“系统设置 → 通知 → ${browserName}”中允许通知，并检查专注模式。`
      : platformName === 'Windows'
        ? `若未显示，请检查 Windows 通知设置及 ${browserName} 的系统通知权限。`
        : '通知样式和声音由当前操作系统及浏览器的通知设置控制。';
  }

  function notificationHelp() {
    if (platformName === 'macOS') {
      return `请检查 macOS“系统设置 → 通知 → ${browserName}”及专注模式。`;
    }
    if (platformName === 'Windows') {
      return `请检查 Windows 通知设置和 ${browserName} 的通知权限。`;
    }
    return '请检查操作系统通知设置和浏览器通知权限。';
  }

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.sync.get(defaults, resolve));
  }

  function storageSet(value) {
    return new Promise((resolve) => chrome.storage.sync.set(value, resolve));
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        resolve(chrome.runtime.lastError
          ? { ok: false, error: chrome.runtime.lastError.message }
          : response || { ok: false, error: 'empty-response' });
      });
    });
  }

  function formSettings() {
    return api.normalizeSettings({
      enabled: elements.enabled.checked,
      notificationMode: 'browser',
      notificationBackend: elements.notificationBackend.value,
      sound: elements.sound.checked,
      soundTheme: elements.soundTheme.value,
      soundVolume: Number(elements.soundVolume.value),
      persistentNotification: elements.persistentNotification.checked,
      backgroundOnly: elements.backgroundOnly.checked,
      quietPeriodMs: Number(elements.quietPeriodMs.value),
      minGenerationMs: Number(elements.minGenerationSeconds.value) * 1_000,
    });
  }

  function syncSoundControls() {
    const soundEnabled = elements.sound.checked;
    const systemManaged = elements.soundTheme.value === 'system';
    elements.soundTheme.disabled = !soundEnabled;
    elements.soundVolume.disabled = !soundEnabled || systemManaged;
    previewSound.disabled = !soundEnabled || systemManaged;
    previewSound.title = systemManaged ? '系统默认声只能通过系统通知试听' : '试听所选内置音效';
    volumeValue.textContent = systemManaged
      ? '系统控制'
      : `${Math.round(Number(elements.soundVolume.value) * 100)}%`;
  }

  function render(settings) {
    elements.enabled.checked = settings.enabled;
    elements.notificationBackend.value = settings.notificationBackend;
    elements.sound.checked = settings.sound;
    elements.soundTheme.value = settings.soundTheme;
    elements.soundVolume.value = String(settings.soundVolume);
    elements.persistentNotification.checked = settings.persistentNotification;
    elements.backgroundOnly.checked = settings.backgroundOnly;
    elements.quietPeriodMs.value = String(settings.quietPeriodMs);
    elements.minGenerationSeconds.value = String(settings.minGenerationMs / 1_000);
    syncSoundControls();
  }

  async function save() {
    const settings = formSettings();
    await storageSet(settings);
    render(settings);
    saveStatus.textContent = '已保存';
    setTimeout(() => { saveStatus.textContent = '设置会自动保存'; }, 1_200);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), 150);
    syncSoundControls();
  }

  function formatDiagnostic(routes) {
    if (!routes) return '尚无通知测试记录。';
    const age = Number(routes.at) > 0
      ? `（${new Date(Number(routes.at)).toLocaleTimeString()}）`
      : '';
    if (routes.web) {
      const soundNote = routes.systemSound ? ` ${platformName} 系统默认通知声由操作系统和浏览器控制。` : '';
      return `Web 通知兼容通道已接受通知${routes.webActive ? '并保持活动' : ''}${age}。${soundNote}${notificationHelp()}`;
    }
    if (routes.webDiagnostic === 'web-unsupported') {
      return `当前浏览器不支持 Web 通知兼容通道${age}；请改回“浏览器扩展通知 API”。`;
    }
    if (routes.webDiagnostic === 'web-create-failed') {
      return `Web 通知兼容通道创建失败${age}${routes.webError ? `：${routes.webError}` : '。'}`;
    }
    if (routes.permission === 'denied' || routes.diagnostic === 'permission-denied') {
      return `浏览器扩展通知权限被拒绝${age}。请重新加载扩展，并检查系统通知设置。`;
    }
    if (routes.diagnostic === 'create-failed') {
      return `浏览器未能创建扩展通知${age}${routes.error ? `：${routes.error}` : '。'}`;
    }
    if (routes.browser && routes.browserActive) {
      const soundNote = routes.systemSound ? `${platformName} 系统默认通知声由操作系统和浏览器控制；` : '';
      return `浏览器扩展通知 API 已接受通知${age}。${soundNote}${notificationHelp()}`;
    }
    if (routes.browser && !routes.browserActive) {
      return `浏览器已接受扩展通知，但查询时已不在活动列表${age}。操作系统或浏览器可能已收起通知。`;
    }
    if (routes.sound || routes.badge) {
      return `系统通知未成功，但${routes.sound ? '提示音' : ''}${routes.sound && routes.badge ? '和' : ''}${routes.badge ? '工具栏 ✓ 徽标' : ''}已生效${age}。`;
    }
    return `未检测到任何成功的提醒通道${age}${routes.error || routes.webError ? `：${routes.error || routes.webError}` : '。'}`;
  }

  async function refreshMonitorStatus() {
    monitorStatus.textContent = '正在检查 DOM 完成监听…';
    monitorDot.className = 'dot';
    const result = await sendMessage({ type: 'monitor-status' });
    if (!result?.ok || !result.domListener) {
      monitorDot.className = 'dot offline';
      monitorStatus.textContent = 'DOM 监听未启动；请在扩展管理页重新加载，并刷新 ChatGPT 标签页';
      return;
    }
    const total = Number(result.total) || 0;
    const active = Number(result.active) || 0;
    if (total === 0) {
      monitorDot.className = 'dot ok';
      monitorStatus.textContent = 'DOM 完成监听已启用；当前没有 ChatGPT 标签页';
      return;
    }
    if (active === total) {
      monitorDot.className = 'dot ok';
      monitorStatus.textContent = `DOM 完成监听已接管 ${active} 个 ChatGPT 标签页`;
      return;
    }
    monitorDot.className = 'dot warn';
    monitorStatus.textContent = `DOM 完成监听已接管 ${active}/${total} 个标签页；请刷新未接管页面`;
  }

  async function refreshNotificationStatus() {
    refreshStatus.disabled = true;
    notificationStatus.textContent = '正在检查浏览器通知权限…';
    notificationDot.className = 'dot';
    const [permission, diagnostic] = await Promise.all([
      sendMessage({ type: 'notification-permission' }),
      sendMessage({ type: 'notification-diagnostics' }),
    ]);
    const backend = elements.notificationBackend.value;
    if (backend === 'web') {
      if (permission?.ok && permission.webSupported) {
        notificationDot.className = 'dot ok';
        notificationStatus.textContent = 'Web 通知兼容通道可调用；请用测试按钮验证系统通知';
      } else {
        notificationDot.className = 'dot offline';
        notificationStatus.textContent = '当前浏览器不支持 Web 通知兼容通道';
      }
    } else if (permission?.ok && permission.level === 'granted') {
      notificationDot.className = 'dot ok';
      notificationStatus.textContent = '浏览器扩展通知 API 已获准；请用测试按钮验证系统通知';
    } else {
      notificationDot.className = 'dot offline';
      notificationStatus.textContent = '浏览器扩展通知权限不可用或被拒绝';
    }
    diagnosticStatus.textContent = formatDiagnostic(diagnostic?.diagnostic || null);
    refreshStatus.disabled = false;
  }

  async function testNotification() {
    testButton.disabled = true;
    testButton.textContent = '正在发送…';
    const settings = formSettings();
    await storageSet(settings);
    const result = await sendMessage({ type: 'test-notification', settings });
    const routes = result?.routes;
    if (routes?.web && routes.webActive) {
      testButton.textContent = '✅ 兼容通道已接受通知';
    } else if (routes?.web) {
      testButton.textContent = '⚠️ 兼容通道已创建，未保持活动';
    } else if (routes?.browser && routes.browserActive) {
      testButton.textContent = '✅ 浏览器已接受通知';
    } else if (routes?.browser) {
      testButton.textContent = '⚠️ 浏览器已创建，系统未保留';
    } else if (routes?.sound || routes?.badge) {
      testButton.textContent = '⚠️ 系统横幅失败，备用提醒成功';
    } else {
      testButton.textContent = '❌ 通知发送失败';
    }
    diagnosticStatus.textContent = formatDiagnostic(routes || null);
    setTimeout(() => {
      testButton.disabled = false;
      testButton.textContent = '🔔 测试所选通知通道';
    }, 2_200);
    void refreshMonitorStatus();
  }

  async function previewSelectedSound() {
    if (elements.soundTheme.value === 'system') {
      previewSound.textContent = '请用测试通知';
      setTimeout(() => {
        previewSound.textContent = '试听';
        syncSoundControls();
      }, 1_200);
      return;
    }
    previewSound.disabled = true;
    const settings = formSettings();
    const result = await sendMessage({
      type: 'preview-sound',
      theme: settings.soundTheme,
      volume: settings.soundVolume,
    });
    previewSound.textContent = result?.ok ? '已播放' : '失败';
    setTimeout(() => {
      previewSound.textContent = '试听';
      syncSoundControls();
    }, 900);
  }

  async function openBrowserSettings() {
    openNotificationSettings.disabled = true;
    const result = await sendMessage({ type: 'open-browser-notification-settings' });
    if (!result?.ok) {
      diagnosticStatus.textContent = `无法自动打开浏览器通知设置${result?.error ? `：${result.error}` : '。'} ${notificationHelp()}`;
    }
    setTimeout(() => { openNotificationSettings.disabled = false; }, 700);
  }

  async function initialize() {
    configurePlatformCopy();
    const stored = await storageGet({});
    const settings = api.migrateSettings(stored);
    await storageSet(settings);
    render(settings);
    for (const element of Object.values(elements)) {
      element.addEventListener('change', scheduleSave);
      if (element === elements.notificationBackend) element.addEventListener('change', () => void refreshNotificationStatus());
      element.addEventListener('input', scheduleSave);
    }
    refreshStatus.addEventListener('click', () => {
      void refreshNotificationStatus();
      void refreshMonitorStatus();
    });
    testButton.addEventListener('click', () => void testNotification());
    previewSound.addEventListener('click', () => void previewSelectedSound());
    openButton.addEventListener('click', () => void sendMessage({ type: 'open-chatgpt' }));
    openNotificationSettings.addEventListener('click', () => void openBrowserSettings());
    void refreshNotificationStatus();
    void refreshMonitorStatus();
  }

  void initialize();
})();
