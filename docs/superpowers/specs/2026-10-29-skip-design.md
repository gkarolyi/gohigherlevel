# Skip contact design

## Approved behavior

Add a **Skip** button next to **Save and next**. Clicking it completes the current contact's matching follow-up task, creates a new follow-up due three hours from the click, and advances using the existing next-contact queue behavior. If no matching task exists, create the follow-up anyway. Do not change stage, add a note, or send SMS. No action-selection dialog is needed.

Use the existing task-matching rules, configured follow-up title, and existing owner resolution. Reuse the recorded task-completion and task-creation APIs; do not introduce an unrecorded due-date update endpoint.

## Safety and integration

Complete the matching task before creating its replacement. Advance only after both required writes succeed and are verified. If completion or creation fails, stay on the current contact and display the error. In particular, creation failure after completion must not be presented as a successful postponement. Preserve existing write checkpoints and uncertain-write safeguards; do not automatically retry writes.

Reuse workflow concurrency locks and session/contact validation so repeated clicks or overlapping workflows cannot duplicate tasks. Preserve existing queue navigation, task-cache invalidation, and queue-summary refresh behavior. Leave Save and next behavior unchanged.

## Verification

Automated tests cover button placement, completion-before-creation, missing-task creation, a deadline three hours from the click, no stage/note/SMS writes, advancement only after successful persistence, completion and creation failures, duplicate clicks, and existing stale-context safeguards. Run the full existing test suite plus JavaScript syntax and whitespace checks.
