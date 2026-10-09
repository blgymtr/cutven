import { edit, get, set, setRuntime, toast } from '../store';
import type { MediaItem } from '../types';
import { basename, mediaUrl, uid } from './util';

export const waveforms = new Map<string, Uint8Array>();
const stripImages = new Map<string, HTMLImageElement>();

export function stripImage(url: string): HTMLImageElement {
  let img = stripImages.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    stripImages.set(url, img);
  }
  return img;
}

interface ProbeResult {
  error?: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
  colorspace?: string;
  orientation?: number;
  type: MediaItem['type'];
}

/** Test whether Chromium can decode the file directly. */
function canPlay(path: string, type: MediaItem['type']): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement(type === 'audio' ? 'audio' : 'video') as HTMLVideoElement;
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      el.removeAttribute('src');
      el.load();
      resolve(v);
    };
    el.preload = 'auto';
    el.muted = true;
    el.onloadeddata = () => finish(type === 'audio' || el.videoWidth > 0);
    el.onerror = () => finish(false);
    setTimeout(() => finish(el.readyState >= 1 && (type === 'audio' || el.videoWidth > 0)), 10000);
    el.src = mediaUrl(path);
  });
}

export async function prepareMedia(m: MediaItem) {
  setRuntime(m.id, { status: 'loading', error: undefined });
  const exists = await window.cv.invoke<boolean>('fs:exists', m.path);
  if (!exists) {
    setRuntime(m.id, { status: 'missing' });
    return;
  }
  try {
    if (m.type === 'image') {
      setRuntime(m.id, { thumb: mediaUrl(m.path), status: 'ready' });
      return;
    }
    if (m.type === 'video') {
      window.cv.invoke<string | null>('media:thumb', m.path, m.duration).then((t) => t && setRuntime(m.id, { thumb: mediaUrl(t) }));
      window.cv
        .invoke<{ path: string; count: number } | null>('media:strip', m.path, m.duration)
        .then((s) => s && setRuntime(m.id, { strip: { url: mediaUrl(s.path), count: s.count } }));
    }
    if (m.hasAudio) {
      window.cv.invoke<Uint8Array>('media:waveform', m.path).then((w) => {
        waveforms.set(m.id, new Uint8Array(w));
        setRuntime(m.id, { wave: true });
      });
    }
    const playable = await canPlay(m.path, m.type);
    if (playable) {
      setRuntime(m.id, { status: 'ready', previewPath: undefined });
      return;
    }
    setRuntime(m.id, { status: 'proxy', progress: 0 });
    const off = window.cv.on('media:proxy-progress', (d) => {
      if (d.id === m.id) setRuntime(m.id, { progress: d.progress });
    });
    try {
      const proxy = await window.cv.invoke<string>('media:proxy', m.id, m.path, m.type);
      setRuntime(m.id, { status: 'ready', previewPath: proxy, progress: 1 });
    } finally {
      off();
    }
  } catch (e: any) {
    setRuntime(m.id, { status: 'error', error: String(e?.message || e) });
  }
}

/** Rasterize an SVG into a PNG next to the project (ffmpeg cannot read SVG). */
async function svgToPng(path: string): Promise<string | null> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = mediaUrl(path);
  try {
    await img.decode();
  } catch {
    return null;
  }
  const w0 = img.naturalWidth || 1024;
  const h0 = img.naturalHeight || 1024;
  const k = Math.min(4, 2048 / Math.max(w0, h0));
  const cv = document.createElement('canvas');
  cv.width = Math.round(w0 * k);
  cv.height = Math.round(h0 * k);
  cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height);
  const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/png'));
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return window.cv.invoke<string>('asset:write', get().projectPath, basename(path).replace(/\.svg$/i, '.png'), bytes);
}

export async function importPaths(paths: string[]): Promise<MediaItem[]> {
  const out: MediaItem[] = [];
  for (let path of paths) {
    const original = path;
    const ext = path.toLowerCase().split('.').pop();
    if (ext === 'svg') path = (await svgToPng(path)) || path;
    else if (ext === 'tif' || ext === 'tiff') path = (await window.cv.invoke<string | null>('media:toPng', path)) || path;
    const p = get().project;
    if (!p) break;
    const existing = p.media.find((m) => m.path.toLowerCase() === path.toLowerCase());
    if (existing) {
      out.push(existing);
      continue;
    }
    const info = await window.cv.invoke<ProbeResult>('media:probe', path);
    if (info.error) {
      toast(`${basename(path)}: ${info.error}`, 'error');
      continue;
    }
    const item: MediaItem = {
      id: uid(),
      path,
      name: original === path ? basename(path) : basename(original).replace(/.[^.]+$/, '.png'),
      type: info.type,
      duration: info.type === 'image' ? 5 : info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps || 30,
      hasAudio: info.hasAudio,
      hasVideo: info.hasVideo,
      colorspace: info.colorspace,
      orientation: info.orientation,
    };
    edit((d) => void d.media.push(item), { record: false });
    out.push(item);
    prepareMedia(item);
  }
  return out;
}

export async function pickAndImport() {
  const paths = await window.cv.invoke<string[]>('dialog:openMedia');
  if (paths.length) return importPaths(paths);
  return [];
}

export async function importFolder() {
  const dir = await window.cv.invoke<string | null>('dialog:openFolder');
  if (!dir) return [];
  const files = await window.cv.invoke<string[]>('media:scanFolder', dir);
  if (!files.length) {
    toast('Bu klasörde medya bulunamadı');
    return [];
  }
  toast(`${files.length} dosya içe aktarılıyor…`);
  return importPaths(files);
}

/** Paste an image from the clipboard (e.g. a screenshot) as media. */
export async function importClipboardImage(): Promise<MediaItem | null> {
  const p = await window.cv.invoke<string | null>('clipboard:image', get().projectPath);
  if (!p) {
    toast('Panoda görsel yok — önce bir ekran görüntüsü al (Win+Shift+S)');
    return null;
  }
  const [m] = await importPaths([p]);
  if (m) toast('Panodaki görsel eklendi', 'success');
  return m || null;
}

export async function relinkMedia(id: string) {
  const path = await window.cv.invoke<string | null>('dialog:pickFile', 'Dosyayı bul');
  if (!path) return;
  edit(
    (d) => {
      const m = d.media.find((x) => x.id === id);
      if (m) {
        m.path = path;
        m.name = basename(path);
      }
    },
    { record: false },
  );
  const m = get().project?.media.find((x) => x.id === id);
  if (m) prepareMedia(m);
}

export function removeMedia(id: string) {
  edit(
    (d) => {
      d.media = d.media.filter((m) => m.id !== id);
      d.clips = d.clips.filter((c) => c.mediaId !== id);
    },
    { record: false },
  );
  // keep undo history consistent: no step may resurrect clips of removed media
  const s = get();
  const strip = <T extends { clips: { mediaId?: string }[] }>(x: T) => ({ ...x, clips: x.clips.filter((c) => c.mediaId !== id) });
  set({ past: s.past.map(strip), future: s.future.map(strip), selection: s.selection.filter((sid) => s.project?.clips.some((c) => c.id === sid)) });
}
