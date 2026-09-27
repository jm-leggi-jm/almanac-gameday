// Turning weather data into verdicts: normals, tercile categories, and ledger projection scores.
const Scoring = (() => {
  const NORMAL_YEARS = 10;
  const VALUE = { below: -1, normal: 0, above: 1 };

  function statsFor(days, dates) {
    let temp = 0, precip = 0, snow = 0, n = 0;
    for (const d of dates) {
      const day = days[d];
      if (!day) continue;
      temp += (day.tmax + day.tmin) / 2;
      precip += day.precip;
      snow += day.snow;
      n++;
    }
    if (n < dates.length * 0.8) return null;
    // Scale totals up for the few missing days so windows stay comparable.
    const scale = dates.length / n;
    return { temp: temp / n, precip: precip * scale, snow: snow * scale };
  }

  // The same calendar dates in each of the last NORMAL_YEARS years that the archive fully covers.
  function normalSamples(hist, dates) {
    const samples = [];
    for (let k = 1; samples.length < NORMAL_YEARS && k <= 13; k++) {
      const shifted = dates.map((d) => Dates.shiftYears(d, k));
      if (shifted[shifted.length - 1] > hist.lastDate) continue;
      const s = statsFor(hist.days, shifted);
      if (s) samples.push(s);
    }
    return samples;
  }

  function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    return sorted[lo] + (sorted[Math.ceil(pos)] - sorted[lo]) * (pos - lo);
  }

  // Tercile classification: "above" means the value would rank in the top third of recent years.
  function tercile(value, samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    if (value < quantile(sorted, 1 / 3)) return 'below';
    if (value > quantile(sorted, 2 / 3)) return 'above';
    return 'normal';
  }

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  function classify(actual, samples) {
    const temps = samples.map((s) => s.temp);
    const precips = samples.map((s) => s.precip);
    const normalPrecip = mean(precips);
    return {
      temp: tercile(actual.temp, temps),
      precip: tercile(actual.precip, precips),
      tempAnom: actual.temp - mean(temps),
      precipPct: normalPrecip > 0.05 ? (actual.precip / normalPrecip) * 100 : null,
      normalTemp: mean(temps),
      normalPrecip,
    };
  }

  function callPoints(call, outcome) {
    if (!call) return null;
    return [1, 0.5, 0][Math.abs(VALUE[call] - VALUE[outcome])];
  }

  // Evaluate one projection against observed data (verified) or observed + forecast days (tracking).
  function evaluate(p, hist, fcDays) {
    const dates = Dates.range(p.start, p.end);
    if (p.end <= hist.lastDate) {
      const actual = statsFor(hist.days, dates);
      const samples = normalSamples(hist, dates);
      if (!actual || samples.length < 5) return { status: 'nodata' };
      const verdict = { ...classify(actual, samples), snow: actual.snow };
      const pts = [callPoints(p.temp, verdict.temp), callPoints(p.precip, verdict.precip)].filter((x) => x !== null);
      return { status: 'verified', verdict, points: pts.length ? mean(pts) : null, coverage: 1 };
    }

    const merged = { ...fcDays, ...hist.days };
    const covered = dates.filter((d) => merged[d]);
    const coverage = covered.length / dates.length;
    if (coverage < 0.3) return { status: 'pending', coverage };
    const samples = normalSamples(hist, covered);
    const actual = statsFor(merged, covered);
    if (!actual || samples.length < 5) return { status: 'pending', coverage };
    return { status: 'tracking', verdict: { ...classify(actual, samples), snow: actual.snow }, coverage };
  }

  // 10-year average high/low for a calendar day, smoothed over ±3 days.
  function dailyNormal(hist, date) {
    const hi = [], lo = [];
    for (let k = 1; k <= NORMAL_YEARS + 1; k++) {
      for (let o = -3; o <= 3; o++) {
        const day = hist.days[Dates.addDays(Dates.shiftYears(date, k), o)];
        if (day) { hi.push(day.tmax); lo.push(day.tmin); }
      }
    }
    return hi.length ? { tmax: mean(hi), tmin: mean(lo) } : null;
  }

  // Category for a stretch of forecast days, used when snapshotting the model's call.
  function modelCall(hist, fcDays, start, end) {
    const dates = Dates.range(start, end);
    const actual = statsFor(fcDays, dates);
    const samples = normalSamples(hist, dates);
    if (!actual || samples.length < 5) return null;
    return classify(actual, samples);
  }

  return { evaluate, dailyNormal, modelCall };
})();
