# Follow-up date/time implementation plan

**Goal:** Implement the approved zero/blank = three hours later default and an exact WITA date/time override in Save and next.

**Architecture:** Keep the existing userscript and native form controls. The confirmation owns a fixed opening-time anchor and a minute-resolution `datetime-local` input explicitly interpreted as WITA (UTC+08:00), regardless of browser timezone. Pass a canonical UTC ISO timestamp through approval, API creation, receipt verification, journal evidence and remembered tasks. Keep historical date-only report support unchanged.

**Tech stack:** Vanilla browser JavaScript; node:test and jsdom.

## Approved behavior
- Zero or blank follow-up days means opening time +3 hours, displayed to minute precision; midnight rollover is allowed.
- Positive whole days retain 11am WITA on the future calendar day.
- Days edits recalculate the picker. Picker edits override only this save; unrelated form changes do not reset it.
- Keep Add task as the opt-in/out control, preserve existing saved rule values/defaults, and allow blank days with task enabled.
- Keep disabled task controls and owner checks; invalid days or date/time block task submission.

## Steps
- [x] Add failing confirmation tests in `tests/pertama.test.cjs` for zero/blank defaults, rollover, timezone conversion, fixed opening anchor, picker overrides, invalid input, and unchanged settings/defaults. Update obsolete date-only assertions.
- [x] Add failing exact-timestamp API tests in `tests/api-writes.test.cjs`, including receipt mismatch, invalid approval and history/journal evidence. Migrate internal test approvals in `tests/concurrent-save.test.cjs` and `tests/lead-access-regressions.test.cjs` to timestamps.
- [x] Run `node --test tests/pertama.test.cjs tests/api-writes.test.cjs` and confirm the intended failures.
- [x] Implement minimal date helpers, confirmation picker/state, optional days validation, and timestamp propagation in `gohigherlevel.user.js`.
- [x] Update `README.md` scheduling instructions, retaining the historical date-only report explanation.
- [x] Run targeted tests, `npm test`, `node --check gohigherlevel.user.js`, and `git diff --check`; inspect the final diff. No live CRM writes are needed for verification.
