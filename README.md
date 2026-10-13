# GoHigherLevel

A single-file Tampermonkey userscript for the Pertama CRM. No build step is needed.

## Install

Install [Tampermonkey](https://www.tampermonkey.net/), then open the [raw userscript](https://raw.githubusercontent.com/gkarolyi/gohigherlevel/main/gohigherlevel.user.js) and confirm installation. If you already installed a local copy, check Tampermonkey for a duplicate and keep only the GitHub-installed script.

## Updates

The script's `@updateURL` and `@downloadURL` point to the raw file on the `main` branch. To publish an update, change the `@version` metadata and the matching `VERSION` constant in `gohigherlevel.user.js`, run the tests, and push the updated file to `main`. Tampermonkey checks for new versions on its update schedule; you can also use its **Check for userscript updates** command.

## Workflow defaults

In **Workflow settings**, each shared stage rule chooses the default actions for **Save and next**: update stage, add note, add follow-up task, and send SMS. You can override every selection before confirming; selecting SMS only loads its options, and does not send a message.

Current and suggested next stages come from the checked pipelines. Saved stages that are no longer available remain visibly labeled and can be kept when saving unrelated settings. The suggested next stage stays editable even when stage updates are off. Follow-up days appear only when the task default is on; turning it off preserves the saved days (including zero). Tasks require a valid contact owner and are due at 11am WITA.

Older rules retain their defaults: notes on, SMS off, and tasks on when follow-up days were set. Stages without a rule retain their existing defaults.

## Development

```sh
npm ci
npm test
```

Edit `gohigherlevel.user.js` directly. The tests in `tests/` load that file; there is no generated copy. Do not commit HAR captures, CRM credentials, contact data, or private business documents to this public repository.
