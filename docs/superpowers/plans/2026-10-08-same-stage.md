# Same-stage Navigation Implementation Plan

> **For agentic workers:** Use test-driven development and review each change before committing. The user explicitly requested the existing checkout, not worktrees.

**Goal:** Add “Same stage only” navigation that stays in the original pipeline/stage after editing a lead.

**Architecture:** Keep the standalone userscript. Store one contact-bound queue `{ contactId, opportunityId, pipelineId, stageId }` in tab-local session storage. Capture the originating stage from observed board search results at the user's board click; if unavailable, explicitly ask the user to choose an opportunity and stage rather than infer the original stage after an edit. Both navigation buttons use the same queue and existing scoped lookup.

**Tech Stack:** Browser JavaScript userscript; Node test runner and jsdom for offline regression tests.

## Files

- `pertama.js`: queue lifecycle, passive board response observation, queue picker, search dispatch, settings and status text.
- `tests/pertama.test.cjs`: execute the actual userscript in a simulated browser; instrument only the test copy to access closure state. No production test hooks.
- `package.json`, `package-lock.json`: reproducible development-only jsdom dependency and `npm test` command.
- `.gitignore`: ignore `node_modules/`; do not stage unrelated user files.

## Verification record

Implemented and independently reviewed on `feature/same-stage`. Initial RED: 20 feature failures and 2 legacy passes. Final automated verification: 34 tests passing, JavaScript syntax check passing, and whitespace check passing. No live CRM requests or mutations were performed.

Additional regression fixes: invalidate board snapshots both before and after writes, reject snapshots started during writes, observe SPA history changes immediately, and reject stale queue selections/lookups/save confirmations after away-and-back navigation.

The existing bounded top-hit behavior remains fail-closed: if every returned hit belongs to the current contact and more hits exist beyond the response, navigation stops rather than claiming the queue is empty or falling back elsewhere.

The checklists below record the implementation plan; live-browser acceptance remains outstanding.

## 1. Add failing regression tests

- [x] Create a jsdom harness that loads the actual script with `runScripts: 'outside-only'`, stubs network transport, and uses a test-only closure accessor before the final `})();`.
- [x] Test `validateSettings({...settings, priority: 'stage'})`, existing priorities, and rejection of unknown priorities.
- [x] Test session persistence, contact/account boundaries, manual navigation reset, and queue immutability after CRM stage changes.
- [x] Test same-stage searches retain non-stage filters/order, replace old stage constraints, scope to the authenticated user, and exclude the current contact.
- [x] Test empty/invalid responses stop without task fallback; existing lead/task priorities remain unchanged.
- [x] Test board capture through fetch/XHR, missing context requiring explicit selection, and shared navigation behavior.
- [x] Run `npm test`; confirm new behavior fails before implementation.

Test access contract (test copy only):

```js
source.replace(/\}\)\(\);\s*$/, 'globalThis.__test = { evaluate(code) { return eval(code); } };\n})();');
```

Planned production names: `pinStageQueue(queue)`, `syncStageQueue()`, `stageQueueContext()` (returns `{ queue, pipeline, stage }` or null), `ensureStageQueue()` (returns context or null on cancellation), `rememberStageResults(data, revision)`, `observeStageRequest(method, url)` (returns revision for board searches, invalidates board snapshots on opportunity writes). Mode value: `stage`. Storage key: `pertama:stage-queue:${LOCATION_ID}`.

## 2. Implement queue lifecycle and lookup

- [x] Extend settings validation to `['leads', 'tasks', 'stage']`.
- [x] Persist only IDs, scoped to the configured account and active contact. Preserve on refresh and intentional next-lead handoff; clear on unrelated manual navigation.
- [x] Observe successful board search responses using the already-supported aggregation shape. Keep snapshots in memory, invalidate them before/after opportunity writes, and reject responses started before invalidation or during a write. Never alter CRM traffic.
- [x] At a board click, pin only an exact contact/opportunity/pipeline match from observed results. Otherwise keep the existing origin but require explicit stage selection.
- [x] For same-stage navigation, validate pipeline/stage IDs against the current catalog and call the existing top-lead lookup with the current contact excluded. Replace stage filters recursively; retain other filters and sort.
- [x] Carry returned pipeline/stage IDs into the next contact's session context before navigation.
- [x] Run the regression tests until queue and lookup cases pass.

Search branch contract:

```js
if (settings.priority === 'stage') {
  const context = stageQueueContext();
  if (!context) throw new Error('Choose the original stage queue before navigating.');
  return topPipelineLead(context.pipeline, context.stage, contactId(), true);
}
```

## 3. Integrate explicit selection and controls

- [x] Add the new priority option and explanatory settings copy.
- [x] If there is no pinned context, inspect opportunity links and show an explicit opportunity/stage picker with no preselected stage. Cancellation performs no writes/navigation. Reject changed contact/account before pinning.
- [x] Resolve the queue before `run()` performs any save, and before `nextLead()` searches. In same-stage mode, use the pinned opportunity as the action origin.
- [x] Display `Next from: Pipeline · Stage` on the navigation button and in save confirmation. Empty queue stays on the current contact with an explicit message.
- [x] Bump userscript/diagnostic version to `0.2.9`.
- [x] Run `npm test`, `node --check pertama.js`, and `git diff --check`.

## 4. Review and commit

- [x] Review the diff for original-stage drift, session leakage, stale observations, accidental task fallback, and changes to existing priorities.
- [x] Add regression tests for any findings before fixing them.
- Commit scope: only implementation, tests, package metadata, ignore rule, and this plan on `feature/same-stage`.
- [x] Report automated verification separately from live CRM verification. No live CRM mutations performed while testing.

## Live-browser acceptance checks (requires user's authenticated CRM)

1. Install 0.2.9 and reload; select “Same stage only.” Open a lead from a populated board stage. Confirm the displayed queue matches.
2. Change that lead's stage manually; Next lead must still use the original pipeline/stage.
3. Repeat with Save and next, including leaving stage unchanged; the current contact must not be reopened.
4. Refresh after changing a stage; the original queue must survive.
5. Open a different lead manually; its queue replaces the previous queue. Open a direct link without captured context; choose the original stage explicitly.
6. Exhaust the queue; confirm no task/other pipeline fallback. Switch to each existing priority and confirm normal behavior.
