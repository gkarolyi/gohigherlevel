# GoHigherLevel

A single-file Tampermonkey userscript for the Pertama CRM. No build step is needed.

## Install

Install [Tampermonkey](https://www.tampermonkey.net/), then open the [raw userscript](https://raw.githubusercontent.com/gkarolyi/gohigherlevel/main/gohigherlevel.user.js) and confirm installation. If you already installed a local copy, check Tampermonkey for a duplicate and keep only the GitHub-installed script.

## Updates

The script's `@updateURL` and `@downloadURL` point to the raw file on the `main` branch. To publish an update, change the `@version` metadata and the matching `VERSION` constant in `gohigherlevel.user.js`, run the tests, and push the updated file to `main`. Tampermonkey checks for new versions on its update schedule; you can also use its **Check for userscript updates** command.

## Workflow defaults

In **Workflow settings**, each shared stage rule chooses the default actions for **Save and next**: update stage, add note, add follow-up task, and send SMS. You can override every selection before confirming; selecting SMS only loads its options, and does not send a message.

Current and suggested next stages come from the checked pipelines. Saved stages that are no longer available remain visibly labeled and can be kept when saving unrelated settings. The suggested next stage stays editable even when stage updates are off. Follow-up days appear only when the task default is on; turning it off preserves the saved days (including zero). Tasks require a valid contact owner. With Add task enabled, **0 or blank follow-up days** defaults to three hours after opening confirmation (to the minute), even if that crosses midnight. Positive days default to 11am WITA on that future day.

In **Save and next**, use **Scheduled for (WITA)** to choose an exact date and time for this save only. Changing follow-up days recalculates this picker; other action toggles preserve your chosen time. All picker values use WITA (UTC+8), regardless of your browser timezone. Existing saved rules are not changed.

### Queue summary

A muted summary beside **Save and next** shows **New leads N · Follow-ups due N**, ordered by your queue priority. These are matching opportunity and due-task totals—not calls or unique contacts—and use the same filters as Next lead. No selected pipelines means zero new leads.

Same-stage mode shows **Stage · N remaining**, excluding all opportunities for the current contact. It uses two bounded aggregation reads (the full queue and the same queue restricted to this contact), including queues larger than the returned top hits. The reads are not an atomic server snapshot; concurrent CRM changes can affect counts. Invalid, failed or incomplete counts show **—**, never a guessed zero; the other category can still appear.

Counts refresh when opening a contact, after Save and next finishes (including when no navigation occurs), and when settings or captured list filters change. Reads require a verified CRM session and visible contact toolbar, do not block workflow saves, and do not poll or automatically retry errors. There is no refresh button. Account/contact/session changes discard stale replies.

**Live validation:** compare both queue totals and same-stage remaining against the native CRM filters before relying on them; automated tests do not verify live aggregation behavior.

### SMS templates

In **Workflow settings → SMS templates**, add named messages using `{firstName}` and `{fullName}`. Your previous SMS message becomes **Default** automatically. Default's message is editable, but its name and entry are kept as the global fallback. Templates remain local to this browser and CRM account.

Each shared stage rule has a **Default SMS template** selector, independent of its **Send SMS** toggle. Stages with no rule or no selected template use Default. Renaming a template preserves rule selections; to remove a referenced template, first change those rules to another template.

With SMS enabled in **Save and next**, click a template button to immediately replace the message with its personalized text. This discards any edits in the editor without a warning. Editing the message does not change the saved template, and toggling SMS off and back on preserves the current text. Template buttons never send: sending still requires **Confirm & next**, with existing sender/recipient checks and no automatic retries. Native CRM drafts remain untouched.

Older rules retain their defaults: notes on, SMS off, and tasks on when follow-up days were set. Stages without a rule retain their existing defaults.

## Inaccessible leads

Open **Workflow settings → Reports → Inaccessible leads** at the bottom of settings, choose a call window (30 days by default; 7 or 90 also available), then **Run report**. Opening the report makes no requests and leaves your unsaved settings unchanged; Close or Escape returns to settings. The report checks contacts from your calls, your visible pending tasks, and remembered outstanding follow-ups even outside the call window. It shows one row per explicitly inaccessible contact, with the saved name (or “Name unavailable”), contact link/ID, last call date, and remembered pending task titles and due dates. Dates use WITA; date-only workflow deadlines are shown at 11am. Share the relevant rows with your manager; this is not proof of ownership or current task status.

Names and tasks can disappear after access is lost, so validated reads during normal CRM use and confirmed linked follow-ups created by the script are remembered locally. History is scoped to this CRM location and the verified signed-in user, limited to 180 days, 2,000 contacts and 20 tasks per contact. Only IDs, names, timestamps and minimal task fields are retained—no phone numbers, notes, credentials or full responses. Writes are batched and flushed on page exit. There is no sync, additional background lookup or polling. Clear this site's browser storage to remove history; retention is pruned when history is next used/written. Older entries may be evicted at the size limits. Storage failures are shown in the report.

Missing tasks are **not** assumed completed. Only an explicit observed completion or accepted script completion updates the last-known status. Records not observed before access loss may have only their ID. Cancel, Close or Escape stops the report; account/user changes discard its results. Generic authorization failures are not classified as inaccessible, and denied rows are withheld if the final session check fails. Errors, pagination limits (5,000 calls / 10,000 tasks) or partial task coverage are visibly marked incomplete.

On Run, the report reads the location's phone-number inventory and selects all voice-capable numbers linked to the signed-in user. Calls use that nonempty `selectedPool` with an empty `userId` filter, matching the working native report; returned rows are independently filtered by `row.userId` (not the contact assignee), location, contact ID and date. Missing, malformed or incomplete inventory is an explicit call-coverage warning, never a clean zero-call result; tasks and remembered follow-ups can still be checked. Numbers are not persisted. Backend calls/contact reads use version `2021-04-15`; services inventory/task reads use `2021-07-28`.

**Live validation:** the corrected selected-pool inaccessible report has been verified by the user.

## Outgoing calls

Open **Workflow settings → Reports → Outgoing calls → Load call counts**. Today and Yesterday use WITA (UTC+8) calendar days, through the time loading started. **Refresh** loads a new snapshot; the small Updated timestamp is WITA. Counts include only the signed-in user's outbound calls, once per call ID—not contacts or nested call legs. Separate attempts to the same contact count separately. Completed is the CRM outcome, not proof a person answered; other returned statuses also contribute to Total.

Loading reads your linked voice-number inventory and the necessary 50-row call pages only. It does not read contacts/tasks/history, save counts, write to the CRM, or poll. No counter requests run until clicked. Failed or incomplete loads show a short warning instead of partial totals. Closing/saving settings, Escape, or an account/user change cancels loading; reopen settings after switching users. The two reports cannot load simultaneously.

**Live validation:** the new counter still needs comparison against the native call report for both WITA days.

## Development

```sh
npm ci
npm test
```

Edit `gohigherlevel.user.js` directly. The tests in `tests/` load that file; there is no generated copy. Do not commit HAR captures, CRM credentials, contact data, or private business documents to this public repository.

### Runtime boundaries

The script stays single-file, with deliberately small internal boundaries:

- **Session and contact reads:** route/session revisions and contact epochs retire stale work. Approved saves account explicitly for their own invalidations; external mutations still stop continuation.
- **Transport:** `requestLifetime` owns timeout/cleanup; `fetchCrmJson` shares native HTTP/JSON mechanics only. Endpoint permissions, final guards, durable intent, receipt verification and no-retry policy remain in the endpoint callers. Reports retain their special permission-denial and cancellation handling.
- **Journal:** `journal` owns completed evidence, pending operations, SMS uncertainty, persistence and rollback. Treat its getters as read-only; mutate through its methods. An accepted write can still leave an unfinished checkpoint if continuation is unsafe.
- **History:** persisted arrays retain their existing format and cross-tab merge rules. In-memory contact indexes follow array identity and eviction; observation callbacks explicitly report changes instead of serializing rows.
- **Queue counts:** settings/catalog/query/queue revisions form the small snapshot key. Keep revision increments with the corresponding input mutations, including lazy query initialization and navigation rollback; do not restore whole-object serialization to toolbar refreshes.
- **DOM:** stable hosts retain observer subscriptions. Validated opportunity snapshots identify board clicks without a global label scan; the label-based fallback remains for missing snapshots.

Performance regression tests count work rather than assert wall-clock timings: one native body clone/decode across observers, no large-object queue serialization during stable refreshes, no stable-host resubscriptions, indexed history updates, inventory-only Settings requests, and four report date formatters reused across rows/reruns. jsdom cannot establish real browser layout costs or live CRM compatibility.
