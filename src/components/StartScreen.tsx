import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Film, Trash2, Clapperboard, CalendarDays, MoreHorizontal, Pencil, CalendarPlus, Play, AlertCircle, X, Video } from 'lucide-react';
import type { ProjectStatus, ProjectSummary } from '../types';
import { ASPECTS, newProject, openProject, createPlannedProject } from '../lib/project';
import { formatDuration, timeAgo } from '../lib/util';
import { STATUSES, statusOf, todayStr, addDays, dayLabel, parseDate } from '../lib/plan';
import { Logo } from './TopBar';
import { askConfirm, showMenu } from './ui';
import { toast, set } from '../store';
import { StudioBadge } from './studio/Studio';

export function Shape({ w, h, size = 40, children }: { w: number; h: number; size?: number; children?: React.ReactNode }) {
  const s = size / Math.max(w, h);
  return (
    <div className="shape" style={{ width: w * s, height: h * s }}>
      {children}
    </div>
  );
}

function StatusChip({ s }: { s?: ProjectStatus | null }) {
  const st = statusOf(s);
  if (!st) return null;
  return (
    <span className="status-chip" style={{ color: st.color, borderColor: st.color + '55', background: st.color + '18' }}>
      {st.name}
    </span>
  );
}

/** Small popover editor for a project's plan (name, date, status). */
function PlanEditor({ p, onClose, onSaved }: { p: ProjectSummary | null; onClose: () => void; onSaved: () => void }) {
  const isNew = !p;
  const [name, setName] = useState(p?.name || '');
  const [date, setDate] = useState(p?.plannedDate || todayStr());
  const [status, setStatus] = useState<ProjectStatus>(p?.status || 'idea');
  const [aspect, setAspect] = useState(ASPECTS[0].id);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const save = async () => {
    if (isNew) {
      const a = ASPECTS.find((x) => x.id === aspect)!;
      await createPlannedProject(name, date, a.w, a.h);
      toast(`"${name || 'Yeni video'}" ${dayLabel(date).toLowerCase()} için planlandı`, 'success');
    } else {
      let path = p!.path;
      if (name.trim() && name.trim() !== p!.name) path = await window.cv.invoke<string>('project:rename', p!.path, name.trim());
      await window.cv.invoke('project:patch', path, { plannedDate: date || null, status });
    }
    onSaved();
    onClose();
  };
  return (
    <div className="modal-back" onPointerDown={onClose}>
      <div className="modal" style={{ width: 420 }} onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{isNew ? 'Video planla' : 'Projeyi düzenle'}</h3>
          <button className="icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="row">
            <label>Ad</label>
            <input ref={ref} className="field" value={name} placeholder="ör. 10 dakikada makarna" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
          </div>
          <div className="row">
            <label>Yayın günü</label>
            <input className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="row">
            <label>Durum</label>
            <div className="chips">
              {STATUSES.map((s) => (
                <button key={s.id} className={'chip' + (status === s.id ? ' on' : '')} onClick={() => setStatus(s.id)}>
                  {s.name}
                </button>
              ))}
            </div>
          </div>
          {isNew && (
            <div className="row">
              <label>Format</label>
              <div className="chips">
                {ASPECTS.map((a) => (
                  <button key={a.id} className={'chip' + (aspect === a.id ? ' on' : '')} onClick={() => setAspect(a.id)}>
                    {a.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot">
          {!isNew && p?.plannedDate && (
            <button
              className="btn ghost"
              style={{ marginRight: 'auto' }}
              onClick={async () => {
                await window.cv.invoke('project:patch', p.path, { plannedDate: null });
                onSaved();
                onClose();
              }}
            >
              Planı kaldır
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn primary" onClick={save}>
            {isNew ? 'Planla' : 'Kaydet'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Today({ list, onEdit, onPlan }: { list: ProjectSummary[]; onEdit: (p: ProjectSummary) => void; onPlan: () => void }) {
  const today = todayStr();
  const todays = list.filter((p) => p.plannedDate === today);
  const late = list.filter((p) => p.plannedDate && p.plannedDate < today && p.status !== 'published');
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  return (
    <div className="today">
      <div className="today-main">
        <div className="today-head">
          <CalendarDays size={16} />
          <span>{parseDate(today).toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
        </div>
        {todays.length ? (
          <>
            <div className="today-title">Bugün {todays.length === 1 ? 'bu video var' : `${todays.length} video var`}</div>
            <div className="today-list">
              {todays.map((p) => (
                <div key={p.path} className="today-item">
                  <div className="today-thumb" style={p.thumb ? { backgroundImage: `url(${p.thumb})` } : undefined}>
                    {!p.thumb && <Film size={16} />}
                  </div>
                  <div className="today-info">
                    <b>{p.name}</b>
                    <StatusChip s={p.status} />
                  </div>
                  <button className="icon-btn sm" title="Düzenle" onClick={() => onEdit(p)}>
                    <Pencil size={13} />
                  </button>
                  <button className="btn sm primary" onClick={() => openProject(p.path)}>
                    <Play size={12} fill="currentColor" /> Aç
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="today-title">Bugün planlı video yok</div>
            <p className="muted" style={{ margin: '4px 0 12px' }}>
              Yayın takvimini buradan tut: her videoya bir gün ver, Cutven sana o gün hatırlatsın.
            </p>
            <button className="btn sm" onClick={onPlan}>
              <CalendarPlus size={13} /> Video planla
            </button>
          </>
        )}
        {late.length > 0 && (
          <div className="late">
            <AlertCircle size={13} /> Geciken: {late.map((p) => p.name).join(', ')}
          </div>
        )}
      </div>
      <div className="week">
        {days.map((d) => {
          const items = list.filter((p) => p.plannedDate === d);
          return (
            <div key={d} className={'day' + (d === today ? ' now' : '')}>
              <div className="day-name">{d === today ? 'Bugün' : parseDate(d).toLocaleDateString('tr-TR', { weekday: 'short' })}</div>
              <div className="day-num">{parseDate(d).getDate()}</div>
              <div className="day-items">
                {items.map((p) => (
                  <button key={p.path} className="day-item" title={p.name} onClick={() => onEdit(p)} style={{ borderLeftColor: statusOf(p.status)?.color }}>
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function StartScreen() {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [editing, setEditing] = useState<ProjectSummary | null | 'new'>(null);
  const load = () => window.cv.invoke<ProjectSummary[]>('project:list').then(setList);
  const [crashed, setCrashed] = useState<{ path: string; at: number } | null>(null);
  useEffect(() => {
    load();
    window.cv.invoke<{ path: string; at: number } | null>('session:previous').then(setCrashed);
  }, []);

  const menu = (e: React.MouseEvent, p: ProjectSummary) => {
    e.stopPropagation();
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: 'Aç', icon: <Play size={14} />, onClick: () => openProject(p.path) },
      { label: 'Yeniden adlandır / planla', icon: <Pencil size={14} />, onClick: () => setEditing(p) },
      ...STATUSES.map((s) => ({
        label: `Durum: ${s.name}`,
        icon: <span className="dot-ico" style={{ background: s.color }} />,
        onClick: async () => {
          await window.cv.invoke('project:patch', p.path, { status: s.id });
          load();
        },
      })),
      { sep: true },
      {
        label: 'Çöp kutusuna taşı',
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: async () => {
          const ok = await askConfirm('Proje silinsin mi?', { text: `"${p.name}" çöp kutusuna taşınacak. Medya dosyalarına dokunulmaz.`, ok: 'Çöpe taşı', danger: true });
          if (!ok) return;
          await window.cv.invoke('project:trash', p.path);
          load();
        },
      },
    ]);
  };

  return (
    <div className="start">
      <div className="topbar">
        <div className="brand">
          <Logo />
          Cutven
        </div>
        <div className="spacer" />
        <StudioBadge />
      </div>
      <div className="start-body">
        <div className="start-inner">
          <div className="hero">
            <div>
              <h1>Ne kurguluyoruz bugün?</h1>
              <p>Bir format seç, videolarını sürükle, gerisini birlikte halledelim.</p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn primary" onClick={() => set({ screen: 'studio', studioBack: 'start' })} title="Ekran, kamera ve sesi sahnelerle kaydet ya da yayınla (OBS gibi)">
                <Video size={15} /> Kayıt stüdyosu
              </button>
              <button className="btn" onClick={() => setEditing('new')}>
                <CalendarPlus size={15} /> Video planla
              </button>
              <button className="btn" onClick={() => openProject()}>
                <FolderOpen size={15} /> Proje aç
              </button>
            </div>
          </div>

          {crashed && (
            <div className="crash-banner">
              <div className="grow">
                <b>Cutven geçen sefer beklenmedik şekilde kapandı.</b>
                <span>Proje otomatik kaydedildi; kaldığın yerden devam edebilirsin. Bir şey eksikse Dosya › Sürüm geçmişi'nden eski bir yedeğe dönebilirsin.</span>
              </div>
              <button className="btn primary sm" onClick={() => openProject(crashed.path)}>
                Projeyi aç
              </button>
              <button className="btn ghost sm" onClick={() => setCrashed(null)}>
                Kapat
              </button>
            </div>
          )}

          {list && <Today list={list} onEdit={(p) => setEditing(p)} onPlan={() => setEditing('new')} />}

          <div className="new-grid">
            {ASPECTS.map((a, i) => (
              <button key={a.id} className="new-card" style={{ animationDelay: `${i * 40}ms` }} onClick={() => newProject(a.w, a.h)}>
                <Shape w={a.w} h={a.h} size={46}>
                  <Film size={14} />
                </Shape>
                <b>{a.name}</b>
                <small>
                  {a.id} · {a.hint}
                </small>
              </button>
            ))}
          </div>

          <div className="h2row">
            <h2>Projeler</h2>
            {list && list.length > 0 && <span className="muted">{list.length} proje · sağ tıkla: yeniden adlandır, planla, durum</span>}
          </div>
          {list && list.length === 0 && (
            <div className="empty-projects">
              <Clapperboard size={26} style={{ marginBottom: 10 }} />
              <div>Henüz proje yok. Yukarıdan bir format seçerek başla.</div>
            </div>
          )}
          <div className="proj-grid">
            {list?.map((p, i) => (
              <div key={p.path} className="proj-card" style={{ animationDelay: `${i * 30}ms` }} onClick={() => openProject(p.path)} onContextMenu={(e) => menu(e, p)}>
                <div className="pthumb" style={p.thumb ? { backgroundImage: `url(${p.thumb})` } : undefined}>
                  {!p.thumb && <Film size={20} />}
                  {p.plannedDate && <span className="pdate">{dayLabel(p.plannedDate)}</span>}
                </div>
                <button className="icon-btn sm pdel" title="Seçenekler" onClick={(e) => menu(e, p)}>
                  <MoreHorizontal size={14} />
                </button>
                <div className="pname">
                  {p.name} <StatusChip s={p.status} />
                </div>
                <div className="pmeta">
                  {timeAgo(p.updatedAt)}
                  {p.duration ? ` · ${formatDuration(p.duration)}` : ''}
                  {p.width ? ` · ${p.width}×${p.height}` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {editing && <PlanEditor p={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}
