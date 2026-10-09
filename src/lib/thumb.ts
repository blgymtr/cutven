import { get, toast } from '../store';
import type { Project, ThumbDesign, ThumbLayer } from '../types';
import { DEFAULT_COLOR, colorFilterCss } from './color';
import { DEFAULT_TEXT, drawText, ensureFont, measureText } from './text';
import { mediaUrl, uid } from './util';

export const TW = 1280;
export const TH = 720;

export function defaultDesign(): ThumbDesign {
  return {
    bg: null,
    bgColor: '#141418',
    bgScale: 1,
    bgX: 0,
    bgY: 0,
    darken: 0.15,
    vignette: 0.35,
    color: { ...DEFAULT_COLOR, preset: 'vivid' },
    layers: [newTextLayer('BAŞLIK')],
    embed: true,
  };
}

export function newTextLayer(content: string, patch: Partial<ThumbLayer> = {}): ThumbLayer {
  return {
    id: uid(),
    kind: 'text',
    x: 0,
    y: 180,
    scale: 1,
    rotation: 0,
    text: { ...DEFAULT_TEXT, content, font: 'Montserrat', weight: 900, size: 120, stroke: true, strokeColor: '#000000', strokeWidth: 9, shadow: true, shadowBlur: 0, shadowOffset: 8, uppercase: true },
    ...patch,
  };
}

export const thumbDesignOf = (p: Project) => p.thumbDesign || defaultDesign();

const imgs = new Map<string, HTMLImageElement>();
function img(src: string, onload?: () => void) {
  const url = src.startsWith('data:') ? src : mediaUrl(src);
  let im = imgs.get(url);
  if (!im) {
    im = new Image();
    im.crossOrigin = 'anonymous';
    im.src = url;
    imgs.set(url, im);
  }
  if (onload && !im.complete) im.addEventListener('load', onload, { once: true });
  return im.complete && im.naturalWidth ? im : null;
}

export function layerSize(l: ThumbLayer, onload?: () => void) {
  if (l.kind === 'text' && l.text) {
    const m = measureText(l.text);
    return { w: m.w * l.scale, h: m.h * l.scale };
  }
  const im = l.path ? img(l.path, onload) : null;
  const w = 420 * l.scale;
  return { w, h: im ? (w * im.naturalHeight) / im.naturalWidth : w };
}

/** Draw the design into a W×H canvas (design space is 1280×720). */
export function renderThumb(ctx: CanvasRenderingContext2D, d: ThumbDesign, W: number, H: number, onload?: () => void) {
  const k = W / TW;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = d.bgColor;
  ctx.fillRect(0, 0, W, H);
  if (d.bg) {
    const im = img(d.bg, onload);
    if (im) {
      const cover = Math.max(TW / im.naturalWidth, TH / im.naturalHeight) * d.bgScale;
      const w = im.naturalWidth * cover;
      const h = im.naturalHeight * cover;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      const f = colorFilterCss(d.color);
      if (f !== 'none') ctx.filter = f;
      ctx.drawImage(im, TW / 2 + d.bgX - w / 2, TH / 2 + d.bgY - h / 2, w, h);
      ctx.filter = 'none';
    }
  }
  ctx.setTransform(k, 0, 0, k, 0, 0);
  if (d.darken > 0) {
    ctx.fillStyle = `rgba(0,0,0,${d.darken})`;
    ctx.fillRect(0, 0, TW, TH);
  }
  if (d.vignette > 0) {
    const g = ctx.createRadialGradient(TW / 2, TH / 2, TH * 0.35, TW / 2, TH / 2, TW * 0.62);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${Math.min(1, d.vignette * 1.6)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, TW, TH);
  }
  for (const l of d.layers) {
    ctx.save();
    ctx.translate(TW / 2 + l.x, TH / 2 + l.y);
    if (l.rotation) ctx.rotate((l.rotation * Math.PI) / 180);
    if (l.kind === 'text' && l.text) {
      const r = ensureFont(l.text);
      if (r !== true && onload) r.then(onload);
      ctx.scale(l.scale, l.scale);
      drawText(ctx, l.text);
    } else if (l.path) {
      const im = img(l.path, onload);
      if (im) {
        const s = layerSize(l);
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 30;
        ctx.drawImage(im, -s.w / 2, -s.h / 2, s.w, s.h);
      }
    }
    ctx.restore();
  }
  ctx.restore();
}

async function ready(d: ThumbDesign) {
  const waits: Promise<unknown>[] = [];
  const need = [d.bg, ...d.layers.map((l) => l.path)].filter(Boolean) as string[];
  for (const s of need) {
    const url = s.startsWith('data:') ? s : mediaUrl(s);
    const im = imgs.get(url) || (img(s), imgs.get(url)!);
    if (!im.complete) waits.push(im.decode().catch(() => {}));
  }
  for (const l of d.layers) if (l.text) waits.push(Promise.resolve(ensureFont(l.text)));
  await Promise.all(waits);
}

/** Final 1280×720 image; JPEG falls back to keep YouTube's 2 MB limit. */
export async function thumbBlob(d: ThumbDesign, type: 'image/png' | 'image/jpeg' = 'image/png') {
  await ready(d);
  const cv = document.createElement('canvas');
  cv.width = TW;
  cv.height = TH;
  renderThumb(cv.getContext('2d')!, d, TW, TH);
  let data = cv.toDataURL(type, 0.92);
  if (type === 'image/png' && data.length * 0.75 > 2 * 1024 * 1024) data = cv.toDataURL('image/jpeg', 0.9);
  return data;
}

export async function saveThumbPng() {
  const p = get().project;
  if (!p) return;
  const path = await window.cv.invoke<string | null>('dialog:saveImage', `${p.name} - küçük resim`);
  if (!path) return;
  const data = await thumbBlob(thumbDesignOf(p));
  await window.cv.invoke('file:writeDataUrl', path, data);
  toast(data.startsWith('data:image/jpeg') ? 'Kaydedildi (2 MB sınırı için JPEG kalitesinde)' : 'Küçük resim kaydedildi', 'success');
}

/** JPEG written to temp for embedding into the MP4. */
export async function thumbCoverPath(p: Project): Promise<string | undefined> {
  if (!p.thumbDesign?.embed) return undefined;
  const data = await thumbBlob(p.thumbDesign, 'image/jpeg');
  return window.cv.invoke<string>('export:writeTemp', data, `cover-${Date.now()}.jpg`);
}
