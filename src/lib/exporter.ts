import type { Clip, Project } from '../types';
import { clipDur, projectDuration } from './util';
import { clipBox, mediaOf, textPad } from './render';
import { colorFfmpeg } from './color';
import { drawText, ensureFont, measureText } from './text';
import { BLUR, ffTrans, trDurations, visStart } from './transitions';
import { afxFfmpeg, chanFfmpeg } from './afx';
import { volExpr } from './keyframes';

export interface ExportOptions {
  format: 'mp4' | 'mp3' | 'wav';
  width: number;
  height: number;
  fps: number;
  crf: number;
  preset: string;
  normalize: boolean;
  outPath: string;
  /** loudnorm first-pass measurements (two-pass normalization) */
  measured?: Loudness;
  /** build an audio-only analysis job instead of a render */
  measureOnly?: boolean;
  /** JPEG/PNG embedded as the MP4 cover (YouTube thumbnail) */
  coverPath?: string;
}

export interface Loudness {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export interface ExportJob {
  inputs: string[];
  graph: string;
  output: string[];
  total: number;
}

const n3 = (v: number) => (Math.round(v * 1000) / 1000).toString();

function atempo(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2.0001) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.4999) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-4) out.push(`atempo=${n3(s)}`);
  return out;
}

/** Text rendered at output scale into its own (padded, unrotated) box. */
async function renderTextPng(c: Clip, k: number): Promise<{ path: string; w: number; h: number }> {
  await ensureFont(c.text!);
  const s = c.text!;
  const cv = document.createElement('canvas');
  const pad = textPad(s);
  const m = measureText(s);
  const sc = c.scale * k;
  const w = Math.max(2, Math.ceil((m.w + pad * 2) * sc));
  const h = Math.max(2, Math.ceil((m.h + pad * 2) * sc));
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(sc, 0, 0, sc, w / 2, h / 2);
  drawText(ctx, s);
  const path = await window.cv.invoke<string>('export:writeTemp', cv.toDataURL('image/png'), `text-${c.id}-${Date.now()}.png`);
  return { path, w, h };
}

export async function buildExport(p: Project, o: ExportOptions): Promise<ExportJob> {
  const total = projectDuration(p);
  if (total <= 0) throw new Error('Zaman çizelgesi boş');
  const W = o.width;
  const H = o.height;
  const fps = o.fps;
  const k = W / p.width;
  const inputs: string[] = [];
  let nIn = 0;
  const addInput = (args: string[]) => {
    inputs.push(...args);
    return nIn++;
  };
  const lines: string[] = [];
  const exists = new Map<string, boolean>();
  const ok = async (path: string) => {
    if (!exists.has(path)) exists.set(path, await window.cv.invoke<boolean>('fs:exists', path));
    return exists.get(path)!;
  };
  const audioOnly = o.format !== 'mp4' || o.measureOnly;

  /* ------------------------------------------------ video */
  if (!audioOnly) {
    const bg = (p.background || '#000000').replace('#', '0x');
    lines.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${n3(total)},format=rgba[b0]`);
    let cur = 'b0';
    let layer = 0;
    let lab = 0;
    const L = () => `t${lab++}`;
    const tracks = p.tracks.filter((t) => t.type === 'visual' && !t.hidden);
    for (let ti = tracks.length - 1; ti >= 0; ti--) {
      const tr = tracks[ti];
      const clips = p.clips.filter((c) => c.trackId === tr.id && c.kind !== 'audio').sort((a, b) => a.start - b.start);
      for (const c of clips) {
        const dur = clipDur(c);
        if (dur <= 0.001 || c.opacity <= 0.001) continue;
        const { pre, L: len } = trDurations(c);
        const vs = visStart(c);
        const fx = ffTrans(c, W, H);
        const b = clipBox(p, c);
        let head: string;
        let w: number;
        let h: number;
        let colorable = false;

        if (c.kind === 'text') {
          const png = await renderTextPng(c, k);
          const i = addInput(['-loop', '1', '-framerate', String(fps), '-t', n3(len), '-i', png.path]);
          head = `[${i}:v]setpts=PTS-STARTPTS,format=rgba`;
          w = png.w;
          h = png.h;
        } else if (c.kind === 'color') {
          w = Math.max(2, Math.round(b.w * k));
          h = Math.max(2, Math.round(b.h * k));
          head = `color=c=${(c.fill || '#000000').replace('#', '0x')}:s=${w}x${h}:r=${fps}:d=${n3(len)},format=rgba`;
        } else {
          const m = mediaOf(p, c);
          if (!m || !(await ok(m.path))) continue;
          w = Math.max(2, Math.round(b.w * k));
          h = Math.max(2, Math.round(b.h * k));
          colorable = true;
          // untagged sources: decode as BT.709 like Chromium does in the preview
          const scale = `scale=${w}:${h}:flags=bicubic` + (c.kind === 'video' && (!m.colorspace || m.colorspace === 'unknown') ? ':in_color_matrix=bt709' : '');
          if (c.kind === 'image') {
            // ffmpeg applies JPEG EXIF orientation itself (as Chromium does in the preview)
            const i = addInput(['-loop', '1', '-framerate', String(fps), '-t', n3(len), '-i', m.path]);
            head = `[${i}:v]setpts=PTS-STARTPTS,${scale},format=rgba`;
          } else {
            let srcIn = c.in - pre * c.speed;
            let hold = 0;
            if (srcIn < 0) {
              hold = -srcIn / c.speed;
              srcIn = 0;
            }
            const i = addInput(['-ss', n3(srcIn), '-t', n3(c.out - srcIn), '-i', m.path]);
            head = `[${i}:v]setpts=(PTS-STARTPTS)/${n3(c.speed)}` + (hold > 0 ? `,tpad=start_duration=${n3(hold)}:start_mode=clone` : '') + `,${scale},format=rgba`;
          }
        }

        const chain: string[] = [head, ...colorFfmpeg(colorable ? c.color : undefined, c.opacity)];
        let body = chain.join(',');
        // blur transitions: blurred copies cross-faded over the sharp clip
        if (fx.blurs.length) {
          const sharp = L();
          const copies = fx.blurs.map(() => L());
          lines.push(`${body},split=${copies.length + 1}[${sharp}]${copies.map((x) => `[${x}]`).join('')}`);
          let base = sharp;
          for (let bi = 0; bi < copies.length; bi++) {
            const bl = L();
            const out = L();
            lines.push(`[${copies[bi]}]gblur=sigma=${n3(BLUR * k * c.scale)},${fx.blurs[bi].join(',')}[${bl}]`);
            lines.push(`[${base}][${bl}]overlay=format=rgb:eof_action=pass[${out}]`);
            base = out;
          }
          body = `[${base}]null`;
        }
        const tail: string[] = [];
        if (fx.zoom) tail.push(`zoompan=z='${fx.zoom}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${w}x${h}:fps=${fps}`);
        const rad = (c.rotation * Math.PI) / 180;
        if (fx.rot) {
          tail.push(`rotate=a='${rad.toFixed(6)}+${fx.rot}':c=black@0:ow=hypot(iw\\,ih):oh=ow`);
        } else if (Math.abs(c.rotation) > 0.01) {
          tail.push(`rotate=a=${rad.toFixed(6)}:c=black@0:ow=rotw(${rad.toFixed(6)}):oh=roth(${rad.toFixed(6)})`);
        }
        tail.push(...fx.pre, `setpts=PTS-STARTPTS+${n3(vs)}/TB`);
        const label = `l${layer++}`;
        lines.push(`${body},${tail.join(',')}[${label}]`);
        const cx = (b.cx * k).toFixed(2);
        const cy = (b.cy * k).toFixed(2);
        const dx = fx.dx;
        const dy = fx.dy;
        const animated = !!(dx || dy);
        const pos = animated
          ? `x='${cx}-overlay_w/2${dx}':y='${cy}-overlay_h/2${dy}':eval=frame`
          : `x=${cx}-overlay_w/2:y=${cy}-overlay_h/2`;
        let next = `b${layer}_v`;
        lines.push(`[${cur}][${label}]overlay=${pos}:format=rgb:eof_action=pass[${next}]`);
        cur = next;
        // dip to black / white flashes right above this clip
        for (const fl of fx.flashes) {
          const fl1 = L();
          const out = L();
          const fade = fl.dir === 'in' ? `fade=t=out:st=0:d=${n3(fl.dur)}:alpha=1` : `fade=t=in:st=0:d=${n3(fl.dur)}:alpha=1`;
          lines.push(`color=c=${fl.color}:s=${W}x${H}:r=${fps}:d=${n3(fl.dur)},format=rgba,${fade},setpts=PTS-STARTPTS+${n3(fl.start)}/TB[${fl1}]`);
          lines.push(`[${cur}][${fl1}]overlay=0:0:format=rgb:eof_action=pass[${out}]`);
          cur = out;
        }
        next = cur;
      }
    }
    lines.push(`[${cur}]scale=w=iw:h=ih:out_color_matrix=bt709:out_range=tv,format=yuv420p[vout]`);
  }

  /* ------------------------------------------------ audio */
  const aLabels: string[] = [];
  for (const c of p.clips) {
    if (c.kind !== 'video' && c.kind !== 'audio') continue;
    const tr = p.tracks.find((t) => t.id === c.trackId);
    if (!tr || tr.muted || c.muted || (!c.vkeys?.length && c.volume <= 0.001)) continue;
    const m = mediaOf(p, c);
    if (!m || !m.hasAudio || !(await ok(m.path))) continue;
    const dur = clipDur(c);
    if (dur <= 0.001) continue;
    const i = addInput(['-ss', n3(c.in), '-t', n3(c.out - c.in), '-i', m.path]);
    const fin = Math.min(c.audioFadeIn, dur / 2);
    const fout = Math.min(c.audioFadeOut, dur / 2);
    const chain = [
      `[${i}:a]asetpts=PTS-STARTPTS`,
      ...atempo(c.speed),
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
      ...chanFfmpeg(c.chan),
      ...afxFfmpeg(c.afx),
      (() => {
        const ve = volExpr(c);
        return ve ? `volume='${ve}':eval=frame` : `volume=${n3(c.volume)}`;
      })(),
      ...(fin > 0 ? [`afade=t=in:st=0:d=${n3(fin)}`] : []),
      ...(fout > 0 ? [`afade=t=out:st=${n3(dur - fout)}:d=${n3(fout)}`] : []),
      `atrim=0:${n3(dur)}`,
      `adelay=delays=${Math.round(c.start * 1000)}:all=1`,
    ];
    const label = `a${aLabels.length}`;
    lines.push(chain.join(',') + `[${label}]`);
    aLabels.push(label);
  }
  const LN = 'loudnorm=I=-14:TP=-1.5:LRA=11';
  const ms = o.measured;
  const post = o.measureOnly
    ? `${LN}:print_format=json,`
    : o.normalize && ms
      ? `${LN}:measured_I=${ms.input_i}:measured_TP=${ms.input_tp}:measured_LRA=${ms.input_lra}:measured_thresh=${ms.input_thresh}:offset=${ms.target_offset}:linear=true,aresample=48000,`
      : o.normalize
        ? `${LN},aresample=48000,`
        : 'alimiter=limit=0.98:level=0:latency=1,';
  if (!aLabels.length) {
    lines.push(`anullsrc=r=48000:cl=stereo,atrim=0:${n3(total)}[aout]`);
  } else if (aLabels.length === 1) {
    lines.push(`[${aLabels[0]}]${post}apad[aout]`);
  } else {
    lines.push(
      aLabels.map((l) => `[${l}]`).join('') +
        `amix=inputs=${aLabels.length}:duration=longest:dropout_transition=0:normalize=0,${post}apad[aout]`,
    );
  }

  let output: string[];
  if (o.measureOnly) output = ['-map', '[aout]', '-t', n3(total), '-f', 'null', '-'];
  else if (o.format === 'mp3') output = ['-map', '[aout]', '-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '48000', '-t', n3(total), o.outPath];
  else if (o.format === 'wav') output = ['-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', '48000', '-t', n3(total), o.outPath];
  else {
    const cover = o.coverPath && (await ok(o.coverPath)) ? addInput(['-i', o.coverPath]) : -1;
    output = [
      '-map', '[vout]', '-map', '[aout]',
      ...(cover >= 0 ? ['-map', `${cover}:v`, '-c:v:1', 'mjpeg', '-disposition:v:1', 'attached_pic'] : []),
      '-c:v:0', 'libx264', '-preset', o.preset, '-crf', String(o.crf), '-profile:v:0', 'high', '-pix_fmt:v:0', 'yuv420p',
      '-r:v:0', String(fps), '-colorspace:v:0', 'bt709', '-color_primaries:v:0', 'bt709', '-color_trc:v:0', 'bt709',
      '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
      '-movflags', '+faststart', '-t', n3(total), o.outPath,
    ];
  }

  return { inputs, graph: lines.join(';\n'), output, total };
}
