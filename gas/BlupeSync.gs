/**
 * Sync Blue Penguin settlement CSVs from Google Drive into the YNAB BLUPE account.
 * Port of scripts/blupe_sync.py; keep the two in step.
 *
 * Drop a Blue Penguin settlement report CSV into the Drive folder
 * "Blue Penguin Transaction CSVs". Each run:
 *
 *   1. reads every CSV in that folder and merges the rows by Event ID, so
 *      overlapping exports are fine;
 *   2. turns each Settle / Refund row dated on/after syncStart into one BLUPE
 *      line (settle = outflow, refund = inflow);
 *   3. matches those lines against what YNAB already has in BLUPE (Event ID in
 *      the memo, then amount within a date window), so earlier manual entries
 *      are not duplicated;
 *   4. logs the plan, and in blupeSyncApply() writes the missing lines
 *      (unapproved, so they show up for review in YNAB).
 *
 * The report has no funding or interchange-payout rows; those still come from
 * the funding account's feed / manual "Blue Penguin" entries.
 *
 * Entry points: blupeSyncDryRun() (log only), blupeSyncApply() (hourly trigger).
 */

const BLUPE_SYNC = {
  driveFolderName: 'Blue Penguin Transaction CSVs',
  ynabAccount: 'BLUPE',
  // YNAB BLUPE already holds every settlement through 2026-08 (entered by hand).
  // Rows before this are left alone.
  syncStart: '2026-09-01',
  // Manual entries were often dated a day or so either side of the settle date.
  matchDaysBefore: 5,
  matchDaysAfter: 7,
  amountTolerance: 10, // milliunits (1 cent)
  syncTypes: new Set(['Settle', 'Refund']),
  // Merchant descriptor -> YNAB payee (first match wins).
  payees: [
    [/ROBINHOOD|RHS? BROKERAGE/i, 'Robinhood'],
    [/AMERICANEXP/i, 'American Express'],
    [/BARCLAYCARD/i, 'Barclaycard'],
    [/DISCOVERCAR/i, 'Discover'],
    [/BANK ?OF ?AMERICA|BANKAMERICA/i, 'Bank of America'],
    [/CITIBANK/i, 'Citi'],
    [/STEP\.COM/i, 'Step']
  ]
};

function blupeSyncDryRun() {
  return blupeSync_(false);
}

function blupeSyncApply() {
  return csvSyncLocked_('blupeSync', () => blupeSync_(true));
}

function blupePayeeFor_(descr) {
  for (const [pat, name] of BLUPE_SYNC.payees) {
    if (pat.test(descr)) return name;
  }
  return cut_(descr.replace(/\s{2,}.*/, '').trim(), 50) || 'Blue Penguin';
}

/** Merge rows across files by Event ID; later files win. */
function blupeMergedRows_(sources) {
  const byId = new Map();
  sources.forEach((src) => {
    readCsvText_(src.text).forEach((r) => {
      const eid = (r['Event ID'] || '').trim();
      if (eid) byId.set(eid, r);
    });
  });
  return Array.from(byId.values());
}

function blupeExpectedLines_(rows) {
  const C = BLUPE_SYNC;
  const out = [];
  rows.forEach((r) => {
    const t = r['Type'].trim();
    const d = r['DateTime'].trim().slice(0, 10);
    if (!isoValid_(d)) return;
    if (!C.syncTypes.has(t) || d < C.syncStart) return;
    const amt = -milli_(r['Amount']); // settle is positive in the report = money out of BLUPE
    if (!amt) return;
    const eid = r['Event ID'].trim(), descr = r['Description'].replace(/\s+/g, ' ').trim();
    const memo = 'BP ' + eid + ' - ' + t + ' - card ' + r['Last 4'].trim() + ' - interchange ' +
      r['Interchange'].trim() + ' - ' + descr;
    out.push({ date: d, amount: amt, ref: 'BP ' + eid, type: t,
      payee: blupePayeeFor_(r['Description'].trim()), memo: cut_(memo, 200) });
  });
  return out;
}

/** Split expected lines into matched / create. */
function blupePlan_(lines, txns) {
  const C = BLUPE_SYNC;
  const pool = txns.filter((t) => !t.deleted);
  const used = new Set(), matched = [], todo = [];
  lines.forEach((l) => { // exact: Event ID already in a memo
    const t = pool.find((t) => !used.has(t.id) && (t.memo || '').indexOf(l.ref) >= 0);
    if (t) { used.add(t.id); matched.push([l, t]); } else { todo.push(l); }
  });
  const create = [];
  todo.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).forEach((l) => {
    let best = null;
    pool.forEach((t) => {
      if (used.has(t.id) || Math.abs(t.amount - l.amount) > C.amountTolerance) return;
      const dd = isoDays_(t.date) - isoDays_(l.date);
      if (-C.matchDaysBefore <= dd && dd <= C.matchDaysAfter && (!best || Math.abs(dd) < best[0])) {
        best = [Math.abs(dd), t];
      }
    });
    if (best) { used.add(best[1].id); matched.push([l, best[1]]); } else { create.push(l); }
  });
  return { matched: matched, create: create };
}

function blupeToYnab_(l, accountId) {
  // No import_id, same as FluzSync: YNAB would auto-merge it into look-alike manual entries.
  return { account_id: accountId, date: l.date, amount: l.amount, payee_name: l.payee,
    memo: l.memo, cleared: 'cleared', approved: false };
}

function blupeDescribe_(l) {
  return l.date + '  ' + fmtMilli_(l.amount).padStart(11) + '  ' + l.payee.padEnd(18) + ' ' + l.memo;
}

function blupeBuildPlan_(y, sources) {
  const C = BLUPE_SYNC;
  const rows = blupeMergedRows_(sources);
  const acct = y.get('/accounts').accounts
    .find((a) => a.name.trim() === C.ynabAccount && !a.deleted && !a.closed);
  const since = isoAddDays_(C.syncStart, -(C.matchDaysBefore + 1));
  const txns = y.get('/accounts/' + acct.id + '/transactions?since_date=' + since).transactions;
  const lines = blupeExpectedLines_(rows);
  const p = blupePlan_(lines, txns);
  p.lines = lines;
  p.acct = acct;
  return p;
}

function blupeSync_(apply) {
  const C = BLUPE_SYNC;
  const y = csvSyncYnab_();
  const sources = driveCsvs_(C.driveFolderName);
  if (!sources.length) { console.log('No CSVs found.'); return null; }
  const p = blupeBuildPlan_(y, sources);
  const net = p.create.reduce((s, l) => s + l.amount, 0);
  const out = [];
  out.push('Files: ' + sources.map((s) => s.name).join(', '));
  out.push('Settle/Refund rows since ' + C.syncStart + ': ' + p.lines.length + '; ' + p.matched.length + ' already in YNAB');
  out.push('TO CREATE (' + p.create.length + '):');
  p.create.forEach((l) => out.push('  ' + blupeDescribe_(l)));
  out.push('BLUPE balance now ' + fmtMilli_(p.acct.balance) + '; after sync ' + fmtMilli_(p.acct.balance + net));
  if (apply && p.create.length) {
    const res = y.postTransactions(p.create.map((l) => blupeToYnab_(l, p.acct.id)));
    out.push('Created ' + res.transaction_ids.length);
  }
  console.log(out.join('\n'));
  return { create: p.create.length, matched: p.matched.length, log: out.join('\n') };
}
