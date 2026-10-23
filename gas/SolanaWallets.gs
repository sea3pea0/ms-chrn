/**
 * Solana wallets that on-ramp purchases (MoonPay etc.) deliver to. The difference between what a
 * purchase cost (the YNAB outflow) and the dollar stablecoin that arrived is the on-ramp's fee,
 * which the ledger subtracts from that purchase's cash back.
 *
 * refreshSolanaDeposits() reads each wallet's token accounts through the public Solana RPC (no
 * key), and appends every new incoming stablecoin transfer to the Solana_Deposits sheet.
 */

const SOL_CFG = {
  sheet: 'Solana_Deposits',
  headers: ['date', 'time_utc', 'wallet', 'amount_usd', 'mint', 'sender', 'signature'],
  rpc: 'https://api.mainnet-beta.solana.com',
  wallets: ['GUDLWMBi1uH1vMwi3MMgmLEr8WwHWmvfy3tdeQzVQ4Dh', '2RE25szgdsh9Hryk8bjaj621EKsEsmnh29E9J4LAGzut'],
  // Dollar stablecoins counted at $1: USDC and the token MoonPay delivers ($450 -> 447.75).
  usdMints: {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
    xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y: 'xoUSD'
  },
  tokenPrograms: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']
};

function refreshSolanaDeposits() {
  const ss = SpreadsheetApp.getActive();
  const sh = ensureSheet_(ss, SOL_CFG.sheet);
  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, SOL_CFG.headers.length).setValues([SOL_CFG.headers]);
    sh.setFrozenRows(1);
  }
  const seen = new Set(sh.getLastRow() > 1
    ? sh.getRange(2, 7, sh.getLastRow() - 1, 1).getValues().map((r) => String(r[0])) : []);
  const props = PropertiesService.getDocumentProperties();
  const tz = ss.getSpreadsheetTimeZone();
  const rows = [];

  SOL_CFG.wallets.forEach((w) => {
    SOL_CFG.tokenPrograms.forEach((prog) => {
      const accts = solRpc_('getTokenAccountsByOwner', [w, { programId: prog }, { encoding: 'jsonParsed' }]).value || [];
      accts.forEach((a) => {
        const mint = a.account.data.parsed.info.mint;
        if (!SOL_CFG.usdMints[mint]) return;
        // Newest signature already read for this token account; only newer ones are fetched.
        const key = 'SOL_LAST_' + a.pubkey;
        const until = props.getProperty(key);
        const params = { limit: 1000 };
        if (until) params.until = until;
        const sigs = solRpc_('getSignaturesForAddress', [a.pubkey, params]) || [];
        if (!sigs.length) return;
        sigs.forEach((s) => {
          if (s.err || seen.has(s.signature)) return;
          const t = solRpc_('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
          if (!t || !t.meta) return;
          let d = 0;
          (t.meta.postTokenBalances || []).forEach((b) => {
            if (b.owner === w && b.mint === mint) d += Number(b.uiTokenAmount.uiAmountString || 0);
          });
          (t.meta.preTokenBalances || []).forEach((b) => {
            if (b.owner === w && b.mint === mint) d -= Number(b.uiTokenAmount.uiAmountString || 0);
          });
          if (!(d > 0)) return; // only money arriving
          const when = new Date(t.blockTime * 1000);
          const signer = t.transaction.message.accountKeys[0];
          rows.push([
            Utilities.formatDate(when, tz, 'yyyy-MM-dd'), Utilities.formatDate(when, 'UTC', 'yyyy-MM-dd HH:mm'), w,
            Math.round(d * 1e6) / 1e6, SOL_CFG.usdMints[mint], signer.pubkey || signer, s.signature
          ]);
          seen.add(s.signature);
        });
        props.setProperty(key, sigs[0].signature);
      });
    });
  });

  if (rows.length) {
    const r0 = sh.getLastRow() + 1;
    sh.getRange(r0, 1, rows.length, 2).setNumberFormat('@');
    sh.getRange(r0, 1, rows.length, SOL_CFG.headers.length).setValues(rows);
  }
  if (sh.getLastRow() > 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, SOL_CFG.headers.length).sort({ column: 2, ascending: false }); // newest on top
  }
  return rows.length;
}

function solRpc_(method, params) {
  for (let i = 0; i < 5; i += 1) {
    const r = UrlFetchApp.fetch(SOL_CFG.rpc, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params })
    });
    if (r.getResponseCode() < 300) {
      const j = JSON.parse(r.getContentText());
      if (!j.error) return j.result;
    }
    Utilities.sleep(1500 * (i + 1)); // public RPC rate limit
  }
  throw new Error('Solana RPC ' + method + ' failed');
}

/** Solana_Deposits rows as objects for the ledger. */
function solanaDepositRows_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SOL_CFG.sheet);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, SOL_CFG.headers.length).getValues()
    .map((r) => ({ date: cellIso_(r[0]), time: String(r[1]), wallet: String(r[2]), amount: toNumber_(r[3]), sig: String(r[6]) }));
}
