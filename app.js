// Şantiye Defteri - ana uygulama (çerçevesiz, derleme yok, çevrimdışı çalışır)
const SITES = { gundogdu: 'Gündoğdu', koseilyas: 'Köseilyas' };
const RADIUS_M = 300;
const MONTHS_TR = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
const DAYS_TR = ['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];

const $ = (id) => document.getElementById(id);

// ---------- localStorage (hata verebilir: her erişim korumalı) ----------
const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* yoksay */ } }
};
const getSettings = () => { const s = ls.get('sd_settings', {}) || {}; return { url: (s.url || '').trim(), key: (s.key || '').trim() }; };

// ---------- IndexedDB ----------
let dbPromise;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open('santiye-defteri', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('days', { keyPath: 'key' });
      db.createObjectStore('names', { keyPath: 'site' });
      const p = db.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
      p.createIndex('siteDate', ['site', 'date']);
      p.createIndex('status', 'status');
      db.createObjectStore('queue', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}
async function dbDo(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const dbGet = (s, k) => dbDo(s, 'readonly', (o) => o.get(k));
const dbPut = (s, v) => dbDo(s, 'readwrite', (o) => o.put(v));
const dbDel = (s, k) => dbDo(s, 'readwrite', (o) => o.delete(k));
const dbAll = (s) => dbDo(s, 'readonly', (o) => o.getAll());
const dbIndexAll = (s, idx, q) => dbDo(s, 'readonly', (o) => o.index(idx).getAll(q));

// ---------- Tarih yardımcıları (yerel saat, UTC değil) ----------
const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => toISO(new Date());
function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function shiftDate(s, delta) { const d = parseISO(s); d.setDate(d.getDate() + delta); return toISO(d); }
const trDate = (s) => { const d = parseISO(s); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };
function longDate(s) {
  const d = parseISO(s);
  return `${d.getDate()} ${MONTHS_TR[d.getMonth()]} ${d.getFullYear()}, ${DAYS_TR[d.getDay()]}`;
}
const fmtNum = (n) => String(n).replace('.', ',');

// ---------- Durum ----------
const state = { site: null, date: today(), day: null, names: [], editMode: false };
let photoUrls = [];

function toast(msg, ms = 2800) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- Gün verisi ----------
const dayKey = (site, date) => `${site}|${date}`;
async function loadDay() {
  const rec = await dbGet('days', dayKey(state.site, state.date));
  state.day = rec || { key: dayKey(state.site, state.date), site: state.site, date: state.date, attendance: {}, note: '', updatedAt: 0, synced: true };
  const n = await dbGet('names', state.site);
  state.names = n ? n.list : [];
}
async function persistDay(day) {
  day.updatedAt = Date.now();
  day.synced = false;
  await dbPut('days', day);
  await dbPut('queue', { id: `day|${day.site}|${day.date}`, type: 'saveDay', site: day.site, date: day.date });
  refreshBanner();
  scheduleSync();
}
async function saveNames() { await dbPut('names', { site: state.site, list: state.names }); }

// ---------- Çizim ----------
function renderDate() {
  $('dateText').textContent = (state.date === today() ? 'Bugün · ' : '') + longDate(state.date);
  $('dateInput').value = state.date;
}
function renderTabs() {
  document.querySelectorAll('#siteTabs button').forEach((b) => {
    const on = b.dataset.site === state.site;
    b.classList.toggle('active', on); b.setAttribute('aria-selected', on);
  });
}
function renderChips() {
  const box = $('chips'); box.textContent = '';
  const att = state.day.attendance;
  if (!state.names.length) {
    const p = document.createElement('div'); p.className = 'hint';
    p.textContent = 'Henüz isim yok. Aşağıdan "+ Yeni isim" ile ekleyin.';
    box.appendChild(p);
  }
  for (const name of state.names) {
    if (state.editMode) {
      const w = document.createElement('span'); w.className = 'chip-edit';
      const r = document.createElement('button'); r.type = 'button'; r.textContent = name + ' ✎'; r.dataset.rename = name;
      const d = document.createElement('button'); d.type = 'button'; d.className = 'del'; d.textContent = '✕'; d.dataset.del = name;
      d.setAttribute('aria-label', name + ' sil');
      w.append(r, d); box.appendChild(w);
    } else {
      const v = att[name];
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'chip' + (v === 1 ? ' full' : v === 0.5 ? ' half' : '');
      b.dataset.name = name;
      b.append(document.createTextNode(name));
      if (v) { const s = document.createElement('small'); s.textContent = v === 1 ? 'Tam' : 'Yarım'; b.appendChild(s); }
      box.appendChild(b);
    }
  }
  const vals = Object.values(att).filter((v) => v > 0);
  const sum = vals.reduce((a, b) => a + b, 0);
  const label = state.date === today() ? 'Bugün' : 'Bu gün';
  $('summary').textContent = `${label}: ${vals.length} kişi (${fmtNum(sum)} gün)`;
  $('editNames').textContent = state.editMode ? 'Bitti' : 'Düzenle';
  $('addForm').hidden = false;
}
function renderNote() {
  const ta = $('note');
  if (document.activeElement !== ta) ta.value = state.day.note || '';
}
async function renderPhotos() {
  const list = await dbIndexAll('photos', 'siteDate', [state.site, state.date]);
  photoUrls.forEach((u) => URL.revokeObjectURL(u)); photoUrls = [];
  const grid = $('photoGrid'); grid.textContent = '';
  for (const p of list) {
    const div = document.createElement('div'); div.className = 'photo ' + (p.status === 'sent' ? 'sent' : 'pending');
    const img = document.createElement('img');
    const blob = p.thumb || p.blob;
    if (blob) { const u = URL.createObjectURL(blob); photoUrls.push(u); img.src = u; }
    img.alt = 'Fotoğraf';
    const s = document.createElement('span'); s.textContent = p.status === 'sent' ? 'Gönderildi' : 'Bekliyor';
    div.append(img, s); grid.appendChild(div);
  }
}
async function renderAll() {
  renderDate(); renderTabs();
  if (!state.site) return;
  await loadDay();
  renderChips(); renderNote(); await renderPhotos();
  $('noteState').textContent = '';
}

// ---------- Şantiye / tarih seçimi ----------
async function flushNote() {
  clearTimeout(noteTimer);
  if (!state.day || !noteDirty) return;
  noteDirty = false;
  state.day.note = $('note').value;
  await persistDay(state.day);
  $('noteState').textContent = 'Kaydedildi';
}
async function selectSite(site) {
  await flushNote();
  state.site = site; ls.set('sd_site', site);
  state.editMode = false;
  await renderAll();
  $('picker').hidden = true;
}
async function setDate(date) {
  if (!date) return;
  await flushNote();
  state.date = date; state.editMode = false;
  await renderAll();
}

// ---------- Konum ----------
function haversine(a, b) {
  const R = 6371000, rad = (x) => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Konum desteklenmiyor'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => reject(e), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  });
}
async function detectSite() {
  const coords = ls.get('sd_coords', {}) || {};
  if (!Object.keys(coords).length) return null;
  try {
    const pos = await getPosition();
    let best = null;
    for (const [site, c] of Object.entries(coords)) {
      const d = haversine(pos, c);
      if (d <= RADIUS_M && (!best || d < best.d)) best = { site, d };
    }
    return best ? best.site : null;
  } catch { return null; }
}
function renderLocInfo() {
  const coords = ls.get('sd_coords', {}) || {};
  for (const s of Object.keys(SITES)) {
    $('loc-' + s).textContent = coords[s] ? `Kayıtlı: ${coords[s].lat.toFixed(5)}, ${coords[s].lng.toFixed(5)}` : 'Henüz kaydedilmedi.';
  }
}

// ---------- Puantaj olayları ----------
$('chips').addEventListener('click', async (e) => {
  const t = e.target.closest('button'); if (!t) return;
  const att = state.day.attendance;
  if (t.dataset.name) {
    const n = t.dataset.name, v = att[n];
    if (!v) att[n] = 1; else if (v === 1) att[n] = 0.5; else delete att[n];
    renderChips(); await persistDay(state.day);
  } else if (t.dataset.rename) {
    const old = t.dataset.rename;
    const nn = (prompt('Yeni ad:', old) || '').trim();
    if (!nn || nn === old) return;
    if (state.names.includes(nn)) return toast('Bu isim zaten var.');
    await renameName(old, nn);
  } else if (t.dataset.del) {
    const n = t.dataset.del;
    if (!confirm(`"${n}" listeden silinsin mi? (Eski günlerdeki kayıtlar kalır.)`)) return;
    state.names = state.names.filter((x) => x !== n);
    await saveNames(); renderChips();
  }
});
async function renameName(old, nn) {
  state.names = state.names.map((x) => (x === old ? nn : x));
  await saveNames();
  // Bu şantiyenin günlerindeki kayıtları da yeni isme taşı
  const all = await dbAll('days');
  for (const d of all) {
    if (d.site === state.site && d.attendance && old in d.attendance) {
      d.attendance[nn] = d.attendance[old]; delete d.attendance[old];
      if (d.key === state.day.key) state.day = d;
      await persistDay(d);
    }
  }
  renderChips();
}
$('editNames').addEventListener('click', () => { state.editMode = !state.editMode; renderChips(); });
$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('newName').value.trim().replace(/\s+/g, ' ');
  if (!v) return;
  if (state.names.some((n) => n.toLocaleLowerCase('tr') === v.toLocaleLowerCase('tr'))) { toast('Bu isim zaten var.'); return; }
  state.names.push(v);
  $('newName').value = '';
  renderChips();
  await saveNames();
});
$('copyYesterday').addEventListener('click', async () => {
  const prev = await dbGet('days', dayKey(state.site, shiftDate(state.date, -1)));
  if (!prev || !Object.keys(prev.attendance || {}).length) return toast('Dünkü liste bulunamadı.');
  if (Object.keys(state.day.attendance).length && !confirm('Bugünkü işaretlerin üzerine yazılsın mı?')) return;
  state.day.attendance = { ...prev.attendance };
  let added = false;
  for (const n of Object.keys(prev.attendance)) if (!state.names.includes(n)) { state.names.push(n); added = true; }
  if (added) await saveNames();
  renderChips(); await persistDay(state.day);
  toast('Dünkü liste kopyalandı.');
});

// ---------- Not (otomatik kayıt) ----------
let noteTimer, noteDirty = false;
$('note').addEventListener('input', () => {
  noteDirty = true; $('noteState').textContent = 'Yazılıyor…';
  clearTimeout(noteTimer); noteTimer = setTimeout(flushNote, 700);
});
$('note').addEventListener('blur', flushNote);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNote(); else { scheduleSync(300); } });
window.addEventListener('pagehide', flushNote);

// ---------- Fotoğraf ----------
async function decode(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* Image ile dene */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}
async function toJpeg(src, maxSide, quality) {
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', quality));
}
async function addPhotos(files) {
  const list = Array.from(files || []);
  if (!list.length || !state.site) return;
  $('photoMsg').textContent = 'Fotoğraflar hazırlanıyor…';
  const site = state.site, date = state.date;
  const existing = await dbIndexAll('photos', 'siteDate', [site, date]);
  let n = existing.length, ok = 0, fail = 0;
  for (const f of list) {
    try {
      const src = await decode(f);
      const blob = await toJpeg(src, 1920, 0.8);
      const thumb = await toJpeg(src, 240, 0.7);
      if (src.close) src.close();
      n++;
      const now = new Date();
      const name = `${trDate(date)}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${n}.jpg`;
      await dbPut('photos', { site, date, name, status: 'pending', blob, thumb, createdAt: Date.now() });
      ok++;
    } catch { fail++; }
  }
  $('photoMsg').textContent = fail ? `${fail} fotoğraf okunamadı (bu biçim desteklenmiyor olabilir).` : '';
  if (ok) toast(`${ok} fotoğraf eklendi.`);
  if (state.site === site && state.date === date) await renderPhotos();
  refreshBanner(); scheduleSync();
}
for (const id of ['camInput', 'galInput']) {
  $(id).addEventListener('change', async (e) => { const files = e.target.files; await addPhotos(files); e.target.value = ''; });
}

// ---------- Senkronizasyon ----------
async function pendingCount() {
  const q = await dbAll('queue');
  const p = await dbIndexAll('photos', 'status', 'pending');
  return q.length + p.length;
}
let syncing = false, resync = false, lastError = '';
async function refreshBanner() {
  const n = await pendingCount();
  $('pendingCount').textContent = String(n);
  const bar = $('syncBar');
  bar.classList.toggle('pending', n > 0); bar.classList.toggle('err', !!lastError);
  $('syncText').innerHTML = n > 0 ? `<b id="pendingCount">${n}</b> öğe gönderilmeyi bekliyor` : `<b id="pendingCount">0</b> öğe bekliyor · hepsi gönderildi`;
  $('syncNow').disabled = syncing;
  $('syncNow').textContent = syncing ? 'Gönderiliyor…' : 'Şimdi gönder';
  const e = $('syncError'); e.hidden = !lastError; e.textContent = lastError;
}
function setError(msg) { lastError = msg || ''; }
async function post(payload) {
  const { url, key } = getSettings();
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 90000);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, key }), signal: ctl.signal });
  } catch { throw new Error('Sunucuya ulaşılamadı (internet yok olabilir). Veriler telefonda duruyor, sonra tekrar denenecek.'); }
  finally { clearTimeout(timer); }
  let data;
  try { data = await res.json(); } catch { throw new Error('Sunucudan beklenmeyen yanıt geldi. Apps Script adresini kontrol edin.'); }
  if (!data || !data.ok) throw new Error((data && data.error) || 'Sunucu hata döndürdü.');
  return data;
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
async function sync(manual = false) {
  if (syncing) { resync = true; return; }
  syncing = true; refreshBanner();
  try {
    const { url, key } = getSettings();
    const total = await pendingCount();
    if (!url || !key) {
      setError(total > 0 || manual ? 'Ayarlar bölümünde Apps Script adresi ve gizli anahtar girilmemiş. Veriler telefonda güvende, ayar yapılınca gönderilir.' : '');
      return;
    }
    setError('');
    // 1) günler
    for (const q of await dbAll('queue')) {
      const day = await dbGet('days', dayKey(q.site, q.date));
      if (!day) { await dbDel('queue', q.id); continue; }
      const stamp = day.updatedAt;
      await post({ action: 'saveDay', site: day.site, date: day.date, attendance: day.attendance, note: day.note || '' });
      const cur = await dbGet('days', day.key);
      if (cur && cur.updatedAt === stamp) { cur.synced = true; await dbPut('days', cur); await dbDel('queue', q.id); }
      refreshBanner();
    }
    // 2) fotoğraflar, tek tek
    for (const p of await dbIndexAll('photos', 'status', 'pending')) {
      if (!p.blob) { p.status = 'sent'; await dbPut('photos', p); continue; }
      const base64 = await blobToBase64(p.blob);
      const r = await post({ action: 'uploadPhoto', site: p.site, date: p.date, name: p.name, base64 });
      p.status = 'sent'; p.fileId = r.fileId || ''; p.blob = null; // küçük resim kalır, büyük dosya silinir
      await dbPut('photos', p);
      refreshBanner();
      if (state.site === p.site && state.date === p.date) renderPhotos();
    }
  } catch (err) {
    setError(err.message || 'Gönderim başarısız.');
  } finally {
    syncing = false; refreshBanner();
    if (resync && !lastError) { resync = false; sync(); } else resync = false;
  }
}
let syncTimer;
function scheduleSync(ms = 1500) { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(), ms); }
$('syncNow').addEventListener('click', () => sync(true));
window.addEventListener('online', () => sync());
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 60000);

// ---------- Ayarlar ----------
function openSettings() {
  const s = getSettings(); $('setUrl').value = s.url; $('setKey').value = s.key;
  $('testResult').textContent = ''; renderLocInfo(); $('settings').hidden = false;
}
function readSettingsForm() { ls.set('sd_settings', { url: $('setUrl').value.trim(), key: $('setKey').value.trim() }); }
$('btnSettings').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', () => { $('settings').hidden = true; scheduleSync(300); });
$('saveSettings').addEventListener('click', () => { readSettingsForm(); $('testResult').textContent = 'Kaydedildi.'; });
$('testConn').addEventListener('click', async () => {
  readSettingsForm();
  const { url, key } = getSettings(); const out = $('testResult');
  if (!url || !key) { out.textContent = 'Önce adresi ve anahtarı girin.'; return; }
  out.textContent = 'Deneniyor…';
  try { await post({ action: 'ping' }); out.textContent = 'Bağlantı başarılı.'; }
  catch (e) { out.textContent = 'Hata: ' + e.message; }
});
document.querySelectorAll('[data-save-loc]').forEach((b) => b.addEventListener('click', async () => {
  const site = b.dataset.saveLoc; const info = $('loc-' + site);
  info.textContent = 'Konum alınıyor…';
  try {
    const pos = await getPosition();
    const c = ls.get('sd_coords', {}) || {}; c[site] = pos; ls.set('sd_coords', c);
    renderLocInfo(); toast(`${SITES[site]} konumu kaydedildi.`);
  } catch { info.textContent = 'Konum alınamadı. Safari\'de konum iznini kontrol edin.'; }
}));

// ---------- Bağlantılar ----------
document.querySelectorAll('#siteTabs button').forEach((b) => b.addEventListener('click', () => selectSite(b.dataset.site)));
document.querySelectorAll('#picker [data-site]').forEach((b) => b.addEventListener('click', () => selectSite(b.dataset.site)));
$('prevDay').addEventListener('click', () => setDate(shiftDate(state.date, -1)));
$('nextDay').addEventListener('click', () => setDate(shiftDate(state.date, 1)));
$('dateInput').addEventListener('change', (e) => setDate(e.target.value));

// ---------- Başlangıç ----------
async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const last = ls.get('sd_site', null);
  renderDate(); renderTabs(); refreshBanner();
  if (last && SITES[last]) await selectSite(last);
  else $('picker').hidden = false;
  const found = await detectSite();
  if (found && found !== state.site) { await selectSite(found); toast(`Konuma göre ${SITES[found]} açıldı.`); }
  sync();
}
init();
