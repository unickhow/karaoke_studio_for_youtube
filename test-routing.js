/** Routing and migration checks, runnable with `node test-routing.js`. */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const extension = path.join(__dirname, 'extension');

const sandbox = {
  chrome: { runtime: { onMessage: { addListener() {} } } },
  navigator: { mediaDevices: {} },
  AudioContext: function () {},
  setInterval, clearInterval,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(extension, 'offscreen.js'), 'utf8') + `\n
  globalThis.testAPI = { channelCoefficients, createVocalMatrix, applySettings, classifyChannels, monitorChannels };`, sandbox);

function makeGain() {
  return { gain: { value: 0, setTargetAtTime(v) { this.value = v; } }, connect() {} };
}
function ctxMock() {
  return {
    currentTime: 10,
    createChannelSplitter() { return { connect() {} }; },
    createChannelMerger() { return { connect() {} }; },
    createGain: makeGain
  };
}
const { channelCoefficients, createVocalMatrix, applySettings, classifyChannels, monitorChannels } = sandbox.testAPI;
const ctx = ctxMock();
const matrix = createVocalMatrix(ctx, { connect() {} });
const state = {
  context: ctx,
  matrix,
  pitch: { update: async () => {} },
  bass: { gain: { setTargetAtTime() {} } },
  treble: { gain: { setTargetAtTime() {} } },
  output: { gain: { setTargetAtTime() {} } }
};
const modes = {
  stereo: { left: [0.8, 0.25], right: [0.8, 0.25] },
  left: { left: [0.8, 0.8], right: [0.8, 0.8] },
  right: { left: [0.25, 0.25], right: [0.25, 0.25] },
  center: { left: [0.275, -0.275], right: [0.275, -0.275] }
};
function approximate(a, b) { assert.ok(Math.abs(a - b) < 0.000001, `${a} !== ${b}`); }
const inp = [0.8, 0.25];
for (const mode of Object.keys(modes)) {
  applySettings(state, { channelMode: mode, vocal: 100, pitch: 0, bass: 0, treble: 0, volume: 100 });
  const { ll, rl, lr, rr } = Object.fromEntries(['ll', 'rl', 'lr', 'rr'].map(k => [k, matrix[k].gain.value]));
  const left = ll * inp[0] + rl * inp[1];
  const right = lr * inp[0] + rr * inp[1];
  const expected = { stereo: inp, left: [inp[0], inp[0]], right: [inp[1], inp[1]], center: [(inp[0]-inp[1])/2, -(inp[0]-inp[1])/2] }[mode];
  approximate(left, expected[0]); approximate(right, expected[1]);
}
// Center reduction at zero strength is a stereo passthrough.
const zero = channelCoefficients('center', 0);
for (const k of ['ll', 'rr']) assert.equal(zero[k], 1);
for (const k of ['lr', 'rl']) approximate(zero[k], 0);
const half = channelCoefficients('center', 50);
approximate(half.ll, 0.75); approximate(half.rl, -0.25);

// Channel layout detection from mean side (L-R)^2 and mid (L+R)^2 energy.
function energies(left, right) {
  let side = 0, mid = 0;
  for (let i = 0; i < left.length; i++) { side += (left[i] - right[i]) ** 2; mid += (left[i] + right[i]) ** 2; }
  return [side / left.length, mid / left.length];
}
const tone = (hz, phase = 0, gain = 0.5) => Float32Array.from({ length: 4096 }, (_, i) => gain * Math.sin(2 * Math.PI * hz * i / 48000 + phase));
const a = tone(440);
assert.equal(classifyChannels(...energies(a, a)), 'mono', 'identical channels are mono');
assert.equal(classifyChannels(...energies(a, tone(440, 0, 0.49))), 'mono', 'a near-identical (lossy) copy is still mono');
assert.equal(classifyChannels(...energies(a, tone(660))), 'stereo', 'different channels are stereo');
assert.equal(classifyChannels(...energies(a, new Float32Array(4096))), 'stereo', 'one silent channel is not mono');
assert.equal(classifyChannels(...energies(new Float32Array(4096), new Float32Array(4096))), null, 'silence is undecided');

// Like real browsers, ChannelSplitterNode refuses any channelInterpretation but 'discrete'.
const strictSplitter = () => ({
  connect() {},
  get channelInterpretation() { return 'discrete'; },
  set channelInterpretation(v) { if (v !== 'discrete') throw new Error('ChannelSplitter: channelInterpretation cannot be changed'); }
});
const monitored = {
  tabId: 1,
  input: { connect() {} },
  context: {
    createChannelSplitter: strictSplitter,
    createGain: () => ({ connect() {} }),
    createAnalyser: () => ({ fftSize: 2048, connect() {}, getFloatTimeDomainData() {} })
  }
};
assert.doesNotThrow(() => monitorChannels(monitored), 'channel monitor must not reconfigure the splitter');
clearInterval(monitored.channelTimer);

// Center reduction must run before the pitch shifter: the phase vocoder treats L and R
// independently, so shifting first breaks the L = R identity that cancellation relies on.
(async () => {
  const edges = [];
  const node = name => ({ name, connect(target) { edges.push(`${name}->${target.name}`); },
    gain: { value: 0, setTargetAtTime() {} }, frequency: {}, parameters: new Map([['semitones', { setTargetAtTime() {} }]]),
    threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}, fftSize: 2048, getFloatTimeDomainData() {} });
  let splitters = 0, mergers = 0, gains = 0;
  const graph = {
    chrome: { runtime: { getURL: p => p, sendMessage: async () => {}, onMessage: { addListener() {} } } },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [] }) } },
    AudioContext: function () {
      Object.assign(this, {
        currentTime: 0, state: 'running', destination: node('destination'),
        audioWorklet: { addModule: async () => {} }, resume: async () => {}, close: async () => {},
        createMediaStreamSource: () => node('source'),
        createChannelSplitter: () => node(splitters++ === 0 ? 'matrixSplitter' : 'monitorSplitter'),
        createChannelMerger: () => node(mergers++ === 0 ? 'matrixMerger' : 'merger' + mergers),
        createGain: () => node(['upmix', 'pitchIn', 'pitchOut', 'dry', 'wet'][gains++] || 'gain'), createBiquadFilter: () => node('eq'),
        createDynamicsCompressor: () => node('limiter'), createAnalyser: () => node('analyser')
      });
    },
    AudioWorkletNode: function () { return node('pitch'); },
    setInterval: () => 0, clearInterval() {}
  };
  vm.createContext(graph);
  vm.runInContext(fs.readFileSync(path.join(extension, 'pitch-stage.js'), 'utf8'), graph);
  vm.runInContext(fs.readFileSync(path.join(extension, 'offscreen.js'), 'utf8') + '\nglobalThis.start = startSession;', graph);
  const result = await graph.start({ streamId: 's', tabId: 1, settings: { pitch: 2, pitchEngine: 'fast', tempo: 1, vocal: 75, channelMode: 'center', bass: 0, treble: 0, volume: 100 } });
  assert.equal(result.active, true, result.error);
  assert.ok(edges.includes('source->upmix') && edges.includes('upmix->matrixSplitter'), 'the (upmixed) source feeds the channel matrix');
  assert.ok(edges.includes('matrixMerger->pitchIn'), 'the channel matrix feeds the pitch stage');
  assert.ok(edges.includes('pitchIn->pitch') && edges.includes('pitchOut->eq'), 'the pitch stage sits between matrix and EQ');
  assert.ok(!edges.includes('source->pitchIn') && !edges.includes('upmix->pitchIn'), 'the pitch shifter must not see unreduced audio');
})().catch(error => { console.error(error); process.exit(1); });

const bg = {
  chrome: {
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
    commands: { onCommand: { addListener() {} } }
  }
};
vm.createContext(bg);
vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8') + `\n
  globalThis.testNormalize = normalizeSettings;`, bg);
assert.equal(bg.testNormalize({ vocal: 75 }).channelMode, 'center', 'legacy reduction should migrate to center mode');
assert.equal(bg.testNormalize({ vocal: 0 }).channelMode, 'stereo', 'legacy zero reduction should migrate to stereo mode');
assert.equal(bg.testNormalize({ channelMode: 'left', vocal: 90 }).channelMode, 'left', 'explicit mode wins');
assert.equal(bg.testNormalize({ channelMode: 'oops' }).channelMode, 'stereo', 'invalid mode should be handled');
assert.equal(bg.testNormalize({}).pitchEngine, 'quality', 'the quality pitch engine is the default');
assert.equal(bg.testNormalize({ pitchEngine: 'fast' }).pitchEngine, 'fast');
assert.equal(bg.testNormalize({ pitchEngine: 'oops' }).pitchEngine, 'quality', 'invalid engine falls back to quality');
console.log('PASS: four audio routings, reduction strengths, channel layout detection, pitch engine setting, v0.1 settings migration, invalid value fallback');
