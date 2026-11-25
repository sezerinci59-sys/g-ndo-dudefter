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
var ROSTER_SHEET = 'EKİPLER';
var DAY_COL_START = 2;   // B sütunu = ayın 1. günü
var TOTAL_COL = 33;      // AG sütunu = TOPLAM
var META_SHEET = 'AYARLAR';
var ROSTER_SITE = 'gundogdu'; // ortak ekip listesi ve ayarlar Gündoğdu e-tablosunda
var API_VERSION = 3;
var ROSTER_COLS = 7;     // Ekip | İsim | Gizli | Güncellenme | Silindi | ID | Ekip ID

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
    case 'ping': return { ok: true, pong: true, v: API_VERSION };
    case 'saveDay': return saveDay_(req);
    case 'uploadPhoto': return uploadPhoto_(req);
    case 'renamePhoto': return renamePhoto_(req);
    case 'getDay': return getDay_(req);
    case 'getRoster': return getRoster_(req);
    case 'saveRoster': return saveRoster_(req);
    case 'getRoster2': return getRoster2_(req);
    case 'saveRoster2': return saveRoster2_(req);
    case 'getMeta': return getMeta_(req);
    case 'saveMeta': return saveMeta_(req);
    default: return { ok: false, error: 'unknown action: ' + req.action };
  }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
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

// Sayıyla tutulan ekipler: "<ekip> (kişi sayısı)" satırında 1..999 tam sayı kabul edilir (3.1).
var COUNT_SUFFIX = ' (kişi sayısı)';
function isCountName_(n) {
  return n.length > COUNT_SUFFIX.length && n.slice(-COUNT_SUFFIX.length) === COUNT_SUFFIX;
}
function validAttValue_(n, v, allowZero) {
  if (isCountName_(n)) return v === Math.floor(v) && v >= (allowZero ? 0 : 1) && v <= 999;
  return (allowZero ? v >= 0 : v > 0) && v <= 1;
}

function cleanAttendance_(att) {
  var out = {};
  if (!att || typeof att !== 'object') return out;
  Object.keys(att).forEach(function (name) {
    var n = String(name).trim();
    var v = Number(att[name]);
    if (n && validAttValue_(n, v, false)) out[n] = v;
  });
  return out;
}

// Kişi bazında değişiklik: {"Ad": 1 | 0.5 | null}. null (veya 0) = o günün hücresini temizle.
function cleanChanges_(ch) {
  var out = {};
  if (!ch || typeof ch !== 'object') return out;
  Object.keys(ch).forEach(function (name) {
    var n = String(name).trim();
    if (!n) return;
    var raw = ch[name];
    var v = (raw === null || raw === '' || raw === false) ? 0 : Number(raw);
    if (validAttValue_(n, v, true)) out[n] = v;
  });
  return out;
}

function readNames_(sh) {
  var last = sh.getLastRow();
  return last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
}

function appendNames_(sh, added) {
  if (!added.length) return;
  var startRow = sh.getLastRow() + 1;
  sh.getRange(startRow, 1, added.length, 1).setValues(added.map(function (n) { return [n]; }));
  var formulas = added.map(function (n, i) { var r = startRow + i; return ['=SUM(B' + r + ':AF' + r + ')']; });
  sh.getRange(startRow, TOTAL_COL, added.length, 1).setFormulas(formulas);
}

// Yeni yol (3.0): yalnızca değişen kişilerin hücreleri yazılır; başka telefonun işaretlerine dokunulmaz.
function applyChanges_(ss, dt, changes) {
  var keys = Object.keys(changes);
  if (!keys.length) return 0;
  var sh = getMonthSheet_(ss, dt);
  var names = readNames_(sh);
  var index = {};
  names.forEach(function (n, i) { if (!(n in index)) index[n] = i; });
  var added = [];
  keys.forEach(function (n) {
    if (!(n in index) && changes[n] > 0) { index[n] = names.length; names.push(n); added.push(n); }
  });
  appendNames_(sh, added);
  var col = DAY_COL_START + dt.d - 1, count = 0;
  keys.forEach(function (n) {
    if (!(n in index)) return; // listede olmayan kişiyi temizlemeye gerek yok
    sh.getRange(index[n] + 2, col).setValue(changes[n] > 0 ? changes[n] : '');
    count++;
  });
  return count;
}

// Eski yol (3.0 öncesi uygulamalar): o günün sütunu baştan yazılır.
function writeDayColumn_(ss, dt, att) {
  var sh = getMonthSheet_(ss, dt);
  var names = readNames_(sh);
  var index = {};
  names.forEach(function (n, i) { index[n] = i; });
  var added = [];
  Object.keys(att).forEach(function (n) {
    if (!(n in index)) { index[n] = names.length; names.push(n); added.push(n); }
  });
  appendNames_(sh, added);
  var col = DAY_COL_START + dt.d - 1;
  if (names.length) {
    var vals = names.map(function (n) { return [att[n] != null ? att[n] : '']; });
    sh.getRange(2, col, names.length, 1).setValues(vals);
  }
  return Object.keys(att).length;
}

function saveDay_(req) {
  site_(req);
  var dt = parseDate_(req.date);
  var hasChanges = req.changes !== undefined && req.changes !== null;
  var changes = hasChanges ? cleanChanges_(req.changes) : null;
  var hasAtt = !hasChanges && req.attendance !== undefined && req.attendance !== null;
  var att = cleanAttendance_(req.attendance);
  var hasNote = req.note !== undefined && req.note !== null;
  var note = hasNote ? String(req.note) : '';
  var noteAt = Number(req.noteUpdatedAt) || 0;

  return withLock_(function () {
    var ss = getSpreadsheet_(req.site);
    var out = { ok: true, v: API_VERSION, saved: 0 };
    // Puantaj gelmediyse (dokunulmamış gün) ay sayfasına hiç dokunma
    if (hasChanges) out.saved = applyChanges_(ss, dt, changes);
    else if (hasAtt) out.saved = writeDayColumn_(ss, dt, att);
    else out.attendanceSkipped = true;
    if (hasNote) {
      var r = writeNote_(ss, dt, note, noteAt);
      out.noteUpdatedAt = r.at;
      if (!r.applied) { out.noteIgnored = true; out.note = r.note; }
    }
    SpreadsheetApp.flush();
    return out;
  });
}

// NOTLAR "Güncellenme": tarih-saat (yeni) ya da "dd.MM.yyyy HH:mm:ss" yazısı (eski) -> ms
function noteTime_(v) {
  if (v && typeof v.getTime === 'function') return v.getTime();
  if (typeof v === 'number') return v > 1e11 ? v : 0;
  var m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(v || '').trim());
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] - 3, +m[5], +m[6]); // İstanbul = UTC+3
  return 0;
}

function findNoteRow_(ns, dt) {
  var last = ns.getLastRow();
  if (last > 1) {
    var rows = ns.getRange(2, 1, last - 1, 3).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) === dt.iso) return { row: i + 2, note: String(rows[i][1]), at: noteTime_(rows[i][2]) };
    }
  }
  return { row: -1, note: '', at: 0, last: last };
}

// Son yazan kazanır: istemcinin zaman damgası kayıtlı olandan eskiyse not yazılmaz.
function writeNote_(ss, dt, note, at) {
  var ns = getNotesSheet_(ss);
  var f = findNoteRow_(ns, dt);
  at = at || new Date().getTime();
  if (f.row !== -1 && f.at > at) return { applied: false, note: f.note, at: f.at };
  var row = f.row;
  if (row === -1) {
    if (!note) return { applied: true, at: at };
    row = ns.getLastRow() + 1;
  }
  ns.getRange(row, 1).setNumberFormat('@').setValue(dt.iso);
  ns.getRange(row, 2).setValue(note).setWrap(true).setVerticalAlignment('top');
  ns.getRange(row, 3).setNumberFormat('dd.MM.yyyy HH:mm:ss').setValue(new Date(at));
  return { applied: true, at: at };
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
  var note = '', noteAt = 0;
  var ns = ss.getSheetByName(NOTES_SHEET);
  if (ns) { var f = findNoteRow_(ns, dt); note = f.note; noteAt = f.at; }
  return { ok: true, v: API_VERSION, attendance: attendance, note: note, noteUpdatedAt: noteAt };
}

// ---------------------------------------------------------------- Ekipler
// EKİPLER: A Ekip | B İsim | C Gizli | D Güncellenme (ms) | E Silindi | F ID | G Ekip ID
// Ekip satırında B boştur. Silinen kişi satırı kalır (E = EVET), böylece başka telefon onu geri getirmez.

var ROSTER_HEADER = ['Ekip', 'İsim', 'Gizli', 'Güncellenme', 'Silindi', 'ID', 'Ekip ID'];

function getRosterSheet_(ss, create) {
  var sh = ss.getSheetByName(ROSTER_SHEET);
  if (sh || !create) return sh;
  sh = ss.insertSheet(ROSTER_SHEET);
  sh.getRange(1, 1, 1, ROSTER_COLS).setValues([ROSTER_HEADER]).setFontWeight('bold').setBackground('#e5e7eb');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 180);
  sh.setColumnWidth(2, 220);
  return sh;
}

function lc_(s) { return String(s == null ? '' : s).replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase(); }
function yes_(v) { return String(v == null ? '' : v).trim().toUpperCase() === 'EVET'; }
function newEntityId_() { return 's' + Utilities.getUuid().replace(/-/g, '').slice(0, 11); }

// Sayfayı okur. Eski (zaman damgasız) satırlar updatedAt = 0 sayılır; eksik ID'ler üretilir (fix = true -> yazılmalı).
function readRoster2_(sh) {
  var r = { teams: [], members: [], fix: false };
  if (!sh || sh.getLastRow() < 2) return r;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, ROSTER_COLS).getValues();
  var byId = {}, byName = {};
  rows.forEach(function (x) {
    if (String(x[1]).trim()) return;
    var name = String(x[0]).trim();
    if (!name) return;
    var id = String(x[5] || x[6] || '').trim();
    if (!id) { id = newEntityId_(); r.fix = true; }
    if (byId[id]) { r.fix = true; return; }
    var del = yes_(x[4]), k = lc_(name);
    if (!del && byName[k]) { byName[k].hidden = byName[k].hidden || yes_(x[2]); r.fix = true; return; }
    var t = { id: id, name: name, hidden: yes_(x[2]), updatedAt: Number(x[3]) || 0, deleted: del, row: true };
    byId[id] = t; if (!del) byName[k] = t;
    r.teams.push(t);
  });
  var seen = {};
  rows.forEach(function (x) {
    var mn = String(x[1]).trim();
    if (!mn) return;
    var tn = String(x[0]).trim(), tid = String(x[6] || '').trim();
    var t = (tid && byId[tid]) || (tn && byName[lc_(tn)]) || null;
    if (!t && tn) {
      t = { id: newEntityId_(), name: tn, hidden: false, updatedAt: 0, deleted: false, row: false };
      byId[t.id] = t; byName[lc_(tn)] = t; r.teams.push(t); r.fix = true;
    }
    if (t && !t.row && yes_(x[2])) t.hidden = true; // eski biçim: gizli bilgisi kişi satırlarında
    if (!tid) r.fix = true;
    var id = String(x[5] || '').trim();
    if (!id) { id = newEntityId_(); r.fix = true; }
    var m = { id: id, name: mn, team: t ? t.id : tid, updatedAt: Number(x[3]) || 0, deleted: yes_(x[4]) };
    var k = lc_(mn);
    if (seen[k] !== undefined) {
      r.fix = true;
      if (m.updatedAt > r.members[seen[k]].updatedAt) r.members[seen[k]] = m;
      return;
    }
    seen[k] = r.members.length; r.members.push(m);
  });
  return r;
}

function writeRoster2_(sh, r) {
  var rows = [], known = {};
  r.teams.forEach(function (t) { known[t.id] = true; });
  r.teams.forEach(function (t) {
    var hid = t.hidden ? 'EVET' : '';
    rows.push([t.name, '', hid, t.updatedAt || 0, t.deleted ? 'EVET' : '', t.id, t.id]);
    r.members.forEach(function (m) {
      if (m.team === t.id) rows.push([t.name, m.name, hid, m.updatedAt || 0, m.deleted ? 'EVET' : '', m.id, t.id]);
    });
  });
  r.members.forEach(function (m) {
    if (!known[m.team]) rows.push(['', m.name, '', m.updatedAt || 0, m.deleted ? 'EVET' : '', m.id, m.team || '']);
  });
  sh.getRange(1, 1, 1, ROSTER_COLS).setValues([ROSTER_HEADER]).setFontWeight('bold').setBackground('#e5e7eb');
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, ROSTER_COLS).clearContent();
  if (rows.length) {
    sh.getRange(2, 1, rows.length, ROSTER_COLS).setValues(rows);
    sh.getRange(2, 4, rows.length, 1).setNumberFormat('0');
  }
  r.fix = false;
}

// Varlık başına "son yazan kazanır" birleştirme. Hiçbir satır körlemesine silinmez.
function mergeRoster2_(r, changes) {
  var aliases = {}, changed = false, byId = {}, byName = {}, byM = {};
  r.teams.forEach(function (t) { byId[t.id] = t; if (!t.deleted) byName[lc_(t.name)] = t; });
  r.members.forEach(function (m) { byM[lc_(m.name)] = m; });
  (changes || []).forEach(function (c) {
    if (!c || c.type !== 'team') return;
    var name = String(c.name == null ? '' : c.name).trim();
    if (!name) return;
    var id = String(c.id || '').trim(), at = Number(c.updatedAt) || 0;
    var t = id ? byId[id] : null;
    if (!t && !c.deleted && byName[lc_(name)]) { t = byName[lc_(name)]; if (id) aliases[id] = t.id; } // aynı adlı ekip: tek ekip
    if (!t) {
      t = { id: id || newEntityId_(), name: name, hidden: !!c.hidden, updatedAt: at, deleted: !!c.deleted };
      if (!id) aliases[name] = t.id;
      byId[t.id] = t; if (!t.deleted) byName[lc_(name)] = t;
      r.teams.push(t); changed = true;
      return;
    }
    if (at > (t.updatedAt || 0)) {
      if (byName[lc_(t.name)] === t) delete byName[lc_(t.name)];
      t.name = name; t.hidden = !!c.hidden; t.deleted = !!c.deleted; t.updatedAt = at;
      if (!t.deleted) byName[lc_(name)] = t;
      changed = true;
    }
  });
  (changes || []).forEach(function (c) {
    if (!c || c.type !== 'member') return;
    var name = String(c.name == null ? '' : c.name).trim();
    if (!name) return;
    var at = Number(c.updatedAt) || 0, team = String(c.team || '');
    if (aliases[team]) team = aliases[team];
    var m = byM[lc_(name)];
    if (!m) {
      m = { id: String(c.id || '') || newEntityId_(), name: name, team: team, updatedAt: at, deleted: !!c.deleted };
      byM[lc_(name)] = m; r.members.push(m); changed = true;
      return;
    }
    if (at > (m.updatedAt || 0)) {
      m.name = name; m.team = team; m.deleted = !!c.deleted; m.updatedAt = at;
      if (c.id) m.id = String(c.id);
      changed = true;
    }
  });
  return { changed: changed, aliases: aliases };
}

function rosterOut_(r) {
  return {
    ok: true, v: API_VERSION,
    teams: r.teams.map(function (t) { return { id: t.id, name: t.name, hidden: !!t.hidden, updatedAt: t.updatedAt || 0, deleted: !!t.deleted }; }),
    members: r.members.map(function (m) { return { id: m.id, name: m.name, team: m.team, updatedAt: m.updatedAt || 0, deleted: !!m.deleted }; })
  };
}

function rosterSs_(req) {
  if (req.site) site_(req);
  return getSpreadsheet_(ROSTER_SITE);
}

function getRoster2_(req) {
  var ss = rosterSs_(req);
  var sh = getRosterSheet_(ss, false);
  var r = readRoster2_(sh);
  if (r.fix) {
    r = withLock_(function () {
      var x = readRoster2_(sh);
      if (x.fix) { writeRoster2_(sh, x); SpreadsheetApp.flush(); }
      return x;
    });
  }
  return rosterOut_(r);
}

function saveRoster2_(req) {
  if (!Array.isArray(req.changes)) throw new Error('changes listesi gerekli.');
  var ss = rosterSs_(req);
  return withLock_(function () {
    var sh = getRosterSheet_(ss, true);
    var r = readRoster2_(sh);
    var m = mergeRoster2_(r, req.changes);
    if (m.changed || r.fix) { writeRoster2_(sh, r); SpreadsheetApp.flush(); }
    var out = rosterOut_(r);
    out.aliases = m.aliases;
    return out;
  });
}

// Eski uygulamalar için (3.0 öncesi): görünen liste
function getRoster_(req) {
  var r = readRoster2_(getRosterSheet_(rosterSs_(req), false));
  var teams = r.teams.filter(function (t) { return !t.deleted; }).map(function (t) {
    return {
      name: t.name, hidden: !!t.hidden,
      members: r.members.filter(function (m) { return !m.deleted && m.team === t.id; }).map(function (m) { return m.name; })
    };
  });
  return { ok: true, teams: teams };
}

// Eski uygulamalar için: artık tümden değiştirme yok. Yalnızca sunucuda olmayan ekip/isimler eklenir
// (zaman damgası 0: yeni telefonların değişikliklerini ve silmelerini asla ezmez).
function saveRoster_(req) {
  if (!Array.isArray(req.teams)) throw new Error('teams listesi gerekli.');
  var ss = rosterSs_(req);
  return withLock_(function () {
    var sh = getRosterSheet_(ss, true);
    var r = readRoster2_(sh);
    var byName = {};
    r.teams.forEach(function (t) { if (!t.deleted) byName[lc_(t.name)] = t.id; });
    var changes = [];
    req.teams.forEach(function (t) {
      var tn = String(t && t.name != null ? t.name : '').trim();
      if (!tn) return;
      var id = byName[lc_(tn)];
      if (!id) { id = newEntityId_(); byName[lc_(tn)] = id; }
      changes.push({ type: 'team', id: id, name: tn, hidden: !!t.hidden, updatedAt: 0 });
      (t.members || []).forEach(function (mm) {
        var mn = String(mm == null ? '' : mm).trim();
        if (mn) changes.push({ type: 'member', name: mn, team: id, updatedAt: 0 });
      });
    });
    var m = mergeRoster2_(r, changes);
    if (m.changed || r.fix) { writeRoster2_(sh, r); SpreadsheetApp.flush(); }
    return { ok: true, saved: changes.length };
  });
}

// ---------------------------------------------------------------- Ortak ayarlar (AYARLAR)
// A Anahtar | B Değer (JSON) | C Güncellenme (ms). Anahtar başına son yazan kazanır.

function getMetaSheet_(ss, create) {
  var sh = ss.getSheetByName(META_SHEET);
  if (sh || !create) return sh;
  sh = ss.insertSheet(META_SHEET);
  sh.getRange(1, 1, 1, 3).setValues([['Anahtar', 'Değer (JSON)', 'Güncellenme']]).setFontWeight('bold').setBackground('#e5e7eb');
  sh.setFrozenRows(1);
  sh.setColumnWidth(2, 500);
  return sh;
}

function readMeta_(sh) {
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  rows.forEach(function (x, i) {
    var k = String(x[0]).trim();
    if (!k || out[k]) return;
    var v = null;
    try { v = JSON.parse(String(x[1])); } catch (e) { v = null; }
    out[k] = { value: v, updatedAt: Number(x[2]) || 0, row: i + 2 };
  });
  return out;
}

function getMeta_(req) {
  var all = readMeta_(getMetaSheet_(getSpreadsheet_(ROSTER_SITE), false));
  var items = {};
  Object.keys(all).forEach(function (k) { items[k] = { value: all[k].value, updatedAt: all[k].updatedAt }; });
  return { ok: true, v: API_VERSION, items: items };
}

// Ayarın adı "metaKey" alanında gelir ("key" alanı gizli anahtardır).
function saveMeta_(req) {
  var key = String(req.metaKey || '');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) throw new Error('Geçersiz ayar adı.');
  var at = Number(req.updatedAt) || 0;
  var value = req.value === undefined ? null : req.value;
  var text = JSON.stringify(value);
  if (text.length > 45000) throw new Error('Ayar çok büyük.');
  var ss = getSpreadsheet_(ROSTER_SITE);
  return withLock_(function () {
    var sh = getMetaSheet_(ss, true);
    var cur = readMeta_(sh)[key];
    if (cur && cur.updatedAt > at) return { ok: true, v: API_VERSION, applied: false, metaKey: key, value: cur.value, updatedAt: cur.updatedAt };
    var row = cur ? cur.row : sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, 3).setValues([[key, text, at]]);
    sh.getRange(row, 3).setNumberFormat('0');
    SpreadsheetApp.flush();
    return { ok: true, v: API_VERSION, applied: true, metaKey: key, value: value, updatedAt: at };
  });
}

// ---------------------------------------------------------------- Fotoğraf

function dayFolder_(root, dt) {
  var it = root.getFoldersByName(dt.tr);
  return it.hasNext() ? it.next() : root.createFolder(dt.tr);
}

function uploadPhoto_(req) {
  var cfg = site_(req);
  var dt = parseDate_(req.date);
  if (!req.base64) throw new Error('Fotoğraf verisi boş.');
  var bytes = Utilities.base64Decode(req.base64);
  var root = DriveApp.getFolderById(cfg.photoFolderId);

  // İrsaliye: numara sunucuda, kilit altında verilir (iki telefon aynı numarayı alamaz)
  if (req.kind === 'irsaliye') {
    var sel = /^s_/.test(String(req.name || '')); // istemci seçili gönderdiyse s_ öneki korunur
    return withLock_(function () { return saveIrsaliye_(dayFolder_(root, dt), dt, bytes, String(req.uid || ''), sel); });
  }

  // Tarih klasörü kilit altında bulunur/oluşturulur (aynı adlı iki klasör olmasın)
  var folder = withLock_(function () { return dayFolder_(root, dt); });

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
    if (f.getSize() === bytes.length) return { ok: true, v: API_VERSION, fileId: f.getId(), name: fname, duplicate: true };
  }
  var blob = Utilities.newBlob(bytes, 'image/jpeg', fname);
  var file = folder.createFile(blob);
  return { ok: true, v: API_VERSION, fileId: file.getId(), name: fname };
}

// Fotoğraf seçimi: dosya adının başındaki "s_" eklenir/çıkarılır. Başka hiçbir yeniden adlandırma, silme veya çöpe atma yapılmaz.
function renamePhoto_(req) {
  var id = String(req.fileId || '');
  if (!id) return { ok: false, error: 'fileId boş.' };
  var file;
  try { file = DriveApp.getFileById(id); } catch (e) { return { ok: false, error: 'Dosya bulunamadı.' }; }
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
  if (!inside) return { ok: false, error: 'Dosya şantiye fotoğraf klasörlerinde değil, adı değiştirilmedi.' };
  var cur = file.getName();
  var base = cur.replace(/^(s_)+/, '');
  var name = (req.selected === true || req.selected === 'true' ? 's_' : '') + base;
  if (name !== cur) file.setName(name);
  return { ok: true, v: API_VERSION, name: name };
}

function saveIrsaliye_(folder, dt, bytes, uid, sel) {
  // Numara sayılırken s_ öneki yok sayılır (seçili ve seçisiz irsaliye aynı sırayı paylaşır)
  var re = new RegExp('^(?:s_)*İrsaliye_' + dt.tr.replace(/\./g, '\\.') + '_(\\d+)\\.jpg$');
  var max = 0, it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    // Yanıtı kaybolan yükleme tekrar gelirse aynı dosya döner
    if (uid && f.getDescription() === 'sd:' + uid) return { ok: true, v: API_VERSION, fileId: f.getId(), name: f.getName(), duplicate: true };
    var m = re.exec(f.getName());
    if (m) max = Math.max(max, Number(m[1]));
  }
  var name = (sel ? 's_' : '') + 'İrsaliye_' + dt.tr + '_' + (max + 1) + '.jpg';
  var file = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', name));
  if (uid) file.setDescription('sd:' + uid);
  return { ok: true, v: API_VERSION, fileId: file.getId(), name: name };
}
