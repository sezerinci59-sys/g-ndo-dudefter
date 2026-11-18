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
const META_KEYS = ['sd_settings', 'sd_coords', 'sd_site', 'sd_site_hide'];
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
const state = { loading: false, otherAtt: {}, site: null, date: today(), day: null, teams: [], members: [], pulled: false, rosterLoaded: false };
const ui = { hideTeam: null, delName: null, archName: null, editName: null, filterTeam: null, q: '', closed: new Set() };
let photoUrls = [];

// ---------- Animasyon yardımcıları (yalnızca transform/opacity; will-change sadece animasyon sırasında) ----------
const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// cls sınıfı animasyon süresince takılı kalır (CSS içinde will-change verir), bitince kalkar.
function playClass(el, cls, ms) {
  if (!el || reduceMotion.matches) return;
  clearTimeout(el._pc);
  if (el.classList.contains(cls)) { el.classList.remove(cls); void el.offsetWidth; } // yalnızca animasyonu yeniden başlatırken
  el.classList.add(cls);
  el._pc = setTimeout(() => el.classList.remove(cls), ms + 60);
}
// Mantıksal durum (hidden) hemen değişir; giriş animasyonu görsel kalır. Çıkışta öğe animasyon bitince gizlenir.
function showAnim(el, cls, ms) {
  clearTimeout(el._lv); el.classList.remove('leaving'); el.hidden = false; playClass(el, cls, ms);
}
function hideAnim(el, ms) {
  if (el.hidden) return;
  clearTimeout(el._lv);
  if (reduceMotion.matches) { el.hidden = true; return; }
  el.classList.add('leaving');
  el._lv = setTimeout(() => { el.hidden = true; el.classList.remove('leaving'); }, ms + 20);
}
function toast(msg, ms = 2800) {
  const t = $('toast'); t.textContent = msg;
  if (t.hidden || t.classList.contains('leaving')) showAnim(t, 'in', 300);
  clearTimeout(toast._t); toast._t = setTimeout(() => hideAnim(t, 220), ms);
}

// ---------- Gün verisi ----------
const dayKey = (site, date) => `${site}|${date}`;
// Aynı gün kuralı: bir kişinin iki şantiyedeki toplamı en fazla 1 gün.
const LOC = { gundogdu: "Gündoğdu'da", koseilyas: "Köseilyas'ta" };
const otherSite = () => Object.keys(SITES).find((k) => k !== state.site);
const otherVal = (n) => Number(state.otherAtt[n]) || 0;
const remaining = (n) => Math.max(0, 1 - otherVal(n));
const isBlocked = (n) => remaining(n) <= 0 && !(state.day.attendance[n] > 0);
const dayWord = () => (state.date === today() ? 'bugün' : 'bu gün');
function limitedTarget(n, want) { return Math.min(want, remaining(n)); }
async function loadOther() {
  const o = otherSite();
  const rec = o ? await dbGet('days', dayKey(o, state.date)) : null;
  state.otherAtt = (rec && rec.attendance) || {};
}
async function loadDay() {
  await loadOther();
  const rec = await dbGet('days', dayKey(state.site, state.date));
  state.day = rec || { key: dayKey(state.site, state.date), site: state.site, date: state.date, attendance: {}, note: '', updatedAt: 0, synced: true };
  state.loading = !rec && canPull();
  await loadNames();
}
const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const EKIPSIZ = 'Ekipsiz';
// Tek ortak ekip listesi (iki şantiye için). Eski şantiye başına kayıtlar ilk açılışta birleştirilir.
const ROSTER_KEY = 'ortak', SYNC_SITE = 'gundogdu', ARSIV = 'Arşiv (sigorta çıkışı)';
const lcTr = (s) => s.toLocaleLowerCase('tr');
const isArsiv = (t) => lcTr(t.name) === lcTr(ARSIV);
const isIthal = (n) => /(^|[^\p{L}])ithal($|[^\p{L}])/u.test(lcTr(n).replace(/ı/g, 'i'));
// Aynı ekipte "İthal" olanlar sona; diğerlerinin göreli sırası korunur.
const orderMembers = (arr) => [...arr.filter((m) => !isIthal(m.name)), ...arr.filter((m) => isIthal(m.name))];
const teamMembers = (id) => orderMembers(state.members.filter((m) => m.teamId === id));
const shownTeams = () => state.teams.filter((t) => !t.hidden && !isArsiv(t));
// Şantiye bazında ekip gizleme (sadece telefonda; sunucuya gitmez): { gundogdu: [ekip adı], koseilyas: [...] }
const readSiteHide = () => { const o = ls.get('sd_site_hide', {}) || {}; return o && typeof o === 'object' ? o : {}; };
const siteHideSet = (site) => new Set((Array.isArray(readSiteHide()[site]) ? readSiteHide()[site] : []).map(lcTr));
const isSiteHidden = (t, site = state.site) => siteHideSet(site).has(lcTr(t.name));
function setSiteHidden(t, site, on) {
  const o = readSiteHide(), k = lcTr(t.name);
  const arr = (Array.isArray(o[site]) ? o[site] : []).filter((n) => lcTr(n) !== k);
  if (on) arr.push(t.name);
  o[site] = arr; ls.set('sd_site_hide', o);
}
const mainTeams = () => shownTeams().filter((t) => !isSiteHidden(t));
async function readShared() {
  const rec = await dbGet('names', ROSTER_KEY);
  if (rec && Array.isArray(rec.teams)) return { teams: rec.teams, members: rec.members || [], pulled: !!rec.pulled };
  const r = { teams: [], members: [], pulled: false };
  let found = false;
  for (const site of Object.keys(SITES)) {
    const o = await dbGet('names', site); if (!o) continue;
    let teams = [], members = [];
    if (Array.isArray(o.teams)) { teams = o.teams; members = o.members || []; }
    else if (Array.isArray(o.list) && o.list.length) {
      const id = newId(); teams = [{ id, name: EKIPSIZ, hidden: false }]; members = o.list.map((name) => ({ name, teamId: id }));
    }
    for (const t of teams) {
      let x = r.teams.find((q) => lcTr(q.name) === lcTr(t.name));
      if (!x) { x = { id: newId(), name: t.name, hidden: !!t.hidden }; r.teams.push(x); }
      else x.hidden = x.hidden && !!t.hidden;
      for (const m of members.filter((q) => q.teamId === t.id)) {
        if (!r.members.some((q) => lcTr(q.name) === lcTr(m.name))) r.members.push({ name: m.name, teamId: x.id });
      }
    }
    // takımsız artık isimler de kaybolmasın
    for (const m of members) {
      if (!teams.some((t) => t.id === m.teamId) && !r.members.some((q) => lcTr(q.name) === lcTr(m.name))) {
        let e = r.teams.find((q) => q.name === EKIPSIZ);
        if (!e) { e = { id: newId(), name: EKIPSIZ, hidden: false }; r.teams.push(e); }
        r.members.push({ name: m.name, teamId: e.id });
      }
    }
    found = true;
  }
  if (found) {
    await saveRosterData(r);
    if (r.teams.length) await enqueueRoster();
  }
  return r;
}
async function loadNames() {
  const r = await readShared();
  state.teams = r.teams; state.members = r.members; state.pulled = r.pulled; state.rosterLoaded = true;
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
async function saveRosterData(r) {
  await dbPut('names', { site: ROSTER_KEY, teams: r.teams, members: r.members, list: r.members.map((m) => m.name), pulled: !!r.pulled });
}
const saveNames = () => saveRosterData(state);
// Yerel ekip/isim değişikliği: kaydet ve sunucuya gönderilmek üzere sıraya al (tek ortak kayıt; sunucuda Gündoğdu sayfası ana liste).
const rosterDirty = new Set();
let rosterRev = 0;
async function enqueueRoster() {
  rosterDirty.add(SYNC_SITE);
  await dbPut('queue', { id: `roster|${SYNC_SITE}`, type: 'saveRoster', site: SYNC_SITE, rev: Date.now() + '.' + (++rosterRev) });
  refreshBanner(); scheduleSync();
}
async function persistRoster() {
  rosterDirty.add(SYNC_SITE);
  await saveNames(); await enqueueRoster();
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
  const nav = $('siteTabs');
  nav.dataset.pos = state.site === 'koseilyas' ? '1' : '0';
  if (state.site && !nav.classList.contains('ready')) requestAnimationFrame(() => requestAnimationFrame(() => nav.classList.add('ready')));
}
const TEAM_COLORS = ['#2f7d2f', '#245edb', '#b45500', '#7a4fb5', '#c0392b', '#0f7a7a', '#8b5a2b'];
function teamColor(name) { let h = 2166136261; for (const c of String(name)) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0; return TEAM_COLORS[(h >>> 8) % TEAM_COLORS.length]; }
function setChipState(b, v) {
  b.classList.toggle('full', v === 1); b.classList.toggle('half', v === 0.5);
  let s = b.querySelector('small');
  if (v) { if (!s) { s = document.createElement('small'); b.appendChild(s); } s.textContent = v === 1 ? 'Tam' : 'Yarım'; }
  else if (s) s.remove();
}
function popChip(b, i = 0) {
  if (reduceMotion.matches) return;
  const d = i ? Math.min(i * 35, 600 - 280) : 0; // toplam en çok ~600 ms
  b.style.animationDelay = d ? d + 'ms' : '';
  playClass(b, 'pop', 280 + d);
}
// Ekip listesini kapatma: gün + şantiye + ekip başına (localStorage), 14 günden eski kayıtlar silinir. Yeni gün hep açık başlar.
const COLL_KEY = 'sd_collapsed';
const collKey = (id) => `${state.date}|${state.site}|${id}`;
function readColl() {
  const m = ls.get(COLL_KEY, {}) || {};
  const lim = shiftDate(today(), -14); let dirty = false;
  for (const k of Object.keys(m)) if (k.slice(0, 10) < lim) { delete m[k]; dirty = true; }
  if (dirty) ls.set(COLL_KEY, m);
  return m;
}
const isCollapsed = (id) => !!readColl()[collKey(id)];
function applyCollapsed(sec, on) {
  sec.classList.toggle('collapsed', on);
  const b = sec.querySelector('.tgl'), all = sec.querySelector('[data-all]'), inn = sec.querySelector('.tbody-in');
  if (b) { b.setAttribute('aria-expanded', String(!on)); b.setAttribute('aria-label', on ? 'Listeyi aç' : 'Listeyi kapat'); }
  if (all) all.disabled = on;
  if (inn) { if (on) inn.setAttribute('inert', ''); else inn.removeAttribute('inert'); }
}
function toggleTeam(sec) {
  const on = !sec.classList.contains('collapsed'), m = readColl(), k = collKey(sec.dataset.team);
  if (on) m[k] = Date.now(); else delete m[k];
  ls.set(COLL_KEY, m);
  if (on && sec.contains(document.activeElement)) document.activeElement.blur();
  applyCollapsed(sec, on);
}
// Sayı kayması: segs = [metin, sayı, metin, sayı, ...]; değişen sayı eski değeri yukarı çıkarır, yenisi alttan gelir.
// Eski değer ::before ile çizilir (data-old), böylece textContent hep tek ve doğru kalır.
function setRoll(el, segs, animate) {
  if (typeof segs === 'string') { if (el.textContent !== segs) el.textContent = segs; el._rs = null; return; }
  const nums = el.querySelectorAll('.num');
  const ok = el._rs && el._rs.length === segs.length && nums.length === (segs.length >> 1) && segs.every((x, i) => i % 2 || el._rs[i] === x);
  if (!ok) {
    el.textContent = '';
    segs.forEach((x, i) => {
      if (i % 2) { const n = document.createElement('span'); n.className = 'num'; n.textContent = String(x); el.appendChild(n); }
      else if (x) el.appendChild(document.createTextNode(x));
    });
    el._rs = segs.slice(); return;
  }
  const nn = [...nums];
  segs.forEach((x, i) => {
    if (i % 2 === 0 || String(el._rs[i]) === String(x)) return;
    const n = nn[i >> 1], old = n.textContent;
    n.textContent = String(x);
    if (animate && !reduceMotion.matches) {
      n.dataset.old = old; clearTimeout(n._rt);
      n.classList.remove('roll'); void n.offsetWidth; n.classList.add('roll');
      n._rt = setTimeout(() => { n.classList.remove('roll'); delete n.dataset.old; }, 260);
    }
  });
  el._rs = segs.slice();
}
// Sadece metinleri günceller (yeniden kurma yok)
function updateCounts() {
  const att = state.day.attendance, label = state.date === today() ? 'bugün' : 'bu gün';
  for (const sec of $('chips').querySelectorAll('section.team[data-team]')) {
    const mem = teamMembers(sec.dataset.team);
    const present = mem.filter((m) => att[m.name] > 0).length;
    const c = sec.querySelector('.team-count');
    if (c) setRoll(c, [label + ' ', present, '/', mem.length], true);
  }
  const vals = Object.values(att).filter((v) => v > 0);
  const sum = vals.reduce((a, b) => a + b, 0);
  const l2 = state.date === today() ? 'Bugün' : 'Bu gün';
  setRoll($('summary'), state.loading ? 'Yükleniyor…' : [l2 + ': ', vals.length, ' kişi (', fmtNum(sum), ' gün)'], true);
}
// Tek tek chip günceller. Düzenin değişeceği durumda (gizli/listede olmayan grup) false döner: tam yeniden çizim gerekir.
function patchChips(names, stagger = false) {
  const att = state.day.attendance, els = [];
  for (const n of names) {
    const b = $('chips').querySelector(`.chip[data-name="${CSS.escape(n)}"]`);
    if (!b) return false;
    if (b.closest('.hiddengrp,.orphangrp') && !(att[n] > 0)) return false;
    els.push([b, att[n]]);
  }
  els.forEach(([b, v], i) => { setChipState(b, v); popChip(b, stagger ? i : 0); });
  updateCounts();
  return true;
}
function chipBtn(name, v) {
  const b = document.createElement('button'); b.type = 'button';
  b.className = 'chip' + (v === 1 ? ' full' : v === 0.5 ? ' half' : '');
  b.dataset.name = name;
  b.append(document.createTextNode(name));
  if (state.day && isBlocked(name)) {
    b.classList.add('blocked'); b.setAttribute('aria-disabled', 'true');
    const c = document.createElement('em'); c.className = 'oth'; c.textContent = LOC[otherSite()]; b.appendChild(c);
  }
  if (v) { const s = document.createElement('small'); s.textContent = v === 1 ? 'Tam' : 'Yarım'; b.appendChild(s); }
  return b;
}
function renderChips() {
  const box = $('chips'); box.textContent = '';
  const att = state.day.attendance;
  const label = state.date === today() ? 'Bugün' : 'Bu gün';
  const visible = mainTeams();
  if (!visible.length) {
    const p = document.createElement('div'); p.className = 'hint';
    p.textContent = 'Henüz ekip yok. Aşağıdan "+ Yeni ekip" ile ekleyin.';
    box.appendChild(p);
  }
  for (const t of visible) {
    const mem = teamMembers(t.id);
    const present = mem.filter((m) => att[m.name] > 0).length;
    const sec = document.createElement('section'); sec.className = 'team'; sec.dataset.team = t.id; sec.style.setProperty('--tc', teamColor(t.name));
    const head = document.createElement('div'); head.className = 'team-head';
    const h = document.createElement('h3'); h.textContent = t.name;
    const cnt = document.createElement('span'); cnt.className = 'team-count';
    setRoll(cnt, [label.toLowerCase() + ' ', present, '/', mem.length], false);
    const all = document.createElement('button'); all.type = 'button'; all.className = 'btn small ghost';
    all.dataset.all = t.id; all.textContent = 'Hepsi geldi';
    const tg = document.createElement('button'); tg.type = 'button'; tg.className = 'btn small ghost tgl'; tg.dataset.tgl = t.id;
    tg.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const act = document.createElement('div'); act.className = 'team-act'; act.append(tg, all);
    head.append(h, cnt, act); sec.appendChild(head);
    const tbody = document.createElement('div'); tbody.className = 'tbody';
    const inn = document.createElement('div'); inn.className = 'tbody-in'; tbody.appendChild(inn); sec.appendChild(tbody);
    const chips = document.createElement('div'); chips.className = 'chips';
    for (const m of mem) chips.appendChild(chipBtn(m.name, att[m.name]));
    inn.appendChild(chips);
    const f = document.createElement('form'); f.className = 'addform teamadd'; f.dataset.team = t.id; f.autocomplete = 'off';
    const i = document.createElement('input'); i.type = 'text'; i.placeholder = 'Yeni isim'; i.autocapitalize = 'words';
    i.setAttribute('aria-label', t.name + ' ekibine isim ekle');
    const ab = document.createElement('button'); ab.type = 'submit'; ab.className = 'btn small plus'; ab.textContent = '+';
    ab.setAttribute('aria-label', t.name + ' ekibine ekle');
    f.append(i, ab); inn.appendChild(f);
    applyCollapsed(sec, isCollapsed(t.id));
    box.appendChild(sec);
  }
  // Gizli ekiplerde / listede olmayıp o gün kaydı olanlar görünür kalır
  const byName = new Map(state.members.map((m) => [m.name, m]));
  const hiddenIds = new Set(state.teams.filter((t) => t.hidden || isSiteHidden(t)).map((t) => t.id));
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
  setRoll($('summary'), state.loading ? 'Yükleniyor…' : [label + ': ', vals.length, ' kişi (', fmtNum(sum), ' gün)'], false);
}
function renderNote() {
  const ta = $('note');
  if (document.activeElement !== ta) ta.value = state.day.note || '';
}
let armedPhoto = null, armTimer = null, photoCtx = '', photoSeen = new Set(), photoStat = new Map();
function disarmPhoto() { clearTimeout(armTimer); armedPhoto = null; }
async function renderPhotos() {
  const list = (await dbIndexAll('photos', 'siteDate', [state.site, state.date])).filter((p) => !p.deleted);
  photoUrls.forEach((u) => URL.revokeObjectURL(u)); photoUrls = [];
  const grid = $('photoGrid'); grid.textContent = '';
  const ctx = state.site + '|' + state.date, fresh = ctx !== photoCtx;
  if (fresh) { photoCtx = ctx; photoSeen = new Set(); photoStat = new Map(); }
  for (const p of list) {
    const isNew = !fresh && !photoSeen.has(p.id) && !reduceMotion.matches; photoSeen.add(p.id);
    const flip = !reduceMotion.matches && photoStat.get(p.id) === 'pending' && p.status === 'sent'; photoStat.set(p.id, p.status === 'sent' ? 'sent' : 'pending');
    const div = document.createElement('div'); div.className = 'photo ' + (p.status === 'sent' ? 'sent' : 'pending') + (isNew ? ' pin' : '') + (flip ? ' flip' : '');
    if (flip) setTimeout(() => div.classList.remove('flip'), 400);
    if (isNew) setTimeout(() => div.classList.remove('pin'), 360);
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
  if (armedPhoto === id) {
    disarmPhoto();
    const ph = b.closest('.photo');
    if (ph && !reduceMotion.matches) { if (ph.classList.contains('pout')) return; ph.classList.add('pout'); await wait(160); }
    await deletePhoto(id); return;
  }
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
const NAV_MS = 340;
let booted = false;
async function selectSite(site) {
  await flushNote();
  state.site = site; ls.set('sd_site', site);
  await renderAll();
  $('picker').hidden = true;
  if (!booted) { booted = true; playClass(document.querySelector('main'), 'boot', 360 + 70 * 5); }
  else playClass(document.querySelector('main'), 'pg-up', 320);
  pullDay(); pullRoster();
}
// Gün geçişi: animasyon sürerken gelen istekler üst üste binmez; yalnızca en son hedef tarih sıraya alınır.
let navBusy = false, navTarget = null;
const navBase = () => (navBusy && navTarget) || state.date;
const stepDay = (delta) => setDate(shiftDate(navBase(), delta));
async function setDate(date) {
  if (!date) return;
  if (navBusy) { navTarget = date; if (date !== state.date) $('dateText').textContent = (date === today() ? 'Bugün · ' : '') + shortDate(date); return; }
  navBusy = true;
  try {
    let d = date;
    while (d) {
      navTarget = null;
      if (d !== state.date) {
        await flushNote();
        const dir = d > state.date ? 'pg-next' : 'pg-prev';
        state.date = d;
        await renderAll();
        playClass(document.querySelector('main'), dir, NAV_MS);
        releaseOut();
        pullDay();
        if (!reduceMotion.matches) await wait(NAV_MS);
      } else renderDate();
      d = navTarget && navTarget !== state.date ? navTarget : null;
    }
  } finally { navBusy = false; navTarget = null; }
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
    swipe.cancel = true;
    const att = state.day.attendance;
    if (isBlocked(n)) return toast(`${n} ${dayWord()} ${LOC[otherSite()]} tam gün çalıştı.`);
    const want = att[n] === 0.5 ? 1 : 0.5, got = limitedTarget(n, want);
    if (got === att[n]) return toast('Diğer şantiyede yarım gün var; yarım gün işaretlendi.');
    att[n] = got;
    if (got < want) toast('Diğer şantiyede yarım gün var; yarım gün işaretlendi.');
    if (!patchChips([n])) renderChips(); await persistDay(state.day, { att: true });
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
    if (!v) {
      if (isBlocked(n)) return toast(`${n} ${dayWord()} ${LOC[otherSite()]} tam gün çalıştı.`);
      att[n] = limitedTarget(n, 1);
      if (att[n] < 1) toast('Diğer şantiyede yarım gün var; yarım gün işaretlendi.');
    } else delete att[n];
    if (!patchChips([n])) renderChips(); await persistDay(state.day, { att: true });
  } else if (t.dataset.tgl) {
    toggleTeam(t.closest('section.team'));
  } else if (t.dataset.all) {
    const mem = state.members.filter((m) => m.teamId === t.dataset.all);
    const tm = state.teams.find((q) => q.id === t.dataset.all); if (tm && isSiteHidden(tm)) return;
    const todo = mem.map((m) => [m.name, limitedTarget(m.name, 1)]).filter(([n, tg]) => tg > 0 && (att[n] || 0) < tg);
    if (!todo.length) return;
    const changed = todo.map(([n]) => n);
    for (const [n, tg] of todo) att[n] = tg;
    if (!patchChips(changed, true)) renderChips(); await persistDay(state.day, { att: true });
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
function renderTeamFilter() {
  const bar = $('tfPills'); if (!bar) return;
  if (ui.filterTeam && !state.teams.some((t) => t.id === ui.filterTeam && !isArsiv(t))) ui.filterTeam = null;
  bar.textContent = '';
  const pill = (text, id) => { const b = el('button', { type: 'button', className: 'pill' + ((ui.filterTeam || '') === id ? ' on' : ''), text }); b.dataset.tf = id; return b; };
  bar.appendChild(pill('Tümü', ''));
  for (const t of state.teams) if (!isArsiv(t)) bar.appendChild(pill(t.name, t.id));
}
async function renameMember(old, raw) {
  const neu = normName(raw);
  if (!neu) return toast('İsim boş olamaz.');
  if (neu === old) { ui.editName = null; return renderTeamSettings(); }
  const m = state.members.find((q) => q.name === old); if (!m) return;
  if (state.members.some((q) => q !== m && lcTr(q.name) === lcTr(neu))) return toast('Bu isim zaten var.');
  m.name = neu; ui.editName = null;
  const moveKey = (att) => {
    if (!att || !(old in att)) return false;
    att[neu] = neu in att ? Math.max(att[neu], att[old]) : att[old]; delete att[old]; return true;
  };
  for (const rec of await dbAll('days')) {
    if (state.day && rec.key === state.day.key) continue;
    if (moveKey(rec.attendance)) await persistDay(rec, { att: true });
  }
  if (state.day && moveKey(state.day.attendance)) await persistDay(state.day, { att: true });
  const info = ls.get('sd_arsiv', {}) || {};
  if (info[old]) { info[neu] = info[old]; delete info[old]; ls.set('sd_arsiv', info); }
  await persistRoster();
  renderTeamSettings(); renderChips(); toast('İsim değişti.');
}
function renderTeamSettings() {
  const box = $('teamSettings'); box.textContent = '';
  if (!state.site) return;
  const btn = (text, data, cls = 'btn small ghost') => el('button', { type: 'button', className: cls, text, ...data });
  const matchQ = (m) => !ui.q || lcTr(m.name).includes(lcTr(ui.q));
  const teamBlock = (t) => {
    const w = el('div', { className: 'tset', 'data-tset': t.id });
    const nm = el('input', { type: 'text', value: t.name, 'aria-label': 'Ekip adı' }); nm.dataset.tname = t.id; nm.setAttribute('value', t.name);
    w.appendChild(el('div', { className: 'tset-row' }, nm, btn('Adı kaydet', { 'data-trename': t.id })));
    const mem = teamMembers(t.id).filter(matchQ);
    const det = el('details', { className: 'tmembers' }, el('summary', { text: `Kişiler (${mem.length})` }));
    for (const m of mem) {
      const sel = el('select', { 'aria-label': m.name + ' ekibi' }); sel.dataset.move = m.name;
      for (const o of state.teams.filter((q) => !isArsiv(q))) sel.appendChild(el('option', { value: o.id, text: o.name + (o.hidden ? ' (gizli)' : ''), selected: o.id === m.teamId }));
      let line;
      if (ui.editName === m.name) {
        const inp = el('input', { type: 'text', value: m.name, className: 'rinput', 'aria-label': 'Yeni isim' }); inp.dataset.rinput = m.name; inp.setAttribute('value', m.name);
        line = el('div', { className: 'mline' }, inp, btn('✔', { 'data-rensave': m.name, 'aria-label': 'Kaydet' }, 'btn small ic'), btn('✕', { 'data-renno': '1', 'aria-label': 'Vazgeç' }, 'btn small ic'));
      } else {
        line = el('div', { className: 'mline' }, btn('✏️', { 'data-ren': m.name, 'aria-label': m.name + ' adını düzenle' }, 'btn small ic'), el('span', { className: 'mname', text: m.name }));
      }
      const act = el('div', { className: 'mact' }, sel);
      if (ui.archName === m.name) act.append(btn('Evet, çıkış yap', { 'data-archyes': m.name }, 'btn small danger'), btn('Vazgeç', { 'data-archno': '1' }));
      else if (ui.delName === m.name) act.append(btn('Evet, sil', { 'data-delyes': m.name }, 'btn small danger'), btn('Vazgeç', { 'data-delno': '1' }));
      else act.append(btn('Sigorta çıkışı', { 'data-arch': m.name }, 'btn small'), btn('Sil', { 'data-del': m.name }, 'btn small linkdel'));
      det.appendChild(el('div', { className: 'mrow' }, line, act));
    }
    det.open = !ui.closed.has(t.id) || !!ui.q; det.dataset.tid = t.id;
    w.appendChild(det);
    if (t.hidden) w.appendChild(btn('Geri getir', { 'data-unhide': t.id }, 'btn small'));
    else if (ui.hideTeam === t.id) w.appendChild(el('div', { className: 'tset-row' }, btn('Evet, gizle', { 'data-hideyes': t.id }, 'btn small danger'), btn('Vazgeç', { 'data-hideno': '1' })));
    else w.appendChild(btn('Ekibi gizle (işi bitti)', { 'data-hide': t.id }));
    if (!t.hidden) {
      const sn = SITES[state.site];
      if (isSiteHidden(t)) w.appendChild(el('div', { className: 'tset-row' }, el('span', { className: 'hint', text: `${sn}'da gizli` }), btn(`${sn}'da göster`, { 'data-sshow': t.id }, 'btn small')));
      else if (ui.siteHideTeam === t.id) w.appendChild(el('div', { className: 'tset-row' }, btn(`Evet, ${sn}'da gizle`, { 'data-sshideyes': t.id }, 'btn small danger'), btn('Vazgeç', { 'data-sshideno': '1' })));
      else w.appendChild(btn(`Bu şantiyede gösterme (${sn})`, { 'data-sshide': t.id }));
    }
    return w;
  };
  renderTeamFilter();
  const keep = (t) => (!ui.filterTeam || ui.filterTeam === t.id) && (!ui.q || state.members.some((m) => m.teamId === t.id && matchQ(m)));
  const vis = shownTeams().filter(keep), hid = state.teams.filter((t) => t.hidden && !isArsiv(t)).filter(keep);
  if (!vis.length && !hid.length) box.appendChild(el('p', { className: 'hint', text: ui.q || ui.filterTeam ? 'Eşleşen kişi yok.' : 'Görünen ekip yok.' }));
  vis.forEach((t) => box.appendChild(teamBlock(t)));
  if (hid.length) {
    box.appendChild(el('h3', { text: 'Gizli ekipler' }));
    hid.forEach((t) => box.appendChild(teamBlock(t)));
  }
  const at = state.teams.find(isArsiv);
  const arch = at && !ui.filterTeam ? state.members.filter((m) => m.teamId === at.id && matchQ(m)) : [];
  if (arch.length) {
    const info = ls.get('sd_arsiv', {}) || {};
    box.appendChild(el('h3', { text: 'Arşiv (sigorta çıkışı yapılanlar)' }));
    const wrap = el('div', { className: 'tset arsiv' });
    for (const m of arch) {
      const d = info[m.name] && info[m.name].date;
      wrap.appendChild(el('div', { className: 'mrow' }, el('span', { className: 'mname', text: m.name }),
        el('span', { className: 'hint', text: d ? 'Çıkış: ' + trDate(d) : '' }), btn('Geri al', { 'data-restore': m.name })));
    }
    box.appendChild(wrap);
  }
}
$('teamSettings').addEventListener('click', async (e) => {
  const t = e.target.closest('button'); if (!t) return;
  const d = t.dataset; let changed = false;
  if (d.sshide) { ui.siteHideTeam = d.sshide; }
  else if (d.sshideno) { ui.siteHideTeam = null; }
  else if (d.sshideyes) { const x = state.teams.find((q) => q.id === d.sshideyes); if (x) setSiteHidden(x, state.site, true); ui.siteHideTeam = null; renderTeamSettings(); renderChips(); return; }
  else if (d.sshow) { const x = state.teams.find((q) => q.id === d.sshow); if (x) setSiteHidden(x, state.site, false); renderTeamSettings(); renderChips(); return; }
  else if (d.hide) { ui.hideTeam = d.hide; }
  else if (d.hideno) { ui.hideTeam = null; }
  else if (d.hideyes) { const x = state.teams.find((q) => q.id === d.hideyes); if (x) x.hidden = true; ui.hideTeam = null; changed = true; }
  else if (d.unhide) { const x = state.teams.find((q) => q.id === d.unhide); if (x) x.hidden = false; changed = true; }
  else if (d.trename) {
    const v = $('teamSettings').querySelector(`input[data-tname="${d.trename}"]`).value.trim().replace(/\s+/g, ' ');
    const x = state.teams.find((q) => q.id === d.trename);
    if (!v || !x || v === x.name) return;
    if (state.teams.some((q) => q !== x && q.name.toLocaleLowerCase('tr') === v.toLocaleLowerCase('tr'))) return toast('Bu ekip zaten var.');
    const wasHid = Object.keys(SITES).filter((k) => isSiteHidden(x, k));
    x.name = v; changed = true; toast('Ekip adı değişti.');
    for (const k of wasHid) setSiteHidden({ name: v }, k, true);
  }
  else if (d.arch) { ui.archName = d.arch; ui.delName = null; }
  else if (d.archno) { ui.archName = null; }
  else if (d.tf !== undefined) { ui.filterTeam = d.tf || null; }
  else if (d.ren) { ui.editName = d.ren; ui.archName = null; ui.delName = null; }
  else if (d.renno) { ui.editName = null; }
  else if (d.rensave) { const i = $('teamSettings').querySelector('input[data-rinput]'); return renameMember(d.rensave, i ? i.value : ''); }
  else if (d.archyes) {
    const m = state.members.find((q) => q.name === d.archyes);
    if (m) {
      const from = state.teams.find((q) => q.id === m.teamId);
      let at = state.teams.find(isArsiv);
      if (!at) { at = { id: newId(), name: ARSIV, hidden: true }; state.teams.push(at); } else at.hidden = true;
      if (from && !isArsiv(from)) {
        const info = ls.get('sd_arsiv', {}) || {};
        info[m.name] = { date: state.date, team: from.name }; ls.set('sd_arsiv', info);
      }
      m.teamId = at.id; changed = true; toast('Sigorta çıkışı yapıldı; Arşiv bölümüne taşındı.');
    }
    ui.archName = null;
  }
  else if (d.restore) {
    const m = state.members.find((q) => q.name === d.restore);
    if (m) {
      const info = ls.get('sd_arsiv', {}) || {};
      const want = info[m.name] && info[m.name].team;
      let t = want && state.teams.find((q) => !isArsiv(q) && lcTr(q.name) === lcTr(want));
      if (!t) t = shownTeams()[0];
      if (!t) { t = { id: newId(), name: 'Kalıpçı', hidden: false }; state.teams.push(t); }
      m.teamId = t.id; delete info[m.name]; ls.set('sd_arsiv', info); changed = true; toast('Geri alındı.');
    }
  }
  else if (d.del) { ui.delName = d.del; ui.archName = null; }
  else if (d.delno) { ui.delName = null; }
  else if (d.delyes) { state.members = state.members.filter((m) => m.name !== d.delyes); ui.delName = null; changed = true; }
  else return;
  renderTeamSettings();
  if (changed) { await persistRoster(); renderChips(); }
});
$('tfPills').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tf]'); if (!b) return;
  ui.filterTeam = b.dataset.tf || null; renderTeamSettings();
});
$('tfSearch').addEventListener('input', (e) => { ui.q = e.target.value.trim(); renderTeamSettings(); });
$('teamSettings').addEventListener('keydown', (e) => {
  const i = e.target.closest && e.target.closest('input[data-rinput]'); if (!i) return;
  if (e.key === 'Enter') { e.preventDefault(); renameMember(i.dataset.rinput, i.value); }
  else if (e.key === 'Escape') { ui.editName = null; renderTeamSettings(); }
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
// ---------- Excel indir ----------
const EXCELJS_URL = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
async function loadExcelJS() {
  if (window.ExcelJS) return window.ExcelJS;
  let text = null;
  try {
    const res = await fetch(EXCELJS_URL);
    if (!res.ok) throw new Error('http ' + res.status);
    const copy = res.clone(); text = await res.text();
    try { const c = await caches.open('santiye-cdn'); await c.put(EXCELJS_URL, copy); } catch { /* yoksay */ }
  } catch {
    try { const hit = await (await caches.open('santiye-cdn')).match(EXCELJS_URL); if (hit) text = await hit.text(); } catch { /* yoksay */ }
  }
  if (!text) throw new Error('Excel kitaplığı yüklenemedi (internet?).');
  const u = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  try {
    await new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = u; sc.onload = ok; sc.onerror = () => no(new Error('Excel kitaplığı çalışmadı.')); document.head.appendChild(sc); });
  } finally { URL.revokeObjectURL(u); }
  return window.ExcelJS;
}
const XL_PAIRS = [['EBF1DE', 'D8E4BC'], ['E4DFEC', 'CCC0DA'], ['FFF2CC', 'FFE699']];
function xlColors(teamName, seen) {
  const k = lcTr(teamName);
  if (k.includes('demirci')) return ['DCE6F1', 'B8CCE4'];
  if (k.includes('kalıpçı') || k.includes('kalipci')) return ['FDE9D9', 'FCD5B4'];
  if (k.includes('mühendis') || k.includes('muhendis') || teamName === '—') return ['FFFFFF', 'FFFFFF'];
  if (!seen.has(k)) seen.set(k, XL_PAIRS[seen.size % XL_PAIRS.length]);
  return seen.get(k);
}
// Ay için satırlar: [{team, name, att:{gün:değer}, exit}] ekip sırasıyla
function buildXlRows(att, info, ym, site) {
  const groups = new Map(); // lc ekip adı -> {name, people}
  const grp = (name) => { const k = lcTr(name); if (!groups.has(k)) groups.set(k, { name, people: [] }); return groups.get(k); };
  const hasAtt = (n) => Object.keys(att[n] || {}).length > 0;
  const at = state.teams.find(isArsiv);
  const seen = new Set();
  for (const t of state.teams) if (!isArsiv(t)) grp(t.name);
  const add = (m, team, exit) => { seen.add(m.name); grp(team).people.push({ name: m.name, att: att[m.name] || {}, exit }); };
  for (const t of state.teams) {
    if (isArsiv(t)) continue;
    const sh = site && isSiteHidden(t, site);
    for (const m of teamMembers(t.id)) { if (sh && !hasAtt(m.name)) continue; add(m, t.name, ''); }
  }
  if (at) for (const m of orderMembers(state.members.filter((q) => q.teamId === at.id))) {
    const i = info[m.name] || {};
    const inMonth = i.date ? i.date >= ym + '-01' : false;
    if (inMonth || hasAtt(m.name)) add(m, i.team || 'ARŞİV', i.date ? trDate(i.date) : '');
  }
  for (const n of Object.keys(att)) if (!seen.has(n) && hasAtt(n)) { seen.add(n); grp('—').people.push({ name: n, att: att[n], exit: '' }); }
  return [...groups.values()].filter((g) => g.people.length);
}
async function makeXlsx(ym, site, att, info) {
  const EJ = await loadExcelJS();
  const [Y, M] = ym.split('-').map(Number);
  const N = new Date(Y, M, 0).getDate();
  const mon = MONTHS_TR[M - 1].toLocaleUpperCase('tr');
  const siteUp = (SITES[site] || site).toLocaleUpperCase('tr');
  const wb = new EJ.Workbook();
  const ws = wb.addWorksheet(`${mon} ${Y}`, { views: [{ state: 'frozen', xSplit: 7, ySplit: 5 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const widths = [5, 26, 13, 11, 4, 11, 11]; for (let i = 0; i < 31; i++) widths.push(3.2); widths.push(8, 10);
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const font = { name: 'Calibri', size: 10 };
  const center = { horizontal: 'center', vertical: 'middle' };
  const thin = { style: 'thin', color: { argb: 'FF000000' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const LAST = 40;
  for (let r = 1; r <= 4; r++) for (let c = 1; c <= LAST; c++) ws.getCell(r, c).font = font;
  ws.mergeCells('A1:AN1'); ws.getCell('A1').value = `İMATEK PERSONELİNE AİT PUANTAJ CETVELİ (${siteUp})`;
  ws.getCell('A1').font = { ...font, bold: true }; ws.getCell('A1').alignment = center;
  ws.mergeCells('A2:AN2'); ws.getCell('A2').value = 'İŞYERİ SİCİL NO:'; ws.getCell('A2').alignment = center;
  ws.mergeCells('A3:AN3');
  ws.getCell('A3').value = { richText: [{ font, text: 'AİT OLDUĞU ÇALIŞMA DÖNEMİ: ' }, { font: { ...font, bold: true }, text: `${mon} -${Y}` }] };
  ws.getCell('A3').alignment = center;
  ws.mergeCells('H4:AL4'); ws.getCell('H4').value = 'ÇALIŞTIĞI GÜNLER'; ws.getCell('H4').font = { ...font, bold: true }; ws.getCell('H4').alignment = center;
  const head = ['SIRA NO', 'PERSONELİN ADI SOYADI', 'T.C NO', 'GÖREVİ', '', 'GİRİŞ TARİHİ', 'ÇIKIŞ TARİHİ'];
  for (let d = 1; d <= 31; d++) head.push(d);
  head.push('ÇALIŞTIĞI SAAT GÜN', 'İMZA');
  head.forEach((v, i) => {
    const c = ws.getCell(5, i + 1); c.value = v === '' ? null : v; c.font = { ...font, bold: true };
    c.alignment = { ...center, wrapText: true }; c.border = border;
  });
  const fill = (hex) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + hex } });
  const colors = new Map();
  let r = 6, no = 0;
  for (const g of buildXlRows(att, info, ym, site)) {
    const pair = xlColors(g.name, colors);
    g.people.forEach((p, idx) => {
      no++;
      const row = ws.getRow(r);
      const base = fill(pair[idx % 2]);
      for (let c = 1; c <= LAST; c++) { const cell = row.getCell(c); cell.font = font; cell.fill = base; cell.border = border; cell.alignment = center; }
      row.getCell(1).value = no;
      row.getCell(2).value = p.name.toLocaleUpperCase('tr'); row.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(4).value = g.name.toLocaleUpperCase('tr');
      if (p.exit) row.getCell(7).value = p.exit;
      let sum = 0;
      for (let d = 1; d <= 31; d++) {
        const cell = row.getCell(7 + d);
        if (d > N) { cell.fill = fill('D9D9D9'); continue; }
        const v = Number(p.att[d]);
        if (v > 0) { cell.value = v; sum += v; }
      }
      row.getCell(39).value = { formula: `SUM(H${r}:AL${r})`, result: sum };
      row.getCell(39).font = { ...font, bold: true };
      r++;
    });
  }
  return wb.xlsx.writeBuffer();
}
async function downloadXlsx(buf, name) {
  const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const blob = new Blob([buf], { type });
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && navigator.canShare) {
    try {
      const f = new File([blob], name, { type });
      if (navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: name }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
let xlBusy = false;
$('xlMonth').value = today().slice(0, 7);
async function exportExcel() {
  if (xlBusy) return;
  const ym = $('xlMonth').value, site = $('xlSite').value;
  if (!/^\d{4}-\d{2}$/.test(ym)) return toast('Önce ayı seçin.');
  if (!navigator.onLine || !canPull()) return toast(navigator.onLine ? 'Önce Apps Script adresi ve anahtarı girin.' : 'İnternet yok; Excel için bağlantı gerekir.');
  xlBusy = true; const btn = $('xlGo'), prog = $('xlProg'); btn.disabled = true;
  try {
    await loadRoster();
    const [Y, M] = ym.split('-').map(Number), N = new Date(Y, M, 0).getDate();
    const att = {}; let done = 0, next = 1, fail = null;
    prog.textContent = `0/${N} gün…`;
    const worker = async () => {
      while (!fail && next <= N) {
        const d = next++, date = `${ym}-${pad(d)}`;
        let a;
        try {
          const loc = await dbGet('days', dayKey(site, date));
          if (loc && isAttDirty(loc)) a = loc.attendance || {};
          else { const data = await post({ action: 'getDay', site, date }); a = {}; for (const [n, v] of Object.entries((data && data.attendance) || {})) if (Number(v) > 0) a[n] = Number(v); }
        } catch (err) { fail = err; return; }
        for (const [n, v] of Object.entries(a)) if (v > 0) (att[n] || (att[n] = {}))[d] = Number(v);
        prog.textContent = `${++done}/${N} gün…`;
      }
    };
    await Promise.all([1, 2, 3, 4].map(worker));
    if (fail) throw fail;
    prog.textContent = 'Dosya hazırlanıyor…';
    const buf = await makeXlsx(ym, site, att, ls.get('sd_arsiv', {}) || {});
    const name = `Puantaj_${(SITES[site] || site).toLocaleUpperCase('tr')}_${MONTHS_TR[M - 1].toLocaleUpperCase('tr')}-${Y}.xlsx`;
    await downloadXlsx(buf, name);
    prog.textContent = 'Hazır: ' + name;
  } catch (err) {
    prog.textContent = ''; toast('Excel hazırlanamadı: ' + (err && err.message ? err.message : err), 4500);
  } finally { xlBusy = false; btn.disabled = false; }
}
$('xlGo').addEventListener('click', exportExcel);
$('copyYesterday').addEventListener('click', async () => {
  let prev = null;
  for (let d = 1; d <= 7 && !prev; d++) {
    const r = await dbGet('days', dayKey(state.site, shiftDate(state.date, -d)));
    if (r && Object.values(r.attendance || {}).some((v) => v > 0)) prev = r;
  }
  if (!prev) return toast('Son 7 günde kayıt yok.');
  const att = state.day.attendance;
  let added = false, count = 0;
  for (const [n, v] of Object.entries(prev.attendance)) {
    if (!(v > 0) || att[n] > 0) continue; // bugün işaretli olanlar değişmez
    const pm = state.members.find((m) => m.name === n), pt = pm && state.teams.find((q) => q.id === pm.teamId);
    if (pt && isSiteHidden(pt)) continue; // bu şantiyede gizli ekip
    const t = limitedTarget(n, v); if (t <= 0) continue;
    att[n] = t; count++;
    if (!hasName(n)) { state.members.push({ name: n, teamId: ensureEkipsiz().id }); added = true; }
  }
  if (added) await persistRoster();
  renderChips();
  if (count) await persistDay(state.day, { att: true });
  toast(`${count} kişi işaretlendi.`);
});

// ---------- Kaydırarak gün değiştirme ----------
const swipe = { x: 0, y: 0, on: false, cancel: false, mode: '', lx: 0, lt: 0, vx: 0, dx: 0, cards: [] };
const swipeCards = () => [...document.querySelectorAll('main .card')];
const rubber = (dx) => { const a = Math.abs(dx), m = a <= 80 ? a : 80 + (a - 80) * 0.5; return dx < 0 ? -m : m; };
let outAnims = [];
// Kaydırma çıkış animasyonu, yeni günün giriş animasyonu başlayınca (aynı karede) bırakılır: arada eski içerik görünmez.
function releaseOut() { for (const a of outAnims) { try { a.effect.target.style.transform = ''; a.effect.target.style.opacity = ''; a.cancel(); } catch { /* yoksay */ } } outAnims = []; }
function swipeSpring() {
  const x = swipe.dx;
  for (const c of swipe.cards) {
    c.style.transform = ''; c.style.willChange = '';
    if (x && !reduceMotion.matches) c.animate([{ transform: `translateX(${x}px)` }, { transform: 'translateX(0)' }], { duration: 260, easing: 'cubic-bezier(.34,1.56,.64,1)' });
  }
  swipe.dx = 0; swipe.cards = [];
}
function swipeCommit(dir) {
  const x = swipe.dx, cards = swipe.cards;
  swipe.dx = 0; swipe.cards = [];
  if (navBusy || reduceMotion.matches || !cards.length) {
    cards.forEach((c) => { c.style.transform = ''; c.style.willChange = ''; });
    stepDay(dir); return;
  }
  const to = -dir * innerWidth * 0.5;
  outAnims = cards.map((c) => c.animate([{ transform: `translateX(${x}px)`, opacity: 1 }, { transform: `translateX(${to}px)`, opacity: 0 }], { duration: 160, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }));
  cards.forEach((c) => { c.style.transform = ''; c.style.willChange = ''; });
  Promise.all(outAnims.map((a) => a.finished.catch(() => {}))).then(() => stepDay(dir));
}
{
  const sc = $('scroller');
  sc.addEventListener('touchstart', (e) => {
    swipe.on = e.touches.length === 1 && !e.target.closest('input,textarea,select,[contenteditable],label.datelabel') && !!state.site;
    swipe.cancel = false; swipe.mode = ''; swipe.dx = 0;
    swipe.x = swipe.lx = e.touches[0].clientX; swipe.y = e.touches[0].clientY; swipe.lt = performance.now(); swipe.vx = 0;
  }, { passive: true });
  sc.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1) { swipe.on = false; if (swipe.mode === 'h') swipeSpring(); swipe.mode = 'v'; return; }
    if (!swipe.on) return;
    const t = e.touches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
    if (!swipe.mode) {
      if (Math.hypot(dx, dy) < 8) return;
      swipe.mode = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'; // eksen 8 px sonra belirlenir
      if (swipe.mode === 'h') { if (press.timer) pressEnd(); swipe.cards = swipeCards(); swipe.cards.forEach((c) => { c.style.willChange = 'transform'; }); }
    }
    if (swipe.mode !== 'h') return;
    const now = performance.now(), dt = now - swipe.lt;
    if (dt > 0) { swipe.vx = 0.6 * swipe.vx + 0.4 * ((t.clientX - swipe.lx) / dt); swipe.lx = t.clientX; swipe.lt = now; }
    swipe.dx = rubber(dx);
    for (const c of swipe.cards) c.style.transform = `translate3d(${swipe.dx}px,0,0)`;
  }, { passive: true });
  sc.addEventListener('touchend', (e) => {
    const wasH = swipe.mode === 'h'; swipe.on = false;
    if (!wasH) return;
    swipe.mode = '';
    const t = e.changedTouches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
    const fling = Math.abs(swipe.vx) > 0.4 && Math.abs(dx) > 20 && (performance.now() - swipe.lt) < 120;
    if (swipe.cancel || press.timer || Math.abs(dx) <= 1.5 * Math.abs(dy) || (Math.abs(dx) < 60 && !fling)) return swipeSpring();
    swipeCommit(dx < 0 ? 1 : -1);
  }, { passive: true });
  sc.addEventListener('touchcancel', () => { swipe.on = false; if (swipe.mode === 'h') swipeSpring(); swipe.mode = ''; }, { passive: true });
}

// ---------- Basma dalgası (Win7 tarzı): dokunulan noktadan büyüyen daire; yalnızca transform/opacity ----------
document.addEventListener('pointerdown', (e) => {
  if (reduceMotion.matches || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const el = e.target.closest && e.target.closest('.btn,.icon-btn,.chip,.tabs button,.pill,.big');
  if (!el || el.disabled || el.classList.contains('blocked')) return;
  const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const rad = Math.hypot(Math.max(x, r.width - x), Math.max(y, r.height - y));
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  el.classList.add('rip-host');
  const d = document.createElement('span'); d.className = 'ripple'; d.setAttribute('aria-hidden', 'true');
  d.style.cssText = `left:${x - rad}px;top:${y - rad}px;width:${rad * 2}px;height:${rad * 2}px`;
  el.appendChild(d);
  setTimeout(() => d.remove(), 440);
}, { passive: true });

// ---------- Not (otomatik kayıt) ----------
let noteTimer, noteDirty = false;
$('note').addEventListener('input', () => {
  noteDirty = true; $('noteState').textContent = 'Yazılıyor…';
  clearTimeout(noteTimer); noteTimer = setTimeout(flushNote, 700);
});
$('note').addEventListener('blur', flushNote);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNote(); else { scheduleSync(300); pullDay(); } });
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
const isUltraLabel = (l) => /ultra|geniş açı|ultra geniş|0[.,]5/i.test(l || '') && !/front|ön|selfie|user/i.test(l || '');
async function torchWorks(track) {
  try {
    if (!track.getCapabilities || !track.getCapabilities().torch) return false;
    await track.applyConstraints({ advanced: [{ torch: true }] });
    const ok = !!(track.getSettings && track.getSettings().torch);
    await track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
    return ok;
  } catch { return false; }
}
async function preferUltraWide(stream, needTorch) {
  try {
    const tr = stream.getVideoTracks()[0];
    if (!tr) return stream;
    if (isUltraLabel(tr.label)) { logEv('Kamera: 0.5x (' + tr.label + ')'); return stream; }
    // 1) Sanal çoklu kamerada zoom < 1 destekleniyorsa onu kullan
    const caps = tr.getCapabilities ? tr.getCapabilities() : {};
    if (caps.zoom && caps.zoom.min < 1) {
      await tr.applyConstraints({ advanced: [{ zoom: Math.max(caps.zoom.min, 0.5) }] });
      logEv('Kamera: zoom ' + Math.max(caps.zoom.min, 0.5)); return stream;
    }
    // 2) Ayrı ultra geniş kamera
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const uw = devs.find((d) => isUltraLabel(d.label));
    if (!uw) { logEv('Kamera: 0.5x bulunamadı (' + devs.map((d) => d.label).join(' | ') + ')'); return stream; }
    const s2 = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: uw.deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
    const t2 = s2.getVideoTracks()[0];
    if (needTorch && !(await torchWorks(t2)) && (await torchWorks(tr))) {
      s2.getTracks().forEach((t) => t.stop());
      logEv('Kamera: 0.5x flaşsız; malzeme için 1x + flaş'); toast('0.5x kamerada flaş yok; malzeme girişi 1x çekiliyor.', 3500);
      return stream;
    }
    stream.getTracks().forEach((t) => t.stop());
    logEv('Kamera: 0.5x (' + uw.label + ')');
    return s2;
  } catch (e) { logEv('Kamera: 0.5x seçilemedi: ' + (e && e.message)); return stream; }
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
  // 0.5x (ultra geniş açı) tercih edilir. iPhone'da ayrı bir kamera olarak görünür; izin alındıktan sonra adı okunabilir.
  stream = await preferUltraWide(stream, !!kind);
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
  const v = $('camVideo'); v.srcObject = stream; showAnim($('cam'), 'in', 160);
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
  const wasPending = bar.classList.contains('pending');
  bar.classList.toggle('pending', n > 0); bar.classList.toggle('err', showErr); bar.classList.toggle('syncing', syncing && n > 0);
  $('syncText').innerHTML = n > 0 ? `<b id="pendingCount">${n}</b> öğe gönderilmeyi bekliyor` : `<b id="pendingCount">0</b> öğe bekliyor · hepsi gönderildi`;
  if (n > 0 || showErr) { clearTimeout(bar._dn); bar.classList.remove('done'); if (bar.hidden || bar.classList.contains('leaving')) showAnim(bar, 'in', 200); }
  else if (wasPending && !bar.hidden && !reduceMotion.matches) { // hepsi gitti: ✔ belirir, kutu ~900 ms sonra kapanır
    bar.classList.add('done'); clearTimeout(bar._dn);
    bar._dn = setTimeout(() => { bar.classList.remove('done', 'in', 'leaving', 'syncing'); bar.hidden = true; }, 900);
  } else if (bar.classList.contains('done')) { /* zamanlayıcı kapatır */ }
  else { clearTimeout(bar._lv); bar.classList.remove('leaving', 'in'); bar.hidden = true; } // gizleme anında (test/mantık); giriş animasyonlu
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
          if (q.site !== SYNC_SITE) { await dbDel('queue', q.id); continue; } // eski şantiye başına kayıt: ortak listeye taşındı
          const r = await loadRoster();
          if (!r.teams.length) { await dbDel('queue', q.id); rosterDirty.delete(q.site); continue; } // hiç ekip yok: sunucuyu boşaltma
          if (!r.pulled) { // sunucudakini hiç görmeden üzerine yazma: önce çek ve birleştir
            const d = await post({ action: 'getRoster', site: SYNC_SITE });
            mergeServerRoster(r, d.teams || []); r.pulled = true;
            await saveRosterData(r);
            if (r === state) { renderChips(); if (!$('settings').hidden) renderTeamSettings(); }
          }
          await post({ action: 'saveRoster', site: SYNC_SITE, teams: toServerTeams(r) });
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
      if (cur && cur.updatedAt === stamp) { cur.synced = true; cur.attDirty = false; cur.noteDirty = false;
        if (state.day && state.day.key === cur.key && state.day.updatedAt === stamp) { state.day.synced = true; state.day.attDirty = false; state.day.noteDirty = false; }
        await dbPut('days', cur); await dbDel('queue', q.id); }
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
window.addEventListener('online', () => { sync(); pullDay(true); pullRoster(); });
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 60000);

// ---------- Sunucudan çekme (Drive > telefon) ----------
const canPull = () => navigator.onLine && !!(getSettings().url && getSettings().key);
const isUnknownAction = (err) => err && err.server && /unknown action|Bilinmeyen işlem/i.test(err.message);
const loadRoster = async () => state.rosterLoaded ? state : readShared();
const normName = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
const toServerTeams = (r) => r.teams.map((t) => ({ name: t.name, hidden: !!t.hidden, members: r.members.filter((m) => m.teamId === t.id).map((m) => m.name) }));
// Sunucudaki ekipleri yerele ekler (hiçbir şey silmez). Dönüş: {changed, push}
function mergeServerRoster(r, serverTeams, moveArchived = false) {
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
      const ex = r.members.find((m) => lcTr(m.name) === lcTr(n));
      if (!ex) { r.members.push({ name: n, teamId: t.id }); changed = true; }
      else if (moveArchived && isArsiv(t) && ex.teamId !== t.id) { ex.teamId = t.id; changed = true; }
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
// Gün önbelleği: kayıt yerelde (IndexedDB) durur, ekranda hemen gösterilir; sunucudan arka planda tazelenir.
// Her kayıtta fetchedAt (son indirme zamanı) tutulur. Yerelde değiştirilmiş (kirli) puantaj/not hiçbir zaman ezilmez.
const DAY_FRESH_MS = 60 * 1000, PREFETCH_FRESH_MS = 5 * 60 * 1000, PREFETCH_CONC = 3;
const inflight = new Map(); // "site|tarih" -> Promise
const normAtt = (o) => { const a = {}; for (const [n, v] of Object.entries(o || {})) if (Number(v) > 0) a[n] = Number(v); return a; };
const shownMain = (site, date) => !!state.day && state.site === site && state.date === date && state.day.key === dayKey(site, date);
// DOM'daki çipleri state'e göre tek tek eşitler. Düzen değişecekse false döner (tam çizim gerekir).
function reconcileChips() {
  const att = state.day.attendance, box = $('chips'), seen = new Set(), todo = [];
  for (const b of box.querySelectorAll('.chip[data-name]')) {
    const n = b.dataset.name, v = att[n] || 0; seen.add(n);
    const cur = b.classList.contains('full') ? 1 : b.classList.contains('half') ? 0.5 : 0;
    const blk = isBlocked(n);
    if (b.closest('.hiddengrp,.orphangrp') && !(v > 0)) return false;
    if (cur !== v || blk !== b.classList.contains('blocked')) todo.push([b, v, blk]);
  }
  for (const n of Object.keys(att)) if (att[n] > 0 && !seen.has(n)) return false;
  for (const [b, v, blk] of todo) {
    if (blk !== b.classList.contains('blocked')) {
      b.classList.toggle('blocked', blk);
      if (blk) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
      const e = b.querySelector('em.oth');
      if (blk && !e) { const c = document.createElement('em'); c.className = 'oth'; c.textContent = LOC[otherSite()]; b.appendChild(c); }
      else if (!blk && e) e.remove();
    }
    const cur = b.classList.contains('full') ? 1 : b.classList.contains('half') ? 0.5 : 0;
    if (cur !== v) { setChipState(b, v); popChip(b); }
  }
  updateCounts();
  return true;
}
const refreshChips = () => { if (!reconcileChips()) renderChips(); };
// Sunucudan bir günü indirir; aynı gün için aynı anda tek istek. Ekranda gösterilen gün ise yalnızca değişen kısım güncellenir.
function fetchDay(site, date) {
  const k = dayKey(site, date);
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    let data;
    try { data = await post({ action: 'getDay', site, date }); } catch { return null; }
    if (!data) return null;
    const att = normAtt(data.attendance), note = data.note == null ? '' : String(data.note);
    const rec0 = await dbGet('days', k);
    const main = shownMain(site, date);
    const base = main ? state.day : (rec0 || { key: k, site, date, attendance: {}, note: '', updatedAt: 0, synced: true });
    let attCh = false, noteCh = false;
    if (!isAttDirty(base) && JSON.stringify(att) !== JSON.stringify(normAtt(base.attendance))) { base.attendance = att; attCh = true; }
    if (!isNoteDirty(base) && !(main && (noteDirty || document.activeElement === $('note'))) && note !== (base.note || '')) { base.note = note; noteCh = true; }
    base.fetchedAt = Date.now();
    await dbPut('days', base);
    if (shownMain(site, date)) {
      state.loading = false;
      if (attCh) refreshChips(); else updateCounts();
      if (noteCh) renderNote();
    } else if (state.site && state.date === date && site === otherSite() && state.day) {
      const oa = base.attendance || {};
      if (JSON.stringify(oa) !== JSON.stringify(state.otherAtt || {})) { state.otherAtt = oa; refreshChips(); }
    }
    return base;
  })().finally(() => {
    inflight.delete(k);
    if (shownMain(site, date) && state.loading) { state.loading = false; updateCounts(); }
  });
  inflight.set(k, p);
  return p;
}
// Önden indirme: en fazla PREFETCH_CONC eşzamanlı; pencere değişince sıradaki eski işler bırakılır.
let pfGen = 0, pfActive = 0, pfQueue = [];
function pfPump() {
  while (pfActive < PREFETCH_CONC && pfQueue.length) {
    const j = pfQueue.shift();
    if (j.gen !== pfGen || inflight.has(dayKey(j.s, j.d))) continue;
    pfActive++;
    fetchDay(j.s, j.d).finally(() => { pfActive--; pfPump(); });
  }
}
async function prefetchWindow(force = false) {
  if (!state.site || !canPull()) return;
  const gen = ++pfGen, site = state.site, o = otherSite(), D = state.date, t = today();
  pfQueue = [];
  const jobs = [];
  const add = (s, d, age) => { if (s && d <= t) jobs.push({ s, d, age, gen }); };
  add(site, D, DAY_FRESH_MS); add(o, D, DAY_FRESH_MS);
  for (const off of [-1, 1, -2, -3]) { const d = shiftDate(D, off); add(site, d, PREFETCH_FRESH_MS); add(o, d, PREFETCH_FRESH_MS); }
  for (const j of jobs) {
    const rec = await dbGet('days', dayKey(j.s, j.d));
    if (gen !== pfGen) return;
    if (!force && rec && rec.fetchedAt && Date.now() - rec.fetchedAt < j.age) continue;
    pfQueue.push(j);
  }
  // Ekrandaki gün ve diğer şantiyenin aynı günü sıra beklemez
  const urgent = pfQueue.filter((j) => j.d === D);
  pfQueue = pfQueue.filter((j) => j.d !== D);
  for (const j of urgent) if (!inflight.has(dayKey(j.s, j.d))) fetchDay(j.s, j.d);
  pfPump();
}
const pullDay = (force = false) => prefetchWindow(force);
async function pullRoster() {
  if (!canPull()) return;
  let data;
  try { data = await post({ action: 'getRoster', site: SYNC_SITE }); }
  catch (err) { if (isUnknownAction(err)) { needUpdate = true; setError(UPDATE_MSG); refreshBanner(); } return; }
  if (!data || !Array.isArray(data.teams)) return;
  try { localStorage.setItem('sd_server_v2', '1'); } catch { /* yoksay */ }
  needUpdate = false; if (lastError === UPDATE_MSG) { setError(''); refreshBanner(); }
  const r = await loadRoster();
  if (rosterDirty.has(SYNC_SITE) || await dbGet('queue', `roster|${SYNC_SITE}`)) { scheduleSync(); return; } // yerel değişiklik önce gider
  const { changed, push } = mergeServerRoster(r, data.teams, true);
  const first = !r.pulled; r.pulled = true;
  if (changed || first) await saveRosterData(r);
  if (r === state) {
    if (changed) renderChips();
    if (changed && !$('settings').hidden) renderTeamSettings();
  }
  if (push) await enqueueRoster();
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
  if (state.site) $('xlSite').value = state.site;
  if (!$('xlMonth').value) $('xlMonth').value = today().slice(0, 7);
  renderLog();
  renderSurum();
  const s = getSettings(); $('setUrl').value = s.url; $('setKey').value = s.key;
  $('testResult').textContent = ''; ui.hideTeam = null; ui.siteHideTeam = null; ui.delName = null; ui.archName = null; ui.editName = null; renderTeamSettings(); renderLocInfo(); showAnim($('settings'), 'sheet-in', 380);
  pullRoster();
}
function readSettingsForm() { ls.set('sd_settings', { url: $('setUrl').value.trim(), key: $('setKey').value.trim() }); }
function autoSaveSettings() { readSettingsForm(); $('testResult').textContent = 'Kaydedildi ✓'; }
['setUrl', 'setKey'].forEach((id) => { $(id).addEventListener('input', autoSaveSettings); $(id).addEventListener('change', autoSaveSettings); });
$('btnSettings').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', () => { readSettingsForm(); hideAnim($('settings'), 260); scheduleSync(300); });
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
    pullRoster();
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
document.addEventListener('touchstart', () => {}, { passive: true }); // iOS: :active (basılı durum) hemen çalışsın
$('prevDay').addEventListener('click', () => stepDay(-1));
$('nextDay').addEventListener('click', () => stepDay(1));
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
