'use strict';

// Local chart-colour and markup regressions only; no dependencies or live data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const app = read('app.js');
const css = read('style.css');
const followers = read('followers-chart.js');
const entries = ['index.html', 'seek-n-tique-dashboard.html'].map(name => ({ name, source: read(name) }));

// This small parser covers the explicit, balanced markup in the two entry files.
// Strip raw-text elements before tokenizing so inline JS templates are not DOM.
function parseMarkup(source) {
  const html = source.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const document = { tag: '#document', attributes: {}, parent: null, children: [] };
  const nodes = [];
  const stack = [document];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const tags = /<!--[\s\S]*?-->|<![^>]*>|<\/?([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  for (const token of html.matchAll(tags)) {
    if (!token[1]) continue;
    const tag = token[1].toLowerCase();
    if (token[0].startsWith('</')) {
      assert.equal(stack.at(-1).tag, tag, `Balanced HTML closing tag: ${tag}`);
      stack.pop();
      continue;
    }
    const attributes = {};
    for (const attribute of token[2].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      attributes[attribute[1].toLowerCase()] = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
    }
    const node = { tag, attributes, parent: stack.at(-1), children: [] };
    node.parent.children.push(node);
    nodes.push(node);
    if (!voidTags.has(tag) && !/\/\s*>$/.test(token[0])) stack.push(node);
  }
  assert.equal(stack.length, 1, 'All HTML containers close');
  const hasClass = (node, name) => (node.attributes.class || '').split(/\s+/).includes(name);
  const byId = id => {
    const matches = nodes.filter(node => node.attributes.id === id);
    assert.equal(matches.length, 1, `${id} exists exactly once`);
    return matches[0];
  };
  const ancestor = (node, predicate) => {
    for (let parent = node.parent; parent; parent = parent.parent) if (predicate(parent)) return parent;
    return null;
  };
  return { nodes, hasClass, byId, ancestor };
}

const followerIds = [
  'followerHeading', 'followerCount', 'followerChange', 'followerRefresh',
  'followerChart', 'followerTooltip', 'followerNote', 'followerReminder',
  'followerForm', 'followerInput', 'followerSave', 'followerInputHint', 'followerSaveStatus',
];

for (const { name, source } of entries) {
  test(`${name}: followers follow expenses inside the same single chart card`, () => {
    const dom = parseMarkup(source);
    const { nodes, byId, hasClass, ancestor } = dom;
    const cards = nodes.filter(node => hasClass(node, 'panel-trend'));
    assert.equal(cards.length, 1);
    const card = cards[0];
    assert.ok(hasClass(card, 'panel'));
    const sections = nodes.filter(node => hasClass(node, 'follower-panel'));
    assert.equal(sections.length, 1);
    const section = sections[0];
    assert.equal(section.tag, 'section');
    assert.ok(section.parent === card, 'Follower section is a direct child of the shared card');
    assert.equal(section.attributes['aria-labelledby'], 'followerHeading');
    assert.equal(hasClass(section, 'panel'), false, 'No extra nested follower card');
    assert.ok(card.children[card.children.indexOf(section) - 1] === byId('expenseChartWrap'), 'Followers immediately follow the expense chart');
    for (const id of ['trendSvgHolder', 'profitSvgHolder', 'expenseSvgHolder', 'followerChart']) {
      assert.ok(ancestor(byId(id), node => hasClass(node, 'panel')) === card, `${id} belongs to the same card`);
    }
    for (const node of nodes.filter(node => node !== card && hasClass(node, 'panel'))) {
      assert.ok(ancestor(node, parent => parent === card) !== card, 'Chart card contains no other panel');
    }
    for (const id of followerIds) {
      assert.ok(ancestor(byId(id), node => node === section) === section, `${id} stays in the follower section`);
    }
    const heading = byId('followerHeading');
    assert.equal(heading.tag, 'h3', 'Follower heading has the same hierarchy as financial charts');
    assert.ok(ancestor(heading, node => hasClass(node, 'trend-subhead')), 'Follower heading uses common chart-heading styles');
    const headingTexts = [...source.matchAll(/<h3\b[^>]*>([^<]+)<\/h3>/g)].map(match => match[1]);
    assert.deepEqual(headingTexts.filter(text => /^แนวโน้ม/.test(text)), [
      'แนวโน้มรายได้', 'แนวโน้มกำไร', 'แนวโน้มรายจ่าย', 'แนวโน้มผู้ติดตาม Instagram',
    ]);
  });

  test(`${name}: moving the follower section keeps its form, refresh and feedback accessible`, () => {
    const { nodes, byId, ancestor } = parseMarkup(source);
    const ids = nodes.map(node => node.attributes.id).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, 'No duplicate element IDs');
    const form = byId('followerForm');
    assert.equal(form.tag, 'form');
    for (const id of ['followerInput', 'followerSave', 'followerInputHint', 'followerSaveStatus']) {
      assert.ok(ancestor(byId(id), node => node === form) === form, `${id} stays in the follower form`);
    }
    const input = byId('followerInput');
    assert.equal(input.attributes.type, 'number');
    assert.equal(input.attributes.min, '1');
    assert.equal(input.attributes.max, '1000000000');
    assert.equal(input.attributes.step, '1');
    assert.equal(input.attributes.inputmode, 'numeric');
    assert.ok(Object.hasOwn(input.attributes, 'required'));
    assert.equal(input.attributes['aria-describedby'], 'followerInputHint');
    assert.equal(nodes.filter(node => node.tag === 'label' && node.attributes.for === 'followerInput').length, 1);
    assert.equal(byId('followerSave').attributes.type, 'submit');
    assert.ok(Object.hasOwn(byId('followerSave').attributes, 'disabled'), 'Save waits for confirmed backend readiness');
    assert.equal(byId('followerRefresh').attributes.type, 'button');
    assert.equal(byId('followerNote').attributes.role, 'status');
    assert.equal(byId('followerReminder').attributes.role, 'status');
    assert.equal(byId('followerSaveStatus').attributes.role, 'status');
    assert.equal(byId('followerSaveStatus').attributes['aria-live'], 'polite');
    const profile = nodes.filter(node => node.tag === 'a' && node.attributes.href === 'https://www.instagram.com/seek.n.tique/');
    assert.equal(profile.length, 1);
    assert.equal(profile[0].attributes.target, '_blank');
    assert.match(profile[0].attributes.rel, /\bnoopener\b/);
  });

  test(`${name}: all four charts retain exactly one shared filter`, () => {
    const { nodes, byId, hasClass, ancestor } = parseMarkup(source);
    const card = nodes.find(node => hasClass(node, 'panel-trend'));
    for (const id of ['sharedChartFilter', 'trendToggle', 'trendDatePicker', 'trendResetBtn']) {
      assert.ok(ancestor(byId(id), node => node === card) === card, `${id} stays in the chart card`);
    }
    assert.equal(nodes.filter(node => hasClass(node, 'date-range-picker')).length, 1);
    assert.deepEqual(byId('trendToggle').children.map(node => node.attributes['data-range']), ['day', 'week', 'month', 'year']);
    for (const id of ['followerRange', 'followerDatePicker', 'followerResetBtn']) {
      assert.equal(nodes.some(node => node.attributes.id === id), false, 'No separate follower filter reintroduced');
    }
  });
}

function rendererColours(source) {
  const calls = [];
  const context = vm.createContext({ renderChart: (...args) => calls.push(args) });
  for (const name of ['renderTrendChart', 'renderProfitChart', 'renderExpenseChart']) {
    const implementation = source.match(new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(implementation, `${name} exists`);
    vm.runInContext(`${implementation[0]}\n${name}();`, context);
  }
  return calls.map(([metric, holder, tooltip, color, label]) => ({ metric, holder, tooltip, color, label }));
}

for (const [name, source, styles] of [
  ['app.js', app, css],
  ['standalone', entries[1].source, entries[1].source],
]) {
  test(`${name}: profit uses CI orange, expenses CI grey and revenue stays CI blue`, () => {
    const calls = rendererColours(source);
    assert.deepEqual(calls.map(({ metric, color }) => [metric, color]), [
      ['revenue', '#1a63a8'], ['profit', '#f15e22'], ['expense', '#6e7c89'],
    ]);
    for (const [metric, token] of [['revenue', 'blue'], ['profit', 'accent'], ['expense', 'muted']]) {
      const value = styles.match(new RegExp(`--${token}:\\s*(#[0-9a-f]{6})\\s*;`, 'i'));
      assert.ok(value, `Existing CI token ${token} exists`);
      assert.equal(calls.find(call => call.metric === metric).color, value[1]);
    }
    assert.deepEqual(calls.map(({ holder, tooltip }) => [holder, tooltip]), [
      ['trendSvgHolder', 'trendTooltip'], ['profitSvgHolder', 'profitTooltip'], ['expenseSvgHolder', 'expenseTooltip'],
    ]);
  });
}

test('follower chart stays blue and retains its shared-filter subscription after the layout move', () => {
  assert.match(followers, /buildLineChartSvg\(points, '#1a63a8',/);
  assert.match(followers, /window\.SNTChartFilter/);
  assert.match(followers, /chartFilter\.subscribe\(/);
});
