# Task and Stage Tweaks Implementation Plan

**Goal:** Allow opt-in tasks when the rule has no default deadline, and infer a same-stage queue from the open contact.

**Architecture:** Keep the existing confirmation dialog and pinned-queue lifecycle. Separate task availability (valid owner) from its default selection (configured deadline). Before showing the fallback queue picker, use the recorded opportunity ID or the sole opportunity and its current API stage; never silently choose between multiple opportunities.

**Tech Stack:** JavaScript userscript; Node test runner and jsdom.

### 1. Regression tests (`tests/pertama.test.cjs`)
- Replace the single-opportunity picker expectation with automatic inference assertions: no dialog, exact persisted queue, API-only reads.
- Make picker cancellation tests explicitly ambiguous by supplying two opportunities.
- Cover recorded origin disambiguation, unknown stage rejection, and preserved pinned queues.
- Exercise `confirmActions` with `days: null`: task unchecked but enabled, days editable when toggled on, missing/invalid dates rejected, valid date returned. Verify no-owner tasks remain disabled.
- Run `npm test` and confirm new expectations fail before implementation.

### 2. Minimal implementation (`gohigherlevel.user.js`)
- In `ensureStageQueue`, retain existing pinned queues. Resolve the recorded origin against returned opportunities, or infer the sole opportunity when there is no origin. Validate pipeline/current stage through `pinStageQueue` before returning; keep the explicit picker for ambiguity and reject stale origins.
- In `confirmActions`, remove deadline-based disabling/hiding and deadline-based submission gates. Keep `due` only for the initial checkbox/day defaults; use checkbox and owner availability for validation and selected task date.
- Update settings help to explain inference and the ambiguity safeguard.

### 3. Verify
- Run `npm test`, `node --check gohigherlevel.user.js`, and `git diff --check`.
- Inspect diff to ensure changes are limited to requested behavior and tests.
