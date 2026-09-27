// Wall-display view (DAKboard Website/iframe block and similar): hands-off, sized to its frame,
// configured by URL parameters, and refreshes its own data on a schedule.
(() => {
  const PANELS = {
    radar: 'Radar',
    forecast: 'Next 16 days',
    accuracy: 'Forecast accuracy',
    actual: 'Forecast vs. actual',
  };
  const DEFAULT_PANELS = ['radar', 'accuracy', 'actual'];
  const DATA_REFRESH_MS = 30 * 60 * 1000;
  const RELOAD_HOUR = 3;      // reload the whole page daily around 3 a.m. to pick up app updates

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v))}`;

  // ---------- Settings from the URL (untrusted: every value is range-checked) ----------

  const q = new URLSearchParams(location.search);
  const number = (key, fallback) => {
    const v = parseFloat(q.get(key));
    return Number.isFinite(v) ? v : fallback;
  };
  const loc = {
    lat: clamp(number('lat', 44.1004), -85, 85),
    lon: clamp(number('lon', -70.2148), -180, 180),
    name: (q.get('name') || 'Lewiston, Maine').slice(0, 60),
  };
  const requested = (q.get('panels') || '').split(',').map((p) => p.trim()).filter((p) => PANELS[p]);
  const panels = requested.length ? [...new Set(requested)] : DEFAULT_PANELS;
  const theme = ['dark', 'light', 'transparent'].includes(q.get('theme')) ? q.get('theme') : 'auto';
  const lead = clamp(Math.round(number('lead', 1)), 1, 7);
  const days = clamp(Math.round(number('days', 30)), 7, 180);
  const zoom = clamp(Math.round(number('zoom', 6)), 3, 7);

  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  if (theme === 'transparent') {
    document.documentElement.dataset.theme = 'dark';
    document.body.classList.add('transparent');
  }

  // ---------- Layout ----------

  const board = $('board');
  board.dataset.count = panels.length;
  board.classList.toggle('lead-radar', panels[0] === 'radar' && panels.length === 3);
  board.innerHTML = panels.map((p) => `
    <section class="panel" data-panel="${p}">
      <h2 class="panel-title">${PANELS[p]}<span class="panel-sub" id="sub-${p}"></span></h2>
      <div class="panel-body" id="body-${p}"></div>
    </section>`).join('');
  $('d-place').textContent = loc.name;

  if (panels.includes('radar')) {
    Radar.mount($('body-radar'), { kiosk: true, zoom });
    Radar.setLocation(loc);
  }

  // ---------- Data ----------

  let hist = null;            // 12-year history, only fetched if the 16-day panel needs normals
  let fc = null;              // forecast incl. the last 7 days
  let recent = null;          // observed days covering the accuracy window
  let pastFc = null;          // what forecasts said 1–7 days ahead
  let lastOk = null;

  const needsHistory = panels.includes('forecast');
  const needsVerify = panels.includes('accuracy') || panels.includes('actual');

  async function load() {
    const today = Dates.today();
    const from = Dates.addDays(today, -days);
    const jobs = [Weather.forecast(loc).then((d) => { fc = d; })];
    if (needsVerify) {
      jobs.push(Weather.recent(loc, Dates.addDays(from, -1)).then((d) => { recent = d; }));
      jobs.push(Verify.forecasts(loc, today, from).then((d) => { pastFc = d; }));
    }
    if (needsHistory && (!hist || hist.fetched !== today)) {
      jobs.push(Weather.history(loc).then((d) => { hist = { ...d, fetched: today }; }));
    }
    const results = await Promise.allSettled(jobs);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed < results.length) lastOk = new Date();
    setStatus(failed);
    renderAll();
  }

  function setStatus(failed) {
    const time = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const el = $('d-status');
    if (!lastOk) el.textContent = failed ? 'Weather data unavailable — retrying' : 'Loading…';
    else el.textContent = `${failed ? 'Some data unavailable · last good ' : 'Updated '}${time(lastOk)}`;
    el.classList.toggle('warn', !!failed);
  }

  // ---------- Panels ----------

  function renderAll() {
    if (panels.includes('accuracy')) renderAccuracy();
    if (panels.includes('actual')) renderActual();
    if (panels.includes('forecast')) renderForecast();
  }

  function waiting(id) {
    $(id).innerHTML = '<p class="panel-wait">Loading…</p>';
  }

  function verifyRows(k) {
    const today = Dates.today();
    const actual = { ...fc, ...recent };
    return Verify.pairs(pastFc, actual, k, Dates.addDays(today, -days), Dates.addDays(today, -1));
  }

  function renderAccuracy() {
    if (!pastFc || !recent || !fc) return waiting('body-accuracy');
    const s = Verify.summarize(verifyRows(lead));
    $('sub-accuracy').textContent = ` · last ${days} days`;
    if (!s) { $('body-accuracy').innerHTML = '<p class="panel-wait">No data yet</p>'; return; }
    const byLead = Verify.LEADS.map((k) => ({ k, s: Verify.summarize(verifyRows(k)) })).filter((x) => x.s);
    const worst = Math.max(...byLead.map((x) => x.s.tempMiss), 0.1);
    const pct = (a, b) => `${Math.round((a / b) * 100)}%`;
    $('body-accuracy').innerHTML = `
      <p class="acc-caption">Forecasts made ${lead} day${lead === 1 ? '' : 's'} ahead</p>
      <div class="d-tiles">
        <div class="d-tile"><span>Highs</span><strong>±${s.highMiss.toFixed(1)}°</strong></div>
        <div class="d-tile"><span>Lows</span><strong>±${s.lowMiss.toFixed(1)}°</strong></div>
        <div class="d-tile"><span>Within 3°</span><strong>${pct(s.within3, s.n)}</strong></div>
        <div class="d-tile"><span>Rain right</span><strong>${pct(s.rainRight, s.n)}</strong></div>
      </div>
      <div class="d-leads" aria-label="Average miss by days ahead">
        ${byLead.map(({ k, s: x }) => `
          <div class="d-lead${k === lead ? ' on' : ''}">
            <span>${k}d</span><span class="lead-bar"><i style="width:${(x.tempMiss / worst) * 100}%"></i></span><b>±${x.tempMiss.toFixed(1)}°</b>
          </div>`).join('')}
      </div>`;
  }

  const actualSeries = [
    { key: 'ahi', label: 'Actual high', color: 'var(--warm)' },
    { key: 'fhi', label: 'Forecast high', color: 'var(--warm)', dashed: true },
    { key: 'alo', label: 'Actual low', color: 'var(--cool)' },
    { key: 'flo', label: 'Forecast low', color: 'var(--cool)', dashed: true },
  ];

  function renderActual() {
    const body = $('body-actual');
    if (!pastFc || !recent || !fc) return waiting('body-actual');
    $('sub-actual').textContent = ` · ${lead} day${lead === 1 ? '' : 's'} ahead, last ${days} days`;
    const rows = verifyRows(lead).map((r) => ({
      date: r.date,
      ahi: r.actual ? r.actual.tmax : null, alo: r.actual ? r.actual.tmin : null,
      fhi: r.forecast ? r.forecast.tmax : null, flo: r.forecast ? r.forecast.tmin : null,
    }));
    body.innerHTML = '<div class="legend d-legend"></div><div class="chart d-chart"></div>';
    Chart.legend(body.querySelector('.d-legend'), actualSeries);
    const chartEl = body.querySelector('.d-chart');
    Chart.render(chartEl, rows, {
      series: actualSeries, tooltip: $('tooltip'), height: chartEl.clientHeight,
      tip: (r) => `<strong>${Dates.short(r.date)}</strong><div>High ${r.ahi == null ? '—' : Math.round(r.ahi) + '°'} · forecast ${r.fhi == null ? '—' : Math.round(r.fhi) + '°'}</div><div>Low ${r.alo == null ? '—' : Math.round(r.alo) + '°'} · forecast ${r.flo == null ? '—' : Math.round(r.flo) + '°'}</div>`,
      xLabel: (r) => Dates.short(r.date),
      ariaLabel: `Actual daily highs and lows against the forecast made ${lead} days ahead, last ${days} days`,
    });
  }

  const forecastSeries = [
    { key: 'tmax', label: 'High', color: 'var(--warm)' },
    { key: 'nmax', label: 'Normal high', color: 'var(--warm)', dashed: true },
    { key: 'tmin', label: 'Low', color: 'var(--cool)' },
    { key: 'nmin', label: 'Normal low', color: 'var(--cool)', dashed: true },
  ];

  function renderForecast() {
    const body = $('body-forecast');
    if (!fc) return waiting('body-forecast');
    const today = Dates.today();
    const rows = Object.keys(fc).sort().filter((d) => d >= today).map((date) => {
      const n = hist ? Scoring.dailyNormal(hist, date) : null;
      return { date, ...fc[date], nmax: n ? n.tmax : null, nmin: n ? n.tmin : null };
    });
    body.innerHTML = '<div class="legend d-legend"></div><div class="chart d-chart"></div>';
    Chart.legend(body.querySelector('.d-legend'), hist ? forecastSeries : forecastSeries.filter((s) => !s.dashed));
    const chartEl = body.querySelector('.d-chart');
    Chart.render(chartEl, rows, {
      series: forecastSeries, tooltip: $('tooltip'), height: chartEl.clientHeight,
      tip: (r) => `<strong>${Dates.weekday(r.date)} ${Dates.short(r.date)}</strong><div>High ${Math.round(r.tmax)}°${r.nmax == null ? '' : ` (${signed(r.tmax - r.nmax)}° vs normal)`}</div><div>Low ${Math.round(r.tmin)}°</div>`,
      xLabel: (r, i) => (i === 0 ? 'Today' : Dates.short(r.date)),
      ariaLabel: 'Forecast highs and lows for the next 16 days against normal',
    });
  }

  // ---------- Schedule ----------

  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderAll, 200);
  }).observe(board);

  setInterval(load, DATA_REFRESH_MS);

  // Reload the page once a day (default: next 3 a.m.) so the display picks up app updates and starts fresh.
  const next = new Date();
  next.setHours(RELOAD_HOUR, 0, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  setTimeout(() => location.reload(), next - new Date());

  panels.filter((p) => p !== 'radar').forEach((p) => waiting(`body-${p}`));
  setStatus(0);
  load();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* fine without offline support */ });
  }
})();
