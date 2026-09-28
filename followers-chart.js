/* Group real observations in Bangkok time; keep the last reading in each interval. */
function buildFollowerPoints(rows, range, customRange) {
  const DAY = 86400000;
  const formats = {
    minute: { hour: '2-digit', minute: '2-digit' },
    hour: { hour: '2-digit', minute: '2-digit' },
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
      case 'minute': bucket = Math.floor(local.getTime() / 60000); break;
      case 'hour': bucket = Math.floor(local.getTime() / 3600000); break;
      case 'day': bucket = day; break;
      case 'month': bucket = local.getUTCFullYear() * 12 + local.getUTCMonth(); break;
      case 'year': bucket = local.getUTCFullYear(); break;
      default: bucket = Math.floor((day + 3) / 7); // Monday starts the week.
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

(() => {
  const root = document.getElementById('followerChart');
  if (!root) return;
  const note = document.getElementById('followerNote');
  const refresh = document.getElementById('followerRefresh');
  const formatter = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 0 });
  let rows = [];
  let range = 'week';
  let customRange = null;
  let loading = false;
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

  function render() {
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
    root.innerHTML = buildLineChartSvg(points, '#1a63a8', value => formatter.format(value));
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

  function loadHistory() {
    if (loading) return;
    loading = true;
    refresh.disabled = true;
    const script = document.createElement('script');
    script.src = 'followers-history.js?v=' + Date.now();
    script.onload = () => {
      const data = window.SNT_FOLLOWER_HISTORY;
      const byTime = new Map();
      if (data && data.username === 'seek.n.tique' && Array.isArray(data.observations)) {
        data.observations.forEach(row => {
          if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isInteger(row.count) || row.count < 0 ||
              !Number.isFinite(dayNumber(row.date)) || !Number.isFinite(Date.parse(row.observedAt))) return;
          byTime.set(Date.parse(row.observedAt), row);
        });
      }
      rows = Array.from(byTime.values()).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
      render();
      finish();
    };
    script.onerror = () => {
      note.textContent = 'โหลดประวัติผู้ติดตามไม่ได้ กรุณาลองโหลดข้อมูลล่าสุดอีกครั้ง';
      finish();
    };
    function finish() {
      loading = false;
      refresh.disabled = false;
      script.remove();
    }
    document.head.appendChild(script);
  }
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
  loadHistory();
})();
