# Idle Overhead Reduction Implementation Plan

> Use the existing checkout as requested. Write failing behavioral/work-budget tests before implementation; review and commit only related files.

**Goal:** Remove persistent page-wide layout work while preserving button placement, SPA behavior, queue guards, and save verification.

**Architecture:** Replace `setInterval(placeButton, 500)` with a requestAnimationFrame-coalesced controller. Cache navigation anchors, read layout only for relevant anchors, and update text/styles only when different. Observe cached anchors and their ancestor chain without a permanent document-wide subtree observer. Use a temporary, bounded discovery observer while required hosts are still mounting; inspect added subtrees rather than repeatedly scanning the page. Route/visibility/resize events and explicit script state changes wake the controller. Leave network response capture and synchronous save checkpoints unchanged; deduplicate identical authentication headers and query persistence.

**Files:** `pertama.js`, `tests/idle-ui.test.cjs`, `tests/pertama.test.cjs`, `tests/timings.test.cjs`.

## 1. Regression and work-budget tests

- Measure startup visibility/layout reads on a fixture containing hundreds of unrelated links/buttons. Those reads should scale with actual anchors, not document size.
- Stable idle UI must not register the old 500 ms interval or generate recurring scans/mutations.
- Repeated refresh requests must coalesce; unchanged labels/styles must not be rewritten; own UI mutations must not cause an observer loop.
- Unrelated main-content mutations must not trigger scans/layout work after anchors are found.
- Replace sidebar/header hosts and navigate between contact/account routes; controls must reattach/hide correctly. Test delayed mounting, resize, queue label changes, and hidden-tab suspension.
- Once hosts are found, no body/document subtree observer should remain active. Discovery is bounded to 30 seconds and can be retriggered by route/visibility/user interaction if mounting takes longer.
- Test identical query captures do not rewrite localStorage, changed captures do, and unchanged credentials are not repeatedly decoded while changed/expired identities remain fail-closed.

## 2. Controller implementation

- Add a closure-level `refreshButtons` callback, initially a no-op, installed by `initializeButtons`. Keep initialization idempotent even when the contact button is not mounted.
- Wake it from path changes, queue/catalog/settings changes, window resize, visibility restoration, and relevant DOM mutations.
- Initial discovery performs one text-based navigation scan; only matching labels get visibility checks. Subsequent discovery inspects added roots or retries once after route/visibility changes, not on a timer forever.
- Use scoped structural observers on anchor ancestor chains to detect host replacement. Ignore the script's own button mutations. Use ResizeObserver where supported, with resize-event fallback.
- Separate layout reads from DOM writes. Keep existing button IDs and relative placement. Ignore unrelated mutations; disconnect temporary discovery once ready; do not do placement work in hidden tabs or other CRM accounts.
- Keep navigation timing readiness sampling tied to relevant placement/mount events instead of periodic scans.

## 3. Observer bookkeeping

- In `captureReadHeaders`, compare incoming authentication values with the in-memory values; avoid rebinding unchanged valid credentials. Expiry checks in `requireVerifiedUser` remain intact; never persist credentials.
- In `rememberQuery`, serialize once, cache the last successfully persisted string per queue, and write only when it changes. Memory query templates still update, and failed persistence can be retried later.
- Do not debounce save checkpoints or relax server receipts. Do not change board snapshot coverage or move parsing into a worker without profiling evidence.

## 4. Verify

Automated verification: 105 tests pass; JavaScript syntax and whitespace checks pass. Independent final review found no high-signal issues. Regression tests were observed failing before the controller/bookkeeping changes, including unnecessary polling, layout work, missing replacement recovery, cached-label reuse, and overly broad observation when hosts are direct children of an app root.

With 600 unrelated links/buttons, the fixture measured startup changing from two global scans / 1,209 visibility reads / one geometry read to one global scan / five visibility reads / one geometry read. A stable simulated 60-second idle period produces no additional scans, visibility/geometry reads, or observer records. Main-content-only mutations do not wake mounted UI. These are structural work counts in jsdom, not browser CPU/layout timings.

Run `npm test`, `node --check pertama.js`, and `git diff --check`; independently review and commit as v0.2.12. Work-count fixtures establish eliminated overhead, not a measured live speedup. In the browser, compare equivalent Performance recordings with script disabled/enabled, reloading between runs; inspect scripting/layout/long tasks and typing/scrolling responsiveness.
