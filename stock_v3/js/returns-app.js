/* =============================================================
   returns-app.js — Entry point for returns.html
   Features:
     - Grid selector (sp500 / candidates / portfolio)
     - Three independent period controls with presets + custom dates
     - Returns calculated from daily OHLC data
     - Weekend/holiday fallback: uses closest previous trading day
     - Sortable columns (click header to sort asc/desc)
   ============================================================= */

import { fetchJSON, buildNavTabs } from './grid.js';

// ── Constants ──────────────────────────────────────────────────
const DATA_PATH  = '../data/';
const GRID_NAME  = 'returns';

// Preset definitions: each returns { start, end } as Date objects
const PRESETS = {
  '1w': () => ({ start: daysAgo(7),   end: today() }),
  '1m': () => ({ start: monthsAgo(1), end: today() }),
  '3m': () => ({ start: monthsAgo(3), end: today() }),
  '6m': () => ({ start: monthsAgo(6), end: today() }),
  '1y': () => ({ start: monthsAgo(12),end: today() }),
};

// ── State ──────────────────────────────────────────────────────
let currentGrid = 'sp500';
let datasets    = [];   // loaded ticker data

// Period state: preset key or 'custom', plus explicit dates for custom
const periods = [
  { preset: '1w',  startDate: null, endDate: null },
  { preset: '1m',  startDate: null, endDate: null },
  { preset: '3m',  startDate: null, endDate: null },
];

// Sort state
let sortCol = 'ticker';
let sortDir = 'asc';

// ── Date helpers ───────────────────────────────────────────────

function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysAgo(n) {
  const d = today();
  d.setDate(d.getDate() - n);
  return d;
}

function monthsAgo(n) {
  const d = today();
  d.setMonth(d.getMonth() - n);
  return d;
}

// Format date as YYYY-MM-DD string
function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

// Format date as short display string e.g. "12 Jan"
function fmtShort(isoStr) {
  const d = new Date(isoStr + 'T00:00:00');
  return d.toLocaleString('en', { day: 'numeric', month: 'short' });
}

// Given a sorted array of OHLC rows and a target ISO date string,
// return the index of the closest row on or before the target date.
// Falls back to the earliest available date if target is before all data.
function closestIdx(ohlcv, targetISO) {
  // Binary search for the last row where row.t <= targetISO
  let lo = 0, hi = ohlcv.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ohlcv[mid].t <= targetISO) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

// Compute return % between two dates for a given ohlcv array
function calcReturn(ohlcv, startISO, endISO) {
  if (!ohlcv || ohlcv.length < 2) return null;
  const iStart = closestIdx(ohlcv, startISO);
  const iEnd   = closestIdx(ohlcv, endISO);
  if (iStart === iEnd) return null;
  const priceStart = ohlcv[iStart].c;
  const priceEnd   = ohlcv[iEnd].c;
  if (!priceStart) return null;
  return (priceEnd - priceStart) / priceStart * 100;
}

// ── Period resolution ──────────────────────────────────────────
// Returns { startISO, endISO } for a given period index

function resolvePeriod(idx) {
  const p = periods[idx];
  if (p.preset === 'custom') {
    return { startISO: p.startDate, endISO: p.endDate };
  }
  const fn = PRESETS[p.preset];
  if (!fn) return null;
  const { start, end } = fn();
  return { startISO: toISODate(start), endISO: toISODate(end) };
}

// ── UI: period controls ────────────────────────────────────────

function initPeriodControls() {
  // Preset button clicks
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pIdx   = parseInt(btn.dataset.period);
      const preset = btn.dataset.preset;

      // Update active state within this period
      document.querySelectorAll(`.preset-btn[data-period="${pIdx}"]`)
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      periods[pIdx].preset = preset;

      // Show/hide custom date inputs
      const dateRow = document.getElementById(`p${pIdx}-dates`);
      dateRow.style.display = preset === 'custom' ? 'flex' : 'none';

      if (preset !== 'custom') rebuildTable();
    });
  });

  // Custom date input changes
  [0, 1, 2].forEach(pIdx => {
    const startEl = document.getElementById(`p${pIdx}-start`);
    const endEl   = document.getElementById(`p${pIdx}-end`);
    if (!startEl || !endEl) return;

    // Set default values for custom inputs (same as current preset)
    const resolved = resolvePeriod(pIdx);
    if (resolved) {
      startEl.value = resolved.startISO;
      endEl.value   = resolved.endISO;
    }

    const onChange = () => {
      if (!startEl.value || !endEl.value) return;
      periods[pIdx].startDate = startEl.value;
      periods[pIdx].endDate   = endEl.value;
      rebuildTable();
    };
    startEl.addEventListener('change', onChange);
    endEl.addEventListener('change', onChange);
  });
}

// ── UI: grid selector ──────────────────────────────────────────

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

// ── Data loading ───────────────────────────────────────────────

async function loadGrid() {
  const status   = document.getElementById('table-status');
  const tableWrap = document.getElementById('table-wrap');

  status.style.display    = 'block';
  status.innerHTML        = `<span class="spinner"></span> Loading ${currentGrid}…`;
  tableWrap.style.display = 'none';

  try {
    const manifest = await fetchJSON(DATA_PATH + `manifest_${currentGrid}.json`);
    const tickers  = manifest.tickers || [];
    const updated  = manifest.generated
      ? new Date(manifest.generated).toLocaleString() : '—';
    document.getElementById('meta-info').textContent =
      `${tickers.length} tickers · ${updated}`;

    datasets = await Promise.all(
      tickers.map(t =>
        fetchJSON(DATA_PATH + t + '_daily.json')
          .catch(() => null)
      )
    );
    datasets = datasets.filter(Boolean);

    status.style.display    = 'none';
    tableWrap.style.display = 'block';
    rebuildTable();

  } catch (e) {
    status.innerHTML =
      `⚠ ${e.message}<br><small>Run <code>python download_data.py</code> first.</small>`;
  }
}

// ── Table build ────────────────────────────────────────────────

function rebuildTable() {
  // Resolve all three periods
  const resolved = [0, 1, 2].map(resolvePeriod);

  // Update column header date ranges
  resolved.forEach((r, i) => {
    const el = document.getElementById(`th-p${i}`);
    if (!el) return;
    el.textContent = r
      ? `${fmtShort(r.startISO)} → ${fmtShort(r.endISO)}`
      : '';
  });

  // Update resolved date labels under period headings
  resolved.forEach((r, i) => {
    const el = document.getElementById(`p${i}-resolved`);
    if (!el || !r) return;
    el.textContent = `${r.startISO} → ${r.endISO}`;
  });

  // Build row data
  let rows = datasets.map(d => {
    const returns = resolved.map(r =>
      r ? calcReturn(d.ohlcv, r.startISO, r.endISO) : null
    );
    return {
      ticker:   d.ticker,
      name:     d.info?.shortName || '—',
      sector:   d.info?.sector    || '—',
      industry: d.info?.industry  || '—',
      r0: returns[0],
      r1: returns[1],
      r2: returns[2],
    };
  });

  // Sort
  rows = sortRows(rows);

  // Render
  const tbody = document.getElementById('returns-tbody');
  tbody.innerHTML = '';
  rows.forEach(row => tbody.appendChild(buildRow(row)));

  // Update sort indicators on headers
  document.querySelectorAll('#returns-table thead th').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === sortCol) {
      th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

// ── Row builder ────────────────────────────────────────────────

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
  if (val === null || val === undefined || isNaN(val)) {
    return `<span class="rt-return flat">—</span>`;
  }
  const cls  = val > 0.05 ? 'up' : val < -0.05 ? 'down' : 'flat';
  const sign = val > 0 ? '+' : '';
  return `<span class="rt-return ${cls}">${sign}${val.toFixed(2)}%</span>`;
}

// ── Sorting ────────────────────────────────────────────────────

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    let vA = a[sortCol], vB = b[sortCol];

    // Nulls always last regardless of sort direction
    if (vA === null && vB === null) return 0;
    if (vA === null) return 1;
    if (vB === null) return -1;

    // Numeric vs string comparison
    const cmp = typeof vA === 'number'
      ? vA - vB
      : String(vA).localeCompare(String(vB));

    return sortDir === 'asc' ? cmp : -cmp;
  });
}

function initSortableHeaders() {
  document.querySelectorAll('#returns-table thead th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortCol = col;
        // Return columns default to descending (best performers first)
        sortDir = col.startsWith('r') ? 'desc' : 'asc';
      }
      rebuildTable();
    });
  });
}

// ── Utilities ──────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Boot ───────────────────────────────────────────────────────

async function main() {
  try {
    const gridsIndex = await fetchJSON(DATA_PATH + 'grids.json')
      .catch(() => ({ grids: [] }));
    buildNavTabs(gridsIndex.grids, GRID_NAME);
  } catch (_) { /* nav is non-critical */ }

  initGridSelector();
  initPeriodControls();
  initSortableHeaders();
  await loadGrid();
}

main();
