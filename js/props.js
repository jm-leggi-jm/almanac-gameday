// Player-prop parlays (Parlays tab): 3-, 4-, 5- and 6-leg parlays made only of player props.
// Props: DraftKings' over/under lines via ESPN (passing, rushing and receiving yards, receptions).
// ESPN doesn't carry prop prices, so each leg is priced at a standard -110 and flagged as assumed.
// A leg's chance comes from the player's history: how often he cleared that line in his most recent
// games (this season and last), pulled toward 50% so small samples don't look like sure things.
// Built on demand (it checks every player's game log), then reused for 6 hours. Informational only.
(() => {
  const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';
  const WEB = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl';
  const SITE = 'https://site.api.espn.com/apis/common/v3/sports/football/nfl';
  const SIZES = [3, 4, 5, 6];
  const ASSUMED_ODDS = -110;
  const RECENT_GAMES = 16;
  const MIN_GAMES = 6;          // skip players with too little history
  const SHRINK = 4;             // pseudo-games (half over, half under) blended into every hit rate
  const MAX_PER_GAME = 2;       // limit legs from one game, since they tend to move together
  const CONCURRENCY = 6;
  const CACHE = 'gameday-props-v1';
  const TTL_MS = 6 * 60 * 60 * 1000;
  const STAKE = 5;   // payouts are shown for a $5 bet

  // `minLine` drops depth-player lines (e.g. over 0.5 receptions), which are never priced near -110.
  const PROP_TYPES = {
    'Total Passing Yards (incl. overtime)': { label: 'passing yds', stats: ['passingYards'], minLine: 149.5 },
    'Total Rushing Yards (incl. overtime)': { label: 'rushing yds', stats: ['rushingYards'], minLine: 14.5 },
    'Total Receiving Yards (incl. overtime)': { label: 'receiving yds', stats: ['receivingYards'], minLine: 14.5 },
    'Total Receptions (incl. overtime)': { label: 'receptions', stats: ['receptions'], minLine: 1.5 },
  };
  // Only props whose line sits inside the player's normal range: he cleared it in 20-80% of recent
  // games. That's where a book prices both sides near -110 (so the assumed price is fair). Outside
  // it, the line is an alternate one, or the book knows something the history doesn't (a new role,
  // an injury), and history would badly overstate the chance.
  const NORMAL_RANGE = [0.2, 0.8];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MINUS = '−';

  // ---------- Fetching: a few at a time, reused for 6 hours ----------

  let active = 0;
  const waiting = [];
  async function slot(job) {
    if (active >= CONCURRENCY) await new Promise((r) => waiting.push(r));
    active++;
    try { return await job(); } finally { active--; const next = waiting.shift(); if (next) next(); }
  }

  async function cachedJSON(url) {
    let cache = null;
    try { cache = 'caches' in self ? await caches.open(CACHE) : null; } catch { cache = null; }
    if (cache) {
      const hit = await cache.match(url);
      if (hit && Date.now() - Number(hit.headers.get('x-fetched-at')) < TTL_MS) return hit.json();
    }
    const res = await slot(() => fetch(url));
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    const body = await res.text();
    if (cache) cache.put(url, new Response(body, { headers: { 'x-fetched-at': String(Date.now()) } })).catch(() => {});
    return JSON.parse(body);
  }

  // ---------- Data ----------

  async function gameProps(g) {
    const base = `${CORE}/events/${g.id}/competitions/${g.id}/odds/100/propBets?limit=1000`;
    const first = await cachedJSON(`${base}&page=1`);
    const pages = [first];
    for (let p = 2; p <= (first.pageCount || 1); p++) pages.push(await cachedJSON(`${base}&page=${p}`));
    const seen = new Map();
    for (const item of pages.flatMap((x) => x.items || [])) {
      const type = PROP_TYPES[item.type && item.type.name];
      const line = item.current && item.current.target && item.current.target.value;
      const athleteId = ((item.athlete && item.athlete.$ref) || '').match(/athletes\/(\d+)/);
      if (!type || line == null || !athleteId) continue;
      const key = `${athleteId[1]}|${item.type.name}`;   // ESPN lists the over and under as twin entries
      if (!seen.has(key)) seen.set(key, { g, athleteId: athleteId[1], type, line: Number(line) });
    }
    return [...seen.values()];
  }

  // One player's recent games, newest first: [{ [statName]: number }]
  async function recentGames(athleteId, season) {
    const logs = await Promise.all([season, season - 1].map((s) =>
      cachedJSON(`${WEB}/athletes/${athleteId}/gamelog?season=${s}`).catch(() => null)));
    const games = [];
    for (const log of logs) {
      if (!log || !log.names) continue;
      for (const st of log.seasonTypes || []) {
        if (/preseason/i.test(st.displayName || '')) continue;
        for (const cat of st.categories || []) {
          for (const ev of cat.events || []) {
            const row = {};
            log.names.forEach((n, i) => { const v = parseFloat(String(ev.stats[i]).replace(/,/g, '')); if (!Number.isNaN(v)) row[n] = v; });
            const meta = (log.events || {})[ev.eventId] || {};
            games.push({ date: meta.gameDate || '', row });
          }
        }
      }
    }
    return games.sort((a, b) => b.date.localeCompare(a.date)).slice(0, RECENT_GAMES).map((x) => x.row);
  }

  async function playerInfo(athleteId) {
    const d = await cachedJSON(`${SITE}/athletes/${athleteId}`).catch(() => null);
    const a = (d && d.athlete) || {};
    return { name: a.displayName || `Player ${athleteId}`, team: (a.team && a.team.abbreviation) || '', pos: (a.position && a.position.abbreviation) || '' };
  }

  function evaluate(prop, games) {
    const values = games.map((row) => prop.type.stats.reduce((sum, s) => sum + (row[s] ?? NaN), 0)).filter((v) => !Number.isNaN(v));
    if (values.length < MIN_GAMES || prop.line < prop.type.minLine) return null;
    const over = values.filter((v) => v > prop.line).length;
    const n = values.length;
    if (over / n < NORMAL_RANGE[0] || over / n > NORMAL_RANGE[1]) return null;
    const pOver = (over + SHRINK / 2) / (n + SHRINK);
    const pickOver = pOver >= 0.5;
    return { ...prop, n, hits: pickOver ? over : n - over, side: pickOver ? 'Over' : 'Under', prob: pickOver ? pOver : 1 - pOver, avg: values.reduce((a, b) => a + b, 0) / n };
  }

  async function buildLegs(onProgress) {
    const week = await Football.thisWeek();
    const games = week.games.filter((g) => g.state === 'pre');
    const now = new Date();
    const season = now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear();   // Jan-Feb games belong to last year's season
    const props = (await Promise.all(games.map((g) => gameProps(g).catch(() => [])))).flat();
    const athletes = [...new Set(props.map((p) => p.athleteId))];
    const byAthlete = new Map();
    let done = 0;
    onProgress(0, athletes.length);
    await Promise.all(athletes.map(async (id) => {
      const [info, recent] = await Promise.all([playerInfo(id), recentGames(id, season)]);
      byAthlete.set(id, { info, recent });
      onProgress(++done, athletes.length);
    }));
    const legs = props.map((p) => {
      const a = byAthlete.get(p.athleteId);
      const e = a && evaluate(p, a.recent);
      return e && { ...e, player: a.info };
    }).filter(Boolean).sort((x, y) => y.prob - x.prob || y.n - x.n);
    return { week, games: games.length, props: props.length, players: athletes.length, legs };
  }

  // One leg per player, at most MAX_PER_GAME per game, taking the likeliest legs first.
  function pickLegs(legs, size) {
    const players = new Set();
    const perGame = new Map();
    const chosen = [];
    for (const l of legs) {
      if (chosen.length === size) break;
      if (players.has(l.athleteId) || (perGame.get(l.g.id) || 0) >= MAX_PER_GAME) continue;
      chosen.push(l);
      players.add(l.athleteId);
      perGame.set(l.g.id, (perGame.get(l.g.id) || 0) + 1);
    }
    return chosen;
  }

  // ---------- Rendering ----------

  const decimal = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
  const american = (d) => { const a = d >= 2 ? (d - 1) * 100 : -100 / (d - 1); return `${a > 0 ? '+' : MINUS}${Math.round(Math.abs(a)).toLocaleString()}`; };
  const pct = (p) => `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;

  function card(size, legs) {
    const chosen = pickLegs(legs, size);
    if (chosen.length < size) {
      return `<article class="parlay"><header class="p-head"><h3>${size}-leg prop parlay</h3></header>
        <p class="gd-wait">Not enough props with enough player history this week.</p></article>`;
    }
    const dec = decimal(ASSUMED_ODDS) ** size;
    const ours = chosen.reduce((a, l) => a * l.prob, 1);
    const rows = chosen.map((l) => `
      <li class="p-leg">
        <div class="p-leg-top">
          <span class="p-game">${esc(l.player.name)}</span>
          <b class="p-pick">${l.side} ${l.line} ${esc(l.type.label)}</b>
          <span class="p-odds">${MINUS}110*</span>
          <span class="p-prob">${pct(l.prob)}</span>
        </div>
        <div class="p-why">${esc([l.player.pos, l.player.team].filter(Boolean).join(', '))} · ${esc(l.g.shortName)} ·
          ${l.side === 'Over' ? 'over' : 'under'} in ${l.hits} of his last ${l.n} games (avg ${l.avg.toFixed(1)})</div>
      </li>`).join('');
    return `
      <article class="parlay">
        <header class="p-head"><h3>${size}-leg prop parlay</h3><span class="p-total">${american(dec)}*</span></header>
        <dl class="p-stats">
          <div title="What a $${STAKE} bet returns if every leg hits, including your $${STAKE} back, assuming each leg is priced at -110.">
            <dt>$${STAKE} bet pays*</dt><dd>$${(STAKE * dec).toFixed(2)}</dd><span class="p-sub">if every leg hits</span></div>
          <div title="How often all these legs would have hit together, going by each player's recent games.">
            <dt>Chance it hits</dt><dd>${pct(ours)}</dd><span class="p-sub">by past games</span></div>
          <div title="How often the parlay must hit for this payout to break even, at the assumed -110 per leg.">
            <dt>Break-even*</dt><dd>${pct(1 / dec)}</dd><span class="p-sub">what this payout needs</span></div>
        </dl>
        <p class="p-verdict warn">⚠ <b>Past games say ${pct(ours)}, well above the ${pct(1 / dec)} needed.</b> That gap is probably not an edge:
          past games don't know about injuries, matchups or role changes that the sportsbook prices in, so the real chance is likely lower.</p>
        <ol class="p-legs">${rows}</ol>
      </article>`;
  }

  let building = false;
  async function build() {
    if (building) return;
    building = true;
    $('pp-build').disabled = true;
    $('pp-list').innerHTML = '';
    try {
      const result = await buildLegs((done, total) => {
        $('pp-status').textContent = total ? `Checking player histories: ${done} of ${total}…` : 'Loading this week’s props…';
      });
      const updated = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      $('pp-status').textContent = `${result.props} props from ${result.games} upcoming games · ${result.players} players checked · ${result.legs.length} with enough history · updated ${updated}`;
      $('pp-list').innerHTML = SIZES.map((n) => card(n, result.legs)).join('');
      $('pp-build').textContent = '↻ Rebuild prop parlays';
    } catch (err) {
      $('pp-status').textContent = `Couldn’t build prop parlays (${err.message}).`;
    } finally {
      building = false;
      $('pp-build').disabled = false;
    }
  }

  $('pp-build').addEventListener('click', build);
})();
