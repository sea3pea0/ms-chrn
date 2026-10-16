/**
 * Transfer profit tracking (MS, MS-Crypto, Bill Pay).
 *
 * 1) importTaekusCsvs() reads every ALT debit export in the Drive folder
 *    "Taekus Transaction CSVs" into Taekus_Raw (deduped; newest file wins, so a
 *    later export updates points that were still 0). The account comes from the
 *    last 4 digits in the file name, e.g. "...ALT Business Debit-0523.csv".
 * 2) rebuildTransferLedger() matches each YNAB outflow from a Taekus account
 *    (TKB/TKP - NNNN) in the YNAB mirror to its Taekus row by account, exact
 *    amount and date window, classifies it MS / MS_CRYPTO / BILL_PAY, and writes
 *    Transfer_Ledger with points and profit (points x Config taekus/point_value).
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
  sheets: {
    taekusRaw: 'Taekus_Raw',
    ledger: 'Transfer_Ledger',
    overrides: 'Transfer_Overrides'
  },
  taekusRawHeaders: [
    'key', 'account_last4', 'date', 'datetime', 'posted_date', 'description', 'merchant', 'mcc',
    'amount', 'points', 'uuid', 'mid', 'refund', 'settled', 'card_nickname', 'file'
  ],
  ledgerHeaders: [
    'date', 'source', 'account', 'payee', 'target', 'target_type', 'amount', 'bucket',
    'points', 'point_value', 'profit', 'rate', 'match', 'csv_description', 'csv_date',
    'ynab_txn_id', 'memo', 'note', 'month', 'target_group', 'fee'
  ],
  overrideHeaders: ['ynab_txn_id', 'bucket', 'points', 'notes'],
  buckets: ['MS', 'MS_CRYPTO', 'BILL_PAY'],
  views: { MS: 'MS', MS_CRYPTO: 'MS-Crypto', BILL_PAY: 'Bill Pay' },
  configDefaults: {
    taekus: {
      point_value: '0.01',
      match_days_before: '7',
      match_days_after: '10'
    },
    transfer_rules: {
      crypto_regex: 'coinbase|uphold|topper|usdc|pyusd|crypto|robinhood|transak|moonpay|phantom|meld|kraken|gemini|bitcoin',
      bill_pay_regex: 'citibank|synchrony|syncb|credit card|card payment|cc payment',
      ms_regex: 'lemfi|wise|revolut|sling|morse|western union|skrill|onepay|metapay|moneylion|roarmoney|chime|current account|remitly|xoom',
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
      Fluz: '^FLUZ\\b|transfer : FLUZ\\b',
      PayPal: '^PP\\b|transfer : PP\\b|paypal'
    }
  },
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
    XFER_CFG.sheets.ledger, XFER_CFG.sheets.overrides, TARGET_CFG.statsSheet, XFER_CFG.sheets.taekusRaw,
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
  [XFER_CFG.sheets.taekusRaw, XFER_CFG.sheets.ledger, XFER_CFG.sheets.overrides].forEach((n) => ensureSheet_(ss, n));
  Object.values(XFER_CFG.views).forEach((n) => ensureSheet_(ss, n));
  const ov = ss.getSheetByName(XFER_CFG.sheets.overrides);
  if (ov.getLastRow() === 0) {
    ov.getRange(1, 1, 1, XFER_CFG.overrideHeaders.length).setValues([XFER_CFG.overrideHeaders]);
    ov.setFrozenRows(1);
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
    sh.getRange(2, 21, rows.length, 1).setNumberFormat('$#,##0.00');
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
  const last4ById = {};
  Object.keys(taekusByLast4).forEach((l4) => { last4ById[taekusByLast4[l4]] = l4; });

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
      fee: mh.split_fee === undefined ? 0 : toNumber_(r[mh.split_fee]),
      dstId: String(r[mh.transfer_account_id] || '').trim()
    });
  });

  // Taekus CSV outflows (positive amount = money out), by last 4.
  const th = mapHeaderIndexes_(input.taekus[0] || []);
  const csv = [];
  const csvMax = {};
  input.taekus.slice(1).forEach((r) => {
    const last4 = String(r[th.account_last4] || '').padStart(4, '0');
    const iso = String(r[th.date] || '');
    if (!iso || !taekusByLast4[last4]) return;
    if (!csvMax[last4] || iso > csvMax[last4]) csvMax[last4] = iso;
    const amt = -toNumber_(r[th.amount]);
    if (amt <= 0 || String(r[th.refund]).toLowerCase() === 'true') return;
    if (mirrorMin && iso < isoAddDays_(mirrorMin, -before)) return;
    csv.push({
      key: String(r[th.key]), last4: last4, iso: iso, cents: Math.round(amt * 100), amount: amt,
      points: toNumber_(r[th.points]), desc: String(r[th.description] || ''), merchant: String(r[th.merchant] || '')
    });
  });

  // YNAB outflows from Taekus accounts.
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
  const ynabToCsv = {};
  const csvUsed = {};
  Object.keys(groups).forEach((k) => {
    const g = groups[k];
    const pairs = [];
    g.y.forEach((i) => {
      g.c.forEach((j) => {
        const dd = isoDays_(tk[i].iso) - isoDays_(csv[j].iso);
        if (dd >= -before && dd <= after) pairs.push([Math.abs(dd), tk[i].iso, i, j]);
      });
    });
    pairs.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    pairs.forEach((p) => {
      if (ynabToCsv[p[2]] !== undefined || csvUsed[p[3]]) return;
      ynabToCsv[p[2]] = p[3];
      csvUsed[p[3]] = true;
    });
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
    const profit = Math.round((o.points * pointValue - fee) * 100) / 100;
    out.push([
      isoToDate_(o.iso), 'TAEKUS', o.account, o.payee, o.target, o.targetType, o.amount, o.bucket,
      o.points, pointValue, profit, o.amount ? profit / o.amount : 0, o.match, o.csvDesc, o.csvIso,
      o.id, o.memo, o.note, o.iso.slice(0, 7), o.group, fee
    ]);
  };

  tk.forEach((t, i) => {
    const last4 = last4ById[t.accountId];
    if (t.iso < isoAddDays_(mirrorMin, 0)) return;
    const j = ynabToCsv[i];
    const c = j === undefined ? null : csv[j];
    const dst = accounts[t.dstId] || null;
    let match = 'matched';
    if (!c) {
      if (!csvMax[last4]) match = 'no csv for account';
      else match = t.iso > csvMax[last4] ? 'awaiting csv' : 'no csv row';
    }

    const text = [t.payee, t.category, t.memo, dst ? dst.name : '', c ? c.desc + ' ' + c.merchant : ''].join(' ');
    let bucket = 'OTHER';
    let note = '';
    let pairedPayee = '';
    // YNAB category group "Transfer" (e.g. Transfer: Coinbase) names the target directly.
    const transferCat = t.catGroup.toLowerCase() === transferGroup && t.category ? t.category : '';
    if (dst && internalRx.test(dst.name)) bucket = 'INTERNAL';
    else if (dst && CFG.debtTypes.has(dst.type)) bucket = 'BILL_PAY';
    else if (cryptoRx.test(text)) bucket = 'MS_CRYPTO';
    else if (dst && paypalRx.test(dst.name)) {
      bucket = 'MS';
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
    const ov = overrides[t.id];
    if (ov) {
      if (ov.bucket) bucket = ov.bucket;
      if (ov.points !== null) points = ov.points;
      match = match + ' (override)';
      if (ov.notes) note = note ? note + '; ' + ov.notes : ov.notes;
    }

    emit({
      iso: t.iso, account: t.account, payee: t.payee, target: dst ? dst.name : t.payee,
      targetType: dst ? dst.type : '', amount: t.outflow, bucket: bucket, points: points, match: match,
      csvDesc: c ? c.desc : '', csvIso: c ? c.iso : '', id: t.id, memo: t.memo, note: note, fee: t.fee,
      group: (pairedPayee && targetGroup_([pairedPayee], aliases)) ||
        (transferCat && (targetGroup_([transferCat], aliases) || transferCat)) ||
        targetGroup_([dst ? dst.name : '', t.payee, c ? c.desc : ''], aliases) || (dst ? dst.name : t.payee)
    });
  });

  // Taekus outflows with no YNAB transaction (only where the mirror covers the dates).
  csv.forEach((c, j) => {
    if (csvUsed[j] || c.iso < isoAddDays_(mirrorMin, after)) return;
    const accId = taekusByLast4[c.last4];
    emit({
      iso: c.iso, account: accounts[accId].name, payee: c.desc, target: c.merchant || c.desc, targetType: '',
      amount: c.amount, bucket: 'REVIEW', points: c.points, match: 'not in YNAB', csvDesc: c.desc,
      csvIso: c.iso, id: '', memo: '', note: c.key,
      group: targetGroup_([c.desc, c.merchant], aliases) || c.desc
    });
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
  sheet.getRange('A1:G1').setValues([['Transfers', 'Amount', 'Points', 'Fees', 'Profit (net)', 'Avg rate', 'Last 30 days profit']]);
  sheet.getRange('A2:G2').setFormulas([[
    `=COUNTIF('${L}'!H:H,"${bucket}")`,
    `=SUMIFS('${L}'!G:G,'${L}'!H:H,"${bucket}")`,
    `=SUMIFS('${L}'!I:I,'${L}'!H:H,"${bucket}")`,
    `=SUMIFS('${L}'!U:U,'${L}'!H:H,"${bucket}")`,
    `=SUMIFS('${L}'!K:K,'${L}'!H:H,"${bucket}")`,
    '=IFERROR(E2/B2,0)',
    `=SUMIFS('${L}'!K:K,'${L}'!H:H,"${bucket}",'${L}'!A:A,">="&(TODAY()-30))`
  ]]);
  sheet.getRange('A1:G1').setFontWeight('bold');
  sheet.getRange('B2').setNumberFormat('$#,##0.00');
  sheet.getRange('C2').setNumberFormat('#,##0');
  sheet.getRange('D2:E2').setNumberFormat('$#,##0.00');
  sheet.getRange('F2').setNumberFormat('0.00%');
  sheet.getRange('G2').setNumberFormat('$#,##0.00');

  // Transactions: A4:M
  sheet.getRange('A4').setFormula(
    `=IFERROR(QUERY('${L}'!A1:U,"select A,C,D,T,G,I,U,K,L,M,R,Q,P where H = '${bucket}' order by A desc ` +
    `label A 'date', C 'account', D 'payee', T 'target', G 'amount', I 'points', U 'fee', K 'profit', L 'rate', ` +
    `M 'match', R 'note', Q 'memo', P 'ynab_txn_id'",1),"")`);
  // Monthly: O4:T
  sheet.getRange('O4').setFormula(
    `=IFERROR(QUERY('${L}'!A1:U,"select S, count(G), sum(G), sum(I), sum(U), sum(K) where H = '${bucket}' group by S order by S desc ` +
    `label S 'month', count(G) 'transfers', sum(G) 'amount', sum(I) 'points', sum(U) 'fees', sum(K) 'profit'",1),"")`);
  sheet.getRange('A5:A').setNumberFormat('yyyy-mm-dd');
  sheet.getRange('E5:E').setNumberFormat('$#,##0.00');
  sheet.getRange('F5:F').setNumberFormat('#,##0');
  sheet.getRange('G5:H').setNumberFormat('$#,##0.00');
  sheet.getRange('I5:I').setNumberFormat('0.00%');
  sheet.getRange('Q5:Q').setNumberFormat('$#,##0.00');
  sheet.getRange('R5:R').setNumberFormat('#,##0');
  sheet.getRange('S5:T').setNumberFormat('$#,##0.00');
  sheet.getRange('A4:T4').setFontWeight('bold');
  sheet.setFrozenRows(4);
}
