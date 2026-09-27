// Forecast verification: what past forecasts said (1–7 days ahead) versus what actually happened.
// Open-Meteo's Previous Runs API keeps each day's forecast as issued N days earlier, so months
// of history are available immediately instead of having to be collected.
const Verify = (() => {
  const API = 'https://previous-runs-api.open-meteo.com/v1/forecast';
  const LEADS = [1, 2, 3, 4, 5, 6, 7];
  const HISTORY_MONTHS = 6;
  const WET = 0.04; // inches in a day that count as "it rained"

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  // Hourly values -> { 'YYYY-MM-DD': { tmax, tmin, precip } } for complete local days.
  function dailyFromHourly(times, temps, precips) {
    const days = {};
    times.forEach((t, i) => {
      if (temps[i] == null) return;
      const date = t.slice(0, 10);
      const d = (days[date] ??= { tmax: -Infinity, tmin: Infinity, precip: 0, hours: 0 });
      d.tmax = Math.max(d.tmax, temps[i]);
      d.tmin = Math.min(d.tmin, temps[i]);
      d.precip += precips[i] ?? 0;
      d.hours++;
    });
    for (const date of Object.keys(days)) {
      if (days[date].hours < 20) delete days[date];
      else delete days[date].hours;
    }
    return days;
  }

  function historyStart(today) {
    const [y, m, d] = today.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 - HISTORY_MONTHS, d)).toISOString().slice(0, 10);
  }

  // -> { [lead]: { [date]: { tmax, tmin, precip } } } from `start` (default: HISTORY_MONTHS ago) to yesterday.
  async function forecasts(loc, today, start = historyStart(today)) {
    const vars = LEADS.flatMap((k) => [`temperature_2m_previous_day${k}`, `precipitation_previous_day${k}`]).join(',');
    const url = `${API}?latitude=${loc.lat}&longitude=${loc.lon}&hourly=${vars}`
      + `&start_date=${start}&end_date=${Dates.addDays(today, -1)}`
      + '&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=auto';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    const { hourly } = await res.json();
    const out = {};
    for (const k of LEADS) {
      out[k] = dailyFromHourly(hourly.time, hourly[`temperature_2m_previous_day${k}`], hourly[`precipitation_previous_day${k}`]);
    }
    return out;
  }

  // One row per day in [from, to]: the actual weather and what was forecast `lead` days before it.
  function pairs(fcByLead, actual, lead, from, to) {
    const fc = fcByLead[lead] || {};
    return Dates.range(from, to).map((date) => ({ date, actual: actual[date] || null, forecast: fc[date] || null }));
  }

  function summarize(rows) {
    const both = rows.filter((r) => r.actual && r.forecast);
    if (!both.length) return null;
    const hiErr = both.map((r) => r.forecast.tmax - r.actual.tmax);
    const loErr = both.map((r) => r.forecast.tmin - r.actual.tmin);
    const wet = (d) => d.precip >= WET;
    return {
      n: both.length,
      highMiss: mean(hiErr.map(Math.abs)),
      lowMiss: mean(loErr.map(Math.abs)),
      tempMiss: mean([...hiErr, ...loErr].map(Math.abs)),
      bias: mean([...hiErr, ...loErr]),                 // + means forecasts ran warm
      within3: both.filter((r, i) => Math.abs(hiErr[i]) <= 3 && Math.abs(loErr[i]) <= 3).length,
      rainRight: both.filter((r) => wet(r.forecast) === wet(r.actual)).length,
      rainMissed: both.filter((r) => !wet(r.forecast) && wet(r.actual)).length,
      falseAlarms: both.filter((r) => wet(r.forecast) && !wet(r.actual)).length,
    };
  }

  // Rows grouped by calendar month, oldest first: [{ month: 'YYYY-MM', summary }]
  function byMonth(rows) {
    const groups = new Map();
    for (const r of rows) {
      const key = r.date.slice(0, 7);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    return [...groups].map(([month, rs]) => ({ month, summary: summarize(rs) })).filter((g) => g.summary);
  }

  return { forecasts, pairs, summarize, byMonth, historyStart, LEADS, WET };
})();
