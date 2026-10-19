/**
 * Self-contained STFT phase-vocoder pitch shifter (prototype quality).
 * Constant audio sample throughput, without altering YouTube's video speed.
 * It introduces ~43 ms algorithmic latency at 48 kHz, plus browser buffering.
 * For demanding mixes, replace with a production DSP/WASM engine later.
 */
const N = 2048;
const HOP = N / 4;
const N2 = N / 2;
const OUT_MASK = 8192 - 1;
const INPUT_MASK = N - 1;

function fft(re, im, inverse) {
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let length = 2; length <= N; length <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / length;
    const wr = Math.cos(angle), wi = Math.sin(angle);
    for (let base = 0; base < N; base += length) {
      let cr = 1, ci = 0;
      const half = length >> 1;
      for (let j = 0; j < half; j++) {
        const a = base + j, b = a + half;
        const br = re[b] * cr - im[b] * ci;
        const bi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - br; im[b] = im[a] - bi;
        re[a] += br; im[a] += bi;
        const tmp = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = tmp;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
  }
}

class ChannelDSP {
  constructor() {
    this.input = new Float32Array(N);
    this.output = new Float32Array(8192);
    this.real = new Float64Array(N);
    this.imag = new Float64Array(N);
    this.lastPhase = new Float64Array(N2 + 1);
    this.sumPhase = new Float64Array(N2 + 1);
    this.mag = new Float64Array(N2 + 1);
    this.freq = new Float64Array(N2 + 1);
    this.synthMag = new Float64Array(N2 + 1);
    this.synthFreq = new Float64Array(N2 + 1);
    this.window = ChannelDSP.WINDOW;
  }

  analyzeAndSynthesize(clock, ratio) {
    const { input, real, imag, lastPhase, sumPhase, mag, freq, synthMag, synthFreq, window, output } = this;
    const binHz = sampleRate / N;
    const phaseStep = 2 * Math.PI * HOP / N;
    const oldest = (clock + 1) & INPUT_MASK;
    for (let i = 0; i < N; i++) {
      real[i] = input[(oldest + i) & INPUT_MASK] * window[i];
      imag[i] = 0;
    }
    fft(real, imag, false);
    synthMag.fill(0); synthFreq.fill(0);
    for (let k = 0; k <= N2; k++) {
      const magnitude = Math.hypot(real[k], imag[k]);
      const phase = Math.atan2(imag[k], real[k]);
      let delta = phase - lastPhase[k] - k * phaseStep;
      lastPhase[k] = phase;
      delta -= 2 * Math.PI * Math.round(delta / (2 * Math.PI));
      const trueHz = k * binHz + delta * sampleRate / (2 * Math.PI * HOP);
      mag[k] = magnitude;
      freq[k] = trueHz;
      const target = Math.round(k * ratio);
      if (target <= N2) {
        // Frequency magnitudes are averaged only at colliding destination bins.
        synthFreq[target] += trueHz * ratio * magnitude;
        synthMag[target] += magnitude;
      }
    }
    real.fill(0); imag.fill(0);
    for (let k = 0; k <= N2; k++) {
      const m = synthMag[k];
      const hz = m > 1e-12 ? synthFreq[k] / m : k * binHz;
      sumPhase[k] += 2 * Math.PI * HOP * hz / sampleRate;
      real[k] = m * Math.cos(sumPhase[k]);
      imag[k] = m * Math.sin(sumPhase[k]);
    }
    imag[0] = 0; imag[N2] = 0;
    for (let k = 1; k < N2; k++) {
      real[N - k] = real[k];
      imag[N - k] = -imag[k];
    }
    fft(real, imag, true);
    // Four Hann windows, squared overlap sum = 1.5.
    const start = clock + 1;
    for (let i = 0; i < N; i++) {
      const index = (start + i) & OUT_MASK;
      output[index] += real[i] * window[i] * (2 / 3);
    }
  }
}
ChannelDSP.WINDOW = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));

class KaraokePitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'semitones', defaultValue: 0, minValue: -12, maxValue: 12, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.channels = [new ChannelDSP(), new ChannelDSP()];
    this.clock = 0;
    this.smoothed = 0;
    this.mix = 0;
    this.alive = true;
    // Sent when another engine replaces this one; returning false lets the node be collected.
    this.port.onmessage = event => { if (event.data === 'stop') this.alive = false; };
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output?.length) return true;
    const requested = parameters.semitones[0] || 0;
    for (let i = 0; i < output[0].length; i++) {
      this.smoothed += (requested - this.smoothed) * 0.001;
      const targetMix = Math.abs(this.smoothed) > 0.025 ? 1 : 0;
      this.mix += (targetMix - this.mix) * 0.001;
      const ratio = Math.pow(2, this.smoothed / 12);
      const index = this.clock & INPUT_MASK;
      const readIndex = this.clock & OUT_MASK;
      for (let ch = 0; ch < output.length; ch++) {
        const dsp = this.channels[Math.min(ch, 1)];
        const dry = (input[ch] || input[0])?.[i] || 0;
        dsp.input[index] = dry;
        const wet = dsp.output[readIndex];
        dsp.output[readIndex] = 0;
        output[ch][i] = dry * (1 - this.mix) + wet * this.mix;
      }
      // Process a complete frame every 512 input samples. At the end of frame
      // the full input window is known; future samples receive the wet result.
      if (this.clock >= N - 1 && (this.clock - (N - 1)) % HOP === 0) {
        for (let ch = 0; ch < output.length; ch++) {
          this.channels[ch].analyzeAndSynthesize(this.clock, ratio);
        }
      }
      this.clock++;
    }
    return this.alive;
  }
}
registerProcessor('karaoke-pitch', KaraokePitchProcessor);
