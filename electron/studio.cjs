'use strict';
/**
 * Recording studio, main-process side: recordings streamed to disk and finished with ffmpeg,
 * crash recovery, global hotkeys, keeping the window out of captures, metrics.
 */

const { app, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');

const PART = /\.part\.(webm|mkv|mp4)$/i;

function register(h, send, { runFF, getWin, safeName }) {
  const recs = new Map(); // id → { fd, part, base, bytes }
  let busy = false;
  let allowClose = false;

  const exists = (p) => fsp.access(p).then(() => true, () => false);
  const defaultDir = () => path.join(app.getPath('videos'), 'Cutven Kayıtlar');

  /** remux the raw MediaRecorder file into a normal MP4 / MKV; keeps the raw file if that fails */
  async function finalize(part, base, format = 'mp4', audioKbps = 192) {
    const raw = part.replace(/\.part(\.\w+)$/i, '$1');
    const info = (await runFF(['-hide_banner', '-i', part])).stderr;
    const audio = /Audio:\s*(\w+)/.exec(info)?.[1] || '';
    const hasVideo = /Video:/.test(info);
    if (!hasVideo) {
      await fsp.rename(part, raw).catch(() => {});
      return raw;
    }
    let target = `${base}.${format === 'mkv' ? 'mkv' : 'mp4'}`;
    let i = 2;
    while (target !== raw && (await exists(target))) target = `${base} (${i++}).${format === 'mkv' ? 'mkv' : 'mp4'}`;
    const args = ['-y', '-hide_banner', '-v', 'error', '-fflags', '+genpts', '-i', part, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy'];
    if (format !== 'mkv') {
      // Opus / Vorbis in MP4 does not play everywhere (Windows Filmler, Premiere): AAC instead
      if (/opus|vorbis/i.test(audio)) args.push('-c:a', 'aac', '-b:a', `${Math.max(96, Math.min(320, audioKbps | 0))}k`);
      args.push('-movflags', '+faststart');
    }
    const tmp = target + '.tmp' + path.extname(target);
    args.push(tmp);
    const r = await runFF(args);
    if (r.code === 0 && (await exists(tmp)) && (await fsp.stat(tmp)).size > 1024) {
      await fsp.rename(tmp, target);
      await fsp.unlink(part).catch(() => {});
      return target;
    }
    await fsp.unlink(tmp).catch(() => {});
    await fsp.rename(part, raw).catch(() => {});
    return raw;
  }

  h('studio:defaultDir', async () => {
    const d = defaultDir();
    await fsp.mkdir(d, { recursive: true }).catch(() => {});
    return d;
  });

  h('studio:recBegin', async (dir, name, ext) => {
    dir = dir || defaultDir();
    await fsp.mkdir(dir, { recursive: true });
    let base = path.join(dir, safeName(name || 'Kayıt'));
    let i = 2;
    while ((await exists(base + '.mp4')) || (await exists(base + '.mkv')) || (await exists(`${base}.part.${ext}`))) base = path.join(dir, `${safeName(name)} (${i++})`);
    const part = `${base}.part.${String(ext || 'webm').replace(/[^a-z0-9]/gi, '')}`;
    const id = crypto.randomUUID();
    recs.set(id, { fd: fs.openSync(part, 'w'), part, base, bytes: 0 });
    return { id, path: part };
  });

  h('studio:recChunk', (id, bytes) => {
    const r = recs.get(id);
    if (!r) return false;
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    fs.writeSync(r.fd, buf);
    r.bytes += buf.length;
    return true;
  });

  h('studio:recEnd', async (id, opts = {}) => {
    const r = recs.get(id);
    if (!r) throw new Error('Kayıt bulunamadı');
    fs.closeSync(r.fd);
    recs.delete(id);
    const out = await finalize(r.part, r.base, opts.format, opts.audioKbps);
    const st = await fsp.stat(out).catch(() => null);
    return { path: out, bytes: st ? st.size : r.bytes };
  });

  /** *.part.* files nobody is writing to: the app stopped mid-recording; finish them as MKV (safest) */
  h('studio:recover', async (dir) => {
    dir = dir || defaultDir();
    const active = new Set([...recs.values()].map((r) => r.part));
    let files = [];
    try {
      files = (await fsp.readdir(dir)).filter((f) => PART.test(f)).map((f) => path.join(dir, f));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      if (active.has(f)) continue;
      const st = await fsp.stat(f).catch(() => null);
      if (!st || st.size < 4096) {
        await fsp.unlink(f).catch(() => {});
        continue;
      }
      const base = f.replace(PART, '') + ' (kurtarıldı)';
      const p = await finalize(f, base, 'mkv');
      const s2 = await fsp.stat(p).catch(() => null);
      out.push({ path: p, bytes: s2 ? s2.size : st.size });
    }
    return out;
  });

  h('studio:protect', (on) => {
    try {
      getWin()?.setContentProtection(!!on);
    } catch {}
    return true;
  });
  h('studio:minimize', () => getWin()?.minimize());

  /** register { action: accelerator }; returns the ones the OS refused */
  h('studio:hotkeys', (map) => {
    globalShortcut.unregisterAll();
    const failed = [];
    for (const [action, accel] of Object.entries(map || {})) {
      if (!accel) continue;
      try {
        if (!globalShortcut.register(accel, () => send('studio:hotkey', action))) failed.push(accel);
      } catch {
        failed.push(accel);
      }
    }
    return failed;
  });

  h('studio:metrics', () => {
    let cpu = 0;
    let mem = 0;
    for (const m of app.getAppMetrics()) {
      cpu += m.cpu?.percentCPUUsage || 0;
      mem += m.memory?.workingSetSize || 0;
    }
    return { cpu: Math.round((cpu / Math.max(1, os.cpus().length)) * 10) / 10, memMB: Math.round(mem / 1024) };
  });

  h('studio:disk', async (dir) => {
    let d = dir || defaultDir();
    // the folder may not exist yet: ask about the nearest existing parent
    for (let i = 0; i < 6 && !(await exists(d)); i++) d = path.dirname(d);
    try {
      const st = await fsp.statfs(d);
      return st.bavail * st.bsize;
    } catch {
      return null;
    }
  });

  h('studio:shot', async (dataUrl) => {
    const dir = path.join(app.getPath('pictures'), 'Cutven');
    await fsp.mkdir(dir, { recursive: true });
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const file = path.join(dir, `Cutven ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}.png`);
    await fsp.writeFile(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    return file;
  });

  h('studio:busy', (b) => {
    busy = !!b;
    return true;
  });
  h('studio:close', () => {
    allowClose = true;
    getWin()?.close();
    return true;
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());

  return {
    /** the window should not close yet (recording / streaming) */
    holdClose: () => busy && !allowClose,
    dispose: () => {
      for (const r of recs.values()) {
        try {
          fs.closeSync(r.fd);
        } catch {}
      }
    },
  };
}

module.exports = { register };
