import { useEffect, useRef } from 'react';
import RecordPanel from './RecordPanel';
import { Mic, Plus, Upload, Music, Image as ImageIcon, Film, X, Copy, Bookmark, AlertTriangle, FolderOpen, ClipboardPaste, MonitorUp, Video, Square, Type, Blend, Gauge, Clapperboard, ListOrdered, Sparkles, Lightbulb, SquarePlay as Youtube, Radio } from 'lucide-react';
import TempoPanel from './TempoPanel';
import { VfxPanel } from './VfxPanel';
import SuggestPanel from './SuggestPanel';
import YouTubePanel from './YouTubePanel';
import LivePanel from './LivePanel';
import { SfxPanel, TransPanel, IntroPanel, ThumbPanel } from './Panels';
import { set, useStore, edit, toast, type LeftTab } from '../store';
import type { MediaItem } from '../types';
import { pickAndImport, relinkMedia, removeMedia, importFolder, importClipboardImage } from '../lib/media';
import { addMediaToTimeline, addText, addMarker, chaptersText, addColor } from '../lib/actions';
import { TEXT_PRESETS, DEFAULT_TEXT, drawText, measureText, ensureFont } from '../lib/text';
import { formatDuration, formatChapter } from '../lib/util';
import { engine } from '../lib/engine';
import { askConfirm } from './ui';

export const DND_TYPE = 'application/x-cutven';

function MediaCard({ m, used }: { m: MediaItem; used: boolean }) {
  const rt = useStore((s) => s.runtime[m.id]);
  const thumb = rt?.thumb;
  return (
    <div
      className={'media-card ' + m.type + (used ? ' used' : '')}
      draggable={rt?.status !== 'missing'}
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_TYPE, JSON.stringify({ type: 'media', id: m.id }));
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onDoubleClick={() => addMediaToTimeline(m)}
      title={m.name}
    >
      <div className="thumb" style={thumb && m.type !== 'audio' ? { backgroundImage: `url("${thumb}")` } : undefined}>
        {m.type === 'audio' && <Music size={22} />}
        {!thumb && m.type === 'video' && <Film size={20} />}
        {!thumb && m.type === 'image' && <ImageIcon size={20} />}
        {m.type !== 'image' && <span className="dur">{formatDuration(m.duration)}</span>}
        {rt?.status === 'proxy' && (
          <div className="state">
            <div>
              Önizleme hazırlanıyor
              <div className="bar">
                <i style={{ width: `${Math.round((rt.progress || 0) * 100)}%` }} />
              </div>
            </div>
          </div>
        )}
        {rt?.status === 'missing' && (
          <div className="state missing" onClick={() => relinkMedia(m.id)}>
            <div>
              <AlertTriangle size={16} />
              <div>Dosya bulunamadı</div>
              <u>Yeniden bağla</u>
            </div>
          </div>
        )}
        {rt?.status === 'error' && <div className="state missing">Açılamadı</div>}
      </div>
      <div className="meta">{m.name}</div>
      {rt?.status !== 'missing' && (
        <button className="add" title="Zaman çizelgesine ekle" onClick={() => addMediaToTimeline(m)}>
          <Plus size={15} />
        </button>
      )}
      <button
        className="del"
        title="Projeden kaldır"
        onClick={async (e) => {
          e.stopPropagation();
          if (used) {
            const ok = await askConfirm('Medya kaldırılsın mı?', {
              text: 'Bu medya zaman çizelgesinde kullanılıyor. Kaldırırsan ilgili klipler de silinir.',
              ok: 'Kaldır',
              danger: true,
            });
            if (!ok) return;
          }
          removeMedia(m.id);
        }}
      >
        <X size={13} />
      </button>
    </div>
  );
}

function MediaTab() {
  const media = useStore((s) => s.project?.media || []);
  const clips = useStore((s) => s.project?.clips || []);
  const used = new Set(clips.map((c) => c.mediaId));
  return (
    <>
      <button className="import-main" onClick={() => pickAndImport()}>
        <Upload size={18} />
        <span>
          <b>Medya içe aktar</b>
          <small>ya da dosyaları pencereye sürükle</small>
        </span>
      </button>
      <div className="import-grid">
        <button onClick={() => importFolder()} title="Bir klasördeki tüm video, ses ve görseller">
          <FolderOpen size={15} />
          Klasör
        </button>
        <button onClick={() => importClipboardImage()} title="Panodaki ekran görüntüsü (Ctrl+V)">
          <ClipboardPaste size={15} />
          Panodan
        </button>
        <button onClick={() => set({ captureOpen: 'screen' })} title="Ekranı ya da bir pencereyi kaydet">
          <MonitorUp size={15} />
          Ekran
        </button>
        <button onClick={() => set({ captureOpen: 'camera' })} title="Web kamerasıyla kayıt">
          <Video size={15} />
          Kamera
        </button>
        <button onClick={() => addColor()} title="Düz renk arka plan klibi">
          <Square size={15} />
          Renk
        </button>
      </div>
      {media.length > 0 && (
        <div className="media-grid">
          {media.map((m) => (
            <MediaCard key={m.id} m={m} used={used.has(m.id)} />
          ))}
        </div>
      )}
      <p className="hint" style={{ marginTop: 14 }}>
        {media.length > 0 ? 'Çift tıkla ya da zaman çizelgesine sürükle.' : 'Desteklenen: MP4, MOV, MKV, WEBM, AVI, GIF · MP3, WAV, M4A, FLAC, OGG · PNG, JPG, WEBP, SVG, TIFF'}
      </p>
    </>
  );
}

function PresetThumb({ id }: { id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const preset = TEXT_PRESETS.find((p) => p.id === id)!;
    const style = { ...DEFAULT_TEXT, ...preset.style };
    const draw = (): void => {
      const cv = ref.current;
      if (!cv) return;
      const dpr = window.devicePixelRatio || 1;
      if (!cv.clientWidth) {
        requestAnimationFrame(draw);
        return;
      }
      cv.width = cv.clientWidth * dpr;
      cv.height = cv.clientHeight * dpr;
      const ctx = cv.getContext('2d')!;
      const m = measureText(style);
      const k = Math.min((cv.width * 0.84) / m.w, (cv.height * 0.7) / m.h);
      ctx.setTransform(k, 0, 0, k, cv.width / 2, cv.height / 2);
      drawText(ctx, style);
    };
    const r = ensureFont(style);
    if (r === true) draw();
    else r.then(draw);
  }, [id]);
  return <canvas ref={ref} />;
}

function TextTab() {
  return (
    <>
      <div className="section-title">Metin stilleri</div>
      <div className="text-presets">
        {TEXT_PRESETS.map((p, i) => (
          <div
            key={p.id}
            className="text-preset"
            style={{ animationDelay: `${i * 25}ms` }}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_TYPE, JSON.stringify({ type: 'text', preset: p.id }));
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => addText(p.id)}
            title={`${p.name} — tıkla ya da sürükle`}
          >
            <PresetThumb id={p.id} />
            <span>{p.name}</span>
          </div>
        ))}
      </div>
      <p className="hint" style={{ marginTop: 14 }}>
        Metin oynatma imlecinin olduğu yere eklenir. Önizlemede sürükleyerek konumlandır, sağ panelden düzenle.
      </p>
    </>
  );
}

function ChaptersTab() {
  const markers = useStore((s) => s.project?.markers || []);
  const project = useStore((s) => s.project);
  const sorted = [...markers].sort((a, b) => a.time - b.time);
  const warn: string[] = [];
  const all = sorted.length && sorted[0].time < 1 ? sorted.map((m) => m.time) : [0, ...sorted.map((m) => m.time)];
  if (all.length < 3) warn.push('YouTube en az 3 bölüm ister.');
  for (let i = 1; i < all.length; i++)
    if (all[i] - all[i - 1] < 10) {
      warn.push('Her bölüm en az 10 saniye olmalı.');
      break;
    }
  return (
    <>
      <div className="group-head">
        <div className="section-title" style={{ margin: 0 }}>
          YouTube bölümleri
        </div>
        <button className="btn sm" onClick={() => addMarker()}>
          <Bookmark size={13} /> Ekle <kbd>M</kbd>
        </button>
      </div>
      {sorted.length === 0 ? (
        <p className="hint">
          Oynatma imlecini bir bölümün başına getir ve <kbd>M</kbd> tuşuna bas. İşaretçiler, açıklamaya yapıştırabileceğin bölüm listesine dönüşür.
        </p>
      ) : (
        <div className="chapters">
          {sorted.map((m) => (
            <div className="chapter" key={m.id}>
              <span className="tc" onClick={() => engine.seek(m.time)}>
                {formatChapter(m.time)}
              </span>
              <input
                value={m.label}
                onChange={(e) =>
                  edit((d) => {
                    const x = d.markers.find((k) => k.id === m.id);
                    if (x) x.label = e.target.value;
                  }, { key: 'marker-label-' + m.id })
                }
              />
              <button className="icon-btn sm" title="Sil" onClick={() => edit((d) => void (d.markers = d.markers.filter((k) => k.id !== m.id)))}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {project && sorted.length > 0 && (
        <>
          {warn.length > 0 && (
            <p className="hint" style={{ color: '#ffcf4a', marginTop: 12 }}>
              {warn.join(' ')}
            </p>
          )}
          <button
            className="btn primary"
            style={{ width: '100%', marginTop: 12 }}
            onClick={() => {
              window.cv.invoke('clipboard:write', chaptersText(project));
              toast('Bölümler kopyalandı — video açıklamasına yapıştır', 'success');
            }}
          >
            <Copy size={14} /> Bölümleri kopyala
          </button>
          <pre className="hint" style={{ whiteSpace: 'pre-wrap', marginTop: 12, userSelect: 'text' }}>
            {chaptersText(project)}
          </pre>
        </>
      )}
    </>
  );
}

const RAIL = [
  { id: 'media', label: 'Medya', icon: Film },
  { id: 'sfx', label: 'Sesler', icon: Music },
  { id: 'text', label: 'Metin', icon: Type },
  { id: 'vfx', label: 'Efekt', icon: Sparkles },
  { id: 'trans', label: 'Geçiş', icon: Blend },
  { id: 'record', label: 'Kayıt', icon: Mic },
  { id: 'tempo', label: 'Tempo', icon: Gauge },
  { id: 'suggest', label: 'Öneri', icon: Lightbulb },
  { id: 'youtube', label: 'YouTube', icon: Youtube },
  { id: 'live', label: 'Canlı', icon: Radio },
  { id: 'intro', label: 'Intro', icon: Clapperboard },
  { id: 'thumb', label: 'Kapak', icon: ImageIcon },
  { id: 'chapters', label: 'Bölüm', icon: ListOrdered },
] as const;

const TITLES: Record<LeftTab, string> = {
  media: 'Medya',
  sfx: 'Ses efektleri',
  text: 'Metin',
  vfx: 'Efektler & lens',
  suggest: 'Öneriler',
  youtube: 'YouTube',
  live: 'Canlı yayın',
  trans: 'Geçişler',
  record: 'Seslendirme',
  tempo: 'Tempo koçu',
  intro: 'Intro & outro',
  thumb: 'Küçük resim',
  chapters: 'Bölümler',
};

export default function MediaPanel() {
  const tab = useStore((s) => s.leftTab);
  const recording = useStore((s) => s.rec.status === 'recording' || s.rec.status === 'paused');
  return (
    <div className="left">
      <nav className="rail">
        {RAIL.map((r) => {
          const Icon = r.icon;
          return (
            <button key={r.id} className={'rail-btn' + (tab === r.id ? ' on' : '') + (r.id === 'record' && recording ? ' live' : '')} onClick={() => set({ leftTab: r.id })} title={TITLES[r.id]}>
              <Icon size={18} />
              <span>{r.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">{TITLES[tab]}</span>
        </div>
        <div className="panel-body">
          {tab === 'media' && <MediaTab />}
          {tab === 'sfx' && <SfxPanel />}
          {tab === 'text' && <TextTab />}
          {tab === 'trans' && <TransPanel />}
          {tab === 'vfx' && <VfxPanel />}
          {tab === 'record' && <RecordPanel />}
          {tab === 'tempo' && <TempoPanel />}
          {tab === 'suggest' && <SuggestPanel />}
          {tab === 'youtube' && <YouTubePanel />}
          {tab === 'live' && <LivePanel />}
          {tab === 'intro' && <IntroPanel />}
          {tab === 'thumb' && <ThumbPanel />}
          {tab === 'chapters' && <ChaptersTab />}
        </div>
      </div>
    </div>
  );
}
