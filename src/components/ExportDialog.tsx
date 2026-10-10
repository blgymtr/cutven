import { useEffect, useState } from 'react';
import { X, FolderOpen, Check, Film, Music, Play, Minimize2 } from 'lucide-react';
import { useStore, set, toast } from '../store';
import type { HwKind, VideoCodec } from '../lib/exporter';
import { runExport, pickOutput, startUpload, type RunParams } from '../lib/exportRun';
import { ioRange } from '../lib/proedit';
import { engine } from '../lib/engine';
import { formatDuration, projectDuration } from '../lib/util';
import { Segmented, Toggle } from './ui';

const RES = [
  { id: 480, label: '480p' },
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
const CODECS: { id: VideoCodec; label: string; hint: string }[] = [
  { id: 'h264', label: 'H.264', hint: 'MP4 — her yerde oynar. YouTube için önerilen.' },
  { id: 'hevc', label: 'HEVC', hint: 'MP4 (H.265) — aynı kalitede ~%40 daha küçük dosya.' },
  { id: 'prores', label: 'ProRes', hint: 'MOV (ProRes 422 HQ) — arşiv ve başka programda düzenleme için. Çok büyük dosya.' },
  { id: 'vp9', label: 'WebM', hint: 'WebM (VP9 + Opus) — web siteleri için.' },
  { id: 'gif', label: 'GIF', hint: 'Sessiz, döngülü hareketli görsel. Kısa parçalar için.' },
  { id: 'png', label: 'PNG', hint: 'Her kare ayrı PNG dosyası (sessiz). Bir klasör seçeceksin.' },
];

interface Preset {
  id: string;
  name: string;
  sub: string;
  codec: VideoCodec;
  res: number;
  fps?: number;
  q: string;
  aspect?: number;
}
const PRESETS: Preset[] = [
  { id: 'yt1080', name: 'YouTube', sub: '1080p · H.264', codec: 'h264', res: 1080, q: 'high', aspect: 16 / 9 },
  { id: 'yt4k', name: 'YouTube 4K', sub: '2160p · H.264', codec: 'h264', res: 2160, q: 'high', aspect: 16 / 9 },
  { id: 'shorts', name: 'Shorts / TikTok / Reels', sub: '1080×1920 · H.264', codec: 'h264', res: 1080, q: 'high', aspect: 9 / 16 },
  { id: 'insta', name: 'Instagram gönderi', sub: '1080×1080 / 4:5', codec: 'h264', res: 1080, q: 'std', aspect: 1 },
  { id: 'archive', name: 'Arşiv', sub: 'ProRes 422 HQ', codec: 'prores', res: 1080, q: 'high' },
  { id: 'gif', name: 'GIF', sub: '480p · 15 fps', codec: 'gif', res: 480, fps: 15, q: 'std' },
];

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const HW_NAME: Record<HwKind, string> = { nvenc: 'NVIDIA (NVENC)', qsv: 'Intel (Quick Sync)', amf: 'AMD (AMF)' };

export default function ExportDialog() {
  const project = useStore((s) => s.project)!;
  const exp = useStore((s) => s.exp);
  const [format, setFormat] = useState<'mp4' | 'mp3'>('mp4');
  const short = Math.min(project.width, project.height);
  const [res, setRes] = useState(short >= 1080 ? 1080 : 720);
  const [fps, setFps] = useState(project.fps);
  const [quality, setQuality] = useState('high');
  const [codec, setCodec] = useState<VideoCodec>('h264');
  const [hwList, setHwList] = useState<string[] | null>(null);
  const [hw, setHw] = useState<HwKind | null>(null);
  const [normalize, setNormalize] = useState(true);
  const [preset, setPreset] = useState<string | null>('yt1080');
  const range = ioRange(project);
  const [useRange, setUseRange] = useState(!!range);
  const [thumb, setThumb] = useState<string | null>(null);
  const dur = useRange && range ? range[1] - range[0] : projectDuration(project);
  const running = exp?.phase === 'running';
  // show the last result only if it belongs to this dialog session
  const [sessionStarted, setSessionStarted] = useState(running);
  const phase = exp && (sessionStarted || running) ? exp.phase : 'setup';

  useEffect(() => {
    if (engine.playing) engine.pause();
    engine.capture(320, 'image/jpeg', 0.8).then(setThumb);
    window.cv.invoke<string[]>('export:hwEncoders').then(setHwList).catch(() => setHwList([]));
  }, []);

  const scale = res / short;
  const W = even(project.width * scale);
  const H = even(project.height * scale);
  const hwFor = (c: VideoCodec) => (['nvenc', 'qsv', 'amf'] as HwKind[]).filter((k) => (c === 'h264' || c === 'hevc') && hwList?.includes(`${c}_${k}`));
  const hwOpts = hwFor(codec);
  useEffect(() => {
    if (hw && !hwOpts.includes(hw)) setHw(null);
  }, [codec, hwList]);

  const applyPreset = (pr: Preset) => {
    setPreset(pr.id);
    setFormat('mp4');
    setCodec(pr.codec);
    setRes(pr.res);
    setQuality(pr.q);
    if (pr.fps) setFps(pr.fps);
    else if (fps === 15) setFps(project.fps);
  };
  const ar = project.width / project.height;
  const pr = PRESETS.find((p) => p.id === preset);
  const aspectWarn = pr?.aspect && Math.abs(pr.aspect - ar) > 0.02 && !(pr.id === 'insta' && Math.abs(ar - 0.8) < 0.02);

  const close = () => {
    if (running) set({ exportOpen: false });
    else set({ exportOpen: false, exp: exp && exp.phase !== 'running' ? null : exp });
  };

  const start = async () => {
    const q = QUALITY.find((x) => x.id === quality)!;
    const prm: RunParams = {
      audioOnly: format === 'mp3',
      codec,
      hw,
      width: W,
      height: H,
      fps: codec === 'gif' ? Math.min(fps, 20) : fps,
      crf: q.crf,
      preset: q.preset,
      normalize,
      range: useRange ? range : null,
    };
    const out = await pickOutput(project, prm);
    if (!out) return;
    setSessionStarted(true);
    runExport(project, prm, out);
  };

  const progress = exp?.progress || 0;
  const elapsed = exp?.elapsed || 0;
  const eta = progress > 0.02 ? (elapsed / progress) * (1 - progress) : null;
  const yt = exp?.yt;
  const outPath = exp?.out || '';
  const isPlayable = exp?.kind === 'audio' || (exp && exp.codec !== 'png');
  const codecLabel = CODECS.find((c) => c.id === codec)!;

  return (
    <div className="modal-back" onPointerDown={close}>
      <div className="modal export-modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{phase === 'done' ? 'Video hazır' : phase === 'running' ? 'Dışa aktarılıyor' : 'Dışa aktar'}</h3>
          <button className="icon-btn" onClick={close} title={running ? 'Arka planda sürdür' : 'Kapat'}>
            {running ? <Minimize2 size={15} /> : <X size={16} />}
          </button>
        </div>
        <div className="modal-body">
          <div className="export-preview">
            {thumb ? <img src={thumb} /> : <div style={{ width: 120, height: 68, background: '#000', borderRadius: 6 }} />}
            <div>
              <div style={{ fontWeight: 600, marginBottom: 3 }}>{project.name}</div>
              <div className="muted">
                {formatDuration(dur)} · {format === 'mp4' ? `${W}×${H} · ${codec === 'gif' ? Math.min(fps, 20) : fps} fps · ${codecLabel.label}${hw ? ' · ' + hw.toUpperCase() : ''}` : 'MP3 · 320 kbps'}
                {useRange && range ? ' · giriş→çıkış' : ''}
              </div>
            </div>
          </div>

          {phase === 'setup' && (
            <>
              <div className="exp-presets">
                {PRESETS.map((p) => (
                  <button key={p.id} className={'exp-preset' + (preset === p.id && format === 'mp4' ? ' on' : '')} onClick={() => applyPreset(p)}>
                    <b>{p.name}</b>
                    <span>{p.sub}</span>
                  </button>
                ))}
              </div>
              {aspectWarn && format === 'mp4' && (
                <p className="hint warn">Projenin oranı bu platforma uymuyor ({project.width}×{project.height}). Dikey video için Dosya → “Shorts’a çevir”i kullan.</p>
              )}
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
                    <label>Kodek</label>
                    <Segmented value={codec} onChange={(v) => (setCodec(v), setPreset(null))} options={CODECS.map((c) => ({ value: c.id, label: c.label, title: c.hint }))} />
                  </div>
                  <p className="hint" style={{ margin: '2px 0 6px 92px' }}>{codecLabel.hint}</p>
                  <div className="row">
                    <label>Çözünürlük</label>
                    <Segmented value={res} onChange={(v) => (setRes(v), setPreset(null))} options={RES.map((r) => ({ value: r.id, label: r.label }))} />
                  </div>
                  <div className="row">
                    <label>Kare hızı</label>
                    <Segmented value={fps} onChange={setFps} options={[15, 24, 25, 30, 50, 60].map((v) => ({ value: v, label: String(v) }))} />
                  </div>
                  {codec !== 'png' && codec !== 'prores' && (
                    <div className="row">
                      <label>Kalite</label>
                      <Segmented value={quality} onChange={setQuality} options={QUALITY.map((q) => ({ value: q.id, label: q.label }))} />
                    </div>
                  )}
                  {(codec === 'h264' || codec === 'hevc') && (
                    <div className="row">
                      <label title="Ekran kartıyla çok daha hızlı dışa aktarır">Hızlandırma</label>
                      {hwList == null ? (
                        <span className="muted">Ekran kartı kontrol ediliyor…</span>
                      ) : hwOpts.length ? (
                        <Segmented
                          value={hw || 'cpu'}
                          onChange={(v) => setHw(v === 'cpu' ? null : (v as HwKind))}
                          options={[{ value: 'cpu', label: 'İşlemci' }, ...hwOpts.map((k) => ({ value: k, label: HW_NAME[k] }))]}
                        />
                      ) : (
                        <span className="muted">Desteklenen ekran kartı kodlayıcısı bulunamadı — işlemci kullanılacak.</span>
                      )}
                    </div>
                  )}
                </>
              )}
              {range && (
                <div className="row">
                  <label>Aralık</label>
                  <Toggle on={useRange} onChange={setUseRange} />
                  <span className="hint" style={{ margin: 0 }}>
                    Sadece giriş → çıkış arası ({formatDuration(range[1] - range[0])})
                  </span>
                </div>
              )}
              {(format === 'mp3' || (codec !== 'gif' && codec !== 'png')) && (
                <div className="row" style={{ marginTop: 4 }}>
                  <label>Ses seviyesi</label>
                  <Toggle on={normalize} onChange={setNormalize} />
                  <span className="hint" style={{ margin: 0 }}>YouTube standardına göre eşitle (−14 LUFS)</span>
                </div>
              )}
            </>
          )}

          {phase === 'running' && (
            <div style={{ padding: '6px 0 4px' }}>
              <div className="big-pct">{Math.floor(progress * 100)}%</div>
              <div className="progress" style={{ margin: '10px 0 8px' }}>
                <i style={{ width: `${progress * 100}%` }} />
              </div>
              <div className="muted">
                {exp?.stage || (eta != null ? `Kalan süre ~${formatDuration(eta)}` : 'Hazırlanıyor…')} · Geçen {formatDuration(elapsed)}
              </div>
              <p className="hint">Bu pencereyi kapatabilirsin; dışa aktarma arka planda sürer, üst çubukta ilerlemeyi görürsün.</p>
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
                {exp?.error}
              </pre>
              {hw && <p className="hint">Ekran kartı kodlayıcısı sorun çıkarmış olabilir; “İşlemci” ile tekrar dene.</p>}
            </div>
          )}
        </div>
        <div className="modal-foot">
          {(phase === 'setup' || phase === 'cancelled') && (
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
            <>
              <button className="btn ghost" onClick={() => set({ exportOpen: false })}>
                <Minimize2 size={14} /> Arka planda sürdür
              </button>
              <button className="btn" onClick={() => window.cv.invoke('export:cancel')}>
                İptal
              </button>
            </>
          )}
          {phase === 'done' && (
            <>
              <button className="btn ghost" onClick={() => window.cv.invoke('shell:showItem', outPath.includes('%05d') ? outPath.replace(/[^\\/]+$/, '') : outPath)}>
                <FolderOpen size={14} /> Klasörde göster
              </button>
              {isPlayable && (
                <button className="btn" onClick={() => window.cv.invoke('shell:openPath', outPath)}>
                  <Play size={14} /> Aç
                </button>
              )}
              {exp?.kind === 'video' && (exp.codec === 'h264' || exp.codec === 'hevc') && !yt?.busy && !yt?.url && (
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
              <button className="btn primary" onClick={() => set({ exp: null })}>
                Tekrar dene
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Small progress chip for the top bar while an export runs in the background. */
export function ExportChip() {
  const exp = useStore((s) => s.exp);
  const open = useStore((s) => s.exportOpen);
  if (!exp || open || (exp.phase !== 'running' && !exp.yt?.busy)) return null;
  const p = exp.yt?.busy ? exp.yt.p : exp.progress;
  return (
    <button className="export-chip" onClick={() => set({ exportOpen: true })} title="Dışa aktarma penceresini aç">
      <span className="export-chip-bar" style={{ width: `${p * 100}%` }} />
      <span>{exp.yt?.busy ? 'YouTube’a yükleniyor' : 'Dışa aktarılıyor'} %{Math.floor(p * 100)}</span>
    </button>
  );
}
