/* Gifts are stored only in the selected sheet: AB cost, AC customer, AD image, AE note. */
(function () {
  'use strict';
  const PAGE_SIZE = 10;
  const NOTE_UPGRADE_MESSAGE = 'ระบบของแถมยังไม่รองรับโน้ต (AE) กรุณาอัปเดต Apps Script และ Deploy เป็นเวอร์ชันใหม่ แล้วกดโหลดล่าสุดก่อนบันทึก';
  const byId = id => document.getElementById(id);
  let initialized = false;
  let items = [];
  let page = 1;
  let lastState = null;
  let available = false;
  let configKey = null;
  let configEpoch = 0;
  let stateRevision = 0;
  let refreshRequest = null;
  let saveRequest = null;
  let editing = null;
  // An uncertain write must retry the exact same row/version and values.
  let pendingAttempt = null;

  function currentConfigKey() {
    return [config.sheetId || '', config.sheetName || '', config.webAppUrl || ''].join('\n');
  }

  function feedback(message, isError) {
    byId('giftFeedback').textContent = message;
    byId('giftFeedback').dataset.error = String(Boolean(isError));
  }

  function errorMessage(error) {
    const message = error && error.message ? error.message : String(error);
    if (/unknown action|ไม่รู้จัก action/i.test(message)) {
      return 'ยังไม่ได้อัปเดตระบบของแถม กรุณาวาง Apps Script รุ่นใหม่ แล้ว Deploy เป็นเวอร์ชันใหม่ จากนั้นกดโหลดล่าสุด';
    }
    return message;
  }

  function isConflict(error) {
    const message = error && error.message ? error.message : String(error);
    return /conflict|version mismatch|เปลี่ยนแปลง|เปลี่ยนแล้ว|ไม่ตรงกับเวอร์ชัน|ข้อมูลไม่ตรงกับ|ถูกแก้ไข|มีสูตร/i.test(message);
  }

  function validImageUrl(value) {
    if (typeof value !== 'string' || value.length > 2000) return false;
    // Match the server's URL checks before submission, including raw characters
    // that URL() would silently normalize but Apps Script deliberately rejects.
    const match = value.match(/^https?:\/\/([^/?#]+)(?:[/?#][^\s]*)?$/i);
    if (!match || /[\s\\<>"'`\u0000-\u001f\u007f]/.test(value) || /%(?![0-9a-f]{2})/i.test(value)) return false;
    const hostMatch = match[1].match(/^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/i);
    if (!hostMatch || (hostMatch[2] && (Number(hostMatch[2]) < 1 || Number(hostMatch[2]) > 65535))) return false;
    const host = hostMatch[1];
    return host.length <= 253 && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) &&
      (!/^[0-9.]+$/.test(host) || (host.split('.').length === 4 && host.split('.').every(part => Number(part) <= 255)));
  }

  function money(value) {
    return '฿' + value.toLocaleString('th-TH', { maximumFractionDigits: 2 });
  }

  function imageMarkup(value) {
    if (!value) return '<span class="draft-image-missing">ยังไม่มีรูป</span>';
    if (!validImageUrl(value)) return '<span class="draft-image-missing">ลิงก์รูปไม่ถูกต้อง</span>';
    const resolved = resolveImageUrl(value);
    if (!validImageUrl(resolved)) return '<span class="draft-image-missing">ลิงก์รูปไม่ถูกต้อง</span>';
    return '<img src="' + escapeHtml(resolved) + '" alt="รูปของแถม" loading="lazy">';
  }

  function attachImageErrors(container) {
    container.querySelectorAll('img').forEach(image => {
      image.addEventListener('error', () => {
        const hint = document.createElement('span');
        hint.className = 'draft-image-missing';
        hint.textContent = 'เปิดรูปไม่ได้ ตรวจสอบสิทธิ์ของลิงก์';
        image.replaceWith(hint);
      }, { once: true });
    });
  }

  function previewImage() {
    const value = byId('giftImage').value.trim();
    const preview = byId('giftImagePreview');
    preview.hidden = !value;
    preview.innerHTML = value ? imageMarkup(value) : '';
    attachImageErrors(preview);
  }

  function renderControls() {
    const busy = Boolean(saveRequest);
    const writable = available && lastState && lastState.notesSupported === true;
    ['giftImage', 'giftCost', 'giftCustomer', 'giftNote'].forEach(id => {
      byId(id).disabled = busy || !writable || Boolean(pendingAttempt);
    });
    byId('giftSaveBtn').disabled = busy || !writable || Boolean(pendingAttempt && pendingAttempt.blocked);
    byId('giftSaveBtn').textContent = busy ? 'กำลังบันทึก…' : pendingAttempt ? 'ลองบันทึกรายการเดิมอีกครั้ง' : editing ? 'บันทึกการแก้ไข' : 'บันทึกของแถม';
    byId('giftCancelBtn').hidden = !editing && !pendingAttempt;
    byId('giftCancelBtn').disabled = busy;
    byId('giftRefreshBtn').disabled = busy || Boolean(refreshRequest);
    byId('giftList').querySelectorAll('[data-gift-edit]').forEach(button => {
      const item = items.find(entry => entry.row === Number(button.dataset.giftEdit));
      button.disabled = busy || !writable || Boolean(pendingAttempt) || !item || item.readOnly;
    });
    byId('giftPagination').querySelectorAll('[data-gift-page]').forEach(button => {
      const target = Number(button.dataset.giftPage);
      button.disabled = busy || !available || target < 1 || target > Math.ceil(items.length / PAGE_SIZE) || target === page;
    });
  }

  function renderPagination(start, totalPages) {
    const holder = byId('giftPagination');
    holder.hidden = !items.length;
    if (!items.length) { holder.innerHTML = ''; return; }
    const pageButton = (target, label) => '<button type="button" class="ghost pagination-num' + (target === page ? ' active' : '') + '" data-gift-page="' + target + '"' +
      (target === page ? ' aria-current="page"' : '') + ' aria-label="' + (typeof label === 'number' ? 'หน้า ' + label : label) + '">' + label + '</button>';
    const numbers = [];
    let previous = 0;
    for (let target = 1; target <= totalPages; target += 1) {
      if (target !== 1 && target !== totalPages && Math.abs(target - page) > 1) continue;
      if (previous && target - previous > 1) numbers.push('<span class="pagination-ellipsis" aria-hidden="true">…</span>');
      numbers.push(pageButton(target, target));
      previous = target;
    }
    holder.innerHTML = '<span class="pagination-info" role="status" aria-live="polite">แสดง ' + (start + 1) + '–' + Math.min(start + PAGE_SIZE, items.length) + ' จาก ' + items.length + ' ชิ้น</span>' +
      pageButton(page - 1, 'ก่อนหน้า') + '<div class="pagination-nums">' + numbers.join('') + '</div>' + pageButton(page + 1, 'ถัดไป');
  }

  function render() {
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    page = Math.max(1, Math.min(page, totalPages));
    const start = (page - 1) * PAGE_SIZE;
    const missingCosts = items.filter(item => item.cost === null).length;
    const total = items.reduce((sum, item) => sum + (item.cost === null ? 0 : item.cost), 0);
    byId('giftCount').textContent = available ? items.length + ' ชิ้น' : 'ยังยืนยันข้อมูลล่าสุดไม่ได้';
    byId('giftTotal').textContent = available ? (missingCosts ? '— · ขาดต้นทุน ' + missingCosts + ' ชิ้น' : money(total)) : '—';
    const list = byId('giftList');
    if (!items.length) {
      list.innerHTML = '<p class="empty">' + (available ? 'ยังไม่มีของแถม — เพิ่มต้นทุน รูป และชื่อลูกค้าได้จากช่องด้านบน' : 'กรุณาโหลดข้อมูลของแถมล่าสุดก่อนบันทึก') + '</p>';
    } else {
      list.innerHTML = '<table class="draft-table gift-table" aria-label="รายการของแถม"><thead><tr><th scope="col">รูป</th><th scope="col" class="draft-cost-cell">ต้นทุน</th><th scope="col">ลูกค้าที่ได้รับ</th><th scope="col">โน้ต</th><th scope="col">จัดการ</th></tr></thead><tbody>' +
        items.slice(start, start + PAGE_SIZE).map(item => '<tr data-gift-row="' + item.row + '">' +
          '<td><div class="draft-table-image">' + imageMarkup(item.image) + '</div></td>' +
          '<td class="draft-cost-cell"><strong>' + (item.cost === null ? '—' : money(item.cost)) + '</strong>' + (item.cost === null ? '<div class="product-draft-note">ยังไม่มีต้นทุนที่คำนวณได้</div>' : '') + '</td>' +
          '<th scope="row" class="draft-table-label gift-customer-cell">' + (item.customer ? escapeHtml(item.customer) : '<span class="product-draft-note">ยังไม่ได้แถมให้ลูกค้า</span>') + '</th>' +
          '<td class="gift-note-cell">' + (lastState && lastState.notesSupported === true ? (item.note ? escapeHtml(item.note) : '<span class="product-draft-note">—</span>') : '<span class="product-draft-note">อัปเดตระบบเพื่ออ่านโน้ต</span>') + '</td>' +
          '<td><div class="draft-table-actions">' + (item.readOnly ? '<span class="product-draft-note">มีสูตรในชีท · อ่านอย่างเดียว</span>' : '<button type="button" class="ghost" data-gift-edit="' + item.row + '">แก้ไข</button>') + '</div></td></tr>').join('') + '</tbody></table>';
      attachImageErrors(list);
    }
    renderPagination(start, totalPages);
    renderControls();
  }

  function resetForm() {
    editing = null;
    pendingAttempt = null;
    ['giftCost', 'giftCustomer', 'giftImage', 'giftNote'].forEach(id => { byId(id).value = ''; });
    byId('giftFormTitle').textContent = 'เพิ่มของแถม';
    previewImage();
    renderControls();
  }

  function resetForConfig() {
    init();
    configKey = currentConfigKey();
    configEpoch += 1;
    stateRevision += 1;
    refreshRequest = null;
    saveRequest = null;
    items = [];
    page = 1;
    lastState = null;
    available = false;
    resetForm();
    render();
    feedback('กรุณาโหลดข้อมูลของแถมจากชีทที่เลือก', false);
  }

  function ensureConfig() {
    if (configKey === null) configKey = currentConfigKey();
    else if (configKey !== currentConfigKey()) resetForConfig();
  }

  function validateState(state, expectedSheetName) {
    if (!state || !config.sheetId || state.spreadsheetId !== config.sheetId ||
        typeof state.sourceSheetName !== 'string' || !state.sourceSheetName.trim() ||
        ((expectedSheetName || config.sheetName) && state.sourceSheetName !== (expectedSheetName || config.sheetName))) {
      throw new Error('Apps Script เชื่อมต่อคนละชีท กรุณาตรวจสอบ Sheet ID ชื่อแท็บ และ Web App URL');
    }
    if (!Array.isArray(state.items) || !Number.isFinite(Date.parse(state.observedAt)) ||
        !Number.isSafeInteger(state.nextRow) || state.nextRow < 3 || typeof state.nextVersion !== 'string' || !state.nextVersion) {
      throw new Error('ข้อมูลของแถมไม่ครบ กรุณาอัปเดต Apps Script แล้วโหลดล่าสุด');
    }
    const seen = new Set();
    for (const item of state.items) {
      if (!item || !Number.isSafeInteger(item.row) || item.row < 3 || seen.has(item.row) ||
          (item.cost !== null && (!Number.isFinite(item.cost) || item.cost < 0 || item.cost > 1000000000 || !Number.isSafeInteger(Math.round(item.cost * 100)))) ||
          typeof item.customer !== 'string' || typeof item.image !== 'string' ||
          (state.notesSupported === true ? typeof item.note !== 'string' : item.note !== undefined && typeof item.note !== 'string') ||
          typeof item.version !== 'string' || !item.version || typeof item.readOnly !== 'boolean') {
        throw new Error('ข้อมูลของแถมไม่ถูกต้อง กรุณาตรวจสอบในชีทแล้วโหลดล่าสุด');
      }
      seen.add(item.row);
    }
    if (seen.has(state.nextRow)) throw new Error('แถวสำหรับเพิ่มของแถมไม่ว่าง กรุณาโหลดล่าสุด');
    return state;
  }

  function applyState(state) {
    validateState(state, lastState && lastState.sourceSheetName);
    items = state.items.slice().sort((a, b) => a.row - b.row);
    lastState = state;
    available = true;
    stateRevision += 1;
    render();
    return state;
  }

  function syncFinance(state, saved) {
    const warnings = [];
    const financeWarning = typeof state.financeWarning === 'string' ? state.financeWarning.trim() : '';
    const snapshotWarning = typeof state.snapshotWarning === 'string' ? state.snapshotWarning.trim() : '';
    try {
      // AB is already included in the sheet's totals. Forward the authoritative
      // values unchanged; never add the gift list's total to them a second time.
      const finance = state.finance;
      if (!finance || !['revenue', 'expense', 'profit', 'draftCost'].every(key => Number.isFinite(finance[key])) || !Number.isFinite(Date.parse(finance.observedAt))) {
        throw new Error(financeWarning || 'ยังไม่ได้รับยอดรวมร้านที่ครบถ้วน กรุณาอัปเดต Apps Script และ Deploy เป็นเวอร์ชันใหม่ แล้วโหลดล่าสุด');
      }
      if (typeof window.applyDraftFinance !== 'function') throw new Error('ยังแสดงยอดรวมร้านไม่ได้ กรุณาโหลดหน้าเว็บใหม่');
      window.applyDraftFinance(finance);
      if (financeWarning) warnings.push('ยังยืนยันยอดรวมร้านไม่ได้: ' + financeWarning);
    } catch (error) {
      const message = errorMessage(error);
      warnings.push('ยังอัปเดตยอดรวมร้านไม่ได้: ' + message);
      // The shared helper uses observedAt to avoid hiding newer totals from a
      // concurrent product/Draft read. Never replace unknown amounts with zero.
      try {
        if (typeof window.showDraftFinanceError === 'function') window.showDraftFinanceError(new Error(message), state.observedAt);
      } catch (_) { /* A display failure cannot undo a confirmed gift write. */ }
    }
    if (state.snapshot) {
      try {
        const snapshot = state.snapshot;
        if (!Number.isFinite(Date.parse(snapshot.date)) || !['revenue', 'expense', 'profit'].every(key => Number.isFinite(snapshot[key]))) {
          throw new Error('ข้อมูลจุดกราฟไม่ครบ กรุณาโหลดล่าสุด');
        }
        if (typeof window.addFinanceSnapshot !== 'function') throw new Error('ยังแสดงจุดกราฟไม่ได้ กรุณาโหลดหน้าเว็บใหม่');
        window.addFinanceSnapshot(snapshot);
      } catch (error) {
        warnings.push('ยังอัปเดตกราฟไม่ได้: ' + errorMessage(error));
      }
    } else if (saved && !snapshotWarning) {
      warnings.push('ยังยืนยันการบันทึกจุดกราฟไม่ได้ กรุณาอัปเดต Apps Script และโหลดล่าสุด');
    }
    if (snapshotWarning) warnings.push('ยังอัปเดตกราฟไม่ได้: ' + snapshotWarning);
    return warnings;
  }

  function isCurrent(request) {
    return request.epoch === configEpoch && request.key === currentConfigKey();
  }

  async function refresh() {
    init();
    ensureConfig();
    if (saveRequest) return lastState;
    if (refreshRequest) return refreshRequest.promise;
    const request = { epoch: configEpoch, key: configKey, revision: stateRevision, promise: null };
    refreshRequest = request;
    request.promise = (async () => {
      try {
        const result = await callWriteApi('getGiftState', { spreadsheetId: config.sheetId, sourceSheetName: config.sheetName || '' });
        if (!isCurrent(request)) return null;
        if (request.revision !== stateRevision) return lastState;
        const state = applyState(result);
        const warnings = syncFinance(state, false);
        if (state.notesSupported !== true) warnings.unshift(NOTE_UPGRADE_MESSAGE);
        const message = pendingAttempt ? 'โหลดล่าสุดแล้ว กรุณาตรวจสอบรายการเดิมก่อนเพิ่มใหม่ ข้อมูลที่รอยืนยันยังคงอยู่ในฟอร์ม' : 'โหลดข้อมูลของแถมล่าสุดแล้ว';
        feedback(message + (warnings.length ? ' แต่ ' + warnings.join(' · ') : ''), Boolean(pendingAttempt) || Boolean(warnings.length));
        return state;
      } catch (error) {
        if (!isCurrent(request)) return null;
        if (request.revision !== stateRevision) return lastState;
        available = false;
        feedback(errorMessage(error), true);
        render();
        throw error;
      } finally {
        if (refreshRequest === request) {
          refreshRequest = null;
          renderControls();
        }
      }
    })();
    renderControls();
    return request.promise;
  }

  function readForm() {
    const rawCost = byId('giftCost').value.trim();
    const cost = Number(rawCost);
    const customer = byId('giftCustomer').value.trim();
    const image = byId('giftImage').value.trim();
    const rawNote = byId('giftNote').value;
    if (!/^\d+(?:\.\d{1,2})?$/.test(rawCost) || !Number.isFinite(cost) || cost > 1000000000 || !Number.isSafeInteger(Math.round(cost * 100))) {
      throw new Error('กรุณากรอกต้นทุนตั้งแต่ 0 ถึง 1,000,000,000 บาท ทศนิยมไม่เกิน 2 ตำแหน่ง');
    }
    if (customer.length > 200) throw new Error('ชื่อลูกค้าต้องไม่เกิน 200 ตัวอักษร');
    if (rawNote.length > 500) throw new Error('โน้ตต้องไม่เกิน 500 ตัวอักษร');
    if (image.length > 2000 || (image && !validImageUrl(image))) throw new Error('กรุณาใส่ลิงก์รูป http:// หรือ https:// ที่ไม่มีชื่อผู้ใช้หรือรหัสผ่าน และยาวไม่เกิน 2,000 ตัวอักษร');
    return { cost, customer, image, note: rawNote.trim() };
  }

  async function save(event) {
    event.preventDefault();
    ensureConfig();
    if (saveRequest || !available || !lastState || (pendingAttempt && pendingAttempt.blocked)) return;
    if (lastState.notesSupported !== true) { feedback(NOTE_UPGRADE_MESSAGE, true); return; }
    if (!pendingAttempt) {
      try {
        const fields = readForm();
        pendingAttempt = { payload: {
          spreadsheetId: config.sheetId,
          sourceSheetName: lastState.sourceSheetName,
          row: editing ? editing.row : lastState.nextRow,
          version: editing ? editing.version : lastState.nextVersion,
          ...fields,
        }, blocked: false };
      } catch (error) { feedback(errorMessage(error), true); return; }
    }
    const attempt = pendingAttempt;
    const request = { epoch: configEpoch, key: configKey };
    saveRequest = request;
    // Any read already in flight predates this write, even if it resolves later.
    stateRevision += 1;
    renderControls();
    feedback('กำลังบันทึกของแถม…', false);
    try {
      const result = await callWriteApi('saveGift', { ...attempt.payload });
      if (!isCurrent(request)) return;
      validateState(result, attempt.payload.sourceSheetName);
      if (result.notesSupported !== true) {
        available = false;
        attempt.blocked = true;
        render();
        throw new Error(NOTE_UPGRADE_MESSAGE);
      }
      const saved = result.items.find(item => item.row === attempt.payload.row);
      if (result.savedRow !== attempt.payload.row || !saved || saved.cost !== attempt.payload.cost || saved.customer !== attempt.payload.customer || saved.image !== attempt.payload.image || saved.note !== attempt.payload.note) {
        throw new Error('ยังยืนยันข้อมูลที่บันทึกไม่ได้ กรุณาโหลดล่าสุดและตรวจสอบรายการเดิม');
      }
      applyState(result);
      resetForm();
      // Gift persistence is confirmed above. Finance/history failures are
      // partial success, never a reason to retry creating the saved gift.
      const warnings = syncFinance(result, true);
      feedback('บันทึกของแถมแล้ว' + (warnings.length ? ' แต่ ' + warnings.join(' · ') : ''), Boolean(warnings.length));
    } catch (error) {
      if (!isCurrent(request)) return;
      attempt.blocked = attempt.blocked || isConflict(error);
      if (/unknown action|ไม่รู้จัก action/i.test(error && error.message ? error.message : String(error))) {
        available = false;
        render();
      }
      feedback(attempt.blocked ? 'รายการนี้เปลี่ยนแปลงแล้ว กรุณาโหลดล่าสุด ตรวจสอบรายการเดิม แล้วกดยกเลิกและเลือกแก้ไขใหม่ — ' + errorMessage(error) :
        'ยังยืนยันการบันทึกไม่ได้ ข้อมูลเดิมยังอยู่ กดบันทึกซ้ำจะใช้รายการเดิมโดยไม่เพิ่มแถวใหม่ — ' + errorMessage(error), true);
    } finally {
      if (saveRequest === request) {
        saveRequest = null;
        renderControls();
      }
    }
  }

  function edit(row) {
    ensureConfig();
    if (saveRequest || pendingAttempt || !available) return;
    if (!lastState || lastState.notesSupported !== true) { feedback(NOTE_UPGRADE_MESSAGE, true); return; }
    const item = items.find(entry => entry.row === row);
    if (!item || item.readOnly) return;
    editing = { row: item.row, version: item.version };
    byId('giftFormTitle').textContent = 'แก้ไขของแถม';
    byId('giftCost').value = item.cost === null ? '' : String(item.cost);
    byId('giftCustomer').value = item.customer;
    byId('giftImage').value = item.image;
    byId('giftNote').value = item.note;
    previewImage();
    renderControls();
    feedback('', false);
    byId('giftForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    byId('giftCost').focus({ preventScroll: true });
  }

  function init() {
    if (initialized) return;
    initialized = true;
    byId('giftForm').addEventListener('submit', save);
    byId('giftImage').addEventListener('input', previewImage);
    byId('giftCancelBtn').addEventListener('click', () => {
      if (saveRequest) return;
      const uncertain = Boolean(pendingAttempt);
      resetForm();
      feedback(uncertain ? 'ยกเลิกฟอร์มแล้ว กรุณาโหลดล่าสุดและตรวจสอบรายการก่อนเพิ่มใหม่' : '', uncertain);
      if (uncertain) { available = false; render(); }
    });
    byId('giftRefreshBtn').addEventListener('click', async () => {
      if (saveRequest) return;
      try { await refresh(); } catch (_) { /* refresh displays the error. */ }
    });
    byId('giftList').addEventListener('click', event => {
      const button = event.target.closest('[data-gift-edit]');
      if (button) edit(Number(button.dataset.giftEdit));
    });
    byId('giftPagination').addEventListener('click', event => {
      const button = event.target.closest('[data-gift-page]');
      if (!button || saveRequest || !available) return;
      const target = Number(button.dataset.giftPage);
      if (!Number.isSafeInteger(target) || target < 1 || target > Math.ceil(items.length / PAGE_SIZE)) return;
      page = target;
      render();
    });
    resetForm();
    render();
  }

  window.SNTGifts = { init, refresh, resetForConfig };
})();
