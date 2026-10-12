const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'gohigherlevel.user.js'), 'utf8');
const LOCATION = '3QixdLNutDXye95tTBK0';
const ROUTE = `/v2/location/${LOCATION}/contacts/detail/contact-a`;
const TIMINGS = `pertama:workflow-timings:${LOCATION}`;
const NAVIGATION = `pertama:navigation-timing:${LOCATION}`;
const plain = value => JSON.parse(JSON.stringify(value));
const row = (action, phase, elapsedMs, result = 'ok') => ({ action, phase, elapsedMs, result });

function harness(t, { route = ROUTE, session = {}, denied = false, hidden = false, now = 10000, origin = 5000 } = {}) {
  const dom = new JSDOM('<!doctype html><body><nav><a>Message hub</a><a>Settings</a></nav><button id="tb_business">Companies</button></body>', {
    url: `https://go.pertamaproperty.com${route}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  for (const key of ['Headers', 'Request', 'Response', 'AbortController']) w[key] = globalThis[key];
  w.HTMLElement.prototype.getClientRects = function () { return this.hidden ? [] : [{ width: 200 }]; };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.document.getElementById('tb_business').hidden = hidden;
  w.fetch = async () => { throw new Error('Unexpected HTTP request'); };
  w.XMLHttpRequest.prototype.send = function () { throw new Error('Unexpected XHR'); };
  w.alert = () => {};
  let monotonic = 0;
  let wall = now;
  w.performance.now = () => monotonic;
  Object.defineProperty(w.performance, 'timeOrigin', { value: origin });
  w.Date.now = () => wall;
  for (const [key, value] of Object.entries(session)) w.sessionStorage.setItem(key, value);
  w.localStorage.setItem(`pertama:pipelines:${LOCATION}`, JSON.stringify({ pipelines: [
    { id: 'pipe-a', name: 'Sales', stages: { 'New Lead': 'stage-new', 'Attempted Contact': 'stage-atc' } },
  ] }));
  if (denied) {
    for (const method of ['getItem', 'setItem', 'removeItem']) {
      w.Storage.prototype[method] = () => { throw new w.DOMException('Storage denied', 'SecurityError'); };
    }
  }
  assert.match(source, /\}\)\(\);\s*$/);
  w.eval(source.replace(/\}\)\(\);\s*$/, 'globalThis.__timingTest = { evaluate(code) { return eval(code); } };\n})();'));
  const evaluate = code => w.__timingTest.evaluate(code);
  return { w, evaluate, tick(value) { monotonic = value; }, wall(value) { wall = value; },
    rows() { assert.ok(Array.isArray(w.pertamaWorkflowTimings), 'window.pertamaWorkflowTimings must be an array'); return plain(w.pertamaWorkflowTimings); } };
}

function requireTimers(h) {
  for (const name of ['startWorkflowTiming', 'markWorkflowTiming', 'finishWorkflowTiming']) {
    assert.equal(h.evaluate(`typeof ${name}`), 'function', `${name} must exist`);
  }
}
function requireNavigation(h) {
  assert.equal(h.evaluate('typeof recordNavigationReady'), 'function', 'recordNavigationReady must exist');
}

test('workflow timing separates read, human confirmation, and save using monotonic time', t => {
  const h = harness(t); requireTimers(h);
  h.tick(10); h.evaluate("startWorkflowTiming('Save and next', 'Prepare')");
  h.tick(35); h.wall(999999); h.evaluate("markWorkflowTiming('Confirmation')");
  h.tick(1035); h.wall(1); h.evaluate("markWorkflowTiming('Save')");
  h.tick(1080); h.evaluate("finishWorkflowTiming('ok')");
  assert.deepEqual(h.rows(), [row('Save and next', 'Prepare', 25), row('Save and next', 'Confirmation', 1000),
    row('Save and next', 'Save', 45), row('Save and next', 'Total', 1070)]);
  h.tick(2000); h.evaluate("finishWorkflowTiming('stopped'); markWorkflowTiming('Save')");
  assert.equal(h.rows().length, 4, 'finished timing must become inactive');
});

for (const outcome of ['cancelled', 'stopped']) {
  test(`workflow timing records ${outcome} on final phase and total`, t => {
    const h = harness(t); requireTimers(h);
    h.tick(5); h.evaluate("startWorkflowTiming('Save and next', 'Prepare')");
    h.tick(15); h.evaluate("markWorkflowTiming('Confirmation')");
    h.tick(115); h.evaluate(`finishWorkflowTiming('${outcome}')`);
    assert.deepEqual(h.rows(), [row('Save and next', 'Prepare', 10), row('Save and next', 'Confirmation', 100, outcome),
      row('Save and next', 'Total', 110, outcome)]);
  });
}

test('workflow timings keep only the most recent 50 flat rows and persist them', t => {
  const h = harness(t); requireTimers(h);
  for (let i = 1; i <= 30; i++) {
    h.tick(i * 100); h.evaluate("startWorkflowTiming('Next lead', 'Prepare')");
    h.tick(i * 100 + i); h.evaluate("finishWorkflowTiming('ok')");
  }
  const expected = [];
  for (let i = 6; i <= 30; i++) expected.push(row('Next lead', 'Prepare', i), row('Next lead', 'Total', i));
  assert.deepEqual(h.rows(), expected);
  assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(TIMINGS)), expected);
  for (const item of h.rows()) assert.deepEqual(Object.keys(item).sort(), ['action', 'elapsedMs', 'phase', 'result']);
});

test('workflow timings restore recent rows across reload', t => {
  const saved = Array.from({ length: 55 }, (_, i) => row('Next lead', 'Total', i));
  const h = harness(t, { session: { [TIMINGS]: JSON.stringify(saved) } });
  assert.deepEqual(h.rows(), saved.slice(-50));
});

for (const saved of ['not JSON', '{}', 'null']) {
  test(`invalid timing storage is ignored: ${saved}`, t => {
    const h = harness(t, { session: { [TIMINGS]: saved } });
    assert.deepEqual(h.rows(), []);
  });
}

test('denied storage never prevents in-memory workflow timings', t => {
  const h = harness(t, { denied: true }); requireTimers(h);
  assert.doesNotThrow(() => {
    h.evaluate("startWorkflowTiming('Next lead', 'Prepare')");
    h.tick(7); h.evaluate("finishWorkflowTiming('stopped')");
  });
  assert.deepEqual(h.rows(), [row('Next lead', 'Prepare', 7, 'stopped'), row('Next lead', 'Total', 7, 'stopped')]);
});

test('native timing measures route commitment, not a retained toolbar or document load', async t => {
  const h = harness(t);
  const target = `/v2/location/${LOCATION}/contacts/detail/contact-b`;
  const router = {
    currentRoute: { value: { name: 'contact_detail-v2', path: ROUTE } },
    resolve(path) { return { name: 'contact_detail-v2', href: path }; },
    async push(path) {
      h.tick(25);
      h.w.history.pushState({}, '', path);
      h.evaluate('recordNavigationReady()');
      assert.deepEqual(h.rows(), [], 'old visible toolbar must not finish native timing');
      h.tick(75); h.wall(999999);
      router.currentRoute.value = { name: 'contact_detail-v2', path };
    },
  };
  const root = h.w.document.createElement('div'); root.setAttribute('data-v-app', '');
  root.__vue_app__ = { config: { globalProperties: { $router: router } } };
  h.w.document.body.append(root);
  h.tick(10);
  await h.evaluate("openLead({ contactId: 'contact-b', opportunityId: 'opp-b', pipeline: 'Sales', pipelineId: 'pipe-a', stageId: 'stage-atc' })");
  assert.equal(h.w.location.pathname, target);
  assert.deepEqual(h.rows(), [row('Navigation', 'Native route committed', 65),
    row('Navigation', 'Previous contact controls released', 65)]);
  h.evaluate('recordNavigationReady()');
  assert.equal(h.rows().length, 2);
  assert.equal(h.w.sessionStorage.getItem(NAVIGATION), null);
});

test('openLead stores wall-clock navigation marker with source document origin', async t => {
  const h = harness(t);
  await h.evaluate("openLead({ contactId: 'contact-b', opportunityId: 'opp-b', pipeline: 'Sales', pipelineId: 'pipe-a', stageId: 'stage-atc' })");
  assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(NAVIGATION)), { contactId: 'contact-b', startedAt: 10000, sourceTimeOrigin: 5000 });
});

const marker = overrides => JSON.stringify({ contactId: 'contact-a', startedAt: 9000, sourceTimeOrigin: 1000, ...overrides });

test('button placement records navigation once and persists only non-identifying timing rows', t => {
  const h = harness(t, { session: { [NAVIGATION]: marker() } });
  h.evaluate('initializeButtons()');
  assert.deepEqual(h.rows(), [row('Navigation', 'Contact toolbar visible', 1000)]);
  assert.equal(h.w.sessionStorage.getItem(NAVIGATION), null);
  requireNavigation(h);
  h.wall(11000); h.evaluate('recordNavigationReady(); recordNavigationReady()');
  assert.deepEqual(h.rows(), [row('Navigation', 'Contact toolbar visible', 1000)]);
  const saved = h.w.sessionStorage.getItem(TIMINGS);
  assert.deepEqual(JSON.parse(saved), h.rows());
  assert.doesNotMatch(saved, /contact-a|contactId|authorization|phone|message|error/i);
});

test('navigation waits for a visible contact toolbar', t => {
  const h = harness(t, { hidden: true, session: { [NAVIGATION]: marker() } }); requireNavigation(h);
  h.evaluate('recordNavigationReady()');
  assert.deepEqual(h.rows(), []);
  h.w.document.getElementById('tb_business').hidden = false;
  h.wall(10500); h.evaluate('recordNavigationReady()');
  assert.deepEqual(h.rows(), [row('Navigation', 'Contact toolbar visible', 1500)]);
});

for (const [name, options] of [
  ['wrong contact', { session: { [NAVIGATION]: marker({ contactId: 'contact-b' }) } }],
  ['same document', { session: { [NAVIGATION]: marker({ sourceTimeOrigin: 5000 }) } }],
  ['wrong account', { route: '/v2/location/other-account/contacts/detail/contact-a', session: { [NAVIGATION]: marker() } }],
]) {
  test(`navigation never records success for ${name}`, t => {
    const h = harness(t, options); requireNavigation(h);
    h.evaluate('recordNavigationReady()');
    assert.deepEqual(h.rows(), []);
  });
}

for (const [name, value] of [
  ['malformed JSON', '{'], ['invalid shape', '{}'],
  ['missing source document', JSON.stringify({ contactId: 'contact-a', startedAt: 9000 })],
  ['expired', marker({ startedAt: -110001 })], ['future', marker({ startedAt: 10001 })],
]) {
  test(`navigation clears ${name} markers without reporting success`, t => {
    const h = harness(t, { session: { [NAVIGATION]: value } }); requireNavigation(h);
    assert.doesNotThrow(() => h.evaluate('recordNavigationReady()'));
    assert.deepEqual(h.rows(), []);
    assert.equal(h.w.sessionStorage.getItem(NAVIGATION), null);
  });
}

test('navigation measurement tolerates denied storage', t => {
  const h = harness(t, { denied: true }); requireNavigation(h);
  assert.doesNotThrow(() => h.evaluate('recordNavigationReady()'));
  assert.deepEqual(h.rows(), []);
});

test('optional navigation marker failure does not block otherwise valid navigation', async t => {
  const h = harness(t);
  const originalSet = h.w.Storage.prototype.setItem;
  h.w.Storage.prototype.setItem = function (key, value) {
    if (key === NAVIGATION) throw new h.w.DOMException('Storage full', 'QuotaExceededError');
    return originalSet.call(this, key, value);
  };
  await assert.doesNotReject(() => h.evaluate("openLead({ contactId: 'contact-b', opportunityId: 'opp-b', pipeline: 'Sales', pipelineId: 'pipe-a', stageId: 'stage-atc' })"));
  assert.equal(JSON.parse(h.w.sessionStorage.getItem(`pertama:stage-queue:${LOCATION}`)).contactId, 'contact-b');
});
