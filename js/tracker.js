// Tracker: a condensed panel on the right with the games you pick using "☆ Track" on a game card.
// It shows on every tab while at least one game is tracked, and is hidden otherwise. It refreshes from
// ESPN's scoreboard (one request for the whole week): every 30 seconds while a tracked game is live,
// every 5 minutes otherwise. Picks are remembered, and dropped once the week's scoreboard moves on.
const Tracker = (() => {
  const KEY = 'almanac-gameday.tracked';
  const LIVE_MS = 30 * 1000;
  const IDLE_MS = 5 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ORDINAL = ['', '1st', '2nd', '3rd', '4th'];

  let ids = load();
  let games = new Map();
  let timer = null;

  function load() {
    try {
      const list = JSON.parse(localStorage.getItem(KEY));
      if (Array.isArray(list)) return new Set(list.map(String));
    } catch { /* fall through */ }
    return new Set();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify([...ids])); } catch { /* fine */ }
  }

  const isTracked = (id) => ids.has(String(id));

  // The toggle shown on live and upcoming game cards.
  function button(g) {
    if (!g || g.state === 'post') return '';
    const on = isTracked(g.id);
    return `<button type="button" class="trk-btn${on ? ' on' : ''}" data-track="${esc(g.id)}" aria-pressed="${on}"
      title="${on ? 'Stop tracking this game' : 'Show this game in the tracker panel'}">${on ? '★ Tracking' : '☆ Track'}</button>`;
  }

  function syncButtons() {
    document.querySelectorAll('[data-track]').forEach((b) => {
      const on = isTracked(b.dataset.track);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      b.textContent = on ? '★ Tracking' : '☆ Track';
      b.title = on ? 'Stop tracking this game' : 'Show this game in the tracker panel';
    });
  }

  function setTracked(id, on) {
    id = String(id);
    if (on) ids.add(id); else ids.delete(id);
    save();
    syncButtons();
    refresh();
  }

  // ---------- Panel ----------

  function show(visible) {
    $('tracker').hidden = !visible;
    document.body.classList.toggle('tracking', visible);
  }

  function statusText(g) {
    if (g.state === 'post') return g.detail || 'Final';
    if (g.state === 'in') return g.detail || 'Live';
    const d = g.kickoff;
    const today = new Date().toDateString() === d.toDateString();
    const day = today ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' });
    return `${day} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }

  function teamRow(g, t, winning) {
    const ball = g.situation && g.situation.possession === String(t.id) ? '<span class="trk-ball" title="Has the ball">●</span>' : '';
    const logo = t.logo ? `<img src="${esc(t.logo)}" alt="" width="20" height="20" loading="lazy">` : '';
    return `<div class="trk-team${winning ? ' lead' : ''}">${logo}<span class="trk-abbr">${esc(t.abbr || '')}</span>${ball}
      <b class="trk-score">${t.score != null ? esc(t.score) : ''}</b></div>`;
  }

  function gameItem(g) {
    const hs = Number(g.home.score);
    const as = Number(g.away.score);
    const started = g.state !== 'pre';
    const s = g.situation;
    const parts = [];
    if (s && s.down && s.possession) parts.push(`${ORDINAL[s.down] || `${s.down}th`} & ${s.distance}`);
    if (s && s.possession) {
      const has = [g.home, g.away].find((t) => String(t.id) === s.possession);
      if (has) parts.push(`${esc(has.abbr)} ball`);
    }
    if (s && s.redZone) parts.push('<span class="trk-rz">Red zone</span>');
    let wp = '';
    if (s && s.homeWin != null) {
      const h = Math.round(s.homeWin);
      wp = `<div class="trk-wp" title="ESPN live win probability">
          <div class="gd-prob-bar"><span class="away" style="width:${100 - h}%"></span><span class="home" style="width:${h}%"></span></div>
          <span>${esc(g.away.abbr)} ${100 - h}% · ${esc(g.home.abbr)} ${h}%</span></div>`;
    }
    return `
      <li class="trk-game state-${g.state}">
        <div class="trk-top">
          <span class="trk-status">${g.state === 'in' ? '● ' : ''}${esc(statusText(g))}</span>
          <button type="button" class="trk-x" data-untrack="${esc(g.id)}" aria-label="Stop tracking ${esc(g.shortName || '')}" title="Stop tracking">×</button>
        </div>
        ${teamRow(g, g.away, started && as > hs)}
        ${teamRow(g, g.home, started && hs > as)}
        ${parts.length ? `<div class="trk-sit">${parts.join(' · ')}</div>` : ''}
        ${wp}
        ${s && s.lastPlay ? `<p class="trk-play" title="${esc(s.lastPlay)}">${esc(s.lastPlay)}</p>` : ''}
      </li>`;
  }

  function draw() {
    const rank = { in: 0, pre: 1, post: 2 };
    const list = [...ids].map((id) => games.get(id)).filter(Boolean)
      .sort((a, b) => rank[a.state] - rank[b.state] || a.kickoff - b.kickoff);
    show(list.length > 0);
    $('trk-list').innerHTML = list.map(gameItem).join('');
    $('trk-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
  }

  async function refresh() {
    clearTimeout(timer);
    if (!ids.size) { show(false); return; }
    let week;
    try {
      week = await Football.thisWeek();
    } catch {
      timer = setTimeout(refresh, IDLE_MS);
      return;
    }
    games = new Map(week.games.map((g) => [String(g.id), g]));
    // A tracked game that's no longer on the scoreboard is from a past week: let it go.
    const stale = [...ids].filter((id) => !games.has(id));
    if (stale.length) { stale.forEach((id) => ids.delete(id)); save(); syncButtons(); }
    draw();
    const live = [...ids].some((id) => games.get(id).state === 'in' || games.get(id).kickoff <= Date.now());
    timer = setTimeout(refresh, live ? LIVE_MS : IDLE_MS);
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-track]');
    if (t) { setTracked(t.dataset.track, !isTracked(t.dataset.track)); return; }
    const x = e.target.closest('[data-untrack]');
    if (x) setTracked(x.dataset.untrack, false);
  });
  $('trk-clear').addEventListener('click', () => {
    ids.clear();
    save();
    syncButtons();
    refresh();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ids.size) refresh(); });

  refresh();
  return { button, isTracked };
})();
