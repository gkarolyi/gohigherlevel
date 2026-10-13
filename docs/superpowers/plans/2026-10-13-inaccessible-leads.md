# Inaccessible Leads Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On demand, find contacts from the user's recent calls, visible outstanding tasks, and remembered follow-ups that now return permission denied, retaining names and last-known tasks locally.

**Architecture:** Extend the single userscript with bounded, user/location-scoped local history and a dedicated read-only report controller. Existing validated contact/task reads and confirmed task writes supply history without background network activity. Report requests use the captured CRM session, exhaustive bounded pagination, explicit current-user filtering, sequential contact checks, cancellation, and incomplete-result warnings.

**Tech Stack:** Vanilla JavaScript userscript; localStorage; node:test/jsdom.

## Scope and contracts

- No ownership/reassignment inference, polling, server, automatic reporting, or private HAR fixtures.
- Default 30-day call lookback; options 7/30/90 days. Pending remembered follow-ups remain candidates independently of the call window.
- Calls: `https://backend.leadconnectorhq.com/reporting/calls/get-all-phone-calls-new`, POST with locationId, userId, startDate/endDate, limit/skip and recorded empty optional filters. Validate/filter rows by caller userId, location, IDs and date; do not use assignedTo as caller identity. Paginate against totalRows, detect repeated/incomplete pages, cap work with an explicit error rather than claim completeness.
- Tasks: services `/objects/task/records/search`, page/pageLimit, locationId, completed=0; filter returned owners to the verified user, validate contact relations. Do not carry saved board/task date filters or ignoreAssignedToPermission=true into report searches. Errors mean task coverage is incomplete, not 'no tasks'.
- Contact checks: backend `/contacts/{id}`, bypass cache. A specific permission-denied response is an inaccessible result; generic authentication rejection aborts. Network/404/schema failures are unresolved, not inaccessible. Check identity, location and cancellation across awaits; validate the session again after denied results before presenting a completed report.
- Cache names, IDs, last accessible/call timestamps and minimal task details (title/due/completion/observedAt) only. No credentials, phone numbers, emails, notes, recordings or full responses. Bound retention and record counts; expose limits and storage failures in UI/docs. Persist in batches, flush on pagehide, merge other-tab updates instead of clobbering history.
- Observe only relevant successful native reads, through fetch and XHR. Existing internal reads and verified created+linked tasks also feed history. Task disappearance must not imply completion. Verified completion/readbacks update remembered state.
- UI: a sidebar 'Inaccessible leads' button and one dialog with lookback, Run, Cancel/Close, progress, warnings, and one plain-text-safe row per inaccessible contact. Columns: saved name/ID + contact link, last call, last accessible, follow-up last known outstanding (title/due/observation time). Distinguish complete empty results from incomplete/cancelled runs. No writes to CRM.

## Task 1: History and report engine

**Files:** modify `gohigherlevel.user.js`; create `tests/lead-access.test.cjs`.

- [x] Add failing tests using `evaluateUserscript` for bounded user-scoped history, persistence/reload/denied storage, no unchanged writes, and no background fetches.
- [x] Run `node --test tests/lead-access.test.cjs` and confirm missing feature failures.
- [x] Implement history helpers and narrow passive/internal observation hooks; test confirmed task association/completion versus uncertain writes.
- [x] Add failing report tests for own-call filtering, pagination, deduplication, remembered missing tasks, names after access loss, exact denial versus session/network failure, stale context, and cancellation.
- [x] Implement the dedicated report engine without widening the existing workflow transport; run focused tests until green.

## Task 2: Dialog and integration

**Files:** modify `gohigherlevel.user.js`; create `tests/lead-access-regressions.test.cjs`; extend `tests/idle-ui.test.cjs` only as needed.

- [x] Test sidebar visibility/remounting/account guards, no requests on dialog open, run/progress/cancel, safe text rendering, names/ID fallback, incomplete states, and prevention of duplicate runs.
- [x] Implement the dialog and integrate its button without changing existing anchor adjacency or adding idle timers/observers.
- [x] Run `node --test tests/lead-access*.test.cjs tests/idle-ui.test.cjs`.

## Task 3: Review and verification

**Files:** modify `README.md` and userscript version metadata/constant.

- [x] Document use, browser-local history, retention, missing historical names, last-known task semantics, and unverified live task-search behavior.
- [x] Review implementation against scope and request contracts; then review correctness/security/performance separately. Both reviews passed after persistence, lifecycle, and task-observation ordering fixes.
- [x] Run `node --check gohigherlevel.user.js`, `npm test`, and `git diff --check` (553 tests passing).
- [x] Inspect final diff for unrelated edits, credentials, or personal data. No commits or publishing without user request.

## Approved UI follow-up

- Move the report launcher from the sidebar into a Reports section at the bottom of Workflow settings; preserve unsaved settings when returning.
- Match the settings dialog's typography, border, backdrop, spacing and controls. Use a compact table: Contact / Last call / Remembered follow-up / Due.
- Show each contact ID once; missing names use "Name unavailable", missing dates use an em dash. Format dates/times in WITA, including date-only task deadlines at 11am.
- Remove static caveats and observation timestamps from the report; retain concise actionable failure warnings and the detailed documentation here/README.
- Test default period, progress/cancel states, empty/incomplete distinction, escaped data, settings preservation, sidebar removal, and readable dates.

### Missing call-date investigation

`requests/inaccessible.har` captures the userscript's actual 30-day request: an empty selectedPool with the authenticated userId returns totalRows:0, totalPages:0 and rows:[] on both initial lookup and final revalidation. Its pending-task search returns 33 records, including the inaccessible contact's owned follow-up due 14 October at 11am WITA. The missing call date is not a timestamp rendering, merge or storage bug.

`requests/calls.har` captures a working native weekly query with a selected phone pool and empty userId: 75 calls over two pages (50 captured), including the same contact's own call on 12 October at 14:19 WITA and a contact permission denial. Joining the location inventory in `requests/cmdk.har` by linkedUser equal to the authenticated user produces exactly that native pool. The fix therefore uses this observed native request pattern, not a guessed user filter. Inventory is fetched only on Run through the report's read-only transport, validated for complete totals, unique E164 numbers, linkage and voice capability. All own voice numbers are selected, including voice-only numbers; other users, unassigned numbers and SMS-only numbers are excluded. No usable complete inventory means an explicit call-coverage warning while task/remembered candidates remain available. No empty-pool call requests are sent.

`tests/lead-access-call-dates.test.cjs` retains the timestamp merge/persistence assertions. `tests/lead-access-pool.test.cjs` reproduces the zero-result empty-pool behavior and checks the corrected contract, pagination/revalidation, incomplete inventory, cancellation and user changes.

## Live validation after installation

The general task listing is now observed live. The corrected userscript query still requires a real Run report rerun: confirm own-call counts, task coverage and the known inaccessible contact's last-call date. Matching the native wire contract and automated tests do not establish that this corrected report has already been live-verified. Report API/schema failures visibly, never as a clean empty result.
