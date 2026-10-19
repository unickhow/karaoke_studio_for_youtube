/** Pitch engine selection and bypass checks, runnable with `node test-pitch-stage.js`. */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const extension = path.join(__dirname, 'extension');

function load({ qualityFails = false } = {}) {
  const log = { created: [], errors: [] };
  const gain = name => ({
    name, edges: new Set(),
    gain: { value: 1, setTargetAtTime(v) { this.value = v; } },
    connect(target) { this.edges.add(target); },
    disconnect(target) { target ? this.edges.delete(target) : this.edges.clear(); }
  });
  const ctx = {
    currentTime: 0,
    createGain: () => gain('gain'),
    audioWorklet: { addModule: async () => {} }
  };
  const sandbox = {
    console: { error: (...args) => log.errors.push(args) },
    chrome: { runtime: { getURL: p => p } },
    AudioWorkletNode: function () {
      const node = Object.assign(gain('fast'), {
        semitones: 0,
        port: { postMessage(m) { node.stopped = m === 'stop'; } }
      });
      node.parameters = new Map([['semitones', { setTargetAtTime(v) { node.semitones = v; } }]]);
      log.created.push(node);
      return node;
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(extension, 'pitch-stage.js'), 'utf8') + '\nglobalThis.PitchStage = PitchStage;', sandbox);
  sandbox.loadSignalsmith = async () => {
    await new Promise(r => setTimeout(r, 5));
    if (qualityFails) throw new Error('CompileError: wasm blocked');
    return async () => {
      const node = Object.assign(gain('quality'), {
        semitones: 0,
        start() { node.started = true; },
        stop() { node.started = false; },
        schedule(o) { if ('semitones' in o) node.semitones = o.semitones; }
      });
      log.created.push(node);
      return node;
    };
  };
  const stage = new sandbox.PitchStage(ctx);
  const routed = () => ({ dry: stage.dry.gain.value, wet: stage.wet.gain.value });
  return { stage, log, routed };
}

(async () => {
  {
    const { stage, log, routed } = load();
    await stage.update({ pitch: 0, pitchEngine: 'quality' });
    assert.deepEqual(routed(), { dry: 1, wet: 0 }, 'quality engine at 0 semitones bypasses the shifter (no latency)');
    assert.equal(log.created[0].name, 'quality');
    assert.equal(log.created[0].started, true, 'the stretch node is started for live input');
    await stage.update({ pitch: 3, pitchEngine: 'quality' });
    assert.deepEqual(routed(), { dry: 0, wet: 1 }, 'a non-zero shift routes through the engine');
    assert.equal(log.created[0].semitones, 3);
    assert.ok(stage.input.edges.has(log.created[0]) && log.created[0].edges.has(stage.wet), 'engine sits between input and wet');
  }
  {
    const { stage, log, routed } = load();
    await stage.update({ pitch: 0, pitchEngine: 'fast' });
    assert.deepEqual(routed(), { dry: 0, wet: 1 }, 'the fast engine handles its own zero-latency bypass');
    await stage.update({ pitch: -2, pitchEngine: 'fast' });
    assert.equal(log.created[0].semitones, -2);
  }
  {
    const { stage, log } = load();
    await stage.update({ pitch: 2, pitchEngine: 'fast' });
    await stage.update({ pitch: 2, pitchEngine: 'quality' });
    const [fast, quality] = log.created;
    assert.ok(!stage.input.edges.has(fast) && fast.edges.size === 0, 'the replaced engine is disconnected');
    assert.equal(fast.stopped, true, 'the replaced fast engine is told to stop processing');
    assert.equal(quality.semitones, 2, 'the new engine receives the current shift');
  }
  {
    const { stage, log } = load();
    const pending = stage.update({ pitch: 1, pitchEngine: 'quality' });
    stage.update({ pitch: 4, pitchEngine: 'quality' });
    await pending;
    assert.equal(log.created.length, 1, 'rapid updates while loading create one engine');
    assert.equal(log.created[0].semitones, 4, 'the latest shift wins');
  }
  {
    const { stage, log, routed } = load({ qualityFails: true });
    await stage.update({ pitch: 2, pitchEngine: 'quality' });
    assert.equal(log.created.at(-1).name, 'fast', 'falls back to the fast engine when quality cannot load');
    assert.equal(log.errors.length, 1, 'the fallback is logged');
    assert.deepEqual(routed(), { dry: 0, wet: 1 });
    await stage.update({ pitch: 3, pitchEngine: 'quality' });
    assert.equal(log.created.length, 1, 'a failed engine is not retried on every update');
  }
  {
    // The real fast-engine processor must honour 'stop', or it keeps burning CPU after a switch.
    let Processor;
    const ctx = { sampleRate: 48000, Float32Array, Float64Array, Math,
      AudioWorkletProcessor: class { constructor() { this.port = {}; } },
      registerProcessor: (n, c) => { Processor = c; } };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(extension, 'pitch-worklet.js'), 'utf8'), ctx);
    const proc = new Processor();
    const io = () => [[[new Float32Array(128), new Float32Array(128)]], [[new Float32Array(128), new Float32Array(128)]], { semitones: [0] }];
    assert.equal(proc.process(...io()), true, 'keeps processing while in use');
    proc.port.onmessage({ data: 'stop' });
    assert.equal(proc.process(...io()), false, 'ends processing after stop');
  }
  console.log('PASS: engine bypass at 0 st, engine switching, load coalescing, quality fallback, fast engine stop');
})().catch(error => { console.error(error); process.exit(1); });
