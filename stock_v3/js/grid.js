/* =============================================================
   grid.js — Card construction, sector filter, sort, watchlist.
   Imports chart.js for rendering.

   Optimised:
     - IntersectionObserver draws charts only when scrolled into view
     - buildCard no longer calls drawChart — just marks canvas._dirty
     - Crosshair attached lazily on first observation
     - Sort/column-toggle only redraws visible cards
     - Cache-busting moved to a 60s window instead of per-request
     - Resize handler only redraws visible canvases
   ============================================================= */

import { drawChart, attachCrosshair, CHART_CONFIG } from './chart.js';

// ── Constants ──────────────────────────────────────────────────
export const CHART_H = 280;
const LS_KEY = 'marketgrid_watchlist_v1';

// ── Lazy chart observer ────────────────────────────────────────
// A single IntersectionObserver watches all card canvases.
// When a canvas scrolls into view for the first time, it draws
// the chart and attaches the crosshair. Subsequent intersections
// only redraw if the canvas is marked _dirty (interval switch,
// resize, sort).

let chartObserver = null;

export function initLazyChartObserver() {
  if (chartObserver) return;           // already initialised

  chartObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const canvas = entry.target;
      if (!canvas._ohlcv) continue;

      if (canvas._dirty !== false) {   // first paint or marked dirty
        drawChart(canvas, canvas._ohlcv, canvas._H);
        canvas._dirty = false;
      }
      if (!canvas._hasCrosshair) {
        attachCrosshair(canvas, () => c => drawChart(c, c._ohlcv, CHART_H));
        canvas._hasCrosshair = true;
      }
    }
  }, {
    rootMargin: '200px 0px',           // start drawing 200px before visible
  });

  // Observe every canvas already in the DOM
  document.querySelectorAll('.card canvas').forEach(c => chartObserver.observe(c));
}

/** Observe a single canvas (called by buildCard). */
function observeCanvas(canvas) {
  if (chartObserver) chartObserver.observe(canvas);
  // If observer not yet created (cards built before init), it will
  // pick them up in initLazyChartObserver's querySelectorAll sweep.
}

/** Mark all visible canvases dirty and let the observer redraw them. */
function markAllDirty() {
  document.querySelectorAll('.card canvas').forEach(c => {
    if (c._ohlcv) c._dirty = true;
  });
}

// ── Watchlist ──────────────────────────────────────────────────

function loadWatchlist() {
  try { return new Set(JSON.parse(localStorage.getItem(LS_KEY)) || []); }
  catch { return new Set(); }
}
function saveWatchlist(s) {
  localStorage.setItem(LS_KEY, JSON.stringify([...s]));
}

let watchlist = loadWatchlist();

export function toggleWatch(ticker, e) {
  if (e) e.stopPropagation();
  watchlist.has(ticker) ? watchlist.delete(ticker) : watchlist.add(ticker);
  saveWatchlist(watchlist);
  refreshWatchlistUI();
  applyFilter();
}

export function refreshWatchlistUI() {
  const n = watchlist.size;
  const countEl = document.getElementById('watchlist-count');
  if (countEl) countEl.textContent = n > 0 ? `★ ${n}` : '';

  document.querySelectorAll('.card[data-ticker]').forEach(card => {
    const t   = card.dataset.ticker;
    const w   = watchlist.has(t);
    const btn = card.querySelector('.btn-watch');
    if (!btn) return;
    btn.textContent = w ? '★' : '+';
    btn.title       = w ? 'Remove from watchlist' : 'Add to watchlist';
    btn.classList.toggle('watched', w);
    card.classList.toggle('in-watchlist', w);
  });
}

// ── Sector filter ──────────────────────────────────────────────

let activeSectors = new Set(['__all__']);

export function buildSectorButtons(datasets) {
  const sectors = [...new Set(
    datasets.filter(Boolean).map(d => d.info?.sector || '—')
  )].sort();

  const bar = document.getElementById('filter-bar');
  if (!bar) return;
  const end = document.getElementById('fdiv-end');

  // Build all buttons in a fragment, single DOM insert
  const frag = document.createDocumentFragment();
  sectors.forEach(s => {
    const btn = document.createElement('button');
    btn.className      = 'filter-btn';
    btn.dataset.sector = s;
    btn.textContent    = s;
    frag.appendChild(btn);
  });
  bar.insertBefore(frag, end);
  bar.style.display = 'flex';

  bar.addEventListener('click', e => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    const s = btn.dataset.sector;

    if (s === '__all__') {
      activeSectors = new Set(['__all__']);
    } else if (s === '__watchlist__') {
      activeSectors = activeSectors.has('__watchlist__')
        ? new Set(['__all__']) : new Set(['__watchlist__']);
    } else {
      activeSectors.delete('__all__'); activeSectors.delete('__watchlist__');
      activeSectors.has(s) ? activeSectors.delete(s) : activeSectors.add(s);
      if (!activeSectors.size) activeSectors = new Set(['__all__']);
    }

    bar.querySelectorAll('.filter-btn').forEach(b =>
      b.classList.toggle('active', activeSectors.has(b.dataset.sector))
    );
    applyFilter();
  });
}

export function applyFilter() {
  const cards = [...document.querySelectorAll('.card[data-ticker]')];
  let visible = 0;
  cards.forEach(card => {
    const show = activeSectors.has('__all__')
      ? true
      : activeSectors.has('__watchlist__')
        ? watchlist.has(card.dataset.ticker)
        : activeSectors.has(card.dataset.sector);
    card.style.display = show ? '' : 'none';
    if (show) visible++;
  });

  const countEl = document.getElementById('filter-count');
  if (countEl) {
    countEl.textContent = activeSectors.has('__all__')
      ? `${cards.length} stocks`
      : `${visible} of ${cards.length} stocks`;
  }

  const emptyEl = document.getElementById('empty-state');
  if (emptyEl) emptyEl.style.display = visible === 0 ? 'block' : 'none';

  // Newly-visible cards may need their chart drawn
  markAllDirty();
  triggerObserverRefresh();
}

/** Force the observer to re-check all canvases (e.g. after filter/sort). */
function triggerObserverRefresh() {
  if (!chartObserver) return;
  document.querySelectorAll('.card canvas').forEach(c => {
    chartObserver.unobserve(c);
    chartObserver.observe(c);
  });
}

// ── Sort ───────────────────────────────────────────────────────

let currentSort = 'default';

export function initSortButtons() {
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSort = btn.dataset.sort;
      sortCards();
    });
  });
}

function sortCards() {
  const grid    = document.getElementById('grid');
  const emptyEl = document.getElementById('empty-state');
  const cards   = [...grid.querySelectorAll('.card[data-ticker]')];

  if (currentSort === 'sector') {
    cards.sort((a, b) => {
      const sA = (a.dataset.sector   || '').toLowerCase();
      const sB = (b.dataset.sector   || '').toLowerCase();
      const iA = (a.dataset.industry || '').toLowerCase();
      const iB = (b.dataset.industry || '').toLowerCase();
      if (sA !== sB) return sA < sB ? -1 : 1;
      return iA < iB ? -1 : iA > iB ? 1 : 0;
    });
  } else {
    cards.sort((a, b) => parseInt(a.dataset.index) - parseInt(b.dataset.index));
  }

  // Batch-move with fragment to minimise reflows
  const frag = document.createDocumentFragment();
  cards.forEach(card => frag.appendChild(card));
  grid.insertBefore(frag, emptyEl);

  // Mark dirty — observer will redraw only what's visible
  markAllDirty();
  triggerObserverRefresh();
}

// ── Column toggle ──────────────────────────────────────────────

export function initColumnToggle() {
  document.querySelectorAll('.col-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.col-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const grid = document.getElementById('grid');
      btn.dataset.cols === '2'
        ? grid.classList.add('cols-2')
        : grid.classList.remove('cols-2');

      // Only redraw after layout settles; observer handles visibility
      markAllDirty();
      requestAnimationFrame(() => triggerObserverRefresh());
    });
  });
}

// ── Interval toggle ────────────────────────────────────────────

let currentInterval = 'daily';

export function initIntervalToggle(dataPath) {
  document.querySelectorAll('.seg-btn[data-interval]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.interval === currentInterval) return;
      document.querySelectorAll('.seg-btn[data-interval]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentInterval = btn.dataset.interval;
      await reloadAllCards(dataPath);
    });
  });
}

async function reloadAllCards(dataPath) {
  const cards = [...document.querySelectorAll('.card[data-ticker]')];
  await Promise.all(cards.map(async card => {
    const ticker = card.dataset.ticker;
    const canvas = card.querySelector('canvas');
    if (!canvas) return;
    try {
      const data    = await fetchJSON(dataPath + ticker + `_${currentInterval}.json`);
      canvas._ohlcv = data.ohlcv;
      canvas._H     = CHART_H;
      canvas._dirty = true;
    } catch (err) {
      console.warn(`Could not load ${currentInterval} data for ${ticker}:`, err);
    }
  }));
  triggerObserverRefresh();
}

// ── Build card ─────────────────────────────────────────────────
/**
 * buildCard(data, idx, onCardClick)
 *   data        – { ticker, info, ohlcv }
 *   idx         – Original load index (used for default sort)
 *   onCardClick – Callback (data) => void
 *
 * NOTE: The chart is NOT drawn here.  The canvas is marked _dirty
 *       and the IntersectionObserver draws it when it scrolls into view.
 *       This is the single biggest perf win — for 500 cards, only
 *       ~8–12 charts are drawn on initial load instead of 500.
 */
export function buildCard(data, idx, onCardClick) {
  const { ticker, info, ohlcv } = data;
  const last  = ohlcv[ohlcv.length - 1];
  const prev  = ohlcv[ohlcv.length - 2] || last;
  const isUp  = last.c >= prev.c;
  const sector = info.sector || '—';
  const w     = watchlist.has(ticker);

  const card = document.createElement('div');
  card.className        = 'card' + (w ? ' in-watchlist' : '');
  card.dataset.ticker   = ticker;
  card.dataset.sector   = sector;
  card.dataset.industry = info.industry || '—';
  card.dataset.index    = idx;
  card.addEventListener('click', () => onCardClick(data));

  // Header row 1
  const hdr  = document.createElement('div'); hdr.className = 'card-header';
  const row1 = document.createElement('div'); row1.className = 'card-row1';
  row1.innerHTML = `
    <span class="ticker-symbol">${ticker}</span>
    <span class="company-name">${esc(info.shortName)}</span>
    <span class="last-price ${isUp ? 'up' : 'down'}">${last.c.toFixed(2)}</span>
    <button class="btn-watch ${w ? 'watched' : ''}"
            title="${w ? 'Remove from watchlist' : 'Add to watchlist'}"
            data-ticker="${ticker}">${w ? '★' : '+'}</button>`;
  row1.querySelector('.btn-watch')
    .addEventListener('click', e => toggleWatch(ticker, e));

  // Header row 2
  const row2 = document.createElement('div'); row2.className = 'card-row2';
  if (info.sector)   row2.innerHTML += `<span class="tag">${esc(info.sector)}</span>`;
  if (info.industry) row2.innerHTML += `<span class="tag">${esc(info.industry)}</span>`;

  hdr.appendChild(row1); hdr.appendChild(row2); card.appendChild(hdr);

  // Canvas — chart will be drawn lazily by the observer
  const wrap   = document.createElement('div'); wrap.className = 'chart-wrap';
  const canvas = document.createElement('canvas');
  canvas.height = CHART_H;
  canvas._ohlcv = ohlcv;
  canvas._H     = CHART_H;
  canvas._dirty = true;                // observer will draw when visible
  wrap.appendChild(canvas); card.appendChild(wrap);

  // Register with observer (no-op if observer not yet created)
  observeCanvas(canvas);

  return card;
}

// ── Export watchlist ───────────────────────────────────────────

export function initExportButton() {
  const btn = document.getElementById('btn-export');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!watchlist.size) { alert('Watchlist is empty.'); return; }
    const blob = new Blob([[...watchlist].sort().join('\n') + '\n'], { type: 'text/plain' });
    const a    = Object.assign(document.createElement('a'), {
      href:     URL.createObjectURL(blob),
      download: 'watchlist.txt',
    });
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

// ── Nav tabs ───────────────────────────────────────────────────

export function buildNavTabs(grids, activeName) {
  const nav = document.getElementById('nav-tabs');
  if (!nav) return;

  const frag = document.createDocumentFragment();
  grids.forEach(name => {
    const a = document.createElement('a');
    a.className   = 'nav-tab' + (name === activeName ? ' active' : '');
    a.href        = name === 'sectors'
      ? 'sectors.html'
      : `grid.html?grid=${name}`;
    a.textContent = name.toUpperCase();
    frag.appendChild(a);
  });

  const ret = document.createElement('a');
  ret.className   = 'nav-tab' + (activeName === 'returns' ? ' active' : '');
  ret.href        = 'returns.html';
  ret.textContent = 'RETURNS';
  frag.appendChild(ret);
  nav.appendChild(frag);
}

// ── Resize handler ─────────────────────────────────────────────

export function initResizeHandler() {
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Only mark dirty — observer redraws what's in viewport
      markAllDirty();
      triggerObserverRefresh();
    }, 150);
  });
}

// ── Utilities ──────────────────────────────────────────────────

export function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Cache-bust on a 60-second window instead of every single request.
// This avoids CDN/browser cache misses on rapid reloads while still
// picking up new data within a minute.
let _bustToken = null;
function cacheBust() {
  if (!_bustToken) _bustToken = Math.floor(Date.now() / 60000);
  return _bustToken;
}

export async function fetchJSON(url) {
  const r = await fetch(url + '?_=' + cacheBust());
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${url}`);
  return r.json();
}
