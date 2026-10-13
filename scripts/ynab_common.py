"""Shared pieces for the Drive-CSV -> YNAB syncs (fluz_sync.py, blupe_sync.py)."""

from __future__ import annotations

import csv
import io
import sys
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parent.parent
SA_KEY = REPO / "credentials" / "ms-chrn-18db117ee503.json"
YNAB_BASE = "https://api.ynab.com/v1"


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


def fmt(m: int) -> str:
    return f"{m / 1000:,.2f}"


def read_csv_text(text: str) -> list[dict]:
    return list(csv.DictReader(io.StringIO(text.lstrip("﻿"))))


def drive_csvs(folder_name: str) -> list[tuple[str, str]]:
    """(name, text) of every CSV in the named Drive folder, oldest modified first."""
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    creds = service_account.Credentials.from_service_account_file(
        str(SA_KEY), scopes=["https://www.googleapis.com/auth/drive.readonly"])
    drive = build("drive", "v3", credentials=creds, cache_discovery=False)
    folders = drive.files().list(
        q=f"name = '{folder_name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields="files(id)").execute()["files"]
    if not folders:
        sys.exit(f'Drive folder "{folder_name}" not visible to the service account.')
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


def local_csvs(paths: list[str]) -> list[tuple[str, str]]:
    return [(p, Path(p).read_text(encoding="utf-8-sig")) for p in paths]


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
                dupes.append(t.get("import_id")); continue
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
