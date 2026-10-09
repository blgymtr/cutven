import { useEffect, useState } from 'react';
import { X, FolderOpen, Check, Film, Music, Play } from 'lucide-react';
import { useStore, set, edit, toast } from '../store';
import { metaOf, uploadToYoutube } from '../lib/youtube';
import { buildExport, type Loudness } from '../lib/exporter';
import { thumbCoverPath } from '../lib/thumb';
import { engine } from '../lib/engine';
import { formatDuration, projectDuration } from '../lib/util';
import { Segmented, Toggle } from './ui';

type Phase = 'setup' | 'running' | 'done' | 'error';

const RES = [
  { id: 720, label: '720p' },
  { id: 1080, label: '1080p' },
  { id: 1440, label: '2K' },
  { id: 2160, label: '4K' },
];
const QUALITY = [
  { id: 'high', label: 'Yüksek', crf: 18, preset: 'medium' },
  { id: 'std', label: 'Standart', crf: 21, preset: 'medium' },
  { id: 'small', label: 'Küçük dosya', crf: 25, preset: 'fast' },
];

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export default function ExportDialog() {
  const project = useStore((s) => s.project)!;
  const [format, setFormat] = useState<'mp4' | 'mp3'>('mp4');
  const short = Math.min(project.width, project.height);
  const [res, setRes] = useState(short >= 1080 ? 1080 : 720);
  const [fps, setFps] = useState(project.fps);
  const [quality, setQuality] = useState('high');
  const [normalize, setNormalize] = useState(true);
  const [phase, setPhase] = useState<Phase>('setup');
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [outPath, setOutPath] = useState('');
  const [thumb, setThumb] = useState<string | null>(null);
  const [stage, setStage] = useState('');
  const dur = projectDuration(project);

  useEffect(() => {
    if (engine.playing) engine.pause();
    engine.capture(320, 'image/jpeg', 0.8).then(setThumb);
    return window.cv.on('export:progress', (d) => {
      setProgress(d.progress);
      setElapsed(d.elapsed);
    });
  }, []);

  // output size keeps the project aspect; "res" = shorter side
  const scale = res / short;
  const W = even(project.width * scale);
  const H = even(project.height * scale);

  const close = () => phase !== 'running' && set({ exportOpen: false });

  const start = async () => {
    const out = await window.cv.invoke<string | null>('dialog:saveExport', project.name, format);
    if (!out) return;
    setOutPath(out);
    setPhase('running');
    setProgress(0);
    setElapsed(0);
    try {
      const q = QUALITY.find((x) => x.id === quality)!;
      const coverPath = format === 'mp4' ? await thumbCoverPath(project) : undefined;
      const base = { format, width: W, height: H, fps, crf: q.crf, preset: q.preset, normalize, outPath: out, coverPath };
      let measured: Loudness | undefined;
      if (normalize) {
        setStage('Ses analiz ediliyor…');
        const mj = await buildExport(project, { ...base, measureOnly: true });
        const mr = await window.cv.invoke<{ loudness?: Loudness; cancelled?: boolean; silent?: boolean; error?: string }>('export:measure', mj);
        if (mr.cancelled) return setPhase('setup');
        measured = mr.loudness;
      }
      setStage('');
      const job = await buildExport(project, { ...base, normalize: normalize && !!measured, measured });
      const r = await window.cv.invoke<{ ok: boolean; cancelled?: boolean; error?: string }>('export:start', job);
      if (r.ok) {
        setProgress(1);
        setPhase('done');
        if (format === 'mp4') {
          edit((d) => void (d.lastExport = out), { record: false });
          const st = await window.cv.invoke<{ connected: boolean }>('yt:status');
          if (st.connected && metaOf(project).autoUpload) startUpload(out);
        }
      } else if (r.cancelled) setPhase('setup');
      else {
        setError(r.error || 'Bilinmeyen hata');
        setPhase('error');
      }
    } catch (e: any) {
      setError(String(e?.message || e));
      setPhase('error');
    }
  };

  const [yt, setYt] = useState<{ busy: boolean; p: number; url?: string; studio?: string; error?: string } | null>(null);
  useEffect(() => window.cv.on('yt:progress', (d) => setYt((y) => (y ? { ...y, p: d.progress } : y))), []);
  const startUpload = async (path: string) => {
    setYt({ busy: true, p: 0 });
    try {
      const r = await uploadToYoutube(path);
      setYt({ busy: false, p: 1, url: r.url, studio: r.studio });
    } catch (e: any) {
      setYt({ busy: false, p: 0, error: String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
    }
  };
  const eta = progress > 0.02 ? (elapsed / progress) * (1 - progress) : null;

  return (
    <div className="modal-back" onPointerDown={close}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{phase === 'done' ? 'Video hazır' : phase === 'running' ? 'Dışa aktarılıyor' : 'Dışa aktar'}</h3>
          {phase !== 'running' && (
            <button className="icon-btn" onClick={close}>
              <X size={16} />
            </button>
          )}
        </div>
        <div className="modal-body">
          <div className="export-preview">
            {thumb ? <img src={thumb} /> : <div style={{ width: 120, height: 68, background: '#000', borderRadius: 6 }} />}
            <div>
              <div style={{ fontWeight: 600, marginBottom: 3 }}>{project.name}</div>
              <div className="muted">
                {formatDuration(dur)} · {format === 'mp4' ? `${W}×${H} · ${fps} fps · MP4` : 'MP3 · 320 kbps'}
              </div>
            </div>
          </div>

          {phase === 'setup' && (
            <>
              <div className="row">
                <label>Biçim</label>
                <Segmented
                  value={format}
                  onChange={setFormat}
                  options={[
                    { value: 'mp4', label: <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Film size={13} /> Video</span> },
                    { value: 'mp3', label: <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Music size={13} /> Sadece ses</span> },
                  ]}
                />
              </div>
              {format === 'mp4' && (
                <>
                  <div className="row">
                    <label>Çözünürlük</label>
                    <Segmented value={res} onChange={setRes} options={RES.map((r) => ({ value: r.id, label: r.label }))} />
                  </div>
                  <div className="row">
                    <label>Kare hızı</label>
                    <Segmented value={fps} onChange={setFps} options={[24, 25, 30, 50, 60].map((v) => ({ value: v, label: String(v) }))} />
                  </div>
                  <div className="row">
                    <label>Kalite</label>
                    <Segmented value={quality} onChange={setQuality} options={QUALITY.map((q) => ({ value: q.id, label: q.label }))} />
                  </div>
                </>
              )}
              <div className="row" style={{ marginTop: 10 }}>
                <label>Ses seviyesi</label>
                <Toggle on={normalize} onChange={setNormalize} />
                <span className="hint">YouTube standardına göre normalleştir (−14 LUFS)</span>
              </div>
            </>
          )}

          {phase === 'running' && (
            <div style={{ padding: '6px 0 4px' }}>
              <div className="big-pct">{Math.floor(progress * 100)}%</div>
              <div className="progress" style={{ margin: '10px 0 8px' }}>
                <i style={{ width: `${progress * 100}%` }} />
              </div>
              <div className="muted">
                {stage || (eta != null ? `Kalan süre ~${formatDuration(eta)}` : 'Hazırlanıyor…')} · Geçen {formatDuration(elapsed)}
              </div>
            </div>
          )}

          {phase === 'done' && (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '4px 0' }}>
              <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(61,220,151,.15)', color: 'var(--ok)', display: 'grid', placeItems: 'center' }}>
                <Check size={18} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>Dışa aktarma tamamlandı</div>
                <div className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{outPath}</div>
              </div>
            </div>
          )}
          {phase === 'done' && yt && (
            <div className="yt-export">
              {yt.busy && (
                <>
                  <div className="muted">YouTube’a yükleniyor… %{Math.round(yt.p * 100)}</div>
                  <div className="progress" style={{ marginTop: 6 }}>
                    <i style={{ width: `${yt.p * 100}%` }} />
                  </div>
                </>
              )}
              {yt.url && (
                <div className="yt-done">
                  <Check size={14} color="var(--ok)" /> YouTube’a yüklendi
                  <button className="btn sm ghost" onClick={() => window.cv.invoke('shell:openUrl', yt.studio)}>
                    Studio’da aç
                  </button>
                </div>
              )}
              {yt.error && <div className="rec-error">{yt.error}</div>}
            </div>
          )}

          {phase === 'error' && (
            <div>
              <div style={{ color: 'var(--danger)', fontWeight: 600, marginBottom: 6 }}>Dışa aktarma başarısız oldu</div>
              <pre className="hint" style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', userSelect: 'text', background: 'var(--panel-2)', padding: 10, borderRadius: 8 }}>
                {error}
              </pre>
            </div>
          )}
        </div>
        <div className="modal-foot">
          {phase === 'setup' && (
            <>
              <button className="btn ghost" onClick={close}>
                Vazgeç
              </button>
              <button className="btn primary" onClick={start} disabled={dur <= 0}>
                Dışa aktar
              </button>
            </>
          )}
          {phase === 'running' && (
            <button className="btn" onClick={() => window.cv.invoke('export:cancel')}>
              İptal
            </button>
          )}
          {phase === 'done' && (
            <>
              <button className="btn ghost" onClick={() => window.cv.invoke('shell:showItem', outPath)}>
                <FolderOpen size={14} /> Klasörde göster
              </button>
              <button className="btn" onClick={() => window.cv.invoke('shell:openPath', outPath)}>
                <Play size={14} /> Oynat
              </button>
              {format === 'mp4' && !yt?.busy && !yt?.url && (
                <button
                  className="btn"
                  onClick={async () => {
                    const st = await window.cv.invoke<{ connected: boolean }>('yt:status');
                    if (st.connected) startUpload(outPath);
                    else {
                      set({ exportOpen: false, leftTab: 'youtube' });
                      toast('Önce YouTube hesabını bağla');
                    }
                  }}
                >
                  YouTube’a yükle
                </button>
              )}
              <button className="btn primary" onClick={close}>
                Tamam
              </button>
            </>
          )}
          {phase === 'error' && (
            <>
              <button className="btn ghost" onClick={close}>
                Kapat
              </button>
              <button className="btn primary" onClick={() => setPhase('setup')}>
                Tekrar dene
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
