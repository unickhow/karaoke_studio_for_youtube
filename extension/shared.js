// Shared by the popup and the in-page panel (loaded as a classic script in both).
const PRESETS = {
  original: { pitch: 0, tempo: 1, vocal: 0, channelMode: 'stereo', bass: 0, treble: 0, volume: 100 },
  karaoke: { pitch: 0, tempo: 1, vocal: 75, channelMode: 'center', bass: 2, treble: 0, volume: 100 },
  practice: { pitch: 0, tempo: 0.85, vocal: 35, channelMode: 'center', bass: 0, treble: 1, volume: 100 }
};
const KEYS = ['pitch', 'tempo', 'vocal', 'bass', 'treble', 'volume'];
const MODES = ['stereo', 'left', 'right', 'center'];
// UI text lives in _locales; a missing key shows the key itself rather than nothing.
function t(key, ...substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

// Fill static markup: data-i18n sets the text, data-i18n-aria the accessible name.
function localize(root = document) {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of root.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.dataset.i18nAria));
}

const ENGINES = {
  quality: { label: t('engineQuality'), hint: t('engineQualityHint') },
  fast: { label: t('engineFast'), hint: t('engineFastHint') }
};
// Conventional key-signature spelling for each tonic (C = 0).
const KEY_SPELLING = {
  major: ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'],
  minor: ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B']
};

/** Name of a detected key after shifting it by some semitones, e.g. "A major". */
function keyName(key, shift = 0) {
  const note = KEY_SPELLING[key.mode][(((key.tonic + shift) % 12) + 12) % 12];
  return key.mode === 'major' ? t('keyMajor', note) : t('keyMinor', note);
}

/** Key line under the pitch control: '' when idle, detecting, or original → shifted. */
function keyText(live, key, shift) {
  if (!live) return '';
  if (!key) return t('keyDetecting');
  return shift % 12 ? t('keyShifted', keyName(key), keyName(key, shift)) : t('keyOriginal', keyName(key));
}

const MODE_LABELS = { stereo: t('modeStereo'), left: t('modeLeft'), right: t('modeRight'), center: t('modeCenter') };

async function command(type, extras = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type, ...extras });
  if (!response?.ok) {
    const error = new Error(response?.error || t('errorGeneric'));
    error.needsGrant = !!response?.needsGrant;
    throw error;
  }
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
