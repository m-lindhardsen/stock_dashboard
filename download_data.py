#!/usr/bin/env python3
"""
Stock Data Downloader — Multi-Grid Edition
-------------------------------------------
Scans for all tickers_*.txt files in the same folder.
Downloads data once per ticker per day into a shared data/ folder.
Writes one manifest_<name>.json per grid so each page knows its tickers.

To add a new grid:  just create tickers_mygrid.txt and re-run.
"""

import os
import json
import time
import datetime
import sys
import glob

try:
    import yfinance as yf
except ImportError:
    print("Installing yfinance...")
    os.system(f"{sys.executable} -m pip install yfinance --quiet")
    import yfinance as yf

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR   = os.path.join(SCRIPT_DIR, "data")
CACHE_FILE = os.path.join(DATA_DIR, "cache_meta.json")
PERIOD     = "2y"


# ── Ticker file helpers ────────────────────────────────────────────────────────

def find_ticker_files():
    """Return dict of {grid_name: filepath} for every tickers_*.txt found."""
    pattern = os.path.join(SCRIPT_DIR, "tickers_*.txt")
    files = sorted(glob.glob(pattern))
    grids = {}
    for f in files:
        base = os.path.basename(f)           # tickers_sp500.txt
        name = base[len("tickers_"):-len(".txt")]   # sp500
        grids[name] = f
    return grids


def load_tickers_from_file(filepath):
    tickers = []
    with open(filepath, "r") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                tickers.append(line.upper())
    return tickers


# ── Cache ──────────────────────────────────────────────────────────────────────

def load_cache():
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE, "r") as f:
            return json.load(f)
    return {}


def save_cache(meta):
    with open(CACHE_FILE, "w") as f:
        json.dump(meta, f, indent=2)


def needs_update(ticker, meta):
    today = datetime.date.today().isoformat()
    return meta.get(ticker, {}).get("date") != today


# ── Download ───────────────────────────────────────────────────────────────────

def fetch_ticker(ticker):
    print(f"    Downloading {ticker}...")
    t = yf.Ticker(ticker)

    hist = t.history(period=PERIOD, interval="1d", auto_adjust=True)
    if hist.empty:
        print(f"    WARNING: No data for {ticker}")
        return None

    try:
        raw  = t.info
        info = {
            "shortName": raw.get("shortName", ticker),
            "sector":    raw.get("sector",    "—"),
            "industry":  raw.get("industry",  "—"),
        }
    except Exception:
        info = {"shortName": ticker, "sector": "—", "industry": "—"}

    rows = []
    for dt, row in hist.iterrows():
        rows.append({
            "t": dt.strftime("%Y-%m-%d"),
            "o": round(float(row["Open"]),  4),
            "h": round(float(row["High"]),  4),
            "l": round(float(row["Low"]),   4),
            "c": round(float(row["Close"]), 4),
            "v": int(row["Volume"]),
        })

    return {"ticker": ticker, "info": info, "ohlcv": rows}


def sma(values, n):
    result = [None] * len(values)
    for i in range(n - 1, len(values)):
        result[i] = round(sum(values[i - n + 1: i + 1]) / n, 4)
    return result


def enrich_with_sma(data):
    closes = [r["c"] for r in data["ohlcv"]]
    for period, key in [(10, "sma10"), (50, "sma50"), (250, "sma250")]:
        vals = sma(closes, period)
        for i, r in enumerate(data["ohlcv"]):
            r[key] = vals[i]
    return data


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    grids = find_ticker_files()
    if not grids:
        print("No tickers_*.txt files found. Create at least one, e.g. tickers_portfolio.txt")
        sys.exit(1)

    print("Stock Dashboard — Multi-Grid Downloader")
    print(f"Found {len(grids)} grid(s): {', '.join(grids.keys())}")
    print(f"Data dir: {DATA_DIR}")
    print()

    # Collect all unique tickers across all grids
    grid_tickers = {}   # {grid_name: [ticker, ...]}
    all_tickers  = set()
    for name, filepath in grids.items():
        tickers = load_tickers_from_file(filepath)
        grid_tickers[name] = tickers
        all_tickers.update(tickers)
        print(f"  {name}: {len(tickers)} tickers")
    print()

    # Download only what's needed (shared pool, once per ticker per day)
    meta    = load_cache()
    updated = []
    skipped = []
    failed  = []

    for ticker in sorted(all_tickers):
        ticker_file = os.path.join(DATA_DIR, f"{ticker}.json")
        if not needs_update(ticker, meta) and os.path.exists(ticker_file):
            print(f"  {ticker}: up to date (cached)")
            skipped.append(ticker)
            continue

        try:
            data = fetch_ticker(ticker)
            if data is None:
                failed.append(ticker)
                continue
            data = enrich_with_sma(data)
            with open(ticker_file, "w") as f:
                json.dump(data, f, separators=(",", ":"))
            meta[ticker] = {"date": datetime.date.today().isoformat()}
            save_cache(meta)
            updated.append(ticker)
            time.sleep(0.3)
        except Exception as e:
            print(f"  ERROR {ticker}: {e}")
            failed.append(ticker)

    print()
    print(f"Download complete — Updated: {len(updated)}  Skipped: {len(skipped)}  Failed: {len(failed)}")
    if failed:
        print(f"Failed: {', '.join(failed)}")

    # Write one manifest per grid
    print()
    now = datetime.datetime.now().isoformat()
    for name, tickers in grid_tickers.items():
        available = [t for t in tickers if os.path.exists(os.path.join(DATA_DIR, f"{t}.json"))]
        manifest  = {
            "grid":      name,
            "tickers":   available,
            "generated": now,
        }
        mfile = os.path.join(DATA_DIR, f"manifest_{name}.json")
        with open(mfile, "w") as f:
            json.dump(manifest, f, indent=2)
        print(f"  Manifest written: manifest_{name}.json  ({len(available)} tickers)")

    # Write grids index so index.html can list all available grids
    grids_index = {
        "grids":     list(grids.keys()),
        "generated": now,
    }
    with open(os.path.join(DATA_DIR, "grids.json"), "w") as f:
        json.dump(grids_index, f, indent=2)
    print(f"\n  grids.json written — {len(grids)} grids registered.")


if __name__ == "__main__":
    main()
