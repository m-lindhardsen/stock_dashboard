/* =============================================================
   lightbox.js — Lightbox overlay: open, close, ESC handling,
   window resize redraw, and zoom integration.
   Imports chart.js for rendering.
   ============================================================= */

import { drawChart, attachLightboxZoom } from './chart.js';

// ── DOM refs ───────────────────────────────────────────────────
const lb       = document.getElementById('lightbox');
const lbCanvas = document.getElementById('lb-canvas');

// ── State ──────────────────────────────────────────────────────
let lbData = null;   // current { ticker, info, ohlcv }
let lbZoom = null;   // current [startIdx, endIdx] | null

// ── Wire up zoom on the lightbox canvas ───────────────────────
// onZoomChange is called by attachLightboxZoom whenever zoom changes.
attachLightboxZoom(lbCanvas, zoomRange => {
  lbZoom               = zoomRange;
  lbCanvas._zoomRange  = zoomRange;
  if (lbData) {
    const H = _lbHeight();
    drawChart(lbCanvas, lbData.ohlcv, H, lbZoom);
  }
});

// ── Open ───────────────────────────────────────────────────────
/**
 * openLightbox(data)
 *   data – { ticker, info, ohlcv }
 *   Opens the lightbox and renders the full-size chart.
 */
export function openLightbox(data) {
  lbData = data;
  lbZoom = null;
  lbCanvas._zoomRange = null;
  if (lbCanvas._resetZoom) lbCanvas._resetZoom();

  const { ticker, info, ohlcv } = data;
  const last = ohlcv[ohlcv.length - 1];
  const prev = ohlcv[ohlcv.length - 2] || last;
  const isUp = last.c >= prev.c;

  // Populate header
  document.getElementById('lb-ticker').textContent = ticker;
  document.getElementById('lb-name').textContent   = info.shortName || '';

  const pe = document.getElementById('lb-price');
  pe.textContent = last.c.toFixed(2);
  pe.className   = isUp ? 'up' : 'down';

  const te = document.getElementById('lb-tags'); te.innerHTML = '';
  if (info.sector)   te.innerHTML += `<span class="tag">${_esc(info.sector)}</span>`;
  if (info.industry) te.innerHTML += `<span class="tag">${_esc(info.industry)}</span>`;

  // Clear mode label (sectors page sets this via openLightboxWithMode)
  const ml = document.getElementById('lb-mode-label');
  if (ml) ml.textContent = '';

  lb.classList.add('open');
  document.body.style.overflow = 'hidden';

  requestAnimationFrame(() => {
    const H = _lbHeight();
    lbCanvas._ohlcv = ohlcv;
    lbCanvas._H     = H;
    drawChart(lbCanvas, ohlcv, H, null);
  });
}

/**
 * openLightboxWithMode(data, useRatio, buildRatioFn, spyOhlcv)
 *   Sectors-page variant: renders ratio chart when mode is active.
 *   buildRatioFn – (etfOhlcv, spyOhlcv) => ratioOhlcv
 */
export function openLightboxWithMode(data, useRatio, drawFn) {
  lbData = data;
  lbZoom = null;
  lbCanvas._zoomRange = null;
  if (lbCanvas._resetZoom) lbCanvas._resetZoom();

  const { ticker, info, ohlcv } = data;
  const last = ohlcv[ohlcv.length - 1];
  const prev = ohlcv[ohlcv.length - 2] || last;
  const isUp = last.c >= prev.c;

  document.getElementById('lb-ticker').textContent = ticker;
  document.getElementById('lb-name').textContent   = info.shortName || '';
  const pe = document.getElementById('lb-price');
  pe.textContent = last.c.toFixed(2);
  pe.className   = isUp ? 'up' : 'down';

  const ml = document.getElementById('lb-mode-label');
  if (ml) ml.textContent = useRatio ? '  vs SPY ratio' : '';

  const te = document.getElementById('lb-tags'); te.innerHTML = '';
  if (info.sector)   te.innerHTML += `<span class="tag">${_esc(info.sector)}</span>`;
  if (info.industry) te.innerHTML += `<span class="tag">${_esc(info.industry)}</span>`;

  lb.classList.add('open');
  document.body.style.overflow = 'hidden';

  requestAnimationFrame(() => {
    const H = _lbHeight();
    lbCanvas._ohlcv = ohlcv;
    lbCanvas._H     = H;
    drawFn(lbCanvas, H);
  });
}

// ── Close ──────────────────────────────────────────────────────
export function closeLightbox() {
  lb.classList.remove('open');
  document.body.style.overflow = '';
  lbData = null;
  lbZoom = null;
}

// ── Wire up close controls ────────────────────────────────────
document.getElementById('lb-close')
  .addEventListener('click', closeLightbox);

lb.addEventListener('click', e => {
  if (e.target === lb) closeLightbox();
});

// ESC: first press resets zoom, second press closes lightbox
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!lb.classList.contains('open')) return;

  if (lbZoom) {
    // Reset zoom only
    lbZoom = null;
    lbCanvas._zoomRange = null;
    if (lbCanvas._resetZoom) lbCanvas._resetZoom();
    if (lbData) drawChart(lbCanvas, lbData.ohlcv, _lbHeight(), null);
  } else {
    closeLightbox();
  }
});

// Redraw on resize
window.addEventListener('resize', () => {
  if (!lbData) return;
  const H = _lbHeight();
  lbCanvas._H = H;
  drawChart(lbCanvas, lbData.ohlcv, H, lbZoom);
});

// ── Private helpers ────────────────────────────────────────────
function _lbHeight() {
  return document.getElementById('lb-canvas-wrap').clientHeight;
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
