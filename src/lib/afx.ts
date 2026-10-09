import type { AudioChannel } from '../types';

/**
 * Audio effects. Each preset is defined once as a list of stages; the preview builds
 * them with WebAudio and the export with the equivalent ffmpeg filters (RBJ biquads,
 * tap delays, soft clip) so what you hear is what you get.
 */

type Stage =
  | { t: 'hp' | 'lp'; f: number }
  | { t: 'peak'; f: number; g: number; q: number }
  | { t: 'lowshelf' | 'highshelf'; f: number; g: number }
  | { t: 'gain'; g: number }
  | { t: 'taps'; taps: [number, number][]; dry: number; out: number }
  | { t: 'comp'; thr: number; ratio: number; att: number; rel: number; makeup: number }
  | { t: 'clip'; drive: number }
  | { t: 'denoise' };

export interface AfxDef {
  id: string;
  name: string;
  hint: string;
  stages: Stage[];
  /** only partly audible in the preview */
  exportOnly?: boolean;
}

const hallTaps: [number, number][] = [
  [29, 0.5], [43, 0.42], [61, 0.36], [83, 0.3], [109, 0.26], [139, 0.22], [173, 0.18], [211, 0.15], [257, 0.12], [311, 0.09], [373, 0.07], [443, 0.05],
];
const roomTaps: [number, number][] = [
  [11, 0.4], [19, 0.33], [27, 0.27], [37, 0.22], [49, 0.17], [63, 0.12], [79, 0.08],
];

export const AFX: AfxDef[] = [
  { id: 'none', name: 'Yok', hint: 'Orijinal ses', stages: [] },
  {
    id: 'clear', name: 'Net ses', hint: 'Konuşmayı öne çıkarır: uğultuyu keser, netlik ve sıkıştırma ekler',
    stages: [{ t: 'hp', f: 90 }, { t: 'peak', f: 3200, g: 4, q: 1 }, { t: 'lowshelf', f: 200, g: -2 }, { t: 'comp', thr: -20, ratio: 3, att: 10, rel: 150, makeup: 3 }],
  },
  { id: 'loud', name: 'Güçlü', hint: 'Kompresörle dolgun ve yüksek', stages: [{ t: 'comp', thr: -26, ratio: 5, att: 5, rel: 120, makeup: 7 }] },
  { id: 'denoise', name: 'Gürültü azalt', hint: 'Sabit arka plan gürültüsünü azaltır (tam etkisi dışa aktarmada)', stages: [{ t: 'hp', f: 80 }, { t: 'denoise' }], exportOnly: true },
  { id: 'bass', name: 'Bas', hint: 'Daha dolgun alt frekans', stages: [{ t: 'lowshelf', f: 120, g: 8 }] },
  { id: 'radio', name: 'Radyo', hint: 'Eski radyo tınısı', stages: [{ t: 'hp', f: 400 }, { t: 'lp', f: 3500 }, { t: 'clip', drive: 2 }, { t: 'gain', g: 1.3 }] },
  { id: 'phone', name: 'Telefon', hint: 'Telefon hattı', stages: [{ t: 'hp', f: 700 }, { t: 'lp', f: 2600 }, { t: 'gain', g: 1.8 }] },
  { id: 'megaphone', name: 'Megafon', hint: 'Sert ve cızırtılı', stages: [{ t: 'hp', f: 800 }, { t: 'lp', f: 3000 }, { t: 'clip', drive: 6 }, { t: 'gain', g: 0.9 }] },
  { id: 'echo', name: 'Yankı', hint: 'Belirgin yankı', stages: [{ t: 'taps', taps: [[300, 0.35], [600, 0.15]], dry: 1, out: 0.9 }] },
  { id: 'room', name: 'Oda', hint: 'Küçük oda yansıması', stages: [{ t: 'taps', taps: roomTaps, dry: 1, out: 0.8 }] },
  { id: 'hall', name: 'Salon', hint: 'Geniş salon / reverb', stages: [{ t: 'lp', f: 9000 }, { t: 'taps', taps: hallTaps, dry: 1, out: 0.65 }] },
];

export const afxById = (id?: string) => AFX.find((a) => a.id === (id || 'none')) || AFX[0];

const n = (v: number) => (Math.round(v * 10000) / 10000).toString();
const dbToLin = (db: number) => Math.pow(10, db / 20);

export function afxFfmpeg(id?: string): string[] {
  const out: string[] = [];
  for (const s of afxById(id).stages) {
    switch (s.t) {
      case 'hp':
        out.push(`highpass=f=${s.f}:p=2:t=q:w=0.7071`);
        break;
      case 'lp':
        out.push(`lowpass=f=${s.f}:p=2:t=q:w=0.7071`);
        break;
      case 'peak':
        out.push(`equalizer=f=${s.f}:t=q:w=${s.q}:g=${s.g}`);
        break;
      case 'lowshelf':
        out.push(`lowshelf=f=${s.f}:g=${s.g}:t=s:w=1`);
        break;
      case 'highshelf':
        out.push(`highshelf=f=${s.f}:g=${s.g}:t=s:w=1`);
        break;
      case 'gain':
        out.push(`volume=${n(s.g)}`);
        break;
      case 'taps':
        out.push(
          `aecho=in_gain=${n(s.dry)}:out_gain=${n(s.out)}:delays=${s.taps.map((x) => x[0]).join('|')}:decays=${s.taps.map((x) => n(x[1])).join('|')}`,
        );
        break;
      case 'comp':
        out.push(`acompressor=threshold=${n(dbToLin(s.thr))}:ratio=${s.ratio}:attack=${s.att}:release=${s.rel}:makeup=${n(dbToLin(s.makeup))}:knee=2`);
        break;
      case 'clip':
        out.push(`volume=${s.drive}`, 'asoftclip=type=tanh', `volume=${n(1 / Math.tanh(s.drive))}`);
        break;
      case 'denoise':
        out.push('afftdn=nr=18:nf=-40');
        break;
    }
  }
  return out;
}

export function chanFfmpeg(chan?: AudioChannel): string[] {
  switch (chan) {
    case 'L':
      return ['pan=stereo|c0=c0|c1=c0'];
    case 'R':
      return ['pan=stereo|c0=c1|c1=c1'];
    case 'mid':
      return ['pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1'];
    case 'side':
      return ['pan=stereo|c0=0.5*c0-0.5*c1|c1=0.5*c1-0.5*c0'];
    default:
      return [];
  }
}

/** WebAudio chain: input → [channel] → [effect stages] → returned output. */
export function buildAudioChain(ctx: BaseAudioContext, input: AudioNode, afx?: string, chan?: AudioChannel) {
  const nodes: AudioNode[] = [];
  let cur: AudioNode = input;
  const add = <T extends AudioNode>(node: T): T => {
    cur.connect(node);
    nodes.push(node);
    cur = node;
    return node;
  };
  if (chan) {
    const up = ctx.createGain();
    up.channelCount = 2;
    up.channelCountMode = 'explicit';
    up.channelInterpretation = 'speakers';
    add(up);
    const split = ctx.createChannelSplitter(2);
    up.connect(split);
    const merge = ctx.createChannelMerger(2);
    const w = { L: [1, 0, 1, 0], R: [0, 1, 0, 1], mid: [0.5, 0.5, 0.5, 0.5], side: [0.5, -0.5, -0.5, 0.5] }[chan];
    // out L = w0*inL + w1*inR ; out R = w2*inL + w3*inR
    const mk = (g: number, from: number, to: number) => {
      if (!g) return;
      const gn = ctx.createGain();
      gn.gain.value = g;
      split.connect(gn, from);
      gn.connect(merge, 0, to);
      nodes.push(gn);
    };
    mk(w[0], 0, 0);
    mk(w[1], 1, 0);
    mk(w[2], 0, 1);
    mk(w[3], 1, 1);
    nodes.push(split, merge);
    cur = merge;
  }
  for (const s of afxById(afx).stages) {
    switch (s.t) {
      case 'hp':
      case 'lp': {
        const b = ctx.createBiquadFilter();
        b.type = s.t === 'hp' ? 'highpass' : 'lowpass';
        b.frequency.value = s.f;
        b.Q.value = 0.7071;
        add(b);
        break;
      }
      case 'peak': {
        const b = ctx.createBiquadFilter();
        b.type = 'peaking';
        b.frequency.value = s.f;
        b.Q.value = s.q;
        b.gain.value = s.g;
        add(b);
        break;
      }
      case 'lowshelf':
      case 'highshelf': {
        const b = ctx.createBiquadFilter();
        b.type = s.t;
        b.frequency.value = s.f;
        b.gain.value = s.g;
        add(b);
        break;
      }
      case 'gain': {
        const g = ctx.createGain();
        g.gain.value = s.g;
        add(g);
        break;
      }
      case 'taps': {
        const inG = ctx.createGain();
        inG.gain.value = s.dry;
        add(inG);
        const sum = ctx.createGain();
        sum.gain.value = s.out;
        inG.connect(sum);
        for (const [ms, dec] of s.taps) {
          const d = ctx.createDelay(1);
          d.delayTime.value = ms / 1000;
          const g = ctx.createGain();
          g.gain.value = dec;
          inG.connect(d).connect(g).connect(sum);
          nodes.push(d, g);
        }
        nodes.push(sum);
        cur = sum;
        break;
      }
      case 'comp': {
        const c = ctx.createDynamicsCompressor();
        c.threshold.value = s.thr;
        c.ratio.value = s.ratio;
        c.attack.value = s.att / 1000;
        c.release.value = s.rel / 1000;
        c.knee.value = 2;
        add(c);
        const mk = ctx.createGain();
        mk.gain.value = dbToLin(s.makeup) * 0.6; // Chromium's compressor already adds some makeup gain
        add(mk);
        break;
      }
      case 'clip': {
        // tanh(drive·x) — same as ffmpeg volume=drive → asoftclip(tanh) for |x| ≤ 1
        const ws = ctx.createWaveShaper();
        const curve = new Float32Array(4096);
        for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * s.drive);
        ws.curve = curve;
        ws.oversample = '2x';
        add(ws);
        const post = ctx.createGain();
        post.gain.value = 1 / Math.tanh(s.drive);
        add(post);
        break;
      }
      case 'denoise':
        break;
    }
  }
  return { output: cur, nodes };
}
