/* =============================================================
   returns-app.js — Returns table + bubble chart
   Table:  Period 1 / 2 / 3, sortable columns
   Bubble: Period 1 = X, Period 2 = Y, sector-coloured bubbles,
           drag-to-zoom box, hover tooltip, legend filter
   ============================================================= */

import { fetchJSON, buildNavTabs } from './grid.js';

// ── Constants ──────────────────────────────────────────────────
const DATA_PATH = '../data/';
const GRID_NAME = 'returns';

// Canvas drawing padding (px)
const PAD = { top: 30, right: 30, bottom: 48, left: 60 };
const BUBBLE_R = 6;   // fixed bubble radius

// Sector colour palette — cycles if more sectors than colours
const SECTOR_COLORS = [
  '#4af0b0', '#60a5fa', '#f97316', '#facc15', '#f04f5e',
  '#a78bfa', '#34d399', '#fb7185', '#38bdf8', '#e879f9',
  '#4ade80', '#fbbf24',
];

// Preset period definitions
const PRESETS = {
  '1w': () => ({ start: daysAgo(7),    end: today() }),
  '1m': () => ({ start: monthsAgo(1),  end: today() }),
  '3m': () => ({ start: monthsAgo(3),  end: today() }),
  '6m': () => ({ start: monthsAgo(6),  end: today() }),
  '1y': () => ({ start: monthsAgo(12), end: today() }),
};

// ── State ──────────────────────────────────────────────────────
let currentGrid = 'sp500';
let currentView = 'table';   // 'table' | 'bubble'
let datasets    = [];

const periods = [
  { preset: '1w', startDate: null, endDate: null },
  { preset: '1m', startDate: null, endDate: null },
  { preset: '3m', startDate: null, endDate: null },
];

// Table sort
let sortCol = 'ticker';
let sortDir = 'asc';

// Bubble zoom: null = full view, otherwise { xMin, xMax, yMin, yMax }
let bubbleZoom = null;

// Sector legend filter: null = all visible, otherwise Set of hidden sectors
let hiddenSectors = new Set();

// Sector → colour map (built when data loads)
let sectorColorMap = {};

// ── Date helpers ───────────────────────────────────────────────
function today() {
  const d = new Date(); d.setHours(0,0,0,0); return d;
}
function daysAgo(n)   { const d = today(); d.setDate(d.getDate() - n); return d; }
function monthsAgo(n) { const d = today(); d.setMonth(d.getMonth() - n); return d; }
function toISODate(d) { return d.toISOString().slice(0, 10); }
function fmtShort(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleString('en', { day: 'numeric', month: 'short' });
}

// Binary search: last index where ohlcv[i].t <= targetISO
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

// ── Computed rows (shared between table and bubble) ─────────────
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
  }));
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
      const dateRow = document.getElementById(`p${pIdx}-dates`);
      dateRow.style.display = preset === 'custom' ? 'flex' : 'none';
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

    // Toggle body class for CSS (hides Period 3 block in bubble mode)
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

// ── Refresh (called after any period change) ───────────────────
function refresh() {
  updateResolvedLabels();
  if (currentView === 'table')  rebuildTable();
  else                          drawBubble();
}

function updateResolvedLabels() {
  [0, 1, 2].forEach(i => {
    const r   = resolvePeriod(i);
    const el  = document.getElementById(`p${i}-resolved`);
    if (el && r) el.textContent = `${r.startISO} → ${r.endISO}`;
  });
}

// ── Data loading ───────────────────────────────────────────────
async function loadGrid() {
  const status    = document.getElementById('table-status');
  const tableWrap = document.getElementById('table-wrap');
  const bubbleV   = document.getElementById('bubble-view');

  status.style.display    = 'block';
  status.innerHTML        = `<span class="spinner"></span> Loading ${currentGrid}…`;
  tableWrap.style.display = 'none';
  bubbleV.style.display   = 'none';

  try {
    const manifest = await fetchJSON(DATA_PATH + `manifest_${currentGrid}.json`);
    const tickers  = manifest.tickers || [];
    const updated  = manifest.generated
      ? new Date(manifest.generated).toLocaleString() : '—';
    document.getElementById('meta-info').textContent =
      `${tickers.length} tickers · ${updated}`;

    datasets = (await Promise.all(
      tickers.map(t => fetchJSON(DATA_PATH + t + '_daily.json').catch(() => null))
    )).filter(Boolean);

    // Build sector colour map
    const sectors = [...new Set(datasets.map(d => d.info?.sector || '—'))].sort();
    sectorColorMap = {};
    sectors.forEach((s, i) => { sectorColorMap[s] = SECTOR_COLORS[i % SECTOR_COLORS.length]; });
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

  // Update column header date sub-labels
  resolved.forEach((r, i) => {
    const el = document.getElementById(`th-p${i}`);
    if (el) el.textContent = r ? `${fmtShort(r.startISO)} → ${fmtShort(r.endISO)}` : '';
  });

  let rows = buildRows();
  rows = sortRows(rows);

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

  // Gather visible points
  const rows = buildRows().filter(r =>
    r.r0 != null && r.r1 != null && !hiddenSectors.has(r.sector)
  );

  if (!rows.length) {
    ctx.fillStyle = '#8896aa';
    ctx.font = `14px 'Inter',sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('No data', W / 2, H / 2);
    return;
  }

  // Data range — use zoom if active, otherwise fit all points with padding
  let xMin, xMax, yMin, yMax;
  if (bubbleZoom) {
    ({ xMin, xMax, yMin, yMax } = bubbleZoom);
  } else {
    xMin = Math.min(...rows.map(r => r.r0));
    xMax = Math.max(...rows.map(r => r.r0));
    yMin = Math.min(...rows.map(r => r.r1));
    yMax = Math.max(...rows.map(r => r.r1));
    // Always include zero in both axes
    xMin = Math.min(xMin, 0); xMax = Math.max(xMax, 0);
    yMin = Math.min(yMin, 0); yMax = Math.max(yMax, 0);
    // Add 10% padding
    const xPad = (xMax - xMin || 2) * 0.10;
    const yPad = (yMax - yMin || 2) * 0.10;
    xMin -= xPad; xMax += xPad;
    yMin -= yPad; yMax += yPad;
  }

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top  - PAD.bottom;

  const toX = v => PAD.left + (v - xMin) / (xMax - xMin) * innerW;
  const toY = v => PAD.top  + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  // ── Background ──
  ctx.fillStyle = '#141820';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgb(36,44,53)';
  ctx.fillRect(PAD.left, PAD.top, innerW, innerH);

  // ── Grid lines ──
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;

  // X grid
  niceAxisTicks(xMin, xMax, 6).forEach(v => {
    const x = toX(v);
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + innerH); ctx.stroke();
  });
  // Y grid
  niceAxisTicks(yMin, yMax, 6).forEach(v => {
    const y = toY(v);
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + innerW, y); ctx.stroke();
  });

  // ── Zero lines (quadrant dividers) ──
  const x0 = toX(0);
  const y0 = toY(0);

  if (x0 >= PAD.left && x0 <= PAD.left + innerW) {
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x0, PAD.top); ctx.lineTo(x0, PAD.top + innerH); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (y0 >= PAD.top && y0 <= PAD.top + innerH) {
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(PAD.left, y0); ctx.lineTo(PAD.left + innerW, y0); ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── Axis tick labels ──
  ctx.fillStyle = '#8896aa';
  ctx.font = `10px 'Space Mono',monospace`;

  // X axis labels
  ctx.textAlign = 'center';
  niceAxisTicks(xMin, xMax, 6).forEach(v => {
    ctx.fillText(fmtPct(v), toX(v), PAD.top + innerH + 16);
  });

  // Y axis labels
  ctx.textAlign = 'right';
  niceAxisTicks(yMin, yMax, 6).forEach(v => {
    ctx.fillText(fmtPct(v), PAD.left - 6, toY(v) + 3);
  });

  // ── Axis titles ──
  const r0 = resolvePeriod(0), r1 = resolvePeriod(1);
  ctx.fillStyle = '#8896aa';
  ctx.font = `9px 'Inter',sans-serif`;
  ctx.textAlign = 'center';
  if (r0) ctx.fillText(
    `Period 1 return  (${fmtShort(r0.startISO)} → ${fmtShort(r0.endISO)})`,
    PAD.left + innerW / 2, PAD.top + innerH + 38
  );
  ctx.save();
  ctx.translate(14, PAD.top + innerH / 2);
  ctx.rotate(-Math.PI / 2);
  if (r1) ctx.fillText(
    `Period 2 return  (${fmtShort(r1.startISO)} → ${fmtShort(r1.endISO)})`,
    0, 0
  );
  ctx.restore();

  // ── Bubbles ──
  rows.forEach(row => {
    const x   = toX(row.r0);
    const y   = toY(row.r1);
    const col = sectorColorMap[row.sector] || '#8896aa';

    // Clip to plot area
    if (x < PAD.left - BUBBLE_R || x > PAD.left + innerW + BUBBLE_R) return;
    if (y < PAD.top  - BUBBLE_R || y > PAD.top  + innerH + BUBBLE_R) return;

    ctx.beginPath();
    ctx.arc(x, y, BUBBLE_R, 0, Math.PI * 2);
    ctx.fillStyle = col + 'cc';   // slight transparency
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  });

  // Store for hit-testing
  canvas._rows  = rows;
  canvas._toX   = toX;
  canvas._toY   = toY;
  canvas._xMin  = xMin; canvas._xMax = xMax;
  canvas._yMin  = yMin; canvas._yMax = yMax;
  canvas._innerW = innerW; canvas._innerH = innerH;
}

// ── Axis tick helper ───────────────────────────────────────────
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

// ── Bubble hover tooltip ───────────────────────────────────────
function initBubbleHover() {
  canvas.addEventListener('mousemove', e => {
    if (currentView !== 'bubble') return;
    const rect = canvas.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;
    const rows = canvas._rows;
    if (!rows) return;

    // Hit-test: find closest bubble within radius
    let best = null, bestDist = BUBBLE_R * 2.5;
    rows.forEach(row => {
      const x = canvas._toX(row.r0);
      const y = canvas._toY(row.r1);
      const d = Math.hypot(mx - x, my - y);
      if (d < bestDist) { bestDist = d; best = row; }
    });

    if (best) {
      const r0 = best.r0, r1 = best.r1;
      document.getElementById('tt-ticker').textContent = best.ticker;
      document.getElementById('tt-name').textContent   = best.name;

      const r0Res = resolvePeriod(0), r1Res = resolvePeriod(1);
      document.getElementById('tt-xlabel').textContent =
        r0Res ? `P1 (${fmtShort(r0Res.startISO)}→${fmtShort(r0Res.endISO)})` : 'Period 1';
      document.getElementById('tt-ylabel').textContent =
        r1Res ? `P2 (${fmtShort(r1Res.startISO)}→${fmtShort(r1Res.endISO)})` : 'Period 2';

      const xEl = document.getElementById('tt-xval');
      xEl.textContent = (r0 > 0 ? '+' : '') + r0.toFixed(2) + '%';
      xEl.className   = 'tt-val ' + (r0 > 0.05 ? 'up' : r0 < -0.05 ? 'down' : 'flat');

      const yEl = document.getElementById('tt-yval');
      yEl.textContent = (r1 > 0 ? '+' : '') + r1.toFixed(2) + '%';
      yEl.className   = 'tt-val ' + (r1 > 0.05 ? 'up' : r1 < -0.05 ? 'down' : 'flat');

      document.getElementById('tt-sector').textContent = `${best.sector} · ${best.industry}`;

      const tt = tooltip;
      tt.style.display = 'block';
      // Keep tooltip inside viewport
      const ttW = 230, ttH = 120;
      const left = e.clientX + 14 + ttW > window.innerWidth  ? e.clientX - ttW - 14 : e.clientX + 14;
      const top  = e.clientY + 14 + ttH > window.innerHeight ? e.clientY - ttH - 14 : e.clientY + 14;
      tt.style.left = left + 'px';
      tt.style.top  = top  + 'px';
      canvas.style.cursor = 'pointer';
    } else {
      tooltip.style.display = 'none';
      canvas.style.cursor = 'crosshair';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });
}

// ── Bubble drag-to-zoom ────────────────────────────────────────
function initBubbleZoom() {
  let dragging = false;
  let startX, startY, currX, currY;

  const canvasCoords = e => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  canvas.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const { x, y } = canvasCoords(e);
    // Only start drag inside plot area
    if (x < PAD.left || x > canvas.offsetWidth - PAD.right) return;
    if (y < PAD.top  || y > (parseInt(canvas.getAttribute('height')) || 580) - PAD.bottom) return;
    dragging = true;
    startX = currX = x;
    startY = currY = y;
    canvas.style.cursor = 'col-resize';
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const { x, y } = canvasCoords(e);
    currX = x; currY = y;

    // Redraw chart then overlay selection rectangle
    drawBubble();
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.scale(dpr, dpr);
    const rx = Math.min(startX, currX), ry = Math.min(startY, currY);
    const rw = Math.abs(currX - startX), rh = Math.abs(currY - startY);
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

    const { x, y } = canvasCoords(e);
    const x1 = Math.min(startX, x), x2 = Math.max(startX, x);
    const y1 = Math.min(startY, y), y2 = Math.max(startY, y);

    // Ignore tiny drags (likely clicks)
    if (x2 - x1 < 8 || y2 - y1 < 8) return;

    // Convert pixel box → data coordinates
    const { _xMin, _xMax, _yMin, _yMax, _innerW, _innerH } = canvas;
    const toDataX = px => _xMin + (px - PAD.left) / _innerW * (_xMax - _xMin);
    const toDataY = py => _yMax - (py - PAD.top)  / _innerH * (_yMax - _yMin);

    bubbleZoom = {
      xMin: toDataX(x1), xMax: toDataX(x2),
      yMin: toDataY(y2), yMax: toDataY(y1),   // y is flipped
    };

    drawBubble();
    document.getElementById('zoom-reset').classList.add('visible');
  });

  // Reset zoom button
  document.getElementById('zoom-reset').addEventListener('click', () => {
    bubbleZoom = null;
    drawBubble();
    document.getElementById('zoom-reset').classList.remove('visible');
  });

  // ESC also resets zoom
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

// ── Resize handler ────────────────────────────────────────────
function initResizeHandler() {
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (currentView === 'bubble') drawBubble();
    }, 150);
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
  initBubbleHover();
  initBubbleZoom();
  initResizeHandler();

  await loadGrid();
}

main();
