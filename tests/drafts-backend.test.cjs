const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function setup() {
  let locked = false, fail = null;
  const sheets = [];
  class Sheet {
    constructor(name) { this.name = name; this.cells = []; this.maxRows = 100; }
    raw(r, c) { return this.cells[r - 1]?.[c - 1] ?? ''; }
    set(r, c, value) { this.cells[r - 1] ||= []; this.cells[r - 1][c - 1] = value; }
    store(r, c, value) {
      if (typeof value === 'string' && value.startsWith("'")) {
        this.set(r, c, { literal: value.slice(1) });
      } else if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) {
        this.set(r, c, Number(value));
      } else this.set(r, c, value);
    }
    value(r, c) {
      if (this.name === 'Products' && r === 2 && [20, 21, 22].includes(c)) {
        const cost = this.cells.slice(2).reduce((sum, row) => sum + (Number(row?.[4]) || 0), 0);
        return c === 20 ? 100 + cost : c === 21 ? 1000 : 900 - cost;
      }
      const v = this.raw(r, c);
      if (v && typeof v === 'object' && 'literal' in v) return v.literal;
      if (typeof v === 'string' && v.startsWith('=')) return c === 1 ? r - 2 : 0;
      return v;
    }
    getRange(r, c, nr = 1, nc = 1) {
      if (typeof r === 'string') {
        const [, letters, row] = r.match(/^([A-Z]+)(\d+)$/);
        c = [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0); r = Number(row);
      }
      const sheet = this;
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => sheet.value(r + i, c + j))),
        getFormulas: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => {
          const v = sheet.raw(r + i, c + j); return typeof v === 'string' && v.startsWith('=') ? v : '';
        })),
        getValue: () => sheet.value(r, c),
        setValue(value) { return this.setValues([[value]]); },
        setFormula(value) { return this.setValue(value); },
        setNumberFormat() { return this; },
        setValues(values) {
          assert(locked, 'all writes must hold shared lock');
          if (fail && fail(sheet, r, c, nr, nc, values)) { fail = null; throw new Error('simulated interrupted write'); }
          values.forEach((row, i) => row.forEach((value, j) => sheet.store(r + i, c + j, value)));
          return this;
        }
      };
    }
    getLastRow() { return Math.max(0, this.cells.findLastIndex(row => row?.some(v => v !== '' && v !== null)) + 1); }
    appendRow(values) { this.getRange(this.getLastRow() + 1, 1, 1, values.length).setValues([values]); }
    getMaxRows() { return this.maxRows; }
    insertRowsAfter(row, count) { this.maxRows += count; }
    getName() { return this.name; }
    setFrozenRows() {}
  }
  const ss = {
    getSheets: () => sheets, getId: () => 'test-sheet',
    getSheetByName: name => sheets.find(s => s.name === name) || null,
    insertSheet(name) { const sheet = new Sheet(name); sheets.push(sheet); return sheet; }
  };
  const products = ss.insertSheet('Products');
  products.set(1, 1, 'No.'); products.set(2, 20, 'formula T2'); products.set(2, 21, 'formula U2'); products.set(2, 22, 'formula V2');
  const ctx = vm.createContext({ console, Date, SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    LockService: { getScriptLock: () => ({ waitLock() { assert(!locked); locked = true; }, releaseLock() { assert(locked); locked = false; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'apps-script-write-api.gs'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'apps-script-revenue-logger.gs'), 'utf8'), ctx);
  const api = (action, data = {}) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ secret: 'snt', action, ...data }) } }).text);
  const save = (id = 'draft-0001', cost = 50, revision = 0) => api('saveDraft', { id, image: 'https://example.com/item.jpg', cost, revision });
  return { api, save, ss, products, ctx, inject(fn) { fail = fn; }, get locked() { return locked; } };
}

let s = setup();
let response = s.save(); assert.equal(response.ok, true);
assert.equal(response.result.finance.expense, 150); assert.equal(response.result.finance.profit, 850);
assert.equal(response.result.snapshot.expense, 150); assert.equal(response.result.spreadsheetId, 'test-sheet');
assert.equal(response.result.sourceSheetName, 'Products');
assert.equal(s.ss.getSheetByName('RevenueHistory').getLastRow(), 2);
assert.equal(s.save().ok, true); assert.equal(s.ss.getSheetByName('RevenueHistory').getLastRow(), 2);
assert.equal(s.save('draft-0001', 60, 0).ok, false); // stale, different payload
assert.equal(s.save('draft-0001', 60, 1).result.finance.expense, 160);
assert.equal(s.save('zero-00001', 0).ok, true);
for (const cost of [-1, 0.001, 1e10, '50', null]) assert.equal(s.save('bad-00001', cost).ok, false);
assert.equal(s.api('saveDraft', { id: 'bad-00001', revision: 0, cost: 1, image: 'javascript:alert(1)' }).ok, false);
response = s.api('addProduct', { draftId: 'draft-0001', draftRevision: 2, fields: { P: 'https://wrong.test/x', E: 1, F: '250.50', C: 'No.999 Vase' } });
assert.equal(response.ok, true); assert.equal(response.result.no, 1); assert.equal(response.result.finance.expense, 160);
assert.equal(response.result.finance.profit, 840); assert.equal(s.products.raw(3, 5), 60);
assert.equal(s.products.value(3, 16), 'https://example.com/item.jpg'); assert.equal(s.products.value(3, 3), 'No.1 Vase');
assert.equal(s.products.raw(3, 6), 250.5);
assert.equal(s.api('addProduct', { draftId: 'draft-0001', draftRevision: 2 }).result.no, 1);
assert.equal(s.products.getLastRow(), 3); assert.equal(s.products.raw(2, 20), 'formula T2');
assert.equal(s.api('deleteDraft', { id: 'zero-00001', revision: 1 }).ok, true);
assert.equal(s.api('deleteDraft', { id: 'zero-00001', revision: 1 }).ok, true);
assert.equal(s.api('deleteDraft', { id: 'draft-0001', revision: 2 }).ok, false);
assert.equal(s.ctx.logWeeklyRevenue().expense, 160); assert.equal(s.locked, false);

// Never reuse an existing incomplete or zero-cost product, including B/D/M/N.
s = setup(); s.products.set(3, 3, 'Existing unfinished'); s.products.set(4, 5, 0); s.products.set(5, 2, 'Protected existing data');
s.save(); response = s.api('addProduct', { draftId: 'draft-0001', draftRevision: 1, fields: { C: 'No.90 New' } });
assert.equal(response.result.no, 4); assert.equal(s.products.raw(3, 3), 'Existing unfinished'); assert.equal(s.products.raw(5, 2), 'Protected existing data');

// Product range write fails midway. Read/retry recovers the reserved same row.
s = setup(); s.save();
s.inject((sheet, row, col, nr, nc, values) => {
  if (sheet.name !== 'Products' || row !== 3) return false;
  values[0].slice(0, 6).forEach((value, i) => sheet.store(row, i + 1, value)); return true;
});
assert.equal(s.api('addProduct', { draftId: 'draft-0001', draftRevision: 1, fields: { C: 'No.1 Recovery' } }).ok, false);
response = s.api('getDraftState'); assert.equal(response.ok, true); assert.equal(response.result.finance.expense, 150);
assert.equal(response.result.drafts.length, 0); assert.equal(response.result.snapshot.expense, 150);
assert.equal(s.api('addProduct', { draftId: 'draft-0001', draftRevision: 1 }).result.no, 1); assert.equal(s.products.getLastRow(), 3);

// Literal-looking numbers, dates, apostrophes and formulas remain plain text.
for (const text of ['00123', '12/10/2026', '=HYPERLINK("https://example.com")', "'quote"]) {
  s = setup(); s.save();
  response = s.api('addProduct', { draftId: 'draft-0001', draftRevision: 1, fields: { C: text, K: text, F: '200' } });
  assert.equal(response.ok, true); assert.equal(s.products.value(3, 3), text);
  assert.equal(s.products.getRange(3, 3).getFormulas()[0][0], '');
}

// Finalize write is applied but the response is lost. Retry sees a tombstone,
// not a fresh item, and pending history is completed once.
s = setup(); s.save();
s.inject((sheet, row, col, nr, nc, values) => {
  if (sheet.name !== 'ProductDrafts' || row !== 2 || values[0][4] !== "'CONVERTED") return false;
  values[0].forEach((value, i) => sheet.store(row, i + 1, value)); return true;
});
assert.equal(s.api('addProduct', { draftId: 'draft-0001', draftRevision: 1 }).ok, false);
response = s.api('addProduct', { draftId: 'draft-0001', draftRevision: 1 });
assert.equal(response.result.no, 1); assert.equal(response.result.finance.expense, 150);
assert.equal(response.result.snapshot.expense, 150); assert.equal(s.products.getLastRow(), 3);

// Failure after journal but before product write: foreign data prevents replay.
s = setup(); s.save(); s.inject((sheet, row) => sheet.name === 'Products' && row === 3);
assert.equal(s.api('addProduct', { draftId: 'draft-0001', draftRevision: 1 }).ok, false);
s.products.set(3, 3, 'Someone else');
assert.equal(s.api('getDraftState').ok, false); assert.equal(s.products.raw(3, 3), 'Someone else');
assert.throws(() => s.ctx.logWeeklyRevenue(), /ขัดแย้ง/); assert.equal(s.locked, false);

// Snapshot failures do not turn successful ledger writes into failed saves.
s = setup(); s.inject((sheet, row) => sheet.name === 'RevenueHistory' && row === 2);
response = s.save(); assert.equal(response.ok, true); assert.match(response.result.warning, /บันทึกรายการแล้ว/);
assert.equal(response.result.snapshot, null);
response = s.api('getDraftState'); assert.equal(response.result.snapshot.expense, 150);

// A lost response during draft write still leaves a durable pending snapshot.
s = setup(); s.inject((sheet, row, col, nr, nc, values) => {
  if (sheet.name !== 'ProductDrafts' || row !== 2) return false;
  values[0].forEach((value, i) => sheet.store(row, i + 1, value)); return true;
});
assert.equal(s.save().ok, false); response = s.save(); assert.equal(response.ok, true);
assert.equal(response.result.drafts.length, 1); assert.equal(response.result.snapshot.expense, 150);

// Preserve old history and reject unrelated D contents without overwriting.
s = setup(); const old = s.ss.insertSheet('RevenueHistory');
['Date', 'Revenue', 'Profit'].forEach((v, i) => old.set(1, i + 1, v));
old.set(2, 1, new Date('2026-09-01T00:00:00Z')); old.set(2, 2, 800); old.set(2, 3, 700);
assert.equal(s.save().ok, true); assert.equal(old.raw(1, 4), 'Expense'); assert.equal(old.raw(2, 4), '');
assert.equal(old.raw(2, 2), 800); assert.equal(old.getLastRow(), 3);
s = setup(); const occupied = s.ss.insertSheet('ProductDrafts'); occupied.set(1, 1, 'Unrelated');
assert.equal(s.save().ok, false); assert.equal(occupied.raw(1, 1), 'Unrelated');
console.log('Draft backend tests passed: totals, conversion, recovery, retries, schema protection and history.');
