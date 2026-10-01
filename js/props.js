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
  const MAX_SIZE = Math.max(...SIZES);
  const MAX_PER_GAME = 2;       // limit legs from one game, since they tend to move together
  const GAMES_KEY = 'gameday.propGames.v1';
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

  // `fresh` skips the reuse window (a refresh), still saving the new copy for later.
  async function cachedJSON(url, fresh = false) {
    let cache = null;
    try { cache = 'caches' in self ? await caches.open(CACHE) : null; } catch { cache = null; }
    if (cache) {
      const hit = await cache.match(url);
      if (!fresh && hit && Date.now() - Number(hit.headers.get('x-fetched-at')) < TTL_MS) return hit.json();
    }
    const res = await slot(() => fetch(url));
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    const body = await res.text();
    const json = JSON.parse(body);   // parse first: never cache a body that isn't JSON
    if (cache) cache.put(url, new Response(body, { headers: { 'x-fetched-at': String(Date.now()) } })).catch(() => {});
    return json;
  }

  // ---------- Data ----------

  async function gameProps(g, fresh = false) {
    const base = `${CORE}/events/${g.id}/competitions/${g.id}/odds/100/propBets?limit=1000`;
    const first = await cachedJSON(`${base}&page=1`, fresh);
    const pages = [first];
    for (let p = 2; p <= (first.pageCount || 1); p++) pages.push(await cachedJSON(`${base}&page=${p}`, fresh));
    const seen = new Map();
    for (const item of pages.flatMap((x) => x.items || [])) {
      const type = PROP_TYPES[item.type && item.type.name];
      const line = item.current && item.current.target && item.current.target.value;
      const athleteId = ((item.athlete && item.athlete.$ref) || '').match(/athletes\/(\d+)/);
      if (!type || line == null || !athleteId) continue;
      const key = `${athleteId[1]}|${item.type.name}`;   // ESPN lists the over and under as twin entries
      const open = item.open && item.open.target && item.open.target.value;
      if (!seen.has(key)) seen.set(key, { g, athleteId: athleteId[1], type, line: Number(line), openLine: open == null ? null : Number(open) });
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
    const values = games.map((row) => prop.type.stats.reduce((sum, s) => sum + (row[s] ?? NaN), 0)).filter((v) => !Number.isNaN(v) && v !== prop.line);   // a push is neither over nor under
    if (values.length < MIN_GAMES || prop.line < prop.type.minLine) return null;
    const over = values.filter((v) => v > prop.line).length;
    const n = values.length;
    if (over / n < NORMAL_RANGE[0] || over / n > NORMAL_RANGE[1]) return null;
    const pOver = (over + SHRINK / 2) / (n + SHRINK);
    const pickOver = pOver >= 0.5;
    return { ...prop, n, hits: pickOver ? over : n - over, side: pickOver ? 'Over' : 'Under', prob: pickOver ? pOver : 1 - pOver, avg: values.reduce((a, b) => a + b, 0) / n };
  }

  // `fresh`: re-download prop lines and injury reports (player game histories are still reused).
  async function buildLegs(onProgress, fresh = false) {
    const week = await Football.thisWeek();
    const games = week.games.filter((g) => g.state === 'pre' && selected.has(g.id));   // unchecked games cost no lookups
    const now = new Date();
    const season = now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear();   // Jan-Feb games belong to last year's season
    if (fresh) Football.clearOdds();   // injury reports come with the odds summaries
    const props = (await Promise.all(games.map((g) => gameProps(g, fresh).catch(() => [])))).flat();
    // Injury reports (from the game summaries the game cards already load): player id -> status.
    const injuryById = new Map();
    const summaries = await Promise.all(games.map((g) => Football.odds(g).catch(() => null)));
    for (const s of summaries) for (const list of Object.values((s && s.injuries) || {})) for (const i of list) injuryById.set(i.id, i.status);
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
      if (!e) return null;
      const injury = injuryById.get(String(p.athleteId)) || null;
      if (injury && injury !== 'Questionable') return null;   // out, doubtful or suspended: likely not playing
      return { ...e, player: a.info, injury, signals: propSignals(e, injury) };
    }).filter(Boolean).sort((x, y) => y.prob - x.prob || y.n - x.n);
    return { week, games: games.length, props: props.length, players: athletes.length, legs };
  }

  // Signal chips for a prop leg: line movement since open, and the player's own injury status.
  function propSignals(e, injury) {
    const signals = [];
    if (e.openLine != null) {
      const moved = e.line - e.openLine;
      const move = `${e.openLine} → ${e.line}`;
      if (moved === 0) signals.push({ tone: 'neutral', text: `• Line steady (${e.line})`, tip: 'The line hasn’t moved since it opened.' });
      else if ((moved > 0) === (e.side === 'Over')) signals.push({ tone: 'good', text: `▲ Line moved toward this pick (${move})`, tip: 'The sportsbook moved the line in the direction of this bet, a sign money agrees with it.' });
      else signals.push({ tone: 'bad', text: `▼ Line moved against this pick (${move})`, tip: 'The sportsbook moved the line away from this bet since it opened.' });
    }
    signals.push(injury
      ? { tone: 'bad', text: '⚠ Listed questionable', tip: 'On the injury report as questionable: he may sit, or play limited snaps.' }
      : { tone: 'good', text: '✓ Not on the injury report', tip: 'Not listed as out, doubtful or questionable.' });
    return signals;
  }

  // With only a few games picked, the per-game limit rises so the biggest parlay can still fill.
  const gameCap = (gameCount) => Math.max(MAX_PER_GAME, Math.ceil(MAX_SIZE / Math.max(gameCount, 1)));

  // One leg per player, at most `cap` per game, taking the likeliest legs first and skipping
  // players in `skip` and props in `skipProps` (those shown in earlier sets, so a refresh brings new picks).
  const propKey = (l) => `${l.athleteId}|${l.type.label}`;
  function pickLegs(legs, size, skip = new Set(), cap = MAX_PER_GAME, skipProps = new Set()) {
    const players = new Set();
    const perGame = new Map();
    const chosen = [];
    for (const l of legs) {
      if (chosen.length === size) break;
      if (skip.has(l.athleteId) || skipProps.has(propKey(l)) || players.has(l.athleteId) || (perGame.get(l.g.id) || 0) >= cap) continue;
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

  function card(size, legs, skip, cap, skipProps) {
    const chosen = pickLegs(legs, size, skip, cap, skipProps);
    if (chosen.length < size) {
      return `<article class="parlay"><header class="p-head"><h3>${size}-leg prop parlay</h3></header>
        <p class="gd-wait">Not enough eligible props in the selected games for ${size} legs.</p></article>`;
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
        ${window.ParlaySignals ? window.ParlaySignals.dropdown(chosen, (l) => `${l.player.name} ${l.side} ${l.line}`) : ''}
        <p class="p-verdict warn">⚠ <b>Past games say ${pct(ours)}, ${ours > 1 / dec ? 'well above' : 'below'} the ${pct(1 / dec)} needed.</b> ${ours > 1 / dec
          ? `That gap is probably not an edge:
          past games don't know about injuries, matchups or role changes that the sportsbook prices in, so the real chance is likely lower.`
          : `Even by past games this payout isn't worth it, and those games don't know about injuries, matchups or role changes, so the real chance is likely lower still.`}</p>
        <ol class="p-legs">${rows}</ol>
      </article>`;
  }

  // Sets of picks: each refresh builds new parlays from the next-best props. Tier 1 skips every player
  // shown in earlier sets; if that can't fill the largest parlay, tier 2 lets a shown player back in on a
  // prop type not yet shown for him. A prop is never repeated until neither tier can fill it, then it starts over.
  let setNumber = 0;
  const shownPlayers = new Set();
  const shownProps = new Set();   // athleteId|type keys
  let lastProps = new Set();      // the previous set's props, avoided again right after a restart

  // The biggest parlay these legs can fill at all (a tiny pool may not reach MAX_SIZE even on a fresh start).
  const targetOf = (legs, cap) => Math.min(MAX_SIZE, pickLegs(legs, MAX_SIZE, new Set(), cap).length);

  const nextSet = (legs, cap, players, props, target = MAX_SIZE) => {
    const t1 = pickLegs(legs, MAX_SIZE, players, cap);
    if (t1.length >= target) return { skip: new Set(players), skipProps: new Set() };
    const t2 = pickLegs(legs, MAX_SIZE, new Set(), cap, props);
    return t2.length >= target ? { skip: new Set(), skipProps: new Set(props) } : null;
  };

  // How many full sets the eligible legs can give before anything repeats (stops counting at 6).
  function countSets(legs, cap) {
    const players = new Set();
    const props = new Set();
    const target = targetOf(legs, cap);
    let n = 0;
    for (let sel; target && n < 6 && (sel = nextSet(legs, cap, players, props, target)); n++) {
      pickLegs(legs, MAX_SIZE, sel.skip, cap, sel.skipProps).forEach((l) => { players.add(l.athleteId); props.add(propKey(l)); });
    }
    return n;
  }

  // ---------- Game picker: which games the parlays draw from ----------

  let pickable = [];          // this week's upcoming games, soonest first
  let selected = new Set();   // ids of the checked games
  let selectionKey = '';

  const keyOf = () => [...selected].sort().join(',');

  function resetSets() {
    setNumber = 0;
    shownPlayers.clear();
    shownProps.clear();
    lastProps = new Set();
  }

  function saveSelection() {
    try { localStorage.setItem(GAMES_KEY, JSON.stringify({ selected: [...selected], seen: pickable.map((g) => g.id) })); } catch { /* fine */ }
  }

  function updateCount() {
    $('pp-games-count').textContent = `${selected.size} of ${pickable.length} games`;
  }

  function changed() {
    saveSelection();
    selectionKey = keyOf();
    resetSets();
    updateCount();
  }

  // Reads the week's games (cached by Football), then keeps the saved choice: games not seen before
  // start checked, and games no longer in the week's list are dropped. A changed choice starts over at Set 1.
  async function refreshPicker() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(GAMES_KEY)) || {}; } catch { stored = {}; }
    const picked = new Set(Array.isArray(stored.selected) ? stored.selected : []);
    const seen = new Set(Array.isArray(stored.seen) ? stored.seen : []);
    const week = await Football.thisWeek();
    pickable = week.games.filter((g) => g.state === 'pre').sort((a, b) => a.kickoff - b.kickoff);
    selected = new Set(pickable.filter((g) => !seen.has(g.id) || picked.has(g.id)).map((g) => g.id));
    saveSelection();
    if (selectionKey && keyOf() !== selectionKey) resetSets();
    selectionKey = keyOf();
    renderPicker();
  }

  function renderPicker() {
    const box = $('pp-games');
    box.textContent = '';
    const head = document.createElement('div');
    head.className = 'pp-games-head';
    const title = document.createElement('b');
    title.textContent = 'Games to use';
    const count = document.createElement('span');
    count.id = 'pp-games-count';
    count.className = 'muted small';
    head.append(title, count);
    for (const [text, all] of [['All', true], ['None', false]]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'small';
      b.textContent = text;
      b.addEventListener('click', () => {
        selected = new Set(all ? pickable.map((g) => g.id) : []);
        box.querySelectorAll('input').forEach((i) => { i.checked = all; });
        changed();
      });
      head.append(b);
    }
    const grid = document.createElement('div');
    grid.className = 'pp-games-grid';
    for (const g of pickable) {
      const label = document.createElement('label');
      label.className = 'pp-game';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = selected.has(g.id);
      input.addEventListener('change', () => {
        if (input.checked) selected.add(g.id); else selected.delete(g.id);
        changed();
      });
      const name = document.createElement('b');
      name.textContent = g.shortName || 'Game';
      const when = document.createElement('span');
      when.className = 'muted small';
      when.textContent = `${g.kickoff.toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: '2-digit' })} CT`;
      label.append(input, name, when);
      grid.append(label);
    }
    box.append(head, grid);
    updateCount();
  }

  let building = false;
  async function build() {
    if (building) return;
    building = true;
    $('pp-build').disabled = true;
    try {
      await refreshPicker();
      if (!selected.size) {
        $('pp-status').textContent = 'Pick at least one game.';
        return;
      }
      const refresh = setNumber > 0;
      $('pp-list').innerHTML = '';
      const result = await buildLegs((done, total) => {
        $('pp-status').textContent = total ? `Checking player histories: ${done} of ${total}…` : 'Loading this week’s props…';
      }, refresh);
      const cap = gameCap(result.games);
      let startedOver = false;
      const target = targetOf(result.legs, cap);
      let sel = nextSet(result.legs, cap, shownPlayers, shownProps, target);
      if (!sel) {
        startedOver = setNumber > 0;
        shownPlayers.clear();
        shownProps.clear();
        setNumber = 0;
        sel = nextSet(result.legs, cap, new Set(), lastProps, target) || { skip: new Set(), skipProps: new Set() };   // avoid repeating the last set right away if possible
      }
      setNumber++;
      const skipped = sel.skip.size;
      $('pp-list').innerHTML = SIZES.map((n) => card(n, result.legs, sel.skip, cap, sel.skipProps)).join('');
      lastProps = new Set();
      pickLegs(result.legs, MAX_SIZE, sel.skip, cap, sel.skipProps).forEach((l) => {   // smaller parlays are the first legs of this one
        shownPlayers.add(l.athleteId);
        shownProps.add(propKey(l));
        lastProps.add(propKey(l));
      });
      const est = countSets(result.legs, cap);

      const updated = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const limit = est < 6 ? ` of about ${Math.max(est, 1)}: only ${result.legs.length} eligible props in the selected games, so picks repeat after that` : '';
      const which = startedOver ? `Set 1 again${limit} (not enough unused props were left to fill a full parlay, so this starts over from the top picks)`
        : setNumber === 1 ? `Set 1${limit}${limit ? '' : ': the top picks'}`
        : `Set ${setNumber}${limit}${limit ? '' : ': new picks'}, ${skipped ? `skipping the ${skipped} players shown in earlier sets` : 'no prop repeated from earlier sets (some players return on a different prop)'}`;
      $('pp-status').textContent = `${which} · ${result.props} props from ${result.games} selected games · ${result.legs.length} with enough history · ${refresh ? 'lines refreshed' : 'updated'} ${updated}`;
      $('pp-build').textContent = '↻ New prop parlays';
      $('pp-build').title = 'Re-downloads the prop lines and injury reports, then builds a new set with different props than every earlier set (new players first, then known players on a new prop type). It starts over only when too few unused props remain.';
    } catch (err) {
      $('pp-status').textContent = `Couldn’t build prop parlays (${err.message}).`;
    } finally {
      building = false;
      $('pp-build').disabled = false;
    }
  }

  $('pp-build').addEventListener('click', build);

  // Fill the picker when the Parlays tab opens (and on load, in case it is already showing).
  const showPicker = () => refreshPicker().catch((e) => { console.error('PICKER', e.message); $('pp-games').textContent = 'Couldn’t load this week’s games.'; });
  document.addEventListener('tabchange', (e) => { if (e.detail === 'parlays') showPicker(); });
  if (!$('parlays-view').hidden) showPicker();
})();
