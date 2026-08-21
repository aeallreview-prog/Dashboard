/**
 * seek n tique — Revenue & profit logger
 * บันทึกค่า U2 (รายรับ) และ V2 (กำไร) ลงในแท็บ "RevenueHistory" ทุกครั้งที่รัน
 * ตั้ง trigger ให้รันตามความถี่ที่ต้องการ (ดูขั้นตอนใน README)
 */
function logWeeklyRevenue() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // แผ่นข้อมูลหลักที่มีเซลล์ U2/V2 — ถ้าไม่ใช่แผ่นแรก ให้เปลี่ยนเป็นชื่อแท็บจริง เช่น
  // var sourceSheet = ss.getSheetByName('ข้อมูลล่าสุด');
  var sourceSheet = ss.getSheets()[0];
  var revenue = sourceSheet.getRange('U2').getValue();
  var profit = sourceSheet.getRange('V2').getValue();

  var historySheetName = 'RevenueHistory';
  var historySheet = ss.getSheetByName(historySheetName);
  if (!historySheet) {
    historySheet = ss.insertSheet(historySheetName);
    historySheet.appendRow(['Date', 'Revenue', 'Profit']);
  }

  historySheet.appendRow([new Date(), revenue, profit]);
}
