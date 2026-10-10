import { useEffect, useRef, useState } from 'react';
import { RotateCcw, Undo2, Film, Music } from 'lucide-react';
import { useStore, edit, get, undo, redo, type Snap } from '../store';
import { engine } from '../lib/engine';
import type { MeterReading } from '../lib/mix';
import { Slider } from './ui';

/* ================================================================ loudness meter */

const YT_TARGET = -14;
const dbPct = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
const fmtL = (v: number) => (v <= -70 ? '−∞' : v.toFixed(1));

export function LoudnessMeter({ compact }: { compact?: boolean }) {
  const [r, setR] = useState<MeterReading | null>(null);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 50) return;
      last = now;
      const m = engine.meter;
      if (m) setR(m.read(engine.playing));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const v = r || { peakL: -120, peakR: -120, holdL: -120, holdR: -120, momentary: -120, shortTerm: -120, integrated: -120 };
  const clip = v.holdL > -0.5 || v.holdR > -0.5;
  const integ = v.integrated;
  const verdict =
    integ <= -70 ? 'Ölçmek için videoyu oynat' : integ > YT_TARGET + 1.5 ? 'Biraz yüksek — dışa aktarmada “Ses seviyesini eşitle” açık kalsın' : integ < YT_TARGET - 3 ? 'Kısık — YouTube’da diğer videolardan sessiz kalır' : 'YouTube için ideal';
  return (
    <div className={'meter' + (compact ? ' compact' : '')}>
      <div className="meter-bars">
        {(['L', 'R'] as const).map((ch) => {
          const pk = ch === 'L' ? v.peakL : v.peakR;
          const hd = ch === 'L' ? v.holdL : v.holdR;
          return (
            <div key={ch} className="meter-bar">
              <span className="meter-ch">{ch}</span>
              <div className="meter-track">
                <div className="meter-fill" style={{ width: `${dbPct(pk)}%` }} />
                <div className="meter-hold" style={{ left: `${dbPct(hd)}%` }} />
              </div>
            </div>
          );
        })}
        <div className="meter-scale">
          {[-48, -36, -24, -12, -6, 0].map((d) => (
            <span key={d} style={{ left: `${dbPct(d)}%` }}>
              {d}
            </span>
          ))}
        </div>
      </div>
      <div className="meter-nums">
        <div>
          <b>{fmtL(v.momentary)}</b>
          <span>Anlık</span>
        </div>
        <div>
          <b>{fmtL(v.shortTerm)}</b>
          <span>Kısa (3 sn)</span>
        </div>
        <div className={integ > -70 && Math.abs(integ - YT_TARGET) <= 1.5 ? 'ok' : ''}>
          <b>{fmtL(integ)}</b>
          <span>Toplam LUFS</span>
        </div>
        <div className={clip ? 'bad' : ''}>
          <b>{fmtL(Math.max(v.holdL, v.holdR))}</b>
          <span>Tepe dBFS</span>
        </div>
      </div>
      {!compact && (
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
          <span className="hint" style={{ margin: 0 }}>
            {clip ? 'Tepe 0 dB’e dayanıyor: sesi biraz kıs ya da klibe Limiter ekle.' : verdict}
          </span>
          <button className="icon-btn sm" title="Ölçümü sıfırla" onClick={() => engine.meter?.reset()}>
            <RotateCcw size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

/* ================================================================ track mixer */

export function MixerPanel() {
  const project = useStore((s) => s.project)!;
  const tracks = project.tracks.filter((t) => t.type === 'audio' || project.clips.some((c) => c.trackId === t.id && c.kind === 'video'));
  const setTrack = (id: string, patch: Record<string, unknown>, key: string) =>
    edit(
      (d) => {
        const t = d.tracks.find((x) => x.id === id);
        if (t) Object.assign(t, patch);
      },
      { key: 'mix-' + key + id },
    );
  return (
    <div className="mixer">
      <LoudnessMeter />
      <p className="hint">YouTube sesleri −14 LUFS’a eşitler. Dışa aktarmadaki “Ses seviyesini eşitle” bunu otomatik yapar.</p>
      {tracks.map((t) => {
        const Icon = t.type === 'audio' ? Music : Film;
        return (
          <div key={t.id} className="mix-strip">
            <div className="mix-head">
              <Icon size={13} />
              <span className="grow">{t.name}</span>
              <button className={'mix-btn' + (t.muted ? ' on mute' : '')} title="Sessize al" onClick={() => setTrack(t.id, { muted: !t.muted }, 'm')}>
                M
              </button>
              <button className={'mix-btn' + (t.solo ? ' on solo' : '')} title="Yalnız bunu dinle (solo)" onClick={() => setTrack(t.id, { solo: !t.solo }, 's')}>
                S
              </button>
            </div>
            <Slider label="Ses" value={t.volume ?? 1} min={0} max={2} step={0.01} def={1} mult={100} unit="%" onChange={(v) => setTrack(t.id, { volume: v }, 'v')} />
            <Slider label="Pan" value={t.pan ?? 0} min={-1} max={1} step={0.01} def={0} mult={100} onChange={(v) => setTrack(t.id, { pan: Math.abs(v) < 0.02 ? 0 : v }, 'p')} />
          </div>
        );
      })}
      {!tracks.length && <p className="hint">Sesli iz yok.</p>}
    </div>
  );
}

/* ================================================================ history */

function describe(a: Snap, b: Snap): string {
  const ac = a.clips.length;
  const bc = b.clips.length;
  if (bc > ac) return bc - ac === 1 ? 'Klip eklendi' : `${bc - ac} klip eklendi`;
  if (bc < ac) return ac - bc === 1 ? 'Klip silindi' : `${ac - bc} klip silindi`;
  if (a.tracks.length !== b.tracks.length) return b.tracks.length > a.tracks.length ? 'İz eklendi' : 'İz silindi';
  if (a.markers !== b.markers) return 'İşaretçi değişti';
  if (a.captions !== b.captions) return 'Altyazı düzenlendi';
  if (a.captionStyle !== b.captionStyle) return 'Altyazı stili';
  if (a.inPoint !== b.inPoint || a.outPoint !== b.outPoint) return 'Giriş / çıkış noktası';
  if (a.width !== b.width || a.height !== b.height) return 'Format değişti';
  if (a.name !== b.name) return 'Proje adı';
  if (a.background !== b.background || a.fps !== b.fps) return 'Proje ayarı';
  if (a.tracks !== b.tracks) return 'İz ayarı (ses / kilit / gizle)';
  if (a.clips !== b.clips) {
    const changed = b.clips.filter((c) => !a.clips.includes(c));
    if (changed.length > 1) return `${changed.length} klip değişti`;
    const c = changed[0];
    const o = c && a.clips.find((x) => x.id === c.id);
    if (c && o) {
      if (c.start !== o.start || c.trackId !== o.trackId) return 'Klip taşındı';
      if (c.in !== o.in || c.out !== o.out) return 'Klip kırpıldı';
      if (c.speed !== o.speed) return 'Hız değişti';
      if (c.keys !== o.keys) return 'Anahtar kare';
      if (c.grade !== o.grade || c.color !== o.color) return 'Renk düzeltme';
      if (c.vfx !== o.vfx) return 'Efekt';
      if (c.text !== o.text) return 'Metin düzenlendi';
      if (c.volume !== o.volume || c.vkeys !== o.vkeys || c.afx !== o.afx || c.eq !== o.eq) return 'Ses ayarı';
      if (c.x !== o.x || c.y !== o.y || c.scale !== o.scale || c.rotation !== o.rotation || c.opacity !== o.opacity) return 'Dönüşüm';
    }
    return 'Klip ayarı';
  }
  return 'Değişiklik';
}

const clock = (t?: number) => (t ? new Date(t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

export function HistoryPanel() {
  const past = useStore((s) => s.past);
  const future = useStore((s) => s.future);
  const project = useStore((s) => s.project)!;
  const ref = useRef<HTMLDivElement>(null);
  // timeline of states: past[0] … past[n-1], current, future[last] … future[0]
  const cur: Snap = { ...project };
  const states: Snap[] = [...past, cur, ...[...future].reverse()];
  const curIdx = past.length;
  const go = (i: number) => {
    const n = i - get().past.length;
    for (let k = 0; k < -n; k++) undo();
    for (let k = 0; k < n; k++) redo();
  };
  useEffect(() => {
    ref.current?.querySelector('.hist-row.now')?.scrollIntoView({ block: 'nearest' });
  }, [past.length]);
  return (
    <div className="history" ref={ref}>
      <p className="hint">Bir adıma tıklayarak projeyi o ana döndür. Sonraki adımlar kaybolmaz; yeni bir değişiklik yapana kadar ileri gidebilirsin.</p>
      <button className={'hist-row' + (curIdx === 0 ? ' now' : '')} onClick={() => go(0)}>
        <Undo2 size={12} />
        <span className="grow">Başlangıç</span>
      </button>
      {states.slice(1).map((s, j) => {
        const i = j + 1;
        return (
          <button key={i} className={'hist-row' + (i === curIdx ? ' now' : '') + (i > curIdx ? ' future' : '')} onClick={() => go(i)}>
            <span className="hist-dot" />
            <span className="grow">{describe(states[i - 1], s)}</span>
            <span className="muted">{i === curIdx ? 'şimdi' : i < curIdx ? clock(states[i - 1]?.at) : ''}</span>
          </button>
        );
      })}
      {!past.length && !future.length && <p className="hint">Henüz değişiklik yok.</p>}
    </div>
  );
}

