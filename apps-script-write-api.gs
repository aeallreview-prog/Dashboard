/**
 * seek n tique — Write-back API
 * Deploy this as a Web App (Deploy > New deployment > Web app) so the
 * dashboard can edit existing products, add new products, and update the
 * store's manual revenue/expense cells (Q2, R2, S2).
 *
 * IMPORTANT — formula columns are never touched by this script:
 *   A (No.)        = ROW()-2            (auto)
 *   G (กำไรของ)     = F - E              (auto, set only on new rows)
 *   L (กำไรของ)     = H + I - E - J      (auto, set only on new rows)
 *
 * Deployment:
 *   1. Extensions > Apps Script > paste this file alongside the revenue logger
 *   2. Deploy > New deployment > type: Web app
 *      - Execute as: Me
 *      - Who has access: Anyone
 *   3. Copy the Web app URL it gives you and paste it into the dashboard's
 *      Settings panel (Web App URL field)
 */

// Change this if you want a different shared secret than the login password.
var API_SECRET = 'snt';

// 1-based column numbers for fields the app is allowed to write.
var EDITABLE_COLS = { P: 16, C: 3, E: 5, F: 6, H: 8, I: 9, J: 10, K: 11, O: 15 };

var PRODUCT_SHEET_INDEX = 0; // first tab holds the product data
var NO_FIRST_ROW = 3;        // row 3 = No.1 (No. = ROW()-2)

function doPost(e) {
  var result;
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.secret !== API_SECRET) {
      throw new Error('unauthorized');
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheets()[PRODUCT_SHEET_INDEX];

    if (body.action === 'getGiftState' || body.action === 'saveGift') {
      // Gift rows never mutate products or drafts. Reads are side-effect free;
      // saves may append current source totals to the existing finance history.
      // In particular, reading gifts must never replay a draft transfer.
      var giftLock = LockService.getScriptLock();
      giftLock.waitLock(30000);
      try {
        validateGiftSource(ss, sheet, body);
        result = body.action === 'getGiftState' ? getGiftState(ss, sheet) : saveGift(ss, sheet, body);
      } finally {
        giftLock.releaseLock();
      }
    } else if (body.action === 'getFollowerHistory') {
      result = { observations: readFollowerHistory(ss) };
    } else if (body.action === 'saveFollowerCount') {
      result = saveFollowerCount(ss, body.count);
    } else {
      var lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try {
        recoverDraftTransfers(ss, sheet);
        if (body.action === 'updateProduct') {
          updateProductRow(sheet, body.no, body.fields || {});
        } else if (body.action === 'addProduct') {
          if (body.draftId) {
            var transfer = transferDraftToProduct(ss, sheet, body);
            result = draftMutationResult(ss, sheet, transfer.changed, { no: transfer.no });
          } else {
            result = { no: addProductRow(sheet, body.fields || {}) };
          }
        } else if (body.action === 'updateStoreFinance') {
          updateStoreFinance(sheet, body.fields || {});
        } else if (body.action === 'deleteProduct') {
          deleteProductRow(sheet, body.no);
        } else if (body.action === 'getDraftState') {
          result = getDraftState(ss, sheet);
        } else if (body.action === 'saveDraft') {
          result = draftMutationResult(ss, sheet, saveProductDraft(ss, body));
        } else if (body.action === 'deleteDraft') {
          result = draftMutationResult(ss, sheet, deleteProductDraft(ss, body));
        } else {
          throw new Error('unknown action: ' + body.action);
        }
        SpreadsheetApp.flush();
      } finally {
        lock.releaseLock();
      }
    }

    return jsonOutput({ ok: true, result: result || null });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err) });
  }
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Gifts occupy only AB:AD, starting at row 3. Source-sheet headers, formulas
// and other columns stay untouched. Saves may append a real finance snapshot
// to the existing RevenueHistory; AB is already included by T2/V2 formulas.
var GIFT_FIRST_ROW = 3;
var GIFT_FIRST_COLUMN = 28;
var GIFT_COLUMN_COUNT = 3;

function validateGiftSource(ss, sheet, body) {
  if (!ss || !sheet || typeof body.spreadsheetId !== 'string' || body.spreadsheetId !== ss.getId()) {
    throw new Error('ชีทของแถมไม่ตรงกับการตั้งค่า กรุณาตรวจสอบ Spreadsheet ID และโหลดข้อมูลใหม่');
  }
  if (typeof body.sourceSheetName !== 'string' || (body.sourceSheetName !== '' && body.sourceSheetName !== sheet.getName())) {
    throw new Error('ชื่อแท็บของแถมไม่ตรงกับแท็บสินค้าของ Web App กรุณาตรวจสอบการตั้งค่าและโหลดข้อมูลใหม่');
  }
}

function giftVersion(values, formulas) {
  return JSON.stringify([values, formulas]);
}

function readGiftRows(sheet) {
  var lastRow = sheet.getLastRow();
  var width = Math.max(0, Math.min(GIFT_COLUMN_COUNT, sheet.getMaxColumns() - GIFT_FIRST_COLUMN + 1));
  var rows = [], nextRow = GIFT_FIRST_ROW;
  var emptyValues = ['', '', ''], emptyFormulas = ['', '', ''];
  if (width && lastRow >= GIFT_FIRST_ROW) {
    var range = sheet.getRange(GIFT_FIRST_ROW, GIFT_FIRST_COLUMN, lastRow - GIFT_FIRST_ROW + 1, width);
    var values = range.getValues(), formulas = range.getFormulas();
    var foundEmpty = false;
    for (var i = 0; i < values.length; i++) {
      var rowValues = values[i].slice(), rowFormulas = formulas[i].slice();
      while (rowValues.length < GIFT_COLUMN_COUNT) rowValues.push('');
      while (rowFormulas.length < GIFT_COLUMN_COUNT) rowFormulas.push('');
      var occupied = rowValues.some(function (value) { return value !== '' && value !== null; }) || rowFormulas.some(function (formula) { return formula !== ''; });
      if (occupied) {
        rows.push({ row: GIFT_FIRST_ROW + i, values: rowValues, formulas: rowFormulas, version: giftVersion(rowValues, rowFormulas) });
      } else if (!foundEmpty) {
        nextRow = GIFT_FIRST_ROW + i;
        emptyValues = rowValues; emptyFormulas = rowFormulas;
        foundEmpty = true;
      }
    }
    if (!foundEmpty) nextRow = lastRow + 1;
  }
  return { rows: rows, nextRow: nextRow, nextValues: emptyValues, nextFormulas: emptyFormulas, nextVersion: giftVersion(emptyValues, emptyFormulas) };
}

function giftStateFromRows(ss, sheet, data) {
  return {
    spreadsheetId: ss.getId(), sourceSheetName: sheet.getName(),
    items: data.rows.map(function (record) {
      var cost = record.values[0];
      var validCost = typeof cost === 'number' && isFinite(cost) && cost >= 0 && cost <= 1000000000 && Math.abs(cost * 100 - Math.round(cost * 100)) <= 0.0001;
      return {
        row: record.row, cost: validCost ? cost : null,
        customer: record.values[1] === null ? '' : String(record.values[1]),
        image: record.values[2] === null ? '' : String(record.values[2]),
        version: record.version, readOnly: record.formulas.some(function (formula) { return formula !== ''; })
      };
    }),
    nextRow: data.nextRow, nextVersion: data.nextVersion, observedAt: new Date().toISOString()
  };
}

function getGiftState(ss, sheet) {
  var state = giftStateFromRows(ss, sheet, readGiftRows(sheet));
  state.finance = null;
  state.snapshot = null;
  // Reuse authoritative source totals plus active Draft costs. Never add AB
  // here: the user's T2/V2 formulas already include the gift ledger.
  try { state.finance = readDraftFinance(ss, sheet); }
  catch (err) { state.financeWarning = 'อ่านยอดรวมร้านไม่สำเร็จ: ' + String(err); }
  try { state.snapshot = latestGiftFinanceSnapshot(ss); }
  catch (err) { state.snapshotWarning = 'อ่านประวัติกราฟไม่สำเร็จ: ' + String(err); }
  if (!state.snapshotWarning && state.finance && !giftSnapshotMatchesFinance(state.snapshot, state.finance)) {
    state.snapshotWarning = 'ยอดล่าสุดยังไม่ถูกบันทึกในกราฟ กรุณารอรอบบันทึกถัดไปหรือตรวจสอบ RevenueHistory';
  }
  return state;
}

function giftSnapshotMatchesFinance(snapshot, finance) {
  return Boolean(snapshot && ['revenue', 'expense', 'profit'].every(function (key) { return snapshot[key] === finance[key]; }));
}

function giftFinanceHistorySheet(ss) {
  var history = ss.getSheetByName('RevenueHistory');
  if (!history) throw new Error('ไม่พบแท็บ RevenueHistory กรุณาตั้งค่าประวัติกราฟก่อน');
  if (history.getMaxColumns() < 4 || history.getRange(1, 1, 1, 4).getValues()[0].join('|') !== 'Date|Revenue|Profit|Expense') {
    throw new Error('หัวคอลัมน์ RevenueHistory ต้องเป็น Date / Revenue / Profit / Expense กรุณาตรวจสอบในชีท');
  }
  return history;
}

function latestGiftFinanceSnapshot(ss) {
  var history = giftFinanceHistorySheet(ss), latest = null;
  if (history.getLastRow() < 2) return null;
  history.getRange(2, 1, history.getLastRow() - 1, 4).getValues().forEach(function (row) {
    var date = row[0] instanceof Date ? row[0] : new Date(row[0]);
    if (isNaN(date.getTime()) || row.slice(1, 4).some(function (value) { return typeof value !== 'number' || !isFinite(value); })) return;
    // If two real saves share a millisecond, the later sheet row wins.
    if (!latest || date.getTime() >= new Date(latest.date).getTime()) latest = { date: date.toISOString(), revenue: row[1], profit: row[2], expense: row[3] };
  });
  return latest;
}

function appendGiftFinanceSnapshot(ss, finance) {
  var latest = latestGiftFinanceSnapshot(ss);
  if (giftSnapshotMatchesFinance(latest, finance)) return latest;
  var history = giftFinanceHistorySheet(ss), row = history.getLastRow() + 1, now = new Date();
  if (row > history.getMaxRows()) history.insertRowsAfter(history.getMaxRows(), row - history.getMaxRows());
  history.getRange(row, 1, 1, 4).setValues([[now, finance.revenue, finance.profit, finance.expense]]);
  SpreadsheetApp.flush();
  // This deliberately does not call appendDraftFinanceSnapshot: gift saves
  // must not clear Draft pending flags or recover interrupted transfers.
  return { date: now.toISOString(), revenue: finance.revenue, profit: finance.profit, expense: finance.expense };
}

function giftImageUrl(image) {
  if (typeof image !== 'string' || image.length > 2000) throw new Error('ลิงก์รูปของแถมไม่ถูกต้อง');
  image = image.trim();
  if (image === '') return '';
  // Apps Script does not supply the browser URL constructor. Validate the
  // protocol and authority explicitly, and never accept credentials or code.
  var match = image.match(/^https?:\/\/([^/?#]+)(?:[/?#][^\s]*)?$/i);
  if (!match || /[\s\\<>"'`\u0000-\u001f\u007f]/.test(image) || /%(?![0-9a-f]{2})/i.test(image)) {
    throw new Error('กรุณาใส่ลิงก์รูปภาพ http:// หรือ https:// ที่ถูกต้องและไม่มีข้อมูลเข้าสู่ระบบ');
  }
  var authority = match[1];
  // Image hosts use DNS names or IPv4. Reject malformed/credential-bearing
  // authorities instead of allowing Sheets to interpret arbitrary strings.
  var hostMatch = authority.match(/^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/i);
  if (!hostMatch || (hostMatch[2] && (Number(hostMatch[2]) < 1 || Number(hostMatch[2]) > 65535))) {
    throw new Error('กรุณาใส่ลิงก์รูปภาพ http:// หรือ https:// ที่ถูกต้องและไม่มีข้อมูลเข้าสู่ระบบ');
  }
  var host = hostMatch[1];
  if (host.length > 253 || host.split('.').some(function (label) { return !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label); }) || (/^[0-9.]+$/.test(host) && (host.split('.').length !== 4 || host.split('.').some(function (part) { return Number(part) > 255; })))) {
    throw new Error('ชื่อเว็บไซต์ในลิงก์รูปของแถมไม่ถูกต้อง');
  }
  return image;
}

function saveGift(ss, sheet, body) {
  if (typeof body.row !== 'number' || !isFinite(body.row) || Math.floor(body.row) !== body.row || body.row < GIFT_FIRST_ROW || typeof body.version !== 'string') {
    throw new Error('แถวของแถมไม่ถูกต้อง กรุณาโหลดข้อมูลใหม่ก่อนบันทึก');
  }
  var cost = draftCostCents(body.cost) / 100;
  if (typeof body.customer !== 'string' || body.customer.length > 200) throw new Error('ชื่อลูกค้าต้องเป็นข้อความไม่เกิน 200 ตัวอักษร');
  var desired = [cost, body.customer.trim(), giftImageUrl(body.image)];
  var data = readGiftRows(sheet);
  var record = data.rows.filter(function (item) { return item.row === body.row; })[0];
  if (!record && body.row === data.nextRow) record = { row: data.nextRow, values: data.nextValues, formulas: data.nextFormulas, version: data.nextVersion };
  if (!record) throw new Error('ตำแหน่งของแถมเปลี่ยนแล้ว กรุณาโหลดข้อมูลใหม่ก่อนบันทึก');
  if (record.formulas.some(function (formula) { return formula !== ''; })) throw new Error('แถวของแถมนี้มีสูตรอยู่ ระบบจะไม่เขียนทับ กรุณาตรวจสอบในชีท');
  var identical = JSON.stringify(record.values) === JSON.stringify(desired);
  if (body.version !== record.version && !identical) throw new Error('ของแถมถูกแก้ไขจากที่อื่นแล้ว กรุณาโหลดข้อมูลใหม่ก่อนบันทึก');
  if (!identical) {
    // Capacity is extended only after configuration, payload, row and version
    // validation. Existing cells are never moved, deleted or reformatted.
    if (body.row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), body.row - sheet.getMaxRows());
    var lastColumn = GIFT_FIRST_COLUMN + GIFT_COLUMN_COUNT - 1;
    if (sheet.getMaxColumns() < lastColumn) sheet.insertColumnsAfter(sheet.getMaxColumns(), lastColumn - sheet.getMaxColumns());
    var transport = desired.slice();
    [1, 2].forEach(function (column) { if (transport[column] !== '') transport[column] = "'" + transport[column]; });
    sheet.getRange(body.row, GIFT_FIRST_COLUMN, 1, GIFT_COLUMN_COUNT).setValues([transport]);
    SpreadsheetApp.flush();
  }
  var state = getGiftState(ss, sheet);
  state.savedRow = body.row;
  if (state.finance) {
    try {
      state.snapshot = appendGiftFinanceSnapshot(ss, state.finance);
      delete state.snapshotWarning;
    } catch (err) {
      state.snapshotWarning = 'บันทึกของแถมแล้ว แต่บันทึกจุดกราฟไม่สำเร็จ: ' + String(err);
    }
  } else {
    state.snapshotWarning = 'บันทึกของแถมแล้ว แต่ยังไม่ได้บันทึกจุดกราฟ เนื่องจากอ่านยอดรวมร้านไม่สำเร็จ';
  }
  return state;
}

// Manual follower history is isolated from all product and finance cells.
var FOLLOWER_SHEET_NAME = 'FollowerHistory';

function readFollowerHistory(ss) {
  var history = ss.getSheetByName(FOLLOWER_SHEET_NAME);
  if (!history || history.getLastRow() < 2) return [];
  return history.getRange(2, 1, history.getLastRow() - 1, 4).getValues().map(function (row) {
    var date = row[0] instanceof Date
      ? Utilities.formatDate(row[0], 'Asia/Bangkok', 'yyyy-MM-dd') : String(row[0]);
    var observedAt = row[2] instanceof Date ? row[2].toISOString() : String(row[2]);
    return { date: date, count: row[1], observedAt: observedAt, source: String(row[3]) };
  });
}

function saveFollowerCount(ss, count) {
  if (typeof count !== 'number' || !isFinite(count) || Math.floor(count) !== count || count < 1 || count > 1000000000) {
    throw new Error('กรุณากรอกยอดผู้ติดตามเป็นจำนวนเต็มตั้งแต่ 1 ถึง 1,000,000,000');
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var now = new Date();
    var date = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-MM-dd');
    var history = ss.getSheetByName(FOLLOWER_SHEET_NAME);
    if (!history) {
      history = ss.insertSheet(FOLLOWER_SHEET_NAME);
      history.appendRow(['Date', 'Count', 'ObservedAt', 'Source']);
      history.setFrozenRows(1);
    }
    var observations = readFollowerHistory(ss);
    var existing = observations.findIndex(function (row) { return row.date === date; });
    var targetRow = existing < 0 ? history.getLastRow() + 1 : existing + 2;
    // Preserve date and timestamp as text regardless of spreadsheet locale.
    history.getRange(targetRow, 1).setNumberFormat('@');
    history.getRange(targetRow, 3, 1, 2).setNumberFormat('@');
    history.getRange(targetRow, 1, 1, 4).setValues([[date, count, now.toISOString(), 'manual']]);
    SpreadsheetApp.flush();
    return { observations: readFollowerHistory(ss), savedDate: date, count: count };
  } finally {
    lock.releaseLock();
  }
}

function findRowByNo(sheet, no) {
  var lastRow = sheet.getLastRow();
  if (lastRow < NO_FIRST_ROW) return null;
  var values = sheet.getRange(NO_FIRST_ROW, 1, lastRow - NO_FIRST_ROW + 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(no)) return NO_FIRST_ROW + i;
  }
  return null;
}

function writeEditableFields(sheet, row, fields) {
  Object.keys(fields).forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(EDITABLE_COLS, key)) {
      var value = normalizeEditableValue(key, fields[key]);
      if (['C', 'K', 'O', 'P'].indexOf(key) >= 0 && value !== '') value = "'" + value;
      sheet.getRange(row, EDITABLE_COLS[key]).setValue(value);
    }
  });
}

function updateProductRow(sheet, no, fields) {
  var row = findRowByNo(sheet, no);
  if (!row) throw new Error('ไม่พบสินค้า No. ' + no);
  writeEditableFields(sheet, row, fields);
}

function findNextEmptyProductRow(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < NO_FIRST_ROW) return NO_FIRST_ROW;
  // A row with a picture/name but no cost is still an existing product.
  // Formula-only spare rows remain available; never move or renumber old rows.
  var values = sheet.getRange(NO_FIRST_ROW, 1, lastRow - NO_FIRST_ROW + 1, 16).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i].every(function (value, column) {
      return column === 0 || column === 6 || column === 11 || value === '' || value === null;
    })) {
      return NO_FIRST_ROW + i;
    }
  }
  return lastRow + 1; // no empty slot found anywhere — append a genuinely new row
}

function addProductRow(sheet, fields) {
  var newRow = findNextEmptyProductRow(sheet);
  ensureProductRowCapacity(sheet, newRow);
  var before = productRowContents(sheet, newRow);
  writeProductContents(sheet, newRow, buildProductRow(before, newRow, fields));
  return newRow - 2; // the new product's No.
}

function ensureProductRowCapacity(sheet, row) {
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), row - sheet.getMaxRows());
}

function productRowContents(sheet, row) {
  var range = sheet.getRange(row, 1, 1, 16);
  var values = range.getValues()[0];
  var formulas = range.getFormulas()[0];
  return values.map(function (value, i) { return formulas[i] || value; });
}

function buildProductRow(before, row, fields) {
  var after = before.slice();
  after[0] = '=ROW()-2';
  after[6] = '=SUM(F' + row + '-E' + row + ')';
  after[11] = '=SUM(H' + row + '+I' + row + '-E' + row + '-J' + row + ')';
  Object.keys(fields).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(EDITABLE_COLS, key)) return;
    after[EDITABLE_COLS[key] - 1] = normalizeEditableValue(key, fields[key]);
  });
  if (typeof after[2] === 'string') after[2] = after[2].replace(/^No\.\s*\d+/i, 'No.' + (row - 2));
  return after;
}

function normalizeEditableValue(key, value) {
  if (['E', 'F', 'H', 'I', 'J'].indexOf(key) >= 0 && value !== '' && value !== null) {
    if ((typeof value !== 'number' && typeof value !== 'string') || !isFinite(Number(value))) throw new Error('ช่องจำนวนเงิน ' + key + ' ต้องเป็นตัวเลข');
    value = Number(value);
  }
  if (['C', 'K', 'O', 'P'].indexOf(key) >= 0 && typeof value !== 'string') throw new Error('ช่องข้อความ ' + key + ' ต้องเป็นข้อความ');
  return value === null ? '' : value;
}

function writeProductContents(sheet, row, contents) {
  var transport = contents.slice();
  // Sheets treats leading '=' as a formula and can parse numbers/dates. A
  // leading apostrophe explicitly stores literal text; getValues returns the
  // original string without this transport prefix, matching the journal.
  [2, 10, 14, 15].forEach(function (column) {
    if (typeof transport[column] === 'string' && transport[column] !== '') transport[column] = "'" + transport[column];
  });
  sheet.getRange(row, 1, 1, 16).setValues([transport]);
}

// Drafts are a separate cost ledger. Main-sheet formulas and old history stay
// untouched. Converted/deleted records are retained for idempotent retries.
var DRAFT_SHEET_NAME = 'ProductDrafts';
var DRAFT_HEADERS = ['Id', 'Image', 'Cost', 'Revision', 'State', 'ProductNo', 'CreatedAt', 'UpdatedAt', 'TransferJournal', 'SnapshotPending'];

function draftSheet(ss, create) {
  var sheet = ss.getSheetByName(DRAFT_SHEET_NAME);
  if (!sheet) {
    if (!create) return null;
    sheet = ss.insertSheet(DRAFT_SHEET_NAME);
    sheet.getRange(1, 1, 1, DRAFT_HEADERS.length).setValues([DRAFT_HEADERS]);
    sheet.setFrozenRows(1);
  }
  var headers = sheet.getRange(1, 1, 1, DRAFT_HEADERS.length).getValues()[0];
  if (headers.some(function (value, i) { return value !== DRAFT_HEADERS[i]; })) throw new Error('แท็บ ProductDrafts มีโครงสร้างอื่นอยู่แล้ว กรุณาตรวจสอบก่อนใช้งาน');
  return sheet;
}

function draftRecords(ss) {
  var sheet = draftSheet(ss, false);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, DRAFT_HEADERS.length).getValues().map(function (values, i) {
    return { row: i + 2, values: values };
  }).filter(function (record) { return record.values[0] !== ''; });
}

function requireDraftId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new Error('รหัสแบบร่างไม่ถูกต้อง');
  return id;
}

function requireDraftRevision(revision) {
  if (typeof revision !== 'number' || !isFinite(revision) || revision < 0 || Math.floor(revision) !== revision) throw new Error('รุ่นข้อมูลแบบร่างไม่ถูกต้อง กรุณาโหลดข้อมูลใหม่');
  return revision;
}

function draftCostCents(cost) {
  if (typeof cost !== 'number' || !isFinite(cost) || cost < 0 || cost > 1000000000 || Math.abs(cost * 100 - Math.round(cost * 100)) > 0.0001) throw new Error('ต้นทุนต้องเป็นตัวเลขตั้งแต่ 0 ถึง 1,000,000,000 และไม่เกิน 2 ตำแหน่งทศนิยม');
  return Math.round(cost * 100);
}

function draftImageUrl(image) {
  if (typeof image !== 'string' || image.length > 4000 || !/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/i.test(image.trim())) throw new Error('กรุณาใส่ลิงก์รูปภาพที่ขึ้นต้นด้วย https:// หรือ http://');
  return image.trim();
}

function findDraftRecord(ss, id) {
  var records = draftRecords(ss).filter(function (record) { return record.values[0] === id; });
  if (records.length > 1) throw new Error('พบรหัสแบบร่างซ้ำในชีท กรุณาตรวจสอบก่อนดำเนินการ');
  return records[0] || null;
}

function putDraftRecord(sheet, row, values) {
  var transport = values.slice();
  [0, 1, 4, 6, 7, 8].forEach(function (column) {
    if (typeof transport[column] === 'string' && transport[column] !== '') transport[column] = "'" + transport[column];
  });
  sheet.getRange(row, 1, 1, DRAFT_HEADERS.length).setValues([transport]);
}

function saveProductDraft(ss, body) {
  var id = requireDraftId(body.id), revision = requireDraftRevision(body.revision);
  var image = draftImageUrl(body.image), cost = draftCostCents(body.cost) / 100;
  var sheet = draftSheet(ss, true), existing = findDraftRecord(ss, id), now = new Date().toISOString();
  if (existing) {
    var values = existing.values;
    if (values[4] !== 'ACTIVE') throw new Error('แบบร่างนี้ถูกนำไปใช้หรือลบแล้ว กรุณาโหลดข้อมูลใหม่');
    if (Number(values[3]) === revision + 1 && values[1] === image && values[2] === cost) return false;
    if (Number(values[3]) !== revision) throw new Error('แบบร่างถูกแก้ไขจากที่อื่นแล้ว กรุณาโหลดข้อมูลใหม่');
    values[1] = image; values[2] = cost; values[3] = revision + 1; values[7] = now; values[9] = true;
    putDraftRecord(sheet, existing.row, values);
  } else {
    if (revision !== 0) throw new Error('ไม่พบแบบร่าง กรุณาโหลดข้อมูลใหม่');
    putDraftRecord(sheet, sheet.getLastRow() + 1, [id, image, cost, 1, 'ACTIVE', '', now, now, '', true]);
  }
  return true;
}

function deleteProductDraft(ss, body) {
  var id = requireDraftId(body.id), revision = requireDraftRevision(body.revision), record = findDraftRecord(ss, id);
  if (!record) throw new Error('ไม่พบแบบร่าง กรุณาโหลดข้อมูลใหม่');
  var values = record.values;
  if (values[4] === 'DELETED' && Number(values[3]) === revision + 1) return false;
  if (values[4] !== 'ACTIVE' || Number(values[3]) !== revision) throw new Error('แบบร่างถูกเปลี่ยนแปลงแล้ว กรุณาโหลดข้อมูลใหม่');
  values[3] = revision + 1; values[4] = 'DELETED'; values[7] = new Date().toISOString(); values[9] = true;
  putDraftRecord(draftSheet(ss, false), record.row, values);
  return true;
}

function transferDraftToProduct(ss, sheet, body) {
  var id = requireDraftId(body.draftId), revision = requireDraftRevision(body.draftRevision), record = findDraftRecord(ss, id);
  if (!record) throw new Error('ไม่พบแบบร่าง กรุณาโหลดข้อมูลใหม่');
  var values = record.values;
  if (values[4] === 'CONVERTED') return { no: Number(values[5]), changed: false };
  if (values[4] !== 'ACTIVE' || Number(values[3]) !== revision) throw new Error('แบบร่างถูกเปลี่ยนแปลงแล้ว กรุณาโหลดข้อมูลใหม่');
  var fields = Object.assign({}, body.fields || {});
  // Authoritative stored cost/image always override client copies.
  fields.P = draftImageUrl(values[1]); fields.E = draftCostCents(values[2]) / 100;
  var row = findNextEmptyProductRow(sheet);
  ensureProductRowCapacity(sheet, row);
  var before = productRowContents(sheet, row), after = buildProductRow(before, row, fields);
  var journal = JSON.stringify({ row: row, before: before, after: after });
  if (journal.length > 45000) throw new Error('รายละเอียดสินค้ายาวเกินไป กรุณาย่อแล้วบันทึกใหม่');
  values[4] = 'TRANSFERRING'; values[5] = row - 2; values[7] = new Date().toISOString(); values[8] = journal;
  putDraftRecord(draftSheet(ss, false), record.row, values);
  SpreadsheetApp.flush();
  recoverDraftTransfers(ss, sheet);
  return { no: row - 2, changed: true };
}

function recoverDraftTransfers(ss, sheet) {
  var pending = draftRecords(ss).filter(function (record) { return record.values[4] === 'TRANSFERRING'; });
  pending.forEach(function (record) {
    var journal;
    try { journal = JSON.parse(record.values[8]); } catch (err) { throw new Error('ข้อมูลกู้คืนแบบร่างไม่สมบูรณ์ กรุณาติดต่อผู้ดูแล'); }
    if (!journal || !Number.isInteger(journal.row) || journal.row < NO_FIRST_ROW || !Array.isArray(journal.before) || !Array.isArray(journal.after) || journal.before.length !== 16 || journal.after.length !== 16 || Number(record.values[5]) !== journal.row - 2) throw new Error('ข้อมูลกู้คืนแบบร่างไม่ถูกต้อง กรุณาติดต่อผู้ดูแล');
    ensureProductRowCapacity(sheet, journal.row);
    var current = productRowContents(sheet, journal.row);
    // An interrupted write may leave old OR intended cells. A third value
    // belongs to another edit: never overwrite it or show duplicate totals.
    if (current.some(function (value, i) { return value !== journal.before[i] && value !== journal.after[i]; })) throw new Error('แถวสินค้า No. ' + (journal.row - 2) + ' มีข้อมูลขัดแย้ง ระบบหยุดเพื่อไม่เขียนทับ กรุณาตรวจสอบ');
    writeProductContents(sheet, journal.row, journal.after);
    SpreadsheetApp.flush();
    if (productRowContents(sheet, journal.row).some(function (value, i) { return value !== journal.after[i]; })) throw new Error('ยังยืนยันการบันทึกสินค้าไม่ได้ กรุณาลองโหลดใหม่');
    record.values[3] = Number(record.values[3]) + 1; record.values[4] = 'CONVERTED'; record.values[7] = new Date().toISOString(); record.values[9] = true;
    putDraftRecord(draftSheet(ss, false), record.row, record.values);
    SpreadsheetApp.flush();
  });
}

function readDraftFinance(ss, sheet) {
  var draftCents = 0;
  var seen = Object.create(null);
  draftRecords(ss).forEach(function (record) {
    var id = requireDraftId(record.values[0]);
    if (Object.prototype.hasOwnProperty.call(seen, id)) throw new Error('พบรหัสแบบร่างซ้ำในชีท กรุณาตรวจสอบก่อนอ่านยอด');
    seen[id] = true;
    if (['ACTIVE', 'CONVERTED', 'DELETED'].indexOf(record.values[4]) < 0) throw new Error('ยังมีการย้ายแบบร่างค้างอยู่ กรุณาโหลดใหม่ก่อนอ่านยอด');
    if (record.values[4] === 'ACTIVE') draftCents += draftCostCents(record.values[2]);
  });
  function sourceCents(cell) {
    var value = sheet.getRange(cell).getValue();
    if (typeof value !== 'number' || !isFinite(value)) throw new Error('อ่านยอด ' + cell + ' ไม่ได้ กรุณาตรวจสอบสูตรในชีท');
    return Math.round(value * 100);
  }
  return { revenue: sourceCents('U2') / 100, expense: (sourceCents('T2') + draftCents) / 100, profit: (sourceCents('V2') - draftCents) / 100, draftCost: draftCents / 100, observedAt: new Date().toISOString() };
}

function historySheetForDraftSnapshot(ss) {
  var sheet = ss.getSheetByName('RevenueHistory');
  if (!sheet) {
    sheet = ss.insertSheet('RevenueHistory');
    sheet.getRange(1, 1, 1, 4).setValues([['Date', 'Revenue', 'Profit', 'Expense']]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  var headers = sheet.getRange(1, 1, 1, 4).getValues()[0];
  if (headers[0] !== 'Date' || headers[1] !== 'Revenue' || headers[2] !== 'Profit') throw new Error('หัวคอลัมน์ RevenueHistory ไม่ตรงกับ Date / Revenue / Profit');
  if (headers[3] === '') {
    if (sheet.getLastRow() > 1 && sheet.getRange(2, 4, sheet.getLastRow() - 1, 1).getValues().some(function (row) { return row[0] !== ''; })) throw new Error('คอลัมน์ D ของ RevenueHistory มีข้อมูลอื่นอยู่แล้ว');
    sheet.getRange('D1').setValue('Expense');
  } else if (headers[3] !== 'Expense') throw new Error('คอลัมน์ D ของ RevenueHistory ไม่ใช่ Expense');
  return sheet;
}

function appendDraftFinanceSnapshot(ss, finance) {
  var now = new Date(), history = historySheetForDraftSnapshot(ss);
  history.appendRow([now, finance.revenue, finance.profit, finance.expense]);
  SpreadsheetApp.flush();
  // A timeout before this step leaves a retryable flag, never a lost cost.
  var ledger = draftSheet(ss, false);
  draftRecords(ss).forEach(function (record) {
    if (record.values[9] === true) ledger.getRange(record.row, 10).setValue(false);
  });
  return { date: now.toISOString(), revenue: finance.revenue, profit: finance.profit, expense: finance.expense };
}

function latestDraftFinanceSnapshot(ss) {
  var sheet = ss.getSheetByName('RevenueHistory');
  if (!sheet || sheet.getLastRow() < 2) return null;
  if (sheet.getRange(1, 1, 1, 4).getValues()[0].join('|') !== 'Date|Revenue|Profit|Expense') return null;
  var latest = null;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues().forEach(function (row) {
    var date = row[0] instanceof Date ? row[0] : new Date(row[0]);
    if (isNaN(date.getTime()) || row.slice(1, 4).some(function (value) { return typeof value !== 'number' || !isFinite(value); })) return;
    if (!latest || date.getTime() > new Date(latest.date).getTime()) latest = { date: date.toISOString(), revenue: row[1], profit: row[2], expense: row[3] };
  });
  return latest;
}

function getDraftState(ss, sheet) {
  SpreadsheetApp.flush();
  var state = {
    spreadsheetId: ss.getId(), sourceSheetName: sheet.getName(), nextProductNo: findNextEmptyProductRow(sheet) - 2,
    drafts: draftRecords(ss).filter(function (record) { return record.values[4] === 'ACTIVE'; }).map(function (record) {
      var values = record.values;
      return { id: values[0], image: values[1], cost: values[2], revision: values[3], createdAt: values[6], updatedAt: values[7] };
    }), finance: readDraftFinance(ss, sheet), snapshot: null
  };
  try { state.snapshot = latestDraftFinanceSnapshot(ss); } catch (err) { state.warning = 'อ่านประวัติกราฟไม่สำเร็จ: ' + String(err); }
  if (draftRecords(ss).some(function (record) { return record.values[9] === true; })) {
    try { state.snapshot = appendDraftFinanceSnapshot(ss, state.finance); }
    catch (err) { state.warning = 'บันทึกรายการแล้ว แต่บันทึกจุดกราฟไม่สำเร็จ: ' + String(err); }
  }
  return state;
}

function draftMutationResult(ss, sheet, changed, extra) {
  // Snapshot failure after a successful write is a warning, not a failed save.
  var state = getDraftState(ss, sheet);
  Object.keys(extra || {}).forEach(function (key) { state[key] = extra[key]; });
  return state;
}

function updateStoreFinance(sheet, fields) {
  if (fields.Q2 !== undefined) sheet.getRange('Q2').setValue(fields.Q2);
  if (fields.R2 !== undefined) sheet.getRange('R2').setValue(fields.R2);
  if (fields.S2 !== undefined) sheet.getRange('S2').setValue(fields.S2);
}

function deleteProductRow(sheet, no) {
  var row = findRowByNo(sheet, no);
  if (!row) throw new Error('ไม่พบสินค้า No. ' + no);
  // clear only the editable fields — formula columns (A/G/L) are left alone so
  // other items' No. never shift, and this row becomes reusable by "add new product"
  Object.keys(EDITABLE_COLS).forEach(function (key) {
    sheet.getRange(row, EDITABLE_COLS[key]).setValue('');
  });
}
