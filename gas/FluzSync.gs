/**
 * Sync Fluz transaction CSVs from Google Drive into the YNAB FLUZ account.
 * Port of scripts/fluz_sync.py; keep the two in step.
 *
 * Drop a full Fluz export ("all transactions" CSV) into the Drive folder
 * "Fluz Transaction CSVs". Each run:
 *
 *   1. reads every CSV in that folder and merges the rows by Fluz Transaction
 *      ID, so overlapping exports are fine;
 *   2. turns each Fluz row created on/after SYNC_START into the YNAB lines it
 *      implies (purchase, funding transfer, cashback, fee, reward, ...);
 *   3. matches those lines against what YNAB already has in FLUZ (by import_id,
 *      then by amount within a date window), so bank-feed transfers and earlier
 *      manual entries are not duplicated;
 *   4. logs the plan, and in fluzSyncApply() writes the missing lines
 *      (unapproved, so they show up for review in YNAB).
 *
 * Where a counterpart account already holds the other side as a plain
 * (non-transfer) transaction, the plan links it instead of creating a duplicate:
 * that transaction is turned into a transfer from FLUZ, which creates the FLUZ
 * line.
 *
 * Entry points: fluzSyncDryRun() (log only), fluzSyncApply() (hourly trigger).
 */

const FLUZ_SYNC = {
  driveFolderName: 'Fluz Transaction CSVs',
  ynabAccount: 'FLUZ',
  // YNAB FLUZ was reconciled to Fluz's own balance through 2026-09-24 ($5.00).
  // Rows before this are left alone.
  syncStart: '2026-09-25',
  // An existing YNAB line matches a Fluz line if its date is within this window
  // around the Fluz date (bank-side transfers often post a few days later).
  matchDaysBefore: 3,
  matchDaysAfter: 7,
  amountTolerance: 10, // milliunits (1 cent): Fluz amounts carry 5 decimals
  fluzBalances: new Set(['Fluz Cash Balance', 'Fluz Rewards Balance', '--', '']),
  // Fluz source/destination names that don't contain the YNAB account code.
  accountAliases: [['SAVINGS9444', 'FLAG - 9444'], ['SOFISAVINGS5887', 'SOFS - 5887 - P1']],
  // Apple Wallet destinations route to the cardholder's Apple Cash account.
  appleCashByUser: { 'Christopher Rains': 'APCA - P1', 'Yulia Rains': 'APCA - P2' },
  purchaseTypes: new Set(['Virtual Card Purchase', 'Gift Card Purchase']),
  returnTypes: new Set(['Virtual Card Return']),
  addMoneyTypes: new Set(['Add Money', 'Add Money Pending Settled']),
  rewardTypes: new Set(['Referral Royalties', 'Rewards Bonus'])
};

function fluzSyncDryRun() {
  return fluzSync_(false);
}

function fluzSyncApply() {
  return csvSyncLocked_('fluzSync', () => fluzSync_(true));
}

// ---------------------------------------------------------------- helpers

const FLUZ_MONTHS_ = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

/** "Mon Sep 29 2026 ..." -> "2026-09-29" (or null). */
function fluzDate_(s) {
  const m = /[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{2}) (\d{4})/.exec(s || '');
  if (!m || !FLUZ_MONTHS_[m[1]]) return null;
  const iso = m[3] + '-' + ('0' + FLUZ_MONTHS_[m[1]]).slice(-2) + '-' + m[2];
  return isoValid_(iso) ? iso : null;
}

function fluzClean_(s) {
  const v = String(s == null ? '' : s).trim();
  return v === '--' ? '' : v;
}

function fluzKey_(s) {
  return String(s == null ? '' : s).replace(/\[.*?\]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function fluzImportId_(txnId, component) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, txnId, Utilities.Charset.UTF_8);
  const hex = bytes.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  return 'FZ:' + hex.slice(0, 12) + ':' + component;
}

/** Merge rows across files by Transaction ID; later files win (fresher status). */
function fluzMergedRows_(sources) {
  const byId = new Map();
  sources.forEach((src) => {
    readCsvText_(src.text).forEach((r) => {
      const tid = (r['Transaction ID'] || '').trim();
      if (tid) byId.set(tid, r);
    });
  });
  return Array.from(byId.values());
}

// ---------------------------------------------------------------- planning

function fluzAccounts_(accounts) {
  const open = accounts.filter((a) => !a.deleted && !a.closed);
  const byName = {};
  open.forEach((a) => { byName[a.name.trim()] = a; });
  const keys = open.filter((a) => fluzKey_(a.name)).map((a) => [fluzKey_(a.name), a])
    .sort((x, y) => y[0].length - x[0].length);
  return {
    open: open,
    byName: byName,
    get: function (name) { return Object.prototype.hasOwnProperty.call(byName, name) ? byName[name] : null; },
    match: function (raw) {
      const k = fluzKey_(raw);
      if (!k) return null;
      for (const [alias, name] of FLUZ_SYNC.accountAliases) {
        if (k.indexOf(alias) >= 0) return this.get(name);
      }
      for (const [ak, a] of keys) { // longest key first = most specific
        if (a.name !== FLUZ_SYNC.ynabAccount && k.indexOf(ak) >= 0) return a;
      }
      return null;
    }
  };
}

/** YNAB lines each Fluz row implies. amount is from FLUZ's point of view. */
function fluzExpectedLines_(rows, accts) {
  const C = FLUZ_SYNC;
  const returnedRefs = {};
  rows.forEach((r) => {
    if (C.returnTypes.has(r['Type'])) {
      returnedRefs[r['Reference ID']] = (returnedRefs[r['Reference ID']] || 0) + Math.abs(milli_(r['Amount']));
    }
  });

  const out = [];
  rows.forEach((r) => {
    const d = fluzDate_(r['Created At']);
    if (!d || d < C.syncStart) return;
    const t = r['Type'].trim(), tid = r['Transaction ID'].trim(), ref = fluzClean_(r['Reference ID']);
    const amt = milli_(r['Amount']), cb = cents_(milli_(r['Cashback'])), fee = milli_(r['Fee']);
    const cleared = r['Status'].toUpperCase() === 'SETTLED' ? 'cleared' : 'uncleared';
    const src = fluzClean_(r['Source']).replace(/\[.*?\]/g, '').trim();
    const dst = fluzClean_(r['Destination']);
    const descr = fluzClean_(r['Description']);
    const merchant = (C.returnTypes.has(t) ? src : dst) || descr || t;

    function line(comp, amount, memo, account, payee) {
      out.push({
        date: d, amount: cents_(amount), comp: comp, ref: ref, type: t,
        import_id: fluzImportId_(tid, comp), cleared: cleared,
        account: account || null, payee: payee == null ? null : payee, memo: cut_(memo, 200)
      });
    }

    if (C.purchaseTypes.has(t) || C.returnTypes.has(t)) {
      const fullyReturned = (returnedRefs[ref] || 0) >= Math.abs(amt) && Math.abs(amt) > 0;
      let target = null;
      if (dst === 'Apple Wallet') {
        target = accts.get(C.appleCashByUser[r['User'].trim()] || '');
      } else if (C.purchaseTypes.has(t)) {
        target = accts.match(dst);
      }
      const counter = C.returnTypes.has(t) ? src : dst;
      if (fullyReturned && target) {
        // Purchase reversed by Fluz: keep it inside FLUZ, the money never landed.
        target = null;
      }
      const payee = counter === 'Apple Wallet' ? 'Apple Cash' : counter;
      const memo = ref + ' - ' + t + (descr ? ' - ' + descr : '');
      line('P', amt, memo, target, target ? null : payee);
      // Bank/card-funded purchases pass through FLUZ: money comes in from the funding source.
      if (C.purchaseTypes.has(t) && !C.fluzBalances.has(src)) {
        const fund = accts.match(src);
        line('S', -amt, ref + ' - Funding for ' + merchant, fund, fund ? null : src);
      }
      if (cb) line('C', cb, ref + ' - Cashback for ' + merchant, null, 'Fluz Cashback');
      if (fee) line('F', -Math.abs(fee), ref + ' - Fee for ' + merchant, null, 'Fluz Fee');
    } else if (C.addMoneyTypes.has(t)) {
      const fund = accts.match(src);
      line('P', amt, ref + ' - ' + t, fund, fund ? null : src);
    } else if (t === 'Withdrawal') {
      const to = accts.match(dst);
      line('P', -Math.abs(amt), ref + ' - Withdrawal', to, to ? null : dst);
    } else if (C.rewardTypes.has(t)) {
      line('P', amt, ref + ' - ' + t, null, src || 'Fluz Rewards');
    }
    // Card Verification, Transfer - In/Out: no money moves in FLUZ.
  });
  return out.filter((l) => l.amount);
}

/** Split expected lines into matched / link-existing / create. */
function fluzPlan_(lines, fluzTxns, counterpartTxns) {
  const C = FLUZ_SYNC;
  const pool = fluzTxns.filter((t) => !t.deleted);
  const used = new Set();
  const byImport = {};
  pool.forEach((t) => { if (t.import_id) byImport[t.import_id] = t; });

  function windowOf(l, t) {
    const dd = isoDays_(t.date) - isoDays_(l.date);
    return [-C.matchDaysBefore <= dd && dd <= C.matchDaysAfter, Math.abs(dd)];
  }
  function lessScore(a, b) {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  }

  const matched = [], todo = [];
  lines.forEach((l) => {
    const t = byImport[l.import_id];
    if (t && !used.has(t.id)) { used.add(t.id); matched.push([l, t]); return; }
    todo.push(l);
  });

  // Amount/date matching; prefer memo ref, then same counterpart account, then nearest date.
  const still = [];
  todo.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.comp < b.comp ? -1 : a.comp > b.comp ? 1 : 0))
    .forEach((l) => {
      let best = null;
      pool.forEach((t) => {
        if (used.has(t.id) || Math.abs(t.amount - l.amount) > C.amountTolerance) return;
        const w = windowOf(l, t);
        if (!w[0]) return;
        const sameAcct = !!l.account && t.transfer_account_id === l.account.id;
        const hasRef = !!l.ref && (t.memo || '').indexOf(l.ref) >= 0;
        const score = [hasRef ? 0 : 1, sameAcct ? 0 : 1, w[1]];
        if (!best || lessScore(score, best[0])) best = [score, t];
      });
      if (best) { used.add(best[1].id); matched.push([l, best[1]]); } else { still.push(l); }
    });

  // Lines that are transfers: if the other account already has the other side
  // as a plain transaction, link it rather than duplicating.
  const link = [], create = [];
  const cused = new Set();
  still.forEach((l) => {
    let hit = null;
    if (l.account) {
      for (const t of counterpartTxns[l.account.id] || []) {
        if (cused.has(t.id) || t.transfer_account_id || t.deleted) continue;
        if (Math.abs(t.amount + l.amount) > C.amountTolerance) continue;
        if (windowOf(l, t)[0]) { hit = t; break; }
      }
    }
    if (hit) { cused.add(hit.id); link.push([l, hit]); } else { create.push(l); }
  });
  return { matched: matched, link: link, create: create };
}

function fluzToYnab_(l, fluzId) {
  const t = {
    account_id: fluzId, date: l.date, amount: l.amount,
    memo: l.memo, cleared: l.cleared, approved: false
  };
  // No import_id on purpose: YNAB auto-matches imported transactions to an existing
  // manual one of the same amount (it merged a Fluz return into a bank transfer),
  // so dedup relies on the ref-in-memo + amount matching in fluzPlan_().
  if (l.account) t.payee_id = l.account.transfer_payee_id;
  else t.payee_name = cut_(l.payee || 'Fluz', 50);
  return t;
}

function fluzDescribe_(l) {
  const who = l.account ? 'Transfer : ' + l.account.name : l.payee;
  return l.date + '  ' + fmtMilli_(l.amount).padStart(11) + '  ' + String(who).padEnd(34) + ' ' + l.memo;
}

// ---------------------------------------------------------------- main

/** Build the plan from Drive + YNAB. Returns everything a caller needs to log or apply it. */
function fluzBuildPlan_(y, sources) {
  const C = FLUZ_SYNC;
  const rows = fluzMergedRows_(sources);
  const accts = fluzAccounts_(y.get('/accounts').accounts);
  const fluz = accts.byName[C.ynabAccount];
  const since = isoAddDays_(C.syncStart, -(C.matchDaysBefore + 1));
  const fluzTxns = y.get('/accounts/' + fluz.id + '/transactions?since_date=' + since).transactions;

  const lines = fluzExpectedLines_(rows, accts);
  const counterpart = {};
  lines.forEach((l) => {
    if (l.account && !counterpart[l.account.id]) {
      counterpart[l.account.id] = y.get('/accounts/' + l.account.id + '/transactions?since_date=' + since).transactions;
    }
  });
  const p = fluzPlan_(lines, fluzTxns, counterpart);
  p.rows = rows;
  p.lines = lines;
  p.fluz = fluz;
  return p;
}

function fluzSync_(apply) {
  const C = FLUZ_SYNC;
  const y = csvSyncYnab_();
  const sources = driveCsvs_(C.driveFolderName);
  if (!sources.length) { console.log('No CSVs found.'); return null; }
  const p = fluzBuildPlan_(y, sources);
  const create = p.create, link = p.link, fluz = p.fluz;

  let latest = null;
  p.rows.forEach((r) => {
    const d = fluzDate_(r['Created At']);
    if (!d) return;
    if (!latest || d > latest.d || (d === latest.d && r['Created At'] > latest.r['Created At'])) latest = { d: d, r: r };
  });
  const net = create.reduce((s, l) => s + l.amount, 0) + link.reduce((s, x) => s + x[0].amount, 0);
  const since = p.rows.filter((r) => (fluzDate_(r['Created At']) || C.syncStart) >= C.syncStart).length;
  const out = [];
  out.push('Files: ' + sources.map((s) => s.name).join(', '));
  out.push('Fluz rows since ' + C.syncStart + ': ' + since + ' -> ' + p.lines.length + ' YNAB lines; ' +
    p.matched.length + ' already in YNAB');
  out.push('TO CREATE (' + create.length + '):');
  create.slice().sort((a, b) => {
    const ka = [a.date, a.ref, a.comp], kb = [b.date, b.ref, b.comp];
    for (let i = 0; i < 3; i += 1) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  }).forEach((l) => out.push('  ' + fluzDescribe_(l)));
  out.push('TO LINK (' + link.length + '): existing transaction in the other account becomes a transfer from FLUZ');
  link.forEach(([l, t]) => out.push('  ' + fluzDescribe_(l) + '   <- ' + l.account.name + ' ' + t.date + ' ' +
    fmtMilli_(t.amount) + " '" + t.payee_name + "'"));
  out.push('FLUZ balance now ' + fmtMilli_(fluz.balance) + '; after sync ' + fmtMilli_(fluz.balance + net) +
    '; Fluz says ' + (latest ? latest.r['Ending total balance'] + ' (as of ' + latest.d + ')' : '?'));

  if (apply && create.length) {
    const res = y.postTransactions(create.map((l) => fluzToYnab_(l, fluz.id)));
    out.push('Created ' + res.transaction_ids.length + '; skipped as duplicate import_id: ' + res.duplicate_import_ids.length);
  }
  if (apply && link.length) {
    y.patchTransactions(link.map(([l, t]) => ({
      id: t.id, payee_id: fluz.transfer_payee_id, category_id: null,
      memo: cut_(((t.memo || '') + ' ' + l.memo).trim(), 200)
    })));
    out.push('Linked ' + link.length + ' existing transactions as transfers from FLUZ');
  }
  console.log(out.join('\n'));
  return { create: create.length, link: link.length, matched: p.matched.length, log: out.join('\n') };
}
