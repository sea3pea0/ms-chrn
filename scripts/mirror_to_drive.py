#!/usr/bin/env python3
"""Mirror the local transaction_csv_files/ folder into a Google Drive folder.

Uploads as the user (OAuth) because service accounts have no Drive storage
quota. Idempotent: a file with the same name is updated in place, otherwise it
is created. Target is the folder in .env as google_driver_root_id, where the
Fluz importer reads from.

Usage:
  python scripts/mirror_to_drive.py            # mirror all CSVs
  python scripts/mirror_to_drive.py --dry-run  # show actions only
"""

from __future__ import annotations

import argparse
import mimetypes
import os
import sys
from pathlib import Path

from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

sys.path.insert(0, str(Path(__file__).resolve().parent))
from push_gas import get_credentials  # user OAuth (service accounts lack Drive quota)

REPO = Path(__file__).resolve().parent.parent
DEFAULT_LOCAL_DIR = REPO / "transaction_csv_files"


def load_env(key: str) -> str:
    env = REPO / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            k, _, v = line.partition("=")
            if k.strip() == key:
                return v.strip()
    return os.environ.get(key, "").strip()


def find_existing(drive, folder_id: str, name: str):
    safe = name.replace("'", "\\'")
    resp = drive.files().list(
        q=f"name = '{safe}' and '{folder_id}' in parents and trashed = false",
        fields="files(id, name)",
        pageSize=1,
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute()
    files = resp.get("files", [])
    return files[0]["id"] if files else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local-dir", default=str(DEFAULT_LOCAL_DIR))
    ap.add_argument("--folder-id", default=load_env("google_driver_root_id"))
    ap.add_argument("--pattern", default="*.csv")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.folder_id:
        raise SystemExit("No folder id. Set google_driver_root_id in .env or pass --folder-id.")

    drive = build("drive", "v3", credentials=get_credentials())

    local_dir = Path(args.local_dir)
    files = sorted(local_dir.glob(args.pattern))
    if not files:
        print(f"No files matching {args.pattern} in {local_dir}")
        return

    created = updated = 0
    for path in files:
        existing_id = find_existing(drive, args.folder_id, path.name)
        action = "update" if existing_id else "create"
        print(f"  {action}: {path.name}")
        if args.dry_run:
            continue
        mimetype = mimetypes.guess_type(path.name)[0] or "text/csv"
        media = MediaFileUpload(str(path), mimetype=mimetype, resumable=False)
        if existing_id:
            drive.files().update(fileId=existing_id, media_body=media, supportsAllDrives=True).execute()
            updated += 1
        else:
            drive.files().create(
                body={"name": path.name, "parents": [args.folder_id]},
                media_body=media,
                fields="id",
                supportsAllDrives=True,
            ).execute()
            created += 1

    if args.dry_run:
        print(f"Dry run: {len(files)} files would be mirrored.")
    else:
        print(f"Mirrored {len(files)} files (created {created}, updated {updated}) to folder {args.folder_id}.")


if __name__ == "__main__":
    main()
