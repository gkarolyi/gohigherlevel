# Save progress modal

## Goal

Make Save and next visibly progress through each selected action without adding clicks or delaying automatic navigation. Prevent interaction with the underlying CRM while actions run. Preserve existing concurrency, verification, checkpoints, and no-retry safeguards.

## Presentation

Transition directly from the confirmation dialog to a compact, centred progress modal without exposing an interactive page between them. Reuse the confirmation dialog's white surface, rounded corners, typography, and dimmed backdrop. Use native dialog modality and accessible labelling.

Show a heading (initially “Preparing actions…”, then “Saving actions”), contact name and pipeline, compact action rows, and “The next lead will open automatically.” Show no editable fields or buttons while running. Ignore Escape and backdrop dismissal during execution. Keep keyboard focus within the modal; announce meaningful status changes politely. Pair icons and colours with text and respect reduced-motion preferences.

Rows represent selected stage, note, follow-up task, and SMS actions. Include automatic existing Call-task completion when preflight finds a matching task. Do not present disabled actions as pending work. During revalidation and preflight, show the preparation phase instead of implying writes have started.

## Status semantics

- Waiting: the action has not started; explain dependencies where useful.
- Running: spinner and specific text such as Saving, Creating, Linking, Sending, or Verifying.
- Confirmed: green tick only after the corresponding save evidence is verified.
- Failed before saving: cross with a short explanation when no mutation was dispatched.
- Unverified: amber warning when a dispatched mutation may have saved but confirmation is unavailable. Never imply it is safe to repeat.
- Not run: neutral indicator for an action prevented by another failure.

Retain confirmed results if a later safety check or another action fails. Do not derive mutation success solely from an enclosing promise resolving or rejecting: verified receipts and workflow-continuation errors are separate facts. Task creation is not fully confirmed until its contact association is verified; if linking fails, explain that the task was created but its link is unverified or was not performed. SMS confirmation means accepted by the CRM, not delivered.

## Execution and lifecycle

Keep the current execution graph:

1. Revalidate contact/opportunity and preflight stage and existing task.
2. Run selected stage and note saves concurrently with existing Call-task completion.
3. In the task lane, create and link the selected follow-up only after existing-task completion (or confirmation that none exists).
4. Send selected SMS only after the save lanes succeed.
5. Show “Opening next lead…” while finding and opening the next lead.

Update rows independently as operations progress. Do not add waits for users to read ticks. Remove the modal immediately when navigation succeeds; never carry it onto the next lead. If no next lead exists, remove the modal and use the existing saved/empty-queue notification.

If an action fails, let already-dispatched work settle and continue updating its rows. Prevent later dispatches according to existing safeguards. Once all in-flight work settles, retain the modal with results, an explanatory stopped summary, and a Close button. Closing then restores access to inspect the CRM record; no retry button is offered. Preserve durable unfinished-action checkpoints and console diagnostics. Present run failures in this modal rather than layering a blocking browser alert over it; failures before the modal exists retain the current reporting path.

If navigation fails after successful saves, retain ticks and explain separately that opening the next lead failed. Allow Close; do not depict successful saves as failed. Closing restores focus to an appropriate existing control. Keep the normal run button short: Saving… or Opening next lead… rather than encoding per-action details there.

## Implementation boundaries

Keep this within the single-file userscript, `gohigherlevel.user.js`. Extend the existing confirmation-to-run lifecycle and add a small explicit progress-state/rendering interface. Report action milestones from the existing dispatch and verification points without changing request ordering or authorization. Keep presentation state separate from durable recovery checkpoints. Do not parse human-readable checkpoint messages to infer status. No new framework, build step, retries, settings, or unrelated restructuring.

## Verification

Extend the DOM and deferred-request tests, especially `tests/concurrent-save.test.cjs` and the confirmation/run tests in `tests/pertama.test.cjs`, to cover:

- Seamless confirmation-to-progress transition, modal semantics, and blocked dismissal while running.
- Only enabled actions shown, plus applicable automatic task completion.
- Preparation feedback and no writes after preflight failure.
- Independent row updates across different completion orders without serialising lanes.
- Follow-up waiting for completion and remaining unfinished until linking succeeds.
- SMS waiting for saves and displaying accepted, not delivered.
- Partial failure, uncertain responses, blocked later work, and retained confirmed evidence.
- Continued progress while failed runs drain outstanding requests; Close appears only after settling.
- Immediate automatic navigation, modal removal on success, empty queue handling, and retained results on navigation failure.
- Existing checkpoint, duplicate-prevention, session-change, timing, and concurrency regressions.

Run the full test suite, JavaScript syntax check, and whitespace check. Browser-only appearance, focus, and route-transition behaviour require a live/manual check and should not be claimed verified by DOM tests alone.
