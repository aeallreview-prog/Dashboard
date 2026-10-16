'use strict';

// Local size and markup regressions; no browser, network or spreadsheet access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const css = read('style.css');
const standalone = read('seek-n-tique-dashboard.html');

function donutStyles(source) {
  const start = source.indexOf('/* Donut chart panel */');
  const end = source.indexOf('\n.empty {', start);
  assert.ok(start >= 0 && end > start, 'Complete donut and legend styles are present');
  return source.slice(start, end).trim();
}

function rule(styles, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(styles);
  assert.ok(match, `${selector} rule exists`);
  return match[1];
}

for (const [name, source] of [['style.css', css], ['standalone', standalone]]) {
  test(`${name}: overview donut grows to 280px and fits narrower containers`, () => {
    const donut = rule(donutStyles(source), '.donut');
    assert.match(donut, /\bwidth:\s*min\(280px,\s*100%\)\s*;/);
    assert.match(donut, /\baspect-ratio:\s*1\s*;/);
    assert.doesNotMatch(donut, /(?:^|;)\s*(?:min-|max-)?height\s*:/, 'Height follows width to keep the chart square');
    assert.match(donut, /\bborder-radius:\s*50%\s*;/);
  });

  test(`${name}: donut center scales with the ring and keeps larger labels`, () => {
    const styles = donutStyles(source);
    const center = rule(styles, '.donut-center');
    assert.match(center, /\bwidth:\s*63%\s*;/);
    assert.match(center, /\baspect-ratio:\s*1\s*;/);
    assert.doesNotMatch(center, /(?:^|;)\s*(?:min-|max-)?height\s*:/, 'Center height follows its proportional width');
    assert.match(center, /\bborder-radius:\s*50%\s*;/);
    assert.match(rule(styles, '.donut-center strong'), /\bfont:\s*700\s+32px\/1\s+'DM Sans',\s*sans-serif\s*;/);
    assert.match(rule(styles, '.donut-center span'), /\bfont-size:\s*11px\s*;/);
  });
}

test('standalone mirrors the full donut and legend style block', () => {
  assert.equal(donutStyles(standalone), donutStyles(css));
});

for (const [name, source] of [['index.html', read('index.html')], ['standalone', standalone]]) {
  test(`${name}: donut keeps exactly one copy of each existing markup ID`, () => {
    const markup = source.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    for (const id of ['donutWrap', 'donutChart', 'donutTotal', 'legendArea']) {
      const matches = [...markup.matchAll(new RegExp(`\\bid\\s*=\\s*["']${id}["']`, 'g'))];
      assert.equal(matches.length, 1, `${id} exists exactly once`);
    }
    assert.match(markup, /<div\s+class="donut"\s+id="donutChart"><div\s+class="donut-center"><strong\s+id="donutTotal">0<\/strong><span>รายการ<\/span><\/div><\/div>/);
    assert.match(markup, /<div\s+class="legend"\s+id="legendArea"><\/div>/);
  });
}
