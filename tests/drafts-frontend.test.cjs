'use strict';

// Run with: node --test tests/drafts-frontend.test.cjs
// No browser, live spreadsheet, dependencies or network access are needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function makeDom() {
  const nodes = new Map();
  function node(id = '') {
    const classes = new Set();
    const listeners = new Map();
    let value = '';
    return {
      id, value: '', textContent: '', innerHTML: '', hidden: false,
      checked: false, disabled: false, readOnly: false, style: {}, dataset: {},
      children: [], attributes: {}, scrollTop: 0,
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
      removeAttribute(key) { delete this.attributes[key]; },
      getAttribute(key) { return this.attributes[key] ?? null; },
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren(...children) { this.children = children; this.innerHTML = ''; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; },
      focus() {},
      scrollIntoView() {},
      reset() {},
      reportValidity() { return true; },
      checkValidity() { return true; },
      get value() { return value; },
      set value(next) { value = String(next); },
    };
  }
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, node(id));
      return nodes.get(id);
    },
    querySelectorAll() { return []; },
    querySelector() { return node(); },
    createElement(tag) { const item = node(); item.tagName = tag.toUpperCase(); return item; },
    addEventListener() {},
  };
  return { document, nodes, node, get: id => document.getElementById(id) };
}

function extractFunction(source, name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `Missing production function: ${name}`);
  // A complete top-level function ends with a brace at the start of a line.
  for (let end = source.indexOf('\n}', match.index); end >= 0; end = source.indexOf('\n}', end + 2)) {
    const candidate = source.slice(match.index, end + 2);
    try { new vm.Script(`(${candidate})`); return candidate; } catch {}
  }
  throw new Error(`Cannot extract production function: ${name}`);
}

function makeChartHarness() {
  const dom = makeDom();
  const context = vm.createContext({
    ...dom, console: { warn() {} }, Date, Map, Number, Intl,
    config: { sheetId: 'test-sheet' },
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ rows: [] }) }),
    parseGviz: JSON.parse,
  });
  vm.runInContext(extractFunction(appSource, 'cellNumber'), context);
  const begin = appSource.indexOf('// ---------- trend charts');
  const end = appSource.indexOf('// ---------- message templates', begin);
  assert.ok(begin >= 0 && end > begin);
  vm.runInContext(appSource.slice(begin, end), context);
  return { ...dom, context, run: source => vm.runInContext(source, context) };
}

test('confirmed saved snapshot is retained when the public history feed is cached or fails', async () => {
  const h = makeChartHarness();
  h.run(`addFinanceSnapshot({date:'2026-10-12T05:00:00.000Z', revenue:1000, expense:750, profit:250})`);
  assert.equal(h.run(`buildSeries('expense')[0].value`), 750);
  h.context.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ rows: [
    { c: [{ v: '2026-10-11T05:00:00.000Z' }, { v: 1000 }, { v: 400 }, { v: 600 }] },
  ] }) });
  await h.run('loadRevenueHistory()');
  assert.equal(h.run('historyRows.length'), 2);
  assert.equal(h.run(`buildSeries('expense').at(-1).value`), 750);
  assert.equal(h.run(`getPoints(buildSeries('expense')).at(-1).value`), 750);
  h.context.fetch = async () => { throw new Error('offline'); };
  await h.run('loadRevenueHistory()');
  assert.equal(h.run('historyRows.length'), 2);
  assert.match(h.get('expenseSvgHolder').innerHTML, /<svg/);
});

test('duplicate saved snapshots do not double-count and null legacy expenses are not invented', async () => {
  const h = makeChartHarness();
  h.context.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ rows: [
    { c: [{ v: '2026-10-05T05:00:00.000Z' }, { v: 1000 }, { v: 500 }] },
    { c: [{ v: '2026-10-12T05:00:00.000Z' }, { v: 1000 }, { v: 250 }, { v: 750 }] },
  ] }) });
  h.run(`addFinanceSnapshot({date:'2026-10-12T05:00:00.000Z', revenue:1000, expense:750, profit:250})`);
  h.run(`addFinanceSnapshot({date:'2026-10-12T05:00:00.000Z', revenue:1000, expense:750, profit:250})`);
  await h.run('loadRevenueHistory()');
  assert.equal(h.run('historyRows.length'), 2);
  assert.equal(h.run('savedFinanceSnapshots.length'), 1);
  assert.equal(h.run(`buildSeries('expense').length`), 1);
  assert.equal(h.run(`buildSeries('profit').length`), 2);
});

test('one actual saved point displays immediately on all three financial charts', () => {
  const h = makeChartHarness();
  h.run(`addFinanceSnapshot({date:'2026-10-12T05:00:00.000Z', revenue:0, expense:0, profit:0})`);
  for (const [id, color] of [['trendSvgHolder', '#1a63a8'], ['profitSvgHolder', '#d4af37'], ['expenseSvgHolder', '#dc2626']]) {
    const svg = h.get(id).innerHTML;
    assert.match(svg, /<svg/);
    assert.match(svg, /class="chart-dot"/);
    assert.ok(svg.includes(color));
    assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
  }
});

test('latest snapshot within Monday–Sunday wins without summing cumulative expense', () => {
  const h = makeChartHarness();
  h.run(`addFinanceSnapshot({date:'2026-10-11T16:59:59.000Z', revenue:1000, expense:600, profit:400})`);
  h.run(`addFinanceSnapshot({date:'2026-10-11T17:00:00.000Z', revenue:1000, expense:700, profit:300})`);
  h.run(`addFinanceSnapshot({date:'2026-10-12T10:00:00.000Z', revenue:1000, expense:750, profit:250})`);
  assert.equal(h.run(`getPoints(buildSeries('expense')).length`), 2);
  assert.equal(h.run(`getPoints(buildSeries('expense')).at(-1).value`), 750);
  h.run(`customRange = {from:new Date('2026-10-01'), to:new Date('2026-10-02')}; renderExpenseChart()`);
  assert.match(h.get('expenseSvgHolder').innerHTML, /ไม่มีข้อมูลในช่วงวันที่เลือก/);
});

test('finance summary rejects missing draft totals and an older response cannot overwrite newer totals', () => {
  const h = makeChartHarness();
  h.run('let latestFinanceObservedAt=0; let draftFinanceRevision=0;');
  h.run(extractFunction(appSource, 'fmtMoney'));
  h.run(extractFunction(appSource, 'applyDraftFinance'));
  h.run(extractFunction(appSource, 'showDraftFinanceError'));
  assert.throws(() => h.run(`applyDraftFinance({revenue:1000,expense:600,profit:400,observedAt:'2026-10-12T04:00:00Z'})`), /ยอดรวมต้นทุน/);
  h.run(`applyDraftFinance({revenue:1000,expense:750,profit:250,draftCost:150,observedAt:'2026-10-12T05:00:00Z'})`);
  h.run(`applyDraftFinance({revenue:1000,expense:600,profit:400,draftCost:0,observedAt:'2026-10-12T04:00:00Z'})`);
  assert.equal(h.get('expenseVal').textContent, '฿750');
  assert.equal(h.get('profitVal').textContent, '฿250');
  assert.match(h.get('draftFinanceStatus').textContent, /150/);
  h.run(`showDraftFinanceError(new Error('อัปเดต Apps Script'))`);
  assert.equal(h.get('expenseVal').textContent, '–');
  assert.equal(h.get('profitVal').textContent, '–');
  assert.match(h.get('draftFinanceStatus').textContent, /อัปเดต Apps Script/);
});

function state(drafts = [], at = '2026-10-12T05:00:00.000Z') {
  const draftCost = drafts.reduce((total, draft) => total + draft.cost, 0);
  return {
    spreadsheetId: 'test-sheet', sourceSheetName: 'Products', drafts,
    finance: { revenue: 1000, expense: 600 + draftCost, profit: 400 - draftCost, draftCost, observedAt: at },
  };
}

const draftA = { id: '00000000-0000-4000-8000-000000000001', image: 'https://images.example.test/a.jpg', cost: 150, revision: 1 };

function makeDraftHarness() {
  const dom = makeDom();
  const calls = [];
  const applied = [];
  const snapshots = [];
  const get = dom.get;
  get('draftForm').querySelectorAll = () => ['draftImage', 'draftCost', 'draftSaveBtn', 'draftCancelBtn'].map(get);
  get('draftForm').reset = () => { get('draftImage').value = ''; get('draftCost').value = ''; };
  let idCounter = 0;
  const context = vm.createContext({
    document: dom.document, URL, Date, Uint8Array, Number, console,
    config: { sheetId: 'test-sheet', sheetName: 'Products', webAppUrl: 'https://script.example.test/exec' },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}` },
    resolveImageUrl: url => url,
    confirm: () => true,
    applyDraftFinance: finance => applied.push(finance),
    addFinanceSnapshot: snapshot => snapshots.push(snapshot),
    loadData: async () => {}, loadRevenueHistory: async () => {},
  });
  context.window = context;
  context.callWriteApi = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'getDraftState') return state([draftA]);
    if (action === 'saveDraft') return state([{ ...payload, revision: payload.revision + 1 }], '2026-10-12T06:00:00.000Z');
    throw new Error('Unexpected action: ' + action);
  };
  vm.runInContext(extractFunction(appSource, 'escapeHtml'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'drafts.js'), 'utf8'), context);
  const api = context.SNTDrafts;
  async function chooseDraft(id = draftA.id) {
    api.resetProductForm(true);
    get('productUseDraft').checked = true;
    await get('productUseDraft').emit('change');
    await get('productDraftPicker').emit('click', { target: {
      closest: selector => selector === '[data-draft-select]' ? { dataset: { draftSelect: id } } : null,
    } });
  }
  async function editDraft(id = draftA.id) {
    await get('draftList').emit('click', { target: {
      closest: selector => selector === '[data-draft-edit]' ? { dataset: { draftEdit: id } } : null,
    } });
  }
  return { ...dom, context, api, calls, applied, snapshots, chooseDraft, editDraft, run: source => vm.runInContext(source, context) };
}

test('create draft accepts an image and zero cost, passes a stable ID, and applies server finance', async () => {
  const h = makeDraftHarness();
  await h.api.refresh();
  h.get('draftImage').value = 'https://images.example.test/free.jpg';
  h.get('draftCost').value = '0';
  await h.get('draftForm').emit('submit');
  const save = h.calls.find(call => call.action === 'saveDraft');
  assert.ok(save);
  assert.equal(save.payload.cost, 0);
  assert.equal(save.payload.image, 'https://images.example.test/free.jpg');
  assert.equal(save.payload.revision, 0);
  assert.match(save.payload.id, /^[a-f0-9-]{36}$/);
  assert.equal(h.applied.at(-1).draftCost, 0);
  assert.equal(h.get('draftCost').value, '');
  assert.equal(h.get('draftSaveBtn').disabled, false);
});

test('edit draft retains its ID and revision while updating image and cost', async () => {
  const h = makeDraftHarness();
  await h.api.refresh();
  await h.editDraft();
  assert.equal(h.get('draftCost').value, '150');
  h.get('draftImage').value = 'https://images.example.test/edited.jpg';
  h.get('draftCost').value = '125.50';
  await h.get('draftForm').emit('submit');
  const save = h.calls.find(call => call.action === 'saveDraft');
  assert.equal(save.payload.id, draftA.id);
  assert.equal(save.payload.revision, 1);
  assert.equal(save.payload.cost, 125.5);
  assert.equal(save.payload.image, 'https://images.example.test/edited.jpg');
});

test('invalid image or absent/negative/overprecision cost cannot be saved as zero', async () => {
  const h = makeDraftHarness();
  await h.api.refresh();
  for (const value of ['', '-1', '1.234', 'Infinity', '1e3', 'not a cost']) {
    h.get('draftImage').value = draftA.image;
    h.get('draftCost').value = value;
    await h.get('draftForm').emit('submit');
    assert.equal(h.get('draftFeedback').dataset.error, 'true');
  }
  h.get('draftCost').value = '1';
  for (const image of ['javascript:alert(1)', 'data:image/png;base64,x', 'https://user:password@example.test/a.jpg']) {
    h.get('draftImage').value = image;
    await h.get('draftForm').emit('submit');
  }
  assert.equal(h.calls.filter(call => call.action === 'saveDraft').length, 0);
});

test('draft choice pre-fills read-only product image/cost and unchecking restores manual inputs', async () => {
  const h = makeDraftHarness();
  await h.api.refresh();
  h.get('pfP').value = 'https://images.example.test/manual.jpg';
  h.get('pfE').value = '25';
  await h.chooseDraft();
  assert.equal(h.get('pfP').value, draftA.image);
  assert.equal(h.get('pfE').value, '150');
  assert.equal(h.get('pfP').readOnly, true);
  assert.equal(h.get('pfE').readOnly, true);
  const selection = h.api.getProductSelection();
  assert.equal(selection.draftId, draftA.id);
  assert.equal(selection.draftRevision, 1);
  h.get('productUseDraft').checked = false;
  await h.get('productUseDraft').emit('change');
  assert.equal(h.get('pfP').value, 'https://images.example.test/manual.jpg');
  assert.equal(h.get('pfE').value, '25');
  assert.equal(h.get('pfP').readOnly, false);
  assert.equal(h.get('pfE').readOnly, false);
  assert.equal(Object.keys(h.api.getProductSelection()).length, 0);
  assert.equal(h.calls.length, 1, 'choosing/unchoosing must not consume or mutate a draft');
});

test('ticking use-draft without selecting a piece is a validation error, not a normal add', async () => {
  const h = makeDraftHarness();
  await h.api.refresh();
  h.api.resetProductForm(true);
  h.get('productUseDraft').checked = true;
  await h.get('productUseDraft').emit('change');
  assert.throws(() => h.api.getProductSelection(), /เลือกสินค้าแบบร่าง/);
});

test('version conflict retains edit inputs and retries use the same draft identity', async () => {
  const h = makeDraftHarness();
  await h.api.refresh();
  await h.editDraft();
  h.get('draftImage').value = 'https://images.example.test/unsaved.jpg';
  h.get('draftCost').value = '225';
  const attempts = [];
  h.context.callWriteApi = async (action, payload) => { attempts.push({ action, payload }); throw new Error('แบบร่างเปลี่ยนแล้ว กรุณาโหลดใหม่'); };
  await h.get('draftForm').emit('submit');
  assert.equal(h.get('draftCost').value, '225');
  assert.equal(h.get('draftImage').value, 'https://images.example.test/unsaved.jpg');
  assert.match(h.get('draftFeedback').textContent, /แบบร่างเปลี่ยนแล้ว/);
  assert.equal(h.get('draftSaveBtn').disabled, false);
  await h.get('draftForm').emit('submit');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].payload.id, attempts[1].payload.id);
  assert.equal(attempts[0].payload.revision, 1);
});

test('unknown API explicitly disables draft costs instead of presenting them as zero', async () => {
  const h = makeDraftHarness();
  h.context.callWriteApi = async () => { throw new Error('Unknown action: getDraftState'); };
  await assert.rejects(h.api.refresh(), /Apps Script.*Deploy/);
  assert.equal(h.get('draftTotal').textContent, '—');
  assert.equal(h.get('draftSaveBtn').disabled, true);
  assert.equal(h.get('productUseDraft').disabled, true);
  assert.equal(h.applied.length, 0);
  assert.match(h.get('draftFeedback').textContent, /ยังไม่ได้อัปเดต/);
});

test('API tied to another spreadsheet or source tab is rejected before any write is enabled', async () => {
  for (const change of [{ spreadsheetId: 'wrong-sheet' }, { sourceSheetName: 'Other Products' }]) {
    const h = makeDraftHarness();
    h.context.callWriteApi = async () => ({ ...state([draftA]), ...change });
    await assert.rejects(h.api.refresh(), /คนละชีท/);
    assert.equal(h.get('draftSaveBtn').disabled, true);
    assert.equal(h.get('productUseDraft').disabled, true);
    assert.equal(h.applied.length, 0);
  }
});

test('newer concurrent state invalidates a selected draft and does not overwrite manual product fields', async () => {
  const h = makeDraftHarness();
  await h.api.refresh();
  h.get('pfP').value = 'https://images.example.test/manual.jpg';
  h.get('pfE').value = '25';
  await h.chooseDraft();
  h.api.applyState(state([{ ...draftA, revision: 2, cost: 170 }], '2026-10-12T06:00:00.000Z'));
  assert.equal(h.get('pfE').value, '25');
  assert.equal(h.get('pfP').value, 'https://images.example.test/manual.jpg');
  assert.equal(h.get('pfE').readOnly, false);
  assert.throws(() => h.api.getProductSelection(), /เลือกสินค้าแบบร่าง/);
  h.api.applyState(state([draftA], '2026-10-12T05:00:00.000Z'));
  assert.equal(h.applied.at(-1).draftCost, 170, 'an older successful request must not roll back totals');
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function addProductFunctions(h) {
  h.run("let productSaving = false; let productFormMode = 'add'; let productFormNo = null;");
  h.context.showDraftFinanceError = err => { h.get('draftFinanceStatus').textContent = err.message; };
  h.run(extractFunction(appSource, 'closeProductForm'));
  h.run(extractFunction(appSource, 'saveProductForm'));
  h.get('productFormBackdrop').classList.add('open');
}

test('cancelling the real product form never consumes or deletes its selected draft', async () => {
  const h = makeDraftHarness();
  await h.api.refresh();
  await h.chooseDraft();
  addProductFunctions(h);
  h.run('closeProductForm()');
  assert.equal(h.get('productFormBackdrop').classList.contains('open'), false);
  assert.equal(h.calls.filter(call => call.action !== 'getDraftState').length, 0);
  h.api.resetProductForm(true);
  assert.equal(Object.keys(h.api.getProductSelection()).length, 0);
  assert.match(h.get('draftList').innerHTML, new RegExp(draftA.id));
});

test('real product save validates empty selection and keeps all fields on a transfer conflict', async () => {
  const h = makeDraftHarness();
  await h.api.refresh();
  addProductFunctions(h);
  h.api.resetProductForm(true);
  h.get('productUseDraft').checked = true;
  await h.get('productUseDraft').emit('change');
  await h.run('saveProductForm()');
  assert.equal(h.calls.length, 1, 'no addProduct request before a draft is selected');
  assert.match(h.get('productFormError').textContent, /เลือกสินค้าแบบร่าง/);
  await h.chooseDraft();
  h.get('pfC').value = 'รายละเอียดสินค้าที่ยังกรอกไม่เสร็จ';
  const attempts = [];
  h.context.callWriteApi = async (action, payload) => { attempts.push({ action, payload }); throw new Error('แบบร่างถูกใช้งานแล้ว'); };
  await h.run('saveProductForm()');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].action, 'addProduct');
  assert.equal(attempts[0].payload.draftId, draftA.id);
  assert.equal(attempts[0].payload.draftRevision, 1);
  assert.equal(h.get('pfC').value, 'รายละเอียดสินค้าที่ยังกรอกไม่เสร็จ');
  assert.equal(h.get('pfP').value, draftA.image);
  assert.equal(h.get('pfE').value, '150');
  assert.equal(h.get('productFormBackdrop').classList.contains('open'), true);
  assert.equal(h.get('productFormSave').disabled, false);
  assert.equal(h.get('productFormCancel').disabled, false);
  assert.match(h.get('productFormError').textContent, /แบบร่างถูกใช้งานแล้ว/);
});

test('confirmed product transfer removes the draft from UI and a refresh failure cannot resubmit it', async () => {
  const h = makeDraftHarness();
  await h.api.refresh();
  await h.chooseDraft();
  addProductFunctions(h);
  const pendingRefresh = deferred();
  const refreshStarted = deferred();
  h.context.loadData = () => { refreshStarted.resolve(); return pendingRefresh.promise; };
  const attempts = [];
  h.context.callWriteApi = async (action, payload) => {
    attempts.push({ action, payload });
    return { ...state([], '2026-10-12T06:00:00.000Z'), no: 20 };
  };
  const saving = h.run('saveProductForm()');
  await refreshStarted.promise;
  assert.equal(h.get('productFormBackdrop').classList.contains('open'), false);
  assert.doesNotMatch(h.get('draftList').innerHTML, new RegExp(draftA.id));
  await h.run('saveProductForm()');
  assert.equal(attempts.length, 1, 'duplicate click during refresh must not create a second product');
  pendingRefresh.reject(new Error('public feed unavailable'));
  await saving;
  assert.equal(attempts.length, 1);
  assert.equal(h.get('productFormBackdrop').classList.contains('open'), false);
  assert.equal(h.api.isBusy(), false);
});

test('failed create retries reuse its ID and concurrent submit sends only one mutation', async () => {
  const h = makeDraftHarness();
  await h.api.refresh();
  h.get('draftImage').value = draftA.image;
  h.get('draftCost').value = '50';
  const pending = deferred();
  const attempts = [];
  h.context.callWriteApi = (action, payload) => { attempts.push({ action, payload }); return pending.promise; };
  const saving = h.get('draftForm').emit('submit');
  await h.get('draftForm').emit('submit');
  assert.equal(attempts.length, 1);
  pending.reject(new Error('Connection lost after sending'));
  await saving;
  h.context.callWriteApi = async (action, payload) => { attempts.push({ action, payload }); throw new Error('Still offline'); };
  await h.get('draftForm').emit('submit');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].payload.id, attempts[1].payload.id);
  assert.equal(h.get('draftCost').value, '50');
});

test('late failed refresh cannot disable a later successful draft save/state', async () => {
  const h = makeDraftHarness();
  await h.api.refresh();
  const pending = deferred();
  h.context.callWriteApi = () => pending.promise;
  const reading = h.api.refresh();
  h.api.applyState(state([{ ...draftA, cost: 175, revision: 2 }], '2026-10-12T06:00:00.000Z'));
  pending.reject(new Error('old request failed'));
  const result = await reading;
  assert.equal(result.finance.draftCost, 175);
  assert.equal(h.get('draftTotal').textContent, '฿175');
  assert.equal(h.get('draftSaveBtn').disabled, false);
  assert.equal(h.get('productUseDraft').disabled, false);
});

test('config changes isolate in-flight requests and clear selection without reusing old-sheet totals', async () => {
  const h = makeDraftHarness();
  await h.api.refresh();
  await h.chooseDraft();
  const oldRead = deferred();
  h.context.callWriteApi = () => oldRead.promise;
  const oldRequest = h.api.refresh();
  h.context.config = { sheetId: 'new-sheet', sheetName: 'New Products', webAppUrl: 'https://new.example.test/exec' };
  h.api.resetForConfig();
  assert.equal(h.get('draftTotal').textContent, '—');
  assert.equal(h.get('productUseDraft').checked, false);
  assert.equal(h.get('pfE').readOnly, false);
  const newState = { ...state([], '2026-10-12T04:00:00.000Z'), spreadsheetId: 'new-sheet', sourceSheetName: 'New Products' };
  h.context.callWriteApi = async () => newState;
  await h.api.refresh();
  oldRead.resolve(state([draftA], '2026-10-12T07:00:00.000Z'));
  await assert.rejects(oldRequest, /การตั้งค่าชีทเปลี่ยนแล้ว/);
  assert.equal(h.get('draftTotal').textContent, '฿0');
  assert.doesNotMatch(h.get('draftList').innerHTML, new RegExp(draftA.id));
  assert.equal(h.get('draftSaveBtn').disabled, false);
});

test('saved mutation with an unconfirmed history snapshot retains an explicit warning after reload', async () => {
  const h = makeDraftHarness();
  await h.api.refresh();
  h.get('draftImage').value = draftA.image;
  h.get('draftCost').value = '20';
  h.context.callWriteApi = async (action, payload) => ({
    ...state([{ ...payload, revision: 1 }], '2026-10-12T06:00:00.000Z'),
    warning: 'ประวัติกราฟยังบันทึกไม่สำเร็จ',
  });
  await h.get('draftForm').emit('submit');
  assert.match(h.get('draftFeedback').textContent, /ประวัติกราฟยังบันทึกไม่สำเร็จ/);
  assert.equal(h.get('draftFeedback').dataset.error, 'true');
  assert.equal(h.snapshots.length, 0);
  assert.equal(h.applied.at(-1).draftCost, 20);
  assert.equal(h.get('draftCost').value, '', 'successful mutation must not remain ready to submit again');
});

test('both product-opening paths reset previous draft bindings before filling the next product', () => {
  const add = extractFunction(appSource, 'openAddProductModal');
  const edit = extractFunction(appSource, 'openEditProductModal');
  assert.ok(add.indexOf('resetProductForm(true)') >= 0);
  assert.ok(add.indexOf('resetProductForm(true)') < add.indexOf("['pfP', 'pfE'"));
  assert.ok(edit.indexOf('resetProductForm(false)') >= 0);
  assert.ok(edit.indexOf('resetProductForm(false)') < edit.indexOf("getElementById('pfP').value"));
});

test('page includes unique draft controls and loads the module before app initialization', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const id of ['view-drafts', 'draftForm', 'draftCost', 'draftImage', 'draftList', 'draftFeedback', 'draftFinanceStatus',
    'productUseDraft', 'productDraftPicker', 'productDraftSection', 'productDraftSelectionNote']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} must exist exactly once`);
  }
  assert.ok(html.indexOf('src="drafts.js?') >= 0);
  assert.ok(html.indexOf('src="drafts.js?') < html.indexOf('src="app.js?'));
});

test('a validated late save preserves its historical snapshot without replacing newer finance or drafts', () => {
  const h = makeDraftHarness();
  const latest = state([{ ...draftA, cost: 200, revision: 3 }], '2026-10-12T07:00:00.000Z');
  h.api.applyState(latest);
  const older = {
    ...state([{ ...draftA, cost: 175, revision: 2 }], '2026-10-12T06:00:00.000Z'),
    snapshot: { date: '2026-10-12T06:00:00.000Z', revenue: 1000, expense: 775, profit: 225 },
  };
  const result = h.api.applyState(older);
  assert.equal(result.finance.draftCost, 200);
  assert.equal(h.get('draftTotal').textContent, '฿200');
  assert.equal(h.applied.length, 1, 'stale finance must not be passed to dashboard summary');
  assert.equal(h.applied[0].expense, 800);
  assert.equal(h.snapshots.length, 1, 'persisted historical point must survive out-of-order delivery');
  assert.equal(h.snapshots[0].expense, 775);
  assert.equal(h.get('draftSaveBtn').disabled, false);
  assert.throws(() => h.api.applyState({ ...older, spreadsheetId: 'wrong-sheet' }), /คนละชีท/);
  assert.equal(h.snapshots.length, 1, 'snapshot from the wrong sheet is never forwarded');
  assert.throws(() => h.api.applyState({ ...older, finance: { ...older.finance, draftCost: null } }), /ข้อมูลยอดร้านหรือแบบร่างไม่ครบ/);
  assert.equal(h.snapshots.length, 1, 'invalid states cannot sneak snapshots past validation');
});

test('pending product save disables and guards draft create/edit/delete/cancel handlers', async () => {
  const h = makeDraftHarness();
  await h.api.refresh();
  h.get('draftImage').value = 'https://images.example.test/pending.jpg';
  h.get('draftCost').value = '75';
  let confirmations = 0;
  h.context.confirm = () => { confirmations += 1; return true; };
  h.api.setProductBusy(true);
  assert.equal(h.api.isBusy(), true);
  for (const id of ['draftImage', 'draftCost', 'draftSaveBtn', 'draftCancelBtn', 'productUseDraft']) {
    assert.equal(h.get(id).disabled, true, `${id} should be disabled during product transfer`);
  }
  // Dispatch directly as well as checking disabled controls: handlers must guard themselves.
  await h.get('draftForm').emit('submit');
  await h.editDraft();
  await h.get('draftList').emit('click', { target: {
    closest: selector => selector === '[data-draft-delete]' ? { dataset: { draftDelete: draftA.id } } : null,
  } });
  await h.get('draftCancelBtn').emit('click');
  assert.equal(confirmations, 0);
  assert.equal(h.calls.length, 1, 'no draft mutation is sent while addProduct is pending');
  assert.equal(h.get('draftImage').value, 'https://images.example.test/pending.jpg');
  assert.equal(h.get('draftCost').value, '75');
  h.api.setProductBusy(false);
  assert.equal(h.get('draftSaveBtn').disabled, false);
  await h.get('draftForm').emit('submit');
  assert.equal(h.calls.filter(call => call.action === 'saveDraft').length, 1);
});
