#!/usr/bin/env python3
"""Convert vibe-trading CSVs into compact game JSON."""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

SRC = Path("/Users/jelech/codes/py/vibe-trading/standalone/backtest/data")
OUT = Path(__file__).resolve().parent.parent / "data" / "stocks.json"

# Display names for known codes; fall back to the code.
NAMES = {
    "001309.SZ": "德明利",
    "600869.SH": "远东股份",
    "600967.SH": "内蒙一机",
    "601086.SH": "国泰集团",
    "603580.SH": "艾艾精工",
    "605058.SH": "奥赛康",
}


def load_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = []
        for r in reader:
            rows.append(
                {
                    "d": r["trade_date"],
                    "o": round(float(r["open"]), 3),
                    "h": round(float(r["high"]), 3),
                    "l": round(float(r["low"]), 3),
                    "c": round(float(r["close"]), 3),
                    "v": float(r["volume"]),
                }
            )
    rows.sort(key=lambda x: x["d"])
    return rows


def build_index(stocks: list[dict]) -> list[dict]:
    """Equal-weight sample index: each stock starts at 100, average when present."""
    by_date: dict[str, list[float]] = {}
    bases: dict[str, float] = {}
    for s in stocks:
        code = s["code"]
        bases[code] = s["bars"][0]["c"]
        for b in s["bars"]:
            by_date.setdefault(b["d"], []).append(b["c"] / bases[code] * 100.0)
    out = []
    for d in sorted(by_date):
        vals = by_date[d]
        out.append({"d": d, "c": round(sum(vals) / len(vals), 3)})
    return out


def main() -> None:
    stocks = []
    for path in sorted(SRC.glob("*.csv")):
        code = path.stem  # e.g. 001309.SZ
        bars = load_csv(path)
        if not bars:
            continue
        stocks.append(
            {
                "code": code,
                "name": NAMES.get(code, code.split(".")[0]),
                "market": code.split(".")[-1],
                "start": bars[0]["d"],
                "end": bars[-1]["d"],
                "bars": bars,
            }
        )
    index = build_index(stocks)
    payload = {
        "generated_from": str(SRC),
        "count": len(stocks),
        "index_name": "样本等权指数",
        "index": index,
        "stocks": stocks,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(stocks)} stocks)")
    for s in stocks:
        print(f"  {s['code']} {s['name']}: {len(s['bars'])} bars {s['start']} → {s['end']}")
    print(f"  index: {len(index)} points {index[0]['d']} → {index[-1]['d']}")


if __name__ == "__main__":
    main()
