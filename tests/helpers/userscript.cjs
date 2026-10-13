const assert = require('node:assert/strict');

function installWebGlobals(window) {
  for (const key of ['Headers', 'Request', 'Response', 'AbortController']) window[key] = globalThis[key];
}

function evaluateUserscript(window, source) {
  assert.match(source, /\}\)\(\);\s*$/);
  window.eval(source.replace(/\}\)\(\);\s*$/, 'globalThis.__evaluateUserscript = code => eval(code);\n})();'));
  return window.__evaluateUserscript;
}

module.exports = { installWebGlobals, evaluateUserscript };
