#!/usr/bin/env python3
"""Offline test for the Fluz -> YNAB importer dedup logic.

Mirrors gas/FluzImport.gs: builds principal transactions from the Fluz CSV, then
dedups against the FLUZ account rows already present in the YNAB export. Only
rows with no matching (date, amount) slot in YNAB should be flagged NEW.

This validates that re-dropping a full Fluz CSV does not create duplicates, and
that only the most recent (not-yet-in-YNAB) transactions are imported.

Usage:
  python scripts/test_fluz_import.py \
      --fluz "transaction_csv_files/fluz_all_transactions_10_04_2026.csv" \
      --ynab "transaction_csv_files/Selected Transactions for Christopher's Budget as of 2026-10-04 08-53.csv"
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
from collections import Counter
from pathlib import Path
from typing import Dict, List, Optional, Tuple

IMPORT_TYPES = {
    "Virtual Card Purchase",
    "Gift Card Purchase",
    "Virtual Card Return",
    "Add Money",
    "Add Money Pending Settled",
    "Withdrawal",
    "Referral Royalties",
    "Rewards Bonus",
}

YNAB_FLUZ_ACCOUNT = "FLUZ"
# Allow a small date tolerance because Fluz stamps UTC while YNAB may post local.
DATE_TOLERANCE_DAYS = 1


def to_num(v: str) -> float:
    s = (v or "").replace("$", "").replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return 0.0


def milli(x: float) -> int:
    return int(round(x * 1000))


def parse_fluz_date(s: str) -> Optional[dt.date]:
    # e.g. "Fri Oct 02 2026 21:24:27 GMT+0000 (Coordinated Universal Time)"
    import re
    m = re.search(r"([A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4})", s or "")
    if not m:
        return None
    return dt.datetime.strptime(m.group(1), "%a %b %d %Y").date()


def parse_mdy(s: str) -> Optional[dt.date]:
    try:
        return dt.datetime.strptime(s, "%m/%d/%Y").date()
    except ValueError:
        return None


def read_csv(path: Path) -> List[Dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def fluz_candidates(fluz_path: Path) -> List[Tuple[dt.date, int, str, str]]:
    """Return principal candidates: (date, milliamount, type, ref), oldest first."""
    out = []
    for r in read_csv(fluz_path):
        t = (r.get("Type") or "").strip()
        if t not in IMPORT_TYPES:
            continue
        d = parse_fluz_date(r.get("Created At", ""))
        amt = milli(to_num(r.get("Amount")))
        ref = (r.get("Reference ID") or r.get("Transaction ID") or "").strip()
        if d is None or amt == 0 or not ref:
            continue
        out.append((d, amt, t, ref))
    out.sort(key=lambda x: (x[0], x[1]))
    return out


def _fluz_originated(r: Dict[str, str]) -> bool:
    # Transfer counterparts entered from the other account (payee "Transfer : X")
    # are not Fluz-originated and must not define the high-water mark.
    return not (r.get("Payee") or "").strip().startswith("Transfer :")


def ynab_fluz_slots(ynab_path: Path) -> Counter:
    """Multiset of (date, milliamount) for Fluz-originated FLUZ transactions."""
    slots: Counter = Counter()
    for r in read_csv(ynab_path):
        if (r.get("Account") or "").strip() != YNAB_FLUZ_ACCOUNT or not _fluz_originated(r):
            continue
        d = parse_mdy((r.get("Date") or "").strip())
        if d is None:
            continue
        net = to_num(r.get("Inflow")) - to_num(r.get("Outflow"))
        slots[(d, milli(net))] += 1
    return slots


def ynab_fluz_high_water(ynab_path: Path) -> Optional[dt.date]:
    dates = [
        parse_mdy((r.get("Date") or "").strip())
        for r in read_csv(ynab_path)
        if (r.get("Account") or "").strip() == YNAB_FLUZ_ACCOUNT and _fluz_originated(r)
    ]
    dates = [d for d in dates if d]
    return max(dates) if dates else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fluz", required=True)
    ap.add_argument("--ynab", required=True)
    args = ap.parse_args()

    candidates = fluz_candidates(Path(args.fluz))
    slots = ynab_fluz_slots(Path(args.ynab))
    high_water = ynab_fluz_high_water(Path(args.ynab))
    total_existing = sum(slots.values())

    skipped_old = 0
    matched_boundary = 0
    new_rows: List[Tuple[dt.date, int, str, str]] = []
    for d, amt, t, ref in candidates:
        if high_water is not None and d < high_water:
            # Older than the latest YNAB FLUZ date: assume already imported.
            skipped_old += 1
            continue
        if high_water is not None and d == high_water:
            # Same-day boundary: import only rows not already present that day.
            if slots.get((d, amt), 0) > 0:
                slots[(d, amt)] -= 1
                matched_boundary += 1
                continue
        new_rows.append((d, amt, t, ref))

    print(f"Fluz candidates (importable types): {len(candidates)}")
    print(f"Existing YNAB FLUZ rows:            {total_existing}")
    print(f"YNAB FLUZ high-water date:          {high_water}")
    print(f"Skipped (older than high-water):    {skipped_old}")
    print(f"Matched on boundary day (skipped):  {matched_boundary}")
    print(f"NEW to import:                      {len(new_rows)}")

    if new_rows:
        dates = [d for d, _, _, _ in new_rows]
        print(f"NEW date range:                     {min(dates)} -> {max(dates)}")
        by_type = Counter(t for _, _, t, _ in new_rows)
        print("NEW by type:", dict(by_type))
        print("Sample NEW rows (date, $amount, type, ref):")
        for d, amt, t, ref in sorted(new_rows)[-15:]:
            print(f"  {d}  {amt/1000:>10.2f}  {t:<22} {ref}")


if __name__ == "__main__":
    main()
