const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { installWebGlobals, evaluateUserscript } = require('./helpers/userscript.cjs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../gohigherlevel.user.js'), 'utf8');
const L = '3QixdLNutDXye95tTBK0';
const origin = 'https://services.leadconnectorhq.com';
const route = `/v2/location/${L}/contacts/detail/c1`;
const contact = { id: 'c1', locationId: L, firstName: 'Ada', lastName: 'Lee', phone: '+123', assignedTo: 'u1' };
const opp = { id: 'o1', contactId: 'c1', locationId: L, pipelineId: 'p1', pipelineStageId: 's1', assignedTo: 'u1' };
const query = { locationId: L, page: 1, limit: 100, query: '', sort: [], filters: [{ group: 'OR', filters: [{ field: 'contact_id', operator: 'eq', value: 'c1' }] }] };
const plain = value => JSON.parse(JSON.stringify(value));
function harness(t) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: `https://go.pertamaproperty.com${route}`, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const w = dom.window; t.after(() => w.close());
  installWebGlobals(w);
  let now = Date.now(); w.Date.now = () => now;
  const calls = []; let handler = url => url.includes('/contacts/') ? { contact } : { opportunities: [opp], total: 1 };
  w.fetch = async (url, init) => { calls.push({ url, init }); if (url instanceof Request) { if (url.body && init?.body === undefined) await url.text(); url = url.url; } const data = await handler(url, init); return data instanceof Response ? data : new Response(JSON.stringify(data), { status: 200 }); };
  w.XMLHttpRequest = class extends w.EventTarget {
    open(method, url) { this.url = url; } setRequestHeader() {} send() {}
    finish(data, status = 200) { this.status = status; this.responseText = JSON.stringify(data); this.dispatchEvent(new w.Event('loadend')); }
  };
  const e = evaluateUserscript(w, source);
  const headers = (id = 'u1', exp = now / 1000 + 3600) => ({ 'token-id': `x.${Buffer.from(JSON.stringify({ user_id: id, sub: id, locations: [L], exp })).toString('base64url')}.x` });
  const auth = (id, exp) => e(`captureReadHeaders('${origin}/contacts/c1', ${JSON.stringify(headers(id, exp))})`);
  auth();
  return { w, e, calls, auth, headers, advance: ms => { now += ms; }, handler: fn => { handler = fn; }, read: (kind = 'Details', fresh = false) => e(`readContact${kind}({fresh:${fresh}})`), flush: () => new Promise(resolve => setImmediate(resolve)) };
}
test('direct providers need no DOM and use exact read-only wire/auth contracts', async t => {
  const h = harness(t);
  assert.equal(h.e('typeof readContactDetails'), 'function');
  assert.deepEqual(plain(await h.read()), contact);
  assert.deepEqual(plain(await h.read('Opportunities')), [opp]);
  assert.equal(h.calls[0].url, `${origin}/contacts/c1`);
  assert.equal(h.calls[0].init.method, 'GET'); assert.equal(h.calls[0].init.body, undefined);
  assert.equal(h.calls[0].init.cache, 'no-store', 'explicit contact refresh must bypass the browser HTTP cache');
  assert.equal(h.calls[1].url, `${origin}/opportunities/search/`);
  assert.deepEqual(JSON.parse(h.calls[1].init.body), query);
  for (const { init } of h.calls) { assert.equal(init.headers.version, '2021-07-28'); assert.equal(init.headers['token-id'], h.headers()['token-id']); }
});
for (const transport of ['fetch', 'xhr']) test(`${transport} passive captures serve both kinds with zero extra requests`, async t => {
  const h = harness(t);
  for (const [url, method, body, data] of [[`${origin}/contacts/c1`, 'GET', undefined, { contact }], [`${origin}/opportunities/search/`, 'POST', query, { opportunities: [opp], total: 1 }]]) {
    if (transport === 'fetch') await h.w.fetch(url, { method, body: body && JSON.stringify(body), headers: h.headers() });
    else { const xhr = new h.w.XMLHttpRequest(); xhr.open(method, url); xhr.send(body && JSON.stringify(body)); xhr.finish(data); }
  }
  await h.flush(); const count = h.calls.length;
  assert.equal(h.e('typeof readContactDetails'), 'function');
  assert.deepEqual(plain(await h.read()), contact); assert.deepEqual(plain(await h.read('Opportunities')), [opp]);
  assert.equal(h.calls.length, count);
});
test('reject malformed, incomplete, duplicate, cross-contact and cross-account data', async t => {
  const h = harness(t);
  for (const value of [{ ...contact, id: 'c2' }, { ...contact, locationId: 'other' }, { ...contact, phone: {} }, null]) {
    h.handler(() => ({ contact: value })); await assert.rejects(h.read('Details', true));
  }
  for (const data of [{ opportunities: [opp], total: 2 }, { opportunities: [opp, opp], total: 2 }, { opportunities: [{ ...opp, contactId: 'c2' }], total: 1 }, { opportunities: [{ ...opp, locationId: 'other' }], total: 1 }, { opportunities: [{ ...opp, pipelineId: null }], total: 1 }, { opportunities: [], total: '0' }]) {
    h.handler(() => data); await assert.rejects(h.read('Opportunities', true));
  }
});
test('TTL starts at request start; fresh reads coalesce but bypass completed slots', async t => {
  const h = harness(t); let resolve; h.handler(() => new Promise(r => { resolve = r; }));
  const a = h.read(), b = h.read('Details', true); await h.flush(); assert.equal(h.calls.length, 1);
  h.advance(4900); resolve({ contact }); await Promise.all([a, b]); await h.read(); assert.equal(h.calls.length, 1);
  h.handler(() => ({ contact })); h.advance(101); await h.read(); assert.equal(h.calls.length, 2);
  await h.read('Details', true); assert.equal(h.calls.length, 3);
});
test('route away/back and auth changes invalidate caches and pending results', async t => {
  const h = harness(t); await h.read();
  h.w.history.pushState({}, '', '/away'); h.w.history.pushState({}, '', route); await h.read(); assert.equal(h.calls.length, 2);
  h.auth('u2'); await h.read(); assert.equal(h.calls.length, 3);
  let resolve; h.handler(() => new Promise(r => { resolve = r; })); const pending = h.read('Details', true); await h.flush();
  h.w.history.pushState({}, '', '/away'); h.w.history.pushState({}, '', route); resolve({ contact }); await assert.rejects(pending);
  h.auth('u3', 1); await assert.rejects(h.read(), /verified/);
});
for (const transport of ['fetch', 'xhr']) test(`${transport} mutation start/completion invalidates; reads during writes fail`, async t => {
  const h = harness(t); await h.read(); let finish;
  if (transport === 'fetch') {
    h.handler(() => new Promise((resolve, reject) => { finish = () => reject(new Error('write failed')); }));
    h.w.fetch(`${origin}/contacts/c1`, { method: 'PUT' }).catch(() => {});
  } else { const xhr = new h.w.XMLHttpRequest(); xhr.open('PUT', `${origin}/opportunities/o1`); xhr.send('{}'); finish = () => xhr.finish({}, 500); }
  await assert.rejects(h.read()); finish(); await h.flush();
  h.handler(() => ({ contact })); await h.read(); assert.equal(h.calls.length, transport === 'fetch' ? 3 : 2);
});
test('unsafe passive filters are not reusable and schema errors leave fetch unchanged', async t => {
  const h = harness(t);
  h.handler(() => ({ opportunities: [opp], total: 1 }));
  await h.w.fetch(`${origin}/opportunities/search/`, { method: 'POST', body: JSON.stringify({ ...query, filters: [...query.filters, { field: 'status', operator: 'eq', value: 'open' }] }) });
  await h.flush(); await h.read('Opportunities'); assert.equal(h.calls.length, 2);
});
test('authorization failure retires identity and all completed read slots', async t => {
  const h = harness(t); await h.read();
  h.handler(() => new Response('{}', { status: 401 }));
  await assert.rejects(h.read('Opportunities'));
  await assert.rejects(h.read(), /verified/);
});
for (const transport of ['fetch', 'xhr']) test(`${transport} authorization rejection invalidates completed and pending contact reads`, async t => {
  const h = harness(t); await h.read();
  let release;
  h.handler(() => new Promise(resolve => { release = resolve; }));
  const pending = h.read('Opportunities');
  const rejected = assert.rejects(pending, /verified|stale/);
  await h.flush();
  if (transport === 'fetch') {
    h.handler(() => new Response('{}', { status: 403 }));
    await h.w.fetch(`${origin}/contacts/c1`, { headers: h.headers() });
  } else {
    const xhr = new h.w.XMLHttpRequest(); xhr.open('GET', `${origin}/contacts/c1`); xhr.send(); xhr.finish({}, 401);
  }
  await h.flush();
  release({ opportunities: [opp], total: 1 });
  await rejected;
  await assert.rejects(h.read(), /verified/);
});

test('fetch Request input is captured before the native fetch consumes its body', async t => {
  const h = harness(t);
  const request = new Request(`${origin}/opportunities/search/`, { method: 'POST', body: JSON.stringify(query), headers: h.headers() });
  await h.w.fetch(request); await h.flush(); await h.read('Opportunities'); assert.equal(h.calls.length, 1);
});
test('diagnostics redact contact identity', async t => {
  const h = harness(t); await h.read();
  assert.equal(h.w.pertamaRequestDiagnostics[0].url, `${origin}/contacts/{id}`);
  assert.ok(!JSON.stringify(h.w.pertamaRequestDiagnostics).includes('c1'));
});
test('in-flight results cannot survive mutation start/completion or user change', async t => {
  const h = harness(t);
  for (const change of ['mutation', 'user']) {
    let resolve; h.handler(() => new Promise(r => { resolve = r; }));
    const pending = h.read('Details', true); await h.flush();
    if (change === 'user') h.auth('u2');
    else { const xhr = new h.w.XMLHttpRequest(); xhr.open('PATCH', `${origin}/contacts/c1`); xhr.send('{}'); xhr.finish({}, 500); }
    resolve({ contact }); await assert.rejects(pending, /stale/);
  }
});
test('backend contact GET and observed OR contact/id query can be reused', async t => {
  const h = harness(t);
  await h.w.fetch('https://backend.leadconnectorhq.com/contacts/c1');
  await h.w.fetch(`${origin}/opportunities/search/`, { method: 'POST', body: JSON.stringify({ ...query,
    filters: [{ group: 'OR', filters: [...query.filters[0].filters, { field: 'id', operator: 'eq', value: ['o1'] }] }] }) });
  await h.flush(); await h.read(); await h.read('Opportunities'); assert.equal(h.calls.length, 2);
});
test('passive reads started during saves or before navigation cannot populate slots', async t => {
  const h = harness(t); const xhr = new h.w.XMLHttpRequest(); xhr.open('PUT', `${origin}/contacts/c1`); xhr.send('{}');
  await h.w.fetch(`${origin}/contacts/c1`); xhr.finish({}); await h.flush(); await h.read(); assert.equal(h.calls.length, 2);
  const late = new h.w.XMLHttpRequest(); late.open('GET', `${origin}/contacts/c1`); late.send();
  h.w.history.pushState({}, '', '/away'); h.w.history.pushState({}, '', route); late.finish({ contact });
  await h.flush(); await h.read(); assert.equal(h.calls.length, 3);
});
test('bad passive schema and board/other-contact queries never become contact slots', async t => {
  const h = harness(t);
  h.handler(() => ({ contact: { ...contact, id: 'wrong' } }));
  const response = await h.w.fetch(`${origin}/contacts/c1`); assert.equal(response.status, 200); await h.flush();
  h.handler(url => url.includes('/contacts/') ? { contact } : { opportunities: [opp], total: 1 });
  await h.read(); assert.equal(h.calls.length, 2);
  for (const body of [{ ...query, aggregations: [] }, { ...query, filters: [{ group: 'OR', filters: [{ field: 'contact_id', operator: 'eq', value: 'other' }] }] }]) {
    await h.w.fetch(`${origin}/opportunities/search/`, { method: 'POST', body: JSON.stringify(body) });
  }
  await h.flush(); await h.read('Opportunities'); assert.equal(h.calls.length, 5);
});
test('a slow fresh response is usable even after the reuse TTL expires', async t => {
  const h = harness(t); let release;
  h.handler(() => new Promise(resolve => { release = resolve; }));
  const pending = h.read(); await h.flush();
  h.advance(6000); release({ contact });
  assert.deepEqual(plain(await pending), contact);
  h.handler(() => ({ contact }));
  await h.read(); assert.equal(h.calls.length, 2, 'slow response must not become a reusable old cache hit');
});

test('pending reads still coalesce after the cache reuse TTL expires', async t => {
  const h = harness(t); let release;
  h.handler(() => new Promise(resolve => { release = resolve; }));
  const first = h.read(); await h.flush(); h.advance(6000);
  const second = h.read('Details', true); await h.flush();
  assert.equal(h.calls.length, 1);
  release({ contact });
  assert.deepEqual(plain(await Promise.all([first, second])), [contact, contact]);
});

for (const unsafe of [{ ...query, aggregations: [] }, { ...query, filters: [] }]) {
  test(`irrelevant search response is not cloned or parsed: ${JSON.stringify(Object.keys(unsafe))}`, async t => {
    const h = harness(t); let clones = 0;
    const response = new Response(JSON.stringify({ opportunities: [opp], total: 1 }));
    const clone = response.clone.bind(response);
    response.clone = () => { clones++; return clone(); };
    h.handler(() => response);
    await h.w.fetch(`${origin}/opportunities/search/`, { method: 'POST', body: JSON.stringify(unsafe) });
    await h.flush(); assert.equal(clones, 0, 'do not duplicate CRM JSON work for non-contact reads');
  });
}

test('extra unverified contact-search restrictions cannot establish a complete contact snapshot', async t => {
  const h = harness(t);
  await h.w.fetch(`${origin}/opportunities/search/`, { method: 'POST', body: JSON.stringify({ ...query, pipelineId: 'p1' }) });
  await h.flush();
  await h.read('Opportunities');
  assert.equal(h.calls.length, 2, 'unknown top-level restrictions may hide other opportunities');
});

test('allowlist rejects writes, unsafe GET paths, bodies and other reads', async t => {
  const h = harness(t);
  for (const [method, path, body] of [['PUT', '/contacts/c1', {}], ['GET', '/users', undefined], ['GET', '/contacts/c1/notes', undefined], ['GET', '/contacts/c1', {}], ['GET', '/contacts/a%2fb', undefined]]) {
    await assert.rejects(h.e(`crmRequest(${JSON.stringify(method)}, ${JSON.stringify(path)}, ${JSON.stringify(body)})`));
  }
  assert.equal(h.calls.length, 0);
});
