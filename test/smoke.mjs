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

// İki isim ekle
for (const n of ['Ali Veli', 'Ayşe Yılmaz']) {
  await page.fill('#newName', n);
  await page.click('#addName');
}
check((await page.locator('.chip').count()) === 2, 'İki isim eklendi');

// Puantaj: biri Tam, biri Yarım
await page.click('.chip[data-name="Ali Veli"]');
await page.click('.chip[data-name="Ayşe Yılmaz"]');
await page.click('.chip[data-name="Ayşe Yılmaz"]');
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

// Ayar yoksa Türkçe uyarı
await page.unroute(GAS);
await page.evaluate(() => localStorage.setItem('sd_settings', '{}'));
await page.click('#syncNow');
await page.waitForFunction(() => /Ayarlar/.test(document.getElementById('syncError').textContent));
check(true, 'URL/anahtar yokken uyarı: ' + (await page.textContent('#syncError')).slice(0, 50) + '…');

await browser.close(); server.close();
console.log(failed ? `\n${failed} kontrol başarısız` : '\nTüm kontroller geçti');
process.exit(failed ? 1 : 0);
