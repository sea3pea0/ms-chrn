/**
 * Fluz transactions pulled from the official Fluz API instead of hand-exported CSVs.
 *
 * refreshFluzApiCsv() asks the API for every transaction updated in the last FLUZ_API.days days
 * and writes them, in Fluz's own export format, to one file in the "Fluz Transaction CSVs" Drive
 * folder (FLUZ_API.fileName, replaced each run). Everything downstream is unchanged: the workbook
 * import and the Fluz -> YNAB sync already read every CSV in that folder and merge overlapping
 * rows by Transaction ID.
 *
 * Setup (once): fluz.app/for-developers > Create new app with scopes LIST_PAYMENT and
 * LIST_PURCHASES, then add three script properties from that app: FLUZ_API_KEY, FLUZ_USER_ID,
 * FLUZ_ACCOUNT_ID. With no key this is a no-op. Each run mints a fresh access token from the
 * API key, so no refresh token has to be stored.
 */

const FLUZ_API = {
  graph: 'https://transactional-graph.fluzapp.com/api/v1/graphql',
  scopes: ['LIST_PAYMENT', 'LIST_PURCHASES'],
  fileName: 'fluz_api_transactions.csv',
  days: 45, // rows updated within this window are rewritten each run (pending -> settled)
  pageSize: 20, // API maximum
  // The API returns unsigned amounts; Fluz's export makes money leaving Fluz negative.
  outflowTypes: /purchase|withdrawal|transfer - out/i,
  // Same columns, in the same order, as Fluz's "all transactions" export.
  csvHeaders: ['Transaction ID', 'Bulk Order ID', 'User', 'Type', 'Amount', 'Destination', 'Source', 'Cashback',
    'Cashback Rate', 'Bonus Cashback Rate', 'Fee', 'Status', 'Reference ID', 'Description', 'Note', 'Category',
    'Card last 4', 'Card name', 'Original Currency Amount', 'Currency', 'Channel', 'Created At', 'Updated At',
    'Ending available balance', 'Ending total balance', 'Transaction category', 'Transaction memo'],
  fields: 'recordId user transactionType amount destination source cashback cashbackRate bonusCashbackRate fee ' +
    'status referenceId description note category cardLastFour cardDisplayName originalCurrencyAmount ' +
    'originalCurrencyCode channel createdAt updatedAt cashBalanceAvailableBalance cashBalanceTotalBalance ' +
    'transactionCategory memo'
};

function refreshFluzApiCsv() {
  const p = PropertiesService.getScriptProperties();
  const key = p.getProperty('FLUZ_API_KEY');
  if (!key) return 0;
  const token = fluzGraph_({ Authorization: 'Basic ' + key },
    'mutation ($userId: UUID, $accountId: UUID, $scopes: [ScopeType!]!) {' +
    ' generateUserAccessToken(userId: $userId, accountId: $accountId, scopes: $scopes) { token } }',
    { userId: p.getProperty('FLUZ_USER_ID'), accountId: p.getProperty('FLUZ_ACCOUNT_ID'), scopes: FLUZ_API.scopes }
  ).generateUserAccessToken.token;

  const since = new Date(Date.now() - FLUZ_API.days * 86400000).toISOString();
  const txns = [];
  for (let offset = 0; ; offset += FLUZ_API.pageSize) {
    const page = fluzGraph_({ Authorization: 'Bearer ' + token },
      'query ($filter: TransactionFilterInput, $paginate: OffsetInput) {' +
      ' getTransactions(filter: $filter, paginate: $paginate) { transactions { ' + FLUZ_API.fields +
      ' } hasNextPage } }',
      { filter: { updatedGte: since }, paginate: { limit: FLUZ_API.pageSize, offset: offset } }
    ).getTransactions;
    (page.transactions || []).forEach((t) => txns.push(t));
    if (!page.hasNextPage || !(page.transactions || []).length) break;
  }

  const v = (x) => (x === null || x === undefined || x === '' ? '--' : x);
  const n5 = (x) => (x === null || x === undefined ? '0.00000' : Number(x).toFixed(5));
  const usd = (x) => (x === null || x === undefined ? '--' : '$' + Number(x).toFixed(2));
  const rows = txns.map((t) => [
    t.recordId, '--', v(t.user), v(t.transactionType),
    n5(FLUZ_API.outflowTypes.test(t.transactionType || '') ? -Math.abs(t.amount) : t.amount), v(t.destination), v(t.source),
    n5(t.cashback), n5(t.cashbackRate), n5(t.bonusCashbackRate), n5(t.fee), v(t.status), v(t.referenceId),
    v(t.description), v(t.note), v(t.category), v(t.cardLastFour), v(t.cardDisplayName),
    t.originalCurrencyAmount === null || t.originalCurrencyAmount === undefined ? '--' : n5(t.originalCurrencyAmount),
    v(t.originalCurrencyCode), v(t.channel), v(t.createdAt), v(t.updatedAt),
    usd(t.cashBalanceAvailableBalance), usd(t.cashBalanceTotalBalance), v(t.transactionCategory), v(t.memo)
  ]);
  // Stable order, so an unchanged result leaves the file (and the hourly re-import) alone.
  rows.sort((x, y) => (x[21] < y[21] ? 1 : x[21] > y[21] ? -1 : x[0] < y[0] ? -1 : 1));
  const csv = [FLUZ_API.csvHeaders].concat(rows).map((r) => r.map((c) => {
    const s = String(c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n') + '\n';

  const folders = DriveApp.getFoldersByName(XFER_CFG.fluzFolder);
  if (!folders.hasNext()) throw new Error('Drive folder not found: ' + XFER_CFG.fluzFolder);
  const folder = folders.next();
  const existing = folder.getFilesByName(FLUZ_API.fileName);
  if (existing.hasNext()) {
    const f = existing.next();
    if (f.getBlob().getDataAsString() !== csv) f.setContent(csv); // unchanged file = no re-import
  } else {
    folder.createFile(FLUZ_API.fileName, csv, MimeType.CSV);
  }
  console.log('Fluz API: ' + rows.length + ' transactions updated since ' + since.slice(0, 10));
  return rows.length;
}

/** POST one GraphQL request; returns data or throws with the API's error message. */
function fluzGraph_(headers, query, variables) {
  const r = UrlFetchApp.fetch(FLUZ_API.graph, {
    method: 'post', contentType: 'application/json', headers: headers, muteHttpExceptions: true,
    payload: JSON.stringify({ query: query, variables: variables })
  });
  const body = r.getContentText();
  let j = null;
  try { j = JSON.parse(body); } catch (e) { /* not JSON */ }
  if (r.getResponseCode() >= 300 || !j || j.errors) {
    const msg = j && j.errors ? j.errors.map((e) => e.message).join('; ') : body.slice(0, 300);
    throw new Error('Fluz API ' + r.getResponseCode() + ': ' + msg);
  }
  return j.data;
}
