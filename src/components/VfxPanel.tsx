import { useStore, edit, set, toast, get } from '../store';
import type { Clip } from '../types';
import { VFX, vfxDef, type VfxCat } from '../lib/vfx';
import { DND_TYPE } from './MediaPanel';
import { Slider } from './ui';
import { ArrowUp, ArrowDown, X, Music2 } from 'lucide-react';
import { videoTempo } from '../lib/tempo';

const CATS: VfxCat[] = ['Hareket', 'Lens', 'Retro', 'Stil'];

export function toggleVfx(clipId: string, id: string) {
  const c = get().project?.clips.find((x) => x.id === clipId);
  if (!c || c.kind === 'audio') return;
  const def = vfxDef(id)!;
  if (def.opaqueOnly && c.kind === 'text') {
    toast(`${def.name} metin kliplerinde kullanılamaz`);
    return;
  }
  const has = c.vfx?.some((v) => v.id === id);
  edit((d) => {
    const x = d.clips.find((q) => q.id === clipId)!;
    if (has) x.vfx = (x.vfx || []).filter((v) => v.id !== id);
    else {
      const bpm = def.bpm ? videoTempo(get().project!).bpm || 120 : undefined;
      x.vfx = [...(x.vfx || []), { id, amount: def.def, ...(bpm ? { bpm } : {}) }];
    }
    if (!x.vfx.length) x.vfx = undefined;
  });
  if (!has) toast(`${def.name} eklendi — ayarı sağ panelde “Efekt” sekmesinde`, 'success');
}

/** Little animated swatch hinting what the effect does. */
function Swatch({ id }: { id: string }) {
  return (
    <div className={'vfx-sw vfx-' + id}>
      <i />
    </div>
  );
}

export function VfxPanel() {
  const sel = useStore((s) => (s.selection.length === 1 ? s.project?.clips.find((c) => c.id === s.selection[0]) : undefined));
  const usable = sel && sel.kind !== 'audio';
  return (
    <>
      <p className="hint" style={{ marginTop: 0 }}>
        {usable ? 'Tıkla: seçili klibe ekle / kaldır. Birden fazla efekt üst üste kullanılabilir.' : 'Bir video, görsel ya da metin klibi seç; ya da efekti zaman çizelgesindeki klibin üzerine sürükle.'}
      </p>
      {CATS.map((cat) => (
        <div key={cat} style={{ marginBottom: 14 }}>
          <div className="section-title">{cat}</div>
          <div className="vfx-grid">
            {VFX.filter((v) => v.cat === cat).map((v) => {
              const on = !!sel?.vfx?.some((x) => x.id === v.id);
              return (
                <button
                  key={v.id}
                  className={'vfx-card' + (on ? ' on' : '')}
                  title={v.hint}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DND_TYPE, JSON.stringify({ type: 'vfx', id: v.id }));
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => (usable ? toggleVfx(sel!.id, v.id) : toast('Önce bir görsel klip seç'))}
                >
                  <Swatch id={v.id} />
                  <span>{v.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

/** Inspector tab: effects applied to one clip. */
export function VfxTab({ c }: { c: Clip }) {
  const list = c.vfx || [];
  const up = (fn: (x: Clip) => void, key?: string) =>
    edit((d) => {
      const x = d.clips.find((q) => q.id === c.id);
      if (x) fn(x as Clip);
    }, { key });
  if (!list.length)
    return (
      <div className="empty-insp">
        Bu klipte efekt yok.
        <br />
        <button className="btn sm" style={{ marginTop: 10 }} onClick={() => set({ leftTab: 'vfx' })}>
          Efektlere göz at
        </button>
      </div>
    );
  return (
    <>
      {list.map((v, i) => {
        const def = vfxDef(v.id);
        if (!def) return null;
        return (
          <div className="group" key={v.id}>
            <div className="group-head">
              <h4>{def.name}</h4>
              <div style={{ display: 'flex', gap: 2 }}>
                <button className="icon-btn sm" title="Yukarı" disabled={i === 0} onClick={() => up((x) => void ([x.vfx![i - 1], x.vfx![i]] = [x.vfx![i], x.vfx![i - 1]]))}>
                  <ArrowUp size={13} />
                </button>
                <button className="icon-btn sm" title="Aşağı" disabled={i === list.length - 1} onClick={() => up((x) => void ([x.vfx![i + 1], x.vfx![i]] = [x.vfx![i], x.vfx![i + 1]]))}>
                  <ArrowDown size={13} />
                </button>
                <button className="icon-btn sm" title="Kaldır" onClick={() => up((x) => void (x.vfx = x.vfx!.filter((q) => q.id !== v.id).length ? x.vfx!.filter((q) => q.id !== v.id) : undefined))}>
                  <X size={13} />
                </button>
              </div>
            </div>
            <Slider label="Şiddet" value={v.amount} min={0} max={1} step={0.01} def={def.def} mult={100} unit="%" onChange={(val) => up((x) => void (x.vfx![i].amount = val), 'vfx-' + c.id + v.id)} />
            {def.bpm && (
              <div className="row">
                <label>BPM</label>
                <input className="num" type="number" min={40} max={220} value={v.bpm || 120} onChange={(e) => up((x) => void (x.vfx![i].bpm = Math.max(40, Math.min(220, +e.target.value || 120))), 'bpm' + c.id)} />
                <button
                  className="btn sm ghost"
                  title="Müzikten algıla"
                  onClick={() => {
                    const b = videoTempo(get().project!).bpm;
                    if (b) up((x) => void (x.vfx![i].bpm = b));
                    else toast('Projede ritmi algılanacak müzik yok');
                  }}
                >
                  <Music2 size={13} /> Müzikten
                </button>
              </div>
            )}
            <p className="hint" style={{ margin: '4px 0 0' }}>{def.hint}</p>
          </div>
        );
      })}
      <button className="btn sm ghost" onClick={() => up((x) => void (x.vfx = undefined))}>
        Tüm efektleri kaldır
      </button>
    </>
  );
}
