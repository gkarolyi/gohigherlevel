# Contact Stage Indicator Plan

**Goal:** Show the linked open opportunity's current stage beside the central conversation contact name.

**Architecture:** Target the supplied `data-testid="CENTRALPANEL_NAME"`, inserting a neutral text badge after its display-contents wrapper. Reuse validated contact/opportunity caches and coalesced reads. Use the recorded origin ID or a unique eligible opportunity; never use the pinned navigation queue's original stage. Observe only the name container and its ancestry via the existing scoped UI observer. Discover a late-mounted header with bounded retries only when a verified contact session exists. No periodic network or idle UI polling.

**Files:** Modify `gohigherlevel.user.js`; add `tests/stage-indicator.test.cjs`; preserve existing UI idle-overhead and API-read tests.

- [x] Write failing tests for central-only placement, current versus pinned stage, origin disambiguation, closed/ambiguous/unknown opportunities, native stage changes, stale navigation responses, retained header names, mounting/replacement, read failures, no unauthorized requests, and idle behavior.
- [x] Keep optional API opportunity status when supplied; omit it when absent for existing payload compatibility.
- [x] Add an indicator update using valid cached contact/opportunity values, with at most one read attempt per contact/user/epoch/route revision when data is missing. Guard display against a retained header belonging to a different contact name.
- [x] Hide stale labels synchronously on contact-read invalidation. Refresh on verified cache completion/passive reads, catalog changes, contact routes and finished workflows.
- [x] Integrate the central-name host into scoped observation and bounded missing-header discovery. Ignore owned mutations and avoid repeated DOM writes.
- [x] Run all tests, syntax and diff checks; review behavior. Commit this feature as its own logical chunk, without versioning or pushing. Leave follow-up task discovery for its own discussion.

**Compatibility:** Existing API payloads lacking status retain legacy opportunity eligibility; explicitly non-open opportunities do not get a badge. Missing metadata or ambiguous opportunity selection hides the badge rather than displaying a guess.
