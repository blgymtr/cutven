import type { Draft } from 'immer';
import { edit, get, newTrack, set, toast } from '../store';
import type { Clip, MediaItem, Project, Track, TrackType } from '../types';
import { DEFAULT_COLOR } from './color';
import { DEFAULT_TEXT, TEXT_PRESETS, measureText } from './text';
import { clipDur, clipEnd, projectDuration, uid, formatChapter } from './util';
import { engine } from './engine';
import { shiftedKeys } from './vkeys';

type P = Project | Draft<Project>;
const EPS = 1e-4;

export function baseClip(kind: Clip['kind'], trackId: string, start: number, inPt: number, out: number): Clip {
  return {
    id: uid(), trackId, kind, start, in: inPt, out, speed: 1, volume: 1, muted: false, audioFadeIn: 0, audioFadeOut: 0,
    opacity: 1, x: 0, y: 0, scale: 1, rotation: 0, fadeIn: 0, fadeOut: 0, color: { ...DEFAULT_COLOR },
  };
}

export const trackTypeFor = (kind: Clip['kind']): TrackType => (kind === 'audio' ? 'audio' : 'visual');

export function hasRoom(p: P, trackId: string, start: number, end: number, ignore: string[] = []) {
  return !p.clips.some((c) => c.trackId === trackId && !ignore.includes(c.id) && c.start < end - EPS && clipEnd(c as Clip) > start + EPS);
}

function trackName(p: P, type: TrackType) {
  const n = p.tracks.filter((t) => t.type === type).length + 1;
  return type === 'audio' ? `Ses ${n}` : `Video ${n}`;
}

/** Insert a new track. Visual tracks go above `nearId` (or on top), audio tracks below `nearId` (or at the bottom). */
export function insertTrack(d: Draft<Project>, type: TrackType, nearId?: string): Track {
  const t = newTrack(type, trackName(d, type));
  const near = nearId ? d.tracks.findIndex((x) => x.id === nearId) : -1;
  if (type === 'visual') {
    const idx = near >= 0 && d.tracks[near].type === 'visual' ? near : 0;
    d.tracks.splice(idx, 0, t);
  } else {
    const idx = near >= 0 && d.tracks[near].type === 'audio' ? near + 1 : d.tracks.length;
    d.tracks.splice(idx, 0, t);
  }
  return t;
}

export function findTrackWithRoom(p: P, type: TrackType, start: number, end: number, prefer?: string): string | null {
  if (prefer) {
    const t = p.tracks.find((x) => x.id === prefer);
    if (t && t.type === type && !t.locked && hasRoom(p, t.id, start, end)) return t.id;
  }
  const list = p.tracks.filter((t) => t.type === type && !t.locked);
  // visual: prefer bottom-most (main) track; audio: top-most
  const ordered = type === 'visual' ? [...list].reverse() : list;
  for (const t of ordered) if (hasRoom(p, t.id, start, end)) return t.id;
  return null;
}

export function clipFromMedia(m: MediaItem, trackId: string, start: number): Clip {
  const kind: Clip['kind'] = m.type === 'image' ? 'image' : m.type === 'audio' ? 'audio' : 'video';
  const c = baseClip(kind, trackId, start, 0, m.type === 'image' ? 5 : m.duration);
  c.mediaId = m.id;
  return c;
}

/**
 * Place a media item on the timeline.
 * - with trackId+start: exact drop; if it overlaps, a new track is created next to the target
 * - without: video/image append to the main track, audio at playhead
 */
export function addMediaToTimeline(m: MediaItem, opts: { start?: number; trackId?: string; newTrack?: boolean } = {}) {
  let newId = '';
  edit((d) => {
    const kind: Clip['kind'] = m.type === 'image' ? 'image' : m.type === 'audio' ? 'audio' : 'video';
    const type = trackTypeFor(kind);
    const dur = m.type === 'image' ? 5 : m.duration;
    let start = opts.start;
    let trackId: string | null = null;
    if (opts.newTrack) {
      trackId = insertTrack(d, type, opts.trackId).id;
      start = Math.max(0, start ?? get().time);
    } else if (opts.trackId && start != null) {
      start = Math.max(0, start);
      const tr = d.tracks.find((t) => t.id === opts.trackId);
      if (tr && tr.type === type && !tr.locked && hasRoom(d, tr.id, start, start + dur)) trackId = tr.id;
      else trackId = insertTrack(d, type, tr && tr.type === type ? tr.id : undefined).id;
    } else if (type === 'visual') {
      const visual = d.tracks.filter((t) => t.type === 'visual');
      const main = visual[visual.length - 1];
      if (main && !main.locked) {
        trackId = main.id;
        start = d.clips.filter((c) => c.trackId === main.id).reduce((mx, c) => Math.max(mx, clipEnd(c as Clip)), 0);
      } else {
        start = get().time;
        trackId = findTrackWithRoom(d, type, start, start + dur) ?? insertTrack(d, type).id;
      }
    } else {
      start = get().time;
      trackId = findTrackWithRoom(d, type, start, start + dur) ?? insertTrack(d, type).id;
    }
    const c = clipFromMedia(m, trackId, start!);
    newId = c.id;
    d.clips.push(c);
  });
  if (newId) set({ selection: [newId] });
  return newId;
}

export function addText(presetId: string, at?: { start: number; trackId?: string }) {
  const preset = TEXT_PRESETS.find((p) => p.id === presetId) || TEXT_PRESETS[0];
  let id = '';
  edit((d) => {
    const start = Math.max(0, at?.start ?? get().time);
    const dur = 3;
    let trackId: string | null = null;
    if (at?.trackId) {
      const tr = d.tracks.find((t) => t.id === at.trackId);
      if (tr && tr.type === 'visual' && !tr.locked && hasRoom(d, tr.id, start, start + dur)) trackId = tr.id;
    }
    if (!trackId) {
      const vis = d.tracks.filter((t) => t.type === 'visual' && !t.locked);
      // text goes on top: use the top-most visual track that is not the main track if it has room
      for (const t of vis.slice(0, Math.max(0, vis.length - 1))) {
        if (hasRoom(d, t.id, start, start + dur)) {
          trackId = t.id;
          break;
        }
      }
    }
    if (!trackId) trackId = insertTrack(d, 'visual', d.tracks.find((t) => t.type === 'visual')?.id).id;
    const c = baseClip('text', trackId, start, 0, dur);
    c.text = { ...DEFAULT_TEXT, ...preset.style };
    c.y = (preset.y ?? 0) * d.height;
    if (preset.x) {
      // left-anchored lower third: box starts near the left edge
      c.x = -d.width / 2 + d.width * 0.05 + measureText(c.text).w / 2;
    }
    id = c.id;
    d.clips.push(c);
  });
  set({ selection: [id] });
  return id;
}

const lockedTrack = (p: P, c: Clip) => !!p.tracks.find((t) => t.id === c.trackId)?.locked;

export function splitAt(t = get().time) {
  const s = get();
  const p = s.project;
  if (!p) return;
  const fr = 1 / p.fps;
  let targets = p.clips.filter((c) => s.selection.includes(c.id) && c.start + fr <= t && clipEnd(c) - fr >= t);
  if (!targets.length) targets = p.clips.filter((c) => !lockedTrack(p, c) && c.start + fr <= t && clipEnd(c) - fr >= t);
  targets = targets.filter((c) => !lockedTrack(p, c));
  if (!targets.length) return;
  const newSel: string[] = [];
  edit((d) => {
    for (const tc of targets) {
      const c = d.clips.find((x) => x.id === tc.id)!;
      const cut = c.in + (t - c.start) * c.speed;
      const right: Clip = JSON.parse(JSON.stringify(c));
      right.id = uid();
      right.start = t;
      right.in = cut;
      right.fadeIn = 0;
      right.audioFadeIn = 0;
      c.out = cut;
      c.fadeOut = 0;
      c.audioFadeOut = 0;
      if (c.kind === 'text' || c.kind === 'image' || c.kind === 'color') {
        right.in = 0;
        right.out = tc.out - (t - tc.start);
        right.keys = shiftedKeys(right.keys, (t - tc.start) * tc.speed);
        c.out = t - c.start;
        c.in = 0;
      }
      d.clips.push(right);
      newSel.push(right.id);
    }
  });
  set({ selection: newSel });
}

export function deleteSelected(ripple = false) {
  const s = get();
  const p = s.project;
  if (!p || !s.selection.length) return;
  const del = p.clips.filter((c) => s.selection.includes(c.id) && !lockedTrack(p, c)).sort((a, b) => b.start - a.start);
  if (!del.length) return;
  edit((d) => {
    const ids = new Set(del.map((c) => c.id));
    d.clips = d.clips.filter((c) => !ids.has(c.id));
    if (ripple) {
      for (const c of del) {
        const dur = clipDur(c);
        for (const o of d.clips) if (o.trackId === c.trackId && o.start >= clipEnd(c) - EPS) o.start = Math.max(0, o.start - dur);
      }
    }
  });
  set({ selection: [] });
}

function cloneTo(d: Draft<Project>, src: Clip, start: number, prefTrack: string) {
  const c: Clip = JSON.parse(JSON.stringify(src));
  c.id = uid();
  c.start = Math.max(0, start);
  const type = trackTypeFor(c.kind);
  const end = c.start + clipDur(c);
  const tr = d.tracks.find((t) => t.id === prefTrack);
  if (tr && tr.type === type && !tr.locked && hasRoom(d, tr.id, c.start, end)) c.trackId = tr.id;
  else c.trackId = insertTrack(d, type, tr?.id).id;
  d.clips.push(c);
  return c.id;
}

export function duplicateSelected() {
  const s = get();
  const p = s.project;
  if (!p) return;
  const src = p.clips.filter((c) => s.selection.includes(c.id));
  if (!src.length) return;
  const ids: string[] = [];
  edit((d) => {
    for (const c of src) ids.push(cloneTo(d, c, clipEnd(c), c.trackId));
  });
  set({ selection: ids });
}

export function copySelected() {
  const s = get();
  const clips = s.project?.clips.filter((c) => s.selection.includes(c.id)) || [];
  if (clips.length) {
    set({ clipboard: JSON.parse(JSON.stringify(clips)) });
    toast(`${clips.length} klip kopyalandı`);
  }
}

export function paste() {
  const s = get();
  if (!s.project || !s.clipboard.length) return;
  const min = Math.min(...s.clipboard.map((c) => c.start));
  const ids: string[] = [];
  edit((d) => {
    for (const c of s.clipboard) {
      if (c.mediaId && !d.media.some((m) => m.id === c.mediaId)) continue;
      ids.push(cloneTo(d, c, s.time + (c.start - min), c.trackId));
    }
  });
  set({ selection: ids });
}

export function detachAudio(id: string) {
  const p = get().project;
  const c = p?.clips.find((x) => x.id === id);
  const m = c && p?.media.find((x) => x.id === c.mediaId);
  if (!p || !c || c.kind !== 'video' || !m?.hasAudio) return;
  let aid = '';
  edit((d) => {
    const vc = d.clips.find((x) => x.id === id)!;
    const end = clipEnd(vc as Clip);
    const trackId = findTrackWithRoom(d, 'audio', vc.start, end) ?? insertTrack(d, 'audio').id;
    const a: Clip = { ...JSON.parse(JSON.stringify(vc)), id: uid(), kind: 'audio', trackId, muted: false };
    vc.muted = true;
    aid = a.id;
    d.clips.push(a);
  });
  set({ selection: [aid] });
  toast('Ses ayrıldı');
}

export function updateClips(ids: string[], fn: (c: Draft<Clip>) => void, key?: string) {
  edit((d) => {
    for (const c of d.clips) if (ids.includes(c.id)) fn(c);
  }, { key });
}

export function addMarker(t = get().time) {
  const p = get().project;
  if (!p) return;
  if (p.markers.some((m) => Math.abs(m.time - t) < 0.05)) return;
  edit((d) => {
    d.markers.push({ id: uid(), time: t, label: `Bölüm ${d.markers.length + 1}` });
    d.markers.sort((a, b) => a.time - b.time);
  });
}

export function chaptersText(p: Project) {
  const ms = [...p.markers].sort((a, b) => a.time - b.time);
  const lines = ms.map((m) => `${formatChapter(m.time)} ${m.label}`);
  if (!ms.length || ms[0].time >= 1) lines.unshift('0:00 Giriş');
  return lines.join('\n');
}

export function deleteTrack(id: string) {
  edit((d) => {
    const t = d.tracks.find((x) => x.id === id);
    if (!t) return;
    if (d.tracks.filter((x) => x.type === t.type).length <= 1) {
      // keep at least one track of each type; just clear it
      d.clips = d.clips.filter((c) => c.trackId !== id);
      return;
    }
    d.tracks = d.tracks.filter((x) => x.id !== id);
    d.clips = d.clips.filter((c) => c.trackId !== id);
  });
}

export function seekRelative(dt: number) {
  engine.seek(get().time + dt);
}

export function jumpEdge(dir: 1 | -1) {
  const p = get().project;
  if (!p) return;
  const t = get().time;
  const edges = new Set<number>([0, projectDuration(p)]);
  for (const c of p.clips) {
    edges.add(c.start);
    edges.add(clipEnd(c));
  }
  for (const m of p.markers) edges.add(m.time);
  const sorted = [...edges].sort((a, b) => a - b);
  const next = dir > 0 ? sorted.find((e) => e > t + 1e-3) : [...sorted].reverse().find((e) => e < t - 1e-3);
  if (next != null) engine.seek(next);
}

/** Solid colour clip (backgrounds, title cards). */
export function addColor(fill = '#111114', at?: { start: number; trackId?: string }) {
  let id = '';
  edit((d) => {
    const start = Math.max(0, at?.start ?? get().time);
    const dur = 3;
    let trackId: string | null = null;
    if (at?.trackId) {
      const tr = d.tracks.find((t) => t.id === at.trackId);
      if (tr && tr.type === 'visual' && !tr.locked && hasRoom(d, tr.id, start, start + dur)) trackId = tr.id;
    }
    if (!trackId) trackId = findTrackWithRoom(d, 'visual', start, start + dur) ?? insertTrack(d, 'visual').id;
    const c = baseClip('color', trackId, start, 0, dur);
    c.fill = fill;
    id = c.id;
    d.clips.push(c);
  });
  set({ selection: [id] });
  return id;
}

/** Apply a transition to a clip edge (from the transitions panel / drag-drop). */
export function applyTransition(id: string, edge: 'in' | 'out', type: Clip['tIn']) {
  edit((d) => {
    const c = d.clips.find((x) => x.id === id);
    if (!c || c.kind === 'audio') return;
    const dur = (c.out - c.in) / c.speed;
    const def = type === 'dissolve' ? 0.8 : type === 'white' ? 0.35 : 0.5;
    if (edge === 'in') {
      c.tIn = type;
      c.fadeIn = Math.min(Math.max(c.fadeIn, def), type === 'dissolve' ? 3 : dur / 2);
    } else {
      c.tOut = type === 'dissolve' ? 'fade' : type;
      c.fadeOut = Math.min(Math.max(c.fadeOut, def), dur / 2);
    }
  });
}
