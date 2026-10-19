// In-page controls under the YouTube player, mirroring the popup.
// Settings are shared through chrome.storage; live state comes from the background worker.
(() => {
  const MODE_LABELS = { stereo: '原始立體聲', left: '只聽左聲道', right: '只聽右聲道', center: '弱化人聲' };
  const LAYOUT_LABELS = { detecting: '偵測聲道中…', stereo: '立體聲 · 左右不同', mono: '單聲道 · 左右相同' };
  const LAYOUT_HINTS = {
    detecting: '正在比較原始音訊的左右聲道。',
    stereo: '左右聲道內容不同：只聽左／右聲道與弱化人聲會有效果。',
    mono: '左右聲道內容相同。'
  };

  let settings = { ...PRESETS.original };
  let live = false;       // this tab is being processed
  let elsewhere = false;  // another tab is being processed
  let layout = null;
  let shortcut = '';
  let collapsed = false;
  let enabled = false;    // opt-in from the popup ("panelEnabled")
  // Shown only after processing was started from the extension on this page: that grants
  // tab capture, which the panel's own button cannot do. A reload resets this script and the grant.
  let unlocked = false;
  let busy = false;
  let notice = null;      // { text, error }
  let timer = null;
  let lastLocalEdit = 0;
  const ui = { modes: [], engines: [], presets: [] };

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  }

  function slider(key, label, min, max, step) {
    const input = h('input', { type: 'range', min, max, step, 'aria-label': label,
      oninput: () => change({ [key]: Number(input.value) }) });
    const out = h('output');
    const field = h('div', { class: 'field' }, h('div', { class: 'field-head' }, h('span', {}, label), out));
    ui[key] = { input, out, field };
    return { field, input };
  }

  function change(partial) {
    settings = { ...settings, ...partial };
    lastLocalEdit = Date.now();
    redraw();
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { await command('UPDATE', { settings }); }
      catch (e) { notice = { text: e.message, error: true }; redraw(); }
    }, 75);
  }

  async function toggle() {
    if (busy) return;
    busy = true; redraw();
    try {
      clearTimeout(timer);
      await command('UPDATE', { settings });
      if (live) {
        await command('STOP');
        live = false; layout = null;
      } else {
        const result = await command('START');
        live = true; elsewhere = false; layout = result.layout || 'detecting';
      }
      notice = null;
    } catch (e) {
      if (e.needsGrant) {
        // The grant is gone; hide rather than show controls that cannot start.
        unlocked = false; notice = null; mount();
      } else {
        notice = { text: e.message, error: true };
      }
    } finally {
      busy = false; redraw();
    }
  }

  async function refreshStatus() {
    try {
      const result = await command('STATUS');
      live = result.here;
      if (live) { unlocked = true; mount(); }
      elsewhere = result.active && !result.here;
      layout = result.here ? result.layout : null;
      shortcut = result.shortcut;
      if (Date.now() - lastLocalEdit > 500) settings = result.settings;
      redraw();
    } catch (e) {
      notice = { text: e.message, error: true }; redraw();
    }
  }

  function build() {
    const pitch = slider('pitch', 'Pitch / Key', -12, 12, 1);
    pitch.field.append(h('div', { class: 'pitch-row' },
      h('button', { type: 'button', class: 'step', 'aria-label': '降半音',
        onclick: () => change({ pitch: Math.max(-12, settings.pitch - 1) }) }, '−'),
      pitch.input,
      h('button', { type: 'button', class: 'step', 'aria-label': '升半音',
        onclick: () => change({ pitch: Math.min(12, settings.pitch + 1) }) }, '+')));
    pitch.field.append(h('div', { class: 'modes engines', role: 'radiogroup', 'aria-label': '變調引擎' },
      ...Object.entries(ENGINES).map(([engine, { label }]) => {
        const input = h('input', { type: 'radio', name: 'ks-engine', value: engine,
          onchange: () => { if (input.checked) change({ pitchEngine: engine }); } });
        ui.engines.push(input);
        return h('label', { class: 'mode' }, input, h('span', {}, label));
      })),
      ui.engineHint = h('p', { class: 'hint' }));
    const tempo = slider('tempo', 'Tempo', 0.5, 1.5, 0.05);
    tempo.field.append(tempo.input);

    const modes = h('div', { class: 'modes', role: 'radiogroup', 'aria-label': '聲道模式' },
      ...MODES.map(mode => {
        const input = h('input', { type: 'radio', name: 'ks-channel', value: mode, onchange: () => {
          if (!input.checked) return;
          change({ channelMode: mode, ...(mode === 'center' && settings.vocal === 0 ? { vocal: 75 } : {}) });
        } });
        ui.modes.push(input);
        return h('label', { class: 'mode' }, input, h('span', {}, MODE_LABELS[mode]));
      }));
    const vocal = slider('vocal', '人聲弱化強度', 0, 100, 5);
    vocal.field.append(vocal.input);
    ui.monoWarning = h('p', { class: 'warning', hidden: '' },
      '偵測到單聲道：只聽左／右聲道不會有差異，弱化人聲會讓整體音量大幅下降。');

    const eq = ['bass', 'treble', 'volume'].map(key => {
      const s = slider(key, { bass: 'Bass', treble: 'Treble', volume: '輸出音量' }[key],
        key === 'volume' ? 0 : -12, key === 'volume' ? 100 : 12, key === 'volume' ? 5 : 1);
      s.field.append(s.input);
      return s.field;
    });

    const presets = h('div', { class: 'presets', role: 'group', 'aria-label': '快速預設' },
      ...Object.keys(PRESETS).map(name => {
        const button = h('button', { type: 'button', class: 'preset', 'data-preset': name,
          onclick: () => change(PRESETS[name]) }, name[0].toUpperCase() + name.slice(1));
        ui.presets.push(button);
        return button;
      }),
      h('button', { type: 'button', class: 'preset reset', onclick: () => change(PRESETS.original) }, '↺ Reset'));

    ui.pill = h('span', { class: 'pill' }, h('span', { class: 'led' }), ui.pillText = h('span', {}, 'OFF'));
    ui.badge = h('span', { class: 'badge', hidden: '' });
    ui.toggle = h('button', { type: 'button', class: 'toggle', onclick: toggle });
    ui.collapse = h('button', { type: 'button', class: 'icon-btn', 'aria-controls': 'ks-body',
      onclick: () => {
        collapsed = !collapsed;
        chrome.storage.local.set({ panelCollapsed: collapsed }).catch(() => {});
        redraw();
      } });
    ui.notice = h('p', { class: 'notice', role: 'status' });
    ui.body = h('div', { class: 'body', id: 'ks-body' },
      presets,
      h('div', { class: 'grid' },
        h('section', { class: 'group' }, h('h3', {}, 'Key · Tempo'), pitch.field, tempo.field),
        h('section', { class: 'group' }, h('h3', {}, '聲道'), modes, vocal.field, ui.monoWarning),
        h('section', { class: 'group' }, h('h3', {}, '音色 · 音量'), ...eq)));

    return h('div', { class: 'panel' },
      h('div', { class: 'bar' },
        h('span', { class: 'logo', 'aria-hidden': 'true' }, '♫'),
        h('strong', { class: 'title' }, 'Karaoke Studio'),
        ui.pill, ui.badge,
        h('span', { class: 'spacer' }),
        ui.toggle, ui.collapse),
      ui.notice,
      ui.body);
  }

  function redraw() {
    for (const key of KEYS) {
      const { input, out } = ui[key];
      input.value = settings[key];
      out.textContent = displayValue(key, settings[key]);
      input.style.setProperty('--fill', `${100 * (input.value - input.min) / (input.max - input.min)}%`);
    }
    for (const input of ui.modes) input.checked = input.value === settings.channelMode;
    for (const input of ui.engines) input.checked = input.value === settings.pitchEngine;
    ui.engineHint.textContent = ENGINES[settings.pitchEngine]?.hint || '';
    const center = settings.channelMode === 'center';
    ui.vocal.input.disabled = !center;
    ui.vocal.field.classList.toggle('disabled', !center);
    for (const button of ui.presets) {
      const preset = PRESETS[button.dataset.preset];
      button.classList.toggle('active', preset.channelMode === settings.channelMode &&
        KEYS.every(k => Number(preset[k]) === Number(settings[k])));
    }

    ui.pill.classList.toggle('on', live);
    ui.pillText.textContent = live ? 'LIVE' : 'OFF';
    ui.badge.hidden = !(live && layout);
    if (live && layout) {
      ui.badge.textContent = LAYOUT_LABELS[layout] || layout;
      ui.badge.title = LAYOUT_HINTS[layout] || '';
      ui.badge.className = `badge ${layout}`;
    }
    ui.monoWarning.hidden = !(live && layout === 'mono');
    ui.toggle.textContent = busy ? '處理中…' : live ? '停止 · 恢復原音' : '開始處理';
    ui.toggle.classList.toggle('on', live);
    ui.toggle.disabled = busy;
    ui.body.hidden = collapsed;
    ui.collapse.setAttribute('aria-expanded', String(!collapsed));
    ui.collapse.setAttribute('aria-label', collapsed ? '展開控制項' : '收合控制項');
    ui.collapse.textContent = collapsed ? '⌄' : '⌃';

    const key = shortcut ? `或按 ${shortcut} ` : '';
    const text = notice?.text
      ?? (live ? '' : elsewhere ? '另一個分頁正在使用音效，按「開始處理」會切換到這裡。'
        : `按「開始處理」${key}啟動；設定會保留並在啟動後套用。`);
    ui.notice.textContent = text;
    ui.notice.hidden = !text;
    ui.notice.classList.toggle('error', !!notice?.error);
  }

  const host = h('div', { id: 'karaoke-studio-panel' });
  const root = host.attachShadow({ mode: 'closed' });
  root.append(h('style', {}, `
    :host { all: initial; display: block; margin: 12px 0 8px; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .panel {
      --bg: #151819; --raised: #1e2425; --line: #323b3b; --text: #f1f6f4; --muted: #98a7a3; --mint: #90e5ca;
      color-scheme: dark; background: var(--bg); color: var(--text); border: 1px solid var(--line);
      border-radius: 12px; font: 13px/1.4 Roboto, Arial, sans-serif;
    }
    button, input { font: inherit; color: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: progress; opacity: .6; }
    :focus-visible { outline: 2px solid var(--mint); outline-offset: 2px; }
    .bar { display: flex; align-items: center; gap: 10px; padding: 10px 12px; flex-wrap: wrap; }
    .logo { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center;
      background: #2a3935; color: var(--mint); font-size: 17px; }
    .title { font-size: 14px; font-weight: 700; }
    .pill { display: inline-flex; gap: 6px; align-items: center; border: 1px solid #33403c; border-radius: 12px;
      padding: 3px 8px; font-size: 10px; font-weight: 700; letter-spacing: .5px; color: #aebdb8; }
    .led { width: 6px; height: 6px; border-radius: 50%; background: #75827c; }
    .pill.on { background: #203a31; color: var(--mint); border-color: #396653; }
    .pill.on .led { background: var(--mint); box-shadow: 0 0 8px #90e5ca99; }
    .badge { font-size: 11px; padding: 3px 8px; border-radius: 6px; background: #263832; color: var(--mint); cursor: help; }
    .badge.detecting { background: #262c2c; color: var(--muted); }
    .badge.mono { background: #3a3424; color: #f3d48b; }
    .spacer { flex: 1; }
    .toggle { min-height: 36px; padding: 0 18px; border-radius: 18px; border: 1px solid transparent;
      background: var(--mint); color: #112a20; font-weight: 700; }
    .toggle.on { background: #343d3c; color: var(--text); border-color: #59625e; }
    .icon-btn { width: 36px; height: 36px; border-radius: 50%; border: 1px solid var(--line); background: transparent;
      font-size: 18px; line-height: 1; }
    .notice { margin: 0 12px 10px; font-size: 12px; color: var(--muted); }
    .notice.error { background: #432b2b; color: #ffc0c0; padding: 8px 10px; border-radius: 8px; }
    .body { border-top: 1px solid var(--line); padding: 12px; }
    .presets { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
    .preset { min-height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid #3b4542;
      background: var(--raised); color: #b3c0bc; font-size: 12px; font-weight: 600; }
    .preset.active { background: #29453b; border-color: #4b8770; color: #a8f5d7; }
    .preset.reset { margin-left: auto; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
    .group { background: var(--raised); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
    h3 { margin: 0; font-size: 10px; font-weight: 700; letter-spacing: 1px; color: var(--muted); }
    .field-head { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 6px; }
    output { color: var(--mint); font-weight: 700; font-variant-numeric: tabular-nums; }
    .field.disabled { opacity: .45; }
    .pitch-row { display: flex; align-items: center; gap: 8px; }
    .step { flex-shrink: 0; width: 32px; height: 32px; border-radius: 8px; border: 1px solid #46514c;
      background: #293030; font-size: 18px; line-height: 1; }
    .modes { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .mode { position: relative; display: flex; align-items: center; justify-content: center; min-height: 32px;
      border: 1px solid #3a4643; border-radius: 8px; background: #252c2c; color: #b6c4bf;
      font-size: 12px; font-weight: 600; cursor: pointer; }
    .mode input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; }
    .mode:has(input:checked) { background: #284439; border-color: #62aa88; color: #b0f7d9; }
    .mode:has(input:focus-visible) { outline: 2px solid var(--mint); outline-offset: 2px; }
    .engines { margin-top: 10px; }
    .hint { margin: 6px 0 0; font-size: 11px; color: var(--muted); }
    .warning { margin: 0; font-size: 11px; line-height: 1.5; color: #f3d48b; background: #3a3424; border-radius: 8px; padding: 8px 10px; }
    input[type=range] { appearance: none; -webkit-appearance: none; display: block; width: 100%; height: 20px;
      margin: 0; background: transparent; cursor: pointer; }
    input[type=range]:disabled { cursor: not-allowed; }
    input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 4px;
      background: linear-gradient(90deg, var(--mint) var(--fill, 50%), #45514c var(--fill, 50%)); }
    input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 15px; height: 15px;
      border-radius: 50%; background: #a9f7da; border: 3px solid #23493b; margin-top: -5.5px; }
  `), build());
  // Keep YouTube's global hotkeys (space, arrows, k/j/l…) from firing while using the panel.
  for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, e => e.stopPropagation());

  function mount() {
    if (!enabled || !unlocked) { host.remove(); return; }
    const below = document.querySelector('ytd-watch-flexy #below');
    if (below && host.parentElement !== below) below.prepend(host);
  }

  function setEnabled(value) {
    enabled = !!value;
    mount();
    if (enabled) refreshStatus();
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type !== 'PANEL_STATE') return false;
    if ('active' in message) {
      live = message.active;
      if (live) { elsewhere = false; unlocked = true; mount(); }
      layout = live ? message.layout || layout : null;
      if (!message.error) notice = null;
    }
    if (message.error) notice = { text: message.error, error: true };
    redraw();
    return false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.panelEnabled) setEnabled(changes.panelEnabled.newValue);
    if (!changes.settings?.newValue) return;
    if (Date.now() - lastLocalEdit < 500) return; // echo of our own edit while dragging
    settings = changes.settings.newValue;
    redraw();
  });
  document.addEventListener('visibilitychange', () => { if (enabled && !document.hidden) refreshStatus(); });
  window.addEventListener('yt-navigate-finish', mount);
  setInterval(mount, 1000); // YouTube re-renders the watch page without a full reload

  redraw();
  chrome.storage.local.get(['panelCollapsed', 'panelEnabled']).then(({ panelCollapsed, panelEnabled }) => {
    collapsed = !!panelCollapsed;
    redraw();
    setEnabled(panelEnabled);
  }).catch(() => {});
})();
