// ==UserScript==
// @name         Pertama — No answer
// @namespace    pertama-local
// @version      1.0.19
// @description  No-answer workflow and a Next lead button for the Opportunities dashboard.
// @updateURL    https://raw.githubusercontent.com/gkarolyi/gohigherlevel/main/gohigherlevel.user.js
// @downloadURL  https://raw.githubusercontent.com/gkarolyi/gohigherlevel/main/gohigherlevel.user.js
// @match        https://go.pertamaproperty.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  // Reading map: settings/catalog and queue lookup; CRM session/read observers;
  // approved writes and checkpoints; Save-and-next/Call/SMS workflows; button placement.
  // Save and next: run -> readActionContext -> confirmActions -> selected API saves
  // -> findNextActionable -> openLead. Uncertain writes leave a checkpoint, never retry.
  if (window.__pertamaNoAnswerInstalled) return;
  window.__pertamaNoAnswerInstalled = true;

  // Account boundary; workflow defaults below remain editable in Settings.
  const VERSION = '1.0.19';
  const LOCATION_ID = '3QixdLNutDXye95tTBK0';
  const SMS_NOTICE_KEY = `pertama:sms-notice:${LOCATION_ID}`;
  const NAV_PIPELINES = [];
  let refreshButtons = () => {};
  let hideStageIndicator = () => {};
  let hideQueueSummary = () => {};
  let queueSaveRevision = 0;
  const SETTINGS_KEY = `pertama:settings:${LOCATION_ID}`;
  const CATALOG_KEY = `pertama:pipelines:${LOCATION_ID}`;
  const SETTINGS_DEFAULTS = {
    note: 'No answer. Will contact again.', task: 'Call again {fullName}',
    smsTemplates: [{ id: 'default', name: 'Default', message: 'Hi {firstName}, following up on your property enquiry. Please let me know a convenient time to speak. Thanks!' }],
    smsFrom: '', priority: 'leads', newLeadStage: 'New Lead', pipelineIds: [],
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
    for (const key of ['note', 'task', 'newLeadStage']) {
      if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`${key} cannot be blank.`);
    }
    for (const key of ['note', 'task']) {
      if (/\{(?!firstName\}|fullName\})[^{}]*\}/.test(value[key])) throw new Error('Use only {firstName} and {fullName} placeholders.');
    }
    const smsTemplates = value.smsTemplates === undefined
      ? [{ id: 'default', name: 'Default', message: value.sms }] : value.smsTemplates;
    const templateIds = new Set(), templateNames = new Set();
    if (!Array.isArray(smsTemplates) || !smsTemplates.length) throw new Error('At least the Default SMS template is required.');
    for (const template of smsTemplates) {
      if (!template || typeof template.id !== 'string' || !template.id.trim() || templateIds.has(template.id)
        || typeof template.name !== 'string' || !template.name.trim() || templateNames.has(template.name.trim().toLowerCase())
        || typeof template.message !== 'string' || !template.message.trim()
        || /\{(?!firstName\}|fullName\})[^{}]*\}/.test(template.message)) {
        throw new Error('SMS templates need unique names and IDs, a message, and only {firstName} or {fullName} placeholders.');
      }
      templateIds.add(template.id); templateNames.add(template.name.trim().toLowerCase());
    }
    if (!smsTemplates.some(template => template.id === 'default' && template.name === 'Default')) throw new Error('The Default SMS template is required.');
    if (!value.rules || typeof value.rules !== 'object' || Array.isArray(value.rules)) throw new Error('Invalid shared stage rules.');
    for (const [stage, rule] of Object.entries(value.rules)) {
      if (!stage.trim() || !rule || typeof rule.next !== 'string' || !rule.next.trim()
        || typeof rule.updateStage !== 'boolean'
        || rule.smsTemplateId !== undefined && typeof rule.smsTemplateId !== 'string'
        || ['addNote', 'addTask', 'sendSms'].some(key => Object.hasOwn(rule, key) && typeof rule[key] !== 'boolean')
        || rule.days !== null && (!Number.isInteger(rule.days) || rule.days < 0 || rule.days > 36500)) {
        throw new Error('Each stage rule needs a destination and whole follow-up days from 0 to 36500, or blank days for 3 hours later.');
      }
    }
    if (value.smsFrom != null && value.smsFrom !== '' && (typeof value.smsFrom !== 'string' || !/^\+[1-9]\d{6,14}$/.test(value.smsFrom))) {
      throw new Error('Invalid SMS sender number.');
    }
    const { sms: legacySms, ...normalized } = value;
    return { ...normalized, smsTemplates, smsFrom: value.smsFrom || '' };
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
    refreshButtons();
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
  window.pertamaUserDiagnostics = () => ({ version: VERSION, status: identityStatus,
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
    const previousUser = currentUserId;
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
    if (previousUser !== currentUserId) { cancelLeadAccessReport(); closeLeadAccessReport(); invalidateOutgoingCallCounter(); invalidateContactReads(); }
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
  const persistedQueries = new Map();
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
  let readSessionRevision = 0;
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
      const unchanged = liveReadHeaders && ['token-id', 'authorization'].every(key => liveReadHeaders[key] === safe[key]);
      if (!unchanged) {
        liveReadHeaders = safe;
        readSessionRevision++;
        bindUserSession(safe); // Expiry is still checked whenever identity is required.
        hideQueueSummary(); refreshButtons();
      }
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
      const changed = JSON.stringify(queryTemplates[key]) !== JSON.stringify(body);
      queryTemplates[key] = body;
      if (changed) { hideQueueSummary(); refreshButtons(); }
      const serialized = JSON.stringify(body);
      if (persistedQueries.get(key) !== serialized) {
        try {
          localStorage.setItem(`pertama:query:${key}`, serialized);
          persistedQueries.set(key, serialized);
        } catch { /* Memory copy is enough; a later capture may retry persistence. */ }
      }
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
  const CRM_HEADERS = { accept: 'application/json, text/plain, */*',
    channel: 'APP', source: 'WEB_USER', version: '2021-07-28' };
  function wireRequest(method, path, body) {
    const headers = { ...CRM_HEADERS };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    if (method === 'POST' && !(path === '/opportunities/search' && body?.aggregations)) headers.developer_version = '';
    const wirePath = path === '/notes' || path === '/opportunities/search' && !body?.aggregations ? `${path}/` : path;
    return { url: `https://services.leadconnectorhq.com${wirePath}`, headers };
  }
  // Diagnostics contain request metadata only, never tokens or message bodies.
  const requestDiagnostics = [];
  window.pertamaRequestDiagnostics = requestDiagnostics;
  function recordRequest(diagnostic) {
    requestDiagnostics.push(diagnostic);
    if (requestDiagnostics.length > 30) requestDiagnostics.shift();
  }
  async function crmRequest(method, path, body, saveDescription = '') {
    const contactRead = method === 'GET' && /^\/contacts\/[a-zA-Z0-9_-]+$/.test(path) && body === undefined;
    const listRead = method === 'POST' && ['/opportunities/search', '/objects/task/records/search'].includes(path) && body?.locationId === LOCATION_ID;
    if ((!contactRead && !listRead) || saveDescription) throw new Error('Direct requests are restricted to read-only contact/lead/task lookups.');
    await wait(() => liveReadHeaders, 'live CRM session',
      () => 'No session headers observed. Reload the CRM once after installing this script.', 30000);
    const historyContext = leadAccessContext();
    const requestHeaders = liveReadHeaders;
    const wire = wireRequest(method, path, body);
    const diagnostic = { method, url: contactRead ? 'https://services.leadconnectorhq.com/contacts/{id}' : wire.url, started: new Date().toISOString(), status: null,
      result: 'pending', requestFields: Object.keys(body || {}) };
    recordRequest(diagnostic);
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await originalFetch.call(window, wire.url, {
        method, headers: { ...wire.headers, ...requestHeaders },
        redirect: 'error',
        ...(contactRead ? { cache: 'no-store' } : {}),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
      });
      diagnostic.status = response.status;
      if (!response.ok) {
        if ([401, 403].includes(response.status) && liveReadHeaders === requestHeaders) rejectCrmAuthorization();
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a JSON object response.');
      diagnostic.responseFields = Object.keys(data);
      if (data.error || data.errors?.length) throw new Error('Server returned an error in its response.');
      diagnostic.result = 'response received';
      if (path === '/objects/task/records/search') rememberLeadTasks(data, historyContext);
      return data;
    } catch (error) {
      diagnostic.result = error.name === 'AbortError' ? 'timeout' : diagnostic.status === null ? 'no HTTP response available' : 'response rejected';
      console.error('Pertama request failed', diagnostic);
      const detail = diagnostic.status === null && error.name !== 'AbortError'
        ? ' Browser supplied no HTTP response. Inspect Network/Console for a connection, CORS or redirect error; the cause cannot be determined here.' : '';
      throw new Error(`${method} ${new URL(diagnostic.url).pathname}: ${error.name === 'AbortError' ? 'Timed out after 30 seconds' : error.message}. Lookup failed.${detail} No automatic retry.`);
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
  function pipelineQueueQuery(pipeline, stage, sameStage = false) {
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
    return body;
  }
  async function topPipelineLead(pipeline, stage = 'New Lead', excludedContact = null, sameStage = false) {
    await requireVerifiedUser();
    return opportunityFromResponse(await readList('/opportunities/search', pipelineQueueQuery(pipeline, stage, sameStage)), pipeline, stage, excludedContact);
  }
  function taskContactFromResponse(data, dueBefore) {
    if (!Array.isArray(data.customObjectRecords)) throw new Error('Task list response is unreadable.');
    const task = data.customObjectRecords[0];
    if (!task) {
      if (data.total === 0) return null;
      throw new Error('Task list reports results but the first task is missing.');
    }
    if (task.locationId !== LOCATION_ID || ![false, 0].includes(task.properties?.completed)) throw new Error('Top task is not a pending task in this account.');
    const due = typeof task.properties.dueDate === 'string' ? Date.parse(task.properties.dueDate) : NaN;
    if (!Number.isFinite(due) || due > Date.parse(dueBefore)) throw new Error('Top task has no valid due date or is not due yet. No task was actioned.');
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
  function dueTaskQueueQuery(dueBefore) {
    const body = JSON.parse(JSON.stringify(queryTemplates.tasks));
    body.page = 1;
    const completedFilters = filterValues(body.filters, 'properties.completed');
    if (completedFilters.length !== 1 || completedFilters[0] !== 0) throw new Error('Saved task query is not restricted to pending tasks.');
    function removeDateFilters(filters) {
      return filters.flatMap(filter => {
        if (filter.field === 'properties.dueDate') return [];
        if (!filter.filters) return [filter];
        const children = removeDateFilters(filter.filters);
        return children.length || !filter.filters.length ? [{ ...filter, filters: children }] : [];
      });
    }
    // Captured date windows go stale. Preserve other filters, but always select due tasks as of this lookup.
    const remaining = removeDateFilters(body.filters);
    const filters = remaining.length === 1 && remaining[0].group === 'AND' ? remaining[0].filters : remaining;
    body.filters = [{ group: 'AND', filters: [...filters,
      { field: 'properties.dueDate', operator: 'range', value: { gte: '1901-01-01T00:00:00Z', lte: dueBefore } },
    ] }];
    return body;
  }
  async function topTaskContact() {
    nextButton.textContent = 'Checking tasks…';
    const dueBefore = new Date().toISOString();
    return taskContactFromResponse(await readList('/objects/task/records/search', dueTaskQueueQuery(dueBefore)), dueBefore);
  }
  function pipelineQueueCount(data, pipeline, stage) {
    const group = data?.aggregations?.pipelines;
    if (!Array.isArray(group?.buckets) || group.docCountErrorUpperBound !== 0 || group.sumOtherDocCount !== 0
      || group.buckets.length > 1 || group.buckets.some(bucket => !bucket || bucket.key !== pipeline.stages[stage]
        || !Number.isSafeInteger(bucket.docCount) || bucket.docCount < 0)) throw new Error('Queue counts are incomplete.');
    return group.buckets[0]?.docCount ?? 0;
  }
  function dueTaskQueueCount(data, dueBefore) {
    if (!Number.isSafeInteger(data?.total) || data.total < 0 || !Array.isArray(data.customObjectRecords)
      || data.customObjectRecords.length > data.total || data.total > 0 && !data.customObjectRecords.length) throw new Error('Task count is unreadable.');
    for (const task of data.customObjectRecords) taskContactFromResponse({ total: 1, customObjectRecords: [task] }, dueBefore);
    return data.total;
  }
  function contactRouter(path) {
    const routers = new Set();
    for (const root of document.querySelectorAll('[data-v-app]')) {
      const router = root.__vue_app__?.config?.globalProperties?.$router;
      if (typeof router?.push !== 'function' || typeof router?.resolve !== 'function') continue;
      try {
        const resolved = router.resolve(path);
        const url = new URL(resolved.href, location.href);
        if (resolved.name === 'contact_detail-v2' && url.origin === location.origin
          && url.pathname === path && !url.search && !url.hash) routers.add(router);
      } catch { /* This mounted app may not own contact routes. */ }
    }
    if (routers.size > 1) throw new Error('Multiple contact routers found. Navigation stopped.');
    return routers.values().next().value || null;
  }
  let retiringContactControls = [];
  function previousContactControlsGone() {
    retiringContactControls = retiringContactControls.filter(node => node.isConnected);
    return retiringContactControls.length === 0;
  }
  function requireContactControlsReady() {
    if (!previousContactControlsGone()) {
      throw new Error('Previous contact controls are still mounted. Wait for the contact to finish switching or reload before using workflow actions.');
    }
  }
  async function openLead(lead, onCommitted = null) {
    requireContactControlsReady();
    if (!/^[a-zA-Z0-9_-]+$/.test(lead.contactId)) throw new Error('Invalid contact ID returned by lookup.');
    if (lead.contactId === contactId()) throw new Error('This is the next top lead; action it first.');
    if (!location.pathname.includes(`/location/${LOCATION_ID}/`)) throw new Error('Open the Pertama account first.');
    const path = `/v2/location/${LOCATION_ID}/contacts/detail/${lead.contactId}`;
    const router = contactRouter(path);
    const sourcePath = location.pathname, sourceRevision = stageRouteRevision, previousQueue = stageQueue;
    const originKey = `pertama:origin:${lead.contactId}`;
    const previousOrigin = router ? sessionStorage.getItem(originKey) : null;
    if (lead.opportunityId) pinStageQueue({ contactId: lead.contactId, opportunityId: lead.opportunityId,
      pipelineId: lead.pipelineId, stageId: lead.stageId });
    else {
      clearStageQueue();
      sessionStorage.removeItem(`pertama:origin:${lead.contactId}`);
    }
    if (router) {
      // The live-tested native transition replaces name/owner controls. Track hidden
      // controls too: opening a retained task/SMS panel must not expose the old record.
      const details = document.getElementById('record-details-lhs') || document;
      retiringContactControls = [...new Set([
        nameInput('first_name', 'First name'), nameInput('last_name', 'Last name'), nameInput('phone', 'Phone'),
        ...details.querySelectorAll('input[id="contact.first_name"], input[id="contact.last_name"], input[id="contact.phone"], input[id="first_name"], input[id="last_name"], input[id="phone"], input[name="first_name"], input[name="last_name"], input[name="phone"], input[name="contact.first_name"], input[name="contact.last_name"], input[name="contact.phone"]'),
        ...document.querySelectorAll('#owner-dropdown-trigger, #tasks-list-container-contact, #conv-composer-textarea-input, #conv-send-button-simple'),
      ].filter(node => node?.isConnected))];
      const started = performance.now();
      let phase = 'Native route committed';
      try {
        // Native navigation stays in this document; a retained toolbar is not a readiness signal.
        try { sessionStorage.removeItem(NAVIGATION_TIMING_KEY); } catch { /* Optional timing only. */ }
        const failure = await router.push(path);
        const current = router.currentRoute?.value;
        const resolved = current && router.resolve(current.path);
        if (failure || location.pathname !== path || current?.name !== 'contact_detail-v2'
          || new URL(resolved.href, location.href).pathname !== path) {
          throw new Error('Native contact navigation was cancelled or redirected. No automatic retry.');
        }
        recordWorkflowTiming('Navigation', phase, performance.now() - started);
        onCommitted?.();
        phase = 'Previous contact controls released';
        const committedRevision = stageRouteRevision;
        await wait(() => {
          if (location.pathname !== path || stageRouteRevision !== committedRevision) {
            throw new Error('Contact changed while waiting for native navigation. No automatic retry.');
          }
          return previousContactControlsGone();
        }, 'previous contact controls to be replaced', () => 'Old controls remain mounted. Reload before using workflow actions.');
        recordWorkflowTiming('Navigation', phase, performance.now() - started);
        refreshButtons();
        return;
      } catch (error) {
        // A cancelled push must not replace the source queue; unrelated navigation must not resurrect it.
        if (location.pathname === sourcePath && stageRouteRevision === sourceRevision) {
          retiringContactControls = [];
          stageQueue = previousQueue;
          if (previousQueue) sessionStorage.setItem(STAGE_QUEUE_KEY, JSON.stringify(previousQueue));
          else sessionStorage.removeItem(STAGE_QUEUE_KEY);
          if (previousOrigin === null) sessionStorage.removeItem(originKey);
          else sessionStorage.setItem(originKey, previousOrigin);
        }
        recordWorkflowTiming('Navigation', phase, performance.now() - started, 'stopped');
        refreshButtons();
        throw error;
      }
    }
    try {
      sessionStorage.setItem(NAVIGATION_TIMING_KEY, JSON.stringify({ contactId: lead.contactId,
        startedAt: Date.now(), sourceTimeOrigin: performance.timeOrigin }));
    } catch { /* Optional timing must never prevent navigation. */ }
    location.assign(path);
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
    refreshButtons();
    sessionStorage.removeItem(STAGE_QUEUE_KEY);
  }
  function syncStageQueue() {
    if (stageQueuePath === location.pathname) return;
    stageQueuePath = location.pathname;
    if (!location.pathname.includes(`/location/${LOCATION_ID}/`)) { cancelLeadAccessReport(); closeLeadAccessReport(); invalidateOutgoingCallCounter(); }
    stageRouteRevision++;
    invalidateContactReads();
    refreshButtons();
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
    refreshButtons();
  }
  function stageQueueLabel() {
    const context = stageQueueContext();
    return context ? `Next from: ${context.pipeline.name} · ${context.stage}` : 'Choose the original stage queue';
  }
  function nextLeadLabel() {
    return settings.priority === 'stage' ? `Next lead — ${stageQueueLabel()}` : 'Next lead';
  }
  function emptyQueueMessage() {
    if (settings.priority !== 'stage') return 'You’re all caught up! No new leads or due follow-up tasks match your selected queues. Nice work.';
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

  // Two bounded, tab-memory-only read slots. Epoch changes also retire pending reads.
  let contactReadEpoch = 0;
  let contactWritesPending = 0;
  const contactReads = { details: null, opportunities: null };
  function invalidateContactReads() {
    contactReadEpoch++;
    contactReads.details = contactReads.opportunities = null;
    hideStageIndicator();
    hideQueueSummary();
    refreshButtons();
  }
  function rejectCrmAuthorization() {
    liveReadHeaders = null;
    currentUserId = null; identityExpires = 0; identityStatus = 'CRM authorization rejected';
    if (leadReportRun?.kind === 'counter') cancelLeadAccessReport();
    invalidateOutgoingCallCounter();
    invalidateContactReads();
  }
  function contactReadContext() {
    syncStageQueue();
    return { id: contactId(), user: currentUserId, epoch: contactReadEpoch, started: Date.now(), blocked: contactWritesPending > 0 };
  }
  function validContactRead(context) {
    syncStageQueue();
    return context.id && /^[a-zA-Z0-9_-]+$/.test(context.id)
      && location.pathname.includes(`/location/${LOCATION_ID}/`) && context.id === contactId()
      && context.user && context.user === currentUserId && identityExpires > Date.now() / 1000
      && context.epoch === contactReadEpoch && !context.blocked && !contactWritesPending;
  }
  function reusableContactRead(context) {
    const age = Date.now() - context.started;
    return age >= 0 && age < 5000 && validContactRead(context);
  }
  function normalizeContactRead(kind, data, id) {
    const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
    const optional = value => {
      if (value == null) return '';
      if (typeof value !== 'string') throw new Error('Malformed contact read field.');
      return value;
    };
    if (kind === 'details') {
      const c = data?.contact;
      if (!c || c.id !== id || c.locationId !== LOCATION_ID) throw new Error('Contact identity/account mismatch.');
      return Object.freeze({ id: c.id, locationId: c.locationId, firstName: optional(c.firstName),
        lastName: optional(c.lastName), phone: optional(c.phone), assignedTo: optional(c.assignedTo) });
    }
    if (!Array.isArray(data?.opportunities) || !Number.isInteger(data.total) || data.total !== data.opportunities.length) {
      throw new Error('Contact opportunities are incomplete.');
    }
    const ids = new Set();
    return Object.freeze(data.opportunities.map(o => {
      if (!o || !['id', 'pipelineId', 'pipelineStageId'].every(key => safeId(o[key]))
        || o.contactId !== id || o.locationId !== LOCATION_ID || ids.has(o.id)) throw new Error('Invalid contact opportunity identity/account.');
      ids.add(o.id);
      return Object.freeze({ id: o.id, contactId: o.contactId, locationId: o.locationId,
        pipelineId: o.pipelineId, pipelineStageId: o.pipelineStageId, assignedTo: optional(o.assignedTo),
        ...(o.status == null ? {} : { status: optional(o.status) }) });
    }));
  }
  function contactOpportunityQuery(id) {
    return { locationId: LOCATION_ID, page: 1, limit: 100, query: '', sort: [],
      filters: [{ group: 'OR', filters: [{ field: 'contact_id', operator: 'eq', value: id }] }] };
  }
  async function readContactData(kind, fresh) {
    const context = contactReadContext();
    await requireVerifiedUser();
    if (!validContactRead(context)) throw new Error('Contact read context changed or a save is pending.');
    const cached = contactReads[kind];
    if (cached && validContactRead(cached.context) && (cached.pending || !fresh && reusableContactRead(cached.context))) return cached.pending || cached.value;
    const slot = { context, pending: null, value: null };
    contactReads[kind] = slot;
    slot.pending = (async () => {
      const data = kind === 'details' ? await crmRequest('GET', `/contacts/${context.id}`)
        : await crmRequest('POST', '/opportunities/search', contactOpportunityQuery(context.id));
      await requireVerifiedUser();
      if (!validContactRead(context)) throw new Error('Contact read became stale.');
      slot.value = normalizeContactRead(kind, data, context.id);
      if (kind === 'details') rememberLeadContact(slot.value, leadAccessContext());
      refreshButtons();
      return slot.value;
    })();
    try { return await slot.pending; }
    catch (error) { if (contactReads[kind] === slot) contactReads[kind] = null; throw error; }
    finally { slot.pending = null; }
  }
  function readContactDetails({ fresh = false } = {}) { return readContactData('details', fresh); }
  function readContactOpportunities({ fresh = false } = {}) { return readContactData('opportunities', fresh); }
  function safeContactSearch(raw, id) {
    const body = jsonValue(raw);
    if (!body || body.locationId !== LOCATION_ID || body.page !== 1 || body.query !== ''
      || Object.keys(body).some(key => !['locationId', 'page', 'limit', 'query', 'sort', 'filters'].includes(key))
      || !Array.isArray(body.filters) || body.filters.length !== 1) return false;
    const group = body.filters[0];
    if (!['OR', 'AND'].includes(group.group) || !Array.isArray(group.filters)) return false;
    const contact = f => f.field === 'contact_id' && f.operator === 'eq' && f.value === id && !f.filters;
    return group.filters.length === 1 && contact(group.filters[0])
      || group.group === 'OR' && group.filters.length === 2 && group.filters.some(contact)
        && group.filters.every(f => contact(f) || f.field === 'id' && f.operator === 'eq'
          && Array.isArray(f.value) && f.value.length > 0 && f.value.every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id)) && !f.filters);
  }
  function observeContactRequest(method, url, body) {
    const parsed = new URL(url, location.href);
    if (!['https://services.leadconnectorhq.com', 'https://backend.leadconnectorhq.com'].includes(parsed.origin)) return null;
    const path = parsed.pathname.replace(/\/$/, '');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && /^\/(contacts|opportunities)(\/|$)/.test(path)
      && !/\/search$/.test(path)) {
      invalidateContactReads(); contactWritesPending++;
      return { write: true, finished: false };
    }
    const context = contactReadContext();
    if (!validContactRead(context)) return null;
    if (method === 'GET' && parsed.pathname === `/contacts/${context.id}` && !parsed.search) return { kind: 'details', context };
    if (method === 'POST' && parsed.origin === 'https://services.leadconnectorhq.com' && path === '/opportunities/search') {
      return { kind: 'opportunities', context, query: Promise.resolve(body()).then(raw => safeContactSearch(raw, context.id), () => false) };
    }
    return null;
  }
  function finishContactWrite(observation) {
    if (!observation?.write || observation.finished) return;
    observation.finished = true; contactWritesPending--; invalidateContactReads();
  }
  async function rememberContactRead(observation, data) {
    if (!observation?.kind || observation.query && !await observation.query || !reusableContactRead(observation.context)) return;
    const value = normalizeContactRead(observation.kind, data, observation.context.id);
    if (observation.kind === 'details') rememberLeadContact(value, leadAccessContext());
    const existing = contactReads[observation.kind];
    if (!existing || !existing.pending && existing.context.started <= observation.context.started) {
      contactReads[observation.kind] = { context: observation.context, value, pending: null };
      refreshButtons();
    }
  }

  // Observe session headers, read results and mutations; leave CRM requests unchanged.
  function jsonValue(value) {
    try { return typeof value === 'string' ? JSON.parse(value) : value; }
    catch { return null; }
  }
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    let stageObservation = null, contactObservation = null, taskObservation = null;
    try {
      const request = input instanceof Request ? input : null;
      stageObservation = observeStageRequest((init?.method || request?.method || 'GET').toUpperCase(), request?.url || String(input));
      captureReadHeaders(request?.url || String(input), init?.headers || request?.headers);
      contactObservation = observeContactRequest((init?.method || request?.method || 'GET').toUpperCase(), request?.url || String(input),
        () => init?.body ?? (request ? request.clone().text() : null));
      taskObservation = observeLeadTaskRequest((init?.method || request?.method || 'GET').toUpperCase(), request?.url || String(input),
        () => init?.body ?? (request ? request.clone().text() : null));
      captureQuery((init?.method || request?.method || 'GET').toUpperCase(), request?.url || String(input),
        () => init?.body ?? (request ? request.clone().text() : null));
    } catch { /* Observing must never prevent the CRM request. */ }
    let result;
    try { result = originalFetch.apply(this, arguments); }
    catch (error) { finishContactWrite(contactObservation); finishStageWrite(stageObservation); throw error; }
    if (taskObservation) result.then(async response => {
      if (!response.ok || !validLeadContext(taskObservation.context)) return;
      const copy = response.clone();
      if (await taskObservation.query) rememberLeadTasks(await copy.json(), taskObservation.context);
    }).catch(() => {});
    if (contactObservation?.write) result.then(() => finishContactWrite(contactObservation), () => finishContactWrite(contactObservation));
    else if (contactObservation) result.then(async response => {
      if (contactObservation.query && !await contactObservation.query || !validContactRead(contactObservation.context)) return;
      if ([401, 403].includes(response.status)) { rejectCrmAuthorization(); return; }
      if (!response.ok || !reusableContactRead(contactObservation.context)) return;
      return response.clone().json().then(data => rememberContactRead(contactObservation, data));
    }).catch(() => {});
    if (stageObservation?.write) result.then(() => finishStageWrite(stageObservation), () => finishStageWrite(stageObservation));
    else if (typeof stageObservation === 'number') {
      result.then(response => response.ok ? response.clone().json().then(data => rememberStageResults(data, stageObservation)) : null).catch(() => {});
    }
    if (pipelineListRequest(input instanceof Request ? input.url : String(input))) {
      result.then(response => response.ok ? response.clone().json().then(rememberPipelines) : null).catch(() => {});
    }
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
    let contactObservation = null, stageObservation = null;
    try {
      const info = xhrInfo.get(this);
      if (info) { captureReadHeaders(info.url, info.headers); captureQuery(info.method, info.url, () => body); }
      const taskObservation = info ? observeLeadTaskRequest(info.method, info.url, () => body) : null;
      if (taskObservation) this.addEventListener('loadend', async () => {
        try { if (this.status >= 200 && this.status < 300 && await taskObservation.query && validLeadContext(taskObservation.context))
          rememberLeadTasks(this.responseType === 'json' ? this.response : JSON.parse(this.responseText), taskObservation.context); } catch { /* Passive only. */ }
      }, { once: true });
      contactObservation = info ? observeContactRequest(info.method, info.url, () => body) : null;
      if (contactObservation) this.addEventListener('loadend', async () => {
        if (contactObservation.write) finishContactWrite(contactObservation);
        else try {
          if (contactObservation.query && !await contactObservation.query || !validContactRead(contactObservation.context)) return;
          if ([401, 403].includes(this.status)) { rejectCrmAuthorization(); return; }
          if (this.status >= 200 && this.status < 300 && reusableContactRead(contactObservation.context)) {
            await rememberContactRead(contactObservation, this.responseType === 'json' ? this.response : JSON.parse(this.responseText));
          }
        } catch { /* Passive schema errors must not affect the CRM. */ }
      }, { once: true });
      stageObservation = info ? observeStageRequest(info.method, info.url) : null;
      if (stageObservation !== null) this.addEventListener('loadend', () => {
        if (stageObservation.write) finishStageWrite(stageObservation);
        else try {
          if (this.status >= 200 && this.status < 300) rememberStageResults(this.responseType === 'json' ? this.response : JSON.parse(this.responseText), stageObservation);
        } catch { /* Unreadable board results must not establish a queue. */ }
      }, { once: true });
      if (info && pipelineListRequest(info.url)) this.addEventListener('loadend', () => {
        try { if (this.status >= 200 && this.status < 300) rememberPipelines(this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch { /* Keep previous catalog. */ }
      }, { once: true });
    } catch { /* Leave the CRM request unchanged. */ }
    try { return originalSend.apply(this, arguments); }
    catch (error) { finishContactWrite(contactObservation); finishStageWrite(stageObservation); throw error; }
  };

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
    const expectedTime = Date.parse(due);
    requireSaved(!data.errors?.length && Boolean(saved?.id) && saved.objectKey === 'task'
      && saved.locationId === LOCATION_ID && sent?.properties?.contactId === id,
      'task creation returned errors or the wrong task/contact/location.');
    requireSaved(saved.properties?.title === title && sent.properties.title === title,
      'saved task title did not match.');
    requireSaved(Date.parse(saved.properties?.dueDate) === expectedTime
      && Date.parse(sent.properties.dueDate) === expectedTime,
      `expected task deadline ${taskDueLabel(due)}; returned ${saved.properties?.dueDate}.`);
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

  // Action requests are deliberately separate from the read-only transport.
  const actionAttempts = new WeakMap();
  const actionStageVersions = new WeakMap();
  function safeActionId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value); }
  function requireActionApproval(action, context = workflow.approvedActionContext, expectedWrites = 0) {
    syncStageQueue();
    if (!context || context !== workflow.approvedActionContext || context.actions?.[action] !== true
      || !safeActionId(context.contact) || workflow.startingContact !== context.contact
      || !location.pathname.includes(`/location/${LOCATION_ID}/`)
      || context.contactRecord?.id !== context.contact || context.contactRecord.locationId !== LOCATION_ID
      || !liveReadHeaders || userFromHeaders(liveReadHeaders).id !== context.user) {
      throw new Error('A valid selected action and live approved contact/account/session are required.');
    }
    assertApprovedActionContext(expectedWrites);
    return context;
  }
  async function recheckActionContact(action, context) {
    requireActionApproval(action, context);
    const fresh = await readContactDetails({ fresh: true });
    requireActionApproval(action, context);
    if (['id', 'locationId', 'firstName', 'lastName', 'phone', 'assignedTo'].some(key => fresh[key] !== context.contactRecord[key])) {
      throw new Error('Contact changed after confirmation. Further saves stopped.');
    }
  }
  function actionRequestShape(operation, context) {
    if (operation === 'stageRead' || operation === 'stage') {
      const o = context.opportunity;
      if (!o || !['id', 'pipelineId', 'pipelineStageId'].every(key => safeActionId(o[key]))
        || o.contactId !== context.contact || o.locationId !== LOCATION_ID
        || !safeActionId(context.targetStageId) || typeof context.targetStageName !== 'string') throw new Error('Invalid approved opportunity/stage.');
      const version = actionStageVersions.get(context);
      if (operation === 'stage' && (!Number.isSafeInteger(version) || version < 1)) throw new Error('Fresh opportunity version is required.');
      return { action: 'stage', method: operation === 'stageRead' ? 'GET' : 'PUT', path: `/opportunities/${o.id}`,
        body: operation === 'stageRead' ? undefined : { pipelineStageId: context.targetStageId, indexVersion: version, isAttribute: false } };
    }
    if (operation === 'note') {
      if (typeof context.noteText !== 'string' || !context.noteText.trim()) throw new Error('Approved note is empty.');
      const escaped = context.noteText.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
      return { action: 'note', method: 'POST', path: `/notes/?locationId=${LOCATION_ID}`,
        body: { body: `<p>${escaped.replace(/\r\n?|\n/g, '<br>\n')}</p>`, title: '', color: '#fef7c3', relations: [{ objectKey: 'contact', recordId: context.contact }] } };
    }
    if (operation === 'task') {
      const due = typeof context.due === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(context.due) && new Date(context.due);
      if (!safeActionId(context.ownerId) || context.ownerId !== context.contactRecord.assignedTo
        || typeof context.taskTitle !== 'string' || !context.taskTitle.trim()
        || !due || !Number.isFinite(due.getTime()) || due.toISOString() !== context.due || context.taskId !== null) throw new Error('Invalid approved task owner/title/deadline or task already created.');
      return { action: 'task', method: 'POST', path: '/objects/task/records', body: { locationId: LOCATION_ID, owners: [context.ownerId],
        properties: { title: context.taskTitle, dueDate: due.toISOString(), completed: false, description: '', contactId: context.contact } } };
    }
    if (operation === 'link' && safeActionId(context.taskId) && actionAttempts.get(context)?.has('task')) {
      return { action: 'task', method: 'POST', path: '/associations/relations/bulk?updateFutureTasks=false',
        body: { locationId: LOCATION_ID, add: [{ associationId: 'TASK_CONTACT_ASSOCIATION', firstRecordId: context.taskId, secondRecordId: context.contact }] } };
    }
    throw new Error('Action request is outside the approved operations.');
  }
  async function actionRequest(operation, context) {
    if (!context || context !== workflow.approvedActionContext) throw new Error('Action approval is required.');
    const { action, method, path, body } = actionRequestShape(operation, context);
    requireActionApproval(action, context);
    let attempts = actionAttempts.get(context);
    if (!attempts) { attempts = new Set(); actionAttempts.set(context, attempts); }
    if (attempts.has(operation) || context.stopSaves || workflow.pendingSave && !context.parallel && operation !== 'link') throw new Error('Action already attempted, stopped or an unresolved save exists. No retry.');
    const wire = wireRequest(method, path, body);
    if (action !== 'task') delete wire.headers.developer_version;
    if (method !== 'GET') {
      const description = operation === 'link' ? `Contact association for task ${context.taskId}`
        : action === 'stage' ? `Stage: ${context.targetStageName} (${context.targetStageId}); opportunity ${context.opportunity.id}`
        : action === 'note' ? `Note: ${context.noteText}`
        : `Task: ${context.taskTitle}; ${taskDueLabel(context.due)}; owner ${context.ownerId}`;
      setPendingAction(operation, description); // No request before this operation's durable journal entry.
      attempts.add(operation);
    }
    const diagnostic = { method, url: `https://services.leadconnectorhq.com${action === 'stage' ? '/opportunities/{id}' : path.split('?')[0]}`,
      started: new Date().toISOString(), status: null, result: 'pending' };
    recordRequest(diagnostic);
    const controller = new AbortController(), started = Date.now();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let contactObservation, stageObservation;
    try {
      // No await between this final approval/auth check and the native request.
      requireActionApproval(action, context);
      if (operation === 'stage') {
        contactObservation = observeContactRequest(method, wire.url, () => body);
        // Account for our own stage write without making contact caches reusable during it.
        if (context.parallel && contactObservation?.write) {
          context.ownedEpoch++;
          context.ownedWritesPending++;
        }
        stageObservation = observeStageRequest(method, wire.url);
      }
      if (method !== 'GET') workflow.activeSaveProgress?.dispatched(action, operation);
      const response = await originalFetch.call(window, wire.url, { method, headers: { ...wire.headers, ...liveReadHeaders },
        redirect: 'error', ...(method === 'GET' ? { cache: 'no-store' } : { body: JSON.stringify(body) }), signal: controller.signal });
      diagnostic.status = response.status;
      if ([401, 403].includes(response.status)) rejectCrmAuthorization();
      if (!response.ok) throw new Error('HTTP failure');
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || data.errors?.length) throw new Error('Invalid response');
      diagnostic.result = 'response received';
      return { data, body };
    } catch (error) {
      diagnostic.result = error.name === 'AbortError' ? 'timeout' : 'response rejected';
      // Do not propagate server text, URLs, bodies or native exception messages.
      throw new Error(`API ${action}: ${error.name === 'AbortError' ? 'Timed out after 30 seconds' : diagnostic.status ? `HTTP ${diagnostic.status}; response not verified` : 'No verified HTTP response'}. No automatic retry.`);
    } finally {
      if (context.parallel && contactObservation?.write && !contactObservation.finished) {
        context.ownedEpoch++;
        context.ownedWritesPending--;
      }
      finishContactWrite(contactObservation); finishStageWrite(stageObservation);
      clearTimeout(timeout); diagnostic.elapsedMs = Date.now() - started;
    }
  }
  async function prepareStageApi() {
    const context = requireActionApproval('stage');
    const { data } = await actionRequest('stageRead', context);
    requireActionApproval('stage', context);
    const fresh = data.opportunity, approved = context.opportunity;
    requireSaved(fresh && ['id', 'contactId', 'locationId', 'pipelineId', 'pipelineStageId'].every(key => fresh[key] === approved[key])
      && (fresh.assignedTo ?? '') === (approved.assignedTo ?? ''), 'fresh opportunity changed after approval.');
    // The native CRM starts missing/null versions at 1; other malformed values still fail closed.
    const version = fresh.indexVersion ?? 0;
    requireSaved(Number.isSafeInteger(version) && version >= 0 && Number.isSafeInteger(version + 1), 'invalid opportunity version.');
    // Captured increment, not a claim of atomic optimistic locking or safe replay.
    actionStageVersions.set(context, version + 1);
  }
  async function saveStageApi() {
    const context = requireActionApproval('stage');
    if (!actionStageVersions.has(context)) await prepareStageApi();
    const approved = context.opportunity;
    const saved = await actionRequest('stage', context);
    verifyStage(saved.data, saved.body, approved.id, context.contact, approved.pipelineId);
    requireSaved(saved.data.opportunity.locationId === LOCATION_ID && saved.data.opportunity.indexVersion === actionStageVersions.get(context)
      && (context.parallel || (saved.data.opportunity.assignedTo ?? '') === (approved.assignedTo ?? '')), 'saved opportunity account/version/owner did not match.');
    appendJournalEvidence(`Stage: ${context.targetStageName} (server confirmed; opportunity ${approved.id})`);
    workflow.activeSaveProgress?.confirm('stage');
    setPendingAction('stage', null);
    requireActionApproval('stage', context, 1);
    if (!context.parallel) context.epoch = contactReadEpoch;
  }
  async function saveNoteApi() {
    const context = requireActionApproval('note');
    if (!context.parallel) await recheckActionContact('note', context);
    const { data, body } = await actionRequest('note', context);
    requireSaved(safeActionId(data.note?.id), 'unsafe note ID.');
    verifyNote(data, body, context.contact, context.noteText);
    appendJournalEvidence(`Note saved (server confirmed; note ${data.note.id})`);
    workflow.activeSaveProgress?.confirm('note');
    setPendingAction('note', null);
    requireActionApproval('note', context);
  }
  async function createTaskApi() {
    const context = requireActionApproval('task');
    actionRequestShape('task', context);
    if (workflow.pendingSave && !context.parallel || actionAttempts.get(context)?.has('task')) throw new Error('Task already attempted or unresolved save exists. No retry.');
    if (!context.parallel) await recheckActionContact('task', context);
    const { data, body } = await actionRequest('task', context);
    requireSaved(safeActionId(data.record?.id), 'unsafe task ID.');
    verifyTask(data, body, context.contact, context.taskTitle, context.due);
    context.taskId = data.record.id;
    workflow.activeSaveProgress?.created();
    appendJournalEvidence(`Task created: ${context.taskId}; ${taskDueLabel(context.due)} (server confirmed)`);
    setPendingAction('task', `Contact association for task ${context.taskId}`);
    requireActionApproval('task', context);
    const linked = await actionRequest('link', context);
    verifyTaskLink(linked.data, context.taskId, context.contact);
    rememberLeadContact(context.contactRecord, { user: context.user });
    rememberLeadTask(context.contact, { id: context.taskId, title: context.taskTitle, due: context.due, completed: false, observedAt: Date.now() }, { user: context.user });
    appendJournalEvidence('Task contact association: server confirmed');
    workflow.activeSaveProgress?.confirm('task');
    setPendingAction('link', null);
    setPendingAction('task', null);
    requireActionApproval('task', context);
  }

  // Local, bounded last-known history. Never stores credentials, phone numbers or full responses.
  const LEAD_RETENTION = 180 * 86400000;
  const leadHistories = new Map();
  let leadHistoryTimer = null, leadStorageWarning = '', leadReportRun = null, leadReportDialog = null, callCounterView = null;
  const leadId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
  const leadHistoryKey = user => `pertama:lead-access:${LOCATION_ID}:${user}`;
  function leadAccessContext() { return { user: currentUserId, observedAt: Date.now() }; }
  function validLeadContext(context) {
    return context?.user && context.user === currentUserId && identityExpires > Date.now() / 1000
      && location.pathname.includes(`/location/${LOCATION_ID}/`);
  }
  function boundedLeadHistory(rows) {
    return (Array.isArray(rows) ? rows : []).filter(r => leadId(r?.id) && Number.isFinite(r.observedAt)
      && r.observedAt > Date.now() - LEAD_RETENTION).sort((a, b) => b.observedAt - a.observedAt).slice(0, 2000).map(r => ({
      id: r.id, name: typeof r.name === 'string' ? r.name.slice(0, 300) : '', observedAt: r.observedAt,
      lastAccessible: Number.isFinite(r.lastAccessible) ? r.lastAccessible : null,
      lastCall: Number.isFinite(r.lastCall) ? r.lastCall : null,
      tasks: (Array.isArray(r.tasks) ? r.tasks : []).filter(t => leadId(t?.id) && typeof t.title === 'string'
        && typeof t.completed === 'boolean' && Number.isFinite(t.observedAt) && t.observedAt > Date.now() - LEAD_RETENTION)
        .sort((a, b) => b.observedAt - a.observedAt).slice(0, 20).map(t => ({ id: t.id, title: t.title.slice(0, 500),
          due: typeof t.due === 'string' ? t.due.slice(0, 100) : '', completed: t.completed, observedAt: t.observedAt })),
    }));
  }
  function storedLeadHistory(user) {
    try { return boundedLeadHistory(JSON.parse(localStorage.getItem(leadHistoryKey(user)) || '[]')); }
    catch { leadStorageWarning = 'Local history storage unavailable; history may be lost on reload.'; return []; }
  }
  function leadHistory(context) {
    if (!validLeadContext(context)) return [];
    if (!leadHistories.has(context.user)) leadHistories.set(context.user, storedLeadHistory(context.user));
    return leadHistories.get(context.user); // Normalized on load/flush; do not clone all tasks per observation.
  }
  function flushLeadHistory() {
    clearTimeout(leadHistoryTimer); leadHistoryTimer = null;
    for (const [user, rows] of leadHistories) {
      const merged = new Map(storedLeadHistory(user).map(r => [r.id, r]));
      for (const row of rows) {
        const old = merged.get(row.id);
        const tasks = new Map((old?.tasks || []).map(t => [t.id, t]));
        for (const task of row.tasks) if (newerLeadTask(task, tasks.get(task.id))) tasks.set(task.id, task);
        const newer = !old || row.observedAt >= old.observedAt ? row : old;
        const named = row.name && (!old?.name || (row.lastAccessible || 0) >= (old.lastAccessible || 0)) ? row : old;
        merged.set(row.id, { ...newer, name: named?.name || '',
          lastAccessible: Math.max(row.lastAccessible || 0, old?.lastAccessible || 0) || null,
          lastCall: Math.max(row.lastCall || 0, old?.lastCall || 0) || null, tasks: [...tasks.values()] });
      }
      const value = boundedLeadHistory([...merged.values()]); leadHistories.set(user, value);
      try { const serialized = JSON.stringify(value); if (localStorage.getItem(leadHistoryKey(user)) !== serialized) localStorage.setItem(leadHistoryKey(user), serialized); }
      catch { leadStorageWarning = 'Local history storage unavailable; history may be lost on reload.'; }
    }
    if (leadStorageWarning && leadReportDialog && validLeadContext(leadReportDialog.context)) {
      leadReportDialog.dialog.querySelector('[data-storage]').textContent = leadStorageWarning;
    }
  }
  window.addEventListener('pagehide', flushLeadHistory);
  function updateLeadHistory(id, context, update) {
    if (!leadId(id) || !validLeadContext(context)) return;
    const rows = leadHistory(context), old = rows.find(r => r.id === id);
    const row = old || { id, name: '', lastAccessible: null, lastCall: null, observedAt: Date.now(), tasks: [] };
    const before = JSON.stringify(row); update(row);
    if (!old) rows.push(row);
    if (before !== JSON.stringify(row) || !old) {
      if (rows.length > 2000) { rows.sort((a, b) => b.observedAt - a.observedAt); rows.splice(2000); }
      if (leadHistoryTimer === null) leadHistoryTimer = setTimeout(flushLeadHistory, 1000);
    }
  }
  function rememberLeadContact(contact, context, report = false) {
    if (contact?.locationId !== LOCATION_ID) return;
    updateLeadHistory(contact.id, context, row => {
      row.name = [contact.firstName, contact.lastName].filter(v => typeof v === 'string').join(' ').trim().slice(0, 300) || row.name;
      row.lastAccessible = Date.now();
      // A synthetic report check is not new activity and must not extend retention.
      if (!report) row.observedAt = Date.now();
    });
  }
  function newerLeadTask(task, previous) {
    return !previous || task.observedAt > previous.observedAt
      || task.observedAt === previous.observedAt && (task.completed || !previous.completed);
  }
  function rememberLeadTask(id, task, context) {
    updateLeadHistory(id, context, row => {
      const saved = { id: task.id, title: task.title.slice(0, 500), due: typeof task.due === 'string' ? task.due.slice(0, 100) : '',
        completed: task.completed, observedAt: task.observedAt };
      const index = row.tasks.findIndex(t => t.id === task.id);
      if (!newerLeadTask(saved, row.tasks[index])) return;
      if (index < 0) row.tasks.push(saved); else row.tasks[index] = saved;
      row.tasks = row.tasks.filter(t => t.observedAt > Date.now() - LEAD_RETENTION).sort((a, b) => b.observedAt - a.observedAt).slice(0, 20);
      row.observedAt = Math.max(row.observedAt, task.observedAt);
    });
  }
  function completeRememberedLeadTask(id, taskId, context) {
    const task = leadHistory(context).find(r => r.id === id)?.tasks.find(t => t.id === taskId);
    if (task) rememberLeadTask(id, { ...task, completed: true, observedAt: Date.now() }, context);
  }
  function normalizedLeadTasks(data) {
    if (!Array.isArray(data?.customObjectRecords) || !Number.isInteger(data.total) || data.total < data.customObjectRecords.length) throw new Error('Invalid task coverage.');
    const ids = new Set();
    return data.customObjectRecords.map(row => {
      const relations = row?.relations?.filter(r => r?.associationId === 'TASK_CONTACT_ASSOCIATION' || r?.objectKey === 'contact');
      if (!leadId(row?.id) || ids.has(row.id) || row.locationId !== LOCATION_ID || row.objectKey !== 'task'
        || !Array.isArray(row.owners) || !row.owners.every(leadId) || typeof row.properties?.title !== 'string'
        || ![0, 1, false, true].includes(row.properties.completed) || typeof row.properties.dueDate !== 'string'
        || !Array.isArray(relations) || relations.length > 1 || relations.length === 1 && (relations[0].associationId !== 'TASK_CONTACT_ASSOCIATION'
        || relations[0].objectKey !== 'contact' || !leadId(relations[0].recordId) || !leadId(relations[0].relationId))) throw new Error('Invalid task record.');
      ids.add(row.id); return { row, contact: relations[0]?.recordId || null };
    });
  }
  function rememberLeadTasks(data, context) {
    if (!validLeadContext(context)) return;
    try {
      for (const { row, contact } of normalizedLeadTasks(data)) {
        if (!contact) continue;
        const known = leadHistory(context).find(r => r.id === contact)?.tasks.some(t => t.id === row.id);
        if (row.owners.includes(context.user) || known) rememberLeadTask(contact, { id: row.id, title: row.properties.title,
          due: row.properties.dueDate, completed: Boolean(row.properties.completed), observedAt: context.observedAt ?? Date.now() }, context);
      }
    } catch { /* Passive observations must never interrupt the CRM. */ }
  }
  function observeLeadTaskRequest(method, url, body) {
    try {
      const parsed = new URL(url, location.href), context = leadAccessContext();
      if (method !== 'POST' || parsed.origin !== 'https://services.leadconnectorhq.com'
        || parsed.pathname !== '/objects/task/records/search' || parsed.search || !validLeadContext(context)) return null;
      return { context, query: Promise.resolve(body()).then(raw => jsonValue(raw)?.locationId === LOCATION_ID, () => false) };
    } catch { return null; }
  }
  function cancelLeadAccessReport() { if (leadReportRun) { leadReportRun.cancelled = true; leadReportRun.controller?.abort(); } }
  function requireLeadReport(run, controller) {
    if (run !== leadReportRun || controller?.signal.aborted || run.cancelled || !validLeadContext(run.context)) throw new Error('Report cancelled or account/session changed.');
  }
  async function leadReportRequest(run, kind, body) {
    requireLeadReport(run);
    const contact = kind === 'contact', reading = contact || kind === 'numbers', backend = contact || kind === 'calls';
    if (!['calls', 'tasks', 'contact', 'numbers'].includes(kind) || contact && !leadId(body)) throw new Error('Report endpoint rejected.');
    if (!liveReadHeaders?.['token-id']) throw new Error('Verified CRM token-id required.');
    const url = backend ? `https://backend.leadconnectorhq.com${contact ? `/contacts/${body}` : '/reporting/calls/get-all-phone-calls-new'}`
      : `https://services.leadconnectorhq.com${kind === 'numbers' ? `/phone-system/numbers/v2/location/${LOCATION_ID}?includeRcsSenderIds=true` : '/objects/task/records/search'}`;
    const controller = new AbortController(); run.controller = controller;
    let timeout;
    const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error(run.cancelled ? 'Report cancelled.' : 'Report request timed out.')), { once: true }));
    timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const result = await Promise.race([aborted, (async () => {
        const response = await originalFetch.call(window, url, { method: reading ? 'GET' : 'POST',
          headers: { ...CRM_HEADERS, version: backend ? '2021-04-15' : '2021-07-28', 'token-id': liveReadHeaders['token-id'],
            ...(reading ? {} : { 'content-type': 'application/json' }) }, redirect: 'error', cache: 'no-store', signal: controller.signal,
          ...(reading ? {} : { body: JSON.stringify(body) }) });
        requireLeadReport(run, controller);
        let data;
        try { data = await response.json(); }
        catch { requireLeadReport(run, controller); if ([401, 403].includes(response.status)) rejectCrmAuthorization(); throw new Error('Unreadable report response.'); }
        requireLeadReport(run, controller);
        if (contact && [401, 403].includes(response.status) && data?.message === 'Permission denied.'
          && data.error === 'Unauthorized' && data.statusCode === response.status) return { denied: true };
        if ([401, 403].includes(response.status)) { rejectCrmAuthorization(); throw new Error('CRM session rejected.'); }
        if (!response.ok || !data || typeof data !== 'object' || data.error || data.errors?.length) throw new Error(`Report lookup failed (HTTP ${response.status}).`);
        return data;
      })()]);
      requireLeadReport(run, controller); return result;
    } finally { clearTimeout(timeout); if (run.controller === controller) run.controller = null; }
  }
  function leadCallsBody(selectedPool, days) {
    return { locationId: LOCATION_ID, source: [], sourceType: [], keyword: [], landingPage: [], referrer: [], campaign: [],
      callStatus: [], dispositions: [], deviceType: [], qualifiedLead: false, firstTime: false, duration: null, selectedPool,
      direction: null, startDate: new Date(Date.now() - days * 86400000).toISOString(), endDate: new Date().toISOString(), userId: '', limit: 50, skip: 0 };
  }
  function validateLeadCalls(data, requireContact = true) {
    if (!Array.isArray(data?.rows) || !Number.isInteger(data.totalRows) || data.totalRows < data.rows.length
      || !Number.isInteger(data.totalPages) || data.totalPages < 0) throw new Error('Incomplete call pagination.');
    for (const row of data.rows) if (!leadId(row?.id) || requireContact && !leadId(row.contactId) || !leadId(row.userId)
      || row.locationId !== LOCATION_ID || !Number.isFinite(Date.parse(row.dateAdded))) throw new Error('Invalid call record.');
  }
  async function readLeadPhonePool(run) {
    const inventory = await leadReportRequest(run, 'numbers');
    if (!Array.isArray(inventory.numbers) || !Number.isInteger(inventory.total) || inventory.total !== inventory.numbers.length) throw new Error('Incomplete phone number inventory.');
    const seen = new Set(), pool = [];
    for (const number of inventory.numbers) {
      if (!number || typeof number.phoneNumber !== 'string' || !/^\+[1-9]\d{6,14}$/.test(number.phoneNumber)
        || seen.has(number.phoneNumber) || !(number.linkedUser == null || typeof number.linkedUser === 'string')
        || typeof number.capabilities?.voice !== 'boolean') throw new Error('Invalid phone number inventory.');
      seen.add(number.phoneNumber);
      if (number.linkedUser === run.context.user && number.capabilities.voice === true) pool.push(number.phoneNumber);
    }
    if (!pool.length) throw new Error('No voice numbers linked to your user.');
    return pool;
  }
  async function runOutgoingCallCount(owner = null) {
    if (leadReportRun) throw new Error('Report already running.');
    const run = { context: leadAccessContext(), kind: 'counter', cancelled: false, controller: null };
    leadReportRun = run; if (owner) owner.run = run;
    const now = Date.now(), today = Math.floor((now + 28800000) / 86400000) * 86400000 - 28800000, yesterday = today - 86400000;
    const days = ['Today', 'Yesterday'].map(label => ({ label, total: 0, statuses: Object.create(null) }));
    try {
      const body = { ...leadCallsBody(await readLeadPhonePool(run), 2), startDate: new Date(yesterday).toISOString(), endDate: new Date(now).toISOString() };
      const seen = new Set(); let total = null;
      for (let skip = 0; ; skip += 50) {
        const data = await leadReportRequest(run, 'calls', { ...body, skip }); validateLeadCalls(data, false);
        if (total !== null && total !== data.totalRows) throw new Error('Call totals changed during pagination.');
        total = data.totalRows;
        if (total > 5000) throw new Error('Call coverage capped at 5,000 records.');
        if (data.rows.length !== Math.min(50, total - skip)) throw new Error('Incomplete call pages.');
        if (data.rows.some(row => seen.has(row.id))) throw new Error('Repeated or overlapping call pages.');
        for (const row of data.rows) {
          if (seen.has(row.id)) continue; seen.add(row.id);
          const date = Date.parse(row.dateAdded);
          if (row.userId !== run.context.user || row.direction !== 'outbound' || date < yesterday || date >= now) continue;
          const day = days[date >= today ? 0 : 1], status = typeof row.callStatus === 'string' && row.callStatus ? row.callStatus : 'unknown';
          day.total++; day.statuses[status] = (day.statuses[status] || 0) + 1;
        }
        if (skip + data.rows.length === total) break;
      }
      requireLeadReport(run); return { days, updatedAt: now };
    } finally { if (leadReportRun === run) leadReportRun = null; }
  }
  async function runLeadAccessReport(days = 30, progress = () => {}) {
    if (leadReportRun) throw new Error('Report already running.');
    const run = { context: leadAccessContext(), cancelled: false, controller: null }; leadReportRun = run;
    const result = { rows: [], warnings: [], complete: false, cancelled: false, checked: 0 };
    const candidates = new Set();
    let body;
    try {
      requireLeadReport(run);
      leadHistory(run.context); flushLeadHistory(); // Merge newer observations from other tabs before a report.
      progress('Reading your phone numbers…');
      try {
        body = leadCallsBody(await readLeadPhonePool(run), [7, 30, 90].includes(Number(days)) ? Number(days) : 30);
      } catch (error) { requireLeadReport(run); result.warnings.push(`Incomplete call coverage: ${error.message}`); }
      if (body) progress('Reading your calls…');
      const calls = new Set(); let total = null;
      for (let page = 0; body; page++) {
        if (page === 100) throw new Error('Call coverage capped at 5,000 records.');
        const data = await leadReportRequest(run, 'calls', { ...body, skip: page * 50 }); validateLeadCalls(data);
        if (total !== null && total !== data.totalRows) throw new Error('Call totals changed during pagination.'); total = data.totalRows;
        let added = 0;
        for (const row of data.rows) {
          if (calls.has(row.id)) continue; calls.add(row.id); added++;
          const date = Date.parse(row.dateAdded);
          if (row.userId !== run.context.user || date < Date.parse(body.startDate) || date > Date.parse(body.endDate)) continue;
          candidates.add(row.contactId);
          updateLeadHistory(row.contactId, run.context, saved => { saved.lastCall = Math.max(saved.lastCall || 0, date); saved.observedAt = Math.max(saved.observedAt, date); });
        }
        if (calls.size === total) break;
        if (!added || data.rows.length !== 50 || (page + 1) * 50 >= total) throw new Error('Repeated or incomplete call pages.');
      }
      progress('Reading pending tasks…');
      try {
        const seen = new Set(); let taskTotal = null;
        for (let page = 1; ; page++) {
          if (page > 100) throw new Error('Task coverage capped at 10,000 records.');
          const taskContext = { ...run.context, observedAt: Date.now() };
          const data = await leadReportRequest(run, 'tasks', { locationId: LOCATION_ID, page, pageLimit: 100,
            filters: [{ field: 'properties.completed', operator: 'eq', value: 0 }],
            sort: [{ field: 'properties.dueDate', direction: 'asc' }], includeTopRelations: true, includeRecurringTaskConfigs: true });
          const rows = normalizedLeadTasks(data);
          if (taskTotal !== null && taskTotal !== data.total) throw new Error('Task totals changed.'); taskTotal = data.total;
          for (const { row, contact } of rows) {
            if (seen.has(row.id)) throw new Error('Repeated task page.'); seen.add(row.id);
            if (contact && row.owners.includes(run.context.user) && !row.properties.completed) candidates.add(contact);
          }
          rememberLeadTasks(data, taskContext);
          if (seen.size === taskTotal) break;
          if (rows.length !== 100 || page * 100 >= taskTotal) throw new Error('Incomplete task pages.');
        }
      } catch (error) { requireLeadReport(run); result.warnings.push(`Incomplete task coverage: ${error.message}`); }
      flushLeadHistory(); // Include cross-tab follow-ups written while list requests were in flight; prune expired history.
      for (const row of leadHistory(run.context)) if (row.tasks.some(t => !t.completed)) candidates.add(row.id);
      for (const id of candidates) {
        requireLeadReport(run); progress(`Checking contacts ${result.checked + 1}/${candidates.size}…`);
        try {
          const data = await leadReportRequest(run, 'contact', id);
          if (data.denied) {
            const saved = leadHistory(run.context).find(r => r.id === id);
            result.rows.push({ id, name: saved?.name || id, lastCall: saved?.lastCall, lastAccessible: saved?.lastAccessible,
              tasks: (saved?.tasks || []).filter(t => !t.completed) });
          } else rememberLeadContact(normalizeContactRead('details', data, id), run.context, true);
        } catch (error) { requireLeadReport(run); result.warnings.push(`Unresolved contact ${id}: ${error.message}`); }
        result.checked++;
      }
      if (result.rows.length && body) { progress('Revalidating CRM session…'); validateLeadCalls(await leadReportRequest(run, 'calls', body)); }
      requireLeadReport(run); result.complete = result.warnings.length === 0;
    } catch (error) { result.rows = []; result.cancelled = run.cancelled; result.warnings.push(error.message); }
    finally { if (leadReportRun === run) leadReportRun = null; }
    flushLeadHistory(); // A quota failure must be visible before returning a completed report.
    if (leadStorageWarning) { result.warnings.push(leadStorageWarning); result.complete = false; }
    return result;
  }
  function closeLeadAccessReport() {
    if (leadReportRun?.kind !== 'counter') cancelLeadAccessReport();
    if (leadReportDialog) { const { dialog, focus } = leadReportDialog; leadReportDialog = null; dialog.close(); dialog.remove(); focus?.focus(); }
  }
  function openLeadAccessReport() {
    if (leadReportDialog || leadReportRun?.kind === 'counter' || !location.pathname.includes(`/location/${LOCATION_ID}/`)) return;
    const context = leadAccessContext(), focus = document.activeElement, dialog = document.createElement('dialog');
    dialog.id = 'pertama-lead-access'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', 'Inaccessible leads');
    dialog.innerHTML = `<style>
      #pertama-lead-access{box-sizing:border-box;width:800px;max-width:calc(100vw - 32px);max-height:85vh;overflow:auto;border:1px solid #e4e7ec;border-radius:14px;padding:24px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#182230;background:#fff;box-shadow:0 24px 60px #10182830}
      #pertama-lead-access::backdrop{background:#10182866}
      #pertama-lead-access *{box-sizing:border-box}
      #pertama-lead-access [hidden]{display:none!important}
      #pertama-lead-access h2{margin:0;padding-right:40px;font-size:22px;font-weight:600;line-height:1.3;color:#182230}
      #pertama-lead-access p{margin:16px 0;color:#667085;font-size:13px;line-height:1.5}
      #pertama-lead-access .report-toolbar{display:flex;align-items:flex-end;flex-wrap:wrap;gap:12px;margin-top:24px}
      #pertama-lead-access label{display:block;margin:0;color:#344054;font-size:13px;font-weight:500}
      #pertama-lead-access select,#pertama-lead-access button{padding:9px 11px;border:1px solid #d0d5dd;border-radius:7px;background:#fff;color:#344054;font:inherit;line-height:1.5;margin:0;box-shadow:0 1px 2px #10182805}
      #pertama-lead-access select{display:block;margin-top:5px;min-width:170px;color:#182230}
      #pertama-lead-access button{cursor:pointer;font-weight:500}
      #pertama-lead-access button:hover{background:#f2f4f7}
      #pertama-lead-access select:focus-visible,#pertama-lead-access button:focus-visible,#pertama-lead-access a:focus-visible{outline:2px solid #84adff;outline-offset:2px}
      #pertama-lead-access [data-run]{margin-left:auto;background:#155eef;border-color:#155eef;color:#fff}
      #pertama-lead-access [data-run]:hover{background:#004eeb}
      #pertama-lead-access :disabled{opacity:.6;cursor:default}
      #pertama-lead-access [data-close]{position:absolute;top:16px;right:16px;padding:4px 10px;border:0;background:transparent;font-size:24px;box-shadow:none}
      #pertama-lead-access [data-warning],#pertama-lead-access [data-storage]{margin:8px 0;color:#93370d;font-size:12px}
      #pertama-lead-access [data-warning]:empty,#pertama-lead-access [data-storage]:empty{display:none}
      #pertama-lead-access [data-rows]{max-width:100%;overflow-x:auto}
      #pertama-lead-access table{width:100%;min-width:620px;border-collapse:collapse;table-layout:fixed;font:inherit;color:#182230;background:#fff;border:0}
      #pertama-lead-access th,#pertama-lead-access td{padding:12px;text-align:left;vertical-align:top;border:0;border-bottom:1px solid #eaecf0;background:transparent;line-height:1.5}
      #pertama-lead-access th{background:#f9fafb;color:#667085;font-size:12px;font-weight:500}
      #pertama-lead-access th:nth-child(1){width:28%}#pertama-lead-access th:nth-child(2){width:16%}#pertama-lead-access th:nth-child(3){width:36%}#pertama-lead-access th:nth-child(4){width:20%}
      #pertama-lead-access a{color:#155eef;text-decoration:none;overflow-wrap:anywhere}
      #pertama-lead-access small{display:block;color:#667085;font-size:12px;overflow-wrap:anywhere}
      #pertama-lead-access .report-task{height:48px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #pertama-lead-access .report-time{display:block;color:#667085;font-size:12px}
      </style><h2>Inaccessible leads</h2><button type="button" data-close aria-label="Close" title="Close">×</button>
      <div class="report-toolbar"><label>Calls from<select><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select></label><button type="button" data-run>Run report</button><button type="button" data-cancel hidden disabled>Cancel</button></div>
      <p role="status"></p><p data-warning role="alert"></p><p data-storage role="alert"></p><div data-rows></div>`;
    leadReportDialog = { dialog, focus, context }; document.body.appendChild(dialog); dialog.showModal();
    const run = dialog.querySelector('[data-run]'), cancel = dialog.querySelector('[data-cancel]'), status = dialog.querySelector('[role="status"]'), rows = dialog.querySelector('[data-rows]');
    const period = dialog.querySelector('select'), warning = dialog.querySelector('[data-warning]');
    status.textContent = 'Choose a period and run the report.';
    dialog.querySelector('[data-storage]').textContent = leadStorageWarning;
    const date = (value, due = false) => {
      if (value === null || value === undefined || value === '') return ['—', ''];
      const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
      const parsed = new Date(dateOnly ? `${value}T11:00:00+08:00` : value);
      if (!Number.isFinite(parsed.getTime()) || dateOnly && parsed.toISOString().slice(0, 10) !== value) return ['—', ''];
      const options = { timeZone: 'Asia/Makassar' };
      const year = new Intl.DateTimeFormat('en-GB', { ...options, year: 'numeric' });
      const day = new Intl.DateTimeFormat('en-GB', { ...options, day: 'numeric', month: 'short', ...(year.format(parsed) !== year.format(new Date()) ? { year: 'numeric' } : {}) }).format(parsed);
      const hour = new Intl.DateTimeFormat('en-GB', { ...options, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(parsed);
      const fullDay = new Intl.DateTimeFormat('en-GB', { ...options, day: 'numeric', month: 'short', year: 'numeric' }).format(parsed);
      return [day, due ? hour : '', `${fullDay}, ${hour} WITA`];
    };
    const showWarnings = messages => {
      warning.title = messages.join('\n');
      const labels = messages.filter(message => message !== leadStorageWarning).map(message =>
        /task coverage/i.test(message) ? 'Task lookup failed.' : /Unresolved contact/i.test(message) ? 'Some contacts could not be checked.'
        : /timed out/i.test(message) ? 'Request timed out.' : /call/i.test(message) ? 'Call lookup failed.' : 'Report could not be completed.');
      warning.textContent = labels.length ? `${[...new Set(labels)].join(' ')} Results may be incomplete.` : '';
    };
    dialog.querySelector('[data-close]').onclick = closeLeadAccessReport; cancel.onclick = cancelLeadAccessReport;
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeLeadAccessReport(); });
    run.onclick = async () => {
      if (run.disabled) return;
      run.disabled = true; period.disabled = true; cancel.disabled = false; cancel.hidden = false; rows.replaceChildren(); showWarnings([]);
      try {
        const result = await runLeadAccessReport(Number(dialog.querySelector('select').value), message => { status.textContent = message; });
        if (leadReportDialog?.dialog !== dialog) return;
        if (!validLeadContext(context)) { closeLeadAccessReport(); return; }
        status.textContent = result.cancelled ? 'Report cancelled.' : `${result.rows.length} inaccessible · ${result.checked} checked`;
        if (!result.cancelled) showWarnings(result.warnings.length || result.complete ? result.warnings : ['Report incomplete.']);
        if (!result.rows.length) {
          if (result.complete && !result.cancelled) rows.textContent = 'No inaccessible contacts found.';
          return;
        }
        const table = document.createElement('table');
        table.innerHTML = '<thead><tr><th scope="col">Contact</th><th scope="col">Last call</th><th scope="col">Remembered follow-up</th><th scope="col">Due</th></tr></thead><tbody></tbody>';
        for (const row of result.rows) {
          const tr = document.createElement('tr'), contact = document.createElement('td'), lastCall = document.createElement('td'), tasks = document.createElement('td'), due = document.createElement('td');
          const link = document.createElement('a'), id = document.createElement('small');
          link.href = `/v2/location/${LOCATION_ID}/contacts/detail/${encodeURIComponent(row.id)}`;
          link.textContent = row.name?.trim() && row.name !== row.id ? row.name : 'Name unavailable';
          id.textContent = row.id; contact.append(link, id);
          const [callDay, , callDetails] = date(row.lastCall); lastCall.textContent = callDay;
          if (callDetails) lastCall.title = callDetails;
          for (const task of row.tasks) {
            const title = document.createElement('div'), deadline = document.createElement('div'), time = document.createElement('span');
            title.className = deadline.className = 'report-task'; title.textContent = task.title; title.title = task.title;
            const [day, hour, details] = date(task.due, true); deadline.textContent = day;
            time.className = 'report-time'; time.textContent = hour; deadline.appendChild(time);
            if (details) deadline.title = details;
            tasks.appendChild(title); due.appendChild(deadline);
          }
          if (!row.tasks.length) { tasks.textContent = '—'; due.textContent = '—'; }
          tr.append(contact, lastCall, tasks, due); table.querySelector('tbody').appendChild(tr);
        }
        rows.appendChild(table);
      } catch (error) { status.textContent = 'Report incomplete.'; showWarnings([error.message]); }
      finally { run.disabled = false; period.disabled = false; cancel.disabled = true; cancel.hidden = true; }
    };
    run.focus();
  }

  // Small DOM helpers. Selectors come from the recordings and inspected CRM UI.
  const visible = el => el && el.getClientRects().length > 0;
  const all = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
  const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const exact = (selector, label, root = document) => all(selector, root).find(el => text(el) === label);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const workflow = {
    busy: false, activeSaveProgress: null, guardedContact: null, guardedStageQueue: null,
    approvedActionContext: null, step: '', completed: [], pendingSave: '',
    pendingActions: {}, startingContact: '',
  };

  // Fixed phase labels and durations only: no names, IDs, credentials or message text.
  const WORKFLOW_TIMINGS_KEY = `pertama:workflow-timings:${LOCATION_ID}`;
  const NAVIGATION_TIMING_KEY = `pertama:navigation-timing:${LOCATION_ID}`;
  const workflowTimings = [];
  window.pertamaWorkflowTimings = workflowTimings;
  try {
    const saved = JSON.parse(sessionStorage.getItem(WORKFLOW_TIMINGS_KEY) || 'null');
    for (const row of Array.isArray(saved) ? saved.slice(-50) : []) {
      if (row && typeof row.action === 'string' && typeof row.phase === 'string'
        && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && typeof row.result === 'string') {
        const { action, phase, elapsedMs, result } = row;
        workflowTimings.push({ action, phase, elapsedMs, result });
      }
    }
  } catch { /* Timing history is optional. */ }
  let activeWorkflowTiming = null;
  function recordWorkflowTiming(action, phase, elapsedMs, result = 'ok') {
    workflowTimings.push({ action, phase, elapsedMs: Math.max(0, Math.round(elapsedMs)), result });
    if (workflowTimings.length > 50) workflowTimings.shift();
    try { sessionStorage.setItem(WORKFLOW_TIMINGS_KEY, JSON.stringify(workflowTimings)); }
    catch { /* In-memory measurements are enough if storage is unavailable. */ }
  }
  function startWorkflowTiming(action, phase) {
    const now = performance.now();
    activeWorkflowTiming = { action, phase, started: now, phaseStarted: now };
  }
  function markWorkflowTiming(phase) {
    if (!activeWorkflowTiming) return;
    const now = performance.now(), timing = activeWorkflowTiming;
    recordWorkflowTiming(timing.action, timing.phase, now - timing.phaseStarted);
    timing.phase = phase; timing.phaseStarted = now;
  }
  function finishWorkflowTiming(result) {
    if (!activeWorkflowTiming) return;
    const now = performance.now(), timing = activeWorkflowTiming;
    activeWorkflowTiming = null;
    recordWorkflowTiming(timing.action, timing.phase, now - timing.phaseStarted, result);
    recordWorkflowTiming(timing.action, 'Total', now - timing.started, result);
  }
  function recordNavigationReady() {
    try {
      const raw = sessionStorage.getItem(NAVIGATION_TIMING_KEY);
      if (!raw) return;
      let pending;
      try { pending = JSON.parse(raw); }
      catch { sessionStorage.removeItem(NAVIGATION_TIMING_KEY); return; }
      const elapsed = Date.now() - pending?.startedAt;
      if (!pending || typeof pending.contactId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(pending.contactId)
        || !Number.isFinite(pending.startedAt) || !Number.isFinite(pending.sourceTimeOrigin)
        || elapsed < 0 || elapsed > 120000) {
        sessionStorage.removeItem(NAVIGATION_TIMING_KEY); return;
      }
      // A visible toolbar in the source document is not a completed page load.
      if (pending.sourceTimeOrigin === performance.timeOrigin) return;
      if (!location.pathname.includes(`/location/${LOCATION_ID}/`) || pending.contactId !== contactId()) {
        sessionStorage.removeItem(NAVIGATION_TIMING_KEY); return;
      }
      if (!visible(document.getElementById('tb_business'))) return;
      sessionStorage.removeItem(NAVIGATION_TIMING_KEY);
      recordWorkflowTiming('Navigation', 'Contact toolbar visible', elapsed);
    } catch { /* Diagnostics must not interfere with the CRM or button placement. */ }
  }

  function contactId() {
    return location.pathname.match(/\/(?:contacts|customers)\/detail\/([^/]+)/)?.[1];
  }

  async function wait(find, description, observed = () => '', timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (workflow.guardedContact && contactId() !== workflow.guardedContact) {
        throw new Error(`Contact changed while waiting for ${description}. Expected ID: ${workflow.guardedContact}; current ID: ${contactId() || '(not on a contact page)'}.`);
      }
      if (workflow.guardedStageQueue && stageQueueContext()?.queue !== workflow.guardedStageQueue) {
        throw new Error(`Original stage queue changed while waiting for ${description}. Execution stopped.`);
      }
      const result = find();
      if (result) return result;
      await sleep(150);
    }
    const detail = observed();
    throw new Error(`Timed out after ${timeout / 1000}s waiting for: ${description}.${detail ? `\nObserved: ${detail}` : ''}`);
  }

  function checkpointKey(id) {
    return `pertama:no-answer:unfinished:${LOCATION_ID}:${id}`;
  }

  function clearContactCheckpoint(id) {
    if (workflow.busy || contactId() !== id || !location.pathname.includes(`/location/${LOCATION_ID}/`)) {
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
    if (workflow.busy || contactId() !== id || localStorage.getItem(key) !== original) {
      throw new Error('Contact or checkpoint changed. Nothing cleared.');
    }
    localStorage.removeItem(key);
    return true;
  }

  function resetJournalEvidence() {
    workflow.completed = [];
    workflow.pendingSave = '';
    workflow.pendingActions = {};
  }

  function restoreJournalEvidence(saved) {
    workflow.completed = saved.completed || [];
    workflow.pendingSave = saved.pendingSave || '';
    workflow.pendingActions = saved.pendingActions || {};
  }

  function appendJournalEvidence(description) {
    workflow.completed.push(description);
  }

  function setSmsSummary(description) {
    workflow.pendingSave = description;
    saveCheckpoint();
  }

  function clearSmsSummary() {
    const unresolved = workflow.pendingSave;
    workflow.pendingSave = '';
    try { saveCheckpoint(); } catch (error) { workflow.pendingSave = unresolved; throw error; }
  }

  function removeCompletedCheckpoint(id) {
    localStorage.removeItem(checkpointKey(id));
  }

  function saveCheckpoint() {
    localStorage.setItem(checkpointKey(workflow.startingContact), JSON.stringify({
      completed: workflow.completed, pendingSave: workflow.pendingSave, pendingActions: { ...workflow.pendingActions }, time: new Date().toISOString(),
    }));
  }

  function setPendingAction(operation, description) {
    const previous = { ...workflow.pendingActions }, previousSummary = workflow.pendingSave;
    if (description === null) delete workflow.pendingActions[operation];
    else workflow.pendingActions[operation] = description;
    workflow.pendingSave = Object.values(workflow.pendingActions).join('\n');
    try { saveCheckpoint(); }
    catch (error) {
      workflow.pendingActions = previous; workflow.pendingSave = previousSummary;
      if (workflow.approvedActionContext?.parallel) workflow.approvedActionContext.stopSaves = true;
      throw error;
    }
  }
  async function drainAll(promises) {
    const results = await Promise.allSettled(promises);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    return results.map(result => result.value);
  }
  function assertApprovedActionContext(expectedWrites = 0) {
    const context = workflow.approvedActionContext;
    // Only explicitly owned invalidations may overlap; any external mutation still fails closed.
    if (context && (contactId() !== context.contact || stageRouteRevision !== context.route
      || currentUserId !== context.user || identityExpires <= Date.now() / 1000
      || contactWritesPending !== (context.parallel ? context.ownedWritesPending : 0)
      || contactReadEpoch !== context.epoch + (context.parallel ? context.ownedEpoch : expectedWrites * 2))) {
      throw new Error('Contact, opportunity or session changed after confirmation. Further saves stopped; review the record before trying again.');
    }
  }
  function futureDate(days, now = Date.now()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Makassar', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
    return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day + days)).toISOString().slice(0, 10);
  }
  // datetime-local has no timezone: always interpret its wall-clock value as WITA (UTC+08:00).
  function taskDueInput(due) {
    return new Date(Date.parse(due) + 8 * 3600000).toISOString().slice(0, 16);
  }
  function taskDueFromInput(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
    const time = Date.parse(`${value}:00+08:00`);
    if (!Number.isFinite(time)) return null;
    const due = new Date(time).toISOString();
    return taskDueInput(due) === value ? due : null;
  }
  function taskDueLabel(due) {
    const local = taskDueInput(due), date = local.slice(0, 10);
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
    return `${date} ${weekday} at ${local.slice(11)} WITA`;
  }

  function progress(message) {
    markWorkflowTiming(message);
    workflow.step = message;
    runButton.textContent = workflow.activeSaveProgress ? message === 'Opening next lead…' ? message : 'Saving…' : message;
    workflow.activeSaveProgress?.phase(message);
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
    const opportunities = await readContactOpportunities();
    if (contactId() !== id || stageRouteRevision !== routeRevision) throw new Error('Contact changed before stage queue selection.');
    const choices = new Map();
    for (const opportunity of opportunities) {
      const pipeline = NAV_PIPELINES.find(p => p.id === opportunity.pipelineId);
      if (pipeline) choices.set(opportunity.id, pipeline);
    }
    if (!choices.size) throw new Error('Pipeline metadata is unavailable. Open the Opportunities board first.');
    const origin = readOrigin(id);
    const inferred = origin ? opportunities.find(item => item.id === origin.opportunityId)
      : opportunities.length === 1 ? opportunities[0] : null;
    if (origin && (!inferred || (origin.pipelineId ? origin.pipelineId !== inferred.pipelineId
      : origin.pipeline !== choices.get(inferred.id)?.name))) {
      throw new Error('Original opportunity/pipeline could not be verified. Reopen the contact from its pipeline board.');
    }
    if (inferred) {
      pinStageQueue({ contactId: id, opportunityId: inferred.id, pipelineId: inferred.pipelineId, stageId: inferred.pipelineStageId });
      return stageQueueContext();
    }
    markWorkflowTiming('Awaiting queue selection…');
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
      opportunity.value = choices.size === 1 ? choices.keys().next().value : '';
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
    markWorkflowTiming('Checking stage queue…');
    if (!selected) return null;
    if (contactId() !== id || stageRouteRevision !== routeRevision || !location.pathname.includes(`/location/${LOCATION_ID}/`)) throw new Error('Contact changed during stage queue selection. Nothing saved.');
    pinStageQueue(selected);
    return stageQueueContext();
  }

  async function nextLead() {
    if (workflow.busy) return;
    workflow.busy = true;
    nextButton.disabled = true;
    let timingResult = 'ok';
    startWorkflowTiming('Next lead', 'Checking navigation context');
    try {
      requireContactControlsReady();
      if (!location.pathname.includes(`/location/${LOCATION_ID}/`)) throw new Error('Open the Pertama account first.');
      if (settings.priority === 'stage' && !await ensureStageQueue()) { timingResult = 'cancelled'; return; }
      markWorkflowTiming('Finding next lead');
      const lead = await findNextActionable();
      if (lead) { await openLead(lead); timingResult = 'navigating'; }
      else taskNotice(emptyQueueMessage());
    } catch (error) {
      timingResult = 'stopped';
      console.error(`[Pertama Next lead v${VERSION}]`, error);
      taskNotice(`Next lead stopped: ${error.message} No records were changed.`, true);
    } finally {
      finishWorkflowTiming(timingResult);
      workflow.busy = false;
      nextButton.disabled = false;
      nextButton.textContent = nextLeadLabel();
    }
  }

  function requireCallTaskContext(context) {
    if (context.approval) {
      if (context.approval !== workflow.approvedActionContext) throw new Error('Call task approval changed.');
      assertApprovedActionContext();
    }
    if ((!context.approval && !validContactRead(context)) || stageRouteRevision !== context.route
      || settings.task !== context.template || !liveReadHeaders
      || userFromHeaders(liveReadHeaders).id !== context.user) {
      throw new Error('Call task context changed.');
    }
    requireContactControlsReady();
  }

  function callTaskTitle(contact, template) {
    const firstName = contact.firstName.trim();
    const name = [firstName, contact.lastName.trim()].filter(Boolean).join(' ');
    if (!name) throw new Error('Contact name is empty.');
    return renderTemplate(template, { firstName, name }).replace(/\s+/g, ' ').trim();
  }

  async function readCallTasks(context) {
    requireCallTaskContext(context);
    const data = await crmRequest('POST', '/objects/task/records/search', {
      filters: [{ group: 'OR', filters: [{ field: 'relations.TASK_CONTACT_ASSOCIATION', operator: 'eq', value: [context.id] }] }],
      locationId: LOCATION_ID, sort: [{ field: 'properties.dueDate', direction: 'desc' }],
      pageLimit: 20, includeRecurringTaskConfigs: true, ignoreAssignedToPermission: true, page: 1, query: '',
    });
    requireCallTaskContext(context);
    const rows = data.customObjectRecords;
    if (!Array.isArray(rows) || !Number.isInteger(data.total) || data.total < rows.length) throw new Error('Task lookup is incomplete.');
    const ids = new Set();
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(row.id) || ids.has(row.id)
        || row.locationId !== LOCATION_ID || row.objectKey !== 'task'
        || typeof row.properties?.title !== 'string' || ![0, 1, false, true].includes(row.properties.completed)
        || !Array.isArray(row.relations)) throw new Error('Task record is invalid.');
      ids.add(row.id);
      const contacts = row.relations.filter(r => r?.associationId === 'TASK_CONTACT_ASSOCIATION' || r?.objectKey === 'contact');
      if (contacts.length !== 1 || contacts[0].associationId !== 'TASK_CONTACT_ASSOCIATION'
        || contacts[0].objectKey !== 'contact' || contacts[0].recordId !== context.id
        || typeof contacts[0].relationId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(contacts[0].relationId)) {
        throw new Error('Task contact association is invalid.');
      }
    }
    return { rows, total: data.total };
  }

  // Dedicated task completion write: never widen the read-only transport or use stage/note/task approval.
  async function putCallTask(context, taskId) {
    requireCallTaskContext(context);
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error('Invalid task ID.');
    const diagnostic = { method: 'PUT', url: `https://services.leadconnectorhq.com/locations/${LOCATION_ID}/tasks/bulk/update`,
      started: new Date().toISOString(), status: null, result: 'pending', requestFields: ['completed', 'ids'] };
    recordRequest(diagnostic);
    const controller = new AbortController(), started = Date.now();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      requireCallTaskContext(context);
      workflow.activeSaveProgress?.dispatched('complete');
      const response = await originalFetch.call(window, diagnostic.url, {
        method: 'PUT', headers: { ...CRM_HEADERS, 'content-type': 'application/json',
          developer_version: '', ...liveReadHeaders },
        redirect: 'error', body: JSON.stringify({ completed: true, ids: [taskId] }), signal: controller.signal,
      });
      diagnostic.status = response.status;
      if (!response.ok) {
        if ([401, 403].includes(response.status)) rejectCrmAuthorization();
        throw new Error('Completion HTTP response rejected.');
      }
      const data = await response.json();
      if (data?.succeded !== true || data.error || data.errors?.length) throw new Error('Completion acknowledgment missing.');
      diagnostic.result = 'completion accepted';
      completeRememberedLeadTask(context.id, taskId, { user: context.user });
      // Preserve known acceptance even if navigation/session changed while the request was in flight.
      appendJournalEvidence(`Call task completion accepted: ${taskId}; readback not yet verified.`);
      saveCheckpoint();
      requireCallTaskContext(context);
    } catch (error) {
      if (diagnostic.result !== 'completion accepted') diagnostic.result = error?.name === 'AbortError' ? 'timeout' : 'completion unverified';
      throw new Error('Call task completion is unverified.');
    } finally {
      diagnostic.elapsedMs = Date.now() - started;
      clearTimeout(timeout);
    }
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

  async function prepareCallTask(id) {
    requireContactControlsReady();
    const context = { ...contactReadContext(), route: stageRouteRevision, template: settings.task };
    if (context.id !== id) throw new Error('Contact changed before task lookup.');
    requireCallTaskContext(context);
    const [contact, lookup] = await drainAll([readContactDetails({ fresh: true }), readCallTasks(context)]);
    requireCallTaskContext(context);
    const title = callTaskTitle(contact, context.template);
    const matchesTitle = row => row.properties.title.replace(/\s+/g, ' ').trim() === title;
    const task = lookup.rows.find(row => matchesTitle(row) && [0, false].includes(row.properties.completed));
    if (!task) {
      if (lookup.total > lookup.rows.length) throw new Error('More tasks exist beyond the lookup.');
      return { context, contact, title, task: null };
    }
    const [fresh, latest] = await drainAll([readContactDetails({ fresh: true }), readCallTasks(context)]);
    requireCallTaskContext(context);
    if (['id', 'locationId', 'firstName', 'lastName', 'assignedTo'].some(key => contact[key] !== fresh[key])
      || callTaskTitle(fresh, context.template) !== title) throw new Error('Contact changed before completion.');
    const target = latest.rows.find(row => row.id === task.id);
    if (!target || !matchesTitle(target) || ![0, false].includes(target.properties.completed)
      || target.relations.find(r => r.associationId === 'TASK_CONTACT_ASSOCIATION').relationId
        !== task.relations.find(r => r.associationId === 'TASK_CONTACT_ASSOCIATION').relationId) throw new Error('Task changed before completion.');
    return { context, contact: fresh, title, task };
  }
  async function completeCallTask(id, { fromSaveAndNext = false, prepared = null } = {}) {
    if (workflow.busy && !fromSaveAndNext) {
      console.info('Call-task completion skipped: another script action is running.');
      return;
    }
    if (!fromSaveAndNext) {
      workflow.busy = true;
      workflow.guardedContact = id;
    }
    let attempted = false;
    let phase = 'checking contact/session and unfinished actions';
    try {
      requireContactControlsReady();
      if (!fromSaveAndNext && localStorage.getItem(checkpointKey(id))) {
        taskNotice('Call task stopped: an unfinished action already exists. Inspect the CRM record, then use Settings to clear its checkpoint. No automatic retry.', true);
        return;
      }
      if (!fromSaveAndNext) {
        resetJournalEvidence();
        workflow.startingContact = id;
      }
      phase = 'reading and rechecking the current contact and exact pending task';
      const { context, title, task } = prepared || await prepareCallTask(id);
      requireCallTaskContext(context);
      if (!task) return;
      const matchesTitle = row => row.properties.title.replace(/\s+/g, ' ').trim() === title;
      phase = 'saving the completion checkpoint';
      if (!fromSaveAndNext && localStorage.getItem(checkpointKey(id))) throw new Error('An unfinished action appeared.');
      if (workflow.approvedActionContext?.stopSaves || workflow.pendingSave && !context.approval) throw new Error('An unresolved save exists or saving was stopped.');
      setPendingAction('complete', `Complete Call task ${task.id}: ${task.properties.title}`); // Persist before PUT.
      requireCallTaskContext(context);
      phase = 'sending task completion or verifying its acknowledgment';
      attempted = true;
      await putCallTask(context, task.id);
      workflow.activeSaveProgress?.start('complete', 'Verifying…');
      requireCallTaskContext(context);
      phase = 'verifying the completed task by its exact ID';
      let verified = false;
      for (let check = 0; check < 3; check++) {
        if (check && fromSaveAndNext) await sleep(check * 500);
        const result = await readCallTasks(context);
        requireCallTaskContext(context);
        const saved = result.rows.find(row => row.id === task.id);
        if (saved && matchesTitle(saved) && [1, true].includes(saved.properties.completed)
          && saved.relations.find(r => r.associationId === 'TASK_CONTACT_ASSOCIATION').relationId
            === task.relations.find(r => r.associationId === 'TASK_CONTACT_ASSOCIATION').relationId) {
          verified = true;
          break;
        }
      }
      if (!verified) throw new Error('Task completion readback unavailable.');
      appendJournalEvidence(`Call task completed and verified: ${task.id}: ${title}`);
      workflow.activeSaveProgress?.confirm('complete');
      setPendingAction('complete', null);
      requireCallTaskContext(context);
      if (!fromSaveAndNext) {
        removeCompletedCheckpoint(id);
        taskNotice(`Completed: ${title}`);
      }
    } catch {
      // Never surface arbitrary native/network errors, which can include credentials or response data.
      console.error('Pertama call task stopped', { phase, attempted });
      if (fromSaveAndNext) throw new Error(`Call task stopped while ${phase}. ${attempted
        ? 'Completion may already be saved; inspect the task before clearing the checkpoint.'
        : 'No task completion was sent.'} No automatic retry.`);
      taskNotice(`Call task stopped while ${phase}. ${attempted
        ? 'Completion may already be saved. Inspect the task and unfinished-action checkpoint before clearing it in Settings.'
        : 'No task completion was sent. Check the contact, session and task data before trying again.'} No automatic retry. The native call was not blocked.`, true);
    } finally {
      if (attempted) {
        if (fromSaveAndNext && workflow.approvedActionContext?.parallel) workflow.approvedActionContext.ownedEpoch++;
        invalidateContactReads();
      }
      if (!fromSaveAndNext) {
        workflow.guardedContact = null;
        workflow.busy = false;
      }
    }
  }

  function canonicalSmsPhone(value) {
    const number = typeof value === 'string' ? value.replace(/[\s()-]/g, '') : '';
    if (!/^\+[1-9]\d{6,14}$/.test(number)) throw new Error('A valid international SMS phone number is required.');
    return number;
  }
  function guardSmsRead(context) {
    if (!validContactRead(context) || context.route !== stageRouteRevision || context.path !== location.pathname
      || !liveReadHeaders || userFromHeaders(liveReadHeaders).id !== context.user) throw new Error('SMS contact/account/session changed.');
  }
  // Closed endpoint inventory: no arbitrary URL or native draft writes.
  async function smsApiRequest(operation, context, sms) {
    const reading = operation === 'inventory' || operation === 'drafts';
    const guard = () => reading ? guardSmsRead(context) : requireActionApproval('sms', context);
    guard();
    let path, body, diagnosticPath;
    if (operation === 'inventory') {
      path = `/phone-system/numbers/v2/location/${LOCATION_ID}?includeRcsSenderIds=true`;
      diagnosticPath = '/phone-system/numbers/v2/location/{location}';
    } else if (operation === 'drafts') {
      path = `/conversations/messages/drafts/${LOCATION_ID}/contacts/${context.id}`;
      diagnosticPath = '/conversations/messages/drafts/{location}/contacts/{id}';
    } else if (operation === 'spam' || operation === 'send') {
      if (!sms || ['from', 'to', 'message'].some(key => sms[key] !== context.sms?.[key])) throw new Error('SMS approval changed.');
      path = operation === 'spam' ? '/conversations/messages/spam/v2' : '/conversations/messages';
      diagnosticPath = path;
      body = operation === 'spam' ? { text: sms.message, locationId: LOCATION_ID, contactId: context.contact }
        : { contactId: context.contact, locationId: LOCATION_ID, message: sms.message, fromNumber: sms.from,
          toNumber: sms.to, type: 'SMS', channel: 'sms', fromOneToOneConversation: true, attachments: [] };
    } else throw new Error('SMS operation is not permitted.');
    const method = body ? 'POST' : 'GET';
    const diagnostic = { method, url: `https://services.leadconnectorhq.com${diagnosticPath}`, status: null, result: 'pending' };
    recordRequest(diagnostic);
    const controller = new AbortController(), started = Date.now();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      guard();
      if (operation === 'send') workflow.activeSaveProgress?.dispatched('sms');
      const response = await originalFetch.call(window, `https://services.leadconnectorhq.com${path}`, {
        method, headers: { ...CRM_HEADERS, ...liveReadHeaders, ...(body ? { 'content-type': 'application/json' } : {}) },
        redirect: 'error', cache: 'no-store', signal: controller.signal, ...(body ? { body: JSON.stringify(body) } : {}),
      });
      diagnostic.status = response.status;
      if ([401, 403].includes(response.status)) rejectCrmAuthorization();
      if (!response.ok) throw new Error('HTTP failure');
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || data.errors?.length) throw new Error('Invalid response');
      diagnostic.result = 'response received';
      // Send acknowledgment must be journaled by the caller before its post-await guard.
      if (reading || operation === 'spam') guard();
      return data;
    } catch (error) {
      diagnostic.result = error.name === 'AbortError' ? 'timeout' : 'response rejected';
      throw new Error(`API SMS ${operation}: ${error.name === 'AbortError' ? 'Timed out after 30 seconds' : diagnostic.status ? `HTTP ${diagnostic.status}; response not verified` : 'No verified HTTP response'}. No automatic retry.`);
    } finally { clearTimeout(timeout); diagnostic.elapsedMs = Date.now() - started; }
  }
  async function prepareSmsApi() {
    const context = { ...contactReadContext(), route: stageRouteRevision, path: location.pathname };
    guardSmsRead(context);
    let contact;
    try { contact = await readContactDetails({ fresh: true }); }
    catch { throw new Error('SMS contact lookup failed. No automatic retry.'); }
    guardSmsRead(context);
    const to = canonicalSmsPhone(contact.phone);
    const reads = await Promise.allSettled([smsApiRequest('inventory', context), smsApiRequest('drafts', context)]);
    guardSmsRead(context);
    const failure = reads.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    const inventory = reads[0].value, drafts = reads[1].value;
    if (!Array.isArray(inventory.numbers) || !Number.isSafeInteger(inventory.total) || inventory.total !== inventory.numbers.length
      || !Array.isArray(drafts.drafts)) throw new Error('SMS inventory or draft lookup is incomplete.');
    const seen = new Set(), fromNumbers = [];
    for (const record of inventory.numbers) {
      const number = canonicalSmsPhone(record?.phoneNumber);
      if (seen.has(number) || record.linkedUser != null && typeof record.linkedUser !== 'string'
        || record.capabilities != null && (typeof record.capabilities !== 'object' || Array.isArray(record.capabilities))
        || record.isDefaultNumber != null && typeof record.isDefaultNumber !== 'boolean'
        || record.isDisabled != null && typeof record.isDisabled !== 'boolean'
        || record.status != null && typeof record.status !== 'string') throw new Error('Malformed or duplicate SMS inventory number.');
      seen.add(number);
      if (record.capabilities?.sms !== true || record.isDisabled === true || record.status === 'disabled') continue;
      if (record.linkedUser !== context.user) continue;
      fromNumbers.push({ number, label: number });
    }
    const from = fromNumbers.length === 1 ? fromNumbers[0].number
      : fromNumbers.some(item => item.number === settings.smsFrom) ? settings.smsFrom : null;
    return { contact, to, from, fromNumbers, savedDraftCount: drafts.drafts.length };
  }
  const smsAttempts = new WeakSet();
  async function sendSmsApi() {
    const context = requireActionApproval('sms');
    if (workflow.pendingSave || smsAttempts.has(context)) throw new Error('SMS already attempted or an unresolved save exists. No retry.');
    const sms = { ...context.sms };
    if (canonicalSmsPhone(sms.from) !== sms.from || canonicalSmsPhone(sms.to) !== sms.to
      || typeof sms.message !== 'string' || !sms.message.trim()) throw new Error('Explicit SMS sender, recipient and message approval are required.');
    // Reserve the approval before any await, also preventing concurrent sends.
    smsAttempts.add(context);
    const fresh = await prepareSmsApi();
    requireActionApproval('sms', context);
    if (['id', 'locationId', 'firstName', 'lastName', 'phone'].some(key => fresh.contact[key] !== context.contactRecord[key])
      || !context.parallel && fresh.contact.assignedTo !== context.contactRecord.assignedTo
      || fresh.to !== sms.to || fresh.from !== sms.from) throw new Error('SMS contact or sender changed after confirmation.');
    const spam = await smsApiRequest('spam', context, sms);
    requireActionApproval('sms', context);
    if (spam.isSpam !== false) throw new Error('SMS spam preflight did not approve the message.');
    if (workflow.pendingSave) throw new Error('An unresolved save exists. No retry.');
    setSmsSummary(`SMS from ${sms.from} to ${sms.to}; message: ${sms.message}; acceptance not yet confirmed`);
    const acknowledgment = await smsApiRequest('send', context, sms);
    if (!safeActionId(acknowledgment.conversationId) || !safeActionId(acknowledgment.messageId)) throw new Error('SMS acknowledgment is unverified. No retry.');
    const identity = `SMS message ${acknowledgment.messageId}; conversation ${acknowledgment.conversationId}`;
    appendJournalEvidence(`${identity}: accepted by CRM; delivery not confirmed.`);
    workflow.activeSaveProgress?.confirm('sms');
    setSmsSummary(`${identity}: accepted; workflow continuation not yet approved`);
    requireActionApproval('sms', context);
    clearSmsSummary();
    requireActionApproval('sms', context);
    const notice = `SMS to ${sms.to}: accepted by CRM; delivery not confirmed.`;
    try {
      taskNotice(notice);
      const savedNotice = JSON.stringify({ message: notice, time: Date.now() });
      sessionStorage.setItem(SMS_NOTICE_KEY, savedNotice);
      setTimeout(() => {
        if (sessionStorage.getItem(SMS_NOTICE_KEY) === savedNotice) sessionStorage.removeItem(SMS_NOTICE_KEY);
      }, 7000);
    } catch { /* Notification failures never authorize another send. */ }
  }

  function createSaveProgress({ name, pipelineName, choices }) {
    document.getElementById('pertama-save-progress')?.remove();
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.id = 'pertama-save-progress';
    dialog.setAttribute('aria-labelledby', 'pertama-save-progress-title');
    dialog.style.cssText = 'width:min(420px,calc(100vw - 32px));max-height:85vh;overflow:auto;border:1px solid #e4e7ec;border-radius:16px;padding:18px 20px;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#182230;background:#fff';
    dialog.innerHTML = `<style>
      #pertama-save-progress::backdrop{background:#10182866}
      #pertama-save-progress h2{margin:0;font-size:19px;line-height:1.3}
      #pertama-save-progress [data-contact]{margin:4px 0 10px;color:#667085;font-size:13px;overflow-wrap:anywhere}
      #pertama-save-progress [data-action]{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #eaecf0}
      #pertama-save-progress [data-action]:last-child{border-bottom:0}
      #pertama-save-progress [data-icon]{color:#667085;display:inline-block;flex:0 0 18px}
      #pertama-save-progress [data-state=running] [data-icon]{color:#155eef;animation:pertama-save-spin 1s linear infinite}
      #pertama-save-progress [data-state=confirmed] [data-icon]{color:#067647}
      #pertama-save-progress [data-state=unverified] [data-icon]{color:#b54708}
      #pertama-save-progress [data-state=failed] [data-icon]{color:#b42318}
      #pertama-save-progress small{display:block;margin-top:1px;color:#667085;font-size:12px;line-height:1.35}
      #pertama-save-progress .visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
      #pertama-save-progress [data-report]{margin-top:12px;padding-top:12px;border-top:1px solid #eaecf0;white-space:pre-wrap;overflow-wrap:anywhere}
      #pertama-save-progress button{padding:8px 16px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;font:inherit;cursor:pointer}
      @keyframes pertama-save-spin{to{transform:rotate(360deg)}}
      @media(prefers-reduced-motion:reduce){#pertama-save-progress [data-icon]{animation:none!important}}
      </style><h2 id="pertama-save-progress-title" tabindex="-1">Preparing actions…</h2><p data-contact></p><div data-live class="visually-hidden" role="status" aria-live="polite"></div><div data-rows></div><section data-report hidden aria-label="Stopped save details"></section><button type="button" data-close hidden>Close</button>`;
    dialog.querySelector('[data-contact]').textContent = `${name} · ${pipelineName}`;
    const rows = new Map(), container = dialog.querySelector('[data-rows]');
    const labels = { stage: 'Stage', note: 'Note', complete: 'Existing Call task', task: 'Follow-up task', sms: 'SMS' };
    let stopped = false;
    const announce = message => { dialog.querySelector('[data-live]').textContent = message; };
    function render(row) {
      row.el.dataset.state = row.state;
      row.el.querySelector('[data-icon]').textContent = { waiting: '○', skipped: '–', running: '◌', confirmed: '✓', unverified: '⚠', failed: '×', blocked: '–' }[row.state];
      row.el.querySelector('small').textContent = row.detail;
      announce(`${labels[row.key]}: ${row.detail}`);
    }
    for (const key of ['stage', 'note', 'complete', 'task', 'sms']) {
      const el = document.createElement('div'); el.dataset.action = key;
      el.innerHTML = '<span data-icon aria-hidden="true"></span><div><strong></strong><small></small></div>';
      el.querySelector('strong').textContent = labels[key];
      const selected = key === 'complete' || choices[key];
      const row = { key, el, state: selected ? 'waiting' : 'skipped', detail: selected ? 'Checking' : 'Skipped', dispatched: new Set(), created: false };
      rows.set(key, row);
      container.appendChild(el);
      render(row);
    }
    function remove() { if (dialog.open) dialog.close(); dialog.remove(); }
    function close() { remove(); (previousFocus?.isConnected ? previousFocus : runButton)?.focus(); }
    dialog.querySelector('[data-close]').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (stopped) close(); });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    function show() { if (!dialog.isConnected) document.body.append(dialog); if (!dialog.open) dialog.showModal(); dialog.querySelector('h2').focus(); }
    function start(key, detail = 'Saving…') {
      const row = rows.get(key); if (!row || row.state === 'confirmed') return;
      row.state = 'running'; row.detail = detail; render(row);
    }
    show();
    return {
      start,
      skip(key) { const row = rows.get(key); if (!row || row.state !== 'waiting') return; row.state = 'skipped'; row.detail = 'Skipped'; render(row); },
      dispatched(key, operation = key) { rows.get(key)?.dispatched.add(operation); },
      created() { const row = rows.get('task'); if (row) { row.created = true; start('task', 'Linking to contact…'); } },
      confirm(key) { const row = rows.get(key); if (!row) return; row.state = 'confirmed'; row.detail = key === 'sms' ? 'Accepted by CRM; delivery not confirmed' : 'Confirmed'; render(row); },
      fail(key) {
        const row = rows.get(key); if (!row || row.state === 'confirmed') return;
        row.state = row.dispatched.size ? 'unverified' : 'failed';
        row.detail = row.created ? row.dispatched.has('link') ? 'Created; contact link unverified. Inspect the record.' : 'Created; contact link not sent. Inspect the record.'
          : row.dispatched.size ? 'May already be saved. Inspect the record.' : 'Stopped before saving';
        render(row);
      },
      phase(message) { dialog.querySelector('h2').textContent = message === 'Opening next lead…' ? message : /Rechecking|Preflighting/.test(message) ? 'Preparing actions…' : 'Saving actions'; announce(message); },
      stop(report) {
        stopped = true;
        for (const row of rows.values()) if (['waiting', 'running'].includes(row.state)) { row.state = 'blocked'; row.detail = 'Not run'; render(row); }
        dialog.querySelector('h2').textContent = 'Execution stopped';
        const details = dialog.querySelector('[data-report]'); details.textContent = report; details.hidden = false;
        dialog.querySelector('[data-close]').hidden = false;
        announce('Execution stopped. Results are ready to inspect.'); show();
      }, remove,
    };
  }

  function confirmActions({ contact, name, firstName, phone, stage, rule, ownerId, taskTitle, pipelineName, stageOptions }, onConfirm = null) {
    return new Promise(resolve => {
      let closed = false, sms = null, smsLoading = false, smsError = '', smsLoadVersion = 0;
      const confirmationUser = currentUserId, confirmationRoute = stageRouteRevision, openedAt = Date.now();
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
          #pertama-confirm-actions .task-schedule{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-top:6px}
          #pertama-confirm-actions .task-schedule label{display:flex;align-items:center;gap:6px;max-width:100%;white-space:nowrap}
          #pertama-confirm-actions .task-schedule input{min-width:0;margin:0;padding:6px 8px;border:1px solid #d0d5dd;border-radius:8px;font:inherit;color:inherit;background:#fff}
          #pertama-confirm-actions input[name=taskDays]{width:60px}
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
            <section><label class="toggle">Add task<span class="switch"><input name="task" type="checkbox" role="switch"><span class="track"></span></span></label><div class="detail task-schedule"><label data-task-days>In <input name="taskDays" type="number" min="0" max="36500" step="1" aria-label="Follow up in days" title="0 or blank = 3 hours later" aria-describedby="pertama-task-days-help">days</label><label><input name="taskDue" type="datetime-local" step="60" aria-label="Scheduled for (WITA)">WITA</label></div><span id="pertama-task-days-help" hidden>0 or blank = 3 hours later</span><p class="detail" data-task></p></section>
            <section><label class="toggle">Send SMS<span class="switch"><input name="sms" type="checkbox" role="switch"><span class="track"></span></span></label><p class="detail" data-recipient></p><p class="detail" data-sms-status></p><div data-sms-templates hidden style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0" aria-label="SMS templates"></div><textarea name="smsText" aria-label="SMS message" placeholder="Write your message…" rows="7" disabled hidden></textarea></section>
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
      if (!rule.next) dialog.querySelector('[data-stage]').textContent += ' · No rule for this stage. Stage update is off by default; choose a destination to turn it on.';
      else if (!stageOptions.includes(rule.next)) dialog.querySelector('[data-stage]').textContent += ` · Suggested stage ${rule.next} is unavailable; choose a destination to update.`;
      field('taskDays').value = rule.days == null ? '' : String(rule.days);
      function daysDue() {
        const days = Number(field('taskDays').value.trim());
        if (field('taskDays').validity.badInput || !Number.isSafeInteger(days) || days < 0 || days > 36500) return null;
        return days === 0 ? new Date(Math.floor(openedAt / 60000) * 60000 + 3 * 3600000).toISOString()
          : `${futureDate(days, openedAt)}T03:00:00.000Z`;
      }
      function updateTaskDate() {
        const due = taskDueFromInput(field('taskDue').value);
        field('taskDays').setCustomValidity(daysDue() ? '' : 'Enter whole days from 0 to 36500, or leave blank for 3 hours later.');
        field('taskDue').setCustomValidity(due ? '' : 'Choose a valid date and time in WITA.');
        dialog.querySelector('[data-task]').textContent = !ownerId ? 'No valid contact owner assigned. Task creation is unavailable.'
          : due ? taskTitle : 'Choose a valid date and time in WITA.';
      }
      function resetTaskDate() {
        const due = daysDue();
        field('taskDue').value = due ? taskDueInput(due) : '';
        updateTaskDate();
      }
      field('taskDays').addEventListener('input', resetTaskDate);
      field('taskDue').addEventListener('input', updateTaskDate);
      resetTaskDate();
      dialog.querySelector('[data-recipient]').textContent = `To: ${name}${phone ? ` · ${phone}` : ''}`;
      field('sms').checked = rule.sendSms === true;
      async function loadSmsOptions() {
        const version = ++smsLoadVersion;
        sms = null; smsError = ''; smsLoading = true;
        updateFields();
        try {
          const prepared = await prepareSmsApi();
          if (closed || version !== smsLoadVersion || !field('sms').checked) return;
          if (contactId() !== contact.id || currentUserId !== confirmationUser || stageRouteRevision !== confirmationRoute
            || ['id', 'locationId', 'firstName', 'lastName', 'phone', 'assignedTo'].some(key => prepared.contact[key] !== contact[key])) {
            throw new Error('Contact or session changed while loading SMS options. Reopen confirmation.');
          }
          if (!prepared.from) throw new Error('Choose your SMS sender in Workflow settings before sending.');
          sms = prepared;
          dialog.querySelector('[data-recipient]').textContent = `To: ${name} · ${sms.to}`;
        } catch (error) {
          if (!closed && version === smsLoadVersion) { sms = null; smsError = error.message || 'SMS options unavailable.'; }
        } finally {
          if (!closed && version === smsLoadVersion) { smsLoading = false; updateFields(); }
        }
      }
      field('sms').addEventListener('change', () => {
        if (field('sms').checked) void loadSmsOptions();
        else { smsLoadVersion++; sms = null; smsLoading = false; smsError = ''; updateFields(); }
      });
      const defaultSmsTemplate = settings.smsTemplates.find(template => template.id === rule.smsTemplateId)
        || settings.smsTemplates.find(template => template.id === 'default');
      field('smsText').value = renderTemplate(defaultSmsTemplate.message, { firstName, name });
      const templateButtons = dialog.querySelector('[data-sms-templates]');
      for (const template of settings.smsTemplates) {
        const button = document.createElement('button'); button.type = 'button';
        button.dataset.useSmsTemplate = template.id;
        button.textContent = template.name + (template.id === defaultSmsTemplate.id ? ' (default)' : '');
        button.addEventListener('click', () => {
          field('smsText').value = renderTemplate(template.message, { firstName, name });
          field('smsText').setCustomValidity('');
          field('smsText').focus();
        });
        templateButtons.appendChild(button);
      }
      dialog.querySelector('[data-next]').textContent = settings.priority === 'stage'
        ? `After saving — ${stageQueueLabel()}. No other queues or tasks will be used.`
        : 'After saving: open the next lead using your selected pipelines and lead priority.';
      field('note').checked = rule.addNote !== false;
      field('noteText').value = renderTemplate(settings.note, { firstName, name });
      field('task').checked = (rule.addTask ?? rule.days != null) && Boolean(ownerId);
      field('task').disabled = !ownerId;
      function updateFields() {
        field('targetStage').disabled = !field('stage').checked;
        field('taskDays').disabled = !field('task').checked || field('task').disabled;
        field('taskDue').disabled = field('taskDays').disabled;
        field('taskDue').required = !field('taskDue').disabled;
        updateTaskDate();
        field('noteText').disabled = !field('note').checked;
        field('noteText').required = field('note').checked;
        const enabled = field('sms').checked;
        templateButtons.hidden = !enabled;
        field('smsText').hidden = !enabled;
        field('smsText').disabled = !enabled;
        field('smsText').required = enabled;
        form.querySelector('[type="submit"]').disabled = enabled && (smsLoading || !sms);
        dialog.querySelector('[data-sms-status]').textContent = !enabled
          ? 'SMS details load only when enabled.'
          : smsLoading ? 'Loading SMS sender options…'
          : smsError ? `${smsError} Turn SMS off to continue with other actions.`
          : sms ? `From: ${sms.from}. Native drafts are kept untouched (${sms.savedDraftCount} saved). This sends a separate message once; delivery is not guaranteed.`
          : 'SMS options are unavailable.';
      }
      function finish(result) {
        if (closed) return;
        closed = true;
        smsLoadVersion++;
        if (result) onConfirm?.(result);
        dialog.close();
        dialog.remove();
        if (!result || !onConfirm) previousFocus?.focus();
        resolve(result);
      }
      form.addEventListener('change', updateFields);
      dialog.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (field('sms').checked && (smsLoading || !sms)) return;
        const taskSelected = field('task').checked && !field('task').disabled;
        updateTaskDate();
        const selectedDue = taskSelected ? taskDueFromInput(field('taskDue').value) : null;
        const targetStage = field('targetStage').value;
        field('targetStage').setCustomValidity(field('stage').checked && !stageOptions.includes(targetStage) ? 'Choose an available stage.' : '');
        const noteText = field('noteText').value.trim();
        const smsText = field('smsText').value.trim();
        field('smsText').setCustomValidity(field('sms').checked && !smsText ? 'Enter a message or turn Send SMS off.' : '');
        field('noteText').setCustomValidity(field('note').checked && !noteText ? 'Enter a note or turn Add note off.' : '');
        if (!form.reportValidity()) return;
        finish({ stage: field('stage').checked, targetStage, note: field('note').checked,
          task: taskSelected, due: selectedDue, noteText,
          sms: field('sms').checked, smsText, smsFrom: sms?.from, smsTo: sms?.to });
      });
      field('targetStage').addEventListener('change', () => field('targetStage').setCustomValidity(''));
      field('noteText').addEventListener('input', () => field('noteText').setCustomValidity(''));
      field('smsText').addEventListener('input', () => field('smsText').setCustomValidity(''));
      dialog.addEventListener('keydown', event => event.stopPropagation());
      updateFields();
      document.body.appendChild(dialog);
      dialog.showModal();
      dialog.querySelector('[data-cancel]').focus();
      if (field('sms').checked) void loadSmsOptions();
    });
  }

  // One procedural sequence. Nothing runs until the user presses the button.
  async function readActionContext(options = {}) {
    const results = await Promise.allSettled([readContactDetails(options), readContactOpportunities(options)]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const contact = results[0].value, opportunities = results[1].value;
    const origin = readOrigin(contact.id);
    const opportunity = origin ? opportunities.find(item => item.id === origin.opportunityId)
      : opportunities.length === 1 ? opportunities[0] : null;
    if (!opportunity) throw new Error('Original opportunity is not unique. Open the contact from its pipeline board or choose a stage queue. Nothing saved.');
    const pipeline = NAV_PIPELINES.find(p => p.id === opportunity.pipelineId);
    if (!pipeline || origin && (origin.pipelineId ? origin.pipelineId !== pipeline.id : origin.pipeline !== pipeline.name)) {
      throw new Error('Original opportunity/pipeline could not be verified. Nothing saved.');
    }
    const stage = Object.keys(pipeline.stages).find(name => pipeline.stages[name] === opportunity.pipelineStageId);
    if (!stage) throw new Error('Current opportunity stage is missing from the pipeline catalog. Open the Opportunities board to refresh it. Nothing saved.');
    return { contact, opportunity, pipeline, stage };
  }

  async function run() {
    if (workflow.busy) return;
    document.getElementById('pertama-save-progress')?.remove();
    let saveProgress = null;
    workflow.busy = true;
    runButton.disabled = true;
    resetJournalEvidence();
    workflow.step = 'Checking contact page';
    workflow.guardedContact = contactId();
    workflow.startingContact = workflow.guardedContact || '(none)';
    const startingRevision = stageRouteRevision, startingUser = currentUserId;
    let timingResult = 'ok';
    startWorkflowTiming('Save and next', workflow.step);
    try {
      requireContactControlsReady();
      if (!workflow.guardedContact || !location.pathname.includes(`/location/${LOCATION_ID}/`)) {
        throw new Error(`Expected a contact detail page in location ${LOCATION_ID}. Current path: ${location.pathname}`);
      }
      const previous = localStorage.getItem(checkpointKey(workflow.startingContact));
      if (previous) {
        const saved = JSON.parse(previous);
        restoreJournalEvidence(saved);
        throw new Error(`Repeat run blocked: an unfinished no-answer action exists from ${saved.time}. Stage/note/task changes may already be saved. Reconcile that action before starting another; refreshing does not clear this block.`);
      }
      if (settings.pipelineIds?.length || settings.priority === 'stage') {
        progress('Checking navigation identity…');
        await requireVerifiedUser();
      }
      if (settings.priority === 'stage') {
        progress('Checking stage queue…');
        const context = await ensureStageQueue();
        if (!context) { timingResult = 'cancelled'; return; }
        // Refresh the action origin from the queue, including after a page reload.
        pinStageQueue(context.queue);
        workflow.guardedStageQueue = context.queue;
      }
      progress('Reading contact and opportunity…');
      const context = await readActionContext();
      if (contactId() !== workflow.startingContact || stageRouteRevision !== startingRevision) throw new Error('Contact changed during preparation. Nothing saved.');
      const { contact, opportunity, pipeline, stage } = context;
      const firstName = contact.firstName.trim(), name = [firstName, contact.lastName.trim()].filter(Boolean).join(' ');
      if (!name) throw new Error('Contact name is empty. Nothing saved.');
      const phone = contact.phone;
      const pipelineName = pipeline.name;
      const stageOptions = Object.keys(pipeline.stages);
      const rule = Object.hasOwn(settings.rules, stage) ? settings.rules[stage]
        : { next: '', days: 2, updateStage: false };
      const ownerId = typeof contact.assignedTo === 'string' && /^[a-zA-Z0-9_-]+$/.test(contact.assignedTo) ? contact.assignedTo : '';
      const taskTitle = renderTemplate(settings.task, { name, firstName });
      progress('Awaiting confirmation…');
      const choices = await confirmActions({ contact, name, firstName: firstName || name, phone, stage, rule, ownerId, taskTitle, pipelineName, stageOptions }, choices => {
        saveProgress = createSaveProgress({ name, pipelineName, choices });
        workflow.activeSaveProgress = saveProgress;
      });
      if (!choices) { timingResult = 'cancelled'; return; }
      if (contactId() !== workflow.startingContact || stageRouteRevision !== startingRevision) throw new Error('Contact or original stage queue changed during confirmation. Nothing saved.');
      progress('Rechecking contact and opportunity…');
      const approvedEpoch = contactReadEpoch;
      const latest = await readActionContext({ fresh: true });
      if (contactId() !== workflow.startingContact || stageRouteRevision !== startingRevision || currentUserId !== startingUser || contactReadEpoch !== approvedEpoch
        || ['id', 'locationId', 'firstName', 'lastName', 'phone', 'assignedTo'].some(key => contact[key] !== latest.contact[key])
        || ['id', 'contactId', 'locationId', 'pipelineId', 'pipelineStageId', 'assignedTo'].some(key => opportunity[key] !== latest.opportunity[key])
        || choices.stage && pipeline.stages[choices.targetStage] !== latest.pipeline.stages[choices.targetStage]) {
        throw new Error('Contact or opportunity changed after confirmation. Nothing saved; review the updated record before trying again.');
      }
      workflow.approvedActionContext = { contact: workflow.startingContact, route: startingRevision, user: startingUser, epoch: approvedEpoch,
        contactRecord: contact, opportunity, targetStageId: pipeline.stages[choices.targetStage], targetStageName: choices.targetStage,
        ownerId, noteText: choices.noteText, taskTitle, due: choices.due,
        actions: { stage: choices.stage, note: choices.note, task: choices.task, sms: choices.sms }, taskId: null,
        sms: { from: choices.smsFrom, to: choices.smsTo, message: choices.smsText } };
      assertApprovedActionContext();
      if (choices.task && (!ownerId || !choices.due)) throw new Error('A valid contact owner and deadline are required for the task. Nothing saved.');
      progress('Preflighting stage and existing Call task…');
      const [, preparedTask] = await drainAll([
        choices.stage ? prepareStageApi() : Promise.resolve(),
        prepareCallTask(workflow.startingContact),
      ]);
      assertApprovedActionContext();
      if (['id', 'locationId', 'firstName', 'lastName', 'phone', 'assignedTo'].some(key => contact[key] !== preparedTask.contact[key])) {
        throw new Error('Contact changed during save preflight. Nothing saved.');
      }
      if (!preparedTask.task) saveProgress.skip('complete');
      // Every lane uses this preflight snapshot; in-flight requests cannot be recalled on failure.
      Object.assign(workflow.approvedActionContext, { parallel: true, ownedEpoch: 0, ownedWritesPending: 0, stopSaves: false });
      preparedTask.context.approval = workflow.approvedActionContext;
      progress('Saving selected actions concurrently…');
      const trackAction = async (key, action, detail = 'Saving…') => {
        saveProgress.start(key, detail);
        try { return await action(); }
        catch (error) { saveProgress.fail(key); throw error; }
      };
      const saveLane = async action => {
        try { await action(); }
        catch (error) { workflow.approvedActionContext.stopSaves = true; throw error; }
      };
      await drainAll([
        ...(choices.stage ? [saveLane(() => trackAction('stage', saveStageApi))] : []),
        ...(choices.note ? [saveLane(() => trackAction('note', saveNoteApi))] : []),
        saveLane(async () => {
          const complete = () => completeCallTask(workflow.startingContact, { fromSaveAndNext: true, prepared: preparedTask });
          if (preparedTask.task) await trackAction('complete', complete, 'Completing…');
          else await complete();
          if (choices.task) {
            if (workflow.approvedActionContext.stopSaves) await createTaskApi();
            else await trackAction('task', createTaskApi, 'Creating…');
          }
        }),
      ]);
      assertApprovedActionContext();

      if (choices.sms) {
        progress('Sending SMS…');
        await trackAction('sms', sendSmsApi, 'Sending…');
      }

      removeCompletedCheckpoint(workflow.startingContact);
      progress('Opening next lead…');
      workflow.guardedContact = null; // Navigation is allowed only after the saves succeeded.
      workflow.guardedStageQueue = null;
      workflow.approvedActionContext = null;
      const next = await findNextActionable();
      if (next) { await openLead(next, () => saveProgress.remove()); timingResult = 'navigating'; }
      else { saveProgress.remove(); taskNotice(`Selected actions saved. ${emptyQueueMessage()} Refresh the contact to update the CRM panels.`); }

    } catch (error) {
      timingResult = 'stopped';
      finishWorkflowTiming(timingResult); // Do not count time spent reading the error alert.
      const report = [
        `Pertama No answer — v${VERSION}`, `Stopped: ${workflow.step}`,
        `Contact ID: ${workflow.startingContact}`, `Current path: ${location.pathname}`,
        '', error.message || String(error), '',
        'Completed actions (verification noted below):', workflow.completed.join('\n') || 'None confirmed.',
        '', workflow.pendingSave ? `Save attempted; result not fully verified:\n${workflow.pendingSave}\nThis may already be saved. Inspect the record to avoid duplicates.`
          : 'No save is awaiting verification. Unsaved form edits may remain.',
        '', 'Execution stopped. No automatic retry. Check the record before running again.',
        'The same report and technical error are in the browser console.',
      ].join('\n');
      console.error(report, error);
      if (saveProgress) saveProgress.stop(report);
      else alert(report);
    } finally {
      finishWorkflowTiming(timingResult);
      workflow.activeSaveProgress = null;
      workflow.guardedContact = null;
      workflow.guardedStageQueue = null;
      workflow.approvedActionContext = null;
      workflow.busy = false;
      runButton.disabled = false;
      runButton.textContent = 'Save and next';
      nextButton.textContent = nextLeadLabel();
      queueSaveRevision++;
      hideQueueSummary();
      refreshButtons();
    }
  }

  function invalidateOutgoingCallCounter() {
    const view = callCounterView;
    if (!view || view.invalid) return;
    view.invalid = true;
    if (view.run && leadReportRun === view.run) cancelLeadAccessReport();
    view.dialog.querySelector('[data-call-count-rows]').replaceChildren();
    view.dialog.querySelector('[data-call-count-load]').disabled = true;
    view.dialog.querySelector('[data-call-count-status]').textContent = 'Session changed. Reopen settings to load counts.';
  }
  function setupOutgoingCallCounter(dialog) {
    const view = { dialog, context: leadAccessContext(), run: null, invalid: false }; callCounterView = view;
    const button = dialog.querySelector('[data-call-count-load]'), rows = dialog.querySelector('[data-call-count-rows]');
    const status = dialog.querySelector('[data-call-count-status]'), report = dialog.querySelector('[data-lead-access]');
    const current = () => callCounterView === view && dialog.isConnected && !view.invalid && validLeadContext(view.context);
    button.onclick = async () => {
      if (button.disabled) return;
      if (!current()) { if (callCounterView === view) invalidateOutgoingCallCounter(); return; }
      if (leadReportRun) { status.textContent = 'Wait for the running report to finish.'; return; }
      button.disabled = true; report.disabled = true; rows.replaceChildren(); status.textContent = 'Loading call counts…';
      try {
        const result = await runOutgoingCallCount(view);
        if (!current()) return;
        const statuses = [...new Set(['completed', 'busy', 'failed', ...result.days.flatMap(day => Object.keys(day.statuses))])];
        const labels = { completed: 'Completed', busy: 'Busy', failed: 'Failed', 'no-answer': 'No answer' };
        const table = document.createElement('table'), head = table.createTHead().insertRow(), body = table.createTBody();
        for (const label of ['Day · WITA', 'Total', ...statuses.map(key => Object.hasOwn(labels, key) ? labels[key] : key)]) {
          const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; head.appendChild(th);
        }
        for (const day of result.days) {
          const tr = body.insertRow(), label = document.createElement('th'); label.scope = 'row'; label.textContent = day.label; tr.appendChild(label);
          for (const value of [day.total, ...statuses.map(key => day.statuses[key] || 0)]) tr.insertCell().textContent = String(value);
        }
        rows.appendChild(table); button.textContent = 'Refresh';
        status.textContent = `Updated ${new Date(result.updatedAt + 28800000).toISOString().slice(11, 16)} · WITA`;
      } catch {
        if (current()) { rows.replaceChildren(); status.textContent = 'Could not load call counts. Try again.'; }
      } finally {
        if (callCounterView === view && dialog.isConnected) {
          if (!validLeadContext(view.context)) invalidateOutgoingCallCounter();
          button.disabled = view.invalid; report.disabled = false;
        }
        view.run = null;
      }
    };
    return () => {
      if (view.run && leadReportRun === view.run) cancelLeadAccessReport();
      if (callCounterView === view) callCounterView = null;
    };
  }
  function openSettings() {
    if (workflow.busy || document.getElementById('pertama-settings')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'pertama-settings';
    dialog.setAttribute('aria-label', 'Workflow settings');
    dialog.style.cssText = 'width:min(680px,calc(100vw - 32px));max-height:85vh;overflow:auto;border:1px solid #e4e7ec;border-radius:14px;padding:24px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#182230;background:#fff;box-shadow:0 24px 60px #10182830';
    dialog.innerHTML = `<style>
      #pertama-settings::backdrop{background:#10182866}
      #pertama-settings *{box-sizing:border-box}
      #pertama-settings [hidden]{display:none!important}
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
      #pertama-settings [data-call-count]{margin-bottom:16px}
      #pertama-settings [data-call-count] strong{margin-right:12px;font-weight:500}
      #pertama-settings [data-call-count-rows]{overflow-x:auto;margin-top:10px}
      #pertama-settings [data-call-count] table{width:100%;border-collapse:collapse;font:inherit}
      #pertama-settings [data-call-count] th,#pertama-settings [data-call-count] td{padding:8px;text-align:left;border:0;border-bottom:1px solid #eaecf0;background:transparent;white-space:nowrap}
      #pertama-settings [data-call-count] th{font-weight:500}
      #pertama-settings [data-call-count-status]{display:block;margin-top:6px;color:#667085;font-size:12px}
      #pertama-settings [data-call-count] button:disabled{opacity:.6;cursor:default}
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
      <h3>SMS templates</h3><p>Default is used when a stage has no template selected. Template buttons replace the current message without sending it.</p><div data-sms-template-list></div><button type="button" data-add-sms-template>Add SMS template</button>
      <label>SMS sender number<select name="smsFrom" disabled><option value="">Open a contact to load your numbers…</option></select></label>
      <p data-sms-settings-status>SMS is available only with a number linked to your CRM user.</p>
      <p>Save and next completes a matching existing Call task before creating a new follow-up. Tasks created with an older title template need manual completion.</p>
      <label>Lead priority<select name="priority"><option value="leads">New leads first</option><option value="tasks">Follow-ups first</option><option value="stage">Same stage only</option></select></label>
      <p>Same stage only stays in the original pipeline and stage, even after moving the current lead. It skips the current contact and never falls back to tasks. Open a lead from its board to capture the queue; otherwise its current pipeline and stage are inferred automatically. You will only be asked to choose a queue if multiple opportunities make it ambiguous. The queue survives refreshes in this tab. Pipeline selections and the new-lead stage below apply to the other two modes.</p>
      <label>New lead stage<select name="newLeadStage" required></select></label>
      <h3>Pipelines</h3><p>Select your pipelines and use Up/Down to set their order. New installations start with none selected. Lead searches use the verified signed-in user (assigned to you or followed by you). Pipeline selection controls new-lead queues; follow-ups preserve your other task-list filters and sorting, but only include tasks already due, with a fresh cutoff on every lookup. Open the Opportunities board and reopen Settings to refresh the available pipelines. Visiting a pipeline board captures your filters; otherwise lead searches use the default order.</p><div data-pipelines></div>
      <h3>Shared stage defaults</h3><p>These rules apply to every pipeline. Checked actions start selected in Save and next; you can override them before confirming. Stages come from the pipelines checked above. Follow-up days of 0 or blank default to 3 hours later; positive days default to 11am WITA. Adjust the exact date and time before confirming.</p><div data-rules></div><button type="button" data-add-rule>Add stage rule</button>
      <section data-checkpoint hidden><h3>Unfinished action</h3><p>Check this contact’s CRM record before removing its retry block.</p><button type="button" data-clear-checkpoint>Clear unfinished action</button></section><section><h3>Reports</h3><div data-call-count><strong>Outgoing calls</strong><button type="button" data-call-count-load>Load call counts</button><div data-call-count-rows></div><small data-call-count-status role="status"></small></div><button type="button" data-lead-access>Inaccessible leads →</button></section><p data-error role="alert" style="color:#b42318"></p><div class="settings-footer"><button type="button" data-cancel>Cancel</button><button type="submit">Save settings</button></div></form>`;
    const form = dialog.querySelector('form');
    dialog.querySelector('[data-lead-access]').addEventListener('click', event => { event.currentTarget.focus(); openLeadAccessReport(); });
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
    const availableStages = [...new Set(NAV_PIPELINES.flatMap(pipeline => Object.keys(pipeline.stages)))];
    const stageSelect = form.elements.namedItem('newLeadStage');
    stageSelect.replaceChildren(new Option('Select a new-lead stage…', ''), ...availableStages.map(stage => new Option(stage, stage)));
    if (!availableStages.includes(settings.newLeadStage)) stageSelect.add(new Option(`${settings.newLeadStage} (saved; not in loaded pipelines)`, settings.newLeadStage));
    for (const key of ['note', 'task', 'priority', 'newLeadStage']) form.elements.namedItem(key).value = settings[key];
    const senderSelect = form.elements.namedItem('smsFrom');
    if (contactId() && location.pathname.includes(`/location/${LOCATION_ID}/`)) {
      void prepareSmsApi().then(prepared => {
        if (!dialog.isConnected) return;
        senderSelect.replaceChildren(new Option('Select your number…', ''));
        for (const sender of prepared.fromNumbers) senderSelect.add(new Option(sender.label, sender.number));
        senderSelect.value = prepared.from || '';
        senderSelect.disabled = prepared.fromNumbers.length < 2;
        dialog.querySelector('[data-sms-settings-status]').textContent = !prepared.fromNumbers.length
          ? 'No number is linked to your CRM user; SMS is unavailable.'
          : prepared.fromNumbers.length === 1 ? `Your number ${prepared.from} is selected automatically.`
          : 'Choose a default number before sending SMS.';
      }).catch(() => {
        if (dialog.isConnected) dialog.querySelector('[data-sms-settings-status]').textContent = 'Could not load your SMS numbers. Open a contact and try again.';
      });
    }
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
    const templateRoot = dialog.querySelector('[data-sms-template-list]');
    function refreshSmsTemplates() {
      for (const select of ruleRoot.querySelectorAll('[data-sms-template]')) {
        const value = select.value;
        select.replaceChildren(new Option('Default (global)', ''), ...[...templateRoot.children].map(row =>
          new Option(row.querySelector('[data-template-name]').value || 'Unnamed template', row.dataset.templateId)));
        if (value && ![...templateRoot.children].some(row => row.dataset.templateId === value)) {
          select.add(new Option('Unavailable template — uses Default', value));
        }
        select.value = value;
      }
    }
    function addSmsTemplate(template) {
      const row = document.createElement('div'); row.dataset.smsTemplateRow = ''; row.dataset.templateId = template.id;
      row.innerHTML = '<label>Template name<input data-template-name required></label><label>Message<textarea data-template-message rows="4" required></textarea></label><button type="button" data-remove-sms-template>Remove template</button>';
      const name = row.querySelector('[data-template-name]'); name.value = template.name; name.readOnly = template.id === 'default';
      row.querySelector('[data-template-message]').value = template.message;
      name.addEventListener('input', refreshSmsTemplates); name.addEventListener('change', refreshSmsTemplates);
      const remove = row.querySelector('[data-remove-sms-template]'); remove.disabled = template.id === 'default';
      remove.addEventListener('click', () => {
        if ([...ruleRoot.querySelectorAll('[data-sms-template]')].some(select => select.value === template.id)) {
          dialog.querySelector('[data-error]').textContent = 'Choose a different template for stage rules using this template before removing it.';
          return;
        }
        row.remove(); refreshSmsTemplates(); dialog.querySelector('[data-error]').textContent = '';
      });
      templateRoot.appendChild(row); refreshSmsTemplates();
    }
    for (const template of settings.smsTemplates) addSmsTemplate(template);
    dialog.querySelector('[data-add-sms-template]').addEventListener('click', () => {
      addSmsTemplate({ id: crypto.randomUUID(), name: '', message: '' });
      templateRoot.lastElementChild.querySelector('input').focus();
    });
    const selectedStages = () => [...new Set([...pipelineRoot.children]
      .filter(row => row.querySelector('input').checked)
      .flatMap(row => Object.keys(NAV_PIPELINES.find(p => p.id === row.dataset.pipelineId)?.stages || {})))];
    function refreshRuleStages() {
      const stages = selectedStages();
      const currentStages = [...ruleRoot.children].map(row => row.querySelector('[data-stage]').value);
      for (const row of ruleRoot.children) {
        for (const key of ['stage', 'next']) {
          const select = row.querySelector(`[data-${key}]`), value = select.value;
          select.replaceChildren(new Option('Select a stage…', ''), ...stages.map(stage => new Option(stage, stage)));
          if (value && !stages.includes(value)) {
            const unavailable = new Option(`${value} (unavailable in selected pipelines)`, value);
            unavailable.disabled = true;
            select.add(unavailable);
          }
          select.value = value;
          if (key === 'stage') for (const option of select.options) {
            if (option.value && option.value !== value && currentStages.includes(option.value)) option.disabled = true;
          }
        }
      }
    }
    function addRule(stage = '', rule = { next: '', days: 2, updateStage: false }) {
      const row = document.createElement('div'); row.className = 'rule-row';
      row.dataset.savedStage = stage; row.dataset.savedNext = rule.next;
      row.innerHTML = '<label>Current stage<select data-stage required></select></label><label>Suggested next stage<select data-next required></select></label><label><input data-update type="checkbox"> Update stage</label><label><input data-note type="checkbox"> Add note</label><label><input data-task type="checkbox"> Add follow-up task</label><label><input data-sms type="checkbox"> Send SMS</label><label>Default SMS template<select data-sms-template></select></label><label>Follow-up days<input data-days type="number" min="0" max="36500" step="1"></label><button type="button">Remove rule</button>';
      row.querySelector('[data-stage]').add(new Option(stage, stage));
      row.querySelector('[data-next]').add(new Option(rule.next, rule.next));
      const days = row.querySelector('[data-days]'), task = row.querySelector('[data-task]');
      days.value = rule.days === null ? '' : String(rule.days);
      row.querySelector('[data-update]').checked = rule.updateStage !== false;
      row.querySelector('[data-note]').checked = rule.addNote !== false;
      task.checked = rule.addTask ?? rule.days != null;
      row.querySelector('[data-sms]').checked = rule.sendSms === true;
      function updateDays() {
        days.closest('label').hidden = !task.checked;
        days.disabled = !task.checked;
      }
      updateDays(); task.addEventListener('change', updateDays);
      row.querySelector('[data-stage]').addEventListener('change', refreshRuleStages);
      row.querySelector('button').addEventListener('click', () => { row.remove(); refreshRuleStages(); });
      ruleRoot.appendChild(row); refreshRuleStages(); refreshSmsTemplates();
      const templateSelect = row.querySelector('[data-sms-template]');
      if (rule.smsTemplateId && ![...templateSelect.options].some(option => option.value === rule.smsTemplateId)) {
        templateSelect.add(new Option('Unavailable template — uses Default', rule.smsTemplateId));
      }
      templateSelect.value = rule.smsTemplateId || '';
    }
    for (const [stage, rule] of Object.entries(settings.rules)) addRule(stage, rule);
    pipelineRoot.addEventListener('change', refreshRuleStages);
    dialog.querySelector('[data-add-rule]').addEventListener('click', () => addRule());
    const closeCounter = setupOutgoingCallCounter(dialog);
    const close = () => { closeCounter(); dialog.close(); dialog.remove(); };
    dialog.querySelector('[data-cancel]').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    form.addEventListener('submit', event => {
      event.preventDefault();
      try {
        const next = { rules: Object.create(null), pipelineIds: [...pipelineRoot.children].filter(row => row.querySelector('input').checked).map(row => row.dataset.pipelineId) };
        for (const key of ['note', 'task', 'priority', 'newLeadStage']) next[key] = form.elements.namedItem(key).value.trim();
        next.smsTemplates = [...templateRoot.children].map(row => ({ id: row.dataset.templateId,
          name: row.querySelector('[data-template-name]').value.trim(), message: row.querySelector('[data-template-message]').value.trim() }));
        next.smsFrom = senderSelect.value || (senderSelect.disabled ? settings.smsFrom : '');
        for (const row of ruleRoot.children) {
          const stage = row.querySelector('[data-stage]').value.trim(), rawDays = row.querySelector('[data-days]').value.trim();
          if (Object.hasOwn(next.rules, stage)) throw new Error(`Duplicate stage rule: ${stage}`);
          const destination = row.querySelector('[data-next]').value.trim();
          const stages = selectedStages();
          if (stage && !stages.includes(stage) && stage !== row.dataset.savedStage
            || destination && !stages.includes(destination) && destination !== row.dataset.savedNext) {
            throw new Error('Stage is unavailable in selected pipelines. Choose an available stage.');
          }
          next.rules[stage] = { next: destination, days: rawDays === '' ? null : Number(rawDays),
            updateStage: row.querySelector('[data-update]').checked, addNote: row.querySelector('[data-note]').checked,
            addTask: row.querySelector('[data-task]').checked, sendSms: row.querySelector('[data-sms]').checked };
          const smsTemplateId = row.querySelector('[data-sms-template]').value;
          if (smsTemplateId) next.rules[stage].smsTemplateId = smsTemplateId;
        }
        validateSettings(next);
        if (!availableStages.includes(next.newLeadStage) && next.newLeadStage !== settings.newLeadStage) throw new Error('Open the Opportunities board and reopen Settings to choose an available new-lead stage.');
        for (const id of next.priority === 'stage' ? [] : next.pipelineIds) {
          const pipeline = NAV_PIPELINES.find(p => p.id === id);
          if (!pipeline || !pipeline.stages[next.newLeadStage]) throw new Error(`${pipeline?.name || 'Unavailable pipeline'} has no ${next.newLeadStage} stage. Disable it or change the stage name.`);
        }
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); settings = next; close();
        hideQueueSummary(); refreshButtons(); taskNotice('Workflow settings saved.');
      } catch (error) { dialog.querySelector('[data-error]').textContent = error.message; }
    });
    document.body.appendChild(dialog); dialog.showModal();
  }

  let runButton, nextButton;
  let buttonsInitialized = false;
  function initializeButtons() {
  if (buttonsInitialized) return;
  buttonsInitialized = true;
  try {
    const savedNotice = JSON.parse(sessionStorage.getItem(SMS_NOTICE_KEY) || 'null');
    sessionStorage.removeItem(SMS_NOTICE_KEY);
    if (savedNotice && Date.now() - savedNotice.time < 30000) taskNotice(savedNotice.message);
  } catch { /* Optional status only. */ }
  document.addEventListener('click', rememberBoardContact, true);
  runButton = document.createElement('button');
  runButton.id = 'pertama-no-answer-button';
  runButton.textContent = 'Save and next';
  runButton.style.cssText = 'align-self:center;flex-shrink:0;margin-left:16px;padding:10px 16px;background:#155eef;color:white;border:0;border-radius:6px;font:14px sans-serif;white-space:nowrap;cursor:pointer';
  runButton.addEventListener('click', run);
  const queueSummary = document.createElement('span');
  queueSummary.id = 'pertama-queue-summary';
  queueSummary.hidden = true;
  queueSummary.style.cssText = 'align-self:center;margin-left:12px;color:#667085;font:12px/18px sans-serif';
  queueSummary.title = 'Matching opportunities and due tasks, not calls or unique contacts. Same-stage remaining excludes this contact. — means unavailable. Snapshot refreshed on contact, save or filter changes.';
  let queueSnapshot = null;
  hideQueueSummary = () => {
    if (!queueSummary.hidden) queueSummary.hidden = true;
    if (queueSummary.textContent) queueSummary.textContent = '';
  };
  function queueIdentity() {
    return JSON.stringify([location.pathname, stageRouteRevision, currentUserId, readSessionRevision, contactReadEpoch, queueSaveRevision,
      settings.priority, settings.pipelineIds, settings.newLeadStage, stageQueue, NAV_PIPELINES, queryTemplates]);
  }
  function updateQueueSummary(show, allowReads) {
    const context = contactReadContext();
    if (!show || document.hidden || !liveReadHeaders || !validContactRead(context) || !previousContactControlsGone()) {
      hideQueueSummary(); return;
    }
    const stage = settings.priority === 'stage' ? stageQueueContext() : null;
    const key = queueIdentity();
    const render = snapshot => {
      const count = value => value === null ? '—' : String(value);
      const label = settings.priority === 'stage' ? `${stage?.stage || 'Stage'} · ${count(snapshot.leads)} remaining`
        : (settings.priority === 'tasks' ? [`Follow-ups due ${count(snapshot.tasks)}`, `New leads ${count(snapshot.leads)}`]
          : [`New leads ${count(snapshot.leads)}`, `Follow-ups due ${count(snapshot.tasks)}`]).join(' · ');
      if (queueSummary.textContent !== label) queueSummary.textContent = label;
      if (queueSummary.hidden) queueSummary.hidden = false;
    };
    if (queueSnapshot?.key === key) { render(queueSnapshot); return; }
    hideQueueSummary();
    if (!allowReads || workflow.busy || stageWritesPending) return;
    const snapshot = { key, leads: null, tasks: null };
    queueSnapshot = snapshot;
    render(snapshot);
    const current = () => queueSnapshot === snapshot && snapshot.key === queueIdentity() && validContactRead(context);
    const publish = (category, promise) => {
      promise.then(value => {
        if (!current()) return;
        snapshot[category] = value;
        if (!document.hidden && !workflow.busy && !stageWritesPending && visible(runButton) && previousContactControlsGone()) render(snapshot);
      }, () => {});
    };
    const pipelineCount = async (pipeline, stageName, sameStage = false) => {
      const body = pipelineQueueQuery(pipeline, stageName, sameStage);
      if (!sameStage) return pipelineQueueCount(await readList('/opportunities/search', body), pipeline, stageName);
      // Contact equality is also used by contactOpportunityQuery; no invented NOT filter or pagination.
      const contactBody = { ...body, filters: [...body.filters,
        { group: 'OR', filters: [{ field: 'contact_id', operator: 'eq', value: context.id }] }] };
      const [all, own] = await Promise.all([readList('/opportunities/search', body), readList('/opportunities/search', contactBody)]);
      const total = pipelineQueueCount(all, pipeline, stageName), excluded = pipelineQueueCount(own, pipeline, stageName);
      if (excluded > total) throw new Error('Queue changed during count.');
      return total - excluded;
    };
    if (settings.priority === 'stage') {
      if (stage) publish('leads', pipelineCount(stage.pipeline, stage.stage, true));
    } else {
      publish('leads', Promise.all(settings.pipelineIds.map(id => pipelineCount(NAV_PIPELINES.find(p => p.id === id), settings.newLeadStage)))
        .then(counts => { const total = counts.reduce((sum, count) => sum + count, 0); if (!Number.isSafeInteger(total)) throw new Error('Invalid queue total.'); return total; }));
      publish('tasks', (async () => {
        const dueBefore = new Date().toISOString();
        return dueTaskQueueCount(await readList('/objects/task/records/search', dueTaskQueueQuery(dueBefore)), dueBefore);
      })());
    }
    // Query builders may load a persisted template on their first use.
    snapshot.key = queueIdentity();
  }
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
  const stageBadge = document.createElement('span');
  stageBadge.id = 'pertama-contact-stage';
  stageBadge.hidden = true;
  stageBadge.style.cssText = 'flex:0 1 auto;min-width:0;max-width:50%;margin-left:6px;padding:2px 8px;border:1px solid #e4e7ec;border-radius:12px;background:#f2f4f7;color:#344054;font:500 12px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  hideStageIndicator = () => { if (!stageBadge.hidden) stageBadge.hidden = true; };
  let indicatorAttempt = '';
  function updateStageIndicator(name) {
    const context = contactReadContext();
    if (!name || !validContactRead(context)) { hideStageIndicator(); return; }
    const cached = kind => {
      const slot = contactReads[kind];
      return slot?.value && validContactRead(slot.context) ? slot.value : null;
    };
    const contact = cached('details'), opportunities = cached('opportunities');
    if (!contact || !opportunities) {
      hideStageIndicator();
      const key = `${context.id}:${context.user}:${context.epoch}:${stageRouteRevision}`;
      if (!workflow.busy && indicatorAttempt !== key) {
        indicatorAttempt = key;
        // Coalesce with native/workflow reads; drain both even if one fails. No idle retries.
        drainAll([readContactDetails(), readContactOpportunities()]).catch(() => {}).finally(refreshButtons);
      }
      return;
    }
    const open = opportunities.filter(item => !item.status || item.status === 'open');
    const origin = readOrigin(contact.id);
    const opportunity = origin ? open.find(item => item.id === origin.opportunityId) : open.length === 1 ? open[0] : null;
    const pipeline = opportunity && NAV_PIPELINES.find(item => item.id === opportunity.pipelineId);
    const stage = pipeline && Object.keys(pipeline.stages).find(label => pipeline.stages[label] === opportunity.pipelineStageId);
    const contactName = [contact.firstName.trim(), contact.lastName.trim()].filter(Boolean).join(' ').replace(/\s+/g, ' ');
    if (!stage || !contactName || text(name).replace(/\s+/g, ' ') !== contactName
      || origin && (origin.pipelineId ? origin.pipelineId !== pipeline.id : origin.pipeline && origin.pipeline !== pipeline.name)) {
      hideStageIndicator(); return;
    }
    const anchor = name.parentElement?.style.display === 'contents' ? name.parentElement : name;
    if (anchor.nextElementSibling !== stageBadge) anchor.insertAdjacentElement('afterend', stageBadge);
    if (stageBadge.textContent !== stage) stageBadge.textContent = stage;
    const label = `Stage: ${stage}`;
    if (stageBadge.title !== label) stageBadge.title = label;
    if (stageBadge.getAttribute('aria-label') !== label) stageBadge.setAttribute('aria-label', label);
    if (stageBadge.hidden) stageBadge.hidden = false;
  }
  // No idle polling. Discover once, then watch only the hosts and their ancestry.
  let messageHub = null, settingsAnchor = null, companies = null, centralName = null;
  let frame = null, discoveryTimer = null, discoveryRetryTimer = null, discoveryExpired = false;
  let discoveryActive = false, observedWidthTarget = null, observedWidth = null;
  let lastPath = location.pathname;
  const rootsToDiscover = new Set([document]);
  const knownAnchors = new Set();
  const owned = node => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('[id^="pertama-"]');
  function relevantMutations(records) {
    if (document.hidden) return;
    let changed = false;
    for (const record of records) {
      if (owned(record.target)) continue;
      const nodes = [...record.addedNodes, ...record.removedNodes];
      const removedControl = [...record.removedNodes].some(node =>
        [runButton, nextButton, settingsButton, stageBadge, queueSummary].includes(node) && !node.isConnected);
      if (record.type === 'childList' && nodes.length && nodes.every(owned) && !removedControl) continue;
      changed = true;
      for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE && !owned(node)) rootsToDiscover.add(node);
      const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      const control = target?.closest('a, button');
      if (control) rootsToDiscover.add(control);
      else if (record.type === 'attributes' && target !== document.body && target !== document.documentElement) rootsToDiscover.add(target);
    }
    if (changed) refreshButtons();
  }
  const hostObserver = new MutationObserver(relevantMutations);
  const discoveryObserver = new MutationObserver(relevantMutations);
  const widthObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    const entry = entries.find(item => item.target === observedWidthTarget);
    if (entry && entry.contentRect.width !== observedWidth) {
      observedWidth = entry.contentRect.width;
      refreshButtons();
    }
  }) : null;
  function stopDiscovery() {
    discoveryObserver.disconnect(); discoveryActive = false;
    clearTimeout(discoveryTimer); discoveryTimer = null;
    clearTimeout(discoveryRetryTimer); discoveryRetryTimer = null;
  }
  function discover(root) {
    if (!root?.isConnected && root !== document) return;
    let needHub = !visible(messageHub), needSettings = !visible(settingsAnchor);
    if (!needHub && !needSettings) return;
    const candidates = root.matches?.('a, button') ? [root, ...root.querySelectorAll('a, button')] : root.querySelectorAll('a, button');
    for (const el of candidates) {
      if (owned(el)) continue;
      const label = text(el);
      if (needHub && /^message hub$/i.test(label) && visible(el)) { messageHub = el; knownAnchors.add(el); needHub = false; }
      if (needSettings && /^settings$/i.test(label) && visible(el)) { settingsAnchor = el; knownAnchors.add(el); needSettings = false; }
      if (!needHub && !needSettings) break;
    }
  }
  function watchHosts() {
    hostObserver.disconnect();
    for (const el of knownAnchors) if (!el.isConnected) knownAnchors.delete(el);
    const hosts = [companies, centralName, ...knownAnchors].filter(el => el?.isConnected);
    // A host's parent could be the entire app. Only controls, navigation and the name
    // container get subtree observation; other ancestors get direct-child checks.
    const localRoots = new Set(hosts);
    for (const el of hosts) {
      const nav = el.closest('nav, [role="navigation"]');
      if (nav) localRoots.add(nav);
    }
    const nameContainer = centralName?.parentElement?.style.display === 'contents' ? centralName.parentElement.parentElement : centralName?.parentElement;
    if (nameContainer?.isConnected) localRoots.add(nameContainer);
    const ancestors = new Set([document.body]);
    if (nameContainer?.isConnected) ancestors.add(nameContainer);
    for (const el of hosts) for (let node = el; node; node = node.parentElement) ancestors.add(node);
    for (const node of ancestors) hostObserver.observe(node, {
      childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'], characterData: true,
      subtree: localRoots.has(node) && node !== document.body && node !== document.documentElement,
    });
  }
  function setDisplay(button, show, display) {
    if (button.hidden !== !show) button.hidden = !show;
    if (display && button.style.display !== (show ? display : 'none')) button.style.display = show ? display : 'none';
  }
  refreshButtons = () => {
    if (document.hidden || frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; refreshToolbar(true); });
  };
  function wakeDiscovery() {
    stopDiscovery(); discoveryExpired = false;
    rootsToDiscover.add(document);
    refreshButtons();
  }
  function scheduleDiscoveryRetry(scanDocument) {
    if (discoveryExpired || discoveryRetryTimer) return;
    discoveryRetryTimer = setTimeout(() => {
      discoveryRetryTimer = null;
      if (scanDocument) rootsToDiscover.add(document);
      refreshButtons();
    }, 1000);
  }
  function discoverHosts() {
    const validHub = messageHub?.isConnected && /^message hub$/i.test(text(messageHub));
    const validSettings = settingsAnchor?.isConnected && /^settings$/i.test(text(settingsAnchor));
    const lostAnchor = messageHub && !validHub || settingsAnchor && !validSettings;
    if (!validHub) messageHub = null;
    if (!validSettings) settingsAnchor = null;
    if (lostAnchor && !rootsToDiscover.size) rootsToDiscover.add(document);
    for (const root of rootsToDiscover) discover(root);
    rootsToDiscover.clear();
    companies = document.getElementById('tb_business');
    centralName = document.querySelector('[data-testid="CENTRALPANEL_NAME"]');
  }
  function placeButton(allowReads) {
    // Finish layout reads before any writes; never measure unrelated page controls.
    const showRun = Boolean(contactId() && visible(companies));
    const visibleName = visible(centralName) ? centralName : null;
    const hub = visible(messageHub) ? messageHub : null;
    const settings = visible(settingsAnchor) ? settingsAnchor : null;
    const widthTarget = hub || settings;
    if (widthTarget !== observedWidthTarget) {
      widthObserver?.disconnect(); observedWidthTarget = widthTarget; observedWidth = null;
      if (widthTarget) widthObserver?.observe(widthTarget);
    }
    const width = widthTarget ? (widthObserver ? observedWidth : null) ?? widthTarget.getBoundingClientRect().width : null;
    if (widthTarget) observedWidth = width;
    const label = nextLeadLabel();

    if (!workflow.busy && nextButton.textContent !== label) nextButton.textContent = label;
    setDisplay(runButton, showRun);
    setDisplay(nextButton, Boolean(widthTarget), 'flex');
    setDisplay(settingsButton, Boolean(settings), 'flex');
    if (showRun && companies.nextElementSibling !== runButton) companies.insertAdjacentElement('afterend', runButton);
    if (settings && settings.previousElementSibling !== settingsButton) settings.insertAdjacentElement('beforebegin', settingsButton);
    if (hub && hub.nextElementSibling !== nextButton) hub.insertAdjacentElement('afterend', nextButton);
    else if (!hub && settings && settingsButton.previousElementSibling !== nextButton) settingsButton.insertAdjacentElement('beforebegin', nextButton);
    if (width !== null) {
      const nextSize = width < 100 ? '11px' : '15px', settingsSize = width < 100 ? '11px' : '14px';
      if (nextButton.style.fontSize !== nextSize) nextButton.style.fontSize = nextSize;
      if (settingsButton.style.fontSize !== settingsSize) settingsButton.style.fontSize = settingsSize;
    }
    if (showRun && runButton.nextElementSibling !== queueSummary) runButton.insertAdjacentElement('afterend', queueSummary);
    updateQueueSummary(showRun, allowReads);
    updateStageIndicator(visibleName);
    return widthTarget;
  }
  function reconcileDiscovery(widthTarget) {
    watchHosts();
    const missingNavHosts = !widthTarget;
    const missingToolbar = Boolean(contactId() && !companies);
    const missingName = Boolean(validContactRead(contactReadContext()) && !centralName);
    if (!missingNavHosts && !missingToolbar && !missingName) stopDiscovery();
    else if (!discoveryExpired) {
      if (!discoveryTimer) discoveryTimer = setTimeout(() => { stopDiscovery(); discoveryExpired = true; }, 30000);
      if (missingNavHosts && !discoveryActive) {
        discoveryObserver.observe(document.body, { childList: true, subtree: true }); discoveryActive = true;
      }
      scheduleDiscoveryRetry(missingNavHosts);
    }
  }
  function refreshToolbar(allowReads = false) {
    if (document.hidden) return;
    recordNavigationReady();
    syncStageQueue();
    if (lastPath !== location.pathname) {
      lastPath = location.pathname;
      stopDiscovery(); discoveryExpired = false;
      rootsToDiscover.add(document);
    }
    if (leadReportDialog && !validLeadContext(leadReportDialog.context)) closeLeadAccessReport();
    if (callCounterView && !validLeadContext(callCounterView.context)) invalidateOutgoingCallCounter();
    if (!location.pathname.includes(`/location/${LOCATION_ID}/`)) {
      cancelLeadAccessReport();
      hideQueueSummary();
      setDisplay(runButton, false); setDisplay(nextButton, false, 'flex'); setDisplay(settingsButton, false, 'flex');
      hostObserver.disconnect(); stopDiscovery(); widthObserver?.disconnect();
      observedWidthTarget = null; observedWidth = null;
      return;
    }
    discoverHosts();
    const widthTarget = placeButton(allowReads);
    reconcileDiscovery(widthTarget);
  }
  window.addEventListener('resize', () => { observedWidth = null; rootsToDiscover.add(document); refreshButtons(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hideQueueSummary();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null; stopDiscovery();
    } else { observedWidth = null; wakeDiscovery(); }
  });
  document.addEventListener('click', () => {
    if (location.pathname.includes(`/location/${LOCATION_ID}/`) &&
      (!(messageHub?.isConnected || settingsAnchor?.isConnected)
        || contactId() && (!companies?.isConnected || currentUserId && !centralName?.isConnected))) wakeDiscovery();
  }, true);
  refreshToolbar();
  refreshButtons();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeButtons, { once: true });
  else initializeButtons();
})();

