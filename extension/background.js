const OFFSCREEN_URL = 'offscreen.html';
const DEFAULT_SETTINGS = Object.freeze({ pitch: 0, tempo: 1, vocal: 0, channelMode: 'stereo', bass: 0, treble: 0, volume: 100 });
let creatingOffscreen = null;

function normalizeSettings(value = {}) {
  const limits = { pitch: [-12, 12], tempo: [0.5, 1.5], vocal: [0, 100], bass: [-12, 12], treble: [-12, 12], volume: [0, 100] };
  const next = { ...DEFAULT_SETTINGS };
  for (const [key, [min, max]] of Object.entries(limits)) {
    const n = Number(value[key]);
    if (Number.isFinite(n)) next[key] = Math.max(min, Math.min(max, n));
  }
  next.pitch = Math.round(next.pitch);
  const modes = ['stereo', 'left', 'right', 'center'];
  // v0.1 settings had a vocal slider but no routing mode. Preserve its behavior.
  next.channelMode = modes.includes(value.channelMode)
    ? value.channelMode
    : next.vocal > 0 ? 'center' : 'stereo';
  return next;
}

function isYoutube(url) {
  try {
    const host = new URL(url).hostname;
    return ['www.youtube.com', 'youtube.com', 'music.youtube.com'].includes(host);
  } catch { return false; }
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Apply local audio effects to the YouTube tab selected by the user.'
  });
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}

async function offscreen(message) {
  if (!await hasOffscreen()) return { active: false };
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

async function sendTempo(tabId, tempo, reset = false) {
  if (!Number.isInteger(tabId)) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: reset ? 'RESTORE_TEMPO' : 'APPLY_TEMPO',
      tempo
    });
  } catch {
    // Player content script may not be ready during reload/navigation.
  }
}

async function getStatus() {
  if (!await hasOffscreen()) return { active: false };
  try { return await offscreen({ type: 'STATUS' }); }
  catch { return { active: false }; }
}

async function stop() {
  const current = await getStatus();
  if (current.active) {
    await offscreen({ type: 'STOP' });
    await sendTempo(current.tabId, 1, true);
  }
  return { active: false };
}

async function start(tab) {
  if (!tab?.id || !isYoutube(tab.url)) {
    throw new Error('請先開啟 YouTube 影片分頁，再按下開始處理。');
  }
  const current = await getStatus();
  if (current.active) {
    if (current.tabId === tab.id) return current;
    await stop();
  }
  const { settings: saved } = await chrome.storage.local.get('settings');
  const settings = normalizeSettings(saved);
  await ensureOffscreen();

  // A stream ID expires quickly. Fetch it only after the offscreen page is ready.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  try {
    const result = await offscreen({ type: 'START', streamId, tabId: tab.id, settings });
    if (!result?.active) throw new Error(result?.error || '音訊擷取未成功啟動。');
    await sendTempo(tab.id, settings.tempo);
    return result;
  } catch (error) {
    await sendTempo(tab.id, 1, true);
    throw error;
  }
}

async function update(partial) {
  const { settings: saved } = await chrome.storage.local.get('settings');
  const settings = normalizeSettings({ ...saved, ...partial });
  await chrome.storage.local.set({ settings });
  const current = await getStatus();
  if (current.active) {
    await offscreen({ type: 'UPDATE', settings });
    await sendTempo(current.tabId, settings.tempo);
  }
  return settings;
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS } });
});

// Content scripts run inside YouTube pages, so only the popup may drive capture/settings.
const ALLOWED_SENDERS = {
  STATUS: 'popup', START: 'popup', STOP: 'popup', UPDATE: 'popup', RESET: 'popup',
  CONTENT_READY: 'content', ENGINE_ENDED: 'offscreen'
};

function senderKind(sender) {
  if (sender.tab) return 'content';
  if (sender.url === chrome.runtime.getURL('popup.html')) return 'popup';
  if (sender.url === chrome.runtime.getURL(OFFSCREEN_URL)) return 'offscreen';
  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return false;
  if (message?.target !== 'background') return false;
  (async () => {
    const allowed = ALLOWED_SENDERS[message.type];
    if (allowed && allowed !== senderKind(sender)) throw new Error('Unauthorized sender');
    switch (message.type) {
      case 'STATUS': {
        const { settings: saved } = await chrome.storage.local.get('settings');
        return { ...(await getStatus()), settings: normalizeSettings(saved) };
      }
      // Look the tab up instead of trusting a URL supplied in the message.
      case 'START': return start(Number.isInteger(message.tabId) ? await chrome.tabs.get(message.tabId) : null);
      case 'STOP': return stop();
      case 'UPDATE': return { settings: await update(message.settings) };
      case 'RESET': return { settings: await update(DEFAULT_SETTINGS) };
      case 'CONTENT_READY': {
        const current = await getStatus();
        if (current.active && current.tabId === sender.tab?.id) {
          const { settings: saved } = await chrome.storage.local.get('settings');
          await sendTempo(current.tabId, normalizeSettings(saved).tempo);
        }
        return {};
      }
      case 'ENGINE_ENDED': {
        await sendTempo(message.tabId, 1, true);
        return {};
      }
      default: throw new Error('Unknown command');
    }
  })().then(value => sendResponse({ ok: true, ...value }))
    .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const current = await getStatus();
  if (current.active && current.tabId === tabId) await stop();
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  // Without the "tabs" permission Chrome hides non-YouTube URLs (tab.url is
  // undefined), so a missing URL also means the captured tab left YouTube.
  if (!info.status || isYoutube(tab?.url)) return;
  const current = await getStatus();
  if (current.active && current.tabId === tabId) await stop();
});
