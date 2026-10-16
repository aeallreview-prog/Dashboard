'use strict';

// Run actual financial and follower controllers together. All UI, history and
// API operations below are local fixtures only: no live data or network writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const followers = fs.readFileSync(path.join(root, 'followers-chart.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const entries = ['index.html', 'seek-n-tique-dashboard.html'].map(name => ({
  name, source: fs.readFileSync(path.join(root, name), 'utf8'),
}));
const plain = value => JSON.parse(JSON.stringify(value));

function chartSection(source) {
  const start = source.indexOf('// ---------- trend charts');
  const end = source.indexOf('// ---------- message templates', start);
  assert.ok(start >= 0 && end > start, 'Financial chart integration is present');
  return source.slice(start, end).trim();
}

function filterMarkup(source) {
  const at = source.indexOf('id="trendDatePicker"');
  const start = source.lastIndexOf('<div class="trend-custom-range"', at);
  const next = source.indexOf('<div class="trend-chart-wrap"', at);
  assert.ok(at >= 0 && start >= 0 && next > at);
  return source.slice(start, next).trim();
}

for (const { name, source } of entries) {
  test(`${name}: all four line charts share one interval, date range and reset control`, () => {
    for (const id of ['trendToggle', 'trendDatePicker', 'trendResetBtn']) {
      assert.equal([...source.matchAll(new RegExp(`\\bid="${id}"`, 'g'))].length, 1, `${id} is unique`);
    }
    for (const id of ['followerRange', 'followerDatePicker', 'followerResetBtn',
      'trendFromDate', 'trendToDate', 'trendCustomBtn', 'followerFromDate', 'followerToDate', 'followerCustomBtn']) {
      assert.doesNotMatch(source, new RegExp(`\\bid="${id}"`), `${id} was removed`);
    }
    assert.equal([...source.matchAll(/class="date-range-picker"/g)].length, 1);
    assert.match(filterMarkup(source), /id="trendResetBtn"/);
    for (const id of ['trendSvgHolder', 'profitSvgHolder', 'expenseSvgHolder', 'followerChart']) {
      assert.match(source, new RegExp(`\\bid="${id}"`));
    }
  });

  test(`${name}: picker and shared filter are available before follower controller loads`, () => {
    const scripts = [...source.matchAll(/<script\b[^>]*\bsrc="([^"?]+)(?:\?[^"\s]*)?"[^>]*>/g)];
    const pickerScripts = scripts.filter(match => match[1] === 'date-range-picker.js');
    assert.equal(pickerScripts.length, 1);
    const application = name === 'index.html'
      ? scripts.find(match => match[1] === 'app.js')?.index
      : source.indexOf('/* seek n tique — live sales dashboard');
    const follower = scripts.find(match => match[1] === 'followers-chart.js')?.index;
    assert.ok(pickerScripts[0].index < application);
    assert.ok(application < follower);
    assert.ok(source.indexOf('id="trendDatePicker"') < pickerScripts[0].index);
  });
}

test('standalone entry mirrors the shared filter, date-picker CSS and financial chart controller', () => {
  assert.equal(filterMarkup(entries[0].source), filterMarkup(entries[1].source));
  const pickerStyles = source => {
    const start = source.indexOf('.trend-custom-range {');
    const end = source.indexOf('.trend-chart-wrap {', start);
    assert.ok(start >= 0 && end > start, 'Shared chart-filter styles are present');
    return source.slice(start, end).trim();
  };
  assert.equal(pickerStyles(entries[1].source), pickerStyles(css));
  assert.equal(chartSection(entries[1].source), chartSection(app));
});

function makeDom() {
  const nodes = new Map();
  function node(id = '') {
    const listeners = new Map();
    const classes = new Set();
    return {
      id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
      style: {}, dataset: {}, attributes: {}, children: [],
      classList: {
        add: (...items) => items.forEach(item => classes.add(item)),
        remove: (...items) => items.forEach(item => classes.delete(item)),
        contains: item => classes.has(item),
        toggle(item, force) {
          const add = force === undefined ? !classes.has(item) : force;
          if (add) classes.add(item); else classes.delete(item);
          return add;
        },
      },
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(callback);
      },
      async emit(type, extra = {}) {
        const event = { target: this, currentTarget: this, preventDefault() {}, ...extra };
        for (const callback of listeners.get(type) || []) await callback(event);
      },
      setAttribute(key, value) { this.attributes[key] = String(value); },
      getAttribute(key) { return this.attributes[key] ?? null; },
      appendChild(child) { this.children.push(child); return child; },
      remove() {}, focus() {},
      getBoundingClientRect() { return { width: 560 }; },
      querySelector(selector) { return selector === 'svg' ? node('mock-svg') : null; },
      querySelectorAll() { return []; },
      closest(selector) {
        return this.dataset.range && (selector === '.trend-btn' || selector === 'button[data-range]') ? this : null;
      },
    };
  }
  const get = id => {
    if (['followerRange', 'followerDatePicker', 'followerResetBtn'].includes(id)) return null;
    if (!nodes.has(id)) nodes.set(id, node(id));
    return nodes.get(id);
  };
  const trendButtons = ['day', 'week', 'month', 'year'].map(range => {
    const button = node(`trend-${range}`);
    button.dataset.range = range;
    if (range === 'week') button.classList.add('active');
    return button;
  });
  const document = {
    hidden: false,
    getElementById: get,
    querySelectorAll: selector => selector === '#trendToggle .trend-btn' ? trendButtons : [],
    querySelector(selector) {
      const match = selector.match(/^#trendToggle \.trend-btn\[data-range="([^"]+)"\]$/);
      return match ? trendButtons.find(button => button.dataset.range === match[1]) : null;
    },
    createElement: tag => node(tag),
    createElementNS: (namespace, tag) => node(tag),
    addEventListener() {},
    head: { appendChild(script) { script.onload(); } },
  };
  return { document, get, trendButtons };
}

function pickerStub() {
  const instances = new Map();
  return {
    instances,
    api: {
      create(options) {
        assert.ok(options.root && options.root.id, 'Picker receives its actual DOM root');
        assert.equal(options.label, 'เลือกช่วงวันที่ของกราฟเส้นทั้งหมด');
        assert.equal(typeof options.onApply, 'function');
        const instance = {
          options, clearCalls: 0, range: null,
          clear() { this.clearCalls += 1; this.range = null; },
          close() {},
          getRange() { return this.range; },
          apply(from, to) { this.range = { from, to }; return options.onApply({ from, to }); },
        };
        instances.set(options.root.id, instance);
        return instance;
      },
    },
  };
}

const followerRows = [
  { date: '2026-10-02', count: 301, observedAt: '2026-10-02T16:59:59.999Z', source: 'manual' },
  { date: '2026-10-03', count: 310, observedAt: '2026-10-02T17:00:00.000Z', source: 'manual' },
  { date: '2026-10-08', count: 340, observedAt: '2026-10-08T16:59:59.999Z', source: 'manual' },
  { date: '2026-10-09', count: 350, observedAt: '2026-10-08T17:00:00.000Z', source: 'manual' },
];
const chartIds = { revenue: 'trendSvgHolder', profit: 'profitSvgHolder', expense: 'expenseSvgHolder', followers: 'followerChart' };

async function makeHarness({ rows = followerRows, loadFollowers = true } = {}) {
  const dom = makeDom();
  const pickers = pickerStub();
  const rendered = [];
  const requests = [];
  const context = vm.createContext({
    document: dom.document, Date, Map, Set, Number, Intl, console, rendered,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
    ResizeObserver: class { observe() {} },
    captureChart(points) {
      rendered.push(Array.from(points, point => ({ ...point })));
      return `<svg data-fixture="${rendered.length - 1}"></svg>`;
    },
    callWriteApi: async (action, payload) => {
      requests.push({ action, payload });
      if (action === 'getFollowerHistory') return { observations: rows };
      if (action === 'saveFollowerCount') return {
        observations: [...rows, { date: '2026-10-16', count: payload.count, observedAt: '2026-10-16T08:00:00Z', source: 'manual' }],
        savedDate: '2026-10-16', count: payload.count,
      };
      throw new Error(`Unexpected API action ${action}`);
    },
    window: {
      SNTDateRangePicker: pickers.api,
      SNT_FOLLOWER_HISTORY: { username: 'seek.n.tique', observations: [] },
    },
  });
  const run = source => vm.runInContext(source, context);
  run(chartSection(app));
  run('buildLineChartSvg = captureChart; attachChartTooltip = () => {};');
  context.fixtureRows = rows;
  run(`historyRows = fixtureRows.map((row, index) => ({
    date: new Date(row.observedAt), revenue: (index + 1) * 100,
    profit: (index + 1) * 10, expense: (index + 1) * 90
  })); renderTrendChart(); renderProfitChart(); renderExpenseChart();`);
  const picker = pickers.instances.get('trendDatePicker');
  assert.ok(picker, 'The one shared date picker is mounted');
  assert.ok(context.window.SNTChartFilter, 'The app owns shared filter state');
  async function loadFollower() {
    run(followers);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    assert.equal(dom.get('followerSave').disabled, false, 'Fixture history loaded');
    assert.equal(pickers.instances.size, 1, 'Followers do not create another picker');
  }
  if (loadFollowers) await loadFollower();
  const points = metric => {
    const match = dom.get(chartIds[metric]).innerHTML.match(/data-fixture="(\d+)"/);
    return match ? rendered[Number(match[1])] : [];
  };
  const values = metric => points(metric).map(point => point.value);
  const preset = range => dom.get('trendToggle').emit('click', { target: dom.trendButtons.find(button => button.dataset.range === range) });
  const state = () => plain(context.window.SNTChartFilter.getState());
  return { ...dom, context, run, rendered, requests, picker, points, values, preset, state, loadFollower };
}

test('shared filter exposes detached snapshots and immediately notifies subscribers', async () => {
  const h = await makeHarness();
  const api = h.context.window.SNTChartFilter;
  const events = [];
  const unsubscribe = api.subscribe(state => events.push(plain(state)));
  assert.deepEqual(events, [{ range: 'week', customRange: null }]);
  await h.preset('month');
  h.picker.apply('2026-10-03', '2026-10-08');
  assert.equal(events.length, 3);
  assert.equal(events[2].range, 'month');
  const snapshot = api.getState();
  snapshot.range = 'year';
  snapshot.customRange.from = 0;
  assert.equal(h.state().range, 'month');
  assert.equal(h.state().customRange.from, Date.parse('2026-10-03T00:00:00+07:00'));
  unsubscribe();
  await h.get('trendResetBtn').emit('click');
  assert.equal(events.length, 3, 'Unsubscribed consumers are no longer notified');
});

test('one date range filters all four charts at exact inclusive Bangkok day boundaries', async () => {
  const h = await makeHarness();
  await h.preset('day');
  h.picker.apply('2026-10-03', '2026-10-08');
  assert.deepEqual(h.state(), {
    range: 'day',
    customRange: { from: Date.parse('2026-10-03T00:00:00+07:00'), to: Date.parse('2026-10-08T23:59:59.999+07:00') },
  });
  for (const [metric, expected] of Object.entries({ revenue: [200, 300], profit: [20, 30], expense: [180, 270], followers: [310, 340] })) {
    assert.deepEqual(h.values(metric), expected, metric);
  }
  assert.equal(h.run('customRange.from.getTime()'), h.state().customRange.from);
  assert.equal(h.run('customRange.to.getTime()'), h.state().customRange.to);
});

test('single selected day includes its final millisecond in every chart', async () => {
  const h = await makeHarness();
  h.picker.apply('2026-10-08', '2026-10-08');
  for (const [metric, expected] of Object.entries({ revenue: [300], profit: [30], expense: [270], followers: [340] })) {
    assert.deepEqual(h.values(metric), expected, metric);
  }
});

test('invalid shared dates cannot change any chart or notify shared consumers', async () => {
  const h = await makeHarness();
  h.picker.apply('2026-10-03', '2026-10-08');
  const initial = h.state();
  const renderedBefore = h.rendered.length;
  let notifications = 0;
  h.context.window.SNTChartFilter.subscribe(() => { notifications += 1; });
  for (const [from, to] of [
    ['', '2026-10-08'], ['2026-10-03', ''], ['not-a-date', '2026-10-08'],
    ['2026-10-03', '2026-13-08'], ['2026-10-09', '2026-10-08'],
    ['2026-1-03', '2026-10-08'], ['2026-10-03T00:00:00', '2026-10-08'],
    ['2026-02-30', '2026-03-08'], ['2026-10-03', '2026-10-32'],
  ]) {
    h.picker.apply(from, to);
    assert.deepEqual(h.state(), initial);
  }
  assert.equal(h.rendered.length, renderedBefore);
  assert.equal(notifications, 1);
});

for (const [range, indexes, expectedFollowers] of [
  ['day', [1, 2, 3, 4], [301, 310, 340, 350]],
  ['week', [2, 4], [310, 350]], ['month', [4], [350]], ['year', [4], [350]],
]) {
  test(`shared ${range} preset clears custom dates and groups every line chart consistently`, async () => {
    const h = await makeHarness();
    h.picker.apply('2026-10-08', '2026-10-08');
    const before = h.picker.clearCalls;
    await h.preset(range);
    assert.deepEqual(h.state(), { range, customRange: null });
    assert.equal(h.picker.clearCalls, before + 1);
    assert.equal(h.picker.getRange(), null);
    assert.deepEqual(h.trendButtons.filter(button => button.classList.contains('active')).map(button => button.dataset.range), [range]);
    assert.deepEqual(h.values('revenue'), indexes.map(index => index * 100));
    assert.deepEqual(h.values('profit'), indexes.map(index => index * 10));
    assert.deepEqual(h.values('expense'), indexes.map(index => index * 90));
    assert.deepEqual(h.values('followers'), expectedFollowers);
  });
}

for (const [range, expectedRevenue, expectedFollowers] of [
  ['day', [200, 300], [310, 340]], ['week', [200, 300], [310, 340]],
  ['month', [300], [340]], ['year', [300], [340]],
]) {
  test(`applying shared dates retains the chosen ${range} grouping for all charts`, async () => {
    const h = await makeHarness();
    await h.preset(range);
    h.picker.apply('2026-10-03', '2026-10-08');
    assert.equal(h.state().range, range);
    assert.deepEqual(h.values('revenue'), expectedRevenue);
    assert.deepEqual(h.values('profit'), expectedRevenue.map(value => value / 10));
    assert.deepEqual(h.values('expense'), expectedRevenue.map(value => value * 0.9));
    assert.deepEqual(h.values('followers'), expectedFollowers);
  });
}

test('shared reset restores weekly history and clears the one picker for every chart', async () => {
  const h = await makeHarness();
  await h.preset('day');
  h.picker.apply('2026-10-08', '2026-10-08');
  const before = h.picker.clearCalls;
  await h.get('trendResetBtn').emit('click');
  assert.deepEqual(h.state(), { range: 'week', customRange: null });
  assert.equal(h.picker.clearCalls, before + 1);
  assert.equal(h.picker.getRange(), null);
  assert.deepEqual(h.values('revenue'), [200, 400]);
  assert.deepEqual(h.values('profit'), [20, 40]);
  assert.deepEqual(h.values('expense'), [180, 360]);
  assert.deepEqual(h.values('followers'), [310, 350]);
});

test('a date range without observations renders empty results in all four charts', async () => {
  const h = await makeHarness();
  h.picker.apply('2027-01-01', '2027-01-02');
  for (const [metric, id] of Object.entries(chartIds)) {
    assert.deepEqual(h.values(metric), []);
    assert.match(h.get(id).innerHTML, /ไม่มีข้อมูลในช่วง/);
  }
  assert.ok(h.state().customRange, 'Empty results do not silently reset the filter');
});

test('followers loaded after a user selection start with the existing shared filter', async () => {
  const h = await makeHarness({ loadFollowers: false });
  await h.preset('month');
  h.picker.apply('2026-10-03', '2026-10-08');
  const before = h.state();
  await h.loadFollower();
  assert.deepEqual(h.state(), before);
  assert.deepEqual(h.values('followers'), [340]);
  assert.deepEqual(h.values('revenue'), [300]);
});

test('read-only follower refresh preserves shared dates and grouping', async () => {
  const h = await makeHarness();
  await h.preset('month');
  h.picker.apply('2026-10-03', '2026-10-08');
  const before = h.state();
  const clears = h.picker.clearCalls;
  await h.get('followerRefresh').emit('click');
  assert.deepEqual(h.state(), before);
  assert.equal(h.picker.clearCalls, clears);
  assert.deepEqual(h.values('followers'), [340]);
  assert.deepEqual(h.values('revenue'), [300]);
  assert.ok(h.requests.every(request => request.action === 'getFollowerHistory'));
});

test('confirmed manual follower save retains range and excludes the out-of-range new point', async () => {
  const h = await makeHarness();
  await h.preset('month');
  h.picker.apply('2026-10-03', '2026-10-08');
  const before = h.state();
  const clears = h.picker.clearCalls;
  h.get('followerInput').value = '375';
  await h.get('followerForm').emit('submit');
  assert.deepEqual(h.state(), before);
  assert.equal(h.picker.clearCalls, clears);
  assert.deepEqual(h.values('followers'), [340]);
  assert.deepEqual(h.values('revenue'), [300]);
  assert.equal(h.get('followerCount').textContent, '375', 'Latest total can update without overriding the plotted interval');
  assert.equal(h.get('followerInput').value, '');
  assert.match(h.get('followerSaveStatus').textContent, /บันทึก/);
  await h.get('trendResetBtn').emit('click');
  assert.deepEqual(h.values('followers'), [310, 350, 375], 'New observation is available after shared reset');
});

test('weekly buckets split at Bangkok Monday midnight in every line chart', async () => {
  const h = await makeHarness({ rows: [
    { date: '2026-10-11', count: 320, observedAt: '2026-10-11T16:59:59.999Z', source: 'manual' },
    { date: '2026-10-12', count: 330, observedAt: '2026-10-11T17:00:00.000Z', source: 'manual' },
    { date: '2026-10-18', count: 340, observedAt: '2026-10-18T16:59:59.999Z', source: 'manual' },
    { date: '2026-10-19', count: 350, observedAt: '2026-10-18T17:00:00.000Z', source: 'manual' },
  ] });
  assert.deepEqual(h.values('revenue'), [100, 300, 400]);
  assert.deepEqual(h.values('profit'), [10, 30, 40]);
  assert.deepEqual(h.values('expense'), [90, 270, 360]);
  assert.deepEqual(h.values('followers'), [320, 340, 350]);
  h.picker.apply('2026-10-12', '2026-10-18');
  assert.deepEqual(h.values('revenue'), [300]);
  assert.deepEqual(h.values('profit'), [30]);
  assert.deepEqual(h.values('expense'), [270]);
  assert.deepEqual(h.values('followers'), [340]);
});

test('gviz date components are interpreted as Bangkok time before shared date filtering', async () => {
  const h = await makeHarness({ rows: [
    { date: '2026-10-08', count: 340, observedAt: '2026-10-08T16:00:00.000Z', source: 'manual' },
    { date: '2026-10-09', count: 350, observedAt: '2026-10-08T17:00:00.000Z', source: 'manual' },
  ] });
  assert.equal(h.run(`parseGvizDate({v:'Date(2026,9,8,23,0,0)'}).toISOString()`), '2026-10-08T16:00:00.000Z');
  assert.equal(h.run(`parseGvizDate({v:'Date(2026,9,9)'}).toISOString()`), '2026-10-08T17:00:00.000Z');
  h.run(`historyRows = [
    {date:parseGvizDate({v:'Date(2026,9,8,23,0,0)'}),revenue:100,profit:10,expense:90},
    {date:parseGvizDate({v:'Date(2026,9,9,0,0,0)'}),revenue:200,profit:20,expense:180}
  ];`);
  await h.preset('day');
  h.picker.apply('2026-10-08', '2026-10-08');
  assert.deepEqual(h.values('revenue'), [100]);
  assert.deepEqual(h.values('profit'), [10]);
  assert.deepEqual(h.values('expense'), [90]);
  assert.deepEqual(h.values('followers'), [340]);
});

test('Bangkok calendar labels agree across financial and follower points at midnight', async () => {
  const h = await makeHarness({ rows: [
    { date: '2026-10-03', count: 310, observedAt: '2026-10-02T17:00:00.000Z', source: 'manual' },
  ] });
  await h.preset('day');
  const label = new Date('2026-10-02T17:00:00.000Z').toLocaleDateString('th-TH', {
    day: '2-digit', month: '2-digit', timeZone: 'Asia/Bangkok',
  });
  for (const metric of Object.keys(chartIds)) assert.equal(h.points(metric)[0].label, label, `${metric} preset label`);
  h.picker.apply('2026-10-03', '2026-10-03');
  for (const metric of Object.keys(chartIds)) assert.equal(h.points(metric)[0].label, label, `${metric} custom label`);
});

test('Bangkok date parsing and chart labels remain correct on non-Thai devices', () => {
  for (const timezone of ['UTC', 'America/Los_Angeles']) {
    const result = spawnSync(process.execPath, [
      '--test', '--test-reporter=spec',
      '--test-name-pattern=^(gviz date components|Bangkok calendar labels)', __filename,
    ], { env: { ...process.env, TZ: timezone }, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `Device timezone ${timezone}:\n${result.stdout}\n${result.stderr}`);
  }
});
