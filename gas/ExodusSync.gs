/**
 * Sync Exodus wallets (Solana xoUSD / USDC) into their YNAB EXOD accounts, straight from the chain.
 *
 * Each run, per wallet in EXODUS_SYNC.wallets:
 *   1. lists the signatures of the wallet's dollar-stablecoin token accounts (the wallet address
 *      alone misses most of them) through the public Solana RPC;
 *   2. reads each signature not yet in YNAB (memo "XO <signature prefix>") and takes the wallet's
 *      own balance change, so Token-2022 fees are included and the YNAB balance follows the chain;
 *   3. books it:
 *        - from the MoonPay payout wallet:   payee MoonPay,       category Transfer: MoonPay
 *        - Exodus Pay card pull / refund:    payee = merchant,    uncategorized (review in YNAB)
 *        - any other outflow (Exodus sends
 *          xoUSD out as USDC via a swap):     payee USDC Transfer, category Transfer: USDC
 *        - any other inflow:                 payee Exodus Deposit, uncategorized
 *   4. creates the missing lines one at a time, unapproved and cleared.
 *
 * Card merchants are not on-chain. If the Drive folder "Exodus Transaction CSVs" holds Exodus
 * activity exports, CARD_PAYMENT rows give the merchant and card amount by on-chain id; a card
 * line created before its export arrived is renamed while it is still unapproved.
 *
 * Entry points: exodusSyncDryRun() (log only), exodusSyncApply() (hourly trigger ~:57).
 */

const EXODUS_SYNC = {
  wallets: [
    { wallet: 'GUDLWMBi1uH1vMwi3MMgmLEr8WwHWmvfy3tdeQzVQ4Dh', account: 'EXOD - 6388 - P2' }
  ],
  syncStart: '2026-10-01',
  driveFolderName: 'Exodus Transaction CSVs',
  moonpayOwners: new Set(['Cc3bpPzUvgAzdW9Nv7dUQ8cpap8Xa7ujJgLdpqGrTCu6']),
  // Exodus Pay card settlement: collector wallet and the program that pulls card spends.
  cardOwners: new Set(['2LS8fVobeHVYot3jp9xnJ7aqsZUhX64eukRUuqUeqfkm']),
  cardPrograms: new Set(['GHCAu2qLdwdSnbSwc4cPqDMvouaZNruB67gW6A8RTuzE']),
  cardPlaceholder: 'Exodus Pay Card',
  categories: { moonpay: 'Transfer: MoonPay', usdc: 'Transfer: USDC' },
  memoKey: (sig) => 'XO ' + sig.slice(0, 24),
  // A line is already booked if any memo holds this much of its signature (also catches lines
  // written by other tools, e.g. the first run from pea-docker on 2026-10-31).
  sigPrefix: 12,
  cardPlaceholders: new Set(['Exodus Pay Card', 'Exodus Pay']),
  // Earlier hand-entered lines: same amount (1 cent) within this many days.
  matchDays: 3
};

function exodusSyncDryRun() {
  return exodusSync_(false);
}

function exodusSyncApply() {
  return csvSyncLocked_('exodusSync', () => exodusSync_(true));
}

// ---------------------------------------------------------------- chain

/** {sig: {iso, time, amount (milli), dir, counterparty, card, usdcTo}} for one wallet, new sigs only. */
function exodusChainMoves_(wallet, isKnown, props) {
  const C = EXODUS_SYNC;
  const ignoredKey = 'EXOD_IGNORED_' + wallet;
  const ignored = new Set(JSON.parse(props.getProperty(ignoredKey) || '[]'));
  const startSec = isoDays_(C.syncStart) * 86400;
  const sigs = new Map();
  SOL_CFG.tokenPrograms.forEach((prog) => {
    const accts = solRpc_('getTokenAccountsByOwner', [wallet, { programId: prog }, { encoding: 'jsonParsed' }]).value || [];
    accts.forEach((a) => {
      if (!SOL_CFG.usdMints[a.account.data.parsed.info.mint]) return;
      let before = null;
      for (let page = 0; page < 10; page += 1) {
        const params = { limit: 1000 };
        if (before) params.before = before;
        const got = solRpc_('getSignaturesForAddress', [a.pubkey, params]) || [];
        got.forEach((s) => { if (!s.err && s.blockTime >= startSec) sigs.set(s.signature, s.blockTime); });
        if (got.length < 1000 || got[got.length - 1].blockTime < startSec) break;
        before = got[got.length - 1].signature;
      }
    });
  });

  const moves = [];
  sigs.forEach((bt, sig) => {
    if (isKnown(sig) || ignored.has(sig)) return;
    const t = solRpc_('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    if (!t || !t.meta) return; // not finalized yet; next run
    const delta = {}; // owner -> mint -> change
    const add = (b, sign) => {
      if (!SOL_CFG.usdMints[b.mint] || !b.owner) return;
      const o = delta[b.owner] || (delta[b.owner] = {});
      o[b.mint] = (o[b.mint] || 0) + sign * Number(b.uiTokenAmount.uiAmountString || 0);
    };
    (t.meta.postTokenBalances || []).forEach((b) => add(b, 1));
    (t.meta.preTokenBalances || []).forEach((b) => add(b, -1));
    const sum = (o) => Object.keys(o || {}).reduce((s, m) => s + o[m], 0);
    const mine = pyRound_(sum(delta[wallet]) * 1000);
    if (!mine) { ignored.add(sig); return; } // e.g. account setup, no money moved
    const dir = mine > 0 ? 1 : -1;
    // Counterparty: the owner whose dollar balance moved the other way the most.
    let cp = '', best = 0;
    Object.keys(delta).forEach((o) => {
      if (o === wallet) return;
      const v = sum(delta[o]) * -dir;
      if (v > best) { best = v; cp = o; }
    });
    // Swap out: who ended up with the USDC.
    let usdcTo = '', usdcBest = 0;
    Object.keys(delta).forEach((o) => {
      const v = (delta[o] || {})['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'] || 0;
      if (o !== wallet && v > usdcBest) { usdcBest = v; usdcTo = o; }
    });
    const keys = (t.transaction.message.accountKeys || []).map((k) => k.pubkey || k);
    const card = C.cardOwners.has(cp) || keys.some((k) => C.cardPrograms.has(k));
    const when = new Date(bt * 1000);
    moves.push({
      sig: sig, iso: Utilities.formatDate(when, 'America/New_York', 'yyyy-MM-dd'),
      time: Utilities.formatDate(when, 'UTC', 'yyyy-MM-dd HH:mm') + ' UTC',
      amount: cents_(mine), counterparty: cp, card: card, usdcTo: usdcTo
    });
  });
  props.setProperty(ignoredKey, JSON.stringify(Array.from(ignored).slice(-300)));
  return moves;
}

// ---------------------------------------------------------------- Exodus CSV (card merchants)

/** on-chain id -> {merchant, amount} from Exodus CARD_PAYMENT rows in Drive, if any. */
function exodusCardInfo_() {
  const out = {};
  let sources = [];
  try { sources = driveCsvs_(EXODUS_SYNC.driveFolderName); } catch (e) { return out; }
  sources.forEach((src) => {
    readCsvText_(src.text).forEach((r) => {
      if ((r.ACCOUNT || '').trim() !== 'Pay' || !/CARD/i.test(r.TYPE || '') || !r.ONCHAINID) return;
      out[r.ONCHAINID.trim()] = { merchant: (r.PARTICIPANT || '').trim(), amount: (r.AMOUNT || '').trim(),
        op: (r.OPERATION || '').trim() };
    });
  });
  return out;
}

/** "BESTBUY.COM 00994 RICHFIELD MNUSA" -> "BESTBUY.COM". */
function exodusMerchantPayee_(m) {
  const s = String(m || '').replace(/\s+/g, ' ').trim();
  const head = s.replace(/\s+[#*]?\d{3,}.*$/, '').trim();
  return cut_(head || s, 50);
}

// ---------------------------------------------------------------- plan

function exodusLine_(m, cards, catIds) {
  const C = EXODUS_SYNC;
  const short = (a) => (a ? a.slice(0, 6) + '...' + a.slice(-4) : '?');
  const l = { date: m.iso, amount: m.amount, key: C.memoKey(m.sig), sig: m.sig };
  if (m.card) {
    const info = cards[m.sig];
    l.payee = info && info.merchant ? exodusMerchantPayee_(info.merchant) : C.cardPlaceholder;
    l.memo = l.key + ' - Exodus Pay card' + (info ? ' $' + info.amount + ' ' + info.merchant : '') + ' - ' + m.time;
    l.card = true;
  } else if (m.amount > 0 && C.moonpayOwners.has(m.counterparty)) {
    l.payee = 'MoonPay'; l.category = catIds.moonpay;
    l.memo = l.key + ' - MoonPay xoUSD - ' + m.time;
  } else if (m.amount < 0) {
    l.payee = 'USDC Transfer'; l.category = catIds.usdc;
    l.memo = l.key + ' - USDC to ' + short(m.usdcTo || m.counterparty) + ' - ' + m.time;
  } else {
    l.payee = 'Exodus Deposit';
    l.memo = l.key + ' - from ' + short(m.counterparty) + ' - ' + m.time;
  }
  l.memo = cut_(l.memo, 200);
  return l;
}

/** True if the memo carries what looks like a signature reference (synced, not hand-entered). */
function exodusHasSigRef_(memo) {
  return (String(memo || '').match(/[1-9A-HJ-NP-Za-km-z]{8,}/g) || [])
    .some((w) => /\d/.test(w) && /[A-Z]/.test(w) && /[a-z]/.test(w));
}

function exodusSync_(apply) {
  const C = EXODUS_SYNC;
  const y = csvSyncYnab_();
  const props = PropertiesService.getScriptProperties();
  const accounts = y.get('/accounts').accounts.filter((a) => !a.deleted && !a.closed);
  const catIds = {};
  y.get('/categories').category_groups.forEach((g) => g.categories.forEach((c) => {
    Object.keys(C.categories).forEach((k) => { if (!c.deleted && c.name === C.categories[k]) catIds[k] = c.id; });
  }));
  const cards = exodusCardInfo_();
  const out = [];
  let created = 0, renamed = 0;

  C.wallets.forEach((w) => {
    const acct = accounts.find((a) => a.name.trim() === w.account);
    if (!acct) { out.push(w.account + ': YNAB account not found'); return; }
    const txns = y.get('/accounts/' + acct.id + '/transactions?since_date=' +
      isoAddDays_(C.syncStart, -C.matchDays)).transactions.filter((t) => !t.deleted);
    const memos = txns.map((t) => t.memo || '').join('\n');
    const isKnown = (sig) => memos.indexOf(sig.slice(0, C.sigPrefix)) >= 0;

    const lines = exodusChainMoves_(w.wallet, isKnown, props).map((m) => exodusLine_(m, cards, catIds))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    // Hand-entered lines without a memo key: same amount within matchDays.
    const used = new Set();
    const create = lines.filter((l) => {
      const t = txns.find((t) => !used.has(t.id) && !exodusHasSigRef_(t.memo) &&
        Math.abs(t.amount - l.amount) <= 10 && Math.abs(isoDays_(t.date) - isoDays_(l.date)) <= C.matchDays);
      if (t) { used.add(t.id); out.push('  matched by hand entry ' + t.date + ' ' + fmtMilli_(t.amount)); return false; }
      return true;
    });

    // Card lines booked before their merchant was known.
    const fixes = [];
    txns.forEach((t) => {
      if (t.approved || !C.cardPlaceholders.has(t.payee_name)) return;
      const sig = Object.keys(cards).find((s) => (t.memo || '').indexOf(s.slice(0, C.sigPrefix)) >= 0);
      if (!sig || !cards[sig].merchant) return;
      fixes.push({ id: t.id, payee_name: exodusMerchantPayee_(cards[sig].merchant),
        memo: cut_(C.memoKey(sig) + ' - Exodus Pay card $' + cards[sig].amount + ' ' + cards[sig].merchant, 200) });
    });

    const net = create.reduce((s, l) => s + l.amount, 0);
    out.push(w.account + ': ' + create.length + ' to create, ' + fixes.length + ' card payees to fill in');
    create.forEach((l) => out.push('  ' + l.date + '  ' + fmtMilli_(l.amount).padStart(10) + '  ' +
      l.payee.padEnd(16) + ' ' + l.memo));
    out.push('  balance now ' + fmtMilli_(acct.balance) + '; after sync ' + fmtMilli_(acct.balance + net));
    if (apply) {
      if (create.length) {
        const res = y.postTransactions(create.map((l) => {
          const t = { account_id: acct.id, date: l.date, amount: l.amount, payee_name: l.payee,
            memo: l.memo, cleared: 'cleared', approved: false };
          if (l.category) t.category_id = l.category;
          return t;
        }));
        created += res.transaction_ids.length;
      }
      if (fixes.length) { y.patchTransactions(fixes); renamed += fixes.length; }
    }
  });
  if (apply) out.push('Created ' + created + ', renamed ' + renamed);
  console.log(out.join('\n'));
  return { created: created, renamed: renamed, log: out.join('\n') };
}
