import { edit, get, set, toast } from '../store';
import { importPaths } from './media';
import { clipFromMedia } from './actions';
import { audioTrackFor } from './audiotools';
import { mediaUrl } from './util';

/**
 * Built-in sound effects, synthesized offline (no downloads, no licenses).
 * Rendered once into WAV files under userData/sfx and then used like any other media.
 */

const SR = 48000;
type Gen = (c: OfflineAudioContext) => void;

export interface SfxDef {
  id: string;
  name: string;
  cat: 'Geçiş' | 'Arayüz' | 'Vurgu' | 'Ortam';
  dur: number;
  gen: Gen;
}

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

function env(c: OfflineAudioContext, t0: number, a: number, peak: number, dec: number, sustainEnd?: number) {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + a);
  if (sustainEnd) g.gain.setValueAtTime(peak, sustainEnd);
  g.gain.exponentialRampToValueAtTime(0.0001, (sustainEnd || t0 + a) + dec);
  return g;
}

function tone(c: OfflineAudioContext, type: OscillatorType, f0: number, f1: number, t0: number, dur: number, peak: number, out: AudioNode, a = 0.005) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  const g = env(c, t0, a, peak, dur);
  o.connect(g).connect(out);
  o.start(t0);
  o.stop(t0 + dur + a + 0.05);
}

function whoosh(c: OfflineAudioContext, dur: number, f0: number, fMid: number, f1: number, peak: number, seed: number) {
  const n = noise(c, dur, seed);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.4;
  bp.frequency.setValueAtTime(f0, 0);
  bp.frequency.exponentialRampToValueAtTime(fMid, dur * 0.55);
  bp.frequency.exponentialRampToValueAtTime(f1, dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, 0);
  g.gain.exponentialRampToValueAtTime(peak, dur * 0.55);
  g.gain.exponentialRampToValueAtTime(0.0001, dur);
  const pan = c.createStereoPanner();
  pan.pan.setValueAtTime(-0.8, 0);
  pan.pan.linearRampToValueAtTime(0.8, dur);
  n.connect(bp).connect(g).connect(pan).connect(c.destination);
  n.start(0);
}

function burst(c: OfflineAudioContext, t0: number, dur: number, f: number, q: number, peak: number, seed: number) {
  const n = noise(c, dur + 0.05, seed);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = f;
  bp.Q.value = q;
  const g = env(c, t0, 0.002, peak, dur);
  n.connect(bp).connect(g).connect(c.destination);
  n.start(t0);
}

export const SFX: SfxDef[] = [
  { id: 'whoosh', name: 'Whoosh', cat: 'Geçiş', dur: 0.9, gen: (c) => whoosh(c, 0.9, 250, 2800, 500, 0.9, 11) },
  { id: 'swoosh', name: 'Hızlı swoosh', cat: 'Geçiş', dur: 0.45, gen: (c) => whoosh(c, 0.45, 800, 5000, 1500, 0.8, 23) },
  {
    id: 'riser', name: 'Yükselen', cat: 'Geçiş', dur: 3,
    gen: (c) => {
      whoosh(c, 3, 200, 2500, 7000, 0.5, 31);
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2500;
      lp.connect(c.destination);
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(110, 0);
      o.frequency.exponentialRampToValueAtTime(880, 3);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(0.18, 2.9);
      g.gain.linearRampToValueAtTime(0, 3);
      o.connect(g).connect(lp);
      o.start(0);
      o.stop(3);
    },
  },
  {
    id: 'boom', name: 'Boom', cat: 'Vurgu', dur: 2.2,
    gen: (c) => {
      tone(c, 'sine', 70, 28, 0, 1.8, 1, c.destination, 0.004);
      const n = noise(c, 1.2, 5);
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900, 0);
      lp.frequency.exponentialRampToValueAtTime(120, 1);
      const g = env(c, 0, 0.003, 0.7, 1);
      n.connect(lp).connect(g).connect(c.destination);
      n.start(0);
    },
  },
  { id: 'kick', name: 'Vuruş', cat: 'Vurgu', dur: 0.5, gen: (c) => tone(c, 'sine', 160, 42, 0, 0.42, 1, c.destination, 0.002) },
  {
    id: 'drama', name: 'Dramatik', cat: 'Vurgu', dur: 2.6,
    gen: (c) => {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1400;
      lp.connect(c.destination);
      const notes: [number, number, number][] = [[146.8, 0, 0.35], [146.8, 0.42, 0.35], [174.6, 0.84, 1.6]];
      for (const [f, t, d] of notes) {
        tone(c, 'sawtooth', f, f, t, d, 0.35, lp, 0.01);
        tone(c, 'sawtooth', f * 2, f * 2, t, d, 0.12, lp, 0.01);
      }
    },
  },
  {
    id: 'ding', name: 'Ding', cat: 'Arayüz', dur: 1.8,
    gen: (c) => {
      tone(c, 'sine', 1320, 1320, 0, 1.6, 0.6, c.destination, 0.002);
      tone(c, 'sine', 2640, 2640, 0, 0.9, 0.22, c.destination, 0.002);
      tone(c, 'sine', 3960, 3960, 0, 0.5, 0.1, c.destination, 0.002);
    },
  },
  {
    id: 'notify', name: 'Bildirim', cat: 'Arayüz', dur: 0.8,
    gen: (c) => {
      tone(c, 'sine', 880, 880, 0, 0.3, 0.5, c.destination);
      tone(c, 'sine', 1320, 1320, 0.13, 0.5, 0.5, c.destination);
    },
  },
  {
    id: 'success', name: 'Başarı', cat: 'Arayüz', dur: 1.1,
    gen: (c) => {
      [523.3, 659.3, 784, 1046.5].forEach((f, i) => {
        tone(c, 'triangle', f, f, i * 0.09, 0.6, 0.4, c.destination);
        tone(c, 'sine', f * 2, f * 2, i * 0.09, 0.3, 0.1, c.destination);
      });
    },
  },
  {
    id: 'error', name: 'Hata', cat: 'Arayüz', dur: 0.7,
    gen: (c) => {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1600;
      lp.connect(c.destination);
      tone(c, 'square', 220, 200, 0, 0.18, 0.3, lp);
      tone(c, 'square', 185, 160, 0.22, 0.32, 0.3, lp);
    },
  },
  {
    id: 'coin', name: 'Para', cat: 'Arayüz', dur: 0.6,
    gen: (c) => {
      tone(c, 'square', 988, 988, 0, 0.08, 0.18, c.destination, 0.001);
      tone(c, 'square', 1319, 1319, 0.08, 0.45, 0.18, c.destination, 0.001);
    },
  },
  { id: 'pop', name: 'Pop', cat: 'Arayüz', dur: 0.2, gen: (c) => tone(c, 'sine', 900, 160, 0, 0.12, 0.8, c.destination, 0.001) },
  { id: 'click', name: 'Tık', cat: 'Arayüz', dur: 0.08, gen: (c) => burst(c, 0, 0.03, 3500, 1.2, 0.9, 3) },
  {
    id: 'shutter', name: 'Fotoğraf', cat: 'Ortam', dur: 0.4,
    gen: (c) => {
      burst(c, 0, 0.05, 2800, 1, 1, 41);
      burst(c, 0.11, 0.08, 1800, 1, 0.8, 42);
    },
  },
  {
    id: 'typing', name: 'Klavye', cat: 'Ortam', dur: 1.8,
    gen: (c) => {
      const r = rng(99);
      let t = 0.02;
      for (let i = 0; i < 14; i++) {
        burst(c, t, 0.025, 2200 + r() * 1200, 2, 0.5 + r() * 0.3, 100 + i);
        t += 0.09 + (r() + 1) * 0.05;
      }
    },
  },
  {
    id: 'heart', name: 'Kalp atışı', cat: 'Ortam', dur: 1.8,
    gen: (c) => {
      for (const t0 of [0, 0.9]) {
        tone(c, 'sine', 70, 45, t0, 0.16, 1, c.destination, 0.004);
        tone(c, 'sine', 65, 42, t0 + 0.22, 0.2, 0.8, c.destination, 0.004);
      }
    },
  },
  {
    id: 'glitch', name: 'Glitch', cat: 'Geçiş', dur: 0.8,
    gen: (c) => {
      const r = rng(77);
      let t = 0;
      while (t < 0.75) {
        const d = 0.015 + (r() + 1) * 0.02;
        if (r() > -0.3) tone(c, 'square', 200 + (r() + 1) * 1500, 200 + (r() + 1) * 1500, t, d, 0.25, c.destination, 0.001);
        t += d;
      }
    },
  },
];

function encodeWav(buf: AudioBuffer): Uint8Array {
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o: number, s: string) => [...s].forEach((x, i) => data.setUint8(o + i, x.charCodeAt(0)));
  w(0, 'RIFF');
  data.setUint32(4, 36 + len * ch * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, ch, true);
  data.setUint32(24, buf.sampleRate, true);
  data.setUint32(28, buf.sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true);
  data.setUint16(34, 16, true);
  w(36, 'data');
  data.setUint32(40, len * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < len; i++)
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  return new Uint8Array(data.buffer);
}

const fileName = (id: string) => `${id}-v1.wav`;
const cache = new Map<string, Promise<string>>();

export function ensureSfx(id: string): Promise<string> {
  if (!cache.has(id)) {
    cache.set(
      id,
      (async () => {
        const have = await window.cv.invoke<string | null>('userfile:path', 'sfx', fileName(id));
        if (have) return have;
        const def = SFX.find((s) => s.id === id)!;
        const ctx = new OfflineAudioContext(2, Math.ceil((def.dur + 0.05) * SR), SR);
        def.gen(ctx);
        const buf = await ctx.startRendering();
        // gentle normalisation to -1 dBFS peak
        let peak = 0;
        for (let c = 0; c < buf.numberOfChannels; c++) for (const v of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
        if (peak > 0) {
          const g = 0.89 / peak;
          for (let c = 0; c < buf.numberOfChannels; c++) {
            const d = buf.getChannelData(c);
            for (let i = 0; i < d.length; i++) d[i] *= g;
          }
        }
        return window.cv.invoke<string>('userfile:write', 'sfx', fileName(id), encodeWav(buf));
      })(),
    );
  }
  return cache.get(id)!;
}

let previewEl: HTMLAudioElement | null = null;
export async function previewSfx(id: string) {
  const path = await ensureSfx(id);
  previewEl?.pause();
  previewEl = new Audio(mediaUrl(path));
  previewEl.play().catch(() => {});
}

export async function addSfx(id: string, start = get().time) {
  const def = SFX.find((s) => s.id === id);
  if (!def || !get().project) return;
  const path = await ensureSfx(id);
  const [m] = await importPaths([path]);
  if (!m) return;
  if (m.name !== def.name) edit((d) => {
    const mm = d.media.find((x) => x.id === m.id);
    if (mm) mm.name = def.name;
  }, { record: false });
  const trackId = audioTrackFor(start, start + m.duration, 'Efektler');
  let cid = '';
  edit((d) => {
    const c = clipFromMedia(m, trackId, start);
    cid = c.id;
    d.clips.push(c);
  });
  set({ selection: [cid] });
  toast(`${def.name} eklendi`, 'success');
}
