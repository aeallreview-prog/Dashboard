const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
for (const file of ['app.js', 'seek-n-tique-dashboard.html']) {
  test(`${file}: item orders image, number, subdued status and optional discount`, () => {
    const source = read(file);
    const start = source.indexOf('const itemRows = calcItems.map');
    const markup = source.slice(start, source.indexOf('const notFoundNote', start));
    const positions = ['calc-item-thumb', 'calc-item-heading', 'calc-item-status', 'calc-item-discount'].map(value => markup.indexOf(value));
    assert.ok(positions.every((position, i) => position >= 0 && (!i || position > positions[i - 1])));
    assert.match(markup, /<small class="calc-item-status">/);
    assert.match(markup, /calcItemDiscount\$\{i\}" hidden/);
    assert.match(markup, /aria-label="จำนวนสินค้า"/);
    const totals = source.slice(source.indexOf('function renderCalcTotals'), source.indexOf('function doCalculate'));
    assert.match(totals, /<span>ราคาสินค้ารวม<\/span>/);
    assert.match(totals, /<span>ส่วนลดสินค้า<\/span>/);
    assert.doesNotMatch(totals, /ชิ้น\)|\(ไม่รวมค่าส่ง\)/);
  });
}
test('mobile styles keep the image uncropped and text wrapping, with matching standalone styles', () => {
  const css = read('style.css');
  const block = source => source.slice(source.indexOf('@media (max-width: 640px) {\n  .calc-card'), source.indexOf('/* Templates view */'));
  assert.equal(block(css), block(read('seek-n-tique-dashboard.html')));
  assert.match(block(css), /object-fit: contain/);
  assert.match(block(css), /flex-wrap: nowrap/);
  assert.match(block(css), /min-width: 0/);
  assert.match(css, /\.calc-item-status \{[^}]*color: var\(--muted\);[^}]*400 11px/);
});
