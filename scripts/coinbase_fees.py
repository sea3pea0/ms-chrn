#!/usr/bin/env python3
"""Export Coinbase One subscription payments made from Coinbase balances to Drive.

Coinbase One is mostly paid in USDC from the Coinbase account itself, so YNAB never sees it.
This reads every account's transactions through the Coinbase App API (CDP key in
credentials/cdp_api_key.json, Ed25519), keeps the `subscription` (fee) and
`subscription_rebate` (fee refund) rows, and replaces coinbase_one_fees.csv in the Drive
folder "Coinbase Fees" (created if missing) so the MS-CHRN workbook can count them against
MS-Crypto profit. Payments made from bank accounts are already in YNAB and are counted there.

Usage:  python scripts/coinbase_fees.py           # print the rows
        python scripts/coinbase_fees.py --upload  # also write the CSV to Drive
"""

from __future__ import annotations

import argparse
import base64
import csv
import io
import json
import os
import secrets
import sys
import time
from pathlib import Path

import requests
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

REPO = Path(__file__).resolve().parent.parent
KEY_FILE = REPO / "credentials" / "cdp_api_key.json"
HOST = "api.coinbase.com"
DRIVE_PARENT = "1p4CvErK2I2FiUokUFQO8Pe-fr6LldLUh"  # Churning & MS
DRIVE_FOLDER = "Coinbase Fees"
CSV_NAME = "coinbase_one_fees.csv"
TYPES = {"subscription", "subscription_rebate"}


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


class Coinbase:
    def __init__(self, key_file: Path):
        k = json.loads(key_file.read_text())
        self.name = k["name"]
        self.key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(k["privateKey"])[:32])

    def _jwt(self, path: str) -> str:
        now = int(time.time())
        header = {"alg": "EdDSA", "kid": self.name, "nonce": secrets.token_hex(16), "typ": "JWT"}
        payload = {"iss": "cdp", "nbf": now, "exp": now + 120, "sub": self.name,
                   "uri": f"GET {HOST}{path.split('?')[0]}"}
        data = b64u(json.dumps(header).encode()) + "." + b64u(json.dumps(payload).encode())
        return data + "." + b64u(self.key.sign(data.encode()))

    def all(self, path: str) -> list[dict]:
        out = []
        while path:
            r = requests.get(f"https://{HOST}{path}", timeout=60,
                             headers={"Authorization": "Bearer " + self._jwt(path), "CB-VERSION": "2024-01-01"})
            r.raise_for_status()
            j = r.json()
            out += j.get("data") or []
            path = (j.get("pagination") or {}).get("next_uri")
        return out


def fee_rows(cb: Coinbase) -> list[list]:
    rows = []
    for a in cb.all("/v2/accounts?limit=100"):
        for t in cb.all(f"/v2/accounts/{a['id']}/transactions?limit=100"):
            if t.get("type") not in TYPES or t.get("status") not in (None, "completed"):
                continue
            rows.append([t["created_at"][:10], t["type"], float(t["native_amount"]["amount"]),
                         t["native_amount"]["currency"], float(t["amount"]["amount"]), t["amount"]["currency"],
                         a.get("name", ""), t["id"]])
    return sorted(rows)


def upload(text: str):
    sys.path.insert(0, str(REPO / "scripts"))
    import push_gas
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseUpload

    d = build("drive", "v3", credentials=push_gas.get_credentials())
    q = (f"'{DRIVE_PARENT}' in parents and name='{DRIVE_FOLDER}' and trashed=false "
         "and mimeType='application/vnd.google-apps.folder'")
    found = d.files().list(q=q, fields="files(id)").execute()["files"]
    folder = found[0]["id"] if found else d.files().create(
        body={"name": DRIVE_FOLDER, "parents": [DRIVE_PARENT], "mimeType": "application/vnd.google-apps.folder"},
        fields="id").execute()["id"]
    media = MediaIoBaseUpload(io.BytesIO(text.encode()), mimetype="text/csv")
    existing = d.files().list(q=f"'{folder}' in parents and name='{CSV_NAME}' and trashed=false",
                              fields="files(id)").execute()["files"]
    if existing:
        d.files().update(fileId=existing[0]["id"], media_body=media).execute()
    else:
        d.files().create(body={"name": CSV_NAME, "parents": [folder]}, media_body=media, fields="id").execute()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--upload", action="store_true")
    args = ap.parse_args()
    rows = fee_rows(Coinbase(KEY_FILE))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["date", "type", "amount_usd", "native_currency", "amount", "currency", "account", "id"])
    w.writerows(rows)
    fees = sum(-r[2] for r in rows if r[1] == "subscription")
    rebates = sum(r[2] for r in rows if r[1] == "subscription_rebate")
    print(f"{time.strftime('%Y-%m-%d %H:%M')} Coinbase One: {sum(r[1] == 'subscription' for r in rows)} payments "
          f"${fees:,.2f}, {sum(r[1] == 'subscription_rebate' for r in rows)} rebates ${rebates:,.2f}")
    if args.upload:
        upload(buf.getvalue())
        print(f"Wrote {CSV_NAME} to Drive/{DRIVE_FOLDER}")


if __name__ == "__main__":
    main()
