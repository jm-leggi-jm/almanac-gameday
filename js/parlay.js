// Parlays tab: 4-, 6-, 8- and 10-leg parlays from this week's not-yet-started games, built twice:
// open-air stadiums only, and all stadiums (domes, covered and retractable roofs too). Each game
// contributes one leg, either a moneyline or an over/under, whichever favored side has the higher
// fair chance. The auto card is favorites only; Other side flips that one leg. Weather is a flag,
// not a change to the chance. The payout uses the posted odds (vig included). Informational only.
(() => {
  const SIZES = [4, 6, 8, 10];
  const AFTERNOON_SIZES = [2, 3, 4];   // the Sunday 4 PM slate is usually only 3-5 games

  // Sunday's late-afternoon window: kickoffs from 4:00 to 4:59 PM Eastern (the 4:05 and 4:25 games).
  function isAfternoonWindow(kickoff) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(kickoff);
    const get = (type) => (parts.find((p) => p.type === type) || {}).value;
    return get('weekday') === 'Sun' && Number(get('hour')) === 16;
  }
  const TAB_KEY = 'almanac-gameday.tab';
  const STAKE = 5;   // payouts are shown for a $5 bet

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MINUS = '−';

  // ---------- Odds math ----------

  const num = (s) => {
    if (s == null || s === '') return null;
    const t = String(s).trim().replace(MINUS, '-').toUpperCase();
    const v = t === 'EVEN' || t === 'EV' ? 100 : t === 'PK' || t === 'PICK' ? 0 : parseFloat(t);
    return Number.isFinite(v) ? v : null;
  };
  function decimalOdds(american) {
    const n = num(american);
    if (n == null || n === 0) return null;
    return n > 0 ? 1 + n / 100 : 1 + 100 / -n;
  }
  function americanFromDecimal(d) {
    const a = d >= 2 ? (d - 1) * 100 : -100 / (d - 1);
    return `${a > 0 ? '+' : MINUS}${Math.round(Math.abs(a)).toLocaleString()}`;
  }
  const showAmerican = (s) => String(s).replace('-', MINUS);
  const pct = (p) => `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;

  // ---------- One leg per game ----------

  const bookList = (o) => (o && o.books && o.books.length ? o.books : (o && o.lines ? [o.lines] : []));

  // Fair home (or over) probability from each distinct book, vig removed. ESPN's posted odds are
  // DraftKings, so that name appears once. The Matchup Predictor is not a book and is not included.
  function bookFair(books, fairOf) {
    const rows = [];
    for (const b of books) {
      const p = fairOf(b);
      if (p == null) continue;
      rows.push({ name: b.provider || 'Sportsbook', p });
    }
    return rows;
  }

  // `skip` is why Polymarket was left out, or null when it was used or there is no market.
  function blendDetail(rows, poly, usePoly, skip, pickPositive) {
    const side = (p) => (pickPositive ? p : 1 - p);
    const parts = rows.map((r) => `${r.name} ${Math.round(side(r.p) * 100)}%`);
    if (usePoly) parts.push(`Polymarket ${Math.round(side(poly) * 100)}%`);
    else if (skip) parts.push(`Polymarket left out (${skip})`);
    const blended = Football.blendFair(Football.combineFair(rows.map((r) => r.p)), poly, usePoly);
    if (blended != null) parts.push(`blend ${Math.round(side(blended) * 100)}%`);
    return parts.join(' · ');
  }

  function moneylineLeg(g, o, m) {
    const books = bookList(o);
    const rows = bookFair(books, (b) => {
      const fair = Football.impliedFromMoneylines(b.mlHome, b.mlAway);
      return fair ? fair.home / 100 : null;
    });
    const posted = books.find((b) => b.mlHome && b.mlAway) || null;
    if (!posted) return null;
    const usePoly = !!(m && !m.thin && m.home + m.away > 0);
    const polyHome = usePoly ? m.home / (m.home + m.away) : null;
    const skip = usePoly || !m || !m.thin ? null : 'thin market';
    const home = Football.blendFair(Football.combineFair(rows.map((r) => r.p)), polyHome, usePoly);
    if (home == null) return null;
    const pickHome = home >= 0.5;
    const sideSources = (positive) => {
      const list = rows.map((r) => ({ name: r.name, p: positive ? r.p : 1 - r.p }));
      if (usePoly) list.push({ name: 'Polymarket', p: positive ? polyHome : 1 - polyHome });
      return list;
    };
    const signalsFor = (homeSide) => [
      movementSignal(homeSide ? posted.mlHomeOpen : posted.mlAwayOpen, homeSide ? posted.mlHome : posted.mlAway),
      agreementSignal(sideSources(homeSide)),
      injurySignal(o && o.injuries, g, homeSide ? g.home.abbr : g.away.abbr),
    ].filter(Boolean);
    return {
      g, kind: 'Moneyline',
      pick: `${pickHome ? g.home.abbr : g.away.abbr} to win`,
      otherPick: `${pickHome ? g.away.abbr : g.home.abbr} to win`,
      odds: pickHome ? posted.mlHome : posted.mlAway,
      otherOdds: pickHome ? posted.mlAway : posted.mlHome,
      prob: pickHome ? home : 1 - home,
      favored: home !== 0.5,
      detail: blendDetail(rows, polyHome, usePoly, skip, pickHome),
      otherDetail: blendDetail(rows, polyHome, usePoly, skip, !pickHome),
      signals: signalsFor(pickHome),
      otherSignals: signalsFor(!pickHome),
      weather: [],
    };
  }

  // ---------- Signals: line movement, source agreement, injuries ----------

  // A sign on each leg, shown as a chip: 'good' supports the pick, 'bad' works against it.
  const impliedOf = (american) => { const d = decimalOdds(american); return d ? 1 / d : null; };

  // Moneyline: did the price on our side get shorter (more money on it) or longer since it opened?
  function movementSignal(openOdds, nowOdds) {
    const was = impliedOf(openOdds);
    const now = impliedOf(nowOdds);
    if (was == null || now == null) return null;
    const pts = Math.round((now - was) * 100);
    const move = `${showAmerican(openOdds)} → ${showAmerican(nowOdds)}`;
    if (Math.abs(pts) < 2) return { tone: 'neutral', text: `• Line steady (${move})`, tip: 'The price has barely moved since the line opened.' };
    return pts > 0
      ? { tone: 'good', text: `▲ Line moved toward this pick (${move})`, tip: `Since opening, the price on this side got ${pts} points shorter: money has come in on it.` }
      : { tone: 'bad', text: `▼ Line moved against this pick (${move})`, tip: `Since opening, the price on this side got ${-pts} points longer: money has gone the other way.` };
  }

  // Totals: a line that rose means money on the Over; one that fell means money on the Under.
  function totalMovementSignal(openLine, nowLine, pickOver) {
    if (openLine == null || nowLine == null) return null;
    const move = `${openLine} → ${nowLine}`;
    if (openLine === nowLine) return { tone: 'neutral', text: `• Total steady (${nowLine})`, tip: 'The total hasn’t moved since it opened.' };
    const toward = (nowLine > openLine) === pickOver;
    return toward
      ? { tone: 'good', text: `▲ Total moved toward this pick (${move})`, tip: 'The total has moved in the direction of this bet since it opened.' }
      : { tone: 'bad', text: `▼ Total moved against this pick (${move})`, tip: 'The total has moved away from this bet since it opened.' };
  }

  // How far apart the sources are on this leg's chance.
  function agreementSignal(probs) {
    if (probs.length < 2) return null;
    const sorted = [...probs].sort((a, b) => a.p - b.p);
    const lo = sorted[0];
    const hi = sorted[sorted.length - 1];
    const gap = Math.round((hi.p - lo.p) * 100);
    if (gap <= 5) return { tone: 'good', text: `✓ Sources agree (within ${gap} pts)`, tip: 'The sportsbook prices and Polymarket are close on this outcome.' };
    if (gap <= 12) return { tone: 'neutral', text: `≈ Sources differ by ${gap} pts`, tip: `${hi.name} ${Math.round(hi.p * 100)}% vs ${lo.name} ${Math.round(lo.p * 100)}%.` };
    return { tone: 'bad', text: `✗ Sources disagree: ${hi.name} ${Math.round(hi.p * 100)}% vs ${lo.name} ${Math.round(lo.p * 100)}%`, tip: 'A wide split means the outcome is less settled than the average suggests.' };
  }

  // Notable injuries (skill positions and QB) on both teams. For a moneyline, injuries on the
  // picked team work against it; for a total, both teams matter.
  const KEY_POS = new Set(['QB', 'RB', 'WR', 'TE', 'K']);
  const STATUS_SHORT = { Out: 'out', Doubtful: 'doubtful', Questionable: 'questionable', Suspended: 'suspended' };
  function injurySignal(injuries, g, pickedTeam) {
    if (!injuries) return null;
    const list = (abbr) => (injuries[abbr] || []).filter((i) => KEY_POS.has(i.pos));
    const describe = (abbr) => list(abbr).map((i) => `${i.name} (${i.pos}) ${STATUS_SHORT[i.status]}`).join(', ');
    const teams = [g.away.abbr, g.home.abbr].filter((t) => list(t).length);
    if (!teams.length) return { tone: 'neutral', text: '• No key injuries listed', tip: 'No QB, RB, WR, TE or K on either injury report (injured reserve not counted).' };
    const text = teams.map((t) => `${t}: ${describe(t)}`).join(' · ');
    if (!pickedTeam) return { tone: 'neutral', text: `⚠ ${text}`, tip: 'Injuries to key players can swing a total either way.' };
    const pickHurt = list(pickedTeam);
    if (!pickHurt.length) return { tone: 'good', text: `✓ Opponent injuries: ${text}`, tip: `Only the opponent has key players hurt, which helps ${pickedTeam}.` };
    const serious = pickHurt.some((i) => i.status !== 'Questionable');
    return { tone: 'bad', text: `${serious ? '✖' : '⚠'} ${text}`, tip: `Injuries on ${pickedTeam} (the pick) work against this leg; injuries on the opponent help it.` };
  }

  function totalLeg(g, o, m) {
    const books = bookList(o);
    const posted = books.find((b) => b.total != null && b.overOdds && b.underOdds) || null;
    if (!posted) return null;
    // Only books at the same number. A 44.5 and a 47.5 are different bets.
    const rows = bookFair(books, (b) => {
      if (b.total !== posted.total || !b.overOdds || !b.underOdds) return null;
      const fair = Football.impliedFromMoneylines(b.overOdds, b.underOdds);   // "home" = over
      return fair ? fair.home / 100 : null;
    });
    // Every qualifying total is kept. Match the book's number; a busier line at a different total is a different bet.
    const match = m && (m.totals || []).find((t) => t.line === posted.total);
    const usePoly = !!match;
    const polyOver = usePoly ? match.over / 100 : null;
    let skip = null;
    if (!usePoly && m) {
      const thinHit = (m.thinTotals || []).some((t) => t.line === posted.total);
      skip = thinHit ? 'thin total' : 'no total at this line';
    }
    const over = Football.blendFair(Football.combineFair(rows.map((r) => r.p)), polyOver, usePoly);
    if (over == null) return null;
    const pickOver = over >= 0.5;
    const sideSources = (positive) => {
      const list = rows.map((r) => ({ name: r.name, p: positive ? r.p : 1 - r.p }));
      if (usePoly) list.push({ name: 'Polymarket', p: positive ? polyOver : 1 - polyOver });
      return list;
    };
    const signalsFor = (overSide) => [
      totalMovementSignal(posted.totalOpen, posted.total, overSide),
      agreementSignal(sideSources(overSide)),
      injurySignal(o && o.injuries, g, null),
    ].filter(Boolean);
    return {
      g, kind: 'Total',
      pick: `${pickOver ? 'Over' : 'Under'} ${posted.total}`,
      otherPick: `${pickOver ? 'Under' : 'Over'} ${posted.total}`,
      odds: pickOver ? posted.overOdds : posted.underOdds,
      otherOdds: pickOver ? posted.underOdds : posted.overOdds,
      prob: pickOver ? over : 1 - over,
      favored: over !== 0.5,
      detail: blendDetail(rows, polyOver, usePoly, skip, pickOver),
      otherDetail: blendDetail(rows, polyOver, usePoly, skip, !pickOver),
      signals: signalsFor(pickOver),
      otherSignals: signalsFor(!pickOver),
      weather: [],
    };
  }

  // Open-air games get weather flags. A roof gets none of the forecast: retractable roofs carry
  // one fixed note, and domes and canopies are already labeled on the leg.
  async function weatherFor(g) {
    if (g.roof !== 'open') return null;
    try {
      const loc = await Football.locate(g.venue);
      if (!loc) return null;
      return Football.gameWindow(await Football.hourly(loc), g.kickoff);
    } catch { return null; }
  }

  function weatherFlags(g, w) {
    if (g.roof === 'retractable') return ['retractable roof, usually closed in bad weather'];
    if (g.roof !== 'open' || !w) return [];
    const imp = Football.impact(w, 'open');
    return imp.reasons.filter((r) => r !== 'Good football weather');
  }

  async function legFor(g) {
    const [o, m, w] = await Promise.all([
      Football.odds(g).catch(() => null),
      Football.market(g).catch(() => null),
      weatherFor(g),
    ]);
    const flags = weatherFlags(g, w);
    const options = [moneylineLeg(g, o, m), totalLeg(g, o, m)].filter((x) => x && decimalOdds(x.odds) && decimalOdds(x.otherOdds));
    if (!options.length) return null;
    // One market per game: the favorite with the higher fair chance. Not the max across sources.
    const leg = options.sort((a, b) => b.prob - a.prob)[0];
    leg.weather = flags;
    return leg;
  }

  // ---------- Rendering ----------

  // One collapsible "Flags" list per card, under the payout details, gathering every leg's signals
  // grouped into against / supporting / neutral. Shared with the prop parlays (window.ParlaySignals).
  // `label(leg)` names the leg in each line (e.g. "SF to win").
  const FLAG_GROUPS = [
    { tone: 'bad', title: 'Against' },
    { tone: 'good', title: 'Supporting' },
    { tone: 'neutral', title: 'Neutral' },
  ];
  function flagsDropdown(legs, label) {
    const all = legs.flatMap((l) => (l.signals || []).map((s) => ({ ...s, leg: label(l) })));
    if (!all.length) return '';
    const count = (tone) => all.filter((s) => s.tone === tone).length;
    const summary = FLAG_GROUPS.filter((g) => count(g.tone))
      .map((g) => `<span class="flag-count ${g.tone}">${count(g.tone)} ${g.title.toLowerCase()}</span>`).join(' · ');
    const groups = FLAG_GROUPS.filter((g) => count(g.tone)).map((g) => `
      <div class="flag-group">
        <h5 class="${g.tone}">${g.title} (${count(g.tone)})</h5>
        <ul>${all.filter((s) => s.tone === g.tone).map((s) => `
          <li class="sig ${s.tone}" title="${esc(s.tip || '')}"><b>${esc(s.leg)}:</b> ${esc(s.text)}</li>`).join('')}
        </ul>
      </div>`).join('');
    return `<details class="p-flags"><summary>Flags: ${summary}</summary>${groups}</details>`;
  }
  window.ParlaySignals = { dropdown: flagsDropdown };

  // The stored leg is the favorite. A flip shows the other side of the same market.
  function shownLeg(leg, flipped) {
    if (!flipped) return { ...leg, userPick: false };
    return {
      ...leg,
      pick: leg.otherPick,
      odds: leg.otherOdds,
      prob: 1 - leg.prob,
      detail: leg.otherDetail,
      signals: leg.otherSignals,
      userPick: true,
    };
  }

  // `kind` names the pool in the not-enough message ("open-air" or "upcoming").
  function parlayCard(size, legs, kind, pool) {
    if (legs.length < size) {
      return `
        <article class="parlay">
          <header class="p-head"><h3>${size}-leg parlay</h3></header>
          <p class="gd-wait">Not enough eligible games this week. There are ${legs.length} ${kind} games with posted odds.</p>
        </article>`;
    }
    const chosen = legs.slice(0, size).map((l) => shownLeg(l, flips.has(`${pool}|${size}|${l.g.id}`)));
    const decimal = chosen.reduce((a, l) => a * decimalOdds(l.odds), 1);
    const ours = chosen.reduce((a, l) => a * l.prob, 1);
    const priced = 1 / decimal;
    const money = (v) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const pays = STAKE * decimal;
    const rows = chosen.map((l) => {
      const tag = l.userPick ? 'you picked this side' : (l.favored ? 'favored' : 'even');
      const flags = (l.weather || []).map((w) => `<span class="p-wx">${esc(w)}</span>`).join(' ');
      return `
      <li class="p-leg">
        <div class="p-leg-top">
          <span class="p-game">${esc(l.g.shortName)}${l.g.roof !== 'open' ? ` <span class="p-roof">${esc(Football.ROOF_LABEL[l.g.roof])}</span>` : ''}</span>
          <b class="p-pick">${esc(l.pick)} <span class="p-side">${esc(tag)}</span></b>
          <span class="p-odds">${esc(showAmerican(l.odds))}</span>
          <span class="p-prob">${pct(l.prob)}</span>
        </div>
        <div class="p-why">${esc(l.kind)}${flags ? ` ${flags}` : ''} · ${esc(l.detail)}
          <button type="button" class="small ghost p-flip" data-flip="${esc(pool)}|${size}|${esc(l.g.id)}">${l.userPick ? 'Favored side' : 'Other side'}</button></div>
      </li>`;
    }).join('');
    return `
      <article class="parlay">
        <header class="p-head">
          <h3>${size}-leg parlay</h3>
          <span class="p-total">${americanFromDecimal(decimal)}</span>
        </header>
        <dl class="p-stats">
          <div title="What a $${STAKE} bet returns if every leg hits, including your $${STAKE} back. The price is the posted American odds, vig included.">
            <dt>$${STAKE} bet pays</dt><dd>${money(pays)}</dd><span class="p-sub">posted price, vig included</span></div>
          <div title="Each leg's de-vigged price, multiplied. This is the market's estimate, with no edge implied.">
            <dt>Chance it hits</dt><dd>${pct(ours)}</dd><span class="p-sub">market estimate, no edge implied</span></div>
          <div title="How often the parlay must hit for this payout to break even. It's what the sportsbook's price implies, vig included.">
            <dt>Break-even</dt><dd>${pct(priced)}</dd><span class="p-sub">what this payout needs</span></div>
        </dl>
        <p class="p-note">Market estimate, no edge implied.</p>
        ${flagsDropdown(chosen, (l) => (l.kind === 'Total' ? `${l.pick} (${l.g.shortName})` : l.pick))}
        <ol class="p-legs">${rows}</ol>
      </article>`;
  }

  let token = 0;
  let cached = null;
  const flips = new Set();   // pool|size|gameId, cleared on a rebuild

  function paint() {
    if (!cached) return;
    const { week, legs, upcoming } = cached;
    const openLegs = legs.filter((l) => l.g.roof === 'open');
    const openGames = upcoming.filter((g) => g.roof === 'open').length;
    const updated = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('p-sub').textContent = `${week.label} · ${upcoming.length} upcoming games (${openGames} open-air) · ${legs.length} with posted odds · updated ${updated}`;
    $('p-count-open').textContent = `${openLegs.length} eligible games`;
    $('p-count-all').textContent = `${legs.length} eligible games`;
    $('p-list-open').innerHTML = SIZES.map((n) => parlayCard(n, openLegs, 'open-air', 'open')).join('');
    $('p-list-all').innerHTML = SIZES.map((n) => parlayCard(n, legs, 'upcoming', 'all')).join('');
    const lateLegs = legs.filter((l) => isAfternoonWindow(l.g.kickoff));
    $('p-count-late').textContent = `${lateLegs.length} games that haven't kicked off`;
    $('p-list-late').innerHTML = AFTERNOON_SIZES.map((n) => parlayCard(n, lateLegs, 'afternoon-window', 'late')).join('');
  }

  async function render() {
    const t = ++token;
    flips.clear();
    cached = null;
    $('p-sub').textContent = 'Building parlays…';
    $('p-list-open').innerHTML = '';
    $('p-list-all').innerHTML = '';
    $('p-list-late').innerHTML = '';
    let week;
    try {
      week = await Football.thisWeek();
    } catch (err) {
      if (t === token) $('p-sub').textContent = `Couldn’t load this week’s games (${err.message}).`;
      return;
    }
    const upcoming = week.games.filter((g) => g.state === 'pre');
    // One leg per game, worked out once; the open-air parlays use the open-air subset.
    // Ranked by the favorite's fair chance, so the auto card is favorites only.
    let legs;
    try {
      legs = (await Promise.all(upcoming.map(legFor))).filter(Boolean).sort((a, b) => b.prob - a.prob);
    } catch (err) {
      if (t === token) $('p-sub').textContent = `Couldn’t build parlays (${err.message}).`;
      return;
    }
    if (t !== token) return;
    cached = { week, legs, upcoming };
    paint();
  }

  // ---------- Tabs ----------

  // Each tab shows one section. Section ids differ from the tab names, so a #parlays link switches tabs without scrolling.
  const VIEWS = { games: 'gameday', parlays: 'parlays-view', past: 'past-view', changelog: 'changelog-view' };

  function setTab(tab) {
    if (!VIEWS[tab]) tab = 'games';
    for (const [name, id] of Object.entries(VIEWS)) $(id).hidden = name !== tab;
    document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* fine */ }
    if (tab === 'parlays') render();
    document.dispatchEvent(new CustomEvent('tabchange', { detail: tab }));
  }

  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  $('p-rebuild').addEventListener('click', render);
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-flip]');
    if (!b || !cached) return;
    const k = b.dataset.flip;
    if (flips.has(k)) flips.delete(k); else flips.add(k);
    paint();
  });

  // A link ending in #games, #parlays or #past opens that tab; otherwise the last tab used.
  let saved = 'games';
  try { saved = localStorage.getItem(TAB_KEY) || 'games'; } catch { /* fine */ }
  if (VIEWS[location.hash.slice(1)]) saved = location.hash.slice(1);
  setTab(saved);
})();
