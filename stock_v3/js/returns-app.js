/* =============================================================
   returns-app.js — Returns table + bubble chart
   Loads data from bundles: data/{gridname}_daily_bundle.json
   Table:  Period 1 / 2 / 3, sortable columns
   Bubble: Period 1 = X axis, Period 2 = Y axis,
           sector-coloured bubbles, drag-to-zoom, hover tooltip
   ============================================================= */

import { fetchJSON, buildNavTabs, initClearWatchlistButton } from './grid.js';

// ── Constants ──────────────────────────────────────────────────
const DATA_PATH = '../data/';
const GRID_NAME = 'returns';

const PAD      = { top: 30, right: 30, bottom: 48, left: 60 };
const BUBBLE_R = 6;

const SECTOR_COLORS = [
  '#4af0b0', '#60a5fa', '#f97316', '#facc15', '#f04f5e',
  '#a78bfa', '#34d399', '#fb7185', '#38bdf8', '#e879f9',
  '#4ade80', '#fbbf24',
];

const PRESETS = {
  '1w': () => ({ start: daysAgo(7),    end: today() }),
  '1m': () => ({ start: monthsAgo(1),  end: today() }),
  '3m': () => ({ start: monthsAgo(3),  end: today() }),
  '6m': () => ({ start: monthsAgo(6),  end: today() }),
  '1y': () => ({ start: monthsAgo(12), end: today() }),
};

// ── State ──────────────────────────────────────────────────────
let currentGrid = 'sp500';
let currentView = 'table';
let datasets    = [];

const periods = [
  { preset: '1w', startDate: null, endDate: null },
  { preset: '1m', startDate: null, endDate: null },
  { preset: '3m', startDate: null, endDate: null },
];

let sortCol = 'ticker';
let sortDir = 'asc';

let bubbleZoom    = null;
let hiddenSectors = new Set();
let sectorColorMap = {};

// ── Date helpers ───────────────────────────────────────────────
function today()      { const d = new Date(); d.setHours(0,0,0,0); return d; }
function daysAgo(n)   { const d = today(); d.setDate(d.getDate() - n); return d; }
function monthsAgo(n) { const d = today(); d.setMonth(d.getMonth() - n); return d; }
function toISODate(d) { return d.toISOString().slice(0, 10); }
function fmtShort(iso) {
  return new Date(iso + 'T00:00:00').toLocaleString('en', { day: 'numeric', month: 'short' });
}

function closestIdx(ohlcv, targetISO) {
  let lo = 0, hi = ohlcv.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ohlcv[mid].t <= targetISO) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

function calcReturn(ohlcv, startISO, endISO) {
  if (!ohlcv || ohlcv.length < 2) return null;
  const iS = closestIdx(ohlcv, startISO);
  const iE = closestIdx(ohlcv, endISO);
  if (iS === iE) return null;
  const pS = ohlcv[iS].c;
  if (!pS) return null;
  return (ohlcv[iE].c - pS) / pS * 100;
}

function resolvePeriod(idx) {
  const p = periods[idx];
  if (p.preset === 'custom') return { startISO: p.startDate, endISO: p.endDate };
  const fn = PRESETS[p.preset];
  if (!fn) return null;
  const { start, end } = fn();
  return { startISO: toISODate(start), endISO: toISODate(end) };
}

// ── Bubble axis metric config ──────────────────────────────────
// To add a new bubble metric: add one entry here. Nothing else changes.
// source: 'period0'|'period1' = use period date range from controls
//         'computed'          = call fn(ohlcv) directly
//         'sma_change'        = uses smaChangeDates state

const BUBBLE_METRICS = [
  { key: 'period0',    label: 'Period 1 return',         source: 'period0',    fmt: 'pct' },
  { key: 'period1',    label: 'Period 2 return',         source: 'period1',    fmt: 'pct' },
  { key: 'period2',    label: 'Period 3 return',         source: 'period2',    fmt: 'pct' },
  { key: 'pct_sma50',  label: '% from SMA 50 (current)', source: 'computed',   fmt: 'pct',
    fn: ohlcv => calcPctFromSma(ohlcv, 50) },
  { key: 'sma_change', label: 'Change in % from SMA 50', source: 'sma_change', fmt: 'pct' },
];

// Which metric is selected for each axis
let bubbleAxisX = 'period0';
let bubbleAxisY = 'period1';

// Date range for the SMA change metric
const smaChangeDates = { startISO: null, endISO: null };

// ── SMA helpers ────────────────────────────────────────────────

// Compute SMA(n) at a specific bar index
function smaAt(ohlcv, idx, n) {
  if (idx < n - 1) return null;
  let sum = 0;
  for (let i = idx - n + 1; i <= idx; i++) sum += ohlcv[i].c;
  return sum / n;
}

// % distance from SMA(n) at a specific bar index
function pctFromSmaAt(ohlcv, idx, n) {
  const s = smaAt(ohlcv, idx, n);
  if (s == null || s === 0) return null;
  return (ohlcv[idx].c - s) / s * 100;
}

// % from SMA(n) using the latest bar
function calcPctFromSma(ohlcv, n) {
  if (!ohlcv || ohlcv.length < n) return null;
  return pctFromSmaAt(ohlcv, ohlcv.length - 1, n);
}

// Change in % from SMA 50 between two dates
function calcSmaChange(ohlcv, startISO, endISO) {
  if (!ohlcv || ohlcv.length < 50) return null;
  const iS = closestIdx(ohlcv, startISO);
  const iE = closestIdx(ohlcv, endISO);
  if (iS === iE) return null;
  const pS = pctFromSmaAt(ohlcv, iS, 50);
  const pE = pctFromSmaAt(ohlcv, iE, 50);
  if (pS == null || pE == null) return null;
  return pE - pS;
}

// Resolve a single metric value for a dataset
function resolveMetric(metricKey, d) {
  const m = BUBBLE_METRICS.find(m => m.key === metricKey);
  if (!m) return null;

  if (m.source === 'period0' || m.source === 'period1' || m.source === 'period2') {
    const idx = m.source === 'period0' ? 0 : m.source === 'period1' ? 1 : 2;
    const r   = resolvePeriod(idx);
    return r ? calcReturn(d.ohlcv, r.startISO, r.endISO) : null;
  }
  if (m.source === 'computed') return m.fn(d.ohlcv);
  if (m.source === 'sma_change') {
    const { startISO, endISO } = smaChangeDates;
    if (!startISO || !endISO) return null;
    return calcSmaChange(d.ohlcv, startISO, endISO);
  }
  return null;
}

// Metric label including date context where relevant
function metricLabel(metricKey) {
  const m = BUBBLE_METRICS.find(m => m.key === metricKey);
  if (!m) return metricKey;
  if (m.source === 'period0' || m.source === 'period1' || m.source === 'period2') {
    const idx = m.source === 'period0' ? 0 : m.source === 'period1' ? 1 : 2;
    const r   = resolvePeriod(idx);
    return r ? `${m.label} (${fmtShort(r.startISO)}→${fmtShort(r.endISO)})` : m.label;
  }
  if (m.source === 'sma_change' && smaChangeDates.startISO && smaChangeDates.endISO) {
    return `${m.label} (${fmtShort(smaChangeDates.startISO)}→${fmtShort(smaChangeDates.endISO)})`;
  }
  return m.label;
}

// ── Computed rows ──────────────────────────────────────────────
function buildRows() {
  const r = [0, 1, 2].map(resolvePeriod);
  return datasets.map(d => ({
    ticker:   d.ticker,
    name:     d.info?.shortName || '—',
    sector:   d.info?.sector    || '—',
    industry: d.info?.industry  || '—',
    r0: r[0] ? calcReturn(d.ohlcv, r[0].startISO, r[0].endISO) : null,
    r1: r[1] ? calcReturn(d.ohlcv, r[1].startISO, r[1].endISO) : null,
    r2: r[2] ? calcReturn(d.ohlcv, r[2].startISO, r[2].endISO) : null,
    // Bubble axis values — computed on demand
    _d: d,   // keep reference for resolveMetric
  }));
}

// Get X and Y values for a row in the bubble chart
function getBubbleXY(row) {
  return {
    x: resolveMetric(bubbleAxisX, row._d),
    y: resolveMetric(bubbleAxisY, row._d),
  };
}

// ── Period controls ────────────────────────────────────────────
function initPeriodControls() {
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pIdx   = parseInt(btn.dataset.period);
      const preset = btn.dataset.preset;
      document.querySelectorAll(`.preset-btn[data-period="${pIdx}"]`)
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      periods[pIdx].preset = preset;
      document.getElementById(`p${pIdx}-dates`).style.display =
        preset === 'custom' ? 'flex' : 'none';
      if (preset !== 'custom') refresh();
    });
  });

  [0, 1, 2].forEach(pIdx => {
    const sEl = document.getElementById(`p${pIdx}-start`);
    const eEl = document.getElementById(`p${pIdx}-end`);
    if (!sEl || !eEl) return;
    const res = resolvePeriod(pIdx);
    if (res) { sEl.value = res.startISO; eEl.value = res.endISO; }
    const onChange = () => {
      if (!sEl.value || !eEl.value) return;
      periods[pIdx].startDate = sEl.value;
      periods[pIdx].endDate   = eEl.value;
      refresh();
    };
    sEl.addEventListener('change', onChange);
    eEl.addEventListener('change', onChange);
  });
}

// ── View toggle ────────────────────────────────────────────────
function initViewToggle() {
  document.getElementById('view-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (!btn || btn.dataset.view === currentView) return;
    document.querySelectorAll('#view-toggle .seg-btn')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.dataset.view;
    document.body.classList.toggle('bubble-active', currentView === 'bubble');
    document.getElementById('table-wrap').style.display  = currentView === 'table'  ? 'block' : 'none';
    document.getElementById('bubble-view').style.display = currentView === 'bubble' ? 'block' : 'none';
    if (currentView === 'bubble') drawBubble();
    else                          rebuildTable();
  });
}

// ── Grid selector ──────────────────────────────────────────────
function initGridSelector() {
  document.getElementById('grid-selector').addEventListener('click', async e => {
    const btn = e.target.closest('.seg-btn');
    if (!btn || btn.dataset.grid === currentGrid) return;
    document.querySelectorAll('#grid-selector .seg-btn')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentGrid = btn.dataset.grid;
    await loadGrid();
  });
}

function refresh() {
  updateResolvedLabels();
  if (currentView === 'table') rebuildTable();
  else                         drawBubble();
}

function updateResolvedLabels() {
  [0, 1, 2].forEach(i => {
    const r  = resolvePeriod(i);
    const el = document.getElementById(`p${i}-resolved`);
    if (el && r) el.textContent = `${r.startISO} → ${r.endISO}`;
  });
}

// ── Data loading — reads from bundle ──────────────────────────
async function loadGrid() {
  const status    = document.getElementById('table-status');
  const tableWrap = document.getElementById('table-wrap');
  const bubbleV   = document.getElementById('bubble-view');

  status.style.display    = 'block';
  status.innerHTML        = `<span class="spinner"></span> Loading ${currentGrid}…`;
  tableWrap.style.display = 'none';
  bubbleV.style.display   = 'none';

  try {
    const bundle  = await fetchJSON(DATA_PATH + `${currentGrid}_daily_bundle.json`);
    const updated = bundle.generated
      ? new Date(bundle.generated).toLocaleString() : '—';

    datasets = bundle.tickers || [];
    document.getElementById('meta-info').textContent =
      `${datasets.length} tickers · ${updated}`;

    // Build sector colour map
    const sectors = [...new Set(datasets.map(d => d.info?.sector || '—'))].sort();
    sectorColorMap = {};
    sectors.forEach((s, i) => {
      sectorColorMap[s] = SECTOR_COLORS[i % SECTOR_COLORS.length];
    });
    hiddenSectors = new Set();
    buildBubbleLegend(sectors);

    status.style.display = 'none';
    if (currentView === 'table') {
      tableWrap.style.display = 'block';
      rebuildTable();
    } else {
      bubbleV.style.display = 'block';
      drawBubble();
    }
    updateResolvedLabels();

  } catch (e) {
    status.innerHTML =
      `⚠ ${e.message}<br><small>Run <code>python download_data.py</code> first.</small>`;
  }
}

// ── TABLE ──────────────────────────────────────────────────────
function rebuildTable() {
  const resolved = [0, 1, 2].map(resolvePeriod);
  resolved.forEach((r, i) => {
    const el = document.getElementById(`th-p${i}`);
    if (el) el.textContent = r ? `${fmtShort(r.startISO)} → ${fmtShort(r.endISO)}` : '';
  });

  let rows = sortRows(buildRows());
  const tbody = document.getElementById('returns-tbody');
  tbody.innerHTML = '';
  rows.forEach(row => tbody.appendChild(buildRow(row)));

  document.querySelectorAll('#returns-table thead th').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === sortCol)
      th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
  });
}

function buildRow(row) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="rt-ticker">${row.ticker}</td>
    <td class="rt-name">${esc(row.name)}</td>
    <td class="rt-sector">${esc(row.sector)}</td>
    <td class="rt-industry">${esc(row.industry)}</td>
    <td class="num">${fmtReturn(row.r0)}</td>
    <td class="num">${fmtReturn(row.r1)}</td>
    <td class="num">${fmtReturn(row.r2)}</td>`;
  return tr;
}

function fmtReturn(val) {
  if (val == null || isNaN(val)) return `<span class="rt-return flat">—</span>`;
  const cls  = val > 0.05 ? 'up' : val < -0.05 ? 'down' : 'flat';
  const sign = val > 0 ? '+' : '';
  return `<span class="rt-return ${cls}">${sign}${val.toFixed(2)}%</span>`;
}

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    let vA = a[sortCol], vB = b[sortCol];
    if (vA == null && vB == null) return 0;
    if (vA == null) return 1;
    if (vB == null) return -1;
    const cmp = typeof vA === 'number'
      ? vA - vB : String(vA).localeCompare(String(vB));
    return sortDir === 'asc' ? cmp : -cmp;
  });
}

function initSortableHeaders() {
  document.querySelectorAll('#returns-table thead th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortCol = col; sortDir = col.startsWith('r') ? 'desc' : 'asc'; }
      rebuildTable();
    });
  });
}

// ── BUBBLE CHART ───────────────────────────────────────────────
const canvas  = document.getElementById('bubble-canvas');
const ctx     = canvas.getContext('2d');
const tooltip = document.getElementById('bubble-tooltip');

function drawBubble() {
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.offsetWidth;
  const H   = parseInt(canvas.getAttribute('height')) || 580;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  const rows = buildRows().filter(r => {
    const { x, y } = getBubbleXY(r);
    return x != null && y != null && !hiddenSectors.has(r.sector);
  });

  if (!rows.length) {
    ctx.fillStyle = '#8896aa';
    ctx.font = `14px 'Inter',sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('No data', W / 2, H / 2);
    return;
  }

  let xMin, xMax, yMin, yMax;
  if (bubbleZoom) {
    ({ xMin, xMax, yMin, yMax } = bubbleZoom);
  } else {
    const xs = rows.map(r => getBubbleXY(r).x);
    const ys = rows.map(r => getBubbleXY(r).y);
    xMin = Math.min(...xs); xMax = Math.max(...xs);
    yMin = Math.min(...ys); yMax = Math.max(...ys);
    xMin = Math.min(xMin, 0); xMax = Math.max(xMax, 0);
    yMin = Math.min(yMin, 0); yMax = Math.max(yMax, 0);
    const xPad = (xMax - xMin || 2) * 0.10;
    const yPad = (yMax - yMin || 2) * 0.10;
    xMin -= xPad; xMax += xPad;
    yMin -= yPad; yMax += yPad;
  }

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top  - PAD.bottom;
  const toX = v => PAD.left + (v - xMin) / (xMax - xMin) * innerW;
  const toY = v => PAD.top  + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  // Background
  ctx.fillStyle = '#141820';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgb(36,44,53)';
  ctx.fillRect(PAD.left, PAD.top, innerW, innerH);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  niceAxisTicks(xMin, xMax, 6).forEach(v => {
    const x = toX(v);
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + innerH); ctx.stroke();
  });
  niceAxisTicks(yMin, yMax, 6).forEach(v => {
    const y = toY(v);
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + innerW, y); ctx.stroke();
  });

  // Zero lines — quadrant dividers
  const x0 = toX(0), y0 = toY(0);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  if (x0 >= PAD.left && x0 <= PAD.left + innerW) {
    ctx.beginPath(); ctx.moveTo(x0, PAD.top); ctx.lineTo(x0, PAD.top + innerH); ctx.stroke();
  }
  if (y0 >= PAD.top && y0 <= PAD.top + innerH) {
    ctx.beginPath(); ctx.moveTo(PAD.left, y0); ctx.lineTo(PAD.left + innerW, y0); ctx.stroke();
  }
  ctx.setLineDash([]);

  // Axis tick labels
  ctx.fillStyle = '#8896aa';
  ctx.font = `10px 'Space Mono',monospace`;
  ctx.textAlign = 'center';
  niceAxisTicks(xMin, xMax, 6).forEach(v => {
    ctx.fillText(fmtPct(v), toX(v), PAD.top + innerH + 16);
  });
  ctx.textAlign = 'right';
  niceAxisTicks(yMin, yMax, 6).forEach(v => {
    ctx.fillText(fmtPct(v), PAD.left - 6, toY(v) + 3);
  });

  // Axis titles
  ctx.fillStyle = '#8896aa';
  ctx.font = `9px 'Inter',sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(metricLabel(bubbleAxisX), PAD.left + innerW / 2, PAD.top + innerH + 38);
  ctx.save();
  ctx.translate(14, PAD.top + innerH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(metricLabel(bubbleAxisY), 0, 0);
  ctx.restore();

  // Bubbles
  rows.forEach(row => {
    const { x, y } = getBubbleXY(row);
    if (x == null || y == null) return;
    const px  = toX(x);
    const py  = toY(y);
    const col = sectorColorMap[row.sector] || '#8896aa';
    if (px < PAD.left - BUBBLE_R || px > PAD.left + innerW + BUBBLE_R) return;
    if (py < PAD.top  - BUBBLE_R || py > PAD.top  + innerH + BUBBLE_R) return;
    ctx.beginPath();
    ctx.arc(px, py, BUBBLE_R, 0, Math.PI * 2);
    ctx.fillStyle   = col + 'cc';
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth   = 1.2;
    ctx.stroke();
  });

  // Store geometry — attach xy to each row for hit-testing
  rows.forEach(row => {
    const { x, y } = getBubbleXY(row);
    row._bx = x; row._by = y;
  });
  canvas._rows   = rows;
  canvas._toX    = toX;
  canvas._toY    = toY;
  canvas._xMin   = xMin; canvas._xMax = xMax;
  canvas._yMin   = yMin; canvas._yMax = yMax;
  canvas._innerW = innerW; canvas._innerH = innerH;
}

function niceAxisTicks(lo, hi, target) {
  const range = hi - lo || 1;
  const rough = range / target;
  const mag   = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm  = rough / mag;
  const nice  = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  const step  = nice * mag;
  const start = Math.ceil(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi + step * 0.001; v = Math.round((v + step) * 1e8) / 1e8) {
    if (v >= lo && v <= hi) ticks.push(v);
  }
  return ticks;
}

function fmtPct(v) {
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
}

// ── Axis selectors ─────────────────────────────────────────────
function initAxisSelectors() {
  const xSel = document.getElementById('x-axis-select');
  const ySel = document.getElementById('y-axis-select');
  if (!xSel || !ySel) return;

  // Populate both dropdowns from BUBBLE_METRICS
  BUBBLE_METRICS.forEach(m => {
    xSel.appendChild(Object.assign(document.createElement('option'), { value: m.key, textContent: m.label }));
    ySel.appendChild(Object.assign(document.createElement('option'), { value: m.key, textContent: m.label }));
  });

  // Set defaults
  xSel.value = bubbleAxisX;
  ySel.value = bubbleAxisY;

  const updateSmaDates = () => {
    const needs = bubbleAxisX === 'sma_change' || bubbleAxisY === 'sma_change';
    document.getElementById('sma-change-dates').style.display = needs ? 'flex' : 'none';
  };

  xSel.addEventListener('change', () => {
    bubbleAxisX = xSel.value;
    bubbleZoom  = null;
    document.getElementById('zoom-reset').classList.remove('visible');
    updateSmaDates();
    if (currentView === 'bubble') drawBubble();
  });

  ySel.addEventListener('change', () => {
    bubbleAxisY = ySel.value;
    bubbleZoom  = null;
    document.getElementById('zoom-reset').classList.remove('visible');
    updateSmaDates();
    if (currentView === 'bubble') drawBubble();
  });

  // SMA change date inputs
  const smaStart = document.getElementById('sma-start');
  const smaEnd   = document.getElementById('sma-end');
  if (smaStart && smaEnd) {
    // Default to 3 months ago → today
    smaStart.value = toISODate(monthsAgo(3));
    smaEnd.value   = toISODate(today());
    smaChangeDates.startISO = smaStart.value;
    smaChangeDates.endISO   = smaEnd.value;

    const onSmaChange = () => {
      if (!smaStart.value || !smaEnd.value) return;
      smaChangeDates.startISO = smaStart.value;
      smaChangeDates.endISO   = smaEnd.value;
      if (currentView === 'bubble') drawBubble();
    };
    smaStart.addEventListener('change', onSmaChange);
    smaEnd.addEventListener('change', onSmaChange);
  }
}

// ── Bubble hover tooltip ───────────────────────────────────────
function initBubbleHover() {
  canvas.addEventListener('mousemove', e => {
    if (currentView !== 'bubble') return;
    const rect = canvas.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;
    const rows = canvas._rows;
    if (!rows) return;

    let best = null, bestDist = BUBBLE_R * 2.5;
    rows.forEach(row => {
      if (row._bx == null || row._by == null) return;
      const d = Math.hypot(mx - canvas._toX(row._bx), my - canvas._toY(row._by));
      if (d < bestDist) { bestDist = d; best = row; }
    });

    if (best) {
      document.getElementById('tt-ticker').textContent = best.ticker;
      document.getElementById('tt-name').textContent   = best.name;

      document.getElementById('tt-xlabel').textContent = metricLabel(bubbleAxisX);
      document.getElementById('tt-ylabel').textContent = metricLabel(bubbleAxisY);

      const xv = best._bx, yv = best._by;
      const xEl = document.getElementById('tt-xval');
      xEl.textContent = xv != null ? (xv > 0 ? '+' : '') + xv.toFixed(2) + '%' : '—';
      xEl.className   = 'tt-val ' + (xv > 0.05 ? 'up' : xv < -0.05 ? 'down' : 'flat');

      const yEl = document.getElementById('tt-yval');
      yEl.textContent = yv != null ? (yv > 0 ? '+' : '') + yv.toFixed(2) + '%' : '—';
      yEl.className   = 'tt-val ' + (yv > 0.05 ? 'up' : yv < -0.05 ? 'down' : 'flat');

      document.getElementById('tt-sector').textContent = `${best.sector} · ${best.industry}`;

      const ttW = 230, ttH = 130;
      const left = e.clientX + 14 + ttW > window.innerWidth  ? e.clientX - ttW - 14 : e.clientX + 14;
      const top  = e.clientY + 14 + ttH > window.innerHeight ? e.clientY - ttH - 14 : e.clientY + 14;
      tooltip.style.cssText = `display:block;left:${left}px;top:${top}px`;
      canvas.style.cursor = 'pointer';
    } else {
      tooltip.style.display = 'none';
      canvas.style.cursor   = 'crosshair';
    }
  });

  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
}

// ── Bubble drag-to-zoom ────────────────────────────────────────
function initBubbleZoom() {
  let dragging = false;
  let startX, startY;

  const coords = e => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  canvas.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const { x, y } = coords(e);
    const H = parseInt(canvas.getAttribute('height')) || 580;
    if (x < PAD.left || x > canvas.offsetWidth - PAD.right) return;
    if (y < PAD.top  || y > H - PAD.bottom) return;
    dragging = true;
    startX   = x; startY = y;
    canvas.style.cursor = 'col-resize';
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const { x, y } = coords(e);
    drawBubble();
    const dpr = window.devicePixelRatio || 1;
    ctx.save(); ctx.scale(dpr, dpr);
    const rx = Math.min(startX, x), ry = Math.min(startY, y);
    const rw = Math.abs(x - startX),  rh = Math.abs(y - startY);
    ctx.fillStyle   = 'rgba(167,139,250,0.10)';
    ctx.strokeStyle = 'rgba(167,139,250,0.7)';
    ctx.lineWidth   = 1;
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.restore();
  });

  window.addEventListener('mouseup', e => {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = 'crosshair';
    const { x, y } = coords(e);
    const x1 = Math.min(startX, x), x2 = Math.max(startX, x);
    const y1 = Math.min(startY, y), y2 = Math.max(startY, y);
    if (x2 - x1 < 8 || y2 - y1 < 8) return;

    const { _xMin, _xMax, _yMin, _yMax, _innerW, _innerH } = canvas;
    const toDataX = px => _xMin + (px - PAD.left)  / _innerW * (_xMax - _xMin);
    const toDataY = py => _yMax - (py - PAD.top)   / _innerH * (_yMax - _yMin);

    bubbleZoom = {
      xMin: toDataX(x1), xMax: toDataX(x2),
      yMin: toDataY(y2), yMax: toDataY(y1),
    };
    drawBubble();
    document.getElementById('zoom-reset').classList.add('visible');
  });

  document.getElementById('zoom-reset').addEventListener('click', () => {
    bubbleZoom = null;
    drawBubble();
    document.getElementById('zoom-reset').classList.remove('visible');
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && bubbleZoom && currentView === 'bubble') {
      bubbleZoom = null;
      drawBubble();
      document.getElementById('zoom-reset').classList.remove('visible');
    }
  });
}

// ── Sector legend ──────────────────────────────────────────────
function buildBubbleLegend(sectors) {
  const legend = document.getElementById('bubble-legend');
  legend.innerHTML = '';
  sectors.forEach(sector => {
    const color = sectorColorMap[sector] || '#8896aa';
    const item  = document.createElement('div');
    item.className = 'bl-item';
    item.innerHTML = `<div class="bl-dot" style="background:${color}"></div>${esc(sector)}`;
    item.addEventListener('click', () => {
      if (hiddenSectors.has(sector)) hiddenSectors.delete(sector);
      else hiddenSectors.add(sector);
      item.classList.toggle('faded', hiddenSectors.has(sector));
      if (currentView === 'bubble') drawBubble();
    });
    legend.appendChild(item);
  });
}

// ── Bubble watchlist ───────────────────────────────────────────
// Adds all currently visible bubbles to the shared watchlist.
// "Visible" = sector not hidden AND (if zoomed) within zoom window.

const LS_KEY = 'marketgrid_watchlist_v1';

function getVisibleTickers() {
  const rows = canvas._rows;   // set by drawBubble() — already filtered by sector
  if (!rows) return [];

  // If zoomed, further filter to tickers inside the zoom window
  if (bubbleZoom) {
    const { xMin, xMax, yMin, yMax } = bubbleZoom;
    return rows
      .filter(r => r.r0 >= xMin && r.r0 <= xMax && r.r1 >= yMin && r.r1 <= yMax)
      .map(r => r.ticker);
  }
  return rows.map(r => r.ticker);
}

function initBubbleWatchlist() {
  const btn      = document.getElementById('bubble-watchlist');
  const feedback = document.getElementById('bubble-save-feedback');
  let   fadeTimer = null;

  btn.addEventListener('click', () => {
    const tickers = getVisibleTickers();

    // Load existing watchlist, add new tickers, save back
    let wl;
    try { wl = new Set(JSON.parse(localStorage.getItem(LS_KEY)) || []); }
    catch { wl = new Set(); }

    const before = wl.size;
    tickers.forEach(t => wl.add(t));
    const added = wl.size - before;

    localStorage.setItem(LS_KEY, JSON.stringify([...wl]));

    // Show feedback
    feedback.textContent = added > 0
      ? `✓ ${added} ticker${added === 1 ? '' : 's'} added`
      : tickers.length === 0
        ? '— nothing visible'
        : '— already in watchlist';

    feedback.classList.add('show');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => feedback.classList.remove('show'), 2200);
  });
}

// ── Resize ─────────────────────────────────────────────────────
function initResizeHandler() {
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (currentView === 'bubble') drawBubble(); }, 150);
  });
}

// ── Utilities ──────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Boot ───────────────────────────────────────────────────────
async function main() {
  try {
    const gridsIndex = await fetchJSON(DATA_PATH + 'grids.json').catch(() => ({ grids: [] }));
    buildNavTabs(gridsIndex.grids, GRID_NAME);
  } catch (_) {}

  initGridSelector();
  initViewToggle();
  initPeriodControls();
  initSortableHeaders();
  initAxisSelectors();
  initBubbleHover();
  initBubbleZoom();
  initBubbleWatchlist();
  initClearWatchlistButton();
  initResizeHandler();

  await loadGrid();
}

main();
