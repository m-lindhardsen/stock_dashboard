/* =============================================================
   sectors-app.js — Entry point for sectors.html
   Loads a single bundle instead of one request per ticker.
   Bundle: data/sectors_{interval}_bundle.json
   ============================================================= */

import {
  fetchJSON, buildNavTabs, refreshWatchlistUI, toggleWatch,
  initColumnToggle, initResizeHandler, CHART_H, esc,
} from './grid.js';

import { drawChart, drawRatioChart, attachCrosshair } from './chart.js';
import { openLightboxWithMode }                        from './lightbox.js';

// ── Constants ──────────────────────────────────────────────────
const GRID_NAME  = 'sectors';
const DATA_PATH  = '../data/';
const SPY_TICKER = 'SPY';

// ── State ──────────────────────────────────────────────────────
let chartMode       = 'price';   // 'price' | 'ratio'
let currentInterval = 'daily';
let spyOhlcv        = null;
let allDatasets     = [];

// ── Ratio OHLCV builder ────────────────────────────────────────
function buildRatioOhlcv(etfOhlcv, refOhlcv) {
  const spyMap = new Map(refOhlcv.map(r => [r.t, r]));
  const rows   = [];
  for (const r of etfOhlcv) {
    const s = spyMap.get(r.t);
    if (!s || s.c === 0) continue;
    rows.push({ t: r.t, o: r.o/s.o, h: r.h/s.h, l: r.l/s.l, c: r.c/s.c, v: r.v });
  }
  const closes = rows.map(r => r.c);
  const smaFn  = (vals, n) => {
    const res = new Array(vals.length).fill(null);
    for (let i = n - 1; i < vals.length; i++)
      res[i] = vals.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n;
    return res;
  };
  const s10 = smaFn(closes, 10), s50 = smaFn(closes, 50), s250 = smaFn(closes, 250);
  rows.forEach((r, i) => { r.sma10 = s10[i]; r.sma50 = s50[i]; r.sma250 = s250[i]; });
  return rows;
}

function currentRatioValue(etfOhlcv) {
  if (!spyOhlcv?.length || !etfOhlcv.length) return null;
  const last    = etfOhlcv[etfOhlcv.length - 1];
  const spyLast = spyOhlcv[spyOhlcv.length - 1];
  if (!spyLast || spyLast.c === 0) return null;
  return (last.c / spyLast.c).toFixed(4);
}

// ── Mode-aware card redraw (used by crosshair callback) ────────
function redrawCardCanvas(canvas) {
  const card    = canvas.closest('[data-ticker]');
  const ticker  = card?.dataset.ticker;
  const dataset = allDatasets.find(d => d?.ticker === ticker);
  if (!dataset) return;
  const isSPY    = ticker === SPY_TICKER;
  const useRatio = chartMode === 'ratio' && !isSPY && spyOhlcv;
  if (useRatio) {
    drawRatioChart(canvas, buildRatioOhlcv(dataset.ohlcv, spyOhlcv), CHART_H);
  } else {
    drawChart(canvas, dataset.ohlcv, CHART_H);
  }
}

// ── Redraw all cards ───────────────────────────────────────────
function redrawAllCards() {
  document.querySelectorAll('.card[data-ticker]').forEach(card => {
    const ticker  = card.dataset.ticker;
    const canvas  = card.querySelector('canvas');
    const dataset = allDatasets.find(d => d?.ticker === ticker);
    if (!dataset || !canvas) return;

    const isSPY    = ticker === SPY_TICKER;
    const useRatio = chartMode === 'ratio' && !isSPY && spyOhlcv;

    const badge = card.querySelector('.ratio-badge');
    if (badge) badge.style.display = (chartMode === 'ratio' && !isSPY) ? 'inline' : 'none';

    if (useRatio) {
      drawRatioChart(canvas, buildRatioOhlcv(dataset.ohlcv, spyOhlcv), CHART_H);
    } else {
      drawChart(canvas, dataset.ohlcv, CHART_H);
    }
  });
}

// ── Build card ─────────────────────────────────────────────────
function buildCard(data, idx) {
  const { ticker, info, ohlcv } = data;
  const last  = ohlcv[ohlcv.length - 1];
  const prev  = ohlcv[ohlcv.length - 2] || last;
  const isUp  = last.c >= prev.c;
  const isSPY = ticker === SPY_TICKER;
  const ratio = isSPY ? null : currentRatioValue(ohlcv);

  const card = document.createElement('div');
  card.className      = 'card' + (isSPY ? ' spy-card' : '');
  card.dataset.ticker = ticker;
  card.dataset.index  = idx;

  card.addEventListener('click', () => {
    const isSPYCard = ticker === SPY_TICKER;
    const useRatio  = chartMode === 'ratio' && !isSPYCard && spyOhlcv;
    openLightboxWithMode(data, useRatio, (lbCanvas, H) => {
      if (useRatio) {
        drawRatioChart(lbCanvas, buildRatioOhlcv(ohlcv, spyOhlcv), H);
      } else {
        drawChart(lbCanvas, ohlcv, H);
      }
    });
  });

  const hdr  = document.createElement('div'); hdr.className = 'card-header';
  const row1 = document.createElement('div'); row1.className = 'card-row1';
  row1.innerHTML = `
    <span class="ticker-symbol">${ticker}</span>
    <span class="company-name">${esc(info.shortName)}</span>
    <span class="last-price ${isUp ? 'up' : 'down'}">${last.c.toFixed(2)}</span>
    ${!isSPY && ratio
      ? `<span class="ratio-badge" style="display:none">${ratio}×</span>` : ''}
    <button class="btn-watch" title="Add to watchlist" data-ticker="${ticker}">+</button>`;
  row1.querySelector('.btn-watch')
    .addEventListener('click', e => toggleWatch(ticker, e));

  const row2 = document.createElement('div'); row2.className = 'card-row2';
  if (isSPY) {
    row2.innerHTML = `<span class="tag" style="color:var(--accent);border-color:var(--accent)">BENCHMARK</span>`;
  }
  if (info.sector)   row2.innerHTML += `<span class="tag">${esc(info.sector)}</span>`;
  if (info.industry) row2.innerHTML += `<span class="tag">${esc(info.industry)}</span>`;

  hdr.appendChild(row1); hdr.appendChild(row2); card.appendChild(hdr);

  const wrap   = document.createElement('div'); wrap.className = 'chart-wrap';
  const canvas = document.createElement('canvas');
  canvas.height = CHART_H;
  canvas._ohlcv = ohlcv;
  canvas._H     = CHART_H;
  wrap.appendChild(canvas); card.appendChild(wrap);

  requestAnimationFrame(() => {
    drawChart(canvas, ohlcv, CHART_H);
    attachCrosshair(canvas, () => redrawCardCanvas);
  });

  return card;
}

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
          DATA_PATH + `sectors_${currentInterval}_bundle.json`
        );
        allDatasets = bundle.tickers || [];
        spyOhlcv    = allDatasets.find(d => d.ticker === SPY_TICKER)?.ohlcv || null;
        // Update each card's canvas data then redraw
        allDatasets.forEach(d => {
          const card   = document.querySelector(`.card[data-ticker="${d.ticker}"]`);
          const canvas = card?.querySelector('canvas');
          if (!canvas) return;
          canvas._ohlcv = d.ohlcv;
        });
        redrawAllCards();
      } catch (e) {
        console.warn('Could not load interval bundle:', e);
      }
    });
  });
}

// ── Chart mode toggle ──────────────────────────────────────────
function initModeToggle() {
  document.getElementById('mode-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    chartMode = btn.dataset.mode;
    document.querySelectorAll('#mode-toggle .seg-btn').forEach(b => {
      b.classList.toggle('active',       b.dataset.mode === chartMode && chartMode === 'price');
      b.classList.toggle('ratio-active', b.dataset.mode === chartMode && chartMode === 'ratio');
    });
    document.getElementById('legend-normal').style.display = chartMode === 'price' ? 'flex' : 'none';
    document.getElementById('legend-ratio').style.display  = chartMode === 'ratio' ? 'flex' : 'none';
    redrawAllCards();
  });
}

// ── Bootstrap ──────────────────────────────────────────────────
async function main() {
  const status = document.getElementById('status');
  const grid   = document.getElementById('grid');

  try {
    const gridsIndex = await fetchJSON(DATA_PATH + 'grids.json')
      .catch(() => ({ grids: ['sectors'] }));
    buildNavTabs(gridsIndex.grids, GRID_NAME);

    status.innerHTML = `<span class="spinner"></span> Loading sectors…`;

    // Single bundle request
    const bundle  = await fetchJSON(DATA_PATH + 'sectors_daily_bundle.json');
    const datasets = bundle.tickers || [];
    const updated  = bundle.generated
      ? new Date(bundle.generated).toLocaleString() : '—';

    document.getElementById('meta-info').textContent = `${datasets.length} ETFs · ${updated}`;

    allDatasets = datasets;
    spyOhlcv    = allDatasets.find(d => d.ticker === SPY_TICKER)?.ohlcv || null;

    status.style.display = 'none';
    grid.style.display   = 'grid';

    // SPY first, then alphabetical
    const sorted = [...allDatasets].sort((a, b) => {
      if (a.ticker === SPY_TICKER) return -1;
      if (b.ticker === SPY_TICKER) return  1;
      return a.ticker.localeCompare(b.ticker);
    });

    sorted.forEach((data, idx) => grid.appendChild(buildCard(data, idx)));
    refreshWatchlistUI();

  } catch (e) {
    status.innerHTML =
      `⚠ ${e.message}<br><small>Run <code>python download_data.py</code> first.</small>`;
  }
}

// ── Wire controls ──────────────────────────────────────────────
initColumnToggle();
initIntervalToggle();
initModeToggle();
initResizeHandler();

main();
