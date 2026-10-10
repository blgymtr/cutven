import { edit, get } from '../store';
import type { Caption, CaptionStyle, Project, TextStyle } from '../types';
import { DEFAULT_TEXT, drawText, ensureFont } from './text';
import { uid } from './util';
import { voiceRegions } from './keyframes';

/**
 * Caption track (subtitles): a list of timed lines drawn on top of everything.
 * Preview draws them with the same text renderer as text clips; export either burns them in
 * (one concat'ed PNG stream) or writes a sidecar .srt next to the video.
 */

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  font: 'Montserrat',
  size: 54,
  weight: 700,
  color: '#ffffff',
  bg: true,
  bgColor: '#000000',
  bgOpacity: 0.55,
  stroke: false,
  y: 0.86,
  burn: true,
  uppercase: false,
};

export const CAPTION_PRESETS: { name: string; s: Partial<CaptionStyle> }[] = [
  { name: 'Klasik', s: { font: 'Montserrat', weight: 700, bg: true, stroke: false, color: '#ffffff', uppercase: false, size: 54 } },
  { name: 'Shorts', s: { font: 'Montserrat', weight: 900, bg: false, stroke: true, color: '#ffffff', uppercase: true, size: 72, y: 0.7 } },
  { name: 'Sarı', s: { font: 'Poppins', weight: 800, bg: false, stroke: true, color: '#ffd43b', uppercase: false, size: 60 } },
  { name: 'Sinema', s: { font: 'Inter', weight: 500, bg: false, stroke: false, color: '#f4f4f4', uppercase: false, size: 46, y: 0.9 } },
];

export const styleOf = (p: Project): CaptionStyle => ({ ...DEFAULT_CAPTION_STYLE, ...(p.captionStyle || {}) });

/** wrap long lines at ~maxChars so captions stay on screen */
export function wrap(text: string, maxChars = 42) {
  return text
    .split('\n')
    .map((line) => {
      const words = line.split(/\s+/).filter(Boolean);
      const out: string[] = [];
      let cur = '';
      for (const w of words) {
        if (cur && (cur + ' ' + w).length > maxChars) {
          out.push(cur);
          cur = w;
        } else cur = cur ? cur + ' ' + w : w;
      }
      if (cur) out.push(cur);
      return out.join('\n');
    })
    .join('\n');
}

export function captionTextStyle(st: CaptionStyle, text: string, frameW: number): TextStyle {
  const maxChars = Math.max(16, Math.round((frameW * 0.86) / (st.size * 0.55)));
  return {
    ...DEFAULT_TEXT,
    content: wrap(text, maxChars),
    font: st.font,
    size: st.size,
    weight: st.weight,
    color: st.color,
    uppercase: st.uppercase,
    lineHeight: 1.2,
    stroke: st.stroke,
    strokeColor: '#000000',
    strokeWidth: Math.max(3, Math.round(st.size / 10)),
    shadow: !st.bg,
    shadowBlur: 10,
    shadowOffset: 3,
    bg: st.bg,
    bgColor: st.bgColor,
    bgOpacity: st.bgOpacity,
    bgPadding: Math.round(st.size * 0.35),
    bgRadius: Math.round(st.size * 0.2),
  };
}

export const activeCaption = (p: Project, t: number) => (p.captions || []).find((c) => t >= c.start && t < c.end);

/** Draw the caption at time t (ctx in canvas px, k = canvas px per project px). */
export function drawCaption(ctx: CanvasRenderingContext2D, p: Project, t: number, k: number) {
  const cap = activeCaption(p, t);
  if (!cap || !cap.text.trim()) return;
  const st = styleOf(p);
  const ts = captionTextStyle(st, cap.text, p.width);
  if (ensureFont(ts) !== true) return;
  ctx.save();
  ctx.setTransform(k, 0, 0, k, (p.width / 2) * k, p.height * st.y * k);
  drawText(ctx, ts);
  ctx.restore();
}

/* ------------------------------------------------------------ SRT / VTT */

const tc = (s: number, sep: ',' | '.') => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
};

export function toSrt(caps: Caption[]) {
  return [...caps]
    .sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${tc(c.start, ',')} --> ${tc(c.end, ',')}\n${c.text.trim()}\n`)
    .join('\n');
}

export function toVtt(caps: Caption[]) {
  return 'WEBVTT\n\n' + [...caps].sort((a, b) => a.start - b.start).map((c) => `${tc(c.start, '.')} --> ${tc(c.end, '.')}\n${c.text.trim()}\n`).join('\n');
}

const parseTc = (s: string) => {
  const m = s.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/);
  if (!m) return NaN;
  return (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0') / 1000;
};

/** Parses SRT and WebVTT (cue settings, tags and numbering are ignored). */
export function parseSubs(text: string): Caption[] {
  const out: Caption[] = [];
  const blocks = text.replace(/\r/g, '').replace(/^﻿/, '').split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->');
    const start = parseTc(a);
    const end = parseTc(z.split(/\s+/).filter(Boolean)[0] || '');
    if (isNaN(start) || isNaN(end) || end <= start) continue;
    const txt = lines
      .slice(i + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]+\}/g, '')
      .trim();
    if (txt) out.push({ id: uid(), start, end, text: txt });
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------ editing */

const sortCaps = (d: { captions?: Caption[] }) => d.captions?.sort((a, b) => a.start - b.start);

export function addCaption(t = get().time, text = 'Yeni altyazı') {
  const id = uid();
  edit((d) => {
    d.captions = d.captions || [];
    const next = d.captions.filter((c) => c.start > t).sort((a, b) => a.start - b.start)[0];
    const end = Math.min(t + 2.5, next ? next.start : t + 2.5);
    d.captions.push({ id, start: t, end: Math.max(t + 0.3, end), text });
    sortCaps(d);
  });
  return id;
}

export function updateCaption(id: string, patch: Partial<Caption>, key?: string) {
  edit(
    (d) => {
      const c = d.captions?.find((x) => x.id === id);
      if (!c) return;
      Object.assign(c, patch);
      if (c.end < c.start + 0.1) c.end = c.start + 0.1;
      sortCaps(d);
    },
    { key: key ? 'cap-' + key + id : undefined },
  );
}

export function deleteCaption(id: string) {
  edit((d) => void (d.captions = (d.captions || []).filter((c) => c.id !== id)));
}

export function setCaptionStyle(patch: Partial<CaptionStyle>, key = 'style') {
  edit((d) => void (d.captionStyle = { ...DEFAULT_CAPTION_STYLE, ...(d.captionStyle || {}), ...patch }), { key: 'capstyle-' + key });
}

export function replaceCaptions(caps: Caption[]) {
  edit((d) => void (d.captions = caps));
}

/** Split a caption at the playhead (text split at the middle word). */
export function splitCaption(id: string, t = get().time) {
  const c = get().project?.captions?.find((x) => x.id === id);
  if (!c || t <= c.start + 0.1 || t >= c.end - 0.1) return;
  const words = c.text.split(/\s+/);
  const cut = Math.max(1, Math.round(words.length * ((t - c.start) / (c.end - c.start))));
  edit((d) => {
    const x = d.captions!.find((q) => q.id === id)!;
    x.text = words.slice(0, cut).join(' ');
    const end = x.end;
    x.end = t;
    d.captions!.push({ id: uid(), start: t, end, text: words.slice(cut).join(' ') || '…' });
    sortCaps(d);
  });
}

/* ------------------------------------------------------------ script → timed captions */

/** Break a script into short caption phrases (sentence, then commas, then ~maxWords). */
export function phrases(script: string, maxWords = 8): string[] {
  const out: string[] = [];
  const sentences = script
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of sentences) {
    const parts = s.split(/(?<=[,;:])\s+/);
    let cur: string[] = [];
    const flush = () => {
      if (cur.length) out.push(cur.join(' '));
      cur = [];
    };
    for (const part of parts) {
      const w = part.split(' ');
      if (cur.length + w.length > maxWords && cur.length >= 3) flush();
      for (const word of w) {
        cur.push(word);
        if (cur.length >= maxWords) flush();
      }
      if (cur.length >= 4) flush();
    }
    flush();
  }
  return out;
}

const vowels = (s: string) => Math.max(1, (s.match(/[aeıioöuüâîûAEIİOÖUÜ]/g) || []).length);

/**
 * Lay the script over the detected speech: phrases are distributed across speech regions in order,
 * each region gets phrases proportional to its length, each phrase a duration proportional to its syllables.
 */
export function timeScript(script: string, regions: [number, number][], fallbackStart = 0, rate = 4.5): Caption[] {
  const ph = phrases(script);
  if (!ph.length) return [];
  const syl = ph.map(vowels);
  const total = syl.reduce((a, b) => a + b, 0);
  let regs = regions.filter(([a, b]) => b - a > 0.3);
  if (!regs.length) regs = [[fallbackStart, fallbackStart + total / rate]];
  const speech = regs.reduce((a, [s, e]) => a + (e - s), 0);
  const out: Caption[] = [];
  // walk syllables through the concatenated speech time
  let acc = 0;
  const at = (x: number) => {
    // x in [0, speech] → timeline time
    let rem = x;
    for (const [s, e] of regs) {
      if (rem <= e - s + 1e-9) return s + rem;
      rem -= e - s;
    }
    return regs[regs.length - 1][1];
  };
  for (let i = 0; i < ph.length; i++) {
    const a = (acc / total) * speech;
    acc += syl[i];
    const b = (acc / total) * speech;
    let st = at(a + 1e-6);
    let en = at(b);
    // a phrase that straddles a pause ends at the pause
    const reg = regs.find(([s, e]) => st >= s - 1e-6 && st <= e + 1e-6);
    if (reg && en > reg[1]) en = reg[1];
    if (en - st < 0.4) en = st + 0.4;
    out.push({ id: uid(), start: Math.round(st * 100) / 100, end: Math.round(en * 100) / 100, text: ph[i] });
  }
  for (let i = 0; i < out.length - 1; i++) if (out[i].end > out[i + 1].start) out[i].end = out[i + 1].start;
  return out;
}

export function captionsFromScript() {
  const p = get().project;
  if (!p?.script?.trim()) return 0;
  const caps = timeScript(p.script, voiceRegions(''), 0);
  replaceCaptions(caps);
  return caps.length;
}

/* ------------------------------------------------------------ export helpers */

/** Full-frame transparent PNGs for each caption + a concat list (one input for ffmpeg). */
export async function burnInput(p: Project, W: number, H: number, total: number): Promise<string | null> {
  const caps = (p.captions || []).filter((c) => c.text.trim() && c.start < total).sort((a, b) => a.start - b.start);
  if (!caps.length) return null;
  const st = styleOf(p);
  const k = W / p.width;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  const stamp = Date.now();
  const write = (name: string) => window.cv.invoke<string>('export:writeTemp', cv.toDataURL('image/png'), name);
  g.clearRect(0, 0, W, H);
  const blank = await write(`cap-blank-${stamp}.png`);
  const list: string[] = ['ffconcat version 1.0'];
  const q = (s: string) => `file '${s.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
  let t = 0;
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    const s = Math.max(t, c.start);
    const e = Math.min(total, c.end);
    if (e <= s) continue;
    if (s > t + 1e-4) list.push(q(blank), `duration ${(s - t).toFixed(4)}`);
    const ts = captionTextStyle(st, c.text, p.width);
    await ensureFont(ts);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.setTransform(k, 0, 0, k, (p.width / 2) * k, p.height * st.y * k);
    drawText(g, ts);
    list.push(q(await write(`cap-${i}-${stamp}.png`)), `duration ${(e - s).toFixed(4)}`);
    t = e;
  }
  if (t < total) list.push(q(blank), `duration ${(total - t).toFixed(4)}`);
  list.push(q(blank));
  const enc = new TextEncoder().encode(list.join('\n') + '\n');
  let bin = '';
  for (let i = 0; i < enc.length; i += 0x8000) bin += String.fromCharCode(...enc.subarray(i, i + 0x8000));
  return window.cv.invoke<string>('export:writeTemp', 'data:text/plain;base64,' + btoa(bin), `captions-${stamp}.ffconcat`);
}
