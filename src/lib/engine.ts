import { get, set, useStore } from '../store';
import type { Clip, Project } from '../types';
import { clamp, clipDur, fadeEnv, mediaUrl, projectDuration } from './util';
import { drawFrame, mediaOf } from './render';
import { ensureFont } from './text';
import { buildAudioChain } from './afx';
import { visStart } from './transitions';
import { volAt } from './keyframes';

interface PlayerEl {
  el: HTMLVideoElement;
  src: string;
  gain: GainNode;
  node: MediaElementAudioSourceNode;
  fx: AudioNode[];
  fxKey: string;
  pending: number | null;
  lastUsed: number;
}

class Engine {
  canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private els = new Map<string, PlayerEl>();
  private imgs = new Map<string, HTMLImageElement>();
  private actx: AudioContext | null = null;
  private t0 = 0;
  private wall0 = 0;
  private dirty = true;
  playing = false;
  /** silence timeline audio (e.g. while recording a voiceover through speakers) */
  muted = false;
  /** extra redraw listeners (e.g. preview overlay) */
  onFrame: (() => void) | null = null;

  constructor() {
    useStore.subscribe((s, prev) => {
      if (s.project !== prev.project || s.time !== prev.time || s.runtime !== prev.runtime) this.dirty = true;
      if (s.project !== prev.project && this.playing && s.project) {
        // keep playing, re-sync next tick
      }
      if (!s.project && prev.project) this.reset();
    });
    const loop = () => {
      requestAnimationFrame(loop);
      this.tick();
    };
    requestAnimationFrame(loop);
  }

  attach(canvas: HTMLCanvasElement | null) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d', { alpha: false }) : null;
    this.dirty = true;
  }

  invalidate() {
    this.dirty = true;
  }

  private audio() {
    if (!this.actx) this.actx = new AudioContext({ latencyHint: 'playback' });
    return this.actx;
  }

  private srcFor(p: Project, c: Clip): string | null {
    const m = mediaOf(p, c);
    if (!m) return null;
    const rt = get().runtime[m.id];
    if (!rt || rt.status === 'missing' || rt.status === 'error' || rt.status === 'proxy') return null;
    return mediaUrl(rt.previewPath || m.path);
  }

  private destroy(id: string) {
    const e = this.els.get(id);
    if (!e) return;
    e.el.pause();
    e.el.removeAttribute('src');
    e.el.load();
    try {
      e.node.disconnect();
      e.fx.forEach((n) => n.disconnect());
      e.gain.disconnect();
    } catch {}
    this.els.delete(id);
  }

  private ensure(p: Project, c: Clip): PlayerEl | null {
    const src = this.srcFor(p, c);
    if (!src) return null;
    let e = this.els.get(c.id);
    if (e && e.src !== src) {
      this.destroy(c.id);
      e = undefined;
    }
    if (!e) {
      const el = document.createElement('video');
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      el.playsInline = true;
      el.src = src;
      const actx = this.audio();
      const node = actx.createMediaElementSource(el);
      const gain = actx.createGain();
      gain.gain.value = 0;
      gain.connect(actx.destination);
      const pe: PlayerEl = { el, src, gain, node, fx: [], fxKey: '#', pending: null, lastUsed: performance.now() };
      el.addEventListener('seeked', () => {
        if (pe.pending != null) {
          el.currentTime = pe.pending;
          pe.pending = null;
        }
        this.dirty = true;
      });
      el.addEventListener('loadeddata', () => (this.dirty = true));
      this.els.set(c.id, pe);
      e = pe;
    }
    e.lastUsed = performance.now();
    const key = (c.afx || 'none') + '|' + (c.chan || '');
    if (e.fxKey !== key) {
      // (re)build the effect chain between the media node and the clip gain
      e.node.disconnect();
      e.fx.forEach((n) => n.disconnect());
      const { output, nodes } = buildAudioChain(this.audio(), e.node, c.afx, c.chan);
      output.connect(e.gain);
      e.fx = nodes;
      e.fxKey = key;
    }
    return e;
  }

  private seekEl(e: PlayerEl, target: number, tol: number) {
    const el = e.el;
    if (el.readyState === 0) {
      e.pending = target;
      el.addEventListener(
        'loadedmetadata',
        () => {
          if (e.pending != null) {
            el.currentTime = e.pending;
            e.pending = null;
          }
        },
        { once: true },
      );
      return;
    }
    if (el.seeking) {
      e.pending = target;
      return;
    }
    if (Math.abs(el.currentTime - target) > tol) el.currentTime = target;
  }

  private image(p: Project, c: Clip): HTMLImageElement | null {
    const src = this.srcFor(p, c);
    if (!src) return null;
    let img = this.imgs.get(src);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => (this.dirty = true);
      img.src = src;
      this.imgs.set(src, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  private sync(p: Project, t: number) {
    const live = new Set<string>();
    const fps = p.fps || 30;
    for (const c of p.clips) {
      if (c.kind !== 'video' && c.kind !== 'audio') continue;
      const dur = clipDur(c);
      const vs = visStart(c);
      const active = t >= vs && t < c.start + dur;
      const soon = !active && t >= vs - 2 && t < vs;
      if (!active && !soon) continue;
      const e = this.ensure(p, c);
      if (!e) continue;
      live.add(c.id);
      const el = e.el;
      const local = active ? t - c.start : vs - c.start;
      const target = Math.max(0, c.in + local * c.speed);
      if (active && this.playing) {
        if (el.playbackRate !== c.speed) el.playbackRate = c.speed;
        if (el.paused) {
          if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
          el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - target) > 0.3) {
          el.currentTime = target;
        }
      } else {
        if (!el.paused) el.pause();
        this.seekEl(e, target, 0.5 / fps);
      }
      const track = p.tracks.find((tr) => tr.id === c.trackId);
      const media = mediaOf(p, c);
      const audible = active && local >= 0 && this.playing && !this.muted && !c.muted && !track?.muted && !!media?.hasAudio;
      const g = audible ? volAt(c, local) * fadeEnv(local, dur, c.audioFadeIn, c.audioFadeOut) : 0;
      if (Math.abs(e.gain.gain.value - g) > 0.001) e.gain.gain.setTargetAtTime(g, this.audio().currentTime, 0.015);
    }
    const now = performance.now();
    for (const [id, e] of this.els) {
      if (live.has(id)) continue;
      if (!e.el.paused) e.el.pause();
      e.gain.gain.value = 0;
      const exists = p.clips.some((c) => c.id === id);
      if (!exists || now - e.lastUsed > 20000) this.destroy(id);
    }
  }

  private source = (c: Clip): CanvasImageSource | null => {
    const p = get().project!;
    if (c.kind === 'image') return this.image(p, c);
    const e = this.els.get(c.id);
    if (!e || e.el.readyState < 2) return null;
    return e.el;
  };

  private draw(p: Project, t: number) {
    const ctx = this.ctx;
    const cv = this.canvas;
    if (!ctx || !cv) return;
    for (const c of p.clips) {
      if (c.kind === 'text' && c.text) {
        const r = ensureFont(c.text);
        if (r !== true) r.then(() => (this.dirty = true));
      }
    }
    drawFrame(ctx, p, t, cv.width / p.width, this.source);
    this.onFrame?.();
  }

  private tick() {
    const s = get();
    const p = s.project;
    if (!p) return;
    if (this.playing) {
      const dur = projectDuration(p);
      let t = this.t0 + (performance.now() - this.wall0) / 1000;
      if (t >= dur) {
        t = dur;
        set({ time: t });
        this.pause();
        return;
      }
      set({ time: t });
      this.sync(p, t);
      this.draw(p, t);
      this.dirty = false;
    } else if (this.dirty) {
      this.dirty = false;
      this.sync(p, s.time);
      this.draw(p, s.time);
    }
  }

  play() {
    const s = get();
    if (!s.project || this.playing) return;
    const dur = projectDuration(s.project);
    if (dur <= 0) return;
    let t = s.time;
    if (t >= dur - 0.02) t = 0;
    this.audio().resume();
    this.t0 = t;
    this.wall0 = performance.now();
    this.playing = true;
    set({ playing: true, time: t });
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    for (const e of this.els.values()) {
      e.el.pause();
      e.gain.gain.value = 0;
    }
    set({ playing: false });
    this.dirty = true;
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t: number) {
    const p = get().project;
    if (!p) return;
    t = clamp(t, 0, Math.max(projectDuration(p), 0));
    if (this.playing) {
      this.t0 = t;
      this.wall0 = performance.now();
    }
    set({ time: t });
  }

  reset() {
    this.pause();
    for (const id of [...this.els.keys()]) this.destroy(id);
    this.imgs.clear();
  }

  /** Wait until all active video elements have finished seeking (max ~3s). */
  async settle() {
    const p = get().project;
    if (!p) return;
    this.sync(p, get().time);
    const start = performance.now();
    while (performance.now() - start < 3000) {
      let busy = false;
      for (const e of this.els.values()) if (e.el.seeking || e.pending != null || (e.el.readyState > 0 && e.el.readyState < 2)) busy = true;
      if (!busy) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    for (const c of p.clips) if (c.kind === 'text' && c.text) await ensureFont(c.text);
  }

  /** Render the current frame at the given width (project aspect). */
  async capture(width: number, type = 'image/png', quality = 0.92): Promise<string | null> {
    const p = get().project;
    if (!p) return null;
    await this.settle();
    const cv = document.createElement('canvas');
    cv.width = Math.round(width);
    cv.height = Math.round((width * p.height) / p.width);
    const ctx = cv.getContext('2d')!;
    drawFrame(ctx, p, get().time, cv.width / p.width, this.source);
    try {
      return cv.toDataURL(type, quality);
    } catch {
      return null;
    }
  }
}

export const engine = new Engine();
