/**
 * Coinbase One subscription payments made from Coinbase balances (mostly USDC), which YNAB never
 * sees, pulled from the Coinbase App API (v2) with a CDP API key.
 *
 * Setup: Apps Script > Project Settings > Script properties > add CDP_API_KEY (P1) and
 * CDP_API_KEY_P2 (P2) with the whole contents of each CDP key file
 * ({"name": "organizations/...", "privateKey": "..."}, Ed25519). Any CDP_API_KEY_<suffix> works.
 * Also writes Coinbase_Balances (each wallet's current USD value) for the MS-Crypto balance.
 *
 * refreshCoinbaseFees() rewrites the Coinbase_Fees sheet with every `subscription` (fee) and
 * `subscription_rebate` (fee refund) transaction; the YNAB sync calls it about once a day.
 * The ledger turns those rows into CRYPTO_FEE rows (see TransferProfit.gs).
 */

const CB_CFG = {
  host: 'api.coinbase.com',
  sheet: 'Coinbase_Fees',
  balanceSheet: 'Coinbase_Balances',
  headers: ['date', 'type', 'amount_usd', 'native_currency', 'amount', 'currency', 'account', 'id'],
  types: { subscription: true, subscription_rebate: true },
  refreshHours: 20,
  propKey: 'COINBASE_FEES_LAST_MS'
};

/** Refresh if the last pull is older than CB_CFG.refreshHours (or force). No key = no-op. */
function refreshCoinbaseFees(force) {
  const sp = PropertiesService.getScriptProperties().getProperties();
  const keys = Object.keys(sp).filter((k) => /^CDP_API_KEY(_.+)?$/.test(k)).sort()
    .map((k) => ({ label: k === 'CDP_API_KEY' ? 'P1' : k.replace('CDP_API_KEY_', ''), key: JSON.parse(sp[k]) }));
  if (!keys.length) { console.log('Coinbase fees: no CDP_API_KEY script property; skipped.'); return 0; }
  const props = PropertiesService.getDocumentProperties();
  const last = Number(props.getProperty(CB_CFG.propKey) || 0);
  const ss = SpreadsheetApp.getActive();
  const sh = ensureSheet_(ss, CB_CFG.sheet);
  // A new key (e.g. P2 added) triggers a pull right away instead of waiting for the daily one.
  const sig = keys.map((k) => k.label).join(',');
  if (force !== true && sh.getLastRow() > 1 && props.getProperty('COINBASE_KEYS') === sig &&
    Date.now() - last < CB_CFG.refreshHours * 3600000) return 0;

  const rows = [];
  const balances = [];
  const rates = cbUsdRates_();
  keys.forEach((k) => {
    cbAll_(k.key, '/v2/accounts?limit=100').forEach((a) => {
      const bal = Number(a.balance && a.balance.amount || 0);
      const cur = a.balance && a.balance.currency || (a.currency && a.currency.code) || '';
      if (bal > 0) {
        const rate = cur === 'USD' ? 1 : Number(rates[cur] || 0);
        balances.push([k.label, a.name || cur, cur, bal, rate ? Math.round(bal / rate * 100) / 100 : '']);
      }
      cbAll_(k.key, '/v2/accounts/' + a.id + '/transactions?limit=100').forEach((t) => {
        if (!CB_CFG.types[t.type] || (t.status && t.status !== 'completed')) return;
        rows.push([
          String(t.created_at).slice(0, 10), t.type, Number(t.native_amount.amount), t.native_amount.currency,
          Number(t.amount.amount), t.amount.currency, k.label + ' ' + (a.name || ''), t.id
        ]);
      });
    });
  });
  const bs = ensureSheet_(ss, CB_CFG.balanceSheet);
  bs.clearContents();
  bs.getRange(1, 1, 1, 6).setValues([['coinbase', 'wallet', 'currency', 'balance', 'usd_value', 'as_of']]);
  if (balances.length) {
    bs.getRange(2, 1, balances.length, 6).setValues(balances.map((b) => b.concat([new Date()])));
    bs.getRange(2, 5, balances.length, 1).setNumberFormat('$#,##0.00');
  }
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
  props.setProperty('COINBASE_KEYS', sig);
  console.log('Coinbase_Fees: ' + rows.length + ' rows');
  return rows.length;
}

/** Units of each currency per 1 USD (public endpoint, no key). */
function cbUsdRates_() {
  const r = UrlFetchApp.fetch('https://' + CB_CFG.host + '/v2/exchange-rates?currency=USD', { muteHttpExceptions: true });
  return r.getResponseCode() < 300 ? (JSON.parse(r.getContentText()).data || {}).rates || {} : {};
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
