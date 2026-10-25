/**
 * Fixes YNAB's TKB -> MoneyLion transfer mix-ups automatically.
 *
 * Both sides of these transfers arrive from bank feeds, and YNAB pairs them by amount and date.
 * Batches of identical $200s into two MoneyLion accounts (P1, P2) make it double-import a send,
 * keep a pending copy next to the posted one, or pair a P1 send with the P2 account.
 *
 * Every hourly sync, fixTkbMoliTransfers_():
 *   1. reads the last TD_CFG.lookbackDays of YNAB transfers from each Taekus account to any MOLI
 *      account, and the same period of "Ml Spend Transfer" sends from the extension's Taekus files
 *      (taekus-api-<last4>.csv, exact times, pending included);
 *   2. pairs each YNAB transfer with one Taekus send of the same amount, nearest date (<= 7 days),
 *      preferring the right owner's MoneyLion account and posted, cleared, uniquely imported rows;
 *   3. deletes YNAB transfers left over (more transfers than Taekus sends) when they are dated
 *      between 3 and 40 days ago. Deleting a transfer removes both sides (TKB and MOLI). The
 *      leftover chosen is the most suspicious: duplicate import id, then the other owner's
 *      MoneyLion account, then a pending import copy, then uncleared;
 *   4. logs every deletion to Transfer_Fixes with the full transaction (to recreate it if needed),
 *      and compares each TKB balance in YNAB with Taekus's live balance (Taekus_Balances).
 * Sends Taekus has but YNAB lacks are left to the Taekus -> YNAB reconcile (taekus_sync).
 */

const TD_CFG = {
  sheet: 'Transfer_Fixes',
  headers: ['when', 'action', 'account', 'date', 'amount', 'payee', 'reason', 'ynab_id', 'details_json'],
  lookbackDays: 60,
  minAgeDays: 3, // let pending items settle and the feeds catch up first
  maxAgeDays: 40, // leave older history alone
  matchDays: 7,
  maxDeletesPerRun: 8,
  taekusRx: /^TK[BP]\s*-\s*(\d{4})/i,
  moliRx: /^MOLI\b/i,
  sendRx: /ml spend transfer|moneylion/i
};

/** Owner tag (P1 / P2) from a YNAB account name like "TKB - 0523 - P1" or "MOLI - 1400 - P2". */
function tdOwner_(name) {
  const m = String(name).match(/\bP(\d)\b/i);
  return m ? 'P' + m[1] : '';
}

/**
 * Pure: decide which YNAB transfers to delete.
 * ynab: [{ id, account, date, amount, dst, cleared, importId, pending }] (outflows, positive amount)
 * taekus: [{ date, amount }] sends from the same TKB account (positive amount)
 * coveredTo: last date the Taekus file is complete for (the day before it was last refreshed)
 */
function tdPlan_(ynab, taekus, todayIso, coveredTo) {
  const day = (iso) => isoDays_(iso);
  const today = day(todayIso);
  const importCount = {};
  ynab.forEach((t) => { if (t.importId) importCount[t.importId] = (importCount[t.importId] || 0) + 1; });
  // Lower = more trustworthy; used to keep the best rows and delete the worst.
  const suspicion = (t) => (importCount[t.importId] > 1 ? 8 : 0) +
    (tdOwner_(t.account) && tdOwner_(t.dst) && tdOwner_(t.account) !== tdOwner_(t.dst) ? 4 : 0) +
    (t.pending ? 2 : 0) + (t.cleared === 'uncleared' ? 1 : 0);
  // Global nearest-date pairing: closest pairs first, and on ties the trustworthy YNAB row wins,
  // so the suspicious copy is the one left over (a plain date-order walk shifts whole batches).
  const pairs = [];
  ynab.forEach((t, yi) => {
    taekus.forEach((s, ti) => {
      if (Math.abs(s.amount - t.amount) > 0.005) return;
      const gap = Math.abs(day(s.date) - day(t.date));
      if (gap <= TD_CFG.matchDays) pairs.push([gap, suspicion(t), yi, ti]);
    });
  });
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const yUsed = new Array(ynab.length).fill(false);
  const tUsed = new Array(taekus.length).fill(false);
  pairs.forEach((p) => {
    if (yUsed[p[2]] || tUsed[p[3]]) return;
    yUsed[p[2]] = true;
    tUsed[p[3]] = true;
  });
  const extras = ynab.filter((t, yi) => !yUsed[yi]);
  // Only judge dates the Taekus data fully covers (a week inside its first and last rows).
  const tDays = taekus.map((s) => day(s.date));
  const first = Math.min.apply(null, tDays) + TD_CFG.matchDays;
  const last = coveredTo ? day(coveredTo) : Math.max.apply(null, tDays) - 1;
  return extras.filter((t) => {
    const d = day(t.date);
    const age = today - d;
    return age >= TD_CFG.minAgeDays && age <= TD_CFG.maxAgeDays && d >= first && d <= last;
  }).map((t) => Object.assign({ reason: (importCount[t.importId] > 1 ? 'duplicate import id; ' : '') +
    (tdOwner_(t.account) !== tdOwner_(t.dst) && tdOwner_(t.dst) ? 'other owner\'s MoneyLion; ' : '') +
    (t.pending ? 'pending copy; ' : '') + 'more YNAB transfers than Taekus sends' }, t));
}

function fixTkbMoliTransfers_() {
  const token = getScriptProperty_('YNAB_TOKEN');
  const budgetId = getScriptProperty_('YNAB_BUDGET_ID');
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();
  const todayIso = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const since = Utilities.formatDate(new Date(Date.now() - TD_CFG.lookbackDays * 86400000), tz, 'yyyy-MM-dd');
  const base = `${CFG.ynabBaseUrl}/budgets/${budgetId}`;
  const accounts = ynabGetWithBackoff_(base + '/accounts', token).accounts || [];
  const byId = {};
  accounts.forEach((a) => { byId[a.id] = a; });

  // Taekus sends per last4 from the extension's files.
  const sends = {};
  const covered = {};
  const folders = DriveApp.getFoldersByName(XFER_CFG.taekusFolder);
  if (!folders.hasNext()) return { deleted: 0, notes: ['no Taekus folder'] };
  const folder = folders.next();
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    const m = f.getName().match(/^taekus-api-(\d{4})\.csv$/);
    if (!m) continue;
    covered[m[1]] = Utilities.formatDate(new Date(f.getLastUpdated().getTime() - 86400000), tz, 'yyyy-MM-dd');
    sends[m[1]] = readCsvText_(f.getBlob().getDataAsString())
      .filter((r) => TD_CFG.sendRx.test(r.description || '') && Number(r['transaction amount']) < 0)
      .map((r) => ({ date: tdLocalIso_(r.date, tz), amount: -Number(r['transaction amount']) }))
      .filter((r) => r.date);
  }

  const sh = ensureSheet_(ss, TD_CFG.sheet);
  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, TD_CFG.headers.length).setValues([TD_CFG.headers]);
    sh.setFrozenRows(1);
  }
  const log = [];
  const notes = [];
  let deleted = 0;
  const balances = tdTaekusBalances_(ss);

  accounts.filter((a) => !a.deleted && !a.closed && TD_CFG.taekusRx.test(a.name)).forEach((a) => {
    const last4 = a.name.match(TD_CFG.taekusRx)[1];
    if (balances[last4] !== undefined) {
      const diff = Math.round((a.balance / 1000 - balances[last4]) * 100) / 100;
      if (Math.abs(diff) >= 0.01) notes.push(a.name.split(' - ').slice(0, 2).join(' ') + ' YNAB−Taekus ' + diff);
    }
    const taekus = sends[last4];
    if (!taekus || !taekus.length) return; // no extension data for this account yet
    const txns = (ynabGetWithBackoff_(`${base}/accounts/${a.id}/transactions?since_date=${since}`, token).transactions || [])
      .filter((t) => !t.deleted && t.amount < 0 && t.transfer_account_id && byId[t.transfer_account_id] &&
        TD_CFG.moliRx.test(byId[t.transfer_account_id].name))
      .map((t) => ({
        id: t.id, account: a.name, date: t.date, amount: -t.amount / 1000, dst: byId[t.transfer_account_id].name,
        cleared: t.cleared, importId: t.import_id || '', pending: /^YNAB:P:/.test(t.import_id || ''), raw: t
      }));
    tdPlan_(txns, taekus, todayIso, covered[last4]).forEach((t) => {
      if (deleted >= TD_CFG.maxDeletesPerRun) return;
      const r = UrlFetchApp.fetch(`${base}/transactions/${t.id}`, {
        method: 'delete', headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true
      });
      const ok = r.getResponseCode() < 300;
      if (ok) deleted += 1;
      log.push([new Date(), ok ? 'deleted transfer' : 'delete failed ' + r.getResponseCode(), t.account, t.date,
        t.amount, 'Transfer : ' + t.dst, t.reason, t.id, JSON.stringify({
          account_id: t.raw.account_id, date: t.raw.date, amount: t.raw.amount, payee_name: t.raw.payee_name,
          transfer_account_id: t.raw.transfer_account_id, cleared: t.raw.cleared, approved: t.raw.approved,
          import_id: t.raw.import_id, memo: t.raw.memo, transfer_transaction_id: t.raw.transfer_transaction_id
        })]);
    });
  });

  if (log.length) {
    sh.insertRowsAfter(1, log.length); // newest on top
    sh.getRange(2, 1, log.length, TD_CFG.headers.length).setValues(log);
  }
  if (deleted) notes.unshift('deleted ' + deleted + ' duplicate TKB→MOLI transfer(s)');
  return { deleted: deleted, notes: notes };
}

/** "10/21/2026 13:59 UTC" -> local ISO date (YNAB dates are local). */
function tdLocalIso_(s, tz) {
  const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4]), Number(m[5])));
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

function tdTaekusBalances_(ss) {
  const sh = ss.getSheetByName(INGEST.taekus.balanceSheet);
  const out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach((r) => {
    const l4 = ('0000' + String(r[0]).replace(/\D/g, '')).slice(-4);
    out[l4] = toNumber_(r[2]);
  });
  return out;
}
