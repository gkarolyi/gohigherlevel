# SMS Composer Activation Implementation Plan

> Work in the current checkout as requested by the user. Use test-driven development; do not test against live CRM records.

**Goal:** Proactively initialize the SMS editor for the user's frequent SMS workflow without treating a visible wrapper as a ready editor or spending 30 seconds waiting for activation that was never triggered. Sending remains opt-in.

**Architecture:** Keep `run()`'s proactive SMS preparation and existing confirmation/send guards. Replace `prepareSms()`'s wrapper-based branching with one bounded readiness/activation loop. Readiness requires the actual visible channel control, input, and send control. Focus/click only the existing known expansion triggers or a textarea inside the composer; never click Send during preparation, fill a draft, switch channels, or send a keypress. Remember activated elements so polling cannot repeatedly toggle the composer.

**Files:** `pertama.js`, `tests/pertama.test.cjs`.

## Steps

1. Add regression fixtures for a visible wrapper with an editor mounted only on focus/click; reproduce the missing activation against current code. Use a fake sleep/clock boundary to exercise the real wait loop without waiting 30 seconds.
2. Cover already-ready composers, staged expansion, disabled activation controls, unchanged drafts, no Send clicks, non-SMS/internal-comment rejection, and a single five-second preparation budget.
3. Implement one `wait(..., 5000)` loop inside `prepareSms()`: check readiness first; activate an eligible element once; recheck actual controls. Prefer the existing explicit expansion/input IDs and scope fallback textareas to `#composer-textarea`.
4. Preserve all `smsContext()`, `sendSmsOnce()`, and opt-in confirmation checks. Add regression tests for changed recipient/draft and exactly one send attempt to guard these invariants.
5. Bump userscript/diagnostic version to `0.2.10`. Run `npm test`, `node --check pertama.js`, and `git diff --check`; review and commit only the related files.

## Verification record

The pre-change regression fixtures reproduced the user's exact 30-second missing-textarea error. After the fix, all 47 tests pass, including editor activation on focus/click, staged expansion, bounded waits, unchanged drafts, unsafe-channel rejection, changed-recipient/draft refusal, and one-send-only behavior. Syntax and whitespace checks pass; independent review found no high-signal issues. No live CRM records were accessed.

## Live acceptance still required

On a freshly opened contact, click Save and next without touching the SMS area. Confirm the editor activates and SMS can be opted into, while From/To and message remain visible for approval. Test collapsed and already-open editor states. If the CRM requires a trusted pointer event or uses a different inactive control than the existing selectors, inspect that live DOM rather than inventing additional selectors/events. Automated fixtures validate the script's behavior, not the live CRM's initialization event.
