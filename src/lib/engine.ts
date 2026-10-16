import { get, set, useStore } from '../store';
import type { Clip, Project } from '../types';
import { clamp, clipDur, fadeEnv, mediaUrl, projectDuration } from './util';
import { activeVisuals, drawFrame, mediaOf } from './render';
import { ensureFont } from './text';
import { buildAudioChain, clipStages, clipFxKey } from './afx';
import { visStart } from './transitions';
import { volAt } from './keyframes';
import { trackMix, LoudnessMeter } from './mix';
import { activeCaption, captionTextStyle, styleOf } from './captions';

interface PlayerEl {
  el: HTMLVideoElement;
  src: string;
  gain: GainNode;
  pan: StereoPannerNode;
  node: MediaElementAudioSourceNode;
  fx: AudioNode[];
  fxKey: string;
  pending: number | null;
  /** waiting for metadata before the first seek */
  metaWait: boolean;
  lastUsed: number;
  /** copy of the last decoded frame: drawn while the element seeks / reloads instead of nothing (black) */
  hold: HTMLCanvasElement | null;
}

/** longest side of a held frame (it is only shown for the moment a seek takes) */
const HOLD_MAX = 1920;
/** how long the preview keeps the previous picture while a newly reached clip is still loading */
const WAIT_MS = 700;

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
  /** the canvas holds a complete picture (false right after attach / resize) */
  private drawn = false;
  /** since when a visible clip has had no picture to draw */
  private waitSince = 0;

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
    this.drawn = false;
    this.dirty = true;
  }

  /** Resize the preview canvas without flashing: the old picture is scaled into the new size, then redrawn. */
  resize(w: number, h: number) {
    const cv = this.canvas;
    w = Math.max(1, w);
    h = Math.max(1, h);
    if (!cv || (cv.width === w && cv.height === h)) return;
    let snap: HTMLCanvasElement | null = null;
    if (this.drawn && cv.width > 1 && cv.height > 1) {
      snap = document.createElement('canvas');
      snap.width = cv.width;
      snap.height = cv.height;
      snap.getContext('2d')!.drawImage(cv, 0, 0);
    }
    cv.width = w;
    cv.height = h;
    if (snap && this.ctx) this.ctx.drawImage(snap, 0, 0, w, h);
    this.dirty = true;
    this.tick();
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
    if (e.hold) e.hold.width = e.hold.height = 0;
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
      const pe: PlayerEl = { el, src, gain, pan, node, fx: [], fxKey: '#', pending: null, metaWait: false, lastUsed: performance.now(), hold: null };
      el.addEventListener('seeked', () => {
        // keep the frame we just reached, so the next seek (scrubbing) has something to show
        this.grab(pe);
        if (pe.pending != null) {
          const next = pe.pending;
          pe.pending = null;
          if (Math.abs(el.currentTime - next) > 0.004) el.currentTime = next;
        }
        this.dirty = true;
      });
      el.addEventListener('loadeddata', () => {
        this.grab(pe);
        this.dirty = true;
      });
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

  /** Copy the element's current frame into its hold canvas (only when a real frame is there). */
  private grab(e: PlayerEl) {
    const el = e.el;
    if (el.readyState < 2 || el.seeking || !el.videoWidth || !el.videoHeight) return;
    const k = Math.min(1, HOLD_MAX / Math.max(el.videoWidth, el.videoHeight));
    const w = Math.max(2, Math.round(el.videoWidth * k));
    const h = Math.max(2, Math.round(el.videoHeight * k));
    let cv = e.hold;
    if (!cv) cv = e.hold = document.createElement('canvas');
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    try {
      cv.getContext('2d')!.drawImage(el, 0, 0, w, h);
    } catch {
      e.hold = null;
    }
  }

  /** Seek an element; while it is busy only the latest target is kept (scrubbing never queues up). */
  private seekTo(e: PlayerEl, target: number) {
    this.grab(e);
    e.el.currentTime = target;
  }

  private seekEl(e: PlayerEl, target: number, tol: number) {
    const el = e.el;
    if (el.readyState === 0) {
      e.pending = target;
      if (!e.metaWait) {
        e.metaWait = true;
        el.addEventListener(
          'loadedmetadata',
          () => {
            e.metaWait = false;
            if (e.pending != null) {
              el.currentTime = e.pending;
              e.pending = null;
            }
          },
          { once: true },
        );
      }
      return;
    }
    if (el.seeking) {
      e.pending = target;
      return;
    }
    e.pending = null;
    if (Math.abs(el.currentTime - target) > tol) this.seekTo(e, target);
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
      const end = c.start + dur;
      const active = t >= vs && t < end;
      // warm up the next clip (and, while paused, the previous one for scrubbing back)
      const ahead = !active && t >= vs - 2 && t < vs;
      const behind = !active && !this.playing && t >= end && t < end + 1;
      if (!active && !ahead && !behind) continue;
      const e = this.ensure(p, c);
      if (!e) continue;
      live.add(c.id);
      const el = e.el;
      const local = active ? t - c.start : ahead ? vs - c.start : dur - 1 / fps;
      const target = Math.min(Math.max(0, c.in + local * c.speed), Math.max(0, c.out - 0.001));
      const scrub = this.playing && (this.rate < 0 || this.rate > 4);
      if (active && this.playing && !scrub) {
        const pr = Math.min(16, c.speed * this.rate);
        if (el.playbackRate !== pr) el.playbackRate = pr;
        if (el.paused) {
          if (el.readyState === 0) this.seekEl(e, target, 0.05);
          else if (!el.seeking && Math.abs(el.currentTime - target) > 0.05) this.seekTo(e, target);
          el.play().catch(() => {});
        } else if (!el.seeking && Math.abs(el.currentTime - target) > 0.3) {
          this.seekTo(e, target);
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
    if (!e) return null;
    const el = e.el;
    // Chromium drops readyState to HAVE_METADATA during a seek and drawImage() then draws nothing:
    // show the last decoded frame of this clip instead of a black hole.
    if (el.readyState >= 2 && !el.seeking && el.videoWidth) return el;
    if (e.hold) return e.hold;
    return el.readyState >= 2 && el.videoWidth ? el : null;
  };

  /** A visible video clip has nothing to draw yet (its element is still loading). */
  private loading(p: Project, t: number): boolean {
    for (const c of activeVisuals(p, t)) {
      if (c.kind !== 'video') continue;
      const e = this.els.get(c.id);
      if (!e) {
        // not created yet but playable: it will be on the next sync
        if (this.srcFor(p, c)) return true;
        continue;
      }
      if (e.el.error) continue;
      if (!e.hold && !(e.el.readyState >= 2 && e.el.videoWidth)) return true;
    }
    return false;
  }

  /** Draw the frame; returns false when it kept the previous picture (a clip is still loading). */
  private draw(p: Project, t: number): boolean {
    const ctx = this.ctx;
    const cv = this.canvas;
    if (!ctx || !cv) return true;
    if (this.drawn && this.loading(p, t)) {
      const now = performance.now();
      if (!this.waitSince) this.waitSince = now;
      // keep showing the last good picture for a moment instead of flashing black
      if (now - this.waitSince < WAIT_MS) return false;
    } else this.waitSince = 0;
    for (const c of p.clips) {
      if (c.kind === 'text' && c.text) {
        const r = ensureFont(c.text);
        if (r !== true) r.then(() => (this.dirty = true));
      }
    }
    // captions skip drawing until their font is loaded: redraw once it is
    const cap = activeCaption(p, t);
    if (cap) {
      const r = ensureFont(captionTextStyle(styleOf(p), cap.text, p.width));
      if (r !== true) r.then(() => (this.dirty = true));
    }
    drawFrame(ctx, p, t, cv.width / p.width, this.source);
    this.drawn = true;
    this.onFrame?.();
    return true;
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
      if (!this.draw(p, s.time)) this.dirty = true;
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
