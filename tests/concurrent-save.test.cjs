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
    confirmActions = async (context, accept) => { const choices = { stage: true, targetStage: 'ATC 2', note: true, noteText: 'No answer', task: true, due: futureDate(3) + 'T03:00:00.000Z', sms: false }; accept(choices); return choices; };
    globalThis.__nextCalls = 0; findNextActionable = async () => { __nextCalls++; return null; };`);
  return { w, e, writes, reads, gates, alerts, run: () => e('run()'), hook: fn => { hook = fn; },
    checkpoint: () => JSON.parse(w.localStorage.getItem(`pertama:no-answer:unfinished:${L}:c1`) || 'null') };
}

for (const field of ['assignedTo', 'firstName', 'lastName', 'phone']) for (const atRead of [2, 3]) {
  test(`production preflight rejects changed ${field} at contact read ${atRead}`, async t => {
    const h = harness(t); let reads = 0;
    for (const gate of Object.values(h.gates)) gate.resolve();
    h.hook(r => r.pathname === '/contacts/c1' && ++reads >= atRead
      ? { contact: { ...contact, [field]: 'changed' } } : undefined);
    await h.run();
    assert.equal(h.writes.length, 0);
    assert.equal(h.e('__nextCalls'), 0);
    assert.match(h.w.document.body.textContent, /Contact.*changed/i);
  });
}

for (const [operation, description] of [['note', 'New note'], ['stage', 'Changed stage'], ['stage', null]]) {
  test(`journal.setPending storage failure restores prior state and evidence: ${operation}=${description}`, t => {
    const h = harness(t);
    h.e(`workflow.startingContact = 'c1'; workflow.approvedActionContext = { stopSaves: false };
      journal.restore({ completed: ['Prior confirmation'], pendingSave: 'Prior uncertainty', pendingActions: { stage: 'Prior stage' } });
      journal.save();`);
    const saved = h.checkpoint(), evidence = h.e('journal.completed');
    h.w.Storage.prototype.setItem = () => { throw new Error('Storage refused'); };
    assert.throws(() => h.e(`journal.setPending(${JSON.stringify(operation)}, ${JSON.stringify(description)})`));
    assert.equal(h.e('journal.completed'), evidence);
    assert.deepEqual(JSON.parse(h.e('JSON.stringify(journal.completed)')), saved.completed);
    assert.deepEqual(JSON.parse(h.e('JSON.stringify(journal.pendingActions)')), saved.pendingActions);
    assert.equal(h.e('journal.pendingSave'), saved.pendingSave);
    assert.deepEqual(h.checkpoint(), saved);
    assert.equal(h.e('workflow.approvedActionContext.stopSaves'), true);
    assert.equal(h.writes.length, 0);
  });
}

test('journal.clearSummary storage failure retains the unresolved summary and evidence', t => {
  const h = harness(t);
  h.e(`workflow.startingContact = 'c1';
    journal.restore({ completed: ['SMS accepted'], pendingSave: 'Continuation unresolved', pendingActions: { note: 'Prior note' } });
    journal.save();`);
  const saved = h.checkpoint(), evidence = h.e('journal.completed'), actions = h.e('journal.pendingActions');
  h.w.Storage.prototype.setItem = () => { throw new Error('Storage refused'); };
  assert.throws(() => h.e('journal.clearSummary()'));
  assert.equal(h.e('journal.pendingSave'), saved.pendingSave);
  assert.equal(h.e('journal.completed'), evidence);
  assert.equal(h.e('journal.pendingActions'), actions);
  assert.deepEqual(JSON.parse(h.e('JSON.stringify(journal.completed)')), saved.completed);
  assert.deepEqual(JSON.parse(h.e('JSON.stringify(journal.pendingActions)')), saved.pendingActions);
  assert.deepEqual(h.checkpoint(), saved);
});

test('journal.reset clears in-memory state without changing stored evidence or starting contact', t => {
  const h = harness(t);
  h.e(`workflow.startingContact = 'c1';
    journal.restore({ completed: ['Prior confirmation'], pendingSave: 'Prior uncertainty', pendingActions: { note: 'Prior note' } });
    journal.save();`);
  const saved = h.w.localStorage.getItem(`pertama:no-answer:unfinished:${L}:c1`);
  h.w.Storage.prototype.setItem = h.w.Storage.prototype.removeItem = h.w.Storage.prototype.clear = () => {
    assert.fail('journal.reset must not mutate storage');
  };
  h.e('journal.reset()');
  assert.deepEqual(JSON.parse(h.e('JSON.stringify(journal.completed)')), []);
  assert.equal(h.e('journal.pendingSave'), '');
  assert.deepEqual(JSON.parse(h.e('JSON.stringify(journal.pendingActions)')), {});
  assert.equal(h.e('workflow.startingContact'), 'c1');
  assert.equal(h.w.localStorage.getItem(`pertama:no-answer:unfinished:${L}:c1`), saved);
});

test('production workflow restores an unfinished journal before any request or evidence reset', async t => {
  const h = harness(t), saved = { completed: ['Prior confirmation'], pendingSave: 'Prior uncertainty',
    pendingActions: { note: 'Prior note' }, time: new Date().toISOString() };
  h.w.localStorage.setItem(`pertama:no-answer:unfinished:${L}:c1`, JSON.stringify(saved));
  await h.run();
  assert.deepEqual(h.checkpoint(), saved);
  assert.equal(h.reads.length + h.writes.length, 0);
  assert.deepEqual(JSON.parse(h.e('JSON.stringify(journal.completed)')), saved.completed);
  assert.equal(h.e('journal.pendingSave'), saved.pendingSave);
  assert.equal(h.e('workflow.busy'), false);
  assert.match(h.alerts.join('\n'), /Repeat run blocked/);
});

test('production checkpoint removal failure retains completion receipts and blocks a repeated run', async t => {
  const h = harness(t); let beforeRemoval;
  h.w.Storage.prototype.removeItem = function (key) {
    if (key.includes('unfinished')) { beforeRemoval = h.checkpoint(); throw new Error('Storage refused'); }
  };
  for (const gate of Object.values(h.gates)) gate.resolve();
  await h.run();
  assert.ok(beforeRemoval);
  assert.match(beforeRemoval.completed.join('\n'), /Call task completion accepted/);
  assert.match(beforeRemoval.completed.join('\n'), /Call task completed and verified/);
  assert.equal(beforeRemoval.pendingSave, '');
  assert.deepEqual(h.checkpoint(), beforeRemoval);
  assert.equal(h.e('__nextCalls'), 0);
  const count = h.writes.length;
  await h.run();
  assert.equal(h.writes.length, count);
  assert.deepEqual(h.checkpoint(), beforeRemoval);
});

for (const ack of [{ succeded: false }, { success: true }, { succeded: 'true' }, null]) {
  test(`production malformed completion acknowledgment cannot be retried: ${JSON.stringify(ack)}`, async t => {
    const h = harness(t);
    h.hook(r => r.operation === 'complete' ? new Response(JSON.stringify(ack)) : undefined);
    for (const gate of Object.values(h.gates)) gate.resolve();
    await h.run();
    assert.match(h.checkpoint().pendingActions.complete, /old-task/);
    assert.doesNotMatch(h.checkpoint().completed.join('\n'), /Call task completion accepted|Call task completed and verified/);
    assert.equal(h.e('__nextCalls'), 0);
    await h.run();
    assert.equal(h.writes.filter(r => r.operation === 'complete').length, 1);
  });
}

test('production busy ownership blocks a second run while completion is in flight', async t => {
  const h = harness(t), pending = h.run(); await flush();
  assert.equal(h.writes.filter(r => r.operation === 'complete').length, 1);
  await h.run();
  assert.equal(h.writes.filter(r => r.operation === 'complete').length, 1);
  for (const gate of Object.values(h.gates)) gate.resolve();
  await pending;
  assert.equal(h.checkpoint(), null);
});

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
    const choices = { stage: true, targetStage: 'ATC 2', note: true, noteText: 'No answer', task: true, due: futureDate(3) + 'T03:00:00.000Z', sms: true,
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
  assert.equal(h.checkpoint(), null, 'verified actions must clear their block before navigation settles');
  if (failure) navigation.reject(new Error('Navigation failed')); else navigation.resolve();
  await pending;
  assert.equal(h.checkpoint(), null, 'navigation failure must not restore a completed contact block');
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
  assert.deepEqual(JSON.parse(h.e('JSON.stringify(journal.completed)')), h.checkpoint().completed);
  assert.deepEqual(JSON.parse(h.e('JSON.stringify(journal.pendingActions)')), h.checkpoint().pendingActions);
  assert.equal(h.e('journal.pendingSave'), h.checkpoint().pendingSave);
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
  const completion = h.w.document.querySelector('[data-action="complete"]');
  assert.equal(completion.dataset.state, 'skipped');
  assert.equal(completion.querySelector('small').textContent, 'Skipped');
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
  assert.deepEqual(JSON.parse(h.e('JSON.stringify(journal.pendingActions)')), h.checkpoint().pendingActions);
  assert.equal(h.e('journal.pendingSave'), h.checkpoint().pendingSave);
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

for (const failure of ['complete', 'task', 'link']) {
  test(`Skip stops after ${failure} failure`, async t => {
    const h = harness(t);
    for (const [operation, gate] of Object.entries(h.gates)) gate.resolve(operation === failure ? new Error('Save failed') : undefined);
    const pending = h.e("run('skip')");
    assert.equal(h.e('runButton.disabled'), true);
    assert.equal(h.e('skipButton.disabled'), true);
    await pending;
    assert.equal(h.e('runButton.disabled'), false);
    assert.equal(h.e('skipButton.disabled'), false);
    assert.equal(h.e('__nextCalls'), 0);
    assert.ok(h.checkpoint());
    assert.equal(h.w.document.querySelector('#pertama-save-progress h2').textContent, 'Execution stopped');
    assert.match(h.w.document.querySelector('[data-report]').textContent, /No automatic retry/);
    if (failure === 'complete') assert.equal(h.writes.some(r => r.operation === 'task'), false);
    assert.equal(h.writes.some(r => ['stage', 'note'].includes(r.operation)), false);
  });
}

test('Skip shares the busy lock with Save and next', async t => {
  const h = harness(t);
  const pending = h.run();
  for (let i = 0; i < 30; i++) await flush();
  const count = h.writes.length;
  await h.e("run('skip')");
  assert.equal(h.writes.length, count);
  for (const gate of Object.values(h.gates)) gate.resolve();
  await pending;
});

for (const oldTask of [true, false]) {
  test(`Skip postpones follow-up with existing task=${oldTask}`, async t => {
    const h = harness(t, { oldTask });
    h.e("confirmActions = async () => { throw new Error('Skip must not confirm'); }");
    const before = Date.now();
    h.w.Date.now = () => before;
    const pending = h.e("run('skip')");
    for (let i = 0; i < 30; i++) await flush();
    assert.deepEqual(h.writes.map(r => r.operation), [oldTask ? 'complete' : 'task']);
    assert.equal(h.e('__nextCalls'), 0);
    if (oldTask) h.gates.complete.resolve();
    for (let i = 0; i < 30; i++) await flush();
    const request = h.writes.find(r => r.operation === 'task');
    assert.ok(request);
    const due = Date.parse(request.body.properties.dueDate);
    assert.equal(due, before + 3 * 3600000);
    assert.deepEqual(request.body.owners, ['u1']);
    assert.equal(request.body.properties.title, 'Call again Ada Lee');
    h.gates.task.resolve();
    for (let i = 0; i < 30; i++) await flush();
    h.gates.link.resolve();
    await pending;
    assert.deepEqual(h.writes.map(r => r.operation), oldTask ? ['complete', 'task', 'link'] : ['task', 'link']);
    assert.equal(h.e('__nextCalls'), 1);
    assert.equal(h.checkpoint(), null);
    assert.equal(h.writes.some(r => ['stage', 'note'].includes(r.operation)), false);
  });
}
