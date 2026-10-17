import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { useStore, get, set, undo, redo, select, toast } from './store';
import { engine } from './lib/engine';
import { importPaths, pickAndImport, importClipboardImage } from './lib/media';
import { openProject, saveProject, saveProjectAs } from './lib/project';
import { splitAt, deleteSelected, copySelected, paste, duplicateSelected, addMarker, seekRelative, jumpEdge, addMediaToTimeline } from './lib/actions';
import { projectDuration } from './lib/util';
import { recorder } from './lib/recorder';
import { toggleKeyAtPlayhead } from './lib/keyframes';
import StartScreen from './components/StartScreen';
import TopBar from './components/TopBar';
import MediaPanel from './components/MediaPanel';
import Preview from './components/Preview';
import Inspector from './components/Inspector';
import Timeline from './components/Timeline';
import ExportDialog from './components/ExportDialog';
import ThumbDialog from './components/ThumbDialog';
import CaptureDialog from './components/CaptureDialog';
import Studio from './components/studio/Studio';
import { Boundary, ConfirmHost, MenuHost } from './components/ui';
import { ShortcutsDialog, SourceMonitor, VersionsDialog } from './components/ProDialogs';
import { markIn, markOut, clearInOut, markSelection, lift, extract, rippleTrim, addEditAll, placeSource } from './lib/proedit';

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={'toast ' + (t.kind || '')}>
          <i style={{ display: 'flex' }}>
            {t.kind === 'success' ? <CheckCircle2 size={15} /> : t.kind === 'error' ? <AlertCircle size={15} /> : <Info size={15} />}
          </i>
          {t.text}
        </div>
      ))}
    </div>
  );
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = get();
      if (s.screen !== 'editor' || !s.project || s.exportOpen || s.thumbOpen || s.captureOpen || s.source || s.shortcutsOpen || s.versionsOpen) return;
      const tgt = e.target as HTMLElement;
      const typing = tgt && (tgt.tagName === 'TEXTAREA' || (tgt.tagName === 'INPUT' && (tgt as HTMLInputElement).type !== 'range') || tgt.isContentEditable);
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (ctrl && k === 's') {
        e.preventDefault();
        if (e.shiftKey) saveProjectAs();
        else saveProject(true).then(() => toast('Kaydedildi', 'success'));
        return;
      }
      if (ctrl && k === 'e') {
        e.preventDefault();
        set({ exportOpen: true });
        return;
      }
      if (ctrl && k === 'i') {
        e.preventDefault();
        pickAndImport();
        return;
      }
      if (typing) return;
      const fps = s.project.fps;
      if (ctrl && k === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (ctrl && k === 'y') {
        e.preventDefault();
        redo();
      } else if (ctrl && k === 'c') copySelected();
      else if (ctrl && k === 'v') {
        if (s.clipboard.length) paste();
        else importClipboardImage().then((m) => m && addMediaToTimeline(m, { start: get().time, newTrack: true }));
      }
      else if (ctrl && k === 'd') {
        e.preventDefault();
        duplicateSelected();
      } else if (ctrl && k === 'a') {
        e.preventDefault();
        select(s.project.clips.map((c) => c.id));
      } else if (ctrl && k === 'b') splitAt();
      else if (ctrl && k === 'k') {
        e.preventDefault();
        addEditAll();
      } else if (ctrl && e.shiftKey && k === 'x') {
        e.preventDefault();
        clearInOut();
      } else if (ctrl) return;
      else if (k === 'j') engine.shuttle(-1);
      else if (k === 'l') engine.shuttle(1);
      else if (k === 'k' && engine.playing) engine.pause();
      else if (k === 'i') markIn();
      else if (k === 'o') markOut();
      else if (k === 'x') markSelection();
      else if (k === ';') lift();
      else if (k === "'") extract();
      else if (k === 'q') rippleTrim('start');
      else if (k === 'w') rippleTrim('end');
      else if (k === 'v') set({ tool: 'select' });
      else if (k === 'b') set({ tool: 'ripple' });
      else if (k === 'y') set({ tool: 'slip' });
      else if (k === 't') set({ tool: 'rate' });
      else if (k === '?' || (e.shiftKey && e.code === 'Slash')) set({ shortcutsOpen: true });
      else if ((k === ',' || k === '.') && s.source) {
        const m = s.project.media.find((x) => x.id === s.source!.mediaId);
        if (m) placeSource(m, s.source, k === ',' ? 'insert' : 'overwrite');
      }
      else if (e.code === 'Space') {
        e.preventDefault();
        const rs = s.rec.status;
        if (rs === 'recording') recorder.pause();
        else if (rs === 'paused') recorder.resume();
        else if (rs === 'idle') engine.toggle();
      } else if (k === 's') splitAt();
      else if (k === 'delete' || k === 'backspace') deleteSelected(e.shiftKey);
      else if (k === 'm') addMarker();
      else if (k === 'k') {
        const c = s.selection.length === 1 ? s.project.clips.find((x) => x.id === s.selection[0]) : undefined;
        if (c && (c.kind === 'audio' || c.kind === 'video')) toggleKeyAtPlayhead(c.id);
        else toast('Önce bir ses ya da video klibi seç');
      }
      else if (k === 'r') {
        set({ leftTab: 'record' });
        recorder.toggle();
      }
      else if (k === 'n') set({ snapping: !s.snapping });
      else if (k === 'escape') select([]);
      else if (k === 'arrowleft') {
        e.preventDefault();
        seekRelative(e.shiftKey ? -1 : -1 / fps);
      } else if (k === 'arrowright') {
        e.preventDefault();
        seekRelative(e.shiftKey ? 1 : 1 / fps);
      } else if (k === 'arrowup') {
        e.preventDefault();
        jumpEdge(-1);
      } else if (k === 'arrowdown') {
        e.preventDefault();
        jumpEdge(1);
      } else if (k === 'home') engine.seek(0);
      else if (k === 'end') engine.seek(projectDuration(s.project));
      else if (k === '+' || k === '=') window.dispatchEvent(new CustomEvent('cutven:zoom', { detail: 1.4 }));
      else if (k === '-') window.dispatchEvent(new CustomEvent('cutven:zoom', { detail: 1 / 1.4 }));
      else if (k === 'z' && e.shiftKey) (document.querySelector('[title^="Tümünü sığdır"]') as HTMLElement)?.click();
    };
    // buttons must not keep focus, otherwise Space would also 'click' them
    const blurButtons = () => {
      const a = document.activeElement;
      if (a instanceof HTMLButtonElement) a.blur();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerup', blurButtons);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerup', blurButtons);
    };
  }, []);
}

function Editor() {
  const exportOpen = useStore((s) => s.exportOpen);
  const thumbOpen = useStore((s) => s.thumbOpen);
  const captureOpen = useStore((s) => s.captureOpen);
  const [tlh, setTlh] = useState(() => {
    try {
      return parseInt(localStorage.getItem('cutven.tlh') || '', 10) || 320;
    } catch {
      return 320;
    }
  });
  const [dragSplit, setDragSplit] = useState(false);
  const [fileOver, setFileOver] = useState(false);
  const depth = useRef(0);

  const onSplit = (e: React.PointerEvent) => {
    const y0 = e.clientY;
    const h0 = tlh;
    setDragSplit(true);
    const move = (ev: PointerEvent) => {
      const h = Math.max(180, Math.min(window.innerHeight - 260, h0 - (ev.clientY - y0)));
      setTlh(h);
    };
    const up = () => {
      setDragSplit(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setTlh((h) => {
        try {
          localStorage.setItem('cutven.tlh', String(h));
        } catch {}
        return h;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className="app"
      style={{ ['--tl-h' as any]: `${tlh}px` }}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        depth.current++;
        setFileOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setFileOver(false);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        depth.current = 0;
        setFileOver(false);
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        const paths = [...e.dataTransfer.files].map((f) => window.cv.pathForFile(f)).filter(Boolean);
        if (paths.length) {
          set({ leftTab: 'media' });
          importPaths(paths);
        }
      }}
      onDropCapture={() => {
        depth.current = 0;
        setFileOver(false);
      }}
    >
      <TopBar />
      <div className="workspace">
        <Boundary name="Medya paneli">
          <MediaPanel />
        </Boundary>
        <Boundary name="Önizleme">
          <Preview />
        </Boundary>
        <Boundary name="Özellikler">
          <Inspector />
        </Boundary>
      </div>
      <div className={'splitter' + (dragSplit ? ' drag' : '')} onPointerDown={onSplit} />
      <Boundary name="Zaman çizelgesi">
        <Timeline />
      </Boundary>
      {exportOpen && <ExportDialog />}
      {thumbOpen && <ThumbDialog />}
      {captureOpen && <CaptureDialog />}
      <ShortcutsDialog />
      <SourceMonitor />
      <VersionsDialog />
      {fileOver && <div className="file-drop">Bırak — medyaya eklensin (zaman çizelgesine bırakırsan oraya eklenir)</div>}
    </div>
  );
}

export default function App() {
  const screen = useStore((s) => s.screen);
  useShortcuts();
  useEffect(() => {
    const open = async (f: string | null) => {
      if (!f) return;
      if (get().project) await saveProject(true);
      openProject(f);
    };
    window.cv.invoke<string | null>('app:pendingOpen').then(open);
    return window.cv.on('app:open-file', open);
  }, []);
  return (
    <>
      {screen === 'start' ? (
        <StartScreen />
      ) : screen === 'studio' ? (
        <Boundary name="Kayıt stüdyosu">
          <Studio />
        </Boundary>
      ) : (
        <Editor />
      )}
      <Toasts />
      <MenuHost />
      <ConfirmHost />
    </>
  );
}
