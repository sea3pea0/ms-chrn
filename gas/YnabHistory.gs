/**
 * Full YNAB history from the CSV export.
 *
 * The YNAB API only returns about the last 12 months, so the YNAB mirror sheet starts
 * there. importYnabHistory() loads the newest export in Drive folder
 * "Churning & MS > YNAB Transaction CSVs" into YNAB_History (re-imported only when a
 * newer file appears). combinedMirror_() returns the API mirror plus the history rows
 * dated before the mirror starts, in mirror format, for the ledger and target stats.
 */

const YH_CFG = {
  folder: 'YNAB Transaction CSVs',
  sheet: 'YNAB_History',
  headers: ['Account', 'Flag', 'Date', 'Payee', 'Category Group/Category', 'Category Group', 'Category', 'Memo',
    'Outflow', 'Inflow', 'Cleared'],
  propKey: 'YNAB_HISTORY_FILE'
};

let combinedMirrorCache_ = null;

function importYnabHistory(force) {
  const it = DriveApp.getFoldersByName(YH_CFG.folder);
  if (!it.hasNext()) throw new Error('Drive folder "' + YH_CFG.folder + '" not found.');
  let newest = null;
  const files = it.next().getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.isTrashed() || !/\.csv$/i.test(f.getName())) continue;
    if (!newest || f.getLastUpdated() > newest.getLastUpdated()) newest = f;
  }
  if (!newest) return 0;

  const props = PropertiesService.getDocumentProperties();
  const stamp = newest.getId() + '@' + newest.getLastUpdated().getTime();
  const ss = SpreadsheetApp.getActive();
  const sh = ensureSheet_(ss, YH_CFG.sheet);
  if (force !== true && props.getProperty(YH_CFG.propKey) === stamp && sh.getLastRow() > 1) return 0;

  const table = Utilities.parseCsv(newest.getBlob().getDataAsString('UTF-8').replace(/^﻿/, ''));
  const h = mapHeaderIndexes_(table[0] || []);
  YH_CFG.headers.forEach((k) => {
    if (h[k] === undefined) throw new Error('YNAB export ' + newest.getName() + ' is missing column ' + k);
  });
  const rows = table.slice(1).filter((r) => r.length > 1).map((r) => YH_CFG.headers.map((k) => r[h[k]]));

  sh.clearContents();
  const w = YH_CFG.headers.length;
  sh.getRange(1, 1, 1, w).setValues([YH_CFG.headers]);
  sh.setFrozenRows(1);
  if (rows.length) {
    const rng = sh.getRange(2, 1, rows.length, w);
    rng.setNumberFormat('@');
    rng.setValues(rows);
  }
  props.setProperty(YH_CFG.propKey, stamp);
  combinedMirrorCache_ = null;
  console.log('YNAB_History: ' + rows.length + ' rows from ' + newest.getName());
  return rows.length;
}

/** API mirror + older history rows, as one mirror-format table (header first). */
function combinedMirror_() {
  if (combinedMirrorCache_) return combinedMirrorCache_;
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();
  const mirror = ss.getSheetByName(CFG.sheets.ynabMirror).getDataRange().getValues();
  const hist = ss.getSheetByName(YH_CFG.sheet);
  const accounts = ss.getSheetByName(CFG.sheets.ynabAccounts).getDataRange().getValues();
  combinedMirrorCache_ = mergeHistoryIntoMirror_(mirror, hist ? hist.getDataRange().getValues() : [], accounts, tz);
  return combinedMirrorCache_;
}

/** Pure: mirror rows as-is, then history rows dated before the first mirror date. */
function mergeHistoryIntoMirror_(mirror, history, accounts, tz) {
  const w = CFG.mirrorHeaders.length;
  const mh = mapHeaderIndexes_(mirror[0] || CFG.mirrorHeaders);
  const out = [CFG.mirrorHeaders.slice()];
  let first = '';
  mirror.slice(1).forEach((r) => {
    const iso = cellIso_(r[mh.Date], tz);
    if (iso && (!first || iso < first)) first = iso;
    out.push(CFG.mirrorHeaders.map((k) => (mh[k] === undefined ? '' : r[mh[k]])));
  });
  if (history.length > 1) historyToMirrorRows_(history, accounts, first, tz).forEach((r) => out.push(r));
  out.forEach((r) => { while (r.length < w) r.push(''); });
  return out;
}

/**
 * Pure: YNAB CSV export rows dated before beforeIso (all if empty) -> mirror rows.
 * Split lines ("Split (i/n)" memos) are merged into one parent row like the API returns:
 * net amount, the largest line's payee/category/transfer, fee lines summed into split_fee.
 */
function historyToMirrorRows_(history, accounts, beforeIso, tz) {
  const h = mapHeaderIndexes_(history[0]);
  const ah = mapHeaderIndexes_(accounts[0] || []);
  const idByName = {};
  accounts.slice(1).forEach((r) => { idByName[String(r[ah.account_name] || '')] = String(r[ah.account_id] || ''); });
  const feeRx = /\bfees?\b/i;

  const lines = [];
  history.slice(1).forEach((r) => {
    const iso = cellIso_(r[h.Date], tz);
    if (!iso || (beforeIso && iso >= beforeIso)) return;
    lines.push({
      account: String(r[h.Account] || ''), flag: r[h.Flag] || '', iso: iso, payee: String(r[h.Payee] || ''),
      cgc: String(r[h['Category Group/Category']] || ''), group: String(r[h['Category Group']] || ''),
      category: String(r[h.Category] || ''), memo: String(r[h.Memo] || ''),
      out: toNumber_(r[h.Outflow]), inn: toNumber_(r[h.Inflow]), cleared: String(r[h.Cleared] || '')
    });
  });

  // Merge split groups: consecutive lines, same account + date, memos Split (1/n) .. (n/n).
  const txns = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].memo.match(/^Split \((\d+)\/(\d+)\)\s*/);
    if (!m || m[1] !== '1') { txns.push({ main: lines[i], parts: [lines[i]] }); continue; }
    const n = Number(m[2]);
    const parts = [lines[i]];
    while (parts.length < n && i + 1 < lines.length) {
      const nx = lines[i + 1];
      const mm = nx.memo.match(/^Split \((\d+)\/(\d+)\)/);
      if (!mm || Number(mm[1]) !== parts.length + 1 || nx.account !== lines[i].account || nx.iso !== lines[i].iso) break;
      parts.push(nx);
      i += 1;
    }
    const main = parts.slice().sort((a, b) => (b.out + b.inn) - (a.out + a.inn))[0];
    txns.push({ main: main, parts: parts, split: parts.length > 1 });
  }

  const seen = {};
  return txns.map((t) => {
    const net = t.parts.reduce((s, p) => s + p.inn - p.out, 0);
    const fee = t.split
      ? t.parts.filter((p) => p.out > 0 && feeRx.test([p.group, p.category, p.payee].join(' '))).reduce((s, p) => s + p.out, 0)
      : 0;
    const main = t.main;
    const tm = main.payee.match(/^Transfer : (.+)$/);
    const memo = main.memo.replace(/^Split \(\d+\/\d+\)\s*/, '');
    const base = ['csv', main.account, main.iso, Math.round(net * 100), main.payee].join('|');
    seen[base] = (seen[base] || 0) + 1;
    return [
      main.account, main.flag, main.iso, main.payee,
      main.cgc, main.group, main.category, memo,
      net < 0 ? Math.round(-net * 100) / 100 : 0, net > 0 ? Math.round(net * 100) / 100 : 0, main.cleared,
      base + '|' + seen[base], idByName[main.account] || '', tm ? idByName[tm[1].trim()] || '' : '',
      false, true, main.flag, '', main.iso, 'csv_history', Math.round(fee * 100) / 100
    ];
  });
}
