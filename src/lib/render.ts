import type { Clip, MediaItem, Project, TextStyle } from '../types';
import { clipDur } from './util';
import { measureText, drawText } from './text';
import { colorFilterCss } from './color';
import { transState, visStart, trDurations } from './transitions';
import { vfxMotion, vfxPixels, hasPixelVfx, blurBg } from './vfx';
import { resolveKeys } from './vkeys';
import { gradeActive, bakeLut } from './lumetri';
import { applyLut } from './lutgl';
import { chromaKey } from './keygl';
import { drawCaption } from './captions';

/** Clip needs the per-clip offscreen pipeline (effects, grade, key, crop). */
export const needsPipeline = (c: Clip) =>
  (!!c.vfx?.length && hasPixelVfx(c)) || gradeActive(c.grade) || !!c.ckey?.on || hasCrop(c);
export const hasCrop = (c: Clip) => !!c.crop && (c.crop.l > 0 || c.crop.r > 0 || c.crop.t > 0 || c.crop.b > 0);
const COMPOSITE: Record<string, GlobalCompositeOperation> = { add: 'lighter' };

const scratch = new Map<string, HTMLCanvasElement>();
function copyTo(name: string, src: HTMLCanvasElement) {
  let cv = scratch.get(name);
  if (!cv) {
    cv = document.createElement('canvas');
    scratch.set(name, cv);
  }
  if (cv.width !== src.width || cv.height !== src.height) {
    cv.width = src.width;
    cv.height = src.height;
  }
  const g = cv.getContext('2d')!;
  g.clearRect(0, 0, cv.width, cv.height);
  g.drawImage(src, 0, 0);
  return cv;
}
function filtered(name: string, src: HTMLCanvasElement, f: string) {
  let cv = scratch.get(name);
  if (!cv) {
    cv = document.createElement('canvas');
    scratch.set(name, cv);
  }
  cv.width = src.width;
  cv.height = src.height;
  const g = cv.getContext('2d')!;
  g.filter = f;
  g.drawImage(src, 0, 0);
  return cv;
}

let contentCv: HTMLCanvasElement | null = null;
function contentCanvas(w: number, h: number) {
  if (!contentCv) contentCv = document.createElement('canvas');
  if (contentCv.width !== w || contentCv.height !== h) {
    contentCv.width = w;
    contentCv.height = h;
  }
  return contentCv;
}

export const mediaOf = (p: Project, c: Clip): MediaItem | undefined =>
  c.mediaId ? p.media.find((m) => m.id === c.mediaId) : undefined;

/** Size at scale=1 in project px (media are fit/contained in the frame). */
export function baseSize(p: Project, c: Clip): { w: number; h: number } {
  if (c.kind === 'text' && c.text) {
    const m = measureText(c.text);
    return { w: m.w, h: m.h };
  }
  if (c.kind === 'color') return { w: p.width, h: p.height };
  const m = mediaOf(p, c);
  const mw = m?.width || p.width;
  const mh = m?.height || p.height;
  const fit = Math.min(p.width / mw, p.height / mh);
  return { w: mw * fit, h: mh * fit };
}

/** Extra room around a text box for shadow / stroke (unscaled project px). */
export function textPad(s: TextStyle) {
  return Math.ceil((s.shadow ? s.shadowBlur + s.shadowOffset : 0) + (s.stroke ? s.strokeWidth : 0) + 4);
}

export function fillScale(p: Project, c: Clip) {
  const m = mediaOf(p, c);
  if (!m || !m.width) return 1;
  const fit = Math.min(p.width / m.width, p.height / m.height);
  const fill = Math.max(p.width / m.width, p.height / m.height);
  return fill / fit;
}

export function clipBox(p: Project, c: Clip) {
  const b = baseSize(p, c);
  return { cx: p.width / 2 + c.x, cy: p.height / 2 + c.y, w: b.w * c.scale, h: b.h * c.scale, rot: c.rotation };
}

export const isVisual = (c: Clip) => c.kind !== 'audio';

/** Active visual clips at time t (incl. dissolve pre-roll), ordered bottom → top. */
export function activeVisuals(p: Project, t: number): Clip[] {
  const out: Clip[] = [];
  const tracks = p.tracks.filter((tr) => tr.type === 'visual' && !tr.hidden);
  for (let i = tracks.length - 1; i >= 0; i--) {
    const tr = tracks[i];
    const list = p.clips.filter((c) => c.trackId === tr.id && isVisual(c) && t >= visStart(c) && t < c.start + clipDur(c));
    list.sort((a, b) => a.start - b.start);
    out.push(...list);
  }
  return out;
}

/**
 * Draw a frame. k = canvas px per project px.
 * source(c) returns the drawable for video/image clips (or null if not ready).
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  p: Project,
  t: number,
  k: number,
  source: (c: Clip) => CanvasImageSource | null,
) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = p.background || '#000';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.imageSmoothingQuality = 'high';
  const fps = p.fps || 30;
  for (const c0 of activeVisuals(p, t)) {
    const c = resolveKeys(c0, t - c0.start);
    const tr = transState(c, t, p.width, p.height);
    const T = t - visStart(c);
    const L = trDurations(c).L;
    const mo = c.vfx?.length ? vfxMotion(c, T, t, L, p.width, p.height) : null;
    const a = c.opacity * tr.alpha;
    const box = clipBox(p, c);
    // blurred full-frame fill behind the clip
    const bb = c.vfx?.length ? blurBg(c) : 0;
    if (bb > 0 && a > 0.001 && (c.kind === 'video' || c.kind === 'image')) {
      const src = source(c);
      if (src) {
        const sw = (src as HTMLVideoElement).videoWidth || (src as HTMLImageElement).naturalWidth || box.w;
        const sh = (src as HTMLVideoElement).videoHeight || (src as HTMLImageElement).naturalHeight || box.h;
        const cover = Math.max(p.width / sw, p.height / sh);
        ctx.save();
        ctx.setTransform(k, 0, 0, k, 0, 0);
        ctx.globalAlpha = a;
        ctx.filter = `blur(${(40 * bb * k).toFixed(2)}px) brightness(0.6)`;
        ctx.drawImage(src, (p.width - sw * cover) / 2, (p.height - sh * cover) / 2, sw * cover, sh * cover);
        ctx.restore();
      }
    }
    if (a > 0.001) {
      ctx.save();
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.translate(box.cx + tr.dx + (mo?.dx || 0), box.cy + tr.dy + (mo?.dy || 0));
      const rot = box.rot + tr.rot + (mo?.rot || 0);
      if (rot) ctx.rotate((rot * Math.PI) / 180);
      ctx.globalAlpha = a;
      const pixel = needsPipeline(c);
      if (c.blend && c.blend !== 'normal') ctx.globalCompositeOperation = COMPOSITE[c.blend] || (c.blend as GlobalCompositeOperation);
      const filters: string[] = [];
      const cf = !pixel && (c.kind === 'video' || c.kind === 'image') ? colorFilterCss(c.color) : 'none';
      if (cf !== 'none') filters.push(cf);
      if (tr.blur > 0.3) filters.push(`blur(${(tr.blur * k * c.scale).toFixed(2)}px)`);
      if (filters.length) ctx.filter = filters.join(' ');
      const zoom = tr.zoom * (mo?.zoom || 1);
      const pad = c.kind === 'text' && c.text ? textPad(c.text) * c.scale : 0;
      if (zoom !== 1) {
        // punch-in inside the clip's own frame (matches ffmpeg zoompan)
        ctx.beginPath();
        ctx.rect(-box.w / 2 - pad, -box.h / 2 - pad, box.w + pad * 2, box.h + pad * 2);
        ctx.clip();
        ctx.scale(zoom, zoom);
        if (mo && mo.pan !== 0.5) ctx.translate(-(mo.pan - 0.5) * (box.w + pad * 2 - (box.w + pad * 2) / zoom), 0);
      }
      if (pixel) {
        // render the clip into its own canvas, run the effects, then place it
        const cw = Math.max(2, Math.round((box.w + pad * 2) * k));
        const ch = Math.max(2, Math.round((box.h + pad * 2) * k));
        const content = contentCanvas(cw, ch);
        const g = content.getContext('2d')!;
        g.clearRect(0, 0, cw, ch);
        if (c.kind === 'text' && c.text) {
          g.setTransform(c.scale * k, 0, 0, c.scale * k, cw / 2, ch / 2);
          drawText(g, c.text);
          g.setTransform(1, 0, 0, 1, 0, 0);
        } else if (c.kind === 'color') {
          g.fillStyle = c.fill || '#000000';
          g.fillRect(0, 0, cw, ch);
        } else {
          const src = source(c);
          const graded = gradeActive(c.grade);
          const f = graded || c.ckey?.on ? 'none' : colorFilterCss(c.color);
          if (f !== 'none') g.filter = f;
          if (src) g.drawImage(src, 0, 0, cw, ch);
          g.filter = 'none';
        }
        let stage: HTMLCanvasElement = content;
        // keying works on the camera colours, before any grading
        if (c.ckey?.on && (c.kind === 'video' || c.kind === 'image')) {
          stage = copyTo('key', chromaKey(stage, c.ckey.color, c.ckey.similarity, c.ckey.smooth, c.ckey.spill));
          if (!gradeActive(c.grade)) {
            const f = colorFilterCss(c.color);
            if (f !== 'none') stage = filtered('keycol', stage, f);
          }
        }
        if (gradeActive(c.grade) && (c.kind === 'video' || c.kind === 'image')) {
          const lut = bakeLut(c.color, c.grade!);
          stage = copyTo('grade', applyLut(stage, lut.key, lut.data));
        }
        if (hasCrop(c)) {
          const cr = c.crop!;
          const o = stage === content ? copyTo('crop', stage) : stage;
          const g2 = o.getContext('2d')!;
          const L = Math.round((cr.l / 100) * cw);
          const R = Math.round((cr.r / 100) * cw);
          const Tt = Math.round((cr.t / 100) * ch);
          const B = Math.round((cr.b / 100) * ch);
          g2.clearRect(0, 0, L, ch);
          g2.clearRect(cw - R, 0, R, ch);
          g2.clearRect(0, 0, cw, Tt);
          g2.clearRect(0, ch - B, cw, B);
          stage = o;
        }
        const out = c.vfx?.length && hasPixelVfx(c) ? vfxPixels(c, stage, T, fps) : stage;
        ctx.drawImage(out, -box.w / 2 - pad, -box.h / 2 - pad, box.w + pad * 2, box.h + pad * 2);
      } else if (c.kind === 'text' && c.text) {
        ctx.scale(c.scale, c.scale);
        drawText(ctx, c.text);
      } else if (c.kind === 'color') {
        ctx.fillStyle = c.fill || '#000000';
        ctx.fillRect(-box.w / 2, -box.h / 2, box.w, box.h);
      } else {
        const src = source(c);
        if (src) ctx.drawImage(src, -box.w / 2, -box.h / 2, box.w, box.h);
      }
      ctx.restore();
    }
    for (const [v, col] of [
      [tr.black, '#000'],
      [tr.white, '#fff'],
    ] as const) {
      if (v > 0.001) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = v;
        ctx.fillStyle = col;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.restore();
      }
    }
  }
  drawCaption(ctx, p, t, k);
  ctx.restore();
}

/** Hit test (project px). Returns top-most visual clip under point. */
export function hitTest(p: Project, t: number, x: number, y: number): Clip | null {
  const list = activeVisuals(p, t);
  for (let i = list.length - 1; i >= 0; i--) {
    const c = resolveKeys(list[i], t - list[i].start);
    const tr = p.tracks.find((t) => t.id === c.trackId);
    if (tr?.locked) continue;
    const b = clipBox(p, c);
    const a = (-b.rot * Math.PI) / 180;
    const dx = x - b.cx;
    const dy = y - b.cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) return c;
  }
  return null;
}
