/**
 * MS-CHRN Google Apps Script
 *
 * Goals:
 * 1) Keep a sheet that mirrors YNAB export columns.
 * 2) Seed from CSV export first, then keep updated with YNAB API.
 * 3) Support on-demand and scheduled sync with API-throttle safety.
 * 4) Calculate cashback using standard rates + per-transaction overrides.
 */

const CFG = {
  ynabBaseUrl: 'https://api.youneedabudget.com/v1',
  sheets: {
    summary: 'Summary',
    ms: 'MS',
    msCrypto: 'MS-Crypto',
    billPay: 'Bill Pay',
    bankBonus: 'Bank Bonus',
    ynabMirror: 'YNAB',
    ynabAccounts: 'YNAB_Accounts',
    config: 'Config',
    rates: 'Cash Back Rates',
    overrides: 'Cashback_Overrides',
    ledger: 'Cashback_Ledger',
    ynabSeed: 'YNAB_CSV_Seed',
    taekusRaw: 'Taekus_Raw',
    bluepeRaw: 'BLUPE_Raw',
    fluzRaw: 'Fluz_Raw',
    altRaw: 'ALT_Raw'
  },
  mirrorHeaders: [
    'Account', 'Flag', 'Date', 'Payee', 'Category Group/Category', 'Category Group', 'Category', 'Memo',
    'Outflow', 'Inflow', 'Cleared',
    'txn_id', 'account_id', 'transfer_account_id', 'deleted', 'approved', 'flag_color_raw', 'import_id',
    'last_modified_on', 'source', 'split_fee'
  ],
  accountHeaders: ['account_id', 'account_name', 'account_type', 'on_budget', 'closed', 'note'],
  rateHeaders: ['active', 'bucket', 'match_field', 'match_type', 'match_value', 'standard_rate', 'cashback_source', 'notes'],
  overrideHeaders: ['txn_id', 'override_rate', 'override_source', 'notes'],
  ledgerHeaders: [
    'txn_id', 'date', 'account', 'payee', 'category_group', 'category', 'memo', 'outflow', 'inflow',
    'route_bucket', 'standard_rate', 'override_rate', 'effective_rate', 'cashback_base', 'cashback_amount',
    'rate_source', 'provider_hint', 'cleared'
  ],
  depositoryTypes: new Set(['checking', 'savings', 'cash']),
  debtTypes: new Set(['creditCard', 'lineOfCredit', 'otherDebt', 'mortgage']),
  cryptoRegex: /coinbase|kraken|gemini|crypto|bitcoin|eth|usdc|usdt|sol|binance|robinhood|pyusd/i,
  bankBonusRegex: /bonus|promo bonus|signup bonus|bank bonus/i,
  billPayRegex: /credit card|cc payment|loan|mortgage|autoloan|student loan/i,
  cashBackRegex: /cash\s*back|cashback/i
};

function setupWorkbook() {
  const ss = SpreadsheetApp.getActive();
  Object.values(CFG.sheets).forEach((name) => ensureSheet_(ss, name));
  seedConfigSheet_();
  seedHeaders_();
  seedRatesSheet_();
  seedOverrideSheet_();
  seedRawHelperSheets_();
  ensureTransferSheets_();
  applyViewFormulas_();
  applySummaryFormulas_();
}

function seedMirrorFromSeedSheet() {
  const ss = SpreadsheetApp.getActive();
  const seed = ss.getSheetByName(CFG.sheets.ynabSeed);
  const mirror = ss.getSheetByName(CFG.sheets.ynabMirror);
  const values = seed.getDataRange().getValues();
  if (values.length < 2) throw new Error('YNAB_CSV_Seed has no data to import.');

  const headerMap = mapHeaderIndexes_(values[0]);
  const required = ['Account', 'Flag', 'Date', 'Payee', 'Category Group/Category', 'Category Group', 'Category', 'Memo', 'Outflow', 'Inflow', 'Cleared'];
  required.forEach((h) => {
    if (headerMap[h] === undefined) throw new Error(`Missing required CSV column: ${h}`);
  });

  const out = values.slice(1).map((r) => {
    const row = required.map((h) => r[headerMap[h]]);
    while (row.length < CFG.mirrorHeaders.length) row.push('');
    row[19] = 'csv_seed';
    return row;
  });

  resetDataBody_(mirror, CFG.mirrorHeaders.length);
  if (out.length) mirror.getRange(2, 1, out.length, CFG.mirrorHeaders.length).setValues(out);
}

function syncYnabMirrorOnDemand() {
  syncYnabMirror_({ force: false, calledBy: 'manual' });
}

function syncYnabMirrorScheduled() {
  syncYnabMirror_({ force: false, calledBy: 'trigger' });
}

function syncYnabMirrorForceFull() {
  syncYnabMirror_({ force: true, calledBy: 'manual_full' });
}

function installDailyTrigger() {
  ScriptApp.newTrigger('syncYnabMirrorScheduled').timeBased().everyDays(1).atHour(5).create();
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

    // Transfer profit first, so the older full-mirror steps can't starve it of run time.
    importTaekusCsvs();
    rebuildTransferLedger();
    if (SpreadsheetApp.getActive().getSheetByName(TARGET_CFG.dashSheet)) rebuildTargetStats();
    else setupTargetDashboard(); // first run after a setup that ran out of time
    applyViewFormulas_();
    applySummaryFormulas_();
    buildCashBackRatesSheet();
    rebuildCashbackLedger();
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

  const txData = fetchYnabTransactions_(token, budgetId, opts.force ? 0 : lastKnowledge);
  const catGroups = fetchYnabCategoryGroups_(token, budgetId);
  upsertMirrorTransactions_(txData.transactions || [], accountMap, opts.force || !lastKnowledge, catGroups);

  props.setProperty('YNAB_SERVER_KNOWLEDGE', String(txData.server_knowledge || 0));
  props.setProperty('YNAB_LAST_SYNC_EPOCH_MS', String(Date.now()));
  props.setProperty('YNAB_LAST_SYNC_CALLER', String(opts.calledBy || 'unknown'));
}

function rebuildCashbackLedger() {
  const ss = SpreadsheetApp.getActive();
  const mirror = ss.getSheetByName(CFG.sheets.ynabMirror);
  const out = ss.getSheetByName(CFG.sheets.ledger);

  const mirrorValues = mirror.getDataRange().getValues();
  if (mirrorValues.length <= 1) {
    resetDataBody_(out, CFG.ledgerHeaders.length);
    return;
  }

  const m = mapHeaderIndexes_(mirrorValues[0]);
  const accountMap = readAccountMap_();
  const trackedMatchers = readTrackedMatchers_();
  const currentRates = readCurrentRates_();
  const overrides = readOverrides_();
  const providerRates = readProviderRates_();

  const rows = [];
  for (let i = 1; i < mirrorValues.length; i += 1) {
    const r = mirrorValues[i];
    const txnId = String(r[m.txn_id] || '').trim();
    if (!txnId) continue;
    if (String(r[m.deleted]).toLowerCase() === 'true') continue;

    const accountName = normalizeCanonicalAccountName_(String(r[m.Account] || '').trim());
    const payee = String(r[m.Payee] || '').trim();
    const categoryGroup = String(r[m['Category Group']] || '').trim();
    const category = String(r[m.Category] || '').trim();
    const memo = String(r[m.Memo] || '').trim();
    const cgc = String(r[m['Category Group/Category']] || '').trim();
    const outflow = toNumber_(r[m.Outflow]);
    const inflow = toNumber_(r[m.Inflow]);

    const transferAccountId = String(r[m.transfer_account_id] || '').trim();
    const accountId = String(r[m.account_id] || '').trim();
    const src = accountMap[accountId] || {};
    const dst = accountMap[transferAccountId] || {};

    const bucket = classifyRoute_({
      src,
      dst,
      accountName,
      payee,
      memo,
      category,
      categoryGroup,
      outflow,
      inflow,
      isTrackedSource: matchesAny_(accountName, trackedMatchers)
    });

    const inlineRate = extractInlineRate_(memo, payee, category);
    const providerRate = providerRates[txnId] || '';
    // Default current CBR from the Cash Back Rates sheet, matched by Source + Target.
    const targetCandidates = [
      normalizeCanonicalAccountName_(category),
      dst.name ? normalizeCanonicalAccountName_(dst.name) : '',
      category
    ];
    const routeHit = inlineRate ? null : lookupRouteCbr_(currentRates, accountName, targetCandidates);
    const routeRate = routeHit ? routeHit.rate : 0;

    const standardRate = inlineRate || routeRate || providerRate || 0;
    const overrideRate = overrides[txnId] || '';
    const effectiveRate = overrideRate !== '' ? overrideRate : standardRate;
    const base = outflow > 0 ? outflow : 0;
    const cashbackAmount = base * (effectiveRate || 0);

    let rateSource = 'none';
    if (overrideRate !== '') rateSource = 'override';
    else if (inlineRate) rateSource = 'ynab_memo_or_payee';
    else if (routeRate) rateSource = 'route_cbr';
    else if (providerRate) rateSource = 'provider_raw';

    rows.push([
      txnId,
      r[m.Date],
      accountName,
      payee,
      categoryGroup,
      category,
      memo,
      outflow,
      inflow,
      bucket,
      standardRate,
      overrideRate,
      effectiveRate,
      base,
      cashbackAmount,
      rateSource,
      inferProviderHint_(accountName, payee, memo),
      r[m.Cleared]
    ]);
  }

  resetDataBody_(out, CFG.ledgerHeaders.length);
  if (rows.length) {
    out.getRange(2, 1, rows.length, CFG.ledgerHeaders.length).setValues(rows);
  }
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
      note: a.note || ''
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
  if (updates.length + deletes.length > 50) {
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
  let transferId = t.transfer_account_id || '';
  let catId = t.category_id;
  let cName = t.category_name || '';
  if (subs.length) {
    subs.forEach((s) => {
      const text = [s.category_name, groups[s.category_id], s.payee_name].join(' ');
      if (/\bfees?\b/i.test(text) && s.amount < 0) splitFee += Math.abs(s.amount) / 1000;
    });
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
    Math.round(splitFee * 100) / 100
  ];
}

function classifyRoute_(ctx) {
  const textBlob = [ctx.accountName, ctx.payee, ctx.memo, ctx.category, ctx.categoryGroup].join(' ');
  const isCrypto = CFG.cryptoRegex.test(textBlob);
  const isBankBonus = ctx.inflow > 0 && CFG.bankBonusRegex.test(textBlob);
  const isBillPayByType = CFG.debtTypes.has(ctx.src.type) || CFG.debtTypes.has(ctx.dst.type);
  const isBillPay = isBillPayByType || CFG.billPayRegex.test(textBlob);
  const isTransfer = String(ctx.payee).toLowerCase().startsWith('transfer :') || Boolean(ctx.dst.id);

  if (isBankBonus) return 'BANK_BONUS';
  if (isBillPay && ctx.outflow > 0) return 'BILL_PAY';
  if (isCrypto && ctx.outflow > 0) return 'MS_CRYPTO';

  const srcDepo = CFG.depositoryTypes.has(String(ctx.src.type || '').toLowerCase());
  const dstDepo = CFG.depositoryTypes.has(String(ctx.dst.type || '').toLowerCase());
  if (isTransfer && ctx.isTrackedSource && srcDepo && dstDepo && ctx.outflow > 0) return 'MS';

  return 'OTHER';
}

function extractInlineRate_(memo, payee, category) {
  const txt = `${memo || ''} ${payee || ''} ${category || ''}`;
  const m = txt.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
  if (!m) return 0;
  return Number(m[1]) / 100;
}

function readProviderRates_() {
  const out = {};
  [CFG.sheets.bluepeRaw, CFG.sheets.fluzRaw, CFG.sheets.altRaw, CFG.sheets.taekusRaw].forEach((sheetName) => {
    const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
    const values = sh.getDataRange().getValues();
    if (values.length <= 1) return;
    const h = mapHeaderIndexes_(values[0]);

    for (let i = 1; i < values.length; i += 1) {
      const row = values[i];
      const txnId = String(row[h.txn_id] || row[h['Transaction ID']] || '').trim();
      const rate = toNumber_(row[h.effective_rate] || row[h['Cashback Rate']] || row[h['Effective rate']] || row[h.rate]);
      if (!txnId || !rate) continue;
      out[txnId] = rate > 1 ? rate / 100 : rate;
    }
  });
  return out;
}

function readRateRules_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.rates);
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return [];
  const h = mapHeaderIndexes_(values[0]);

  return values.slice(1)
    .map((r) => ({
      active: String(r[h.active]).toLowerCase() === 'true' || String(r[h.active]).toLowerCase() === 'yes',
      bucket: String(r[h.bucket] || '').trim(),
      matchField: String(r[h.match_field] || '').trim(),
      matchType: String(r[h.match_type] || '').trim().toLowerCase(),
      matchValue: String(r[h.match_value] || '').trim(),
      standardRate: toNumber_(r[h.standard_rate]),
      cashbackSource: String(r[h.cashback_source] || '').trim(),
      notes: String(r[h.notes] || '').trim()
    }))
    .filter((r) => r.active && r.standardRate > 0 && r.matchValue);
}

function findRateRule_(rules, ctx) {
  for (let i = 0; i < rules.length; i += 1) {
    const r = rules[i];
    if (r.bucket && r.bucket !== ctx.bucket) continue;
    const fieldValue = String(resolveRateField_(ctx, r.matchField));
    if (matchesRule_(fieldValue, r.matchType, r.matchValue)) return r;
  }
  return null;
}

function resolveRateField_(ctx, field) {
  const map = {
    account: ctx.accountName,
    payee: ctx.payee,
    memo: ctx.memo,
    category: ctx.category,
    category_group: ctx.categoryGroup,
    category_group_category: ctx.cgc,
    route_bucket: ctx.bucket
  };
  return map[field] || '';
}

function matchesRule_(value, type, target) {
  const v = String(value || '');
  if (type === 'exact') return v.toLowerCase() === target.toLowerCase();
  if (type === 'regex') {
    try {
      return new RegExp(target, 'i').test(v);
    } catch (e) {
      return false;
    }
  }
  return v.toLowerCase().includes(target.toLowerCase());
}

function readOverrides_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.overrides);
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return {};
  const h = mapHeaderIndexes_(values[0]);
  const out = {};
  values.slice(1).forEach((r) => {
    const txnId = String(r[h.txn_id] || '').trim();
    if (!txnId) return;
    const rate = toNumber_(r[h.override_rate]);
    if (rate > 0) out[txnId] = rate > 1 ? rate / 100 : rate;
  });
  return out;
}

function readAccountMap_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.ynabAccounts);
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return {};
  const h = mapHeaderIndexes_(values[0]);
  const out = {};
  values.slice(1).forEach((r) => {
    const id = String(r[h.account_id] || '').trim();
    if (!id) return;
    out[id] = {
      id,
      name: r[h.account_name],
      type: r[h.account_type]
    };
  });
  return out;
}

function writeAccounts_(accountMap) {
  const rows = Object.values(accountMap)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((a) => [a.id, a.name, a.type, a.on_budget, a.closed, a.note]);

  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.ynabAccounts);
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
  setViewFormula_(CFG.sheets.bankBonus, 'BANK_BONUS');
}

function setViewFormula_(sheetName, bucket) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
  const headers = [
    'date', 'account', 'payee', 'category_group', 'category', 'memo', 'outflow', 'inflow',
    'txn_id', 'effective_rate', 'cashback_amount', 'rate_source', 'cleared'
  ];

  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);

  const formula = `=IFERROR(QUERY(${CFG.sheets.ledger}!A1:R,` +
    `"select Col2,Col3,Col4,Col5,Col6,Col7,Col8,Col9,Col1,Col13,Col15,Col16,Col18 where Col10 = '${bucket}' order by Col2 desc",1),"")`;
  sheet.getRange(2, 1).setFormula(formula);
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
  sh.getRange('A8').setValue('Needs review');
  sh.getRange('B8').setFormula(`=COUNTIF('${L}'!H:H,"REVIEW")+COUNTIF('${L}'!M:M,"no csv row*")`);
  sh.getRange('C4:C7').setNumberFormat('$#,##0.00');
  sh.getRange('D4:D7').setNumberFormat('#,##0');
  sh.getRange('E4:E7').setNumberFormat('$#,##0.00');
  sh.getRange('F4:F7').setNumberFormat('0.00%');
  sh.getRange('A3:F3').setFontWeight('bold');
  sh.getRange('A7:F7').setFontWeight('bold');

  sh.getRange('A11:C11').setValues([['Sync Info', 'Value', 'Notes']]);
  sh.getRange('A12').setValue('Last API Sync (epoch ms)');
  sh.getRange('B12').setValue(PropertiesService.getDocumentProperties().getProperty('YNAB_LAST_SYNC_EPOCH_MS') || '');
  sh.getRange('A13').setValue('Server Knowledge');
  sh.getRange('B13').setValue(PropertiesService.getDocumentProperties().getProperty('YNAB_SERVER_KNOWLEDGE') || '');
  sh.getRange('A14').setValue('Sync Cooldown Minutes');
  sh.getRange('B14').setFormula(`=IFERROR(VLOOKUP("sync_min_minutes",FILTER(${CFG.sheets.config}!B:C,${CFG.sheets.config}!A:A="sync"),2,FALSE),20)`);

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

  const ledger = ss.getSheetByName(CFG.sheets.ledger);
  ledger.getRange(1, 1, 1, CFG.ledgerHeaders.length).setValues([CFG.ledgerHeaders]);
  ledger.setFrozenRows(1);

  const rates = ss.getSheetByName(CFG.sheets.rates);
  rates.getRange(1, 1, 1, CFG.rateHeaders.length).setValues([CFG.rateHeaders]);
  rates.setFrozenRows(1);

  const ov = ss.getSheetByName(CFG.sheets.overrides);
  ov.getRange(1, 1, 1, CFG.overrideHeaders.length).setValues([CFG.overrideHeaders]);
  ov.setFrozenRows(1);

  const seed = ss.getSheetByName(CFG.sheets.ynabSeed);
  seed.getRange(1, 1, 1, 11).setValues([CFG.mirrorHeaders.slice(0, 11)]);
  seed.setFrozenRows(1);
}

function seedConfigSheet_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.config);
  if (sh.getLastRow() > 0) return;
  sh.getRange(1, 1, 1, 3).setValues([['section', 'key', 'value']]);
  sh.getRange(2, 1, 13, 3).setValues([
    ['tracked_account_match', '1', 'TKB'],
    ['tracked_account_match', '2', 'TKP'],
    ['tracked_account_match', '3', 'MOLI'],
    ['tracked_account_match', '4', 'CURR'],
    ['tracked_account_match', '5', 'Coinbase'],
    ['tracked_account_match', '6', 'Lemfi'],
    ['tracked_account_match', '7', 'PP'],
    ['tracked_account_match', '8', 'BLUPE'],
    ['tracked_account_match', '9', 'FLUZ'],
    ['sync', 'sync_min_minutes', '20'],
    ['sync', 'full_refresh_day_of_week', '7'],
    ['cashback', 'default_rate_ms', '0'],
    ['cashback', 'default_rate_ms_crypto', '0'],
    ['cashback', 'default_rate_bill_pay', '0'],
    ['cashback', 'default_rate_bank_bonus', '0']
  ]);
  sh.setFrozenRows(1);
}

function seedRatesSheet_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.rates);
  if (sh.getLastRow() > 1) return;
  sh.getRange(2, 1, 5, CFG.rateHeaders.length).setValues([
    ['TRUE', 'MS_CRYPTO', 'payee', 'contains', 'Coinbase', 0, 'rule', 'Set your typical Coinbase rate here'],
    ['TRUE', 'MS_CRYPTO', 'payee', 'contains', 'Robinhood', 0, 'rule', 'Set your typical Robinhood rate here'],
    ['TRUE', 'MS', 'account', 'contains', 'BLUPE', 0, 'rule', 'BLUPE often uses variable effective rates'],
    ['TRUE', 'MS', 'account', 'contains', 'FLUZ', 0, 'rule', 'FLUZ rates can vary by merchant/category'],
    ['TRUE', 'BILL_PAY', 'category_group', 'contains', 'Bills', 0, 'rule', 'Optional bill-pay default']
  ]);
}

function seedOverrideSheet_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.overrides);
  if (sh.getLastRow() > 1) return;
  sh.getRange(2, 1, 1, CFG.overrideHeaders.length).setValues([
    ['example_txn_id', 0.015, 'manual', 'Delete this sample row after setup']
  ]);
}

function seedRawHelperSheets_() {
  seedHeaderIfEmpty_(CFG.sheets.taekusRaw, ['txn_id', 'Date', 'Type', 'Description', 'Status', 'Amount (USD)', 'Points', 'effective_rate', 'rate']);
  seedHeaderIfEmpty_(CFG.sheets.bluepeRaw, ['txn_id', 'Event ID', 'Type', 'DateTime', 'Amount', 'Interchange', 'Effective rate', 'Description', 'Category', 'effective_rate']);
  seedHeaderIfEmpty_(CFG.sheets.fluzRaw, ['txn_id', 'Transaction ID', 'Type', 'Amount', 'Cashback', 'Cashback Rate', 'Description', 'Category', 'Created At', 'effective_rate']);
  seedHeaderIfEmpty_(CFG.sheets.altRaw, ['txn_id', 'date', 'description', 'merchant', 'points credited', 'transaction amount', 'effective_rate', 'rate']);
}

function seedHeaderIfEmpty_(sheetName, headers) {
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  if (sh.getLastRow() > 0) return;
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  sh.setFrozenRows(1);
}

function readTrackedMatchers_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.config);
  const values = sh.getDataRange().getValues();
  const out = [];
  values.slice(1).forEach((r) => {
    if (String(r[0]).trim() === 'tracked_account_match' && String(r[2]).trim()) {
      out.push(normalizeCanonicalAccountName_(String(r[2]).trim()).toLowerCase());
    }
  });
  return out;
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

function inferProviderHint_(accountName, payee, memo) {
  const normalizedAccount = normalizeCanonicalAccountName_(accountName || '');
  const t = `${normalizedAccount} ${payee || ''} ${memo || ''}`.toLowerCase();
  if (t.includes('fluz')) return 'FLUZ';
  if (t.includes('blupe') || t.includes('blue penguin')) return 'BLUPE';
  if (t.includes('taekus')) return 'TAEKUS';
  if (t.includes('tkb') || t.includes('tkp')) return 'TKB/TKP';
  return '';
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

function normalizeCanonicalAccountName_(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const upper = s.toUpperCase();
  if (upper.includes('COINBASE')) return 'Coinbase';
  if (upper.includes('LEMFI')) return 'Lemfi';
  if (upper.includes('CURRENT') || upper.includes('CURR')) return 'CURR';
  if (upper.includes('TKB')) return 'TKB';
  if (upper.includes('TKP')) return 'TKP';
  if (upper.includes('MOLI')) return 'MOLI';
  if (upper.includes('PPBZ') || upper.includes('PP')) return 'PP';
  if (upper.includes('TAEKUS')) return 'TAEKUS';
  if (upper.includes('BLUPE')) return 'BLUPE';
  if (upper.includes('FLUZ')) return 'FLUZ';
  return s;
}

function matchesAny_(value, matchers) {
  const v = normalizeCanonicalAccountName_(value).toLowerCase();
  return matchers.some((m) => v.includes(String(m || '').trim().toLowerCase()));
}

function ensureSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function getScriptProperty_(key) {
  const val = PropertiesService.getScriptProperties().getProperty(key);
  if (!val) throw new Error(`Missing script property: ${key}`);
  return val;
}
