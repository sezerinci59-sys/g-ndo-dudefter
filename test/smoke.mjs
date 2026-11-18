// Duman testi: node test/smoke.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('yok'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'GEÇTİ  ' : 'KALDI  ') + msg); if (!ok) failed++; };

const GAS = 'https://script.google.com/macros/s/TEST/exec';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ['camera'] });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text() + ' @' + (m.location().url||'')); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

// Durumlu sahte sunucu: şantiye başına ekip listesi ve gün kayıtları (bellekte)
const newSrv = () => ({ rosters: {}, days: {}, unknown: new Set() });
let fileSeq = 0;
function serverReply(srv, body) {
  if (srv.unknown.has(body.action)) return { ok: false, error: 'unknown action: ' + body.action };
  switch (body.action) {
    case 'getRoster': return { ok: true, teams: srv.rosters[body.site] || [] };
    case 'saveRoster': srv.rosters[body.site] = body.teams; return { ok: true };
    case 'getDay': { const d = srv.days[body.site + '|' + body.date] || { attendance: {}, note: '' }; return { ok: true, attendance: d.attendance, note: d.note }; }
    case 'saveDay': {
      const k = body.site + '|' + body.date; const d = srv.days[k] || (srv.days[k] = { attendance: {}, note: '' });
      if ('attendance' in body) d.attendance = body.attendance;
      if ('note' in body) d.note = body.note;
      return { ok: true };
    }
    default: return { ok: true, fileId: 'F' + (++fileSeq) };
  }
}
const srv = newSrv();
const received = [];
let mockMode = 'ok', deleteReply = null;
await page.route(GAS, async (route) => {
  if (mockMode === 'offline') return route.abort('failed');
  const body = JSON.parse(route.request().postData() || '{}');
  received.push({ body, ct: route.request().headers()['content-type'] });
  const reply = body.action === 'deletePhoto' && deleteReply ? deleteReply : serverReply(srv, body);
  await route.fulfill({ status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(reply) });
});

await page.addInitScript(([url]) => {
  if (!localStorage.getItem('sd_settings')) localStorage.setItem('sd_settings', JSON.stringify({ url, key: 'testkey' }));
}, [GAS]);
await page.goto(base + 'index.html');

// Şantiye seç
await page.locator('#picker [data-site="gundogdu"]').click();
await page.waitForSelector('#picker', { state: 'hidden' });
check((await page.locator('#siteTabs button.active').textContent()) === 'Gündoğdu', 'Gündoğdu seçildi');

// Ekip oluştur, isimleri ekibin kendi kutusundan ekle
await page.fill('#newTeam', 'Beton');
await page.click('#addTeam');
const teamSec = (name) => page.locator('#chips section.team', { has: page.locator('h3', { hasText: new RegExp('^' + name + '$') }) });
for (const n of ['Ali Veli', 'Ayşe Yılmaz']) {
  await teamSec('Beton').locator('form.teamadd input').fill(n);
  await teamSec('Beton').locator('form.teamadd button').click();
}
check((await page.locator('.chip').count()) === 2, 'İki isim eklendi');

// Puantaj: biri Tam, biri Yarım
await page.click('.chip[data-name="Ali Veli"]');
check((await page.locator('.chip.full[data-name="Ali Veli"]').count()) === 1, 'kısa dokunuş = Tam');
const longPress = async (sel) => { const b = await page.locator(sel).boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await page.waitForTimeout(600); await page.mouse.up(); };
await longPress('.chip[data-name="Ayşe Yılmaz"]');
await page.waitForTimeout(100);
check((await page.locator('.chip.half[data-name="Ayşe Yılmaz"]').count()) === 1, 'uzun basış = Yarım (kısa dokunuş tetiklenmedi)');
const summary = await page.textContent('#summary');
check(summary.includes('2 kişi') && summary.includes('1,5 gün'), 'Özet: ' + summary);

// Not
await page.fill('#note', 'Beton döküldü, hava güzel.');
await page.waitForFunction(() => document.getElementById('noteState').textContent === 'Kaydedildi');

// Fotoğraf (tarayıcıda JPEG üret)
const b64 = await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 2400; c.height = 1200;
  const g = c.getContext('2d'); g.fillStyle = '#4488cc'; g.fillRect(0, 0, 2400, 1200);
  g.fillStyle = '#fff'; g.fillRect(200, 200, 800, 400);
  return c.toDataURL('image/jpeg', 0.9).split(',')[1];
});
await page.setInputFiles('#galInput', { name: 'test.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
await page.waitForSelector('#photoGrid .photo');

// Gönder
await page.evaluate(() => document.getElementById('syncNow').click());
await page.waitForFunction(() => document.getElementById('pendingCount').textContent === '0', null, { timeout: 15000 });

const saveDay = received.filter((r) => r.body.action === 'saveDay');
const lastSave = saveDay[saveDay.length - 1];
const vals = lastSave ? Object.values(lastSave.body.attendance).sort() : [];
check(saveDay.length >= 1, `saveDay isteği alındı (${saveDay.length})`);
check(JSON.stringify(vals) === '[0.5,1]', 'attendance değerleri 1 ve 0.5: ' + JSON.stringify(lastSave && lastSave.body.attendance));
check(lastSave && lastSave.body.site === 'gundogdu' && /^\d{4}-\d{2}-\d{2}$/.test(lastSave.body.date), 'site ve tarih doğru');
check(lastSave && lastSave.body.note.includes('Beton'), 'not gönderildi');
check(lastSave && lastSave.body.key === 'testkey', 'anahtar gönderildi');
check(received.every((r) => /^text\/plain/.test(r.ct || '')), 'Content-Type text/plain (ön kontrol yok)');
const up = received.filter((r) => r.body.action === 'uploadPhoto');
check(up.length === 1 && up[0].body.base64.length > 1000 && /\.jpg$/.test(up[0].body.name), 'uploadPhoto isteği alındı: ' + (up[0] && up[0].body.name));
// gönderilen JPEG en uzun kenar <= 1920
const dim = await page.evaluate(async (b) => {
  const img = new Image(); img.src = 'data:image/jpeg;base64,' + b; await img.decode(); return [img.width, img.height];
}, up[0].body.base64);
check(Math.max(...dim) === 1920, 'fotoğraf küçültüldü: ' + dim.join('x'));
check((await page.locator('#photoGrid .photo.sent').count()) === 1, 'küçük resim "Gönderildi" olarak duruyor');
const blobLeft = await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('santiye-defteri'); r.onsuccess = () => {
    const q = r.result.transaction('photos').objectStore('photos').getAll();
    q.onsuccess = () => res(q.result.map((p) => ({ blob: !!p.blob, thumb: typeof p.thumbData === 'string' && p.thumbData.startsWith('data:image/jpeg') })));
  };
}));
check(blobLeft.length === 1 && !blobLeft[0].blob && blobLeft[0].thumb, 'büyük dosya silindi, küçük resim yazı (data URL) olarak kaldı');
check(errors.length === 0, 'konsol hatası yok' + (errors.length ? ': ' + errors.join(' | ') : ''));


// ---- Ekipler ----
await page.fill('#newTeam', 'Kalıp');
await page.click('#addTeam');
check((await page.locator('#chips section.team:not(.hiddengrp)').count()) === 2, 'iki ekip var');
for (const n of ['Can', 'Deniz']) {
  await teamSec('Kalıp').locator('form.teamadd input').fill(n);
  await teamSec('Kalıp').locator('form.teamadd button').click();
}
check((await teamSec('Kalıp').locator('.chip').count()) === 2, 'Kalıp ekibine iki isim eklendi');
check(/bugün 0\/2/.test(await teamSec('Kalıp').locator('.team-count').textContent()), 'ekip sayacı 0/2');
const minH = await page.evaluate(() => [...document.querySelectorAll('#chips button')].map((b) => b.getBoundingClientRect().height));
check(minH.every((h) => h >= 44), 'ana ekran düğmeleri >=44px');
check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), '390px genişlikte yatay kaydırma yok');
await teamSec('Kalıp').locator('button[data-all]').click();
check((await teamSec('Kalıp').locator('.chip.full').count()) === 2, 'Hepsi geldi: Kalıp tamamı Tam');
check(/2\/2/.test(await teamSec('Kalıp').locator('.team-count').textContent()), 'ekip sayacı 2/2');
check((await teamSec('Beton').locator('.chip.full, .chip.half').count()) === 2, 'Beton ekibi etkilenmedi');
await page.evaluate(() => document.getElementById('syncNow').click());
await page.waitForFunction(() => document.getElementById('pendingCount').textContent === '0', null, { timeout: 15000 });
const sd2 = received.filter((r) => r.body.action === 'saveDay').pop().body.attendance;
check(sd2['Can'] === 1 && sd2['Deniz'] === 1 && sd2['Ali Veli'] === 1 && sd2['Ayşe Yılmaz'] === 0.5 && Object.keys(sd2).length === 4,
  'saveDay payload Hepsi geldi sonrası: ' + JSON.stringify(sd2));

// Ayarlar > Ekipler: gizle (iki adımlı)
await page.click('#btnSettings');
const tset = (name) => page.locator('#teamSettings .tset', { has: page.locator(`input[value="${name}"]`) });
check((await page.locator('#teamSettings .tset').count()) === 2, 'Ayarlar: iki ekip listeli');
await tset('Kalıp').locator('button[data-hide]').click();
check((await page.locator('#chips section.team h3', { hasText: 'Kalıp' }).count()) === 1, 'ilk adımda ekip hâlâ görünür (onay bekleniyor)');
await tset('Kalıp').locator('button[data-hideyes]').click();
check((await page.locator('#teamSettings h3', { hasText: 'Gizli ekipler' }).count()) === 1, 'Gizli ekipler bölümü göründü');
await page.click('#closeSettings');
check((await page.locator('#chips .chip[data-name="Can"]').count()) === 1 && (await page.locator('#chips section.hiddengrp').count()) === 1,
  'bugün kaydı olan gizli üye "Gizli ekipten" grubunda görünür');
check((await page.locator('#chips section.team:not(.hiddengrp) h3', { hasText: 'Kalıp' }).count()) === 0, 'gizli ekip başlığı ana ekranda yok');
// Başka güne geç: gizli ekip üyeleri hiç görünmez
await page.click('#prevDay');
await page.waitForFunction(() => /^Bu gün/.test(document.getElementById('summary').textContent));
check((await page.locator('#chips .chip[data-name="Can"]').count()) === 0 && (await page.locator('#chips .chip[data-name="Deniz"]').count()) === 0,
  'geçmiş günde kaydı olmayan gizli üyeler görünmüyor');
await page.click('#nextDay');
await page.waitForFunction(() => /^Bugün/.test(document.getElementById('summary').textContent));
// Geri getir
await page.click('#btnSettings');
await tset('Kalıp').locator('button[data-unhide]').click();
await page.click('#closeSettings');
check((await teamSec('Kalıp').locator('.chip').count()) === 2 && (await page.locator('#chips section.hiddengrp').count()) === 0, 'Geri getir: üyeler ana ekranda');
// Taşı + sil (iki adımlı)
await page.click('#btnSettings');
// kişi listesi varsayılan olarak açık
await tset('Kalıp').locator('select[data-move="Deniz"]').selectOption({ label: 'Beton' });
await page.click('#closeSettings');
check((await teamSec('Beton').locator('.chip[data-name="Deniz"]').count()) === 1, 'isim Beton ekibine taşındı');
await page.click('#btnSettings');
// kişi listesi varsayılan olarak açık
await tset('Beton').locator('button[data-del="Deniz"]').click();
check((await page.locator('#teamSettings button[data-delyes]').count()) === 1, 'silme için ikinci adım düğmesi çıktı');
await tset('Beton').locator('button[data-delyes="Deniz"]').click();
await page.click('#closeSettings');
check((await page.locator('#chips .chip[data-name="Deniz"]').count()) === 1, 'silinen ismin bugünkü kaydı "Listede olmayanlar"da görünür (veri kaybı yok)');
check(errors.length === 0, 'ekip akışında konsol hatası yok' + (errors.length ? ': ' + errors.join(' | ') : ''));

// ---- Fotoğraf silme ----
const jpegB64 = await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 600; c.height = 400;
  const g = c.getContext('2d'); g.fillStyle = '#c84'; g.fillRect(0, 0, 600, 400); return c.toDataURL('image/jpeg', 0.9).split(',')[1];
});
const jpegFile = { name: 'a.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpegB64, 'base64') };
const idbPhotos = () => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('santiye-defteri'); r.onsuccess = () => {
    const q = r.result.transaction('photos').objectStore('photos').getAll();
    q.onsuccess = () => res(q.result.map((p) => ({ id: p.id, status: p.status, fileId: p.fileId, deleted: !!p.deleted })));
  };
}));
const idbQueue = () => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('santiye-defteri'); r.onsuccess = () => {
    const q = r.result.transaction('queue').objectStore('queue').getAll();
    q.onsuccess = () => res(q.result);
  };
}));
const waitUntil = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await page.waitForTimeout(100); } return false; };
const settle = () => page.waitForFunction(() => document.getElementById('pendingCount').textContent === '0', null, { timeout: 15000 });
const upCount = () => received.filter((r) => r.body.action === 'uploadPhoto').length;

mockMode = 'offline';
errors.length = 0; // (çevrimdışı taklidi tarayıcı konsoluna ağ hatası yazar)
const upBefore = upCount();
await page.setInputFiles('#galInput', jpegFile);
await page.waitForSelector('#photoGrid .photo.pending');
const delBtn = page.locator('#photoGrid .photo.pending .pdel');
const dbb = await delBtn.boundingBox();
check(dbb.width >= 44 && dbb.height >= 44, 'silme düğmesi >=44px: ' + dbb.width + 'x' + dbb.height);
await delBtn.click();
await page.waitForSelector('#photoGrid .pdel.armed');
check((await delBtn.textContent()).trim() === 'Sil?', 'ilk dokunuş: Sil? onayı');
check((await page.locator('#photoGrid .photo.pending').count()) === 1, 'ilk dokunuşta fotoğraf silinmedi');
await page.waitForTimeout(4400);
check((await page.locator('#photoGrid .photo.pending .pdel').textContent()).trim() === '✕', '4 sn sonra onay kendiliğinden ✕ a döndü');
await page.locator('#photoGrid .photo.pending .pdel').click();
await page.waitForSelector('#photoGrid .pdel.armed');
await page.locator('#photoGrid .photo.pending .pdel').click();
await waitUntil(async () => (await page.locator('#photoGrid .photo.pending').count()) === 0, 3000);
check((await page.locator('#photoGrid .photo.pending').count()) === 0, 'bekleyen fotoğraf iki dokunuşla arayüzden kalktı');
check((await idbPhotos()).every((p) => p.status !== 'pending'), 'bekleyen fotoğraf IndexedDB den silindi');
await page.evaluate(() => document.getElementById('syncNow').click());
await page.waitForFunction(() => !document.getElementById('syncError').hidden, null, { timeout: 15000 });
errors.length = 0;
mockMode = 'ok';
await page.evaluate(() => document.getElementById('syncNow').click()); await settle();
check(upCount() === upBefore, 'silinen bekleyen fotoğraf için yükleme gönderilmedi');

// yüklenmiş fotoğraf: sadece listeden kalkar, Drive'a silme isteği GİTMEZ
const sentPhoto = (await idbPhotos()).find((p) => p.status === 'sent');
check(!!(sentPhoto && sentPhoto.fileId), 'yüklenmiş fotoğraf fileId taşıyor: ' + (sentPhoto && sentPhoto.fileId));
await page.locator('#photoGrid .photo.sent .pdel').click();
await page.waitForSelector('#photoGrid .pdel.armed');
await page.locator('#photoGrid .photo.sent .pdel').click();
await waitUntil(async () => (await page.locator('#photoGrid .photo').count()) === 0, 3000);
check((await page.locator('#photoGrid .photo').count()) === 0, 'yüklenmiş fotoğraf listeden kalktı');
await page.evaluate(() => document.getElementById('syncNow').click()); await settle();
check(!received.some((r) => r.body.action === 'deletePhoto'), "Drive'a silme isteği gönderilmedi");
check((await idbPhotos()).length === 0 && (await idbQueue()).length === 0, 'kayıt ve kuyruk temiz');

// ---- Uygulama içi kamera ----
errors.length = 0; // çevrimdışı taklidinden kalan yeniden deneme ağ hatası olabilir
await page.evaluate(() => {
  window.__streams = [];
  const o = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => { const s = await o(c); window.__streams.push(s); return s; };
});
const upB3 = upCount();
await page.click('#camBtn');
await page.waitForSelector('#cam:not([hidden])');
await page.waitForFunction(() => document.getElementById('camVideo').videoWidth > 0, null, { timeout: 10000 });
const sb = await page.locator('#camShutter').boundingBox();
check(sb.width >= 72 && sb.height >= 72, 'deklanşör >=72px: ' + sb.width);
check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'kamera açıkken yatay kaydırma yok');
for (let i = 0; i < 3; i++) await page.locator('#camShutter').click({ delay: 0 });
await page.click('#camDone');
check(await page.locator('#cam').isHidden(), 'Bitti kamerayı kapattı');
const ended = await page.evaluate(() => window.__streams.length > 0 && window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')));
check(ended, 'kamera izleri durduruldu');
await waitUntil(async () => (await idbPhotos()).filter((p) => p.status !== 'deleted').length >= 3);
await page.evaluate(() => document.getElementById('syncNow').click()); await settle();
check(upCount() - upB3 === 3, '3 çekim yüklendi: ' + (upCount() - upB3));
check((await page.locator('#photoGrid .photo.sent').count()) >= 3, 'çekilenler listede');
// ---- v2.0: başlık, tarih, bildirim kutusu, sekmeler, malzeme girişi ----
await page.waitForSelector('#syncBar', { state: 'hidden', timeout: 3000 }).catch(() => {});
check((await page.locator('#syncBar').isHidden()), 'bekleyen yok, hata yok: bildirim kutusu gizli');
const ttl = await page.locator('.apptitle').boundingBox();
check((await page.textContent('.apptitle')) === 'İmatek Şantiye Defteri' && Math.abs(ttl.x + ttl.width / 2 - 195) < 3, 'başlık ortada: ' + (ttl.x + ttl.width / 2));
const dl = await page.locator('#dateText').evaluate((e) => ({ h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight), t: e.textContent, ws: getComputedStyle(e).whiteSpace }));
check(dl.h <= dl.lh * 1.5 && dl.ws === 'nowrap' && /^Bugün · \d+ \S{3} \d{4} \S{3}$/.test(dl.t), 'tarih tek satır: ' + dl.t + ' h=' + dl.h);
check(/Puantaj — Gündoğdu/.test(await page.textContent('.card-head h2')), 'Puantaj başlığında şantiye adı');
check((await page.locator('#siteTabs button.active').evaluate((e) => getComputedStyle(e, '::before').content)).includes('✔'), 'aktif sekmede ✔');
const todayTr = await page.evaluate(() => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`; });
const normalUps = received.filter((r) => r.body.action === 'uploadPhoto').map((r) => r.body.name);
check(normalUps.length > 0 && normalUps.every((n) => /^\d\d\.\d\d\.\d{4}_\d{6}_\d+\.jpg$/.test(n)), 'normal fotoğraf adı değişmedi: ' + normalUps[0]);
const upB5 = upCount();
await page.click('#matBtn');
await page.waitForSelector('#cam:not([hidden])');
await page.waitForFunction(() => document.getElementById('camVideo').videoWidth > 0, null, { timeout: 10000 });
check((await page.textContent('#camMode')).includes('Malzeme girişi (İrsaliye)') && await page.locator('#camMode').isVisible(), 'kamerada Malzeme girişi etiketi');
check(await page.locator('#camWarn').isVisible() && (await page.textContent('#camWarn')).includes('flaş açılamadı'), 'flaş yok uyarısı görünür');
await page.screenshot({ path: '/tmp/claude-0/-home-user/dfd6405a-5f4c-5037-9513-cd07bd58f531/scratchpad/v20c.png' });
for (let i = 0; i < 2; i++) { await page.locator('#camShutter').click(); await page.waitForTimeout(300); }
await page.click('#camDone');
await waitUntil(async () => (await page.locator('#photoGrid .photo .irs').count()) === 2);
check((await page.locator('#photoGrid .photo .irs').count()) === 2, 'küçük resimlerde İrsaliye etiketi');
await page.evaluate(() => document.getElementById('syncNow').click()); await settle();
let irs = received.filter((r) => r.body.action === 'uploadPhoto').slice(upB5).map((r) => r.body.name);
check(JSON.stringify(irs) === JSON.stringify([`İrsaliye_${todayTr}_1.jpg`, `İrsaliye_${todayTr}_2.jpg`]), 'irsaliye adları: ' + irs);
const second = page.locator('#photoGrid .photo:has(.irs)').nth(1);
await second.locator('.pdel').click(); await page.waitForSelector('#photoGrid .pdel.armed');
await second.locator('.pdel').click();
await waitUntil(async () => (await page.locator('#photoGrid .photo .irs').count()) === 1, 3000);
const upB6 = upCount();
await page.click('#matBtn');
await page.waitForSelector('#cam:not([hidden])');
await page.waitForFunction(() => document.getElementById('camVideo').videoWidth > 0, null, { timeout: 10000 });
await page.locator('#camShutter').click(); await page.waitForTimeout(300);
await page.click('#camDone');
await waitUntil(async () => (await page.locator('#photoGrid .photo .irs').count()) === 2);
await page.evaluate(() => document.getElementById('syncNow').click()); await settle();
irs = received.filter((r) => r.body.action === 'uploadPhoto').slice(upB6).map((r) => r.body.name);
check(JSON.stringify(irs) === JSON.stringify([`İrsaliye_${todayTr}_3.jpg`]), 'silinen numara yeniden kullanılmadı: ' + irs);
// Yedek yol: getUserMedia reddedilirse yerel giriş
await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })); });
const upB4 = upCount();
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#camBtn')]);
check(await page.locator('#cam').isHidden(), 'reddedilince tam ekran kamera açılmadı');
check(/Kamera izni/.test(await page.textContent('#toast')), 'bildirim: ' + (await page.textContent('#toast')));
await fc.setFiles(jpegFile);
await waitUntil(() => page.locator('#photoGrid .photo.pending').count().then((n) => n > 0));
await page.evaluate(() => document.getElementById('syncNow').click()); await settle();
check(upCount() - upB4 === 1, 'yedek yoldan çekilen fotoğraf yüklendi');
const upB7 = upCount();
const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('#matBtn')]);
await fc2.setFiles(jpegFile);
await waitUntil(async () => (await page.locator('#photoGrid .photo .irs').count()) === 3);
await page.evaluate(() => document.getElementById('syncNow').click()); await settle();
irs = received.filter((r) => r.body.action === 'uploadPhoto').slice(upB7).map((r) => r.body.name);
check(JSON.stringify(irs) === JSON.stringify([`İrsaliye_${todayTr}_4.jpg`]), 'yedek yolda da irsaliye adı: ' + irs);
check(errors.length === 0, 'silme/kamera akışında konsol hatası yok' + (errors.length ? ': ' + errors.join(' | ') : ''));

// ---- Göç testi: eski biçim ----
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const p2 = await ctx2.newPage();
const errs2 = [];
p2.on('console', (m) => { if (m.type() === 'error') errs2.push(m.text()); });
p2.on('pageerror', (e) => errs2.push('pageerror: ' + e.message));
await p2.goto(base + 'manifest.webmanifest');
const todayISO = await p2.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
await p2.evaluate((td) => new Promise((res, rej) => {
  const r = indexedDB.open('santiye-defteri', 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore('days', { keyPath: 'key' }); db.createObjectStore('names', { keyPath: 'site' });
    const p = db.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
    p.createIndex('siteDate', ['site', 'date']); p.createIndex('status', 'status');
    db.createObjectStore('queue', { keyPath: 'id' });
  };
  r.onsuccess = () => {
    const t = r.result.transaction(['names', 'days'], 'readwrite');
    t.objectStore('names').put({ site: 'gundogdu', list: ['Eski Usta', 'Eski Çırak'] });
    t.objectStore('days').put({ key: 'gundogdu|' + td, site: 'gundogdu', date: td, attendance: { 'Eski Usta': 1, 'Eski Çırak': 0.5 }, note: 'eski not', updatedAt: 1, synced: true });
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  };
}), todayISO);
await p2.evaluate(() => { localStorage.setItem('sd_site', JSON.stringify('gundogdu')); });
await p2.goto(base + 'index.html');
await p2.waitForSelector('#chips .chip');
const ek = p2.locator('#chips section.team', { has: p2.locator('h3', { hasText: /^Ekipsiz$/ }) });
check((await ek.count()) === 1 && (await ek.locator('.chip').count()) === 2, 'göç: iki isim "Ekipsiz" altında');
check((await ek.locator('.chip.full[data-name="Eski Usta"]').count()) === 1 && (await ek.locator('.chip.half[data-name="Eski Çırak"]').count()) === 1, 'göç: puantaj korundu');
check((await p2.textContent('#summary')).includes('2 kişi') && (await p2.textContent('#summary')).includes('1,5 gün'), 'göç: özet doğru');
check((await p2.inputValue('#note')) === 'eski not', 'göç: not korundu');
await p2.reload(); await p2.waitForSelector('#chips .chip');
check((await p2.locator('#chips section.team h3', { hasText: /^Ekipsiz$/ }).count()) === 1, 'göç ikinci açılışta tekrar ekip üretmedi');
check(errs2.length === 0, 'göç testinde konsol hatası yok' + (errs2.length ? ': ' + errs2.join(' | ') : ''));
await ctx2.close();

// ---- Drive'dan çekme: ekipler ve geçmiş günler ----
{
  const srv4 = newSrv(), rec4 = [];
  const ctx4 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p4 = await ctx4.newPage();
  const errs4 = [];
  p4.on('pageerror', (e) => errs4.push('pageerror: ' + e.message));
  await p4.route(GAS, async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    rec4.push(body);
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(serverReply(srv4, body)) });
  });
  await p4.addInitScript(([url]) => {
    if (!localStorage.getItem('sd_settings')) { localStorage.setItem('sd_settings', JSON.stringify({ url, key: 'k' })); localStorage.setItem('sd_site', JSON.stringify('gundogdu')); }
  }, [GAS]);
  const yIso = await p4.evaluate(() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  srv4.rosters.gundogdu = [{ name: 'Kalıpçı', hidden: false, members: ['Sefa', 'Raskon'] }];
  srv4.days['gundogdu|' + yIso] = { attendance: { Sefa: 1 }, note: 'Drive notu' };
  await p4.goto(base + 'index.html');
  const sec4 = p4.locator('#chips section.team', { has: p4.locator('h3', { hasText: /^Kalıpçı$/ }) });
  await p4.waitForSelector('#chips .chip[data-name="Raskon"]', { timeout: 10000 });
  check((await sec4.locator('.chip[data-name="Sefa"]').count()) === 1 && (await sec4.locator('.chip[data-name="Raskon"]').count()) === 1, 'sunucu ekibi: Sefa ve Raskon Kalıpçı altında göründü');
  check(!rec4.some((b) => b.action === 'saveRoster'), 'sunucuyla aynı liste: saveRoster gönderilmedi');
  const w4 = (fn, ms = 10000) => p4.waitForFunction(fn, null, { timeout: ms });
  // (2) yerel isim sunucuya gider
  await sec4.locator('form.teamadd input').fill('Yerel Usta');
  await sec4.locator('form.teamadd button').click();
  const until4 = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await p4.waitForTimeout(100); } return false; };
  check(await until4(() => (srv4.rosters.gundogdu[0].members || []).includes('Yerel Usta')), 'yerel isim saveRoster ile sunucuya gitti: ' + JSON.stringify(srv4.rosters.gundogdu));
  check(srv4.rosters.gundogdu[0].members.includes('Sefa'), 'sunucudaki isimler korundu');
  // (3) geçmiş gün sunucudan gelir
  await p4.click('#prevDay');
  await p4.waitForSelector('.chip.full[data-name="Sefa"]', { timeout: 10000 });
  check(true, 'geçmiş günde Sefa Tam olarak Drive\'dan yüklendi');
  await w4(() => document.getElementById('note').value === 'Drive notu');
  check(true, 'geçmiş günün notu Drive\'dan yüklendi');
  await p4.waitForTimeout(2500);
  check(!rec4.some((b) => b.action === 'saveDay'), 'dokunulmayan güne saveDay gönderilmedi');
  // (4) yalnızca not düzenlenir
  await p4.fill('#note', 'Drive notu, düzeltildi');
  await p4.waitForFunction(() => document.getElementById('noteState').textContent === 'Kaydedildi');
  await p4.evaluate(() => document.getElementById('syncNow').click());
  await until4(() => rec4.some((b) => b.action === 'saveDay'));
  const sd4 = rec4.filter((b) => b.action === 'saveDay').pop();
  check(sd4 && sd4.note === 'Drive notu, düzeltildi' && !('attendance' in sd4), 'yalnız not düzenlendi: saveDay attendance içermiyor: ' + JSON.stringify(sd4));
  check(srv4.days['gundogdu|' + yIso].attendance.Sefa === 1, 'sunucudaki puantaj bozulmadı');
  // (5) eski Apps Script
  srv4.unknown.add('getRoster'); srv4.unknown.add('saveRoster');
  await p4.click('#nextDay');
  await p4.fill('#note', 'Bugün notu');
  await p4.waitForFunction(() => document.getElementById('noteState').textContent === 'Kaydedildi');
  await p4.fill('#newTeam', 'Yeni Ekip'); await p4.click('#addTeam');
  const sdN = rec4.filter((b) => b.action === 'saveDay').length;
  await p4.evaluate(() => document.getElementById('syncNow').click());
  await p4.waitForFunction(() => /Apps Script'i güncelleyin/.test(document.getElementById('syncError').textContent), null, { timeout: 15000 });
  check((await p4.textContent('#syncError')).includes('Ayarlar > Sürüm notları'), 'eski sunucu: güncelleme iletisi: ' + (await p4.textContent('#syncError')));
  check(await until4(() => rec4.filter((b) => b.action === 'saveDay').length > sdN), 'eski sunucuda diğer öğeler (saveDay) yine gitti');
  const q4 = await p4.evaluate(() => new Promise((res) => { const r = indexedDB.open('santiye-defteri'); r.onsuccess = () => { const q = r.result.transaction('queue').objectStore('queue').getAll(); q.onsuccess = () => res(q.result.map((x) => x.type)); }; }));
  check(q4.includes('saveRoster') && !q4.includes('saveDay'), 'saveRoster kuyrukta bekliyor: ' + JSON.stringify(q4));
  check(errs4.length === 0, 'Drive çekme testinde sayfa hatası yok' + (errs4.length ? ': ' + errs4.join(' | ') : ''));
  await ctx4.close();
}

// ---- Ortak liste, İthal sırası, Sigorta çıkışı ----
{
  const srv5 = newSrv(), rec5 = [];
  const ctx5 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p5 = await ctx5.newPage();
  const errs5 = [];
  p5.on('pageerror', (e) => errs5.push('pageerror: ' + e.message));
  await p5.route(GAS, async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    rec5.push(body);
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(serverReply(srv5, body)) });
  });
  await p5.goto(base + 'manifest.webmanifest');
  const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const yIso5 = await p5.evaluate(() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const tIso5 = await p5.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  await p5.evaluate(([y, url]) => new Promise((res, rej) => {
    const r = indexedDB.open('santiye-defteri', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('days', { keyPath: 'key' }); db.createObjectStore('names', { keyPath: 'site' });
      const p = db.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
      p.createIndex('siteDate', ['site', 'date']); p.createIndex('status', 'status');
      db.createObjectStore('queue', { keyPath: 'id' });
    };
    r.onsuccess = () => {
      const t = r.result.transaction(['names', 'days'], 'readwrite');
      t.objectStore('names').put({ site: 'gundogdu', teams: [{ id: 'a1', name: 'Kalıp', hidden: false }], members: [{ name: 'Zeki', teamId: 'a1' }, { name: 'Mehmet', teamId: 'a1' }] });
      t.objectStore('names').put({ site: 'koseilyas', list: ['mehmet', 'Ali Köse'] });
      t.objectStore('days').put({ key: 'koseilyas|' + y, site: 'koseilyas', date: y, attendance: { Zeki: 1 }, note: '', updatedAt: 1, synced: true });
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    };
    localStorage.setItem('sd_settings', JSON.stringify({ url, key: 'k' })); localStorage.setItem('sd_site', JSON.stringify('gundogdu'));
  }), [yIso5, GAS]);
  srv5.days['koseilyas|' + yIso5] = { attendance: { Zeki: 1 }, note: '' };
  await p5.goto(base + 'index.html');
  await p5.waitForSelector('#chips .chip[data-name="Ali Köse"]');
  const names5 = async () => (await p5.locator('#chips .chip').evaluateAll((a) => a.map((x) => x.dataset.name))).sort();
  check(JSON.stringify(await names5()) === JSON.stringify(['Ali Köse', 'Mehmet', 'Zeki']), 'ortak liste: eski iki şantiye listesi birleşti (Mehmet tek): ' + JSON.stringify(await names5()));
  await p5.locator('#siteTabs [data-site="koseilyas"]').click();
  await p5.waitForFunction(() => document.querySelector('#siteTabs button.active').dataset.site === 'koseilyas');
  check(JSON.stringify(await names5()) === JSON.stringify(['Ali Köse', 'Mehmet', 'Zeki']), 'ortak liste: Köseilyas sekmesinde de aynı kişiler');
  await p5.locator('#siteTabs [data-site="gundogdu"]').click();
  await p5.waitForFunction(() => document.querySelector('#siteTabs button.active').dataset.site === 'gundogdu');
  const until5 = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await p5.waitForTimeout(100); } return false; };
  check(await until5(() => rec5.some((b) => b.action === 'saveRoster')), 'göç sonrası saveRoster gönderildi');
  const rosterCalls = rec5.filter((b) => b.action === 'getRoster' || b.action === 'saveRoster');
  check(rosterCalls.length > 0 && rosterCalls.every((b) => b.site === 'gundogdu'), 'yalnız gundogdu ile getRoster/saveRoster: ' + rosterCalls.map((b) => b.action + ':' + b.site).join(','));
  const sv = (srv5.rosters.gundogdu || []).flatMap((t) => t.members);
  check(['Zeki', 'Mehmet', 'Ali Köse'].every((n) => sv.includes(n)), 'sunucuya tüm isimler gitti: ' + JSON.stringify(srv5.rosters.gundogdu));
  // (b) İthal sonda
  const kalip = p5.locator('#chips section.team', { has: p5.locator('h3', { hasText: /^Kalıp$/ }) });
  await p5.waitForFunction(() => document.getElementById('pendingCount').textContent === '0', null, { timeout: 15000 });
  await p5.waitForTimeout(800);
  await kalip.locator('form.teamadd input').fill('Ahmet İthal');
  await kalip.locator('form.teamadd button').click();
  await p5.waitForSelector('#chips .chip[data-name="Ahmet İthal"]');
  const order = await kalip.locator('.chip').evaluateAll((a) => a.map((x) => x.dataset.name));
  check(order.join('|') === 'Zeki|Mehmet|Ahmet İthal', 'İthal olan listenin sonunda: ' + order.join('|'));
  // (c) Sigorta çıkışı
  await p5.click('#btnSettings');
  const ts5 = p5.locator('#teamSettings .tset', { has: p5.locator('input[value="Kalıp"]') });
  const mrows = await ts5.locator('.mname').evaluateAll((a) => a.map((x) => x.textContent));
  check(mrows.join('|') === 'Zeki|Mehmet|Ahmet İthal', 'Ayarlar listesinde de İthal sonda: ' + mrows.join('|'));
  await ts5.locator('button[data-arch="Zeki"]').click();
  check((await p5.locator('#teamSettings button[data-archyes]').count()) === 1 && (await p5.locator('#teamSettings .mname', { hasText: 'Zeki' }).count()) === 1, 'çıkış için ikinci adım, henüz taşınmadı');
  await ts5.locator('button[data-archyes="Zeki"]').click();
  check((await p5.locator('#teamSettings .tset:not(.arsiv) .mname', { hasText: 'Zeki' }).count()) === 0, 'Zeki normal ekip listesinde yok');
  check((await p5.locator('#teamSettings .tset:not(.arsiv)').count()) === 2, 'Arşiv ekibi normal ekip olarak listelenmedi');
  const ar = p5.locator('#teamSettings .arsiv');
  check((await p5.locator('#teamSettings h3', { hasText: 'Arşiv (sigorta çıkışı yapılanlar)' }).count()) === 1 && (await ar.locator('.mname', { hasText: 'Zeki' }).count()) === 1, 'Zeki Arşiv bölümünde');
  const tr5 = tIso5.split('-').reverse().join('.');
  check((await ar.textContent()).includes('Çıkış: ' + tr5), 'çıkış tarihi gösterildi: ' + (await ar.textContent()));
  check((await p5.locator('#teamSettings select option', { hasText: 'Arşiv' }).count()) === 0, 'taşı listesinde Arşiv seçeneği yok');
  await p5.click('#closeSettings');
  check((await p5.locator('#chips .chip[data-name="Zeki"]').count()) === 0 && (await p5.locator('#chips h3', { hasText: 'Arşiv' }).count()) === 0, 'Zeki ana ekranda yok, Arşiv ekibi ana ekranda yok');
  check(await until5(() => (srv5.rosters.gundogdu || []).some((t) => t.name === 'Arşiv (sigorta çıkışı)' && t.hidden === true && t.members.includes('Zeki'))), 'saveRoster: Arşiv ekibi hidden:true ve Zeki içinde: ' + JSON.stringify(srv5.rosters.gundogdu));
  check(!(srv5.rosters.gundogdu.find((t) => t.name === 'Kalıp').members.includes('Zeki')), 'Zeki Kalıp ekibinden çıktı');
  // geçmiş gün: kaydı olan arşivli kişi görünür (gundogdu için kayıt ekle)
  await p5.click('#prevDay');
  await p5.waitForFunction(() => /^Bu gün/.test(document.getElementById('summary').textContent));
  check((await p5.locator('#chips .chip[data-name="Zeki"]').count()) === 0, 'geçmiş günde kaydı olmayan arşivli kişi görünmez');
  await p5.locator('#siteTabs [data-site="koseilyas"]').click();
  await p5.waitForSelector('#chips .chip.full[data-name="Zeki"]', { timeout: 10000 });
  check((await p5.locator('#chips section.hiddengrp .chip[data-name="Zeki"]').count()) === 1, 'geçmiş günde kaydı olan arşivli kişi "Gizli ekipten" altında görünür');
  await p5.click('#nextDay');
  // Geri al
  await p5.click('#btnSettings');
  await p5.locator('#teamSettings button[data-restore="Zeki"]').click();
  await p5.click('#closeSettings');
  check((await p5.locator('#chips section.team', { has: p5.locator('h3', { hasText: /^Kalıp$/ }) }).locator('.chip[data-name="Zeki"]').count()) === 1, 'Geri al: Zeki Kalıp ekibine döndü');
  check(await until5(() => (srv5.rosters.gundogdu.find((t) => t.name === 'Kalıp').members || []).includes('Zeki')), 'geri alma sunucuya gitti');
  // 2.5.1: yeniden adlandırma, süzgeç
  await p5.click('#btnSettings');
  await p5.locator('#teamSettings button[data-ren="Zeki"]').click();
  await p5.locator('#teamSettings input[data-rinput]').fill('Mehmet');
  await p5.locator('#teamSettings button[data-rensave]').click();
  check((await p5.locator('#teamSettings input[data-rinput]').count()) === 1, 'yinelenen isim reddedildi (düzenleme açık kaldı)');
  await p5.locator('#teamSettings input[data-rinput]').fill('Zeki Usta');
  await p5.locator('#teamSettings button[data-rensave]').click();
  await p5.waitForSelector('#teamSettings .mname:has-text("Zeki Usta")');
  check(true, 'isim değişti');
  const dk = await p5.evaluate((y) => new Promise((res) => { const r = indexedDB.open('santiye-defteri'); r.onsuccess = () => { const q = r.result.transaction('days').objectStore('days').get('koseilyas|' + y); q.onsuccess = () => res(q.result); }; }), yIso5);
  check(dk && dk.attendance['Zeki Usta'] === 1 && !('Zeki' in dk.attendance), 'puantaj kayıtlarında isim değişti: ' + JSON.stringify(dk && dk.attendance));
  check(await until5(() => (srv5.days['koseilyas|' + yIso5].attendance['Zeki Usta'] === 1)), 'yeni isimle saveDay gitti');
  check(await until5(() => (srv5.rosters.gundogdu.find((t) => t.name === 'Kalıp').members || []).includes('Zeki Usta')), 'yeni isim sunucu listesinde');
  await p5.locator('#tfPills button', { hasText: /^Ekipsiz$/ }).click();
  check((await p5.locator('#teamSettings .tset').count()) === 1 && (await p5.locator('#teamSettings .mname', { hasText: 'Ali Köse' }).count()) === 1, 'ekip düğmesi süzdü');
  await p5.locator('#tfPills button', { hasText: 'Tümü' }).click();
  await p5.fill('#tfSearch', 'AHMET');
  check((await p5.locator('#teamSettings .mname').count()) === 1, 'arama süzdü');
  await p5.fill('#tfSearch', '');
  await p5.click('#closeSettings');
  // 2.6: Excel
  {
    const XLDIR = '/tmp/claude-0/-home-user/dfd6405a-5f4c-5037-9513-cd07bd58f531/scratchpad/xl';
    const xlFile = XLDIR + '/node_modules/exceljs/dist/exceljs.min.js';
    if (!fs.existsSync(xlFile)) { check(false, 'exceljs test dosyası yok: ' + xlFile); }
    else {
      await p5.route('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(xlFile) }));
      const ym = tIso5.slice(0, 7), day = (n) => `${ym}-${String(n).padStart(2, '0')}`;
      srv5.days['gundogdu|' + day(1)] = { attendance: { 'Mehmet': 1, 'Ahmet İthal': 0.5, 'Yabancı Kişi': 1 }, note: '' };
      srv5.days['gundogdu|' + day(2)] = { attendance: { 'Mehmet': 1 }, note: '' };
      // Kalıpçı ve Demirci ekipleri
      await p5.fill('#newTeam', 'Demirci'); await p5.click('#addTeam');
      await p5.fill('#newTeam', 'KALIPÇI'); await p5.click('#addTeam');
      const dem = p5.locator('#chips section.team', { has: p5.locator('h3', { hasText: /^Demirci$/ }) });
      await dem.locator('form.teamadd input').fill('Demir Ali'); await dem.locator('form.teamadd button').click();
      await p5.waitForSelector('#chips .chip[data-name="Demir Ali"]');
      const kal2 = p5.locator('#chips section.team', { has: p5.locator('h3', { hasText: /^KALIPÇI$/ }) });
      await kal2.locator('form.teamadd input').fill('Kalıp Bir'); await kal2.locator('form.teamadd button').click();
      await kal2.locator('form.teamadd input').fill('Kalıp İki'); await kal2.locator('form.teamadd button').click();
      await p5.waitForSelector('#chips .chip[data-name="Kalıp İki"]');
      srv5.days['gundogdu|' + day(3)] = { attendance: { 'Kalıp İki': 1, 'Demir Ali': 1 }, note: '' };
      await p5.click('#btnSettings');
      await p5.selectOption('#xlSite', 'gundogdu');
      await p5.evaluate(() => { const c = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { window.__dlName = this.download; return c.call(this); }; });
      const dl = p5.waitForEvent('download', { timeout: 30000 });
      await p5.click('#xlGo');
      const dld = await dl;
      const out = '/tmp/claude-0/-home-user/dfd6405a-5f4c-5037-9513-cd07bd58f531/scratchpad/ornek_puantaj.xlsx';
      await dld.saveAs(out);
      const mons = ['OCAK', 'ŞUBAT', 'MART', 'NİSAN', 'MAYIS', 'HAZİRAN', 'TEMMUZ', 'AĞUSTOS', 'EYLÜL', 'EKİM', 'KASIM', 'ARALIK'];
      const mm = mons[Number(ym.slice(5)) - 1], yy = ym.slice(0, 4);
      const dlName = await p5.evaluate(() => window.__dlName);
      check(dlName === `Puantaj_GÜNDOĞDU_${mm}-${yy}.xlsx`, 'dosya adı: ' + dlName);
      const ExcelJS = require(XLDIR + '/node_modules/exceljs');
      const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(out);
      const ws = wb.worksheets[0];
      check(ws.name === `${mm} ${yy}`, 'sayfa adı: ' + ws.name);
      check(ws.getCell('A1').value === 'İMATEK PERSONELİNE AİT PUANTAJ CETVELİ (GÜNDOĞDU)' && ws.getCell('A1').font.bold, 'başlık satırı');
      check(ws.getCell('A2').value === 'İŞYERİ SİCİL NO:', 'sicil satırı');
      const a3 = ws.getCell('A3').value; const a3t = a3.richText ? a3.richText.map((x) => x.text).join('') : a3;
      check(a3t === `AİT OLDUĞU ÇALIŞMA DÖNEMİ: ${mm} -${yy}`, 'dönem satırı: ' + a3t);
      const merges = [...ws.model.merges].sort();
      check(['A1:AN1', 'A2:AN2', 'A3:AN3', 'H4:AL4'].every((x) => merges.includes(x)), 'birleşik hücreler: ' + merges.join(','));
      check(ws.getCell('H4').value === 'ÇALIŞTIĞI GÜNLER', 'ÇALIŞTIĞI GÜNLER');
      const hd = ['SIRA NO', 'PERSONELİN ADI SOYADI', 'T.C NO', 'GÖREVİ', null, 'GİRİŞ TARİHİ', 'ÇIKIŞ TARİHİ'].map((v, i) => ws.getCell(5, i + 1).value === v || (v === null && !ws.getCell(5, 5).value));
      check(hd.every(Boolean) && ws.getCell('H5').value === 1 && ws.getCell('AL5').value === 31 && ws.getCell('AM5').value === 'ÇALIŞTIĞI SAAT GÜN' && ws.getCell('AN5').value === 'İMZA', 'başlık hücreleri');
      let rowOf = (nm) => { for (let r = 6; r < 40; r++) if (ws.getCell(r, 2).value === nm) return r; return 0; };
      const rm = rowOf('MEHMET'), ra = rowOf('AHMET İTHAL'), rz = rowOf('ZEKİ USTA');
      check(rm > 0 && ws.getCell(rm, 8).value === 1 && ws.getCell(rm, 9).value === 1 && !ws.getCell(rm, 10).value, 'Mehmet 1. ve 2. gün 1');
      const f = ws.getCell(rm, 39).value; check(f && f.formula === `SUM(H${rm}:AL${rm})` && f.result === 2, 'SUM formülü: ' + JSON.stringify(f));
      check(ra === rm + 1 || ra > rz, 'Ahmet İthal ekibin sonunda (satır ' + ra + ')');
      check(ws.getCell(ra, 8).value === 0.5 && ws.getCell(ra, 4).value === 'KALIP', 'Ahmet yarım gün, görevi ekip adı: ' + ws.getCell(ra, 4).value);
      check(rowOf('YABANCI KİŞİ') > 0, 'listede olmayan ama kaydı olan kişi eklendi');
      const rk = rowOf('KALIP BİR'), rk2 = rowOf('KALIP İKİ'), rd = rowOf('DEMİR ALİ');
      const argb = (r, c) => ws.getCell(r, c).fill.fgColor.argb;
      check(argb(rk, 1) === 'FFFDE9D9' && argb(rk2, 40) === 'FFFCD5B4', 'KALIPÇI satırları şeftali dönüşümlü: ' + argb(rk, 1) + ',' + argb(rk2, 40));
      check(argb(rd, 1) === 'FFDCE6F1', 'DEMİRCİ satırı mavi: ' + argb(rd, 1));
      check(ws.getCell(rk, 4).value === 'KALIPÇI' && ws.getCell(rk, 2).border.top.style === 'thin', 'KALIPÇI görev ve çerçeve');
      const nd = new Date(Number(yy), Number(ym.slice(5)), 0).getDate();
      if (nd < 31) check(argb(rm, 8 + 30) === 'FFD9D9D9' && !ws.getCell(rm, 38).value, 'ay dışı günler gri');
      check(ws.getColumn(2).width === 26 && ws.getColumn(8).width === 3.2 && ws.views[0].xSplit === 7 && ws.views[0].ySplit === 5, 'sütun genişliği ve dondurma');
      check(ws.pageSetup.orientation === 'landscape' && ws.pageSetup.fitToWidth === 1, 'yazdırma ayarı');
      check(ws.getCell(rm, 2).font.name === 'Calibri' && ws.getCell(rm, 2).font.size === 10, 'Calibri 10');
      await p5.click('#closeSettings');
    }
  }
  check(errs5.length === 0, 'ortak liste/arşiv testinde sayfa hatası yok' + (errs5.length ? ': ' + errs5.join(' | ') : ''));
  await ctx5.close();
}

// Çevrimdışı: istekler iptal
await page.unroute(GAS);
await page.route(GAS, (route) => route.abort('failed'));
await page.fill('#note', 'Çevrimdışı not.');
await page.waitForFunction(() => document.getElementById('noteState').textContent === 'Kaydedildi');
await page.evaluate(() => document.getElementById('syncNow').click());
await page.waitForFunction(() => !document.getElementById('syncError').hidden, null, { timeout: 15000 });
const pending = Number(await page.textContent('#pendingCount'));
check(pending > 0, `çevrimdışı: bekleyen sayısı ${pending} > 0`);
const errTxt = await page.textContent('#syncError');
check(/ulaşılamadı/.test(errTxt), 'çevrimdışı hata metni: ' + errTxt);
const noteKept = await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('santiye-defteri'); r.onsuccess = () => {
    const q = r.result.transaction('days').objectStore('days').getAll();
    q.onsuccess = () => res(q.result.map((d) => d.note));
  };
}));
check(noteKept.includes('Çevrimdışı not.'), 'çevrimdışı not IndexedDB içinde duruyor');

// Ayarlar kalıcılığı (Kapat ile) ve IndexedDB'den geri yükleme
const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const p3 = await ctx3.newPage();
await p3.goto(base + 'index.html');
await p3.locator('#picker [data-site="gundogdu"]').click();
await p3.click('#btnSettings');
await p3.fill('#setUrl', 'https://example.test/exec'); await p3.fill('#setKey', 'abc123');
check((await p3.textContent('#testResult')).includes('Kaydedildi'), 'yazınca Kaydedildi ✓ görünür');
await p3.click('#closeSettings');
await p3.reload();
await p3.waitForSelector('#picker', { state: 'hidden' });
await p3.click('#btnSettings');
check((await p3.inputValue('#setUrl')) === 'https://example.test/exec' && (await p3.inputValue('#setKey')) === 'abc123', 'Kapat sonrası yenileme: ayarlar duruyor');
await p3.waitForTimeout(300);
await p3.evaluate(() => localStorage.clear());
await p3.reload();
await p3.waitForSelector('#picker', { state: 'hidden' });
await p3.click('#btnSettings');
check((await p3.inputValue('#setUrl')) === 'https://example.test/exec' && (await p3.inputValue('#setKey')) === 'abc123', 'localStorage silinince IndexedDB den geri yüklendi');
await ctx3.close();

// ---- 2.8: aynı gün kuralı, kaydırma kabı, Dünküyle aynı, kaydırarak gün değiştirme ----
{
  const ctx6 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p6 = await ctx6.newPage();
  const errs6 = [];
  p6.on('pageerror', (e) => errs6.push('pageerror: ' + e.message));
  await p6.goto(base + 'manifest.webmanifest');
  const iso6 = (off) => p6.evaluate((o) => { const d = new Date(); d.setDate(d.getDate() + o); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }, off);
  const [t6, d2] = [await iso6(0), await iso6(-2)];
  await p6.evaluate(([t, d2]) => new Promise((res, rej) => {
    const r = indexedDB.open('santiye-defteri', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('days', { keyPath: 'key' }); db.createObjectStore('names', { keyPath: 'site' });
      const p = db.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
      p.createIndex('siteDate', ['site', 'date']); p.createIndex('status', 'status');
      db.createObjectStore('queue', { keyPath: 'id' });
    };
    r.onsuccess = () => {
      const tx = r.result.transaction(['names', 'days'], 'readwrite');
      tx.objectStore('names').put({ site: 'gundogdu', teams: [{ id: 'a1', name: 'Ekip', hidden: false }], members: ['Raskon', 'Yarim', 'Bos', 'Dun'].map((name) => ({ name, teamId: 'a1' })) });
      tx.objectStore('days').put({ key: 'koseilyas|' + t, site: 'koseilyas', date: t, attendance: { Raskon: 1, Yarim: 0.5 }, note: '', updatedAt: 1, synced: true });
      tx.objectStore('days').put({ key: 'gundogdu|' + d2, site: 'gundogdu', date: d2, attendance: { Bos: 1, Raskon: 1, Yarim: 1, Dun: 0.5 }, note: '', updatedAt: 1, synced: true });
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    };
    localStorage.setItem('sd_site', JSON.stringify('gundogdu'));
  }), [t6, d2]);
  await p6.goto(base + 'index.html');
  await p6.waitForSelector('#chips .chip[data-name="Raskon"]');
  const chip6 = (n) => p6.locator(`#chips .chip[data-name="${n}"]`);
  const toast6 = async () => (await p6.textContent('#toast')) || '';
  check(await chip6('Raskon').evaluate((b) => b.classList.contains('blocked') && b.getAttribute('aria-disabled') === 'true') && /Köseilyas'ta/.test(await chip6('Raskon').textContent()), '2.8: diğer şantiyede tam gün: isim kapalı ve altında şantiye adı');
  await chip6('Raskon').click({ force: true });
  check(/Raskon bugün Köseilyas'ta tam gün çalıştı\./.test(await toast6()) && (await p6.locator('#chips .chip.full, #chips .chip.half').count()) === 0, '2.8: kapalı isme dokununca bildirim, işaret yok');
  await p6.locator('button[data-all]').click();
  check((await chip6('Yarim').evaluate((b) => b.classList.contains('half'))) && (await chip6('Bos').evaluate((b) => b.classList.contains('full'))) && (await chip6('Dun').evaluate((b) => b.classList.contains('full'))) && (await chip6('Raskon').evaluate((b) => !b.classList.contains('full') && !b.classList.contains('half'))), '2.8: Hepsi geldi kapalıyı atlar, kalan yarımsa yarım yazar');
  await chip6('Bos').click(); await chip6('Dun').click();
  check((await p6.locator('#chips .chip.full').count()) === 0, '2.8: işaret kaldırma çalışıyor');
  await chip6('Yarim').click(); // işaretliyi kaldır
  await chip6('Yarim').click(); // yeniden: kalan 0,5 => yarım
  check((await chip6('Yarim').evaluate((b) => b.classList.contains('half'))) && /yarım gün işaretlendi/.test(await toast6()), '2.8: diğer şantiyede yarım varsa dokunma yarım yazar + bildirim');
  const lp6 = async (n) => { const b = await chip6(n).boundingBox(); await p6.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p6.mouse.down(); await p6.waitForTimeout(600); await p6.mouse.up(); await p6.waitForTimeout(100); };
  await lp6('Yarim');
  check(await chip6('Yarim').evaluate((b) => b.classList.contains('half') && !b.classList.contains('full')), '2.8: uzun basış da en fazla yarım');
  await p6.click('#copyYesterday');
  await p6.waitForFunction(() => /kişi işaretlendi/.test(document.getElementById('toast').textContent), null, { timeout: 3000 }).catch(() => {});
  check(/^2 kişi işaretlendi\.$/.test((await toast6()).trim()), '2.8: Dünküyle aynı (2 gün öncesinden): ' + (await toast6()));
  check((await chip6('Bos').evaluate((b) => b.classList.contains('full'))) && (await chip6('Dun').evaluate((b) => b.classList.contains('half'))) && (await chip6('Yarim').evaluate((b) => b.classList.contains('half'))) && (await chip6('Raskon').evaluate((b) => b.classList.contains('blocked'))), '2.8: Dünküyle aynı: değerler geldi, kural uygulandı, işaretli olan değişmedi');
  // kaydırma kabı
  const sc = await p6.evaluate(() => {
    const s = document.getElementById('scroller');
    if (s.scrollHeight <= s.clientHeight + 100) { const d = document.createElement('div'); d.style.height = '1500px'; document.querySelector('main').appendChild(d); }
    s.scrollTop = 300;
    return { st: s.scrollTop, doc: document.scrollingElement.scrollTop };
  });
  check(sc.st > 0 && sc.doc === 0, '2.8: #scroller kayar, belge kaymaz: ' + JSON.stringify(sc));
  await p6.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });
  // kaydırarak gün değiştirme
  const cdp = await ctx6.newCDPSession(p6);
  const swipeTo = async (x1, y1, x2, y2) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1 }] });
    for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 + (x2 - x1) * i / 6, y: y1 + (y2 - y1) * i / 6 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const sb = await p6.locator('#summary').boundingBox();
  const sy = sb.y + sb.height / 2;
  const dateVal = () => p6.inputValue('#dateInput');
  const t1 = await iso6(1);
  await swipeTo(300, sy, 150, sy + 10);
  await p6.waitForFunction((v) => document.getElementById('dateInput').value === v, t1, { timeout: 3000 }).catch(() => {});
  check((await dateVal()) === t1, '2.8: sola kaydırma = ertesi gün');
  await p6.waitForTimeout(400);
  await swipeTo(100, sy, 260, sy + 10);
  await p6.waitForFunction((v) => document.getElementById('dateInput').value === v, t6, { timeout: 3000 }).catch(() => {});
  check((await dateVal()) === t6, '2.8: sağa kaydırma = önceki gün');
  await p6.waitForTimeout(400);
  await swipeTo(200, sy + 120, 215, sy - 100);
  await p6.waitForTimeout(500);
  check((await dateVal()) === t6, '2.8: dikey kaydırma günü değiştirmez');
  // 2.9.1: parmakla birlikte kayma ve geri yaylanma
  await p6.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });
  await p6.waitForTimeout(100);
  const sb2 = await p6.locator('#summary').boundingBox();
  const sy2 = sb2.y + sb2.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: sy2 }] });
  for (const x of [190, 170, 150, 130]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: sy2 + 2 }] });
  const mid = await p6.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('main .card')).transform).m41);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 160, y: sy2 + 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await p6.waitForTimeout(450);
  const after = await p6.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('main .card')).transform).m41);
  check(mid < -40 && Math.abs(after) < 1 && (await dateVal()) === t6, '2.9.1: içerik parmakla kayar (' + Math.round(mid) + ' px), eşik altında geri yaylanır');
  await p6.fill('#dateInput', '2020-01-01');
  await p6.waitForFunction(() => document.getElementById('dateInput').value === '2020-01-01');
  await p6.waitForTimeout(300);
  await p6.click('#copyYesterday');
  await p6.waitForFunction(() => /Son 7/.test(document.getElementById('toast').textContent), null, { timeout: 3000 }).catch(() => {});
  check(/Son 7 günde kayıt yok\./.test(await toast6()), '2.8: kayıt yoksa bildirim: ' + (await toast6()));
  check(errs6.length === 0, '2.8: sayfa hatası yok ' + errs6.join('|'));
  await ctx6.close();
}

// ---- 2.9: gün önbelleği + önden indirme ----
{
  const ctx9 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p9 = await ctx9.newPage();
  const errs9 = [];
  p9.on('pageerror', (e) => errs9.push('pageerror: ' + e.message));
  const iso9 = (off) => { const d = new Date(); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const T = iso9(0), Y = iso9(-1);
  const days9 = { ['gundogdu|' + Y]: { attendance: { Ali: 1 }, note: '' }, ['gundogdu|' + T]: { attendance: { Veli: 0.5 }, note: '' } };
  const log9 = [], active9 = new Set(); let dup9 = 0, hold9 = false;
  await ctx9.route(GAS, async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    let reply = { ok: true };
    if (body.action === 'getRoster') reply = { ok: true, teams: [{ name: 'Ekip', hidden: false, members: ['Ali', 'Veli'] }] };
    else if (body.action === 'getDay') {
      const k = body.site + '|' + body.date;
      if (active9.has(k)) dup9++;
      active9.add(k);
      const snap = days9[k] || { attendance: {}, note: '' };
      await new Promise((r) => setTimeout(r, 800));
      active9.delete(k); log9.push(k);
      reply = { ok: true, attendance: snap.attendance, note: snap.note };
    } else if (body.action === 'saveDay') { if (hold9) await new Promise((r) => setTimeout(r, 6000)); }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(reply) });
  });
  await p9.addInitScript(([url]) => {
    if (!localStorage.getItem('sd_settings')) localStorage.setItem('sd_settings', JSON.stringify({ url, key: 'k' }));
    if (!localStorage.getItem('sd_site')) localStorage.setItem('sd_site', JSON.stringify('gundogdu'));
  }, [GAS]);
  await p9.goto(base + 'index.html');
  await p9.waitForSelector('#chips .chip[data-name="Ali"]');
  const until9 = async (fn, ms = 12000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await p9.waitForTimeout(50); } return false; };
  const want = []; for (let i = -3; i <= 0; i++) for (const s of ['gundogdu', 'koseilyas']) want.push(s + '|' + iso9(i));
  await until9(() => want.every((k) => log9.includes(k)));
  check(want.every((k) => log9.includes(k)), '2.9: önden indirme D-3..D, iki şantiye (' + log9.length + ' istek)');
  check(dup9 === 0, '2.9: aynı gün için eşzamanlı tekrar istek yok');
  check(log9.every((k) => k.split('|')[1] <= T), '2.9: bugünden ilerisi indirilmez');
  // (a) önceki gün hemen görünür
  const ms = await p9.evaluate(() => new Promise((res) => {
    const t0 = performance.now();
    document.getElementById('prevDay').click();
    const tick = () => {
      const c = document.querySelector('#chips .chip[data-name="Ali"]');
      if (document.getElementById('dateInput').value && c && c.classList.contains('full')) res(performance.now() - t0);
      else if (performance.now() - t0 > 3000) res(99999); else requestAnimationFrame(tick);
    };
    tick();
  }));
  check(ms < 100, '2.9: önceki gün önbellekten ' + Math.round(ms) + ' ms içinde göründü');
  check((await p9.inputValue('#dateInput')) === Y, '2.9: tarih önceki güne geçti');
  await p9.waitForTimeout(400);
  // (c) ekranda olmayan günün cevabı arayüzü değiştirmez
  await p9.evaluate((k) => new Promise((res, rej) => {
    const r = indexedDB.open('santiye-defteri'); r.onsuccess = () => {
      const st = r.result.transaction('days', 'readwrite').objectStore('days'); const g = st.get(k);
      g.onsuccess = () => { const v = g.result; v.fetchedAt = 0; st.put(v).onsuccess = () => res(); };
    }; r.onerror = () => rej(r.error);
  }), 'gundogdu|' + Y);
  days9['gundogdu|' + Y] = { attendance: { Veli: 1 }, note: '' };
  const n0 = log9.length;
  await p9.evaluate(() => window.dispatchEvent(new Event('online'))); // ekrandaki günü yeniden indirir (800 ms gecikmeli)
  await p9.click('#nextDay'); // cevap gelmeden bugüne dön (kilitli geçiş kuyruğa alınır)
  await until9(async () => (await p9.inputValue('#dateInput')) === T, 3000);
  await p9.waitForTimeout(250);
  const snapT = await p9.evaluate(() => [...document.querySelectorAll('#chips .chip')].map((c) => c.dataset.name + ':' + c.className).join('|'));
  await until9(() => log9.slice(n0).includes('gundogdu|' + Y), 4000);
  await p9.waitForTimeout(300);
  const snapT2 = await p9.evaluate(() => [...document.querySelectorAll('#chips .chip')].map((c) => c.dataset.name + ':' + c.className).join('|'));
  check(snapT === snapT2 && (await p9.inputValue('#dateInput')) === T, '2.9: ekranda olmayan günün cevabı arayüzü değiştirmedi');
  await p9.click('#prevDay'); await p9.waitForTimeout(500);
  check(await p9.locator('#chips .chip[data-name="Veli"]').evaluate((b) => b.classList.contains('full')), '2.9: ama önbelleğe yazıldı (geri gelince yeni veri)');
  await p9.click('#nextDay'); await p9.waitForTimeout(500);
  // (d) kirli yerel puantaj önden indirmeyle ezilmez
  hold9 = true;
  const ali = p9.locator('#chips .chip[data-name="Ali"]');
  await ali.click();
  check(await ali.evaluate((b) => b.classList.contains('full')), '2.9: Ali işaretlendi (yerel)');
  days9['gundogdu|' + T] = { attendance: { Veli: 1 }, note: '' };
  const n1 = log9.length;
  await p9.evaluate(() => window.dispatchEvent(new Event('online')));
  await until9(() => log9.slice(n1).includes('gundogdu|' + T), 4000);
  await p9.waitForTimeout(300);
  check(await ali.evaluate((b) => b.classList.contains('full')) && await p9.locator('#chips .chip[data-name="Veli"]').evaluate((b) => b.classList.contains('half')), '2.9: kirli puantaj sunucu verisiyle ezilmedi');
  check(errs9.length === 0, '2.9: sayfa hatası yok ' + errs9.join('|'));
  await ctx9.close();
}

// ---- 2.9.2: ekip listesini kapatma ----
{
  const ctx7 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p7 = await ctx7.newPage();
  const errs7 = [];
  p7.on('pageerror', (e) => errs7.push('pageerror: ' + e.message));
  await p7.addInitScript(() => { if (!localStorage.getItem('sd_site')) localStorage.setItem('sd_site', JSON.stringify('gundogdu')); });
  await p7.goto(base + 'index.html');
  await p7.waitForSelector('#chips', { state: 'attached' });
  await p7.fill('#newTeam', 'Beton'); await p7.click('#addTeam');
  const sec7 = p7.locator('#chips section.team', { has: p7.locator('h3', { hasText: /^Beton$/ }) });
  for (const n of ['Ali', 'Veli']) { await sec7.locator('form.teamadd input').fill(n); await sec7.locator('form.teamadd button').click(); }
  const tgl = sec7.locator('.tgl');
  check((await tgl.getAttribute('aria-expanded')) === 'true' && (await tgl.getAttribute('aria-label')) === 'Listeyi kapat' && (await tgl.boundingBox()).width >= 44, '2.9.2: ekip başlığında ▼ düğmesi, varsayılan açık');
  await tgl.click();
  await p7.waitForTimeout(450);
  check((await tgl.getAttribute('aria-expanded')) === 'false' && (await tgl.getAttribute('aria-label')) === 'Listeyi aç', '2.9.2: kapatınca aria-expanded=false');
  check(await sec7.locator('.tbody-in').evaluate((e) => e.hasAttribute('inert') && e.getBoundingClientRect().height < 2), '2.9.2: liste inert ve yüksekliği 0');
  check(await sec7.locator('[data-all]').isDisabled(), '2.9.2: kapalıyken Hepsi geldi devre dışı');
  const sum7 = await p7.textContent('#summary');
  await sec7.locator('.chip[data-name="Ali"]').click({ force: true, timeout: 1000 }).catch(() => {});
  check((await p7.textContent('#summary')) === sum7 && (await p7.locator('#chips .chip.full').count()) === 0, '2.9.2: kapalıyken isme dokunulamaz');
  await p7.reload(); await p7.waitForSelector('#chips .chip[data-name="Ali"]', { state: 'attached' });
  check((await sec7.locator('.tgl').getAttribute('aria-expanded')) === 'false', '2.9.2: yenilemede aynı gün+şantiye kapalı kalır');
  await p7.locator('#siteTabs button[data-site="koseilyas"]').click(); await p7.waitForTimeout(400);
  check((await sec7.locator('.tgl').getAttribute('aria-expanded')) === 'true', '2.9.2: diğer şantiye açık başlar');
  await p7.locator('#siteTabs button[data-site="gundogdu"]').click(); await p7.waitForTimeout(400);
  check((await sec7.locator('.tgl').getAttribute('aria-expanded')) === 'false', '2.9.2: şantiyeye dönünce kapalı');
  await p7.click('#nextDay'); await p7.waitForTimeout(600);
  check((await sec7.locator('.tgl').getAttribute('aria-expanded')) === 'true' && !(await sec7.locator('[data-all]').isDisabled()), '2.9.2: ertesi gün açık başlar');
  await p7.click('#prevDay'); await p7.waitForTimeout(600);
  await sec7.locator('.tgl').click(); await p7.waitForTimeout(450);
  check((await sec7.locator('.tgl').getAttribute('aria-expanded')) === 'true' && await sec7.locator('.chip[data-name="Ali"]').isEnabled(), '2.9.2: tekrar açılır');
  check(errs7.length === 0, '2.9.2: sayfa hatası yok ' + errs7.join('|'));
  await ctx7.close();
}

// ---- 2.9.4: şantiye bazında ekip gizleme ----
{
  const ctxH = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const pH = await ctxH.newPage();
  const errsH = [];
  pH.on('pageerror', (e) => errsH.push('pageerror: ' + e.message));
  await pH.addInitScript(() => { if (!localStorage.getItem('sd_site')) localStorage.setItem('sd_site', JSON.stringify('gundogdu')); });
  await pH.goto(base + 'index.html');
  await pH.waitForSelector('#chips', { state: 'attached' });
  for (const t of ['Beton', 'Demir']) { await pH.fill('#newTeam', t); await pH.click('#addTeam'); }
  const secH = (t) => pH.locator('#chips section.team[data-team]', { has: pH.locator('h3', { hasText: new RegExp('^' + t + '$') }) });
  for (const [t, ns] of [['Beton', ['Ali', 'Veli']], ['Demir', ['Can']]]) for (const n of ns) { await secH(t).locator('form.teamadd input').fill(n); await secH(t).locator('form.teamadd button').click(); }
  await pH.locator('#chips .chip[data-name="Ali"]').click();
  await pH.locator('#chips .chip[data-name="Can"]').click();
  await pH.click('#btnSettings');
  const tsH = pH.locator('#teamSettings .tset', { has: pH.locator('input[value="Beton"]') });
  await tsH.locator('button[data-sshide]').click();
  check(await tsH.locator('button[data-sshideyes]').count() === 1 && /Evet, Gündoğdu'da gizle/.test(await tsH.locator('button[data-sshideyes]').textContent()), '2.9.4: ikinci adım onayı');
  await tsH.locator('button[data-sshideno]').click();
  check(await tsH.locator('button[data-sshide]').count() === 1 && /Bu şantiyede gösterme \(Gündoğdu\)/.test(await tsH.locator('button[data-sshide]').textContent()), '2.9.4: Vazgeç geri döner');
  check((await pH.locator('#chips section.team[data-team]').count()) === 2, '2.9.4: Vazgeç sonrası ekipler duruyor');
  await tsH.locator('button[data-sshide]').click(); await tsH.locator('button[data-sshideyes]').click();
  check(/Gündoğdu'da gizli/.test(await tsH.textContent()) && await tsH.locator('button[data-sshow]').count() === 1, '2.9.4: gizli satırı ve Göster düğmesi');
  await pH.click('#closeSettings'); await pH.waitForTimeout(400);
  check((await secH('Beton').count()) === 0 && (await secH('Demir').count()) === 1, '2.9.4: Gündoğdu ana ekranda Beton yok, Demir var');
  check((await pH.locator('#chips .hiddengrp .chip[data-name="Ali"]').count()) === 1 && (await pH.locator('#chips .chip[data-name="Veli"]').count()) === 0, '2.9.4: kaydı olan Ali görünür, Veli görünmez');
  await pH.locator('#chips .hiddengrp .chip[data-name="Ali"]').click(); await pH.waitForTimeout(200);
  check((await pH.locator('#chips .chip[data-name="Ali"]').count()) === 0, '2.9.4: gizli ekipten kayıt kaldırılabilir');
  await pH.locator('#siteTabs button[data-site="koseilyas"]').click(); await pH.waitForTimeout(500);
  check((await secH('Beton').count()) === 1 && (await pH.locator('#chips .chip[data-name="Veli"]').count()) === 1, '2.9.4: Köseilyas etkilenmedi');
  await pH.locator('#siteTabs button[data-site="gundogdu"]').click(); await pH.waitForTimeout(500);
  await pH.waitForTimeout(300);
  await pH.evaluate(() => localStorage.removeItem('sd_site_hide'));
  await pH.reload(); await pH.waitForSelector('#chips', { state: 'attached' }); await pH.waitForTimeout(500);
  check((await secH('Beton').count()) === 0, '2.9.4: localStorage silinince ayar IndexedDB den geri geldi');
  await pH.click('#btnSettings');
  await pH.locator('#teamSettings .tset', { has: pH.locator('input[value="Beton"]') }).locator('button[data-sshow]').click();
  await pH.click('#closeSettings'); await pH.waitForTimeout(400);
  check((await secH('Beton').count()) === 1, '2.9.4: Göster ile ekip geri geldi');
  check(errsH.length === 0, '2.9.4: sayfa hatası yok ' + errsH.join('|'));
  await ctxH.close();
}

// Ayar yoksa Türkçe uyarı
await page.unroute(GAS);
await page.evaluate(() => localStorage.setItem('sd_settings', '{}'));
await page.evaluate(() => document.getElementById('syncNow').click());
await page.waitForFunction(() => /Ayarlar/.test(document.getElementById('syncError').textContent));
check(true, 'URL/anahtar yokken uyarı: ' + (await page.textContent('#syncError')).slice(0, 50) + '…');

await browser.close(); server.close();
console.log(failed ? `\n${failed} kontrol başarısız` : '\nTüm kontroller geçti');
process.exit(failed ? 1 : 0);
