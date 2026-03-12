/* =============================================================
   chart.js — Pure chart rendering module
   Exports: drawChart, drawRatioChart, attachCrosshair,
            attachLightboxZoom
   No knowledge of page DOM outside a <canvas> element.
   All configuration is in CHART_CONFIG at the top — change
   colours, pane sizes, padding here and it affects everything.
   ============================================================= */

// ── Configuration ─────────────────────────────────────────────
// Edit this object to change chart appearance globally.

export const CHART_CONFIG = {
  // Canvas padding (pixels)
  pad: { top: 12, right: 22, bottom: 18, left: 62 },

  // OHLC tick arm width (pixels, clamped to slot width)
  tickW: 3,

  // Pane height fractions (must sum to ≤ 1.0)
  panes: {
    price: 0.58,   // OHLC + SMAs
    vol:   0.16,   // Volume bars
    ind:   0.16,   // Price − SMA50 indicator
    // Remainder (~0.10) goes to the date axis
  },

  // Colours (canvas, not CSS — must be explicit values)
  colors: {
    bg:      '#141820',
    plotBg:  'rgb(36,44,53)',
    grid:    'rgba(255,255,255,0.07)',
    text:    '#8896aa',
    up:      '#26d97f',
    down:    '#f04f5e',
    sma10:   '#facc15',
    sma50:   '#60a5fa',
    sma250:  '#f97316',
    ratio:   '#a78bfa',           // Indicator / ratio line
    curPriceLine: 'rgba(255,255,255,0.35)',
    volUp:   'rgba(38,217,127,0.35)',
    volDown: 'rgba(240,79,94,0.35)',
    indZero: 'rgba(255,255,255,0.25)',
    crosshair:    'rgba(255,255,255,0.25)',
    tooltipBg:    'rgba(20,24,32,0.88)',
    tooltipText:  '#e2e8f0',
    zoomOverlay:  'rgba(167,139,250,0.12)',
    zoomEdge:     'rgba(167,139,250,0.6)',
    ratioBaseline:'rgba(255,255,255,0.2)',
    ratioFill:    'rgba(255,255,255,0.05)',
    ratioLine:    'rgba(255,255,255,0.85)',
  },
};

// Shorthand alias (internal use)
const C   = CHART_CONFIG.colors;
const PAD = CHART_CONFIG.pad;

// ── Nice number helpers ────────────────────────────────────────
// Produce rounded, human-friendly axis tick values.

function niceStep(range, targetTicks) {
  const rough = range / targetTicks;
  const mag   = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm  = rough / mag;
  const nice  = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return nice * mag;
}

function niceTicks(lo, hi, targetTicks) {
  const step  = niceStep(hi - lo, targetTicks);
  const start = Math.ceil(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi + step * 0.001; v = Math.round((v + step) * 1e8) / 1e8) {
    if (v >= lo && v <= hi) ticks.push(v);
  }
  return ticks;
}

// ── Date axis helpers ──────────────────────────────────────────
// Produces an array of { i, label } tick positions for the date axis.
// Auto-selects monthly/quarterly labels based on series length,
// then thins them down if too many ticks would overlap.

function pickDateTicks(ohlcv, maxTicks) {
  const n      = ohlcv.length;
  const ticks  = [];
  let lastMonth = null;

  for (let i = 0; i < n; i++) {
    const d        = new Date(ohlcv[i].t + 'T00:00:00');
    const y        = d.getFullYear();
    const m        = d.getMonth();
    // Long daily series → quarterly; otherwise monthly
    const interval = n > 600 ? 3 : 1;

    if (m !== lastMonth && m % interval === 0) {
      const label = m === 0
        ? String(y)
        : d.toLocaleString('en', { month: 'short' });
      ticks.push({ i, label });
      lastMonth = m;
    }
  }

  // Thin until we fit within maxTicks
  while (ticks.length > maxTicks) {
    ticks.splice(0, ticks.length, ...ticks.filter((_, i) => i % 2 === 0));
  }
  return ticks;
}

// ── Price label formatter ──────────────────────────────────────
function fmtPrice(v) {
  return v >= 1000 ? v.toFixed(0) : v >= 100 ? v.toFixed(1) : v.toFixed(2);
}

// ── Core chart renderer ────────────────────────────────────────
/**
 * drawChart(canvas, ohlcv, H, zoomRange?)
 *   canvas    – HTMLCanvasElement
 *   ohlcv     – Array of { t, o, h, l, c, v, sma10, sma50, sma250 }
 *   H         – Logical height in CSS pixels
 *   zoomRange – Optional [startIdx, endIdx] to show a slice
 *
 * Stores geometry on canvas._chartMeta for use by crosshair/zoom.
 */
export function drawChart(canvas, ohlcv, H, zoomRange) {
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.offsetWidth;
  if (!W || !H || !ohlcv?.length) return;

  // Size the backing buffer
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Apply zoom slice
  const data = zoomRange
    ? ohlcv.slice(zoomRange[0], zoomRange[1] + 1)
    : ohlcv;
  const n = data.length;
  if (!n) return;

  // ── Pane geometry ──
  const { panes } = CHART_CONFIG;
  const pH = Math.floor(H * panes.price);
  const vH = Math.floor(H * panes.vol);
  const iH = Math.floor(H * panes.ind);

  const priceY   = PAD.top;
  const priceBot = priceY + pH - PAD.bottom;
  const volY     = priceY + pH;
  const volBot   = volY + vH - 4;
  const indY     = volY + vH;
  const indBot   = indY + iH - 4;
  const dateY    = indY + iH;
  const innerW   = W - PAD.left - PAD.right;
  const slotW    = innerW / n;

  // ── Data ranges ──
  let pmin = Infinity, pmax = -Infinity;
  data.forEach(r => {
    pmin = Math.min(pmin, r.l); pmax = Math.max(pmax, r.h);
    [r.sma10, r.sma50, r.sma250].forEach(v => {
      if (v != null) { pmin = Math.min(pmin, v); pmax = Math.max(pmax, v); }
    });
  });
  const ppad  = (pmax - pmin || 1) * 0.04;
  const plo   = pmin - ppad, phi = pmax + ppad, pspan = phi - plo;
  const volMax = Math.max(...data.map(r => r.v)) || 1;

  // Indicator: price − SMA50
  const indVals  = data.map(r => r.sma50 != null ? r.c - r.sma50 : null);
  const indNonNull = indVals.filter(v => v != null);
  const indAbs   = (indNonNull.length ? Math.max(...indNonNull.map(Math.abs)) : 1) * 1.15;

  // ── Coordinate transforms ──
  const px = i => PAD.left + (i + 0.5) * slotW;
  const py = v => priceY   + (priceBot - priceY) * (1 - (v - plo) / pspan);
  const vy = v => volY     + (volBot   - volY)   * (1 - v / volMax);
  const iy = v => indY     + (indBot   - indY)   * (1 - (v + indAbs) / (2 * indAbs));

  // ── Background ──
  ctx.fillStyle = C.plotBg;
  ctx.fillRect(PAD.left, priceY, innerW, priceBot - priceY);
  ctx.fillRect(PAD.left, volY,   innerW, volBot   - volY);
  ctx.fillRect(PAD.left, indY,   innerW, indBot   - indY);
  // Axis gutters (left, right, date row) stay dark
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, PAD.left, H);
  ctx.fillRect(W - PAD.right, 0, PAD.right, H);
  ctx.fillRect(0, dateY, W, H - dateY);

  // ── Price grid + Y-axis labels ──
  ctx.lineWidth = 1;
  niceTicks(plo, phi, 5).forEach(v => {
    const y = py(v);
    ctx.strokeStyle = C.grid;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
    ctx.fillStyle   = C.text;
    ctx.font        = `10px 'Space Mono',monospace`;
    ctx.textAlign   = 'right';
    ctx.fillText(fmtPrice(v), PAD.left - 4, y + 3);
  });

  // ── Current price dashed line + right-edge label ──
  const lastClose = data[n - 1].c;
  const lastY     = py(lastClose);
  const isLastUp  = data[n - 1].c >= (data[n - 2] || data[n - 1]).c;
  ctx.strokeStyle = C.curPriceLine; ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(PAD.left, lastY); ctx.lineTo(W - PAD.right, lastY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = isLastUp ? C.up : C.down;
  ctx.font      = `9px 'Space Mono',monospace`;
  ctx.textAlign = 'left';
  ctx.fillText(lastClose.toFixed(lastClose >= 100 ? 1 : 2), W - PAD.right + 2, lastY + 3);

  // ── Volume bars (green/red by candle direction) ──
  for (let i = 0; i < n; i++) {
    const r  = data[i];
    const bw = Math.max(1, slotW * 0.6);
    ctx.fillStyle = r.c >= r.o ? C.volUp : C.volDown;
    ctx.fillRect(px(i) - bw / 2, vy(r.v), bw, volBot - vy(r.v));
  }

  // ── SMAs ──
  const drawSMA = (key, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
    let go = false;
    for (let i = 0; i < n; i++) {
      const v = data[i][key]; if (v == null) continue;
      go ? ctx.lineTo(px(i), py(v)) : (ctx.moveTo(px(i), py(v)), go = true);
    }
    ctx.stroke();
  };
  drawSMA('sma250', C.sma250);
  drawSMA('sma50',  C.sma50);
  drawSMA('sma10',  C.sma10);

  // ── OHLC bars ──
  const tw = Math.min(CHART_CONFIG.tickW, Math.max(1, slotW * 0.35));
  ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const r = data[i];
    ctx.strokeStyle = r.c >= r.o ? C.up : C.down;
    ctx.beginPath();
    ctx.moveTo(px(i), py(r.h));      ctx.lineTo(px(i), py(r.l));    // wick
    ctx.moveTo(px(i) - tw, py(r.o)); ctx.lineTo(px(i), py(r.o));    // open tick
    ctx.moveTo(px(i), py(r.c));      ctx.lineTo(px(i) + tw, py(r.c)); // close tick
    ctx.stroke();
  }

  // ── Pane divider lines ──
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  [volY, indY].forEach(y => {
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
  });

  // ── Indicator pane: Price − SMA50 ──
  const zeroY = iy(0);
  // Zero baseline
  ctx.strokeStyle = C.indZero; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD.left, zeroY); ctx.lineTo(W - PAD.right, zeroY); ctx.stroke();
  // Indicator line
  ctx.strokeStyle = C.ratio; ctx.lineWidth = 1.3; ctx.beginPath();
  let indGo = false;
  for (let i = 0; i < n; i++) {
    const v = indVals[i]; if (v == null) { indGo = false; continue; }
    indGo ? ctx.lineTo(px(i), iy(v)) : (ctx.moveTo(px(i), iy(v)), indGo = true);
  }
  ctx.stroke();
  // Label
  ctx.fillStyle = C.text; ctx.font = `9px 'Space Mono',monospace`; ctx.textAlign = 'right';
  ctx.fillText('P−50', PAD.left - 4, indY + 10);

  // ── Date axis ──
  const maxDateTicks = Math.floor(innerW / 45);
  ctx.font = `9px 'Inter',sans-serif`; ctx.textAlign = 'center';
  pickDateTicks(data, maxDateTicks).forEach(({ i, label }) => {
    const x = px(i);
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, dateY); ctx.lineTo(x, dateY + 3); ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.fillText(label, x, dateY + 12);
  });

  // ── Store geometry for crosshair / zoom ──
  canvas._chartMeta = { data, n, slotW, px, py, priceY, priceBot, volY, indY, indBot, dateY, innerW };
}

// ── Ratio chart renderer ───────────────────────────────────────
/**
 * drawRatioChart(canvas, ratioOhlcv, H)
 *   Renders ETF/SPY ratio as a line-area chart.
 *   Uses the same PAD and colours as drawChart.
 */
export function drawRatioChart(canvas, ratioOhlcv, H) {
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.offsetWidth;
  if (!W || !H || !ratioOhlcv?.length) return;

  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const n      = ratioOhlcv.length;
  const innerW = W - PAD.left - PAD.right;
  const priceY = PAD.top;
  const dateY  = H - 18;
  const priceBot = dateY - 4;
  const slotW  = innerW / n;

  // Price range
  let pmin = Infinity, pmax = -Infinity;
  ratioOhlcv.forEach(r => {
    pmin = Math.min(pmin, r.l); pmax = Math.max(pmax, r.h);
    [r.sma10, r.sma50, r.sma250].forEach(v => {
      if (v != null) { pmin = Math.min(pmin, v); pmax = Math.max(pmax, v); }
    });
  });
  const pad5  = (pmax - pmin || 1) * 0.05;
  const plo   = pmin - pad5, phi = pmax + pad5, pspan = phi - plo;

  const px = i => PAD.left + (i + 0.5) * slotW;
  const py = v => priceY + (priceBot - priceY) * (1 - (v - plo) / pspan);

  // ── Background ──
  ctx.fillStyle = C.plotBg;
  ctx.fillRect(PAD.left, priceY, innerW, priceBot - priceY);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, PAD.left, H);
  ctx.fillRect(W - PAD.right, 0, PAD.right, H);
  ctx.fillRect(0, dateY, W, H - dateY);

  // ── Grid + Y-axis labels ──
  niceTicks(plo, phi, 5).forEach(v => {
    const y = py(v);
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
    ctx.fillStyle = C.text; ctx.font = `10px 'Space Mono',monospace`; ctx.textAlign = 'right';
    ctx.fillText(v.toFixed(3), PAD.left - 4, y + 3);
  });

  // ── Baseline at ratio = 1.0 ──
  const baseline = py(1.0);
  ctx.strokeStyle = C.ratioBaseline; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(PAD.left, baseline); ctx.lineTo(W - PAD.right, baseline); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.font = `9px 'Space Mono',monospace`; ctx.textAlign = 'left';
  ctx.fillText('1.0', PAD.left + 3, baseline - 3);

  // ── SMAs ──
  const drawSMA = (key, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
    let go = false;
    for (let i = 0; i < n; i++) {
      const v = ratioOhlcv[i][key]; if (v == null) continue;
      go ? ctx.lineTo(px(i), py(v)) : (ctx.moveTo(px(i), py(v)), go = true);
    }
    ctx.stroke();
  };
  drawSMA('sma250', C.sma250);
  drawSMA('sma50',  C.sma50);
  drawSMA('sma10',  C.sma10);

  // ── Area fill under ratio line ──
  ctx.beginPath();
  ctx.moveTo(px(0), py(ratioOhlcv[0].c));
  for (let i = 1; i < n; i++) ctx.lineTo(px(i), py(ratioOhlcv[i].c));
  ctx.lineTo(px(n - 1), baseline);
  ctx.lineTo(px(0), baseline);
  ctx.closePath();
  ctx.fillStyle = C.ratioFill; ctx.fill();

  // ── Ratio line ──
  ctx.strokeStyle = C.ratioLine; ctx.lineWidth = 1.5; ctx.beginPath();
  for (let i = 0; i < n; i++) {
    i === 0
      ? ctx.moveTo(px(i), py(ratioOhlcv[i].c))
      : ctx.lineTo(px(i), py(ratioOhlcv[i].c));
  }
  ctx.stroke();

  // ── Date axis ──
  const maxDateTicks = Math.floor(innerW / 45);
  ctx.font = `9px 'Inter',sans-serif`; ctx.textAlign = 'center';
  pickDateTicks(ratioOhlcv, maxDateTicks).forEach(({ i, label }) => {
    const x = px(i);
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, dateY); ctx.lineTo(x, dateY + 3); ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.fillText(label, x, dateY + 12);
  });

  // Store meta for crosshair
  canvas._chartMeta = { data: ratioOhlcv, n, slotW, px, py, priceY, priceBot, dateY, innerW };
}

// ── Crosshair ──────────────────────────────────────────────────
/**
 * attachCrosshair(canvas, getRedrawFn)
 *   canvas       – The card canvas element
 *   getRedrawFn  – Callback () => fn  that returns the correct
 *                  redraw function for the current chart mode.
 *                  This keeps chart.js decoupled from app state.
 *
 * Usage (grid page):
 *   attachCrosshair(canvas, () => (c) => drawChart(c, c._ohlcv, CHART_H));
 *
 * Usage (sectors page):
 *   attachCrosshair(canvas, () => redrawCardCanvas);
 */
export function attachCrosshair(canvas, getRedrawFn) {
  canvas.addEventListener('mousemove', e => {
    const meta = canvas._chartMeta;
    if (!meta) return;
    const rect = canvas.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;
    if (mx < PAD.left || mx > rect.width - PAD.right || my > meta.dateY) return;

    const i = Math.round((mx - PAD.left) / meta.slotW - 0.5);
    if (i < 0 || i >= meta.n) return;
    const bar = meta.data[i];
    const x   = meta.px(i);

    // Redraw clean chart first, then overlay
    getRedrawFn()(canvas);

    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Vertical crosshair line
    ctx.strokeStyle = C.crosshair; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, meta.priceY); ctx.lineTo(x, meta.dateY); ctx.stroke();
    ctx.setLineDash([]);

    // Tooltip
    const label = `${bar.t}  ${bar.c.toFixed(bar.c >= 100 ? 2 : 3)}`;
    ctx.font = `10px 'Space Mono',monospace`;
    const tw  = ctx.measureText(label).width + 10;
    const tx  = Math.min(x + 6, rect.width - PAD.right - tw);
    const ty  = meta.priceY + 10;
    ctx.fillStyle = C.tooltipBg;
    ctx.fillRect(tx - 2, ty - 11, tw + 4, 16);
    ctx.fillStyle = C.tooltipText;
    ctx.fillText(label, tx + 3, ty);
  });

  canvas.addEventListener('mouseleave', () => {
    getRedrawFn()(canvas);
  });
}

// ── Lightbox zoom (drag-to-select) ────────────────────────────
/**
 * attachLightboxZoom(canvas, onZoomChange)
 *   canvas        – The lightbox canvas element
 *   onZoomChange  – Callback (zoomRange | null) => void
 *                   Called when zoom is committed or reset.
 *
 * Zoom state is stored externally via the callback — this function
 * manages only drag UI and emits events.
 */
export function attachLightboxZoom(canvas, onZoomChange) {
  let dragging = false;
  let startX   = null;
  let overlayX = null;
  let currentZoom = null;   // tracks zoom passed back via callback

  const canvasX = e => e.clientX - canvas.getBoundingClientRect().left;

  canvas.addEventListener('mousedown', e => {
    const meta = canvas._chartMeta;
    if (!meta || e.button !== 0) return;
    const cx = canvasX(e);
    if (cx < PAD.left || cx > canvas.getBoundingClientRect().width - PAD.right) return;
    dragging = true;
    startX   = cx;
    overlayX = cx;
    canvas.style.cursor = 'col-resize';
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    overlayX = canvasX(e);
    const meta = canvas._chartMeta;
    if (!meta) return;

    // Redraw chart then show drag selection overlay
    const H = canvas._H || Math.round(canvas.height / (window.devicePixelRatio || 1));
    drawChart(canvas, canvas._ohlcv, H, currentZoom);

    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const x1 = Math.min(startX, overlayX);
    const x2 = Math.max(startX, overlayX);
    ctx.fillStyle = C.zoomOverlay;
    ctx.fillRect(x1, meta.priceY, x2 - x1, meta.dateY - meta.priceY);
    ctx.strokeStyle = C.zoomEdge; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x1, meta.priceY); ctx.lineTo(x1, meta.dateY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2, meta.priceY); ctx.lineTo(x2, meta.dateY); ctx.stroke();
  });

  window.addEventListener('mouseup', e => {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = '';
    const meta = canvas._chartMeta;
    if (!meta) return;
    const x1 = Math.min(startX, canvasX(e));
    const x2 = Math.max(startX, canvasX(e));
    if (x2 - x1 < 8) return;   // too small to be intentional

    // Convert pixel range → data indices (accounting for existing zoom offset)
    const baseStart = currentZoom ? currentZoom[0] : 0;
    const i1 = Math.max(0, Math.floor((x1 - PAD.left) / meta.slotW));
    const i2 = Math.min(meta.n - 1, Math.ceil((x2 - PAD.left) / meta.slotW));
    if (i2 <= i1) return;

    currentZoom = [baseStart + i1, baseStart + i2];
    onZoomChange(currentZoom);
  });

  // Click without drag → reset zoom
  canvas.addEventListener('click', e => {
    if (Math.abs(canvasX(e) - startX) > 4) return;
    if (!currentZoom) return;
    currentZoom = null;
    onZoomChange(null);
  });

  // Allow external code to reset zoom (e.g. ESC key handler)
  canvas._resetZoom = () => {
    currentZoom = null;
    onZoomChange(null);
  };
  // Allow external code to read current zoom
  canvas._getZoom = () => currentZoom;
}
