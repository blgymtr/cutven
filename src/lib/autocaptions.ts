import { create } from 'zustand';
import { get } from '../store';
import type { Caption, Clip, Project } from '../types';
import { buildExport } from './exporter';
import { captionsFromSegments } from './captions';
import { projectDuration } from './util';

/**
 * "Videodan otomatik altyazı": the speech of the timeline is mixed to 16 kHz PCM with the export
 * graph (so cuts, speed changes and positions are exactly what plays), recognised offline by Whisper
 * in a utility process (electron/asr.cjs) and laid out as caption lines.
 */

export type AsrModel = 'base' | 'small' | 'turbo';
export type AsrSource = 'speech' | 'all' | 'clip';

export const ASR_MODELS: { id: AsrModel; name: string; size: string; hint: string }[] = [
  { id: 'base', name: 'Hızlı', size: '~130 MB', hint: 'Kısa videolar ve net konuşma için' },
  { id: 'small', name: 'Dengeli', size: '~500 MB', hint: 'Önerilen: hız ve doğruluk dengesi' },
  { id: 'turbo', name: 'En doğru', size: '~800 MB', hint: 'Türkçede en iyi sonuç; daha yavaş, 8 GB+ RAM önerilir' },
];

export const ASR_LANGS: { id: string; name: string }[] = [
  { id: 'turkish', name: 'Türkçe' },
  { id: 'english', name: 'İngilizce' },
  { id: 'german', name: 'Almanca' },
  { id: 'french', name: 'Fransızca' },
  { id: 'spanish', name: 'İspanyolca' },
  { id: 'arabic', name: 'Arapça' },
  { id: 'russian', name: 'Rusça' },
  { id: 'auto', name: 'Otomatik algıla' },
];

export const ASR_SOURCES: { id: AsrSource; name: string }[] = [
  { id: 'speech', name: 'Konuşma (müzik ve efekt izleri hariç)' },
  { id: 'all', name: 'Duyulan tüm sesler' },
  { id: 'clip', name: 'Sadece seçili klip' },
];

export type AsrPhase = 'extract' | 'download' | 'load' | 'transcribe';

export interface AsrState {
  running: boolean;
  phase: AsrPhase | null;
  progress: number;
  /** last recognised line (live feedback) */
  text: string;
  loaded?: number;
  total?: number;
}

export const useAsr = create<AsrState>(() => ({ running: false, phase: null, progress: 0, text: '' }));

const NON_SPEECH = /müzik|music|efekt|sfx/i;

/** The part of the project whose audio gets recognised (positions stay, so caption times are timeline times). */
export function speechProject(p: Project, source: AsrSource, clipId?: string): Project | null {
  const sourced = (c: Clip) => c.kind === 'video' || c.kind === 'audio';
  if (source === 'clip') {
    const c = p.clips.find((x) => x.id === clipId && sourced(x));
    if (!c) return null;
    // the chosen clip is heard even if it (or its track) is muted or another track is soloed
    return {
      ...p,
      clips: [{ ...c, muted: false }],
      tracks: p.tracks.map((t) => (t.id === c.trackId ? { ...t, muted: false, solo: false } : { ...t, solo: false })),
    };
  }
  const clips = p.clips.filter((c) => {
    if (!sourced(c)) return false;
    if (source === 'all') return true;
    const tr = p.tracks.find((t) => t.id === c.trackId);
    return !NON_SPEECH.test(tr?.name || '') && c.chan !== 'side';
  });
  return clips.length ? { ...p, clips } : null;
}

let cancelled = false;

export function cancelAutoCaptions() {
  cancelled = true;
  window.cv.invoke('asr:cancel');
}

export type AutoResult = { ok: true; captions: Caption[] } | { ok: false; cancelled?: boolean; error?: string };

export async function autoCaptions(opts: { model: AsrModel; language: string; source: AsrSource; clipId?: string }): Promise<AutoResult> {
  const p = get().project;
  if (!p) return { ok: false, error: 'Proje açık değil' };
  if (useAsr.getState().running) return { ok: false, error: 'Zaten bir altyazı işlemi sürüyor' };
  const sp = speechProject(p, opts.source, opts.clipId);
  if (!sp) return { ok: false, error: opts.source === 'clip' ? 'Önce zaman çizelgesinde sesli bir klip seç' : 'Zaman çizelgesinde sesli klip yok' };
  if (!sp.clips.some((c) => sp.media.find((m) => m.id === c.mediaId)?.hasAudio)) return { ok: false, error: 'Seçilen kaynakta ses yok' };
  cancelled = false;
  useAsr.setState({ running: true, phase: 'extract', progress: 0, text: '', loaded: undefined, total: undefined });
  const off = window.cv.on('asr:progress', (d: { phase: AsrPhase; progress: number; text?: string; loaded?: number; total?: number }) => {
    useAsr.setState((s) => ({ phase: d.phase, progress: d.progress ?? 0, text: d.text || s.text, loaded: d.loaded, total: d.total }));
  });
  try {
    const pcmPath = await window.cv.invoke<string>('asr:tempPath');
    const job = await buildExport(sp, { format: 'pcm', width: 0, height: 0, fps: p.fps || 30, crf: 0, preset: '', normalize: false, outPath: pcmPath });
    if (cancelled) return { ok: false, cancelled: true };
    const ex = await window.cv.invoke<{ ok: boolean; cancelled?: boolean; error?: string }>('asr:extract', job);
    if (cancelled || ex.cancelled) return { ok: false, cancelled: true };
    if (!ex.ok) return { ok: false, error: 'Ses hazırlanamadı: ' + (ex.error || '') };
    const r = await window.cv.invoke<{
      ok: boolean;
      cancelled?: boolean;
      error?: string;
      segments?: { start: number; end: number; text: string; regions: [number, number][] }[];
    }>('asr:transcribe', { pcmPath, model: opts.model, language: opts.language === 'auto' ? null : opts.language });
    if (cancelled || r.cancelled) return { ok: false, cancelled: true };
    if (!r.ok) return { ok: false, error: friendlyError(r.error || '') };
    return { ok: true, captions: captionsFromSegments(r.segments || [], projectDuration(p)) };
  } catch (e: any) {
    return cancelled ? { ok: false, cancelled: true } : { ok: false, error: friendlyError(String(e?.message || e)) };
  } finally {
    off();
    useAsr.setState({ running: false, phase: null, progress: 0 });
  }
}

function friendlyError(e: string) {
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|getaddrinfo/i.test(e))
    return 'Model indirilemedi. İlk kullanımda internet bağlantısı gerekir (huggingface.co). Bağlantını kontrol edip tekrar dene.';
  if (/ENOSPC/i.test(e)) return 'Diskte yer kalmadı: model indirilemedi.';
  return e;
}
