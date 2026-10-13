#!/usr/bin/env python3
"""Create any missing pipeline sheets in the MS-CHRN workbook with headers.

The view formulas reference Cashback_Ledger, and the GAS sync reads YNAB_Accounts,
Config and the raw helper sheets. If those were deleted, recreate them here so
formulas resolve and syncYnabMirror_ can repopulate them. Does NOT touch existing
sheets (YNAB, Cash Back Rates, etc.).
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

# sheet title -> header row (None = config, seeded separately)
SHEETS = {
    "YNAB_Accounts": ["account_id", "account_name", "account_type", "on_budget", "closed", "note"],
    "Cashback_Ledger": [
        "txn_id", "date", "account", "payee", "category_group", "category", "memo", "outflow", "inflow",
        "route_bucket", "standard_rate", "override_rate", "effective_rate", "cashback_base", "cashback_amount",
        "rate_source", "provider_hint", "cleared",
    ],
    "Taekus_Raw": ["txn_id", "Date", "Type", "Description", "Status", "Amount (USD)", "Points", "effective_rate", "rate"],
    "BLUPE_Raw": ["txn_id", "Event ID", "Type", "DateTime", "Amount", "Interchange", "Effective rate", "Description", "Category", "effective_rate"],
    "Fluz_Raw": ["txn_id", "Transaction ID", "Type", "Amount", "Cashback", "Cashback Rate", "Description", "Category", "Created At", "effective_rate"],
    "ALT_Raw": ["txn_id", "date", "description", "merchant", "points credited", "transaction amount", "effective_rate", "rate"],
    "YNAB_CSV_Seed": ["Account", "Flag", "Date", "Payee", "Category Group/Category", "Category Group", "Category", "Memo", "Outflow", "Inflow", "Cleared"],
}

CONFIG_ROWS = [
    ["section", "key", "value"],
    ["tracked_account_match", "1", "TKB"],
    ["tracked_account_match", "2", "TKP"],
    ["tracked_account_match", "3", "MOLI"],
    ["tracked_account_match", "4", "CURR"],
    ["tracked_account_match", "5", "Coinbase"],
    ["tracked_account_match", "6", "Lemfi"],
    ["tracked_account_match", "7", "PP"],
    ["tracked_account_match", "8", "BLUPE"],
    ["tracked_account_match", "9", "FLUZ"],
    ["sync", "sync_min_minutes", "20"],
    ["sync", "full_refresh_day_of_week", "7"],
]


def find_spreadsheet_id(drive, title: str) -> str:
    safe = title.replace("'", "\\'")
    resp = drive.files().list(
        q=f"mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and name='{safe}'",
        fields="files(id,name)", pageSize=10,
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
    spreadsheet_id = args.spreadsheet_id or find_spreadsheet_id(build("drive", "v3", credentials=creds), args.title)

    meta = sheets.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    existing = {s["properties"]["title"] for s in meta["sheets"]}

    want = list(SHEETS.keys()) + ["Config"]
    to_add = [name for name in want if name not in existing]
    if to_add:
        sheets.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"requests": [{"addSheet": {"properties": {"title": name}}} for name in to_add]},
        ).execute()
        print("Created sheets:", ", ".join(to_add))
    else:
        print("No sheets to create.")

    # Write headers only for sheets we just created (don't clobber existing data).
    for name, header in SHEETS.items():
        if name in to_add:
            sheets.spreadsheets().values().update(
                spreadsheetId=spreadsheet_id, range=f"'{name}'!A1",
                valueInputOption="RAW", body={"values": [header]},
            ).execute()
    if "Config" in to_add:
        sheets.spreadsheets().values().update(
            spreadsheetId=spreadsheet_id, range="'Config'!A1",
            valueInputOption="RAW", body={"values": CONFIG_ROWS},
        ).execute()

    print(f"Done. Spreadsheet: {spreadsheet_id}")


if __name__ == "__main__":
    main()
