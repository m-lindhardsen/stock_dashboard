/* =============================================================
   chart.js — Pure chart rendering module
   Exports: drawChart, drawRatioChart, attachCrosshair,
            attachLightboxZoom
   No knowledge of page DOM outside a <canvas> element.

   Optimised over v1:
     - OHLC bars batched by colour: 2 draw calls instead of N
     - Volume bars batched by colour: 2 draw calls instead of N
     - Offscreen buffer for crosshair (avoids full redraw per mousemove)
     - pickDateTicks uses string slicing, no Date() construction
     - Loop-based min/max (no spread/stack-overflow risk)
     - Data-range scan is a single pass
   ============================================================= */

// ── Configuration ─────────────────────────────────────────────

export const CHART_CONFIG = {
  pad: { top: 12, right: 22, bottom: 18, left: 62 },
  tickW: 3,
  panes: {
    price: 0.58,
    vol:   0.16,
    ind:   0.16,
  },
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
    ratio:   '#a78bfa',
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

const C   = CHART_CONFIG.colors;
const PAD = CHART_CONFIG.pad;

// ── Nice number helpers ────────────────────────────────────────

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

// ── Date axis helpers (no Date() construction) ─────────────────
// ohlcv[i].t is "YYYY-MM-DD". We extract year/month from substrings.

function pickDateTicks(ohlcv, maxTicks) {
  const n     = ohlcv.length;
  const ticks = [];
  let lastYM  = '';                       // "YYYY-MM" of previous tick

  // Long daily series → quarterly; otherwise monthly
  const interval = n > 600 ? 3 : 1;
  const MONTHS   = ['Jan','Feb','Mar','Apr','May','Jun',
                    'Jul','Aug','Sep','Oct','Nov','Dec'];

  for (let i = 0; i < n; i++) {
    const t  = ohlcv[i].t;               // "YYYY-MM-DD"
    const ym = t.substring(0, 7);        // "YYYY-MM"
    if (ym === lastYM) continue;         // same month
    lastYM = ym;

    const m = parseInt(t.substring(5, 7), 10) - 1;   // 0-based month
    if (m % interval !== 0) continue;

    const label = m === 0 ? t.substring(0, 4) : MONTHS[m];
    ticks.push({ i, label });
  }

  // Thin until we fit
  while (ticks.length > maxTicks) {
    const keep = [];
    for (let i = 0; i < ticks.length; i += 2) keep.push(ticks[i]);
    ticks.length = 0;
    ticks.push(...keep);
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

  // ── Data ranges — single pass ──
  let pmin = Infinity, pmax = -Infinity, volMax = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i];
    if (r.l < pmin) pmin = r.l;
    if (r.h > pmax) pmax = r.h;
    if (r.sma10  != null) { if (r.sma10  < pmin) pmin = r.sma10;  if (r.sma10  > pmax) pmax = r.sma10;  }
    if (r.sma50  != null) { if (r.sma50  < pmin) pmin = r.sma50;  if (r.sma50  > pmax) pmax = r.sma50;  }
    if (r.sma250 != null) { if (r.sma250 < pmin) pmin = r.sma250; if (r.sma250 > pmax) pmax = r.sma250; }
    if (r.v > volMax) volMax = r.v;
  }
  if (!volMax) volMax = 1;
  const ppad  = (pmax - pmin || 1) * 0.04;
  const plo   = pmin - ppad, phi = pmax + ppad, pspan = phi - plo;

  // Indicator: price − SMA50
  const indVals  = new Array(n);
  let indAbs = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i];
    if (r.sma50 != null) {
      const v = r.c - r.sma50;
      indVals[i] = v;
      const a = v < 0 ? -v : v;
      if (a > indAbs) indAbs = a;
    } else {
      indVals[i] = null;
    }
  }
  indAbs = (indAbs || 1) * 1.15;

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

  // ── Volume bars — batched by colour (2 draw calls, not N) ──
  {
    const bw = Math.max(1, slotW * 0.6);
    const halfBw = bw / 2;
    ctx.fillStyle = C.volUp;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const r = data[i];
      if (r.c >= r.o) {
        const x = px(i) - halfBw;
        const top = vy(r.v);
        ctx.rect(x, top, bw, volBot - top);
      }
    }
    ctx.fill();
    ctx.fillStyle = C.volDown;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const r = data[i];
      if (r.c < r.o) {
        const x = px(i) - halfBw;
        const top = vy(r.v);
        ctx.rect(x, top, bw, volBot - top);
      }
    }
    ctx.fill();
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

  // ── OHLC bars — batched by colour (2 draw calls, not N) ──
  {
    const tw = Math.min(CHART_CONFIG.tickW, Math.max(1, slotW * 0.35));
    ctx.lineWidth = 1;

    // Green (up) bars
    ctx.strokeStyle = C.up;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const r = data[i];
      if (r.c < r.o) continue;
      const x = px(i);
      ctx.moveTo(x, py(r.h));      ctx.lineTo(x, py(r.l));        // wick
      ctx.moveTo(x - tw, py(r.o)); ctx.lineTo(x, py(r.o));        // open tick
      ctx.moveTo(x, py(r.c));      ctx.lineTo(x + tw, py(r.c));   // close tick
    }
    ctx.stroke();

    // Red (down) bars
    ctx.strokeStyle = C.down;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const r = data[i];
      if (r.c >= r.o) continue;
      const x = px(i);
      ctx.moveTo(x, py(r.h));      ctx.lineTo(x, py(r.l));
      ctx.moveTo(x - tw, py(r.o)); ctx.lineTo(x, py(r.o));
      ctx.moveTo(x, py(r.c));      ctx.lineTo(x + tw, py(r.c));
    }
    ctx.stroke();
  }

  // ── Pane divider lines ──
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  [volY, indY].forEach(y => {
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
  });

  // ── Indicator pane: Price − SMA50 ──
  const zeroY = iy(0);
  ctx.strokeStyle = C.indZero; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD.left, zeroY); ctx.lineTo(W - PAD.right, zeroY); ctx.stroke();
  ctx.strokeStyle = C.ratio; ctx.lineWidth = 1.3; ctx.beginPath();
  let indGo = false;
  for (let i = 0; i < n; i++) {
    const v = indVals[i]; if (v == null) { indGo = false; continue; }
    indGo ? ctx.lineTo(px(i), iy(v)) : (ctx.moveTo(px(i), iy(v)), indGo = true);
  }
  ctx.stroke();
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

  // ── Cache clean chart as offscreen bitmap for crosshair ──
  _cacheBuffer(canvas);
}

// ── Offscreen buffer for crosshair ─────────────────────────────
// After drawChart completes, we snapshot the canvas to an offscreen
// buffer. The crosshair handler restores from this buffer instead
// of calling the full drawChart() again on every mousemove.

function _cacheBuffer(canvas) {
  if (!canvas._buffer) {
    canvas._buffer = document.createElement('canvas');
  }
  const buf = canvas._buffer;
  buf.width  = canvas.width;
  buf.height = canvas.height;
  buf.getContext('2d').drawImage(canvas, 0, 0);
}

function _restoreBuffer(canvas) {
  const buf = canvas._buffer;
  if (!buf || buf.width !== canvas.width || buf.height !== canvas.height) return false;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);   // reset any scale
  ctx.drawImage(buf, 0, 0);
  return true;
}


// ── Ratio chart renderer ───────────────────────────────────────
/**
 * drawRatioChart(canvas, ratioOhlcv, H)
 *   Renders ETF/SPY ratio as a line-area chart.
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

  // Price range — single-pass loop
  let pmin = Infinity, pmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const r = ratioOhlcv[i];
    if (r.l < pmin) pmin = r.l;
    if (r.h > pmax) pmax = r.h;
    if (r.sma10  != null) { if (r.sma10  < pmin) pmin = r.sma10;  if (r.sma10  > pmax) pmax = r.sma10;  }
    if (r.sma50  != null) { if (r.sma50  < pmin) pmin = r.sma50;  if (r.sma50  > pmax) pmax = r.sma50;  }
    if (r.sma250 != null) { if (r.sma250 < pmin) pmin = r.sma250; if (r.sma250 > pmax) pmax = r.sma250; }
  }
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

  // Cache for crosshair
  _cacheBuffer(canvas);
}

// ── Crosshair ──────────────────────────────────────────────────
/**
 * attachCrosshair(canvas, getRedrawFn)
 *   canvas       – The card canvas element
 *   getRedrawFn  – Callback () => fn that returns the correct redraw
 *                  function for the current chart mode.
 *
 * Optimised: uses offscreen buffer instead of full redraw per mousemove.
 * Falls back to getRedrawFn if buffer is stale or missing.
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

    // Restore clean chart from buffer (fast) or full redraw (fallback)
    if (!_restoreBuffer(canvas)) {
      getRedrawFn()(canvas);
    }

    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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
    // Restore clean chart (no crosshair)
    if (!_restoreBuffer(canvas)) {
      getRedrawFn()(canvas);
    }
  });
}

// ── Lightbox zoom (drag-to-select) ────────────────────────────
/**
 * attachLightboxZoom(canvas, onZoomChange)
 *   canvas        – The lightbox canvas element
 *   onZoomChange  – Callback (zoomRange | null) => void
 */
export function attachLightboxZoom(canvas, onZoomChange) {
  let dragging = false;
  let startX   = null;
  let overlayX = null;
  let currentZoom = null;

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

    // Restore clean chart then overlay selection
    if (!_restoreBuffer(canvas)) {
      const H = canvas._H || Math.round(canvas.height / (window.devicePixelRatio || 1));
      drawChart(canvas, canvas._ohlcv, H, currentZoom);
    }

    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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
    if (x2 - x1 < 8) return;

    const baseStart = currentZoom ? currentZoom[0] : 0;
    const i1 = Math.max(0, Math.floor((x1 - PAD.left) / meta.slotW));
    const i2 = Math.min(meta.n - 1, Math.ceil((x2 - PAD.left) / meta.slotW));
    if (i2 <= i1) return;

    currentZoom = [baseStart + i1, baseStart + i2];
    onZoomChange(currentZoom);
  });

  canvas.addEventListener('click', e => {
    if (Math.abs(canvasX(e) - startX) > 4) return;
    if (!currentZoom) return;
    currentZoom = null;
    onZoomChange(null);
  });

  canvas._resetZoom = () => {
    currentZoom = null;
    onZoomChange(null);
  };
  canvas._getZoom = () => currentZoom;
}
