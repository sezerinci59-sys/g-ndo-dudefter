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
- **Fotoğraf çek** uygulamanın kendi kamerasını açar; arka arkaya çekin, bitince **Bitti**. Fotoğrafın köşesindeki **✕**'e iki kez dokunarak silin. Veya **Galeriden seç**. Fotoğraflar küçültülür, "Bekliyor" yazar, gönderilince "Gönderildi" olur.
- Üstteki sarı/kırmızı çerçeve takılı kalmışsa **Şimdi gönder**'e basın. Hata yazısını okuyun (adres/anahtar eksik, internet yok vb.).

## Dosyalar

| Dosya | Ne işe yarar |
|---|---|
| `index.html`, `app.css`, `app.js` | Uygulamanın kendisi |
| `sw.js`, `manifest.webmanifest`, `icons/` | Çevrimdışı çalışma ve ana ekran simgesi |
| `apps-script/Code.gs` | Google'da çalışan, Drive ve E-Tablo'ya yazan kısım |
| `test/smoke.mjs` | Geliştirici için otomatik deneme (`node test/smoke.mjs`) |

## Apps Script'i güncelleme

Uygulamaya yeni bir özellik eklenince `Code.gs` de değişir. **Sürüm 3.0 (iki telefon aynı anda) için güncelleme şarttır**; güncellenmezse puantaj gönderilmez ve uygulama "Apps Script'i güncelleyin" uyarısı gösterir (veriler telefonda bekler, kaybolmaz). Güncellemek için:

1. script.google.com adresinde projenizi açın.
2. Sol taraftaki `Code.gs` içindeki her şeyi silin, yerine `https://raw.githubusercontent.com/sezerinci59-sys/g-ndo-dudefter/main/apps-script/Code.gs` adresindeki yeni kodu yapıştırın. **Kaydet**'e basın.
3. **Dağıt → Dağıtımları yönet → ✎ (kalem) → Sürüm: Yeni sürüm → Dağıt**.
4. Telefonda Ayarlar > **Bağlantıyı test et**: "Apps Script: GÜNCEL (3.0) ✔" yazmalı.

Web uygulaması adresi değişmez, kurulumu (`kurulum`) tekrar yapmanız gerekmez. İki telefon aynı adresi ve aynı gizli anahtarı kullanır.

3.0 ile E-Tablo'da (Puantaj - Gündoğdu) şunlar değişir — elle düzenlemeyin:

- **EKİPLER** sekmesine D–G sütunları eklenir: Güncellenme (ms), Silindi (EVET), ID, Ekip ID. Her ekibin bir başlık satırı olur (İsim boş). Silinen kişinin satırı "Silindi = EVET" ile kalır; bu sayede başka telefon onu geri getirmez. Eski satırlar ilk açılışta kendiliğinden bu biçime çevrilir.
- Yeni **AYARLAR** sekmesi: şantiyede gizlenen ekipler, sigorta çıkışı bilgileri ve şantiye konumları (iki telefon ortak kullanır).
- **NOTLAR** sekmesindeki "Güncellenme" artık tarih-saat değeridir; iki telefonda aynı güne not yazılırsa en son yazılan kalır.

## Sorular (4.0)

Claude (her gün 16:00'daki otomatik görev) irsaliye ve günlük raporla ilgili emin olmadığı şeyleri **Puantaj - Gündoğdu** e-tablosundaki **SORULAR** sekmesine yazar. Uygulamada en üstte **Sorular** kartı çıkar:

- Kırmızı rozet cevap bekleyen soru sayısıdır.
- **📷 Fotoğrafı göster** ile sorunun fotoğrafı açılır, dokununca büyür.
- Seçeneğe dokun ya da cevabı yaz, **Gönder**. İnternet yoksa telefonda bekler, sonra gider.
- Claude bir sonraki çalışmada cevabı işler; soru "Son işlenenler"e geçer ve ne yapıldığı yazar.

SORULAR sütunları: ID | Tarih | Şantiye | Soru | Fotoğraf ID | Seçenekler (" | " ile) | Cevap | Cevaplanma | Durum (Açık / Cevaplandı / İşlendi) | Sonuç. Satırları elle silmeyin.

Bu özellik için Apps Script güncellenmelidir (yukarıdaki "Apps Script'i güncelleme" adımları).

## Bilinmesi gerekenler

- Gizli anahtarı kimseyle paylaşmayın. Sızarsa Apps Script'te `anahtariYenile` fonksiyonunu çalıştırıp uygulamada yenisini girin.
- Uygulama güncellenince iPhone eski sürümü bir süre gösterebilir; uygulamayı tamamen kapatıp açın.
- İsim değiştirirseniz E-Tabloda eski isim satırı eski günlerle birlikte kalabilir; yeni isim ayrı satır olur.
- İki telefon aynı anda kullanılabilir: puantaj kişi bazında gönderilir, uygulama açıkken 30 saniyede bir diğer telefonun değişikliklerini alır ("son eşitleme: … önce").
- İki telefonda aynı ayara (ör. şantiyede gizlenen ekipler) birkaç saniye arayla farklı değişiklik yapılırsa son yapılan geçerli olur.
