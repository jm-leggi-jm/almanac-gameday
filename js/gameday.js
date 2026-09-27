// "Game day weather" section: upcoming NFL games for followed teams (or the whole week), each with the
// forecast for its game window, roof-aware impact, and a radar of the stadium's area.
(() => {
  const PREFS_KEY = 'almanac-gameday.prefs.v2';   // v2: new defaults (This week, no teams)
  const DEFAULT_PREFS = { mode: 'week', teams: [] };
  const UPCOMING_PER_TEAM = 4;
  const RECENT_DAYS = 8;            // also show a followed team's last game if it was this recent
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

  async function gamesToShow() {
    if (prefs.mode === 'week') {
      const w = await Football.thisWeek();
      return { title: w.label, games: w.games };
    }
    if (!prefs.teams.length) return { title: 'No teams picked', games: [] };
    const now = Date.now();
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
      const recent = list.filter((g) => g.state === 'post' && now - g.kickoff < RECENT_DAYS * 86400000)
        .sort((a, b) => b.kickoff - a.kickoff).slice(0, 1);
      for (const g of [...recent, ...upcoming]) byId.set(g.id, g);
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
      <article class="game roof-${g.roof}" data-i="${i}">
        <header class="gd-head">
          <div class="gd-matchup">${team(g.away)}<span class="gd-at">@</span>${team(g.home)}</div>
          <div class="gd-when"><span>${esc(w.text)}</span><span class="gd-rel">${esc(w.rel)}</span>${statusTag}</div>
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
        <div class="gd-slot gd-radar-wrap" data-slot="radar"></div>
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

    try {
      const h = await Football.hourly(loc);
      const w = Football.gameWindow(h, g.kickoff);
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
    wrap.innerHTML = `<p class="gd-radar-cap">${esc(radarCaption(g))}</p>`;
    card._radar = mountRadar(g, wrap, loc);
    observer.observe(card);   // pauses the loop while the card is off-screen
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
        if (card._radar) card._radar.setActive(e.isIntersecting);
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
    // Weather matters least under a roof, so dome and covered games go last; each group by kickoff.
    const indoors = (g) => (g.roof === 'dome' || g.roof === 'canopy' ? 1 : 0);
    const games = result.games.sort((a, b) => indoors(a) - indoors(b) || a.kickoff - b.kickoff);
    const following = prefs.mode === 'mine' && prefs.teams.length ? ` · following ${prefs.teams.join(', ')}` : '';
    const updated = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('gd-sub').textContent = `${result.title}${following} · ${games.length} game${games.length === 1 ? '' : 's'} · updated ${updated}`;
    if (!games.length) {
      $('gd-list').innerHTML = `<p class="empty-note">${prefs.mode === 'mine' ? 'No teams yet. Click <b>Teams…</b> and search for the teams you want to follow.' : 'No games scheduled this week.'}</p>`;
      return;
    }
    $('gd-list').innerHTML = games.map(cardShell).join('');
    $('gd-list').querySelectorAll('.game').forEach((card) => {
      const g = games[Number(card.dataset.i)];
      fillCard(card, g);
      fillOdds(card, g);
    });
  }

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
    fillOdds(card, g);
    let loc = null;
    try { loc = await Football.locate(g.venue); } catch { loc = null; }
    if (!loc) { fill(card, { now: '<p class="gd-wait">Couldn’t find this stadium’s location.</p>' }); return; }
    try {
      const h = await Football.pastHourly(loc, past.start);
      const w = Football.gameWindow(h, g.kickoff);
      fill(card, w ? weatherBlock(g, w) : { now: '<p class="gd-wait">No weather recorded for this game yet.</p>' });
    } catch (err) {
      fill(card, { now: `<p class="gd-wait">Weather unavailable (${esc(err.message)}).</p>` });
    }
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

  // ---------- Full refresh (limited) ----------

  // Skips the 30-minute reuse of forecasts, odds and prices. Capped at 3 per rolling 30 minutes so a
  // burst of refreshes can't bring back the rate-limit (429) errors from the free weather API.
  const REFRESH_KEY = 'almanac-gameday.refreshes';
  const REFRESH_LIMIT = 3;
  const REFRESH_WINDOW_MS = 30 * 60 * 1000;
  let refreshTimer = null;

  function recentRefreshes() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(REFRESH_KEY)) || []; } catch { list = []; }
    return list.filter((t) => typeof t === 'number' && Date.now() - t < REFRESH_WINDOW_MS);
  }

  function updateRefreshButton() {
    const btn = $('gd-refresh');
    const used = recentRefreshes();
    const left = REFRESH_LIMIT - used.length;
    clearTimeout(refreshTimer);
    if (left > 0) {
      btn.disabled = false;
      btn.textContent = `↻ Refresh · ${left} left`;
      btn.title = `Download fresh forecasts, odds and prices now (${left} of ${REFRESH_LIMIT} left in the next 30 minutes)`;
    } else {
      const freeAt = new Date(Math.min(...used) + REFRESH_WINDOW_MS);
      btn.disabled = true;
      btn.textContent = `↻ Refresh at ${freeAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      btn.title = `Refresh limit reached (${REFRESH_LIMIT} per 30 minutes). The next one frees up at ${freeAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    }
    // Re-check when the oldest use ages out of the window.
    if (used.length) refreshTimer = setTimeout(updateRefreshButton, Math.min(...used) + REFRESH_WINDOW_MS - Date.now() + 500);
  }

  $('gd-refresh').addEventListener('click', async () => {
    const used = recentRefreshes();
    if (used.length >= REFRESH_LIMIT) { updateRefreshButton(); return; }
    try { localStorage.setItem(REFRESH_KEY, JSON.stringify([...used, Date.now()])); } catch { /* still refresh */ }
    updateRefreshButton();
    await Football.clearCaches();
    render();
  });
  updateRefreshButton();

  // The desktop .exe (WebView2) serves files from inside itself, so it skips the offline cache;
  // a cache there would keep serving old files after a rebuild.
  const inDesktopShell = !!(window.chrome && window.chrome.webview);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !inDesktopShell) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* works without offline support */ });
  }

  // The banner's field is scaled to cover the header, so where its goal lines land depends on the window
  // size. Measure them and pad the header so the title starts just inside the left goal line and the
  // menu's right edge sits on the right one.
  const TITLE_INSET = 14;   // px between the left goal line and the title
  const banner = document.querySelector('.top.banner');
  const goalLeft = document.querySelector('.banner-field .goal-left');
  const goalRight = document.querySelector('.banner-field .goal-right');
  function alignBanner() {
    const b = banner.getBoundingClientRect();
    const left = goalLeft.getBoundingClientRect().right - b.left + TITLE_INSET;
    const right = b.right - goalRight.getBoundingClientRect().right;
    banner.style.paddingLeft = `${Math.max(16, Math.round(left))}px`;
    banner.style.paddingRight = `${Math.max(16, Math.round(right))}px`;
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
