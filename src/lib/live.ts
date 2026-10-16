import { get, toast } from '../store';

/**
 * Live streaming scene: screen and/or camera + mic/system audio composed on a canvas,
 * encoded with MediaRecorder and piped to ffmpeg (RTMP) in the main process.
 * Lives outside React so the stream keeps running while you switch panels.
 */

export type LiveMode = 'screen' | 'camera' | 'both';
export type LiveQuality = '720' | '1080' | '1080_60';

export interface LiveOpts {
  mode: LiveMode;
  sourceId: string;
  camId: string;
  mic: boolean;
  sys: boolean;
  title: string;
  quality: LiveQuality;
  record: boolean;
  camCorner: 'br' | 'bl' | 'tr' | 'tl';
}

export interface LiveStats {
  secs: number;
  kbps: number;
  fps: number;
  speed: number;
}

const Q: Record<LiveQuality, { w: number; h: number; fps: number; kbps: number }> = {
  '720': { w: 1280, h: 720, fps: 30, kbps: 3000 },
  '1080': { w: 1920, h: 1080, fps: 30, kbps: 4500 },
  '1080_60': { w: 1920, h: 1080, fps: 60, kbps: 6800 },
};

class Live {
  status: 'idle' | 'preview' | 'live' | 'stopping' = 'idle';
  opts: LiveOpts = { mode: 'both', sourceId: '', camId: '', mic: true, sys: true, title: '', quality: '1080', record: true, camCorner: 'br' };
  stats: LiveStats | null = null;
  error = '';
  recordPath = '';
  canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private screen: MediaStream | null = null;
  private cam: MediaStream | null = null;
  private mic: MediaStream | null = null;
  private screenEl = document.createElement('video');
  private camEl = document.createElement('video');
  private timer = 0;
  private rec: MediaRecorder | null = null;
  private actx: AudioContext | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private offStats: (() => void) | null = null;
  private offEnd: (() => void) | null = null;

  constructor() {
    for (const v of [this.screenEl, this.camEl]) {
      v.muted = true;
      v.playsInline = true;
    }
  }

  on(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private emit() {
    for (const f of this.listeners) f();
  }

  set(patch: Partial<LiveOpts>) {
    const prev = this.opts;
    this.opts = { ...prev, ...patch };
    const needs = ['mode', 'sourceId', 'camId', 'sys'].some((k) => k in patch && (patch as any)[k] !== (prev as any)[k]);
    if (needs && this.status === 'preview') this.preview();
    this.emit();
  }

  private stopTracks() {
    for (const s of [this.screen, this.cam, this.mic]) s?.getTracks().forEach((t) => t.stop());
    this.screen = this.cam = this.mic = null;
  }

  /** Acquire sources and start drawing the scene. */
  async preview() {
    if (this.status === 'live') return;
    this.stopTracks();
    this.error = '';
    const o = this.opts;
    try {
      if (o.mode !== 'camera') {
        await window.cv.invoke('screen:select', o.sourceId, o.sys);
        this.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: o.sys });
        this.screenEl.srcObject = this.screen;
        await this.screenEl.play().catch(() => {});
      }
      if (o.mode !== 'screen') {
        this.cam = await navigator.mediaDevices.getUserMedia({ video: { deviceId: o.camId ? { exact: o.camId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } } });
        this.camEl.srcObject = this.cam;
        await this.camEl.play().catch(() => {});
      }
    } catch (e: any) {
      this.error = 'Kaynak açılamadı: ' + (e?.message || e);
      this.emit();
      return;
    }
    const q = Q[o.quality];
    this.canvas.width = q.w;
    this.canvas.height = q.h;
    clearInterval(this.timer);
    // setInterval (not rAF) keeps drawing while the window is minimised
    this.timer = window.setInterval(() => this.draw(), 1000 / q.fps);
    this.status = 'preview';
    this.emit();
  }

  private draw() {
    const { ctx, canvas: cv } = this;
    const W = cv.width;
    const H = cv.height;
    const o = this.opts;
    ctx.fillStyle = '#0b0b0d';
    ctx.fillRect(0, 0, W, H);
    const fit = (el: HTMLVideoElement, x: number, y: number, w: number, h: number, cover: boolean) => {
      const vw = el.videoWidth;
      const vh = el.videoHeight;
      if (!vw) return;
      const s = cover ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh);
      ctx.drawImage(el, x + (w - vw * s) / 2, y + (h - vh * s) / 2, vw * s, vh * s);
    };
    if (o.mode === 'camera') fit(this.camEl, 0, 0, W, H, true);
    else fit(this.screenEl, 0, 0, W, H, false);
    if (o.mode === 'both' && this.camEl.videoWidth) {
      const d = Math.round(H * 0.28);
      const m = Math.round(H * 0.035);
      const x = o.camCorner.endsWith('r') ? W - d - m : m;
      const y = o.camCorner.startsWith('b') ? H - d - m : m;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
      ctx.clip();
      fit(this.camEl, x, y, d, d, true);
      ctx.restore();
      ctx.lineWidth = Math.max(3, H * 0.004);
      ctx.strokeStyle = '#ff6a3d';
      ctx.beginPath();
      ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (o.title.trim()) {
      const fs = Math.round(H * 0.04);
      ctx.font = `700 ${fs}px Inter, sans-serif`;
      const tw = ctx.measureText(o.title).width;
      const pad = fs * 0.6;
      const bx = H * 0.035;
      const by = H - H * 0.035 - fs - pad * 2 - (o.mode === 'both' && o.camCorner === 'bl' ? H * 0.3 : 0);
      ctx.fillStyle = 'rgba(11,11,13,0.82)';
      ctx.beginPath();
      ctx.roundRect(bx, by, tw + pad * 2, fs + pad * 2, fs * 0.35);
      ctx.fill();
      ctx.fillStyle = '#ff6a3d';
      ctx.fillRect(bx, by, Math.max(4, fs * 0.15), fs + pad * 2);
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(o.title, bx + pad + fs * 0.1, by + pad + fs / 2);
    }
    if (this.status === 'live') {
      const fs = Math.round(H * 0.022);
      ctx.font = `800 ${fs}px Inter, sans-serif`;
      // small LIVE badge only in the local preview would leak into the stream, so nothing is drawn here
    }
  }

  async start(testFile?: string) {
    if (this.status === 'live') return;
    if (this.status !== 'preview') await this.preview();
    if (this.status !== 'preview') return;
    const o = this.opts;
    const q = Q[o.quality];
    const tracks: MediaStreamTrack[] = [...this.canvas.captureStream(q.fps).getVideoTracks()];
    const actx = new AudioContext({ sampleRate: 48000 });
    const dest = actx.createMediaStreamDestination();
    let hasAudio = false;
    if (this.screen?.getAudioTracks().length) {
      actx.createMediaStreamSource(new MediaStream(this.screen.getAudioTracks())).connect(dest);
      hasAudio = true;
    }
    if (o.mic) {
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true, echoCancellation: true } });
        actx.createMediaStreamSource(this.mic).connect(dest);
        hasAudio = true;
      } catch {
        toast('Mikrofon açılamadı, sessiz yayın', 'error');
      }
    }
    if (!hasAudio) {
      // silent track keeps the RTMP server happy
      const osc = actx.createOscillator();
      const g = actx.createGain();
      g.gain.value = 0;
      osc.connect(g).connect(dest);
      osc.start();
    }
    tracks.push(...dest.stream.getAudioTracks());
    this.actx = actx;
    try {
      await window.cv.invoke('live:start', { videoKbps: q.kbps, fps: q.fps, testFile });
    } catch (e: any) {
      this.error = String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      // nothing went live: release the canvas capture, audio graph and microphone
      tracks.forEach((t) => t.stop());
      actx.close().catch(() => {});
      this.actx = null;
      this.mic?.getTracks().forEach((t) => t.stop());
      this.mic = null;
      this.emit();
      return;
    }
    // local copy: the very same encoded stream, written straight to disk (only once the stream is up)
    this.recId = o.record ? (await window.cv.invoke<{ id: string; path: string }>('stream:begin', get().projectPath, 'Canlı yayın', 'webm')).id : '';
    const mime = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: q.kbps * 1500, audioBitsPerSecond: 192000 });
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      this.writes = this.writes.then(async () => {
        const bytes = new Uint8Array(await e.data.arrayBuffer());
        await window.cv.invoke('live:chunk', bytes);
        if (this.recId) await window.cv.invoke('stream:chunk', this.recId, bytes);
      });
    };
    this.offStats = window.cv.on('live:stats', (s) => {
      this.stats = s;
      this.emit();
    });
    this.offEnd = window.cv.on('live:ended', (d) => {
      if (d.error) {
        this.error = d.error;
        toast('Yayın durdu: ' + d.error, 'error');
      }
      this.finish();
    });
    rec.start(250);
    this.rec = rec;
    this.stats = { secs: 0, kbps: 0, fps: 0, speed: 0 };
    this.status = 'live';
    this.emit();
  }

  async stop() {
    if (this.status !== 'live') return;
    this.status = 'stopping';
    this.emit();
    await new Promise<void>((r) => {
      if (!this.rec || this.rec.state === 'inactive') return r();
      this.rec.onstop = () => r();
      this.rec.stop();
    });
    await this.writes;
    await window.cv.invoke('live:stop');
    this.finish();
  }

  private recId = '';

  private finish() {
    if (this.recId) {
      const id = this.recId;
      this.recId = '';
      this.writes.then(() => window.cv.invoke<string | null>('stream:end', id)).then((p) => {
        this.recordPath = p || '';
        if (p) toast('Yayın kaydı kaydedildi: Cutven Kayıtlar', 'success');
        this.emit();
      });
    }
    this.offStats?.();
    this.offEnd?.();
    this.offStats = this.offEnd = null;
    // the stream may have ended on its own (ffmpeg exit): stop the encoder, or its chunks would leak into the next stream
    const rec = this.rec;
    if (rec) {
      rec.ondataavailable = null;
      if (rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {}
      }
      rec.stream.getTracks().forEach((t) => t.stop());
    }
    this.rec = null;
    this.actx?.close().catch(() => {});
    this.actx = null;
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    if (this.status === 'live' || this.status === 'stopping') {
      this.status = 'preview';
    }
    this.emit();
  }

  /** Stop previewing (keeps nothing running). */
  release() {
    if (this.status === 'live' || this.status === 'stopping') return;
    clearInterval(this.timer);
    this.stopTracks();
    this.status = 'idle';
    this.emit();
  }
}

export const live = new Live();
