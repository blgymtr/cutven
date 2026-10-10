import { useState } from 'react';
import { Undo2, Redo2, Download, ChevronLeft, Camera, FolderInput, Save, CalendarDays, Smartphone, History, FileOutput, Keyboard } from 'lucide-react';
import { convertToShorts } from '../lib/convert';
import { set, undo, redo, useStore, edit, toast } from '../store';
import { exportInterchange } from './ProDialogs';
import { ExportChip } from './ExportDialog';
import { closeProject, saveProject, saveProjectAs, renameProject } from '../lib/project';
import { STATUSES, statusOf, dayLabel } from '../lib/plan';
import { engine } from '../lib/engine';
import { showMenu } from './ui';

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: size, height: size }}>
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none">
        <path d="M6 3.8v8.1L17.6 12 6 3.8Z" fill="#1b0a03" />
        <path d="M6 13.6v6.6l9.4-6.6H6Z" fill="#1b0a03" opacity="0.55" />
      </svg>
    </span>
  );
}

export async function saveFrame() {
  const p = useStore.getState().project;
  if (!p) return;
  if (engine.playing) engine.pause();
  const path = await window.cv.invoke<string | null>('dialog:saveImage', `${p.name} - kare`);
  if (!path) return;
  const data = await engine.capture(p.width, 'image/png');
  if (!data) return toast('Kare alınamadı', 'error');
  await window.cv.invoke('file:writeDataUrl', path, data);
  toast('Kare kaydedildi — küçük resim için hazır', 'success');
}

function PlanChip() {
  const date = useStore((s) => s.project?.plannedDate);
  const status = useStore((s) => s.project?.status);
  const st = statusOf(status);
  return (
    <div className="plan-chip" title="Yayın planı">
      <CalendarDays size={13} />
      <input type="date" value={date || ''} onChange={(e) => edit((d) => void (d.plannedDate = e.target.value || undefined))} />
      <span className="plan-day">{date ? dayLabel(date) : 'Plan yok'}</span>
      <button
        className="plan-status"
        style={st ? { color: st.color } : undefined}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          showMenu(r.left, r.bottom + 6, STATUSES.map((s) => ({ label: s.name, icon: <span className="dot-ico" style={{ background: s.color }} />, onClick: () => edit((d) => void (d.status = s.id)) })));
        }}
      >
        {st ? st.name : 'Durum'}
      </button>
    </div>
  );
}

export default function TopBar() {
  const name = useStore((s) => s.project?.name || '');
  const saveState = useStore((s) => s.saveState);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <div className="topbar">
      <button className="icon-btn" title="Projeler" onClick={() => closeProject()}>
        <ChevronLeft size={18} />
      </button>
      <div className="brand">
        <Logo />
      </div>
      <input
        className="proj-name"
        value={draft ?? name}
        size={Math.max(8, (draft ?? name).length)}
        onFocus={() => setDraft(name)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const v = (draft || '').trim();
          if (v && v !== name) renameProject(v).then(() => toast(`Proje adı: ${v}`, "success"));
          setDraft(null);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        spellCheck={false}
      />
      <span className={'save-state' + (saveState !== 'saved' ? ' dirty' : '')}>
        <i />
        {saveState === 'saved' ? 'Kaydedildi' : saveState === 'saving' ? 'Kaydediliyor…' : 'Değişiklikler var'}
      </span>
      <div className="sep" />
      <button
        className="btn ghost sm"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          showMenu(r.left, r.bottom + 6, [
            { label: 'Kaydet', icon: <Save size={14} />, k: 'Ctrl+S', onClick: () => saveProject(true).then(() => toast('Kaydedildi', 'success')) },
            { label: 'Farklı kaydet…', icon: <FolderInput size={14} />, k: 'Ctrl+Shift+S', onClick: () => saveProjectAs() },
            { label: 'Shorts’a çevir (9:16 kopya)', icon: <Smartphone size={14} />, onClick: () => convertToShorts() },
            { label: 'Sürüm geçmişi…', icon: <History size={14} />, onClick: () => set({ versionsOpen: true }) },
            { sep: true },
            { label: 'Premiere / Resolve için XML', icon: <FileOutput size={14} />, onClick: () => exportInterchange('xml') },
            { label: 'EDL (CMX3600)', icon: <FileOutput size={14} />, onClick: () => exportInterchange('edl') },
            { label: 'OpenTimelineIO (.otio)', icon: <FileOutput size={14} />, onClick: () => exportInterchange('otio') },
            { label: 'Klavye kısayolları', icon: <Keyboard size={14} />, k: '?', onClick: () => set({ shortcutsOpen: true }) },
            { sep: true },
            { label: 'Projeler', icon: <ChevronLeft size={14} />, onClick: () => closeProject() },
          ]);
        }}
      >
        Dosya
      </button>
      <PlanChip />
      <div className="spacer" />
      <ExportChip />
      <button className="icon-btn" title="Geri al (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
        <Undo2 size={16} />
      </button>
      <button className="icon-btn" title="Yinele (Ctrl+Y)" disabled={!canRedo} onClick={redo}>
        <Redo2 size={16} />
      </button>
      <div className="sep" />
      <button className="btn ghost" title="Geçerli kareyi PNG olarak kaydet" onClick={saveFrame}>
        <Camera size={15} /> Kare kaydet
      </button>
      <button className="btn primary" onClick={() => set({ exportOpen: true })} title="Dışa aktar (Ctrl+E)">
        <Download size={15} /> Dışa aktar
      </button>
    </div>
  );
}
