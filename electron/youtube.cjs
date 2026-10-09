// YouTube Data API v3: OAuth (installed-app loopback + PKCE), resumable upload, thumbnails.
// The user supplies their own Google OAuth client (Desktop app). Tokens are encrypted with safeStorage.
const { shell, safeStorage, app } = require('electron');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const FILE = () => path.join(app.getPath('userData'), 'youtube.json');
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

async function load() {
  try {
    const j = JSON.parse(await fsp.readFile(FILE(), 'utf8'));
    if (j.secretEnc && safeStorage.isEncryptionAvailable()) j.clientSecret = safeStorage.decryptString(Buffer.from(j.secretEnc, 'base64'));
    if (j.refreshEnc && safeStorage.isEncryptionAvailable()) j.refreshToken = safeStorage.decryptString(Buffer.from(j.refreshEnc, 'base64'));
    return j;
  } catch {
    return {};
  }
}

async function save(j) {
  const out = { clientId: j.clientId || '', channel: j.channel || null };
  const enc = (s) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s).toString('base64') : null);
  if (j.clientSecret) out.secretEnc = enc(j.clientSecret);
  if (j.refreshToken) out.refreshEnc = enc(j.refreshToken);
  await fsp.writeFile(FILE(), JSON.stringify(out, null, 2));
}

let access = { token: '', exp: 0 };

async function token() {
  if (access.token && Date.now() < access.exp - 60000) return access.token;
  const j = await load();
  if (!j.refreshToken) throw new Error('YouTube hesabı bağlı değil');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: j.clientId, client_secret: j.clientSecret || '', refresh_token: j.refreshToken, grant_type: 'refresh_token' }),
  });
  const t = await r.json();
  if (!r.ok) throw new Error(t.error_description || t.error || 'Oturum yenilenemedi');
  access = { token: t.access_token, exp: Date.now() + t.expires_in * 1000 };
  return access.token;
}

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${await token()}`, ...(opts.headers || {}) } });
  const txt = await r.text();
  let j = {};
  try {
    j = JSON.parse(txt);
  } catch {}
  if (!r.ok) throw new Error(j.error?.message || `YouTube hatası (${r.status})`);
  return j;
}

async function channelInfo() {
  const j = await api('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true');
  const c = j.items?.[0];
  return c ? { id: c.id, title: c.snippet.title, thumb: c.snippet.thumbnails?.default?.url || '', subs: c.statistics?.subscriberCount || null } : null;
}

function connect() {
  return new Promise(async (resolve, reject) => {
    const j = await load();
    if (!j.clientId) return reject(new Error('Önce Google OAuth istemci kimliğini gir'));
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/cb') {
        res.writeHead(404).end();
        return;
      }
      const page = (msg) => `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;background:#0b0b0d;color:#eee;display:grid;place-items:center;height:100vh"><div>${msg}</div></body>`;
      if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Bağlantı iptal edildi. Bu sekmeyi kapatabilirsin.'));
        server.close();
        return reject(new Error(u.searchParams.get('error') || 'İzin verilmedi'));
      }
      try {
        const port = server.address().port;
        const r = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: u.searchParams.get('code'),
            client_id: j.clientId,
            client_secret: j.clientSecret || '',
            redirect_uri: `http://127.0.0.1:${port}/cb`,
            grant_type: 'authorization_code',
            code_verifier: verifier,
          }),
        });
        const t = await r.json();
        if (!r.ok) throw new Error(t.error_description || t.error || 'Belirteç alınamadı');
        access = { token: t.access_token, exp: Date.now() + t.expires_in * 1000 };
        j.refreshToken = t.refresh_token || j.refreshToken;
        j.channel = await channelInfo().catch(() => null);
        await save(j);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('✓ Cutven YouTube hesabına bağlandı. Bu sekmeyi kapatıp uygulamaya dönebilirsin.'));
        resolve(j.channel);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Bağlantı başarısız: ' + e.message));
        reject(e);
      } finally {
        server.close();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: j.clientId,
        redirect_uri: `http://127.0.0.1:${port}/cb`,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      }).toString();
      shell.openExternal(auth.toString());
    });
    setTimeout(() => {
      try {
        server.close();
      } catch {}
      reject(new Error('Zaman aşımı: tarayıcıda izin verilmedi'));
    }, 5 * 60 * 1000);
  });
}

/** Resumable upload in 8 MB chunks with progress callback. */
async function upload({ path: file, meta, thumbPath }, onProgress) {
  const size = (await fsp.stat(file)).size;
  const body = {
    snippet: { title: meta.title, description: meta.description, tags: meta.tags, categoryId: meta.category, defaultLanguage: meta.language, defaultAudioLanguage: meta.language },
    status: { privacyStatus: meta.privacy, selfDeclaredMadeForKids: !!meta.madeForKids, ...(meta.publishAt ? { publishAt: meta.publishAt, privacyStatus: 'private' } : {}) },
  };
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await token()}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(size),
      'X-Upload-Content-Type': 'video/mp4',
    },
    body: JSON.stringify(body),
  });
  if (!init.ok) {
    const e = await init.json().catch(() => ({}));
    throw new Error(e.error?.message || `Yükleme başlatılamadı (${init.status})`);
  }
  const loc = init.headers.get('location');
  const CHUNK = 8 * 1024 * 1024;
  const fd = await fsp.open(file, 'r');
  let off = 0;
  let result = null;
  try {
    while (off < size) {
      const len = Math.min(CHUNK, size - off);
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, off);
      let tries = 0;
      for (;;) {
        const r = await fetch(loc, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${await token()}`, 'Content-Length': String(len), 'Content-Range': `bytes ${off}-${off + len - 1}/${size}` },
          body: buf,
        }).catch((e) => ({ ok: false, status: 0, err: e }));
        if (r.status === 308 || r.ok) {
          if (r.ok) result = await r.json();
          break;
        }
        if (++tries > 4) throw new Error('Yükleme kesildi, internet bağlantını kontrol et');
        await new Promise((res) => setTimeout(res, 1500 * tries));
      }
      off += len;
      onProgress(off / size);
    }
  } finally {
    await fd.close();
  }
  if (!result?.id) throw new Error('YouTube yanıtı beklenmedik');
  let thumbOk = null;
  if (thumbPath) {
    try {
      const img = await fsp.readFile(thumbPath);
      await api(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${result.id}`, { method: 'POST', headers: { 'Content-Type': thumbPath.endsWith('.png') ? 'image/png' : 'image/jpeg' }, body: img });
      thumbOk = true;
    } catch (e) {
      thumbOk = e.message;
    }
  }
  return { videoId: result.id, url: `https://youtu.be/${result.id}`, studio: `https://studio.youtube.com/video/${result.id}/edit`, privacy: result.status?.privacyStatus, thumbOk };
}

function register(h, send) {
  h('yt:status', async () => {
    const j = await load();
    return { configured: !!j.clientId, connected: !!j.refreshToken, channel: j.channel || null, clientId: j.clientId || '' };
  });
  h('yt:setClient', async (clientId, clientSecret) => {
    const j = await load();
    j.clientId = String(clientId || '').trim();
    if (clientSecret != null) j.clientSecret = String(clientSecret).trim();
    await save(j);
    return true;
  });
  h('yt:connect', () => connect());
  h('yt:refreshChannel', async () => {
    const j = await load();
    j.channel = await channelInfo();
    await save(j);
    return j.channel;
  });
  h('yt:disconnect', async () => {
    const j = await load();
    if (j.refreshToken) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(j.refreshToken), { method: 'POST' }).catch(() => {});
    delete j.refreshToken;
    j.channel = null;
    access = { token: '', exp: 0 };
    await save(j);
    return true;
  });
  h('yt:upload', (job) => upload(job, (p) => send('yt:progress', { progress: p })));
}

module.exports = { register };
