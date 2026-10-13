#!/usr/bin/env python3
"""Push (and optionally deploy) the gas/ files to an Apps Script project via the
Apps Script API using USER OAuth.

Why user OAuth and not the service account: the Apps Script API does not work
with service accounts, so managing your own script project requires a one-time
user consent.

Prerequisites (one-time):
  1. Enable the Apps Script API: https://script.google.com/home/usersettings
  2. In Google Cloud Console, create an OAuth client (Desktop app) and download
     the JSON to credentials/gas-oauth.json.
  3. Put your project's scriptId in .env as gas_script_id=... (or pass --script-id).
     Find it in the Apps Script editor: Project Settings -> IDs -> Script ID.

Usage:
  python scripts/push_gas.py                 # push gas/ files
  python scripts/push_gas.py --deploy        # push, then version + deploy
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/script.projects",
    "https://www.googleapis.com/auth/script.deployments",
    "https://www.googleapis.com/auth/drive",
]

REPO = Path(__file__).resolve().parent.parent
GAS_DIR = REPO / "gas"
OAUTH_CLIENT = REPO / "credentials" / "gas-oauth.json"
TOKEN_PATH = REPO / "credentials" / "apps_script_token.json"


def load_env_script_id() -> str:
    env = REPO / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            key, _, value = line.partition("=")
            if key.strip().lower() == "gas_script_id":
                return value.strip()
    return os.environ.get("SCRIPT_ID", os.environ.get("gas_script_id", "")).strip()


def get_credentials() -> Credentials:
    creds = None
    if TOKEN_PATH.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    if creds and creds.valid:
        return creds
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_PATH.write_text(creds.to_json())
        return creds
    return authorize_manual()


def authorize_manual() -> Credentials:
    """One-time, portless consent: user approves in a browser, pastes the code.

    The registered redirect (http://localhost) will fail to load after approval,
    but the authorization code is visible in the browser address bar. No local
    server or port forwarding is required. The resulting refresh token is cached
    so every later run is fully non-interactive.
    """
    if not OAUTH_CLIENT.exists():
        raise SystemExit(f"Missing OAuth client file: {OAUTH_CLIENT}")
    flow = Flow.from_client_secrets_file(
        str(OAUTH_CLIENT), scopes=SCOPES, redirect_uri="http://localhost"
    )
    auth_url, _ = flow.authorization_url(access_type="offline", prompt="consent")
    print("Authorize in your browser:\n")
    print(auth_url + "\n")
    print("After approving, your browser will try to open http://localhost/?code=...")
    print("That page will not load — copy the 'code' value from the address bar.\n")
    raw = input("Paste the code (or the full redirect URL): ").strip()
    code = _extract_code(raw)
    flow.fetch_token(code=code)
    creds = flow.credentials
    TOKEN_PATH.write_text(creds.to_json())
    print("Token cached; future runs are non-interactive.")
    return creds


def _extract_code(raw: str) -> str:
    if raw.startswith("http"):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(raw).query)
        return qs.get("code", [""])[0]
    return raw


def build_files_payload() -> list:
    files = []
    for path in sorted(GAS_DIR.iterdir()):
        if path.name == "appsscript.json":
            files.append({"name": "appsscript", "type": "JSON", "source": path.read_text()})
        elif path.suffix == ".gs":
            files.append({"name": path.stem, "type": "SERVER_JS", "source": path.read_text()})
    # Apps Script requires the manifest to be present.
    if not any(f["name"] == "appsscript" for f in files):
        raise SystemExit("gas/appsscript.json manifest is required.")
    return files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--script-id", default=load_env_script_id())
    ap.add_argument("--deploy", action="store_true", help="Create a version and deployment after pushing.")
    ap.add_argument("--description", default="Automated push via push_gas.py")
    args = ap.parse_args()

    if not args.script_id:
        raise SystemExit("No scriptId. Set SCRIPT_ID in .env or pass --script-id.")

    service = build("script", "v1", credentials=get_credentials())
    files = build_files_payload()

    service.projects().updateContent(
        scriptId=args.script_id,
        body={"files": files},
    ).execute()
    print(f"Pushed {len(files)} files to script {args.script_id}:")
    for f in files:
        print(f"  {f['name']} ({f['type']})")

    if args.deploy:
        version = service.projects().versions().create(
            scriptId=args.script_id,
            body={"description": args.description},
        ).execute()
        version_number = version["versionNumber"]
        deployment = service.projects().deployments().create(
            scriptId=args.script_id,
            body={"versionNumber": version_number, "manifestFileName": "appsscript", "description": args.description},
        ).execute()
        print(f"Created version {version_number}; deployment {deployment.get('deploymentId')}")


if __name__ == "__main__":
    main()
