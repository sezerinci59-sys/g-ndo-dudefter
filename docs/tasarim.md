# Şantiye Defteri — Tasarım (2026-11-17)

## Amaç
Tek kullanıcılı (şantiye şefi) iPhone ana ekran web uygulaması (PWA). İki şantiye: **Gündoğdu** ve **Köseilyas**.
Günlük: kim geldi (puantaj, aylık SGK günü için), serbest notlar, fotoğraflar → Google Drive.

## Yaklaşım (seçilen)
- Ön yüz: statik PWA (HTML/CSS/JS, framework yok, derleme adımı yok), GitHub Pages'te.
- Arka uç: kullanıcının Google hesabında **Google Apps Script web app** (`apps-script/Code.gs`). Drive + Sheets'e o yazar.
- Elenenler: kendi sunucusu (maliyet, bakım); tarayıcıdan doğrudan Google OAuth (iOS PWA'da giriş akışı kırılgan, her açılışta token sorunu).

## Davranış
1. **Şantiye seçimi:** Ayarlar'da "Şu anki konumu Gündoğdu/Köseilyas olarak kaydet". Açılışta konum alınır; kayıtlı noktaya ≤300 m ise o şantiye açılır. Değilse / konum yoksa iki büyük düğme. Üst barda her zaman elle değiştirme. Son seçilen hatırlanır.
2. **Tarih:** Varsayılan bugün (yerel saat, Europe/Istanbul). ‹ › ile gün gün, tarihe dokununca takvim. Geçmiş gün düzenlenebilir.
3. **Puantaj:** Şantiye başına **ekipler** (`{id, name, hidden}`); her isim bir ekibe bağlı. Kartta görünür ekipler gruplanır: başlıkta ekip adı, "bugün X/Y" ve "Hepsi geldi" (ekibi Tam yapar; hepsi zaten Tam ise bir şey yapmaz). Çipler: dokun boş → Tam (1) → Yarım (0,5) → boş. Her ekipte satır içi isim kutusu + "+"; kartın altında "+ Yeni ekip". Üstte "Bugün: 12 kişi (11,5 gün)", "Dünkü listeyi kopyala". Ekip gizleme/yeniden adlandırma, isim taşıma/silme yalnızca **Ayarlar > Ekipler**'de (iki adımlı, sayfa içi onay; `confirm` yok). Gizli ekip ve üyeleri ana ekranda görünmez; ancak geçmiş günde kaydı olan gizli ekip üyesi "Gizli ekipten" grubunda görünür/düzenlenebilir. Gizleme puantaj verisini silmez. Eski veri (düz isim listesi) ilk açılışta otomatik "Ekipsiz" ekibine taşınır. Sunucu API'si değişmez (`attendance:{"Ad":1|0.5}`).
4. **Notlar:** O gün+şantiye için serbest metin (otomatik kaydedilir).
5. **Fotoğraf:** "Fotoğraf çek" (`<input type=file accept=image/* capture=environment>`) ve "Galeriden seç" (multiple). İstemcide en uzun kenar 1920 px, JPEG ~0.8'e küçült. Küçük resim ızgarası, durum işareti (bekliyor/gönderildi).
6. **Çevrimdışı:** Her şey önce IndexedDB'ye. Gönderim kuyruğu; çevrimiçi olunca/uygulama açılınca/`online` olayında otomatik gönderir. Üstte "3 öğe gönderilmeyi bekliyor" + "Şimdi gönder". Service worker uygulama kabuğunu önbellekler.
7. **Ayarlar:** Apps Script URL'si + gizli anahtar (localStorage), şantiye konumları, "Bağlantıyı test et".

## Drive yerleşimi (Apps Script tarafında)
- Fotoğraf: `GÜNDOĞDU-FOTOĞRAFLAR/<dd.mm.yyyy>/` ve `KÖSEİLYAS-FOTOĞRAFLAR/<dd.mm.yyyy>/` (klasör yoksa oluşturulur). Dosya adı `dd.mm.yyyy_HHMMSS_<n>.jpg`.
  - Klasör ID'leri: Gündoğdu `1PnWIRJRoiC4DauFzMnSJqoCX0hXDUWZ9`, Köseilyas `1atlqBgNzuRbUCiomprLghf27MluqsM-2`; üst klasör `1N93nP0SZE1Epzsmss7lhTc27rwNQiHPY`.
- Puantaj: üst klasörde şantiye başına Google E-Tablo `Puantaj - Gündoğdu`, `Puantaj - Köseilyas` (yoksa oluşturulur). Ay başına sekme `KASIM 2026`: A sütunu isim, B..AF günler 1–31, AG `TOPLAM` (=SUM). Hücre 1 / 0,5 / boş. Bir gün gönderilince o günün sütunu tamamen yeniden yazılır (idempotent).
- Notlar: aynı e-tabloda `NOTLAR` sekmesi: Tarih | Not | Güncellenme. Tarih başına tek satır, üzerine yazılır.

## API (Apps Script `doPost`, gövde `text/plain` JSON — CORS ön kontrolünü önlemek için)
Hepsinde `key` alanı (Script Properties `API_KEY`) doğrulanır.
- `{action:"ping"}`
- `{action:"saveDay", site:"gundogdu"|"koseilyas", date:"YYYY-MM-DD", attendance:{"Ad Soyad":1|0.5}, note:"..."}`
- `{action:"uploadPhoto", site, date, name, base64}` → `{ok, fileId}`
- `{action:"getDay", site, date}` → kayıtlı puantaj + not (başka cihazdan/silinmiş önbellekten geri yükleme için)
Yanıt: `{ok:true,...}` / `{ok:false,error}`.

## Kapsam dışı (şimdilik)
Arayüzün son görsel tasarımı, günlük rapor/irsaliye bağlantısı, çok kullanıcı.
