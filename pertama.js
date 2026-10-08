// ==UserScript==
// @name         Pertama — No answer
// @namespace    pertama-local
// @version      0.2.9
// @description  No-answer workflow and a Next lead button for the Opportunities dashboard.
// @match        https://go.pertamaproperty.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  if (window.__pertamaNoAnswerInstalled) return;
  window.__pertamaNoAnswerInstalled = true;

  // Account boundary; workflow defaults below remain editable in Settings.
  const LOCATION_ID = '3QixdLNutDXye95tTBK0';
  const SMS_NOTICE_KEY = `pertama:sms-notice:${LOCATION_ID}`;
  const NAV_PIPELINES = [];
  const SETTINGS_KEY = `pertama:settings:${LOCATION_ID}`;
  const CATALOG_KEY = `pertama:pipelines:${LOCATION_ID}`;
  const SETTINGS_DEFAULTS = {
    note: 'No answer. Will contact again.', task: 'Call again {fullName}',
    sms: 'Hi {firstName}, following up on your property enquiry. Please let me know a convenient time to speak. Thanks!',
    priority: 'leads', newLeadStage: 'New Lead', pipelineIds: [],
    rules: {
      'New Lead': { next: 'Attempted Contact', days: 1, updateStage: true },
      'Attempted Contact': { next: 'ATC 2', days: 3, updateStage: true },
      'ATC 2': { next: 'ATC 3', days: 5, updateStage: true },
      'ATC 3': { next: 'Robot', days: null, updateStage: true },
      'Contacted': { next: 'Robot', days: 2, updateStage: false },
    },
  };
  let settings = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
  function validateSettings(value) {
    if (!value || !['leads', 'tasks', 'stage'].includes(value.priority)
      || !Array.isArray(value.pipelineIds) || value.pipelineIds.some(id => typeof id !== 'string')
      || new Set(value.pipelineIds).size !== value.pipelineIds.length) throw new Error('Invalid pipeline selection or priority.');
    for (const key of ['note', 'task', 'sms', 'newLeadStage']) {
      if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`${key} cannot be blank.`);
    }
    for (const key of ['note', 'task', 'sms']) {
      if (/\{(?!firstName\}|fullName\})[^{}]*\}/.test(value[key])) throw new Error('Use only {firstName} and {fullName} placeholders.');
    }
    if (!value.rules || typeof value.rules !== 'object' || Array.isArray(value.rules)) throw new Error('Invalid shared stage rules.');
    for (const [stage, rule] of Object.entries(value.rules)) {
      if (!stage.trim() || !rule || typeof rule.next !== 'string' || !rule.next.trim()
        || typeof rule.updateStage !== 'boolean'
        || rule.days !== null && (!Number.isInteger(rule.days) || rule.days < 0 || rule.days > 36500)) {
        throw new Error('Each stage rule needs a destination and whole follow-up days from 0 to 36500, or no task.');
      }
    }
    return value;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (saved) settings = validateSettings(saved);
  } catch { /* Keep defaults when saved settings are unreadable. */ }
  function renderTemplate(template, { firstName, name }) {
    return template.replace(/\{(firstName|fullName)\}/g, (_, key) => key === 'firstName' ? firstName || name : name);
  }
  function normalizePipelines(data) {
    if (!Array.isArray(data?.pipelines)) throw new Error('Pipeline list is unreadable.');
    const ids = new Set();
    return data.pipelines.map(p => {
      if (!p.id || typeof p.name !== 'string' || !Array.isArray(p.stages) || ids.has(p.id)) throw new Error('Invalid pipeline metadata.');
      ids.add(p.id);
      const stages = Object.create(null);
      for (const stage of p.stages) {
        if (!stage.id || typeof stage.name !== 'string' || Object.hasOwn(stages, stage.name)) throw new Error('Ambiguous pipeline stage names.');
        stages[stage.name] = stage.id;
      }
      return { id: p.id, name: p.name, stages };
    });
  }
  function rememberPipelines(data) {
    const pipelines = normalizePipelines(data);
    localStorage.setItem(CATALOG_KEY, JSON.stringify({ pipelines }));
    NAV_PIPELINES.splice(0, NAV_PIPELINES.length, ...pipelines);
  }
  try {
    const cached = JSON.parse(localStorage.getItem(CATALOG_KEY) || 'null');
    if (cached) {
      const raw = { pipelines: cached.pipelines.map(p => ({ ...p, stages: Object.entries(p.stages).map(([name, id]) => ({ name, id })) })) };
      NAV_PIPELINES.splice(0, NAV_PIPELINES.length, ...normalizePipelines(raw));
    }
  } catch { /* Discovery will populate the catalog when the CRM loads its list. */ }
  function pipelineListRequest(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.origin === 'https://backend.leadconnectorhq.com'
        && parsed.pathname === '/opportunities/pipelines' && parsed.searchParams.get('locationId') === LOCATION_ID;
    } catch { return false; }
  }
  // Read identity from the authentication header the CRM already uses.
  // Credentials and identity stay in memory; no saved identity or preferences lookup.
  let currentUserId = null;
  let identityStatus = 'Awaiting CRM authentication headers';
  let identityExpires = 0;
  window.pertamaUserDiagnostics = () => ({ version: '0.2.9', status: identityStatus,
    verified: Boolean(currentUserId) && identityExpires > Date.now() / 1000 });
  async function requireVerifiedUser() {
    if (!currentUserId || identityExpires <= Date.now() / 1000) {
      throw new Error(`Current CRM user has not been verified: ${identityStatus}. No fallback user was used.`);
    }
  }
  function userFromHeaders(headers) {
    const token = (headers['token-id'] || headers.authorization || '').replace(/^Bearer\s+/i, '');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('CRM authentication token is unreadable');
    const raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, '=')));
    if (typeof claims.user_id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(claims.user_id)
      || claims.sub !== claims.user_id) throw new Error('CRM token identity fields are missing or inconsistent');
    if (!Array.isArray(claims.locations) || !claims.locations.includes(LOCATION_ID)) throw new Error('CRM token does not cover this account');
    if (!Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) throw new Error('CRM authentication token has expired');
    return { id: claims.user_id, expires: claims.exp };
  }
  function bindUserSession(headers) {
    try {
      const user = userFromHeaders(headers);
      currentUserId = user.id;
      identityExpires = user.expires;
      identityStatus = 'Identified from current CRM authentication';
    } catch (error) {
      currentUserId = null;
      identityExpires = 0;
      identityStatus = error.message;
    }
  }
  function scopeLeadFilters(filters, id) {
    function removeUserFilters(items) {
      return (items || []).flatMap(item => {
        if (item.filters) {
          const children = removeUserFilters(item.filters);
          return children.length ? [{ ...item, filters: children }] : [];
        }
        return ['assigned_to', 'followers'].includes(item.field) ? [] : [item];
      });
    }
    return [...removeUserFilters(filters), { group: 'OR', filters: [
      { group: 'AND', filters: [{ field: 'assigned_to', operator: 'eq', value: [id] }] },
      { group: 'AND', filters: [{ field: 'followers', operator: 'eq', value: [id] }] },
    ] }];
  }
  // Generic request shape; captured CRM searches preserve the user's filters/order.
  const queryTemplates = {};
  function defaultPipelineQuery(pipeline) {
    return {
      locationId: LOCATION_ID,
      filters: [
        { field: 'pipeline_id', operator: 'eq', value: [pipeline.id] },
      ],
      query: '', sort: [{ field: 'last_stage_change_date', direction: 'asc' }], limit: 1,
      additionalDetails: { notes: false, tasks: false, calendarEvents: false, unReadConversations: false },
      includeTopRelations: true,
      aggregations: [{ name: 'pipelines', type: 'terms', field: 'pipeline_stage_id', size: 1,
        options: { include: Object.values(pipeline.stages) },
        aggregations: [
          { name: 'top_opportunities', type: 'top_hits', size: 20,
            options: { sort: [{ last_stage_change_date: { order: 'asc' } }] } },
          { name: 'revenues', type: 'sum', field: 'monetary_value' },
        ],
      }],
    };
  }
  queryTemplates.tasks = {
    locationId: LOCATION_ID, page: 1, pageLimit: 20,
    filters: [{ group: 'AND', filters: [
      { group: 'OR', filters: [] }, { field: 'properties.completed', operator: 'eq', value: 0 },
    ] }],
    includeTopRelations: true, sort: [{ field: 'properties.dueDate', direction: 'asc' }],
    includeRecurringTaskConfigs: true,
  };
  for (const key of Object.keys(queryTemplates)) {
    try {
      const saved = JSON.parse(localStorage.getItem(`pertama:query:${key}`) || 'null');
      if (saved?.locationId === LOCATION_ID) queryTemplates[key] = saved;
    } catch { /* Use the recorded filters and sort as defaults. */ }
  }
  // Query templates contain filters/order only. Authentication stays in memory.
  let liveReadHeaders = null;
  function captureReadHeaders(url, headers) {
    try {
      if (new URL(url, location.href).origin !== 'https://services.leadconnectorhq.com') return;
      const incoming = new Headers(headers);
      if (!incoming.has('token-id') && !incoming.has('authorization')) return;
      // Ignore other service clients; these requests use the CRM's web session.
      if (incoming.has('channel') && incoming.get('channel') !== 'APP'
        || incoming.has('source') && incoming.get('source') !== 'WEB_USER') return;
      const safe = {};
      for (const key of ['token-id', 'authorization']) {
        if (incoming.has(key)) safe[key] = incoming.get(key);
      }
      liveReadHeaders = safe;
      bindUserSession(safe);
    } catch { /* Never interfere with CRM traffic. */ }
  }
  function filterValues(filters, field) {
    return (filters || []).flatMap(f => f.filters ? filterValues(f.filters, field)
      : f.field === field && f.operator === 'eq' ? [f.value].flat() : []);
  }
  function rememberQuery(path, body) {
    if (body?.locationId !== LOCATION_ID) return;
    let key;
    if (path === '/opportunities/search' && body.aggregations?.some(a => a.name === 'pipelines')) {
      const ids = filterValues(body.filters, 'pipeline_id');
      if (ids.length === 1 && NAV_PIPELINES.some(p => p.id === ids[0])) key = ids[0];
    } else if (path === '/objects/task/records/search' && body.includeTopRelations
      && body.page === 1 && filterValues(body.filters, 'properties.completed').includes(0)
      && !JSON.stringify(body.filters).includes('TASK_CONTACT_ASSOCIATION')) key = 'tasks';
    if (key) {
      queryTemplates[key] = body;
      try { localStorage.setItem(`pertama:query:${key}`, JSON.stringify(body)); } catch { /* Memory copy is enough. */ }
    }
  }
  function captureQuery(method, url, body) {
    try {
      const parsed = new URL(url, location.href);
      const path = parsed.pathname.replace(/\/$/, '');
      if (method !== 'POST' || parsed.origin !== 'https://services.leadconnectorhq.com'
        || !['/opportunities/search', '/objects/task/records/search'].includes(path)) return;
      Promise.resolve().then(body).then(raw => rememberQuery(path, jsonValue(raw)), () => {});
    } catch { /* Observer only. */ }
  }
  async function readList(path, body) {
    if (!['/opportunities/search', '/objects/task/records/search'].includes(path)
      || body.locationId !== LOCATION_ID) throw new Error('Read query is outside the permitted contact lists.');
    return crmRequest('POST', path, body);
  }
  // Keep exact wire URLs from the recordings, including trailing slashes.
  // Use endpoint-specific non-secret headers rather than the last request's metadata.
  function wireRequest(method, path, body) {
    const headers = { accept: 'application/json, text/plain, */*',
      channel: 'APP', source: 'WEB_USER', version: '2021-07-28' };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    if (method === 'POST' && !(path === '/opportunities/search' && body?.aggregations)) headers.developer_version = '';
    const wirePath = path === '/notes' || path === '/opportunities/search' && !body?.aggregations ? `${path}/` : path;
    return { url: `https://services.leadconnectorhq.com${wirePath}`, headers };
  }
  // Diagnostics contain request metadata only, never tokens or message bodies.
  const requestDiagnostics = [];
  window.pertamaRequestDiagnostics = requestDiagnostics;
  async function crmRequest(method, path, body, saveDescription = '') {
    if (method !== 'POST' || !['/opportunities/search', '/objects/task/records/search'].includes(path)
      || body?.locationId !== LOCATION_ID || saveDescription) throw new Error('Direct requests are restricted to read-only lead/task searches.');
    await wait(() => liveReadHeaders, 'live CRM session',
      () => 'No session headers observed. Reload the CRM once after installing this script.', 30000);
    const wire = wireRequest(method, path, body);
    const diagnostic = { method, url: wire.url, started: new Date().toISOString(), status: null,
      result: 'pending', requestFields: Object.keys(body || {}) };
    requestDiagnostics.push(diagnostic);
    if (requestDiagnostics.length > 30) requestDiagnostics.shift();
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await originalFetch.call(window, wire.url, {
        method, headers: { ...wire.headers, ...liveReadHeaders },
        redirect: 'error',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
      });
      diagnostic.status = response.status;
      if (!response.ok) {
        if ([401, 403].includes(response.status)) liveReadHeaders = null;
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a JSON object response.');
      diagnostic.responseFields = Object.keys(data);
      if (data.error || data.errors?.length) throw new Error('Server returned an error in its response.');
      diagnostic.result = 'response received';
      return data;
    } catch (error) {
      diagnostic.result = error.name === 'AbortError' ? 'timeout' : diagnostic.status === null ? 'no HTTP response available' : 'response rejected';
      console.error('Pertama request failed', diagnostic);
      const detail = diagnostic.status === null && error.name !== 'AbortError'
        ? ' Browser supplied no HTTP response. Inspect Network/Console for a connection, CORS or redirect error; the cause cannot be determined here.' : '';
      throw new Error(`${method} ${new URL(wire.url).pathname}: ${error.name === 'AbortError' ? 'Timed out after 30 seconds' : error.message}. Lookup failed.${detail} No automatic retry.`);
    } finally { diagnostic.elapsedMs = Date.now() - started; clearTimeout(timeout); }
  }
  function opportunityFromResponse(data, pipeline, stage, excludedContact) {
    const group = data.aggregations?.pipelines;
    if (!Array.isArray(group?.buckets) || group.docCountErrorUpperBound !== 0 || group.sumOtherDocCount !== 0) {
      throw new Error('Stage counts are incomplete or unreadable. No fallback taken.');
    }
    const bucket = group.buckets.find(b => b.key === pipeline.stages[stage]);
    if (!bucket || bucket.docCount === 0) return null;
    const hits = bucket.topOpportunities?.hits?.hits;
    if (!Array.isArray(hits) || !hits.length) throw new Error('Stage has leads but no readable top result.');
    for (const hit of hits) {
      const lead = hit._source;
      if (lead?.pipelineId !== pipeline.id || lead.pipelineStageId !== pipeline.stages[stage]
        || lead.locationId !== LOCATION_ID || !hit._id || !lead.contactId) throw new Error('Top lead does not match the requested pipeline/stage/contact.');
      if (lead.contactId !== excludedContact) return { contactId: lead.contactId, opportunityId: hit._id,
        pipeline: pipeline.name, pipelineId: pipeline.id, stageId: pipeline.stages[stage] };
    }
    if (bucket.docCount > hits.length) throw new Error('More leads exist beyond this response. No fallback taken.');
    return null;
  }
  async function topPipelineLead(pipeline, stage = 'New Lead', excludedContact = null, sameStage = false) {
    await requireVerifiedUser();
    if (!pipeline?.stages[stage]) throw new Error(`Unrecognised pipeline/stage: ${stage}`);
    if (!queryTemplates[pipeline.id]) {
      try { const saved = JSON.parse(localStorage.getItem(`pertama:query:${pipeline.id}`) || 'null'); if (saved?.locationId === LOCATION_ID) queryTemplates[pipeline.id] = saved; } catch { /* Board visit required. */ }
    }
    if (!queryTemplates[pipeline.id]) queryTemplates[pipeline.id] = defaultPipelineQuery(pipeline);
    const body = JSON.parse(JSON.stringify(queryTemplates[pipeline.id]));
    body.locationId = LOCATION_ID;
    const ids = filterValues(body.filters, 'pipeline_id');
    if (ids.length !== 1 || ids[0] !== pipeline.id) throw new Error('Saved query belongs to a different pipeline.');
    body.filters = scopeLeadFilters(body.filters, currentUserId);
    if (sameStage) {
      function removeStageFilters(items) {
        return (items || []).flatMap(item => {
          if (item.filters) {
            const children = removeStageFilters(item.filters);
            return children.length ? [{ ...item, filters: children }] : [];
          }
          return item.field === 'pipeline_stage_id' ? [] : [item];
        });
      }
      body.filters = [...removeStageFilters(body.filters),
        { field: 'pipeline_stage_id', operator: 'eq', value: [pipeline.stages[stage]] }];
    }
    const group = body.aggregations.find(a => a.name === 'pipelines');
    group.options = { ...group.options, include: [pipeline.stages[stage]] };
    return opportunityFromResponse(await readList('/opportunities/search', body), pipeline, stage, excludedContact);
  }
  function taskContactFromResponse(data) {
    if (!Array.isArray(data.customObjectRecords)) throw new Error('Task list response is unreadable.');
    const task = data.customObjectRecords[0];
    if (!task) {
      if (data.total === 0) return null;
      throw new Error('Task list reports results but the first task is missing.');
    }
    if (task.locationId !== LOCATION_ID || ![false, 0].includes(task.properties?.completed)) throw new Error('Top task is not a pending task in this account.');
    const contacts = (task.relations || []).filter(r => r.associationId === 'TASK_CONTACT_ASSOCIATION' && r.objectKey === 'contact');
    if (contacts.length !== 1 || !contacts[0].recordId) throw new Error('The top task has no unique associated contact. No task was skipped or completed.');
    return { contactId: contacts[0].recordId };
  }
  async function findNextActionable() {
    if (settings.priority === 'stage') {
      const context = stageQueueContext();
      if (!context) throw new Error('Choose the original stage queue before navigating.');
      nextButton.textContent = `Checking ${context.pipeline.name} · ${context.stage}…`;
      const lead = await topPipelineLead(context.pipeline, context.stage, context.queue.contactId, true);
      syncStageQueue();
      if (stageQueue !== context.queue || contactId() !== context.queue.contactId) {
        throw new Error('Contact or stage queue changed during lookup. Navigation cancelled.');
      }
      return lead;
    }
    const pipelines = settings.pipelineIds.map(id => {
      const pipeline = NAV_PIPELINES.find(p => p.id === id);
      if (!pipeline) throw new Error('A selected pipeline is no longer available. Update Settings.');
      if (!pipeline.stages[settings.newLeadStage]) throw new Error(`${pipeline.name} has no ${settings.newLeadStage} stage. Update Settings.`);
      return pipeline;
    });
    const order = settings.priority === 'tasks' ? [null, ...pipelines] : [...pipelines, null];
    for (const pipeline of order) {
      if (pipeline) nextButton.textContent = `Checking ${pipeline.name}…`;
      const lead = pipeline ? await topPipelineLead(pipeline, settings.newLeadStage) : await topTaskContact();
      if (lead) return lead;
    }
    return null;
  }
  async function topTaskContact() {
    nextButton.textContent = 'Checking tasks…';
    const body = JSON.parse(JSON.stringify(queryTemplates.tasks));
    body.page = 1;
    const completedFilters = filterValues(body.filters, 'properties.completed');
    if (completedFilters.length !== 1 || completedFilters[0] !== 0) throw new Error('Saved task query is not restricted to pending tasks.');
    return taskContactFromResponse(await readList('/objects/task/records/search', body));
  }
  function openLead(lead) {
    if (!/^[a-zA-Z0-9_-]+$/.test(lead.contactId)) throw new Error('Invalid contact ID returned by lookup.');
    if (lead.opportunityId) pinStageQueue({ contactId: lead.contactId, opportunityId: lead.opportunityId,
      pipelineId: lead.pipelineId, stageId: lead.stageId });
    else {
      clearStageQueue();
      sessionStorage.removeItem(`pertama:origin:${lead.contactId}`);
    }
    location.assign(`/v2/location/${LOCATION_ID}/contacts/detail/${lead.contactId}`);
  }

  // One tab-local queue, bound to the contact being viewed. Never derive it from a stage save.
  const STAGE_QUEUE_KEY = `pertama:stage-queue:${LOCATION_ID}`;
  let stageQueue = null;
  let stageQueuePath = location.pathname;
  let stageRouteRevision = 0;
  const stageResults = new Map();
  let stageRevision = 0;
  let stageWritesPending = 0;
  try {
    const saved = JSON.parse(sessionStorage.getItem(STAGE_QUEUE_KEY) || 'null');
    if (saved?.contactId === contactId() && location.pathname.includes(`/location/${LOCATION_ID}/`)) stageQueue = saved;
    else sessionStorage.removeItem(STAGE_QUEUE_KEY);
  } catch { /* Without a readable queue, require explicit selection. */ }

  function clearStageQueue() {
    stageQueue = null;
    sessionStorage.removeItem(STAGE_QUEUE_KEY);
  }
  function syncStageQueue() {
    if (stageQueuePath === location.pathname) return;
    stageQueuePath = location.pathname;
    stageRouteRevision++;
    stageResults.clear();
    stageRevision++;
    if (stageQueue?.contactId !== contactId() || !location.pathname.includes(`/location/${LOCATION_ID}/`)) clearStageQueue();
  }
  // SPA route changes must invalidate immediately, including a quick away-and-back.
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function() {
      const result = original.apply(this, arguments);
      try { syncStageQueue(); } catch { /* Never prevent CRM navigation. */ }
      return result;
    };
  }
  window.addEventListener('popstate', () => { try { syncStageQueue(); } catch { /* Observer only. */ } });
  function stageQueueContext() {
    syncStageQueue();
    if (!stageQueue || stageQueue.contactId !== contactId() || !location.pathname.includes(`/location/${LOCATION_ID}/`)) return null;
    if (!['contactId', 'opportunityId', 'pipelineId', 'stageId'].every(key =>
      typeof stageQueue[key] === 'string' && /^[a-zA-Z0-9_-]+$/.test(stageQueue[key]))) return null;
    const pipeline = NAV_PIPELINES.find(p => p.id === stageQueue.pipelineId);
    const stage = pipeline && Object.keys(pipeline.stages).find(name => pipeline.stages[name] === stageQueue.stageId);
    return stage ? { queue: stageQueue, pipeline, stage } : null;
  }
  function pinStageQueue(queue) {
    syncStageQueue();
    if (!queue || !['contactId', 'opportunityId', 'pipelineId', 'stageId'].every(key =>
      typeof queue[key] === 'string' && /^[a-zA-Z0-9_-]+$/.test(queue[key]))) throw new Error('Invalid stage queue IDs.');
    const pipeline = NAV_PIPELINES.find(p => p.id === queue.pipelineId);
    if (!pipeline || !Object.values(pipeline.stages).includes(queue.stageId)) throw new Error('Stage queue is no longer available. Reopen the pipeline board.');
    sessionStorage.setItem(`pertama:origin:${queue.contactId}`, JSON.stringify({
      pipeline: pipeline.name, pipelineId: pipeline.id, opportunityId: queue.opportunityId,
    }));
    sessionStorage.setItem(STAGE_QUEUE_KEY, JSON.stringify(queue));
    stageQueue = queue;
  }
  function stageQueueLabel() {
    const context = stageQueueContext();
    return context ? `Next from: ${context.pipeline.name} · ${context.stage}` : 'Choose the original stage queue';
  }
  function nextLeadLabel() {
    return settings.priority === 'stage' ? `Next lead — ${stageQueueLabel()}` : 'Next lead';
  }
  function emptyQueueMessage() {
    if (settings.priority !== 'stage') return 'No leads or pending tasks match your selected queues and saved filters.';
    const context = stageQueueContext();
    return context ? `No other matching leads in ${context.pipeline.name} · ${context.stage}.`
      : 'The original stage queue is unavailable. Reopen the pipeline board.';
  }
  function observeStageRequest(method, url) {
    syncStageQueue();
    const parsed = new URL(url, location.href);
    if (parsed.origin !== 'https://services.leadconnectorhq.com') return null;
    const path = parsed.pathname.replace(/\/$/, '');
    if (['PUT', 'PATCH', 'DELETE'].includes(method) && /^\/opportunities\/[^/]+$/.test(path)
      || method === 'POST' && path === '/opportunities') {
      stageResults.clear(); stageRevision++; stageWritesPending++;
      return { write: true, finished: false };
    }
    return method === 'POST' && path === '/opportunities/search' && opportunitiesPage() && !stageWritesPending
      ? stageRevision : null;
  }
  function finishStageWrite(observation) {
    if (!observation?.write || observation.finished) return;
    observation.finished = true;
    stageWritesPending--;
    stageResults.clear(); stageRevision++;
  }
  function rememberStageResults(data, revision) {
    syncStageQueue();
    if (typeof revision !== 'number' || revision !== stageRevision || stageWritesPending || !opportunitiesPage()) return;
    for (const bucket of data?.aggregations?.pipelines?.buckets || []) {
      for (const hit of bucket.topOpportunities?.hits?.hits || []) {
        const lead = hit._source;
        if (lead?.locationId !== LOCATION_ID || !hit._id || !lead.contactId || bucket.key !== lead.pipelineStageId) continue;
        stageResults.set(hit._id, { contactId: lead.contactId, opportunityId: hit._id,
          pipelineId: lead.pipelineId, stageId: lead.pipelineStageId });
      }
    }
  }

  // Observe session headers, list results and save receipts; leave CRM requests unchanged.
  let receiptBatch = null;
  function beginReceipts() {
    receiptBatch = [];
    return receiptBatch;
  }
  function jsonValue(value) {
    try { return typeof value === 'string' ? JSON.parse(value) : value; }
    catch { return null; }
  }
  function observeRequest(method, url, body) {
    if (!receiptBatch) return null;
    const parsed = new URL(url, location.href);
    const path = parsed.pathname.replace(/\/$/, '');
    if (parsed.hostname !== 'services.leadconnectorhq.com'
      || !(method === 'PUT' && /^\/opportunities\/[^/]+$/.test(path)
        || method === 'POST' && ['/notes', '/objects/task/records', '/associations/relations/bulk'].includes(path))) return null;
    const receipt = { method, path, request: null, requestReady: false, status: null, response: null, finished: false };
    receiptBatch.push(receipt);
    Promise.resolve().then(body).then(value => { receipt.request = jsonValue(value); receipt.requestReady = true; }, () => { receipt.requestReady = true; });
    return receipt;
  }
  function finishReceipt(receipt, status, body) {
    if (!receipt) return;
    receipt.status = status;
    receipt.response = jsonValue(body);
    receipt.finished = true;
  }
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    let receipt, stageObservation = null;
    try {
      const request = input instanceof Request ? input : null;
      stageObservation = observeStageRequest((init?.method || request?.method || 'GET').toUpperCase(), request?.url || String(input));
      captureReadHeaders(request?.url || String(input), init?.headers || request?.headers);
      captureQuery((init?.method || request?.method || 'GET').toUpperCase(), request?.url || String(input),
        () => init?.body ?? (request ? request.clone().text() : null));
      receipt = observeRequest((init?.method || request?.method || 'GET').toUpperCase(), request?.url || String(input),
        () => init?.body ?? (request ? request.clone().text() : null));
    } catch { /* Observing must never prevent the CRM request. */ }
    const result = originalFetch.apply(this, arguments);
    if (stageObservation?.write) result.then(() => finishStageWrite(stageObservation), () => finishStageWrite(stageObservation));
    else if (typeof stageObservation === 'number') {
      result.then(response => response.ok ? response.clone().json().then(data => rememberStageResults(data, stageObservation)) : null).catch(() => {});
    }
    if (pipelineListRequest(input instanceof Request ? input.url : String(input))) {
      result.then(response => response.ok ? response.clone().json().then(rememberPipelines) : null).catch(() => {});
    }
    if (receipt) result.then(response => {
      response.clone().text().then(body => finishReceipt(receipt, response.status, body),
        () => finishReceipt(receipt, response.status, null));
    }, () => finishReceipt(receipt, 0, null)).catch(() => finishReceipt(receipt, 0, null));
    return result;
  };
  const xhrInfo = new WeakMap();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    const info = xhrInfo.get(this);
    if (info && ['token-id', 'authorization', 'version', 'channel', 'source', 'developer_version'].includes(String(name).toLowerCase())) {
      info.headers[name] = value;
    }
    return originalSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.open = function(method, url) {
    xhrInfo.set(this, { method: String(method).toUpperCase(), url: String(url), headers: {} });
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    try {
      const info = xhrInfo.get(this);
      if (info) { captureReadHeaders(info.url, info.headers); captureQuery(info.method, info.url, () => body); }
      const stageObservation = info ? observeStageRequest(info.method, info.url) : null;
      if (stageObservation !== null) this.addEventListener('loadend', () => {
        if (stageObservation.write) finishStageWrite(stageObservation);
        else try {
          if (this.status >= 200 && this.status < 300) rememberStageResults(this.responseType === 'json' ? this.response : JSON.parse(this.responseText), stageObservation);
        } catch { /* Unreadable board results must not establish a queue. */ }
      }, { once: true });
      if (info && pipelineListRequest(info.url)) this.addEventListener('loadend', () => {
        try { if (this.status >= 200 && this.status < 300) rememberPipelines(this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch { /* Keep previous catalog. */ }
      }, { once: true });
      const receipt = info && observeRequest(info.method, info.url, () => body);
      if (receipt) this.addEventListener('loadend', () => {
        try { finishReceipt(receipt, this.status, this.responseType === 'json' ? this.response : this.responseText); }
        catch { finishReceipt(receipt, this.status, null); }
      }, { once: true });
    } catch { /* Leave the CRM request unchanged. */ }
    return originalSend.apply(this, arguments);
  };

  async function savedResponse(batch, description, matches, verify) {
    const receipt = await wait(() => {
      const found = batch.find(matches);
      return found?.finished && found.requestReady ? found : null;
    }, `server confirmation: ${description}`, () => batch.length
      ? batch.map(r => `${r.method} ${r.path}: ${r.finished ? `HTTP ${r.status}` : 'response pending'}`).join('; ')
      : 'No matching save requests were observed. Refresh once after installing this version so observation starts before the CRM loads.', 30000);
    if (receipt.status < 200 || receipt.status >= 300) {
      throw new Error(`${description}: server returned HTTP ${receipt.status}. Save not confirmed.`);
    }
    if (!receipt.response) throw new Error(`${description}: server response was not readable JSON. Save not confirmed.`);
    verify(receipt.response, receipt.request);
    return receipt.response;
  }
  function requireSaved(condition, message) {
    if (!condition) throw new Error(`Server confirmation mismatch: ${message}`);
  }
  function plainNote(html) {
    return new DOMParser().parseFromString(html || '', 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
  }
  function verifyStage(data, sent, opportunityId, id, originalPipelineId) {
    const saved = data.opportunity;
    requireSaved(saved?.id === opportunityId && saved.contactId === id && Boolean(originalPipelineId) && saved.pipelineId === originalPipelineId
      && (!sent?.pipelineId || sent.pipelineId === originalPipelineId),
      'opportunity/contact/pipeline did not match the current action.');
    requireSaved(Boolean(sent?.pipelineStageId) && saved.pipelineStageId === sent.pipelineStageId,
      `stage sent ${sent?.pipelineStageId}; returned ${saved?.pipelineStageId}.`);
  }
  function verifyNote(data, sent, id, expectedNote) {
    const saved = data.note;
    requireSaved(Boolean(saved?.id) && saved.locationId === LOCATION_ID && saved.contactId === id,
      'saved note ID/contact/location did not match.');
    requireSaved(plainNote(sent?.body) === expectedNote.replace(/\s+/g, ' ').trim() && (saved.bodyText || plainNote(saved.body)).replace(/\s+/g, ' ').trim() === expectedNote.replace(/\s+/g, ' ').trim(),
      'saved note text did not match the intended note.');
  }
  function verifyTask(data, sent, id, title, due) {
    const saved = data.record;
    const expectedTime = Date.parse(`${due}T11:00:00+08:00`);
    requireSaved(!data.errors?.length && Boolean(saved?.id) && saved.objectKey === 'task'
      && saved.locationId === LOCATION_ID && sent?.properties?.contactId === id,
      'task creation returned errors or the wrong task/contact/location.');
    requireSaved(saved.properties?.title === title && sent.properties.title === title,
      'saved task title did not match.');
    requireSaved(Date.parse(saved.properties?.dueDate) === expectedTime
      && Date.parse(sent.properties.dueDate) === expectedTime,
      `expected task deadline ${due}, 11am WITA; returned ${saved.properties?.dueDate}.`);
    requireSaved([false, 0].includes(saved.properties?.completed), 'new task was not pending.');
    requireSaved(sent.owners?.length === 1 && saved.owners?.length === 1 && saved.owners[0] === sent.owners[0],
      'saved task owner did not match the submitted owner.');
  }
  function verifyTaskLink(data, taskId, id) {
    requireSaved(!data.results?.errored?.length && data.results?.added?.some(item => item.success === true
      && item.data?.associationId === 'TASK_CONTACT_ASSOCIATION'
      && item.data.firstRecordId === taskId && item.data.secondRecordId === id),
      'task was created but its contact association was not confirmed.');
  }

  // Small DOM helpers. Selectors come from the recordings and inspected CRM UI.
  const visible = el => el && el.getClientRects().length > 0;
  const all = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
  const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const exact = (selector, label, root = document) => all(selector, root).find(el => text(el) === label);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let busy = false;
  let guardedContact = null;
  let guardedStageQueue = null;
  let step = '';
  let completed = [];
  let pendingSave = '';
  let startingContact = '';

  function contactId() {
    return location.pathname.match(/\/(?:contacts|customers)\/detail\/([^/]+)/)?.[1];
  }

  async function wait(find, description, observed = () => '', timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (guardedContact && contactId() !== guardedContact) {
        throw new Error(`Contact changed while waiting for ${description}. Expected ID: ${guardedContact}; current ID: ${contactId() || '(not on a contact page)'}.`);
      }
      if (guardedStageQueue && stageQueueContext()?.queue !== guardedStageQueue) {
        throw new Error(`Original stage queue changed while waiting for ${description}. Execution stopped.`);
      }
      const result = find();
      if (result) return result;
      await sleep(150);
    }
    const detail = observed();
    throw new Error(`Timed out after ${timeout / 1000}s waiting for: ${description}.${detail ? `\nObserved: ${detail}` : ''}`);
  }

  function controlState(selector, root = document) {
    const matches = [...root.querySelectorAll(selector)];
    return `${selector}: ${matches.length} found, ${matches.filter(visible).length} visible, ${matches.filter(el => visible(el) && !el.disabled).length} visible and enabled`;
  }

  function checkpointKey(id) {
    return `pertama:no-answer:unfinished:${LOCATION_ID}:${id}`;
  }

  function clearContactCheckpoint(id) {
    if (busy || contactId() !== id || !location.pathname.includes(`/location/${LOCATION_ID}/`)) {
      throw new Error('Contact changed or another action is running. Nothing cleared.');
    }
    const key = checkpointKey(id);
    const original = localStorage.getItem(key);
    if (!original) return false;
    let saved;
    try { saved = JSON.parse(original); } catch { throw new Error('Checkpoint is unreadable. Nothing cleared.'); }
    const report = [
      `Clear unfinished action for contact ${id}?`,
      `Recorded: ${saved.time || 'Unknown'}`,
      '', 'Completed steps:',
      Array.isArray(saved.completed) ? saved.completed.join('\n') || 'None confirmed.' : 'None recorded.',
      '', `Unverified save: ${saved.pendingSave || 'None recorded.'}`,
      '', 'Confirm you have checked the CRM record. Saved changes will not be undone. This only removes the retry block; it does not retry anything.',
    ].join('\n');
    if (!confirm(report)) return false;
    if (busy || contactId() !== id || localStorage.getItem(key) !== original) {
      throw new Error('Contact or checkpoint changed. Nothing cleared.');
    }
    localStorage.removeItem(key);
    return true;
  }

  function saveCheckpoint() {
    localStorage.setItem(checkpointKey(startingContact), JSON.stringify({
      completed, pendingSave, time: new Date().toISOString(),
    }));
  }

  async function click(selector, saveDescription = '') {
    const el = await wait(() => all(selector).find(el => !el.disabled), `enabled control ${selector}`, () => controlState(selector));
    el.scrollIntoView({ block: 'nearest' });
    if (saveDescription) {
      pendingSave = saveDescription;
      saveCheckpoint(); // Persist before clicking; failure must block the save.
    }
    el.click();
  }

  async function clickLabel(label, root = document) {
    const el = await wait(() => exact('button', label, root), `visible button with exact text "${label}"`,
      () => `Visible button labels: ${all('button', root).map(text).filter(Boolean).join(' | ').slice(0, 500) || '(none)'}`);
    if (el.disabled) throw new Error(`The "${label}" button is disabled.`);
    el.click();
  }

  function fill(input, value) {
    input.focus();
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  }

  function futureDate(days) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Makassar', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date()).map(p => [p.type, p.value]));
    return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day + days)).toISOString().slice(0, 10);
  }

  async function openSidebar(icon) {
    // Sidebar buttons toggle: clicking an already open panel would hide it.
    const view = { 'sidebar-tasks-icon': 'tasks', 'sidebar-notes-icon': 'notes', 'sidebar-opportunities-icon': 'opportunities' }[icon];
    if (view && new URL(location.href).searchParams.get('view') === view) return;
    if (icon === 'sidebar-opportunities-icon' && all('.opportunities-pane-list').length) return;
    if (icon === 'sidebar-notes-icon' && visible(document.getElementById('add-note-button'))) return;
    if (icon === 'sidebar-tasks-icon' && (visible(document.getElementById('tasks-list-container-contact'))
      || visible(document.getElementById('tasks-form-container')) || exact('button', 'Add task'))) return;
    const el = await wait(() => all(`[id="${icon}"]`)[0], `sidebar icon #${icon}`, () => controlState(`[id="${icon}"]`));
    const button = el.closest('button');
    if (!button) throw new Error(`Sidebar icon #${icon} exists, but has no enclosing button. The sidebar selector needs updating.`);
    if (button.disabled) throw new Error(`Sidebar button containing #${icon} is disabled.`);
    button.click();
  }

  function progress(message) {
    step = message;
    runButton.textContent = message;
  }

  function nameInput(field, label) {
    const root = document.getElementById('record-details-lhs') || document;
    const byId = document.getElementById(`contact.${field}`);
    if (visible(byId) && 'value' in byId) return byId;
    const input = all('input', root).find(el => el.id === field || el.name === field || el.name === `contact.${field}`);
    if (input) return input;
    const heading = exact('label', label, root);
    if (heading?.htmlFor) {
      const target = document.getElementById(heading.htmlFor);
      if (visible(target) && 'value' in target) return target;
    }
    return heading?.parentElement?.querySelector('input') || null;
  }
  async function readContactName() {
    const selector = '#record-details-tabs div.hr-tabs-rail > div:nth-of-type(2) span';
    (await wait(() => exact(selector, 'All fields'), 'All fields tab', () => controlState(selector))).click();
    const first = await wait(() => nameInput('first_name', 'First name'), 'First name input in All fields');
    const last = await wait(() => nameInput('last_name', 'Last name'), 'Last name input in All fields');
    const firstName = first.value.trim();
    const name = [firstName, last.value.trim()].filter(Boolean).join(' ');
    if (!name) throw new Error('Contact name is empty.');
    return { firstName, name };
  }

  function selectedPipeline(root = document) {
    const values = all('input', root).map(el => el.value.trim());
    const labels = all('button, [role="combobox"], span, div, p', root)
      .filter(el => !el.closest('[role="option"], [role="listbox"], [role="menu"], .hr-base-select-option'));
    values.push(...labels.map(text));
    const matches = NAV_PIPELINES.map(p => p.name).filter(name => values.includes(name));
    return matches.length === 1 ? matches[0] : null;
  }

  function opportunitiesPage() {
    return location.pathname.replace(/\/$/, '') === `/v2/location/${LOCATION_ID}/opportunities`;
  }

  function rememberBoardContact(event) {
    if (!opportunitiesPage() || !(event.target instanceof Element)) return;
    const link = event.target.closest('.card a');
    if (!link) return;
    const url = new URL(link.href, location.href);
    const id = url.pathname.match(/\/(?:contacts|customers)\/detail\/([^/]+)/)?.[1];
    const pipeline = selectedPipeline();
    const opportunityId = link.closest('.card')?.id;
    if (!id || !pipeline || !opportunityId) return;
    try {
      syncStageQueue();
      clearStageQueue();
      sessionStorage.setItem(`pertama:origin:${id}`, JSON.stringify({ pipeline, opportunityId }));
      const snapshot = stageResults.get(opportunityId);
      if (snapshot?.contactId === id && NAV_PIPELINES.some(p => p.id === snapshot.pipelineId && p.name === pipeline)) pinStageQueue(snapshot);
    } catch { /* Without a remembered origin, only an unambiguous opportunity is allowed. */ }
  }

  function readOrigin(id) {
    try { return JSON.parse(sessionStorage.getItem(`pertama:origin:${id}`) || 'null'); }
    catch { return null; }
  }

  async function ensureStageQueue() {
    const id = contactId();
    if (!id || !location.pathname.includes(`/location/${LOCATION_ID}/`)) throw new Error('Open a contact in the Pertama account to choose a stage queue.');
    const existing = stageQueueContext();
    if (existing) return existing;
    const routeRevision = stageRouteRevision;
    await openSidebar('sidebar-opportunities-icon');
    const links = await wait(() => {
      const found = all('a[href*="/opportunities/"][href*="pipelineId="]');
      return found.length ? found : null;
    }, 'contact opportunities for stage queue selection');
    if (contactId() !== id || stageRouteRevision !== routeRevision) throw new Error('Contact changed before stage queue selection.');
    const choices = new Map();
    for (const link of links) {
      const url = new URL(link.href, location.href);
      const opportunityId = url.pathname.match(/\/opportunities\/([^/]+)\/?$/)?.[1];
      const pipeline = NAV_PIPELINES.find(p => p.id === url.searchParams.get('pipelineId'));
      if (opportunityId && pipeline) choices.set(opportunityId, pipeline);
    }
    if (!choices.size) throw new Error('Pipeline metadata is unavailable. Open the Opportunities board first.');
    const selected = await new Promise(resolve => {
      const previousFocus = document.activeElement;
      const dialog = document.createElement('dialog');
      dialog.id = 'pertama-stage-queue';
      dialog.setAttribute('aria-labelledby', 'pertama-stage-queue-title');
      dialog.style.cssText = 'width:min(500px,calc(100vw - 32px));max-height:85vh;overflow:auto;border:1px solid #e4e7ec;border-radius:14px;padding:24px;font:14px/1.5 sans-serif;color:#182230;background:#fff';
      dialog.innerHTML = `<style>
        #pertama-stage-queue::backdrop{background:#10182866}
        #pertama-stage-queue label{display:block;margin:16px 0}
        #pertama-stage-queue select{display:block;width:100%;margin-top:6px;padding:8px;font:inherit}
        #pertama-stage-queue button{padding:8px 12px;margin-right:8px;font:inherit;cursor:pointer}
        </style><form><h2 id="pertama-stage-queue-title">Choose the original stage queue</h2>
        <p>The stage when you opened this lead was not captured. Choose the pipeline opportunity and original stage to work through—even if you have already moved this lead.</p>
        <label>Opportunity<select name="opportunity" required></select></label>
        <label>Original stage<select name="stage" required></select></label>
        <button type="button" data-cancel>Cancel</button><button type="submit">Use this queue</button></form>`;
      const form = dialog.querySelector('form');
      const opportunity = form.elements.namedItem('opportunity');
      const stage = form.elements.namedItem('stage');
      opportunity.add(new Option('Select an opportunity…', ''));
      for (const [opportunityId, pipeline] of choices) opportunity.add(new Option(`${pipeline.name} · ${opportunityId}`, opportunityId));
      const origin = readOrigin(id);
      opportunity.value = choices.has(origin?.opportunityId) ? origin.opportunityId : choices.size === 1 ? choices.keys().next().value : '';
      function updateStages() {
        stage.replaceChildren(new Option('Select the original stage…', ''));
        const pipeline = choices.get(opportunity.value);
        for (const [name, stageId] of Object.entries(pipeline?.stages || {})) stage.add(new Option(name, stageId));
      }
      opportunity.addEventListener('change', updateStages);
      updateStages();
      let closed = false;
      function finish(value) {
        if (closed) return;
        closed = true;
        dialog.close(); dialog.remove(); previousFocus?.focus(); resolve(value);
      }
      dialog.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      dialog.addEventListener('keydown', event => event.stopPropagation());
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const pipeline = choices.get(opportunity.value);
        if (!pipeline || !Object.values(pipeline.stages).includes(stage.value)) return;
        finish({ contactId: id, opportunityId: opportunity.value, pipelineId: pipeline.id, stageId: stage.value });
      });
      document.body.appendChild(dialog); dialog.showModal();
      dialog.querySelector('[data-cancel]').focus();
    });
    if (!selected) return null;
    if (contactId() !== id || stageRouteRevision !== routeRevision || !location.pathname.includes(`/location/${LOCATION_ID}/`)) throw new Error('Contact changed during stage queue selection. Nothing saved.');
    pinStageQueue(selected);
    return stageQueueContext();
  }

  async function nextLead() {
    if (busy) return;
    busy = true;
    nextButton.disabled = true;
    try {
      if (!location.pathname.includes(`/location/${LOCATION_ID}/`)) throw new Error('Open the Pertama account first.');
      if (settings.priority === 'stage' && !await ensureStageQueue()) return;
      const lead = await findNextActionable();
      if (lead) openLead(lead);
      else taskNotice(emptyQueueMessage());
    } catch (error) {
      console.error('[Pertama Next lead v0.2.9]', error);
      taskNotice(`Next lead stopped: ${error.message} No records were changed.`, true);
    } finally {
      busy = false;
      nextButton.disabled = false;
      nextButton.textContent = nextLeadLabel();
    }
  }

  function pendingCallTask(card, expectedTitle) {
    // Select the title beside the completion button, not description/due text.
    const title = card.querySelector(':scope > div:first-child > div > p');
    const button = card.querySelector('button[id="completed-action"]');
    return title && text(title) === expectedTitle
      && !title.classList.contains('line-through')
      && button && !button.disabled
      && button.querySelector('svg.text-gray-500') ? { card, title, button } : null;
  }

  function callStartButton(event) {
    if (!event.isTrusted || !(event.target instanceof Element)) return null;
    const button = event.target.closest('button[id="hr-button-v-1"]');
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return null;
    const label = button.querySelector('[id="hr-button-v-1-label"]');
    return label && /^Call:/.test(text(label.querySelector('.sr-only')))
      && exact('p', 'Call', label) ? button : null;
  }

  function taskNotice(message, failed = false) {
    let notice = document.getElementById('pertama-task-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'pertama-task-notice';
      notice.setAttribute('role', 'status');
      notice.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;max-width:420px;padding:14px;background:white;color:#182230;border:1px solid #98a2b3;border-radius:8px;box-shadow:0 2px 8px #0002;font:14px sans-serif;white-space:pre-wrap;cursor:pointer';
      notice.addEventListener('click', () => notice.remove());
      document.body.appendChild(notice);
    }
    notice.textContent = message + (failed ? '\nDetails are in the browser console. Click to dismiss.' : '');
    if (!failed) setTimeout(() => {
      if (notice.textContent === message) notice.remove();
    }, 7000);
  }

  async function completeCallTask(id) {
    if (busy) {
      console.info('Call-task completion skipped: another script action is running.');
      return;
    }
    busy = true;
    guardedContact = id;
    let attempted = false;
    let title = '';
    try {
      if (contactId() !== id) throw new Error('Contact changed before task lookup.');
      await openSidebar('sidebar-notes-icon');
      const { name, firstName } = await readContactName();
      const expectedTitle = renderTemplate(settings.task, { name, firstName }).replace(/\s+/g, ' ').trim();

      if (!visible(document.getElementById('tasks-list-container-contact'))) {
        await openSidebar('sidebar-tasks-icon');
      }
      await wait(() => visible(document.getElementById('tasks-list-container-contact'))
        || exact('button', 'Add task'), 'contact task list or empty task view');
      const cards = all('#tasks-list-container-contact .tasks-card-container-style');
      const task = cards.map(card => pendingCallTask(card, expectedTitle)).find(Boolean);
      if (!task) return;
      title = text(task.title);
      if (contactId() !== id) throw new Error('Contact changed before task completion.');
      attempted = true;
      task.button.click();
      await wait(() => {
        const current = all('#tasks-list-container-contact .tasks-card-container-style');
        return current.some(card => {
          const label = card.querySelector(':scope > div:first-child > div > p');
          return text(label) === title && label.classList.contains('line-through');
        }) || (!task.card.isConnected && !current.some(card =>
          text(card.querySelector(':scope > div:first-child > div > p')) === title)
          && (visible(document.getElementById('tasks-list-container-contact')) || exact('button', 'Add task')));
      }, `task "${title}" marked complete or removed from the pending list`);
      taskNotice(`Completed: ${title}`);
    } catch (error) {
      const report = `Pertama call task — v0.2.9\nContact ID: ${id}\n${error.message}\n${attempted
        ? `Completion clicked for "${title}", but not verified. Inspect it before retrying.`
        : 'Task completion was not clicked.'}\nNo automatic retry.`;
      console.error(report, error);
    } finally {
      if (contactId() === id) {
        try { await openSidebar('sidebar-notes-icon'); }
        catch (error) { console.error('Could not leave Notes open after the call.', error); }
      }
      guardedContact = null;
      busy = false;
    }
  }

  function smsContext() {
    const root = document.getElementById('composer-textarea');
    if (!visible(root)) throw new Error('Open the SMS composer to enable sending.');
    const channel = root.querySelector('#conv-channel-bar-provider-trigger');
    if (text(channel) !== 'SMS') throw new Error('Select SMS in the composer to enable sending.');
    if (root.querySelector('#conv-channel-bar-internal-comment-toggle')?.getAttribute('aria-pressed') !== 'false') {
      throw new Error('Turn off Internal Comment to enable SMS.');
    }
    const from = text(root.querySelector('#contact-select-trigger'));
    const toLabel = exact('span', 'To:', root);
    const to = text(toLabel?.parentElement).replace(/^To:\s*/, '');
    const validPhone = value => /^\+[\d ()-]{7,24}$/.test(value);
    if (!validPhone(from) || !validPhone(to)) throw new Error('SMS From or To number could not be read.');
    const input = root.querySelector('#conv-composer-textarea-input');
    const send = root.querySelector('#conv-send-button-simple');
    if (!visible(input) || !visible(send)) throw new Error('SMS message field or Send button is unavailable.');
    return { from, to, draft: input.value, input, send };
  }

  async function prepareSms() {
    try {
      const expanded = () => visible(document.getElementById('composer-textarea'));
      // Wait for either state: the contact composer can mount after the rest of the page.
      const target = await wait(() => expanded() ? { expanded: true } :
        all('#conv-composer-inline-expand-trigger')[0] || all('[id^="composer-input-"]')[0],
        'message composer or expansion trigger', () => controlState('#conv-composer-inline-expand-trigger'));
      if (!target.expanded) {
        target.click();
        await wait(expanded, 'expanded message composer', () => controlState('#composer-textarea'));
      }
      await wait(() => {
        const root = document.getElementById('composer-textarea');
        return visible(root?.querySelector('#conv-channel-bar-provider-trigger'))
          && visible(root?.querySelector('#conv-composer-textarea-input'))
          && visible(root?.querySelector('#conv-send-button-simple'));
      }, 'message composer controls', () => controlState('#conv-composer-textarea-input'));
      return smsContext();
    } catch (error) {
      return { error: error.message };
    }
  }

  async function sendSmsOnce(approved, message) {
    const current = smsContext();
    if (contactId() !== startingContact || current.to !== approved.to || current.from !== approved.from) {
      throw new Error('SMS contact or From/To number changed after confirmation. Send was not clicked.');
    }
    if (current.draft !== approved.draft) throw new Error('The SMS draft changed after confirmation. Send was not clicked.');
    if (!message.trim()) throw new Error('SMS message is empty. Send was not clicked.');
    fill(current.input, message); // Input/change events only; never an Enter key.
    await wait(() => document.getElementById('conv-composer-textarea-input')?.value === message,
      'SMS composer containing the approved message');
    const ready = smsContext();
    if (contactId() !== startingContact || ready.to !== approved.to || ready.from !== approved.from
      || ready.input.value !== message || ready.send.getAttribute('aria-disabled') === 'true'
      || ready.send.hasAttribute('disabled')) throw new Error('SMS composer changed or Send is disabled. Send was not clicked.');
    // The misleading aria-label is not used as a readiness check.
    pendingSave = `SMS Send clicked for ${approved.to}; acceptance/delivery not yet verified`;
    saveCheckpoint();
    ready.send.click(); // Exactly one attempt, never an automatic retry.
    await wait(() => document.getElementById('conv-composer-textarea-input')?.value === '',
      'SMS composer to clear after the single Send click',
      () => 'The SMS may already have been sent. Inspect the conversation before retrying.');
    completed.push(`SMS Send clicked; composer cleared (${approved.to}). Delivery not verified.`);
    const notice = `SMS submitted to ${approved.to}.`;
    taskNotice(notice);
    // Carry the status across the next contact's page load.
    try {
      const savedNotice = JSON.stringify({ message: notice, time: Date.now() });
      sessionStorage.setItem(SMS_NOTICE_KEY, savedNotice);
      setTimeout(() => {
        if (sessionStorage.getItem(SMS_NOTICE_KEY) === savedNotice) sessionStorage.removeItem(SMS_NOTICE_KEY);
      }, 7000);
    } catch { /* A notification failure must not turn a send into a retry. */ }
    pendingSave = '';
    saveCheckpoint();
  }

  function confirmActions({ name, firstName, phone, stage, rule, due, owner, taskTitle, sms, pipelineName, stageOptions }) {
    return new Promise(resolve => {
      const previousFocus = document.activeElement;
      const dialog = document.createElement('dialog');
      dialog.id = 'pertama-confirm-actions';
      dialog.setAttribute('aria-labelledby', 'pertama-confirm-title');
      dialog.innerHTML = `
        <style>
          #pertama-confirm-actions{box-sizing:border-box;width:min(510px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto;margin:auto;padding:0;border:1px solid #e4e7ec;border-radius:16px;background:#fff;color:#182230;box-shadow:0 24px 60px #10182830;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
          #pertama-confirm-actions::backdrop{background:#10182866}
          #pertama-confirm-actions *{box-sizing:border-box}
          #pertama-confirm-actions form{margin:0}
          #pertama-confirm-actions header{padding:16px 18px 10px}
          #pertama-confirm-actions h2{font-size:21px;font-weight:600;line-height:1.3;margin:0 0 6px}
          #pertama-confirm-actions p{margin:0;color:#667085}
          #pertama-confirm-actions .actions{padding:0 18px}
          #pertama-confirm-actions section{border-top:1px solid #eaecf0;padding:10px 0}
          #pertama-confirm-actions label.toggle{display:flex;justify-content:space-between;align-items:center;gap:16px;font-weight:600;cursor:pointer}
          #pertama-confirm-actions .switch{position:relative;flex:none;width:38px;height:22px}
          #pertama-confirm-actions .switch input{position:absolute;inset:0;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
          #pertama-confirm-actions .track{display:block;width:38px;height:22px;border-radius:12px;background:#d0d5dd;pointer-events:none}
          #pertama-confirm-actions .track:after{content:"";display:block;position:relative;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:white;box-shadow:0 1px 3px #10182833;transition:transform .15s}
          #pertama-confirm-actions input:checked+.track{background:#155eef}
          #pertama-confirm-actions input:checked+.track:after{transform:translateX(16px)}
          #pertama-confirm-actions input:focus-visible+.track{outline:3px solid #84adff;outline-offset:3px}
          #pertama-confirm-actions input:disabled+.track{opacity:.45}
          #pertama-confirm-actions .detail{margin-top:4px;font-size:13px;color:#667085;white-space:pre-line}
          #pertama-confirm-actions input[type=number]{width:90px;margin:6px 8px 0 0;padding:8px 10px;border:1px solid #d0d5dd;border-radius:8px;font:inherit;color:inherit}
          #pertama-confirm-actions select{display:block;width:100%;margin-top:6px;padding:8px 10px;border:1px solid #d0d5dd;border-radius:8px;font:inherit;color:inherit;background:#fff}
          #pertama-confirm-actions select:disabled{background:#f9fafb;color:#98a2b3}
          #pertama-confirm-actions textarea{display:block;width:100%;resize:vertical;min-height:54px;margin-top:6px;padding:8px 10px;border:1px solid #d0d5dd;border-radius:8px;font:inherit;color:inherit;background:#fff}
          #pertama-confirm-actions textarea:focus{outline:2px solid #84adff;border-color:#155eef}
          #pertama-confirm-actions textarea:disabled{background:#f9fafb;color:#98a2b3}
          #pertama-confirm-actions [hidden]{display:none!important}
          #pertama-confirm-actions footer{padding:12px 18px;background:#f9fafb;border-top:1px solid #eaecf0}
          #pertama-confirm-actions .buttons{display:flex;justify-content:flex-end;gap:10px;margin-top:10px}
          #pertama-confirm-actions button{padding:9px 16px;border:1px solid #d0d5dd;border-radius:8px;background:white;color:#344054;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer}
          #pertama-confirm-actions button[type=submit]{background:#155eef;border-color:#155eef;color:white}
        </style>
        <form>
          <header><h2 id="pertama-confirm-title">Save and next</h2><p data-contact></p></header>
          <div class="actions">
            <section><label class="toggle">Update stage<span class="switch"><input name="stage" type="checkbox" role="switch" checked><span class="track"></span></span></label><p class="detail" data-stage></p><select name="targetStage" aria-label="Stage to update to"></select></section>
            <section><label class="toggle">Add note<span class="switch"><input name="note" type="checkbox" role="switch" checked><span class="track"></span></span></label><textarea name="noteText" aria-label="Note text" rows="2"></textarea></section>
            <section><label class="toggle">Add task<span class="switch"><input name="task" type="checkbox" role="switch"><span class="track"></span></span></label><label class="detail" data-task-days>Follow up in <input name="taskDays" type="number" min="0" step="1" aria-label="Follow up in days">days</label><p class="detail" data-task></p></section>
            <section><label class="toggle">Send SMS<span class="switch"><input name="sms" type="checkbox" role="switch"><span class="track"></span></span></label><p class="detail" data-recipient></p><p class="detail" data-sms-status></p><textarea name="smsText" aria-label="SMS message" placeholder="Write your message…" rows="3" disabled hidden></textarea></section>
          </div>
          <footer><p class="detail" data-next></p><div class="buttons"><button type="button" data-cancel>Cancel</button><button type="submit">Confirm &amp; next</button></div></footer>
        </form>`;
      const form = dialog.querySelector('form');
      const field = name => form.elements.namedItem(name);
      dialog.querySelector('[data-contact]').textContent = `${name} · ${pipelineName}`;
      dialog.querySelector('[data-stage]').textContent = `Current stage: ${stage}`;
      field('stage').checked = rule.updateStage !== false && stageOptions.includes(rule.next);
      for (const name of stageOptions) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        field('targetStage').appendChild(option);
      }
      const missingStage = document.createElement('option');
      missingStage.value = ''; missingStage.textContent = 'Select a stage…';
      field('targetStage').appendChild(missingStage);
      field('targetStage').value = stageOptions.includes(rule.next) ? rule.next : '';
      if (!stageOptions.includes(rule.next)) dialog.querySelector('[data-stage]').textContent += ` · Suggested stage ${rule.next} is unavailable; choose a destination to update.`;
      field('taskDays').value = due ? String(rule.days) : '';
      dialog.querySelector('[data-task-days]').hidden = !due;
      function taskDate() {
        const raw = field('taskDays').value.trim();
        const days = Number(raw);
        if (!raw || !Number.isSafeInteger(days) || days < 0) return null;
        try {
          const date = futureDate(days);
          return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
        } catch { return null; }
      }
      function updateTaskDate() {
        field('taskDays').setCustomValidity('');
        const date = due ? taskDate() : null;
        dialog.querySelector('[data-task]').textContent = !due
          ? 'No follow-up task at the Robot stage.'
          : date ? `${taskTitle}\n${date} at 11am WITA · ${owner}` : 'Enter a whole number of days, 0 or greater.';
      }
      field('taskDays').addEventListener('input', updateTaskDate);
      dialog.querySelector('[data-recipient]').textContent = sms.error
        ? `Recipient: ${name}${phone ? ` · ${phone}` : ''}` : `To: ${name} · ${sms.to}\nFrom: ${sms.from}`;
      dialog.querySelector('[data-sms-status]').textContent = sms.error || 'Off by default. Turning this on sends the message once when you confirm. Delivery is not verified.';
      field('sms').checked = false;
      field('sms').disabled = Boolean(sms.error);
      field('smsText').value = renderTemplate(settings.sms, { firstName, name });
      dialog.querySelector('[data-next]').textContent = settings.priority === 'stage'
        ? `After saving — ${stageQueueLabel()}. No other queues or tasks will be used.`
        : 'After saving: open the next lead using your selected pipelines and lead priority.';
      field('noteText').value = renderTemplate(settings.note, { firstName, name });
      field('task').checked = Boolean(due);
      field('task').disabled = !due;
      function updateFields() {
        field('targetStage').disabled = !field('stage').checked;
        field('taskDays').disabled = !field('task').checked || !due;
        field('taskDays').required = field('task').checked && Boolean(due);
        updateTaskDate();
        field('noteText').disabled = !field('note').checked;
        field('noteText').required = field('note').checked;
        field('smsText').hidden = !field('sms').checked;
        field('smsText').disabled = !field('sms').checked;
        field('smsText').required = field('sms').checked;
      }
      let closed = false;
      function finish(result) {
        if (closed) return;
        closed = true;
        dialog.close();
        dialog.remove();
        previousFocus?.focus();
        resolve(result);
      }
      form.addEventListener('change', updateFields);
      dialog.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      form.addEventListener('submit', event => {
        event.preventDefault();
        const selectedDue = field('task').checked && due ? taskDate() : null;
        field('taskDays').setCustomValidity(field('task').checked && due && !selectedDue
          ? 'Enter a whole number of days, 0 or greater, within the supported date range.' : '');
        const targetStage = field('targetStage').value;
        field('targetStage').setCustomValidity(field('stage').checked && !stageOptions.includes(targetStage) ? 'Choose an available stage.' : '');
        const noteText = field('noteText').value.trim();
        const smsText = field('smsText').value.trim();
        field('smsText').setCustomValidity(field('sms').checked && !smsText ? 'Enter a message or turn Send SMS off.' : '');
        field('noteText').setCustomValidity(field('note').checked && !noteText ? 'Enter a note or turn Add note off.' : '');
        if (!form.reportValidity()) return;
        finish({ stage: field('stage').checked, targetStage, note: field('note').checked,
          task: field('task').checked && Boolean(due), due: selectedDue, noteText,
          sms: field('sms').checked && !field('sms').disabled, smsText });
      });
      field('targetStage').addEventListener('change', () => field('targetStage').setCustomValidity(''));
      field('noteText').addEventListener('input', () => field('noteText').setCustomValidity(''));
      field('smsText').addEventListener('input', () => field('smsText').setCustomValidity(''));
      dialog.addEventListener('keydown', event => event.stopPropagation());
      updateFields();
      document.body.appendChild(dialog);
      dialog.showModal();
      dialog.querySelector('[data-cancel]').focus();
    });
  }

  // One procedural sequence. Nothing runs until the user presses the button.
  async function run() {
    if (busy) return;
    busy = true;
    runButton.disabled = true;
    completed = [];
    pendingSave = '';
    step = 'Checking contact page';
    guardedContact = contactId();
    startingContact = guardedContact || '(none)';
    try {
      if (!guardedContact || !location.pathname.includes(`/location/${LOCATION_ID}/`)) {
        throw new Error(`Expected a contact detail page in location ${LOCATION_ID}. Current path: ${location.pathname}`);
      }
      const previous = localStorage.getItem(checkpointKey(startingContact));
      if (previous) {
        const saved = JSON.parse(previous);
        completed = saved.completed || [];
        pendingSave = saved.pendingSave || '';
        throw new Error(`Repeat run blocked: an unfinished no-answer action exists from ${saved.time}. Stage/note/task changes may already be saved. Reconcile that action before starting another; refreshing does not clear this block.`);
      }
      if (settings.pipelineIds?.length || settings.priority === 'stage') {
        progress('Checking navigation identity…');
        await requireVerifiedUser();
      }
      if (settings.priority === 'stage') {
        progress('Checking stage queue…');
        const context = await ensureStageQueue();
        if (!context) return;
        // Refresh the action origin from the queue, including after a page reload.
        pinStageQueue(context.queue);
        guardedStageQueue = context.queue;
      }
      progress('Reading contact…');
      const { name, firstName } = await readContactName();
      const owner = await wait(() => {
        const box = document.getElementById('owner-dropdown-trigger');
        return [...(box?.querySelectorAll('*') || [])].filter(el => !el.children.length)
          .map(text).filter(t => t.length > 2).sort((a, b) => b.length - a.length)[0];
      }, 'contact owner in #owner-dropdown-trigger');
      const phone = nameInput('phone', 'Phone')?.value?.trim() || '';
      const sms = await prepareSms();
      progress('Reading opportunity…');
      await openSidebar('sidebar-opportunities-icon');
      const origin = readOrigin(startingContact);
      const selector = 'a[href*="/opportunities/"][href*="pipelineId="]';
      await wait(() => all(selector).length, 'linked opportunities', () =>
        `View: ${new URL(location.href).searchParams.get('view') || '(none)'}; ${controlState('.opportunities-pane-list')}; ${controlState(selector)}`);
      const links = all(selector);
      const linkId = link => new URL(link.href).pathname.match(/\/opportunities\/([^/]+)\/?$/)?.[1];
      const link = origin ? links.find(item => linkId(item) === origin.opportunityId) : links.length === 1 ? links[0] : null;
      if (!link) throw new Error('Original opportunity is not unique. Open the contact from its pipeline board. Nothing saved.');
      const opportunityId = linkId(link);
      const originalPipelineId = new URL(link.href).searchParams.get('pipelineId');
      const pipeline = NAV_PIPELINES.find(p => p.id === originalPipelineId);
      if (!opportunityId || !pipeline || origin && (origin.pipelineId ? origin.pipelineId !== pipeline.id : origin.pipeline !== pipeline.name)) throw new Error('Original opportunity/pipeline could not be verified. Nothing saved.');
      const pipelineName = pipeline.name;
      link.click();
      const stageControl = await wait(() => all('#OpportunityStage')[0], 'opportunity stage #OpportunityStage');
      const modalPipeline = selectedPipeline(stageControl.closest('#modal, [role="dialog"]') || stageControl.parentElement);
      if (modalPipeline && modalPipeline !== pipelineName) throw new Error('Opportunity form pipeline differs from the original pipeline. Nothing saved.');
      const stage = text(stageControl.querySelector('.hr-base-selection-input__content'));
      const rule = Object.hasOwn(settings.rules, stage) ? settings.rules[stage] : null;
      if (!rule) throw new Error(`Unsupported stage: "${stage}". Nothing saved.`);
      // Read the actual pipeline's stage names so the dropdown includes all CRM stages.
      await click('#OpportunityStage .hr-base-selection-label');
      const stageOptions = await wait(() => {
        const names = [...new Set(all('.hr-base-select-option p').map(text).filter(Boolean))];
        return names.length ? names : null;
      }, `available stages including ${rule.next}`);
      // Selecting the existing stage closes the CRM dropdown without saving anything.
      (await wait(() => exact('.hr-base-select-option p', stage), `current stage option ${stage}`)).click();
      let due = rule.days === null ? null : futureDate(rule.days);
      const taskTitle = renderTemplate(settings.task, { name, firstName });
      const choices = await confirmActions({ name, firstName: firstName || name, phone, stage, rule, due, owner, taskTitle, sms, pipelineName, stageOptions });
      if (!choices) {
        if (visible(document.getElementById('modal-header-modal-close-btn'))) await click('#modal-header-modal-close-btn');
        return;
      }
      if (contactId() !== startingContact) throw new Error('Contact changed during confirmation. Nothing saved.');
      due = choices.due;
      if (choices.stage) {
        if (!stageOptions.includes(choices.targetStage)) throw new Error('Selected stage is not available in this pipeline. Nothing saved.');
        progress('Saving stage…');
        await click('#OpportunityStage .hr-base-selection-label');
        (await wait(() => exact('.hr-base-select-option p', choices.targetStage), `stage option ${choices.targetStage}`)).click();
        await wait(() => text(stageControl.querySelector('.hr-base-selection-input__content')) === choices.targetStage, `selected stage ${choices.targetStage}`);
        const batch = beginReceipts();
        await click('#CreateUpdateOpportunity', `Stage: ${stage} → ${choices.targetStage}`);
        await savedResponse(batch, `stage ${choices.targetStage}`, r => r.method === 'PUT' && r.path === `/opportunities/${opportunityId}`,
          (data, sent) => verifyStage(data, sent, opportunityId, startingContact, originalPipelineId));
        completed.push(`Stage: ${choices.targetStage} (server confirmed; opportunity ${opportunityId})`);
        pendingSave = '';
        saveCheckpoint();
      }
      if (visible(document.getElementById('modal-header-modal-close-btn'))) await click('#modal-header-modal-close-btn');
      if (choices.note) {
        progress('Saving note…');
        await openSidebar('sidebar-notes-icon');
        await click('#add-note-button');
        const editor = await wait(() => all('#common-rich-text-editor [contenteditable="true"]')[0], 'note editor');
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        if (!document.execCommand('insertText', false, choices.noteText)) throw new Error('Note insertion failed. Save not clicked.');
        const batch = beginReceipts();
        await click('#notes-form-save-btn', `Note: ${choices.noteText}`);
        const saved = await savedResponse(batch, 'note creation', r => r.method === 'POST' && r.path === '/notes'
          && r.request?.relations?.some(rel => rel.objectKey === 'contact' && rel.recordId === startingContact),
          (data, sent) => verifyNote(data, sent, startingContact, choices.noteText));
        completed.push(`Note saved (server confirmed; note ${saved.note.id})`);
        pendingSave = '';
        saveCheckpoint();
      }
      if (choices.task && due) {
        progress('Creating follow-up…');
        await openSidebar('sidebar-tasks-icon');
        await wait(() => all('input').some(el => el.placeholder === 'Search by title'), 'task list');
        if (exact('button', 'Add task')) await clickLabel('Add task');
        else await clickLabel('Add');
        const form = await wait(() => document.getElementById('tasks-form-container'), 'task form');
        await wait(() => form.innerText.includes(owner), `task owner ${owner}`);
        fill(await wait(() => form.querySelector('#add-task-title input, input[placeholder="Enter"]'), 'task title input'), taskTitle);
        const time = await wait(() => all('div.hr-time-picker input', form).find(el => !el.disabled), 'task time input');
        time.scrollIntoView({ block: 'nearest' });
        time.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        time.focus();
        time.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
        time.click();
        await wait(() => all('div.hours-column > div').length, 'time dropdown');
        (await wait(() => exact('div.hours-column > div:nth-of-type(11)', '11'), 'hour option 11')).click();
        await click('#task-due-date-time-form-item > label');
        await wait(() => /^11:00$/.test(time.value), 'time 11:00');
        if (!all('.hr-base-selection-input', form).some(el => text(el) === 'AM')) throw new Error('Task time is not AM. Save not clicked.');
        const date = await wait(() => form.querySelector('input[aria-label="Select Date"], .hr-datepicker__trigger-wrapper input'), 'task date input');
        fill(date, due);
        date.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        const batch = beginReceipts();
        await click('#tasks-form-save-btn', `Task: ${taskTitle}; ${due}, 11am WITA; owner ${owner}`);
        const saved = await savedResponse(batch, 'follow-up task creation', r => r.method === 'POST' && r.path === '/objects/task/records'
          && r.request?.properties?.contactId === startingContact,
          (data, sent) => verifyTask(data, sent, startingContact, taskTitle, due));
        const taskId = saved.record.id;
        completed.push(`Task created: ${taskId}; ${due}, 11am WITA (server confirmed)`);
        pendingSave = `Contact association for task ${taskId}`;
        saveCheckpoint();
        await savedResponse(batch, 'task linked to contact', r => r.method === 'POST' && r.path === '/associations/relations/bulk'
          && r.request?.add?.some(rel => rel.firstRecordId === taskId && rel.secondRecordId === startingContact),
          data => verifyTaskLink(data, taskId, startingContact));
        completed.push('Task contact association: server confirmed');
        pendingSave = '';
        saveCheckpoint();
      }

      if (choices.sms) {
        progress('Sending SMS…');
        await sendSmsOnce(sms, choices.smsText);
      }

      receiptBatch = null;
      localStorage.removeItem(checkpointKey(startingContact));
      progress('Opening next lead…');
      guardedContact = null; // Navigation is allowed only after the saves succeeded.
      guardedStageQueue = null;
      const next = await findNextActionable();
      if (next) openLead(next);
      else taskNotice(`Selected actions saved. ${emptyQueueMessage()}`);

    } catch (error) {
      const report = [
        'Pertama No answer — v0.2.9', `Stopped: ${step}`,
        `Contact ID: ${startingContact}`, `Current path: ${location.pathname}`,
        '', error.message || String(error), '',
        'Completed actions (verification noted below):', completed.join('\n') || 'None confirmed.',
        '', pendingSave ? `Save attempted; result not fully verified:\n${pendingSave}\nThis may already be saved. Inspect the record to avoid duplicates.`
          : 'No save is awaiting verification. Unsaved form edits may remain.',
        '', 'Execution stopped. No automatic retry. Check the record before running again.',
        'The same report and technical error are in the browser console.',
      ].join('\n');
      console.error(report, error);
      alert(report);
    } finally {
      guardedContact = null;
      guardedStageQueue = null;
      busy = false;
      receiptBatch = null;
      runButton.disabled = false;
      runButton.textContent = 'Save and next';
      nextButton.textContent = nextLeadLabel();
    }
  }

  function openSettings() {
    if (busy || document.getElementById('pertama-settings')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'pertama-settings';
    dialog.setAttribute('aria-label', 'Workflow settings');
    dialog.style.cssText = 'width:min(680px,calc(100vw - 32px));max-height:85vh;overflow:auto;border:1px solid #e4e7ec;border-radius:14px;padding:24px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#182230;background:#fff;box-shadow:0 24px 60px #10182830';
    dialog.innerHTML = `<style>
      #pertama-settings::backdrop{background:#10182866}
      #pertama-settings *{box-sizing:border-box}
      #pertama-settings form{margin:0}
      #pertama-settings h2{margin:0 0 8px;font-size:22px;font-weight:600;line-height:1.3;color:#182230}
      #pertama-settings h3{margin:24px 0 8px;padding-top:18px;border-top:1px solid #eaecf0;font-size:16px;font-weight:600;line-height:1.4;color:#182230}
      #pertama-settings p{margin:8px 0 14px;color:#667085;font-size:13px;line-height:1.5}
      #pertama-settings label{display:block;margin:14px 0;color:#344054;font-size:13px;font-weight:500}
      #pertama-settings input:not([type=checkbox]),#pertama-settings textarea,#pertama-settings select{display:block;width:100%;margin-top:5px;padding:9px 11px;border:1px solid #d0d5dd;border-radius:7px;background:#fff;color:#182230;font-family:inherit;font-size:14px;line-height:1.5;box-shadow:0 1px 2px #10182805}
      #pertama-settings textarea{resize:vertical}
      #pertama-settings input[type=checkbox]{accent-color:#155eef;margin-right:6px;vertical-align:middle}
      #pertama-settings input:focus-visible,#pertama-settings textarea:focus-visible,#pertama-settings select:focus-visible,#pertama-settings button:focus-visible{outline:2px solid #84adff;outline-offset:2px}
      #pertama-settings button{padding:8px 12px;margin:0;border:1px solid #d0d5dd;border-radius:7px;background:#fff;color:#344054;font-size:13px;font-weight:500;line-height:1.3;font-family:inherit;cursor:pointer}
      #pertama-settings button:hover{background:#f2f4f7}
      #pertama-settings button[type=submit]{background:#155eef;border-color:#155eef;color:#fff}
      #pertama-settings button[type=submit]:hover{background:#004eeb}
      #pertama-settings .pipeline-row{display:flex;align-items:center;gap:6px;padding:9px 0;border-bottom:1px solid #f2f4f7}
      #pertama-settings .pipeline-row label{flex:1;margin:0;min-width:0}
      #pertama-settings .rule-row{border:1px solid #eaecf0;border-radius:9px;background:#f9fafb;padding:14px;margin:10px 0;display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}
      #pertama-settings .rule-row label{margin:0}
      #pertama-settings .rule-row button{justify-self:start;color:#b42318}
      #pertama-settings .settings-footer{position:sticky;bottom:-24px;display:flex;justify-content:flex-end;gap:10px;background:#fff;border-top:1px solid #eaecf0;margin:20px -24px -24px;padding:16px 24px;border-radius:0 0 14px 14px}
      @media(max-width:520px){#pertama-settings .rule-row{grid-template-columns:1fr}}
      </style>
      <form><h2>Workflow settings</h2><p data-user></p><p>Templates support {firstName} and {fullName}. Settings are saved in this browser for this CRM account.</p>
      <label>Default note<textarea name="note" rows="2" required></textarea></label>
      <label>Task title template<input name="task" required></label>
      <label>Default SMS<textarea name="sms" rows="4" required></textarea></label>
      <p>Call-task completion matches the current task title template exactly. Tasks created with an older template will need manual completion.</p>
      <label>Lead priority<select name="priority"><option value="leads">New leads first</option><option value="tasks">Follow-ups first</option><option value="stage">Same stage only</option></select></label>
      <p>Same stage only stays in the original pipeline and stage, even after moving the current lead. It skips the current contact and never falls back to tasks. Open a lead from its board to capture the queue; if it was not captured, you will be asked to choose it. The queue survives refreshes in this tab. Pipeline selections and the new-lead stage below apply to the other two modes.</p>
      <label>New lead stage name<input name="newLeadStage" required></label>
      <h3>Pipelines</h3><p>Select your pipelines and use Up/Down to set their order. New installations start with none selected. Lead searches use the verified signed-in user (assigned to you or followed by you). Pipeline selection controls new-lead queues; follow-ups use your saved task-list filters. Open the Opportunities board and reopen Settings to refresh the available pipelines. Visiting a pipeline board captures your filters; otherwise lead searches use the default order.</p><div data-pipelines></div>
      <h3>Shared stage defaults</h3><p>These rules apply to every pipeline. Leave follow-up days blank for no task. Task deadlines remain 11am WITA.</p><div data-rules></div><button type="button" data-add-rule>Add stage rule</button>
      <section data-checkpoint hidden><h3>Unfinished action</h3><p>Check this contact’s CRM record before removing its retry block.</p><button type="button" data-clear-checkpoint>Clear unfinished action</button></section><p data-error role="alert" style="color:#b42318"></p><div class="settings-footer"><button type="button" data-cancel>Cancel</button><button type="submit">Save settings</button></div></form>`;
    const form = dialog.querySelector('form');
    const settingsContact = contactId();
    const checkpointSection = dialog.querySelector('[data-checkpoint]');
    if (settingsContact && location.pathname.includes(`/location/${LOCATION_ID}/`)
      && localStorage.getItem(checkpointKey(settingsContact))) checkpointSection.hidden = false;
    dialog.querySelector('[data-clear-checkpoint]').addEventListener('click', () => {
      try {
        if (clearContactCheckpoint(settingsContact)) {
          checkpointSection.hidden = true;
          dialog.querySelector('[data-error]').textContent = '';
          taskNotice('Unfinished-action checkpoint cleared for this contact. No CRM records were changed.');
        }
      } catch (error) { dialog.querySelector('[data-error]').textContent = error.message; }
    });
    dialog.querySelector('[data-user]').textContent = currentUserId && identityExpires > Date.now() / 1000
      ? `CRM user: ${currentUserId} · identified from current CRM authentication`
      : 'CRM user: awaiting verification. Waiting for the CRM to load authenticated data.';
    for (const key of ['note', 'task', 'sms', 'priority', 'newLeadStage']) form.elements.namedItem(key).value = settings[key];
    const pipelineRoot = dialog.querySelector('[data-pipelines]');
    const orderedIds = [...settings.pipelineIds, ...NAV_PIPELINES.map(p => p.id).filter(id => !settings.pipelineIds.includes(id))];
    for (const id of orderedIds) {
      const pipeline = NAV_PIPELINES.find(p => p.id === id);
      const row = document.createElement('div'); row.className = 'pipeline-row'; row.dataset.pipelineId = id;
      const label = document.createElement('label');
      const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = settings.pipelineIds.includes(id);
      label.appendChild(toggle); label.appendChild(document.createTextNode(` ${pipeline?.name || 'Unavailable pipeline'}${pipeline ? '' : ' — disable to remove'}`)); row.appendChild(label);
      for (const direction of ['Up', 'Down']) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = direction;
        button.addEventListener('click', () => {
          if (direction === 'Up' && row.previousElementSibling) pipelineRoot.insertBefore(row, row.previousElementSibling);
          if (direction === 'Down' && row.nextElementSibling) pipelineRoot.insertBefore(row.nextElementSibling, row);
        }); row.appendChild(button);
      }
      pipelineRoot.appendChild(row);
    }
    const ruleRoot = dialog.querySelector('[data-rules]');
    function addRule(stage = '', rule = { next: '', days: 2, updateStage: false }) {
      const row = document.createElement('div'); row.className = 'rule-row';
      row.innerHTML = '<label>Current stage<input data-stage required></label><label>Suggested next stage<input data-next required></label><label>Follow-up days<input data-days type="number" min="0" max="36500" step="1"></label><label><input data-update type="checkbox"> Update stage by default</label><button type="button">Remove rule</button>';
      row.querySelector('[data-stage]').value = stage; row.querySelector('[data-next]').value = rule.next;
      row.querySelector('[data-days]').value = rule.days === null ? '' : String(rule.days);
      row.querySelector('[data-update]').checked = rule.updateStage !== false;
      row.querySelector('button').addEventListener('click', () => row.remove()); ruleRoot.appendChild(row);
    }
    for (const [stage, rule] of Object.entries(settings.rules)) addRule(stage, rule);
    dialog.querySelector('[data-add-rule]').addEventListener('click', () => addRule());
    const close = () => { dialog.close(); dialog.remove(); };
    dialog.querySelector('[data-cancel]').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    form.addEventListener('submit', event => {
      event.preventDefault();
      try {
        const next = { rules: Object.create(null), pipelineIds: [...pipelineRoot.children].filter(row => row.querySelector('input').checked).map(row => row.dataset.pipelineId) };
        for (const key of ['note', 'task', 'sms', 'priority', 'newLeadStage']) next[key] = form.elements.namedItem(key).value.trim();
        for (const row of ruleRoot.children) {
          const stage = row.querySelector('[data-stage]').value.trim(), rawDays = row.querySelector('[data-days]').value.trim();
          if (Object.hasOwn(next.rules, stage)) throw new Error(`Duplicate stage rule: ${stage}`);
          next.rules[stage] = { next: row.querySelector('[data-next]').value.trim(), days: rawDays === '' ? null : Number(rawDays), updateStage: row.querySelector('[data-update]').checked };
        }
        validateSettings(next);
        for (const id of next.priority === 'stage' ? [] : next.pipelineIds) {
          const pipeline = NAV_PIPELINES.find(p => p.id === id);
          if (!pipeline || !pipeline.stages[next.newLeadStage]) throw new Error(`${pipeline?.name || 'Unavailable pipeline'} has no ${next.newLeadStage} stage. Disable it or change the stage name.`);
        }
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); settings = next; close();
        nextButton.textContent = nextLeadLabel(); taskNotice('Workflow settings saved.');
      } catch (error) { dialog.querySelector('[data-error]').textContent = error.message; }
    });
    document.body.appendChild(dialog); dialog.showModal();
  }

  let runButton, nextButton;
  function initializeButtons() {
  if (document.getElementById('pertama-no-answer-button')) return;
  try {
    const savedNotice = JSON.parse(sessionStorage.getItem(SMS_NOTICE_KEY) || 'null');
    sessionStorage.removeItem(SMS_NOTICE_KEY);
    if (savedNotice && Date.now() - savedNotice.time < 30000) taskNotice(savedNotice.message);
  } catch { /* Optional status only. */ }
  document.addEventListener('click', rememberBoardContact, true);
  // Observe only the user's actual Call click; never initiate or block a call.
  document.addEventListener('click', event => {
    if (!callStartButton(event) || !contactId()
      || !location.pathname.includes(`/location/${LOCATION_ID}/`)) return;
    const id = contactId();
    setTimeout(() => completeCallTask(id), 0);
  }, true);
  runButton = document.createElement('button');
  runButton.id = 'pertama-no-answer-button';
  runButton.textContent = 'Save and next';
  runButton.style.cssText = 'align-self:center;flex-shrink:0;margin-left:16px;padding:10px 16px;background:#155eef;color:white;border:0;border-radius:6px;font:14px sans-serif;white-space:nowrap;cursor:pointer';
  runButton.addEventListener('click', run);
  nextButton = document.createElement('button');
  nextButton.id = 'pertama-next-lead-button';
  nextButton.textContent = 'Next lead';
  nextButton.hidden = true;
  nextButton.title = 'Open the next lead using your Settings.';
  nextButton.style.cssText = 'display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:calc(100% - 20px);min-height:46px;margin:12px 10px;padding:10px 8px;background:#155eef;color:white;border:1px solid #528bff;border-radius:8px;font:600 15px/1.25 sans-serif;white-space:normal;cursor:pointer;flex-shrink:0';
  nextButton.addEventListener('click', nextLead);
  const settingsButton = document.createElement('button');
  settingsButton.id = 'pertama-settings-button';
  settingsButton.textContent = 'Workflow settings';
  settingsButton.style.cssText = 'display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:calc(100% - 20px);min-height:42px;margin:10px;padding:10px 8px;background:#155eef;color:white;border:1px solid #528bff;border-radius:8px;font:600 14px/1.25 sans-serif;white-space:normal;cursor:pointer;flex-shrink:0';
  settingsButton.addEventListener('click', openSettings);
  // Keep the button immediately after Companies, including after SPA navigation.
  function placeButton() {
    syncStageQueue();
    if (!busy) nextButton.textContent = nextLeadLabel();
    const companies = document.getElementById('tb_business');
    runButton.hidden = !contactId() || !visible(companies);
    if (!runButton.hidden && companies.nextElementSibling !== runButton) {
      companies.insertAdjacentElement('afterend', runButton);
    }
    const messageHub = all('a, button').find(el => /^message hub$/i.test(text(el)));
    const settings = all('a, button').find(el => /^settings$/i.test(text(el)));
    const inAccount = location.pathname.includes(`/location/${LOCATION_ID}/`);
    nextButton.hidden = !inAccount || !(messageHub || settings);
    nextButton.style.display = nextButton.hidden ? 'none' : 'flex';
    settingsButton.hidden = !inAccount || !settings;
    settingsButton.style.display = settingsButton.hidden ? 'none' : 'flex';
    if (!settingsButton.hidden && settings.previousElementSibling !== settingsButton) settings.insertAdjacentElement('beforebegin', settingsButton);
    if (!nextButton.hidden) {
      if (messageHub && messageHub.nextElementSibling !== nextButton) messageHub.insertAdjacentElement('afterend', nextButton);
      else if (!messageHub && settingsButton.previousElementSibling !== nextButton) settingsButton.insertAdjacentElement('beforebegin', nextButton);
      const width = (messageHub || settings).getBoundingClientRect().width;
      nextButton.style.fontSize = width < 100 ? '11px' : '15px';
      settingsButton.style.fontSize = width < 100 ? '11px' : '14px';
    }
  }
  placeButton();
  setInterval(placeButton, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeButtons, { once: true });
  else initializeButtons();
})();

