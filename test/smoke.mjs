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
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

const received = [];
await page.route(GAS, async (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  received.push({ body, ct: route.request().headers()['content-type'] });
  await route.fulfill({ status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: true, fileId: 'F1' }) });
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
await page.click('#syncNow');
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
    q.onsuccess = () => res(q.result.map((p) => ({ blob: !!p.blob, thumb: !!p.thumb })));
  };
}));
check(blobLeft.length === 1 && !blobLeft[0].blob && blobLeft[0].thumb, 'büyük dosya silindi, küçük resim kaldı');
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
await page.click('#syncNow');
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
await tset('Kalıp').locator('summary').click();
await tset('Kalıp').locator('select[data-move="Deniz"]').selectOption({ label: 'Beton' });
await page.click('#closeSettings');
check((await teamSec('Beton').locator('.chip[data-name="Deniz"]').count()) === 1, 'isim Beton ekibine taşındı');
await page.click('#btnSettings');
await tset('Beton').locator('summary').click();
await tset('Beton').locator('button[data-del="Deniz"]').click();
check((await page.locator('#teamSettings button[data-delyes]').count()) === 1, 'silme için ikinci adım düğmesi çıktı');
await tset('Beton').locator('button[data-delyes="Deniz"]').click();
await page.click('#closeSettings');
check((await page.locator('#chips .chip[data-name="Deniz"]').count()) === 1, 'silinen ismin bugünkü kaydı "Listede olmayanlar"da görünür (veri kaybı yok)');
check(errors.length === 0, 'ekip akışında konsol hatası yok' + (errors.length ? ': ' + errors.join(' | ') : ''));

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

// Çevrimdışı: istekler iptal
await page.unroute(GAS);
await page.route(GAS, (route) => route.abort('failed'));
await page.fill('#note', 'Çevrimdışı not.');
await page.waitForFunction(() => document.getElementById('noteState').textContent === 'Kaydedildi');
await page.click('#syncNow');
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

// Ayar yoksa Türkçe uyarı
await page.unroute(GAS);
await page.evaluate(() => localStorage.setItem('sd_settings', '{}'));
await page.click('#syncNow');
await page.waitForFunction(() => /Ayarlar/.test(document.getElementById('syncError').textContent));
check(true, 'URL/anahtar yokken uyarı: ' + (await page.textContent('#syncError')).slice(0, 50) + '…');

await browser.close(); server.close();
console.log(failed ? `\n${failed} kontrol başarısız` : '\nTüm kontroller geçti');
process.exit(failed ? 1 : 0);
