const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { installWebGlobals, evaluateUserscript } = require('./helpers/userscript.cjs');
const source = fs.readFileSync(path.join(__dirname, '../gohigherlevel.user.js'), 'utf8');
const locationId = '3QixdLNutDXye95tTBK0';
const now = Date.parse('2026-10-13T05:43:00Z');
const yesterday = '2026-10-12T04:15:00Z';
const task = {
  id: 'followup1', locationId, objectKey: 'task', owners: ['user1'],
  properties: { title: 'Call again Example Lead', completed: 0, dueDate: '2026-10-14T03:00:00Z' },
  relations: [{ associationId: 'TASK_CONTACT_ASSOCIATION', objectKey: 'contact', recordId: 'lead1', relationId: 'relation1' }],
};
function harness(t, rows) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: `https://go.pertamaproperty.com/v2/location/${locationId}/contacts/detail/lead1`,
    runScripts: 'outside-only', virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  t.after(() => w.close());
  installWebGlobals(w);
  w.Date.now = () => now;
  const calls = [];
  w.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/numbers/v2/')) return new Response(JSON.stringify({ numbers: [{ phoneNumber: '+15550000001', linkedUser: 'user1', capabilities: { voice: true } }], total: 1 }));
    if (url.includes('/reporting/')) return new Response(JSON.stringify({ rows, totalRows: rows.length, totalPages: rows.length ? 1 : 0 }));
    if (url.includes('/records/search')) return new Response(JSON.stringify({ customObjectRecords: [task], total: 1 }));
    return new Response(JSON.stringify({ message: 'Permission denied.', error: 'Unauthorized', statusCode: 401 }), { status: 401 });
  };
  const e = evaluateUserscript(w, source);
  const token = `x.${Buffer.from(JSON.stringify({ user_id: 'user1', sub: 'user1', locations: [locationId], exp: now / 1000 + 3600 })).toString('base64url')}.x`;
  e(`captureReadHeaders('https://services.leadconnectorhq.com/contacts/lead1', {'token-id': ${JSON.stringify(token)}})`);
  return { w, e, calls, run: () => e('runLeadAccessReport(30)') };
}
function call(id, dateAdded, userId = 'user1') {
  return { id, dateAdded, userId, contactId: 'lead1', locationId };
}

test('yesterday call date survives pending-task merge, denial, and persistence', async t => {
  const h = harness(t, [call('call1', yesterday)]);
  h.e("rememberLeadContact({ id: 'lead1', locationId: LOCATION_ID, firstName: 'Example', lastName: 'Lead' }, leadAccessContext()); flushLeadHistory()");
  const result = await h.run();
  assert.equal(result.complete, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].lastCall, Date.parse(yesterday));
  assert.equal(result.rows[0].name, 'Example Lead');
  assert.equal(result.rows[0].tasks[0].id, 'followup1');
  const history = JSON.parse(h.w.localStorage.getItem(`pertama:lead-access:${locationId}:user1`));
  assert.equal(history[0].lastCall, Date.parse(yesterday));
  h.e('leadHistories.clear()');
  assert.equal((await h.run()).rows[0].lastCall, Date.parse(yesterday));
  const request = JSON.parse(h.calls.find(c => c.url.includes('/reporting/')).init.body);
  assert.ok(Date.parse(request.startDate) < Date.parse(yesterday));
  assert.ok(Date.parse(request.endDate) > Date.parse(yesterday));
});

test('a task alone can highlight an inaccessible contact without a retrieved call', async t => {
  const h = harness(t, []);
  const result = await h.run();
  assert.equal(result.complete, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].id, 'lead1');
  assert.equal(result.rows[0].lastCall, null);
  assert.equal(result.rows[0].tasks[0].id, 'followup1');
});

test('last call uses latest own call, not response order or another caller', async t => {
  const h = harness(t, [
    call('latest-own', yesterday),
    call('older-own', '2026-10-10T06:00:00Z'),
    call('other-caller', '2026-10-13T05:00:00Z', 'user2'),
  ]);
  const result = await h.run();
  assert.equal(result.complete, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].lastCall, Date.parse(yesterday));
  assert.equal(h.calls.filter(c => c.url.includes('/contacts/')).length, 1);
});
