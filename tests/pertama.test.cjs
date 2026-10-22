const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { JSDOM, VirtualConsole } = require('jsdom');
const { installWebGlobals, evaluateUserscript } = require('./helpers/userscript.cjs');

const ROOT = path.resolve(__dirname, '..');
// This option proves RED against the committed baseline even during concurrent source edits.
const source = process.env.PERTAMA_TEST_BASELINE === '1'
  ? execFileSync('git', ['show', 'd429293:pertama.js'], { cwd: ROOT, encoding: 'utf8' })
  : fs.readFileSync(path.join(ROOT, 'gohigherlevel.user.js'), 'utf8');
const LOCATION = '3QixdLNutDXye95tTBK0';
const CONTACT_PATH = `/v2/location/${LOCATION}/contacts/detail/contact-a`;
const BOARD_PATH = `/v2/location/${LOCATION}/opportunities`;
const QUEUE_KEY = `pertama:stage-queue:${LOCATION}`;
const queue = { contactId: 'contact-a', opportunityId: 'opp-a', pipelineId: 'pipe-a', stageId: 'stage-atc' };
const pipelines = [{ id: 'pipe-a', name: 'Sales', stages: { 'New Lead': 'stage-new', 'Attempted Contact': 'stage-atc', Robot: 'stage-robot' } }];
const plain = value => JSON.parse(JSON.stringify(value));
function harness(t, { route = CONTACT_PATH, session = {}, fetchResponse, xhr = false, storedSettings } = {}) {
  const virtualConsole = new VirtualConsole();
  const navigationErrors = [];
  virtualConsole.on('jsdomError', error => { if (/navigation/i.test(error.message)) navigationErrors.push(error); });
  const dom = new JSDOM('<!doctype html><body><nav><a>Message hub</a><a>Settings</a></nav><button id="tb_business">Companies</button></body>', {
    url: `https://go.pertamaproperty.com${route}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  installWebGlobals(w);
  w.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{ width: 200 }]; };
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
  if (storedSettings) w.localStorage.setItem(`pertama:settings:${LOCATION}`, JSON.stringify(storedSettings));
  const evaluate = evaluateUserscript(w, source);
  evaluate('initializeButtons()');
  const claims = { user_id: 'user-a', sub: 'user-a', locations: [LOCATION], exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = `test.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.test`;
  evaluate(`captureReadHeaders('https://services.leadconnectorhq.com/opportunities/search', { authorization: ${JSON.stringify(`Bearer ${token}`)} })`);
  return { w, evaluate, requests, xhrRequests, alerts, navigationErrors,
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
test('progress controller preserves evidence, blocks dismissal and reattaches stopped results', t => {
  const h = harness(t);
  const p = h.evaluate(`createSaveProgress({ name: '<b>Ada</b>', pipelineName: 'Sales', choices: { stage: true, note: true, task: true, sms: true } })`);
  const d = h.w.document.querySelector('#pertama-save-progress');
  const row = key => d.querySelector(`[data-action="${key}"]`);
  assert.equal(d.open, true);
  assert.equal(d.querySelector('b'), null);
  assert.equal(row('complete').dataset.state, 'waiting');
  for (const el of d.querySelectorAll('[data-action]')) assert.equal(el.querySelector('small').textContent, 'Checking');
  assert.equal(d.querySelector('[data-close]').hidden, true);
  assert.equal(d.querySelector('[data-footer]'), null, 'no redundant navigation status below the actions');
  assert.equal(d.querySelector('[data-live]').getAttribute('class'), 'visually-hidden', 'screen-reader announcements remain off screen');
  assert.equal(d.style.padding, '18px 20px', 'progress dialog uses tighter spacing');
  assert.match(d.querySelector('style').textContent, /\[data-action\]\{display:flex;gap:10px;padding:8px 0/, 'action rows use tighter spacing');
  p.phase('Opening next lead…');
  assert.equal(d.querySelector('h2').textContent, 'Opening next lead…');
  assert.equal(d.querySelector('[data-rows]').nextElementSibling?.hasAttribute('data-report'), true, 'only the hidden error report follows the action rows');
  const cancel = new h.w.Event('cancel', { cancelable: true }); d.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(d.querySelectorAll('[data-action="complete"]').length, 1);
  p.start('stage', 'Saving…'); p.dispatched('stage'); p.confirm('stage'); p.fail('stage');
  assert.equal(row('stage').dataset.state, 'confirmed');
  p.start('note'); p.fail('note'); assert.equal(row('note').dataset.state, 'failed');
  p.dispatched('task'); p.created(); p.fail('task');
  assert.match(row('task').textContent, /Created; contact link not sent/);
  p.dispatched('task', 'link'); p.fail('task');
  assert.match(row('task').textContent, /link unverified/);
  p.dispatched('complete'); p.fail('complete');
  assert.equal(row('complete').dataset.state, 'unverified');
  p.remove(); p.remove(); assert.equal(d.isConnected, false);
  p.stop('<img> navigation failed');
  assert.equal(d.isConnected, true); assert.equal(row('sms').dataset.state, 'blocked');
  assert.equal(d.querySelector('img'), null);
  assert.equal(d.querySelector('[data-close]').hidden, false);
  d.querySelector('[data-close]').click(); assert.equal(d.isConnected, false);
});

for (const choices of [{ note: true, sms: true }, {}]) {
  test(`progress immediately shows fixed rows with exact initial labels: ${JSON.stringify(choices)}`, t => {
    const h = harness(t);
    const p = h.evaluate(`createSaveProgress({ name: 'Ada', pipelineName: 'Sales', choices: ${JSON.stringify(choices)} })`);
    const d = h.w.document.querySelector('#pertama-save-progress');
    const rows = [...d.querySelectorAll('[data-action]')];
    assert.deepEqual(rows.map(row => row.dataset.action), ['stage', 'note', 'complete', 'task', 'sms']);
    for (const row of rows) {
      const waiting = row.dataset.action === 'complete' || choices[row.dataset.action];
      assert.equal(row.hidden, false);
      assert.equal(row.dataset.state, waiting ? 'waiting' : 'skipped');
      assert.equal(row.querySelector('small').textContent, waiting ? 'Checking' : 'Skipped');
      assert.equal(row.querySelector('[data-icon]').textContent, waiting ? '○' : '–');
    }
    p.skip('complete');
    p.stop('Save failed');
    assert.deepEqual([...d.querySelectorAll('[data-action]')], rows);
    for (const row of rows) {
      const selected = choices[row.dataset.action];
      assert.equal(row.dataset.state, selected ? 'blocked' : 'skipped');
      assert.equal(row.querySelector('small').textContent, selected ? 'Not run' : 'Skipped');
    }
  });
}

for (const matchingTask of [false, true]) {
  test(`Save and next resolves completion on the original row: matching task ${matchingTask}`, async t => {
    let completed = false;
    const h = harness(t, { fetchResponse: request => {
      assert.equal(request.method, 'PUT');
      assert.deepEqual(request.body, { completed: true, ids: ['call-a'] });
      completed = true;
      return { succeded: true };
    } });
    apiContactFixture(h);
    let release;
    h.w.__lookupGate = new Promise(resolve => { release = resolve; });
    h.w.__taskRows = () => matchingTask ? [{ id: 'call-a', properties: { title: 'Call Ada Test', completed },
      relations: [{ associationId: 'TASK_CONTACT_ASSOCIATION', relationId: 'relation-a' }] }] : [];
    h.evaluate(`settings.task = 'Call {fullName}';
      readCallTasks = async () => { await __lookupGate; return { rows: __taskRows(), total: __taskRows().length }; };
      findNextActionable = async () => { throw new Error('Keep results visible'); };`);
    const pending = h.evaluate('run()'); await flush();
    const form = h.w.document.querySelector('#pertama-confirm-actions form');
    for (const key of ['stage', 'note', 'task', 'sms']) form.elements.namedItem(key).checked = false;
    form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
    const d = h.w.document.querySelector('#pertama-save-progress');
    const rows = [...d.querySelectorAll('[data-action]')];
    assert.deepEqual(rows.map(row => row.dataset.action), ['stage', 'note', 'complete', 'task', 'sms']);
    await flush();
    assert.equal(rows[2].querySelector('small').textContent, 'Checking', 'lookup remains pending');
    release(); await pending;
    assert.deepEqual([...d.querySelectorAll('[data-action]')], rows, 'lookup never inserts or replaces rows');
    assert.equal(rows[2].dataset.state, matchingTask ? 'confirmed' : 'skipped');
    assert.equal(rows[2].querySelector('small').textContent, matchingTask ? 'Confirmed' : 'Skipped');
    assert.equal(completed, matchingTask);
    for (const row of rows.filter(row => row.dataset.action !== 'complete')) assert.equal(row.dataset.state, 'skipped');
  });
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

const nextLeadData = { contactId: 'contact-b', opportunityId: 'opp-b', pipeline: 'Sales', pipelineId: 'pipe-a', stageId: 'stage-atc' };
const NEXT_PATH = `/v2/location/${LOCATION}/contacts/detail/contact-b`;
function installRouter(h, overrides = {}) {
  const pushes = [];
  const router = {
    currentRoute: { value: { name: 'contact_detail-v2', path: h.w.location.pathname } },
    resolve(path) { return { name: 'contact_detail-v2', href: path }; },
    async push(path) {
      pushes.push(path);
      h.route(path);
      router.currentRoute.value = { name: 'contact_detail-v2', path };
      for (const id of ['contact.first_name', 'contact.last_name', 'contact.phone', 'owner-dropdown-trigger',
        'tasks-list-container-contact', 'conv-composer-textarea-input', 'conv-send-button-simple']) {
        h.w.document.getElementById(id)?.remove();
      }
    },
    ...overrides,
  };
  const root = h.w.document.createElement('div'); root.setAttribute('data-v-app', '');
  root.__vue_app__ = { config: { globalProperties: { $router: router } } };
  h.w.document.body.append(root);
  return { router, pushes };
}
const openNext = async h => h.evaluate(`openLead(${JSON.stringify(nextLeadData)})`);

test('progress is removed at native route commit before old controls retire', async t => {
  const h = harness(t); h.pin();
  h.w.document.body.insertAdjacentHTML('beforeend', '<input id="contact.first_name">');
  const old = h.w.document.getElementById('contact.first_name');
  const { router } = installRouter(h, { async push(path) { h.route(path); router.currentRoute.value = { name: 'contact_detail-v2', path }; } });
  h.evaluate(`globalThis.__progress = createSaveProgress({ name: 'Original Ada', pipelineName: 'Sales', choices: { note: true } }); __progress.confirm('note');`);
  const pending = h.evaluate(`openLead(${JSON.stringify(nextLeadData)}, () => __progress.remove())`);
  await flush();
  assert.equal(old.isConnected, true);
  assert.equal(h.w.document.querySelector('#pertama-save-progress'), null);
  old.remove(); await pending;
});

test('progress reattaches original-contact results after committed navigation readiness failure', async t => {
  const h = harness(t); h.pin(); fastPolling(h);
  h.w.document.body.insertAdjacentHTML('beforeend', '<input id="contact.first_name">');
  const { router } = installRouter(h, { async push(path) { h.route(path); router.currentRoute.value = { name: 'contact_detail-v2', path }; } });
  h.evaluate(`globalThis.__progress = createSaveProgress({ name: 'Original Ada', pipelineName: 'Sales', choices: { note: true } }); __progress.confirm('note');`);
  await h.evaluate(`openLead(${JSON.stringify(nextLeadData)}, () => __progress.remove()).catch(error => __progress.stop(error.message))`);
  const d = h.w.document.querySelector('#pertama-save-progress');
  assert.equal(h.w.location.pathname, NEXT_PATH);
  assert.match(d.textContent, /Original Ada/);
  assert.equal(d.querySelector('[data-action="note"]').dataset.state, 'confirmed');
  assert.match(d.querySelector('[data-report]').textContent, /previous contact controls/);
  d.querySelector('[data-close]').click(); assert.equal(d.isConnected, false);
});

test('next contact already open reports action required without invoking native navigation', async t => {
  const h = harness(t); h.pin();
  const { pushes } = installRouter(h);
  await assert.rejects(h.evaluate("openLead({ contactId: 'contact-a', opportunityId: 'opp-a', pipelineId: 'pipe-a', stageId: 'stage-atc' })"), /next top lead.*action it first/i);
  assert.deepEqual(pushes, []);
  assert.equal(h.w.location.pathname, CONTACT_PATH);
  assert.equal(h.evaluate('stageQueueContext().queue.contactId'), 'contact-a');
});
test('native navigation uses exact contact path, preserves stage queue and avoids document reload', async t => {
  const h = harness(t); h.pin();
  const emptyRoot = h.w.document.createElement('div'); emptyRoot.setAttribute('data-v-app', ''); h.w.document.body.append(emptyRoot);
  const { pushes } = installRouter(h);
  await openNext(h);
  assert.deepEqual(pushes, [NEXT_PATH]);
  assert.equal(h.w.location.pathname, NEXT_PATH);
  assert.equal(h.navigationErrors.length, 0);
  assert.equal(h.w.sessionStorage.getItem(`pertama:navigation-timing:${LOCATION}`), null);
  assert.equal(h.evaluate('stageQueueContext().queue.contactId'), 'contact-b');
  assert.equal(h.evaluate('stageQueueContext().queue.stageId'), 'stage-atc');
  const timing = plain(h.w.pertamaWorkflowTimings).find(row => row.action === 'Navigation');
  assert.equal(timing.phase, 'Native route committed');
  h.route(CONTACT_PATH);
  assert.equal(h.evaluate('stageQueueContext()'), null, 'manual navigation must still clear the queue');
});

test('repeated Next lead transitions keep the original stage without reinitializing the script', async t => {
  const h = harness(t); h.pin(); h.evaluate("settings.priority = 'stage'");
  const { pushes } = installRouter(h);
  h.evaluate(`journal.restore({ completed: ['Prior confirmation'], pendingSave: 'Prior uncertainty',
    pendingActions: { note: 'Prior note' } }); workflow.startingContact = 'prior-contact'; workflow.step = 'Prior phase';`);
  const evidence = h.evaluate('journal.completed'), actions = h.evaluate('journal.pendingActions');
  let current = 'contact-a';
  for (const next of ['contact-b', 'contact-c', 'contact-d']) {
    h.respond(result([hit(current, `opp-${current}`), hit(next, `opp-${next}`)]));
    await h.evaluate('nextLead()');
    assert.equal(h.evaluate('stageQueueContext().queue.contactId'), next);
    assert.equal(h.evaluate('stageQueueContext().queue.stageId'), 'stage-atc');
    assert.equal(h.evaluate('workflow.busy'), false);
    assert.equal(h.evaluate('journal.completed'), evidence);
    assert.equal(h.evaluate('journal.pendingActions'), actions);
    assert.equal(h.evaluate('journal.pendingSave'), 'Prior uncertainty');
    assert.equal(h.evaluate('workflow.startingContact'), 'prior-contact');
    assert.equal(h.evaluate('workflow.step'), 'Prior phase');
    current = next;
  }
  assert.equal(pushes.length, 3);
  assert.equal(h.navigationErrors.length, 0);
  assert.equal(h.requests.length, 3);
});

for (const mode of ['throw', 'failure value', 'no transition']) {
  test(`native navigation ${mode} restores source queue without retry or reload`, async t => {
    const h = harness(t); h.pin(); let attempts = 0;
    installRouter(h, { async push() { attempts++; if (mode === 'throw') throw new Error('blocked'); return mode === 'failure value' ? new Error('aborted') : undefined; } });
    await assert.rejects(openNext(h));
    assert.equal(attempts, 1);
    assert.equal(h.navigationErrors.length, 0);
    assert.deepEqual(plain(h.evaluate('stageQueueContext().queue')), queue);
    assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(QUEUE_KEY)), queue);
    assert.equal(h.w.sessionStorage.getItem('pertama:origin:contact-b'), null);
    assert.equal(plain(h.w.pertamaWorkflowTimings).some(row => row.action === 'Navigation' && row.result === 'ok'), false);
  });
}

for (const mode of ['redirect', 'away and back']) {
  test(`native ${mode} never restores a stale queue`, async t => {
    const h = harness(t); h.pin();
    installRouter(h, { async push() {
      h.route(`/v2/location/${LOCATION}/contacts/detail/contact-c`);
      if (mode === 'away and back') h.route(CONTACT_PATH);
      throw new Error('navigation interrupted');
    } });
    await assert.rejects(openNext(h));
    assert.equal(h.evaluate('stageQueueContext()'), null);
    assert.equal(h.navigationErrors.length, 0);
  });
}

test('router redirect or stale router state is not reported as successful navigation', async t => {
  const h = harness(t); h.pin();
  installRouter(h, { async push() { h.route(NEXT_PATH); } });
  await assert.rejects(openNext(h));
  assert.equal(h.navigationErrors.length, 0);
});

test('multiple matching routers fail closed before changing the queue', async t => {
  const h = harness(t); h.pin();
  const first = installRouter(h), second = installRouter(h);
  await assert.rejects(openNext(h), /router/i);
  assert.deepEqual(first.pushes, []); assert.deepEqual(second.pushes, []);
  assert.deepEqual(plain(h.evaluate('stageQueueContext().queue')), queue);
  assert.equal(h.navigationErrors.length, 0);
});

test('unavailable native router preserves full-document fallback', async t => {
  const h = harness(t);
  await openNext(h);
  assert.equal(h.navigationErrors.length, 1);
  assert.equal(JSON.parse(h.w.sessionStorage.getItem(QUEUE_KEY)).contactId, 'contact-b');
});

test('Next lead waits for native navigation and refuses a concurrent workflow', async t => {
  const h = harness(t); h.pin(); h.respond(result([hit()]));
  h.evaluate("settings.priority = 'stage'");
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const { router, pushes } = installRouter(h);
  const push = router.push;
  router.push = async path => { started(); await pending; return push(path); };
  const navigation = h.evaluate('nextLead()');
  // Bounded turn drain also fails against the old synchronous/full-page implementation.
  for (let i = 0; i < 30 && !h.navigationErrors.length; i++) await Promise.resolve();
  assert.equal(h.navigationErrors.length, 0, 'must use native navigation');
  await began;
  assert.equal(h.evaluate('workflow.busy'), true);
  await h.evaluate('nextLead(); run()');
  assert.equal(h.requests.length, 1);
  release(); await navigation;
  assert.deepEqual(pushes, [NEXT_PATH]);
  assert.equal(h.evaluate('workflow.busy'), false);
});

function retainedContactFixture(h, { hidden = false } = {}) {
  const root = h.w.document.createElement('section');
  root.hidden = hidden;
  root.innerHTML = `<input id="contact.first_name" value="Old"><input id="contact.last_name" value="Lead">
    <div id="owner-dropdown-trigger"><span>Old Owner</span></div>
    <div id="tasks-list-container-contact"><div class="tasks-card-container-style"><div><div><p>Call again Old Lead</p></div>
      <button id="completed-action"><svg class="text-gray-500"></svg></button></div></div></div>
    <textarea id="conv-composer-textarea-input">Old draft</textarea><button id="conv-send-button-simple">Send</button>`;
  h.w.document.body.append(root);
  let clicks = 0;
  root.querySelectorAll('button').forEach(button => button.addEventListener('click', () => { clicks++; }));
  let now = Date.now();
  h.w.Date.now = () => now;
  const sleeps = [], originalTimeout = h.w.setTimeout.bind(h.w);
  h.w.setTimeout = (callback, delay, ...args) => {
    if (delay === 150) { sleeps.push(callback); return 0; }
    return originalTimeout(callback, delay, ...args);
  };
  const { router } = installRouter(h, { async push(path) {
    h.route(path); router.currentRoute.value = { name: 'contact_detail-v2', path };
  } });
  h.pin(); h.respond(result([hit()])); h.evaluate("settings.priority = 'stage'");
  return { root, sleeps, clicks: () => clicks, advance(ms) { now += ms; sleeps.splice(0).forEach(callback => callback()); } };
}

test('native transition blocks automation until old contact, task and SMS controls are disconnected', async t => {
  const h = harness(t), fixture = retainedContactFixture(h);
  const navigation = h.evaluate('nextLead()');
  await flush();
  assert.equal(h.w.location.pathname, NEXT_PATH);
  assert.equal(h.evaluate('workflow.busy'), true, 'route commitment is not contact readiness');
  await assert.rejects(h.evaluate("prepareCallTask('contact-b')"), /previous contact controls/i);
  await h.evaluate('run(); nextLead()');
  assert.equal(fixture.clicks(), 0);
  assert.equal(h.requests.length, 1);
  // Replaced names alone do not make retained task/SMS controls safe.
  for (const id of ['contact.first_name', 'contact.last_name', 'owner-dropdown-trigger']) h.w.document.getElementById(id).remove();
  fixture.advance(150); await flush();
  assert.equal(h.evaluate('workflow.busy'), true);
  fixture.root.hidden = true;
  fixture.advance(150); await flush();
  assert.equal(h.evaluate('workflow.busy'), true, 'hidden old controls must not be treated as replaced');
  fixture.root.remove(); fixture.advance(150);
  await navigation;
  assert.equal(h.evaluate('workflow.busy'), false);
  assert.equal(fixture.clicks(), 0);
  assert.equal(h.navigationErrors.length, 0);
  assert.ok(plain(h.w.pertamaWorkflowTimings).some(row => row.phase === 'Previous contact controls released' && row.result === 'ok'));
});

test('controls hidden before native navigation remain blocked if revealed for the next contact', async t => {
  const h = harness(t), fixture = retainedContactFixture(h, { hidden: true });
  const navigation = h.evaluate('nextLead()'); await flush();
  assert.equal(h.w.location.pathname, NEXT_PATH);
  assert.equal(h.evaluate('workflow.busy'), true, 'initially hidden source controls also need retirement');
  fixture.root.hidden = false;
  await assert.rejects(h.evaluate("prepareCallTask('contact-b')"), /previous contact controls/i);
  await h.evaluate('run(); nextLead()');
  assert.equal(fixture.clicks(), 0);
  assert.equal(h.requests.length, 1);
  fixture.root.remove(); fixture.advance(150);
  await navigation;
  assert.equal(h.evaluate('workflow.busy'), false);
  assert.equal(h.navigationErrors.length, 0);
});

test('retained controls remain blocked after navigation readiness timeout and unblock only after removal', async t => {
  const h = harness(t), fixture = retainedContactFixture(h);
  const navigation = h.evaluate('nextLead()'); await flush();
  assert.equal(h.evaluate('workflow.busy'), true);
  assert.ok(fixture.sleeps.length);
  fixture.advance(30001); await navigation;
  assert.equal(h.evaluate('workflow.busy'), false);
  assert.equal(h.w.location.pathname, NEXT_PATH);
  h.evaluate('globalThis.__sidebarTouches = 0; globalThis.openSidebar = async () => { __sidebarTouches++; }; openSidebar = globalThis.openSidebar;');
  await assert.rejects(h.evaluate("prepareCallTask('contact-b')"), /previous contact controls/i);
  await h.evaluate('run()');
  await h.evaluate('nextLead()');
  assert.equal(fixture.clicks(), 0, 'old task and Send controls must never be clicked');
  assert.equal(h.evaluate('__sidebarTouches'), 0, 'must reject before manipulating old panels');
  assert.equal(h.requests.length, 1, 'must not navigate again while old controls remain');
  assert.match(h.alerts.join('\n'), /previous contact controls/i);
  assert.equal(h.navigationErrors.length, 0);
  fixture.root.remove();
  h.respond(result([hit('contact-c', 'opp-c')]));
  await h.evaluate('nextLead()');
  assert.equal(h.w.location.pathname, `/v2/location/${LOCATION}/contacts/detail/contact-c`);
  assert.equal(h.requests.length, 2);
});

test('manual route change during control retirement cancels navigation without reviving the source queue', async t => {
  const h = harness(t), fixture = retainedContactFixture(h);
  const navigation = h.evaluate('nextLead()'); await flush();
  assert.equal(h.evaluate('workflow.busy'), true);
  h.route(CONTACT_PATH); h.route(NEXT_PATH);
  fixture.root.remove(); fixture.advance(150);
  await navigation;
  assert.equal(h.evaluate('stageQueueContext()'), null);
  assert.equal(h.evaluate('workflow.busy'), false);
  assert.equal(plain(h.w.pertamaWorkflowTimings).at(-1).result, 'stopped');
  assert.equal(h.navigationErrors.length, 0);
});

test('unchanged captured queries do not repeatedly write localStorage', t => {
  const h = harness(t);
  const originalSet = h.w.Storage.prototype.setItem;
  let writes = 0;
  h.w.Storage.prototype.setItem = function (key, value) {
    if (key === 'pertama:query:pipe-a') writes++;
    return originalSet.call(this, key, value);
  };
  h.evaluate("rememberQuery('/opportunities/search', defaultPipelineQuery(NAV_PIPELINES[0]))");
  h.evaluate("rememberQuery('/opportunities/search', defaultPipelineQuery(NAV_PIPELINES[0]))");
  assert.equal(writes, 1);
  h.evaluate("rememberQuery('/opportunities/search', { ...defaultPipelineQuery(NAV_PIPELINES[0]), query: 'changed' })");
  assert.equal(writes, 2);
  assert.equal(h.evaluate("queryTemplates['pipe-a'].query"), 'changed');
});

test('failed optional query persistence can retry, then deduplicates after success', t => {
  const h = harness(t);
  const originalSet = h.w.Storage.prototype.setItem;
  let writes = 0;
  h.w.Storage.prototype.setItem = function (key, value) {
    if (key === 'pertama:query:pipe-a' && ++writes === 1) throw new Error('Storage full');
    return originalSet.call(this, key, value);
  };
  for (let i = 0; i < 3; i++) h.evaluate("rememberQuery('/opportunities/search', defaultPipelineQuery(NAV_PIPELINES[0]))");
  assert.equal(writes, 2);
  assert.equal(JSON.parse(h.w.localStorage.getItem('pertama:query:pipe-a')).locationId, LOCATION);
});

test('unchanged authentication is not decoded repeatedly but changed credentials are verified', t => {
  const h = harness(t);
  let decodes = 0;
  const originalAtob = h.w.atob.bind(h.w);
  h.w.atob = value => { decodes++; return originalAtob(value); };
  for (let i = 0; i < 5; i++) h.evaluate("captureReadHeaders('https://services.leadconnectorhq.com/contacts', liveReadHeaders)");
  assert.equal(decodes, 0);
  const claims = { user_id: 'user-b', sub: 'user-b', locations: [LOCATION], exp: Math.floor(Date.now() / 1000) + 3600 };
  const authorization = `Bearer test.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.test`;
  h.evaluate(`captureReadHeaders('https://services.leadconnectorhq.com/contacts', { authorization: ${JSON.stringify(authorization)} })`);
  assert.equal(decodes, 1);
  assert.equal(h.evaluate('currentUserId'), 'user-b');
});

test('cached authentication still expires and rejects malformed replacement tokens', async t => {
  const h = harness(t);
  h.w.Date.now = () => Date.now() + 7200000;
  h.evaluate("captureReadHeaders('https://services.leadconnectorhq.com/contacts', liveReadHeaders)");
  await assert.rejects(h.evaluate('requireVerifiedUser()'), /verified|expired/i);
  h.evaluate("captureReadHeaders('https://services.leadconnectorhq.com/contacts', { authorization: 'Bearer invalid' })");
  assert.equal(h.evaluate('currentUserId'), null);
  await assert.rejects(h.evaluate('requireVerifiedUser()'), /verified|unreadable/i);
});

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

test('openLead pins IDs before navigation and intentional handoff survives route sync', async t => {
  const h = harness(t); h.pin();
  await h.evaluate("openLead({ contactId: 'contact-b', opportunityId: 'opp-b', pipeline: 'Sales', pipelineId: 'pipe-a', stageId: 'stage-atc' })");
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

for (const key of ['addNote', 'addTask', 'sendSms']) {
  test(`settings validate optional ${key} booleans without rejecting legacy rules`, t => {
    const h = harness(t);
    assert.doesNotThrow(() => h.evaluate('validateSettings(settings)'));
    for (const value of [true, false]) assert.doesNotThrow(() => h.evaluate(`validateSettings({ ...settings, rules: { Lead: { next: 'Robot', days: 0, updateStage: false, ${key}: ${value} } } })`));
    for (const value of [null, 'true', 1, {}]) {
      assert.throws(() => h.evaluate(`validateSettings({ ...settings, rules: { Lead: { next: 'Robot', days: 0, updateStage: false, ${key}: ${JSON.stringify(value)} } } })`), /rule|boolean/i);
    }
  });
}
test('enabled task defaults accept blank days but reject invalid days', t => {
  const h = harness(t);
  assert.doesNotThrow(() => h.evaluate("validateSettings({ ...settings, rules: { Lead: { next: 'Robot', days: null, updateStage: false, addTask: true } } })"));
  for (const days of [-1, 0.5, 36501, '2']) assert.throws(() => h.evaluate(`validateSettings({ ...settings, rules: { Lead: { next: 'Robot', days: ${JSON.stringify(days)}, updateStage: false, addTask: true } } })`), /days|task/i);
  assert.doesNotThrow(() => h.evaluate("validateSettings({ ...settings, rules: { Lead: { next: 'Robot', days: null, updateStage: false, addTask: false } } })"));
});

function settingsForm(h) { h.evaluate('openSettings()'); return h.w.document.querySelector('#pertama-settings form'); }
function submitSettings(h, form) { form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true })); }
function change(h, field) { field.dispatchEvent(new h.w.Event('change', { bubbles: true })); }
function savedSettings(h) { return JSON.parse(h.w.localStorage.getItem(`pertama:settings:${LOCATION}`)); }

test('legacy rules migrate to explicit action defaults and reload without changing behavior', t => {
  const h = harness(t);
  const legacy = plain(h.evaluate('settings'));
  const form = settingsForm(h);
  for (const row of form.querySelectorAll('.rule-row')) {
    const rule = legacy.rules[row.querySelector('[data-stage]').value];
    assert.equal(row.querySelector('[data-note]')?.checked, true);
    assert.equal(row.querySelector('[data-task]')?.checked, rule.days !== null);
    assert.equal(row.querySelector('[data-sms]')?.checked, false);
    assert.equal(row.querySelector('[data-update]').checked, rule.updateStage);
  }
  form.querySelector('[type="submit"]').click();
  const saved = savedSettings(h);
  for (const [stage, rule] of Object.entries(legacy.rules)) assert.deepEqual(saved.rules[stage], { ...rule, addNote: true, addTask: rule.days !== null, sendSms: false });
  const loaded = harness(t, { storedSettings: saved });
  assert.deepEqual(plain(loaded.evaluate('settings')), saved);
});

test('rule stage selects filter selected pipelines, deduplicate stages and update live without losing values', t => {
  const h = harness(t);
  h.evaluate(`settings.pipelineIds = ['pipe-a']; settings.priority = 'stage';
    settings.rules = { 'New Lead': { next: 'Robot', days: 0, updateStage: false } };
    NAV_PIPELINES.push({ id: 'pipe-b', name: 'Other', stages: { Robot: 'other-robot', Exclusive: 'exclusive' } });`);
  const form = settingsForm(h), row = form.querySelector('.rule-row');
  const current = row.querySelector('[data-stage]'), next = row.querySelector('[data-next]');
  assert.equal(current.tagName, 'SELECT'); assert.equal(next.tagName, 'SELECT');
  assert.equal(next.disabled, false, 'suggestion remains editable with stage update off');
  const values = select => [...select.options].filter(o => o.value).map(o => o.value);
  assert.deepEqual(values(next), ['New Lead', 'Attempted Contact', 'Robot']);
  const a = form.querySelector('[data-pipeline-id="pipe-a"] input'), b = form.querySelector('[data-pipeline-id="pipe-b"] input');
  b.checked = true; change(h, b);
  assert.deepEqual(values(next), ['New Lead', 'Attempted Contact', 'Robot', 'Exclusive']);
  next.value = 'Exclusive'; change(h, next);
  b.checked = false; change(h, b);
  assert.equal(next.value, 'Exclusive');
  assert.match(next.selectedOptions[0].textContent, /unavailable/i);
  assert.equal(next.selectedOptions[0].disabled, true);
  submitSettings(h, form);
  assert.match(form.querySelector('[data-error]').textContent, /unavailable/i, 'new unavailable destinations cannot be saved');
  next.value = 'Robot'; change(h, next);
  a.checked = false; change(h, a);
  assert.equal(current.value, 'New Lead'); assert.match(current.selectedOptions[0].textContent, /unavailable/i);
  assert.equal(next.value, 'Robot'); assert.match(next.selectedOptions[0].textContent, /unavailable/i);
  form.querySelector('[data-add-rule]').click();
  const added = form.querySelectorAll('.rule-row')[1];
  assert.deepEqual(values(added.querySelector('[data-next]')), [], 'new rows cannot pick another rule’s unavailable saved stage');
  added.querySelector('button').click();
  submitSettings(h, form);
  assert.equal(savedSettings(h).rules['New Lead'].next, 'Robot', 'unchanged saved values allowed with no pipelines');
});

for (const days of [0, 7, null]) test(`rule task toggle preserves days ${days} and persists all action choices`, t => {
  const h = harness(t);
  h.evaluate(`settings.rules = { 'New Lead': { next: 'Robot', days: ${days}, updateStage: false, addNote: false, addTask: false, sendSms: true } }`);
  const form = settingsForm(h), row = form.querySelector('.rule-row');
  const task = row.querySelector('[data-task]'), input = row.querySelector('[data-days]');
  assert.ok(task, 'explicit follow-up toggle');
  assert.equal(input.closest('label').hidden, true);
  assert.match(form.closest('dialog').querySelector('style').textContent, /#pertama-settings \[hidden\]\{display:none!important\}/, 'hidden days must override the label display:block rule');
  assert.equal(input.value, days === null ? '' : String(days));
  task.checked = true; change(h, task);
  assert.equal(input.closest('label').hidden, false); assert.equal(input.required, false);
  task.checked = false; change(h, task);
  assert.equal(input.required, false);
  assert.equal(input.value, days === null ? '' : String(days));
  submitSettings(h, form);
  assert.deepEqual(savedSettings(h).rules['New Lead'], { next: 'Robot', days, updateStage: false, addNote: false, addTask: false, sendSms: true });
  const reopened = settingsForm(h).querySelector('.rule-row');
  const toggle = reopened.querySelector('[data-task]'); toggle.checked = true; change(h, toggle);
  assert.equal(reopened.querySelector('[data-days]').value, days === null ? '' : String(days));
});

test('current stage choices disable duplicates and save validation still rejects duplicate rules', t => {
  const h = harness(t);
  h.evaluate(`settings.pipelineIds = ['pipe-a']; settings.rules = { 'New Lead': { next: 'Robot', days: null, updateStage: false }, Robot: { next: 'New Lead', days: null, updateStage: true } }`);
  const form = settingsForm(h), rows = form.querySelectorAll('.rule-row');
  const first = rows[0].querySelector('[data-stage]'), second = rows[1].querySelector('[data-stage]');
  assert.equal(second.tagName, 'SELECT');
  assert.equal([...second.options].find(o => o.value === 'New Lead').disabled, true);
  first.value = 'Attempted Contact'; change(h, first);
  assert.equal([...second.options].find(o => o.value === 'New Lead').disabled, false);
  second.value = 'Attempted Contact'; submitSettings(h, form);
  assert.match(form.querySelector('[data-error]').textContent, /Duplicate stage rule/);
  rows[0].querySelector('button').click();
  assert.equal([...second.options].find(o => o.value === 'New Lead').disabled, false);
});

test('settings new-lead stage is picked from available pipeline stages', t => {
  const h = harness(t);
  h.evaluate('openSettings()');
  const form = h.w.document.querySelector('#pertama-settings form');
  const stage = form.elements.namedItem('newLeadStage');
  assert.equal(stage.tagName, 'SELECT');
  assert.equal(stage.value, 'New Lead');
  assert.deepEqual([...stage.options].map(option => option.value), ['', 'New Lead', 'Attempted Contact', 'Robot']);
  stage.value = 'Robot';
  form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(JSON.parse(h.w.localStorage.getItem(`pertama:settings:${LOCATION}`)).newLeadStage, 'Robot');
});

test('settings preserve the saved stage when the pipeline catalog is unavailable', t => {
  const h = harness(t);
  h.evaluate('NAV_PIPELINES.splice(0)');
  h.evaluate('openSettings()');
  const form = h.w.document.querySelector('#pertama-settings form');
  const stage = form.elements.namedItem('newLeadStage');
  assert.equal(stage.tagName, 'SELECT');
  assert.deepEqual([...stage.options].map(option => option.value), ['', 'New Lead']);
  assert.equal(stage.value, 'New Lead');
  form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(JSON.parse(h.w.localStorage.getItem(`pertama:settings:${LOCATION}`)).newLeadStage, 'New Lead');
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
  const h = harness(t); apiContactFixture(h);
  h.w.__apiOpportunities.push({ ...h.w.__apiOpportunities[0], id: 'opp-other' });
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

function apiContactFixture(h) {
  h.w.__apiContact = { id: 'contact-a', locationId: LOCATION, firstName: 'Ada', lastName: 'Test', phone: '+628123456789', assignedTo: 'owner-a' };
  h.w.__apiOpportunities = [{ id: 'opp-a', contactId: 'contact-a', locationId: LOCATION, pipelineId: 'pipe-a', pipelineStageId: 'stage-atc', assignedTo: 'owner-a' }];
  h.w.__apiReads = [];
  h.evaluate(`globalThis.readContactDetails = async (options = {}) => {
    __apiReads.push({ kind: 'contact', fresh: Boolean(options.fresh) });
    return JSON.parse(JSON.stringify(__apiContact));
  }; readContactDetails = globalThis.readContactDetails;
  globalThis.readContactOpportunities = async (options = {}) => {
    __apiReads.push({ kind: 'opportunities', fresh: Boolean(options.fresh) });
    return JSON.parse(JSON.stringify(__apiOpportunities));
  }; readContactOpportunities = globalThis.readContactOpportunities;
  readCallTasks = async () => ({ rows: [], total: 0 });`);
}
function opportunityFixture(h) {
  apiContactFixture(h);
  h.w.document.body.insertAdjacentHTML('beforeend', `<div class="opportunities-pane-list"><a href="/v2/location/${LOCATION}/opportunities/opp-a?pipelineId=pipe-a">Sales opportunity</a></div>`);
  h.w.document.querySelector('.opportunities-pane-list a').addEventListener('click', event => event.preventDefault());
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('Save and next reaches confirmation through the real API providers without contact or opportunity DOM', async t => {
  const h = harness(t, { fetchResponse: request => request.method === 'GET'
    ? { contact: { id: 'contact-a', locationId: LOCATION, firstName: 'Api', lastName: 'Contact', phone: '+628123456789', assignedTo: 'owner-a' } }
    : { opportunities: [{ id: 'opp-a', contactId: 'contact-a', locationId: LOCATION, pipelineId: 'pipe-a', pipelineStageId: 'stage-atc', assignedTo: 'owner-a' }], total: 1 } });
  h.pin();
  fastPolling(h); // Missing owner UI must never hold up API-backed confirmation.
  h.evaluate("globalThis.openSidebar = async () => { throw new Error('No sidebar reads allowed'); }; openSidebar = globalThis.openSidebar;");
  const pending = h.evaluate('run()'); await flush();
  const dialog = h.w.document.getElementById('pertama-confirm-actions');
  assert.ok(dialog, h.alerts.join('\n'));
  assert.match(dialog.textContent, /Api Contact/);
  assert.match(dialog.querySelector('[data-stage]').textContent, /Attempted Contact/);
  assert.deepEqual(h.requests.map(request => request.method).sort(), ['GET', 'POST']);
  assert.equal(h.requests.find(request => request.method === 'GET').url, 'https://services.leadconnectorhq.com/contacts/contact-a');
  assert.equal(h.requests.find(request => request.method === 'POST').url, 'https://services.leadconnectorhq.com/opportunities/search/');
  dialog.querySelector('[data-cancel]').click(); await pending;
  assert.deepEqual(h.alerts, []);
});

test('unconfigured stage allows manual stage update and defaults follow-up to two days', async t => {
  const h = harness(t); apiContactFixture(h); h.pin();
  h.w.__apiOpportunities[0].pipelineStageId = 'stage-robot';
  h.w.__selectedActions = [];
  h.evaluate(`prepareStageApi = async () => {};
    saveStageApi = async () => { __selectedActions.push({ action: 'stage', target: workflow.approvedActionContext.targetStageId }); };
    createTaskApi = async () => { __selectedActions.push({ action: 'task', due: workflow.approvedActionContext.due }); };
    completeCallTask = async () => {}; findNextActionable = async () => null;`);
  const pending = h.evaluate('run()'); await flush();
  const dialog = h.w.document.getElementById('pertama-confirm-actions');
  assert.ok(dialog, h.alerts.join('\n'));
  const form = dialog.querySelector('form');
  assert.equal(form.elements.namedItem('stage').checked, false);
  assert.equal(form.elements.namedItem('targetStage').disabled, true);
  assert.match(dialog.querySelector('[data-stage]').textContent, /no (automatic )?rule/i);
  assert.equal(form.elements.namedItem('task').checked, true);
  assert.equal(form.elements.namedItem('taskDays').value, '2');
  form.elements.namedItem('note').checked = false;
  form.elements.namedItem('stage').checked = true;
  form.elements.namedItem('targetStage').value = 'New Lead';
  form.dispatchEvent(new h.w.Event('change', { bubbles: true }));
  form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  await pending;
  assert.deepEqual(plain(h.w.__selectedActions), [
    { action: 'stage', target: 'stage-new' }, { action: 'task', due: `${h.evaluate('futureDate(2)')}T03:00:00.000Z` },
  ]);
  assert.deepEqual(h.alerts, []);
});

test('API action context requires a unique opportunity unless the original ID is pinned', async t => {
  const h = harness(t); apiContactFixture(h);
  h.w.__apiOpportunities.unshift({ ...h.w.__apiOpportunities[0], id: 'opp-other', pipelineStageId: 'stage-robot' });
  await assert.rejects(h.evaluate('readActionContext()'), /not unique/i);
  h.pin();
  const context = await h.evaluate('readActionContext()');
  assert.equal(context.opportunity.id, 'opp-a');
  assert.equal(context.stage, 'Attempted Contact');
});

for (const mismatch of ['pipeline', 'stage']) {
  test(`API action context rejects unknown ${mismatch} instead of inferring from the queue`, async t => {
    const h = harness(t); apiContactFixture(h); h.pin();
    h.w.__apiOpportunities[0][mismatch === 'pipeline' ? 'pipelineId' : 'pipelineStageId'] = 'missing';
    await assert.rejects(h.evaluate('readActionContext()'), /pipeline|stage/i);
    assert.deepEqual(plain(h.evaluate('stageQueueContext().queue')), queue);
    assert.equal(h.requests.length, 0);
  });
}

test('cancelled confirmation resets prior evidence and releases workflow ownership', async t => {
  const h = harness(t); apiContactFixture(h); h.pin(); h.evaluate("settings.priority = 'stage'");
  h.evaluate(`journal.restore({ completed: ['Previous evidence'], pendingSave: 'Previous uncertainty',
    pendingActions: { note: 'Previous note' } }); workflow.startingContact = 'previous-contact';`);
  const pending = h.evaluate('run()'); await flush();
  const dialog = h.w.document.getElementById('pertama-confirm-actions');
  assert.ok(dialog, h.alerts.join('\n'));
  assert.equal(h.evaluate('workflow.busy'), true);
  assert.equal(h.evaluate('workflow.guardedContact'), 'contact-a');
  assert.equal(h.evaluate('workflow.guardedStageQueue === stageQueueContext().queue'), true);
  assert.deepEqual(plain(h.evaluate('journal.completed')), []);
  assert.equal(h.evaluate('journal.pendingSave'), '');
  assert.deepEqual(plain(h.evaluate('journal.pendingActions')), {});
  assert.equal(h.evaluate('workflow.startingContact'), 'contact-a');
  dialog.querySelector('[data-cancel]').click(); await pending;
  assert.deepEqual(plain(h.evaluate('[workflow.busy, workflow.activeSaveProgress, workflow.guardedContact, workflow.guardedStageQueue, workflow.approvedActionContext]')), [false, null, null, null, null]);
  assert.equal(h.evaluate('workflow.step'), 'Awaiting confirmation…');
  assert.equal(h.evaluate('workflow.startingContact'), 'contact-a');
  assert.equal(h.w.localStorage.getItem(`pertama:no-answer:unfinished:${LOCATION}:contact-a`), null);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.alerts, []);
});

test('API context failure drains the other read before releasing the workflow', async t => {
  const h = harness(t); apiContactFixture(h);
  let release;
  h.w.__pendingOpportunities = new Promise(resolve => { release = resolve; });
  h.evaluate(`readContactDetails = async () => { throw new Error('Contact read failed'); };
    readContactOpportunities = () => __pendingOpportunities;`);
  let settled = false;
  const pending = h.evaluate('run()').finally(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  assert.equal(h.evaluate('workflow.busy'), true);
  release(h.w.__apiOpportunities); await pending;
  assert.equal(h.evaluate('workflow.busy'), false);
  assert.match(h.alerts.join('\n'), /Contact read failed/);
});

test('unknown stage queue infers the sole current opportunity without opening the CRM sidebar', async t => {
  const h = harness(t); apiContactFixture(h);
  h.evaluate("globalThis.openSidebar = async () => { throw new Error('Sidebar discovery forbidden'); }; openSidebar = globalThis.openSidebar;");
  const pending = h.evaluate('ensureStageQueue()').catch(error => ({ error }));
  await flush();
  const dialog = h.w.document.getElementById('pertama-stage-queue');
  assert.equal(dialog, null, 'a unique opportunity needs no queue confirmation');
  const context = await pending;
  assert.deepEqual(plain(context.queue), queue);
  assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(QUEUE_KEY)), queue);
  assert.deepEqual(plain(h.w.__apiReads), [{ kind: 'opportunities', fresh: false }]);
});

test('same-stage inference uses the opened opportunity origin to disambiguate current stage', async t => {
  const h = harness(t); apiContactFixture(h);
  h.w.__apiOpportunities.unshift({ ...h.w.__apiOpportunities[0], id: 'opp-other' });
  h.w.__apiOpportunities[1].pipelineStageId = 'stage-robot';
  h.w.sessionStorage.setItem('pertama:origin:contact-a', JSON.stringify({ opportunityId: 'opp-a', pipelineId: 'pipe-a', pipeline: 'Sales' }));
  const pending = h.evaluate('ensureStageQueue()'); await flush();
  const dialog = h.w.document.getElementById('pertama-stage-queue');
  if (dialog) dialog.querySelector('[data-cancel]').click();
  assert.equal(dialog, null);
  assert.deepEqual(plain((await pending).queue), { ...queue, stageId: 'stage-robot' });
});

for (const invalid of ['stage', 'origin']) {
  test(`same-stage inference rejects an unavailable ${invalid} without pinning a queue`, async t => {
    const h = harness(t); apiContactFixture(h);
    if (invalid === 'stage') h.w.__apiOpportunities[0].pipelineStageId = 'missing';
    else h.w.sessionStorage.setItem('pertama:origin:contact-a', JSON.stringify({ opportunityId: 'missing', pipelineId: 'pipe-a' }));
    const pending = h.evaluate('ensureStageQueue()');
    const settled = pending.then(value => ({ value }), error => ({ error }));
    await flush();
    h.w.document.querySelector('#pertama-stage-queue [data-cancel]')?.click();
    assert.match(String((await settled).error), /stage|opportunity/i);
    assert.equal(h.w.sessionStorage.getItem(QUEUE_KEY), null);
  });
}

for (const defaults of [
  { addNote: false, addTask: false, updateStage: false },
  { addNote: true, addTask: true, updateStage: true },
  {},
]) test(`confirmation action defaults and manual overrides: ${JSON.stringify(defaults)}`, async t => {
  const h = harness(t);
  const rule = { next: 'Robot', days: 0, ...defaults };
  const pending = h.evaluate(`confirmActions({ contact: { id: 'contact-a' }, name: 'Ada', firstName: 'Ada', phone: '',
    stage: 'New Lead', rule: ${JSON.stringify(rule)}, due: futureDate(0), ownerId: 'owner-a', taskTitle: 'Call Ada', pipelineName: 'Sales', stageOptions: ['Robot'] })`);
  const form = h.w.document.querySelector('#pertama-confirm-actions form'), field = name => form.elements.namedItem(name);
  for (const [action, key] of [['note', 'addNote'], ['task', 'addTask'], ['stage', 'updateStage']]) {
    assert.equal(field(action).checked, defaults[key] !== false);
    field(action).checked = !field(action).checked; change(h, field(action));
  }
  assert.equal(field('sms').checked, false);
  assert.equal(field('taskDays').value, '0', 'retain deadline even with task off');
  const expectedDue = new Date(`${field('taskDue').value}+08:00`).toISOString();
  field('noteText').value = 'Manual note';
  submitSettings(h, form);
  const choices = await pending;
  for (const [action, key] of [['note', 'addNote'], ['task', 'addTask'], ['stage', 'updateStage']]) assert.equal(choices[action], defaults[key] === false);
  assert.equal(choices.due, choices.task ? expectedDue : null);
});

test('no matching rule preserves legacy note and follow-up defaults', async t => {
  const h = harness(t); apiContactFixture(h);
  h.evaluate('settings.rules = {}');
  const pending = h.evaluate('run()'); await flush();
  const dialog = h.w.document.querySelector('#pertama-confirm-actions');
  assert.ok(dialog, h.alerts.join('\n'));
  const form = dialog.querySelector('form');
  for (const [action, checked] of [['note', true], ['stage', false], ['task', true], ['sms', false]]) assert.equal(form.elements.namedItem(action).checked, checked, action);
  dialog.querySelector('[data-cancel]').click(); await pending;
});

test('task controls share a compact row with tooltip help and no duplicate deadline', t => {
  const h = harness(t);
  h.evaluate("Date.now = () => Date.parse('2026-10-14T00:00:00Z'); futureDate = () => '2026-10-15'");
  const pending = h.evaluate(`confirmActions({ contact: { id: 'contact-a' }, name: 'Ada Test', firstName: 'Ada',
    phone: '', stage: 'New Lead', rule: { next: 'Attempted Contact', days: 0, updateStage: true }, due: '2026-10-14',
    ownerId: 'owner-a', taskTitle: 'Call Ada', pipelineName: 'Sales', stageOptions: ['Attempted Contact'] })`);
  const dialog = h.w.document.getElementById('pertama-confirm-actions');
  const preview = dialog.querySelector('[data-task]');
  assert.equal(preview.textContent, 'Call Ada');
  const days = dialog.querySelector('[name="taskDays"]');
  const picker = dialog.querySelector('[name="taskDue"]');
  const row = days.closest('.task-schedule');
  assert.ok(row, 'shared schedule row');
  assert.ok(row.contains(picker));
  assert.equal(h.w.getComputedStyle(row).display, 'flex');
  assert.equal(h.w.getComputedStyle(row).flexWrap, 'wrap', 'wrap on narrow screens');
  assert.equal(days.title, '0 or blank = 3 hours later');
  const help = dialog.querySelector(`#${days.getAttribute('aria-describedby')}`);
  assert.equal(help.hidden, true, 'helper is not another visible row');
  assert.equal(help.textContent, days.title);
  assert.equal(picker.getAttribute('aria-label'), 'Scheduled for (WITA)');
  assert.equal(picker.value, '2026-10-14T11:00');
  days.value = '1';
  days.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.equal(picker.value, '2026-10-15T11:00');
  assert.equal(preview.textContent, 'Call Ada', 'date only appears in the picker');
  dialog.querySelector('[data-cancel]').click();
  return pending;
});

test('Robot rule permits opt-in tasks and validates a user-entered deadline', async t => {
  const h = harness(t);
  const pending = h.evaluate(`confirmActions({ contact: { id: 'contact-a' }, name: 'Ada Test', firstName: 'Ada',
    phone: '', stage: 'ATC 3', rule: { next: 'Robot', days: null, updateStage: true }, due: null,
    owner: 'Owner', ownerId: 'owner-a', taskTitle: 'Call Ada', pipelineName: 'Sales', stageOptions: ['Robot'] })`);
  const dialog = h.w.document.getElementById('pertama-confirm-actions');
  t.after(() => dialog.querySelector('[data-cancel]')?.click());
  const form = dialog.querySelector('form');
  const task = form.elements.namedItem('task'), days = form.elements.namedItem('taskDays');
  assert.equal(task.checked, false);
  assert.equal(task.disabled, false);
  assert.equal(days.disabled, true);
  assert.equal(days.value, '');
  task.checked = true;
  form.dispatchEvent(new h.w.Event('change', { bubbles: true }));
  assert.equal(days.disabled, false);
  assert.equal(days.required, false);
  assert.equal(dialog.querySelector('[data-task-days]').hidden, false);
  form.elements.namedItem('note').checked = false;
  days.value = '-1';
  days.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(dialog.isConnected, true, 'negative deadline must not close confirmation');
  days.value = '3';
  days.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  const choices = await pending;
  assert.equal(choices.task, true);
  assert.equal(choices.due, `${h.evaluate('futureDate(3)')}T03:00:00.000Z`);
});

for (const days of [0, null]) for (const [now, localDue, utcDue] of [
  ['2026-10-14T02:15:42Z', '2026-10-14T13:15', '2026-10-14T05:15:00.000Z'],
  ['2026-12-31T15:30:00Z', '2027-01-01T02:30', '2026-12-31T18:30:00.000Z'],
]) test(`follow-up ${days} defaults to three hours after opening at ${now}`, async t => {
  const h = harness(t);
  h.evaluate(`Date.now = () => Date.parse('${now}')`);
  const pending = h.evaluate(`confirmActions({ contact: { id: 'contact-a' }, name: 'Ada', stage: 'Robot',
    rule: { next: 'Robot', days: ${days}, addTask: true }, due: null, ownerId: 'owner-a',
    taskTitle: 'Call Ada', pipelineName: 'Sales', stageOptions: ['Robot'] })`);
  const dialog = h.w.document.querySelector('#pertama-confirm-actions'), form = dialog.querySelector('form');
  const picker = form.elements.namedItem('taskDue');
  assert.ok(picker, 'compact date/time picker');
  assert.equal(picker.type, 'datetime-local');
  assert.match(picker.labels[0].textContent, /WITA/);
  assert.equal(picker.value, localDue);
  assert.equal(form.elements.namedItem('taskDays').required, false);
  h.evaluate(`Date.now = () => Date.parse('${now}') + 3600000`);
  change(h, form.elements.namedItem('note'));
  assert.equal(picker.value, localDue, 'unrelated changes never move the opening-time default');
  form.querySelector('[type=submit]').click();
  assert.equal((await pending).due, utcDue);
  assert.equal(h.requests.length, 0);
});

test('picker overrides survive toggles; days edits reset the picker, without saving defaults', async t => {
  const h = harness(t);
  h.evaluate("Date.now = () => Date.parse('2026-10-14T15:30:00Z')");
  const before = plain(h.evaluate('settings'));
  const pending = h.evaluate(`confirmActions({ contact: { id: 'contact-a' }, name: 'Ada', stage: 'Robot',
    rule: { next: 'Robot', days: 2, addTask: true }, ownerId: 'owner-a',
    taskTitle: 'Call Ada', pipelineName: 'Sales', stageOptions: ['Robot'] })`);
  const form = h.w.document.querySelector('#pertama-confirm-actions form'), field = name => form.elements.namedItem(name);
  assert.equal(field('taskDue').value, '2026-10-16T11:00');
  field('taskDue').value = '2026-10-17T00:45'; change(h, field('taskDue'));
  assert.equal(form.querySelector('[data-task]').textContent, 'Call Ada');
  field('task').checked = false; change(h, field('task'));
  assert.equal(field('taskDue').disabled, true);
  field('task').checked = true; change(h, field('task'));
  assert.equal(field('taskDue').value, '2026-10-17T00:45');
  field('taskDays').value = ''; field('taskDays').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.equal(field('taskDue').value, '2026-10-15T02:30');
  field('taskDays').value = '1'; field('taskDays').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.equal(field('taskDue').value, '2026-10-15T11:00');
  field('taskDue').value = '2026-10-17T00:45'; change(h, field('taskDue'));
  form.querySelector('[type=submit]').click();
  assert.equal((await pending).due, '2026-10-16T16:45:00.000Z');
  assert.deepEqual(plain(h.evaluate('settings')), before);
});

for (const invalid of ['-1', '1.5', '36501']) test(`invalid days ${invalid} block confirmation even with a valid picker`, async t => {
  const h = harness(t);
  const pending = h.evaluate(`confirmActions({ contact: { id: 'contact-a' }, name: 'Ada', stage: 'Robot',
    rule: { next: 'Robot', days: 0, addTask: true }, ownerId: 'owner-a',
    taskTitle: 'Call Ada', pipelineName: 'Sales', stageOptions: ['Robot'] })`);
  const dialog = h.w.document.querySelector('#pertama-confirm-actions'), form = dialog.querySelector('form');
  form.elements.namedItem('taskDays').value = invalid;
  form.elements.namedItem('taskDays').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  form.elements.namedItem('taskDue').value = '2026-10-17T00:45';
  submitSettings(h, form);
  assert.equal(dialog.isConnected, true);
  assert.equal(form.elements.namedItem('taskDays').checkValidity(), false);
  dialog.querySelector('[data-cancel]').click(); await pending;
});

test('empty picker blocks enabled tasks but does not block skipping tasks', async t => {
  const h = harness(t);
  const pending = h.evaluate(`confirmActions({ contact: { id: 'contact-a' }, name: 'Ada', stage: 'Robot',
    rule: { next: 'Robot', days: 0, addTask: true }, ownerId: 'owner-a',
    taskTitle: 'Call Ada', pipelineName: 'Sales', stageOptions: ['Robot'] })`);
  const dialog = h.w.document.querySelector('#pertama-confirm-actions'), form = dialog.querySelector('form');
  const picker = form.elements.namedItem('taskDue');
  picker.value = ''; change(h, picker); submitSettings(h, form);
  assert.equal(dialog.isConnected, true);
  assert.equal(picker.checkValidity(), false);
  form.elements.namedItem('task').checked = false; change(h, form.elements.namedItem('task'));
  form.querySelector('[type=submit]').click();
  assert.equal((await pending).due, null);
});

test('WITA picker parsing rejects impossible dates and preserves leap-day times', t => {
  const h = harness(t);
  for (const value of ['', '2026-02-30T12:00', '2026-10-17T25:00', '2026-10-17', '2026-10-17T12:00Z']) {
    assert.equal(h.evaluate(`taskDueFromInput(${JSON.stringify(value)})`), null, value);
  }
  const due = h.evaluate("taskDueFromInput('2028-02-29T00:15')");
  assert.equal(due, '2028-02-28T16:15:00.000Z');
  assert.equal(h.evaluate(`taskDueInput('${due}')`), '2028-02-29T00:15');
});

test('blank settings days with Add task enabled save and reload without changing other rules', t => {
  const h = harness(t);
  const before = plain(h.evaluate('settings.rules'));
  const form = settingsForm(h), row = form.querySelector('.rule-row');
  row.querySelector('[data-days]').value = '';
  assert.equal(row.querySelector('[data-task]').checked, true);
  form.querySelector('[type=submit]').click();
  const saved = savedSettings(h);
  assert.ok(saved, 'blank days must be accepted by native and settings validation');
  assert.equal(saved.rules['New Lead'].days, null);
  assert.equal(saved.rules['New Lead'].addTask, true);
  for (const stage of Object.keys(before).filter(stage => stage !== 'New Lead')) assert.equal(saved.rules[stage].days, before[stage].days);
  const loaded = harness(t, { storedSettings: saved });
  assert.deepEqual(plain(loaded.evaluate('settings')), saved);
});

test('Robot rule still disables task creation without a valid owner', async t => {
  const h = harness(t);
  const pending = h.evaluate(`confirmActions({ contact: { id: 'contact-a' }, name: 'Ada', firstName: 'Ada',
    phone: '', stage: 'ATC 3', rule: { next: 'Robot', days: null }, due: null,
    owner: '', ownerId: '', taskTitle: 'Call Ada', pipelineName: 'Sales', stageOptions: ['Robot'] })`);
  const dialog = h.w.document.getElementById('pertama-confirm-actions');
  assert.equal(dialog.querySelector('[name="task"]').disabled, true);
  assert.equal(dialog.querySelector('[name="taskDue"]').disabled, true);
  assert.match(dialog.querySelector('[data-task]').textContent, /owner/i);
  dialog.querySelector('[data-cancel]').click();
  assert.equal(await pending, null);
});

for (const outcome of ['cancel', 'skip-writes', 'changed-contact', 'changed-stage', 'changed-owner']) {
  test(`API preparation without contact inputs or opportunity panels: ${outcome}`, async t => {
    const h = harness(t); apiContactFixture(h);
    h.pin({ ...queue, stageId: 'stage-new' });
    h.w.document.body.insertAdjacentHTML('beforeend', '<div id="owner-dropdown-trigger"><span>Ada Owner</span></div>');
    h.evaluate(`globalThis.openSidebar = async () => { throw new Error('Sidebar discovery forbidden'); }; openSidebar = globalThis.openSidebar;
      findNextActionable = async () => null; completeCallTask = async () => {};`);
    const pending = h.evaluate('run()'); await flush();
    const dialog = h.w.document.getElementById('pertama-confirm-actions');
    assert.ok(dialog, h.alerts.join('\n'));
    assert.match(dialog.textContent, /Ada Test/);
    assert.match(dialog.querySelector('[data-stage]').textContent, /Attempted Contact/);
    assert.equal(h.evaluate('stageQueueContext().stage'), 'New Lead', 'original queue is not the current stage');
    assert.equal(h.w.document.getElementById('OpportunityStage'), null);
    if (outcome === 'cancel') {
      dialog.querySelector('[data-cancel]').click(); await pending;
      assert.equal(h.w.__apiReads.length, 2);
    } else {
      if (outcome === 'changed-contact') h.w.__apiContact.firstName = 'Changed';
      if (outcome === 'changed-owner') h.w.__apiContact.assignedTo = 'owner-b';
      if (outcome === 'changed-stage') h.w.__apiOpportunities[0].pipelineStageId = 'stage-robot';
      const form = dialog.querySelector('form');
      for (const field of ['stage', 'note', 'task', 'sms']) form.elements.namedItem(field).checked = false;
      form.dispatchEvent(new h.w.Event('change', { bubbles: true }));
      form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
      await pending;
      assert.equal(h.w.__apiReads.filter(read => read.fresh).length, outcome === 'skip-writes' ? 3 : 2);
      if (outcome.startsWith('changed')) {
        assert.deepEqual(h.alerts, []);
        assert.match(h.w.document.querySelector('#pertama-save-progress [data-report]').textContent, /changed.*confirmation|confirmation.*changed/i);
      }
    }
    if (!outcome.startsWith('changed')) assert.deepEqual(h.alerts, []);
    assert.equal(h.requests.length, 0);
    assert.equal(h.navigationErrors.length, 0);
  });
}

for (const action of ['cancel', 'contact change', 'navigate away and back']) {
  test(`picker ${action} never pins a queue or searches`, { timeout: 3000 }, async t => {
    const h = harness(t); opportunityFixture(h);
    h.w.__apiOpportunities.push({ ...h.w.__apiOpportunities[0], id: 'opp-other' });
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

test('empty lead/task queues show an accurate congratulatory notice', t => {
  const h = harness(t);
  assert.equal(h.evaluate('emptyQueueMessage()'),
    'You’re all caught up! No new leads or due follow-up tasks match your selected queues. Nice work.');
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
  const timing = h.w.pertamaWorkflowTimings.at(-1);
  assert.equal(timing.action, 'Next lead');
  assert.equal(timing.phase, 'Total');
  assert.equal(timing.result, 'ok');
});

test('Next lead infers the current stage and navigates without a queue picker', async t => {
  const h = harness(t); apiContactFixture(h);
  h.evaluate("settings.priority = 'stage'");
  const { pushes } = installRouter(h);
  h.respond(result([hit()]));
  await h.evaluate('nextLead()');
  assert.equal(h.w.document.querySelector('#pertama-stage-queue'), null);
  assert.deepEqual(pushes, [NEXT_PATH]);
  assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(QUEUE_KEY)), { ...queue, contactId: 'contact-b', opportunityId: 'opp-b' });
  assert.deepEqual(h.requests[0].body.aggregations[0].options.include, ['stage-atc']);
  assert.deepEqual(h.alerts, []);
});

test('Next lead resolves ambiguous context through actual picker before lookup', { timeout: 3000 }, async t => {
  const h = harness(t); opportunityFixture(h);
  h.w.__apiOpportunities.push({ ...h.w.__apiOpportunities[0], id: 'opp-other' });
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

for (const mode of ['saved', 'all-actions', 'custom-time', 'all-actions-sms', 'sms-history-unavailable', 'sms-navigation-failure', 'stale-confirmation', 'navigation-failure', 'stage-mismatch', 'retained-modal',
  'mutation-after-recheck', 'user-after-recheck', 'route-after-recheck', 'stage-owner-automation', 'link-failure', 'task-route-change', 'empty-queue']) {
  test(`API Save and next without CRM forms: ${mode}`, { timeout: 3000 }, async t => {
    const contact = { id: 'contact-a', locationId: LOCATION, firstName: 'Ada', lastName: 'Test', phone: '+628123456789', assignedTo: 'owner-a' };
    const opportunity = { id: 'opp-a', contactId: 'contact-a', locationId: LOCATION, pipelineId: 'pipe-a', pipelineStageId: 'stage-atc', assignedTo: 'owner-a', indexVersion: 7, isAttribute: true };
    const smsEnabled = ['all-actions-sms', 'sms-history-unavailable', 'sms-navigation-failure'].includes(mode);
    const allActions = smsEnabled || ['all-actions', 'custom-time', 'stage-owner-automation', 'link-failure', 'task-route-change'].includes(mode);
    const writes = [];
    const checkpointKey = `pertama:no-answer:unfinished:${LOCATION}:contact-a`;
    const h = harness(t, { fetchResponse: request => {
      const url = new URL(request.url), body = request.body;
      if (request.method === 'GET' && url.pathname === '/contacts/contact-a') return { contact };
      if (url.pathname === `/phone-system/numbers/v2/location/${LOCATION}`) return { isUnderGhl: true, total: 2, page: 0, pageSize: 1000,
        numbers: [{ phoneNumber: '+15555550101', sid: 'pn-a', linkedUser: 'user-a', isDefaultNumber: true, capabilities: { sms: true } },
          { phoneNumber: '+15555550102', sid: 'pn-b', linkedUser: 'owner-a', isDefaultNumber: false, capabilities: { sms: true } }], rcsSenderIds: [] };
      if (url.pathname.startsWith('/conversations/messages/drafts/')) { assert.equal(request.method, 'GET'); return { drafts: [] }; }
      if (url.pathname === '/conversations/messages/spam/v2') { assert.equal(body.text, 'Approved API message'); return { isSpam: false }; }
      if (url.pathname.startsWith('/f1/conversations/')) throw new Error('Conversation history is unavailable');
      if (url.pathname.replace(/\/$/, '') === '/opportunities/search') {
        return body.aggregations ? result(mode === 'empty-queue' ? [] : [hit('contact-a', 'opp-a'), hit()])
          : { opportunities: [opportunity], total: 1 };
      }
      if (request.method === 'GET' && url.pathname === '/opportunities/opp-a') {
        if (mode === 'mutation-after-recheck') h.evaluate("finishContactWrite(observeContactRequest('PATCH', 'https://services.leadconnectorhq.com/contacts/contact-a', () => '{}'))");
        if (mode === 'user-after-recheck') h.evaluate("currentUserId = 'other-user'; invalidateContactReads()");
        if (mode === 'route-after-recheck') { h.route(BOARD_PATH); h.route(CONTACT_PATH); }
        return { opportunity: mode === 'stage-mismatch' ? { ...opportunity, pipelineStageId: 'stage-new' } : opportunity };
      }
      if (url.pathname === '/objects/task/records/search') return { customObjectRecords: [], total: 0 };
      writes.push(request);
      assert.ok(JSON.parse(h.w.localStorage.getItem(checkpointKey)).pendingSave, 'journal must precede every write');
      if (url.pathname === '/conversations/messages') {
        assert.equal(body.fromNumber, '+15555550101');
        assert.equal(body.toNumber, contact.phone);
        assert.equal(body.message, 'Approved API message');
        return { messageId: 'msg-created', conversationId: 'conv-created' };
      }
      if (request.method === 'PUT' && url.pathname === '/opportunities/opp-a') {
        assert.deepEqual(body, { pipelineStageId: 'stage-robot', indexVersion: 8, isAttribute: false });
        Object.assign(opportunity, { pipelineStageId: body.pipelineStageId, indexVersion: body.indexVersion });
        if (mode === 'stage-owner-automation') contact.assignedTo = 'owner-b';
        return { opportunity };
      }
      if (url.pathname === '/notes/') {
        assert.equal(url.searchParams.get('locationId'), LOCATION);
        assert.deepEqual(body.relations, [{ objectKey: 'contact', recordId: 'contact-a' }]);
        assert.match(body.body, /&lt;b&gt;literal&lt;\/b&gt;/);
        return { note: { id: 'note-created', locationId: LOCATION, contactId: 'contact-a', body: body.body } };
      }
      if (url.pathname === '/objects/task/records') {
        assert.deepEqual(body.owners, ['owner-a'], 'assign contact owner, not current user');
        assert.equal(body.properties.contactId, 'contact-a');
        assert.equal(body.properties.dueDate, mode === 'custom-time' ? '2026-10-16T16:45:00.000Z' : `${h.evaluate('futureDate(3)')}T03:00:00.000Z`);
        if (mode === 'task-route-change') h.route(CONTACT_PATH.replace('contact-a', 'contact-other'));
        return { record: { id: 'task-created', locationId: LOCATION, objectKey: 'task', owners: body.owners,
          properties: { title: body.properties.title, dueDate: body.properties.dueDate.replace('.000Z', 'Z'), completed: 0 } }, errors: [] };
      }
      if (url.pathname === '/associations/relations/bulk') {
        assert.equal(url.searchParams.get('updateFutureTasks'), 'false');
        assert.deepEqual(body.add, [{ associationId: 'TASK_CONTACT_ASSOCIATION', firstRecordId: 'task-created', secondRecordId: 'contact-a' }]);
        assert.match(h.w.localStorage.getItem(checkpointKey), /task-created/);
        if (mode === 'link-failure') throw new Error('Association response lost');
        return { results: { added: [{ success: true, relationId: 'relation-created', data: body.add[0] }], removed: [], errored: [] } };
      }
      throw new Error('Unexpected request');
    } });
    h.pin(); fastPolling(h);
    const native = installRouter(h);
    let navigationAttempts = 0;
    const nativePush = native.router.push;
    native.router.push = async path => {
      navigationAttempts++;
      if (['navigation-failure', 'sms-navigation-failure'].includes(mode)) throw new Error('Native navigation cancelled');
      return nativePush(path);
    };
    h.evaluate(`settings.priority = 'stage'; settings.rules['Attempted Contact'].next = 'Robot';
      globalThis.openSidebar = async () => { throw new Error('CRM form access forbidden'); }; openSidebar = globalThis.openSidebar;`);
    if (mode === 'route-after-recheck') h.evaluate("settings.priority = 'leads'");
    let modalClicks = 0;
    if (mode === 'retained-modal') {
      h.w.document.body.insertAdjacentHTML('beforeend', '<div id="modal"><div id="OpportunityStage">Other opportunity</div><button id="CreateUpdateOpportunity">Save</button></div>');
      h.w.document.getElementById('CreateUpdateOpportunity').addEventListener('click', () => modalClicks++);
    }
    const pending = h.evaluate('run()'); await flush();
    const dialog = h.w.document.getElementById('pertama-confirm-actions');
    assert.ok(dialog, h.alerts.join('\n'));
    assert.equal(dialog.querySelector('[data-task]').textContent, 'Call again Ada Test');
    assert.match(dialog.querySelector('[name="taskDue"]').value, /^\d{4}-\d{2}-\d{2}T11:00$/);
    assert.doesNotMatch(dialog.querySelector('[data-task]').textContent, /owner-a|Contact owner/);
    const form = dialog.querySelector('form');
    form.elements.namedItem('stage').checked = true;
    form.elements.namedItem('targetStage').value = 'Robot';
    form.elements.namedItem('note').checked = allActions;
    form.elements.namedItem('task').checked = allActions;
    form.elements.namedItem('taskDays').value = '3';
    form.elements.namedItem('taskDays').dispatchEvent(new h.w.Event('input', { bubbles: true }));
    if (mode === 'custom-time') {
      form.elements.namedItem('taskDue').value = '2026-10-17T00:45';
      change(h, form.elements.namedItem('taskDue'));
    }
    form.elements.namedItem('noteText').value = 'No answer <b>literal</b>\nFollow up';
    assert.equal(form.elements.namedItem('sms').checked, false);
    assert.equal(h.requests.some(r => /phone-system|conversations/.test(r.url)), false, 'non-SMS confirmation must not fetch SMS data');
    if (smsEnabled) {
      form.elements.namedItem('sms').checked = true;
      form.elements.namedItem('sms').dispatchEvent(new h.w.Event('change', { bubbles: true })); await flush();
      assert.equal(form.elements.namedItem('smsFrom'), null);
      assert.match(dialog.querySelector('[data-sms-status]').textContent, /From: \+15555550101/);
      form.elements.namedItem('smsText').value = 'Approved API message';
    }
    form.dispatchEvent(new h.w.Event('change', { bubbles: true }));
    if (mode === 'stale-confirmation') { h.route(BOARD_PATH); h.route(CONTACT_PATH); }
    form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(h.w.document.querySelector('#pertama-save-progress').open, true, 'synchronous modal handoff');
    assert.equal(dialog.isConnected, false);
    await pending;
    assert.equal(modalClicks, 0, 'existing opportunity editors must never be used');
    const timings = plain(h.w.pertamaWorkflowTimings);
    for (const phase of ['Reading contact and opportunity…', 'Awaiting confirmation…']) {
      assert.ok(timings.some(row => row.phase === phase), `missing phase: ${phase}`);
    }
    assert.doesNotMatch(JSON.stringify(timings), /Ada|contact-a|opp-a|owner-a|stage-robot/);
    const beforeWriteFailure = ['stale-confirmation', 'stage-mismatch', 'mutation-after-recheck', 'user-after-recheck', 'route-after-recheck'].includes(mode);
    if (beforeWriteFailure) {
      assert.equal(writes.length, 0, h.alerts.join('\n'));
      assert.equal(navigationAttempts, 0);
      assert.deepEqual(h.alerts, []);
      assert.match(h.w.document.querySelector('#pertama-save-progress [data-report]').textContent, /Stopped:/);
      assert.equal(h.w.localStorage.getItem(checkpointKey), null, 'no attempted write to reconcile');
    } else if (['navigation-failure', 'sms-navigation-failure', 'link-failure', 'task-route-change'].includes(mode)) {
      assert.equal(writes.length, smsEnabled ? 5 : mode === 'link-failure' ? 4 : mode === 'task-route-change' ? 3 : 1, h.alerts.join('\n'));
      const navigationFailed = ['navigation-failure', 'sms-navigation-failure'].includes(mode);
      assert.equal(navigationAttempts, navigationFailed ? 1 : 0);
      if (navigationFailed) assert.equal(h.w.localStorage.getItem(checkpointKey), null, 'completed writes must not remain blocked by navigation');
      else {
        assert.match(h.w.localStorage.getItem(checkpointKey), /Stage: Robot/);
        assert.match(h.w.localStorage.getItem(checkpointKey), /Task created.*task-created/);
      }
      const progress = h.w.document.querySelector('#pertama-save-progress');
      assert.equal(progress.querySelector('[data-action="stage"]').dataset.state, 'confirmed');
      if (smsEnabled) assert.match(progress.querySelector('[data-action="sms"]').textContent, /Accepted by CRM; delivery not confirmed/);
      if (mode === 'task-route-change') assert.match(progress.querySelector('[data-action="task"]').textContent, /Created; contact link not sent/);
      if (mode === 'link-failure') assert.match(progress.querySelector('[data-action="task"]').textContent, /Created; contact link unverified/);
      assert.deepEqual(h.alerts, []);
      progress.querySelector('[data-close]').click();
      if (!navigationFailed) {
        if (mode === 'task-route-change') h.route(CONTACT_PATH);
        const count = h.requests.length;
        await h.evaluate('run()');
        assert.equal(h.requests.length, count, 'checkpoint blocks duplicate requests, including re-creating a partially linked task');
        assert.match(h.alerts.join('\n'), /Repeat run blocked/);
      }
    } else {
      assert.deepEqual(h.alerts, []);
      assert.equal(writes.length, smsEnabled ? 5 : allActions ? 4 : 1);
      assert.deepEqual(writes.map(r => r.method), smsEnabled ? ['PUT', 'POST', 'POST', 'POST', 'POST'] : allActions ? ['PUT', 'POST', 'POST', 'POST'] : ['PUT']);
      const lookup = h.requests.find(r => r.body?.aggregations);
      assert.deepEqual(lookup.body.aggregations[0].options.include, ['stage-atc']);
      if (mode === 'empty-queue') {
        assert.equal(navigationAttempts, 0);
        assert.match(h.w.document.getElementById('pertama-task-notice').textContent, /refresh/i);
      } else {
        assert.deepEqual(native.pushes, [NEXT_PATH]);
        assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(QUEUE_KEY)), { ...queue, contactId: 'contact-b', opportunityId: 'opp-b' });
      }
      assert.equal(h.w.localStorage.getItem(checkpointKey), null);
      assert.equal(h.w.document.querySelector('#pertama-save-progress'), null);
      if (smsEnabled) {
        assert.equal(h.requests.some(r => new URL(r.url).pathname.startsWith('/f1/conversations/')), false, 'SMS acknowledgment must not require history before navigation');
        assert.match(h.w.document.getElementById('pertama-task-notice').textContent, /accepted.*delivery not confirmed/i);
      }
    }
    if (!beforeWriteFailure) {
      assert.equal(h.requests.filter(r => new URL(r.url).pathname === '/objects/task/records/search').length, 1, 'preflight checks for an existing task before writes');
    }
    assert.equal(h.evaluate('workflow.busy'), false);
    assert.equal(h.navigationErrors.length, 0);
  });
}

test('mutation start and settlement do not drift the pinned original stage', t => {
  const h = harness(t); h.pin();
  h.evaluate("globalThis.__write = observeStageRequest('PUT', 'https://services.leadconnectorhq.com/opportunities/opp-a')");
  assert.equal(h.evaluate('stageQueueContext().queue.stageId'), 'stage-atc');
  h.evaluate('finishStageWrite(__write)');
  assert.deepEqual(plain(h.evaluate('stageQueueContext().queue')), queue);
});

for (const ownerId of ['', 'unsafe/owner']) {
  test(`missing or invalid API owner disables only task selection: ${ownerId || 'unassigned'}`, async t => {
    const h = harness(t); apiContactFixture(h); h.pin(); fastPolling(h);
    h.w.__apiContact.assignedTo = ownerId;
    h.evaluate("settings.rules['Attempted Contact'].addTask = true");
    const pending = h.evaluate('run()'); await flush();
    const dialog = h.w.document.getElementById('pertama-confirm-actions');
    assert.ok(dialog, h.alerts.join('\n'));
    const form = dialog.querySelector('form');
    assert.equal(form.elements.namedItem('task').disabled, true);
    assert.equal(form.elements.namedItem('task').checked, false);
    assert.match(dialog.querySelector('[data-task]').textContent, /owner.*unavailable|no.*owner/i);
    assert.equal(form.elements.namedItem('note').disabled, false);
    assert.equal(form.elements.namedItem('stage').disabled, false);
    dialog.querySelector('[data-cancel]').click(); await pending;
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.alerts, []);
  });
}

// Advance only the polling clock/sleep boundary; exercise the real readiness loop.
function fastPolling(h) {
  h.w.__elapsed = 0;
  h.w.Date.now = () => h.w.__elapsed;
  const originalTimeout = h.w.setTimeout.bind(h.w);
  h.w.setTimeout = (callback, ms, ...args) => {
    if (ms !== 150) return originalTimeout(callback, ms, ...args);
    h.w.__elapsed += ms;
    queueMicrotask(() => callback(...args));
    return 0;
  };
}
test('SMS templates migrate legacy text and validate template identities and placeholders', t => {
  const h = harness(t);
  const legacy = plain(h.evaluate('settings'));
  delete legacy.smsTemplates;
  legacy.sms = 'Legacy {firstName}';
  const loaded = harness(t, { storedSettings: legacy });
  assert.ok(loaded.evaluate('settings.smsTemplates'), 'legacy settings gain a template collection');
  assert.deepEqual(plain(loaded.evaluate('settings.smsTemplates')), [{ id: 'default', name: 'Default', message: legacy.sms }]);
  for (const templates of [[], [{ id: 'x', name: 'Other', message: 'Hi' }],
    [{ id: 'default', name: 'Default', message: '{unknown}' }],
    [{ id: 'default', name: 'Default', message: 'Hi' }, { id: 'default', name: 'Again', message: 'Hi' }],
    [{ id: 'default', name: 'Default', message: 'Hi' }, { id: 'x', name: 'default', message: 'Hi' }]]) {
    assert.throws(() => h.evaluate(`validateSettings({ ...settings, smsTemplates: ${JSON.stringify(templates)} })`), /template|placeholder/i);
  }
});

test('SMS template settings save named templates and stable rule selections', t => {
  const h = harness(t);
  const form = settingsForm(h);
  assert.ok(form.querySelector('[data-add-sms-template]'));
  form.querySelector('[data-add-sms-template]').click();
  const rows = form.querySelectorAll('[data-sms-template-row]');
  assert.equal(rows.length, 2);
  rows[1].querySelector('[data-template-name]').value = 'Follow up';
  change(h, rows[1].querySelector('[data-template-name]'));
  rows[1].querySelector('[data-template-message]').value = 'Hello {fullName}';
  const rule = form.querySelector('.rule-row');
  const select = rule.querySelector('[data-sms-template]');
  select.value = rows[1].dataset.templateId;
  assert.equal(select.disabled, false, 'template selection is independent of SMS toggle');
  submitSettings(h, form);
  const saved = savedSettings(h);
  assert.equal(saved.smsTemplates[1].name, 'Follow up');
  assert.equal(saved.smsTemplates[1].message, 'Hello {fullName}');
  assert.equal(saved.rules[rule.querySelector('[data-stage]').value].smsTemplateId, saved.smsTemplates[1].id);
  const loaded = harness(t, { storedSettings: saved });
  const reopened = settingsForm(loaded);
  assert.equal(reopened.querySelector('.rule-row [data-sms-template]').value, saved.smsTemplates[1].id);
  const renamed = reopened.querySelectorAll('[data-template-name]')[1];
  renamed.value = 'Renamed'; change(loaded, renamed);
  assert.equal(reopened.querySelector('.rule-row [data-sms-template]').selectedOptions[0].textContent, 'Renamed');
  assert.equal(reopened.querySelector('.rule-row [data-sms-template]').value, saved.smsTemplates[1].id);
  reopened.querySelectorAll('[data-remove-sms-template]')[1].click();
  assert.equal(reopened.querySelectorAll('[data-sms-template-row]').length, 2, 'referenced template cannot be silently removed');
  assert.match(reopened.querySelector('[data-error]').textContent, /stage|rule/i);
  const selected = reopened.querySelector('.rule-row [data-sms-template]');
  selected.value = ''; change(loaded, selected);
  reopened.querySelectorAll('[data-remove-sms-template]')[1].click();
  assert.equal(reopened.querySelectorAll('[data-sms-template-row]').length, 1);
  assert.equal(reopened.querySelector('[data-remove-sms-template]').disabled, true);
});

for (const selection of ['follow', '', 'missing', 'no-rule']) test(`SMS buttons replace text with rendered templates; stage selection ${selection || 'fallback'}`, async t => {
  const h = deferredSmsFixture(t);
  h.evaluate(`settings.smsTemplates = [{ id: 'default', name: 'Default', message: 'Default {firstName}' },
    { id: 'follow', name: 'Follow up', message: 'Hello {fullName}' }];
    settings.rules['Attempted Contact'].smsTemplateId = ${JSON.stringify(selection)};`);
  if (selection === 'no-rule') h.evaluate("delete settings.rules['Attempted Contact']");
  const pending = h.evaluate('run()'); await flush();
  const dialog = h.w.document.querySelector('#pertama-confirm-actions');
  const form = dialog.querySelector('form'), editor = form.elements.namedItem('smsText');
  const buttons = dialog.querySelectorAll('[data-use-sms-template]');
  assert.equal(buttons.length, 2);
  const expected = h.evaluate(`renderTemplate(settings.smsTemplates[${selection === 'follow' ? 1 : 0}].message, { firstName: __apiContact.firstName, name: [__apiContact.firstName, __apiContact.lastName].filter(Boolean).join(' ') })`);
  assert.equal(editor.value, expected);
  assert.equal(dialog.querySelector('[data-sms-templates]').hidden, true);
  const toggle = form.elements.namedItem('sms'); toggle.checked = true; change(h, toggle); await flush();
  assert.equal(dialog.querySelector('[data-sms-templates]').hidden, false);
  editor.value = 'Manual edit'; buttons[1].click();
  assert.match(editor.value, /^Hello /);
  assert.equal(editor.value.includes('{'), false);
  assert.equal(dialog.open, true); assert.equal(h.w.__sentSms, undefined);
  editor.value = 'Keep this'; toggle.checked = false; change(h, toggle);
  toggle.checked = true; change(h, toggle); await flush();
  assert.equal(editor.value, 'Keep this');
  buttons[0].click(); assert.match(editor.value, /^Default /);
  const approvedMessage = editor.value;
  for (const key of ['stage', 'note', 'task']) form.elements.namedItem(key).checked = false;
  form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true })); await pending;
  assert.equal(h.w.__sentSms.message, approvedMessage);
});

function deferredSmsFixture(t) {
  const h = harness(t); apiContactFixture(h); h.pin();
  h.w.__smsCalls = 0;
  h.w.__smsResult = { contact: plain(h.w.__apiContact), to: h.w.__apiContact.phone,
    from: '+15555550101', fromNumbers: [{ number: '+15555550101', label: 'Your number' }], savedDraftCount: 1 };
  h.evaluate(`globalThis.prepareSmsApi = async () => {
    if (!document.querySelector('#pertama-confirm-actions')?.open) throw new Error('SMS loaded before confirmation was shown');
    __smsCalls++; return globalThis.__smsGate ? await __smsGate : __smsResult; };
    prepareSmsApi = globalThis.prepareSmsApi;
    globalThis.prepareSms = async () => { __smsCalls++; return { error: 'Legacy UI preparation' }; }; prepareSms = globalThis.prepareSms;
    globalThis.sendSmsApi = async () => { globalThis.__sentSms = JSON.parse(JSON.stringify(workflow.approvedActionContext.sms)); };
    sendSmsApi = globalThis.sendSmsApi; findNextActionable = async () => null; completeCallTask = async () => {};`);
  return h;
}
for (const smsDefault of [false, true]) for (const mode of ['cancel', 'send', 'toggle-off', 'prep-failure', 'empty-inventory', 'cancel-loading', 'route-change', 'stale-result']) {
  test(`deferred API SMS confirmation (default ${smsDefault}): ${mode}`, async t => {
    const h = deferredSmsFixture(t);
    h.evaluate(`settings.rules['Attempted Contact'].sendSms = ${smsDefault}`);
    let release;
    if (['toggle-off', 'cancel-loading', 'stale-result'].includes(mode)) h.w.__smsGate = new Promise(resolve => { release = resolve; });
    if (mode === 'prep-failure') h.evaluate('prepareSmsApi = async () => { __smsCalls++; throw new Error("SMS inventory unavailable"); }');
    if (mode === 'empty-inventory') h.w.__smsResult.from = null;
    const pending = h.evaluate('run()'); await flush();
    const dialog = h.w.document.getElementById('pertama-confirm-actions');
    assert.ok(dialog, h.alerts.join('\n'));
    const form = dialog.querySelector('form'), sms = form.elements.namedItem('sms');
    assert.equal(h.w.__smsCalls, smsDefault ? 1 : 0, 'SMS preparation follows the configured default');
    assert.equal(sms.checked, smsDefault);
    assert.equal(h.w.__sentSms, undefined, 'defaults never send before confirmation');
    assert.equal(sms.disabled, false);
    for (const field of ['stage', 'note', 'task']) form.elements.namedItem(field).checked = false;
    if (mode === 'cancel') { dialog.querySelector('[data-cancel]').click(); await pending; return; }
    if (!smsDefault) { sms.checked = true; sms.dispatchEvent(new h.w.Event('change', { bubbles: true })); await flush(); }
    assert.equal(form.elements.namedItem('smsText').hidden, false);
    assert.equal(form.elements.namedItem('smsText').rows, 7, 'expanded SMS shows several lines without manual resizing');
    assert.equal(h.w.__smsCalls, 1);
    if (mode === 'cancel-loading') {
      dialog.querySelector('[data-cancel]').click(); await pending;
      release(h.w.__smsResult); await flush();
      assert.equal(h.w.document.getElementById('pertama-confirm-actions'), null);
      assert.equal(h.w.__sentSms, undefined);
      assert.equal(h.evaluate('workflow.busy'), false);
      return;
    }
    if (mode === 'stale-result') {
      sms.checked = false; sms.dispatchEvent(new h.w.Event('change', { bubbles: true }));
      const oldRelease = release;
      h.w.__smsGate = new Promise(resolve => { release = resolve; });
      sms.checked = true; sms.dispatchEvent(new h.w.Event('change', { bubbles: true }));
      release({ ...h.w.__smsResult, from: '+15555550103' }); await flush();
      oldRelease(h.w.__smsResult); await flush();
      assert.match(dialog.querySelector('[data-sms-status]').textContent, /From: \+15555550103/);
      dialog.querySelector('[data-cancel]').click(); await pending; return;
    }
    if (mode === 'toggle-off' || mode === 'prep-failure' || mode === 'empty-inventory') {
      assert.equal(form.querySelector('[type="submit"]').disabled, true);
      if (mode === 'empty-inventory') assert.match(dialog.querySelector('[data-sms-status]').textContent, /choose.*sender/i);
      sms.checked = false; sms.dispatchEvent(new h.w.Event('change', { bubbles: true }));
      assert.equal(form.querySelector('[type="submit"]').disabled, false, 'SMS error/loading must not block non-SMS actions');
      if (release) { release(h.w.__smsResult); await flush(); }
      form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true })); await pending;
      assert.equal(h.w.__sentSms, undefined);
      assert.deepEqual(h.alerts, []);
      return;
    }
    assert.equal(form.elements.namedItem('smsFrom'), null);
    assert.match(dialog.querySelector('[data-sms-status]').textContent, /From: \+15555550101/);
    form.elements.namedItem('smsText').value = 'Approved independent message';
    assert.match(dialog.querySelector('[data-sms-status]').textContent, /draft.*(kept|untouched|unchanged)|preserv/i);
    if (mode === 'route-change') { h.route(BOARD_PATH); h.route(CONTACT_PATH); }
    form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true })); await pending;
    if (mode === 'route-change') {
      assert.equal(h.w.__sentSms, undefined);
      assert.deepEqual(h.alerts, []);
      assert.match(h.w.document.querySelector('#pertama-save-progress [data-report]').textContent, /changed/i);
    } else {
      assert.deepEqual(plain(h.w.__sentSms), { from: '+15555550101', to: '+628123456789', message: 'Approved independent message' });
      assert.deepEqual(h.alerts, []);
    }
    assert.equal(h.requests.length, 0, 'fixture uses only API stubs, never native composer');
  });
}
