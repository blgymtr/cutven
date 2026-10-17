import { useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX, Settings2, Plus, Trash2, Headphones, Mic, MonitorSpeaker, Film } from 'lucide-react';
import { studio } from '../../lib/studio/engine';
import { useStudio, sset, updateAudio, newAudio, type AudioIn } from '../../lib/studio/state';
import { Slider, Toggle, askConfirm } from '../ui';

const MIN_DB = -60;
const pct = (db: number) => Math.max(0, Math.min(100, ((db - MIN_DB) / -MIN_DB) * 100));

function Channel({ a, meter }: { a: AudioIn; meter: (el: HTMLDivElement | null) => void }) {
  const [open, setOpen] = useState(false);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const live = useStudio(() => studio.hasInput(a));
  useEffect(() => {
    if (open && a.kind === 'mic') navigator.mediaDevices.enumerateDevices().then((d) => setMics(d.filter((x) => x.kind === 'audioinput')));
  }, [open, a.kind]);
  const Icon = a.kind === 'desktop' ? MonitorSpeaker : a.kind === 'mic' ? Mic : Film;
  return (
    <div className={'st-ch' + (a.muted ? ' muted' : '') + (live ? '' : ' off')}>
      <div className="st-ch-top">
        <Icon size={13} />
        <span className="st-ch-name" title={a.name}>
          {a.name}
        </span>
        <span className="st-ch-db">{a.volume <= MIN_DB ? '−∞' : (a.volume > 0 ? '+' : '') + a.volume.toFixed(1)} dB</span>
        <button className={'icon-btn sm' + (a.monitor ? ' on' : '')} title={a.monitor ? 'Dinleme açık' : 'Hoparlörden dinle'} onClick={() => updateAudio(a.id, { monitor: !a.monitor })}>
          <Headphones size={13} />
        </button>
        <button className={'icon-btn sm' + (a.muted ? ' on danger' : '')} title={a.muted ? 'Sesi aç' : 'Sustur'} onClick={() => updateAudio(a.id, { muted: !a.muted })}>
          {a.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
        <button className={'icon-btn sm' + (open ? ' on' : '')} title="Filtreler ve ayarlar" onClick={() => setOpen(!open)}>
          <Settings2 size={13} />
        </button>
      </div>
      <div className="st-meter" ref={meter}>
        <i className="lvl" />
        <i className="pk" />
        {a.gate.on && <i className="thr" style={{ left: `${pct(a.gate.threshold)}%` }} title="Gürültü kapısı eşiği" />}
      </div>
      <input
        type="range"
        className="st-fader"
        min={MIN_DB}
        max={6}
        step={0.1}
        value={a.volume}
        onChange={(e) => updateAudio(a.id, { volume: parseFloat(e.target.value) })}
        onDoubleClick={() => updateAudio(a.id, { volume: 0 })}
        title="Çift tık: 0 dB"
      />
      {!live && <div className="st-ch-note">{a.kind === 'source' ? 'Kaynak açıldığında gelir' : 'Bağlanıyor… (cihazı kontrol et)'}</div>}
      {open && (
        <div className="st-ch-more">
          <div className="row">
            <label>Ad</label>
            <input className="field" value={a.name} onChange={(e) => updateAudio(a.id, { name: e.target.value })} />
          </div>
          {a.kind === 'mic' && (
            <>
              <div className="row">
                <label>Cihaz</label>
                <select className="field" value={a.device || ''} onChange={(e) => updateAudio(a.id, { device: e.target.value || undefined })}>
                  <option value="">Varsayılan mikrofon</option>
                  {mics
                    .filter((m) => m.deviceId !== 'default' && m.deviceId !== 'communications')
                    .map((m, i) => (
                      <option key={m.deviceId || i} value={m.deviceId}>
                        {m.label || `Mikrofon ${i + 1}`}
                      </option>
                    ))}
                </select>
              </div>
              <div className="row">
                <label>Gürültü engelleme</label>
                <Toggle on={a.suppress} onChange={(v) => updateAudio(a.id, { suppress: v })} />
              </div>
            </>
          )}
          <div className="row">
            <label>Gürültü kapısı</label>
            <Toggle on={a.gate.on} onChange={(v) => updateAudio(a.id, { gate: { ...a.gate, on: v } })} />
          </div>
          {a.gate.on && (
            <Slider label="Eşik" value={a.gate.threshold} min={-80} max={-10} step={1} def={-45} unit="dB" onChange={(v) => updateAudio(a.id, { gate: { ...a.gate, threshold: v } })} />
          )}
          <div className="row">
            <label>Kompresör</label>
            <Toggle on={a.comp} onChange={(v) => updateAudio(a.id, { comp: v })} />
          </div>
          <Slider label="Kazanç" value={a.gain} min={0} max={20} step={0.5} def={0} digits={1} unit="dB" onChange={(v) => updateAudio(a.id, { gain: v })} />
          <Slider label="Gecikme" value={a.offset} min={0} max={1000} step={10} def={0} unit="ms" onChange={(v) => updateAudio(a.id, { offset: v })} />
          {a.kind === 'desktop' && a.monitor && <p className="hint">Masaüstü sesini dinlemek yankı yapar (hoparlörden çıkan ses yeniden kaydedilir). Kulaklık kullan.</p>}
          {a.kind !== 'source' && (
            <button
              className="btn sm ghost danger"
              onClick={async () => (await askConfirm(`“${a.name}” kanalı kaldırılsın mı?`, { ok: 'Kaldır', danger: true })) && sset((s) => ({ audio: s.audio.filter((x) => x.id !== a.id) }))}
            >
              <Trash2 size={13} /> Kanalı kaldır
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function Mixer() {
  const audio = useStudio((s) => s.audio);
  const meters = useRef(new Map<string, HTMLDivElement>());
  const peaks = useRef(new Map<string, { v: number; t: number }>());

  // meters are painted straight into the DOM at display rate (no React re-render)
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const lv = studio.levels();
      const now = performance.now();
      for (const [id, el] of meters.current) {
        const l = lv[id];
        const db = l ? l.peak : -120;
        const pk = peaks.current.get(id);
        const hold = !pk || db > pk.v || now - pk.t > 1200 ? { v: db, t: now } : pk;
        peaks.current.set(id, hold);
        // .lvl covers the unlit part of the fixed-scale gradient, from the right
        (el.children[0] as HTMLElement).style.width = 100 - pct(l ? l.rms + 3 : -120) + '%';
        (el.children[1] as HTMLElement).style.left = pct(hold.v) + '%';
        el.classList.toggle('clip', hold.v > -1);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="st-mixer">
      {audio.map((a) => (
        <Channel
          key={a.id}
          a={a}
          meter={(el) => {
            if (el) meters.current.set(a.id, el);
            else meters.current.delete(a.id);
          }}
        />
      ))}
      <div className="st-add-row">
        <button className="btn sm ghost" onClick={() => sset((s) => ({ audio: [...s.audio, newAudio('mic', `Mikrofon ${s.audio.filter((x) => x.kind === 'mic').length + 1}`)] }))}>
          <Plus size={13} /> Mikrofon ekle
        </button>
        {!audio.some((a) => a.kind === 'desktop') && (
          <button className="btn sm ghost" onClick={() => sset((s) => ({ audio: [newAudio('desktop', 'Masaüstü sesi', { suppress: false }), ...s.audio] }))}>
            <Plus size={13} /> Masaüstü sesi
          </button>
        )}
      </div>
    </div>
  );
}
