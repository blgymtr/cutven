import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  def?: number;
  unit?: string;
  /** display multiplier (e.g. 100 for percent) */
  mult?: number;
  digits?: number;
  /** logarithmic track (for ratios like scale: 100% sits near the middle, not at 19%) */
  log?: boolean;
  onChange: (v: number) => void;
}) {
  const { label, value, min, max, step = 0.01, def, unit = '', mult = 1, digits = 0, log = false, onChange } = props;
  const toPos = (v: number) => (log ? Math.log(Math.max(min, v)) : v);
  const fromPos = (x: number) => (log ? +(Math.round(Math.exp(x) / step) * step).toFixed(6) : x);
  const lo = toPos(min);
  const hi = toPos(max);
  const pct = Math.min(100, Math.max(0, ((toPos(value) - lo) / (hi - lo)) * 100));
  const [txt, setTxt] = useState<string | null>(null);
  const shown = (value * mult).toFixed(digits);
  return (
    <div className="row">
      <label onDoubleClick={() => def != null && onChange(def)} title={def != null ? 'Sıfırlamak için çift tıkla' : undefined}>
        {label}
      </label>
      <div className="slider">
        <input
          type="range"
          min={lo}
          max={hi}
          step={log ? 0.001 : step}
          value={toPos(value)}
          style={{ ['--p' as any]: `${pct}%` }}
          onChange={(e) => onChange(Math.min(max, Math.max(min, fromPos(parseFloat(e.target.value)))))}
          onDoubleClick={() => def != null && onChange(def)}
        />
        <input
          className="num"
          value={txt ?? shown + unit}
          onFocus={(e) => {
            setTxt(shown);
            requestAnimationFrame(() => e.target.select());
          }}
          onChange={(e) => setTxt(e.target.value)}
          onBlur={() => {
            const v = parseFloat((txt || '').replace(',', '.'));
            if (!isNaN(v)) onChange(Math.min(max, Math.max(min, v / mult)));
            setTxt(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setTxt(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </div>
    </div>
  );
}

export function Toggle({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return <button className={'toggle' + (on ? ' on' : '')} onClick={() => onChange(!on)} title={title} aria-pressed={on} />;
}

export function Segmented<T extends string | number>(props: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {props.options.map((o) => (
        <button key={String(o.value)} className={o.value === props.value ? 'on' : ''} title={o.title} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <span className="swatch" style={{ background: value }}>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
    </span>
  );
}

export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  k?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  sep?: boolean;
}

let openMenu: ((m: { x: number; y: number; items: MenuItem[] } | null) => void) | null = null;

export function showMenu(x: number, y: number, items: MenuItem[]) {
  openMenu?.({ x, y, items });
}

export function MenuHost() {
  const [m, setM] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useEffect(() => {
    openMenu = setM;
    return () => {
      openMenu = null;
    };
  }, []);
  useEffect(() => {
    if (!m) return;
    const close = () => setM(null);
    const t = setTimeout(() => {
      window.addEventListener('pointerdown', close);
      window.addEventListener('blur', close);
      window.addEventListener('keydown', close);
    });
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', close);
    };
  }, [m]);
  useEffect(() => {
    if (!m || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(m.x, window.innerWidth - r.width - 8), y: Math.min(m.y, window.innerHeight - r.height - 8) });
  }, [m]);
  if (!m) return null;
  return createPortal(
    <div className="ctx-menu" ref={ref} style={{ left: pos.x || m.x, top: pos.y || m.y }} onPointerDown={(e) => e.stopPropagation()}>
      {m.items.map((it, i) =>
        it.sep ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            className={it.danger ? 'danger' : ''}
            disabled={it.disabled}
            style={it.disabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
            onClick={() => {
              setM(null);
              it.onClick?.();
            }}
          >
            {it.icon}
            {it.label}
            {it.k && <span className="k">{it.k}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

interface ConfirmReq {
  title: string;
  text?: string;
  ok: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
}
let openConfirm: ((r: ConfirmReq | null) => void) | null = null;

export function askConfirm(title: string, opts: { text?: string; ok?: string; danger?: boolean } = {}) {
  return new Promise<boolean>((resolve) => {
    if (!openConfirm) return resolve(true);
    openConfirm({ title, text: opts.text, ok: opts.ok || 'Tamam', danger: opts.danger, resolve });
  });
}

export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmReq | null>(null);
  useEffect(() => {
    openConfirm = setReq;
    return () => {
      openConfirm = null;
    };
  }, []);
  useEffect(() => {
    if (!req) return;
    const k = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') done(true);
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  });
  if (!req) return null;
  const done = (v: boolean) => {
    req.resolve(v);
    setReq(null);
  };
  return createPortal(
    <div className="modal-back" onPointerDown={() => done(false)}>
      <div className="modal" style={{ width: 400 }} onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{req.title}</h3>
        </div>
        {req.text && (
          <div className="modal-body hint" style={{ fontSize: 12.5 }}>
            {req.text}
          </div>
        )}
        <div className="modal-foot">
          <button className="btn ghost" onClick={() => done(false)}>
            Vazgeç
          </button>
          <button className={'btn ' + (req.danger ? 'danger' : 'primary')} autoFocus onClick={() => done(true)}>
            {req.ok}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export class Boundary extends Component<{ children: ReactNode; name: string }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error) {
    console.error(this.props.name, err);
  }
  render() {
    if (this.state.err)
      return (
        <div className="err-box">
          <div>{this.props.name} yüklenemedi.</div>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={() => this.setState({ err: null })}>
            Tekrar dene
          </button>
        </div>
      );
    return this.props.children;
  }
}
