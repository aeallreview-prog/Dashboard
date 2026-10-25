'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const app = read('app.js');
test('standalone keeps inventory logic and button CSS synchronized while preserving its storage adapter', () => {
  const html = read('seek-n-tique-dashboard.html');
  const inline = html.match(/<script>\n(\/\* seek n tique[\s\S]*?)<\/script>/)[1];
  const overview = source => source.slice(source.indexOf('const STATUS_DEFS'), source.indexOf('const DEFAULTS'));
  assert.equal(overview(inline), overview(app));
  const buttons = source => source.slice(source.indexOf('\nbutton {'), source.indexOf('\n.summary {'));
  assert.equal(buttons(html), buttons(read('style.css')));
});

for (const file of ['app.js', 'seek-n-tique-dashboard.html']) {
  const source = read(file);
  for (const quantity of [1, 2, 10, 100]) {
    test(`${file}: flat delivery for ${quantity} items, with optional special-area fee`, () => {
      const nodes = { calcTotalsBox: {}, calcMessageText: {} };
      const context = vm.createContext({ document: { getElementById: id => nodes[id] },
        fmtMoney: n => '฿' + n, navigator: {}, setTimeout() {} });
      vm.runInContext(source.slice(source.indexOf('const SHIPPING_BASE'), source.indexOf('\nfunction doCalculate(')), context);
      vm.runInContext(`calcItems = [{price: 100, qty: ${quantity}}]; renderCalcTotals();`, context);
      assert.match(nodes.calcMessageText.textContent, new RegExp(`= ${(quantity * 100 + 50).toLocaleString('th-TH')} บาท`));
      assert.match(nodes.calcTotalsBox.innerHTML, /ค่าส่งเหมาจ่าย/);
      assert.doesNotMatch(nodes.calcMessageText.textContent, /ชิ้นละ|เริ่มต้น/);
      assert.match(nodes.calcMessageText.textContent, /ค่าส่งเหมาจ่าย 50 บ\./);
      assert.doesNotMatch(nodes.calcMessageText.textContent, /[()]|ค่าส่งเพิ่ม/);
      vm.runInContext('toggleRemoteArea(true)', context);
      assert.match(nodes.calcMessageText.textContent, /ค่าส่งเพิ่มสำหรับพื้นที่พิเศษ 50 บ\./);
      assert.doesNotMatch(nodes.calcMessageText.textContent, /พื้นที่ห่างไกลหรือพื้นที่ท่องเที่ยวพิเศษ/);
      assert.doesNotMatch(nodes.calcMessageText.textContent, /[()]/);
      assert.match(nodes.calcMessageText.textContent, new RegExp(`= ${(quantity * 100 + 100).toLocaleString('th-TH')} บาท`));
    });
  }
}

test('both overview charts use all Draft and Gift counts, without mutating product counts', () => {
  const tag = {};
  const calls = [];
  let drafts = 21, gifts = 13;
  const base = { counts: {none: 2, listed: 4}, total: 6, other: 0 };
  const context = vm.createContext({ overviewProducts: base,
    window: { SNTDrafts: {getCount: () => drafts}, SNTGifts: {getCount: () => gifts} },
    document: {getElementById: () => tag},
    renderStatusGrid: (counts, total) => calls.push({counts, total}),
    renderDonut: (counts, total) => calls.push({counts, total}) });
  vm.runInContext(app.slice(app.indexOf('function renderInventoryOverview'), app.indexOf('\nconst DEFAULTS')), context);
  vm.runInContext('renderInventoryOverview(); renderInventoryOverview();', context);
  assert.equal(calls.length, 4);
  for (const c of calls) { assert.equal(c.counts.none, 23); assert.equal(c.counts.gift, 13); assert.equal(c.total, 40); }
  assert.equal(base.counts.none, 2);
  drafts = 20; gifts = 14;
  vm.runInContext('renderInventoryOverview()', context);
  assert.equal(calls.at(-1).counts.none, 22);
  assert.equal(calls.at(-1).counts.gift, 14);
  drafts = null;
  vm.runInContext('renderInventoryOverview()', context);
  assert.match(tag.textContent, /ยังไม่รวม Draft/);
  assert.equal(calls.at(-1).counts.none, 2);
});

test('gifts stay out of product status selectors; overview reads full module arrays', () => {
  assert.doesNotMatch(app.match(/const STATUS_DEFS = \[[\s\S]*?\n\];/)[0], /ของแถม/);
  assert.match(read('drafts.js'), /getCount\(\) \{ return available \? drafts.length : null; \}/);
  assert.match(read('gifts.js'), /getCount\(\) \{ return overviewCount; \}/);
  const load = app.slice(app.indexOf('async function loadData'), app.indexOf('function startPolling'));
  assert.ok(load.indexOf('SNTGifts.refreshCount()') < load.indexOf('await fetch('));
  assert.doesNotMatch(load, /await window.SNTGifts.refresh\(\)/);
});

test('generic orange button hover is mouse-only and tapping does not add a second submit handler', () => {
  const css = read('style.css');
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\) \{\s*button:hover/);
  assert.match(css, /touch-action: manipulation/);
  for (const file of ['app.js', 'drafts.js', 'gifts.js']) assert.doesNotMatch(read(file), /addEventListener\(['"]touchend/);
});
