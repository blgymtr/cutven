import { get as appGet, toast } from '../../store';
import type { TextStyle } from '../../types';
import { mediaUrl } from '../util';
import { drawText, ensureFont, measureText } from '../text';
import { chromaKey } from '../keygl';
import { importPaths } from '../media';
import { addMediaToTimeline } from '../actions';
import {
  sget,
  sset,
  useStudio,
  patchStatus,
  updateSource,
  loadStudio,
  videoKbps,
  type AudioIn,
  type HotkeyAction,
  type StudioScene,
  type StudioSource,
} from './state';

/**
 * Recording studio engine. One instance for the whole app: it keeps capturing, composing and
 * encoding while you switch to the editor, and only lets go of cameras / screens when nothing
 * is being recorded or streamed and the studio is closed.
 *
 * Video: every source gets a "feed" (video / image element). Feeds are shared by key, so the same
 * camera in three scenes is opened once. A timer (not requestAnimationFrame, which stops when the
 * window is minimised) draws the program scene onto a canvas; canvas.captureStream() + the mixer
 * output go into MediaRecorder (recording) and into ffmpeg (RTMP streaming).
 *
 * Audio: each mixer channel is input → delay → gain → (compressor) → gate → fader → master,
 * with analysers before the gate (gate detection) and after the fader (meter).
 */

interface Feed {
  key: string;
  el: HTMLVideoElement | HTMLImageElement;
  stream?: MediaStream;
  /** sound of this feed for the mixer (display loopback, video file) */
  audio?: AudioNode;
  ready: boolean;
  error?: string;
}

interface Strip {
  sig: string;
  nodes: AudioNode[];
  delay: DelayNode;
  gain: GainNode;
  gate: GainNode;
  fader: GainNode;
  monitor: GainNode;
  pre: AnalyserNode;
  post: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
  holdUntil: number;
}

export interface Level {
  peak: number;
  rms: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** identity of an audio input node (a strip is rebuilt when its input node changes) */
const nodeIds = new WeakMap<AudioNode, number>();
let nodeSeq = 0;
const nodeId = (n: AudioNode | null) => {
  if (!n) return 0;
  let id = nodeIds.get(n);
  if (!id) nodeIds.set(n, (id = ++nodeSeq));
  return id;
};
const dbToGain = (db: number) => (db <= -60 ? 0 : Math.pow(10, db / 20));
const errText = (e: any) => String(e?.message || e || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** extra room around a text box for shadow / stroke */
const textPad = (s: TextStyle) => Math.ceil((s.shadow ? s.shadowBlur + s.shadowOffset : 0) + (s.stroke ? s.strokeWidth : 0) + 4);

/** natural size of a text source (unscaled) */
export function textNatural(s: TextStyle) {
  const m = measureText(s);
  const p = textPad(s);
  return { w: Math.max(2, m.w + p * 2), h: Math.max(2, m.h + p * 2) };
}

/** source key → which feed serves it (shared between sources) */
function feedKey(s: StudioSource): string | null {
  switch (s.kind) {
    case 'display':
    case 'window':
      return s.capture ? `cap:${s.capture}:${s.audio ? 1 : 0}` : s.kind === 'display' ? `cap:primary:${s.audio ? 1 : 0}` : null;
    case 'camera':
      return `cam:${s.device || 'default'}:${s.camRes || '1080'}`;
    case 'image':
      return s.path ? `img:${s.path}` : null;
    case 'media':
      return s.path ? `med:${s.id}:${s.path}` : null;
    default:
      return null;
  }
}

const audioKey = (a: AudioIn) => (a.kind === 'desktop' ? 'desk' : a.kind === 'mic' ? `mic:${a.device || 'default'}:${a.suppress ? 1 : 0}` : null);

/** MediaRecorder formats, safest first: Matroska / WebM survive a crash, MP4 is written at the end. */
function pickRecorder(codec: 'h264' | 'vp9' | 'av1') {
  const by: Record<string, string[]> = {
    h264: ['video/x-matroska;codecs=avc1,opus', 'video/webm;codecs=h264,opus', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2'],
    vp9: ['video/webm;codecs=vp9,opus'],
    av1: ['video/webm;codecs=av01,opus', 'video/webm;codecs=av1,opus'],
  };
  const order = [...by[codec], ...by.h264, ...by.vp9, 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const m of order) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return { mime: m, ext: m.startsWith('video/mp4') ? 'mp4' : m.includes('matroska') ? 'mkv' : 'webm' };
  }
  return null;
}

export const encoderName = (mime: string) =>
  /avc1|h264/.test(mime) ? 'H.264' : /vp9/.test(mime) ? 'VP9' : /av0?1/.test(mime) ? 'AV1' : /vp8/.test(mime) ? 'VP8' : mime || '—';

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
};

/** Match a KeyboardEvent against an Electron accelerator ("Ctrl+Shift+F9"). */
export function matchAccel(e: KeyboardEvent, accel: string) {
  if (!accel) return false;
  const parts = accel.split('+').map((x) => x.trim().toLowerCase());
  const key = parts.pop()!;
  const want = { ctrl: parts.includes('ctrl') || parts.includes('control') || parts.includes('commandorcontrol') || parts.includes('cmdorctrl'), shift: parts.includes('shift'), alt: parts.includes('alt') };
  if (e.ctrlKey !== want.ctrl || e.shiftKey !== want.shift || e.altKey !== want.alt) return false;
  const k = e.key.toLowerCase();
  return k === key || (key === 'space' && k === ' ') || e.code.toLowerCase() === key || e.code.toLowerCase() === 'key' + key || e.code.toLowerCase() === 'digit' + key;
}

/** KeyboardEvent → Electron accelerator (for the hotkey settings). */
export function accelFrom(e: KeyboardEvent): string | null {
  const k = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean) as string[];
  let key = k.length === 1 ? k.toUpperCase() : k;
  if (k === ' ') key = 'Space';
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  if (/^F\d{1,2}$/.test(k)) key = k;
  return [...mods, key].join('+');
}

class StudioEngine {
  program = document.createElement('canvas');
  previewCv = document.createElement('canvas');
  private pctx = this.program.getContext('2d', { alpha: false })!;
  private vctx = this.previewCv.getContext('2d', { alpha: false })!;
  private sceneCvs = new Map<string, HTMLCanvasElement>();
  private feeds = new Map<string, Feed>();
  private textCache = new Map<string, { key: string; cv: HTMLCanvasElement }>();
  private keyCvs = new Map<string, HTMLCanvasElement>();
  private actx: AudioContext | null = null;
  private master: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private strips = new Map<string, Strip>();
  private captured: MediaStream | null = null;
  private capturedFps = 0;
  private timer = 0;
  private nextAt = 0;
  private frames = 0;
  private framesAt = 0;
  private lagged = 0;
  private metricsTimer = 0;
  private reconcileTimer = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private transition: { from: string; to: string; start: number; ms: number; kind: string } | null = null;
  private unsub: (() => void) | null = null;
  private offHotkey: (() => void) | null = null;
  private offClose: (() => void) | null = null;
  /** studio screen is open */
  ui = false;
  active = false;

  /* recording */
  private rec: MediaRecorder | null = null;
  private recId = '';
  private recWrites: Promise<unknown> = Promise.resolve();
  private recStart = 0;
  private pausedFor = 0;
  private pauseAt = 0;
  private recBytes = 0;
  private recTracks: MediaStreamTrack[] = [];
  private cancelCountdown = false;
  private bytesWindow: { t: number; b: number }[] = [];

  /* streaming */
  private srec: MediaRecorder | null = null;
  private sWrites: Promise<unknown> = Promise.resolve();
  private sTracks: MediaStreamTrack[] = [];
  private offStats: (() => void) | null = null;
  private offEnd: (() => void) | null = null;

  /* ------------------------------------------------------------ lifecycle */

  async open() {
    this.ui = true;
    await this.activate();
  }

  close() {
    this.ui = false;
    if (!this.busy()) this.deactivate();
  }

  busy() {
    const st = sget().status;
    return st.rec !== 'idle' || st.stream !== 'idle';
  }

  private async activate() {
    if (this.active) return;
    this.active = true;
    await loadStudio();
    this.audioCtx();
    this.resize();
    this.nextAt = performance.now();
    this.framesAt = this.nextAt;
    this.loop();
    this.unsub = useStudio.subscribe((s, prev) => {
      if (s.scenes !== prev.scenes || s.audio !== prev.audio || s.settings !== prev.settings) this.scheduleReconcile();
      if (s.settings !== prev.settings) {
        this.resize();
        if (s.settings.hideSelf !== prev.settings.hideSelf) window.cv.invoke('studio:protect', s.settings.hideSelf);
        if (s.settings.hotkeys !== prev.settings.hotkeys || s.settings.hotkeysGlobal !== prev.settings.hotkeysGlobal) this.registerHotkeys();
      }
      if (s.audio !== prev.audio) this.updateStrips();
    });
    this.offHotkey = window.cv.on('studio:hotkey', (a: HotkeyAction) => this.hotkey(a));
    this.offClose = window.cv.on('studio:closeRequest', async () => {
      await this.stopAll();
      await window.cv.invoke('studio:busy', false);
      window.cv.invoke('studio:close');
    });
    window.cv.invoke('studio:protect', sget().settings.hideSelf);
    this.registerHotkeys();
    this.metricsTimer = window.setInterval(() => this.metrics(), 1000);
    patchStatus({ active: true });
    await this.reconcile();
    this.recover();
  }

  deactivate() {
    if (!this.active || this.busy()) return;
    this.active = false;
    clearTimeout(this.timer);
    clearInterval(this.metricsTimer);
    clearTimeout(this.reconcileTimer);
    this.unsub?.();
    this.offHotkey?.();
    this.offClose?.();
    this.unsub = this.offHotkey = this.offClose = null;
    for (const k of [...this.feeds.keys()]) this.release(k);
    for (const id of [...this.strips.keys()]) this.dropStrip(id);
    this.captured?.getTracks().forEach((t) => t.stop());
    this.captured = null;
    this.actx?.close().catch(() => {});
    this.actx = this.master = this.dest = null;
    window.cv.invoke('studio:protect', false);
    window.cv.invoke('studio:hotkeys', {});
    patchStatus({ active: false, fps: 0 });
  }

  private resize() {
    const { width: W, height: H } = sget().settings;
    for (const cv of [this.program, this.previewCv, ...this.sceneCvs.values()]) {
      if (cv.width !== W || cv.height !== H) {
        cv.width = W;
        cv.height = H;
      }
    }
  }

  /* ------------------------------------------------------------ feeds */

  private scheduleReconcile() {
    clearTimeout(this.reconcileTimer);
    this.reconcileTimer = window.setTimeout(() => this.reconcile(), 120);
  }

  /** open what the scenes and the mixer need, close the rest (one at a time: screen picks are sequential) */
  reconcile() {
    const run = async () => {
      if (!this.active) return;
      const s = sget();
      const want = new Map<string, () => Promise<Feed>>();
      for (const sc of s.scenes) for (const x of sc.sources) {
        const k = feedKey(x);
        if (k && !want.has(k)) want.set(k, () => this.openFeed(k, x));
      }
      for (const a of s.audio) {
        const k = audioKey(a);
        if (k && !want.has(k)) want.set(k, () => this.openAudioFeed(k, a));
      }
      for (const k of [...this.feeds.keys()]) if (!want.has(k)) this.release(k);
      for (const [k, open] of want) {
        if (this.feeds.has(k) || !this.active) continue;
        try {
          const f = await open();
          if (!this.active || !useStudioWants(k)) {
            stopFeed(f);
            continue;
          }
          this.feeds.set(k, f);
          this.setError(k, '');
        } catch (e) {
          this.setError(k, errText(e));
        }
      }
      this.updateStrips();
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  private setError(k: string, msg: string) {
    const errors = sget().errors;
    if ((errors[k] || '') === msg) return;
    const next = { ...errors };
    if (msg) next[k] = msg;
    else delete next[k];
    sset({ errors: next });
  }

  errorFor(s: StudioSource) {
    const k = feedKey(s);
    if (!k) return s.kind === 'window' ? 'Bir pencere seç' : s.kind === 'image' || s.kind === 'media' ? 'Dosya seç' : '';
    return sget().errors[k] || '';
  }

  private release(k: string) {
    const f = this.feeds.get(k);
    if (!f) return;
    this.feeds.delete(k);
    stopFeed(f);
  }

  private async primaryScreen() {
    const list = await window.cv.invoke<{ id: string; name: string; screen: boolean }[]>('screen:sources', false);
    return list.find((x) => x.screen)?.id || list[0]?.id || '';
  }

  private async openFeed(k: string, s: StudioSource): Promise<Feed> {
    const fps = sget().settings.fps;
    if (s.kind === 'display' || s.kind === 'window') {
      let id = s.capture || '';
      if (s.kind === 'display' && !id) id = await this.primaryScreen();
      else if (s.kind === 'window') {
        // window ids change between sessions: find it again by its title
        const list = await window.cv.invoke<{ id: string; name: string }[]>('screen:sources');
        if (!list.some((x) => x.id === id) && s.captureName) id = list.find((x) => x.name === s.captureName)?.id || id;
      }
      await window.cv.invoke('screen:select', id, !!s.audio);
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: fps, max: fps } }, audio: !!s.audio });
      return this.videoFeed(k, stream, !!s.audio);
    }
    if (s.kind === 'camera') {
      const r = s.camRes === '720' ? [1280, 720] : s.camRes === '2160' ? [3840, 2160] : [1920, 1080];
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: s.device ? { exact: s.device } : undefined, width: { ideal: r[0] }, height: { ideal: r[1] }, frameRate: { ideal: fps } },
      });
      return this.videoFeed(k, stream, false);
    }
    if (s.kind === 'image') {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = mediaUrl(s.path!);
      await img.decode().catch(() => {
        throw new Error('Görsel açılamadı');
      });
      return { key: k, el: img, ready: true };
    }
    // video file
    const el = document.createElement('video');
    el.crossOrigin = 'anonymous';
    el.loop = s.loop !== false;
    el.playsInline = true;
    el.preload = 'auto';
    el.src = mediaUrl(s.path!);
    const f: Feed = { key: k, el, ready: false };
    await new Promise<void>((ok, bad) => {
      el.onloadeddata = () => ok();
      el.onerror = () => bad(new Error('Video açılamadı'));
    });
    f.ready = true;
    const actx = this.audioCtx();
    f.audio = actx.createMediaElementSource(el);
    el.play().catch(() => {});
    return f;
  }

  private async videoFeed(k: string, stream: MediaStream, withAudio: boolean): Promise<Feed> {
    const el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.srcObject = new MediaStream(stream.getVideoTracks());
    const f: Feed = { key: k, el, stream, ready: false };
    el.onloadeddata = () => (f.ready = true);
    await el.play().catch(() => {});
    if (withAudio && stream.getAudioTracks().length) f.audio = this.audioCtx().createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    return f;
  }

  private async openAudioFeed(k: string, a: AudioIn): Promise<Feed> {
    const actx = this.audioCtx();
    let stream: MediaStream;
    if (a.kind === 'desktop') {
      // system sound comes with a screen capture ("loopback"); keep that picture tiny and slow
      await window.cv.invoke('screen:select', await this.primaryScreen(), true);
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: 320 }, height: { max: 180 }, frameRate: { max: 1 } }, audio: true });
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('Bilgisayar sesi alınamadı');
      }
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: a.device ? { exact: a.device } : undefined, noiseSuppression: a.suppress, echoCancellation: false, autoGainControl: false },
      });
    }
    return { key: k, el: new Image(), stream, audio: actx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())), ready: true };
  }

  /** drawable + size for a source, null while loading */
  private media(s: StudioSource): { el: CanvasImageSource; w: number; h: number } | null {
    const k = feedKey(s);
    const f = k ? this.feeds.get(k) : undefined;
    if (!f) return null;
    if (f.el instanceof HTMLImageElement) return f.el.naturalWidth ? { el: f.el, w: f.el.naturalWidth, h: f.el.naturalHeight } : null;
    const v = f.el;
    if (v.readyState < 2 || !v.videoWidth) return null;
    return { el: v, w: v.videoWidth, h: v.videoHeight };
  }

  /** intrinsic size of a source (for fitting / aspect lock), null if unknown yet */
  naturalSize(s: StudioSource): { w: number; h: number } | null {
    if (s.kind === 'text' && s.text) return textNatural(s.text);
    if (s.kind === 'color') return { w: s.w, h: s.h };
    const m = this.media(s);
    if (!m) return null;
    return { w: m.w * (1 - s.crop.l - s.crop.r), h: m.h * (1 - s.crop.t - s.crop.b) };
  }

  /** media sources: restart, play / pause */
  mediaControl(s: StudioSource, cmd: 'restart' | 'toggle') {
    const k = feedKey(s);
    const el = k ? this.feeds.get(k)?.el : null;
    if (!(el instanceof HTMLVideoElement)) return;
    if (cmd === 'restart') {
      el.currentTime = 0;
      el.play().catch(() => {});
    } else if (el.paused) el.play().catch(() => {});
    else el.pause();
  }

  /* ------------------------------------------------------------ compositor */

  private loop = () => {
    if (!this.active) return;
    const fps = sget().settings.fps;
    const step = 1000 / fps;
    const now = performance.now();
    try {
      this.render(now);
    } catch (e) {
      console.error(e);
    }
    this.frames++;
    if (now - this.framesAt >= 1000) {
      patchStatus({ fps: Math.round((this.frames * 1000) / (now - this.framesAt)), lagged: this.lagged });
      this.frames = 0;
      this.framesAt = now;
    }
    this.nextAt += step;
    const late = performance.now() - this.nextAt;
    if (late > step) {
      // we fell behind (busy machine): count the frames we skipped and resync
      this.lagged += Math.floor(late / step);
      this.nextAt = performance.now() + step;
    }
    this.timer = window.setTimeout(this.loop, Math.max(0, this.nextAt - performance.now()));
  };

  private sceneCanvas(id: string) {
    let cv = this.sceneCvs.get(id);
    if (!cv) {
      cv = document.createElement('canvas');
      cv.width = this.program.width;
      cv.height = this.program.height;
      this.sceneCvs.set(id, cv);
    }
    return cv;
  }

  private render(now: number) {
    const s = sget();
    const W = this.program.width;
    const H = this.program.height;
    const scene = (id: string) => s.scenes.find((x) => x.id === id) || s.scenes[0];
    const fits: [string, Partial<StudioSource>][] = [];
    const t = this.transition;
    if (t) {
      const p = Math.min(1, (now - t.start) / t.ms);
      const a = this.sceneCanvas('A');
      const b = this.sceneCanvas('B');
      this.drawScene(a.getContext('2d')!, scene(t.from), W, H, fits);
      this.drawScene(b.getContext('2d')!, scene(t.to), W, H, fits);
      const ctx = this.pctx;
      const e = p * p * (3 - 2 * p);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      if (t.kind === 'slide') {
        ctx.drawImage(a, -e * W, 0);
        ctx.drawImage(b, (1 - e) * W, 0);
      } else if (t.kind === 'zoom') {
        ctx.drawImage(a, 0, 0);
        const z = 0.85 + 0.15 * e;
        ctx.globalAlpha = e;
        ctx.drawImage(b, (W - W * z) / 2, (H - H * z) / 2, W * z, H * z);
        ctx.globalAlpha = 1;
      } else {
        ctx.drawImage(a, 0, 0);
        ctx.globalAlpha = e;
        ctx.drawImage(b, 0, 0);
        ctx.globalAlpha = 1;
      }
      if (p >= 1) {
        this.transition = null;
        patchStatus({ transitioning: false });
      }
    } else this.drawScene(this.pctx, scene(s.program), W, H, fits);
    if (s.settings.studioMode) this.drawScene(this.vctx, scene(s.preview), W, H, fits);
    for (const [id, patch] of fits) updateSource(id, patch);
    this.gate(now);
  }

  private drawScene(ctx: CanvasRenderingContext2D, scene: StudioScene, W: number, H: number, fits: [string, Partial<StudioSource>][]) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    for (const src of scene.sources) {
      if (src.fit) {
        const fit = this.fitBox(src, W, H);
        if (fit) fits.push([src.id, fit]);
      }
      if (!src.visible || src.opacity <= 0.001 || src.w < 1 || src.h < 1) continue;
      this.drawSource(ctx, src);
    }
    ctx.restore();
  }

  /** first time a source's size is known: give its box the right aspect */
  private fitBox(s: StudioSource, W: number, H: number): Partial<StudioSource> | null {
    const n = this.naturalSize(s);
    if (!n || !n.w || !n.h) return null;
    const ar = n.w / n.h;
    if (s.fit === 'full') {
      const k = Math.min(W / n.w, H / n.h);
      const w = Math.round(n.w * k);
      const h = Math.round(n.h * k);
      return { fit: undefined, x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
    }
    if (s.fit === 'corner') {
      const h = Math.round(s.w / ar);
      return { fit: undefined, h, y: Math.min(s.y, H - h - Math.round(H * 0.04)) };
    }
    const k = Math.min(1, (W * 0.8) / n.w, (H * 0.8) / n.h);
    const w = Math.round(n.w * k);
    const h = Math.round(n.h * k);
    return { fit: undefined, x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
  }

  private textCanvas(s: StudioSource): HTMLCanvasElement | null {
    const st = s.text!;
    if (ensureFont(st) !== true) return this.textCache.get(s.id)?.cv || null;
    const w = Math.max(2, Math.round(s.w));
    const h = Math.max(2, Math.round(s.h));
    const key = JSON.stringify(st) + w + 'x' + h;
    const c = this.textCache.get(s.id);
    if (c && c.key === key) return c.cv;
    const cv = c?.cv || document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d')!;
    const n = textNatural(st);
    g.clearRect(0, 0, w, h);
    g.setTransform(w / n.w, 0, 0, h / n.h, w / 2, h / 2);
    drawText(g, st);
    this.textCache.set(s.id, { key, cv });
    return cv;
  }

  private shapePath(ctx: CanvasRenderingContext2D, s: StudioSource, x: number, y: number, w: number, h: number) {
    ctx.beginPath();
    if (s.shape === 'circle') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (s.shape === 'rounded') ctx.roundRect(x, y, w, h, Math.min(s.radius, w / 2, h / 2));
    else ctx.rect(x, y, w, h);
  }

  private drawSource(ctx: CanvasRenderingContext2D, s: StudioSource) {
    let img: CanvasImageSource | null = null;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    let sh = 0;
    if (s.kind === 'text') {
      if (!s.text) return;
      img = this.textCanvas(s);
      if (!img) return;
      sw = (img as HTMLCanvasElement).width;
      sh = (img as HTMLCanvasElement).height;
    } else if (s.kind !== 'color') {
      const m = this.media(s);
      if (!m) return;
      sx = m.w * s.crop.l;
      sy = m.h * s.crop.t;
      sw = Math.max(1, m.w * (1 - s.crop.l - s.crop.r));
      sh = Math.max(1, m.h * (1 - s.crop.t - s.crop.b));
      img = m.el;
      if (s.chroma.on) {
        // key on a copy of the (cropped) frame, at most the size it is shown at
        let cv = this.keyCvs.get(s.id);
        if (!cv) this.keyCvs.set(s.id, (cv = document.createElement('canvas')));
        const kw = Math.max(2, Math.round(Math.min(sw, s.w)));
        const kh = Math.max(2, Math.round(Math.min(sh, s.h)));
        if (cv.width !== kw || cv.height !== kh) {
          cv.width = kw;
          cv.height = kh;
        }
        const g = cv.getContext('2d')!;
        g.clearRect(0, 0, kw, kh);
        g.drawImage(img, sx, sy, sw, sh, 0, 0, kw, kh);
        img = chromaKey(cv, s.chroma.color, s.chroma.similarity, s.chroma.smooth, s.chroma.spill);
        sx = 0;
        sy = 0;
        sw = kw;
        sh = kh;
      }
    }
    ctx.save();
    ctx.globalAlpha = s.opacity;
    ctx.translate(s.x, s.y);
    if (s.mirror) {
      ctx.translate(s.w, 0);
      ctx.scale(-1, 1);
    }
    const shaped = s.shape !== 'rect';
    if (shaped) {
      this.shapePath(ctx, s, 0, 0, s.w, s.h);
      ctx.save();
      ctx.clip();
    }
    const f: string[] = [];
    if (Math.abs(s.brightness - 1) > 0.005) f.push(`brightness(${s.brightness})`);
    if (Math.abs(s.contrast - 1) > 0.005) f.push(`contrast(${s.contrast})`);
    if (Math.abs(s.saturation - 1) > 0.005) f.push(`saturate(${s.saturation})`);
    if (f.length) ctx.filter = f.join(' ');
    if (s.kind === 'color') {
      ctx.fillStyle = s.color || '#000';
      ctx.fillRect(0, 0, s.w, s.h);
    } else if (img) ctx.drawImage(img, sx, sy, sw, sh, 0, 0, s.w, s.h);
    ctx.filter = 'none';
    if (shaped) ctx.restore();
    if (s.border > 0) {
      ctx.lineWidth = s.border;
      ctx.strokeStyle = s.borderColor;
      const b = s.border / 2;
      this.shapePath(ctx, { ...s, radius: Math.max(0, s.radius - b) }, b, b, s.w - s.border, s.h - s.border);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Switch the program scene (with the chosen transition). */
  goLive(id: string) {
    const s = sget();
    if (!s.scenes.some((x) => x.id === id) || (id === s.program && !this.transition)) return;
    const kind = s.settings.transition;
    if (kind === 'cut' || s.settings.transitionMs < 30 || !this.active) {
      this.transition = null;
      sset({ program: id });
      return;
    }
    this.transition = { from: s.program, to: id, start: performance.now(), ms: s.settings.transitionMs, kind };
    patchStatus({ transitioning: true });
    sset({ program: id });
  }

  /** click on a scene: studio mode prepares it, otherwise it goes live */
  pickScene(id: string) {
    const s = sget();
    if (s.settings.studioMode) sset({ preview: id, selected: null });
    else {
      this.goLive(id);
      sset({ preview: id, selected: null });
    }
  }

  /** studio mode: send the preview to program */
  transitionNow() {
    const s = sget();
    this.goLive(s.preview);
  }

  /* ------------------------------------------------------------ audio */

  private audioCtx() {
    if (!this.actx) {
      this.actx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      this.master = this.actx.createGain();
      this.dest = this.actx.createMediaStreamDestination();
      this.dest.channelCount = 2;
      this.master.connect(this.dest);
    }
    if (this.actx.state === 'suspended') this.actx.resume().catch(() => {});
    return this.actx;
  }

  private inputFor(a: AudioIn): AudioNode | null {
    if (a.kind === 'source') {
      const src = sget().scenes.flatMap((sc) => sc.sources).find((x) => x.id === a.sourceId);
      const k = src && feedKey(src);
      return (k && this.feeds.get(k)?.audio) || null;
    }
    const k = audioKey(a);
    return (k && this.feeds.get(k)?.audio) || null;
  }

  private dropStrip(id: string) {
    const st = this.strips.get(id);
    if (!st) return;
    for (const n of [...st.nodes, st.delay, st.gain, st.gate, st.fader, st.monitor, st.pre, st.post]) {
      try {
        n.disconnect();
      } catch {}
    }
    this.strips.delete(id);
  }

  /** (re)wire strips whose topology changed, update parameters of the others */
  private updateStrips() {
    if (!this.actx || !this.master) return;
    const actx = this.actx;
    const audio = sget().audio;
    for (const id of [...this.strips.keys()]) if (!audio.some((a) => a.id === id)) this.dropStrip(id);
    for (const a of audio) {
      const input = this.inputFor(a);
      const sig = `${nodeId(input)}|${a.comp}`;
      let st = this.strips.get(a.id);
      if (st && st.sig !== sig) {
        this.dropStrip(a.id);
        st = undefined;
      }
      if (!st) {
        if (!input) continue;
        const delay = actx.createDelay(2);
        const gain = actx.createGain();
        const gate = actx.createGain();
        const fader = actx.createGain();
        const monitor = actx.createGain();
        const pre = actx.createAnalyser();
        const post = actx.createAnalyser();
        pre.fftSize = post.fftSize = 2048;
        const nodes: AudioNode[] = [];
        input.connect(delay);
        delay.connect(gain);
        let tail: AudioNode = gain;
        if (a.comp) {
          const c = actx.createDynamicsCompressor();
          c.threshold.value = -24;
          c.knee.value = 12;
          c.ratio.value = 4;
          c.attack.value = 0.005;
          c.release.value = 0.15;
          tail.connect(c);
          tail = c;
          nodes.push(c);
        }
        tail.connect(pre);
        tail.connect(gate);
        gate.connect(fader);
        fader.connect(post);
        fader.connect(this.master);
        fader.connect(monitor);
        monitor.connect(actx.destination);
        st = { sig, nodes, delay, gain, gate, fader, monitor, pre, post, buf: new Float32Array(2048) as Float32Array<ArrayBuffer>, holdUntil: 0 };
        this.strips.set(a.id, st);
      }
      const t = actx.currentTime;
      st.delay.delayTime.setTargetAtTime(Math.min(2, Math.max(0, a.offset / 1000)), t, 0.01);
      st.gain.gain.setTargetAtTime(dbToGain(a.gain), t, 0.01);
      st.fader.gain.setTargetAtTime(a.muted ? 0 : dbToGain(a.volume), t, 0.01);
      st.monitor.gain.setTargetAtTime(a.monitor ? 1 : 0, t, 0.01);
      if (!a.gate.on) st.gate.gain.setTargetAtTime(1, t, 0.01);
    }
  }

  private rms(an: AnalyserNode, buf: Float32Array<ArrayBuffer>) {
    an.getFloatTimeDomainData(buf);
    let s = 0;
    let p = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      s += v * v;
      const a = v < 0 ? -v : v;
      if (a > p) p = a;
    }
    const r = Math.sqrt(s / buf.length);
    return { rms: r > 1e-6 ? 20 * Math.log10(r) : -120, peak: p > 1e-6 ? 20 * Math.log10(p) : -120 };
  }

  /** noise gate: open above the threshold, hold 200 ms, release 150 ms */
  private gate(now: number) {
    if (!this.actx) return;
    for (const a of sget().audio) {
      if (!a.gate.on) continue;
      const st = this.strips.get(a.id);
      if (!st) continue;
      const { rms } = this.rms(st.pre, st.buf);
      const t = this.actx.currentTime;
      if (rms >= a.gate.threshold) {
        st.holdUntil = now + 200;
        st.gate.gain.setTargetAtTime(1, t, 0.005);
      } else if (now > st.holdUntil) st.gate.gain.setTargetAtTime(0, t, 0.05);
    }
  }

  /** post-fader levels for the meters (dBFS) */
  levels(): Record<string, Level> {
    const out: Record<string, Level> = {};
    for (const [id, st] of this.strips) out[id] = this.rms(st.post, st.buf);
    return out;
  }

  hasInput(a: AudioIn) {
    return this.strips.has(a.id);
  }

  toggleMicMute() {
    const mics = sget().audio.filter((a) => a.kind === 'mic');
    if (!mics.length) return;
    const mute = !mics.every((a) => a.muted);
    sset((s) => ({ audio: s.audio.map((a) => (a.kind === 'mic' ? { ...a, muted: mute } : a)) }));
    toast(mute ? 'Mikrofon susturuldu' : 'Mikrofon açık');
  }

  /* ------------------------------------------------------------ output */

  /** program picture + mixer sound, as fresh tracks for one consumer */
  private outputTracks() {
    const fps = sget().settings.fps;
    if (!this.captured || this.capturedFps !== fps || this.captured.getVideoTracks()[0]?.readyState !== 'live') {
      this.captured?.getTracks().forEach((t) => t.stop());
      this.captured = this.program.captureStream(fps);
      this.capturedFps = fps;
    }
    this.audioCtx();
    const v = this.captured.getVideoTracks()[0].clone();
    const a = this.dest!.stream.getAudioTracks()[0].clone();
    return [v, a];
  }

  private elapsed() {
    if (!this.recStart) return 0;
    const paused = this.pausedFor + (this.pauseAt ? performance.now() - this.pauseAt : 0);
    return (performance.now() - this.recStart - paused) / 1000;
  }

  async startRecording() {
    const s = sget();
    if (s.status.rec !== 'idle') return;
    if (!this.active) await this.activate();
    const enc = pickRecorder(s.settings.codec);
    if (!enc) {
      toast('Bu bilgisayarda kayıt kodlayıcısı bulunamadı', 'error');
      return;
    }
    this.cancelCountdown = false;
    for (let n = s.settings.countdown; n > 0; n--) {
      patchStatus({ rec: 'countdown', countdown: n });
      await sleep(1000);
      if (this.cancelCountdown) {
        patchStatus({ rec: 'idle', countdown: 0 });
        return;
      }
    }
    try {
      const dir = s.settings.folder || (await window.cv.invoke<string>('studio:defaultDir'));
      const { id } = await window.cv.invoke<{ id: string; path: string }>('studio:recBegin', dir, `Cutven ${stamp()}`, enc.ext);
      this.recId = id;
      this.recTracks = this.outputTracks();
      const kbps = videoKbps(sget().settings);
      const rec = new MediaRecorder(new MediaStream(this.recTracks), {
        mimeType: enc.mime,
        videoBitsPerSecond: kbps * 1000,
        audioBitsPerSecond: sget().settings.audioKbps * 1000,
        // a keyframe every 2 s keeps the file easy to seek and cut
        videoKeyFrameIntervalDuration: 2000,
      } as MediaRecorderOptions);
      this.recBytes = 0;
      this.bytesWindow = [];
      this.recWrites = Promise.resolve();
      rec.ondataavailable = (e) => {
        if (!e.data.size) return;
        this.recBytes += e.data.size;
        const rid = this.recId;
        this.recWrites = this.recWrites.then(async () => window.cv.invoke('studio:recChunk', rid, new Uint8Array(await e.data.arrayBuffer())));
      };
      rec.onerror = (e: any) => {
        toast('Kayıt hatası: ' + errText(e?.error || e), 'error');
        this.stopRecording();
      };
      rec.start(1000);
      this.rec = rec;
      this.recStart = performance.now();
      this.pausedFor = 0;
      this.pauseAt = 0;
      patchStatus({ rec: 'recording', countdown: 0, recSecs: 0, recBytes: 0, encoder: encoderName(enc.mime) });
      window.cv.invoke('studio:busy', true);
      if (sget().settings.minimize) window.cv.invoke('studio:minimize');
    } catch (e) {
      this.recTracks.forEach((t) => t.stop());
      this.recTracks = [];
      patchStatus({ rec: 'idle', countdown: 0 });
      toast('Kayıt başlatılamadı: ' + errText(e), 'error');
    }
  }

  pauseRecording() {
    const st = sget().status.rec;
    if (!this.rec) return;
    if (st === 'recording') {
      this.rec.pause();
      this.pauseAt = performance.now();
      patchStatus({ rec: 'paused' });
    } else if (st === 'paused') {
      this.rec.resume();
      this.pausedFor += performance.now() - this.pauseAt;
      this.pauseAt = 0;
      patchStatus({ rec: 'recording' });
    }
  }

  async stopRecording() {
    const st = sget().status.rec;
    if (st === 'countdown') {
      this.cancelCountdown = true;
      return;
    }
    const rec = this.rec;
    if (!rec || st === 'saving') return;
    this.rec = null;
    const secs = this.elapsed();
    patchStatus({ rec: 'saving' });
    await new Promise<void>((r) => {
      if (rec.state === 'inactive') return r();
      rec.onstop = () => r();
      rec.stop();
    });
    await this.recWrites;
    this.recTracks.forEach((t) => t.stop());
    this.recTracks = [];
    this.recStart = 0;
    const s = sget().settings;
    try {
      const r = await window.cv.invoke<{ path: string; bytes: number }>('studio:recEnd', this.recId, { format: s.format, audioKbps: s.audioKbps });
      sset((x) => ({ recordings: [{ path: r.path, at: Date.now(), secs, bytes: r.bytes }, ...x.recordings].slice(0, 40) }));
      const name = r.path.split(/[\\/]/).pop();
      if (s.addToProject && appGet().project) {
        await addRecordingToProject(r.path);
        toast(`Kayıt projeye eklendi: ${name}`, 'success');
      } else toast(`Kayıt kaydedildi: ${name}`, 'success');
    } catch (e) {
      toast('Kayıt kaydedilemedi: ' + errText(e), 'error');
    }
    patchStatus({ rec: 'idle', recSecs: 0, recBytes: 0, recKbps: 0 });
    this.afterOutput();
  }

  toggleRecording() {
    const st = sget().status.rec;
    if (st === 'idle') this.startRecording();
    else this.stopRecording();
  }

  async startStream() {
    const s = sget();
    if (s.status.stream !== 'idle') return;
    if (!this.active) await this.activate();
    const cfg = await window.cv.invoke<{ hasKey: boolean }>('live:config');
    if (!cfg.hasKey) {
      toast('Önce Ayarlar › Yayın bölümünden yayın anahtarını gir', 'error');
      sset({ settingsOpen: true });
      return;
    }
    const mime = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    patchStatus({ stream: 'starting', streamSecs: 0, streamKbps: 0 });
    try {
      await window.cv.invoke('live:start', { videoKbps: s.settings.streamKbps, fps: s.settings.fps });
    } catch (e) {
      patchStatus({ stream: 'idle' });
      toast('Yayın başlatılamadı: ' + errText(e), 'error');
      return;
    }
    this.sTracks = this.outputTracks();
    const rec = new MediaRecorder(new MediaStream(this.sTracks), { mimeType: mime, videoBitsPerSecond: s.settings.streamKbps * 1500, audioBitsPerSecond: 192000 });
    this.sWrites = Promise.resolve();
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      this.sWrites = this.sWrites.then(async () => window.cv.invoke('live:chunk', new Uint8Array(await e.data.arrayBuffer())));
    };
    this.offStats = window.cv.on('live:stats', (d: { kbps: number; secs: number }) => patchStatus({ streamKbps: d.kbps, streamSecs: d.secs }));
    this.offEnd = window.cv.on('live:ended', (d: { error?: string | null }) => {
      if (d.error) toast('Yayın durdu: ' + d.error, 'error');
      this.cleanupStream();
    });
    rec.start(250);
    this.srec = rec;
    patchStatus({ stream: 'live' });
    window.cv.invoke('studio:busy', true);
  }

  private cleanupStream() {
    const rec = this.srec;
    this.srec = null;
    if (rec) {
      rec.ondataavailable = null;
      if (rec.state !== 'inactive') rec.stop();
    }
    this.sTracks.forEach((t) => t.stop());
    this.sTracks = [];
    this.offStats?.();
    this.offEnd?.();
    this.offStats = this.offEnd = null;
    patchStatus({ stream: 'idle', streamSecs: 0, streamKbps: 0 });
    this.afterOutput();
  }

  async stopStream() {
    if (sget().status.stream !== 'live') return;
    patchStatus({ stream: 'stopping' });
    const rec = this.srec;
    await new Promise<void>((r) => {
      if (!rec || rec.state === 'inactive') return r();
      rec.onstop = () => r();
      rec.stop();
    });
    await this.sWrites;
    await window.cv.invoke('live:stop');
    this.cleanupStream();
  }

  toggleStream() {
    if (sget().status.stream === 'idle') this.startStream();
    else this.stopStream();
  }

  async stopAll() {
    if (sget().status.rec !== 'idle') await this.stopRecording();
    if (sget().status.stream === 'live') await this.stopStream();
  }

  /** nothing goes out any more: release the busy flag (and the devices if the studio is closed) */
  private afterOutput() {
    if (this.busy()) return;
    window.cv.invoke('studio:busy', false);
    if (!this.ui) this.deactivate();
  }

  async screenshot() {
    try {
      const p = await window.cv.invoke<string>('studio:shot', this.program.toDataURL('image/png'));
      toast('Ekran görüntüsü kaydedildi: ' + p.split(/[\\/]/).pop(), 'success');
    } catch (e) {
      toast('Ekran görüntüsü kaydedilemedi: ' + errText(e), 'error');
    }
  }

  hotkey(a: HotkeyAction) {
    if (a === 'record') this.toggleRecording();
    else if (a === 'pause') this.pauseRecording();
    else if (a === 'stream') this.toggleStream();
    else if (a === 'mute') this.toggleMicMute();
    else if (a === 'shot') this.screenshot();
    else if (a === 'transition' && sget().settings.studioMode) this.transitionNow();
  }

  private async registerHotkeys() {
    const s = sget().settings;
    const map = s.hotkeysGlobal ? Object.fromEntries(Object.entries(s.hotkeys).filter(([, v]) => v)) : {};
    const failed = await window.cv.invoke<string[]>('studio:hotkeys', map).catch(() => [] as string[]);
    if (failed.length) toast(`Bu kısayollar başka bir uygulamada kullanılıyor: ${failed.join(', ')}`, 'error');
  }

  private async metrics() {
    const st = sget().status;
    const patch: Partial<typeof st> = {};
    if (this.rec && (st.rec === 'recording' || st.rec === 'paused')) {
      patch.recSecs = this.elapsed();
      patch.recBytes = this.recBytes;
      const now = performance.now();
      this.bytesWindow.push({ t: now, b: this.recBytes });
      while (this.bytesWindow.length > 6) this.bytesWindow.shift();
      const f = this.bytesWindow[0];
      patch.recKbps = now - f.t > 500 ? Math.round(((this.recBytes - f.b) * 8) / (now - f.t)) : st.recKbps;
    }
    try {
      const m = await window.cv.invoke<{ cpu: number }>('studio:metrics');
      patch.cpu = m.cpu;
      if (!this.diskAt || performance.now() - this.diskAt > 15000) {
        this.diskAt = performance.now();
        const dir = sget().settings.folder || (await window.cv.invoke<string>('studio:defaultDir'));
        patch.diskFree = await window.cv.invoke<number | null>('studio:disk', dir);
      }
    } catch {}
    patchStatus(patch);
  }
  private diskAt = 0;

  /** recordings cut short by a crash / power loss are finished on the next start */
  private async recover() {
    try {
      const dir = sget().settings.folder || (await window.cv.invoke<string>('studio:defaultDir'));
      const list = await window.cv.invoke<{ path: string; bytes: number }[]>('studio:recover', dir);
      if (!list.length) return;
      sset((x) => ({ recordings: [...list.map((r) => ({ path: r.path, at: Date.now(), secs: 0, bytes: r.bytes })), ...x.recordings].slice(0, 40) }));
      toast(`${list.length} yarım kalan kayıt kurtarıldı`, 'success');
    } catch {}
  }
}

function stopFeed(f: Feed) {
  f.stream?.getTracks().forEach((t) => t.stop());
  try {
    f.audio?.disconnect();
  } catch {}
  if (f.el instanceof HTMLVideoElement) {
    f.el.pause();
    f.el.srcObject = null;
    f.el.removeAttribute('src');
    f.el.load();
  }
}

/** is this feed key still needed by the current state? */
function useStudioWants(k: string) {
  const s = sget();
  for (const sc of s.scenes) for (const x of sc.sources) if (feedKey(x) === k) return true;
  return s.audio.some((a) => audioKey(a) === k);
}

/** Put a finished recording on the open project's timeline (new track, at the playhead). */
export async function addRecordingToProject(path: string) {
  const [m] = await importPaths([path]);
  if (m) addMediaToTimeline(m, { start: appGet().time, newTrack: true });
  return !!m;
}

export const studio = new StudioEngine();
export { feedKey };
