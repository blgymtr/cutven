import { useEffect, useRef, useState } from 'react';
import { X, Monitor, AppWindow, Circle, Square } from 'lucide-react';
import { useStore, set, get, toast } from '../store';
import { importPaths } from '../lib/media';
import { addMediaToTimeline } from '../lib/actions';
import { Toggle } from './ui';

interface Source {
  id: string;
  name: string;
  thumb: string;
  screen: boolean;
}

const fmt = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export default function CaptureDialog() {
  const mode = useStore((s) => s.captureOpen)!;
  const [sources, setSources] = useState<Source[]>([]);
  const [src, setSrc] = useState('');
  const [mic, setMic] = useState(true);
  const [sys, setSys] = useState(mode === 'screen');
  const [addToTimeline, setAdd] = useState(true);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [cam, setCam] = useState('');
  const [state, setState] = useState<'idle' | 'countdown' | 'rec' | 'saving'>('idle');
  const [cd, setCd] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const live = useRef<{ streams: MediaStream[]; rec: MediaRecorder | null; id: string; actx: AudioContext | null; writes: Promise<unknown> }>({
    streams: [],
    rec: null,
    id: '',
    actx: null,
    writes: Promise.resolve(),
  });

  const stopStreams = () => {
    live.current.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    live.current.streams = [];
    live.current.actx?.close().catch(() => {});
    live.current.actx = null;
  };

  useEffect(() => {
    if (mode === 'screen') {
      window.cv.invoke<Source[]>('screen:sources').then((l) => {
        setSources(l);
        setSrc(l.find((x) => x.screen)?.id || l[0]?.id || '');
      });
    } else {
      navigator.mediaDevices.enumerateDevices().then((d) => setCams(d.filter((x) => x.kind === 'videoinput')));
    }
    return () => {
      live.current.rec?.state === 'recording' && live.current.rec.stop();
      stopStreams();
    };
  }, [mode]);

  // camera preview
  useEffect(() => {
    if (mode !== 'camera' || state !== 'idle') return;
    let s: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: cam ? { exact: cam } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 } } })
      .then((st) => {
        s = st;
        if (videoRef.current) videoRef.current.srcObject = st;
        setError('');
        navigator.mediaDevices.enumerateDevices().then((d) => setCams(d.filter((x) => x.kind === 'videoinput')));
      })
      .catch(() => setError('Kamera açılamadı. Bağlı olduğundan ve başka bir uygulamanın kullanmadığından emin ol.'));
    return () => s?.getTracks().forEach((t) => t.stop());
  }, [mode, cam, state]);

  const close = () => {
    if (state === 'rec' || state === 'saving') return;
    set({ captureOpen: null });
  };

  const start = async () => {
    setError('');
    try {
      const tracks: MediaStreamTrack[] = [];
      let video: MediaStream;
      if (mode === 'screen') {
        await window.cv.invoke('screen:select', src, sys);
        video = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: sys });
      } else {
        video = await navigator.mediaDevices.getUserMedia({ video: { deviceId: cam ? { exact: cam } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } });
      }
      live.current.streams.push(video);
      tracks.push(...video.getVideoTracks());
      // mix microphone + system audio into one track
      const audioIns: MediaStream[] = [];
      if (video.getAudioTracks().length) audioIns.push(new MediaStream(video.getAudioTracks()));
      if (mic) {
        try {
          const m = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true, echoCancellation: true } });
          live.current.streams.push(m);
          audioIns.push(m);
        } catch {
          toast('Mikrofon açılamadı, sessiz kaydediliyor', 'error');
        }
      }
      if (audioIns.length) {
        const actx = new AudioContext({ sampleRate: 48000 });
        const dest = actx.createMediaStreamDestination();
        for (const s of audioIns) actx.createMediaStreamSource(s).connect(dest);
        live.current.actx = actx;
        tracks.push(...dest.stream.getAudioTracks());
      }
      const stream = new MediaStream(tracks);
      for (let n = 3; n >= 1; n--) {
        setState('countdown');
        setCd(n);
        await new Promise((r) => setTimeout(r, 1000));
      }
      const name = mode === 'screen' ? 'Ekran kaydı' : 'Kamera kaydı';
      const { id } = await window.cv.invoke<{ id: string; path: string }>('stream:begin', get().projectPath, name, 'webm');
      live.current.id = id;
      const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: mode === 'screen' ? 10_000_000 : 8_000_000, audioBitsPerSecond: 192_000 });
      live.current.rec = rec;
      rec.ondataavailable = (e) => {
        if (!e.data.size) return;
        live.current.writes = live.current.writes.then(async () => window.cv.invoke('stream:chunk', id, new Uint8Array(await e.data.arrayBuffer())));
      };
      const t0 = performance.now();
      const timer = setInterval(() => setElapsed((performance.now() - t0) / 1000), 250);
      rec.onstop = async () => {
        clearInterval(timer);
        setState('saving');
        stopStreams();
        await live.current.writes;
        const path = await window.cv.invoke<string | null>('stream:end', id);
        if (path) {
          const [m] = await importPaths([path]);
          if (m && addToTimeline) addMediaToTimeline(m, { start: get().time, newTrack: true });
          toast('Kayıt projeye eklendi', 'success');
        }
        set({ captureOpen: null });
      };
      // stop when the user ends sharing from the OS
      video.getVideoTracks()[0].addEventListener('ended', () => rec.state === 'recording' && rec.stop());
      rec.start(1000);
      setElapsed(0);
      setState('rec');
    } catch (e: any) {
      stopStreams();
      setState('idle');
      setError(mode === 'screen' ? 'Ekran kaydı başlatılamadı: ' + (e?.message || e) : 'Kamera kaydı başlatılamadı: ' + (e?.message || e));
    }
  };

  const stop = () => live.current.rec?.state === 'recording' && live.current.rec.stop();

  return (
    <div className="modal-back" onPointerDown={close}>
      <div className="modal capture-modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{mode === 'screen' ? 'Ekran kaydı' : 'Kamera kaydı'}</h3>
          {state === 'idle' && (
            <button className="icon-btn" onClick={close}>
              <X size={16} />
            </button>
          )}
        </div>
        <div className="modal-body">
          {state === 'idle' && mode === 'screen' && (
            <div className="src-grid">
              {sources.map((s) => (
                <button key={s.id} className={'src' + (src === s.id ? ' on' : '')} onClick={() => setSrc(s.id)} title={s.name}>
                  <img src={s.thumb} />
                  <span>
                    {s.screen ? <Monitor size={12} /> : <AppWindow size={12} />} {s.name}
                  </span>
                </button>
              ))}
              {!sources.length && <div className="hint">Kaynaklar yükleniyor…</div>}
            </div>
          )}
          {state === 'idle' && mode === 'camera' && (
            <>
              <video ref={videoRef} className="cam-preview" autoPlay muted playsInline />
              {cams.length > 1 && (
                <select className="field" style={{ marginTop: 8 }} value={cam} onChange={(e) => setCam(e.target.value)}>
                  <option value="">Varsayılan kamera</option>
                  {cams.map((c) => (
                    <option key={c.deviceId} value={c.deviceId}>
                      {c.label || 'Kamera'}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
          {state === 'idle' && (
            <div style={{ marginTop: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>Mikrofon sesi</span>
                <Toggle on={mic} onChange={setMic} />
              </div>
              {mode === 'screen' && (
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>Bilgisayar sesi (oyun, tarayıcı…)</span>
                  <Toggle on={sys} onChange={setSys} />
                </div>
              )}
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>Bitince zaman çizelgesine ekle</span>
                <Toggle on={addToTimeline} onChange={setAdd} />
              </div>
            </div>
          )}
          {state === 'countdown' && <div className="cap-big">{cd}</div>}
          {(state === 'rec' || state === 'saving') && (
            <div className="cap-live">
              <div className="rec-pill" style={{ position: 'static' }}>
                <i />
                {state === 'saving' ? 'KAYDEDİLİYOR…' : 'KAYIT'} {fmt(elapsed)}
              </div>
              <p className="hint">
                {mode === 'screen' ? 'Ekranın kaydediliyor. Bu pencereyi küçültebilirsin; bitirince geri dön ve Durdur’a bas.' : 'Kamera kaydediliyor.'}
              </p>
            </div>
          )}
          {error && <div className="rec-error">{error}</div>}
        </div>
        <div className="modal-foot">
          {state === 'idle' && (
            <>
              <button className="btn ghost" onClick={close}>
                Vazgeç
              </button>
              <button className="btn primary" onClick={start} disabled={mode === 'screen' && !src}>
                <Circle size={13} fill="currentColor" /> Kaydı başlat
              </button>
            </>
          )}
          {state === 'rec' && (
            <button className="btn danger" onClick={stop}>
              <Square size={13} fill="currentColor" /> Durdur
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
