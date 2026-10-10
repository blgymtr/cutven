import type { Clip, Project } from '../types';

/**
 * Track mixer (volume / pan / solo) shared by the preview engine and the exporter,
 * plus a broadcast-style loudness meter (EBU R128 momentary / short-term / integrated, sample peak).
 */

export function trackMix(p: Project, c: Clip): { vol: number; pan: number; on: boolean } {
  const tr = p.tracks.find((t) => t.id === c.trackId);
  if (!tr) return { vol: 1, pan: 0, on: false };
  const anySolo = p.tracks.some((t) => t.solo);
  const on = !tr.muted && (!anySolo || !!tr.solo);
  return { vol: tr.volume ?? 1, pan: tr.pan ?? 0, on };
}

const n = (v: number) => (Math.round(v * 100000) / 100000).toString();

/** ffmpeg pan filter equal to WebAudio's StereoPannerNode on a stereo input. */
export function panFfmpeg(pan: number): string[] {
  if (Math.abs(pan) < 0.005) return [];
  if (pan <= 0) {
    const x = pan + 1;
    const gl = Math.cos((x * Math.PI) / 2);
    const gr = Math.sin((x * Math.PI) / 2);
    return [`pan=stereo|c0=c0+${n(gl)}*c1|c1=${n(gr)}*c1`];
  }
  const gl = Math.cos((pan * Math.PI) / 2);
  const gr = Math.sin((pan * Math.PI) / 2);
  return [`pan=stereo|c0=${n(gl)}*c0|c1=c1+${n(gr)}*c0`];
}

/* ------------------------------------------------------------ loudness meter */

export interface MeterReading {
  peakL: number;
  peakR: number;
  /** dBFS, held */
  holdL: number;
  holdR: number;
  momentary: number;
  shortTerm: number;
  integrated: number;
}

const toDb = (v: number) => (v > 1e-9 ? 20 * Math.log10(v) : -120);
const lufs = (ms: number) => (ms > 1e-12 ? -0.691 + 10 * Math.log10(ms) : -120);

export class LoudnessMeter {
  private raw: AnalyserNode[];
  private k: AnalyserNode[];
  private buf: Float32Array<ArrayBuffer>;
  private hist: { t: number; ms: number }[] = [];
  private blocks: number[] = [];
  private lastBlock = 0;
  private hold = [-120, -120];
  private holdT = [0, 0];

  constructor(ctx: AudioContext, input: AudioNode) {
    // K-weighting: high shelf +4 dB @ 1.5 kHz and high-pass @ 38 Hz (BS.1770 pre-filter approximations)
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 1500;
    shelf.gain.value = 4;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 38;
    hp.Q.value = 0.5;
    input.connect(shelf).connect(hp);
    const s1 = ctx.createChannelSplitter(2);
    const s2 = ctx.createChannelSplitter(2);
    input.connect(s1);
    hp.connect(s2);
    const mk = () => {
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      return a;
    };
    this.raw = [mk(), mk()];
    this.k = [mk(), mk()];
    s1.connect(this.raw[0], 0);
    s1.connect(this.raw[1], 1);
    s2.connect(this.k[0], 0);
    s2.connect(this.k[1], 1);
    this.buf = new Float32Array(2048);
  }

  reset() {
    this.hist = [];
    this.blocks = [];
    this.hold = [-120, -120];
  }

  read(playing: boolean): MeterReading {
    const now = performance.now();
    const peaks = this.raw.map((a) => {
      a.getFloatTimeDomainData(this.buf);
      let m = 0;
      for (let i = 0; i < this.buf.length; i++) m = Math.max(m, Math.abs(this.buf[i]));
      return toDb(m);
    });
    let ms = 0;
    for (const a of this.k) {
      a.getFloatTimeDomainData(this.buf);
      let s = 0;
      for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
      ms += s / this.buf.length;
    }
    for (let c = 0; c < 2; c++) {
      if (peaks[c] >= this.hold[c] || now - this.holdT[c] > 1500) {
        this.hold[c] = peaks[c];
        this.holdT[c] = now;
      }
    }
    if (playing) this.hist.push({ t: now, ms });
    while (this.hist.length && now - this.hist[0].t > 3000) this.hist.shift();
    const avg = (win: number) => {
      const xs = this.hist.filter((h) => now - h.t <= win);
      return xs.length ? xs.reduce((a, h) => a + h.ms, 0) / xs.length : 0;
    };
    const mom = lufs(avg(400));
    // integrated: 400 ms blocks every 100 ms, gated at -70 LUFS absolute and -10 LU relative
    if (playing && now - this.lastBlock >= 100) {
      this.lastBlock = now;
      const b = avg(400);
      if (lufs(b) > -70) this.blocks.push(b);
    }
    let integrated = -120;
    if (this.blocks.length) {
      const m1 = this.blocks.reduce((a, b) => a + b, 0) / this.blocks.length;
      const gate = lufs(m1) - 10;
      const kept = this.blocks.filter((b) => lufs(b) > gate);
      if (kept.length) integrated = lufs(kept.reduce((a, b) => a + b, 0) / kept.length);
    }
    return { peakL: peaks[0], peakR: peaks[1], holdL: this.hold[0], holdR: this.hold[1], momentary: playing ? mom : -120, shortTerm: lufs(avg(3000)), integrated };
  }
}
