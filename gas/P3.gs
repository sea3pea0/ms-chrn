/**
 * P3: Churning as a Service (CaaS).
 *
 * P3 runs their own YNAB budget (Config p3/budget_id, read with the same YNAB_TOKEN). Everything in
 * it is split with Chris (Config p3/share, 0.5): transfer profit, fees and subscriptions, bank
 * bonuses and referrals.
 *
 *   pullP3Mirror_()        P3 budget -> YNAB_P3 + YNAB_Accounts_P3 (same layout as YNAB / YNAB_Accounts)
 *   importP3TaekusCsvs()   Drive folder Config p3/taekus_folder -> P3_Taekus_Raw. P3's Taekus accounts are
 *                          kept apart from P1/P2 by budget: P3_Ledger only sees P3's accounts, and the
 *                          main ledger never sees P3's. A P3 export dropped in the main Taekus folder by
 *                          mistake is still picked up (rows whose last 4 is a P3 Taekus account).
 *   rebuildP3Ledger()      the same matching as Transfer_Ledger, on P3's data -> P3_Ledger (full values)
 *   rebuildP3Sheets()      P3 MS / P3 MS-Crypto / P3 Bill Pay / P3 Bonuses views and the CaaS sheet
 *                          (all P3 profit together, split). Chris's share is one "CaaS" column on Summary;
 *                          it is not mixed into his own MS / MS-Crypto / Bank Bonus sheets.
 */

const P3_CFG = {
  person: 'P3',
  sheets: {
    mirror: 'YNAB_P3',
    accounts: 'YNAB_Accounts_P3',
    taekusRaw: 'P3_Taekus_Raw',
    ledger: 'P3_Ledger',
    caas: 'CaaS',
    ms: 'P3 MS',
    msCrypto: 'P3 MS-Crypto',
    billPay: 'P3 Bill Pay',
    bonus: 'P3 Bonuses'
  },
  knowledgeKey: 'P3_YNAB_SERVER_KNOWLEDGE',
  budgetKey: 'P3_YNAB_BUDGET',
  // Ledger buckets that make up P3's profit: transfers, plus costs that can't be tied to one transfer.
  profitBuckets: ['MS', 'MS_CRYPTO', 'BILL_PAY', 'CRYPTO_FEE', 'FLUZ_FEE']
};

function p3Config_() {
  const c = xferConfig_().p3 || {};
  const share = Number(c.share);
  return {
    budgetId: String(c.budget_id || '').trim(),
    share: Number.isFinite(share) && share >= 0 && share <= 1 ? share : 0.5,
    taekusFolder: String(c.taekus_folder || 'P3 Taekus Transaction CSVs').trim()
  };
}

// ---------------------------------------------------------------- YNAB

/** P3 budget accounts + changed transactions into YNAB_P3 (incremental, like the main mirror). */
function pullP3Mirror_() {
  const cfg = p3Config_();
  if (!cfg.budgetId) return false;
  const token = getScriptProperty_('YNAB_TOKEN');
  const ss = SpreadsheetApp.getActive();
  const props = PropertiesService.getDocumentProperties();

  const accountMap = fetchYnabAccounts_(token, cfg.budgetId);
  writeAccounts_(accountMap, ensureSheet_(ss, P3_CFG.sheets.accounts));

  const sh = ensureSheet_(ss, P3_CFG.sheets.mirror);
  const w = CFG.mirrorHeaders.length;
  const header = sh.getLastRow() ? sh.getRange(1, 1, 1, w).getValues()[0] : [];
  const stale = CFG.mirrorHeaders.some((h, i) => String(header[i] || '') !== h);
  sh.getRange(1, 1, 1, w).setValues([CFG.mirrorHeaders]);
  sh.setFrozenRows(1);
  const last = Number(props.getProperty(P3_CFG.knowledgeKey) || 0);
  const full = !last || stale || props.getProperty(P3_CFG.budgetKey) !== cfg.budgetId;

  const tx = fetchYnabTransactions_(token, cfg.budgetId, full ? 0 : last);
  const groups = fetchYnabCategoryGroups_(token, cfg.budgetId);
  upsertMirrorTransactions_(tx.transactions || [], accountMap, full, groups, sh);
  props.setProperty(P3_CFG.knowledgeKey, String(tx.server_knowledge || 0));
  props.setProperty(P3_CFG.budgetKey, cfg.budgetId);
  return true;
}

// ---------------------------------------------------------------- Taekus

function importP3TaekusCsvs(force) {
  const cfg = p3Config_();
  const ss = SpreadsheetApp.getActive();
  if (!DriveApp.getFoldersByName(cfg.taekusFolder).hasNext()) {
    // No folder yet: keep an empty sheet so the ledger can run (rows show "no csv for account").
    const sh = ensureSheet_(ss, P3_CFG.sheets.taekusRaw);
    if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, XFER_CFG.taekusRawHeaders.length).setValues([XFER_CFG.taekusRawHeaders]);
    return 0;
  }
  return importTaekusFolder_(cfg.taekusFolder, P3_CFG.sheets.taekusRaw, force);
}

/**
 * Pure: P3's Taekus rows = its own folder's rows + any rows in the main Taekus_Raw whose last 4 is
 * one of P3's Taekus accounts (deduped by key). Header first, oldest first.
 */
function p3TaekusRows_(p3Raw, mainRaw, p3Accounts) {
  const ah = mapHeaderIndexes_(p3Accounts[0] || []);
  const mine = {};
  p3Accounts.slice(1).forEach((r) => {
    const m = String(r[ah.account_name] || '').match(/^TK[BP]\s*-\s*(\d{4})/i);
    if (m) mine[m[1]] = true;
  });
  const header = (p3Raw[0] && p3Raw[0].length ? p3Raw[0] : null) || mainRaw[0] || XFER_CFG.taekusRawHeaders;
  const h = mapHeaderIndexes_(header);
  const byKey = {};
  const add = (values, onlyMine) => {
    const vh = mapHeaderIndexes_(values[0] || []);
    values.slice(1).forEach((r) => {
      const last4 = String(r[vh.account_last4] || '').padStart(4, '0');
      if (onlyMine && !mine[last4]) return;
      const key = String(r[vh.key] || '');
      if (!key || byKey[key]) return;
      byKey[key] = header.map((k) => (vh[k] === undefined ? '' : r[vh[k]]));
    });
  };
  add(p3Raw, false);
  add(mainRaw, true);
  const rows = Object.values(byKey).sort((a, b) => {
    const x = cellIso_(a[h.date]);
    const y = cellIso_(b[h.date]);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return [header].concat(rows);
}

// ---------------------------------------------------------------- ledger

function rebuildP3Ledger() {
  const ss = SpreadsheetApp.getActive();
  const mirror = ss.getSheetByName(P3_CFG.sheets.mirror);
  const accSh = ss.getSheetByName(P3_CFG.sheets.accounts);
  if (!mirror || !accSh || mirror.getLastRow() < 2) return 0;
  const accounts = accSh.getDataRange().getValues();
  const p3Raw = ss.getSheetByName(P3_CFG.sheets.taekusRaw);
  const mainRaw = ss.getSheetByName(XFER_CFG.sheets.taekusRaw);
  const rows = buildTransferLedgerRows_({
    mirror: mirror.getDataRange().getValues(),
    accounts: accounts,
    taekus: p3TaekusRows_(p3Raw && p3Raw.getLastRow() ? p3Raw.getDataRange().getValues() : [],
      mainRaw && mainRaw.getLastRow() ? mainRaw.getDataRange().getValues() : [], accounts),
    // Chris's Fluz / Blue Penguin / Coinbase / MetaMask / Solana data and swap fees are his, not P3's.
    fluz: [], blupe: [], blupeStatements: [], coinbaseFees: [], metaMaskRewards: [], solanaDeposits: [],
    swapFees: [],
    overrides: ss.getSheetByName(XFER_CFG.sheets.overrides).getDataRange().getValues(),
    cfg: xferConfig_(),
    tz: ss.getSpreadsheetTimeZone()
  });
  const sh = ensureSheet_(ss, P3_CFG.sheets.ledger);
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
    sh.getRange(2, 21, rows.length, 2).setNumberFormat('$#,##0.00');
  }
  console.log('P3_Ledger: ' + rows.length + ' rows');
  return rows.length;
}

function p3BonusRows_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(P3_CFG.sheets.mirror);
  if (!sh || sh.getLastRow() < 2) return [];
  return buildBonusRows_(sh.getDataRange().getValues(), SpreadsheetApp.getActive().getSpreadsheetTimeZone());
}

/**
 * Pure: every P3 profit item as {iso, kind, profit, amount, transfer}. kind is a ledger bucket or BONUS.
 * Bonus rows are [iso, type, account, payee, amount, ...] from buildBonusRows_.
 */
function p3ProfitItems_(ledger, bonusRows, tz) {
  const h = mapHeaderIndexes_(ledger[0] || []);
  const items = [];
  ledger.slice(1).forEach((r) => {
    const bucket = String(r[h.bucket] || '');
    if (P3_CFG.profitBuckets.indexOf(bucket) < 0) return;
    const iso = cellIso_(r[h.date], tz);
    if (!iso) return;
    const amount = toNumber_(r[h.amount]);
    items.push({ iso: iso, kind: bucket, profit: toNumber_(r[h.profit]), fee: toNumber_(r[h.fee]), amount: amount,
      transfer: XFER_CFG.buckets.indexOf(bucket) >= 0 && amount > 0 });
  });
  (bonusRows || []).forEach((b) => {
    if (b[0]) items.push({ iso: b[0], kind: 'BONUS', profit: toNumber_(b[4]), fee: 0, amount: 0, transfer: false });
  });
  return items;
}

/** Chris's share of P3's profit, by date, for the Summary's CaaS column: [{iso, profit}]. */
function caasShareRows_() {
  const ss = SpreadsheetApp.getActive();
  const led = ss.getSheetByName(P3_CFG.sheets.ledger);
  if (!led || led.getLastRow() < 1) return [];
  const share = p3Config_().share;
  return p3ProfitItems_(led.getDataRange().getValues(), p3BonusRows_(), ss.getSpreadsheetTimeZone())
    .map((i) => ({ iso: i.iso, profit: Math.round(i.profit * share * 100) / 100 }));
}

// ---------------------------------------------------------------- sheets

function rebuildP3Sheets() {
  const ss = SpreadsheetApp.getActive();
  if (!ss.getSheetByName(P3_CFG.sheets.ledger)) return;
  const L = P3_CFG.sheets.ledger;
  setTransferView_(P3_CFG.sheets.ms, 'MS', L);
  setTransferView_(P3_CFG.sheets.msCrypto, 'MS_CRYPTO', L);
  setTransferView_(P3_CFG.sheets.billPay, 'BILL_PAY', L);
  const bonuses = p3BonusRows_();
  writeBonusSheet_(P3_CFG.sheets.bonus, bonuses);
  writeCaasSheet_(bonuses);
}

/** Pure: CaaS table rows (newest month first, then all time) from p3ProfitItems_ output. */
function buildCaasData_(items, share) {
  const r2 = (x) => Math.round(x * 100) / 100;
  const blank = () => ({ MS: 0, MS_CRYPTO: 0, BILL_PAY: 0, costs: 0, BONUS: 0, spend: 0, transfers: 0 });
  const byMonth = {};
  const all = blank();
  items.forEach((i) => {
    [byMonth[i.iso.slice(0, 7)] = byMonth[i.iso.slice(0, 7)] || blank(), all].forEach((v) => {
      if (i.kind === 'CRYPTO_FEE' || i.kind === 'FLUZ_FEE') v.costs += i.profit;
      else v[i.kind] += i.profit;
      if (i.transfer) { v.spend += i.amount; v.transfers += 1; }
    });
  });
  const row = (label, v) => {
    const total = v.MS + v.MS_CRYPTO + v.BILL_PAY + v.costs + v.BONUS;
    return [label, r2(v.MS), r2(v.MS_CRYPTO), r2(v.BILL_PAY), r2(v.costs), r2(v.BONUS), r2(total),
      r2(total * share), r2(total - r2(total * share)), r2(v.spend), v.transfers];
  };
  const months = Object.keys(byMonth).sort().reverse();
  return months.map((m) => row(m, byMonth[m])).concat([row('All time', all)]);
}

function writeCaasSheet_(bonuses) {
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();
  const share = p3Config_().share;
  const ledger = ss.getSheetByName(P3_CFG.sheets.ledger).getDataRange().getValues();
  const items = p3ProfitItems_(ledger, bonuses, tz);
  const rows = buildCaasData_(items, share);
  const lh = mapHeaderIndexes_(ledger[0] || []);
  const review = ledger.slice(1).filter((r) => String(r[lh.bucket]) === 'REVIEW' ||
    /^no csv/.test(String(r[lh.match] || ''))).length;

  const created = !ss.getSheetByName(P3_CFG.sheets.caas);
  const sh = ensureSheet_(ss, P3_CFG.sheets.caas);
  if (created) {
    // New sheet: put it right after Bank Bonus & Referrals instead of at the end.
    const after = ss.getSheetByName(BONUS_CFG.sheet);
    if (after) { ss.setActiveSheet(sh); ss.moveActiveSheet(after.getIndex() + 1); }
  }
  const C = SUMMARY_CFG.colors;
  const money = '$#,##0.00;[Red]-$#,##0.00';
  const W = 11;
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear();
  sh.getRange(1, 1, 1, W).merge().setValue('Churning as a Service: P3').setFontSize(18).setFontWeight('bold')
    .setFontColor(C.text).setBackground(C.title);
  sh.setRowHeight(1, 40);
  const pct = (x) => Math.round(x * 100) + '%';
  sh.getRange(2, 1, 1, W).merge().setValue('Updated ' + Utilities.formatDate(new Date(), tz, 'MMM d, yyyy h:mm a') +
    '   ·   all P3 profit (transfers, fees, bank bonuses, referrals) split ' + pct(share) + ' you / ' +
    pct(1 - share) + ' P3. Your share is the CaaS column on Summary. Details: P3 MS, P3 MS-Crypto, P3 Bill Pay, P3 Bonuses.')
    .setFontColor('#666666').setFontStyle('italic').setWrap(true);
  sh.setRowHeight(2, 30);

  const head = ['Month', 'MS', 'MS-Crypto', 'Bill Pay', 'Fees & subscriptions', 'Bank bonus & referrals',
    'Total profit', 'Your share (' + pct(share) + ')', 'P3 share (' + pct(1 - share) + ')', 'Spend', 'Transfers'];
  sh.getRange(4, 1, 1, W).setValues([head]).setFontWeight('bold').setBackground(C.header).setWrap(true)
    .setHorizontalAlignment('center');
  sh.getRange(5, 1, rows.length, W).setValues(rows);
  sh.getRange(5, 1, rows.length, 1).setNumberFormat('@');
  sh.getRange(5, 2, rows.length, 9).setNumberFormat(money);
  sh.getRange(5, 11, rows.length, 1).setNumberFormat('#,##0');
  sh.getRange(5, 8, rows.length, 1).setFontWeight('bold').setFontColor('#1a7f37');
  sh.getRange(4 + rows.length, 1, 1, W).setFontWeight('bold').setBackground(C.header);
  const note = 4 + rows.length + 2;
  sh.getRange(note, 1, 1, 2).setValues([['P3 ledger rows needing review', review]])
    .setFontColor(review ? '#b42318' : '#666666');
  // Taekus accounts the extension saw on P3's login that aren't in P3's YNAB budget yet.
  const bal = ss.getSheetByName(INGEST.taekus.balanceSheet);
  const fresh = bal && bal.getLastRow() > 1 && bal.getLastColumn() >= 6
    ? bal.getRange(2, 1, bal.getLastRow() - 1, 6).getValues()
      .filter((r) => r[4] === P3_CFG.person && r[5]).map((r) => String(r[0]).padStart(4, '0') + (r[1] ? ' (' + r[1] + ')' : ''))
    : [];
  sh.getRange(note + 2, 1, 1, W).merge()
    .setValue(fresh.length ? 'New P3 Taekus accounts not in P3\'s YNAB budget yet: ' + fresh.join(', ') +
      '. Add them to the P3 budget as "TKB - <last 4> - P3" (or TKP) to start tracking them.' : '')
    .setFontColor('#b42318').setWrap(true);
  sh.getRange(note + 1, 1, 1, W).merge()
    .setValue('Taekus points for P3 come from ALT debit exports in the Drive folder "' + p3Config_().taekusFolder +
      '". Until a P3 account has an export, its transfers show "no csv for account" and earn 0 points.')
    .setFontColor('#666666').setFontStyle('italic').setWrap(true);
  sh.setColumnWidth(1, 120);
  for (let c = 2; c <= W; c += 1) sh.setColumnWidth(c, 110);
  sh.setFrozenRows(4);
}
