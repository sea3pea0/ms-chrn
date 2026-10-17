"""Replace the lumped $508.53 GEICO entry (TKP 7840, 2025-04-21) with its 390 Taekus charges.

Reads logs/geico_split_plan.json (lump) and logs/geico_left_charges.json (charges) from
scripts/geico_plan.py. Creates one YNAB transaction per charge (one POST at a time: this
budget rejects bulk creates; no import_id, which would get merged into existing entries),
logging created ids to logs/geico_split_done.json so a rerun resumes. Only after every
charge exists and the total equals the lump does it delete the lump. Backup of the lump:
logs/geico_split_lump_backup.json.
"""
import json
import os
import sys
import time

import requests

sys.path.insert(0, "scripts")
from ynab_common import YNAB_BASE, load_env

env = load_env()
BASE = f"{YNAB_BASE}/budgets/{env['YNAB_BUDGET_ID']}"
H = {"Authorization": "Bearer " + env["YNAB_TOKEN"]}
DONE = "logs/geico_split_done.json"

lump = json.load(open("logs/geico_split_plan.json"))["unexplained"][0]
charges = json.load(open("logs/geico_left_charges.json"))
assert lump["cents"] == 50853 and lump["last4"] == "7840", lump
assert sum(c["cents"] for c in charges) == lump["cents"], "charges do not add up to the lump"
json.dump(lump, open("logs/geico_split_lump_backup.json", "w"), indent=1)

done = json.load(open(DONE)) if os.path.exists(DONE) else {}


def call(method, path, body=None):
    for attempt in range(8):
        r = requests.request(method, BASE + path, headers=H, json=body, timeout=60)
        if r.status_code == 429:
            print("rate limited; sleeping 5 min", flush=True)
            time.sleep(300)
            continue
        if r.status_code >= 500:
            time.sleep(10 * (attempt + 1))
            continue
        return r
    raise SystemExit(f"{method} {path} kept failing: {r.status_code} {r.text}")


for n, c in enumerate(charges):
    key = f"{c['ts']}|{c['cents']}|{n}"
    if key in done:
        continue
    t = {
        "account_id": lump["account_id"], "date": c["iso"], "amount": -c["cents"] * 10,
        "payee_id": lump["payee_id"], "category_id": lump["category_id"],
        "memo": f"Taekus {c['ts']}", "cleared": lump["cleared"], "approved": True,
    }
    r = call("post", "/transactions", {"transaction": t})
    if r.status_code >= 300:
        raise SystemExit(f"create failed after {len(done)}: {r.status_code} {r.text}")
    done[key] = r.json()["data"]["transaction"]["id"]
    json.dump(done, open(DONE, "w"))
    if len(done) % 25 == 0:
        print(f"created {len(done)}/{len(charges)}", flush=True)

assert len(done) == len(charges), (len(done), len(charges))
# verify the created transactions before removing the lump
r = call("get", f"/accounts/{lump['account_id']}/transactions?since_date=2025-04-01")
live = {t["id"]: t for t in r.json()["data"]["transactions"] if not t["deleted"]}
missing = [tid for tid in done.values() if tid not in live]
assert not missing, f"{len(missing)} created transactions not found"
total = sum(-live[tid]["amount"] for tid in done.values())
assert total == lump["cents"] * 10, (total, lump["cents"] * 10)
r = call("get", f"/transactions/{lump['id']}")
if not r.json()["data"]["transaction"]["deleted"]:
    r = call("delete", f"/transactions/{lump['id']}")
    if r.status_code >= 300:
        raise SystemExit(f"lump delete failed: {r.status_code} {r.text}")
print(f"done: {len(done)} charges created (${total / 1000:.2f}), lump {lump['id']} deleted", flush=True)
