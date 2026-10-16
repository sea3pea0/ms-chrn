/**
 * Per-target money in / money out / cash back (all time, yearly, monthly).
 *
 * rebuildTargetStats() writes Target_Stats from Transfer_Ledger and the YNAB mirror:
 *   money out = YNAB outflows from any account to the target (category Transfer: X,
 *               payee/category alias, or a transfer into one of its accounts)
 *   money in  = YNAB inflows into any account from the target, same matching
 *   cash back = profit on tracked transfers (Transfer_Ledger MS, MS_CRYPTO, BILL_PAY)
 * Moves inside the target itself (e.g. between two MoneyLion accounts) are ignored.
 * Targets are grouped by Config target_aliases (LemFi, MoneyLion, Coinbase, PYUSD, ...).
 *
 * setupTargetDashboard() builds the Targets sheet: pick a target in B1 and the tables
 * and charts follow; the bottom section compares all targets.
 */

const TARGET_CFG = {
  statsSheet: 'Target_Stats',
  dashSheet: 'Targets',
  statsHeaders: ['target', 'period_type', 'period', 'money_in', 'money_out', 'cash_back', 'transfers'],
  buckets: new Set(['MS', 'MS_CRYPTO', 'BILL_PAY']),
  listCol: 26 // Z: dropdown source list on the Targets sheet
};

function rebuildTargetStats() {
  const ss = SpreadsheetApp.getActive();
  const rows = buildTargetStatsRows_({
    ledger: ss.getSheetByName(XFER_CFG.sheets.ledger).getDataRange().getValues(),
    mirror: combinedMirror_(),
    cfg: xferConfig_(),
    tz: ss.getSpreadsheetTimeZone()
  });
  const sh = ensureSheet_(ss, TARGET_CFG.statsSheet);
  const w = TARGET_CFG.statsHeaders.length;
  sh.clearContents();
  sh.getRange(1, 1, 1, w).setValues([TARGET_CFG.statsHeaders]);
  sh.setFrozenRows(1);
  if (rows.length) {
    sh.getRange(2, 3, rows.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, rows.length, w).setValues(rows);
    sh.getRange(2, 4, rows.length, 3).setNumberFormat('$#,##0.00');
  }

  // Dropdown list for the dashboard: targets by all-time money out.
  const dash = ss.getSheetByName(TARGET_CFG.dashSheet);
  if (dash) {
    const names = rows.filter((r) => r[1] === 'all' && (r[3] || r[4] || r[5])).sort((a, b) => b[4] - a[4]).map((r) => [r[0]]);
    dash.getRange(1, TARGET_CFG.listCol, Math.max(dash.getMaxRows(), 1), 1).clearContent();
    dash.getRange(1, TARGET_CFG.listCol).setValue('targets');
    if (names.length) dash.getRange(2, TARGET_CFG.listCol, names.length, 1).setValues(names);
  }
  console.log('Target_Stats: ' + rows.length + ' rows');
  return rows.length;
}

/** Pure function (no Apps Script services) so it can be tested offline. */
function buildTargetStatsRows_(input) {
  const aliases = targetAliases_(input.cfg);
  const transferGroup = String(input.cfg.transfer_rules.transfer_category_group || 'Transfer').toLowerCase();
  const stats = {};
  const add = (group, iso, field, v) => {
    [['all', 'all'], ['year', iso.slice(0, 4)], ['month', iso.slice(0, 7)]].forEach((p) => {
      const k = group + '\u0001' + p[0] + '\u0001' + p[1];
      const s = stats[k] || (stats[k] = { group: group, type: p[0], period: p[1], money_in: 0, money_out: 0, cash_back: 0, transfers: 0 });
      s[field] += v;
    });
  };

  // Cash back (and transfer count) from the ledger.
  const lh = mapHeaderIndexes_(input.ledger[0] || []);
  const groups = new Set(aliases.map((a) => a[0]));
  input.ledger.slice(1).forEach((r) => {
    if (!TARGET_CFG.buckets.has(String(r[lh.bucket]))) return;
    const iso = cellIso_(r[lh.date], input.tz);
    const group = String(r[lh.target_group] || r[lh.target] || '').trim();
    if (!iso || !group) return;
    groups.add(group);
    add(group, iso, 'cash_back', toNumber_(r[lh.profit]));
    add(group, iso, 'transfers', 1);
  });

  // Money in / out from every YNAB account (all sources, not only tracked ones).
  const mh = mapHeaderIndexes_(input.mirror[0] || []);
  input.mirror.slice(1).forEach((r) => {
    if (String(r[mh.deleted]).toLowerCase() === 'true') return;
    const inflow = toNumber_(r[mh.Inflow]);
    const outflow = toNumber_(r[mh.Outflow]);
    if (!(inflow > 0) && !(outflow > 0)) return;
    const payee = String(r[mh.Payee] || '');
    const category = String(r[mh.Category] || '');
    let group = '';
    if (String(r[mh['Category Group']] || '').toLowerCase() === transferGroup && category) {
      group = targetGroup_([category], aliases) || category;
      groups.add(group);
    }
    if (!group) group = targetGroup_([payee, category], aliases);
    if (!group) {
      const m = payee.match(/^Transfer : (.+)$/);
      if (m && groups.has(m[1].trim())) group = m[1].trim();
    }
    if (!group || !groups.has(group)) return;
    const account = String(r[mh.Account] || '');
    if ((targetGroup_([account], aliases) || account) === group) return;
    const iso = cellIso_(r[mh.Date], input.tz);
    if (!iso) return;
    if (inflow > 0) add(group, iso, 'money_in', inflow);
    else add(group, iso, 'money_out', outflow);
  });

  const order = { all: 0, year: 1, month: 2 };
  const r2 = (x) => Math.round(x * 100) / 100;
  return Object.values(stats)
    .sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) ||
      order[a.type] - order[b.type] || (a.period < b.period ? -1 : a.period > b.period ? 1 : 0))
    .map((s) => [s.group, s.type, s.period, r2(s.money_in), r2(s.money_out), r2(s.cash_back), s.transfers]);
}

function setupTargetDashboard() {
  const ss = SpreadsheetApp.getActive();
  const sh = ensureSheet_(ss, TARGET_CFG.dashSheet);
  const S = TARGET_CFG.statsSheet;
  sh.getCharts().forEach((c) => sh.removeChart(c));
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearDataValidations();
  rebuildTargetStats();

  // Selector
  const listCol = String.fromCharCode(64 + TARGET_CFG.listCol);
  sh.getRange('A1').setValue('Target').setFontWeight('bold');
  sh.getRange('B1').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(sh.getRange(`${listCol}2:${listCol}`), true).setAllowInvalid(false).build());
  const first = sh.getRange(2, TARGET_CFG.listCol).getValue();
  sh.getRange('B1').setValue(first || '').setFontWeight('bold').setBackground('#fff2cc');
  sh.hideColumns(TARGET_CFG.listCol);

  // All time for the selected target
  sh.getRange('A3:F3').setValues([['All time', 'Money in', 'Money out', 'Cash back', 'Net (in - out)', 'Transfers']]);
  const sumAll = (col) => `=SUMIFS('${S}'!${col}:${col},'${S}'!A:A,$B$1,'${S}'!B:B,"all")`;
  sh.getRange('A4:F4').setFormulas([['=$B$1', sumAll('D'), sumAll('E'), sumAll('F'), '=B4-C4', sumAll('G')]]);

  // By year (A7:D) and last 24 months (F7:I)
  sh.getRange('A6').setValue('By year');
  sh.getRange('A7').setFormula(
    `=IFERROR(QUERY('${S}'!A:G,"select C,D,E,F where A='"&$B$1&"' and B='year' order by C ` +
    `label C 'year', D 'money in', E 'money out', F 'cash back'",1),"")`);
  sh.getRange('F6').setValue('By month (last 24)');
  sh.getRange('F7:I7').setValues([['month', 'money in', 'money out', 'cash back']]);
  sh.getRange('F8').setFormula(
    `=IFERROR(SORT(QUERY('${S}'!A:G,"select C,D,E,F where A='"&$B$1&"' and B='month' order by C desc limit 24",0),1,TRUE),"")`);

  // All targets, all time (A35:E)
  sh.getRange('A34').setValue('All targets, all time');
  sh.getRange('A35').setFormula(
    `=IFERROR(QUERY('${S}'!A:G,"select A,D,E,F,G where B='all' order by E desc ` +
    `label A 'target', D 'money in', E 'money out', F 'cash back', G 'transfers'",1),"")`);

  ['A3:F3', 'A6', 'F6', 'A7:D7', 'F7:I7', 'A34', 'A35:E35'].forEach((a) => sh.getRange(a).setFontWeight('bold'));
  ['B4:E4', 'B8:D20', 'G8:I31', 'B36:D80'].forEach((a) => sh.getRange(a).setNumberFormat('$#,##0'));
  sh.getRange('F8:F31').setNumberFormat('@');

  const combo = (range, title, row, col) => sh.insertChart(sh.newChart()
    .asComboChart()
    .addRange(sh.getRange(range))
    .setNumHeaders(1)
    .setOption('title', title)
    .setOption('seriesType', 'bars')
    .setOption('series', { 2: { type: 'line', targetAxisIndex: 1, pointSize: 5 } })
    .setOption('vAxes', { 0: { title: 'Money in / out', format: '$#,##0' }, 1: { title: 'Cash back', format: '$#,##0' } })
    .setOption('legend', { position: 'top' })
    .setOption('width', 760)
    .setOption('height', 330)
    .setPosition(row, col, 0, 0)
    .build());
  combo('A7:D17', 'Selected target by year (B1)', 3, 11);
  combo('F7:I31', 'Selected target by month (B1)', 20, 11);
  combo('A35:D55', 'All targets, all time (top 20 by money out)', 37, 11);
  sh.setFrozenRows(1);
}
