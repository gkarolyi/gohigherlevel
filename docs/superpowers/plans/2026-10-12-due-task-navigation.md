# Due-Only Follow-Up Navigation Plan

**Goal:** Find pending follow-up tasks already due without requiring a visit to Tasks → Overdue.

**Evidence:** The supplied saved task query has `properties.dueDate` range upper bound `2026-10-12T05:01:04Z`. `topTaskContact` clones it and changes only page, so the boundary remains frozen. The default query has no date constraint at all.

**Architecture:** Build a fresh due-date constraint on each lookup, removing captured date predicates while preserving pending-status, owner/other non-date filters, query options and sort. Use the demonstrated range operator with a historical lower bound and a current UTC upper bound. Leave the stored template unchanged. Validate that the top returned task has a finite, explicit due date not later than the request cutoff before choosing its contact. Never skip an invalid top task silently.

**Files:** Modify `gohigherlevel.user.js`; add `tests/due-task-navigation.test.cjs`.

- [x] Write failing tests for saved stale cutoff, default due-only lookup, advancing clock/day, frozen template preservation, retention of owner and sort filters, replacement of stale date windows, and due/overdue/future/malformed response boundaries.
- [x] Observe regression failures before modifying production code.
- [x] In `topTaskContact`, clone the template, keep the completed=0 guard, remove old date conditions recursively and add `range` with `gte: '1901-01-01T00:00:00Z'`, `lte: new Date().toISOString()` under an AND group.
- [x] Pass the cutoff into `taskContactFromResponse`; reject missing/invalid/future due dates without navigation. Keep empty-response and association validation behavior.
- [x] Explain due-only refreshed lookups in settings help. Run full tests, syntax/diff checks and review the patch.
- [x] Commit this fix independently; do not version or push.

**Scope:** No future tasks, no owner-filter redesign, no sort redesign, no change to Same stage mode (which intentionally does not consult tasks).
