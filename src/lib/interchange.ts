import type { Clip, MediaItem, Project } from '../types';
import { clipDur, projectDuration } from './util';

/**
 * Timeline interchange for finishing in other tools:
 *  - Final Cut Pro 7 XML (xmeml v4) — imports into Premiere Pro and DaVinci Resolve
 *  - CMX3600 EDL (main video track + audio) — universal, cuts only
 *  - OpenTimelineIO JSON (.otio) — Resolve, Nuke Studio, Kdenlive, Hiero …
 * Only cuts, speed, opacity/volume levels and markers travel; effects stay in Cutven.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fileUrl = (p: string) => 'file://localhost/' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
const isSourced = (c: Clip) => c.kind === 'video' || c.kind === 'audio' || c.kind === 'image';
const mediaOf = (p: Project, c: Clip) => (c.mediaId ? p.media.find((m) => m.id === c.mediaId) : undefined);

function timebase(fps: number) {
  const ntsc = [23.976, 29.97, 59.94].some((f) => Math.abs(f - fps) < 0.01);
  return { tb: Math.round(fps), ntsc };
}

/* ------------------------------------------------------------ FCP7 XML */

export function toFcpXml(p: Project): string {
  const fps = p.fps;
  const { tb, ntsc } = timebase(fps);
  const F = (s: number) => Math.round(s * fps);
  const rate = `<rate><timebase>${tb}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const total = F(projectDuration(p));
  const files = new Set<string>();
  const fileXml = (m: MediaItem) => {
    const fid = 'file-' + m.id;
    if (files.has(fid)) return `<file id="${fid}"/>`;
    files.add(fid);
    const dur = F(m.type === 'image' ? 3600 : m.duration);
    return `<file id="${fid}"><name>${esc(m.name)}</name><pathurl>${esc(fileUrl(m.path))}</pathurl>${rate}<duration>${dur}</duration><media>${
      m.type !== 'audio' ? `<video><samplecharacteristics>${rate}<width>${m.width || p.width}</width><height>${m.height || p.height}</height></samplecharacteristics></video>` : ''
    }${m.hasAudio || m.type === 'audio' ? '<audio><channelcount>2</channelcount></audio>' : ''}</media></file>`;
  };
  const clipItem = (c: Clip, kind: 'video' | 'audio', i: number) => {
    const m = mediaOf(p, c)!;
    const start = F(c.start);
    const end = F(c.start + clipDur(c));
    const inF = F(m.type === 'image' ? 0 : c.in);
    const outF = m.type === 'image' ? inF + (end - start) : F(c.out);
    const speedFx =
      Math.abs(c.speed - 1) > 1e-3
        ? `<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><parameterid>speed</parameterid><name>speed</name><value>${(c.speed * 100).toFixed(2)}</value></parameter><parameter><parameterid>variablespeed</parameterid><value>0</value></parameter></effect></filter>`
        : '';
    const level =
      kind === 'audio' && Math.abs(c.volume - 1) > 1e-3
        ? `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name><value>${c.volume.toFixed(3)}</value></parameter></effect></filter>`
        : '';
    const op =
      kind === 'video' && c.opacity < 0.999
        ? `<filter><effect><name>Opacity</name><effectid>opacity</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><parameterid>opacity</parameterid><name>opacity</name><value>${(c.opacity * 100).toFixed(1)}</value></parameter></effect></filter>`
        : '';
    return `<clipitem id="${kind}-${c.id}-${i}"><name>${esc(m.name)}</name><enabled>${c.muted && kind === 'audio' ? 'FALSE' : 'TRUE'}</enabled><duration>${F(m.type === 'image' ? 3600 : m.duration)}</duration>${rate}<start>${start}</start><end>${end}</end><in>${inF}</in><out>${outF}</out>${fileXml(m)}${
      kind === 'audio' ? '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>' : ''
    }${speedFx}${level}${op}</clipitem>`;
  };
  // video tracks bottom → top (FCP order), audio tracks top → bottom
  const vTracks = p.tracks.filter((t) => t.type === 'visual').reverse();
  const aSources: { trackName: string; clips: Clip[] }[] = [];
  for (const t of p.tracks.filter((t) => t.type === 'audio')) aSources.push({ trackName: t.name, clips: p.clips.filter((c) => c.trackId === t.id && c.kind === 'audio') });
  const vXml = vTracks
    .map((t) => {
      const clips = p.clips.filter((c) => c.trackId === t.id && isSourced(c) && mediaOf(p, c)).sort((a, b) => a.start - b.start);
      // video clips with sound get their own audio track entry
      const withSound = clips.filter((c) => c.kind === 'video' && mediaOf(p, c)?.hasAudio && !c.muted);
      if (withSound.length) aSources.unshift({ trackName: t.name + ' ses', clips: withSound });
      return `<track>${clips.map((c, i) => clipItem(c, 'video', i)).join('')}<enabled>${t.hidden ? 'FALSE' : 'TRUE'}</enabled><locked>${t.locked ? 'TRUE' : 'FALSE'}</locked></track>`;
    })
    .join('');
  const aXml = aSources
    .map((a) => `<track>${a.clips.sort((x, y) => x.start - y.start).map((c, i) => clipItem(c, 'audio', i)).join('')}<enabled>TRUE</enabled><locked>FALSE</locked></track>`)
    .join('');
  const markers = p.markers
    .map((m) => `<marker><name>${esc(m.label)}</name><comment>${esc(m.note || '')}</comment><in>${F(m.time)}</in><out>-1</out></marker>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4"><sequence id="seq-1"><name>${esc(p.name)}</name><duration>${total}</duration>${rate}<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media><video><format><samplecharacteristics>${rate}<width>${p.width}</width><height>${p.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>${vXml}</video><audio>${aXml}</audio></media>${markers}</sequence></xmeml>
`;
}

/* ------------------------------------------------------------ CMX3600 EDL */

export function toEdl(p: Project): string {
  const fps = p.fps;
  const tb = Math.round(fps);
  const tc = (s: number) => {
    const f = Math.round(s * fps);
    const fr = f % tb;
    const tot = Math.floor(f / tb);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(Math.floor(tot / 3600))}:${pad(Math.floor(tot / 60) % 60)}:${pad(tot % 60)}:${pad(fr)}`;
  };
  const lines = [`TITLE: ${p.name.toUpperCase().slice(0, 60)}`, 'FCM: NON-DROP FRAME', ''];
  let n = 1;
  const reel = (m: MediaItem) => m.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 8).toUpperCase() || 'AX';
  const main = p.tracks.filter((t) => t.type === 'visual');
  const ev = (c: Clip, chan: 'V' | 'A' | 'B') => {
    const m = mediaOf(p, c)!;
    const srcIn = m.type === 'image' ? 0 : c.in;
    const srcOut = m.type === 'image' ? clipDur(c) : c.out;
    const num = String(n++).padStart(3, '0');
    lines.push(`${num}  ${reel(m).padEnd(8)} ${chan.padEnd(5)} C        ${tc(srcIn)} ${tc(srcOut)} ${tc(c.start)} ${tc(c.start + clipDur(c))}`);
    if (Math.abs(c.speed - 1) > 1e-3) lines.push(`M2   ${reel(m).padEnd(8)}       ${(fps * c.speed).toFixed(1).padStart(5)}                ${tc(srcIn)}`);
    lines.push(`* FROM CLIP NAME: ${m.name}`, `* SOURCE FILE: ${m.path}`, '');
  };
  // lowest visual track = picture; all clips of the bottom-most visual track first, then upper tracks as separate events
  for (const t of [...main].reverse()) for (const c of p.clips.filter((x) => x.trackId === t.id && isSourced(x) && mediaOf(p, x)).sort((a, b) => a.start - b.start)) ev(c, c.kind === 'video' && mediaOf(p, c)?.hasAudio && !c.muted ? 'B' : 'V');
  for (const t of p.tracks.filter((x) => x.type === 'audio')) for (const c of p.clips.filter((x) => x.trackId === t.id && mediaOf(p, x)).sort((a, b) => a.start - b.start)) ev(c, 'A');
  for (const m of p.markers) lines.push(`* LOC: ${tc(m.time)} ${(m.color ? 'YELLOW' : 'YELLOW').padEnd(7)} ${m.label}`);
  return lines.join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------ OpenTimelineIO */

export function toOtio(p: Project): string {
  const fps = p.fps;
  const rt = (v: number) => ({ OTIO_SCHEMA: 'RationalTime.1', rate: fps, value: Math.round(v * fps) });
  const range = (s: number, d: number) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: rt(s), duration: rt(d) });
  const gap = (d: number) => ({ OTIO_SCHEMA: 'Gap.1', name: '', source_range: range(0, d), effects: [], markers: [], metadata: {} });
  const track = (name: string, kind: 'Video' | 'Audio', clips: Clip[]) => {
    const children: unknown[] = [];
    let t = 0;
    for (const c of clips.sort((a, b) => a.start - b.start)) {
      const m = mediaOf(p, c);
      if (!m) continue;
      if (c.start > t + 1e-4) children.push(gap(c.start - t));
      const d = clipDur(c);
      children.push({
        OTIO_SCHEMA: 'Clip.2',
        name: m.name,
        source_range: range(m.type === 'image' ? 0 : c.in, m.type === 'image' ? d : c.out - c.in),
        media_references: {
          DEFAULT_MEDIA: { OTIO_SCHEMA: 'ExternalReference.1', name: m.name, target_url: fileUrl(m.path).replace('file://localhost/', 'file:///'), available_range: m.type === 'image' ? null : range(0, m.duration), metadata: {} },
        },
        active_media_reference_key: 'DEFAULT_MEDIA',
        effects: Math.abs(c.speed - 1) > 1e-3 ? [{ OTIO_SCHEMA: 'LinearTimeWarp.1', name: 'speed', effect_name: 'LinearTimeWarp', time_scalar: c.speed, metadata: {} }] : [],
        markers: [],
        enabled: !(kind === 'Audio' && c.muted),
        metadata: { cutven: { volume: c.volume, opacity: c.opacity } },
      });
      t = c.start + d;
    }
    return { OTIO_SCHEMA: 'Track.1', name, kind, children, effects: [], markers: [], enabled: true, metadata: {} };
  };
  const tracks = [
    ...p.tracks.filter((t) => t.type === 'visual').reverse().map((t) => track(t.name, 'Video', p.clips.filter((c) => c.trackId === t.id && isSourced(c)))),
    ...p.tracks
      .filter((t) => t.type === 'visual')
      .reverse()
      .map((t) => track(t.name + ' ses', 'Audio', p.clips.filter((c) => c.trackId === t.id && c.kind === 'video' && !!mediaOf(p, c)?.hasAudio)))
      .filter((t) => t.children.length),
    ...p.tracks.filter((t) => t.type === 'audio').map((t) => track(t.name, 'Audio', p.clips.filter((c) => c.trackId === t.id))),
  ];
  const tl = {
    OTIO_SCHEMA: 'Timeline.1',
    name: p.name,
    global_start_time: rt(0),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: tracks,
      effects: [],
      markers: p.markers.map((m) => ({ OTIO_SCHEMA: 'Marker.2', name: m.label, marked_range: range(m.time, m.dur || 0), color: 'YELLOW', comment: m.note || '', metadata: {} })),
      enabled: true,
      metadata: {},
    },
    metadata: { cutven: { width: p.width, height: p.height } },
  };
  return JSON.stringify(tl, null, 2);
}
