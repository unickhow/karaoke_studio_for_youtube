/** Message-sender and capture-lifecycle checks, runnable with `node test-background.js`. */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const extension = path.join(__dirname, 'extension');
const BASE = 'chrome-extension://abc/';

function loadBackground({ tabs = {}, captured = null } = {}) {
  const calls = { offscreen: [], tabMessages: [], streamIds: [] };
  let hasDocument = captured !== null;
  const listeners = {};
  let stored = { settings: { pitch: 0, tempo: 1, vocal: 0, channelMode: 'stereo', bass: 0, treble: 0, volume: 100 } };
  const chrome = {
    runtime: {
      id: 'abc',
      getURL: p => BASE + p,
      getContexts: async () => (hasDocument ? [{}] : []),
      sendMessage: async message => {
        calls.offscreen.push(message.type);
        if (message.type === 'STATUS') return captured ? { active: true, tabId: captured } : { active: false };
        if (message.type === 'STOP') { captured = null; return { active: false }; }
        if (message.type === 'START') { captured = message.tabId; return { active: true, tabId: message.tabId }; }
        return { active: !!captured };
      },
      onInstalled: { addListener() {} },
      onMessage: { addListener(fn) { listeners.message = fn; } }
    },
    tabs: {
      get: async id => { if (!(id in tabs)) throw new Error('No tab'); return tabs[id]; },
      sendMessage: async (tabId, message) => { calls.tabMessages.push([tabId, message.type]); },
      onRemoved: { addListener() {} },
      onUpdated: { addListener(fn) { listeners.updated = fn; } }
    },
    storage: { local: {
      get: async () => stored,
      set: async value => { stored = { ...stored, ...value }; }
    } },
    tabCapture: { getMediaStreamId: async ({ targetTabId }) => { calls.streamIds.push(targetTabId); return 'sid'; } },
    offscreen: { createDocument: async () => { hasDocument = true; } }
  };
  const sandbox = { chrome, URL };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), sandbox);
  const send = (message, sender) => new Promise(resolve => {
    listeners.message({ target: 'background', ...message }, sender, resolve);
  });
  return { calls, send, listeners, settings: () => stored.settings };
}

const popup = { id: 'abc', url: BASE + 'popup.html' };
const offscreenPage = { id: 'abc', url: BASE + 'offscreen.html' };
const youtubeTab = { id: 3, url: 'https://www.youtube.com/watch?v=x' };
const contentScript = { id: 'abc', url: youtubeTab.url, tab: youtubeTab };

(async () => {
  {
    const bg = loadBackground();
    const res = await bg.send({ type: 'UPDATE', settings: { volume: 0 } }, contentScript);
    assert.equal(res.ok, false, 'content scripts must not change settings');
    assert.equal(bg.settings().volume, 100);
  }
  {
    const bg = loadBackground();
    const res = await bg.send({ type: 'UPDATE', settings: { volume: 40 } }, popup);
    assert.equal(res.ok, true, 'popup may change settings');
    assert.equal(bg.settings().volume, 40);
  }
  {
    const bg = loadBackground({ tabs: { 7: { id: 7 } } });
    const res = await bg.send({ type: 'START', tabId: 7, tab: { id: 7, url: 'https://www.youtube.com/' } }, popup);
    assert.equal(res.ok, false, 'START must check the real tab URL, not the one in the message');
    assert.deepEqual(bg.calls.streamIds, []);
  }
  {
    const bg = loadBackground({ tabs: { 3: youtubeTab } });
    const res = await bg.send({ type: 'START', tabId: 3 }, popup);
    assert.equal(res.ok, true, 'popup may start capture of a real YouTube tab: ' + res.error);
    assert.deepEqual(bg.calls.streamIds, [3]);
  }
  {
    const bg = loadBackground({ tabs: { 3: youtubeTab } });
    const res = await bg.send({ type: 'START', tabId: 3 }, contentScript);
    assert.equal(res.ok, false, 'content scripts must not start capture');
    assert.deepEqual(bg.calls.streamIds, []);
  }
  {
    const bg = loadBackground();
    await bg.send({ type: 'ENGINE_ENDED', tabId: 9 }, contentScript);
    assert.deepEqual(bg.calls.tabMessages, [], 'only the offscreen engine may report ENGINE_ENDED');
    await bg.send({ type: 'ENGINE_ENDED', tabId: 9 }, offscreenPage);
    assert.deepEqual(bg.calls.tabMessages, [[9, 'RESTORE_TEMPO']]);
  }
  {
    // Without the "tabs" permission Chrome hides non-YouTube URLs, so tab.url is undefined.
    const bg = loadBackground({ captured: 3 });
    await bg.listeners.updated(3, { status: 'complete' }, { id: 3 });
    assert.ok(bg.calls.offscreen.includes('STOP'), 'capture stops when the tab leaves YouTube');
  }
  {
    const bg = loadBackground({ captured: 3 });
    await bg.listeners.updated(3, { status: 'complete' }, youtubeTab);
    assert.ok(!bg.calls.offscreen.includes('STOP'), 'capture continues on YouTube navigation');
  }

  let offscreenListener;
  const sandbox = {
    chrome: { runtime: { getURL: p => BASE + p, onMessage: { addListener(fn) { offscreenListener = fn; } } } },
    navigator: { mediaDevices: {} },
    AudioContext: function () {}
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(extension, 'offscreen.js'), 'utf8'), sandbox);
  assert.equal(offscreenListener({ target: 'offscreen', type: 'STOP' }, contentScript, () => {}), false,
    'offscreen engine ignores content scripts');
  assert.equal(offscreenListener({ target: 'offscreen', type: 'STATUS' }, { id: 'abc', url: BASE + 'background.js' }, () => {}), true,
    'offscreen engine accepts the service worker');

  console.log('PASS: sender checks, real-tab URL check, stop on leaving YouTube');
})().catch(error => { console.error(error); process.exit(1); });
