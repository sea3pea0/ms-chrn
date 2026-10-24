/**
 * Summary sheet: recent-first view of cash back minus fees.
 *
 *   1. Cash back minus fees by period: month to date, each earlier month of this year, year to
 *      date, last year, all time; split MS / MS-Crypto / Bill Pay, with Coinbase One and Fluz load
 *      fees in their own columns. Per-transfer fees (split fees, on-ramp fees) are already inside
 *      each bucket's profit.
 *   2. Targets active in the last 30 days, with their cash back minus fees, the current rate (the
 *      newest transfer whose cash back has posted, minus its fees), and an estimate of
 *      the next load: the target's usual gap between load days and usual amount per load day,
 *      both medians over the last 90 days.
 *   3. Profit by source (all time) and how many ledger rows need review.
 *
 * Values are written by the hourly sync (writeSummary_); buildSummaryData_ is pure for testing.
 */

const SUMMARY_CFG = {
  buckets: ['MS', 'MS_CRYPTO', 'BILL_PAY'],
  labels: { MS: 'MS', MS_CRYPTO: 'MS-Crypto', BILL_PAY: 'Bill Pay' },
  activeDays: 30,
  patternDays: 90,
  sources: [['TAEKUS', 'Taekus (points)'], ['FLUZ', 'Fluz (cash back)'], ['BLUPE', 'Blue Penguin (interchange share)'],
    ['UPGRADE', 'Upgrade (monthly rewards)'], ['PRIMIS', 'Primis (monthly rewards)'], ['METAMASK', 'MetaMask Card (mUSD)']],
  colors: { title: '#1f3864', header: '#dbe5f1', band: '#f5f8fc', text: '#ffffff' }
};

/** Pure: ledger values (header row first) + today's ISO date -> everything the sheet shows. */
function buildSummaryData_(ledger, todayIso, tz) {
  const h = mapHeaderIndexes_(ledger[0] || []);
  const rows = [];
  ledger.slice(1).forEach((r) => {
    const iso = cellIso_(r[h.date], tz);
    if (!iso) return;
    rows.push({
      iso: iso, bucket: String(r[h.bucket]), source: String(r[h.source]), amount: toNumber_(r[h.amount]),
      profit: toNumber_(r[h.profit]), fee: toNumber_(r[h.fee]), target: String(r[h.target_group] || r[h.target] || '').trim(),
      match: String(r[h.match] || '')
    });
  });

  const y = Number(todayIso.slice(0, 4));
  const ym = todayIso.slice(0, 7);
  const lastMonth = (() => {
    const d = new Date(Date.UTC(y, Number(todayIso.slice(5, 7)) - 2, 1));
    return d.toISOString().slice(0, 7);
  })();
  const monthName = (m) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4);
  const periods = [{ label: 'Month to date (' + monthName(ym) + ')', test: (iso) => iso.slice(0, 7) === ym }];
  for (let m = Number(todayIso.slice(5, 7)) - 1; m >= 1; m -= 1) {
    const key = y + '-' + ('0' + m).slice(-2);
    periods.push({ label: monthName(key), test: (iso) => iso.slice(0, 7) === key });
  }
  periods.push({ label: 'Year to date (' + y + ')', test: (iso) => iso.slice(0, 4) === String(y), strong: true });
  periods.push({ label: String(y - 1), test: (iso) => iso.slice(0, 4) === String(y - 1), strong: true });
  periods.push({ label: 'All time', test: () => true, strong: true });
  const r2 = (x) => Math.round(x * 100) / 100;
  const periodRows = periods.map((p) => {
    const v = { MS: 0, MS_CRYPTO: 0, BILL_PAY: 0, cbOne: 0, fluzFees: 0, spend: 0, transfers: 0 };
    rows.forEach((r) => {
      if (!p.test(r.iso)) return;
      if (SUMMARY_CFG.buckets.indexOf(r.bucket) >= 0) {
        v[r.bucket] += r.profit;
        v.spend += r.amount;
        v.transfers += 1;
      } else if (r.bucket === 'CRYPTO_FEE') {
        v.cbOne += r.profit; // Coinbase One subscription (negative)
      } else if (r.bucket === 'FLUZ_FEE') {
        v.fluzFees += r.profit;
      }
    });
    const total = v.MS + v.MS_CRYPTO + v.cbOne + v.BILL_PAY + v.fluzFees;
    return [p.label, r2(v.MS), r2(v.MS_CRYPTO), r2(v.cbOne), r2(v.BILL_PAY), r2(v.fluzFees), r2(total), r2(v.spend),
      v.spend ? total / v.spend : 0, v.transfers];
  });

  // Active targets: any tracked transfer in the last 30 days.
  const today = isoDays_(todayIso);
  const tracked = rows.filter((r) => SUMMARY_CFG.buckets.indexOf(r.bucket) >= 0 && r.target);
  const byTarget = {};
  tracked.forEach((r) => {
    const t = byTarget[r.target] || (byTarget[r.target] = { recent: [], pattern: {}, byBucket: {} });
    const age = today - isoDays_(r.iso);
    if (age < 0) return;
    if (age < SUMMARY_CFG.activeDays) {
      t.recent.push(r);
      t.byBucket[r.bucket] = (t.byBucket[r.bucket] || 0) + r.amount;
    }
    if (age < SUMMARY_CFG.patternDays) t.pattern[r.iso] = (t.pattern[r.iso] || 0) + r.amount;
    // Current rate: newest transfer whose cash back / points have posted (gross > 0), net of fees.
    if (r.amount > 0 && r.profit + r.fee > 0 && (!t.latest || r.iso >= t.latest.iso)) t.latest = r;
  });
  const median = (a) => {
    if (!a.length) return null;
    const s = a.slice().sort((x, z) => x - z);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const isoOf = (days) => new Date(days * 86400000).toISOString().slice(0, 10);
  // Like the Targets page: only places that earned (or cost) something; plain moves between your
  // own accounts with no cash back are left out.
  const active = Object.keys(byTarget).filter((t) => byTarget[t].recent.some((r) => r.profit !== 0)).map((t) => {
    const o = byTarget[t];
    const group = Object.keys(o.byBucket).sort((a, b) => o.byBucket[b] - o.byBucket[a])[0];
    const net = o.recent.reduce((s, r) => s + r.profit, 0);
    const spend = o.recent.reduce((s, r) => s + r.amount, 0);
    const days = Object.keys(o.pattern).sort();
    const last = days[days.length - 1];
    const gaps = [];
    for (let i = 1; i < days.length; i += 1) gaps.push(isoDays_(days[i]) - isoDays_(days[i - 1]));
    const gap = median(gaps);
    const amt = median(days.map((d) => o.pattern[d]));
    let next = '';
    if (gap !== null) {
      const due = isoDays_(last) + Math.max(1, Math.round(gap));
      next = isoOf(Math.max(due, today));
    }
    const cur = o.latest ? o.latest.profit / o.latest.amount : '';
    return [t, SUMMARY_CFG.labels[group] || group, o.recent.length, r2(spend), r2(net), spend ? net / spend : 0,
      cur, o.latest ? o.latest.iso : '', last, next, amt === null ? '' : r2(amt), gap === null ? '' : Math.round(gap * 10) / 10];
  }).sort((a, b) => b[4] - a[4]);

  const bySource = SUMMARY_CFG.sources.map((s) => [s[1], r2(rows
    .filter((r) => r.source === s[0] && SUMMARY_CFG.buckets.indexOf(r.bucket) >= 0)
    .reduce((x, r) => x + r.profit, 0))]);
  const review = rows.filter((r) => r.bucket === 'REVIEW' || /^no csv row/.test(r.match)).length;
  return { periods: periodRows, strong: periods.map((p) => !!p.strong), active: active, bySource: bySource, review: review };
}

function writeSummary_() {
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();
  const sh = ensureSheet_(ss, CFG.sheets.summary);
  const data = buildSummaryData_(ss.getSheetByName(XFER_CFG.sheets.ledger).getDataRange().getValues(),
    Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'), tz);
  const C = SUMMARY_CFG.colors;
  const money = '$#,##0.00;[Red]-$#,##0.00';
  const W = 12;

  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setFontFamily('Arial').setFontSize(10).setVerticalAlignment('middle');
  sh.setHiddenGridlines(true);
  const title = sh.getRange(1, 1, 1, W).merge();
  title.setValue('MS-CHRN Cash Back').setFontSize(18).setFontWeight('bold').setFontColor(C.text).setBackground(C.title);
  sh.getRange(2, 1, 1, W).merge().setValue('Updated ' + Utilities.formatDate(new Date(), tz, 'MMM d, yyyy h:mm a') +
    '   ·   cash back minus fees (split fees, on-ramp fees, Coinbase One, Fluz load fees)')
    .setFontColor('#666666').setFontStyle('italic');
  sh.setRowHeight(1, 40);

  const section = (row, text) => {
    sh.getRange(row, 1, 1, W).merge().setValue(text).setFontSize(12).setFontWeight('bold').setFontColor(C.title)
      .setBorder(null, null, true, null, null, null, C.title, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    sh.setRowHeight(row, 28);
  };
  const header = (row, cols) => {
    sh.getRange(row, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground(C.header)
      .setWrap(true).setHorizontalAlignment('center');
  };
  const band = (row, n, cols) => {
    for (let i = 0; i < n; i += 2) sh.getRange(row + i, 1, 1, cols).setBackground(C.band);
  };

  // 1. Periods
  let row = 4;
  section(row, 'Cash back minus fees');
  header(row + 1, ['Period', 'MS', 'MS-Crypto', 'Coinbase One', 'Bill Pay', 'Fluz load fees', 'Total', 'Spend',
    'Net rate', 'Transfers']);
  const p0 = row + 2;
  const n = data.periods.length;
  sh.getRange(p0, 1, n, 10).setValues(data.periods);
  sh.getRange(p0, 2, n, 7).setNumberFormat(money);
  sh.getRange(p0, 9, n, 1).setNumberFormat('0.00%');
  sh.getRange(p0, 10, n, 1).setNumberFormat('#,##0');
  band(p0, n, 10);
  sh.getRange(p0, 7, n, 1).setFontWeight('bold');
  sh.getRange(p0, 1, 1, 10).setFontWeight('bold'); // month to date
  const firstStrong = data.strong.indexOf(true);
  data.strong.forEach((st, i) => { if (st) sh.getRange(p0 + i, 1, 1, 10).setFontWeight('bold').setBackground(C.header); });
  if (firstStrong > 0) {
    sh.getRange(p0 + firstStrong, 1, 1, 10)
      .setBorder(true, null, null, null, null, null, '#999999', SpreadsheetApp.BorderStyle.SOLID);
  }

  // 2. Active targets + next load
  row = p0 + data.periods.length + 2;
  section(row, 'Targets active in the last 30 days');
  header(row + 1, ['Target', 'Group', 'Transfers', 'Spend', 'Cash back − fees', 'Net rate (30d)', 'Current rate',
    'Rate as of', 'Last load', 'Next load (est.)', 'Est. amount', 'Usual gap (days)']);
  const a0 = row + 2;
  if (data.active.length) {
    sh.getRange(a0, 1, data.active.length, 12).setValues(data.active);
    sh.getRange(a0, 4, data.active.length, 2).setNumberFormat(money);
    sh.getRange(a0, 6, data.active.length, 2).setNumberFormat('0.00%;[Red]-0.00%');
    sh.getRange(a0, 7, data.active.length, 1).setFontWeight('bold');
    sh.getRange(a0, 8, data.active.length, 3).setNumberFormat('@').setHorizontalAlignment('center');
    sh.getRange(a0, 11, data.active.length, 1).setNumberFormat('$#,##0');
    sh.getRange(a0, 12, data.active.length, 1).setHorizontalAlignment('center');
    band(a0, data.active.length, 12);
    sh.getRange(a0, 10, data.active.length, 2).setFontWeight('bold').setFontColor('#1a7f37');
  }
  const aEnd = a0 + Math.max(data.active.length, 1);
  sh.getRange(aEnd, 1, 1, W).merge()
    .setValue('Next load: last load day + the target\'s median gap between load days; amount: its median ' +
      'total per load day (both over the last 90 days). A date of today means it is due now. Current rate: the ' +
      'newest transfer whose cash back has posted, minus its fees.')
    .setFontColor('#666666').setFontStyle('italic').setWrap(true);
  sh.setRowHeight(aEnd, 30);

  // 3. Profit by source + review count
  row = aEnd + 2;
  section(row, 'Profit by source (all time)');
  header(row + 1, ['Source', 'Profit']);
  const s0 = row + 2;
  sh.getRange(s0, 1, data.bySource.length, 2).setValues(data.bySource);
  sh.getRange(s0, 2, data.bySource.length, 1).setNumberFormat(money);
  band(s0, data.bySource.length, 2);
  sh.getRange(s0 + data.bySource.length + 1, 1, 1, 2).setValues([['Ledger rows needing review', data.review]])
    .setFontColor(data.review ? '#b42318' : '#666666');

  sh.setColumnWidth(1, 210);
  for (let c = 2; c <= W; c += 1) sh.setColumnWidth(c, 105);
  sh.setFrozenRows(2);
}
