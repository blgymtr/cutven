import { edit, get, set, toast } from '../store';
import type { Clip, KeyProp, Project } from '../types';
import { clipDur, uid } from './util';
import { mediaOf } from './render';
import { measureText } from './text';
import { openProject, saveProject } from './project';

/* ------------------------------------------------------------ format change */

/** Multiply a property and its keyframes. */
function scaleProp(c: Clip, prop: KeyProp, k: number) {
  (c as any)[prop] = (c[prop] as number) * k;
  const keys = c.keys?.[prop];
  if (keys) c.keys = { ...c.keys, [prop]: keys.map((x) => ({ ...x, v: x.v * k })) };
}

/**
 * Re-lay a project for a new frame size: the old frame is fitted into the new one (factor k), so
 * positions, text sizes and their keyframes follow it. Video, image and colour clips are sized
 * relative to the frame already, only their offsets need scaling.
 */
export function reflowClips(clips: Clip[], k: number) {
  if (!isFinite(k) || k <= 0 || Math.abs(k - 1) < 1e-6) return;
  for (const c of clips) {
    if (c.kind === 'audio') continue;
    scaleProp(c, 'x', k);
    scaleProp(c, 'y', k);
    if (c.kind === 'text') scaleProp(c, 'scale', k);
  }
}

/** Change the project format (16:9, 9:16 …) keeping the layout proportional. */
export function setFormat(w: number, h: number) {
  const p = get().project;
  if (!p || (p.width === w && p.height === h)) return;
  const k = Math.min(w / p.width, h / p.height);
  edit((d) => {
    reflowClips(d.clips as Clip[], k);
    d.width = w;
    d.height = h;
  });
}

/** Split a video clip at detected scene changes. */
export async function splitAtScenes(id: string, threshold = 0.32) {
  const p = get().project;
  const c = p?.clips.find((x) => x.id === id);
  const m = c && p && mediaOf(p, c);
  if (!p || !c || !m || c.kind !== 'video') return;
  toast('Sahne değişimleri aranıyor…');
  const times = await window.cv.invoke<number[]>('media:scenes', m.path, c.in, c.out, threshold);
  // timeline positions, at least 0.4 s apart and away from the clip edges
  const cuts: number[] = [];
  for (const s of times) {
    const t = c.start + (s - c.in) / c.speed;
    if (t - c.start < 0.4 || c.start + clipDur(c) - t < 0.4) continue;
    if (cuts.length && t - cuts[cuts.length - 1] < 0.4) continue;
    cuts.push(t);
  }
  if (!cuts.length) {
    toast('Belirgin bir sahne değişimi bulunamadı');
    return;
  }
  const ids: string[] = [];
  edit((d) => {
    const base: Clip = JSON.parse(JSON.stringify(d.clips.find((x) => x.id === id)));
    d.clips = d.clips.filter((x) => x.id !== id);
    const edges = [base.start, ...cuts, base.start + (base.out - base.in) / base.speed];
    for (let i = 0; i < edges.length - 1; i++) {
      const n: Clip = { ...JSON.parse(JSON.stringify(base)), id: i ? uid() : base.id };
      n.start = edges[i];
      n.in = base.in + (edges[i] - base.start) * base.speed;
      n.out = base.in + (edges[i + 1] - base.start) * base.speed;
      if (i) n.fadeIn = 0;
      if (i < edges.length - 2) n.fadeOut = 0;
      d.clips.push(n);
      ids.push(n.id);
    }
  });
  set({ selection: ids });
  toast(`${cuts.length} sahne değişiminden bölündü`, 'success');
}

/** Save a 9:16 copy of the project for YouTube Shorts and open it. */
export async function convertToShorts() {
  const s = get();
  const p = s.project;
  if (!p) return;
  if (p.height > p.width) {
    toast('Proje zaten dikey');
    return;
  }
  await saveProject(true);
  const W = 1080;
  const H = 1920;
  const k = W / p.width; // horizontal content keeps its width
  const copy: Project = JSON.parse(JSON.stringify(p));
  copy.id = uid();
  copy.name = `${p.name} (Shorts)`;
  copy.width = W;
  copy.height = H;
  copy.thumbDesign = undefined;
  copy.yt = undefined;
  copy.lastExport = undefined;
  copy.createdAt = copy.updatedAt = Date.now();
  // positions, text sizes and keyframes follow the frame (the old frame fitted into the new one)
  reflowClips(copy.clips, k);
  for (const c of copy.clips) {
    if (c.kind === 'audio' || c.kind === 'color') continue;
    if (c.kind === 'text' && c.text) {
      // titles read better a bit bigger on phones, but must stay inside the width
      const tw = measureText(c.text).w;
      const widest = Math.max(c.scale, ...(c.keys?.scale || []).map((x) => x.v));
      const grow = Math.max(1, Math.min(1.5, tw > 0 ? (W * 0.9) / (tw * widest) : 1.5));
      if (grow > 1) scaleProp(c, 'scale', grow);
      continue;
    }
    const m = mediaOf(copy, c);
    const wide = m && m.width >= m.height;
    if (wide) {
      // keep the horizontal video readable in the middle and fill the bars with a blurred copy
      c.scale = Math.max(1, c.scale);
      if (!c.vfx?.some((v) => v.id === 'blurbg')) c.vfx = [{ id: 'blurbg', amount: 0.75 }, ...(c.vfx || [])];
    }
  }
  const path = await window.cv.invoke<string>('project:defaultPath', copy.name);
  await window.cv.invoke('project:write', path, JSON.stringify(copy));
  window.cv.invoke('project:remember', path);
  await openProject(path);
  toast('Shorts kopyası hazır (9:16). Uzun sahneleri kısaltmayı unutma — Shorts en fazla 3 dk.', 'success');
}
