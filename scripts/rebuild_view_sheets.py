#!/usr/bin/env python3
"""Rebuild the MS, MS-Crypto, Bill Pay, and Bank Bonus view sheets.

Mirrors setViewFormula_ in gas/Code.gs: each sheet shows a QUERY over the
Cashback_Ledger filtered by its route bucket, newest first.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build

SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets"
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
REPO = Path(__file__).resolve().parent.parent
DEFAULT_CREDS = REPO / "credentials" / "ms-chrn-18db117ee503.json"

LEDGER = "Cashback_Ledger"
HEADERS = [
    "date", "account", "payee", "category_group", "category", "memo", "outflow", "inflow",
    "txn_id", "effective_rate", "cashback_amount", "rate_source", "cleared",
]
# (sheet name, ledger bucket)
VIEWS = [
    ("MS", "MS"),
    ("MS-Crypto", "MS_CRYPTO"),
    ("Bill Pay", "BILL_PAY"),
    ("Bank Bonus", "BANK_BONUS"),
]


def query_formula(bucket: str) -> str:
    return (
        f'=IFERROR(QUERY({LEDGER}!A1:R,'
        f'"select Col2,Col3,Col4,Col5,Col6,Col7,Col8,Col9,Col1,Col13,Col15,Col16,Col18 '
        f"where Col10 = '{bucket}' order by Col2 desc\",1),\"\")"
    )


def find_spreadsheet_id(drive, title: str) -> str:
    safe = title.replace("'", "\\'")
    resp = drive.files().list(
        q=f"mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and name='{safe}'",
        fields="files(id,name)", pageSize=10, supportsAllDrives=True, includeItemsFromAllDrives=True,
    ).execute()
    files = resp.get("files", [])
    if not files:
        raise SystemExit("Spreadsheet not found; pass --spreadsheet-id.")
    return files[0]["id"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--creds", default=str(DEFAULT_CREDS))
    ap.add_argument("--spreadsheet-id", default="")
    ap.add_argument("--title", default="MS-CHRN")
    args = ap.parse_args()

    scopes = [SHEETS_SCOPE] + ([] if args.spreadsheet_id else [DRIVE_SCOPE])
    creds = service_account.Credentials.from_service_account_file(args.creds, scopes=scopes)
    sheets = build("sheets", "v4", credentials=creds)
    spreadsheet_id = args.spreadsheet_id or find_spreadsheet_id(
        build("drive", "v3", credentials=creds), args.title
    )

    meta = sheets.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    existing = {s["properties"]["title"]: s["properties"]["sheetId"] for s in meta["sheets"]}

    for name, bucket in VIEWS:
        if name not in existing:
            print(f"  skip (missing sheet): {name}")
            continue
        sheets.spreadsheets().values().clear(spreadsheetId=spreadsheet_id, range=f"'{name}'!A:Z", body={}).execute()
        sheets.spreadsheets().values().update(
            spreadsheetId=spreadsheet_id,
            range=f"'{name}'!A1",
            valueInputOption="USER_ENTERED",
            body={"values": [HEADERS, [query_formula(bucket)]]},
        ).execute()
        print(f"  rebuilt: {name} (bucket {bucket})")

    print(f"Done. Spreadsheet: {spreadsheet_id}")


if __name__ == "__main__":
    main()
