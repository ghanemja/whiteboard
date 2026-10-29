// The ad's music: an original lo-fi bed, synthesized here so there's nothing to license.
// Soft pads alone under the problem cards, then keys, kick and hats come in when the app does,
// and it all fades over the end card.
//
//   node scripts/ad-music.mjs <out.wav> <seconds> [beat-in seconds]
//
// 92 BPM, Fmaj7 · Em7 · Dm7 · Cmaj7 (two bars each), 44.1 kHz stereo 16-bit WAV.
import fs from "fs";

const [out = "music.wav", secs = "90", inAt = "16"] = process.argv.slice(2);
const SR = 44100, LEN = Math.ceil(Number(secs) * SR), BEAT_IN = Number(inAt);
const BPM = 92, BEAT = 60 / BPM, BAR = BEAT * 4;
const L = new Float32Array(LEN), R = new Float32Array(LEN);
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
// Midi notes: F3 A3 C4 E4 · E3 G3 B3 D4 · D3 F3 A3 C4 · C3 E3 G3 B3
const CHORDS = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]];
const ROOTS = [41, 40, 38, 36];
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function add(start, dur, fn, pan = 0, gain = 1) {
  const s0 = Math.floor(start * SR), n = Math.floor(dur * SR);
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4), gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < n && s0 + i < LEN; i++) {
    if (s0 + i < 0) continue;
    const v = fn(i / SR, i);
    L[s0 + i] += v * gl;
    R[s0 + i] += v * gr;
  }
}
// A pad: three detuned triangles per note, slow attack and release, darkened by a one-pole filter.
function pad(start, dur, notes, gain) {
  for (const [k, m] of notes.entries()) {
    let lp = 0;
    const f = hz(m);
    add(start, dur + 1.5, (t) => {
      let v = 0;
      for (const d of [-0.12, 0, 0.11]) v += 2 * Math.abs(2 * ((t * f * 2 ** (d / 12)) % 1) - 1) - 1;
      lp += 0.06 * (v / 3 - lp);
      const env = Math.min(1, t / 1.2) * (t > dur ? Math.max(0, 1 - (t - dur) / 1.5) : 1);
      return lp * env;
    }, k % 2 ? 0.35 : -0.35, gain);
  }
}
// An electric-piano-ish key: a sine with a bell partial and a quick decay.
function key(start, m, gain, pan) {
  const f = hz(m);
  add(start, 1.6, (t) => Math.exp(-t * 3.2) * (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-t * 8)), pan, gain);
}
function bass(start, m, dur, gain) {
  const f = hz(m);
  add(start, dur, (t) => Math.sin(2 * Math.PI * f * t) * Math.min(1, t / 0.01) * Math.exp(-t * 1.4), 0, gain);
}
function kick(start, gain) {
  add(start, 0.4, (t) => Math.sin(2 * Math.PI * (48 * t + 60 * (1 - Math.exp(-t * 30)) / 30)) * Math.exp(-t * 9), 0, gain);
}
function hat(start, gain, pan) {
  let hp = 0, prev = 0;
  add(start, 0.08, (t) => {
    const x = rand() * 2 - 1;
    hp = 0.7 * (hp + x - prev);
    prev = x;
    return hp * Math.exp(-t * 60);
  }, pan, gain);
}
function snare(start, gain) {
  add(start, 0.25, (t) => ((rand() * 2 - 1) * 0.6 + Math.sin(2 * Math.PI * 185 * t) * 0.4) * Math.exp(-t * 18), 0.05, gain);
}

const bars = Math.ceil(Number(secs) / BAR) + 1;
for (let b = 0; b < bars; b++) {
  const t0 = b * BAR, c = Math.floor(b / 2) % 4, on = t0 >= BEAT_IN - 0.01;
  pad(t0, BAR, CHORDS[c], on ? 0.05 : 0.07);
  if (!on) continue;
  bass(t0, ROOTS[c], BEAT * 1.8, 0.22);
  bass(t0 + BEAT * 2.5, ROOTS[c] + (b % 2 ? 7 : 12), BEAT * 1.2, 0.16);
  // Keys: a lazy broken chord, a touch behind the beat.
  const pattern = b % 2 ? [0, 1.5, 2, 3.5] : [0.5, 1, 2.5, 3];
  pattern.forEach((p, i) => key(t0 + p * BEAT + 0.02, CHORDS[c][(i + b) % 4] + 12, 0.07, i % 2 ? 0.4 : -0.4));
  for (let q = 0; q < 4; q++) {
    if (q === 0) kick(t0, 0.5);
    if (q === 1 || q === 3) snare(t0 + q * BEAT, 0.06);
  }
  kick(t0 + 2.5 * BEAT, 0.35);
  for (let e = 0; e < 8; e++) hat(t0 + e * BEAT / 2 + (e % 2 ? 0.03 : 0), e % 2 ? 0.018 : 0.03, e % 2 ? 0.3 : -0.3);
}

// A little room: two feedback delays, then the fades and a soft limit.
for (const [ch, d, fb] of [[L, 0.31, 0.32], [R, 0.37, 0.3]]) {
  const n = Math.floor(d * SR);
  for (let i = n; i < LEN; i++) ch[i] += ch[i - n] * fb * 0.5;
}
const fadeIn = 1.5 * SR, fadeOut = 4 * SR;
let peak = 0;
for (const ch of [L, R]) for (let i = 0; i < LEN; i++) {
  ch[i] *= Math.min(1, i / fadeIn, (LEN - i) / fadeOut);
  peak = Math.max(peak, Math.abs(ch[i]));
}
const norm = 0.6 / (peak || 1);
const buf = Buffer.alloc(44 + LEN * 4);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + LEN * 4, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(LEN * 4, 40);
for (let i = 0; i < LEN; i++) {
  buf.writeInt16LE(Math.round(Math.tanh(L[i] * norm) * 32000), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.tanh(R[i] * norm) * 32000), 46 + i * 4);
}
fs.writeFileSync(out, buf);
console.log(`${out}: ${secs} s, beat in at ${BEAT_IN} s`);
