# Deferred save progress UI follow-up

Status: deferred at user's request; no UI implementation changes yet. Resume this after investigating the other user's “server configuration mismatch: invalid opportunity version” error. The separate task-search timeout investigation is also unresolved.

## User feedback and agreed direction

The v1.0.7 modal is too tall and verbose. In preparation, all rows say Waiting without a clear active indicator. On failure, the expanded technical report overwhelms the modal and can push its heading out of view.

- Keep a blocking modal and immediate automatic navigation, without extra clicks, delays, or animations that delay navigation.
- Tighten spacing; use compact rows with an icon, action name, and short status on one line where practical.
- Show a spinner in the heading during preparation so waiting rows do not appear stuck.
- Remove or visually hide the standalone paragraphs below the rows, including the internal phase message and automatic-navigation reminder. The rows should carry progress feedback. Preserve screen-reader announcements in a visually hidden live region.
- On failure, show a short explanation, collapsed Technical details, and Close. Keep heading and Close visible when details expand.
- Preserve truthful confirmed/unverified/blocked states and existing concurrency, checkpoint and retry safeguards.
- User approved focusing on UI only; do not bundle timeout/request changes with this work.

## Separate timeout evidence

User screenshots from 2026-10-12 13:44 showed a 30-second timeout on POST /objects/task/records/search during “Preflighting stage and existing Call task…”. This is a read-only lookup despite using POST. This run stopped before stage/note/task/SMS mutations. Why the lookup stalled is not yet established; do not infer that increasing a timeout or skipping the lookup is safe.

Screenshots remain in temporary OS paths and may disappear. They contain private CRM data; do not copy them into the repository.
