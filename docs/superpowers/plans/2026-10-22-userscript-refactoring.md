# Single-file userscript refactoring plan

> Execution completed sequentially on `refactor/userscript-performance`; tests and production changes were committed separately.

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
- Chunk 1 complete: test commits `762d6b7`, `9699abb`, `bf7b62b`; script commit `f61c408`. Removed sequential approval mode and standalone task-completion orchestration; 668/668 tests pass.
- Chunk 2 complete: test commits `1b9c93e`, `ac4c6fb`; script commit `33ffd47`. Settings reads inventory only, independent of contact recipient validity; sender and send guards retained. Parent reran default `npm test`: 691/691 pass.
- Chunk 3 complete: test commits `25844fc`, `9adf233`; script commit `b135b01`. Weakly cached contact-ID indexes follow array replacement/eviction; observations report changes without serializing rows. 694/694 tests pass.
- Chunk 4 complete: test commit `f4524d1`; script commit `3c094a1`. Constant-size revision identities, single serialization of captured queries, identical catalog recaptures suppressed. 697/697 tests pass.
- Chunk 5 complete: test commit `21126d0`; script commit `f8473cc`. Fetch/XHR share one parsed URL and memoized request-body clone/decode across passive consumers. Existing response consumers are endpoint-disjoint, so no speculative shared-response abstraction was added. 699/699 tests pass.
- Chunk 6 complete: characterization commit `744e689`; script commit `4a9ec02`. Five request lifetimes share timeout/cleanup; four wrappers share native HTTP/JSON mechanics. Reports intentionally retain their distinct denial and abort-race semantics. 709/709 tests pass.
- Chunk 7 complete: test commit `5b5b262`; script commit `ea7a02f`. Journal state and mutation/rollback now belong to one closure with explicit methods; general workflow state no longer owns journal fields. 714/714 tests pass.
- Chunk 8 complete: test commit `2b34050`; script commit `2932dbf`. Stable host subscriptions are retained, four formatters reused per report dialog, and exact observed board snapshots avoid page-wide label scans. No verified picker selector was available in repository fixtures, so the fast path uses validated server record identity instead of inventing a DOM selector; ambiguous label fallback is preserved. 719/719 tests pass.

## Deterministic work reductions

- Native task search observers: two Request clones/body decodes reduced to one shared clone/decode (fetch and XHR tested).
- Stable toolbar: no serialization of whole catalog/query objects; five stable refreshes incur zero observer subscriptions/disconnections instead of 45 observe calls.
- Validated board click with 600 unrelated nested controls: 1,205 geometry checks reduced to fewer than 10.
- Report rendering 90 dates: 360 Intl formatters reduced to four, reused on rerun.
- Settings sender selection: only inventory is requested, rather than contact + inventory + drafts; no valid recipient phone is required.
- History updates: contact lookup uses an index and no row serialization, with explicit tests across 2,000 contacts, task batches, eviction and flush replacement.

These are operation-count guarantees, not measured live-browser latency improvements. No release version bump or push is part of this session.

## Final verification

- Default `npm test`: 719 passed, zero failed (baseline: 657 passed).
- `node --test --test-concurrency=1 tests/*.test.cjs`: 719 passed, zero failed.
- `node --check gohigherlevel.user.js` and `git diff --check 26ca7ed..HEAD`: pass.
- Commit inspection confirms no commit mixes production-script changes with test changes.
- Independent read-only adversarial review: no evidenced high/medium regressions. Checked snapshot identity, revision mutations, history indexes/merges, native fetch/XHR behavior, journal-before-dispatch, receipt retention, sibling draining and no-retry guards.
- Residual risks requiring live-browser validation: CRM board/response timing, out-of-tab opportunity changes, simultaneous cross-tab storage races, native navigation and observer behavior. Existing safety boundaries are preserved; no claim of atomic server or localStorage snapshots is made.
- All planned chunks completed; runtime ownership and performance contracts are documented in `README.md`.
