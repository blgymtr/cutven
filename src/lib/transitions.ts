import type { Clip, TransType } from '../types';
import { clamp, clipDur } from './util';

/**
 * Clip-edge transitions. The same math drives the canvas preview (transState)
 * and the ffmpeg export (ffTrans) so both look identical.
 * In-transition window: local [0, dIn]; out-transition window: local [L - dOut, L]
 * where local time 0 = visual start (clip start minus dissolve pre-roll).
 */

export const TRANSITIONS: { id: TransType; name: string; hint: string; outOk: boolean }[] = [
  { id: 'fade', name: 'Solma', hint: 'Saydamlıkla yumuşak giriş/çıkış', outOk: true },
  { id: 'dissolve', name: 'Çözülme', hint: 'Önceki klibin üzerine erir', outOk: false },
  { id: 'black', name: 'Siyaha', hint: 'Siyahtan açılır / siyaha kararır', outOk: true },
  { id: 'white', name: 'Beyaz flaş', hint: 'Beyaz parlamayla geçiş', outOk: true },
  { id: 'slideL', name: 'Sola kaydır', hint: 'Sağdan girer, sola çıkar', outOk: true },
  { id: 'slideR', name: 'Sağa kaydır', hint: 'Soldan girer, sağa çıkar', outOk: true },
  { id: 'slideU', name: 'Yukarı', hint: 'Alttan girer, yukarı çıkar', outOk: true },
  { id: 'slideD', name: 'Aşağı', hint: 'Üstten girer, aşağı çıkar', outOk: true },
  { id: 'zoom', name: 'Yakınlaş', hint: 'Yakından açılarak oturur', outOk: true },
  { id: 'spin', name: 'Döndür', hint: 'Dönerek girer/çıkar', outOk: true },
  { id: 'blur', name: 'Bulanık', hint: 'Bulanıktan netleşir', outOk: true },
];

export const transName = (t?: TransType) => TRANSITIONS.find((x) => x.id === (t || 'fade'))?.name || 'Solma';

const ZOOM = 0.25;
const SPIN = 90;
export const BLUR = 30;

/** Dissolve: the clip starts this much earlier, over the previous clip. */
export function preRoll(c: Clip): number {
  if (c.kind === 'audio' || c.tIn !== 'dissolve' || c.fadeIn <= 0) return 0;
  return Math.min(c.fadeIn, 3, Math.max(0.05, clipDur(c)));
}

export const visStart = (c: Clip) => c.start - preRoll(c);

export function trDurations(c: Clip) {
  const dur = clipDur(c);
  const pre = preRoll(c);
  const dIn = pre > 0 ? pre : Math.min(c.fadeIn, dur / 2);
  const dOut = Math.min(c.fadeOut, dur / 2);
  return { pre, dIn, dOut, L: pre + dur };
}

export interface TransState {
  alpha: number;
  dx: number;
  dy: number;
  zoom: number;
  rot: number;
  blur: number;
  black: number;
  white: number;
}

const inv = (p: number) => Math.pow(1 - p, 3); // 1 - easeOutCubic(p)

function apply(s: TransState, type: TransType, p: number, isIn: boolean, W: number, H: number) {
  const r = inv(p);
  const sg = isIn ? 1 : -1;
  switch (type) {
    case 'fade':
    case 'dissolve':
      s.alpha *= p;
      break;
    case 'black':
      s.black = Math.max(s.black, 1 - p);
      break;
    case 'white':
      s.white = Math.max(s.white, 1 - p);
      break;
    case 'slideL':
      s.dx += sg * r * W;
      break;
    case 'slideR':
      s.dx -= sg * r * W;
      break;
    case 'slideU':
      s.dy += sg * r * H;
      break;
    case 'slideD':
      s.dy -= sg * r * H;
      break;
    case 'zoom':
      s.zoom *= 1 + ZOOM * r;
      s.alpha *= p;
      break;
    case 'spin':
      s.rot += -sg * SPIN * r;
      s.alpha *= p;
      break;
    case 'blur':
      s.blur = Math.max(s.blur, BLUR * r);
      break;
  }
}

export function transState(c: Clip, t: number, W: number, H: number): TransState {
  const s: TransState = { alpha: 1, dx: 0, dy: 0, zoom: 1, rot: 0, blur: 0, black: 0, white: 0 };
  const { dIn, dOut, L } = trDurations(c);
  const local = t - visStart(c);
  if (dIn > 0 && local < dIn) apply(s, c.tIn || 'fade', clamp(local / dIn, 0, 1), true, W, H);
  if (dOut > 0 && local > L - dOut) apply(s, c.tOut || 'fade', clamp((L - local) / dOut, 0, 1), false, W, H);
  return s;
}

/* ------------------------------------------------------------ ffmpeg */

const f = (n: number) => (Math.round(n * 10000) / 10000).toString();

export interface FfTrans {
  /** filters on the clip stream (local time t), before the timeline offset */
  pre: string[];
  /** extra x/y terms for overlay (main timeline time t), in output px */
  dx: string;
  dy: string;
  /** zoompan z expression (uses it = local time), or null */
  zoom: string | null;
  /** extra rotation in radians (rotate filter, local t), or null */
  rot: string | null;
  /** blurred-copy alpha fades (each entry = one blurred copy) */
  blurs: string[][];
  /** full-frame color flashes drawn right above the clip */
  flashes: { color: string; start: number; dur: number; dir: 'in' | 'out' }[];
}

export function ffTrans(c: Clip, W: number, H: number): FfTrans {
  const { dIn, dOut, L } = trDurations(c);
  const vs = visStart(c);
  const res: FfTrans = { pre: [], dx: '', dy: '', zoom: null, rot: null, blurs: [], flashes: [] };
  const zooms: string[] = [];
  const rots: string[] = [];
  const side = (type: TransType, isIn: boolean) => {
    const d = isIn ? dIn : dOut;
    // remaining-progress terms
    const pLocal = isIn ? `clip(T/${f(d)},0,1)` : `clip((${f(L)}-T)/${f(d)},0,1)`;
    const r = (T: string) => `pow(1-${pLocal.replace(/T/g, T)},3)`;
    const sg = isIn ? 1 : -1;
    switch (type) {
      case 'fade':
      case 'dissolve':
      case 'zoom':
      case 'spin':
        res.pre.push(isIn ? `fade=t=in:st=0:d=${f(d)}:alpha=1` : `fade=t=out:st=${f(L - d)}:d=${f(d)}:alpha=1`);
        if (type === 'zoom') zooms.push(`(1+${ZOOM}*${r('it')})`);
        if (type === 'spin') rots.push(`${f((-sg * SPIN * Math.PI) / 180)}*${r('t')}`);
        break;
      case 'black':
      case 'white':
        res.flashes.push({ color: type === 'black' ? '0x000000' : '0xFFFFFF', start: isIn ? vs : vs + L - d, dur: d, dir: isIn ? 'in' : 'out' });
        break;
      case 'slideL':
      case 'slideR':
      case 'slideU':
      case 'slideD': {
        const horiz = type === 'slideL' || type === 'slideR';
        const k = (type === 'slideL' || type === 'slideU' ? 1 : -1) * sg * (horiz ? W : H);
        const term = (k >= 0 ? '+' : '-') + `${f(Math.abs(k))}*${r(`(t-${f(vs)})`)}`;
        if (horiz) res.dx += term;
        else res.dy += term;
        break;
      }
      case 'blur':
        res.blurs.push(isIn ? [`fade=t=out:st=0:d=${f(d)}:alpha=1`] : [`fade=t=in:st=${f(L - d)}:d=${f(d)}:alpha=1`]);
        break;
    }
  };
  if (dIn > 0) side(c.tIn || 'fade', true);
  if (dOut > 0) side(c.tOut || 'fade', false);
  if (zooms.length) res.zoom = zooms.join('*');
  if (rots.length) res.rot = rots.join('+');
  return res;
}
