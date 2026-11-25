// Apps Script (apps-script/Code.gs) için bellekte çalışan sahte Google servisleri.
// Hem test/apps-script-harness.mjs hem test/smoke.mjs (sahte sunucu olarak gerçek Code.gs) kullanır.
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

export function createGas() {
  // ---------------------------------------------------------------- Sahte servisler
  let idSeq = 0;
  const nextId = (p) => p + (++idSeq);

  class FakeRange {
    constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
    getValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sheet.get(this.r + i, this.c + j)); out.push(row); }
      return out;
    }
    getValue() { return this.sheet.get(this.r, this.c); }
    setValues(v) {
      if (v.length !== this.nr || v.some((row) => row.length !== this.nc)) throw new Error(`setValues boyut uyuşmuyor: ${v.length}x${v[0] && v[0].length} != ${this.nr}x${this.nc}`);
      v.forEach((row, i) => row.forEach((x, j) => this.sheet.set(this.r + i, this.c + j, x)));
      return this;
    }
    setValue(x) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.set(this.r + i, this.c + j, x); return this; }
    setFormulas(v) { return this.setValues(v); }
    clearContent() { return this.setValue(''); }
    setFontWeight() { return this; } setBackground() { return this; } setNumberFormat() { return this; }
    setWrap() { return this; } setVerticalAlignment() { return this; }
  }
  class FakeSheet {
    constructor(name) { this.name = name; this.cells = new Map(); this.writes = 0; }
    key(r, c) { return r + ',' + c; }
    get(r, c) { const v = this.cells.get(this.key(r, c)); return v === undefined ? '' : v; }
    set(r, c, v) { this.writes++; if (v === '' || v === null || v === undefined) this.cells.delete(this.key(r, c)); else this.cells.set(this.key(r, c), v); }
    getLastRow() { let m = 0; for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(',')[0])); return m; }
    getLastColumn() { let m = 0; for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(',')[1])); return m; }
    getRange(r, c, nr = 1, nc = 1) {
      if (typeof r === 'string') return new FakeRange(this, 1, 1, 1, 1); // 'A:A' gibi (yalnız biçim)
      if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error(`geçersiz aralık ${r},${c},${nr},${nc}`);
      return new FakeRange(this, r, c, nr, nc);
    }
    getName() { return this.name; }
    setFrozenRows() {} setFrozenColumns() {} setColumnWidth() {}
    // test yardımcısı: satırları dizi olarak
    rows(nc) { const out = []; for (let r = 1; r <= this.getLastRow(); r++) { const row = []; for (let c = 1; c <= nc; c++) row.push(this.get(r, c)); out.push(row); } return out; }
  }
  class FakeSpreadsheet {
    constructor(name) { this.id = nextId('ss'); this.name = name; this.sheets = [new FakeSheet('Sayfa1')]; }
    getId() { return this.id; }
    getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
    insertSheet(n) { const s = new FakeSheet(n); this.sheets.push(s); return s; }
    getSheets() { return this.sheets.slice(); }
    deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
  }
  const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  class FakeFile {
    constructor(name, size, mime) { Object.assign(this, { id: nextId('f'), name, size, mime, desc: '', trashed: false }); }
    getId() { return this.id; } getName() { return this.name; } getSize() { return this.size; }
    getMimeType() { return this.mime; } isTrashed() { return this.trashed; }
    getDescription() { return this.desc; } setDescription(d) { this.desc = d; return this; }
    moveTo(folder) { folder.files.push(this); return this; }
    setName(n) { this.name = n; return this; }
    getParents() { return iter(this.parents || []); }
  }
  class FakeFolder {
    constructor(name) { Object.assign(this, { id: nextId('d'), name, files: [], folders: [] }); }
    getId() { return this.id; } getName() { return this.name; }
    getParents() { return iter(this.parents || []); }
    getFilesByName(n) { return iter(this.files.filter((f) => f.name === n)); }
    getFoldersByName(n) { return iter(this.folders.filter((f) => f.name === n)); }
    getFiles() { return iter(this.files.slice()); }
    createFolder(n) { const f = new FakeFolder(n); f.parents = [this]; this.folders.push(f); folders.set(f.id, f); return f; }
    createFile(blob) { const f = new FakeFile(blob.name, blob.bytes.length, blob.mime); f.parents = [this]; this.files.push(f); files.set(f.id, f); return f; }
  }
  const folders = new Map(), files = new Map(), spreadsheets = new Map();
  for (const id of ['1N93nP0SZE1Epzsmss7lhTc27rwNQiHPY', '1PnWIRJRoiC4DauFzMnSJqoCX0hXDUWZ9', '1atlqBgNzuRbUCiomprLghf27MluqsM-2']) {
    const f = new FakeFolder(id); f.id = id; folders.set(id, f);
  }
  let lockHeld = 0, lockMax = 0;
  const props = new Map([['API_KEY', 'K']]);
  const ctx = {
    console,
    Logger: { log() {} },
    MimeType: { GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, String(v)) }) },
    LockService: { getScriptLock: () => ({ waitLock() { lockHeld++; lockMax = Math.max(lockMax, lockHeld); }, releaseLock() { lockHeld--; } }) },
    Utilities: {
      getUuid: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, () => Math.floor(Math.random() * 16).toString(16)),
      base64Decode: (b) => [...Buffer.from(b, 'base64')],
      newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
      formatDate: (d, tz, fmt) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
        return fmt.replace('dd', p.day).replace('MM', p.month).replace('yyyy', p.year).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
      },
    },
    SpreadsheetApp: {
      openById: (id) => { const s = spreadsheets.get(id); if (!s) throw new Error('yok'); return s; },
      create: (name) => { const s = new FakeSpreadsheet(name); spreadsheets.set(s.id, s); const f = new FakeFile(name, 0, 'application/vnd.google-apps.spreadsheet'); f.id = s.id; files.set(s.id, f); return s; },
      flush() {},
    },
    DriveApp: {
      getFolderById: (id) => { const f = folders.get(id); if (!f) throw new Error('klasör yok ' + id); return f; },
      getFileById: (id) => { const f = files.get(id); if (!f) throw new Error('dosya yok ' + id); return f; },
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
  };
  vm.createContext(ctx);
  new vm.Script(SRC, { filename: 'Code.gs' }).runInContext(ctx); // sözdizimi denetimi de burada

  vm.createContext(ctx);
  new vm.Script(SRC, { filename: 'Code.gs' }).runInContext(ctx);
  const call = (body) => {
    const out = ctx.doPost({ postData: { contents: JSON.stringify({ key: 'K', ...body }) } });
    return JSON.parse(out.text);
  };
  const ssOf = (site) => spreadsheets.get(props.get(site === 'gundogdu' ? 'SHEET_ID_GUNDOGDU' : 'SHEET_ID_KOSEILYAS'));
  const sheet = (site, name) => ssOf(site).getSheetByName(name);


  return { ctx, call, ssOf, sheet, folders, files, spreadsheets, props, lock: () => ({ held: lockHeld, max: lockMax }) };
}
