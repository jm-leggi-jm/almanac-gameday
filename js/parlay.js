// Parlays tab: 4-, 6-, 8- and 10-leg parlays from this week's not-yet-started games, built twice:
// open-air stadiums only, and all stadiums (domes, covered and retractable roofs too). Each game
// contributes one leg, either a moneyline or an over/under, whichever our estimate says is more
// likely. Weather only adjusts totals for open-air games. Legs are ranked by that estimate and each
// parlay takes the top N. Informational only.
(() => {
  const SIZES = [4, 6, 8, 10];
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
    return {
      g, kind: 'Moneyline',
      pick: `${pickHome ? g.home.abbr : g.away.abbr} to win`,
      odds: pickHome ? l.mlHome : l.mlAway,
      prob: pickHome ? home : 1 - home,
      detail: sources.map((s) => `${s.name} ${Math.round((pickHome ? s.home : 1 - s.home) * 100)}%`).join(' · '),
    };
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
    return {
      g, kind: 'Total',
      pick: `${pickOver ? 'Over' : 'Under'} ${l.total}`,
      odds: pickOver ? l.overOdds : l.underOdds,
      prob: pickOver ? over : 1 - over,
      detail: parts.join(' · '),
      weather: bump > 0,
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
          <div><dt>$${STAKE} pays</dt><dd>$${(STAKE * decimal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</dd></div>
          <div><dt>Our estimate</dt><dd>${pct(ours)}</dd></div>
          <div><dt>Priced at</dt><dd>${pct(priced)}</dd></div>
        </dl>
        <ol class="p-legs">${rows}</ol>
      </article>`;
  }

  let token = 0;
  async function render() {
    const t = ++token;
    $('p-sub').textContent = 'Building parlays…';
    $('p-list-open').innerHTML = '';
    $('p-list-all').innerHTML = '';
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
  }

  // ---------- Tabs ----------

  function setTab(tab) {
    const parlays = tab === 'parlays';
    $('gameday').hidden = parlays;
    $('parlays').hidden = !parlays;
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
