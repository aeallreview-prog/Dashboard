'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const file = path.resolve(__dirname, '..', 'date-range-picker.js');
const source = fs.readFileSync(file, 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

class FakeTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, data = {}) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...data };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
}

class FakeElement extends FakeTarget {
  constructor(tag, doc) {
    super();
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, enabled) => {
        if (enabled === undefined) enabled = !this.classList.contains(name);
        if (enabled) this.classList.add(name); else this.classList.remove(name);
        return enabled;
      }
    };
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  contains(node) {
    if (node && !node.nodeType) throw new TypeError('contains expects a DOM Node');
    return node === this || this.children.some(child => child.contains(node));
  }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('[data-date=')) return this.dataset.date === selector.slice(12, -2);
    return false;
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() {
    this.ownerDocument.activeElement = this;
    this.ownerDocument.emit('focusin', { target: this });
  }
  getBoundingClientRect() {
    return this.rect || (this.classList.contains('date-range-popover')
      ? { width: 320, height: 400, top: 0, left: 0, bottom: 400 }
      : { width: 280, height: 42, left: 100, top: 100, bottom: 142 });
  }
  click() { if (!this.disabled) this.emit('click'); }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
}

function harness(now = '2026-10-16T16:00:00.000Z') {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
  }
  const doc = new FakeTarget();
  const win = new FakeTarget();
  win.innerWidth = 1000;
  win.innerHeight = 800;
  doc.defaultView = win;
  doc.createElement = tag => new FakeElement(tag, doc);
  doc.body = doc.createElement('body');
  doc.documentElement = { clientWidth: 1000, clientHeight: 800 };
  const context = vm.createContext({ window: win, Date: FixedDate, Intl, WeakMap, module: { exports: {} } });
  vm.runInContext(source, context);
  const create = () => {
    const root = doc.createElement('div');
    doc.body.append(root);
    const calls = [];
    const api = win.SNTDateRangePicker.create({ root, label: 'ช่วงวันที่กราฟรายรับ', onApply: value => calls.push(plain(value)) });
    const trigger = root.querySelector('.date-range-trigger');
    const popup = doc.body.children.find(node => node.id === trigger.getAttribute('aria-controls'));
    const get = name => popup.querySelector('.date-range-' + name);
    const day = date => popup.querySelectorAll('.date-range-day').find(node => node.dataset.date === date);
    const goTo = date => {
      const month = date.slice(0, 7);
      for (let index = 0; index < 150; index++) {
        const current = popup.querySelectorAll('.date-range-day')[0].dataset.date.slice(0, 7);
        if (current === month) return;
        get(current < month ? 'next' : 'prev').click();
      }
      throw new Error('Target month not found');
    };
    return {
      api, root, popup, trigger, get, day, goTo, calls,
      open() { trigger.click(); },
      select(date) { goTo(date); assert.ok(day(date), date); day(date).click(); },
      apply() { get('apply').click(); }
    };
  };
  return { doc, win, create, helpers: context.module.exports };
}

test('ISO helpers validate dates, keep local calendar components, and reject invalid dates', () => {
  const { helpers } = harness();
  for (const date of ['2024-02-29', '2026-01-01', '0099-12-31', '9999-12-31']) {
    assert.equal(helpers.isoDate(helpers.parseDate(date)), date);
  }
  for (const date of ['', '2026-2-03', '2026-02-29', '2026-13-01', '2026-01-32', '0000-01-01', null, 20261016]) {
    assert.equal(helpers.parseDate(date), null, date);
  }
});

test('calendar is Monday-first with correct leap day and month boundaries', () => {
  const { helpers } = harness();
  const leap = plain(helpers.calendarDays(2024, 1));
  assert.deepEqual(leap.slice(0, 5), [null, null, null, '2024-02-01', '2024-02-02']);
  assert.equal(leap.filter(Boolean).length, 29);
  assert.ok(leap.includes('2024-02-29'));
  assert.equal(leap.length % 7, 0);
  assert.equal(helpers.calendarDays(2026, 1).filter(Boolean).length, 28);
  assert.equal(helpers.calendarDays(2026, 5)[0], '2026-06-01');
});

test('day/month shifts cross years and clamp month-end/leap dates', () => {
  const { helpers } = harness();
  assert.equal(helpers.shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(helpers.shiftDate('2027-01-01', -1), '2026-12-31');
  assert.equal(helpers.shiftDate('2026-01-31', 0, 1), '2026-02-28');
  assert.equal(helpers.shiftDate('2024-01-31', 0, 1), '2024-02-29');
  assert.equal(helpers.shiftDate('2024-02-29', 0, 12), '2025-02-28');
});

test('initial calendar date uses Bangkok day even before another timezone reaches it', () => {
  const h = harness('2026-10-15T17:05:00.000Z');
  assert.equal(h.helpers.todayInBangkok(), '2026-10-16');
  const picker = h.create();
  picker.open();
  assert.equal(h.doc.activeElement.dataset.date, '2026-10-16');
});

test('a single trigger opens an accessible body-level calendar and waits for two dates', () => {
  const h = harness();
  const picker = h.create();
  assert.equal(picker.root.querySelectorAll('.date-range-trigger').length, 1);
  assert.equal(picker.api.getRange(), null);
  assert.equal(picker.popup.hidden, true);
  assert.equal(picker.popup.parentElement, h.doc.body);
  picker.open();
  assert.equal(picker.popup.hidden, false);
  assert.equal(picker.trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(picker.popup.getAttribute('role'), 'dialog');
  assert.equal(picker.get('apply').disabled, true);
  picker.select('2026-10-03');
  assert.equal(picker.get('apply').disabled, true);
  picker.apply();
  assert.equal(picker.calls.length, 0);
  assert.equal(picker.day('2026-10-03').getAttribute('aria-pressed'), 'true');
  assert.equal(picker.day('2026-10-03').parentElement.classList.contains('is-single'), true);
  picker.select('2026-10-08');
  assert.equal(picker.get('apply').disabled, false);
  assert.equal(picker.calls.length, 0);
  for (let day = 3; day <= 8; day++) assert.equal(picker.day('2026-10-0' + day).parentElement.classList.contains('is-in-range'), true);
  picker.apply();
  assert.deepEqual(plain(picker.api.getRange()), { from: '2026-10-03', to: '2026-10-08' });
  assert.deepEqual(picker.calls, [{ from: '2026-10-03', to: '2026-10-08' }]);
  assert.equal(picker.popup.hidden, true);
  assert.equal(h.doc.activeElement, picker.trigger);
});

test('reverse selection sorts the bounds and same-day range is valid', () => {
  const h = harness();
  const picker = h.create();
  picker.open();
  picker.select('2026-10-20');
  picker.select('2026-10-05');
  picker.apply();
  assert.deepEqual(picker.calls[0], { from: '2026-10-05', to: '2026-10-20' });
  picker.open();
  picker.select('2026-10-12');
  picker.select('2026-10-12');
  assert.equal(picker.day('2026-10-12').parentElement.classList.contains('is-single'), true);
  picker.apply();
  assert.deepEqual(picker.calls[1], { from: '2026-10-12', to: '2026-10-12' });
});

test('range may cross months and years without losing its pending start', () => {
  const h = harness();
  const picker = h.create();
  picker.open();
  picker.select('2026-12-28');
  picker.select('2027-01-07');
  assert.equal(picker.day('2027-01-01').parentElement.classList.contains('is-in-range'), true);
  assert.equal(picker.day('2027-01-07').parentElement.classList.contains('is-end'), true);
  picker.apply();
  assert.deepEqual(picker.calls, [{ from: '2026-12-28', to: '2027-01-07' }]);
});

test('third click starts a fresh pending range, so apply becomes disabled', () => {
  const h = harness();
  const picker = h.create();
  picker.open();
  picker.select('2026-10-03');
  picker.select('2026-10-08');
  picker.select('2026-10-15');
  assert.equal(picker.get('apply').disabled, true);
  assert.equal(picker.day('2026-10-03').getAttribute('aria-pressed'), 'false');
  assert.equal(picker.day('2026-10-15').getAttribute('aria-pressed'), 'true');
  assert.equal(picker.api.getRange(), null);
});

test('cancel, Escape, outside pointer and focus all discard drafts without applying', () => {
  const h = harness();
  const picker = h.create();
  picker.open();
  picker.select('2026-10-01');
  picker.select('2026-10-10');
  picker.apply();
  for (const dismiss of [
    () => picker.get('cancel').click(),
    () => h.doc.emit('keydown', { key: 'Escape' }),
    () => h.doc.emit('pointerdown', { target: h.doc.body }),
    () => h.doc.emit('focusin', { target: h.doc.body }),
    () => picker.api.close()
  ]) {
    picker.open();
    picker.select('2026-10-15');
    picker.select('2026-10-20');
    dismiss();
    assert.equal(picker.popup.hidden, true);
    assert.deepEqual(plain(picker.api.getRange()), { from: '2026-10-01', to: '2026-10-10' });
    picker.open();
    assert.equal(picker.day('2026-10-01').parentElement.classList.contains('is-start'), true);
    assert.equal(picker.day('2026-10-10').parentElement.classList.contains('is-end'), true);
    picker.api.close();
  }
  assert.equal(picker.calls.length, 1);
});

test('clear resets trigger/range without emitting another apply; returned range is detached', () => {
  const h = harness();
  const picker = h.create();
  picker.open();
  picker.select('2026-10-03');
  picker.select('2026-10-08');
  picker.apply();
  const range = picker.api.getRange();
  range.from = '2020-01-01';
  assert.equal(picker.api.getRange().from, '2026-10-03');
  picker.open();
  picker.api.clear();
  assert.equal(picker.api.getRange(), null);
  assert.equal(picker.popup.hidden, true);
  assert.equal(picker.root.querySelector('.date-range-value').textContent, 'เลือกช่วงวันที่');
  assert.equal(picker.calls.length, 1);
  picker.open();
  assert.equal(picker.get('apply').disabled, true);
});

test('two instances keep independent committed ranges and opening one closes the other', () => {
  const h = harness();
  const one = h.create();
  const two = h.create();
  one.open();
  one.select('2026-10-01');
  one.select('2026-10-05');
  one.apply();
  one.open();
  one.select('2026-10-25');
  two.open();
  assert.equal(one.popup.hidden, true);
  assert.equal(two.popup.hidden, false);
  two.select('2026-10-11');
  two.select('2026-10-20');
  two.apply();
  assert.deepEqual(plain(one.api.getRange()), { from: '2026-10-01', to: '2026-10-05' });
  assert.deepEqual(plain(two.api.getRange()), { from: '2026-10-11', to: '2026-10-20' });
  two.api.clear();
  assert.equal(one.api.getRange().from, '2026-10-01');
  assert.notEqual(one.popup.id, two.popup.id);
});

test('keyboard arrows cross month boundaries; Home/End follow Monday–Sunday', () => {
  const h = harness();
  const picker = h.create();
  picker.open();
  const event = picker.day('2026-10-01').emit('keydown', { key: 'ArrowLeft' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.doc.activeElement.dataset.date, '2026-09-30');
  h.doc.activeElement.emit('keydown', { key: 'Home' });
  assert.equal(h.doc.activeElement.dataset.date, '2026-09-28');
  h.doc.activeElement.emit('keydown', { key: 'End' });
  assert.equal(h.doc.activeElement.dataset.date, '2026-10-04');
  h.doc.activeElement.emit('keydown', { key: 'ArrowUp' });
  assert.equal(h.doc.activeElement.dataset.date, '2026-09-27');
  h.doc.activeElement.emit('keydown', { key: 'PageDown', shiftKey: true });
  assert.equal(h.doc.activeElement.dataset.date, '2027-09-27');
  assert.equal(picker.calls.length, 0);
});

test('popup positions within screen bounds and flips above a low trigger', () => {
  const h = harness();
  const picker = h.create();
  h.win.innerWidth = 390;
  h.win.innerHeight = 800;
  picker.trigger.rect = { left: 300, top: 700, bottom: 742, width: 280, height: 42 };
  picker.open();
  assert.equal(picker.popup.style.left, '58px');
  assert.equal(picker.popup.style.top, '292px');
  h.win.innerHeight = 450;
  h.win.emit('resize');
  assert.equal(picker.popup.style.top, '38px');
});

test('create is idempotent and destroy removes portal/listeners before recreation', () => {
  const h = harness();
  const picker = h.create();
  assert.equal(h.win.SNTDateRangePicker.create({ root: picker.root }), picker.api);
  assert.equal(picker.root.querySelectorAll('.date-range-trigger').length, 1);
  picker.open();
  picker.api.destroy();
  assert.equal(picker.popup.parentElement, null);
  assert.equal(picker.root.querySelectorAll('.date-range-trigger').length, 0);
  assert.equal(h.doc.listeners.get('pointerdown').size, 0);
  assert.equal(h.win.listeners.get('resize').size, 0);
  const replacement = h.win.SNTDateRangePicker.create({ root: picker.root });
  assert.notEqual(replacement, picker.api);
});

test('local date parsing remains the same in negative and positive UTC offsets', () => {
  const script = `const p=require(${JSON.stringify(file)}); process.stdout.write(p.isoDate(p.parseDate('2026-10-16'))+'|'+p.shiftDate('2026-12-31',1));`;
  for (const timezone of ['America/Los_Angeles', 'Asia/Bangkok', 'Pacific/Kiritimati']) {
    const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '2026-10-16|2027-01-01', timezone);
  }
});
