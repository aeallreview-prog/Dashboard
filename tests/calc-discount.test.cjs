const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
for (const file of ['app.js', 'seek-n-tique-dashboard.html']) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  function setup(items) {
    const nodes = {};
    const ctx = vm.createContext({document:{getElementById:id=>nodes[id] ||= {}},fmtMoney:n=>'฿'+n,items});
    vm.runInContext(source.slice(source.indexOf('const SHIPPING_BASE'),source.indexOf('function doCalculate()')),ctx);
    const run = code=>vm.runInContext(code,ctx);
    run('calcItems = items; renderCalcTotals()');
    return {run,nodes};
  }
  test(`${file}: 10/15 percent applies only to goods, not either delivery fee`,()=>{
    const h=setup([{price:100,qty:2},{price:300,qty:1}]);
    assert.match(h.nodes.calcMessageText.textContent,/\n= 550 บาท/);
    h.run('setCalcDiscount("10")');
    assert.match(h.nodes.calcMessageText.textContent,/ส่วนลด 10% 50 บ\./);
    assert.match(h.nodes.calcMessageText.textContent,/\n= 500 บาท/);
    h.run('setCalcDiscount("15"); toggleRemoteArea(true)');
    assert.match(h.nodes.calcMessageText.textContent,/ส่วนลด 15% 75 บ\./);
    assert.match(h.nodes.calcMessageText.textContent,/\n= 525 บาท/);
    h.run('setCalcDiscount(0)');
    assert.doesNotMatch(h.nodes.calcMessageText.textContent,/ส่วนลด/);
    assert.match(h.nodes.calcMessageText.textContent,/\n= 600 บาท/);
  });
  test(`${file}: each item shows compact discount text and hides full price while discounted`,()=>{
    const h=setup([{price:100,qty:2},{price:99,qty:1}]);
    assert.equal(h.nodes.calcItemDiscount0.hidden,true);
    h.run('setCalcDiscount(10)');
    assert.equal(h.nodes.calcItemDiscount0.hidden,false);
    assert.equal(h.nodes.calcItemDiscount0.textContent,'-10% = ฿90');
    assert.equal(h.nodes.calcItemDiscount1.textContent,'-10% = ฿89.1');
    assert.equal(h.nodes.calcItemFullPrice0.hidden,true);
    h.run('setCalcDiscount(15); updateCalcQty(0,3)');
    assert.equal(h.nodes.calcItemDiscount0.textContent,'-15% = ฿85');
    assert.match(h.nodes.calcItemDiscount1.textContent,/฿84.15$/);
    h.run('setCalcDiscount(0)');
    assert.equal(h.nodes.calcItemDiscount0.hidden,true);
    assert.equal(h.nodes.calcItemDiscount0.textContent,'');
    assert.equal(h.nodes.calcItemFullPrice0.hidden,false);
    assert.match(source,/class="calc-item-discount" id="calcItemDiscount/);
  });
  test(`${file}: quantity changes recalculate discount and round to satang`,()=>{
    const h=setup([{price:99,qty:1}]);
    h.run('setCalcDiscount(15)');
    assert.match(h.nodes.calcMessageText.textContent,/ส่วนลด 15% 14.85 บ\./);
    assert.match(h.nodes.calcMessageText.textContent,/\n= 134.15 บาท/);
    assert.match(h.nodes.calcTotalsBox.innerHTML,/฿134.15/);
    h.run('updateCalcQty(0,2)');
    assert.match(h.nodes.calcMessageText.textContent,/\n= 218.3 บาท/);
    h.run('setCalcDiscount(99)');
    assert.doesNotMatch(h.nodes.calcMessageText.textContent,/ส่วนลด/);
    assert.match(source,/function doCalculate\(\) \{\s*calcDiscountPercent = 0/);
  });
}
