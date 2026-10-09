import type { ColorAdjust } from '../types';

/**
 * Color pipeline shared by the preview (SVG feColorMatrix) and export (ffmpeg lutrgb + colorchannelmixer):
 *   1) per-channel affine:  x' = clamp(D * x + E)
 *   2) channel mix:         x'' = clamp(C * x')
 * Both stages exist with identical semantics in SVG filters and ffmpeg, so preview == export.
 */

type Mat3 = number[]; // row-major 3x3

interface PresetDef {
  id: string;
  name: string;
  c?: number; // contrast multiplier
  b?: number; // brightness offset
  sat?: number;
  gains?: [number, number, number];
  m?: Mat3;
}

const SEPIA: Mat3 = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];
const I3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mix = (a: Mat3, b: Mat3, t: number): Mat3 => a.map((v, i) => v * (1 - t) + b[i] * t);

export const PRESETS: PresetDef[] = [
  { id: 'none', name: 'Orijinal' },
  { id: 'cinema', name: 'Sinematik', c: 1.12, sat: 0.82, b: -0.02, m: [1.06, -0.03, -0.03, -0.02, 1.0, 0.02, -0.04, 0.06, 0.98] },
  { id: 'warm', name: 'Sıcak', gains: [1.08, 1.02, 0.86], sat: 1.05 },
  { id: 'cool', name: 'Soğuk', gains: [0.9, 0.99, 1.1] },
  { id: 'vivid', name: 'Canlı', c: 1.1, sat: 1.4 },
  { id: 'fade', name: 'Mat', c: 0.82, b: 0.05, sat: 0.85 },
  { id: 'mono', name: 'S/B', c: 1.12, sat: 0 },
  { id: 'noir', name: 'Noir', c: 1.45, b: -0.04, sat: 0 },
  { id: 'sepia', name: 'Sepya', m: SEPIA },
  { id: 'vintage', name: 'Vintage', c: 0.9, b: 0.03, m: mix(I3, SEPIA, 0.35) },
  { id: 'moody', name: 'Gece', c: 1.18, b: -0.05, sat: 0.7, gains: [0.94, 1.0, 1.06] },
  { id: 'gold', name: 'Altın', gains: [1.1, 1.04, 0.84], c: 1.06, sat: 1.15 },
];

export const DEFAULT_COLOR: ColorAdjust = { preset: 'none', brightness: 0, contrast: 0, saturation: 0, temperature: 0, hue: 0 };

const LUMA = [0.2126, 0.7152, 0.0722];

function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

function satMat(s: number): Mat3 {
  const r: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push((1 - s) * LUMA[j] + (i === j ? s : 0));
  return r;
}

function hueMat(deg: number): Mat3 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
}

export interface ColorPipeline {
  D: [number, number, number];
  E: [number, number, number];
  C: Mat3;
}

export function colorPipeline(a: ColorAdjust | undefined): ColorPipeline | null {
  if (!a) return null;
  const p = PRESETS.find((x) => x.id === a.preset) || PRESETS[0];
  const c = (1 + (a.contrast / 100) * 0.8) * (p.c ?? 1);
  const bo = (a.brightness / 100) * 0.25 + (p.b ?? 0);
  const tg = (a.temperature / 100) * 0.12;
  const pg = p.gains ?? [1, 1, 1];
  const gains = [(1 + tg) * pg[0], pg[1], (1 - tg) * pg[2]];
  const D = gains.map((g) => c * g) as [number, number, number];
  const E = gains.map((g) => (0.5 * (1 - c) + bo) * g) as [number, number, number];
  const s = Math.max(0, (1 + a.saturation / 100) * (p.sat ?? 1));
  let C = mul(p.m ?? I3, mul(hueMat(a.hue), satMat(s)));
  const ident =
    D.every((v) => Math.abs(v - 1) < 1e-4) && E.every((v) => Math.abs(v) < 1e-4) && C.every((v, i) => Math.abs(v - I3[i]) < 1e-4);
  if (ident) return null;
  C = C.map((v) => Math.round(v * 1e5) / 1e5);
  return { D, E, C };
}

/* -------------------------------------------------- preview: SVG filters */

let svgRoot: SVGSVGElement | null = null;
const filterCache = new Map<string, string>();

function ensureSvg() {
  if (svgRoot) return svgRoot;
  svgRoot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgRoot.setAttribute('width', '0');
  svgRoot.setAttribute('height', '0');
  svgRoot.style.position = 'absolute';
  svgRoot.style.pointerEvents = 'none';
  document.body.appendChild(svgRoot);
  return svgRoot;
}

/** Returns a CSS/canvas filter string (url(#id)) for the adjustment, or 'none'. */
export function colorFilterCss(a: ColorAdjust | undefined): string {
  const pl = colorPipeline(a);
  if (!pl) return 'none';
  const f = (n: number) => n.toFixed(5);
  const v1 = `${f(pl.D[0])} 0 0 0 ${f(pl.E[0])} 0 ${f(pl.D[1])} 0 0 ${f(pl.E[1])} 0 0 ${f(pl.D[2])} 0 ${f(pl.E[2])} 0 0 0 1 0`;
  const C = pl.C;
  const v2 = `${f(C[0])} ${f(C[1])} ${f(C[2])} 0 0 ${f(C[3])} ${f(C[4])} ${f(C[5])} 0 0 ${f(C[6])} ${f(C[7])} ${f(C[8])} 0 0 0 0 0 1 0`;
  const key = v1 + '|' + v2;
  let id = filterCache.get(key);
  if (!id) {
    id = 'cvf' + filterCache.size;
    const svg = ensureSvg();
    const ns = 'http://www.w3.org/2000/svg';
    const filter = document.createElementNS(ns, 'filter');
    filter.setAttribute('id', id);
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    for (const vals of [v1, v2]) {
      const m = document.createElementNS(ns, 'feColorMatrix');
      m.setAttribute('type', 'matrix');
      m.setAttribute('values', vals);
      filter.appendChild(m);
    }
    svg.appendChild(filter);
    filterCache.set(key, id);
  }
  return `url(#${id})`;
}

/* -------------------------------------------------- export: ffmpeg filters */

export function colorFfmpeg(a: ColorAdjust | undefined, opacity: number): string[] {
  const pl = colorPipeline(a);
  const out: string[] = [];
  const f = (n: number) => n.toFixed(5);
  if (pl) {
    const ch = ['r', 'g', 'b'] as const;
    out.push('lutrgb=' + ch.map((c, i) => `${c}='clip(val*${f(pl.D[i])}+${f(pl.E[i] * 255)},0,255)'`).join(':'));
    const C = pl.C;
    out.push(
      `colorchannelmixer=rr=${f(C[0])}:rg=${f(C[1])}:rb=${f(C[2])}:gr=${f(C[3])}:gg=${f(C[4])}:gb=${f(C[5])}:br=${f(C[6])}:bg=${f(C[7])}:bb=${f(C[8])}:aa=${f(opacity)}`,
    );
  } else if (opacity < 0.999) {
    out.push(`colorchannelmixer=aa=${f(opacity)}`);
  }
  return out;
}
