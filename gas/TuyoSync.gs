/**
 * Sync TUYO loads and MMCA sends into the YNAB TUYO accounts from the Base chain (USDC logs).
 *
 * TUYO wallets are ZeroDev smart wallets on Base. Per run and wallet:
 *   - reads USDC Transfer logs to/from the wallet through a public Base RPC (eth_getLogs);
 *   - a load (USDC in from the TUYO on-ramp) is the TKB "Add cash" charge: an existing TUYO inflow
 *     of the same amount (within matchDays) counts as booked; else the TKB charge (payee/category
 *     /tuyo/) is turned into a transfer to TUYO; with no charge after loadWaitDays it is booked
 *     as a transfer from the funding account;
 *   - a send to the owner's MetaMask card wallet (MMCA) is payee "USDC Transfer", category
 *     Transfer: USDC (Chris's rule), unless a matching outflow is already there;
 *   - everything else (card collateral contract, Aave vault) moves money inside TUYO and is skipped.
 * Card spends and cash back settle off-chain, so they still come from the connector / by hand.
 *
 * Lines are created unapproved; memo "TUYO <tx hash prefix>" marks what the sync booked.
 * Entry points: tuyoSyncDryRun() (log only), tuyoSyncApply() (hourly trigger ~:52).
 */

const TUYO_SYNC = {
  rpc: 'https://base-rpc.publicnode.com',
  usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  transferTopic: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  onramps: [], // full addresses filled in below (TUYO on-ramp EOA)
  wallets: [
    { wallet: '0xdaaf40e1155b02d5aae5af1a1f1d943e47df2ebf', account: 'TUYO - 4382 - P2',
      funding: 'TKB - 5427 - P2', mmca: '0x71648abb5dbdc13290de3d50ef11578869fdd046' },
    { wallet: '0x5bd65c5c90fca5c5185bad6953bb71e77aec1fe8', account: 'TUYO - 7734 - P1',
      funding: 'TKP - 7840 - P1', mmca: '0x794dfcd10c0f29769c31e1913a05f6667d5da788' }
  ],
  syncStart: '2026-10-20',
  blockSeconds: 2,
  maxRange: 50000,
  matchDays: 3,
  loadWaitDays: 4,
  fundingChargeRx: /tuyo/i,
  categories: { usdc: 'Transfer: USDC' },
  memoKey: (hash) => 'TUYO ' + hash.slice(0, 14)
};

function tuyoSyncDryRun() {
  return tuyoSync_(false);
}

function tuyoSyncApply() {
  return csvSyncLocked_('tuyoSync', () => tuyoSync_(true));
}

function baseRpc_(method, params, tries) {
  for (let i = 0; i < (tries || 4); i += 1) {
    const r = UrlFetchApp.fetch(TUYO_SYNC.rpc, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params })
    });
    if (r.getResponseCode() < 300) {
      const j = JSON.parse(r.getContentText());
      if (!j.error) return j.result;
    }
    Utilities.sleep(1500 * (i + 1));
  }
  throw new Error('Base RPC ' + method + ' failed');
}

const tuyoPad_ = (a) => '0x' + '0'.repeat(24) + a.toLowerCase().replace(/^0x/, '');
const tuyoAddr_ = (topic) => '0x' + topic.slice(-40).toLowerCase();

/**
 * USDC moves in/out of the wallet in blocks startBlock..latest: [{hash, iso, time, amount (milli), dir, cp}].
 * Ranges shrink when the RPC refuses a span as too large.
 */
function tuyoMoves_(wallet, startBlock, latest) {
  const C = TUYO_SYNC;
  const logs = [];
  let span = C.maxRange;
  for (let from = startBlock; from <= latest;) {
    const to = Math.min(latest, from + span - 1);
    const range = { fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), address: C.usdc };
    let got;
    try {
      got = [[C.transferTopic, tuyoPad_(wallet)], [C.transferTopic, null, tuyoPad_(wallet)]]
        .map((topics) => baseRpc_('eth_getLogs', [Object.assign({ topics: topics }, range)], 2) || []);
    } catch (e) {
      if (span <= 500) throw e;
      span = Math.floor(span / 4);
      continue;
    }
    got.forEach((ls) => ls.forEach((l) => logs.push(l)));
    from = to + 1;
  }
  const times = {};
  return logs.map((l) => {
    const src = tuyoAddr_(l.topics[1]), dst = tuyoAddr_(l.topics[2]);
    const out = src === wallet.toLowerCase();
    if (!times[l.blockNumber]) times[l.blockNumber] = parseInt(baseRpc_('eth_getBlockByNumber', [l.blockNumber, false]).timestamp, 16);
    const when = new Date(times[l.blockNumber] * 1000);
    const micro = parseInt(l.data, 16); // USDC has 6 decimals
    return {
      hash: l.transactionHash, dir: out ? -1 : 1, cp: out ? dst : src,
      amount: (out ? -1 : 1) * cents_(Math.round(micro / 1000)),
      iso: Utilities.formatDate(when, 'America/New_York', 'yyyy-MM-dd'),
      time: Utilities.formatDate(when, 'UTC', 'yyyy-MM-dd HH:mm') + ' UTC'
    };
  });
}

function tuyoSync_(apply) {
  const C = TUYO_SYNC;
  const y = csvSyncYnab_();
  const accounts = y.get('/accounts').accounts.filter((a) => !a.deleted && !a.closed);
  let usdcCat = null;
  y.get('/categories').category_groups.forEach((g) => g.categories.forEach((c) => {
    if (!c.deleted && (c.name === C.categories.usdc || g.name + ': ' + c.name === C.categories.usdc)) usdcCat = c.id;
  }));
  const onramps = new Set(C.onramps.map((a) => a.toLowerCase()));
  const latest = parseInt(baseRpc_('eth_blockNumber', []), 16);
  const today = Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd');
  const since = isoAddDays_(C.syncStart, -C.matchDays);
  const out = [];
  let made = 0;

  C.wallets.forEach((w) => {
    const acct = accounts.find((a) => a.name.trim() === w.account);
    const fund = accounts.find((a) => a.name.trim() === w.funding);
    if (!acct || !fund) { out.push(w.account + ': YNAB account ' + (acct ? w.funding : w.account) + ' not found'); return; }
    const txns = y.get('/accounts/' + acct.id + '/transactions?since_date=' + since).transactions.filter((t) => !t.deleted);
    const fundTxns = y.get('/accounts/' + fund.id + '/transactions?since_date=' + since).transactions.filter((t) => !t.deleted);
    const memos = txns.concat(fundTxns).map((t) => t.memo || '').join('\n');
    const used = new Set();
    const near = (t, m) => !used.has(t.id) && Math.abs(t.amount - m.amount) <= 10 &&
      Math.abs(isoDays_(t.date) - isoDays_(m.iso)) <= C.matchDays;

    const plan = [];
    // Scan only new blocks; loads still waiting for their bank charge are carried in pending.
    const props = PropertiesService.getScriptProperties();
    const curKey = 'TUYO_BLOCK_' + w.wallet, pendKey = 'TUYO_PENDING_' + w.wallet;
    const cursor = Number(props.getProperty(curKey) || 0);
    const nowSec = Math.floor(Date.now() / 1000);
    const startBlock = cursor ? cursor + 1 :
      Math.max(0, latest - Math.ceil((nowSec - isoDays_(C.syncStart) * 86400) / C.blockSeconds) - 2000);
    const pending = JSON.parse(props.getProperty(pendKey) || '[]');
    const fresh = tuyoMoves_(w.wallet, startBlock, latest);
    const moves = pending.concat(fresh.filter((m) => !pending.some((p) => p.hash === m.hash && p.amount === m.amount)));
    const waiting = [];
    moves.sort((a, b) => (a.time < b.time ? -1 : 1)).forEach((m) => {
      const key = C.memoKey(m.hash);
      if (memos.indexOf(key) >= 0) return;
      const load = m.dir > 0 && onramps.has(m.cp);
      const send = m.dir < 0 && m.cp === w.mmca.toLowerCase();
      if (!load && !send) return; // collateral / vault: money moving inside TUYO
      const have = txns.find((t) => near(t, m));
      if (have) { used.add(have.id); return; } // already in YNAB (bank feed, connector or by hand)
      if (send) {
        plan.push({ kind: 'send', m: m, key: key });
        return;
      }
      const charge = fundTxns.find((t) => !t.transfer_account_id && C.fundingChargeRx.test([t.payee_name, t.category_name].join(' ')) &&
        !used.has(t.id) && Math.abs(-t.amount - m.amount) <= 10 && Math.abs(isoDays_(t.date) - isoDays_(m.iso)) <= C.matchDays);
      if (charge) { used.add(charge.id); plan.push({ kind: 'convert', m: m, key: key, charge: charge }); return; }
      if (isoDays_(today) - isoDays_(m.iso) >= C.loadWaitDays) plan.push({ kind: 'load', m: m, key: key });
      else { waiting.push(m); out.push('  waiting for the ' + w.funding + ' charge: load ' + m.iso + ' ' + fmtMilli_(m.amount)); }
    });

    out.push(w.account + ': blocks ' + startBlock + '-' + latest + ', ' + fresh.length + ' new USDC moves, ' + plan.length + ' to book');
    plan.forEach((p) => out.push('  ' + p.kind.padEnd(8) + p.m.iso + ' ' + fmtMilli_(p.m.amount).padStart(10) + '  ' + p.m.hash));
    if (!apply) return;
    plan.forEach((p) => {
      const memo = p.key + ' - ' + p.m.time;
      if (p.kind === 'send') {
        y.postTransactions([{ account_id: acct.id, date: p.m.iso, amount: p.m.amount, payee_name: 'USDC Transfer',
          category_id: usdcCat, memo: memo + ' - to MMCA', cleared: 'cleared', approved: false }]);
      } else if (p.kind === 'convert') {
        y.patchTransactions([{ id: p.charge.id, payee_id: acct.transfer_payee_id, category_id: null,
          memo: cut_([p.charge.memo, 'TUYO load ' + memo].filter((x) => x).join(' | '), 200) }]);
      } else {
        y.postTransactions([{ account_id: acct.id, date: p.m.iso, amount: p.m.amount, payee_id: fund.transfer_payee_id,
          memo: memo + ' - load', cleared: 'cleared', approved: false }]);
      }
      made += 1;
    });
    props.setProperty(curKey, String(latest));
    props.setProperty(pendKey, JSON.stringify(waiting));
  });
  if (apply) out.push('Booked ' + made);
  console.log(out.join('\n'));
  return { booked: made, log: out.join('\n') };
}
