/**
 * Coinbase One subscription payments made from Coinbase balances (mostly USDC), which YNAB never
 * sees, pulled from the Coinbase App API (v2) with a CDP API key.
 *
 * Setup: Apps Script > Project Settings > Script properties > add CDP_API_KEY with the whole
 * contents of the CDP key file ({"name": "organizations/...", "privateKey": "..."}, Ed25519).
 *
 * refreshCoinbaseFees() rewrites the Coinbase_Fees sheet with every `subscription` (fee) and
 * `subscription_rebate` (fee refund) transaction; the YNAB sync calls it about once a day.
 * The ledger turns those rows into CRYPTO_FEE rows (see TransferProfit.gs).
 */

const CB_CFG = {
  host: 'api.coinbase.com',
  sheet: 'Coinbase_Fees',
  headers: ['date', 'type', 'amount_usd', 'native_currency', 'amount', 'currency', 'account', 'id'],
  types: { subscription: true, subscription_rebate: true },
  refreshHours: 20,
  propKey: 'COINBASE_FEES_LAST_MS'
};

/** Refresh if the last pull is older than CB_CFG.refreshHours (or force). No key = no-op. */
function refreshCoinbaseFees(force) {
  const raw = PropertiesService.getScriptProperties().getProperty('CDP_API_KEY');
  if (!raw) { console.log('Coinbase fees: no CDP_API_KEY script property; skipped.'); return 0; }
  const props = PropertiesService.getDocumentProperties();
  const last = Number(props.getProperty(CB_CFG.propKey) || 0);
  const ss = SpreadsheetApp.getActive();
  const sh = ensureSheet_(ss, CB_CFG.sheet);
  if (force !== true && sh.getLastRow() > 1 && Date.now() - last < CB_CFG.refreshHours * 3600000) return 0;

  const key = JSON.parse(raw);
  const rows = [];
  cbAll_(key, '/v2/accounts?limit=100').forEach((a) => {
    cbAll_(key, '/v2/accounts/' + a.id + '/transactions?limit=100').forEach((t) => {
      if (!CB_CFG.types[t.type] || (t.status && t.status !== 'completed')) return;
      rows.push([
        String(t.created_at).slice(0, 10), t.type, Number(t.native_amount.amount), t.native_amount.currency,
        Number(t.amount.amount), t.amount.currency, a.name || '', t.id
      ]);
    });
  });
  rows.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));

  const w = CB_CFG.headers.length;
  sh.clearContents();
  sh.getRange(1, 1, 1, w).setValues([CB_CFG.headers]);
  sh.setFrozenRows(1);
  if (rows.length) {
    sh.getRange(2, 1, rows.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, rows.length, w).setValues(rows);
  }
  props.setProperty(CB_CFG.propKey, String(Date.now()));
  console.log('Coinbase_Fees: ' + rows.length + ' rows');
  return rows.length;
}

/** GET every page of a Coinbase v2 list endpoint. */
function cbAll_(key, path) {
  const out = [];
  let next = path;
  while (next) {
    const r = UrlFetchApp.fetch('https://' + CB_CFG.host + next, {
      headers: { Authorization: 'Bearer ' + cbJwt_(key, 'GET', next), 'CB-VERSION': '2024-01-01' },
      muteHttpExceptions: true
    });
    if (r.getResponseCode() >= 300) {
      throw new Error('Coinbase ' + next + ' failed ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300));
    }
    const j = JSON.parse(r.getContentText());
    (j.data || []).forEach((x) => out.push(x));
    next = j.pagination && j.pagination.next_uri;
  }
  return out;
}

/** CDP JWT (EdDSA) for one request: header kid/nonce, payload iss/sub/uri, 2-minute lifetime. */
function cbJwt_(key, method, path) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'EdDSA', kid: key.name, nonce: Utilities.getUuid().replace(/-/g, ''), typ: 'JWT' };
  const payload = { iss: 'cdp', nbf: now, exp: now + 120, sub: key.name, uri: method + ' ' + CB_CFG.host + path.split('?')[0] };
  const data = cbB64u_(Utilities.newBlob(JSON.stringify(header)).getBytes()) + '.' +
    cbB64u_(Utilities.newBlob(JSON.stringify(payload)).getBytes());
  const secret = Uint8Array.from(Utilities.base64Decode(key.privateKey), (b) => b & 255);
  const msg = Uint8Array.from(Utilities.newBlob(data).getBytes(), (b) => b & 255);
  const sig = NACL_.sign.detached(msg, secret);
  return data + '.' + cbB64u_(Array.from(sig, (b) => (b > 127 ? b - 256 : b)));
}

function cbB64u_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}
