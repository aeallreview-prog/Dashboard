/* seek n tique — live sales dashboard
 * Reads directly from a public Google Sheet in the browser (no server needed).
 * Sheet must be shared as "Anyone with the link can view".
 */

const STATUS_DEFS = [
  { key: 'none',     label: 'ยังไม่ได้ลงขาย', color: 'var(--status-none)' },
  { key: 'shipped',  label: 'ส่งแล้ว',        color: 'var(--status-shipped)' },
  { key: 'listed',   label: 'ลงขายแล้ว',      color: 'var(--status-listed)' },
  { key: 'partial',  label: 'ขายได้บางส่วน',  color: 'var(--status-partial)' },
  { key: 'reserved', label: 'ติดจอง',         color: 'var(--status-reserved)' },
  { key: 'soldout',  label: 'ขายหมดแล้ว',     color: 'var(--status-soldout)' },
];
const STATUS_COLOR_HEX = {
  none: '#97a2ad', shipped: '#1f9d63', listed: '#1a63a8', partial: '#eab308',
  reserved: '#f97316', soldout: '#8b5cf6'
};
const LABEL_TO_KEY = {};
STATUS_DEFS.forEach(s => LABEL_TO_KEY[s.label] = s.key);

const DEFAULTS = {
  sheetId: '1uWbyx7ojEQ5iZpY6XSlk2xFiAko5bdVcsjjyMg4_OJg',
  sheetName: '',
  statusCol: 'auto',
  interval: 60,
};

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem('sntDashboardConfig') || '{}');
    return { ...DEFAULTS, ...saved };
  } catch (e) { return { ...DEFAULTS }; }
}
function saveConfig(cfg) {
  localStorage.setItem('sntDashboardConfig', JSON.stringify(cfg));
}

let config = loadConfig();
let pollTimer = null;
let lastRows = null;   // full row data from the most recent successful fetch
let lastHeaders = [];  // header labels taken from sheet row 1

// ---------- helpers ----------
function colToIndex(letter) {
  letter = letter.trim().toUpperCase();
  let idx = 0;
  for (let i = 0; i < letter.length; i++) idx = idx * 26 + (letter.charCodeAt(i) - 64);
  return idx - 1; // 0-based
}
function indexToCol(idx) {
  let n = idx + 1, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function fmtMoney(n) {
  if (n === null || n === undefined || isNaN(n)) return '–';
  return '฿' + Number(n).toLocaleString('th-TH', { maximumFractionDigits: 0 });
}
function cellNumber(cell) {
  if (!cell) return null;
  if (typeof cell.v === 'number') return cell.v;
  if (typeof cell.v === 'string') {
    const n = parseFloat(cell.v.replace(/[^0-9.-]/g, ''));
    return isNaN(n) ? null : n;
  }
  if (cell.f) {
    const n = parseFloat(String(cell.f).replace(/[^0-9.-]/g, ''));
    return isNaN(n) ? null : n;
  }
  return null;
}
function cellText(cell) {
  if (!cell) return '';
  if (typeof cell.v === 'string') return cell.v.trim();
  if (cell.f) return String(cell.f).trim();
  return '';
}

function parseGviz(text) {
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  const json = JSON.parse(text.substring(start + 1, end));
  return json.table;
}

function buildUrl(cfg) {
  const base = `https://docs.google.com/spreadsheets/d/${cfg.sheetId}/gviz/tq?tqx=out:json&headers=0`;
  const sheetParam = cfg.sheetName ? `&sheet=${encodeURIComponent(cfg.sheetName)}` : '';
  return base + sheetParam + '&_=' + Date.now();
}

// ---------- product row filter ----------
// Only rows that have data in column E count as real products.
const PRODUCT_COL = colToIndex('E');
function rowHasProduct(row) {
  const cell = row.c && row.c[PRODUCT_COL];
  return cellText(cell) !== '';
}

// ---------- status column detection ----------
function detectStatusColumn(rows) {
  const knownLabels = Object.keys(LABEL_TO_KEY);
  let bestCol = -1, bestCount = -1;
  const maxCols = rows.reduce((m, r) => Math.max(m, r.c ? r.c.length : 0), 0);
  const productRows = rows.filter(rowHasProduct);
  for (let col = 0; col < maxCols; col++) {
    let count = 0;
    for (const row of productRows) {
      const cell = row.c && row.c[col];
      const text = cellText(cell);
      if (knownLabels.includes(text)) count++;
    }
    if (count > bestCount) { bestCount = count; bestCol = col; }
  }
  return bestCount > 0 ? bestCol : -1;
}

function tallyStatuses(rows, colIdx) {
  const counts = { none: 0, shipped: 0, listed: 0, partial: 0, reserved: 0, soldout: 0 };
  let other = 0, total = 0;
  for (const row of rows) {
    if (!rowHasProduct(row)) continue; // skip rows with no product in column D
    const cell = row.c && row.c[colIdx];
    const text = cellText(cell);
    if (!text) continue;
    const key = LABEL_TO_KEY[text];
    if (key) { counts[key]++; total++; }
    else { other++; }
  }
  return { counts, other, total };
}

// ---------- rendering ----------
function renderStatusGrid(counts, total) {
  const grid = document.getElementById('statusGrid');
  grid.innerHTML = '';
  if (total === 0) {
    grid.innerHTML = '<p class="empty">ไม่พบข้อมูลสถานะสินค้าในชีต</p>';
    return;
  }
  STATUS_DEFS.forEach(def => {
    const n = counts[def.key] || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    const card = document.createElement('div');
    card.className = 'status-card';
    card.innerHTML = `
      <div>
        <p><span class="dot" style="background:${def.color}"></span>${def.label}</p>
        <strong style="color:${def.color}">${n}</strong>
      </div>
      <span class="status-share">${pct}% ของทั้งหมด</span>
      <div class="bar"><i style="width:${pct}%;background:${def.color}"></i></div>
    `;
    grid.appendChild(card);
  });
}

function renderDonut(counts, total) {
  const chart = document.getElementById('donutChart');
  const totalEl = document.getElementById('donutTotal');
  const legend = document.getElementById('legendArea');
  totalEl.textContent = total;
  legend.innerHTML = '';

  if (total === 0) {
    chart.style.setProperty('--conic', '#e9eef1');
    legend.innerHTML = '<p class="empty" style="padding:0">ไม่มีข้อมูล</p>';
    return;
  }

  let acc = 0;
  const stops = [];
  STATUS_DEFS.forEach(def => {
    const n = counts[def.key] || 0;
    if (n <= 0) return;
    const start = (acc / total) * 360;
    acc += n;
    const end = (acc / total) * 360;
    stops.push(`${STATUS_COLOR_HEX[def.key]} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`);
  });
  chart.style.background = `conic-gradient(${stops.join(', ')})`;

  STATUS_DEFS.forEach(def => {
    const n = counts[def.key] || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'legend-row';
    row.innerHTML = `
      <span class="lg-left"><span class="dot" style="background:${STATUS_COLOR_HEX[def.key]}"></span>${def.label}</span>
      <span class="lg-val">${n} · ${pct}%</span>
    `;
    legend.appendChild(row);
  });
}

function setStatus(mode, text) {
  const line = document.getElementById('statusLine');
  const label = document.getElementById('statusText');
  line.className = 'status ' + (mode || '');
  label.textContent = text;
}

function showError(msg) {
  const area = document.getElementById('errorArea');
  area.innerHTML = `<div class="error-box"><p style="margin:0;font:700 16px 'DM Sans',sans-serif;color:var(--ink)">โหลดข้อมูลไม่สำเร็จ</p><p>${msg}</p></div>`;
}
function clearError() {
  document.getElementById('errorArea').innerHTML = '';
}

// ---------- search by No. (column A) ----------
const COLUMN_LABEL_OVERRIDES = {
  A: 'No.',
  E: 'ต้นทุนของ',
  F: 'ราคาขาย',
  G: 'กำไรของ',
  H: 'ขายแล้ว',
  I: 'ค่าส่งจากลูกค้า',
  J: 'ค่าส่งจริง',
  K: 'หมายเหตุ',
  L: 'กำไรของ',
  O: 'สถานะ',
  P: 'Image',
};
const IMAGE_COL = colToIndex('P');
const DETAIL_COL = colToIndex('C'); // detail/description column - shown wider
const PRICE_COL = colToIndex('F'); // ราคาขาย - green highlight
const STATUS_DISPLAY_COL = colToIndex('O'); // สถานะ - colored like the donut chart
// Only these columns are shown in the search result, in this exact order.
const DISPLAY_COLS = ['A', 'P', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'O'].map(colToIndex);

function headerLabel(colIdx) {
  const letter = indexToCol(colIdx);
  if (COLUMN_LABEL_OVERRIDES[letter]) return COLUMN_LABEL_OVERRIDES[letter];
  const raw = lastHeaders[colIdx];
  return raw && raw.trim() ? raw.trim() : `คอลัมน์ ${letter}`;
}
function looksLikeImageUrl(text) {
  return /^https?:\/\/\S+/i.test(text);
}
// Google Drive "share" links (view/open) don't work as an <img src> directly —
// convert them to Drive's thumbnail endpoint, which does.
function resolveImageUrl(url) {
  if (/drive\.google\.com/i.test(url)) {
    const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m && m[1]) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1000`;
  }
  return url;
}
function handleImgError(imgEl) {
  const fallback = document.createElement('strong');
  fallback.textContent = '-';
  imgEl.replaceWith(fallback);
}

function renderSearchResult(row) {
  const noVal = cellText(row.c && row.c[0]) || '-';
  let fields = '';

  DISPLAY_COLS.forEach(i => {
    const cell = row.c && row.c[i];
    const rawText = cellText(cell);
    const text = rawText || '-';

    if (i === IMAGE_COL) {
      if (looksLikeImageUrl(rawText)) {
        fields += `<div class="search-field image-field"><p>${headerLabel(i)}</p><img src="${resolveImageUrl(rawText)}" alt="รูปสินค้า No. ${noVal}" loading="lazy" onerror="handleImgError(this)"></div>`;
      } else {
        fields += `<div class="search-field image-field"><p>${headerLabel(i)}</p><strong>-</strong></div>`;
      }
    } else if (i === DETAIL_COL) {
      fields += `<div class="search-field detail-field"><p>${headerLabel(i)}</p><strong>${text}</strong></div>`;
    } else if (i === PRICE_COL) {
      fields += `<div class="search-field price-field"><p>${headerLabel(i)}</p><strong>${text}</strong></div>`;
    } else if (i === STATUS_DISPLAY_COL) {
      const key = LABEL_TO_KEY[rawText];
      const bg = key ? STATUS_COLOR_HEX[key] : '#97a2ad';
      fields += `<div class="search-field status-field" style="background:${bg}"><p>${headerLabel(i)}</p><strong>${text}</strong></div>`;
    } else {
      fields += `<div class="search-field"><p>${headerLabel(i)}</p><strong>${text}</strong></div>`;
    }
  });

  return `
    <div class="search-result-card">
      <div class="search-result-head"><strong>No. ${noVal}</strong></div>
      <div class="search-fields">${fields}</div>
    </div>
  `;
}

function findRowByNo(val) {
  return lastRows.find((row, idx) => {
    if (idx === 0) return false; // skip header row
    const cellVal = cellText(row.c && row.c[0]);
    return cellVal !== '' && (cellVal === val || Number(cellVal) === Number(val));
  });
}

const MAX_SEARCH_ITEMS = 5;

function doSearch() {
  const box = document.getElementById('searchResult');
  const raw = document.getElementById('searchInput').value.trim();
  if (!raw) { box.innerHTML = ''; return; }
  if (!lastRows) {
    box.innerHTML = '<p class="search-empty">ยังไม่มีข้อมูล กรุณารอให้โหลดข้อมูลก่อน</p>';
    return;
  }

  let tokens = raw.split(',').map(s => s.trim()).filter(Boolean);
  let notice = '';
  if (tokens.length > MAX_SEARCH_ITEMS) {
    notice = `<p class="search-empty">ค้นหาได้สูงสุด ${MAX_SEARCH_ITEMS} รายการต่อครั้ง แสดงเฉพาะ: ${tokens.slice(0, MAX_SEARCH_ITEMS).join(', ')}</p>`;
    tokens = tokens.slice(0, MAX_SEARCH_ITEMS);
  }

  let html = '';
  const notFound = [];
  tokens.forEach(val => {
    const match = findRowByNo(val);
    if (match) html += renderSearchResult(match);
    else notFound.push(val);
  });

  if (notFound.length) {
    html += `<p class="search-empty">ไม่พบข้อมูล No. ${notFound.map(v => `"${v}"`).join(', ')}</p>`;
  }
  box.innerHTML = notice + html;
}

// ---------- main fetch ----------
async function loadData() {
  document.getElementById('refreshBtn').disabled = true;
  setStatus('', 'กำลังอัปเดต...');
  try {
    const res = await fetch(buildUrl(config), { cache: 'no-store' });
    if (!res.ok) throw new Error('เชื่อมต่อ Google Sheet ไม่สำเร็จ (HTTP ' + res.status + ')');
    const text = await res.text();
    const table = parseGviz(text);
    const rows = table.rows || [];
    lastRows = rows;
    lastHeaders = (rows[0] && rows[0].c) ? rows[0].c.map(c => cellText(c)) : [];

    // Revenue / expense / profit from fixed cells U2 / T2 / V2 (row index 1)
    const rowTwo = rows[1];
    const revenue = cellNumber(rowTwo && rowTwo.c && rowTwo.c[colToIndex('U')]);
    const expense = cellNumber(rowTwo && rowTwo.c && rowTwo.c[colToIndex('T')]);
    const profit = cellNumber(rowTwo && rowTwo.c && rowTwo.c[colToIndex('V')]);

    document.getElementById('revenueVal').textContent = fmtMoney(revenue);
    document.getElementById('expenseVal').textContent = fmtMoney(expense);
    document.getElementById('profitVal').textContent = fmtMoney(profit);

    // Status column: manual override or auto-detect
    let statusColIdx;
    if (config.statusCol && config.statusCol !== 'auto') {
      statusColIdx = colToIndex(config.statusCol);
    } else {
      statusColIdx = detectStatusColumn(rows);
    }

    let counts = { none: 0, shipped: 0, listed: 0, partial: 0, reserved: 0, soldout: 0 }, total = 0, other = 0;
    if (statusColIdx >= 0) {
      const r = tallyStatuses(rows, statusColIdx);
      counts = r.counts; total = r.total; other = r.other;
    }

    document.getElementById('totalItemsTag').textContent =
      total ? `รวม ${total} รายการ` + (other ? ` · พบสถานะอื่นอีก ${other} รายการที่ไม่ตรง 4 กลุ่ม` : '') : '';

    renderStatusGrid(counts, total);
    renderDonut(counts, total);

    // keep an active search result live/up to date after each refresh
    if (document.getElementById('searchInput').value.trim()) doSearch();

    clearError();
    setStatus('live', 'เชื่อมต่อสำเร็จ');
    const now = new Date();
    document.getElementById('lastUpdated').textContent = 'อัปเดตล่าสุด ' + now.toLocaleTimeString('th-TH');
  } catch (err) {
    console.error(err);
    setStatus('error', 'เชื่อมต่อไม่สำเร็จ');
    showError((err && err.message ? err.message : 'ไม่ทราบสาเหตุ') +
      ' — ตรวจสอบว่าตั้งค่า Sheet เป็น "Anyone with the link can view" และ Sheet ID ถูกต้อง');
  } finally {
    document.getElementById('refreshBtn').disabled = false;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const ms = Math.max(5, Number(config.interval) || 60) * 1000;
  pollTimer = setInterval(() => { loadData(); loadRevenueHistory(); }, ms);
}

// ---------- settings modal ----------
function populateColumnOptions() {
  const sel = document.getElementById('cfgStatusCol');
  sel.innerHTML = '<option value="auto">ตรวจจับอัตโนมัติ</option>';
  for (let i = 0; i < 26; i++) {
    const letter = indexToCol(i);
    const opt = document.createElement('option');
    opt.value = letter;
    opt.textContent = `คอลัมน์ ${letter}`;
    sel.appendChild(opt);
  }
}
function openSettings() {
  document.getElementById('cfgSheetId').value = config.sheetId;
  document.getElementById('cfgSheetName').value = config.sheetName;
  document.getElementById('cfgStatusCol').value = config.statusCol;
  document.getElementById('cfgInterval').value = config.interval;
  document.getElementById('settingsBackdrop').classList.add('open');
}
function closeSettings() {
  document.getElementById('settingsBackdrop').classList.remove('open');
}

// ---------- sidebar navigation ----------
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
  });
});

// ---------- calculate (price + shipping) ----------
const SHIPPING_BASE = 50;
const SHIPPING_PER_EXTRA_ITEM = 5;
let lastCalcMessage = '';

function buildCustomerMessage(subtotal, shipping, total) {
  const fmt = n => Number(n).toLocaleString('th-TH');
  return `รวมสินค้า ${fmt(subtotal)} + ค่าส่ง ${fmt(shipping)} (เริ่มต้น ${fmt(SHIPPING_BASE)} บ. + เพิ่มชิ้นละ ${fmt(SHIPPING_PER_EXTRA_ITEM)} บ.) = ${fmt(total)} บาทค่ะ 🌟🌈✨️`;
}

function copyCalcMessage() {
  const btn = document.getElementById('calcCopyBtn');
  navigator.clipboard.writeText(lastCalcMessage).then(() => {
    const original = btn.textContent;
    btn.textContent = 'คัดลอกแล้ว ✓';
    setTimeout(() => { btn.textContent = original; }, 1500);
  }).catch(() => {
    btn.textContent = 'คัดลอกไม่สำเร็จ';
    setTimeout(() => { btn.textContent = 'คัดลอกข้อความ'; }, 1500);
  });
}

function doCalculate() {
  const box = document.getElementById('calcResult');
  const raw = document.getElementById('calcInput').value.trim();
  if (!raw) { box.innerHTML = ''; return; }
  if (!lastRows) {
    box.innerHTML = '<p class="search-empty">ยังไม่มีข้อมูล กรุณารอให้โหลดข้อมูลก่อน</p>';
    return;
  }

  const tokens = raw.split(',').map(s => s.trim()).filter(Boolean);
  const found = [];
  const notFound = [];

  tokens.forEach(val => {
    const row = findRowByNo(val);
    if (!row) { notFound.push(val); return; }
    const price = cellNumber(row.c && row.c[PRICE_COL]);
    if (price === null) { notFound.push(val); return; }
    found.push({ no: cellText(row.c && row.c[0]) || val, price });
  });

  if (!found.length) {
    box.innerHTML = `<p class="search-empty">ไม่พบสินค้าที่ค้นหา: ${tokens.map(v => `"${v}"`).join(', ')}</p>`;
    return;
  }

  const n = found.length;
  const subtotal = found.reduce((sum, item) => sum + item.price, 0);
  const extraItems = Math.max(0, n - 1);
  const shippingExtra = extraItems * SHIPPING_PER_EXTRA_ITEM;
  const shipping = SHIPPING_BASE + shippingExtra;
  const total = subtotal + shipping;

  const itemRows = found.map(item =>
    `<div class="calc-row"><span>No. ${item.no}</span><span>${fmtMoney(item.price)}</span></div>`
  ).join('');

  const extraLine = extraItems > 0
    ? `<div class="calc-row"><span>ค่าส่งเพิ่ม (${extraItems} ชิ้น × ${fmtMoney(SHIPPING_PER_EXTRA_ITEM)})</span><span>${fmtMoney(shippingExtra)}</span></div>`
    : '';

  const notFoundNote = notFound.length
    ? `<p class="search-empty">ไม่พบสินค้า: ${notFound.map(v => `"${v}"`).join(', ')}</p>`
    : '';

  lastCalcMessage = buildCustomerMessage(subtotal, shipping, total);

  box.innerHTML = `
    <div class="search-result-card calc-card">
      <div class="search-result-head"><strong>สรุปการคำนวณ (${n} ชิ้น)</strong></div>
      <div class="calc-breakdown">
        ${itemRows}
        <div class="calc-divider"></div>
        <div class="calc-row"><span>ราคาสินค้ารวม</span><span>${fmtMoney(subtotal)}</span></div>
        <div class="calc-row"><span>ค่าส่งเริ่มต้น</span><span>${fmtMoney(SHIPPING_BASE)}</span></div>
        ${extraLine}
        <div class="calc-divider"></div>
        <div class="calc-row calc-total"><span>รวมทั้งหมด</span><span>${fmtMoney(total)}</span></div>
      </div>
    </div>
    ${notFoundNote}
    <div class="calc-message-box">
      <p class="calc-message-label">ข้อความแจ้งลูกค้า</p>
      <p class="calc-message-text">${lastCalcMessage}</p>
      <button class="ghost" id="calcCopyBtn" onclick="copyCalcMessage()">คัดลอกข้อความ</button>
    </div>
  `;
}

document.getElementById('calcBtn').addEventListener('click', doCalculate);
document.getElementById('calcInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doCalculate(); });

document.getElementById('refreshBtn').addEventListener('click', () => { loadData(); loadRevenueHistory(); });
document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('searchBtn').addEventListener('click', doSearch);
document.getElementById('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});
document.getElementById('settingsCancel').addEventListener('click', closeSettings);
document.getElementById('settingsBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'settingsBackdrop') closeSettings();
});
document.getElementById('settingsSave').addEventListener('click', () => {
  config = {
    sheetId: document.getElementById('cfgSheetId').value.trim() || DEFAULTS.sheetId,
    sheetName: document.getElementById('cfgSheetName').value.trim(),
    statusCol: document.getElementById('cfgStatusCol').value,
    interval: Number(document.getElementById('cfgInterval').value) || 60,
  };
  saveConfig(config);
  closeSettings();
  loadData();
  startPolling();
});

// ---------- trend charts (revenue + profit) ----------
let historyRows = []; // [{date, revenue, profit}], sorted ascending
let trendRange = 'week';
let customRange = null; // { from: Date, to: Date } | null — overrides trendRange when set

function buildHistoryUrl(cfg) {
  const base = `https://docs.google.com/spreadsheets/d/${cfg.sheetId}/gviz/tq?tqx=out:json&headers=1&sheet=RevenueHistory`;
  return base + '&_=' + Date.now();
}

function parseGvizDate(cell) {
  // gviz encodes dates as v: "Date(y,m,d,h,mi,s)" or a formatted string in .f
  if (!cell) return null;
  if (typeof cell.v === 'string' && cell.v.startsWith('Date(')) {
    const parts = cell.v.replace('Date(', '').replace(')', '').split(',').map(Number);
    return new Date(parts[0], parts[1], parts[2], parts[3] || 0, parts[4] || 0, parts[5] || 0);
  }
  if (cell.f) {
    const d = new Date(cell.f);
    if (!isNaN(d)) return d;
  }
  if (typeof cell.v === 'string') {
    const d = new Date(cell.v);
    if (!isNaN(d)) return d;
  }
  return null;
}

async function loadRevenueHistory() {
  try {
    const res = await fetch(buildHistoryUrl(config), { cache: 'no-store' });
    if (!res.ok) throw new Error('no history sheet');
    const text = await res.text();
    const table = parseGviz(text);
    const rows = table.rows || [];
    historyRows = rows.map(r => {
      const date = parseGvizDate(r.c && r.c[0]);
      const revenue = cellNumber(r.c && r.c[1]);
      const profit = cellNumber(r.c && r.c[2]);
      return date ? { date, revenue, profit } : null;
    }).filter(Boolean).sort((a, b) => a.date - b.date);
    renderTrendChart();
    renderProfitChart();
  } catch (err) {
    console.warn('revenue history not available yet:', err.message);
    const emptyMsg = '<p class="empty">ยังไม่มีข้อมูลย้อนหลัง — ต้องตั้งค่า Apps Script ให้บันทึกก่อน (ดู README)</p>';
    document.getElementById('trendSvgHolder').innerHTML = emptyMsg;
    document.getElementById('profitSvgHolder').innerHTML = emptyMsg;
  }
}

const CHART_POINTS = 8; // number of columns shown on the x-axis, for every range

function monthKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function yearKey(d) { return String(d.getFullYear()); }
function hourKey(d) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + '-' + d.getHours(); }
function minuteKey(d) { return hourKey(d) + '-' + d.getMinutes(); }
function mondayOf(d) {
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1) - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}
function weekKey(d) { return mondayOf(d).toISOString().slice(0, 10); }
function dayKey(d) { return d.toISOString().slice(0, 10); }

function lastPerGroup(series, keyFn) {
  const map = new Map();
  series.forEach(p => {
    const key = keyFn(p.date);
    const existing = map.get(key);
    if (!existing || p.date > existing.date) map.set(key, p);
  });
  return [...map.values()].sort((a, b) => a.date - b.date);
}

function buildSeries(metric) {
  // metric: 'revenue' | 'profit'
  return historyRows
    .filter(r => r[metric] !== null && r[metric] !== undefined)
    .map(r => ({ date: r.date, value: r[metric] }));
}

function aggregateHistory(series, range) {
  const cfgs = {
    minute: { key: minuteKey, fmt: { hour: '2-digit', minute: '2-digit' } },
    hour:   { key: hourKey,   fmt: { hour: '2-digit', minute: '2-digit' } },
    day:    { key: dayKey,    fmt: { day: '2-digit', month: '2-digit' } },
    week:   { key: weekKey,   fmt: { day: '2-digit', month: '2-digit' } },
    month:  { key: monthKey,  fmt: { month: 'short', year: '2-digit' } },
    year:   { key: yearKey,   fmt: { year: 'numeric' } },
  };
  const c = cfgs[range] || cfgs.week;
  return lastPerGroup(series, c.key).slice(-CHART_POINTS).map(p => ({
    label: range === 'minute' || range === 'hour'
      ? p.date.toLocaleTimeString('th-TH', c.fmt)
      : p.date.toLocaleDateString('th-TH', c.fmt),
    value: p.value,
  }));
}

const CUSTOM_RANGE_MAX_POINTS = 40; // cap so long custom ranges stay readable

function pointsForCustomRange(series, from, to) {
  const filtered = series.filter(p => p.date >= from && p.date <= to);
  const spanMs = to - from;
  const showTime = spanMs <= 3 * 24 * 60 * 60 * 1000; // <=3 days: show date+time
  const fmt = showTime
    ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: '2-digit' };
  const label = d => d.toLocaleString('th-TH', fmt);

  if (filtered.length <= CUSTOM_RANGE_MAX_POINTS) {
    return filtered.map(p => ({ label: label(p.date), value: p.value }));
  }
  // too many raw points — bucket evenly across the range and keep the latest per bucket
  const bucketMs = spanMs / CUSTOM_RANGE_MAX_POINTS;
  const map = new Map();
  filtered.forEach(p => {
    const idx = Math.min(CUSTOM_RANGE_MAX_POINTS - 1, Math.floor((p.date - from) / bucketMs));
    const existing = map.get(idx);
    if (!existing || p.date > existing.date) map.set(idx, p);
  });
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => ({ label: label(p.date), value: p.value }));
}

function getPoints(series) {
  if (customRange) return pointsForCustomRange(series, customRange.from, customRange.to);
  return aggregateHistory(series, trendRange);
}

// round a value up to a "nice" number (1/2/5 × 10^n) for clean axis labels
function niceCeil(value) {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / Math.pow(10, exponent);
  let niceFraction;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * Math.pow(10, exponent);
}

function buildLineChartSvg(points, colorHex) {
  const W = 560, H = 220, padL = 54, padR = 16, padT = 16, padB = 34;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const values = points.map(p => p.value);
  const dataMax = Math.max(...values, 0);
  const max = niceCeil(dataMax === 0 ? 1 : dataMax);
  const min = 0;
  const TICKS = 6; // ~6 evenly spaced price levels from 0 to max

  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const xAt = i => padL + stepX * i;
  const yAt = v => padT + innerH - ((v - min) / (max - min)) * innerH;

  const linePts = points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(' ');
  const areaPts = `${xAt(0).toFixed(1)},${(padT + innerH).toFixed(1)} ${linePts} ${xAt(points.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)}`;

  const dots = points.map((p, i) =>
    `<circle class="chart-dot" cx="${xAt(i).toFixed(1)}" cy="${yAt(p.value).toFixed(1)}" r="9" fill="${colorHex}" fill-opacity="0" stroke="${colorHex}" stroke-width="0" data-label="${p.label}" data-value="${fmtMoney(p.value)}"/>` +
    `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.value).toFixed(1)}" r="3.5" fill="${colorHex}" style="pointer-events:none"/>`
  ).join('');

  const labelEvery = points.length > 10 ? Math.ceil(points.length / 8) : 1;
  const labels = points.map((p, i) => {
    if (i % labelEvery !== 0 && i !== points.length - 1) return '';
    return `<text x="${xAt(i).toFixed(1)}" y="${H - 10}" font-size="10" fill="#6e7c89" text-anchor="middle">${p.label}</text>`;
  }).join('');

  // horizontal gridlines + labels, evenly spaced 0..max in TICKS steps
  let gridlines = '';
  for (let i = 0; i < TICKS; i++) {
    const val = (max / (TICKS - 1)) * i;
    const y = yAt(val);
    gridlines += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + innerW}" y2="${y.toFixed(1)}" stroke="#e7ebef" stroke-width="1"/>`;
    gridlines += `<text x="${padL - 8}" y="${(y + 3).toFixed(1)}" font-size="10" fill="#6e7c89" text-anchor="end">${fmtMoney(val)}</text>`;
  }

  return `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      ${gridlines}
      <polygon points="${areaPts}" fill="${colorHex}" opacity="0.08"/>
      <polyline points="${linePts}" fill="none" stroke="${colorHex}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      ${labels}
    </svg>
  `;
}

function attachChartTooltip(holderEl, tooltipEl) {
  const svg = holderEl.querySelector('svg');
  if (!svg) return;
  svg.querySelectorAll('.chart-dot').forEach(dot => {
    dot.addEventListener('mouseenter', () => {
      tooltipEl.textContent = `${dot.dataset.label} · ${dot.dataset.value}`;
      tooltipEl.style.opacity = '1';
    });
    dot.addEventListener('mousemove', (e) => {
      const rect = holderEl.parentElement.getBoundingClientRect();
      let left = e.clientX - rect.left + 12;
      let top = e.clientY - rect.top - 34;
      tooltipEl.style.left = left + 'px';
      tooltipEl.style.top = top + 'px';
    });
    dot.addEventListener('mouseleave', () => { tooltipEl.style.opacity = '0'; });
  });
}

function renderChart(metric, holderId, tooltipId, colorHex, emptyLabel) {
  const holder = document.getElementById(holderId);
  const tooltip = document.getElementById(tooltipId);
  const series = buildSeries(metric);
  if (!series.length) {
    holder.innerHTML = `<p class="empty">ยังไม่มีข้อมูล${emptyLabel}ย้อนหลัง — ต้องตั้งค่า Apps Script ให้บันทึกก่อน (ดู README)</p>`;
    return;
  }
  const points = getPoints(series);
  if (points.length < 2) {
    holder.innerHTML = '<p class="empty">มีข้อมูลแค่จุดเดียว รอรอบถัดไปให้กราฟขึ้นเส้นได้</p>';
    return;
  }
  holder.innerHTML = buildLineChartSvg(points, colorHex);
  attachChartTooltip(holder, tooltip);
}

function renderTrendChart() {
  renderChart('revenue', 'trendSvgHolder', 'trendTooltip', '#1a63a8', 'รายได้');
}
function renderProfitChart() {
  renderChart('profit', 'profitSvgHolder', 'profitTooltip', '#f15e22', 'กำไร');
}

document.getElementById('trendToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.trend-btn');
  if (!btn) return;
  customRange = null;
  document.querySelectorAll('.trend-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  trendRange = btn.dataset.range;
  renderTrendChart();
  renderProfitChart();
});

document.getElementById('trendCustomBtn').addEventListener('click', () => {
  const fromVal = document.getElementById('trendFromDate').value;
  const toVal = document.getElementById('trendToDate').value;
  if (!fromVal || !toVal) return;
  const from = new Date(fromVal + 'T00:00:00');
  const to = new Date(toVal + 'T23:59:59');
  if (from > to) return;
  customRange = { from, to };
  document.querySelectorAll('.trend-btn').forEach(b => b.classList.remove('active'));
  renderTrendChart();
  renderProfitChart();
});

document.getElementById('trendResetBtn').addEventListener('click', () => {
  customRange = null;
  document.getElementById('trendFromDate').value = '';
  document.getElementById('trendToDate').value = '';
  document.querySelectorAll('.trend-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.trend-btn[data-range="week"]').classList.add('active');
  trendRange = 'week';
  renderTrendChart();
  renderProfitChart();
});

// ---------- init ----------
function initApp() {
  populateColumnOptions();
  loadData();
  loadRevenueHistory();
  startPolling();
}
initApp();
