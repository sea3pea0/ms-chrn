# MS-CHRN Transfer Profit Tracker

Google Sheet **MS-CHRN** (Drive: Churning & MS) driven by the Apps Script files in `gas/`, plus Python helpers in
`scripts/` that run on pea-docker.

## Sheets

| Sheet | What it is |
|---|---|
| Summary | Profit per bucket (MS, MS-Crypto, Bill Pay) and sync info |
| MS / MS-Crypto / Bill Pay | Totals, monthly table and every transfer in that bucket (views of Transfer_Ledger) |
| Targets | Pick a target in B1: money in / out / cash back all time, by year, by month, with charts |
| Transfer_Ledger | One row per tracked outflow: bucket, points, fee, profit, target group (script-written) |
| Transfer_Overrides | Manual fixes by YNAB txn id: bucket and/or points |
| Target_Stats | Per-target totals behind the Targets sheet (script-written) |
| Taekus_Raw | Taekus ALT debit CSV rows from Drive (script-written) |
| YNAB | YNAB API mirror, about the last 12 months (script-written) |
| YNAB_History | Full YNAB CSV export, used for anything older than the mirror (script-written) |
| YNAB_Accounts | YNAB accounts and types (script-written) |
| Config | Point value, matching window, classification regexes, target aliases |

## How it works

1. `syncYnabMirrorScheduled()` (hourly trigger) pulls changed YNAB transactions into `YNAB`, with category
   groups and split fees, then runs the steps below.
2. `importYnabHistory()` loads the newest export in Drive **Churning & MS > YNAB Transaction CSVs** into
   `YNAB_History` when a newer file appears. Split lines are merged back into one transaction and fee lines
   (category/payee containing "fee") become `split_fee`.
3. `importTaekusCsvs()` reads every ALT debit export in **Churning & MS > Taekus Transaction CSVs** into
   `Taekus_Raw` (deduped; newest file wins). The account comes from the last 4 digits in the file name, e.g.
   `...ALT Business Debit-0523.csv` -> YNAB `TKB - 0523 - P1`.
4. `rebuildTransferLedger()` matches each YNAB outflow from a Taekus account to its Taekus row by account,
   exact amount and date (-7..+10 days), classifies it and writes `Transfer_Ledger`.
   Profit = points x `Config` taekus/point_value (0.01) - split fee.
   - `BILL_PAY`: transfer to a credit card account, or a bill-pay descriptor
   - `MS_CRYPTO`: Coinbase, Uphold, PYUSD, Robinhood, etc., or a Taekus -> PayPal transfer followed by a PayPal
     crypto buy
   - `MS`: YNAB category group `Transfer` (e.g. Transfer: Lemfi), another account, or a money transmitter
   - `INTERNAL` (Taekus to Taekus), `OTHER` (purchases) and `REVIEW` (Taekus row with no YNAB transaction)
     stay out of the views.
5. `rebuildTargetStats()` writes `Target_Stats`: money in / out from every YNAB account (category
   `Transfer: X`, payee/category alias, or a transfer into the target's accounts) and cash back from the
   ledger. Targets are grouped by `Config` `target_aliases` (first match wins; unmatched targets such as
   credit cards keep their own name).

Fixes: put a YNAB txn id in `Transfer_Overrides` with a bucket and/or points. Patterns are editable in
`Config` under `transfer_rules` and `target_aliases`.

## Setup

1. Script properties: `YNAB_TOKEN`, `YNAB_BUDGET_ID`.
2. Deploy from pea-docker: `.venv/bin/python scripts/push_gas.py` (user OAuth; the Apps Script API can't run
   functions with this token).
3. Run `setupTransferProfit()` once from the Apps Script editor. It installs the hourly trigger, refreshes the
   YNAB mirror in full, imports history and Taekus CSVs, builds every sheet and orders them.

`gas/FluzSync.gs`, `gas/BlupeSync.gs` and `gas/FluzImport.gs` are the Fluz / Blue Penguin CSV -> YNAB
importers (they write to YNAB, not to the workbook); `installCsvSyncTriggers()` schedules them. The same jobs
also run as Python cron scripts on pea-docker (`scripts/fluz_sync.py`, `scripts/blupe_sync.py`).

## Taekus -> YNAB reconciliation

The Taekus bank connection in YNAB drops transactions now and then. `scripts/taekus_sync.py` (cron hourly at :37
on pea-docker, log `logs/taekus_sync.log`) reads the same Drive folder as the tracker, matches every settled
Taekus row from 2026 on to its YNAB account (same signed amount, date order, -7..+30 days), and for rows since
2026-09-25 that are at least 3 days old with no YNAB transaction, creates one: cleared, unapproved, memo
`Taekus <timestamp>`, with payee and category (or transfer account) copied from the last matched row with the
same description and card. Run it without `--apply` for a dry run.
