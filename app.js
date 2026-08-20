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
  interval: 30,
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
    let tag = '';
    if (config.statusCol && config.statusCol !== 'auto') {
      statusColIdx = colToIndex(config.statusCol);
      tag = `(คอลัมน์ ${config.statusCol})`;
    } else {
      statusColIdx = detectStatusColumn(rows);
      tag = statusColIdx >= 0 ? `(ตรวจพบอัตโนมัติ: คอลัมน์ ${indexToCol(statusColIdx)})` : '(ยังไม่พบคอลัมน์สถานะ)';
    }
    document.getElementById('statusColTag').textContent = tag;

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
  const ms = Math.max(5, Number(config.interval) || 30) * 1000;
  pollTimer = setInterval(loadData, ms);
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

document.getElementById('refreshBtn').addEventListener('click', loadData);
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
    interval: Number(document.getElementById('cfgInterval').value) || 30,
  };
  saveConfig(config);
  closeSettings();
  loadData();
  startPolling();
});

// ---------- login gate ----------
const LOGIN_ID = 'snt';
const LOGIN_PASS = 'snt';

function attemptLogin() {
  const idVal = document.getElementById('loginId').value.trim();
  const passVal = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  if (idVal === LOGIN_ID && passVal === LOGIN_PASS) {
    document.getElementById('loginBackdrop').style.display = 'none';
    document.querySelector('.shell').classList.remove('hidden');
    initApp();
  } else {
    errEl.textContent = 'ID หรือ Password ไม่ถูกต้อง';
  }
}
document.getElementById('loginBtn').addEventListener('click', attemptLogin);
document.getElementById('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptLogin(); });
document.getElementById('loginId').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('loginPass').focus();
});

// ---------- init ----------
function initApp() {
  populateColumnOptions();
  loadData();
  startPolling();
}
