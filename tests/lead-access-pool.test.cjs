const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { installWebGlobals, evaluateUserscript } = require('./helpers/userscript.cjs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../gohigherlevel.user.js'), 'utf8');
const L = '3QixdLNutDXye95tTBK0';
const own = (phoneNumber = '+15550000001') => ({ phoneNumber, linkedUser: 'u1', capabilities: { voice: true, sms: false } });
const numbers = [own(), own('+15550000002'), { ...own('+15550000003'), linkedUser: 'u2', default: true },
  { ...own('+15550000004'), linkedUser: null, ringAll: true }, { ...own('+15550000005'), capabilities: { voice: false, sms: true } }];
const yesterday = Date.now() - 86400000;
function harness(t, inventory = { numbers, total: numbers.length }, paginated = false) {
  const dom = new JSDOM('<body></body>', { url: `https://go.pertamaproperty.com/v2/location/${L}/contacts`, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const w = dom.window; t.after(() => w.close()); installWebGlobals(w);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const calls = [];
  w.fetch = async (url, init) => {
    calls.push({ url, init }); let data;
    if (url.includes('/numbers/v2/')) data = typeof inventory === 'function' ? await inventory() : inventory;
    else if (url.includes('/reporting/')) {
      const body = JSON.parse(init.body);
      const all = Array.from({ length: paginated ? 51 : 1 }, (_, i) => ({ id: `call${i}`, contactId: 'c1', userId: i === 1 ? 'u2' : 'u1', locationId: L, dateAdded: new Date(i === 1 ? Date.now() - 1000 : yesterday).toISOString() }));
      data = body.selectedPool.length && body.userId === '' ? { rows: all.slice(body.skip, body.skip + 50), totalRows: all.length, totalPages: paginated ? 2 : 1 } : { rows: [], totalRows: 0, totalPages: 0 };
    } else if (url.includes('/search')) data = { total: 1, customObjectRecords: [{ id: 't1', objectKey: 'task', locationId: L, owners: ['u1'], properties: { completed: 0, title: 'Follow up', dueDate: '2026-10-14T03:00:00Z' }, relations: [{ associationId: 'TASK_CONTACT_ASSOCIATION', objectKey: 'contact', recordId: 'c1', relationId: 'r1' }] }] };
    else return new Response(JSON.stringify({ message: 'Permission denied.', error: 'Unauthorized', statusCode: 401 }), { status: 401 });
    return data instanceof Response ? data : new Response(JSON.stringify(data));
  };
  const e = evaluateUserscript(w, source);
  function auth(user = 'u1') { const token = `x.${Buffer.from(JSON.stringify({ user_id: user, sub: user, locations: [L], exp: Date.now() / 1000 + 3600 })).toString('base64url')}.x`; e(`captureReadHeaders('https://services.leadconnectorhq.com/contacts/c1', {'token-id': ${JSON.stringify(token)}})`); }
  auth(); return { w, e, calls, auth, run: () => e('runLeadAccessReport(30)') };
}
for (const paginated of [false, true]) test(`native selected pool recovers yesterday call with pending task; pagination=${paginated}`, async t => {
  const h = harness(t, undefined, paginated);
  h.e('openLeadAccessReport()'); assert.equal(h.calls.length, 0);
  const result = await h.run();
  assert.equal(result.rows[0].lastCall, yesterday);
  assert.equal(result.rows[0].tasks[0].id, 't1'); assert.equal(result.complete, true);
  const inventory = h.calls[0];
  assert.equal(inventory.url, `https://services.leadconnectorhq.com/phone-system/numbers/v2/location/${L}?includeRcsSenderIds=true`);
  assert.equal(inventory.init.method, 'GET'); assert.equal(inventory.init.body, undefined);
  assert.equal(inventory.init.headers.version, '2021-07-28'); assert.equal(inventory.init.headers.source, 'WEB_USER'); assert.equal(inventory.init.headers.channel, 'APP');
  const requests = h.calls.filter(c => c.url.includes('/reporting/'));
  assert.equal(requests.length, paginated ? 3 : 2);
  for (const request of requests) { const body = JSON.parse(request.init.body); assert.deepEqual(body.selectedPool, ['+15550000001', '+15550000002']); assert.equal(body.userId, ''); assert.equal(request.init.headers.version, '2021-04-15'); }
  assert.doesNotMatch(h.w.localStorage.getItem(`pertama:lead-access:${L}:u1`), /1555000/);
});
test('unassigned number with omitted linkedUser does not block own call history', async t => {
  const unassigned = { phoneNumber: '+15550000006', capabilities: { voice: true, sms: true } };
  const h = harness(t, { numbers: [unassigned, own()], total: 2 });
  const result = await h.run();
  assert.equal(result.complete, true, result.warnings.join(' '));
  assert.equal(result.rows[0].lastCall, yesterday);
  const requests = h.calls.filter(c => c.url.includes('/reporting/'));
  assert.equal(requests.length, 2);
  for (const request of requests) assert.deepEqual(JSON.parse(request.init.body).selectedPool, ['+15550000001']);
});
for (const inventory of [ { numbers: [], total: 0 }, { numbers: [own()], total: 2 }, { numbers: [own(), own()], total: 2 }, { numbers: [own()], total: '1' }, {}, { numbers: [{ ...own(), linkedUser: {} }], total: 1 }, { numbers: [{ ...own(), phoneNumber: 'unsafe' }], total: 1 }, { numbers: [{ ...own(), capabilities: { voice: 'true' } }], total: 1 }, new Response('{}', { status: 500 }) ]) test(`unavailable or invalid inventory keeps tasks but not clean call coverage: ${JSON.stringify(inventory)}`, async t => {
  const h = harness(t, inventory); const result = await h.run();
  assert.equal(result.complete, false); assert.match(result.warnings.join(' '), /Incomplete call coverage/);
  assert.equal(result.rows[0].tasks[0].id, 't1'); assert.equal(h.calls.filter(c => c.url.includes('/reporting/')).length, 0);
});
for (const mode of ['cancel', 'user']) test(`inventory resolving after ${mode} cannot dispatch calls`, async t => {
  let resolve; const h = harness(t, () => new Promise(r => { resolve = r; })); const pending = h.run();
  await new Promise(r => setImmediate(r));
  if (mode === 'cancel') h.e('cancelLeadAccessReport()'); else h.auth('u2');
  resolve({ numbers, total: numbers.length }); const result = await pending;
  assert.equal(result.complete, false); assert.equal(result.rows.length, 0); assert.equal(h.calls.length, 1);
});
test('inventory authorization failure aborts instead of checking tasks', async t => {
  const h = harness(t, new Response('{}', { status: 401 })); const result = await h.run();
  assert.equal(result.complete, false); assert.equal(result.rows.length, 0); assert.equal(h.calls.length, 1);
});
