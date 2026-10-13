const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { installWebGlobals, evaluateUserscript } = require('./helpers/userscript.cjs');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'gohigherlevel.user.js'), 'utf8');
const LOCATION = '3QixdLNutDXye95tTBK0';
const CONTACT = `/v2/location/${LOCATION}/contacts/detail/contact-a`;
const RUN = 'pertama-no-answer-button';
const NEXT = 'pertama-next-lead-button';
const SETTINGS = 'pertama-settings-button';
const sidebarHosts = '<aside id="sidebar"><nav><a id="hub">Message hub</a><a id="settings-anchor">Settings</a></nav></aside>';
const toolbarHost = '<header><button id="tb_business">Companies</button></header>';
const hosts = `${sidebarHosts}${toolbarHost}`;
const noise = Array.from({ length: 600 }, (_, i) => `<${i % 2 ? 'a' : 'button'}>Unrelated ${i}</${i % 2 ? 'a' : 'button'}>`).join('');

function harness(t, { mounted = true, toolbar = true, route = CONTACT, hidden = false, resize = true, flat = false } = {}) {
  const flatHosts = `<a id="hub">Message hub</a><a id="settings-anchor">Settings</a>${toolbar ? '<button id="tb_business">Companies</button>' : ''}`;
  const mountedHosts = flat ? flatHosts : `${sidebarHosts}${toolbar ? toolbarHost : ''}`;
  const dom = new JSDOM(`<!doctype html><body><div id="app">${mounted ? mountedHosts : ''}<main>${noise}</main></div></body>`, {
    url: `https://go.pertamaproperty.com${route}`, runScripts: 'outside-only',
    pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const w = dom.window, d = w.document;
  t.after(() => w.close());
  Object.defineProperty(d, 'readyState', { configurable: true, value: 'complete' });
  Object.defineProperty(d, 'hidden', { configurable: true, get: () => hidden });
  installWebGlobals(w);
  w.fetch = async () => { throw new Error('UI maintenance must not fetch'); };
  const counts = { scans: 0, visibility: 0, geometry: 0, observerRecords: 0 };
  const originalQuery = d.querySelectorAll.bind(d);
  d.querySelectorAll = selector => {
    if (/^a\s*,\s*button$/.test(selector)) counts.scans++;
    return originalQuery(selector);
  };
  let width = 200;
  w.HTMLElement.prototype.getClientRects = function () {
    counts.visibility++;
    return this.hidden ? [] : [{ width }];
  };
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    counts.geometry++;
    return { width, height: 40, x: 0, y: 0, top: 0, left: 0, bottom: 40, right: width };
  };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const frames = new Map(), timers = new Map(), intervals = [];
  let serial = 0, now = 0;
  w.requestAnimationFrame = callback => { frames.set(++serial, callback); return serial; };
  w.cancelAnimationFrame = id => frames.delete(id);
  w.setTimeout = (callback, delay = 0) => { timers.set(++serial, { callback, at: now + delay }); return serial; };
  w.clearTimeout = id => timers.delete(id);
  w.setInterval = (callback, delay) => { intervals.push({ callback, delay }); return ++serial; };
  w.clearInterval = () => {};
  const NativeObserver = w.MutationObserver;
  const observers = [];
  w.MutationObserver = class {
    constructor(callback) {
      this.targets = new Map();
      this.native = new NativeObserver(records => { counts.observerRecords += records.length; callback(records, this); });
      observers.push(this);
    }
    observe(target, options) { this.targets.set(target, { ...options }); this.native.observe(target, options); }
    disconnect() { this.targets.clear(); this.native.disconnect(); }
    takeRecords() { return this.native.takeRecords(); }
  };
  const resizeObservers = [];
  w.ResizeObserver = resize ? class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); resizeObservers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  } : undefined;
  w.localStorage.setItem(`pertama:pipelines:${LOCATION}`, JSON.stringify({ pipelines: [
    { id: 'pipe-a', name: 'Sales', stages: { 'New Lead': 'stage-new', 'Attempted Contact': 'stage-atc' } },
  ] }));
  const evaluate = evaluateUserscript(w, source);
  async function flush() {
    for (let round = 0; round < 12; round++) {
      await Promise.resolve();
      if (!frames.size) { await Promise.resolve(); if (!frames.size) return; }
      const batch = [...frames.values()]; frames.clear();
      for (const callback of batch) callback(now);
    }
    assert.fail('UI did not settle within 12 frames (possible own-mutation feedback loop)');
  }
  return {
    w, d, evaluate, counts, frames, intervals, observers, resizeObservers, flush,
    button: id => d.getElementById(id),
    reset() { for (const key of Object.keys(counts)) counts[key] = 0; },
    refresh() { assert.equal(evaluate('typeof refreshButtons'), 'function', 'closure must expose refreshButtons'); evaluate('refreshButtons()'); },
    setHidden(value) { hidden = value; d.dispatchEvent(new w.Event('visibilitychange')); },
    setWidth(value) { width = value; },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
      await flush();
    },
    recordMutations() {
      const records = [];
      const observer = new NativeObserver(batch => records.push(...batch));
      observer.observe(d.body, { subtree: true, childList: true, attributes: true, characterData: true });
      t.after(() => observer.disconnect());
      return records;
    },
  };
}
function assertPlacement(h) {
  for (const id of [RUN, NEXT, SETTINGS]) assert.ok(h.button(id), `${id} must be mounted`);
  assert.equal(h.button('tb_business').nextElementSibling, h.button(RUN));
  assert.equal(h.button('hub').nextElementSibling, h.button(NEXT));
  assert.equal(h.button('settings-anchor').previousElementSibling, h.button(SETTINGS));
  for (const id of [RUN, NEXT, SETTINGS]) assert.equal(h.button(id).hidden, false);
}
function broadObservers(h) {
  return h.observers.flatMap(observer => [...observer.targets].filter(([target, options]) =>
    [h.d, h.d.documentElement, h.d.body].includes(target) && options.subtree));
}

test('startup places controls synchronously without measuring hundreds of unrelated links', t => {
  const h = harness(t);
  assertPlacement(h);
  assert.ok(h.counts.visibility + h.counts.geometry < 20, JSON.stringify(h.counts));
  t.diagnostic(`Startup work with 600 unrelated controls: ${JSON.stringify(h.counts)}`);
});

test('mounted UI has no periodic placement timer or permanent document subtree observer', async t => {
  const h = harness(t); await h.flush();
  assert.equal(h.intervals.filter(timer => timer.delay === 500).length, 0, '500ms placement polling remains');
  assert.ok(h.observers.some(observer => observer.targets.size), 'host replacement needs scoped observation');
  assert.equal(broadObservers(h).length, 0);
  h.reset(); await h.advance(60000);
  assert.deepEqual(h.counts, { scans: 0, visibility: 0, geometry: 0, observerRecords: 0 });
});

test('refresh requests coalesce and stable controls incur no scans or redundant writes', async t => {
  const h = harness(t); await h.flush(); h.reset();
  const records = h.recordMutations();
  for (let i = 0; i < 30; i++) h.refresh();
  assert.equal(h.frames.size, 1, 'one queued animation frame per burst');
  await h.flush();
  for (let i = 0; i < 3; i++) { h.refresh(); await h.flush(); }
  assert.equal(h.counts.scans, 0, 'cached hosts must avoid global rescans');
  assert.equal(records.length, 0, 'unchanged labels/styles/positions must not be written again');
});

test('flat CRM hosts do not turn the application root into a subtree observer', async t => {
  const h = harness(t, { flat: true }); await h.flush(); h.reset();
  const app = h.d.getElementById('app');
  assert.ok(h.observers.every(observer => !observer.targets.get(app)?.subtree));
  h.d.querySelector('main').append(h.d.createElement('span')); await h.flush();
  assert.deepEqual(h.counts, { scans: 0, visibility: 0, geometry: 0, observerRecords: 0 });
});

test('unrelated main content mutations do not wake mounted UI', async t => {
  const h = harness(t); await h.flush(); h.reset();
  const main = h.d.querySelector('main');
  for (let i = 0; i < 20; i++) { const node = h.d.createElement('span'); node.textContent = String(i); main.append(node); }
  await h.flush();
  assert.deepEqual(h.counts, { scans: 0, visibility: 0, geometry: 0, observerRecords: 0 });
});

for (const selector of ['nav', '#sidebar', 'header']) {
  test(`replacing ${selector} repairs placement without polling`, async t => {
    const h = harness(t); await h.flush();
    const old = h.d.querySelector(selector);
    const replacement = old.cloneNode(true);
    replacement.querySelectorAll('[id^="pertama-"]').forEach(node => node.remove());
    old.replaceWith(replacement);
    await h.flush();
    assertPlacement(h);
    assert.equal(broadObservers(h).length, 0);
  });
}

for (const id of [RUN, NEXT, SETTINGS]) {
  test(`CRM removing only ${id} repairs the control without a host replacement`, async t => {
    const h = harness(t); await h.flush();
    h.button(id).remove(); await h.flush();
    assertPlacement(h);
  });
}

for (const flat of [false, true]) {
test(`reused navigation controls can become anchors again (flat=${flat})`, async t => {
  const h = harness(t, { flat }); await h.flush();
  h.button('settings-anchor').textContent = 'Contacts'; await h.flush();
  assert.equal(h.button(SETTINGS).hidden, true);
  h.button('settings-anchor').textContent = 'Settings'; await h.flush();
  assertPlacement(h);
});

}

test('a newly mounted visible sidebar replaces cached hidden navigation anchors', async t => {
  const h = harness(t); await h.flush();
  h.button('hub').hidden = true; h.button('settings-anchor').hidden = true;
  const sidebar = h.d.createElement('aside');
  sidebar.innerHTML = '<nav><a id="visible-hub">Message hub</a><a id="visible-settings">Settings</a></nav>';
  h.d.getElementById('app').append(sidebar); await h.flush();
  assert.equal(h.button('visible-hub').nextElementSibling, h.button(NEXT));
  assert.equal(h.button('visible-settings').previousElementSibling, h.button(SETTINGS));
  assert.equal(h.button(SETTINGS).hidden, false);
});

test('host mutations update widths without ResizeObserver support', async t => {
  const h = harness(t, { resize: false }); await h.flush();
  h.setWidth(80); h.button('sidebar').className = 'collapsed'; await h.flush();
  assert.equal(h.button(NEXT).style.fontSize, '11px');
});

test('missing Message hub falls back to immediately before Workflow settings', async t => {
  const h = harness(t); await h.flush();
  h.button('hub').remove(); await h.flush();
  assert.equal(h.button(NEXT).nextElementSibling, h.button(SETTINGS));
});

test('pinning a stage queue refreshes the label without waiting for a timer', async t => {
  const h = harness(t); await h.flush();
  h.evaluate("settings.priority = 'stage'"); h.refresh(); await h.flush();
  assert.match(h.button(NEXT).textContent, /Choose the original stage queue/);
  h.evaluate("pinStageQueue({ contactId: 'contact-a', opportunityId: 'opp-a', pipelineId: 'pipe-a', stageId: 'stage-atc' })");
  await h.flush();
  assert.equal(h.button(NEXT).textContent, 'Next lead — Next from: Sales · Attempted Contact');
});

test('saving settings wakes the label update without polling', async t => {
  const h = harness(t); await h.flush();
  h.button(SETTINGS).click();
  const form = h.d.querySelector('#pertama-settings form');
  assert.ok(form);
  form.elements.namedItem('priority').value = 'stage';
  form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  await h.flush();
  assert.equal(h.button(NEXT).textContent, 'Next lead — Choose the original stage queue');
});

test('catalog updates refresh a pinned queue label', async t => {
  const h = harness(t); await h.flush();
  h.evaluate("settings.priority = 'stage'; pinStageQueue({ contactId: 'contact-a', opportunityId: 'opp-a', pipelineId: 'pipe-a', stageId: 'stage-atc' })");
  h.refresh(); await h.flush();
  h.evaluate("rememberPipelines({ pipelines: [{ id: 'pipe-a', name: 'Renamed Sales', stages: [{ id: 'stage-atc', name: 'Renamed Stage' }] }] })");
  await h.flush();
  assert.equal(h.button(NEXT).textContent, 'Next lead — Next from: Renamed Sales · Renamed Stage');
});

test('window resize and observed host resize update responsive button sizes', async t => {
  const h = harness(t); await h.flush();
  h.setWidth(80); h.w.dispatchEvent(new h.w.Event('resize')); await h.flush();
  assert.equal(h.button(NEXT).style.fontSize, '11px');
  const active = h.resizeObservers.filter(observer => observer.targets.size);
  assert.ok(active.length, 'host width changes need ResizeObserver');
  h.setWidth(200);
  for (const observer of active) observer.callback([...observer.targets].map(target => ({ target, contentRect: { width: 200 } })), observer);
  await h.flush();
  assert.equal(h.button(NEXT).style.fontSize, '15px');
  assert.equal(h.button(SETTINGS).style.fontSize, '14px');
});

test('initial wrong-account route does no anchor scans or placement', async t => {
  const h = harness(t, { route: '/v2/location/other/contacts/detail/contact-a' }); await h.flush();
  assert.equal(h.counts.scans, 0);
  assert.equal(h.counts.visibility + h.counts.geometry, 0);
  for (const id of [RUN, NEXT, SETTINGS]) assert.ok(!h.button(id) || h.button(id).hidden, `${id} must not appear in another account`);
  h.w.history.pushState({}, '', CONTACT); await h.flush(); assertPlacement(h);
});

test('history and popstate hide wrong-account controls and restore the correct account', async t => {
  const h = harness(t); await h.flush(); h.reset();
  h.w.history.replaceState({}, '', '/v2/location/other/contacts/detail/contact-a'); await h.flush();
  for (const id of [RUN, NEXT, SETTINGS]) assert.ok(!h.button(id) || h.button(id).hidden);
  assert.equal(h.counts.scans, 0);
  h.w.history.pushState({}, '', CONTACT); await h.flush(); assertPlacement(h);
  // Dispatch popstate independently of the wrapped history methods.
  h.w.History.prototype.replaceState.call(h.w.history, {}, '', `/v2/location/${LOCATION}/opportunities`);
  h.w.dispatchEvent(new h.w.PopStateEvent('popstate')); await h.flush();
  assert.equal(h.button(RUN).hidden, true);
});

test('delayed host mounting is discovered and broad discovery observation disconnects', async t => {
  const h = harness(t, { mounted: false }); await h.flush(); h.reset();
  const fragment = h.d.createElement('div'); fragment.innerHTML = hosts;
  h.d.getElementById('app').append(fragment); await h.flush();
  assertPlacement(h);
  assert.equal(broadObservers(h).length, 0);
  assert.equal(h.counts.scans, 0, 'discovery must inspect added subtrees instead of rescanning the whole page');
});

test('missing contact toolbar does not observe the whole document during CRM boot', async t => {
  const h = harness(t, { toolbar: false }); await h.flush();
  assert.equal(broadObservers(h).length, 0, 'toolbar-only waiting must not watch all CRM boot mutations');
  h.reset();
  for (let i = 0; i < 50; i++) h.d.querySelector('main').append(h.d.createElement('section'));
  await h.flush();
  assert.deepEqual(h.counts, { scans: 0, visibility: 0, geometry: 0, observerRecords: 0 });
});

test('missing contact toolbar is found by bounded retries without mutation observation', async t => {
  const h = harness(t, { toolbar: false }); await h.flush(); h.reset();
  const header = h.d.createElement('header'); header.innerHTML = '<button id="tb_business">Companies</button>';
  h.d.getElementById('app').append(header);
  await h.advance(1000);
  assertPlacement(h);
  assert.equal(broadObservers(h).length, 0);
});

test('missing navigation hosts do not leave a broad discovery observer alive beyond 30 seconds', async t => {
  const h = harness(t, { mounted: false }); await h.flush();
  assert.ok(broadObservers(h).length, 'missing navigation hosts need temporary discovery observation');
  await h.advance(30001);
  assert.equal(broadObservers(h).length, 0);
});

test('discovery can recover on user interaction after its bounded window expires', async t => {
  const h = harness(t, { mounted: false }); await h.flush();
  await h.advance(30001);
  const fragment = h.d.createElement('div'); fragment.innerHTML = hosts;
  h.d.getElementById('app').append(fragment); await h.flush();
  h.d.querySelector('main').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await h.flush(); assertPlacement(h);
  assert.equal(broadObservers(h).length, 0);
});

test('hidden tabs defer refresh and host repair until visibility resumes', async t => {
  const h = harness(t); await h.flush();
  h.setHidden(true); await h.flush(); h.reset();
  h.setWidth(80); h.w.dispatchEvent(new h.w.Event('resize'));
  h.refresh(); await h.flush();
  assert.equal(h.counts.scans + h.counts.visibility + h.counts.geometry, 0);
  assert.equal(h.button(NEXT).style.fontSize, '15px');
  h.setHidden(false); await h.flush();
  assert.equal(h.button(NEXT).style.fontSize, '11px');
});
