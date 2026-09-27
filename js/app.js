// UI wiring: location, ledger storage, and rendering of each card.
(() => {
  const STORAGE_KEY = 'almanac-gameday.v1';
  // The Farmers' Almanac's home base, used until you pick your own spot.
  const DEFAULT_LOCATION = { name: 'Lewiston, Maine, US', lat: 44.1004, lon: -70.2148 };

  const SOURCES = {
    almanac: { label: "Farmers' Almanac", color: 'var(--s1)' },
    mine: { label: 'My call', color: 'var(--s2)' },
    lore: { label: 'Folklore sign', color: 'var(--s3)' },
    model: { label: 'Weather model', color: 'var(--s4)' },
  };
  const TEMP_WORD = { above: 'Warmer', normal: 'Normal', below: 'Colder' };
  const PRECIP_WORD = { above: 'Wetter', normal: 'Normal', below: 'Drier' };

  const FORECAST_SERIES = [
    { key: 'tmax', label: 'Forecast high', color: 'var(--warm)' },
    { key: 'nmax', label: 'Normal high', color: 'var(--warm)', dashed: true },
    { key: 'tmin', label: 'Forecast low', color: 'var(--cool)' },
    { key: 'nmin', label: 'Normal low', color: 'var(--cool)', dashed: true },
  ];
  const actualSeries = (lead) => [
    { key: 'ahi', label: 'Actual high', color: 'var(--warm)' },
    { key: 'fhi', label: `Forecast high (${aheadText(lead)})`, color: 'var(--warm)', dashed: true },
    { key: 'alo', label: 'Actual low', color: 'var(--cool)' },
    { key: 'flo', label: `Forecast low (${aheadText(lead)})`, color: 'var(--cool)', dashed: true },
  ];
  const DEFAULT_VIEW = { lead: 1, range: 90 };

  const LORE = [
    ['Red sky at night, sailor’s delight; red sky at morning, sailors take warning.', 'Traditional'],
    ['Clear moon, frost soon.', 'Traditional'],
    ['Ring around the moon, rain real soon.', 'Traditional'],
    ['When the dew is on the grass, rain will never come to pass.', 'Traditional'],
    ['Mackerel sky and mares’ tails make tall ships carry low sails.', 'Sailors’ lore'],
    ['Onion skins very thin, mild winter coming in; onion skins thick and tough, coming winter cold and rough.', 'Farm lore'],
    ['When leaves show their undersides, be very sure that rain betides.', 'Traditional'],
    ['Year of snow, crops will grow.', 'Farm lore'],
    ['If the goose honks high, fair weather; if the goose honks low, foul weather.', 'Farm lore'],
  ];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const aheadText = (k) => `${k} day${k === 1 ? '' : 's'} ahead`;
  const signed = (v, digits = 0) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;

  let state = load();
  let data = null;       // { hist, fc } for the current location
  let verif = { status: 'loading' }; // past forecasts for the forecast-vs-actual cards
  let loadToken = 0;
  let chartRows = null;
  let vaRows = null;

  function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { /* storage unavailable or corrupt */ }
    if (!saved || !Array.isArray(saved.projections)) saved = { location: DEFAULT_LOCATION, projections: [] };
    saved.view = { ...DEFAULT_VIEW, ...saved.view };
    return saved;
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* non-fatal */ }
  }

  const setStatus = (msg, isError = false) => {
    $('status').textContent = msg;
    $('status').classList.toggle('error', isError);
  };

  // ---------- Data load ----------

  async function refresh() {
    const loc = state.location;
    const token = ++loadToken; // ignore results from a location the user has since switched away from
    $('loc-name').textContent = loc.name;
    Radar.setLocation(loc);
    setStatus(`Loading 12 years of weather for ${loc.name}…`);

    verif = { status: 'loading' };
    renderVerify();
    const pastForecasts = Verify.forecasts(loc, Dates.today()).then(
      (fc) => { if (token === loadToken) verif = { status: 'ready', fc }; },
      (err) => { if (token === loadToken) verif = { status: 'error', message: err.message }; },
    );

    try {
      const [hist, fc] = await Promise.all([Weather.history(loc), Weather.forecast(loc)]);
      if (token !== loadToken) return;
      data = { hist, fc };
      setStatus('');
      renderAll();
    } catch (err) {
      if (token !== loadToken) return;
      setStatus(navigator.onLine
        ? `Couldn't load weather data (${err.message}). Try again in a bit.`
        : `You're offline, and there's no saved weather for ${loc.name} yet. Your ledger is safe; scores fill in once you're back online.`, true);
    }
    await pastForecasts;
    if (token === loadToken) renderVerify();
  }

  function renderAll() {
    if (!data) return;
    const results = new Map(state.projections.map((p) => [p.id, Scoring.evaluate(p, data.hist, data.fc)]));
    renderChart();
    renderVerify();
    renderLedger(results);
  }

  // ---------- 16-day forecast chart ----------

  function forecastTip(r) {
    const vsNormal = (v, n) => (n == null ? '' : ` <span class="muted">(${signed(v - n)}° vs normal)</span>`);
    return `<strong>${Dates.weekday(r.date)} ${Dates.short(r.date)}</strong>
      <div>High ${Math.round(r.tmax)}°${vsNormal(r.tmax, r.nmax)}</div>
      <div>Low ${Math.round(r.tmin)}°${vsNormal(r.tmin, r.nmin)}</div>
      <div>Precip ${r.precip.toFixed(2)}″${r.snow > 0.05 ? ` · Snow ${r.snow.toFixed(1)}″` : ''}</div>`;
  }

  function drawForecastChart() {
    if (!chartRows?.length) return;
    Chart.render($('fc-chart'), chartRows, {
      series: FORECAST_SERIES, tooltip: $('tooltip'), tip: forecastTip,
      xLabel: (r, i) => (i === 0 ? 'Today' : Dates.short(r.date)),
      ariaLabel: 'Line chart of forecast high and low temperatures against 10-year normals for the next 16 days',
    });
  }

  function renderChart() {
    const today = Dates.today();
    chartRows = Object.keys(data.fc).sort().filter((d) => d >= today).map((date) => {
      const n = Scoring.dailyNormal(data.hist, date);
      return { date, ...data.fc[date], nmax: n?.tmax ?? null, nmin: n?.tmin ?? null };
    });
    drawForecastChart();
  }

  // ---------- Forecast vs. actual ----------

  function verifyWindow() {
    const today = Dates.today();
    const start = Verify.historyStart(today);
    const to = Dates.addDays(today, -1);
    const from = state.view.range === 'all' ? start : Dates.addDays(today, -state.view.range);
    return { from: from < start ? start : from, to, start };
  }

  function rainWord(d) {
    return d.precip >= Verify.WET ? `rain ${d.precip.toFixed(2)}″` : 'dry';
  }

  function actualTip(r) {
    const line = (name, a, f) => (a == null
      ? `<div>${name} <span class="muted">no data</span></div>`
      : `<div>${name} ${Math.round(a)}°${f == null ? '' : ` · forecast ${Math.round(f)}° <span class="muted">(${signed(f - a)}°)</span>`}</div>`);
    const rain = r.actualDay && r.forecastDay
      ? `<div>Actual ${rainWord(r.actualDay)} · forecast ${rainWord(r.forecastDay)}
          ${(r.actualDay.precip >= Verify.WET) === (r.forecastDay.precip >= Verify.WET) ? '✓' : '✗'}</div>` : '';
    return `<strong>${Dates.weekday(r.date)} ${Dates.shortYear(r.date)}</strong>
      ${line('High', r.ahi, r.fhi)}${line('Low', r.alo, r.flo)}${rain}`;
  }

  function drawActualChart() {
    if (!vaRows?.length) return;
    Chart.render($('va-chart'), vaRows, {
      series: actualSeries(state.view.lead), tooltip: $('tooltip'), tip: actualTip,
      xLabel: (r) => Dates.short(r.date),
      ariaLabel: `Line chart of actual daily high and low temperatures against the forecast made ${aheadText(state.view.lead)}`,
    });
  }

  function tile(label, value, detail) {
    return `<div class="tile"><span class="tile-label">${label}</span><strong class="tile-value">${value}</strong><span class="tile-detail">${detail}</span></div>`;
  }

  function leanPhrase(bias) {
    return Math.abs(bias) < 0.3 ? 'No lean' : `${Math.abs(bias).toFixed(1)}° ${bias > 0 ? 'warm' : 'cold'}`;
  }

  function renderVerify() {
    $('va-lead').value = state.view.lead;
    $('va-range').querySelectorAll('button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.days === String(state.view.range))));

    const waiting = verif.status !== 'ready' || !data;
    if (waiting) {
      const msg = verif.status === 'error'
        ? `Couldn't load past forecasts (${esc(verif.message)}). They'll load next time the app opens online.`
        : 'Loading 6 months of past forecasts…';
      $('va-tiles').innerHTML = `<p class="empty-note">${msg}</p>`;
      $('lead-table').innerHTML = `<p class="empty-note">${msg}</p>`;
      for (const id of ['va-chart', 'va-legend', 'va-months']) $(id).innerHTML = '';
      $('lead-range').textContent = '';
      vaRows = null;
      return;
    }

    const actual = { ...data.fc, ...data.hist.days };
    const { from, to, start } = verifyWindow();
    const lead = state.view.lead;
    const rangeText = `${Dates.short(from)} – ${Dates.shortYear(to)}`;

    // Accuracy by lead time
    const byLead = Verify.LEADS.map((k) => ({ k, s: Verify.summarize(Verify.pairs(verif.fc, actual, k, from, to)) }));
    const worst = Math.max(...byLead.map((x) => (x.s ? x.s.tempMiss : 0)), 0.1);
    $('lead-range').textContent = rangeText;
    $('lead-table').innerHTML = byLead.map(({ k, s }) => (s ? `
      <button type="button" class="lead-row${k === lead ? ' on' : ''}" data-lead="${k}" aria-pressed="${k === lead}">
        <span class="lead-name">${aheadText(k)}</span>
        <span class="lead-bar" aria-hidden="true"><i style="width:${(s.tempMiss / worst) * 100}%"></i></span>
        <strong>±${s.tempMiss.toFixed(1)}°</strong>
        <span class="muted small">${Math.round((s.rainRight / s.n) * 100)}% rain right</span>
      </button>` : '')).join('');

    // Headline tiles for the chosen lead
    const rows = Verify.pairs(verif.fc, actual, lead, from, to);
    const s = Verify.summarize(rows);
    if (!s) {
      $('va-tiles').innerHTML = '<p class="empty-note">No overlapping forecast and observed days in this range.</p>';
      $('va-chart').innerHTML = '';
      vaRows = null;
    } else {
      $('va-tiles').innerHTML = [
        tile('Highs', `±${s.highMiss.toFixed(1)}°`, 'average miss'),
        tile('Lows', `±${s.lowMiss.toFixed(1)}°`, 'average miss'),
        tile('Within 3°', `${Math.round((s.within3 / s.n) * 100)}%`, `${s.within3} of ${s.n} days, high and low`),
        tile('Leaning', leanPhrase(s.bias), 'forecast vs. actual, on average'),
        tile('Rain called right', `${s.rainRight} / ${s.n}`, `${s.rainMissed} missed · ${s.falseAlarms} false alarm${s.falseAlarms === 1 ? '' : 's'}`),
      ].join('');
      vaRows = rows.map((r) => ({
        date: r.date,
        ahi: r.actual?.tmax ?? null, alo: r.actual?.tmin ?? null,
        fhi: r.forecast?.tmax ?? null, flo: r.forecast?.tmin ?? null,
        actualDay: r.actual, forecastDay: r.forecast,
      }));
      Chart.legend($('va-legend'), actualSeries(lead));
      drawActualChart();
    }

    // Month by month, always over the full 6 months so seasons can be compared
    const months = Verify.byMonth(Verify.pairs(verif.fc, actual, lead, start, to));
    $('va-months').innerHTML = `
      <table class="num">
        <thead><tr><th>Month</th><th>Highs</th><th>Lows</th><th>Within 3°</th><th>Leaning</th><th>Rain right</th><th>Days</th></tr></thead>
        <tbody>${months.map(({ month, summary: m }) => `
          <tr>
            <td>${new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })}</td>
            <td>±${m.highMiss.toFixed(1)}°</td>
            <td>±${m.lowMiss.toFixed(1)}°</td>
            <td>${Math.round((m.within3 / m.n) * 100)}%</td>
            <td>${leanPhrase(m.bias)}</td>
            <td>${Math.round((m.rainRight / m.n) * 100)}%</td>
            <td>${m.n}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  $('va-lead').innerHTML = Verify.LEADS.map((k) => `<option value="${k}">${aheadText(k)}</option>`).join('');
  $('va-lead').addEventListener('change', (e) => setView({ lead: Number(e.target.value) }));
  $('lead-table').addEventListener('click', (e) => {
    const row = e.target.closest('[data-lead]');
    if (row) setView({ lead: Number(row.dataset.lead) });
  });
  $('va-range').addEventListener('click', (e) => {
    const b = e.target.closest('[data-days]');
    if (b) setView({ range: b.dataset.days === 'all' ? 'all' : Number(b.dataset.days) });
  });

  function setView(change) {
    state.view = { ...state.view, ...change };
    save();
    renderVerify();
  }

  // ---------- Ledger ----------

  function describeCall(p) {
    const parts = [];
    if (p.temp) parts.push(TEMP_WORD[p.temp]);
    if (p.precip) parts.push(PRECIP_WORD[p.precip]);
    return parts.join(' · ') || '—';
  }

  function describeVerdict(v) {
    const t = `${TEMP_WORD[v.temp]} (${v.tempAnom >= 0 ? '+' : '−'}${Math.abs(v.tempAnom).toFixed(1)}°)`;
    const p = `${PRECIP_WORD[v.precip]}${v.precipPct == null ? '' : ` (${Math.round(v.precipPct)}%)`}`;
    const s = v.snow >= 0.5 ? ` · ${v.snow.toFixed(1)}″ snow` : '';
    return `${t} · ${p}${s}`;
  }

  function badge(r) {
    switch (r.status) {
      case 'verified':
        if (r.points === null) return '<span class="badge">Scored — no call</span>';
        if (r.points === 1) return '<span class="badge good">✓ Hit</span>';
        if (r.points === 0) return '<span class="badge bad">✗ Miss</span>';
        return `<span class="badge part">◐ ${r.points.toFixed(2)}</span>`;
      case 'tracking': return `<span class="badge live">● Tracking ${Math.round(r.coverage * 100)}%</span>`;
      case 'nodata': return '<span class="badge">No data</span>';
      default: return '<span class="badge">Waiting</span>';
    }
  }

  function renderLedger(results) {
    if (!state.projections.length) {
      $('ledger').innerHTML = '<p class="empty-note">No projections yet. Log the model’s call, import a saved ledger, or load the example entries to see how scoring works.</p>';
      return;
    }
    const rows = [...state.projections].sort((a, b) => b.start.localeCompare(a.start)).map((p) => {
      const r = results.get(p.id);
      const src = SOURCES[p.source];
      const outcome = r.verdict
        ? `${r.status === 'tracking' ? '<span class="muted">So far:</span> ' : ''}${describeVerdict(r.verdict)}`
        : '<span class="muted">—</span>';
      return `
        <tr>
          <td><span class="src"><i style="background:${src.color}"></i>${src.label}</span></td>
          <td>${esc(p.label)}</td>
          <td class="nowrap">${Dates.short(p.start)} – ${Dates.shortYear(p.end)}</td>
          <td>${describeCall(p)}</td>
          <td>${outcome}</td>
          <td>${badge(r)}</td>
          <td><button class="icon" data-del="${esc(p.id)}" aria-label="Delete projection">×</button></td>
        </tr>`;
    }).join('');
    $('ledger').innerHTML = `
      <table>
        <thead><tr><th>Source</th><th>Projection</th><th>Window</th><th>Called</th><th>What happened</th><th>Score</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // ---------- Actions ----------

  $('log-model').addEventListener('click', () => {
    if (!data) return;
    const today = Dates.today();
    let added = 0;
    for (const [from, to, name] of [[1, 7, 'days 1–7'], [8, 14, 'days 8–14']]) {
      const start = Dates.addDays(today, from);
      const end = Dates.addDays(today, to);
      const call = Scoring.modelCall(data.hist, data.fc, start, end);
      if (!call) continue;
      state.projections.push({ id: newId(), created: today, source: 'model',
        label: `Model snapshot, ${name} (logged ${Dates.short(today)})`, start, end, temp: call.temp, precip: call.precip });
      added++;
    }
    save();
    renderAll();
    setStatus(added ? `Logged ${added} model calls — they'll be scored once the days pass.` : 'Not enough forecast data to log a model call.', !added);
  });

  $('ledger').addEventListener('click', (e) => {
    const id = e.target.closest('[data-del]')?.dataset.del;
    if (!id) return;
    state.projections = state.projections.filter((p) => p.id !== id);
    save();
    renderAll();
  });

  $('clear-all').addEventListener('click', () => {
    if (!state.projections.length || !confirm('Remove every projection from the ledger?')) return;
    state.projections = [];
    save();
    renderAll();
  });

  // Export / import: a JSON backup, and the way to move a ledger between browsers or the installed app.
  $('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ app: 'almanac-ledger', version: 1, ...state }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `almanac-ledger-${Dates.today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const CALLS = [null, undefined, '', 'above', 'normal', 'below'];

  // Imported files are untrusted: every field must have the exact shape the app writes itself.
  function isValidProjection(p) {
    return p && typeof p === 'object'
      && typeof p.id === 'string' && /^[\w-]{1,64}$/.test(p.id)
      && Object.prototype.hasOwnProperty.call(SOURCES, p.source)
      && typeof p.label === 'string' && p.label.length <= 200
      && typeof p.start === 'string' && DATE_RE.test(p.start)
      && typeof p.end === 'string' && DATE_RE.test(p.end) && p.end >= p.start
      && CALLS.includes(p.temp) && CALLS.includes(p.precip)
      && (p.temp || p.precip);
  }

  $('import').addEventListener('click', () => $('import-file').click());

  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const incoming = JSON.parse(await file.text());
      if (!Array.isArray(incoming.projections)) throw new Error('no projections found');
      const valid = incoming.projections.filter(isValidProjection).map((p) => ({
        // Keep only known fields so nothing unexpected rides along into storage.
        id: p.id, created: typeof p.created === 'string' && DATE_RE.test(p.created) ? p.created : Dates.today(),
        source: p.source, label: p.label, start: p.start, end: p.end, temp: p.temp || null, precip: p.precip || null,
      }));
      const have = new Set(state.projections.map((p) => p.id));
      const added = valid.filter((p) => !have.has(p.id));
      state.projections.push(...added);
      save();
      renderAll();
      const notes = [];
      if (valid.length > added.length) notes.push(`${valid.length - added.length} already in the ledger`);
      const invalid = incoming.projections.length - valid.length;
      if (invalid) notes.push(`${invalid} skipped as invalid`);
      setStatus(`Imported ${added.length} projection${added.length === 1 ? '' : 's'}${notes.length ? ` (${notes.join(', ')})` : ''}.`);
    } catch (err) {
      setStatus(`That file couldn't be imported (${err.message}).`, true);
    }
  });

  // Example entries: made-up calls placed on recent months (already scorable) and upcoming ones (still waiting).
  $('load-example').addEventListener('click', () => {
    if (!data) return;
    const [y, m] = data.hist.lastDate.split('-').map(Number);
    const month = (offset) => {
      const d = new Date(Date.UTC(y, m - 1 + offset, 1));
      const start = d.toISOString().slice(0, 10);
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      const name = d.toLocaleDateString(undefined, { month: 'long', timeZone: 'UTC' });
      return { start, end, name };
    };
    const ex = [
      ['almanac', -4, 'above', 'normal', 'hot, humid'], ['almanac', -3, 'normal', 'above', 'stormy'],
      ['almanac', -2, 'below', 'below', 'cool, fair'], ['almanac', -1, 'above', 'above', 'warm, thunderstorms'],
      ['mine', -3, 'above', 'normal', 'feels like a hot one'], ['mine', -2, 'normal', 'normal', 'nothing unusual'],
      ['mine', -1, 'below', 'above', 'early chill, soggy'],
      ['lore', -2, null, 'above', 'thick onion skins'],
      ['almanac', 1, 'below', 'above', 'cold, wet'], ['mine', 1, 'normal', 'above', 'rainy stretch'],
      ['lore', 1, 'below', null, 'geese flying south early'],
      ['almanac', 2, 'below', 'normal', 'frosty, then fair'],
    ];
    for (const [source, off, temp, precip, words] of ex) {
      const w = month(off);
      state.projections.push({ id: newId(), created: Dates.today(), source, start: w.start, end: w.end, temp, precip,
        label: `Example: ${w.name} — “${words}”` });
    }
    save();
    renderAll();
    setStatus('Loaded example entries. They’re invented calls — swap in real ones from your almanac.');
  });

  // ---------- DAKboard display setup ----------

  // The display must load from a public HTTPS address: this site if it's already hosted, otherwise the
  // published copy from config.js. Returns null when neither exists (e.g. the desktop .exe before deploying).
  function displayBase() {
    const local = location.protocol !== 'https:' || /(^localhost$|\.local$)/.test(location.hostname);
    if (!local) return new URL('display.html', location.href).href;
    if (CONFIG.publicSite) return new URL('display.html', CONFIG.publicSite).href;
    return null;
  }

  function displayUrl() {
    const loc = state.location;
    const panels = [...document.querySelectorAll('.dd-panels input:checked')].map((i) => i.value);
    const params = new URLSearchParams({
      lat: loc.lat.toFixed(4), lon: loc.lon.toFixed(4), name: loc.name,
      panels: panels.join(','), theme: $('dd-theme').value,
      lead: $('dd-lead').value, days: $('dd-days').value, zoom: $('dd-zoom').value,
    });
    const base = displayBase();
    return { base, url: `${base || new URL('display.html', location.href).href}?${params}`, panels };
  }

  function updateDisplayUrl() {
    const { base, url, panels } = displayUrl();
    $('dd-url').value = url;
    $('dd-copy').disabled = !base || !panels.length;
    $('dd-preview').disabled = !panels.length || (!base && location.protocol === 'https:');
    $('dd-note').textContent = !panels.length ? 'Pick at least one panel.'
      : base ? 'The display refreshes itself: radar every 5 minutes, weather every 30, and a full reload daily around 3 a.m.'
      : 'The site isn’t published yet, so DAKboard can’t reach this address. Run deploy.ps1 (see the README), then reopen this.';
  }

  $('dd-lead').innerHTML = Verify.LEADS.map((k) => `<option value="${k}">${aheadText(k)}</option>`).join('');
  $('open-display').addEventListener('click', () => {
    $('dd-place').textContent = state.location.name;
    updateDisplayUrl();
    $('display-dialog').showModal();
  });
  $('display-dialog').addEventListener('change', updateDisplayUrl);
  $('dd-close').addEventListener('click', () => $('display-dialog').close());
  $('dd-copy').addEventListener('click', async () => {
    const url = $('dd-url').value;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      $('dd-url').select();
      document.execCommand('copy');
    }
    $('dd-copy').textContent = 'Copied ✓';
    setTimeout(() => { $('dd-copy').textContent = 'Copy address'; }, 1800);
  });
  $('dd-preview').addEventListener('click', () => window.open($('dd-url').value, '_blank', 'noopener'));

  // ---------- Location search ----------

  $('loc-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('loc-input').value.trim();
    if (!q) return;
    const list = $('loc-results');
    try {
      const results = await Weather.geocode(q);
      list.innerHTML = results.length
        ? results.map((r, i) => `<li><button type="button" data-i="${i}">${esc(r.name)}</button></li>`).join('')
        : '<li class="muted">No matches</li>';
      list.hidden = false;
      list.onclick = (ev) => {
        const i = ev.target.closest('[data-i]')?.dataset.i;
        if (i == null) return;
        state.location = results[i];
        save();
        list.hidden = true;
        $('loc-input').value = '';
        refresh();
      };
    } catch (err) {
      setStatus(`Location search failed (${err.message}).`, true);
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#loc-form')) $('loc-results').hidden = true;
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { drawForecastChart(); drawActualChart(); }, 150);
  });

  // ---------- Boot ----------

  const [quote, who] = LORE[Math.floor(Math.random() * LORE.length)];
  $('lore').innerHTML = `“${esc(quote)}” <cite>— ${who}</cite>`;
  Chart.legend($('fc-legend'), FORECAST_SERIES);
  Radar.mount($('radar'));
  refresh();

  // The desktop .exe (WebView2) serves files from inside itself, so it skips the offline cache;
  // a cache there would keep serving old files after a rebuild.
  const inDesktopShell = !!(window.chrome && window.chrome.webview);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !inDesktopShell) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works, just not offline */ });
  }
})();
