import { memo, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Upload, Download, Wand2, Scissors, AudioLines, X, Check } from 'lucide-react';
import { useStore, get } from '../store';
import { engine } from '../lib/engine';
import { addCaption, updateCaption, deleteCaption, setCaptionStyle, replaceCaptions, splitCaption, parseSubs, toSrt, toVtt, styleOf, captionsFromScript, activeCaption, CAPTION_PRESETS } from '../lib/captions';
import { autoCaptions, cancelAutoCaptions, useAsr, ASR_MODELS, ASR_LANGS, ASR_SOURCES, type AsrModel, type AsrSource } from '../lib/autocaptions';
import { FONTS } from '../lib/text';
import { formatDuration } from '../lib/util';
import { Slider, Toggle, ColorInput, askConfirm } from './ui';
import { toast } from '../store';
import type { Caption } from '../types';

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, '0')}`;
};
const parseTime = (v: string) => {
  const m = v.trim().match(/^(?:(\d+):)?(\d+(?:[.,]\d+)?)$/);
  if (!m) return NaN;
  return (+(m[1] || 0)) * 60 + parseFloat(m[2].replace(',', '.'));
};
const mb = (b?: number) => (b ? Math.round(b / 1e6) : 0);

function TimeBox({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [txt, setTxt] = useState<string | null>(null);
  return (
    <input
      className="num cap-time"
      value={txt ?? fmt(value)}
      onFocus={(e) => {
        setTxt(fmt(value));
        requestAnimationFrame(() => e.target.select());
      }}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => {
        const v = parseTime(txt || '');
        if (!isNaN(v)) onChange(Math.max(0, v));
        setTxt(null);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** split button: subscribes to the playhead on its own, so the list does not re-render every frame */
function SplitButton({ c }: { c: Caption }) {
  const ok = useStore((s) => s.time > c.start + 0.1 && s.time < c.end - 0.1);
  return (
    <button className="icon-btn sm" title="İmleçten böl" disabled={!ok} onClick={() => splitCaption(c.id)}>
      <Scissors size={12} />
    </button>
  );
}

const CaptionRow = memo(function CaptionRow({ c, on }: { c: Caption; on: boolean }) {
  return (
    <div data-id={c.id} className={'cap-row' + (on ? ' on' : '')} onPointerDown={() => !engine.playing && Math.abs(get().time - c.start) > 1e-3 && engine.seek(c.start + 0.001)}>
      <div className="cap-times">
        <TimeBox value={c.start} onChange={(v) => updateCaption(c.id, { start: v })} />
        <TimeBox value={c.end} onChange={(v) => updateCaption(c.id, { end: v })} />
      </div>
      <textarea
        className="field cap-text"
        rows={Math.min(3, Math.max(1, Math.ceil(c.text.length / 28)))}
        value={c.text}
        onChange={(e) => updateCaption(c.id, { text: e.target.value }, 'text')}
      />
      <div className="cap-actions">
        <SplitButton c={c} />
        <button className="icon-btn sm" title="Sil" onClick={() => deleteCaption(c.id)}>
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
});

interface AsrPrefs {
  model: AsrModel;
  language: string;
  source: AsrSource;
}
const DEFAULT_PREFS: AsrPrefs = { model: 'small', language: 'turkish', source: 'speech' };

function AutoCaptions({ hasCaps }: { hasCaps: boolean }) {
  const asr = useAsr();
  const selection = useStore((s) => s.selection);
  const [prefs, setPrefs] = useState<AsrPrefs>(DEFAULT_PREFS);
  const [ready, setReady] = useState<Record<string, boolean>>({});

  useEffect(() => {
    window.cv
      .invoke<{ asr?: Partial<AsrPrefs> }>('settings:get')
      .then((s) => s.asr && setPrefs((p) => ({ ...p, ...s.asr })))
      .catch(() => {});
    window.cv.invoke<Record<string, boolean>>('asr:models').then(setReady).catch(() => {});
  }, [asr.running]);

  const change = (patch: Partial<AsrPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    window.cv.invoke('settings:set', { asr: next });
  };

  const run = async () => {
    if (hasCaps && !(await askConfirm('Mevcut altyazılar değiştirilsin mi?', { text: 'Konuşmadan yeni altyazılar oluşturulacak.', ok: 'Oluştur' }))) return;
    if (engine.playing) engine.pause();
    const clipId = selection.length === 1 ? selection[0] : undefined;
    const r = await autoCaptions({ ...prefs, clipId });
    if (!r.ok) {
      if (!r.cancelled) toast(r.error || 'Altyazı oluşturulamadı', 'error');
      return;
    }
    if (!r.captions.length) {
      toast('Konuşma bulunamadı — kaynağı ya da dili kontrol et', 'error');
      return;
    }
    replaceCaptions(r.captions);
    toast(`${r.captions.length} altyazı oluşturuldu. Satırları aşağıdan düzeltebilirsin.`, 'success');
  };

  const model = ASR_MODELS.find((m) => m.id === prefs.model) || ASR_MODELS[1];
  const pct = Math.round((asr.progress || 0) * 100);
  const status =
    asr.phase === 'extract'
      ? 'Ses hazırlanıyor…'
      : asr.phase === 'download'
        ? `Model indiriliyor (yalnızca ilk sefer)… %${pct}${asr.total ? ` · ${mb(asr.loaded)} / ${mb(asr.total)} MB` : ''}`
        : asr.phase === 'load'
          ? 'Model yükleniyor…'
          : asr.phase === 'transcribe'
            ? `Konuşma yazıya dökülüyor… %${pct}`
            : '';

  return (
    <div className="group">
      <div className="group-head">
        <h4>Videodan otomatik altyazı</h4>
      </div>
      <div className="row">
        <label>Dil</label>
        <select className="field" value={prefs.language} disabled={asr.running} onChange={(e) => change({ language: e.target.value })}>
          {ASR_LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>Model</label>
        <select className="field" value={prefs.model} disabled={asr.running} onChange={(e) => change({ model: e.target.value as AsrModel })}>
          {ASR_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} · {ready[m.id] ? 'indirildi' : m.size}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>Kaynak</label>
        <select className="field" value={prefs.source} disabled={asr.running} onChange={(e) => change({ source: e.target.value as AsrSource })}>
          {ASR_SOURCES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      {asr.running ? (
        <div className="asr-run">
          <div className="row" style={{ gap: 8 }}>
            <span className="grow">{status}</span>
            <button className="btn sm ghost" onClick={cancelAutoCaptions}>
              <X size={13} /> İptal
            </button>
          </div>
          <div className="progress">
            <i style={{ width: `${asr.phase === 'extract' || asr.phase === 'load' ? 100 : pct}%`, opacity: asr.phase === 'extract' || asr.phase === 'load' ? 0.35 : 1 }} />
          </div>
          {asr.text && <p className="hint asr-last">“{asr.text}”</p>}
        </div>
      ) : (
        <button className="btn sm primary" style={{ width: '100%', marginTop: 4 }} onClick={run}>
          <AudioLines size={13} /> Konuşmadan altyazı oluştur
        </button>
      )}
      <p className="hint">
        {ready[prefs.model] ? (
          <>
            <Check size={11} style={{ verticalAlign: -1 }} /> {model.name} model hazır — tamamen çevrimdışı çalışır.
          </>
        ) : (
          `${model.hint}. Model ilk kullanımda bir kez indirilir (${model.size}, internet gerekir); sonra çevrimdışı çalışır.`
        )}
      </p>
    </div>
  );
}

export default function CaptionsPanel() {
  const caps = useStore((s) => s.project?.captions) || [];
  const project = useStore((s) => s.project)!;
  // only the id of the line under the playhead (re-render on change, not on every frame)
  const activeId = useStore((s) => (s.project ? activeCaption(s.project, s.time)?.id : undefined));
  const st = styleOf(project);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeId || !engine.playing) return;
    listRef.current?.querySelector(`[data-id="${activeId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const importSubs = async () => {
    const path = await window.cv.invoke<string | null>('dialog:pickFile', 'Altyazı dosyası', ['srt', 'vtt']);
    if (!path) return;
    const txt = await window.cv.invoke<string>('file:readText', path);
    const parsed = parseSubs(txt);
    if (!parsed.length) return toast('Bu dosyada altyazı bulunamadı', 'error');
    if (caps.length && !(await askConfirm('Mevcut altyazılar değiştirilsin mi?', { text: `${parsed.length} satır içe aktarılacak.`, ok: 'Değiştir' }))) return;
    replaceCaptions(parsed);
    toast(`${parsed.length} altyazı içe aktarıldı`, 'success');
  };
  const exportSubs = async (ext: 'srt' | 'vtt') => {
    const out = await window.cv.invoke<string | null>('dialog:saveText', project.name, ext);
    if (!out) return;
    await window.cv.invoke('file:writeText', out, ext === 'srt' ? toSrt(caps) : toVtt(caps));
    toast('Altyazı kaydedildi', 'success');
  };
  const fromScript = async () => {
    if (!project.script?.trim()) return toast('Önce Tempo panelinde senaryonu yaz ya da yapıştır', 'error');
    if (caps.length && !(await askConfirm('Altyazılar senaryodan yeniden oluşturulsun mu?', { text: 'Mevcut altyazılar silinir.', ok: 'Oluştur' }))) return;
    const n = captionsFromScript();
    toast(n ? `${n} altyazı konuşmaya göre yerleştirildi` : 'Senaryoda konuşmayla eşleşen cümle çıkmadı', n ? 'success' : 'error');
  };

  return (
    <div className="captions">
      <AutoCaptions hasCaps={caps.length > 0} />

      <div className="tool-list" style={{ marginTop: 12 }}>
        <button className="btn sm" onClick={() => addCaption()}>
          <Plus size={13} /> İmlece altyazı ekle
        </button>
        <button className="btn sm" onClick={fromScript} title="Senaryodaki cümleleri konuşmanın olduğu yerlere otomatik yerleştirir">
          <Wand2 size={13} /> Senaryodan yerleştir
        </button>
        <button className="btn sm" onClick={importSubs}>
          <Upload size={13} /> SRT / VTT içe aktar
        </button>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm grow" disabled={!caps.length} onClick={() => exportSubs('srt')}>
            <Download size={13} /> SRT
          </button>
          <button className="btn sm grow" disabled={!caps.length} onClick={() => exportSubs('vtt')}>
            <Download size={13} /> VTT
          </button>
        </div>
      </div>

      <div className="group" style={{ marginTop: 12 }}>
        <div className="group-head">
          <h4>Stil</h4>
        </div>
        <div className="chips" style={{ marginBottom: 8 }}>
          {CAPTION_PRESETS.map((pr) => (
            <button key={pr.name} className="chip" onClick={() => setCaptionStyle(pr.s, 'preset')}>
              {pr.name}
            </button>
          ))}
        </div>
        <div className="row">
          <label>Yazı tipi</label>
          <select className="field" value={st.font} onChange={(e) => setCaptionStyle({ font: e.target.value }, 'font')}>
            {FONTS.map((f) => (
              <option key={f.family} value={f.family}>
                {f.family}
              </option>
            ))}
          </select>
        </div>
        <Slider label="Boyut" value={st.size} min={20} max={140} step={1} def={54} onChange={(v) => setCaptionStyle({ size: v }, 'size')} />
        <Slider label="Konum" value={st.y} min={0.08} max={0.95} step={0.01} def={0.86} mult={100} unit="%" onChange={(v) => setCaptionStyle({ y: v }, 'y')} />
        <div className="row">
          <label>Renk</label>
          <ColorInput value={st.color} onChange={(v) => setCaptionStyle({ color: v }, 'color')} />
          <span className="muted grow" />
          <label style={{ width: 'auto' }}>BÜYÜK</label>
          <Toggle on={st.uppercase} onChange={(v) => setCaptionStyle({ uppercase: v }, 'up')} />
        </div>
        <div className="row">
          <label>Arka kutu</label>
          <Toggle on={st.bg} onChange={(v) => setCaptionStyle({ bg: v }, 'bg')} />
          <span className="muted grow" />
          <label style={{ width: 'auto' }}>Kontur</label>
          <Toggle on={st.stroke} onChange={(v) => setCaptionStyle({ stroke: v }, 'stroke')} />
        </div>
        {st.bg && <Slider label="Kutu opaklık" value={st.bgOpacity} min={0} max={1} step={0.01} def={0.55} mult={100} unit="%" onChange={(v) => setCaptionStyle({ bgOpacity: v }, 'bgo')} />}
        <div className="row">
          <label>Videoya göm</label>
          <Toggle on={st.burn} onChange={(v) => setCaptionStyle({ burn: v }, 'burn')} />
        </div>
        <p className="hint">{st.burn ? 'Altyazılar videonun üstüne yazılır.' : 'Altyazılar videoya yazılmaz; dışa aktarırken yanına aynı adla .srt dosyası konur (YouTube’a yükleyebilirsin).'}</p>
      </div>

      <div className="group-head" style={{ marginTop: 14 }}>
        <h4>
          Satırlar <span className="muted">· {caps.length}</span>
        </h4>
        {caps.length > 0 && (
          <button
            className="btn sm ghost"
            onClick={async () => (await askConfirm('Tüm altyazılar silinsin mi?', { ok: 'Sil', danger: true })) && replaceCaptions([])}
          >
            Tümünü sil
          </button>
        )}
      </div>
      {!caps.length && <p className="hint">Henüz altyazı yok. Konuşmadan otomatik oluştur, imlece ekle, senaryondan yerleştir ya da bir SRT dosyası içe aktar.</p>}
      <div className="cap-list" ref={listRef}>
        {caps.map((c) => (
          <CaptionRow key={c.id} c={c} on={activeId === c.id} />
        ))}
      </div>
      {caps.length > 0 && <p className="hint">Toplam {formatDuration(caps.reduce((a, c) => a + c.end - c.start, 0))} altyazı. Zaman kutularına 1:23.5 gibi yaz.</p>}
    </div>
  );
}
