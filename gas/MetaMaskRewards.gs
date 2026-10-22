/**
 * MetaMask Card cash back, read from the blockchain: the rewards are mUSD transfers on Linea from
 * MetaMask's rewards address to the user's wallets. No API key; the public Linea RPC is used.
 *
 * refreshMetaMaskRewards() runs about once a week (the card is rarely used now): it scans the blocks
 * since the last run (eth_getLogs, 10,000 blocks per request) and appends each reward to the
 * MetaMask_Rewards sheet. The ledger treats the MMCA
 * accounts as a deposit-allocated source (key METAMASK, see XFER_CFG.depositSources): each
 * month's rewards for a wallet are spread over that month's outflows from its YNAB account.
 */

const MM_CFG = {
  sheet: 'MetaMask_Rewards',
  headers: ['date', 'account', 'wallet', 'amount_musd', 'block', 'tx_hash'],
  rpc: 'https://rpc.linea.build',
  token: '0xaca92e438df0b2401ff60da7e4337b687a2435da', // mUSD on Linea (6 decimals)
  decimals: 6,
  source: '0x984c916d8437e4b8bba8f1d98b6336d7a36bc3a6', // MetaMask rewards sender
  // Wallet -> YNAB account it pays for (matched by daily reward ≈ 1% of that account's spend).
  wallets: {
    '0x794dfcd10c0f29769c31e1913a05f6667d5da788': 'MMCA',
    '0x71648abb5dbdc13290de3d50ef11578869fdd046': 'MMCA - P2'
  },
  startBlock: 30300000, // first reward is block 30,350,780 (2026-04-23)
  chunk: 10000, // RPC limit per eth_getLogs
  batch: 20, // parallel requests per fetchAll
  maxChunksPerRun: 400,
  propKey: 'METAMASK_LAST_BLOCK',
  lastRunKey: 'METAMASK_LAST_RUN_MS',
  refreshDays: 7,
  transferTopic: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
};

function refreshMetaMaskRewards(force) {
  const ss = SpreadsheetApp.getActive();
  const sh = ensureSheet_(ss, MM_CFG.sheet);
  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, MM_CFG.headers.length).setValues([MM_CFG.headers]);
    sh.setFrozenRows(1);
  }
  const props = PropertiesService.getDocumentProperties();
  // The card is rarely used now: rescan weekly (the hourly sync calls this; force skips the wait).
  const lastMs = Number(props.getProperty(MM_CFG.lastRunKey) || 0);
  if (force !== true && sh.getLastRow() > 1 && Date.now() - lastMs < MM_CFG.refreshDays * 86400000) return 0;
  // Empty sheet = start over from the first reward block.
  let from = sh.getLastRow() > 1 ? Number(props.getProperty(MM_CFG.propKey) || 0) + 1 : MM_CFG.startBlock;
  if (from < MM_CFG.startBlock) from = MM_CFG.startBlock;
  const latest = parseInt(mmRpc_([['eth_blockNumber', []]])[0], 16);
  if (from > latest) return 0;

  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
  const ranges = [];
  for (let b = from; b <= latest && ranges.length < MM_CFG.maxChunksPerRun; b += MM_CFG.chunk) {
    ranges.push([b, Math.min(b + MM_CFG.chunk - 1, latest)]);
  }
  const logs = [];
  for (let i = 0; i < ranges.length; i += MM_CFG.batch) {
    mmRpc_(ranges.slice(i, i + MM_CFG.batch).map((r) => ['eth_getLogs', [{
      fromBlock: '0x' + r[0].toString(16), toBlock: '0x' + r[1].toString(16), address: MM_CFG.token,
      topics: [MM_CFG.transferTopic, pad(MM_CFG.source), Object.keys(MM_CFG.wallets).map(pad)]
    }]])).forEach((res) => res.forEach((l) => logs.push(l)));
  }
  const scannedTo = ranges[ranges.length - 1][1];

  const seen = new Set(sh.getLastRow() > 1
    ? sh.getRange(2, 6, sh.getLastRow() - 1, 1).getValues().map((r) => String(r[0])) : []);
  const fresh = logs.filter((l) => !seen.has(l.transactionHash + ':' + parseInt(l.logIndex, 16)));
  const blocks = Array.from(new Set(fresh.map((l) => l.blockNumber)));
  const ts = {};
  if (blocks.length) {
    mmRpc_(blocks.map((b) => ['eth_getBlockByNumber', [b, false]])).forEach((blk, i) => {
      ts[blocks[i]] = new Date(parseInt(blk.timestamp, 16) * 1000);
    });
  }
  const tz = ss.getSpreadsheetTimeZone();
  const rows = fresh.map((l) => {
    const wallet = '0x' + l.topics[2].slice(-40).toLowerCase();
    // BigInt-free: mUSD amounts are far below 2^53 base units.
    const amount = parseInt(l.data, 16) / Math.pow(10, MM_CFG.decimals);
    return [Utilities.formatDate(ts[l.blockNumber], tz, 'yyyy-MM-dd'), MM_CFG.wallets[wallet] || '', wallet,
      Math.round(amount * 1e6) / 1e6, parseInt(l.blockNumber, 16), l.transactionHash + ':' + parseInt(l.logIndex, 16)];
  }).sort((a, b) => a[4] - b[4]);
  if (rows.length) {
    const r0 = sh.getLastRow() + 1;
    sh.getRange(r0, 1, rows.length, 1).setNumberFormat('@');
    sh.getRange(r0, 1, rows.length, MM_CFG.headers.length).setValues(rows);
    // Newest on top (by block).
    sh.getRange(2, 1, sh.getLastRow() - 1, MM_CFG.headers.length).sort({ column: 5, ascending: false });
  }
  props.setProperty(MM_CFG.propKey, String(scannedTo));
  if (scannedTo >= latest) props.setProperty(MM_CFG.lastRunKey, String(Date.now())); // else finish next run
  console.log('MetaMask_Rewards: +' + rows.length + ' (scanned to block ' + scannedTo + ' of ' + latest + ')');
  return rows.length;
}

/** JSON-RPC calls [[method, params], ...] in parallel; returns results in order. */
function mmRpc_(calls) {
  const reqs = calls.map((c, i) => ({
    url: MM_CFG.rpc, method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ jsonrpc: '2.0', id: i, method: c[0], params: c[1] })
  }));
  const res = UrlFetchApp.fetchAll(reqs);
  const out = new Array(calls.length);
  // Failed calls (rate limit, timeout) are retried one at a time with a short backoff.
  res.forEach((r, i) => {
    let body = r.getResponseCode() < 300 ? JSON.parse(r.getContentText()) : null;
    for (let t = 0; (!body || body.error) && t < 4; t += 1) {
      Utilities.sleep(1000 * (t + 1));
      const again = UrlFetchApp.fetch(reqs[i].url, reqs[i]);
      body = again.getResponseCode() < 300 ? JSON.parse(again.getContentText()) : null;
    }
    if (!body || body.error) {
      throw new Error('Linea RPC ' + calls[i][0] + ' failed: ' + JSON.stringify(body && body.error || r.getResponseCode()));
    }
    out[i] = body.result;
  });
  return out;
}

/** MetaMask_Rewards sheet rows as objects for the ledger. */
function metaMaskRewardRows_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(MM_CFG.sheet);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues()
    .map((r) => ({ date: cellIso_(r[0]), account: String(r[1]), amount: toNumber_(r[3]) }));
}
