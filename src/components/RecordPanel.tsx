import { useEffect, useReducer, useRef } from 'react';
import { Mic, Pause, Play, Square, RotateCcw, SkipBack, Undo2, Check, Trash2, Headphones, AlertTriangle } from 'lucide-react';
import { useStore } from '../store';
import { recorder, SAMPLE_RATE } from '../lib/recorder';
import { formatChapter, formatDuration } from '../lib/util';
import { Slider, Toggle } from './ui';
import { Prompter, LivePace } from './Prompter';

function fmtRec(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const d = Math.floor((t % 1) * 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
}

function useRecorder() {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => recorder.onChange(force), []);
  return recorder;
}

/** Input level meter with peak hold, -60..0 dBFS. */
function Meter() {
  const ref = useRef<HTMLCanvasElement>(null);
  const dbRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let shown = 0;
    let hold = 0;
    let holdT = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = ref.current;
      if (!cv) return;
      const lvl = recorder.readLevel();
      const db = lvl > 0 ? 20 * Math.log10(lvl) : -100;
      const x = Math.max(0, Math.min(1, (db + 60) / 60));
      shown = x > shown ? x : shown * 0.92 + x * 0.08;
      const now = performance.now();
      if (x >= hold || now - holdT > 1200) {
        hold = x;
        holdT = now;
      }
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (cv.width !== w * dpr) {
        cv.width = w * dpr;
        cv.height = h * dpr;
      }
      const ctx = cv.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#1d1d22';
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, 4);
      ctx.fill();
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, '#3ddc97');
      g.addColorStop(0.7, '#3ddc97');
      g.addColorStop(0.85, '#ffcf4a');
      g.addColorStop(1, '#ff4d5e');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(0, 0, w * shown, h, 4);
      ctx.fill();
      ctx.fillStyle = hold > 0.95 ? '#ff4d5e' : '#ececf0';
      ctx.fillRect(Math.max(0, w * hold - 2), 0, 2, h);
      // -12 dB / -6 dB ticks
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      for (const t of [-48, -36, -24, -12, -6]) ctx.fillRect(Math.round(((t + 60) / 60) * w), 0, 1, h);
      if (dbRef.current) dbRef.current.textContent = db > -60 ? `${db.toFixed(0)} dB` : '−∞';
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="rec-meter">
      <canvas ref={ref} />
      <span ref={dbRef} className="db" />
    </div>
  );
}

/** Live scrolling waveform of the take being recorded. */
function LiveWave({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = ref.current;
      if (!cv) return;
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (cv.width !== w * dpr) {
        cv.width = w * dpr;
        cv.height = h * dpr;
      }
      const ctx = cv.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(0, h / 2, w, 1);
      const peaks = recorder.livePeaks;
      // newest at the right edge, 2px per 10 ms bucket
      const n = Math.floor(w / 2);
      const from = Math.max(0, peaks.length - n);
      ctx.fillStyle = active ? '#ff5a4f' : '#7d7d88';
      for (let i = from; i < peaks.length; i++) {
        const x = w - (peaks.length - i) * 2;
        const v = Math.sqrt(peaks[i]);
        const bh = Math.max(1, v * (h - 4));
        ctx.fillRect(x, (h - bh) / 2, 1.4, bh);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return <canvas ref={ref} className="rec-wave" />;
}

function TakeWave({ peaks }: { peaks: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#49c98f';
    const per = peaks.length / w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per) || i === Math.floor(x * per); i++) if (peaks[i] > v) v = peaks[i];
      const bh = Math.max(1, Math.sqrt(v) * h);
      ctx.fillRect(x, (h - bh) / 2, 1, bh);
    }
  }, [peaks]);
  return <canvas ref={ref} className="take-wave" />;
}

export default function RecordPanel() {
  const rec = useRecorder();
  const status = useStore((s) => s.rec.status);
  const countdown = useStore((s) => s.rec.countdown);
  const elapsed = useStore((s) => s.rec.elapsed);
  const start = useStore((s) => s.rec.start);
  const time = useStore((s) => s.time);
  const takes = useStore((s) => s.takes);
  const clips = useStore((s) => s.project?.clips);
  const s = rec.settings;
  const live = status === 'recording' || status === 'paused';

  useEffect(() => {
    recorder.acquire();
    return () => recorder.release();
  }, []);

  const label =
    status === 'countdown' ? 'Hazırlan…' : status === 'recording' ? 'Kaydediliyor' : status === 'paused' ? 'Duraklatıldı' : status === 'saving' ? 'Kaydediliyor…' : 'Kayda hazır';

  return (
    <div className="rec-panel">
      <div className="section-title">Seslendirme</div>

      <div className="row">
        <select
          className="field"
          value={s.deviceId}
          disabled={live || status === 'countdown'}
          onChange={(e) => rec.update({ deviceId: e.target.value })}
          title="Mikrofon"
        >
          <option value="">Varsayılan mikrofon</option>
          {rec.devices
            .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
            .map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Mikrofon'}
              </option>
            ))}
        </select>
      </div>
      <Meter />
      {rec.error && (
        <div className="rec-error">
          <AlertTriangle size={14} />
          <span>{rec.error}</span>
        </div>
      )}

      <div className={'rec-stage ' + status}>
        <button
          className={'rec-big ' + status}
          title={live ? 'Durdur ve kaydet (R)' : 'Kayda başla (R)'}
          onClick={() => recorder.toggle()}
          disabled={status === 'saving'}
        >
          {status === 'countdown' ? <span className="cd">{countdown}</span> : live ? <Square size={30} fill="currentColor" /> : <Mic size={34} />}
        </button>
        <div className="rec-time">{fmtRec(live || status === 'saving' ? elapsed : 0)}</div>
        <div className="rec-label">
          {status === 'recording' && <i className="dot" />}
          {label}
          {live && <span className="muted"> · {formatChapter(start)}'dan itibaren</span>}
        </div>
      </div>

      <div className="rec-transport">
        <button className="icon-btn" title="Kaydın başına sar" onClick={() => recorder.rewind()} disabled={status === 'recording'}>
          <SkipBack size={16} />
        </button>
        <button className="icon-btn" title="5 sn geri sar" onClick={() => recorder.skip(-5)} disabled={status === 'recording'}>
          <Undo2 size={16} />
        </button>
        <button
          className="icon-btn big"
          title={status === 'paused' ? 'Devam et' : 'Duraklat'}
          disabled={!live}
          onClick={() => (status === 'paused' ? recorder.resume() : recorder.pause())}
        >
          {status === 'paused' ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
        </button>
        <button className="icon-btn" title="Durdur" disabled={!live && status !== 'countdown'} onClick={() => recorder.stop()}>
          <Square size={15} fill="currentColor" />
        </button>
        <button className="icon-btn" title="Baştan al — son kaydı silip aynı yerden tekrar kaydet" disabled={status === 'countdown' || status === 'saving' || (!live && !takes.length)} onClick={() => recorder.retake()}>
          <RotateCcw size={16} />
        </button>
      </div>
      <LiveWave active={status === 'recording'} />
      <LivePace />
      <Prompter />
      {!live && status !== 'countdown' && (
        <p className="hint" style={{ textAlign: 'center', margin: '4px 0 0' }}>
          Kayıt oynatma imlecinden başlar ({formatChapter(time)}). <kbd>R</kbd> ile başlat/durdur.
        </p>
      )}

      <div className="group" style={{ marginTop: 14 }}>
        <div className="group-head">
          <h4>Kayıt ayarları</h4>
        </div>
        <Opt label="Kayıtta videoyu oynat" on={s.playVideo} onChange={(v) => rec.update({ playVideo: v })} />
        <Opt label="Kayıtta video sesini kapat" hint="Hoparlör kullanıyorsan açık bırak" on={s.muteVideo} onChange={(v) => rec.update({ muteVideo: v })} />
        <Opt label="3 sn geri sayım" on={s.countdown} onChange={(v) => rec.update({ countdown: v })} />
        <Opt label="Bitince videoya ekle" on={s.autoAdd} onChange={(v) => rec.update({ autoAdd: v })} />
        <Opt label="Gürültü engelleme" disabled={live} on={s.noiseSuppression} onChange={(v) => rec.update({ noiseSuppression: v })} />
        <Opt label="Yankı engelleme" disabled={live} on={s.echoCancellation} onChange={(v) => rec.update({ echoCancellation: v })} />
        <Opt label="Otomatik kazanç" disabled={live} on={s.autoGain} onChange={(v) => rec.update({ autoGain: v })} />
        <Slider label="Giriş kazancı" value={s.gain} min={0} max={3} step={0.05} def={1} mult={100} unit="%" onChange={(v) => rec.update({ gain: v })} />
      </div>

      <div className="group-head" style={{ marginTop: 4 }}>
        <h4>Kayıtlar</h4>
        {takes.length > 0 && <span className="muted">{takes.length}</span>}
      </div>
      {takes.length === 0 ? (
        <p className="hint">Henüz kayıt yok. Kırmızı düğmeye bas, video oynarken konuş.</p>
      ) : (
        <div className="takes">
          {[...takes].reverse().map((t) => {
            const onTimeline = !!t.clipId && !!clips?.some((c) => c.id === t.clipId);
            return (
              <div className="take" key={t.id}>
                <div className="take-top">
                  <b>{t.name}</b>
                  <span className="muted">
                    {formatChapter(t.start)} · {formatDuration(t.duration)}
                  </span>
                  {onTimeline && <span className="take-tag">Videoda</span>}
                </div>
                <TakeWave peaks={t.peaks} />
                <div className="take-actions">
                  <button className="icon-btn sm" title="Videoyla birlikte dinle" disabled={live} onClick={() => recorder.listen(t.id)}>
                    <Headphones size={14} />
                  </button>
                  {!onTimeline && (
                    <button className="btn sm" onClick={() => recorder.addTake(t.id)} disabled={live}>
                      <Check size={13} /> Videoya ekle
                    </button>
                  )}
                  <div className="spacer" />
                  <button className="icon-btn sm" title="Kaydı sil" disabled={live} onClick={() => recorder.removeTake(t.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="hint" style={{ marginTop: 10 }}>
        Kayıtlar proje klasöründe <b>Cutven Kayıtlar</b> içinde WAV ({SAMPLE_RATE / 1000} kHz) olarak saklanır.
      </p>
    </div>
  );
}

function Opt({ label, hint, on, onChange, disabled }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : undefined }} title={hint}>
      <span style={{ color: 'var(--text-2)' }}>{label}</span>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}
