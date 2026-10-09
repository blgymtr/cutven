import type { Clip, Project } from '../types';
import { clipDur, projectDuration } from './util';
import { clipEnvelope, toDb } from './audiotools';

/** Narration pace classes in syllables per second (Turkish read speech ≈ 4–5 syl/s). */
export const PACES = [
  { id: 0, name: 'Sakin', syl: [3.6, 4.3] as [number, number], hint: 'Belgesel, anlatı, duygusal anlar' },
  { id: 1, name: 'Orta', syl: [4.3, 5.0] as [number, number], hint: 'Klasik YouTube anlatımı' },
  { id: 2, name: 'Hızlı', syl: [5.0, 5.8] as [number, number], hint: 'Enerjik vlog, liste videoları' },
  { id: 3, name: 'Çok hızlı', syl: [5.8, 6.5] as [number, number], hint: 'Shorts, hızlı kurgu' },
];

const VOWELS = /[aeıioöuüâîûAEIİOÖUÜÂÎÛ]/g;

export function scriptStats(text: string) {
  const words = (text.match(/[\p{L}\p{N}]+/gu) || []).length;
  const syl = (text.match(VOWELS) || []).length || Math.round(words * 2.6);
  // sentence-ending punctuation adds natural pauses
  const breaks = (text.match(/[.!?…]+/g) || []).length + (text.match(/[,;:]/g) || []).length * 0.4;
  return { words, syl, sylPerWord: words ? syl / words : 2.6, breaks };
}

/** Seconds needed to read the text at the given syllable rate (incl. short pauses). */
export const readTime = (st: ReturnType<typeof scriptStats>, rate: number) => st.syl / rate + st.breaks * 0.35;

/** Syllable rate that makes the text fit in `seconds`. */
export const rateFor = (st: ReturnType<typeof scriptStats>, seconds: number) => st.syl / Math.max(0.5, seconds - st.breaks * 0.35);

export function paceOf(rate: number) {
  if (rate < PACES[0].syl[0]) return -1;
  for (const p of PACES) if (rate < p.syl[1]) return p.id;
  return 4;
}

/* ------------------------------------------------------------ envelope analysis */

function percentile(a: number[], q: number) {
  if (!a.length) return -120;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

export interface SpeechStats {
  syllables: number;
  voiced: number;
  total: number;
  rate: number;
  pauses: number;
  longPauses: number;
  avgPause: number;
  speechRatio: number;
}

/** Syllable nuclei = envelope peaks during speech (100 values per second, linear amplitude). */
export function analyzeSpeech(env: Float32Array | number[]): SpeechStats {
  const n = env.length;
  const lin = new Float32Array(n);
  for (let i = 0; i < n; i++) lin[i] = ((env[i - 1] ?? env[i]) + env[i] * 2 + (env[i + 1] ?? env[i])) / 4;
  const db = Array.from(lin, toDb);
  const floor = percentile(db, 0.15);
  const top = percentile(db, 0.97);
  const thr = Math.max(floor + 10, top - 28);
  // Syllable nuclei: local maxima (±40 ms) above the speech threshold that are separated
  // from the previous nucleus by a valley at least 2 dB deep, and ≥ 80 ms apart.
  let syllables = 0;
  let last = -100;
  let voicedN = 0;
  let valley = Infinity;
  let lastPeakDb = -Infinity;
  for (let i = 0; i < n; i++) {
    if (db[i] >= thr) voicedN++;
    valley = Math.min(valley, db[i]);
    if (db[i] < thr) continue;
    let isMax = true;
    for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) if (db[j] > db[i] || (db[j] === db[i] && j < i)) isMax = false;
    if (!isMax) continue;
    const deep = Math.min(db[i], lastPeakDb) - valley >= 2 || last < 0;
    if (i - last < 8) {
      // too close: keep the stronger of the two
      if (db[i] > lastPeakDb) {
        lastPeakDb = db[i];
        last = i;
      }
      continue;
    }
    if (!deep) {
      if (db[i] > lastPeakDb) lastPeakDb = db[i];
      continue;
    }
    syllables++;
    last = i;
    lastPeakDb = db[i];
    valley = Infinity;
  }
  // pauses between speech
  let pauses = 0;
  let longPauses = 0;
  let pauseSum = 0;
  let run = 0;
  let seenSpeech = false;
  for (let i = 0; i < n; i++) {
    if (db[i] < thr) run++;
    else {
      if (seenSpeech && run >= 25) {
        pauses++;
        pauseSum += run / 100;
        if (run >= 100) longPauses++;
      }
      run = 0;
      seenSpeech = true;
    }
  }
  // speaking time = first to last voiced frame, minus the real pauses (≥ 250 ms)
  let first = -1;
  let lastV = -1;
  for (let i = 0; i < n; i++)
    if (db[i] >= thr) {
      if (first < 0) first = i;
      lastV = i;
    }
  const speaking = first >= 0 ? (lastV - first + 1) / 100 - pauseSum : 0;
  const voiced = voicedN / 100;
  return {
    syllables,
    voiced,
    total: n / 100,
    rate: speaking > 0.5 ? syllables / speaking : 0,
    pauses,
    longPauses,
    avgPause: pauses ? pauseSum / pauses : 0,
    speechRatio: n ? voicedN / n : 0,
  };
}

/** Tempo in BPM from an amplitude envelope (100 Hz), via onset autocorrelation. */
export function detectBpm(env: Float32Array): { bpm: number; confidence: number } | null {
  const n = Math.min(env.length, 100 * 120);
  if (n < 800) return null;
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) sm[i] = Math.log10(1e-4 + (env[i] + (env[i - 1] ?? 0) + (env[i + 1] ?? 0)) / 3);
  const on = new Float32Array(n);
  for (let i = 1; i < n; i++) on[i] = Math.max(0, sm[i] - sm[i - 1]);
  let mean = 0;
  for (const v of on) mean += v;
  mean /= n;
  for (let i = 0; i < n; i++) on[i] -= mean;
  const ac = (l: number) => {
    let s = 0;
    for (let i = 0; i + l < n; i++) s += on[i] * on[i + l];
    return s;
  };
  const r0 = ac(0) || 1;
  let best = 0;
  let bestL = 0;
  const vals: number[] = [];
  for (let l = 30; l <= 110; l++) {
    // favour the 90–130 BPM region slightly (perceptual prior)
    const bpm = 6000 / l;
    const w = 1 - 0.25 * Math.min(1, Math.abs(Math.log2(bpm / 110)));
    const v = ac(l) * w;
    vals[l] = v;
    if (v > best) {
      best = v;
      bestL = l;
    }
  }
  if (!bestL || best <= 0) return null;
  const a = vals[bestL - 1] ?? best;
  const c = vals[bestL + 1] ?? best;
  const off = (a - c) / (2 * (a - 2 * best + c) || 1);
  let bpm = 6000 / (bestL + (Number.isFinite(off) ? Math.max(-0.5, Math.min(0.5, off)) : 0));
  while (bpm < 70) bpm *= 2;
  while (bpm > 170) bpm /= 2;
  return { bpm: Math.round(bpm), confidence: Math.max(0, Math.min(1, best / r0)) };
}

/* ------------------------------------------------------------ video tempo */

const isVoiceTrack = (name: string) => /seslendirme|kayıt|vokal/i.test(name);
const isFxTrack = (name: string) => /efekt/i.test(name);

export interface VideoTempo {
  duration: number;
  shots: number;
  asl: number | null;
  cutsPerMin: number | null;
  bpm: number | null;
  musicName: string | null;
  level: number;
  reasons: string[];
}

export function videoTempo(p: Project): VideoTempo {
  const duration = projectDuration(p);
  const visual = p.tracks.filter((t) => t.type === 'visual');
  const main = visual[visual.length - 1];
  const mainClips = p.clips.filter((c) => c.trackId === main?.id && c.kind !== 'text');
  const shots = mainClips.length;
  const mainDur = mainClips.reduce((s, c) => s + clipDur(c), 0);
  const asl = shots >= 2 ? mainDur / shots : null;
  const levels: number[] = [];
  const reasons: string[] = [];
  if (asl != null) {
    const lv = asl >= 6 ? 0 : asl >= 3.5 ? 1 : asl >= 2 ? 2 : 3;
    levels.push(lv);
    reasons.push(`Ortalama plan süresi ${asl.toFixed(1)} sn (${PACES[lv].name.toLowerCase()} kurgu)`);
  }
  // music: the longest audio clip that is not voiceover / sfx
  let music: Clip | null = null;
  for (const c of p.clips) {
    if (c.kind !== 'audio') continue;
    const tr = p.tracks.find((t) => t.id === c.trackId);
    if (!tr || isVoiceTrack(tr.name) || isFxTrack(tr.name) || c.chan === 'mid') continue;
    if (!music || clipDur(c) > clipDur(music)) music = c;
  }
  let bpm: number | null = null;
  let musicName: string | null = null;
  if (music && clipDur(music) >= 8) {
    const env = clipEnvelope(music);
    const r = env && detectBpm(env);
    if (r) {
      bpm = r.bpm;
      musicName = p.media.find((m) => m.id === music!.mediaId)?.name || null;
      const lv = bpm < 85 ? 0 : bpm < 110 ? 1 : bpm < 135 ? 2 : 3;
      levels.push(lv);
      reasons.push(`Müzik temposu ~${bpm} BPM`);
    }
  }
  if (p.height > p.width) {
    levels.push(Math.max(2, levels.length ? Math.round(levels.reduce((a, b) => a + b) / levels.length) : 2));
    reasons.push('Dikey format (Shorts) hızlı anlatım ister');
  }
  const level = levels.length ? Math.round(levels.reduce((a, b) => a + b, 0) / levels.length) : 1;
  if (!reasons.length) reasons.push('Henüz kurgu/müzik verisi az — varsayılan orta tempo');
  return { duration, shots, asl, cutsPerMin: asl ? 60 / asl : null, bpm, musicName, level, reasons };
}

export function advice(rate: number, target: [number, number]) {
  if (!rate) return { tone: 'muted', text: 'Konuşma algılanamadı.' };
  if (rate < target[0] - 0.4) return { tone: 'warn', text: `Yavaşsın — biraz hızlan (hedef ${target[0]}–${target[1]} hece/sn).` };
  if (rate < target[0]) return { tone: 'ok', text: 'Hedefin biraz altında, hafif hızlanabilirsin.' };
  if (rate <= target[1]) return { tone: 'good', text: 'Tempo videoya tam uyuyor.' };
  if (rate <= target[1] + 0.4) return { tone: 'ok', text: 'Hedefin biraz üstünde, hafif yavaşlayabilirsin.' };
  return { tone: 'warn', text: `Hızlısın — biraz yavaşla (hedef ${target[0]}–${target[1]} hece/sn).` };
}

export interface Segment {
  t0: number;
  t1: number;
  rate: number;
  speaking: boolean;
}

/** Speaking rate per window (default 4 s) — shows where a take speeds up or slows down. */
export function segmentRates(env: Float32Array | number[], win = 4): Segment[] {
  const n = env.length;
  const step = Math.round(win * 100);
  const out: Segment[] = [];
  for (let i = 0; i < n; i += step) {
    const slice = Array.prototype.slice.call(env, Math.max(0, i - 50), Math.min(n, i + step + 50)) as number[];
    const s = analyzeSpeech(slice);
    const speaking = s.voiced > win * 0.3 && s.rate > 0;
    out.push({ t0: i / 100, t1: Math.min(n, i + step) / 100, rate: speaking ? s.rate : 0, speaking });
  }
  return out;
}

/** Plain-language feedback for a finished take. */
export function takeReport(env: Float32Array | number[], target: [number, number]) {
  const s = analyzeSpeech(env);
  const segs = segmentRates(env);
  const fast = segs.filter((g) => g.speaking && g.rate > target[1] + 0.4);
  const slow = segs.filter((g) => g.speaking && g.rate < target[0] - 0.4);
  const mid = (target[0] + target[1]) / 2;
  let verdict: { tone: 'good' | 'ok' | 'warn' | 'muted'; title: string };
  if (!s.rate) verdict = { tone: 'muted', title: 'Konuşma algılanamadı' };
  else if (s.rate > target[1] + 0.6) verdict = { tone: 'warn', title: 'Çok hızlısın' };
  else if (s.rate > target[1]) verdict = { tone: 'ok', title: 'Biraz hızlısın' };
  else if (s.rate < target[0] - 0.6) verdict = { tone: 'warn', title: 'Çok yavaşsın' };
  else if (s.rate < target[0]) verdict = { tone: 'ok', title: 'Biraz yavaşsın' };
  else verdict = { tone: 'good', title: 'Tempo tam yerinde' };
  const tips: string[] = [];
  if (s.rate && Math.abs(s.rate - mid) > 0.3) {
    const pct = Math.round(Math.abs(s.rate / mid - 1) * 100);
    tips.push(s.rate > mid ? `Yaklaşık %${pct} daha yavaş oku; cümle sonlarında kısa nefes al.` : `Yaklaşık %${pct} daha hızlı oku; kelimeler arasındaki boşlukları kısalt.`);
  }
  const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  if (fast.length) tips.push(`Hızlandığın yerler: ${fast.slice(0, 4).map((g) => fmt(g.t0)).join(', ')}`);
  if (slow.length) tips.push(`Yavaşladığın yerler: ${slow.slice(0, 4).map((g) => fmt(g.t0)).join(', ')}`);
  if (s.longPauses) tips.push(`${s.longPauses} uzun duraklama (1 sn+) var — “Sessizlikleri sil” ile videoyu sıkılaştırabilirsin.`);
  const spoken = segs.filter((g) => g.speaking);
  if (spoken.length >= 3) {
    const rates = spoken.map((g) => g.rate);
    const sd = Math.sqrt(rates.reduce((a, r) => a + (r - s.rate) ** 2, 0) / rates.length);
    if (sd > 0.9) tips.push('Hızın kayıt boyunca çok değişiyor; daha dengeli bir tempo dinleyiciyi yormaz.');
    else if (sd < 0.35 && verdict.tone === 'good') tips.push('Tempon baştan sona dengeli, harika.');
  }
  return { stats: s, segs, verdict, tips };
}
