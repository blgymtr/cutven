'use strict';
/**
 * Automatic captions: the renderer mixes the speech of the timeline into 16 kHz PCM (asr:extract),
 * then a utility process recognises it (asr:transcribe). The Whisper model is downloaded once into
 * userData/models and works offline afterwards.
 */

const { utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { MODELS } = require('./asr-core.cjs');

function register(h, send, { runFF, TEMP_DIR, userData }) {
  const MODELS_DIR = path.join(userData, 'models');
  let child = null;
  let job = null; // { id, resolve, timer }
  let extractProc = null;
  let extractCancelled = false;
  let idleTimer = null;
  let seq = 0;

  const stopChild = () => {
    if (child) {
      try {
        child.kill();
      } catch {}
    }
    child = null;
  };

  const ensureChild = () => {
    if (child) return child;
    const c = utilityProcess.fork(path.join(__dirname, 'asr-worker.cjs'), [], { serviceName: 'Cutven Altyazi', stdio: 'ignore' });
    c.on('message', (m) => {
      if (!job || !m || m.id !== job.id) return;
      if (m.type === 'progress') send('asr:progress', { phase: m.phase, progress: m.progress, text: m.text, loaded: m.loaded, total: m.total });
      else if (m.type === 'done') finish({ ok: true, ...m.result });
      else if (m.type === 'error') finish(m.cancelled ? { ok: false, cancelled: true } : { ok: false, error: m.error });
    });
    c.on('exit', () => {
      if (child === c) child = null;
      if (job) finish(job.cancelled ? { ok: false, cancelled: true } : { ok: false, error: 'Konuşma tanıma işlemi beklenmedik şekilde kapandı (bellek yetersiz olabilir).' });
    });
    child = c;
    return c;
  };

  const finish = (result) => {
    const j = job;
    if (!j) return;
    job = null;
    clearTimeout(j.timer);
    j.resolve(result);
    // keep the model in memory for a while (a second run starts instantly), then free the RAM
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stopChild, 3 * 60 * 1000);
  };

  /** remove downloads that were cut off (the cache writes *.tmp.* first) */
  const cleanPartial = async (dir) => {
    let ents = [];
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await cleanPartial(p);
      else if (/\.tmp\.\w+\.\w+$/.test(e.name)) await fsp.unlink(p).catch(() => {});
    }
  };

  h('asr:tempPath', () => path.join(TEMP_DIR, `asr-${Date.now()}.f32`));

  /** Render the speech mix (an audio-only export job) to raw 16 kHz mono float PCM. */
  h('asr:extract', async ({ inputs, graph, output }) => {
    const graphFile = path.join(TEMP_DIR, `asr-graph-${Date.now()}.txt`);
    await fsp.writeFile(graphFile, graph, 'utf8');
    extractCancelled = false;
    const r = await runFF(['-y', '-hide_banner', '-nostats', ...inputs, '-filter_complex_script', graphFile, ...output], { track: (p) => (extractProc = p) });
    extractProc = null;
    fsp.unlink(graphFile).catch(() => {});
    if (extractCancelled) return { ok: false, cancelled: true };
    if (r.code !== 0) {
      const lines = r.stderr.split(/\r?\n/).filter((l) => l.trim());
      return { ok: false, error: lines.slice(-4).join('\n') };
    }
    return { ok: true };
  });

  h('asr:transcribe', async (opts) => {
    if (job) return { ok: false, error: 'Zaten bir altyazı işlemi sürüyor' };
    clearTimeout(idleTimer);
    await fsp.mkdir(MODELS_DIR, { recursive: true });
    await cleanPartial(MODELS_DIR);
    const id = ++seq;
    const pcmPath = opts.pcmPath;
    const result = await new Promise((resolve) => {
      job = { id, resolve, cancelled: false, timer: null };
      try {
        ensureChild().postMessage({ type: 'run', id, opts: { pcmPath, model: opts.model, language: opts.language, cacheDir: MODELS_DIR } });
      } catch (e) {
        finish({ ok: false, error: String((e && e.message) || e) });
      }
    });
    if (pcmPath && pcmPath.startsWith(TEMP_DIR)) fsp.unlink(pcmPath).catch(() => {});
    return result;
  });

  h('asr:cancel', () => {
    extractCancelled = true;
    if (extractProc) extractProc.kill();
    if (job) {
      job.cancelled = true;
      try {
        child?.postMessage({ type: 'cancel' });
      } catch {}
      // the worker checks between sentences; a model download or a long sentence is cut hard
      const j = job;
      j.timer = setTimeout(() => job === j && stopChild(), 1500);
    }
    return true;
  });

  /** Which models are already downloaded (works offline). */
  h('asr:models', async () => {
    const out = {};
    for (const [key, m] of Object.entries(MODELS)) {
      const dir = path.join(MODELS_DIR, ...m.id.split('/'), 'onnx');
      let files = [];
      try {
        files = await fsp.readdir(dir);
      } catch {}
      out[key] = files.some((f) => /^encoder_model.*\.onnx$/.test(f)) && files.some((f) => /^decoder_model_merged.*\.onnx$/.test(f));
    }
    return out;
  });

  return { dispose: stopChild };
}

module.exports = { register };
