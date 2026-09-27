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

  // A full week is ~14 stadiums, and firing all their forecast requests at once (again on every
  // reload) is what drew 429 "too many requests" replies. So Open-Meteo calls go through a small
  // queue (a few at a time), a 429 is retried after a pause, and forecasts are kept for 30 minutes
  // in the browser's Cache Storage so reloading the page doesn't download them again.
  const METEO_CONCURRENCY = 3;
  const METEO_RETRY_DELAYS_MS = [2000, 4000, 8000];
  const METEO_CACHE = 'gameday-forecasts-v1';
  let meteoActive = 0;
  const meteoWaiting = [];

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

  async function meteoFetch(url) {
    for (let attempt = 0; ; attempt++) {
      const res = await meteoSlot(() => fetch(url));
      if (res.status === 429 && attempt < METEO_RETRY_DELAYS_MS.length) {
        const retryAfter = Number(res.headers.get('Retry-After')) * 1000;
        await sleep(retryAfter > 0 ? retryAfter : METEO_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
      return res;
    }
  }

  // JSON from Open-Meteo, reused for `maxAgeMs` across page loads when Cache Storage is available.
  async function meteoJSON(url, maxAgeMs = 0) {
    let cache = null;
    if (maxAgeMs && 'caches' in self) {
      try { cache = await caches.open(METEO_CACHE); } catch { cache = null; }
    }
    if (cache) {
      const hit = await cache.match(url);
      const at = hit && Number(hit.headers.get('x-fetched-at'));
      if (hit && Date.now() - at < maxAgeMs) return hit.json();
    }
    const res = await meteoFetch(url);
    const body = await res.text();
    if (cache) {
      const stamped = new Response(body, { headers: { 'Content-Type': 'application/json', 'x-fetched-at': String(Date.now()) } });
      cache.put(url, stamped).catch(() => { /* storage full or unavailable: fine */ });
    }
    return JSON.parse(body);
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
    };
  }

  async function teamSchedule(abbr) {
    const d = await getJSON(`${ESPN}/teams/${encodeURIComponent(abbr.toLowerCase())}/schedule`);
    return (d.events || []).map(normalize);
  }

  async function thisWeek() {
    const d = await getJSON(`${ESPN}/scoreboard`);
    return { label: d.week ? `Week ${d.week.number}` : 'This week', games: (d.events || []).map(normalize) };
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
    const vars = 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,snowfall,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m';
    // GMT keeps hour stamps comparable with ESPN's UTC kickoff times.
    const url = `${FORECAST}?latitude=${loc.lat}&longitude=${loc.lon}&hourly=${vars}&past_days=7&forecast_days=${FORECAST_DAYS}`
      + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=GMT';
    const promise = meteoJSON(url, FORECAST_TTL_MS).then((d) => d.hourly);
    promise.catch(() => forecastCache.delete(key));
    forecastCache.set(key, { at: Date.now(), promise });
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
        pop: h.precipitation_probability[i], precip: h.precipitation[i] || 0, snow: h.snowfall[i] || 0,
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
      popMax: max('pop'), precip: sum('precip'), snow: sum('snow'),
      windMax: max('wind'), gustMax: max('gust'), windDir: compass(hours[0].dir || 0),
      code: worst.code, condition: WMO[worst.code] || 'Unknown',
    };
  }

  // ---------- Impact on play ----------

  // Levels: 0 none (roof), 1 low, 2 moderate, 3 high. Thresholds are rules of thumb for NFL play:
  // sustained wind near 20 mph and gusts past 30 affect passing and kicking; heavy rain, snow, lightning,
  // bitter cold and heat each change how a game is played or managed.
  // `past`: the game has been played, so rain is judged by what fell rather than the forecast chance.
  function impact(w, roof, past = false) {
    if (roof === 'dome' || roof === 'canopy') {
      return { level: 0, label: 'None', reasons: [roof === 'dome' ? 'Indoors: weather won’t affect play' : 'Roof covers the field'] };
    }
    const reasons = [];
    let level = 1;
    const add = (lvl, text) => { reasons.push(text); level = Math.max(level, lvl); };
    if (w.code >= 95) add(3, 'Thunderstorms: lightning delays possible');
    if (w.snow >= 0.5) add(3, `Snow (${w.snow.toFixed(1)}″)`);
    else if (w.snow > 0.05) add(2, 'Some snow');
    if (past) {
      if (w.precip >= 0.25) add(3, `Heavy rain (${w.precip.toFixed(2)}″ fell)`);
      else if (w.precip >= 0.03) add(2, `Rain (${w.precip.toFixed(2)}″ fell)`);
      else if (w.precip > 0) add(1, 'A little rain');
    } else if (w.precip >= 0.25 && w.popMax >= 50) add(3, `Heavy rain (${w.precip.toFixed(2)}″)`);
    else if (w.popMax >= 50 && w.precip >= 0.03) add(2, `Rain likely (${Math.round(w.popMax)}%)`);
    else if (w.popMax >= 30) add(1, `Chance of showers (${Math.round(w.popMax)}%)`);
    if (w.windMax >= 20 || w.gustMax >= 35) add(3, `Strong wind (${Math.round(w.windMax)} mph, gusts ${Math.round(w.gustMax)})`);
    else if (w.windMax >= 13 || w.gustMax >= 25) add(2, `Breezy (${Math.round(w.windMax)} mph, gusts ${Math.round(w.gustMax)})`);
    if (w.feelsMin <= 10) add(3, `Bitter cold (feels ${Math.round(w.feelsMin)}°)`);
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

  const num = (s) => (s == null || s === '' ? null : parseFloat(String(s).replace(/^[ou]/, '')));

  function parseOdds(summary, g) {
    const p = (summary.pickcenter || [])[0];
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
    const out = { win, lines: null, injuries: parseInjuries(summary) };
    if (!p) return out;
    const ps = p.pointSpread || {};
    const ml = p.moneyline || {};
    const tot = p.total || {};
    const homeLine = num(ps.home && ps.home.close && ps.home.close.line) ?? (p.spread != null ? p.spread : null);
    out.lines = {
      provider: (p.provider && (p.provider.displayName || p.provider.name)) || 'Sportsbook',
      homeLine,                                                   // negative = home favored
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
    return out;
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

  // Sportsbook moneylines -> win chances with the bookmaker's margin ("vig") removed, so they sum to 100%.
  function impliedFromMoneylines(mlHome, mlAway) {
    const p = (ml) => { const n = num(ml); return n == null ? null : n < 0 ? -n / (-n + 100) : 100 / (n + 100); };
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
  const THIN_MARKET_USD = 1000;                   // below this much traded, prices mean little
  const marketCache = new Map();

  const pmCode = (abbr) => PM_ABBR[abbr] || abbr.toLowerCase();
  const utcDate = (d) => d.toISOString().slice(0, 10);
  const easternDate = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // After kickoff a market trades on the live game (and settles to 100/0), so use its last price
  // before kickoff instead.
  async function pregamePrice(tokenId, kickoff) {
    const end = Math.floor(kickoff.getTime() / 1000);
    const d = await getJSON(`${PM_CLOB}/prices-history?market=${encodeURIComponent(tokenId)}&startTs=${end - 2 * 86400}&endTs=${end}&fidelity=60`);
    const hist = (d && d.history) || [];
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
    const volume = Number(ml.volumeNum ?? ml.volume ?? 0);
    const totals = markets.filter((m) => m.sportsMarketType === 'totals')
      .sort((a, b) => Number(b.volumeNum || 0) - Number(a.volumeNum || 0))[0];
    let total = null;
    if (totals && Number(totals.volumeNum || 0) >= THIN_MARKET_USD) {   // untraded total markets sit at placeholder lines
      const line = num((totals.question.match(/O\/U\s*([\d.]+)/) || [])[1]);
      const tp = JSON.parse(totals.outcomePrices || '[]').map(Number);
      const to = JSON.parse(totals.outcomes || '[]');
      const over = tp[to.indexOf('Over')];
      if (line != null && over != null) total = { line, over: over * 100, volume: Number(totals.volumeNum || 0) };
    }
    const out = {
      url: `https://polymarket.com/event/${event.slug}`,
      closed: !!ml.closed,
      home: prices[hi] * 100, away: prices[ai] * 100,
      volume, thin: volume < THIN_MARKET_USD, total,
    };
    if (g.state !== 'pre') {
      const tokens = JSON.parse(ml.clobTokenIds || '[]');
      const homePre = tokens[hi] ? await pregamePrice(tokens[hi], g.kickoff).catch(() => null) : null;
      if (homePre == null) return null;
      Object.assign(out, { home: homePre * 100, away: (1 - homePre) * 100, pregame: true, total: null });
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
    oddsCache.clear();
    marketCache.clear();
    if ('caches' in self) await caches.delete(METEO_CACHE).catch(() => {});
  }

  // Just the odds summaries (lines, projections, injury reports), e.g. for a prop refresh;
  // forecasts and market prices are left alone.
  function clearOdds() {
    oddsCache.clear();
  }

  return { clearCaches, clearOdds, teams, teamSchedule, thisWeek, locate, hourly, gameWindow, impact, confidence, odds, market, impliedFromMoneylines, bettingResult, ROOF_LABEL, FORECAST_DAYS };
})();
