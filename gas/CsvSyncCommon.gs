/**
 * Shared pieces for the Drive-CSV -> YNAB syncs (FluzSync.gs, BlupeSync.gs).
 * Port of scripts/ynab_common.py. Needs script properties YNAB_TOKEN and
 * YNAB_BUDGET_ID (shared with Code.gs).
 *
 * Triggers: run installCsvSyncTriggers() once (Fluz hourly ~:17, Blue Penguin
 * hourly ~:47). removeCsvSyncTriggers() takes them out again.
 */

const CSV_SYNC_YNAB_BASE = 'https://api.ynab.com/v1';
const CSV_SYNC_TRIGGERS = [
  { fn: 'fluzSyncApply', minute: 17 },
  { fn: 'blupeSyncApply', minute: 47 }
];

function installCsvSyncTriggers() {
  removeCsvSyncTriggers();
  CSV_SYNC_TRIGGERS.forEach((t) => {
    ScriptApp.newTrigger(t.fn).timeBased().everyHours(1).nearMinute(t.minute).create();
  });
  console.log('Installed triggers: ' + CSV_SYNC_TRIGGERS.map((t) => t.fn).join(', '));
}

function removeCsvSyncTriggers() {
  const fns = new Set(CSV_SYNC_TRIGGERS.map((t) => t.fn));
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (fns.has(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  });
}

/** Run fn under the script lock so a slow run never overlaps the next one. */
function csvSyncLocked_(name, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) {
    console.warn(name + ': another sync holds the lock; skipping this run.');
    return null;
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- numbers

/** Python's round(): half to even. */
function pyRound_(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

function milli_(s) {
  const v = String(s == null ? '' : s).replace(/\$/g, '').replace(/,/g, '').trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) return 0;
  return pyRound_(parseFloat(v) * 1000);
}

/** Round milliunits to whole cents (YNAB shows cents). */
function cents_(m) {
  return pyRound_(m / 10.0) * 10;
}

function fmtMilli_(m) {
  const s = (Math.abs(m) / 1000).toFixed(2).split('.');
  return (m < 0 ? '-' : '') + s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + s[1];
}

/** First n code points (Python slicing semantics). */
function cut_(s, n) {
  return Array.from(String(s)).slice(0, n).join('');
}

// ---------------------------------------------------------------- dates (ISO yyyy-mm-dd strings)

function isoDays_(iso) {
  const p = iso.split('-').map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2]) / 86400000;
}

function isoAddDays_(iso, n) {
  return new Date((isoDays_(iso) + n) * 86400000).toISOString().slice(0, 10);
}

function isoValid_(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  return new Date(isoDays_(iso) * 86400000).toISOString().slice(0, 10) === iso;
}

// ---------------------------------------------------------------- CSV

/** RFC 4180 CSV -> array of objects keyed by the header row (like csv.DictReader). */
function readCsvText_(text) {
  text = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQ = false, i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQ = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      i += (c === '\r' && text[i + 1] === '\n') ? 2 : 1;
      continue;
    }
    field += c; i += 1;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const data = rows.filter((r) => !(r.length === 1 && r[0] === '') && r.length);
  if (!data.length) return [];
  const header = data[0];
  return data.slice(1).map((r) => {
    const o = {};
    header.forEach((h, j) => { o[h] = j < r.length ? r[j] : ''; });
    return o;
  });
}

/** [{name, text}] of every CSV in the named Drive folder, oldest modified first. */
function driveCsvs_(folderName) {
  const it = DriveApp.getFoldersByName(folderName);
  if (!it.hasNext()) throw new Error('Drive folder "' + folderName + '" not found.');
  const folder = it.next();
  const files = [];
  const fit = folder.getFiles();
  while (fit.hasNext()) {
    const f = fit.next();
    if (f.isTrashed()) continue;
    if (!f.getName().toLowerCase().endsWith('.csv') && f.getMimeType() !== 'text/csv') continue;
    files.push(f);
  }
  files.sort((a, b) => a.getLastUpdated().getTime() - b.getLastUpdated().getTime());
  return files.map((f) => ({ name: f.getName(), text: f.getBlob().getDataAsString('UTF-8') }));
}

// ---------------------------------------------------------------- YNAB

function csvSyncYnab_() {
  const token = getScriptProperty_('YNAB_TOKEN');
  const base = CSV_SYNC_YNAB_BASE + '/budgets/' + getScriptProperty_('YNAB_BUDGET_ID');
  const headers = { Authorization: 'Bearer ' + token };

  function call(method, path, body) {
    const opts = { method: method, headers: headers, muteHttpExceptions: true };
    if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
    for (let attempt = 1; ; attempt += 1) {
      const r = UrlFetchApp.fetch(base + path, opts);
      const code = r.getResponseCode();
      if ((code === 429 || code >= 500) && attempt < 4 && method === 'get') {
        Utilities.sleep(attempt * 2000);
        continue;
      }
      return { code: code, text: r.getContentText() };
    }
  }

  return {
    get: function (path) {
      const r = call('get', path);
      if (r.code >= 300) throw new Error('YNAB GET ' + path + ' failed ' + r.code + ': ' + r.text);
      return JSON.parse(r.text).data;
    },
    // This budget rejects bulk creates with 403.4 data_limit_reached, so post one at a time.
    postTransactions: function (txns) {
      const created = [], dupes = [];
      txns.forEach((t) => {
        const r = call('post', '/transactions', { transaction: t });
        if (r.code === 409) { dupes.push(t.import_id); return; }
        if (r.code >= 300) {
          throw new Error('YNAB create failed ' + r.code + ' after ' + created.length + ' created: ' + r.text);
        }
        created.push(JSON.parse(r.text).data.transaction.id);
      });
      return { transaction_ids: created, duplicate_import_ids: dupes };
    },
    patchTransactions: function (txns) {
      txns.forEach((t) => {
        const id = t.id;
        const body = Object.assign({}, t);
        delete body.id;
        const r = call('put', '/transactions/' + id, { transaction: body });
        if (r.code >= 300) throw new Error('YNAB update failed ' + r.code + ': ' + r.text);
      });
    }
  };
}
