#!/usr/bin/env python3
"""Build data/stocks.json for K线竞技场.

Two source modes (can be combined):

1. Long-format CSV parts (akline dump):
   <AKLINE_PARTS>/part_*.csv
   Columns include: code, code_name, trade_date, open, high, low, close, volume, ...

2. Per-stock CSVs in data/raw/*.csv  (filename = stock code, e.g. 600519.SH.csv)
   Columns: trade_date,open,high,low,close,volume  (order flexible; volume optional)

Bulk source path is resolved as:
  $AKLINE_PARTS  →  $AKLINE_DATA/csv_parts  →  ../akline/data/csv_parts  →  data/csv_parts

Usage:
  python3 tools/build_data.py
  AKLINE_PARTS=/path/to/csv_parts python3 tools/build_data.py --top 40
  python3 tools/build_data.py --top 40          # keep N hottest stocks
  python3 tools/build_data.py --min-bars 250
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "stocks.json"
RAW_DIR = ROOT / "data" / "raw"


def _resolve_akline_parts() -> Path:
    env = os.environ.get("AKLINE_PARTS")
    if env:
        return Path(env).expanduser()
    env_data = os.environ.get("AKLINE_DATA")
    if env_data:
        return Path(env_data).expanduser() / "csv_parts"
    for cand in (
        ROOT.parent / "akline" / "data" / "csv_parts",
        ROOT / "data" / "csv_parts",
    ):
        if cand.is_dir():
            return cand
    return ROOT / "data" / "csv_parts"


AKLINE_PARTS = _resolve_akline_parts()

# Display names for known codes; fall back to the code.
NAMES = {
    "001309.SZ": "德明利",
    "600869.SH": "远东股份",
    "600967.SH": "内蒙一机",
    "601086.SH": "国泰集团",
    "603580.SH": "艾艾精工",
    "605058.SH": "奥赛康",
}

REQUIRED = ("trade_date", "open", "high", "low", "close")


def _num(x) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return float("nan")


def bars_from_rows(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        try:
            d = str(r["trade_date"]).strip()
            o, h, l, c = _num(r["open"]), _num(r["high"]), _num(r["low"]), _num(r["close"])
            v = _num(r.get("volume", 0) or 0)
            if not d or any(math.isnan(x) for x in (o, h, l, c)):
                continue
            if h < l or c <= 0 or o <= 0:
                continue
            out.append(
                {
                    "d": d,
                    "o": round(o, 3),
                    "h": round(h, 3),
                    "l": round(l, 3),
                    "c": round(c, 3),
                    "v": v,
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    out.sort(key=lambda x: x["d"])
    # drop duplicate dates (keep last)
    dedup = {}
    for b in out:
        dedup[b["d"]] = b
    return [dedup[d] for d in sorted(dedup)]


def load_raw_dir() -> list[dict]:
    """Per-stock CSVs under data/raw/."""
    stocks = []
    if not RAW_DIR.exists():
        return stocks
    for path in sorted(RAW_DIR.glob("*.csv")):
        code = path.stem
        with path.open(newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        bars = bars_from_rows(rows)
        if not bars:
            continue
        name = NAMES.get(code, code.split(".")[0])
        # try to read a name column if present
        for r in rows:
            for k in ("code_name", "name"):
                if r.get(k):
                    name = r[k]
                    break
        stocks.append(
            {
                "code": code,
                "name": name,
                "market": code.split(".")[-1] if "." in code else ("SH" if code.startswith("6") else "SZ"),
                "start": bars[0]["d"],
                "end": bars[-1]["d"],
                "bars": bars,
            }
        )
    return stocks


def load_akline_parts(min_bars: int) -> list[dict]:
    """Long-format multi-stock dump. Filter + hot-score + keep enough history."""
    if not AKLINE_PARTS.exists():
        return []

    # Collect per-code bar lists + aux metrics on the last ~120 trade dates.
    by_code: dict[str, list[dict]] = defaultdict(list)
    name_of: dict[str, str] = {}
    st_codes: set[str] = set()
    amount_sum: dict[str, float] = defaultdict(float)
    amount_n: dict[str, int] = defaultdict(int)
    ret_window: dict[str, list[float]] = defaultdict(list)

    files = sorted(AKLINE_PARTS.glob("part_*.csv"))
    if not files:
        return []

    # Pass 1: read everything we need (memory OK for ~600k rows).
    all_dates: set[str] = set()
    recs = []  # (code, name, d, o,h,l,c,v, amount, status, is_st)
    for path in files:
        with path.open(newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for r in reader:
                code = str(r.get("code", "")).strip()
                if not code:
                    continue
                # normalize code → 600519.SH style
                if code.isdigit():
                    if code.startswith("6") or code.startswith("9"):
                        scode = f"{code}.SH"
                    elif code.startswith("4") or code.startswith("8"):
                        scode = f"{code}.BJ"
                    else:
                        scode = f"{code}.SZ"
                else:
                    scode = code

                name = (r.get("code_name") or "").strip() or NAMES.get(scode, code)
                name_of[scode] = name
                try:
                    is_st = int(float(r.get("isST") or 0))
                except ValueError:
                    is_st = 0
                if is_st or "ST" in name.upper().replace(" ", ""):
                    st_codes.add(scode)
                try:
                    status = int(float(r.get("tradestatus") or 1))
                except ValueError:
                    status = 1
                if status != 1:
                    continue

                d = str(r.get("trade_date", "")).strip()
                o, h, l, c = _num(r.get("open")), _num(r.get("high")), _num(r.get("low")), _num(r.get("close"))
                v = _num(r.get("volume") or 0)
                amt = _num(r.get("amount") or 0)
                if not d or any(math.isnan(x) for x in (o, h, l, c)):
                    continue
                if h < l or c <= 0 or o <= 0:
                    continue
                recs.append((scode, name, d, o, h, l, c, v, amt, is_st))
                all_dates.add(d)

    if not recs:
        return []

    dates_sorted = sorted(all_dates)
    hot_days = set(dates_sorted[-120:])  # last ~120 trading days

    for scode, name, d, o, h, l, c, v, amt, is_st in recs:
        by_code[scode].append(
            {
                "d": d,
                "o": round(o, 3),
                "h": round(h, 3),
                "l": round(l, 3),
                "c": round(c, 3),
                "v": v,
            }
        )
        if d in hot_days:
            amount_sum[scode] += amt if not math.isnan(amt) else 0
            amount_n[scode] += 1
            ret_window[scode].append(c)

    stocks = []
    for scode, bars in by_code.items():
        if scode in st_codes:
            continue
        # dedup + sort
        dedup = {b["d"]: b for b in bars}
        bars = [dedup[d] for d in sorted(dedup)]
        if len(bars) < min_bars:
            continue

        closes = [b["c"] for b in bars]
        # hot score over last 120 bars
        tail = closes[-120:] if len(closes) >= 120 else closes
        ret120 = (tail[-1] / tail[0] - 1) * 100 if tail[0] else 0.0
        rets = []
        for i in range(max(1, len(tail) - 60), len(tail)):
            if tail[i - 1]:
                rets.append(tail[i] / tail[i - 1] - 1)
        vol = 0.0
        if len(rets) >= 5:
            m = sum(rets) / len(rets)
            vol = math.sqrt(sum((x - m) ** 2 for x in rets) / (len(rets) - 1)) * math.sqrt(250) * 100
        avg_amt = amount_sum[scode] / amount_n[scode] if amount_n[scode] else 0.0

        # 「火热」分项：交投活跃 / 上涨人气 / 波动博弈
        liq = min(math.log10(max(avg_amt, 1e7) / 1e7) * 18.0, 60.0)  # 0..60
        mom = max(ret120, 0.0) * 0.55 + max(-ret120, 0.0) * 0.12  # up-side counts more
        vol_s = min(vol, 90.0) * 0.35
        hot_score = 0.45 * liq + 0.35 * mom + 0.20 * vol_s

        code = scode
        stocks.append(
            {
                "code": code,
                "name": name_of.get(code, NAMES.get(code, code.split(".")[0])),
                "market": code.split(".")[-1],
                "start": bars[0]["d"],
                "end": bars[-1]["d"],
                "ret_120d": round(ret120, 2),
                "vol_pct": round(vol, 2),
                "avg_amt": round(avg_amt, 0),
                "hot": round(hot_score, 2),
                "bars": bars,
            }
        )

    return stocks


def pick_hot_pool(stocks: list[dict], top: int) -> list[dict]:
    """Stratified pool: liquidity leaders + momentum leaders + high-vol names.

    Avoids a pure momentum ranking that would fill the pool with small-cap
    moonshots and drop the names people actually trade.
    """
    if top <= 0 or len(stocks) <= top:
        return sorted(stocks, key=lambda s: -s["hot"])

    n_liq = max(8, top * 2 // 5)          # ~40% 高成交
    n_mom = max(8, top * 2 // 5)          # ~40% 高人气/涨幅
    n_vol = max(4, top - n_liq - n_mom)   # 其余高波动

    by_liq = sorted(stocks, key=lambda s: -(s.get("avg_amt") or 0))
    by_mom = sorted(
        [s for s in stocks if s.get("ret_120d", 0) > 5],
        key=lambda s: -s["ret_120d"],
    )
    by_vol = sorted(stocks, key=lambda s: -s.get("vol_pct", 0))

    picked: list[dict] = []
    seen: set[str] = set()
    for seq, n in (
        (by_liq, n_liq),
        (by_mom, n_mom),
        (by_vol, n_vol),
        (sorted(stocks, key=lambda s: -s["hot"]), top),
    ):
        added = 0
        for s in seq:
            if s["code"] in seen:
                continue
            if len(picked) >= top:
                break
            picked.append(s)
            seen.add(s["code"])
            added += 1
            if added >= n:
                break
        if len(picked) >= top:
            break

    picked.sort(key=lambda s: -s["hot"])
    return picked


def build_index(stocks: list[dict]) -> list[dict]:
    """Equal-weight sample index: each stock starts at 100, average when present."""
    by_date: dict[str, list[float]] = {}
    for s in stocks:
        base = s["bars"][0]["c"]
        if not base:
            continue
        for b in s["bars"]:
            by_date.setdefault(b["d"], []).append(b["c"] / base * 100.0)
    out = []
    for d in sorted(by_date):
        vals = by_date[d]
        out.append({"d": d, "c": round(sum(vals) / len(vals), 3)})
    return out


def classify_window(bars: list[dict], i: int, n: int) -> str:
    """Bull / bear / sideways for bars[i : i+n] based on close-to-close return."""
    j = min(i + n - 1, len(bars) - 1)
    if j <= i:
        return "unknown"
    r = (bars[j]["c"] / bars[i]["c"] - 1) * 100
    # thresholds scale gently with length
    thr = 6.0 + 0.12 * n  # 40d → ~10.8%
    if r >= thr:
        return "bull"
    if r <= -thr:
        return "bear"
    return "side"


def window_stats(stocks: list[dict], days: int = 40) -> dict:
    """How many bull/bear/side windows exist across the pool (for setup info)."""
    counts = {"bull": 0, "bear": 0, "side": 0}
    for s in stocks:
        bars = s["bars"]
        step = max(5, days // 4)
        for i in range(0, len(bars) - days, step):
            counts[classify_window(bars, i, days)] += 1
    return counts


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=36, help="keep N hottest stocks from akline dump")
    ap.add_argument("--min-bars", type=int, default=90, help="min bars required (game needs ~85: warmup 25 + 60d)")
    ap.add_argument("--keep-existing-names", action="store_true")
    args = ap.parse_args()

    stocks: list[dict] = []
    seen = set()

    # 1) user-supplied raw CSVs win / come first
    for s in load_raw_dir():
        stocks.append(s)
        seen.add(s["code"])

    # 2) bulk akline dump → stratified hot pool
    ak = load_akline_parts(min_bars=args.min_bars)
    pool = pick_hot_pool(ak, args.top)
    for s in pool:
        if s["code"] in seen:
            continue
        stocks.append(s)
        seen.add(s["code"])

    if not stocks:
        print("no stocks found; put CSVs into data/raw/ or fix AKLINE_PARTS", file=sys.stderr)
        sys.exit(1)

    # Keep full history but cap bars per stock to limit JSON size (~2.5y)
    max_bars = 640
    for s in stocks:
        if len(s["bars"]) > max_bars:
            s["bars"] = s["bars"][-max_bars:]
            s["start"] = s["bars"][0]["d"]
            s["end"] = s["bars"][-1]["d"]

    index = build_index(stocks)
    regimes = window_stats(stocks, days=40)

    payload = {
        "generated_from": "akline:csv_parts" if ak else "data/raw",
        "count": len(stocks),
        "index_name": "样本等权指数",
        "index": index,
        "regime_counts_40d": regimes,
        "pool_info": {
            "hot_window_days": 120,
            "min_bars": args.min_bars,
            "date_min": min(s["start"] for s in stocks),
            "date_max": max(s["end"] for s in stocks),
        },
        "stocks": stocks,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB, {len(stocks)} stocks)")
    for s in stocks[:15]:
        print(
            f"  {s['code']} {s['name']}: {len(s['bars'])} bars {s['start']} → {s['end']}"
            f"  hot={s.get('hot', '-')} ret120={s.get('ret_120d', '-')}"
        )
    if len(stocks) > 15:
        print(f"  ... +{len(stocks) - 15} more")
    print(f"  index: {len(index)} points {index[0]['d']} → {index[-1]['d']}")
    print(f"  40d windows: {regimes}")


if __name__ == "__main__":
    main()
