/** Musical key detection and labelling checks, runnable with `node test-key.js`. */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const extension = path.join(__dirname, 'extension');

const sandbox = { chrome: { runtime: { onMessage: { addListener() {} } } }, navigator: {}, AudioContext: function () {}, setInterval, clearInterval };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(extension, 'offscreen.js'), 'utf8') +
  '\nglobalThis.api = { classifyKey, addChroma };', sandbox);
const { classifyKey, addChroma } = sandbox.api;

const SR = 48000, FFT = 16384;
const NOTE = { C: 0, 'C#': 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const midiHz = m => 440 * 2 ** ((m - 69) / 12);
// A dB spectrum (like AnalyserNode.getFloatFrequencyData) of tones with harmonics 1-5 at 1/n level.
function spectrum(midiNotes) {
  const db = new Float32Array(FFT / 2).fill(-120);
  for (const m of midiNotes) {
    for (let n = 1; n <= 5; n++) {
      const bin = Math.round(midiHz(m) * n * FFT / SR);
      if (bin < db.length) db[bin] = Math.max(db[bin], 20 * Math.log10(0.5 / n));
    }
  }
  return db;
}
// Chords (MIDI notes) of a progression, played in equal measure.
const triad = (root, minor = false) => [root, root + (minor ? 3 : 4), root + 7];
function chromaOf(progression) {
  const chroma = new Float64Array(12);
  for (const chord of progression) addChroma(chroma, spectrum(chord), SR, FFT);
  return chroma;
}
const keyOf = progression => { const k = classifyKey(chromaOf(progression)); return k && `${k.tonic}:${k.mode}`; };

// I-V-vi-IV in G major, with the bass note an octave down.
const G = 55;
const gMajor = [triad(G), triad(G + 7 - 12), triad(G + 9 - 12, true), triad(G + 5)].map(c => [...c, c[0] - 12]);
assert.equal(keyOf(gMajor), `${NOTE.G}:major`, 'I-V-vi-IV in G is G major');
// The same progression moved to D and E-flat.
for (const name of ['D', 'Eb']) {
  const shifted = gMajor.map(c => c.map(m => m + NOTE[name] - NOTE.G));
  assert.equal(keyOf(shifted), `${NOTE[name]}:major`, `transposed progression is ${name} major`);
}
// i-iv-V-i in A minor (harmonic minor: E major chord with G#).
const A = 57;
const aMinor = [triad(A, true), triad(A + 5, true), triad(A + 7 - 12), triad(A, true)].map(c => [...c, c[0] - 12]);
assert.equal(keyOf(aMinor), `${NOTE.A}:minor`, 'i-iv-V-i in A is A minor');
// Silence gives no answer instead of a guess.
assert.equal(classifyKey(new Float64Array(12)), null, 'no key without sound');
// Frames that are silent add nothing.
const quiet = new Float64Array(12);
addChroma(quiet, new Float32Array(FFT / 2).fill(-120), SR, FFT);
assert.ok(quiet.every(v => v === 0), 'a silent frame adds no chroma');

// Labels: the shifted key is the original key plus the pitch shift.
const shared = { chrome: { i18n: {
  getUILanguage: () => 'en',
  getMessage: (key, subs) => ({ keyMajor: `${subs[0]} major`, keyMinor: `${subs[0]} minor` })[key] || key
} } };
vm.createContext(shared);
vm.runInContext(fs.readFileSync(path.join(extension, 'shared.js'), 'utf8') + '\nglobalThis.keyName = keyName;', shared);
const { keyName } = shared;
assert.equal(keyName({ tonic: NOTE.G, mode: 'major' }, 0), 'G major');
assert.equal(keyName({ tonic: NOTE.G, mode: 'major' }, 2), 'A major', 'G major +2 is A major');
assert.equal(keyName({ tonic: NOTE.C, mode: 'major' }, -1), 'B major', 'shifts wrap around the octave');
assert.equal(keyName({ tonic: NOTE.D, mode: 'major' }, -1), 'D♭ major', 'major keys use conventional flats');
assert.equal(keyName({ tonic: NOTE.E, mode: 'minor' }, -3), 'C♯ minor', 'minor keys use conventional sharps');
assert.equal(keyName({ tonic: NOTE.A, mode: 'minor' }, 12), 'A minor', 'an octave shift keeps the key');
console.log('PASS: key from chord spectra (major, minor, transposed), silence, shifted key names');
