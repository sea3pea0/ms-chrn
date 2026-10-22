// MS-CHRN Sync: every hour (and when the icon is clicked) pull each site you're signed in to and
// post the rows to the workbook's web-app endpoint (gas/Ingest.gs). Add a site by writing an
// adapter in sites/ and listing it in SITES.
import { taekus } from './sites/taekus.js';

const SITES = [taekus];
const ALARM = 'ms-chrn-sync';
const DEFAULTS = { endpoint: '', key: '', days: 45, intervalMin: 60 };

async function settings() {
  return Object.assign({}, DEFAULTS, await chrome.storage.sync.get(Object.keys(DEFAULTS)));
}

async function schedule() {
  const s = await settings();
  await chrome.alarms.clear(ALARM);
  chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: Math.max(15, Number(s.intervalMin) || 60) });
}

async function badge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title: 'MS-CHRN Sync: ' + title });
}

async function syncAll() {
  const s = await settings();
  if (!s.endpoint || !s.key) {
    await badge('SET', '#888', 'open Options to set the endpoint URL and key');
    return { ok: false, error: 'not configured' };
  }
  const status = { at: new Date().toISOString(), sites: {} };
  let problem = '';
  for (const site of SITES) {
    try {
      const data = await site.pull({ days: Number(s.days) || 45 });
      const r = await fetch(s.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ key: s.key, site: site.id }, data))
      });
      const res = await r.json().catch(() => ({ ok: false, error: 'endpoint returned ' + r.status }));
      status.sites[site.id] = res;
      if (!res.ok) problem = site.label + ': ' + res.error;
    } catch (e) {
      status.sites[site.id] = { ok: false, error: e.message, loginNeeded: !!e.loginNeeded };
      problem = e.loginNeeded ? 'sign in to ' + site.label : site.label + ': ' + e.message;
    }
  }
  await chrome.storage.local.set({ lastStatus: status });
  if (problem) await badge('!', '#c0392b', problem);
  else await badge('', null, 'last synced ' + new Date().toLocaleString());
  return status;
}

chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) syncAll(); });
chrome.action.onClicked.addListener(() => syncAll());
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg === 'sync') { syncAll().then(reply); return true; }
  if (msg === 'reschedule') { schedule().then(() => reply(true)); return true; }
  return false;
});
