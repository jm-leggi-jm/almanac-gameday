// Service worker: lets the installed app open without the local server, and shows the last weather seen when offline.
const SHELL_CACHE = 'gameday-shell-v49';
const DATA_CACHE = 'weather-data-v1';
const SHELL_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/styles.css',
  'js/theme.js', 'js/radar.js', 'js/football.js', 'js/gameday.js', 'js/parlay.js', 'js/props.js', 'js/tracker.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE && !k.startsWith('gameday-forecasts') && !k.startsWith('gameday-props')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Weather URLs carry today's date range; drop it so yesterday's copy still serves as the offline fallback.
function dataKey(url) {
  const u = new URL(url);
  u.searchParams.delete('start_date');
  u.searchParams.delete('end_date');
  return u.toString();
}

// App files: fresh from the server when it's running (so all files stay the same version),
// otherwise from the cache. A stopped localhost server refuses instantly, so there's no wait.
async function shell(request) {
  const cache = await caches.open(SHELL_CACHE);
  // Pages are cached under their own path (query string dropped).
  let key = request;
  if (request.mode === 'navigate') {
    const url = new URL(request.url);
    key = url.pathname.endsWith('/') ? 'index.html' : url.origin + url.pathname;
  }
  try {
    // no-cache: revalidate with the server so a fresh publish isn't masked by the browser's
    // 10-minute HTTP cache (which could pair a new page with old scripts).
    const res = await fetch(request.mode === 'navigate' ? request.url : request, { cache: 'no-cache' });
    if (!res.ok) return (await cache.match(key, { ignoreSearch: true })) || res;
    await cache.put(key, res.clone()).catch(() => {});
    return res;
  } catch {
    const cached = await cache.match(key, { ignoreSearch: true });
    return cached || new Response('Offline', { status: 503 });
  }
}

// Weather data: always try the network first so numbers are fresh, fall back to the last copy.
// An Open-Meteo 429 is returned as-is so the page can back off and retry. Substituting a saved
// copy there used to hide the 429, and the page would treat that old forecast as a fresh download.
async function weather(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(request);
    // Only Open-Meteo is retried with backoff by the page. Other hosts (ESPN, Polymarket)
    // have no retry, so a 429 there still falls back to the saved copy.
    const meteo429 = res.status === 429 && ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'historical-forecast-api.open-meteo.com'].includes(new URL(request.url).hostname);
    if (meteo429) return res;
    if (!res.ok) return (await cache.match(dataKey(request.url))) || res;
    await cache.put(dataKey(request.url), res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const cached = await cache.match(dataKey(request.url));
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin) event.respondWith(shell(event.request));
  else if (['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'historical-forecast-api.open-meteo.com'].includes(url.hostname) || url.hostname === 'site.api.espn.com' || url.hostname === 'gamma-api.polymarket.com' || url.hostname === 'clob.polymarket.com') event.respondWith(weather(event.request));
});
