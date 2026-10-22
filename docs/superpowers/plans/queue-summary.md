# Passive queue summary implementation plan

**Goal:** Show muted queue counts beside Save and next, without manual refresh or polling.

**Architecture:** Reuse the exact navigation query builders for count reads. Normal mode sums selected pipeline stage aggregation docCounts and uses due-task total; these are opportunities/tasks, not deduplicated calls. Same-stage mode subtracts a current-contact-scoped stage aggregation using the existing `contact_id` equality filter demonstrated by `contactOpportunityQuery`; incomplete or unverified counts display an em dash rather than guessing. Background reads never block saves.

**Files:** `gohigherlevel.user.js` for query extraction, count lifecycle and toolbar; `tests/queue-summary.test.cjs` for focused jsdom regressions; `README.md` for count semantics.

- [x] Extract synchronous pipeline and due-task query construction without changing navigation behavior; count queries must use identical filters and fresh due cutoff.
- [x] Add test-first strict aggregation/task-total validation and fail-closed same-stage current-contact exclusion.
- [x] Add muted `#pertama-queue-summary` adjacent to Save and next. Render counts in priority order, stage label plus remaining count in same-stage mode, em dashes on errors, and tooltip explaining opportunity/task semantics.
- [x] Coalesce background refreshes keyed to route, verified user, settings/query changes, and completed writes. Ignore stale responses; do not poll or retry failed reads on unrelated UI mutations. Keep requests out of busy saves and hide on account/contact departure.
- [x] Verify existing navigation/idle UI tests and new lifecycle tests, run full suite, syntax and whitespace checks; document live CRM validation limits.

## Acceptance checks
- Normal totals count queue records, not unique contacts; tooltip makes this explicit.
- One failed category never becomes zero or hides a valid other category.
- New leads use selected pipelines, configured stage and assigned-or-followed user scope; follow-ups retain navigation's task filters and due-now cutoff.
- Stage summary uses the pinned original stage, not the suggested destination, and subtracts all matching current-contact opportunities through a same-filter contact-scoped count (not just the first page of hits).
- Late results from another route/account/settings snapshot cannot appear; count failure cannot interrupt Save and next or change its state.
- Unrelated mutations and repeated toolbar refreshes do not cause requests; completed writes trigger a fresh snapshot even when staying on the current contact.
- No new persisted counts, timers for polling, or manual refresh control.
- Confirm the summary reattaches after native toolbar replacement and hides outside the configured CRM account.

## Verification

22 queue-summary tests and all 657 suite tests pass. JavaScript syntax and git whitespace checks pass. Review found initialization, hidden/busy completion, and credential-change edge cases; regression tests reproduced them before fixes. Live CRM aggregation/visual validation is still required. Version prepared as 1.0.19; no commit or release performed.
