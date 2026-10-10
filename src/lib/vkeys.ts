import type { Draft } from 'immer';
import { edit, get } from '../store';
import type { Clip, Ease, Key, KeyProp } from '../types';
import { clamp, clipDur } from './util';

/**
 * Visual keyframes (Premiere "Motion" / "Opacity"): x, y, scale, rotation, opacity.
 * Keys live in SOURCE time (like the volume keys) so trims and splits keep them on the picture.
 */

export const KEY_PROPS: { id: KeyProp; name: string; min: number; max: number; step: number }[] = [
  { id: 'x', name: 'Konum X', min: -4000, max: 4000, step: 1 },
  { id: 'y', name: 'Konum Y', min: -4000, max: 4000, step: 1 },
  { id: 'scale', name: 'Ölçek', min: 0.05, max: 5, step: 0.01 },
  { id: 'rotation', name: 'Döndürme', min: -360, max: 360, step: 0.5 },
  { id: 'opacity', name: 'Opaklık', min: 0, max: 1, step: 0.01 },
];

export const EASES: { id: Ease; name: string }[] = [
  { id: 'linear', name: 'Doğrusal' },
  { id: 'ease', name: 'Yumuşak' },
  { id: 'in', name: 'Yavaş başla' },
  { id: 'out', name: 'Yavaş bitir' },
  { id: 'hold', name: 'Bekle (sıçrama)' },
];

const easeFn = (e: Ease, p: number) => (e === 'hold' ? 0 : e === 'ease' ? p * p * (3 - 2 * p) : e === 'in' ? p * p : e === 'out' ? 1 - (1 - p) * (1 - p) : p);

export const hasKeys = (c: Clip, prop?: KeyProp) => (prop ? !!c.keys?.[prop]?.length : !!c.keys && Object.values(c.keys).some((k) => k && k.length));
const srcAt = (c: Clip, local: number) => c.in + local * c.speed;

export function keyedValue(c: Clip, prop: KeyProp, local: number): number {
  const k = c.keys?.[prop];
  const base = c[prop] as number;
  if (!k || !k.length) return base;
  const s = srcAt(c, local);
  if (s <= k[0].s) return k[0].v;
  for (let i = 1; i < k.length; i++) {
    if (s <= k[i].s) {
      const a = k[i - 1];
      const b = k[i];
      const p = clamp((s - a.s) / Math.max(1e-6, b.s - a.s), 0, 1);
      return a.v + (b.v - a.v) * easeFn(a.e, p);
    }
  }
  return k[k.length - 1].v;
}

/** The clip with its keyed properties evaluated at clip-local time `local`. */
export function resolveKeys(c: Clip, local: number): Clip {
  if (!c.keys || !hasKeys(c)) return c;
  const out = { ...c };
  for (const p of KEY_PROPS) if (c.keys[p.id]?.length) (out as any)[p.id] = keyedValue(c, p.id, local);
  return out;
}

export function maxKeyed(c: Clip, prop: KeyProp) {
  const k = c.keys?.[prop];
  return k?.length ? Math.max(...k.map((x) => x.v)) : (c[prop] as number);
}

const n = (v: number) => (Math.round(v * 100000) / 100000).toString();

/** ffmpeg expression of a keyed prop. `S` is an expression for source time. map() transforms values (units). */
export function keyExpr(c: Clip, prop: KeyProp, S: string, map: (v: number) => number = (v) => v): string | null {
  const k = c.keys?.[prop];
  if (!k || !k.length) return null;
  const P = (a: Key, b: Key) => `clip((${S}-${n(a.s)})/${n(Math.max(1e-6, b.s - a.s))},0,1)`;
  const ease = (e: Ease, p: string) =>
    e === 'hold' ? '0' : e === 'ease' ? `(${p})*(${p})*(3-2*(${p}))` : e === 'in' ? `(${p})*(${p})` : e === 'out' ? `(1-(1-(${p}))*(1-(${p})))` : `(${p})`;
  let expr = n(map(k[k.length - 1].v));
  for (let i = k.length - 1; i >= 1; i--) {
    const a = k[i - 1];
    const b = k[i];
    const va = map(a.v);
    const vb = map(b.v);
    expr = `if(lt(${S},${n(b.s)}),${n(va)}+${n(vb - va)}*${ease(a.e, P(a, b))},${expr})`;
  }
  return `if(lt(${S},${n(k[0].s)}),${n(map(k[0].v))},${expr})`;
}

/** Per-frame opacity commands for ffmpeg sendcmd (local stream time starts at visual start). */
export function opacityCommands(c: Clip, target: string, fps: number, pre: number, len: number, base = 1): string {
  const lines: string[] = [];
  let last = -1;
  for (let f = 0; f <= Math.ceil(len * fps); f++) {
    const t = f / fps;
    const v = Math.round(clamp(keyedValue(c, 'opacity', t - pre) * base, 0, 1) * 1000) / 1000;
    if (v !== last) lines.push(`${t.toFixed(4)} ${target} aa ${v};`);
    last = v;
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------ editing */

const near = (c: Clip, prop: KeyProp, s: number) => (c.keys?.[prop] || []).findIndex((k) => Math.abs(k.s - s) < (1 / 30) * c.speed + 1e-4);
const localNow = (c: Clip) => clamp(get().time - c.start, 0, clipDur(c));

/** ◆ toggle: add a key with the current value at the playhead, or remove the one there. */
export function toggleKey(id: string, prop: KeyProp) {
  const c = get().project?.clips.find((x) => x.id === id);
  if (!c) return;
  const local = localNow(c);
  const s = srcAt(c, local);
  const i = near(c, prop, s);
  edit((d) => {
    const x = d.clips.find((q) => q.id === id)!;
    x.keys = { ...(x.keys || {}) };
    const list = [...(x.keys[prop] || [])].map((k) => ({ ...k }));
    if (i >= 0) list.splice(i, 1);
    else list.push({ s, v: keyedValue(c, prop, local), e: 'ease' });
    list.sort((a, b) => a.s - b.s);
    if (list.length) x.keys[prop] = list;
    else {
      // removing the last key leaves the clip at that value
      if (i >= 0) (x as any)[prop] = c.keys![prop]![i].v;
      delete x.keys[prop];
    }
  });
}

/** Set a property; with keys on that property this writes (or creates) the key at the playhead. */
export function setProp(d: Draft<Clip>, prop: KeyProp, v: number, time = get().time) {
  const k = d.keys?.[prop];
  if (!k || !k.length) {
    (d as any)[prop] = v;
    return;
  }
  const local = clamp(time - d.start, 0, (d.out - d.in) / d.speed);
  const s = d.in + local * d.speed;
  const i = k.findIndex((q) => Math.abs(q.s - s) < (1 / 30) * d.speed + 1e-4);
  if (i >= 0) k[i].v = v;
  else {
    k.push({ s, v, e: 'ease' });
    k.sort((a, b) => a.s - b.s);
  }
}

export function setEase(id: string, prop: KeyProp, index: number, e: Ease) {
  edit((d) => {
    const k = d.clips.find((q) => q.id === id)?.keys?.[prop]?.[index];
    if (k) k.e = e;
  });
}

export function clearKeys(id: string, prop?: KeyProp) {
  edit((d) => {
    const x = d.clips.find((q) => q.id === id);
    if (!x?.keys) return;
    if (prop) {
      const last = x.keys[prop]?.slice(-1)[0];
      if (last) (x as any)[prop] = last.v;
      delete x.keys[prop];
    } else x.keys = undefined;
  });
}

/** Jump to previous / next key of any (or one) property. */
export function keyTimes(c: Clip, prop?: KeyProp): number[] {
  const out: number[] = [];
  for (const p of KEY_PROPS) if (!prop || p.id === prop) for (const k of c.keys?.[p.id] || []) out.push(c.start + (k.s - c.in) / c.speed);
  return [...new Set(out.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
}
