const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../gohigherlevel.user.js'), 'utf8');
const L = '3QixdLNutDXye95tTBK0';
const route = `/v2/location/${L}/contacts/detail/c1`;
const contact = { id: 'c1', locationId: L, firstName: 'Ada', lastName: 'Lee', phone: '+628123456789', assignedTo: 'u1' };
const opportunity = { id: 'o1', contactId: 'c1', locationId: L, pipelineId: 'p1', pipelineStageId: 's1', assignedTo: 'u1', indexVersion: 7 };
const task = { id: 'old-task', locationId: L, objectKey: 'task', properties: { title: 'Call again Ada Lee', completed: 0 },
  relations: [{ associationId: 'TASK_CONTACT_ASSOCIATION', objectKey: 'contact', recordId: 'c1', relationId: 'r1' }] };
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(t, { oldTask = true } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: `https://go.pertamaproperty.com${route}`, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const w = dom.window; t.after(() => w.close());
  for (const key of ['Request', 'Response', 'Headers', 'AbortController']) w[key] = globalThis[key];
  w.HTMLElement.prototype.getClientRects = () => [{ width: 200 }];
  const writes = [], reads = [], gates = { stage: deferred(), note: deferred(), complete: deferred(), task: deferred(), link: deferred() };
  let hook = () => {}, completed = false;
  w.alert = message => alerts.push(message);
  const alerts = [];
  w.fetch = async (url, init) => {
    const pathname = new URL(url).pathname.replace(/\/$/, ''), body = init.body && JSON.parse(init.body);
    let operation = pathname === '/opportunities/o1' && init.method === 'PUT' ? 'stage'
      : pathname === '/notes' ? 'note' : pathname.endsWith('/tasks/bulk/update') ? 'complete'
      : pathname === '/objects/task/records' ? 'task' : pathname === '/associations/relations/bulk' ? 'link' : null;
    const request = { pathname, method: init.method, body, operation, init };
    (operation ? writes : reads).push(request);
    const override = await hook(request);
    if (override !== undefined) return override instanceof Response ? override : new Response(JSON.stringify(override));
    if (operation) {
      const failure = await gates[operation].promise;
      if (failure instanceof Response) return failure;
      if (failure instanceof Error) throw failure;
      if (operation === 'stage') return new Response(JSON.stringify({ opportunity: { ...opportunity, ...body } }));
      if (operation === 'note') return new Response(JSON.stringify({ note: { id: 'n1', locationId: L, contactId: 'c1', body: body.body } }));
      if (operation === 'complete') { completed = true; return new Response(JSON.stringify({ succeded: true })); }
      if (operation === 'task') return new Response(JSON.stringify({ record: { id: 'new-task', objectKey: 'task', ...body }, errors: [] }));
      return new Response(JSON.stringify({ results: { added: body.add.map(data => ({ success: true, data })), errored: [] } }));
    }
    const data = pathname === '/contacts/c1' ? { contact }
      : pathname === '/opportunities/o1' ? { opportunity }
      : pathname === '/opportunities/search' ? { opportunities: [opportunity], total: 1 }
      : { customObjectRecords: oldTask ? [{ ...task, properties: { ...task.properties, completed: completed ? 1 : 0 } }] : [], total: oldTask ? 1 : 0 };
    return new Response(JSON.stringify(data));
  };
  w.localStorage.setItem(`pertama:pipelines:${L}`, JSON.stringify({ pipelines: [{ id: 'p1', name: 'Sales', stages: { 'Attempted Contact': 's1', 'ATC 2': 's2' } }] }));
  w.eval(source.replace(/\}\)\(\);\s*$/, 'globalThis.__concurrentTest = { evaluate(code) { return eval(code); } };\n})();'));
  const e = code => w.__concurrentTest.evaluate(code);
  const token = `x.${Buffer.from(JSON.stringify({ user_id: 'u1', sub: 'u1', locations: [L], exp: Date.now() / 1000 + 3600 })).toString('base64url')}.x`;
  e(`initializeButtons(); captureReadHeaders('https://services.leadconnectorhq.com/contacts/c1', ${JSON.stringify({ 'token-id': token })});
    pinStageQueue({ contactId: 'c1', opportunityId: 'o1', pipelineId: 'p1', stageId: 's1' });
    confirmActions = async () => ({ stage: true, targetStage: 'ATC 2', note: true, noteText: 'No answer', task: true, due: futureDate(3), sms: false });
    globalThis.__nextCalls = 0; findNextActionable = async () => { __nextCalls++; return null; };`);
  return { w, e, writes, reads, gates, alerts, run: () => e('run()'), hook: fn => { hook = fn; },
    checkpoint: () => JSON.parse(w.localStorage.getItem(`pertama:no-answer:unfinished:${L}:c1`) || 'null') };
}

for (const order of [['stage', 'note', 'complete'], ['stage', 'complete', 'note'], ['note', 'stage', 'complete'],
  ['note', 'complete', 'stage'], ['complete', 'stage', 'note'], ['complete', 'note', 'stage']]) {
  test(`independent saves overlap and retain each intent: ${order.join(', ')}`, async t => {
    const h = harness(t); const pending = h.run(); await flush();
    assert.deepEqual(h.writes.map(r => r.operation).sort(), ['complete', 'note', 'stage'], h.alerts.join('\n'));
    assert.deepEqual(Object.keys(h.checkpoint().pendingActions).sort(), ['complete', 'note', 'stage']);
    assert.equal(h.e('busy'), true);
    assert.equal(h.e('__nextCalls'), 0);
    for (const operation of order) {
      h.gates[operation].resolve(); await flush();
      assert.equal(Object.hasOwn(h.checkpoint().pendingActions, operation), false);
      if (operation === 'complete') assert.equal(h.writes.some(r => r.operation === 'task'), true);
    }
    h.gates.task.resolve(); await flush();
    assert.equal(h.writes.at(-1).operation, 'link');
    assert.match(h.checkpoint().pendingSave, /association/i);
    h.gates.link.resolve(); await pending;
    assert.equal(h.checkpoint(), null);
    assert.equal(h.e('__nextCalls'), 1);
    assert.equal(h.e('busy'), false);
    assert.deepEqual(h.alerts, []);
  });
}

for (const failed of ['stage', 'note', 'complete']) for (const reason of ['HTTP', 'malformed receipt', 'lost response', 'timeout']) {
  test(`${failed} ${reason} retains its intent and drains other dispatched saves`, async t => {
    const h = harness(t); const pending = h.run(); await flush();
    assert.equal(h.writes.length, 3);
    const response = reason === 'HTTP' ? new Response('{}', { status: 500 })
      : reason === 'malformed receipt' ? new Response('{}')
      : reason === 'timeout' ? new DOMException('Timed out', 'AbortError') : new Error('Lost response');
    h.gates[failed].resolve(response); await flush();
    assert.equal(h.e('busy'), true);
    assert.equal(h.e('__nextCalls'), 0);
    assert.equal(h.alerts.length, 0);
    for (const operation of ['stage', 'note', 'complete']) if (operation !== failed) h.gates[operation].resolve();
    await pending;
    assert.equal(h.writes.length, 3);
    assert.equal(h.e('busy'), false);
    assert.equal(h.e('contactWritesPending + stageWritesPending'), 0);
    assert.deepEqual(Object.keys(h.checkpoint().pendingActions), [failed]);
    if (failed !== 'stage') assert.match(h.checkpoint().completed.join('\n'), /Stage:.*server confirmed/);
    if (failed !== 'note') assert.match(h.checkpoint().completed.join('\n'), /Note saved/);
    if (failed !== 'complete') assert.match(h.checkpoint().completed.join('\n'), /Call task completed and verified/);
    await h.run(); assert.equal(h.writes.length, 3);
  });
}

for (const failed of ['task', 'link']) {
  test(`follow-up ${failed} failure preserves task identity and never repeats creation`, async t => {
    const h = harness(t); const pending = h.run(); await flush();
    for (const operation of ['stage', 'note', 'complete']) h.gates[operation].resolve();
    await flush();
    assert.equal(h.writes.at(-1).operation, 'task');
    if (failed === 'link') { h.gates.task.resolve(); await flush(); }
    h.gates[failed].resolve(new Error('Lost response')); await pending;
    assert.equal(h.e('__nextCalls'), 0);
    assert.ok(h.checkpoint().pendingActions.task);
    if (failed === 'link') {
      assert.ok(h.checkpoint().pendingActions.link);
      assert.match(h.checkpoint().completed.join('\n'), /Task created: new-task/);
    }
    const count = h.writes.length;
    await h.run(); assert.equal(h.writes.length, count);
  });
}

test('concurrent stage receipts retain the confirmed stage if automation changes opportunity ownership', async t => {
  const h = harness(t);
  h.hook(async r => {
    if (r.operation !== 'stage') return;
    await h.gates.stage.promise;
    return { opportunity: { ...opportunity, ...r.body, assignedTo: 'u2' } };
  });
  const pending = h.run(); await flush();
  for (const key of ['stage', 'note', 'complete', 'task', 'link']) h.gates[key].resolve();
  await pending;
  assert.deepEqual(h.alerts, []);
  assert.equal(h.e('__nextCalls'), 1);
  assert.equal(h.checkpoint(), null);
});

test('owned stage writes never make stale contact reads reusable', async t => {
  const h = harness(t); const pending = h.run(); await flush();
  await assert.rejects(h.e('readContactDetails()'), /pending|changed/i);
  for (const key of ['stage', 'note', 'complete', 'task', 'link']) h.gates[key].resolve();
  await pending;
  assert.equal(h.e('contactWritesPending'), 0);
  assert.equal(h.checkpoint(), null);
});

test('a failed save drains siblings and preserves their outcomes without navigation or retry', async t => {
  const h = harness(t); const pending = h.run(); await flush();
  assert.equal(h.writes.length, 3);
  h.gates.note.resolve(new Response('{}', { status: 500 })); await flush();
  assert.equal(h.e('busy'), true);
  assert.deepEqual(h.alerts, []);
  h.gates.complete.resolve(); await flush();
  assert.equal(h.writes.some(r => r.operation === 'task'), false, 'failure stops later dispatches');
  h.gates.stage.resolve(); await pending;
  assert.equal(h.e('busy'), false);
  assert.equal(h.e('__nextCalls'), 0);
  assert.match(h.checkpoint().completed.join('\n'), /Stage:.*server confirmed/);
  assert.match(h.checkpoint().completed.join('\n'), /Call task completed and verified/);
  assert.deepEqual(Object.keys(h.checkpoint().pendingActions), ['note']);
  await h.run(); assert.equal(h.writes.length, 3);
});

for (const change of ['external write', 'route', 'auth']) {
  test(`${change} during concurrent saves records receipts but blocks subsequent dispatch`, async t => {
    const h = harness(t); const pending = h.run(); await flush();
    assert.equal(h.writes.length, 3);
    if (change === 'external write') h.e("finishContactWrite(observeContactRequest('PUT', 'https://services.leadconnectorhq.com/contacts/c1'))");
    else if (change === 'route') h.w.history.pushState({}, '', route.replace('c1', 'c2'));
    else h.e('rejectCrmAuthorization()');
    for (const key of ['stage', 'note', 'complete']) h.gates[key].resolve();
    await pending;
    assert.equal(h.writes.length, 3);
    assert.equal(h.e('__nextCalls'), 0);
    assert.ok(h.checkpoint());
    assert.match(h.checkpoint().completed.join('\n'), /Stage:.*server confirmed/);
    assert.match(h.checkpoint().completed.join('\n'), /Note saved/);
    assert.match(h.checkpoint().completed.join('\n'), /completion accepted/);
    assert.equal(h.e('contactWritesPending + stageWritesPending'), 0);
  });
}

test('no matching old task permits follow-up creation but never completion', async t => {
  const h = harness(t, { oldTask: false }); const pending = h.run(); await flush();
  assert.deepEqual(h.writes.map(r => r.operation).sort(), ['note', 'stage', 'task']);
  for (const key of ['stage', 'note', 'task', 'link']) h.gates[key].resolve();
  await pending; assert.deepEqual(h.alerts, []);
});

test('preflight failure drains reads and sends no writes', async t => {
  const h = harness(t); const read = deferred();
  h.hook(r => r.pathname === '/opportunities/o1' ? new Response('{}', { status: 500 })
    : r.pathname === '/objects/task/records/search' ? read.promise : undefined);
  const pending = h.run(); await flush();
  assert.equal(h.e('busy'), true);
  assert.equal(h.writes.length, 0);
  read.resolve({ customObjectRecords: [], total: 0 }); await pending;
  assert.equal(h.writes.length, 0);
  assert.equal(h.checkpoint(), null);
});

test('failure to persist one lane cannot erase an already dispatched lane', async t => {
  const h = harness(t);
  const original = h.w.Storage.prototype.setItem;
  h.w.Storage.prototype.setItem = function (key, value) {
    if (key.includes('unfinished') && JSON.parse(value).pendingActions?.note) throw new Error('Storage refused');
    return original.call(this, key, value);
  };
  const pending = h.run(); await flush();
  assert.deepEqual(h.writes.map(r => r.operation), ['stage']);
  assert.match(h.checkpoint().pendingSave, /Stage/);
  assert.equal(h.e('busy'), true);
  h.w.Storage.prototype.setItem = original;
  h.gates.stage.resolve(); await pending;
  assert.equal(h.e('__nextCalls'), 0);
  assert.match(h.checkpoint().completed.join('\n'), /Stage:.*server confirmed/);
});
