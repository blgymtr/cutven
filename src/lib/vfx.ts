import type { Clip, Vfx } from '../types';
import { clamp } from './util';
import { fisheye } from './fxgl';

/**
 * Visual / lens effects. Every effect is defined here twice — preview (canvas) and
 * export (ffmpeg) — with the same formulas, so what you see is what you export.
 * a = amount (0..1); T = clip-local visual time; L = visual length; t = timeline time.
 */

export type VfxCat = 'Hareket' | 'Lens' | 'Retro' | 'Stil';

export interface VfxDef {
  id: string;
  name: string;
  cat: VfxCat;
  hint: string;
  def: number;
  /** only for opaque clips (video / image / colour) */
  opaqueOnly?: boolean;
  bpm?: boolean;
}

export const VFX: VfxDef[] = [
  { id: 'shake', name: 'Sallantı', cat: 'Hareket', hint: 'El kamerası titremesi', def: 0.5 },
  { id: 'impact', name: 'Darbe', cat: 'Hareket', hint: 'Başta yumruk gibi zoom + sarsıntı', def: 0.6 },
  { id: 'pulse', name: 'Nabız zoom', cat: 'Hareket', hint: 'Müziğin ritmine göre zoom', def: 0.5, bpm: true },
  { id: 'kenburns', name: 'Yaklaş', cat: 'Hareket', hint: 'Yavaşça yakınlaşma (Ken Burns)', def: 0.6 },
  { id: 'zoomout', name: 'Uzaklaş', cat: 'Hareket', hint: 'Yavaşça uzaklaşma', def: 0.6 },
  { id: 'pan', name: 'Kaydırma', cat: 'Hareket', hint: 'Soldan sağa yavaş kayma', def: 0.6 },
  { id: 'wobble', name: 'Salınım', cat: 'Hareket', hint: 'Hafif sağa-sola sallanma', def: 0.5 },
  { id: 'fisheye', name: 'Balık gözü', cat: 'Lens', hint: 'Geniş açı lens bükmesi', def: 0.5 },
  { id: 'rgbsplit', name: 'Renk kayması', cat: 'Lens', hint: 'Kromatik sapma (RGB split)', def: 0.5 },
  { id: 'glow', name: 'Parlama', cat: 'Lens', hint: 'Rüya gibi yumuşak ışıma', def: 0.5 },
  { id: 'leak', name: 'Işık sızıntısı', cat: 'Lens', hint: 'Sıcak film ışığı', def: 0.6 },
  { id: 'vignette', name: 'Vinyet', cat: 'Lens', hint: 'Kenarları karart', def: 0.6 },
  { id: 'blur', name: 'Bulanık', cat: 'Lens', hint: 'Yumuşak odak', def: 0.4 },
  { id: 'sharpen', name: 'Keskin', cat: 'Lens', hint: 'Detayları belirginleştir', def: 0.5 },
  { id: 'blurbg', name: 'Bulanık dolgu', cat: 'Lens', hint: 'Boş kenarları bulanık kopyayla doldur (Shorts)', def: 0.7, opaqueOnly: true },
  { id: 'glitch', name: 'Glitch', cat: 'Retro', hint: 'Dijital bozulma patlamaları', def: 0.6 },
  { id: 'vhs', name: 'VHS', cat: 'Retro', hint: 'Eski kaset: tarama çizgisi, renk kayması', def: 0.6 },
  { id: 'oldfilm', name: 'Eski film', cat: 'Retro', hint: 'Sepya, gren, titreşen ışık', def: 0.6, opaqueOnly: true },
  { id: 'grain', name: 'Film greni', cat: 'Retro', hint: 'Sinematik doku', def: 0.4 },
  { id: 'pixel', name: 'Piksel', cat: 'Retro', hint: 'Pikselleştir / sansür', def: 0.5 },
  { id: 'poster', name: 'Poster', cat: 'Retro', hint: 'Az renkli çizgi film görünümü', def: 0.5 },
  { id: 'letterbox', name: 'Sinema bandı', cat: 'Stil', hint: 'Üst-alt siyah bantlar (2.39:1)', def: 0.6 },
  { id: 'strobe', name: 'Flaş', cat: 'Stil', hint: 'Ritmik beyaz flaş', def: 0.5 },
  { id: 'invert', name: 'Negatif', cat: 'Stil', hint: 'Renkleri ters çevir', def: 1 },
  { id: 'mirror', name: 'Ayna', cat: 'Stil', hint: 'Sol yarıyı sağa yansıt', def: 1 },
  { id: 'quad', name: 'Dörtlü', cat: 'Stil', hint: '2×2 çoklu ekran', def: 1 },
  { id: 'fliph', name: 'Yatay çevir', cat: 'Stil', hint: 'Görüntüyü aynala', def: 1 },
  { id: 'flipv', name: 'Dikey çevir', cat: 'Stil', hint: 'Baş aşağı', def: 1 },
];

export const vfxDef = (id: string) => VFX.find((v) => v.id === id);
const fx = (c: Clip, id: string) => c.vfx?.find((v) => v.id === id);
const amt = (v: Vfx | undefined) => (v ? clamp(v.amount, 0, 1) : 0);
const r4 = (n: number) => (Math.round(n * 10000) / 10000).toString();

/* ------------------------------------------------------------ shared formulas */

const GL = { P: 1.1 };
const glitchDur = (a: number) => 0.06 + 0.12 * a;
const glitchOff = (a: number, k: number) => 0.04 * a * Math.sin(k * 12.9898 + 1);
const strobeP = (a: number) => 0.6 - 0.4 * a;
const STROBE_D = 0.06;

/** Geometry effects: offset (project px), zoom inside the clip frame, pan, rotation (deg). */
export function vfxMotion(c: Clip, T: number, t: number, L: number, W: number, H: number) {
  let dx = 0;
  let dy = 0;
  let zoom = 1;
  let pan = 0.5;
  let rot = 0;
  const shake = (a: number) => {
    dx += a * W * 0.012 * (Math.sin(23 * t) + 0.6 * Math.sin(37.7 * t + 1.3));
    dy += a * H * 0.012 * (Math.sin(29.3 * t + 0.7) + 0.5 * Math.sin(41.9 * t));
  };
  for (const v of c.vfx || []) {
    const a = amt(v);
    switch (v.id) {
      case 'shake':
        shake(a);
        zoom *= 1 + 0.035 * a;
        break;
      case 'impact':
        zoom *= 1 + 0.25 * a * Math.exp(-6 * T);
        shake(a * Math.exp(-4 * T));
        break;
      case 'pulse': {
        const f = (v.bpm || 120) / 60;
        zoom *= 1 + 0.08 * a * Math.pow(0.5 + 0.5 * Math.cos(2 * Math.PI * T * f), 6);
        break;
      }
      case 'kenburns':
        zoom *= 1 + 0.18 * a * clamp(T / L, 0, 1);
        break;
      case 'zoomout':
        zoom *= 1 + 0.18 * a * (1 - clamp(T / L, 0, 1));
        break;
      case 'pan':
        zoom *= 1 + 0.15 * a;
        pan = clamp(T / L, 0, 1);
        break;
      case 'wobble':
        rot += 3 * a * Math.sin(2 * Math.PI * 0.8 * T);
        break;
    }
  }
  return { dx, dy, zoom, pan, rot };
}

/** ffmpeg counterparts of vfxMotion. `it` = zoompan input time, `T` = clip-local time, `t` = timeline time. */
export function vfxMotionFf(c: Clip, L: number, W: number, H: number, vs: number) {
  const zooms: string[] = [];
  let pan: string | null = null;
  const rots: string[] = [];
  let dx = '';
  let dy = '';
  const shakeTerms = (a: string) => {
    dx += `+(${a})*${r4(W * 0.012)}*(sin(23*t)+0.6*sin(37.7*t+1.3))`;
    dy += `+(${a})*${r4(H * 0.012)}*(sin(29.3*t+0.7)+0.5*sin(41.9*t))`;
  };
  for (const v of c.vfx || []) {
    const a = amt(v);
    switch (v.id) {
      case 'shake':
        shakeTerms(r4(a));
        zooms.push(r4(1 + 0.035 * a));
        break;
      case 'impact':
        zooms.push(`(1+${r4(0.25 * a)}*exp(-6*it))`);
        shakeTerms(`${r4(a)}*exp(-4*(t-${r4(vs)}))`);
        break;
      case 'pulse': {
        const f = (v.bpm || 120) / 60;
        zooms.push(`(1+${r4(0.08 * a)}*pow(0.5+0.5*cos(${r4(2 * Math.PI * f)}*it),6))`);
        break;
      }
      case 'kenburns':
        zooms.push(`(1+${r4(0.18 * a)}*clip(it/${r4(L)},0,1))`);
        break;
      case 'zoomout':
        zooms.push(`(1+${r4(0.18 * a)}*(1-clip(it/${r4(L)},0,1)))`);
        break;
      case 'pan':
        zooms.push(r4(1 + 0.15 * a));
        pan = `clip(it/${r4(L)},0,1)`;
        break;
      case 'wobble':
        rots.push(`${r4((3 * a * Math.PI) / 180)}*sin(${r4(2 * Math.PI * 0.8)}*t)`);
        break;
    }
  }
  return { zoom: zooms.length ? zooms.join('*') : null, pan, rot: rots.length ? rots.join('+') : null, dx, dy };
}

/* ------------------------------------------------------------ masks (identical PNGs for preview + export) */

const maskCache = new Map<string, HTMLCanvasElement>();
function mask(kind: 'vignette' | 'scan' | 'leak', w: number, h: number, a: number) {
  const key = `${kind}|${w}|${h}|${a.toFixed(3)}`;
  let cv = maskCache.get(key);
  if (cv) return cv;
  cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d')!;
  if (kind === 'vignette') {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    const rad = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) / 2);
    rad.addColorStop(0, 'rgba(0,0,0,0)');
    rad.addColorStop(1, `rgba(0,0,0,${0.9 * a})`);
    g.fillStyle = rad;
    g.fillRect(0, 0, w, h);
  } else if (kind === 'scan') {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    const step = Math.max(2, Math.round(h / 240));
    g.fillStyle = `rgba(0,0,0,${0.35 * a})`;
    for (let y = 0; y < h; y += step * 2) g.fillRect(0, y, w, step);
  } else {
    const blob = (x: number, y: number, r: number, col: string) => {
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, col);
      gr.addColorStop(1, 'rgba(255,120,40,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, w, h);
    };
    blob(w * 0.05, h * 0.1, Math.max(w, h) * 0.55, `rgba(255,140,50,${0.55 * a})`);
    blob(w * 0.95, h * 0.85, Math.max(w, h) * 0.45, `rgba(255,70,90,${0.4 * a})`);
    blob(w * 0.7, h * 0.05, Math.max(w, h) * 0.3, `rgba(255,220,120,${0.35 * a})`);
  }
  maskCache.set(key, cv);
  if (maskCache.size > 40) maskCache.delete(maskCache.keys().next().value!);
  return cv;
}

export async function maskPng(kind: 'vignette' | 'scan' | 'leak', w: number, h: number, a: number): Promise<string> {
  return window.cv.invoke<string>('export:writeTemp', mask(kind, w, h, a).toDataURL('image/png'), `mask-${kind}-${w}x${h}-${Math.round(a * 1000)}.png`);
}

/* ------------------------------------------------------------ preview pipeline */

const pool = new Map<string, HTMLCanvasElement>();
function canvas(name: string, w: number, h: number) {
  let cv = pool.get(name);
  if (!cv) {
    cv = document.createElement('canvas');
    pool.set(name, cv);
  }
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  } else cv.getContext('2d')!.clearRect(0, 0, w, h);
  return cv;
}

let svg: SVGSVGElement | null = null;
const svgFilters = new Set<string>();
function svgFilter(id: string, build: (ns: string, f: SVGFilterElement) => void) {
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    document.body.appendChild(svg);
  }
  if (!svgFilters.has(id)) {
    const ns = 'http://www.w3.org/2000/svg';
    const f = document.createElementNS(ns, 'filter') as SVGFilterElement;
    f.setAttribute('id', id);
    f.setAttribute('color-interpolation-filters', 'sRGB');
    build(ns, f);
    svg.appendChild(f);
    svgFilters.add(id);
  }
  return `url(#${id})`;
}
const channelOnly = (ch: 0 | 1 | 2) =>
  svgFilter('vfx-ch' + ch, (ns, f) => {
    const m = document.createElementNS(ns, 'feColorMatrix');
    m.setAttribute('type', 'matrix');
    const rows = [0, 1, 2].map((i) => (i === ch ? (i === 0 ? '1 0 0 0 0' : i === 1 ? '0 1 0 0 0' : '0 0 1 0 0') : '0 0 0 0 0'));
    m.setAttribute('values', `${rows.join(' ')} 0 0 0 1 0`);
    f.appendChild(m);
  });
const posterFilter = (L: number) =>
  svgFilter('vfx-post' + L, (ns, f) => {
    const t = document.createElementNS(ns, 'feComponentTransfer');
    const vals = Array.from({ length: L }, (_, i) => (i / (L - 1)).toFixed(4)).join(' ');
    for (const ch of ['feFuncR', 'feFuncG', 'feFuncB']) {
      const fn = document.createElementNS(ns, ch);
      fn.setAttribute('type', 'discrete');
      fn.setAttribute('tableValues', vals);
      t.appendChild(fn);
    }
    f.appendChild(t);
  });
const sharpFilter = (k: number) =>
  svgFilter('vfx-sharp' + Math.round(k * 100), (ns, f) => {
    const m = document.createElementNS(ns, 'feConvolveMatrix');
    m.setAttribute('order', '3');
    m.setAttribute('kernelMatrix', `0 ${-k} 0 ${-k} ${1 + 4 * k} ${-k} 0 ${-k} 0`);
    m.setAttribute('preserveAlpha', 'true');
    f.appendChild(m);
  });
const matrixFilter = (id: string, vals: string) =>
  svgFilter(id, (ns, f) => {
    const m = document.createElementNS(ns, 'feColorMatrix');
    m.setAttribute('type', 'matrix');
    m.setAttribute('values', vals);
    f.appendChild(m);
  });

const SEPIA = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];
function mixMat(a: number, m: number[]) {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return I.map((v, i) => v * (1 - a) + m[i] * a);
}
function satMat(s: number) {
  const Lm = [0.2126, 0.7152, 0.0722];
  const r: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push((1 - s) * Lm[j] + (i === j ? s : 0));
  return r;
}
const matVals = (m: number[]) => `${m[0]} ${m[1]} ${m[2]} 0 0 ${m[3]} ${m[4]} ${m[5]} 0 0 ${m[6]} ${m[7]} ${m[8]} 0 0 0 0 0 1 0`;

let noiseTiles: HTMLCanvasElement[] = [];
function noiseTile(frame: number) {
  if (!noiseTiles.length) {
    noiseTiles = Array.from({ length: 6 }, () => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 256;
      const g = cv.getContext('2d')!;
      const d = g.createImageData(256, 256);
      for (let i = 0; i < d.data.length; i += 4) {
        const v = Math.random() * 255;
        d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
        d.data[i + 3] = 255;
      }
      g.putImageData(d, 0, 0);
      return cv;
    });
  }
  return noiseTiles[frame % noiseTiles.length];
}

export const hasPixelVfx = (c: Clip) => (c.vfx || []).some((v) => !['shake', 'impact', 'pulse', 'kenburns', 'zoomout', 'pan', 'wobble', 'blurbg'].includes(v.id));

/**
 * Apply pixel effects to the clip image `src` (already sized to the clip box in canvas px).
 * T = clip-local visual time, fps used for grain animation.
 */
export function vfxPixels(c: Clip, src: HTMLCanvasElement, T: number, fps: number): HTMLCanvasElement {
  let cur = src;
  const w = src.width;
  const h = src.height;
  const opaque = c.kind !== 'text';
  let step = 0;
  const next = () => canvas('vfx' + step++, w, h);
  const filt = (f: string) => {
    const o = next();
    const g = o.getContext('2d')!;
    g.filter = f;
    g.drawImage(cur, 0, 0);
    cur = o;
  };
  const shift = (d: number) => {
    if (Math.abs(d) < 0.5) return;
    const o = next();
    const g = o.getContext('2d')!;
    g.globalCompositeOperation = 'lighter';
    g.filter = channelOnly(0);
    g.drawImage(cur, -d, 0);
    g.filter = channelOnly(1);
    g.drawImage(cur, 0, 0);
    g.filter = channelOnly(2);
    g.drawImage(cur, d, 0);
    cur = o;
  };
  const overlayMask = (m: HTMLCanvasElement, mode: GlobalCompositeOperation) => {
    const o = next();
    const g = o.getContext('2d')!;
    g.drawImage(cur, 0, 0);
    g.globalCompositeOperation = mode;
    g.drawImage(m, 0, 0, w, h);
    // keep the clip's own transparency
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(cur, 0, 0);
    cur = o;
  };
  const grain = (a: number) => {
    const o = next();
    const g = o.getContext('2d')!;
    g.drawImage(cur, 0, 0);
    g.globalCompositeOperation = 'overlay';
    g.globalAlpha = Math.min(1, a * 0.9);
    const tile = noiseTile(Math.floor(T * fps));
    for (let y = 0; y < h; y += 256) for (let x = 0; x < w; x += 256) g.drawImage(tile, x, y);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(cur, 0, 0);
    cur = o;
  };

  for (const v of c.vfx || []) {
    const a = amt(v);
    switch (v.id) {
      case 'invert':
        filt(`invert(${a})`);
        break;
      case 'poster':
        filt(posterFilter(Math.round(2 + 10 * (1 - a))));
        break;
      case 'blur':
        filt(`blur(${(0.012 * a * w).toFixed(2)}px)`);
        break;
      case 'sharpen':
        filt(sharpFilter(Math.round(a * 0.5 * 100) / 100));
        break;
      case 'pixel': {
        const B = Math.max(2, Math.round(w * (0.01 + 0.05 * a)));
        const sw = Math.max(1, Math.round(w / B));
        const sh = Math.max(1, Math.round(h / B));
        const small = canvas('vfx-small', sw, sh);
        small.getContext('2d')!.drawImage(cur, 0, 0, sw, sh);
        const o = next();
        const g = o.getContext('2d')!;
        g.imageSmoothingEnabled = false;
        g.drawImage(small, 0, 0, w, h);
        cur = o;
        break;
      }
      case 'rgbsplit':
        shift(Math.round(0.008 * a * w));
        break;
      case 'vhs':
        shift(Math.round(0.004 * a * w));
        filt(matrixFilter('vfx-vhs' + Math.round(a * 100), matVals(satMat(1 - 0.3 * a))));
        overlayMask(mask('scan', w, h, a), 'multiply');
        grain(0.35 * a);
        break;
      case 'oldfilm': {
        filt(matrixFilter('vfx-old' + Math.round(a * 100), matVals(mixMat(a, SEPIA))));
        grain(0.5 * a);
        overlayMask(mask('vignette', w, h, 0.6 * a), 'multiply');
        if (opaque) {
          const b = 0.06 * a * Math.sin(T * 31) * Math.sin(T * 7.3);
          const o = next();
          const g = o.getContext('2d')!;
          g.drawImage(cur, 0, 0);
          g.globalCompositeOperation = b > 0 ? 'lighter' : 'source-atop';
          g.fillStyle = b > 0 ? `rgba(255,255,255,${b})` : `rgba(0,0,0,${-b})`;
          g.fillRect(0, 0, w, h);
          cur = o;
        }
        break;
      }
      case 'grain':
        grain(a);
        break;
      case 'vignette':
        overlayMask(mask('vignette', w, h, a), 'multiply');
        break;
      case 'leak': {
        const o = next();
        const g = o.getContext('2d')!;
        g.drawImage(cur, 0, 0);
        g.drawImage(mask('leak', w, h, a), 0, 0);
        cur = o;
        break;
      }
      case 'glow': {
        const o = next();
        const g = o.getContext('2d')!;
        g.drawImage(cur, 0, 0);
        g.globalCompositeOperation = 'screen';
        g.globalAlpha = a;
        g.filter = `blur(${(0.02 * w).toFixed(2)}px)`;
        g.drawImage(cur, 0, 0);
        cur = o;
        break;
      }
      case 'fisheye': {
        const out = fisheye(cur, 0.6 * a, 0.25 * a);
        const o = next();
        o.getContext('2d')!.drawImage(out, 0, 0);
        cur = o;
        break;
      }
      case 'glitch': {
        const k = Math.floor((T + 0.001) / GL.P);
        if (T + 0.001 - k * GL.P < glitchDur(a)) {
          const base = cur;
          shift(Math.round(0.03 * a * w));
          const o = next();
          const g = o.getContext('2d')!;
          g.drawImage(base, 0, 0);
          g.drawImage(cur, Math.round(glitchOff(a, k) * w), 0);
          cur = o;
        }
        break;
      }
      case 'mirror': {
        const o = next();
        const g = o.getContext('2d')!;
        const hw = Math.floor(w / 2);
        g.drawImage(cur, 0, 0, hw, h, 0, 0, hw, h);
        g.translate(w, 0);
        g.scale(-1, 1);
        g.drawImage(cur, 0, 0, hw, h, 0, 0, hw, h);
        cur = o;
        break;
      }
      case 'quad': {
        const o = next();
        const g = o.getContext('2d')!;
        const hw = Math.floor(w / 2);
        const hh = Math.floor(h / 2);
        for (const [x, y] of [[0, 0], [hw, 0], [0, hh], [hw, hh]]) g.drawImage(cur, x, y, hw, hh);
        cur = o;
        break;
      }
      case 'fliph':
      case 'flipv': {
        const o = next();
        const g = o.getContext('2d')!;
        if (v.id === 'fliph') {
          g.translate(w, 0);
          g.scale(-1, 1);
        } else {
          g.translate(0, h);
          g.scale(1, -1);
        }
        g.drawImage(cur, 0, 0);
        cur = o;
        break;
      }
      case 'letterbox': {
        const ratio = 1.85 + 0.9 * a;
        const bar = Math.round((h - w / ratio) / 2);
        if (bar > 0) {
          const o = next();
          const g = o.getContext('2d')!;
          g.drawImage(cur, 0, 0);
          g.fillStyle = '#000';
          g.fillRect(0, 0, w, bar);
          g.fillRect(0, h - bar, w, bar);
          cur = o;
        }
        break;
      }
      case 'strobe': {
        const P = strobeP(a);
        const Tq = T + 0.001;
        if (Tq - Math.floor(Tq / P) * P < STROBE_D) {
          const o = next();
          const g = o.getContext('2d')!;
          g.drawImage(cur, 0, 0);
          g.globalCompositeOperation = 'source-atop';
          g.fillStyle = 'rgba(255,255,255,0.85)';
          g.fillRect(0, 0, w, h);
          cur = o;
        }
        break;
      }
    }
  }
  return cur;
}

/* ------------------------------------------------------------ export pipeline */

export interface FfCtx {
  lines: string[];
  label: () => string;
  addInput: (args: string[]) => number;
  fps: number;
  L: number;
}

/** Push filter lines applying the pixel effects to stream `inp` (w×h, rgba); returns the output label. */
export async function vfxFfmpeg(c: Clip, inp: string, w: number, h: number, ctx: FfCtx): Promise<string> {
  let cur = inp;
  const opaque = c.kind !== 'text';
  const chain = (f: string) => {
    const o = ctx.label();
    ctx.lines.push(`[${cur}]${f}[${o}]`);
    cur = o;
  };
  const shift = (d: number) => {
    if (Math.abs(d) >= 1) chain(`rgbashift=rh=${-d}:bh=${d}`);
  };
  const withMask = async (kind: 'vignette' | 'scan' | 'leak', a: number, mode: 'multiply' | 'over') => {
    const png = await maskPng(kind, w, h, a);
    const i = ctx.addInput(['-loop', '1', '-framerate', String(ctx.fps), '-t', r4(ctx.L), '-i', png]);
    const m = ctx.label();
    ctx.lines.push(`[${i}:v]format=rgba[${m}]`);
    const o = ctx.label();
    if (mode === 'multiply') ctx.lines.push(`[${cur}][${m}]blend=all_mode=multiply:shortest=1,format=rgba[${o}]`);
    else ctx.lines.push(`[${cur}][${m}]overlay=0:0:format=rgb:shortest=1[${o}]`);
    cur = o;
  };
  const grain = (a: number) => {
    const s = Math.round(55 * a);
    if (s > 0) chain(`noise=c0s=${s}:c1s=${s}:c2s=${s}:allf=t+u,format=rgba`);
  };
  const matrix = (m: number[]) =>
    chain(`colorchannelmixer=rr=${r4(m[0])}:rg=${r4(m[1])}:rb=${r4(m[2])}:gr=${r4(m[3])}:gg=${r4(m[4])}:gb=${r4(m[5])}:br=${r4(m[6])}:bg=${r4(m[7])}:bb=${r4(m[8])}`);

  for (const v of c.vfx || []) {
    const a = amt(v);
    switch (v.id) {
      case 'invert':
        chain(['r', 'g', 'b'].map((ch) => `${ch}='val*${r4(1 - a)}+(255-val)*${r4(a)}'`).join(':').replace(/^/, 'lutrgb='));
        break;
      case 'poster': {
        const L = Math.round(2 + 10 * (1 - a));
        chain('lutrgb=' + ['r', 'g', 'b'].map((ch) => `${ch}='min(${L - 1},floor(val*${L}/256))*${r4(255 / (L - 1))}'`).join(':'));
        break;
      }
      case 'blur':
        chain(`gblur=sigma=${r4(Math.max(0.1, 0.012 * a * w))}`);
        break;
      case 'sharpen':
        chain(`unsharp=3:3:${r4(Math.round(a * 0.5 * 100) / 100 * 4)}:3:3:0`);
        break;
      case 'pixel': {
        const B = Math.max(2, Math.round(w * (0.01 + 0.05 * a)));
        chain(`scale=${Math.max(1, Math.round(w / B))}:${Math.max(1, Math.round(h / B))}:flags=area,scale=${w}:${h}:flags=neighbor`);
        break;
      }
      case 'rgbsplit':
        shift(Math.round(0.008 * a * w));
        break;
      case 'vhs':
        shift(Math.round(0.004 * a * w));
        matrix(satMat(1 - 0.3 * a));
        await withMask('scan', a, 'multiply');
        grain(0.35 * a);
        break;
      case 'oldfilm':
        matrix(mixMat(a, SEPIA));
        grain(0.5 * a);
        await withMask('vignette', 0.6 * a, 'multiply');
        if (opaque) chain(`eq=brightness='${r4(0.06 * a)}*sin(t*31)*sin(t*7.3)':eval=frame,format=rgba`);
        break;
      case 'grain':
        grain(a);
        break;
      case 'vignette':
        await withMask('vignette', a, 'multiply');
        break;
      case 'leak':
        await withMask('leak', a, 'over');
        break;
      case 'glow': {
        const s = ctx.label();
        const b = ctx.label();
        const g = ctx.label();
        const o = ctx.label();
        ctx.lines.push(`[${cur}]split[${s}][${b}]`);
        ctx.lines.push(`[${b}]gblur=sigma=${r4(0.02 * w)}[${g}]`);
        ctx.lines.push(`[${s}][${g}]blend=all_mode=screen:all_opacity=${r4(a)},format=rgba[${o}]`);
        cur = o;
        break;
      }
      case 'fisheye':
        chain(`lenscorrection=k1=${r4(0.6 * a)}:k2=${r4(0.25 * a)}:i=bilinear,format=rgba`);
        break;
      case 'glitch': {
        const n = ctx.label();
        const g = ctx.label();
        const gg = ctx.label();
        const o = ctx.label();
        const d = Math.max(1, Math.round(0.03 * a * w));
        ctx.lines.push(`[${cur}]split[${n}][${g}]`);
        ctx.lines.push(`[${g}]rgbashift=rh=${-d}:bh=${d}[${gg}]`);
        const off = `${r4(0.04 * a * w)}*sin(floor((t+0.001)/${GL.P})*12.9898+1)`;
        ctx.lines.push(`[${n}][${gg}]overlay=x='round(${off})':y=0:eval=frame:format=rgb:enable='lt(mod(t+0.001,${GL.P}),${r4(glitchDur(a))})'[${o}]`);
        cur = o;
        break;
      }
      case 'mirror': {
        const hw = Math.floor(w / 2);
        const l = ctx.label();
        const r = ctx.label();
        const rf = ctx.label();
        const o = ctx.label();
        ctx.lines.push(`[${cur}]split[${l}][${r}]`);
        ctx.lines.push(`[${r}]crop=${hw}:${h}:0:0,hflip[${rf}]`);
        ctx.lines.push(`[${l}][${rf}]overlay=x=${w - hw}:y=0:format=rgb[${o}]`);
        cur = o;
        break;
      }
      case 'quad': {
        const hw = Math.floor(w / 2);
        const hh = Math.floor(h / 2);
        const s = Array.from({ length: 4 }, () => ctx.label());
        const sm = Array.from({ length: 4 }, () => ctx.label());
        ctx.lines.push(`[${cur}]scale=${hw}:${hh},split=4${s.map((x) => `[${x}]`).join('')}`);
        const base = ctx.label();
        ctx.lines.push(`color=c=black@0:s=${w}x${h}:r=${ctx.fps}:d=${r4(ctx.L)},format=rgba[${base}]`);
        let b = base;
        [[0, 0], [hw, 0], [0, hh], [hw, hh]].forEach(([x, y], i) => {
          ctx.lines.push(`[${s[i]}]null[${sm[i]}]`);
          const o = ctx.label();
          ctx.lines.push(`[${b}][${sm[i]}]overlay=${x}:${y}:format=rgb:eof_action=endall[${o}]`);
          b = o;
        });
        cur = b;
        break;
      }
      case 'fliph':
        chain('hflip');
        break;
      case 'flipv':
        chain('vflip');
        break;
      case 'letterbox': {
        const ratio = 1.85 + 0.9 * a;
        const bar = Math.round((h - w / ratio) / 2);
        if (bar > 0) chain(`drawbox=x=0:y=0:w=${w}:h=${bar}:color=black:t=fill,drawbox=x=0:y=${h - bar}:w=${w}:h=${bar}:color=black:t=fill`);
        break;
      }
      case 'strobe': {
        const P = strobeP(a);
        const wc = ctx.label();
        const o = ctx.label();
        ctx.lines.push(`color=c=white@0.85:s=${w}x${h}:r=${ctx.fps}:d=${r4(ctx.L)},format=rgba[${wc}]`);
        ctx.lines.push(`[${cur}][${wc}]overlay=0:0:format=rgb:shortest=1:enable='lt(mod(t+0.001,${r4(P)}),${STROBE_D})'[${o}]`);
        cur = o;
        break;
      }
    }
  }
  return cur;
}

/** Blurred, darkened full-frame copy behind clips that don't fill the frame (vertical video in 16:9 etc.). */
export const blurBg = (c: Clip) => amt(fx(c, 'blurbg'));
