import { useEffect, useState } from 'react';
import { SquarePlay as Youtube, Link2, Unlink, Copy, Upload, X, ExternalLink, Wand2, Check, RefreshCw } from 'lucide-react';
import { useStore, toast, get } from '../store';
import { CATEGORIES, LANGS, metaOf, updateMeta, suggestTags, fullDescription, validate, ytStatus, uploadToYoutube, publishAtFromPlan, fmtLocal, type YtStatus } from '../lib/youtube';
import { Toggle, Segmented } from './ui';

function Setup({ st, onDone }: { st: YtStatus; onDone: () => void }) {
  const [id, setId] = useState(st.clientId);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    await window.cv.invoke('yt:setClient', id, secret || null);
    onDone();
  };
  const connect = async () => {
    setBusy(true);
    try {
      if (id !== st.clientId || secret) await window.cv.invoke('yt:setClient', id, secret || null);
      const ch = await window.cv.invoke<YtStatus['channel']>('yt:connect');
      toast(`YouTube bağlandı${ch ? ': ' + ch.title : ''}`, 'success');
      onDone();
    } catch (e: any) {
      toast(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="yt-setup">
      <p className="hint" style={{ marginTop: 0 }}>
        Cutven videoları senin hesabına doğrudan yükleyebilir. Bunun için bir kerelik, ücretsiz bir Google bağlantı anahtarı oluşturman gerekir (yaklaşık 5 dakika):
      </p>
      <ol className="yt-steps">
        <li>
          <a onClick={() => window.cv.invoke('shell:openUrl', 'https://console.cloud.google.com/projectcreate')}>Google Cloud Console</a>’da yeni bir proje oluştur.
        </li>
        <li>
          <a onClick={() => window.cv.invoke('shell:openUrl', 'https://console.cloud.google.com/apis/library/youtube.googleapis.com')}>YouTube Data API v3</a>’ü etkinleştir.
        </li>
        <li>
          <a onClick={() => window.cv.invoke('shell:openUrl', 'https://console.cloud.google.com/apis/credentials/consent')}>OAuth izin ekranı</a>’nda türü “Harici” seç, kendi e-postanı <b>Test kullanıcısı</b> olarak ekle.
        </li>
        <li>
          <a onClick={() => window.cv.invoke('shell:openUrl', 'https://console.cloud.google.com/apis/credentials')}>Kimlik bilgileri</a> → <b>OAuth istemci kimliği oluştur</b> → uygulama türü <b>Masaüstü uygulaması</b>.
        </li>
        <li>Çıkan istemci kimliğini ve gizli anahtarı aşağıya yapıştır, “Bağlan”a bas. Tarayıcıda Google hesabınla izin ver.</li>
      </ol>
      <div className="row">
        <label>İstemci kimliği</label>
        <input className="field" value={id} placeholder="xxxx.apps.googleusercontent.com" onChange={(e) => setId(e.target.value)} spellCheck={false} />
      </div>
      <div className="row">
        <label>Gizli anahtar</label>
        <input className="field" type="password" value={secret} placeholder={st.clientId ? '•••••• (kayıtlı)' : 'GOCSPX-…'} onChange={(e) => setSecret(e.target.value)} spellCheck={false} />
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn primary" disabled={!id.trim() || busy} onClick={connect}>
          <Link2 size={14} /> {busy ? 'Tarayıcıda izin bekleniyor…' : 'Bağlan'}
        </button>
        {id !== st.clientId && (
          <button className="btn ghost" onClick={save}>
            Sadece kaydet
          </button>
        )}
      </div>
      <p className="hint">Anahtarlar bilgisayarında Windows şifrelemesiyle saklanır; şifren Cutven’e hiç girmez. Doğrulanmamış Google projelerinden yüklenen videoları YouTube ilk başta “Özel” tutabilir; Studio’dan herkese açabilirsin.</p>
    </div>
  );
}

function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [v, setV] = useState('');
  const add = (s: string) => {
    const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length) onChange([...tags, ...parts.filter((p) => !tags.includes(p))]);
    setV('');
  };
  return (
    <div className="tag-input">
      {tags.map((t) => (
        <span key={t} className="tag">
          {t}
          <button onClick={() => onChange(tags.filter((x) => x !== t))}>
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        value={v}
        placeholder={tags.length ? '' : 'etiket yaz, Enter'}
        onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value) : setV(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add(v);
          if (e.key === 'Backspace' && !v && tags.length) onChange(tags.slice(0, -1));
        }}
        onBlur={() => v && add(v)}
      />
    </div>
  );
}

export default function YouTubePanel() {
  const project = useStore((s) => s.project)!;
  const m = metaOf(project);
  const [st, setSt] = useState<YtStatus | null>(null);
  const [tpl, setTpl] = useState('');
  const [up, setUp] = useState<{ p: number; busy: boolean; result?: any; error?: string }>({ p: 0, busy: false });
  const refresh = () => ytStatus().then(setSt);
  useEffect(() => {
    refresh();
    window.cv.invoke<{ ytTemplate?: string }>('settings:get').then((s) => setTpl(s.ytTemplate || ''));
    return window.cv.on('yt:progress', (d) => setUp((u) => ({ ...u, p: d.progress })));
  }, []);
  const desc = fullDescription(project, m, tpl);
  const errs = validate(m, desc);
  const bytes = new TextEncoder().encode(desc).length;
  const scheduled = !!m.publishAt;

  const doUpload = async () => {
    const path = get().project?.lastExport;
    if (!path || !(await window.cv.invoke<boolean>('fs:exists', path))) {
      toast('Önce videoyu dışa aktar (Ctrl+E); bittiğinde buradan yüklenir', 'error');
      return;
    }
    setUp({ p: 0, busy: true });
    try {
      const r = await uploadToYoutube(path);
      setUp({ p: 1, busy: false, result: r });
      toast('YouTube’a yüklendi', 'success');
    } catch (e: any) {
      setUp({ p: 0, busy: false, error: String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
    }
  };

  return (
    <div className="yt">
      <div className="yt-card">
        <Youtube size={18} color="#ff0033" />
        {st?.connected ? (
          <>
            {st.channel?.thumb && <img src={st.channel.thumb} className="yt-avatar" />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{st.channel?.title || 'Bağlı hesap'}</b>
              <div className="muted">{st.channel?.subs ? `${Number(st.channel.subs).toLocaleString('tr-TR')} abone` : 'YouTube bağlı'}</div>
            </div>
            <button className="icon-btn sm" title="Kanal bilgisini yenile" onClick={() => window.cv.invoke('yt:refreshChannel').then(refresh)}>
              <RefreshCw size={13} />
            </button>
            <button className="icon-btn sm" title="Bağlantıyı kes" onClick={() => window.cv.invoke('yt:disconnect').then(refresh)}>
              <Unlink size={13} />
            </button>
          </>
        ) : (
          <div style={{ flex: 1 }}>
            <b>YouTube bağlı değil</b>
            <div className="muted">Bilgileri yine de hazırlayıp kopyalayabilirsin</div>
          </div>
        )}
      </div>
      {st && !st.connected && <Setup st={st} onDone={refresh} />}

      <div className="group" style={{ marginTop: 12 }}>
        <div className="group-head">
          <h4>Başlık</h4>
          <span className={'muted' + (m.title.length > 100 ? ' over' : '')}>{m.title.length}/100</span>
        </div>
        <input className="field" value={m.title} onChange={(e) => updateMeta({ title: e.target.value }, 'title')} />
        <p className="hint" style={{ margin: '6px 0 0' }}>İpucu: ilk 60 karakter aramada görünür; anahtar kelimeyi başa koy.</p>
      </div>

      <div className="group">
        <div className="group-head">
          <h4>Açıklama</h4>
          <span className={'muted' + (bytes > 5000 ? ' over' : '')}>{bytes}/5000</span>
        </div>
        <textarea className="field" rows={5} value={m.description} placeholder="Videonun ne hakkında olduğunu 2–3 cümleyle anlat. İlk iki satır aramada görünür." onChange={(e) => updateMeta({ description: e.target.value }, 'desc')} />
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-2)' }}>Bölümleri ekle ({project.markers.length})</span>
          <Toggle on={m.includeChapters} onChange={(v) => updateMeta({ includeChapters: v })} />
        </div>
        <div className="section-title" style={{ margin: '10px 0 6px' }}>
          Her videoya eklenecek şablon
        </div>
        <textarea
          className="field"
          rows={3}
          value={tpl}
          placeholder={'📸 Instagram: @kanalin\n💌 İş birliği: mail@ornek.com'}
          onChange={(e) => setTpl(e.target.value)}
          onBlur={() => window.cv.invoke('settings:set', { ytTemplate: tpl })}
        />
        <details className="yt-preview">
          <summary>Açıklamanın son hali</summary>
          <pre>{desc || '—'}</pre>
        </details>
        <button
          className="btn sm"
          style={{ marginTop: 8 }}
          onClick={() => {
            window.cv.invoke('clipboard:write', `${m.title}\n\n${desc}\n\nEtiketler: ${m.tags.join(', ')}`);
            toast('Başlık, açıklama ve etiketler kopyalandı', 'success');
          }}
        >
          <Copy size={13} /> Hepsini kopyala
        </button>
      </div>

      <div className="group">
        <div className="group-head">
          <h4>Etiketler</h4>
          <button className="btn sm ghost" onClick={() => updateMeta({ tags: [...new Set([...m.tags, ...suggestTags(project)])].slice(0, 20) })}>
            <Wand2 size={13} /> Öner
          </button>
        </div>
        <TagInput tags={m.tags} onChange={(tags) => updateMeta({ tags })} />
        <p className="hint" style={{ margin: '6px 0 0' }}>İlk üç etiket açıklamanın sonuna #hashtag olarak eklenir.</p>
      </div>

      <div className="group">
        <div className="row">
          <label>Kategori</label>
          <select className="field" value={m.category} onChange={(e) => updateMeta({ category: e.target.value })}>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <label>Dil</label>
          <select className="field" value={m.language} onChange={(e) => updateMeta({ language: e.target.value })}>
            {LANGS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <label>Görünürlük</label>
          <Segmented
            value={scheduled ? 'scheduled' : m.privacy}
            onChange={(v) =>
              v === 'scheduled'
                ? updateMeta({ privacy: 'private', publishAt: publishAtFromPlan(project) || new Date(Date.now() + 86400000).toISOString() })
                : updateMeta({ privacy: v as any, publishAt: undefined })
            }
            options={[
              { value: 'private', label: 'Özel' },
              { value: 'unlisted', label: 'Liste dışı' },
              { value: 'public', label: 'Herkese açık' },
              { value: 'scheduled', label: 'Planlı' },
            ]}
          />
        </div>
        {scheduled && (
          <div className="row">
            <label>Yayın zamanı</label>
            <input className="field" type="datetime-local" value={fmtLocal(m.publishAt)} onChange={(e) => updateMeta({ publishAt: e.target.value ? new Date(e.target.value).toISOString() : undefined })} />
          </div>
        )}
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-2)' }}>Çocuklara özel</span>
          <Toggle on={m.madeForKids} onChange={(v) => updateMeta({ madeForKids: v })} />
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-2)' }}>Dışa aktarınca otomatik yükle</span>
          <Toggle on={m.autoUpload} onChange={(v) => updateMeta({ autoUpload: v })} />
        </div>
        {project.thumbDesign ? (
          <p className="hint">
            <Check size={12} color="var(--ok)" /> Tasarladığın küçük resim de yüklenecek.
          </p>
        ) : (
          <p className="hint">Küçük resim tasarlarsan o da otomatik yüklenir.</p>
        )}
      </div>

      {errs.length > 0 && (
        <div className="rec-error" style={{ marginBottom: 10 }}>
          {errs.join(' ')}
        </div>
      )}

      {st?.connected && (
        <div className="group">
          <button className="btn primary" style={{ width: '100%' }} disabled={up.busy || errs.length > 0} onClick={doUpload}>
            <Upload size={14} /> {up.busy ? `Yükleniyor %${Math.round(up.p * 100)}` : project.yt?.videoId ? 'Tekrar yükle (yeni video)' : 'Son dışa aktarımı yükle'}
          </button>
          {up.busy && (
            <div className="progress" style={{ marginTop: 8 }}>
              <i style={{ width: `${up.p * 100}%` }} />
            </div>
          )}
          {up.error && <div className="rec-error">{up.error}</div>}
          {(up.result || project.yt?.videoId) && (
            <div className="yt-done">
              <Check size={14} color="var(--ok)" /> Yüklendi
              <button className="btn sm ghost" onClick={() => window.cv.invoke('shell:openUrl', `https://studio.youtube.com/video/${up.result?.videoId || project.yt?.videoId}/edit`)}>
                <ExternalLink size={12} /> Studio’da aç
              </button>
            </div>
          )}
          {up.result?.thumbOk && up.result.thumbOk !== true && <p className="hint">Küçük resim yüklenemedi: {up.result.thumbOk} (kanalda telefon doğrulaması gerekebilir).</p>}
        </div>
      )}
    </div>
  );
}
