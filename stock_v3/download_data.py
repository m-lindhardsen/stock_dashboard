#!/usr/bin/env python3
"""
Stock Data Downloader — Multi-Grid Edition (Optimized)
-------------------------------------------------------
Downloads two datasets per ticker:
  - Daily  2 years  → data/AAPL_daily.json
  - Weekly 5 years  → data/AAPL_weekly.json

Optimizations over v1:
  1. Vectorized DataFrame→dict conversion (no iterrows)
  2. Running-sum SMA — O(n) instead of O(n×k)
  3. Threaded company info fetches (concurrent.futures)
  4. In-memory bundle assembly (no re-reading JSON from disk)
  5. Safer chunk size (50) to avoid Yahoo rate limits
  6. Single today() call instead of per-ticker

After individual files are written, bundles are produced per grid per interval:
  - data/sp500_daily_bundle.json   etc.

Ticker files: tickers_mygrid.txt   (one ticker per line, # comments ok)
"""

import os
import json
import datetime
import sys
import glob
from concurrent.futures import ThreadPoolExecutor, as_completed

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

try:
    import numpy as np
except ImportError:
    os.system(f"{sys.executable} -m pip install numpy --quiet")
    import numpy as np

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
DATA_DIR    = os.path.join(SCRIPT_DIR, "data")
CACHE_FILE  = os.path.join(DATA_DIR, "cache_meta.json")
INFO_FILE   = os.path.join(DATA_DIR, "info_cache.json")
CHUNK_SIZE  = 50          # safer than 100 — fewer Yahoo rate-limit retries
INFO_THREADS = 8          # parallel company-info fetches

INTERVALS = [
    ("daily",  "2y", "1d",  "daily"),
    ("weekly", "5y", "1wk", "weekly"),
]


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


# ── Cache helpers ──────────────────────────────────────────────────────────────

def load_json(path, default):
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    return default


def save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def cache_key(ticker, interval_label):
    return f"{ticker}_{interval_label}"


def needs_update(ticker, interval_label, date_cache, today):
    key   = cache_key(ticker, interval_label)
    fname = os.path.join(DATA_DIR, f"{ticker}_{interval_label}.json")
    return date_cache.get(key) != today or not os.path.exists(fname)


# ── SMA — O(n) running sum ────────────────────────────────────────────────────

def sma(values, n):
    """Running-sum SMA.  ~10× faster than re-summing the window each step."""
    length = len(values)
    result = [None] * length
    if length < n:
        return result
    window_sum = sum(values[:n])
    result[n - 1] = round(window_sum / n, 4)
    for i in range(n, length):
        window_sum += values[i] - values[i - n]
        result[i] = round(window_sum / n, 4)
    return result


def enrich_with_sma(rows):
    closes = [r["c"] for r in rows]
    for period, key in [(10, "sma10"), (50, "sma50"), (250, "sma250")]:
        vals = sma(closes, period)
        for i, r in enumerate(rows):
            r[key] = vals[i]
    return rows


# ── Vectorised DataFrame → list-of-dicts ──────────────────────────────────────

def _df_to_rows(sub):
    """Convert a single-ticker OHLCV DataFrame to compact dicts — vectorised."""
    sub = sub.dropna(subset=["Close"])
    if sub.empty:
        return []
    return [
        {
            "t": t.strftime("%Y-%m-%d"),
            "o": round(float(o), 4),
            "h": round(float(h), 4),
            "l": round(float(l), 4),
            "c": round(float(c), 4),
            "v": int(v),
        }
        for t, o, h, l, c, v in zip(
            sub.index,
            sub["Open"].values,
            sub["High"].values,
            sub["Low"].values,
            sub["Close"].values,
            sub["Volume"].values,
        )
    ]


# ── Bulk download ──────────────────────────────────────────────────────────────

def bulk_download(tickers, period, interval):
    print(f"  Bulk downloading {len(tickers)} tickers "
          f"[{interval}, {period}]...", flush=True)

    df = yf.download(
        tickers,
        period=period,
        interval=interval,
        auto_adjust=True,
        group_by="ticker",
        progress=False,
        threads=True,
    )

    results = {}

    if len(tickers) == 1:
        t = tickers[0]
        rows = _df_to_rows(df)
        if rows:
            results[t] = rows
    else:
        for t in tickers:
            try:
                rows = _df_to_rows(df[t])
                if rows:
                    results[t] = rows
            except Exception as e:
                print(f"    WARNING: Could not parse {t}: {e}")

    return results


# ── Company info — threaded ────────────────────────────────────────────────────

def _fetch_single_info(ticker):
    """Fetch info for one ticker (called inside thread pool)."""
    try:
        raw  = yf.Ticker(ticker).info
        return ticker, {
            "shortName": raw.get("shortName", ticker),
            "sector":    raw.get("sector",    "—"),
            "industry":  raw.get("industry",  "—"),
        }
    except Exception:
        return ticker, {"shortName": ticker, "sector": "—", "industry": "—"}


def fetch_info_batch(tickers, info_cache):
    """
    Return info for every ticker in `tickers`.
    Cached tickers are returned immediately; uncached ones are fetched
    in parallel using a thread pool.
    """
    to_fetch = [t for t in tickers if t not in info_cache]
    if to_fetch:
        print(f"    Fetching company info for {len(to_fetch)} new tickers "
              f"({INFO_THREADS} threads)...")
        with ThreadPoolExecutor(max_workers=INFO_THREADS) as pool:
            futures = {pool.submit(_fetch_single_info, t): t for t in to_fetch}
            for fut in as_completed(futures):
                ticker, info = fut.result()
                info_cache[ticker] = info
    return info_cache


# ── Bundle writer (in-memory) ─────────────────────────────────────────────────

def write_bundles(grid_tickers, suffix, now, ticker_data_cache):
    """
    Build bundles from in-memory ticker_data_cache where possible,
    falling back to disk only for tickers that weren't freshly downloaded.
    """
    print(f"\n── BUNDLES ({suffix}) ──────────────────────────────────────")
    for grid_name, tickers in grid_tickers.items():
        bundle_path = os.path.join(DATA_DIR, f"{grid_name}_{suffix}_bundle.json")
        entries = []
        missing = []
        for t in tickers:
            mem_key = f"{t}_{suffix}"
            if mem_key in ticker_data_cache:
                entries.append(ticker_data_cache[mem_key])
            else:
                fpath = os.path.join(DATA_DIR, f"{t}_{suffix}.json")
                if not os.path.exists(fpath):
                    missing.append(t)
                    continue
                with open(fpath, "r") as f:
                    entries.append(json.load(f))

        bundle = {
            "grid":      grid_name,
            "interval":  suffix,
            "generated": now,
            "tickers":   entries,
        }
        with open(bundle_path, "w") as f:
            json.dump(bundle, f, separators=(",", ":"))

        size_kb = os.path.getsize(bundle_path) // 1024
        msg = f"  {grid_name}_{suffix}_bundle.json — {len(entries)} tickers, {size_kb} KB"
        if missing:
            msg += f"  ({len(missing)} missing)"
        print(msg)


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    grids = find_ticker_files()
    if not grids:
        print("No tickers_*.txt files found.")
        sys.exit(1)

    print("Stock Dashboard — Bulk Downloader (Optimized)")
    print(f"Found {len(grids)} grid(s): {', '.join(grids.keys())}")
    print()

    grid_tickers = {}
    all_tickers  = set()
    for name, filepath in grids.items():
        tickers = load_tickers_from_file(filepath)
        grid_tickers[name] = tickers
        all_tickers.update(tickers)
        print(f"  {name}: {len(tickers)} tickers")
    print(f"\n  Total unique tickers: {len(all_tickers)}")

    date_cache = load_json(CACHE_FILE, {})
    info_cache = load_json(INFO_FILE,  {})
    today      = datetime.date.today().isoformat()
    now        = datetime.datetime.now().isoformat()

    # In-memory cache: "AAPL_daily" → {ticker, info, ohlcv} dict
    # Used by write_bundles() to avoid re-reading files we just wrote.
    ticker_data_cache = {}

    for label, period, interval, suffix in INTERVALS:
        print(f"\n── {label.upper()} ({period}, {interval}) ──────────────────")

        to_update = [t for t in sorted(all_tickers)
                     if needs_update(t, label, date_cache, today)]
        skipped   = len(all_tickers) - len(to_update)

        print(f"  To download: {len(to_update)}   Already cached: {skipped}")

        if not to_update:
            print("  All up to date.")
        else:
            # Bulk download in chunks
            all_ohlcv = {}
            for i in range(0, len(to_update), CHUNK_SIZE):
                chunk  = to_update[i: i + CHUNK_SIZE]
                result = bulk_download(chunk, period, interval)
                all_ohlcv.update(result)

            # Batch-fetch company info (threaded)
            tickers_needing_info = [t for t in to_update if t in all_ohlcv]
            fetch_info_batch(tickers_needing_info, info_cache)

            updated, failed = [], []
            for ticker in to_update:
                if ticker not in all_ohlcv:
                    print(f"  WARNING: No {label} data for {ticker}")
                    failed.append(ticker)
                    continue

                rows = enrich_with_sma(all_ohlcv[ticker])
                info = info_cache.get(ticker, {"shortName": ticker, "sector": "—", "industry": "—"})
                data = {"ticker": ticker, "info": info, "ohlcv": rows}

                # Write individual file
                fname = os.path.join(DATA_DIR, f"{ticker}_{suffix}.json")
                with open(fname, "w") as f:
                    json.dump(data, f, separators=(",", ":"))

                # Keep in memory for bundle assembly
                ticker_data_cache[f"{ticker}_{suffix}"] = data

                date_cache[cache_key(ticker, label)] = today
                updated.append(ticker)

            save_json(CACHE_FILE, date_cache)
            save_json(INFO_FILE,  info_cache)

            print(f"  Updated: {len(updated)}   Failed: {len(failed)}")
            if failed:
                print(f"  Failed: {', '.join(failed)}")

        write_bundles(grid_tickers, suffix, now, ticker_data_cache)

    # ── Manifests ──────────────────────────────────────────────────
    print("\n── MANIFESTS ──────────────────────────────────────")
    for name, tickers in grid_tickers.items():
        available = [
            t for t in tickers
            if os.path.exists(os.path.join(DATA_DIR, f"{t}_daily.json"))
        ]
        manifest = {"grid": name, "tickers": available, "generated": now}
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
