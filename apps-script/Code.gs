/**
 * Şantiye Defteri - Google Apps Script arka ucu
 * Drive klasörlerine fotoğraf, Google E-Tablo'ya puantaj ve not yazar.
 * İlk kurulumda kurulum() fonksiyonunu bir kez çalıştırın.
 */

var PARENT_FOLDER_ID = '1N93nP0SZE1Epzsmss7lhTc27rwNQiHPY';

var SITES = {
  gundogdu: {
    label: 'Gündoğdu',
    photoFolderId: '1PnWIRJRoiC4DauFzMnSJqoCX0hXDUWZ9',
    sheetName: 'Puantaj - Gündoğdu',
    prop: 'SHEET_ID_GUNDOGDU'
  },
  koseilyas: {
    label: 'Köseilyas',
    photoFolderId: '1atlqBgNzuRbUCiomprLghf27MluqsM-2',
    sheetName: 'Puantaj - Köseilyas',
    prop: 'SHEET_ID_KOSEILYAS'
  }
};

var MONTHS_TR_UPPER = ['OCAK', 'ŞUBAT', 'MART', 'NİSAN', 'MAYIS', 'HAZİRAN', 'TEMMUZ', 'AĞUSTOS', 'EYLÜL', 'EKİM', 'KASIM', 'ARALIK'];
var NOTES_SHEET = 'NOTLAR';
var DAY_COL_START = 2;   // B sütunu = ayın 1. günü
var TOTAL_COL = 33;      // AG sütunu = TOPLAM

// ---------------------------------------------------------------- Kurulum

/** Bir kez elle çalıştırın: gizli anahtarı üretir, izinleri ister, e-tabloları hazırlar. */
function kurulum() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('API_KEY');
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('API_KEY', key);
  }
  DriveApp.getFolderById(PARENT_FOLDER_ID); // Drive iznini tetikler
  Object.keys(SITES).forEach(function (s) {
    DriveApp.getFolderById(SITES[s].photoFolderId);
    getSpreadsheet_(s);
  });
  Logger.log('KURULUM TAMAM. Gizli anahtarınız (uygulamada Ayarlar > Gizli anahtar): ' + key);
  return key;
}

/** Anahtarı değiştirmek isterseniz çalıştırın. */
function anahtariYenile() {
  var key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('API_KEY', key);
  Logger.log('Yeni gizli anahtar: ' + key);
  return key;
}

// ---------------------------------------------------------------- Giriş noktaları

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    return json_(handle_(body));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (!p.action) return json_({ ok: true, message: 'Şantiye Defteri çalışıyor.' });
    return json_(handle_(p));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(req) {
  var expected = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!expected) throw new Error('Kurulum yapılmamış: Apps Script içinde kurulum() fonksiyonunu çalıştırın.');
  if (!req.key || String(req.key) !== expected) throw new Error('Geçersiz anahtar.');
  switch (req.action) {
    case 'ping': return { ok: true, pong: true };
    case 'saveDay': return saveDay_(req);
    case 'uploadPhoto': return uploadPhoto_(req);
    case 'getDay': return getDay_(req);
    case 'deletePhoto': return deletePhoto_(req);
    default: return { ok: false, error: 'unknown action: ' + req.action };
  }
}

// ---------------------------------------------------------------- Doğrulama

function site_(req) {
  var s = SITES[req.site];
  if (!s) throw new Error('Bilinmeyen şantiye: ' + req.site);
  return s;
}
function parseDate_(str) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
  if (!m) throw new Error('Tarih YYYY-AA-GG biçiminde olmalı.');
  var y = +m[1], mo = +m[2], d = +m[3];
  var dt = new Date(y, mo - 1, d);
  if (dt.getMonth() !== mo - 1 || dt.getDate() !== d) throw new Error('Geçersiz tarih.');
  return { y: y, m: mo, d: d, iso: m[0], tr: pad2_(d) + '.' + pad2_(mo) + '.' + y };
}
function pad2_(n) { return (n < 10 ? '0' : '') + n; }

// ---------------------------------------------------------------- E-tablo

function getSpreadsheet_(siteKey) {
  var cfg = SITES[siteKey];
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(cfg.prop);
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* silinmiş olabilir: yeniden bul/oluştur */ }
  }
  var parent = DriveApp.getFolderById(PARENT_FOLDER_ID);
  var it = parent.getFilesByName(cfg.sheetName);
  var ss = null;
  while (it.hasNext()) {
    var f = it.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS && !f.isTrashed()) { ss = SpreadsheetApp.openById(f.getId()); break; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(cfg.sheetName);
    DriveApp.getFileById(ss.getId()).moveTo(parent);
  }
  props.setProperty(cfg.prop, ss.getId());
  return ss;
}

function getMonthSheet_(ss, dt) {
  var name = MONTHS_TR_UPPER[dt.m - 1] + ' ' + dt.y;
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  var header = ['İSİM'];
  for (var i = 1; i <= 31; i++) header.push(i);
  header.push('TOPLAM');
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e5e7eb');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  sh.setColumnWidth(1, 180);
  // Varsayılan "Sayfa1" boşsa kaldır
  var first = ss.getSheetByName('Sayfa1') || ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);
  return sh;
}

function getNotesSheet_(ss) {
  var sh = ss.getSheetByName(NOTES_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(NOTES_SHEET);
  sh.getRange(1, 1, 1, 3).setValues([['Tarih', 'Not', 'Güncellenme']]).setFontWeight('bold').setBackground('#e5e7eb');
  sh.getRange('A:A').setNumberFormat('@');
  sh.setFrozenRows(1);
  sh.setColumnWidth(2, 500);
  return sh;
}

function cleanAttendance_(att) {
  var out = {};
  if (!att || typeof att !== 'object') return out;
  Object.keys(att).forEach(function (name) {
    var n = String(name).trim();
    var v = Number(att[name]);
    if (n && v > 0 && v <= 1) out[n] = v;
  });
  return out;
}

function saveDay_(req) {
  var cfg = site_(req);
  var dt = parseDate_(req.date);
  var att = cleanAttendance_(req.attendance);
  var note = req.note == null ? '' : String(req.note);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var siteKey = req.site;
    var ss = getSpreadsheet_(siteKey);
    var sh = getMonthSheet_(ss, dt);

    // Mevcut isimler (A sütunu)
    var last = sh.getLastRow();
    var names = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
    var index = {};
    names.forEach(function (n, i) { index[n] = i; });

    // Yeni isimleri ekle
    var added = [];
    Object.keys(att).forEach(function (n) {
      if (!(n in index)) { index[n] = names.length; names.push(n); added.push(n); }
    });
    if (added.length) {
      var startRow = last + 1;
      sh.getRange(startRow, 1, added.length, 1).setValues(added.map(function (n) { return [n]; }));
      var formulas = added.map(function (n, i) { var r = startRow + i; return ['=SUM(B' + r + ':AF' + r + ')']; });
      sh.getRange(startRow, TOTAL_COL, added.length, 1).setFormulas(formulas);
    }

    // O günün sütununu baştan yaz (idempotent)
    var col = DAY_COL_START + dt.d - 1;
    if (names.length) {
      var vals = names.map(function (n) { return [att[n] != null ? att[n] : '']; });
      sh.getRange(2, col, names.length, 1).setValues(vals);
    }

    // Not
    writeNote_(ss, dt, note);
    SpreadsheetApp.flush();
    return { ok: true, saved: Object.keys(att).length };
  } finally {
    lock.releaseLock();
  }
}

function writeNote_(ss, dt, note) {
  var ns = getNotesSheet_(ss);
  var last = ns.getLastRow();
  var row = -1;
  if (last > 1) {
    var dates = ns.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < dates.length; i++) {
      if (String(dates[i][0]) === dt.iso) { row = i + 2; break; }
    }
  }
  var now = Utilities.formatDate(new Date(), 'Europe/Istanbul', 'dd.MM.yyyy HH:mm:ss');
  if (row === -1) {
    if (!note) return;
    row = last + 1;
  }
  ns.getRange(row, 1).setNumberFormat('@').setValue(dt.iso);
  ns.getRange(row, 2).setValue(note).setWrap(true).setVerticalAlignment('top');
  ns.getRange(row, 3).setValue(now);
}

function getDay_(req) {
  site_(req);
  var dt = parseDate_(req.date);
  var ss = getSpreadsheet_(req.site);
  var attendance = {};
  var sh = ss.getSheetByName(MONTHS_TR_UPPER[dt.m - 1] + ' ' + dt.y);
  if (sh && sh.getLastRow() > 1) {
    var n = sh.getLastRow() - 1;
    var names = sh.getRange(2, 1, n, 1).getValues();
    var vals = sh.getRange(2, DAY_COL_START + dt.d - 1, n, 1).getValues();
    for (var i = 0; i < n; i++) {
      var v = Number(vals[i][0]);
      if (names[i][0] && v > 0) attendance[String(names[i][0])] = v;
    }
  }
  var note = '';
  var ns = ss.getSheetByName(NOTES_SHEET);
  if (ns && ns.getLastRow() > 1) {
    var rows = ns.getRange(2, 1, ns.getLastRow() - 1, 2).getValues();
    for (var j = 0; j < rows.length; j++) {
      if (String(rows[j][0]) === dt.iso) { note = String(rows[j][1]); break; }
    }
  }
  return { ok: true, attendance: attendance, note: note };
}

// ---------------------------------------------------------------- Fotoğraf

function uploadPhoto_(req) {
  var cfg = site_(req);
  var dt = parseDate_(req.date);
  if (!req.base64) throw new Error('Fotoğraf verisi boş.');
  var bytes = Utilities.base64Decode(req.base64);

  var root = DriveApp.getFolderById(cfg.photoFolderId);
  var folder;
  var it = root.getFoldersByName(dt.tr);
  folder = it.hasNext() ? it.next() : root.createFolder(dt.tr);

  var fname = String(req.name || '').replace(/[\\\/:*?"<>|]/g, '_').trim();
  if (!fname) {
    var now = Utilities.formatDate(new Date(), 'Europe/Istanbul', 'HHmmss');
    var count = 0, all = folder.getFiles();
    while (all.hasNext()) { all.next(); count++; }
    fname = dt.tr + '_' + now + '_' + (count + 1) + '.jpg';
  }

  // Aynı ad ve aynı boyutta dosya varsa (yanıt kaybolup tekrar gönderildiyse) yenisini oluşturma
  var same = folder.getFilesByName(fname);
  while (same.hasNext()) {
    var f = same.next();
    if (f.getSize() === bytes.length) return { ok: true, fileId: f.getId(), duplicate: true };
  }
  var blob = Utilities.newBlob(bytes, 'image/jpeg', fname);
  var file = folder.createFile(blob);
  return { ok: true, fileId: file.getId() };
}

/**
 * Fotoğrafı çöp kutusuna taşır. Yalnızca iki şantiye fotoğraf klasörünün
 * (tarih klasörü > şantiye klasörü) altındaki dosyalara dokunur.
 * Dosya yoksa ya da zaten çöpteyse başarılı sayılır (tekrar denemeye dayanıklı).
 */
function deletePhoto_(req) {
  var id = String(req.fileId || '');
  if (!id) return { ok: false, error: 'fileId boş.' };
  var file;
  try { file = DriveApp.getFileById(id); } catch (e) { return { ok: true, notFound: true }; }
  if (file.isTrashed()) return { ok: true, alreadyTrashed: true };
  var allowed = {};
  Object.keys(SITES).forEach(function (s) { allowed[SITES[s].photoFolderId] = true; });
  var inside = false;
  var p1 = file.getParents();
  while (p1.hasNext() && !inside) {
    var dateFolder = p1.next();
    if (allowed[dateFolder.getId()]) { inside = true; break; }
    var p2 = dateFolder.getParents();
    while (p2.hasNext()) { if (allowed[p2.next().getId()]) { inside = true; break; } }
  }
  if (!inside) return { ok: false, error: 'Dosya şantiye fotoğraf klasörlerinde değil, silinmedi.' };
  file.setTrashed(true);
  return { ok: true };
}
