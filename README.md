# Stock Dashboard — Multi-Grid Edition

An offline-first stock chart dashboard. Multiple grids, shared data pool.

## Folder Structure

```
stock_dashboard/
├── download_data.py          ← run once per day
├── tickers_sp500.txt         ← ticker list for SP500 grid
├── tickers_candidates.txt    ← ticker list for Candidates grid
├── tickers_portfolio.txt     ← ticker list for Portfolio grid
├── index.html                ← landing page (links to all grids)
├── pages/
│   ├── sp500.html            ← SP500 chart grid
│   ├── candidates.html       ← Candidates chart grid
│   ├── portfolio.html        ← Portfolio chart grid
│   └── _template.html        ← source template (do not delete)
└── data/                     ← auto-created; shared ticker data
    ├── grids.json
    ├── manifest_sp500.json
    ├── manifest_candidates.json
    ├── manifest_portfolio.json
    ├── AAPL.json              ← shared — downloaded once even if in multiple grids
    └── ...
```

## Quick Start

### 1. Install dependency
```bash
pip install yfinance
```

### 2. Edit ticker files
Each `tickers_*.txt` controls one grid. One ticker per line, `#` comments out a line.
A ticker that appears in multiple grids is only downloaded once.

### 3. Download data
```bash
python download_data.py
```

### 4. Serve and view
```bash
python -m http.server 8080
```
Open `http://localhost:8080`

---

## Adding a New Grid

1. Create a new file: `tickers_mygrid.txt`
2. Add tickers to it
3. Run `python download_data.py`
4. Copy `pages/_template.html` → `pages/mygrid.html`
5. Refresh the browser — the new grid appears automatically in the nav

No other changes needed.

---

## Features

- **OHLC bars** with green/red colouring
- **SMA 10** (yellow), **SMA 50** (blue), **SMA 250** (orange)
- **Volume** pane below price
- **2 years** of daily data
- **Sector filter** — multi-select, per grid
- **Watchlist** — shared across all grids, persists in browser
- **Export watchlist** → downloads `watchlist.txt`
- **2 / 4 column** layout toggle
- **Click to expand** — lightbox overlay with large chart
- **Nav bar** — jump between grids without going back to landing page
