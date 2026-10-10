import { useEffect, useRef, useState } from 'react';
import { Diamond, ChevronLeft, ChevronRight, RotateCcw, Upload, X, Crosshair } from 'lucide-react';
import { useStore } from '../store';
import type { BlendMode, Clip, Ease, Grade, KeyProp, Project, Pt, Wheel } from '../types';
import { updateClips } from '../lib/actions';
import { engine } from '../lib/engine';
import { KEY_PROPS, EASES, keyedValue, toggleKey, setProp, setEase, clearKeys, keyTimes, hasKeys } from '../lib/vkeys';
import { DEFAULT_GRADE, LOOKS, loadCube, cubeFor } from '../lib/lumetri';
import { clipDur } from '../lib/util';
import { Slider, Toggle, Segmented, ColorInput } from './ui';

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

/* ================================================================ keyframed transform */

const PROP_UI: Record<KeyProp, { min: number; max: number; step: number; def: number; mult?: number; unit?: string; digits?: number }> = {
  x: { min: -2000, max: 2000, step: 1, def: 0, unit: 'px' },
  y: { min: -2000, max: 2000, step: 1, def: 0, unit: 'px' },
  scale: { min: 0.05, max: 5, step: 0.01, def: 1, mult: 100, unit: '%' },
  rotation: { min: -360, max: 360, step: 0.5, def: 0, unit: '°' },
  opacity: { min: 0, max: 1, step: 0.01, def: 1, mult: 100, unit: '%' },
};

export function KeyedTransform({ c, p }: { c: Clip; p: Project }) {
  const time = useStore((s) => s.time);
  const dur = clipDur(c);
  const local = Math.min(Math.max(time - c.start, 0), dur);
  const inside = time >= c.start - 1e-3 && time <= c.start + dur + 1e-3;
  const s = c.in + local * c.speed;
  const tol = (1 / 30) * c.speed + 1e-4;
  const keyAt = (prop: KeyProp) => (c.keys?.[prop] || []).findIndex((k) => Math.abs(k.s - s) < tol);
  const times = keyTimes(c);
  const prev = [...times].reverse().find((t) => t < time - 1e-3);
  const next = times.find((t) => t > time + 1e-3);
  // ease of the segment that starts at (or before) the playhead
  const segEase = (() => {
    for (const pr of KEY_PROPS) {
      const k = c.keys?.[pr.id];
      if (!k?.length) continue;
      let i = -1;
      for (let j = 0; j < k.length; j++) if (k[j].s <= s + tol) i = j;
      if (i >= 0 && i < k.length - 1) return k[i].e;
    }
    return null;
  })();
  const applyEase = (e: Ease) => {
    for (const pr of KEY_PROPS) {
      const k = c.keys?.[pr.id];
      if (!k?.length) continue;
      let i = -1;
      for (let j = 0; j < k.length; j++) if (k[j].s <= s + tol) i = j;
      if (i >= 0 && i < k.length - 1) setEase(c.id, pr.id, i, e);
    }
  };
  const lim = (pr: KeyProp) => (pr === 'x' ? p.width : pr === 'y' ? p.height : 0);
  return (
    <>
      {KEY_PROPS.map((pr) => {
        const u = PROP_UI[pr.id];
        const keyed = hasKeys(c, pr.id);
        const on = keyed && keyAt(pr.id) >= 0;
        const v = keyed ? keyedValue(c, pr.id, local) : (c[pr.id] as number);
        const L = lim(pr.id);
        return (
          <div className="kf-row" key={pr.id}>
            <Slider
              label={pr.name}
              value={v}
              min={L ? -L : u.min}
              max={L ? L : u.max}
              step={u.step}
              def={u.def}
              mult={u.mult}
              unit={u.unit}
              digits={u.digits}
              onChange={(nv) => updateClips([c.id], (x) => setProp(x, pr.id, nv), 'kp-' + pr.id + c.id)}
            />
            <button
              className={'kf-dia' + (on ? ' on' : keyed ? ' keyed' : '')}
              disabled={!inside}
              title={on ? 'Bu anahtar kareyi kaldır' : 'İmlece anahtar kare ekle'}
              onClick={() => toggleKey(c.id, pr.id)}
            >
              <Diamond size={12} fill={on ? 'currentColor' : 'none'} />
            </button>
          </div>
        );
      })}
      <div className="row kf-nav">
        <button className="icon-btn sm" disabled={prev == null} title="Önceki anahtar kare" onClick={() => prev != null && engine.seek(prev)}>
          <ChevronLeft size={14} />
        </button>
        <span className="muted">{times.length ? `${times.length} kare` : 'Anahtar kare yok'}</span>
        <button className="icon-btn sm" disabled={next == null} title="Sonraki anahtar kare" onClick={() => next != null && engine.seek(next)}>
          <ChevronRight size={14} />
        </button>
        {segEase && (
          <select className="field sm" value={segEase} title="Bu karedan sonraki geçişin eğrisi" onChange={(e) => applyEase(e.target.value as Ease)}>
            {EASES.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        )}
        {times.length > 0 && (
          <button className="btn sm ghost" onClick={() => clearKeys(c.id)}>
            Tümünü sil
          </button>
        )}
      </div>
      <p className="hint">◆ ile değerin o anki halini kaydet, imleci ilerletip değeri değiştir; Cutven aradaki hareketi kendisi oluşturur (Ken Burns, kayan yazı, büyüme).</p>
    </>
  );
}

/* ================================================================ blend / crop / key */

export const BLENDS: { id: BlendMode; name: string }[] = [
  { id: 'normal', name: 'Normal' },
  { id: 'multiply', name: 'Çarp (Multiply)' },
  { id: 'screen', name: 'Ekran (Screen)' },
  { id: 'overlay', name: 'Bindirme (Overlay)' },
  { id: 'soft-light', name: 'Yumuşak ışık' },
  { id: 'hard-light', name: 'Sert ışık' },
  { id: 'darken', name: 'Koyulaştır' },
  { id: 'lighten', name: 'Açıklaştır' },
  { id: 'color-dodge', name: 'Renk soldurma' },
  { id: 'color-burn', name: 'Renk yakma' },
  { id: 'add', name: 'Ekle (Add)' },
  { id: 'difference', name: 'Fark' },
  { id: 'exclusion', name: 'Dışlama' },
];

export function CompositeGroups({ c }: { c: Clip }) {
  const up = (fn: (x: Clip) => void, key: string) => updateClips([c.id], fn as any, key + c.id);
  const cr = c.crop || { l: 0, r: 0, t: 0, b: 0 };
  const k = c.ckey || { on: false, color: '#00ff00', similarity: 0.12, smooth: 0.08, spill: 0.5 };
  const media = c.kind === 'video' || c.kind === 'image';
  const setCrop = (patch: Partial<typeof cr>, key: string) => up((x) => void (x.crop = { ...cr, ...patch }), 'crop' + key);
  const setKey = (patch: Partial<typeof k>, key: string) => up((x) => void (x.ckey = { ...k, ...patch }), 'ck' + key);
  return (
    <>
      <Group title="Karışım">
        <div className="row">
          <label>Mod</label>
          <select className="field" value={c.blend || 'normal'} onChange={(e) => up((x) => void (x.blend = e.target.value === 'normal' ? undefined : (e.target.value as BlendMode)), 'blend')}>
            {BLENDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <p className="hint">Üst izdeki klibi alttakiyle karıştırır. Işık sızıntısı, toz, ateş gibi siyah zeminli videolar için “Ekran” kullan.</p>
      </Group>
      {media && (
        <Group
          title="Kırpma"
          right={
            <button className="icon-btn sm" title="Kırpmayı sıfırla" onClick={() => up((x) => void (x.crop = undefined), 'crop0')}>
              <RotateCcw size={13} />
            </button>
          }
        >
          <Slider label="Sol" value={cr.l} min={0} max={95 - cr.r} step={0.5} def={0} digits={1} unit="%" onChange={(v) => setCrop({ l: v }, 'l')} />
          <Slider label="Sağ" value={cr.r} min={0} max={95 - cr.l} step={0.5} def={0} digits={1} unit="%" onChange={(v) => setCrop({ r: v }, 'r')} />
          <Slider label="Üst" value={cr.t} min={0} max={95 - cr.b} step={0.5} def={0} digits={1} unit="%" onChange={(v) => setCrop({ t: v }, 't')} />
          <Slider label="Alt" value={cr.b} min={0} max={95 - cr.t} step={0.5} def={0} digits={1} unit="%" onChange={(v) => setCrop({ b: v }, 'b')} />
        </Group>
      )}
      {media && (
        <Group title="Yeşil ekran (chroma key)" right={<Toggle on={k.on} onChange={(v) => setKey({ on: v }, 'on')} title="Anahtarlamayı aç/kapat" />}>
          <div className="row">
            <label>Renk</label>
            <ColorInput value={k.color} onChange={(v) => setKey({ color: v, on: true }, 'col')} />
            <div className="chips">
              <button className={'chip' + (k.color === '#00ff00' ? ' on' : '')} onClick={() => setKey({ color: '#00ff00', on: true }, 'col')}>
                Yeşil
              </button>
              <button className={'chip' + (k.color === '#0047bb' ? ' on' : '')} onClick={() => setKey({ color: '#0047bb', on: true }, 'col')}>
                Mavi
              </button>
              <PickColor onPick={(col) => setKey({ color: col, on: true }, 'col')} />
            </div>
          </div>
          <Slider label="Tolerans" value={k.similarity} min={0.01} max={0.5} step={0.005} def={0.12} mult={100} onChange={(v) => setKey({ similarity: v }, 'sim')} />
          <Slider label="Yumuşatma" value={k.smooth} min={0} max={0.3} step={0.005} def={0.08} mult={100} onChange={(v) => setKey({ smooth: v }, 'sm')} />
          <Slider label="Taşma gider" value={k.spill} min={0} max={1} step={0.01} def={0.5} mult={100} unit="%" onChange={(v) => setKey({ spill: v }, 'sp')} />
          <p className="hint">Arka planı silmek istediğin klibi üst ize koy. Kenarlarda yeşil kalırsa “Taşma gider”i artır.</p>
        </Group>
      )}
    </>
  );
}

/** pick a colour from the preview canvas (click on the picture) */
function PickColor({ onPick }: { onPick: (hex: string) => void }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const cv = document.querySelector<HTMLCanvasElement>('.canvas-wrap canvas');
    if (!cv) return setOn(false);
    const h = (e: PointerEvent) => {
      if (e.target !== cv && !(e.target as HTMLElement).closest('.canvas-wrap')) return setOn(false);
      e.stopPropagation();
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const x = Math.round(((e.clientX - r.left) / r.width) * cv.width);
      const y = Math.round(((e.clientY - r.top) / r.height) * cv.height);
      // sample the un-keyed picture: grab from the engine's raw frame if possible, else canvas
      const g = cv.getContext('2d')!;
      const d = g.getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5).data;
      let rr = 0, gg = 0, bb = 0;
      for (let i = 0; i < d.length; i += 4) (rr += d[i]), (gg += d[i + 1]), (bb += d[i + 2]);
      const n = d.length / 4;
      const hex = '#' + [rr, gg, bb].map((v) => Math.round(v / n).toString(16).padStart(2, '0')).join('');
      onPick(hex);
      setOn(false);
    };
    document.addEventListener('pointerdown', h, true);
    document.body.classList.add('picking');
    return () => {
      document.removeEventListener('pointerdown', h, true);
      document.body.classList.remove('picking');
    };
  }, [on, onPick]);
  return (
    <button className={'chip' + (on ? ' on' : '')} title="Önizlemeden renk seç" onClick={() => setOn(!on)}>
      <Crosshair size={12} /> Seç
    </button>
  );
}

/* ================================================================ Lumetri */

export function LumetriGroups({ c }: { c: Clip }) {
  const g: Grade = c.grade || { ...DEFAULT_GRADE, on: true };
  const [, force] = useState(0);
  const up = (patch: Partial<Grade>, key: string) => updateClips([c.id], (x) => void (x.grade = { ...(x.grade || DEFAULT_GRADE), on: true, ...patch } as Grade), 'lm-' + key + c.id);
  useEffect(() => {
    if (g.lut?.path && !cubeFor(g.lut.path)) loadCube(g.lut.path).then(() => force((n) => n + 1)).catch(() => {});
  }, [g.lut?.path]);
  const pickLut = async () => {
    const path = await window.cv.invoke<string | null>('dialog:pickFile', 'LUT dosyası (.cube)', ['cube']);
    if (!path) return;
    try {
      await loadCube(path);
      up({ lut: { name: path.split(/[\\/]/).pop()!.replace(/\.cube$/i, ''), path, amt: 1 } }, 'lut');
    } catch {
      alertLut();
    }
  };
  return (
    <>
      <Group
        title="Lumetri · Temel"
        right={
          <div className="row" style={{ gap: 6, margin: 0 }}>
            <button className="icon-btn sm" title="Lumetri ayarlarını sıfırla" onClick={() => updateClips([c.id], (x) => void (x.grade = undefined), 'lm-reset' + c.id)}>
              <RotateCcw size={13} />
            </button>
            <Toggle on={!!c.grade?.on} onChange={(v) => up({ on: v }, 'on')} title="Lumetri aç/kapat (karşılaştır)" />
          </div>
        }
      >
        <Slider label="Pozlama" value={g.exposure} min={-3} max={3} step={0.05} def={0} digits={2} unit=" EV" onChange={(v) => up({ exposure: v }, 'exp')} />
        <Slider label="Vurgular" value={g.highlights} min={-100} max={100} step={1} def={0} onChange={(v) => up({ highlights: v }, 'hi')} />
        <Slider label="Gölgeler" value={g.shadows} min={-100} max={100} step={1} def={0} onChange={(v) => up({ shadows: v }, 'sh')} />
        <Slider label="Beyazlar" value={g.whites} min={-100} max={100} step={1} def={0} onChange={(v) => up({ whites: v }, 'wh')} />
        <Slider label="Siyahlar" value={g.blacks} min={-100} max={100} step={1} def={0} onChange={(v) => up({ blacks: v }, 'bl')} />
        <Slider label="Renk tonu" value={g.tint} min={-100} max={100} step={1} def={0} onChange={(v) => up({ tint: v }, 'tint')} />
        <Slider label="Canlılık" value={g.vibrance} min={-100} max={100} step={1} def={0} onChange={(v) => up({ vibrance: v }, 'vib')} />
      </Group>
      <Group title="Yaratıcı görünüm">
        <div className="chips">
          {LOOKS.map((l) => (
            <button key={l.id} className={'chip' + (g.look === l.id ? ' on' : '')} onClick={() => up({ look: l.id }, 'look')}>
              {l.name}
            </button>
          ))}
        </div>
        {g.look !== 'none' && <Slider label="Yoğunluk" value={g.lookAmt} min={0} max={1} step={0.01} def={1} mult={100} unit="%" onChange={(v) => up({ lookAmt: v }, 'la')} />}
        <div className="row" style={{ marginTop: 8 }}>
          {g.lut ? (
            <>
              <span className="chip on" title={g.lut.path}>
                LUT: {g.lut.name}
              </span>
              <button className="icon-btn sm" title="LUT'u kaldır" onClick={() => up({ lut: undefined }, 'lut')}>
                <X size={13} />
              </button>
            </>
          ) : (
            <button className="btn sm" onClick={pickLut}>
              <Upload size={13} /> LUT yükle (.cube)
            </button>
          )}
        </div>
        {g.lut && <Slider label="LUT gücü" value={g.lut.amt} min={0} max={1} step={0.01} def={1} mult={100} unit="%" onChange={(v) => up({ lut: { ...g.lut!, amt: v } }, 'lamt')} />}
        {g.lut && !cubeFor(g.lut.path) && <p className="hint">LUT dosyası bulunamadı: {g.lut.path}</p>}
      </Group>
      <Group title="Eğriler">
        <CurveEditor g={g} onChange={(curves, key) => up({ curves }, 'cv' + key)} />
      </Group>
      <Group title="Renk tekerlekleri">
        <div className="wheels">
          {(['shadows', 'mids', 'highs'] as const).map((w) => (
            <ColorWheel key={w} name={w === 'shadows' ? 'Gölgeler' : w === 'mids' ? 'Orta tonlar' : 'Vurgular'} v={g.wheels[w]} onChange={(nv) => up({ wheels: { ...g.wheels, [w]: nv } }, 'wh' + w)} />
          ))}
        </div>
      </Group>
      <HslGroup g={g} up={up} />
    </>
  );
}

function alertLut() {
  import('./ui').then((m) => m.askConfirm('LUT okunamadı', { text: 'Dosya geçerli bir .cube 3D LUT değil.', ok: 'Tamam' }));
}

const HSL_PRESETS = [
  { name: 'Ten', hue: 25, range: 25 },
  { name: 'Gökyüzü', hue: 210, range: 30 },
  { name: 'Yeşillik', hue: 100, range: 35 },
  { name: 'Kırmızı', hue: 0, range: 20 },
];

function HslGroup({ g, up }: { g: Grade; up: (p: Partial<Grade>, key: string) => void }) {
  const h = g.hsl;
  const set = (patch: Partial<Grade['hsl']>, key: string) => up({ hsl: { ...h, ...patch } }, 'hsl' + key);
  return (
    <Group title="HSL ikincil" right={<Toggle on={h.on} onChange={(v) => set({ on: v }, 'on')} title="Sadece bir rengi değiştir" />}>
      {h.on && (
        <>
          <div className="chips" style={{ marginBottom: 6 }}>
            {HSL_PRESETS.map((pr) => (
              <button key={pr.name} className={'chip' + (h.hue === pr.hue ? ' on' : '')} onClick={() => set({ hue: pr.hue, range: pr.range }, 'pre')}>
                {pr.name}
              </button>
            ))}
          </div>
          <div className="row">
            <label>Seçilen</label>
            <div className="hue-bar grow">
              <span style={{ left: `${(h.hue / 360) * 100}%` }} />
            </div>
          </div>
          <Slider label="Renk" value={h.hue} min={0} max={360} step={1} def={120} unit="°" onChange={(v) => set({ hue: v }, 'hue')} />
          <Slider label="Aralık" value={h.range} min={5} max={90} step={1} def={30} unit="°" onChange={(v) => set({ range: v }, 'rg')} />
          <Slider label="En az doy." value={h.satMin} min={0} max={0.8} step={0.01} def={0.15} mult={100} unit="%" onChange={(v) => set({ satMin: v }, 'sm')} />
          <Slider label="Yumuşaklık" value={h.soft} min={0} max={1} step={0.01} def={0.5} mult={100} unit="%" onChange={(v) => set({ soft: v }, 'so')} />
          <div className="row">
            <label>Maskeyi göster</label>
            <Toggle on={h.show} onChange={(v) => set({ show: v }, 'show')} />
          </div>
          <Slider label="Ton kaydır" value={h.dHue} min={-180} max={180} step={1} def={0} unit="°" onChange={(v) => set({ dHue: v }, 'dh')} />
          <Slider label="Doygunluk" value={h.dSat} min={-100} max={100} step={1} def={0} onChange={(v) => set({ dSat: v }, 'ds')} />
          <Slider label="Parlaklık" value={h.dLum} min={-100} max={100} step={1} def={0} onChange={(v) => set({ dLum: v }, 'dl')} />
        </>
      )}
      {!h.on && <p className="hint">Sadece tek bir rengi (ör. gökyüzünü ya da ten rengini) değiştirmek için aç.</p>}
    </Group>
  );
}

/* ------------------------------------------------------------ curves */

const CH = [
  { id: 'm', name: 'Ana', col: 'var(--text)' },
  { id: 'r', name: 'K', col: '#ff5a5a' },
  { id: 'g', name: 'Y', col: '#4cd07d' },
  { id: 'b', name: 'M', col: '#5a8cff' },
] as const;

function monotone(pts: Pt[], x: number) {
  // same monotone cubic as lumetri.curveTable (sampled for drawing)
  const n = pts.length;
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[n - 1][0]) return pts[n - 1][1];
  const d: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / Math.max(1e-6, pts[i + 1][0] - pts[i][0]));
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) (m[i] = 0), (m[i + 1] = 0);
    else {
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[i] = t * a * d[i];
        m[i + 1] = t * b * d[i];
      }
    }
  }
  let i = 0;
  while (i < n - 2 && x > pts[i + 1][0]) i++;
  const h = pts[i + 1][0] - pts[i][0];
  const t = (x - pts[i][0]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * pts[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * pts[i + 1][1] + (t3 - t2) * h * m[i + 1];
}

function CurveEditor({ g, onChange }: { g: Grade; onChange: (c: Grade['curves'], key: string) => void }) {
  const [ch, setCh] = useState<'m' | 'r' | 'g' | 'b'>('m');
  const ref = useRef<SVGSVGElement>(null);
  const S = 200;
  const pts = g.curves[ch];
  const col = CH.find((x) => x.id === ch)!.col;
  const set = (np: Pt[]) => onChange({ ...g.curves, [ch]: np }, ch);
  const toPt = (e: { clientX: number; clientY: number }): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  };
  const drag = (i: number, e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const start = pts;
    const move = (ev: PointerEvent) => {
      const [x, y] = toPt(ev);
      const np = start.map((p) => [...p] as Pt);
      const lo = i === 0 ? 0 : np[i - 1][0] + 0.01;
      const hi = i === np.length - 1 ? 1 : np[i + 1][0] - 0.01;
      np[i] = [i === 0 || i === np.length - 1 ? (i === 0 ? Math.min(x, hi) : Math.max(x, lo)) : Math.min(hi, Math.max(lo, x)), y];
      set(np);
    };
    const upH = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', upH);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', upH);
  };
  const add = (e: React.PointerEvent) => {
    const [x] = toPt(e);
    const y = monotone(pts, x);
    const np = [...pts.map((p) => [...p] as Pt), [x, y] as Pt].sort((a, b) => a[0] - b[0]);
    set(np);
  };
  let path = '';
  for (let i = 0; i <= 64; i++) {
    const x = i / 64;
    path += `${i ? 'L' : 'M'}${(x * S).toFixed(1)},${((1 - Math.min(1, Math.max(0, monotone(pts, x)))) * S).toFixed(1)}`;
  }
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <Segmented value={ch} options={CH.map((x) => ({ value: x.id, label: <span style={{ color: x.id === 'm' ? undefined : x.col }}>{x.name}</span> }))} onChange={setCh} />
        <button className="icon-btn sm" title="Bu eğriyi sıfırla" onClick={() => set([[0, 0], [1, 1]])}>
          <RotateCcw size={13} />
        </button>
      </div>
      <svg ref={ref} className="curve" viewBox={`0 0 ${S} ${S}`} onPointerDown={add}>
        {[0.25, 0.5, 0.75].map((v) => (
          <g key={v}>
            <line x1={v * S} y1={0} x2={v * S} y2={S} />
            <line x1={0} y1={v * S} x2={S} y2={v * S} />
          </g>
        ))}
        <line x1={0} y1={S} x2={S} y2={0} className="diag" />
        <path d={path} style={{ stroke: col }} />
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={p[0] * S}
            cy={(1 - p[1]) * S}
            r={5}
            style={{ stroke: col }}
            onPointerDown={(e) => drag(i, e)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (i > 0 && i < pts.length - 1) set(pts.filter((_, j) => j !== i));
            }}
          />
        ))}
      </svg>
      <p className="hint">Tıkla: nokta ekle · sürükle: eğ · çift tıkla: sil. Hafif “S” şekli kontrast verir.</p>
    </>
  );
}

/* ------------------------------------------------------------ colour wheel */

function ColorWheel({ name, v, onChange }: { name: string; v: Wheel; onChange: (w: Wheel) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const R = 44;
  const set = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const a = Math.min(1, Math.hypot(dx, dy) / R);
    const h = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
    onChange({ ...v, h: Math.round(h), a: Math.round(a * 100) / 100 });
  };
  const down = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    set(e);
    const move = (ev: PointerEvent) => set(ev);
    const upH = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', upH);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', upH);
  };
  const rad = (v.h * Math.PI) / 180;
  return (
    <div className="wheel">
      <div ref={ref} className="wheel-pad" onPointerDown={down} onDoubleClick={() => onChange({ h: 0, a: 0, l: 0 })} title="Sürükle · çift tıkla: sıfırla">
        <span className="wheel-dot" style={{ left: `calc(50% + ${Math.cos(rad) * v.a * R}px)`, top: `calc(50% - ${Math.sin(rad) * v.a * R}px)` }} />
      </div>
      <div className="wheel-name">{name}</div>
      <input type="range" min={-100} max={100} step={1} value={v.l} title="Parlaklık" onChange={(e) => onChange({ ...v, l: parseFloat(e.target.value) })} onDoubleClick={() => onChange({ ...v, l: 0 })} />
    </div>
  );
}

/* ================================================================ scopes */

type ScopeKind = 'wave' | 'vector' | 'hist';

export function Scopes() {
  const [kind, setKind] = useState<ScopeKind>('wave');
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const sm = document.createElement('canvas');
    const SW = 160;
    let stop = false;
    const tick = () => {
      if (stop) return;
      const src = document.querySelector<HTMLCanvasElement>('.canvas-wrap canvas');
      const out = ref.current;
      if (src && out && src.width > 0) {
        const SH = Math.max(1, Math.round((SW * src.height) / src.width));
        sm.width = SW;
        sm.height = SH;
        const sg = sm.getContext('2d', { willReadFrequently: true })!;
        sg.drawImage(src, 0, 0, SW, SH);
        draw(kind, sg.getImageData(0, 0, SW, SH), out);
      }
      setTimeout(() => requestAnimationFrame(tick), 150);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [kind]);
  return (
    <Group title="Skoplar" right={<Segmented value={kind} options={[{ value: 'wave', label: 'Dalga' }, { value: 'vector', label: 'Vektör' }, { value: 'hist', label: 'Histogram' }]} onChange={setKind} />}>
      <canvas ref={ref} className="scope" width={256} height={kind === 'vector' ? 256 : 160} />
    </Group>
  );
}

function draw(kind: ScopeKind, img: ImageData, out: HTMLCanvasElement) {
  const W = out.width;
  const H = out.height;
  const g = out.getContext('2d')!;
  const o = g.createImageData(W, H);
  const acc = new Float32Array(W * H * 3);
  const d = img.data;
  const iw = img.width;
  if (kind === 'wave') {
    for (let i = 0; i < d.length; i += 4) {
      const px = (i / 4) % iw;
      const x = Math.floor((px / iw) * W);
      const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const yy = H - 1 - Math.round((y / 255) * (H - 1));
      const j = (yy * W + x) * 3;
      acc[j] += 1;
      acc[j + 1] += 1;
      acc[j + 2] += 1;
    }
  } else if (kind === 'vector') {
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const u = -0.1146 * r - 0.3854 * gg + 0.5 * b;
      const v = 0.5 * r - 0.4542 * gg - 0.0458 * b;
      const x = Math.round(W / 2 + (u / 128) * (W / 2) * 0.95);
      const y = Math.round(H / 2 - (v / 128) * (H / 2) * 0.95);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const j = (y * W + x) * 3;
      acc[j] += r / 255 + 0.3;
      acc[j + 1] += gg / 255 + 0.3;
      acc[j + 2] += b / 255 + 0.3;
    }
  } else {
    const hist = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) hist[c][d[i + c]]++;
    let mx = 1;
    for (const h of hist) for (let i = 2; i < 254; i++) mx = Math.max(mx, h[i]);
    for (let c = 0; c < 3; c++)
      for (let x = 0; x < W; x++) {
        const v = hist[c][Math.floor((x / W) * 256)] / mx;
        const top = Math.max(0, H - Math.round(v * H));
        for (let y = top; y < H; y++) acc[(y * W + x) * 3 + c] = 0.6;
      }
  }
  const gain = kind === 'hist' ? 255 : kind === 'wave' ? 70 : 90;
  for (let i = 0, j = 0; i < acc.length; i += 3, j += 4) {
    o.data[j] = Math.min(255, acc[i] * gain);
    o.data[j + 1] = Math.min(255, acc[i + 1] * gain);
    o.data[j + 2] = Math.min(255, acc[i + 2] * gain);
    o.data[j + 3] = 255;
  }
  g.putImageData(o, 0, 0);
  // graticule
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  g.lineWidth = 1;
  if (kind === 'vector') {
    g.beginPath();
    g.arc(W / 2, H / 2, (W / 2) * 0.95, 0, Math.PI * 2);
    g.moveTo(W / 2, 0);
    g.lineTo(W / 2, H);
    g.moveTo(0, H / 2);
    g.lineTo(W, H / 2);
    g.stroke();
    // skin tone line (~123°)
    g.strokeStyle = 'rgba(255,180,120,0.35)';
    g.beginPath();
    g.moveTo(W / 2, H / 2);
    const a = (123 * Math.PI) / 180;
    g.lineTo(W / 2 + Math.cos(a) * W * 0.47, H / 2 - Math.sin(a) * H * 0.47);
    g.stroke();
  } else {
    for (const f of [0.25, 0.5, 0.75]) {
      g.beginPath();
      g.moveTo(0, Math.round(H * f) + 0.5);
      g.lineTo(W, Math.round(H * f) + 0.5);
      g.stroke();
    }
  }
}
