"""Plan: replace lumped Geico YNAB transactions with the individual Taekus charges.

Writes logs/geico_split_plan.json; changes nothing in YNAB.
"""
import datetime as dt
import json
import re
import sys
from collections import defaultdict

sys.path.insert(0, "scripts")
from ynab_common import Ynab, load_env, drive_csvs, read_csv_text

env = load_env()
y = Ynab(env["YNAB_TOKEN"], env["YNAB_BUDGET_ID"])
GEICO = re.compile(r"geico", re.I)

accounts = {a["id"]: a for a in y.get("/accounts")["accounts"]}
tk = {}
for a in accounts.values():
    m = re.match(r"^TK[BP]\s*-\s*(\d{4})", a["name"])
    if m and not a["deleted"]:
        tk[m.group(1)] = a

# Taekus CSV rows, deduped like TransferProfit.gs (account + timestamp + amount).
csv_rows = {}
for name, text in drive_csvs("Taekus Transaction CSVs"):
    m = re.search(r"(\d{4})\.csv$", name, re.I)
    if not m:
        continue
    recs = read_csv_text(text)
    if not recs or "transaction amount" not in recs[0]:
        continue
    seen = defaultdict(int)
    for r in recs:
        dm = re.match(r"(\d{2})/(\d{2})/(\d{4})", r["date"])
        if not dm:
            continue
        amt = float(r["transaction amount"] or 0)
        base = (m.group(1), r["date"].strip(), round(amt * 100))
        seen[base] += 1
        key = base + (seen[base],)
        pts = float(r["points credited"] or 0)
        old = csv_rows.get(key)
        csv_rows[key] = {
            "last4": m.group(1), "ts": r["date"].strip(), "iso": f"{dm.group(3)}-{dm.group(1)}-{dm.group(2)}",
            "cents": -round(amt * 100), "desc": r["description"], "points": max(pts, old["points"] if old else 0),
        }
csv_g = [c for c in csv_rows.values() if c["cents"] > 0 and GEICO.search(c["desc"]) and c["last4"] in tk]

ynab_g = []
for l4, a in tk.items():
    for t in y.get(f"/accounts/{a['id']}/transactions?since_date=2024-01-01")["transactions"]:
        if t["deleted"] or t["amount"] >= 0:
            continue
        if not GEICO.search((t.get("payee_name") or "") + " " + (t.get("category_name") or "")):
            continue
        ynab_g.append({"id": t["id"], "last4": l4, "iso": t["date"], "cents": -t["amount"] // 10,
                       "payee": t.get("payee_name"), "payee_id": t.get("payee_id"), "category_id": t.get("category_id"),
                       "category": t.get("category_name"), "memo": t.get("memo"), "cleared": t["cleared"],
                       "approved": t["approved"], "flag_color": t.get("flag_color"),
                       "split": bool(t.get("subtransactions")), "account_id": a["id"]})

days = lambda iso: dt.date.fromisoformat(iso).toordinal()

# 1) individual matches (same account + amount, date -7..+10, date order)
used_c, used_y = set(), set()
groups = defaultdict(lambda: ([], []))
for i, t in enumerate(ynab_g):
    groups[(t["last4"], t["cents"])][0].append(i)
for j, c in enumerate(csv_g):
    groups[(c["last4"], c["cents"])][1].append(j)
for ys, cs in groups.values():
    ys.sort(key=lambda i: ynab_g[i]["iso"])
    cs.sort(key=lambda j: csv_g[j]["iso"])
    p = 0
    for j in cs:
        cd = days(csv_g[j]["iso"])
        while p < len(ys) and (ys[p] in used_y or days(ynab_g[ys[p]]["iso"]) - cd < -7):
            p += 1
        for q in range(p, len(ys)):
            i = ys[q]
            if i in used_y:
                continue
            if days(ynab_g[i]["iso"]) - cd > 10:
                break
            used_y.add(i)
            used_c.add(j)
            break

left_y = sorted([t for i, t in enumerate(ynab_g) if i not in used_y], key=lambda t: (t["last4"], t["iso"]))
left_c = sorted([c for j, c in enumerate(csv_g) if j not in used_c], key=lambda c: (c["last4"], c["iso"], c["ts"]))

# 2) explain each leftover YNAB entry as a run of leftover Taekus charges (oldest first) summing to it
plan, unexplained = [], []
taken = set()
for t in left_y:
    pool = [k for k, c in enumerate(left_c) if k not in taken and c["last4"] == t["last4"]
            and -20 <= days(t["iso"]) - days(c["iso"]) <= 7]
    run, total = [], 0
    for k in pool:
        if total >= t["cents"]:
            break
        run.append(k)
        total += left_c[k]["cents"]
    if run and total == t["cents"] and len(run) > 1:
        taken.update(run)
        plan.append({"lump": t, "charges": [left_c[k] for k in run]})
    else:
        unexplained.append(t)

summary = {
    "taekus_geico": len(csv_g), "ynab_geico": len(ynab_g), "matched_1to1": len(used_y),
    "lumps_explained": len(plan), "charges_in_lumps": sum(len(p["charges"]) for p in plan),
    "ynab_unexplained": len(unexplained), "taekus_left": len(left_c) - len(taken),
}
print(json.dumps(summary, indent=1))
for p in plan[:8]:
    print(p["lump"]["iso"], p["lump"]["cents"] / 100, p["lump"]["cleared"], p["lump"]["category"], "<-",
          len(p["charges"]), p["charges"][0]["iso"], "..", p["charges"][-1]["iso"])
print("unexplained YNAB:", [(t["iso"], t["cents"] / 100, t["last4"]) for t in unexplained][:30])
print("left Taekus:", [(c["iso"], c["cents"] / 100) for k, c in enumerate(left_c) if k not in taken][:30])
print("cleared states:", defaultdict(int, {}).__class__(int))
cs = defaultdict(int)
for p in plan:
    cs[p["lump"]["cleared"]] += 1
print(dict(cs), "splits:", sum(p["lump"]["split"] for p in plan))
json.dump({"summary": summary, "plan": plan, "unexplained": unexplained}, open("logs/geico_split_plan.json", "w"), indent=1)

rest = [c for k, c in enumerate(left_c) if k not in taken]
byday = defaultdict(lambda: [0, 0, 0])
for c in rest:
    byday[c["iso"]][0] += 1
    byday[c["iso"]][1] += c["cents"]
    byday[c["iso"]][2] += c["points"]
for d in sorted(byday):
    print(d, byday[d][0], byday[d][1] / 100, byday[d][2])
print("total", len(rest), sum(c["cents"] for c in rest) / 100, sum(c["points"] for c in rest))
json.dump(rest, open("logs/geico_left_charges.json", "w"), indent=1)
