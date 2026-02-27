#!/usr/bin/env python3
"""
Stock Data Downloader — Multi-Grid Edition (Bulk)
---------------------------------------------------
Scans for all tickers_*.txt files in the same folder.
Downloads OHLCV data in bulk using yf.download() — much faster for large lists.
Company info (name, sector, industry) is still fetched per-ticker but only once,
and is cached so it is not re-fetched on subsequent days.

To add a new grid:  just create tickers_mygrid.txt and re-run.
"""

import os
import json
import datetime
import sys
import glob

try:
    import yfinance as yf
except ImportError:
    print("Installing yfinance...")
    os.system(f"{sys.executable} -m pip install yfinance --quiet")
    import yfinance as yf

try:
    import pandas as pd
except ImportError:
    os.system(f"{sys.executable} -m pip install pandas --quiet")
    import pandas as pd

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
DATA_DIR    = os.path.join(SCRIPT_DIR, "data")
CACHE_FILE  = os.path.join(DATA_DIR, "cache_meta.json")
INFO_FILE   = os.path.join(DATA_DIR, "info_cache.json")
PERIOD      = "2y"
CHUNK_SIZE  = 100   # tickers per bulk download batch


# ── Ticker file helpers ────────────────────────────────────────────────────────

def find_ticker_files():
    pattern = os.path.join(SCRIPT_DIR, "tickers_*.txt")
    grids = {}
    for f in sorted(glob.glob(pattern)):
        name = os.path.basename(f)[len("tickers_"):-len(".txt")]
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


# ── Caches ─────────────────────────────────────────────────────────────────────

def load_json(path, default):
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    return default


def save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def needs_price_update(ticker, date_cache):
    today = datetime.date.today().isoformat()
    return date_cache.get(ticker) != today


# ── SMA ────────────────────────────────────────────────────────────────────────

def sma(values, n):
    result = [None] * len(values)
    for i in range(n - 1, len(values)):
        result[i] = round(sum(values[i - n + 1: i + 1]) / n, 4)
    return result


def enrich_with_sma(rows):
    closes = [r["c"] for r in rows]
    sma10  = sma(closes, 10)
    sma50  = sma(closes, 50)
    sma250 = sma(closes, 250)
    for i, r in enumerate(rows):
        r["sma10"]  = sma10[i]
        r["sma50"]  = sma50[i]
        r["sma250"] = sma250[i]
    return rows


# ── Bulk OHLCV download ────────────────────────────────────────────────────────

def bulk_download(tickers):
    """
    Download OHLCV for a list of tickers in one request.
    Returns dict: {ticker: [{"t":..,"o":..,"h":..,"l":..,"c":..,"v":..}, ...]}
    """
    print(f"  Bulk downloading {len(tickers)} tickers...", flush=True)

    df = yf.download(
        tickers,
        period=PERIOD,
        interval="1d",
        auto_adjust=True,
        group_by="ticker",
        progress=False,
        threads=True,
    )

    results = {}

    if len(tickers) == 1:
        # Single ticker — yfinance returns flat columns
        t = tickers[0]
        rows = []
        for dt, row in df.iterrows():
            try:
                rows.append({
                    "t": dt.strftime("%Y-%m-%d"),
                    "o": round(float(row["Open"]),  4),
                    "h": round(float(row["High"]),  4),
                    "l": round(float(row["Low"]),   4),
                    "c": round(float(row["Close"]), 4),
                    "v": int(row["Volume"]),
                })
            except Exception:
                continue
        if rows:
            results[t] = rows
    else:
        for t in tickers:
            try:
                sub = df[t].dropna(subset=["Close"])
                rows = []
                for dt, row in sub.iterrows():
                    rows.append({
                        "t": dt.strftime("%Y-%m-%d"),
                        "o": round(float(row["Open"]),  4),
                        "h": round(float(row["High"]),  4),
                        "l": round(float(row["Low"]),   4),
                        "c": round(float(row["Close"]), 4),
                        "v": int(row["Volume"]),
                    })
                if rows:
                    results[t] = rows
            except Exception as e:
                print(f"    WARNING: Could not parse {t}: {e}")

    return results


# ── Company info (cached separately, only fetched once per ticker ever) ────────

def fetch_info(ticker, info_cache):
    if ticker in info_cache:
        return info_cache[ticker]
    print(f"    Fetching info for {ticker}...")
    try:
        raw = yf.Ticker(ticker).info
        info = {
            "shortName": raw.get("shortName", ticker),
            "sector":    raw.get("sector",    "—"),
            "industry":  raw.get("industry",  "—"),
        }
    except Exception:
        info = {"shortName": ticker, "sector": "—", "industry": "—"}
    info_cache[ticker] = info
    return info


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    grids = find_ticker_files()
    if not grids:
        print("No tickers_*.txt files found.")
        sys.exit(1)

    print("Stock Dashboard — Bulk Downloader")
    print(f"Found {len(grids)} grid(s): {', '.join(grids.keys())}")
    print()

    # Collect all unique tickers
    grid_tickers = {}
    all_tickers  = set()
    for name, filepath in grids.items():
        tickers = load_tickers_from_file(filepath)
        grid_tickers[name] = tickers
        all_tickers.update(tickers)
        print(f"  {name}: {len(tickers)} tickers")
    print(f"\n  Total unique tickers: {len(all_tickers)}")

    # Determine which tickers need a price update today
    date_cache = load_json(CACHE_FILE, {})
    info_cache = load_json(INFO_FILE,  {})
    today      = datetime.date.today().isoformat()

    to_update = [t for t in sorted(all_tickers) if needs_price_update(t, date_cache)
                 or not os.path.exists(os.path.join(DATA_DIR, f"{t}.json"))]
    skipped   = [t for t in sorted(all_tickers) if t not in to_update]

    print(f"\n  To download: {len(to_update)}   Already cached: {len(skipped)}")
    if not to_update:
        print("  All tickers up to date — nothing to download.")
    else:
        print()
        # Download in chunks to avoid overwhelming Yahoo
        all_ohlcv = {}
        for i in range(0, len(to_update), CHUNK_SIZE):
            chunk = to_update[i: i + CHUNK_SIZE]
            result = bulk_download(chunk)
            all_ohlcv.update(result)

        # Save each ticker's file
        updated = []
        failed  = []
        for ticker in to_update:
            if ticker not in all_ohlcv:
                print(f"  WARNING: No data returned for {ticker}")
                failed.append(ticker)
                continue
            rows = enrich_with_sma(all_ohlcv[ticker])
            info = fetch_info(ticker, info_cache)
            data = {"ticker": ticker, "info": info, "ohlcv": rows}
            with open(os.path.join(DATA_DIR, f"{ticker}.json"), "w") as f:
                json.dump(data, f, separators=(",", ":"))
            date_cache[ticker] = today
            updated.append(ticker)

        # Persist caches
        save_json(CACHE_FILE, date_cache)
        save_json(INFO_FILE,  info_cache)

        print(f"\n  Updated: {len(updated)}   Failed: {len(failed)}")
        if failed:
            print(f"  Failed tickers: {', '.join(failed)}")

    # Write manifests
    print()
    now = datetime.datetime.now().isoformat()
    for name, tickers in grid_tickers.items():
        available = [t for t in tickers if os.path.exists(os.path.join(DATA_DIR, f"{t}.json"))]
        manifest  = {"grid": name, "tickers": available, "generated": now}
        with open(os.path.join(DATA_DIR, f"manifest_{name}.json"), "w") as f:
            json.dump(manifest, f, indent=2)
        print(f"  manifest_{name}.json — {len(available)} tickers")

    grids_index = {"grids": list(grids.keys()), "generated": now}
    with open(os.path.join(DATA_DIR, "grids.json"), "w") as f:
        json.dump(grids_index, f, indent=2)
    print(f"  grids.json — {len(grids)} grids")
    print("\nDone.")


if __name__ == "__main__":
    main()
