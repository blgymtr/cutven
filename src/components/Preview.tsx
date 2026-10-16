import { useLayoutEffect, useRef, useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, Maximize2, RotateCw, Upload, Mic } from 'lucide-react';
import { useStore, get, set, select, beginGesture, edit } from '../store';
import { resolveKeys, setProp } from '../lib/vkeys';
import { engine } from '../lib/engine';
import { clipBox, hitTest } from '../lib/render';
import { clipDur, formatTC, projectDuration } from '../lib/util';
import { jumpEdge } from '../lib/actions';
import type { Clip } from '../types';

function Timecode() {
  const time = useStore((s) => s.time);
  const fps = useStore((s) => s.project?.fps || 30);
  const dur = useStore((s) => (s.project ? projectDuration(s.project) : 0));
  return (
    <div className="tc-big">
      <b>{formatTC(time, fps)}</b> <span>/ {formatTC(dur, fps)}</span>
    </div>
  );
}

function RecOverlay() {
  const status = useStore((s) => s.rec.status);
  const countdown = useStore((s) => s.rec.countdown);
  const elapsed = useStore((s) => s.rec.elapsed);
  if (status === 'countdown')
    return (
      <div className="rec-countdown">
        <span key={countdown}>{countdown}</span>
      </div>
    );
  if (status !== 'recording' && status !== 'paused') return null;
  const m = Math.floor(elapsed / 60);
  const sec = Math.floor(elapsed % 60);
  return (
    <div className={'rec-pill ' + status}>
      <i />
      {status === 'paused' ? 'DURAKLATILDI' : 'KAYIT'} {String(m).padStart(2, '0')}:{String(sec).padStart(2, '0')}
    </div>
  );
}

function SelectionOverlay({ k }: { k: number }) {
  const project = useStore((s) => s.project)!;
  const selection = useStore((s) => s.selection);
  const time = useStore((s) => s.time);
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const rootRef = useRef<HTMLDivElement>(null);

  const raw: Clip | undefined =
    selection.length === 1
      ? project.clips.find((c) => c.id === selection[0] && c.kind !== 'audio' && time >= c.start && time < c.start + clipDur(c))
      : undefined;
  // keyframed clips show (and edit) their value at the playhead
  const sel = raw && resolveKeys(raw, time - raw.start);
  const track = sel && project.tracks.find((t) => t.id === sel.trackId);
  const show = sel && !track?.hidden && !track?.locked;

  const toProject = (e: { clientX: number; clientY: number }) => {
    const r = rootRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };

  const startDrag = (e: React.PointerEvent, clip: Clip, mode: 'move' | 'scale' | 'rotate') => {
    e.stopPropagation();
    e.preventDefault();
    if (engine.playing) engine.pause();
    const p0 = toProject(e);
    const c0 = { ...clip };
    const box = clipBox(project, clip);
    const d0 = Math.hypot(p0.x - box.cx, p0.y - box.cy) || 1;
    let started = false;
    const move = (ev: PointerEvent) => {
      const pt = toProject(ev);
      if (!started) {
        if (Math.hypot(pt.x - p0.x, pt.y - p0.y) * k < 2) return;
        started = true;
        beginGesture();
      }
      const snapT = 8 / k;
      if (mode === 'move') {
        let x = c0.x + (pt.x - p0.x);
        let y = c0.y + (pt.y - p0.y);
        const sv = !ev.altKey && Math.abs(x) < snapT;
        const sh = !ev.altKey && Math.abs(y) < snapT;
        if (sv) x = 0;
        if (sh) y = 0;
        setGuides({ v: sv, h: sh });
        edit((d) => {
          const c = d.clips.find((q) => q.id === clip.id);
          if (c) {
            setProp(c, 'x', Math.round(x));
            setProp(c, 'y', Math.round(y));
          }
        }, { record: false });
      } else if (mode === 'scale') {
        const d = Math.hypot(pt.x - box.cx, pt.y - box.cy);
        // same range as the inspector's scale slider
        let s = Math.max(0.05, Math.min(5, (c0.scale * d) / d0));
        if (!ev.altKey && Math.abs(s - 1) < 0.03) s = 1;
        edit((dr) => {
          const c = dr.clips.find((q) => q.id === clip.id);
          if (c) setProp(c, 'scale', Math.round(s * 1000) / 1000);
        }, { record: false });
      } else {
        let a = (Math.atan2(pt.y - box.cy, pt.x - box.cx) * 180) / Math.PI + 90;
        if (a > 180) a -= 360;
        const step = ev.shiftKey ? 15 : 45;
        const near = Math.round(a / step) * step;
        if (ev.shiftKey || Math.abs(a - near) < 4) a = near;
        if (a <= -180) a += 360;
        edit((dr) => {
          const c = dr.clips.find((q) => q.id === clip.id);
          if (c) setProp(c, 'rotation', Math.round(a * 10) / 10);
        }, { record: false });
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGuides({ v: false, h: false });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onRootDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const pt = toProject(e);
    const hit = hitTest(project, get().time, pt.x, pt.y);
    if (hit) {
      select([hit.id]);
      startDrag(e, hit, 'move');
    } else select([]);
  };

  let boxEl = null;
  if (show && sel) {
    const b = clipBox(project, sel);
    const w = b.w * k;
    const h = b.h * k;
    const corners = [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ];
    boxEl = (
      <div
        className="sel-box"
        style={{ left: b.cx * k - w / 2, top: b.cy * k - h / 2, width: w, height: h, transform: `rotate(${b.rot}deg)` }}
        onPointerDown={(e) => e.button === 0 && startDrag(e, sel, 'move')}
        onDoubleClick={() => sel.kind === 'text' && window.dispatchEvent(new CustomEvent('cutven:focus-text'))}
      >
        {corners.map(([x, y], i) => (
          <span
            key={i}
            className="h"
            style={{ left: x, top: y, cursor: i === 0 || i === 3 ? 'nwse-resize' : 'nesw-resize' }}
            onPointerDown={(e) => startDrag(e, sel, 'scale')}
          />
        ))}
        <span className="rot" title="Döndür (Shift: 15°)" onPointerDown={(e) => startDrag(e, sel, 'rotate')}>
          <RotateCw size={11} />
        </span>
      </div>
    );
  }

  return (
    <div className="overlay" ref={rootRef} onPointerDown={onRootDown}>
      {guides.v && <div className="guide" style={{ left: (project.width / 2) * k - 0.5, top: 0, width: 1, height: '100%' }} />}
      {guides.h && <div className="guide" style={{ top: (project.height / 2) * k - 0.5, left: 0, height: 1, width: '100%' }} />}
      {boxEl}
    </div>
  );
}

export default function Preview() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pw = useStore((s) => s.project?.width || 1920);
  const ph = useStore((s) => s.project?.height || 1080);
  const playing = useStore((s) => s.playing);
  const empty = useStore((s) => !s.project?.clips.length);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = stageRef.current!;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const aw = r.width - 36;
      const ah = r.height - 36;
      const s = Math.min(aw / pw, ah / ph);
      setSize({ w: Math.max(10, Math.floor(pw * s)), h: Math.max(10, Math.floor(ph * s)) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pw, ph]);

  useLayoutEffect(() => {
    engine.attach(canvasRef.current);
    return () => engine.attach(null);
  }, []);
  // resize the bitmap in the same frame as the box (no stretched / blank frame in between)
  useLayoutEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    engine.resize(Math.round(size.w * dpr), Math.round(size.h * dpr));
  }, [size]);

  const k = size.w / pw;

  return (
    <div className="preview">
      <div className="stage" ref={stageRef}>
        <div className="canvas-wrap" style={{ width: size.w, height: size.h }}>
          <canvas ref={canvasRef} />
          {size.w > 0 && <SelectionOverlay k={k} />}
          <RecOverlay />
        </div>
        {empty && (
          <div className="empty-stage">
            <div>
              <Upload size={22} style={{ marginBottom: 8 }} />
              <div style={{ color: 'var(--text-2)', fontWeight: 500 }}>Dosyaları pencereye sürükle</div>
              <div style={{ marginTop: 4 }}>ya da soldan medya içe aktar</div>
            </div>
          </div>
        )}
      </div>
      <div className="transport">
        <Timecode />
        <div className="center">
          <button className="icon-btn" title="Önceki kesim (↑)" onClick={() => jumpEdge(-1)}>
            <SkipBack size={16} />
          </button>
          <button className="play-btn" title="Oynat / Duraklat (Boşluk)" onClick={() => engine.toggle()}>
            {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" style={{ marginLeft: 2 }} />}
          </button>
          <button className="icon-btn" title="Sonraki kesim (↓)" onClick={() => jumpEdge(1)}>
            <SkipForward size={16} />
          </button>
        </div>
        <button className="icon-btn rec-mini" title="Seslendirme kaydı (R)" onClick={() => set({ leftTab: 'record' })}>
          <Mic size={16} />
        </button>
        <span className="ratio-pill">
          {pw}×{ph}
        </span>
        <button
          className="icon-btn"
          title="Tam ekran önizleme"
          onClick={() => {
            const el = stageRef.current?.querySelector('canvas');
            el?.requestFullscreen?.();
          }}
        >
          <Maximize2 size={15} />
        </button>
      </div>
    </div>
  );
}
