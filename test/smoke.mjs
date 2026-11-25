// Duman testi: node test/smoke.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createGas } from './gas-sim.mjs';

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

// Durumlu sahte sunucu: gerçek apps-script/Code.gs, bellekteki sahte E-Tablo/Drive ile (test/gas-sim.mjs)
// old = true: 3.0 öncesi Apps Script taklidi (yeni işlemleri ve alanları bilmez)
function newSrv() {
  const gas = createGas();
  const srv = { gas, unknown: new Set(), old: false };
  srv.reply = (body) => {
    const b = { ...body }; delete b.key;
    if (srv.unknown.has(b.action)) return { ok: false, error: 'unknown action: ' + b.action };
    if (srv.old) {
      if (['getRoster2', 'saveRoster2', 'getMeta', 'saveMeta'].includes(b.action)) return { ok: false, error: 'unknown action: ' + b.action };
      delete b.changes; delete b.noteUpdatedAt; delete b.kind; delete b.uid;
      const r = gas.call(b); delete r.v; delete r.noteUpdatedAt; return r;
    }
    return gas.call(b);
  };
  srv.seedDay = (site, date, attendance, note = '') => gas.call({ action: 'saveDay', site, date, attendance, note });
  srv.day = (site, date) => gas.call({ action: 'getDay', site, date });
  srv.seedRoster = (teams) => gas.call({ action: 'saveRoster', site: 'gundogdu', teams });
  srv.roster = () => gas.call({ action: 'getRoster', site: 'gundogdu' }).teams; // görünen liste (eski biçim)
  srv.meta = () => gas.call({ action: 'getMeta' }).items;
  srv.photoNames = (site, trDate) => {
    const root = gas.folders.get(site === 'gundogdu' ? '1PnWIRJRoiC4DauFzMnSJqoCX0hXDUWZ9' : '1atlqBgNzuRbUCiomprLghf27MluqsM-2');
    const f = root.folders.find((x) => x.name === trDate); return f ? f.files.map((x) => x.name) : [];
  };
  return srv;
}
const serverReply = (srv, body) => srv.reply(body);
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
const DAY0 = lastSave && lastSave.body.date;
const srvDay0 = () => srv.day('gundogdu', DAY0);
const vals = Object.values(srvDay0().attendance).sort();
check(saveDay.length >= 1, `saveDay isteği alındı (${saveDay.length})`);
check(JSON.stringify(vals) === '[0.5,1]', 'sunucuda puantaj 1 ve 0.5: ' + JSON.stringify(srvDay0().attendance));
check(saveDay.every((r) => !('attendance' in r.body)) && saveDay.some((r) => r.body.changes && r.body.changes['Ali Veli'] === 1), '3.0: saveDay yalnız değişen kişileri (changes) gönderir: ' + JSON.stringify(saveDay.map((r) => r.body.changes)));
check(lastSave && lastSave.body.site === 'gundogdu' && /^\d{4}-\d{2}-\d{2}$/.test(lastSave.body.date), 'site ve tarih doğru');
check(srvDay0().note.includes('Beton') && saveDay.some((r) => r.body.note && r.body.noteUpdatedAt > 0), 'not zaman damgasıyla gönderildi');
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
const sd2 = srvDay0().attendance;
check(sd2['Can'] === 1 && sd2['Deniz'] === 1 && sd2['Ali Veli'] === 1 && sd2['Ayşe Yılmaz'] === 0.5 && Object.keys(sd2).length === 4,
  'sunucu Hepsi geldi sonrası: ' + JSON.stringify(sd2));
const lastCh = received.filter((r) => r.body.action === 'saveDay').pop().body.changes || {};
check(lastCh.Can === 1 && lastCh.Deniz === 1 && !('Ali Veli' in lastCh), 'Hepsi geldi: yalnız o ekip gönderildi: ' + JSON.stringify(lastCh));

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
    q.onsuccess = () => res(q.result.map((p) => ({ id: p.id, status: p.status, fileId: p.fileId, deleted: !!p.deleted, name: p.name, selected: p.selected, site: p.site, date: p.date })));
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

// ---- 3.2: fotoğraf seçme (★ = Drive adı s_ ile başlar) ----
{
  const renames = () => received.filter((r) => r.body.action === 'renamePhoto');
  const star = () => page.locator('#photoGrid .photo .psel');
  const lastUp = () => received.filter((r) => r.body.action === 'uploadPhoto').slice(-1)[0].body.name;
  const dayNames = async () => { const d = (await idbPhotos())[0]; return srv.photoNames(d.site, trDay(d.date)); };
  function trDay(iso) { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; }
  mockMode = 'offline'; errors.length = 0;
  await page.setInputFiles('#galInput', jpegFile);
  await page.waitForSelector('#photoGrid .photo.pending');
  const sbx = await star().boundingBox(), pbx = await page.locator('#photoGrid .photo').boundingBox();
  check(sbx.width >= 44 && sbx.height >= 44 && sbx.x - pbx.x < 6 && sbx.y - pbx.y < 6, '3.2: yıldız sol üstte, >=44px: ' + sbx.width + 'x' + sbx.height);
  check((await star().textContent()).trim() === '☆', '3.2: seçilmemiş ☆');
  await star().click();
  check((await star().textContent()).trim() === '★' && (await page.locator('#photoGrid .photo.sel').count()) === 1, '3.2: dokununca hemen ★ ve altın çerçeve');
  const bw = await page.locator('#photoGrid .photo.sel').evaluate((e) => getComputedStyle(e).borderTopWidth);
  check(bw === '3px', '3.2: seçili çerçeve 3px: ' + bw);
  check((await page.locator('#photoGrid .pdel.armed').count()) === 0 && (await page.locator('#photoGrid .photo').count()) === 1, '3.2: yıldız silmeyi tetiklemedi');
  await waitUntil(async () => (await idbPhotos()).some((p) => p.selected === true), 3000);
  check((await idbPhotos()).some((p) => p.status === 'pending' && p.selected === true), '3.2: yerel kayıtta selected=true');
  mockMode = 'ok'; errors.length = 0;
  await page.evaluate(() => document.getElementById('syncNow').click()); await settle();
  check(/^s_/.test(lastUp()), '3.2: yüklemeden önce seçilen: Drive adı s_ ile başlıyor: ' + lastUp());
  let rec = (await idbPhotos()).find((p) => p.status === 'sent');
  check(rec && rec.name === lastUp() && rec.selected === true && rec.fileId, '3.2: kayıt sunucu adını tuttu');
  check((await star().textContent()).trim() === '★', '3.2: gönderildikten sonra ★ duruyor');
  // seçimi kaldır (çevrimiçi): renamePhoto gider, ad eski haline döner
  const r0 = renames().length;
  await star().click();
  check((await star().textContent()).trim() === '☆', '3.2: iyimser: hemen ☆');
  await waitUntil(async () => renames().length === r0 + 1);
  await settle();
  check(renames().length === r0 + 1 && renames()[r0].body.selected === false && renames()[r0].body.fileId === rec.fileId, '3.2: renamePhoto {selected:false} gönderildi');
  rec = (await idbPhotos()).find((p) => p.status === 'sent');
  check(!/^s_/.test(rec.name) && rec.name === lastUp().replace(/^s_/, ''), '3.2: kayıttaki ad eski adına döndü: ' + rec.name);
  check((await dayNames()).includes(rec.name) && !(await dayNames()).some((n) => /^s_/.test(n)), '3.2: Drive adı eski haline döndü');
  check(received.filter((r) => r.body.action === 'deletePhoto').length === 0 && (await page.locator('#photoGrid .photo').count()) === 1, '3.2: yıldız silme yapmadı');
  // çevrimdışı seç: kuyruğa girer, çevrimiçi olunca gider
  mockMode = 'offline'; errors.length = 0;
  await star().click(); await star().click(); await star().click(); // üç dokunuş: son durum seçili (coalesce)
  await page.waitForTimeout(300);
  const qs = (await idbQueue()).filter((q) => q.type === 'renamePhoto');
  check(qs.length === 1 && qs[0].selected === true, '3.2: çevrimdışı: tek renamePhoto kuyrukta (son durum): ' + JSON.stringify(qs.map((q) => q.selected)));
  const r1 = renames().length;
  mockMode = 'ok'; errors.length = 0;
  await page.evaluate(() => document.getElementById('syncNow').click()); await settle();
  check(renames().length === r1 + 1 && renames()[r1].body.selected === true, '3.2: çevrimiçi olunca renamePhoto gönderildi');
  rec = (await idbPhotos()).find((p) => p.status === 'sent');
  check(/^s_/.test(rec.name) && (await dayNames()).includes(rec.name), '3.2: seçim sonrası kayıt ve Drive adı s_ ile: ' + rec.name);
  // eski Apps Script: bilinmeyen işlem -> kuyrukta kalır, uyarı görünür
  srv.unknown.add('renamePhoto'); errors.length = 0;
  await star().click();
  await waitUntil(async () => renames().length >= r1 + 2, 6000);
  await page.waitForTimeout(500);
  check((await idbQueue()).some((q) => q.type === 'renamePhoto'), '3.2: bilinmeyen işlem: renamePhoto kuyrukta kaldı');
  await page.click('#btnSettings');
  check(await page.locator('#updateNote').isVisible(), "3.2: Ayarlar'da Apps Script güncelleme notu görünür");
  await page.click('#closeSettings');
  srv.unknown.delete('renamePhoto'); errors.length = 0;
  await page.evaluate(() => document.getElementById('syncNow').click()); await settle();
  rec = (await idbPhotos()).find((p) => p.status === 'sent');
  check(!/^s_/.test(rec.name) && !(await dayNames()).some((n) => /^s_/.test(n)), '3.2: güncelleme sonrası kuyruk gitti, ad eski haline döndü');
  // temizlik: sonraki testler boş liste bekliyor
  await star().evaluate((e) => e.closest('.photo').querySelector('.pdel').click());
  await page.waitForSelector('#photoGrid .pdel.armed');
  await page.locator('#photoGrid .photo .pdel').click();
  await waitUntil(async () => (await page.locator('#photoGrid .photo').count()) === 0, 3000);
  errors.length = 0;
}

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
check(normalUps.length > 0 && normalUps.every((n) => /^(s_)?\d\d\.\d\d\.\d{4}_\d{6}_\d+\.jpg$/.test(n)), 'normal fotoğraf adı değişmedi: ' + normalUps[0]);
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
const drvIrs = srv.photoNames('gundogdu', todayTr).filter((n) => n.startsWith('İrsaliye')).sort();
check(JSON.stringify(drvIrs) === JSON.stringify([1, 2, 3, 4].map((i) => `İrsaliye_${todayTr}_${i}.jpg`)), "Drive'da irsaliye adları: " + drvIrs);
check((await page.locator('#photoGrid .photo .irs', { hasText: /^İrsaliye 4$/ }).count()) === 1, 'gönderilen irsaliyede numara görünür');
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
  srv4.seedRoster([{ name: 'Kalıpçı', hidden: false, members: ['Sefa', 'Raskon'] }]);
  srv4.seedDay('gundogdu', yIso, { Sefa: 1 }, 'Drive notu');
  await p4.goto(base + 'index.html');
  const sec4 = p4.locator('#chips section.team', { has: p4.locator('h3', { hasText: /^Kalıpçı$/ }) });
  await p4.waitForSelector('#chips .chip[data-name="Raskon"]', { timeout: 10000 });
  check((await sec4.locator('.chip[data-name="Sefa"]').count()) === 1 && (await sec4.locator('.chip[data-name="Raskon"]').count()) === 1, 'sunucu ekibi: Sefa ve Raskon Kalıpçı altında göründü');
  check(!rec4.some((b) => b.action === 'saveRoster' || b.action === 'saveRoster2'), 'sunucuyla aynı liste: saveRoster2 gönderilmedi');
  const w4 = (fn, ms = 10000) => p4.waitForFunction(fn, null, { timeout: ms });
  // (2) yerel isim sunucuya gider
  await sec4.locator('form.teamadd input').fill('Yerel Usta');
  await sec4.locator('form.teamadd button').click();
  const until4 = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await p4.waitForTimeout(100); } return false; };
  check(await until4(() => (srv4.roster()[0].members || []).includes('Yerel Usta')), 'yerel isim saveRoster2 ile sunucuya gitti: ' + JSON.stringify(srv4.roster()));
  check(srv4.roster()[0].members.includes('Sefa'), 'sunucudaki isimler korundu');
  check(rec4.some((b) => b.action === 'saveRoster2' && b.changes.some((c) => c.type === 'member' && c.name === 'Yerel Usta')) && !rec4.some((b) => b.action === 'saveRoster2' && b.changes.some((c) => c.name === 'Sefa')), 'saveRoster2 yalnız değişen kişiyi gönderdi');
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
  check(sd4 && sd4.note === 'Drive notu, düzeltildi' && !('attendance' in sd4) && !('changes' in sd4), 'yalnız not düzenlendi: saveDay puantaj içermiyor: ' + JSON.stringify(sd4));
  check(srv4.day('gundogdu', yIso).attendance.Sefa === 1, 'sunucudaki puantaj bozulmadı');
  // (5) eski Apps Script (3.0 öncesi, ekip listesi de yok)
  srv4.old = true; srv4.unknown.add('getRoster'); srv4.unknown.add('saveRoster');
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
  srv5.seedDay('koseilyas', yIso5, { Zeki: 1 });
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
  check(await until5(() => rec5.some((b) => b.action === 'saveRoster2')), 'göç sonrası saveRoster2 gönderildi');
  const rosterCalls = rec5.filter((b) => /^(get|save)Roster2?$/.test(b.action));
  check(rosterCalls.length > 0 && rosterCalls.every((b) => b.site === 'gundogdu'), 'yalnız gundogdu ile getRoster2/saveRoster2: ' + rosterCalls.map((b) => b.action + ':' + b.site).join(','));
  await until5(() => ['Zeki', 'Mehmet', 'Ali Köse'].every((n) => srv5.roster().flatMap((t) => t.members).includes(n)));
  const sv = srv5.roster().flatMap((t) => t.members);
  check(['Zeki', 'Mehmet', 'Ali Köse'].every((n) => sv.includes(n)), 'sunucuya tüm isimler gitti: ' + JSON.stringify(srv5.roster()));
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
  check(await until5(() => srv5.roster().some((t) => t.name === 'Arşiv (sigorta çıkışı)' && t.hidden === true && t.members.includes('Zeki'))), 'saveRoster2: Arşiv ekibi hidden:true ve Zeki içinde: ' + JSON.stringify(srv5.roster()));
  check(!(srv5.roster().find((t) => t.name === 'Kalıp').members.includes('Zeki')), 'Zeki Kalıp ekibinden çıktı');
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
  check(await until5(() => (srv5.roster().find((t) => t.name === 'Kalıp').members || []).includes('Zeki')), 'geri alma sunucuya gitti');
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
  check(await until5(() => (srv5.day('koseilyas', yIso5).attendance['Zeki Usta'] === 1 && !('Zeki' in srv5.day('koseilyas', yIso5).attendance))), 'yeni isimle saveDay gitti (eski adın hücresi temizlendi)');
  check(await until5(() => (srv5.roster().find((t) => t.name === 'Kalıp').members || []).includes('Zeki Usta') && !srv5.roster().some((t) => t.members.includes('Zeki'))), 'yeni isim sunucu listesinde, eski ad silindi');
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
      srv5.seedDay('gundogdu', day(1), { 'Mehmet': 1, 'Ahmet İthal': 0.5, 'Yabancı Kişi': 1 });
      srv5.seedDay('gundogdu', day(2), { 'Mehmet': 1 });
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
      srv5.seedDay('gundogdu', day(3), { 'Kalıp İki': 1, 'Demir Ali': 1 });
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
check(await p3.locator('#connBox').evaluate((e) => e.disabled), 'bağlantı alanları kilitli açılır');
check(!(await p3.locator('#setUrl').isEditable()), 'kilitliyken adres değiştirilemez');
await p3.click('#lockBtn');
await p3.fill('#setUrl', 'https://example.test/exec'); await p3.fill('#setKey', 'abc123');
check((await p3.textContent('#testResult')).includes('Kaydedildi'), 'yazınca Kaydedildi ✓ görünür');
await p3.click('#closeSettings');
await p3.reload();
await p3.waitForSelector('#picker', { state: 'hidden' });
await p3.click('#btnSettings');
check((await p3.inputValue('#setUrl')) === 'https://example.test/exec' && (await p3.inputValue('#setKey')) === 'abc123', 'Kapat sonrası yenileme: ayarlar duruyor');
check(await p3.locator('#connBox').evaluate((e) => e.disabled), 'yeniden açılınca tekrar kilitli');
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
    let reply = { ok: true, v: 3 };
    const roster9 = { ok: true, v: 3, teams: [{ id: 'e1', name: 'Ekip', hidden: false, updatedAt: 0 }], members: ['Ali', 'Veli'].map((n, i) => ({ id: 'm' + i, name: n, team: 'e1', updatedAt: 0 })) };
    if (body.action === 'getRoster2' || body.action === 'saveRoster2') reply = roster9;
    else if (body.action === 'getMeta') reply = { ok: true, v: 3, items: {} };
    else if (body.action === 'getDay') {
      const k = body.site + '|' + body.date;
      if (active9.has(k)) dup9++;
      active9.add(k);
      const snap = days9[k] || { attendance: {}, note: '' };
      await new Promise((r) => setTimeout(r, 800));
      active9.delete(k); log9.push(k);
      reply = { ok: true, v: 3, attendance: snap.attendance, note: snap.note, noteUpdatedAt: 0 };
    } else if (body.action === 'saveDay') { if (hold9) await new Promise((r) => setTimeout(r, 6000)); }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(reply) });
  });
  await p9.addInitScript(([url]) => {
    window.__syncIntervalMs = 600000; // bu testte canlı yenileme istek sayımını bozmasın
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
  check(await ali.evaluate((b) => b.classList.contains('full')), '2.9: gönderilmemiş yerel işaret (Ali) sunucu verisiyle ezilmedi');
  check(await p9.locator('#chips .chip[data-name="Veli"]').evaluate((b) => b.classList.contains('full')), '3.0: dokunulmayan kişide (Veli) diğer telefonun değişikliği geldi');
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

// ---- 3.0: iki telefon aynı anda (aynı Apps Script) ----
{
  const srvT = newSrv();
  srvT.seedRoster([{ name: 'Kalıpçı', hidden: false, members: ['Raskon', 'Sefa', 'Mehmet'] }, { name: 'Demirci', hidden: false, members: ['Can'] }]);
  const phone = async (label) => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await c.newPage();
    const ph = { c, p, errs: [], label, offline: false };
    p.on('pageerror', (e) => ph.errs.push('pageerror: ' + e.message));
    await p.route(GAS, async (route) => {
      if (ph.offline) return route.abort('failed');
      const body = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(srvT.reply(body)) });
    });
    await p.addInitScript(([url]) => {
      window.__syncIntervalMs = 1500; // canlı yenileme aralığı (test için kısa)
      if (!localStorage.getItem('sd_settings')) { localStorage.setItem('sd_settings', JSON.stringify({ url, key: 'K' })); localStorage.setItem('sd_site', JSON.stringify('gundogdu')); }
    }, [GAS]);
    await p.goto(base + 'index.html');
    await p.waitForSelector('#chips .chip[data-name="Raskon"]', { timeout: 10000 });
    return ph;
  };
  const A = await phone('A'), B = await phone('B');
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
  const syncNow = (ph) => ph.p.evaluate(() => document.getElementById('syncNow').click());
  const settled = (ph) => ph.p.waitForFunction(() => document.getElementById('pendingCount').textContent === '0', null, { timeout: 15000 });
  const T = await A.p.inputValue('#dateInput');
  const Ttr = T.split('-').reverse().join('.');
  const chip = (ph, n) => ph.p.locator(`#chips .chip[data-name="${n}"]`);
  const isFull = (ph, n) => chip(ph, n).evaluate((b) => b.classList.contains('full')).catch(() => false);

  // (1) Aynı gün, aynı şantiye: A Raskon'u, B Sefa'yı işaretler -> sunucuda ikisi de var
  await chip(A, 'Raskon').click(); await chip(B, 'Sefa').click();
  await Promise.all([syncNow(A), syncNow(B)]);
  await Promise.all([settled(A), settled(B)]);
  const att = srvT.day('gundogdu', T).attendance;
  check(att.Raskon === 1 && att.Sefa === 1, '3.0 iki telefon: sunucuda ikisinin işareti de var: ' + JSON.stringify(att));
  // canlı yenileme: diğer telefonun işareti bir yenileme turunda gelir (gün yeniden açılmadan)
  check(await until(() => isFull(B, 'Raskon'), 5000), '3.0 canlı yenileme: B, A\'nın işaretini (Raskon) gördü');
  check(await until(() => isFull(A, 'Sefa'), 5000), '3.0 canlı yenileme: A, B\'nin işaretini (Sefa) gördü');
  check(/^son eşitleme: (az önce|\d+ sn önce)$/.test(await B.p.textContent('#lastSync')) && await B.p.locator('#lastSync').isVisible(), 'son eşitleme ipucu: ' + await B.p.textContent('#lastSync'));
  // A Raskon'u kaldırır, B Sefa'yı yarım yapar (aynı anda): ikisi de doğru kalır
  // (B'nin hareketleri önce: A'nın değişikliği canlı gelip çipleri kaydırırsa uzun basış iptal olur)
  await chip(B, 'Sefa').click(); // Sefa boşalır
  await B.p.waitForTimeout(100);
  const bb = await chip(B, 'Sefa').boundingBox();
  await B.p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await B.p.mouse.down(); await B.p.waitForTimeout(600); await B.p.mouse.up();
  check(await chip(B, 'Sefa').evaluate((b) => b.classList.contains('half')), '3.0: B\'de Sefa yarım');
  await chip(A, 'Raskon').click();
  await Promise.all([syncNow(A), syncNow(B)]); await Promise.all([settled(A), settled(B)]);
  const att2 = srvT.day('gundogdu', T).attendance;
  check(!('Raskon' in att2) && att2.Sefa === 0.5, '3.0: silme ve yarım gün birbirini ezmedi: ' + JSON.stringify(att2));

  // (2) A bir ismi siler -> B yenileyince gider ve B onu geri getirmez
  await A.p.click('#btnSettings');
  const tsA = (name) => A.p.locator('#teamSettings .tset', { has: A.p.locator(`input[value="${name}"]`) });
  await tsA('Kalıpçı').locator('button[data-del="Mehmet"]').click();
  await tsA('Kalıpçı').locator('button[data-delyes="Mehmet"]').click();
  await A.p.click('#closeSettings');
  check(await until(() => !srvT.roster().some((t) => t.members.includes('Mehmet'))), '3.0: silme Drive\'a gitti');
  check(await until(async () => (await chip(B, 'Mehmet').count()) === 0, 6000), '3.0: B yenileyince silinen isim gitti');
  // B ekip listesinde başka değişiklik yapar (tam liste gönderseydi Mehmet geri gelirdi)
  const kalB = B.p.locator('#chips section.team', { has: B.p.locator('h3', { hasText: /^Kalıpçı$/ }) });
  await kalB.locator('form.teamadd input').fill('Yeni B'); await kalB.locator('form.teamadd button').click();
  await syncNow(B); await settled(B);
  check(await until(() => srvT.roster().some((t) => t.members.includes('Yeni B'))), '3.0: B\'nin eklediği isim gitti');
  await B.p.waitForTimeout(500);
  check(!srvT.roster().some((t) => t.members.includes('Mehmet')) && (await chip(B, 'Mehmet').count()) === 0, '3.0: B silinen ismi geri getirmedi');
  check(await until(async () => (await chip(A, 'Yeni B').count()) === 1, 6000), '3.0: A, B\'nin eklediği ismi gördü');

  // (3) B bir ekibin adını değiştirir -> A görür
  await B.p.click('#btnSettings');
  await B.p.locator('#teamSettings input[data-tname]').nth(1).fill('Demir Ekibi');
  const tnId = await B.p.locator('#teamSettings input[data-tname]').nth(1).getAttribute('data-tname');
  await B.p.locator(`#teamSettings button[data-trename="${tnId}"]`).click();
  await B.p.click('#closeSettings');
  const teamH = (ph, n) => ph.p.locator('#chips section.team[data-team] h3', { hasText: new RegExp('^' + n + '$') });
  check(await until(async () => (await teamH(A, 'Demir Ekibi').count()) === 1 && (await teamH(A, 'Demirci').count()) === 0, 8000), '3.0: B\'nin ekip adı değişikliği A\'da göründü');
  check(await until(async () => (await A.p.locator('#chips section.team', { has: A.p.locator('h3', { hasText: /^Demir Ekibi$/ }) }).locator('.chip[data-name="Can"]').count()) === 1), '3.0: üyeler yeni adlı ekipte');

  // (4) A'da şantiye bazında gizleme -> B'de de görünür (Drive: AYARLAR)
  await A.p.click('#btnSettings');
  const tsDem = A.p.locator('#teamSettings .tset', { has: A.p.locator('input[value="Demir Ekibi"]') });
  await tsDem.locator('button[data-sshide]').click(); await tsDem.locator('button[data-sshideyes]').click();
  await A.p.click('#closeSettings');
  check(await until(() => { const m = srvT.meta().sd_site_hide; return !!(m && (m.value.gundogdu || []).includes('Demir Ekibi')); }), '3.0: şantiye gizleme Drive\'a (AYARLAR) gitti');
  check(await until(async () => (await teamH(B, 'Demir Ekibi').count()) === 0, 8000), '3.0: A\'daki şantiye gizleme B\'de uygulandı');
  check(await B.p.evaluate(() => (JSON.parse(localStorage.getItem('sd_site_hide') || '{}').gundogdu || []).includes('Demir Ekibi')), '3.0: B\'nin telefondaki kopyası güncellendi');

  // (5) İki telefon aynı gün birer irsaliye fotoğrafı -> _1 ve _2
  const jpg = await A.p.evaluate(() => { const c = document.createElement('canvas'); c.width = 300; c.height = 200; const g = c.getContext('2d'); g.fillStyle = '#4a4'; g.fillRect(0, 0, 300, 200); return c.toDataURL('image/jpeg', 0.9).split(',')[1]; });
  for (const ph of [A, B]) {
    ph.offline = true; // ikisi de çevrimdışıyken çeker: telefondaki geçici ad ikisinde de _1
    await ph.p.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })); });
    const [fc] = await Promise.all([ph.p.waitForEvent('filechooser'), ph.p.click('#matBtn')]);
    await fc.setFiles({ name: 'i.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpg, 'base64') });
    await ph.p.waitForSelector('#photoGrid .photo .irs');
  }
  const localNames = async (ph) => ph.p.evaluate(() => new Promise((res) => { const r = indexedDB.open('santiye-defteri'); r.onsuccess = () => { const q = r.result.transaction('photos').objectStore('photos').getAll(); q.onsuccess = () => res(q.result.filter((p) => p.kind === 'irsaliye').map((p) => p.name)); }; }));
  check((await localNames(A))[0] === (await localNames(B))[0], '3.0: iki telefonda geçici irsaliye adı aynı: ' + (await localNames(A))[0]);
  A.offline = false; B.offline = false;
  await Promise.all([syncNow(A), syncNow(B)]); await Promise.all([settled(A), settled(B)]);
  const drv = srvT.photoNames('gundogdu', Ttr).sort();
  check(JSON.stringify(drv) === JSON.stringify([`İrsaliye_${Ttr}_1.jpg`, `İrsaliye_${Ttr}_2.jpg`]), "3.0: Drive'da irsaliye _1 ve _2: " + drv.join(', '));
  const both = [...(await localNames(A)), ...(await localNames(B))].sort();
  check(JSON.stringify(both) === JSON.stringify(drv), '3.0: telefonlardaki kayıt Drive adıyla güncellendi: ' + both.join(', '));
  const labels = [await A.p.textContent('#photoGrid .irs'), await B.p.textContent('#photoGrid .irs')].sort();
  check(JSON.stringify(labels) === JSON.stringify(['İrsaliye 1', 'İrsaliye 2']), '3.0: küçük resim etiketinde numara: ' + labels.join(', '));

  // (6) Not iki telefonda düzenlenir -> en yeni kazanır
  A.offline = true;
  await A.p.fill('#note', 'A notu (eski)');
  await A.p.waitForFunction(() => document.getElementById('noteState').textContent === 'Kaydedildi');
  await A.p.evaluate(() => document.getElementById('note').blur());
  await A.p.waitForTimeout(50);
  await B.p.fill('#note', 'B notu (yeni)');
  await B.p.waitForFunction(() => document.getElementById('noteState').textContent === 'Kaydedildi');
  await B.p.evaluate(() => document.getElementById('note').blur());
  await syncNow(B); await settled(B);
  A.offline = false; // A'nın eski notu şimdi gider; sunucu yok sayar
  await A.p.evaluate(() => document.getElementById('syncNow').click()); await settled(A);
  check(srvT.day('gundogdu', T).note === 'B notu (yeni)', '3.0 not: en yeni (B) kazandı: ' + srvT.day('gundogdu', T).note);
  check(await until(async () => (await A.p.inputValue('#note')) === 'B notu (yeni)', 6000), '3.0 not: A\'nın ekranı en yeni notu gösteriyor');
  await B.p.waitForTimeout(2000);
  check((await B.p.inputValue('#note')) === 'B notu (yeni)', '3.0 not: B kendi notunu koruyor');

  // (7) Canlı yenileme: A'nın değişikliği B'de (gün yeniden açılmadan) bir turda görünür
  check(!(await isFull(B, 'Raskon')), '3.0: B\'de Raskon boş');
  await chip(A, 'Raskon').click(); await syncNow(A); await settled(A);
  const t0 = Date.now();
  const seen = await until(() => isFull(B, 'Raskon'), 6000);
  check(seen, '3.0 canlı yenileme: A\'nın işareti B\'ye ' + (Date.now() - t0) + ' ms içinde geldi');
  check(A.errs.length === 0 && B.errs.length === 0, '3.0 iki telefon: sayfa hatası yok ' + [...A.errs, ...B.errs].join('|'));
  await A.c.close(); await B.c.close();
}

// ---- 3.1: sayıyla puantaj (İzolasyoncu) ----
{
  const srvC = newSrv();
  srvC.seedRoster([{ name: 'Kalıpçı', hidden: false, members: ['Raskon'] }, { name: 'İzolasyoncu', hidden: false, members: ['Ali', 'Veli'] }]);
  const sent = [];
  const phone = async (label) => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await c.newPage();
    const ph = { c, p, errs: [], label };
    p.on('pageerror', (e) => ph.errs.push('pageerror: ' + e.message));
    await p.route(GAS, async (route) => {
      const body = JSON.parse(route.request().postData() || '{}'); sent.push(body);
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(srvC.reply(body)) });
    });
    await p.addInitScript(([url]) => {
      window.__syncIntervalMs = 1500;
      if (!localStorage.getItem('sd_settings')) { localStorage.setItem('sd_settings', JSON.stringify({ url, key: 'K' })); localStorage.setItem('sd_site', JSON.stringify('gundogdu')); }
    }, [GAS]);
    await p.goto(base + 'index.html');
    await p.waitForSelector('#chips .chip[data-name="Raskon"]', { timeout: 10000 });
    return ph;
  };
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
  const syncNow = (ph) => ph.p.evaluate(() => document.getElementById('syncNow').click());
  const settled = (ph) => ph.p.waitForFunction(() => document.getElementById('pendingCount').textContent === '0', null, { timeout: 15000 });
  const nowD = new Date(), T = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
  const [ty, tm, td] = T.split('-').map(Number);
  const Y1 = new Date(Date.UTC(ty, tm - 1, td - 1)).toISOString().slice(0, 10);
  const CK = 'İzolasyoncu (kişi sayısı)';
  srvC.seedDay('gundogdu', Y1, { Raskon: 1, [CK]: 4 });
  const A = await phone('A');
  const secOf = (ph) => ph.p.locator('#chips section.team', { has: ph.p.locator('h3', { hasText: /^İzolasyoncu$/ }) });
  const num = async (ph) => (await secOf(ph).locator('.stepnum').textContent()).trim();
  check((await secOf(A).locator('.chip').count()) === 2, '3.1: varsayılan İsimle: ekipte 2 çip var');

  // Ayarlar > Ekipler: Sayıyla (üyeli ekip: iki adımlı onay)
  await A.p.click('#btnSettings');
  const tsA = A.p.locator('#teamSettings .tset', { has: A.p.locator('input[value="İzolasyoncu"]') });
  check((await tsA.locator('button[data-tmode][data-mode="isim"].on').count()) === 1, '3.1: Puantaj türü: İsimle seçili');
  await tsA.locator('button[data-tmode][data-mode="sayi"]').click();
  check((await tsA.locator('button[data-modeyes]').count()) === 1 && /Evet, sayıyla tut/.test(await tsA.locator('button[data-modeyes]').textContent()), '3.1: üyeli ekipte onay düğmesi çıktı');
  check(await A.p.evaluate(() => !(JSON.parse(localStorage.getItem('sd_team_mode') || '{}')['İzolasyoncu'])), '3.1: onaylanmadan mod değişmedi');
  await tsA.locator('button[data-modeno]').click();
  check((await tsA.locator('button[data-modeyes]').count()) === 0, '3.1: Vazgeç onayı kapattı');
  await tsA.locator('button[data-tmode][data-mode="sayi"]').click();
  await tsA.locator('button[data-modeyes]').click();
  check(await A.p.evaluate(() => JSON.parse(localStorage.getItem('sd_team_mode') || '{}')['İzolasyoncu'] === 'sayi'), '3.1: mod sayıyla kaydedildi');
  check((await tsA.locator('button[data-tmode][data-mode="sayi"].on').count()) === 1, '3.1: Sayıyla seçili göründü');
  check((await tsA.locator('details.tmembers .mrow').count()) === 2, '3.1: üyeler silinmedi (ayarlarda duruyor)');
  await A.p.click('#closeSettings'); await A.p.waitForTimeout(400);

  // Ana ekran: sayaç
  const S = secOf(A);
  check((await S.locator('.chip').count()) === 0 && (await S.locator('[data-all]').count()) === 0 && (await S.locator('input').count()) === 0, '3.1: sayıyla ekipte çip, "Hepsi geldi", isim kutusu yok');
  check((await S.locator('.tgl').count()) === 1 && (await S.locator('h3').textContent()) === 'İzolasyoncu', '3.1: başlık ve daralt düğmesi duruyor');
  const bm = await S.locator('[data-step="-1"]').boundingBox(), bp = await S.locator('[data-step="1"]').boundingBox();
  check(bm.width >= 56 && bm.height >= 56 && bp.width >= 56 && bp.height >= 56, '3.1: − / + düğmeleri en az 56 px: ' + Math.round(bm.width) + 'x' + Math.round(bm.height));
  check((await num(A)) === '0' && /^bugün 0 kişi$/.test((await S.locator('.team-count').textContent()).trim()), '3.1: başlangıç 0, hap: ' + (await S.locator('.team-count').textContent()));
  check(await S.locator('[data-step="-1"]').isDisabled(), '3.1: 0\'da − kapalı');

  // Dünküyle aynı: sayı da gelir
  check(await until(async () => A.p.evaluate((k) => new Promise((res) => { const r = indexedDB.open('santiye-defteri'); r.onsuccess = () => { const q = r.result.transaction('days').objectStore('days').get(k); q.onsuccess = () => res(!!q.result); }; }), 'gundogdu|' + Y1), 8000), '3.1: dünün kaydı önceden indirildi');
  await A.p.click('#copyYesterday'); await A.p.waitForTimeout(300);
  check((await num(A)) === '4', '3.1: Dünküyle aynı sayıyı (4) kopyaladı: ' + (await num(A)));
  check((await A.p.textContent('#toast')).includes('1 kişi işaretlendi'), '3.1: bildirim: ' + (await A.p.textContent('#toast')));

  // + + − ve yazarak
  await S.locator('[data-step="1"]').click(); await S.locator('[data-step="1"]').click();
  check((await num(A)) === '6', '3.1: + + sonrası 6');
  await S.locator('[data-step="-1"]').click();
  check((await num(A)) === '5', '3.1: − sonrası 5');
  await S.locator('.stepnum').click();
  const inp = S.locator('input.stepinput');
  check((await inp.count()) === 1 && (await inp.getAttribute('inputmode')) === 'numeric', '3.1: sayıya dokununca sayısal giriş kutusu açıldı');
  await inp.fill('37'); await inp.press('Enter');
  check((await S.locator('input').count()) === 0 && (await num(A)) === '37', '3.1: yazılan sayı (37) uygulandı');
  await S.locator('.stepnum').click(); await S.locator('input.stepinput').fill('1500'); await S.locator('input.stepinput').press('Enter');
  check(Number(await num(A)) <= 999, '3.1: en çok 3 hane: 1500 yazılınca ' + (await num(A)));
  await S.locator('.stepnum').click(); await S.locator('input.stepinput').fill('6'); await S.locator('input.stepinput').press('Enter');
  check((await num(A)) === '6' && /^bugün 6 kişi$/.test((await S.locator('.team-count').textContent()).trim()), '3.1: yazarak 6; hap: ' + (await S.locator('.team-count').textContent()));
  const sm0 = (await A.p.textContent('#summary')).trim();
  check(sm0 === 'Bugün: 1 kişi (1 gün) · İzolasyoncu: 6', '3.1: özet satırı (Dünküyle aynı ile gelen Raskon + sayı): ' + sm0);
  await A.p.locator('#chips .chip[data-name="Raskon"]').click();
  const sm = (await A.p.textContent('#summary')).trim();
  check(sm === 'Bugün: 0 kişi (0 gün) · İzolasyoncu: 6', '3.1: özet satırı sayıyı korur: ' + sm);
  // daralt
  await S.locator('.tgl').click(); await A.p.waitForTimeout(400);
  check(await S.locator('.tbody-in').evaluate((e) => e.hasAttribute('inert')), '3.1: daraltınca sayaç etkisiz (inert)');
  await S.locator('.tgl').click(); await A.p.waitForTimeout(400);

  // Drive'a gönderim
  await syncNow(A); await settled(A);
  const ch = sent.filter((b) => b.action === 'saveDay' && b.changes && b.changes[CK] !== undefined).pop();
  check(!!ch && ch.changes[CK] === 6, '3.1: saveDay changes içinde "' + CK + '": 6 → ' + JSON.stringify(ch && ch.changes));
  const sv = srvC.day('gundogdu', T).attendance;
  check(sv[CK] === 6, '3.1: Drive\'da sayı satırı 6: ' + JSON.stringify(sv));
  check(!!srvC.meta().sd_team_mode && srvC.meta().sd_team_mode.value['İzolasyoncu'] === 'sayi', '3.1: mod Drive\'a (AYARLAR sd_team_mode) gitti');

  // İkinci telefon: mod meta ile gelir, sayı canlı yenilemeyle
  const B = await phone('B');
  check(await until(async () => (await secOf(B).locator('.stepper').count()) === 1, 10000), '3.1: ikinci telefonda mod senkronlandı (sayaç göründü)');
  check(await until(async () => (await num(B)) === '6', 8000), '3.1: ikinci telefonda sayı 6');
  await secOf(B).locator('[data-step="1"]').click(); await syncNow(B); await settled(B);
  check(await until(async () => (await num(A)) === '7', 8000), '3.1: B\'deki + canlı yenilemeyle A\'ya geldi (7)');
  check(srvC.day('gundogdu', T).attendance[CK] === 7, '3.1: Drive\'da 7');

  // 0'a inince hücre temizlenir
  for (let i = 0; i < 7; i++) await secOf(A).locator('[data-step="-1"]').click();
  await syncNow(A); await settled(A);
  check(!(CK in srvC.day('gundogdu', T).attendance), '3.1: sayı 0 olunca Drive\'da satır boşaldı');
  for (let i = 0; i < 6; i++) await secOf(A).locator('[data-step="1"]').click();
  await syncNow(A); await settled(A);
  check(srvC.day('gundogdu', T).attendance[CK] === 6, '3.1: tekrar 6');

  // Excel
  {
    const XLDIR = '/tmp/claude-0/-home-user/dfd6405a-5f4c-5037-9513-cd07bd58f531/scratchpad/xl';
    const xlFile = XLDIR + '/node_modules/exceljs/dist/exceljs.min.js';
    if (!fs.existsSync(xlFile)) check(false, 'exceljs test dosyası yok: ' + xlFile);
    else {
      await A.p.route('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(xlFile) }));
      await A.p.click('#btnSettings');
      await A.p.selectOption('#xlSite', 'gundogdu');
      await A.p.fill('#xlMonth', T.slice(0, 7));
      const dl = A.p.waitForEvent('download', { timeout: 30000 });
      await A.p.click('#xlGo');
      const out = '/tmp/claude-0/-home-user/dfd6405a-5f4c-5037-9513-cd07bd58f531/scratchpad/sayi_puantaj.xlsx';
      await (await dl).saveAs(out);
      const ExcelJS = require(XLDIR + '/node_modules/exceljs');
      const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(out);
      const ws = wb.worksheets[0];
      let rr = 0, rRaskon = 0, rAli = 0; for (let r = 6; r < 40; r++) { const v = ws.getCell(r, 2).value; if (v === 'İZOLASYONCU (KİŞİ SAYISI)') rr = r; if (v === 'RASKON') rRaskon = r; if (v === 'ALİ') rAli = r; }
      check(rr > 0, 'Excel: "İZOLASYONCU (KİŞİ SAYISI)" satırı var (satır ' + rr + ')');
      check(rr > 0 && ws.getCell(rr, 4).value === 'İZOLASYONCU', 'Excel: görevi ekip adı');
      check(rr > 0 && ws.getCell(rr, 7 + td).value === 6, 'Excel: gün hücresi sayı (6): ' + (rr && ws.getCell(rr, 7 + td).value));
      const sameMonth = Y1.slice(0, 7) === T.slice(0, 7);
      const f = rr && ws.getCell(rr, 39).value;
      check(!!f && f.formula === `SUM(H${rr}:AL${rr})` && f.result === 6 + (sameMonth ? 4 : 0), 'Excel: AM toplamı: ' + JSON.stringify(f));
      check(rAli === 0, 'Excel: sayıyla ekibin gizli üyeleri (kaydı yok) satır açmadı');
      const argb = (r) => ws.getCell(r, 1).fill.fgColor.argb;
      check(rr > 0 && /^FF/.test(argb(rr)) && argb(rr) !== 'FFFFFFFF', 'Excel: ekip rengiyle boyalı: ' + (rr && argb(rr)));
      check(rr > 0 && rRaskon > 0 && rr > rRaskon, 'Excel: ekip sırası korundu (Kalıpçı sonra İzolasyoncu)');
      await A.p.click('#closeSettings');
    }
  }

  // İsimle'ye dönüş
  await A.p.click('#btnSettings');
  await tsA.locator('button[data-tmode][data-mode="isim"]').click();
  await A.p.click('#closeSettings'); await A.p.waitForTimeout(300);
  check((await secOf(A).locator('.chip').count()) === 2 && (await secOf(A).locator('.stepper').count()) === 0, '3.1: İsimle\'ye dönünce çipler geri geldi');
  check(A.errs.length === 0 && B.errs.length === 0, '3.1: sayfa hatası yok ' + [...A.errs, ...B.errs].join('|'));
  await A.c.close(); await B.c.close();
}

// 3.5: ekibi bugünlük gizle (şeride basılı tut)
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(() => { if (!localStorage.getItem('sd_site')) localStorage.setItem('sd_site', JSON.stringify('gundogdu')); });
  await p.goto(base + 'index.html');
  await p.waitForSelector('#chips', { state: 'attached' });
  await p.fill('#newTeam', 'Sıva'); await p.click('#addTeam');
  const sec = p.locator('#chips section.team', { has: p.locator('h3', { hasText: /^Sıva$/ }) });
  await sec.locator('form.teamadd input').fill('Kemal'); await sec.locator('form.teamadd button').click();
  const hold = async (ms = 650) => {
    const b = await sec.locator('.team-head h3').boundingBox();
    await p.mouse.move(b.x + 5, b.y + b.height / 2); await p.mouse.down(); await p.waitForTimeout(ms); await p.mouse.up();
  };
  await hold(); await p.waitForTimeout(350);
  check((await p.locator('.daypop').count()) === 1 && (await p.locator('.daypop .daypop-warn').count()) === 0, '3.5: basılı tutunca açılır pencere, kimse işaretli değilken uyarı yok');
  const pb = await p.locator('.daypop').boundingBox(), hb = await sec.locator('.team-head').boundingBox();
  check(pb.y >= hb.y + hb.height - 2 && pb.y < hb.y + hb.height + 20, '3.5: pencere şeridin hemen altında');
  await p.locator('.daypop [data-dpcancel]').click(); await p.waitForTimeout(400);
  check((await p.locator('.daypop').count()) === 0 && (await sec.count()) === 1, '3.5: İptal pencereyi kapatır, ekip durur');
  await sec.locator('.chip[data-name="Kemal"]').click();
  await hold(); await p.waitForTimeout(350);
  check(/Bu ekipte bugün 1 kişi işaretli\./.test(await p.locator('.daypop-warn').textContent()), '3.5: işaretli kişi varsa uyarı satırı');
  // pencere açıkken kaydırarak gün değişmez
  const d0 = await p.inputValue('#dateInput');
  const cdp = await ctx.newCDPSession(p); const sb = await p.locator('#summary').boundingBox(), sy = sb.y + sb.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: sy }] });
  for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 300 - 25 * i, y: sy + 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await p.waitForTimeout(600);
  check((await p.inputValue('#dateInput')) === d0, '3.5: pencere açıkken gün kaydırma yok sayılır');
  await p.mouse.click(200, 700); await p.waitForTimeout(400);
  check((await p.locator('.daypop').count()) === 0, '3.5: dışarı dokunmak kapatır');
  await hold(); await p.waitForTimeout(350);
  await p.locator('.daypop [data-dphide]').click(); await p.waitForTimeout(700);
  check((await sec.count()) === 0, '3.5: Bugünlük gizle ekibi kaldırır');
  check(/^1 ekip bugün gizli/.test((await p.locator('#dayHideNote').textContent()).trim()) && await p.locator('#dayHideNote #dayShow').isVisible(), '3.5: alt satır "1 ekip bugün gizli · Göster"');
  check(await p.evaluate(() => { const o = JSON.parse(localStorage.getItem('sd_day_hide') || '{}'); const k = Object.keys(o)[0] || ''; return k.endsWith('|gundogdu') && o[k][0] === 'Sıva'; }), '3.5: sd_day_hide kaydedildi');
  await p.reload(); await p.waitForSelector('#chips', { state: 'attached' }); await p.waitForTimeout(500);
  check((await p.locator('#chips section.team', { has: p.locator('h3', { hasText: /^Sıva$/ }) }).count()) === 0, '3.5: yenilemede hâlâ gizli');
  // diğer şantiye ve ertesi gün hâlâ görünür
  const other = p.locator('.tabs button').nth(1); await other.click(); await p.waitForTimeout(600);
  check((await p.locator('#chips section.team', { has: p.locator('h3', { hasText: /^Sıva$/ }) }).count()) === 1 && (await p.locator('#dayHideNote').isHidden()), '3.5: diğer şantiyede görünür');
  await p.locator('.tabs button').nth(0).click(); await p.waitForTimeout(600);
  await p.evaluate(() => document.getElementById('nextDay')?.click()); await p.waitForTimeout(700);
  const secN = p.locator('#chips section.team', { has: p.locator('h3', { hasText: /^Sıva$/ }) });
  check((await p.inputValue('#dateInput')) !== d0 && (await secN.count()) === 1, '3.5: ertesi gün ekip yine görünür');
  await p.evaluate(() => document.getElementById('prevDay')?.click()); await p.waitForTimeout(700);
  await p.locator('#dayShow').click(); await p.waitForTimeout(500);
  check((await secN.count()) === 1 && (await p.locator('#dayHideNote').isHidden()), '3.5: Göster ekibi geri getirir');
  check(errs.length === 0, '3.5: sayfa hatası yok ' + errs.join('|'));
  await ctx.close();
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
