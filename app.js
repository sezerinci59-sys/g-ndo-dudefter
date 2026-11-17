import { SURUMLER } from './surum.js';
// Şantiye Defteri - ana uygulama (çerçevesiz, derleme yok, çevrimdışı çalışır)
const SITES = { gundogdu: 'Gündoğdu', koseilyas: 'Köseilyas' };
const RADIUS_M = 300;
const MONTHS_TR = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
const MONTHS_ABBR = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
const DAYS_ABBR = ['Paz','Pzt','Sal','Çar','Per','Cum','Cmt'];
const DAYS_TR = ['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];

const $ = (id) => document.getElementById(id);

// ---------- localStorage (hata verebilir: her erişim korumalı) ----------
const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* yoksay */ }
    if (META_KEYS.includes(k)) mirrorMeta(k, v);
  }
};
const META_KEYS = ['sd_settings', 'sd_coords', 'sd_site'];
function mirrorMeta(k, v) { dbPut('meta', { k, v }).catch(() => {}); }
async function syncMeta() {
  for (const k of META_KEYS) {
    try {
      const l = ls.get(k, null);
      const rec = await dbGet('meta', k);
      if (l === null && rec && rec.v != null) { try { localStorage.setItem(k, JSON.stringify(rec.v)); } catch { /* yoksay */ } }
      else if (l !== null && !rec) mirrorMeta(k, l);
    } catch { /* yoksay */ }
  }
}
const getSettings = () => { const s = ls.get('sd_settings', {}) || {}; return { url: (s.url || '').trim(), key: (s.key || '').trim() }; };

// ---------- IndexedDB ----------
let dbPromise;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open('santiye-defteri', 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('days')) db.createObjectStore('days', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('names')) db.createObjectStore('names', { keyPath: 'site' });
      if (!db.objectStoreNames.contains('photos')) {
        const p = db.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
        p.createIndex('siteDate', ['site', 'date']);
        p.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
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
function shortDate(s) {
  const d = parseISO(s);
  return `${d.getDate()} ${MONTHS_ABBR[d.getMonth()]} ${d.getFullYear()} ${DAYS_ABBR[d.getDay()]}`;
}
const fmtNum = (n) => String(n).replace('.', ',');

// ---------- Durum ----------
const state = { site: null, date: today(), day: null, teams: [], members: [], pulled: false };
const ui = { hideTeam: null, delName: null, closed: new Set() };
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
  await loadNames();
}
const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const EKIPSIZ = 'Ekipsiz';
// Eski biçim {site, list:[ad]} -> yeni biçim {site, teams, members}; kayıp yok, otomatik.
async function loadNames() {
  const rec = await dbGet('names', state.site);
  if (rec && Array.isArray(rec.teams)) {
    state.teams = rec.teams; state.members = rec.members || []; state.pulled = !!rec.pulled;
    return;
  }
  state.teams = []; state.members = []; state.pulled = false;
  const list = (rec && Array.isArray(rec.list)) ? rec.list : [];
  if (list.length) {
    const id = newId();
    state.teams.push({ id, name: EKIPSIZ, hidden: false });
    state.members = list.map((name) => ({ name, teamId: id }));
    await saveNames();
  }
}
function ensureEkipsiz() {
  let t = state.teams.find((x) => x.name === EKIPSIZ);
  if (!t) { t = { id: newId(), name: EKIPSIZ, hidden: false }; state.teams.push(t); }
  return t;
}
const hasName = (v) => state.members.some((m) => m.name.toLocaleLowerCase('tr') === v.toLocaleLowerCase('tr'));
// Eski kayıtlarda bayrak yok: senkronize değilse ikisi de değişmiş sayılır.
const isAttDirty = (d) => d.attDirty != null ? !!d.attDirty : !d.synced;
const isNoteDirty = (d) => d.noteDirty != null ? !!d.noteDirty : !d.synced;
async function persistDay(day, what = {}) {
  const a = isAttDirty(day) || !!what.att, n = isNoteDirty(day) || !!what.note;
  day.attDirty = a; day.noteDirty = n;
  day.updatedAt = Date.now();
  day.synced = false;
  await dbPut('days', day);
  await dbPut('queue', { id: `day|${day.site}|${day.date}`, type: 'saveDay', v: 2, site: day.site, date: day.date });
  refreshBanner();
  scheduleSync();
}
async function saveRosterData(site, r) {
  await dbPut('names', { site, teams: r.teams, members: r.members, list: r.members.map((m) => m.name), pulled: !!r.pulled });
}
const saveNames = () => saveRosterData(state.site, state);
// Yerel ekip/isim değişikliği: kaydet ve sunucuya gönderilmek üzere sıraya al (site başına tek kayıt).
const rosterDirty = new Set();
let rosterRev = 0;
async function enqueueRoster(site) {
  rosterDirty.add(site);
  await dbPut('queue', { id: `roster|${site}`, type: 'saveRoster', site, rev: Date.now() + '.' + (++rosterRev) });
  refreshBanner(); scheduleSync();
}
async function persistRoster() {
  const site = state.site; rosterDirty.add(site);
  await saveNames(); await enqueueRoster(site);
}

// ---------- Çizim ----------
function renderDate() {
  $('dateText').textContent = (state.date === today() ? 'Bugün · ' : '') + shortDate(state.date);
  $('puanSite').textContent = SITES[state.site] || '';
  $('dateInput').value = state.date;
}
function renderTabs() {
  document.querySelectorAll('#siteTabs button').forEach((b) => {
    const on = b.dataset.site === state.site;
    b.classList.toggle('active', on); b.setAttribute('aria-selected', on);
  });
  $('puanSite').textContent = SITES[state.site] || '';
}
const TEAM_COLORS = ['#2f7d2f', '#245edb', '#b45500', '#7a4fb5', '#c0392b', '#0f7a7a', '#8b5a2b'];
function teamColor(name) { let h = 2166136261; for (const c of String(name)) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0; return TEAM_COLORS[(h >>> 8) % TEAM_COLORS.length]; }
function chipBtn(name, v) {
  const b = document.createElement('button'); b.type = 'button';
  b.className = 'chip' + (v === 1 ? ' full' : v === 0.5 ? ' half' : '');
  b.dataset.name = name;
  b.append(document.createTextNode(name));
  if (v) { const s = document.createElement('small'); s.textContent = v === 1 ? 'Tam' : 'Yarım'; b.appendChild(s); }
  return b;
}
function renderChips() {
  const box = $('chips'); box.textContent = '';
  const att = state.day.attendance;
  const label = state.date === today() ? 'Bugün' : 'Bu gün';
  const visible = state.teams.filter((t) => !t.hidden);
  if (!visible.length) {
    const p = document.createElement('div'); p.className = 'hint';
    p.textContent = 'Henüz ekip yok. Aşağıdan "+ Yeni ekip" ile ekleyin.';
    box.appendChild(p);
  }
  for (const t of visible) {
    const mem = state.members.filter((m) => m.teamId === t.id);
    const present = mem.filter((m) => att[m.name] > 0).length;
    const sec = document.createElement('section'); sec.className = 'team'; sec.dataset.team = t.id; sec.style.setProperty('--tc', teamColor(t.name));
    const head = document.createElement('div'); head.className = 'team-head';
    const h = document.createElement('h3'); h.textContent = t.name;
    const cnt = document.createElement('span'); cnt.className = 'team-count';
    cnt.textContent = `${label.toLowerCase()} ${present}/${mem.length}`;
    const all = document.createElement('button'); all.type = 'button'; all.className = 'btn small ghost';
    all.dataset.all = t.id; all.textContent = 'Hepsi geldi';
    head.append(h, cnt, all); sec.appendChild(head);
    const chips = document.createElement('div'); chips.className = 'chips';
    for (const m of mem) chips.appendChild(chipBtn(m.name, att[m.name]));
    sec.appendChild(chips);
    const f = document.createElement('form'); f.className = 'addform teamadd'; f.dataset.team = t.id; f.autocomplete = 'off';
    const i = document.createElement('input'); i.type = 'text'; i.placeholder = 'Yeni isim'; i.autocapitalize = 'words';
    i.setAttribute('aria-label', t.name + ' ekibine isim ekle');
    const ab = document.createElement('button'); ab.type = 'submit'; ab.className = 'btn small plus'; ab.textContent = '+';
    ab.setAttribute('aria-label', t.name + ' ekibine ekle');
    f.append(i, ab); sec.appendChild(f);
    box.appendChild(sec);
  }
  // Gizli ekiplerde / listede olmayıp o gün kaydı olanlar görünür kalır
  const byName = new Map(state.members.map((m) => [m.name, m]));
  const hiddenIds = new Set(state.teams.filter((t) => t.hidden).map((t) => t.id));
  const hid = [], orphan = [];
  for (const n of Object.keys(att)) {
    if (!(att[n] > 0)) continue;
    const m = byName.get(n);
    if (!m) orphan.push(n); else if (hiddenIds.has(m.teamId)) hid.push(n);
  }
  for (const [title, arr, cls] of [['Gizli ekipten', hid, 'hiddengrp'], ['Listede olmayanlar', orphan, 'orphangrp']]) {
    if (!arr.length) continue;
    const sec = document.createElement('section'); sec.className = 'team ' + cls;
    const h = document.createElement('h3'); h.textContent = title;
    const chips = document.createElement('div'); chips.className = 'chips';
    for (const n of arr) chips.appendChild(chipBtn(n, att[n]));
    sec.append(h, chips); box.appendChild(sec);
  }
  const vals = Object.values(att).filter((v) => v > 0);
  const sum = vals.reduce((a, b) => a + b, 0);
  $('summary').textContent = `${label}: ${vals.length} kişi (${fmtNum(sum)} gün)`;
}
function renderNote() {
  const ta = $('note');
  if (document.activeElement !== ta) ta.value = state.day.note || '';
}
let armedPhoto = null, armTimer = null;
function disarmPhoto() { clearTimeout(armTimer); armedPhoto = null; }
async function renderPhotos() {
  const list = (await dbIndexAll('photos', 'siteDate', [state.site, state.date])).filter((p) => !p.deleted);
  photoUrls.forEach((u) => URL.revokeObjectURL(u)); photoUrls = [];
  const grid = $('photoGrid'); grid.textContent = '';
  for (const p of list) {
    const div = document.createElement('div'); div.className = 'photo ' + (p.status === 'sent' ? 'sent' : 'pending');
    const img = document.createElement('img');
    const noThumb = () => { div.classList.add('nothumb'); img.remove(); };
    if (p.thumbData) img.src = p.thumbData;
    else if (p.status !== 'sent' && (p.thumb || p.blob)) { const u = URL.createObjectURL(p.thumb || p.blob); photoUrls.push(u); img.src = u; }
    else setTimeout(noThumb, 0);
    img.onerror = noThumb;
    img.alt = 'Fotoğraf';
    const s = document.createElement('span'); s.textContent = p.status === 'sent' ? 'Gönderildi' : 'Bekliyor';
    const d = document.createElement('button'); d.type = 'button'; d.dataset.pdel = String(p.id);
    const armed = armedPhoto === p.id;
    d.className = 'pdel' + (armed ? ' armed' : ''); d.textContent = armed ? 'Sil?' : '✕';
    d.setAttribute('aria-label', armed ? 'Silmek için tekrar dokunun' : 'Fotoğrafı sil');
    div.append(img, s);
    if (p.kind === 'irsaliye') { const t = document.createElement('span'); t.className = 'irs'; t.textContent = 'İrsaliye'; div.appendChild(t); }
    div.append(d); grid.appendChild(div);
  }
}
async function deletePhoto(id) {
  const p = await dbGet('photos', id);
  if (!p) return;
  // Uygulama Drive'dan hiçbir şey silmez: gönderilmiş fotoğraf sadece telefondaki listeden kalkar.
  await dbDel('photos', id);
  await dbDel('queue', `photo|${id}`).catch(() => {});
  if (p.status === 'sent') toast("Listeden kaldırıldı. Drive'daki fotoğraf duruyor.");
  await renderPhotos(); refreshBanner(); scheduleSync();
}
$('photoGrid').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pdel]'); if (!b) return;
  const id = Number(b.dataset.pdel);
  if (armedPhoto === id) { disarmPhoto(); await deletePhoto(id); return; }
  disarmPhoto(); armedPhoto = id;
  armTimer = setTimeout(() => { armedPhoto = null; renderPhotos(); }, 4000);
  renderPhotos();
});
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
  await persistDay(state.day, { note: true });
  $('noteState').textContent = 'Kaydedildi';
}
async function selectSite(site) {
  await flushNote();
  state.site = site; ls.set('sd_site', site);
  await renderAll();
  $('picker').hidden = true;
  pullDay(); pullRoster(site);
}
async function setDate(date) {
  if (!date) return;
  await flushNote();
  state.date = date;
  await renderAll();
  pullDay();
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
const press = { timer: null, suppress: false, x: 0, y: 0, el: null };
function pressEnd() { clearTimeout(press.timer); press.timer = null; if (press.el) press.el.classList.remove('pressing'); press.el = null; }
$('chips').addEventListener('pointerdown', (e) => {
  const t = e.target.closest('button.chip'); if (!t || (e.pointerType === 'mouse' && e.button !== 0)) return;
  pressEnd(); press.suppress = false; press.x = e.clientX; press.y = e.clientY; press.el = t; t.classList.add('pressing');
  const n = t.dataset.name;
  press.timer = setTimeout(async () => {
    press.timer = null; press.suppress = true; pressEnd();
    try { navigator.vibrate?.(15); } catch { /* yoksay */ }
    const att = state.day.attendance;
    att[n] = att[n] === 0.5 ? 1 : 0.5;
    renderChips(); await persistDay(state.day, { att: true });
  }, 450);
});
$('chips').addEventListener('pointermove', (e) => {
  if (press.timer && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) pressEnd();
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => $('chips').addEventListener(ev, () => { if (press.timer) pressEnd(); else if (press.el) pressEnd(); }));
$('chips').addEventListener('contextmenu', (e) => { if (e.target.closest('.chip')) e.preventDefault(); });
$('chips').addEventListener('click', async (e) => {
  const t = e.target.closest('button'); if (!t) return;
  const att = state.day.attendance;
  if (t.dataset.name) {
    if (press.suppress) { press.suppress = false; return; }
    const n = t.dataset.name, v = att[n];
    if (!v) att[n] = 1; else delete att[n];
    renderChips(); await persistDay(state.day, { att: true });
  } else if (t.dataset.all) {
    const mem = state.members.filter((m) => m.teamId === t.dataset.all);
    if (!mem.length || mem.every((m) => att[m.name] === 1)) return;
    for (const m of mem) att[m.name] = 1;
    renderChips(); await persistDay(state.day, { att: true });
  }
});
$('chips').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.closest('form.teamadd'); if (!f) return;
  const inp = f.querySelector('input');
  const v = inp.value.trim().replace(/\s+/g, ' ');
  if (!v) return;
  if (hasName(v)) return toast('Bu isim zaten var.');
  state.members.push({ name: v, teamId: f.dataset.team });
  renderChips();
  const again = document.querySelector(`#chips form.teamadd[data-team="${f.dataset.team}"] input`);
  if (again) again.focus();
  await persistRoster();
});
$('teamForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('newTeam').value.trim().replace(/\s+/g, ' ');
  if (!v) return;
  if (state.teams.some((t) => t.name.toLocaleLowerCase('tr') === v.toLocaleLowerCase('tr'))) return toast('Bu ekip zaten var.');
  state.teams.push({ id: newId(), name: v, hidden: false });
  $('newTeam').value = '';
  renderChips(); await persistRoster();
});

// ---------- Ayarlar > Ekipler ----------
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'text') n.textContent = v; else if (k in n) n[k] = v; else n.setAttribute(k, v); }
  n.append(...kids); return n;
}
function renderTeamSettings() {
  const box = $('teamSettings'); box.textContent = '';
  if (!state.site) return;
  const btn = (text, data, cls = 'btn small ghost') => el('button', { type: 'button', className: cls, text, ...data });
  const teamBlock = (t) => {
    const w = el('div', { className: 'tset', 'data-tset': t.id });
    const nm = el('input', { type: 'text', value: t.name, 'aria-label': 'Ekip adı' }); nm.dataset.tname = t.id; nm.setAttribute('value', t.name);
    w.appendChild(el('div', { className: 'tset-row' }, nm, btn('Adı kaydet', { 'data-trename': t.id })));
    const mem = state.members.filter((m) => m.teamId === t.id);
    const det = el('details', { className: 'tmembers' }, el('summary', { text: `Kişiler (${mem.length})` }));
    for (const m of mem) {
      const sel = el('select', { 'aria-label': m.name + ' ekibi' }); sel.dataset.move = m.name;
      for (const o of state.teams) sel.appendChild(el('option', { value: o.id, text: o.name + (o.hidden ? ' (gizli)' : ''), selected: o.id === m.teamId }));
      const row = el('div', { className: 'mrow' }, el('span', { className: 'mname', text: m.name }), sel);
      if (ui.delName === m.name) row.append(btn('Evet, sil', { 'data-delyes': m.name }, 'btn small danger'), btn('Vazgeç', { 'data-delno': '1' }));
      else row.append(btn('Sil', { 'data-del': m.name }));
      det.appendChild(row);
    }
    det.open = !ui.closed.has(t.id); det.dataset.tid = t.id;
    w.appendChild(det);
    if (t.hidden) w.appendChild(btn('Geri getir', { 'data-unhide': t.id }, 'btn small'));
    else if (ui.hideTeam === t.id) w.appendChild(el('div', { className: 'tset-row' }, btn('Evet, gizle', { 'data-hideyes': t.id }, 'btn small danger'), btn('Vazgeç', { 'data-hideno': '1' })));
    else w.appendChild(btn('Ekibi gizle (işi bitti)', { 'data-hide': t.id }));
    return w;
  };
  const vis = state.teams.filter((t) => !t.hidden), hid = state.teams.filter((t) => t.hidden);
  if (!vis.length) box.appendChild(el('p', { className: 'hint', text: 'Görünen ekip yok.' }));
  vis.forEach((t) => box.appendChild(teamBlock(t)));
  if (hid.length) {
    box.appendChild(el('h3', { text: 'Gizli ekipler' }));
    hid.forEach((t) => box.appendChild(teamBlock(t)));
  }
}
$('teamSettings').addEventListener('click', async (e) => {
  const t = e.target.closest('button'); if (!t) return;
  const d = t.dataset; let changed = false;
  if (d.hide) { ui.hideTeam = d.hide; }
  else if (d.hideno) { ui.hideTeam = null; }
  else if (d.hideyes) { const x = state.teams.find((q) => q.id === d.hideyes); if (x) x.hidden = true; ui.hideTeam = null; changed = true; }
  else if (d.unhide) { const x = state.teams.find((q) => q.id === d.unhide); if (x) x.hidden = false; changed = true; }
  else if (d.trename) {
    const v = $('teamSettings').querySelector(`input[data-tname="${d.trename}"]`).value.trim().replace(/\s+/g, ' ');
    const x = state.teams.find((q) => q.id === d.trename);
    if (!v || !x || v === x.name) return;
    if (state.teams.some((q) => q !== x && q.name.toLocaleLowerCase('tr') === v.toLocaleLowerCase('tr'))) return toast('Bu ekip zaten var.');
    x.name = v; changed = true; toast('Ekip adı değişti.');
  }
  else if (d.del) { ui.delName = d.del; }
  else if (d.delno) { ui.delName = null; }
  else if (d.delyes) { state.members = state.members.filter((m) => m.name !== d.delyes); ui.delName = null; changed = true; }
  else return;
  renderTeamSettings();
  if (changed) { await persistRoster(); renderChips(); }
});
$('teamSettings').addEventListener('toggle', (e) => {
  const d = e.target; if (!d.dataset || !d.dataset.tid) return;
  if (d.open) ui.closed.delete(d.dataset.tid); else ui.closed.add(d.dataset.tid);
}, true);
$('teamSettings').addEventListener('change', async (e) => {
  const s = e.target.closest('select[data-move]'); if (!s) return;
  const m = state.members.find((q) => q.name === s.dataset.move);
  if (m) { m.teamId = s.value; await persistRoster(); renderTeamSettings(); renderChips(); }
});
$('copyYesterday').addEventListener('click', async () => {
  const prev = await dbGet('days', dayKey(state.site, shiftDate(state.date, -1)));
  if (!prev || !Object.keys(prev.attendance || {}).length) return toast('Dünkü liste bulunamadı.');
  if (Object.keys(state.day.attendance).length && !confirm('Bugünkü işaretlerin üzerine yazılsın mı?')) return;
  state.day.attendance = { ...prev.attendance };
  let added = false;
  for (const n of Object.keys(prev.attendance)) if (!hasName(n)) { state.members.push({ name: n, teamId: ensureEkipsiz().id }); added = true; }
  if (added) await persistRoster();
  renderChips(); await persistDay(state.day, { att: true });
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
// Gün başına kalıcı İrsaliye sayacı: silinen fotoğrafın numarası asla yeniden kullanılmaz.
function nextIrsNo(site, date) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(['meta', 'photos'], 'readwrite');
    const meta = t.objectStore('meta'), key = `irs|${site}|${date}`;
    let n = 0;
    t.objectStore('photos').index('siteDate').getAll([site, date]).onsuccess = (e) => {
      for (const p of e.target.result) { const m = /_(\d+)\.jpg$/.exec(p.name || ''); if (p.kind === 'irsaliye' && m) n = Math.max(n, Number(m[1])); }
      meta.get(key).onsuccess = (ev) => {
        n = Math.max(n, (ev.target.result && ev.target.result.v) || 0) + 1;
        meta.put({ k: key, v: n });
      };
    };
    t.oncomplete = () => resolve(n);
    t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  }));
}
async function savePhoto(site, date, src, kind) {
  const blob = await toJpeg(src, 1920, 0.8);
  const thumb = await toJpeg(src, 240, 0.7);
  const now = new Date();
  let name;
  if (kind === 'irsaliye') name = `İrsaliye_${trDate(date)}_${await nextIrsNo(site, date)}.jpg`;
  else {
    const n = (await dbIndexAll('photos', 'siteDate', [site, date])).length + 1;
    name = `${trDate(date)}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${n}.jpg`;
  }
  const thumbData = 'data:image/jpeg;base64,' + await blobToBase64(thumb);
  await dbPut('photos', { site, date, name, status: 'pending', blob, thumb, thumbData, createdAt: Date.now(), ...(kind ? { kind } : {}) });
  return thumb;
}
async function addPhotos(files, kind) {
  const list = Array.from(files || []);
  if (!list.length || !state.site) return;
  $('photoMsg').textContent = 'Fotoğraflar hazırlanıyor…';
  const site = state.site, date = state.date;
  let ok = 0, fail = 0;
  for (const f of list) {
    try {
      const src = await decode(f);
      try { await savePhoto(site, date, src, kind); } finally { if (src.close) src.close(); }
      ok++;
    } catch { fail++; }
  }
  $('photoMsg').textContent = fail ? `${fail} fotoğraf okunamadı (bu biçim desteklenmiyor olabilir).` : '';
  if (ok) toast(`${ok} fotoğraf eklendi.`);
  if (state.site === site && state.date === date) await renderPhotos();
  refreshBanner(); scheduleSync();
}
let nativeKind;
for (const id of ['camInput', 'galInput']) {
  $(id).addEventListener('change', async (e) => {
    const files = e.target.files, kind = id === 'camInput' ? nativeKind : undefined;
    if (id === 'camInput') nativeKind = undefined;
    await addPhotos(files, kind); e.target.value = '';
  });
}

// ---------- Uygulama içi seri kamera ----------
const cam = { kind: undefined, stream: null, site: null, date: null, chain: Promise.resolve(), saved: 0, urls: [], fallback: false };
function camNative(why, kind) {
  cam.fallback = true; nativeKind = kind;
  if (why) toast(why, 5000);
  $('camInput').click();
}
async function openCamera(kind) {
  if (kind !== 'irsaliye') kind = undefined;
  if (!state.site) return;
  if (cam.fallback || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
    return camNative(cam.fallback ? (kind ? 'Flaş açılamıyor; iyi ışıkta çekin.' : '') : 'Bu tarayıcıda uygulama içi kamera yok; sistem kamerası açılıyor.', kind);
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
  } catch (err) {
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    return camNative(denied ? 'Kamera izni verilmedi; sistem kamerası açılıyor. (Her fotoğrafta "Kullan" onayı çıkar.)' : 'Kamera açılamadı; sistem kamerası açılıyor.', kind);
  }
  cam.kind = kind;
  $('camMode').hidden = !kind; $('camWarn').hidden = true;
  if (kind) {
    let on = false;
    try {
      const tr = stream.getVideoTracks()[0];
      if (tr && tr.getCapabilities && tr.getCapabilities().torch) {
        await tr.applyConstraints({ advanced: [{ torch: true }] });
        on = !!(tr.getSettings && tr.getSettings().torch);
      }
    } catch { on = false; }
    $('camWarn').hidden = on;
  }
  cam.stream = stream; cam.site = state.site; cam.date = state.date; cam.saved = 0;
  cam.urls.forEach((u) => URL.revokeObjectURL(u)); cam.urls = [];
  $('camStrip').textContent = ''; $('camCount').textContent = '0 fotoğraf';
  const v = $('camVideo'); v.srcObject = stream; $('cam').hidden = false;
  try { await v.play(); } catch { /* autoplay zaten var */ }
}
function camShot() {
  const v = $('camVideo');
  if (!cam.stream || !v.videoWidth) return;
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  try { $('camFlash').animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 180 }); } catch { /* yoksay */ }
  const site = cam.site, date = cam.date, kind = cam.kind;
  // Her çekim hemen tuvale kopyalanır; kodlama/kaydetme sırayla yapılır, hiçbiri düşmez.
  cam.chain = cam.chain.then(async () => {
    try {
      const thumb = await savePhoto(site, date, c, kind);
      cam.saved++;
      $('camCount').textContent = `${cam.saved} fotoğraf`;
      const u = URL.createObjectURL(thumb); cam.urls.push(u);
      const im = document.createElement('img'); im.src = u; im.alt = '';
      const strip = $('camStrip'); strip.prepend(im);
      while (strip.children.length > 3) strip.lastChild.remove();
      refreshBanner();
    } catch { toast('Fotoğraf kaydedilemedi.'); }
  });
}
async function closeCamera() {
  if (!cam.stream) return;
  const s = cam.stream; cam.stream = null;
  s.getTracks().forEach((t) => { try { if (cam.kind) t.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {}); } catch { /* yoksay */ } t.stop(); });
  $('camVideo').srcObject = null; $('cam').hidden = true;
  await cam.chain;
  const n = cam.saved; cam.saved = 0;
  cam.urls.forEach((u) => URL.revokeObjectURL(u)); cam.urls = [];
  if (n) toast(`${n} fotoğraf eklendi.`);
  if (state.site === cam.site && state.date === cam.date) await renderPhotos();
  refreshBanner(); scheduleSync();
}
$('camBtn').addEventListener('click', () => openCamera());
$('matBtn').addEventListener('click', () => openCamera('irsaliye'));
$('camShutter').addEventListener('click', camShot);
$('camDone').addEventListener('click', closeCamera);
document.addEventListener('visibilitychange', () => { if (document.hidden) closeCamera(); });
window.addEventListener('pagehide', closeCamera);

// ---------- Senkronizasyon ----------
async function pendingCount() {
  const q = await dbAll('queue');
  const p = await dbIndexAll('photos', 'status', 'pending');
  return q.length + p.length;
}
let syncing = false, resync = false, lastError = '', needUpdate = false;
const UPDATE_MSG = "Bazı özellikler için Apps Script'i güncelleyin (Ayarlar > Sürüm notları).";
async function refreshBanner() {
  const n = await pendingCount();
  $('pendingCount').textContent = String(n);
  const bar = $('syncBar');
  // "Apps Script'i güncelleyin" uyarısı ana ekranı kalabalıklaştırmaz: bekleyen öğe yoksa kutu gizlenir,
  // uyarı Ayarlar'da (#updateNote) görünür.
  const onlyUpdate = lastError === UPDATE_MSG;
  const showErr = !!lastError && !(onlyUpdate && n === 0);
  bar.classList.toggle('pending', n > 0); bar.classList.toggle('err', showErr);
  $('syncText').innerHTML = n > 0 ? `<b id="pendingCount">${n}</b> öğe gönderilmeyi bekliyor` : `<b id="pendingCount">0</b> öğe bekliyor · hepsi gönderildi`;
  bar.hidden = !(n > 0 || showErr);
  const un = $('updateNote'); if (un) un.hidden = !(needUpdate || onlyUpdate);
  $('syncNow').disabled = syncing;
  $('syncNow').textContent = syncing ? 'Gönderiliyor…' : 'Şimdi gönder';
  const e = $('syncError'); e.hidden = !showErr; e.textContent = showErr ? lastError : '';
}
function setError(msg) { lastError = msg || ''; }
// ---------- Kayıt defteri (log): son 300 olay, anahtar ve fotoğraf içeriği yazılmaz ----------
function logEv(msg) {
  try {
    const arr = JSON.parse(localStorage.getItem('sd_log') || '[]');
    const t = new Date(); const ts = `${pad(t.getDate())}.${pad(t.getMonth() + 1)} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    arr.push(ts + ' ' + msg); while (arr.length > 300) arr.shift();
    localStorage.setItem('sd_log', JSON.stringify(arr));
  } catch { /* yoksay */ }
}
function logSummary(p) {
  const x = [p.action]; if (p.site) x.push(p.site); if (p.date) x.push(p.date);
  if (p.attendance) x.push('puantaj:' + Object.keys(p.attendance).length + ' kişi');
  if (p.note !== undefined) x.push('not');
  if (p.teams) x.push('ekip:' + p.teams.length + ' / kişi:' + p.teams.reduce((n, t) => n + (t.members || []).length, 0));
  if (p.name) x.push(p.name);
  return x.join(' ');
}
async function post(payload) {
  const t0 = Date.now(), sum = logSummary(payload);
  try {
    const r = await postRaw(payload);
    let extra = '';
    if (r && Array.isArray(r.teams)) extra = ' → ekip:' + r.teams.length + ' kişi:' + r.teams.reduce((n, t) => n + (t.members || []).length, 0);
    if (r && r.attendance) extra = ' → puantaj:' + Object.keys(r.attendance).length;
    logEv(`OK ${sum} (${Date.now() - t0} ms)${extra}`);
    return r;
  } catch (e) { logEv(`HATA ${sum}: ${e && e.message}`); throw e; }
}
async function postRaw(payload) {
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
  if (!data || !data.ok) { const e = new Error((data && data.error) || 'Sunucu hata döndürdü.'); e.server = true; throw e; }
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
    // 1) günler ve silme işlemleri
    let noDeleteSupport = false, deleteErr = '';
    for (const q of await dbAll('queue')) {
      if (q.type === 'saveRoster') {
        try {
          const r = await loadRoster(q.site);
          if (!r.teams.length) { await dbDel('queue', q.id); rosterDirty.delete(q.site); continue; } // hiç ekip yok: sunucuyu boşaltma
          if (!r.pulled) { // sunucudakini hiç görmeden üzerine yazma: önce çek ve birleştir
            const d = await post({ action: 'getRoster', site: q.site });
            mergeServerRoster(r, d.teams || []); r.pulled = true;
            await saveRosterData(q.site, r);
            if (q.site === state.site) { renderChips(); if (!$('settings').hidden) renderTeamSettings(); }
          }
          await post({ action: 'saveRoster', site: q.site, teams: toServerTeams(r) });
          const cur = await dbGet('queue', q.id);
          if (cur && cur.rev === q.rev) { await dbDel('queue', q.id); rosterDirty.delete(q.site); }
        } catch (err) {
          if (!err.server) throw err;
          if (/unknown action|Bilinmeyen işlem/i.test(err.message)) noDeleteSupport = true;
          else deleteErr = err.message;
        }
        refreshBanner();
        continue;
      }
      if (q.type === 'deletePhoto') {
        // Drive'dan silme kaldırıldı (silme elle yapılır): eski kuyruk öğesi atılır.
        await dbDel('queue', q.id);
        if (q.photoId != null) await dbDel('photos', q.photoId);
        refreshBanner();
        continue;
      }
      const day = await dbGet('days', dayKey(q.site, q.date));
      if (!day) { await dbDel('queue', q.id); continue; }
      const stamp = day.updatedAt;
      const payload = { action: 'saveDay', site: day.site, date: day.date };
      const legacy = !q.v; // eski sürümden kalan kuyruk öğesi: ikisini de gönder
      let v2 = false; try { v2 = localStorage.getItem('sd_server_v2') === '1'; } catch { /* yoksay */ }
      if (legacy || isAttDirty(day)) payload.attendance = day.attendance;
      if (legacy || isNoteDirty(day) || (!v2 && payload.attendance !== undefined)) payload.note = day.note || '';
      // Eski Apps Script "attendance" yoksa o günün puantajını siler: güncellenene kadar sadece-not gönderimi bekler.
      if (!v2 && payload.attendance === undefined && payload.note !== undefined) {
        needUpdate = true; setError(UPDATE_MSG); refreshBanner(); continue;
      }
      if (payload.attendance !== undefined || payload.note !== undefined) await post(payload);
      const cur = await dbGet('days', day.key);
      if (cur && cur.updatedAt === stamp) { cur.synced = true; cur.attDirty = false; cur.noteDirty = false; await dbPut('days', cur); await dbDel('queue', q.id); }
      refreshBanner();
    }
    // 2) fotoğraflar, tek tek
    for (const p of await dbIndexAll('photos', 'status', 'pending')) {
      if (!p.blob) { p.status = 'sent'; await dbPut('photos', p); continue; }
      const base64 = await blobToBase64(p.blob);
      const r = await post({ action: 'uploadPhoto', site: p.site, date: p.date, name: p.name, base64 });
      const cur = await dbGet('photos', p.id);
      if (!cur) continue; // yüklenirken listeden kaldırıldı; Drive'daki dosyaya dokunulmaz
      if (!cur.thumbData && cur.blob) { // eski kayıt: büyük dosyadan küçük resmi yazı olarak üret
        try { const bm = await createImageBitmap(cur.blob); cur.thumbData = 'data:image/jpeg;base64,' + await blobToBase64(await toJpeg(bm, 240, 0.7)); } catch { /* yoksay */ }
      }
      cur.status = 'sent'; cur.fileId = r.fileId || ''; cur.blob = null; cur.thumb = null; // küçük resim yazı olarak kalır (iOS'ta Blob bozulabiliyor)
      await dbPut('photos', cur);
      refreshBanner();
      if (state.site === p.site && state.date === p.date) renderPhotos();
    }
    // kuyruktaki Drive silmeleri için sonuç iletisi (öteki işler yine de gönderildi)
    if (noDeleteSupport || needUpdate) setError(UPDATE_MSG);
    else if (deleteErr) setError(deleteErr);
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
window.addEventListener('online', () => { sync(); pullDay(); if (state.site) pullRoster(state.site); });
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 60000);

// ---------- Sunucudan çekme (Drive > telefon) ----------
const canPull = () => navigator.onLine && !!(getSettings().url && getSettings().key);
const isUnknownAction = (err) => err && err.server && /unknown action|Bilinmeyen işlem/i.test(err.message);
async function loadRoster(site) {
  if (site === state.site) return state;
  const rec = await dbGet('names', site);
  if (rec && Array.isArray(rec.teams)) return { teams: rec.teams, members: rec.members || [], pulled: !!rec.pulled };
  const r = { teams: [], members: [], pulled: false };
  const list = (rec && Array.isArray(rec.list)) ? rec.list : [];
  if (list.length) { const id = newId(); r.teams.push({ id, name: EKIPSIZ, hidden: false }); r.members = list.map((name) => ({ name, teamId: id })); }
  return r;
}
const normName = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
const lcTr = (s) => s.toLocaleLowerCase('tr');
const toServerTeams = (r) => r.teams.map((t) => ({ name: t.name, hidden: !!t.hidden, members: r.members.filter((m) => m.teamId === t.id).map((m) => m.name) }));
// Sunucudaki ekipleri yerele ekler (hiçbir şey silmez). Dönüş: {changed, push}
function mergeServerRoster(r, serverTeams) {
  let changed = false;
  const findTeam = (name) => r.teams.find((t) => lcTr(t.name) === lcTr(name));
  const srv = [];
  for (const st of serverTeams || []) {
    const name = normName(st && st.name); if (!name) continue;
    let t = findTeam(name);
    if (!t) { t = { id: newId(), name, hidden: !!st.hidden }; r.teams.push(t); changed = true; }
    const names = [];
    for (const mn of (st.members || [])) {
      const n = normName(mn); if (!n) continue;
      names.push(lcTr(n));
      if (!r.members.some((m) => lcTr(m.name) === lcTr(n))) { r.members.push({ name: n, teamId: t.id }); changed = true; }
    }
    srv.push({ key: lcTr(name), hidden: !!st.hidden, names: new Set(names) });
  }
  let push = false;
  for (const t of r.teams) {
    const s = srv.find((x) => x.key === lcTr(t.name));
    if (!s || s.hidden !== !!t.hidden) { push = true; break; }
    if (r.members.some((m) => m.teamId === t.id && !s.names.has(lcTr(m.name)))) { push = true; break; }
  }
  return { changed, push };
}
async function pullRoster(site) {
  if (!site || !canPull()) return;
  let data;
  try { data = await post({ action: 'getRoster', site }); }
  catch (err) { if (isUnknownAction(err)) { needUpdate = true; setError(UPDATE_MSG); refreshBanner(); } return; }
  if (!data || !Array.isArray(data.teams)) return;
  try { localStorage.setItem('sd_server_v2', '1'); } catch { /* yoksay */ }
  needUpdate = false; if (lastError === UPDATE_MSG) { setError(''); refreshBanner(); }
  const r = await loadRoster(site);
  if (rosterDirty.has(site) || await dbGet('queue', `roster|${site}`)) { scheduleSync(); return; } // yerel değişiklik önce gider
  const { changed, push } = mergeServerRoster(r, data.teams);
  const first = !r.pulled; r.pulled = true;
  if (changed || first) await saveRosterData(site, r);
  if (site === state.site) {
    if (changed) renderChips();
    if (changed && !$('settings').hidden) renderTeamSettings();
  }
  if (push) await enqueueRoster(site);
}
async function pullDay() {
  const site = state.site, date = state.date;
  if (!site || !canPull()) return;
  let data;
  try { data = await post({ action: 'getDay', site, date }); } catch { return; }
  if (!data || state.site !== site || state.date !== date || !state.day) return;
  const day = state.day;
  let changed = false;
  if (!isAttDirty(day)) {
    const att = {};
    for (const [n, v] of Object.entries(data.attendance || {})) if (Number(v) > 0) att[n] = Number(v);
    if (JSON.stringify(att) !== JSON.stringify(day.attendance || {})) { day.attendance = att; changed = true; }
  }
  if (!isNoteDirty(day) && !noteDirty) {
    const note = data.note == null ? '' : String(data.note);
    if (note !== (day.note || '')) { day.note = note; changed = true; }
  }
  if (!changed) return;
  await dbPut('days', day);
  renderChips(); renderNote();
}

// ---------- Ayarlar ----------
function renderSurum() {
  const box = $('surumNotlari'); if (!box) return; box.textContent = '';
  SURUMLER.forEach((r, i) => {
    const d = document.createElement('details'); if (i === 0) d.open = true; d.className = 'surum';
    const sm = document.createElement('summary'); sm.textContent = `Sürüm ${r.v} · ${r.t}` + (i === 0 ? ' (şu an kullanılan)' : '');
    const ul = document.createElement('ul'); r.n.forEach((x) => { const li = document.createElement('li'); li.textContent = x; ul.appendChild(li); });
    d.append(sm, ul); box.appendChild(d);
  });
}
$('forceUpdate')?.addEventListener('click', async () => {
  if (!navigator.onLine) return toast('İnternet yok, güncelleme alınamadı.');
  toast('Güncelleniyor…');
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* yoksay */ }
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch { /* yoksay */ }
  location.reload();
});
try { const e = $('surumEtiket'); if (e) e.textContent = `Sürüm ${SURUMLER[0].v}`; } catch { /* yoksay */ }
function renderLog() {
  const box = $('logBox'); if (!box) return;
  let arr = []; try { arr = JSON.parse(localStorage.getItem('sd_log') || '[]'); } catch { /* yoksay */ }
  box.value = [`Sürüm ${SURUMLER[0].v} · ${navigator.userAgent}`, ...arr.slice().reverse()].join('\n');
}
$('logCopy')?.addEventListener('click', async () => {
  renderLog(); const box = $('logBox');
  try { await navigator.clipboard.writeText(box.value); toast('Kayıt kopyalandı.'); }
  catch { box.focus(); box.select(); toast('Seçildi; Kopyala deyin.'); }
});
$('logClear')?.addEventListener('click', () => { try { localStorage.removeItem('sd_log'); } catch { /* yoksay */ } renderLog(); toast('Kayıt temizlendi.'); });
function openSettings() {
  renderLog();
  renderSurum();
  const s = getSettings(); $('setUrl').value = s.url; $('setKey').value = s.key;
  $('testResult').textContent = ''; ui.hideTeam = null; ui.delName = null; renderTeamSettings(); renderLocInfo(); $('settings').hidden = false;
  if (state.site) pullRoster(state.site);
}
function readSettingsForm() { ls.set('sd_settings', { url: $('setUrl').value.trim(), key: $('setKey').value.trim() }); }
function autoSaveSettings() { readSettingsForm(); $('testResult').textContent = 'Kaydedildi ✓'; }
['setUrl', 'setKey'].forEach((id) => { $(id).addEventListener('input', autoSaveSettings); $(id).addEventListener('change', autoSaveSettings); });
$('btnSettings').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', () => { readSettingsForm(); $('settings').hidden = true; scheduleSync(300); });
$('saveSettings').addEventListener('click', () => { readSettingsForm(); $('testResult').textContent = 'Kaydedildi ✓'; });
$('testConn').addEventListener('click', async () => {
  readSettingsForm();
  const { url, key } = getSettings(); const out = $('testResult');
  if (!url || !key) { out.textContent = 'Önce adresi ve anahtarı girin.'; return; }
  out.textContent = 'Deneniyor…';
  try { await post({ action: 'ping' }); }
  catch (e) { out.textContent = 'Hata: ' + e.message; return; }
  try {
    await post({ action: 'getRoster', site: state.site || 'gundogdu' });
    try { localStorage.setItem('sd_server_v2', '1'); } catch { /* yoksay */ }
    out.textContent = 'Bağlantı başarılı. Apps Script: GÜNCEL ✔';
    needUpdate = false; if (lastError === UPDATE_MSG) setError(''); refreshBanner();
    if (state.site) pullRoster(state.site);
  } catch (e) {
    out.textContent = isUnknownAction(e)
      ? "Bağlantı var ama Apps Script ESKİ sürümde çalışıyor. Dağıt → Dağıtımları yönet → kalem → Sürüm: 'Yeni sürüm' → Dağıt."
      : 'Bağlantı var, ekip listesi alınamadı: ' + e.message;
  }
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
  try { navigator.storage?.persist?.(); } catch { /* yoksay */ }
  await syncMeta();
  if ('serviceWorker' in navigator) {
    // Otomatik güncelleme: uygulama her öne geldiğinde yeni sürüm var mı bakılır;
    // varsa sayfa bir kez kendiliğinden yenilenir (veriler telefonda kalır).
    const hadController = !!navigator.serviceWorker.controller;
    try {
      const cur = SURUMLER[0].v, last = localStorage.getItem('sd_surum');
      if (last && last !== cur) setTimeout(() => toast(`Güncellendi: sürüm ${cur} — ayrıntılar Ayarlar'da`, 4500), 600);
      localStorage.setItem('sd_surum', cur);
    } catch { /* yoksay */ }
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return; reloaded = true; location.reload();
    });
    logEv('Uygulama açıldı, sürüm ' + SURUMLER[0].v + (navigator.onLine ? '' : ' (internet yok)'));
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      const check = () => { try { reg.update(); } catch { /* yoksay */ } };
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
      window.addEventListener('online', check);
    }).catch(() => {});
  }
  const last = ls.get('sd_site', null);
  renderDate(); renderTabs(); refreshBanner();
  if (last && SITES[last]) await selectSite(last);
  else $('picker').hidden = false;
  const found = await detectSite();
  if (found && found !== state.site) { await selectSite(found); toast(`Konuma göre ${SITES[found]} açıldı.`); }
  sync();
}
init();

// iPhone'da iki parmakla yakınlaştırmayı kapat (düzen sabit kalsın)
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
document.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
