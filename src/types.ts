export type MediaType = 'video' | 'audio' | 'image';

export interface MediaItem {
  id: string;
  path: string;
  name: string;
  type: MediaType;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
  colorspace?: string;
  /** EXIF orientation for JPEG images */
  orientation?: number;
}

export type MediaStatus = 'loading' | 'ready' | 'proxy' | 'missing' | 'error';

export interface MediaRuntime {
  status: MediaStatus;
  thumb?: string;
  strip?: { url: string; count: number };
  wave?: boolean;
  previewPath?: string;
  progress?: number;
  error?: string;
}

export type TrackType = 'visual' | 'audio';

export interface Track {
  id: string;
  type: TrackType;
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
  /** mixer */
  volume?: number;
  pan?: number;
  solo?: boolean;
}

export interface ColorAdjust {
  preset: string;
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  hue: number;
}

export interface TextStyle {
  content: string;
  font: string;
  size: number;
  weight: number;
  italic: boolean;
  color: string;
  align: 'left' | 'center' | 'right';
  letterSpacing: number;
  lineHeight: number;
  uppercase: boolean;
  stroke: boolean;
  strokeColor: string;
  strokeWidth: number;
  shadow: boolean;
  shadowColor: string;
  shadowBlur: number;
  shadowOffset: number;
  bg: boolean;
  bgColor: string;
  bgOpacity: number;
  bgPadding: number;
  bgRadius: number;
}

export type ClipKind = 'video' | 'image' | 'audio' | 'text' | 'color';

/** Visual transition at a clip edge. Duration lives in fadeIn / fadeOut. */
export type TransType = 'fade' | 'dissolve' | 'black' | 'white' | 'slideL' | 'slideR' | 'slideU' | 'slideD' | 'zoom' | 'spin' | 'blur';

/** Which part of the source audio a clip plays (channel split / basic stem split). */
export type AudioChannel = 'L' | 'R' | 'mid' | 'side';

/** Volume keyframe: s = source time (s), v = volume (0..2). */
export interface VolKey {
  s: number;
  v: number;
}

export interface Clip {
  id: string;
  trackId: string;
  kind: ClipKind;
  mediaId?: string;
  /** timeline position (s) */
  start: number;
  /** source in/out points (s); for image/text: in=0, out=duration */
  in: number;
  out: number;
  speed: number;
  volume: number;
  muted: boolean;
  audioFadeIn: number;
  audioFadeOut: number;
  opacity: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  fadeIn: number;
  fadeOut: number;
  color: ColorAdjust;
  text?: TextStyle;
  /** solid fill for kind 'color' */
  fill?: string;
  tIn?: TransType;
  tOut?: TransType;
  /** audio effect preset id */
  afx?: string;
  chan?: AudioChannel;
  vkeys?: VolKey[];
  /** visual / lens effects, applied in order */
  vfx?: Vfx[];
  /** Lumetri-style grade (baked to a 3D LUT) */
  grade?: Grade;
  /** visual keyframes: x, y, scale, rotation, opacity */
  keys?: Partial<Record<KeyProp, Key[]>>;
  blend?: BlendMode;
  /** crop in % of the source frame */
  crop?: { l: number; r: number; t: number; b: number };
  /** green / blue screen */
  ckey?: { on: boolean; color: string; similarity: number; smooth: number; spill: number };
  /** linked audio/video (same source, moved/trimmed together) */
  link?: string;
  /** parametric EQ in dB (hp = high-pass frequency, 0 = off) */
  eq?: { hp: number; low: number; mid: number; midF: number; high: number };
  /** mains hum removal (50 / 60 Hz + harmonics) */
  dehum?: 50 | 60;
  /** brick-wall limiter at -1.5 dBFS */
  limit?: boolean;
}

export type KeyProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity';
export type Ease = 'linear' | 'ease' | 'in' | 'out' | 'hold';
/** keyframe at source time s */
export interface Key {
  s: number;
  v: number;
  e: Ease;
}

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light' | 'difference' | 'exclusion' | 'add';

export type Pt = [number, number];
export interface Wheel {
  h: number;
  a: number;
  l: number;
}
export interface Grade {
  on: boolean;
  exposure: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  tint: number;
  vibrance: number;
  wheels: { shadows: Wheel; mids: Wheel; highs: Wheel };
  curves: { m: Pt[]; r: Pt[]; g: Pt[]; b: Pt[] };
  hsl: { on: boolean; hue: number; range: number; satMin: number; soft: number; dHue: number; dSat: number; dLum: number; show: boolean };
  look: string;
  lookAmt: number;
  lut?: { name: string; path: string; amt: number };
}

export interface Caption {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface CaptionStyle {
  font: string;
  size: number;
  weight: number;
  color: string;
  bg: boolean;
  bgColor: string;
  bgOpacity: number;
  stroke: boolean;
  y: number;
  burn: boolean;
  uppercase: boolean;
}

export interface Vfx {
  id: string;
  amount: number;
  bpm?: number;
}

export interface Marker {
  id: string;
  time: number;
  label: string;
  color?: string;
  note?: string;
  /** duration in seconds (range marker) */
  dur?: number;
}

export interface Project {
  version: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  background: string;
  media: MediaItem[];
  tracks: Track[];
  clips: Clip[];
  markers: Marker[];
  createdAt: number;
  updatedAt: number;
  duration?: number;
  thumb?: string;
  /** content calendar */
  plannedDate?: string;
  status?: ProjectStatus;
  /** narration script (tempo coach / prompter) */
  script?: string;
  thumbDesign?: ThumbDesign;
  /** YouTube metadata / upload settings */
  yt?: YtMeta;
  /** last exported file (for YouTube upload) */
  lastExport?: string;
  captions?: Caption[];
  captionStyle?: CaptionStyle;
  /** timeline In / Out marks (three-point editing, lift / extract) */
  inPoint?: number;
  outPoint?: number;
}

export interface YtMeta {
  title: string;
  description: string;
  tags: string[];
  category: string;
  privacy: 'private' | 'unlisted' | 'public';
  /** ISO time for scheduled publish (privacy must be private) */
  publishAt?: string;
  madeForKids: boolean;
  language: string;
  /** upload right after export */
  autoUpload: boolean;
  includeChapters: boolean;
  videoId?: string;
  uploadedAt?: number;
}

export type ProjectStatus = 'idea' | 'shoot' | 'edit' | 'ready' | 'published';

export interface ThumbLayer {
  id: string;
  kind: 'text' | 'image';
  x: number;
  y: number;
  scale: number;
  rotation: number;
  text?: TextStyle;
  path?: string;
}

export interface ThumbDesign {
  /** data URL (frame grab) or file path */
  bg: string | null;
  bgColor: string;
  bgScale: number;
  bgX: number;
  bgY: number;
  darken: number;
  vignette: number;
  color: ColorAdjust;
  layers: ThumbLayer[];
  embed: boolean;
}

export interface ProjectSummary {
  path: string;
  name: string;
  updatedAt: number;
  thumb: string | null;
  width: number;
  height: number;
  duration: number;
  plannedDate?: string | null;
  status?: ProjectStatus | null;
}

declare global {
  interface Window {
    cv: {
      invoke: <T = any>(channel: string, ...args: any[]) => Promise<T>;
      sendSync: (channel: string, ...args: any[]) => any;
      on: (channel: string, fn: (data: any) => void) => () => void;
      pathForFile: (file: File) => string;
    };
  }
}
