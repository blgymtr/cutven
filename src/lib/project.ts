import { edit, get, newTrack, set, toast, useStore } from '../store';
import type { Clip, Project } from '../types';
import { DEFAULT_COLOR } from './color';
import { DEFAULT_TEXT } from './text';
import { engine } from './engine';
import { recorder } from './recorder';
import { prepareMedia, waveforms } from './media';
import { projectDuration, uid } from './util';

export const ASPECTS = [
  { id: '16:9', name: 'YouTube', hint: '1920 × 1080', w: 1920, h: 1080 },
  { id: '9:16', name: 'Shorts', hint: '1080 × 1920', w: 1080, h: 1920 },
  { id: '1:1', name: 'Kare', hint: '1080 × 1080', w: 1080, h: 1080 },
  { id: '4:5', name: 'Dikey', hint: '1080 × 1350', w: 1080, h: 1350 },
];

function defaultName() {
  const d = new Date();
  return `Proje ${d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' })} ${d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }).replace(':', '.')}`;
}

function enterEditor(project: Project, path: string) {
  recorder.reset();
  engine.reset();
  waveforms.clear();
  set({
    screen: 'editor',
    project,
    projectPath: path,
    past: [],
    future: [],
    selection: [],
    time: 0,
    playing: false,
    runtime: {},
    saveState: 'saved',
    scrollLeft: 0,
    lastKey: null,
  });
  for (const m of project.media) prepareMedia(m);
}

export async function newProject(w: number, h: number) {
  const now = Date.now();
  const name = defaultName();
  const project: Project = {
    version: 1,
    id: uid(),
    name,
    width: w,
    height: h,
    fps: 30,
    background: '#000000',
    media: [],
    tracks: [newTrack('visual', 'Video 1'), newTrack('audio', 'Ses 1')],
    clips: [],
    markers: [],
    createdAt: now,
    updatedAt: now,
  };
  const path = await window.cv.invoke<string>('project:defaultPath', name);
  enterEditor(project, path);
  await saveProject();
  window.cv.invoke('project:remember', path);
}

/** Fill in fields missing from older / hand-edited files. */
function normalize(p: any): Project {
  const clips: Clip[] = (p.clips || []).map((c: any) => ({
    speed: 1, volume: 1, muted: false, audioFadeIn: 0, audioFadeOut: 0, opacity: 1, x: 0, y: 0, scale: 1, rotation: 0,
    fadeIn: 0, fadeOut: 0, ...c,
    color: { ...DEFAULT_COLOR, ...(c.color || {}) },
    text: c.kind === 'text' ? { ...DEFAULT_TEXT, ...(c.text || {}) } : undefined,
  }));
  return {
    version: 1,
    id: p.id || uid(),
    name: p.name || 'Proje',
    width: p.width || 1920,
    height: p.height || 1080,
    fps: p.fps || 30,
    background: p.background || '#000000',
    media: p.media || [],
    tracks: p.tracks?.length ? p.tracks : [newTrack('visual', 'Video 1'), newTrack('audio', 'Ses 1')],
    clips,
    markers: p.markers || [],
    createdAt: p.createdAt || Date.now(),
    updatedAt: p.updatedAt || Date.now(),
    thumb: p.thumb,
    plannedDate: p.plannedDate,
    status: p.status,
    script: p.script,
    thumbDesign: p.thumbDesign,
    yt: p.yt,
    lastExport: p.lastExport,
  };
}

export async function openProject(path?: string | null) {
  if (!path) path = await window.cv.invoke<string | null>('dialog:openProject');
  if (!path) return;
  try {
    const txt = await window.cv.invoke<string>('project:read', path);
    enterEditor(normalize(JSON.parse(txt)), path);
  } catch {
    toast('Proje açılamadı', 'error');
  }
}

let lastThumbAt = 0;
let saving: Promise<void> | null = null;

function serialize(p: Project) {
  return JSON.stringify({ ...p, updatedAt: Date.now(), duration: projectDuration(p) });
}

export async function saveProject(force = false) {
  if (saving) await saving;
  const s = get();
  if (!s.project || !s.projectPath) return;
  saving = (async () => {
    set({ saveState: 'saving' });
    let thumb = s.project!.thumb;
    if (!engine.playing && (force || Date.now() - lastThumbAt > 15000) && s.project!.clips.length) {
      const t = await engine.capture(320, 'image/jpeg', 0.7);
      if (t) {
        thumb = t;
        lastThumbAt = Date.now();
      }
    }
    const cur = get().project!;
    const proj = { ...cur, thumb };
    try {
      await window.cv.invoke('project:write', s.projectPath, serialize(proj));
      if (get().project === cur) set({ project: proj, saveState: 'saved' });
      else set({ project: { ...get().project!, thumb } });
    } catch {
      set({ saveState: 'dirty' });
      toast('Kaydedilemedi', 'error');
    }
  })();
  await saving;
  saving = null;
}

export async function saveProjectAs() {
  const s = get();
  if (!s.project) return;
  const path = await window.cv.invoke<string | null>('dialog:saveProject', s.project.name);
  if (!path) return;
  set({ projectPath: path });
  await saveProject(true);
  window.cv.invoke('project:remember', path);
  toast('Proje kaydedildi', 'success');
}

export function saveSync() {
  const s = get();
  if (!s.project || !s.projectPath || s.saveState === 'saved') return;
  window.cv.sendSync('project:writeSync', s.projectPath, serialize(s.project));
}

export async function closeProject() {
  if (recorder.busy) await recorder.stop();
  recorder.reset();
  await saveProject(true);
  engine.reset();
  set({ screen: 'start', project: null, projectPath: null, selection: [], runtime: {}, past: [], future: [] });
}

/* autosave */
let timer: number | undefined;
useStore.subscribe((s, prev) => {
  if (s.project && s.project !== prev.project && s.saveState === 'dirty') {
    clearTimeout(timer);
    timer = window.setTimeout(() => saveProject(), 1500);
  }
});
window.addEventListener('beforeunload', saveSync);

/** Create a project file for a planned video without opening it. */
export async function createPlannedProject(name: string, plannedDate: string, w = 1920, h = 1080) {
  const now = Date.now();
  const project: Project = {
    version: 1,
    id: uid(),
    name: name.trim() || defaultName(),
    width: w,
    height: h,
    fps: 30,
    background: '#000000',
    media: [],
    tracks: [newTrack('visual', 'Video 1'), newTrack('audio', 'Ses 1')],
    clips: [],
    markers: [],
    createdAt: now,
    updatedAt: now,
    plannedDate,
    status: 'idea',
  };
  const path = await window.cv.invoke<string>('project:defaultPath', project.name);
  await window.cv.invoke('project:write', path, serialize(project));
  window.cv.invoke('project:remember', path);
  return path;
}

/** Rename the open project and its file on disk. */
export async function renameProject(name: string) {
  const s = get();
  if (!s.project || !s.projectPath || !name.trim()) return;
  edit((d) => void (d.name = name.trim()));
  await saveProject();
  const next = await window.cv.invoke<string>('project:rename', s.projectPath, name.trim());
  if (next && next !== s.projectPath) set({ projectPath: next });
}
