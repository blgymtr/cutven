import { useEffect, useReducer, useRef, useState } from 'react';
import { X, Camera, ImagePlus, Type, Trash2, ArrowUp, ArrowDown, Download, Image as ImageIcon } from 'lucide-react';
import { useStore, set, get, edit } from '../store';
import type { ThumbDesign, ThumbLayer, TextStyle } from '../types';
import { TW, TH, renderThumb, thumbDesignOf, newTextLayer, layerSize, saveThumbPng, defaultDesign } from '../lib/thumb';
import { PRESETS, DEFAULT_COLOR } from '../lib/color';
import { FONTS, measureText } from '../lib/text';
import { engine } from '../lib/engine';
import { uid } from '../lib/util';
import { Slider, Toggle, ColorInput } from './ui';

const QUICK_TEXTS = [
  { label: 'Büyük beyaz', patch: {} },
  { label: 'Sarı vurgu', patch: { color: '#ffe14d', font: 'Anton', weight: 400, size: 150 } },
  { label: 'Kırmızı kutu', patch: { bg: true, bgColor: '#ff0033', bgOpacity: 1, bgRadius: 10, bgPadding: 22, stroke: false, size: 90 } },
  { label: 'İnce alt yazı', patch: { font: 'Inter', weight: 700, size: 56, stroke: false, uppercase: false, shadowBlur: 14, shadowOffset: 3 } },
];

export default function ThumbDialog() {
  const project = useStore((s) => s.project)!;
  const d = thumbDesignOf(project);
  const [sel, setSel] = useState<string | null>(d.layers[0]?.id ?? null);
  const [, redraw] = useReducer((x) => x + 1, 0);
  const cvRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dispW, setDispW] = useState(760);

  const save = (fn: (x: ThumbDesign) => void, key?: string) =>
    edit((dr) => {
      if (!dr.thumbDesign) dr.thumbDesign = defaultDesign();
      fn(dr.thumbDesign as ThumbDesign);
    }, { key: key ? 'thumb-' + key : undefined });
  const layer = d.layers.find((l) => l.id === sel);
  const upLayer = (fn: (l: ThumbLayer) => void, key: string) =>
    save((x) => {
      const l = x.layers.find((q) => q.id === sel);
      if (l) fn(l);
    }, key + sel);
  const upText = (patch: Partial<TextStyle>, key: string) =>
    upLayer((l) => {
      l.text = { ...l.text!, ...patch };
      // keep long titles inside the frame
      const w = measureText(l.text).w * l.scale;
      if (w > TW - 80) l.scale = Math.max(0.2, ((TW - 80) / w) * l.scale);
    }, 'tx' + key);

  // create the design on first open so edits have a target
  useEffect(() => {
    if (!get().project?.thumbDesign) edit((dr) => void (dr.thumbDesign = defaultDesign()), { record: false });
    const ro = new ResizeObserver(() => wrapRef.current && setDispW(Math.min(wrapRef.current.clientWidth, 900)));
    if (wrapRef.current) ro.observe(wrapRef.current);
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') set({ thumbOpen: false });
    };
    window.addEventListener('keydown', k);
    return () => {
      ro.disconnect();
      window.removeEventListener('keydown', k);
    };
  }, []);

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(dispW * dpr);
    cv.height = Math.round(((dispW * TH) / TW) * dpr);
    renderThumb(cv.getContext('2d')!, d, cv.width, cv.height, redraw);
  });

  const k = dispW / TW;

  const grabFrame = async () => {
    const data = await engine.capture(1920, 'image/jpeg', 0.92);
    if (data) save((x) => Object.assign(x, { bg: data, bgScale: 1, bgX: 0, bgY: 0 }));
  };
  const pickBg = async () => {
    const p = await window.cv.invoke<string | null>('dialog:pickFile', 'Arka plan görseli');
    if (p) save((x) => Object.assign(x, { bg: p, bgScale: 1, bgX: 0, bgY: 0 }));
  };
  const addImage = async () => {
    const p = await window.cv.invoke<string | null>('dialog:pickFile', 'Görsel (ör. yüz kesiti PNG)');
    if (!p) return;
    const id = uid();
    save((x) => void x.layers.push({ id, kind: 'image', path: p, x: 300, y: 0, scale: 1.2, rotation: 0 }));
    setSel(id);
  };
  const addText = (patch: Partial<TextStyle>) => {
    const l = newTextLayer('YENİ YAZI', { y: -200 + d.layers.length * 60 });
    l.text = { ...l.text!, ...patch };
    save((x) => void x.layers.push(l));
    setSel(l.id);
  };

  const onDown = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = (e.clientX - r.left) / k - TW / 2;
    const py = (e.clientY - r.top) / k - TH / 2;
    let hit: ThumbLayer | undefined;
    for (let i = d.layers.length - 1; i >= 0; i--) {
      const l = d.layers[i];
      const s = layerSize(l);
      if (Math.abs(px - l.x) <= s.w / 2 && Math.abs(py - l.y) <= s.h / 2) {
        hit = l;
        break;
      }
    }
    const moveBg = !hit || e.shiftKey;
    if (hit && !moveBg) setSel(hit.id);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const start = moveBg ? { x: d.bgX, y: d.bgY } : { x: hit!.x, y: hit!.y };
    const id = hit?.id;
    const mv = (ev: PointerEvent) => {
      let nx = start.x + (ev.clientX - x0) / k;
      let ny = start.y + (ev.clientY - y0) / k;
      if (!moveBg && !ev.altKey) {
        if (Math.abs(nx) < 12) nx = 0;
        if (Math.abs(ny) < 12) ny = 0;
      }
      save((x) => {
        if (moveBg) {
          x.bgX = Math.round(nx);
          x.bgY = Math.round(ny);
        } else {
          const l = x.layers.find((q) => q.id === id);
          if (l) {
            l.x = Math.round(nx);
            l.y = Math.round(ny);
          }
        }
      }, 'drag');
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const move = (dir: -1 | 1) =>
    save((x) => {
      const i = x.layers.findIndex((l) => l.id === sel);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= x.layers.length) return;
      [x.layers[i], x.layers[j]] = [x.layers[j], x.layers[i]];
    });

  return (
    <div className="modal-back" onPointerDown={() => set({ thumbOpen: false })}>
      <div className="modal thumb-modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Küçük resim</h3>
          <button className="icon-btn" onClick={() => set({ thumbOpen: false })}>
            <X size={16} />
          </button>
        </div>
        <div className="thumb-body">
          <div className="thumb-stage" ref={wrapRef}>
            <div className="thumb-canvas" style={{ width: dispW, height: (dispW * TH) / TW }} onPointerDown={onDown}>
              <canvas ref={cvRef} style={{ width: '100%', height: '100%' }} />
              {layer && (() => {
                const s = layerSize(layer);
                return (
                  <div
                    className="thumb-sel"
                    style={{ left: (TW / 2 + layer.x - s.w / 2) * k, top: (TH / 2 + layer.y - s.h / 2) * k, width: s.w * k, height: s.h * k, transform: `rotate(${layer.rotation}deg)` }}
                  />
                );
              })()}
            </div>
            <p className="hint">Katmanı sürükleyerek taşı · boşluğa ya da Shift ile sürükleyince arka plan kayar · ortada mıknatıs, Alt ile kapat.</p>
            <div className="thumb-yt">
              <div className="thumb-yt-img">
                <canvas
                  ref={(cv) => {
                    if (!cv) return;
                    cv.width = 336;
                    cv.height = 189;
                    renderThumb(cv.getContext('2d')!, d, 336, 189);
                  }}
                />
              </div>
              <div>
                <b>{project.name}</b>
                <div className="muted">Kanal adı · 12 B görüntüleme · 1 saat önce</div>
                <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>YouTube önerilerinde bu boyutta görünür</div>
              </div>
            </div>
          </div>
          <div className="thumb-side">
            <div className="group">
              <div className="group-head">
                <h4>Arka plan</h4>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn sm" onClick={grabFrame} title="Önizlemedeki geçerli kare">
                  <Camera size={13} /> Şu anki kare
                </button>
                <button className="btn sm" onClick={pickBg}>
                  <ImageIcon size={13} /> Görsel
                </button>
                <ColorInput value={d.bgColor} onChange={(v) => save((x) => void (x.bgColor = v), 'bgc')} />
              </div>
              {d.bg && <Slider label="Yakınlaştır" value={d.bgScale} min={1} max={3} step={0.01} def={1} mult={100} unit="%" onChange={(v) => save((x) => void (x.bgScale = v), 'bgs')} />}
              <Slider label="Karartma" value={d.darken} min={0} max={0.8} step={0.01} def={0.15} mult={100} unit="%" onChange={(v) => save((x) => void (x.darken = v), 'dk')} />
              <Slider label="Vinyet" value={d.vignette} min={0} max={1} step={0.01} def={0.35} mult={100} unit="%" onChange={(v) => save((x) => void (x.vignette = v), 'vg')} />
              <div className="chips" style={{ marginTop: 8 }}>
                {PRESETS.slice(0, 8).map((p) => (
                  <button key={p.id} className={'chip' + (d.color.preset === p.id ? ' on' : '')} onClick={() => save((x) => void (x.color = { ...DEFAULT_COLOR, ...x.color, preset: p.id }))}>
                    {p.name}
                  </button>
                ))}
              </div>
              <Slider label="Doygunluk" value={d.color.saturation} min={-100} max={100} step={1} def={0} onChange={(v) => save((x) => void (x.color = { ...x.color, saturation: v }), 'sat')} />
              <Slider label="Kontrast" value={d.color.contrast} min={-100} max={100} step={1} def={0} onChange={(v) => save((x) => void (x.color = { ...x.color, contrast: v }), 'con')} />
            </div>

            <div className="group">
              <div className="group-head">
                <h4>Katmanlar</h4>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="btn sm" onClick={() => addText({})}>
                    <Type size={13} /> Yazı
                  </button>
                  <button className="btn sm" onClick={addImage}>
                    <ImagePlus size={13} /> Görsel
                  </button>
                </div>
              </div>
              <div className="layer-list">
                {[...d.layers].reverse().map((l) => (
                  <div key={l.id} className={'layer-row' + (l.id === sel ? ' on' : '')} onClick={() => setSel(l.id)}>
                    {l.kind === 'text' ? <Type size={13} /> : <ImageIcon size={13} />}
                    <span>{l.kind === 'text' ? l.text?.content.split('\n')[0] || 'Yazı' : 'Görsel'}</span>
                  </div>
                ))}
                {!d.layers.length && <div className="hint">Henüz katman yok.</div>}
              </div>
              {layer && (
                <div className="row" style={{ gap: 4, marginTop: 6 }}>
                  <button className="icon-btn sm" title="Öne getir" onClick={() => move(1)}>
                    <ArrowUp size={13} />
                  </button>
                  <button className="icon-btn sm" title="Arkaya gönder" onClick={() => move(-1)}>
                    <ArrowDown size={13} />
                  </button>
                  <div className="spacer" />
                  <button
                    className="icon-btn sm"
                    title="Katmanı sil"
                    onClick={() => {
                      save((x) => void (x.layers = x.layers.filter((q) => q.id !== sel)));
                      setSel(null);
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </div>

            {layer?.kind === 'text' && layer.text && (
              <div className="group">
                <textarea className="field" rows={2} value={layer.text.content} onChange={(e) => upText({ content: e.target.value }, 'c')} spellCheck={false} />
                <div className="chips" style={{ margin: '8px 0' }}>
                  {QUICK_TEXTS.map((q) => (
                    <button key={q.label} className="chip" onClick={() => upText({ ...newTextLayer('').text!, ...q.patch, content: layer.text!.content }, 'q')}>
                      {q.label}
                    </button>
                  ))}
                </div>
                <div className="row">
                  <select className="field" value={layer.text.font} onChange={(e) => upText({ font: e.target.value, weight: FONTS.find((f) => f.family === e.target.value)!.weights.slice(-1)[0] }, 'f')}>
                    {FONTS.map((f) => (
                      <option key={f.family}>{f.family}</option>
                    ))}
                  </select>
                  <ColorInput value={layer.text.color} onChange={(v) => upText({ color: v }, 'col')} />
                </div>
                <Slider label="Boyut" value={layer.text.size} min={30} max={300} step={1} def={120} onChange={(v) => upText({ size: v }, 's')} />
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-2)' }}>Kontur</span>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {layer.text.stroke && <ColorInput value={layer.text.strokeColor} onChange={(v) => upText({ strokeColor: v }, 'sc')} />}
                    <Toggle on={layer.text.stroke} onChange={(v) => upText({ stroke: v }, 'st')} />
                  </div>
                </div>
                {layer.text.stroke && <Slider label="Kalınlık" value={layer.text.strokeWidth} min={1} max={30} step={0.5} def={9} digits={1} onChange={(v) => upText({ strokeWidth: v }, 'sw')} />}
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-2)' }}>Kutu</span>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {layer.text.bg && <ColorInput value={layer.text.bgColor} onChange={(v) => upText({ bgColor: v }, 'bc')} />}
                    <Toggle on={layer.text.bg} onChange={(v) => upText({ bg: v, bgOpacity: 1 }, 'bg')} />
                  </div>
                </div>
                <Slider label="Döndür" value={layer.rotation} min={-30} max={30} step={0.5} def={0} unit="°" onChange={(v) => upLayer((l) => void (l.rotation = v), 'rot')} />
              </div>
            )}
            {layer?.kind === 'image' && (
              <div className="group">
                <Slider label="Boyut" value={layer.scale} min={0.2} max={4} step={0.01} def={1} mult={100} unit="%" onChange={(v) => upLayer((l) => void (l.scale = v), 'sc')} />
                <Slider label="Döndür" value={layer.rotation} min={-30} max={30} step={0.5} def={0} unit="°" onChange={(v) => upLayer((l) => void (l.rotation = v), 'rot')} />
              </div>
            )}
          </div>
        </div>
        <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
          <div className="row" style={{ gap: 10, minHeight: 0 }}>
            <Toggle on={d.embed} onChange={(v) => save((x) => void (x.embed = v))} />
            <span className="hint" style={{ margin: 0 }}>Dışa aktarılan MP4’e kapak olarak göm</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => saveThumbPng()}>
              <Download size={14} /> PNG kaydet
            </button>
            <button className="btn primary" onClick={() => set({ thumbOpen: false })}>
              Tamam
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
