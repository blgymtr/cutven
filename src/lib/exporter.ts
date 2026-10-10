import type { Clip, Project } from '../types';
import { clipDur, projectDuration } from './util';
import { clipBox, mediaOf, textPad } from './render';
import { colorFfmpeg } from './color';
import { drawText, ensureFont, measureText } from './text';
import { BLUR, ffTrans, trDurations, visStart } from './transitions';
import { afxFfmpeg, chanFfmpeg, clipStages } from './afx';
import { volExpr } from './keyframes';
import { vfxFfmpeg, vfxMotionFf, hasPixelVfx, blurBg } from './vfx';
import { hasKeys, maxKeyed, keyExpr, opacityCommands } from './vkeys';
import { gradeActive, bakeLut, cubeText, loadCube } from './lumetri';
import { hexRgb } from './keygl';
import { hasCrop } from './render';
import { burnInput, styleOf } from './captions';
import { trackMix, panFfmpeg } from './mix';

const FF_BLEND: Record<string, string> = {
  multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', 'color-dodge': 'dodge', 'color-burn': 'burn',
  'hard-light': 'hardlight', 'soft-light': 'softlight', difference: 'difference', exclusion: 'exclusion', add: 'addition',
};
/** base64 of a UTF-8 string */
const b64 = (s: string) => {
  const u = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(bin);
};
/** path inside a filter option: forward slashes, escaped drive colon */
const ffPath = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:');

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
  /** video codec (default h264) */
  codec?: VideoCodec;
  /** hardware encoder family for h264 / hevc */
  hw?: HwKind | null;
}

export type VideoCodec = 'h264' | 'hevc' | 'prores' | 'vp9' | 'gif' | 'png';
export type HwKind = 'nvenc' | 'qsv' | 'amf';
export const CODEC_EXT: Record<VideoCodec, string> = { h264: 'mp4', hevc: 'mp4', prores: 'mov', vp9: 'webm', gif: 'gif', png: 'png' };

/** encoder args for h264/hevc: software (crf) or hardware (constant quality) */
function videoEnc(codec: 'h264' | 'hevc', hw: HwKind | null | undefined, crf: number, preset: string): string[] {
  const q = String(Math.round(crf + (codec === 'hevc' ? 2 : 0)));
  if (!hw) {
    return codec === 'h264'
      ? ['-c:v:0', 'libx264', '-preset', preset, '-crf', String(crf), '-profile:v:0', 'high']
      : ['-c:v:0', 'libx265', '-preset', preset, '-crf', String(crf + 4), '-tag:v:0', 'hvc1', '-x265-params', 'log-level=error'];
  }
  const name = `${codec}_${hw}`;
  const tag = codec === 'hevc' ? ['-tag:v:0', 'hvc1'] : [];
  if (hw === 'nvenc') return ['-c:v:0', name, '-preset', 'p5', '-rc', 'vbr', '-cq', q, '-b:v', '0', ...tag];
  if (hw === 'qsv') return ['-c:v:0', name, '-preset', 'medium', '-global_quality', q, ...tag];
  return ['-c:v:0', name, '-quality', 'quality', '-rc', 'cqp', '-qp_i', q, '-qp_p', q, '-qp_b', q, ...tag];
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
      for (const c0 of clips) {
        // animated scale renders at the largest keyed size and scales down per frame
        const kScale = hasKeys(c0, 'scale');
        const maxS = kScale ? Math.max(0.01, maxKeyed(c0, 'scale')) : c0.scale;
        const c: Clip = kScale ? { ...c0, scale: maxS } : c0;
        const kOp = hasKeys(c0, 'opacity');
        const dur = clipDur(c);
        if (dur <= 0.001 || (!kOp && c.opacity <= 0.001)) continue;
        const { pre, L: len } = trDurations(c);
        const vs = visStart(c);
        const fx = ffTrans(c, W, H);
        const b = clipBox(p, c);
        let head: string;
        let w: number;
        let h: number;
        let colorable = false;
        let mkHead: (() => string) | null = null;

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
            mkHead = () => `[${addInput(['-loop', '1', '-framerate', String(fps), '-t', n3(len), '-i', m.path])}:v]setpts=PTS-STARTPTS`;
            head = `${mkHead()},${scale},format=rgba`;
          } else {
            let srcIn = c.in - pre * c.speed;
            let hold = 0;
            if (srcIn < 0) {
              hold = -srcIn / c.speed;
              srcIn = 0;
            }
            const si = srcIn;
            const hd = hold;
            mkHead = () =>
              `[${addInput(['-ss', n3(si), '-t', n3(c.out - si), '-i', m.path])}:v]setpts=(PTS-STARTPTS)/${n3(c.speed)}` +
              (hd > 0 ? `,tpad=start_duration=${n3(hd)}:start_mode=clone` : '');
            head = `${mkHead()},${scale},format=rgba`;
          }
        }

        const chain: string[] = [head];
        if (colorable && c.ckey?.on) {
          const [kr, kg, kb] = hexRgb(c.ckey.color);
          chain.push(`format=yuva444p,chromakey=0x${c.ckey.color.replace('#', '')}:${n3(Math.max(0.0001, c.ckey.similarity))}:${n3(c.ckey.smooth)},format=rgba`);
          if (c.ckey.spill > 0) {
            const blue = kb > kg && kb > kr;
            chain.push(blue ? `despill=type=blue:mix=0.5:expand=0:red=0:green=0:blue=${n3(-c.ckey.spill)}` : `despill=type=green:mix=0.5:expand=0:red=0:green=${n3(-c.ckey.spill)}:blue=0`, 'format=rgba');
          }
        }
        const baseOpacity = kOp ? 1 : c.opacity;
        if (colorable && gradeActive(c.grade)) {
          if (c.grade!.lut?.path) await loadCube(c.grade!.lut.path).catch(() => undefined);
          const lut = bakeLut(c.color, c.grade!);
          const cube = await window.cv.invoke<string>('export:writeTemp', 'data:text/plain;base64,' + b64(cubeText(lut.data)), `grade-${c.id}-${Date.now()}.cube`);
          chain.push(`lut3d=file='${ffPath(cube)}':interp=trilinear`, 'format=rgba');
          if (baseOpacity < 0.999) chain.push(`colorchannelmixer=aa=${n3(baseOpacity)}`);
        } else chain.push(...colorFfmpeg(colorable ? c.color : undefined, baseOpacity));
        if (hasCrop(c) && colorable) {
          const cr = c.crop!;
          const L0 = Math.round((cr.l / 100) * w);
          const R0 = Math.round((cr.r / 100) * w);
          const T0 = Math.round((cr.t / 100) * h);
          const B0 = Math.round((cr.b / 100) * h);
          const cw = Math.max(2, w - L0 - R0);
          const chh = Math.max(2, h - T0 - B0);
          chain.push(`crop=${cw}:${chh}:${L0}:${T0}`, `pad=${w}:${h}:${L0}:${T0}:color=black@0`);
        }
        if (kOp) {
          const id = 'op' + layer;
          const cmds = await window.cv.invoke<string>('export:writeTemp', 'data:text/plain;base64,' + b64(opacityCommands(c0, `colorchannelmixer@${id}`, fps, pre, len, 1)), `op-${c.id}-${Date.now()}.txt`);
          chain.push(`sendcmd=f='${ffPath(cmds)}'`, `colorchannelmixer@${id}=aa=1`);
        }
        let body = chain.join(',');
        if (c.vfx?.length && hasPixelVfx(c)) {
          const v0 = L();
          lines.push(`${body}[${v0}]`);
          const out = await vfxFfmpeg(c, v0, w, h, { lines, label: L, addInput, fps, L: len });
          body = `[${out}]null`;
        }
        const mo = c.vfx?.length ? vfxMotionFf(c, len, W, H, vs) : { zoom: null, pan: null, rot: null, dx: '', dy: '' };
        // blurred fill behind the clip
        if (mkHead && c.vfx?.length && blurBg(c) > 0) {
          const bgl = L();
          const bgo = L();
          lines.push(
            `${mkHead()},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=${n3(40 * blurBg(c) * k)},format=rgba,colorchannelmixer=rr=0.6:gg=0.6:bb=0.6:aa=${n3(c.opacity)},${[...fx.pre, `setpts=PTS-STARTPTS+${n3(vs)}/TB`].join(',')}[${bgl}]`,
          );
          lines.push(`[${cur}][${bgl}]overlay=0:0:format=rgb:eof_action=pass[${bgo}]`);
          cur = bgo;
        }
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
        const zexpr = [fx.zoom, mo.zoom].filter(Boolean).join('*');
        if (zexpr) {
          const px = mo.pan ? `+(${mo.pan}-0.5)*(iw-iw/zoom)` : '';
          tail.push(`zoompan=z='${zexpr}':x='iw/2-iw/zoom/2${px}':y='ih/2-ih/zoom/2':d=1:s=${w}x${h}:fps=${fps}`);
        }
        const rad = hasKeys(c0, 'rotation') ? 0 : (c.rotation * Math.PI) / 180;
        const Sloc = `(${n3(c.in)}+(t-${n3(pre)})*${n3(c.speed)})`;
        const krot = keyExpr(c0, 'rotation', Sloc, (v) => (v * Math.PI) / 180);
        const rexpr = [fx.rot, mo.rot, krot].filter(Boolean).join('+');
        if (rexpr) {
          tail.push(`rotate=a='${rad.toFixed(6)}+${rexpr}':c=black@0:ow=hypot(iw\\,ih):oh=ow`);
        } else if (Math.abs(c.rotation) > 0.01) {
          tail.push(`rotate=a=${rad.toFixed(6)}:c=black@0:ow=rotw(${rad.toFixed(6)}):oh=roth(${rad.toFixed(6)})`);
        }
        tail.push(...fx.pre);
        if (kScale) {
          const se = keyExpr(c0, 'scale', Sloc, (v) => v / maxS)!;
          tail.push(`scale=w='max(2,trunc(iw*(${se})/2)*2)':h='max(2,trunc(ih*(${se})/2)*2)':eval=frame`);
        }
        tail.push(`setpts=PTS-STARTPTS+${n3(vs)}/TB`);
        const label = `l${layer++}`;
        lines.push(`${body},${tail.join(',')}[${label}]`);
        const Stl = `(${n3(c.in)}+(t-${n3(c.start)})*${n3(c.speed)})`;
        const kx = keyExpr(c0, 'x', Stl);
        const ky = keyExpr(c0, 'y', Stl);
        const cx = kx ? `${n3(k)}*(${n3(p.width / 2)}+${kx})` : (b.cx * k).toFixed(2);
        const cy = ky ? `${n3(k)}*(${n3(p.height / 2)}+${ky})` : (b.cy * k).toFixed(2);
        const dx = fx.dx + mo.dx;
        const dy = fx.dy + mo.dy;
        const animated = !!(dx || dy || kx || ky);
        const pos = animated
          ? `x='${cx}-overlay_w/2${dx}':y='${cy}-overlay_h/2${dy}':eval=frame`
          : `x=${cx}-overlay_w/2:y=${cy}-overlay_h/2`;
        let next = `b${layer}_v`;
        if (c.blend && c.blend !== 'normal') {
          // place the clip on a transparent frame, blend with what's below, keep the clip's alpha as mask
          const e = L(), full = L(), f1 = L(), f2 = L(), b1 = L(), b2 = L(), bl = L(), al = L(), bla = L();
          lines.push(`color=c=black@0:s=${W}x${H}:r=${fps}:d=${n3(total)},format=rgba[${e}]`);
          lines.push(`[${e}][${label}]overlay=${pos}:format=rgb:eof_action=pass[${full}]`);
          lines.push(`[${full}]split[${f1}][${f2}]`);
          lines.push(`[${cur}]split[${b1}][${b2}]`);
          lines.push(`[${b1}][${f1}]blend=all_mode=${FF_BLEND[c.blend] || 'normal'}:shortest=1,format=rgba[${bl}]`);
          lines.push(`[${f2}]alphaextract[${al}]`);
          lines.push(`[${bl}][${al}]alphamerge[${bla}]`);
          lines.push(`[${b2}][${bla}]overlay=0:0:format=rgb[${next}]`);
        } else lines.push(`[${cur}][${label}]overlay=${pos}:format=rgb:eof_action=pass[${next}]`);
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
    if ((p.captions?.length || 0) > 0 && styleOf(p).burn) {
      const list = await burnInput(p, W, H, total);
      if (list) {
        const i = addInput(['-f', 'concat', '-safe', '0', '-i', list]);
        const cl = L(), co = L();
        lines.push(`[${i}:v]fps=${fps},format=rgba,setpts=PTS-STARTPTS[${cl}]`);
        lines.push(`[${cur}][${cl}]overlay=0:0:format=rgb:eof_action=pass[${co}]`);
        cur = co;
      }
    }
    const codec = o.codec || 'h264';
    if (codec === 'gif') {
      const g1 = L(), g2 = L(), gp = L();
      lines.push(`[${cur}]format=rgb24,split[${g1}][${g2}]`);
      lines.push(`[${g1}]palettegen=max_colors=256:stats_mode=diff[${gp}]`);
      lines.push(`[${g2}][${gp}]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[vout]`);
    } else if (codec === 'png') lines.push(`[${cur}]format=rgb24[vout]`);
    else lines.push(`[${cur}]scale=w=iw:h=ih:out_color_matrix=bt709:out_range=tv,format=${codec === 'prores' ? 'yuv422p10le' : 'yuv420p'}[vout]`);
  }

  /* ------------------------------------------------ audio */
  const aLabels: string[] = [];
  const silent = !o.measureOnly && o.format === 'mp4' && (o.codec === 'gif' || o.codec === 'png');
  for (const c of silent ? [] : p.clips) {
    if (c.kind !== 'video' && c.kind !== 'audio') continue;
    const tr = p.tracks.find((t) => t.id === c.trackId);
    const mix = trackMix(p, c);
    if (!tr || !mix.on || c.muted || mix.vol <= 0.001 || (!c.vkeys?.length && c.volume <= 0.001)) continue;
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
      ...afxFfmpeg(c.afx, clipStages(c)),
      (() => {
        const ve = volExpr(c);
        return ve ? `volume='${ve}':eval=frame` : `volume=${n3(c.volume)}`;
      })(),
      ...(Math.abs(mix.vol - 1) > 0.001 ? [`volume=${n3(mix.vol)}`] : []),
      ...panFfmpeg(mix.pan),
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
  if (silent) {
    // gif / png sequence: no audio stream
  } else if (!aLabels.length) {
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
  else if (o.codec === 'gif') output = ['-map', '[vout]', '-loop', '0', '-t', n3(total), o.outPath];
  else if (o.codec === 'png') output = ['-map', '[vout]', '-c:v', 'png', '-t', n3(total), '-start_number', '1', o.outPath];
  else if (o.codec === 'prores')
    output = [
      '-map', '[vout]', '-map', '[aout]', '-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le', '-r', String(fps),
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'pcm_s16le', '-ar', '48000', '-t', n3(total), o.outPath,
    ];
  else if (o.codec === 'vp9')
    output = [
      '-map', '[vout]', '-map', '[aout]', '-c:v', 'libvpx-vp9', '-crf', String(Math.round(o.crf + 13)), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '3',
      '-pix_fmt', 'yuv420p', '-r', String(fps), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-c:a', 'libopus', '-b:a', '192k', '-ar', '48000', '-t', n3(total), o.outPath,
    ];
  else {
    const cover = o.coverPath && (await ok(o.coverPath)) ? addInput(['-i', o.coverPath]) : -1;
    output = [
      '-map', '[vout]', '-map', '[aout]',
      ...(cover >= 0 ? ['-map', `${cover}:v`, '-c:v:1', 'mjpeg', '-disposition:v:1', 'attached_pic'] : []),
      ...videoEnc(o.codec === 'hevc' ? 'hevc' : 'h264', o.hw, o.crf, o.preset), '-pix_fmt:v:0', 'yuv420p',
      '-r:v:0', String(fps), '-colorspace:v:0', 'bt709', '-color_primaries:v:0', 'bt709', '-color_trc:v:0', 'bt709',
      '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
      '-movflags', '+faststart', '-t', n3(total), o.outPath,
    ];
  }

  return { inputs, graph: lines.join(';\n'), output, total };
}
