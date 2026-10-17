import { useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { studio } from '../../lib/studio/engine';
import { useStudio, sget, sset, updateSource, editScene, type StudioSource } from '../../lib/studio/state';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Shows one of the engine's canvases; the editable one gets selection, move / resize handles and snapping. */
export default function Monitor({ which, editable, label }: { which: 'program' | 'preview'; editable: boolean; label?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const W = useStudio((s) => s.settings.width);
  const H = useStudio((s) => s.settings.height);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = hostRef.current!;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const k = Math.min((r.width - 16) / W, (r.height - 16) / H);
      setSize({ w: Math.max(10, Math.floor(W * k)), h: Math.max(10, Math.floor(H * k)) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  useLayoutEffect(() => {
    const cv = which === 'program' ? studio.program : studio.previewCv;
    cv.className = 'st-canvas';
    wrapRef.current!.prepend(cv);
    return () => {
      if (cv.parentElement === wrapRef.current) cv.remove();
    };
  }, [which]);

  const k = size.w / W;
  return (
    <div className={'st-monitor ' + which}>
      {label && <div className={'st-mon-label ' + which}>{label}</div>}
      <div className="st-mon-host" ref={hostRef}>
        <div className="st-canvas-wrap" ref={wrapRef} style={{ width: size.w, height: size.h }}>
          {editable && size.w > 0 && <Overlay k={k} W={W} H={H} />}
          <Countdown />
        </div>
      </div>
    </div>
  );
}

function Countdown() {
  const rec = useStudio((s) => s.status.rec);
  const n = useStudio((s) => s.status.countdown);
  if (rec !== 'countdown') return null;
  return (
    <div className="st-countdown">
      <span key={n}>{n}</span>
    </div>
  );
}

function Overlay({ k, W, H }: { k: number; W: number; H: number }) {
  const scene = useStudio((s) => editScene(s));
  const selected = useStudio((s) => s.selected);
  useStudio((s) => s.errors);
  const ref = useRef<HTMLDivElement>(null);
  const [guides, setGuides] = useState<{ v: number | null; h: number | null }>({ v: null, h: null });
  const sel = scene.sources.find((x) => x.id === selected);

  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };

  const hit = (x: number, y: number) => {
    for (let i = scene.sources.length - 1; i >= 0; i--) {
      const s = scene.sources[i];
      if (!s.visible || s.locked) continue;
      if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return s;
    }
    return null;
  };

  const drag = (e: React.PointerEvent, s: StudioSource, mode: 'move' | Handle) => {
    e.stopPropagation();
    e.preventDefault();
    if (s.locked) return;
    const p0 = toCanvas(e);
    const o = { x: s.x, y: s.y, w: s.w, h: s.h };
    const ar = o.w / Math.max(1, o.h);
    const snap = 10 / k;
    const move = (ev: PointerEvent) => {
      const p = toCanvas(ev);
      const dx = p.x - p0.x;
      const dy = p.y - p0.y;
      if (mode === 'move') {
        let x = o.x + dx;
        let y = o.y + dy;
        let gv: number | null = null;
        let gh: number | null = null;
        if (!ev.altKey) {
          // left / right edge and centre of the box → edges and centre of the canvas
          for (const [off, line] of [
            [x, 0],
            [x + o.w - W, W],
            [x + o.w / 2 - W / 2, W / 2],
          ] as const) {
            if (Math.abs(off) < snap) {
              x -= off;
              gv = line;
              break;
            }
          }
          for (const [off, line] of [
            [y, 0],
            [y + o.h - H, H],
            [y + o.h / 2 - H / 2, H / 2],
          ] as const) {
            if (Math.abs(off) < snap) {
              y -= off;
              gh = line;
              break;
            }
          }
        }
        setGuides({ v: gv, h: gh });
        updateSource(s.id, { x: Math.round(x), y: Math.round(y) });
        return;
      }
      // resize: the opposite corner / edge stays put
      let { x, y, w, h } = o;
      const L = mode.includes('w');
      const R = mode.includes('e');
      const T = mode.includes('n');
      const B = mode.includes('s');
      if (R) w = Math.max(8, o.w + dx);
      if (L) w = Math.max(8, o.w - dx);
      if (B) h = Math.max(8, o.h + dy);
      if (T) h = Math.max(8, o.h - dy);
      const corner = (L || R) && (T || B);
      if (corner && !ev.shiftKey) {
        // keep the aspect ratio; follow the larger move
        if (Math.abs(w - o.w) / o.w > Math.abs(h - o.h) / o.h) h = w / ar;
        else w = h * ar;
      }
      if (!ev.altKey) {
        // snap the moving edges to the canvas edges
        if (R && Math.abs(x + w - W) < snap) w = W - x;
        if (B && Math.abs(y + h - H) < snap) h = H - y;
      }
      if (L) x = o.x + o.w - w;
      if (T) y = o.y + o.h - h;
      updateSource(s.id, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGuides({ v: null, h: null });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = toCanvas(e);
    const s = hit(p.x, p.y);
    sset({ selected: s ? s.id : null });
    if (s) drag(e, s, 'move');
  };

  return (
    <div className="st-overlay" ref={ref} onPointerDown={onDown}>
      {!scene.sources.length && (
        <div className="st-empty">
          <b>Bu sahne boş</b>
          <span>Aşağıdaki Kaynaklar bölümünden + ile ekran, kamera, görsel ya da yazı ekle.</span>
        </div>
      )}
      {scene.sources.map((s) => {
        const err = s.visible ? studio.errorFor(s) : '';
        if (!err) return null;
        return (
          <div key={s.id} className="st-src-err" style={{ left: s.x * k, top: s.y * k, width: s.w * k, height: s.h * k }}>
            <span>
              <AlertTriangle size={13} /> {s.name}: {err}
            </span>
          </div>
        );
      })}
      {guides.v != null && <div className="st-guide v" style={{ left: guides.v * k }} />}
      {guides.h != null && <div className="st-guide h" style={{ top: guides.h * k }} />}
      {sel && sel.visible && (
        <div
          className={'st-sel' + (sel.locked ? ' locked' : '')}
          style={{ left: sel.x * k, top: sel.y * k, width: sel.w * k, height: sel.h * k }}
          onPointerDown={(e) => e.button === 0 && drag(e, sel, 'move')}
        >
          {!sel.locked && HANDLES.map((hd) => <i key={hd} className={'st-h ' + hd} onPointerDown={(e) => drag(e, sel, hd)} />)}
          <span className="st-sel-name">{sel.name}</span>
        </div>
      )}
    </div>
  );
}

/** keyboard nudging of the selected source (arrows; Shift = 10 px) */
export function nudgeSelected(dx: number, dy: number) {
  const s = sget();
  const src = editScene(s).sources.find((x) => x.id === s.selected);
  if (!src || src.locked) return false;
  updateSource(src.id, { x: src.x + dx, y: src.y + dy });
  return true;
}
