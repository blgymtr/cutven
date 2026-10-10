import type { ColorAdjust, Grade, Pt } from '../types';
import { colorPipeline } from './color';

/**
 * Lumetri-style grading. The whole grade (basic colour + tone + wheels + curves + HSL
 * secondary + look + user LUT) is baked into one 33³ 3D LUT. The preview applies it with
 * WebGL2 and the export with ffmpeg's lut3d (trilinear) — identical maths on both sides.
 */

export const LUT_N = 33;

export const DEFAULT_GRADE: Grade = {
  on: true,
  exposure: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  tint: 0,
  vibrance: 0,
  wheels: { shadows: { h: 0, a: 0, l: 0 }, mids: { h: 0, a: 0, l: 0 }, highs: { h: 0, a: 0, l: 0 } },
  curves: { m: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] },
  hsl: { on: false, hue: 120, range: 30, satMin: 0.15, soft: 0.5, dHue: 0, dSat: 0, dLum: 0, show: false },
  look: 'none',
  lookAmt: 1,
};

export const LOOKS: { id: string; name: string }[] = [
  { id: 'none', name: 'Yok' },
  { id: 'teal', name: 'Teal & Orange' },
  { id: 'warmfilm', name: 'Sıcak film' },
  { id: 'bleach', name: 'Bleach bypass' },
  { id: 'cold', name: 'Soğuk mavi' },
  { id: 'matte', name: 'Mat' },
  { id: 'noir', name: 'Noir' },
  { id: 'cyber', name: 'Cyberpunk' },
  { id: 'golden', name: 'Altın saat' },
];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055);
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Monotone cubic (Fritsch–Carlson) curve → 1024-entry table. */
export function curveTable(pts: Pt[]): Float32Array {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  const out = new Float32Array(1024);
  if (n < 2) {
    for (let i = 0; i < 1024; i++) out[i] = i / 1023;
    return out;
  }
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(Math.max(1e-6, p[i + 1][0] - p[i][0]));
    m.push((p[i + 1][1] - p[i][1]) / dx[i]);
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  let seg = 0;
  for (let i = 0; i < 1024; i++) {
    const x = i / 1023;
    if (x <= p[0][0]) {
      out[i] = p[0][1];
      continue;
    }
    if (x >= p[n - 1][0]) {
      out[i] = p[n - 1][1];
      continue;
    }
    while (seg < n - 2 && x > p[seg + 1][0]) seg++;
    const h = dx[seg];
    const u = (x - p[seg][0]) / h;
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1;
    const h10 = u ** 3 - 2 * u ** 2 + u;
    const h01 = -2 * u ** 3 + 3 * u ** 2;
    const h11 = u ** 3 - u ** 2;
    out[i] = clamp01(h00 * p[seg][1] + h10 * h * t[seg] + h01 * p[seg + 1][1] + h11 * h * t[seg + 1]);
  }
  return out;
}
const isIdentityCurve = (p: Pt[]) => p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1;
const tab = (t: Float32Array, v: number) => {
  const x = clamp01(v) * 1023;
  const i = Math.floor(x);
  const f = x - i;
  return i >= 1023 ? t[1023] : t[i] * (1 - f) + t[i + 1] * f;
};

function rgb2hsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h / 360 + 1 / 3), f(h / 360), f(h / 360 - 1 / 3)];
}
/** chroma offset from a wheel (hue°, amount) */
/** colour-wheel push: the hue's colour minus its own luma (so the wheel tints without brightening). */
const wheelRgb = (h: number, a: number): [number, number, number] => {
  if (!a) return [0, 0, 0];
  const c = hsl2rgb(((h % 360) + 360) % 360, 1, 0.5);
  const y = luma(c[0], c[1], c[2]);
  return [(c[0] - y) * a * 0.2, (c[1] - y) * a * 0.2, (c[2] - y) * a * 0.2];
};
const splitTone = (rgb: number[], sh: number[], hi: number[], amt: number) => {
  const y = luma(rgb[0], rgb[1], rgb[2]);
  const ws = 1 - smooth(0, 0.55, y);
  const wh = smooth(0.45, 1, y);
  return rgb.map((v, i) => v + amt * (ws * sh[i] + wh * hi[i]));
};

function look(id: string, c: number[]): number[] {
  let [r, g, b] = c;
  const y = luma(r, g, b);
  const sat = (k: number) => [y + (r - y) * k, y + (g - y) * k, y + (b - y) * k];
  switch (id) {
    case 'teal': {
      const s = sat(1.15);
      return splitTone(s, [-0.06, 0.03, 0.08], [0.09, 0.02, -0.07], 1);
    }
    case 'warmfilm': {
      const s = sat(0.9);
      return [s[0] * 1.06 + 0.03, s[1] * 1.0 + 0.02, s[2] * 0.88 + 0.03];
    }
    case 'bleach': {
      const s = sat(0.45);
      return s.map((v) => clamp01((v - 0.5) * 1.3 + 0.5));
    }
    case 'cold': {
      const s = sat(0.85);
      return splitTone(s, [-0.02, 0.0, 0.06], [-0.03, 0.01, 0.07], 1);
    }
    case 'matte': {
      const s = sat(0.85);
      return s.map((v) => 0.08 + v * 0.86);
    }
    case 'noir': {
      const v = clamp01((y - 0.5) * 1.45 + 0.48);
      return [v, v, v * 1.02];
    }
    case 'cyber': {
      const s = sat(1.3);
      return splitTone(s, [0.05, -0.04, 0.12], [-0.06, 0.06, 0.1], 1);
    }
    case 'golden': {
      const s = sat(1.12);
      return splitTone(s, [0.02, 0.0, -0.03], [0.1, 0.05, -0.06], 1);
    }
  }
  return c;
}

/* ------------------------------------------------------------ user LUT (.cube) */

export interface CubeLut {
  n: number;
  data: Float32Array;
}
const cubeCache = new Map<string, CubeLut>();

export function parseCube(text: string): CubeLut {
  let n = 0;
  const vals: number[] = [];
  let dmin = [0, 0, 0];
  let dmax = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^LUT_3D_SIZE/i.test(line)) n = parseInt(line.split(/\s+/)[1], 10);
    else if (/^DOMAIN_MIN/i.test(line)) dmin = line.split(/\s+/).slice(1).map(Number);
    else if (/^DOMAIN_MAX/i.test(line)) dmax = line.split(/\s+/).slice(1).map(Number);
    else if (/^[-\d.]/.test(line)) {
      const p = line.split(/\s+/).map(Number);
      if (p.length >= 3) vals.push((p[0] - dmin[0]) / (dmax[0] - dmin[0]), (p[1] - dmin[1]) / (dmax[1] - dmin[1]), (p[2] - dmin[2]) / (dmax[2] - dmin[2]));
    }
  }
  if (!n || vals.length < n * n * n * 3) throw new Error('Geçersiz .cube dosyası (yalnızca 3D LUT desteklenir)');
  return { n, data: Float32Array.from(vals.slice(0, n * n * n * 3)) };
}

export function registerCube(path: string, lut: CubeLut) {
  cubeCache.set(path, lut);
}
export const cubeFor = (path?: string) => (path ? cubeCache.get(path) : undefined);

function sampleCube(l: CubeLut, r: number, g: number, b: number): [number, number, number] {
  const n = l.n;
  const f = (v: number) => clamp01(v) * (n - 1);
  const x = f(r);
  const y = f(g);
  const z = f(b);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const z1 = Math.min(n - 1, z0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const at = (i: number, j: number, k: number, c: number) => l.data[(k * n * n + j * n + i) * 3 + c];
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(x0, y0, z0, c) * (1 - fx) + at(x1, y0, z0, c) * fx;
    const c10 = at(x0, y1, z0, c) * (1 - fx) + at(x1, y1, z0, c) * fx;
    const c01 = at(x0, y0, z1, c) * (1 - fx) + at(x1, y0, z1, c) * fx;
    const c11 = at(x0, y1, z1, c) * (1 - fx) + at(x1, y1, z1, c) * fx;
    out[c] = (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  }
  return out;
}

/* ------------------------------------------------------------ the grade function */

export function gradeActive(g?: Grade) {
  if (!g || !g.on) return false;
  const w = g.wheels;
  return !!(
    g.exposure || g.highlights || g.shadows || g.whites || g.blacks || g.tint || g.vibrance ||
    w.shadows.a || w.shadows.l || w.mids.a || w.mids.l || w.highs.a || w.highs.l ||
    !isIdentityCurve(g.curves.m) || !isIdentityCurve(g.curves.r) || !isIdentityCurve(g.curves.g) || !isIdentityCurve(g.curves.b) ||
    (g.hsl.on && (g.hsl.dHue || g.hsl.dSat || g.hsl.dLum || g.hsl.show)) || (g.look !== 'none' && g.lookAmt > 0) || (g.lut && g.lut.amt > 0)
  );
}

function makeFn(base: ColorAdjust | undefined, g: Grade) {
  const pl = colorPipeline(base);
  const cm = curveTable(g.curves.m);
  const cr = curveTable(g.curves.r);
  const cg = curveTable(g.curves.g);
  const cb = curveTable(g.curves.b);
  const curves = !(isIdentityCurve(g.curves.m) && isIdentityCurve(g.curves.r) && isIdentityCurve(g.curves.g) && isIdentityCurve(g.curves.b));
  const ws = wheelRgb(g.wheels.shadows.h, g.wheels.shadows.a);
  const wm = wheelRgb(g.wheels.mids.h, g.wheels.mids.a);
  const wh = wheelRgb(g.wheels.highs.h, g.wheels.highs.a);
  const cube = cubeFor(g.lut?.path);
  const exp = Math.pow(2, g.exposure);
  return (r: number, gg: number, b: number): [number, number, number] => {
    let c = [r, gg, b];
    // 1) basic colour from the classic panel (same two-stage pipeline as before)
    if (pl) {
      c = c.map((v, i) => clamp01(pl.D[i] * v + pl.E[i]));
      c = [0, 1, 2].map((i) => clamp01(pl.C[i * 3] * c[0] + pl.C[i * 3 + 1] * c[1] + pl.C[i * 3 + 2] * c[2]));
    }
    // 2) exposure in linear light
    if (g.exposure) c = c.map((v) => clamp01(toSrgb(toLin(v) * exp)));
    // 3) tone regions (luma-preserving hue)
    if (g.highlights || g.shadows || g.whites || g.blacks) {
      const y = luma(c[0], c[1], c[2]);
      const dy =
        (0.25 * (g.shadows * (1 - smooth(0, 0.5, y)) + g.highlights * smooth(0.5, 1, y))) / 100 +
        (0.15 * (g.blacks * (1 - smooth(0, 0.25, y)) + g.whites * smooth(0.75, 1, y))) / 100;
      const ny = clamp01(y + dy);
      if (y > 1e-4) c = c.map((v) => clamp01(v * (ny / y)));
      else c = [ny, ny, ny];
    }
    // 4) tint (green ↔ magenta)
    if (g.tint) {
      const t = g.tint / 100;
      c = [clamp01(c[0] * (1 + 0.05 * t)), clamp01(c[1] * (1 - 0.1 * t)), clamp01(c[2] * (1 + 0.05 * t))];
    }
    // 5) colour wheels
    {
      const y = luma(c[0], c[1], c[2]);
      const s = 1 - smooth(0, 0.5, y);
      const h = smooth(0.5, 1, y);
      const m = 1 - s - h;
      const L = (g.wheels.shadows.l * s + g.wheels.mids.l * m + g.wheels.highs.l * h) / 400;
      if (L || g.wheels.shadows.a || g.wheels.mids.a || g.wheels.highs.a)
        c = c.map((v, i) => clamp01(v + ws[i] * s + wm[i] * m + wh[i] * h + L));
    }
    // 6) curves (master, then per channel)
    if (curves) c = [tab(cr, tab(cm, c[0])), tab(cg, tab(cm, c[1])), tab(cb, tab(cm, c[2]))];
    // 7) HSL secondary
    if (g.hsl.on) {
      const [H, S, Lh] = rgb2hsl(c[0], c[1], c[2]);
      let dh = Math.abs(((H - g.hsl.hue + 540) % 360) - 180);
      const soft = Math.max(1, g.hsl.range * g.hsl.soft);
      const wHue = 1 - smooth(g.hsl.range - soft, g.hsl.range + soft, dh);
      const wSat = smooth(g.hsl.satMin * 0.5, g.hsl.satMin + 0.05, S);
      const w = wHue * wSat;
      if (g.hsl.show) {
        c = [w, w, w];
      } else if (w > 0.001) {
        const nh = H + g.hsl.dHue * w;
        const ns = clamp01(S * (1 + (g.hsl.dSat / 100) * w));
        const nl = clamp01(Lh + (g.hsl.dLum / 400) * w);
        c = hsl2rgb(((nh % 360) + 360) % 360, ns, nl);
      }
    }
    // 8) vibrance: boosts muted colours more than saturated ones
    if (g.vibrance) {
      const mx = Math.max(...c);
      const mn = Math.min(...c);
      const sat = mx - mn;
      const k = 1 + (g.vibrance / 100) * (1 - sat) * 0.9;
      const y = luma(c[0], c[1], c[2]);
      c = c.map((v) => clamp01(y + (v - y) * k));
    }
    // 9) creative look
    if (g.look !== 'none' && g.lookAmt > 0) {
      const l = look(g.look, c);
      c = c.map((v, i) => clamp01(v * (1 - g.lookAmt) + l[i] * g.lookAmt));
    }
    // 10) user LUT
    if (cube && g.lut && g.lut.amt > 0) {
      const l = sampleCube(cube, c[0], c[1], c[2]);
      c = c.map((v, i) => clamp01(v * (1 - g.lut!.amt) + l[i] * g.lut!.amt));
    }
    return [c[0], c[1], c[2]];
  };
}

const bakeCache = new Map<string, Float32Array>();
const keyOf = (base: ColorAdjust | undefined, g: Grade) => JSON.stringify([base, g, cubeFor(g.lut?.path) ? 1 : 0]);

/** RGB float LUT, r fastest (same order as .cube). */
export function bakeLut(base: ColorAdjust | undefined, g: Grade): { key: string; data: Float32Array } {
  const key = keyOf(base, g);
  let data = bakeCache.get(key);
  if (!data) {
    const f = makeFn(base, g);
    const N = LUT_N;
    data = new Float32Array(N * N * N * 3);
    let o = 0;
    for (let b = 0; b < N; b++)
      for (let gg = 0; gg < N; gg++)
        for (let r = 0; r < N; r++) {
          const v = f(r / (N - 1), gg / (N - 1), b / (N - 1));
          data[o++] = v[0];
          data[o++] = v[1];
          data[o++] = v[2];
        }
    bakeCache.set(key, data);
    if (bakeCache.size > 30) bakeCache.delete(bakeCache.keys().next().value!);
  }
  return { key, data };
}

export function cubeText(data: Float32Array): string {
  const lines = ['TITLE "Cutven grade"', `LUT_3D_SIZE ${LUT_N}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let i = 0; i < data.length; i += 3) lines.push(`${data[i].toFixed(6)} ${data[i + 1].toFixed(6)} ${data[i + 2].toFixed(6)}`);
  return lines.join('\n') + '\n';
}

/** Load a .cube from disk (through the cvm protocol) and keep it parsed in memory. */
export async function loadCube(path: string): Promise<CubeLut> {
  const cached = cubeFor(path);
  if (cached) return cached;
  const txt = await (await fetch('cvm://media/' + encodeURIComponent(path))).text();
  const lut = parseCube(txt);
  registerCube(path, lut);
  return lut;
}
