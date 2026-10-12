const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(require('node:path').join(__dirname, '../gohigherlevel.user.js'), 'utf8');
const L = '3QixdLNutDXye95tTBK0', origin = 'https://services.leadconnectorhq.com';
const route = `/v2/location/${L}/contacts/detail/c1`;
const contact = { id: 'c1', locationId: L, firstName: 'Ada', lastName: 'Lee', phone: '+123', assignedTo: 'owner1' };
const opportunity = { id: 'o1', contactId: 'c1', locationId: L, pipelineId: 'p1', pipelineStageId: 's1', assignedTo: 'owner1' };
function harness(t) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: `https://go.pertamaproperty.com${route}`, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const w = dom.window; t.after(() => w.close());
  for (const key of ['Request', 'Response', 'Headers', 'AbortController']) w[key] = globalThis[key];
  const calls = []; let hook = () => {};
  w.fetch = async (url, init) => {
    const path = new URL(url).pathname, body = init.body && JSON.parse(init.body);
    const call = { url, path, init, body }; calls.push(call);
    const override = await hook(call);
    if (override !== undefined) return override instanceof Response ? override : new Response(JSON.stringify(override));
    let data;
    if (path === '/contacts/c1') data = { contact };
    else if (init.method === 'GET') data = { opportunity: { ...opportunity, indexVersion: 7 } };
    else if (init.method === 'PUT') data = { opportunity: { ...opportunity, ...body } };
    else if (path === '/notes/') data = { note: { ...body, id: 'n1', locationId: L, contactId: 'c1' } };
    else if (path === '/objects/task/records') data = { record: { ...body, id: 't1', objectKey: 'task', properties: { ...body.properties, completed: 0, dueDate: '2026-10-10T03:00:00Z' } }, errors: [] };
    else data = { results: { added: [{ success: true, data: body.add[0] }], errored: [], removed: [] } };
    return new Response(JSON.stringify(data));
  };
  w.eval(source.replace(/\}\)\(\);\s*$/, 'globalThis.__writes = { evaluate(code) { return eval(code); } };\n})();'));
  const e = code => w.__writes.evaluate(code);
  const token = `x.${Buffer.from(JSON.stringify({ user_id: 'user1', sub: 'user1', locations: [L], exp: Date.now() / 1000 + 3600 })).toString('base64url')}.x`;
  e(`captureReadHeaders('${origin}/contacts/c1', ${JSON.stringify({ 'token-id': token })}); startingContact = 'c1'; approvedActionContext = { contact:'c1', route:stageRouteRevision, user:currentUserId, epoch:contactReadEpoch, contactRecord:${JSON.stringify(contact)}, opportunity:${JSON.stringify(opportunity)}, targetStageId:'s2', targetStageName:'Next', ownerId:'owner1', noteText:'A < B & "quoted"\nsecond line', taskTitle:'Call Ada', due:'2026-10-10', actions:{stage:true,note:true,task:true}, taskId:null };`.replace('"quoted"\nsecond', '"quoted"\\nsecond'));
  return { w, e, calls, hook: fn => { hook = fn; }, checkpoint: () => w.localStorage.getItem(`pertama:no-answer:unfinished:${L}:c1`), run: name => e(`${name}()`), flush: () => new Promise(resolve => setImmediate(resolve)) };
}
test('exact API requests, confirmed checkpoints, stage lifecycle and no CRM DOM', async t => {
  const h = harness(t), epoch = h.e('contactReadEpoch');
  await h.run('saveStageApi'); await h.run('saveNoteApi'); await h.run('createTaskApi');
  assert.deepEqual(h.calls.map(c => [c.init.method, c.url.replace(origin, '')]), [['GET','/opportunities/o1'],['PUT','/opportunities/o1'],['GET','/contacts/c1'],['POST',`/notes/?locationId=${L}`],['GET','/contacts/c1'],['POST','/objects/task/records'],['POST','/associations/relations/bulk?updateFutureTasks=false']]);
  assert.deepEqual(h.calls[1].body, { pipelineStageId:'s2', indexVersion:8, isAttribute:false });
  assert.deepEqual(h.calls[3].body, { body:'<p>A &lt; B &amp; &quot;quoted&quot;<br>\nsecond line</p>', title:'', color:'#fef7c3', relations:[{ objectKey:'contact',recordId:'c1' }] });
  assert.deepEqual(h.calls[5].body, { locationId:L, owners:['owner1'], properties:{ title:'Call Ada', dueDate:'2026-10-10T03:00:00.000Z', completed:false, description:'', contactId:'c1' } });
  assert.equal(h.calls[3].init.headers.developer_version, undefined); assert.equal(h.calls[5].init.headers.developer_version, '');
  assert.equal(h.e('contactReadEpoch'), epoch + 2); assert.equal(h.e('approvedActionContext.epoch'), epoch + 2);
  assert.equal(h.e('contactWritesPending + stageWritesPending'), 0);
  assert.equal(JSON.parse(h.checkpoint()).completed.length, 4); assert.equal(JSON.parse(h.checkpoint()).pendingSave, '');
});
for (const fn of ['saveStageApi','saveNoteApi','createTaskApi']) for (const change of ['approvedActionContext = null', 'approvedActionContext.actions = {}', 'approvedActionContext.user = "other"', 'approvedActionContext.contactRecord.locationId = "other"', 'identityExpires = 0', 'liveReadHeaders = null']) test(`${fn} refuses ${change}`, async t => {
  const h = harness(t); h.e(change); await assert.rejects(h.run(fn)); assert.equal(h.calls.length, 0);
});
for (const field of ['id','locationId','contactId','pipelineId','pipelineStageId','assignedTo','indexVersion']) test(`fresh stage rejects wrong ${field}`, async t => {
  const h = harness(t); h.hook(() => ({ opportunity:{ ...opportunity,indexVersion:7,[field]:field === 'indexVersion' ? Number.MAX_SAFE_INTEGER : 'wrong' } }));
  await assert.rejects(h.run('saveStageApi')); assert.equal(h.calls.length, 1);
});
for (const field of ['id','locationId','contactId','pipelineId','pipelineStageId','assignedTo','indexVersion']) test(`stage receipt rejects wrong ${field} and finishes lifecycle`, async t => {
  const h = harness(t); h.hook(c => c.init.method === 'PUT' ? { opportunity:{ ...opportunity,...c.body,[field]:'wrong' } } : undefined);
  await assert.rejects(h.run('saveStageApi')); assert.equal(h.e('contactWritesPending + stageWritesPending'), 0); assert.ok(JSON.parse(h.checkpoint()).pendingSave);
});
for (const field of ['assignedTo','firstName','lastName','phone']) test(`contact recheck rejects changed ${field}`, async t => {
  const h = harness(t); h.hook(() => ({ contact:{ ...contact,[field]:'changed' } })); await assert.rejects(h.run('createTaskApi')); assert.equal(h.calls.length, 1);
});
for (const [field, value] of [['id','bad/id'],['locationId','other'],['contactId','other'],['bodyText','wrong text']]) test(`note rejects wrong ${field}`, async t => {
  const h = harness(t); h.hook(c => c.path === '/notes/' ? { note:{ ...c.body,id:'n1',locationId:L,contactId:'c1',[field]:value } } : undefined);
  await assert.rejects(h.run('saveNoteApi')); assert.ok(JSON.parse(h.checkpoint()).pendingSave); assert.equal(JSON.parse(h.checkpoint()).completed.length, 0);
});
for (const patch of [{ id:'bad/id' },{ locationId:'other' },{ owners:['user1'] },{ properties:{ title:'wrong' } },{ properties:{ dueDate:'2026-10-10T11:00:00Z' } },{ properties:{ completed:true } }]) test(`task rejects receipt ${JSON.stringify(patch)}`, async t => {
  const h = harness(t); h.hook(c => c.path === '/objects/task/records' ? { record:{ ...c.body,id:'t1',objectKey:'task',...patch,properties:{ ...c.body.properties,...patch.properties } } } : undefined);
  await assert.rejects(h.run('createTaskApi')); assert.equal(h.calls.length, 2); assert.equal(JSON.parse(h.checkpoint()).completed.length, 0);
});
for (const change of ['approvedActionContext.ownerId = "user1"','approvedActionContext.due = "2026-02-30"','approvedActionContext.due = "wrong"','approvedActionContext.taskTitle = ""']) test(`invalid task approval ${change}`, async t => {
  const h = harness(t); h.e(change); await assert.rejects(h.run('createTaskApi')); assert.equal(h.calls.length, 0);
});
test('timeout aborts once, retains journal, balances stage lifecycle', async t => {
  const h = harness(t); let abortTimer;
  const nativeTimer = h.w.setTimeout.bind(h.w);
  h.w.setTimeout = (fn, ms, ...args) => ms === 30000 ? (abortTimer = fn, nativeTimer(() => {}, 60000)) : nativeTimer(fn, ms, ...args);
  h.hook(c => c.init.method === 'PUT' ? new Promise((resolve, reject) => c.init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) : undefined);
  const pending = h.run('saveStageApi'); await h.flush(); abortTimer(); await assert.rejects(pending, /Timed out/);
  assert.equal(h.calls.length, 2); assert.ok(JSON.parse(h.checkpoint()).pendingSave); assert.equal(h.e('contactWritesPending + stageWritesPending'), 0);
});
test('native fetch exception is redacted and lifecycle ends once', async t => {
  const h = harness(t), epoch = h.e('contactReadEpoch'); h.hook(c => { if (c.init.method === 'PUT') throw new Error('secret body token'); });
  await assert.rejects(h.run('saveStageApi'), error => !error.message.includes('secret'));
  assert.equal(h.e('contactReadEpoch'), epoch + 2); assert.equal(h.e('contactWritesPending + stageWritesPending'), 0);
});
test('concurrent mutation preserves confirmed stage evidence but forbids advancing approval', async t => {
  const h = harness(t), epoch = h.e('approvedActionContext.epoch');
  h.hook(c => { if (c.init.method === 'PUT') h.e(`finishContactWrite(observeContactRequest('PUT','${origin}/contacts/c1',()=>({})))`); });
  await assert.rejects(h.run('saveStageApi')); assert.equal(JSON.parse(h.checkpoint()).completed.length, 1); assert.equal(h.e('approvedActionContext.epoch'), epoch);
});
test('stage automation owner change stops subsequent note and task', async t => {
  const h = harness(t); await h.run('saveStageApi');
  h.hook(c => c.path === '/contacts/c1' ? { contact:{ ...contact,assignedTo:'new-owner' } } : undefined);
  await assert.rejects(h.run('saveNoteApi')); await assert.rejects(h.run('createTaskApi'));
  assert.equal(h.calls.filter(c => c.init.method === 'POST').length, 0);
});
test('nullable opportunity owner is normalized like approved reads', async t => {
  const h = harness(t); h.e('approvedActionContext.opportunity.assignedTo = ""');
  h.hook(c => c.path === '/opportunities/o1' ? { opportunity:{ ...opportunity,assignedTo:null,indexVersion:7,...c.body } } : undefined);
  await h.run('saveStageApi'); assert.equal(JSON.parse(h.checkpoint()).completed.length, 1);
});
test('wrong association retains partial task creation', async t => {
  const h = harness(t); h.hook(c => c.path.startsWith('/associations') ? { results:{ added:[{success:true,data:{...c.body.add[0],secondRecordId:'wrong'}}],errored:[] } } : undefined);
  await assert.rejects(h.run('createTaskApi')); assert.match(h.checkpoint(), /Task created/); assert.match(h.checkpoint(), /association/);
});
test('transport rejects arbitrary operations and unapproved target context', async t => {
  const h = harness(t);
  await assert.rejects(h.e('actionRequest("/conversations/messages", approvedActionContext)'));
  await assert.rejects(h.e('actionRequest("note", {...approvedActionContext, contact:"c2"})'));
  h.e('approvedActionContext.actions.note = false'); await assert.rejects(h.e('actionRequest("note", approvedActionContext)'));
  assert.equal(h.calls.length, 0);
});
test('HTML note body preserves line breaks without interpreting approved markup', async t => {
  const h = harness(t);
  h.e('approvedActionContext.noteText = "First <b>literal</b>\\nSecond"');
  await h.run('saveNoteApi');
  const body = h.calls.find(c => c.path === '/notes/').body.body;
  const parsed = new h.w.DOMParser().parseFromString(body, 'text/html');
  assert.equal(parsed.querySelectorAll('br').length, 1);
  assert.equal(parsed.querySelector('b'), null);
  assert.equal(parsed.body.textContent, 'First <b>literal</b>\nSecond');
});
for (const [fn, details] of [['saveStageApi', ['Next', 's2', 'o1']], ['saveNoteApi', ['A < B', 'second line']], ['createTaskApi', ['Call Ada', '2026-10-10', 'owner1']]]) {
  test(`${fn} journals intended action details before an uncertain write`, async t => {
    const h = harness(t);
    h.hook(c => {
      if (c.init.method === 'GET') return;
      const pending = JSON.parse(h.checkpoint()).pendingSave;
      for (const detail of details) assert.ok(pending.includes(detail), `missing journal detail: ${detail}`);
      throw new Error('Response lost');
    });
    await assert.rejects(h.run(fn));
    const pending = JSON.parse(h.checkpoint()).pendingSave;
    for (const detail of details) assert.ok(pending.includes(detail), `missing journal detail: ${detail}`);
  });
}

test('storage refusal prevents write', async t => {
  const h = harness(t); h.e('Storage.prototype.setItem = function() { throw new Error("storage full"); }');
  await assert.rejects(h.run('saveStageApi'), /storage/); assert.equal(h.calls.length, 1);
});
test('route changes during reads stop writes', async t => {
  const h = harness(t); h.hook(() => { h.w.history.pushState({}, '', '/away'); }); await assert.rejects(h.run('saveNoteApi')); assert.equal(h.calls.length, 1);
});
for (const fn of ['saveStageApi','saveNoteApi','createTaskApi']) test(`${fn} records known outcome before rejecting route change`, async t => {
  const h = harness(t); h.hook(c => { if (c.init.method !== 'GET') h.w.history.pushState({}, '', '/away'); });
  await assert.rejects(h.run(fn)); assert.equal(JSON.parse(h.checkpoint()).completed.length, 1);
  if (fn === 'createTaskApi') { assert.match(h.checkpoint(), /Task created.*t1/); assert.match(h.checkpoint(), /association/); assert.equal(h.calls.length, 2); }
});
test('failed association retains task identity and does not retry creation', async t => {
  const h = harness(t); h.hook(c => c.path.startsWith('/associations') ? new Response('{}',{status:500}) : undefined);
  await assert.rejects(h.run('createTaskApi')); assert.match(h.checkpoint(), /Task created.*t1/); await assert.rejects(h.run('createTaskApi')); assert.equal(h.calls.filter(c => c.path === '/objects/task/records').length, 1);
});
for (const status of [401,403,500]) test(`HTTP ${status} retains journal, no retry, sanitized diagnostics`, async t => {
  const h = harness(t); h.hook(c => c.init.method === 'PUT' ? new Response('{}',{status}) : undefined);
  await assert.rejects(h.run('saveStageApi')); assert.equal(h.calls.length, 2); assert.ok(JSON.parse(h.checkpoint()).pendingSave);
  assert.equal(h.e('contactWritesPending + stageWritesPending'), 0);
  if (status !== 500) assert.equal(h.e('currentUserId'), null);
  assert.ok(!JSON.stringify(h.w.pertamaRequestDiagnostics).includes('o1'));
});
