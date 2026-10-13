const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { installWebGlobals, evaluateUserscript } = require('./helpers/userscript.cjs');
const source = fs.readFileSync(path.join(__dirname, '../gohigherlevel.user.js'), 'utf8');
const L = '3QixdLNutDXye95tTBK0';
const route = id => `/v2/location/${L}/contacts/detail/${id}`;
const header = name => `<section id="conversation"><div class="flex justify-between items-center px-3 gap-3 border-b border-gray-200" style="height:56px"><div class="flex items-center gap-3 flex-1 min-w-0"><div class="flex items-baseline gap-1 flex-1 min-w-0"><span style="display:contents"><div data-testid="CENTRALPANEL_NAME" class="truncate min-w-0">${name}</div></span></div></div><div id="phone-calls" aria-label="Call"></div></div></section>`;
const contact = (id, firstName) => ({ id, locationId: L, firstName, lastName: 'Test', phone: '+628123456789', assignedTo: 'u1' });
const opportunity = (id = 'o1', contactId = 'c1', stage = 's1', status = 'open') => ({ id, contactId, locationId: L, pipelineId: 'p1', pipelineStageId: stage, status, assignedTo: 'u1' });
function harness(t, { mounted = true, auth = true, session = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><body><nav><a>Message hub</a><a>Settings</a></nav><button id="tb_business">Companies</button><aside id="contact-card">Ada Test</aside><main>${mounted ? header('Ada Test') : ''}</main></body>`, {
    url: `https://go.pertamaproperty.com${route('c1')}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const w = dom.window, d = w.document; t.after(() => w.close());
  Object.defineProperty(d, 'readyState', { value: 'complete', configurable: true });
  installWebGlobals(w);
  w.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{ width: 200 }]; };
  const frames = new Map(), timers = new Map(); let serial = 0, now = 0;
  w.requestAnimationFrame = fn => { frames.set(++serial, fn); return serial; };
  w.cancelAnimationFrame = id => frames.delete(id);
  w.setTimeout = (fn, delay = 0) => { timers.set(++serial, { fn, at: now + delay }); return serial; };
  w.clearTimeout = id => timers.delete(id);
  const requests = [], alerts = [], contacts = { c1: contact('c1', 'Ada'), c2: contact('c2', 'Grace') }, opportunities = { c1: [opportunity()], c2: [opportunity('o2', 'c2', 's2')] };
  let hook = () => {};
  w.alert = message => alerts.push(message);
  w.fetch = async (url, init) => {
    const pathname = new URL(url).pathname.replace(/\/$/, ''), body = init.body && JSON.parse(init.body);
    const id = init.method === 'GET' ? pathname.split('/').at(-1) : body.filters[0].filters[0].value;
    const request = { pathname, method: init.method, body, id }; requests.push(request);
    const override = await hook(request);
    if (override instanceof Response) return override;
    const data = override === undefined ? init.method === 'GET' ? { contact: contacts[id] } : { opportunities: opportunities[id], total: opportunities[id].length } : override;
    return new Response(JSON.stringify(data));
  };
  w.localStorage.setItem(`pertama:pipelines:${L}`, JSON.stringify({ pipelines: [{ id: 'p1', name: 'Sales', stages: { 'New Lead': 's1', 'Attempted Contact': 's2' } }] }));
  for (const [key, value] of Object.entries(session)) w.sessionStorage.setItem(key, JSON.stringify(value));
  const e = evaluateUserscript(w, source);
  function authenticate(user = 'u1') {
    const token = `x.${Buffer.from(JSON.stringify({ user_id: user, sub: user, locations: [L], exp: Date.now() / 1000 + 3600 })).toString('base64url')}.x`;
    e(`captureReadHeaders('https://services.leadconnectorhq.com/contacts/c1', ${JSON.stringify({ 'token-id': token })})`);
  }
  if (auth) authenticate();
  async function flush() {
    for (let round = 0; round < 16; round++) {
      await new Promise(resolve => setImmediate(resolve));
      if (!frames.size) return;
      const batch = [...frames.values()]; frames.clear();
      for (const fn of batch) fn(0);
    }
    assert.fail('Indicator UI did not settle');
  }
  async function advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    await flush();
  }
  return { w, d, e, contacts, opportunities, requests, alerts, authenticate, flush, advance, timers, hook: fn => { hook = fn; },
    badge: () => d.getElementById('pertama-contact-stage'), name: () => d.querySelector('[data-testid="CENTRALPANEL_NAME"]'),
    refresh: () => e('refreshButtons()'), navigate: id => w.history.pushState({}, '', route(id)) };
}
function assertStage(h, stage) {
  assert.ok(h.badge(), 'stage badge must exist');
  assert.equal(h.badge().hidden, false);
  assert.equal(h.badge().textContent, stage);
}

test('badge uses the supplied central name wrapper, leaving the contact card untouched', async t => {
  const h = harness(t); await h.flush();
  assertStage(h, 'New Lead');
  assert.equal(h.name().parentElement.nextElementSibling, h.badge());
  assert.equal(h.d.getElementById('contact-card').textContent, 'Ada Test');
  assert.equal(h.badge().getAttribute('aria-label'), 'Stage: New Lead');
  assert.deepEqual(h.requests.map(r => r.method).sort(), ['GET', 'POST']);
});

test('indicator uses current opportunity stage, never the original pinned queue', async t => {
  const h = harness(t, { session: { [`pertama:stage-queue:${L}`]: { contactId: 'c1', opportunityId: 'o1', pipelineId: 'p1', stageId: 's1' } } });
  h.opportunities.c1[0].pipelineStageId = 's2'; await h.flush();
  assertStage(h, 'Attempted Contact');
  assert.equal(h.e('stageQueueContext().stage'), 'New Lead');
});

for (const scenario of ['ambiguous', 'closed', 'unknown stage', 'unknown pipeline', 'stale origin']) {
  test(`unresolvable ${scenario} hides the indicator rather than guessing`, async t => {
    const h = harness(t);
    if (scenario === 'ambiguous') h.opportunities.c1.push(opportunity('other', 'c1', 's2'));
    if (scenario === 'closed') h.opportunities.c1[0].status = 'won';
    if (scenario === 'unknown stage') h.opportunities.c1[0].pipelineStageId = 'missing';
    if (scenario === 'unknown pipeline') h.opportunities.c1[0].pipelineId = 'missing';
    if (scenario === 'stale origin') h.w.sessionStorage.setItem('pertama:origin:c1', JSON.stringify({ opportunityId: 'missing', pipelineId: 'p1' }));
    await h.flush();
    assert.equal(Boolean(h.badge() && !h.badge().hidden), false);
    assert.equal(h.requests.length, 2, 'only one bounded read attempt');
    assert.deepEqual(h.alerts, []);
  });
}

test('origin selects the linked opportunity among multiple open opportunities', async t => {
  const h = harness(t, { session: { 'pertama:origin:c1': { opportunityId: 'o1', pipelineId: 'p1', pipeline: 'Sales' } } });
  h.opportunities.c1.unshift(opportunity('other', 'c1', 's2')); await h.flush();
  assertStage(h, 'New Lead');
});

test('one open opportunity may be selected alongside a closed opportunity', async t => {
  const h = harness(t); h.opportunities.c1.unshift(opportunity('closed', 'c1', 's2', 'lost')); await h.flush();
  assertStage(h, 'New Lead');
});

test('legacy opportunity payloads without status still resolve', async t => {
  const h = harness(t); delete h.opportunities.c1[0].status; await h.flush(); assertStage(h, 'New Lead');
});

test('native stage writes hide stale stage immediately and refresh once settled', async t => {
  const h = harness(t); await h.flush(); assertStage(h, 'New Lead');
  const write = h.e("observeContactRequest('PUT', 'https://services.leadconnectorhq.com/opportunities/o1')");
  assert.equal(h.badge().hidden, true);
  await h.flush(); assert.equal(h.requests.length, 2, 'no reads during a write');
  h.opportunities.c1[0].pipelineStageId = 's2';
  h.w.__write = write; h.e('finishContactWrite(__write)'); await h.flush();
  assertStage(h, 'Attempted Contact'); assert.equal(h.requests.length, 4);
});

test('contact navigation never shows a new stage under a retained old contact name', async t => {
  const h = harness(t); await h.flush(); assertStage(h, 'New Lead');
  h.navigate('c2'); assert.equal(h.badge().hidden, true);
  await h.flush(); assert.equal(h.badge().hidden, true);
  h.name().textContent = 'Grace Test'; await h.flush(); assertStage(h, 'Attempted Contact');
  assert.equal(h.requests.length, 4);
});

test('late old-contact responses cannot overwrite the current contact stage', async t => {
  const h = harness(t); let release;
  h.hook(r => r.id === 'c1' && r.method === 'POST' ? new Promise(resolve => { release = resolve; }) : undefined);
  await h.flush(); assert.ok(release);
  h.navigate('c2'); h.name().textContent = 'Grace Test'; await h.flush(); assertStage(h, 'Attempted Contact');
  release({ opportunities: [opportunity()], total: 1 }); await h.flush();
  assertStage(h, 'Attempted Contact'); assert.equal(h.requests.length, 4);
});

test('a late-mounted name is discovered with bounded retries, never broad observation', async t => {
  const h = harness(t, { mounted: false }); await h.flush(); assert.equal(h.requests.length, 0);
  h.d.querySelector('main').innerHTML = header('Ada Test');
  await h.advance(1000); assertStage(h, 'New Lead');
  assert.equal(h.timers.size, 0, 'mounted name ends discovery timers');
  const count = h.requests.length; await h.advance(60000); assert.equal(h.requests.length, count);
});

test('header discovery stops after its budget and can wake on user interaction', async t => {
  const h = harness(t, { mounted: false }); await h.flush(); await h.advance(30000);
  assert.equal(h.timers.size, 0);
  h.d.querySelector('main').innerHTML = header('Ada Test');
  h.d.body.click(); await h.flush(); assertStage(h, 'New Lead');
});

test('replacing the native header remounts a single badge without rereading', async t => {
  const h = harness(t); await h.flush();
  h.d.getElementById('conversation').outerHTML = header('Ada Test'); await h.flush();
  assertStage(h, 'New Lead');
  assert.equal(h.d.querySelectorAll('#pertama-contact-stage').length, 1);
  assert.equal(h.requests.length, 2);
});

test('removing the injected badge repairs it without a network request', async t => {
  const h = harness(t); await h.flush(); assertStage(h, 'New Lead');
  h.badge().remove(); await h.flush(); assertStage(h, 'New Lead');
  assert.equal(h.requests.length, 2);
});

test('stable UI neither rereads nor rewrites the stage on repeated refreshes', async t => {
  const h = harness(t); await h.flush(); assertStage(h, 'New Lead');
  const mutations = [], observer = new h.w.MutationObserver(records => mutations.push(...records));
  observer.observe(h.d.getElementById('conversation'), { childList: true, subtree: true, attributes: true, characterData: true });
  t.after(() => observer.disconnect());
  for (let i = 0; i < 5; i++) { h.refresh(); await h.flush(); }
  assert.equal(h.requests.length, 2);
  assert.equal(mutations.length, 0);
});

test('no verified user means no indicator requests, and session rejection hides the stage', async t => {
  const h = harness(t, { auth: false }); await h.flush(); assert.equal(h.requests.length, 0);
  h.authenticate(); await h.flush(); assertStage(h, 'New Lead');
  h.e('rejectCrmAuthorization()'); assert.equal(h.badge().hidden, true); await h.flush();
  assert.equal(h.requests.length, 2);
});

test('background read failure stays unobtrusive and does not repeatedly retry', async t => {
  const h = harness(t); h.hook(r => r.method === 'POST' ? new Response('{}', { status: 500 }) : undefined);
  await h.flush();
  for (let i = 0; i < 3; i++) { h.refresh(); await h.flush(); }
  assert.equal(h.requests.length, 2);
  assert.equal(Boolean(h.badge() && !h.badge().hidden), false);
  assert.deepEqual(h.alerts, []);
});

test('verified passive reads update the badge without additional indicator requests', async t => {
  const h = harness(t, { auth: false }); h.e('busy = true'); h.authenticate();
  await h.e("rememberContactRead(observeContactRequest('GET', 'https://services.leadconnectorhq.com/contacts/c1'), { contact: " + JSON.stringify(h.contacts.c1) + ' })');
  await h.e("rememberContactRead(observeContactRequest('POST', 'https://services.leadconnectorhq.com/opportunities/search', () => JSON.stringify(contactOpportunityQuery('c1'))), " + JSON.stringify({ opportunities: h.opportunities.c1, total: 1 }) + ')');
  await h.flush(); assertStage(h, 'New Lead'); assert.equal(h.requests.length, 0);
});
