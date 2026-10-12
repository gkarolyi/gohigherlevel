# Save Progress Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show live, truthful per-action progress in a blocking modal without delaying automatic navigation.

**Architecture:** Keep the existing execution graph and durable checkpoints intact. A run-scoped presentation controller owns a native dialog and structured action evidence; explicit dispatch and verification hooks update it. Confirmation hands off synchronously to progress, and the runner owns terminal success/failure presentation.

**Tech Stack:** Single-file vanilla JavaScript userscript, native HTML dialog, Node test runner, JSDOM.

**Approved spec:** `docs/superpowers/specs/2026-10-12-save-progress-design.md`.

---

## File map and constraints

- Modify `gohigherlevel.user.js`: progress controller near `confirmActions`; hooks in `actionRequest`, `saveStageApi`, `saveNoteApi`, `createTaskApi`, `putCallTask`, `completeCallTask`, `smsApiRequest`, `sendSmsApi`; lifecycle integration in `confirmActions`, `run`, and `openLead`.
- Modify `tests/concurrent-save.test.cjs`: deferred requests and structured evidence assertions.
- Modify `tests/pertama.test.cjs`: real confirmation handoff, modal lifecycle, post-confirmation error-report assertions, navigation.
- Modify `tests/timings.test.cjs` only if fixture adaptation is needed; preserve timing phase names and expectations.
- No new dependency, framework, build step, release/version change, or public API.
- No retries or changes to request ordering, authorization, checkpoint contents, or concurrency.
- Do not parse `completed` strings to infer status. Keep structured presentation evidence separate from recovery data.
- Existing independent call-task and SMS tests must work with no active progress controller.

## Task 1: Add the progress controller and presentation contract

**Files:** `gohigherlevel.user.js`, `tests/pertama.test.cjs`.

- [ ] Add controller-focused failing tests using the existing JSDOM harness (`h.evaluate`, `h.w.document`). Establish this interface:

```js
const p = h.evaluate(`createSaveProgress({ name: 'Ada Lee', pipelineName: 'Sales',
  choices: { stage: true, note: true, task: true, sms: false } })`);
const dialog = h.w.document.querySelector('#pertama-save-progress');
assert.equal(dialog.open, true);
assert.match(dialog.textContent, /Ada Lee/);
assert.equal(dialog.querySelector('[data-action="sms"]'), null);
assert.equal(dialog.querySelector('[data-action="complete"]'), null);
assert.equal(dialog.querySelector('[data-close]').hidden, true);
const cancel = new h.w.Event('cancel', { cancelable: true });
dialog.dispatchEvent(cancel);
assert.equal(cancel.defaultPrevented, true);
assert.equal(dialog.open, true);
p.addCompletion();
p.start('note', 'Saving…');
p.dispatched('note');
p.confirm('note');
assert.equal(dialog.querySelector('[data-action="note"]').dataset.state, 'confirmed');
p.stop('Saving stopped. Check the record before running again.');
assert.equal(dialog.querySelector('[data-close]').hidden, false);
dialog.querySelector('[data-close]').click();
assert.equal(dialog.isConnected, false);
```

- [ ] Run `node --test --test-name-pattern='progress' tests/pertama.test.cjs`. Confirm failure for the missing controller, not fixture setup.
- [ ] Implement `createSaveProgress({ name, pipelineName, choices })`. Return `addCompletion`, `start`, `dispatched`, `created`, `confirm`, `fail`, `phase`, `stop`, and `remove`. Use fixed action keys `stage`, `note`, `complete`, `task`, `sms`; fixed labels; `data-action` and `data-state` attributes. `addCompletion()` inserts before task and is idempotent.
- [ ] Use a Map of rows and structured evidence. The core state transitions are:

```js
function start(key, detail) {
  const row = rows.get(key);
  if (!row || row.state === 'confirmed') return;
  row.state = 'running'; row.detail = detail;
  render(row);
}
function dispatched(key, operation = key) {
  const row = rows.get(key);
  if (row) row.dispatched.add(operation);
}
function created() {
  const row = rows.get('task');
  if (!row) return;
  row.created = true;
  start('task', 'Linking to contact…');
}
function confirm(key) {
  const row = rows.get(key);
  if (!row) return;
  row.state = 'confirmed';
  row.detail = key === 'sms' ? 'Accepted by CRM; delivery not confirmed' : 'Confirmed';
  render(row);
}
function fail(key) {
  const row = rows.get(key);
  if (!row || row.state === 'confirmed') return;
  row.state = row.dispatched.size ? 'unverified' : 'failed';
  row.detail = row.created
    ? row.dispatched.has('link') ? 'Created; contact link unverified. Inspect the record.'
      : 'Created; contact link not sent. Inspect the record.'
    : row.dispatched.size ? 'May already be saved. Inspect the record.' : 'Stopped before saving';
  render(row);
}
```

`render` sets the row's `data-state`, fixed icon, and status text using `textContent`. Never interpolate contact names, messages, or errors into HTML. `stop(report)` preserves confirmed/failed/unverified rows and marks remaining waiting/running rows `blocked` with “Not run”; callers must classify rejected active rows before stopping. Show the report in a wrapping, labelled details section and reveal Close. `remove()` is idempotent and never clears checkpoints.

- [ ] Build a centred native dialog with static markup: labelled heading, contact/pipeline subtitle, rows container, polite live status region, automatic-navigation footer, hidden Close button, and initially hidden error details. Match confirmation width (maximum 510px), 16px corners, white surface, existing font, and `#10182866` backdrop. Use blue running indicators, green ticks, amber warnings, red crosses, and neutral waiting/blocked icons with text. Use `prefers-reduced-motion` to disable spinner animation. Avoid placing the entire technical report in a live region.
- [ ] While running, prevent `cancel`, ignore backdrop dismissal, and offer no focusable operation buttons. Focus a `tabindex="-1"` heading after `showModal`. After stopping, enable Close and Escape dismissal. On explicit Close, focus the original connected control or `runButton`; successful navigation removal must not restore old-contact focus.
- [ ] Add controller tests for confirmed rows surviving `fail`, dispatched vs undispatched failures, task-created/link-not-sent and link-unverified distinctions, blocked waiting rows, literal rendering of HTML-like contact/error text, and idempotent removal.
- [ ] Run the focused tests, then `npm test`; commit only passing changes with `git add gohigherlevel.user.js tests/pertama.test.cjs && git commit -m "Add save progress modal controller"`.

## Task 2: Integrate confirmation handoff and run lifecycle

**Files:** `gohigherlevel.user.js`, `tests/pertama.test.cjs`, `tests/concurrent-save.test.cjs`.

- [ ] Add failing assertions to real confirmation/run tests: before submit only confirmation is open; immediately after valid submit progress is open; cancel creates no progress; revalidation failure is shown in progress with zero browser alerts; early read and checkpoint failures still alert.
- [ ] Add an optional second argument to `confirmActions(context, onConfirm = null)`. In `finish(result)`, after setting `closed` and incrementing `smsLoadVersion`, call `onConfirm(result)` synchronously on acceptance before closing/removing confirmation. Restore `previousFocus` only on cancellation or when no callback was provided. Preserve standalone confirmation tests and result shape.
- [ ] Add `let activeSaveProgress = null` beside workflow state. Inside `run`, keep a local `saveProgress` reference and create it through a single acceptance callback:

```js
const accept = choices => {
  saveProgress = createSaveProgress({ name, pipelineName, choices });
  activeSaveProgress = saveProgress;
};
const choices = await confirmActions(confirmationContext, accept);
```

`confirmationContext` is the existing literal containing contact, name, firstName, phone, stage, rule, due, owner, ownerId, taskTitle, pipelineName, and stageOptions; do not change its data. Before starting a new workflow, dismiss any settled prior progress panel without clearing its checkpoint. Reject a second run while `busy` as today.

- [ ] Adapt the concurrent harness with the same dialog shims used in `tests/pertama.test.cjs`:

```js
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
w.HTMLDialogElement.prototype.close = function () { this.open = false; };
```

Change its `confirmActions` stub to `(context, accept) => { const choices = ...; accept(choices); return choices; }`, using its existing literal choices. Do not add production fallbacks solely for tests.

- [ ] Route existing `progress(message)` to the modal phase while preserving `markWorkflowTiming(message)` and `step = message`. Shorten only the button display:

```js
runButton.textContent = activeSaveProgress
  ? message === 'Opening next lead…' ? 'Opening next lead…' : 'Saving…'
  : message;
activeSaveProgress?.phase(message);
```

Map recheck/preflight to “Preparing actions…”, concurrent saves and SMS to “Saving actions”, and navigation to “Opening next lead…”. Keep the exact current phase detail beneath the heading or in the status region.

- [ ] After preflight, add the completion row only when `preparedTask.task` exists. When it does not, never render a completion tick for a nonexistent write. Until preflight resolves, selected actions remain waiting.
- [ ] In the catch block, retain existing report construction and `console.error`. Use `saveProgress.stop(report)` instead of `alert(report)` if this run has progress; preserve alerts for pre-confirmation failures. In `finally`, clear `activeSaveProgress` and restore button/busy state, but do not remove a stopped modal.
- [ ] Update existing post-confirmation failure assertions (stale confirmation, API failure, changed SMS context) to inspect the modal report with zero alerts. Keep initial read/controls/checkpoint-block assertions unchanged. Close stopped progress before simulating subsequent user actions.
- [ ] Run `node --test tests/pertama.test.cjs tests/concurrent-save.test.cjs tests/timings.test.cjs`, then `npm test`. Commit passing lifecycle changes.

## Task 3: Wire truthful action milestones without changing concurrency

**Files:** `gohigherlevel.user.js`, `tests/concurrent-save.test.cjs`, `tests/pertama.test.cjs`.

- [ ] Add a failing deferred-order test:

```js
test('progress updates independently and task waits for its link', async t => {
  const h = harness(t); const pending = h.run(); await flush();
  const row = key => h.w.document.querySelector(`[data-action="${key}"]`);
  assert.equal(row('stage').dataset.state, 'running');
  assert.equal(row('note').dataset.state, 'running');
  assert.equal(row('complete').dataset.state, 'running');
  assert.equal(row('task').dataset.state, 'waiting');
  h.gates.note.resolve(); await flush();
  assert.equal(row('note').dataset.state, 'confirmed');
  assert.equal(row('stage').dataset.state, 'running');
  h.gates.complete.resolve(); await flush();
  assert.equal(row('complete').dataset.state, 'confirmed');
  assert.equal(row('task').dataset.state, 'running');
  h.gates.task.resolve(); await flush();
  assert.match(row('task').textContent, /Linking/);
  assert.notEqual(row('task').dataset.state, 'confirmed');
  h.gates.link.resolve(); await flush();
  assert.equal(row('task').dataset.state, 'confirmed');
  h.gates.stage.resolve(); await pending;
  assert.equal(h.w.document.querySelector('#pertama-save-progress'), null);
});
```

- [ ] Run the new test and confirm the missing milestone assertions fail.
- [ ] Wrap individual logical actions with a run-local helper (not the combined task lane):

```js
const trackAction = async (key, action, detail = 'Saving…') => {
  saveProgress.start(key, detail);
  try { return await action(); }
  catch (error) { saveProgress.fail(key); throw error; }
};
```

Keep `saveLane`'s existing `stopSaves` behavior and `drainAll`. Track stage and note independently. In the existing task lane, track completion only if a matching task exists; still call `completeCallTask` for the original guard behavior. Before tracking task creation, if `stopSaves` is true, leave its row waiting (terminal stop marks it blocked) and preserve rejection via the existing guard. Track SMS separately after drain. Do not mark rows confirmed in `trackAction`.

- [ ] Place optional controller evidence hooks at these exact boundaries:

| Function | Hook |
| --- | --- |
| `actionRequest` | Immediately before native fetch for mutations, after final approval and durable intent: `dispatched(action, operation)`; never count `stageRead` |
| `saveStageApi` | After all response verification and `completed.push`, before checkpoint cleanup or continuation guards: `confirm('stage')` |
| `saveNoteApi` | After receipt verification and `completed.push`: `confirm('note')` |
| `createTaskApi` | After task ID verification and assignment: `created()`; after link verification and completion evidence: `confirm('task')` |
| `putCallTask` | Immediately before actual PUT dispatch: `dispatched('complete')`; acceptance alone is not confirmation |
| `completeCallTask` | After PUT acknowledgment: `start('complete', 'Verifying…')`; after successful readback evidence: `confirm('complete')` |
| `smsApiRequest` | Only for `operation === 'send'`, immediately before native fetch: `dispatched('sms')` |
| `sendSmsApi` | After acknowledgment IDs validate and accepted evidence is recorded: `confirm('sms')` |

Use `activeSaveProgress?.method(...)`; hooks must be no-ops for missing rows and absent controllers. Preserve all request/verification/authorization code around these insertions.

- [ ] Expand all six existing completion-order tests with row-state checks. Expand failure tests with `unverified` for dispatched malformed/lost/timed-out responses, retained confirmed siblings, no Close while draining, and blocked task/SMS afterward. Add preparation/storage-denial tests distinguishing a failed-before-dispatch row from another lane's dispatched mutation. Test a valid receipt followed by a session/checkpoint failure retains the tick while the overall run stops.
- [ ] Extend SMS integration tests with a gate before send: SMS stays waiting during other saves; accepted acknowledgment produces a confirmed row even if continuation/navigation later fails. Keep existing SMS notification and `SMS_NOTICE_KEY` behavior unchanged: the new modal does not carry over, but this feature does not remove existing SMS receipts/toasts.
- [ ] Run `node --test tests/concurrent-save.test.cjs tests/pertama.test.cjs tests/api-writes.test.cjs tests/api-call-task.test.cjs tests/api-sms.test.cjs`, then `npm test`. Commit passing milestone changes.

## Task 4: Finish navigation, failure and accessibility lifecycle

**Files:** `gohigherlevel.user.js`, `tests/pertama.test.cjs`, `tests/concurrent-save.test.cjs`.

- [ ] Add deferred navigation tests: after saves succeed, heading is Opening next lead and no Close is available; resolve navigation and assert immediate modal removal without timers or confirmation clicks. Reject navigation and assert retained ticks plus a navigation-specific stopped report.
- [ ] Account for `openLead`'s distinction between route commitment and retirement of previous contact controls. Add an optional `onCommitted` callback argument (default null). On the native router path, invoke it after validating router success and destination, before waiting for old-control retirement. `run` passes `() => saveProgress.remove()`. Leave all route checks, retirement guards, timings and other `openLead` callers unchanged. On full-document fallback, page unload naturally removes the dialog; remove after successful return as well, never before calling `location.assign`.
- [ ] If a later retirement/readiness check fails after committed navigation, show a stopped result dialog again, labelled with the original contact. Implement controller `stop(report)` to reattach and show its existing dialog if removed. This is an error report, not successful progress carried to the next contact. Retain the unchanged readiness guard preventing workflow on stale controls.
- [ ] Remove progress after `await openLead(next)` as an idempotent success cleanup. For an empty queue, remove before the existing saved/empty-queue `taskNotice`. Do not remove in unconditional `finally`.
- [ ] Add tests for route commitment followed by delayed old-control retirement (no progress on the new lead), commitment followed by retirement error (stopped report can be closed), full-page fallback call, empty queue, unchanged task/SMS warnings, and failure during navigation retaining the checkpoint.
- [ ] Assert Close does not mutate checkpoints or issue requests, successful removal does not focus old-contact controls, Escape/backdrop cannot dismiss running progress, and settled Close restores connected focus. JSDOM tests assert structure/events, not native focus trapping or visuals.
- [ ] Run final automated verification:

```sh
npm test
node --check gohigherlevel.user.js
git diff --check
```

Expected: all tests pass, no syntax or whitespace failures. Review the actual diff to ensure no request graph or safety guard changed. Commit passing navigation/lifecycle tests and implementation.

- [ ] Perform a manual browser check when CRM access is available: confirmation handoff without visual flicker; centred modal at narrow viewport; keyboard blocking; spinner and reduced-motion behavior; independent rows under slow requests; no extra click/delay; removal at next-contact route commitment; inspectable partial failure. Do not issue live CRM mutations without an approved test record. If unavailable, report manual verification as outstanding rather than claiming it passed.

## Plan self-review

Coverage: presentation/controller and accessibility (Task 1); seamless handoff, phase feedback and report routing (Task 2); concurrency, dependencies and evidence-based outcomes (Task 3); auto-navigation, empty queues, failures and teardown (Task 4). State keys and controller methods are consistent throughout. Existing SMS notices remain unchanged; only the new progress modal has the no-carryover requirement. Preserve timing labels even though the button label is shortened. No implementation or live CRM testing is authorized by this document alone.
