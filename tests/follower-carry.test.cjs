const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'followers-chart.js'), 'utf8');
const ctx = vm.createContext({Date, Map, Number});
vm.runInContext(source.slice(0, source.indexOf('(() => {')), ctx);
const row = (date, count) => ({date, count, observedAt: date+'T12:00:00+07:00', source:'manual'});
const range = (from,to) => ({from:Date.parse(from+'T00:00:00+07:00'),to:Date.parse(to+'T23:59:59.999+07:00')});
function points(rows, from, to, now='2026-11-12T18:00:00+07:00', grouping='day') {
  return ctx.buildFollowerPoints(rows,grouping,range(from,to),Date.parse(now));
}
const values = list => Array.from(list,p=>p.value);
test('missing days carry forward repeatedly, new input replaces it, including decreases',()=>{
  const rows = [row('2026-11-07',350),row('2026-11-10',340)];
  const before=JSON.stringify(rows);
  const list=points(rows,'2026-11-07','2026-11-12');
  assert.deepEqual(values(list),[350,350,350,340,340,340]);
  assert.match(list[1].tooltipLabel,/ใช้ยอดวันก่อนหน้า/);
  assert.doesNotMatch(list[3].tooltipLabel,/ใช้ยอดวันก่อนหน้า/);
  assert.ok(list.every(p=>!p.breakBefore));
  assert.equal(JSON.stringify(rows),before);
});
test('custom range seeds from a real entry before the selected range',()=>{
  assert.deepEqual(values(points([row('2026-11-01',350)],'2026-11-10','2026-11-12')),[350,350,350]);
});
test('never invent values before first entry or after today; no entries means empty',()=>{
  assert.deepEqual(values(points([],'2026-11-01','2026-11-30')),[]);
  assert.deepEqual(values(points([row('2026-11-10',350)],'2026-11-01','2026-11-30')),[350,350,350]);
  assert.deepEqual(values(points([row('2026-11-10',350)],'2026-11-13','2026-11-30')),[]);
});
test('day changes at Bangkok midnight, not UTC midnight',()=>{
  const rows=[row('2026-11-10',350)];
  assert.equal(points(rows,'2026-11-10','2026-11-13','2026-11-11T16:59:59.999Z').length,2);
  assert.equal(points(rows,'2026-11-10','2026-11-13','2026-11-11T17:00:00Z').length,3);
});
test('carry does not satisfy the real manual-entry reminder and weekly buckets remain Monday based',()=>{
  const rows=[row('2026-11-08',350)];
  assert.deepEqual(values(points(rows,'2026-11-08','2026-11-12',undefined,'week')),[350,350]);
  assert.equal(ctx.followerWeekMissing(rows,Date.parse('2026-11-12T18:00:00+07:00')),true);
});
test('latest actual entry wins within a day, even with unsorted input',()=>{
  assert.deepEqual(values(points([row('2026-11-10',360),{...row('2026-11-10',350),observedAt:'2026-11-10T08:00:00+07:00'}],'2026-11-10','2026-11-12')),[360,360,360]);
});
