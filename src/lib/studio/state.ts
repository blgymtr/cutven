import { create } from 'zustand';
import type { TextStyle } from '../../types';
import { DEFAULT_TEXT } from '../text';
import { uid } from '../util';

/**
 * Recording studio (OBS-style): scenes made of sources, an audio mixer and the recording / streaming
 * settings. This file holds the serialisable state (saved to settings.json → "studio"); the live media,
 * canvases and encoders live in engine.ts.
 */

export type SrcKind = 'display' | 'window' | 'camera' | 'image' | 'text' | 'color' | 'media';

export interface Crop {
  l: number;
  r: number;
  t: number;
  b: number;
}

export interface StudioSource {
  id: string;
  kind: SrcKind;
  name: string;
  visible: boolean;
  locked: boolean;
  /** box on the canvas, top-left + size (canvas px) */
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
  /** cut off each edge, fraction of the source (0 … 0.45) */
  crop: Crop;
  mirror: boolean;
  shape: 'rect' | 'rounded' | 'circle';
  radius: number;
  border: number;
  borderColor: string;
  brightness: number;
  contrast: number;
  saturation: number;
  chroma: { on: boolean; color: string; similarity: number; smooth: number; spill: number };
  /** fit the box to the media's aspect once its size is known */
  fit?: 'full' | 'corner' | 'center';
  /* kind-specific */
  device?: string;
  camRes?: '720' | '1080' | '2160';
  capture?: string;
  captureName?: string;
  /** display / window / media: route its sound into the mixer */
  audio?: boolean;
  path?: string;
  loop?: boolean;
  text?: TextStyle;
  color?: string;
}

export interface StudioScene {
  id: string;
  name: string;
  /** index 0 = bottom, last = front */
  sources: StudioSource[];
}

export type AudioKind = 'desktop' | 'mic' | 'source';

export interface AudioIn {
  id: string;
  kind: AudioKind;
  name: string;
  /** microphone device */
  device?: string;
  /** kind 'source': the display / media source whose sound this is */
  sourceId?: string;
  /** fader, dB (-60 = silent) */
  volume: number;
  muted: boolean;
  /** hear it on the speakers (headphones recommended) */
  monitor: boolean;
  /** browser noise suppression (microphones) */
  suppress: boolean;
  gate: { on: boolean; threshold: number };
  comp: boolean;
  /** extra gain, dB */
  gain: number;
  /** delay, ms (lip sync) */
  offset: number;
}

export type HotkeyAction = 'record' | 'pause' | 'stream' | 'mute' | 'shot' | 'transition';

export interface StudioSettings {
  width: number;
  height: number;
  fps: 30 | 60;
  /** '' = Videolar/Cutven Kayıtlar */
  folder: string;
  format: 'mp4' | 'mkv';
  codec: 'h264' | 'vp9' | 'av1';
  quality: 'high' | 'std' | 'low' | 'custom';
  kbps: number;
  audioKbps: number;
  countdown: number;
  minimize: boolean;
  /** keep the Cutven window out of screen captures */
  hideSelf: boolean;
  addToProject: boolean;
  studioMode: boolean;
  transition: 'cut' | 'fade' | 'slide' | 'zoom';
  transitionMs: number;
  hotkeysGlobal: boolean;
  hotkeys: Record<HotkeyAction, string>;
  streamKbps: number;
}

export interface Recording {
  path: string;
  at: number;
  secs: number;
  bytes: number;
}

export interface StudioStatus {
  active: boolean;
  rec: 'idle' | 'countdown' | 'recording' | 'paused' | 'saving';
  countdown: number;
  recSecs: number;
  recBytes: number;
  recKbps: number;
  stream: 'idle' | 'starting' | 'live' | 'stopping';
  streamSecs: number;
  streamKbps: number;
  fps: number;
  /** frames the compositor could not render on time */
  lagged: number;
  cpu: number;
  diskFree: number | null;
  transitioning: boolean;
  /** encoder actually used (mime) */
  encoder: string;
}

export interface StudioState {
  loaded: boolean;
  scenes: StudioScene[];
  /** scene on air */
  program: string;
  /** studio mode: scene being prepared */
  preview: string;
  selected: string | null;
  audio: AudioIn[];
  settings: StudioSettings;
  recordings: Recording[];
  status: StudioStatus;
  settingsOpen: boolean;
  /** per media key: why a source could not start */
  errors: Record<string, string>;
}

export const QUALITY_KBPS: Record<'high' | 'std' | 'low', number> = { high: 12000, std: 8000, low: 4000 };

/** video bitrate (kbps) for the current settings, scaled by resolution and frame rate */
export function videoKbps(s: StudioSettings) {
  if (s.quality === 'custom') return Math.max(500, s.kbps);
  const px = (s.width * s.height) / (1920 * 1080);
  return Math.round(QUALITY_KBPS[s.quality] * Math.max(0.35, px) * (s.fps === 60 ? 1.5 : 1));
}

export const DEFAULT_SETTINGS: StudioSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  folder: '',
  format: 'mp4',
  codec: 'h264',
  quality: 'high',
  kbps: 12000,
  audioKbps: 192,
  countdown: 3,
  minimize: false,
  hideSelf: true,
  addToProject: true,
  studioMode: false,
  transition: 'fade',
  transitionMs: 300,
  hotkeysGlobal: true,
  // Alt+F-keys: global, so they must not steal plain F-keys (debuggers, games, F10 menus) from other apps
  hotkeys: { record: 'Alt+F9', pause: 'Alt+F10', stream: '', mute: 'Alt+F8', shot: 'Alt+F7', transition: '' },
  streamKbps: 4500,
};

export const HOTKEY_NAMES: Record<HotkeyAction, string> = {
  record: 'Kaydı başlat / durdur',
  pause: 'Kaydı duraklat / devam',
  stream: 'Yayını başlat / durdur',
  mute: 'Mikrofonu sustur / aç',
  shot: 'Ekran görüntüsü',
  transition: 'Geçiş (stüdyo modu)',
};

export const KIND_NAMES: Record<SrcKind, string> = {
  display: 'Ekran',
  window: 'Pencere',
  camera: 'Kamera',
  image: 'Görsel',
  text: 'Metin',
  color: 'Renk',
  media: 'Video dosyası',
};

export function newSource(kind: SrcKind, W: number, H: number, patch: Partial<StudioSource> = {}): StudioSource {
  const base: StudioSource = {
    id: uid(),
    kind,
    name: KIND_NAMES[kind],
    visible: true,
    locked: false,
    x: 0,
    y: 0,
    w: W,
    h: H,
    opacity: 1,
    crop: { l: 0, r: 0, t: 0, b: 0 },
    mirror: false,
    shape: 'rect',
    radius: 24,
    border: 0,
    borderColor: '#ffffff',
    brightness: 1,
    contrast: 1,
    saturation: 1,
    chroma: { on: false, color: '#00ff00', similarity: 0.3, smooth: 0.1, spill: 0.1 },
  };
  if (kind === 'display' || kind === 'window' || kind === 'media') Object.assign(base, { fit: 'full', audio: kind === 'media' });
  if (kind === 'media') base.loop = true;
  if (kind === 'camera') {
    const w = Math.round(W * 0.28);
    Object.assign(base, { camRes: '1080', fit: 'corner', w, h: Math.round((w * 9) / 16), x: W - w - Math.round(W * 0.025), y: H - Math.round((w * 9) / 16) - Math.round(H * 0.04) });
  }
  if (kind === 'image') base.fit = 'center';
  if (kind === 'color') Object.assign(base, { color: '#111114', name: 'Arka plan' });
  if (kind === 'text') {
    base.text = { ...DEFAULT_TEXT, content: 'Yazı', size: Math.round(H * 0.08) };
    base.fit = 'center';
  }
  return { ...base, ...patch };
}

export const newAudio = (kind: AudioKind, name: string, patch: Partial<AudioIn> = {}): AudioIn => ({
  id: uid(),
  kind,
  name,
  volume: 0,
  muted: false,
  monitor: false,
  suppress: kind === 'mic',
  gate: { on: false, threshold: -45 },
  comp: false,
  gain: 0,
  offset: 0,
  ...patch,
});

/** Ready-made scenes for a YouTube channel. */
export const SCENE_TEMPLATES: { id: string; name: string; make: (W: number, H: number) => StudioSource[] }[] = [
  { id: 'empty', name: 'Boş sahne', make: () => [] },
  { id: 'screen', name: 'Ekran', make: (W, H) => [newSource('display', W, H)] },
  { id: 'screen-cam', name: 'Ekran + köşede kamera', make: (W, H) => [newSource('display', W, H), newSource('camera', W, H, { shape: 'rounded', border: 4, borderColor: '#ff6a3d' })] },
  { id: 'cam', name: 'Sadece kamera', make: (W, H) => [newSource('camera', W, H, { x: 0, y: 0, w: W, h: H, fit: 'full' })] },
  {
    id: 'starting',
    name: 'Başlıyoruz',
    make: (W, H) => {
      const t = newSource('text', W, H, { name: 'Başlık' });
      t.text = { ...t.text!, content: 'Birazdan başlıyoruz', size: Math.round(H * 0.09), weight: 900 };
      return [newSource('color', W, H, { color: '#16161b' }), t];
    },
  },
];

export const defaultScenes = (W: number, H: number): StudioScene[] => [{ id: uid(), name: 'Sahne 1', sources: SCENE_TEMPLATES[1].make(W, H) }];

const IDLE: StudioStatus = {
  active: false,
  rec: 'idle',
  countdown: 0,
  recSecs: 0,
  recBytes: 0,
  recKbps: 0,
  stream: 'idle',
  streamSecs: 0,
  streamKbps: 0,
  fps: 0,
  lagged: 0,
  cpu: 0,
  diskFree: null,
  transitioning: false,
  encoder: '',
};

export const useStudio = create<StudioState>(() => {
  const scenes = defaultScenes(DEFAULT_SETTINGS.width, DEFAULT_SETTINGS.height);
  return {
    loaded: false,
    scenes,
    program: scenes[0].id,
    preview: scenes[0].id,
    selected: null,
    audio: [newAudio('desktop', 'Masaüstü sesi', { suppress: false }), newAudio('mic', 'Mikrofon')],
    settings: DEFAULT_SETTINGS,
    recordings: [],
    status: IDLE,
    settingsOpen: false,
    errors: {},
  };
});

export const sget = useStudio.getState;
export const sset = useStudio.setState;

export const patchStatus = (p: Partial<StudioStatus>) => sset((s) => ({ status: { ...s.status, ...p } }));

/** scene shown and edited in the main monitor (studio mode: the preview) */
export const editSceneId = (s: StudioState = sget()) => (s.settings.studioMode ? s.preview : s.program);
export const editScene = (s: StudioState = sget()) => s.scenes.find((x) => x.id === editSceneId(s)) || s.scenes[0];

export function findSource(id: string | null, s: StudioState = sget()): StudioSource | undefined {
  if (!id) return undefined;
  for (const sc of s.scenes) {
    const x = sc.sources.find((q) => q.id === id);
    if (x) return x;
  }
  return undefined;
}

/* ------------------------------------------------------------ editing */

export function updateSource(id: string, patch: Partial<StudioSource>) {
  sset((s) => ({ scenes: s.scenes.map((sc) => ({ ...sc, sources: sc.sources.map((x) => (x.id === id ? { ...x, ...patch } : x)) })) }));
}

export function addSource(src: StudioSource, sceneId = editSceneId()) {
  sset((s) => ({ scenes: s.scenes.map((sc) => (sc.id === sceneId ? { ...sc, sources: [...sc.sources, src] } : sc)), selected: src.id }));
  syncSourceAudio();
}

export function removeSource(id: string) {
  sset((s) => ({ scenes: s.scenes.map((sc) => ({ ...sc, sources: sc.sources.filter((x) => x.id !== id) })), selected: s.selected === id ? null : s.selected }));
  syncSourceAudio();
}

/** dir = +1 towards the front */
export function moveSource(id: string, dir: 1 | -1) {
  sset((s) => ({
    scenes: s.scenes.map((sc) => {
      const i = sc.sources.findIndex((x) => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= sc.sources.length) return sc;
      const list = [...sc.sources];
      [list[i], list[j]] = [list[j], list[i]];
      return { ...sc, sources: list };
    }),
  }));
}

export function addScene(templateId = 'empty') {
  const s = sget();
  const t = SCENE_TEMPLATES.find((x) => x.id === templateId) || SCENE_TEMPLATES[0];
  let n = s.scenes.length + 1;
  while (s.scenes.some((x) => x.name === `Sahne ${n}`)) n++;
  const sc: StudioScene = { id: uid(), name: templateId === 'empty' ? `Sahne ${n}` : t.name, sources: t.make(s.settings.width, s.settings.height) };
  sset({ scenes: [...s.scenes, sc], selected: null });
  syncSourceAudio();
  return sc.id;
}

export function duplicateScene(id: string) {
  const s = sget();
  const sc = s.scenes.find((x) => x.id === id);
  if (!sc) return;
  const copy: StudioScene = { id: uid(), name: sc.name + ' kopya', sources: sc.sources.map((x) => ({ ...x, id: uid() })) };
  const i = s.scenes.indexOf(sc);
  sset({ scenes: [...s.scenes.slice(0, i + 1), copy, ...s.scenes.slice(i + 1)] });
  syncSourceAudio();
}

export function removeScene(id: string) {
  const s = sget();
  if (s.scenes.length <= 1) return;
  const scenes = s.scenes.filter((x) => x.id !== id);
  sset({
    scenes,
    program: s.program === id ? scenes[0].id : s.program,
    preview: s.preview === id ? scenes[0].id : s.preview,
    selected: null,
  });
  syncSourceAudio();
}

export function renameScene(id: string, name: string) {
  sset((s) => ({ scenes: s.scenes.map((x) => (x.id === id ? { ...x, name } : x)) }));
}

export function moveScene(id: string, dir: 1 | -1) {
  sset((s) => {
    const i = s.scenes.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= s.scenes.length) return {};
    const list = [...s.scenes];
    [list[i], list[j]] = [list[j], list[i]];
    return { scenes: list };
  });
}

export function updateAudio(id: string, patch: Partial<AudioIn>) {
  sset((s) => ({ audio: s.audio.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
}

export function setSettings(patch: Partial<StudioSettings>) {
  const s = sget();
  const next = { ...s.settings, ...patch };
  // a new canvas size re-lays every scene proportionally
  if ((patch.width && patch.width !== s.settings.width) || (patch.height && patch.height !== s.settings.height)) {
    const kx = next.width / s.settings.width;
    const ky = next.height / s.settings.height;
    const k = Math.min(kx, ky);
    const ox = (next.width - s.settings.width * k) / 2;
    const oy = (next.height - s.settings.height * k) / 2;
    sset({
      scenes: s.scenes.map((sc) => ({
        ...sc,
        sources: sc.sources.map((x) => {
          const full = x.x === 0 && x.y === 0 && x.w === s.settings.width && x.h === s.settings.height;
          return full ? { ...x, w: next.width, h: next.height } : { ...x, x: Math.round(x.x * k + ox), y: Math.round(x.y * k + oy), w: Math.round(x.w * k), h: Math.round(x.h * k) };
        }),
      })),
    });
  }
  sset({ settings: next });
}

/** Every display / media source with "audio" gets (and keeps) its own mixer channel. */
export function syncSourceAudio() {
  const s = sget();
  const wanted = new Map<string, StudioSource>();
  for (const sc of s.scenes) for (const x of sc.sources) if ((x.kind === 'display' || x.kind === 'window' || x.kind === 'media') && x.audio) wanted.set(x.id, x);
  let audio = s.audio.filter((a) => a.kind !== 'source' || (a.sourceId && wanted.has(a.sourceId)));
  for (const [id, x] of wanted) if (!audio.some((a) => a.sourceId === id)) audio = [...audio, newAudio('source', x.name, { sourceId: id, suppress: false })];
  if (audio.length !== s.audio.length || audio.some((a, i) => a !== s.audio[i])) sset({ audio });
}

/* ------------------------------------------------------------ persistence */

type Saved = Pick<StudioState, 'scenes' | 'program' | 'preview' | 'audio' | 'settings' | 'recordings'>;

export async function loadStudio() {
  if (sget().loaded) return;
  try {
    const all = await window.cv.invoke<{ studio?: Partial<Saved> }>('settings:get');
    const j = all.studio;
    if (j?.scenes?.length) {
      const settings = { ...DEFAULT_SETTINGS, ...(j.settings || {}), hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...(j.settings?.hotkeys || {}) } };
      const scenes = j.scenes.map((sc) => ({ ...sc, sources: sc.sources.map((x) => ({ ...newSource(x.kind, settings.width, settings.height), ...x, fit: undefined })) }));
      const has = (id?: string) => !!id && scenes.some((x) => x.id === id);
      sset({
        scenes,
        program: has(j.program) ? j.program! : scenes[0].id,
        preview: has(j.preview) ? j.preview! : scenes[0].id,
        audio: (j.audio || []).map((a) => ({ ...newAudio(a.kind, a.name), ...a })),
        settings,
        recordings: j.recordings || [],
      });
    }
  } catch {}
  sset({ loaded: true });
  syncSourceAudio();
}

let saveTimer = 0;
useStudio.subscribe((s, prev) => {
  if (!s.loaded) return;
  if (s.scenes === prev.scenes && s.program === prev.program && s.preview === prev.preview && s.audio === prev.audio && s.settings === prev.settings && s.recordings === prev.recordings) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const { scenes, program, preview, audio, settings, recordings } = sget();
    window.cv.invoke('settings:set', { studio: { scenes, program, preview, audio, settings, recordings: recordings.slice(0, 40) } }).catch(() => {});
  }, 600);
});
