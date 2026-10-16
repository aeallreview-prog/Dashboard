(function (global) {
  'use strict';

  var nextId = 0;
  var activePicker = null;
  var instances = new WeakMap();
  var weekdays = ['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'];
  var weekdayNames = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'];

  function makeDate(year, month, day) {
    var date = new Date(2000, 0, 1, 12);
    date.setFullYear(year, month, day);
    return date;
  }

  function isoDate(date) {
    return String(date.getFullYear()).padStart(4, '0') + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function parseDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    var parts = value.split('-').map(Number);
    if (parts[0] < 1 || parts[0] > 9999) return null;
    var date = makeDate(parts[0], parts[1] - 1, parts[2]);
    return isoDate(date) === value ? date : null;
  }

  function todayInBangkok() {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    var values = {};
    parts.forEach(function (part) { values[part.type] = part.value; });
    return values.year + '-' + values.month + '-' + values.day;
  }

  function copyRange(range) {
    return range ? { from: range.from, to: range.to } : null;
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat('th-TH', {
      day: 'numeric', month: 'short', year: 'numeric'
    }).format(parseDate(value));
  }

  function formatRange(range) {
    return range.from === range.to ? formatDate(range.from) : formatDate(range.from) + ' – ' + formatDate(range.to);
  }

  function daysInMonth(year, month) {
    return makeDate(year, month + 1, 0).getDate();
  }

  function calendarDays(year, month) {
    var leading = (makeDate(year, month, 1).getDay() + 6) % 7;
    var count = daysInMonth(year, month);
    var length = Math.ceil((leading + count) / 7) * 7;
    return Array.from({ length: length }, function (_, index) {
      var day = index - leading + 1;
      return day > 0 && day <= count ? isoDate(makeDate(year, month, day)) : null;
    });
  }

  function shiftDate(value, days, months) {
    var date = parseDate(value);
    if (months) {
      var day = date.getDate();
      date.setDate(1);
      date.setMonth(date.getMonth() + months);
      date.setDate(Math.min(day, daysInMonth(date.getFullYear(), date.getMonth())));
    }
    if (days) date.setDate(date.getDate() + days);
    return date.getFullYear() >= 1 && date.getFullYear() <= 9999 ? isoDate(date) : value;
  }

  function create(options) {
    options = options || {};
    var root = options.root;
    if (!root || !root.ownerDocument) throw new Error('Date range picker requires a root element');
    if (instances.has(root)) return instances.get(root);
    var doc = root.ownerDocument;
    var win = doc.defaultView || global;
    var label = options.label || 'ช่วงวันที่';
    var id = 'snt-date-range-' + (++nextId);
    var committed = null;
    var draft = null;
    var today = todayInBangkok();
    var focusedDate = today;
    var view = parseDate(today);
    var isOpen = false;
    var destroyed = false;

    function element(tag, className, text) {
      var node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function button(className, text, ariaLabel) {
      var node = element('button', className, text);
      node.type = 'button';
      if (ariaLabel) node.setAttribute('aria-label', ariaLabel);
      return node;
    }

    root.classList.add('date-range-picker');
    var trigger = button('date-range-trigger', undefined, label);
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', id);
    var value = element('span', 'date-range-value');
    var icon = element('span', 'date-range-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="3"></rect><path d="M16 3v4M8 3v4M3 11h18"></path></svg>';
    trigger.append(value, icon);
    root.append(trigger);

    // A body-level popover is not clipped by chart panels' overflow/container rules.
    var popup = element('div', 'date-range-popover');
    popup.id = id;
    popup.hidden = true;
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', label);
    var heading = element('div', 'date-range-heading');
    var title = element('div', 'date-range-title');
    title.id = id + '-month';
    title.setAttribute('aria-live', 'polite');
    var navigation = element('div', 'date-range-nav');
    var previous = button('date-range-prev', '‹', 'เดือนก่อนหน้า');
    var next = button('date-range-next', '›', 'เดือนถัดไป');
    navigation.append(previous, next);
    heading.append(title, navigation);
    var weekdayRow = element('div', 'date-range-weekdays');
    weekdays.forEach(function (name, index) {
      var day = element('span', '', name);
      day.setAttribute('aria-label', weekdayNames[index]);
      weekdayRow.append(day);
    });
    var grid = element('div', 'date-range-grid');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-labelledby', title.id);
    var hint = element('p', 'date-range-hint');
    hint.id = id + '-hint';
    hint.setAttribute('aria-live', 'polite');
    grid.setAttribute('aria-describedby', hint.id);
    var actions = element('div', 'date-range-actions');
    var cancel = button('date-range-cancel', 'ยกเลิก');
    var apply = button('date-range-apply', 'เลือกช่วงนี้');
    actions.append(cancel, apply);
    popup.append(heading, weekdayRow, grid, hint, actions);
    doc.body.append(popup);

    function updateTrigger() {
      value.textContent = committed ? formatRange(committed) : 'เลือกช่วงวันที่';
      trigger.classList.toggle('is-placeholder', !committed);
      trigger.setAttribute('aria-label', label + ': ' + value.textContent);
    }

    function positionPopup() {
      if (!isOpen) return;
      var anchor = trigger.getBoundingClientRect();
      var width = popup.getBoundingClientRect().width;
      var height = popup.getBoundingClientRect().height;
      var viewportWidth = win.innerWidth || doc.documentElement.clientWidth;
      var viewportHeight = win.innerHeight || doc.documentElement.clientHeight;
      var left = Math.max(12, Math.min(anchor.left, viewportWidth - width - 12));
      var below = anchor.bottom + 8;
      var top = below + height <= viewportHeight - 12 ? below : anchor.top - height - 8;
      top = Math.max(12, Math.min(top, viewportHeight - height - 12));
      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
    }

    function renderCalendar(focusDay) {
      title.textContent = new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric' }).format(view);
      previous.disabled = view.getFullYear() === 1 && view.getMonth() === 0;
      next.disabled = view.getFullYear() === 9999 && view.getMonth() === 11;
      grid.replaceChildren();
      calendarDays(view.getFullYear(), view.getMonth()).forEach(function (date) {
        var cell = element('div', 'date-range-cell');
        if (!date) {
          cell.classList.add('is-empty');
          cell.setAttribute('aria-hidden', 'true');
          grid.append(cell);
          return;
        }
        var day = button('date-range-day', String(parseDate(date).getDate()), formatDate(date));
        day.dataset.date = date;
        day.tabIndex = date === focusedDate ? 0 : -1;
        var start = !!draft && date === draft.from;
        var end = !!draft && !!draft.to && date === draft.to;
        var inRange = !!draft && !!draft.to && date >= draft.from && date <= draft.to;
        [['is-start', start], ['is-end', end], ['is-in-range', inRange], ['is-single', start && (!draft.to || draft.to === draft.from)]].forEach(function (state) {
          cell.classList.toggle(state[0], state[1]);
          day.classList.toggle(state[0], state[1]);
        });
        day.classList.toggle('is-today', date === today);
        if (date === today) day.setAttribute('aria-current', 'date');
        day.setAttribute('aria-pressed', String(start || end || inRange));
        day.addEventListener('click', function () { selectDate(date); });
        day.addEventListener('keydown', function (event) { navigateByKeyboard(event, date); });
        cell.append(day);
        grid.append(cell);
      });
      apply.disabled = !draft || !draft.from || !draft.to;
      hint.textContent = !draft ? 'เลือกวันเริ่มต้น แล้วเลือกวันสิ้นสุด' :
        !draft.to ? 'เริ่ม ' + formatDate(draft.from) + ' · เลือกวันสิ้นสุด' : formatRange(draft);
      positionPopup();
      if (focusDay) {
        var target = grid.querySelector('[data-date="' + focusedDate + '"]');
        if (target) target.focus({ preventScroll: true });
      }
    }

    function selectDate(date) {
      if (!draft || draft.to) draft = { from: date, to: '' };
      else draft = date < draft.from ? { from: date, to: draft.from } : { from: draft.from, to: date };
      focusedDate = date;
      renderCalendar(true);
    }

    function navigateByKeyboard(event, date) {
      var target;
      if (event.key === 'ArrowLeft') target = shiftDate(date, -1);
      else if (event.key === 'ArrowRight') target = shiftDate(date, 1);
      else if (event.key === 'ArrowUp') target = shiftDate(date, -7);
      else if (event.key === 'ArrowDown') target = shiftDate(date, 7);
      else if (event.key === 'Home') target = shiftDate(date, -((parseDate(date).getDay() + 6) % 7));
      else if (event.key === 'End') target = shiftDate(date, 6 - ((parseDate(date).getDay() + 6) % 7));
      else if (event.key === 'PageUp') target = shiftDate(date, 0, event.shiftKey ? -12 : -1);
      else if (event.key === 'PageDown') target = shiftDate(date, 0, event.shiftKey ? 12 : 1);
      else return;
      event.preventDefault();
      focusedDate = target;
      view = parseDate(target);
      renderCalendar(true);
    }

    function changeMonth(amount) {
      var target = shiftDate(focusedDate, 0, amount);
      focusedDate = target;
      view = parseDate(target);
      renderCalendar(false);
    }

    function close(restoreFocus) {
      if (!isOpen) return;
      isOpen = false;
      popup.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      draft = copyRange(committed);
      if (activePicker === api) activePicker = null;
      if (restoreFocus) trigger.focus({ preventScroll: true });
    }

    function open() {
      if (destroyed) return;
      if (activePicker && activePicker !== api) activePicker.close();
      activePicker = api;
      draft = copyRange(committed);
      today = todayInBangkok();
      focusedDate = committed ? committed.from : today;
      view = parseDate(focusedDate);
      isOpen = true;
      popup.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      renderCalendar(true);
    }

    function outsidePointer(event) {
      if (isOpen && !root.contains(event.target) && !popup.contains(event.target)) close(false);
    }

    function outsideFocus(event) {
      if (isOpen && !root.contains(event.target) && !popup.contains(event.target)) close(false);
    }

    function escape(event) {
      if (isOpen && event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    }

    function reposition(event) {
      if (event && event.target && event.target.nodeType && popup.contains(event.target)) return;
      positionPopup();
    }

    trigger.addEventListener('click', function () { if (isOpen) close(true); else open(); });
    previous.addEventListener('click', function () { changeMonth(-1); });
    next.addEventListener('click', function () { changeMonth(1); });
    cancel.addEventListener('click', function () { close(true); });
    apply.addEventListener('click', function () {
      if (!draft || !draft.from || !draft.to || apply.disabled) return;
      committed = copyRange(draft);
      updateTrigger();
      close(true);
      if (typeof options.onApply === 'function') options.onApply(copyRange(committed));
    });
    doc.addEventListener('pointerdown', outsidePointer);
    doc.addEventListener('focusin', outsideFocus);
    doc.addEventListener('keydown', escape);
    win.addEventListener('resize', reposition);
    win.addEventListener('scroll', reposition, true);
    updateTrigger();

    var api = {
      getRange: function () { return copyRange(committed); },
      clear: function () {
        committed = null;
        draft = null;
        updateTrigger();
        close(false);
      },
      close: function () { close(false); },
      destroy: function () {
        close(false);
        destroyed = true;
        doc.removeEventListener('pointerdown', outsidePointer);
        doc.removeEventListener('focusin', outsideFocus);
        doc.removeEventListener('keydown', escape);
        win.removeEventListener('resize', reposition);
        win.removeEventListener('scroll', reposition, true);
        popup.remove();
        trigger.remove();
        root.classList.remove('date-range-picker');
        instances.delete(root);
      }
    };
    instances.set(root, api);
    return api;
  }

  global.SNTDateRangePicker = Object.freeze({ create: create });
  if (typeof module === 'object' && module.exports) {
    module.exports = { create: create, parseDate: parseDate, isoDate: isoDate, calendarDays: calendarDays, shiftDate: shiftDate, todayInBangkok: todayInBangkok };
  }
})(typeof window !== 'undefined' ? window : globalThis);
