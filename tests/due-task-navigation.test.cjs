const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../gohigherlevel.user.js'), 'utf8');
const L = '3QixdLNutDXye95tTBK0';
const NOW = '2026-10-12T08:00:00.000Z';
const KEY = 'pertama:query:tasks';
const storedQuery = {
  locationId: L, page: 1, pageLimit: 20,
  filters: [{ group: 'AND', filters: [
    { group: 'OR', filters: [] }, { field: 'properties.completed', operator: 'eq', value: 0 },
    { field: 'properties.dueDate', operator: 'range', value: { gte: '1901-01-01T01:15:32+07:57', lte: '2026-10-12T05:01:04Z' } },
  ] }],
  includeTopRelations: true, sort: [{ field: 'properties.dueDate', direction: 'desc' }], includeRecurringTaskConfigs: true,
};
const task = dueDate => ({ id: 't1', locationId: L, properties: { completed: 0, dueDate },
  relations: [{ associationId: 'TASK_CONTACT_ASSOCIATION', objectKey: 'contact', recordId: 'c2' }] });
const list = rows => ({ customObjectRecords: rows, total: rows.length });
const fields = (filters, field) => filters.flatMap(filter => filter.filters ? fields(filter.filters, field) : filter.field === field ? [filter] : []);
function harness(t, { template, rows = [task('2026-10-12T07:00:00Z')], respectDates = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><nav><a>Message hub</a><a>Settings</a></nav><button id="tb_business">Companies</button></body>', {
    url: `https://go.pertamaproperty.com/v2/location/${L}/contacts/detail/c1`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const w = dom.window; t.after(() => w.close());
  for (const key of ['Request', 'Response', 'Headers', 'AbortController']) w[key] = globalThis[key];
  w.HTMLElement.prototype.getClientRects = () => [{ width: 200 }];
  let now = Date.parse(NOW), response = rows;
  const NativeDate = w.Date;
  w.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  const requests = [];
  w.fetch = async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url: String(url), method: init.method, body });
    const ranges = fields(body.filters, 'properties.dueDate');
    const selected = respectDates ? response.filter(row => ranges.every(filter => {
      if (filter.operator !== 'range') return true;
      const due = Date.parse(row.properties.dueDate);
      return due >= Date.parse(filter.value.gte) && due <= Date.parse(filter.value.lte);
    })) : response;
    return new Response(JSON.stringify(list(selected)));
  };
  if (template) w.localStorage.setItem(KEY, JSON.stringify(template));
  w.eval(source.replace(/\}\)\(\);\s*$/, 'globalThis.__taskNavigation = { evaluate(code) { return eval(code); } };\n})();'));
  const e = code => w.__taskNavigation.evaluate(code);
  const token = `x.${Buffer.from(JSON.stringify({ user_id: 'u1', sub: 'u1', locations: [L], exp: now / 1000 + 365 * 86400 })).toString('base64url')}.x`;
  e(`initializeButtons(); captureReadHeaders('https://services.leadconnectorhq.com/opportunities/search', ${JSON.stringify({ 'token-id': token })})`);
  return { w, e, requests, run: () => e('topTaskContact()'), setNow: value => { now = Date.parse(value); }, respond: value => { response = value; } };
}

test('saved Overdue cutoff is refreshed so tasks that became due later are found', async t => {
  const h = harness(t, { template: storedQuery });
  assert.equal((await h.run()).contactId, 'c2');
  const query = h.requests[0].body;
  const due = fields(query.filters, 'properties.dueDate');
  assert.equal(due.length, 1);
  assert.equal(due[0].operator, 'range');
  assert.equal(due[0].value.lte, NOW);
  const expectedFilters = JSON.parse(JSON.stringify(storedQuery.filters));
  expectedFilters[0].filters[2].value = { gte: '1901-01-01T00:00:00Z', lte: NOW };
  assert.deepEqual(query.filters, expectedFilters, 'retain the demonstrated native filter structure');
  assert.deepEqual(query.sort, storedQuery.sort);
  assert.equal(query.includeTopRelations, true);
  assert.deepEqual(JSON.parse(h.w.localStorage.getItem(KEY)), storedQuery, 'stored capture must not be mutated');
  assert.deepEqual(JSON.parse(h.e('JSON.stringify(queryTemplates.tasks)')), storedQuery);
});

test('default task lookup is due-only without opening Tasks or Overdue', async t => {
  const h = harness(t, { rows: [task('2026-10-12T08:00:00.001Z')] });
  assert.equal(await h.run(), null);
  assert.equal(fields(h.requests[0].body.filters, 'properties.dueDate')[0].value.lte, NOW);
  assert.equal(h.w.localStorage.getItem(KEY), null);
});

test('each lookup uses the current cutoff, including after the date changes', async t => {
  const h = harness(t, { template: storedQuery }); await h.run();
  h.setNow('2026-10-13T00:30:00.000Z'); h.respond([task('2026-10-13T00:00:00Z')]);
  assert.equal((await h.run()).contactId, 'c2');
  assert.deepEqual(h.requests.map(r => fields(r.body.filters, 'properties.dueDate')[0].value.lte), [NOW, '2026-10-13T00:30:00.000Z']);
});

test('old date windows are replaced while non-date filters, query text and sort survive', async t => {
  const template = JSON.parse(JSON.stringify(storedQuery));
  template.query = 'Call'; template.page = 4;
  template.filters[0].filters.push({ field: 'owners', operator: 'eq', value: ['u1'] },
    { group: 'OR', filters: [{ field: 'properties.dueDate', operator: 'range', value: { gte: '2026-10-11T00:00:00Z', lte: '2026-10-11T23:59:59Z' } }] });
  const h = harness(t, { template });
  assert.equal((await h.run()).contactId, 'c2');
  const query = h.requests[0].body;
  assert.equal(fields(query.filters, 'properties.dueDate').length, 1);
  assert.deepEqual(fields(query.filters, 'owners'), [{ field: 'owners', operator: 'eq', value: ['u1'] }]);
  assert.deepEqual(fields(query.filters, 'properties.completed'), [{ field: 'properties.completed', operator: 'eq', value: 0 }]);
  assert.equal(query.query, 'Call'); assert.equal(query.page, 1); assert.equal(query.pageLimit, 20);
  assert.deepEqual(query.sort, template.sort);
});

for (const due of ['2026-10-11T08:00:00Z', NOW, '2026-10-12T16:00:00+08:00']) {
  test(`already-due response is actionable: ${due}`, async t => {
    const h = harness(t, { rows: [task(due)], respectDates: false });
    assert.equal((await h.run()).contactId, 'c2');
  });
}

for (const due of ['2026-10-12T08:00:00.001Z', '2026-10-13T00:00:00Z', 'invalid', '', null, undefined]) {
  test(`future or invalid top task is rejected without action: ${due}`, async t => {
    const h = harness(t, { rows: [task(due)], respectDates: false });
    await assert.rejects(h.run(), /due|date|future/i);
    assert.equal(h.requests.length, 1, 'no fallback lookup or task mutation');
  });
}

test('empty due-task result is not mistaken for a failed lookup', async t => {
  const h = harness(t, { rows: [] }); assert.equal(await h.run(), null);
});

test('saved completed-task filters still fail before a request', async t => {
  const template = JSON.parse(JSON.stringify(storedQuery)); template.filters[0].filters[1].value = 1;
  const h = harness(t, { template }); await assert.rejects(h.run(), /pending tasks/); assert.equal(h.requests.length, 0);
});

test('Next lead looks up a due follow-up without a task-list UI visit', async t => {
  const h = harness(t, { template: storedQuery });
  h.e("settings.priority = 'tasks'; globalThis.__opened = null; openLead = async lead => { __opened = lead.contactId; }");
  await h.e('nextLead()'); assert.equal(h.e('__opened'), 'c2');
  assert.equal(h.requests.length, 1);
});
