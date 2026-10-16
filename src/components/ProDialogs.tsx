import { useEffect, useRef, useState } from 'react';
import { X, ArrowDownToLine, Replace, CornerDownRight } from 'lucide-react';
import { useStore, set, toast } from '../store';
import { saveProject, openProject } from '../lib/project';
import { askConfirm } from './ui';
import { placeSource } from '../lib/proedit';
import { mediaUrl, formatDuration } from '../lib/util';

/* ================================================================ shortcuts */

export const SHORTCUTS: [string, [string, string][]][] = [
  [
    'Oynatma',
    [
      ['Boşluk', 'Oynat / durdur'],
      ['J / K / L', 'Geri sar · durdur · ileri sar (tekrar bas: 2×, 4×, 8×)'],
      ['← / →', 'Bir kare geri / ileri (Shift: 1 sn)'],
      ['↑ / ↓', 'Önceki / sonraki kesme noktası'],
      ['Home / End', 'Başa / sona git'],
    ],
  ],
  [
    'Kurgu',
    [
      ['S  ·  Ctrl+B', 'Seçili klibi imleçten böl'],
      ['Ctrl+K', 'Tüm izleri imleçten kes'],
      ['Q / W', 'Klibin başını / sonunu imlece kadar kırp, boşluğu kapat'],
      ['Del  ·  Shift+Del', 'Sil · sil ve boşluğu kapat'],
      ['I / O', 'Giriş / çıkış noktası'],
      ['X', 'Seçili klibin etrafına giriş-çıkış koy'],
      ['Ctrl+Shift+X', 'Giriş-çıkışı temizle'],
      ['; (noktalı virgül)', 'Kaldır (lift): giriş-çıkış arasını sil, boşluk kalsın'],
      ["' (tek tırnak)", 'Çıkar (extract): giriş-çıkış arasını sil, boşluğu kapat'],
      [',  /  .', 'Kaynak monitöründeki parçayı ekle (insert) / üzerine yaz (overwrite)'],
    ],
  ],
  [
    'Araçlar',
    [
      ['V', 'Seçim'],
      ['B', 'Dalgalı kırpma (ripple)'],
      ['Y', 'Kaydırma (slip)'],
      ['T', 'Hız esnetme'],
      ['N', 'Mıknatıs aç / kapat (Alt: geçici kapat)'],
    ],
  ],
  [
    'Diğer',
    [
      ['M', 'İşaretçi ekle (çift tık: renk ve not)'],
      ['K (dururken)', 'Seçili klibe ses anahtar karesi'],
      ['R', 'Seslendirme kaydı başlat / durdur'],
      ['Ctrl+Z / Ctrl+Y', 'Geri al / yinele'],
      ['Ctrl+C / Ctrl+V / Ctrl+D', 'Kopyala / yapıştır / çoğalt'],
      ['Ctrl+S / Ctrl+E / Ctrl+I', 'Kaydet / dışa aktar / içe aktar'],
      ['+ / − / Shift+Z', 'Yakınlaştır / uzaklaştır / sığdır'],
      ['?', 'Bu pencere'],
    ],
  ],
];

export function ShortcutsDialog() {
  const open = useStore((s) => s.shortcutsOpen);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && set({ shortcutsOpen: false });
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-back" onPointerDown={() => set({ shortcutsOpen: false })}>
      <div className="modal shortcuts" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Klavye kısayolları</h3>
          <button className="icon-btn" onClick={() => set({ shortcutsOpen: false })}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body sc-grid">
          {SHORTCUTS.map(([title, rows]) => (
            <div key={title}>
              <h4>{title}</h4>
              {rows.map(([k, v]) => (
                <div className="sc-row" key={k}>
                  <kbd>{k}</kbd>
                  <span>{v}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ================================================================ source monitor */

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
};

export function SourceMonitor() {
  const src = useStore((s) => s.source);
  const media = useStore((s) => (s.source ? s.project?.media.find((m) => m.id === s.source!.mediaId) : undefined));
  const rt = useStore((s) => (s.source ? s.runtime[s.source.mediaId] : undefined));
  const ref = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!src) return;
    const k = (e: KeyboardEvent) => {
      const tg = e.target as HTMLElement;
      if (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA') return;
      const v = ref.current;
      if (!v) return;
      const key = e.key.toLowerCase();
      let handled = true;
      if (key === 'i') set({ source: { ...src, in: v.currentTime, out: Math.max(src.out, v.currentTime + 0.1) } });
      // Out before In moves In back (never a negative range)
      else if (key === 'o') set({ source: { ...src, out: Math.max(0.1, v.currentTime), in: Math.min(src.in, Math.max(0, v.currentTime - 0.1)) } });
      else if (key === ' ') v.paused ? v.play() : v.pause();
      else if (key === ',') place('insert');
      else if (key === '.') place('overwrite');
      else if (key === 'escape') set({ source: null });
      else if (key === 'arrowleft') v.currentTime = Math.max(0, v.currentTime - (e.shiftKey ? 1 : 1 / 30));
      else if (key === 'arrowright') v.currentTime = Math.min(v.duration, v.currentTime + (e.shiftKey ? 1 : 1 / 30));
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  });
  if (!src || !media) return null;
  const dur = media.duration || 0.01;
  const isImg = media.type === 'image';
  const url = mediaUrl(rt?.previewPath || media.path);
  const place = (mode: 'insert' | 'overwrite') => {
    placeSource(media, isImg ? { in: 0, out: Math.max(0.5, src.out - src.in) } : { in: src.in, out: src.out }, mode);
    ref.current?.pause();
    set({ source: null });
  };
  const pct = (v: number) => `${(v / dur) * 100}%`;
  return (
    <div className="modal-back" onPointerDown={() => set({ source: null })}>
      <div className="modal source-mon" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Kaynak · {media.name}</h3>
          <button className="icon-btn" onClick={() => set({ source: null })}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          {isImg ? (
            <img src={url} className="src-view" />
          ) : (
            <video
              ref={ref}
              src={url}
              className="src-view"
              onTimeUpdate={(e) => setT((e.target as HTMLVideoElement).currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onLoadedMetadata={(e) => ((e.target as HTMLVideoElement).currentTime = src.in)}
              onClick={(e) => {
                const v = e.target as HTMLVideoElement;
                v.paused ? v.play() : v.pause();
              }}
            />
          )}
          {!isImg && (
            <div
              className="src-bar"
              onPointerDown={(e) => {
                const bar = e.currentTarget.getBoundingClientRect();
                const seek = (x: number) => ref.current && (ref.current.currentTime = Math.max(0, Math.min(dur, ((x - bar.left) / bar.width) * dur)));
                seek(e.clientX);
                const mv = (ev: PointerEvent) => seek(ev.clientX);
                const up = () => {
                  window.removeEventListener('pointermove', mv);
                  window.removeEventListener('pointerup', up);
                };
                window.addEventListener('pointermove', mv);
                window.addEventListener('pointerup', up);
              }}
            >
              <div className="src-range" style={{ left: pct(src.in), width: pct(src.out - src.in) }} />
              <div className="src-head" style={{ left: pct(t) }} />
            </div>
          )}
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
            {!isImg ? (
              <div className="row" style={{ gap: 6 }}>
                <button className="btn sm" onClick={() => ref.current && set({ source: { ...src, in: ref.current.currentTime, out: Math.max(src.out, ref.current.currentTime + 0.1) } })}>
                  Giriş (I) · {fmt(src.in)}
                </button>
                <button
                  className="btn sm"
                  onClick={() => ref.current && set({ source: { ...src, out: Math.max(0.1, ref.current.currentTime), in: Math.min(src.in, Math.max(0, ref.current.currentTime - 0.1)) } })}
                >
                  Çıkış (O) · {fmt(src.out)}
                </button>
                <span className="muted">{playing ? 'Oynatılıyor' : fmt(t)} · seçili {formatDuration(src.out - src.in)}</span>
              </div>
            ) : (
              <span className="muted">Görsel 5 sn olarak eklenir.</span>
            )}
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm" title="Giriş noktasına (yoksa imlece) ekle, sonrasını ileri it" onClick={() => place('insert')}>
                <CornerDownRight size={13} /> Ekle ( , )
              </button>
              <button className="btn sm primary" title="Giriş noktasına (yoksa imlece) üzerine yaz" onClick={() => place('overwrite')}>
                <Replace size={13} /> Üzerine yaz ( . )
              </button>
            </div>
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            <ArrowDownToLine size={11} /> Üç noktalı kurgu: kaynakta I/O ile parçayı seç; zaman çizelgesinde giriş noktası (I) ya da imleç neredeyse oraya yerleşir.
          </p>
        </div>
      </div>
    </div>
  );
}

export function openSource(mediaId: string, duration: number) {
  set({ source: { mediaId, in: 0, out: duration || 5 } });
}

/* ================================================================ version history */

interface Version {
  file: string;
  at: number;
  size: number;
  clips?: number;
  duration?: number;
  name?: string;
}

export function VersionsDialog() {
  const open = useStore((s) => s.versionsOpen);
  const path = useStore((s) => s.projectPath);
  const [list, setList] = useState<Version[] | null>(null);
  const load = () => path && window.cv.invoke<Version[]>('versions:list', path).then(setList);
  useEffect(() => {
    if (open) load();
    else setList(null);
  }, [open]);
  if (!open || !path) return null;
  const restore = async (v: Version) => {
    const ok = await askConfirm('Bu sürüm geri yüklensin mi?', { text: `${new Date(v.at).toLocaleString('tr-TR')} tarihli sürüm açılacak. Şu anki hâl de yedeklenir, istersen geri dönebilirsin.`, ok: 'Geri yükle' });
    if (!ok) return;
    await saveProject(true);
    await window.cv.invoke('versions:restore', path, v.file);
    set({ versionsOpen: false });
    await openProject(path);
    toast('Sürüm geri yüklendi', 'success');
  };
  const day = (t: number) => new Date(t).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' });
  let lastDay = '';
  return (
    <div className="modal-back" onPointerDown={() => set({ versionsOpen: false })}>
      <div className="modal versions" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Sürüm geçmişi</h3>
          <button className="icon-btn" onClick={() => set({ versionsOpen: false })}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p className="hint" style={{ marginTop: 0 }}>Cutven çalışırken her 5 dakikada bir projenin yedeğini alır (son 40 sürüm saklanır). Yanlışlıkla bir şeyi bozarsan buradan eski hâline dönebilirsin.</p>
          {list == null && <p className="muted">Yükleniyor…</p>}
          {list && !list.length && <p className="muted">Henüz yedek yok. İlk yedek birkaç dakika içinde alınır.</p>}
          <div className="ver-list">
            {list?.map((v) => {
              const d = day(v.at);
              const head = d !== lastDay ? ((lastDay = d), <div className="ver-day" key={'d' + v.at}>{d}</div>) : null;
              return (
                <div key={v.file}>
                  {head}
                  <div className="ver-row">
                    <b>{new Date(v.at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</b>
                    <span className="muted grow">
                      {v.clips != null ? `${v.clips} klip · ${formatDuration(v.duration || 0)}` : ''} · {(v.size / 1024).toFixed(0)} KB
                    </span>
                    <button className="btn sm" onClick={() => restore(v)}>
                      Geri yükle
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="modal-foot">
          <button
            className="btn ghost"
            onClick={async () => {
              await saveProject(true);
              await window.cv.invoke('versions:snapshot', path);
              load();
              toast('Yedek alındı', 'success');
            }}
          >
            Şimdi yedek al
          </button>
          <button className="btn primary" onClick={() => set({ versionsOpen: false })}>
            Kapat
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================================================================ interchange */

export async function exportInterchange(kind: 'xml' | 'edl' | 'otio') {
  const { get } = await import('../store');
  const { toFcpXml, toEdl, toOtio } = await import('../lib/interchange');
  const p = get().project;
  if (!p) return;
  const ext = kind;
  const out = await window.cv.invoke<string | null>('dialog:saveText', p.name, ext);
  if (!out) return;
  await window.cv.invoke('file:writeText', out, kind === 'xml' ? toFcpXml(p) : kind === 'edl' ? toEdl(p) : toOtio(p));
  toast(kind === 'xml' ? 'XML kaydedildi — Premiere: Dosya › İçe aktar, Resolve: Dosya › İçe Aktar › Zaman çizelgesi' : kind === 'edl' ? 'EDL kaydedildi' : 'OpenTimelineIO kaydedildi', 'success');
}
