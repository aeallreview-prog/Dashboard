'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'gifts.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const item = (row, overrides = {}) => ({ row, cost: 25, customer: '', image: '', version: 'row-' + row, readOnly: false, ...overrides });
const finance = (overrides = {}) => ({ revenue: 1000, expense: 600, profit: 400, draftCost: 100, observedAt: '2026-10-13T10:00:00.000Z', ...overrides });
const snapshot = (overrides = {}) => ({ date: '2026-10-13T10:00:00.000Z', revenue: 1000, expense: 600, profit: 400, ...overrides });
const state = (items = [], overrides = {}) => ({ spreadsheetId: 'sheet-a', sourceSheetName: 'สินค้า', items, nextRow: Math.max(2, ...items.map(entry => entry.row)) + 1, nextVersion: 'empty', observedAt: '2026-10-13T10:00:00.000Z', finance: finance(), snapshot: overrides.savedRow ? snapshot() : null, ...overrides });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(initial = state()) {
  const nodes = new Map();
  const calls = [];
  const financeCalls = [];
  const snapshotCalls = [];
  const financeErrors = [];
  const get = id => {
    if (!nodes.has(id)) {
      const listeners = new Map();
      nodes.set(id, {
        id, value: '', textContent: '', innerHTML: '', disabled: false, hidden: false, dataset: {},
        addEventListener(type, callback) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(callback);
        },
        async emit(type, extra = {}) {
          const event = { target: this, preventDefault() {}, ...extra };
          for (const callback of listeners.get(type) || []) await callback(event);
        },
        listenerCount(type) { return (listeners.get(type) || []).length; },
        querySelectorAll() { return []; },
        scrollIntoView() { this.scrolled = true; },
        focus() { this.focused = true; },
      });
    }
    return nodes.get(id);
  };
  let handler = async action => {
    if (action === 'getGiftState') return initial;
    throw new Error('Unexpected save');
  };
  const config = { sheetId: 'sheet-a', sheetName: 'สินค้า', webAppUrl: 'https://example.test/api' };
  const window = {
    applyDraftFinance(value) { financeCalls.push(plain(value)); },
    addFinanceSnapshot(value) { snapshotCalls.push(plain(value)); },
    showDraftFinanceError(error, observedAt) { financeErrors.push({ message: error.message, observedAt }); },
  };
  const context = vm.createContext({
    window, config, URL, Date, Number, Math, Set,
    document: { getElementById: get, createElement: () => get('created-image-error') },
    escapeHtml: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
    resolveImageUrl: value => value,
    callWriteApi: async (action, payload) => { calls.push({ action, payload: plain(payload) }); return handler(action, payload); },
  });
  vm.runInContext(source, context);
  const api = window.SNTGifts;
  api.init();
  return {
    api, get, calls, config, context, window, financeCalls, snapshotCalls, financeErrors,
    handler(value) { handler = value; },
    form(cost, customer = '', image = '') {
      get('giftCost').value = String(cost);
      get('giftCustomer').value = customer;
      get('giftImage').value = image;
    },
    submit() { return get('giftForm').emit('submit'); },
    edit(row) { return get('giftList').emit('click', { target: { closest: () => ({ dataset: { giftEdit: String(row) } }) } }); },
    page(target) { return get('giftPagination').emit('click', { target: { closest: () => ({ dataset: { giftPage: String(target) } }) } }); },
  };
}

test('init is idempotent and does not read or write before parent starts a logged-in refresh', async () => {
  const h = harness();
  h.api.init();
  h.api.init();
  assert.equal(h.calls.length, 0);
  assert.equal(h.get('giftForm').listenerCount('submit'), 1);
  assert.equal(h.get('giftSaveBtn').disabled, true);
  h.form(25);
  await h.submit();
  assert.equal(h.calls.length, 0);
  await h.api.refresh();
  assert.deepEqual(h.calls, [{ action: 'getGiftState', payload: { spreadsheetId: 'sheet-a', sourceSheetName: 'สินค้า' } }]);
  assert.equal(h.get('giftSaveBtn').disabled, false);
  assert.equal(h.get('giftTotal').textContent, '฿0');
});

test('new gift saves required cost and optional customer/image to the captured sheet row/version', async () => {
  const h = harness(state([item(3)]));
  await h.api.refresh();
  h.form('12.50', ' คุณเอ ', ' https://example.test/gift.jpg ');
  h.handler(async (action, payload) => {
    assert.equal(action, 'saveGift');
    assert.deepEqual(plain(payload), { spreadsheetId: 'sheet-a', sourceSheetName: 'สินค้า', row: 4, version: 'empty', cost: 12.5, customer: 'คุณเอ', image: 'https://example.test/gift.jpg' });
    return state([item(3), item(4, { ...payload, version: 'saved' })], { savedRow: 4 });
  });
  await h.submit();
  assert.equal(h.get('giftFeedback').textContent, 'บันทึกของแถมแล้ว');
  assert.equal(h.get('giftCustomer').value, '');
  assert.equal(h.get('giftTotal').textContent, '฿37.5');
  assert.deepEqual(h.calls.map(call => call.action), ['getGiftState', 'saveGift']);
  assert.doesNotMatch(source, /localStorage|loadRevenueHistory|loadData|deleteGift/);
});

test('zero cost and blank customer/image are valid; resolved fallback sheet name is pinned for writes', async () => {
  const h = harness();
  h.config.sheetName = '';
  await h.api.refresh();
  assert.equal(h.calls[0].payload.sourceSheetName, '');
  h.form('0');
  h.handler(async (_action, payload) => state([item(3, { ...payload, version: 'saved' })], { savedRow: 3 }));
  await h.submit();
  assert.deepEqual(h.calls[1].payload, { spreadsheetId: 'sheet-a', sourceSheetName: 'สินค้า', row: 3, version: 'empty', cost: 0, customer: '', image: '' });
  assert.equal(h.get('giftTotal').textContent, '฿0');
  assert.match(h.get('giftList').innerHTML, /ยังไม่ได้แถมให้ลูกค้า/);
});

test('edit fills the form, preserves row/version even if a read changes nextRow, and saves without adding a row', async () => {
  const existing = item(8, { cost: 30, customer: 'เดิม', image: 'https://example.test/old.jpg', version: 'before' });
  const h = harness(state([existing]));
  await h.api.refresh();
  await h.edit(8);
  assert.equal(h.get('giftCost').value, '30');
  assert.equal(h.get('giftCustomer').value, 'เดิม');
  assert.equal(h.get('giftForm').scrolled, true);
  assert.equal(h.get('giftCost').focused, true);
  h.handler(async action => {
    assert.equal(action, 'getGiftState');
    return state([existing], { nextRow: 12 });
  });
  await h.api.refresh();
  h.form('40', 'ใหม่');
  h.handler(async (_action, payload) => state([item(8, { ...payload, version: 'after' })], { savedRow: 8 }));
  await h.submit();
  const payload = h.calls.at(-1).payload;
  assert.equal(payload.row, 8);
  assert.equal(payload.version, 'before');
  assert.equal(h.get('giftCount').textContent, '1 ชิ้น');
});

test('frontend rejects invalid costs, oversized names and unsafe image links without writing', async () => {
  const h = harness();
  await h.api.refresh();
  for (const cost of ['', '-1', '1.234', 'Infinity', 'NaN', '1e3', '1,000', '1000000000.01', '9007199254740992']) {
    h.form(cost);
    await h.submit();
    assert.match(h.get('giftFeedback').textContent, /ต้นทุน/);
  }
  h.form('2', 'ก'.repeat(201));
  await h.submit();
  assert.match(h.get('giftFeedback').textContent, /200/);
  for (const url of ['javascript:alert(1)', 'data:image/png;base64,x', 'https://user:pass@example.test/a.jpg', 'https://example.test/' + 'a'.repeat(2000),
    'https://example.test/a b', 'https://example.test/%broken', 'https://example.test/\\bad', 'https://example.test/"bad"',
    'https://[::1]/a.jpg', 'https://example.test:65536/a.jpg', 'https://example.test:0/a.jpg', 'https://bad..test/a.jpg', 'https://999.2.3.4/a.jpg']) {
    h.form('2', '', url);
    await h.submit();
    assert.match(h.get('giftFeedback').textContent, /ลิงก์รูป/);
  }
  assert.equal(h.calls.length, 1);
  assert.equal(h.get('giftCost').disabled, false);
});

test('customer text and image URLs are escaped, invalid existing URLs never become image sources', async () => {
  const customer = '<img src=x onerror="alert(1)">';
  const h = harness(state([item(3, { customer, image: 'javascript:alert(1)' }), item(4, { image: 'https://example.test/a?x=%22bad%22&y=ok' })]));
  await h.api.refresh();
  const html = h.get('giftList').innerHTML;
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(!html.includes(customer));
  assert.doesNotMatch(html, /src="javascript:/);
  assert.ok(html.includes('?x=%22bad%22&amp;y=ok'));
  assert.match(html, /class="draft-table-image"/);
});

test('pagination shows ten uncropped-image frames per page while count and total include every gift', async () => {
  const h = harness(state(Array.from({ length: 23 }, (_, index) => item(index + 3, { cost: index }))));
  await h.api.refresh();
  assert.equal((h.get('giftList').innerHTML.match(/data-gift-row=/g) || []).length, 10);
  assert.equal(h.get('giftTotal').textContent, '฿253');
  assert.equal(h.get('giftCount').textContent, '23 ชิ้น');
  assert.match(h.get('giftPagination').innerHTML, /แสดง 1–10 จาก 23/);
  await h.page(3);
  assert.equal((h.get('giftList').innerHTML.match(/data-gift-row=/g) || []).length, 3);
  assert.match(h.get('giftPagination').innerHTML, /แสดง 21–23 จาก 23/);
  assert.equal(h.get('giftTotal').textContent, '฿253');
  await h.page(100);
  assert.match(h.get('giftPagination').innerHTML, /แสดง 21–23 จาก 23/);
});

test('null costs are visibly incomplete and formula rows cannot be edited', async () => {
  const h = harness(state([item(3, { cost: null, readOnly: true }), item(4, { cost: 0 }), item(5, { cost: 15 })]));
  await h.api.refresh();
  assert.equal(h.get('giftTotal').textContent, '— · ขาดต้นทุน 1 ชิ้น');
  assert.match(h.get('giftList').innerHTML, /<strong>—<\/strong>/);
  assert.match(h.get('giftList').innerHTML, /มีสูตรในชีท · อ่านอย่างเดียว/);
  assert.doesNotMatch(h.get('giftList').innerHTML, /data-gift-edit="3"/);
  await h.edit(3);
  assert.equal(h.get('giftFormTitle').textContent, 'เพิ่มของแถม');
  assert.equal(h.get('giftCost').value, '');
});

test('unknown backend action gives an actionable Apps Script redeploy message and cannot write', async () => {
  const h = harness();
  h.handler(async () => { throw new Error('Unknown action: getGiftState'); });
  await assert.rejects(h.api.refresh(), /Unknown action/);
  assert.match(h.get('giftFeedback').textContent, /Apps Script.*Deploy/);
  assert.equal(h.get('giftSaveBtn').disabled, true);
  h.form(5);
  await h.submit();
  assert.equal(h.calls.length, 1);
});

test('missing save action preserves values but requires an updated backend and fresh read before retry', async () => {
  const h = harness();
  await h.api.refresh();
  h.form(25, 'A');
  h.handler(async () => { throw new Error('unknown action: saveGift'); });
  await h.submit();
  assert.equal(h.get('giftCustomer').value, 'A');
  assert.equal(h.get('giftSaveBtn').disabled, true);
  assert.equal(h.get('giftTotal').textContent, '—');
  assert.match(h.get('giftFeedback').textContent, /Apps Script.*Deploy/);
  await h.submit();
  assert.equal(h.calls.length, 2);
});

test('wrong workbook, wrong tab and malformed states keep writes disabled', async () => {
  for (const badState of [
    state([], { spreadsheetId: 'wrong' }), state([], { sourceSheetName: 'wrong' }),
    state([], { sourceSheetName: '' }), state([], { nextVersion: '' }),
    state([], { observedAt: 'invalid' }), state([item(2)]),
    state([item(3)], { nextRow: 3 }), state([item(3), item(3)]),
    state([item(3, { cost: NaN })]), state([item(3, { readOnly: undefined })]),
  ]) {
    const h = harness(badState);
    await assert.rejects(h.api.refresh());
    assert.equal(h.get('giftSaveBtn').disabled, true);
    h.form(1);
    await h.submit();
    assert.equal(h.calls.length, 1);
  }
});

test('failed refresh retains visible rows but marks totals unavailable and blocks writes until verified again', async () => {
  const h = harness(state([item(3)]));
  await h.api.refresh();
  h.handler(async () => { throw new Error('offline'); });
  await assert.rejects(h.api.refresh(), /offline/);
  assert.match(h.get('giftList').innerHTML, /data-gift-row="3"/);
  assert.equal(h.get('giftTotal').textContent, '—');
  assert.equal(h.get('giftSaveBtn').disabled, true);
  assert.equal(h.get('giftFeedback').textContent, 'offline');
  h.handler(async () => state([item(3)]));
  await h.api.refresh();
  assert.equal(h.get('giftSaveBtn').disabled, false);
});

test('double submit is blocked and an uncertain create retries identical values/row/version after refresh', async () => {
  const h = harness();
  await h.api.refresh();
  h.form('25', 'A', 'https://example.test/a.jpg');
  const wait = deferred();
  h.handler(async () => wait.promise);
  const first = h.submit();
  await h.submit();
  assert.equal(h.calls.length, 2);
  assert.equal(h.get('giftSaveBtn').disabled, true);
  await h.api.refresh();
  assert.equal(h.calls.length, 2, 'refresh does not race a write');
  wait.reject(new Error('response lost'));
  await first;
  const attempted = h.calls[1].payload;
  assert.equal(h.get('giftCost').value, '25');
  assert.equal(h.get('giftCost').disabled, true);
  assert.equal(h.get('giftSaveBtn').disabled, false);
  assert.match(h.get('giftFeedback').textContent, /รายการเดิมโดยไม่เพิ่มแถวใหม่/);
  h.handler(async action => {
    assert.equal(action, 'getGiftState');
    return state([item(3, { ...attempted, version: 'saved' })]);
  });
  await h.api.refresh();
  h.form(999, 'programmatic changes must not affect retry');
  h.handler(async (_action, payload) => {
    assert.deepEqual(plain(payload), attempted);
    return state([item(3, { ...payload, version: 'saved' })], { savedRow: 3 });
  });
  await h.submit();
  assert.deepEqual(h.calls.at(-1).payload, attempted);
  assert.equal(h.get('giftCount').textContent, '1 ชิ้น');
  assert.equal(h.get('giftFeedback').textContent, 'บันทึกของแถมแล้ว');
});

test('version conflict retains form, blocks blind retry, and cancel requires a new read before adding', async () => {
  const h = harness(state([item(3)]));
  await h.api.refresh();
  await h.edit(3);
  h.form(45, 'A');
  h.handler(async () => { throw new Error('Gift conflict: row changed'); });
  await h.submit();
  assert.equal(h.get('giftCustomer').value, 'A');
  assert.equal(h.get('giftSaveBtn').disabled, true);
  assert.match(h.get('giftFeedback').textContent, /โหลดล่าสุด.*เลือกแก้ไขใหม่/);
  await h.submit();
  assert.equal(h.calls.length, 2);
  await h.get('giftCancelBtn').emit('click');
  assert.equal(h.get('giftCustomer').value, '');
  assert.equal(h.get('giftSaveBtn').disabled, true);
  assert.match(h.get('giftFeedback').textContent, /ตรวจสอบรายการก่อนเพิ่มใหม่/);
});

test('server formula protection is a conflict and never blindly retries overwriting formulas', async () => {
  const h = harness(state([item(3)]));
  await h.api.refresh();
  await h.edit(3);
  h.form(45);
  h.handler(async () => { throw new Error('แถวของแถมนี้มีสูตรอยู่ ระบบจะไม่เขียนทับ กรุณาตรวจสอบในชีท'); });
  await h.submit();
  assert.equal(h.get('giftSaveBtn').disabled, true);
  assert.match(h.get('giftFeedback').textContent, /โหลดล่าสุด/);
  await h.submit();
  assert.equal(h.calls.length, 2);
});

test('success response must confirm exact saved row and values; malformed success never clears the form', async () => {
  for (const result of [state([item(3)], { savedRow: 4 }), state([item(3, { customer: 'wrong' })], { savedRow: 3 }), state([], { savedRow: 3 })]) {
    const h = harness();
    await h.api.refresh();
    h.form(25, 'A');
    h.handler(async () => result);
    await h.submit();
    assert.equal(h.get('giftCustomer').value, 'A');
    assert.match(h.get('giftFeedback').textContent, /ยังยืนยัน/);
    assert.notEqual(h.get('giftFeedback').textContent, 'บันทึกของแถมแล้ว');
  }
});

test('a read started before a save cannot overwrite saved rows or report its late failure', async () => {
  for (const fail of [false, true]) {
    const h = harness();
    await h.api.refresh();
    const read = deferred();
    h.handler(async action => action === 'getGiftState' ? read.promise : state([item(3, { customer: 'A' })], { savedRow: 3 }));
    const refresh = h.api.refresh();
    h.form(25, 'A');
    await h.submit();
    if (fail) read.reject(new Error('late offline')); else read.resolve(state());
    await refresh;
    assert.equal(h.get('giftCount').textContent, '1 ชิ้น');
    assert.equal(h.get('giftTotal').textContent, '฿25');
    assert.equal(h.get('giftFeedback').textContent, 'บันทึกของแถมแล้ว');
    assert.equal(h.get('giftSaveBtn').disabled, false);
  }
});

test('configuration reset ignores late read success/failure and starts the new workbook cleanly', async () => {
  for (const fail of [false, true]) {
    const h = harness();
    const read = deferred();
    h.handler(async () => read.promise);
    const first = h.api.refresh();
    h.config.sheetId = 'sheet-b';
    h.config.sheetName = 'ใหม่';
    h.api.resetForConfig();
    h.handler(async () => state([item(3, { cost: 66 })], { spreadsheetId: 'sheet-b', sourceSheetName: 'ใหม่' }));
    await h.api.refresh();
    if (fail) read.reject(new Error('old error')); else read.resolve(state([item(3)]));
    await first;
    assert.equal(h.get('giftTotal').textContent, '฿66');
    assert.equal(h.get('giftFeedback').textContent, 'โหลดข้อมูลของแถมล่าสุดแล้ว');
    assert.equal(h.get('giftSaveBtn').disabled, false);
    assert.equal(h.get('giftForm').listenerCount('submit'), 1);
  }
});

test('configuration reset isolates old save success/failure from a new form and its in-flight save', async () => {
  for (const fail of [false, true]) {
    const h = harness();
    await h.api.refresh();
    h.form(25, 'old');
    const oldWrite = deferred();
    h.handler(async () => oldWrite.promise);
    const first = h.submit();
    h.config.sheetId = 'sheet-b';
    h.api.resetForConfig();
    h.handler(async () => state([], { spreadsheetId: 'sheet-b' }));
    await h.api.refresh();
    h.form(55, 'new');
    const newWrite = deferred();
    h.handler(async () => newWrite.promise);
    const second = h.submit();
    if (fail) oldWrite.reject(new Error('old save failed'));
    else oldWrite.resolve(state([item(3, { customer: 'old' })], { savedRow: 3 }));
    await first;
    assert.equal(h.get('giftCustomer').value, 'new');
    assert.equal(h.get('giftSaveBtn').disabled, true);
    assert.equal(h.get('giftFeedback').textContent, 'กำลังบันทึกของแถม…');
    newWrite.resolve(state([item(3, { cost: 55, customer: 'new' })], { spreadsheetId: 'sheet-b', savedRow: 3 }));
    await second;
    assert.equal(h.get('giftTotal').textContent, '฿55');
    assert.equal(h.get('giftFeedback').textContent, 'บันทึกของแถมแล้ว');
  }
});

test('changing config without explicit reset is detected before a save can target stale data', async () => {
  const h = harness();
  await h.api.refresh();
  h.form(25, 'A');
  h.config.webAppUrl = 'https://other.test/api';
  await h.submit();
  assert.equal(h.calls.length, 1);
  assert.equal(h.get('giftSaveBtn').disabled, true);
  assert.equal(h.get('giftTotal').textContent, '—');
});

test('reads and saves forward authoritative finance unchanged without adding AB costs again', async () => {
  const initial = state([item(3, { cost: 500 })], { finance: finance({ expense: 600, profit: 400 }) });
  const h = harness(initial);
  await h.api.refresh();
  assert.deepEqual(h.financeCalls, [initial.finance]);
  assert.equal(h.financeCalls[0].expense, 600, 'the AB list total is not added to T2 again');
  assert.equal(h.snapshotCalls.length, 0, 'a read with no snapshot does not invent a chart point');
  h.form(100, 'A');
  const savedFinance = finance({ expense: 700, profit: 300, observedAt: '2026-10-13T11:00:00.000Z' });
  const savedSnapshot = snapshot({ expense: 700, profit: 300, date: '2026-10-13T11:00:00.000Z' });
  h.handler(async (_action, payload) => state([item(3, { cost: 500 }), item(4, { ...payload, version: 'saved' })], {
    savedRow: 4, finance: savedFinance, snapshot: savedSnapshot, observedAt: savedFinance.observedAt,
  }));
  await h.submit();
  assert.deepEqual(h.financeCalls.at(-1), savedFinance);
  assert.deepEqual(h.snapshotCalls, [savedSnapshot]);
  assert.equal(h.get('giftTotal').textContent, '฿600', 'gift-only total stays distinct from shop finance');
  assert.equal(h.get('giftFeedback').textContent, 'บันทึกของแถมแล้ว');
  assert.equal(h.financeErrors.length, 0);
});

test('confirmed all-zero shop totals are valid and are not replaced by gift-list totals', async () => {
  const zero = finance({ revenue: 0, expense: 0, profit: 0, draftCost: 0 });
  const h = harness(state([item(3)], { finance: zero }));
  await h.api.refresh();
  assert.deepEqual(h.financeCalls, [zero]);
  assert.equal(h.financeErrors.length, 0);
  assert.equal(h.get('giftFeedback').dataset.error, 'false');
});

test('legacy reads missing finance retain the list and permit save, with redeploy warning and stale totals', async () => {
  const old = state([item(3)], { finance: undefined, snapshot: undefined });
  const h = harness(old);
  await h.api.refresh();
  assert.equal(h.get('giftCount').textContent, '1 ชิ้น');
  assert.match(h.get('giftList').innerHTML, /data-gift-row="3"/);
  assert.equal(h.get('giftSaveBtn').disabled, false);
  assert.match(h.get('giftFeedback').textContent, /โหลดข้อมูลของแถมล่าสุดแล้ว.*Apps Script.*Deploy/);
  assert.equal(h.financeCalls.length, 0);
  assert.equal(h.financeErrors.length, 1);
  assert.equal(h.financeErrors[0].observedAt, old.observedAt);
  h.form(30, 'A');
  h.handler(async (_action, payload) => state([item(3), item(4, { ...payload, version: 'saved' })], { savedRow: 4 }));
  await h.submit();
  assert.equal(h.get('giftFeedback').textContent, 'บันทึกของแถมแล้ว');
  assert.equal(h.financeCalls.length, 1);
});

test('a confirmed save with missing or invalid finance is partial success and never retains a create retry', async () => {
  for (const brokenFinance of [undefined, null, finance({ expense: NaN }), finance({ profit: '400' }), finance({ observedAt: 'bad-date' }), {}]) {
    const h = harness();
    await h.api.refresh();
    h.form(25, 'A');
    h.handler(async (_action, payload) => state([item(3, { ...payload, version: 'saved' })], {
      savedRow: 3, finance: brokenFinance, financeWarning: 'สูตร T2 ยังไม่พร้อม', snapshot: null, snapshotWarning: 'ยังไม่บันทึกกราฟเพราะยอดร้านไม่พร้อม',
    }));
    await h.submit();
    assert.equal(h.get('giftCustomer').value, '');
    assert.equal(h.get('giftCost').value, '');
    assert.equal(h.get('giftCost').disabled, false);
    assert.equal(h.get('giftCancelBtn').hidden, true);
    assert.equal(h.get('giftSaveBtn').textContent, 'บันทึกของแถม');
    assert.equal(h.get('giftCount').textContent, '1 ชิ้น');
    assert.match(h.get('giftFeedback').textContent, /^บันทึกของแถมแล้ว แต่ .*สูตร T2.*กราฟ/);
    assert.doesNotMatch(h.get('giftFeedback').textContent, /กดบันทึกซ้ำ/);
    assert.equal(h.financeErrors.length, 1);
    assert.equal(h.snapshotCalls.length, 0);
    await h.submit();
    assert.equal(h.calls.length, 2, 'empty reset form cannot repeat the old create');
  }
});

test('missing, malformed and failed snapshots warn without undoing confirmed gift or clearing valid finance', async () => {
  for (const brokenSnapshot of [undefined, null, snapshot({ date: 'bad-date' }), snapshot({ expense: '600' }), {}]) {
    const h = harness();
    await h.api.refresh();
    h.form(25, 'A');
    h.handler(async (_action, payload) => state([item(3, { ...payload, version: 'saved' })], { savedRow: 3, snapshot: brokenSnapshot }));
    await h.submit();
    assert.equal(h.get('giftCustomer').value, '');
    assert.equal(h.get('giftCount').textContent, '1 ชิ้น');
    assert.equal(h.get('giftSaveBtn').textContent, 'บันทึกของแถม');
    assert.equal(h.financeCalls.length, 2);
    assert.equal(h.financeErrors.length, 0);
    assert.equal(h.snapshotCalls.length, 0);
    assert.match(h.get('giftFeedback').textContent, /^บันทึกของแถมแล้ว แต่ .*กราฟ/);
    assert.doesNotMatch(h.get('giftFeedback').textContent, /กดบันทึกซ้ำ/);
  }
  const h = harness();
  await h.api.refresh();
  h.form(25, 'A');
  h.handler(async (_action, payload) => state([item(3, { ...payload, version: 'saved' })], {
    savedRow: 3, snapshot: null, snapshotWarning: 'หัวคอลัมน์ RevenueHistory ไม่ตรง',
  }));
  await h.submit();
  assert.match(h.get('giftFeedback').textContent, /^บันทึกของแถมแล้ว แต่ .*RevenueHistory/);
  assert.equal(h.get('giftCustomer').value, '');
  assert.equal(h.financeErrors.length, 0);
});

test('dashboard renderer errors cannot turn a confirmed gift save into an uncertain retry', async () => {
  for (const failingHelper of ['applyDraftFinance', 'addFinanceSnapshot']) {
    const h = harness();
    await h.api.refresh();
    h.window[failingHelper] = () => { throw new Error('render failed'); };
    h.window.showDraftFinanceError = () => { throw new Error('status failed too'); };
    h.form(25, 'A');
    h.handler(async (_action, payload) => state([item(3, { ...payload, version: 'saved' })], { savedRow: 3 }));
    await h.submit();
    assert.equal(h.get('giftCustomer').value, '');
    assert.equal(h.get('giftSaveBtn').textContent, 'บันทึกของแถม');
    assert.equal(h.get('giftCount').textContent, '1 ชิ้น');
    assert.match(h.get('giftFeedback').textContent, /^บันทึกของแถมแล้ว แต่ .*render failed/);
    assert.doesNotMatch(h.get('giftFeedback').textContent, /กดบันทึกซ้ำ/);
  }
});

test('read-only snapshot warnings do not lose the gift list or valid finance', async () => {
  const h = harness(state([item(3)], { snapshotWarning: 'ยังอ่านประวัติกราฟไม่ได้' }));
  await h.api.refresh();
  assert.equal(h.get('giftCount').textContent, '1 ชิ้น');
  assert.equal(h.financeCalls.length, 1);
  assert.equal(h.snapshotCalls.length, 0);
  assert.equal(h.financeErrors.length, 0);
  assert.match(h.get('giftFeedback').textContent, /โหลดข้อมูลของแถมล่าสุดแล้ว.*ยังอ่านประวัติกราฟไม่ได้/);
});

test('a stale read cannot replace saved finance, add chart points, or clear totals for missing finance', async () => {
  for (const oldFinance of [finance({ expense: 1 }), null]) {
    const h = harness();
    await h.api.refresh();
    const read = deferred();
    const freshFinance = finance({ expense: 750, profit: 250, observedAt: '2026-10-13T11:00:00.000Z' });
    const freshSnapshot = snapshot({ expense: 750, profit: 250, date: '2026-10-13T11:00:00.000Z' });
    h.handler(async (action, payload) => action === 'getGiftState' ? read.promise : state([item(3, { ...payload, version: 'saved' })], {
      savedRow: 3, finance: freshFinance, snapshot: freshSnapshot,
    }));
    const refresh = h.api.refresh();
    h.form(25, 'A');
    await h.submit();
    read.resolve(state([], { finance: oldFinance, snapshot: snapshot({ expense: 1 }) }));
    await refresh;
    assert.deepEqual(h.financeCalls, [finance(), freshFinance]);
    assert.deepEqual(h.snapshotCalls, [freshSnapshot]);
    assert.equal(h.financeErrors.length, 0);
  }
});

test('old-config read/save finance and errors never affect the newly selected workbook', async () => {
  for (const action of ['read', 'save']) {
    for (const oldFinance of [finance({ expense: 1 }), null]) {
      const h = harness();
      await h.api.refresh();
      const old = deferred();
      h.handler(async () => old.promise);
      h.form(25, 'old');
      const pending = action === 'read' ? h.api.refresh() : h.submit();
      h.config.sheetId = 'sheet-b';
      h.api.resetForConfig();
      const newFinance = finance({ expense: 750, profit: 250 });
      h.handler(async () => state([], { spreadsheetId: 'sheet-b', finance: newFinance }));
      await h.api.refresh();
      old.resolve(state([item(3, { customer: 'old' })], { savedRow: 3, finance: oldFinance, snapshot: snapshot({ expense: 1 }) }));
      await pending;
      assert.deepEqual(h.financeCalls, [finance(), newFinance]);
      assert.equal(h.snapshotCalls.length, 0);
      assert.equal(h.financeErrors.length, 0);
    }
  }
});

test('unverified gift responses never forward their finance or chart data', async () => {
  const h = harness();
  await h.api.refresh();
  h.form(25, 'A');
  h.handler(async () => state([item(3, { customer: 'wrong' })], { savedRow: 3, finance: finance({ expense: 1 }), snapshot: snapshot({ expense: 1 }) }));
  await h.submit();
  assert.deepEqual(h.financeCalls, [finance()]);
  assert.equal(h.snapshotCalls.length, 0);
  assert.equal(h.financeErrors.length, 0);
  assert.equal(h.get('giftCustomer').value, 'A');
});
