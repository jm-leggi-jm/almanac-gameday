# Knowledge

## Purpose

Almanac Game Day is a static page for NFL game day. The tagline is "The weather at every kickoff." It lists live and upcoming games, past games, a change log, and informational parlays (game legs and player props). Weather is tied to each game's stadium and kickoff window. Odds come from public sports and price feeds and are shown for information only.

## Architecture and folder layout

One HTML page, plain CSS, and classic scripts. A service worker caches the shell and the last weather responses so the installed page can open offline.

```
index.html              page, tabs, Content-Security-Policy
css/styles.css          styles
js/theme.js             light/dark, loaded from the head
js/football.js          schedules, roofs, geocoding, forecast, odds scan
js/gameday.js           game-day weather cards
js/radar.js             precipitation radar (tile grid, no map library)
js/parlay.js            game parlays
js/props.js             player-prop parlays
js/tracker.js           starred-game panel
sw.js                   service worker
manifest.webmanifest    installable-app manifest
icons/                  favicon and app icons
tests/odds-parse.test.js
.nojekyll               serve as static files
```

Tabs in the page: Live / Upcoming Games, Parlay Generation, Past Games, Change Log. Game list modes are "This week" and "My teams".

## Key files and entry points

- `index.html` is the entry. `js/theme.js` is loaded in `<head>` so a saved theme applies before paint. Other script tags: see `index.html`. The shell list in `sw.js` names every app file the worker caches.
- `Football` (`js/football.js`) loads the ESPN NFL scoreboard and team schedules, classifies roofs, geocodes stadiums, fetches the Open-Meteo forecast for the game window, and rates weather impact. It also exposes `americanOddsIn`.
- `js/gameday.js` renders live and upcoming games (finals go to Past Games), in the browser's time zone.
- `Radar` (`js/radar.js`) draws RainViewer frames over Esri canvas tiles. `Radar.mount` / `Radar.setLocation` drive the main map; `Radar.create()` makes per-game maps. Maps share one frame-list download.
- `js/parlay.js` builds 4-, 6-, 8-, and 10-leg cards from this week's not-yet-started games (smaller sizes for the Sunday late-afternoon slate). One moneyline or total per game. Weather is a flag, not a change to the chance.
- `js/props.js` builds 3- to 6-leg player-prop cards (passing, rushing, and receiving yards, receptions) from DraftKings lines via ESPN.
- `Tracker` (`js/tracker.js`) shows starred games on every tab and refreshes the week's scoreboard while the page is visible.
- `sw.js` uses network-first for app files (`cache: 'no-cache'`) and network-first with a date-stripped cache key for weather URLs.

## Config and environment variables

No environment variables appear in the code. Nothing is read from the process environment.

Settings are constants in the JS files and keys in `localStorage`:

- `almanac-gameday.theme` — `light` or `dark`; otherwise follow the system.
- `almanac-gameday.prefs.v2` — `{ mode: 'week' | 'mine', teams: [] }`.
- `almanac-gameday.tab` — last tab.
- `almanac-gameday.tracked` — starred game ids.
- `almanac-gameday.geo.v1` — geocoding cache.
- `gameday.propGames.v1` — prop-game cache key.

Cache names live in `sw.js` and the feature files (`gameday-shell-…`, `weather-data-v1`, `gameday-props-v1`, plus `gameday-forecasts*` and `gameday-props*` prefixes kept on activate). See those files for current names and TTLs.

## Run and test

- Open `index.html`.
- From the repo root: `node tests/odds-parse.test.js`.

No other run or test command is in the repo.

## Deploy and where it runs

Static files only. `.nojekyll` tells a Jekyll-based static host not to process the site. The service worker can serve the cached shell when the network is down. Where it is published is unclear from code.

## Owners

- Owner: the maintainer.
- The maintainer approves merges.
- Odds, parlay, stake, and payout changes need an explicit OK from the maintainer.

## Known gotchas

- ESPN's indoor flag misses retractable roofs and is sometimes absent. `ROOFS` in `js/football.js` is the list. Unlisted venues are open-air. SoFi is stored as `canopy` (covered, open sides). The Bernabéu match is the prefix `bernab` for international games.
- Dome and covered stadiums keep weather off the field; the outside forecast is still shown for fans. A retractable roof gets the note "retractable roof, usually closed in bad weather" and no weather adjustment. Radar is for open-air and retractable games only.
- The forecast window is the kickoff hour plus about three hours (`WINDOW_HOURS` in `js/football.js`).
- RainViewer free radar tiles stop at zoom 7. The free tier serves the Universal Blue palette whatever scheme is requested. Esri tile URLs are `z/y/x`. A theme change must redraw basemaps (`themechange`).
- An Open-Meteo 429 is returned as-is so the page can handle it. See `sw.js`.
- Shell updates depend on bumping the shell cache name. Activate deletes caches other than the current shell, the weather-data cache, and the `gameday-forecasts` / `gameday-props` prefixes.
- Weather cache keys drop `start_date` and `end_date` so an older copy can be the offline fallback.
- American prices count only when they look like a price and are ≤ −100 or ≥ +100. `EVEN` / `EV` is 100. `PK` / `PICK` is 0. Fields such as `oddsId` and `priceID` are ignored. Very large magnitudes are rejected. See `tests/odds-parse.test.js`.
- If a prop has no real price on both sides, the leg prints "assumed −110" and counts as 50%. Players need enough recent games. Lines outside the player's normal hit-rate band are skipped. At most two prop legs come from one game. Cards are cached for hours. See `js/props.js`.
- Parlay payouts use posted odds with the vig included. Fair chances used to pick a side have the vig removed. ESPN's Matchup Predictor is not treated as a book. The Sunday 4:00–4:59 PM Eastern window is detected with `America/New_York`. Displayed kickoff times use the viewer's time zone.
- Payout figures on both parlay cards are for a fixed display stake. See `STAKE` in `js/parlay.js` and `js/props.js`.
- The tracker drops saved ids once the week's scoreboard no longer includes them. Finished games are not given a track button.
- `localStorage` failures are ignored. The page still runs; the choice is not remembered.

## Related repos and links

No related repositories are named in this repo.

Data and image hosts allowed by the page (see the Content-Security-Policy in `index.html`):

- ESPN site, web, and core APIs (`site.api.espn.com`, `site.web.api.espn.com`, `sports.core.api.espn.com`) and images on `a.espncdn.com`.
- Open-Meteo forecast and geocoding (`api.open-meteo.com`, `geocoding-api.open-meteo.com`).
- RainViewer (`api.rainviewer.com`, `*.rainviewer.com`).
- Esri canvas tiles (`services.arcgisonline.com`).
- Polymarket (`gamma-api.polymarket.com`, `clob.polymarket.com`), prices for information only.
