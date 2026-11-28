// Apps Script arka ucunu (apps-script/Code.gs) Node içinde, bellekte sahte Google servisleriyle çalıştırır.
// Çalıştırma: node test/apps-script-harness.mjs
import { createGas } from './gas-sim.mjs';

let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'GEÇTİ  ' : 'KALDI  ') + msg); if (!ok) failed++; };

const { call, ssOf, sheet, folders, files, lock } = createGas(); // Code.gs burada yüklenir (sözdizimi denetimi)
check(true, 'Code.gs sözdizimi geçerli ve yüklendi');

// ---------------------------------------------------------------- Temel
check(call({ action: 'ping' }).v === 3, 'ping v:3 döner');
check(call({ action: 'ping', key: 'yanlis' }).ok === false, 'yanlış anahtar reddedilir');
check(/unknown action/.test(call({ action: 'yok' }).error), 'bilinmeyen işlem: unknown action');

// ---------------------------------------------------------------- saveDay (changes)
const D = '2026-11-18';
let r = call({ action: 'saveDay', site: 'gundogdu', date: D, changes: { Raskon: 1 } });
check(r.ok && r.v === 3 && r.saved === 1, 'saveDay changes: Raskon kaydedildi');
r = call({ action: 'saveDay', site: 'gundogdu', date: D, changes: { Sefa: 0.5 } });
let day = call({ action: 'getDay', site: 'gundogdu', date: D });
check(day.attendance.Raskon === 1 && day.attendance.Sefa === 0.5, 'iki ayrı telefonun değişikliği birlikte duruyor: ' + JSON.stringify(day.attendance));
const ks = sheet('gundogdu', 'KASIM 2026');
check(ks.get(2, 33) === '=SUM(B2:AF2)' && ks.get(3, 33) === '=SUM(B3:AF3)', 'yeni satırlara TOPLAM formülü eklendi');
check(ks.get(2, 1 + 18) === 1 && ks.get(3, 19) === 0.5, 'hücreler doğru sütunda (18. gün = S)');
r = call({ action: 'saveDay', site: 'gundogdu', date: D, changes: { Raskon: null, Yeni: null } });
day = call({ action: 'getDay', site: 'gundogdu', date: D });
check(!('Raskon' in day.attendance) && day.attendance.Sefa === 0.5, 'null = temizle; diğer kişiye dokunulmadı');
check(ks.getLastRow() === 3, 'temizlenen bilinmeyen isim için satır açılmadı');
call({ action: 'saveDay', site: 'gundogdu', date: '2026-11-17', changes: { Raskon: 1 } });
day = call({ action: 'getDay', site: 'gundogdu', date: D });
check(!('Raskon' in day.attendance), 'başka günün değişikliği bu günü etkilemedi');
check(lock().held === 0 && lock().max >= 1, 'kilit alındı ve bırakıldı');

// ---------------------------------------------------------------- 3.1: sayıyla tutulan ekip ("<ekip> (kişi sayısı)")
{
  const CK = 'İzolasyoncu (kişi sayısı)', D2 = '2026-11-20';
  let r2 = call({ action: 'saveDay', site: 'gundogdu', date: D2, changes: { [CK]: 6, Raskon: 1 } });
  let d2 = call({ action: 'getDay', site: 'gundogdu', date: D2 });
  check(r2.ok && d2.attendance[CK] === 6 && d2.attendance.Raskon === 1, '3.1 changes: sayı satırı 6 kabul edildi: ' + JSON.stringify(d2.attendance));
  r2 = call({ action: 'saveDay', site: 'gundogdu', date: D2, changes: { Sefa: 6 } });
  d2 = call({ action: 'getDay', site: 'gundogdu', date: D2 });
  check(!('Sefa' in d2.attendance), '3.1 changes: normal isim için 6 reddedildi');
  r2 = call({ action: 'saveDay', site: 'gundogdu', date: D2, changes: { [CK]: 1000, 'Demir (kişi sayısı)': 2.5 } });
  d2 = call({ action: 'getDay', site: 'gundogdu', date: D2 });
  check(d2.attendance[CK] === 6 && !('Demir (kişi sayısı)' in d2.attendance), '3.1 changes: 1000 ve ondalıklı sayı reddedildi (eski değer 6 kaldı)');
  r2 = call({ action: 'saveDay', site: 'gundogdu', date: D2, changes: { [CK]: 8 } });
  d2 = call({ action: 'getDay', site: 'gundogdu', date: D2 });
  check(d2.attendance[CK] === 8, '3.1 changes: sayı güncellendi (8)');
  r2 = call({ action: 'saveDay', site: 'gundogdu', date: D2, changes: { [CK]: null } });
  d2 = call({ action: 'getDay', site: 'gundogdu', date: D2 });
  check(!(CK in d2.attendance) && d2.attendance.Raskon === 1, '3.1 changes: null sayıyı temizledi');
  call({ action: 'saveDay', site: 'gundogdu', date: D2, attendance: { [CK]: 12, Ali: 1, Veli: 5 } });
  d2 = call({ action: 'getDay', site: 'gundogdu', date: D2 });
  check(d2.attendance[CK] === 12 && d2.attendance.Ali === 1 && !('Veli' in d2.attendance), '3.1 eski attendance yolu: sayı 12 kabul, normal isim için 5 reddedildi');
  check(call({ action: 'saveDay', site: 'gundogdu', date: D2, changes: { Raskon: 0.5 } }).ok, '3.1: normal isim 0.5 hâlâ kabul');
}

// ---------------------------------------------------------------- saveDay (eski attendance)
call({ action: 'saveDay', site: 'koseilyas', date: D, attendance: { Ali: 1, Veli: 0.5 }, note: 'eski not' });
day = call({ action: 'getDay', site: 'koseilyas', date: D });
check(day.attendance.Ali === 1 && day.attendance.Veli === 0.5 && day.note === 'eski not', 'eski biçim attendance + not hâlâ çalışıyor');
call({ action: 'saveDay', site: 'koseilyas', date: D, attendance: { Ali: 1 } });
day = call({ action: 'getDay', site: 'koseilyas', date: D });
check(day.attendance.Ali === 1 && !('Veli' in day.attendance), 'eski biçim: o günün sütunu baştan yazılır (Veli silindi)');
r = call({ action: 'saveDay', site: 'koseilyas', date: D, note: 'yalnız not' });
day = call({ action: 'getDay', site: 'koseilyas', date: D });
check(r.attendanceSkipped && day.attendance.Ali === 1 && day.note === 'yalnız not', 'yalnız not: puantaja dokunulmadı');

// ---------------------------------------------------------------- Not: son yazan kazanır
const t0 = Date.UTC(2026, 10, 18, 9, 0, 0);
call({ action: 'saveDay', site: 'gundogdu', date: D, note: 'B telefonu (yeni)', noteUpdatedAt: t0 + 5000 });
r = call({ action: 'saveDay', site: 'gundogdu', date: D, note: 'A telefonu (eski)', noteUpdatedAt: t0 + 1000 });
day = call({ action: 'getDay', site: 'gundogdu', date: D });
check(r.noteIgnored && r.note === 'B telefonu (yeni)' && day.note === 'B telefonu (yeni)', 'eski zaman damgalı not yok sayıldı');
check(day.noteUpdatedAt === t0 + 5000, 'getDay notun zaman damgasını döner: ' + day.noteUpdatedAt);
r = call({ action: 'saveDay', site: 'gundogdu', date: D, note: 'A tekrar (daha yeni)', noteUpdatedAt: t0 + 9000 });
day = call({ action: 'getDay', site: 'gundogdu', date: D });
check(!r.noteIgnored && day.note === 'A tekrar (daha yeni)', 'daha yeni not yazıldı');
// eski biçim (yazı) "Güncellenme" hücresi okunur
const ns = sheet('gundogdu', 'NOTLAR');
ns.set(2, 3, '18.11.2026 12:00:10'); // İstanbul = 09:00:10 UTC
day = call({ action: 'getDay', site: 'gundogdu', date: D });
check(day.noteUpdatedAt === t0 + 10000, 'eski yazı biçimindeki Güncellenme ms\'ye çevrildi: ' + day.noteUpdatedAt);

// ---------------------------------------------------------------- Ekipler: eski satırların göçü
const ss = ssOf('gundogdu');
const old = ss.insertSheet('EKİPLER');
[['Ekip', 'İsim', 'Gizli'], ['Kalıpçı', 'Raskon', ''], ['Kalıpçı', 'Sefa', ''], ['Demirci', 'Can', 'EVET'], ['Boş Ekip', '', '']].forEach((row, i) => row.forEach((v, j) => old.set(i + 1, j + 1, v)));
let ros = call({ action: 'getRoster2', site: 'gundogdu' });
const T = (n) => ros.teams.find((t) => t.name === n), M = (n) => ros.members.find((m) => m.name === n);
check(ros.teams.length === 3 && T('Demirci').hidden && !T('Kalıpçı').hidden && T('Boş Ekip'), 'göç: üç ekip, gizli bilgisi korundu');
check(ros.members.length === 3 && ros.members.every((m) => m.updatedAt === 0 && m.id && !m.deleted), 'göç: kişiler updatedAt=0 ve kimlikli');
check(M('Raskon').team === T('Kalıpçı').id, 'göç: kişi ekip kimliğine bağlı');
check(old.get(1, 4) === 'Güncellenme' && old.get(1, 5) === 'Silindi' && old.get(1, 6) === 'ID', 'göç: D/E/F başlıkları yazıldı');
const ros2 = call({ action: 'getRoster2', site: 'gundogdu' });
check(JSON.stringify(ros2) === JSON.stringify(ros), 'ikinci okumada kimlikler aynı (kalıcı)');
check(call({ action: 'getRoster' }).teams.find((t) => t.name === 'Kalıpçı').members.join() === 'Raskon,Sefa', 'eski getRoster aynı listeyi verir');

// ---------------------------------------------------------------- saveRoster2 birleştirme
const kid = T('Kalıpçı').id, did = T('Demirci').id;
r = call({ action: 'saveRoster2', site: 'gundogdu', changes: [
  { type: 'member', id: M('Sefa').id, name: 'Sefa', team: kid, updatedAt: 1000, deleted: true },
  { type: 'member', id: 'mYeni', name: 'Yeni Usta', team: did, updatedAt: 1000 },
] });
check(r.members.find((m) => m.name === 'Sefa').deleted === true && r.members.find((m) => m.name === 'Yeni Usta').team === did, 'silme (tombstone) ve ekleme birleşti');
check(old.rows(7).some((row) => row[1] === 'Sefa' && row[4] === 'EVET'), 'silinen kişi satırı E=EVET ile duruyor');
r = call({ action: 'saveRoster2', site: 'gundogdu', changes: [{ type: 'member', name: 'Sefa', team: kid, updatedAt: 500 }] });
check(r.members.find((m) => m.name === 'Sefa').deleted === true, 'eski zaman damgalı kayıt silineni geri getirmedi');
r = call({ action: 'saveRoster', site: 'gundogdu', teams: [{ name: 'Kalıpçı', members: ['Raskon', 'Sefa', 'Eski Telefon'] }] });
ros = call({ action: 'getRoster2', site: 'gundogdu' });
check(M('Sefa').deleted && M('Eski Telefon') && !M('Eski Telefon').deleted && M('Eski Telefon').team === kid, 'eski saveRoster: yalnız ekler, silineni geri getirmez');
check(ros.members.find((m) => m.name === 'Yeni Usta'), 'eski saveRoster tümden değiştirmedi');
// ekip adı değişikliği (aynı kimlik)
r = call({ action: 'saveRoster2', site: 'gundogdu', changes: [{ type: 'team', id: kid, name: 'Kalıp Ekibi', hidden: false, updatedAt: 2000 }] });
ros = r;
check(T('Kalıp Ekibi') && !T('Kalıpçı') && M('Raskon').team === kid, 'ekip adı değişti, üyeler yeni adda');
check(old.rows(7).some((row) => row[0] === 'Kalıp Ekibi' && row[1] === 'Raskon'), 'sayfada A sütunu yeni ekip adı');
// aynı adlı yeni ekip (başka telefon): tek ekipte birleşir
r = call({ action: 'saveRoster2', site: 'gundogdu', changes: [
  { type: 'team', id: 'tBaska', name: 'kalıp ekibi', hidden: false, updatedAt: 1500 },
  { type: 'member', name: 'Başka', team: 'tBaska', updatedAt: 1500 },
] });
ros = r;
check(r.aliases.tBaska === kid && ros.teams.filter((t) => !t.deleted && /kalıp ekibi/i.test(t.name)).length === 1 && M('Başka').team === kid, 'aynı adlı ekip tek ekipte birleşti (alias)');
check(T('Kalıp Ekibi'), 'eski zaman damgalı ad değişikliği uygulanmadı');
// yeniden adlandırma: eski ad silinir, yeni ad aynı kimlikle
const rid = M('Raskon').id;
r = call({ action: 'saveRoster2', site: 'gundogdu', changes: [
  { type: 'member', id: rid, name: 'Raskon', team: kid, updatedAt: 3000, deleted: true },
  { type: 'member', id: rid, name: 'Raskon Usta', team: kid, updatedAt: 3000 },
] });
ros = r;
check(M('Raskon').deleted && M('Raskon Usta').id === rid, 'isim değişikliği: eski ad silindi, yeni ad aynı kimlikle');
// yeni sürüm satırları yeniden okunur
ros = call({ action: 'getRoster2', site: 'gundogdu' });
check(ros.teams.length === 3 && ros.members.length === 7, 'sayfa yeniden okununca her şey yerinde: ' + ros.members.map((m) => m.name).join(','));

// ---------------------------------------------------------------- AYARLAR
r = call({ action: 'getMeta' });
check(r.ok && Object.keys(r.items).length === 0, 'getMeta boş başlar');
r = call({ action: 'saveMeta', metaKey: 'sd_site_hide', value: { gundogdu: ['Beton'] }, updatedAt: 100 });
check(r.applied, 'saveMeta yazıldı ' + JSON.stringify(r));
r = call({ action: 'saveMeta', metaKey: 'sd_site_hide', value: { gundogdu: [] }, updatedAt: 50 });
check(!r.applied && r.value.gundogdu[0] === 'Beton' && r.updatedAt === 100, 'eski saveMeta yok sayıldı, güncel değer döndü');
call({ action: 'saveMeta', metaKey: 'sd_coords', value: { gundogdu: { lat: 40.1, lng: 29.2 } }, updatedAt: 70 });
call({ action: 'saveMeta', metaKey: 'sd_site_hide', value: { koseilyas: ['Demir'] }, updatedAt: 200 });
r = call({ action: 'getMeta' });
check(r.items.sd_site_hide.value.koseilyas[0] === 'Demir' && r.items.sd_site_hide.updatedAt === 200 && r.items.sd_coords.value.gundogdu.lat === 40.1, 'getMeta güncel değerleri döner');
check(sheet('gundogdu', 'AYARLAR').getLastRow() === 3, 'AYARLAR: anahtar başına tek satır');
check(call({ action: 'saveMeta', metaKey: 'kötü ad', value: 1 }).ok === false, 'geçersiz ayar adı reddedildi');

// ---------------------------------------------------------------- İrsaliye numarası
const jpg = Buffer.from('fake-jpeg-bytes').toString('base64');
const a = call({ action: 'uploadPhoto', site: 'gundogdu', date: D, kind: 'irsaliye', name: 'İrsaliye_18.11.2026_1.jpg', uid: 'A1', base64: jpg });
const b = call({ action: 'uploadPhoto', site: 'gundogdu', date: D, kind: 'irsaliye', name: 'İrsaliye_18.11.2026_1.jpg', uid: 'B1', base64: jpg });
check(a.name === 'İrsaliye_18.11.2026_1.jpg' && b.name === 'İrsaliye_18.11.2026_2.jpg', 'iki telefon: _1 ve _2 (' + a.name + ', ' + b.name + ')');
const again = call({ action: 'uploadPhoto', site: 'gundogdu', date: D, kind: 'irsaliye', name: 'x', uid: 'A1', base64: jpg });
check(again.duplicate && again.fileId === a.fileId && again.name === a.name, 'aynı yükleme tekrar gelince yeni numara verilmedi');
const n1 = call({ action: 'uploadPhoto', site: 'gundogdu', date: D, name: '18.11.2026_101010_1.jpg', base64: jpg });
check(n1.name === '18.11.2026_101010_1.jpg', 'normal fotoğraf adı değişmedi');
const c = call({ action: 'uploadPhoto', site: 'gundogdu', date: D, kind: 'irsaliye', name: 'x', uid: 'C1', base64: jpg });
check(c.name === 'İrsaliye_18.11.2026_3.jpg', 'üçüncü irsaliye _3');
const root = folders.get('1PnWIRJRoiC4DauFzMnSJqoCX0hXDUWZ9');
check(root.folders.length === 1 && root.folders[0].files.length === 4, 'tek tarih klasörü, dört dosya');
const k1 = call({ action: 'uploadPhoto', site: 'koseilyas', date: D, kind: 'irsaliye', name: 'x', uid: 'K1', base64: jpg });
check(k1.name === 'İrsaliye_18.11.2026_1.jpg', 'başka şantiyede numara 1den başlar');
// ---------------------------------------------------------------- 3.2: fotoğraf seçimi (s_ öneki)
{
  const up = call({ action: 'uploadPhoto', site: 'gundogdu', date: D, name: '18.11.2026_121212_9.jpg', base64: jpg });
  let rn = call({ action: 'renamePhoto', fileId: up.fileId, selected: true });
  check(rn.ok && rn.name === 's_18.11.2026_121212_9.jpg', 'renamePhoto: s_ eklendi: ' + rn.name);
  rn = call({ action: 'renamePhoto', fileId: up.fileId, selected: true });
  check(rn.ok && rn.name === 's_18.11.2026_121212_9.jpg', 'renamePhoto idempotent: ikinci seçimde s_s_ olmadı');
  rn = call({ action: 'renamePhoto', fileId: up.fileId, selected: false });
  check(rn.ok && rn.name === '18.11.2026_121212_9.jpg', 'renamePhoto: s_ kaldırıldı: ' + rn.name);
  rn = call({ action: 'renamePhoto', fileId: up.fileId, selected: false });
  check(rn.ok && rn.name === '18.11.2026_121212_9.jpg', 'renamePhoto idempotent: seçisiz tekrar aynı ad');
  call({ action: 'renamePhoto', fileId: up.fileId, selected: true });
  files.get(up.fileId).name = 's_s_s_18.11.2026_121212_9.jpg';
  rn = call({ action: 'renamePhoto', fileId: up.fileId, selected: true });
  check(rn.name === 's_18.11.2026_121212_9.jpg', 'tekrarlı s_ önekleri tek s_ olur');
  check(files.get(up.fileId).trashed === false, 'dosya çöpe atılmadı');
  // klasör dışı dosya reddedilir
  const outside = folders.get('1N93nP0SZE1Epzsmss7lhTc27rwNQiHPY').createFile({ name: 'dis.jpg', bytes: [1, 2], mime: 'image/jpeg' });
  rn = call({ action: 'renamePhoto', fileId: outside.getId(), selected: true });
  check(rn.ok === false && outside.getName() === 'dis.jpg', 'klasör dışı dosya reddedildi, adı değişmedi');
  check(call({ action: 'renamePhoto', fileId: 'yok', selected: true }).ok === false, 'olmayan dosya reddedilir');
  check(call({ action: 'renamePhoto', selected: true }).ok === false, 'fileId boşsa reddedilir');
  // uploadPhoto s_ önekini korur
  const su = call({ action: 'uploadPhoto', site: 'gundogdu', date: D, name: 's_18.11.2026_131313_1.jpg', base64: jpg });
  check(su.name === 's_18.11.2026_131313_1.jpg', 'uploadPhoto s_ önekini korur');
  // irsaliye: s_ önekli istek s_ önekli ad alır; numara s_ yok sayılarak devam eder
  const i4 = call({ action: 'uploadPhoto', site: 'gundogdu', date: D, kind: 'irsaliye', name: 's_İrsaliye_18.11.2026_1.jpg', uid: 'S4', base64: jpg });
  check(i4.name === 's_İrsaliye_18.11.2026_4.jpg', 'irsaliye s_ önekli: numara 4 (s_ yok sayıldı): ' + i4.name);
  const i5 = call({ action: 'uploadPhoto', site: 'gundogdu', date: D, kind: 'irsaliye', name: 'İrsaliye_18.11.2026_1.jpg', uid: 'S5', base64: jpg });
  check(i5.name === 'İrsaliye_18.11.2026_5.jpg', 'sonraki irsaliye s_ li dosyadan sonra 5: ' + i5.name);
  const i4b = call({ action: 'uploadPhoto', site: 'gundogdu', date: D, kind: 'irsaliye', name: 's_x', uid: 'S4', base64: jpg });
  check(i4b.duplicate && i4b.name === 's_İrsaliye_18.11.2026_4.jpg', 'aynı uid tekrarında aynı dosya döner');
  rn = call({ action: 'renamePhoto', fileId: i5.fileId, selected: true });
  check(rn.name === 's_İrsaliye_18.11.2026_5.jpg', 'irsaliye seçilince s_ eklenir');
}

// ---------------------------------------------------------------- 4.0: Sorular
{
  let q = call({ action: 'getQuestions' });
  check(q.ok && Array.isArray(q.questions) && q.questions.length === 0, 'getQuestions: SORULAR sekmesi yokken boş liste');
  const up = call({ action: 'uploadPhoto', site: 'koseilyas', date: D, name: 'İrsaliye_soru.jpg', base64: jpg });
  // Claude'un yazdığı satırlar (Sheets bağlayıcısıyla)
  const ss = ssOf('gundogdu');
  const sh = ss.insertSheet('SORULAR');
  const rows = [
    ['ID', 'Tarih', 'Şantiye', 'Soru', 'Fotoğraf ID', 'Seçenekler', 'Cevap', 'Cevaplanma', 'Durum', 'Sonuç'],
    ['Q1', '28.11.2026', 'Köseilyas', 'Tarih 09.11 mi?', up.fileId, 'Evet | Hayır, 08.11', '', '', 'Açık', ''],
    ['Q2', '28.11.2026', 'Gündoğdu', 'Firma hangisi?', '', '', '', '', 'Açık', ''],
    ['Q3', '27.11.2026', 'Gündoğdu', 'Eski soru', '', '', 'tamam', 1, 'İşlendi', 'Deftere yazıldı'],
  ];
  rows.forEach((r, i) => r.forEach((v, j) => sh.set(i + 1, j + 1, v)));
  q = call({ action: 'getQuestions' });
  check(q.questions.length === 3 && q.questions[0].id === 'Q1' && q.questions[0].options.length === 2 && q.questions[0].options[1] === 'Hayır, 08.11', 'getQuestions: açık + işlenen sorular, seçenekler ayrıldı');
  check(q.questions[2].status === 'İşlendi' && q.questions[2].result === 'Deftere yazıldı', 'işlenen soru sonucu ile gelir');
  let a = call({ action: 'answerQuestion', id: 'Q1', answer: 'Evet', answeredAt: 1000 });
  check(a.ok && a.applied && sh.get(2, 7) === 'Evet' && sh.get(2, 8) === 1000 && sh.get(2, 9) === 'Cevaplandı', 'answerQuestion: cevap, zaman ve durum yazıldı');
  a = call({ action: 'answerQuestion', id: 'Q1', answer: 'Eski cevap', answeredAt: 500 });
  check(a.ok && !a.applied && sh.get(2, 7) === 'Evet', 'daha eski cevap yenisini ezmez');
  a = call({ action: 'answerQuestion', id: 'Q3', answer: 'değiştir', answeredAt: 9999 });
  check(a.ok && !a.applied && sh.get(4, 7) === 'tamam', 'işlenmiş soru değiştirilmez');
  a = call({ action: 'answerQuestion', id: 'YOK', answer: 'x', answeredAt: 1 });
  check(a.ok && a.missing, 'olmayan soru: missing');
  check(call({ action: 'answerQuestion', id: 'Q2', answer: '   ' }).ok === false, 'boş cevap reddedilir');
  const ph = call({ action: 'questionPhoto', fileId: up.fileId });
  check(ph.ok && ph.base64 === jpg && ph.mime === 'image/jpeg', 'questionPhoto: fotoğraf base64 döner');
  const outside2 = folders.get('1N93nP0SZE1Epzsmss7lhTc27rwNQiHPY').createFile({ name: 'gizli.jpg', bytes: [1, 2], mime: 'image/jpeg' });
  check(call({ action: 'questionPhoto', fileId: outside2.getId() }).ok === false, 'questionPhoto: klasör dışı dosya verilmez');
}

check(lock().held === 0, 'tüm kilitler bırakıldı');

console.log(failed ? `\n${failed} kontrol başarısız` : '\nApps Script testleri geçti');
process.exit(failed ? 1 : 0);
