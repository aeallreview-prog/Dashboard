/**
 * seek n tique — Revenue, profit & expense logger
 * บันทึกค่า U2 (รายรับ), V2 (กำไร) และ T2 (รายจ่าย) ลงในแท็บ "RevenueHistory" ทุกครั้งที่รัน
 * ตั้ง trigger ให้รันตามความถี่ที่ต้องการ (ดูขั้นตอนใน README)
 */
function logWeeklyRevenue() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // แผ่นข้อมูลหลักที่มีเซลล์ T2/U2/V2 — ถ้าไม่ใช่แผ่นแรก ให้เปลี่ยนเป็นชื่อแท็บจริง เช่น
  // var sourceSheet = ss.getSheetByName('ข้อมูลล่าสุด');
  var sourceSheet = ss.getSheets()[0];
  var revenue = sourceSheet.getRange('U2').getValue();
  var profit = sourceSheet.getRange('V2').getValue();
  var expense = sourceSheet.getRange('T2').getValue();
  // ช่องว่างหรือสูตรผิดพลาดไม่ใช่ยอดศูนย์ และไม่เติมประวัติรายจ่ายย้อนหลัง
  if (typeof expense !== 'number' || !isFinite(expense)) expense = '';

  var historySheetName = 'RevenueHistory';
  var historySheet = ss.getSheetByName(historySheetName);
  if (!historySheet) {
    historySheet = ss.insertSheet(historySheetName);
    historySheet.appendRow(['Date', 'Revenue', 'Profit', 'Expense']);
  } else {
    var expenseHeader = historySheet.getRange('D1');
    if (expenseHeader.getValue() === '') {
      // เพิ่มคอลัมน์ D โดยคงประวัติ A–C เดิมทั้งหมด
      if (historySheet.getLastRow() > 1 && historySheet.getRange(2, 4, historySheet.getLastRow() - 1, 1).getValues().some(function(row) { return row[0] !== ''; })) {
        throw new Error('คอลัมน์ D มีข้อมูลอยู่แล้ว กรุณาตรวจสอบก่อนเพิ่มประวัติรายจ่าย');
      }
      expenseHeader.setValue('Expense');
    } else if (expenseHeader.getValue() !== 'Expense') {
      throw new Error('คอลัมน์ D ถูกใช้งานอยู่ กรุณาตรวจสอบก่อนเพิ่มประวัติรายจ่าย');
    }
  }

  historySheet.appendRow([new Date(), revenue, profit, expense]);
}
