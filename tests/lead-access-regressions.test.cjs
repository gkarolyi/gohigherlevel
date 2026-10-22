const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { installWebGlobals, evaluateUserscript } = require('./helpers/userscript.cjs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../gohigherlevel.user.js'), 'utf8');
const L = '3QixdLNutDXye95tTBK0', origin = 'https://services.leadconnectorhq.com';
const contact = { id: 'c1', locationId: L, firstName: 'Ada', lastName: 'Lee', phone: '+123', assignedTo: 'owner1' };
const task = (id = 't1', relations = [{ associationId: 'TASK_CONTACT_ASSOCIATION', objectKey: 'contact', recordId: 'c1', relationId: 'r1' }]) => ({
  id, locationId: L, objectKey: 'task', owners: ['u1'], relations,
  properties: { title: 'Call Ada', dueDate: '2026-10-10T03:00:00Z', completed: 0 },
});
const list = rows => ({ total: rows.length, customObjectRecords: rows });
function harness(t) {
  const dom = new JSDOM('<body><button id="opener">Open</button></body>', {
    url: `https://go.pertamaproperty.com/v2/location/${L}/contacts/detail/c1`, runScripts: 'outside-only', virtualConsole: new VirtualConsole(),
  });
  const w = dom.window; t.after(() => w.close()); installWebGlobals(w);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.XMLHttpRequest = class extends w.EventTarget {
    open() {} setRequestHeader() {} send() {}
    finish(data) { this.status = 200; this.responseText = JSON.stringify(data); this.dispatchEvent(new w.Event('loadend')); }
  };
  let handler = () => list([]); const calls = [];
  w.fetch = async (input, init) => {
    // Real fetch consumes a Request immediately. Observers must clone before dispatch.
    const url = input instanceof Request ? input.url : input;
    const raw = input instanceof Request && init?.body === undefined ? await input.text() : init?.body;
    const c = { url, init, body: raw && JSON.parse(raw) }; calls.push(c);
    const data = url.includes('/numbers/v2/') ? { numbers: [{ phoneNumber: '+15550000001', linkedUser: 'u1', capabilities: { voice: true } }], total: 1 } : await handler(c); return data instanceof Response ? data : new Response(JSON.stringify(data));
  };
  const e = evaluateUserscript(w, source);
  const token = `x.${Buffer.from(JSON.stringify({ user_id: 'u1', sub: 'u1', locations: [L], exp: Date.now() / 1000 + 3600 })).toString('base64url')}.x`;
  e(`captureReadHeaders('${origin}/contacts/c1', ${JSON.stringify({ 'token-id': token })})`);
  return { w, e, calls, handler: fn => { handler = fn; }, async flush() { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); },
    history: () => JSON.parse(e('JSON.stringify(leadHistory(leadAccessContext()))')) };
}
test('history observations use indexed contacts without scanning or serializing rows', t => {
  const h = harness(t);
  h.e(`{
    const context = leadAccessContext();
    for (let i = 0; i < 2000; i++) rememberLeadContact({ id: 'c' + i, locationId: LOCATION_ID, firstName: 'Lead', lastName: String(i) }, context);
    const rows = leadHistory(context);
    rows.find = () => { throw new Error('linear contact lookup'); };
    const stringify = JSON.stringify;
    JSON.stringify = function(value, ...args) {
      if (value && rows.includes(value)) throw new Error('serialized history row');
      return stringify.call(this, value, ...args);
    };
    try {
      rememberLeadTasks({ total: 100, customObjectRecords: Array.from({ length: 100 }, (_, i) => ({
        id: 'task' + i, locationId: LOCATION_ID, objectKey: 'task', owners: [context.user],
        properties: { title: 'Call', dueDate: '2026-10-10', completed: 0 },
        relations: [{ associationId: 'TASK_CONTACT_ASSOCIATION', objectKey: 'contact', recordId: 'c' + i, relationId: 'rel' + i }],
      })) }, context);
      if (rows.slice(0, 100).some(row => row.tasks.length !== 1)) throw new Error('task observations lost');
      completeRememberedLeadTask('c0', 'task0', context);
      if (!rows[0].tasks[0].completed) throw new Error('completion lost');
      rememberLeadContact({ id: 'c0', locationId: LOCATION_ID, firstName: 'Updated' }, context);
      if (rows[0].name !== 'Updated') throw new Error('name observation lost');
    } finally { JSON.stringify = stringify; }
  }`);
});

test('older task observations neither change history nor schedule persistence', t => {
  const h = harness(t), now = Date.now();
  h.e(`rememberLeadTask('c1', { id: 't1', title: 'Latest', due: '', completed: true, observedAt: ${now} }, leadAccessContext()); flushLeadHistory();
    rememberLeadTask('c1', { id: 't1', title: 'Old', due: '', completed: false, observedAt: ${now - 1000} }, leadAccessContext())`);
  assert.equal(h.e('leadHistoryTimer'), null);
  assert.equal(h.history()[0].tasks[0].title, 'Latest');
});

test('history index follows eviction and replacement on flush', t => {
  const h = harness(t), now = Date.now();
  h.e(`{
    const context = leadAccessContext();
    for (let i = 0; i < 2001; i++) rememberLeadTask('c' + i, { id: 't' + i, title: 'Call', due: '', completed: false, observedAt: ${now - 5000} + i }, context);
    if (leadHistory(context).length !== 2000 || leadHistory(context).some(row => row.id === 'c0')) throw new Error('oldest contact not evicted');
    flushLeadHistory();
    rememberLeadContact({ id: 'c0', locationId: LOCATION_ID, firstName: 'Returned' }, context);
    if (leadHistory(context).filter(row => row.id === 'c0').length !== 1) throw new Error('index retained evicted row');
  }`);
});

test('native Request task search is captured before original fetch consumes its body', async t => {
  const h = harness(t); h.handler(() => list([task()]));
  const request = new Request(`${origin}/objects/task/records/search`, { method: 'POST', body: JSON.stringify({ locationId: L }) });
  const response = await h.w.fetch(request); assert.equal((await response.json()).total, 1);
  await h.flush(); assert.equal(request.bodyUsed, true); assert.equal(h.history()[0]?.tasks[0]?.id, 't1');
  assert.equal(h.calls.length, 1);
});
test('native XHR task search captures owned tasks and completed readbacks', async t => {
  const h = harness(t);
  for (const completed of [0, 1]) {
    const xhr = new h.w.XMLHttpRequest(); xhr.open('POST', `${origin}/objects/task/records/search`);
    xhr.send(JSON.stringify({ locationId: L }));
    xhr.finish(list([{ ...task(), properties: { ...task().properties, completed } }]));
    await h.flush(); assert.equal(h.history()[0]?.tasks[0]?.completed, Boolean(completed));
  }
  assert.equal(h.calls.length, 0);
});
test('standalone and opportunity tasks do not invalidate contact task coverage', async t => {
  const h = harness(t);
  const rows = [task(), task('standalone', []), { ...task('other', []), owners: ['u2'] },
    task('opportunity', [{ associationId: 'TASK_OPPORTUNITY_ASSOCIATION', objectKey: 'opportunity', recordId: 'o1', relationId: 'r2' }])];
  h.handler(c => c.url.includes('/reporting/') ? { totalRows: 0, totalPages: 0, rows: [] }
    : c.url.includes('/search') ? list(rows) : new Response(JSON.stringify({ message: 'Permission denied.', error: 'Unauthorized', statusCode: 401 }), { status: 401 }));
  const result = await h.e('runLeadAccessReport()');
  assert.equal(result.complete, true); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].id, 'c1');
  assert.equal(h.history().length, 1);
});
test('duplicate standalone task IDs still invalidate pagination', async t => {
  const h = harness(t);
  h.handler(c => c.url.includes('/reporting/') ? { totalRows: 0, totalPages: 0, rows: [] } : list([task('a', []), task('a', [])]));
  const result = await h.e('runLeadAccessReport()'); assert.equal(result.complete, false); assert.match(result.warnings.join(' '), /task coverage/);
});
for (const reverse of [false, true]) test(`tab history merge preserves independent name/call/access/task observations, reverse=${reverse}`, t => {
  const h = harness(t), now = Date.now();
  const named = { id: 'c1', name: 'Ada Lee', observedAt: now - 1000, lastAccessible: now - 1000, lastCall: now - 2000, tasks: [] };
  const taskOnly = { id: 'c1', name: '', observedAt: now, lastAccessible: null, lastCall: null,
    tasks: [{ id: 't1', title: 'Call Ada', due: '2026-10-10', completed: false, observedAt: now }] };
  h.w.localStorage.setItem(`pertama:lead-access:${L}:u1`, JSON.stringify([reverse ? taskOnly : named]));
  h.e(`leadHistories.set('u1', ${JSON.stringify([reverse ? named : taskOnly])}); flushLeadHistory(); leadHistories.clear()`);
  const row = h.history()[0]; assert.equal(row.name, 'Ada Lee'); assert.equal(row.lastAccessible, named.lastAccessible);
  assert.equal(row.lastCall, named.lastCall); assert.equal(row.tasks[0].title, 'Call Ada');
});
for (const failedLink of [false, true]) test(`actual task creation remembers only confirmed links; failedLink=${failedLink}`, async t => {
  const h = harness(t);
  h.e(`workflow.startingContact = 'c1'; workflow.approvedActionContext = {
    contact:'c1', route:stageRouteRevision, user:currentUserId, epoch:contactReadEpoch,
    ownedEpoch:0, ownedWritesPending:0, stopSaves:false,
    contactRecord:${JSON.stringify(contact)}, ownerId:'owner1', taskTitle:'Call Ada', due:'2026-10-10T03:00:00.000Z', actions:{task:true}, taskId:null };`);
  h.handler(c => c.url.includes('/contacts/') ? { contact }
    : c.url.endsWith('/objects/task/records') ? { record: { ...c.body, id: 't1', objectKey: 'task' }, errors: [] }
    : { results: { added: failedLink ? [] : [{ success: true, data: c.body.add[0] }], errored: [] } });
  await h.e('readContactDetails({ fresh: true })'); // run() records this contact during preflight.
  if (failedLink) await assert.rejects(h.e('createTaskApi()'), /association/); else await h.e('createTaskApi()');
  h.e('flushLeadHistory(); leadHistories.clear()');
  assert.equal(h.history()[0].name, 'Ada Lee'); assert.equal(h.history()[0].tasks.length, failedLink ? 0 : 1);
  if (!failedLink) { assert.equal(h.history()[0].tasks[0].title, 'Call Ada'); assert.equal(h.history()[0].tasks[0].completed, false); }
  assert.deepEqual(h.calls.find(c => c.url.endsWith('/objects/task/records')).body.owners, ['owner1']);
});
test('actual internal task reads and completion acknowledgment update remembered pending status', async t => {
  const h = harness(t); let completed = 0;
  h.handler(c => c.init.method === 'PUT' ? { succeded: true } : list([{ ...task(), properties: { ...task().properties, completed } }]));
  await h.e(`crmRequest('POST', '/objects/task/records/search', {locationId:LOCATION_ID})`);
  assert.equal(h.history()[0].tasks[0].completed, false);
  completed = 1; await h.e(`crmRequest('POST', '/objects/task/records/search', {locationId:LOCATION_ID})`);
  assert.equal(h.history()[0].tasks[0].completed, true);
  completed = 0; await h.e(`crmRequest('POST', '/objects/task/records/search', {locationId:LOCATION_ID})`);
  await h.e(`putCallTask({...contactReadContext(),route:stageRouteRevision,template:settings.task}, 't1')`);
  assert.equal(h.calls.filter(c => c.init.method === 'PUT').length, 1); assert.equal(h.history()[0].tasks[0].completed, true);
});
test('report is a native modal, handles native cancel and restores focus without opening requests', t => {
  const h = harness(t), opener = h.w.document.getElementById('opener'); opener.focus(); h.e('openLeadAccessReport()');
  const dialog = h.w.document.getElementById('pertama-lead-access');
  assert.equal(dialog.tagName, 'DIALOG'); assert.equal(dialog.open, true); assert.equal(h.calls.length, 0);
  dialog.dispatchEvent(new h.w.Event('cancel', { cancelable: true }));
  assert.equal(dialog.isConnected, false); assert.equal(h.w.document.activeElement, opener);
});
test('task pagination counts non-contact rows and rejects repeated standalone pages', async t => {
  for (const repeated of [false, true]) {
    const h = harness(t), first = Array.from({ length: 100 }, (_, i) => task(`standalone${i}`, []));
    h.handler(c => c.url.includes('/reporting/') ? { totalRows: 0, totalPages: 0, rows: [] }
      : c.url.includes('/search') ? { total: 101, customObjectRecords: c.body.page === 1 ? first : repeated ? [first[0]] : [task()] }
        : new Response(JSON.stringify({ message: 'Permission denied.', error: 'Unauthorized', statusCode: 401 }), { status: 401 }));
    const result = await h.e('runLeadAccessReport()');
    assert.equal(result.complete, !repeated); assert.equal(result.rows.length, repeated ? 0 : 1);
    assert.deepEqual(h.calls.filter(c => c.url.includes('/search')).map(c => c.body.page), [1, 2]);
  }
});
test('malformed contact relations still make task coverage incomplete', async t => {
  const h = harness(t);
  h.handler(c => c.url.includes('/reporting/') ? { totalRows: 0, totalPages: 0, rows: [] }
    : list([task('broken', [{ associationId: 'TASK_CONTACT_ASSOCIATION', objectKey: 'opportunity', recordId: 'c1', relationId: 'r1' }])]));
  const result = await h.e('runLeadAccessReport()');
  assert.equal(result.complete, false); assert.equal(result.rows.length, 0); assert.match(result.warnings.join(' '), /task coverage/);
});
test('wrong-user and malformed non-attributable calls never introduce contacts', async t => {
  for (const userId of ['other', undefined]) {
    const h = harness(t);
    h.handler(c => c.url.includes('/search') ? list([]) : { totalRows: 1, totalPages: 1, rows: [{ id: 'call1', userId, assignedTo: 'u1', contactId: 'otherContact', locationId: L, dateAdded: new Date(Date.now() - 60000).toISOString() }] });
    const result = await h.e('runLeadAccessReport()');
    assert.equal(result.rows.length, 0); assert.equal(h.calls.some(c => c.url.includes('/contacts/')), false);
    assert.equal(result.complete, Boolean(userId));
  }
});
test('native modal cancellation aborts an in-flight report and restores focus', async t => {
  const h = harness(t), opener = h.w.document.getElementById('opener');
  h.handler(() => new Promise(() => {})); opener.focus(); h.e('openLeadAccessReport()');
  const dialog = h.w.document.getElementById('pertama-lead-access');
  const pending = dialog.querySelector('[data-run]').onclick(); await h.flush();
  dialog.dispatchEvent(new h.w.Event('cancel', { cancelable: true })); await pending;
  assert.equal(h.calls.at(-1).init.signal.aborted, true); assert.equal(dialog.isConnected, false);
  assert.equal(h.w.document.activeElement, opener); assert.equal(h.e('leadReportRun'), null);
});
test('report merges a later cross-tab pending task into an already loaded empty cache', async t => {
  const h = harness(t); assert.deepEqual(h.history(), []);
  h.w.localStorage.setItem(`pertama:lead-access:${L}:u1`, JSON.stringify([{ id: 'c1', name: 'Saved Ada', observedAt: Date.now(),
    lastAccessible: Date.now(), tasks: [{ id: 't1', title: 'Call Ada', due: '', completed: false, observedAt: Date.now() }] }]));
  h.handler(c => c.url.includes('/reporting/') ? { totalRows: 0, totalPages: 1, rows: [] } : c.url.includes('/search') ? list([])
    : new Response(JSON.stringify({ message: 'Permission denied.', error: 'Unauthorized', statusCode: 401 }), { status: 401 }));
  const result = await h.e('runLeadAccessReport()');
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].name, 'Saved Ada'); assert.equal(result.complete, true);
});
test('fast reports flush pending history and surface quota errors before returning Complete', async t => {
  const h = harness(t);
  const setItem = h.w.Storage.prototype.setItem;
  h.w.Storage.prototype.setItem = function (key, value) {
    if (key.startsWith('pertama:lead-access:')) throw new Error('quota'); return setItem.call(this, key, value);
  };
  h.handler(c => c.url.includes('/reporting/') ? { totalRows: 0, totalPages: 0, rows: [] } : c.url.includes('/search') ? list([task()]) : { contact });
  const result = await h.e('runLeadAccessReport()');
  assert.equal(result.complete, false); assert.match(result.warnings.join(' '), /storage unavailable/);
  assert.equal(h.e('leadHistoryTimer'), null);
});
test('passive storage failure is visible in an already open report dialog', t => {
  const h = harness(t); h.e('openLeadAccessReport()');
  h.w.Storage.prototype.setItem = () => { throw new Error('quota'); };
  h.e(`rememberLeadContact(${JSON.stringify(contact)}, leadAccessContext()); flushLeadHistory()`);
  assert.match(h.w.document.getElementById('pertama-lead-access').textContent, /storage unavailable/);
});
test('cached history expires before a later report and caps remain enforced during writes', async t => {
  const h = harness(t), now = Date.now();
  h.e(`for (let i = 0; i < 2010; i++) rememberLeadContact({id:'cap'+i,locationId:LOCATION_ID,firstName:'Ada'},leadAccessContext())`);
  assert.equal(h.history().length, 2000);
  h.e(`for (let i = 0; i < 30; i++) rememberLeadTask('c1',{id:'t'+i,title:'Call',due:'',completed:false,observedAt:Date.now()+i},leadAccessContext())`);
  assert.equal(h.history().length, 2000); assert.equal(h.history().find(row => row.id === 'c1').tasks.length, 20);
  h.w.Date.now = () => now + 181 * 86400000;
  h.e('identityExpires = Date.now()/1000 + 3600');
  h.handler(c => c.url.includes('/reporting/') ? { totalRows: 0, totalPages: 0, rows: [] } : list([]));
  const result = await h.e('runLeadAccessReport()');
  assert.equal(result.complete, true); assert.equal(result.checked, 0); assert.deepEqual(h.history(), []);
});
test('old closed report handler never closes a newly opened dialog', async t => {
  const h = harness(t); h.handler(() => new Promise(() => {}));
  h.e('openLeadAccessReport()'); const old = h.w.document.getElementById('pertama-lead-access');
  const pending = old.querySelector('[data-run]').onclick(); await h.flush();
  h.e('closeLeadAccessReport(); openLeadAccessReport()');
  const current = h.w.document.getElementById('pertama-lead-access'); assert.notEqual(current, old);
  await pending; assert.equal(current.isConnected, true); assert.equal(current.open, true);
});
for (const rejectJson of [false, true]) test(`timed-out old JSON cannot invalidate refreshed same-user auth; reject=${rejectJson}`, async t => {
  const h = harness(t); let timer, finish;
  const setTimeout = h.w.setTimeout;
  h.w.setTimeout = (fn, delay) => delay === 30000 ? (timer = fn, 9999) : setTimeout(fn, delay);
  const response = new Response('{}', { status: 401 });
  response.json = () => new Promise((resolve, reject) => { finish = () => rejectJson ? reject(Error('late bad JSON')) : resolve({}); });
  h.handler(() => response); const pending = h.e('runLeadAccessReport()'); await h.flush(); timer();
  assert.equal((await pending).complete, false);
  const token = `x.${Buffer.from(JSON.stringify({ user_id: 'u1', sub: 'u1', locations: [L], exp: Date.now() / 1000 + 7200 })).toString('base64url')}.x`;
  h.e(`captureReadHeaders('${origin}/contacts/c1', ${JSON.stringify({ 'token-id': token })})`);
  finish(); await h.flush(); assert.equal(h.e('currentUserId'), 'u1');
});
test('100-task capture does not repeatedly normalize an entire full contact history', async t => {
  const h = harness(t), now = Date.now();
  const saved = Array.from({ length: 2000 }, (_, i) => ({ id: `c${i}`, name: 'Saved', observedAt: now,
    tasks: Array.from({ length: 20 }, (_, j) => ({ id: `old${j}`, title: 'Call', completed: false, observedAt: now, due: '' })) }));
  h.w.localStorage.setItem(`pertama:lead-access:${L}:u1`, JSON.stringify(saved)); h.history();
  h.e('globalThis.boundCalls = 0; const originalBoundHistory = boundedLeadHistory; boundedLeadHistory = rows => { globalThis.boundCalls++; return originalBoundHistory(rows); }');
  const rows = Array.from({ length: 100 }, (_, i) => task(`new${i}`, [{ associationId: 'TASK_CONTACT_ASSOCIATION', objectKey: 'contact', recordId: `c${i}`, relationId: `r${i}` }]));
  h.handler(() => list(rows)); await h.w.fetch(`${origin}/objects/task/records/search`, { method: 'POST', body: JSON.stringify({ locationId: L }) }); await h.flush();
  assert.ok(h.e('boundCalls') <= 2, `full-history normalizations: ${h.e('boundCalls')}`);
  const history = h.history(); assert.equal(history.length, 2000); assert.ok(history.every(row => row.tasks.length <= 20));
  assert.ok(history.find(row => row.id === 'c0').tasks.some(t => t.id === 'new0'));
});
for (const completion of ['ack', 'read']) for (const sameTick of [false, true]) test(`older native pending response cannot undo ${completion} completion; sameTick=${sameTick}`, async t => {
  const h = harness(t); let now = Date.now(), finish;
  h.w.Date.now = () => now;
  h.handler(() => list([task()]));
  await h.e(`crmRequest('POST', '/objects/task/records/search', {locationId:LOCATION_ID})`);
  h.handler(() => new Promise(resolve => { finish = resolve; }));
  const old = h.w.fetch(`${origin}/objects/task/records/search`, { method: 'POST', body: JSON.stringify({ locationId: L }) });
  await h.flush(); if (!sameTick) now += 100;
  h.handler(c => c.init.method === 'PUT' ? { succeded: true } : list([{ ...task(), properties: { ...task().properties, completed: 1 } }]));
  if (completion === 'ack') await h.e(`putCallTask({...contactReadContext(),route:stageRouteRevision,template:settings.task}, 't1')`);
  else await h.e(`crmRequest('POST', '/objects/task/records/search', {locationId:LOCATION_ID})`);
  assert.equal(h.history()[0].tasks[0].completed, true);
  now += 100; finish(list([task()])); await old; await h.flush();
  assert.equal(h.history()[0].tasks[0].completed, true);
  h.e('flushLeadHistory(); leadHistories.clear()'); assert.equal(h.history()[0].tasks[0].completed, true);
  now += 100; h.handler(() => list([task()]));
  await h.e(`crmRequest('POST', '/objects/task/records/search', {locationId:LOCATION_ID})`);
  assert.equal(h.history()[0].tasks[0].completed, false, 'a genuinely newer pending read may reopen the task');
});
for (const sameTick of [false, true]) for (const storedCompleted of [false, true]) test(`cross-tab merge keeps newer/equal completion; sameTick=${sameTick}, storedCompleted=${storedCompleted}`, t => {
  const h = harness(t), now = Date.now();
  const row = completed => ({ id: 'c1', name: 'Ada', observedAt: now, tasks: [{ id: 't1', title: 'Call', due: '', completed,
    observedAt: completed || sameTick ? now : now - 100 }] });
  h.w.localStorage.setItem(`pertama:lead-access:${L}:u1`, JSON.stringify([row(storedCompleted)]));
  h.e(`leadHistories.set('u1', ${JSON.stringify([row(!storedCompleted)])}); flushLeadHistory(); leadHistories.clear()`);
  assert.equal(h.history()[0].tasks[0].completed, true);
});
test('empty calls may legitimately report one total page', async t => {
  const h = harness(t); h.handler(c => c.url.includes('/reporting/') ? { totalRows: 0, totalPages: 1, rows: [] } : list([]));
  const result = await h.e('runLeadAccessReport()'); assert.equal(result.complete, true); assert.equal(result.rows.length, 0);
});
