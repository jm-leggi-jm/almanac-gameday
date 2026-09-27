// Date helpers. All dates are 'YYYY-MM-DD' strings handled in UTC to avoid DST drift.
const Dates = (() => {
  const parse = (s) => new Date(s + 'T00:00:00Z');
  const fmt = (d) => d.toISOString().slice(0, 10);

  function addDays(s, n) {
    const d = parse(s);
    d.setUTCDate(d.getUTCDate() + n);
    return fmt(d);
  }

  // Same calendar day n years earlier; Feb 29 falls back to Feb 28.
  function shiftYears(s, n) {
    const [y, m, d] = s.split('-').map(Number);
    const year = y - n;
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const day = m === 2 && d === 29 && !leap ? 28 : d;
    return `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);

  function range(start, end) {
    const out = [];
    for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
    return out;
  }

  const today = () => {
    const now = new Date();
    return fmt(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
  };

  const short = (s) => parse(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const shortYear = (s) => parse(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const weekday = (s) => parse(s).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });

  return { addDays, shiftYears, diffDays, range, today, short, shortYear, weekday };
})();
