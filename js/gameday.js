// "Game day weather" section: upcoming NFL games for followed teams (or the whole week), each with the
// forecast for its game window, roof-aware impact, and a radar of the stadium's area.
(() => {
  const PREFS_KEY = 'almanac-gameday.prefs.v2';   // v2: new defaults (This week, no teams)
  const DEFAULT_PREFS = { mode: 'week', teams: [] };
  const UPCOMING_PER_TEAM = 4;
  const REFRESH_MS = 30 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const IMPACT_ICON = ['○', '✓', '▲', '⚠'];   // ○ none, ✓ low, ▲ moderate, ⚠ high

  let prefs = loadPrefs();
  let radars = [];                  // live radar instances for the current cards
  let observer = null;
  let loadToken = 0;

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY));
      if (p && Array.isArray(p.teams) && (p.mode === 'mine' || p.mode === 'week')) return p;
    } catch { /* fall through */ }
    return { ...DEFAULT_PREFS };
  }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* fine */ }
  }

  // ---------- Which games ----------

  // Live and upcoming games only: once a game is final it moves to the Past Games tab.
  async function gamesToShow() {
    if (prefs.mode === 'week') {
      const w = await Football.thisWeek();
      const games = w.games.filter((g) => g.state !== 'post');
      return { title: w.label, games, finals: w.games.length - games.length };
    }
    if (!prefs.teams.length) return { title: 'No teams picked', games: [] };
    const failed = [];
    let lastError = null;
    const lists = await Promise.all(prefs.teams.map((t) => Football.teamSchedule(t).catch((err) => {
      failed.push(t);
      lastError = err;
      return [];
    })));
    if (failed.length === prefs.teams.length) throw lastError;
    const byId = new Map();
    for (const list of lists) {
      const upcoming = list.filter((g) => g.state !== 'post').sort((a, b) => a.kickoff - b.kickoff).slice(0, UPCOMING_PER_TEAM);
      for (const g of upcoming) byId.set(g.id, g);
    }
    const note = failed.length ? ` (couldn’t load ${failed.join(', ')})` : '';
    return { title: `Upcoming games${note}`, games: [...byId.values()] };
  }

  // ---------- Rendering ----------

  function when(g) {
    const d = g.kickoff;
    const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
    const rel = g.state === 'in' || g.state === 'post' ? ''
      : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days > 1 ? `in ${days} days` : '';
    return { text: `${date} · ${time}`, rel, days };
  }

  function team(t) {
    if (!t) return '<span class="gd-team">TBD</span>';
    const logo = t.logo ? `<img src="${esc(t.logo)}" alt="" width="28" height="28" loading="lazy">` : '';
    const score = t.score != null ? `<b class="gd-score">${esc(t.score)}</b>` : '';
    return `<span class="gd-team">${logo}<span class="gd-abbr">${esc(t.abbr || '')}</span>${score}</span>`;
  }

  function cardShell(g, i) {
    const w = when(g);
    const statusTag = g.state === 'in' ? `<span class="gd-live">● ${esc(g.detail || 'Live')}</span>`
      : g.state === 'post' ? `<span class="gd-final">${esc(g.detail || 'Final')}</span>` : '';
    const place = [g.venue.city, g.venue.state || g.venue.country].filter(Boolean).join(', ');
    return `
      <article class="game roof-${g.roof}${g.state === 'post' ? ' past' : ''}" data-i="${i}" data-id="${esc(g.id)}">
        <header class="gd-head">
          <div class="gd-matchup">${typeof Tracker !== 'undefined' ? Tracker.button(g) : ''}${team(g.away)}<span class="gd-at">@</span>${team(g.home)}</div>
          ${g.state === 'in' ? '<button type="button" class="gd-collapse" data-collapse aria-expanded="true" aria-label="Collapse this game" title="Collapse to just the score">▾</button>' : ''}
          <div class="gd-when"><span class="gd-date">${esc(w.text)}</span><span class="gd-rel">${esc(w.rel)}</span>${statusTag}</div>
        </header>
        <div class="gd-venue">
          <span>${esc(g.venue.name)}${place ? ` · ${esc(place)}` : ''}${g.neutral ? ' · neutral site' : ''}</span>
          <span class="roof-badge roof-${g.roof}">${esc(Football.ROOF_LABEL[g.roof])}</span>
        </div>
        <div class="gd-slot" data-slot="now"><p class="gd-wait">${g.state === 'post' ? 'Loading weather…' : 'Loading forecast…'}</p></div>
        <div class="gd-slot" data-slot="hours"></div>
        <div class="gd-slot" data-slot="impact"></div>
        <div class="gd-slot" data-slot="conf"></div>
        <div class="gd-slot gd-odds" data-slot="probs"><p class="gd-wait">Loading odds…</p></div>
        <div class="gd-slot" data-slot="lines"></div>
        <div class="gd-slot" data-slot="result"></div>
        ${g.state === 'post' ? '<div class="gd-slot" data-slot="verdict"></div>' : '<div class="gd-slot gd-radar-wrap" data-slot="radar"></div>'}
      </article>`;
  }

  // Each card is the same stack of rows (CARD_ROWS in the CSS), and cards side by side share row
  // heights, so every section lines up across columns. Filling a slot never adds or removes rows.
  function fill(card, parts) {
    for (const [name, html] of Object.entries(parts)) card.querySelector(`[data-slot="${name}"]`).innerHTML = html || '';
  }

  function hourCell(h) {
    const t = h.at.toLocaleTimeString([], { hour: 'numeric' });
    return `<div class="gd-hour"><span>${esc(t)}</span><b>${Math.round(h.temp)}°</b>
      <span>${h.pop == null ? '' : `${Math.round(h.pop)}% · `}${Math.round(h.wind)} mph</span></div>`;
  }

  function weatherBlock(g, w) {
    const imp = Football.impact(w, g.roof, g.state === 'post');
    const temps = Math.round(w.tempStart) === Math.round(w.tempEnd)
      ? `${Math.round(w.tempStart)}°` : `${Math.round(w.tempStart)}° → ${Math.round(w.tempEnd)}°`;
    const past = g.state === 'post';
    const indoors = g.roof === 'dome' || g.roof === 'canopy';
    const days = Math.max(0, (g.kickoff - Date.now()) / 86400000);
    const conf = past || g.state === 'in' ? null : Football.confidence(days);
    return {
      now: `
        <div class="gd-now">
          <div class="gd-big"><strong>${temps}</strong><span>${esc(w.condition)}${indoors ? ' <em>(outside)</em>' : ''}</span></div>
          <dl class="gd-facts">
            <div><dt>Feels like</dt><dd>${Math.round(w.feelsMin)}°${Math.round(w.feelsMax) !== Math.round(w.feelsMin) ? `–${Math.round(w.feelsMax)}°` : ''}</dd></div>
            <div><dt>${past ? 'Precip' : 'Rain chance'}</dt><dd>${past ? `${w.precip.toFixed(2)}″` : `${Math.round(w.popMax)}%`}</dd></div>
            <div><dt>Wind</dt><dd>${esc(w.windDir)} ${Math.round(w.windMax)} mph</dd></div>
            <div><dt>Gusts</dt><dd>${Math.round(w.gustMax)} mph</dd></div>
          </dl>
        </div>`,
      hours: `<div class="gd-hours">${w.hours.map(hourCell).join('')}</div>`,
      impact: `
        <div class="gd-impact impact-${imp.level}">
          <span class="gd-impact-label">${IMPACT_ICON[imp.level]} ${past ? 'Weather impact was' : 'Weather impact'}: <b>${imp.label}</b>${g.roof === 'retractable' ? ' <span class="muted">(if the roof is open)</span>' : ''}</span>
          <span class="gd-reasons">${imp.reasons.map(esc).join(' · ')}</span>
        </div>`,
      conf: [
        conf ? `<p class="gd-conf">Forecast confidence: <b>${conf.label}</b> — ${esc(conf.note)}</p>` : '',
        g.roof === 'retractable' ? '<p class="gd-conf">Retractable roof: the team usually decides on game day, and tends to close it for rain, cold or heat.</p>' : '',
      ].join(''),
    };
  }

  // ---------- Odds & projection ----------

  const MINUS = '−';
  const signed = (v) => (v > 0 ? `+${v}` : v < 0 ? `${MINUS}${Math.abs(v)}` : '0');
  const american = (s) => (s ? String(s).replace('-', MINUS) : '—');
  const money = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}K` : `$${Math.round(v)}`);

  // `dim`: shown faded (e.g. a market with almost no money in it).
  function probRow(g, label, away, home, note, dim = false) {
    const a = Math.round((away / (away + home)) * 100);
    const h = 100 - a;   // so the two always add to 100
    return `
      <div class="gd-prob-row${dim ? ' dim' : ''}">
        <span class="gd-prob-label">${label}</span>
        <div class="gd-prob-bar" role="img" aria-label="${esc(label)}: ${esc(g.away.abbr)} ${a}%, ${esc(g.home.abbr)} ${h}%">
          <span class="away" style="width:${a}%"></span><span class="home" style="width:${h}%"></span>
        </div>
        <span class="gd-prob-vals">${esc(g.away.abbr)} <b>${a}%</b> · ${esc(g.home.abbr)} <b>${h}%</b></span>
        ${note ? `<span class="gd-prob-note">${note}</span>` : '<span></span>'}
      </div>`;
  }

  // Same shape as probRow, for a source with nothing to show yet, so every card has the same three rows.
  function emptyRow(label, text) {
    return `
      <div class="gd-prob-row empty">
        <span class="gd-prob-label">${label}</span>
        <div class="gd-prob-bar"></div>
        <span class="gd-prob-vals">${text}</span>
        <span></span>
      </div>`;
  }

  function spreadText(g, l) {
    if (l.homeLine == null) return null;
    if (l.homeLine === 0) return 'Pick’em';
    const homeFav = l.homeLine < 0;
    const team = homeFav ? g.home.abbr : g.away.abbr;
    const line = homeFav ? l.homeLine : -l.homeLine;
    const open = l.homeOpen == null ? null : homeFav ? l.homeOpen : -l.homeOpen;
    const odds = homeFav ? l.homeSpreadOdds : l.awaySpreadOdds;
    return `${esc(team)} ${signed(line)}${odds ? ` (${american(odds)})` : ''}${open != null && open !== line ? ` <span class="muted">opened ${signed(open)}</span>` : ''}`;
  }

  function oddsBlock(g, o, m) {
    const past = g.state === 'post';
    const started = g.state !== 'pre';
    const rows = [];

    // ESPN projection (pre-game once the game has started)
    if (o && o.win) rows.push(probRow(g, 'ESPN projection', o.win.away, o.win.home, o.win.pregame ? 'pre-game' : ''));
    else rows.push(emptyRow('ESPN projection', 'Not posted yet'));

    // Polymarket (last price before kickoff once the game has started)
    if (m) {
      const note = [
        m.pregame ? 'last price before kickoff' : '',
        m.thin && !m.pregame ? '<span class="gd-thin">thin market</span>' : '',
        `${money(m.volume)} traded`,
        `<a href="${esc(m.url)}" target="_blank" rel="noopener">view ↗</a>`,
      ].filter(Boolean).join(' · ');
      rows.push(probRow(g, 'Polymarket', m.away, m.home, note, m.thin && !m.pregame));
    } else {
      rows.push(emptyRow('Polymarket', started ? 'No pre-game price' : 'No market yet'));
    }

    // Sportsbook moneyline (the closing line once the game has started)
    const l = o && o.lines;
    const implied = l && Football.impliedFromMoneylines(l.mlHome, l.mlAway);
    if (implied) rows.push(probRow(g, esc(l.provider), implied.away, implied.home, `${started ? 'closing moneyline' : 'from moneyline'}, margin removed`));
    else rows.push(emptyRow('Sportsbook', 'Lines not posted yet'));

    const facts = [];
    if (l) {
      const spread = spreadText(g, l);
      if (spread) facts.push(`<div><dt>Spread</dt><dd>${spread}</dd></div>`);
      if (l.total != null) {
        facts.push(`<div><dt>Total</dt><dd>${l.total}${l.overOdds ? ` (o ${american(l.overOdds)} / u ${american(l.underOdds)})` : ''}${l.totalOpen != null && l.totalOpen !== l.total ? ` <span class="muted">opened ${l.totalOpen}</span>` : ''}</dd></div>`);
      }
      if (l.mlHome || l.mlAway) facts.push(`<div><dt>Moneyline</dt><dd>${esc(g.away.abbr)} ${american(l.mlAway)} · ${esc(g.home.abbr)} ${american(l.mlHome)}</dd></div>`);
    }
    if (m && !m.pregame && m.total) {
      facts.push(`<div><dt>Market total</dt><dd>${Math.round(m.total.over)}% chance of over ${m.total.line}</dd></div>`);
    }

    let result = '';
    if (past && l) {
      const r = Football.bettingResult(g, l);
      if (r) {
        const parts = [];
        if (r.ats) parts.push(r.ats.push ? 'Spread: push' : `<b>${esc(r.ats.team)}</b> covered ${signed(r.ats.line)}`);
        if (r.ou) parts.push(`<b>${r.ou.result}</b> ${r.ou.total} (${r.ou.points} points)`);
        result = `<p class="gd-result">Result vs. the line: ${parts.join(' · ')}</p>`;
      }
    }

    return {
      probs: `
        <h3 class="gd-odds-title">${started ? 'Pre-game odds & projection' : 'Odds & projection'}</h3>
        <div class="gd-probs">${rows.join('')}</div>`,
      lines: facts.length ? `<dl class="gd-lines">${facts.join('')}</dl>` : '',
      result,
    };
  }

  async function fillOdds(card, g) {
    const [o, m] = await Promise.all([
      Football.odds(g).catch(() => null),
      Football.market(g).catch(() => null),
    ]);
    fill(card, oddsBlock(g, o, m));
  }

  function mountRadar(g, wrap, loc) {
    const holder = document.createElement('div');
    holder.className = 'gd-radar';
    wrap.appendChild(holder);
    const r = Radar.create();
    r.mount(holder, { zoom: 6, fixed: true });
    r.setLocation(loc);
    radars.push(r);
    return r;
  }

  async function fillCard(card, g) {
    const wrap = card.querySelector('.gd-radar-wrap');
    let loc;
    try {
      loc = await Football.locate(g.venue);
    } catch { loc = null; }
    if (!loc) { fill(card, { now: '<p class="gd-wait">Couldn’t find this stadium’s location.</p>' }); return; }

    let w = null;
    try {
      const h = await Football.hourly(loc);
      w = Football.gameWindow(h, g.kickoff);
      if (w) {
        fill(card, weatherBlock(g, w));
      } else {
        const opens = new Date(g.kickoff.getTime() - (Football.FORECAST_DAYS - 1) * 86400000);
        fill(card, { now: `<p class="gd-wait">Too far out for a forecast. It appears around
          <b>${opens.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</b>, ${Football.FORECAST_DAYS} days before kickoff.</p>` });
      }
    } catch (err) {
      fill(card, { now: `<p class="gd-wait">Forecast unavailable (${esc(err.message)}).</p>` });
    }

    // Radar for every outdoor or retractable-roof game: live conditions around the stadium right now
    // (radar only covers the last two hours, so the caption says what it shows). Under a fixed roof
    // the weather doesn't reach the field, so dome and covered games get none.
    if (g.roof === 'dome' || g.roof === 'canopy') return;
    // When the game-window weather risk is Low, the radar starts folded away (and isn't loaded until
    // opened). Moderate or High risk, or no forecast yet, shows it straight away.
    const low = w && Football.impact(w, g.roof, g.state === 'post').level <= 1;
    const showRadar = (into) => {
      into.insertAdjacentHTML('beforeend', `<p class="gd-radar-cap">${esc(radarCaption(g))}</p>`);
      card._radar = mountRadar(g, into, loc);
      observer.observe(card);   // pauses the loop while the card is off-screen
    };
    if (!low) { wrap.innerHTML = ''; showRadar(wrap); return; }
    wrap.innerHTML = `
      <details class="p-flags gd-radar-fold">
        <summary>Show radar <span class="muted">· weather risk is low</span></summary>
        <div class="gd-radar-fold-body"></div>
      </details>`;
    const fold = wrap.querySelector('details');
    fold.addEventListener('toggle', () => {
      if (fold.open && !card._radar) showRadar(fold.querySelector('.gd-radar-fold-body'));
      else if (card._radar) card._radar.setActive(fold.open);
    });
  }

  function radarCaption(g) {
    const where = `around ${g.venue.name}`;
    if (g.state === 'in') return `Live radar ${where}, during the game`;
    if (g.state === 'post') return `Radar ${where} now — the game is over`;
    const hours = (g.kickoff - Date.now()) / 3600000;
    const until = hours < 1 ? 'kickoff within the hour' : hours < 24 ? `kickoff in ${Math.round(hours)} hours`
      : `kickoff in ${Math.round(hours / 24)} days`;
    return `Radar ${where} now · ${until}`;
  }

  // Every card gets its radar right away; the observer just pauses a radar's loop while its card is off-screen.
  function makeObserver() {
    return new IntersectionObserver((entries) => {
      for (const e of entries) {
        const card = e.target;
        if (card._radar) card._radar.setActive(e.isIntersecting && !card.querySelector('.gd-radar-fold:not([open])'));
      }
    }, { rootMargin: '300px 0px' });
  }

  function teardown() {
    radars.forEach((r) => r.destroy());
    radars = [];
    if (observer) observer.disconnect();
    observer = makeObserver();
  }

  async function render() {
    const token = ++loadToken;
    $('gd-mode').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === prefs.mode)));
    $('gd-teams').hidden = prefs.mode !== 'mine';
    $('gd-sub').textContent = 'Loading schedule…';
    let result;
    try {
      result = await gamesToShow();
    } catch (err) {
      if (token !== loadToken) return;
      $('gd-sub').textContent = `Couldn’t load the NFL schedule (${err.message}). It will retry in 30 minutes.`;
      return;
    }
    if (token !== loadToken) return;
    teardown();
    // Games under way first, then upcoming ones. Within each, weather matters least under a roof,
    // so dome and covered games go last; then by kickoff.
    const indoors = (g) => (g.roof === 'dome' || g.roof === 'canopy' ? 1 : 0);
    const live = (g) => (g.state === 'in' ? 0 : 1);
    const games = result.games.sort((a, b) => live(a) - live(b) || indoors(a) - indoors(b) || a.kickoff - b.kickoff);
    const following = prefs.mode === 'mine' && prefs.teams.length ? ` · following ${prefs.teams.join(', ')}` : '';
    const updated = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const finals = result.finals ? ` · ${result.finals} final (in Past Games)` : '';
    $('gd-sub').textContent = `${result.title}${following} · ${games.length} live or upcoming game${games.length === 1 ? '' : 's'}${finals} · updated ${updated}`;
    shown = games;
    if (!games.length) {
      const note = prefs.mode === 'mine' && !prefs.teams.length
        ? 'No teams yet. Click <b>Teams…</b> and search for the teams you want to follow.'
        : result.finals ? 'All of this week’s games are final. See <b>Past Games</b> for results; next week’s games appear once ESPN posts them.'
          : 'No upcoming games.';
      $('gd-list').innerHTML = `<p class="empty-note">${note}</p>`;
      $('gd-strip').innerHTML = '';
      $('gd-strip').hidden = true;
      return;
    }
    $('gd-list').innerHTML = games.map(cardShell).join('');
    $('gd-strip').innerHTML = '';
    $('gd-list').querySelectorAll('.game').forEach((card) => {
      const g = games[Number(card.dataset.i)];
      fillCard(card, g);
      fillOdds(card, g);
    });
    // Forget collapsed games that are no longer live; re-collapse the rest.
    const liveIds = new Set(games.filter((g) => g.state === 'in').map((g) => String(g.id)));
    collapsed = new Set([...collapsed].filter((id) => liveIds.has(id)));
    saveCollapsed();
    collapsed.forEach((id) => setCollapsed(id, true));
    updateStrip();
  }

  // ---------- Collapsing live games ----------

  // ▾ on a live game's card shrinks it to a compact chip (teams, score, clock and quarter) in a strip
  // above the grid; ▸ on the chip puts the full card back in its place. The card itself is moved, so
  // its forecast, odds and radar stay loaded. Remembered until the game ends.
  const COLLAPSE_KEY = 'almanac-gameday.collapsed';
  let collapsed = new Set();
  try { collapsed = new Set((JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || []).map(String)); } catch { collapsed = new Set(); }
  function saveCollapsed() {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])); } catch { /* fine */ }
  }

  function setCollapsed(id, on) {
    const card = document.querySelector(`#gameday .game[data-id="${CSS.escape(String(id))}"]`);
    if (!card) return;
    card.classList.toggle('collapsed', on);
    const btn = card.querySelector('[data-collapse]');
    if (btn) {
      btn.textContent = on ? '▸' : '▾';
      btn.setAttribute('aria-expanded', String(!on));
      btn.setAttribute('aria-label', on ? 'Expand this game' : 'Collapse this game');
      btn.title = on ? 'Show the full card' : 'Collapse to just the score';
    }
    if (card._radar) card._radar.setActive(!on);
    if (on) {
      $('gd-strip').appendChild(card);
    } else {
      // Back into the grid at its original position.
      const i = Number(card.dataset.i);
      const next = [...$('gd-list').children].find((c) => Number(c.dataset.i) > i);
      $('gd-list').insertBefore(card, next || null);
    }
  }

  function updateStrip() {
    $('gd-strip').hidden = !$('gd-strip').children.length;
  }

  $('gameday').addEventListener('click', (e) => {
    const b = e.target.closest('[data-collapse]');
    if (!b) return;
    const id = b.closest('.game').dataset.id;
    const on = !collapsed.has(id);
    if (on) collapsed.add(id); else collapsed.delete(id);
    saveCollapsed();
    setCollapsed(id, on);
    updateStrip();
  });

  // Scores, clock and quarter in place (no redraw), from a fresh scoreboard.
  function updateScores(week) {
    const byId = new Map(week.games.map((g) => [String(g.id), g]));
    document.querySelectorAll('#gameday .game[data-id]').forEach((card) => {
      const g = byId.get(card.dataset.id);
      if (!g || g.state !== 'in') return;
      const scores = card.querySelectorAll('.gd-score');
      if (scores[0] && g.away.score != null) scores[0].textContent = g.away.score;
      if (scores[1] && g.home.score != null) scores[1].textContent = g.home.score;
      const live = card.querySelector('.gd-live');
      if (live) live.textContent = `● ${g.detail || 'Live'}`;
    });
  }

  // ---------- Moving finished games to Past Games ----------

  // While a shown game is under way (or past its kickoff time), check ESPN's scoreboard every minute.
  // Scores, clock and quarter update in place. When a game kicks off, redraw so it joins the live
  // games at the top; when one goes final, redraw so it leaves this tab, and reload Past Games.
  const LIVE_CHECK_MS = 60 * 1000;
  let shown = [];

  setInterval(async () => {
    if (document.hidden || !shown.some((g) => g.state === 'in' || g.kickoff <= Date.now())) return;
    let week;
    try { week = await Football.thisWeek(); } catch { return; }
    updateScores(week);
    const state = new Map(week.games.map((g) => [g.id, g.state]));
    const changed = shown.filter((g) => state.has(g.id) && state.get(g.id) !== g.state);
    if (!changed.length) return;
    // A kickoff moves the game up with the live ones; a final moves it to Past Games.
    if (changed.some((g) => state.get(g.id) === 'post')) {
      Football.clearSeason();
      pastAt = 0;
      if (!$('past-view').hidden) renderPast();
    }
    render();
  }, LIVE_CHECK_MS);

  // ---------- Past games tab ----------

  // Every game played this season, grouped by week (newest first), with the same card as the Games
  // tab: the weather recorded during the game window, pre-game odds and the result vs. the line.
  // No radar, since it only shows the last two hours. Cards fill in as they scroll near the screen,
  // so opening the tab doesn't fire a request for every game of the season at once.
  let past = null;                  // { year, weeks, start }
  let pastAt = 0;
  let pastGames = [];
  let pastObserver = null;
  let pastToken = 0;

  async function renderPast() {
    const token = ++pastToken;
    if (!past) $('past-sub').textContent = 'Loading the season so far…';
    let season;
    try {
      season = await Football.seasonSoFar();
    } catch (err) {
      if (token === pastToken) $('past-sub').textContent = `Couldn’t load past games (${err.message}).`;
      return;
    }
    if (token !== pastToken) return;
    past = season;
    pastAt = Date.now();
    drawPast();
  }

  function drawPast() {
    const pick = $('past-team').value;
    const indoors = (g) => (g.roof === 'dome' || g.roof === 'canopy' ? 1 : 0);
    const weeks = past.weeks
      .map((w) => ({ ...w, games: w.games.filter((g) => !pick || (g.home && g.home.abbr === pick) || (g.away && g.away.abbr === pick)) }))
      .filter((w) => w.games.length)
      .reverse();
    const total = weeks.reduce((n, w) => n + w.games.length, 0);
    $('past-sub').textContent = `${past.year || ''} season · ${total} game${total === 1 ? '' : 's'} played${pick ? ` by ${pick}` : ''} · updated ${new Date(pastAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    if (pastObserver) pastObserver.disconnect();
    pastGames = [];
    if (!weeks.length) {
      $('past-list').innerHTML = `<p class="empty-note">${past.weeks.length ? 'No games played yet by this team.' : 'No regular-season games have been played yet.'}</p>`;
      return;
    }
    const day = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    $('past-list').innerHTML = weeks.map((w, n) => {
      const games = [...w.games].sort((a, b) => indoors(a) - indoors(b) || a.kickoff - b.kickoff);
      const first = new Date(Math.min(...games.map((g) => g.kickoff)));
      const last = new Date(Math.max(...games.map((g) => g.kickoff)));
      const span = day(first) === day(last) ? day(first) : `${day(first)} – ${day(last)}`;
      const cards = games.map((g) => cardShell(g, pastGames.push(g) - 1)).join('');
      return `
        <div class="p-group-head${n === 0 ? ' first' : ''}"><h3>${esc(w.label)}</h3><span class="muted small">${games.length} game${games.length === 1 ? '' : 's'} · ${esc(span)}</span></div>
        <div class="gd-list">${cards}</div>`;
    }).join('');
    pastObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        pastObserver.unobserve(e.target);
        fillPastCard(e.target, pastGames[Number(e.target.dataset.i)]);
      }
    }, { rootMargin: '600px 0px' });
    $('past-list').querySelectorAll('.game').forEach((card) => pastObserver.observe(card));
  }

  async function fillPastCard(card, g) {
    const oddsJob = Promise.all([Football.odds(g).catch(() => null), Football.market(g).catch(() => null)]);
    const weatherJob = (async () => {
      let loc = null;
      try { loc = await Football.locate(g.venue); } catch { loc = null; }
      if (!loc) { fill(card, { now: '<p class="gd-wait">Couldn’t find this stadium’s location.</p>' }); return null; }
      try {
        const h = await Football.pastHourly(loc, past.start);
        const w = Football.gameWindow(h, g.kickoff);
        fill(card, w ? weatherBlock(g, w) : { now: '<p class="gd-wait">No weather recorded for this game yet.</p>' });
        return w;
      } catch (err) {
        fill(card, { now: `<p class="gd-wait">Weather unavailable (${esc(err.message)}).</p>` });
        return null;
      }
    })();
    const [o, m] = await oddsJob;
    fill(card, oddsBlock(g, o, m));
    const w = await weatherJob;
    const v = verdict(g, o, m, w);
    if (!v) return;
    fill(card, { verdict: v.html });
    card.querySelector('.gd-when').insertAdjacentHTML('beforeend', `<span class="pv-chip ${v.tone}">${esc(v.chip)}</span>`);
  }

  // ---------- Were the predictions right? ----------

  const pct = (v) => `${Math.round(v)}%`;

  // Each source's pick (the team it gave the better chance) against the winner, plus whether the
  // spread favorite covered. When something missed, a dropdown lists what in the game data could
  // explain it: how likely an upset was to begin with, turnovers, yardage, penalties, a blown lead,
  // weather, line movement and disagreement between sources. These are clues, not proof.
  function verdict(g, o, m, w) {
    const hs = Number(g.home && g.home.score);
    const as = Number(g.away && g.away.score);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;
    const winner = hs > as ? 'home' : as > hs ? 'away' : null;   // null: a tie
    const team = (side) => g[side].abbr;
    const other = (side) => (side === 'home' ? 'away' : 'home');

    const l = o && o.lines;
    const implied = l && Football.impliedFromMoneylines(l.mlHome, l.mlAway);
    const sources = [
      o && o.win ? { name: 'ESPN', home: o.win.home, away: o.win.away } : null,
      m ? { name: 'Polymarket', home: m.home, away: m.away } : null,
      implied ? { name: (l && l.provider) || 'Sportsbook', home: implied.home, away: implied.away } : null,
    ].filter(Boolean).map((s) => {
      const pick = s.home >= s.away ? 'home' : 'away';
      return { ...s, pick, chance: (s[pick] / (s.home + s.away)) * 100, right: pick === winner };
    });
    if (!sources.length) return null;

    // The favorite: what most sources picked (ties go to the sportsbook's favorite).
    const homeVotes = sources.filter((s) => s.pick === 'home').length;
    const fav = homeVotes * 2 > sources.length ? 'home' : homeVotes * 2 < sources.length ? 'away'
      : (l && l.homeLine != null ? (l.homeLine <= 0 ? 'home' : 'away') : sources[0].pick);
    const dog = other(fav);
    const favChance = sources.reduce((a, s) => a + (s[fav] / (s.home + s.away)) * 100, 0) / sources.length;

    // Spread: did the favorite (by the line) cover?
    let spread = null;
    if (l && l.homeLine != null && l.homeLine !== 0) {
      const lineFav = l.homeLine < 0 ? 'home' : 'away';
      const need = Math.abs(l.homeLine);
      const margin = lineFav === 'home' ? hs - as : as - hs;
      spread = { fav: lineFav, need, margin, right: margin > need, push: margin === need };
    }

    const right = sources.filter((s) => s.right).length;
    const margin = Math.abs(hs - as);
    let tone, chip, headline;
    if (!winner) {
      tone = 'bad'; chip = '✗ Tie'; headline = `A tie: none of the ${sources.length} sources’ picks won.`;
    } else if (right === sources.length) {
      tone = 'good'; chip = '✓ Picks right';
      headline = `${sources.length === 1 ? 'The pick' : `All ${sources.length} sources`} had ${team(winner)}, and ${team(winner)} won.`;
    } else if (right === 0) {
      tone = 'bad'; chip = '✗ Upset';
      headline = `${sources.length === 1 ? 'The pick was' : `All ${sources.length} sources picked`} ${team(fav)}, but ${team(winner)} won.`;
    } else {
      tone = 'mixed'; chip = `◐ ${right} of ${sources.length} right`;
      headline = `${right} of ${sources.length} sources picked the winner, ${team(winner)}.`;
    }

    const rows = sources.map((s) => `
      <li class="${s.right ? 'ok' : 'miss'}"><span class="pv-mark">${s.right ? '✓' : '✗'}</span>
        <span>${esc(s.name)} picked <b>${esc(team(s.pick))}</b> (${pct(s.chance)})</span></li>`);
    if (spread) {
      const mark = spread.push ? '–' : spread.right ? '✓' : '✗';
      const cls = spread.push ? 'push' : spread.right ? 'ok' : 'miss';
      const text = spread.push ? `${esc(team(spread.fav))} −${spread.need}: push`
        : `${esc(team(spread.fav))} −${spread.need} ${spread.right ? 'covered' : 'didn’t cover'} (${spread.margin > 0 ? `won by ${spread.margin}` : spread.margin < 0 ? `lost by ${-spread.margin}` : 'tied'})`;
      rows.push(`<li class="${cls}"><span class="pv-mark">${mark}</span><span>Spread: ${text}</span></li>`);
    }

    // Why it may have missed: only when a winner pick or the favorite's spread missed.
    const missed = right < sources.length || (spread && !spread.right && !spread.push);
    let why = '';
    if (missed) {
      const reasons = [];
      const upset = winner && winner !== fav;
      const s = o && o.stats;
      if (upset) {
        const inTen = Math.max(1, Math.round((100 - favChance) / 10));
        reasons.push(`<b>Upsets happen:</b> ${team(fav)} was a ${pct(favChance)} favorite, so ${team(dog)} wins a game like this about ${inTen} time${inTen === 1 ? '' : 's'} in 10.`);
      } else if (winner && right < sources.length) {
        const wrong = sources.filter((x) => !x.right);
        reasons.push(`<b>${wrong.map((x) => esc(x.name)).join(' and ')} missed:</b> ${wrong.map((x) => `${pct(x.chance)} on ${team(x.pick)}`).join(', ')}${wrong.every((x) => x.chance < 60) ? ', close to a coin flip' : ''}.`);
      }
      if (spread && !spread.right && !spread.push && winner === spread.fav) {
        reasons.push(`<b>Won, but not by enough:</b> ${team(spread.fav)} won by ${spread.margin}, short of the ${spread.need}-point spread.`);
      }
      if (winner && margin <= 3) reasons.push(`<b>One-score finish:</b> decided by ${margin} point${margin === 1 ? '' : 's'}, where a single play or kick swings the result.`);
      if (s) {
        const f = s[fav], d = s[dog];
        const toDiff = (f.turnovers ?? 0) - (d.turnovers ?? 0);
        if (toDiff >= 1) reasons.push(`<b>Turnovers:</b> ${team(fav)} gave the ball away ${f.turnovers} time${f.turnovers === 1 ? '' : 's'}, ${team(dog)} ${d.turnovers}. Turnover margin is one of the strongest predictors of who wins a given game, and it’s largely luck week to week.`);
        if (d.defTDs > 0) reasons.push(`<b>Defensive score:</b> ${team(dog)} scored ${d.defTDs} defensive touchdown${d.defTDs === 1 ? '' : 's'}.`);
        if (d.yards != null && f.yards != null) {
          const perPlay = d.perPlay != null && f.perPlay != null && d.perPlay > f.perPlay ? ` (${d.perPlay} vs ${f.perPlay} per play)` : '';
          if (upset && d.yards > f.yards) reasons.push(`<b>Outplayed:</b> ${team(dog)} out-gained ${team(fav)} ${d.yards}–${f.yards} yards${perPlay}, so this wasn’t a fluke.`);
          else if (upset && f.yards > d.yards + 50) reasons.push(`<b>Out-gained but lost:</b> ${team(fav)} had more yards (${f.yards}–${d.yards}) but didn’t turn them into points.`);
        }
        if (f.penaltyYards - d.penaltyYards >= 40) reasons.push(`<b>Penalties:</b> ${team(fav)} was flagged ${f.penalties} times for ${f.penaltyYards} yards, ${team(dog)} ${d.penalties} for ${d.penaltyYards}.`);
      }
      const wr = o && o.wpRange;
      if (wr && upset) {
        const favMax = fav === 'home' ? wr.homeMax : 100 - wr.homeMin;
        const late = fav === 'home' ? wr.maxLate : wr.minLate;
        if (favMax >= 80) reasons.push(`<b>Blown lead:</b> ${team(fav)}’s chance to win reached ${pct(favMax)}${late ? ' in the second half' : ''} before slipping away.`);
      }
      if (w && g.roof !== 'dome' && g.roof !== 'canopy') {
        const imp = Football.impact(w, g.roof, true);
        if (imp.level >= 2) reasons.push(`<b>Weather:</b> ${imp.reasons.map(esc).join(', ')}. Rough conditions tend to shrink the gap between teams (fewer big plays, more fumbles and missed kicks, tired players in heat).`);
      }
      if (l && l.homeOpen != null && l.homeLine != null) {
        const favSide = l.homeLine <= 0 ? 'home' : 'away';
        const open = favSide === 'home' ? -l.homeOpen : l.homeOpen;
        const close = Math.abs(l.homeLine);
        if (open - close >= 1.5) reasons.push(`<b>Line moved toward ${team(other(favSide))}:</b> ${team(favSide)} opened −${open} and closed −${close}, so late news or money was already leaning against the favorite.`);
      }
      const dissent = sources.filter((x) => x.pick !== fav);
      if (dissent.length) reasons.push(`<b>Sources disagreed:</b> ${dissent.map((x) => esc(x.name)).join(' and ')} had ${team(dog)}, a sign the game was closer than the favorite’s odds suggested.`);
      if (reasons.length === 1 && upset) reasons.push('Nothing in the box score stands out, so this looks like ordinary game-to-game variance.');
      why = `
        <details class="p-flags pv-why">
          <summary>Why the prediction may have missed</summary>
          <ul>${reasons.map((r) => `<li>${r}</li>`).join('')}</ul>
        </details>`;
    }

    return {
      tone, chip,
      html: `
        <div class="pv ${tone}">
          <p class="pv-head"><span class="pv-chip ${tone}">${esc(chip)}</span> ${esc(headline)}</p>
          <ul class="pv-rows">${rows.join('')}</ul>
          ${why}
        </div>`,
    };
  }

  Football.teams().then((all) => {
    $('past-team').insertAdjacentHTML('beforeend', all.map((t) => `<option value="${esc(t.abbr)}">${esc(t.name)}</option>`).join(''));
  });
  $('past-team').addEventListener('change', () => { if (past) drawPast(); });
  // Loads the first time the tab opens, and again if it has been a while.
  document.addEventListener('tabchange', (e) => {
    if (e.detail === 'past' && (!past || Date.now() - pastAt > REFRESH_MS)) renderPast();
  });

  // ---------- Team picker ----------

  async function openPicker() {
    const dlg = $('gd-dialog');
    const list = $('gd-team-list');
    list.innerHTML = '<p class="muted">Loading teams…</p>';
    $('gd-save').disabled = true;   // never save an empty selection just because the list isn't there yet
    $('gd-team-search').value = '';
    dlg.showModal();
    try {
      const all = await Football.teams();
      list.innerHTML = all.map((t) => `
        <label class="gd-pick" data-search="${esc(`${t.name} ${t.abbr}`.toLowerCase())}">
          <input type="checkbox" value="${esc(t.abbr)}" ${prefs.teams.includes(t.abbr) ? 'checked' : ''}>
          ${t.logo ? `<img src="${esc(t.logo)}" alt="" width="22" height="22" loading="lazy">` : ''}<span>${esc(t.name)}</span></label>`).join('')
        + '<p class="muted gd-no-match" hidden>No team matches that search.</p>';
      $('gd-save').disabled = false;
      updatePicked();
      $('gd-team-search').focus();
    } catch (err) {
      list.innerHTML = `<p class="muted">Couldn’t load teams (${esc(err.message)}).</p>`;
    }
  }

  // Filters by city, nickname or abbreviation ("vik", "min", "green bay").
  function filterTeams() {
    const q = $('gd-team-search').value.trim().toLowerCase();
    const picks = [...$('gd-team-list').querySelectorAll('.gd-pick')];
    let shown = 0;
    for (const p of picks) {
      const match = !q || p.dataset.search.includes(q);
      p.hidden = !match;
      if (match) shown++;
    }
    const none = $('gd-team-list').querySelector('.gd-no-match');
    if (none) none.hidden = shown > 0;
    return picks.filter((p) => !p.hidden);
  }

  function updatePicked() {
    const picked = [...$('gd-team-list').querySelectorAll('input:checked')].map((i) => i.value);
    $('gd-picked').textContent = picked.length ? `Following: ${picked.join(', ')}` : 'No teams picked yet';
  }

  $('gd-team-search').addEventListener('input', filterTeams);
  // Enter with exactly one match toggles that team, so you can type "vik", Enter, then the next team.
  $('gd-team-search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const visible = filterTeams();
    if (visible.length !== 1) return;
    const box = visible[0].querySelector('input');
    box.checked = !box.checked;
    updatePicked();
    $('gd-team-search').select();
  });
  $('gd-team-list').addEventListener('change', updatePicked);

  $('gd-teams').addEventListener('click', openPicker);
  $('gd-cancel').addEventListener('click', () => $('gd-dialog').close());
  $('gd-save').addEventListener('click', () => {
    if ($('gd-save').disabled) return;
    prefs.teams = [...$('gd-team-list').querySelectorAll('input:checked')].map((i) => i.value);
    savePrefs();
    $('gd-dialog').close();
    render();
  });
  $('gd-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b || b.dataset.mode === prefs.mode) return;
    prefs.mode = b.dataset.mode;
    savePrefs();
    render();
  });

  // ---------- Full refresh ----------

  // Skips the 30-minute reuse of forecasts, odds and prices and downloads everything fresh. No limit;
  // weather requests still go through the queue (a few at a time, retried after a 429). The button is
  // only disabled while a refresh is running, so a double-click doesn't start two.
  try { localStorage.removeItem('almanac-gameday.refreshes'); } catch { /* fine */ }   // from the old 3-per-30-minutes limit

  $('gd-refresh').addEventListener('click', async () => {
    const btn = $('gd-refresh');
    btn.disabled = true;
    btn.textContent = '↻ Refreshing…';
    try {
      await Football.clearCaches();
      await render();
    } finally {
      btn.disabled = false;
      btn.textContent = '↻ Refresh';
    }
  });

  // The desktop .exe (WebView2) serves files from inside itself, so it skips the offline cache;
  // a cache there would keep serving old files after a rebuild.
  const inDesktopShell = !!(window.chrome && window.chrome.webview);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !inDesktopShell) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* works without offline support */ });
  }

  // The banner's field is scaled to cover the header, so where its goal lines land depends on the window
  // size. Measure them and pad the header so the title and the menu each sit just inside their goal line.
  const INSET = 14;   // px between each goal line and the title or menu
  const banner = document.querySelector('.top.banner');
  const goalLeft = document.querySelector('.banner-field .goal-left');
  const goalRight = document.querySelector('.banner-field .goal-right');
  const yardNums = document.querySelectorAll('.banner-field .yard-nums text');
  const NUMBERS_ABOVE_BOTTOM = 10;   // px from the banner's bottom edge to the numbers' baseline
  const NUMBERS_PX = 24;             // yard-number font size on screen
  function alignBanner() {
    const b = banner.getBoundingClientRect();
    const left = goalLeft.getBoundingClientRect().right - b.left + INSET;
    const right = b.right - goalRight.getBoundingClientRect().left + INSET;
    banner.style.paddingLeft = `${Math.max(16, Math.round(left))}px`;
    banner.style.paddingRight = `${Math.max(16, Math.round(right))}px`;
    // Yard numbers: always just above the banner's bottom edge (below the menu), however the field
    // is scaled and cropped. The field fills the banner (slice), centered, so work back from pixels.
    const s = Math.max(b.width / 1200, b.height / 180);
    const cropTop = (180 * s - b.height) / 2;
    const y = ((b.height - NUMBERS_ABOVE_BOTTOM + cropTop) / s).toFixed(1);
    yardNums.forEach((t) => t.setAttribute('y', y));
    // …and the same on-screen size at every width, so wide windows don't grow them into the menu.
    if (yardNums[0]) yardNums[0].parentNode.setAttribute('font-size', (NUMBERS_PX / s).toFixed(1));
  }
  if (banner && goalLeft && goalRight) {
    alignBanner();
    if ('ResizeObserver' in window) new ResizeObserver(alignBanner).observe(banner);
    else addEventListener('resize', alignBanner);
  }

  observer = makeObserver();
  render();
  setInterval(() => { if (!document.hidden) render(); }, REFRESH_MS);
})();
