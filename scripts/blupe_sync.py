#!/usr/bin/env python3
"""Sync Blue Penguin settlement CSVs from Google Drive into the YNAB BLUPE account.

Drop a Blue Penguin settlement report CSV into the Drive folder
"Blue Penguin Transaction CSVs". Each run:

  1. downloads every CSV in that folder (service account) and merges the rows
     by Event ID, so overlapping exports are fine;
  2. turns each Settle / Refund row dated on/after SYNC_START into one BLUPE
     line (settle = outflow, refund = inflow);
  3. matches those lines against what YNAB already has in BLUPE (Event ID in
     the memo, then amount within a date window), so earlier manual entries
     are not duplicated;
  4. prints the plan, and with --apply writes the missing lines (unapproved,
     so they show up for review in YNAB).

The report has no funding or interchange-payout rows; those still come from
the funding account's feed / manual "Blue Penguin" entries.

Usage:
  python scripts/blupe_sync.py                 # dry run against Drive
  python scripts/blupe_sync.py --apply         # write to YNAB
  python scripts/blupe_sync.py --csv file.csv  # use a local CSV instead of Drive
"""

from __future__ import annotations

import argparse
import datetime as dt
import re

from ynab_common import Ynab, drive_csvs, fmt, load_env, local_csvs, milli, read_csv_text

DRIVE_FOLDER_NAME = "Blue Penguin Transaction CSVs"
YNAB_ACCOUNT = "BLUPE"
# YNAB BLUPE already holds every settlement through 2026-08 (entered by hand).
# Rows before this are left alone.
SYNC_START = dt.date(2026, 9, 1)
# Manual entries were often dated a day or so either side of the settle date.
MATCH_DAYS_BEFORE = 5
MATCH_DAYS_AFTER = 7
AMOUNT_TOLERANCE = 10  # milliunits (1 cent)

SYNC_TYPES = {"Settle", "Refund"}
# Merchant descriptor -> YNAB payee (first match wins).
PAYEES = [
    (r"ROBINHOOD|RHS? BROKERAGE", "Robinhood"),
    (r"AMERICANEXP", "American Express"),
    (r"BARCLAYCARD", "Barclaycard"),
    (r"DISCOVERCAR", "Discover"),
    (r"BANK ?OF ?AMERICA|BANKAMERICA", "Bank of America"),
    (r"CITIBANK", "Citi"),
    (r"STEP\.COM", "Step"),
]


def payee_for(descr: str) -> str:
    for pat, name in PAYEES:
        if re.search(pat, descr, re.I):
            return name
    return re.sub(r"\s{2,}.*", "", descr).strip()[:50] or "Blue Penguin"


def merged_rows(sources: list[tuple[str, str]]) -> list[dict]:
    """Merge rows across files by Event ID; later files win."""
    by_id = {}
    for _, text in sources:
        for r in read_csv_text(text):
            eid = (r.get("Event ID") or "").strip()
            if eid:
                by_id[eid] = r
    return list(by_id.values())


def expected_lines(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        t = r["Type"].strip()
        try:
            d = dt.date.fromisoformat(r["DateTime"].strip()[:10])
        except ValueError:
            continue
        if t not in SYNC_TYPES or d < SYNC_START:
            continue
        amt = -milli(r["Amount"])  # settle is positive in the report = money out of BLUPE
        if not amt:
            continue
        eid, descr = r["Event ID"].strip(), re.sub(r"\s+", " ", r["Description"]).strip()
        memo = (f"BP {eid} - {t} - card {r['Last 4'].strip()} - interchange {r['Interchange'].strip()}"
                f" - {descr}")
        out.append(dict(date=d, amount=amt, ref=f"BP {eid}", type=t,
                        payee=payee_for(r["Description"].strip()), memo=memo[:200]))
    return out


def plan(lines, txns):
    """Split expected lines into matched / create."""
    pool = [t for t in txns if not t["deleted"]]
    used, matched, todo = set(), [], []
    for l in lines:  # exact: Event ID already in a memo
        t = next((t for t in pool if t["id"] not in used and l["ref"] in (t.get("memo") or "")), None)
        if t:
            used.add(t["id"]); matched.append((l, t))
        else:
            todo.append(l)
    create = []
    for l in sorted(todo, key=lambda l: l["date"]):
        best = None
        for t in pool:
            if t["id"] in used or abs(t["amount"] - l["amount"]) > AMOUNT_TOLERANCE:
                continue
            dd = (dt.date.fromisoformat(t["date"]) - l["date"]).days
            if -MATCH_DAYS_BEFORE <= dd <= MATCH_DAYS_AFTER and (best is None or abs(dd) < best[0]):
                best = (abs(dd), t)
        if best:
            used.add(best[1]["id"]); matched.append((l, best[1]))
        else:
            create.append(l)
    return matched, create


def to_ynab(l, account_id):
    # No import_id, same as fluz_sync: YNAB would auto-merge it into look-alike manual entries.
    return dict(account_id=account_id, date=l["date"].isoformat(), amount=l["amount"],
                payee_name=l["payee"], memo=l["memo"], cleared="cleared", approved=False)


def describe(l):
    return f"{l['date']}  {fmt(l['amount']):>11}  {l['payee']:<18} {l['memo']}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", action="append", help="local settlement CSV (repeatable); default: Drive folder")
    ap.add_argument("--apply", action="store_true", help="write to YNAB")
    args = ap.parse_args()

    env = load_env()
    y = Ynab(env["YNAB_TOKEN"], env["YNAB_BUDGET_ID"])

    sources = local_csvs(args.csv) if args.csv else drive_csvs(DRIVE_FOLDER_NAME)
    if not sources:
        print("No CSVs found."); return
    rows = merged_rows(sources)

    acct = next(a for a in y.get("/accounts")["accounts"]
                if a["name"].strip() == YNAB_ACCOUNT and not a["deleted"] and not a["closed"])
    since = (SYNC_START - dt.timedelta(days=MATCH_DAYS_BEFORE + 1)).isoformat()
    txns = y.get(f"/accounts/{acct['id']}/transactions?since_date={since}")["transactions"]

    lines = expected_lines(rows)
    matched, create = plan(lines, txns)
    net = sum(l["amount"] for l in create)
    print(f"Files: {', '.join(n for n, _ in sources)}")
    print(f"Settle/Refund rows since {SYNC_START}: {len(lines)}; {len(matched)} already in YNAB")
    print(f"\nTO CREATE ({len(create)}):")
    for l in create:
        print("  " + describe(l))
    print(f"\nBLUPE balance now {fmt(acct['balance'])}; after sync {fmt(acct['balance'] + net)}")

    if args.apply and create:
        res = y.post_transactions([to_ynab(l, acct["id"]) for l in create])
        print(f"Created {len(res['transaction_ids'])}")


if __name__ == "__main__":
    main()
