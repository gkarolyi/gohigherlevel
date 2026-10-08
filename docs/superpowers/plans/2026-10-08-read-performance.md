# Read Preparation Performance Implementation Plan

> Work in the existing checkout (user explicitly rejected worktrees). Use test-driven development, review the diff, and commit only related files.

**Goal:** Reduce redundant preparation interactions, overlap independent waits safely, and expose measurements instead of guessing at further bottlenecks.

**Architecture:** Keep the standalone userscript and sequential saves. Reuse already-visible name inputs; otherwise open All fields once and wait for both inputs together. Once the name is read, overlap the passive owner lookup with SMS activation, using `Promise.allSettled` so no unfinished background activation survives failure. Add bounded tab-local timing records with fixed phase labels, no contact/message/authentication contents, and a separate next-document toolbar-visible measurement.

**Tech Stack:** Browser JavaScript; existing Node/jsdom regression suite.

## Files

- `pertama.js`: name-read fast path, owner/SMS coordination, workflow phase timing and navigation measurement.
- `tests/pertama.test.cjs`: behavioral regressions using the existing full-script harness.
- `tests/timings.test.cjs`: deterministic timing, storage, and navigation-marker tests.

## 1. RED: preparation behavior

- Test visible first/last inputs with no All fields tab: `readContactName()` returns names without tab interaction.
- Test hidden/missing inputs: All fields is clicked exactly once and both inputs must be visible before reading. Preserve first-name-empty/last-name-only behavior and empty-name rejection.
- Test `readOwnerAndPrepareSms()` starts SMS preparation while owner text is still loading. Neither promise may be abandoned on failure: settle both before returning/rejecting. Preserve SMS-unavailable as an optional error value, but propagate owner failures.
- Run `npm test`; observe feature failures before implementing.

Coordinator contract:

```js
async function readOwnerAndPrepareSms() {
  const results = await Promise.allSettled([
    wait(() => {
      const box = document.getElementById('owner-dropdown-trigger');
      return [...(box?.querySelectorAll('*') || [])].filter(el => !el.children.length)
        .map(text).filter(t => t.length > 2).sort((a, b) => b.length - a.length)[0];
    }, 'contact owner in #owner-dropdown-trigger'),
    prepareSms(),
  ]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return { owner: results[0].value, sms: results[1].value };
}
```

The owner predicate remains the current leaf-text lookup in `#owner-dropdown-trigger`; it does not click or focus anything. Do not overlap SMS activation with opening All fields or the opportunity editor.

## 2. RED: timing behavior

- `window.pertamaWorkflowTimings` exposes at most 50 flat records: `{ action, phase, elapsedMs, result }`.
- `startWorkflowTiming(action, phase)`, `markWorkflowTiming(phase)`, and `finishWorkflowTiming(result)` use a monotonic clock for phases and a total row. Confirmation time is its own phase, not attributed to opportunity loading.
- Preserve records in `sessionStorage` under `pertama:workflow-timings:${LOCATION_ID}` so they survive full-page navigation. Storage failure must not change workflow outcomes.
- `openLead()` stores a private navigation marker under `pertama:navigation-timing:${LOCATION_ID}` with target contact ID, source `performance.timeOrigin`, and wall-clock start. Do not emit the contact ID into timing records.
- `recordNavigationReady()` runs from button placement. Only a new document, the correct account/contact, and a visible Companies toolbar control count; record the duration as `Navigation / Contact toolbar visible`, not as full CRM readiness. Ignore malformed/expired markers and clear successfully consumed markers.
- Test phase durations, bounds, persistence, optional storage failures, separated confirmation, wrong-contact/same-document rejection, and one-time navigation measurement.

## 3. Implement and integrate

- Implement the name fast path and owner/SMS coordinator without changing SMS opt-in or recipient/draft/send validation.
- Feed existing `progress()` transitions into timing phases. Add explicit confirmation/applying phases. Begin/end timing in both `run()` and `nextLead()`, including cancelled/stopped outcomes.
- Retain actual opportunity/modal stage reads, save order, response verification, task association checks, and full-page navigation. No new endpoints or unverified contact-response schemas.
- Bump script/diagnostic version to `0.2.11`.
- Run `npm test`, `node --check pertama.js`, and `git diff --check`; independently review and commit.

## Automated verification

Preparation regression tests failed before implementation (unnecessary All fields timeout and missing concurrent coordinator), then passed. Timing tests likewise failed before their implementation. All 75 tests now pass, including full Save and next/Next lead timing integration, stale-confirmation protection, failure draining, bounded history, storage denial, and navigation guards. JavaScript syntax and whitespace checks pass. Independent adversarial review found no supported high-signal issues; live GHL performance has not been measured.

## Live verification

Install/reload, perform representative workflows, then inspect:

```js
console.table(window.pertamaWorkflowTimings)
```

The last 50 records stay in this browser tab across reloads. `elapsedMs` is milliseconds; `Total` includes human confirmation/queue-selection time. Those waits have separate phases, so do not mistake them for CRM latency. `Navigation / Contact toolbar visible` is an approximate UI milestone sampled by button placement (up to 500 ms polling delay), not proof that every CRM panel is ready. Navigation markers expire after two minutes; records contain no contact IDs, phone numbers, message contents, or credentials.

Compare preparation, confirmation, saves, lookup, and navigation separately. Automation tests prove avoided clicks and overlapping waits, not live GHL speedups. Further response caching/navigation changes depend on these measurements and actual response/UI inspection.
