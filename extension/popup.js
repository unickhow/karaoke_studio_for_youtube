const PRESETS = {
  original: { pitch: 0, tempo: 1, vocal: 0, channelMode: 'stereo', bass: 0, treble: 0, volume: 100 },
  karaoke: { pitch: 0, tempo: 1, vocal: 75, channelMode: 'center', bass: 2, treble: 0, volume: 100 },
  practice: { pitch: 0, tempo: 0.85, vocal: 35, channelMode: 'center', bass: 0, treble: 1, volume: 100 }
};
const KEYS = ['pitch', 'tempo', 'vocal', 'bass', 'treble', 'volume'];
const MODES = ['stereo', 'left', 'right', 'center'];
let settings = { ...PRESETS.original };
let currentTab = null;
let activeTabId = null;
let busy = false;
let timer = null;
const $ = id => document.getElementById(id);

async function command(type, extras = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type, ...extras });
  if (!response?.ok) throw new Error(response?.error || '擴充功能無法執行這項操作。');
  return response;
}

function showNotice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}

function displayValue(key, value) {
  switch (key) {
    case 'pitch': return value > 0 ? `+${value}` : `${value}`;
    case 'tempo': return `${Number(value).toFixed(2)}×`;
    case 'vocal': case 'volume': return `${value}%`;
    default: return `${value > 0 ? '+' : ''}${value} dB`;
  }
}

function redraw() {
  for (const key of KEYS) {
    const slider = $(key);
    slider.value = settings[key];
    $(key + 'Value').textContent = displayValue(key, settings[key]);
    const fill = 100 * (Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min));
    slider.style.setProperty('--fill', `${fill}%`);
  }
  for (const radio of document.querySelectorAll('input[name="channelMode"]')) {
    radio.checked = radio.value === settings.channelMode;
  }
  const centerEnabled = settings.channelMode === 'center';
  $('vocal').disabled = !centerEnabled;
  $('vocalControl').classList.toggle('is-disabled', !centerEnabled);
  const descriptions = {
    stereo: ['L → L  /  R → R', '原始立體聲，不移除人聲。'],
    left: ['L → L + R', '左聲道複製到雙耳；適合左聲道只有伴奏的音源。'],
    right: ['R → L + R', '右聲道複製到雙耳；適合右聲道只有伴奏的音源。'],
    center: ['L − R', '透過聲道差分弱化置中聲音，部分樂器也可能被消除。']
  };
  const [route, detail] = descriptions[settings.channelMode] || descriptions.stereo;
  $('routeValue').textContent = route;
  $('channelDescription').textContent = detail;
  for (const b of document.querySelectorAll('[data-preset]')) {
    const preset = PRESETS[b.dataset.preset];
    b.classList.toggle('active', preset.channelMode === settings.channelMode &&
      KEYS.every(k => Number(preset[k]) === Number(settings[k])));
  }
}

function redrawStatus() {
  const runningHere = activeTabId === currentTab?.id;
  $('indicator').classList.toggle('on', runningHere);
  $('connectionText').textContent = runningHere ? 'LIVE' : 'OFF';
  $('toggle').classList.toggle('on', runningHere);
  $('toggleLabel').textContent = runningHere ? '停止處理 · 恢復原音' : '開始處理音訊';
  $('toggle').disabled = busy;
  if (runningHere) showNotice('處理中 · 關閉此面板，音效仍會持續。');
  else if (activeTabId) showNotice('另一個 YouTube 分頁正在使用音效。啟動本頁會切換音源。');
  else showNotice('在 YouTube 開啟影片後，按下「開始處理音訊」。');
}

function change(partial) {
  settings = { ...settings, ...partial };
  redraw();
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try { await command('UPDATE', { settings }); }
    catch (e) { showNotice(e.message, true); }
  }, 75);
}

async function flushSettings() {
  clearTimeout(timer);
  await command('UPDATE', { settings });
}

async function initialize() {
  try {
    [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await command('STATUS');
    settings = result.settings;
    activeTabId = result.active ? result.tabId : null;
    redraw();
    redrawStatus();
  } catch (e) { showNotice(e.message, true); }
}

for (const key of KEYS) {
  $(key).addEventListener('input', e => {
    change({ [key]: Number(e.target.value) });
  });
}
for (const radio of document.querySelectorAll('input[name="channelMode"]')) {
  radio.addEventListener('change', () => {
    if (!radio.checked || !MODES.includes(radio.value)) return;
    // Selecting reduction should have an audible default; otherwise preserve
    // the last chosen strength when changing between channel modes.
    change({ channelMode: radio.value,
      ...(radio.value === 'center' && settings.vocal === 0 ? { vocal: 75 } : {}) });
  });
}
$('pitchDown').addEventListener('click', () => change({ pitch: Math.max(-12, settings.pitch - 1) }));
$('pitchUp').addEventListener('click', () => change({ pitch: Math.min(12, settings.pitch + 1) }));
for (const b of document.querySelectorAll('[data-preset]')) {
  b.addEventListener('click', () => change(PRESETS[b.dataset.preset]));
}
$('reset').addEventListener('click', () => change(PRESETS.original));
$('advancedToggle').addEventListener('click', () => {
  const open = $('advancedPanel').hidden;
  $('advancedPanel').hidden = !open;
  $('advancedToggle').setAttribute('aria-expanded', String(open));
  $('arrow').textContent = open ? '⌃' : '⌄';
});
$('toggle').addEventListener('click', async () => {
  if (busy) return;
  busy = true; $('toggle').disabled = true;
  try {
    await flushSettings();
    if (activeTabId === currentTab?.id) {
      await command('STOP');
      activeTabId = null;
    } else {
      const result = await command('START', { tabId: currentTab?.id });
      activeTabId = result.tabId;
    }
    redrawStatus();
  } catch (error) {
    showNotice(error.message, true);
  } finally { busy = false; $('toggle').disabled = false; }
});
initialize();
