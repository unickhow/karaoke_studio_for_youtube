// Shared by the popup and the in-page panel (loaded as a classic script in both).
const PRESETS = {
  original: { pitch: 0, tempo: 1, vocal: 0, channelMode: 'stereo', bass: 0, treble: 0, volume: 100 },
  karaoke: { pitch: 0, tempo: 1, vocal: 75, channelMode: 'center', bass: 2, treble: 0, volume: 100 },
  practice: { pitch: 0, tempo: 0.85, vocal: 35, channelMode: 'center', bass: 0, treble: 1, volume: 100 }
};
const KEYS = ['pitch', 'tempo', 'vocal', 'bass', 'treble', 'volume'];
const MODES = ['stereo', 'left', 'right', 'center'];

async function command(type, extras = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type, ...extras });
  if (!response?.ok) throw new Error(response?.error || '擴充功能無法執行這項操作。');
  return response;
}

function displayValue(key, value) {
  switch (key) {
    case 'pitch': return value > 0 ? `+${value}` : `${value}`;
    case 'tempo': return `${Number(value).toFixed(2)}×`;
    case 'vocal': case 'volume': return `${value}%`;
    default: return `${value > 0 ? '+' : ''}${value} dB`;
  }
}
