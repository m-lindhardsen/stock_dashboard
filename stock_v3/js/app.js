/* =============================================================
   app.js — Entry point for grid pages (grid.html?grid=<n>)
   Loads a single bundle file instead of one request per ticker.
   Bundle: data/{gridname}_{interval}_bundle.json
   ============================================================= */

import {
  fetchJSON, buildNavTabs, buildCard, buildSectorButtons,
  refreshWatchlistUI, applyFilter, initSortButtons,
  initColumnToggle, initExportButton, initResizeHandler, CHART_H,
} from './grid.js';

import { openLightbox } from './lightbox.js';
import { drawChart }    from './chart.js';

// ── Resolve grid name from URL query string ────────────────────
// e.g. pages/grid.html?grid=sp500  →  GRID_NAME = 'sp500'
const params    = new URLSearchParams(location.search);
const GRID_NAME = params.get('grid') || 'sp500';
const DATA_PATH = '../data/';

let currentInterval = 'daily';

// ── Interval toggle ────────────────────────────────────────────
// Reloads the bundle for the new interval and redraws all cards.
function initIntervalToggle() {
  document.querySelectorAll('.seg-btn[data-interval]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.interval === currentInterval) return;
      document.querySelectorAll('.seg-btn[data-interval]')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentInterval = btn.dataset.interval;

      try {
        const bundle = await fetchJSON(
          DATA_PATH + `${GRID_NAME}_${currentInterval}_bundle.json`
        );
        const map = new Map(bundle.tickers.map(d => [d.ticker, d]));
        document.querySelectorAll('.card[data-ticker]').forEach(card => {
          const d      = map.get(card.dataset.ticker);
          const canvas = card.querySelector('canvas');
          if (!d || !canvas) return;
          canvas._ohlcv = d.ohlcv;
          canvas._H     = CHART_H;
          drawChart(canvas, d.ohlcv, CHART_H);
        });
      } catch (e) {
        console.warn('Could not load interval bundle:', e);
      }
    });
  });
}

// ── Boot ───────────────────────────────────────────────────────
async function main() {
  const status = document.getElementById('status');
  const grid   = document.getElementById('grid');

  document.title = `Market Grid — ${GRID_NAME.toUpperCase()}`;

  try {
    // Nav tabs
    const gridsIndex = await fetchJSON(DATA_PATH + 'grids.json')
      .catch(() => ({ grids: [GRID_NAME] }));
    buildNavTabs(gridsIndex.grids, GRID_NAME);

    // Load the daily bundle — one request for all tickers
    status.innerHTML = `<span class="spinner"></span> Loading ${GRID_NAME.toUpperCase()}…`;

    const bundle  = await fetchJSON(DATA_PATH + `${GRID_NAME}_daily_bundle.json`);
    const datasets = bundle.tickers || [];
    const updated  = bundle.generated
      ? new Date(bundle.generated).toLocaleString() : '—';

    document.getElementById('meta-info').textContent =
      `${datasets.length} tickers · ${updated}`;

    status.style.display = 'none';
    grid.style.display   = 'grid';

    buildSectorButtons(datasets);

    const emptyEl = document.getElementById('empty-state');
    datasets.forEach((data, idx) => {
      if (data) grid.insertBefore(buildCard(data, idx, openLightbox), emptyEl);
    });

    refreshWatchlistUI();
    applyFilter();

  } catch (e) {
    status.innerHTML =
      `⚠ ${e.message}<br><small>Run <code>python download_data.py</code> first.</small>`;
  }
}

// ── Wire controls ──────────────────────────────────────────────
initColumnToggle();
initSortButtons();
initIntervalToggle();
initExportButton();
initResizeHandler();

main();
