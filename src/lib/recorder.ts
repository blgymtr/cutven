import { edit, get, set, toast, type RecState, type Take } from '../store';
import { engine } from './engine';
import { importPaths, removeMedia } from './media';
import { clipFromMedia, hasRoom, insertTrack } from './actions';
import { projectDuration, uid } from './util';

export const SAMPLE_RATE = 48000;
/** one live-waveform peak per 10 ms */
export const PEAK_SAMPLES = 480;

export interface RecSettings {
  deviceId: string;
  playVideo: boolean;
  muteVideo: boolean;
  countdown: boolean;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGain: boolean;
  gain: number;
  autoAdd: boolean;
}

const KEY = 'cutven.rec.v1';
const DEFAULTS: RecSettings = {
  deviceId: '',
  playVideo: true,
  muteVideo: true,
  countdown: true,
  noiseSuppression: true,
  echoCancellation: false,
  autoGain: false,
  gain: 1,
  autoAdd: true,
};

function loadSettings(): RecSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

const setRec = (patch: Partial<RecState>) => set({ rec: { ...get().rec, ...patch } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Recorder {
  settings = loadSettings();
  devices: MediaDeviceInfo[] = [];
  error = '';
  /** peak level since last read (0..1) */
  private level = 0;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private gainNode: GainNode | null = null;
  private proc: ScriptProcessorNode | null = null;
  private openKey = '';
  private users = 0;
  private capturing = false;
  private cancelled = false;
  private pending: Int16Array[] = [];
  private pendingLen = 0;
  private writes: Promise<unknown> = Promise.resolve();
  private peakAcc = 0;
  private peakN = 0;
  private timer = 0;
  samples = 0;
  livePeaks: number[] = [];
  private cur: { id: string; path: string; start: number; name: string } | null = null;
  private listeners = new Set<() => void>();

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  readLevel() {
    const l = this.level;
    this.level = 0;
    return l;
  }

  get busy() {
    const st = get().rec.status;
    return st !== 'idle';
  }

  update(patch: Partial<RecSettings>) {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.settings));
    } catch {}
    if (this.gainNode && patch.gain != null) this.gainNode.gain.value = this.settings.gain;
    const needsReopen = ['deviceId', 'noiseSuppression', 'echoCancellation', 'autoGain'].some((k) => k in patch);
    if (needsReopen && this.users > 0 && !this.capturing) this.open(true);
    this.emit();
  }

  async refreshDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.devices = all.filter((d) => d.kind === 'audioinput');
    } catch {
      this.devices = [];
    }
    this.emit();
  }

  /** Panel mounted: keep the microphone open for the level meter. */
  acquire() {
    this.users++;
    this.open();
  }
  release() {
    this.users = Math.max(0, this.users - 1);
    setTimeout(() => {
      if (this.users === 0 && !this.busy) this.close();
    }, 300);
  }

  private async open(force = false) {
    const s = this.settings;
    const key = [s.deviceId, s.noiseSuppression, s.echoCancellation, s.autoGain].join('|');
    if (this.stream && this.openKey === key && !force) return true;
    this.close();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: s.deviceId ? { exact: s.deviceId } : undefined,
          channelCount: 1,
          noiseSuppression: s.noiseSuppression,
          echoCancellation: s.echoCancellation,
          autoGainControl: s.autoGain,
        },
      });
    } catch (e: any) {
      this.error =
        e?.name === 'NotAllowedError'
          ? 'Mikrofon izni yok. Windows Ayarlar → Gizlilik → Mikrofon bölümünden masaüstü uygulamalarına izin ver.'
          : e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError'
            ? 'Mikrofon bulunamadı. Bir mikrofon bağla ya da listeden başka bir giriş seç.'
            : 'Mikrofon açılamadı: ' + (e?.message || e);
      this.emit();
      return false;
    }
    this.error = '';
    this.openKey = key;
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    const src = ctx.createMediaStreamSource(this.stream);
    const gain = ctx.createGain();
    gain.gain.value = s.gain;
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0; // keeps the processor running without monitoring the mic
    src.connect(gain).connect(proc).connect(sink).connect(ctx.destination);
    proc.onaudioprocess = (e) => this.onData(e.inputBuffer.getChannelData(0));
    this.ctx = ctx;
    this.gainNode = gain;
    this.proc = proc;
    await ctx.resume();
    this.refreshDevices();
    this.emit();
    return true;
  }

  private close() {
    this.proc && (this.proc.onaudioprocess = null);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.proc = null;
    this.gainNode = null;
    this.openKey = '';
  }

  private onData(f32: Float32Array) {
    let peak = 0;
    for (let i = 0; i < f32.length; i++) {
      const v = Math.abs(f32[i]);
      if (v > peak) peak = v;
    }
    if (peak > this.level) this.level = peak;
    if (!this.capturing) return;
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const v = Math.max(-1, Math.min(1, f32[i]));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      const a = Math.abs(v);
      if (a > this.peakAcc) this.peakAcc = a;
      if (++this.peakN >= PEAK_SAMPLES) {
        this.livePeaks.push(this.peakAcc);
        this.peakAcc = 0;
        this.peakN = 0;
      }
    }
    this.samples += out.length;
    this.pending.push(out);
    this.pendingLen += out.length;
    if (this.pendingLen >= SAMPLE_RATE / 2) this.flush();
  }

  private flush() {
    if (!this.pendingLen || !this.cur) return;
    const all = new Int16Array(this.pendingLen);
    let o = 0;
    for (const p of this.pending) {
      all.set(p, o);
      o += p.length;
    }
    this.pending = [];
    this.pendingLen = 0;
    const id = this.cur.id;
    const bytes = new Uint8Array(all.buffer);
    this.writes = this.writes.then(() => window.cv.invoke('rec:chunk', id, bytes));
  }

  /* ------------------------------------------------------------ transport */

  async start() {
    const s = get();
    if (!s.project || this.busy) return;
    if (!(await this.open())) {
      toast(this.error, 'error');
      return;
    }
    if (engine.playing) engine.pause();
    this.cancelled = false;
    if (this.settings.countdown) {
      for (let n = 3; n >= 1; n--) {
        setRec({ status: 'countdown', countdown: n });
        await sleep(1000);
        if (this.cancelled) {
          setRec({ status: 'idle', countdown: 0 });
          return;
        }
      }
    }
    const { id, path } = await window.cv.invoke<{ id: string; path: string }>('rec:begin', s.projectPath, s.project.name);
    engine.muted = this.settings.muteVideo;
    if (this.settings.playVideo) engine.play();
    const start = get().time;
    const n = get().takes.length + 1;
    this.cur = { id, path, start, name: `Kayıt ${n}` };
    this.samples = 0;
    this.livePeaks = [];
    this.peakAcc = 0;
    this.peakN = 0;
    this.capturing = true;
    setRec({ status: 'recording', countdown: 0, start, elapsed: 0 });
    clearInterval(this.timer);
    this.timer = window.setInterval(() => setRec({ elapsed: this.samples / SAMPLE_RATE }), 100);
  }

  pause() {
    if (get().rec.status !== 'recording') return;
    this.capturing = false;
    this.flush();
    if (engine.playing) engine.pause();
    setRec({ status: 'paused', elapsed: this.samples / SAMPLE_RATE });
  }

  resume() {
    if (get().rec.status !== 'paused') return;
    const p = get().project!;
    if (this.settings.playVideo && get().time < projectDuration(p) - 0.05) engine.play();
    this.capturing = true;
    setRec({ status: 'recording' });
  }

  /** Cancel a countdown, or stop and keep the take. */
  async stop() {
    const st = get().rec.status;
    if (st === 'countdown') {
      this.cancelled = true;
      return;
    }
    if ((st !== 'recording' && st !== 'paused') || !this.cur) return;
    this.capturing = false;
    clearInterval(this.timer);
    this.flush();
    setRec({ status: 'saving' });
    if (engine.playing) engine.pause();
    engine.muted = false;
    await this.writes;
    const cur = this.cur;
    this.cur = null;
    const duration = this.samples / SAMPLE_RATE;
    if (duration < 0.2) {
      await window.cv.invoke('rec:discard', cur.id);
      setRec({ status: 'idle', elapsed: 0 });
      toast('Kayıt çok kısa, kaydedilmedi');
      return;
    }
    const path = await window.cv.invoke<string>('rec:end', cur.id, SAMPLE_RATE);
    const take: Take = { id: uid(), name: cur.name, path, start: cur.start, duration, peaks: this.livePeaks.slice() };
    set({ takes: [...get().takes, take] });
    setRec({ status: 'idle', elapsed: duration });
    if (this.settings.autoAdd) await this.addTake(take.id);
    else toast(`${take.name} hazır — eklemek için ✓`, 'success');
  }

  toggle() {
    const st = get().rec.status;
    if (st === 'idle') this.start();
    else if (st === 'saving') return;
    else this.stop();
  }

  /** Throw away the current (or last) take and record again from the same spot. */
  async retake() {
    const st = get().rec.status;
    let start: number;
    if (st === 'countdown') return;
    if (st === 'recording' || st === 'paused') {
      if (!this.cur) return;
      this.capturing = false;
      clearInterval(this.timer);
      this.pending = [];
      this.pendingLen = 0;
      if (engine.playing) engine.pause();
      engine.muted = false;
      await this.writes;
      await window.cv.invoke('rec:discard', this.cur.id);
      start = this.cur.start;
      this.cur = null;
      setRec({ status: 'idle', elapsed: 0 });
    } else {
      const last = get().takes[get().takes.length - 1];
      if (!last) return this.start();
      start = last.start;
      await this.removeTake(last.id);
    }
    engine.seek(start);
    await this.start();
  }

  /** Back to where the current/last take started. */
  rewind() {
    if (this.capturing) return;
    const s = get();
    const last = s.takes[s.takes.length - 1];
    const t = s.rec.status === 'paused' ? s.rec.start : last ? last.start : 0;
    engine.seek(t);
  }

  skip(dt: number) {
    if (this.capturing) return;
    engine.seek(get().time + dt);
  }

  /* ------------------------------------------------------------ takes */

  async addTake(id: string) {
    const take = get().takes.find((t) => t.id === id);
    if (!take || take.clipId) return;
    const [m] = await importPaths([take.path]);
    if (!m) return;
    let clipId = '';
    edit((d) => {
      const end = take.start + m.duration;
      let tr = d.tracks.find((t) => t.type === 'audio' && t.name.startsWith('Seslendirme') && !t.locked && hasRoom(d, t.id, take.start, end));
      if (!tr) {
        tr = insertTrack(d, 'audio');
        const n = d.tracks.filter((t) => t.name.startsWith('Seslendirme')).length;
        tr.name = n ? `Seslendirme ${n + 1}` : 'Seslendirme';
      }
      const c = clipFromMedia(m, tr.id, take.start);
      clipId = c.id;
      d.clips.push(c);
    });
    set({ takes: get().takes.map((t) => (t.id === id ? { ...t, clipId, mediaId: m.id } : t)), selection: [clipId] });
    toast(`${take.name} videoya eklendi`, 'success');
  }

  async removeTake(id: string) {
    const take = get().takes.find((t) => t.id === id);
    if (!take) return;
    const p = get().project;
    if (take.clipId) edit((d) => void (d.clips = d.clips.filter((c) => c.id !== take.clipId)));
    const stillUsed = p && take.mediaId && get().project!.clips.some((c) => c.mediaId === take.mediaId);
    if (take.mediaId && !stillUsed) removeMedia(take.mediaId);
    if (!stillUsed) await window.cv.invoke('rec:delete', take.path);
    set({ takes: get().takes.filter((t) => t.id !== id) });
  }

  /** Listen to a take together with the video from its start. */
  private audition: HTMLAudioElement | null = null;
  listen(id: string) {
    const take = get().takes.find((t) => t.id === id);
    if (!take || this.busy) return;
    this.stopListening();
    engine.seek(take.start);
    if (take.clipId && get().project?.clips.some((c) => c.id === take.clipId)) {
      engine.play(); // already on the timeline: normal playback
      return;
    }
    const a = new Audio('cvm://media/' + encodeURIComponent(take.path));
    this.audition = a;
    a.play().catch(() => {});
    engine.play();
    const stopWhenPaused = setInterval(() => {
      if (!engine.playing || a.ended) {
        clearInterval(stopWhenPaused);
        this.stopListening();
      }
    }, 100);
  }
  stopListening() {
    if (this.audition) {
      this.audition.pause();
      this.audition = null;
    }
  }

  reset() {
    if (this.cur) {
      window.cv.invoke('rec:discard', this.cur.id);
      this.cur = null;
    }
    this.capturing = false;
    clearInterval(this.timer);
    engine.muted = false;
    this.stopListening();
    set({ takes: [], rec: { status: 'idle', countdown: 0, start: 0, elapsed: 0 } });
    if (!this.users) this.close();
  }
}

export const recorder = new Recorder();
navigator.mediaDevices?.addEventListener?.('devicechange', () => recorder.refreshDevices());
