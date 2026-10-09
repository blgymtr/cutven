import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { recorder } from '../lib/recorder';
import { PACES, analyzeSpeech, advice, takeReport } from '../lib/tempo';
import { cutSilences } from '../lib/audiotools';
import type { Take } from '../store';
import { usePaceTarget } from './TempoPanel';

const VOWELS = /[aeıioöuüâîûAEIİOÖUÜÂÎÛ]/g;

/** Scrolling script that advances at the target pace while recording. */
export function Prompter() {
  const script = useStore((s) => s.project?.script || '');
  const status = useStore((s) => s.rec.status);
  const elapsed = useStore((s) => s.rec.elapsed);
  const vt = usePaceTarget();
  const pace = PACES[Math.max(0, Math.min(3, vt?.level ?? 1))];
  const rate = (pace.syl[0] + pace.syl[1]) / 2;
  const [on, setOn] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const words = useMemo(() => {
    let acc = 0;
    return script.split(/(\s+)/).map((w) => {
      const syl = (w.match(VOWELS) || []).length + (/[.!?…]$/.test(w) ? 1.4 : /[,;:]$/.test(w) ? 0.6 : 0);
      const start = acc;
      acc += syl;
      return { w, start, end: acc };
    });
  }, [script]);
  const live = status === 'recording' || status === 'paused';
  const pos = live ? elapsed * rate : -1;
  const idx = words.findIndex((x) => x.end > pos && x.w.trim());

  useEffect(() => {
    const el = boxRef.current?.querySelector('.pw.now') as HTMLElement | null;
    if (el && boxRef.current) boxRef.current.scrollTo({ top: el.offsetTop - boxRef.current.clientHeight * 0.35, behavior: 'smooth' });
  }, [idx]);

  if (!script.trim()) return null;
  return (
    <div className="prompter-wrap">
      <div className="row" style={{ justifyContent: 'space-between', minHeight: 0 }}>
        <span className="muted" style={{ fontSize: 11.5 }}>
          Prompter · {pace.name.toLowerCase()} tempo ({rate.toFixed(1)} hece/sn)
        </span>
        <button className="btn sm ghost" onClick={() => setOn(!on)}>
          {on ? 'Gizle' : 'Göster'}
        </button>
      </div>
      {on && (
        <div className="prompter" ref={boxRef}>
          {words.map((x, i) =>
            x.w.trim() ? (
              <span key={i} className={'pw' + (i === idx ? ' now' : live && x.end <= pos ? ' done' : '')}>
                {x.w}
              </span>
            ) : (
              <span key={i}>{x.w.includes('\n') ? <br /> : ' '}</span>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Live speaking-rate feedback from the microphone (last ~6 s). */
export function LivePace() {
  const status = useStore((s) => s.rec.status);
  const vt = usePaceTarget();
  const target = PACES[Math.max(0, Math.min(3, vt?.level ?? 1))].syl;
  const [rate, setRate] = useState(0);
  useEffect(() => {
    if (status !== 'recording') return;
    const t = setInterval(() => {
      const p = recorder.livePeaks;
      if (p.length < 250) return;
      // last 8 s, needs at least ~1.5 s of actual speech
      const s = analyzeSpeech(p.slice(-800));
      setRate(s.voiced > 1.5 && s.rate ? s.rate : 0);
    }, 500);
    return () => clearInterval(t);
  }, [status]);
  if (status !== 'recording' && status !== 'paused') return null;
  const adv = rate ? advice(rate, target) : null;
  return (
    <div className={'live-pace ' + (adv?.tone || 'muted')}>
      <b>{rate ? rate.toFixed(1) : '–'}</b>
      <span>hece/sn</span>
      <em>{adv ? adv.text.split(' (')[0] : 'Konuşmaya başla…'}</em>
    </div>
  );
}

/** Result card for a finished take: verdict, per-section pace strip, tips and quick fixes. */
export function TakeReport({ take, compact }: { take: Take; compact?: boolean }) {
  const vt = usePaceTarget();
  const pace = PACES[Math.max(0, Math.min(3, vt?.level ?? 1))];
  const target = pace.syl;
  const rep = useMemo(() => takeReport(take.peaks, target), [take.peaks, target[0], target[1]]);
  const clipOnTimeline = useStore((s) => !!take.clipId && !!s.project?.clips.some((c) => c.id === take.clipId));
  if (compact)
    return (
      <span className={'take-verdict ' + rep.verdict.tone} title={rep.tips.join('\n')}>
        {rep.stats.rate ? `${rep.stats.rate.toFixed(1)} hece/sn · ${rep.verdict.title}` : rep.verdict.title}
      </span>
    );
  const color = (r: number) => (!r ? 'transparent' : r > target[1] + 0.4 ? '#ff4d5e' : r < target[0] - 0.4 ? '#5b8cff' : r > target[1] || r < target[0] ? '#ffcf4a' : '#3ddc97');
  const total = Math.max(0.1, take.duration);
  return (
    <div className={'take-report ' + rep.verdict.tone}>
      <div className="tr-head">
        <b>{rep.verdict.title}</b>
        <span>
          {rep.stats.rate ? rep.stats.rate.toFixed(1) : '–'} <small>hece/sn</small>
        </span>
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>
        Hedef: {pace.name.toLowerCase()} tempo, {target[0]}–{target[1]} hece/sn
      </div>
      <div className="tr-strip" title="Kırmızı: hızlı · Mavi: yavaş · Yeşil: iyi">
        {rep.segs.map((g, i) => (
          <i
            key={i}
            style={{ left: `${(g.t0 / total) * 100}%`, width: `${((g.t1 - g.t0) / total) * 100}%`, background: color(g.rate) }}
            title={g.speaking ? `${g.t0.toFixed(0)}–${g.t1.toFixed(0)} sn: ${g.rate.toFixed(1)} hece/sn` : 'Sessiz'}
          />
        ))}
      </div>
      <div className="tr-legend">
        <span><i style={{ background: '#3ddc97' }} />iyi</span>
        <span><i style={{ background: '#ff4d5e' }} />hızlı</span>
        <span><i style={{ background: '#5b8cff' }} />yavaş</span>
      </div>
      {rep.tips.length > 0 && (
        <ul className="tr-tips">
          {rep.tips.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      <div className="row" style={{ gap: 6, minHeight: 0, marginTop: 6 }}>
        {rep.verdict.tone !== 'good' && rep.verdict.tone !== 'muted' && (
          <button className="btn sm" onClick={() => recorder.retake()}>
            Baştan al
          </button>
        )}
        {rep.stats.longPauses > 0 && clipOnTimeline && (
          <button className="btn sm primary" onClick={() => cutSilences(take.clipId!, { thresholdDb: -40, minSilence: 0.7, padding: 0.15 }, true)}>
            Uzun duraklamaları sil
          </button>
        )}
      </div>
    </div>
  );
}
