#!/usr/bin/env python3
"""Reconcile Taekus (ALT debit) transaction CSVs from Google Drive against YNAB.

The Taekus bank connection in YNAB regularly drops transactions. Drop ALT debit
exports into the Drive folder "Taekus Transaction CSVs" (file names end in the
account's last 4, e.g. "...ALT Business Debit-0523.csv"). Each run:

  1. downloads every CSV in that folder and merges rows by account + timestamp +
     amount, so overlapping exports are fine (the newest copy wins, keeping the
     most points / any filled-in field);
  2. matches every settled Taekus row to the YNAB account TK[BP] - <last4>: same
     signed amount, walked in date order, YNAB dated MATCH_DAYS_BEFORE before to
     MATCH_DAYS_AFTER after the Taekus date (entries are often batch-dated later);
  3. for Taekus rows on/after SYNC_START (and at least GRACE_DAYS old, so the bank
     feed gets first try) with no YNAB transaction, plans a new one,
     copying payee and category (or transfer account) from the most recent matched
     Taekus row with the same description and card, else the description alone;
     a transfer between two Taekus accounts is created once (YNAB adds the other side);
  4. prints the plan, and with --apply writes the missing transactions (cleared,
     unapproved, memo "Taekus <timestamp>", so they show up for review in YNAB).

Usage:
  python scripts/taekus_sync.py            # dry run against Drive
  python scripts/taekus_sync.py --apply    # write to YNAB
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
from collections import defaultdict

from ynab_common import Ynab, drive_csvs, fmt, load_env, read_csv_text

DRIVE_FOLDER_NAME = "Taekus Transaction CSVs"
# YNAB Taekus accounts were bank-reconciled through 2026-09-24; rows before this are left alone.
SYNC_START = dt.date(2026, 9, 25)
HISTORY_START = dt.date(2026, 1, 1)  # matched rows from here on teach payee/category
MATCH_DAYS_BEFORE = 7
MATCH_DAYS_AFTER = 30
# Leave the newest rows to the bank feed for a few days before filling them in.
GRACE_DAYS = 3


def norm(s: str) -> str:
    s = re.sub(r"\(\d+\)", "", str(s or "")).upper()  # drop reference numbers
    return re.sub(r"[^A-Z]+", " ", s).strip()


def taekus_rows(sources):
    rows = {}
    for name, text in sources:
        m = re.search(r"(\d{4})\.csv$", name, re.I)
        if not m:
            continue
        recs = read_csv_text(text)
        if not recs or "transaction amount" not in recs[0] or "points credited" not in recs[0]:
            continue
        seen = defaultdict(int)
        for r in recs:
            dm = re.match(r"(\d{2})/(\d{2})/(\d{4})", r.get("date") or "")
            if not dm:
                continue
            amt = round(float(r["transaction amount"] or 0) * 1000)
            base = (m.group(1), r["date"].strip(), amt)
            seen[base] += 1
            key = base + (seen[base],)
            row = {"key": key, "last4": m.group(1), "ts": r["date"].strip(), "amount": amt,
                   "date": dt.date(int(dm.group(3)), int(dm.group(1)), int(dm.group(2))),
                   "desc": (r.get("description") or "").strip(), "card": (r.get("card nickname") or "").strip(),
                   "settled": (r.get("settled") or "").strip().lower() == "true",
                   "points": float(r.get("points credited") or 0)}
            old = rows.get(key)
            if old:
                row["points"] = max(row["points"], old["points"])
                row["card"] = row["card"] or old["card"]
                if not row["card"] and old["desc"]:
                    row["desc"] = old["desc"]
            rows[key] = row
    return list(rows.values())


def match(csv_rows, ynab_txns):
    """{csv key: ynab txn} matching by signed amount in date order within the window."""
    out, used = {}, set()
    groups = defaultdict(lambda: ([], []))
    for t in ynab_txns:
        groups[t["amount"]][0].append(t)
    for c in csv_rows:
        groups[c["amount"]][1].append(c)
    for ys, cs in groups.values():
        ys.sort(key=lambda t: t["date"])
        cs.sort(key=lambda c: (c["date"], c["ts"]))
        p = 0
        for c in cs:
            while p < len(ys) and (ys[p]["id"] in used or
                                   (dt.date.fromisoformat(ys[p]["date"]) - c["date"]).days < -MATCH_DAYS_BEFORE):
                p += 1
            for t in ys[p:]:
                if t["id"] in used:
                    continue
                if (dt.date.fromisoformat(t["date"]) - c["date"]).days > MATCH_DAYS_AFTER:
                    break
                used.add(t["id"])
                out[c["key"]] = t
                break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write to YNAB")
    args = ap.parse_args()

    env = load_env()
    y = Ynab(env["YNAB_TOKEN"], env["YNAB_BUDGET_ID"])
    sources = drive_csvs(DRIVE_FOLDER_NAME)
    rows = [r for r in taekus_rows(sources) if r["settled"] and r["amount"] != 0]

    accounts = [a for a in y.get("/accounts")["accounts"] if not a["deleted"]]
    by_l4 = {}
    for a in accounts:
        m = re.match(r"^TK[BP]\s*-\s*(\d{4})", a["name"])
        if m and not a["closed"]:
            by_l4[m.group(1)] = a
    by_id = {a["id"]: a for a in accounts}
    tk_ids = {a["id"] for a in by_l4.values()}

    since = (HISTORY_START - dt.timedelta(days=MATCH_DAYS_AFTER)).isoformat()
    matched, learned, learned_desc, missing = {}, {}, {}, []
    for l4, a in sorted(by_l4.items()):
        cs = [r for r in rows if r["last4"] == l4 and r["date"] >= HISTORY_START]
        if not cs:
            continue
        ys = [t for t in y.get(f"/accounts/{a['id']}/transactions?since_date={since}")["transactions"]
              if not t["deleted"]]
        m = match(cs, ys)
        matched.update(m)
        for c in sorted(cs, key=lambda c: (c["date"], c["ts"])):
            t = m.get(c["key"])
            if t:
                how = {"payee_id": t.get("payee_id"), "payee_name": t.get("payee_name"),
                       "category_id": t.get("category_id"), "category_name": t.get("category_name"),
                       "transfer_account_id": t.get("transfer_account_id")}
                learned[(norm(c["desc"]), c["card"], c["amount"] > 0)] = how
                learned_desc[(norm(c["desc"]), c["amount"] > 0)] = how
            elif SYNC_START <= c["date"] <= dt.date.today() - dt.timedelta(days=GRACE_DAYS):
                missing.append(c)

    # A transfer between two Taekus accounts shows up in both CSVs; create it once.
    plan, covered = [], set()
    for c in sorted(missing, key=lambda c: (c["date"], c["ts"])):
        if c["key"] in covered:
            continue
        a = by_l4[c["last4"]]
        how = (learned.get((norm(c["desc"]), c["card"], c["amount"] > 0))
               or learned_desc.get((norm(c["desc"]), c["amount"] > 0)) or {})
        t = {"account_id": a["id"], "date": c["date"].isoformat(), "amount": c["amount"],
             "memo": f"Taekus {c['ts']}", "cleared": "cleared", "approved": False}
        dst = how.get("transfer_account_id")
        if dst:
            t["payee_id"] = by_id[dst]["transfer_payee_id"]
            label = f"Transfer : {by_id[dst]['name']}"
            if dst in tk_ids:
                for o in missing:
                    if o["last4"] != c["last4"] and o["ts"] == c["ts"] and o["amount"] == -c["amount"]:
                        covered.add(o["key"])
        elif how.get("payee_id"):
            t["payee_id"], t["category_id"] = how["payee_id"], how.get("category_id")
            label = f"{how['payee_name']} | {how.get('category_name') or ''}"
        else:
            t["payee_name"] = c["desc"][:50]
            label = f"{c['desc']} | (new payee, uncategorized)"
        plan.append((c, a, t, label))

    print(f"Files: {', '.join(n for n, _ in sources)}")
    print(f"Taekus rows since {HISTORY_START}: {sum(1 for r in rows if r['date'] >= HISTORY_START)};"
          f" matched to YNAB: {len(matched)}; missing since {SYNC_START}: {len(plan)}")
    print(f"\nTO CREATE ({len(plan)}):")
    for c, a, t, label in plan:
        print(f"  {t['date']} {a['name']:<16} {fmt(t['amount']):>12}  {label}   [{c['desc']}, {c['ts']}]")

    if not args.apply or not plan:
        return
    res = y.post_transactions([t for _, _, t, _ in plan])
    print(f"Created {len(res.get('transaction_ids', []))}")


if __name__ == "__main__":
    main()
