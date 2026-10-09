import { useEffect, useReducer, useRef, useState } from 'react';
import { Radio, Square, Monitor, AppWindow, Video, KeyRound, Eye, EyeOff, Save } from 'lucide-react';
import { live, type LiveMode, type LiveQuality } from '../lib/live';
import { Segmented, Toggle } from './ui';
import { toast } from '../store';

interface Source {
  id: string;
  name: string;
  thumb: string;
  screen: boolean;
}

const fmt = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function LivePanel() {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => live.on(force), []);
  const o = live.opts;
  const [sources, setSources] = useState<Source[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [cfg, setCfg] = useState<{ url: string; hasKey: boolean; masked: string }>({ url: '', hasKey: false, masked: '' });
  const [key, setKey] = useState('');
  const [url, setUrl] = useState('');
  const [show, setShow] = useState(false);
  const holder = useRef<HTMLDivElement>(null);

  const loadCfg = () =>
    window.cv.invoke<typeof cfg>('live:config').then((c) => {
      setCfg(c);
      setUrl(c.url);
    });
  useEffect(() => {
    loadCfg();
    window.cv.invoke<Source[]>('screen:sources').then((l) => {
      setSources(l);
      if (!live.opts.sourceId) live.set({ sourceId: l.find((x) => x.screen)?.id || l[0]?.id || '' });
    });
    navigator.mediaDevices.enumerateDevices().then((d) => setCams(d.filter((x) => x.kind === 'videoinput')));
  }, []);

  // show the live scene canvas inside the panel
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    live.canvas.className = 'live-canvas';
    el.appendChild(live.canvas);
    return () => {
      if (live.canvas.parentElement === el) el.removeChild(live.canvas);
    };
  }, []);

  const isLive = live.status === 'live' || live.status === 'stopping';

  return (
    <div className="live">
      <div className={'live-stage' + (live.status === 'idle' ? ' idle' : '')} ref={holder}>
        {live.status === 'idle' && (
          <div className="live-placeholder">
            <Radio size={22} />
            <span>Önizlemeyi başlat</span>
          </div>
        )}
        {isLive && (
          <div className="live-badge">
            <i /> CANLI {fmt(live.stats?.secs || 0)}
          </div>
        )}
      </div>
      {isLive && live.stats && (
        <div className="live-stats">
          <span>{Math.round(live.stats.kbps)} kbps</span>
          <span>{live.stats.fps.toFixed(0)} fps</span>
          <span className={live.stats.speed && live.stats.speed < 0.95 ? 'bad' : ''}>hız {live.stats.speed ? live.stats.speed.toFixed(2) + '×' : '–'}</span>
        </div>
      )}
      {live.error && <div className="rec-error">{live.error}</div>}

      <div className="row" style={{ gap: 6, marginTop: 10 }}>
        {!isLive ? (
          <>
            <button className="btn" onClick={() => (live.status === 'idle' ? live.preview() : live.release())}>
              {live.status === 'idle' ? <Eye size={14} /> : <EyeOff size={14} />} {live.status === 'idle' ? 'Önizle' : 'Önizlemeyi kapat'}
            </button>
            <button
              className="btn primary live-go"
              disabled={!cfg.hasKey}
              title={cfg.hasKey ? '' : 'Önce yayın anahtarını gir'}
              onClick={() => live.start()}
            >
              <Radio size={14} /> Yayını başlat
            </button>
          </>
        ) : (
          <button className="btn danger" disabled={live.status === 'stopping'} onClick={() => live.stop()}>
            <Square size={13} fill="currentColor" /> {live.status === 'stopping' ? 'Bitiriliyor…' : 'Yayını bitir'}
          </button>
        )}
      </div>

      <div className="group" style={{ marginTop: 14 }}>
        <div className="group-head">
          <h4>Sahne</h4>
        </div>
        <div className="row">
          <label>Kaynak</label>
          <Segmented<LiveMode>
            value={o.mode}
            onChange={(v) => live.set({ mode: v })}
            options={[
              { value: 'screen', label: 'Ekran' },
              { value: 'camera', label: 'Kamera' },
              { value: 'both', label: 'İkisi' },
            ]}
          />
        </div>
        {o.mode !== 'camera' && (
          <div className="live-sources">
            {sources.map((s) => (
              <button key={s.id} className={'src' + (o.sourceId === s.id ? ' on' : '')} disabled={isLive} onClick={() => live.set({ sourceId: s.id })} title={s.name}>
                <img src={s.thumb} />
                <span>
                  {s.screen ? <Monitor size={11} /> : <AppWindow size={11} />} {s.name}
                </span>
              </button>
            ))}
          </div>
        )}
        {o.mode !== 'screen' && cams.length > 1 && (
          <div className="row">
            <label>Kamera</label>
            <select className="field" value={o.camId} onChange={(e) => live.set({ camId: e.target.value })}>
              <option value="">Varsayılan</option>
              {cams.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label || 'Kamera'}
                </option>
              ))}
            </select>
          </div>
        )}
        {o.mode === 'both' && (
          <div className="row">
            <label>Kamera yeri</label>
            <Segmented
              value={o.camCorner}
              onChange={(v) => live.set({ camCorner: v })}
              options={[
                { value: 'tl', label: '↖' },
                { value: 'tr', label: '↗' },
                { value: 'bl', label: '↙' },
                { value: 'br', label: '↘' },
              ]}
            />
          </div>
        )}
        <div className="row">
          <label>Başlık</label>
          <input className="field" value={o.title} placeholder="ör. Canlı soru-cevap" onChange={(e) => live.set({ title: e.target.value })} />
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-2)' }}>Mikrofon</span>
          <Toggle on={o.mic} onChange={(v) => live.set({ mic: v })} />
        </div>
        {o.mode !== 'camera' && (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-2)' }}>Bilgisayar sesi</span>
            <Toggle on={o.sys} onChange={(v) => live.set({ sys: v })} />
          </div>
        )}
        <div className="row">
          <label>Kalite</label>
          <Segmented<LiveQuality>
            value={o.quality}
            onChange={(v) => !isLive && live.set({ quality: v })}
            options={[
              { value: '720', label: '720p' },
              { value: '1080', label: '1080p' },
              { value: '1080_60', label: '1080p60' },
            ]}
          />
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-2)' }}>Aynı anda bilgisayara kaydet</span>
          <Toggle on={o.record} onChange={(v) => live.set({ record: v })} />
        </div>
      </div>

      <div className="group">
        <div className="group-head">
          <h4>
            <KeyRound size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
            Yayın anahtarı
          </h4>
          {cfg.hasKey && <span className="muted">{cfg.masked}</span>}
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          YouTube Studio → <b>Oluştur</b> → <b>Canlı yayın başlat</b> → <b>Yayın</b> sekmesindeki “Yayın anahtarı”nı kopyalayıp buraya yapıştır. Anahtar bilgisayarında şifreli saklanır.
        </p>
        <div className="row">
          <input className="field" type={show ? 'text' : 'password'} value={key} placeholder={cfg.hasKey ? 'Kayıtlı — değiştirmek için yeni anahtar yapıştır' : 'xxxx-xxxx-xxxx-xxxx-xxxx'} onChange={(e) => setKey(e.target.value)} spellCheck={false} />
          <button className="icon-btn sm" onClick={() => setShow(!show)} title="Göster/gizle">
            {show ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        </div>
        <details>
          <summary className="hint" style={{ cursor: 'pointer' }}>
            Başka platform (Twitch, Kick…) / sunucu adresi
          </summary>
          <input className="field" style={{ marginTop: 6 }} value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        </details>
        <button
          className="btn sm"
          style={{ marginTop: 8 }}
          onClick={async () => {
            await window.cv.invoke('live:saveConfig', url, key || null);
            setKey('');
            await loadCfg();
            toast('Yayın ayarları kaydedildi', 'success');
          }}
        >
          <Save size={13} /> Kaydet
        </button>
      </div>
      <p className="hint">
        <Video size={11} style={{ verticalAlign: -1 }} /> Yayın sırasında Cutven’i küçültebilirsin; sahne arka planda çizilmeye devam eder. Stabil yayın için yükleme hızın kalite değerinin en az 1,5 katı olmalı.
      </p>
    </div>
  );
}
