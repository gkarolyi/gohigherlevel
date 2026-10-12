# Concurrent Saves Implementation Plan

**Goal:** Reduce save latency by overlapping independent reads and writes while preserving durable evidence, no-retry behavior, and task ordering.

**Architecture:** Retain the single userscript and existing endpoint-specific verification. Preflight stage version and exact existing Call task before any writes. Enable a scoped concurrent approval that accounts only for this workflow's own cache invalidations, never external writes. Track each pending operation separately while retaining the legacy pendingSave summary for checkpoint compatibility. Drain all save lanes before SMS, navigation, or releasing busy.

**Files:** Modify `gohigherlevel.user.js`; add `tests/concurrent-save.test.cjs`; adjust sequential integration expectations in `tests/pertama.test.cjs`; add read-overlap coverage in `tests/api-call-task.test.cjs`.

## Steps
- [x] Write deferred-transport tests for overlap, all settlement orders, partial failure/draining, independent checkpoints, external mutations, route/auth changes, storage errors, and completion-before-creation. Run and observe failures.
- [x] Extract Call-task preflight; concurrently read contact/task pairs with allSettled draining. Separate stage-version preflight from mutation.
- [x] Add operation-keyed pending-action journaling, preserving pendingSave as a human-readable summary and old checkpoint compatibility.
- [x] Track owned stage invalidation increments/pending counts on the approved context. Concurrent approval permits these known increments only, while read caches remain invalidated and blocked during stage writes. Standalone helper guards stay unchanged.
- [x] Dispatch stage, note, and completion→creation/link lanes after preflight. Completion uses the prepared exact task; note/new task use the freshly approved contact snapshot instead of redundant reads during owned stage mutation. Every lane failure stops future dispatches, but previously sent writes are verified and journaled. Await allSettled before reporting errors. SMS remains sequential and last.
- [x] Update integration tests to the approved snapshot semantics (stage-induced owner changes no longer force a stage-first barrier), preserving external-change rejection and no duplicate retries.
- [x] Run `npm test`, `node --check gohigherlevel.user.js`, `git diff --check`, inspect the full diff. Do not version or push without request.

**Accepted tradeoff:** A contact owner changed by CRM automation after preflight may not prevent already-approved concurrent requests. Requests already sent can succeed after another lane fails; record all outcomes, block navigation, and never automatically retry.
