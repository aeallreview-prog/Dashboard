'use strict';

// View-only profit percentages: no spreadsheet, backend, browser, or network writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const standalone = fs.readFileSync(path.join(root, 'seek-n-tique-dashboard.html'), 'utf8');

function extractFunction(text, name) {
  const match = new RegExp(`function ${name}\\(`).exec(text);
  assert.ok(match, `Missing production function: ${name}`);
  for (let end = text.indexOf('\n}', match.index); end >= 0; end = text.indexOf('\n}', end + 2)) {
    const candidate = text.slice(match.index, end + 2);
    try { new vm.Script(`(${candidate})`); return candidate; } catch {}
  }
  throw new Error(`Cannot extract function: ${name}`);
}

function columnConstants(text) {
  const start = text.indexOf('const COLUMN_LABEL_OVERRIDES =');
  const end = text.indexOf('function headerLabel(', start);
  assert.ok(start >= 0 && end > start);
  return text.slice(start, end).trim();
}

function makeHarness(text = source) {
  const head = { innerHTML: '' };
  const context = vm.createContext({
    document: { getElementById: () => head },
    lastHeaders: Array(16).fill('original header'),
    detailCopyTexts: [],
    buildQuickStatusSelect: () => '<select></select>',
    fetch() { throw new Error('Display formatting must not fetch data'); },
    callWriteApi() { throw new Error('Display formatting must not write to the sheet'); },
  });
  const run = code => vm.runInContext(code, context);
  for (const name of ['colToIndex', 'indexToCol', 'cellText', 'escapeHtml']) run(extractFunction(text, name));
  run(columnConstants(text));
  run(`let hideSensitiveData = false; let productSortFieldVal = 'L'; let productSortDirectionVal = 'desc'; const expandedProductRows = new Set();`);
  for (const name of ['SENSITIVE_COLS', 'PRODUCT_SORT_COLS']) {
    const declaration = text.match(new RegExp(`const ${name} = [^;]+;`));
    assert.ok(declaration, `Missing production constant: ${name}`);
    run(declaration[0]);
  }
  for (const name of [
    'headerLabel', 'getProductSortValue', 'getProductProfitPercent', 'formatProductProfitPercent', 'getProductDisplayText',
    'looksLikeImageUrl', 'resolveImageUrl', 'registerDetailCopyText', 'getVisibleCols',
    'renderSearchResult', 'renderProductTableRow', 'renderProductTableHead',
  ]) run(extractFunction(text, name));
  return {
    context, run, head,
    percent(row) { context.row = row; return run('getProductProfitPercent(row)'); },
    format(row) { context.row = row; return run('formatProductProfitPercent(row)'); },
    display(row, column) { context.row = row; return run(`getProductDisplayText(row, colToIndex('${column}'))`); },
    table(row) { context.row = row; return run('renderProductTableRow(row)'); },
    search(row) { context.row = row; return run('renderSearchResult(row)'); },
  };
}

function product(values = {}) {
  const c = Array(16).fill(null);
  c[0] = { v: '001' };
  c[2] = { v: 'เก้าอี้ไม้' };
  c[14] = { v: 'ลงขายแล้ว' };
  for (const [column, value] of Object.entries(values)) {
    c[column.charCodeAt(0) - 65] = value === null || typeof value === 'object'
      ? value : { v: value, f: String(value) };
  }
  return { c };
}

test('G displays profit as a percentage of E cost using H actual sale, including a loss or break-even', () => {
  const h = makeHarness();
  for (const [cost, sale, expected] of [
    [100, 150, '50%'], [100, 50, '-50%'], [100, 100, '0%'],
    [200, 600, '200%'], [25, 500, '1,900%'],
  ]) {
    const row = product({ E: cost, H: sale });
    assert.equal(h.format(row), expected);
    assert.equal(h.display(row, 'G'), expected);
  }
});

test('percentage rounds to at most two decimals and does not display negative zero', () => {
  const h = makeHarness();
  for (const [cost, sale, expected] of [
    [3, 4, '33.33%'], [3, 2, '-33.33%'], [100, 110.5, '10.5%'],
    [100, 99.999, '0%'], [100, 100.001, '0%'], [100, 99.99, '-0.01%'],
  ]) assert.equal(h.format(product({ E: cost, H: sale })), expected);
});

test('the shared numeric percentage remains unrounded for sorting while the display rounds it', () => {
  const h = makeHarness();
  const lower = product({ E: 100, H: 150.001 });
  const higher = product({ E: 100, H: 150.004 });
  assert.equal(h.format(lower), '50%');
  assert.equal(h.format(higher), '50%');
  assert.ok(h.percent(lower) < h.percent(higher));
  assert.equal(h.percent(product({ E: 100, H: 100 })), 0);
  assert.equal(h.percent(product({ E: 100, H: 50 })), -50);
});

test('missing, invalid, nonpositive, and nonfinite cost or actual sale show an em dash', () => {
  const h = makeHarness();
  const invalid = [null, { v: null }, { v: '' }, { v: ' ' }, { v: 0 }, { v: -1 },
    { v: '#DIV/0!' }, { v: '#N/A', f: '200' }, { v: 'รอ 500' },
    { v: NaN }, { v: Infinity }, { v: -Infinity }];
  for (const cell of invalid) {
    assert.equal(h.format(product({ E: cell, H: 150 })), '—', `Invalid cost: ${JSON.stringify(cell)}`);
    assert.equal(h.format(product({ E: 100, H: cell })), '—', `Invalid sale: ${JSON.stringify(cell)}`);
    assert.equal(h.percent(product({ E: cell, H: 150 })), null, `Unavailable cost produces null for sorting: ${JSON.stringify(cell)}`);
    assert.equal(h.percent(product({ E: 100, H: cell })), null, `Unavailable sale produces null for sorting: ${JSON.stringify(cell)}`);
  }
  assert.equal(h.format({}), '—');
  assert.equal(h.format(product({ E: Number.MIN_VALUE, H: Number.MAX_VALUE })), '—');
  assert.equal(h.percent(product({ E: Number.MIN_VALUE, H: Number.MAX_VALUE })), null);
});

test('numeric source values take precedence over formatted values and currency text is parsed strictly', () => {
  const h = makeHarness();
  assert.equal(h.format(product({ E: { v: 100, f: '999' }, H: { v: 150, f: '100' } })), '50%');
  assert.equal(h.format(product({ E: { v: '฿ 1,200.50' }, H: { v: '1,800.75 บาท' } })), '50%');
  assert.equal(h.format(product({ E: { v: null, f: '100 บาท' }, H: { f: '฿150' } })), '50%');
  assert.equal(h.format(product({ E: 100, H: { v: 0, f: '150' } })), '—');
});

test('the percentage ignores existing G, asking price F, net profit L, and shipping amounts', () => {
  const h = makeHarness();
  const row = product({ E: 100, H: 150, F: 800, G: 987654, I: 40, J: 30, L: 777 });
  assert.equal(h.format(row), '50%');
  assert.equal(h.display(row, 'F'), '800');
  assert.equal(h.display(row, 'L'), '777');
  assert.equal(h.run("headerLabel(colToIndex('G'))"), 'กำไร (%)');
  assert.equal(h.run("headerLabel(colToIndex('L'))"), 'กำไรของ');
});

test('formatting and rendering leave all original cells untouched', () => {
  const h = makeHarness();
  const row = product({ E: 100, H: 150, G: 987654, L: 777 });
  const original = JSON.stringify(row);
  for (const cell of row.c) if (cell) Object.freeze(cell);
  Object.freeze(row.c);
  Object.freeze(row);
  h.format(row);
  h.table(row);
  h.search(row);
  assert.equal(JSON.stringify(row), original);
  assert.equal(row.c[6].v, 987654);
});

test('table, search, and expanded detail all display the new G percentage while keeping L money', () => {
  const h = makeHarness();
  const row = product({ E: 100, F: 800, G: 987654, H: 150, L: 777 });
  const table = h.table(row);
  assert.match(table, /<td>50%<\/td>/);
  assert.match(table, /<td>777<\/td>/);
  assert.doesNotMatch(table, /987654/);
  const search = h.search(row);
  assert.match(search, /<p>กำไร \(%\)<\/p><strong>50%<\/strong>/);
  assert.match(search, /<p>กำไรของ<\/p><strong>777<\/strong>/);
  assert.doesNotMatch(search, /987654/);
  h.run("expandedProductRows.add('001')");
  const expanded = h.table(row);
  assert.match(expanded, /product-row-expanded/);
  assert.match(expanded, /<p>กำไร \(%\)<\/p><strong>50%<\/strong>/);
  assert.match(expanded, /<p>กำไรของ<\/p><strong>777<\/strong>/);
});

test('unsold products show an em dash in G instead of the old G value or a misleading loss', () => {
  const h = makeHarness();
  const row = product({ E: 100, F: 150, G: 50, H: 0 });
  assert.match(h.table(row), /<td>—<\/td>/);
  assert.match(h.search(row), /<p>กำไร \(%\)<\/p><strong>—<\/strong>/);
  assert.doesNotMatch(h.table(row), /-100%/);
});

test('sensitive data stays hidden and each profit sort marks only its own column', () => {
  const h = makeHarness();
  const row = product({ E: 100, G: 987654, H: 150, L: 777 });
  h.run('renderProductTableHead()');
  assert.match(h.head.innerHTML, /<th scope="col">กำไร \(%\)<\/th>/);
  assert.match(h.head.innerHTML, /<th scope="col" aria-sort="descending">กำไรของ<\/th>/);
  assert.deepEqual(Array.from(h.run('PRODUCT_SORT_COLS')), ['E', 'F', 'L', 'G', 'H']);
  h.run("productSortFieldVal = 'G'; renderProductTableHead()");
  assert.match(h.head.innerHTML, /<th scope="col" aria-sort="descending">กำไร \(%\)<\/th>/);
  assert.match(h.head.innerHTML, /<th scope="col">กำไรของ<\/th>/);
  h.run('hideSensitiveData = true; renderProductTableHead()');
  assert.doesNotMatch(h.head.innerHTML, /กำไร|aria-sort/);
  assert.doesNotMatch(h.table(row), /50%|987654|777/);
});

for (const [name, text] of [['modular', source], ['standalone', standalone]]) {
  test(`${name}: search and expanded details hide sensitive fields until explicitly opened`, () => {
    const h = makeHarness(text);
    const row = product({E: 12345, H: 24690, I: 87654, J: 76543, K: 'PRIVATE-NOTE', L: 65432});
    h.run('hideSensitiveData = true');
    h.run("expandedProductRows.add('001')");
    for (const html of [h.search(row), h.table(row)]) {
      assert.doesNotMatch(html, /12345|24690|87654|76543|PRIVATE-NOTE|65432|100%/);
      assert.match(html, /เก้าอี้ไม้/);
    }
    h.run('hideSensitiveData = false');
    for (const html of [h.search(row), h.table(row)]) assert.match(html, /PRIVATE-NOTE/);
    h.run('hideSensitiveData = true');
    for (const html of [h.search(row), h.table(row)]) assert.doesNotMatch(html, /PRIVATE-NOTE/);
    assert.match(text, /let hideSensitiveData = true/);
    assert.match(text, /hideSensitiveData = hideBox.checked;\s*renderProductTable\(\);\s*doSearch\(\);/);
  });
}

test('standalone and modular dashboard use identical percentage constants and rendering logic', () => {
  assert.equal(columnConstants(standalone), columnConstants(source));
  for (const name of ['getProductProfitPercent', 'formatProductProfitPercent', 'getProductDisplayText', 'renderSearchResult', 'renderProductTableRow']) {
    assert.equal(extractFunction(standalone, name), extractFunction(source, name), name);
  }
  const h = makeHarness(standalone);
  assert.equal(h.format(product({ E: 100, H: 150 })), '50%');
  assert.match(h.search(product({ E: 100, H: 150 })), /<p>กำไร \(%\)<\/p><strong>50%<\/strong>/);
});
