const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { installWebGlobals, evaluateUserscript } = require('./helpers/userscript.cjs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../gohigherlevel.user.js'), 'utf8');
const L = '3QixdLNutDXye95tTBK0';
function harness(t) {
  const dom = new JSDOM('<body></body>', { url: `https://go.pertamaproperty.com/v2/location/${L}/contacts`, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const w = dom.window; t.after(() => w.close()); installWebGlobals(w);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const calls = []; w.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === `https://services.leadconnectorhq.com/phone-system/numbers/v2/location/${L}?includeRcsSenderIds=true` && init.method === 'GET') {
      return new Response(JSON.stringify({ numbers: [{ phoneNumber: '+15550000001', linkedUser: 'u1', capabilities: { sms: true } }], total: 1 }));
    }
    throw Error('Unexpected request');
  };
  const e = evaluateUserscript(w, source);
  const token = `x.${Buffer.from(JSON.stringify({ user_id: 'u1', sub: 'u1', locations: [L], exp: Date.now() / 1000 + 3600 })).toString('base64url')}.x`;
  e(`captureReadHeaders('https://services.leadconnectorhq.com/contacts/c1', ${JSON.stringify({ 'token-id': token })})`);
  return { w, e, calls, d: w.document, open() { e('openLeadAccessReport()'); return w.document.getElementById('pertama-lead-access'); },
    result(result) { w.reportResult = { complete: true, cancelled: false, checked: 33, warnings: [], rows: [], ...result }; e('runLeadAccessReport = async () => globalThis.reportResult'); } };
}
for (const escape of [false, true]) test(`settings report entry preserves unsaved form and restores focus; Escape=${escape}`, async t => {
  const h = harness(t); h.e('openSettings()'); await new Promise(resolve => setImmediate(resolve));
  const settings = h.d.querySelector('#pertama-settings');
  assert.ok(h.calls.length <= 1);
  for (const request of h.calls) {
    assert.equal(request.url, `https://services.leadconnectorhq.com/phone-system/numbers/v2/location/${L}?includeRcsSenderIds=true`);
    assert.equal(request.init.method, 'GET');
  }
  const settingsRequests = h.calls.length;
  const entry = settings.querySelector('[data-lead-access]'); assert.ok(entry); assert.equal(entry.type, 'button');
  assert.equal(entry.textContent, 'Inaccessible leads →');
  assert.equal(entry.closest('section').querySelector('h3').textContent, 'Reports');
  assert.ok(entry.compareDocumentPosition(settings.querySelector('.settings-footer')) & h.w.Node.DOCUMENT_POSITION_FOLLOWING);
  const input = settings.querySelector('[name=note]'); input.value = 'Unsaved edit';
  let submitted = 0; settings.querySelector('form').addEventListener('submit', () => submitted++);
  const before = h.w.localStorage.length; entry.click(); const report = h.d.querySelector('#pertama-lead-access');
  assert.ok(report.open); assert.ok(settings.open); assert.equal(submitted, 0); assert.equal(h.calls.length, settingsRequests);
  h.e('openLeadAccessReport()'); assert.equal(h.d.querySelectorAll('#pertama-lead-access').length, 1);
  assert.equal(h.calls.length, settingsRequests, 'opening the report adds no requests');
  if (escape) report.dispatchEvent(new h.w.Event('cancel', { cancelable: true })); else report.querySelector('[data-close]').click();
  assert.ok(settings.open); assert.equal(input.value, 'Unsaved edit'); assert.equal(h.w.localStorage.length, before);
  assert.equal(h.d.activeElement, entry);
});
test('report opens with scoped responsive styles, default period and quiet controls', t => {
  const h = harness(t), dialog = h.open();
  assert.equal(dialog.querySelector('select').value, '30');
  assert.deepEqual([...dialog.querySelectorAll('option')].map(o => o.textContent), ['Last 7 days', 'Last 30 days', 'Last 90 days']);
  assert.match(dialog.querySelector('label').textContent, /Calls from/);
  assert.equal(dialog.querySelector('[role=status]').textContent, 'Choose a period and run the report.');
  assert.ok(dialog.querySelector('[data-cancel]').hidden); assert.equal(dialog.querySelectorAll('[data-close]').length, 1);
  assert.equal(dialog.querySelector('[data-close]').getAttribute('aria-label'), 'Close');
  assert.match(dialog.querySelector('style').textContent, /#pertama-lead-access::backdrop/);
  const style = h.w.getComputedStyle(dialog);
  assert.equal(style.width, '800px'); assert.equal(style.maxHeight, '85vh');
  assert.equal(style.maxWidth, 'calc(100vw - 32px)');
  assert.doesNotMatch(dialog.textContent, /proof of ownership|180 days|Missing tasks|No requests/);
  assert.equal(h.calls.length, 0);
});
test('semantic rows keep IDs once, escape text, stack tasks and format dates explicitly in WITA', async t => {
  const h = harness(t), year = new Date().getFullYear();
  h.result({ rows: [
    { id: 'contact-unique', name: '<img src=x>', lastCall: `${year}-10-11T20:00:00Z`, tasks: [
      { title: '<script>hostile</script>', due: `${year}-10-14` }, { title: 'Second', due: `${year}-10-14T20:15:00Z` }] },
    { id: 'missing-id', name: 'missing-id', lastCall: null, tasks: [{ title: 'Do not infer this name', due: 'invalid' }] },
    { id: 'empty-name', name: '', lastCall: 'invalid', tasks: [] },
    { id: 'older', name: 'Older', lastCall: '2000-10-12T03:00:00Z', tasks: [] },
  ] });
  const dialog = h.open(); await dialog.querySelector('[data-run]').onclick();
  assert.deepEqual([...dialog.querySelectorAll('th')].map(x => x.textContent), ['Contact', 'Last call', 'Remembered follow-up', 'Due']);
  const rows = [...dialog.querySelectorAll('tbody tr')]; assert.equal(rows.length, 4);
  assert.equal(rows[0].querySelectorAll('td').length, 4); assert.equal(rows[0].querySelector('a').textContent, '<img src=x>');
  assert.equal(rows[0].textContent.split('contact-unique').length - 1, 1); assert.equal(dialog.querySelectorAll('img,script').length, 0);
  assert.equal(rows[0].children[1].textContent, '12 Oct'); assert.match(rows[0].children[2].textContent, /<script>hostile<\/script>/);
  assert.match(rows[0].children[3].textContent, /14 Oct.*11:00.*15 Oct.*04:15/s);
  assert.equal(rows[1].querySelector('a').textContent, 'Name unavailable'); assert.equal(rows[1].textContent.split('missing-id').length - 1, 1);
  assert.equal(rows[1].children[1].textContent, '—'); assert.equal(rows[1].children[3].textContent, '—');
  assert.equal(rows[2].querySelector('a').textContent, 'Name unavailable'); assert.equal(rows[2].children[1].textContent, '—');
  assert.equal(rows[3].children[1].textContent, '12 Oct 2000');
  assert.doesNotMatch(dialog.querySelector('[data-rows]').textContent, /unknown|T03:|T20:|observed|Last accessible/);
  assert.equal(dialog.querySelector('[role=status]').textContent, '4 inaccessible · 33 checked');
  h.result({ rows: [] }); await dialog.querySelector('[data-run]').onclick(); assert.equal(dialog.querySelectorAll('tbody tr').length, 0);
  assert.match(dialog.querySelector('[data-rows]').textContent, /No inaccessible contacts found\./);
});
test('report date formatter construction is bounded across rows and reruns', async t => {
  const h = harness(t);
  const DateTimeFormat = h.w.Intl.DateTimeFormat;
  let constructions = 0;
  h.w.Intl.DateTimeFormat = function(...args) { constructions++; return new DateTimeFormat(...args); };
  h.result({ rows: Array.from({ length: 30 }, (_, i) => ({ id: 'lead' + i, name: 'Lead ' + i,
    lastCall: '2026-10-14T20:15:00Z', tasks: [
      { title: 'Date only', due: '2026-10-14' }, { title: 'Timestamp', due: '2026-10-14T20:15:00Z' },
    ] })) });
  const dialog = h.open(); await dialog.querySelector('[data-run]').onclick();
  assert.equal(dialog.querySelectorAll('tbody tr').length, 30);
  assert.equal(dialog.querySelector('tbody tr td:nth-child(2)').title, '15 Oct 2026, 04:15 WITA');
  assert.ok(constructions <= 4, `constructed ${constructions} formatters for 90 dates`);
  const firstRun = constructions;
  await dialog.querySelector('[data-run]').onclick();
  assert.equal(constructions, firstRun, 'reruns should reuse the same formatters');
});

test('date tooltips use converted full WITA timestamps, including date-only deadlines and next-day calls', async t => {
  const h = harness(t);
  h.result({ rows: [
    { id: 'dated', name: 'Dated', lastCall: '2026-10-14T20:15:00Z', tasks: [
      { title: 'Date only', due: '2026-10-14' }, { title: 'Timestamp', due: '2026-10-14T20:15:00Z' }] },
    { id: 'missing', name: '', lastCall: null, tasks: [{ title: 'Missing', due: '' }] },
    { id: 'invalid', name: '', lastCall: 'invalid', tasks: [{ title: 'Invalid', due: '2026-02-30' }] },
  ] });
  const dialog = h.open(); await dialog.querySelector('[data-run]').onclick();
  const rows = [...dialog.querySelectorAll('tbody tr')];
  const deadlines = rows[0].children[3].children;
  assert.equal(deadlines[0].title, '14 Oct 2026, 11:00 WITA');
  assert.equal(deadlines[1].title, '15 Oct 2026, 04:15 WITA');
  assert.equal(rows[0].children[1].title, '15 Oct 2026, 04:15 WITA');
  for (const row of rows.slice(1)) {
    assert.equal(row.children[1].hasAttribute('title'), false);
    assert.equal(row.children[3].firstElementChild.hasAttribute('title'), false);
  }
});
test('running disables filters and Run, exposes Cancel, then restores controls', async t => {
  const h = harness(t); let finish;
  h.w.waitForReport = (days, progress) => { assert.equal(days, 30); progress('Reading your calls…'); return new Promise(resolve => { finish = resolve; }); };
  h.e('runLeadAccessReport = (days, progress) => globalThis.waitForReport(days, progress)');
  const dialog = h.open(), run = dialog.querySelector('[data-run]'), cancel = dialog.querySelector('[data-cancel]');
  const pending = run.onclick(); assert.equal(run.disabled, true); assert.equal(dialog.querySelector('select').disabled, true);
  assert.equal(cancel.hidden, false); assert.equal(cancel.disabled, false); assert.match(dialog.querySelector('[role=status]').textContent, /Reading/);
  finish({ complete: false, cancelled: true, checked: 0, rows: [], warnings: ['Cancelled'] }); await pending;
  assert.equal(run.disabled, false); assert.equal(dialog.querySelector('select').disabled, false); assert.equal(cancel.hidden, true);
  assert.equal(dialog.querySelector('[role=status]').textContent, 'Report cancelled.');
  assert.doesNotMatch(dialog.querySelector('[data-rows]').textContent, /No inaccessible/);
});
test('incomplete warnings are concise and keep full error details without a clean empty claim', async t => {
  const h = harness(t), detail = 'Incomplete task coverage: HTTP 500 ' + 'technical '.repeat(80);
  h.result({ complete: false, warnings: [detail] }); const dialog = h.open(); await dialog.querySelector('[data-run]').onclick();
  const warning = dialog.querySelector('[data-warning]'); assert.ok(warning);
  assert.equal(warning.textContent, 'Task lookup failed. Results may be incomplete.'); assert.equal(warning.title, detail);
  assert.doesNotMatch(dialog.querySelector('[data-rows]').textContent, /No inaccessible/);
  assert.equal(dialog.querySelector('[data-storage]').textContent, '');
  h.result({}); await dialog.querySelector('[data-run]').onclick(); assert.equal(warning.textContent, '');
  assert.match(dialog.querySelector('[data-rows]').textContent, /No inaccessible contacts found/);
});
