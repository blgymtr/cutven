// Live streaming: the renderer composes the scene and streams WebM chunks over IPC;
// ffmpeg transcodes to H.264/AAC and pushes FLV to an RTMP server (YouTube Live by default),
// optionally recording a local copy at the same time.
const { safeStorage, app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const CFG = () => path.join(app.getPath('userData'), 'live.json');
const DEFAULT_URL = 'rtmp://a.rtmp.youtube.com/live2';

async function load() {
  try {
    const j = JSON.parse(await fsp.readFile(CFG(), 'utf8'));
    if (j.keyEnc && safeStorage.isEncryptionAvailable()) j.key = safeStorage.decryptString(Buffer.from(j.keyEnc, 'base64'));
    return j;
  } catch {
    return {};
  }
}

let proc = null;
let started = 0;
let lastErr = '';
let stopping = false;

function register(h, send, FFMPEG) {
  h('live:config', async () => {
    const j = await load();
    const k = j.key || '';
    return { url: j.url || DEFAULT_URL, hasKey: !!k, masked: k ? k.slice(0, 4) + '••••' + k.slice(-3) : '' };
  });
  h('live:saveConfig', async (url, key) => {
    const j = await load();
    j.url = String(url || DEFAULT_URL).trim();
    if (key != null && String(key).trim()) j.key = String(key).trim();
    const out = { url: j.url };
    if (j.key && safeStorage.isEncryptionAvailable()) out.keyEnc = safeStorage.encryptString(j.key).toString('base64');
    await fsp.writeFile(CFG(), JSON.stringify(out, null, 2));
    return true;
  });
  h('live:start', async (o) => {
    if (proc) throw new Error('Zaten yayındasın');
    const j = await load();
    // o.testFile: stream into a local file instead of RTMP (used for checks)
    const target = o.testFile ? o.testFile : `${(j.url || DEFAULT_URL).replace(/\/$/, '')}/${j.key || ''}`;
    if (!o.testFile && !j.key) throw new Error('Yayın anahtarı girilmemiş');
    const vb = Math.round(o.videoKbps || 4500);
    const fps = o.fps || 30;
    const args = [
      '-y', '-hide_banner', '-loglevel', 'info', '-fflags', '+genpts', '-f', 'webm', '-i', 'pipe:0',
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
      '-b:v', `${vb}k`, '-maxrate', `${vb}k`, '-bufsize', `${vb * 2}k`, '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-r', String(fps),
      '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
      '-f', 'flv', '-flvflags', 'no_duration_filesize', target,
    ];
    lastErr = '';
    stopping = false;
    proc = spawn(FFMPEG, args, { windowsHide: true });
    started = Date.now();
    let buf = '';
    proc.stderr.on('data', (d) => {
      buf = (buf + d.toString()).slice(-4000);
      const tail = buf.slice(-500);
      const all = [...tail.matchAll(/frame=\s*(\d+)\s+fps=\s*([\d.]+).*?bitrate=\s*([\d.]+|N\/A)(?:kbits\/s)?.*?speed=\s*([\d.]+|N\/A)x?/g)];
      const m = all[all.length - 1];
      if (m) send('live:stats', { frames: +m[1], fps: +m[2], kbps: parseFloat(m[3]) || 0, speed: parseFloat(m[4]) || 0, secs: (Date.now() - started) / 1000 });
      const lines = buf.split(/\r?\n/).filter((l) => /error|failed|refused|denied|invalid|exists|exiting/i.test(l));
      if (lines.length) lastErr = lines[lines.length - 1].replace(j.key || '\u0000', '••••');
    });
    proc.stdin.on('error', () => {});
    proc.on('close', (code) => {
      send('live:ended', { code, error: code || !stopping ? lastErr || 'Yayın beklenmedik şekilde kapandı' : null, secs: (Date.now() - started) / 1000, log: process.env.CUTVEN_LIVE_DEBUG ? buf.slice(-1500) : undefined });
      proc = null;
    });
    return true;
  });
  h('live:chunk', (bytes) => {
    if (!proc || !proc.stdin.writable) return false;
    proc.stdin.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return true;
  });
  h('live:stop', async () => {
    if (!proc) return true;
    const p = proc;
    stopping = true;
    p.stdin.end();
    await new Promise((r) => {
      const t = setTimeout(() => {
        try {
          p.kill();
        } catch {}
        r();
      }, 8000);
      p.on('close', () => {
        clearTimeout(t);
        r();
      });
    });
    return true;
  });
  h('live:recordPath', async (projectPath) => {
    const dir = path.join(projectPath ? path.dirname(projectPath) : app.getPath('videos'), 'Cutven Kayıtlar');
    await fsp.mkdir(dir, { recursive: true });
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return path.join(dir, `Canlı yayın ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.mkv`);
  });
  app.on('before-quit', () => {
    if (proc) proc.kill();
  });
}

module.exports = { register };
