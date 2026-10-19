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
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(extension, 'offscreen.js'), 'utf8') + `\n
  globalThis.testAPI = { channelCoefficients, createVocalMatrix, applySettings };`, sandbox);

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
const { channelCoefficients, createVocalMatrix, applySettings } = sandbox.testAPI;
const ctx = ctxMock();
const matrix = createVocalMatrix(ctx, { connect() {} });
const state = {
  context: ctx,
  matrix,
  pitch: { parameters: new Map([['semitones', { setTargetAtTime() {} }]]) },
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

const bg = {
  chrome: {
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } }
  }
};
vm.createContext(bg);
vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8') + `\n
  globalThis.testNormalize = normalizeSettings;`, bg);
assert.equal(bg.testNormalize({ vocal: 75 }).channelMode, 'center', 'legacy reduction should migrate to center mode');
assert.equal(bg.testNormalize({ vocal: 0 }).channelMode, 'stereo', 'legacy zero reduction should migrate to stereo mode');
assert.equal(bg.testNormalize({ channelMode: 'left', vocal: 90 }).channelMode, 'left', 'explicit mode wins');
assert.equal(bg.testNormalize({ channelMode: 'oops' }).channelMode, 'stereo', 'invalid mode should be handled');
console.log('PASS: four audio routings, reduction strengths, v0.1 settings migration, invalid value fallback');
