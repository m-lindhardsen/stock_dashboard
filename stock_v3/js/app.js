/* =============================================================
   app.js — Entry point for grid pages (grid.html?grid=<name>)
   Orchestrates: data fetching, grid build, controls wiring.
   ============================================================= */

import {
  fetchJSON, buildNavTabs, buildCard, buildSectorButtons,
  refreshWatchlistUI, applyFilter, initSortButtons,
  initColumnToggle, initIntervalToggle, initExportButton,
  initResizeHandler, CHART_H,
} from './grid.js';

import { openLightbox } from './lightbox.js';

// ── Resolve grid name from URL query string ────────────────────
// e.g. pages/grid.html?grid=sp500  →  GRID_NAME = 'sp500'
const params   = new URLSearchParams(location.search);
const GRID_NAME = params.get('grid') || 'sp500';
const DATA_PATH = '../data/';

// ── Boot ───────────────────────────────────────────────────────
async function main() {
  const status = document.getElementById('status');
  const grid   = document.getElementById('grid');

  document.title = `Market Grid — ${GRID_NAME.toUpperCase()}`;

  try {
    // Load grid index (for nav tabs)
    const gridsIndex = await fetchJSON(DATA_PATH + 'grids.json')
      .catch(() => ({ grids: [GRID_NAME] }));
    buildNavTabs(gridsIndex.grids, GRID_NAME);

    // Load manifest for this grid
    const manifest = await fetchJSON(DATA_PATH + `manifest_${GRID_NAME}.json`);
    const tickers  = manifest.tickers || [];
    const updated  = manifest.generated
      ? new Date(manifest.generated).toLocaleString() : '—';
    document.getElementById('meta-info').textContent =
      `${tickers.length} tickers · ${updated}`;

    status.innerHTML = `<span class="spinner"></span> Loading ${tickers.length} tickers…`;

    // Load all ticker data in parallel
    const datasets = await Promise.all(
      tickers.map(t =>
        fetchJSON(DATA_PATH + t + '_daily.json')
          .catch(e => { console.warn(`Skip ${t}:`, e); return null; })
      )
    );

    status.style.display = 'none';
    grid.style.display   = 'grid';

    // Build sector filter pills
    buildSectorButtons(datasets);

    // Build cards
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

// ── Wire up controls (run immediately — DOM already exists) ────
initColumnToggle();
initSortButtons();
initIntervalToggle(DATA_PATH);
initExportButton();
initResizeHandler();

main();
