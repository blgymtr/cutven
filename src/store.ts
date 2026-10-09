import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import type { Clip, MediaRuntime, Project, Track } from './types';
import { uid } from './lib/util';

type Snap = Pick<Project, 'tracks' | 'clips' | 'markers' | 'width' | 'height' | 'fps' | 'background' | 'name'>;

export interface Toast {
  id: string;
  text: string;
  kind?: 'info' | 'error' | 'success';
}

export type LeftTab = 'media' | 'sfx' | 'text' | 'trans' | 'record' | 'tempo' | 'intro' | 'thumb' | 'chapters';

export type RecStatus = 'idle' | 'countdown' | 'recording' | 'paused' | 'saving';

export interface RecState {
  status: RecStatus;
  countdown: number;
  /** timeline time where the current take starts */
  start: number;
  /** seconds captured so far */
  elapsed: number;
}

export interface Take {
  id: string;
  name: string;
  path: string;
  start: number;
  duration: number;
  peaks: number[];
  mediaId?: string;
  clipId?: string;
}

export interface State {
  screen: 'start' | 'editor';
  project: Project | null;
  projectPath: string | null;
  saveState: 'saved' | 'saving' | 'dirty';
  selection: string[];
  time: number;
  playing: boolean;
  pps: number;
  snapping: boolean;
  scrollLeft: number;
  viewW: number;
  leftTab: LeftTab;
  thumbOpen: boolean;
  captureOpen: null | 'screen' | 'camera';
  rec: RecState;
  takes: Take[];
  runtime: Record<string, MediaRuntime>;
  past: Snap[];
  future: Snap[];
  lastKey: string | null;
  lastKeyAt: number;
  clipboard: Clip[];
  exportOpen: boolean;
  toasts: Toast[];
  version: number;
}

export const useStore = create<State>(() => ({
  screen: 'start',
  project: null,
  projectPath: null,
  saveState: 'saved',
  selection: [],
  time: 0,
  playing: false,
  pps: 60,
  snapping: true,
  scrollLeft: 0,
  viewW: 1000,
  leftTab: 'media',
  thumbOpen: false,
  captureOpen: null,
  rec: { status: 'idle', countdown: 0, start: 0, elapsed: 0 },
  takes: [],
  runtime: {},
  past: [],
  future: [],
  lastKey: null,
  lastKeyAt: 0,
  clipboard: [],
  exportOpen: false,
  toasts: [],
  version: 0,
}));

export const get = useStore.getState;
export const set = useStore.setState;

const snap = (p: Project): Snap => ({
  tracks: p.tracks,
  clips: p.clips,
  markers: p.markers,
  width: p.width,
  height: p.height,
  fps: p.fps,
  background: p.background,
  name: p.name,
});

export interface EditOpts {
  /** coalesce consecutive edits with the same key into one undo step */
  key?: string;
  /** false: do not create an undo step (used during drags after beginGesture) */
  record?: boolean;
}

export function edit(recipe: (p: Draft<Project>) => void, opts: EditOpts = {}) {
  const s = get();
  if (!s.project) return;
  const now = Date.now();
  const record = opts.record !== false;
  const coalesce = !!opts.key && s.lastKey === opts.key && now - s.lastKeyAt < 1200;
  const project = produce(s.project, recipe);
  if (project === s.project) return;
  const patch: Partial<State> = { project, saveState: 'dirty' };
  if (record && !coalesce) {
    patch.past = [...s.past.slice(-120), snap(s.project)];
    patch.future = [];
  }
  if (record) {
    patch.lastKey = opts.key ?? null;
    patch.lastKeyAt = now;
  }
  set(patch);
}

/** Push one undo step now; following edits use {record:false}. */
export function beginGesture() {
  const s = get();
  if (!s.project) return;
  set({ past: [...s.past.slice(-120), snap(s.project)], future: [], lastKey: null });
}

export function undo() {
  const s = get();
  if (!s.project || !s.past.length) return;
  const prev = s.past[s.past.length - 1];
  set({
    project: { ...s.project, ...prev },
    past: s.past.slice(0, -1),
    future: [...s.future, snap(s.project)],
    saveState: 'dirty',
    lastKey: null,
    selection: s.selection.filter((id) => prev.clips.some((c) => c.id === id)),
  });
}

export function redo() {
  const s = get();
  if (!s.project || !s.future.length) return;
  const next = s.future[s.future.length - 1];
  set({
    project: { ...s.project, ...next },
    future: s.future.slice(0, -1),
    past: [...s.past, snap(s.project)],
    saveState: 'dirty',
    lastKey: null,
    selection: s.selection.filter((id) => next.clips.some((c) => c.id === id)),
  });
}

export function setRuntime(id: string, patch: Partial<MediaRuntime>) {
  const s = get();
  const cur = s.runtime[id] || { status: 'loading' };
  set({ runtime: { ...s.runtime, [id]: { ...cur, ...patch } } });
}

export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = uid();
  set({ toasts: [...get().toasts, { id, text, kind }] });
  setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 6000 : 2800);
}

export function select(ids: string[]) {
  set({ selection: ids });
}

export function newTrack(type: Track['type'], name?: string): Track {
  return { id: uid(), type, name: name || '', muted: false, hidden: false, locked: false };
}

export const selectedClips = () => {
  const s = get();
  if (!s.project) return [];
  return s.project.clips.filter((c) => s.selection.includes(c.id));
};
