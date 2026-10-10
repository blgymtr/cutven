import { edit, get, toast } from '../store';
import type { Clip, VolKey } from '../types';
import { clipDur, clipEnd, clamp } from './util';
import { clipEnvelope, toDb } from './audiotools';

/**
 * Volume keyframes (CapCut "anahtar kare"). Keys are anchored to SOURCE time,
 * so trimming / splitting / speed changes keep them on the same sound.
 * Between keys the volume changes linearly; before the first / after the last it stays flat.
 */

export const srcAt = (c: Clip, local: number) => c.in + local * c.speed;
export const localAt = (c: Clip, s: number) => (s - c.in) / c.speed;

export function volAt(c: Clip, local: number): number {
  const k = c.vkeys;
  if (!k || !k.length) return c.volume;
  const s = srcAt(c, local);
  if (s <= k[0].s) return k[0].v;
  for (let i = 1; i < k.length; i++) {
    if (s <= k[i].s) {
      const a = k[i - 1];
      const b = k[i];
      return a.v + ((b.v - a.v) * (s - a.s)) / Math.max(1e-6, b.s - a.s);
    }
  }
  return k[k.length - 1].v;
}

const n = (v: number) => (Math.round(v * 10000) / 10000).toString();

/** ffmpeg volume expression in clip-local timeline time t (after atempo). */
export function volExpr(c: Clip): string | null {
  const k = c.vkeys;
  if (!k || !k.length) return null;
  const S = `(${n(c.in)}+t*${n(c.speed)})`;
  let expr = n(k[k.length - 1].v);
  for (let i = k.length - 1; i >= 1; i--) {
    const a = k[i - 1];
    const b = k[i];
    expr = `if(lt(${S},${n(b.s)}),${n(a.v)}+${n(b.v - a.v)}*(${S}-${n(a.s)})/${n(Math.max(1e-6, b.s - a.s))},${expr})`;
  }
  return `if(lt(${S},${n(k[0].s)}),${n(k[0].v)},${expr})`;
}

const sortKeys = (k: VolKey[]) => k.sort((a, b) => a.s - b.s);
const near = (c: Clip, s: number) => (c.vkeys || []).findIndex((k) => Math.abs(k.s - s) < (1 / 30) * c.speed + 1e-4);

/** Add a key at the playhead (with the current volume) or remove the key that is there. */
export function toggleKeyAtPlayhead(id: string) {
  const c = get().project?.clips.find((x) => x.id === id);
  if (!c) return;
  const local = get().time - c.start;
  if (local < -1e-3 || local > clipDur(c) + 1e-3) {
    toast('Oynatma imlecini klibin üzerine getir');
    return;
  }
  const s = srcAt(c, clamp(local, 0, clipDur(c)));
  const i = near(c, s);
  edit((d) => {
    const x = d.clips.find((q) => q.id === id)!;
    const keys = [...(x.vkeys || [])];
    if (i >= 0) keys.splice(i, 1);
    else keys.push({ s, v: volAt(c, local) });
    x.vkeys = keys.length ? sortKeys(keys) : undefined;
  });
}

export function hasKeyAtPlayhead(c: Clip) {
  const local = get().time - c.start;
  return near(c, srcAt(c, local)) >= 0;
}

/** Volume slider with keyframes: edits the key at the playhead (creating one if needed). */
export function setVolumeAtPlayhead(id: string, v: number) {
  const c = get().project?.clips.find((x) => x.id === id);
  if (!c) return;
  if (!c.vkeys?.length) {
    edit((d) => void (d.clips.find((q) => q.id === id)!.volume = v), { key: 'vol' + id });
    return;
  }
  const local = clamp(get().time - c.start, 0, clipDur(c));
  const s = srcAt(c, local);
  edit(
    (d) => {
      const x = d.clips.find((q) => q.id === id)!;
      const keys = [...(x.vkeys || [])].map((k) => ({ ...k }));
      const i = keys.findIndex((k) => Math.abs(k.s - s) < (1 / 30) * x.speed + 1e-4);
      if (i >= 0) keys[i].v = v;
      else keys.push({ s, v });
      x.vkeys = sortKeys(keys);
    },
    { key: 'volk' + id + Math.round(s * 30) },
  );
}

export function clearKeys(id: string) {
  edit((d) => {
    const x = d.clips.find((q) => q.id === id);
    if (x) x.vkeys = undefined;
  });
}

/** Move one key (drag on the timeline). */
export function moveKey(id: string, index: number, s: number, v: number, record: boolean) {
  edit(
    (d) => {
      const x = d.clips.find((q) => q.id === id);
      if (!x?.vkeys?.[index]) return;
      const keys = x.vkeys.map((k) => ({ ...k }));
      keys[index] = { s: clamp(s, x.in, x.out), v: clamp(v, 0, 2) };
      x.vkeys = keys;
    },
    { record },
  );
}

export function deleteKey(id: string, index: number) {
  edit((d) => {
    const x = d.clips.find((q) => q.id === id);
    if (!x?.vkeys) return;
    const keys = x.vkeys.filter((_, i) => i !== index);
    x.vkeys = keys.length ? keys : undefined;
  });
}

/* ------------------------------------------------------------ auto ducking */

const isVoiceTrackName = (s: string) => /seslendirme|kayıt|vokal|sol kanal|sağ kanal/i.test(s);

/** Speech regions (timeline seconds) from voiceover tracks and talking video clips, excluding `skip`. */
export function voiceRegions(skip: string): [number, number][] {
  const p = get().project!;
  const out: [number, number][] = [];
  for (const c of p.clips) {
    if (c.id === skip || c.muted || (c.kind !== 'audio' && c.kind !== 'video')) continue;
    const tr = p.tracks.find((t) => t.id === c.trackId);
    if (!tr || tr.muted) continue;
    const isVoice = c.kind === 'video' || isVoiceTrackName(tr.name);
    if (!isVoice) continue;
    const env = clipEnvelope(c);
    if (!env) continue;
    // adaptive threshold: 22 dB under the loud part of this clip
    const dbs = Array.from(env, toDb).sort((a, b) => a - b);
    const top = dbs[Math.floor(dbs.length * 0.95)] ?? -20;
    const thr = Math.max(-50, top - 22);
    let st = -1;
    for (let i = 0; i <= env.length; i++) {
      const on = i < env.length && toDb(env[i]) >= thr;
      if (on && st < 0) st = i;
      if (!on && st >= 0) {
        out.push([c.start + st / 100, c.start + i / 100]);
        st = -1;
      }
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  // merge short gaps between words
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < 0.8) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r] as [number, number]);
  }
  return merged.filter(([a, b]) => b - a > 0.25);
}

/** Lower this clip's volume wherever someone speaks (keys are generated, editable afterwards). */
export function autoDuck(id: string, level: number, fade = 0.35) {
  const c = get().project?.clips.find((x) => x.id === id);
  if (!c) return 0;
  const regions = voiceRegions(id).filter(([a, b]) => b > c.start && a < clipEnd(c));
  if (!regions.length) {
    toast('Bu klibin altında konuşma bulunamadı (Seslendirme izi ya da sesli video gerekir)');
    return 0;
  }
  const base = c.volume;
  const keys: VolKey[] = [];
  const toS = (t: number) => clamp(srcAt(c, t - c.start), c.in, c.out);
  for (const [a, b] of regions) {
    keys.push({ s: toS(a - fade), v: base }, { s: toS(a), v: level }, { s: toS(b), v: level }, { s: toS(b + fade), v: base });
  }
  // drop duplicates created by clamping at the clip edges
  const clean = sortKeys(keys).filter((k, i, arr) => i === 0 || Math.abs(k.s - arr[i - 1].s) > 1e-3 || k.v !== arr[i - 1].v);
  edit((d) => {
    const x = d.clips.find((q) => q.id === id);
    if (x) x.vkeys = clean;
  });
  toast(`${regions.length} konuşma bölümünde ses kısıldı`, 'success');
  return regions.length;
}
