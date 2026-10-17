import { useEffect, useState } from 'react';
import { X, FolderOpen, Eye, EyeOff } from 'lucide-react';
import { accelFrom } from '../../lib/studio/engine';
import { useStudio, sset, setSettings, videoKbps, HOTKEY_NAMES, type HotkeyAction, type StudioSettings } from '../../lib/studio/state';
import { Segmented, Toggle } from '../ui';
import { toast } from '../../store';

type Tab = 'out' | 'video' | 'audio' | 'stream' | 'keys' | 'general';
const TABS: [Tab, string][] = [
  ['out', 'Çıkış'],
  ['video', 'Görüntü'],
  ['audio', 'Ses'],
  ['stream', 'Yayın'],
  ['keys', 'Kısayollar'],
  ['general', 'Genel'],
];

const RES = [
  { w: 1920, h: 1080, label: '1920 × 1080 (Full HD)' },
  { w: 1280, h: 720, label: '1280 × 720 (HD)' },
  { w: 2560, h: 1440, label: '2560 × 1440 (2K)' },
  { w: 3840, h: 2160, label: '3840 × 2160 (4K)' },
  { w: 1080, h: 1920, label: '1080 × 1920 (dikey · Shorts)' },
];

function HotkeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [listening, setListening] = useState(false);
  return (
    <div className="row" style={{ gap: 6 }}>
      <input
        className={'field st-key' + (listening ? ' listening' : '')}
        readOnly
        value={listening ? 'Tuşa bas…' : value || '—'}
        onFocus={() => setListening(true)}
        onBlur={() => setListening(false)}
        onKeyDown={(e) => {
          e.preventDefault();
          if (e.key === 'Escape') return (e.target as HTMLInputElement).blur();
          if (e.key === 'Backspace' || e.key === 'Delete') {
            onChange('');
            return (e.target as HTMLInputElement).blur();
          }
          const a = accelFrom(e.nativeEvent);
          if (a) {
            onChange(a);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {value && (
        <button className="icon-btn sm" title="Kaldır" onClick={() => onChange('')}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

export default function StudioSettingsDialog() {
  const s = useStudio((x) => x.settings);
  const busy = useStudio((x) => x.status.rec !== 'idle' || x.status.stream !== 'idle');
  const [tab, setTab] = useState<Tab>('out');
  const [defDir, setDefDir] = useState('');
  const [cfg, setCfg] = useState<{ url: string; hasKey: boolean; masked: string } | null>(null);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const close = () => sset({ settingsOpen: false });
  const up = (p: Partial<StudioSettings>) => setSettings(p);

  useEffect(() => {
    window.cv.invoke<string>('studio:defaultDir').then(setDefDir);
    window.cv.invoke<{ url: string; hasKey: boolean; masked: string }>('live:config').then((c) => {
      setCfg(c);
      setUrl(c.url);
    });
  }, []);

  const kbps = videoKbps(s);
  const gbPerHour = ((kbps + s.audioKbps) * 3600) / 8 / 1e6;

  return (
    <div className="modal-back" onPointerDown={close}>
      <div className="modal st-settings" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Stüdyo ayarları</h3>
          <button className="icon-btn" onClick={close}>
            <X size={16} />
          </button>
        </div>
        <div className="st-set-body">
          <div className="st-set-tabs">
            {TABS.map(([id, name]) => (
              <button key={id} className={'tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
                {name}
              </button>
            ))}
          </div>
          <div className="st-set-pane">
            {tab === 'out' && (
              <>
                <div className="row">
                  <label>Kayıt klasörü</label>
                  <span className="grow st-path" title={s.folder || defDir}>
                    {s.folder || defDir}
                  </span>
                  <button
                    className="btn sm"
                    onClick={async () => {
                      const d = await window.cv.invoke<string | null>('dialog:openFolder', 'Kayıt klasörü');
                      if (d) up({ folder: d });
                    }}
                  >
                    <FolderOpen size={13} /> Değiştir
                  </button>
                  {s.folder && (
                    <button className="btn sm ghost" onClick={() => up({ folder: '' })}>
                      Varsayılan
                    </button>
                  )}
                </div>
                <div className="row">
                  <label>Dosya biçimi</label>
                  <Segmented
                    value={s.format}
                    onChange={(v) => up({ format: v })}
                    options={[
                      { value: 'mp4', label: 'MP4' },
                      { value: 'mkv', label: 'MKV' },
                    ]}
                  />
                </div>
                <p className="hint">
                  Kayıt sırasında dosya her zaman çökmeye dayanıklı biçimde yazılır; bitince {s.format === 'mp4' ? 'her yerde açılan MP4’e' : 'MKV’ye'} çevrilir. Elektrik kesilirse kayıt
                  bir sonraki açılışta kurtarılır.
                </p>
                <div className="row">
                  <label>Kodlayıcı</label>
                  <Segmented
                    value={s.codec}
                    onChange={(v) => up({ codec: v })}
                    options={[
                      { value: 'h264', label: 'H.264' },
                      { value: 'vp9', label: 'VP9' },
                      { value: 'av1', label: 'AV1' },
                    ]}
                  />
                </div>
                <p className="hint">H.264 önerilir: mümkünse ekran kartıyla kodlanır, işlemciyi az yorar ve her programda açılır. Bilgisayar desteklemiyorsa uygun olan otomatik seçilir.</p>
                <div className="row">
                  <label>Kalite</label>
                  <Segmented
                    value={s.quality}
                    onChange={(v) => up({ quality: v })}
                    options={[
                      { value: 'high', label: 'Yüksek' },
                      { value: 'std', label: 'Standart' },
                      { value: 'low', label: 'Küçük dosya' },
                      { value: 'custom', label: 'Özel' },
                    ]}
                  />
                </div>
                {s.quality === 'custom' && (
                  <div className="row">
                    <label>Bit hızı</label>
                    <input className="field" type="number" min={500} max={100000} step={500} value={s.kbps} onChange={(e) => up({ kbps: Math.max(500, +e.target.value || 500) })} />
                    <span className="muted">kbps</span>
                  </div>
                )}
                <p className="hint">
                  Görüntü ~{(kbps / 1000).toFixed(1)} Mb/sn · saatte yaklaşık {gbPerHour.toFixed(1)} GB
                </p>
              </>
            )}
            {tab === 'video' && (
              <>
                {busy && <p className="hint">Kayıt ya da yayın sürerken değiştirilemez.</p>}
                <div className="row">
                  <label>Tuval</label>
                  <select
                    className="field"
                    disabled={busy}
                    value={`${s.width}x${s.height}`}
                    onChange={(e) => {
                      const [w, h] = e.target.value.split('x').map(Number);
                      up({ width: w, height: h });
                    }}
                  >
                    {RES.map((r) => (
                      <option key={r.label} value={`${r.w}x${r.h}`}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="row">
                  <label>Kare hızı</label>
                  <Segmented
                    value={s.fps}
                    onChange={(v) => !busy && up({ fps: v })}
                    options={[
                      { value: 30, label: '30 fps' },
                      { value: 60, label: '60 fps' },
                    ]}
                  />
                </div>
                <p className="hint">60 fps oyun ve hızlı ekran hareketleri için; konuşma videolarında 30 fps yeterli ve daha hafiftir. Tuval değişince sahneler orantılı yeniden yerleşir.</p>
              </>
            )}
            {tab === 'audio' && (
              <>
                <div className="row">
                  <label>Ses bit hızı</label>
                  <Segmented
                    value={s.audioKbps}
                    onChange={(v) => up({ audioKbps: v })}
                    options={[128, 160, 192, 256, 320].map((v) => ({ value: v, label: String(v) }))}
                  />
                  <span className="muted">kbps</span>
                </div>
                <p className="hint">Mikrofon, masaüstü sesi ve diğer kanalların ayarları (gürültü engelleme, gürültü kapısı, kompresör, gecikme) mikserdeki ⚙ düğmesinde.</p>
              </>
            )}
            {tab === 'stream' && (
              <>
                <div className="row">
                  <label>Sunucu</label>
                  <input className="field grow" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="rtmp://a.rtmp.youtube.com/live2" />
                </div>
                <div className="row">
                  <label>Yayın anahtarı</label>
                  <input className="field grow" type={showKey ? 'text' : 'password'} value={key} onChange={(e) => setKey(e.target.value)} placeholder={cfg?.hasKey ? cfg.masked : 'YouTube Studio › Canlı yayın'} />
                  <button className="icon-btn sm" onClick={() => setShowKey(!showKey)}>
                    {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                  <button
                    className="btn sm"
                    onClick={async () => {
                      await window.cv.invoke('live:saveConfig', url, key || null);
                      setKey('');
                      const c = await window.cv.invoke<{ url: string; hasKey: boolean; masked: string }>('live:config');
                      setCfg(c);
                      toast('Yayın ayarları kaydedildi', 'success');
                    }}
                  >
                    Kaydet
                  </button>
                </div>
                <div className="row">
                  <label>Bit hızı</label>
                  <Segmented
                    value={s.streamKbps}
                    onChange={(v) => up({ streamKbps: v })}
                    options={[2500, 4500, 6000, 9000].map((v) => ({ value: v, label: `${v / 1000} Mb/sn` }))}
                  />
                </div>
                <p className="hint">YouTube için 1080p30: 4,5 Mb/sn, 1080p60: 6–9 Mb/sn. Anahtar bilgisayarında şifreli saklanır. Kayıt ve yayın aynı anda yapılabilir.</p>
              </>
            )}
            {tab === 'keys' && (
              <>
                <div className="row">
                  <label>Her yerde çalışsın</label>
                  <Toggle on={s.hotkeysGlobal} onChange={(v) => up({ hotkeysGlobal: v })} />
                </div>
                <p className="hint">{s.hotkeysGlobal ? 'Kısayollar Cutven arka plandayken de (oyun, tarayıcı…) çalışır; stüdyo açıkken etkindir.' : 'Kısayollar yalnızca stüdyo penceresi öndeyken çalışır.'}</p>
                {(Object.keys(HOTKEY_NAMES) as HotkeyAction[]).map((a) => (
                  <div className="row" key={a}>
                    <label style={{ width: 190 }}>{HOTKEY_NAMES[a]}</label>
                    <HotkeyInput value={s.hotkeys[a]} onChange={(v) => up({ hotkeys: { ...s.hotkeys, [a]: v } })} />
                  </div>
                ))}
              </>
            )}
            {tab === 'general' && (
              <>
                <div className="row">
                  <label>Geri sayım</label>
                  <Segmented
                    value={s.countdown}
                    onChange={(v) => up({ countdown: v })}
                    options={[0, 3, 5, 10].map((v) => ({ value: v, label: v ? `${v} sn` : 'Yok' }))}
                  />
                </div>
                <div className="row">
                  <label>Kayıtta pencereyi küçült</label>
                  <Toggle on={s.minimize} onChange={(v) => up({ minimize: v })} />
                </div>
                <div className="row">
                  <label>Cutven’i kayıtta gizle</label>
                  <Toggle on={s.hideSelf} onChange={(v) => up({ hideSelf: v })} />
                </div>
                <p className="hint">Açıkken Cutven penceresi ekran yakalamalarında görünmez (sonsuz ayna oluşmaz). Cutven’in kendisini kaydetmek istiyorsan kapat.</p>
                <div className="row">
                  <label>Bitince projeye ekle</label>
                  <Toggle on={s.addToProject} onChange={(v) => up({ addToProject: v })} />
                </div>
                <p className="hint">Bir proje açıksa kayıt, bitince zaman çizelgesine yeni bir ize eklenir.</p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
