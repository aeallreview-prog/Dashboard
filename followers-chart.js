/* Group real observations in Bangkok time; keep the last reading in each interval. */
function buildFollowerPoints(rows, range, customRange) {
  const DAY = 86400000;
  const formats = {
    day: { day: '2-digit', month: '2-digit' },
    week: { day: '2-digit', month: '2-digit' },
    month: { month: 'short', year: '2-digit' },
    year: { year: 'numeric' }
  };
  const grouped = new Map();
  rows.forEach(row => {
    const time = Date.parse(row.observedAt);
    if (!Number.isFinite(time) || (customRange && (time < customRange.from || time > customRange.to))) return;
    const local = new Date(time + 7 * 3600000);
    const day = Math.floor(local.getTime() / DAY);
    let bucket;
    switch (range) {
      case 'day': bucket = day; break;
      case 'month': bucket = local.getUTCFullYear() * 12 + local.getUTCMonth(); break;
      case 'year': bucket = local.getUTCFullYear(); break;
      default: bucket = Math.floor((day + 4) / 7); // Sunday starts the Bangkok week.
    }
    const old = grouped.get(bucket);
    if (!old || time >= old.time) grouped.set(bucket, { row, time, bucket });
  });
  const points = Array.from(grouped.values()).sort((a, b) => a.time - b.time);
  // Match the other charts: latest 8 groups, up to 40 for a custom date range.
  let selected = points.slice(-(customRange ? 40 : 8));
  if (customRange && points.length > 40) {
    // Keep both ends of a long range and distribute the remaining observed points.
    selected = Array.from({ length: 40 }, (_, i) => points[Math.round(i * (points.length - 1) / 39)]);
  }
  return selected.map((item, i) => ({
    value: item.row.count,
    label: new Date(item.time).toLocaleString('th-TH', { ...formats[range] || formats.week, timeZone: 'Asia/Bangkok' }),
    tooltipLabel: new Date(item.time).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }),
    breakBefore: i > 0 && item.bucket - selected[i - 1].bucket > 1
  }));
}

function followerThaiDate(time = Date.now()) {
  return new Date(time + 7 * 3600000).toISOString().slice(0, 10);
}

function followerWeekStart(time = Date.now()) {
  const date = new Date(followerThaiDate(time) + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date.toISOString().slice(0, 10);
}

function mergeFollowerHistory(seed, manual) {
  const byDate = new Map();
  [...seed, ...manual].forEach(row => {
    if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
        !Number.isSafeInteger(row.count) || row.count < 1 || row.count > 1000000000 ||
        !Number.isFinite(Date.parse(row.observedAt)) ||
        followerThaiDate(Date.parse(row.observedAt)) !== row.date) return;
    byDate.set(row.date, row);
  });
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function followerWeekMissing(rows, time = Date.now()) {
  const start = followerWeekStart(time);
  const today = followerThaiDate(time);
  return !rows.some(row => row.source === 'manual' && row.date >= start && row.date <= today);
}

(() => {
  const root = document.getElementById('followerChart');
  if (!root) return;
  const note = document.getElementById('followerNote');
  const refresh = document.getElementById('followerRefresh');
  const form = document.getElementById('followerForm');
  const input = document.getElementById('followerInput');
  const save = document.getElementById('followerSave');
  const saveStatus = document.getElementById('followerSaveStatus');
  const reminder = document.getElementById('followerReminder');
  const formatter = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 0 });
  let rows = [];
  let range = 'week';
  let customRange = null;
  let loading = false;
  let saving = false;
  let historyReady = false;
  let seedRows = [];
  let manualRows = [];
  const dayNumber = date => Date.parse(date + 'T00:00:00+07:00');
  // Use the same rendered SVG width as revenue/profit so labels and strokes scale equally.
  const referenceChart = document.getElementById('trendSvgHolder');
  const matchChartSize = () => {
    const width = referenceChart.getBoundingClientRect().width;
    if (width > 0) root.style.maxWidth = width + 'px';
  };
  const chartSizeObserver = new ResizeObserver(matchChartSize);
  chartSizeObserver.observe(referenceChart);
  matchChartSize();

  function updateReminder() {
    reminder.hidden = !historyReady || !followerWeekMissing(rows);
    reminder.textContent = 'สัปดาห์นี้ยังไม่ได้กรอกยอดผู้ติดตาม — เปิด IG ดูยอดล่าสุด แล้วกรอกด้านล่าง (อาทิตย์–เสาร์)';
  }

  function updateControls() {
    refresh.disabled = loading || saving;
    save.disabled = !historyReady || loading || saving;
    input.disabled = saving;
    save.textContent = saving ? 'กำลังบันทึก…' : 'บันทึกยอด';
  }

  function showSaveStatus(message, error = false) {
    saveStatus.textContent = message;
    saveStatus.dataset.error = String(error);
  }

  function render() {
    updateReminder();
    document.getElementById('followerTooltip').style.opacity = '0';
    if (!rows.length) {
      root.innerHTML = '';
      document.getElementById('followerCount').textContent = '—';
      document.getElementById('followerChange').textContent = '';
      note.textContent = 'ยังไม่มีข้อมูลผู้ติดตามที่อ่านได้';
      return;
    }
    const latest = rows[rows.length - 1];
    document.getElementById('followerCount').textContent = formatter.format(latest.count);
    const points = buildFollowerPoints(rows, range, customRange);
    const difference = points.length > 1 ? points[points.length - 1].value - points[0].value : null;
    document.getElementById('followerChange').textContent = difference === null
      ? ''
      : (difference > 0 ? '+' : '') + formatter.format(difference) + ' คน ในช่วงที่เลือก';
    note.textContent = '';
    if (!points.length) {
      root.innerHTML = '<p class="empty">ไม่มีข้อมูลในช่วงที่เลือก</p>';
      return;
    }
    root.innerHTML = buildLineChartSvg(points, '#1a63a8', value => formatter.format(value), { min: 300, max: 500, ticks: 5 });
    const svg = root.querySelector('svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'แนวโน้มผู้ติดตาม Instagram ในช่วงที่เลือก ' + points.length + ' จุดข้อมูล');
    svg.querySelectorAll('.chart-dot').forEach(dot => {
      dot.dataset.value += ' คน';
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = dot.dataset.label + ' · ' + dot.dataset.value;
      dot.appendChild(title);
    });
    attachChartTooltip(root, document.getElementById('followerTooltip'));
  }

  function loadSeedHistory() {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => finish(new Error('โหลดประวัติเดิมหมดเวลา')), 15000);
      script.src = 'followers-history.js?v=' + Date.now();
      script.onload = () => {
        const data = window.SNT_FOLLOWER_HISTORY;
        if (!data || data.username !== 'seek.n.tique' || !Array.isArray(data.observations)) {
          finish(new Error('รูปแบบประวัติเดิมไม่ถูกต้อง'));
          return;
        }
        seedRows = mergeFollowerHistory(data.observations, []);
        finish();
      };
      script.onerror = () => finish(new Error('โหลดประวัติเดิมไม่ได้'));
      function finish(error) {
        clearTimeout(timer);
        script.onload = script.onerror = null;
        script.remove();
        if (error) reject(error); else resolve();
      }
      document.head.appendChild(script);
    });
  }

  async function loadHistory() {
    if (loading || saving) return;
    loading = true;
    historyReady = false;
    updateControls();
    updateReminder();
    let seedError = false;
    try {
      await loadSeedHistory().catch(() => { seedError = true; });
      const data = await callWriteApi('getFollowerHistory', {});
      if (!data || !Array.isArray(data.observations)) throw new Error('รูปแบบประวัติไม่ถูกต้อง');
      manualRows = mergeFollowerHistory([], data.observations);
      historyReady = true;
      rows = mergeFollowerHistory(seedRows, manualRows);
      render();
      note.textContent = seedError ? 'โหลดข้อมูลที่กรอกเองแล้ว แต่โหลดประวัติเดิมไม่ได้ กรุณาลองโหลดอีกครั้ง' : '';
    } catch (error) {
      rows = mergeFollowerHistory(seedRows, manualRows);
      render();
      note.textContent = 'ยังเชื่อมต่อประวัติที่กรอกเองไม่ได้ ข้อมูลที่เห็นอาจไม่ใช่ล่าสุด — กรุณาอัปเดต Apps Script ให้รองรับผู้ติดตาม แล้วกดโหลดข้อมูลล่าสุด';
    } finally {
      loading = false;
      updateControls();
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || loading || !historyReady) return;
    const raw = input.value.trim();
    const count = Number(raw);
    if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(count) || count < 1 || count > 1000000000) {
      showSaveStatus('กรุณากรอกยอดทั้งหมดเป็นจำนวนเต็มตั้งแต่ 1 ถึง 1,000,000,000', true);
      return;
    }
    saving = true;
    updateControls();
    showSaveStatus('');
    try {
      const data = await callWriteApi('saveFollowerCount', { count });
      if (!data || !Array.isArray(data.observations) || data.count !== count ||
          !data.observations.some(row => row.date === data.savedDate && row.count === count && row.source === 'manual')) {
        throw new Error('ยังยืนยันผลบันทึกไม่ได้ กรุณาโหลดข้อมูลล่าสุดเพื่อตรวจสอบก่อนลองอีกครั้ง');
      }
      manualRows = mergeFollowerHistory([], data.observations);
      rows = mergeFollowerHistory(seedRows, manualRows);
      range = 'day';
      clearDates();
      updateButtons();
      render();
      input.value = '';
      showSaveStatus('บันทึก ' + formatter.format(count) + ' คน ลง Google Sheet แล้ว');
    } catch (error) {
      showSaveStatus('บันทึกไม่สำเร็จ: ' + error.message, true);
    } finally {
      saving = false;
      updateControls();
    }
  });
  function updateButtons() {
    document.querySelectorAll('#followerRange button').forEach(item => {
      item.classList.toggle('active', item.dataset.range === range);
      item.setAttribute('aria-pressed', String(item.dataset.range === range));
    });
  }
  function clearDates() {
    customRange = null;
    document.getElementById('followerFromDate').value = '';
    document.getElementById('followerToDate').value = '';
  }
  document.getElementById('followerRange').addEventListener('click', event => {
    const button = event.target.closest('button[data-range]');
    if (!button) return;
    range = button.dataset.range;
    updateButtons();
    render();
  });
  document.getElementById('followerCustomBtn').addEventListener('click', () => {
    const from = dayNumber(document.getElementById('followerFromDate').value);
    const to = Date.parse(document.getElementById('followerToDate').value + 'T23:59:59.999+07:00');
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      note.textContent = 'กรุณาเลือกวันที่เริ่มต้นและสิ้นสุดให้ถูกต้อง';
      return;
    }
    customRange = { from, to };
    render();
  });
  document.getElementById('followerResetBtn').addEventListener('click', () => {
    range = 'week';
    clearDates();
    updateButtons();
    render();
  });
  refresh.addEventListener('click', loadHistory);
  // Re-check the week even when the dashboard stays open across Sunday midnight.
  setInterval(updateReminder, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadHistory();
  });
  loadHistory();
})();
