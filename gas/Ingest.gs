/**
 * Web-app endpoint the "MS-CHRN Sync" Chrome extension posts to (extension/ in the repo).
 *
 * The extension reads transactions from sites Chris is signed in to (Taekus first) and POSTs
 * them here as JSON: { key, site, accounts: [...] }. key must equal the INGEST_KEY script
 * property. Each site handler turns the rows into that site's own export format and keeps one
 * file per account in the site's Drive folder, so the existing CSV imports (workbook and YNAB)
 * pick them up unchanged and merge them with any hand-downloaded exports.
 *
 * Deploy: Apps Script > Deploy > New deployment > Web app, execute as me, access "Anyone";
 * paste the /exec URL and the INGEST_KEY into the extension's options.
 */

const INGEST = {
  taekus: {
    filePrefix: 'taekus-api-', // + last4 + '.csv' (the importers take the account from the name)
    // Same columns, in the same order, as Taekus's ALT debit CSV export.
    headers: ['date', 'card nickname', 'first name', 'last name', 'description', 'merchant', 'mcc code',
      'original currency', 'posted date', 'refund', 'settled', 'points credited', 'original currency amount',
      'transaction amount', 'card last 4', 'transaction uuid', 'transaction MID'],
    balanceSheet: 'Taekus_Balances'
  }
};

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return ingestJson_({ ok: false, error: 'bad json' }); }
  const want = PropertiesService.getScriptProperties().getProperty('INGEST_KEY');
  if (!want || body.key !== want) return ingestJson_({ ok: false, error: 'bad key' });
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (body.site === 'taekus') return ingestJson_(Object.assign({ ok: true }, ingestTaekus_(body)));
    return ingestJson_({ ok: false, error: 'unknown site ' + body.site });
  } catch (err) {
    return ingestJson_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function ingestJson_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * accounts: [{ last4, name, available_balance, start, end, transactions: [{ token, ts, amount,
 * settled, state, description, merchant, mcc, points, refund }] }]. Rows in the account's file
 * dated inside [start, end] that are missing from this pull (declined or dropped pending
 * charges) are removed; everything else is kept, so the file grows into a full history.
 */
function ingestTaekus_(body) {
  const cfg = INGEST.taekus;
  const folders = DriveApp.getFoldersByName(XFER_CFG.taekusFolder);
  if (!folders.hasNext()) throw new Error('Drive folder not found: ' + XFER_CFG.taekusFolder);
  const folder = folders.next();
  const H = cfg.headers;
  const col = {};
  H.forEach((h, i) => { col[h] = i; });
  const result = { accounts: [] };
  const balances = [];

  (body.accounts || []).forEach((a) => {
    const last4 = String(a.last4 || '').replace(/\D/g, '');
    if (!/^\d{4}$/.test(last4)) return;
    const name = cfg.filePrefix + last4 + '.csv';
    const it = folder.getFilesByName(name);
    const file = it.hasNext() ? it.next() : null;
    const byToken = {};
    if (file) {
      readCsvText_(file.getBlob().getDataAsString()).forEach((r) => {
        byToken[r['transaction uuid']] = H.map((h) => r[h] === undefined ? '' : r[h]);
      });
    }
    const start = String(a.start || '').slice(0, 10);
    const end = String(a.end || '').slice(0, 10);
    const fresh = {};
    (a.transactions || []).forEach((t) => {
      if (!t.token || !t.ts) return;
      const d = new Date(t.ts);
      if (isNaN(d)) return;
      const row = new Array(H.length).fill('');
      row[col.date] = Utilities.formatDate(d, 'UTC', 'MM/dd/yyyy HH:mm') + ' UTC';
      row[col.description] = t.description || '';
      row[col.merchant] = t.merchant || '';
      row[col['mcc code']] = t.mcc || '';
      row[col['original currency']] = '840';
      row[col.refund] = t.refund ? 'True' : 'False';
      row[col.settled] = t.settled ? 'True' : 'False';
      row[col['points credited']] = String(Math.round(Number(t.points) || 0));
      row[col['original currency amount']] = String(Number(t.amount));
      row[col['transaction amount']] = String(Number(t.amount));
      row[col['transaction uuid']] = t.token;
      fresh[t.token] = row;
    });
    let dropped = 0;
    Object.keys(byToken).forEach((tok) => {
      if (fresh[tok]) return;
      const iso = altIso_(byToken[tok][col.date]);
      if (start && end && iso && iso >= start && iso <= end) { delete byToken[tok]; dropped += 1; }
    });
    Object.assign(byToken, fresh);
    const rows = Object.values(byToken).sort((x, y) => {
      const dx = altSortKey_(x[col.date]);
      const dy = altSortKey_(y[col.date]);
      return dx < dy ? 1 : dx > dy ? -1 : 0;
    });
    const csv = [H].concat(rows).map((r) => r.map((c) => {
      const s = String(c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n') + '\n';
    if (!file) folder.createFile(name, csv, MimeType.CSV);
    else if (file.getBlob().getDataAsString() !== csv) file.setContent(csv);
    result.accounts.push({ last4: last4, rows: rows.length, received: Object.keys(fresh).length, dropped: dropped });
    if (a.available_balance !== undefined && a.available_balance !== null) {
      balances.push([last4, a.name || '', Number(a.available_balance), new Date()]);
    }
  });

  if (balances.length) {
    const sh = ensureSheet_(SpreadsheetApp.getActive(), cfg.balanceSheet);
    sh.clearContents();
    sh.getRange(1, 1, 1, 4).setValues([['account_last4', 'name', 'available_balance', 'as_of']]);
    sh.getRange(2, 1, balances.length, 4).setValues(balances);
    sh.getRange(2, 3, balances.length, 1).setNumberFormat('$#,##0.00');
  }
  return result;
}

/** "10/21/2026 13:59 UTC" -> "2026-10-21 13:59" for sorting. */
function altSortKey_(s) {
  const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2})?/);
  return m ? m[3] + '-' + m[1] + '-' + m[2] + ' ' + (m[4] || '') : '';
}
