import type { Draft } from 'immer';
import { edit, get, set, toast } from '../store';
import type { Clip, MediaItem, Project } from '../types';
import { clipFromMedia, insertTrack } from './actions';
import { clipDur, clipEnd, projectDuration, uid } from './util';

/**
 * Pro editing (Premiere-style): In/Out marks, lift / extract, ripple trims (Q/W),
 * add edit on all tracks (Ctrl+K), three-point insert / overwrite and range export.
 */

const EPS = 1e-4;
type D = Draft<Project>;
const locked = (p: Project | D, c: Clip) => !!p.tracks.find((t) => t.id === c.trackId)?.locked;
const isSourced = (c: Clip) => c.kind === 'video' || c.kind === 'audio';

/* ------------------------------------------------------------ In / Out */

export function markIn(t = get().time) {
  edit((d) => {
    d.inPoint = t;
    if (d.outPoint != null && d.outPoint <= t) d.outPoint = undefined;
  });
}
export function markOut(t = get().time) {
  edit((d) => {
    d.outPoint = t;
    if (d.inPoint != null && d.inPoint >= t) d.inPoint = undefined;
  });
}
export function clearInOut() {
  edit((d) => {
    d.inPoint = undefined;
    d.outPoint = undefined;
  });
}
/** In/Out range, defaulting to start / end of the timeline. */
export function ioRange(p: Project): [number, number] | null {
  if (p.inPoint == null && p.outPoint == null) return null;
  const a = p.inPoint ?? 0;
  const b = p.outPoint ?? projectDuration(p);
  return b - a > 0.01 ? [a, b] : null;
}
/** Mark In/Out around the selected clip(s) (Premiere "X"). */
export function markSelection() {
  const s = get();
  const sel = s.project!.clips.filter((c) => s.selection.includes(c.id));
  if (!sel.length) return toast('Önce bir klip seç');
  edit((d) => {
    d.inPoint = Math.min(...sel.map((c) => c.start));
    d.outPoint = Math.max(...sel.map(clipEnd));
  });
}

/* ------------------------------------------------------------ cutting a range */

/** Split clip `c` (draft) at timeline time t; returns the right half (or null if t is not inside). */
function splitDraft(d: D, c: Draft<Clip>, t: number): Draft<Clip> | null {
  if (t <= c.start + EPS || t >= clipEnd(c as Clip) - EPS) return null;
  const right = JSON.parse(JSON.stringify(c)) as Clip;
  right.id = uid();
  right.start = t;
  right.fadeIn = 0;
  right.audioFadeIn = 0;
  if (isSourced(c as Clip)) {
    const cut = c.in + (t - c.start) * c.speed;
    right.in = cut;
    c.out = cut;
  } else {
    right.in = 0;
    right.out = c.out - (t - c.start);
    c.out = t - c.start;
    c.in = 0;
  }
  c.fadeOut = 0;
  c.audioFadeOut = 0;
  d.clips.push(right);
  return d.clips[d.clips.length - 1];
}

/** Remove everything between a and b on unlocked tracks; with ripple close the gap. */
export function removeRange(a: number, b: number, ripple: boolean, d: D) {
  const len = b - a;
  for (const c of [...d.clips]) {
    if (locked(d, c as Clip)) continue;
    if (clipEnd(c as Clip) <= a + EPS || c.start >= b - EPS) continue;
    splitDraft(d, c, a);
  }
  for (const c of [...d.clips]) {
    if (locked(d, c as Clip)) continue;
    if (clipEnd(c as Clip) <= a + EPS || c.start >= b - EPS) continue;
    splitDraft(d, c, b);
  }
  d.clips = d.clips.filter((c) => locked(d, c as Clip) || !(c.start >= a - EPS && clipEnd(c as Clip) <= b + EPS));
  if (!ripple) return;
  for (const c of d.clips) if (!locked(d, c as Clip) && c.start >= b - EPS) c.start = Math.max(0, c.start - len);
  d.markers = d.markers.filter((m) => m.time < a || m.time >= b).map((m) => (m.time >= b ? { ...m, time: m.time - len } : m));
  if (d.captions)
    d.captions = d.captions
      .filter((c) => c.end <= a || c.start >= b)
      .map((c) => (c.start >= b ? { ...c, start: c.start - len, end: c.end - len } : c));
}

/** Lift (;): remove In→Out, leave a gap. */
export function lift() {
  const p = get().project!;
  const r = ioRange(p);
  if (!r) return toast('Önce giriş (I) ve çıkış (O) noktası koy');
  edit((d) => removeRange(r[0], r[1], false, d));
  set({ selection: [] });
}
/** Extract ('): remove In→Out and close the gap. */
export function extract() {
  const p = get().project!;
  const r = ioRange(p);
  if (!r) return toast('Önce giriş (I) ve çıkış (O) noktası koy');
  edit((d) => {
    removeRange(r[0], r[1], true, d);
    d.inPoint = r[0];
    d.outPoint = undefined;
  });
  set({ selection: [], time: r[0] });
}

/* ------------------------------------------------------------ ripple trims */

/** The clip under the playhead on the top-most unlocked track (selection wins). */
function clipAtPlayhead(p: Project, t: number): Clip | undefined {
  const s = get();
  const sel = p.clips.find((c) => s.selection.includes(c.id) && c.start - EPS <= t && clipEnd(c) + EPS >= t);
  if (sel) return sel;
  for (const tr of p.tracks) {
    if (tr.locked) continue;
    const c = p.clips.find((x) => x.trackId === tr.id && x.start <= t + EPS && clipEnd(x) > t + EPS);
    if (c) return c;
  }
}

/** Q: trim the start of the clip under the playhead to the playhead and ripple left. W: trim the end and ripple. */
export function rippleTrim(edge: 'start' | 'end') {
  const p = get().project!;
  const t = get().time;
  const c = clipAtPlayhead(p, t);
  if (!c) return;
  if (t <= c.start + EPS || t >= clipEnd(c) - EPS) return;
  const removed = edge === 'start' ? t - c.start : clipEnd(c) - t;
  const end0 = clipEnd(c);
  edit((d) => {
    const x = d.clips.find((q) => q.id === c.id)!;
    if (edge === 'start') {
      if (isSourced(c)) x.in = c.in + removed * c.speed;
      else x.out = c.out - removed;
      x.fadeIn = Math.min(x.fadeIn, clipDur(x as Clip) / 2);
    } else {
      x.out = isSourced(c) ? c.in + (t - c.start) * c.speed : t - c.start;
    }
    // everything after on the same track (and linked audio) slides left
    for (const o of d.clips) if (o.id !== c.id && o.trackId === c.trackId && o.start >= end0 - EPS) o.start = Math.max(0, o.start - removed);
  });
  if (edge === 'start') set({ time: c.start });
}

/** Ctrl+K: cut every unlocked track at the playhead. */
export function addEditAll(t = get().time) {
  let n = 0;
  edit((d) => {
    for (const c of [...d.clips]) if (!locked(d, c as Clip) && splitDraft(d, c, t)) n++;
  });
  if (!n) toast('İmleçte kesilecek klip yok');
}

/* ------------------------------------------------------------ three-point editing */

export interface SourceMarks {
  mediaId: string;
  in: number;
  out: number;
}

/**
 * Insert (,) / overwrite (.) the source range at the timeline In (or the playhead).
 * Insert pushes everything at/after the edit point right on the target track(s); overwrite replaces.
 */
export function placeSource(m: MediaItem, src: { in: number; out: number }, mode: 'insert' | 'overwrite') {
  const p = get().project!;
  const at = p.inPoint ?? get().time;
  const len = Math.max(1 / p.fps, src.out - src.in);
  const kind: Clip['kind'] = m.type === 'image' ? 'image' : m.type === 'audio' ? 'audio' : 'video';
  const isAudio = kind === 'audio';
  const target = p.tracks.find((t) => !t.locked && t.type === (isAudio ? 'audio' : 'visual') && (isAudio || p.clips.some((c) => c.trackId === t.id))) || p.tracks.find((t) => !t.locked && t.type === (isAudio ? 'audio' : 'visual'));
  let newId = '';
  edit((d) => {
    const trId = target?.id || insertTrack(d, isAudio ? 'audio' : 'visual').id;
    if (mode === 'insert') {
      // split clips that straddle the edit point on every unlocked track, then push right
      for (const c of [...d.clips]) if (!locked(d, c as Clip)) splitDraft(d, c, at);
      for (const c of d.clips) if (!locked(d, c as Clip) && c.start >= at - EPS) c.start += len;
      for (const mk of d.markers) if (mk.time >= at) mk.time += len;
      if (d.captions) for (const cp of d.captions) if (cp.start >= at) (cp.start += len), (cp.end += len);
    } else {
      // overwrite only the target track
      for (const c of [...d.clips]) if (c.trackId === trId) splitDraft(d, c, at);
      for (const c of [...d.clips]) if (c.trackId === trId) splitDraft(d, c, at + len);
      d.clips = d.clips.filter((c) => !(c.trackId === trId && c.start >= at - EPS && clipEnd(c as Clip) <= at + len + EPS));
    }
    const c = clipFromMedia(m, trId, at);
    if (kind !== 'image') {
      c.in = src.in;
      c.out = src.out;
    } else c.out = len;
    newId = c.id;
    d.clips.push(c);
    d.inPoint = undefined;
    d.outPoint = undefined;
  });
  set({ selection: [newId], time: at + len });
  return newId;
}

/* ------------------------------------------------------------ range export */

/** A copy of the project containing only [a, b], shifted to start at 0 (for "export In→Out"). */
export function rangeProject(p: Project, a: number, b: number): Project {
  const d: Project = JSON.parse(JSON.stringify(p));
  const unlockAll = d.tracks.map((t) => t.locked);
  d.tracks.forEach((t) => (t.locked = false));
  removeRange(b, Math.max(b, projectDuration(d)) + 1, false, d as D);
  removeRange(0, a, true, d as D);
  d.tracks.forEach((t, i) => (t.locked = unlockAll[i]));
  d.inPoint = undefined;
  d.outPoint = undefined;
  return d;
}
