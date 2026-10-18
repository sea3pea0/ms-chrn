/**
 * Bank Bonus & Referrals sheet: every YNAB inflow categorized Bank Bonus or Referral Rewards
 * (any category group, e.g. "Income: Bank Bonus", "71200 - Referral Rewards"), with totals by
 * type and by year. Rebuilt by the hourly sync from the YNAB mirror + history.
 */

const BONUS_CFG = {
  sheet: 'Bank Bonus & Referrals',
  types: [
    { label: 'Bank Bonus', regex: /bank bonus/i },
    { label: 'Referral Rewards', regex: /referral reward/i }
  ]
};

function rebuildBonusSheet() {
  const ss = SpreadsheetApp.getActive();
  const rows = buildBonusRows_(combinedMirror_(), ss.getSpreadsheetTimeZone());
  const sh = ensureSheet_(ss, BONUS_CFG.sheet);
  sh.clear();
  const labels = BONUS_CFG.types.map((t) => t.label);

  // Totals by type (A1:C)
  const totals = [['Type', 'Count', 'Total']];
  labels.forEach((l) => {
    const rs = rows.filter((r) => r[1] === l);
    totals.push([l, rs.length, rs.reduce((s, r) => s + r[4], 0)]);
  });
  totals.push(['Total', rows.length, rows.reduce((s, r) => s + r[4], 0)]);
  sh.getRange(1, 1, totals.length, 3).setValues(totals);
  sh.getRange(2, 3, totals.length - 1, 1).setNumberFormat('$#,##0.00');
  sh.getRange(1, 1, 1, 3).setFontWeight('bold');
  sh.getRange(totals.length, 1, 1, 3).setFontWeight('bold');

  // By year (E1)
  const years = Array.from(new Set(rows.map((r) => r[0].slice(0, 4)))).sort().reverse();
  const byYear = [['Year'].concat(labels).concat(['Total'])];
  years.forEach((y) => {
    const vals = labels.map((l) => rows.filter((r) => r[1] === l && r[0].slice(0, 4) === y).reduce((s, r) => s + r[4], 0));
    byYear.push([y].concat(vals).concat([vals.reduce((s, v) => s + v, 0)]));
  });
  sh.getRange(1, 5, byYear.length, byYear[0].length).setValues(byYear);
  sh.getRange(1, 5, 1, byYear[0].length).setFontWeight('bold');
  if (byYear.length > 1) sh.getRange(2, 6, byYear.length - 1, byYear[0].length - 1).setNumberFormat('$#,##0.00');
  sh.getRange(2, 5, Math.max(byYear.length - 1, 1), 1).setNumberFormat('@');

  // Every bonus / referral, newest first
  const start = Math.max(totals.length, byYear.length) + 2;
  const list = [['date', 'type', 'account', 'payee', 'amount', 'category', 'memo']]
    .concat(rows.map((r) => [isoToDate_(r[0]), r[1], r[2], r[3], r[4], r[5], r[6]]));
  sh.getRange(start, 1, list.length, list[0].length).setValues(list);
  sh.getRange(start, 1, 1, list[0].length).setFontWeight('bold');
  if (list.length > 1) {
    sh.getRange(start + 1, 1, list.length - 1, 1).setNumberFormat('yyyy-mm-dd');
    sh.getRange(start + 1, 5, list.length - 1, 1).setNumberFormat('$#,##0.00');
  }
  sh.setFrozenRows(0);
  console.log('Bank Bonus & Referrals: ' + rows.length + ' rows');
  return rows.length;
}

/** Pure: [iso, type, account, payee, amount, category, memo], newest first. Refunds/clawbacks negative. */
function buildBonusRows_(mirror, tz) {
  const h = mapHeaderIndexes_(mirror[0] || []);
  const out = [];
  mirror.slice(1).forEach((r) => {
    if (String(r[h.deleted]).toLowerCase() === 'true') return;
    const category = String(r[h.Category] || '');
    const type = BONUS_CFG.types.find((t) => t.regex.test(category));
    if (!type) return;
    const amount = toNumber_(r[h.Inflow]) - toNumber_(r[h.Outflow]);
    const iso = cellIso_(r[h.Date], tz);
    if (!iso || !amount) return;
    const group = String(r[h['Category Group']] || '');
    out.push([iso, type.label, String(r[h.Account] || ''), String(r[h.Payee] || ''),
      Math.round(amount * 100) / 100, group ? group + ': ' + category : category, String(r[h.Memo] || '')]);
  });
  return out.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
}
