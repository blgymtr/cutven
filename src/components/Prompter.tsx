import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { recorder } from '../lib/recorder';
import { PACES, analyzeSpeech, advice } from '../lib/tempo';
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
      if (p.length < 300) return;
      const s = analyzeSpeech(p.slice(-600));
      if (s.voiced > 1.2) setRate(s.rate);
    }, 700);
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
