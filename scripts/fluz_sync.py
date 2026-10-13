#!/usr/bin/env python3
"""Sync Fluz transaction CSVs from Google Drive into the YNAB FLUZ account.

Drop a full Fluz export ("all transactions" CSV) into the Drive folder
"Fluz Transaction CSVs". Each run:

  1. downloads every CSV in that folder (service account) and merges the rows
     by Fluz Transaction ID, so overlapping exports are fine;
  2. turns each Fluz row created on/after SYNC_START into the YNAB lines it
     implies (purchase, funding transfer, cashback, fee, reward, ...);
  3. matches those lines against what YNAB already has in FLUZ (by import_id,
     then by amount within a date window), so bank-feed transfers and earlier
     manual entries are not duplicated;
  4. prints the plan, and with --apply writes the missing lines (unapproved,
     so they show up for review in YNAB).

Where a counterpart account already holds the other side as a plain
(non-transfer) transaction, the plan links it instead of creating a duplicate:
that transaction is turned into a transfer from FLUZ, which creates the FLUZ
line.

Usage:
  python scripts/fluz_sync.py                 # dry run against Drive
  python scripts/fluz_sync.py --apply         # write to YNAB
  python scripts/fluz_sync.py --csv file.csv  # use a local CSV instead of Drive
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parent.parent
SA_KEY = REPO / "credentials" / "ms-chrn-18db117ee503.json"
YNAB_BASE = "https://api.ynab.com/v1"

DRIVE_FOLDER_NAME = "Fluz Transaction CSVs"
YNAB_ACCOUNT = "FLUZ"
# YNAB FLUZ was reconciled to Fluz's own balance through 2026-09-24 ($5.00).
# Rows before this are left alone.
SYNC_START = dt.date(2026, 9, 25)
# An existing YNAB line matches a Fluz line if its date is within this window
# around the Fluz date (bank-side transfers often post a few days later).
MATCH_DAYS_BEFORE = 3
MATCH_DAYS_AFTER = 7
AMOUNT_TOLERANCE = 10  # milliunits (1 cent): Fluz amounts carry 5 decimals

FLUZ_BALANCES = {"Fluz Cash Balance", "Fluz Rewards Balance", "--", ""}
# Fluz source/destination names that don't contain the YNAB account code.
ACCOUNT_ALIASES = {
    "SAVINGS9444": "FLAG - 9444",
    "SOFISAVINGS5887": "SOFS - 5887 - P1",
}
# Apple Wallet destinations route to the cardholder's Apple Cash account.
APPLE_CASH_BY_USER = {"Christopher Rains": "APCA - P1", "Yulia Rains": "APCA - P2"}

PURCHASE_TYPES = {"Virtual Card Purchase", "Gift Card Purchase"}
RETURN_TYPES = {"Virtual Card Return"}
ADD_MONEY_TYPES = {"Add Money", "Add Money Pending Settled"}
REWARD_TYPES = {"Referral Royalties", "Rewards Bonus"}


# ---------------------------------------------------------------- helpers

def load_env() -> dict:
    env = {}
    for line in (REPO / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def milli(s) -> int:
    v = str(s or "").replace("$", "").replace(",", "").strip()
    try:
        return int(round(float(v) * 1000))
    except ValueError:
        return 0


def cents(m: int) -> int:
    """Round milliunits to whole cents (YNAB shows cents)."""
    return int(round(m / 10.0)) * 10


def fluz_date(s: str):
    m = re.search(r"[A-Z][a-z]{2} ([A-Z][a-z]{2} \d{2} \d{4})", s or "")
    return dt.datetime.strptime(m.group(1), "%b %d %Y").date() if m else None


def clean(s) -> str:
    v = str(s or "").strip()
    return "" if v == "--" else v


def key(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", re.sub(r"\[.*?\]", "", str(s or "")).upper())


def import_id(txn_id: str, component: str) -> str:
    return "FZ:" + hashlib.md5(txn_id.encode()).hexdigest()[:12] + ":" + component


def fmt(m: int) -> str:
    return f"{m / 1000:,.2f}"


# ---------------------------------------------------------------- inputs

def read_csv_text(text: str) -> list[dict]:
    return list(csv.DictReader(io.StringIO(text.lstrip("﻿"))))


def drive_csvs() -> list[tuple[str, str]]:
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    creds = service_account.Credentials.from_service_account_file(
        str(SA_KEY), scopes=["https://www.googleapis.com/auth/drive.readonly"])
    drive = build("drive", "v3", credentials=creds, cache_discovery=False)
    folders = drive.files().list(
        q=f"name = '{DRIVE_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields="files(id)").execute()["files"]
    if not folders:
        sys.exit(f'Drive folder "{DRIVE_FOLDER_NAME}" not visible to the service account.')
    files = drive.files().list(
        q=f"'{folders[0]['id']}' in parents and trashed = false",
        fields="files(id,name,mimeType,modifiedTime)", orderBy="modifiedTime").execute()["files"]
    out = []
    for f in files:
        if not f["name"].lower().endswith(".csv") and f["mimeType"] != "text/csv":
            continue
        data = drive.files().get_media(fileId=f["id"]).execute()
        out.append((f["name"], data.decode("utf-8-sig")))
    return out


def merged_rows(sources: list[tuple[str, str]]) -> list[dict]:
    """Merge rows across files by Transaction ID; later files win (fresher status)."""
    by_id = {}
    for _, text in sources:
        for r in read_csv_text(text):
            tid = (r.get("Transaction ID") or "").strip()
            if tid:
                by_id[tid] = r
    return list(by_id.values())


class Ynab:
    def __init__(self, token: str, budget: str):
        self.h = {"Authorization": f"Bearer {token}"}
        self.b = f"{YNAB_BASE}/budgets/{budget}"

    def get(self, path: str):
        r = requests.get(self.b + path, headers=self.h, timeout=60)
        r.raise_for_status()
        return r.json()["data"]

    def post_transactions(self, txns: list[dict]) -> dict:
        # This budget rejects bulk creates with 403.4 data_limit_reached, so post one at a time.
        created, dupes = [], []
        for t in txns:
            r = requests.post(self.b + "/transactions", headers=self.h, json={"transaction": t}, timeout=60)
            if r.status_code == 409:
                dupes.append(t["import_id"]); continue
            if r.status_code >= 300:
                raise RuntimeError(f"YNAB create failed {r.status_code} after {len(created)} created: {r.text}")
            created.append(r.json()["data"]["transaction"]["id"])
        return {"transaction_ids": created, "duplicate_import_ids": dupes}

    def patch_transactions(self, txns: list[dict]) -> dict:
        for t in txns:
            tid = t.pop("id")
            r = requests.put(f"{self.b}/transactions/{tid}", headers=self.h, json={"transaction": t}, timeout=60)
            if r.status_code >= 300:
                raise RuntimeError(f"YNAB update failed {r.status_code}: {r.text}")
        return r.json()["data"]


# ---------------------------------------------------------------- planning

class Accounts:
    def __init__(self, accounts: list[dict]):
        self.open = [a for a in accounts if not a["deleted"] and not a["closed"]]
        self.by_name = {a["name"].strip(): a for a in self.open}
        self.keys = sorted(((key(a["name"]), a) for a in self.open if key(a["name"])),
                           key=lambda x: -len(x[0]))

    def match(self, raw: str):
        k = key(raw)
        if not k:
            return None
        for alias, name in ACCOUNT_ALIASES.items():
            if alias in k:
                return self.by_name.get(name)
        for ak, a in self.keys:  # longest key first = most specific
            if a["name"] != YNAB_ACCOUNT and ak in k:
                return a
        return None


def expected_lines(rows: list[dict], accts: Accounts) -> list[dict]:
    """YNAB lines each Fluz row implies. amount is from FLUZ's point of view."""
    returned_refs = defaultdict(int)
    for r in rows:
        if r["Type"] in RETURN_TYPES:
            returned_refs[r["Reference ID"]] += abs(milli(r["Amount"]))

    out = []
    for r in rows:
        d = fluz_date(r["Created At"])
        if not d or d < SYNC_START:
            continue
        t, tid, ref = r["Type"].strip(), r["Transaction ID"].strip(), clean(r["Reference ID"])
        amt, cb, fee = milli(r["Amount"]), cents(milli(r["Cashback"])), milli(r["Fee"])
        cleared = "cleared" if r["Status"].upper() == "SETTLED" else "uncleared"
        src = re.sub(r"\[.*?\]", "", clean(r["Source"])).strip()
        dst = clean(r["Destination"])
        descr = clean(r["Description"])
        merchant = (src if t in RETURN_TYPES else dst) or descr or t

        def line(comp, amount, memo, account=None, payee=None):
            out.append(dict(date=d, amount=cents(amount), comp=comp, ref=ref, type=t,
                            import_id=import_id(tid, comp), cleared=cleared,
                            account=account, payee=payee, memo=memo[:200]))

        if t in PURCHASE_TYPES or t in RETURN_TYPES:
            fully_returned = returned_refs.get(ref, 0) >= abs(amt) > 0
            target = None
            if dst == "Apple Wallet":
                target = accts.by_name.get(APPLE_CASH_BY_USER.get(r["User"].strip(), ""))
            elif t in PURCHASE_TYPES:
                target = accts.match(dst)
            counter = src if t in RETURN_TYPES else dst
            if fully_returned and target is not None:
                # Purchase reversed by Fluz: keep it inside FLUZ, the money never landed.
                target = None
            payee = "Apple Cash" if counter == "Apple Wallet" else counter
            memo = f"{ref} - {t}" + (f" - {descr}" if descr else "")
            line("P", amt, memo, account=target, payee=None if target else payee)
            # Bank/card-funded purchases pass through FLUZ: money comes in from the funding source.
            if t in PURCHASE_TYPES and src not in FLUZ_BALANCES:
                fund = accts.match(src)
                line("S", -amt, f"{ref} - Funding for {merchant}", account=fund,
                     payee=None if fund else src)
            if cb:
                line("C", cb, f"{ref} - Cashback for {merchant}", payee="Fluz Cashback")
            if fee:
                line("F", -abs(fee), f"{ref} - Fee for {merchant}", payee="Fluz Fee")
        elif t in ADD_MONEY_TYPES:
            fund = accts.match(src)
            line("P", amt, f"{ref} - {t}", account=fund, payee=None if fund else src)
        elif t == "Withdrawal":
            to = accts.match(dst)
            line("P", -abs(amt), f"{ref} - Withdrawal", account=to, payee=None if to else dst)
        elif t in REWARD_TYPES:
            line("P", amt, f"{ref} - {t}", payee=src or "Fluz Rewards")
        # Card Verification, Transfer - In/Out: no money moves in FLUZ.
    return [l for l in out if l["amount"]]


def plan(lines, fluz_txns, accts, counterpart_txns):
    """Split expected lines into matched / link-existing / create."""
    pool = [t for t in fluz_txns if not t["deleted"]]
    used = set()
    by_import = {t["import_id"]: t for t in pool if t.get("import_id")}

    def window(l, t):
        dd = (dt.date.fromisoformat(t["date"]) - l["date"]).days
        return -MATCH_DAYS_BEFORE <= dd <= MATCH_DAYS_AFTER, abs(dd)

    matched, todo = [], []
    for l in lines:
        t = by_import.get(l["import_id"])
        if t and t["id"] not in used:
            used.add(t["id"]); matched.append((l, t)); continue
        todo.append(l)

    # Amount/date matching; prefer same counterpart account, then memo ref, then nearest date.
    still = []
    for l in sorted(todo, key=lambda l: (l["date"], l["comp"])):
        best = None
        for t in pool:
            if t["id"] in used or abs(t["amount"] - l["amount"]) > AMOUNT_TOLERANCE:
                continue
            ok, dist = window(l, t)
            if not ok:
                continue
            same_acct = bool(l["account"]) and t.get("transfer_account_id") == l["account"]["id"]
            has_ref = bool(l["ref"]) and l["ref"] in (t.get("memo") or "")
            score = (not has_ref, not same_acct, dist)
            if best is None or score < best[0]:
                best = (score, t)
        if best:
            used.add(best[1]["id"]); matched.append((l, best[1]))
        else:
            still.append(l)

    # Lines that are transfers: if the other account already has the other side
    # as a plain transaction, link it rather than duplicating.
    link, create = [], []
    cused = set()
    for l in still:
        hit = None
        if l["account"]:
            for t in counterpart_txns.get(l["account"]["id"], []):
                if t["id"] in cused or t.get("transfer_account_id") or t["deleted"]:
                    continue
                if abs(t["amount"] + l["amount"]) > AMOUNT_TOLERANCE:
                    continue
                if window(l, t)[0]:
                    hit = t; break
        if hit:
            cused.add(hit["id"]); link.append((l, hit))
        else:
            create.append(l)
    return matched, link, create


def to_ynab(l, fluz_id):
    t = dict(account_id=fluz_id, date=l["date"].isoformat(), amount=l["amount"],
             memo=l["memo"], cleared=l["cleared"], approved=False)
    # No import_id on purpose: YNAB auto-matches imported transactions to an existing
    # manual one of the same amount (it merged a Fluz return into a bank transfer),
    # so dedup relies on the ref-in-memo + amount matching in plan().
    if l["account"]:
        t["payee_id"] = l["account"]["transfer_payee_id"]
    else:
        t["payee_name"] = (l["payee"] or "Fluz")[:50]
    return t


def describe(l):
    who = f"Transfer : {l['account']['name']}" if l["account"] else l["payee"]
    return f"{l['date']}  {fmt(l['amount']):>11}  {who:<34} {l['memo']}"


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", action="append", help="local Fluz CSV (repeatable); default: Drive folder")
    ap.add_argument("--apply", action="store_true", help="write to YNAB")
    ap.add_argument("--json", help="also write the plan to this JSON file")
    args = ap.parse_args()

    env = load_env()
    y = Ynab(env["YNAB_TOKEN"], env["YNAB_BUDGET_ID"])

    sources = [(p, Path(p).read_text(encoding="utf-8-sig")) for p in args.csv] if args.csv else drive_csvs()
    if not sources:
        print("No CSVs found."); return
    rows = merged_rows(sources)
    latest = max((r for r in rows if fluz_date(r["Created At"])), key=lambda r: (fluz_date(r["Created At"]), r["Created At"]))

    accts = Accounts(y.get("/accounts")["accounts"])
    fluz = accts.by_name[YNAB_ACCOUNT]
    since = (SYNC_START - dt.timedelta(days=MATCH_DAYS_BEFORE + 1)).isoformat()
    fluz_txns = y.get(f"/accounts/{fluz['id']}/transactions?since_date={since}")["transactions"]

    lines = expected_lines(rows, accts)
    counterpart_ids = {l["account"]["id"] for l in lines if l["account"]}
    counterpart = {aid: y.get(f"/accounts/{aid}/transactions?since_date={since}")["transactions"]
                   for aid in counterpart_ids}
    matched, link, create = plan(lines, fluz_txns, accts, counterpart)

    net = sum(l["amount"] for l in create) + sum(l["amount"] for l, _ in link)
    print(f"Files: {', '.join(n for n, _ in sources)}")
    print(f"Fluz rows since {SYNC_START}: {sum(1 for r in rows if (fluz_date(r['Created At']) or SYNC_START) >= SYNC_START)}"
          f" -> {len(lines)} YNAB lines; {len(matched)} already in YNAB")
    print(f"\nTO CREATE ({len(create)}):")
    for l in sorted(create, key=lambda l: (l["date"], l["ref"], l["comp"])):
        print("  " + describe(l))
    print(f"\nTO LINK ({len(link)}): existing transaction in the other account becomes a transfer from FLUZ")
    for l, t in link:
        print(f"  {describe(l)}   <- {l['account']['name']} {t['date']} {fmt(t['amount'])} '{t['payee_name']}'")
    print(f"\nFLUZ balance now {fmt(fluz['balance'])}; after sync {fmt(fluz['balance'] + net)};"
          f" Fluz says {latest['Ending total balance']} (as of {fluz_date(latest['Created At'])})")

    if args.json:
        Path(args.json).write_text(json.dumps({
            "create": [to_ynab(l, fluz["id"]) for l in create],
            "link": [{"id": t["id"], "line": describe(l)} for l, t in link]}, indent=1, default=str))

    if not args.apply or not (create or link):
        return
    if create:
        res = y.post_transactions([to_ynab(l, fluz["id"]) for l in create])
        print(f"Created {len(res.get('transaction_ids', []))}; skipped as duplicate import_id: {len(res.get('duplicate_import_ids', []))}")
    if link:
        y.patch_transactions([{"id": t["id"], "payee_id": fluz["transfer_payee_id"], "category_id": None,
                               "memo": ((t.get("memo") or "") + " " + l["memo"]).strip()[:200]}
                              for l, t in link])
        print(f"Linked {len(link)} existing transactions as transfers from FLUZ")


if __name__ == "__main__":
    main()
