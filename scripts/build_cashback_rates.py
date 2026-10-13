#!/usr/bin/env python3
"""Build the Cash Back Rates sheet from Taekus points data + YNAB target semantics.

CBR = points_credited / abs(transaction_amount) * 0.01

The Taekus ALT exports provide the points and charge amount (the CBR). The YNAB
export provides the destination semantics (the Target and whether it is MS or
MS-Crypto). Targets below were confirmed against YNAB category group/category:
- MOLI      -> YNAB Transfer : MOLI (non-crypto earning transfer)        -> MS
- Coinbase  -> YNAB Transfer group / Coinbase category                   -> MS-Crypto
- PP        -> YNAB Transfer : PP* with Coinbase/PYUSD crypto category    -> MS-Crypto

Sources:
- TKB (Taekus Business P1)  -> ...ALT Business Debit-0523.csv
- TKP (Taekus Personal P1)  -> ...ALT Personal Debit-7840.csv
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

from google.oauth2 import service_account
from googleapiclient.discovery import build

SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets"
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
POINT_VALUE = 0.01

HEADERS = ["Source", "Target", "CBR", "CBR Date", "High CBR", "High CBR Date", "Type"]

Classifier = Callable[[str, str, str], Optional[Tuple[str, str]]]

def classify_tkb(desc: str, merch: str, nick: str) -> Optional[Tuple[str, str]]:
    # Match on description/merchant only; card nicknames cause false positives.
    t = f"{desc} {merch}".lower()
    return match_rules(t, TKB_RULES)


def classify_tkp(desc: str, merch: str, nick: str) -> Optional[Tuple[str, str]]:
    # TKP crypto buys route through PayPal; match the crypto merchant, not the PP card.
    t = f"{desc} {merch}".lower()
    return match_rules(t, TKP_RULES)


# Ordered rule tables: first matching keyword wins. (keywords, target, type)
Rule = Tuple[Tuple[str, ...], str, str]

TKB_RULES: List[Rule] = [
    (("metapay",), "MetaPay", "MS"),  # hidden TKB P1 -> TKB P2 intermediary
    (("moneylion", "money lion", "ml spend transfer", "roarmoney"), "MOLI", "MS"),
    (("current account depos",), "CURR", "MS"),
    (("chime",), "CHME", "MS"),
    (("lemfi",), "Lemfi", "MS"),
    (("wise",), "Wise", "MS"),
    (("onepay",), "OnePay", "MS"),
    (("sling",), "Sling Money", "MS"),
    (("skrill", "skrillusa"), "Skrill", "MS"),
    (("revolut",), "Revolut", "MS"),
    (("robinhood",), "Robinhood", "MS-Crypto"),
    (("uphold",), "Uphold", "MS-Crypto"),
    (("coinbase",), "Coinbase", "MS-Crypto"),
    (("transak",), "Transak", "MS-Crypto"),
    (("moonpay",), "MoonPay", "MS-Crypto"),
    (("usdc",), "USDC", "MS-Crypto"),
    (("phantom", "meld"), "Phantom", "MS-Crypto"),
    (("citibank",), "Citi", "Bill Pay"),
    (("syncb", "synchrony"), "Synchrony", "Bill Pay"),
]

TKP_RULES: List[Rule] = [
    (("coinbase", "pyusd", "crypto hub"), "PP", "MS-Crypto"),
    (("robinhood",), "Robinhood", "MS-Crypto"),
    (("sling",), "Sling Money", "MS"),
    (("revolut",), "Revolut", "MS"),
    (("skrill",), "Skrill", "MS"),
]


def match_rules(text: str, rules: List[Rule]) -> Optional[Tuple[str, str]]:
    for keywords, target, type_ in rules:
        if any(k in text for k in keywords):
            return target, type_
    return None


SOURCES: List[Tuple[str, List[str], Classifier]] = [
    (
        "TKB",
        [
            "2024-01-01-2025-10-05-ALT Business Debit-0523.csv",
            "2025-10-04-2026-10-05-ALT Business Debit-0523.csv",
        ],
        classify_tkb,
    ),
    (
        "TKP",
        [
            "2024-01-01-2025-10-05-ALT Personal Debit-7840.csv",
            "2025-10-04-2026-10-05-ALT Personal Debit-7840.csv",
        ],
        classify_tkp,
    ),
]


def to_num(v: str) -> float:
    s = (v or "").replace("$", "").replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return 0.0


def parse_alt_datetime(s: str) -> Optional[dt.datetime]:
    try:
        return dt.datetime.strptime(s, "%m/%d/%Y %H:%M UTC")
    except ValueError:
        return None


def parse_fluz_datetime(s: str) -> Optional[dt.datetime]:
    import re
    m = re.search(r"([A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4})", s or "")
    if not m:
        return None
    try:
        return dt.datetime.strptime(m.group(1), "%a %b %d %Y")
    except ValueError:
        return None


# Fluz spends through virtual/gift cards to money-movement rails (not retail).
FLUZ_RULES: List[Rule] = [
    (("roarmoney", "moneylion"), "MOLI", "MS"),
    (("skrill",), "Skrill", "MS"),
    (("western union",), "Western Union", "MS"),
    (("sling", "morse"), "Sling Money", "MS"),
    (("astra",), "Astra", "MS"),
    (("paypal",), "PP", "MS-Crypto"),
    (("one finance", "one"), "OnePay", "MS"),
    (("coinbase",), "Coinbase", "MS-Crypto"),
    (("robinhood",), "Robinhood", "MS-Crypto"),
    (("citi",), "Citi", "Bill Pay"),
    (("synchrony",), "Synchrony", "Bill Pay"),
]

FLUZ_FILE = "fluz_all_transactions_10_04_2026.csv"
FLUZ_SPEND_TYPES = {"Virtual Card Purchase", "Gift Card Purchase"}


def read_csv(path: Path) -> List[Dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


# Observation: (source, target, type, datetime, cbr).
Observation = Tuple[str, str, str, dt.datetime, float]


def collect_taekus(data_dir: Path, min_amount: float) -> List[Observation]:
    out: List[Observation] = []
    for source, filenames, classify in SOURCES:
        for filename in filenames:
            path = data_dir / filename
            if not path.exists():
                continue
            for r in read_csv(path):
                amt = to_num(r.get("transaction amount"))
                pts = to_num(r.get("points credited"))
                when = parse_alt_datetime(r.get("date", ""))
                # Small charges round points up and distort the rate; skip them.
                if when is None or pts <= 0 or amt >= 0 or abs(amt) < min_amount:
                    continue
                result = classify(r.get("description", ""), r.get("merchant", ""), r.get("card nickname", ""))
                if result is None:
                    continue
                target, type_ = result
                out.append((source, target, type_, when, pts / abs(amt) * POINT_VALUE))
    return out


def collect_fluz(data_dir: Path) -> List[Observation]:
    path = data_dir / FLUZ_FILE
    if not path.exists():
        return []
    out: List[Observation] = []
    for r in read_csv(path):
        if (r.get("Type") or "").strip() not in FLUZ_SPEND_TYPES:
            continue
        amt = to_num(r.get("Amount"))
        cb = to_num(r.get("Cashback"))
        when = parse_fluz_datetime(r.get("Created At", ""))
        if when is None or amt >= 0 or cb <= 0:
            continue
        # Fluz cashback is an exact percentage, so no minimum-amount filter needed.
        result = match_rules((r.get("Destination") or "").lower(), FLUZ_RULES)
        if result is None:
            continue
        target, type_ = result
        out.append(("FLUZ", target, type_, when, cb / abs(amt)))
    return out


# BLUPE pays bills/brokerage; user keeps a share of the card interchange as cash
# back (the rest goes to Blue Penguin). CBR = effective_rate * share_ratio.
BLUPE_FILE = "BLUPE_settlement_report_20261004_081017.csv"
BLUPE_RULES: List[Rule] = [
    (("americanexp", "amex"), "Amex", "Bill Pay"),
    (("bankamerica", "bank of america"), "BofA", "Bill Pay"),
    (("barclay",), "Barclays", "Bill Pay"),
    (("citibank", "citi"), "Citi", "Bill Pay"),
    (("discover",), "Discover", "Bill Pay"),
    (("robinhood", "rhs brokerage", "rh brokerage"), "Robinhood", "Bill Pay"),
    (("step.com", "step "), "Step", "MS"),
]


def _year_month(d: dt.date) -> int:
    return d.year * 12 + d.month


def blupe_share_ratio(data_dir: Path, ynab_path: Optional[Path]) -> float:
    """Median monthly (cashback deposit / interchange) with a ~2-month payout lag.

    Blue Penguin pays cash back ~45 days after month end, so a deposit in month D
    corresponds to spend in month D-2. The median resists months with partial data.
    """
    default = 0.697
    if ynab_path is None or not ynab_path.exists():
        return default
    settle_path = data_dir / BLUPE_FILE
    if not settle_path.exists():
        return default

    interchange_by_month: Dict[int, float] = {}
    for r in read_csv(settle_path):
        if (r.get("Type") or "").strip() != "Settle":
            continue
        try:
            d = dt.datetime.strptime(r["DateTime"], "%Y-%m-%d").date()
        except (ValueError, KeyError):
            continue
        interchange_by_month[_year_month(d)] = interchange_by_month.get(_year_month(d), 0.0) + to_num(r.get("Interchange"))

    cashback_by_month: Dict[int, float] = {}
    for r in read_csv(ynab_path):
        if (r.get("Account") or "").strip() != "BLUPE":
            continue
        payee = (r.get("Payee") or "").lower()
        category = (r.get("Category") or "").lower()
        inflow = to_num(r.get("Inflow"))
        if inflow <= 0 or not ("blue penguin" in payee or "cash back" in category or "reward" in category):
            continue
        d = parse_mdy_date((r.get("Date") or "").strip())
        if d is None:
            continue
        cashback_by_month[_year_month(d)] = cashback_by_month.get(_year_month(d), 0.0) + inflow

    ratios = []
    for dep_month, cb in cashback_by_month.items():
        spend_month = dep_month - 2
        ic = interchange_by_month.get(spend_month, 0.0)
        if ic > 0:
            ratios.append(cb / ic)
    if not ratios:
        return default
    ratios.sort()
    mid = len(ratios) // 2
    return ratios[mid] if len(ratios) % 2 else (ratios[mid - 1] + ratios[mid]) / 2


def parse_mdy_date(s: str) -> Optional[dt.date]:
    try:
        return dt.datetime.strptime(s, "%m/%d/%Y").date()
    except ValueError:
        return None


def collect_blupe(data_dir: Path, ynab_path: Optional[Path]) -> List[Observation]:
    path = data_dir / BLUPE_FILE
    if not path.exists():
        return []
    share = blupe_share_ratio(data_dir, ynab_path)
    out: List[Observation] = []
    for r in read_csv(path):
        if (r.get("Type") or "").strip() != "Settle":
            continue
        amt = to_num(r.get("Amount"))
        interchange = to_num(r.get("Interchange"))
        if amt <= 0 or interchange <= 0:
            continue
        try:
            d = dt.datetime.strptime(r["DateTime"], "%Y-%m-%d")
        except (ValueError, KeyError):
            continue
        result = match_rules((r.get("Description") or "").lower(), BLUPE_RULES)
        if result is None:
            continue
        target, type_ = result
        cbr = (interchange / amt) * share
        out.append(("BLUPE", target, type_, d, cbr))
    return out


def observations_to_rows(observations: List[Observation]) -> List[List[str]]:
    buckets: Dict[Tuple[str, str, str], List[Tuple[dt.datetime, float]]] = {}
    for source, target, type_, when, cbr in observations:
        buckets.setdefault((source, target, type_), []).append((when, cbr))

    rows: List[List[str]] = []
    for (source, target, type_), obs in buckets.items():
        latest_when, latest_cbr = max(obs, key=lambda x: x[0])
        high_when, high_cbr = max(obs, key=lambda x: (x[1], x[0]))
        rows.append([
            source,
            target,
            f"{latest_cbr * 100:.2f}%",
            latest_when.date().isoformat(),
            f"{high_cbr * 100:.2f}%",
            high_when.date().isoformat(),
            type_,
        ])
    # Most recent CBR Date on top.
    rows.sort(key=lambda r: r[3], reverse=True)
    return rows


def build_rows(data_dir: Path, min_amount: float = 0.0, ynab_path: Optional[Path] = None) -> List[List[str]]:
    observations = (
        collect_taekus(data_dir, min_amount)
        + collect_fluz(data_dir)
        + collect_blupe(data_dir, ynab_path)
    )
    return observations_to_rows(observations)



def get_services(creds_path: str, include_drive: bool):
    scopes = [SHEETS_SCOPE] + ([DRIVE_SCOPE] if include_drive else [])
    creds = service_account.Credentials.from_service_account_file(creds_path, scopes=scopes)
    sheets = build("sheets", "v4", credentials=creds)
    drive = build("drive", "v3", credentials=creds) if include_drive else None
    return sheets, drive


def find_spreadsheet_id(drive_svc, title: str) -> str:
    safe_title = title.replace("'", "\\'")
    q = (
        "mimeType='application/vnd.google-apps.spreadsheet' "
        "and trashed=false "
        f"and name='{safe_title}'"
    )
    resp = drive_svc.files().list(
        q=q,
        fields="files(id,name)",
        pageSize=10,
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute()
    files = resp.get("files", [])
    if not files:
        raise RuntimeError("Spreadsheet not found by title.")
    if len(files) > 1:
        raise RuntimeError("Multiple spreadsheets matched title; pass --spreadsheet-id.")
    return files[0]["id"]


def write_sheet(sheets_svc, spreadsheet_id: str, rows: List[List[str]]):
    sheets_svc.spreadsheets().values().clear(
        spreadsheetId=spreadsheet_id,
        range="Cash Back Rates!A:Z",
        body={},
    ).execute()
    sheets_svc.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range="Cash Back Rates!A1",
        valueInputOption="USER_ENTERED",
        body={"values": [HEADERS] + rows},
    ).execute()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--creds", required=True)
    p.add_argument("--data-dir", default="transaction_csv_files")
    p.add_argument("--spreadsheet-id", default="")
    p.add_argument("--title", default="MS-CHRN")
    p.add_argument("--write-sheet", action="store_true")
    p.add_argument("--min-amount", type=float, default=200.0,
                   help="Ignore charges below this amount; small charges round points up and distort the rate.")
    p.add_argument("--ynab-csv", default="transaction_csv_files/Selected Transactions for Christopher's Budget as of 2026-10-04 08-53.csv",
                   help="YNAB export, used to derive the BLUPE interchange-share ratio.")
    p.add_argument("--output-csv", default="outputs/cash_back_rates.csv")
    return p.parse_args()


def main():
    args = parse_args()
    data_dir = Path(args.data_dir)
    ynab_path = Path(args.ynab_csv) if args.ynab_csv else None
    rows = build_rows(data_dir, min_amount=args.min_amount, ynab_path=ynab_path)

    out_path = Path(args.output_csv)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(HEADERS)
        w.writerows(rows)

    print(f"Built {len(rows)} source rows")
    print(f"Output file: {out_path}")
    for row in rows:
        print(" ", row)

    if args.write_sheet:
        spreadsheet_id = args.spreadsheet_id.strip()
        sheets_svc, drive_svc = get_services(args.creds, include_drive=not bool(spreadsheet_id))
        if not spreadsheet_id:
            spreadsheet_id = find_spreadsheet_id(drive_svc, args.title)
        write_sheet(sheets_svc, spreadsheet_id, rows)
        print(f"Wrote Cash Back Rates to sheet: {spreadsheet_id}")


if __name__ == "__main__":
    main()
