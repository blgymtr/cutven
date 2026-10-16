import { edit, get, set, toast } from '../store';
import type { Project } from '../types';
import { buildExport, CODEC_EXT, type ExportOptions, type HwKind, type Loudness, type VideoCodec } from './exporter';
import { styleOf, toSrt } from './captions';
import { thumbCoverPath } from './thumb';
import { metaOf, uploadToYoutube } from './youtube';
import { rangeProject } from './proedit';

/**
 * Export runner. Lives outside the dialog so an export keeps going (and reports progress in the top bar)
 * after the dialog is closed — "export in background".
 */

export interface ExpState {
  phase: 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  elapsed: number;
  stage: string;
  out: string;
  error?: string;
  kind: 'video' | 'audio';
  codec: VideoCodec;
  yt?: { busy: boolean; p: number; url?: string; studio?: string; error?: string };
}

export interface RunParams {
  audioOnly: boolean;
  codec: VideoCodec;
  hw: HwKind | null;
  width: number;
  height: number;
  fps: number;
  crf: number;
  preset: string;
  normalize: boolean;
  range: [number, number] | null;
}

const patchExp = (p: Partial<ExpState>) => {
  const e = get().exp;
  if (e) set({ exp: { ...e, ...p } });
};

let off: (() => void) | null = null;
/** cancel pressed while the job is still being prepared (no ffmpeg process to kill yet) */
let cancelReq = false;

export function cancelExport() {
  cancelReq = true;
  window.cv.invoke('export:cancel');
}

export async function pickOutput(project: Project, prm: RunParams): Promise<string | null> {
  if (prm.audioOnly) return window.cv.invoke<string | null>('dialog:saveExport', project.name, 'mp3');
  if (prm.codec === 'png') {
    const dir = await window.cv.invoke<string | null>('dialog:openFolder', 'PNG kareleri için klasör seç');
    // '%' is ffmpeg's frame-number placeholder: a literal one in the name must be doubled
    return dir ? `${dir}\\${project.name.replace(/[\\/:*?"<>|]/g, '_').replace(/%/g, '%%')}_%05d.png` : null;
  }
  return window.cv.invoke<string | null>('dialog:saveExport', project.name, CODEC_EXT[prm.codec]);
}

export async function runExport(project0: Project, prm: RunParams, out: string) {
  const project = prm.range ? rangeProject(project0, prm.range[0], prm.range[1]) : project0;
  // the export can outlive the project being open (background export → user opens another one)
  const path0 = get().projectPath;
  const stillOpen = () => get().project?.id === project0.id;
  cancelReq = false;
  set({ exp: { phase: 'running', progress: 0, elapsed: 0, stage: '', out, kind: prm.audioOnly ? 'audio' : 'video', codec: prm.codec } });
  off?.();
  off = window.cv.on('export:progress', (d) => patchExp({ progress: d.progress, elapsed: d.elapsed }));
  try {
    const video = !prm.audioOnly;
    const withAudio = !prm.audioOnly && prm.codec !== 'gif' && prm.codec !== 'png';
    const coverPath = video && (prm.codec === 'h264' || prm.codec === 'hevc') ? await thumbCoverPath(project) : undefined;
    const base: ExportOptions = {
      format: video ? 'mp4' : 'mp3',
      width: prm.width,
      height: prm.height,
      fps: prm.fps,
      crf: prm.crf,
      preset: prm.preset,
      normalize: prm.normalize && (withAudio || prm.audioOnly),
      outPath: out,
      coverPath,
      codec: video ? prm.codec : undefined,
      hw: prm.hw,
    };
    let measured: Loudness | undefined;
    if (cancelReq) return patchExp({ phase: 'cancelled' });
    if (base.normalize) {
      patchExp({ stage: 'Ses analiz ediliyor…' });
      const mj = await buildExport(project, { ...base, measureOnly: true });
      if (cancelReq) return patchExp({ phase: 'cancelled' });
      const mr = await window.cv.invoke<{ ok: boolean; cancelled?: boolean; loudness?: Loudness }>('export:measure', mj);
      if (mr.cancelled || cancelReq) return patchExp({ phase: 'cancelled' });
      measured = mr.loudness;
    }
    patchExp({ stage: '' });
    const job = await buildExport(project, { ...base, normalize: base.normalize && !!measured, measured });
    if (cancelReq) return patchExp({ phase: 'cancelled' });
    const r = await window.cv.invoke<{ ok: boolean; cancelled?: boolean; error?: string }>('export:start', job);
    if (r.cancelled) return patchExp({ phase: 'cancelled' });
    if (!r.ok) {
      patchExp({ phase: 'error', error: r.error || 'Bilinmeyen hata' });
      if (!get().exportOpen) toast('Dışa aktarma başarısız oldu', 'error');
      return;
    }
    patchExp({ phase: 'done', progress: 1 });
    if (!get().exportOpen) toast('Video hazır: ' + out.split(/[\\/]/).pop(), 'success');
    if (video && (prm.codec === 'h264' || prm.codec === 'hevc')) {
      if (stillOpen()) edit((d) => void (d.lastExport = out), { record: false });
      else if (path0) await window.cv.invoke('project:patch', path0, { lastExport: out });
      if (project.captions?.length && !styleOf(project).burn) await window.cv.invoke('file:writeText', out.replace(/\.[^.\\/]+$/, '') + '.srt', toSrt(project.captions));
      const st = await window.cv.invoke<{ connected: boolean }>('yt:status');
      if (st.connected && metaOf(project0).autoUpload) startUpload(out, project0, path0);
    }
  } catch (e: any) {
    patchExp({ phase: 'error', error: String(e?.message || e) });
  } finally {
    off?.();
    off = null;
  }
}

let offYt: (() => void) | null = null;
export async function startUpload(path: string, project?: Project, projectPath?: string | null) {
  patchExp({ yt: { busy: true, p: 0 } });
  offYt?.();
  offYt = window.cv.on('yt:progress', (d) => {
    const e = get().exp;
    if (e?.yt) patchExp({ yt: { ...e.yt, p: d.progress } });
  });
  try {
    const r = await uploadToYoutube(path, project, projectPath);
    patchExp({ yt: { busy: false, p: 1, url: r.url, studio: r.studio } });
    if (!get().exportOpen) toast('YouTube’a yüklendi', 'success');
  } catch (e: any) {
    patchExp({ yt: { busy: false, p: 0, error: String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') } });
  } finally {
    offYt?.();
    offYt = null;
  }
}
