# SMS Acknowledgment Success Plan

**Goal:** Advance after the CRM accepts an SMS, without requiring conversation-history readback.

**Architecture:** Keep recipient/sender approval, spam check, durable pre-send intent, single-send reservation, and safe acknowledgment-ID validation. Persist the accepted message/conversation IDs before the post-request route/session guard. Clear the pending SMS only after acknowledgment persistence and that guard succeed. Report acceptance, never delivery.

**Files:** `gohigherlevel.user.js`, `tests/api-sms.test.cjs`, `tests/pertama.test.cjs`.

- [x] Replace history-only tests with regressions proving no history request, accepted outcome durability, navigation on acknowledgment, and no duplicate sends.
- [x] Run tests and confirm no-history expectations fail against the current script.
- [x] Remove the history endpoint and readback logic; retain acknowledgment journaling and post-request guards. Use an accepted/not-delivery-confirmed notification.
- [x] Verify malformed IDs, send HTTP errors/timeouts, storage failures, and route/auth changes still fail closed without resend.
- [x] Run the full suite, syntax check, and diff check. Do not version, commit, push, or begin other queued items without request.
