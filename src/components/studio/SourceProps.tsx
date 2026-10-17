import { useEffect, useState } from 'react';
import { Monitor as MonitorIcon, AppWindow, RefreshCw, RotateCcw, Play, Trash2, FolderOpen, Maximize, Minimize, Crosshair, PictureInPicture2 } from 'lucide-react';
import { studio, textNatural } from '../../lib/studio/engine';
import { useStudio, sget, sset, updateSource, removeSource, syncSourceAudio, findSource, KIND_NAMES, type StudioSource } from '../../lib/studio/state';
import type { TextStyle } from '../../types';
import { FONTS, WEIGHT_NAMES } from '../../lib/text';
import { basename } from '../../lib/util';
import { Slider, Toggle, Segmented, ColorInput, askConfirm } from '../ui';

interface CapSource {
  id: string;
  name: string;
  thumb: string;
  screen: boolean;
}

function Group({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="group">
      <div className="group-head">
        <h4>{title}</h4>
        {right}
      </div>
      {children}
    </div>
  );
}

const Num = ({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) => {
  const [t, setT] = useState<string | null>(null);
  return (
    <label className="st-num">
      <span>{label}</span>
      <input
        className="field"
        value={t ?? String(Math.round(value))}
        onFocus={(e) => (setT(String(Math.round(value))), requestAnimationFrame(() => e.target.select()))}
        onChange={(e) => setT(e.target.value)}
        onBlur={() => {
          const v = parseFloat((t || '').replace(',', '.'));
          if (!isNaN(v)) onChange(v);
          setT(null);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
};

function CapturePicker({ s }: { s: StudioSource }) {
  const [list, setList] = useState<CapSource[] | null>(null);
  const load = () => window.cv.invoke<CapSource[]>('screen:sources').then(setList).catch(() => setList([]));
  useEffect(() => {
    load();
  }, []);
  const want = s.kind === 'display';
  const items = (list || []).filter((x) => x.screen === want);
  return (
    <Group
      title={want ? 'Ekran' : 'Pencere'}
      right={
        <button className="icon-btn sm" title="Listeyi yenile" onClick={load}>
          <RefreshCw size={13} />
        </button>
      }
    >
      <div className="st-cap-grid">
        {items.map((x) => (
          <button
            key={x.id}
            className={'src' + ((s.capture || (want && items[0]?.id === x.id && !s.capture ? x.id : '')) === x.id ? ' on' : '')}
            title={x.name}
            onClick={() => updateSource(s.id, { capture: x.id, captureName: x.name, name: want ? x.name : x.name.slice(0, 40), fit: 'full' })}
          >
            <img src={x.thumb} />
            <span>
              {x.screen ? <MonitorIcon size={11} /> : <AppWindow size={11} />} {x.name}
            </span>
          </button>
        ))}
        {list && !items.length && <p className="hint">{want ? 'Ekran bulunamadı.' : 'Açık pencere bulunamadı. Kaydetmek istediğin uygulamayı aç ve yenile.'}</p>}
        {!list && <p className="hint">Yükleniyor…</p>}
      </div>
      <div className="row">
        <label>Sesini de al</label>
        <Toggle
          on={!!s.audio}
          onChange={(v) => {
            updateSource(s.id, { audio: v });
            syncSourceAudio();
          }}
        />
      </div>
      <p className="hint">
        {s.audio
          ? 'Bu kaynağın sesi mikserde ayrı bir kanal olur. Masaüstü sesi kanalı da açıksa ses iki kez kaydedilir.'
          : 'Bilgisayar sesi zaten mikserdeki “Masaüstü sesi” kanalından gelir.'}
      </p>
    </Group>
  );
}

function CameraProps({ s }: { s: StudioSource }) {
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    navigator.mediaDevices.enumerateDevices().then((d) => setCams(d.filter((x) => x.kind === 'videoinput')));
  }, [s.device]);
  return (
    <Group title="Kamera">
      <div className="row">
        <label>Cihaz</label>
        <select className="field" value={s.device || ''} onChange={(e) => updateSource(s.id, { device: e.target.value || undefined })}>
          <option value="">Varsayılan kamera</option>
          {cams.map((c, i) => (
            <option key={c.deviceId || i} value={c.deviceId}>
              {c.label || `Kamera ${i + 1}`}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>Çözünürlük</label>
        <Segmented
          value={s.camRes || '1080'}
          onChange={(v) => updateSource(s.id, { camRes: v })}
          options={[
            { value: '720', label: '720p' },
            { value: '1080', label: '1080p' },
            { value: '2160', label: '4K' },
          ]}
        />
      </div>
    </Group>
  );
}

function FileProps({ s }: { s: StudioSource }) {
  const pick = async () => {
    const exts = s.kind === 'image' ? ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] : ['mp4', 'mov', 'webm', 'mkv', 'm4v'];
    const p = await window.cv.invoke<string | null>('dialog:pickFile', s.kind === 'image' ? 'Görsel seç' : 'Video seç', exts);
    if (p) updateSource(s.id, { path: p, name: basename(p), fit: 'center' });
  };
  return (
    <Group title={s.kind === 'image' ? 'Görsel' : 'Video dosyası'}>
      <div className="row">
        <span className="grow st-path" title={s.path}>
          {s.path ? basename(s.path) : 'Dosya seçilmedi'}
        </span>
        <button className="btn sm" onClick={pick}>
          <FolderOpen size={13} /> {s.path ? 'Değiştir' : 'Seç'}
        </button>
      </div>
      {s.kind === 'media' && (
        <>
          <div className="row">
            <label>Döngü</label>
            <Toggle on={s.loop !== false} onChange={(v) => updateSource(s.id, { loop: v })} />
            <span className="grow" />
            <button className="icon-btn sm" title="Baştan oynat" onClick={() => studio.mediaControl(s, 'restart')}>
              <RotateCcw size={13} />
            </button>
            <button className="icon-btn sm" title="Oynat / duraklat" onClick={() => studio.mediaControl(s, 'toggle')}>
              <Play size={13} />
            </button>
          </div>
          <div className="row">
            <label>Sesi mikserde</label>
            <Toggle
              on={!!s.audio}
              onChange={(v) => {
                updateSource(s.id, { audio: v });
                syncSourceAudio();
              }}
            />
          </div>
        </>
      )}
    </Group>
  );
}

/** change text style keeping the box's scale and centre */
function updateText(s: StudioSource, patch: Partial<TextStyle>) {
  const cur = findSource(s.id);
  if (!cur?.text) return;
  const next = { ...cur.text, ...patch };
  const a = textNatural(cur.text);
  const b = textNatural(next);
  const k = cur.w / a.w;
  const w = Math.round(b.w * k);
  const h = Math.round(b.h * k);
  updateSource(s.id, { text: next, w, h, x: Math.round(cur.x + (cur.w - w) / 2), y: Math.round(cur.y + (cur.h - h) / 2) });
}

function TextProps({ s }: { s: StudioSource }) {
  const t = s.text!;
  const font = FONTS.find((f) => f.family === t.font) || FONTS[0];
  return (
    <Group title="Yazı">
      <textarea className="field st-textarea" rows={3} value={t.content} onChange={(e) => updateText(s, { content: e.target.value })} />
      <div className="row">
        <label>Yazı tipi</label>
        <select className="field" value={t.font} onChange={(e) => updateText(s, { font: e.target.value, weight: FONTS.find((f) => f.family === e.target.value)?.weights.slice(-1)[0] || 700 })}>
          {FONTS.map((f) => (
            <option key={f.family} value={f.family}>
              {f.family}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>Kalınlık</label>
        <select className="field" value={t.weight} onChange={(e) => updateText(s, { weight: +e.target.value })}>
          {font.weights.map((w) => (
            <option key={w} value={w}>
              {WEIGHT_NAMES[w] || w}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>Renk</label>
        <ColorInput value={t.color} onChange={(v) => updateText(s, { color: v })} />
        <span className="grow" />
        <label style={{ width: 'auto' }}>BÜYÜK</label>
        <Toggle on={t.uppercase} onChange={(v) => updateText(s, { uppercase: v })} />
      </div>
      <div className="row">
        <label>Kontur</label>
        <Toggle on={t.stroke} onChange={(v) => updateText(s, { stroke: v })} />
        {t.stroke && <ColorInput value={t.strokeColor} onChange={(v) => updateText(s, { strokeColor: v })} />}
      </div>
      <div className="row">
        <label>Gölge</label>
        <Toggle on={t.shadow} onChange={(v) => updateText(s, { shadow: v })} />
      </div>
      <div className="row">
        <label>Arka kutu</label>
        <Toggle on={t.bg} onChange={(v) => updateText(s, { bg: v })} />
        {t.bg && <ColorInput value={t.bgColor} onChange={(v) => updateText(s, { bgColor: v })} />}
      </div>
      {t.bg && <Slider label="Kutu opaklık" value={t.bgOpacity} min={0} max={1} step={0.01} def={0.6} mult={100} unit="%" onChange={(v) => updateText(s, { bgOpacity: v })} />}
    </Group>
  );
}

function TransformProps({ s }: { s: StudioSource }) {
  const W = useStudio((x) => x.settings.width);
  const H = useStudio((x) => x.settings.height);
  const nat = () => studio.naturalSize(s) || { w: s.w, h: s.h };
  const fit = (cover: boolean) => {
    const n = nat();
    const k = cover ? Math.max(W / n.w, H / n.h) : Math.min(W / n.w, H / n.h);
    const w = Math.round(n.w * k);
    const h = Math.round(n.h * k);
    updateSource(s.id, { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h });
  };
  /** crop keeps the visible part where it is (OBS behaviour) */
  const crop = (edge: 'l' | 'r' | 't' | 'b', v: number) => {
    const c = { ...s.crop, [edge]: v };
    if (c.l + c.r > 0.9 || c.t + c.b > 0.9) return;
    const fw = s.w / (1 - s.crop.l - s.crop.r);
    const fh = s.h / (1 - s.crop.t - s.crop.b);
    updateSource(s.id, {
      crop: c,
      x: Math.round(s.x + fw * (c.l - s.crop.l)),
      y: Math.round(s.y + fh * (c.t - s.crop.t)),
      w: Math.round(fw * (1 - c.l - c.r)),
      h: Math.round(fh * (1 - c.t - c.b)),
    });
  };
  return (
    <Group title="Konum ve boyut">
      <div className="st-num-grid">
        <Num label="X" value={s.x} onChange={(v) => updateSource(s.id, { x: v })} />
        <Num label="Y" value={s.y} onChange={(v) => updateSource(s.id, { y: v })} />
        <Num
          label="Genişlik"
          value={s.w}
          onChange={(v) => {
            const w = Math.max(8, v);
            updateSource(s.id, { w, h: Math.round((s.h * w) / s.w) });
          }}
        />
        <Num label="Yükseklik" value={s.h} onChange={(v) => updateSource(s.id, { h: Math.max(8, v) })} />
      </div>
      <div className="chips st-chips">
        <button className="chip" onClick={() => fit(false)} title="Oranı koruyarak tuvale sığdır">
          <Minimize size={12} /> Sığdır
        </button>
        <button className="chip" onClick={() => fit(true)} title="Oranı koruyarak tuvali kapla (taşan kısım kesilir)">
          <Maximize size={12} /> Kapla
        </button>
        <button className="chip" onClick={() => updateSource(s.id, { x: Math.round((W - s.w) / 2), y: Math.round((H - s.h) / 2) })}>
          <Crosshair size={12} /> Ortala
        </button>
        <button
          className="chip"
          title="Sağ alt köşeye küçük pencere"
          onClick={() => {
            const n = nat();
            const w = Math.round(W * 0.28);
            const h = Math.round((w * n.h) / n.w);
            updateSource(s.id, { w, h, x: W - w - Math.round(W * 0.025), y: H - h - Math.round(H * 0.04) });
          }}
        >
          <PictureInPicture2 size={12} /> Köşe
        </button>
      </div>
      {s.kind !== 'text' && s.kind !== 'color' && (
        <>
          <Slider label="Kırp: sol" value={s.crop.l} min={0} max={0.45} step={0.005} def={0} mult={100} unit="%" onChange={(v) => crop('l', v)} />
          <Slider label="Kırp: sağ" value={s.crop.r} min={0} max={0.45} step={0.005} def={0} mult={100} unit="%" onChange={(v) => crop('r', v)} />
          <Slider label="Kırp: üst" value={s.crop.t} min={0} max={0.45} step={0.005} def={0} mult={100} unit="%" onChange={(v) => crop('t', v)} />
          <Slider label="Kırp: alt" value={s.crop.b} min={0} max={0.45} step={0.005} def={0} mult={100} unit="%" onChange={(v) => crop('b', v)} />
        </>
      )}
    </Group>
  );
}

function LookProps({ s }: { s: StudioSource }) {
  const up = (p: Partial<StudioSource>) => updateSource(s.id, p);
  const visual = s.kind !== 'text' && s.kind !== 'color';
  return (
    <>
      <Group title="Görünüm">
        {s.kind === 'color' && (
          <div className="row">
            <label>Renk</label>
            <ColorInput value={s.color || '#000000'} onChange={(v) => up({ color: v })} />
          </div>
        )}
        <Slider label="Opaklık" value={s.opacity} min={0} max={1} step={0.01} def={1} mult={100} unit="%" onChange={(v) => up({ opacity: v })} />
        <div className="row">
          <label>Şekil</label>
          <Segmented
            value={s.shape}
            onChange={(v) => up({ shape: v })}
            options={[
              { value: 'rect', label: 'Kare' },
              { value: 'rounded', label: 'Yuvarlak köşe' },
              { value: 'circle', label: 'Daire' },
            ]}
          />
        </div>
        {s.shape === 'rounded' && <Slider label="Köşe" value={s.radius} min={0} max={300} step={1} def={24} unit="px" onChange={(v) => up({ radius: v })} />}
        <Slider label="Kenarlık" value={s.border} min={0} max={40} step={1} def={0} unit="px" onChange={(v) => up({ border: v })} />
        {s.border > 0 && (
          <div className="row">
            <label>Kenarlık rengi</label>
            <ColorInput value={s.borderColor} onChange={(v) => up({ borderColor: v })} />
          </div>
        )}
        {visual && (
          <div className="row">
            <label>Ayna</label>
            <Toggle on={s.mirror} onChange={(v) => up({ mirror: v })} />
          </div>
        )}
      </Group>
      {visual && (
        <Group
          title="Renk ayarı"
          right={
            <button className="icon-btn sm" title="Sıfırla" onClick={() => up({ brightness: 1, contrast: 1, saturation: 1 })}>
              <RotateCcw size={13} />
            </button>
          }
        >
          <Slider label="Parlaklık" value={s.brightness} min={0.3} max={2} step={0.01} def={1} mult={100} unit="%" onChange={(v) => up({ brightness: v })} />
          <Slider label="Kontrast" value={s.contrast} min={0.3} max={2} step={0.01} def={1} mult={100} unit="%" onChange={(v) => up({ contrast: v })} />
          <Slider label="Doygunluk" value={s.saturation} min={0} max={2.5} step={0.01} def={1} mult={100} unit="%" onChange={(v) => up({ saturation: v })} />
        </Group>
      )}
      {visual && (
        <Group title="Yeşil ekran" right={<Toggle on={s.chroma.on} onChange={(v) => up({ chroma: { ...s.chroma, on: v } })} />}>
          {s.chroma.on && (
            <>
              <div className="row">
                <label>Renk</label>
                <ColorInput value={s.chroma.color} onChange={(v) => up({ chroma: { ...s.chroma, color: v } })} />
                <button className="chip" onClick={() => up({ chroma: { ...s.chroma, color: '#00ff00' } })}>
                  Yeşil
                </button>
                <button className="chip" onClick={() => up({ chroma: { ...s.chroma, color: '#0047ff' } })}>
                  Mavi
                </button>
              </div>
              <Slider label="Benzerlik" value={s.chroma.similarity} min={0.01} max={0.8} step={0.01} def={0.3} mult={100} unit="%" onChange={(v) => up({ chroma: { ...s.chroma, similarity: v } })} />
              <Slider label="Yumuşatma" value={s.chroma.smooth} min={0} max={0.5} step={0.01} def={0.1} mult={100} unit="%" onChange={(v) => up({ chroma: { ...s.chroma, smooth: v } })} />
              <Slider label="Taşma giderme" value={s.chroma.spill} min={0} max={1} step={0.01} def={0.1} mult={100} unit="%" onChange={(v) => up({ chroma: { ...s.chroma, spill: v } })} />
            </>
          )}
        </Group>
      )}
    </>
  );
}

export default function SourceProps({ id }: { id: string }) {
  const s = useStudio((x) => findSource(id, x));
  const err = useStudio(() => (s ? studio.errorFor(s) : ''));
  if (!s) return null;
  return (
    <div className="st-props">
      <div className="group">
        <div className="row">
          <input className="field grow" value={s.name} onChange={(e) => updateSource(s.id, { name: e.target.value })} spellCheck={false} />
          <span className="st-kind">{KIND_NAMES[s.kind]}</span>
        </div>
        {err && <div className="rec-error">{err}</div>}
      </div>
      {(s.kind === 'display' || s.kind === 'window') && <CapturePicker s={s} />}
      {s.kind === 'camera' && <CameraProps s={s} />}
      {(s.kind === 'image' || s.kind === 'media') && <FileProps s={s} />}
      {s.kind === 'text' && s.text && <TextProps s={s} />}
      <TransformProps s={s} />
      <LookProps s={s} />
      <button
        className="btn sm danger"
        style={{ width: '100%' }}
        onClick={async () => {
          if (await askConfirm(`“${s.name}” kaynağı silinsin mi?`, { ok: 'Sil', danger: true })) {
            removeSource(s.id);
            if (sget().selected === s.id) sset({ selected: null });
          }
        }}
      >
        <Trash2 size={13} /> Kaynağı sil
      </button>
    </div>
  );
}
