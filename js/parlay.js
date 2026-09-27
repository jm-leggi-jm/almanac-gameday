// Parlays tab: 4-, 6-, 8- and 10-leg parlays from this week's not-yet-started games, built twice:
// open-air stadiums only, and all stadiums (domes, covered and retractable roofs too). Each game
// contributes one leg, either a moneyline or an over/under, whichever our estimate says is more
// likely. Weather only adjusts totals for open-air games. Legs are ranked by that estimate and each
// parlay takes the top N. Informational only.
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

  // Weather nudges toward the Under (rule of thumb): wind hurts passing and kicking; heavy rain and
  // snow slow games down. Percentage points added to the Under's chance, capped.
  const UNDER_BUMP = { strongWind: 6, breezy: 3, heavyPrecip: 5, rainLikely: 2, cap: 10 };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MINUS = '−';

  // ---------- Odds math ----------

  const num = (s) => (s == null || s === '' ? null : parseFloat(String(s).replace(MINUS, '-')));
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
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  // ---------- One leg per game ----------

  function underBump(w) {
    if (!w) return { bump: 0, why: [] };
    let bump = 0;
    const why = [];
    if (w.windMax >= 20 || w.gustMax >= 35) { bump += UNDER_BUMP.strongWind; why.push(`wind ${Math.round(w.windMax)} mph, gusts ${Math.round(w.gustMax)}`); }
    else if (w.windMax >= 13 || w.gustMax >= 25) { bump += UNDER_BUMP.breezy; why.push(`breezy ${Math.round(w.windMax)} mph, gusts ${Math.round(w.gustMax)}`); }
    if ((w.precip >= 0.25 && w.popMax >= 50) || w.snow >= 0.5) { bump += UNDER_BUMP.heavyPrecip; why.push(w.snow >= 0.5 ? 'snow' : 'heavy rain'); }
    else if (w.popMax >= 50 && w.precip >= 0.03) { bump += UNDER_BUMP.rainLikely; why.push(`rain likely (${Math.round(w.popMax)}%)`); }
    return { bump: Math.min(bump, UNDER_BUMP.cap), why };
  }

  function moneylineLeg(g, o, m) {
    const l = o && o.lines;
    if (!l || !l.mlHome || !l.mlAway) return null;
    const book = Football.impliedFromMoneylines(l.mlHome, l.mlAway);
    const sources = [];
    if (o.win) sources.push({ name: 'ESPN', home: o.win.home / (o.win.home + o.win.away) });
    if (m && !m.thin) sources.push({ name: 'Polymarket', home: m.home / (m.home + m.away) });
    if (book) sources.push({ name: 'DraftKings', home: book.home / 100 });
    if (!sources.length) return null;
    const home = avg(sources.map((s) => s.home));
    const pickHome = home >= 0.5;
    const pickProbs = sources.map((s) => ({ name: s.name, p: pickHome ? s.home : 1 - s.home }));
    return {
      g, kind: 'Moneyline',
      pick: `${pickHome ? g.home.abbr : g.away.abbr} to win`,
      odds: pickHome ? l.mlHome : l.mlAway,
      prob: pickHome ? home : 1 - home,
      detail: pickProbs.map((s) => `${s.name} ${Math.round(s.p * 100)}%`).join(' · '),
      signals: [
        movementSignal(pickHome ? l.mlHomeOpen : l.mlAwayOpen, pickHome ? l.mlHome : l.mlAway),
        agreementSignal(pickProbs),
        injurySignal(o.injuries, g, pickHome ? g.home.abbr : g.away.abbr),
      ].filter(Boolean),
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
    if (gap <= 5) return { tone: 'good', text: `✓ Sources agree (within ${gap} pts)`, tip: 'ESPN, Polymarket and DraftKings are close on this outcome.' };
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

  function totalLeg(g, o, m, w) {
    const l = o && o.lines;
    if (!l || l.total == null || !l.overOdds || !l.underOdds) return null;
    const book = Football.impliedFromMoneylines(l.overOdds, l.underOdds);   // "home" = over here
    if (!book) return null;
    const overs = [book.home / 100];
    const parts = [`DraftKings over ${Math.round(book.home)}%`];
    if (m && m.total && m.total.line === l.total) { overs.push(m.total.over / 100); parts.push(`Polymarket over ${Math.round(m.total.over)}%`); }
    let over = avg(overs);
    const { bump, why } = underBump(w);
    over -= bump / 100;
    if (bump) parts.push(`weather +${bump} pts to Under: ${why.join(', ')}`);
    const pickOver = over > 0.5;
    const probs = [{ name: 'DraftKings', p: book.home / 100 }];
    if (m && m.total && m.total.line === l.total) probs.push({ name: 'Polymarket', p: m.total.over / 100 });
    return {
      g, kind: 'Total',
      pick: `${pickOver ? 'Over' : 'Under'} ${l.total}`,
      odds: pickOver ? l.overOdds : l.underOdds,
      prob: pickOver ? over : 1 - over,
      detail: parts.join(' · '),
      weather: bump > 0,
      signals: [
        totalMovementSignal(l.totalOpen, l.total, pickOver),
        agreementSignal(probs.map((x) => ({ name: x.name, p: pickOver ? x.p : 1 - x.p }))),
        injurySignal(o.injuries, g, null),
      ].filter(Boolean),
    };
  }

  // Weather only counts for open-air games: a fixed roof keeps it off the field, and retractable
  // roofs are usually closed when it's bad.
  async function weatherFor(g) {
    if (g.roof !== 'open') return null;
    try {
      const loc = await Football.locate(g.venue);
      if (!loc) return null;
      return Football.gameWindow(await Football.hourly(loc), g.kickoff);
    } catch { return null; }
  }

  async function legFor(g) {
    const [o, m, w] = await Promise.all([
      Football.odds(g).catch(() => null),
      Football.market(g).catch(() => null),
      weatherFor(g),
    ]);
    const options = [moneylineLeg(g, o, m), totalLeg(g, o, m, w)].filter((x) => x && decimalOdds(x.odds));
    if (!options.length) return null;
    return options.sort((a, b) => b.prob - a.prob)[0];
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

  // `kind` names the pool in the not-enough message ("open-air" or "upcoming").
  function parlayCard(size, legs, kind) {
    if (legs.length < size) {
      return `
        <article class="parlay">
          <header class="p-head"><h3>${size}-leg parlay</h3></header>
          <p class="gd-wait">Not enough eligible games this week. There are ${legs.length} ${kind} games with posted odds.</p>
        </article>`;
    }
    const chosen = legs.slice(0, size);
    const decimal = chosen.reduce((a, l) => a * decimalOdds(l.odds), 1);
    const ours = chosen.reduce((a, l) => a * l.prob, 1);
    const priced = 1 / decimal;
    const money = (v) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const pays = STAKE * decimal;
    const rows = chosen.map((l) => `
      <li class="p-leg">
        <div class="p-leg-top">
          <span class="p-game">${esc(l.g.shortName)}${l.g.roof !== 'open' ? ` <span class="p-roof">${esc(Football.ROOF_LABEL[l.g.roof])}</span>` : ''}</span>
          <b class="p-pick">${esc(l.pick)}</b>
          <span class="p-odds">${esc(showAmerican(l.odds))}</span>
          <span class="p-prob">${pct(l.prob)}</span>
        </div>
        <div class="p-why">${esc(l.kind)}${l.weather ? ' <span class="p-wx">weather</span>' : ''} · ${esc(l.detail)}</div>
      </li>`).join('');
    return `
      <article class="parlay">
        <header class="p-head">
          <h3>${size}-leg parlay</h3>
          <span class="p-total">${americanFromDecimal(decimal)}</span>
        </header>
        <dl class="p-stats">
          <div title="What a $${STAKE} bet returns if every leg hits, including your $${STAKE} back.">
            <dt>$${STAKE} bet pays</dt><dd>${money(pays)}</dd><span class="p-sub">if every leg hits</span></div>
          <div title="Every leg's chance multiplied together: how often this parlay should hit, by our numbers (ESPN, Polymarket and DraftKings blended).">
            <dt>Chance it hits</dt><dd>${pct(ours)}</dd><span class="p-sub">our estimate</span></div>
          <div title="How often the parlay must hit for this payout to break even. It's what the sportsbook's price implies.">
            <dt>Break-even</dt><dd>${pct(priced)}</dd><span class="p-sub">what this payout needs</span></div>
        </dl>
        ${flagsDropdown(chosen, (l) => (l.kind === 'Total' ? `${l.pick} (${l.g.shortName})` : l.pick))}
        <ol class="p-legs">${rows}</ol>
      </article>`;
  }

  let token = 0;
  async function render() {
    const t = ++token;
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
    const legs = (await Promise.all(upcoming.map(legFor))).filter(Boolean).sort((a, b) => b.prob - a.prob);
    if (t !== token) return;
    const openLegs = legs.filter((l) => l.g.roof === 'open');
    const openGames = upcoming.filter((g) => g.roof === 'open').length;
    const updated = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('p-sub').textContent = `${week.label} · ${upcoming.length} upcoming games (${openGames} open-air) · ${legs.length} with posted odds · updated ${updated}`;
    $('p-count-open').textContent = `${openLegs.length} eligible games`;
    $('p-count-all').textContent = `${legs.length} eligible games`;
    $('p-list-open').innerHTML = SIZES.map((n) => parlayCard(n, openLegs, 'open-air')).join('');
    $('p-list-all').innerHTML = SIZES.map((n) => parlayCard(n, legs, 'upcoming')).join('');
    const lateLegs = legs.filter((l) => isAfternoonWindow(l.g.kickoff));
    $('p-count-late').textContent = `${lateLegs.length} games that haven't kicked off`;
    $('p-list-late').innerHTML = AFTERNOON_SIZES.map((n) => parlayCard(n, lateLegs, 'afternoon-window')).join('');
  }

  // ---------- Tabs ----------

  function setTab(tab) {
    const parlays = tab === 'parlays';
    $('gameday').hidden = parlays;
    $('parlays-view').hidden = !parlays;   // not id="parlays", so a #parlays link switches tabs without scrolling
    document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* fine */ }
    if (parlays) render();
  }

  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  $('p-rebuild').addEventListener('click', render);

  // A link ending in #parlays or #games opens that tab; otherwise the last tab used.
  let saved = 'games';
  try { saved = localStorage.getItem(TAB_KEY) === 'parlays' ? 'parlays' : 'games'; } catch { /* fine */ }
  if (location.hash === '#parlays' || location.hash === '#games') saved = location.hash.slice(1);
  setTab(saved);
})();
