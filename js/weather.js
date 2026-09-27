// Open-Meteo access: geocoding, observed history (for actuals + normals), and the 16-day forecast.
const Weather = (() => {
  const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
  const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
  const FORECAST = 'https://api.open-meteo.com/v1/forecast';
  const DAILY = 'temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum';
  const UNITS = 'temperature_unit=fahrenheit&precipitation_unit=inch&timezone=auto';
  const HISTORY_YEARS = 12;   // 10 years of normals plus room for windows that end next year
  const ARCHIVE_LAG_DAYS = 6; // the reanalysis archive trails real time by ~5 days

  async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    return res.json();
  }

  async function geocode(query) {
    const data = await getJSON(`${GEO}?name=${encodeURIComponent(query)}&count=6&language=en&format=json`);
    return (data.results || []).map((r) => ({
      name: [r.name, r.admin1, r.country_code].filter(Boolean).join(', '),
      lat: r.latitude,
      lon: r.longitude,
    }));
  }

  // Open-Meteo daily arrays -> { 'YYYY-MM-DD': { tmax, tmin, precip, snow } }
  function toDayMap(daily) {
    const map = {};
    daily.time.forEach((date, i) => {
      const tmax = daily.temperature_2m_max[i];
      const tmin = daily.temperature_2m_min[i];
      if (tmax == null || tmin == null) return;
      map[date] = {
        tmax, tmin,
        precip: daily.precipitation_sum[i] ?? 0,
        snow: daily.snowfall_sum[i] ?? 0,
      };
    });
    return map;
  }

  const historyCache = new Map();

  async function history(loc) {
    const key = `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
    if (!historyCache.has(key)) {
      const end = Dates.addDays(Dates.today(), -ARCHIVE_LAG_DAYS);
      const start = Dates.shiftYears(end, HISTORY_YEARS);
      const promise = getJSON(`${ARCHIVE}?latitude=${loc.lat}&longitude=${loc.lon}&start_date=${start}&end_date=${end}&daily=${DAILY}&${UNITS}`)
        .then((data) => {
          const days = toDayMap(data.daily);
          const dates = Object.keys(days).sort();
          return { days, lastDate: dates[dates.length - 1] };
        });
      promise.catch(() => historyCache.delete(key));
      historyCache.set(key, promise);
    }
    return historyCache.get(key);
  }

  // Observed days from `start` up to the archive's last date — a light fetch for the wall display,
  // which only needs recent weather, not 12 years of normals.
  async function recent(loc, start) {
    const end = Dates.addDays(Dates.today(), -ARCHIVE_LAG_DAYS);
    const data = await getJSON(`${ARCHIVE}?latitude=${loc.lat}&longitude=${loc.lon}&start_date=${start}&end_date=${end}&daily=${DAILY}&${UNITS}`);
    return toDayMap(data.daily);
  }

  // past_days bridges the gap between the archive's last date and today.
  async function forecast(loc) {
    const data = await getJSON(`${FORECAST}?latitude=${loc.lat}&longitude=${loc.lon}&daily=${DAILY}&past_days=7&forecast_days=16&${UNITS}`);
    return toDayMap(data.daily);
  }

  return { geocode, history, recent, forecast };
})();
