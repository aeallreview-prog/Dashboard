'use strict';

// Local layout/rendering regression checks only: no network or spreadsheet access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const standalone = fs.readFileSync(path.join(root, 'seek-n-tique-dashboard.html'), 'utf8');

function statusStyles(source) {
  const start = source.indexOf('.status-grid {');
  const end = source.indexOf('/* Donut chart panel */', start);
  assert.ok(start >= 0 && end > start, 'Product-status styles are present');
  return source.slice(start, end).trim();
}

const containerRules = [
  [900, 3],
  [640, 2],
  [420, 1],
].map(([width, columns]) => new RegExp(
  `@container\\s*\\(max-width:\\s*${width}px\\)\\s*\\{\\s*\\.status-grid\\s*\\{\\s*grid-template-columns:\\s*repeat\\(${columns},\\s*1fr\\);\\s*\\}\\s*\\}`
));

for (const [name, source] of [['style.css', css], ['standalone', standalone]]) {
  test(`${name}: desktop status cards use one column after all container overrides`, () => {
    const styles = statusStyles(source);
    const desktop = /@media\s*\(min-width:\s*1024px\)\s*\{\s*\.status-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);\s*\}\s*\}/.exec(styles);
    assert.ok(desktop, 'Desktop-only single-column override starts at 1024px');
    for (const rule of containerRules) {
      const match = rule.exec(styles);
      assert.ok(match, 'Existing responsive container rule is retained');
      assert.ok(match.index + match[0].length <= desktop.index,
        'Desktop rule follows the container rule so the cascade stays single-column');
    }
  });

  test(`${name}: original base and mobile/tablet container column counts are retained`, () => {
    const styles = statusStyles(source);
    assert.match(styles, /^\.status-grid\s*\{[^}]*grid-template-columns:\s*repeat\(6,\s*1fr\);/);
    for (const rule of containerRules) assert.match(styles, rule);
    assert.equal([...styles.matchAll(/@container\b/g)].length, 3);
  });
}

test('standalone mirrors the complete product-status styling', () => {
  assert.equal(statusStyles(standalone), statusStyles(css));
});

function makeHarness(source) {
  const definitions = source.match(/const STATUS_DEFS = \[[\s\S]*?\n\];/);
  const start = source.indexOf('function renderStatusGrid(');
  const end = source.indexOf('\nfunction renderDonut(', start);
  assert.ok(definitions && start >= 0 && end > start, 'Actual production status renderer is present');
  const grid = {
    children: [], html: '',
    get innerHTML() { return this.html; },
    set innerHTML(value) { this.html = value; this.children = []; },
    appendChild(child) { this.children.push(child); return child; },
  };
  const context = vm.createContext({
    document: {
      getElementById(id) { assert.equal(id, 'statusGrid'); return grid; },
      createElement(tag) { assert.equal(tag, 'div'); return { className: '', innerHTML: '' }; },
    },
    fetch() { throw new Error('Status layout must not access the network'); },
    callWriteApi() { throw new Error('Status layout must not write data'); },
  });
  const overview = source.match(/const OVERVIEW_STATUS_DEFS = .*;/)[0];
  vm.runInContext(`${definitions[0]}\n${overview}\n${source.slice(start, end)}`, context);
  return {
    grid,
    render(counts, total) {
      context.testCounts = counts;
      context.testTotal = total;
      vm.runInContext('renderStatusGrid(testCounts, testTotal)', context);
    },
  };
}

for (const [name, source] of [['app.js', app], ['standalone', standalone]]) {
  test(`${name}: actual renderer keeps six product cards and adds Free Gift last`, () => {
    const h = makeHarness(source);
    const expected = [
      ['none', 'ยังไม่ได้ลงขาย', 5],
      ['listed', 'ลงขายแล้ว', 10],
      ['partial', 'ขายได้บางส่วน', 15],
      ['reserved', 'ติดจอง', 20],
      ['soldout', 'ขายหมดแล้ว', 25],
      ['shipped', 'ส่งแล้ว', 25],
    ];
    h.render(Object.fromEntries(expected.map(([key, , count]) => [key, count])), 100);
    assert.equal(h.grid.children.length, 7);
    assert.match(h.grid.children[6].innerHTML, /ของแถม/);
    expected.forEach(([key, label, count], index) => {
      const card = h.grid.children[index];
      assert.equal(card.className, 'status-card');
      assert.ok(card.innerHTML.includes(`</span>${label}</p>`), 'Status label stays in original order');
      assert.ok(card.innerHTML.includes(`color:var(--status-${key})">${count}</strong>`));
      assert.ok(card.innerHTML.includes(`${count}% ของทั้งหมด`));
    });
  });

  test(`${name}: statuses with no products still have cards and zero counts`, () => {
    const h = makeHarness(source);
    h.render({ none: 2 }, 2);
    assert.equal(h.grid.children.length, 7);
    assert.match(h.grid.children[0].innerHTML, /100% ของทั้งหมด/);
    for (const card of h.grid.children.slice(1)) {
      assert.match(card.innerHTML, />0<\/strong>/);
      assert.match(card.innerHTML, />0% ของทั้งหมด</);
    }
  });

  test(`${name}: empty history preserves the existing empty message and clears old cards`, () => {
    const h = makeHarness(source);
    h.render({ none: 1 }, 1);
    assert.equal(h.grid.children.length, 7);
    h.render({}, 0);
    assert.equal(h.grid.children.length, 0);
    assert.equal(h.grid.innerHTML, '<p class="empty">ไม่พบข้อมูลสถานะสินค้าในชีต</p>');
  });
}
