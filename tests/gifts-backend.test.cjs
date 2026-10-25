const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'apps-script-write-api.gs'), 'utf8');

function setup(options = {}) {
  let locked = false, lockCount = 0, releaseCount = 0, recoveryCount = 0, failure = null;
  const mutations = [], sheets = [];
  class Sheet {
    constructor(name, rows = 20, columns = 34) { this.name = name; this.maxRows = rows; this.maxColumns = columns; this.cells = []; }
    raw(row, column) { return this.cells[row - 1]?.[column - 1] ?? ''; }
    set(row, column, value) { this.cells[row - 1] ||= []; this.cells[row - 1][column - 1] = value; }
    value(row, column) {
      const raw = this.raw(row, column);
      if (raw && typeof raw === 'object' && raw.financeFormula) {
        const giftCost = this.cells.slice(2).reduce((sum, cells) => sum + (typeof cells?.[27] === 'number' ? cells[27] : 0), 0);
        return column === 20 ? 100 + giftCost : column === 21 ? 1000 : 900 - giftCost;
      }
      if (raw && typeof raw === 'object' && 'formula' in raw) return raw.value;
      if (raw && typeof raw === 'object' && 'literal' in raw) return raw.literal;
      return raw;
    }
    store(row, column, value) {
      if (typeof value === 'string' && value.startsWith("'")) this.set(row, column, { literal: value.slice(1) });
      else if (typeof value === 'string' && value.startsWith('=')) this.set(row, column, { formula: value, value: '' });
      else this.set(row, column, value);
    }
    getRange(row, column, height = 1, width = 1) {
      if (typeof row === 'string') {
        const match = row.match(/^([A-Z]+)(\d+)$/);
        assert(match, 'supported A1 address');
        column = [...match[1]].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
        row = Number(match[2]);
      }
      assert(Number.isInteger(row) && row >= 1 && row + height - 1 <= this.maxRows, 'read/write within row capacity');
      assert(Number.isInteger(column) && column >= 1 && column + width - 1 <= this.maxColumns, 'read/write within column capacity');
      const sheet = this;
      return {
        getValue: () => sheet.value(row, column),
        getValues: () => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => sheet.value(row + i, column + j))),
        getFormulas: () => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => sheet.raw(row + i, column + j)?.formula || '')),
        setValues(values) {
          assert(locked, 'writes require script lock');
          mutations.push({ type: 'values', sheet: sheet.name, row, column, height, width, values });
          if (failure === 'before-write' || (failure === 'history-before-write' && sheet.name === 'RevenueHistory')) { failure = null; throw new Error('write failed'); }
          values.forEach((valuesRow, i) => valuesRow.forEach((value, j) => sheet.store(row + i, column + j, value)));
          if (failure === 'after-write' || (failure === 'history-after-write' && sheet.name === 'RevenueHistory')) { failure = null; throw new Error('response lost after write'); }
          return this;
        },
        setValue(value) { return this.setValues([[value]]); }
      };
    }
    getLastRow() { return this.cells.findLastIndex(row => row?.some(value => value !== '' && value !== null)) + 1; }
    getName() { return this.name; }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxColumns; }
    insertRowsAfter(after, count) { assert(locked); assert.equal(after, this.maxRows); mutations.push({ type: 'rows', after, count }); this.maxRows += count; }
    insertColumnsAfter(after, count) { assert(locked); assert.equal(after, this.maxColumns); mutations.push({ type: 'columns', after, count }); this.maxColumns += count; }
  }
  const products = new Sheet('Products', options.rows ?? 20, options.columns ?? 34);
  sheets.push(products);
  function addSheet(name, rows = 20, columns = 10) {
    const sheet = new Sheet(name, rows, columns);
    sheets.push(sheet);
    return sheet;
  }
  if (options.finance) {
    products.set(2, 20, { formula: '=100+SUM(AB3:AB)', financeFormula: true });
    products.set(2, 21, { formula: '=1000', financeFormula: true });
    products.set(2, 22, { formula: '=U2-T2', financeFormula: true });
  }
  if (options.history) {
    const history = addSheet('RevenueHistory');
    ['Date', 'Revenue', 'Profit', 'Expense'].forEach((header, i) => history.set(1, i + 1, header));
  }
  const ss = {
    getId: () => 'configured-sheet', getSheets: () => sheets,
    getSheetByName: name => sheets.find(sheet => sheet.name === name) || null,
    insertSheet() { throw new Error('gift APIs must not create a sheet'); }
  };
  const ctx = vm.createContext({
    console, Date,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      flush() {
        if (failure === 'flush' || (failure === 'history-flush' && mutations.at(-1)?.sheet === 'RevenueHistory')) {
          failure = null; throw new Error('flush response lost');
        }
      }
    },
    LockService: { getScriptLock: () => ({
      waitLock() { assert(!locked); locked = true; lockCount++; },
      releaseLock() { assert(locked); locked = false; releaseCount++; }
    }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) }
  });
  vm.runInContext(source, ctx);
  const originalRecovery = ctx.recoverDraftTransfers;
  ctx.recoverDraftTransfers = (...args) => { recoveryCount++; return originalRecovery(...args); };
  function api(action, extra = {}) {
    return JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({
      secret: 'snt', spreadsheetId: 'configured-sheet', sourceSheetName: '', action, ...extra
    }) } }).text);
  }
  function state() { const response = api('getGiftState'); assert.equal(response.ok, true, response.error); return response.result; }
  function nextPayload(extra = {}) { const current = state(); return { row: current.nextRow, version: current.nextVersion, cost: 25.5, customer: 'ลูกค้า', image: 'https://example.com/gift.jpg', ...extra }; }
  return { api, state, nextPayload, products, ctx, mutations, sheets, addSheet,
    fail(type) { failure = type; },
    get locked() { return locked; }, get lockCount() { return lockCount; },
    get releaseCount() { return releaseCount; }, get recoveryCount() { return recoveryCount; }
  };
}

test('lightweight count matches occupied gift rows without reading finance or history', () => {
  const s = setup();
  s.products.set(3, 28, 0);
  s.products.set(5, 29, 'customer');
  s.products.set(6, 30, 'image');
  s.products.set(7, 31, 'note');
  s.products.set(8, 28, { formula: '=IF(TRUE,"",1)', value: '' });
  s.products.set(9, 4, 'product only');
  const expected = s.state().items.length;
  s.ctx.readDraftFinance = () => { throw new Error('Count must not read finance'); };
  s.ctx.latestGiftFinanceSnapshot = () => { throw new Error('Count must not read history'); };
  const result = s.api('getGiftCount');
  assert.equal(result.ok, true);
  assert.equal(result.result.count, 5);
  assert.equal(result.result.count, expected);
  assert.deepEqual(Object.keys(result.result).sort(), ['count', 'observedAt', 'sourceSheetName', 'spreadsheetId']);
  assert.deepEqual(s.mutations, []);
  assert.equal(s.recoveryCount, 0);
  assert.equal(s.locked, false);
  assert.equal(s.api('getGiftCount', { spreadsheetId: 'wrong' }).ok, false);
  assert.equal(s.api('getGiftCount', { secret: 'wrong' }).ok, false);
});

test('lightweight count handles empty sheets and missing gift columns', () => {
  for (const columns of [20, 28, 30, 31]) {
    const s = setup({ columns });
    const result = s.api('getGiftCount');
    assert.equal(result.ok, true);
    assert.equal(result.result.count, 0);
    assert.deepEqual(s.mutations, []);
  }
});

test('empty gift state is read-only, scoped and locked without draft recovery', () => {
  const s = setup();
  const state = s.state();
  assert.deepEqual(state.items, []);
  assert.equal(state.spreadsheetId, 'configured-sheet');
  assert.equal(state.sourceSheetName, 'Products');
  assert.equal(state.notesSupported, true);
  assert.equal(state.nextRow, 3);
  assert.deepEqual(JSON.parse(state.nextVersion), [['', '', '', ''], ['', '', '', '']]);
  assert.match(state.observedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(s.recoveryCount, 0);
  assert.equal(s.lockCount, 1); assert.equal(s.releaseCount, 1); assert.equal(s.locked, false);
  assert.deepEqual(s.mutations, []);
});

test('reads every occupied AB:AD row, including zero, partial records and formula-empty cells', () => {
  const s = setup();
  s.products.set(3, 28, 0);
  s.products.set(5, 29, 'customer only');
  s.products.set(6, 30, 'https://example.com/only-image.jpg');
  s.products.set(7, 28, { formula: '=IF(A7="","",100)', value: '' });
  s.products.set(8, 28, 'invalid cost');
  s.products.set(9, 28, -3);
  s.products.set(10, 28, 1.111);
  s.products.set(11, 28, '100');
  const state = s.state();
  assert.deepEqual(state.items.map(item => item.row), [3, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(state.items[0].cost, 0);
  assert(state.items.slice(1).every(item => item.cost === null));
  assert.equal(state.items[3].readOnly, true);
  assert.equal(state.nextRow, 4);
  assert.equal(s.mutations.length, 0);
});

test('legacy saves write exactly AB:AD and preserve all headers, totals, product data and later columns', () => {
  const s = setup();
  for (let row = 1; row <= 4; row++) {
    for (let col = 1; col <= 34; col++) {
      if (row < 3 || col < 28 || col > 31) s.products.set(row, col, col === 7 ? { formula: `=F${row}-E${row}`, value: 12 } : `preserve-${row}-${col}`);
    }
  }
  const before = JSON.stringify(s.products.cells);
  const payload = s.nextPayload({ customer: '=HYPERLINK("https://example.com")' });
  const response = s.api('saveGift', payload);
  assert.equal(response.ok, true, response.error);
  assert.equal(response.result.savedRow, 3);
  assert.equal(response.result.items.length, 1);
  assert.equal(s.products.value(3, 28), 25.5);
  assert.equal(s.products.value(3, 29), payload.customer);
  assert.equal(s.products.value(3, 30), payload.image);
  assert.equal(s.products.getRange(3, 29, 1, 2).getFormulas()[0].join(''), '');
  const expected = JSON.parse(before);
  [28, 29, 30].forEach(col => { expected[2][col - 1] = s.products.raw(3, col); });
  assert.deepEqual(JSON.parse(JSON.stringify(s.products.cells)), expected);
  assert.deepEqual(s.mutations.map(({ type, row, column, height, width }) => ({ type, row, column, height, width })), [
    { type: 'values', row: 3, column: 28, height: 1, width: 3 }
  ]);
  assert.equal(s.sheets.length, 1); assert.equal(s.recoveryCount, 0); assert.equal(s.locked, false);
});

test('literal customer strings preserve leading zeroes, apostrophes and formula-like content', () => {
  for (const customer of ['00123', "'quote", '=SUM(A1:A9)', '+1+1', '12/10/2026']) {
    const s = setup();
    const result = s.api('saveGift', s.nextPayload({ customer }));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.items[0].customer, customer);
    assert.equal(s.products.getRange(3, 29).getFormulas()[0][0], '');
  }
});

test('validates spreadsheet and exact source name before any write or capacity changes', () => {
  for (const extra of [
    { spreadsheetId: 'other-sheet' }, { spreadsheetId: '' }, { spreadsheetId: null },
    { sourceSheetName: 'Other' }, { sourceSheetName: 'Products ' }, { sourceSheetName: null }
  ]) {
    for (const action of ['getGiftState', 'saveGift']) {
      const s = setup({ rows: 2, columns: 26 });
      const payload = s.nextPayload();
      const result = s.api(action, { ...payload, ...extra });
      assert.equal(result.ok, false);
      assert.deepEqual(s.mutations, []);
      assert.equal(s.locked, false);
    }
  }
  const s = setup();
  assert.equal(s.api('getGiftState', { sourceSheetName: 'Products' }).ok, true);
  assert.equal(s.api('saveGift', { ...s.nextPayload(), sourceSheetName: 'Products' }).ok, true);
});

test('authentication fails before reads, locks or writes', () => {
  const s = setup();
  for (const action of ['getGiftState', 'saveGift']) assert.equal(s.api(action, { secret: 'wrong' }).ok, false);
  assert.equal(s.lockCount, 0); assert.deepEqual(s.mutations, []);
});

test('rejects rows 1/2, non-integers and arbitrary unallocated rows without any mutation', () => {
  for (const row of [0, 1, 2, -1, 3.5, 4, 19, 999999999, '3', null]) {
    const s = setup({ rows: 2, columns: 26 });
    const response = s.api('saveGift', s.nextPayload({ row }));
    assert.equal(response.ok, false, `row ${row}`);
    assert.deepEqual(s.mutations, []);
    assert.equal(s.locked, false);
  }
});

test('rejects invalid costs and accepts zero and upper cost boundary', () => {
  for (const cost of [-1, 0.001, 1000000000.01, 1e10, '25', '', null, false, Infinity, NaN]) {
    const s = setup();
    const response = s.api('saveGift', s.nextPayload({ cost }));
    assert.equal(response.ok, false, `cost ${cost}`); assert.deepEqual(s.mutations, []);
  }
  for (const cost of [0, 0.01, 25.55, 1000000000]) {
    const s = setup();
    const result = s.api('saveGift', s.nextPayload({ cost, customer: '', image: '' }));
    assert.equal(result.ok, true, result.error); assert.equal(result.result.items[0].cost, cost);
  }
});

test('rejects malformed or unsafe image URLs and oversized or non-text customer fields', () => {
  for (const image of [
    'javascript:alert(1)', 'data:image/png;base64,abc', 'file:///tmp/a.png', '//example.com/a.png',
    'https://', 'https://user:password@example.com/a.png', 'https://user@example.com/a.png',
    'https://example.com\\evil.png', 'https://example.com/ white.png', 'https://example.com/%xx',
    'https://-bad.example/a.png', 'https://example..com/a.png', 'https://example.com:99999/a.png',
    'https://256.2.3.4/a.png', 'https://%65xample.com/a.png', 'https://example.com/"a.png',
    `https://example.com/${'a'.repeat(2000)}`, null, 2
  ]) {
    const s = setup();
    const result = s.api('saveGift', s.nextPayload({ image }));
    assert.equal(result.ok, false, `image ${image}`); assert.deepEqual(s.mutations, []);
  }
  for (const customer of ['a'.repeat(201), null, 42, {}]) {
    const s = setup();
    assert.equal(s.api('saveGift', s.nextPayload({ customer })).ok, false); assert.deepEqual(s.mutations, []);
  }
});

test('accepts optional image, HTTPS queries and safe HTTP image URLs', () => {
  for (const image of ['', ' https://cdn.example.com/gift%20photo.png?q=2#x ', 'http://127.0.0.1:8080/gift.png', 'https://example.com?q=2']) {
    const s = setup();
    const result = s.api('saveGift', s.nextPayload({ image, customer: 'a'.repeat(200) }));
    assert.equal(result.ok, true, result.error); assert.equal(result.result.items[0].image, image.trim());
  }
});

test('formula in any target cell is read-only, even when its result equals the requested value', () => {
  for (const col of [28, 29, 30]) {
    const s = setup();
    s.products.set(3, 28, 25.5); s.products.set(3, 29, 'ลูกค้า'); s.products.set(3, 30, 'https://example.com/gift.jpg');
    s.products.set(3, col, { formula: '=IF(TRUE,"","")', value: s.products.value(3, col) });
    const state = s.state();
    assert.equal(state.items[0].readOnly, true); assert.equal(state.nextRow, 4);
    const response = s.api('saveGift', { ...s.nextPayload(), row: 3, version: state.items[0].version });
    assert.equal(response.ok, false); assert.match(response.error, /สูตร/); assert.deepEqual(s.mutations, []);
  }
});

test('concurrent new clients cannot overwrite different data or silently allocate another row', () => {
  const s = setup();
  const first = s.nextPayload(), second = s.nextPayload({ cost: 40, customer: 'other' });
  assert.equal(first.row, second.row); assert.equal(first.version, second.version);
  assert.equal(s.api('saveGift', first).ok, true);
  const response = s.api('saveGift', second);
  assert.equal(response.ok, false); assert.match(response.error, /โหลดข้อมูลใหม่/);
  assert.equal(s.state().items.length, 1); assert.equal(s.products.value(3, 28), first.cost);
  assert.equal(s.mutations.length, 1); assert.equal(s.locked, false);
});

test('optimistic version detects edits to any cell and permits a deliberate latest-version edit', () => {
  for (const col of [28, 29, 30]) {
    const s = setup();
    s.api('saveGift', s.nextPayload());
    const initial = s.state().items[0];
    s.products.set(3, col, col === 28 ? 40 : 'changed');
    const stale = { ...initial, cost: 45, customer: 'new', image: '' };
    assert.equal(s.api('saveGift', stale).ok, false);
    const fresh = s.state().items[0];
    assert.notEqual(fresh.version, initial.version);
    const result = s.api('saveGift', { ...stale, version: fresh.version });
    assert.equal(result.ok, true, result.error); assert.equal(result.result.items[0].cost, 45);
  }
});

test('lost response after write or flush retries the same row as a no-op', () => {
  for (const failure of ['after-write', 'flush']) {
    const s = setup(), payload = s.nextPayload();
    s.fail(failure);
    assert.equal(s.api('saveGift', payload).ok, false);
    assert.equal(s.locked, false);
    const result = s.api('saveGift', payload);
    assert.equal(result.ok, true, result.error); assert.equal(result.result.savedRow, 3);
    assert.equal(result.result.items.length, 1); assert.equal(s.mutations.length, 1);
    assert.equal(s.lockCount, s.releaseCount);
  }
});

test('failure before write releases lock and the unchanged request can retry successfully', () => {
  const s = setup(), payload = s.nextPayload();
  s.fail('before-write');
  assert.equal(s.api('saveGift', payload).ok, false); assert.equal(s.locked, false);
  assert.equal(s.state().items.length, 0);
  assert.equal(s.api('saveGift', payload).ok, true); assert.equal(s.state().items.length, 1);
  assert.equal(s.lockCount, s.releaseCount);
});

test('missing row/column capacity is only appended for a valid save, never for reading', () => {
  for (const columns of [26, 28, 29]) {
    const s = setup({ rows: 2, columns });
    s.products.set(1, 1, 'header'); s.products.set(2, 20, { formula: '=SUM(E3:E)', value: 0 });
    const state = s.state(); assert.deepEqual(state.items, []); assert.deepEqual(s.mutations, []);
    const result = s.api('saveGift', { row: state.nextRow, version: state.nextVersion, cost: 0, customer: '', image: '' });
    assert.equal(result.ok, true, result.error);
    assert.equal(s.products.maxRows, 3); assert.equal(s.products.maxColumns, 30);
    assert.deepEqual(s.mutations.map(item => item.type), ['rows', 'columns', 'values']);
    assert.equal(s.products.raw(1, 1), 'header'); assert.equal(s.products.raw(2, 20).formula, '=SUM(E3:E)');
  }
});

test('partially available gift columns are read and formula-guarded before extending capacity', () => {
  const s = setup({ rows: 3, columns: 28 });
  s.products.set(3, 28, { formula: '=IF(A3="","",0)', value: '' });
  const state = s.state();
  assert.equal(state.items.length, 1); assert.equal(state.items[0].readOnly, true); assert.equal(state.nextRow, 4);
  assert.deepEqual(s.mutations, []);
  assert.equal(s.api('saveGift', { row: 3, version: state.items[0].version, cost: 5, customer: '', image: '' }).ok, false);
  assert.deepEqual(s.mutations, []);
});

test('unrelated ordinary product route still performs its original draft recovery and field update', () => {
  const s = setup();
  s.products.set(3, 1, 1);
  const result = s.api('updateProduct', { no: 1, fields: { E: 88 } });
  assert.equal(result.ok, true, result.error); assert.equal(s.products.value(3, 5), 88);
  assert.equal(s.recoveryCount, 1); assert.equal(s.locked, false);
});

function addActiveDraft(s, cost = 50, state = 'ACTIVE') {
  const draft = s.addSheet('ProductDrafts');
  [...s.ctx.DRAFT_HEADERS].forEach((header, i) => draft.set(1, i + 1, header));
  ['draft-00001', 'https://example.com/draft.jpg', cost, 1, state, '', 'created', 'updated', '', true]
    .forEach((value, i) => draft.set(2, i + 1, value));
  return draft;
}

test('gift reads return authoritative finance and latest history without snapshot writes or draft recovery', () => {
  const s = setup({ finance: true, history: true });
  const drafts = addActiveDraft(s, 50);
  const history = s.sheets.find(sheet => sheet.name === 'RevenueHistory');
  const date = '2026-09-01T00:00:00.000Z';
  [date, 1000, 875, 125].forEach((value, i) => history.set(2, i + 1, value));
  s.products.set(3, 28, 100);
  const result = s.state();
  assert.equal(result.finance.revenue, 1000);
  assert.equal(result.finance.expense, 250);
  assert.equal(result.finance.profit, 750);
  assert.equal(result.finance.draftCost, 50);
  assert.deepEqual(result.snapshot, { date, revenue: 1000, profit: 875, expense: 125 });
  assert.equal(result.financeWarning, undefined); assert.match(result.snapshotWarning, /ยอดล่าสุดยังไม่ถูกบันทึกในกราฟ/);
  assert.deepEqual(s.mutations, []); assert.equal(drafts.value(2, 10), true);
  assert.equal(s.recoveryCount, 0); assert.equal(s.locked, false);
});

test('gift add100/edit150 use T2/V2 once, preserve formulas/history and leave Draft flags unchanged', () => {
  const s = setup({ finance: true, history: true });
  const drafts = addActiveDraft(s, 50);
  const draftBefore = JSON.stringify(drafts.cells);
  const formulasBefore = s.products.getRange(2, 20, 1, 3).getFormulas();
  const history = s.sheets.find(sheet => sheet.name === 'RevenueHistory');
  const oldRow = ['2026-09-01T00:00:00.000Z', 1000, 850, 150];
  oldRow.forEach((value, i) => history.set(2, i + 1, value));
  const before = s.state().finance;
  const first = s.api('saveGift', s.nextPayload({ cost: 100 }));
  assert.equal(first.ok, true, first.error);
  assert.equal(first.result.finance.expense, before.expense + 100);
  assert.equal(first.result.finance.profit, before.profit - 100);
  assert.equal(first.result.finance.revenue, before.revenue);
  assert.equal(first.result.snapshot.expense, 250); assert.equal(first.result.snapshot.profit, 750);
  assert.equal(history.getLastRow(), 3);
  const current = first.result.items[0];
  const edit = s.api('saveGift', { ...current, cost: 150 });
  assert.equal(edit.ok, true, edit.error);
  assert.equal(edit.result.finance.expense, first.result.finance.expense + 50);
  assert.equal(edit.result.finance.profit, first.result.finance.profit - 50);
  assert.equal(edit.result.snapshot.expense, 300); assert.equal(edit.result.snapshot.profit, 700);
  assert.equal(history.getLastRow(), 4);
  assert.deepEqual(history.getRange(2, 1, 1, 4).getValues()[0], oldRow);
  assert.deepEqual(s.products.getRange(2, 20, 1, 3).getFormulas(), formulasBefore);
  assert.equal(JSON.stringify(drafts.cells), draftBefore);
  assert.equal(s.mutations.filter(item => item.sheet === 'ProductDrafts').length, 0);
  assert(s.mutations.every(item => item.sheet === 'RevenueHistory' || (item.sheet === 'Products' && item.column === 28 && [3, 4].includes(item.width))));
  assert.equal(s.recoveryCount, 0); assert.equal(s.locked, false);
});

test('zero-cost first gift records actual totals once; retries and metadata-only edits do not duplicate the graph', () => {
  const s = setup({ finance: true, history: true });
  const payload = s.nextPayload({ cost: 0 });
  const first = s.api('saveGift', payload);
  assert.equal(first.ok, true, first.error);
  assert.equal(first.result.finance.expense, 100); assert.equal(first.result.finance.profit, 900);
  assert.equal(first.result.snapshot.expense, 100);
  const history = s.sheets.find(sheet => sheet.name === 'RevenueHistory');
  assert.equal(history.getLastRow(), 2);
  const retry = s.api('saveGift', payload);
  assert.equal(retry.ok, true); assert.deepEqual(retry.result.snapshot, first.result.snapshot);
  assert.equal(history.getLastRow(), 2);
  const edit = s.api('saveGift', { ...first.result.items[0], customer: 'updated customer' });
  assert.equal(edit.ok, true); assert.equal(history.getLastRow(), 2);
  assert.equal(s.mutations.filter(item => item.sheet === 'RevenueHistory').length, 1);
});

test('a lost gift-write response retries once and records real finance only after the saved row is confirmed', () => {
  const s = setup({ finance: true, history: true });
  const payload = s.nextPayload({ cost: 100 });
  s.fail('after-write');
  assert.equal(s.api('saveGift', payload).ok, false);
  const retry = s.api('saveGift', payload);
  assert.equal(retry.ok, true, retry.error); assert.equal(retry.result.finance.expense, 200);
  assert.equal(retry.result.snapshot.expense, 200);
  assert.equal(s.mutations.filter(item => item.sheet === 'Products').length, 1);
  assert.equal(s.mutations.filter(item => item.sheet === 'RevenueHistory').length, 1);
  assert.equal(s.api('saveGift', payload).ok, true);
  assert.equal(s.mutations.filter(item => item.sheet === 'RevenueHistory').length, 1);
});

test('history write/flush failures warn after a successful gift save and retries deduplicate an already written point', () => {
  for (const failure of ['history-before-write', 'history-after-write', 'history-flush']) {
    const s = setup({ finance: true, history: true }), payload = s.nextPayload({ cost: 100 });
    s.fail(failure);
    const first = s.api('saveGift', payload);
    assert.equal(first.ok, true, first.error); assert.equal(first.result.savedRow, 3);
    assert.equal(first.result.items[0].cost, 100); assert.equal(first.result.finance.expense, 200);
    assert.match(first.result.snapshotWarning, /บันทึกของแถมแล้ว/);
    assert.equal(s.locked, false);
    const retry = s.api('saveGift', payload);
    assert.equal(retry.ok, true, retry.error); assert.equal(retry.result.snapshot.expense, 200);
    assert.equal(retry.result.snapshotWarning, undefined);
    const history = s.sheets.find(sheet => sheet.name === 'RevenueHistory');
    assert.equal(history.getLastRow(), 2);
    assert.equal(s.mutations.filter(item => item.sheet === 'Products').length, 1);
  }
});

test('missing source totals return finance warnings while still reading and saving gift records successfully', () => {
  for (const column of [20, 21, 22]) {
    const s = setup({ finance: true, history: true });
    s.products.set(2, column, { formula: '=BROKEN()', value: '#ERROR!' });
    const state = s.state();
    assert.equal(state.finance, null); assert.match(state.financeWarning, /อ่านยอดรวมร้านไม่สำเร็จ/);
    assert.deepEqual(s.mutations, []);
    const result = s.api('saveGift', s.nextPayload({ cost: 100 }));
    assert.equal(result.ok, true, result.error); assert.equal(result.result.savedRow, 3);
    assert.equal(result.result.finance, null); assert.match(result.result.financeWarning, /สูตร/);
    assert.match(result.result.snapshotWarning, /ยังไม่ได้บันทึกจุดกราฟ/);
    assert.equal(s.products.value(3, 28), 100);
    assert.equal(s.mutations.filter(item => item.sheet === 'RevenueHistory').length, 0);
    assert.equal(s.products.raw(2, column).formula, '=BROKEN()');
  }
});

test('missing or mismatched history schema warns without creating sheets, fixing headers or failing the gift save', () => {
  for (const kind of ['missing', 'wrong-header', 'missing-expense']) {
    const s = setup({ finance: true, history: kind !== 'missing' });
    const history = s.sheets.find(sheet => sheet.name === 'RevenueHistory');
    if (kind === 'wrong-header') history.set(1, 3, 'Something else');
    if (kind === 'missing-expense') history.set(1, 4, '');
    const originalHistory = history && JSON.stringify(history.cells);
    const state = s.state();
    assert.equal(state.finance.expense, 100); assert.equal(state.snapshot, null);
    assert.match(state.snapshotWarning, /RevenueHistory/); assert.deepEqual(s.mutations, []);
    const result = s.api('saveGift', s.nextPayload({ cost: 100 }));
    assert.equal(result.ok, true, result.error); assert.equal(result.result.savedRow, 3);
    assert.equal(result.result.finance.expense, 200); assert.equal(result.result.snapshot, null);
    assert.match(result.result.snapshotWarning, /บันทึกของแถมแล้ว/);
    assert.equal(s.sheets.length, kind === 'missing' ? 1 : 2);
    assert.equal(history && JSON.stringify(history.cells), originalHistory);
    assert.equal(s.mutations.filter(item => item.sheet === 'RevenueHistory').length, 0);
  }
});

test('pending Draft transfers block only finance/snapshot and are never recovered or rewritten by gift routes', () => {
  const s = setup({ finance: true, history: true });
  const drafts = addActiveDraft(s, 50, 'TRANSFERRING');
  const before = JSON.stringify(drafts.cells);
  const state = s.state();
  assert.equal(state.finance, null); assert.match(state.financeWarning, /ย้ายแบบร่างค้าง/);
  const result = s.api('saveGift', s.nextPayload({ cost: 100 }));
  assert.equal(result.ok, true, result.error); assert.equal(result.result.items[0].cost, 100);
  assert.equal(result.result.finance, null); assert.equal(result.result.snapshot, null);
  assert.equal(JSON.stringify(drafts.cells), before); assert.equal(s.recoveryCount, 0);
  assert.equal(s.mutations.filter(item => item.sheet !== 'Products').length, 0);
});

test('latest gift snapshot ignores invalid history rows and resolves equal timestamps to the later real row', () => {
  const s = setup({ finance: true, history: true });
  const history = s.sheets.find(sheet => sheet.name === 'RevenueHistory');
  const date = '2026-09-01T00:00:00.000Z';
  [[date, 1000, 900, 100], [date, 1000, 800, 200], ['not-a-date', 0, 0, 0], [date, '', 0, 0]]
    .forEach((row, i) => row.forEach((value, j) => history.set(i + 2, j + 1, value)));
  const state = s.state();
  assert.deepEqual(state.snapshot, { date, revenue: 1000, profit: 800, expense: 200 });
  assert.deepEqual(s.mutations, []);
  const result = s.api('saveGift', s.nextPayload({ cost: 100 }));
  assert.equal(result.ok, true, result.error); assert.equal(history.getLastRow(), 5);
  assert.equal(s.mutations.filter(item => item.sheet === 'RevenueHistory').length, 0);
});

test('read-only refresh retains a warning after failed graph save until a real matching snapshot exists', () => {
  const s = setup({ finance: true, history: true });
  const history = s.sheets.find(sheet => sheet.name === 'RevenueHistory');
  ['2026-09-01T00:00:00.000Z', 1000, 900, 100].forEach((value, i) => history.set(2, i + 1, value));
  const payload = s.nextPayload({ cost: 100 });
  s.fail('history-before-write');
  const saved = s.api('saveGift', payload);
  assert.equal(saved.ok, true); assert.match(saved.result.snapshotWarning, /บันทึกจุดกราฟไม่สำเร็จ/);
  const mutationsBeforeRead = s.mutations.length;
  const refreshed = s.state();
  assert.equal(refreshed.finance.expense, 200); assert.equal(refreshed.snapshot.expense, 100);
  assert.match(refreshed.snapshotWarning, /ยอดล่าสุดยังไม่ถูกบันทึกในกราฟ/);
  assert.equal(s.mutations.length, mutationsBeforeRead);
  // Simulate the existing logger later recording the actual totals.
  ['2026-09-02T00:00:00.000Z', 1000, 800, 200].forEach((value, i) => history.set(3, i + 1, value));
  const afterLogger = s.state();
  assert.equal(afterLogger.snapshot.expense, 200); assert.equal(afterLogger.snapshotWarning, undefined);
  assert.equal(s.mutations.length, mutationsBeforeRead);
});

test('empty valid history warns on read but a successful first save clears the warning', () => {
  const s = setup({ finance: true, history: true });
  const before = s.state();
  assert.equal(before.snapshot, null); assert.match(before.snapshotWarning, /ยอดล่าสุดยังไม่ถูกบันทึกในกราฟ/);
  assert.deepEqual(s.mutations, []);
  const saved = s.api('saveGift', s.nextPayload({ cost: 0 }));
  assert.equal(saved.ok, true); assert.equal(saved.result.snapshotWarning, undefined);
  assert.equal(s.state().snapshotWarning, undefined);
});

test('notes round-trip through AE with whitespace trimming, linebreaks, max length, editing and explicit clearing', () => {
  const s = setup();
  s.products.set(1, 31, 'existing note header'); s.products.set(2, 31, 'existing summary');
  s.products.set(3, 32, 'preserve AF');
  const first = s.api('saveGift', s.nextPayload({ note: 'ก'.repeat(500) }));
  assert.equal(first.ok, true, first.error); assert.equal(first.result.notesSupported, true);
  assert.equal(first.result.items[0].note, 'ก'.repeat(500));
  assert.equal(s.products.value(3, 31), 'ก'.repeat(500));
  assert.equal(s.mutations[0].column, 28); assert.equal(s.mutations[0].width, 4);
  const edited = s.api('saveGift', { ...first.result.items[0], note: '  แถมพร้อมแจกัน\nห่อแยกกัน  ' });
  assert.equal(edited.ok, true, edited.error); assert.equal(edited.result.items[0].note, 'แถมพร้อมแจกัน\nห่อแยกกัน');
  const cleared = s.api('saveGift', { ...edited.result.items[0], note: '' });
  assert.equal(cleared.ok, true, cleared.error); assert.equal(cleared.result.items[0].note, '');
  assert.equal(s.products.value(3, 31), '');
  assert.equal(s.products.value(1, 31), 'existing note header');
  assert.equal(s.products.value(2, 31), 'existing summary'); assert.equal(s.products.value(3, 32), 'preserve AF');
});

test('invalid note types or over500 characters are rejected before any write or capacity extension', () => {
  for (const note of [null, 12, false, {}, [], 'a'.repeat(501), ' '.repeat(501)]) {
    const s = setup({ rows: 2, columns: 26 });
    const result = s.api('saveGift', s.nextPayload({ note }));
    assert.equal(result.ok, false, `note ${JSON.stringify(note)}`); assert.match(result.error, /500/);
    assert.deepEqual(s.mutations, []); assert.equal(s.products.maxColumns, 26); assert.equal(s.products.maxRows, 2);
    assert.equal(s.locked, false);
  }
});

test('formula-looking and numeric-looking notes are stored as literal text, not formulas or numbers', () => {
  for (const note of ['=HYPERLINK("https://example.com")', '+1+1', '-10', '00123', "'quote", '12/10/2026']) {
    const s = setup();
    const result = s.api('saveGift', s.nextPayload({ note }));
    assert.equal(result.ok, true, result.error);
    assert.equal(s.products.value(3, 31), note); assert.equal(result.result.items[0].note, note);
    assert.equal(s.products.getRange(3, 31).getFormulas()[0][0], '');
  }
});

test('AE-only notes and empty-result formulas are occupied, returned and protected when allocating new gifts', () => {
  const s = setup();
  s.products.set(3, 31, 'existing note only');
  s.products.set(4, 31, { formula: '=IF(TRUE,"","")', value: '' });
  const state = s.state();
  assert.deepEqual(state.items.map(item => item.row), [3, 4]);
  assert.equal(state.items[0].note, 'existing note only'); assert.equal(state.items[0].cost, null);
  assert.equal(state.items[1].readOnly, true); assert.equal(state.items[1].note, '');
  assert.equal(state.nextRow, 5);
  const blocked = s.api('saveGift', { ...state.items[1], cost: 10, customer: '', image: '', note: 'try overwrite' });
  assert.equal(blocked.ok, false); assert.match(blocked.error, /สูตร/); assert.deepEqual(s.mutations, []);
  const saved = s.api('saveGift', s.nextPayload({ note: 'new note' }));
  assert.equal(saved.ok, true, saved.error); assert.equal(saved.result.savedRow, 5);
  assert.equal(s.products.value(3, 31), 'existing note only'); assert.equal(s.products.raw(4, 31).formula, '=IF(TRUE,"","")');
});

test('legacy missing-note payload preserves AE byte-for-byte and writes only AB:AD', () => {
  for (const stored of ['existing note', { literal: "'literal" }, 123, 'a'.repeat(600)]) {
    const s = setup();
    s.products.set(3, 28, 25); s.products.set(3, 29, 'old customer'); s.products.set(3, 31, stored);
    const current = s.state().items[0];
    const { note, ...legacyItem } = current;
    const beforeAE = JSON.stringify(s.products.raw(3, 31));
    const result = s.api('saveGift', { ...legacyItem, cost: 30, customer: 'new customer' });
    assert.equal(result.ok, true, result.error); assert.equal(result.result.items[0].cost, 30);
    assert.equal(JSON.stringify(s.products.raw(3, 31)), beforeAE);
    assert.equal(s.mutations.length, 1); assert.equal(s.mutations[0].width, 3);
  }
});

test('stale three-cell legacy versions reject changed writes safely but an identical retry remains a no-op', () => {
  const s = setup();
  const oldEmptyVersion = JSON.stringify([['', '', ''], ['', '', '']]);
  assert.equal(s.api('saveGift', { ...s.nextPayload({ note: 'new' }), version: oldEmptyVersion }).ok, false);
  assert.deepEqual(s.mutations, []);
  s.products.set(3, 28, 25); s.products.set(3, 29, 'customer'); s.products.set(3, 30, 'https://example.com/gift.jpg');
  s.products.set(3, 31, 'keep note');
  const legacyVersion = JSON.stringify([[25, 'customer', 'https://example.com/gift.jpg'], ['', '', '']]);
  const legacyPayload = { row: 3, version: legacyVersion, cost: 26, customer: 'customer', image: 'https://example.com/gift.jpg' };
  const blocked = s.api('saveGift', legacyPayload);
  assert.equal(blocked.ok, false); assert.match(blocked.error, /โหลดข้อมูลใหม่/); assert.deepEqual(s.mutations, []);
  const noOp = s.api('saveGift', { ...legacyPayload, cost: 25 });
  assert.equal(noOp.ok, true, noOp.error); assert.equal(noOp.result.items[0].note, 'keep note');
  assert.deepEqual(s.mutations, []);
});

test('concurrent note changes are covered by the four-cell optimistic version', () => {
  const s = setup();
  const first = s.api('saveGift', s.nextPayload({ note: 'initial' }));
  const original = first.result.items[0];
  const second = s.api('saveGift', { ...original, note: 'changed elsewhere' });
  assert.equal(second.ok, true, second.error); assert.notEqual(second.result.items[0].version, original.version);
  const stale = s.api('saveGift', { ...original, note: 'my change' });
  assert.equal(stale.ok, false); assert.match(stale.error, /โหลดข้อมูลใหม่/);
  assert.equal(s.products.value(3, 31), 'changed elsewhere');
  const { note, ...oldClientPayload } = original;
  assert.equal(s.api('saveGift', { ...oldClientPayload, cost: 99 }).ok, false);
  assert.equal(s.products.value(3, 28), original.cost);
});

test('lost-response retries retain the exact note and never create another gift or duplicate finance point', () => {
  const s = setup({ finance: true, history: true });
  const payload = s.nextPayload({ cost: 100, note: 'include this note' });
  s.fail('after-write');
  assert.equal(s.api('saveGift', payload).ok, false);
  const retry = s.api('saveGift', payload);
  assert.equal(retry.ok, true, retry.error); assert.equal(retry.result.items.length, 1);
  assert.equal(retry.result.items[0].note, payload.note); assert.equal(retry.result.finance.expense, 200);
  const history = s.sheets.find(sheet => sheet.name === 'RevenueHistory');
  assert.equal(history.getLastRow(), 2);
  assert.equal(s.api('saveGift', payload).ok, true); assert.equal(history.getLastRow(), 2);
  assert.equal(s.mutations.filter(item => item.sheet === 'Products').length, 1);
});

test('note-only edits preserve finance totals and do not append a redundant chart snapshot', () => {
  const s = setup({ finance: true, history: true });
  const first = s.api('saveGift', s.nextPayload({ cost: 100, note: 'before' }));
  const changed = s.api('saveGift', { ...first.result.items[0], note: 'after' });
  assert.equal(changed.ok, true, changed.error);
  assert.equal(changed.result.finance.expense, first.result.finance.expense);
  assert.equal(changed.result.finance.profit, first.result.finance.profit);
  assert.equal(changed.result.finance.revenue, first.result.finance.revenue);
  assert.deepEqual(changed.result.snapshot, first.result.snapshot);
  assert.equal(s.sheets.find(sheet => sheet.name === 'RevenueHistory').getLastRow(), 2);
  assert.equal(s.products.value(3, 31), 'after');
});

test('note-capable read pads absent AE without mutation; explicit note saves extend only required capacity', () => {
  const s = setup({ rows: 2, columns: 30 });
  const state = s.state();
  assert.equal(state.notesSupported, true); assert.deepEqual(JSON.parse(state.nextVersion), [['', '', '', ''], ['', '', '', '']]);
  assert.deepEqual(s.mutations, []); assert.equal(s.products.maxColumns, 30);
  const result = s.api('saveGift', { row: state.nextRow, version: state.nextVersion, cost: 0, customer: '', image: '', note: '' });
  assert.equal(result.ok, true, result.error); assert.equal(result.result.items[0].note, '');
  assert.equal(s.products.maxRows, 3); assert.equal(s.products.maxColumns, 31);
  assert.deepEqual(s.mutations.map(item => item.type), ['rows', 'columns', 'values']);
  assert.equal(s.mutations[1].after, 30); assert.equal(s.mutations[1].count, 1);
  assert.equal(s.mutations[2].width, 4);
});
