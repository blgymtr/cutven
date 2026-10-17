const { app, BrowserWindow, ipcMain, dialog, protocol, shell, clipboard, Menu, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const FFMPEG = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const DEV_URL = process.env.CUTVEN_DEV_URL;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cvm',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true },
  },
]);

app.setName('Cutven');
// the recording studio keeps composing and encoding while the window is minimised or covered
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (process.env.CUTVEN_FAKE_MIC) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  if (process.env.CUTVEN_FAKE_MIC_FILE) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.CUTVEN_FAKE_MIC_FILE);
}
if (process.env.CUTVEN_USER_DATA) app.setPath('userData', process.env.CUTVEN_USER_DATA);
if (process.platform === 'win32') app.setAppUserModelId('com.cutven.app');

let win = null;
let asr = null;
let studio = null;
let pendingScreen = { id: '', audio: false };
const fileFromArgv = (argv) => argv.slice(1).find((a) => a.toLowerCase().endsWith('.cutven') && fs.existsSync(a)) || null;
let pendingOpen = fileFromArgv(process.argv);
const CACHE_DIR = path.join(app.getPath('userData'), 'cache');
const TEMP_DIR = path.join(os.tmpdir(), 'cutven-' + process.pid);
const PROJECTS_DIR = process.env.CUTVEN_PROJECTS_DIR || path.join(app.getPath('documents'), 'Cutven Projeleri');
const RECENT_FILE = path.join(app.getPath('userData'), 'recent.json');
/* ---- version backups + crash recovery */
const VERSIONS_DIR = path.join(app.getPath('userData'), 'versions');
const SESSION_FILE = path.join(app.getPath('userData'), 'session.json');
const VERSION_EVERY = Number(process.env.CUTVEN_VERSION_EVERY_MS || 5 * 60 * 1000);
const VERSION_KEEP = 40;
const lastVersionAt = new Map();
// what the previous run left behind: a session file means it did not close cleanly
let prevSession = null;
try {
  prevSession = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
} catch {}
const versionDir = (p) => path.join(VERSIONS_DIR, crypto.createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 16));
async function snapshotVersion(p, force = false) {
  const now = Date.now();
  if (!force && now - (lastVersionAt.get(p) || 0) < VERSION_EVERY) return;
  if (!(await exists(p))) return;
  lastVersionAt.set(p, now);
  const dir = versionDir(p);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'source.txt'), p, 'utf8');
  await fsp.copyFile(p, path.join(dir, now + '.cutven'));
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.cutven')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - VERSION_KEEP))) await fsp.unlink(path.join(dir, f)).catch(() => {});
}

for (const d of [CACHE_DIR, TEMP_DIR]) fs.mkdirSync(d, { recursive: true });

/* ---------------------------------------------------------------- helpers */

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/webm',
  '.avi': 'video/x-msvideo', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.wma': 'audio/x-ms-wma',
};
const VIDEO_EXT = ['.gif', '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.flv', '.mts', '.m2ts', '.3gp', '.mpg', '.mpeg'];
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.wma', '.aiff', '.aif'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.svg'];

function runFF(args, { onStdout, onStderr, track } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, args, { windowsHide: true });
    if (track) track(proc);
    let stderr = '';
    const out = [];
    proc.stdout.on('data', (d) => (onStdout ? onStdout(d) : out.push(d)));
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr = (stderr + s).slice(-20000);
      if (onStderr) onStderr(s);
    });
    proc.on('error', (e) => resolve({ code: -1, stderr: String(e), stdout: Buffer.alloc(0) }));
    proc.on('close', (code) => resolve({ code, stderr, stdout: Buffer.concat(out) }));
  });
}

async function fileKey(file) {
  const st = await fsp.stat(file);
  return crypto.createHash('sha1').update(file + '|' + st.size + '|' + st.mtimeMs).digest('hex').slice(0, 20);
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- protocol */

function registerProtocol() {
  protocol.handle('cvm', async (req) => {
    try {
      const u = new URL(req.url);
      const file = decodeURIComponent(u.pathname.slice(1));
      const st = await fsp.stat(file);
      const size = st.size;
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const base = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      };
      const range = req.headers.get('range');
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = 0;
        let end = size - 1;
        if (m && m[1]) {
          start = parseInt(m[1], 10);
          if (m[2]) end = Math.min(parseInt(m[2], 10), size - 1);
        } else if (m && m[2]) {
          start = Math.max(0, size - parseInt(m[2], 10));
        }
        if (start >= size || start > end) {
          return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
        }
        const stream = fs.createReadStream(file, { start, end });
        return new Response(Readable.toWeb(stream), {
          status: 206,
          headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
        });
      }
      const stream = fs.createReadStream(file);
      return new Response(Readable.toWeb(stream), { status: 200, headers: { ...base, 'Content-Length': String(size) } });
    } catch (e) {
      return new Response('not found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
  });
}

/* ---------------------------------------------------------------- media */

/** EXIF orientation of a JPEG (1 = normal). Chromium applies it, ffmpeg does not. */
function jpegOrientation(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(131072);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (n < 4 || buf.readUInt16BE(0) !== 0xffd8) return 1;
    let off = 2;
    while (off < n - 10) {
      const marker = buf.readUInt16BE(off);
      if ((marker & 0xff00) !== 0xff00) break;
      const len = buf.readUInt16BE(off + 2);
      if (marker === 0xffe1 && buf.toString('ascii', off + 4, off + 8) === 'Exif') {
        const t = off + 10;
        const le = buf.toString('ascii', t, t + 2) === 'II';
        const r16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
        const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
        const ifd = t + r32(t + 4);
        const cnt = r16(ifd);
        for (let i = 0; i < cnt; i++) {
          const e = ifd + 2 + i * 12;
          if (r16(e) === 0x0112) return r16(e + 8) || 1;
        }
        return 1;
      }
      off += 2 + len;
    }
  } catch {}
  return 1;
}

async function probe(file) {
  if (!(await exists(file))) return { error: 'Dosya bulunamadı' };
  const ext = path.extname(file).toLowerCase();
  const { stderr } = await runFF(['-hide_banner', '-i', file]);
  const info = { duration: 0, width: 0, height: 0, fps: 30, hasAudio: false, hasVideo: false, type: 'video' };
  const dm = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (dm) info.duration = +dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3]);
  const lines = stderr.split(/\r?\n/);
  for (const line of lines) {
    if (/Stream #.*Video:/.test(line) && !/attached pic/.test(line) && !info.hasVideo) {
      const sm = /, (\d{2,5})x(\d{2,5})/.exec(line);
      if (sm) {
        info.width = +sm[1];
        info.height = +sm[2];
        // non-square pixels (DV, anamorphic): use the display size, as the browser does
        const sar = /\[SAR (\d+):(\d+)/.exec(line);
        if (sar && +sar[1] > 0 && +sar[2] > 0 && sar[1] !== sar[2]) info.width = Math.round((info.width * +sar[1]) / +sar[2] / 2) * 2;
      }
      const fm = /(\d+(?:\.\d+)?) fps/.exec(line) || /(\d+(?:\.\d+)?) tbr/.exec(line);
      if (fm) info.fps = parseFloat(fm[1]);
      info.colorspace = /bt709/.test(line) ? 'bt709' : /bt470bg|smpte170m|bt601/.test(line) ? 'bt601' : /bt2020/.test(line) ? 'bt2020' : 'unknown';
      info.hasVideo = true;
    }
    if (/Stream #.*Audio:/.test(line)) info.hasAudio = true;
  }
  const rm = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(stderr) || /rotate\s*:\s*(-?\d+)/.exec(stderr);
  if (rm) {
    const r = Math.abs(Math.round(parseFloat(rm[1]))) % 180;
    if (r === 90) [info.width, info.height] = [info.height, info.width];
  }
  if (IMAGE_EXT.includes(ext)) {
    info.type = 'image';
    info.orientation = ext === '.jpg' || ext === '.jpeg' ? jpegOrientation(file) : 1;
    if (info.orientation >= 5) [info.width, info.height] = [info.height, info.width];
    info.duration = 0;
    info.hasAudio = false;
  } else if (AUDIO_EXT.includes(ext) || (!info.hasVideo && info.hasAudio)) {
    info.type = 'audio';
    info.hasVideo = false;
  } else if (VIDEO_EXT.includes(ext) || info.hasVideo) {
    info.type = 'video';
  }
  if (!info.hasVideo && !info.hasAudio) return { error: 'Desteklenmeyen dosya' };
  if (info.type === 'video' && !info.duration) return { error: 'Video süresi okunamadı' };
  return info;
}

async function makeThumb(file, duration) {
  const key = await fileKey(file);
  const out = path.join(CACHE_DIR, key + '-thumb.jpg');
  if (await exists(out)) return out;
  const t = Math.min(1, (duration || 0) * 0.1);
  await runFF(['-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out]);
  if (!(await exists(out))) await runFF(['-y', '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out]);
  return (await exists(out)) ? out : null;
}

async function makeStrip(file, duration) {
  const key = await fileKey(file);
  const count = Math.max(1, Math.min(40, Math.ceil(duration / 3)));
  const out = path.join(CACHE_DIR, `${key}-strip${count}.jpg`);
  if (await exists(out)) return { path: out, count };
  const args = ['-y'];
  for (let i = 0; i < count; i++) {
    const t = ((i + 0.5) * duration) / count;
    args.push('-ss', t.toFixed(3), '-i', file);
  }
  let graph = '';
  for (let i = 0; i < count; i++) graph += `[${i}:v]scale=-2:72,setsar=1,format=yuvj420p[v${i}];`;
  if (count > 1) graph += Array.from({ length: count }, (_, i) => `[v${i}]`).join('') + `hstack=inputs=${count}[out]`;
  else graph = graph.replace('[v0];', '[out]');
  args.push('-filter_complex', graph, '-map', '[out]', '-frames:v', '1', '-q:v', '5', out);
  const r = await runFF(args);
  if (r.code !== 0 || !(await exists(out))) return null;
  return { path: out, count };
}

async function makeWaveform(file) {
  const key = await fileKey(file);
  const out = path.join(CACHE_DIR, key + '-wave.bin');
  if (await exists(out)) return new Uint8Array(await fsp.readFile(out));
  const RATE = 4000;
  const PER = RATE / 100; // 100 peaks per second
  const peaks = [];
  let acc = 0;
  let n = 0;
  let carry = null;
  await runFF(['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], {
    onStdout: (chunk) => {
      let buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      const len = buf.length - (buf.length % 2);
      for (let i = 0; i < len; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > acc) acc = v;
        if (++n >= PER) {
          peaks.push(Math.min(255, Math.round(Math.sqrt(acc / 32768) * 255)));
          acc = 0;
          n = 0;
        }
      }
      carry = len < buf.length ? buf.subarray(len) : null;
    },
  });
  if (n > 0) peaks.push(Math.min(255, Math.round(Math.sqrt(acc / 32768) * 255)));
  const arr = Uint8Array.from(peaks);
  await fsp.writeFile(out, arr);
  return arr;
}

const proxyJobs = new Map();
async function makeProxy(id, file, kind) {
  const key = await fileKey(file);
  const out = path.join(CACHE_DIR, key + (kind === 'audio' ? '-proxy.m4a' : '-proxy.mp4'));
  if (await exists(out)) return out;
  if (proxyJobs.has(out)) return proxyJobs.get(out);
  const info = await probe(file);
  const total = info.duration || 1;
  const tmp = out + '.part' + path.extname(out);
  const args =
    kind === 'audio'
      ? ['-y', '-i', file, '-vn', '-c:a', 'aac', '-b:a', '192k', '-progress', 'pipe:1', '-nostats', tmp]
      : ['-y', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'libx264', '-preset',
         'veryfast', '-crf', '24', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-progress', 'pipe:1', '-nostats', tmp];
  const job = (async () => {
    let buf = '';
    const r = await runFF(args, {
      onStdout: (d) => {
        buf += d.toString();
        const m = buf.match(/out_time_us=(\d+)/g);
        if (m) {
          const us = parseInt(m[m.length - 1].split('=')[1], 10);
          win?.webContents.send('media:proxy-progress', { id, progress: Math.min(1, us / 1e6 / total) });
          buf = buf.slice(-200);
        }
      },
    });
    if (r.code !== 0) throw new Error('Önizleme dosyası oluşturulamadı');
    await fsp.rename(tmp, out);
    return out;
  })();
  proxyJobs.set(out, job);
  try {
    return await job;
  } finally {
    proxyJobs.delete(out);
  }
}

/* ---------------------------------------------------------------- export */

let exportProc = null;
let exportCancelled = false;

async function runExport({ inputs, graph, output, total }) {
  const graphFile = path.join(TEMP_DIR, `graph-${Date.now()}.txt`);
  await fsp.writeFile(graphFile, graph, 'utf8');
  const args = ['-y', '-hide_banner', ...inputs, '-filter_complex_script', graphFile, ...output, '-progress', 'pipe:1', '-nostats'];
  exportCancelled = false;
  let buf = '';
  const started = Date.now();
  const r = await runFF(args, {
    track: (p) => (exportProc = p),
    onStdout: (d) => {
      buf += d.toString();
      const m = buf.match(/out_time_us=(\d+)/g);
      if (m) {
        const us = parseInt(m[m.length - 1].split('=')[1], 10);
        if (us > 0) win?.webContents.send('export:progress', { progress: Math.min(1, us / 1e6 / total), elapsed: (Date.now() - started) / 1000 });
        buf = buf.slice(-200);
      }
    },
  });
  exportProc = null;
  fsp.unlink(graphFile).catch(() => {});
  if (exportCancelled) {
    const outFile = output[output.length - 1];
    fsp.unlink(outFile).catch(() => {});
    return { ok: false, cancelled: true };
  }
  if (r.code !== 0) {
    const lines = r.stderr.split(/\r?\n/).filter((l) => l.trim());
    return { ok: false, error: lines.slice(-6).join('\n') };
  }
  return { ok: true };
}

/* ---------------------------------------------------------------- projects */

async function readRecent() {
  try {
    return JSON.parse(await fsp.readFile(RECENT_FILE, 'utf8'));
  } catch {
    return [];
  }
}
async function pushRecent(p) {
  const list = (await readRecent()).filter((x) => x !== p);
  list.unshift(p);
  await fsp.writeFile(RECENT_FILE, JSON.stringify(list.slice(0, 30)));
}

async function listProjects() {
  await fsp.mkdir(PROJECTS_DIR, { recursive: true });
  const files = (await fsp.readdir(PROJECTS_DIR)).filter((f) => f.endsWith('.cutven')).map((f) => path.join(PROJECTS_DIR, f));
  const all = Array.from(new Set([...files, ...(await readRecent())]));
  const out = [];
  for (const f of all) {
    try {
      const j = JSON.parse(await fsp.readFile(f, 'utf8'));
      out.push({ path: f, name: j.name, updatedAt: j.updatedAt, thumb: j.thumb || null, width: j.width, height: j.height, duration: j.duration || 0, plannedDate: j.plannedDate || null, status: j.status || null });
    } catch {}
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

function safeName(name) {
  return (name || 'Proje').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 60) || 'Proje';
}

/* ---------------------------------------------------------------- ipc */

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => fn(...a));

  h('dialog:openMedia', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Medya içe aktar',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Medya', extensions: [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT].map((e) => e.slice(1)) },
        { name: 'Tüm dosyalar', extensions: ['*'] },
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });
  h('dialog:openProject', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Proje aç', properties: ['openFile'], filters: [{ name: 'Cutven projesi', extensions: ['cutven'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('dialog:saveProject', async (name) => {
    const r = await dialog.showSaveDialog(win, { title: 'Farklı kaydet', defaultPath: path.join(PROJECTS_DIR, safeName(name) + '.cutven'), filters: [{ name: 'Cutven projesi', extensions: ['cutven'] }] });
    return r.canceled ? null : r.filePath;
  });
  h('dialog:saveExport', async (name, ext) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Dışa aktar',
      defaultPath: path.join(app.getPath('videos'), safeName(name) + '.' + ext),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    return r.canceled ? null : r.filePath;
  });
  h('dialog:saveImage', async (name) => {
    const r = await dialog.showSaveDialog(win, { title: 'Kareyi kaydet', defaultPath: path.join(app.getPath('pictures'), safeName(name) + '.png'), filters: [{ name: 'PNG', extensions: ['png'] }] });
    return r.canceled ? null : r.filePath;
  });
  h('file:writeText', async (p, text) => {
    await fsp.writeFile(p, text, 'utf8');
    return p;
  });
  h('file:readText', async (p) => fsp.readFile(p, 'utf8'));
  h('dialog:saveText', async (name, ext) => {
    const r = await dialog.showSaveDialog(win, { title: 'Kaydet', defaultPath: path.join(app.getPath('documents'), safeName(name) + '.' + ext), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    return r.canceled ? null : r.filePath;
  });
  h('dialog:pickFile', async (title, exts) => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters: exts ? [{ name: title, extensions: exts }, { name: 'Tümü', extensions: ['*'] }] : undefined });
    return r.canceled ? null : r.filePaths[0];
  });

  h('media:probe', (file) => probe(file));
  h('media:thumb', (file, duration) => makeThumb(file, duration));
  h('media:strip', (file, duration) => makeStrip(file, duration));
  h('media:waveform', (file) => makeWaveform(file));
  h('media:proxy', (id, file, kind) => makeProxy(id, file, kind));
  h('fs:exists', (p) => exists(p));

  h('project:list', () => listProjects());
  h('project:defaultPath', async (name) => {
    await fsp.mkdir(PROJECTS_DIR, { recursive: true });
    let base = safeName(name);
    let p = path.join(PROJECTS_DIR, base + '.cutven');
    let i = 2;
    while (await exists(p)) p = path.join(PROJECTS_DIR, `${base} ${i++}.cutven`);
    return p;
  });
  h('project:read', async (p) => {
    const txt = await fsp.readFile(p, 'utf8');
    await pushRecent(p);
    return txt;
  });
  h('project:write', async (p, json) => {
    await snapshotVersion(p).catch(() => {});
    const tmp = p + '.tmp';
    await fsp.writeFile(tmp, json, 'utf8');
    await fsp.rename(tmp, p);
    return true;
  });
  h('project:remember', (p) => pushRecent(p));
  h('versions:list', async (p) => {
    const dir = versionDir(p);
    if (!(await exists(dir))) return [];
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.cutven')).sort().reverse();
    const out = [];
    for (const f of files) {
      const full = path.join(dir, f);
      let info = {};
      try {
        const j = JSON.parse(await fsp.readFile(full, 'utf8'));
        info = { clips: (j.clips || []).length, duration: j.duration || 0, name: j.name };
      } catch {}
      out.push({ file: full, at: Number(f.replace('.cutven', '')), size: (await fsp.stat(full)).size, ...info });
    }
    return out;
  });
  h('versions:snapshot', (p) => snapshotVersion(p, true));
  h('versions:restore', async (p, file) => {
    if (!file.startsWith(VERSIONS_DIR)) throw new Error('bad version');
    await snapshotVersion(p, true);
    await fsp.copyFile(file, p);
    return true;
  });
  h('session:mark', async (p) => {
    if (p) await fsp.writeFile(SESSION_FILE, JSON.stringify({ path: p, at: Date.now(), pid: process.pid }), 'utf8');
    else await fsp.unlink(SESSION_FILE).catch(() => {});
    return true;
  });
  h('session:previous', async () => {
    const s = prevSession;
    prevSession = null;
    if (!s || s.pid === process.pid || !s.path || !(await exists(s.path))) return null;
    return s;
  });
  h('project:trash', async (p) => {
    await shell.trashItem(p);
    const list = (await readRecent()).filter((x) => x !== p);
    await fsp.writeFile(RECENT_FILE, JSON.stringify(list));
    return true;
  });
  ipcMain.on('project:writeSync', (e, p, json) => {
    try {
      fs.writeFileSync(p, json, 'utf8');
      e.returnValue = true;
    } catch {
      e.returnValue = false;
    }
  });

  /* --- voice recording: streamed to a WAV file on disk --- */
  const recs = new Map();
  const wavHeader = (dataLen, sr) => {
    const b = Buffer.alloc(44);
    b.write('RIFF', 0);
    b.writeUInt32LE(36 + dataLen, 4);
    b.write('WAVE', 8);
    b.write('fmt ', 12);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(1, 22);
    b.writeUInt32LE(sr, 24);
    b.writeUInt32LE(sr * 2, 28);
    b.writeUInt16LE(2, 32);
    b.writeUInt16LE(16, 34);
    b.write('data', 36);
    b.writeUInt32LE(dataLen, 40);
    return b;
  };
  const recDir = (projectPath) => path.join(projectPath ? path.dirname(projectPath) : PROJECTS_DIR, 'Cutven Kayıtlar');
  h('rec:begin', async (projectPath, name) => {
    const dir = recDir(projectPath);
    await fsp.mkdir(dir, { recursive: true });
    let i = 1;
    let p;
    do p = path.join(dir, `${safeName(name)} - Kayıt ${i++}.wav`);
    while (await exists(p));
    const fd = fs.openSync(p, 'w');
    fs.writeSync(fd, wavHeader(0, 48000));
    const id = crypto.randomUUID();
    recs.set(id, { fd, path: p, bytes: 0 });
    return { id, path: p };
  });
  h('rec:chunk', (id, bytes) => {
    const r = recs.get(id);
    if (!r) return false;
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    fs.writeSync(r.fd, buf, 0, buf.length, 44 + r.bytes);
    r.bytes += buf.length;
    return true;
  });
  h('rec:end', (id, sr) => {
    const r = recs.get(id);
    if (!r) return null;
    fs.writeSync(r.fd, wavHeader(r.bytes, sr), 0, 44, 0);
    fs.closeSync(r.fd);
    recs.delete(id);
    return r.path;
  });
  h('rec:discard', async (id) => {
    const r = recs.get(id);
    if (!r) return false;
    fs.closeSync(r.fd);
    recs.delete(id);
    await fsp.unlink(r.path).catch(() => {});
    return true;
  });
  h('rec:delete', async (p) => {
    if (path.basename(path.dirname(p)) !== 'Cutven Kayıtlar' || !p.endsWith('.wav')) return false;
    await fsp.unlink(p).catch(() => {});
    return true;
  });

  /* --- generic streamed file (screen / camera recordings) --- */
  const streams = new Map();
  h('stream:begin', async (projectPath, name, ext) => {
    const dir = recDir(projectPath);
    await fsp.mkdir(dir, { recursive: true });
    let i = 1;
    let p;
    do p = path.join(dir, `${safeName(name)} ${i++}.${ext}`);
    while (await exists(p));
    const id = crypto.randomUUID();
    streams.set(id, { fd: fs.openSync(p, 'w'), path: p });
    return { id, path: p };
  });
  h('stream:chunk', (id, bytes) => {
    const s = streams.get(id);
    if (!s) return false;
    fs.writeSync(s.fd, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return true;
  });
  h('stream:end', async (id) => {
    const s = streams.get(id);
    if (!s) return null;
    fs.closeSync(s.fd);
    streams.delete(id);
    // MediaRecorder WebM has no duration / cues: remux so seeking and probing work
    const fixed = s.path.replace(/\.webm$/, '.fixed.webm');
    let r = await runFF(['-y', '-i', s.path, '-c', 'copy', fixed]);
    if (r.code === 0 && (await exists(fixed))) {
      await fsp.unlink(s.path).catch(() => {});
      await fsp.rename(fixed, s.path);
      return s.path;
    }
    // H.264 cannot live in WebM: such streams go to MKV
    await fsp.unlink(fixed).catch(() => {});
    const mkv = s.path.replace(/\.webm$/, '.mkv');
    r = await runFF(['-y', '-i', s.path, '-c', 'copy', mkv]);
    if (r.code === 0 && (await exists(mkv))) {
      await fsp.unlink(s.path).catch(() => {});
      return mkv;
    }
    return s.path;
  });

  h('screen:sources', async (thumbs = true) => {
    // thumbs=false: just the ids (much faster, no thumbnail rendering for every window)
    const list = await desktopCapturer.getSources({ types: thumbs ? ['screen', 'window'] : ['screen'], thumbnailSize: thumbs ? { width: 320, height: 180 } : { width: 0, height: 0 } });
    return list.map((s) => ({ id: s.id, name: s.name, thumb: thumbs ? s.thumbnail.toDataURL() : '', screen: s.id.startsWith('screen') }));
  });
  h('screen:select', (id, audio) => {
    pendingScreen = { id, audio: !!audio };
    return true;
  });

  /* --- import helpers --- */
  h('dialog:openFolder', async (title) => {
    const r = await dialog.showOpenDialog(win, { title: title || 'Klasör içe aktar', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('media:scanFolder', async (dir) => {
    const exts = new Set([...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT, '.gif', '.tif', '.tiff', '.svg']);
    const out = [];
    const walk = async (d, depth) => {
      if (depth > 4 || out.length >= 500) return;
      let ents = [];
      try {
        ents = await fsp.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      ents.sort((a, b) => a.name.localeCompare(b.name, 'tr', { numeric: true }));
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p, depth + 1);
        else if (exts.has(path.extname(e.name).toLowerCase())) out.push(p);
      }
    };
    await walk(dir, 0);
    return out;
  });
  const assetDir = (projectPath) => path.join(projectPath ? path.dirname(projectPath) : PROJECTS_DIR, 'Cutven Medya');
  h('clipboard:image', async (projectPath) => {
    let buf = null;
    let ext = 'png';
    if (typeof clipboard.readImage === 'function') {
      const img = clipboard.readImage();
      if (!img.isEmpty()) buf = img.toPNG();
    } else {
      // Electron 44+: async ClipboardItem API
      for (const item of await clipboard.read()) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (!type) continue;
        buf = Buffer.from(await (await item.getType(type)).arrayBuffer());
        ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/gif': 'gif' }[type] || 'png';
        break;
      }
    }
    if (!buf || !buf.length) return null;
    const dir = assetDir(projectPath);
    await fsp.mkdir(dir, { recursive: true });
    const p = path.join(dir, `Pano ${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`);
    await fsp.writeFile(p, buf);
    return p;
  });
  h('asset:write', async (projectPath, name, bytes) => {
    const dir = assetDir(projectPath);
    await fsp.mkdir(dir, { recursive: true });
    const ext = path.extname(name);
    const base = safeName(path.basename(name, ext));
    let p = path.join(dir, base + ext);
    let i = 2;
    while (await exists(p)) p = path.join(dir, `${base} ${i++}${ext}`);
    await fsp.writeFile(p, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return p;
  });
  /** formats Chromium cannot show (TIFF): convert to PNG in the cache */
  h('media:toPng', async (file) => {
    const out = path.join(CACHE_DIR, (await fileKey(file)) + '-conv.png');
    if (await exists(out)) return out;
    const r = await runFF(['-y', '-i', file, '-frames:v', '1', out]);
    return r.code === 0 ? out : null;
  });

  /* --- app-level files: sound effects library, settings --- */
  const userFile = (sub, name) => path.join(app.getPath('userData'), sub, path.basename(name));
  h('userfile:path', async (sub, name) => {
    const p = userFile(sub, name);
    return (await exists(p)) ? p : null;
  });
  h('userfile:write', async (sub, name, bytes) => {
    const p = userFile(sub, name);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return p;
  });
  const SETTINGS = path.join(app.getPath('userData'), 'settings.json');
  h('settings:get', async () => {
    try {
      return JSON.parse(await fsp.readFile(SETTINGS, 'utf8'));
    } catch {
      return {};
    }
  });
  // one write at a time: two panels saving at once must not drop each other's keys
  let settingsQueue = Promise.resolve();
  h('settings:set', (patch) => {
    const run = async () => {
      let cur = {};
      try {
        cur = JSON.parse(await fsp.readFile(SETTINGS, 'utf8'));
      } catch {}
      const next = { ...cur, ...patch };
      await fsp.writeFile(SETTINGS + '.tmp', JSON.stringify(next, null, 2));
      await fsp.rename(SETTINGS + '.tmp', SETTINGS);
      return next;
    };
    const p = settingsQueue.then(run, run);
    settingsQueue = p.catch(() => {});
    return p;
  });

  /* --- project file edits from the start screen --- */
  h('project:patch', async (p, patch) => {
    const j = JSON.parse(await fsp.readFile(p, 'utf8'));
    Object.assign(j, patch, { updatedAt: Date.now() });
    await fsp.writeFile(p + '.tmp', JSON.stringify(j), 'utf8');
    await fsp.rename(p + '.tmp', p);
    return true;
  });
  /** rename the project and its file; returns the (possibly new) path */
  h('project:rename', async (p, name) => {
    let j = {};
    try {
      j = JSON.parse(await fsp.readFile(p, 'utf8'));
    } catch {}
    j.name = name;
    j.updatedAt = Date.now();
    await fsp.writeFile(p, JSON.stringify(j), 'utf8');
    const target = path.join(path.dirname(p), safeName(name) + '.cutven');
    if (target.toLowerCase() === p.toLowerCase() || (await exists(target))) return p;
    try {
      await fsp.rename(p, target);
    } catch {
      return p;
    }
    const list = (await readRecent()).map((x) => (x === p ? target : x));
    await fsp.writeFile(RECENT_FILE, JSON.stringify(list));
    return target;
  });

  h('export:writeTemp', async (dataUrl, name) => {
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const p = path.join(TEMP_DIR, name);
    await fsp.writeFile(p, Buffer.from(b64, 'base64'));
    return p;
  });
  h('export:start', (job) => runExport(job));
  h('export:measure', async ({ inputs, graph, output }) => {
    const graphFile = path.join(TEMP_DIR, `measure-${Date.now()}.txt`);
    await fsp.writeFile(graphFile, graph, 'utf8');
    exportCancelled = false;
    const r = await runFF(['-hide_banner', '-nostats', ...inputs, '-filter_complex_script', graphFile, ...output], { track: (p) => (exportProc = p) });
    exportProc = null;
    fsp.unlink(graphFile).catch(() => {});
    if (exportCancelled) return { cancelled: true };
    const s = r.stderr;
    const a = s.lastIndexOf('{');
    const b = s.lastIndexOf('}');
    try {
      const j = JSON.parse(s.slice(a, b + 1));
      if (!isFinite(parseFloat(j.input_i))) return { silent: true };
      return { loudness: j };
    } catch {
      return { error: 'Ses analizi başarısız' };
    }
  });
  // which hardware encoders actually work on this machine (cached)
  let hwCache = null;
  h('export:hwEncoders', async () => {
    if (hwCache) return hwCache;
    const list = await runFF(['-hide_banner', '-encoders']);
    const names = ['h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf'].filter((n) => list.stdout.toString().includes(n));
    const ok = [];
    for (const n of names) {
      const r = await runFF(['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2', '-c:v', n, '-f', 'null', '-']);
      if (r.code === 0) ok.push(n);
    }
    hwCache = ok;
    return ok;
  });
  h('export:cancel', () => {
    exportCancelled = true;
    if (exportProc) exportProc.kill();
    return true;
  });

  h('file:writeDataUrl', async (p, dataUrl) => {
    await fsp.writeFile(p, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    return true;
  });
  h('shell:showItem', (p) => shell.showItemInFolder(p));
  h('shell:openPath', (p) => shell.openPath(p));
  h('clipboard:write', (t) => clipboard.writeText(t));
  require('./youtube.cjs').register(h, (ch, d) => win?.webContents.send(ch, d));
  require('./live.cjs').register(h, (ch, d) => win?.webContents.send(ch, d), FFMPEG);
  asr = require('./asr.cjs').register(h, (ch, d) => win?.webContents.send(ch, d), { runFF, TEMP_DIR, userData: app.getPath('userData') });
  studio = require('./studio.cjs').register(h, (ch, d) => win?.webContents.send(ch, d), { runFF, getWin: () => win, safeName });
  /** Scene cuts (seconds, source time) via ffmpeg's scene score. */
  h('media:scenes', async (file, from, to, threshold) => {
    const args = ['-hide_banner', '-ss', String(from || 0)];
    if (to) args.push('-t', String(Math.max(0.1, to - (from || 0))));
    args.push('-i', file, '-an', '-vf', `scale=320:-2,select='gt(scene,${threshold || 0.32})',showinfo`, '-f', 'null', '-');
    const r = await runFF(args);
    const out = [];
    for (const m of r.stderr.matchAll(/pts_time:([\d.]+)/g)) out.push((from || 0) + parseFloat(m[1]));
    return out;
  });
  h('shell:openUrl', (u) => (/^https:\/\/(youtu\.be|www\.youtube\.com|studio\.youtube\.com|console\.cloud\.google\.com)\//.test(u) ? shell.openExternal(u) : false));
  h('app:paths', () => ({ projects: PROJECTS_DIR, version: app.getVersion() }));
  h('app:pendingOpen', () => {
    const f = pendingOpen;
    pendingOpen = null;
    return f;
  });
}

/* ---------------------------------------------------------------- window */

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 660,
    show: false,
    backgroundColor: '#0b0b0d',
    title: 'Cutven',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0b0d', symbolColor: '#9a9aa3', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // closing while the studio records / streams: ask, then let the renderer finish the file first
  win.on('close', (e) => {
    if (!studio?.holdClose()) return;
    e.preventDefault();
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Kaydı bitir ve kapat', 'Vazgeç'],
      defaultId: 1,
      cancelId: 1,
      title: 'Kayıt sürüyor',
      message: 'Kayıt ya da yayın hâlâ sürüyor.',
      detail: 'Kapatırsan kayıt durdurulur ve dosya kaydedilir.',
    });
    if (r === 0) win.webContents.send('studio:closeRequest');
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !(DEV_URL && url.startsWith(DEV_URL))) e.preventDefault();
  });
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.on('closed', () => (win = null));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const f = fileFromArgv(argv);
    if (f && win) win.webContents.send('app:open-file', f);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    const allowed = ['media', 'clipboard-sanitized-write', 'fullscreen', 'speaker-selection'];
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.includes(perm)));
    session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowed.includes(perm));
    // screen recording: the renderer picks a source first ('screen:select'), then calls getDisplayMedia
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        const src = sources.find((s) => s.id === pendingScreen.id) || sources[0];
        cb(pendingScreen.audio ? { video: src, audio: 'loopback' } : { video: src });
      } catch {
        cb({});
      }
    });
    registerProtocol();
    registerIpc();
    createWindow();
  });
  app.on('window-all-closed', () => {
    try {
      fs.rmSync(SESSION_FILE, { force: true });
    } catch {}
    if (exportProc) exportProc.kill();
    asr?.dispose();
    studio?.dispose();
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    app.quit();
  });
}
