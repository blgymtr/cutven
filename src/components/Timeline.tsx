import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  MousePointer2, ArrowLeftRight, MoveHorizontal, Keyboard,
  Scissors, Trash2, Copy, Magnet, ZoomIn, ZoomOut, Maximize2, Bookmark, Eye, EyeOff, Volume2, VolumeX, Lock, Unlock,
  Film, Music, Type, Image as ImageIcon, X, AudioLines, ClipboardPaste, CopyPlus, Gauge, Square, Diamond,
} from 'lucide-react';
import { useStore, get, set, select, beginGesture, edit, toast } from '../store';
import type { Clip, Track } from '../types';
import { clamp, clipDur, clipEnd, projectDuration, formatChapter } from '../lib/util';
import { engine } from '../lib/engine';
import {
  splitAt, deleteSelected, duplicateSelected, detachAudio, addMarker, addMediaToTimeline, addText, insertTrack,
  hasRoom, trackTypeFor, copySelected, paste, deleteTrack, updateClips, applyTransition,
} from '../lib/actions';
import { addSfx } from '../lib/sfx';
import { toggleVfx } from './VfxPanel';
import { volAt, localAt, moveKey, deleteKey, toggleKeyAtPlayhead } from '../lib/keyframes';
import { waveforms, stripImage, importPaths } from '../lib/media';
import { showMenu } from './ui';
import { DND_TYPE } from './MediaPanel';

const HEAD_W = 184;
const RULER_H = 28;
const laneHeight = (t: Track) => (t.type === 'audio' ? 52 : 64);
const MIN_PPS = 0.5;
const MAX_PPS = 600;

const EMPTY: string[] = [];

/* ------------------------------------------------------------------ ruler */

function pickStep(pps: number, fps: number) {
  const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const s of steps) if (s * pps >= 90) return s;
  return 3600;
}

function labelFor(t: number, step: number, fps: number) {
  if (step < 1) {
    const f = Math.round((t % 1) * fps);
    return `${formatChapter(t)}${f ? `:${String(f).padStart(2, '0')}f` : ''}`;
  }
  return formatChapter(t);
}

function Ruler({ width, onScrub }: { width: number; onScrub: (e: React.PointerEvent) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const pps = useStore((s) => s.pps);
  const scrollLeft = useStore((s) => s.scrollLeft);
  const viewW = useStore((s) => s.viewW);
  const fps = useStore((s) => s.project?.fps || 30);
  const markers = useStore((s) => s.project?.markers);
  const inPt = useStore((s) => s.project?.inPoint);
  const outPt = useStore((s) => s.project?.outPoint);
  const total = useStore((s) => (s.project ? projectDuration(s.project) : 0));
  const [editing, setEditing] = useState<string | null>(null);
  const w = Math.max(0, viewW - HEAD_W);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, w * dpr);
    cv.height = RULER_H * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, RULER_H);
    const step = pickStep(pps, fps);
    const minor = step / (step >= 1 ? 5 : 2);
    const t0 = Math.floor(scrollLeft / pps / minor) * minor;
    const t1 = (scrollLeft + w) / pps;
    ctx.font = '500 10px Inter, sans-serif';
    ctx.textBaseline = 'top';
    for (let i = 0; ; i++) {
      const t = t0 + i * minor;
      if (t > t1) break;
      const x = Math.round(t * pps - scrollLeft) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.fillStyle = major ? '#4a4a54' : '#2e2e35';
      ctx.fillRect(x, major ? 14 : 20, 1, major ? 14 : 8);
      if (major) {
        ctx.fillStyle = '#7d7d88';
        ctx.fillText(labelFor(Math.max(0, t), step, fps), x + 4, 5);
      }
    }
  }, [pps, scrollLeft, w, fps]);

  return (
    <div className="tl-ruler" style={{ width }} onPointerDown={onScrub}>
      <canvas ref={ref} style={{ left: scrollLeft, width: w }} />
      {(inPt != null || outPt != null) && (
        <div className="io-range" style={{ left: (inPt ?? 0) * pps, width: Math.max(1, ((outPt ?? total) - (inPt ?? 0)) * pps) }} title="Giriş → çıkış (I / O). Ctrl+Shift+X ile temizle">
          {inPt != null && <b className="io-in" />}
          {outPt != null && <b className="io-out" />}
        </div>
      )}
      {editing && markers?.some((m) => m.id === editing) && <MarkerEditor id={editing} onClose={() => setEditing(null)} />}
      {markers?.map((m) => (
        <div
          key={m.id}
          className="marker"
          style={{ left: m.time * pps, ['--mk' as any]: m.color || '#ffcf4a' }}
          title={`${formatChapter(m.time)} ${m.label}${m.note ? ' — ' + m.note : ''}`}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(m.id);
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
            engine.seek(m.time);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            showMenu(e.clientX, e.clientY, [
              { label: 'Düzenle (renk, not)', icon: <Bookmark size={14} />, onClick: () => setEditing(m.id) },
              { label: 'Bölümlerde düzenle', icon: <Bookmark size={14} />, onClick: () => set({ leftTab: 'chapters' }) },
              { label: 'İşaretçiyi sil', icon: <Trash2 size={14} />, danger: true, onClick: () => edit((d) => void (d.markers = d.markers.filter((x) => x.id !== m.id))) },
            ]);
          }}
        >
          <i />
          {pps * 10 > 60 && <span>{m.label}</span>}
        </div>
      ))}
    </div>
  );
}

const MARKER_COLORS = ['#ffcf4a', '#ff6a3d', '#ff4d5e', '#c56cf0', '#5a8cff', '#3ddc97', '#ececf0'];

function MarkerEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const m = useStore((s) => s.project?.markers.find((x) => x.id === id))!;
  const pps = useStore((s) => s.pps);
  const set1 = (patch: Partial<typeof m>, key: string) =>
    edit((d) => {
      const x = d.markers.find((q) => q.id === id);
      if (x) Object.assign(x, patch);
    }, { key: 'mk-' + key + id });
  useEffect(() => {
    const close = (e: PointerEvent) => !(e.target as HTMLElement).closest('.marker-editor') && onClose();
    const t = setTimeout(() => window.addEventListener('pointerdown', close));
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', close);
    };
  }, [onClose]);
  return (
    <div className="marker-editor" style={{ left: m.time * pps }} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <input className="field" autoFocus value={m.label} onChange={(e) => set1({ label: e.target.value }, 'l')} onKeyDown={(e) => e.key === 'Enter' && onClose()} />
      <textarea className="field" rows={2} placeholder="Not (ör. buraya B-roll koy)" value={m.note || ''} onChange={(e) => set1({ note: e.target.value || undefined }, 'n')} />
      <div className="chips">
        {MARKER_COLORS.map((c) => (
          <button key={c} className={'chip swatch-chip' + ((m.color || '#ffcf4a') === c ? ' on' : '')} style={{ background: c }} onClick={() => set1({ color: c }, 'c')} />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ volume keyframes */

function VolKeys({ c, width, h, pps }: { c: Clip; width: number; h: number; pps: number }) {
  const keys = c.vkeys || [];
  const dur = clipDur(c);
  const y = (v: number) => 3 + (1 - Math.min(2, v) / 2) * (h - 6);
  const xs = (s: number) => localAt(c, s) * pps;
  const pts = [`0,${y(volAt(c, 0))}`, ...keys.map((k) => `${xs(k.s)},${y(k.v)}`), `${width},${y(volAt(c, dur))}`].join(' ');
  const drag = (e: React.PointerEvent, i: number) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;
    const k0 = keys[i];
    const x0 = e.clientX;
    const y0 = e.clientY;
    let started = false;
    const mv = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 3) return;
        started = true;
        beginGesture();
      }
      const ds = ((ev.clientX - x0) / get().pps) * c.speed;
      const dv = (-(ev.clientY - y0) / (h - 6)) * 2;
      moveKey(c.id, i, k0.s + (ev.shiftKey ? 0 : ds), Math.round((k0.v + dv) * 100) / 100, false);
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      if (!started) engine.seek(c.start + localAt(c, k0.s));
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  return (
    <>
      <svg className="vol-line" width={width} height={h} style={{ width }}>
        <polyline points={pts} />
      </svg>
      {keys.map((k, i) => {
        const x = xs(k.s);
        if (x < -6 || x > width + 6) return null;
        return (
          <div
            key={i}
            className="kf"
            style={{ left: x, top: y(k.v) }}
            title={`Ses %${Math.round(k.v * 100)} — sürükle: konum/seviye, çift tık: sil`}
            onPointerDown={(e) => drag(e, i)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              deleteKey(c.id, i);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              deleteKey(c.id, i);
            }}
          />
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------ clip */

interface DragApi {
  start: (e: React.PointerEvent, c: Clip, mode: 'move' | 'l' | 'r') => void;
}

const ClipView = memo(function ClipView({ c, laneH, drag, dragging }: { c: Clip; laneH: number; drag: DragApi; dragging: boolean }) {
  const pps = useStore((s) => s.pps);
  const sel = useStore((s) => s.selection.includes(c.id));
  const scrollLeft = useStore((s) => s.scrollLeft);
  const viewW = useStore((s) => s.viewW);
  const media = useStore((s) => (c.mediaId ? s.project!.media.find((m) => m.id === c.mediaId) : undefined));
  const rt = useStore((s) => (c.mediaId ? s.runtime[c.mediaId] : undefined));
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [imgTick, setImgTick] = useState(0);

  const left = c.start * pps;
  const width = Math.max(3, clipDur(c) * pps);
  const visL = clamp(scrollLeft - left - 50, 0, width);
  const visR = clamp(scrollLeft + viewW - HEAD_W - left + 50, 0, width);
  const visW = Math.max(0, Math.floor(visR - visL));
  const h = laneH - 8;

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || visW <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, visW * dpr);
    cv.height = h * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, visW, h);
    const srcAt = (x: number) => c.in + (x / pps) * c.speed;

    if ((c.kind === 'video' || c.kind === 'image') && rt?.strip && media) {
      const img = stripImage(rt.strip.url);
      if (!img.complete) {
        img.addEventListener('load', () => setImgTick((t) => t + 1), { once: true });
      } else if (img.naturalWidth) {
        const count = rt.strip.count;
        const fw = img.naturalWidth / count;
        const fh = img.naturalHeight;
        const th = c.kind === 'video' && media.hasAudio && !c.muted ? h - 16 : h;
        const tw = th * (fw / fh);
        const startX = Math.floor(visL / tw) * tw;
        for (let x = startX; x < visR; x += tw) {
          const idx = clamp(Math.floor((srcAt(x + tw / 2) / media.duration) * count), 0, count - 1);
          ctx.drawImage(img, idx * fw, 0, fw, fh, x - visL, 0, tw, th);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(0, 0, visW, th);
      }
    } else if (c.kind === 'image' && rt?.thumb) {
      const img = stripImage(rt.thumb);
      if (!img.complete) img.addEventListener('load', () => setImgTick((t) => t + 1), { once: true });
      else if (img.naturalWidth) {
        const tw = h * (img.naturalWidth / img.naturalHeight);
        for (let x = Math.floor(visL / tw) * tw; x < visR; x += tw) ctx.drawImage(img, x - visL, 0, tw, h);
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(0, 0, visW, h);
      }
    }

    const peaks = c.mediaId ? waveforms.get(c.mediaId) : undefined;
    if (peaks && (c.kind === 'audio' || (c.kind === 'video' && !c.muted))) {
      const isAudio = c.kind === 'audio';
      const wh = isAudio ? h - 18 : 14;
      const base = isAudio ? 16 + wh / 2 : h - 1;
      ctx.fillStyle = isAudio ? (c.muted ? 'rgba(73,201,143,0.35)' : 'rgba(73,201,143,0.9)') : 'rgba(150,220,190,0.75)';
      const vol = Math.min(1.4, c.volume);
      for (let x = 0; x < visW; x++) {
        const px = x + visL;
        const i0 = Math.floor(srcAt(px) * 100);
        const i1 = Math.max(i0 + 1, Math.floor(srcAt(px + 1) * 100));
        let v = 0;
        for (let i = i0; i < i1 && i < peaks.length; i++) if (peaks[i] > v) v = peaks[i];
        const amp = Math.min(1, (v / 255) * vol);
        if (isAudio) {
          const bh = Math.max(1, amp * wh);
          ctx.fillRect(x, base - bh / 2, 1, bh);
        } else {
          const bh = Math.max(0.5, amp * wh);
          ctx.fillRect(x, base - bh, 1, bh);
        }
      }
    }
  }, [c, pps, visL, visR, visW, h, rt?.strip, rt?.thumb, rt?.wave, media, imgTick]);

  const name =
    c.kind === 'text' ? (c.text?.content || 'Metin').replace(/\n/g, ' ') : c.kind === 'color' ? 'Renk' : media?.name || (c.kind === 'audio' ? 'Ses' : 'Klip');
  const Icon = c.kind === 'text' ? Type : c.kind === 'audio' ? Music : c.kind === 'image' ? ImageIcon : c.kind === 'color' ? Square : Film;
  const fi = Math.min(c.kind === 'audio' ? c.audioFadeIn : c.fadeIn, clipDur(c) / 2) * pps;
  const fo = Math.min(c.kind === 'audio' ? c.audioFadeOut : c.fadeOut, clipDur(c) / 2) * pps;
  const missing = rt?.status === 'missing';

  return (
    <div
      className={
        'clip ' + c.kind + (sel ? ' sel' : '') + (dragging ? ' dragging' : '') + (c.kind === 'audio' && c.muted ? ' muted-clip' : '')
      }
      data-id={c.id}
      style={{ left, width, ...(missing ? { background: '#4a1f25' } : c.kind === 'color' ? { background: c.fill } : null) }}
      onPointerDown={(e) => drag.start(e, c, 'move')}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!get().selection.includes(c.id)) select([c.id]);
        const m = media;
        showMenu(e.clientX, e.clientY, [
          { label: 'Böl', icon: <Scissors size={14} />, k: 'S', onClick: () => splitAt() },
          { label: 'Kopyala', icon: <Copy size={14} />, k: 'Ctrl+C', onClick: copySelected },
          { label: 'Yapıştır', icon: <ClipboardPaste size={14} />, k: 'Ctrl+V', onClick: paste, disabled: !get().clipboard.length },
          { label: 'Çoğalt', icon: <CopyPlus size={14} />, k: 'Ctrl+D', onClick: duplicateSelected },
          ...(c.kind === 'video' && m?.hasAudio && !c.muted
            ? [{ label: 'Sesi ayır', icon: <AudioLines size={14} />, onClick: () => detachAudio(c.id) }]
            : []),
          ...(c.kind === 'video' || c.kind === 'audio'
            ? [{
                label: c.muted ? 'Sesi aç' : 'Sessize al',
                icon: c.muted ? <Volume2 size={14} /> : <VolumeX size={14} />,
                onClick: () => updateClips(get().selection, (x) => void (x.muted = !c.muted)),
              }]
            : []),
          { sep: true },
          { label: 'Sil', icon: <Trash2 size={14} />, k: 'Del', danger: true, onClick: () => deleteSelected() },
          { label: 'Sil ve boşluğu kapat', icon: <Trash2 size={14} />, k: 'Shift+Del', danger: true, onClick: () => deleteSelected(true) },
        ]);
      }}
    >
      {visW > 0 && <canvas ref={cvRef} style={{ left: visL, width: visW }} />}
      {fi > 1 && <div className="fade in" style={{ width: fi }} />}
      {fo > 1 && <div className="fade out" style={{ width: fo }} />}
      {width > 28 && (
        <div className="label" style={{ paddingLeft: Math.max(0, Math.min(visL, width - 120)) }}>
          <Icon size={11} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{missing ? 'Dosya bulunamadı' : name}</span>
          {c.speed !== 1 && (
            <span className="badge">
              <Gauge size={9} style={{ marginRight: 2, verticalAlign: -1 }} />
              {c.speed}×
            </span>
          )}
          {c.muted && c.kind === 'video' && <VolumeX size={11} />}
          {c.afx && <span className="badge">FX</span>}
          {!!c.vfx?.length && <span className="badge">✦{c.vfx.length}</span>}
          {c.chan && <span className="badge">{c.chan === 'L' ? 'Sol' : c.chan === 'R' ? 'Sağ' : c.chan === 'mid' ? 'Vokal' : 'Müzik'}</span>}
        </div>
      )}
      {(c.kind === 'audio' || c.kind === 'video') && !!c.vkeys?.length && <VolKeys c={c} width={width} h={h} pps={pps} />}
      <div className="trim l" onPointerDown={(e) => drag.start(e, c, 'l')} />
      <div className="trim r" onPointerDown={(e) => drag.start(e, c, 'r')} />
    </div>
  );
});

/* ------------------------------------------------------------------ track header */

function TrackHead({ t, isMain, h }: { t: Track; isMain: boolean; h: number }) {
  const toggle = (k: 'muted' | 'hidden' | 'locked') =>
    edit((d) => {
      const x = d.tracks.find((q) => q.id === t.id);
      if (x) x[k] = !x[k];
    });
  return (
    <div className="tl-head" style={{ height: h }}>
      <div className="nm">
        {t.type === 'audio' ? <Music size={12} /> : <Film size={12} />}
        <span>{t.name}</span>
        {isMain && <span className="main-tag">Ana</span>}
      </div>
      {t.type === 'visual' && (
        <button className={'icon-btn sm' + (t.hidden ? ' on' : '')} title={t.hidden ? 'Göster' : 'Gizle'} onClick={() => toggle('hidden')}>
          {t.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      )}
      <button className={'icon-btn sm' + (t.muted ? ' on' : '')} title={t.muted ? 'Sesi aç' : 'Sessize al'} onClick={() => toggle('muted')}>
        {t.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
      </button>
      <button className={'icon-btn sm' + (t.locked ? ' on' : '')} title={t.locked ? 'Kilidi aç' : 'Kilitle'} onClick={() => toggle('locked')}>
        {t.locked ? <Lock size={13} /> : <Unlock size={13} />}
      </button>
      <button className="icon-btn sm x" title="İzi sil" onClick={() => deleteTrack(t.id)}>
        <X size={13} />
      </button>
    </div>
  );
}

function RecGhost() {
  const rec = useStore((s) => s.rec);
  const pps = useStore((s) => s.pps);
  if (rec.status !== 'recording' && rec.status !== 'paused' && rec.status !== 'saving') return null;
  return (
    <div className={'rec-ghost ' + rec.status} style={{ left: rec.start * pps, width: Math.max(2, rec.elapsed * pps) }}>
      <span>● Seslendirme</span>
    </div>
  );
}

function Playhead() {
  const time = useStore((s) => s.time);
  const pps = useStore((s) => s.pps);
  const scrollLeft = useStore((s) => s.scrollLeft);
  const x = time * pps;
  if (x < scrollLeft - 1) return null;
  return <div className="playhead" style={{ left: HEAD_W + x }} />;
}

/* ------------------------------------------------------------------ timeline */

interface DragState {
  ids: string[];
  snapX: number | null;
  newZone: boolean;
}

interface Ghost {
  trackId: string | null;
  start: number;
  dur: number;
  kind: Clip['kind'];
}

export default function Timeline() {
  const project = useStore((s) => s.project)!;
  const pps = useStore((s) => s.pps);
  const snapping = useStore((s) => s.snapping);
  const viewW = useStore((s) => s.viewW);
  const scrollLeft = useStore((s) => s.scrollLeft);
  const selection = useStore((s) => s.selection) || EMPTY;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);

  const dur = projectDuration(project);
  const laneW = Math.max(viewW - HEAD_W, (dur + 60) * pps);
  const visualTracks = project.tracks.filter((t) => t.type === 'visual');
  const mainId = visualTracks[visualTracks.length - 1]?.id;

  /* --- scroll / size bookkeeping */
  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const ro = new ResizeObserver(() => set({ viewW: el.clientWidth }));
    ro.observe(el);
    set({ viewW: el.clientWidth });
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = scrollRef.current!;
    if (Math.abs(el.scrollLeft - scrollLeft) > 1) el.scrollLeft = scrollLeft;
  }, [scrollLeft]);

  /* --- follow playhead while playing */
  useEffect(
    () =>
      useStore.subscribe((s) => {
        if (!s.playing) return;
        const el = scrollRef.current;
        if (!el) return;
        const x = s.time * s.pps;
        const w = el.clientWidth - HEAD_W;
        if (x > el.scrollLeft + w - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80);
      }),
    [],
  );

  const timeAtClientX = useCallback((clientX: number) => {
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - HEAD_W + el.scrollLeft) / get().pps);
  }, []);

  /* --- zoom */
  const zoomTo = useCallback((next: number, anchorClientX?: number) => {
    const el = scrollRef.current!;
    const cur = get().pps;
    next = clamp(next, MIN_PPS, MAX_PPS);
    const r = el.getBoundingClientRect();
    const ax = anchorClientX != null ? anchorClientX - r.left - HEAD_W : get().time * cur - el.scrollLeft;
    const t = (el.scrollLeft + ax) / cur;
    set({ pps: next });
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, t * next - ax);
      set({ scrollLeft: el.scrollLeft });
    });
  }, []);
  const fit = () => {
    const d = Math.max(5, projectDuration(get().project!));
    zoomTo((viewW - HEAD_W - 60) / d);
    requestAnimationFrame(() => {
      scrollRef.current!.scrollLeft = 0;
    });
  };

  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomTo(get().pps * Math.exp(-e.deltaY * 0.0022), e.clientX);
      } else if (e.shiftKey) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    const onZoom = (e: Event) => zoomTo(get().pps * (e as CustomEvent).detail);
    window.addEventListener('cutven:zoom', onZoom);
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('cutven:zoom', onZoom);
    };
  }, [zoomTo]);

  /* --- scrubbing */
  const onScrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const wasPlaying = engine.playing;
    if (wasPlaying) engine.pause();
    const fps = get().project!.fps;
    const go = (x: number) => engine.seek(Math.round(timeAtClientX(x) * fps) / fps);
    go(e.clientX);
    const move = (ev: PointerEvent) => go(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /* --- rows under pointer */
  const rowAt = (clientY: number): { trackId: string | null; newZone: boolean } => {
    const rows = scrollRef.current!.querySelectorAll<HTMLElement>('[data-track]');
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      if (clientY >= b.top && clientY < b.bottom) return { trackId: r.dataset.track!, newZone: false };
    }
    const nz = scrollRef.current!.querySelector<HTMLElement>('[data-newzone]');
    if (nz && clientY >= nz.getBoundingClientRect().top) return { trackId: null, newZone: true };
    return { trackId: null, newZone: false };
  };

  const snapPoints = (exclude: string[]) => {
    const p = get().project!;
    const pts = [0, get().time];
    for (const c of p.clips) {
      if (exclude.includes(c.id)) continue;
      pts.push(c.start, clipEnd(c));
    }
    for (const m of p.markers) pts.push(m.time);
    return pts;
  };
  const snapTo = (t: number, pts: number[], disabled: boolean) => {
    if (disabled || !get().snapping) return { t, hit: null as number | null };
    const th = 8 / get().pps;
    let best: number | null = null;
    for (const p of pts) if (Math.abs(p - t) < th && (best == null || Math.abs(p - t) < Math.abs(best - t))) best = p;
    return best != null ? { t: best, hit: best } : { t, hit: null };
  };

  /* --- clip dragging */
  const dragImpl = useRef<DragApi>(null!);
  const dragApi = useMemo<DragApi>(() => ({ start: (e, c, mode) => dragImpl.current.start(e, c, mode) }), []);
  dragImpl.current = {
    start: (e, c, mode) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const p0 = get().project!;
      const track = p0.tracks.find((t) => t.id === c.trackId);
      const sel0 = get().selection;
      if (e.shiftKey || e.ctrlKey) {
        select(sel0.includes(c.id) ? sel0.filter((x) => x !== c.id) : [...sel0, c.id]);
        return;
      }
      if (!sel0.includes(c.id)) select([c.id]);
      if (track?.locked) return;
      const ids = mode === 'move' && sel0.includes(c.id) ? get().selection : [c.id];
      const movable = ids.filter((id) => {
        const cl = p0.clips.find((x) => x.id === id);
        return cl && !p0.tracks.find((t) => t.id === cl.trackId)?.locked;
      });
      const orig = new Map(p0.clips.filter((x) => movable.includes(x.id)).map((x) => [x.id, { ...x }]));
      const o = orig.get(c.id)!;
      const pts = snapPoints(movable);
      const x0 = e.clientX;
      const media = c.mediaId ? p0.media.find((m) => m.id === c.mediaId) : undefined;
      const fr = 1 / p0.fps;
      const minStartOffset = Math.min(...[...orig.values()].map((x) => x.start));
      let started = false;
      let newZone = false;
      let targetTrack = c.trackId;
      const tool = get().tool;
      const sourced = c.kind === 'video' || c.kind === 'audio';
      // clips after this one on the same track (for ripple trims)
      const after = p0.clips.filter((x) => x.trackId === o.trackId && x.id !== o.id && x.start >= clipEnd(o) - 1e-4).map((x) => ({ id: x.id, start: x.start }));

      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - x0;
        if (!started) {
          if (Math.abs(dx) < 3 && Math.abs(ev.clientY - e.clientY) < 3) return;
          started = true;
          if (engine.playing) engine.pause();
          beginGesture();
        }
        const pps = get().pps;
        const dt = dx / pps;
        let snapHit: number | null = null;
        if (tool === 'slip' && mode === 'move' && sourced && media) {
          // slip: same place and length on the timeline, different part of the source
          const span = o.out - o.in;
          const ni = clamp(o.in - dt * o.speed, 0, Math.max(0, media.duration - span));
          edit((d) => {
            const cl = d.clips.find((x) => x.id === c.id)!;
            cl.in = ni;
            cl.out = ni + span;
          }, { record: false });
          engine.seek(o.start + 0.0001);
        } else if (tool === 'rate' && mode !== 'move' && sourced) {
          // rate stretch: keep the source range, change speed so the clip fits the new length
          const span = o.out - o.in;
          const end0 = clipEnd(o);
          if (mode === 'r') {
            const s = snapTo(end0 + dt, pts, ev.altKey);
            snapHit = s.hit;
            let lim = Infinity;
            for (const x of get().project!.clips) if (x.trackId === o.trackId && x.id !== o.id && x.start >= end0 - 1e-4) lim = Math.min(lim, x.start);
            const len = clamp(Math.min(s.t, lim) - o.start, span / 16, span / 0.1);
            edit((d) => void (d.clips.find((x) => x.id === c.id)!.speed = Math.round((span / len) * 1000) / 1000), { record: false });
          } else {
            const s = snapTo(o.start + dt, pts, ev.altKey);
            snapHit = s.hit;
            let lim = 0;
            for (const x of get().project!.clips) if (x.trackId === o.trackId && x.id !== o.id && clipEnd(x) <= o.start + 1e-4) lim = Math.max(lim, clipEnd(x));
            const len = clamp(end0 - Math.max(s.t, lim), span / 16, span / 0.1);
            const sp = Math.round((span / len) * 1000) / 1000;
            edit((d) => {
              const cl = d.clips.find((x) => x.id === c.id)!;
              cl.speed = sp;
              cl.start = Math.max(0, end0 - span / sp);
            }, { record: false });
          }
        } else if (tool === 'ripple' && mode !== 'move') {
          // ripple trim: the clip keeps its start, everything after it on the track follows
          const end0 = clipEnd(o);
          let newDur: number;
          let ni = o.in;
          let no = o.out;
          if (mode === 'r') {
            const s = snapTo(end0 + dt, pts, ev.altKey);
            snapHit = s.hit;
            let ne = Math.max(o.start + fr, s.t);
            if (sourced && media) ne = Math.min(ne, o.start + (media.duration - o.in) / o.speed);
            newDur = ne - o.start;
            no = sourced ? o.in + newDur * o.speed : newDur;
          } else {
            const maxCut = clipDur(o) - fr;
            let cut = clamp(dt, sourced ? -o.in / o.speed : -Infinity, maxCut);
            if (!sourced) cut = Math.min(cut, maxCut);
            newDur = clipDur(o) - cut;
            if (sourced) ni = o.in + cut * o.speed;
            else no = o.out - cut;
          }
          const delta = o.start + newDur - end0;
          edit((d) => {
            const cl = d.clips.find((x) => x.id === c.id)!;
            cl.in = ni;
            cl.out = no;
            for (const a of after) {
              const x = d.clips.find((q) => q.id === a.id);
              if (x) x.start = Math.max(0, a.start + delta);
            }
          }, { record: false });
        } else if (mode === 'move') {
          let ns = Math.max(0, o.start + dt);
          const len = clipDur(o);
          const a = snapTo(ns, pts, ev.altKey);
          const b = snapTo(ns + len, pts, ev.altKey);
          if (a.hit != null && (b.hit == null || Math.abs(a.t - ns) <= Math.abs(b.t - (ns + len)))) {
            ns = a.t;
            snapHit = a.hit;
          } else if (b.hit != null) {
            ns = b.t - len;
            snapHit = b.hit;
          }
          let delta = ns - o.start;
          if (minStartOffset + delta < 0) delta = -minStartOffset;
          if (movable.length === 1) {
            const r = rowAt(ev.clientY);
            newZone = r.newZone;
            const tr = r.trackId ? get().project!.tracks.find((t) => t.id === r.trackId) : null;
            if (tr && tr.type === trackTypeFor(c.kind) && !tr.locked) targetTrack = tr.id;
          }
          edit((d) => {
            for (const cl of d.clips) {
              const oc = orig.get(cl.id);
              if (!oc) continue;
              cl.start = Math.max(0, oc.start + delta);
              if (movable.length === 1 && !newZone) cl.trackId = targetTrack;
            }
          }, { record: false });
        } else if (mode === 'l') {
          let ns = o.start + dt;
          const s = snapTo(ns, pts, ev.altKey);
          ns = s.t;
          snapHit = s.hit;
          // limits: source start, min length, previous clip on the track
          const maxStart = clipEnd(o) - fr;
          let minStart = 0;
          if (c.kind === 'video' || c.kind === 'audio') minStart = Math.max(minStart, o.start - o.in / o.speed);
          for (const x of get().project!.clips) if (x.trackId === o.trackId && x.id !== o.id && clipEnd(x) <= o.start + 1e-4) minStart = Math.max(minStart, clipEnd(x));
          ns = clamp(ns, minStart, maxStart);
          const dd = ns - o.start;
          edit((d) => {
            const cl = d.clips.find((x) => x.id === c.id)!;
            cl.start = ns;
            if (c.kind === 'video' || c.kind === 'audio') cl.in = Math.max(0, o.in + dd * o.speed);
            else cl.out = Math.max(fr, o.out - dd);
          }, { record: false });
        } else {
          let ne = clipEnd(o) + dt;
          const s = snapTo(ne, pts, ev.altKey);
          ne = s.t;
          snapHit = s.hit;
          let maxEnd = Infinity;
          if ((c.kind === 'video' || c.kind === 'audio') && media) maxEnd = o.start + (media.duration - o.in) / o.speed;
          for (const x of get().project!.clips) if (x.trackId === o.trackId && x.id !== o.id && x.start >= clipEnd(o) - 1e-4) maxEnd = Math.min(maxEnd, x.start);
          ne = clamp(ne, o.start + fr, maxEnd);
          edit((d) => {
            const cl = d.clips.find((x) => x.id === c.id)!;
            cl.out = o.in + (ne - o.start) * o.speed;
          }, { record: false });
        }
        setDrag({ ids: movable, snapX: snapHit, newZone });
      };

      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setDrag(null);
        if (!started || mode !== 'move') return;
        // resolve: new-track drop zone or overlaps → move to a fresh/adjacent track
        edit((d) => {
          for (const id of movable) {
            const cl = d.clips.find((x) => x.id === id);
            if (!cl) continue;
            const type = trackTypeFor(cl.kind);
            const end = cl.start + (cl.out - cl.in) / cl.speed;
            if (newZone && movable.length === 1) {
              cl.trackId = insertTrack(d, type, type === 'audio' ? d.tracks[d.tracks.length - 1].id : undefined).id;
            } else if (!hasRoom(d, cl.trackId, cl.start, end, movable)) {
              cl.trackId = insertTrack(d, type, cl.trackId).id;
            }
          }
        }, { record: false });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
  };

  /* --- drop from media panel / explorer */
  const dropInfo = (e: React.DragEvent) => {
    const t = timeAtClientX(e.clientX);
    const r = rowAt(e.clientY);
    return { t, ...r };
  };
  const onDragOver = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (!types.includes(DND_TYPE) && !types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    const { t, trackId, newZone } = dropInfo(e);
    setGhost({ trackId: newZone ? null : trackId, start: t, dur: 3, kind: 'video' });
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setGhost(null);
    const { t, trackId, newZone } = dropInfo(e);
    const raw = e.dataTransfer.getData(DND_TYPE);
    let st = snapTo(t, snapPoints([]), false).t;
    // first clip on an empty track lands at 0 when dropped near the start
    const p = get().project!;
    const emptyTarget = newZone || !trackId || !p.clips.some((c) => c.trackId === trackId);
    if (emptyTarget && st * get().pps < 60) st = 0;
    if (raw) {
      const data = JSON.parse(raw);
      if (data.type === 'media') {
        const m = get().project!.media.find((x) => x.id === data.id);
        if (m) addMediaToTimeline(m, newZone ? { start: st, newTrack: true } : { start: st, trackId: trackId || undefined });
      } else if (data.type === 'text') {
        addText(data.preset, { start: st, trackId: trackId || undefined });
      } else if (data.type === 'sfx') {
        addSfx(data.id, st);
      } else if (data.type === 'vfx') {
        const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('.clip') as HTMLElement | null;
        if (!el?.dataset.id) {
          toast('Efekti bir klibin üzerine bırak');
          return;
        }
        toggleVfx(el.dataset.id, data.id);
        select([el.dataset.id]);
      } else if (data.type === 'trans') {
        const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('.clip') as HTMLElement | null;
        const id = el?.dataset.id;
        if (!id) {
          toast('Geçişi bir klibin başına ya da sonuna bırak');
          return;
        }
        const r = el!.getBoundingClientRect();
        applyTransition(id, e.clientX < r.left + r.width / 2 ? 'in' : 'out', data.id);
        select([id]);
      }
      return;
    }
    const files = [...e.dataTransfer.files].map((f) => window.cv.pathForFile(f)).filter(Boolean);
    if (files.length) {
      const items = await importPaths(files);
      let at = st;
      for (const m of items) {
        addMediaToTimeline(m, newZone ? { start: at, newTrack: true } : { start: at, trackId: trackId || undefined });
        at += m.type === 'image' ? 5 : m.duration;
      }
    }
  };

  const hasClips = project.clips.length > 0;
  const selAudio = selection.length === 1 ? project.clips.find((c) => c.id === selection[0] && (c.kind === 'audio' || c.kind === 'video')) : undefined;
  const nowT = useStore((s) => s.time);
  const tool = useStore((s) => s.tool);
  const shuttle = useStore((s) => s.shuttle);
  const selKey = !!selAudio && !!selAudio.vkeys?.length && (selAudio.vkeys || []).some((k) => Math.abs(localAt(selAudio, k.s) + selAudio.start - nowT) < 1 / 30 + 1e-3);

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <div className="seg tools">
          {([
            ['select', MousePointer2, 'Seçim aracı (V)'],
            ['ripple', ArrowLeftRight, 'Dalgalı kırpma (B): kenarı çekince arkadaki klipler de kayar'],
            ['slip', MoveHorizontal, 'Kaydırma / slip (Y): klip yerinde kalır, içindeki görüntü kayar'],
            ['rate', Gauge, 'Hız esnetme (T): kenarı çekerek klibi hızlandır / yavaşlat'],
          ] as const).map(([id, Icon, title]) => (
            <button key={id} className={tool === id ? 'on' : ''} title={title} onClick={() => set({ tool: id })}>
              <Icon size={14} />
            </button>
          ))}
        </div>
        <div className="vsep" />
        <button className="icon-btn" title="Böl (S)" onClick={() => splitAt()}>
          <Scissors size={16} />
        </button>
        <button className="icon-btn" title="Sil (Del)" disabled={!selection.length} onClick={() => deleteSelected()}>
          <Trash2 size={16} />
        </button>
        <button className="icon-btn" title="Çoğalt (Ctrl+D)" disabled={!selection.length} onClick={duplicateSelected}>
          <CopyPlus size={16} />
        </button>
        <button
          className="icon-btn"
          title="Sesi ayır"
          disabled={selection.length !== 1}
          onClick={() => {
            const c = project.clips.find((x) => x.id === selection[0]);
            if (c?.kind === 'video') detachAudio(c.id);
            else toast('Bir video klip seç');
          }}
        >
          <AudioLines size={16} />
        </button>
        <button
          className={'icon-btn' + (selKey ? ' on' : '')}
          title="Ses anahtar karesi ekle/kaldır (K) — oynatma imlecinde"
          disabled={!selAudio}
          onClick={() => selAudio && toggleKeyAtPlayhead(selAudio.id)}
        >
          <Diamond size={16} />
        </button>
        <div className="vsep" />
        <button className="icon-btn" title="Bölüm işaretçisi ekle (M)" onClick={() => addMarker()}>
          <Bookmark size={16} />
        </button>
        <div className="spacer" />
        {shuttle !== 1 && <span className="shuttle-badge">{shuttle < 0 ? '◀◀' : '▶▶'} {Math.abs(shuttle)}×</span>}
        <button className="icon-btn" title="Klavye kısayolları (?)" onClick={() => set({ shortcutsOpen: true })}>
          <Keyboard size={16} />
        </button>
        <button className={'icon-btn' + (snapping ? ' on' : '')} title="Mıknatıs (N) — Alt ile geçici kapat" onClick={() => set({ snapping: !snapping })}>
          <Magnet size={16} />
        </button>
        <div className="vsep" />
        <div className="zoom">
          <button className="icon-btn sm" title="Uzaklaştır (-)" onClick={() => zoomTo(pps / 1.5)}>
            <ZoomOut size={15} />
          </button>
          <input
            type="range"
            min={Math.log(MIN_PPS)}
            max={Math.log(MAX_PPS)}
            step={0.01}
            value={Math.log(pps)}
            style={{ ['--p' as any]: `${((Math.log(pps) - Math.log(MIN_PPS)) / (Math.log(MAX_PPS) - Math.log(MIN_PPS))) * 100}%` }}
            onChange={(e) => zoomTo(Math.exp(parseFloat(e.target.value)))}
          />
          <button className="icon-btn sm" title="Yakınlaştır (+)" onClick={() => zoomTo(pps * 1.5)}>
            <ZoomIn size={15} />
          </button>
        </div>
        <button className="icon-btn" title="Tümünü sığdır (Shift+Z)" onClick={fit}>
          <Maximize2 size={15} />
        </button>
      </div>

      <div
        className="tl-scroll"
        ref={scrollRef}
        onScroll={(e) => set({ scrollLeft: (e.target as HTMLElement).scrollLeft })}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setGhost(null);
        }}
        onDrop={onDrop}
      >
        <div className="tl-inner" style={{ width: HEAD_W + laneW }}>
          <div className="tl-ruler-row">
            <div className="tl-corner" />
            <Ruler width={laneW} onScrub={onScrub} />
          </div>
          {project.tracks.map((t) => {
            const h = laneHeight(t);
            const clips = project.clips.filter((c) => c.trackId === t.id);
            return (
              <div className="tl-row" key={t.id} data-track={t.id}>
                <TrackHead t={t} isMain={t.id === mainId} h={h} />
                <div
                  className={'tl-lane tool-' + tool + (t.locked ? ' locked' : '') + (ghost && ghost.trackId === t.id ? ' drop' : '')}
                  style={{ width: laneW, height: h, ['--grid' as any]: `${pickStep(pps, project.fps) * pps}px` }}
                  onPointerDown={(e) => {
                    if (e.button === 0 && !e.shiftKey) select([]);
                  }}
                >
                  {clips.map((c) => (
                    <ClipView key={c.id} c={c} laneH={h} drag={dragApi} dragging={!!drag?.ids.includes(c.id)} />
                  ))}
                </div>
              </div>
            );
          })}
          <div className="tl-row tl-new" data-newzone>
            <div className="tl-head" style={{ height: 34, borderBottom: 0 }} />
            <div
              className={'tl-lane' + ((ghost && ghost.trackId == null) || drag?.newZone ? ' drop' : '')}
              style={{ width: laneW, height: 34 }}
              onPointerDown={() => select([])}
            >
              <RecGhost />
            </div>
          </div>
          {!hasClips && (
            <div className="tl-empty">Medyayı buraya sürükle — ya da medya kartındaki + ile ekle</div>
          )}
          <Playhead />
          {drag?.snapX != null && <div className="snap-line" style={{ left: HEAD_W + drag.snapX * pps }} />}
        </div>
      </div>
    </div>
  );
}
