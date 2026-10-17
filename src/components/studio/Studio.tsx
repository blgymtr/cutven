import { useEffect, useState } from 'react';
import {
  ChevronLeft, Settings, Circle, Square, Pause, Play, Radio, Camera, Plus, Trash2, ChevronUp, ChevronDown, Copy, Eye, EyeOff, Lock, Unlock,
  Monitor as MonitorIcon, AppWindow, Video, Image as ImageIcon, Type, Palette, Film, ArrowRightLeft, FolderOpen, FilePlus2, Clapperboard, Columns2,
} from 'lucide-react';
import { useStore, set, get, toast } from '../../store';
import { studio, matchAccel, addRecordingToProject } from '../../lib/studio/engine';
import {
  useStudio, sget, sset, editScene, addSource, newSource, removeSource, moveSource, updateSource, addScene, duplicateScene, removeScene, renameScene,
  moveScene, setSettings, SCENE_TEMPLATES, type SrcKind, type StudioSource, type HotkeyAction,
} from '../../lib/studio/state';
import { newProject, saveProject } from '../../lib/project';
import { importPaths } from '../../lib/media';
import { addMediaToTimeline } from '../../lib/actions';
import { basename, formatDuration } from '../../lib/util';
import { showMenu, askConfirm, Segmented } from '../ui';
import Monitor, { nudgeSelected } from './Monitor';
import SourceProps from './SourceProps';
import Mixer from './Mixer';
import StudioSettingsDialog from './StudioSettings';

const KIND_ICON: Record<SrcKind, typeof MonitorIcon> = { display: MonitorIcon, window: AppWindow, camera: Video, image: ImageIcon, text: Type, color: Palette, media: Film };

const hms = (t: number) => {
  t = Math.max(0, Math.floor(t));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
};
const size = (b: number) => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + ' MB');

/* ------------------------------------------------------------ docks */

function ScenesDock() {
  const scenes = useStudio((s) => s.scenes);
  const program = useStudio((s) => s.program);
  const preview = useStudio((s) => s.preview);
  const studioMode = useStudio((s) => s.settings.studioMode);
  const transition = useStudio((s) => s.settings.transition);
  const ms = useStudio((s) => s.settings.transitionMs);
  const [renaming, setRenaming] = useState<string | null>(null);
  const current = studioMode ? preview : program;
  return (
    <div className="st-dock">
      <div className="st-dock-head">
        <h4>Sahneler</h4>
        <span className="muted">{scenes.length}</span>
      </div>
      <div className="st-list">
        {scenes.map((sc, i) => (
          <div
            key={sc.id}
            className={'st-item' + (sc.id === current ? ' on' : '') + (sc.id === program ? ' live' : '')}
            onClick={() => studio.pickScene(sc.id)}
            onDoubleClick={() => setRenaming(sc.id)}
            title={i < 9 ? `Alt+${i + 1}` : undefined}
          >
            {renaming === sc.id ? (
              <input
                className="field"
                autoFocus
                defaultValue={sc.name}
                onBlur={(e) => {
                  if (e.target.value.trim()) renameScene(sc.id, e.target.value.trim());
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
                }}
              />
            ) : (
              <span className="grow">{sc.name}</span>
            )}
            {sc.id === program && <span className="st-onair">YAYINDA</span>}
          </div>
        ))}
      </div>
      <div className="st-dock-foot">
        <button
          className="icon-btn sm"
          title="Sahne ekle"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            showMenu(
              r.left,
              r.top - 8 - SCENE_TEMPLATES.length * 34,
              SCENE_TEMPLATES.map((t) => ({ label: t.name, icon: <Plus size={14} />, onClick: () => studio.pickScene(addScene(t.id)) })),
            );
          }}
        >
          <Plus size={14} />
        </button>
        <button className="icon-btn sm" title="Çoğalt" onClick={() => duplicateScene(current)}>
          <Copy size={13} />
        </button>
        <button
          className="icon-btn sm"
          title="Sil"
          disabled={scenes.length < 2}
          onClick={async () => {
            const sc = scenes.find((x) => x.id === current);
            if (sc && (await askConfirm(`“${sc.name}” sahnesi silinsin mi?`, { ok: 'Sil', danger: true }))) removeScene(sc.id);
          }}
        >
          <Trash2 size={13} />
        </button>
        <button className="icon-btn sm" title="Yukarı" onClick={() => moveScene(current, -1)}>
          <ChevronUp size={14} />
        </button>
        <button className="icon-btn sm" title="Aşağı" onClick={() => moveScene(current, 1)}>
          <ChevronDown size={14} />
        </button>
      </div>
      <div className="st-trans">
        <select className="field" value={transition} onChange={(e) => setSettings({ transition: e.target.value as any })} title="Sahne geçişi">
          <option value="cut">Kes</option>
          <option value="fade">Solma</option>
          <option value="slide">Kaydırma</option>
          <option value="zoom">Yakınlaşma</option>
        </select>
        {transition !== 'cut' && (
          <select className="field" value={ms} onChange={(e) => setSettings({ transitionMs: +e.target.value })} title="Süre">
            {[150, 300, 500, 800, 1200].map((v) => (
              <option key={v} value={v}>
                {v} ms
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

async function addKind(kind: SrcKind) {
  const { width: W, height: H } = sget().settings;
  if (kind === 'image' || kind === 'media') {
    const exts = kind === 'image' ? ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] : ['mp4', 'mov', 'webm', 'mkv', 'm4v'];
    const p = await window.cv.invoke<string | null>('dialog:pickFile', kind === 'image' ? 'Görsel seç' : 'Video seç', exts);
    if (!p) return;
    addSource(newSource(kind, W, H, { path: p, name: basename(p) }));
    return;
  }
  const n = editScene().sources.filter((x) => x.kind === kind).length;
  const src = newSource(kind, W, H);
  if (n) src.name += ` ${n + 1}`;
  addSource(src);
}

function SourcesDock() {
  const scene = useStudio((s) => editScene(s));
  const selected = useStudio((s) => s.selected);
  const list = [...scene.sources].reverse();
  return (
    <div className="st-dock">
      <div className="st-dock-head">
        <h4>Kaynaklar</h4>
        <span className="muted">{scene.name}</span>
      </div>
      <div className="st-list">
        {list.map((s: StudioSource) => {
          const Icon = KIND_ICON[s.kind];
          return (
            <div key={s.id} className={'st-item' + (s.id === selected ? ' on' : '') + (s.visible ? '' : ' hidden')} onClick={() => sset({ selected: s.id })}>
              <Icon size={13} />
              <span className="grow">{s.name}</span>
              <button className="icon-btn sm" title={s.visible ? 'Gizle' : 'Göster'} onClick={(e) => (e.stopPropagation(), updateSource(s.id, { visible: !s.visible }))}>
                {s.visible ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <button className="icon-btn sm" title={s.locked ? 'Kilidi aç' : 'Kilitle'} onClick={(e) => (e.stopPropagation(), updateSource(s.id, { locked: !s.locked }))}>
                {s.locked ? <Lock size={13} /> : <Unlock size={13} />}
              </button>
            </div>
          );
        })}
        {!list.length && <p className="hint" style={{ padding: 8 }}>Kaynak yok. + ile ekran, kamera, yazı… ekle.</p>}
      </div>
      <div className="st-dock-foot">
        <button
          className="icon-btn sm"
          title="Kaynak ekle"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const kinds: [SrcKind, string][] = [
              ['display', 'Ekran'],
              ['window', 'Pencere'],
              ['camera', 'Kamera'],
              ['image', 'Görsel'],
              ['media', 'Video dosyası'],
              ['text', 'Yazı'],
              ['color', 'Renk / arka plan'],
            ];
            showMenu(
              r.left,
              r.top - 8 - kinds.length * 34,
              kinds.map(([k, label]) => {
                const I = KIND_ICON[k];
                return { label, icon: <I size={14} />, onClick: () => addKind(k) };
              }),
            );
          }}
        >
          <Plus size={14} />
        </button>
        <button
          className="icon-btn sm"
          title="Sil"
          disabled={!selected}
          onClick={async () => {
            const s = scene.sources.find((x) => x.id === selected);
            if (s && (await askConfirm(`“${s.name}” kaynağı silinsin mi?`, { ok: 'Sil', danger: true }))) removeSource(s.id);
          }}
        >
          <Trash2 size={13} />
        </button>
        <button className="icon-btn sm" title="Öne getir" disabled={!selected} onClick={() => selected && moveSource(selected, 1)}>
          <ChevronUp size={14} />
        </button>
        <button className="icon-btn sm" title="Arkaya gönder" disabled={!selected} onClick={() => selected && moveSource(selected, -1)}>
          <ChevronDown size={14} />
        </button>
      </div>
    </div>
  );
}

function ControlsDock() {
  const st = useStudio((s) => s.status);
  const studioMode = useStudio((s) => s.settings.studioMode);
  const keys = useStudio((s) => s.settings.hotkeys);
  const k = (a: HotkeyAction) => (keys[a] ? ` (${keys[a]})` : '');
  const recOn = st.rec === 'recording' || st.rec === 'paused';
  return (
    <div className="st-dock st-controls">
      <div className="st-dock-head">
        <h4>Kontroller</h4>
      </div>
      <button
        className={'btn st-big ' + (st.rec === 'idle' ? 'rec' : 'stop')}
        disabled={st.rec === 'saving'}
        onClick={() => studio.toggleRecording()}
        title={'Kaydı başlat / durdur' + k('record')}
      >
        {st.rec === 'idle' ? <Circle size={14} fill="currentColor" /> : <Square size={13} fill="currentColor" />}
        {st.rec === 'idle' ? 'Kaydı başlat' : st.rec === 'countdown' ? `İptal (${st.countdown})` : st.rec === 'saving' ? 'Kaydediliyor…' : 'Kaydı durdur'}
      </button>
      <button className="btn" disabled={!recOn} onClick={() => studio.pauseRecording()} title={'Duraklat / devam' + k('pause')}>
        {st.rec === 'paused' ? <Play size={14} /> : <Pause size={14} />}
        {st.rec === 'paused' ? 'Devam et' : 'Duraklat'}
      </button>
      <button className={'btn ' + (st.stream === 'live' ? 'stop' : '')} disabled={st.stream === 'starting' || st.stream === 'stopping'} onClick={() => studio.toggleStream()} title={'Yayın' + k('stream')}>
        <Radio size={14} />
        {st.stream === 'idle' ? 'Yayını başlat' : st.stream === 'starting' ? 'Bağlanıyor…' : st.stream === 'stopping' ? 'Durduruluyor…' : 'Yayını bitir'}
      </button>
      <button className={'btn' + (studioMode ? ' on-soft' : '')} onClick={() => setSettings({ studioMode: !studioMode })} title="Önizleme ve yayın ayrı: sahneyi hazırla, Geçiş ile yayına al">
        <Columns2 size={14} /> Stüdyo modu
      </button>
      <button className="btn" onClick={() => studio.screenshot()} title={'Ekran görüntüsü (PNG)' + k('shot')}>
        <Camera size={14} /> Ekran görüntüsü
      </button>
      <button className="btn" onClick={() => sset({ settingsOpen: true })}>
        <Settings size={14} /> Ayarlar
      </button>
    </div>
  );
}

function Recordings() {
  const recs = useStudio((s) => s.recordings);
  const W = useStudio((s) => s.settings.width);
  const H = useStudio((s) => s.settings.height);
  const hasProject = useStore((s) => !!s.project);
  const editNew = async (path: string) => {
    if (get().project) await saveProject(true);
    await newProject(W, H);
    const [m] = await importPaths([path]);
    if (m) addMediaToTimeline(m, { start: 0 });
  };
  return (
    <div className="st-props">
      <div className="group">
        <div className="group-head">
          <h4>Kayıtlar</h4>
        </div>
        {!recs.length && <p className="hint">Henüz kayıt yok. Sahneni kur, “Kaydı başlat”a bas. Bitince kayıt burada görünür; tek tıkla kurguya alabilirsin.</p>}
        <div className="st-recs">
          {recs.map((r) => (
            <div key={r.path + r.at} className="st-rec">
              <div className="st-rec-name" title={r.path}>
                {basename(r.path)}
              </div>
              <div className="muted st-rec-meta">
                {new Date(r.at).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                {r.secs ? ` · ${formatDuration(r.secs)}` : ''} · {size(r.bytes)}
              </div>
              <div className="st-rec-actions">
                <button className="btn sm ghost" title="Klasörde göster" onClick={() => window.cv.invoke('shell:showItem', r.path)}>
                  <FolderOpen size={12} />
                </button>
                <button className="btn sm ghost" title="Yeni projede kurgula" onClick={() => editNew(r.path)}>
                  <Clapperboard size={12} /> Kurgula
                </button>
                {hasProject && (
                  <button
                    className="btn sm ghost"
                    title="Açık projeye ekle"
                    onClick={async () => (await addRecordingToProject(r.path)) && toast('Kayıt projeye eklendi', 'success')}
                  >
                    <FilePlus2 size={12} /> Projeye
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="group">
        <div className="group-head">
          <h4>İpuçları</h4>
        </div>
        <p className="hint">
          Önizlemede bir kaynağa tıkla: sürükleyerek taşı, köşelerden boyutlandır (Shift: serbest oran), kenarlara ve ortaya kendiliğinden yapışır (Alt: kapat). Ok tuşlarıyla kaydır,
          Delete ile sil. Sahneler arasında Alt+1…9 ile geç.
        </p>
      </div>
    </div>
  );
}

function StatusBar() {
  const st = useStudio((s) => s.status);
  const W = useStudio((s) => s.settings.width);
  const H = useStudio((s) => s.settings.height);
  const fps = useStudio((s) => s.settings.fps);
  const recOn = st.rec === 'recording' || st.rec === 'paused' || st.rec === 'saving';
  return (
    <div className="st-status">
      <span className={'st-stat rec' + (recOn ? ' on' : '') + (st.rec === 'paused' ? ' paused' : '')}>
        <i /> {st.rec === 'paused' ? 'DURAKLATILDI' : st.rec === 'saving' ? 'KAYDEDİLİYOR' : 'KAYIT'} {hms(st.recSecs)}
      </span>
      {recOn && (
        <span className="st-stat">
          {size(st.recBytes)} · {(st.recKbps / 1000).toFixed(1)} Mb/sn · {st.encoder}
        </span>
      )}
      <span className={'st-stat live' + (st.stream === 'live' ? ' on' : '')}>
        <i /> YAYIN {hms(st.streamSecs)}
        {st.stream === 'live' ? ` · ${(st.streamKbps / 1000).toFixed(1)} Mb/sn` : ''}
      </span>
      <span className="grow" />
      <span className={'st-stat' + (st.fps && st.fps < fps * 0.9 ? ' warn' : '')} title="Saniyede çizilen kare / gecikmeli kare">
        {st.fps}/{fps} fps · gecikme {st.lagged}
      </span>
      <span className={'st-stat' + (st.cpu > 80 ? ' warn' : '')}>CPU %{st.cpu.toFixed(0)}</span>
      {st.diskFree != null && <span className={'st-stat' + (st.diskFree < 5e9 ? ' warn' : '')}>Disk {size(st.diskFree)} boş</span>}
      <span className="st-stat muted">
        {W}×{H}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------ screen */

export default function Studio() {
  const studioMode = useStudio((s) => s.settings.studioMode);
  const selected = useStudio((s) => s.selected);
  const settingsOpen = useStudio((s) => s.settingsOpen);
  const transitioning = useStudio((s) => s.status.transitioning);
  const loaded = useStudio((s) => s.loaded);
  const back = useStore((s) => s.studioBack);
  const hasProject = useStore((s) => !!s.project);

  useEffect(() => {
    studio.open();
    return () => studio.close();
  }, []);

  // in-app keys: scenes (Alt+1…9), nudge / delete the selected source, hotkeys when they are not global
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const s = sget();
      if (s.settingsOpen) return;
      if (!s.settings.hotkeysGlobal) {
        for (const [a, accel] of Object.entries(s.settings.hotkeys)) {
          if (accel && matchAccel(e, accel)) {
            e.preventDefault();
            studio.hotkey(a as HotkeyAction);
            return;
          }
        }
      }
      if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
        const sc = s.scenes[+e.code.slice(5) - 1];
        if (sc) studio.pickScene(sc.id);
        e.preventDefault();
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key] && nudgeSelected(...moves[e.key])) {
        e.preventDefault();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && s.selected) {
        const src = editScene(s).sources.find((x) => x.id === s.selected);
        if (src) askConfirm(`“${src.name}” kaynağı silinsin mi?`, { ok: 'Sil', danger: true }).then((ok) => ok && removeSource(src.id));
      }
      if (e.key === 'Escape') sset({ selected: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const goBack = () => set({ screen: back === 'editor' && get().project ? 'editor' : 'start' });

  return (
    <div className="studio">
      <div className="topbar">
        <button className="icon-btn" title={back === 'editor' && hasProject ? 'Kurguya dön' : 'Ana ekran'} onClick={goBack}>
          <ChevronLeft size={18} />
        </button>
        <div className="brand">
          <Video size={16} /> Kayıt Stüdyosu
        </div>
        <span className="muted st-sub">Kayıt ve yayın sürerken kurguya geçebilirsin; kayıt arka planda devam eder.</span>
        <div className="spacer" />
        <Segmented
          value={studioMode ? 'studio' : 'simple'}
          onChange={(v) => setSettings({ studioMode: v === 'studio' })}
          options={[
            { value: 'simple', label: 'Tek ekran' },
            { value: 'studio', label: 'Stüdyo modu' },
          ]}
        />
        <button className="btn ghost" onClick={() => sset({ settingsOpen: true })}>
          <Settings size={15} /> Ayarlar
        </button>
      </div>
      <div className="st-main">
        <div className={'st-stage' + (studioMode ? ' dual' : '')}>
          {!loaded ? null : studioMode ? (
            <>
              <Monitor which="preview" editable label="ÖNİZLEME" />
              <div className="st-tcol">
                <button className="btn primary" disabled={transitioning} onClick={() => studio.transitionNow()} title="Önizlemeyi yayına al">
                  <ArrowRightLeft size={15} /> Geçiş
                </button>
              </div>
              <Monitor which="program" editable={false} label="YAYIN / KAYIT" />
            </>
          ) : (
            <Monitor which="program" editable />
          )}
        </div>
        <div className="st-side">{selected ? <SourceProps id={selected} /> : <Recordings />}</div>
      </div>
      <div className="st-docks">
        <ScenesDock />
        <SourcesDock />
        <div className="st-dock st-mixer-dock">
          <div className="st-dock-head">
            <h4>Ses mikseri</h4>
          </div>
          <Mixer />
        </div>
        <ControlsDock />
      </div>
      <StatusBar />
      {settingsOpen && <StudioSettingsDialog />}
    </div>
  );
}

/** Small "● KAYIT 00:12:34" chip shown outside the studio while it records / streams. */
export function StudioBadge() {
  const rec = useStudio((s) => s.status.rec);
  const secs = useStudio((s) => s.status.recSecs);
  const stream = useStudio((s) => s.status.stream);
  if (rec === 'idle' && stream === 'idle') return null;
  return (
    <button className="st-badge" title="Kayıt stüdyosuna dön" onClick={() => set({ screen: 'studio' })}>
      <i />
      {rec !== 'idle' ? `KAYIT ${hms(secs)}` : 'YAYINDA'}
      {rec !== 'idle' && stream !== 'idle' ? ' · YAYINDA' : ''}
    </button>
  );
}
