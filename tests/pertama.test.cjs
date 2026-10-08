const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
// This option proves RED against the committed baseline even during concurrent source edits.
const source = process.env.PERTAMA_TEST_BASELINE === '1'
  ? execFileSync('git', ['show', 'd429293:pertama.js'], { cwd: ROOT, encoding: 'utf8' })
  : fs.readFileSync(path.join(ROOT, 'pertama.js'), 'utf8');
const LOCATION = '3QixdLNutDXye95tTBK0';
const CONTACT_PATH = `/v2/location/${LOCATION}/contacts/detail/contact-a`;
const BOARD_PATH = `/v2/location/${LOCATION}/opportunities`;
const QUEUE_KEY = `pertama:stage-queue:${LOCATION}`;
const queue = { contactId: 'contact-a', opportunityId: 'opp-a', pipelineId: 'pipe-a', stageId: 'stage-atc' };
const pipelines = [{ id: 'pipe-a', name: 'Sales', stages: { 'New Lead': 'stage-new', 'Attempted Contact': 'stage-atc', Robot: 'stage-robot' } }];
const plain = value => JSON.parse(JSON.stringify(value));
function harness(t, { route = CONTACT_PATH, session = {}, fetchResponse, xhr = false } = {}) {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM('<!doctype html><body><nav><a>Message hub</a><a>Settings</a></nav><button id="tb_business">Companies</button></body>', {
    url: `https://go.pertamaproperty.com${route}`, runScripts: 'outside-only', virtualConsole,
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  for (const key of ['Headers', 'Request', 'Response', 'AbortController']) w[key] = globalThis[key];
  w.HTMLElement.prototype.getClientRects = function () { return this.hidden ? [] : [{ width: 200 }]; };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const requests = [];
  let response = result([]);
  w.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const data = fetchResponse ? await fetchResponse(requests.at(-1)) : response;
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  // Fake only the XHR transport; the userscript still installs its real observers.
  const xhrRequests = [];
  w.XMLHttpRequest.prototype.send = function (body) {
    if (!xhr) throw new Error('Unexpected XHR in test');
    xhrRequests.push({ request: this, body });
  };
  const alerts = [];
  w.alert = message => alerts.push(message);
  for (const [key, value] of Object.entries(session)) w.sessionStorage.setItem(key, value);
  w.localStorage.setItem(`pertama:pipelines:${LOCATION}`, JSON.stringify({ pipelines }));
  assert.match(source, /\}\)\(\);\s*$/);
  w.eval(source.replace(/\}\)\(\);\s*$/, 'globalThis.__test = { evaluate(code) { return eval(code); } };\n})();'));
  const evaluate = code => w.__test.evaluate(code);
  evaluate('initializeButtons()');
  const claims = { user_id: 'user-a', sub: 'user-a', locations: [LOCATION], exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = `test.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.test`;
  evaluate(`captureReadHeaders('https://services.leadconnectorhq.com/opportunities/search', { authorization: ${JSON.stringify(`Bearer ${token}`)} })`);
  return { w, evaluate, requests, xhrRequests, alerts,
    finishXhr(request, data, status = 200) {
      Object.defineProperties(request, {
        status: { configurable: true, value: status },
        response: { configurable: true, value: data },
        responseText: { configurable: true, value: JSON.stringify(data) },
      });
      request.dispatchEvent(new w.Event('loadend'));
    },
    respond(data) { response = data; }, route(value) { w.history.pushState({}, '', value); },
    pin(value = queue) { return evaluate(`pinStageQueue(${JSON.stringify(value)})`); } };
}
function hit(contactId = 'contact-b', opportunityId = 'opp-b', overrides = {}) {
  return { _id: opportunityId, _source: { contactId, pipelineId: 'pipe-a', pipelineStageId: 'stage-atc', locationId: LOCATION, ...overrides } };
}
function result(hits, stageId = 'stage-atc') {
  return { aggregations: { pipelines: { docCountErrorUpperBound: 0, sumOtherDocCount: 0,
    buckets: [{ key: stageId, docCount: hits.length, topOpportunities: { hits: { hits } } }] } } };
}
function fields(filters, name) {
  return filters.flatMap(f => f.filters ? fields(f.filters, name) : f.field === name ? [f] : []);
}

test('priority validation accepts stage but rejects unknown modes', t => {
  const h = harness(t);
  assert.equal(h.evaluate("validateSettings({ ...settings, priority: 'stage' }).priority"), 'stage');
  assert.throws(() => h.evaluate("validateSettings({ ...settings, priority: 'other' })"), /priority/i);
});

test('pinned stage survives refresh and resolves its name from current catalog', t => {
  const h = harness(t);
  h.pin();
  const saved = h.w.sessionStorage.getItem(QUEUE_KEY);
  assert.deepEqual(JSON.parse(saved), queue);
  const refreshed = harness(t, { session: { [QUEUE_KEY]: saved } });
  refreshed.evaluate('syncStageQueue()');
  assert.deepEqual(plain(refreshed.evaluate('stageQueueContext().queue')), queue);
  refreshed.evaluate("NAV_PIPELINES[0].stages['Renamed attempt'] = NAV_PIPELINES[0].stages['Attempted Contact']; delete NAV_PIPELINES[0].stages['Attempted Contact']");
  assert.equal(refreshed.evaluate('stageQueueContext().stage'), 'Renamed attempt');
});

test('unrelated manual contact navigation clears queue', t => {
  const h = harness(t); h.pin();
  h.route(CONTACT_PATH.replace('contact-a', 'unrelated'));
  h.evaluate('syncStageQueue()');
  assert.equal(h.evaluate('stageQueueContext()'), null);
  assert.equal(h.w.sessionStorage.getItem(QUEUE_KEY), null);
});

test('same-stage lookup replaces nested stage filters, keeps other filters/sort and scopes current user', async t => {
  const h = harness(t);
  const template = plain(h.evaluate('defaultPipelineQuery(NAV_PIPELINES[0])'));
  template.filters.push({ group: 'AND', filters: [
    { field: 'pipeline_stage_id', operator: 'eq', value: ['stage-new'] },
    { group: 'OR', filters: [{ field: 'pipeline_stage_id', operator: 'neq', value: ['stage-robot'] }] },
    { field: 'status', operator: 'eq', value: ['open'] },
    { field: 'assigned_to', operator: 'eq', value: ['someone-else'] },
  ] });
  template.sort = [{ field: 'created_at', direction: 'desc' }];
  h.evaluate(`queryTemplates['pipe-a'] = ${JSON.stringify(template)}`);
  h.respond(result([hit('contact-a', 'opp-a'), hit()]));
  const lead = plain(await h.evaluate("topPipelineLead(NAV_PIPELINES[0], 'Attempted Contact', 'contact-a', true)"));
  assert.deepEqual(lead, { contactId: 'contact-b', opportunityId: 'opp-b', pipeline: 'Sales', pipelineId: 'pipe-a', stageId: 'stage-atc' });
  assert.equal(h.requests.length, 1);
  const body = h.requests[0].body;
  assert.deepEqual(body.sort, template.sort);
  assert.deepEqual(fields(body.filters, 'status'), [{ field: 'status', operator: 'eq', value: ['open'] }]);
  assert.ok(fields(body.filters, 'pipeline_stage_id').length > 0);
  for (const filter of fields(body.filters, 'pipeline_stage_id')) {
    assert.equal(filter.operator, 'eq'); assert.deepEqual(filter.value, ['stage-atc']);
  }
  assert.deepEqual(fields(body.filters, 'assigned_to').map(f => f.value), [['user-a']]);
  assert.deepEqual(fields(body.filters, 'followers').map(f => f.value), [['user-a']]);
  assert.deepEqual(body.aggregations[0].options.include, ['stage-atc']);
  assert.deepEqual(plain(h.evaluate("queryTemplates['pipe-a']")), template, 'saved template is not mutated');
});

test('empty same-stage queue ignores selected pipelines and never falls back to tasks', async t => {
  const h = harness(t); h.pin();
  h.evaluate("settings.priority = 'stage'; settings.pipelineIds = ['missing-pipeline']; settings.newLeadStage = 'missing-stage'");
  h.respond(result([hit('contact-a', 'opp-a')]));
  assert.equal(await h.evaluate('findNextActionable()'), null);
  assert.equal(h.requests.length, 1);
  assert.ok(h.requests.every(r => r.url.endsWith('/opportunities/search')));
});

test('changing account clears pinned queue', t => {
  const h = harness(t); h.pin();
  h.route(CONTACT_PATH.replace(LOCATION, 'other-account'));
  h.evaluate('syncStageQueue()');
  assert.equal(h.evaluate('stageQueueContext()'), null);
  assert.equal(h.w.sessionStorage.getItem(QUEUE_KEY), null);
});

test('openLead pins IDs before navigation and intentional handoff survives route sync', t => {
  const h = harness(t); h.pin();
  h.evaluate("openLead({ contactId: 'contact-b', opportunityId: 'opp-b', pipeline: 'Sales', pipelineId: 'pipe-a', stageId: 'stage-atc' })");
  const expected = { ...queue, contactId: 'contact-b', opportunityId: 'opp-b' };
  assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(QUEUE_KEY)), expected);
  // jsdom cannot perform location.assign; emulate the browser reaching its destination.
  h.route(CONTACT_PATH.replace('contact-a', 'contact-b'));
  h.evaluate('syncStageQueue()');
  assert.deepEqual(plain(h.evaluate('stageQueueContext().queue')), expected);
});

for (const invalid of [
  { ...queue, stageId: 'nonexistent' }, { ...queue, pipelineId: 'nonexistent' },
  { ...queue, stageId: null }, { ...queue, opportunityId: '' },
]) {
  test(`persisted malformed queue fails closed: ${JSON.stringify(invalid)}`, t => {
    const h = harness(t, { session: { [QUEUE_KEY]: JSON.stringify(invalid) } });
    assert.equal(h.evaluate('stageQueueContext()'), null);
    assert.equal(h.requests.length, 0);
  });
}

for (const priority of ['leads', 'tasks']) {
  test(`legacy ${priority} priority retains lookup order`, async t => {
    const h = harness(t);
    h.evaluate(`settings.priority = '${priority}'; settings.pipelineIds = ['pipe-a']`);
    const order = [];
    h.w.__order = order;
    // Dispatch-only test: parser and network behavior are tested separately with real helpers.
    h.evaluate("topPipelineLead = async () => { __order.push('leads'); return null; }; topTaskContact = async () => { __order.push('tasks'); return null; }");
    assert.equal(await h.evaluate('findNextActionable()'), null);
    assert.deepEqual(order, priority === 'tasks' ? ['tasks', 'leads'] : ['leads', 'tasks']);
  });
}

function clickBoardCard(h, { contactId = 'contact-a', opportunityId = 'opp-a', pipeline = 'Sales' } = {}) {
  const wrapper = h.w.document.createElement('section');
  wrapper.innerHTML = `<button>${pipeline}</button><div class="card" id="${opportunityId}"><a href="/v2/location/${LOCATION}/contacts/detail/${contactId}">Contact</a></div>`;
  h.w.document.body.append(wrapper);
  h.evaluate('rememberBoardContact({ target: document.querySelector(".card a") })');
  return wrapper;
}

function rememberSnapshot(h, data) {
  return h.evaluate(`rememberStageResults(${JSON.stringify(data)}, observeStageRequest('POST', 'https://services.leadconnectorhq.com/opportunities/search'))`);
}

test('board snapshot pins exact opportunity, contact, pipeline and stage', t => {
  const h = harness(t, { route: BOARD_PATH });
  rememberSnapshot(h, result([hit('contact-a', 'opp-other', { pipelineStageId: 'stage-atc' }), hit('contact-a', 'opp-a')]));
  clickBoardCard(h);
  assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(QUEUE_KEY)), queue);
});

test('board snapshot does not infer stage for an unmatched opportunity', t => {
  const h = harness(t, { route: BOARD_PATH });
  rememberSnapshot(h, result([hit('contact-a', 'opp-other')]));
  clickBoardCard(h);
  assert.equal(h.w.sessionStorage.getItem(QUEUE_KEY), null);
});

test('opportunity mutation invalidates snapshots and rejects late pre-mutation responses', t => {
  const h = harness(t, { route: BOARD_PATH });
  const revision = h.evaluate("observeStageRequest('POST', 'https://services.leadconnectorhq.com/opportunities/search')");
  assert.equal(typeof revision, 'number');
  h.evaluate(`rememberStageResults(${JSON.stringify(result([hit('contact-a', 'opp-a')]))}, ${revision})`);
  h.evaluate("observeStageRequest('PUT', 'https://services.leadconnectorhq.com/opportunities/opp-a')");
  h.evaluate(`rememberStageResults(${JSON.stringify(result([hit('contact-a', 'opp-a')]))}, ${revision})`);
  clickBoardCard(h);
  assert.equal(h.w.sessionStorage.getItem(QUEUE_KEY), null);
});

test('updated opportunity stage does not move an already pinned queue', t => {
  const h = harness(t); h.pin();
  h.evaluate("observeStageRequest('PUT', 'https://services.leadconnectorhq.com/opportunities/opp-a')");
  h.evaluate(`rememberStageResults(${JSON.stringify(result([hit('contact-a', 'opp-a', { pipelineStageId: 'stage-robot' })], 'stage-robot'))}, 0)`);
  assert.equal(h.evaluate('stageQueueContext().queue.stageId'), 'stage-atc');
});

test('fetch observer captures board responses without extra network calls', async t => {
  const h = harness(t, { route: BOARD_PATH });
  h.respond(result([hit('contact-a', 'opp-a')]));
  await h.w.fetch('https://services.leadconnectorhq.com/opportunities/search', {
    method: 'POST', body: JSON.stringify(plain(h.evaluate('defaultPipelineQuery(NAV_PIPELINES[0])'))),
  });
  await new Promise(resolve => setImmediate(resolve));
  clickBoardCard(h);
  assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(QUEUE_KEY)), queue);
  assert.equal(h.requests.length, 1);
});

test('same-stage response from wrong pipeline is rejected without task fallback', async t => {
  const h = harness(t); h.pin();
  h.evaluate("settings.priority = 'stage'");
  h.respond(result([hit('contact-b', 'opp-b', { pipelineId: 'pipe-wrong' })]));
  await assert.rejects(h.evaluate('findNextActionable()'), /pipeline|stage|match/i);
  assert.equal(h.requests.length, 1);
});

test('same-stage lookup requires verified identity before sending a request', async t => {
  const h = harness(t); h.pin();
  h.evaluate("settings.priority = 'stage'; currentUserId = null; identityExpires = 0");
  await assert.rejects(h.evaluate('findNextActionable()'), /verified/i);
  assert.equal(h.requests.length, 0);
});

test('settings dialog offers and saves same-stage priority', t => {
  const h = harness(t);
  h.evaluate('openSettings()');
  const form = h.w.document.querySelector('#pertama-settings form');
  assert.ok(form.querySelector('select[name="priority"] option[value="stage"]'));
  form.elements.namedItem('priority').value = 'stage';
  form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(JSON.parse(h.w.localStorage.getItem(`pertama:settings:${LOCATION}`)).priority, 'stage');
});

test('explicit picker requires stage choice and pins chosen opportunity before resolving', { timeout: 3000 }, async t => {
  const h = harness(t);
  h.w.document.body.insertAdjacentHTML('beforeend', `<div class="opportunities-pane-list"><a href="/v2/location/${LOCATION}/opportunities/opp-a?pipelineId=pipe-a">Sales opportunity</a></div>`);
  const pending = h.evaluate('ensureStageQueue()');
  await new Promise(resolve => setImmediate(resolve));
  const dialog = h.w.document.querySelector('#pertama-stage-queue');
  assert.ok(dialog, 'an explicit queue picker appears');
  const form = dialog.querySelector('form');
  const opportunity = form.elements.namedItem('opportunity');
  const stage = form.elements.namedItem('stage');
  assert.equal(stage.value, '', 'stage must not silently default');
  const option = [...opportunity.options].find(option => option.value);
  assert.ok(option);
  opportunity.value = option.value;
  opportunity.dispatchEvent(new h.w.Event('change', { bubbles: true }));
  stage.value = 'stage-atc';
  stage.dispatchEvent(new h.w.Event('change', { bubbles: true }));
  form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  await pending;
  assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(QUEUE_KEY)), queue);
  assert.equal(h.requests.length, 0);
});

function opportunityFixture(h) {
  h.w.document.body.insertAdjacentHTML('beforeend', `<div class="opportunities-pane-list"><a href="/v2/location/${LOCATION}/opportunities/opp-a?pipelineId=pipe-a">Sales opportunity</a></div>`);
  h.w.document.querySelector('.opportunities-pane-list a').addEventListener('click', event => event.preventDefault());
}
const flush = () => new Promise(resolve => setImmediate(resolve));

for (const action of ['cancel', 'contact change', 'navigate away and back']) {
  test(`picker ${action} never pins a queue or searches`, { timeout: 3000 }, async t => {
    const h = harness(t); opportunityFixture(h);
    const pending = h.evaluate('ensureStageQueue()');
    // Attach rejection handler immediately: contact-change cancellation may reject.
    const settled = pending.then(value => ({ value }), error => ({ error }));
    await flush();
    const dialog = h.w.document.querySelector('#pertama-stage-queue');
    assert.ok(dialog);
    assert.equal(dialog.querySelector('[name="stage"]').value, '');
    if (action === 'cancel') {
      const cancel = [...dialog.querySelectorAll('button')].find(button => button.textContent.trim() === 'Cancel');
      assert.ok(cancel); cancel.click();
    } else {
      const opportunity = dialog.querySelector('[name="opportunity"]');
      opportunity.value = [...opportunity.options].find(option => option.value).value;
      opportunity.dispatchEvent(new h.w.Event('change', { bubbles: true }));
      dialog.querySelector('[name="stage"]').value = 'stage-atc';
      h.route(CONTACT_PATH.replace('contact-a', 'manual-contact'));
      if (action === 'navigate away and back') h.route(CONTACT_PATH);
      dialog.querySelector('form').dispatchEvent(new h.w.Event('submit', { cancelable: true, bubbles: true }));
    }
    const outcome = await settled;
    assert.ok(outcome.error || !outcome.value, 'cancelled selection cannot resolve to a queue');
    assert.equal(h.w.sessionStorage.getItem(QUEUE_KEY), null);
    assert.equal(h.requests.length, 0);
  });
}

test('in-flight lookup rejects after unrelated route change rather than opening its result', async t => {
  let release;
  const response = new Promise(resolve => { release = resolve; });
  const h = harness(t, { fetchResponse: () => response }); h.pin();
  h.evaluate("settings.priority = 'stage'");
  const lookup = h.evaluate('findNextActionable()');
  const rejected = assert.rejects(lookup, /changed|cancelled/i);
  await flush();
  assert.equal(h.requests.length, 1);
  h.route(CONTACT_PATH.replace('contact-a', 'manual-contact'));
  release(result([hit()]));
  await rejected;
  assert.equal(h.w.sessionStorage.getItem(QUEUE_KEY), null);
});

test('quick away-and-back navigation invalidates an in-flight lookup', async t => {
  let release;
  const response = new Promise(resolve => { release = resolve; });
  const h = harness(t, { fetchResponse: () => response }); h.pin();
  h.evaluate("settings.priority = 'stage'");
  const lookup = h.evaluate('findNextActionable()');
  const rejected = assert.rejects(lookup, /changed|cancelled/i);
  await flush();
  h.route(BOARD_PATH);
  h.route(CONTACT_PATH);
  release(result([hit()]));
  await rejected;
  assert.equal(h.w.sessionStorage.getItem(QUEUE_KEY), null);
});

test('Next lead uses pinned queue and shows stage-specific empty notice without tasks', async t => {
  const h = harness(t); h.pin();
  h.evaluate("settings.priority = 'stage'; settings.pipelineIds = ['unrelated']; settings.newLeadStage = 'missing'");
  h.respond(result([hit('contact-a', 'opp-a')]));
  await h.evaluate('nextLead()');
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].body.aggregations[0].options.include, ['stage-atc']);
  assert.match(h.w.document.querySelector('#pertama-task-notice').textContent, /No other matching leads.*Sales.*Attempted Contact/);
  assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(QUEUE_KEY)), queue);
  assert.equal(h.w.document.querySelector('#pertama-next-lead-button').disabled, false);
});

test('Next lead resolves missing context through actual picker before lookup', { timeout: 3000 }, async t => {
  const h = harness(t); opportunityFixture(h);
  h.evaluate("settings.priority = 'stage'");
  h.respond(result([hit()]));
  const pending = h.evaluate('nextLead()');
  await flush();
  const dialog = h.w.document.querySelector('#pertama-stage-queue');
  assert.ok(dialog);
  assert.equal(h.requests.length, 0);
  assert.equal(dialog.querySelector('[name="stage"]').value, '');
  const opportunity = dialog.querySelector('[name="opportunity"]');
  opportunity.value = [...opportunity.options].find(option => option.value).value;
  opportunity.dispatchEvent(new h.w.Event('change', { bubbles: true }));
  dialog.querySelector('[name="stage"]').value = 'stage-atc';
  dialog.querySelector('form').dispatchEvent(new h.w.Event('submit', { cancelable: true, bubbles: true }));
  await pending;
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(QUEUE_KEY)), { ...queue, contactId: 'contact-b', opportunityId: 'opp-b' });
});

test('XHR board search observer captures results and invalidates on write completion', t => {
  const h = harness(t, { route: BOARD_PATH, xhr: true });
  const search = new h.w.XMLHttpRequest();
  search.open('POST', 'https://services.leadconnectorhq.com/opportunities/search');
  search.responseType = 'json';
  search.send(JSON.stringify(plain(h.evaluate('defaultPipelineQuery(NAV_PIPELINES[0])'))));
  h.finishXhr(search, result([hit('contact-a', 'opp-a')]));
  const card = clickBoardCard(h);
  assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(QUEUE_KEY)), queue);
  h.evaluate('clearStageQueue()'); card.remove();
  const write = new h.w.XMLHttpRequest();
  write.open('PUT', 'https://services.leadconnectorhq.com/opportunities/opp-a');
  write.send(JSON.stringify({ pipelineStageId: 'stage-robot' }));
  assert.equal(h.evaluate("observeStageRequest('POST', 'https://services.leadconnectorhq.com/opportunities/search')"), null);
  h.finishXhr(write, {});
  assert.equal(typeof h.evaluate("observeStageRequest('POST', 'https://services.leadconnectorhq.com/opportunities/search')"), 'number');
  clickBoardCard(h);
  assert.equal(h.w.sessionStorage.getItem(QUEUE_KEY), null);
  assert.equal(h.xhrRequests.length, 2);
  assert.equal(h.requests.length, 0);
});

test('overlapping writes reject snapshots before and during writes, even after settlement', t => {
  const h = harness(t, { route: BOARD_PATH });
  const snapshot = JSON.stringify(result([hit('contact-a', 'opp-a')]));
  const query = "observeStageRequest('POST', 'https://services.leadconnectorhq.com/opportunities/search')";
  const before = h.evaluate(query);
  assert.equal(typeof before, 'number');
  h.evaluate(`rememberStageResults(${snapshot}, ${before})`);
  h.evaluate("globalThis.__writeA = observeStageRequest('PUT', 'https://services.leadconnectorhq.com/opportunities/opp-a'); globalThis.__writeB = observeStageRequest('PATCH', 'https://services.leadconnectorhq.com/opportunities/opp-b')");
  assert.deepEqual(plain(h.w.__writeA), { write: true, finished: false });
  assert.equal(h.evaluate(query), null);
  h.evaluate(`rememberStageResults(${snapshot}, ${before}); rememberStageResults(${snapshot}, null)`);
  h.evaluate('finishStageWrite(__writeA); finishStageWrite(__writeA)');
  assert.equal(h.evaluate(query), null, 'duplicate completion must not finish the other pending write');
  h.evaluate('finishStageWrite(__writeB)');
  assert.equal(typeof h.evaluate(query), 'number');
  assert.notEqual(h.evaluate(query), before);
  h.evaluate(`rememberStageResults(${snapshot}, ${before}); rememberStageResults(${snapshot}, null)`);
  const card = clickBoardCard(h);
  assert.equal(h.w.sessionStorage.getItem(QUEUE_KEY), null);
  card.remove();
  // A fresh post-settlement search can establish a queue again.
  h.evaluate(`rememberStageResults(${snapshot}, ${query})`);
  clickBoardCard(h);
  assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(QUEUE_KEY)), queue);
});

for (const changeRoute of [false, true]) {
test(changeRoute ? 'Save and next refuses saves after leaving and returning during confirmation'
  : 'Save and next preserves original queue through confirmed stage save and excludes current contact', { timeout: 3000 }, async t => {
  const h = harness(t, { fetchResponse: request => request.method === 'PUT'
    ? { opportunity: { id: 'opp-a', contactId: 'contact-a', pipelineId: 'pipe-a', pipelineStageId: 'stage-robot' } }
    : result([hit('contact-a', 'opp-a'), hit()]) });
  h.pin(); opportunityFixture(h);
  h.evaluate("settings.priority = 'stage'; settings.rules['Attempted Contact'].next = 'Robot'; prepareSms = async () => ({ error: 'No SMS composer in fixture' })");
  h.w.document.body.insertAdjacentHTML('beforeend', `
    <div id="record-details-tabs"><div class="hr-tabs-rail"><div></div><div><span>All fields</span></div></div></div>
    <input id="contact.first_name" value="Ada"><input id="contact.last_name" value="Test">
    <div id="owner-dropdown-trigger"><span>Ada Owner</span></div>
    <div id="modal"><span>Sales</span><div id="OpportunityStage"><button class="hr-base-selection-label">Stage</button><span class="hr-base-selection-input__content">Attempted Contact</span></div>
    <div class="hr-base-select-option"><p>Attempted Contact</p></div><div class="hr-base-select-option"><p>Robot</p></div>
    <button id="CreateUpdateOpportunity">Save</button><button id="modal-header-modal-close-btn">Close</button></div>`);
  for (const option of h.w.document.querySelectorAll('.hr-base-select-option p')) {
    option.addEventListener('click', () => { h.w.document.querySelector('.hr-base-selection-input__content').textContent = option.textContent; });
  }
  h.w.document.querySelector('#CreateUpdateOpportunity').addEventListener('click', () => {
    void h.w.fetch('https://services.leadconnectorhq.com/opportunities/opp-a', {
      method: 'PUT', body: JSON.stringify({ pipelineId: 'pipe-a', pipelineStageId: 'stage-robot' }),
    });
  });
  const pending = h.evaluate('run()');
  await flush();
  const dialog = h.w.document.querySelector('#pertama-confirm-actions');
  assert.ok(dialog, h.alerts.join('\n'));
  const form = dialog.querySelector('form');
  form.elements.namedItem('stage').checked = true;
  form.elements.namedItem('targetStage').value = 'Robot';
  for (const name of ['note', 'task', 'sms']) form.elements.namedItem(name).checked = false;
  form.dispatchEvent(new h.w.Event('change', { bubbles: true }));
  if (changeRoute) { h.route(BOARD_PATH); h.route(CONTACT_PATH); }
  form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  await pending;
  if (changeRoute) {
    assert.equal(h.requests.length, 0, 'a stale confirmation must not save anything');
    assert.match(h.alerts.join('\n'), /queue.*changed|changed.*queue/i);
    return;
  }
  assert.deepEqual(h.alerts, []);
  assert.equal(h.requests.length, 2, 'one simulated CRM save and one read-only next lookup');
  assert.equal(h.requests[0].method, 'PUT');
  assert.equal(h.requests[1].method, 'POST');
  assert.deepEqual(h.requests[1].body.aggregations[0].options.include, ['stage-atc'], 'lookup stays on original stage after save');
  assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(QUEUE_KEY)), { ...queue, contactId: 'contact-b', opportunityId: 'opp-b' }, 'current contact was excluded');
  assert.equal(h.w.localStorage.getItem(`pertama:no-answer:unfinished:${LOCATION}:contact-a`), null);
});

}

test('mutation start and settlement do not drift the pinned original stage', t => {
  const h = harness(t); h.pin();
  h.evaluate("globalThis.__write = observeStageRequest('PUT', 'https://services.leadconnectorhq.com/opportunities/opp-a')");
  assert.equal(h.evaluate('stageQueueContext().queue.stageId'), 'stage-atc');
  h.evaluate('finishStageWrite(__write)');
  assert.deepEqual(plain(h.evaluate('stageQueueContext().queue')), queue);
});
