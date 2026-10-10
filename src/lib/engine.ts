import { get, set, useStore } from '../store';
import type { Clip, Project } from '../types';
import { clamp, clipDur, fadeEnv, mediaUrl, projectDuration } from './util';
import { drawFrame, mediaOf } from './render';
import { ensureFont } from './text';
import { buildAudioChain, clipStages, clipFxKey } from './afx';
import { visStart } from './transitions';
import { volAt } from './keyframes';
import { trackMix, LoudnessMeter } from './mix';

interface PlayerEl {
  el: HTMLVideoElement;
  src: string;
  gain: GainNode;
  pan: StereoPannerNode;
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
  private master: GainNode | null = null;
  meter: LoudnessMeter | null = null;
  private t0 = 0;
  private wall0 = 0;
  private dirty = true;
  playing = false;
  /** shuttle speed (J/K/L): negative plays backwards */
  rate = 1;
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
    if (!this.actx) {
      this.actx = new AudioContext({ latencyHint: 'playback' });
      this.master = this.actx.createGain();
      this.master.channelCount = 2;
      this.master.channelCountMode = 'explicit';
      this.master.connect(this.actx.destination);
      this.meter = new LoudnessMeter(this.actx, this.master);
    }
    return this.actx;
  }
  /** master bus (everything the timeline plays goes through here and the loudness meter) */
  bus() {
    this.audio();
    return this.master!;
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
      e.pan.disconnect();
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
      const pan = actx.createStereoPanner();
      gain.connect(pan);
      pan.connect(this.bus());
      const pe: PlayerEl = { el, src, gain, pan, node, fx: [], fxKey: '#', pending: null, lastUsed: performance.now() };
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
    const key = clipFxKey(c);
    if (e.fxKey !== key) {
      // (re)build the effect chain between the media node and the clip gain
      e.node.disconnect();
      e.fx.forEach((n) => n.disconnect());
      const { output, nodes } = buildAudioChain(this.audio(), e.node, c.afx, c.chan, clipStages(c));
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
      const scrub = this.playing && (this.rate < 0 || this.rate > 4);
      if (active && this.playing && !scrub) {
        const pr = Math.min(16, c.speed * this.rate);
        if (el.playbackRate !== pr) el.playbackRate = pr;
        if (el.paused) {
          if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
          el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - target) > 0.3) {
          el.currentTime = target;
        }
      } else {
        if (!el.paused) el.pause();
        this.seekEl(e, target, scrub ? 1.5 / fps : 0.5 / fps);
      }
      const track = p.tracks.find((tr) => tr.id === c.trackId);
      const media = mediaOf(p, c);
      const mix = trackMix(p, c);
      const audible = active && local >= 0 && this.playing && !scrub && !this.muted && !c.muted && !!track && mix.on && !!media?.hasAudio;
      const g = audible ? volAt(c, local) * fadeEnv(local, dur, c.audioFadeIn, c.audioFadeOut) * mix.vol : 0;
      if (Math.abs(e.pan.pan.value - mix.pan) > 0.001) e.pan.pan.value = mix.pan;
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
      let t = this.t0 + ((performance.now() - this.wall0) / 1000) * this.rate;
      if (t <= 0 && this.rate < 0) {
        set({ time: 0 });
        this.pause();
        return;
      }
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

  play(rate = 1) {
    const s = get();
    if (!s.project) return;
    if (this.playing) {
      // change shuttle speed without a jump
      this.t0 = s.time;
      this.wall0 = performance.now();
      this.rate = rate;
      set({ shuttle: rate });
      return;
    }
    const dur = projectDuration(s.project);
    if (dur <= 0) return;
    let t = s.time;
    if (t >= dur - 0.02 && rate > 0) t = 0;
    this.rate = rate;
    this.audio().resume();
    this.t0 = t;
    this.wall0 = performance.now();
    this.playing = true;
    set({ playing: true, time: t, shuttle: rate });
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.rate = 1;
    for (const e of this.els.values()) {
      e.el.pause();
      e.gain.gain.value = 0;
    }
    set({ playing: false, shuttle: 1 });
    this.dirty = true;
  }

  /** J / L: each press doubles the speed in that direction (1, 2, 4, 8). */
  shuttle(dir: 1 | -1) {
    const cur = this.playing ? this.rate : 0;
    let next: number;
    if (cur === 0 || Math.sign(cur) !== dir) next = dir;
    else next = Math.min(8, Math.abs(cur) * 2) * dir;
    this.play(next);
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
