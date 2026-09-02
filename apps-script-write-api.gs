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

function addProductRow(sheet, fields) {
  var newRow = sheet.getLastRow() + 1;
  if (newRow < NO_FIRST_ROW) newRow = NO_FIRST_ROW;

  // formula columns — set once here, then they behave exactly like the rest of the sheet
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
