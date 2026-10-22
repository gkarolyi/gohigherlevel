const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { installWebGlobals, evaluateUserscript } = require('./helpers/userscript.cjs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../gohigherlevel.user.js'), 'utf8');
const L = '3QixdLNutDXye95tTBK0';
const NOW = Date.parse('2026-10-15T02:30:00Z'), TODAY = Date.parse('2026-10-14T16:00:00Z'), YESTERDAY = TODAY - 86400000;
const own = { phoneNumber: '+15550000001', linkedUser: 'u1', capabilities: { voice: true } };
const inventory = { numbers: [own, { ...own, phoneNumber: '+15550000002', linkedUser: 'u2' }, { phoneNumber: '+15550000003', capabilities: { voice: true } }], total: 3 };
const call = (id, overrides = {}) => ({ id: `call${id}`, contactId: 'same-contact', userId: 'u1', locationId: L, dateAdded: new Date(TODAY).toISOString(), direction: 'outbound', callStatus: 'completed', ...overrides });
function harness(t, rows = [], respond) {
  const dom = new JSDOM('<body></body>', { url: `https://go.pertamaproperty.com/v2/location/${L}/contacts`, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const w = dom.window; t.after(() => w.close()); installWebGlobals(w);
  w.Date.now = () => NOW;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const calls = [], settingsCalls = [];
  let openingSettings = false;
  w.fetch = async (url, init) => {
    if (openingSettings) {
      settingsCalls.push({ url, init });
      assert.equal(url, `https://services.leadconnectorhq.com/phone-system/numbers/v2/location/${L}?includeRcsSenderIds=true`);
      assert.equal(init.method, 'GET');
      return new Response(JSON.stringify(inventory));
    }
    calls.push({ url, init });
    let data;
    if (respond) data = await respond(url, init, calls.length);
    if (data === undefined) {
      if (url.includes('/numbers/v2/')) data = inventory;
      else if (url.includes('/reporting/')) { const b = JSON.parse(init.body); data = { rows: rows.slice(b.skip, b.skip + 50), totalRows: rows.length, totalPages: Math.ceil(rows.length / 50) }; }
      else throw Error(`Unexpected endpoint: ${url}`);
    }
    return data instanceof Response ? data : new Response(JSON.stringify(data));
  };
  const e = evaluateUserscript(w, source);
  function auth(user = 'u1') { const token = `x.${Buffer.from(JSON.stringify({ user_id: user, sub: user, locations: [L], exp: NOW / 1000 + 3600 })).toString('base64url')}.x`; e(`captureReadHeaders('https://services.leadconnectorhq.com/contacts/c1', {'token-id': ${JSON.stringify(token)}})`); }
  auth();
  return { w, e, calls, settingsCalls, auth, run: () => e('runOutgoingCallCount()'), async open() {
    // Settings owns its inventory lookup; counter assertions cover only subsequent requests.
    const before = calls.length, settingsBefore = settingsCalls.length;
    openingSettings = true;
    e('openSettings()'); await tick();
    openingSettings = false;
    assert.equal(calls.length, before);
    const inventoryRequests = settingsCalls.slice(settingsBefore);
    assert.ok(inventoryRequests.length <= 1);
    for (const request of inventoryRequests) {
      assert.equal(request.url, `https://services.leadconnectorhq.com/phone-system/numbers/v2/location/${L}?includeRcsSenderIds=true`);
      assert.equal(request.init.method, 'GET');
    }
    return w.document.querySelector('#pertama-settings');
  } };
}
const plain = x => JSON.parse(JSON.stringify(x));
const tick = () => new Promise(resolve => setImmediate(resolve));
test('counts distinct own outbound calls in exact WITA days, including unknown outcomes', async t => {
  const h = harness(t, [call(1), call(1), call(2, { callStatus: 'busy' }), call(3, { callStatus: 'failed', dateAdded: new Date(TODAY - 1).toISOString() }),
    call(4, { callStatus: 'no-answer', dateAdded: new Date(YESTERDAY).toISOString() }), call(5, { callStatus: '<img src=x>' }),
    call(6, { direction: 'inbound' }), call(7, { userId: 'u2' }), call(8, { dateAdded: new Date(YESTERDAY - 1).toISOString() }),
    call(9, { dateAdded: new Date(NOW).toISOString() }), call(10, { dateAdded: new Date(NOW + 1).toISOString() })]);
  const before = h.w.localStorage.length;
  h.e(`leadHistory = flushLeadHistory = updateLeadHistory = () => { throw Error('Counter touched history'); }`);
  const result = await h.run();
  assert.deepEqual(plain(result.days), [{ label: 'Today', total: 3, statuses: { completed: 1, busy: 1, '<img src=x>': 1 } }, { label: 'Yesterday', total: 2, statuses: { failed: 1, 'no-answer': 1 } }]);
  for (const day of result.days) assert.equal(Object.values(day.statuses).reduce((a, b) => a + b, 0), day.total);
  assert.equal(result.updatedAt, NOW); assert.equal(h.calls.length, 2); assert.equal(h.w.localStorage.length, before);
  const b = JSON.parse(h.calls[1].init.body);
  assert.equal(b.startDate, new Date(YESTERDAY).toISOString()); assert.equal(b.endDate, new Date(NOW).toISOString());
  assert.equal(b.userId, ''); assert.deepEqual(b.selectedPool, [own.phoneNumber]); assert.equal(b.limit, 50); assert.equal(b.skip, 0);
  assert.equal(h.calls[0].init.headers.version, '2021-07-28'); assert.equal(h.calls[1].init.headers.version, '2021-04-15');
});
test('uses native callStatus only, never an invented status fallback', async t => {
  const h = harness(t, [call(1, { status: 'wrong', callStatus: 'busy' }), call(2, { status: 'wrong', callStatus: undefined })]);
  const result = await h.run();
  assert.deepEqual(plain(result.days[0].statuses), { busy: 1, unknown: 1 });
});
test('over-cap call inventory stops after its first page without partial results', async t => {
  const h = harness(t, Array.from({ length: 5001 }, (_, i) => call(i)));
  await assert.rejects(h.run(), /capped at 5,000/);
  assert.equal(h.calls.length, 2); assert.equal(h.e('leadReportRun'), null);
  const d = await h.open(); await d.querySelector('[data-call-count-load]').onclick();
  assert.equal(h.calls.length, 4);
  assert.equal(d.querySelector('[data-call-count-rows]').textContent, '');
  assert.match(d.querySelector('[data-call-count-status]').textContent, /Could not load/);
});
test('outgoing counter appears above inaccessible report with spacing', async t => {
  const h = harness(t), d = await h.open(), counter = d.querySelector('[data-call-count]'), report = d.querySelector('[data-lead-access]');
  assert.ok(counter.compareDocumentPosition(report) & h.w.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(h.w.getComputedStyle(counter).marginBottom, '16px');
});
test('call counting does not require an associated contact', async t => {
  const h = harness(t, [call(1, { contactId: null }), call(2, { contactId: undefined })]);
  const result = await h.run();
  assert.equal(result.days[0].total, 2);
  assert.equal(result.days[0].statuses.completed, 2);
  assert.equal(h.calls.length, 2);
});
for (const size of [0, 51, 125, 5000]) test(`complete pagination with ${size} calls and zero-day rows`, async t => {
  const h = harness(t, Array.from({ length: size }, (_, i) => call(i)));
  const result = await h.run(); assert.equal(result.days.length, 2); assert.equal(result.days[0].total, size); assert.equal(result.days[1].total, 0);
  assert.deepEqual(h.calls.slice(1).map(c => JSON.parse(c.init.body).skip), Array.from({ length: Math.max(1, Math.ceil(size / 50)) }, (_, i) => i * 50));
});
for (const mode of ['failure', 'repeat', 'overlap', 'total', 'short']) test(`rejects ${mode} on late page, never returns partial totals`, async t => {
  const rows = Array.from({ length: 101 }, (_, i) => call(i));
  const h = harness(t, rows, (url, init) => {
    if (!url.includes('/reporting/') || JSON.parse(init.body).skip !== 50) return;
    if (mode === 'failure') return new Response('{}', { status: 500 });
    return { rows: mode === 'repeat' ? rows.slice(0, 50) : mode === 'overlap' ? rows.slice(49, 99) : rows.slice(50, mode === 'short' ? 51 : 100), totalRows: mode === 'total' ? 102 : 101, totalPages: 3 };
  });
  await assert.rejects(h.run(), /lookup|Repeated|incomplete|totals/i);
  assert.equal(h.e('leadReportRun'), null);
});
test('UI is click-only, safely renders totals and WITA timestamp, refresh clears failure and preserves settings', async t => {
  let fail = false;
  const h = harness(t, [call(1, { callStatus: '<img src=x>' })], () => fail ? new Response('{}', { status: 500 }) : undefined);
  const d = await h.open(), button = d.querySelector('[data-call-count-load]'); assert.ok(button); assert.equal(button.textContent, 'Load call counts');
  assert.equal(h.calls.length, 0); assert.equal(d.querySelector('[data-call-count-rows]').textContent, '');
  d.querySelector('[name=note]').value = 'Unsaved';
  await button.onclick();
  assert.equal(button.textContent, 'Refresh'); assert.equal(d.querySelectorAll('[data-call-count-rows] tbody tr').length, 2);
  assert.equal(d.querySelectorAll('img').length, 0); assert.match(d.querySelector('[data-call-count-rows]').textContent, /<img src=x>/);
  assert.equal(d.querySelector('[data-call-count-status]').textContent, 'Updated 10:30 · WITA');
  assert.match(d.querySelector('[data-call-count-rows]').textContent, /Today.*Yesterday/s);
  fail = true; await button.onclick();
  assert.equal(d.querySelector('[data-call-count-rows]').textContent, ''); assert.match(d.querySelector('[data-call-count-status]').textContent, /Could not load/);
  assert.equal(d.querySelector('[name=note]').value, 'Unsaved');
});
for (const mode of ['close', 'escape', 'save', 'user', 'auth', 'account']) test(`${mode} cancels counter and suppresses late paint`, async t => {
  let finish;
  const h = harness(t, [], (url) => url.includes('/numbers/') ? new Promise(resolve => { finish = resolve; }) : undefined);
  const d = await h.open(), button = d.querySelector('[data-call-count-load]'); assert.ok(button);
  const pending = button.onclick(); await tick(); assert.equal(button.disabled, true);
  await button.onclick(); assert.equal(h.calls.length, 1); assert.equal(d.querySelector('[data-lead-access]').disabled, true);
  if (mode === 'close') d.querySelector('[data-cancel]').click();
  if (mode === 'escape') d.dispatchEvent(new h.w.Event('cancel', { cancelable: true }));
  if (mode === 'save') d.querySelector('form').dispatchEvent(new h.w.Event('submit', { cancelable: true }));
  if (mode === 'user') h.auth('u2');
  if (mode === 'auth') h.e('rejectCrmAuthorization()');
  if (mode === 'account') h.w.history.pushState({}, '', '/v2/location/other/contacts');
  assert.equal(h.calls[0].init.signal.aborted, true);
  finish(inventory); await pending;
  assert.equal(h.calls.length, 1); assert.equal(d.querySelector('[data-call-count-rows]').textContent, '');
  if (['user', 'auth', 'account'].includes(mode)) { assert.equal(button.disabled, true); await button.onclick(); assert.equal(h.calls.length, 1); }
  else assert.equal(d.isConnected, false);
});
test('shared run rejects simultaneous report and report close does not cancel counter owner', async t => {
  let finish; const h = harness(t, [], url => url.includes('/numbers/') ? new Promise(resolve => { finish = resolve; }) : undefined);
  const pending = h.run(); await tick();
  await assert.rejects(h.e('runLeadAccessReport()'), /already running/);
  h.e('closeLeadAccessReport()'); assert.equal(h.calls[0].init.signal.aborted, false);
  finish(inventory); assert.equal((await pending).days[0].total, 0);
});
test('counter rejects another active owner without cancelling it', async t => {
  const h = harness(t); h.e('leadReportRun = { context: leadAccessContext(), cancelled: false }');
  await assert.rejects(h.run(), /already running/); assert.equal(h.e('leadReportRun.cancelled'), false);
});
test('identity switch clears already loaded rows and disables old settings context', async t => {
  const h = harness(t, [call(1)]), d = await h.open(), button = d.querySelector('[data-call-count-load]'); assert.ok(button);
  await button.onclick(); h.auth('u2');
  assert.equal(d.querySelector('[data-call-count-rows]').textContent, ''); assert.equal(button.disabled, true);
});
for (const data of [{ numbers: [], total: 0 }, { numbers: [own], total: 2 }, { numbers: [own, own], total: 2 }, { numbers: [{ ...own, linkedUser: {} }], total: 1 }]) test('invalid/non-own pool cannot produce a zero-call success', async t => {
  const h = harness(t, [], () => data);
  await assert.rejects(h.run(), /inventory|No voice/); assert.equal(h.calls.length, 1);
});
test('unknown and prototype-like statuses are safe and nested call legs never count', async t => {
  const h = harness(t, [call(1, { callStatus: '__proto__', calls: [call(55), call(56)] }), call(2, { callStatus: null }), call(3, { callStatus: 'no-answer' })]);
  const result = await h.run();
  assert.equal(result.days[0].total, 3);
  assert.deepEqual(plain(result.days[0].statuses), JSON.parse('{"__proto__":1,"unknown":1,"no-answer":1}'));
  const d = await h.open(); await d.querySelector('[data-call-count-load]').onclick();
  assert.deepEqual([...d.querySelectorAll('[data-call-count-rows] thead th')].map(x => x.textContent), ['Day · WITA', 'Total', 'Completed', 'Busy', 'Failed', '__proto__', 'unknown', 'No answer']);
});
test('captured now stays fixed while pages load, including exactly WITA midnight', async t => {
  const h = harness(t, [call(1), call(2, { dateAdded: new Date(TODAY - 1).toISOString() })], url => {
    if (url.includes('/numbers/')) h.w.Date.now = () => TODAY + 10000;
  });
  h.w.Date.now = () => TODAY;
  const result = await h.run(); assert.equal(result.updatedAt, TODAY);
  assert.deepEqual(result.days.map(x => x.total).join(','), '0,1');
  assert.equal(JSON.parse(h.calls[1].init.body).endDate, new Date(TODAY).toISOString());
});
test('old settings handler cannot paint into reopened settings', async t => {
  let finish; const h = harness(t, [], url => url.includes('/numbers/') ? new Promise(resolve => { finish = resolve; }) : undefined);
  const old = await h.open(), pending = old.querySelector('[data-call-count-load]').onclick(); await tick();
  old.querySelector('[data-cancel]').click(); const current = await h.open();
  finish(inventory); await pending;
  assert.equal(current.isConnected, true); assert.equal(current.querySelector('[data-call-count-rows]').textContent, '');
  assert.equal(current.querySelector('[data-call-count-load]').disabled, false); assert.equal(h.calls.length, 1);
});
test('invalidating an old settings context is idempotent, without repeated DOM mutations', async t => {
  const h = harness(t), d = await h.open(); h.auth('u2');
  const message = d.querySelector('[data-call-count-status]').firstChild;
  h.e('invalidateOutgoingCallCounter()');
  assert.equal(d.querySelector('[data-call-count-status]').firstChild, message);
});
test('late page failure leaves UI empty, not a partial total', async t => {
  const h = harness(t, Array.from({ length: 51 }, (_, i) => call(i)), (url, init) => {
    if (url.includes('/reporting/') && JSON.parse(init.body).skip === 50) return new Response('{}', { status: 500 });
  });
  const d = await h.open(); await d.querySelector('[data-call-count-load]').onclick();
  assert.equal(d.querySelectorAll('[data-call-count-rows] tr').length, 0);
  assert.match(d.querySelector('[data-call-count-status]').textContent, /Could not load/);
});
