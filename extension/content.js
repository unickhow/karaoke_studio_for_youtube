// Only changes the YouTube playback rate while processing is enabled.
// Native preservesPitch=true keeps tempo and musical key separate.
let enabled = false;
let tempo = 1;
let video = null;
let originalRate = 1;
let lastApply = 0;

function findVideo() {
  return document.querySelector('video.html5-main-video') || document.querySelector('video');
}

function sync() {
  if (!enabled) return;
  const current = findVideo();
  if (!current) return;
  if (video !== current) {
    video = current;
    originalRate = current.playbackRate;
  }
  video.preservesPitch = true;
  if (Math.abs(video.playbackRate - tempo) > 0.005) {
    lastApply = Date.now();
    video.playbackRate = tempo;
  }
}

function restore() {
  enabled = false;
  if (video?.isConnected) video.playbackRate = originalRate;
  video = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'APPLY_TEMPO') {
    tempo = Math.min(1.5, Math.max(0.5, Number(message.tempo) || 1));
    if (!enabled) { video = null; enabled = true; }
    sync();
    sendResponse({ ok: !!video });
  }
  if (message?.type === 'RESTORE_TEMPO') {
    restore();
    sendResponse({ ok: true });
  }
  return false;
});

document.addEventListener('ratechange', () => {
  if (enabled && Date.now() - lastApply > 80) setTimeout(sync, 40);
}, true);
window.addEventListener('yt-navigate-finish', () => setTimeout(sync, 150));
setInterval(sync, 1200);

// Reapply the saved tempo after a YouTube page reload while audio is still active.
chrome.runtime.sendMessage({ target: 'background', type: 'CONTENT_READY' }).catch(() => {});
