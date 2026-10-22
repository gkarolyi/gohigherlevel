# Saved SMS Templates Implementation Plan

**Goal:** Multiple named local SMS templates, stage-specific defaults, and immediate template replacement in Save and next.

**Architecture:** Keep the single userscript and existing send approval boundary. Store templates as `{ id, name, message }`, with a permanent `default` entry named Default. Migrate legacy `sms` text on settings validation. Rules optionally reference `smsTemplateId`; missing selections fall back to Default.

**Tech Stack:** Vanilla JavaScript, localStorage, node:test and jsdom.

## Steps
- [x] Add regression tests in `tests/pertama.test.cjs` for migration, validation, settings CRUD, rule selection, rendering and immediate replacement; run and observe failures.
- [x] Modify `gohigherlevel.user.js` settings validation and UI. Keep Default non-removable, use stable IDs, and block removal of referenced templates with an explanatory error.
- [x] Modify confirmation to show named buttons only with SMS enabled, resolve placeholders on selection, and preserve text across toggles. Never dispatch or submit from a template button.
- [x] Run targeted tests, then `npm test`, syntax and whitespace checks. Update README and both userscript version fields. Review the final diff. Live CRM testing remains a separate manual check.
