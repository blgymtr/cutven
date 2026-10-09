<p align="center">
  <img src="build/icon.png" width="96" alt="Cutven simgesi" />
</p>

<h1 align="center">Cutven</h1>

<p align="center">
  <b>YouTube içerik üreticileri için sade, hızlı ve tamamen çevrimdışı video editörü.</b><br/>
  CapCut'a ihtiyaç duymadan; hesap yok, abonelik yok, filigran yok.
</p>

---

## Neden Cutven?

Cutven, bir YouTube videosunu fikir aşamasından yayına kadar tek bir masaüstü uygulamasında hazırlaman için tasarlandı. Kurgu, seslendirme, küçük resim, intro/outro ve yayın takvimi aynı yerde. Her şey kendi bilgisayarında çalışır; dosyaların hiçbir yere yüklenmez.

Önizlemede ne görüyorsan dışa aktarılan videoda da birebir o çıkar: renkler, yazılar, geçişler ve ses seviyeleri aynı hesapla üretilir.

## Özellikler

### 🎬 Kurgu
- Çok izli zaman çizelgesi: taşıma, kırpma, bölme (`S`), kopyala/yapıştır, mıknatıslı hizalama
- Film şeridi ve ses dalga formu görünümü, yakınlaştırma
- Tuval üzerinde sürükleyerek konum, ölçek ve döndürme; merkez kılavuzları
- Hız (0,25× – 4×), opaklık, renk ayarları ve 12 hazır filtre
- Düz renk klipleri (arka plan, başlık kartı)
- Geri al / yinele, otomatik kayıt

### ✨ Geçişler
Solma, Çözülme, Siyaha, Beyaz flaş, dört yöne kaydırma, Yakınlaş, Döndür ve Bulanık. Klibin başına ya da sonuna sürüklemen yeterli.

### 🔤 Metin
YouTube'a uygun hazır stiller (başlık, altyazı, alt bant, "Abone ol"), 8 yazı tipi, kontur, gölge ve arka plan kutusu.

### 🎙️ Seslendirme
- Video oynarken kaydet; büyük kayıt düğmesi, 3-2-1 geri sayım
- Duraklat / devam et, baştan al, geri sarma
- Canlı ses seviyesi ve dalga formu, mikrofon seçimi, gürültü engelleme
- Kayıt bitince otomatik olarak doğru yere "Seslendirme" izine eklenir
- Senaryonu akan metin (prompter) olarak gösterir

### ⏱️ Tempo koçu
Videonun kurgu hızına ve müziğin temposuna (BPM) bakıp hangi hızda okuman gerektiğini söyler. Senaryonun süreye sığıp sığmadığını hesaplar, kaydını analiz eder ve kayıt sırasında canlı olarak "hızlısın / yavaşsın" der.

### 🔊 Ses
- **Anahtar kareler (◆):** sesi istediğin noktada kıs ya da aç (`K`)
- **Otomatik kısma (ducking):** konuştuğun yerlerde müziği kendiliğinden kısar
- Klip efektleri: Net ses, Güçlü, Bas, Radyo, Telefon, Megafon, Yankı, Oda, Salon, Gürültü azalt
- 17 hazır ses efekti (whoosh, boom, riser, ding, pop…); uygulama içinde üretilir, telifsizdir
- Sessizliklerden otomatik bölme ve sessiz kısımları silme (jump cut)
- Sesi videodan ayırma, sol/sağ kanal ayırma, basit vokal/müzik ayırma, WAV/MP3 kaydetme
- Dışa aktarmada YouTube standardına göre ses seviyesi (−14 LUFS, iki geçişli)

### 🖼️ Küçük resim (thumbnail)
1280×720 tasarlayıcı: önizlemedeki kareyi ya da bir görseli arka plan yap, büyük yazı ve görsel katmanları ekle, YouTube önerilerinde nasıl görüneceğine bak. PNG olarak kaydet ya da MP4'e kapak olarak göm.

### 🎞️ Intro & outro
Kendi intro/outro dosyanı bir kez seç, her projede tek tıkla ekle. Hazır şablonlar: başlık kartı, minimal, vurucu giriş, YouTube bitiş ekranı ve kısa kapanış.

### 📅 Yayın takvimi
Başlangıç ekranında "Bugün hangi video var?" kartı ve 7 günlük takvim. Her videoya yayın günü ve durum (Fikir · Çekim · Kurgu · Hazır · Yayında) ver.

### 📥 İçe aktarma
Dosya ya da klasör, panodan görsel (`Ctrl+V`), ekran kaydı, kamera kaydı.
Desteklenen biçimler: MP4, MOV, MKV, WEBM, AVI, GIF · MP3, WAV, M4A, FLAC, OGG · PNG, JPG, WEBP, SVG, TIFF.
Tarayıcının açamadığı videolar için önizleme kopyası otomatik hazırlanır.

### 📤 Dışa aktarma
MP4 (H.264 / AAC), 720p – 4K, 24 – 60 fps, üç kalite seviyesi, ilerleme göstergesi ve iptal. Sadece ses (MP3) de mümkün. Bölüm işaretçilerinden YouTube açıklamasına yapıştırmaya hazır bölüm listesi.

## Kurulum

Kurulum dosyasını aşağıdaki [Geliştirme](#geliştirme) adımlarıyla kendin üretebilirsin (`npm run dist` → `release/Cutven-Setup-1.0.0.exe`). Dosyayı çalıştırıp adımları izle. Uygulama imzasız olduğu için Windows ilk açılışta uyarı gösterebilir: **Ek bilgi → Yine de çalıştır**.

Projeler kendiliğinden `Belgeler/Cutven Projeleri` klasörüne kaydedilir; ses ve ekran kayıtları proje klasöründeki `Cutven Kayıtlar` içinde durur.

## Klavye kısayolları

| Kısayol | İşlev |
| --- | --- |
| `Boşluk` | Oynat / duraklat (kayıtta: duraklat / devam) |
| `S` | Böl |
| `Del` · `Shift+Del` | Sil · Silip boşluğu kapat |
| `K` | Ses anahtar karesi ekle / kaldır |
| `R` | Seslendirme kaydını başlat / durdur |
| `M` | Bölüm işaretçisi ekle |
| `N` | Mıknatıs aç / kapat |
| `←` `→` | Bir kare ileri / geri (`Shift` ile 1 sn) |
| `↑` `↓` | Önceki / sonraki kesim |
| `Ctrl+C` · `Ctrl+V` · `Ctrl+D` | Kopyala · Yapıştır · Çoğalt |
| `Ctrl+Z` · `Ctrl+Y` | Geri al · Yinele |
| `Ctrl+S` · `Ctrl+E` · `Ctrl+I` | Kaydet · Dışa aktar · İçe aktar |

## Geliştirme

Gereksinim: Node.js 20+ (Windows).

```bash
npm install
```

```bash
npm run build:web && npm start
```

Windows kurulum dosyası üretmek için:

```bash
npm run dist
```

Çıktı `release/` klasörüne yazılır.

### Teknoloji

- **Electron** — masaüstü kabuğu, dosya erişimi, ekran/kamera kaydı
- **React + TypeScript + Vite** — arayüz
- **FFmpeg** (ffmpeg-static) — dışa aktarma, önizleme kopyaları, ses analizi
- **Canvas 2D + Web Audio** — gerçek zamanlı önizleme ve ses efektleri

### Klasör yapısı

```
electron/        Ana süreç: pencere, IPC, FFmpeg işleri, dosya akışı
src/
  components/    Arayüz bileşenleri (zaman çizelgesi, önizleme, paneller…)
  lib/
    engine.ts       Oynatma motoru (video, ses, efekt zinciri)
    render.ts       Kare çizimi (önizleme)
    exporter.ts     FFmpeg filtre grafiği (dışa aktarma)
    transitions.ts  Geçişler (önizleme + FFmpeg ortak matematik)
    afx.ts          Ses efektleri
    keyframes.ts    Ses anahtar kareleri ve otomatik kısma
    recorder.ts     Seslendirme kaydı
    tempo.ts        Tempo koçu (BPM, hece hızı)
    audiotools.ts   Sessizlik, kanal ayırma
    sfx.ts          Ses efekti kütüphanesi
    thumb.ts        Küçük resim
    introoutro.ts   Intro / outro şablonları
build/           Uygulama simgesi
```

---

<p align="center">Kendi videolarını kendi aracınla kurgula. 🎬</p>
