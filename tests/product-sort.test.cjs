'use strict';

// Run with: node --test tests/product-sort.test.cjs
// Exercises the production table code without a browser, spreadsheet or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const standalone = fs.readFileSync(path.join(root, 'seek-n-tique-dashboard.html'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function extractFunction(text, name) {
  const match = new RegExp(`function ${name}\\(`).exec(text);
  assert.ok(match, `Missing production function: ${name}`);
  for (let end = text.indexOf('\n}', match.index); end >= 0; end = text.indexOf('\n}', end + 2)) {
    const candidate = text.slice(match.index, end + 2);
    try { new vm.Script(`(${candidate})`); return candidate; } catch {}
  }
  throw new Error(`Cannot extract function: ${name}`);
}

function tableSection(text) {
  const start = text.indexOf('// ---------- product table (');
  const end = text.indexOf('// ---------- main fetch ----------', start);
  assert.ok(start >= 0 && end > start, 'Product-table section must exist');
  return text.slice(start, end).trim();
}

function makeHarness() {
  const nodes = new Map();
  const documentListeners = new Map();
  let focusedNode = null;
  function get(id) {
    if (!nodes.has(id)) {
      const listeners = new Map();
      nodes.set(id, {
        id, value: '', checked: false, disabled: false, hidden: false, open: false,
        innerHTML: '', textContent: '', dataset: {}, style: {}, children: [],
        attributes: {},
        addEventListener(type, callback) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(callback);
        },
        emit(type, properties = {}) {
          const event = { target: this, currentTarget: this, preventDefault() {}, ...properties };
          for (const callback of listeners.get(type) || []) callback(event);
          return event;
        },
        listenerCount(type) { return (listeners.get(type) || []).length; },
        appendChild(node) { this.children.push(node); },
        setAttribute(key, value) { this.attributes[key] = String(value); },
        removeAttribute(key) { delete this.attributes[key]; },
        contains(node) { return node === this || this.children.some(child => child === node || child.contains?.(node)); },
        focus() { focusedNode = this; },
        closest() { return get('panel'); },
        classList: { add() {}, remove() {}, toggle() {} },
      });
    }
    return nodes.get(id);
  }
  get('productSortMenu').children.push(get('productSortToggle'), get('productSortControls'));
  get('productSortControls').children.push(get('productSortField'), get('productSortDirection'), get('productSortReset'), get('productSortApply'));
  const context = vm.createContext({
    document: {
      getElementById: get,
      createElement: tag => ({ tagName: tag.toUpperCase(), value: '', textContent: '' }),
      querySelectorAll: () => [],
      addEventListener(type, callback) {
        if (!documentListeners.has(type)) documentListeners.set(type, []);
        documentListeners.get(type).push(callback);
      },
    },
    STATUS_DEFS: [{ label: 'ลงขายแล้ว' }, { label: 'ขายหมดแล้ว' }],
    STATUS_DISPLAY_COL: 14,
    PRODUCT_COL: 4,
    DISPLAY_COLS: [0, 15, 2, 4, 5, 6, 7, 8, 9, 10, 11, 14],
    IMAGE_COL: 15, DETAIL_COL: 2, PRICE_COL: 5,
    lastRows: null,
    detailCopyTexts: [],
    headerLabel: col => String(col),
    attachDragScrollAll() {},
    fixExpandedRowWidths() {},
    callWriteApi() { throw new Error('Sorting must not write to the spreadsheet'); },
    fetch() { throw new Error('Sorting must not make a network request'); },
  });
  const run = code => vm.runInContext(code, context);
  for (const name of ['colToIndex', 'cellText', 'cellNumber', 'rowHasProduct', 'getProductProfitPercent']) run(extractFunction(source, name));
  const percentColumn = source.match(/const PROFIT_PERCENT_COL = [^;]+;/);
  assert.ok(percentColumn, 'Missing production percentage column constant');
  run(percentColumn[0]);
  run(tableSection(source));
  // Table pagination and controls are real; simple row markup makes row order observable.
  run(`renderProductTableRow = row => '<tr data-no="' + cellText(row.c[0]) + '"></tr>'`);
  return {
    get, context, run,
    focusedNode: () => focusedNode,
    documentListenerCount: type => (documentListeners.get(type) || []).length,
    emitDocument(type, properties = {}) {
      const event = { target: get('outside'), preventDefault() {}, ...properties };
      for (const callback of documentListeners.get(type) || []) callback(event);
      return event;
    },
    setRows(rows) { context.lastRows = [{ c: [{ v: 'No.' }] }, ...rows]; },
    sort(field, direction = 'desc') {
      run(`productSortFieldVal = ${JSON.stringify(field)}; productSortDirectionVal = ${JSON.stringify(direction)}`);
    },
    ids() { return Array.from(run('getFilteredProductRows()'), row => row.c[0].v); },
    renderedIds() { return Array.from(get('productTableBody').innerHTML.matchAll(/data-no="([^"]+)"/g), match => match[1]); },
  };
}

function amount(value) {
  return typeof value === 'object' && value !== null ? value : { v: value, f: String(value) };
}

function product(id, values = {}, status = 'ลงขายแล้ว') {
  const c = Array(16).fill(null);
  c[0] = { v: String(id) };
  c[4] = { v: 100, f: '100' }; // Existing row qualification requires a populated cost.
  c[14] = { v: status };
  for (const [column, value] of Object.entries(values)) c[column.charCodeAt(0) - 65] = amount(value);
  return { c };
}

test('every requested monetary column sorts numerically in both directions with stable ties', () => {
  for (const field of ['E', 'F', 'L', 'H']) {
    const h = makeHarness();
    h.setRows([20, 3, -4, 0, 100.5, 3].map((value, i) => product(i + 1, { [field]: value })));
    h.sort(field, 'desc');
    assert.deepEqual(h.ids(), ['5', '1', '2', '6', '4', '3'], `${field} descending`);
    h.sort(field, 'asc');
    assert.deepEqual(h.ids(), ['3', '4', '2', '6', '1', '5'], `${field} ascending`);
  }
});

test('profit uses L and sale revenue uses H, never G or the status column', () => {
  const h = makeHarness();
  h.setRows([
    product('a', { E: 200, F: 250, G: 50, H: 0, L: 900 }, 'ขายหมดแล้ว'),
    product('b', { E: 10, F: 100, G: 90, H: 300, L: -900 }),
    product('c', { E: 100, F: 50, G: -50, H: 100, L: 9999 }),
  ]);
  h.sort('L');
  assert.deepEqual(h.ids(), ['c', 'a', 'b']);
  h.sort('L', 'asc');
  assert.deepEqual(h.ids(), ['b', 'a', 'c']);
  h.sort('H');
  assert.deepEqual(h.ids(), ['b', 'c', 'a']);
});

test('G sorts cost-based profit percentages from E and H, not stored G, asking price F, net profit L, or status', () => {
  const h = makeHarness();
  h.setRows([
    product('gain', { E: 100, H: 150, G: -999, F: 5, L: -999 }),
    product('loss', { E: 100, H: 50, G: 999, F: 9000, L: 999 }, 'ขายหมดแล้ว'),
    product('even', { E: 100, H: 100, G: 800, F: 8000, L: 800 }),
    product('same-percent', { E: 200, H: 300, G: 700, F: 7000, L: 700 }),
    product('best-percent', { E: 10, H: 30, G: 600, F: 6000, L: 600 }),
  ]);
  const original = JSON.stringify(h.context.lastRows);
  const originalRefs = h.context.lastRows.slice();
  h.sort('G', 'desc');
  assert.deepEqual(h.ids(), ['best-percent', 'gain', 'same-percent', 'even', 'loss']);
  h.sort('G', 'asc');
  assert.deepEqual(h.ids(), ['loss', 'even', 'gain', 'same-percent', 'best-percent']);
  assert.equal(JSON.stringify(h.context.lastRows), original);
  assert.ok(h.context.lastRows.every((row, i) => row === originalRefs[i]));
  h.sort('none');
  assert.deepEqual(h.ids(), ['gain', 'loss', 'even', 'same-percent', 'best-percent']);
});

test('unavailable profit percentages stay last in both directions, with zero percent treated as a valid value', () => {
  const h = makeHarness();
  const unavailable = [
    product('not-sold', { E: 100, H: 0, G: 900 }),
    product('no-sale', { E: 100, G: 800 }),
    product('zero-cost', { E: 0, H: 150 }),
    product('negative-cost', { E: -100, H: 150 }),
    product('negative-sale', { E: 100, H: -50 }),
    product('cost-error', { E: '#DIV/0!', H: 150 }),
    product('sale-error', { E: 100, H: '#N/A' }),
    product('overflow', { E: Number.MIN_VALUE, H: Number.MAX_VALUE }),
    product('infinity', { E: 100, H: Infinity }),
  ];
  h.setRows([product('zero', { E: 100, H: 100 }), ...unavailable,
    product('loss', { E: 100, H: 50 }), product('gain', { E: 100, H: 200 })]);
  const unavailableIds = unavailable.map(row => row.c[0].v);
  h.sort('G', 'asc');
  assert.deepEqual(h.ids(), ['loss', 'zero', 'gain', ...unavailableIds]);
  h.sort('G', 'desc');
  assert.deepEqual(h.ids(), ['gain', 'zero', 'loss', ...unavailableIds]);
});

test('percentage sorting uses full precision and strict numeric inputs rather than rounded display text', () => {
  const h = makeHarness();
  h.setRows([
    product('lower-rounded', { E: 100, H: { v: 150.001, f: '150' } }),
    product('higher-rounded', { E: 100, H: { v: 150.004, f: '150' } }),
    product('formatted-half', { E: { v: '฿ 1,200.50' }, H: { v: '1,800.75 บาท' } }),
    product('formatted-double', { E: { v: null, f: '100 บาท' }, H: { f: '฿200' } }),
  ]);
  h.sort('G', 'desc');
  assert.deepEqual(h.ids(), ['formatted-double', 'higher-rounded', 'lower-rounded', 'formatted-half']);
  h.sort('G', 'asc');
  assert.deepEqual(h.ids(), ['formatted-half', 'lower-rounded', 'higher-rounded', 'formatted-double']);
});

test('raw numeric values win over display rounding and currency/formatted fallbacks remain numeric', () => {
  const h = makeHarness();
  h.setRows([
    product('raw', { F: { v: 2.25, f: '฿9,999' } }),
    product('decimal', { F: { v: 2.2, f: '฿2' } }),
    product('comma', { F: { v: '1,200.50 บาท' } }),
    product('fallback', { F: { v: null, f: '฿ 200.75' } }),
    product('formatted-only', { F: { f: '50 บาท' } }),
    product('accounting', { F: { v: '(฿ 30.50)' } }),
    product('unicode-minus', { F: { v: '−5.25' } }),
    product('raw-zero', { F: { v: 0, f: '999' } }),
  ]);
  h.sort('F', 'asc');
  assert.deepEqual(h.ids(), ['accounting', 'unicode-minus', 'raw-zero', 'decimal', 'raw', 'formatted-only', 'fallback', 'comma']);
  h.sort('F', 'desc');
  assert.deepEqual(h.ids(), ['comma', 'fallback', 'formatted-only', 'raw', 'decimal', 'raw-zero', 'unicode-minus', 'accounting']);
});

test('blanks, spreadsheet errors, non-numbers and non-finite values stay last in both directions', () => {
  for (const field of ['F', 'L', 'H']) {
    const h = makeHarness();
    const missing = [
      ['blank', { v: '' }], ['missing', null], ['spaces', { v: '   ' }],
      ['divide-error', { v: '#DIV/0!' }], ['value-error', { v: '#VALUE!' }],
      ['word', { v: 'รอ 500' }], ['infinity', { v: Infinity }], ['nan', { v: NaN }],
      ['bad-raw-good-display', { v: '#N/A', f: '200' }], ['null', { v: null }],
    ];
    h.setRows([
      product('zero', { [field]: 0 }),
      ...missing.map(([id, value]) => {
        const row = product(id);
        row.c[field.charCodeAt(0) - 65] = value;
        return row;
      }),
      product('negative', { [field]: -3 }), product('positive', { [field]: 30 }),
    ]);
    const invalidIds = missing.map(([id]) => id);
    h.sort(field, 'asc');
    assert.deepEqual(h.ids(), ['negative', 'zero', 'positive', ...invalidIds], `${field} ascending`);
    h.sort(field, 'desc');
    assert.deepEqual(h.ids(), ['positive', 'zero', 'negative', ...invalidIds], `${field} descending`);
  }
});

test('invalid populated costs sort last without changing the existing product-row qualification', () => {
  const h = makeHarness();
  const blank = product('blank');
  blank.c[4] = null;
  h.setRows([product('error', { E: '#DIV/0!' }), product('low', { E: 0 }), blank, product('high', { E: 100 })]);
  h.sort('E', 'asc');
  assert.deepEqual(h.ids(), ['low', 'high', 'error']);
  h.sort('E', 'desc');
  assert.deepEqual(h.ids(), ['high', 'low', 'error']);
});

test('sorting is a view-only copy and selecting original order restores sheet order', () => {
  const h = makeHarness();
  const rows = [product('c', { F: 30 }), product('a', { F: 10 }), product('b', { F: 20 })];
  h.setRows(rows);
  const original = JSON.stringify(h.context.lastRows);
  const originalRefs = h.context.lastRows.slice();
  for (const direction of ['desc', 'asc']) {
    h.sort('F', direction);
    h.ids();
    assert.equal(JSON.stringify(h.context.lastRows), original);
    assert.ok(h.context.lastRows.every((row, i) => row === originalRefs[i]));
  }
  h.sort('none');
  assert.deepEqual(h.ids(), ['c', 'a', 'b']);
});

test('status filtering and global sorting happen before ten-item pagination on every page', () => {
  const h = makeHarness();
  const rows = Array.from({ length: 26 }, (_, i) => product(i + 1, { E: (i + 1) * 10 }, (i + 1) % 5 ? 'ลงขายแล้ว' : 'ขายหมดแล้ว'));
  h.setRows(rows);
  h.run(`productStatusFilterVal = 'ลงขายแล้ว'`);
  h.sort('E', 'desc');
  const expected = rows.filter(row => row.c[14].v === 'ลงขายแล้ว').map(row => row.c[0].v).reverse();
  h.run('renderProductTable()');
  assert.deepEqual(h.renderedIds(), expected.slice(0, 10));
  assert.match(h.get('productPagination').innerHTML, /21 รายการ/);
  h.run('changeProductPage(2)');
  assert.deepEqual(h.renderedIds(), expected.slice(10, 20));
  h.run('changeProductPage(3)');
  assert.deepEqual(h.renderedIds(), expected.slice(20));
});

test('percentage sorting respects status filtering and sorts all pages globally before pagination', () => {
  const h = makeHarness();
  const rows = Array.from({ length: 26 }, (_, i) => product(i + 1,
    { E: 100, H: 101 + i, G: 100 - i }, (i + 1) % 5 ? 'ลงขายแล้ว' : 'ขายหมดแล้ว'));
  h.setRows(rows);
  h.run(`productStatusFilterVal = 'ลงขายแล้ว'`);
  h.sort('G', 'desc');
  const expected = rows.filter(row => row.c[14].v === 'ลงขายแล้ว').map(row => row.c[0].v).reverse();
  h.run('renderProductTable()');
  assert.deepEqual(h.renderedIds(), expected.slice(0, 10));
  h.run('changeProductPage(2)');
  assert.deepEqual(h.renderedIds(), expected.slice(10, 20));
  h.run('changeProductPage(3)');
  assert.deepEqual(h.renderedIds(), expected.slice(20));
  assert.match(h.get('productPagination').innerHTML, /21 รายการ/);
});

test('sort controls initialize and bind once, with changes staged until Apply commits both values', () => {
  const h = makeHarness();
  h.setRows(Array.from({ length: 23 }, (_, i) => product(i + 1, { F: (23 - i) * 10 })));
  h.run('renderProductTable(); populateProductSortControls(); populateProductSortControls()');
  assert.equal(h.get('productSortField').listenerCount('change'), 1);
  assert.ok(h.get('productSortDirection').listenerCount('change') <= 1);
  assert.equal(h.get('productSortReset').listenerCount('click'), 1);
  assert.equal(h.get('productSortApply').listenerCount('click'), 1);
  assert.equal(h.get('productSortField').value, 'none');
  assert.equal(h.get('productSortDirection').value, 'desc');
  assert.equal(h.get('productSortDirection').disabled, true);
  h.run(`productStatusFilterVal = 'ลงขายแล้ว'; changeProductPage(3)`);
  const initialRows = h.renderedIds();
  const initialHead = h.get('productTableHead').innerHTML;
  h.get('productSortMenu').open = true;
  h.get('productSortField').value = 'F';
  h.get('productSortField').emit('change');
  assert.equal(h.get('productSortDirection').disabled, false);
  assert.equal(h.get('productSortReset').disabled, false);
  h.get('productSortDirection').value = 'asc';
  h.get('productSortDirection').emit('change');
  assert.equal(h.run('productPage'), 3);
  assert.equal(h.run('productSortFieldVal'), 'none');
  assert.equal(h.run('productSortDirectionVal'), 'desc');
  assert.deepEqual(h.renderedIds(), initialRows);
  assert.equal(h.get('productTableHead').innerHTML, initialHead);
  assert.equal(h.get('productSortMenu').dataset.active, 'false');
  assert.equal(h.get('productSortMenu').open, true);

  h.get('productSortApply').emit('click');
  assert.equal(h.run('productPage'), 1);
  assert.equal(h.run('productSortFieldVal'), 'F');
  assert.equal(h.run('productSortDirectionVal'), 'asc');
  assert.equal(h.run('productStatusFilterVal'), 'ลงขายแล้ว');
  assert.deepEqual(h.renderedIds(), ['23', '22', '21', '20', '19', '18', '17', '16', '15', '14']);
  assert.match(h.get('productTableHead').innerHTML, /aria-sort="ascending"/);
  assert.equal(h.get('productSortMenu').open, false);
  assert.equal(h.focusedNode(), h.get('productSortToggle'));
});

test('reset stages original order and only Apply restores it and restarts pagination', () => {
  const h = makeHarness();
  h.setRows(Array.from({ length: 12 }, (_, i) => product(i + 1, { L: i })));
  h.sort('L', 'desc');
  h.run('renderProductTable(); changeProductPage(2)');
  const previousRows = h.renderedIds();
  const previousTitle = h.get('productSortToggle').attributes['aria-label'];
  h.get('productSortMenu').open = true;
  h.get('productSortReset').emit('click');
  assert.equal(h.run('productPage'), 2);
  assert.equal(h.run('productSortFieldVal'), 'L');
  assert.equal(h.run('productSortDirectionVal'), 'desc');
  assert.deepEqual(h.renderedIds(), previousRows);
  assert.equal(h.get('productSortMenu').dataset.active, 'true');
  assert.equal(h.get('productSortToggle').attributes['aria-label'], previousTitle);
  assert.equal(h.get('productSortMenu').open, true);
  assert.equal(h.get('productSortField').value, 'none');
  assert.equal(h.get('productSortDirection').value, 'desc');
  assert.equal(h.get('productSortDirection').disabled, true);
  assert.equal(h.get('productSortReset').disabled, true);
  h.get('productSortApply').emit('click');
  assert.equal(h.run('productPage'), 1);
  assert.equal(h.run('productSortFieldVal'), 'none');
  assert.equal(h.run('productSortDirectionVal'), 'desc');
  assert.deepEqual(h.renderedIds(), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  assert.equal(h.get('productSortMenu').dataset.active, 'false');
  assert.equal(h.get('productSortMenu').open, false);
});

test('Apply validates unknown fields and directions', () => {
  for (const field of ['invalid', '']) {
    const h = makeHarness();
    h.setRows([product('a', { L: 10 }), product('b', { L: 20 })]);
    h.sort('L', 'desc');
    h.run('renderProductTable()');
    h.get('productSortField').value = field;
    h.get('productSortDirection').value = 'invalid';
    h.get('productSortApply').emit('click');
    assert.equal(h.run('productSortFieldVal'), 'none');
    assert.equal(h.run('productSortDirectionVal'), 'desc');
    assert.deepEqual(h.renderedIds(), ['a', 'b']);
  }
});

test('the percentage option stays pending until Apply, then labels and marks G while leaving L as money', () => {
  const h = makeHarness();
  h.setRows(Array.from({ length: 12 }, (_, i) => product(i + 1, { E: 100, H: 101 + i, G: 1000 - i, L: 1000 - i })));
  h.sort('L', 'desc');
  h.run('hideSensitiveData = false; renderProductTable(); changeProductPage(2)');
  const previousRows = h.renderedIds();
  const previousHead = h.get('productTableHead').innerHTML;
  const previousLabel = h.get('productSortToggle').attributes['aria-label'];
  h.get('productSortMenu').open = true;
  h.get('productSortField').value = 'G';
  h.get('productSortField').emit('change');
  h.get('productSortDirection').value = 'desc';
  h.get('productSortDirection').emit('change');
  assert.equal(h.run('productSortFieldVal'), 'L');
  assert.equal(h.run('productPage'), 2);
  assert.deepEqual(h.renderedIds(), previousRows);
  assert.equal(h.get('productTableHead').innerHTML, previousHead);
  assert.equal(h.get('productSortToggle').attributes['aria-label'], previousLabel);
  h.run('renderProductTable()');
  assert.equal(h.get('productSortField').value, 'G', 'Refresh retains the pending percentage selection');
  assert.deepEqual(h.renderedIds(), previousRows);
  h.get('productSortApply').emit('click');
  assert.equal(h.run('productSortFieldVal'), 'G');
  assert.equal(h.run('productPage'), 1);
  assert.deepEqual(h.renderedIds(), ['12', '11', '10', '9', '8', '7', '6', '5', '4', '3']);
  assert.match(h.get('productSortToggle').attributes['aria-label'], /กำไร \(%\)/);
  assert.match(h.get('productTableHead').innerHTML, /<th scope="col" aria-sort="descending">6<\/th>/);
  assert.match(h.get('productTableHead').innerHTML, /<th scope="col">11<\/th>/);
  assert.equal(h.get('productSortMenu').open, false);
  assert.equal(h.focusedNode(), h.get('productSortToggle'));
});

test('compact sort icon changes its active state and accessible labels only after Apply', () => {
  const h = makeHarness();
  h.setRows([product('a', { F: 10 }), product('b', { F: 20 })]);
  h.run('populateProductSortControls()');
  const menu = h.get('productSortMenu');
  const toggle = h.get('productSortToggle');
  const idleLabel = toggle.attributes['aria-label'];
  const idleTitle = toggle.title || toggle.attributes.title;
  assert.equal(menu.dataset.active, 'false');
  assert.equal(menu.open, false);
  assert.ok(idleLabel && idleTitle, 'Idle icon must expose an accessible name and a tooltip');

  h.get('productSortField').value = 'F';
  h.get('productSortField').emit('change');
  assert.equal(menu.dataset.active, 'false');
  assert.equal(toggle.attributes['aria-label'], idleLabel);
  h.get('productSortApply').emit('click');
  assert.equal(menu.dataset.active, 'true');
  assert.notEqual(toggle.attributes['aria-label'], idleLabel);
  assert.notEqual(toggle.title || toggle.attributes.title, idleTitle);
  assert.match(toggle.attributes['aria-label'], /ราคาขาย/);
  const descendingLabel = toggle.attributes['aria-label'];
  h.get('productSortDirection').value = 'asc';
  h.get('productSortDirection').emit('change');
  assert.equal(toggle.attributes['aria-label'], descendingLabel);
  h.get('productSortApply').emit('click');
  assert.notEqual(toggle.attributes['aria-label'], descendingLabel, 'Accessible name reflects direction');

  h.get('productSortReset').emit('click');
  assert.equal(menu.dataset.active, 'true');
  h.get('productSortApply').emit('click');
  assert.equal(menu.dataset.active, 'false');
  assert.equal(toggle.attributes['aria-label'], idleLabel);
  assert.equal(toggle.title || toggle.attributes.title, idleTitle);
});

test('Escape closes the sort menu without applying or discarding pending choices', () => {
  const h = makeHarness();
  h.setRows([product('a', { F: 10 }), product('b', { F: 20 })]);
  h.sort('F', 'desc');
  h.run('renderProductTable()');
  const menu = h.get('productSortMenu');
  menu.open = true;
  h.get('productSortField').value = 'L';
  h.get('productSortField').emit('change');
  h.get('productSortDirection').value = 'asc';
  h.get('productSortDirection').emit('change');
  let prevented = false;
  menu.emit('keydown', { key: 'ArrowDown', target: h.get('productSortField') });
  assert.equal(menu.open, true, 'Other keys must remain available for select navigation');
  menu.emit('keydown', {
    key: 'Escape', target: h.get('productSortDirection'),
    preventDefault() { prevented = true; },
  });
  assert.equal(menu.open, false);
  assert.equal(prevented, true);
  assert.equal(h.focusedNode(), h.get('productSortToggle'));
  assert.equal(h.run('productSortFieldVal'), 'F');
  assert.equal(h.run('productSortDirectionVal'), 'desc');
  assert.deepEqual(h.renderedIds(), ['b', 'a']);
  assert.equal(menu.dataset.active, 'true');
  menu.open = true;
  menu.emit('toggle');
  assert.equal(h.get('productSortField').value, 'L');
  assert.equal(h.get('productSortDirection').value, 'asc');
});

test('outside clicks close the sort menu but clicks inside it preserve both the menu and sort state', () => {
  const h = makeHarness();
  h.setRows([product('a', { E: 10 }), product('b', { E: 20 })]);
  h.sort('E', 'asc');
  h.run('renderProductTable(); populateProductSortControls(); populateProductSortControls()');
  const menu = h.get('productSortMenu');
  h.get('productSortField').value = 'H';
  h.get('productSortField').emit('change');
  h.get('productSortDirection').value = 'desc';
  h.get('productSortDirection').emit('change');
  assert.equal(menu.listenerCount('keydown'), 1);
  assert.equal(h.documentListenerCount('click'), 1);
  for (const target of [menu, h.get('productSortToggle'), h.get('productSortField'), h.get('productSortDirection'), h.get('productSortApply')]) {
    menu.open = true;
    h.emitDocument('click', { target });
    assert.equal(menu.open, true, `Inside click must not close menu: ${target.id}`);
  }
  h.emitDocument('click', { target: h.get('outside') });
  assert.equal(menu.open, false);
  assert.equal(h.run('productSortFieldVal'), 'E');
  assert.equal(h.run('productSortDirectionVal'), 'asc');
  assert.deepEqual(h.renderedIds(), ['a', 'b']);
  assert.equal(menu.dataset.active, 'true');
  menu.open = true;
  menu.emit('toggle');
  assert.equal(h.get('productSortField').value, 'H');
  assert.equal(h.get('productSortDirection').value, 'desc');
});

test('a data refresh preserves the selected sort and applies it to the latest values', () => {
  const h = makeHarness();
  h.setRows([product('a', { H: 10 }), product('b', { H: 20 })]);
  h.sort('H', 'desc');
  h.run('renderProductTable()');
  assert.deepEqual(h.renderedIds(), ['b', 'a']);
  h.setRows([product('a', { H: 30 }), product('b', { H: 20 }), product('c', { H: 40 })]);
  h.run('renderProductTable()');
  assert.deepEqual(h.renderedIds(), ['c', 'a', 'b']);
  assert.equal(h.get('productSortField').value, 'H');
  assert.equal(h.get('productSortDirection').value, 'desc');
});

test('refresh retains pending controls while ordering new data by the applied settings', () => {
  const h = makeHarness();
  h.setRows([product('a', { H: 10, L: 10 }), product('b', { H: 20, L: 20 })]);
  h.sort('H', 'desc');
  h.run('renderProductTable()');
  const appliedLabel = h.get('productSortToggle').attributes['aria-label'];
  h.get('productSortMenu').open = true;
  h.get('productSortField').value = 'L';
  h.get('productSortField').emit('change');
  h.get('productSortDirection').value = 'asc';
  h.get('productSortDirection').emit('change');
  h.setRows([product('a', { H: 30, L: 100 }), product('b', { H: 20, L: 50 }), product('c', { H: 40, L: -10 })]);
  h.run('renderProductTable(); populateProductSortControls()');
  assert.deepEqual(h.renderedIds(), ['c', 'a', 'b']);
  assert.equal(h.run('productSortFieldVal'), 'H');
  assert.equal(h.run('productSortDirectionVal'), 'desc');
  assert.equal(h.get('productSortField').value, 'L');
  assert.equal(h.get('productSortDirection').value, 'asc');
  assert.equal(h.get('productSortMenu').open, true);
  assert.equal(h.get('productSortToggle').attributes['aria-label'], appliedLabel);
  h.get('productSortApply').emit('click');
  assert.deepEqual(h.renderedIds(), ['c', 'b', 'a']);
  assert.equal(h.run('productSortFieldVal'), 'L');
  assert.equal(h.run('productSortDirectionVal'), 'asc');
  assert.match(h.get('productSortToggle').attributes['aria-label'], /กำไรของ/);
});

test('sorting hidden monetary data does not reveal columns or change the visibility toggle', () => {
  const h = makeHarness();
  h.setRows([product('a', { L: -10 }), product('b', { L: 30 })]);
  h.sort('L', 'desc');
  h.run('renderProductTable()');
  assert.deepEqual(h.renderedIds(), ['b', 'a']);
  assert.equal(h.run('hideSensitiveData'), true);
  assert.equal(h.get('hideSensitiveCheckbox').checked, true);
  assert.deepEqual(Array.from(h.run('getVisibleCols()')), [0, 15, 2, 5, 14]);
  h.get('hideSensitiveCheckbox').checked = false;
  h.get('hideSensitiveCheckbox').emit('change');
  assert.equal(h.run('hideSensitiveData'), false);
  assert.equal(h.run('productSortFieldVal'), 'L');
  assert.deepEqual(Array.from(h.run('getVisibleCols()')), h.context.DISPLAY_COLS);
  assert.deepEqual(h.renderedIds(), ['b', 'a']);
});

test('sorting percentages preserves the sensitive-data setting and does not expose financial columns', () => {
  const h = makeHarness();
  h.setRows([product('a', { E: 100, H: 110 }), product('b', { E: 100, H: 150 })]);
  h.sort('G', 'desc');
  h.run('renderProductTable()');
  assert.deepEqual(h.renderedIds(), ['b', 'a']);
  assert.equal(h.run('hideSensitiveData'), true);
  assert.equal(h.get('hideSensitiveCheckbox').checked, true);
  assert.deepEqual(Array.from(h.run('getVisibleCols()')), [0, 15, 2, 5, 14]);
  assert.doesNotMatch(h.get('productTableHead').innerHTML, /aria-sort/);
  h.get('hideSensitiveCheckbox').checked = false;
  h.get('hideSensitiveCheckbox').emit('change');
  assert.equal(h.run('productSortFieldVal'), 'G');
  assert.deepEqual(h.renderedIds(), ['b', 'a']);
  assert.match(h.get('productTableHead').innerHTML, /<th scope="col" aria-sort="descending">6<\/th>/);
});

test('loading and empty states tolerate active sorting', () => {
  const h = makeHarness();
  h.sort('E', 'asc');
  h.run('renderProductTable()');
  assert.match(h.get('productTableBody').innerHTML, /กำลังโหลดข้อมูล/);
  assert.deepEqual(h.ids(), []);
  h.setRows([]);
  h.run('renderProductTable()');
  assert.match(h.get('productTableBody').innerHTML, /ไม่พบสินค้า/);
  assert.equal(h.get('productPagination').innerHTML, '');
});

test('standalone HTML has the exact same product-table implementation as app.js', () => {
  assert.equal(tableSection(standalone), tableSection(source));
});

test('both entry points expose the same uniquely identified sort fields and directions', () => {
  for (const [name, html] of [['index.html', index], ['seek-n-tique-dashboard.html', standalone]]) {
    for (const id of ['productSortMenu', 'productSortToggle', 'productSortControls', 'productSortField', 'productSortDirection', 'productSortReset', 'productSortApply']) {
      assert.equal((html.match(new RegExp(`\\bid="${id}"`, 'g')) || []).length, 1, `${name}: unique ${id}`);
    }
    for (const [id, expected] of [['productSortField', ['none', 'E', 'F', 'L', 'G', 'H']], ['productSortDirection', ['desc', 'asc']]]) {
      const select = html.match(new RegExp(`<select\\b[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/select>`));
      assert.ok(select, `${name}: ${id} select`);
      assert.deepEqual(Array.from(select[1].matchAll(/<option\b[^>]*value="([^"]+)"/g), match => match[1]), expected);
      assert.match(html, new RegExp(`<label\\b[^>]*for="${id}"`), `${name}: accessible ${id} label`);
    }
    assert.match(html, /<button\b[^>]*id="productSortReset"[^>]*type="button"|<button\b[^>]*type="button"[^>]*id="productSortReset"/, `${name}: reset must not submit`);
    assert.match(html, /<button\b[^>]*id="productSortApply"[^>]*type="button"[^>]*>\s*เลือก\s*<\/button>|<button\b[^>]*type="button"[^>]*id="productSortApply"[^>]*>\s*เลือก\s*<\/button>/, `${name}: explicit Apply button must not submit`);
    assert.match(html, /<option\b[^>]*value="L"[^>]*>[^<]*กำไรของ[^<]*<\/option>/, `${name}: profit option maps to column L`);
    assert.match(html, /<option\b[^>]*value="G"[^>]*>\s*กำไร \(%\)\s*<\/option>/, `${name}: percentage option maps to calculated column G`);
  }
});

test('both entry points use a closed native details control with an icon-only accessible summary', () => {
  for (const [name, html] of [['index.html', index], ['seek-n-tique-dashboard.html', standalone]]) {
    const details = html.match(/<details\b([^>]*\bid="productSortMenu"[^>]*)>([\s\S]*?)<\/details>/);
    assert.ok(details, `${name}: native details menu exists`);
    assert.doesNotMatch(details[1], /\bopen(?:\s|=|$)/, `${name}: menu defaults closed`);
    const summary = details[2].match(/<summary\b([^>]*\bid="productSortToggle"[^>]*)>([\s\S]*?)<\/summary>/);
    assert.ok(summary, `${name}: native summary exposes keyboard toggle behavior`);
    assert.match(summary[1], /\baria-label="[^"]+"/, `${name}: icon has accessible label`);
    assert.match(summary[1], /\btitle="[^"]+"/, `${name}: icon has tooltip`);
    assert.match(summary[1], /\baria-controls="productSortControls"/, `${name}: summary describes controlled panel`);
    assert.match(summary[2], /<svg\b[^>]*\baria-hidden="true"/, `${name}: funnel icon is decorative`);
    assert.equal(summary[2].replace(/<svg\b[\s\S]*?<\/svg>/g, '').trim(), '', `${name}: no visible toolbar text outside icon`);
    assert.match(details[2], /\bid="productSortControls"/, `${name}: sorting controls stay inside collapsed details`);
    assert.match(details[2], /\bid="productSortField"/, `${name}: field selector remains available after opening`);
    assert.match(details[2], /\bid="productSortDirection"/, `${name}: direction selector remains available after opening`);
    assert.match(details[2], /\bid="productSortReset"/, `${name}: reset remains available after opening`);
    assert.match(details[2], /\bid="productSortApply"/, `${name}: Apply remains inside the sorting menu`);
  }
});
