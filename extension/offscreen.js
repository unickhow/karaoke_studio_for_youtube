// One captured tab at a time. The offscreen document survives the popup closing.
let session = null;

async function stopSession() {
  if (!session) return;
  const old = session;
  session = null;
  clearInterval(old.channelTimer);
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

// ChannelSplitter is fixed to 'discrete', so upmix first: a mono stream becomes L = R.
function upmixStereo(ctx, input) {
  const upmix = ctx.createGain();
  upmix.channelCount = 2;
  upmix.channelCountMode = 'explicit';
  upmix.channelInterpretation = 'speakers';
  input.connect(upmix);
  return upmix;
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

// Vocals sit between these; bass, kick and cymbals outside them survive center reduction.
const VOCAL_BAND = { low: 100, high: 8000 };
// Two cascaded 4th-order Butterworths form a Linkwitz-Riley crossover whose bands sum flat.
// Web Audio expresses lowpass/highpass Q in dB.
const LR8_Q = [0.5412, 1.3066, 0.5412, 1.3066].map(q => 20 * Math.log10(q));

function crossoverFilter(ctx, input, type, frequency) {
  let node = input;
  for (const q of LR8_Q) {
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    node.connect(filter);
    node = filter;
  }
  return node;
}

/**
 * Split into the vocal band and the rest. Both channels are filtered identically, so each
 * band keeps the L/R relationship center reduction relies on, at any strength.
 */
function createChannelRouting(ctx, input) {
  const low = crossoverFilter(ctx, input, 'lowpass', VOCAL_BAND.low);
  const upper = crossoverFilter(ctx, input, 'highpass', VOCAL_BAND.low);
  const mid = crossoverFilter(ctx, upper, 'lowpass', VOCAL_BAND.high);
  const high = crossoverFilter(ctx, upper, 'highpass', VOCAL_BAND.high);
  const outside = ctx.createGain();
  low.connect(outside);
  high.connect(outside);
  return { vocal: createVocalMatrix(ctx, mid), edges: createVocalMatrix(ctx, outside) };
}

/**
 * Classify the source as mono (L and R carry the same signal) or stereo from
 * mean side (L-R)^2 and mid (L+R)^2 energy. Returns null when too quiet to tell.
 */
function classifyChannels(side, mid) {
  if (mid < 1e-6) return null;
  return Math.sqrt(side / mid) < 0.03 ? 'mono' : 'stereo';
}

// Sample the unprocessed source a few times per second and report layout changes.
// L-R and L+R are formed on the audio thread: the audio can advance between two analyser
// reads, so comparing separately read L and R windows would make mono look stereo.
function monitorChannels(s) {
  const splitter = s.context.createChannelSplitter(2);
  const invert = s.context.createGain();
  invert.gain.value = -1;
  const sideAnalyser = s.context.createAnalyser();
  const midAnalyser = s.context.createAnalyser();
  s.input.connect(splitter);
  splitter.connect(sideAnalyser, 0);
  splitter.connect(invert, 1);
  invert.connect(sideAnalyser);
  splitter.connect(midAnalyser, 0);
  splitter.connect(midAnalyser, 1);
  const d = new Float32Array(sideAnalyser.fftSize);
  const m = new Float32Array(midAnalyser.fftSize);
  let side = 0, mid = 0, samples = 0;
  s.layout = 'detecting';
  s.channelTimer = setInterval(() => {
    sideAnalyser.getFloatTimeDomainData(d);
    midAnalyser.getFloatTimeDomainData(m);
    for (let i = 0; i < d.length; i++) {
      side += d[i] ** 2;
      mid += m[i] ** 2;
    }
    samples += d.length;
    if (samples < 8 * d.length) return; // decide on ~2 s of snapshots
    const layout = classifyChannels(side / samples, mid / samples);
    side = mid = samples = 0;
    if (!layout || layout === s.layout || session !== s) return;
    s.layout = layout;
    chrome.runtime.sendMessage({ target: 'background', type: 'CHANNEL_INFO', tabId: s.tabId, layout }).catch(() => {});
  }, 250);
}

function applySettings(s, settings) {
  s.settings = settings;
  const t = s.context.currentTime;
  s.pitch.update(settings).catch(error => console.error('Pitch engine failed', error));
  // Use short smoothing to avoid hard audio discontinuities when switching modes.
  const edgeMode = settings.channelMode === 'center' ? 'stereo' : settings.channelMode;
  for (const [band, mode] of [['vocal', settings.channelMode], ['edges', edgeMode]]) {
    const routing = channelCoefficients(mode, settings.vocal);
    for (const [key, gain] of Object.entries(routing)) {
      s.matrix[band][key].gain.setTargetAtTime(gain, t, 0.015);
    }
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

    const source = context.createMediaStreamSource(stream);
    const input = upmixStereo(context, source);
    const pitch = new PitchStage(context);
    await pitch.update(message.settings);
    // Channel routing runs before pitch shifting: the phase vocoder processes L and R
    // independently, so shifting first breaks the L = R identity center reduction needs.
    const matrix = createChannelRouting(context, input);
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

    matrix.vocal.merger.connect(pitch.input);
    matrix.edges.merger.connect(pitch.input);
    pitch.output.connect(bass);
    bass.connect(treble);
    treble.connect(output);
    output.connect(limiter);
    limiter.connect(context.destination);

    const next = { tabId: message.tabId, stream, context, source, input, pitch, matrix, bass, treble, output };
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
    // Detection is informational; never let it take the audio path down.
    try { monitorChannels(next); } catch (error) { console.error('Channel detection unavailable', error); }
    return { active: true, tabId: next.tabId, layout: next.layout };
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
      case 'STATUS': return session ? { active: true, tabId: session.tabId, layout: session.layout } : { active: false };
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
