// NFL game-day weather: schedules (ESPN), stadium roof types, stadium locations (Open-Meteo geocoding),
// the forecast for each game window (Open-Meteo), and a weather-impact rating.
const Football = (() => {
  const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
  const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
  const FORECAST = 'https://api.open-meteo.com/v1/forecast';
  const WINDOW_HOURS = 4;      // kickoff hour plus the next three: an NFL game runs about 3¼ hours
  const FORECAST_DAYS = 16;
  const FORECAST_TTL_MS = 30 * 60 * 1000;
  const GEO_CACHE_KEY = 'almanac-gameday.geo.v1';

  // ESPN's "indoor" flag marks fixed domes but not retractable roofs, and some endpoints omit it,
  // so NFL venues with any roof are listed here. Anything not listed is open-air.
  const ROOFS = [
    ['ford field', 'dome'],
    ['caesars superdome', 'dome'],
    ['u.s. bank stadium', 'dome'],
    ['allegiant stadium', 'dome'],
    ['sofi stadium', 'canopy'],             // fixed translucent roof over the field, open sides
    ['at&t stadium', 'retractable'],
    ['nrg stadium', 'retractable'],
    ['state farm stadium', 'retractable'],
    ['mercedes-benz stadium', 'retractable'],
    ['lucas oil stadium', 'retractable'],
    ['bernab', 'retractable'],              // Estadio Santiago Bernabéu (international games)
  ];
  const ROOF_LABEL = { dome: 'Dome', canopy: 'Covered, open sides', retractable: 'Retractable roof', open: 'Open-air' };

  const STATES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
    DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
    IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
    NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
    VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  };

  // WMO weather codes (Open-Meteo) -> short description
  const WMO = {
    0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorms', 96: 'Thunderstorms, hail', 99: 'Thunderstorms, hail',
  };
  // Rough severity so a window's "headline" condition is its worst hour.
  const severity = (code) => (code >= 95 ? 9 : code >= 71 && code <= 86 && code !== 80 && code !== 81 && code !== 82 ? 8
    : code >= 61 ? 7 : code >= 51 ? 5 : code >= 45 ? 4 : code);

  async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    return res.json();
  }

  // ---------- Open-Meteo: gentle on the free API ----------

  // A full week is ~14 stadiums. One forecast URL covers every variable for a venue (lat/lon
  // rounded so the same stadium is one request), kept for 30 minutes. Starts are spaced with a
  // little jitter so a refresh isn't a burst, and a 429 waits (honoring Retry-After, plus jitter)
  // before the next try. At most a few requests are in flight.
  const METEO_CONCURRENCY = 3;
  const METEO_GAP_MS = 200;
  const METEO_GAP_JITTER_MS = 200;
  const METEO_RETRY_DELAYS_MS = [2000, 4000, 8000];
  const METEO_RETRY_CAP_MS = 30000;
  const METEO_CACHE = 'gameday-forecasts-v1';
  let meteoActive = 0;
  const meteoWaiting = [];
  let meteoChain = Promise.resolve();

  async function meteoSlot(job) {
    if (meteoActive >= METEO_CONCURRENCY) await new Promise((resolve) => meteoWaiting.push(resolve));
    meteoActive++;
    try {
      return await job();
    } finally {
      meteoActive--;
      const next = meteoWaiting.shift();
      if (next) next();
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Retry-After is either delta-seconds or an HTTP date. Anything else is ignored.
  function parseRetryAfter(header) {
    if (header == null || header === '') return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const when = Date.parse(header);
    return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
  }

  // 80–120% of the scheduled wait, so retries from a burst don't line up.
  const withJitter = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));

  function retryWait(attempt, retryAfterHeader) {
    const base = METEO_RETRY_DELAYS_MS[attempt];
    const asked = parseRetryAfter(retryAfterHeader);
    if (asked == null) return withJitter(base);
    const floor = Math.min(Math.max(asked, base), METEO_RETRY_CAP_MS);
    return floor + Math.round(Math.random() * Math.min(1500, floor * 0.25));
  }

  // Space out request starts. The gap runs inside a concurrency slot, before the fetch;
  // the wait after a 429 happens outside the slot so a retry doesn't keep one occupied.
  function meteoGap() {
    const turn = meteoChain.then(() => sleep(METEO_GAP_MS + Math.random() * METEO_GAP_JITTER_MS));
    meteoChain = turn.then(() => {}, () => {});
    return turn;
  }

  async function meteoFetch(url) {
    for (let attempt = 0; ; attempt++) {
      const res = await meteoSlot(async () => {
        await meteoGap();
        return fetch(url);
      });
      if (res.status === 429 && attempt < METEO_RETRY_DELAYS_MS.length) {
        await sleep(retryWait(attempt, res.headers.get('Retry-After')));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
      return res;
    }
  }

  // JSON from Open-Meteo, reused for `maxAgeMs` across page loads when Cache Storage is available.
  async function meteoJSON(url, maxAgeMs = 0, cacheName = METEO_CACHE) {
    let cache = null;
    if (maxAgeMs && 'caches' in self) {
      try { cache = await caches.open(cacheName); } catch { cache = null; }
    }
    if (cache) {
      const hit = await cache.match(url);
      const at = hit && Number(hit.headers.get('x-fetched-at'));
      if (hit && Date.now() - at < maxAgeMs) {
        try {
          return await hit.json();
        } catch {
          cache.delete(url).catch(() => {});   // damaged entry: fetch a fresh copy
        }
      }
    }
    const res = await meteoFetch(url);
    const body = await res.text();
    const json = JSON.parse(body);   // parse first: never cache a body that isn't JSON
    if (cache) {
      const stamped = new Response(body, { headers: { 'Content-Type': 'application/json', 'x-fetched-at': String(Date.now()) } });
      cache.put(url, stamped).catch(() => { /* storage full or unavailable: fine */ });
    }
    return json;
  }

  // ---------- Teams and schedules ----------

  // The 32 teams, built in: ESPN's team-list endpoint doesn't allow browser (CORS) access, and the
  // league rarely changes. Abbreviations match ESPN's schedule URLs; logos use ESPN's CDN pattern.
  const TEAMS = [
    ['ARI', 'Arizona Cardinals'], ['ATL', 'Atlanta Falcons'], ['BAL', 'Baltimore Ravens'], ['BUF', 'Buffalo Bills'],
    ['CAR', 'Carolina Panthers'], ['CHI', 'Chicago Bears'], ['CIN', 'Cincinnati Bengals'], ['CLE', 'Cleveland Browns'],
    ['DAL', 'Dallas Cowboys'], ['DEN', 'Denver Broncos'], ['DET', 'Detroit Lions'], ['GB', 'Green Bay Packers'],
    ['HOU', 'Houston Texans'], ['IND', 'Indianapolis Colts'], ['JAX', 'Jacksonville Jaguars'], ['KC', 'Kansas City Chiefs'],
    ['LV', 'Las Vegas Raiders'], ['LAC', 'Los Angeles Chargers'], ['LAR', 'Los Angeles Rams'], ['MIA', 'Miami Dolphins'],
    ['MIN', 'Minnesota Vikings'], ['NE', 'New England Patriots'], ['NO', 'New Orleans Saints'], ['NYG', 'New York Giants'],
    ['NYJ', 'New York Jets'], ['PHI', 'Philadelphia Eagles'], ['PIT', 'Pittsburgh Steelers'], ['SF', 'San Francisco 49ers'],
    ['SEA', 'Seattle Seahawks'], ['TB', 'Tampa Bay Buccaneers'], ['TEN', 'Tennessee Titans'], ['WSH', 'Washington Commanders'],
  ].map(([abbr, name]) => ({ abbr, name, logo: `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png` }));

  const teams = () => Promise.resolve(TEAMS);

  function roofType(venueName, espnIndoor) {
    const n = (venueName || '').toLowerCase();
    const hit = ROOFS.find(([key]) => n.includes(key));
    if (hit) return hit[1];
    return espnIndoor === true ? 'dome' : 'open';
  }

  const scoreOf = (c) => (c.score == null ? null : typeof c.score === 'object' ? c.score.displayValue : String(c.score));

  // Scores only once a game has started (ESPN lists 0-0 for games not yet played).
  function side(c, started) {
    const t = c.team || {};
    const logo = t.logo || (t.logos && t.logos[0] && t.logos[0].href) || '';
    return { id: t.id, abbr: t.abbreviation, name: t.displayName, short: t.shortDisplayName || t.displayName, logo, score: started ? scoreOf(c) : null };
  }

  // Normalize a list of events, skipping any malformed one rather than failing the whole list.
  function normalizeAll(events) {
    const out = [];
    for (const e of events || []) {
      try { out.push(normalize(e)); } catch (err) { console.warn('Skipping malformed event', err); }
    }
    return out;
  }

  // ESPN event (schedule or scoreboard shape) -> the fields the app uses
  function normalize(e) {
    const c = e.competitions[0];
    const v = c.venue || {};
    const a = v.address || {};
    const home = c.competitors.find((x) => x.homeAway === 'home');
    const away = c.competitors.find((x) => x.homeAway === 'away');
    const status = (c.status || e.status || {}).type || {};
    const started = status.state === 'in' || status.state === 'post';
    return {
      id: e.id,
      kickoff: new Date(e.date),
      shortName: e.shortName,
      state: status.state || 'pre',                  // pre | in | post
      detail: status.shortDetail || status.detail || '',
      neutral: !!c.neutralSite,
      venue: { name: v.fullName || 'Stadium TBD', city: a.city || '', state: a.state || '', country: a.country || '' },
      roof: roofType(v.fullName, v.indoor),
      home: home ? side(home, started) : null,
      away: away ? side(away, started) : null,
      situation: status.state === 'in' ? situation(c.situation) : null,
    };
  }

  // Live game details from the scoreboard, for the tracker panel.
  function situation(s) {
    if (!s) return null;
    const lp = s.lastPlay || {};
    const prob = lp.probability || {};
    const home = prob.homeWinPercentage;
    const tie = prob.tiePercentage;
    return {
      down: s.down > 0 ? s.down : null, distance: s.distance ?? null,
      possession: s.possession ? String(s.possession) : null,   // team id
      redZone: !!s.isRedZone,
      lastPlay: lp.text ? lp.text.trim() : null,
      homeWin: home == null ? null : home * 100,
      tie: tie == null ? 0 : tie * 100,
    };
  }

  async function teamSchedule(abbr) {
    const d = await getJSON(`${ESPN}/teams/${encodeURIComponent(abbr.toLowerCase())}/schedule`);
    return normalizeAll(d.events);
  }

  async function thisWeek() {
    const d = await getJSON(`${ESPN}/scoreboard`);
    return { label: d.week ? `Week ${d.week.number}` : 'This week', games: normalizeAll(d.events) };
  }

  // Every finished game this season, week by week from Week 1 (and the playoffs once they start).
  // One scoreboard request per week; kept for 30 minutes.
  const PAST_TTL_MS = 30 * 60 * 1000;
  const POSTSEASON = ['', 'Wild Card', 'Divisional round', 'Conference championships', 'Pro Bowl', 'Super Bowl'];
  let seasonCache = null;

  function seasonSoFar() {
    if (seasonCache && Date.now() - seasonCache.at < PAST_TTL_MS) return seasonCache.promise;
    const promise = (async () => {
      const d = await getJSON(`${ESPN}/scoreboard`);
      const year = d.season && d.season.year;
      const type = d.season && d.season.type;        // 1 preseason, 2 regular season, 3 playoffs
      const current = (d.week && d.week.number) || 1;
      const weeks = [];
      if (type === 2 || type === 3) {
        for (let w = 1; w <= (type === 2 ? current : 18); w++) weeks.push({ type: 2, week: w, label: `Week ${w}` });
      }
      if (type === 3) for (let w = 1; w <= current; w++) weeks.push({ type: 3, week: w, label: POSTSEASON[w] || `Playoffs, week ${w}` });
      const lists = await Promise.all(weeks.map(async (wk) => {
        try {
          const data = await getJSON(`${ESPN}/scoreboard?seasontype=${wk.type}&week=${wk.week}&dates=${year}`);
          return { ...wk, games: normalizeAll(data.events).filter((g) => g.state === 'post') };
        } catch (err) {
          console.warn(`Skipping ${wk.label}`, err);
          return { ...wk, games: [] };
        }
      }));
      const played = lists.filter((w) => w.games.length);
      const all = played.flatMap((w) => w.games);
      const start = all.length ? new Date(Math.min(...all.map((g) => g.kickoff))) : null;
      return { year, weeks: played, start };
    })();
    promise.catch(() => { seasonCache = null; });
    seasonCache = { at: Date.now(), promise };
    return promise;
  }

  // ---------- Stadium locations ----------

  let geoCache = {};
  try { geoCache = JSON.parse(localStorage.getItem(GEO_CACHE_KEY)) || {}; } catch { geoCache = {}; }
  const geoPending = new Map();

  async function locate(venue) {
    const key = `${venue.city}|${venue.state}|${venue.country}`.toLowerCase();
    if (geoCache[key]) return geoCache[key];
    if (!venue.city) return null;
    if (!geoPending.has(key)) {
      const stateName = STATES[venue.state] || '';
      const job = meteoJSON(`${GEO}?name=${encodeURIComponent(venue.city)}&count=10&language=en&format=json`).then((d) => {
        const results = d.results || [];
        const pick = (stateName && results.find((r) => r.country_code === 'US' && r.admin1 === stateName))
          || (stateName && results.find((r) => r.country_code === 'US'))
          || results[0];
        if (!pick) return null;
        const loc = { lat: pick.latitude, lon: pick.longitude };
        geoCache[key] = loc;
        try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(geoCache)); } catch { /* fine */ }
        return loc;
      });
      job.finally(() => geoPending.delete(key));
      geoPending.set(key, job);
    }
    return geoPending.get(key);
  }

  // ---------- Game-window forecast ----------

  const forecastCache = new Map();

  function hourly(loc) {
    const key = `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
    const hit = forecastCache.get(key);
    if (hit && Date.now() - hit.at < FORECAST_TTL_MS) return hit.promise;
    // Rain and showers are requested on their own. Precipitation is not, so rain is never
    // derived from it (that total also contains the water in snow). One URL per venue.
    const vars = 'temperature_2m,apparent_temperature,precipitation_probability,rain,showers,snowfall,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m';
    // GMT keeps hour stamps comparable with ESPN's UTC kickoff times.
    // snowfall_unit=inch: Open-Meteo's default is centimeters, and the cards label snow in inches.
    const url = `${FORECAST}?latitude=${loc.lat}&longitude=${loc.lon}&hourly=${vars}&past_days=7&forecast_days=${FORECAST_DAYS}`
      + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&snowfall_unit=inch&timezone=GMT';
    const promise = meteoJSON(url, FORECAST_TTL_MS).then((d) => d.hourly);
    promise.catch(() => forecastCache.delete(key));
    forecastCache.set(key, { at: Date.now(), promise });
    return promise;
  }

  // Recorded weather at a stadium from `from` through today, for past games: one request per stadium
  // covers all its games this season. Open-Meteo's historical-forecast archive has no lag (the
  // reanalysis archive runs about 5 days behind) and no rain chance, since it's what happened.
  const HISTORY = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
  const HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
  const HISTORY_CACHE = 'gameday-forecasts-history-v1';   // its own cache, so Refresh (which clears forecasts) keeps it
  const historyCache = new Map();

  function pastHourly(loc, from) {
    const start = from.toISOString().slice(0, 10);
    const end = new Date().toISOString().slice(0, 10);
    const key = `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)},${start},${end}`;
    const hit = historyCache.get(key);
    if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.promise;
    const vars = 'temperature_2m,apparent_temperature,rain,showers,snowfall,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m';
    const url = `${HISTORY}?latitude=${loc.lat}&longitude=${loc.lon}&hourly=${vars}&start_date=${start}&end_date=${end}`
      + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&snowfall_unit=inch&timezone=GMT';
    const promise = meteoJSON(url, HISTORY_TTL_MS, HISTORY_CACHE).then((d) => ({ ...d.hourly, precipitation_probability: d.hourly.time.map(() => null) }));
    promise.catch(() => { if (historyCache.get(key)?.promise === promise) historyCache.delete(key); });
    historyCache.set(key, { at: Date.now(), promise });
    return promise;
  }

  const hourKey = (date) => date.toISOString().slice(0, 13) + ':00';
  const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];

  // The game's hours from the hourly forecast, or null if kickoff is beyond the forecast range.
  function gameWindow(h, kickoff) {
    const start = new Date(kickoff);
    start.setUTCMinutes(0, 0, 0);
    const idx = h.time.indexOf(hourKey(start));
    if (idx < 0) return null;
    const hours = [];
    for (let i = idx; i < Math.min(idx + WINDOW_HOURS, h.time.length); i++) {
      if (h.temperature_2m[i] == null) continue;
      hours.push({
        at: new Date(`${h.time[i]}Z`),
        temp: h.temperature_2m[i], feels: h.apparent_temperature[i],
        pop: h.precipitation_probability ? h.precipitation_probability[i] : null,
        rain: Array.isArray(h.rain) ? (h.rain[i] || 0) : 0,
        showers: Array.isArray(h.showers) ? (h.showers[i] || 0) : 0,
        snow: (h.snowfall && h.snowfall[i]) || 0,
        code: h.weather_code[i], wind: h.wind_speed_10m[i], gust: h.wind_gusts_10m[i], dir: h.wind_direction_10m[i],
      });
    }
    if (!hours.length) return null;
    const max = (k) => Math.max(...hours.map((x) => x[k] ?? -Infinity));
    const min = (k) => Math.min(...hours.map((x) => x[k] ?? Infinity));
    const sum = (k) => hours.reduce((a, x) => a + (x[k] || 0), 0);
    const worst = hours.reduce((a, x) => (severity(x.code) > severity(a.code) ? x : a), hours[0]);
    return {
      hours,
      tempStart: hours[0].temp, tempEnd: hours[hours.length - 1].temp,
      feelsMin: min('feels'), feelsMax: max('feels'),
      popMax: max('pop'),
      tempMin: min('temp'),
      rain: (Array.isArray(h.rain) || Array.isArray(h.showers)) ? sum('rain') + sum('showers') : null,
      snow: sum('snow'),
      windMax: max('wind'), gustMax: max('gust'), windDir: compass(hours[0].dir || 0),
      code: worst.code, condition: WMO[worst.code] || 'Unknown',
    };
  }

  // ---------- Impact on play ----------

  // Levels: 0 none (any roof), 1 low, 2 moderate, 3 high. A fixed roof or a retractable roof
  // gets no weather level: teams close a retractable roof when the weather would matter.
  // Open-air flags are rules of thumb and each factor is one reason. Snow is a flag only
  // (it does not raise the level). Wind tier 1 is ≥15 mph or gusts ≥25; tier 2 is ≥20 or gusts ≥35.
  // `past`: the game has been played, so rain is judged by what fell rather than the forecast chance.
  function impact(w, roof, past = false) {
    if (roof === 'dome' || roof === 'canopy') {
      return { level: 0, label: 'None', reasons: [roof === 'dome' ? 'Indoors: weather won’t affect play' : 'Roof covers the field'] };
    }
    if (roof === 'retractable') {
      return { level: 0, label: 'None', reasons: ['retractable roof, usually closed in bad weather'] };
    }
    const reasons = [];
    let level = 1;
    const add = (lvl, text) => { reasons.push(text); level = Math.max(level, lvl); };
    if (w.code >= 95) add(3, 'Thunderstorms: lightning delays possible');
    if (w.snow >= 0.5) reasons.push(`Snow (${w.snow.toFixed(1)}″)`);
    else if (w.snow > 0.05) reasons.push('Some snow');
    const rain = Number.isFinite(w.rain) ? w.rain : null;
    if (rain != null) {
      if (past) {
        if (rain >= 0.25) add(3, `Heavy rain (${rain.toFixed(2)}″ fell)`);
        else if (rain >= 0.03) add(2, `Rain (${rain.toFixed(2)}″ fell)`);
        else if (rain > 0) add(1, 'A little rain');
      } else if (rain >= 0.25 && w.popMax >= 50) add(3, `Heavy rain (${rain.toFixed(2)}″)`);
      else if (w.popMax >= 50 && rain >= 0.03) add(2, `Rain likely (${Math.round(w.popMax)}%)`);
      else if (w.popMax >= 30) add(1, `Chance of showers (${Math.round(w.popMax)}%)`);
    }
    if (w.windMax >= 20 || w.gustMax >= 35) add(3, `Strong wind (${Math.round(w.windMax)} mph, gusts ${Math.round(w.gustMax)}): passing and kicking`);
    else if (w.windMax >= 15 || w.gustMax >= 25) add(2, `Wind (${Math.round(w.windMax)} mph, gusts ${Math.round(w.gustMax)}): passing and kicking`);
    const airMin = Number.isFinite(w.tempMin) ? w.tempMin : null;
    if (w.feelsMin <= 10) add(3, `Bitter cold (feels ${Math.round(w.feelsMin)}°)`);
    else if (airMin != null && airMin < 20) add(2, `Below 20°F (${Math.round(airMin)}°)`);
    else if (w.feelsMin <= 32) add(2, `Cold (feels ${Math.round(w.feelsMin)}°)`);
    if (w.feelsMax >= 95) add(3, `Heat (feels ${Math.round(w.feelsMax)}°)`);
    else if (w.feelsMax >= 88) add(2, `Hot (feels ${Math.round(w.feelsMax)}°)`);
    if (!reasons.length) reasons.push('Good football weather');
    return { level, label: ['None', 'Low', 'Moderate', 'High'][level], reasons };
  }

  // ---------- Odds and projection ----------

  // ESPN's game summary carries the sportsbook lines it shows (DraftKings), with opening and current
  // numbers, plus ESPN's Matchup Predictor win probabilities. One request per game, cached.
  const ODDS_TTL_MS = 30 * 60 * 1000;
  const oddsCache = new Map();

  const num = (s) => {
    if (s == null || s === '') return null;
    const t = String(s).trim().replace(/^[ou]/i, '').replace('−', '-').toUpperCase();
    const v = t === 'EVEN' || t === 'EV' ? 100 : t === 'PK' || t === 'PICK' ? 0 : parseFloat(t);
    return Number.isFinite(v) ? v : null;
  };

  // Team box-score stats for a finished game, keyed 'home' / 'away' (matched by team id).
  function parseStats(summary, g) {
    const teams = (summary.boxscore && summary.boxscore.teams) || [];
    if (!g || !g.home || teams.length < 2) return null;
    const out = {};
    for (const t of teams) {
      const side = String(t.team && t.team.id) === String(g.home.id) ? 'home' : 'away';
      const stat = (name) => {
        const s = (t.statistics || []).find((x) => x.name === name);
        return s ? s.displayValue : null;
      };
      const pen = (stat('totalPenaltiesYards') || '').split('-').map(Number);
      out[side] = {
        turnovers: num(stat('turnovers')), yards: num(stat('totalYards')), perPlay: num(stat('yardsPerPlay')),
        penalties: pen[0] || 0, penaltyYards: pen[1] || 0, defTDs: num(stat('defensiveTouchdowns')) || 0,
      };
    }
    return out.home && out.away ? out : null;
  }

  // Highest and lowest home win chance during the game (after the pre-game point), and whether each
  // came in the second half (by play order), from ESPN's win-probability chart.
  function winProbRange(wp) {
    if (!wp || wp.length < 4) return null;
    let max = -1, min = 2, maxAt = 0, minAt = 0;
    for (let i = 1; i < wp.length; i++) {
      const h = wp[i].homeWinPercentage;
      if (h == null) continue;
      if (h > max) { max = h; maxAt = i; }
      if (h < min) { min = h; minAt = i; }
    }
    const half = wp.length / 2;
    return { homeMax: max * 100, homeMin: min * 100, maxLate: maxAt > half, minLate: minAt > half };
  }

  function linesFromPick(p) {
    const ps = p.pointSpread || {};
    const ml = p.moneyline || {};
    const tot = p.total || {};
    const homeLine = num(ps.home && ps.home.close && ps.home.close.line) ?? (p.spread != null ? p.spread : null);
    return {
      provider: (p.provider && (p.provider.displayName || p.provider.name)) || 'Sportsbook',
      providerId: p.provider && p.provider.id != null && p.provider.id !== '' ? String(p.provider.id) : '',
      homeLine,
      homeOpen: num(ps.home && ps.home.open && ps.home.open.line),
      homeSpreadOdds: (ps.home && ps.home.close && ps.home.close.odds) || null,
      awaySpreadOdds: (ps.away && ps.away.close && ps.away.close.odds) || null,
      total: p.overUnder ?? num(tot.over && tot.over.close && tot.over.close.line),
      totalOpen: num(tot.over && tot.over.open && tot.over.open.line),
      overOdds: (tot.over && tot.over.close && tot.over.close.odds) || null,
      underOdds: (tot.under && tot.under.close && tot.under.close.odds) || null,
      mlHome: (ml.home && ml.home.close && ml.home.close.odds) || null,
      mlAway: (ml.away && ml.away.close && ml.away.close.odds) || null,
      mlHomeOpen: (ml.home && ml.home.open && ml.home.open.odds) || null,
      mlAwayOpen: (ml.away && ml.away.open && ml.away.open.odds) || null,
    };
  }

  function parseOdds(summary, g) {
    const pred = summary.predictor || {};
    const winHome = num(pred.homeTeam && pred.homeTeam.gameProjection);
    const winAway = num(pred.awayTeam && pred.awayTeam.gameProjection);
    let win = winHome != null && winAway != null ? { home: winHome, away: winAway } : null;
    // Match by team id rather than trusting the home/away labels.
    if (win && g && g.home && pred.homeTeam && String(pred.homeTeam.id) === String(g.away && g.away.id)) win = { home: winAway, away: winHome };
    // ESPN drops the Matchup Predictor once a game starts; the first point of its in-game
    // win-probability chart is the same pre-game projection.
    const wp = summary.winprobability || [];
    if (!win && wp.length && wp[0].homeWinPercentage != null) {
      const home = wp[0].homeWinPercentage * 100;
      win = { home, away: 100 - home - (wp[0].tiePercentage || 0) * 100, pregame: true };
    }
    // One row per sportsbook. ESPN's pickcenter odds are DraftKings (provider id 100), the same
    // book the cards already call the book feed, so a repeated provider id is dropped.
    const books = [];
    const seenProviders = new Set();
    for (const pick of summary.pickcenter || []) {
      const row = linesFromPick(pick);
      const key = row.providerId || `name:${row.provider.trim().toLowerCase()}`;
      if (seenProviders.has(key)) continue;
      seenProviders.add(key);
      books.push(row);
    }
    return { win, lines: books[0] || null, books, injuries: parseInjuries(summary), stats: parseStats(summary, g), wpRange: winProbRange(wp) };
  }

  // Current injury report from the same summary: { TEAM: [{ id, name, pos, status }] }.
  // Injured reserve is left out: those players have been gone a while and the lines already know.
  const INJURY_STATUS = { Out: 'Out', Doubtful: 'Doubtful', Questionable: 'Questionable', Suspension: 'Suspended' };
  function parseInjuries(summary) {
    const byTeam = {};
    for (const t of summary.injuries || []) {
      const abbr = t.team && t.team.abbreviation;
      if (!abbr) continue;
      byTeam[abbr] = (t.injuries || []).map((i) => ({
        id: String((i.athlete && i.athlete.id) || ''),
        name: (i.athlete && (i.athlete.shortName || i.athlete.displayName)) || 'Player',
        pos: (i.athlete && i.athlete.position && i.athlete.position.abbreviation) || '',
        status: INJURY_STATUS[i.status] || null,
      })).filter((i) => i.status);
    }
    return byTeam;
  }

  function odds(g) {
    const eventId = g.id;
    const hit = oddsCache.get(eventId);
    if (hit && Date.now() - hit.at < ODDS_TTL_MS) return hit.promise;
    const promise = getJSON(`${ESPN}/summary?event=${encodeURIComponent(eventId)}`).then((s) => parseOdds(s, g));
    promise.catch(() => oddsCache.delete(eventId));
    oddsCache.set(eventId, { at: Date.now(), promise });
    return promise;
  }

  // Mean of the de-vigged book probabilities, or the median when there are 3 or more.
  function combineFair(probs) {
    const xs = (probs || []).filter((p) => Number.isFinite(p));
    if (!xs.length) return null;
    if (xs.length >= 3) {
      const s = [...xs].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  }

  // 70% books / 30% Polymarket. `usePoly` is false when the market has no real volume, and the
  // result is then the books alone. Never the larger of the two.
  function blendFair(book, poly, usePoly) {
    if (!Number.isFinite(book)) return usePoly && Number.isFinite(poly) ? poly : null;
    if (!usePoly || !Number.isFinite(poly)) return book;
    return 0.7 * book + 0.3 * poly;
  }

  // Live win shares on a 0–100 scale. Away is what's left after home and the tie.
  function winShares(homePct, tiePct) {
    const home = Math.max(0, Number(homePct) || 0);
    const tie = Math.max(0, Number(tiePct) || 0);
    const away = Math.max(0, 100 - home - tie);
    return { home, away, tie, showTie: tie >= 1 };
  }

  // American odds buried in an object, without assuming one field name. A number counts only when
  // its key (or its parent key, for `{american:{value:"-120"}}`) looks like a price, does not end
  // in "id", is a whole number, and is ≤ −100 or ≥ +100 with a magnitude of at most 10,000
  // (EVEN counts as +100). A yard line such as 245.5 is not a price.
  // A nested read such as `{odds:{american:"-120"}}` is recorded once. A repeat of that same
  // price on the same object is marked seen. A different price is left for the walk. A field
  // named exactly over or under, with a plain number or EVEN, is recorded with that side.
  const MAX_AMERICAN_ODDS = 10000;
  function americanOddsIn(root) {
    const found = [];
    const seen = new Set();
    const priceKey = (k) => /american|odds|price|moneyline/i.test(k) && !/display/i.test(k) && !/id$/i.test(k);
    const asAmerican = (v) => {
      if (typeof v === 'number') {
        return Number.isFinite(v) && Number.isInteger(v) && (v <= -100 || v >= 100) && Math.abs(v) <= MAX_AMERICAN_ODDS ? v : null;
      }
      if (typeof v !== 'string') return null;
      const t = v.trim().replace(/[−–]/g, '-').toUpperCase();
      if (!t) return null;
      const n = t === 'EVEN' || t === 'EV' ? 100 : Number(t);
      return Number.isFinite(n) && Number.isInteger(n) && (n <= -100 || n >= 100) && Math.abs(n) <= MAX_AMERICAN_ODDS ? n : null;
    };
    // A bare -115, the string "-115", or EVEN/EV. Not an object, and not a yard line.
    const plainNumber = (raw) => {
      if (typeof raw === 'number') return Number.isFinite(raw);
      if (typeof raw !== 'string') return false;
      const t = raw.trim().replace(/[−–]/g, '-').toUpperCase();
      if (t === 'EVEN' || t === 'EV') return true;
      return /^[+-]?\d+(\.\d+)?$/.test(t);
    };
    const sideOf = (path) => {
      const parts = path.split(/[.[\]]/).filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i];
        if (/^under/i.test(part) || /\bunder\b/i.test(part)) return 'under';
        if (/^over/i.test(part) || /\bover\b/i.test(part)) return 'over';
      }
      return null;
    };
    function walk(obj, path, depth) {
      if (obj == null || depth > 8) return;
      if (Array.isArray(obj)) {
        obj.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
        return;
      }
      if (typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        if (k === '$ref' || k === 'lastUpdated') continue;
        const p = path ? `${path}.${k}` : k;
        const take = (odds) => {
          const mark = `${p}:${odds}`;
          if (odds == null || seen.has(mark)) return;
          seen.add(mark);
          found.push({ path: p, odds, side: sideOf(p) });
        };
        if (priceKey(k) && (typeof v === 'string' || typeof v === 'number')) take(asAmerican(v));
        else if (v && typeof v === 'object') {
          // `{american:{value:"-120"}}`: the price key is the parent. Record the first real price.
          // Only a key that is exactly `over` or `under` is a bare side. `overUnder` is not, and
          // neither is a line or an id nested under an over. After a bare side, a sibling with
          // that same side and the same number is marked seen. A sideless copy is dropped only
          // when this object already recorded that number with a side.
          if (priceKey(k) && !Array.isArray(v)) {
            const local = [];
            for (const [innerKey, raw] of Object.entries(v)) {
              if (!/^(over|under)$/i.test(innerKey) || !plainNumber(raw)) continue;
              const n = asAmerican(raw);
              if (n == null) continue;
              const child = `${p}.${innerKey}`;
              const side = /^over$/i.test(innerKey) ? 'over' : 'under';
              const mark = `${child}:${n}`;
              if (seen.has(mark)) continue;
              seen.add(mark);
              const hit = { path: child, odds: n, side };
              found.push(hit);
              local.push(hit);
              for (const [sib, sibRaw] of Object.entries(v)) {
                if (sib === innerKey || sideOf(sib) !== side) continue;
                if (asAmerican(sibRaw) !== n) continue;
                seen.add(`${p}.${sib}:${n}`);
              }
            }
            const preferred = ['value', 'odds', 'american', 'price', 'americanOdds'];
            const innerKeys = preferred.concat(Object.keys(v).filter((ik) => priceKey(ik) && !preferred.includes(ik)));
            let firstN = null;
            for (const innerKey of innerKeys) {
              if (sideOf(`${p}.${innerKey}`)) continue;
              const raw = v[innerKey];
              if (typeof raw !== 'string' && typeof raw !== 'number') continue;
              const n = asAmerican(raw);
              if (n == null) continue;
              if (local.some((h) => h.odds === n && h.side)) {
                seen.add(`${p}.${innerKey}:${n}`);
                if (firstN == null) firstN = n;
                continue;
              }
              if (firstN == null) {
                take(n);
                firstN = n;
              }
              if (n !== firstN) continue;
              seen.add(`${p}.${innerKey}:${n}`);
            }
          }
          walk(v, p, depth + 1);
        }
      }
    }
    walk(root, '', 0);
    return found;
  }

  // Sportsbook moneylines -> win chances with the bookmaker's margin ("vig") removed, so they sum to 100%.
  function impliedFromMoneylines(mlHome, mlAway) {
    const p = (ml) => { const n = num(ml); return n == null || n === 0 ? null : n < 0 ? -n / (-n + 100) : 100 / (n + 100); };
    const h = p(mlHome);
    const a = p(mlAway);
    if (h == null || a == null) return null;
    return { home: (h / (h + a)) * 100, away: (a / (h + a)) * 100 };
  }

  // ---------- Prediction market (Polymarket) ----------

  // Polymarket lists each NFL game as an event with a predictable slug: nfl-{away}-{home}-{date}.
  // The date is the kickoff's UTC date, so night games carry the next day's date; the Eastern date is
  // tried as a fallback.
  const PM = 'https://gamma-api.polymarket.com';
  const PM_CLOB = 'https://clob.polymarket.com';
  const PM_ABBR = { LAR: 'la', WSH: 'was' };      // where Polymarket's team codes differ from ESPN's
  // Moneyline: today's books run from about $5k to $131k traded, with much more sitting available.
  // Each total line is thinner, so its floor is lower. A missing liquidity figure does not skip the market.
  const ML_MIN_VOLUME = 10000;
  const ML_MIN_LIQUIDITY = 10000;
  const TOTAL_MIN_VOLUME = 2500;
  const TOTAL_MIN_LIQUIDITY = 5000;
  const marketCache = new Map();

  const pmCode = (abbr) => PM_ABBR[abbr] || abbr.toLowerCase();
  const utcDate = (d) => d.toISOString().slice(0, 10);
  const easternDate = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // After kickoff a market trades on the live game (and settles to 100/0), so use its last price
  // before kickoff instead.
  async function pregamePrice(tokenId, kickoff) {
    const end = Math.floor(kickoff.getTime() / 1000);
    const d = await getJSON(`${PM_CLOB}/prices-history?market=${encodeURIComponent(tokenId)}&startTs=${end - 2 * 86400}&endTs=${end}&fidelity=60`);
    // The API can include points after endTs (the settled price), so keep only those before kickoff.
    const hist = ((d && d.history) || []).filter((pt) => pt.t <= end);
    return hist.length ? Number(hist[hist.length - 1].p) : null;
  }

  async function parseMarket(event, g) {
    const markets = event.markets || [];
    const ml = markets.find((m) => m.sportsMarketType === 'moneyline') || markets[0];
    if (!ml) return null;
    const outcomes = JSON.parse(ml.outcomes || '[]');
    const prices = JSON.parse(ml.outcomePrices || '[]').map(Number);
    const matches = (name, side) => side && [side.short, side.name].some((s) => s && (s.includes(name) || name.includes(s)));
    let hi = outcomes.findIndex((o) => matches(o, g.home));
    let ai = outcomes.findIndex((o) => matches(o, g.away));
    if (hi < 0 || ai < 0) { ai = 0; hi = 1; }       // Polymarket orders away team first
    // Number(null) and Number('') are 0, which would look like a real zero. Skip those.
    const moneyOf = (...vals) => {
      for (const v of vals) {
        if (v == null || v === '') continue;
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      return null;
    };
    const volume = moneyOf(ml.volumeNum, ml.volume) ?? 0;
    const liquidity = moneyOf(ml.liquidityNum, ml.liquidity, ml.liquidityClob);
    const moneylineThin = volume < ML_MIN_VOLUME || (liquidity != null && liquidity < ML_MIN_LIQUIDITY);
    // Every total line, not just the busiest one. A book can move to a quieter line that still qualifies.
    const byLine = new Map();
    for (const mkt of markets) {
      if (mkt.sportsMarketType !== 'totals') continue;
      const line = num(((mkt.question || '').match(/O\/U\s*([\d.]+)/) || [])[1]);
      let to = [];
      let tp = [];
      try {
        to = JSON.parse(mkt.outcomes || '[]');
        tp = JSON.parse(mkt.outcomePrices || '[]').map(Number);
      } catch { continue; }
      const oi = to.findIndex((x) => /^over$/i.test(String(x)));
      const ui = to.findIndex((x) => /^under$/i.test(String(x)));
      const overPx = tp[oi];
      const underPx = tp[ui];
      if (line == null || !(overPx > 0) || !(underPx > 0)) continue;
      const vol = moneyOf(mkt.volumeNum, mkt.volume) ?? 0;
      const liq = moneyOf(mkt.liquidityNum, mkt.liquidity, mkt.liquidityClob);
      const thin = vol < TOTAL_MIN_VOLUME || (liq != null && liq < TOTAL_MIN_LIQUIDITY);
      const row = { line, over: (overPx / (overPx + underPx)) * 100, volume: vol, thin };
      const prev = byLine.get(line);
      if (!prev || row.volume > prev.volume) byLine.set(line, row);
    }
    const parsedTotals = [...byLine.values()];
    const totals = parsedTotals.filter((t) => !t.thin).map(({ line, over, volume: vol }) => ({ line, over, volume: vol }));
    const thinTotals = parsedTotals.filter((t) => t.thin).map(({ line, over, volume: vol }) => ({ line, over, volume: vol }));
    const total = totals.slice().sort((a, b) => b.volume - a.volume)[0] || null;
    const out = {
      url: `https://polymarket.com/event/${encodeURIComponent(event.slug || '')}`,
      closed: !!ml.closed,
      home: prices[hi] * 100, away: prices[ai] * 100,
      volume, liquidity, thin: moneylineThin, total, totals, thinTotals,
    };
    if (g.state !== 'pre') {
      const tokens = JSON.parse(ml.clobTokenIds || '[]');
      const homePre = tokens[hi] ? await pregamePrice(tokens[hi], g.kickoff).catch(() => null) : null;
      if (homePre == null) return null;
      Object.assign(out, { home: homePre * 100, away: (1 - homePre) * 100, pregame: true, total: null, totals: [], thinTotals: [] });
    }
    return out;
  }

  function market(g) {
    if (!g.home || !g.away || !g.home.abbr || !g.away.abbr) return Promise.resolve(null);
    const hit = marketCache.get(g.id);
    if (hit && Date.now() - hit.at < ODDS_TTL_MS) return hit.promise;
    const base = `nfl-${pmCode(g.away.abbr)}-${pmCode(g.home.abbr)}-`;
    const slugs = [...new Set([utcDate(g.kickoff), easternDate(g.kickoff)])].map((d) => base + d);
    const promise = (async () => {
      for (const slug of slugs) {
        const events = await getJSON(`${PM}/events?slug=${encodeURIComponent(slug)}`);
        if (Array.isArray(events) && events[0]) return parseMarket(events[0], g);
      }
      return null;   // no market listed yet
    })();
    promise.catch(() => marketCache.delete(g.id));
    marketCache.set(g.id, { at: Date.now(), promise });
    return promise;
  }

  // For a finished game: who covered the spread, and whether the total went over or under.
  function bettingResult(g, lines) {
    const home = num(g.home && g.home.score);
    const away = num(g.away && g.away.score);
    if (home == null || away == null || !lines) return null;
    const res = {};
    if (lines.homeLine != null) {
      const ats = home - away + lines.homeLine;
      res.ats = ats === 0 ? { push: true } : ats > 0
        ? { team: g.home.abbr, line: lines.homeLine } : { team: g.away.abbr, line: -lines.homeLine };
    }
    if (lines.total != null) {
      const pts = home + away;
      res.ou = { points: pts, total: lines.total, result: pts > lines.total ? 'Over' : pts < lines.total ? 'Under' : 'Push' };
    }
    return res;
  }

  // How far to trust the forecast, by days until kickoff (see the app's Accuracy by lead time).
  function confidence(daysOut) {
    if (daysOut <= 2) return { label: 'High', note: 'usually within about 2–3°' };
    if (daysOut <= 5) return { label: 'Medium', note: 'often off by 3–5°' };
    if (daysOut <= 10) return { label: 'Low', note: 'can be off by 5° or more; will firm up' };
    return { label: 'Very low', note: 'a rough outlook only' };
  }

  // Full refresh: forget every reused answer (in memory and the 30-minute forecast store) so the next
  // render downloads fresh forecasts, odds and market prices. Stadium locations are kept; they don't change.
  async function clearCaches() {
    forecastCache.clear();
    seasonCache = null;
    historyCache.clear();
    oddsCache.clear();
    marketCache.clear();
    if ('caches' in self) await caches.delete(METEO_CACHE).catch(() => {});
  }

  // Just the odds summaries (lines, projections, injury reports), e.g. for a prop refresh;
  // forecasts and market prices are left alone.
  function clearSeason() { seasonCache = null; }

  function clearOdds() {
    oddsCache.clear();
  }

  return {
    clearCaches, clearOdds, clearSeason, teams, teamSchedule, thisWeek, seasonSoFar, locate, hourly, pastHourly, gameWindow, impact, confidence, odds, market,
    impliedFromMoneylines, combineFair, blendFair, winShares, americanOddsIn, bettingResult, ROOF_LABEL, FORECAST_DAYS,
  };
})();
