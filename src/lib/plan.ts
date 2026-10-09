import type { ProjectStatus } from '../types';

export const STATUSES: { id: ProjectStatus; name: string; color: string }[] = [
  { id: 'idea', name: 'Fikir', color: '#9a9aa3' },
  { id: 'shoot', name: 'Çekim', color: '#5b8cff' },
  { id: 'edit', name: 'Kurgu', color: '#ff9f43' },
  { id: 'ready', name: 'Hazır', color: '#3ddc97' },
  { id: 'published', name: 'Yayında', color: '#ff4d5e' },
];

export const statusOf = (s?: ProjectStatus | null) => STATUSES.find((x) => x.id === s);

const pad = (n: number) => String(n).padStart(2, '0');
export const dateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = () => dateStr(new Date());
export const addDays = (s: string, n: number) => {
  const [y, m, d] = s.split('-').map(Number);
  return dateStr(new Date(y, m - 1, d + n));
};
export const parseDate = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export function dayLabel(s: string) {
  const t = todayStr();
  if (s === t) return 'Bugün';
  if (s === addDays(t, 1)) return 'Yarın';
  if (s === addDays(t, -1)) return 'Dün';
  return parseDate(s).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', weekday: 'short' });
}
