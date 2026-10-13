'use strict';

// Local integration contracts only: no network or real spreadsheet access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const drafts = fs.readFileSync(path.join(root, 'drafts.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const entries = ['index.html', 'seek-n-tique-dashboard.html'].map(name => ({
  name, source: fs.readFileSync(path.join(root, name), 'utf8'),
}));

function functionSource(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `Missing function: ${name}`);
  for (let end = source.indexOf('\n}', start); end !== -1; end = source.indexOf('\n}', end + 2)) {
    const candidate = source.slice(start, end + 2);
    try { new vm.Script(`(${candidate})`); return candidate; } catch {}
  }
  assert.fail(`Could not parse function: ${name}`);
}

function giftView(source) {
  const start = source.indexOf('    <div class="view" id="view-gifts">');
  assert.notEqual(start, -1, 'Gift view is present');
  const end = source.indexOf('    <div class="view"', start + 1);
  assert.ok(end > start, 'Gift view ends before the next view');
  return source.slice(start, end).trim();
}

function giftStyles(source) {
  const start = source.indexOf('/* Gifts share the inventory table layout');
  const end = source.indexOf('/* Login gate */', start);
  assert.ok(start >= 0 && end > start, 'Gift-specific style section is present');
  return source.slice(start, end).trim();
}

test('gift page and gift-specific styles match between both entrypoints', () => {
  assert.equal(giftView(entries[0].source), giftView(entries[1].source));
  assert.equal(giftStyles(css), giftStyles(entries[1].source));
});

for (const { name, source } of entries) {
  test(`${name}: gift page has unique IDs, one navigation target and associated labels`, () => {
    const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    for (const id of [
      'view-gifts', 'giftRefreshBtn', 'giftCount', 'giftTotal', 'giftForm',
      'giftFormTitle', 'giftImage', 'giftCost', 'giftCustomer', 'giftImagePreview',
      'giftSaveBtn', 'giftCancelBtn', 'giftFeedback', 'giftList', 'giftPagination',
    ]) assert.equal(ids.filter(value => value === id).length, 1, `${id} must occur once`);
    assert.equal([...source.matchAll(/data-view="gifts"/g)].length, 1);
    const view = giftView(source);
    assert.match(source, /data-view="gifts" title="Free Gift"[^\n]*<span>Free Gift<\/span><\/button>/);
    assert.match(view, /<h2>Free Gift<\/h2>/);
    for (const id of ['giftImage', 'giftCost', 'giftCustomer']) {
      assert.match(view, new RegExp(`<label for="${id}">`));
      assert.match(view, new RegExp(`<input id="${id}"[^>]*\\bdisabled(?:>|\\s)`));
    }
    assert.match(view, /<label for="giftCost">[^<]*\(AB\)/);
    assert.match(view, /<input id="giftCost"[^>]*min="0"[^>]*max="1000000000"[^>]*step="0\.01"/);
    assert.match(view, /<label for="giftCustomer">[^<]*\(AC\)/);
    assert.match(view, /<label for="giftImage">[^<]*\(AD\)/);
    assert.match(view, /id="giftFeedback"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(view, /id="giftPagination"[^>]*aria-label="[^"]+"[^>]*hidden/);
  });

  test(`${name}: gift module loads once before application initialization`, () => {
    const matches = [...source.matchAll(/<script src="gifts\.js(?:\?[^"\s]+)?"><\/script>/g)];
    assert.equal(matches.length, 1);
    const appStart = name === 'index.html'
      ? source.search(/<script src="app\.js(?:\?[^"\s]+)?">/)
      : source.indexOf('/* seek n tique — live sales dashboard');
    assert.ok(appStart > matches[0].index);
    assert.ok(source.indexOf('id="giftForm"') < matches[0].index);
  });
}

test('gift form uses white editable inputs, mobile stacking and uncropped shared images', () => {
  assert.match(giftStyles(css), /#giftForm input\s*\{\s*background:\s*#fff;/);
  assert.match(giftStyles(css), /@media\s*\(max-width:\s*600px\)[\s\S]*#giftForm\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.draft-table-image img\s*\{[^}]*object-fit:\s*contain;/);
  assert.match(css, /\.draft-table-wrap\s*\{[^}]*overflow-x:\s*auto;/);
});

test('gift integration hooks match the standalone application', () => {
  for (const name of ['refreshActiveGifts', 'startPolling', 'initApp']) {
    assert.equal(functionSource(app, name), functionSource(entries[1].source, name));
  }
});

test('automatic gift refresh is read-only and requires both login and the active gift page', async () => {
  for (const loggedIn of [false, true]) {
    for (const active of [false, true]) {
      const calls = [];
      const context = vm.createContext({
        window: { SNTGifts: {
          init() { calls.push('init'); },
          refresh() { calls.push('refresh'); return Promise.resolve(); },
        } },
        isAlreadyLoggedIn: () => loggedIn,
        document: { getElementById: id => {
          assert.equal(id, 'view-gifts');
          return { classList: { contains: value => value === 'active' && active } };
        } },
      });
      vm.runInContext(functionSource(app, 'refreshActiveGifts'), context);
      vm.runInContext('refreshActiveGifts()', context);
      await Promise.resolve();
      assert.deepEqual(calls, loggedIn && active ? ['init', 'refresh'] : []);
    }
  }
});

test('missing gift module or an unavailable gift API does not break other app features', async () => {
  const context = vm.createContext({
    window: {}, isAlreadyLoggedIn: () => true,
    document: { getElementById: () => ({ classList: { contains: () => true } }) },
  });
  vm.runInContext(functionSource(app, 'refreshActiveGifts'), context);
  assert.doesNotThrow(() => vm.runInContext('refreshActiveGifts()', context));
  let refreshed = false;
  context.window.SNTGifts = {
    init() {}, refresh() { refreshed = true; return Promise.reject(new Error('API unavailable')); },
  };
  assert.doesNotThrow(() => vm.runInContext('refreshActiveGifts()', context));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshed, true);
});

test('config changes invalidate gifts before refreshing the new sheet', () => {
  const start = app.indexOf("document.getElementById('settingsSave').addEventListener('click', () => {");
  const end = app.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start);
  const callbacks = new Map();
  const calls = [];
  const values = {
    cfgSheetId: 'new-sheet', cfgSheetName: 'New Products', cfgStatusCol: 'O',
    cfgInterval: '60', cfgWebAppUrl: 'https://example.test/api',
  };
  const context = vm.createContext({
    config: { sheetId: 'old-sheet' }, DEFAULTS: { sheetId: 'default-sheet' },
    cachedAutoStatusCol: 1, latestFinanceObservedAt: 1,
    savedFinanceSnapshots: [{}], historyRows: [{}], historyLoadSequence: 0,
    document: { getElementById: id => ({
      value: values[id], addEventListener: (type, callback) => callbacks.set(`${id}:${type}`, callback),
    }) },
    window: { SNTDrafts: { resetForConfig() { calls.push('draft-reset'); } }, SNTGifts: {
      resetForConfig() { calls.push('gift-reset:' + context.config.sheetId); },
    } },
    saveConfig() { calls.push('save-config'); }, closeSettings() {},
    refreshActiveGifts() { calls.push('gift-refresh:' + context.config.sheetId); },
    loadData() { calls.push('products'); }, loadRevenueHistory() { calls.push('history'); },
    startPolling() { calls.push('polling'); },
  });
  vm.runInContext(app.slice(start, end + 4), context);
  callbacks.get('settingsSave:click')();
  assert.deepEqual(calls, [
    'draft-reset', 'gift-reset:new-sheet', 'save-config', 'gift-refresh:new-sheet',
    'products', 'history', 'polling',
  ]);
  assert.equal(context.historyLoadSequence, 1, 'config reset invalidates old-sheet history reads immediately');
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function makeHistoryHarness() {
  const nodes = new Map();
  const reads = [];
  const renders = [];
  const context = vm.createContext({
    config: { sheetId: 'first-sheet', sheetName: 'Products', webAppUrl: 'https://example.test/first' },
    document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', classList: { add() {}, remove() {} } });
      return nodes.get(id);
    } },
    Date, Map, console: { warn() {} },
    fetch(url) { const read = deferred(); reads.push({ ...read, url }); return read.promise; },
    buildHistoryUrl: config => 'test-history:' + config.sheetId,
    parseGviz: JSON.parse,
    renderTrendChart() { renders.push('revenue'); },
    renderProfitChart() { renders.push('profit'); },
    renderExpenseChart() { renders.push('expense'); },
    fmtChartMoney: value => String(value),
  });
  vm.runInContext('let historyRows = []; let savedFinanceSnapshots = []; let historyLoadSequence = 0; let latestFinanceObservedAt = 0; let draftFinanceRevision = 0;', context);
  for (const name of ['cellNumber', 'parseGvizDate', 'mergeFinanceHistory', 'addFinanceSnapshot', 'loadRevenueHistory', 'applyDraftFinance', 'showDraftFinanceError']) {
    vm.runInContext(functionSource(app, name), context);
  }
  function reply(index, rows) {
    reads[index].resolve({ ok: true, text: async () => JSON.stringify({ rows: rows.map(row => ({ c: [
      { v: row.date }, { v: row.revenue }, { v: row.profit }, { v: row.expense },
    ] })) }) });
  }
  const run = source => vm.runInContext(source, context);
  return { context, nodes, reads, renders, run, reply, history: () => JSON.parse(run('JSON.stringify(historyRows)')) };
}

const beforeGift = { date: '2026-10-13T05:00:00.000Z', revenue: 1000, expense: 600, profit: 400 };
const afterGift = { date: '2026-10-13T06:00:00.000Z', revenue: 1000, expense: 650, profit: 350 };

test('cached public history cannot erase a confirmed gift save snapshot', async () => {
  const h = makeHistoryHarness();
  const request = h.run('loadRevenueHistory()');
  h.run(`addFinanceSnapshot(${JSON.stringify(afterGift)})`);
  h.reply(0, [beforeGift]);
  await request;
  assert.deepEqual(h.history(), [beforeGift, afterGift]);
  assert.equal(h.run('savedFinanceSnapshots.length'), 1);
});

test('an older same-sheet history success cannot replace a newer read', async () => {
  const h = makeHistoryHarness();
  const older = h.run('loadRevenueHistory()');
  const newer = h.run('loadRevenueHistory()');
  h.reply(1, [beforeGift, afterGift]);
  await newer;
  const renders = h.renders.length;
  h.reply(0, [beforeGift]);
  await older;
  assert.deepEqual(h.history(), [beforeGift, afterGift]);
  assert.equal(h.renders.length, renders);
});

test('an older failed history read cannot blank newer chart results', async () => {
  const h = makeHistoryHarness();
  const older = h.run('loadRevenueHistory()');
  const newer = h.run('loadRevenueHistory()');
  h.reply(1, [afterGift]);
  await newer;
  h.reads[0].reject(new Error('old request timed out'));
  await older;
  assert.deepEqual(h.history(), [afterGift]);
  assert.equal(h.nodes.size, 0, 'stale failure does not touch empty-state chart markup');
});

test('old-sheet history success and failure cannot contaminate a new gift snapshot', async () => {
  for (const outcome of ['success', 'failure']) {
    const h = makeHistoryHarness();
    const oldRead = h.run('loadRevenueHistory()');
    h.context.config = { sheetId: 'new-sheet', sheetName: 'Other Products', webAppUrl: 'https://example.test/new' };
    h.run(`historyRows = []; savedFinanceSnapshots = []; addFinanceSnapshot(${JSON.stringify(afterGift)})`);
    const renders = h.renders.length;
    if (outcome === 'success') h.reply(0, [beforeGift]);
    else h.reads[0].reject(new Error('old sheet unreachable'));
    await oldRead;
    assert.deepEqual(h.history(), [afterGift]);
    assert.equal(h.renders.length, renders);
  }
});

test('source changes to tab or API invalidate pending history even before the next fetch', async () => {
  for (const key of ['sheetName', 'webAppUrl']) {
    const h = makeHistoryHarness();
    const oldRead = h.run('loadRevenueHistory()');
    h.context.config[key] += '-changed';
    h.reply(0, [beforeGift]);
    await oldRead;
    assert.deepEqual(h.history(), []);
    assert.deepEqual(h.renders, []);
  }
});

test('late finance failure cannot replace a newer confirmed gift or draft total', () => {
  const h = makeHistoryHarness();
  h.run(`applyDraftFinance({revenue:1000,expense:650,profit:350,draftCost:100,observedAt:'2026-10-13T06:00:00.000Z'})`);
  h.run(`showDraftFinanceError(new Error('old read failed'), '2026-10-13T05:00:00.000Z')`);
  assert.equal(h.nodes.get('expenseVal').textContent, '650');
  assert.equal(h.nodes.get('profitVal').textContent, '350');
});

test('newer finance error invalidates stale totals and blocks an older late success', () => {
  const h = makeHistoryHarness();
  h.run(`applyDraftFinance({revenue:1000,expense:600,profit:400,draftCost:100,observedAt:'2026-10-13T05:00:00.000Z'})`);
  h.run(`showDraftFinanceError(new Error('current finance formula invalid'), '2026-10-13T06:00:00.000Z')`);
  assert.equal(h.nodes.get('expenseVal').textContent, '–');
  h.run(`applyDraftFinance({revenue:1000,expense:625,profit:375,draftCost:100,observedAt:'2026-10-13T05:30:00.000Z'})`);
  assert.equal(h.nodes.get('expenseVal').textContent, '–');
  h.run(`applyDraftFinance({revenue:1000,expense:650,profit:350,draftCost:100,observedAt:'2026-10-13T07:00:00.000Z'})`);
  assert.equal(h.nodes.get('expenseVal').textContent, '650');
});

test('shared gift finance and history hooks remain identical in both dashboard versions', () => {
  for (const name of ['applyDraftFinance', 'showDraftFinanceError', 'addFinanceSnapshot', 'loadRevenueHistory']) {
    assert.equal(functionSource(app, name), functionSource(entries[1].source, name));
  }
});

test('failed Draft refresh carries the shared finance revision from its original request', async () => {
  const read = deferred();
  const context = vm.createContext({
    configEpoch: 1, configKey: 'sheet', stateVersion: 1, draftFinanceRevision: 4,
    refreshRequest: null, available: true, lastState: {}, loadError: '',
    ensureConfig() {}, currentConfigKey: () => 'sheet',
    callWriteApi: () => read.promise,
    applyState: state => state,
    errorMessage: error => error.message,
    feedback() {}, renderList() {}, renderPicker() {}, renderControls() {},
  });
  vm.runInContext(functionSource(drafts.replace(/^  /gm, ''), 'refresh'), context);
  const pending = vm.runInContext('refresh()', context);
  context.draftFinanceRevision = 5; // A gift save is confirmed while the read is in flight.
  read.reject(new Error('older Draft read failed'));
  await assert.rejects(pending, error => {
    assert.equal(error.message, 'older Draft read failed');
    assert.equal(error.financeRevision, 4);
    return true;
  });
});

function makeLoadDataHarness(errorRevision) {
  const nodes = new Map();
  const errors = [];
  const failure = new Error('Draft refresh unavailable');
  if (errorRevision !== undefined) failure.financeRevision = errorRevision;
  const context = vm.createContext({
    config: { sheetId: 'sheet', statusCol: 'O' }, dataLoadSequence: 0,
    draftFinanceRevision: 5, cachedAutoStatusCol: null, lastRows: null, lastHeaders: [],
    window: { SNTDrafts: { refresh: async () => { throw failure; } } },
    document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', disabled: false });
      return nodes.get(id);
    } },
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ rows: [] }) }),
    buildUrl: () => 'test-products', parseGviz: JSON.parse, Date,
    cellText: cell => cell && cell.v || '', colToIndex: () => 14,
    tallyStatuses: () => ({ counts: {}, total: 0, other: 0 }),
    renderStatusGrid() {}, renderDonut() {}, renderProductTable() {}, doSearch() {},
    clearError() {}, setStatus() {}, showError() {}, console: { error() {} },
    showDraftFinanceError(error) { errors.push(error.message); },
  });
  vm.runInContext(functionSource(app, 'loadData'), context);
  return { run: () => vm.runInContext('loadData()', context), errors };
}

test('loadData joining a pre-gift Draft request cannot blank the newer gift totals', async () => {
  const h = makeLoadDataHarness(4);
  await h.run();
  assert.deepEqual(h.errors, []);
});

test('loadData still reports current Draft failures and failures without revision metadata', async () => {
  for (const revision of [5, undefined, NaN]) {
    const h = makeLoadDataHarness(revision);
    await h.run();
    assert.deepEqual(h.errors, ['Draft refresh unavailable']);
  }
});
