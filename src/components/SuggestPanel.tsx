import { useMemo, useState } from 'react';
import { CheckCircle2, AlertTriangle, Lightbulb, Crosshair, Wand2 } from 'lucide-react';
import { useStore, toast } from '../store';
import { suggestions, readiness, type Suggestion } from '../lib/suggest';
import { engine } from '../lib/engine';

export default function SuggestPanel() {
  const project = useStore((s) => s.project)!;
  const runtime = useStore((s) => s.runtime);
  const [busy, setBusy] = useState<string | null>(null);
  const list = useMemo(() => suggestions(project), [project, runtime]);
  const score = readiness(list);
  const fixable = list.filter((s) => s.fix && s.level !== 'good');

  const run = async (s: Suggestion) => {
    if (!s.fix) return;
    setBusy(s.id);
    try {
      await s.fix();
    } finally {
      setBusy(null);
    }
  };

  const color = score >= 80 ? 'var(--ok)' : score >= 55 ? '#ffcf4a' : 'var(--danger)';
  const R = 30;
  const C = 2 * Math.PI * R;
  return (
    <div className="suggest">
      <div className="score-card">
        <svg width="76" height="76" viewBox="0 0 76 76">
          <circle cx="38" cy="38" r={R} stroke="var(--line-2)" strokeWidth="7" fill="none" />
          <circle cx="38" cy="38" r={R} stroke={color} strokeWidth="7" fill="none" strokeLinecap="round" strokeDasharray={`${(C * score) / 100} ${C}`} transform="rotate(-90 38 38)" />
          <text x="38" y="44" textAnchor="middle" fontSize="19" fontWeight="700" fill="currentColor">
            {score}
          </text>
        </svg>
        <div>
          <b>Yayına hazırlık</b>
          <div className="muted">
            {list.filter((s) => s.level === 'fix').length} önemli · {list.filter((s) => s.level === 'tip').length} öneri
          </div>
          {fixable.length > 1 && (
            <button
              className="btn sm primary"
              style={{ marginTop: 8 }}
              onClick={async () => {
                const safe = fixable.filter((s) => s.level === 'fix' && !['thumb', 'meta'].includes(s.id));
                for (const s of safe) await run(s);
                toast(`${safe.length} düzeltme uygulandı`, 'success');
              }}
            >
              <Wand2 size={13} /> Önemlileri düzelt
            </button>
          )}
        </div>
      </div>
      <div className="sg-list">
        {list.map((s) => (
          <div key={s.id} className={'sg ' + s.level}>
            <div className="sg-ico">{s.level === 'fix' ? <AlertTriangle size={14} /> : s.level === 'tip' ? <Lightbulb size={14} /> : <CheckCircle2 size={14} />}</div>
            <div className="sg-body">
              <div className="sg-top">
                <span className="sg-area">{s.area}</span>
                <b>{s.title}</b>
              </div>
              <p>{s.detail}</p>
              {(s.fix || s.at != null) && (
                <div className="sg-actions">
                  {s.fix && (
                    <button className="btn sm" disabled={busy === s.id} onClick={() => run(s)}>
                      {s.fixLabel || 'Düzelt'}
                    </button>
                  )}
                  {s.at != null && (
                    <button className="icon-btn sm" title="Bu ana git" onClick={() => engine.seek(s.at!)}>
                      <Crosshair size={13} />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="hint">Öneriler projeyi değiştirdikçe güncellenir. Her düzeltme geri alınabilir (Ctrl+Z).</p>
    </div>
  );
}
