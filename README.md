# MS-CHRN Cashback Tracker

This repo includes a Google Apps Script setup focused on:

- A mirror sheet of YNAB export-style transaction data
- Safe YNAB API syncing (on-demand and scheduled)
- Cashback calculation with standard rate rules plus per-transaction overrides
- Separate views for MS, MS-Crypto, Bill Pay, and Bank Bonus

## What was discovered from your current export

Using your YNAB export (`Selected Transactions for Christopher's Budget as of 2026-10-04 08-53.csv`):

- Rows: ~68,520
- Most relevant tracked accounts found:
  - FLUZ
  - TKP - 7840 - P1
  - TKB - 0523 - P1
  - BLUPE
  - TKB - 5427 - P2
  - TKP - 7226 - P2
- Crypto-like rows by keyword (payee/category/memo): ~17,525
- Bill-pay-like rows by keyword: ~3,599
- Transfer counterparties are broad (185 unique), so account-type-based routing is important.

## Added files

- `gas/Code.gs`
  - Maintains a YNAB-export-like mirror sheet in `YNAB_Mirror`.
  - Supports seed import from `YNAB_CSV_Seed`.
  - Syncs from YNAB API with server knowledge for incremental updates.
  - Includes cooldown + retry logic to reduce rate-limit risk.
  - Builds `Cashback_Ledger` with standard rates and manual overrides.
  - Drives formula-based views (`MS`, `MS-Crypto`, `Bill Pay`, `Bank Bonus`).
- `gas/appsscript.json`
  - Basic Apps Script manifest.
- `scripts/profile_ynab_export.py`
  - Local profiler for large YNAB export CSVs.

## Workbook design

The script manages these sheets:

- `Summary`
- `MS`
- `MS-Crypto`
- `Bill Pay`
- `Bank Bonus`
- `YNAB_Mirror`
- `YNAB_Accounts`
- `Config`
- `Cashback_Rates`
- `Cashback_Overrides`
- `Cashback_Ledger`
- `YNAB_CSV_Seed`
- `Taekus_Raw`
- `BLUPE_Raw`
- `Fluz_Raw`
- `ALT_Raw`

### Data flow

1. Paste initial YNAB CSV export into `YNAB_CSV_Seed` and run `seedMirrorFromSeedSheet()`.
2. `syncYnabMirrorOnDemand()` or `syncYnabMirrorScheduled()` updates `YNAB_Mirror` from YNAB API.
3. Sync uses YNAB `server_knowledge` for incremental updates, avoiding full reloads each run.
4. `rebuildCashbackLedger()` classifies route buckets and computes cashback rates/amounts.
5. View sheets use formulas against `Cashback_Ledger`.
6. `Summary` shows bucket totals and sync metadata.

## Setup steps

1. In Google Sheets workbook `MS-CHRN`, open Apps Script.
2. Copy code from `gas/Code.gs`.
3. In Apps Script project settings, add script properties:
   - `YNAB_TOKEN`
   - `YNAB_BUDGET_ID`
4. Run `setupWorkbook()` once.
5. Paste your YNAB CSV export into `YNAB_CSV_Seed` and run `seedMirrorFromSeedSheet()`.
6. Run `syncYnabMirrorOnDemand()` for first API sync.
7. Optionally run `installDailyTrigger()` for daily scheduled sync.

## API sync modes and rate-limit safety

- On demand: `syncYnabMirrorOnDemand()`
- Scheduled: `syncYnabMirrorScheduled()`
- Force full refresh: `syncYnabMirrorForceFull()`

Rate-limit protections built in:

- Cooldown check (`Config` -> `sync_min_minutes`, default 20)
- Incremental sync via YNAB `last_knowledge_of_server`
- Retry/backoff for `429` and transient `5xx`
- Script lock to prevent concurrent overlap

## Cashback rates and overrides

Cashback is computed in `Cashback_Ledger` with this precedence:

1. `Cashback_Overrides` by `txn_id`
2. Inline YNAB rate (if memo/payee/category has a percent like `1.5%`)
3. Provider raw sheets when `txn_id` and rate are provided
4. `Cashback_Rates` rule match

Use `Cashback_Overrides` for transactions where rate varies and needs manual correction.

## How route classification works

- `MS`:
  - Internal transfer
  - Source account matches tracked list in `Config`
  - Source and destination account types are depository-like (`checking`, `savings`, `cash`)
  - Outflow side only to avoid duplicate transfer sides
- `MS_CRYPTO`:
  - Crypto keyword match in payee/memo/category/account context
  - Outflow side only
- `BILL_PAY`:
  - Source or destination account type is debt-like (`creditCard`, `lineOfCredit`, `otherDebt`, `mortgage`) OR bill-pay keywords
  - Outflow side only
- `BANK_BONUS`:
  - Inflow > 0 and bonus keyword in payee/memo/category

## Recommended YNAB cleanup (important)

For cleaner sheet routing and less manual correction:

1. Standardize crypto categories/payees
   - Ensure Coinbase/Robinhood/etc are consistently categorized as transfer/investment based on your intended rule.
2. Standardize bill pay transfer names
   - Make credit-card/loan transfer targets consistently named.
3. Add memo tags for cashback source where possible
   - Suggested tags: `cb:fluz`, `cb:blupe`, `cb:taekus`, `cb:bankbonus`.
4. Review `OTHER` bucket weekly
  - Add/adjust `Cashback_Rates` rules and YNAB categorization where needed.

## Secondary CSV sources

The project can use those files for enrichment, but they are not directly readable by Apps Script from your local machine.

Practical options:

- Paste exports into `Taekus_Raw`, `BLUPE_Raw`, `Fluz_Raw`, `ALT_Raw`.
- Add `txn_id` and rate columns when available to auto-apply provider rates.
- Keep using `scripts/profile_ynab_export.py` for local analysis and cleanup suggestions.

## Local profiling usage

```bash
cd /home/cmarty_pantz/ms-chrn
. .venv/bin/activate
python scripts/profile_ynab_export.py "transaction_csv_files/Selected Transactions for Christopher's Budget as of 2026-10-04 08-53.csv"
```
