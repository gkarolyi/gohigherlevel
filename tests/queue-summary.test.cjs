const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { installWebGlobals, evaluateUserscript } = require('./helpers/userscript.cjs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../gohigherlevel.user.js'), 'utf8');
const LOCATION = '3QixdLNutDXye95tTBK0';
const route = `/v2/location/${LOCATION}/contacts/detail/a`;
const leads = (count = 3, hits = []) => ({ aggregations: { pipelines: { docCountErrorUpperBound: 0, sumOtherDocCount: 0, buckets: [{ key: 's', docCount: count, topOpportunities: { hits: { hits } } }] } } });
const tasks = (total = 2) => ({ total, customObjectRecords: total ? [{ locationId: LOCATION, properties: { completed: false, dueDate: '2020-01-01T00:00:00Z' }, relations: [{ associationId: 'TASK_CONTACT_ASSOCIATION', objectKey: 'contact', recordId: 'b' }] }] : [] });
function harness(t, { verified = true, visible = true, reply, delayedInit = false } = {}) {
  const dom = new JSDOM('<body><header><button id="tb_business">Companies</button></header><nav><a>Message hub</a><a>Settings</a></nav><main></main></body>', { url: `https://go.pertamaproperty.com${route}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window; t.after(() => w.close()); installWebGlobals(w);
  Object.defineProperty(w.document, 'readyState', { value: delayedInit ? 'loading' : 'complete' });
  w.HTMLElement.prototype.getClientRects = function () { return visible && !this.hidden ? [{}] : []; };
  const frames = []; w.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  const requests = [];
  w.fetch = async (url, options) => { const body = JSON.parse(options.body); requests.push({ url, body }); return reply ? reply(url, body) : new Response(JSON.stringify(url.includes('/objects/') ? tasks() : leads())); };
  w.localStorage.setItem(`pertama:pipelines:${LOCATION}`, JSON.stringify({ pipelines: [{ id: 'p', name: 'Sales', stages: { 'New Lead': 's' } }] }));
  const evaluate = evaluateUserscript(w, source);
  evaluate("settings.pipelineIds = ['p']");
  function auth(user = 'user-a') { const token = `a.${Buffer.from(JSON.stringify({ user_id: user, sub: user, locations: [LOCATION], exp: Date.now()/1000 + 3600 })).toString('base64url')}.b`; evaluate(`captureReadHeaders('https://services.leadconnectorhq.com/contacts/a', {'token-id': ${JSON.stringify(token)}})`); }
  if (verified) auth();
  if (delayedInit) evaluate('initializeButtons()');
  async function flush() { for (let i = 0; i < 30; i++) { await new Promise(resolve => setImmediate(resolve)); const batch = frames.splice(0); batch.forEach(cb => cb()); } }
  return { w, evaluate, requests, auth, flush, summary: () => w.document.getElementById('pertama-queue-summary'), refresh: () => evaluate('refreshButtons()') };
}
test('authenticated session before toolbar initialization still starts a background snapshot', async t => {
  const h = harness(t, { delayedInit: true }); await h.flush();
  assert.equal(h.summary().textContent, 'New leads 3 · Follow-ups due 2');
  assert.equal(h.requests.length, 2);
});
for (const paused of ['hidden', 'busy']) test(`pending snapshot survives temporarily ${paused} UI`, async t => {
  const pending = [];
  const h = harness(t, { reply: url => new Promise(resolve => pending.push({ url, resolve })) }); await h.flush();
  if (paused === 'hidden') {
    Object.defineProperty(h.w.document, 'hidden', { configurable: true, value: true });
    h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
  } else h.evaluate('workflow.busy = true');
  for (const request of pending) request.resolve(new Response(JSON.stringify(request.url.includes('/objects/') ? tasks() : leads())));
  await h.flush();
  if (paused === 'hidden') {
    assert.equal(h.summary().hidden, true);
    Object.defineProperty(h.w.document, 'hidden', { configurable: true, value: false });
    h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
  } else { h.evaluate('workflow.busy = false'); h.refresh(); }
  await h.flush();
  assert.equal(h.summary().textContent, 'New leads 3 · Follow-ups due 2');
  assert.equal(h.requests.length, 2, 'valid completed reads are cached, not repeated');
});
test('mounts muted summary adjacent to Save and next and fetches once without changing Next label', async t => {
  const h = harness(t); await h.flush();
  assert.ok(h.summary(), 'summary mounted');
  assert.equal(h.w.document.getElementById('pertama-no-answer-button').nextElementSibling, h.summary());
  assert.equal(h.summary().textContent, 'New leads 3 · Follow-ups due 2');
  assert.equal(h.requests.length, 2);
  assert.equal(h.w.document.getElementById('pertama-next-lead-button').textContent, 'Next lead');
  for (let i = 0; i < 4; i++) { h.refresh(); h.w.document.querySelector('header').className = `x${i}`; await h.flush(); }
  assert.equal(h.requests.length, 2);
  h.summary().remove(); await h.flush(); assert.ok(h.summary()); assert.equal(h.requests.length, 2);
});
for (const options of [{ verified: false }, { visible: false }]) test(`no reads without verified visible contact ${JSON.stringify(options)}`, async t => {
  const h = harness(t, options); await h.flush(); assert.equal(h.requests.length, 0); assert.ok(!h.summary() || h.summary().hidden);
});
test('count queries equal navigation builders and use fresh due cutoff, priority order and zero pipelines', async t => {
  const h = harness(t);
  h.evaluate("queryTemplates.tasks.filters[0].filters.push({field:'properties.assignedTo',operator:'eq',value:['owner']}); settings.priority = 'tasks'");
  const before = Date.now(); await h.flush();
  assert.equal(h.summary().textContent, 'Follow-ups due 2 · New leads 3');
  const pipeline = h.requests.find(r => r.url.includes('/opportunities/')).body;
  assert.deepEqual(pipeline, JSON.parse(h.evaluate('JSON.stringify(pipelineQueueQuery(NAV_PIPELINES[0], settings.newLeadStage, false))')));
  const task = h.requests.find(r => r.url.includes('/objects/')).body;
  const cutoff = task.filters[0].filters.find(f => f.field === 'properties.dueDate').value.lte;
  assert.ok(Date.parse(cutoff) >= before && Date.parse(cutoff) <= Date.now());
  assert.deepEqual(task, JSON.parse(h.evaluate(`JSON.stringify(dueTaskQueueQuery(${JSON.stringify(cutoff)}))`)));
  h.evaluate('settings.pipelineIds = []'); h.refresh(); await h.flush();
  assert.equal(h.summary().textContent, 'Follow-ups due 2 · New leads 0');
});
test('new-lead total sums only selected pipelines and preserves verified user scope', async t => {
  const h = harness(t, { reply: async (url, body) => {
    if (url.includes('/objects/')) return new Response(JSON.stringify(tasks(0)));
    const pipeline = body.filters.find(filter => filter.field === 'pipeline_id').value[0];
    return new Response(JSON.stringify(leads(pipeline === 'p' ? 4 : 7)));
  } });
  h.evaluate("NAV_PIPELINES.push({id:'p2', name:'Second', stages:{'New Lead':'s'}}, {id:'ignored', name:'Ignored', stages:{'New Lead':'s'}}); settings.pipelineIds = ['p', 'p2']");
  await h.flush();
  assert.equal(h.summary().textContent, 'New leads 11 · Follow-ups due 0');
  const queries = h.requests.filter(request => request.url.includes('/opportunities/')).map(request => request.body);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries.map(query => query.filters.find(filter => filter.field === 'pipeline_id').value[0]), ['p', 'p2']);
  for (const query of queries) {
    assert.deepEqual(query.aggregations[0].options.include, ['s']);
    assert.deepEqual(query.filters.at(-1), { group: 'OR', filters: [
      { group: 'AND', filters: [{field: 'assigned_to', operator: 'eq', value: ['user-a']}] },
      { group: 'AND', filters: [{field: 'followers', operator: 'eq', value: ['user-a']}] },
    ] });
  }
});
test('strict counts reject malformed buckets and task totals independently', async t => {
  const h = harness(t); await h.flush();
  assert.equal(h.evaluate('typeof pipelineQueueCount'), 'function');
  assert.equal(h.evaluate('typeof dueTaskQueueCount'), 'function');
  for (const count of [-1, 1.5, '3', null]) assert.throws(() => h.evaluate(`pipelineQueueCount(${JSON.stringify(leads(count))}, NAV_PIPELINES[0], 'New Lead')`));
  for (const total of [-1, 1.5, '2', null]) assert.throws(() => h.evaluate(`dueTaskQueueCount(${JSON.stringify(tasks(total))}, new Date().toISOString())`));
  for (const data of [ { ...leads(), aggregations: { pipelines: { ...leads().aggregations.pipelines, sumOtherDocCount: 1 } } }, { ...leads(), aggregations: { pipelines: { ...leads().aggregations.pipelines, buckets: [leads().aggregations.pipelines.buckets[0], leads().aggregations.pipelines.buckets[0]] } } } ]) assert.throws(() => h.evaluate(`pipelineQueueCount(${JSON.stringify(data)}, NAV_PIPELINES[0], 'New Lead')`));
  assert.throws(() => h.evaluate(`dueTaskQueueCount({total: 4, customObjectRecords: []}, new Date().toISOString())`));
});
test('same-stage subtracts all current opportunities even beyond the first 20 hits', async t => {
  const h = harness(t, { reply: async (url, body) => new Response(JSON.stringify(leads(body.filters.some(f => f.group === 'OR' && f.filters.some(c => c.field === 'contact_id')) ? 2 : 30))) });
  h.evaluate("settings.priority = 'stage'; pinStageQueue({contactId:'a', opportunityId:'1', pipelineId:'p', stageId:'s'})"); await h.flush();
  assert.equal(h.summary().textContent, 'New Lead · 28 remaining'); assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].body.filters.at(-1), {group: 'OR', filters: [{field:'contact_id', operator:'eq', value:'a'}]});
  assert.deepEqual({...h.requests[1].body, filters: h.requests[1].body.filters.slice(0, -1)}, h.requests[0].body);
});
test('same-stage rejects a current-contact count larger than the full queue', async t => {
  let n = 0; const h = harness(t, { reply: async () => new Response(JSON.stringify(leads(++n))) });
  h.evaluate("settings.priority = 'stage'; pinStageQueue({contactId:'a', opportunityId:'1', pipelineId:'p', stageId:'s'})"); await h.flush();
  assert.equal(h.summary().textContent, 'New Lead · — remaining');
});
test('category failures display dash, preserve other count and never auto-retry', async t => {
  const h = harness(t, { reply: async url => new Response(JSON.stringify(url.includes('/objects/') ? tasks() : leads('bad'))) }); await h.flush();
  assert.equal(h.summary().textContent, 'New leads — · Follow-ups due 2');
  h.refresh(); await h.flush(); assert.equal(h.requests.length, 2);
});
for (const change of ['route', 'account', 'settings', 'user']) test(`discards stale ${change} responses`, async t => {
  const pending = []; const h = harness(t, { reply: (url) => new Promise(resolve => pending.push({ url, resolve })) }); await h.flush();
  if (change === 'route') h.w.history.pushState({}, '', route.replace(/a$/, 'b'));
  if (change === 'account') h.w.history.pushState({}, '', '/v2/location/other/contacts/detail/a');
  if (change === 'settings') { h.evaluate("settings.priority = 'tasks'"); h.refresh(); }
  if (change === 'user') h.auth('user-b');
  const old = pending.splice(0); await h.flush();
  old.forEach(r => r.resolve(new Response(JSON.stringify(r.url.includes('/objects/') ? tasks(99) : leads(99))))); await h.flush();
  assert.ok(!h.summary().textContent.includes('99'));
  if (change === 'account') assert.equal(h.summary().hidden, true);
});
test('busy saves and contact writes defer snapshots until idle', async t => {
  const h = harness(t); h.evaluate('workflow.busy = true'); await h.flush(); assert.equal(h.requests.length, 0);
  h.evaluate('workflow.busy = false; contactWritesPending = 1'); h.refresh(); await h.flush(); assert.equal(h.requests.length, 0);
  h.evaluate('contactWritesPending = 0; invalidateContactReads()'); await h.flush(); assert.equal(h.requests.length, 2);
  h.evaluate('workflow.busy = true; invalidateContactReads()'); await h.flush(); assert.equal(h.requests.length, 2);
  h.evaluate('workflow.busy = false'); h.refresh(); await h.flush(); assert.equal(h.requests.length, 4);
});
test('same-session header recapture still invalidates rejected credentials', async t => {
  const pending = []; const h = harness(t, { reply: () => new Promise(resolve => pending.push(resolve)) }); await h.flush();
  h.evaluate("captureReadHeaders('https://services.leadconnectorhq.com/contacts/a', liveReadHeaders)");
  for (const resolve of pending) resolve(new Response('{}', { status: 401 }));
  await h.flush();
  assert.equal(h.evaluate('currentUserId'), null);
  assert.equal(h.evaluate('liveReadHeaders'), null);
  assert.equal(h.summary().hidden, true);
});
test('changed credentials for the same user refresh counts and discard old results', async t => {
  const pending = []; const h = harness(t, { reply: url => new Promise(resolve => pending.push({ url, resolve })) }); await h.flush();
  const old = pending.splice(0);
  h.evaluate("captureReadHeaders('https://services.leadconnectorhq.com/contacts/a', {'token-id': liveReadHeaders['token-id'] + 'new-session'})");
  await h.flush(); assert.equal(h.requests.length, 4);
  for (const request of old) request.resolve(new Response(JSON.stringify(request.url.includes('/objects/') ? tasks(99) : leads(99))));
  await h.flush(); assert.ok(!h.summary().textContent.includes('99'));
  for (const request of pending) request.resolve(new Response(JSON.stringify(request.url.includes('/objects/') ? tasks() : leads())));
  await h.flush(); assert.equal(h.summary().textContent, 'New leads 3 · Follow-ups due 2');
  h.evaluate("captureReadHeaders('https://services.leadconnectorhq.com/contacts/a', liveReadHeaders)");
  h.refresh(); await h.flush(); assert.equal(h.requests.length, 4, 'unchanged credentials do not refetch');
});
test('late old-session authorization failure cannot invalidate new user', async t => {
  const pending = []; const h = harness(t, { reply: () => new Promise(resolve => pending.push(resolve)) }); await h.flush();
  const old = pending.splice(0); h.auth('user-b'); await h.flush();
  old.forEach(resolve => resolve(new Response('{}', { status: 401 }))); await h.flush();
  assert.equal(h.evaluate('currentUserId'), 'user-b');
  assert.equal(h.evaluate('Boolean(liveReadHeaders)'), true);
});
test('run finally refreshes even when contact does not navigate', async t => {
  const h = harness(t); await h.flush();
  h.w.alert = () => {};
  h.evaluate("readActionContext = async () => { throw new Error('fixture stops before writes'); }");
  await h.evaluate('run()'); await h.flush();
  assert.equal(h.requests.length, 4); assert.equal(h.summary().textContent, 'New leads 3 · Follow-ups due 2');
});
test('native query filter changes refresh counts', async t => {
  const h = harness(t); await h.flush();
  h.evaluate("const body = pipelineQueueQuery(NAV_PIPELINES[0], 'New Lead', false); body.query = 'changed'; rememberQuery('/opportunities/search', body)"); await h.flush();
  assert.equal(h.requests.length, 4); assert.equal(h.requests[2].body.query, 'changed');
});
