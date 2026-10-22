const FIELDS = ['endpoint', 'key', 'days', 'intervalMin'];
const DEFAULTS = { endpoint: '', key: '', days: 45, intervalMin: 60 };
const $ = (id) => document.getElementById(id);

async function load() {
  const s = Object.assign({}, DEFAULTS, await chrome.storage.sync.get(FIELDS));
  FIELDS.forEach((f) => { $(f).value = s[f]; });
  const { lastStatus } = await chrome.storage.local.get('lastStatus');
  $('status').textContent = lastStatus ? JSON.stringify(lastStatus, null, 2) : 'never';
}

async function save() {
  const s = {};
  FIELDS.forEach((f) => { s[f] = $(f).type === 'number' ? Number($(f).value) : $(f).value.trim(); });
  await chrome.storage.sync.set(s);
  await chrome.runtime.sendMessage('reschedule');
}

$('save').onclick = async () => { await save(); $('status').textContent = 'saved'; };
$('sync').onclick = async () => {
  await save();
  $('status').textContent = 'syncing...';
  const r = await chrome.runtime.sendMessage('sync');
  $('status').textContent = JSON.stringify(r, null, 2);
};
load();
