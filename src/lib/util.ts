import type { Clip, Project } from '../types';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export const clipDur = (c: Clip) => (c.out - c.in) / c.speed;
export const clipEnd = (c: Clip) => c.start + clipDur(c);

export const projectDuration = (p: Project) => p.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);

export const mediaUrl = (path: string) => 'cvm://media/' + encodeURIComponent(path);

export const basename = (p: string) => p.split(/[\\/]/).pop() || p;

const pad = (n: number, l = 2) => String(Math.floor(n)).padStart(l, '0');

/** hh:mm:ss:ff (hours omitted below 1h) */
export function formatTC(t: number, fps: number) {
  t = Math.max(0, t);
  const f = Math.floor((t % 1) * fps + 1e-6);
  const s = Math.floor(t) % 60;
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return (h ? pad(h) + ':' : '') + pad(m) + ':' + pad(s) + ':' + pad(Math.min(f, fps - 1));
}

/** YouTube chapter style: 0:00 / 1:02:03 */
export function formatChapter(t: number) {
  t = Math.floor(Math.max(0, t));
  const s = t % 60;
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatDuration(t: number) {
  t = Math.max(0, t);
  const s = Math.floor(t) % 60;
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function snapToFrame(t: number, fps: number) {
  return Math.round(t * fps) / fps;
}

export function fadeEnv(local: number, dur: number, fin: number, fout: number) {
  let a = 1;
  if (fin > 0 && local < fin) a = Math.min(a, local / fin);
  if (fout > 0 && local > dur - fout) a = Math.min(a, (dur - local) / fout);
  return clamp(a, 0, 1);
}

export function timeAgo(ts: number) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'az önce';
  if (d < 3600) return `${Math.floor(d / 60)} dk önce`;
  if (d < 86400) return `${Math.floor(d / 3600)} sa önce`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} gün önce`;
  return new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
}
