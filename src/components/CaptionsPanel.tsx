import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Upload, Download, Wand2, Scissors } from 'lucide-react';
import { useStore } from '../store';
import { engine } from '../lib/engine';
import { addCaption, updateCaption, deleteCaption, setCaptionStyle, replaceCaptions, splitCaption, parseSubs, toSrt, toVtt, styleOf, captionsFromScript, CAPTION_PRESETS } from '../lib/captions';
import { FONTS } from '../lib/text';
import { formatDuration } from '../lib/util';
import { Slider, Toggle, ColorInput, askConfirm } from './ui';
import { toast } from '../store';

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

export default function CaptionsPanel() {
  const project = useStore((s) => s.project)!;
  const time = useStore((s) => s.time);
  const caps = project.captions || [];
  const st = styleOf(project);
  const active = caps.find((c) => time >= c.start && time < c.end);
  const listRef = useRef<HTMLDivElement>(null);
  const [follow] = useState(true);

  useEffect(() => {
    if (!follow || !active || !engine.playing) return;
    listRef.current?.querySelector(`[data-id="${active.id}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active?.id]);

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
    toast(n ? `${n} altyazı konuşmaya göre yerleştirildi` : 'Senaryodan altyazı çıkmadı', n ? 'success' : 'error');
  };

  return (
    <div className="captions">
      <div className="tool-list">
        <button className="btn sm primary" onClick={() => addCaption()}>
          <Plus size={13} /> İmlece altyazı ekle
        </button>
        <button className="btn sm" onClick={fromScript} title="Senaryodaki cümleleri konuşmanın olduğu yerlere otomatik yerleştirir">
          <Wand2 size={13} /> Senaryodan otomatik
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
      {!caps.length && <p className="hint">Henüz altyazı yok. İmlece ekle, senaryondan otomatik oluştur ya da bir SRT dosyası içe aktar.</p>}
      <div className="cap-list" ref={listRef}>
        {caps.map((c) => (
          <div key={c.id} data-id={c.id} className={'cap-row' + (active?.id === c.id ? ' on' : '')} onPointerDown={() => !engine.playing && time !== c.start && engine.seek(c.start + 0.001)}>
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
              <button className="icon-btn sm" title="İmleçten böl" disabled={!(time > c.start + 0.1 && time < c.end - 0.1)} onClick={() => splitCaption(c.id)}>
                <Scissors size={12} />
              </button>
              <button className="icon-btn sm" title="Sil" onClick={() => deleteCaption(c.id)}>
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {caps.length > 0 && <p className="hint">Toplam {formatDuration(caps.reduce((a, c) => a + c.end - c.start, 0))} altyazı. Zaman kutularına 1:23.5 gibi yaz.</p>}
    </div>
  );
}
