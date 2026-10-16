'use strict';
/**
 * Speech recognition (Whisper, ONNX on the CPU via transformers.js).
 *
 * Input is 16 kHz mono float PCM of the timeline. Instead of letting Whisper walk the file in
 * 30 s windows (it hallucinates on silence and music and drops text when its own timestamps go
 * wrong) the audio is first split at pauses (energy VAD). Each window — roughly a sentence, at most
 * MAX_WIN seconds — is recognised on its own, and its speech regions are returned with the text
 * so the renderer can lay the words over the time where someone actually speaks.
 *
 * Electron-free on purpose: asr-worker.cjs runs it in a utility process, tests run it in Node.
 */

const fs = require('fs');

const SR = 16000;
const FRAME = 320; // 20 ms
const MAX_WIN = 15; // s of audio per recognition window
const MIN_REGION = 0.25;

/**
 * Models offered in the app. dtypes are tried in order (a repo may not ship every variant).
 * The encoder decides accuracy, the decoder speed: full-precision encoder + 8-bit decoder where affordable.
 */
const MODELS = {
  base: { id: 'Xenova/whisper-base', dtypes: [{ encoder_model: 'fp32', decoder_model_merged: 'q8' }, 'q8', 'fp32'] },
  small: { id: 'Xenova/whisper-small', dtypes: [{ encoder_model: 'fp32', decoder_model_merged: 'q8' }, 'q8', 'fp32'] },
  turbo: { id: 'onnx-community/whisper-large-v3-turbo', dtypes: ['q8', { encoder_model: 'fp16', decoder_model_merged: 'q4' }] },
};

/* ------------------------------------------------------------------ VAD */

/** Frame energies in dB (20 ms frames). */
function frameDb(a) {
  const n = Math.floor(a.length / FRAME);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * FRAME, e = j + FRAME; j < e; j++) s += a[j] * a[j];
    db[i] = 10 * Math.log10(s / FRAME + 1e-10);
  }
  return db;
}

/** Speech regions [start, end] in seconds. Adaptive threshold between the noise floor and the loud parts. */
function speechRegions(a) {
  const db = frameDb(a);
  const n = db.length;
  if (!n) return [];
  const sorted = Array.from(db).sort((x, y) => x - y);
  const floor = sorted[Math.floor(n * 0.1)];
  const top = sorted[Math.floor(n * 0.95)];
  if (top < -55) return []; // practically silent
  const thr = Math.max(floor + 10, top - 30, -60);
  const raw = [];
  let st = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && db[i] >= thr;
    if (on && st < 0) st = i;
    if (!on && st >= 0) {
      raw.push([st * 0.02, i * 0.02]);
      st = -1;
    }
  }
  // pad, bridge the short gaps between words, drop clicks
  const dur = a.length / SR;
  const out = [];
  for (const [s0, e0] of raw) {
    const s = Math.max(0, s0 - 0.12);
    const e = Math.min(dur, e0 + 0.18);
    const last = out[out.length - 1];
    if (last && s - last[1] < 0.35) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out.filter(([s, e]) => e - s >= MIN_REGION).map(([s, e]) => [round2(s), round2(e)]);
}

const round2 = (v) => Math.round(v * 100) / 100;

/** Quietest point of [from, to] (s), used to cut speech that never pauses. */
function quietest(db, from, to) {
  let best = from;
  let bv = Infinity;
  for (let i = Math.floor(from / 0.02); i < Math.min(db.length, Math.floor(to / 0.02)); i++) {
    if (db[i] < bv) {
      bv = db[i];
      best = i * 0.02;
    }
  }
  return best;
}

/**
 * Group regions into recognition windows: a new window starts at a clear pause (≥ 0.8 s) or when
 * the window would get longer than MAX_WIN (then it is cut at its largest inner pause).
 */
function windows(regions, db) {
  // split regions that are too long by themselves at their quietest point
  const regs = [];
  for (let [s, e] of regions) {
    while (e - s > MAX_WIN) {
      const cut = quietest(db, s + MAX_WIN * 0.55, s + MAX_WIN * 0.95);
      regs.push([s, cut]);
      s = cut;
    }
    regs.push([s, e]);
  }
  const out = [];
  let cur = [];
  const flush = () => {
    if (cur.length) out.push(cur);
    cur = [];
  };
  for (const r of regs) {
    if (!cur.length) {
      cur.push(r);
      continue;
    }
    const gap = r[0] - cur[cur.length - 1][1];
    if (gap >= 0.8) {
      flush();
      cur.push(r);
      continue;
    }
    if (r[1] - cur[0][0] > MAX_WIN) {
      // too long: cut at the largest pause after which the rest (plus this region) still fits
      let gi = cur.length; // cut right before this region
      let gv = gap;
      for (let i = 1; i < cur.length; i++) {
        const g = cur[i][0] - cur[i - 1][1];
        if (r[1] - cur[i][0] <= MAX_WIN && g >= gv) {
          gv = g;
          gi = i;
        }
      }
      const rest = cur.slice(gi);
      cur = cur.slice(0, gi);
      flush();
      cur = rest;
    }
    cur.push(r);
  }
  flush();
  return out.map((rs) => ({ start: rs[0][0], end: rs[rs.length - 1][1], regions: rs }));
}

/* ------------------------------------------------------------------ text cleanup */

const JUNK = [
  /altyaz[ıi]\s*m\.?\s*k\.?/i,
  /subtitles? (by|from)/i,
  /amara\.org/i,
  /www\.\S+\.(com|org|net)/i,
  /^\W*$/,
  // sound descriptions instead of speech: "[Müzik]", "(alkış)", "♪ ♪"
  /^[\s[(♪*]*(müzik|music|alkış|alkis|applause|gülüşmeler|laughter|sessizlik|silence)?[\s\])♪*.]*$/i,
];

/** Remove Whisper's loops ("ne? ne? ne? ne?", ".com.com.com") and known filler hallucinations. */
function clean(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  // a short piece with letters repeated 4+ times in a row → once (numbers like 1000000 stay)
  t = t.replace(/(.{2,40}?)(?:\s*\1){3,}/gu, (m, unit) => (/\p{L}/u.test(unit) ? unit : m));
  t = t.replace(/^[\s.,;:!?-]+/, '').trim();
  // the same word three or more times in a row ("comment, comment, comment") → once
  t = collapse(t, 3);
  if (JUNK.some((re) => re.test(t))) return '';
  return t;
}

const words = (t) =>
  t
    .toLocaleLowerCase('tr-TR')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Whisper got stuck in a loop: a few words repeated over and over. */
function looped(text) {
  const w = words(text);
  return w.length >= 6 && new Set(w).size / w.length < 0.45;
}

/**
 * Drop words that repeat the previous one ("benim benim benim" → "benim").
 * minRun: only runs at least this long are collapsed (2 = every repeat; used for looped results).
 */
function collapse(text, minRun = 2) {
  const toks = text.split(/\s+/).filter(Boolean);
  const keys = toks.map((t) => words(t).join(' '));
  const out = [];
  for (let i = 0; i < toks.length; ) {
    let j = i + 1;
    while (j < toks.length && keys[i] && keys[j] === keys[i]) j++;
    if (j - i >= minRun) out.push(toks[j - 1]);
    else for (let k = i; k < j; k++) out.push(toks[k]);
    i = j;
  }
  return out.join(' ');
}

/* ------------------------------------------------------------------ recognition */

/** encoder + decoder weights of the model are in the cache (written atomically, so present = complete) */
function isCached(cacheDir, id) {
  if (!cacheDir) return false;
  try {
    const files = fs.readdirSync(require('path').join(cacheDir, ...id.split('/'), 'onnx'));
    return files.some((f) => /^encoder_model.*\.onnx$/.test(f)) && files.some((f) => /^decoder_model_merged.*\.onnx$/.test(f));
  } catch {
    return false;
  }
}

let tf = null;

/**
 * transformers.js loads `sharp` (native image library) at startup although speech recognition never
 * touches images: hand it a stub so a missing / unloadable sharp binary can't break captions,
 * and the app doesn't have to ship it.
 */
function loadTransformers() {
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'sharp') {
      return function sharpUnavailable() {
        throw new Error('Görüntü işleme bu bileşende yok');
      };
    }
    return orig.call(this, req, ...rest);
  };
  try {
    return require('@huggingface/transformers');
  } finally {
    Module._load = orig;
  }
}
const loaded = new Map(); // model key → pipeline

async function getPipeline(key, opts, onProgress) {
  const spec = opts.modelId ? { id: opts.modelId, dtypes: opts.dtypes || ['q8'] } : MODELS[key];
  if (!spec) throw new Error('Bilinmeyen model: ' + key);
  const cacheKey = spec.id;
  if (loaded.has(cacheKey)) return loaded.get(cacheKey);
  if (!tf) tf = loadTransformers();
  const { env, pipeline } = tf;
  if (opts.cacheDir) env.cacheDir = opts.cacheDir;
  if (opts.localModelPath) {
    env.localModelPath = opts.localModelPath;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
  } else {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
  }
  // reading an already downloaded model also reports progress: call it loading, not downloading
  const cached = isCached(opts.cacheDir, spec.id);
  let lastErr = null;
  for (const dtype of spec.dtypes) {
    try {
      const p = await pipeline('automatic-speech-recognition', spec.id, {
        dtype,
        device: 'cpu',
        progress_callback: (info) => {
          if (info.status === 'progress_total' && info.total > 0)
            onProgress({ phase: cached ? 'load' : 'download', progress: info.loaded / info.total, loaded: info.loaded, total: info.total });
        },
      });
      loaded.set(cacheKey, p);
      return p;
    } catch (e) {
      lastErr = e;
      // a missing variant of the weights: try the next one; anything else (network, disk) is final
      if (!/could not locate|not found|404|no such file/i.test(String(e && e.message))) break;
    }
  }
  throw lastErr || new Error('Model yüklenemedi');
}

/**
 * Transcribe a 16 kHz mono f32le file.
 * opts: { pcmPath, model, language ('turkish' | 'english' | null = auto), cacheDir, modelId?, dtypes?, localModelPath? }
 * onProgress({ phase: 'download' | 'load' | 'transcribe', progress 0..1, text? })
 * isCancelled(): boolean
 */
async function transcribe(opts, onProgress = () => {}, isCancelled = () => false) {
  const buf = fs.readFileSync(opts.pcmPath);
  const audio = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  const db = frameDb(audio);
  const regions = speechRegions(audio);
  const wins = windows(regions, db);
  if (!wins.length) return { segments: [], speech: 0 };
  onProgress({ phase: 'load', progress: 0 });
  const asr = await getPipeline(opts.model || 'small', opts, onProgress);
  const total = wins.reduce((s, w) => s + (w.end - w.start), 0);
  let done = 0;
  const segments = [];
  onProgress({ phase: 'transcribe', progress: 0 });
  for (const w of wins) {
    if (isCancelled()) throw new Error('cancelled');
    const a = audio.subarray(Math.floor(w.start * SR), Math.min(audio.length, Math.ceil(w.end * SR)));
    const len = w.end - w.start;
    const run = async (extra) => {
      const out = await asr(a, {
        language: opts.language || null,
        task: 'transcribe',
        // ~3 words/s, ~3 tokens per Turkish word, plus headroom; never more than the decoder allows
        max_new_tokens: Math.min(440, Math.ceil(len * 12) + 16),
        no_repeat_ngram_size: 6,
        ...extra,
      });
      return clean(Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text);
    };
    let text = await run({});
    // like openai-whisper: a degenerate (looping) result is decoded again with some randomness
    for (const temperature of [0.5, 0.9]) {
      if (!looped(text) || isCancelled()) break;
      const again = await run({ do_sample: true, temperature, top_k: 0 });
      if (!looped(again) || words(again).length < words(text).length) text = again;
    }
    if (looped(text)) text = collapse(text);
    if (text) segments.push({ start: w.start, end: w.end, regions: w.regions, text });
    done += len;
    onProgress({ phase: 'transcribe', progress: Math.min(1, done / total), text });
  }
  return { segments, speech: total };
}

module.exports = { transcribe, speechRegions, windows, frameDb, clean, looped, collapse, MODELS, SR };
