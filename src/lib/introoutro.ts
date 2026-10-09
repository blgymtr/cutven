import type { Draft } from 'immer';
import { edit, get, set, toast } from '../store';
import type { Clip, MediaItem, Project, TextStyle } from '../types';
import { importPaths } from './media';
import { baseClip, clipFromMedia, insertTrack } from './actions';
import { DEFAULT_TEXT } from './text';
import { clipEnd, projectDuration } from './util';

export interface AppSettings {
  introPath?: string;
  outroPath?: string;
  brandColor?: string;
  channelName?: string;
}

export const loadSettings = () => window.cv.invoke<AppSettings>('settings:get');
export const saveSettings = (patch: Partial<AppSettings>) => window.cv.invoke<AppSettings>('settings:set', patch);

const mainTrack = (d: Draft<Project>) => {
  const v = d.tracks.filter((t) => t.type === 'visual');
  return v[v.length - 1] || insertTrack(d, 'visual');
};

function topTrack(d: Draft<Project>, start: number, end: number) {
  const vis = d.tracks.filter((t) => t.type === 'visual' && !t.locked);
  const main = vis[vis.length - 1];
  for (const t of vis) if (t.id !== main.id && !d.clips.some((c) => c.trackId === t.id && c.start < end && clipEnd(c as Clip) > start)) return t.id;
  return insertTrack(d, 'visual', vis[0]?.id).id;
}

/** Push everything (clips + markers) right by `dur` seconds. */
function ripple(d: Draft<Project>, dur: number) {
  for (const c of d.clips) c.start += dur;
  for (const m of d.markers) m.time += dur;
}

function text(content: string, patch: Partial<TextStyle>): TextStyle {
  return { ...DEFAULT_TEXT, content, ...patch };
}

/* ------------------------------------------------------------ media intro/outro */

export async function insertMedia(path: string, where: 'start' | 'end') {
  const [m] = await importPaths([path]);
  if (!m) return;
  placeMedia(m, where);
}

function placeMedia(m: MediaItem, where: 'start' | 'end') {
  let id = '';
  edit((d) => {
    const dur = m.type === 'image' ? 4 : m.duration;
    const end = projectDuration(d as Project);
    const tr = mainTrack(d);
    if (where === 'start') ripple(d, dur);
    const c = clipFromMedia(m, tr.id, where === 'start' ? 0 : end);
    if (m.type === 'image') c.out = 4;
    // a soft edge into / out of the video
    if (where === 'start') {
      c.tOut = 'fade';
      c.fadeOut = 0.4;
    } else {
      c.tIn = 'dissolve';
      c.fadeIn = 0.6;
    }
    id = c.id;
    d.clips.push(c);
  });
  set({ selection: [id], time: where === 'start' ? 0 : get().time });
  toast(where === 'start' ? 'Intro başa eklendi' : 'Outro sona eklendi', 'success');
}

/* ------------------------------------------------------------ templates */

export interface Template {
  id: string;
  name: string;
  hint: string;
  where: 'start' | 'end';
  dur: number;
  build: (d: Draft<Project>, t0: number, o: { color: string; channel: string; title: string }) => void;
}

const colorClip = (trackId: string, start: number, dur: number, fill: string) => {
  const c = baseClip('color', trackId, start, 0, dur);
  c.fill = fill;
  return c;
};

const textClip = (d: Draft<Project>, start: number, dur: number, style: TextStyle, x: number, y: number, tIn: Clip['tIn'], tOut: Clip['tOut']) => {
  const tr = topTrack(d, start, start + dur);
  const c = baseClip('text', tr, start, 0, dur);
  c.text = style;
  c.x = x;
  c.y = y;
  c.tIn = tIn;
  c.fadeIn = 0.5;
  c.tOut = tOut;
  c.fadeOut = 0.4;
  d.clips.push(c);
};

export const TEMPLATES: Template[] = [
  {
    id: 'title-card', name: 'Başlık kartı', hint: 'Renkli zemin + başlık, 3 sn', where: 'start', dur: 3,
    build: (d, t0, o) => {
      const tr = mainTrack(d);
      const bg = colorClip(tr.id, t0, 3, o.color);
      bg.tOut = 'fade';
      bg.fadeOut = 0.5;
      d.clips.push(bg);
      textClip(d, t0 + 0.2, 2.6, text(o.title, { font: 'Montserrat', weight: 900, size: Math.round(d.height * 0.11), shadow: false }), 0, -d.height * 0.03, 'zoom', 'fade');
      textClip(d, t0 + 0.6, 2.2, text(o.channel, { font: 'Inter', weight: 600, size: Math.round(d.height * 0.035), shadow: false, color: '#e8e8ee', letterSpacing: 4, uppercase: true }), 0, d.height * 0.09, 'slideU', 'fade');
    },
  },
  {
    id: 'minimal', name: 'Minimal', hint: 'Siyah zemin, yumuşak yazı, 2.5 sn', where: 'start', dur: 2.5,
    build: (d, t0, o) => {
      const tr = mainTrack(d);
      d.clips.push(colorClip(tr.id, t0, 2.5, '#000000'));
      textClip(d, t0 + 0.3, 2, text(o.title, { font: 'Playfair Display', weight: 700, italic: true, size: Math.round(d.height * 0.09), shadow: false }), 0, 0, 'blur', 'fade');
    },
  },
  {
    id: 'punch', name: 'Vurucu giriş', hint: 'Beyaz flaşla açılan büyük yazı, 2 sn', where: 'start', dur: 2,
    build: (d, t0, o) => {
      const tr = mainTrack(d);
      const bg = colorClip(tr.id, t0, 2, '#0b0b0d');
      bg.tOut = 'white';
      bg.fadeOut = 0.3;
      d.clips.push(bg);
      textClip(d, t0, 2, text(o.title.toLocaleUpperCase('tr-TR'), { font: 'Bebas Neue', weight: 400, size: Math.round(d.height * 0.2), stroke: true, strokeWidth: 6, color: o.color, shadow: false, letterSpacing: 6 }), 0, 0, 'white', 'zoom');
    },
  },
  {
    id: 'endscreen', name: 'Bitiş ekranı', hint: 'YouTube son ekranı için 20 sn yerleşim', where: 'end', dur: 20,
    build: (d, t0, o) => {
      const tr = mainTrack(d);
      const bg = colorClip(tr.id, t0, 20, '#0e0e12');
      bg.tIn = 'dissolve';
      bg.fadeIn = 0.8;
      d.clips.push(bg);
      const H = d.height;
      const W = d.width;
      textClip(d, t0 + 0.3, 19.7, text('İzlediğin için teşekkürler!', { font: 'Montserrat', weight: 800, size: Math.round(H * 0.06), shadow: false }), 0, -H * 0.36, 'slideD', 'fade');
      // placeholders where YouTube end-screen elements go (video boxes 16:9, subscribe circle)
      const box = (label: string, x: number) =>
        textClip(d, t0 + 0.6, 19.4, text(label, { font: 'Inter', weight: 600, size: Math.round(H * 0.028), shadow: false, bg: true, bgColor: '#ffffff', bgOpacity: 0.08, bgPadding: Math.round(H * 0.13), bgRadius: 18, color: '#9a9aa3' }), x, H * 0.02, 'fade', 'fade');
      box('Sonraki video', -W * 0.2);
      box('Önerilen video', W * 0.2);
      textClip(d, t0 + 1, 19, text('ABONE OL', { font: 'Montserrat', weight: 900, size: Math.round(H * 0.035), shadow: false, bg: true, bgColor: o.color, bgOpacity: 1, bgPadding: Math.round(H * 0.03), bgRadius: 999 }), 0, H * 0.34, 'zoom', 'fade');
    },
  },
  {
    id: 'thanks', name: 'Kısa kapanış', hint: 'Kanal adı + abone ol, 4 sn', where: 'end', dur: 4,
    build: (d, t0, o) => {
      const tr = mainTrack(d);
      const bg = colorClip(tr.id, t0, 4, o.color);
      bg.tIn = 'slideL';
      bg.fadeIn = 0.5;
      d.clips.push(bg);
      textClip(d, t0 + 0.4, 3.6, text(o.channel, { font: 'Montserrat', weight: 900, size: Math.round(d.height * 0.09), shadow: false }), 0, -d.height * 0.04, 'slideU', 'fade');
      textClip(d, t0 + 0.8, 3.2, text('Abone olmayı unutma', { font: 'Inter', weight: 600, size: Math.round(d.height * 0.035), shadow: false }), 0, d.height * 0.07, 'fade', 'fade');
    },
  },
];

export function insertTemplate(id: string, o: { color: string; channel: string; title: string }) {
  const tpl = TEMPLATES.find((t) => t.id === id);
  if (!tpl) return;
  edit((d) => {
    const t0 = tpl.where === 'start' ? 0 : projectDuration(d as Project);
    if (tpl.where === 'start') ripple(d, tpl.dur);
    tpl.build(d, t0, o);
  });
  set({ time: tpl.where === 'start' ? 0 : projectDuration(get().project!) - tpl.dur, selection: [] });
  toast(`${tpl.name} ${tpl.where === 'start' ? 'başa' : 'sona'} eklendi`, 'success');
}
