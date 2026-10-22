// Taekus adapter: reads the same JSON the Taekus web app uses, with your signed-in session.
// Points per transaction come from the rewards feed, joined on the exact time and amount.

const BASE = 'https://app.taekus.com';

async function getJson(path) {
  const r = await fetch(BASE + path, { credentials: 'include', headers: { accept: 'application/json' } });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Taekus: not signed in'), { loginNeeded: true });
  if (!r.ok) throw new Error('Taekus ' + path.split('?')[0] + ' failed: ' + r.status);
  return r.json();
}

export const taekus = {
  id: 'taekus',
  label: 'Taekus',
  loginUrl: BASE + '/',

  /** Returns { accounts: [...] } in the shape the workbook's Ingest.gs expects. */
  async pull({ days }) {
    const user = await getJson('/api/user/');
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);

    // Points: rewards feed (all accounts), keyed by transaction time (to the second) + amount.
    const points = {};
    const rewards = (await getJson('/api/banking/rewards/transactions/')).rewardsTransactions || [];
    rewards.forEach((x) => {
      const c = x.content_object || {};
      if (!c.transaction_datetime || x.transaction_type === 'REDEMPTION') return;
      const k = Math.floor(Date.parse(c.transaction_datetime) / 1000) + '|' + Math.round(Number(c.amount) * 100);
      points[k] = (points[k] || 0) + Number(x.value || 0);
    });

    const accounts = [];
    for (const a of user.card_accounts || []) {
      const txns = [];
      let startIndex = 0;
      for (let page = 0; page < 100; page += 1) {
        const q = new URLSearchParams({
          cardAccountUuid: a.uuid, startIndex: String(startIndex), startDate: start.toISOString(),
          endDate: end.toISOString(), transactionType: 'ALL'
        });
        const j = await getJson('/api/banking/activity/?' + q);
        (j.transactions || []).forEach((t) => {
          if (/DECLIN|VOID|EXPIR/i.test(t.state || '')) return;
          const amount = Number((t.amount || {}).amount_usd);
          const k = Math.floor(Date.parse(t.date) / 1000) + '|' + Math.round(amount * 100);
          txns.push({
            token: t.token, ts: t.date, amount, settled: !!t.settled, state: t.state || '',
            description: ((t.merchant || {}).description || t.memo || '').trim(),
            merchant: ((t.merchant || {}).name || '') || '', mcc: '',
            points: points[k] || 0, refund: /REFUND|RETURN/i.test(t.type || '')
          });
        });
        if (!j.is_more || !(j.transactions || []).length) break;
        startIndex = Number(j.end_index) + 1;
      }
      accounts.push({
        last4: a.account_last_4, name: a.name || a.nickname || '', available_balance: a.available_balance,
        start: start.toISOString(), end: end.toISOString(), transactions: txns
      });
    }
    return { accounts };
  }
};
