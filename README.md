# GoHigherLevel

A single-file Tampermonkey userscript for the Pertama CRM. No build step is needed.

## Install

Install [Tampermonkey](https://www.tampermonkey.net/), then open the [raw userscript](https://raw.githubusercontent.com/gkarolyi/gohigherlevel/main/gohigherlevel.user.js) and confirm installation. If you already installed a local copy, check Tampermonkey for a duplicate and keep only the GitHub-installed script.

## Updates

The script's `@updateURL` and `@downloadURL` point to the raw file on the `main` branch. To publish an update, change the `@version` metadata and the matching `VERSION` constant in `gohigherlevel.user.js`, run the tests, and push the updated file to `main`. Tampermonkey checks for new versions on its update schedule; you can also use its **Check for userscript updates** command.

## Development

```sh
npm ci
npm test
```

Edit `gohigherlevel.user.js` directly. The tests in `tests/` load that file; there is no generated copy. Do not commit HAR captures, CRM credentials, contact data, or private business documents to this public repository.
