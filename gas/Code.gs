/**
 * MS-CHRN Google Apps Script
 *
 * 1) Keep the YNAB sheet mirrored from the YNAB API (incremental, throttle-safe).
 * 2) Feed the transfer profit pipeline (TransferProfit.gs, TargetCharts.gs, YnabHistory.gs)
 *    behind the MS, MS-Crypto, Bill Pay, Summary and Targets sheets.
 */

const CFG = {
  ynabBaseUrl: 'https://api.youneedabudget.com/v1',
  sheets: {
    summary: 'Summary',
    ms: 'MS',
    msCrypto: 'MS-Crypto',
    billPay: 'Bill Pay',
    ynabMirror: 'YNAB',
    ynabAccounts: 'YNAB_Accounts',
    config: 'Config'
  },
  mirrorHeaders: [
    'Account', 'Flag', 'Date', 'Payee', 'Category Group/Category', 'Category Group', 'Category', 'Memo',
    'Outflow', 'Inflow', 'Cleared',
    'txn_id', 'account_id', 'transfer_account_id', 'deleted', 'approved', 'flag_color_raw', 'import_id',
    'last_modified_on', 'source', 'split_fee', 'split_payees'
  ],
  accountHeaders: ['account_id', 'account_name', 'account_type', 'on_budget', 'closed', 'note', 'balance'],
  debtTypes: new Set(['creditCard', 'lineOfCredit', 'otherDebt', 'mortgage'])
};

function setupWorkbook() {
  const ss = SpreadsheetApp.getActive();
  Object.values(CFG.sheets).forEach((name) => ensureSheet_(ss, name));
  seedConfigSheet_();
  seedHeaders_();
  ensureTransferSheets_();
  applyViewFormulas_();
  applySummaryFormulas_();
}

function syncYnabMirrorOnDemand() {
  syncYnabMirror_({ force: false, calledBy: 'manual' });
}

function syncYnabMirrorScheduled() {
  const started = new Date();
  try {
    syncYnabMirror_({ force: false, calledBy: 'trigger' });
    logSync_(started, 'ok', '');
  } catch (e) {
    logSync_(started, 'error', String(e && e.stack || e));
    throw e;
  }
}

/** Keep the last 50 sync results in a Sync_Log sheet (time, status, seconds, message). */
function logSync_(started, status, message) {
  try {
    const sh = ensureSheet_(SpreadsheetApp.getActive(), 'Sync_Log');
    if (sh.getLastRow() === 0) sh.appendRow(['started', 'status', 'seconds', 'message']);
    sh.insertRowAfter(1);
    sh.getRange(2, 1, 1, 4).setValues([[started, status, Math.round((Date.now() - started) / 1000),
      String(message).slice(0, 2000)]]);
    if (sh.getLastRow() > 51) sh.deleteRows(52, sh.getLastRow() - 51);
  } catch (e) {
    console.warn('logSync_: ' + e);
  }
}

function syncYnabMirrorForceFull() {
  syncYnabMirror_({ force: true, calledBy: 'manual_full' });
}

function syncYnabMirror_(opts) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (!opts.force && isWithinSyncCooldown_()) {
      return;
    }

    pullYnabMirror_(opts);
    combinedMirrorCache_ = null;
    importYnabHistory();

    importTaekusCsvs();
    importFluzCsvs();
    importBlupeCsvs();
    try { refreshCoinbaseFees(); } catch (e) { console.warn('Coinbase fees: ' + e.message); }
    try { refreshMetaMaskRewards(); } catch (e) { console.warn('MetaMask rewards: ' + e.message); }
    rebuildTransferLedger();
    if (SpreadsheetApp.getActive().getSheetByName(TARGET_CFG.dashSheet) &&
      PropertiesService.getDocumentProperties().getProperty('TARGETS_DASH_VERSION') === TARGET_CFG.version) rebuildTargetStats();
    else { setupTargetDashboard(); arrangeSheets_(); } // first run after a setup that ran out of time
    applyViewFormulas_();
    applySummaryFormulas_();
    rebuildBonusSheet();
  } finally {
    lock.releaseLock();
  }
}

/** Fetch accounts + changed transactions into the mirror (no lock, no cooldown). */
function pullYnabMirror_(opts) {
  const token = getScriptProperty_('YNAB_TOKEN');
  const budgetId = getScriptProperty_('YNAB_BUDGET_ID');
  const props = PropertiesService.getDocumentProperties();
  const lastKnowledge = Number(props.getProperty('YNAB_SERVER_KNOWLEDGE') || 0);

  const accountMap = fetchYnabAccounts_(token, budgetId);
  writeAccounts_(accountMap);

  // Keep the header in step with CFG.mirrorHeaders (rows are written by position, and the
  // ledger reads columns by header name). A new column means older rows lack it, so refetch all.
  const mirrorSheet = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.ynabMirror);
  const header = mirrorSheet.getRange(1, 1, 1, CFG.mirrorHeaders.length).getValues()[0];
  const stale = CFG.mirrorHeaders.some((h, i) => String(header[i]) !== h);
  mirrorSheet.getRange(1, 1, 1, CFG.mirrorHeaders.length).setValues([CFG.mirrorHeaders]);
  const full = opts.force || !lastKnowledge || stale;

  const txData = fetchYnabTransactions_(token, budgetId, full ? 0 : lastKnowledge);
  const catGroups = fetchYnabCategoryGroups_(token, budgetId);
  upsertMirrorTransactions_(txData.transactions || [], accountMap, full, catGroups);

  props.setProperty('YNAB_SERVER_KNOWLEDGE', String(txData.server_knowledge || 0));
  props.setProperty('YNAB_LAST_SYNC_EPOCH_MS', String(Date.now()));
  props.setProperty('YNAB_LAST_SYNC_CALLER', String(opts.calledBy || 'unknown'));
}

/** category_id -> category group name (transactions only carry the category name). */
function fetchYnabCategoryGroups_(token, budgetId) {
  const data = ynabGetWithBackoff_(`${CFG.ynabBaseUrl}/budgets/${budgetId}/categories`, token);
  const map = {};
  (data.category_groups || []).forEach((g) => {
    (g.categories || []).forEach((c) => { map[c.id] = g.name; });
  });
  return map;
}

function fetchYnabAccounts_(token, budgetId) {
  const url = `${CFG.ynabBaseUrl}/budgets/${budgetId}/accounts`;
  const data = ynabGetWithBackoff_(url, token);
  const map = {};
  (data.accounts || []).forEach((a) => {
    map[a.id] = {
      id: a.id,
      name: a.name,
      type: a.type,
      on_budget: a.on_budget,
      closed: a.closed,
      note: a.note || '',
      balance: Number(a.balance || 0) / 1000
    };
  });
  return map;
}

function fetchYnabTransactions_(token, budgetId, serverKnowledge) {
  let url = `${CFG.ynabBaseUrl}/budgets/${budgetId}/transactions`;
  if (serverKnowledge && serverKnowledge > 0) {
    url += `?last_knowledge_of_server=${encodeURIComponent(serverKnowledge)}`;
  }
  const data = ynabGetWithBackoff_(url, token);
  return {
    transactions: data.transactions || [],
    server_knowledge: data.server_knowledge || serverKnowledge || 0
  };
}

function ynabGetWithBackoff_(url, token) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: `Bearer ${token}` },
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    if (code < 300) return JSON.parse(response.getContentText()).data;

    if (code === 429 && attempt < 4) {
      const retryHeader = response.getHeaders()['Retry-After'];
      const retryMs = retryHeader ? Number(retryHeader) * 1000 : attempt * 1500;
      Utilities.sleep(Math.max(1000, retryMs));
      continue;
    }

    if (code >= 500 && attempt < 4) {
      Utilities.sleep(attempt * 1000);
      continue;
    }

    throw new Error(`YNAB API request failed ${code}: ${response.getContentText()}`);
  }

  throw new Error('YNAB API request failed after retries.');
}

function upsertMirrorTransactions_(transactions, accountMap, replaceAll, catGroups) {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.ynabMirror);

  if (replaceAll) {
    const rows = transactions
      .filter((t) => !t.deleted)
      .map((t) => mapTxnToMirrorRow_(t, accountMap, catGroups));
    resetDataBody_(sh, CFG.mirrorHeaders.length);
    if (rows.length) {
      sh.getRange(2, 1, rows.length, CFG.mirrorHeaders.length).setValues(rows);
    }
    return;
  }

  const values = sh.getDataRange().getValues();
  const headerMap = mapHeaderIndexes_(values[0]);
  const txnCol = headerMap.txn_id;

  const rowByTxn = {};
  for (let i = 1; i < values.length; i += 1) {
    const id = String(values[i][txnCol] || '').trim();
    if (id) rowByTxn[id] = i + 1;
  }

  const updates = [];
  const appends = [];
  const deletes = [];

  transactions.forEach((t) => {
    const id = String(t.id || '');
    const existingRow = rowByTxn[id];
    if (t.deleted) {
      if (existingRow) deletes.push(existingRow);
      return;
    }

    const row = mapTxnToMirrorRow_(t, accountMap, catGroups);
    if (existingRow) updates.push({ row: existingRow, values: row });
    else appends.push(row);
  });

  // Many changes (e.g. a bulk recategorize): rewrite the body once instead of row by row.
  if (updates.length + deletes.length > 150) {
    const w = CFG.mirrorHeaders.length;
    const byRow = {};
    updates.forEach((u) => { byRow[u.row] = u.values; });
    const gone = new Set(deletes);
    const rows = [];
    for (let i = 1; i < values.length; i += 1) {
      if (gone.has(i + 1)) continue;
      rows.push(byRow[i + 1] || values[i].slice(0, w));
    }
    appends.forEach((r) => rows.push(r));
    resetDataBody_(sh, w);
    if (rows.length) sh.getRange(2, 1, rows.length, w).setValues(rows);
    return;
  }

  deletes.sort((a, b) => b - a).forEach((rowNum) => sh.deleteRow(rowNum));

  updates.forEach((u) => {
    sh.getRange(u.row, 1, 1, CFG.mirrorHeaders.length).setValues([u.values]);
  });

  if (appends.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, CFG.mirrorHeaders.length).setValues(appends);
  }
}

function mapTxnToMirrorRow_(t, accountMap, catGroups) {
  const src = accountMap[t.account_id] || {};
  // Split: fee lines are summed into split_fee; the largest line's category and transfer
  // stand for the parent (YNAB itself only says "Split").
  const groups = catGroups || {};
  const subs = (t.subtransactions || []).filter((s) => !s.deleted);
  let splitFee = 0;
  let splitPayees = '';
  let transferId = t.transfer_account_id || '';
  let catId = t.category_id;
  let cName = t.category_name || '';
  if (subs.length) {
    subs.forEach((s) => {
      const text = [s.category_name, groups[s.category_id], s.payee_name].join(' ');
      if (/\bfees?\b/i.test(text) && s.amount < 0) splitFee += Math.abs(s.amount) / 1000;
    });
    splitPayees = Array.from(new Set(subs.map((s) => s.payee_name || '')
      .filter((p) => p && !/^Transfer : /.test(p)))).join(' | ');
    const big = subs.slice().sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
    if (!transferId) transferId = big.transfer_account_id || '';
    catId = big.category_id;
    cName = big.category_name || '';
  }
  const dst = accountMap[transferId] || {};
  const amount = Number(t.amount || 0) / 1000;
  const outflow = amount < 0 ? Math.abs(amount) : 0;
  const inflow = amount > 0 ? amount : 0;

  const cGroup = (subs.length ? '' : t.category_group_name) || groups[catId] || '';
  const cgc = cGroup && cName ? `${cGroup}: ${cName}` : cName;
  const payee = t.payee_name || (dst.name ? `Transfer : ${dst.name}` : '');

  return [
    src.name || '',
    t.flag_color || '',
    t.date || '',
    payee,
    cgc,
    cGroup,
    cName,
    t.memo || '',
    outflow,
    inflow,
    normalizeCleared_(t.cleared || ''),
    t.id || '',
    t.account_id || '',
    transferId,
    Boolean(t.deleted),
    Boolean(t.approved),
    t.flag_color || '',
    t.import_id || '',
    t.date || '',
    'ynab_api',
    Math.round(splitFee * 100) / 100,
    splitPayees
  ];
}

function writeAccounts_(accountMap) {
  const rows = Object.values(accountMap)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((a) => [a.id, a.name, a.type, a.on_budget, a.closed, a.note, a.balance]);

  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.ynabAccounts);
  sh.getRange(1, 1, 1, CFG.accountHeaders.length).setValues([CFG.accountHeaders]);
  resetDataBody_(sh, CFG.accountHeaders.length);
  if (rows.length) {
    sh.getRange(2, 1, rows.length, CFG.accountHeaders.length).setValues(rows);
  }
}

function applyViewFormulas_() {
  // MS / MS-Crypto / Bill Pay come from Transfer_Ledger (TransferProfit.gs).
  setTransferView_(CFG.sheets.ms, 'MS');
  setTransferView_(CFG.sheets.msCrypto, 'MS_CRYPTO');
  setTransferView_(CFG.sheets.billPay, 'BILL_PAY');
}

function applySummaryFormulas_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.summary);
  const L = XFER_CFG.sheets.ledger;
  sh.clear();
  sh.getRange('A1').setValue('MS-CHRN Transfer Profit Summary');
  sh.getRange('A3:F3').setValues([['Bucket', 'Transfers', 'Amount', 'Points', 'Profit', 'Avg rate']]);

  const buckets = ['MS', 'MS_CRYPTO', 'BILL_PAY'];
  buckets.forEach((b, i) => {
    const row = 4 + i;
    sh.getRange(row, 1).setValue(b);
    sh.getRange(row, 2).setFormula(`=COUNTIF('${L}'!H:H,A${row})`);
    sh.getRange(row, 3).setFormula(`=SUMIFS('${L}'!G:G,'${L}'!H:H,A${row})`);
    sh.getRange(row, 4).setFormula(`=SUMIFS('${L}'!I:I,'${L}'!H:H,A${row})`);
    sh.getRange(row, 5).setFormula(`=SUMIFS('${L}'!K:K,'${L}'!H:H,A${row})`);
    sh.getRange(row, 6).setFormula(`=IFERROR(E${row}/C${row},0)`);
  });
  sh.getRange('A7').setValue('Total');
  sh.getRange('B7:E7').setFormulas([['=SUM(B4:B6)', '=SUM(C4:C6)', '=SUM(D4:D6)', '=SUM(E4:E6)']]);
  sh.getRange('F7').setFormula('=IFERROR(E7/C7,0)');
  // Fluz load fees (card-funded Add Money) can't be tied to a transfer; they come off the total here.
  sh.getRange('A8').setValue('Fluz load fees');
  sh.getRange('B8').setFormula(`=COUNTIF('${L}'!H:H,"FLUZ_FEE")`);
  sh.getRange('E8').setFormula(`=SUMIFS('${L}'!K:K,'${L}'!H:H,"FLUZ_FEE")`);
  sh.getRange('A9').setValue('Coinbase One fees');
  sh.getRange('B9').setFormula(`=COUNTIF('${L}'!H:H,"CRYPTO_FEE")`);
  sh.getRange('E9').setFormula(`=SUMIFS('${L}'!K:K,'${L}'!H:H,"CRYPTO_FEE")`);
  sh.getRange('A10').setValue('Net profit after fees');
  sh.getRange('E10').setFormula('=E7+E8+E9');
  sh.getRange('F10').setFormula('=IFERROR(E10/C7,0)');
  sh.getRange('A11').setValue('Needs review');
  sh.getRange('B11').setFormula(`=COUNTIF('${L}'!H:H,"REVIEW")+COUNTIF('${L}'!M:M,"no csv row*")`);
  sh.getRange('C4:C10').setNumberFormat('$#,##0.00');
  sh.getRange('D4:D10').setNumberFormat('#,##0');
  sh.getRange('E4:E10').setNumberFormat('$#,##0.00');
  sh.getRange('F4:F10').setNumberFormat('0.00%');
  sh.getRange('A3:F3').setFontWeight('bold');
  sh.getRange('A7:F7').setFontWeight('bold');
  sh.getRange('A10:F10').setFontWeight('bold');
  // Fluz load fees by month
  sh.getRange('H3').setFormula(
    `=IFERROR(QUERY('${L}'!A1:V,"select S, count(G), sum(G) where H = 'FLUZ_FEE' group by S order by S desc ` +
    `label S 'Fluz fee month', count(G) 'charges', sum(G) 'fees'",1),"")`);
  sh.getRange('J4:J').setNumberFormat('$#,##0.00');
  sh.getRange('H3:J3').setFontWeight('bold');
  // Profit by source, and Blue Penguin's actual monthly rebates next to the per-transfer estimate
  // (estimate = interchange x Config blupe/interchange_share).
  const tracked = '{"MS","MS_CRYPTO","BILL_PAY"}';
  sh.getRange('L3:M3').setValues([['Source', 'Profit']]);
  [['TAEKUS', 'Taekus (points)'], ['FLUZ', 'Fluz (cashback)'], ['BLUPE', 'Blue Penguin (est. interchange share)'],
    ['UPGRADE', 'Upgrade (monthly rewards)'], ['PRIMIS', 'Primis (monthly rewards)'], ['METAMASK', 'MetaMask Card (on-chain mUSD)']]
    .forEach((src, i) => {
      sh.getRange(4 + i, 12).setValue(src[1]);
      sh.getRange(4 + i, 13).setFormula(`=SUM(SUMIFS('${L}'!K:K,'${L}'!B:B,"${src[0]}",'${L}'!H:H,${tracked}))`);
    });
  sh.getRange('L10').setValue('Blue Penguin rebates received');
  sh.getRange('M10').setFormula(`=SUMIFS('${L}'!V:V,'${L}'!H:H,"BLUPE_REBATE")`);
  sh.getRange('M4:M10').setNumberFormat('$#,##0.00');
  sh.getRange('L3:M3').setFontWeight('bold');

  sh.getRange('A13:C13').setValues([['Sync Info', 'Value', 'Notes']]);
  sh.getRange('A14').setValue('Last API Sync (epoch ms)');
  sh.getRange('B14').setValue(PropertiesService.getDocumentProperties().getProperty('YNAB_LAST_SYNC_EPOCH_MS') || '');
  sh.getRange('A15').setValue('Server Knowledge');
  sh.getRange('B15').setValue(PropertiesService.getDocumentProperties().getProperty('YNAB_SERVER_KNOWLEDGE') || '');
  sh.getRange('A16').setValue('Sync Cooldown Minutes');
  sh.getRange('B16').setFormula(`=IFERROR(VLOOKUP("sync_min_minutes",FILTER(${CFG.sheets.config}!B:C,${CFG.sheets.config}!A:A="sync"),2,FALSE),20)`);

  sh.setFrozenRows(3);
}

function isWithinSyncCooldown_() {
  const props = PropertiesService.getDocumentProperties();
  const last = Number(props.getProperty('YNAB_LAST_SYNC_EPOCH_MS') || 0);
  if (!last) return false;
  const cfg = readConfigKV_('sync');
  const minMinutes = Number(cfg.sync_min_minutes || 20);
  const elapsed = (Date.now() - last) / 60000;
  return elapsed < minMinutes;
}

function seedHeaders_() {
  const ss = SpreadsheetApp.getActive();

  const mirror = ss.getSheetByName(CFG.sheets.ynabMirror);
  mirror.getRange(1, 1, 1, CFG.mirrorHeaders.length).setValues([CFG.mirrorHeaders]);
  mirror.setFrozenRows(1);

  const acc = ss.getSheetByName(CFG.sheets.ynabAccounts);
  acc.getRange(1, 1, 1, CFG.accountHeaders.length).setValues([CFG.accountHeaders]);
  acc.setFrozenRows(1);
}

function seedConfigSheet_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.config);
  if (sh.getLastRow() > 0) return;
  sh.getRange(1, 1, 1, 3).setValues([['section', 'key', 'value']]);
  sh.getRange(2, 1, 1, 3).setValues([['sync', 'sync_min_minutes', '20']]);
  sh.setFrozenRows(1);
}

function readConfigKV_(section) {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.config);
  const values = sh.getDataRange().getValues();
  const out = {};
  values.slice(1).forEach((r) => {
    if (String(r[0]).trim() !== section) return;
    out[String(r[1]).trim()] = String(r[2]).trim();
  });
  return out;
}

function normalizeCleared_(v) {
  const val = String(v || '').toLowerCase();
  if (val === 'cleared') return 'Cleared';
  if (val === 'reconciled') return 'Reconciled';
  return 'Uncleared';
}

function toNumber_(v) {
  if (typeof v === 'number') return v;
  const cleaned = String(v || '').replace(/[$,]/g, '').trim();
  if (!cleaned) return 0;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapHeaderIndexes_(headerRow) {
  const map = {};
  headerRow.forEach((h, idx) => {
    map[String(h).trim()] = idx;
  });
  return map;
}

function resetDataBody_(sheet, width) {
  const last = sheet.getLastRow();
  if (last > 1) {
    sheet.getRange(2, 1, last - 1, width).clearContent();
  }
}

function ensureSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function getScriptProperty_(key) {
  const val = PropertiesService.getScriptProperties().getProperty(key);
  if (!val) throw new Error(`Missing script property: ${key}`);
  return val;
}
