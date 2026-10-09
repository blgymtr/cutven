import { useEffect, useRef, useState } from 'react';
import { Play, Plus, Film, Image as ImageIcon, FolderOpen, X, Wand2, Download, Check } from 'lucide-react';
import { set, useStore, toast, get } from '../store';
import { SFX, addSfx, previewSfx } from '../lib/sfx';
import { TRANSITIONS } from '../lib/transitions';
import { applyTransition } from '../lib/actions';
import { TEMPLATES, insertMedia, insertTemplate, loadSettings, saveSettings, type AppSettings } from '../lib/introoutro';
import { mediaUrl, basename } from '../lib/util';
import { renderThumb, thumbDesignOf, saveThumbPng } from '../lib/thumb';
import { ColorInput } from './ui';
import { DND_TYPE } from './MediaPanel';
import type { TransType } from '../types';

/* ------------------------------------------------------------ sound effects */

export function SfxPanel() {
  const cats = ['Geçiş', 'Vurgu', 'Komik', 'Arayüz', 'Ortam'] as const;
  const [playing, setPlaying] = useState<string | null>(null);
  return (
    <>
      <p className="hint" style={{ marginTop: 0 }}>
        Tıkla dinle, <b>+</b> ile oynatma imlecine ekle ya da zaman çizelgesine sürükle. Efektler uygulama içinde üretilir, telifsizdir.
      </p>
      {cats.map((cat) => (
        <div key={cat} style={{ marginBottom: 14 }}>
          <div className="section-title">{cat}</div>
          <div className="sfx-list">
            {SFX.filter((s) => s.cat === cat).map((s) => (
              <div
                key={s.id}
                className={'sfx' + (playing === s.id ? ' on' : '')}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DND_TYPE, JSON.stringify({ type: 'sfx', id: s.id }));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
              >
                <button
                  className="sfx-play"
                  title="Dinle"
                  onClick={async () => {
                    setPlaying(s.id);
                    await previewSfx(s.id);
                    setTimeout(() => setPlaying((p) => (p === s.id ? null : p)), s.dur * 1000 + 200);
                  }}
                >
                  <Play size={12} fill="currentColor" />
                </button>
                <span className="sfx-name">{s.name}</span>
                <span className="muted sfx-dur">{s.dur.toFixed(1)} sn</span>
                <button className="icon-btn sm" title="Oynatma imlecine ekle" onClick={() => addSfx(s.id)}>
                  <Plus size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/* ------------------------------------------------------------ transitions */

function TransIcon({ id }: { id: TransType }) {
  // tiny animated glyph describing the motion
  return (
    <div className={'tr-icon tr-' + id}>
      <i className="a" />
      <i className="b" />
    </div>
  );
}

export function TransPanel() {
  const sel = useStore((s) => (s.selection.length === 1 ? s.project?.clips.find((c) => c.id === s.selection[0]) : undefined));
  const usable = sel && sel.kind !== 'audio';
  return (
    <>
      <p className="hint" style={{ marginTop: 0 }}>
        {usable ? (
          <>
            Seçili klibe <b>giriş</b> ya da <b>çıkış</b> geçişi uygula. Süreyi sağ panelden ayarlarsın.
          </>
        ) : (
          <>Bir video, görsel ya da metin klibi seç; ya da geçişi zaman çizelgesindeki klibin başına/sonuna sürükle.</>
        )}
      </p>
      <div className="trans-grid">
        {TRANSITIONS.map((t) => (
          <div
            key={t.id}
            className="trans-card"
            title={t.hint}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_TYPE, JSON.stringify({ type: 'trans', id: t.id }));
              e.dataTransfer.effectAllowed = 'copy';
            }}
          >
            <TransIcon id={t.id} />
            <div className="trans-name">{t.name}</div>
            <div className="trans-actions">
              <button className="chip" disabled={!usable} onClick={() => sel && applyTransition(sel.id, 'in', t.id)}>
                Giriş
              </button>
              {t.outOk && (
                <button className="chip" disabled={!usable} onClick={() => sel && applyTransition(sel.id, 'out', t.id)}>
                  Çıkış
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------ intro / outro */

function Slot({ label, path, onPick, onClear, onInsert, insertLabel }: { label: string; path?: string; onPick: () => void; onClear: () => void; onInsert: () => void; insertLabel: string }) {
  const isImg = path && /\.(png|jpe?g|webp|bmp)$/i.test(path);
  return (
    <div className="slot">
      <div className="slot-thumb" onClick={onPick} title="Dosya seç">
        {path ? isImg ? <img src={mediaUrl(path)} /> : <video src={mediaUrl(path) + '#t=0.5'} muted preload="metadata" /> : <Film size={18} />}
      </div>
      <div className="slot-info">
        <b>{label}</b>
        <span className="muted">{path ? basename(path) : 'Henüz seçilmedi'}</span>
        <div className="row" style={{ gap: 6, minHeight: 0, marginTop: 6 }}>
          {path ? (
            <>
              <button className="btn sm primary" onClick={onInsert}>
                {insertLabel}
              </button>
              <button className="icon-btn sm" title="Kaldır" onClick={onClear}>
                <X size={13} />
              </button>
            </>
          ) : (
            <button className="btn sm" onClick={onPick}>
              <FolderOpen size={13} /> Dosya seç
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function IntroPanel() {
  const [st, setSt] = useState<AppSettings>({});
  const name = useStore((s) => s.project?.name || '');
  const [title, setTitle] = useState('');
  useEffect(() => {
    loadSettings().then(setSt);
  }, []);
  const update = async (patch: Partial<AppSettings>) => setSt(await saveSettings(patch));
  const pick = async (key: 'introPath' | 'outroPath') => {
    const p = await window.cv.invoke<string | null>('dialog:pickFile', key === 'introPath' ? 'Intro dosyası' : 'Outro dosyası');
    if (p) update({ [key]: p });
  };
  const color = st.brandColor || '#ff6a3d';
  const channel = st.channelName || 'Kanal Adı';
  return (
    <>
      <div className="section-title">Kendi intro / outro'n</div>
      <p className="hint" style={{ marginTop: 0 }}>Bir kez seç, tüm projelerde tek tıkla ekle.</p>
      <Slot label="Intro" path={st.introPath} onPick={() => pick('introPath')} onClear={() => update({ introPath: undefined })} onInsert={() => st.introPath && insertMedia(st.introPath, 'start')} insertLabel="Başa ekle" />
      <Slot label="Outro" path={st.outroPath} onPick={() => pick('outroPath')} onClear={() => update({ outroPath: undefined })} onInsert={() => st.outroPath && insertMedia(st.outroPath, 'end')} insertLabel="Sona ekle" />

      <div className="section-title" style={{ marginTop: 18 }}>
        Hazır şablonlar
      </div>
      <div className="row">
        <label>Kanal adı</label>
        <input className="field" value={st.channelName || ''} placeholder="Kanal Adı" onChange={(e) => setSt({ ...st, channelName: e.target.value })} onBlur={() => update({ channelName: st.channelName })} />
      </div>
      <div className="row">
        <label>Başlık</label>
        <input className="field" value={title} placeholder={name} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="row">
        <label>Marka rengi</label>
        <ColorInput value={color} onChange={(v) => update({ brandColor: v })} />
      </div>
      <div className="tpl-list">
        {TEMPLATES.map((t) => (
          <button key={t.id} className="tpl" onClick={() => insertTemplate(t.id, { color, channel, title: title || name })}>
            <span className={'tpl-badge ' + t.where}>{t.where === 'start' ? 'INTRO' : 'OUTRO'}</span>
            <b>{t.name}</b>
            <span className="muted">{t.hint}</span>
          </button>
        ))}
      </div>
      <p className="hint" style={{ marginTop: 10 }}>
        Intro eklenince tüm video ileri kayar; outro en sona gelir. Şablon yazılarını sonradan düzenleyebilirsin.
      </p>
    </>
  );
}

/* ------------------------------------------------------------ thumbnail launcher */

export function ThumbPanel() {
  const design = useStore((s) => s.project?.thumbDesign);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    cv.width = 640;
    cv.height = 360;
    renderThumb(cv.getContext('2d')!, thumbDesignOf(get().project!), 640, 360);
  }, [design]);
  return (
    <>
      <p className="hint" style={{ marginTop: 0 }}>YouTube küçük resmi: 1280×720, en fazla 2 MB. Bir kareden başla, büyük yazı ekle.</p>
      <canvas ref={ref} className="thumb-mini" onClick={() => set({ thumbOpen: true })} />
      <button className="btn primary" style={{ width: '100%', marginTop: 10 }} onClick={() => set({ thumbOpen: true })}>
        <Wand2 size={14} /> {design ? 'Tasarımı düzenle' : 'Küçük resim tasarla'}
      </button>
      {design && (
        <>
          <button className="btn" style={{ width: '100%', marginTop: 8 }} onClick={() => saveThumbPng()}>
            <Download size={14} /> PNG olarak kaydet
          </button>
          <p className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {design.embed ? <Check size={13} color="var(--ok)" /> : <ImageIcon size={13} />}
            {design.embed ? 'Dışa aktarılan MP4’e kapak olarak gömülecek' : 'Videoya gömülmüyor (tasarımdan açılabilir)'}
          </p>
        </>
      )}
      {!design && (
        <p className="hint">
          İpucu: önizlemede güzel bir kareye gel, sonra <b>Küçük resim tasarla</b>’ya bas — o kare arka plan olur.
        </p>
      )}
    </>
  );
}

export function useToastOnce() {
  return toast;
}
