import { useEffect, useRef, useState } from 'react';
import { Diamond, SplitSquareHorizontal, AudioLines, Download, Zap, AlignLeft, AlignCenter, AlignRight, Italic, Scissors, Crosshair, Maximize, Minimize, RotateCcw, Trash2, Volume2 } from 'lucide-react';
import { useStore, edit } from '../store';
import type { Clip, Project, TextStyle, TransType } from '../types';
import { updateClips, detachAudio, deleteSelected } from '../lib/actions';
import { TRANSITIONS } from '../lib/transitions';
import { VfxTab } from './VfxPanel';
import { splitAtScenes } from '../lib/convert';
import { volAt, hasKeyAtPlayhead, setVolumeAtPlayhead, toggleKeyAtPlayhead, clearKeys, autoDuck } from '../lib/keyframes';
import { AFX, afxById } from '../lib/afx';
import { cutSilences, silencePreview, splitChannels, setChannel, exportClipAudio } from '../lib/audiotools';
import { fillScale, mediaOf } from '../lib/render';
import { PRESETS, DEFAULT_COLOR, colorFilterCss } from '../lib/color';
import { FONTS, WEIGHT_NAMES } from '../lib/text';
import { clipDur, formatDuration } from '../lib/util';
import { ASPECTS } from '../lib/project';
import { Slider, Toggle, Segmented, ColorInput } from './ui';
import { Shape } from './StartScreen';
import { KeyedTransform, CompositeGroups, LumetriGroups, Scopes } from './ProTabs';

type Tab = 'text' | 'visual' | 'audio' | 'speed' | 'color' | 'vfx';
const TAB_NAMES: Record<Tab, string> = { text: 'Metin', visual: 'Görüntü', audio: 'Ses', speed: 'Hız', color: 'Renk', vfx: 'Efekt' };

function tabsFor(c: Clip, p: Project): Tab[] {
  const m = mediaOf(p, c);
  if (c.kind === 'text') return ['text', 'visual', 'vfx'];
  if (c.kind === 'color') return ['visual', 'vfx'];
  if (c.kind === 'image') return ['visual', 'color', 'vfx'];
  if (c.kind === 'audio') return ['audio', 'speed'];
  return m?.hasAudio ? ['visual', 'audio', 'speed', 'color', 'vfx'] : ['visual', 'speed', 'color', 'vfx'];
}

function Group({ title, right, children }: { title?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="group">
      {(title || right) && (
        <div className="group-head">
          <h4>{title}</h4>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

function VisualTab({ c, p }: { c: Clip; p: Project }) {
  const up = (fn: (c: Clip) => void, key: string) => updateClips([c.id], fn as any, key + c.id);
  const dur = clipDur(c);
  return (
    <>
      {c.kind === 'color' && (
        <Group title="Renk">
          <div className="row">
            <ColorInput value={c.fill || '#000000'} onChange={(v) => up((x) => void (x.fill = v), 'fill')} />
            <div className="chips">
              {['#000000', '#ffffff', '#ff6a3d', '#ff0033', '#2b6bff', '#12b886', '#ffd43b', '#111114'].map((col) => (
                <button key={col} className="chip swatch-chip" style={{ background: col }} onClick={() => up((x) => void (x.fill = col), 'fill')} />
              ))}
            </div>
          </div>
        </Group>
      )}
      <Group
        title="Dönüşüm"
        right={
          <button className="icon-btn sm" title="Sıfırla" onClick={() => up((x) => Object.assign(x, { x: 0, y: 0, scale: 1, rotation: 0 }), 'reset')}>
            <RotateCcw size={13} />
          </button>
        }
      >
        <KeyedTransform c={c} p={p} />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn sm" onClick={() => up((x) => Object.assign(x, { x: 0, y: 0 }), 'center')}>
            <Crosshair size={13} /> Ortala
          </button>
          {c.kind !== 'text' && (
            <>
              <button className="btn sm" onClick={() => up((x) => Object.assign(x, { x: 0, y: 0, scale: 1 }), 'fit')}>
                <Minimize size={13} /> Sığdır
              </button>
              <button className="btn sm" onClick={() => up((x) => Object.assign(x, { x: 0, y: 0, scale: fillScale(p, c) }), 'fill')}>
                <Maximize size={13} /> Doldur
              </button>
              {c.kind === 'video' && (
                <button className="btn sm" title="Görüntüdeki sahne değişimlerini bul ve oradan böl" onClick={() => splitAtScenes(c.id)}>
                  <Scissors size={13} /> Sahnelerden böl
                </button>
              )}
            </>
          )}
        </div>
      </Group>
      <CompositeGroups c={c} />
      <Group title="Geçişler">
        <div className="row">
          <label>Giriş</label>
          <select
            className="field"
            value={c.tIn || 'fade'}
            onChange={(e) =>
              up((x) => {
                x.tIn = e.target.value as TransType;
                if (!x.fadeIn) x.fadeIn = x.tIn === 'dissolve' ? 0.8 : 0.5;
              }, 'tin')
            }
          >
            {TRANSITIONS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <Slider label="Süre" value={c.fadeIn} min={0} max={c.tIn === 'dissolve' ? 3 : Math.min(5, dur / 2)} step={0.05} def={0} digits={1} unit="sn" onChange={(v) => up((x) => void (x.fadeIn = v), 'fi')} />
        <div className="row" style={{ marginTop: 10 }}>
          <label>Çıkış</label>
          <select
            className="field"
            value={c.tOut || 'fade'}
            onChange={(e) =>
              up((x) => {
                x.tOut = e.target.value as TransType;
                if (!x.fadeOut) x.fadeOut = 0.5;
              }, 'tout')
            }
          >
            {TRANSITIONS.filter((t) => t.outOk).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <Slider label="Süre" value={c.fadeOut} min={0} max={Math.min(5, dur / 2)} step={0.05} def={0} digits={1} unit="sn" onChange={(v) => up((x) => void (x.fadeOut = v), 'fo')} />
        {c.tIn === 'dissolve' && <p className="hint">Çözülme, klibi bir öncekinin üzerine eritir; bu yüzden klip biraz erken başlar.</p>}
      </Group>
    </>
  );
}

const CHAN_NAMES: Record<string, string> = { L: 'Sol kanal', R: 'Sağ kanal', mid: 'Vokal (orta)', side: 'Müzik (kenar)' };

function SilenceTools({ c }: { c: Clip }) {
  const [thr, setThr] = useState(-38);
  const [min, setMin] = useState(0.6);
  const [pad, setPad] = useState(0.12);
  const wave = useStore((s) => (c.mediaId ? s.runtime[c.mediaId]?.wave : false));
  const o = { thresholdDb: thr, minSilence: min, padding: pad };
  const pv = wave ? silencePreview(c.id, o) : null;
  return (
    <Group title="Ses bölme (sessizlik)">
      <Slider label="Eşik" value={thr} min={-60} max={-15} step={1} def={-38} unit="dB" onChange={setThr} />
      <Slider label="En kısa" value={min} min={0.2} max={3} step={0.05} def={0.6} digits={1} unit="s" onChange={setMin} />
      <Slider label="Pay" value={pad} min={0} max={0.5} step={0.01} def={0.12} digits={2} unit="s" onChange={setPad} />
      <p className="hint" style={{ margin: '6px 0' }}>
        {!wave ? 'Ses dalgası hazırlanıyor…' : pv && pv.count ? `${pv.count} sessizlik bulundu · toplam ${pv.removed.toFixed(1)} sn` : 'Bu ayarlarla sessizlik yok.'}
      </p>
      <div className="tool-list">
        <button className="btn sm" disabled={!pv?.count} onClick={() => cutSilences(c.id, o, false)}>
          <Scissors size={13} /> Sessizliklerden böl
        </button>
        <button className="btn sm primary" disabled={!pv?.count} onClick={() => cutSilences(c.id, o, true)}>
          <Zap size={13} /> Sessizlikleri sil (jump cut)
        </button>
      </div>
    </Group>
  );
}

function KeyVolume({ c }: { c: Clip }) {
  const time = useStore((s) => s.time);
  const local = Math.min(Math.max(time - c.start, 0), clipDur(c));
  const keyed = !!c.vkeys?.length;
  const onKey = keyed && hasKeyAtPlayhead(c);
  const inside = time >= c.start - 1e-3 && time <= c.start + clipDur(c) + 1e-3;
  return (
    <>
      <Slider label="Seviye" value={keyed ? volAt(c, local) : c.volume} min={0} max={2} step={0.01} def={1} mult={100} unit="%" onChange={(v) => setVolumeAtPlayhead(c.id, v)} />
      <div className="row" style={{ gap: 6, marginTop: 4 }}>
        <button className={'btn sm kf-add' + (onKey ? ' on' : '')} disabled={!inside} onClick={() => toggleKeyAtPlayhead(c.id)} title="Oynatma imlecinde (K)">
          <Diamond size={13} fill={onKey ? 'currentColor' : 'none'} />
          {onKey ? 'Anahtar kareyi kaldır' : 'Anahtar kare ekle'}
        </button>
        {keyed && (
          <button className="btn sm ghost" onClick={() => clearKeys(c.id)}>
            Tümünü sil
          </button>
        )}
      </div>
      <p className="hint" style={{ margin: '6px 0 0' }}>
        {keyed
          ? `${c.vkeys!.length} anahtar kare. Seviye, imlecin olduğu yerdeki sesi değiştirir (gerekirse yeni kare ekler). Zaman çizelgesindeki elmasları sürükle; çift tıkla sil.`
          : 'Sesi bir yerden sonra kısmak için: imleci oraya getir, “Anahtar kare ekle”ye bas, sonra imleci ilerletip seviyeyi düşür.'}
      </p>
    </>
  );
}

function DuckTools({ c }: { c: Clip }) {
  const [level, setLevel] = useState(0.25);
  return (
    <Group title="Konuşmada müziği kıs">
      <Slider label="Kısma" value={level} min={0} max={0.8} step={0.01} def={0.25} mult={100} unit="%" onChange={setLevel} />
      <button className="btn sm primary" style={{ marginTop: 6 }} onClick={() => autoDuck(c.id, level)}>
        <Diamond size={13} /> Otomatik kıs (ducking)
      </button>
      <p className="hint">Seslendirme izinde ya da videoda konuşma olan yerlerde bu klibin sesi otomatik kısılır; anahtar kareler oluşur, sonra elle düzeltebilirsin.</p>
    </Group>
  );
}

function AudioTab({ c }: { c: Clip }) {
  const up = (fn: (c: Clip) => void, key: string) => updateClips([c.id], fn as any, key + c.id);
  const dur = clipDur(c);
  return (
    <>
      <Group title="Ses" right={<Toggle on={!c.muted} onChange={(v) => up((x) => void (x.muted = !v), 'mute')} title="Sesi aç/kapat" />}>
        <KeyVolume c={c} />
        <Slider label="Giriş" value={c.audioFadeIn} min={0} max={Math.min(10, dur / 2)} step={0.05} def={0} digits={1} unit="sn" onChange={(v) => up((x) => void (x.audioFadeIn = v), 'afi')} />
        <Slider label="Çıkış" value={c.audioFadeOut} min={0} max={Math.min(10, dur / 2)} step={0.05} def={0} digits={1} unit="sn" onChange={(v) => up((x) => void (x.audioFadeOut = v), 'afo')} />
      </Group>
      {c.kind === 'audio' && <DuckTools c={c} />}
      <Group title="Ses efekti">
        <div className="chips">
          {AFX.map((a) => (
            <button key={a.id} title={a.hint} className={'chip' + ((c.afx || 'none') === a.id ? ' on' : '')} onClick={() => up((x) => void (x.afx = a.id === 'none' ? undefined : a.id), 'afx')}>
              {a.name}
            </button>
          ))}
        </div>
        {afxById(c.afx).exportOnly && <p className="hint">Bu efektin tam etkisi dışa aktarmada duyulur.</p>}
      </Group>
      <Group
        title="Ekolayzer"
        right={
          <button className="icon-btn sm" title="EQ'yu sıfırla" onClick={() => up((x) => void (x.eq = undefined), 'eq0')}>
            <RotateCcw size={13} />
          </button>
        }
      >
        {(() => {
          const eq = c.eq || { hp: 0, low: 0, mid: 0, midF: 1000, high: 0 };
          const setEq = (patch: Partial<typeof eq>, k: string) => up((x) => void (x.eq = { ...eq, ...patch }), 'eq' + k);
          return (
            <>
              <Slider label="Alçak kes" value={eq.hp} min={0} max={300} step={5} def={0} unit=" Hz" onChange={(v) => setEq({ hp: v }, 'hp')} />
              <Slider label="Bas" value={eq.low} min={-12} max={12} step={0.5} def={0} digits={1} unit=" dB" onChange={(v) => setEq({ low: v }, 'lo')} />
              <Slider label="Orta" value={eq.mid} min={-12} max={12} step={0.5} def={0} digits={1} unit=" dB" onChange={(v) => setEq({ mid: v }, 'mi')} />
              <Slider label="Orta frekans" value={eq.midF} min={200} max={5000} step={50} def={1000} unit=" Hz" onChange={(v) => setEq({ midF: v }, 'mf')} />
              <Slider label="Tiz" value={eq.high} min={-12} max={12} step={0.5} def={0} digits={1} unit=" dB" onChange={(v) => setEq({ high: v }, 'hi')} />
            </>
          );
        })()}
        <div className="row" style={{ marginTop: 8 }}>
          <label>Uğultu giderme</label>
          <Segmented
            value={String(c.dehum || 0)}
            options={[{ value: '0', label: 'Kapalı' }, { value: '50', label: '50 Hz' }, { value: '60', label: '60 Hz' }]}
            onChange={(v) => up((x) => void (x.dehum = v === '0' ? undefined : (Number(v) as 50 | 60)), 'hum')}
          />
        </div>
        <div className="row">
          <label>Limiter</label>
          <Toggle on={!!c.limit} onChange={(v) => up((x) => void (x.limit = v || undefined), 'lim')} title="Tepeleri −1.5 dB'de keser, patlamayı önler" />
        </div>
        <p className="hint">Türkiye’de elektrik uğultusu 50 Hz’dir. Limiter, bağırma/kahkaha gibi ani tepelerde sesin patlamasını önler.</p>
      </Group>
      <SilenceTools c={c} />
      <Group title="Ses ayırma">
        {c.chan && (
          <div className="row">
            <span className="chip on">{CHAN_NAMES[c.chan]}</span>
            <button className="btn sm ghost" onClick={() => setChannel(c.id, undefined)}>
              Tam stereoya dön
            </button>
          </div>
        )}
        <div className="tool-list">
          {c.kind === 'video' && (
            <button className="btn sm" onClick={() => detachAudio(c.id)} disabled={c.muted}>
              <Volume2 size={13} /> Sesi videodan ayır
            </button>
          )}
          <button className="btn sm" onClick={() => splitChannels(c.id, 'lr')} disabled={c.kind === 'video' && c.muted}>
            <SplitSquareHorizontal size={13} /> Sol / sağ kanalı ayır
          </button>
          <button className="btn sm" onClick={() => splitChannels(c.id, 'stem')} disabled={c.kind === 'video' && c.muted}>
            <AudioLines size={13} /> Vokal / müzik ayır
          </button>
          <button className="btn sm" onClick={() => exportClipAudio(c.id, 'wav')}>
            <Download size={13} /> WAV kaydet
          </button>
          <button className="btn sm" onClick={() => exportClipAudio(c.id, 'mp3')}>
            <Download size={13} /> MP3 kaydet
          </button>
        </div>
        <p className="hint">Sol/sağ ayırma iki mikrofonlu kayıtlar (podcast) için. Vokal/müzik ayırma basit yöntemdir; stereo şarkılarda ortadaki vokali ayırır.</p>
      </Group>
    </>
  );
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
function SpeedTab({ c }: { c: Clip }) {
  const set = (v: number) => updateClips([c.id], (x) => void (x.speed = Math.round(v * 100) / 100), 'speed' + c.id);
  return (
    <Group title="Hız">
      <Slider label="Hız" value={c.speed} min={0.25} max={4} step={0.05} def={1} digits={2} unit="×" onChange={set} />
      <div className="chips" style={{ marginTop: 10 }}>
        {SPEEDS.map((s) => (
          <button key={s} className={'chip' + (Math.abs(c.speed - s) < 0.001 ? ' on' : '')} onClick={() => set(s)}>
            {s}×
          </button>
        ))}
      </div>
      <p className="hint" style={{ marginTop: 12 }}>
        Klip süresi: {formatDuration(clipDur(c))}. Ses perdesi korunur.
      </p>
    </Group>
  );
}

function ColorTab({ c }: { c: Clip }) {
  const thumb = useStore((s) => (c.mediaId ? s.runtime[c.mediaId]?.thumb : undefined));
  const col = c.color || DEFAULT_COLOR;
  const up = (patch: Partial<typeof col>, key: string) => updateClips([c.id], (x) => void (x.color = { ...x.color, ...patch }), 'color-' + key + c.id);
  return (
    <>
      <Scopes />
      <Group title="Filtreler">
        <div className="filters">
          {PRESETS.map((pr) => (
            <button key={pr.id} className={'filter' + (col.preset === pr.id ? ' on' : '')} onClick={() => up({ preset: pr.id }, 'preset')}>
              <div
                className="fimg"
                style={{
                  backgroundImage: thumb ? `url("${thumb}")` : 'linear-gradient(135deg,#f6a35b,#5b8df6)',
                  filter: colorFilterCss({ ...DEFAULT_COLOR, preset: pr.id }),
                }}
              />
              {pr.name}
            </button>
          ))}
        </div>
      </Group>
      <Group
        title="Ayarlar"
        right={
          <button className="icon-btn sm" title="Ayarları sıfırla" onClick={() => up({ ...DEFAULT_COLOR, preset: col.preset }, 'reset')}>
            <RotateCcw size={13} />
          </button>
        }
      >
        <Slider label="Parlaklık" value={col.brightness} min={-100} max={100} step={1} def={0} onChange={(v) => up({ brightness: v }, 'b')} />
        <Slider label="Kontrast" value={col.contrast} min={-100} max={100} step={1} def={0} onChange={(v) => up({ contrast: v }, 'c')} />
        <Slider label="Doygunluk" value={col.saturation} min={-100} max={100} step={1} def={0} onChange={(v) => up({ saturation: v }, 's')} />
        <Slider label="Sıcaklık" value={col.temperature} min={-100} max={100} step={1} def={0} onChange={(v) => up({ temperature: v }, 't')} />
        <Slider label="Ton" value={col.hue} min={-180} max={180} step={1} def={0} unit="°" onChange={(v) => up({ hue: v }, 'h')} />
      </Group>
      <LumetriGroups c={c} />
    </>
  );
}

function TextTab({ c }: { c: Clip }) {
  const s = c.text!;
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const f = () => {
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener('cutven:focus-text', f);
    return () => window.removeEventListener('cutven:focus-text', f);
  }, []);
  const up = (patch: Partial<TextStyle>, key: string) => updateClips([c.id], (x) => void (x.text = { ...x.text!, ...patch }), 'text-' + key + c.id);
  const font = FONTS.find((f) => f.family === s.font) || FONTS[0];
  return (
    <>
      <Group>
        <textarea
          id="insp-text"
          ref={ref}
          className="field"
          rows={3}
          value={s.content}
          onChange={(e) => up({ content: e.target.value }, 'content')}
          spellCheck={false}
          placeholder="Metni yaz…"
          style={{ fontFamily: s.font, fontWeight: s.weight }}
        />
      </Group>
      <Group title="Yazı tipi">
        <div className="row">
          <select
            className="field"
            value={s.font}
            onChange={(e) => {
              const f = FONTS.find((x) => x.family === e.target.value)!;
              const w = f.weights.includes(s.weight) ? s.weight : f.weights.reduce((a, b) => (Math.abs(b - s.weight) < Math.abs(a - s.weight) ? b : a));
              up({ font: f.family, weight: w }, 'font');
            }}
          >
            {FONTS.map((f) => (
              <option key={f.family} value={f.family}>
                {f.family}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <select className="field" value={s.weight} onChange={(e) => up({ weight: +e.target.value }, 'weight')} disabled={font.weights.length < 2}>
            {font.weights.map((w) => (
              <option key={w} value={w}>
                {WEIGHT_NAMES[w] || w}
              </option>
            ))}
          </select>
          <ColorInput value={s.color} onChange={(v) => up({ color: v }, 'color')} />
        </div>
        <Slider label="Boyut" value={s.size} min={12} max={400} step={1} def={96} onChange={(v) => up({ size: v }, 'size')} />
        <div className="row">
          <label>Hizalama</label>
          <Segmented
            value={s.align}
            onChange={(v) => up({ align: v }, 'align')}
            options={[
              { value: 'left', label: <AlignLeft size={14} /> },
              { value: 'center', label: <AlignCenter size={14} /> },
              { value: 'right', label: <AlignRight size={14} /> },
            ]}
          />
          <button className={'icon-btn sm' + (s.italic ? ' on' : '')} title="İtalik" onClick={() => up({ italic: !s.italic }, 'italic')}>
            <Italic size={14} />
          </button>
          <button className={'icon-btn sm' + (s.uppercase ? ' on' : '')} title="BÜYÜK HARF" onClick={() => up({ uppercase: !s.uppercase }, 'upper')} style={{ fontWeight: 700, fontSize: 11 }}>
            AA
          </button>
        </div>
        <Slider label="Harf aralığı" value={s.letterSpacing} min={-10} max={40} step={0.5} def={0} digits={1} onChange={(v) => up({ letterSpacing: v }, 'ls')} />
        <Slider label="Satır aralığı" value={s.lineHeight} min={0.7} max={2.5} step={0.05} def={1.15} digits={2} onChange={(v) => up({ lineHeight: v }, 'lh')} />
      </Group>
      <Group title="Kontur" right={<Toggle on={s.stroke} onChange={(v) => up({ stroke: v }, 'stroke')} />}>
        {s.stroke && (
          <div className="row">
            <ColorInput value={s.strokeColor} onChange={(v) => up({ strokeColor: v }, 'sc')} />
            <Slider label="" value={s.strokeWidth} min={1} max={30} step={0.5} def={6} digits={1} onChange={(v) => up({ strokeWidth: v }, 'sw')} />
          </div>
        )}
      </Group>
      <Group title="Gölge" right={<Toggle on={s.shadow} onChange={(v) => up({ shadow: v }, 'shadow')} />}>
        {s.shadow && (
          <>
            <div className="row">
              <label>Renk</label>
              <ColorInput value={s.shadowColor} onChange={(v) => up({ shadowColor: v }, 'shc')} />
            </div>
            <Slider label="Yumuşaklık" value={s.shadowBlur} min={0} max={60} step={1} def={18} onChange={(v) => up({ shadowBlur: v }, 'shb')} />
            <Slider label="Mesafe" value={s.shadowOffset} min={0} max={30} step={1} def={4} onChange={(v) => up({ shadowOffset: v }, 'sho')} />
          </>
        )}
      </Group>
      <Group title="Arka plan" right={<Toggle on={s.bg} onChange={(v) => up({ bg: v }, 'bg')} />}>
        {s.bg && (
          <>
            <div className="row">
              <label>Renk</label>
              <ColorInput value={s.bgColor} onChange={(v) => up({ bgColor: v }, 'bgc')} />
            </div>
            <Slider label="Opaklık" value={s.bgOpacity} min={0} max={1} step={0.01} def={0.6} mult={100} unit="%" onChange={(v) => up({ bgOpacity: v }, 'bgo')} />
            <Slider label="Boşluk" value={s.bgPadding} min={0} max={80} step={1} def={24} onChange={(v) => up({ bgPadding: v }, 'bgp')} />
            <Slider label="Köşe" value={s.bgRadius} min={0} max={80} step={1} def={14} onChange={(v) => up({ bgRadius: v }, 'bgr')} />
          </>
        )}
      </Group>
    </>
  );
}

function ProjectSettings({ p }: { p: Project }) {
  return (
    <>
      <Group title="Format">
        <div className="aspect-grid">
          {ASPECTS.map((a) => (
            <button
              key={a.id}
              className={'aspect' + (a.w === p.width && a.h === p.height ? ' on' : '')}
              onClick={() =>
                edit((d) => {
                  d.width = a.w;
                  d.height = a.h;
                })
              }
            >
              <Shape w={a.w} h={a.h} size={22} />
              <div>
                <b>{a.name}</b>
                <small>{a.id}</small>
              </div>
            </button>
          ))}
        </div>
      </Group>
      <Group title="Kare hızı">
        <Segmented
          value={p.fps}
          onChange={(v) => edit((d) => void (d.fps = v))}
          options={[24, 25, 30, 50, 60].map((v) => ({ value: v, label: String(v) }))}
        />
      </Group>
      <Group title="Arka plan rengi">
        <div className="row">
          <ColorInput value={p.background} onChange={(v) => edit((d) => void (d.background = v), { key: 'bg' })} />
          <span className="muted">{p.background.toUpperCase()}</span>
        </div>
      </Group>
      <div className="empty-insp" style={{ paddingTop: 10 }}>
        Düzenlemek için zaman çizelgesinden ya da önizlemeden bir klip seç.
      </div>
    </>
  );
}

export default function Inspector() {
  const project = useStore((s) => s.project)!;
  const selection = useStore((s) => s.selection);
  const clip = selection.length === 1 ? project.clips.find((c) => c.id === selection[0]) : undefined;
  const tabs = clip ? tabsFor(clip, project) : [];
  const [tab, setTab] = useState<Tab>('visual');
  const clipKind = clip?.kind;
  useEffect(() => {
    if (clip) setTab(tabsFor(clip, project)[0]);
    // only when a different clip type gets selected
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id, clipKind]);
  const active = tabs.includes(tab) ? tab : tabs[0];

  return (
    <div className="panel">
      <div className="panel-head">
        {clip ? (
          <div className="insp-tabs">
            {tabs.map((t) => (
              <button key={t} className={'tab' + (active === t ? ' on' : '')} onClick={() => setTab(t)}>
                {TAB_NAMES[t]}
              </button>
            ))}
          </div>
        ) : (
          <span style={{ fontWeight: 600, paddingLeft: 4 }}>{selection.length > 1 ? `${selection.length} klip seçili` : 'Proje'}</span>
        )}
      </div>
      <div className="panel-body">
        {!clip && selection.length > 1 && (
          <div className="empty-insp">
            <button className="btn sm danger" onClick={() => deleteSelected()}>
              <Trash2 size={13} /> Seçilenleri sil
            </button>
          </div>
        )}
        {!clip && selection.length <= 1 && <ProjectSettings p={project} />}
        {clip && active === 'text' && <TextTab c={clip} />}
        {clip && active === 'visual' && <VisualTab c={clip} p={project} />}
        {clip && active === 'audio' && <AudioTab c={clip} />}
        {clip && active === 'speed' && <SpeedTab c={clip} />}
        {clip && active === 'color' && <ColorTab c={clip} />}
        {clip && active === 'vfx' && <VfxTab c={clip} />}
        {clip && (
          <p className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Scissors size={12} /> Bölmek için <kbd>S</kbd>, silmek için <kbd>Del</kbd>
          </p>
        )}
      </div>
    </div>
  );
}
