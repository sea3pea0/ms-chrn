/**
 * Fluz -> YNAB importer (Google Apps Script).
 *
 * Reads a Fluz transactions CSV from Google Drive and creates matching YNAB
 * transactions in the FLUZ account. Safe to re-run: every created transaction
 * carries a stable import_id, so YNAB skips ones already imported.
 *
 * Per source row we emit up to three YNAB transactions:
 *   - principal (the Fluz "Amount"; transfer when the counter account matches a
 *     YNAB account, otherwise a plain payee)
 *   - cashback  (the Fluz "Cashback", when it is additional to the principal)
 *   - fee       (the Fluz "Fee", when present)
 *
 * All imports are left unapproved for review.
 *
 * Setup: Script Properties YNAB_TOKEN and YNAB_BUDGET_ID must be set (shared
 * with Code.gs). Upload the Fluz CSV to Drive; the newest file whose name
 * contains FLUZ_CFG.driveFileNameContains is used.
 */

const FLUZ_CFG = {
  driveFileNameContains: 'fluz_all_transactions',
  // transaction_csv_files mirror folder in Drive (not secret). Script property
  // DRIVE_ROOT_ID overrides this if set.
  driveFolderId: '1p4CvErK2I2FiUokUFQO8Pe-fr6LldLUh',
  ynabAccountName: 'FLUZ',
  cashbackPayee: 'Fluz Cashback',
  feePayee: 'Fluz Fee',
  rewardsPayee: 'Fluz Rewards',
  // Types whose money movement we push to YNAB.
  importTypes: new Set([
    'Virtual Card Purchase',
    'Gift Card Purchase',
    'Virtual Card Return',
    'Add Money',
    'Add Money Pending Settled',
    'Withdrawal',
    'Referral Royalties',
    'Rewards Bonus'
  ]),
  // Types where Cashback is additional to Amount (emit a separate cashback line).
  separateCashbackTypes: new Set([
    'Virtual Card Purchase',
    'Gift Card Purchase',
    'Virtual Card Return'
  ]),
  // Types where Amount already equals the reward (no separate cashback line).
  rewardTypes: new Set(['Referral Royalties', 'Rewards Bonus']),
  // Fluz 'Created At' can be a day off the YNAB-recorded date; match boundary
  // rows within this many days so they are not re-imported.
  boundaryToleranceDays: 3
};


function addDaysIso_(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

/** Entry point: run this from the Apps Script editor. */
function importFluzToYnab() {
  const prep = prepareFluzImport_();
  if (!prep.txns.length) {
    Logger.log(`No new Fluz transactions to import (high-water date ${prep.highWater || 'none'}).`);
    return;
  }
  const created = postYnabTransactions_(prep.token, prep.budgetId, prep.txns);
  Logger.log(`High-water ${prep.highWater}; prepared ${prep.txns.length} transactions; YNAB created ${created} new (import_id dedup).`);
}

/**
 * Safe dry run: fetches live YNAB, computes exactly what WOULD be imported, and
 * logs it. Writes nothing. Run this first to verify before importFluzToYnab().
 */
function previewFluzImport() {
  const prep = prepareFluzImport_();
  Logger.log(`High-water date: ${prep.highWater || 'none'}`);
  Logger.log(`Would create ${prep.txns.length} YNAB transactions (none written):`);
  prep.txns.forEach((t) => {
    const dollars = (t.amount / 1000).toFixed(2);
    const dest = t.payee_id ? '[transfer]' : (t.payee_name || '');
    Logger.log(`  ${t.date}  ${dollars.padStart(12)}  ${t.import_id}  ${dest} | ${t.memo || ''}`);
  });
}

/** Shared setup used by both the preview and the real import. */
function prepareFluzImport_() {
  const token = getScriptProperty_('YNAB_TOKEN');
  const budgetId = getScriptProperty_('YNAB_BUDGET_ID');

  const accounts = fetchYnabAccountsFull_(token, budgetId);
  const fluzAccount = findYnabAccountByName_(accounts, FLUZ_CFG.ynabAccountName);
  if (!fluzAccount) throw new Error(`YNAB account "${FLUZ_CFG.ynabAccountName}" not found.`);

  // High-water-mark dedup: only import rows newer than what YNAB already has.
  const existing = fetchFluzExisting_(token, budgetId, fluzAccount.id);
  const rows = readFluzCsvFromDrive_();
  const txns = buildFluzYnabTransactions_(rows, accounts, fluzAccount, existing);
  return { token: token, budgetId: budgetId, txns: txns, highWater: existing.highWater };
}

/**
 * Fetch existing FLUZ transactions and summarize for dedup:
 *  - highWater: latest Fluz-originated transaction date (YYYY-MM-DD)
 *  - boundary:  multiset of milliamount counts on the high-water date
 *
 * Only Fluz-originated rows define the high-water: non-transfers (gift cards,
 * referrals, fees) or rows this importer created (FZ: import_id). Transfer
 * counterparts entered from the OTHER account (bank/Apple-Cash side of Add
 * Money/Withdrawal/VCP) carry later dates and would push the mark too high.
 */
function fetchFluzExisting_(token, budgetId, accountId) {
  const url = `${CFG.ynabBaseUrl}/budgets/${budgetId}/accounts/${accountId}/transactions`;
  const data = ynabGetWithBackoff_(url, token);
  const txns = data.transactions || [];
  const fluzOriginated = (t) => !t.transfer_account_id || (t.import_id && t.import_id.indexOf('FZ:') === 0);

  let highWater = '';
  txns.forEach((t) => {
    if (t.deleted || !fluzOriginated(t)) return;
    if (t.date > highWater) highWater = t.date;
  });
  // Boundary amounts: Fluz-originated rows within the tolerance window ending at
  // the high-water date, so date-skewed rows match by amount instead of leaking.
  const boundaryStart = highWater ? addDaysIso_(highWater, -FLUZ_CFG.boundaryToleranceDays) : '';
  const boundary = {};
  txns.forEach((t) => {
    if (t.deleted || !fluzOriginated(t) || t.date < boundaryStart) return;
    boundary[t.amount] = (boundary[t.amount] || 0) + 1;
  });
  return { highWater: highWater, boundary: boundary };
}

/** Fetch accounts including transfer_payee_id (needed to create transfers). */
function fetchYnabAccountsFull_(token, budgetId) {
  const url = `${CFG.ynabBaseUrl}/budgets/${budgetId}/accounts`;
  const data = ynabGetWithBackoff_(url, token);
  return (data.accounts || [])
    .filter((a) => !a.closed && !a.deleted)
    .map((a) => ({
      id: a.id,
      name: a.name,
      transferPayeeId: a.transfer_payee_id,
      key: normalizeAccountKey_(a.name)
    }));
}

function findYnabAccountByName_(accounts, name) {
  const target = String(name).trim().toLowerCase();
  return accounts.find((a) => a.name.trim().toLowerCase() === target) || null;
}

/** Reduce an account name to alphanumerics for substring matching. */
function normalizeAccountKey_(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Find the newest Fluz CSV in the mirror folder and parse it into row objects. */
function readFluzCsvFromDrive_() {
  const folderId = PropertiesService.getScriptProperties().getProperty('DRIVE_ROOT_ID') || FLUZ_CFG.driveFolderId;
  const files = DriveApp.getFolderById(folderId).getFiles();
  let newest = null;
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().toLowerCase().indexOf(FLUZ_CFG.driveFileNameContains) === -1) continue;
    if (!newest || f.getLastUpdated() > newest.getLastUpdated()) newest = f;
  }
  if (!newest) throw new Error(`No file containing "${FLUZ_CFG.driveFileNameContains}" in folder ${folderId}.`);

  const csv = newest.getBlob().getDataAsString('UTF-8');
  const table = Utilities.parseCsv(csv);
  if (table.length < 2) return [];
  const header = table[0].map((h) => String(h).trim());
  return table.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

function buildFluzYnabTransactions_(rows, accounts, fluzAccount, existing) {
  const highWater = (existing && existing.highWater) || '';
  const boundary = Object.assign({}, (existing && existing.boundary) || {});
  const out = [];
  // Oldest-first so boundary-day occurrence matching is stable.
  const sorted = rows.slice().filter((r) => parseFluzDate_(r['Created At'])).sort(
    (a, b) => parseFluzDate_(a['Created At']) < parseFluzDate_(b['Created At']) ? -1 : 1
  );
  sorted.forEach((r) => {
    const type = String(r.Type || '').trim();
    if (!FLUZ_CFG.importTypes.has(type)) return;

    const amount = toNumber_(r.Amount);
    const cashback = toNumber_(r.Cashback);
    const fee = toNumber_(r.Fee);
    const date = parseFluzDate_(r['Created At']);
    if (!date) return;

    const principalMilli = Math.round(amount * 1000);

    // High-water-mark dedup at the row level, keyed on the principal.
    if (highWater) {
      if (date <= highWater) return; // already imported
      // Within the tolerance window, skip rows that match a boundary amount
      // (handles Fluz 'Created At' being a day or two after the YNAB date).
      if (date <= addDaysIso_(highWater, FLUZ_CFG.boundaryToleranceDays) && boundary[principalMilli] > 0) {
        boundary[principalMilli] -= 1;
        return;
      }
    }

    const cleared = String(r.Status || '').toUpperCase() === 'SETTLED' ? 'cleared' : 'uncleared';
    const ref = String(r['Reference ID'] || r['Transaction ID'] || '').trim();
    if (!ref) return;
    // Transaction ID (UUID) is unique per row; Reference IDs are shared by a
    // purchase and its return, so use the UUID for import_id uniqueness.
    const uniqueKey = String(r['Transaction ID'] || ref).trim();
    const descr = cleanFluzText_(r.Description);
    const note = cleanFluzText_(r.Note);
    // Merchant label for memos: Description when present, else Destination.
    const merchant = descr || cleanFluzText_(r.Destination) || type;

    // Counter party: destination on outflows, source on inflows.
    const counterRaw = amount < 0 ? r.Destination : r.Source;
    const counter = matchCounterAccount_(counterRaw, accounts, fluzAccount);

    // 1) Principal. Memo mirrors existing YNAB convention: "<ref> - <type>".
    if (principalMilli !== 0) {
      let memo = `${ref} - ${type}`;
      if (note) memo += ` - ${note}`;
      const base = {
        account_id: fluzAccount.id,
        date: date,
        amount: principalMilli,
        memo: truncate_(memo, 200),
        cleared: cleared,
        approved: false,
        import_id: fluzImportId_(uniqueKey, 'P')
      };
      if (counter) {
        base.payee_id = counter.transferPayeeId;
      } else {
        base.payee_name = truncate_(cleanFluzText_(counterRaw) || `Fluz ${type}`, 50);
      }
      out.push(base);
    }

    // 2) Cashback (only when additional to the principal).
    if (FLUZ_CFG.separateCashbackTypes.has(type) && Math.round(cashback * 1000) !== 0) {
      out.push({
        account_id: fluzAccount.id,
        date: date,
        amount: Math.round(cashback * 1000),
        payee_name: FLUZ_CFG.cashbackPayee,
        memo: truncate_(`${ref} - Cashback for ${merchant}`, 200),
        cleared: cleared,
        approved: false,
        import_id: fluzImportId_(uniqueKey, 'C')
      });
    }

    // 3) Fee (a cost -> outflow).
    if (Math.round(fee * 1000) !== 0) {
      out.push({
        account_id: fluzAccount.id,
        date: date,
        amount: -Math.abs(Math.round(fee * 1000)),
        payee_name: FLUZ_CFG.feePayee,
        memo: truncate_(`${ref} - Fee for ${merchant}`, 200),
        cleared: cleared,
        approved: false,
        import_id: fluzImportId_(uniqueKey, 'F')
      });
    }
  });
  return out;
}

/** Try to map a Fluz source/destination string to a YNAB account for transfers. */
function matchCounterAccount_(raw, accounts, fluzAccount) {
  const key = normalizeAccountKey_(raw);
  if (!key) return null;
  let best = null;
  accounts.forEach((a) => {
    if (a.id === fluzAccount.id || !a.transferPayeeId || !a.key) return;
    if (key.indexOf(a.key) !== -1) {
      if (!best || a.key.length > best.key.length) best = a; // prefer the most specific match
    }
  });
  return best;
}

function parseFluzDate_(s) {
  if (!s) return null;
  const d = new Date(String(s));
  if (isNaN(d.getTime())) return null;
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function cleanFluzText_(s) {
  const v = String(s == null ? '' : s).trim();
  return v === '--' ? '' : v;
}

/**
 * Stable, unique import_id (<= 36 chars). Keyed on the Fluz Transaction ID
 * (a UUID) because Reference IDs are shared between a purchase and its return.
 */
function fluzImportId_(uniqueKey, component) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(uniqueKey));
  let hex = '';
  for (let i = 0; i < 6; i += 1) {
    hex += ('0' + ((bytes[i] + 256) % 256).toString(16)).slice(-2);
  }
  return 'FZ:' + hex + ':' + component;
}

function truncate_(s, n) {
  const v = String(s == null ? '' : s);
  return v.length > n ? v.slice(0, n) : v;
}

function postYnabTransactions_(token, budgetId, transactions) {
  const url = `${CFG.ynabBaseUrl}/budgets/${budgetId}/transactions`;
  let createdTotal = 0;
  // YNAB accepts bulk arrays; chunk to stay well within request limits.
  const chunkSize = 200;
  for (let i = 0; i < transactions.length; i += chunkSize) {
    const chunk = transactions.slice(i, i + chunkSize);
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${token}` },
      payload: JSON.stringify({ transactions: chunk }),
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    if (code >= 300) {
      throw new Error(`YNAB bulk create failed ${code}: ${response.getContentText()}`);
    }
    const data = JSON.parse(response.getContentText()).data;
    createdTotal += (data.transaction_ids || []).length;
  }
  return createdTotal;
}
