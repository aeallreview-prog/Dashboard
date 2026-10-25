const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
for (const file of ['app.js', 'seek-n-tique-dashboard.html']) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const take = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  test(`${file}: existing descriptions display and copy the new shipping line without mutating source`, () => {
    const row = {c:[null,null,{v:'No.1 แจกัน\n(ราคายังไม่รวมค่าจัดส่ง)\nหมายเหตุเดิม'}]};
    const context = vm.createContext({DETAIL_COL:2, PROFIT_PERCENT_COL:6, cellText:c=>c?.v || '', row});
    vm.runInContext(take('function getProductDisplayText(', '\nfunction looksLikeImageUrl('), context);
    assert.equal(vm.runInContext('getProductDisplayText(row, 2)',context),'No.1 แจกัน\n🚀 ค่าส่งเหมาจ่าย 50 บ.\nหมายเหตุเดิม');
    assert.match(row.c[2].v,/ราคายังไม่รวม/);
    assert.match(source,/registerDetailCopyText\(rawText\)/);
  });
  test(`${file}: parser preserves custom closing notes with either shipping wording`, () => {
    const context=vm.createContext({});
    vm.runInContext(take('function parseDetailTemplate(', '\nfunction fillTemplateBuilderFrom('),context);
    for(const shipping of ['(ราคายังไม่รวมค่าจัดส่ง)','🚀 ค่าส่งเหมาจ่าย 50 บ.']) {
      context.detail='No.1 แจกัน\n'+shipping+'\n--------------------\nโน้ตเฉพาะชิ้น\n#เดิม';
      const result=vm.runInContext('parseDetailTemplate(detail)',context);
      assert.equal(result.title,'แจกัน');
      assert.equal(result.closing,'โน้ตเฉพาะชิ้น\n#เดิม');
    }
    assert.match(source,/lines.push\('🚀 ค่าส่งเหมาจ่าย 50 บ\.'/);
    assert.match(source,/const detailText = getProductDisplayText\(row, DETAIL_COL\)/);
  });
}
