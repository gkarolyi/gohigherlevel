const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { installWebGlobals, evaluateUserscript } = require('./helpers/userscript.cjs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../gohigherlevel.user.js'), 'utf8');
const L = '3QixdLNutDXye95tTBK0', origin = 'https://services.leadconnectorhq.com';
const route = `/v2/location/${L}/contacts/detail/c1`;
const contact = { id:'c1', locationId:L, firstName:'Ada', lastName:'Lee', assignedTo:'u1' };
const task = { id:'t1', locationId:L, objectKey:'task', properties:{title:'Call again Ada Lee',completed:0}, relations:[{associationId:'TASK_CONTACT_ASSOCIATION',objectKey:'contact',recordId:'c1',relationId:'r1'}] };
const list = (rows, total = rows.length) => ({customObjectRecords:rows,total,recurringTaskConfigs:[]});
function harness(t) {
  const dom = new JSDOM('<!doctype html><body></body>', {url:`https://go.pertamaproperty.com${route}`,runScripts:'outside-only',virtualConsole:new VirtualConsole()});
  const w = dom.window; t.after(() => w.close());
  installWebGlobals(w);
  let hook = () => {}, written = false; const calls = [];
  w.fetch = async (url, init) => {
    const c = {url,path:new URL(url).pathname,init,body:init.body && JSON.parse(init.body)}; calls.push(c);
    const override = await hook(c);
    if (override !== undefined) return override instanceof Response ? override : new Response(JSON.stringify(override));
    if (init.method === 'PUT') { written = true; return new Response(JSON.stringify({succeded:true})); }
    return new Response(JSON.stringify(init.method === 'GET' ? {contact} : list([{...task,properties:{...task.properties,completed:written ? 1 : 0}}])));
  };
  const e = evaluateUserscript(w, source);
  const auth = (user = 'u1') => e(`captureReadHeaders('${origin}/contacts/c1', ${JSON.stringify({'token-id':`x.${Buffer.from(JSON.stringify({user_id:user,sub:user,locations:[L],exp:Date.now()/1000+3600})).toString('base64url')}.x`})})`);
  auth();
  // Any legacy UI access is an immediate failure rather than a 30-second wait.
  e('globalThis.openSidebar = async () => { throw new Error("CRM DOM forbidden"); }; openSidebar = globalThis.openSidebar; if (typeof readContactName === "function") readContactName = async () => { throw new Error("CRM DOM forbidden"); }');
  return {w,e,calls,auth,hook:fn => {hook = fn;},run:() => e('completeCallTask("c1")'),puts:() => calls.filter(c => c.init.method === 'PUT'),checkpoint:() => w.localStorage.getItem(`pertama:no-answer:unfinished:${L}:c1`),notice:() => w.document.getElementById('pertama-task-notice')?.textContent || '',flush:() => new Promise(resolve => setImmediate(resolve))};
}
test('Save-and-next task completion keeps earlier confirmed actions in its checkpoint', async t => {
  const h = harness(t);
  h.e("busy = true; guardedContact = 'c1'; startingContact = 'c1'; completed = ['Stage: confirmed']; saveCheckpoint()");
  await h.e('completeCallTask("c1", { fromSaveAndNext: true })');
  assert.equal(h.puts().length, 1);
  assert.match(h.checkpoint(), /Stage: confirmed/);
  assert.match(h.checkpoint(), /Call task completed and verified/);
  assert.equal(h.e('busy'), true);
  assert.equal(h.e('guardedContact'), 'c1');
});
test('Call-click completes exact API task without CRM panels and journals before PUT', async t => {
  const h = harness(t);
  h.hook(c => { if (c.init.method === 'PUT') { assert.match(h.checkpoint(), /t1/); assert.match(h.checkpoint(), /Call again Ada Lee/); } });
  await h.run();
  assert.equal(h.puts().length, 1);
  assert.deepEqual(h.puts()[0].body, {completed:true,ids:['t1']});
  assert.equal(h.puts()[0].url, `${origin}/locations/${L}/tasks/bulk/update`);
  assert.deepEqual(h.calls.find(c => c.init.method === 'POST').body, {filters:[{group:'OR',filters:[{field:'relations.TASK_CONTACT_ASSOCIATION',operator:'eq',value:['c1']}]}],locationId:L,sort:[{field:'properties.dueDate',direction:'desc'}],pageLimit:20,includeRecurringTaskConfigs:true,ignoreAssignedToPermission:true,page:1,query:''});
  const init = h.puts()[0].init;
  assert.equal(init.redirect,'error'); assert.equal(init.headers.channel,'APP'); assert.equal(init.headers.source,'WEB_USER'); assert.equal(init.headers.version,'2021-07-28'); assert.equal(init.headers.developer_version,''); assert.ok(init.headers['token-id']);
  assert.equal(h.calls.filter(c => c.init.method === 'GET').length,2);
  assert.equal(h.checkpoint(),null); assert.match(h.notice(),/^Completed:/);
});
for (const rows of [[],[{...task,properties:{...task.properties,completed:1}}],[{...task,properties:{...task.properties,title:'Other'}}]]) test(`no exact pending actual task: ${JSON.stringify(rows)}`, async t => {
  const h = harness(t); h.hook(c => c.init.method === 'POST' ? {...list(rows),recurringTaskConfigs:[task]} : undefined);
  await h.run(); assert.equal(h.puts().length,0); assert.equal(h.checkpoint(),null); assert.doesNotMatch(h.notice(),/stopped/i);
});
test('first pending title match in observed order, normalizing whitespace', async t => {
  const h = harness(t); h.hook(c => c.init.method === 'POST' ? list([{...task,id:'done',properties:{...task.properties,completed:1}},{...task,id:'first',properties:{title:' Call again  Ada\nLee ',completed:h.puts().length ? true : 0}},{...task,id:'second'}]) : undefined);
  await h.run(); assert.deepEqual(h.puts()[0].body.ids,['first']); assert.equal(h.checkpoint(),null);
});
for (const patch of [{id:'bad/id'},{locationId:'other'},{objectKey:'config'},{relations:[]},{relations:[{...task.relations[0],recordId:'c2'}]},{relations:[{...task.relations[0],objectKey:'other'}]},{relations:[task.relations[0],task.relations[0]]},{properties:{...task.properties,completed:'0'}}]) test(`reject row ${JSON.stringify(patch)}`, async t => {
  const h = harness(t); h.hook(c => c.init.method === 'POST' ? list([{...task,...patch}]) : undefined);
  await h.run(); assert.equal(h.puts().length,0); assert.match(h.notice(),/stopped/i);
});
for (const data of [list([],1),{customObjectRecords:[],total:'0'},list([task,task]),list([task],0)]) test(`reject incomplete or malformed lookup ${JSON.stringify(data)}`, async t => {
  const h = harness(t); h.hook(c => c.init.method === 'POST' ? data : undefined); await h.run(); assert.equal(h.puts().length,0); assert.match(h.notice(),/stopped/i);
});
test('partial first page with established first matching target is sufficient', async t => {
  const h = harness(t); h.hook(c => c.init.method === 'POST' ? list([{...task,properties:{...task.properties,completed:h.puts().length ? 1 : 0}}],30) : undefined);
  await h.run(); assert.equal(h.puts().length,1); assert.equal(h.checkpoint(),null);
});
for (const change of ['route','auth','epoch','account']) for (const phase of ['GET','POST']) test(`${change} during ${phase} prevents write`, async t => {
  const h = harness(t); h.hook(c => { if(c.init.method !== phase) return; if(change === 'route') {h.w.history.pushState({},'', '/away'); h.w.history.pushState({},'',route);} else if(change === 'account') h.w.history.pushState({},'',route.replace(L,'other')); else if(change === 'auth') h.auth('u2'); else h.e('invalidateContactReads()'); });
  await h.run(); assert.equal(h.puts().length,0); assert.match(h.notice(),/stopped/i);
});
for (const field of ['firstName','lastName','assignedTo']) test(`fresh contact ${field} change blocks PUT`, async t => {
  const h = harness(t); let reads = 0; h.hook(c => c.init.method === 'GET' && ++reads === 2 ? {contact:{...contact,[field]:'changed'}} : undefined);
  await h.run(); assert.equal(h.puts().length,0); assert.match(h.notice(),/stopped/i);
});
for (const patch of [{id:'t2'},{properties:{...task.properties,completed:1}},{properties:{...task.properties,title:'changed'}},{relations:[{...task.relations[0],recordId:'c2'}]}]) test(`fresh task changed ${JSON.stringify(patch)}`, async t => {
  const h = harness(t); let reads = 0; h.hook(c => c.init.method === 'POST' && ++reads === 2 ? list([{...task,...patch}]) : undefined);
  await h.run(); assert.equal(h.puts().length,0);
});
test('storage failure blocks completion', async t => {
  const h = harness(t); h.w.Storage.prototype.setItem = () => {throw new Error('secret');}; await h.run(); assert.equal(h.puts().length,0); assert.doesNotMatch(h.notice(),/secret/); assert.match(h.notice(),/stopped/i);
});
test('existing unfinished action is never overwritten', async t => {
  const h = harness(t); h.w.localStorage.setItem(`pertama:no-answer:unfinished:${L}:c1`,'original'); await h.run(); assert.equal(h.calls.length,0); assert.equal(h.checkpoint(),'original');
});
for (const ack of [{succeded:false},{success:true},{succeded:'true'},null]) test(`malformed ack ${JSON.stringify(ack)} is uncertain and blocks duplicate click`, async t => {
  const h = harness(t); h.hook(c => c.init.method === 'PUT' ? ack : undefined); await h.run(); await h.run(); assert.equal(h.puts().length,1); assert.ok(h.checkpoint()); assert.doesNotMatch(h.notice(),/^Completed:/);
});
for (const status of [401,403,500]) test(`HTTP ${status} retains checkpoint and sanitizes body`, async t => {
  const h = harness(t); h.hook(c => c.init.method === 'PUT' ? new Response('secret',{status}) : undefined); await h.run(); assert.ok(h.checkpoint()); assert.doesNotMatch(h.notice(),/secret/); if(status !== 500) assert.equal(h.e('currentUserId'),null);
});
for (const result of ['missing','otherId','pending','renamed','wrongAssociation']) test(`readback ${result} cannot verify exact task`, async t => {
  const h = harness(t); h.hook(c => {if(c.init.method !== 'POST' || !h.puts().length) return; if(result === 'missing') return list([]); return list([{...task,id:result === 'otherId' ? 't2' : 't1',properties:{title:result === 'renamed' ? 'changed' : task.properties.title,completed:result === 'pending' ? 0 : 1},relations:result === 'wrongAssociation' ? [{...task.relations[0],recordId:'c2'}] : task.relations}]);});
  await h.run(); await h.run(); assert.equal(h.puts().length,1); assert.ok(h.checkpoint()); assert.doesNotMatch(h.notice(),/^Completed:/);
});
test('bounded readback tolerates indexing lag without retrying PUT', async t => {
  const h = harness(t); let reads = 0; h.hook(c => c.init.method === 'POST' && h.puts().length && ++reads < 3 ? list([task]) : undefined);
  await h.run(); assert.equal(h.puts().length,1); assert.equal(h.checkpoint(),null);
});
test('route change after accepted PUT journals acceptance on original contact only', async t => {
  const h = harness(t); h.hook(c => {if(c.init.method === 'PUT') h.w.history.pushState({},'',route.replace('c1','c2'));});
  await h.run(); assert.match(h.checkpoint(),/accepted/i); assert.equal(h.w.localStorage.getItem(`pertama:no-answer:unfinished:${L}:c2`),null); assert.equal(h.calls.filter(c => c.init.method === 'POST').length,2);
});
test('timeout keeps checkpoint; concurrent and subsequent calls never repeat PUT', async t => {
  const h = harness(t); let abortTimer; const timer = h.w.setTimeout.bind(h.w);
  h.w.setTimeout = (fn,ms,...args) => ms === 30000 ? (abortTimer = fn,timer(() => {},60000)) : timer(fn,ms,...args);
  h.hook(c => c.init.method === 'PUT' ? new Promise((resolve,reject) => c.init.signal.addEventListener('abort',() => reject(new DOMException('secret','AbortError')))) : undefined);
  const pending = h.run(); await h.flush(); await h.run(); abortTimer(); await pending; await h.run(); assert.equal(h.puts().length,1); assert.ok(h.checkpoint()); assert.doesNotMatch(h.notice(),/secret/);
});
test('native fetch error data is never surfaced', async t => {
  const h = harness(t); h.hook(() => {throw new Error('secret credentials');}); await h.run(); assert.doesNotMatch(h.notice(),/secret credentials/); assert.match(h.notice(),/stopped/i);
});
for (const state of ['busy = true','identityExpires = 0','liveReadHeaders = null','retiringContactControls = [document.body]']) test(`preflight blocks ${state}`, async t => {
  const h = harness(t); h.e(state); await h.run(); assert.equal(h.calls.length,0); assert.equal(h.checkpoint(),null);
});
for (const patch of [{id:'c2'},{locationId:'other'}]) test(`contact response mismatch ${JSON.stringify(patch)}`, async t => {
  const h = harness(t); h.hook(c => c.init.method === 'GET' ? {contact:{...contact,...patch}} : undefined); await h.run(); assert.equal(h.puts().length,0); assert.match(h.notice(),/stopped/i);
});
for (const phase of ['GET','POST']) test(`HTTP lookup failure during ${phase} is never treated as no task`, async t => {
  const h = harness(t); h.hook(c => c.init.method === phase ? new Response('secret',{status:403}) : undefined); await h.run(); assert.equal(h.puts().length,0); assert.match(h.notice(),/stopped/i); assert.doesNotMatch(h.notice(),/secret/);
});
test('readback HTTP failure retains acceptance and checkpoint', async t => {
  const h = harness(t); h.hook(c => c.init.method === 'POST' && h.puts().length ? new Response('secret',{status:500}) : undefined); await h.run(); assert.match(h.checkpoint(),/accepted/); assert.doesNotMatch(h.notice(),/^Completed:/);
});
test('native PUT failure redacts exception and retains the intent', async t => {
  const h = harness(t); h.hook(c => {if(c.init.method === 'PUT') throw new Error('secret credentials');}); await h.run(); assert.ok(h.checkpoint()); assert.doesNotMatch(h.notice(),/secret credentials/); assert.equal(h.puts().length,1);
});
test('the second Call-task preflight pair also overlaps before completion', async t => {
  const h = harness(t); let contactReads = 0, taskReads = 0, releaseContact, releaseTasks;
  const heldContact = new Promise(resolve => { releaseContact = resolve; });
  const heldTasks = new Promise(resolve => { releaseTasks = resolve; });
  h.hook(c => c.init.method === 'GET' && ++contactReads === 2 ? heldContact
    : c.init.method === 'POST' && ++taskReads === 2 ? heldTasks : undefined);
  const pending = h.run(); await h.flush();
  assert.equal(contactReads, 2);
  assert.equal(taskReads, 2);
  assert.equal(h.puts().length, 0);
  releaseContact({ contact }); releaseTasks(list([task])); await pending;
  assert.equal(h.puts().length, 1);
  assert.equal(h.checkpoint(), null);
});

test('Call-task preflight overlaps contact and task reads and drains both on failure', async t => {
  const h = harness(t); let release;
  const held = new Promise(resolve => { release = resolve; });
  h.hook(c => c.init.method === 'GET' ? held : new Response('{}', { status: 500 }));
  const pending = h.run(); await h.flush();
  assert.deepEqual(h.calls.map(c => c.init.method).sort(), ['GET', 'POST']);
  assert.equal(h.e('busy'), true);
  assert.equal(h.puts().length, 0);
  release({ contact }); await pending;
  assert.equal(h.e('busy'), false);
  assert.equal(h.puts().length, 0);
});

test('Call click does not trigger task completion', async t => {
  const h = harness(t); h.w.document.body.innerHTML = '<button id="hr-button-v-1"><span id="hr-button-v-1-label"><span class="sr-only">Call: Ada</span><p>Call</p></span></button>';
  h.w.document.querySelector('button').click();
  await h.flush();
  assert.equal(h.calls.length, 0);
});
