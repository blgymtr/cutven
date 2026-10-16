'use strict';
/** Utility process: speech recognition off the main process (model inference blocks for seconds). */

const core = require('./asr-core.cjs');

const port = process.parentPort;
let cancelled = false;
let busy = false;

port.on('message', async (e) => {
  const msg = e.data || {};
  if (msg.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (msg.type !== 'run' || busy) return;
  busy = true;
  cancelled = false;
  try {
    const result = await core.transcribe(
      msg.opts,
      (p) => port.postMessage({ type: 'progress', id: msg.id, ...p }),
      () => cancelled,
    );
    port.postMessage({ type: 'done', id: msg.id, result });
  } catch (err) {
    port.postMessage({ type: 'error', id: msg.id, error: String((err && err.message) || err), cancelled });
  } finally {
    busy = false;
  }
});
