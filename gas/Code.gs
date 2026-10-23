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
  // A "running" row is written first and updated after every step, so a run that hits the
  // 6-minute limit still shows how far it got and how long each step took.
  logSync_(started, 'running', '');
  syncLogLive_ = started;
  try {
    syncYnabMirror_({ force: false, calledBy: 'trigger' });
    updateSyncLog_('ok');
  } catch (e) {
    updateSyncLog_('error', String(e && e.stack || e));
    throw e;
  }
}

/** Keep the last 50 sync results in a Sync_Log sheet (time, status, seconds, message). */
// Side-step results (Fluz API, Coinbase, MetaMask) shown in the Sync_Log message column.
var syncNotes_ = [];
var syncLogLive_ = null; // start time of the scheduled run whose Sync_Log row is row 2

/** Run one sync step, timing it into the Sync_Log message. */
function syncStep_(name, fn) {
  const t0 = Date.now();
  try {
    return fn();
  } finally {
    syncNotes_.push(name + ' ' + Math.round((Date.now() - t0) / 1000) + 's');
    updateSyncLog_('running');
  }
}

function updateSyncLog_(status, extra) {
  if (!syncLogLive_) return;
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName('Sync_Log');
    sh.getRange(2, 2, 1, 3).setValues([[status, Math.round((Date.now() - syncLogLive_) / 1000),
      (syncNotes_.join(' | ') + (extra ? ' | ' + extra : '')).slice(0, 2000)]]);
  } catch (e) {
    console.warn('updateSyncLog_: ' + e);
  }
}

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

    syncStep_('ynab', () => pullYnabMirror_(opts));
    combinedMirrorCache_ = null;
    syncStep_('history', () => importYnabHistory());
    // One-time rewrite of the raw sheets newest-first (RAW_ORDER), then only when the CSVs change.
    const docProps = PropertiesService.getDocumentProperties();
    const reorder = docProps.getProperty('RAW_ORDER') !== 'newest_first';
    syncStep_('taekus', () => importTaekusCsvs(reorder));
    syncStep_('fluz', () => importFluzCsvs(reorder));
    syncStep_('blupe', () => importBlupeCsvs(reorder));
    if (reorder) docProps.setProperty('RAW_ORDER', 'newest_first');
    syncStep_('coinbase', () => {
      try { refreshCoinbaseFees(); } catch (e) { syncNotes_.push('Coinbase fees: ' + e.message); }
    });
    syncStep_('metamask', () => {
      try { const n = refreshMetaMaskRewards(); if (n) syncNotes_.push('MetaMask +' + n); } catch (e) { syncNotes_.push('MetaMask: ' + e.message); }
    });
    syncStep_('solana', () => {
      try { const n = refreshSolanaDeposits(); if (n) syncNotes_.push('Solana +' + n); } catch (e) { syncNotes_.push('Solana: ' + e.message); }
    });
    syncStep_('ledger', () => rebuildTransferLedger());
    syncStep_('targets', () => {
      if (SpreadsheetApp.getActive().getSheetByName(TARGET_CFG.dashSheet) &&
        PropertiesService.getDocumentProperties().getProperty('TARGETS_DASH_VERSION') === TARGET_CFG.version) rebuildTargetStats();
      else { setupTargetDashboard(); arrangeSheets_(); } // first run after a setup that ran out of time
    });
    syncStep_('views', () => { applyViewFormulas_(); applySummaryFormulas_(); });
    syncStep_('bonus', () => rebuildBonusSheet());
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
  writeSummary_(); // SummaryDash.gs
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
