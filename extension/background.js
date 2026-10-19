const OFFSCREEN_URL = 'offscreen.html';
const DEFAULT_SETTINGS = Object.freeze({ pitch: 0, pitchEngine: 'quality', tempo: 1, vocal: 0, channelMode: 'stereo', bass: 0, treble: 0, volume: 100 });
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
  next.pitchEngine = ['quality', 'fast'].includes(value.pitchEngine) ? value.pitchEngine : 'quality';
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

// Push live state to the in-page panel of a tab (it may not exist).
function notifyPanel(tabId, state) {
  if (!Number.isInteger(tabId)) return;
  chrome.tabs.sendMessage(tabId, { type: 'PANEL_STATE', ...state }).catch(() => {});
}

async function shortcutLabel() {
  const commands = await chrome.commands.getAll();
  return commands.find(c => c.name === 'toggle-processing')?.shortcut || '';
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
    notifyPanel(current.tabId, { active: false });
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
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch {
    // tabCapture needs an activeTab grant: an icon click or the keyboard shortcut.
    const key = await shortcutLabel();
    const error = new Error(`尚未授權擷取此分頁：請按 ${key || '擴充功能快捷鍵'} 或點一次擴充功能圖示。`);
    error.needsGrant = true;
    throw error;
  }
  try {
    const result = await offscreen({ type: 'START', streamId, tabId: tab.id, settings });
    if (!result?.active) throw new Error(result?.error || '音訊擷取未成功啟動。');
    await sendTempo(tab.id, settings.tempo);
    notifyPanel(tab.id, { active: true, layout: result.layout });
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

// Content scripts run inside YouTube pages: the in-page panel may change settings,
// but can only start/stop capture of its own tab (see START/STOP below).
const ALLOWED_SENDERS = {
  STATUS: ['popup', 'content'], START: ['popup', 'content'], STOP: ['popup', 'content'],
  UPDATE: ['popup', 'content'], RESET: ['popup', 'content'],
  CONTENT_READY: ['content'], ENGINE_ENDED: ['offscreen'], CHANNEL_INFO: ['offscreen']
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
    if (allowed && !allowed.includes(senderKind(sender))) throw new Error('Unauthorized sender');
    switch (message.type) {
      case 'STATUS': {
        const { settings: saved } = await chrome.storage.local.get('settings');
        const current = await getStatus();
        return {
          ...current,
          here: !!current.active && current.tabId === sender.tab?.id,
          settings: normalizeSettings(saved),
          shortcut: await shortcutLabel()
        };
      }
      case 'START': {
        // Look the tab up instead of trusting a URL supplied in the message.
        const tabId = sender.tab ? sender.tab.id : message.tabId;
        return start(Number.isInteger(tabId) ? await chrome.tabs.get(tabId) : null);
      }
      case 'STOP': {
        if (sender.tab && (await getStatus()).tabId !== sender.tab.id) return { active: false };
        return stop();
      }
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
        notifyPanel(message.tabId, { active: false });
        return {};
      }
      case 'CHANNEL_INFO': {
        notifyPanel(message.tabId, { active: true, layout: message.layout });
        return {};
      }
      default: throw new Error('Unknown command');
    }
  })().then(value => sendResponse({ ok: true, ...value }))
    .catch(error => sendResponse({ ok: false, error: error.message || String(error), needsGrant: !!error.needsGrant }));
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

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-processing') return;
  try {
    const current = await getStatus();
    if (current.active && current.tabId === tab?.id) await stop();
    else await start(tab);
  } catch (error) {
    notifyPanel(tab?.id, { error: error.message || String(error) });
  }
});
