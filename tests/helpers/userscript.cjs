const assert = require('node:assert/strict');

function installWebGlobals(window) {
  for (const key of ['Headers', 'Request', 'Response', 'AbortController']) window[key] = globalThis[key];
}

function evaluateUserscript(window, source) {
  assert.match(source, /\}\)\(\);\s*$/);
  window.eval(source.replace(/\}\)\(\);\s*$/, `
    if (typeof workflow === 'undefined') {
      globalThis.workflow = {
        get busy() { return busy; }, set busy(value) { busy = value; },
        get activeSaveProgress() { return activeSaveProgress; }, set activeSaveProgress(value) { activeSaveProgress = value; },
        get guardedContact() { return guardedContact; }, set guardedContact(value) { guardedContact = value; },
        get guardedStageQueue() { return guardedStageQueue; }, set guardedStageQueue(value) { guardedStageQueue = value; },
        get approvedActionContext() { return approvedActionContext; }, set approvedActionContext(value) { approvedActionContext = value; },
        get step() { return step; }, set step(value) { step = value; },
        get completed() { return completed; }, set completed(value) { completed = value; },
        get pendingSave() { return pendingSave; }, set pendingSave(value) { pendingSave = value; },
        get pendingActions() { return pendingActions; }, set pendingActions(value) { pendingActions = value; },
        get startingContact() { return startingContact; }, set startingContact(value) { startingContact = value; },
      };
    }
    globalThis.__evaluateUserscript = code => eval(code);
  })();`));
  return window.__evaluateUserscript;
}

module.exports = { installWebGlobals, evaluateUserscript };
