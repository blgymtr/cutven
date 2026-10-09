import { edit, get, set, toast } from '../store';
import type { AudioChannel, Clip, Project } from '../types';
import { clipDur, clipEnd, uid } from './util';
import { waveforms } from './media';
import { findTrackWithRoom, insertTrack } from './actions';
import { mediaOf } from './render';
import { buildExport } from './exporter';

/* ------------------------------------------------------------ envelope helpers */

/** Peak envelope (0..1 linear amplitude) of a clip in timeline time, 100 values per second. */
export function clipEnvelope(c: Clip): Float32Array | null {
  const peaks = c.mediaId ? waveforms.get(c.mediaId) : undefined;
  if (!peaks) return null;
  const dur = clipDur(c);
  const n = Math.max(1, Math.floor(dur * 100));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s0 = c.in + (i / 100) * c.speed;
    const s1 = c.in + ((i + 1) / 100) * c.speed;
    let v = 0;
    for (let j = Math.floor(s0 * 100); j < Math.max(Math.floor(s0 * 100) + 1, Math.floor(s1 * 100)) && j < peaks.length; j++) if (peaks[j] > v) v = peaks[j];
    const a = v / 255;
    out[i] = a * a; // waveform peaks are stored sqrt-scaled
  }
  return out;
}

export const toDb = (a: number) => (a > 1e-6 ? 20 * Math.log10(a) : -120);

export interface SilenceOpts {
  thresholdDb: number;
  minSilence: number;
  padding: number;
}

/** Silent ranges in clip-local seconds (already shrunk by padding). */
export function findSilences(env: Float32Array, o: SilenceOpts): [number, number][] {
  const out: [number, number][] = [];
  let runStart = -1;
  const total = env.length / 100;
  for (let i = 0; i <= env.length; i++) {
    const silent = i < env.length && toDb(env[i]) < o.thresholdDb;
    if (silent && runStart < 0) runStart = i;
    if (!silent && runStart >= 0) {
      const s = runStart / 100;
      const e = i / 100;
      if (e - s >= o.minSilence) {
        const ps = s === 0 ? 0 : s + o.padding;
        const pe = e >= total ? total : e - o.padding;
        if (pe - ps > 0.05) out.push([ps, pe]);
      }
      runStart = -1;
    }
  }
  return out;
}

const linkedOf = (p: Project, c: Clip) =>
  p.clips.filter(
    (x) =>
      x.id !== c.id &&
      x.mediaId &&
      x.mediaId === c.mediaId &&
      Math.abs(x.start - c.start) < 1e-3 &&
      Math.abs(x.in - c.in) < 1e-3 &&
      Math.abs(x.out - c.out) < 1e-3 &&
      Math.abs(x.speed - c.speed) < 1e-6,
  );

export function silencePreview(id: string, o: SilenceOpts) {
  const c = get().project?.clips.find((x) => x.id === id);
  if (!c) return null;
  const env = clipEnvelope(c);
  if (!env) return null;
  const sil = findSilences(env, o);
  return { count: sil.length, removed: sil.reduce((s, [a, b]) => s + b - a, 0), duration: clipDur(c) };
}

/**
 * Split a clip (and its detached-audio twin) at silences.
 * remove=true deletes the silent parts and closes the gaps (jump cut).
 */
export function cutSilences(id: string, o: SilenceOpts, remove: boolean) {
  const p = get().project;
  const c = p?.clips.find((x) => x.id === id);
  if (!p || !c) return;
  const env = clipEnvelope(c);
  if (!env) {
    toast('Bu klibin ses dalgası henüz hazır değil', 'error');
    return;
  }
  const sil = findSilences(env, o);
  if (!sil.length) {
    toast('Bu ayarlarla sessizlik bulunamadı — eşiği yükselt ya da süreyi kısalt');
    return;
  }
  const dur = clipDur(c);
  // pieces in clip-local time
  const pieces: { a: number; b: number; silent: boolean }[] = [];
  let t = 0;
  for (const [a, b] of sil) {
    if (a > t + 0.01) pieces.push({ a: t, b: a, silent: false });
    pieces.push({ a, b, silent: true });
    t = b;
  }
  if (dur > t + 0.01) pieces.push({ a: t, b: dur, silent: false });
  const keep = remove ? pieces.filter((x) => !x.silent) : pieces;
  const removed = remove ? pieces.filter((x) => x.silent).reduce((s, x) => s + x.b - x.a, 0) : 0;
  const group = [c, ...linkedOf(p, c)];
  const newIds: string[] = [];
  edit((d) => {
    const oldEnd = clipEnd(c);
    for (const g of group) {
      const src = d.clips.find((x) => x.id === g.id);
      if (!src) continue;
      const base: Clip = JSON.parse(JSON.stringify(src));
      d.clips = d.clips.filter((x) => x.id !== g.id);
      let at = base.start;
      keep.forEach((pc, i) => {
        const n: Clip = { ...JSON.parse(JSON.stringify(base)), id: i === 0 ? base.id : uid() };
        n.in = base.in + pc.a * base.speed;
        n.out = base.in + pc.b * base.speed;
        n.start = remove ? at : base.start + pc.a;
        at += pc.b - pc.a;
        // short fades keep jump cuts click-free
        n.audioFadeIn = i === 0 ? base.audioFadeIn : 0.01;
        n.audioFadeOut = i === keep.length - 1 ? base.audioFadeOut : 0.01;
        n.fadeIn = i === 0 ? base.fadeIn : 0;
        n.fadeOut = i === keep.length - 1 ? base.fadeOut : 0;
        if (i > 0) n.tIn = undefined;
        if (i < keep.length - 1) n.tOut = undefined;
        d.clips.push(n);
        if (g.id === c.id) newIds.push(n.id);
      });
    }
    if (remove && removed > 0) {
      const tracks = new Set(group.map((g) => g.trackId));
      const groupIds = new Set(d.clips.filter((x) => group.some((g) => g.id === x.id) || newIds.includes(x.id)).map((x) => x.id));
      for (const x of d.clips) if (tracks.has(x.trackId) && !groupIds.has(x.id) && x.start >= oldEnd - 1e-3) x.start = Math.max(0, x.start - removed);
    }
  });
  set({ selection: newIds });
  toast(remove ? `${sil.length} sessizlik silindi · ${removed.toFixed(1)} sn kısaldı` : `${sil.length} sessizlikten bölündü`, 'success');
}

/* ------------------------------------------------------------ channel / stem split */

export function splitChannels(id: string, mode: 'lr' | 'stem') {
  const p = get().project;
  const c = p?.clips.find((x) => x.id === id);
  const m = c && p && mediaOf(p, c);
  if (!p || !c || !m?.hasAudio || (c.kind !== 'audio' && c.kind !== 'video')) return;
  const parts: [AudioChannel, string][] = mode === 'lr' ? [['L', 'Sol kanal'], ['R', 'Sağ kanal']] : [['mid', 'Vokal'], ['side', 'Müzik']];
  const ids: string[] = [];
  edit((d) => {
    const src = d.clips.find((x) => x.id === id)!;
    const end = clipEnd(src as Clip);
    for (const [chan, name] of parts) {
      let tr = d.tracks.find((t) => t.type === 'audio' && t.name === name && !t.locked && !d.clips.some((x) => x.trackId === t.id && x.start < end && clipEnd(x as Clip) > src.start));
      if (!tr) {
        tr = insertTrack(d, 'audio');
        tr.name = name;
      }
      const n: Clip = { ...JSON.parse(JSON.stringify(src)), id: uid(), kind: 'audio', trackId: tr.id, chan, muted: false };
      d.clips.push(n);
      ids.push(n.id);
    }
    if (src.kind === 'video') src.muted = true;
    else d.clips = d.clips.filter((x) => x.id !== id);
  });
  set({ selection: ids });
  toast(mode === 'lr' ? 'Sol ve sağ kanal ayrı izlere ayrıldı' : 'Vokal ve müzik ayrıldı (basit yöntem, stereo kayıtlarda en iyi sonuç)', 'success');
}

export function setChannel(id: string, chan: AudioChannel | undefined) {
  edit((d) => {
    const c = d.clips.find((x) => x.id === id);
    if (c) c.chan = chan;
  });
}

/* ------------------------------------------------------------ save audio of one clip */

export async function exportClipAudio(id: string, fmt: 'wav' | 'mp3') {
  const p = get().project;
  const c = p?.clips.find((x) => x.id === id);
  const m = c && p && mediaOf(p, c);
  if (!p || !c || !m) return;
  const out = await window.cv.invoke<string | null>('dialog:saveExport', m.name.replace(/\.[^.]+$/, '') + ' - ses', fmt);
  if (!out) return;
  const clip: Clip = { ...c, start: 0, muted: false };
  const mini: Project = { ...p, clips: [clip], tracks: p.tracks.map((t) => (t.id === c.trackId ? { ...t, muted: false } : t)) };
  toast('Ses kaydediliyor…');
  const job = await buildExport(mini, { format: fmt, width: 0, height: 0, fps: 30, crf: 0, preset: '', normalize: false, outPath: out });
  const r = await window.cv.invoke<{ ok: boolean; error?: string }>('export:start', job);
  if (r.ok) toast('Ses dosyası kaydedildi', 'success');
  else toast('Kaydedilemedi: ' + (r.error || ''), 'error');
}

/** Ensure there is an audio track with room; returns its id (used by SFX). */
export function audioTrackFor(start: number, end: number, name: string): string {
  let id = '';
  edit(
    (d) => {
      const tr = d.tracks.find((t) => t.type === 'audio' && t.name === name && !t.locked && !d.clips.some((x) => x.trackId === t.id && x.start < end && clipEnd(x as Clip) > start));
      if (tr) id = tr.id;
      else {
        const t = insertTrack(d, 'audio');
        t.name = name;
        id = t.id;
      }
    },
    { record: false },
  );
  return id || findTrackWithRoom(get().project!, 'audio', start, end) || '';
}
