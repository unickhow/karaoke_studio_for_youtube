// One captured tab at a time. The offscreen document survives the popup closing.
let session = null;

async function stopSession() {
  if (!session) return;
  const old = session;
  session = null;
  try { old.stream.getTracks().forEach(t => t.stop()); } catch {}
  try { await old.context.close(); } catch {}
}

/**
 * Route stereo input to a pair of speakers without reducing it to a single ear.
 * The left/right modes duplicate one discrete channel to both output channels.
 * Center mode subtracts shared, phase-aligned audio; it cannot identify vocals.
 */
function channelCoefficients(mode, vocal) {
  switch (mode) {
    case 'left': return { ll: 1, rl: 0, lr: 1, rr: 0 };
    case 'right': return { ll: 0, rl: 1, lr: 0, rr: 1 };
    case 'center': {
      const a = Math.min(1, Math.max(0, Number(vocal) / 100 || 0));
      return { ll: 1 - a / 2, rl: -a / 2, lr: -a / 2, rr: 1 - a / 2 };
    }
    default: return { ll: 1, rl: 0, lr: 0, rr: 1 }; // untouched stereo
  }
}

function createVocalMatrix(ctx, input) {
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  const ll = ctx.createGain();
  const rr = ctx.createGain();
  const lr = ctx.createGain();
  const rl = ctx.createGain();
  input.connect(splitter);
  splitter.connect(ll, 0); ll.connect(merger, 0, 0);
  splitter.connect(rl, 1); rl.connect(merger, 0, 0);
  splitter.connect(lr, 0); lr.connect(merger, 0, 1);
  splitter.connect(rr, 1); rr.connect(merger, 0, 1);
  return { merger, ll, rr, lr, rl };
}

function applySettings(s, settings) {
  s.settings = settings;
  const t = s.context.currentTime;
  s.pitch.parameters.get('semitones').setTargetAtTime(settings.pitch, t, 0.025);
  // Use short smoothing to avoid hard audio discontinuities when switching modes.
  const routing = channelCoefficients(settings.channelMode, settings.vocal);
  for (const [key, gain] of Object.entries(routing)) {
    s.matrix[key].gain.setTargetAtTime(gain, t, 0.015);
  }
  s.bass.gain.setTargetAtTime(settings.bass, t, 0.02);
  s.treble.gain.setTargetAtTime(settings.treble, t, 0.02);
  s.output.gain.setTargetAtTime(settings.volume / 100, t, 0.02);
}

async function startSession(message) {
  await stopSession();
  let stream, context;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } },
      video: false
    });
    context = new AudioContext({ latencyHint: 'interactive' });
    await context.audioWorklet.addModule(chrome.runtime.getURL('pitch-worklet.js'));

    const source = context.createMediaStreamSource(stream);
    const pitch = new AudioWorkletNode(context, 'karaoke-pitch', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      parameterData: { semitones: message.settings.pitch }
    });
    const matrix = createVocalMatrix(context, pitch);
    const bass = context.createBiquadFilter();
    bass.type = 'lowshelf'; bass.frequency.value = 180;
    const treble = context.createBiquadFilter();
    treble.type = 'highshelf'; treble.frequency.value = 3500;
    const output = context.createGain();
    // Peak limiter: EQ boosts up to +12 dB would otherwise hard-clip.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;

    source.connect(pitch);
    matrix.merger.connect(bass);
    bass.connect(treble);
    treble.connect(output);
    output.connect(limiter);
    limiter.connect(context.destination);

    const next = { tabId: message.tabId, stream, context, source, pitch, matrix, bass, treble, output };
    session = next;
    applySettings(next, message.settings);
    stream.getAudioTracks().forEach(track => {
      track.addEventListener('ended', () => {
        if (session === next) {
          stopSession();
          chrome.runtime.sendMessage({ target: 'background', type: 'ENGINE_ENDED', tabId: next.tabId }).catch(() => {});
        }
      }, { once: true });
    });
    await context.resume();
    return { active: true, tabId: next.tabId };
  } catch (error) {
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (context && context.state !== 'closed') await context.close();
    session = null;
    return { active: false, error: error.message || String(error) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;
  if (sender.tab || sender.url !== chrome.runtime.getURL('background.js')) return false;
  (async () => {
    switch (message.type) {
      case 'STATUS': return session ? { active: true, tabId: session.tabId } : { active: false };
      case 'STOP': await stopSession(); return { active: false };
      case 'START': return startSession(message);
      case 'UPDATE':
        if (session) applySettings(session, message.settings);
        return { active: !!session };
      default: return { active: !!session };
    }
  })().then(sendResponse).catch(error => sendResponse({ active: false, error: error.message }));
  return true;
});
