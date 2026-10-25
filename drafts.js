/* Draft inventory: persisted in Apps Script, never treated as local-only stock. */
(function () {
  'use strict';
  const byId = id => document.getElementById(id);
  const DRAFT_PAGE_SIZE = 10;
  let drafts = [];
  let draftPage = 1;
  let lastState = null;
  let available = false;
  let lastObservedAt = -Infinity;
  let busy = false;
  let productBusy = false;
  let productIsAdd = false;
  let editing = null;
  let newDraftId = null;
  let selected = null;
  let originalProductFields = null;
  let refreshRequest = null;
  let configKey = null;
  let configEpoch = 0;
  let stateVersion = 0;
  let loadError = '';
  let stateWarning = '';

  function errorMessage(err) {
    const message = err && err.message ? err.message : String(err);
    if (/unknown action|ไม่รู้จัก action/i.test(message)) {
      return 'ยังไม่ได้อัปเดตระบบแบบร่าง กรุณาวาง Apps Script รุ่นใหม่ แล้ว Deploy เป็นเวอร์ชันใหม่ก่อนใช้งาน';
    }
    return message;
  }

  function feedback(message, isError) {
    const el = byId('draftFeedback');
    el.textContent = message;
    el.dataset.error = isError ? 'true' : 'false';
  }

  function money(value) {
    return '฿' + Number(value).toLocaleString('th-TH', { maximumFractionDigits: 2 });
  }

  function validImageUrl(value) {
    try {
      const parsed = new URL(String(value));
      return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password;
    } catch (_) { return false; }
  }

  function imageMarkup(url, label) {
    if (!validImageUrl(url)) return '<span class="draft-image-missing">ไม่มีรูปที่เปิดได้</span>';
    return '<img src="' + escapeHtml(resolveImageUrl(url)) + '" alt="' + escapeHtml(label) + '" loading="lazy">';
  }

  function attachImageErrors(container) {
    container.querySelectorAll('img').forEach(img => {
      img.addEventListener('error', () => {
        const hint = document.createElement('span');
        hint.className = 'draft-image-missing';
        hint.textContent = 'เปิดรูปไม่ได้ ตรวจสอบสิทธิ์ของลิงก์';
        img.replaceWith(hint);
      }, { once: true });
    });
  }

  function draftLabel(draft) {
    return 'แบบร่าง ' + draft.id.slice(-8).toUpperCase();
  }

  function renderControls() {
    byId('draftForm').querySelectorAll('input, button').forEach(el => { el.disabled = busy || productBusy || !available; });
    byId('draftSaveBtn').textContent = busy ? 'กำลังบันทึก…' : editing ? 'บันทึกการแก้ไข' : 'บันทึกแบบร่าง';
    byId('draftRefreshBtn').disabled = busy || Boolean(refreshRequest);
    byId('draftList').querySelectorAll('button').forEach(el => { el.disabled = busy || productBusy || !available; });
    byId('draftPagination').querySelectorAll('[data-draft-page]').forEach(el => {
      const page = Number(el.dataset.draftPage);
      el.disabled = busy || productBusy || !available || page < 1 || page > Math.ceil(drafts.length / DRAFT_PAGE_SIZE) || page === draftPage;
    });
    byId('productUseDraft').disabled = productBusy || busy || !available;
    byId('productDraftPicker').querySelectorAll('button').forEach(el => { el.disabled = productBusy || busy || !available; });
  }

  function renderList() {
    if (typeof window.renderInventoryOverview === 'function') window.renderInventoryOverview();
    const list = byId('draftList');
    const totalPages = Math.max(1, Math.ceil(drafts.length / DRAFT_PAGE_SIZE));
    draftPage = Math.min(draftPage, totalPages);
    const start = (draftPage - 1) * DRAFT_PAGE_SIZE;
    byId('draftCount').textContent = available ? drafts.length + ' ชิ้นที่ยังไม่ออกเลข' : 'ยังยืนยันข้อมูลล่าสุดไม่ได้';
    byId('draftTotal').textContent = available && lastState ? money(lastState.finance.draftCost) : '—';
    if (!available && !drafts.length) {
      list.innerHTML = '<p class="empty">ยังโหลดแบบร่างไม่ได้ กรุณาตรวจสอบข้อความด้านบนแล้วกดโหลดล่าสุด</p>';
    } else if (!drafts.length) {
      list.innerHTML = '<p class="empty">ยังไม่มีแบบร่าง — เพิ่มรูปและต้นทุนได้จากช่องด้านบน</p>';
    } else {
      list.innerHTML = '<table class="draft-table" aria-label="รายการสินค้า Draft">' +
        '<thead><tr><th scope="col">รูป</th><th scope="col" class="draft-cost-cell">ราคา</th><th scope="col">รหัสแบบร่าง</th><th scope="col">จัดการ</th></tr></thead><tbody>' +
        drafts.slice(start, start + DRAFT_PAGE_SIZE).map(draft => '<tr data-draft-row="' + escapeHtml(draft.id) + '">' +
        '<td><div class="draft-table-image">' + imageMarkup(draft.image, draftLabel(draft)) + '</div></td>' +
        '<td class="draft-cost-cell"><strong>' + money(draft.cost) + '</strong></td><th scope="row" class="draft-table-label">' + escapeHtml(draftLabel(draft)) + '</th>' +
        '<td><div class="draft-table-actions"><button class="ghost" type="button" data-draft-edit="' + escapeHtml(draft.id) + '">แก้ไข</button>' +
        '<button class="draft-delete" type="button" data-draft-delete="' + escapeHtml(draft.id) + '">ลบแบบร่าง</button></div></td></tr>').join('') + '</tbody></table>';
      attachImageErrors(list);
    }
    renderPagination(totalPages, start);
    renderControls();
  }

  function renderPagination(totalPages, start) {
    const pagination = byId('draftPagination');
    pagination.hidden = !drafts.length;
    if (!drafts.length) { pagination.innerHTML = ''; return; }
    const pageButton = (page, label, current = false) => '<button class="ghost pagination-num' + (current ? ' active' : '') + '" type="button" data-draft-page="' + page + '"' +
      (current ? ' aria-current="page"' : '') + ' aria-label="' + (typeof label === 'number' ? 'หน้า ' + label : label) + '">' + label + '</button>';
    const numbers = [];
    let previous = 0;
    for (let page = 1; page <= totalPages; page += 1) {
      if (page !== 1 && page !== totalPages && Math.abs(page - draftPage) > 1) continue;
      if (previous && page - previous > 1) numbers.push('<span class="pagination-ellipsis" aria-hidden="true">…</span>');
      numbers.push(pageButton(page, page, page === draftPage));
      previous = page;
    }
    pagination.innerHTML = '<span class="pagination-info" role="status" aria-live="polite">แสดง ' + (start + 1) + '–' + Math.min(start + DRAFT_PAGE_SIZE, drafts.length) + ' จาก ' + drafts.length + ' ชิ้น</span>' +
      pageButton(draftPage - 1, 'ก่อนหน้า') + '<div class="pagination-nums">' + numbers.join('') + '</div>' + pageButton(draftPage + 1, 'ถัดไป');
  }

  function restoreProductFields() {
    if (originalProductFields) {
      byId('pfP').value = originalProductFields.image;
      byId('pfE').value = originalProductFields.cost;
    }
    byId('pfP').readOnly = false;
    byId('pfE').readOnly = false;
    selected = null;
  }

  function renderPicker() {
    const picker = byId('productDraftPicker');
    const checked = byId('productUseDraft').checked;
    picker.hidden = !checked;
    const note = byId('productDraftSelectionNote');
    if (!available) {
      note.textContent = loadError || 'กำลังตรวจสอบแบบร่าง…';
    } else if (checked) {
      note.textContent = selected ? draftLabel(selected) + ' · ต้นทุน ' + money(selected.cost) + ' (รวมในยอดร้านแล้ว)' : 'เลือกแบบร่างหนึ่งชิ้นก่อนบันทึกสินค้า';
    } else {
      note.textContent = '';
    }
    picker.innerHTML = drafts.length ? drafts.map(draft => {
      const active = selected && selected.id === draft.id;
      return '<button type="button" class="draft-choice' + (active ? ' selected' : '') + '" data-draft-select="' + escapeHtml(draft.id) + '" aria-pressed="' + Boolean(active) + '">' +
        '<span class="draft-choice-image">' + imageMarkup(draft.image, draftLabel(draft)) + '</span>' +
        '<span><span>' + escapeHtml(draftLabel(draft)) + '</span><strong>' + money(draft.cost) + '</strong></span></button>';
    }).join('') : '<p class="product-draft-note">ยังไม่มีแบบร่างให้เลือก เพิ่มรูปและต้นทุนในหน้า “Draft” ก่อน</p>';
    attachImageErrors(picker);
    renderControls();
  }

  function currentConfigKey() {
    return [config.sheetId, config.sheetName || '', config.webAppUrl || ''].join('\n');
  }

  function resetForConfig() {
    configKey = currentConfigKey();
    configEpoch += 1;
    stateVersion += 1;
    refreshRequest = null;
    lastObservedAt = -Infinity;
    lastState = null;
    drafts = [];
    draftPage = 1;
    available = false;
    loadError = 'กำลังตรวจสอบแบบร่างของชีทที่เลือก…';
    stateWarning = '';
    resetDraftForm();
    resetProductForm(false);
    renderList();
    feedback(loadError, false);
  }

  function ensureConfig() {
    if (configKey === null) configKey = currentConfigKey();
    else if (configKey !== currentConfigKey()) resetForConfig();
  }

  function applyState(state) {
    ensureConfig();
    if (!state || state.spreadsheetId !== config.sheetId || (config.sheetName && state.sourceSheetName !== config.sheetName)) {
      throw new Error('Apps Script เชื่อมต่อคนละชีทกับแดชบอร์ด กรุณาตรวจสอบ Sheet ID ชื่อแท็บ และ Web App URL');
    }
    const finance = state.finance;
    const observedAt = finance && Date.parse(finance.observedAt);
    if (!Array.isArray(state.drafts) || !finance || !Number.isFinite(observedAt) ||
        !['revenue', 'expense', 'profit', 'draftCost'].every(key => Number.isFinite(finance[key]))) {
      throw new Error('ข้อมูลยอดร้านหรือแบบร่างไม่ครบ กรุณาอัปเดต Apps Script แล้วโหลดใหม่');
    }
    if (state.drafts.some(draft => !draft || typeof draft.id !== 'string' || !draft.id ||
        !Number.isFinite(draft.cost) || draft.cost < 0 || !Number.isSafeInteger(draft.revision) || draft.revision < 0 || typeof draft.image !== 'string')) {
      throw new Error('ข้อมูลแบบร่างไม่ถูกต้อง กรุณาตรวจสอบในชีทก่อนใช้งาน');
    }
    if (observedAt < lastObservedAt) {
      // A later read can finish before a save response. Keep the newer totals,
      // but retain the save's actual historical point while the public feed caches.
      if (state.snapshot && typeof window.addFinanceSnapshot === 'function') window.addFinanceSnapshot(state.snapshot);
      return lastState;
    }
    stateVersion += 1;
    lastObservedAt = observedAt;
    lastState = state;
    drafts = state.drafts;
    available = true;
    const previousError = loadError;
    const previousWarning = stateWarning;
    loadError = '';
    stateWarning = state.warning ? String(state.warning) : '';
    let selectionChanged = false;
    if (selected && !drafts.some(draft => draft.id === selected.id && draft.revision === selected.revision)) {
      restoreProductFields();
      selectionChanged = true;
    }
    renderList();
    renderPicker();
    if (stateWarning) feedback('ยอดร้านโหลดแล้ว แต่ ' + stateWarning, true);
    else if ((previousError && byId('draftFeedback').textContent === previousError) ||
        (previousWarning && byId('draftFeedback').textContent.includes(previousWarning))) feedback('', false);
    if (selectionChanged) byId('productDraftSelectionNote').textContent = 'แบบร่างที่เลือกถูกเปลี่ยนหรือใช้งานแล้ว กรุณาเลือกใหม่';
    if (typeof window.applyDraftFinance === 'function') window.applyDraftFinance(finance);
    if (state.snapshot && typeof window.addFinanceSnapshot === 'function') window.addFinanceSnapshot(state.snapshot);
    return state;
  }

  async function refresh() {
    ensureConfig();
    if (refreshRequest) return refreshRequest.promise;
    const request = { epoch: configEpoch, configKey, stateVersion,
      financeRevision: typeof draftFinanceRevision === 'number' ? draftFinanceRevision : null, promise: null };
    refreshRequest = request;
    request.promise = (async () => {
      try {
        const result = await callWriteApi('getDraftState', {});
        if (request.epoch !== configEpoch || request.configKey !== currentConfigKey()) throw new Error('การตั้งค่าชีทเปลี่ยนแล้ว กรุณารอข้อมูลจากชีทที่เลือก');
        return applyState(result);
      } catch (err) {
        if (request.epoch !== configEpoch || request.configKey !== currentConfigKey()) throw err;
        // A late failed read must not invalidate a later successful save/read.
        if (stateVersion > request.stateVersion && available) return lastState;
        available = false;
        loadError = errorMessage(err);
        feedback(loadError, true);
        renderList();
        renderPicker();
        const failure = new Error(loadError);
        failure.financeRevision = request.financeRevision;
        throw failure;
      } finally {
        if (refreshRequest === request) refreshRequest = null;
        renderControls();
      }
    })();
    renderControls();
    return request.promise;
  }

  function previewImage() {
    const url = byId('draftImage').value.trim();
    const preview = byId('draftImagePreview');
    preview.hidden = !url;
    preview.innerHTML = url ? imageMarkup(url, 'รูปตัวอย่างของแบบร่าง') : '';
    attachImageErrors(preview);
  }

  function resetDraftForm() {
    editing = null;
    newDraftId = null;
    byId('draftForm').reset();
    byId('draftFormTitle').textContent = 'เพิ่มแบบร่าง';
    byId('draftCancelBtn').hidden = true;
    previewImage();
    renderControls();
  }

  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    if (!window.crypto || !window.crypto.getRandomValues) throw new Error('เบราว์เซอร์นี้สร้างรหัสแบบร่างไม่ได้ กรุณาเปิดเว็บผ่าน HTTPS');
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  async function reloadDashboard() {
    await Promise.all([loadData(), loadRevenueHistory()]);
  }

  async function saveDraft(event) {
    event.preventDefault();
    if (busy || productBusy || !available) return;
    const image = byId('draftImage').value.trim();
    const rawCost = byId('draftCost').value.trim();
    if (!validImageUrl(image)) { feedback('กรุณาใส่ลิงก์รูปที่เริ่มด้วย https:// หรือ http://', true); return; }
    const cost = Number(rawCost);
    if (!/^\d+(?:\.\d{1,2})?$/.test(rawCost) || !Number.isFinite(cost) || !Number.isSafeInteger(Math.round(cost * 100))) {
      feedback('กรุณากรอกต้นทุนตั้งแต่ 0 บาท ทศนิยมไม่เกิน 2 ตำแหน่ง', true); return;
    }
    let id;
    try { id = editing ? editing.id : (newDraftId || (newDraftId = createId())); }
    catch (err) { feedback(errorMessage(err), true); return; }
    busy = true;
    renderControls();
    feedback('กำลังบันทึกต้นทุน…', false);
    let saved = false;
    try {
      const result = await callWriteApi('saveDraft', { id, image, cost, revision: editing ? editing.revision : 0 });
      saved = true;
      applyState(result);
      resetDraftForm();
      const warning = result.warning || (!result.snapshot ? 'ยังยืนยันการบันทึกประวัติกราฟไม่ได้ กรุณากดโหลดล่าสุด' : '');
      const message = warning ? 'บันทึกแบบร่างและต้นทุนแล้ว แต่ ' + warning : 'บันทึกแบบร่างแล้ว ต้นทุนรวมในยอดร้านและบันทึกประวัติกราฟแล้ว';
      feedback(message, Boolean(warning));
      await reloadDashboard();
      if (warning || available) feedback(message, Boolean(warning));
    } catch (err) {
      feedback((saved ? 'บันทึกสำเร็จ แต่โหลดหน้าจอล่าสุดไม่สำเร็จ กรุณากดโหลดล่าสุด — ' : '') + errorMessage(err), true);
    } finally {
      busy = false;
      renderControls();
    }
  }

  function editDraft(id) {
    if (busy || productBusy || !available) return;
    const draft = drafts.find(item => item.id === id);
    if (!draft) return;
    editing = { ...draft };
    newDraftId = null;
    byId('draftFormTitle').textContent = 'แก้ไข ' + draftLabel(draft);
    byId('draftImage').value = draft.image;
    byId('draftCost').value = draft.cost;
    byId('draftCancelBtn').hidden = false;
    feedback('การเปลี่ยนต้นทุนจะปรับยอดร้านและบันทึกประวัติใหม่ โดยไม่แก้กราฟย้อนหลัง', false);
    previewImage();
    renderControls();
    byId('draftForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    byId('draftCost').focus({ preventScroll: true });
  }

  async function deleteDraft(id) {
    if (busy || productBusy || !available) return;
    const draft = drafts.find(item => item.id === id);
    if (!draft || !confirm('ลบ ' + draftLabel(draft) + '?\nต้นทุน ' + money(draft.cost) + ' จะถูกนำออกจากยอดร้านปัจจุบัน แต่ไม่แก้ประวัติกราฟเดิม')) return;
    busy = true;
    renderControls();
    let saved = false;
    try {
      const result = await callWriteApi('deleteDraft', { id: draft.id, revision: draft.revision });
      saved = true;
      applyState(result);
      if (editing && editing.id === id) resetDraftForm();
      const warning = result.warning || (!result.snapshot ? 'ยังยืนยันการบันทึกประวัติกราฟไม่ได้ กรุณากดโหลดล่าสุด' : '');
      const message = warning ? 'นำแบบร่างออกและปรับต้นทุนแล้ว แต่ ' + warning : 'นำแบบร่างออกแล้ว และปรับต้นทุนปัจจุบันเรียบร้อย ประวัติยังเก็บอยู่ในชีท';
      feedback(message, Boolean(warning));
      await reloadDashboard();
      if (warning || available) feedback(message, Boolean(warning));
    } catch (err) {
      feedback((saved ? 'ลบสำเร็จ แต่โหลดหน้าจอล่าสุดไม่สำเร็จ กรุณากดโหลดล่าสุด — ' : '') + errorMessage(err), true);
    } finally { busy = false; renderControls(); }
  }

  function resetProductForm(isAdd) {
    restoreProductFields();
    originalProductFields = null;
    productIsAdd = Boolean(isAdd);
    byId('productUseDraft').checked = false;
    byId('productDraftSection').hidden = !productIsAdd;
    renderPicker();
  }

  function selectDraft(id) {
    if (!available || productBusy || busy || !productIsAdd || !byId('productUseDraft').checked) return;
    const draft = drafts.find(item => item.id === id);
    if (!draft) return;
    selected = { ...draft };
    byId('pfP').value = draft.image;
    byId('pfE').value = draft.cost;
    byId('pfP').readOnly = true;
    byId('pfE').readOnly = true;
    renderPicker();
  }

  function getProductSelection() {
    if (!productIsAdd || !byId('productUseDraft').checked) return {};
    if (!available) throw new Error(loadError || 'ยังยืนยันแบบร่างล่าสุดไม่ได้ กรุณาโหลดใหม่');
    if (!selected) throw new Error('กรุณาเลือกสินค้าแบบร่างหนึ่งชิ้น');
    if (!drafts.some(item => item.id === selected.id && item.revision === selected.revision)) throw new Error('แบบร่างนี้เปลี่ยนแล้ว กรุณาเลือกใหม่');
    return { draftId: selected.id, draftRevision: selected.revision };
  }

  byId('draftForm').addEventListener('submit', saveDraft);
  byId('draftImage').addEventListener('input', previewImage);
  byId('draftCancelBtn').addEventListener('click', () => { if (!busy && !productBusy) { resetDraftForm(); feedback('', false); } });
  byId('draftRefreshBtn').addEventListener('click', async () => {
    if (busy) return;
    feedback('กำลังโหลดข้อมูลล่าสุด…', false);
    try {
      const state = await refresh();
      feedback(state.warning ? 'โหลดแบบร่างแล้ว แต่ ' + state.warning : 'โหลดแบบร่างล่าสุดแล้ว', Boolean(state.warning));
    }
    catch (_) { /* refresh displays the specific error. */ }
  });
  byId('draftList').addEventListener('click', event => {
    const edit = event.target.closest('[data-draft-edit]');
    const remove = event.target.closest('[data-draft-delete]');
    if (edit) editDraft(edit.dataset.draftEdit);
    else if (remove) deleteDraft(remove.dataset.draftDelete);
  });
  byId('draftPagination').addEventListener('click', event => {
    if (busy || productBusy || !available) return;
    const button = event.target.closest('[data-draft-page]');
    if (!button) return;
    const page = Number(button.dataset.draftPage);
    if (!Number.isInteger(page) || page < 1 || page > Math.ceil(drafts.length / DRAFT_PAGE_SIZE) || page === draftPage) return;
    draftPage = page;
    renderList();
    byId('draftList').focus({ preventScroll: true });
    byId('draftList').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  byId('productUseDraft').addEventListener('change', () => {
    if (byId('productUseDraft').checked) {
      originalProductFields = { image: byId('pfP').value, cost: byId('pfE').value };
    } else {
      restoreProductFields();
      originalProductFields = null;
    }
    renderPicker();
  });
  byId('productDraftPicker').addEventListener('click', event => {
    const button = event.target.closest('[data-draft-select]');
    if (button) selectDraft(button.dataset.draftSelect);
  });

  window.SNTDrafts = {
    getCount() { return available ? drafts.length : null; },
    refresh,
    applyState,
    resetProductForm,
    getProductSelection,
    resetForConfig,
    onProductSaved(result) { if (result && result.drafts) applyState(result); resetProductForm(false); },
    setProductBusy(value) { productBusy = Boolean(value); renderControls(); },
    isBusy() { return busy || productBusy; },
  };
})();
