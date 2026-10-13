# GoHigherLevel

A single-file Tampermonkey userscript for the Pertama CRM. No build step is needed.

## Install

Install [Tampermonkey](https://www.tampermonkey.net/), then open the [raw userscript](https://raw.githubusercontent.com/gkarolyi/gohigherlevel/main/gohigherlevel.user.js) and confirm installation. If you already installed a local copy, check Tampermonkey for a duplicate and keep only the GitHub-installed script.

## Updates

The script's `@updateURL` and `@downloadURL` point to the raw file on the `main` branch. To publish an update, change the `@version` metadata and the matching `VERSION` constant in `gohigherlevel.user.js`, run the tests, and push the updated file to `main`. Tampermonkey checks for new versions on its update schedule; you can also use its **Check for userscript updates** command.

## Workflow defaults

In **Workflow settings**, each shared stage rule chooses the default actions for **Save and next**: update stage, add note, add follow-up task, and send SMS. You can override every selection before confirming; selecting SMS only loads its options, and does not send a message.

Current and suggested next stages come from the checked pipelines. Saved stages that are no longer available remain visibly labeled and can be kept when saving unrelated settings. The suggested next stage stays editable even when stage updates are off. Follow-up days appear only when the task default is on; turning it off preserves the saved days (including zero). Tasks require a valid contact owner and are due at 11am WITA.

Older rules retain their defaults: notes on, SMS off, and tasks on when follow-up days were set. Stages without a rule retain their existing defaults.

## Inaccessible leads

Open **Workflow settings → Reports → Inaccessible leads** at the bottom of settings, choose a call window (30 days by default; 7 or 90 also available), then **Run report**. Opening the report makes no requests and leaves your unsaved settings unchanged; Close or Escape returns to settings. The report checks contacts from your calls, your visible pending tasks, and remembered outstanding follow-ups even outside the call window. It shows one row per explicitly inaccessible contact, with the saved name (or “Name unavailable”), contact link/ID, last call date, and remembered pending task titles and due dates. Dates use WITA; date-only workflow deadlines are shown at 11am. Share the relevant rows with your manager; this is not proof of ownership or current task status.

Names and tasks can disappear after access is lost, so validated reads during normal CRM use and confirmed linked follow-ups created by the script are remembered locally. History is scoped to this CRM location and the verified signed-in user, limited to 180 days, 2,000 contacts and 20 tasks per contact. Only IDs, names, timestamps and minimal task fields are retained—no phone numbers, notes, credentials or full responses. Writes are batched and flushed on page exit. There is no sync, additional background lookup or polling. Clear this site's browser storage to remove history; retention is pruned when history is next used/written. Older entries may be evicted at the size limits. Storage failures are shown in the report.

Missing tasks are **not** assumed completed. Only an explicit observed completion or accepted script completion updates the last-known status. Records not observed before access loss may have only their ID. Cancel, Close or Escape stops the report; account/user changes discard its results. Generic authorization failures are not classified as inaccessible, and denied rows are withheld if the final session check fails. Errors, pagination limits (5,000 calls / 10,000 tasks) or partial task coverage are visibly marked incomplete.

On Run, the report reads the location's phone-number inventory and selects all voice-capable numbers linked to the signed-in user. Calls use that nonempty `selectedPool` with an empty `userId` filter, matching the working native report; returned rows are independently filtered by `row.userId` (not the contact assignee), location, contact ID and date. Missing, malformed or incomplete inventory is an explicit call-coverage warning, never a clean zero-call result; tasks and remembered follow-ups can still be checked. Numbers are not persisted. Backend calls/contact reads use version `2021-04-15`; services inventory/task reads use `2021-07-28`.

**Live validation:** captures show the old empty-pool query returned zero calls despite a known call in the native selected-pool report. The general pending-task search has now been observed live returning the expected task. The corrected userscript query still needs a real Run report rerun before relying on completeness.

## Development

```sh
npm ci
npm test
```

Edit `gohigherlevel.user.js` directly. The tests in `tests/` load that file; there is no generated copy. Do not commit HAR captures, CRM credentials, contact data, or private business documents to this public repository.
