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
  get('productSortControls').children.push(get('productSortField'), get('productSortDirection'), get('productSortReset'));
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
  for (const name of ['colToIndex', 'cellText', 'cellNumber', 'rowHasProduct']) run(extractFunction(source, name));
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
  for (const field of ['E', 'F', 'G', 'H']) {
    const h = makeHarness();
    h.setRows([20, 3, -4, 0, 100.5, 3].map((value, i) => product(i + 1, { [field]: value })));
    h.sort(field, 'desc');
    assert.deepEqual(h.ids(), ['5', '1', '2', '6', '4', '3'], `${field} descending`);
    h.sort(field, 'asc');
    assert.deepEqual(h.ids(), ['3', '4', '2', '6', '1', '5'], `${field} ascending`);
  }
});

test('profit uses G and sale revenue uses H, never another profit or status column', () => {
  const h = makeHarness();
  h.setRows([
    product('a', { E: 200, F: 250, G: 50, H: 0, L: 900 }, 'ขายหมดแล้ว'),
    product('b', { E: 10, F: 100, G: 90, H: 300, L: -900 }),
    product('c', { E: 100, F: 50, G: -50, H: 100, L: 9999 }),
  ]);
  h.sort('G');
  assert.deepEqual(h.ids(), ['b', 'a', 'c']);
  h.sort('H');
  assert.deepEqual(h.ids(), ['b', 'c', 'a']);
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
  for (const field of ['F', 'G', 'H']) {
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

test('sort controls bind only once, synchronize state and restart pagination without clearing status', () => {
  const h = makeHarness();
  h.setRows([product('a', { F: 10 }), product('b', { F: 20 })]);
  h.run('populateProductSortControls(); populateProductSortControls()');
  for (const id of ['productSortField', 'productSortDirection']) assert.equal(h.get(id).listenerCount('change'), 1);
  assert.equal(h.get('productSortReset').listenerCount('click'), 1);
  assert.equal(h.get('productSortField').value, 'none');
  assert.equal(h.get('productSortDirection').value, 'desc');
  h.run(`productPage = 3; productStatusFilterVal = 'ลงขายแล้ว'`);
  h.get('productSortField').value = 'F';
  h.get('productSortField').emit('change');
  assert.equal(h.run('productPage'), 1);
  assert.equal(h.run('productSortFieldVal'), 'F');
  assert.deepEqual(h.renderedIds(), ['b', 'a']);
  h.run('productPage = 2');
  h.get('productSortDirection').value = 'asc';
  h.get('productSortDirection').emit('change');
  assert.equal(h.run('productPage'), 1);
  assert.equal(h.run('productSortDirectionVal'), 'asc');
  assert.deepEqual(h.renderedIds(), ['a', 'b']);
  h.run('productPage = 2');
  h.get('productSortReset').emit('click');
  assert.equal(h.run('productPage'), 1);
  assert.equal(h.run('productSortFieldVal'), 'none');
  assert.equal(h.run('productStatusFilterVal'), 'ลงขายแล้ว');
  assert.equal(h.get('productSortField').value, 'none');
  assert.deepEqual(h.renderedIds(), ['a', 'b']);
});

test('compact sort icon indicates active sorting and returns to its idle label after reset', () => {
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
  assert.equal(menu.dataset.active, 'true');
  assert.notEqual(toggle.attributes['aria-label'], idleLabel);
  assert.notEqual(toggle.title || toggle.attributes.title, idleTitle);
  assert.match(toggle.attributes['aria-label'], /ราคาขาย/);
  const descendingLabel = toggle.attributes['aria-label'];
  h.get('productSortDirection').value = 'asc';
  h.get('productSortDirection').emit('change');
  assert.notEqual(toggle.attributes['aria-label'], descendingLabel, 'Accessible name reflects direction');

  h.get('productSortReset').emit('click');
  assert.equal(menu.dataset.active, 'false');
  assert.equal(toggle.attributes['aria-label'], idleLabel);
  assert.equal(toggle.title || toggle.attributes.title, idleTitle);
});

test('Escape closes the sort menu, returns focus to its icon and preserves the selected ordering', () => {
  const h = makeHarness();
  h.setRows([product('a', { F: 10 }), product('b', { F: 20 })]);
  h.sort('F', 'desc');
  h.run('renderProductTable()');
  const menu = h.get('productSortMenu');
  menu.open = true;
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
});

test('outside clicks close the sort menu but clicks inside it preserve both the menu and sort state', () => {
  const h = makeHarness();
  h.setRows([product('a', { E: 10 }), product('b', { E: 20 })]);
  h.sort('E', 'asc');
  h.run('renderProductTable(); populateProductSortControls(); populateProductSortControls()');
  const menu = h.get('productSortMenu');
  assert.equal(menu.listenerCount('keydown'), 1);
  assert.equal(h.documentListenerCount('click'), 1);
  for (const target of [menu, h.get('productSortToggle'), h.get('productSortField'), h.get('productSortDirection')]) {
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

test('sorting hidden monetary data does not reveal columns or change the visibility toggle', () => {
  const h = makeHarness();
  h.setRows([product('a', { G: -10 }), product('b', { G: 30 })]);
  h.sort('G', 'desc');
  h.run('renderProductTable()');
  assert.deepEqual(h.renderedIds(), ['b', 'a']);
  assert.equal(h.run('hideSensitiveData'), true);
  assert.equal(h.get('hideSensitiveCheckbox').checked, true);
  assert.deepEqual(Array.from(h.run('getVisibleCols()')), [0, 15, 2, 5, 14]);
  h.get('hideSensitiveCheckbox').checked = false;
  h.get('hideSensitiveCheckbox').emit('change');
  assert.equal(h.run('hideSensitiveData'), false);
  assert.equal(h.run('productSortFieldVal'), 'G');
  assert.deepEqual(Array.from(h.run('getVisibleCols()')), h.context.DISPLAY_COLS);
  assert.deepEqual(h.renderedIds(), ['b', 'a']);
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
    for (const id of ['productSortMenu', 'productSortToggle', 'productSortControls', 'productSortField', 'productSortDirection', 'productSortReset']) {
      assert.equal((html.match(new RegExp(`\\bid="${id}"`, 'g')) || []).length, 1, `${name}: unique ${id}`);
    }
    for (const [id, expected] of [['productSortField', ['none', 'E', 'F', 'G', 'H']], ['productSortDirection', ['desc', 'asc']]]) {
      const select = html.match(new RegExp(`<select\\b[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/select>`));
      assert.ok(select, `${name}: ${id} select`);
      assert.deepEqual(Array.from(select[1].matchAll(/<option\b[^>]*value="([^"]+)"/g), match => match[1]), expected);
      assert.match(html, new RegExp(`<label\\b[^>]*for="${id}"`), `${name}: accessible ${id} label`);
    }
    assert.match(html, /<button\b[^>]*id="productSortReset"[^>]*type="button"|<button\b[^>]*type="button"[^>]*id="productSortReset"/, `${name}: reset must not submit`);
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
  }
});
