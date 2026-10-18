/**
 * Per-target cash back (all time, yearly, monthly) and balance.
 *
 * rebuildTargetStats() writes Target_Stats from Transfer_Ledger, the Bank Bonus & Referrals
 * rows and the YNAB mirror:
 *   cash back = profit on tracked transfers (MS, MS_CRYPTO, BILL_PAY), or the bonus itself
 *   group     = MS / MS-Crypto / Bill Pay (where the target earned the most cash back), or
 *               Bank Bonus & Referrals
 *   balance   = the YNAB balance of the target's own accounts (MoneyLion, Chime, Current, a credit
 *               card, ...), which nets every transaction in and out. Pass-through targets
 *               (TARGET_CFG.netFlowTargets: LemFi, Western Union) show transfers out minus
 *               transfers back in, which should end at 0; anything else means a transfer is
 *               missing or miscategorized in YNAB. MS-Crypto is one balance for the
 *               whole group: current Coinbase holdings (Coinbase_Balances, P1 + P2) plus the YNAB
 *               balance of any crypto accounts (e.g. a Robinhood brokerage account).
 *
 * setupTargetDashboard() builds the Targets sheet: pick a target in B1 for its balance and cash
 * back by year / month; below, every target grouped, highest-earning group first.
 */

const TARGET_CFG = {
  // Bump when the dashboard layout changes; the hourly sync rebuilds it once.
  version: '5',
  statsSheet: 'Target_Stats',
  dashSheet: 'Targets',
  statsHeaders: ['target', 'period_type', 'period', 'balance', 'cash_back', 'transfers', 'group'],
  groupLabels: { MS: 'MS', MS_CRYPTO: 'MS-Crypto', BILL_PAY: 'Bill Pay' },
  bonusGroup: 'Bank Bonus & Referrals',
  buckets: new Set(['MS', 'MS_CRYPTO', 'BILL_PAY']),
  listCol: 26, // Z: dropdown source list on the Targets sheet
  // Money sent here should all come back: balance = transfers out - transfers back in.
  netFlowTargets: ['LemFi', 'Western Union']
};

function rebuildTargetStats() {
  const ss = SpreadsheetApp.getActive();
  const cb = ss.getSheetByName(CB_CFG.balanceSheet);
  const coinbaseUsd = cb && cb.getLastRow() > 1
    ? cb.getRange(2, 5, cb.getLastRow() - 1, 1).getValues().reduce((s, r) => s + toNumber_(r[0]), 0) : 0;
  const mirror = combinedMirror_();
  const res = buildTargetStatsRows_({
    ledger: ss.getSheetByName(XFER_CFG.sheets.ledger).getDataRange().getValues(),
    mirror: mirror,
    accounts: ss.getSheetByName(CFG.sheets.ynabAccounts).getDataRange().getValues(),
    bonuses: buildBonusRows_(mirror, ss.getSpreadsheetTimeZone()),
    cfg: xferConfig_(),
    tz: ss.getSpreadsheetTimeZone()
  });
  const rows = res.rows;
  const sh = ensureSheet_(ss, TARGET_CFG.statsSheet);
  const w = TARGET_CFG.statsHeaders.length;
  sh.clearContents();
  sh.getRange(1, 1, 1, w).setValues([TARGET_CFG.statsHeaders]);
  sh.setFrozenRows(1);
  if (rows.length) {
    sh.getRange(2, 3, rows.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, rows.length, w).setValues(rows);
    sh.getRange(2, 4, rows.length, 2).setNumberFormat('$#,##0.00');
  }

  // A target is somewhere cash back was earned. Groups in order of total cash back, targets
  // within a group by cash back.
  const all = rows.filter((r) => r[1] === 'all' && r[4] > 0 && r[6]);
  const groupTotal = {};
  all.forEach((r) => { groupTotal[r[6]] = (groupTotal[r[6]] || 0) + r[4]; });
  const groupOrder = Object.keys(groupTotal).sort((a, b) => groupTotal[b] - groupTotal[a]);
  all.sort((a, b) => groupOrder.indexOf(a[6]) - groupOrder.indexOf(b[6]) || b[4] - a[4]);

  const dash = ss.getSheetByName(TARGET_CFG.dashSheet);
  if (dash) {
    dash.getRange(1, TARGET_CFG.listCol, Math.max(dash.getMaxRows(), 1), 1).clearContent();
    dash.getRange(1, TARGET_CFG.listCol).setValue('targets');
    if (all.length) dash.getRange(2, TARGET_CFG.listCol, all.length, 1).setValues(all.map((r) => [r[0]]));

    // Grouped table from A35, group totals (for the chart) at H35.
    dash.getRange('A35:E500').clearContent().setFontWeight('normal').setBackground(null);
    dash.getRange('H35:I40').clearContent();
    const out = [['target', 'balance', 'cash back', 'transfers', 'note']];
    const bold = [];
    groupOrder.forEach((g) => {
      const rs = all.filter((r) => r[6] === g);
      bold.push(out.length);
      let gBal = '';
      let note = '';
      if (g === TARGET_CFG.groupLabels.MS_CRYPTO) {
        gBal = Math.round((res.cryptoBalance + coinbaseUsd) * 100) / 100;
        note = 'one balance for all crypto targets: Coinbase holdings $' +
          Math.round(coinbaseUsd).toLocaleString('en-US') + ' + YNAB crypto accounts $' +
          Math.round(res.cryptoBalance).toLocaleString('en-US');
      } else if (g !== TARGET_CFG.bonusGroup) {
        gBal = rs.reduce((s, r) => s + (r[3] === '' ? 0 : r[3]), 0);
      }
      out.push([g, gBal, groupTotal[g], rs.reduce((s, r) => s + r[5], 0), note]);
      rs.forEach((r) => out.push(['   ' + r[0], r[3], r[4], r[5], '']));
    });
    dash.getRange(35, 1, out.length, 5).setValues(out);
    dash.getRange(35, 1, 1, 5).setFontWeight('bold');
    bold.forEach((i) => dash.getRange(35 + i, 1, 1, 5).setFontWeight('bold').setBackground('#eef3fb'));
    dash.getRange(36, 2, Math.max(out.length - 1, 1), 2).setNumberFormat('$#,##0');
    dash.getRange(35, 8, 1 + groupOrder.length, 2).setValues(
      [['group', 'cash back']].concat(groupOrder.map((g) => [g, Math.round(groupTotal[g] * 100) / 100])));
    dash.getRange(36, 9, Math.max(groupOrder.length, 1), 1).setNumberFormat('$#,##0');
  }
  console.log('Target_Stats: ' + rows.length + ' rows');
  return rows.length;
}

/** Pure function (no Apps Script services) so it can be tested offline. */
function buildTargetStatsRows_(input) {
  const aliases = targetAliases_(input.cfg);
  const stats = {};
  const add = (target, iso, field, v) => {
    [['all', 'all'], ['year', iso.slice(0, 4)], ['month', iso.slice(0, 7)]].forEach((p) => {
      const k = target + '\u0001' + p[0] + '\u0001' + p[1];
      const s = stats[k] || (stats[k] = { target: target, type: p[0], period: p[1], cash_back: 0, transfers: 0 });
      s[field] += v;
    });
  };

  // Cash back (and transfer count) from the ledger; each target's group = its best bucket.
  const lh = mapHeaderIndexes_(input.ledger[0] || []);
  const known = new Set(aliases.map((a) => a[0]));
  const byBucket = {};
  input.ledger.slice(1).forEach((r) => {
    if (!TARGET_CFG.buckets.has(String(r[lh.bucket]))) return;
    const iso = cellIso_(r[lh.date], input.tz);
    const target = String(r[lh.target_group] || r[lh.target] || '').trim();
    if (!iso || !target) return;
    known.add(target);
    add(target, iso, 'cash_back', toNumber_(r[lh.profit]));
    add(target, iso, 'transfers', 1);
    const b = String(r[lh.bucket]);
    byBucket[target] = byBucket[target] || {};
    byBucket[target][b] = (byBucket[target][b] || 0) + toNumber_(r[lh.profit]);
  });
  const groupOf = {};
  Object.keys(byBucket).forEach((t) => {
    const best = Object.keys(byBucket[t]).sort((a, b) => byBucket[t][b] - byBucket[t][a])[0];
    groupOf[t] = byBucket[t][best] > 0 ? TARGET_CFG.groupLabels[best] || best : '';
  });

  // Bank bonuses and referral rewards: the payer is the target, the bonus is the cash back.
  (input.bonuses || []).forEach((r) => {
    const target = String(r[3] || 'Unknown').split(' | ')[0].trim() || 'Unknown';
    if (groupOf[target] && groupOf[target] !== TARGET_CFG.bonusGroup) return;
    groupOf[target] = TARGET_CFG.bonusGroup;
    add(target, r[0], 'cash_back', r[4]);
    add(target, r[0], 'transfers', 1);
  });

  // Balance. Accounts that belong to a target: their YNAB balance. Other targets: net flow.
  const ah = mapHeaderIndexes_((input.accounts || [])[0] || []);
  const acctBalance = {};
  (input.accounts || []).slice(1).forEach((r) => {
    const name = String(r[ah.account_name] || '');
    if (!name) return;
    const t = targetGroup_([name], aliases) || name;
    if (!known.has(t)) return;
    acctBalance[t] = (acctBalance[t] || 0) + toNumber_(r[ah.balance]);
  });
  // MS-Crypto: one combined balance (YNAB crypto accounts here; Coinbase holdings added by caller).
  let cryptoBalance = 0;
  Object.keys(groupOf).forEach((t) => {
    if (groupOf[t] === TARGET_CFG.groupLabels.MS_CRYPTO) cryptoBalance += acctBalance[t] || 0;
  });
  // Pass-through targets: transfers out minus transfers back in, from every YNAB transaction whose
  // category, payee or split payee names the target. Spending paid through the target (a bill
  // categorized Mortgage, say) is not a transfer and is left out. A split that pays the target
  // and transfers straight to one of the user's accounts (Western Union: fee line + transfer to
  // SOFD) already shows the money back, so it nets to 0 and is skipped.
  const netFlow = {};
  const nfAliases = aliases.filter((a) => TARGET_CFG.netFlowTargets.indexOf(a[0]) >= 0);
  const mh = mapHeaderIndexes_((input.mirror || [])[0] || []);
  const transferGroup = String(((input.cfg || {}).transfer_rules || {}).transfer_category_group || 'Transfer')
    .toLowerCase();
  if (nfAliases.length && mh.Outflow !== undefined) {
    input.mirror.slice(1).forEach((r) => {
      if (String(r[mh.deleted]).toLowerCase() === 'true') return;
      const cat = String(r[mh.Category] || '').trim();
      const grp = String(r[mh['Category Group']] || '').trim().toLowerCase();
      const payee = String(r[mh.Payee] || '');
      const splitPayees = mh.split_payees === undefined ? [] : String(r[mh.split_payees] || '').split(' | ');
      const dst = String(r[mh.transfer_account_id] || '').trim();
      nfAliases.forEach((a) => {
        const rx = a[1];
        const byCat = rx.test(cat);
        const byPayee = rx.test(payee) || splitPayees.some((p) => rx.test(p));
        if (!byCat && !byPayee) return;
        if (!byCat && splitPayees.length > 1 && dst) return; // paid and transferred back in one split
        if (!byCat && dst) return;
        // Only transfer-like categories: the target's own, the Transfer group, or none yet.
        if (!byCat && cat && grp !== transferGroup && !/uncategorized|ready to assign/i.test(cat)) return;
        netFlow[a[0]] = (netFlow[a[0]] || 0) + toNumber_(r[mh.Outflow]) - toNumber_(r[mh.Inflow]);
      });
    });
  }
  const balanceOf = (t) => {
    if (t in netFlow) return Math.round(netFlow[t] * 100) / 100;
    const g = groupOf[t];
    if (!g || g === TARGET_CFG.bonusGroup || g === TARGET_CFG.groupLabels.MS_CRYPTO) return '';
    return t in acctBalance ? Math.round(acctBalance[t] * 100) / 100 : '';
  };

  const order = { all: 0, year: 1, month: 2 };
  const r2 = (x) => Math.round(x * 100) / 100;
  const rows = Object.values(stats)
    .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0) ||
      order[a.type] - order[b.type] || (a.period < b.period ? -1 : a.period > b.period ? 1 : 0))
    .map((s) => [s.target, s.type, s.period, s.type === 'all' ? balanceOf(s.target) : '', r2(s.cash_back),
      s.transfers, groupOf[s.target] || '']);
  return { rows: rows, cryptoBalance: r2(cryptoBalance) };
}

function setupTargetDashboard() {
  const ss = SpreadsheetApp.getActive();
  const sh = ensureSheet_(ss, TARGET_CFG.dashSheet);
  const S = TARGET_CFG.statsSheet;
  sh.getCharts().forEach((c) => sh.removeChart(c));
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearDataValidations();
  sh.getRange('A34').setValue('All targets by group (highest-earning group first)');
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
  sh.getRange('A3:E3').setValues([['Target', 'Group', 'Balance', 'Cash back', 'Transfers']]);
  const pick = (col) => `=IFERROR(INDEX(FILTER('${S}'!${col}:${col},'${S}'!A:A=$B$1,'${S}'!B:B="all"),1),"")`;
  sh.getRange('A4:E4').setFormulas([['=$B$1', pick('G'), pick('D'), pick('E'), pick('F')]]);

  // Cash back by year (A7:B) and over the last 24 months (D7:E)
  sh.getRange('A6').setValue('Cash back by year');
  sh.getRange('A7').setFormula(
    `=IFERROR(QUERY('${S}'!A:G,"select C,E where A='"&$B$1&"' and B='year' order by C ` +
    `label C 'year', E 'cash back'",1),"")`);
  sh.getRange('D6').setValue('Cash back by month (last 24)');
  sh.getRange('D7:E7').setValues([['month', 'cash back']]);
  sh.getRange('D8').setFormula(
    `=IFERROR(SORT(QUERY('${S}'!A:G,"select C,E where A='"&$B$1&"' and B='month' order by C desc limit 24",0),1,TRUE),"")`);

  ['A3:E3', 'A6', 'D6', 'A7:B7', 'D7:E7', 'A34'].forEach((a) => sh.getRange(a).setFontWeight('bold'));
  ['C4:D4', 'B8:B20', 'E8:E31'].forEach((a) => sh.getRange(a).setNumberFormat('$#,##0'));
  sh.getRange('A8:A20').setNumberFormat('@');
  sh.getRange('D8:D31').setNumberFormat('@');

  const column = (range, title, row, col) => sh.insertChart(sh.newChart()
    .asColumnChart()
    .addRange(sh.getRange(range))
    .setNumHeaders(1)
    .setOption('title', title)
    .setOption('legend', { position: 'none' })
    .setOption('vAxis', { format: '$#,##0' })
    .setOption('width', 760)
    .setOption('height', 300)
    .setPosition(row, col, 0, 0)
    .build());
  column('A7:B17', 'Cash back by year: selected target (B1)', 3, 11);
  column('D7:E31', 'Cash back by month: selected target (B1)', 19, 11);
  column('H35:I40', 'Cash back by group', 36, 11);
  sh.setFrozenRows(1);
  PropertiesService.getDocumentProperties().setProperty('TARGETS_DASH_VERSION', TARGET_CFG.version);
}
