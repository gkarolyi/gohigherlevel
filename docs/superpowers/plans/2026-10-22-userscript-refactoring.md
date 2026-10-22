# Single-file userscript refactoring plan

**Goal:** Reduce unnecessary CPU/network work and make state ownership explicit without changing CRM write safety or introducing a build step.

**Architecture:** Keep `gohigherlevel.user.js` as the directly installed artifact. Use small internal closures and narrow helpers, not a framework. Preserve account/session/route guards, durable intent before writes, receipt verification, no write retries, sibling draining, retention and cross-tab merges.

**Tech stack:** Browser JavaScript, Tampermonkey, node:test and jsdom.

## Execution rules

- Branch: `refactor/userscript-performance`.
- Work sequentially. Never edit production and test files in the same phase or commit.
- Each behavior/performance improvement: tests-only phase, run and inspect expected failures, commit tests; implementation-only phase, run focused tests and full `npm test`, inspect diff, commit script.
- Pure refactoring: establish passing characterization tests first, commit test changes separately, then change only production code and keep the full suite green.
- Update this log after each logical chunk. Do not change user-facing defaults or publish a release/version bump.
- Baseline: 657 passing tests; clean working tree at `26ca7ed`.

## Ordered chunks and checks

1. **Remove unused execution modes.** Production writes use only the concurrent approved preflight snapshot. Migrate direct-helper tests to that context before removing `parallel`/`expectedWrites` sequential branches. Make task completion a prepared Save-and-next operation, removing its unused standalone orchestration. Preserve guards, uncertain-write evidence, accepted receipts, completion-before-follow-up and owned invalidation accounting. Run API write/task/SMS and concurrent-save suites, then all tests.
2. **Split SMS inventory discovery.** Settings needs only phone inventory, not contact details/drafts. Test request counts, invalid recipient independence, malformed inventory, user/session changes and unchanged send preflight behavior. Extract inventory validation/selection and use it from Settings. Run SMS/settings/report suites and all tests.
3. **Index history.** Add a contact-ID index to the per-user in-memory history; retain array persistence, bounded retention and merging. Replace JSON-before/after change detection with explicit mutation results. Test large batches with operation counts, older-task no-ops, eviction, retention, cross-tab merges and storage errors. Run lead-access/task suites and all tests.
4. **Use queue input revisions.** Replace whole-catalog/query JSON identity with explicit settings/catalog/query/queue revisions. Serialize captured queries once; deduplicate unchanged metadata. Test stable refresh cost, every invalidation source, lazy query loads and stale async publications. Run queue-summary/idle-ui/stage suites and all tests.
5. **Normalize passive interception.** Build one descriptor per native request, memoize body decoding and share lazy JSON response parsing among interested observers. Keep native fetch promise identity and XHR behavior. Test body/response parse counts, irrelevant traffic, observer failure isolation, synchronous native failures and write counters. Run reads/history/queue suites and all tests.
6. **Consolidate request mechanics.** Introduce only a private transport-mechanics helper for timeout, native fetch, JSON envelope and diagnostics. Keep read/write/report endpoint policy and guards in their callers, final write guards synchronous with dispatch, durable receipts in callers, and report cancellation semantics. Establish characterization tests for timeouts, non-JSON errors, redirects, diagnostics and late session changes before editing. Run all transport-related suites and all tests.
7. **Encapsulate journal ownership.** Group pending operations, summary, completed evidence, persistence and rollback behind one internal journal closure. Keep workflow orchestration and approval distinct. Test durable-before-dispatch, storage failures, sibling receipts, restore/clear and SMS continuation. Use explicit methods rather than an event bus. Run concurrent-save/checkpoint/SMS suites and all tests.
8. **Reduce DOM/report overhead.** Prefer the verified board pipeline-picker structure (inspect existing fixtures/recorded selectors before choosing it), preserving ambiguity checks and broad fallback when unavailable. Cache report date formatters and unchanged observer subscriptions. Test scoped lookup cost, ambiguous selection, host replacement, hidden/reused anchors, no idle scans/writes, WITA date output. Run idle-ui/report/settings suites and all tests.
9. **Final verification/review.** Run full suite and syntax check, inspect complete diff for changed behavior and safety regressions, confirm commit separation and clean working tree. Record deterministic performance improvements and limits of jsdom (no real-browser latency claims).

## Progress

- Planning/baseline complete: clean baseline, 657/657 tests pass.
