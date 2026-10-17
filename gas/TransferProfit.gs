/**
 * Transfer profit tracking (MS, MS-Crypto, Bill Pay).
 *
 * 1) importTaekusCsvs() reads every ALT debit export in the Drive folder
 *    "Taekus Transaction CSVs" into Taekus_Raw (deduped; newest file wins, so a
 *    later export updates points that were still 0). The account comes from the
 *    last 4 digits in the file name, e.g. "...ALT Business Debit-0523.csv".
 *    importFluzCsvs() does the same for the Fluz exports in "Fluz Transaction CSVs"
 *    (merged by Transaction ID) into Fluz_Raw.
 * 2) rebuildTransferLedger() matches each YNAB outflow from a Taekus account
 *    (TKB/TKP - NNNN) or FLUZ in the YNAB mirror to its Taekus / Fluz row (Fluz: by the
 *    reference ID in the memo first), by account, exact amount and date window,
 *    classifies it MS / MS_CRYPTO / BILL_PAY, and writes Transfer_Ledger with profit =
 *    Taekus points x Config taekus/point_value + Fluz cashback - fees.
 * 3) The MS, MS-Crypto and Bill Pay sheets are QUERY views of Transfer_Ledger.
 *
 * Per-transaction fixes go in Transfer_Overrides (YNAB txn_id -> bucket and/or
 * points). Classification patterns live in Config under transfer_rules.
 *
 * One-time setup: run setupTransferProfit() from the editor. It creates the
 * sheets, installs the hourly refresh trigger, catches the YNAB mirror up,
 * imports, and builds.
 */

const XFER_CFG = {
  taekusFolder: 'Taekus Transaction CSVs',
  fluzFolder: 'Fluz Transaction CSVs',
  blupeFolder: 'Blue Penguin Transaction CSVs',
  // coinbase_one_fees.csv, written daily by scripts/coinbase_fees.py on pea-docker (Coinbase API).
  coinbaseFeeFolder: 'Coinbase Fees',
  // Coinbase One paid from a bank account shows up in YNAB as a Coinbase charge in a subscription
  // category; refunds of it are the matching inflows.
  coinbaseOneRegex: { payee: 'coinbase', category: 'subscription|coinbase one' },
  sheets: {
    taekusRaw: 'Taekus_Raw',
    fluzRaw: 'Fluz_Raw',
    blupeRaw: 'BLUPE_Raw',
    blupeStatements: 'BLUPE_Statements',
    ledger: 'Transfer_Ledger',
    overrides: 'Transfer_Overrides'
  },
  taekusRawHeaders: [
    'key', 'account_last4', 'date', 'datetime', 'posted_date', 'description', 'merchant', 'mcc',
    'amount', 'points', 'uuid', 'mid', 'refund', 'settled', 'card_nickname', 'file'
  ],
  // Blue Penguin rebate statements (processing month = activity month; paid ~2 months later).
  // Used for months the settlement CSVs don't cover (account 126795, Sep 2024 - Jan 2025).
  // Every statement works out to ~69.7% of net interchange, hence interchange_share 0.697.
  blupeStatementHeaders: ['processing_month', 'customer_id', 'settlement', 'interchange', 'rebate', 'payout'],
  blupeStatementSeed: [
    // No statements for Jun - Aug 2024: rebate deposited into BLUPE two months later divided by
    // that month's BLUPE transfers in YNAB.
    ['2024-06', 'from deposit', 14016.31, '', 203.61, '2024-08-15'],
    ['2024-07', 'from deposit', 83183.45, '', 1370.28, '2024-09-17'],
    ['2024-08', 'from deposit', 340830.28, '', 6829.76, '2024-10-17'],
    ['2024-09', '126795', 433592.57, 12707.80, 8865.46, '2024-11-15'],
    ['2024-10', '126795', 273984.53, 8053.14, 5617.25, '2024-12-15'],
    ['2024-11', '126795', 162846.59, 4673.60, 3258.00, '2025-01-15'],
    ['2024-12', '126795', 81729.84, 2291.33, 1596.53, '2025-02-15'],
    ['2025-01', '126795', 53111.77, 1525.17, 1061.85, '2025-03-15'],
    ['2025-02', '128329', 101849.84, 2744.25, 1913.19, '2025-04-15'],
    ['2025-03', '128329', 176822.58, 4764.53, 3322.60, '2025-05-15'],
    ['2025-04', '128329', 109165.81, 2931.71, 2044.06, '2025-06-15'],
    ['2025-05', '128329', 91059.04, 2496.24, 1741.20, '2025-07-15'],
    ['2025-06', '128329', 113375.44, 3130.77, 2004.01, '2025-08-15'],
    ['2025-07', '128329', 27390.91, 750.50, 522.97, '2025-09-15'],
    ['2025-08', '128329', 36381.37, 1009.86, 703.81, '2025-10-15'],
    ['2025-09', '128329', 30764.84, 859.86, 599.45, '2025-11-15'],
    ['2025-10', '128329', 38127.85, 1060.56, 739.35, '2025-12-15'],
    ['2025-11', '128329', 29736.39, 814.89, 567.84, '2026-01-15'],
    ['2025-12', '128329', 5687.03, 152.82, 106.19, '2026-02-15'],
    ['2026-01', '128329', 13048.65, 369.87, 257.72, '2026-03-15'],
    ['2026-02', '128329', 9310.90, 260.76, 181.68, '2026-04-15'],
    ['2026-03', '128329', 10704.77, 307.17, 214.16, '2026-05-15'],
    ['2026-04', '128329', 13297.93, 385.16, 268.54, '2026-06-15'],
    ['2026-05', '128329', 6882.41, 191.21, 133.28, '2026-07-15'],
    ['2026-06', '128329', 5536.25, 147.01, 102.42, '2026-08-15'],
    ['2026-08', '128329', 2872.47, 76.22, 53.14, '2026-10-15']
  ],
  blupeRawHeaders: [
    'event_id', 'type', 'date', 'amount', 'interchange', 'effective_rate', 'description', 'category',
    'card_type', 'last4', 'file'
  ],
  fluzRawHeaders: [
    'transaction_id', 'reference_id', 'type', 'status', 'date', 'created_at', 'amount', 'destination',
    'source', 'cashback', 'cashback_rate', 'fee', 'description', 'card_name', 'category', 'file'
  ],
  // Fluz rows that are money leaving Fluz (purchases earn cashback; withdrawals go to your own bank).
  fluzTypes: ['Virtual Card Purchase', 'Gift Card Purchase', 'Withdrawal'],
  fluzSkipStatus: /fail|cancel|declin|revers|refund/i,
  ledgerHeaders: [
    'date', 'source', 'account', 'payee', 'target', 'target_type', 'amount', 'bucket',
    'points', 'point_value', 'profit', 'rate', 'match', 'csv_description', 'csv_date',
    'ynab_txn_id', 'memo', 'note', 'month', 'target_group', 'fee', 'cashback'
  ],
  overrideHeaders: ['ynab_txn_id', 'bucket', 'points', 'notes'],
  buckets: ['MS', 'MS_CRYPTO', 'BILL_PAY'],
  views: { MS: 'MS', MS_CRYPTO: 'MS-Crypto', BILL_PAY: 'Bill Pay' },
  configDefaults: {
    taekus: {
      point_value: '0.01',
      match_days_before: '7',
      match_days_after: '10',
      late_entry_days: '30',
      review_min_amount: '10'
    },
    fluz: {
      account_name: 'FLUZ'
    },
    blupe: {
      account_name: 'BLUPE',
      interchange_share: '0.697',
      rebate_payee_regex: 'blue penguin',
      other_account_rebate_payee_regex: '^BP (REBATE|PAYOUT)\\b',
      // Blue Penguin -> Robinhood: crypto until mid-2025, since then paying the Robinhood credit card.
      // A transfer counts as Bill Pay when a card payment follows within rh_pay_days (the payment is
      // the transfer plus the card's 3% cash back, so it can be a little bigger).
      rh_card_account_regex: '^RHCC\\b',
      rh_pay_days: '10',
      rh_pay_tolerance: '0.05',
      // Last Blue Penguin -> Robinhood crypto buy; every later one is Robinhood card Bill Pay.
      rh_crypto_end: '2025-06-10'
    },
    transfer_rules: {
      crypto_regex: 'coinbase|uphold|topper|usdc|pyusd|crypto|robinhood|transak|moonpay|phantom|meld|kraken|gemini|bitcoin',
      bill_pay_regex: 'citibank|\\bciti\\b|synchrony|syncb|credit card|card payment|cc payment|geico|americanexp|amex|barclaycard|discovercar|bankamerica',
      ms_regex: 'lemfi|wise|revolut|sling|morse|western union|skrill|onepay|metapay|moneylion|roarmoney|chime|current account|remitly|xoom|astra|honey ?fund|apple wallet|apple cash',
      paypal_account_regex: '^PP',
      internal_account_regex: '^TK[BP]\\b',
      transfer_category_group: 'Transfer',
      paypal_pair_days: '3',
      paypal_pair_tolerance: '0.05'
    },
    // Canonical transfer target -> regex over payee / account / Taekus description. First match wins;
    // anything unmatched keeps its own name (e.g. each credit card for Bill Pay).
    target_aliases: {
      PYUSD: 'pyusd|crypto hub|paypal \\*?crypto',
      Coinbase: 'coinbase',
      Uphold: 'uphold',
      Topper: 'topper',
      Robinhood: 'robinhood',
      LemFi: 'lemfi',
      MoneyLion: 'moneylion|money lion|roarmoney|ml spend|^MOLI\\b|transfer : MOLI\\b',
      Skrill: 'skrill|^SKRL\\b|transfer : SKRL\\b',
      Wise: '\\bwise\\b|^WSE[BP]\\b|transfer : WSE[BP]\\b',
      Revolut: 'revolut',
      Sling: 'sling|morse',
      'Western Union': 'western union|^wu\\b',
      Chime: 'chime|^CHME\\b|transfer : CHME\\b',
      Current: 'current account|^CURR\\b|transfer : CURR\\b',
      OnePay: 'onepay|^OPYD\\b|transfer : OPYD\\b',
      MetaPay: 'metapay',
      Astra: '\\bastra\\b',
      'Honey Fund': 'honey ?fund',
      'Apple Cash': 'apple wallet|apple cash|^APCA\\b|transfer : APCA\\b',
      Geico: 'geico',
      'American Express': 'americanexp|american express|\\bamex\\b',
      Barclaycard: 'barclaycard',
      Discover: 'discovercar|discover card',
      Fluz: '^FLUZ\\b|transfer : FLUZ\\b',
      PayPal: '^PP\\b|transfer : PP\\b|paypal'
    }
  },
  // Older sources with no per-transaction export: the reward deposited into the account (in YNAB) is
  // spread over that activity month's tracked transfers out of the same accounts. The activity month
  // comes from the payee ("Upgrade Cashback Rewards for July 2024") or is lagMonths before the deposit.
  depositSources: [
    { key: 'UPGRADE', accountRegex: '^UPG[DS]\\b', rewardRegex: 'upgrade cashback rewards for ([a-z]+ \\d{4})', lagMonths: 1 },
    { key: 'PRIMIS', accountRegex: '^PRMS\\b', rewardRegex: '^cashback rewards', lagMonths: 1 }
  ],
  triggerFn: 'syncYnabMirrorScheduled',
  triggerMinute: 32
};

// ---------------------------------------------------------------- setup / triggers

function setupTransferProfit() {
  ensureTransferSheets_();
  installTransferTrigger();
  // Full refresh so every mirror row has category groups and split fees.
  csvSyncLocked_('setupTransferProfit', () => pullYnabMirror_({ force: true, calledBy: 'setup' }));
  importYnabHistory(true);
  importTaekusCsvs();
  importFluzCsvs();
  importBlupeCsvs();
  rebuildTransferLedger();
  applyViewFormulas_();
  applySummaryFormulas_();
  setupTargetDashboard();
  arrangeSheets_();
}

/** Views first, then data sheets; anything else (unknown) stays at the end. */
function arrangeSheets_() {
  const ss = SpreadsheetApp.getActive();
  const order = [
    CFG.sheets.summary, CFG.sheets.ms, CFG.sheets.msCrypto, CFG.sheets.billPay, TARGET_CFG.dashSheet,
    XFER_CFG.sheets.ledger, XFER_CFG.sheets.overrides, TARGET_CFG.statsSheet, XFER_CFG.sheets.taekusRaw, XFER_CFG.sheets.fluzRaw,
    XFER_CFG.sheets.blupeRaw, XFER_CFG.sheets.blupeStatements,
    CFG.sheets.ynabMirror, YH_CFG.sheet, CFG.sheets.ynabAccounts, CFG.sheets.config
  ];
  let pos = 1;
  order.forEach((name) => {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(pos);
    pos += 1;
  });
  ss.setActiveSheet(ss.getSheetByName(CFG.sheets.summary));
}

/** Hourly YNAB mirror sync + Taekus import + ledger rebuild (replaces the daily trigger). */
function installTransferTrigger() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === XFER_CFG.triggerFn) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger(XFER_CFG.triggerFn).timeBased().everyHours(1).nearMinute(XFER_CFG.triggerMinute).create();
  console.log('Installed hourly trigger: ' + XFER_CFG.triggerFn);
}

function ensureTransferSheets_() {
  const ss = SpreadsheetApp.getActive();
  [XFER_CFG.sheets.taekusRaw, XFER_CFG.sheets.fluzRaw, XFER_CFG.sheets.blupeRaw,
    XFER_CFG.sheets.blupeStatements, XFER_CFG.sheets.ledger,
    XFER_CFG.sheets.overrides]
    .forEach((n) => ensureSheet_(ss, n));
  Object.values(XFER_CFG.views).forEach((n) => ensureSheet_(ss, n));
  const ov = ss.getSheetByName(XFER_CFG.sheets.overrides);
  if (ov.getLastRow() === 0) {
    ov.getRange(1, 1, 1, XFER_CFG.overrideHeaders.length).setValues([XFER_CFG.overrideHeaders]);
    ov.setFrozenRows(1);
  }
  const st = ss.getSheetByName(XFER_CFG.sheets.blupeStatements);
  if (st.getLastRow() === 0) {
    const h = XFER_CFG.blupeStatementHeaders;
    st.getRange(1, 1, 1, h.length).setValues([h]);
    st.getRange(2, 1, XFER_CFG.blupeStatementSeed.length, 1).setNumberFormat('@');
    st.getRange(2, 1, XFER_CFG.blupeStatementSeed.length, h.length).setValues(XFER_CFG.blupeStatementSeed);
    st.setFrozenRows(1);
  }
  ensureConfigDefaults_();
}

/** Append any missing Config rows from XFER_CFG.configDefaults (never overwrites). */
function ensureConfigDefaults_() {
  const sh = ensureSheet_(SpreadsheetApp.getActive(), CFG.sheets.config);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, 3).setValues([['section', 'key', 'value']]);
  const have = new Set(sh.getDataRange().getValues().map((r) => String(r[0]).trim() + '|' + String(r[1]).trim()));
  const add = [];
  Object.keys(XFER_CFG.configDefaults).forEach((section) => {
    const kv = XFER_CFG.configDefaults[section];
    Object.keys(kv).forEach((k) => {
      if (!have.has(section + '|' + k)) add.push([section, k, kv[k]]);
    });
  });
  if (add.length) {
    const rng = sh.getRange(sh.getLastRow() + 1, 1, add.length, 3);
    rng.setNumberFormat('@');
    rng.setValues(add);
  }
}

function xferConfig_() {
  const out = {};
  Object.keys(XFER_CFG.configDefaults).forEach((section) => {
    out[section] = Object.assign({}, XFER_CFG.configDefaults[section], readConfigKV_(section));
  });
  return out;
}

// ---------------------------------------------------------------- Taekus CSV import

function importTaekusCsvs() {
  ensureTransferSheets_();
  const rows = taekusRowsFromCsvs_(driveCsvs_(XFER_CFG.taekusFolder));
  const sh = SpreadsheetApp.getActive().getSheetByName(XFER_CFG.sheets.taekusRaw);
  sh.clearContents();
  sh.getRange(1, 1, 1, XFER_CFG.taekusRawHeaders.length).setValues([XFER_CFG.taekusRawHeaders]);
  sh.setFrozenRows(1);
  if (rows.length) {
    const rng = sh.getRange(2, 1, rows.length, XFER_CFG.taekusRawHeaders.length);
    rng.setNumberFormat('@');
    rng.setValues(rows);
  }
  console.log('Taekus_Raw: ' + rows.length + ' rows');
  return rows.length;
}

/**
 * files: [{name, text}] oldest first. Returns Taekus_Raw rows. Files without a
 * last-4 in the name or without ALT columns (e.g. the rewards-activity export)
 * are skipped.
 */
function taekusRowsFromCsvs_(files) {
  const byKey = {};
  files.forEach((f) => {
    const m = f.name.match(/(\d{4})\.csv$/i);
    if (!m) { console.warn('Taekus: skipping ' + f.name + ' (no account last 4 in name)'); return; }
    const recs = readCsvText_(f.text);
    if (!recs.length || !('transaction amount' in recs[0]) || !('points credited' in recs[0])) {
      console.warn('Taekus: skipping ' + f.name + ' (not an ALT debit export)');
      return;
    }
    const last4 = m[1];
    const seen = {};
    recs.forEach((r) => {
      const iso = altIso_(r.date);
      if (!iso) return;
      const amount = toNumber_(r['transaction amount']);
      // Overlapping exports format the same transaction differently (description case, uuid
      // and points sometimes missing), so the key is account + timestamp + amount only; the
      // Nth identical row in one file pairs with the Nth in another.
      const base = [last4, String(r.date).trim(), Math.round(amount * 100)].join('|');
      seen[base] = (seen[base] || 0) + 1;
      const key = base + '|' + seen[base];
      const row = [
        key, last4, iso, r.date, r['posted date'] || '', r.description || '', r.merchant || '', r['mcc code'] || '',
        amount, toNumber_(r['points credited']), r['transaction uuid'] || '', r['transaction MID'] || '',
        r.refund || '', r.settled || '', r['card nickname'] || '', f.name
      ];
      const old = byKey[key];
      if (old) {
        // Keep the fuller copy: most points, and any field the newer file leaves blank.
        row[9] = Math.max(row[9], old[9]);
        [4, 6, 7, 10, 11, 14].forEach((i) => { if (!row[i]) row[i] = old[i]; });
        if (old[10] && !r['transaction uuid']) row[5] = old[5];
      }
      byKey[key] = row;
    });
  });
  return Object.values(byKey).sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
}

// ---------------------------------------------------------------- Coinbase One fees

/** Rows of coinbase_one_fees.csv (Coinbase One paid from Coinbase balances), or [] if not there yet. */
function coinbaseFeeRows_() {
  try {
    const files = driveCsvs_(XFER_CFG.coinbaseFeeFolder);
    const f = files.filter((x) => /coinbase_one_fees/i.test(x.name)).pop();
    return f ? readCsvText_(f.text) : [];
  } catch (e) {
    console.warn('Coinbase fees: ' + e.message);
    return [];
  }
}

// ---------------------------------------------------------------- Blue Penguin CSV import

function importBlupeCsvs() {
  ensureTransferSheets_();
  const rows = blupeRowsFromCsvs_(driveCsvs_(XFER_CFG.blupeFolder));
  const sh = SpreadsheetApp.getActive().getSheetByName(XFER_CFG.sheets.blupeRaw);
  const w = XFER_CFG.blupeRawHeaders.length;
  sh.clearContents();
  sh.getRange(1, 1, 1, w).setValues([XFER_CFG.blupeRawHeaders]);
  sh.setFrozenRows(1);
  if (rows.length) {
    const rng = sh.getRange(2, 1, rows.length, w);
    rng.setNumberFormat('@');
    rng.setValues(rows);
  }
  console.log('BLUPE_Raw: ' + rows.length + ' rows');
  return rows.length;
}

/** Blue Penguin settlement reports, merged by Event ID (later files win). */
function blupeRowsFromCsvs_(files) {
  const byId = {};
  files.forEach((f) => {
    const recs = readCsvText_(f.text);
    if (!recs.length || !('Event ID' in recs[0]) || !('Interchange' in recs[0])) return;
    recs.forEach((r) => {
      const id = String(r['Event ID'] || '').trim();
      if (id) byId[id] = Object.assign({ _file: f.name }, r);
    });
  });
  return Object.keys(byId).map((id) => byId[id])
    .map((r) => [
      String(r['Event ID']).trim(), String(r.Type || '').trim(), String(r.DateTime || '').trim().slice(0, 10),
      Math.abs(toNumber_(r.Amount)), toNumber_(r.Interchange), String(r['Effective rate'] || '').trim(),
      String(r.Description || '').replace(/\s+/g, ' ').trim(), String(r.Category || '').trim(),
      String(r['Card type'] || '').trim(), String(r['Last 4'] || '').trim(), r._file
    ])
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r[2]))
    .sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
}

// ---------------------------------------------------------------- Fluz CSV import

function importFluzCsvs() {
  ensureTransferSheets_();
  const rows = fluzRowsFromCsvs_(driveCsvs_(XFER_CFG.fluzFolder));
  const sh = SpreadsheetApp.getActive().getSheetByName(XFER_CFG.sheets.fluzRaw);
  const w = XFER_CFG.fluzRawHeaders.length;
  sh.clearContents();
  sh.getRange(1, 1, 1, w).setValues([XFER_CFG.fluzRawHeaders]);
  sh.setFrozenRows(1);
  if (rows.length) {
    const rng = sh.getRange(2, 1, rows.length, w);
    rng.setNumberFormat('@');
    rng.setValues(rows);
  }
  console.log('Fluz_Raw: ' + rows.length + ' rows');
  return rows.length;
}

/**
 * files: [{name, text}] oldest first. Merges every Fluz export by Transaction ID (later files win,
 * so a newer export updates a PENDING row) and keeps the rows where money leaves Fluz.
 */
function fluzRowsFromCsvs_(files) {
  const byId = {};
  files.forEach((f) => {
    const recs = readCsvText_(f.text);
    if (!recs.length || !('Transaction ID' in recs[0]) || !('Cashback' in recs[0])) return;
    recs.forEach((r) => {
      const id = String(r['Transaction ID'] || '').trim();
      if (id) byId[id] = Object.assign({ _file: f.name }, r);
    });
  });
  const keep = new Set(XFER_CFG.fluzTypes);
  const clean = (v) => (String(v == null ? '' : v).trim() === '--' ? '' : String(v == null ? '' : v).trim());
  return Object.keys(byId).map((id) => byId[id])
    .filter((r) => keep.has(String(r.Type).trim()) && !XFER_CFG.fluzSkipStatus.test(r.Status || ''))
    .map((r) => [
      clean(r['Transaction ID']), clean(r['Reference ID']), clean(r.Type), clean(r.Status), fluzIso_(r['Created At']),
      clean(r['Created At']), toNumber_(r.Amount), clean(r.Destination), clean(r.Source).replace(/\s*\[.*?\]/g, ''),
      toNumber_(r.Cashback), toNumber_(r['Cashback Rate']), toNumber_(r.Fee), clean(r.Description),
      clean(r['Card name']), clean(r.Category), r._file
    ])
    .filter((r) => r[4])
    .sort((a, b) => (a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0));
}

/** Fluz "Created At": "Mon Oct 12 2026 20:21:44 GMT+0000 (...)" or "2026-10-16T16:52:53.446Z" (UTC). */
function fluzIso_(s) {
  const t = String(s || '');
  let m = t.match(/^\s*(\d{4}-\d{2}-\d{2})T/);
  if (m) return m[1];
  m = t.match(/[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{2}) (\d{4})/);
  const mon = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08',
    Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  return m && mon[m[1]] ? m[3] + '-' + mon[m[1]] + '-' + m[2] : '';
}

/** "05/28/2024 21:36 UTC" -> "2024-05-28" */
function altIso_(s) {
  const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? m[3] + '-' + m[1] + '-' + m[2] : '';
}

// ---------------------------------------------------------------- ledger

function rebuildTransferLedger() {
  ensureTransferSheets_();
  const ss = SpreadsheetApp.getActive();
  const rows = buildTransferLedgerRows_({
    mirror: combinedMirror_(),
    accounts: ss.getSheetByName(CFG.sheets.ynabAccounts).getDataRange().getValues(),
    taekus: ss.getSheetByName(XFER_CFG.sheets.taekusRaw).getDataRange().getValues(),
    fluz: ss.getSheetByName(XFER_CFG.sheets.fluzRaw).getDataRange().getValues(),
    blupe: ss.getSheetByName(XFER_CFG.sheets.blupeRaw).getDataRange().getValues(),
    blupeStatements: ss.getSheetByName(XFER_CFG.sheets.blupeStatements).getDataRange().getValues(),
    coinbaseFees: coinbaseFeeRows_(),
    overrides: ss.getSheetByName(XFER_CFG.sheets.overrides).getDataRange().getValues(),
    cfg: xferConfig_(),
    tz: ss.getSpreadsheetTimeZone()
  });
  const sh = ss.getSheetByName(XFER_CFG.sheets.ledger);
  sh.clearContents();
  const w = XFER_CFG.ledgerHeaders.length;
  sh.getRange(1, 1, 1, w).setValues([XFER_CFG.ledgerHeaders]);
  sh.setFrozenRows(1);
  if (rows.length) {
    sh.getRange(2, 19, rows.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, rows.length, w).setValues(rows);
    sh.getRange(2, 1, rows.length, 1).setNumberFormat('yyyy-mm-dd');
    sh.getRange(2, 7, rows.length, 1).setNumberFormat('$#,##0.00');
    sh.getRange(2, 9, rows.length, 1).setNumberFormat('#,##0');
    sh.getRange(2, 11, rows.length, 1).setNumberFormat('$#,##0.00');
    sh.getRange(2, 12, rows.length, 1).setNumberFormat('0.00%');
    sh.getRange(2, 21, rows.length, 2).setNumberFormat('$#,##0.00');
  }
  console.log('Transfer_Ledger: ' + rows.length + ' rows');
  return rows.length;
}

/** Pure function (no Apps Script services) so it can be tested offline. */
function buildTransferLedgerRows_(input) {
  const cfg = input.cfg;
  const pointValue = Number(cfg.taekus.point_value) || 0.01;
  const before = Number(cfg.taekus.match_days_before) || 7;
  const after = Number(cfg.taekus.match_days_after) || 10;
  const late = Number(cfg.taekus.late_entry_days) || 30;
  const reviewMin = Number(cfg.taekus.review_min_amount) || 0;
  const rx = (k) => new RegExp(cfg.transfer_rules[k], 'i');
  const cryptoRx = rx('crypto_regex');
  const billRx = rx('bill_pay_regex');
  const msRx = rx('ms_regex');
  const paypalRx = rx('paypal_account_regex');
  const internalRx = rx('internal_account_regex');
  const pairDays = Number(cfg.transfer_rules.paypal_pair_days) || 3;
  const pairTol = Number(cfg.transfer_rules.paypal_pair_tolerance) || 0.05;
  const aliases = targetAliases_(cfg);
  const transferGroup = String(cfg.transfer_rules.transfer_category_group || 'Transfer').toLowerCase();

  // Accounts: id -> {name, type}; Taekus accounts by last 4.
  const accounts = {};
  const taekusByLast4 = {};
  const ah = mapHeaderIndexes_(input.accounts[0] || []);
  input.accounts.slice(1).forEach((r) => {
    const id = String(r[ah.account_id] || '').trim();
    if (!id) return;
    const name = String(r[ah.account_name] || '');
    accounts[id] = { id: id, name: name, type: String(r[ah.account_type] || '') };
    const m = name.match(/^TK[BP]\s*-\s*(\d{4})/i);
    if (m) taekusByLast4[m[1]] = id;
  });
  // Source accounts: each Taekus account by its last 4, Fluz as "FLUZ", Blue Penguin as "BLUPE".
  const last4ById = {};
  Object.keys(taekusByLast4).forEach((l4) => { last4ById[taekusByLast4[l4]] = l4; });
  const fluzName = String((cfg.fluz || {}).account_name || 'FLUZ').trim().toLowerCase();
  Object.keys(accounts).forEach((id) => {
    if (accounts[id].name.trim().toLowerCase() === fluzName) {
      last4ById[id] = 'FLUZ';
      taekusByLast4.FLUZ = id;
    }
  });
  const depSrc = (XFER_CFG.depositSources || []).map((d) => Object.assign({}, d, {
    accRx: new RegExp(d.accountRegex, 'i'), rewRx: new RegExp(d.rewardRegex, 'i')
  }));
  Object.keys(accounts).forEach((id) => {
    const d = depSrc.find((s) => s.accRx.test(accounts[id].name));
    if (d && !last4ById[id]) last4ById[id] = d.key;
  });
  const blupeCfg = cfg.blupe || {};
  const blupeName = String(blupeCfg.account_name || 'BLUPE').trim().toLowerCase();
  const blupeShare = Number(blupeCfg.interchange_share) || 0;
  const rebateRx = new RegExp(blupeCfg.rebate_payee_regex || 'blue penguin', 'i');
  const otherRebateRx = new RegExp(blupeCfg.other_account_rebate_payee_regex || '^BP (REBATE|PAYOUT)\\b', 'i');
  Object.keys(accounts).forEach((id) => {
    if (accounts[id].name.trim().toLowerCase() === blupeName) {
      last4ById[id] = 'BLUPE';
      taekusByLast4.BLUPE = id;
    }
  });

  // Mirror rows -> plain objects.
  const mh = mapHeaderIndexes_(input.mirror[0] || []);
  const txns = [];
  let mirrorMin = '';
  input.mirror.slice(1).forEach((r) => {
    const id = String(r[mh.txn_id] || '').trim();
    if (!id || String(r[mh.deleted]).toLowerCase() === 'true') return;
    const iso = cellIso_(r[mh.Date], input.tz);
    if (!iso) return;
    if (!mirrorMin || iso < mirrorMin) mirrorMin = iso;
    txns.push({
      id: id,
      iso: iso,
      accountId: String(r[mh.account_id] || '').trim(),
      account: String(r[mh.Account] || ''),
      payee: String(r[mh.Payee] || ''),
      category: String(r[mh.Category] || ''),
      catGroup: String(r[mh['Category Group']] || ''),
      memo: String(r[mh.Memo] || ''),
      outflow: toNumber_(r[mh.Outflow]),
      inflow: toNumber_(r[mh.Inflow]),
      fee: mh.split_fee === undefined ? 0 : toNumber_(r[mh.split_fee]),
      // Payees of a split's other lines, e.g. the "Western Union" fee line next to a transfer
      // to SOFD: Western Union is the real target there.
      splitPayees: mh.split_payees === undefined ? '' : String(r[mh.split_payees] || ''),
      dstId: String(r[mh.transfer_account_id] || '').trim()
    });
  });

  // Taekus CSV outflows (positive amount = money out), by last 4.
  const th = mapHeaderIndexes_(input.taekus[0] || []);
  const csv = [];
  const csvMax = {};
  const csvMin = {};
  input.taekus.slice(1).forEach((r) => {
    const last4 = String(r[th.account_last4] || '').padStart(4, '0');
    const iso = String(r[th.date] || '');
    if (!iso || !taekusByLast4[last4]) return;
    if (!csvMax[last4] || iso > csvMax[last4]) csvMax[last4] = iso;
    if (!csvMin[last4] || iso < csvMin[last4]) csvMin[last4] = iso;
    const amt = -toNumber_(r[th.amount]);
    if (amt <= 0 || String(r[th.refund]).toLowerCase() === 'true') return;
    if (mirrorMin && iso < isoAddDays_(mirrorMin, -before)) return;
    csv.push({
      key: String(r[th.key]), last4: last4, iso: iso, cents: Math.round(amt * 100), amount: amt,
      points: toNumber_(r[th.points]), desc: String(r[th.description] || ''), merchant: String(r[th.merchant] || ''),
      cashback: 0, source: 'TAEKUS'
    });
  });

  // Fluz rows (money leaving Fluz): cashback in dollars instead of points; matched by reference ID
  // in the YNAB memo first (the Fluz sync writes "<ref> - ..."), then like Taekus rows.
  const fz = input.fluz || [];
  const fh = mapHeaderIndexes_(fz[0] || []);
  if (taekusByLast4.FLUZ) {
    fz.slice(1).forEach((r) => {
      const iso = String(r[fh.date] || '');
      if (!iso) return;
      if (!csvMax.FLUZ || iso > csvMax.FLUZ) csvMax.FLUZ = iso;
      if (!csvMin.FLUZ || iso < csvMin.FLUZ) csvMin.FLUZ = iso;
      const amt = -toNumber_(r[fh.amount]);
      if (amt <= 0) return;
      if (mirrorMin && iso < isoAddDays_(mirrorMin, -before)) return;
      const type = String(r[fh.type] || '');
      csv.push({
        key: String(r[fh.transaction_id]), last4: 'FLUZ', iso: iso, cents: Math.round(amt * 100), amount: amt,
        points: 0, cashback: toNumber_(r[fh.cashback]) - Math.abs(toNumber_(r[fh.fee])),
        desc: String(r[fh.destination] || '') + (r[fh.description] ? ' ' + r[fh.description] : ''),
        merchant: String(r[fh.card_name] || ''), ref: String(r[fh.reference_id] || ''), type: type, source: 'FLUZ'
      });
    });
  }

  // Blue Penguin settles: your share of the interchange is the cash back. Matched by the Event ID in
  // the YNAB memo first (the Blue Penguin sync writes "BP <id> - ..."), then like Taekus rows.
  const bp = input.blupe || [];
  const bpRefunds = [];
  const bh = mapHeaderIndexes_(bp[0] || []);
  if (taekusByLast4.BLUPE) {
    bp.slice(1).forEach((r) => {
      const iso = String(r[bh.date] || '');
      if (!iso) return;
      if (!csvMax.BLUPE || iso > csvMax.BLUPE) csvMax.BLUPE = iso;
      if (!csvMin.BLUPE || iso < csvMin.BLUPE) csvMin.BLUPE = iso;
      if (String(r[bh.type]) === 'Refund' && iso >= mirrorMin) {
        bpRefunds.push({ id: String(r[bh.event_id]), iso: iso, amount: Math.abs(toNumber_(r[bh.amount])),
          interchange: Math.abs(toNumber_(r[bh.interchange])), desc: String(r[bh.description] || '') });
      }
      if (String(r[bh.type]) !== 'Settle') return;
      const amt = toNumber_(r[bh.amount]);
      if (amt <= 0 || (mirrorMin && iso < isoAddDays_(mirrorMin, -before))) return;
      csv.push({
        key: String(r[bh.event_id]), last4: 'BLUPE', iso: iso, cents: Math.round(amt * 100), amount: amt,
        points: 0, cashback: Math.round(toNumber_(r[bh.interchange]) * blupeShare * 100) / 100,
        desc: String(r[bh.description] || ''), merchant: '', ref: 'BP ' + String(r[bh.event_id]), type: 'Settle',
        source: 'BLUPE'
      });
    });
  }

  // Statement rate per processing month, and which months the settlement CSVs cover.
  const bpStatements = {};
  const sth = mapHeaderIndexes_((input.blupeStatements || [])[0] || []);
  (input.blupeStatements || []).slice(1).forEach((r) => {
    const m = String(r[sth.processing_month] || '').trim().slice(0, 7);
    const settle = toNumber_(r[sth.settlement]);
    if (/^\d{4}-\d{2}$/.test(m) && settle > 0) bpStatements[m] = { rate: toNumber_(r[sth.rebate]) / settle };
  });
  const bpCsvMonths = {};
  csv.forEach((c) => { if (c.source === 'BLUPE') bpCsvMonths[c.iso.slice(0, 7)] = true; });

  // YNAB outflows from the source accounts.
  const tk = txns.filter((t) => last4ById[t.accountId] && t.outflow > 0);

  // Match: same account + amount, date window; closest dates first, one-to-one.
  const groups = {};
  tk.forEach((t, i) => {
    const k = last4ById[t.accountId] + '|' + Math.round(t.outflow * 100);
    (groups[k] = groups[k] || { y: [], c: [] }).y.push(i);
  });
  csv.forEach((c, j) => {
    const k = c.last4 + '|' + c.cents;
    if (groups[k]) groups[k].c.push(j);
  });
  // Within each account + amount group, walk both sides in date order and give each Taekus row
  // the earliest unused YNAB entry inside the window. Order-preserving matching keeps long runs of
  // identical $1,000 buys (YNAB often batch-dated a few days off) from stranding rows at the edges.
  // Pass 2 pairs what is left with YNAB entries made up to late_entry_days after the Taekus date
  // (batches typed in weeks later, e.g. PayPal crypto buys).
  const ynabToCsv = {};
  const csvUsed = {};
  const lateMatch = {};
  const byDate = (arr, get) => arr.slice().sort((a, b) => (get(a) < get(b) ? -1 : get(a) > get(b) ? 1 : a - b));
  // Fluz / Blue Penguin: exact pairing first by a reference ID in the YNAB memo (same amount, to the cent).
  const refIdx = {};
  csv.forEach((c, j) => { if (c.ref) refIdx[c.ref] = j; });
  tk.forEach((t, i) => {
    const src = last4ById[t.accountId];
    if (src !== 'FLUZ' && src !== 'BLUPE') return;
    const refs = src === 'FLUZ' ? t.memo.match(/\b\d{6,10}\b/g) || []
      : (t.memo.match(/\bBP \d+\b/g) || []);
    for (let n = 0; n < refs.length; n += 1) {
      const j = refIdx[refs[n]];
      if (j === undefined || csvUsed[j] || Math.abs(csv[j].cents - Math.round(t.outflow * 100)) > 1) continue;
      ynabToCsv[i] = j;
      csvUsed[j] = true;
      break;
    }
  });
  [after, Math.max(after, late)].forEach((maxAfter, pass) => {
    Object.keys(groups).forEach((k) => {
      const ys = byDate(groups[k].y.filter((i) => ynabToCsv[i] === undefined), (i) => tk[i].iso);
      const cs = byDate(groups[k].c.filter((j) => !csvUsed[j]), (j) => csv[j].iso);
      let p = 0;
      const taken = {};
      cs.forEach((j) => {
        const cd = isoDays_(csv[j].iso);
        while (p < ys.length && (taken[p] || isoDays_(tk[ys[p]].iso) - cd < -before)) p += 1;
        for (let q = p; q < ys.length; q += 1) {
          if (taken[q]) continue;
          const dd = isoDays_(tk[ys[q]].iso) - cd;
          if (dd > maxAfter) break;
          taken[q] = true;
          ynabToCsv[ys[q]] = j;
          csvUsed[j] = true;
          if (pass === 1) lateMatch[ys[q]] = true;
          break;
        }
      });
    });
  });

  // Uncross pairs: two same-amount transfers to different places on nearby days can get each
  // other's Taekus row (e.g. YNAB "Transfer : OPYD" paired with Taekus "Coinbase" and YNAB
  // "Coinbase" with Taekus "Onepay*One"). Swap them when that makes both sides agree.
  const tGroup = tk.map((t) => targetGroup_([
    t.catGroup.toLowerCase() === transferGroup ? t.category : '',
    (accounts[t.dstId] || {}).name, t.payee, t.splitPayees
  ], aliases));
  const cGroup = csv.map((c) => targetGroup_([c.desc, c.merchant], aliases));
  const crossed = {};
  Object.keys(ynabToCsv).forEach((i) => {
    const j = ynabToCsv[i];
    if (tGroup[i] && cGroup[j] && tGroup[i] !== cGroup[j]) {
      const k = last4ById[tk[i].accountId] + '|' + csv[j].cents;
      (crossed[k] = crossed[k] || []).push(Number(i));
    }
  });
  const inWindow = (i, j) => {
    const dd = isoDays_(tk[i].iso) - isoDays_(csv[j].iso);
    return dd >= -before && dd <= Math.max(after, late);
  };
  Object.keys(crossed).forEach((k) => {
    const list = crossed[k];
    for (let a = 0; a < list.length; a += 1) {
      for (let b = a + 1; b < list.length; b += 1) {
        const ia = list[a];
        const ib = list[b];
        const ja = ynabToCsv[ia];
        const jb = ynabToCsv[ib];
        if (tGroup[ia] === cGroup[ja] || tGroup[ib] === cGroup[jb]) continue;
        if (tGroup[ia] !== cGroup[jb] || tGroup[ib] !== cGroup[ja]) continue;
        if (!inWindow(ia, jb) || !inWindow(ib, ja)) continue;
        ynabToCsv[ia] = jb;
        ynabToCsv[ib] = ja;
        break;
      }
    }
  });

  // PayPal outflows that can pair with a Taekus -> PayPal transfer (crypto via PayPal).
  const ppOut = {};
  txns.forEach((t, i) => {
    if (!(t.outflow > 0) || !paypalRx.test(t.account)) return;
    const text = [t.payee, t.category, t.memo].join(' ');
    if (!cryptoRx.test(text)) return;
    (ppOut[t.accountId] = ppOut[t.accountId] || []).push(i);
  });
  const ppUsed = {};

  // Blue Penguin -> Robinhood transfers that fund a Robinhood credit card payment are Bill Pay.
  // Each card payment takes the unused transfers dated up to rh_pay_days before it (or 2 after),
  // oldest first, while their total stays within the payment (+ tolerance).
  const rhBill = {};
  const bpc = cfg.blupe || {};
  const rhCardRx = new RegExp(bpc.rh_card_account_regex || '^RHCC\\b', 'i');
  const rhDays = Number(bpc.rh_pay_days) || 10;
  const rhTol = Number(bpc.rh_pay_tolerance) || 0.05;
  const rhCand = [];
  tk.forEach((t, i) => {
    if (last4ById[t.accountId] !== 'BLUPE') return;
    const cat = t.catGroup.toLowerCase() === transferGroup ? t.category : '';
    if (targetGroup_([cat, (accounts[t.dstId] || {}).name, t.payee], aliases) === 'Robinhood') rhCand.push(i);
  });
  const rhCryptoEnd = String(bpc.rh_crypto_end || '').trim();
  const isRh = {};
  rhCand.forEach((i) => { isRh[i] = true; });
  rhCand.sort((a, b) => (tk[a].iso < tk[b].iso ? -1 : tk[a].iso > tk[b].iso ? 1 : 0));
  txns.filter((t) => rhCardRx.test(t.account) && t.inflow > 0 && /payment/i.test(t.payee) && !t.dstId)
    .sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0))
    .forEach((p) => {
      let sum = 0;
      rhCand.forEach((i) => {
        if (rhBill[i]) return;
        const dd = isoDays_(p.iso) - isoDays_(tk[i].iso);
        if (dd < -2 || dd > rhDays || sum + tk[i].outflow > p.inflow * (1 + rhTol)) return;
        sum += tk[i].outflow;
        rhBill[i] = p;
      });
    });

  const overrides = {};
  const oh = mapHeaderIndexes_(input.overrides[0] || []);
  input.overrides.slice(1).forEach((r) => {
    const id = String(r[oh.ynab_txn_id] || '').trim();
    if (!id) return;
    overrides[id] = {
      bucket: String(r[oh.bucket] || '').trim().toUpperCase().replace(/[- ]/g, '_'),
      points: r[oh.points] === '' || r[oh.points] == null ? null : toNumber_(r[oh.points]),
      notes: String(r[oh.notes] || '')
    };
  });

  const out = [];
  const emit = (o) => {
    const fee = o.fee || 0;
    const cashback = o.cashback || 0;
    const profit = Math.round((o.points * pointValue + cashback - fee) * 100) / 100;
    out.push([
      isoToDate_(o.iso), o.source, o.account, o.payee, o.target, o.targetType, o.amount, o.bucket,
      o.points, o.source === 'TAEKUS' ? pointValue : '', profit, o.amount ? profit / o.amount : 0, o.match,
      o.csvDesc, o.csvIso, o.id, o.memo, o.note, o.iso.slice(0, 7), o.group, fee, cashback
    ]);
  };

  tk.forEach((t, i) => {
    const last4 = last4ById[t.accountId];
    if (t.iso < isoAddDays_(mirrorMin, 0)) return;
    const j = ynabToCsv[i];
    const c = j === undefined ? null : csv[j];
    const dst = accounts[t.dstId] || null;
    let match = lateMatch[i] ? 'matched (late entry)' : 'matched';
    if (!c) {
      if (!csvMax[last4]) match = 'no csv for account';
      else if (t.iso > csvMax[last4]) match = 'awaiting csv';
      else if (t.iso < csvMin[last4]) match = 'before csv start';
      else match = 'no csv row';
    }

    let bucket = 'OTHER';
    let note = '';
    let pairedPayee = '';
    // YNAB category group "Transfer" (e.g. Transfer: Coinbase) names the target directly.
    const transferCat = t.catGroup.toLowerCase() === transferGroup && t.category ? t.category : '';
    // YNAB says where the money went; the Taekus description only helps when YNAB doesn't
    // (no transfer account or Transfer category) or the transfer went to PayPal (crypto via PayPal).
    const useCsv = c && ((!dst && !transferCat) || (dst && paypalRx.test(dst.name)));
    const text = [t.payee, t.category, t.memo, dst ? dst.name : '', useCsv ? c.desc + ' ' + c.merchant : ''].join(' ');
    // A Fluz withdrawal just moves your own balance back to a bank account.
    if ((dst && internalRx.test(dst.name)) || (c && c.type === 'Withdrawal')) bucket = 'INTERNAL';
    // Fee charges of their own aren't transfers. Fluz's (card-funded loads) can't be tied to a
    // transfer, so they get their own bucket and come off total profit on the Summary.
    else if (!dst && /\bfees?\b/i.test([t.payee, t.category, t.catGroup].join(' '))) {
      bucket = last4 === 'FLUZ' ? 'FLUZ_FEE' : 'OTHER';
    }
    else if (dst && CFG.debtTypes.has(dst.type)) bucket = 'BILL_PAY';
    else if (rhBill[i] || (isRh[i] && rhCryptoEnd && t.iso > rhCryptoEnd)) {
      bucket = 'BILL_PAY';
      pairedPayee = 'Robinhood Credit Card';
      note = rhBill[i] ? 'pays ' + rhBill[i].account + ' ' + rhBill[i].inflow.toFixed(2) + ' on ' + rhBill[i].iso
        : 'Robinhood card payment (after ' + rhCryptoEnd + ')';
    }
    else if (cryptoRx.test(text)) bucket = 'MS_CRYPTO';
    else if (dst && paypalRx.test(dst.name)) {
      bucket = billRx.test(text) ? 'BILL_PAY' : 'MS';
      const cands = ppOut[dst.id] || [];
      for (let k = 0; k < cands.length; k += 1) {
        const p = txns[cands[k]];
        const dd = isoDays_(p.iso) - isoDays_(t.iso);
        if (ppUsed[cands[k]] || dd < 0 || dd > pairDays) continue;
        if (Math.abs(p.outflow - t.outflow) > Math.max(1, t.outflow * pairTol)) continue;
        ppUsed[cands[k]] = true;
        bucket = 'MS_CRYPTO';
        pairedPayee = p.payee;
        note = 'via PayPal: ' + p.payee + ' ' + p.outflow.toFixed(2) + ' on ' + p.iso;
        break;
      }
    } else if (billRx.test(text)) bucket = 'BILL_PAY';
    else if (transferCat || dst || msRx.test(text)) bucket = 'MS';

    let points = c ? c.points : 0;
    // Blue Penguin months without settlement rows (account 126795, before the CSVs start): use that
    // month's statement rate (rebate / settlement) so the history still shows cash back.
    let cashback = c ? c.cashback : 0;
    const stmt = !c && last4 === 'BLUPE' ? bpStatements[t.iso.slice(0, 7)] : null;
    if (stmt && (!bpCsvMonths[t.iso.slice(0, 7)] || t.iso < csvMin.BLUPE) && bucket !== 'INTERNAL') {
      cashback = Math.round(t.outflow * stmt.rate * 100) / 100;
      match = 'statement rate';
    }
    // A Fluz fee row is all cost: the whole charge counts as fee.
    const rowFee = bucket === 'FLUZ_FEE' ? t.outflow : t.fee;
    if (bucket === 'FLUZ_FEE') match = 'fee charge';
    const ov = overrides[t.id];
    if (ov) {
      if (ov.bucket) bucket = ov.bucket;
      if (ov.points !== null) points = ov.points;
      match = match + ' (override)';
      if (ov.notes) note = note ? note + '; ' + ov.notes : ov.notes;
    }

    emit({
      iso: t.iso, source: /^\d{4}$/.test(last4) ? 'TAEKUS' : last4, account: t.account, payee: t.payee,
      target: dst ? dst.name : t.payee, cashback: cashback,
      targetType: dst ? dst.type : '', amount: t.outflow, bucket: bucket, points: points, match: match,
      csvDesc: c ? c.desc : '', csvIso: c ? c.iso : '', id: t.id, memo: t.memo, note: note, fee: rowFee,
      group: (pairedPayee === 'Robinhood Credit Card' && pairedPayee) ||
        (pairedPayee && targetGroup_([pairedPayee], aliases)) ||
        (transferCat && (targetGroup_([transferCat], aliases) || transferCat)) ||
        // Paid through PayPal: the PayPal descriptor names the real target (PAYPAL *AMERICANEXP).
        (dst && paypalRx.test(dst.name) && c && targetGroup_([c.desc], aliases)) ||
        targetGroup_([dst ? dst.name : '', t.payee, t.splitPayees], aliases) ||
        (useCsv && targetGroup_([c.desc], aliases)) || (dst ? dst.name : t.payee)
    });
  });

  // Blue Penguin refunds reverse the interchange (and so the cash back) of the purchase they undo.
  // Each becomes a negative row in the bucket of what was refunded, linked to the YNAB inflow.
  const refundUsed = {};
  bpRefunds.forEach((f) => {
    const inflow = txns.find((t) => last4ById[t.accountId] === 'BLUPE' && !refundUsed[t.id] &&
      Math.abs(t.inflow - f.amount) < 0.01 && Math.abs(isoDays_(t.iso) - isoDays_(f.iso)) <= after);
    if (inflow) refundUsed[inflow.id] = true;
    // Bucket of the purchase being undone: the latest same-amount Blue Penguin transfer in the
    // 30 days before; else guess from the descriptor.
    const fd = isoDays_(f.iso);
    const orig = out.filter((r) => r[1] === 'BLUPE' && Math.abs(r[6] - f.amount) < 0.01 &&
      XFER_CFG.buckets.indexOf(r[7]) >= 0 && fd - isoDays_(r[18] + '-01') >= 0)
      .map((r) => ({ bucket: r[7], group: r[19], d: isoDays_(cellIso_(r[0])) }))
      .filter((o) => fd - o.d >= 0 && fd - o.d <= 30)
      .sort((a, b) => b.d - a.d)[0];
    const group = orig ? orig.group : targetGroup_([f.desc], aliases) || f.desc;
    let bucket = orig ? orig.bucket : 'MS';
    if (!orig && cryptoRx.test(f.desc)) bucket = 'MS_CRYPTO';
    else if (!orig && billRx.test(f.desc)) bucket = 'BILL_PAY';
    const back = -Math.round(f.interchange * blupeShare * 100) / 100;
    out.push([
      isoToDate_(f.iso), 'BLUPE', accounts[taekusByLast4.BLUPE].name, inflow ? inflow.payee : f.desc, group, '',
      -f.amount, bucket, 0, '', back, f.amount ? back / -f.amount : 0, 'refund', f.desc, f.iso,
      inflow ? inflow.id : '', inflow ? inflow.memo : '', 'BP ' + f.id + ' refund', f.iso.slice(0, 7), group, 0, back
    ]);
  });

  // Taekus outflows with no YNAB transaction (only where the mirror covers the dates).
  csv.forEach((c, j) => {
    // Tiny charges (e.g. Geico micro-payments) are lumped together in YNAB; don't flag them.
    if (csvUsed[j] || c.amount < reviewMin || c.iso < isoAddDays_(mirrorMin, after)) return;
    if (c.type === 'Withdrawal') return;
    const accId = taekusByLast4[c.last4];
    emit({
      iso: c.iso, source: c.source, cashback: c.cashback,
      account: accounts[accId].name, payee: c.desc, target: c.merchant || c.desc, targetType: '',
      amount: c.amount, bucket: 'REVIEW', points: c.points, match: 'not in YNAB', csvDesc: c.desc,
      csvIso: c.iso, id: '', memo: '', note: c.key,
      group: targetGroup_([c.desc, c.merchant], aliases) || c.desc
    });
  });

  // Coinbase One subscription: a cost of crypto MS that can't be tied to a single buy. Kept as
  // CRYPTO_FEE rows (profit = -fee) so the Summary and MS-Crypto sheet can show profit after it.
  // From Coinbase balances (API export) plus bank-paid charges and refunds in YNAB.
  const cbPayRx = new RegExp(XFER_CFG.coinbaseOneRegex.payee, 'i');
  const cbCatRx = new RegExp(XFER_CFG.coinbaseOneRegex.category, 'i');
  const feeRow = (iso, account, payee, amount, id, memo, note) => {
    out.push([
      isoToDate_(iso), 'COINBASE', account, payee, 'Coinbase One', '', amount, 'CRYPTO_FEE', 0, '',
      -Math.round(amount * 100) / 100, 0, 'subscription fee', '', '', id, memo, note, iso.slice(0, 7),
      'Coinbase One', Math.round(amount * 100) / 100, 0
    ]);
  };
  txns.forEach((t) => {
    if (t.dstId || t.iso < mirrorMin || !cbPayRx.test(t.payee) || !cbCatRx.test(t.category)) return;
    if (t.outflow > 0) feeRow(t.iso, t.account, t.payee, t.outflow, t.id, t.memo, 'paid from bank');
    else if (t.inflow > 0) feeRow(t.iso, t.account, t.payee, -t.inflow, t.id, t.memo, 'refund');
  });
  (input.coinbaseFees || []).forEach((r) => {
    const iso = String(r.date || '').slice(0, 10);
    const usd = toNumber_(r.amount_usd);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !usd) return;
    // subscription: negative amount (paid); subscription_rebate: positive (refunded).
    feeRow(iso, 'Coinbase ' + (r.account || ''), r.type === 'subscription' ? 'Coinbase One' : 'Coinbase One rebate',
      -usd, String(r.id || ''), '', r.type === 'subscription' ? 'paid in ' + (r.currency || 'USDC') : 'rebate');
  });

  // Deposit-allocated sources (Upgrade, Primis): monthly reward / that month's tracked transfers.
  if (depSrc.length) {
    const monNames = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
      september: 9, october: 10, november: 11, december: 12 };
    const shiftMonth = (ym, n) => {
      const p = ym.split('-').map(Number);
      const d = new Date(Date.UTC(p[0], p[1] - 1 - n, 1));
      return d.toISOString().slice(0, 7);
    };
    const reward = {};
    txns.forEach((t) => {
      const key = last4ById[t.accountId];
      const d = depSrc.find((s) => s.key === key);
      if (!d || !(t.inflow > 0) || t.dstId) return;
      const m = [t.payee, t.memo].join(' ').match(d.rewRx);
      if (!m) return;
      let month = shiftMonth(t.iso.slice(0, 7), d.lagMonths || 0);
      if (m[1]) {
        const mm = m[1].toLowerCase().match(/([a-z]+) (\d{4})/);
        if (mm && monNames[mm[1]]) month = mm[2] + '-' + ('0' + monNames[mm[1]]).slice(-2);
      }
      reward[key + '|' + month] = (reward[key + '|' + month] || 0) + t.inflow;
    });
    const base = {};
    // The reward was earned on all card spend that month (purchases too), so every outflow except
    // moves between your own accounts counts toward the base; only tracked transfers keep a share.
    out.forEach((r) => {
      if (!depSrc.some((s) => s.key === r[1]) || r[7] === 'INTERNAL' || !(r[6] > 0)) return;
      base[r[1] + '|' + r[18]] = (base[r[1] + '|' + r[18]] || 0) + r[6];
    });
    out.forEach((r) => {
      const k = r[1] + '|' + r[18];
      if (!base[k] || !reward[k] || XFER_CFG.buckets.indexOf(r[7]) < 0) return;
      const cb = Math.round(r[6] * reward[k] / base[k] * 100) / 100;
      r[21] = cb;
      r[10] = Math.round((cb - (r[20] || 0)) * 100) / 100;
      r[11] = r[6] ? r[10] / r[6] : 0;
      if (/^no csv/.test(String(r[12]))) r[12] = 'deposit rate';
    });
  }

  // Blue Penguin monthly rebates actually received: inflows to BLUPE from Blue Penguin, plus the
  // early ones (Dec 2024 - May 2025) paid into Sequence accounts as "BP REBATE | <id>" or
  // "BP PAYOUT | <id>". Kept as their own rows so the Summary can compare them with the
  // per-transfer estimate. No profit here, so they are not counted twice.
  txns.forEach((t) => {
    if (!(t.inflow > 0) || t.dstId || t.iso < mirrorMin) return;
    const inBlupe = last4ById[t.accountId] === 'BLUPE' && rebateRx.test([t.payee, t.category, t.memo].join(' '));
    if (!inBlupe && !otherRebateRx.test(t.payee)) return;
    out.push([
      isoToDate_(t.iso), 'BLUPE', t.account, t.payee, 'Blue Penguin', '', t.inflow, 'BLUPE_REBATE', 0, '', 0, 0,
      'rebate received', '', '', t.id, t.memo, '', t.iso.slice(0, 7), 'Blue Penguin', 0, t.inflow
    ]);
  });

  out.sort((a, b) => b[0] - a[0]);
  return out;
}

/** [[name, RegExp]] in Config order. */
function targetAliases_(cfg) {
  return Object.keys(cfg.target_aliases).map((k) => [k, new RegExp(cfg.target_aliases[k], 'i')]);
}

/** First alias (in Config order) that matches any of the texts, else ''. */
function targetGroup_(texts, aliases) {
  const ts = texts.map((t) => String(t || '').trim()).filter((t) => t);
  for (let j = 0; j < aliases.length; j += 1) {
    for (let i = 0; i < ts.length; i += 1) if (aliases[j][1].test(ts[i])) return aliases[j][0];
  }
  return '';
}

/** Sheet cell (Date, serial, "MM/DD/YYYY" or "YYYY-MM-DD") -> "YYYY-MM-DD". */
function cellIso_(v, tz) {
  if (v instanceof Date) {
    return typeof Utilities !== 'undefined'
      ? Utilities.formatDate(v, tz || 'America/New_York', 'yyyy-MM-dd')
      : v.toISOString().slice(0, 10);
  }
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
  return '';
}

/** "YYYY-MM-DD" -> local-midnight Date (so the sheet shows that calendar day). */
function isoToDate_(iso) {
  const p = iso.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

// ---------------------------------------------------------------- views

/** MS / MS-Crypto / Bill Pay: totals on top, monthly table, then the transactions. */
function setTransferView_(sheetName, bucket) {
  const sheet = ensureSheet_(SpreadsheetApp.getActive(), sheetName);
  const L = XFER_CFG.sheets.ledger;
  sheet.clear();
  sheet.getRange('A1:H1').setValues([['Transfers', 'Amount', 'Taekus points', 'Fluz cashback', 'Fees',
    'Profit (net)', 'Avg rate', 'Last 30 days profit']]);
  sheet.getRange('A2:H2').setFormulas([[
    `=COUNTIF('${L}'!H:H,"${bucket}")`,
    `=SUMIFS('${L}'!G:G,'${L}'!H:H,"${bucket}")`,
    `=SUMIFS('${L}'!I:I,'${L}'!H:H,"${bucket}")`,
    `=SUMIFS('${L}'!V:V,'${L}'!H:H,"${bucket}")`,
    `=SUMIFS('${L}'!U:U,'${L}'!H:H,"${bucket}")`,
    `=SUMIFS('${L}'!K:K,'${L}'!H:H,"${bucket}")`,
    '=IFERROR(F2/B2,0)',
    `=SUMIFS('${L}'!K:K,'${L}'!H:H,"${bucket}",'${L}'!A:A,">="&(TODAY()-30))`
  ]]);
  if (bucket === 'MS_CRYPTO') {
    sheet.getRange('I1:J1').setValues([['Coinbase One fees', 'Profit after Coinbase One']]);
    sheet.getRange('I2:J2').setFormulas([[`=SUMIFS('${L}'!U:U,'${L}'!H:H,"CRYPTO_FEE")`, '=F2-I2']]);
    sheet.getRange('I2:J2').setNumberFormat('$#,##0.00');
    sheet.getRange('I1:J1').setFontWeight('bold');
  }
  sheet.getRange('A1:H1').setFontWeight('bold');
  sheet.getRange('B2').setNumberFormat('$#,##0.00');
  sheet.getRange('C2').setNumberFormat('#,##0');
  sheet.getRange('D2:F2').setNumberFormat('$#,##0.00');
  sheet.getRange('G2').setNumberFormat('0.00%');
  sheet.getRange('H2').setNumberFormat('$#,##0.00');

  // Transactions: A4:N
  sheet.getRange('A4').setFormula(
    `=IFERROR(QUERY('${L}'!A1:V,"select A,C,D,T,G,I,V,U,K,L,M,R,Q,P where H = '${bucket}' order by A desc ` +
    `label A 'date', C 'account', D 'payee', T 'target', G 'amount', I 'points', V 'cashback', U 'fee', ` +
    `K 'profit', L 'rate', M 'match', R 'note', Q 'memo', P 'ynab_txn_id'",1),"")`);
  // Monthly: P4:V
  sheet.getRange('P4').setFormula(
    `=IFERROR(QUERY('${L}'!A1:V,"select S, count(G), sum(G), sum(I), sum(V), sum(U), sum(K) where H = '${bucket}' ` +
    `group by S order by S desc label S 'month', count(G) 'transfers', sum(G) 'amount', sum(I) 'points', ` +
    `sum(V) 'cashback', sum(U) 'fees', sum(K) 'profit'",1),"")`);
  sheet.getRange('A5:A').setNumberFormat('yyyy-mm-dd');
  sheet.getRange('E5:E').setNumberFormat('$#,##0.00');
  sheet.getRange('F5:F').setNumberFormat('#,##0');
  sheet.getRange('G5:I').setNumberFormat('$#,##0.00');
  sheet.getRange('J5:J').setNumberFormat('0.00%');
  sheet.getRange('R5:R').setNumberFormat('$#,##0.00');
  sheet.getRange('S5:S').setNumberFormat('#,##0');
  sheet.getRange('T5:V').setNumberFormat('$#,##0.00');
  sheet.getRange('A4:V4').setFontWeight('bold');
  sheet.setFrozenRows(4);
}
