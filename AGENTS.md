# AGENTS.md

Operating guide for coding agents working on Almanac Game Day.

## What this is

A static NFL game-day page. It shows schedules, stadium weather, radar, odds, and informational parlay cards. Open `index.html` in a browser. There is no build step and no package manifest in the repo.

Odds, projections, and parlays are informational only. Nothing in the repo places a bet.

## Setup, run, test

No install command is shown. The page is static.

- Open `index.html`.
- Price-parsing checks, from the repo root:

```
node tests/odds-parse.test.js
```

That test uses Node's built-in `fs`, `path`, and `vm` modules. It loads `js/football.js` and checks `Football.americanOddsIn`. No other test command appears in the repo.

How to publish the site is unclear from code. `.nojekyll` is present so a static host that would otherwise run Jekyll serves these files as-is.

## Coding conventions

- Vanilla JS and CSS. No framework and no bundler appear in the repo.
- Feature code lives in `js/`. Each file is an IIFE. `Football`, `Radar`, and `Tracker` are globals other files call.
- Shared DOM helpers are repeated per file: `$` is `document.getElementById`, and `esc` escapes HTML.
- User-facing odds use a Unicode minus (`−`), not a hyphen.
- Preferences and theme live in `localStorage`. Storage access is wrapped in `try/catch` because storage can be unavailable.
- Comments record non-obvious rules (roof types, vig, cache keys). Keep those comments when you change the rule.
- The only automated check is a plain Node script that prints `PASS` or `FAIL`. See `tests/odds-parse.test.js`.

## Rules

- Never commit secrets, `.env` files, logs, or runtime state (browser caches, `localStorage` dumps).
- Work on a branch and open a pull request.
- The maintainer approves merges.
- Changes to odds math, parlay construction, stake display, or other money logic need an explicit OK from the maintainer.

## What not to touch

- Do not loosen the Content-Security-Policy in `index.html`. Scripts are `'self'` only. New data hosts must be added there on purpose.
- Do not edit `Football.americanOddsIn` or the parlay and prop payout math without the OK above, and without running `node tests/odds-parse.test.js`.
- The roof list in `js/football.js` is hand-maintained. Venues not listed are treated as open-air. Change it only when a stadium's roof status is wrong.
- If you add or rename a shell file, update `SHELL_FILES` in `sw.js` and bump `SHELL_CACHE`. See `sw.js`.
- Do not add a build tool, dependency file, or server unless the change needs it. None exists today.
