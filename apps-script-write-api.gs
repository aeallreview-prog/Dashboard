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

    if (body.action === 'updateProduct') {
      updateProductRow(sheet, body.no, body.fields || {});
    } else if (body.action === 'addProduct') {
      var newNo = addProductRow(sheet, body.fields || {});
      result = { no: newNo };
    } else if (body.action === 'updateStoreFinance') {
      updateStoreFinance(sheet, body.fields || {});
    } else if (body.action === 'deleteProduct') {
      deleteProductRow(sheet, body.no);
    } else if (body.action === 'getFollowerHistory') {
      result = { observations: readFollowerHistory(ss) };
    } else if (body.action === 'saveFollowerCount') {
      result = saveFollowerCount(ss, body.count);
    } else {
      throw new Error('unknown action: ' + body.action);
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
      sheet.getRange(row, EDITABLE_COLS[key]).setValue(fields[key]);
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
  // column E (index 5) marks whether a row "has" a product — search the whole
  // pre-filled formula range for the first empty one instead of just appending
  // after getLastRow(), which with formulas pre-filled hundreds of rows ahead
  // would silently write far below where anyone would ever scroll to see it.
  var values = sheet.getRange(NO_FIRST_ROW, 5, lastRow - NO_FIRST_ROW + 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === '' || values[i][0] === null) {
      return NO_FIRST_ROW + i;
    }
  }
  return lastRow + 1; // no empty slot found anywhere — append a genuinely new row
}

function addProductRow(sheet, fields) {
  var newRow = findNextEmptyProductRow(sheet);

  // formula columns — safe to (re)set even if already pre-filled
  sheet.getRange(newRow, 1).setFormula('=ROW()-2');                                            // A: No.
  sheet.getRange(newRow, 7).setFormula('=SUM(F' + newRow + '-E' + newRow + ')');                // G: กำไรของ
  sheet.getRange(newRow, 12).setFormula('=SUM(H' + newRow + '+I' + newRow + '-E' + newRow + '-J' + newRow + ')'); // L: กำไรของ

  writeEditableFields(sheet, newRow, fields);
  return newRow - 2; // the new product's No.
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
