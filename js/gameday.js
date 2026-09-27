// "Game day weather" section: upcoming NFL games for followed teams (or the whole week), each with the
// forecast for its game window, roof-aware impact, and a radar of the stadium's area.
(() => {
  const PREFS_KEY = 'almanac-gameday.prefs.v1';
  const DEFAULT_PREFS = { mode: 'mine', teams: ['MIN'] };
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
        <div class="gd-weather"><p class="gd-wait">Loading forecast…</p></div>
        <div class="gd-radar-wrap"></div>
      </article>`;
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
    return `
      <div class="gd-now">
        <div class="gd-big"><strong>${temps}</strong><span>${esc(w.condition)}${indoors ? ' <em>(outside)</em>' : ''}</span></div>
        <dl class="gd-facts">
          <div><dt>Feels like</dt><dd>${Math.round(w.feelsMin)}°${Math.round(w.feelsMax) !== Math.round(w.feelsMin) ? `–${Math.round(w.feelsMax)}°` : ''}</dd></div>
          <div><dt>${past ? 'Precip' : 'Rain chance'}</dt><dd>${past ? `${w.precip.toFixed(2)}″` : `${Math.round(w.popMax)}%`}</dd></div>
          <div><dt>Wind</dt><dd>${esc(w.windDir)} ${Math.round(w.windMax)} mph</dd></div>
          <div><dt>Gusts</dt><dd>${Math.round(w.gustMax)} mph</dd></div>
        </dl>
      </div>
      <div class="gd-hours">${w.hours.map(hourCell).join('')}</div>
      <div class="gd-impact impact-${imp.level}">
        <span class="gd-impact-label">${IMPACT_ICON[imp.level]} ${past ? 'Weather impact was' : 'Weather impact'}: <b>${imp.label}</b>${g.roof === 'retractable' ? ' <span class="muted">(if the roof is open)</span>' : ''}</span>
        <span class="gd-reasons">${imp.reasons.map(esc).join(' · ')}</span>
      </div>
      ${conf ? `<p class="gd-conf">Forecast confidence: <b>${conf.label}</b> — ${esc(conf.note)}</p>` : ''}
      ${g.roof === 'retractable' ? '<p class="gd-conf">Retractable roof: the team usually decides on game day, and tends to close it for rain, cold or heat.</p>' : ''}`;
  }

  function mountRadar(g, wrap, loc) {
    const holder = document.createElement('div');
    holder.className = 'gd-radar';
    wrap.appendChild(holder);
    const r = Radar.create();
    r.mount(holder, { zoom: 6 });
    r.setLocation(loc);
    radars.push(r);
    return r;
  }

  async function fillCard(card, g) {
    const wx = card.querySelector('.gd-weather');
    const wrap = card.querySelector('.gd-radar-wrap');
    let loc;
    try {
      loc = await Football.locate(g.venue);
    } catch { loc = null; }
    if (!loc) { wx.innerHTML = '<p class="gd-wait">Couldn’t find this stadium’s location.</p>'; return; }

    try {
      const h = await Football.hourly(loc);
      const w = Football.gameWindow(h, g.kickoff);
      if (w) {
        wx.innerHTML = weatherBlock(g, w);
      } else {
        const opens = new Date(g.kickoff.getTime() - (Football.FORECAST_DAYS - 1) * 86400000);
        wx.innerHTML = `<p class="gd-wait">Too far out for a forecast. It appears around
          <b>${opens.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</b>, ${Football.FORECAST_DAYS} days before kickoff.</p>`;
      }
    } catch (err) {
      wx.innerHTML = `<p class="gd-wait">Forecast unavailable (${esc(err.message)}).</p>`;
    }

    // Radar: live conditions around the stadium. Domes get it on request only.
    if (g.state === 'post') return;
    if (g.roof === 'dome' || g.roof === 'canopy') {
      wrap.innerHTML = '<button type="button" class="ghost small gd-show-radar">Show outside radar</button>';
      wrap.querySelector('button').addEventListener('click', (e) => {
        e.target.remove();
        const r = mountRadar(g, wrap, loc);
        observer.observe(card);
        card._radar = r;
      }, { once: true });
      return;
    }
    card._pendingRadar = () => { card._radar = mountRadar(g, wrap, loc); };
    observer.observe(card);
  }

  // Radars are created when their card nears the screen and paused while it's away.
  function makeObserver() {
    return new IntersectionObserver((entries) => {
      for (const e of entries) {
        const card = e.target;
        if (e.isIntersecting && card._pendingRadar) { const make = card._pendingRadar; card._pendingRadar = null; make(); }
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
    const games = result.games.sort((a, b) => a.kickoff - b.kickoff);
    const following = prefs.mode === 'mine' && prefs.teams.length ? ` · following ${prefs.teams.join(', ')}` : '';
    $('gd-sub').textContent = `${result.title}${following} · ${games.length} game${games.length === 1 ? '' : 's'}`;
    if (!games.length) {
      $('gd-list').innerHTML = `<p class="empty-note">${prefs.mode === 'mine' ? 'Pick teams to follow with <b>Teams…</b>.' : 'No games scheduled this week.'}</p>`;
      return;
    }
    $('gd-list').innerHTML = games.map(cardShell).join('');
    $('gd-list').querySelectorAll('.game').forEach((card) => fillCard(card, games[Number(card.dataset.i)]));
  }

  // ---------- Team picker ----------

  async function openPicker() {
    const dlg = $('gd-dialog');
    const list = $('gd-team-list');
    list.innerHTML = '<p class="muted">Loading teams…</p>';
    $('gd-save').disabled = true;   // never save an empty selection just because the list isn't there yet
    dlg.showModal();
    try {
      const all = await Football.teams();
      list.innerHTML = all.map((t) => `
        <label class="gd-pick"><input type="checkbox" value="${esc(t.abbr)}" ${prefs.teams.includes(t.abbr) ? 'checked' : ''}>
          ${t.logo ? `<img src="${esc(t.logo)}" alt="" width="22" height="22" loading="lazy">` : ''}<span>${esc(t.name)}</span></label>`).join('');
      $('gd-save').disabled = false;
    } catch (err) {
      list.innerHTML = `<p class="muted">Couldn’t load teams (${esc(err.message)}).</p>`;
    }
  }

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

  observer = makeObserver();
  render();
  setInterval(() => { if (!document.hidden) render(); }, REFRESH_MS);
})();
