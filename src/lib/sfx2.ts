/**
 * Extra sound effects (synthesized, royalty-free). Same building blocks as sfx.ts.
 */
import type { SfxDef } from './sfx';

const SR = 48000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}
function noise(c: OfflineAudioContext, dur: number, seed = 7) {
  const b = c.createBuffer(1, Math.ceil(dur * SR), SR);
  const d = b.getChannelData(0);
  const r = rng(seed);
  for (let i = 0; i < d.length; i++) d[i] = r();
  const s = c.createBufferSource();
  s.buffer = b;
  return s;
}
function env(c: OfflineAudioContext, t0: number, a: number, peak: number, dec: number, hold = 0) {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + a);
  if (hold) g.gain.setValueAtTime(peak, t0 + a + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + hold + dec);
  return g;
}
function osc(c: OfflineAudioContext, type: OscillatorType, f0: number, f1: number, t0: number, dur: number, peak: number, out: AudioNode, o: { a?: number; hold?: number; vib?: [number, number]; lin?: boolean } = {}) {
  const n = c.createOscillator();
  n.type = type;
  n.frequency.setValueAtTime(f0, t0);
  if (f1 !== f0) {
    if (o.lin) n.frequency.linearRampToValueAtTime(f1, t0 + dur);
    else n.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  }
  if (o.vib) {
    const l = c.createOscillator();
    l.frequency.value = o.vib[0];
    const lg = c.createGain();
    lg.gain.value = o.vib[1];
    l.connect(lg).connect(n.frequency);
    l.start(t0);
    l.stop(t0 + dur + 0.2);
  }
  const g = env(c, t0, o.a ?? 0.005, peak, o.hold ? Math.max(0.05, dur - o.hold) : dur, o.hold || 0);
  n.connect(g).connect(out);
  n.start(t0);
  n.stop(t0 + dur + 0.25);
}
function filt(c: OfflineAudioContext, type: BiquadFilterType, f: number, q = 0.8, to: AudioNode = c.destination) {
  const b = c.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  b.connect(to);
  return b;
}
function burst(c: OfflineAudioContext, t0: number, dur: number, f: number, q: number, peak: number, seed: number, to: AudioNode = c.destination) {
  const n = noise(c, dur + 0.05, seed);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = f;
  bp.Q.value = q;
  n.connect(bp).connect(env(c, t0, 0.002, peak, dur)).connect(to);
  n.start(t0);
}
function sweepNoise(c: OfflineAudioContext, dur: number, type: BiquadFilterType, f0: number, f1: number, peak: number, seed: number, attack: number) {
  const n = noise(c, dur, seed);
  const b = c.createBiquadFilter();
  b.type = type;
  b.Q.value = 1;
  b.frequency.setValueAtTime(f0, 0);
  b.frequency.exponentialRampToValueAtTime(f1, dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, 0);
  g.gain.exponentialRampToValueAtTime(peak, dur * attack);
  g.gain.exponentialRampToValueAtTime(0.0001, dur);
  n.connect(b).connect(g).connect(c.destination);
  n.start(0);
}
const D = (c: OfflineAudioContext) => c.destination;

export const SFX2: SfxDef[] = [
  /* --- Geçiş --- */
  { id: 'whoosh-down', name: 'Whoosh (iniş)', cat: 'Geçiş', dur: 0.9, gen: (c) => sweepNoise(c, 0.9, 'bandpass', 4000, 250, 0.9, 51, 0.35) },
  { id: 'swipe', name: 'Kaydırma', cat: 'Geçiş', dur: 0.3, gen: (c) => sweepNoise(c, 0.3, 'highpass', 1200, 6000, 0.8, 52, 0.4) },
  { id: 'rev-cymbal', name: 'Ters zil', cat: 'Geçiş', dur: 2.2, gen: (c) => sweepNoise(c, 2.2, 'highpass', 2000, 9000, 0.7, 53, 0.95) },
  { id: 'zap', name: 'Lazer', cat: 'Geçiş', dur: 0.4, gen: (c) => osc(c, 'sawtooth', 1800, 120, 0, 0.35, 0.4, filt(c, 'lowpass', 3500)) },
  {
    id: 'rewind', name: 'Geri sarma', cat: 'Geçiş', dur: 1.2,
    gen: (c) => {
      const out = filt(c, 'bandpass', 2200, 0.7);
      for (let i = 0; i < 14; i++) osc(c, 'square', 700 + i * 90, 1400 + i * 120, i * 0.08, 0.07, 0.15, out, { a: 0.002 });
    },
  },
  { id: 'vinyl-stop', name: 'Plak durması', cat: 'Geçiş', dur: 1.3, gen: (c) => { osc(c, 'sawtooth', 440, 30, 0, 1.2, 0.3, filt(c, 'lowpass', 1800), { lin: false }); osc(c, 'sine', 110, 20, 0, 1.2, 0.5, D(c)); } },
  { id: 'cam-zoom', name: 'Kamera zoom', cat: 'Geçiş', dur: 0.8, gen: (c) => { osc(c, 'sawtooth', 500, 1300, 0, 0.7, 0.12, filt(c, 'bandpass', 1500, 2), { a: 0.05, lin: true }); burst(c, 0.72, 0.04, 3000, 2, 0.6, 54); } },

  /* --- Vurgu --- */
  { id: 'bass-drop', name: 'Bas düşüşü', cat: 'Vurgu', dur: 2.6, gen: (c) => { osc(c, 'sine', 120, 28, 0, 2.4, 1, D(c), { a: 0.01 }); osc(c, 'sawtooth', 60, 28, 0, 1.6, 0.2, filt(c, 'lowpass', 300)); } },
  {
    id: 'explosion', name: 'Patlama', cat: 'Vurgu', dur: 3,
    gen: (c) => {
      osc(c, 'sine', 80, 25, 0, 2, 1, D(c), { a: 0.003 });
      const n = noise(c, 3, 61);
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(3000, 0);
      lp.frequency.exponentialRampToValueAtTime(150, 2.8);
      n.connect(lp).connect(env(c, 0, 0.004, 0.9, 2.8)).connect(D(c));
      n.start(0);
    },
  },
  { id: 'punch', name: 'Yumruk', cat: 'Vurgu', dur: 0.4, gen: (c) => { osc(c, 'sine', 140, 50, 0, 0.25, 1, D(c), { a: 0.001 }); burst(c, 0, 0.06, 1800, 0.8, 0.7, 62); } },
  {
    id: 'gong', name: 'Gong', cat: 'Vurgu', dur: 4,
    gen: (c) => {
      [[110, 0.6], [151, 0.4], [227, 0.3], [304, 0.2], [411, 0.12]].forEach(([f, p]) => osc(c, 'sine', f, f * 0.99, 0, 3.8, p, D(c), { a: 0.01, vib: [3, 1] }));
      burst(c, 0, 0.05, 900, 1, 0.4, 63);
    },
  },
  {
    id: 'tada', name: 'Ta-da!', cat: 'Vurgu', dur: 1.6,
    gen: (c) => {
      const out = filt(c, 'lowpass', 5000);
      [[392, 0], [523.3, 0.12]].forEach(([f, t]) => [1, 1.26, 1.5].forEach((m) => osc(c, 'triangle', f * m, f * m, t, t ? 1.3 : 0.12, 0.22, out)));
    },
  },
  {
    id: 'drumroll', name: 'Davul ruloları', cat: 'Vurgu', dur: 2.6,
    gen: (c) => {
      let t = 0;
      let i = 0;
      while (t < 2) {
        burst(c, t, 0.05, 220 + (i % 3) * 40, 1.5, 0.35 + t * 0.2, 70 + i);
        t += 0.09 - t * 0.025;
        i++;
      }
      burst(c, 2.05, 0.5, 5000, 0.6, 0.9, 99);
      osc(c, 'sine', 90, 45, 2.05, 0.4, 0.9, D(c));
    },
  },
  {
    id: 'suspense', name: 'Gerilim', cat: 'Vurgu', dur: 4,
    gen: (c) => {
      const out = filt(c, 'lowpass', 900);
      osc(c, 'sawtooth', 55, 55, 0, 3.8, 0.25, out, { a: 0.8, hold: 2.6, vib: [5, 1.5] });
      osc(c, 'sawtooth', 58.3, 58.3, 0, 3.8, 0.2, out, { a: 0.8, hold: 2.6 });
      osc(c, 'sine', 880, 1760, 0.5, 3.3, 0.06, D(c), { a: 1.5, vib: [7, 15], lin: true });
    },
  },
  {
    id: 'thunder', name: 'Gök gürültüsü', cat: 'Vurgu', dur: 4,
    gen: (c) => {
      const out = filt(c, 'lowpass', 400, 0.5);
      const r = rng(5);
      for (let i = 0; i < 6; i++) burst(c, i * 0.25 + Math.abs(r()) * 0.2, 1.5 + Math.abs(r()), 120 + Math.abs(r()) * 200, 0.4, 0.6, 80 + i, out);
      burst(c, 0, 0.12, 2500, 0.5, 0.7, 89);
    },
  },

  /* --- Arayüz / oyun --- */
  { id: 'bubble', name: 'Baloncuk', cat: 'Arayüz', dur: 0.25, gen: (c) => osc(c, 'sine', 300, 1600, 0, 0.12, 0.7, D(c), { a: 0.002 }) },
  { id: 'message', name: 'Mesaj', cat: 'Arayüz', dur: 0.4, gen: (c) => { osc(c, 'sine', 1200, 1200, 0, 0.08, 0.5, D(c)); osc(c, 'sine', 1600, 1600, 0.1, 0.18, 0.5, D(c)); } },
  { id: 'like', name: 'Beğeni', cat: 'Arayüz', dur: 0.7, gen: (c) => { osc(c, 'sine', 700, 1400, 0, 0.1, 0.6, D(c)); osc(c, 'triangle', 2093, 2093, 0.08, 0.5, 0.25, D(c)); } },
  {
    id: 'levelup', name: 'Seviye atla', cat: 'Arayüz', dur: 1,
    gen: (c) => [523, 659, 784, 1047, 1319].forEach((f, i) => osc(c, 'square', f, f, i * 0.07, i === 4 ? 0.5 : 0.08, 0.15, D(c), { a: 0.002 })),
  },
  { id: 'jump', name: '8-bit zıplama', cat: 'Arayüz', dur: 0.3, gen: (c) => osc(c, 'square', 300, 900, 0, 0.18, 0.18, D(c), { a: 0.002 }) },
  {
    id: 'powerup', name: 'Güç topla', cat: 'Arayüz', dur: 1,
    gen: (c) => {
      for (let i = 0; i < 10; i++) osc(c, 'square', 400 + i * 120, 600 + i * 150, i * 0.07, 0.07, 0.14, D(c), { a: 0.002 });
    },
  },
  {
    id: 'cash', name: 'Kasa', cat: 'Arayüz', dur: 1.2,
    gen: (c) => {
      burst(c, 0, 0.08, 4000, 3, 0.6, 91);
      burst(c, 0.1, 0.08, 3000, 3, 0.5, 92);
      osc(c, 'sine', 2637, 2637, 0.2, 0.9, 0.35, D(c));
      osc(c, 'sine', 3951, 3951, 0.2, 0.5, 0.15, D(c));
    },
  },
  {
    id: 'alarm', name: 'Alarm', cat: 'Arayüz', dur: 1.6,
    gen: (c) => {
      const out = filt(c, 'lowpass', 3000);
      for (let i = 0; i < 4; i++) osc(c, 'square', i % 2 ? 660 : 880, i % 2 ? 660 : 880, i * 0.38, 0.3, 0.18, out, { a: 0.003, hold: 0.25 });
    },
  },
  {
    id: 'phone', name: 'Telefon çalıyor', cat: 'Arayüz', dur: 2.2,
    gen: (c) => {
      for (const t0 of [0, 0.5]) for (const f of [440, 480]) osc(c, 'sine', f, f, t0, 0.4, 0.25, D(c), { a: 0.01, hold: 0.35, vib: [20, 6] });
    },
  },

  /* --- Komik --- */
  { id: 'boing', name: 'Boing', cat: 'Komik', dur: 0.9, gen: (c) => osc(c, 'triangle', 180, 520, 0, 0.8, 0.6, D(c), { a: 0.003, vib: [14, 60], lin: true }) },
  {
    id: 'sad-trombone', name: 'Hüzünlü trombon', cat: 'Komik', dur: 2.6,
    gen: (c) => {
      const out = filt(c, 'lowpass', 1400);
      [[293.7, 0, 0.45], [277.2, 0.5, 0.45], [261.6, 1, 0.45], [247, 1.5, 1]].forEach(([f, t, d]) => osc(c, 'sawtooth', f, f * (d > 0.5 ? 0.97 : 1), t, d, 0.25, out, { a: 0.03, hold: d * 0.7, vib: d > 0.5 ? [5, 6] : undefined }));
    },
  },
  {
    id: 'slide-whistle', name: 'Kaydırmalı düdük', cat: 'Komik', dur: 1.4,
    gen: (c) => {
      osc(c, 'sine', 500, 2000, 0, 0.6, 0.4, D(c), { a: 0.02, hold: 0.5, lin: true });
      osc(c, 'sine', 2000, 400, 0.65, 0.65, 0.4, D(c), { a: 0.005, hold: 0.5, lin: true });
    },
  },
  { id: 'honk', name: 'Korna', cat: 'Komik', dur: 0.8, gen: (c) => { const o = filt(c, 'lowpass', 2200); osc(c, 'square', 330, 330, 0, 0.25, 0.25, o, { hold: 0.2 }); osc(c, 'square', 330, 330, 0.35, 0.35, 0.25, o, { hold: 0.3 }); } },
  {
    id: 'cartoon-run', name: 'Çizgi film koşu', cat: 'Komik', dur: 1,
    gen: (c) => {
      for (let i = 0; i < 12; i++) osc(c, 'square', i % 2 ? 700 : 900, i % 2 ? 700 : 900, i * 0.07, 0.04, 0.12, D(c), { a: 0.002 });
    },
  },
  {
    id: 'crickets', name: 'Cırcır böceği (sessizlik)', cat: 'Komik', dur: 3,
    gen: (c) => {
      for (const t0 of [0.2, 1.2, 2.2]) for (let i = 0; i < 4; i++) osc(c, 'sine', 4500, 4500, t0 + i * 0.05, 0.03, 0.12, D(c), { a: 0.002 });
    },
  },
  {
    id: 'applause', name: 'Alkış', cat: 'Komik', dur: 3.2,
    gen: (c) => {
      const r = rng(123);
      for (let i = 0; i < 160; i++) {
        const t = Math.abs(r()) * 2.8;
        burst(c, t, 0.02 + Math.abs(r()) * 0.02, 1500 + Math.abs(r()) * 2000, 1.2, 0.1 + Math.abs(r()) * 0.15 * (1 - t / 3.2), 300 + i);
      }
    },
  },

  /* --- Ortam --- */
  {
    id: 'rain', name: 'Yağmur', cat: 'Ortam', dur: 5,
    gen: (c) => {
      const n = noise(c, 5, 201);
      const b = filt(c, 'bandpass', 3500, 0.4);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(0.5, 0.6);
      g.gain.setValueAtTime(0.5, 4.4);
      g.gain.exponentialRampToValueAtTime(0.0001, 5);
      n.connect(g).connect(b);
      n.start(0);
      const r = rng(9);
      for (let i = 0; i < 60; i++) burst(c, Math.abs(r()) * 4.7, 0.02, 5000 + Math.abs(r()) * 3000, 4, 0.15, 400 + i);
    },
  },
  {
    id: 'wind', name: 'Rüzgar', cat: 'Ortam', dur: 5,
    gen: (c) => {
      const n = noise(c, 5, 202);
      const b = c.createBiquadFilter();
      b.type = 'bandpass';
      b.Q.value = 2.5;
      b.frequency.setValueAtTime(300, 0);
      b.frequency.linearRampToValueAtTime(900, 1.8);
      b.frequency.linearRampToValueAtTime(400, 3.2);
      b.frequency.linearRampToValueAtTime(700, 5);
      const g = env(c, 0, 1.2, 0.8, 1.2, 2.5);
      n.connect(b).connect(g).connect(D(c));
      n.start(0);
    },
  },
  {
    id: 'clock', name: 'Saat tik-tak', cat: 'Ortam', dur: 4,
    gen: (c) => {
      for (let i = 0; i < 8; i++) burst(c, i * 0.5, 0.015, i % 2 ? 2600 : 3400, 6, 0.8, 500 + i);
    },
  },
  {
    id: 'knock', name: 'Kapı çalma', cat: 'Ortam', dur: 1,
    gen: (c) => {
      const out = filt(c, 'lowpass', 900);
      [0, 0.18, 0.36].forEach((t, i) => {
        burst(c, t, 0.06, 300, 1, 1, 600 + i, out);
        osc(c, 'sine', 160, 90, t, 0.08, 0.6, D(c), { a: 0.001 });
      });
    },
  },
  { id: 'siren', name: 'Siren', cat: 'Ortam', dur: 3, gen: (c) => osc(c, 'sawtooth', 600, 600, 0, 2.9, 0.15, filt(c, 'lowpass', 2500), { a: 0.1, hold: 2.6, vib: [0.8, 250] }) },
];
