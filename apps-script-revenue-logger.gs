/**
 * Revenue, profit & expense logger including active draft costs.
 * Keep in the SAME Apps Script project as apps-script-write-api.gs.
 * No source formulas or historical records are rewritten.
 */
function logWeeklyRevenue() {
  if (typeof recoverDraftTransfers !== 'function' || typeof readDraftFinance !== 'function' || typeof appendDraftFinanceSnapshot !== 'function') {
    throw new Error('กรุณาบันทึกไฟล์ Write API รุ่นที่รองรับแบบร่างใน Apps Script โปรเจกต์เดียวกันก่อนรัน logger');
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sourceSheet = ss.getSheets()[PRODUCT_SHEET_INDEX];
    recoverDraftTransfers(ss, sourceSheet);
    SpreadsheetApp.flush();
    return appendDraftFinanceSnapshot(ss, readDraftFinance(ss, sourceSheet));
  } finally {
    lock.releaseLock();
  }
}
