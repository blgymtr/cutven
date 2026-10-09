import { useMemo, useState } from 'react';
import { Gauge, Mic, FileText, Activity } from 'lucide-react';
import { useStore, edit, set } from '../store';
import { PACES, videoTempo, scriptStats, readTime, rateFor, paceOf, analyzeSpeech, advice } from '../lib/tempo';
import { clipEnvelope } from '../lib/audiotools';
import { clipDur, formatDuration, projectDuration } from '../lib/util';
import { Segmented } from './ui';

export function usePaceTarget() {
  const project = useStore((s) => s.project);
  const runtime = useStore((s) => s.runtime);
  return useMemo(() => (project ? videoTempo(project) : null), [project, runtime]);
}

function PaceBar({ rate, target }: { rate: number; target: [number, number] }) {
  // 3 … 7 syl/s scale
  const x = (v: number) => `${((Math.min(7, Math.max(3, v)) - 3) / 4) * 100}%`;
  return (
    <div className="pace-bar">
      <div className="pace-target" style={{ left: x(target[0]), width: `calc(${x(target[1])} - ${x(target[0])})` }} />
      {rate > 0 && <div className="pace-dot" style={{ left: x(rate) }} />}
      <div className="pace-scale">
        <span>3</span>
        <span>4</span>
        <span>5</span>
        <span>6</span>
        <span>7 hece/sn</span>
      </div>
    </div>
  );
}

export default function TempoPanel() {
  const project = useStore((s) => s.project)!;
  const selection = useStore((s) => s.selection);
  const vt = usePaceTarget()!;
  const runtime = useStore((s) => s.runtime);
  const [override, setOverride] = useState<number | null>(null);
  const level = override ?? vt.level;
  const pace = PACES[Math.max(0, Math.min(3, level))];
  const target = pace.syl;
  const mid = (target[0] + target[1]) / 2;

  /* script */
  const script = project.script || '';
  const st = scriptStats(script);
  const sel = selection.length === 1 ? project.clips.find((c) => c.id === selection[0]) : undefined;
  const [span, setSpan] = useState<'all' | 'sel' | 'custom'>('all');
  const [custom, setCustom] = useState(60);
  const targetDur = span === 'sel' && sel ? clipDur(sel) : span === 'custom' ? custom : projectDuration(project) || 60;
  const need = st.syl ? rateFor(st, targetDur) : 0;
  const needPace = paceOf(need);
  const atTarget = st.syl ? readTime(st, mid) : 0;
  const wpm = (rate: number) => Math.round((rate / st.sylPerWord) * 60);

  /* recording analysis */
  const audioClips = project.clips.filter((c) => c.kind === 'audio' || (c.kind === 'video' && !c.muted));
  const voiceDefault = audioClips.find((c) => /seslendirme|kayıt/i.test(project.tracks.find((t) => t.id === c.trackId)?.name || '')) || audioClips[0];
  const [aid, setAid] = useState<string | null>(null);
  const clip = project.clips.find((c) => c.id === (aid || (sel && (sel.kind === 'audio' || sel.kind === 'video') ? sel.id : voiceDefault?.id)));
  const speech = useMemo(() => {
    if (!clip) return null;
    const env = clipEnvelope(clip);
    return env ? analyzeSpeech(env) : null;
  }, [clip, runtime]);
  const adv = speech ? advice(speech.rate, target) : null;

  return (
    <div className="tempo">
      <div className="group">
        <div className="group-head">
          <h4>
            <Gauge size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
            Videonun temposu
          </h4>
        </div>
        <div className="tempo-hero">
          <div className="tempo-level">{pace.name}</div>
          <div className="muted">{pace.hint}</div>
        </div>
        <ul className="tempo-reasons">
          {vt.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <div className="tempo-rec">
          Bu tempoda <b>{target[0]}–{target[1]} hece/sn</b> oku
          {st.words > 0 && (
            <>
              {' '}
              (≈ {wpm(target[0])}–{wpm(target[1])} kelime/dk)
            </>
          )}
          .
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <label>Tempo</label>
          <div className="chips">
            {[{ id: -1, name: 'Otomatik' }, ...PACES].map((p) => (
              <button key={p.id} className={'chip' + ((override ?? -1) === p.id ? ' on' : '')} onClick={() => setOverride(p.id === -1 ? null : p.id)}>
                {p.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="group">
        <div className="group-head">
          <h4>
            <FileText size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
            Metin / senaryo
          </h4>
          {st.words > 0 && <span className="muted">{st.words} kelime · {st.syl} hece</span>}
        </div>
        <textarea
          className="field"
          rows={5}
          placeholder="Okuyacağın metni buraya yapıştır. Uygulama süresini ve gereken okuma hızını hesaplar; Kayıt sekmesinde akan metin (prompter) olarak görünür."
          value={script}
          onChange={(e) => edit((d) => void (d.script = e.target.value), { key: 'script' })}
          spellCheck={false}
        />
        {st.syl > 0 && (
          <>
            <div className="row" style={{ marginTop: 8 }}>
              <label>Hedef süre</label>
              <Segmented
                value={span}
                onChange={setSpan}
                options={[
                  { value: 'all', label: 'Tüm video' },
                  { value: 'sel', label: 'Seçili klip', title: sel ? '' : 'Önce bir klip seç' },
                  { value: 'custom', label: 'Özel' },
                ]}
              />
            </div>
            {span === 'custom' && (
              <div className="row">
                <label>Saniye</label>
                <input className="num" style={{ width: 80 }} type="number" min={5} value={custom} onChange={(e) => setCustom(Math.max(5, +e.target.value || 5))} />
              </div>
            )}
            <div className={'tempo-verdict ' + (needPace >= 0 && Math.abs(needPace - level) <= 0 ? 'good' : Math.abs(needPace - level) === 1 ? 'ok' : 'warn')}>
              <b>
                {formatDuration(targetDur)} içinde bitirmek için {need.toFixed(1)} hece/sn ({wpm(need)} kelime/dk)
              </b>
              <span>
                {needPace < 0
                  ? 'Çok yavaş — metne ekleme yapabilir ya da sahneleri kısaltabilirsin.'
                  : needPace > 3
                    ? `Bu süreye sığmaz — metni ~%${Math.round((1 - target[1] / need) * 100)} kısalt ya da videoyu uzat.`
                    : needPace === level
                      ? 'Videonun temposuyla birebir uyumlu.'
                      : `${PACES[needPace].name} okuman gerekiyor; video ${pace.name.toLowerCase()} tempoda.`}
              </span>
              <span className="muted">Önerilen tempoda okunursa ≈ {formatDuration(atTarget)} sürer.</span>
            </div>
            <PaceBar rate={need} target={target} />
            <button className="btn sm" style={{ marginTop: 10 }} onClick={() => set({ leftTab: 'record' })}>
              <Mic size={13} /> Prompter ile kaydet
            </button>
          </>
        )}
      </div>

      <div className="group">
        <div className="group-head">
          <h4>
            <Activity size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
            Kayıt analizi
          </h4>
        </div>
        {audioClips.length === 0 ? (
          <p className="hint">Bir ses kaydı ya da sesli video ekleyince konuşma hızını burada analiz ederim.</p>
        ) : (
          <>
            <select className="field" value={clip?.id || ''} onChange={(e) => setAid(e.target.value)}>
              {audioClips.map((c) => (
                <option key={c.id} value={c.id}>
                  {project.media.find((m) => m.id === c.mediaId)?.name || 'Klip'} · {formatDuration(c.start)}
                </option>
              ))}
            </select>
            {!speech ? (
              <p className="hint">Ses dalgası hazırlanıyor…</p>
            ) : (
              <>
                <div className="stat-grid">
                  <div>
                    <b>{speech.rate.toFixed(1)}</b>
                    <span>hece/sn</span>
                  </div>
                  <div>
                    <b>{st.syl ? wpm(speech.rate) : Math.round((speech.rate / 2.6) * 60)}</b>
                    <span>kelime/dk</span>
                  </div>
                  <div>
                    <b>%{Math.round(speech.speechRatio * 100)}</b>
                    <span>konuşma</span>
                  </div>
                  <div>
                    <b>{speech.pauses}</b>
                    <span>duraklama</span>
                  </div>
                </div>
                <PaceBar rate={speech.rate} target={target} />
                <div className={'tempo-verdict ' + adv!.tone}>
                  <b>{adv!.text}</b>
                  {speech.longPauses > 0 && <span>{speech.longPauses} uzun (1 sn+) duraklama var — sağ panelden “Sessizlikleri sil” ile hızlandırabilirsin.</span>}
                  {speech.avgPause > 0 && <span className="muted">Ortalama duraklama {speech.avgPause.toFixed(2)} sn</span>}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
