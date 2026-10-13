/**
 * Cash Back Rates computation (Google Apps Script port of build_cashback_rates.py).
 *
 * Reads Taekus (ALT), Fluz, and Blue Penguin CSVs from the Drive mirror folder
 * and rewrites the "Cash Back Rates" sheet with one row per Source/Target/Type:
 *   Source, Target, CBR, CBR Date, High CBR, High CBR Date, Type
 *
 * Taekus/BLUPE have no API, so refresh by dropping new CSVs into the Drive folder
 * and running buildCashBackRatesSheet() (also called from the YNAB sync).
 */

const RATES_CFG = {
  sheetName: 'Cash Back Rates',
  headers: ['Source', 'Target', 'CBR', 'CBR Date', 'High CBR', 'High CBR Date', 'Type'],
  pointValue: 0.01,
  taekusMinAmount: 200,
  // Drive filename fragments.
  tkbFragment: 'ALT Business Debit-0523',
  tkpFragment: 'ALT Personal Debit-7840',
  fluzFragment: 'fluz_all_transactions',
  blupeFragment: 'BLUPE_settlement_report',
  blupeDefaultShare: 0.697
};

// Ordered keyword rules: [ [keywords...], target, type ]. First match wins.
const TKB_RULES = [
  [['metapay'], 'MetaPay', 'MS'],
  [['moneylion', 'money lion', 'ml spend transfer', 'roarmoney'], 'MOLI', 'MS'],
  [['current account depos'], 'CURR', 'MS'],
  [['chime'], 'CHME', 'MS'],
  [['lemfi'], 'Lemfi', 'MS'],
  [['wise'], 'Wise', 'MS'],
  [['onepay'], 'OnePay', 'MS'],
  [['sling', 'morse'], 'Sling Money', 'MS'],
  [['skrill', 'skrillusa'], 'Skrill', 'MS'],
  [['revolut'], 'Revolut', 'MS'],
  [['robinhood'], 'Robinhood', 'MS-Crypto'],
  [['uphold'], 'Uphold', 'MS-Crypto'],
  [['coinbase'], 'Coinbase', 'MS-Crypto'],
  [['transak'], 'Transak', 'MS-Crypto'],
  [['moonpay'], 'MoonPay', 'MS-Crypto'],
  [['usdc'], 'USDC', 'MS-Crypto'],
  [['phantom', 'meld'], 'Phantom', 'MS-Crypto'],
  [['citibank'], 'Citi', 'Bill Pay'],
  [['syncb', 'synchrony'], 'Synchrony', 'Bill Pay']
];

const TKP_RULES = [
  [['coinbase', 'pyusd', 'crypto hub'], 'PP', 'MS-Crypto'],
  [['robinhood'], 'Robinhood', 'MS-Crypto'],
  [['sling', 'morse'], 'Sling Money', 'MS'],
  [['revolut'], 'Revolut', 'MS'],
  [['skrill'], 'Skrill', 'MS']
];

const FLUZ_RULES = [
  [['roarmoney', 'moneylion'], 'MOLI', 'MS'],
  [['skrill'], 'Skrill', 'MS'],
  [['western union'], 'Western Union', 'MS'],
  [['sling', 'morse'], 'Sling Money', 'MS'],
  [['astra'], 'Astra', 'MS'],
  [['paypal'], 'PP', 'MS-Crypto'],
  [['one finance', 'one'], 'OnePay', 'MS'],
  [['coinbase'], 'Coinbase', 'MS-Crypto'],
  [['robinhood'], 'Robinhood', 'MS-Crypto'],
  [['citi'], 'Citi', 'Bill Pay'],
  [['synchrony'], 'Synchrony', 'Bill Pay']
];

const BLUPE_RULES = [
  [['americanexp', 'amex'], 'Amex', 'Bill Pay'],
  [['bankamerica', 'bank of america'], 'BofA', 'Bill Pay'],
  [['barclay'], 'Barclays', 'Bill Pay'],
  [['citibank', 'citi'], 'Citi', 'Bill Pay'],
  [['discover'], 'Discover', 'Bill Pay'],
  [['robinhood', 'rhs brokerage', 'rh brokerage'], 'Robinhood', 'Bill Pay'],
  [['step.com', 'step '], 'Step', 'MS']
];

const FLUZ_SPEND_TYPES = { 'Virtual Card Purchase': 1, 'Gift Card Purchase': 1 };


/** Entry point: rebuild the Cash Back Rates sheet from the Drive CSVs. */
function buildCashBackRatesSheet() {
  const folderId = ratesDriveFolderId_();
  let obs = [];
  obs = obs.concat(collectTaekus_(folderId));
  obs = obs.concat(collectFluz_(folderId));
  obs = obs.concat(collectBlupe_(folderId));
  const rows = observationsToRateRows_(obs);
  writeRatesSheet_(rows);
  Logger.log(`Cash Back Rates rebuilt: ${rows.length} rows from ${obs.length} observations.`);
  return rows.length;
}

function ratesDriveFolderId_() {
  const prop = PropertiesService.getScriptProperties().getProperty('DRIVE_ROOT_ID');
  if (prop) return prop;
  if (typeof FLUZ_CFG !== 'undefined' && FLUZ_CFG.driveFolderId) return FLUZ_CFG.driveFolderId;
  throw new Error('No Drive folder id (set DRIVE_ROOT_ID script property).');
}

function matchRateRules_(text, rules) {
  const t = String(text || '').toLowerCase();
  for (let i = 0; i < rules.length; i += 1) {
    const keywords = rules[i][0];
    for (let j = 0; j < keywords.length; j += 1) {
      if (t.indexOf(keywords[j]) !== -1) return { target: rules[i][1], type: rules[i][2] };
    }
  }
  return null;
}

/** Read and concatenate rows from every Drive file whose name contains fragment. */
function readCsvRowsFromDrive_(folderId, fragment) {
  const files = DriveApp.getFolderById(folderId).getFiles();
  const out = [];
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().indexOf(fragment) === -1) continue;
    const table = Utilities.parseCsv(f.getBlob().getDataAsString('UTF-8'));
    if (table.length < 2) continue;
    const header = table[0].map((h) => String(h).trim());
    for (let i = 1; i < table.length; i += 1) {
      const o = {};
      header.forEach((h, idx) => { o[h] = table[i][idx]; });
      out.push(o);
    }
  }
  return out;
}

function ratesToNumber_(v) {
  const cleaned = String(v == null ? '' : v).replace(/[$,%]/g, '').trim();
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return isFinite(n) ? n : 0;
}

function parseAltDate_(s) {
  const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
}

function parseFluzDateObj_(s) {
  const m = String(s || '').match(/[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{2}) (\d{4})/);
  if (!m) return null;
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  return new Date(Date.UTC(Number(m[3]), months[m[1]], Number(m[2])));
}

function collectTaekus_(folderId) {
  const out = [];
  [['TKB', RATES_CFG.tkbFragment, TKB_RULES], ['TKP', RATES_CFG.tkpFragment, TKP_RULES]].forEach((spec) => {
    const source = spec[0];
    const rules = spec[2];
    readCsvRowsFromDrive_(folderId, spec[1]).forEach((r) => {
      const amt = ratesToNumber_(r['transaction amount']);
      const pts = ratesToNumber_(r['points credited']);
      const when = parseAltDate_(r.date);
      if (!when || pts <= 0 || amt >= 0 || Math.abs(amt) < RATES_CFG.taekusMinAmount) return;
      const hit = matchRateRules_((r.description || '') + ' ' + (r.merchant || ''), rules);
      if (!hit) return;
      out.push({ source: source, target: hit.target, type: hit.type, date: when, cbr: pts / Math.abs(amt) * RATES_CFG.pointValue });
    });
  });
  return out;
}

function collectFluz_(folderId) {
  const out = [];
  readCsvRowsFromDrive_(folderId, RATES_CFG.fluzFragment).forEach((r) => {
    if (!FLUZ_SPEND_TYPES[String(r.Type || '').trim()]) return;
    const amt = ratesToNumber_(r.Amount);
    const cb = ratesToNumber_(r.Cashback);
    const when = parseFluzDateObj_(r['Created At']);
    if (!when || amt >= 0 || cb <= 0) return;
    const hit = matchRateRules_(r.Destination, FLUZ_RULES);
    if (!hit) return;
    out.push({ source: 'FLUZ', target: hit.target, type: hit.type, date: when, cbr: cb / Math.abs(amt) });
  });
  return out;
}

function collectBlupe_(folderId) {
  const settle = readCsvRowsFromDrive_(folderId, RATES_CFG.blupeFragment);
  if (!settle.length) return [];
  const share = blupeShareRatio_(settle);
  const out = [];
  settle.forEach((r) => {
    if (String(r.Type || '').trim() !== 'Settle') return;
    const amt = ratesToNumber_(r.Amount);
    const interchange = ratesToNumber_(r.Interchange);
    if (amt <= 0 || interchange <= 0) return;
    const d = String(r.DateTime || '').match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!d) return;
    const when = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])));
    const hit = matchRateRules_(r.Description, BLUPE_RULES);
    if (!hit) return;
    out.push({ source: 'BLUPE', target: hit.target, type: hit.type, date: when, cbr: (interchange / amt) * share });
  });
  return out;
}

/** Median monthly (BLUPE cashback deposit / interchange) with ~2-month payout lag. */
function blupeShareRatio_(settleRows) {
  const ym = (y, mo) => y * 12 + mo;
  const interchangeByMonth = {};
  settleRows.forEach((r) => {
    if (String(r.Type || '').trim() !== 'Settle') return;
    const d = String(r.DateTime || '').match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!d) return;
    const key = ym(Number(d[1]), Number(d[2]));
    interchangeByMonth[key] = (interchangeByMonth[key] || 0) + ratesToNumber_(r.Interchange);
  });

  // Cash-back deposits come from the YNAB mirror (BLUPE account inflows).
  const cashbackByMonth = {};
  const mirror = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.ynabMirror);
  if (mirror) {
    const values = mirror.getDataRange().getValues();
    if (values.length > 1) {
      const h = mapHeaderIndexes_(values[0]);
      for (let i = 1; i < values.length; i += 1) {
        const row = values[i];
        if (String(row[h.Account] || '').trim() !== 'BLUPE') continue;
        const payee = String(row[h.Payee] || '').toLowerCase();
        const category = String(row[h.Category] || '').toLowerCase();
        const inflow = toNumber_(row[h.Inflow]);
        if (inflow <= 0) continue;
        if (!(payee.indexOf('blue penguin') !== -1 || category.indexOf('cash back') !== -1 || category.indexOf('reward') !== -1)) continue;
        const dm = String(row[h.Date] || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (!dm) continue;
        const key = ym(Number(dm[3]), Number(dm[1]));
        cashbackByMonth[key] = (cashbackByMonth[key] || 0) + inflow;
      }
    }
  }

  const ratios = [];
  Object.keys(cashbackByMonth).forEach((depMonth) => {
    const spendMonth = Number(depMonth) - 2;
    const ic = interchangeByMonth[spendMonth] || 0;
    if (ic > 0) ratios.push(cashbackByMonth[depMonth] / ic);
  });
  if (!ratios.length) return RATES_CFG.blupeDefaultShare;
  ratios.sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  return ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
}

function observationsToRateRows_(observations) {
  const buckets = {};
  observations.forEach((o) => {
    const key = o.source + '|' + o.target + '|' + o.type;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(o);
  });

  const rows = [];
  Object.keys(buckets).forEach((key) => {
    const obs = buckets[key];
    let latest = obs[0];
    let high = obs[0];
    obs.forEach((o) => {
      if (o.date > latest.date) latest = o;
      if (o.cbr > high.cbr || (o.cbr === high.cbr && o.date > high.date)) high = o;
    });
    const parts = key.split('|');
    rows.push([
      parts[0],
      parts[1],
      (latest.cbr * 100).toFixed(2) + '%',
      Utilities.formatDate(latest.date, 'UTC', 'yyyy-MM-dd'),
      (high.cbr * 100).toFixed(2) + '%',
      Utilities.formatDate(high.date, 'UTC', 'yyyy-MM-dd'),
      parts[2]
    ]);
  });
  // Most recent CBR Date on top.
  rows.sort((a, b) => (a[3] < b[3] ? 1 : a[3] > b[3] ? -1 : 0));
  return rows;
}

function writeRatesSheet_(rows) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(RATES_CFG.sheetName);
  if (!sheet) sheet = ss.insertSheet(RATES_CFG.sheetName);
  sheet.clear();
  sheet.getRange(1, 1, 1, RATES_CFG.headers.length).setValues([RATES_CFG.headers]);
  sheet.setFrozenRows(1);
  if (rows.length) sheet.getRange(2, 1, rows.length, RATES_CFG.headers.length).setValues(rows);
}

/** Read the Cash Back Rates sheet into a lookup map: "SOURCE|TARGET" -> {rate, type}. */
function readCurrentRates_() {
  const map = {};
  const sh = SpreadsheetApp.getActive().getSheetByName(RATES_CFG.sheetName);
  if (!sh) return map;
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    const src = String(values[i][0] || '').trim().toUpperCase();
    const tgt = String(values[i][1] || '').trim().toUpperCase();
    if (!src || !tgt) continue;
    map[src + '|' + tgt] = { rate: ratesToNumber_(values[i][2]) / 100, type: String(values[i][6] || '').trim() };
  }
  return map;
}

/** Find the current CBR for a transaction by trying each candidate target. */
function lookupRouteCbr_(ratesMap, source, targetCandidates) {
  const src = String(source || '').toUpperCase();
  for (let i = 0; i < targetCandidates.length; i += 1) {
    const t = String(targetCandidates[i] || '').trim().toUpperCase();
    if (t && ratesMap[src + '|' + t]) return ratesMap[src + '|' + t];
  }
  return null;
}
