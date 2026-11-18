// Yayın öncesi: kritik dosyalar boş ya da bozuk olmasın
import { readFileSync } from 'node:fs';
const need = { 'sw.js': ['CACHE', "addEventListener('fetch'"], 'app.js': ['openCamera'], 'index.html': ['app.js'], 'surum.js': ['SURUMLER'], 'app.css': ['.chip'], 'apps-script/Code.gs': ['saveRoster2', 'function uploadPhoto_'] };
let bad = 0;
for (const [f, keys] of Object.entries(need)) {
  const s = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  for (const k of keys) if (!s.includes(k)) { console.log('KALDI', f, 'içinde yok:', k); bad++; }
  if (s.length < 200) { console.log('KALDI', f, 'çok kısa:', s.length); bad++; }
}
console.log(bad ? bad + ' dosya kontrolü başarısız' : 'Dosya kontrolü geçti'); process.exit(bad ? 1 : 0);
