# Workflow Boundaries Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Keep tests-only and production-only commits separate; every checkpoint must pass the full suite.

**Goal:** Reduce workflow-state, journal, and toolbar-discovery coupling while preserving v1.0.8 behavior.

**Architecture:** Retain the single-file, no-build userscript. Group workflow-owned state behind one internal object; keep per-session identity, cache epochs, attempt registries and DOM-discovery state outside it. Extract explicit journal and discovery lifecycle operations without changing request or persistence ordering.

**Tech Stack:** Vanilla JavaScript userscript, Node test runner, JSDOM.

---

## Baseline and invariants

Baseline `f27cb3e`: 465 tests pass. Work on `refactor/workflow-boundaries`; no release, push, version bump, visual redesign, timeout change or live CRM writes.

Preserve approval checks around awaits, exact durable checkpoint JSON schema, storage-error policies, parallel lane draining, task-link sequencing, SMS acceptance semantics, no automatic retries, navigation readiness and the modal lifecycle. Preserve bounded discovery, hidden-tab behavior and read-before-write layout ordering.

Stage exact paths and inspect `git diff --cached --stat` before each commit. Never combine `gohigherlevel.user.js` and test changes in one commit. Do not rewrite assertions merely to pass a refactor.

## 1. Shared test bootstrap — tests-only checkpoint

Files: create `tests/helpers/userscript.cjs`; modify the ten `tests/*.test.cjs` suites.

- [ ] Extract source evaluation/IIFE hook installation and web-global setup into helpers accepting the existing window and source.
- [ ] Leave fixture DOM, endpoint mocks, JWT/session choices, clocks, observers and lifecycle timing local. Preserve `PERTAMA_TEST_BASELINE` handling in the main harness.
- [ ] Run `npm test`; all 465 baseline tests must still pass.
- [ ] Commit tests only: `test: share userscript evaluation bootstrap`.

## 2. State-address migration and guards — tests-only checkpoint

Files: `tests/helpers/userscript.cjs`, suites that directly access workflow locals.

- [ ] Add a temporary test-only fallback inside the injected userscript closure before the evaluation hook. If no lexical `workflow` exists, install a global object with explicit getters/setters for old lexical state. For example:

```js
if (typeof workflow === 'undefined') {
  globalThis.workflow = {
    get busy() { return busy; }, set busy(value) { busy = value; },
    get pendingSave() { return pendingSave; }, set pendingSave(value) { pendingSave = value; }
  };
}
```

Apply that explicit forwarding to `busy`, `activeSaveProgress`, `guardedContact`, `guardedStageQueue`, `approvedActionContext`, `step`, `completed`, `pendingSave`, `pendingActions`, `startingContact`. Do not include session/cache state or timing history. The bridge is test-only and will be removed immediately after the production migration.

- [ ] Change only eval references to these variables into `workflow.<originalName>`. Do not alter API fixture properties, serialized checkpoint fields, local mock variables, or unrelated text.
- [ ] Add baseline-compatible lifecycle guards for evidence preservation after failed runs, cleanup after cancellation, and standalone Call-task ownership if not already covered.
- [ ] Run full suite and commit tests only: `test: guard workflow ownership through state migration`.

## 3. Group workflow state — production-only checkpoint

File: `gohigherlevel.user.js`.

- [ ] Replace the ten top-level locals with this stable object:

```js
const workflow = {
  busy: false, activeSaveProgress: null, guardedContact: null, guardedStageQueue: null,
  approvedActionContext: null, step: '', completed: [], pendingSave: '',
  pendingActions: {}, startingContact: '',
};
```

- [ ] Change references to object properties, preserving exact checks, initialization and cleanup positions. Expand serialization shorthand explicitly so checkpoint keys remain unchanged.
- [ ] Do not move asynchronous ownership boundaries: `run` resets evidence at entry; `nextLead` touches busy/timing only; standalone Call-task completion resets evidence only after its existing checkpoint check; nested completion neither resets nor releases parent ownership. Keep evidence after final cleanup for reports/recovery.
- [ ] Run `npm test`, `node --check gohigherlevel.user.js`, `git diff --check`; commit production only: `refactor: group workflow-owned state`.
- [ ] In a separate tests-only commit remove the transitional fallback, rerun all tests, and verify they now access actual lexical state: `test: remove legacy workflow state bridge`.

## 4. Checkpoint transitions — tests-first, production-second checkpoints

Files: `tests/api-sms.test.cjs`, `tests/concurrent-save.test.cjs`, `tests/api-call-task.test.cjs`, `gohigherlevel.user.js`.

- [ ] Add only missing characterization guards: operation-map rollback retains sibling intents; initial/acknowledged SMS summary remains in memory on failed persistence; final SMS clear restores its unresolved summary on failure; standalone completion preserves prior evidence when blocked by a checkpoint. Assert request counts, checkpoint contents and no retry. Commit passing tests separately.
- [ ] Centralize journal reset/restore, evidence append, SMS summary set/clear, and successful checkpoint removal in the existing checkpoint section. Keep serialization explicit and unchanged.
- [ ] Keep `setPendingAction`'s map+summary rollback and parallel stop behavior intact. SMS initial/acknowledged summary writes retain the new in-memory value on failure; SMS final clear restores the previous value. Do not add checkpoint writes when appending evidence. User-requested checkpoint clearing retains confirm/compare-before-delete guards.
- [ ] Run focused journal suites, full suite, syntax and whitespace checks. Commit production only: `refactor: centralize checkpoint transitions`.

## 5. Toolbar discovery — tests-first, production-second checkpoints

Files: `tests/idle-ui.test.cjs`, `tests/stage-indicator.test.cjs`, `gohigherlevel.user.js`.

- [ ] Add only missing baseline-compatible guards for route changes, discovery expiration, hidden-tab suspension, late host recovery and out-of-account teardown. Preserve existing instrumented scan/geometry/observer assertions. Commit tests separately if additions are needed.
- [ ] Within `initializeButtons`, extract anchor validation/scanning into `discoverHosts`, placement/layout into `placeButton`, and the current `watchHosts`/missing-host/timer tail into `reconcileDiscovery(widthTarget)`.
- [ ] A small `refreshToolbar` orchestrator preserves the existing sequence: hidden early return; timing/queue synchronization; route-reset handling; out-of-account teardown; discovery; layout reads and writes; discovery reconciliation. Schedule that orchestrator from `refreshButtons` and invoke it synchronously at initialization.
- [ ] Keep the 30-second budget, one-second retry, observer roots, cached width behavior and visibility/click/resize wakeups unchanged. Do not introduce continuous polling.
- [ ] Run focused idle/stage-indicator suites, full suite, syntax and whitespace checks. Commit production only: `refactor: separate toolbar discovery from placement`.

## Final verification

- [ ] Independently review production diff for semantic drift and all checkpoint commit file lists for test/production separation.
- [ ] Run full test suite, syntax and whitespace checks; verify clean Git status.
- [ ] Re-measure hotspot complexity with the same ESLint rules used in the baseline analysis; report any tradeoff honestly.
- [ ] Summarize commits and evidence; do not claim live browser/CRM verification. Keep deferred UI discussion untouched.

## Execution record

Implemented on `refactor/workflow-boundaries`. Checklists above record the original sequence; completed checkpoints:

| Commit | Scope | Full-suite passing tests |
| --- | --- | ---: |
| `eb0d22e` | Tests only: shared evaluation and Web API bootstrap | 465 |
| `7de70f7` | Tests only: workflow ownership guards and temporary state bridge | 468 |
| `89d8552` | Production only: group workflow-owned state | 468 |
| `d4e24ee` | Tests only: remove temporary bridge | 468 |
| `bd496ae` | Tests only: checkpoint storage-failure guards | 470 |
| `fcd0390` | Production only: centralize journal transitions | 470 |
| `e150a86` | Tests only: toolbar discovery lifecycle guards | 473 |
| `6e8a1c6` | Production only: separate discovery, placement and reconciliation | 473 |
| `fff706d` | Production only: retain exact pre-refactor checkpoint restoration assignments | 473 |

The last correction avoids introducing different behavior for malformed stored fields through array/object cloning. Reset still creates fresh evidence containers; restoration retains its original assignments. No new corruption handling is part of this refactor.

ESLint 9 classic cyclomatic complexity: `placeButton` 55 → 30, `run` 50 → 47, `sendSmsApi` 19 → 18. Extracted toolbar boundaries: `discoverHosts` 13, `reconcileDiscovery` 10, `refreshToolbar` 5. Production cloc SLOC is 2,382 versus 2,360 initially: a small increase for explicit boundaries, not a code-size reduction. Shared test helpers eliminate repeated evaluator/Web API setup; endpoint fixtures and clocks remain local.

No version bump, release, push, request changes, visual changes or live CRM writes. Full-suite verification, syntax checks and whitespace checks pass; live browser/CRM behavior remains unverified. Deferred modal UI work remains separate.
