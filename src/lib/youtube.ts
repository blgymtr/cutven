import { edit, get } from '../store';
import type { Project, YtMeta } from '../types';
import { chaptersText } from './actions';
import { thumbBlob } from './thumb';

export const CATEGORIES = [
  { id: '22', name: 'İnsanlar ve Bloglar' },
  { id: '24', name: 'Eğlence' },
  { id: '27', name: 'Eğitim' },
  { id: '26', name: 'Nasıl Yapılır ve Stil' },
  { id: '20', name: 'Oyun' },
  { id: '10', name: 'Müzik' },
  { id: '28', name: 'Bilim ve Teknoloji' },
  { id: '17', name: 'Spor' },
  { id: '19', name: 'Seyahat ve Etkinlikler' },
  { id: '23', name: 'Komedi' },
  { id: '25', name: 'Haberler ve Politika' },
  { id: '1', name: 'Film ve Animasyon' },
  { id: '2', name: 'Otomobiller ve Araçlar' },
  { id: '15', name: 'Evcil Hayvanlar' },
  { id: '29', name: 'Kâr Amacı Gütmeyen' },
];

export const LANGS = [
  { id: 'tr', name: 'Türkçe' },
  { id: 'en', name: 'İngilizce' },
  { id: 'de', name: 'Almanca' },
  { id: 'ar', name: 'Arapça' },
  { id: 'az', name: 'Azerbaycan Türkçesi' },
];

const pad = (n: number) => String(n).padStart(2, '0');

/** Planned date from the content calendar → 18:00 local time as ISO. */
export function publishAtFromPlan(p: Project): string | undefined {
  if (!p.plannedDate) return undefined;
  const [y, m, d] = p.plannedDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 18, 0, 0);
  return dt.getTime() > Date.now() + 15 * 60000 ? dt.toISOString() : undefined;
}

export function defaultMeta(p: Project): YtMeta {
  return {
    title: p.name.slice(0, 100),
    description: '',
    tags: suggestTags(p).slice(0, 8),
    category: '22',
    privacy: 'private',
    publishAt: undefined,
    madeForKids: false,
    language: 'tr',
    autoUpload: false,
    includeChapters: true,
  };
}

export const metaOf = (p: Project): YtMeta => ({ ...defaultMeta(p), ...(p.yt || {}) });

export function updateMeta(patch: Partial<YtMeta>, key?: string) {
  edit((d) => {
    d.yt = { ...metaOf(d as Project), ...(d.yt || {}), ...patch };
    // not part of the undo snapshot: recording would only add empty undo steps
  }, { record: false, key: key ? 'yt-' + key : undefined });
}

const STOP = new Set(
  'bir bu şu o ve ile için gibi çok daha en ama fakat ya da veya ki de da mi mı mu mü ne nasıl neden niye hem her hiç olan olarak ise sonra önce kadar bunu şunu onu benim senin bizim sizin ben sen biz siz onlar var yok değil evet hayır şey şeyi şimdi bugün the and for with you your this that from are was'.split(' '),
);

/** Tag ideas from the title, chapter names and the narration script. */
export function suggestTags(p: Project): string[] {
  const text = [p.name, p.name, ...p.markers.map((m) => m.label), p.script || ''].join(' ').toLocaleLowerCase('tr-TR');
  const words = text.match(/[\p{L}\p{N}]{3,}/gu) || [];
  const freq = new Map<string, number>();
  for (const w of words) if (!STOP.has(w) && !/^bölüm\d*$/.test(w) && !/\d/.test(w) && !(w === 'proje' && /^Proje \d/.test(p.name))) freq.set(w, (freq.get(w) || 0) + 1);
  const single = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
  const title = p.name.toLocaleLowerCase('tr-TR').replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  const defaultName = /^Proje \d/.test(p.name);
  const out = [defaultName ? '' : title, ...single].filter((x, i, a) => x && a.indexOf(x) === i);
  return out.slice(0, 15);
}

export function hashtags(m: YtMeta) {
  return m.tags
    .slice(0, 3)
    .map((t) => '#' + t.replace(/\s+/g, '').replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((t) => t.length > 1)
    .join(' ');
}

/** Final description: user text + chapters + channel template + hashtags. */
export function fullDescription(p: Project, m: YtMeta, template = ''): string {
  const parts = [m.description.trim()];
  if (m.includeChapters && p.markers.length) parts.push(chaptersText(p));
  if (template.trim()) parts.push(template.trim());
  const h = hashtags(m);
  if (h) parts.push(h);
  return parts.filter(Boolean).join('\n\n');
}

export function validate(m: YtMeta, desc: string): string[] {
  const e: string[] = [];
  if (!m.title.trim()) e.push('Başlık boş olamaz.');
  if (m.title.length > 100) e.push(`Başlık 100 karakteri geçemez (${m.title.length}).`);
  if (/[<>]/.test(m.title + desc)) e.push('Başlık ve açıklamada < > karakterleri kullanılamaz.');
  if (new TextEncoder().encode(desc).length > 5000) e.push('Açıklama 5000 baytı geçemez.');
  const tagLen = m.tags.reduce((s, t) => s + t.length + (t.includes(' ') ? 2 : 0) + 1, 0);
  if (tagLen > 500) e.push(`Etiketler toplam 500 karakteri geçemez (${tagLen}).`);
  if (m.publishAt && new Date(m.publishAt).getTime() < Date.now()) e.push('Planlı yayın tarihi geçmişte.');
  return e;
}

export interface YtStatus {
  configured: boolean;
  connected: boolean;
  channel: { id: string; title: string; thumb: string; subs: string | null } | null;
  clientId: string;
}

export const ytStatus = () => window.cv.invoke<YtStatus>('yt:status');

export interface UploadResult {
  videoId: string;
  url: string;
  studio: string;
  privacy: string;
  thumbOk: true | string | null;
}

/** Upload an exported file with the project's metadata (and thumbnail when designed). */
/** Upload a rendered file. `project` is the project it was made from (a background export may outlive it being open). */
export async function uploadToYoutube(path: string, project?: Project, projectPath?: string | null): Promise<UploadResult> {
  const p = project || get().project!;
  const m = metaOf(p);
  const settings = await window.cv.invoke<{ ytTemplate?: string }>('settings:get');
  const description = fullDescription(p, m, settings.ytTemplate || '');
  const errs = validate(m, description);
  if (errs.length) throw new Error(errs.join(' '));
  let thumbPath: string | undefined;
  if (p.thumbDesign) thumbPath = await window.cv.invoke<string>('export:writeTemp', await thumbBlob(p.thumbDesign, 'image/jpeg'), `yt-thumb-${Date.now()}.jpg`);
  const r = await window.cv.invoke<UploadResult>('yt:upload', {
    path,
    thumbPath,
    meta: { title: m.title.trim(), description, tags: m.tags, category: m.category, privacy: m.privacy, publishAt: m.publishAt, madeForKids: m.madeForKids, language: m.language },
  });
  const published = !m.publishAt && m.privacy === 'public';
  if (get().project?.id === p.id) {
    edit((d) => {
      d.yt = { ...metaOf(d as Project), ...(d.yt || {}), videoId: r.videoId, uploadedAt: Date.now() };
      if (published) d.status = 'published';
    }, { record: false });
  } else if (projectPath) {
    // another project is open now: record the upload in the right file
    const yt = { ...m, ...(p.yt || {}), videoId: r.videoId, uploadedAt: Date.now() };
    await window.cv.invoke('project:patch', projectPath, published ? { yt, status: 'published' } : { yt });
  }
  return r;
}

export const fmtLocal = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
