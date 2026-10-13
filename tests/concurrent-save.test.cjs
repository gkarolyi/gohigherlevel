const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { installWebGlobals, evaluateUserscript } = require('./helpers/userscript.cjs');
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
  installWebGlobals(w);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
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
  const e = evaluateUserscript(w, source);
  const token = `x.${Buffer.from(JSON.stringify({ user_id: 'u1', sub: 'u1', locations: [L], exp: Date.now() / 1000 + 3600 })).toString('base64url')}.x`;
  e(`initializeButtons(); captureReadHeaders('https://services.leadconnectorhq.com/contacts/c1', ${JSON.stringify({ 'token-id': token })});
    pinStageQueue({ contactId: 'c1', opportunityId: 'o1', pipelineId: 'p1', stageId: 's1' });
    confirmActions = async (context, accept) => { const choices = { stage: true, targetStage: 'ATC 2', note: true, noteText: 'No answer', task: true, due: futureDate(3), sms: false }; accept(choices); return choices; };
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
    assert.equal(h.e('workflow.busy'), true);
    assert.equal(h.e('__nextCalls'), 0);
    const row = key => h.w.document.querySelector(`[data-action="${key}"]`);
    assert.equal(row('task').dataset.state, 'waiting');
    for (const key of order) assert.equal(row(key).dataset.state, 'running');
    for (const operation of order) {
      h.gates[operation].resolve(); await flush();
      assert.equal(Object.hasOwn(h.checkpoint().pendingActions, operation), false);
      assert.equal(row(operation).dataset.state, 'confirmed');
      if (operation === 'complete') assert.equal(h.writes.some(r => r.operation === 'task'), true);
    }
    h.gates.task.resolve(); await flush();
    assert.equal(h.writes.at(-1).operation, 'link');
    assert.match(h.checkpoint().pendingSave, /association/i);
    assert.equal(row('task').dataset.state, 'running');
    assert.match(row('task').textContent, /Linking/);
    h.gates.link.resolve(); await pending;
    assert.equal(h.checkpoint(), null);
    assert.equal(h.w.document.querySelector('#pertama-save-progress'), null);
    assert.equal(h.e('__nextCalls'), 1);
    assert.equal(h.e('workflow.busy'), false);
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
    assert.equal(h.e('workflow.busy'), true);
    assert.equal(h.e('__nextCalls'), 0);
    assert.equal(h.alerts.length, 0);
    const d = h.w.document.querySelector('#pertama-save-progress');
    assert.equal(d.querySelector(`[data-action="${failed}"]`).dataset.state, 'unverified');
    assert.equal(d.querySelector('[data-close]').hidden, true);
    for (const operation of ['stage', 'note', 'complete']) if (operation !== failed) h.gates[operation].resolve();
    await pending;
    assert.equal(h.writes.length, 3);
    assert.equal(d.querySelector('[data-close]').hidden, false);
    assert.equal(d.querySelector('[data-action="task"]').dataset.state, 'blocked');
    assert.equal(h.e('workflow.busy'), false);
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

test('progress SMS waits for saves and retains accepted receipt after continuation failure', async t => {
  const h = harness(t), sms = deferred();
  h.w.__contact = contact;
  h.e(`confirmActions = async (context, accept) => {
    const choices = { stage: true, targetStage: 'ATC 2', note: true, noteText: 'No answer', task: true, due: futureDate(3), sms: true,
      smsFrom: '+15555550101', smsTo: '+628123456789', smsText: 'Approved message' };
    accept(choices); return choices;
  }; prepareSmsApi = async () => ({ contact: __contact, from: '+15555550101', to: '+628123456789' });`);
  h.hook(r => r.pathname === '/conversations/messages/spam/v2' ? { isSpam: false }
    : r.pathname === '/conversations/messages' ? sms.promise : undefined);
  const pending = h.run(); await flush();
  const d = h.w.document.querySelector('#pertama-save-progress'), row = d.querySelector('[data-action="sms"]');
  assert.equal(row.dataset.state, 'waiting');
  assert.equal(h.reads.some(r => r.pathname === '/conversations/messages'), false);
  for (const key of ['stage', 'note', 'complete', 'task', 'link']) h.gates[key].resolve();
  await flush(); await flush();
  assert.equal(row.dataset.state, 'running');
  h.e('rejectCrmAuthorization()');
  sms.resolve({ conversationId: 'conv1', messageId: 'msg1' }); await pending;
  assert.equal(row.dataset.state, 'confirmed');
  assert.match(row.textContent, /Accepted by CRM; delivery not confirmed/);
  assert.equal(d.querySelector('[data-close]').hidden, false);
  assert.equal(h.e('__nextCalls'), 0);
  assert.deepEqual(h.alerts, []);
});

for (const failure of [false, true]) test(`progress navigation settles without extra clicks: failure=${failure}`, async t => {
  const h = harness(t), navigation = deferred();
  h.w.__navigation = navigation.promise;
  h.e(`findNextActionable = async () => ({ contactId: 'c2' }); openLead = async (lead, committed) => { await __navigation; committed(); };`);
  const pending = h.run(); await flush();
  for (const key of ['stage', 'note', 'complete', 'task', 'link']) h.gates[key].resolve();
  await flush(); await flush();
  const d = h.w.document.querySelector('#pertama-save-progress');
  assert.equal(d.querySelector('h2').textContent, 'Opening next lead…');
  assert.equal(d.querySelector('[data-close]').hidden, true);
  for (const key of ['stage', 'note', 'complete', 'task']) assert.equal(d.querySelector(`[data-action="${key}"]`).dataset.state, 'confirmed');
  if (failure) navigation.reject(new Error('Navigation failed')); else navigation.resolve();
  await pending;
  assert.equal(d.isConnected, failure);
  if (failure) {
    assert.match(d.querySelector('[data-report]').textContent, /Opening next lead/);
    assert.equal(d.querySelector('[data-close]').hidden, false);
  }
});

test('full-page navigation keeps progress modal open until the old document unloads', async t => {
  const h = harness(t), navigationErrors = [];
  h.w._virtualConsole.on('jsdomError', error => navigationErrors.push(error));
  h.e(`findNextActionable = async () => ({ contactId: 'c2' });`);
  const pending = h.run(); await flush();
  const d = h.w.document.querySelector('#pertama-save-progress');
  for (const key of ['stage', 'note', 'complete', 'task', 'link']) h.gates[key].resolve();
  await pending;
  assert.equal(navigationErrors.length, 1);
  assert.match(navigationErrors[0].message, /Not implemented: navigation/);
  assert.equal(h.w.location.pathname, route);
  assert.equal(h.writes.length, 5);
  assert.equal(h.checkpoint(), null);
  assert.deepEqual(h.alerts, []);
  assert.equal(d.isConnected, true);
  assert.equal(d.open, true);
  assert.equal(d.querySelector('h2').textContent, 'Opening next lead…');
  assert.equal(d.querySelector('[data-close]').hidden, true);
  for (const key of ['stage', 'note', 'complete', 'task']) assert.equal(d.querySelector(`[data-action="${key}"]`).dataset.state, 'confirmed');
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
  assert.equal(h.e('workflow.busy'), true);
  assert.deepEqual(h.alerts, []);
  h.gates.complete.resolve(); await flush();
  assert.equal(h.writes.some(r => r.operation === 'task'), false, 'failure stops later dispatches');
  h.gates.stage.resolve(); await pending;
  assert.equal(h.e('workflow.busy'), false);
  assert.equal(h.e('__nextCalls'), 0);
  assert.match(h.checkpoint().completed.join('\n'), /Stage:.*server confirmed/);
  assert.match(h.checkpoint().completed.join('\n'), /Call task completed and verified/);
  assert.deepEqual(Object.keys(h.checkpoint().pendingActions), ['note']);
  assert.deepEqual(JSON.parse(h.e('JSON.stringify(workflow.completed)')), h.checkpoint().completed);
  assert.deepEqual(JSON.parse(h.e('JSON.stringify(workflow.pendingActions)')), h.checkpoint().pendingActions);
  assert.equal(h.e('workflow.pendingSave'), h.checkpoint().pendingSave);
  assert.equal(h.e('workflow.startingContact'), 'c1');
  assert.equal(h.e('workflow.step'), 'Saving selected actions concurrently…');
  assert.deepEqual(JSON.parse(h.e('JSON.stringify([workflow.busy, workflow.activeSaveProgress, workflow.guardedContact, workflow.guardedStageQueue, workflow.approvedActionContext])')), [false, null, null, null, null]);
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
    const d = h.w.document.querySelector('#pertama-save-progress');
    for (const key of ['stage', 'note']) assert.equal(d.querySelector(`[data-action="${key}"]`).dataset.state, 'confirmed');
    assert.equal(d.querySelector('[data-action="complete"]').dataset.state, 'unverified');
    assert.equal(d.querySelector('[data-action="task"]').dataset.state, 'blocked');
    assert.equal(h.e('contactWritesPending + stageWritesPending'), 0);
  });
}

test('no matching old task permits follow-up creation but never completion', async t => {
  const h = harness(t, { oldTask: false }); const pending = h.run(); await flush();
  assert.deepEqual(h.writes.map(r => r.operation).sort(), ['note', 'stage', 'task']);
  assert.equal(h.w.document.querySelector('[data-action="complete"]'), null);
  for (const key of ['stage', 'note', 'task', 'link']) h.gates[key].resolve();
  await pending; assert.deepEqual(h.alerts, []);
});

for (const version of [undefined, null]) test(`concurrent saves accept ${String(version)} opportunity version at preflight`, async t => {
  const h = harness(t);
  h.hook(r => r.pathname === '/opportunities/o1' && r.method === 'GET'
    ? { opportunity: { ...opportunity, indexVersion: version } } : undefined);
  const pending = h.run(); await flush();
  assert.deepEqual(h.writes.map(r => r.operation).sort(), ['complete', 'note', 'stage']);
  assert.equal(h.writes.find(r => r.operation === 'stage').body.indexVersion, 1);
  for (const key of ['stage', 'note', 'complete', 'task', 'link']) h.gates[key].resolve();
  await pending;
  assert.equal(h.e('__nextCalls'), 1);
  assert.equal(h.checkpoint(), null);
  assert.deepEqual(h.alerts, []);
  assert.equal(h.w.document.querySelector('#pertama-save-progress'), null);
});

test('preflight failure drains reads and sends no writes', async t => {
  const h = harness(t); const read = deferred();
  h.hook(r => r.pathname === '/opportunities/o1' ? new Response('{}', { status: 500 })
    : r.pathname === '/objects/task/records/search' ? read.promise : undefined);
  const pending = h.run(); await flush();
  assert.equal(h.e('workflow.busy'), true);
  assert.equal(h.writes.length, 0);
  read.resolve({ customObjectRecords: [], total: 0 }); await pending;
  assert.equal(h.writes.length, 0);
  assert.equal(h.checkpoint(), null);
  assert.deepEqual(h.alerts, []);
  assert.equal(h.w.document.querySelector('[data-action="stage"]').dataset.state, 'blocked');
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
  assert.deepEqual(Object.keys(h.checkpoint().pendingActions), ['stage']);
  assert.deepEqual(JSON.parse(h.e('JSON.stringify(workflow.pendingActions)')), h.checkpoint().pendingActions);
  assert.equal(h.e('workflow.pendingSave'), h.checkpoint().pendingSave);
  assert.equal(h.e('workflow.approvedActionContext.stopSaves'), true);
  assert.deepEqual(h.checkpoint().completed, []);
  assert.equal(h.writes[0].body.pipelineStageId, 's2');
  assert.equal(h.e('workflow.busy'), true);
  h.w.Storage.prototype.setItem = original;
  h.gates.stage.resolve(); await pending;
  assert.equal(h.e('__nextCalls'), 0);
  assert.match(h.checkpoint().completed.join('\n'), /Stage:.*server confirmed/);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.checkpoint().pendingActions, {});
  assert.equal(h.checkpoint().pendingSave, '');
  const d = h.w.document.querySelector('#pertama-save-progress');
  assert.equal(d.querySelector('[data-action="stage"]').dataset.state, 'confirmed');
  assert.equal(d.querySelector('[data-action="note"]').dataset.state, 'failed');
  assert.equal(d.querySelector('[data-action="task"]').dataset.state, 'blocked');
});
