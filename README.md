# Şantiye Defteri

iPhone ana ekranına eklenen küçük bir uygulama. İki şantiye için (Gündoğdu, Köseilyas) her gün şunları kaydeder:

- **Puantaj:** Kim geldi? (Tam gün / yarım gün) Aylık SGK günü için Google E-Tablo'ya yazılır.
- **Notlar:** O günün serbest notları.
- **Fotoğraflar:** Google Drive'daki şantiye klasörüne, tarihli alt klasöre yüklenir.

İnternet yokken de çalışır. Her şey önce telefona kaydedilir, internet gelince kendiliğinden Google'a gönderilir. Üstteki bar kaç öğenin beklediğini gösterir.

## Bir kerelik kurulum

### 1) Google tarafı (Apps Script)

1. Tarayıcıda **script.google.com** adresini açın (Drive'ın sahibi olan Google hesabıyla girin).
2. **Yeni proje** deyin.
3. Soldaki `Code.gs` dosyasının içindeki her şeyi silin; bu klasördeki `apps-script/Code.gs` dosyasının tamamını yapıştırın.
4. (İsteğe bağlı ama önerilir) Sol menüde **Proje Ayarları** > "appsscript.json bildirim dosyasını göster" kutusunu işaretleyin. Sonra `appsscript.json` dosyasının içeriğini `apps-script/appsscript.json` ile değiştirin.
5. Üstteki fonksiyon listesinden **kurulum** seçip **Çalıştır**'a basın. Google izin isteyecek: izin verin. ("Bu uygulama doğrulanmadı" derse: Gelişmiş > Projeye git > İzin ver.)
6. Altta açılan **Yürütme günlüğü**nde "Gizli anahtarınız: ..." satırını göreceksiniz. O anahtarı kopyalayıp bir yere not edin.
7. Sağ üstte **Dağıt > Yeni dağıtım**. Türü **Web uygulaması** seçin.
   - **Şu kişi olarak yürüt:** Ben
   - **Erişimi olanlar:** Herkes
8. **Dağıt**'a basın ve çıkan **Web uygulaması URL'sini** kopyalayın (`https://script.google.com/macros/s/.../exec`).

> Code.gs'i sonradan değiştirirseniz: Dağıt > Dağıtımları yönet > kalem simgesi > Sürüm: Yeni sürüm > Dağıt. URL aynı kalır.

### 2) Uygulamayı yayınlama

Bu klasördeki dosyalar (`index.html`, `app.css`, `app.js`, `sw.js`, `manifest.webmanifest`, `icons/`) GitHub Pages gibi bir adreste yayınlanmalıdır. Yayın adresini (örneğin `https://kullanici.github.io/santiye-defteri/`) not edin.

### 3) iPhone tarafı

1. iPhone'da **Safari** ile uygulamanın adresini açın.
2. **Paylaş** düğmesi > **Ana Ekrana Ekle**.
3. Ana ekrandaki **Şantiye Defteri** simgesinden açın.
4. Sağ üstteki **⚙ (Ayarlar)** düğmesine basın:
   - **Apps Script adresi:** 8. adımda kopyaladığınız URL'yi yapıştırın.
   - **Gizli anahtar:** 6. adımdaki anahtarı yapıştırın.
   - **Kaydet**, sonra **Bağlantıyı test et** deyin. "Bağlantı başarılı" yazmalı.
5. **Her şantiyede** Ayarlar'ı açıp o şantiyenin düğmesine basın: **"Burayı Gündoğdu olarak kaydet"** veya **"Burayı Köseilyas olarak kaydet"** (konum izni isteyecek, izin verin). Bundan sonra uygulama açılınca 300 metre içindeki şantiyeyi kendisi seçer.

## Günlük kullanım

- Üstte şantiyeyi seçin. Tarih çubuğunda ‹ › ile gün değiştirin, tarihe dokunarak takvim açın.
- İsme dokunun: boş > **Tam** > **Yarım** > boş.
- **+ Yeni isim** ile kalıcı isim ekleyin. **Düzenle** ile isim değiştirin veya silin.
- **Dünkü listeyi kopyala** ile önceki günün işaretlerini getirin.
- Notları yazın, kendiliğinden kaydedilir.
- **Fotoğraf çek** veya **Galeriden seç**. Fotoğraflar küçültülür, "Bekliyor" yazar, gönderilince "Gönderildi" olur.
- Üstteki sarı/kırmızı çerçeve takılı kalmışsa **Şimdi gönder**'e basın. Hata yazısını okuyun (adres/anahtar eksik, internet yok vb.).

## Dosyalar

| Dosya | Ne işe yarar |
|---|---|
| `index.html`, `app.css`, `app.js` | Uygulamanın kendisi |
| `sw.js`, `manifest.webmanifest`, `icons/` | Çevrimdışı çalışma ve ana ekran simgesi |
| `apps-script/Code.gs` | Google'da çalışan, Drive ve E-Tablo'ya yazan kısım |
| `test/smoke.mjs` | Geliştirici için otomatik deneme (`node test/smoke.mjs`) |

## Bilinmesi gerekenler

- Gizli anahtarı kimseyle paylaşmayın. Sızarsa Apps Script'te `anahtariYenile` fonksiyonunu çalıştırıp uygulamada yenisini girin.
- Uygulama güncellenince iPhone eski sürümü bir süre gösterebilir; uygulamayı tamamen kapatıp açın.
- İsim değiştirirseniz E-Tabloda eski isim satırı eski günlerle birlikte kalabilir; yeni isim ayrı satır olur.
