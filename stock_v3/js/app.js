/* =============================================================
   app.js — Entry point for grid pages (grid.html?grid=<n>)
   Loads a single bundle file instead of one request per ticker.
   Bundle: data/{gridname}_{interval}_bundle.json

   Optimised:
     - grids.json + bundle fetch in parallel
     - Cards built in idle-time chunks (no 500-card DOM thrash)
     - Charts drawn lazily via IntersectionObserver (only when visible)
     - DocumentFragment for batch DOM insert
   ============================================================= */

import {
  fetchJSON, buildNavTabs, buildCard, buildSectorButtons,
  refreshWatchlistUI, applyFilter, initSortButtons,
  initColumnToggle, initExportButton, initClearButton, initResizeHandler, CHART_H,
  initLazyChartObserver,
} from './grid.js';

import { openLightbox } from './lightbox.js';
import { drawChart }    from './chart.js';

// ── Resolve grid name from URL query string ────────────────────
const params    = new URLSearchParams(location.search);
const GRID_NAME = params.get('grid') || 'sp500';
const DATA_PATH = '../data/';

let currentInterval = 'daily';

// How many cards to build per idle/rAF chunk before yielding
const CARD_CHUNK = 60;

// ── Interval toggle ────────────────────────────────────────────
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
          canvas._dirty = true;          // mark for lazy redraw
          // Only draw if currently visible
          if (card.style.display !== 'none' && isElementInViewport(card)) {
            drawChart(canvas, d.ohlcv, CHART_H);
            canvas._dirty = false;
          }
        });
      } catch (e) {
        console.warn('Could not load interval bundle:', e);
      }
    });
  });
}

function isElementInViewport(el) {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight;
}

// ── Boot ───────────────────────────────────────────────────────
async function main() {
  const status = document.getElementById('status');
  const grid   = document.getElementById('grid');

  document.title = `Market Grid — ${GRID_NAME.toUpperCase()}`;

  try {
    status.innerHTML = `<span class="spinner"></span> Loading ${GRID_NAME.toUpperCase()}…`;

    // Fetch grids.json and the bundle in parallel
    const [gridsIndex, bundle] = await Promise.all([
      fetchJSON(DATA_PATH + 'grids.json').catch(() => ({ grids: [GRID_NAME] })),
      fetchJSON(DATA_PATH + `${GRID_NAME}_daily_bundle.json`),
    ]);

    buildNavTabs(gridsIndex.grids, GRID_NAME);

    const datasets = bundle.tickers || [];
    const updated  = bundle.generated
      ? new Date(bundle.generated).toLocaleString() : '—';

    document.getElementById('meta-info').textContent =
      `${datasets.length} tickers · ${updated}`;

    status.style.display = 'none';
    grid.style.display   = 'grid';

    buildSectorButtons(datasets);

    // Build cards in chunks to avoid blocking the main thread.
    // First chunk is synchronous so the user sees content immediately;
    // remaining chunks are yielded via requestAnimationFrame.
    const emptyEl = document.getElementById('empty-state');

    if (datasets.length <= CARD_CHUNK) {
      // Small grid — build all at once
      const frag = document.createDocumentFragment();
      datasets.forEach((data, idx) => {
        if (data) frag.appendChild(buildCard(data, idx, openLightbox));
      });
      grid.insertBefore(frag, emptyEl);
    } else {
      // Large grid — chunked insertion
      await buildCardsChunked(datasets, grid, emptyEl);
    }

    // Start the IntersectionObserver that lazily draws charts
    initLazyChartObserver();

    refreshWatchlistUI();
    applyFilter();

  } catch (e) {
    status.innerHTML =
      `⚠ ${e.message}<br><small>Run <code>python download_data.py</code> first.</small>`;
  }
}

/**
 * Insert cards in chunks of CARD_CHUNK, yielding to the browser
 * between chunks so the page stays responsive.
 */
function buildCardsChunked(datasets, grid, emptyEl) {
  return new Promise(resolve => {
    let i = 0;
    function nextChunk() {
      const frag = document.createDocumentFragment();
      const end  = Math.min(i + CARD_CHUNK, datasets.length);
      for (; i < end; i++) {
        if (datasets[i]) frag.appendChild(buildCard(datasets[i], i, openLightbox));
      }
      grid.insertBefore(frag, emptyEl);
      if (i < datasets.length) {
        requestAnimationFrame(nextChunk);
      } else {
        resolve();
      }
    }
    nextChunk();
  });
}

// ── Wire controls ──────────────────────────────────────────────
initColumnToggle();
initSortButtons();
initIntervalToggle();
initExportButton();
initClearButton();
initResizeHandler();

main();
