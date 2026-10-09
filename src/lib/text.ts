import type { TextStyle } from '../types';

export const FONTS: { family: string; weights: number[] }[] = [
  { family: 'Inter', weights: [400, 600, 700, 800, 900] },
  { family: 'Montserrat', weights: [400, 600, 700, 800, 900] },
  { family: 'Poppins', weights: [400, 600, 700, 800, 900] },
  { family: 'Bebas Neue', weights: [400] },
  { family: 'Anton', weights: [400] },
  { family: 'Oswald', weights: [400, 700] },
  { family: 'Playfair Display', weights: [400, 700, 900] },
  { family: 'Permanent Marker', weights: [400] },
];

export const WEIGHT_NAMES: Record<number, string> = { 400: 'Normal', 600: 'Yarı kalın', 700: 'Kalın', 800: 'Ekstra kalın', 900: 'Çok kalın' };

export const DEFAULT_TEXT: TextStyle = {
  content: 'Metin',
  font: 'Montserrat',
  size: 96,
  weight: 800,
  italic: false,
  color: '#ffffff',
  align: 'center',
  letterSpacing: 0,
  lineHeight: 1.15,
  uppercase: false,
  stroke: false,
  strokeColor: '#000000',
  strokeWidth: 6,
  shadow: true,
  shadowColor: '#000000',
  shadowBlur: 18,
  shadowOffset: 4,
  bg: false,
  bgColor: '#000000',
  bgOpacity: 0.6,
  bgPadding: 24,
  bgRadius: 14,
};

export interface TextPreset {
  id: string;
  name: string;
  hint: string;
  style: Partial<TextStyle>;
  /** position in project px relative to center, as fraction of height */
  y?: number;
  x?: number;
}

export const TEXT_PRESETS: TextPreset[] = [
  { id: 'title', name: 'Başlık', hint: 'Büyük, kalın', style: { content: 'BAŞLIK', font: 'Montserrat', weight: 900, size: 140, shadow: true } },
  { id: 'bebas', name: 'Vurucu', hint: 'Bebas Neue', style: { content: 'BU İNANILMAZ', font: 'Bebas Neue', weight: 400, size: 180, letterSpacing: 4, stroke: true, strokeWidth: 8, shadow: false } },
  { id: 'caption', name: 'Altyazı', hint: 'Alt kısım', y: 0.36, style: { content: 'Altyazı metni', font: 'Inter', weight: 700, size: 64, shadow: true, shadowBlur: 10 } },
  { id: 'boxed', name: 'Kutulu', hint: 'Arka planlı', y: 0.36, style: { content: 'Kutulu altyazı', font: 'Poppins', weight: 600, size: 58, shadow: false, bg: true, bgOpacity: 0.72 } },
  { id: 'lower', name: 'Alt bant', hint: 'İsim etiketi', x: -0.42, y: 0.3, style: { content: 'Adın Soyadın\nYouTube Kanalı', font: 'Inter', weight: 700, size: 52, align: 'left', shadow: false, bg: true, bgColor: '#111114', bgOpacity: 0.85, bgRadius: 10, bgPadding: 28 } },
  { id: 'sub', name: 'Abone ol', hint: 'Kırmızı rozet', y: 0.3, style: { content: 'ABONE OL', font: 'Montserrat', weight: 900, size: 64, letterSpacing: 2, shadow: false, bg: true, bgColor: '#ff0033', bgOpacity: 1, bgRadius: 12, bgPadding: 30 } },
  { id: 'yellow', name: 'Sarı vurgu', hint: 'Konturlu', style: { content: 'DİKKAT!', font: 'Anton', weight: 400, size: 160, color: '#ffe14d', stroke: true, strokeColor: '#000000', strokeWidth: 10, shadow: true, shadowBlur: 0, shadowOffset: 10 } },
  { id: 'elegant', name: 'Zarif', hint: 'Playfair', style: { content: 'Bölüm Bir', font: 'Playfair Display', weight: 700, italic: true, size: 120, shadow: true, shadowBlur: 24 } },
  { id: 'marker', name: 'El yazısı', hint: 'Marker', style: { content: 'vay be!', font: 'Permanent Marker', weight: 400, size: 120, color: '#ffffff', shadow: true } },
];

export const fontString = (s: TextStyle, k = 1) =>
  `${s.italic ? 'italic ' : ''}${s.weight} ${Math.max(1, s.size * k)}px "${s.font}"`;

let measureCtx: CanvasRenderingContext2D | null = null;
function mctx() {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')!;
  return measureCtx;
}

const linesOf = (s: TextStyle) => (s.uppercase ? s.content.toLocaleUpperCase('tr-TR') : s.content).split('\n');

/** Unscaled text box (project px), including background padding. */
export function measureText(s: TextStyle) {
  const ctx = mctx();
  ctx.font = fontString(s);
  (ctx as any).letterSpacing = `${s.letterSpacing}px`;
  const lines = linesOf(s);
  let w = 0;
  for (const l of lines) w = Math.max(w, ctx.measureText(l || ' ').width);
  const lh = s.size * s.lineHeight;
  const h = lh * lines.length;
  const pad = s.bg ? s.bgPadding : 0;
  const strokePad = s.stroke ? s.strokeWidth : 0;
  return { w: w + pad * 2 + strokePad, h: h + pad * 2 + strokePad, textW: w, lineH: lh, lines };
}

function hexToRgba(hex: string, a: number) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Draws text centered at origin in project units (caller applies transforms & scale). */
export function drawText(ctx: CanvasRenderingContext2D, s: TextStyle) {
  const m = measureText(s);
  ctx.save();
  if (s.bg) {
    ctx.fillStyle = hexToRgba(s.bgColor, s.bgOpacity);
    ctx.beginPath();
    const r = Math.min(s.bgRadius, m.w / 2, m.h / 2);
    (ctx as any).roundRect(-m.w / 2, -m.h / 2, m.w, m.h, r);
    ctx.fill();
  }
  ctx.font = fontString(s);
  (ctx as any).letterSpacing = `${s.letterSpacing}px`;
  ctx.textAlign = s.align;
  ctx.textBaseline = 'middle';
  const ax = s.align === 'left' ? -m.textW / 2 : s.align === 'right' ? m.textW / 2 : 0;
  const top = -(m.lineH * m.lines.length) / 2 + m.lineH / 2;
  // letterSpacing adds trailing space after the last glyph; compensate for centered/right alignment
  const lsFix = s.align === 'center' ? s.letterSpacing / 2 : s.align === 'right' ? s.letterSpacing : 0;
  const pass = (fn: (line: string, x: number, y: number) => void) =>
    m.lines.forEach((line, i) => fn(line, ax + lsFix, top + i * m.lineH));

  if (s.shadow) {
    ctx.save();
    ctx.shadowColor = hexToRgba(s.shadowColor, 0.85);
    ctx.shadowBlur = s.shadowBlur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = s.shadowOffset;
    ctx.fillStyle = s.color;
    if (s.stroke) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = s.strokeWidth * 2;
      ctx.strokeStyle = s.strokeColor;
      pass((l, x, y) => ctx.strokeText(l, x, y));
    } else pass((l, x, y) => ctx.fillText(l, x, y));
    ctx.restore();
  }
  if (s.stroke && s.strokeWidth > 0) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = s.strokeWidth * 2;
    ctx.strokeStyle = s.strokeColor;
    pass((l, x, y) => ctx.strokeText(l, x, y));
  }
  ctx.fillStyle = s.color;
  pass((l, x, y) => ctx.fillText(l, x, y));
  ctx.restore();
}

/** Make sure a font face is loaded before drawing. Resolves true when ready. */
const loaded = new Set<string>();
export function ensureFont(s: TextStyle): Promise<boolean> | true {
  const key = fontString(s, 1 / s.size * 40);
  if (loaded.has(key)) return true;
  return document.fonts
    .load(key, s.content || 'A')
    .then(() => {
      loaded.add(key);
      return true;
    })
    .catch(() => false);
}
