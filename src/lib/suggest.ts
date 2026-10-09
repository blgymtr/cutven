import { edit, get, set } from '../store';
import type { Clip, Project } from '../types';
import { clipDur, clipEnd, projectDuration, formatDuration } from './util';
import { clipEnvelope, cutSilences, toDb } from './audiotools';
import { analyzeSpeech, videoTempo, PACES } from './tempo';
import { addText, addMarker } from './actions';
import { insertTemplate } from './introoutro';
import { autoDuck } from './keyframes';
import { addSfx } from './sfx';
import { mediaOf, clipBox } from './render';
import { measureText } from './text';

/**
 * "What could be better?" — quick checks over the project with one-click fixes.
 * Each suggestion is cheap to compute and only uses local analysis.
 */

export type Level = 'fix' | 'tip' | 'good';

export interface Suggestion {
  id: string;
  level: Level;
  area: 'Kanca' | 'Kurgu' | 'Ses' | 'Metin' | 'YouTube' | 'Görsel';
  title: string;
  detail: string;
  fixLabel?: string;
  fix?: () => void | Promise<unknown>;
  /** timeline time to jump to */
  at?: number;
}

const isVoice = (p: Project, c: Clip) => {
  const tr = p.tracks.find((t) => t.id === c.trackId);
  return !!tr && /seslendirme|kayıt|vokal/i.test(tr.name);
};
const mainTrackId = (p: Project) => {
  const v = p.tracks.filter((t) => t.type === 'visual');
  return v[v.length - 1]?.id;
};

export function suggestions(p: Project): Suggestion[] {
  const out: Suggestion[] = [];
  const dur = projectDuration(p);
  if (!p.clips.length) {
    return [{ id: 'empty', level: 'tip', area: 'Kurgu', title: 'Önce medya ekle', detail: 'Videolarını Medya sekmesinden içe aktar ya da pencereye sürükle.', fixLabel: 'Medyaya git', fix: () => set({ leftTab: 'media' }) }];
  }
  const main = mainTrackId(p);
  const mainClips = p.clips.filter((c) => c.trackId === main).sort((a, b) => a.start - b.start);
  const texts = p.clips.filter((c) => c.kind === 'text');
  const vertical = p.height > p.width;

  /* --- hook: the first seconds decide whether people stay */
  const early = p.clips.filter((c) => c.kind !== 'audio' && c.start < 5);
  const earlyText = texts.some((c) => c.start < 4);
  const earlyCuts = mainClips.filter((c) => c.start > 0.1 && c.start < 6).length;
  const earlyFx = early.some((c) => c.vfx?.length || (c.tIn && c.tIn !== 'fade'));
  if (!earlyText && !earlyFx && earlyCuts === 0 && dur > 15) {
    out.push({
      id: 'hook', level: 'fix', area: 'Kanca',
      title: 'İlk 5 saniyede dikkat çekecek bir şey yok',
      detail: 'İzleyicilerin çoğu ilk saniyelerde karar verir. Büyük bir başlık, hızlı bir kesim ya da bir efekt ekle.',
      fixLabel: 'Başlık + whoosh ekle',
      fix: async () => {
        set({ time: 0.2 });
        addText('bebas', { start: 0.2 });
        await addSfx('whoosh', 0.1);
      },
      at: 0,
    });
  } else out.push({ id: 'hook-ok', level: 'good', area: 'Kanca', title: 'Açılış hareketli', detail: 'İlk saniyelerde yazı, kesim ya da efekt var.' });

  /* --- long static shots */
  for (const c of mainClips) {
    const d = clipDur(c);
    const moving = c.vfx?.some((v) => ['kenburns', 'zoomout', 'pan', 'pulse', 'shake'].includes(v.id));
    const limit = vertical ? 6 : 15;
    if (d > limit && !moving && (c.kind === 'video' || c.kind === 'image')) {
      out.push({
        id: 'long-' + c.id, level: c.kind === 'image' ? 'fix' : 'tip', area: 'Kurgu',
        title: `${formatDuration(d)} süren ${c.kind === 'image' ? 'sabit görsel' : 'tek plan'}`,
        detail: c.kind === 'image' ? 'Sabit görseller sıkıcı durur; yavaş bir yakınlaşma (Ken Burns) ekle.' : `${vertical ? 'Shorts’ta' : 'Uzun planlarda'} izleyici sıkılabilir. Yavaş yakınlaşma ekle ya da araya kesim koy.`,
        fixLabel: 'Yavaş yakınlaşma ekle',
        fix: () =>
          edit((dr) => {
            const x = dr.clips.find((q) => q.id === c.id);
            if (x) x.vfx = [...(x.vfx || []), { id: 'kenburns', amount: 0.5 }];
          }),
        at: c.start,
      });
      if (out.filter((s) => s.id.startsWith('long-')).length >= 3) break;
    }
  }

  /* --- gaps on the main track (black frames) */
  let gap = 0;
  let gapAt = 0;
  let prevEnd = 0;
  for (const c of mainClips) {
    if (c.start - prevEnd > 0.3 && !p.clips.some((o) => o.kind !== 'audio' && o.trackId !== main && o.start <= prevEnd + 0.05 && clipEnd(o) >= c.start - 0.05)) {
      gap += c.start - prevEnd;
      if (!gapAt) gapAt = prevEnd;
    }
    prevEnd = Math.max(prevEnd, clipEnd(c));
  }
  if (gap > 0.3)
    out.push({
      id: 'gaps', level: 'fix', area: 'Kurgu',
      title: `Ana izde ${gap.toFixed(1)} sn boşluk (siyah ekran)`,
      detail: 'Klipler arasındaki boşluklar siyah görünür.',
      fixLabel: 'Boşlukları kapat',
      fix: () =>
        edit((dr) => {
          // ripple: each gap on the main track pulls everything after it to the left
          let t = 0;
          for (const c of dr.clips.filter((x) => x.trackId === main).sort((x, y) => x.start - y.start)) {
            const shift = c.start - t;
            if (shift > 0.3) {
              const from = c.start - 1e-3;
              for (const o of dr.clips) if (o.start >= from) o.start -= shift;
              for (const mk of dr.markers) if (mk.time >= from) mk.time -= shift;
            }
            t = Math.max(t, c.start + (c.out - c.in) / c.speed);
          }
        }),
      at: gapAt,
    });

  /* --- voice: pauses, level, pace */
  const voices = p.clips.filter((c) => (c.kind === 'audio' && isVoice(p, c)) || (c.kind === 'video' && !c.muted && mediaOf(p, c)?.hasAudio));
  let anyAnalysed = false;
  const vt = videoTempo(p);
  const target = PACES[Math.max(0, Math.min(3, vt.level))].syl;
  const seenMedia = new Set<string>();
  for (const c of voices.slice(0, 8)) {
    if (c.mediaId && seenMedia.has(c.mediaId)) continue;
    if (c.mediaId) seenMedia.add(c.mediaId);
    const env = clipEnvelope(c);
    if (!env) continue;
    anyAnalysed = true;
    const s = analyzeSpeech(env);
    const name = mediaOf(p, c)?.name || 'Ses';
    if (s.longPauses >= 2)
      out.push({
        id: 'pauses-' + c.id, level: 'fix', area: 'Ses',
        title: `“${name}” içinde ${s.longPauses} uzun duraklama`,
        detail: 'Uzun sessizlikler videoyu yavaşlatır. Jump cut ile sessiz kısımları silebilirsin.',
        fixLabel: 'Sessizlikleri sil',
        fix: () => cutSilences(c.id, { thresholdDb: -40, minSilence: 0.7, padding: 0.15 }, true),
        at: c.start,
      });
    const dbs = Array.from(env, toDb).sort((a, b) => a - b);
    const loud = dbs[Math.floor(dbs.length * 0.95)];
    if (loud < -24 && c.volume < 1.6)
      out.push({
        id: 'quiet-' + c.id, level: 'fix', area: 'Ses',
        title: `“${name}” kısık kaydedilmiş`,
        detail: `Ses tepeleri yaklaşık ${loud.toFixed(0)} dB. Sesi yükselt ve "Net ses" efektiyle toparla.`,
        fixLabel: 'Sesi yükselt + Net ses',
        fix: () =>
          edit((dr) => {
            const x = dr.clips.find((q) => q.id === c.id);
            if (x) {
              x.volume = Math.min(2, x.volume * Math.pow(10, (-12 - loud) / 20));
              x.afx = x.afx || 'clear';
            }
          }),
      });
    if (s.rate && (s.rate > target[1] + 0.5 || s.rate < target[0] - 0.5))
      out.push({
        id: 'pace-' + c.id, level: 'tip', area: 'Ses',
        title: s.rate > target[1] ? `Konuşma hızlı: ${s.rate.toFixed(1)} hece/sn` : `Konuşma yavaş: ${s.rate.toFixed(1)} hece/sn`,
        detail: `Videonun temposu için hedef ${target[0]}–${target[1]} hece/sn. Tempo koçunda ayrıntılı analiz var.`,
        fixLabel: 'Tempo koçunu aç',
        fix: () => set({ leftTab: 'tempo', selection: [c.id] }),
      });
  }

  /* --- music fighting the voice */
  const music = p.clips.filter((c) => c.kind === 'audio' && !isVoice(p, c) && !c.muted && clipDur(c) > 10);
  for (const m of music) {
    const overlaps = voices.some((v) => v.start < clipEnd(m) && clipEnd(v) > m.start);
    if (overlaps && !m.vkeys?.length && m.volume > 0.4)
      out.push({
        id: 'duck-' + m.id, level: 'fix', area: 'Ses',
        title: 'Müzik konuşmanın üstüne biniyor',
        detail: 'Konuşmanın olduğu yerlerde müziği otomatik kıs (ducking); konuşma netleşir.',
        fixLabel: 'Konuşmada müziği kıs',
        fix: () => void autoDuck(m.id, 0.25),
        at: m.start,
      });
  }
  if (!music.length && dur > 30 && voices.length)
    out.push({ id: 'music', level: 'tip', area: 'Ses', title: 'Arka plan müziği yok', detail: 'Düşük seviyede bir müzik videoyu daha akıcı gösterir. Bir müzik dosyası ekleyip “Konuşmada müziği kıs” kullan.', fixLabel: 'Medyaya git', fix: () => set({ leftTab: 'media' }) });

  /* --- text readability & safe area */
  for (const c of texts) {
    if (!c.text) continue;
    const words = (c.text.content.match(/\S+/g) || []).length;
    const need = Math.max(1.2, words * 0.32);
    if (clipDur(c) < need)
      out.push({
        id: 'short-' + c.id, level: 'tip', area: 'Metin',
        title: `“${c.text.content.slice(0, 24)}” okunmaya yetmeyecek kadar kısa`,
        detail: `${words} kelime için en az ${need.toFixed(1)} sn ekranda kalmalı.`,
        fixLabel: 'Süreyi uzat',
        fix: () =>
          edit((dr) => {
            const x = dr.clips.find((q) => q.id === c.id);
            if (x) x.out = need;
          }),
        at: c.start,
      });
    const b = clipBox(p, c);
    const m = measureText(c.text);
    const halfW = (m.w * c.scale) / 2;
    const safe = 0.05;
    if (b.cx - halfW < p.width * safe || b.cx + halfW > p.width * (1 - safe) || b.cy - b.h / 2 < p.height * safe || b.cy + b.h / 2 > p.height * (1 - safe))
      out.push({
        id: 'safe-' + c.id, level: 'tip', area: 'Metin',
        title: `“${c.text.content.slice(0, 24)}” kenara çok yakın`,
        detail: 'Telefonlarda ve YouTube arayüzünde kesilebilir. Güvenli alana al.',
        fixLabel: 'Sığdır ve ortala',
        fix: () =>
          edit((dr) => {
            const x = dr.clips.find((q) => q.id === c.id);
            if (!x) return;
            const fit = Math.min(1, (p.width * 0.86) / (m.w * x.scale)) * x.scale;
            x.scale = fit;
            x.x = Math.max(-p.width * 0.4 + (m.w * fit) / 2, Math.min(p.width * 0.4 - (m.w * fit) / 2, x.x));
            x.y = Math.max(-p.height * 0.42 + (m.h * fit) / 2, Math.min(p.height * 0.42 - (m.h * fit) / 2, x.y));
          }),
        at: c.start,
      });
  }

  /* --- calls to action */
  const hasCta = texts.some((c) => /abone|subscribe|beğen|like/i.test(c.text?.content || ''));
  if (!hasCta && dur > 45)
    out.push({
      id: 'cta', level: 'tip', area: 'YouTube',
      title: 'Abone ol hatırlatması yok',
      detail: 'Videonun ilk üçte birinde kısa bir "Abone ol" hatırlatması abonelik oranını artırır.',
      fixLabel: '“Abone ol” ekle',
      fix: () => {
        const t = Math.round(dur * 0.3);
        set({ time: t });
        addText('sub', { start: t });
        addSfx('pop', t);
      },
      at: dur * 0.3,
    });
  const hasEnd = p.clips.some((c) => c.kind === 'text' && /izlediğin için|teşekkür/i.test(c.text?.content || ''));
  if (!hasEnd && dur > 60 && !vertical)
    out.push({ id: 'endscreen', level: 'tip', area: 'YouTube', title: 'Bitiş ekranı yok', detail: 'Son 5–20 saniyeye YouTube bitiş ekranı (sonraki video, abone ol) koymak izlenme süresini uzatır.', fixLabel: 'Bitiş ekranı ekle', fix: () => insertTemplate('endscreen', { color: '#ff6a3d', channel: '', title: '' }) });

  /* --- chapters, thumbnail, metadata */
  if (dur > 180 && p.markers.length < 2 && !vertical)
    out.push({
      id: 'chapters', level: 'tip', area: 'YouTube',
      title: 'Bölüm (chapter) yok',
      detail: '3 dakikadan uzun videolarda bölümler aramada ve izlenmede yardımcı olur. Konuşmadaki uzun duraklamalardan bölüm önerebilirim.',
      fixLabel: 'Bölüm öner',
      fix: () => suggestChapters(),
    });
  if (!p.thumbDesign)
    out.push({ id: 'thumb', level: 'fix', area: 'YouTube', title: 'Küçük resim tasarlanmamış', detail: 'Tıklanma oranını en çok etkileyen şey küçük resimdir. Büyük, okunaklı 2–4 kelime kullan.', fixLabel: 'Küçük resim tasarla', fix: () => set({ thumbOpen: true }) });
  if (!p.yt?.title || !p.yt?.description)
    out.push({ id: 'meta', level: 'tip', area: 'YouTube', title: 'YouTube başlığı / açıklaması boş', detail: 'Açıklamayı bölümler ve etiketlerle otomatik hazırlayabilirim.', fixLabel: 'YouTube bilgilerini aç', fix: () => set({ leftTab: 'youtube' }) });
  if (vertical && dur > 180)
    out.push({ id: 'shorts-len', level: 'fix', area: 'YouTube', title: `Shorts için uzun: ${formatDuration(dur)}`, detail: 'YouTube Shorts en fazla 3 dakika olabilir.' });

  /* --- visuals */
  const lowRes = p.clips.filter((c) => (c.kind === 'video' || c.kind === 'image') && (mediaOf(p, c)?.height || 9999) < Math.min(p.width, p.height) * 0.66);
  if (lowRes.length)
    out.push({ id: 'lowres', level: 'tip', area: 'Görsel', title: `${lowRes.length} klip düşük çözünürlüklü`, detail: 'Proje çözünürlüğünden belirgin şekilde küçük; büyütülünce bulanık görünebilir.', at: lowRes[0].start });
  const verticalInWide = !vertical && p.clips.find((c) => c.kind === 'video' && (mediaOf(p, c)?.height || 0) > (mediaOf(p, c)?.width || 0) && !c.vfx?.some((v) => v.id === 'blurbg'));
  if (verticalInWide)
    out.push({
      id: 'blurbg', level: 'tip', area: 'Görsel', title: 'Dikey video yatay projede: yanlar boş', detail: 'Boş kenarları videonun bulanık kopyasıyla doldur.',
      fixLabel: 'Bulanık dolgu ekle',
      fix: () => edit((dr) => {
        const x = dr.clips.find((q) => q.id === verticalInWide.id);
        if (x) x.vfx = [...(x.vfx || []), { id: 'blurbg', amount: 0.7 }];
      }),
      at: verticalInWide.start,
    });
  const cuts = mainClips.length;
  const sfxCount = p.clips.filter((c) => c.kind === 'audio' && /efekt/i.test(p.tracks.find((t) => t.id === c.trackId)?.name || '')).length;
  if (cuts >= 6 && sfxCount === 0)
    out.push({
      id: 'sfx', level: 'tip', area: 'Kurgu', title: 'Geçişlerde ses efekti yok', detail: 'Kesimlerin üstüne hafif whoosh/pop sesleri kurguyu daha profesyonel yapar.',
      fixLabel: 'Kesimlere whoosh ekle',
      fix: async () => {
        for (const c of mainClips.slice(1, 9)) await addSfx('swoosh', Math.max(0, c.start - 0.2));
      },
    });
  if (!anyAnalysed && voices.length)
    out.push({ id: 'wait', level: 'tip', area: 'Ses', title: 'Ses analizi hazırlanıyor…', detail: 'Ses dalgaları hazırlanınca ses önerileri burada görünür.' });

  const order: Record<Level, number> = { fix: 0, tip: 1, good: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

export function readiness(list: Suggestion[]) {
  const fixes = list.filter((s) => s.level === 'fix').length;
  const tips = list.filter((s) => s.level === 'tip').length;
  return Math.max(10, Math.min(100, 100 - fixes * 14 - tips * 5));
}

/** Chapter markers at the longest pauses of the voice track(s). */
export function suggestChapters() {
  const p = get().project!;
  const voices = p.clips.filter((c) => (c.kind === 'audio' && isVoice(p, c)) || (c.kind === 'video' && !c.muted));
  const gaps: { t: number; len: number }[] = [];
  for (const c of voices) {
    const env = clipEnvelope(c);
    if (!env) continue;
    let run = 0;
    for (let i = 0; i < env.length; i++) {
      if (toDb(env[i]) < -42) run++;
      else {
        if (run >= 80) gaps.push({ t: c.start + (i - run / 2) / 100, len: run / 100 });
        run = 0;
      }
    }
  }
  const dur = projectDuration(p);
  const minSpacing = Math.max(30, dur / 10);
  const picked: number[] = [];
  for (const g of gaps.sort((a, b) => b.len - a.len)) {
    if (g.t < 10 || g.t > dur - 10) continue;
    if (picked.every((t) => Math.abs(t - g.t) >= minSpacing)) picked.push(g.t);
    if (picked.length >= 8) break;
  }
  if (!picked.length) {
    // even spacing as a fallback
    const n = Math.min(6, Math.floor(dur / 60));
    for (let i = 1; i <= n; i++) picked.push((dur * i) / (n + 1));
  }
  for (const t of picked.sort((a, b) => a - b)) addMarker(t);
  set({ leftTab: 'chapters' });
}
