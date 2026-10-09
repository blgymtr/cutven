import type { Clip, MediaItem, Project, TextStyle } from '../types';
import { clipDur } from './util';
import { measureText, drawText } from './text';
import { colorFilterCss } from './color';
import { transState, visStart } from './transitions';

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
  for (const c of activeVisuals(p, t)) {
    const tr = transState(c, t, p.width, p.height);
    const a = c.opacity * tr.alpha;
    if (a > 0.001) {
      const box = clipBox(p, c);
      ctx.save();
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.translate(box.cx + tr.dx, box.cy + tr.dy);
      const rot = box.rot + tr.rot;
      if (rot) ctx.rotate((rot * Math.PI) / 180);
      ctx.globalAlpha = a;
      const filters: string[] = [];
      const cf = c.kind === 'video' || c.kind === 'image' ? colorFilterCss(c.color) : 'none';
      if (cf !== 'none') filters.push(cf);
      if (tr.blur > 0.3) filters.push(`blur(${(tr.blur * k * c.scale).toFixed(2)}px)`);
      if (filters.length) ctx.filter = filters.join(' ');
      if (tr.zoom !== 1) {
        // punch-in inside the clip's own frame (matches ffmpeg zoompan)
        const pad = c.kind === 'text' && c.text ? textPad(c.text) * c.scale : 0;
        ctx.beginPath();
        ctx.rect(-box.w / 2 - pad, -box.h / 2 - pad, box.w + pad * 2, box.h + pad * 2);
        ctx.clip();
        ctx.scale(tr.zoom, tr.zoom);
      }
      if (c.kind === 'text' && c.text) {
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
  ctx.restore();
}

/** Hit test (project px). Returns top-most visual clip under point. */
export function hitTest(p: Project, t: number, x: number, y: number): Clip | null {
  const list = activeVisuals(p, t);
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
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
