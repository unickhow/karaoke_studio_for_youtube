// Pitch-shift stage for the offscreen audio graph, with two engines:
//  'quality' – Signalsmith Stretch (WASM): much cleaner shifts, ~120 ms latency.
//  'fast'    – the bundled phase vocoder (pitch-worklet.js): ~43 ms latency.
// With the quality engine, 0 semitones bypasses the shifter so it adds no latency.
const STRETCH_PATH = 'vendor/signalsmith-stretch/SignalsmithStretch.mjs';
const ENGINE_NODE_OPTIONS = { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] };

async function loadSignalsmith() {
  const url = chrome.runtime.getURL(STRETCH_PATH);
  const { default: SignalsmithStretch } = await import(url);
  // Load the worklet from the packaged file: MV3's CSP blocks the library's blob: fallback.
  SignalsmithStretch.moduleUrl = url;
  return SignalsmithStretch;
}

async function createEngineNode(ctx, engine) {
  if (engine === 'fast') {
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('pitch-worklet.js'));
    return new AudioWorkletNode(ctx, 'karaoke-pitch', ENGINE_NODE_OPTIONS);
  }
  const SignalsmithStretch = await loadSignalsmith();
  const node = await SignalsmithStretch(ctx, ENGINE_NODE_OPTIONS);
  node.start();
  return node;
}

class PitchStage {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.wet.connect(this.output);
    this.engine = null;
    this.node = null;
    this.wanted = null;
    this.semitones = 0;
    this.failed = new Set();
    this.switching = null;
  }

  update({ pitch, pitchEngine }) {
    this.semitones = pitch;
    this.wanted = this.failed.has(pitchEngine) ? 'fast' : pitchEngine;
    this.apply();
    if (this.wanted !== this.engine && !this.switching) {
      this.switching = this.switchEngine().finally(() => { this.switching = null; });
    }
    return this.switching || Promise.resolve();
  }

  async switchEngine() {
    while (this.wanted !== this.engine) {
      const engine = this.wanted;
      let node;
      try {
        node = await createEngineNode(this.ctx, engine);
      } catch (error) {
        if (engine === 'fast') throw error;
        console.error('Quality pitch engine unavailable; using the fast engine.', error);
        this.failed.add(engine);
        this.wanted = 'fast';
        continue;
      }
      this.retire();
      this.input.connect(node);
      node.connect(this.wet);
      this.node = node;
      this.engine = engine;
      this.apply();
    }
  }

  // Worklet processors keep running until the context closes unless told to stop.
  retire() {
    if (!this.node) return;
    this.input.disconnect(this.node);
    this.node.disconnect();
    if (this.engine === 'fast') this.node.port.postMessage('stop');
    else this.node.stop();
  }

  apply() {
    const t = this.ctx.currentTime;
    if (this.engine === 'fast') this.node.parameters.get('semitones').setTargetAtTime(this.semitones, t, 0.025);
    else if (this.node) this.node.schedule({ semitones: this.semitones });
    const shifting = !!this.node && (this.engine === 'fast' || this.semitones !== 0);
    this.dry.gain.setTargetAtTime(shifting ? 0 : 1, t, 0.02);
    this.wet.gain.setTargetAtTime(shifting ? 1 : 0, t, 0.02);
  }
}
