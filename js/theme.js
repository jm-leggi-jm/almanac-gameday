// Light/dark mode. Loaded in <head> so a saved choice applies before the page paints (no flash).
// Until the toggle is used, the page follows the system setting.
(() => {
  const KEY = 'almanac-gameday.theme';
  const root = document.documentElement;

  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  } catch { /* storage unavailable: follow the system */ }

  const current = () => root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  function label(btn) {
    const dark = current() === 'dark';
    btn.textContent = dark ? '☀ Light mode' : '☾ Dark mode';
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    label(btn);
    btn.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem(KEY, next); } catch { /* not remembered, still switched */ }
      label(btn);
      document.dispatchEvent(new Event('themechange'));   // radars redraw their basemaps
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => label(btn));
  });
})();
