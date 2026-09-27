// Animated precipitation radar: RainViewer frames over an Esri gray basemap, drawn as a plain tile grid (no map library).
// Radar.mount / Radar.setLocation drive the page's main radar; Radar.create() makes further independent maps
// (e.g. one per game). All maps share one download of the frame list.
const Radar = (() => {
  const TILE = 256;
  const FRAMES_URL = 'https://api.rainviewer.com/public/weather-maps.json';
  const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas';
  const MIN_ZOOM = 3;
  const MAX_ZOOM = 7;          // RainViewer's free radar tiles stop at zoom 7
  const COLOR_SCHEME = 2;      // "Universal Blue" — the free tier serves this palette whatever is requested
  const TILE_OPTIONS = '1_1';  // smoothed, with snow drawn in its own colors
  const FRAME_MS = 450;
  const HOLD_MS = 1600;        // pause on the newest frame before looping
  const REFRESH_MS = 5 * 60 * 1000;
  const FRAMES_TTL_MS = 60 * 1000;

  function project(lat, lon, z) {
    const size = TILE * 2 ** z;
    const s = Math.sin((lat * Math.PI) / 180);
    return {
      x: ((lon + 180) / 360) * size,
      y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size,
    };
  }

  function isDark() {
    const theme = document.documentElement.dataset.theme;
    if (theme) return theme === 'dark';
    return matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // Esri tile URLs are z/y/x. Base = land and water; reference = borders and place names, drawn above the radar.
  const baseUrl = (x, y, z) => `${ESRI}/World_${isDark() ? 'Dark' : 'Light'}_Gray_Base/MapServer/tile/${z}/${y}/${x}`;
  const labelsUrl = (x, y, z) => `${ESRI}/World_${isDark() ? 'Dark' : 'Light'}_Gray_Reference/MapServer/tile/${z}/${y}/${x}`;
  const radarUrl = (host, frame, x, y, z) => `${host}${frame.path}/${TILE}/${z}/${x}/${y}/${COLOR_SCHEME}/${TILE_OPTIONS}.png`;

  function tileImg(src, left, top) {
    const img = new Image(TILE, TILE);
    img.src = src;
    img.alt = '';
    img.draggable = false;
    img.style.left = `${left}px`;
    img.style.top = `${top}px`;
    img.onerror = () => { img.style.visibility = 'hidden'; };
    return img;
  }

  // One request for the frame list, shared by every map on the page for a minute.
  let framesCache = null;
  function sharedFrames() {
    if (!framesCache || Date.now() - framesCache.at > FRAMES_TTL_MS) {
      const promise = fetch(FRAMES_URL)
        .then((res) => { if (!res.ok) throw new Error(res.status); return res.json(); })
        .then((data) => ({ host: data.host, frames: (data.radar && data.radar.past) || [] }));
      promise.catch(() => { framesCache = null; });
      framesCache = { at: Date.now(), promise };
    }
    return framesCache.promise;
  }

  function createRadar() {
    let map, pane, slider, playBtn, timeLabel, note;
    let loc = null;
    let zoom = 6;
    let center = null;           // world-pixel coordinates at the current zoom
    let host = '';
    let frames = [];
    let current = 0;
    let playing = true;
    let active = true;           // false while scrolled out of view: no animation
    let timer = null;
    let refreshTimer = null;
    let resizeObserver = null;
    const cleanups = [];

    function render() {
      if (!center || !map) return;
      const W = map.clientWidth;
      const H = map.clientHeight;
      if (!W || !H) return;
      const left = center.x - W / 2;
      const top = center.y - H / 2;
      const n = 2 ** zoom;

      pane.innerHTML = '';
      pane.style.transform = '';
      const base = document.createElement('div');
      base.className = 'radar-layer';
      const layers = frames.map((_, i) => {
        const div = document.createElement('div');
        div.className = `radar-layer radar-frame${i === current ? ' on' : ''}`;
        return div;
      });
      const labels = document.createElement('div');
      labels.className = 'radar-layer';

      for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + H - 1) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue;
        for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + W - 1) / TILE); tx++) {
          const wx = ((tx % n) + n) % n; // wrap around the antimeridian
          const px = tx * TILE - left;
          const py = ty * TILE - top;
          base.appendChild(tileImg(baseUrl(wx, ty, zoom), px, py));
          frames.forEach((f, i) => layers[i].appendChild(tileImg(radarUrl(host, f, wx, ty, zoom), px, py)));
          labels.appendChild(tileImg(labelsUrl(wx, ty, zoom), px, py));
        }
      }
      pane.append(base, ...layers, labels);

      const pin = document.createElement('div');
      pin.className = 'radar-pin';
      const p = project(loc.lat, loc.lon, zoom);
      pin.style.left = `${p.x - left}px`;
      pin.style.top = `${p.y - top}px`;
      pane.appendChild(pin);
    }

    function showFrame(i) {
      current = i;
      if (!pane) return;
      pane.querySelectorAll('.radar-frame').forEach((layer, k) => layer.classList.toggle('on', k === i));
      slider.value = i;
      const f = frames[i];
      if (!f) return;
      const when = new Date(f.time * 1000);
      const mins = Math.max(0, Math.round((Date.now() - when) / 60000));
      timeLabel.textContent = `${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${mins < 1 ? 'just now' : `${mins} min ago`}`;
    }

    function tick() {
      clearTimeout(timer);
      if (!playing || !active || !frames.length || document.hidden) return;
      const last = current === frames.length - 1;
      timer = setTimeout(() => { showFrame(last ? 0 : current + 1); tick(); }, last ? HOLD_MS : FRAME_MS);
    }

    function setPlaying(on) {
      playing = on;
      playBtn.textContent = on ? '❚❚' : '▶';
      playBtn.setAttribute('aria-label', on ? 'Pause radar loop' : 'Play radar loop');
      tick();
    }

    async function loadFrames() {
      try {
        const data = await sharedFrames();
        host = data.host;
        frames = data.frames;
        if (!frames.length) throw new Error('no frames');
        note.hidden = true;
      } catch {
        frames = [];
        note.textContent = 'Radar is unavailable right now. The map will retry in a few minutes.';
        note.hidden = false;
      }
      slider.max = Math.max(0, frames.length - 1);
      current = frames.length - 1;
      render();
      showFrame(current);
      tick();
    }

    function setZoom(z) {
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
      if (next === zoom || !center) return;
      const k = 2 ** (next - zoom);
      center = { x: center.x * k, y: center.y * k };
      zoom = next;
      render();
      showFrame(current);
    }

    function recenter() {
      if (!loc) return;
      center = project(loc.lat, loc.lon, zoom);
      render();
      showFrame(current);
    }

    function enableDrag() {
      let start = null;
      map.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button') || !center) return;
        start = { x: e.clientX, y: e.clientY };
        map.setPointerCapture(e.pointerId);
        map.classList.add('dragging');
      });
      map.addEventListener('pointermove', (e) => {
        if (!start) return;
        pane.style.transform = `translate(${e.clientX - start.x}px, ${e.clientY - start.y}px)`;
      });
      const end = (e) => {
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        start = null;
        map.classList.remove('dragging');
        if (Math.abs(dx) + Math.abs(dy) < 3) { pane.style.transform = ''; return; }
        center = { x: center.x - dx, y: center.y - dy };
        render();
        showFrame(current);
      };
      map.addEventListener('pointerup', end);
      map.addEventListener('pointercancel', end);
      map.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(zoom + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
      map.addEventListener('keydown', (e) => {
        const step = 80;
        const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (moves[e.key] && center) {
          e.preventDefault();
          center = { x: center.x + moves[e.key][0], y: center.y + moves[e.key][1] };
          render(); showFrame(current);
        } else if (e.key === '+' || e.key === '=') setZoom(zoom + 1);
        else if (e.key === '-') setZoom(zoom - 1);
      });
    }

    function listen(target, type, fn) {
      target.addEventListener(type, fn);
      cleanups.push(() => target.removeEventListener(type, fn));
    }

    // opts.kiosk: hands-off wall display (no buttons or slider; the loop just plays). opts.zoom: starting zoom.
    // opts.fixed: the map can't be zoomed or panned (no zoom buttons, mouse wheel scrolls the page).
    function mount(container, opts = {}) {
      if (opts.zoom) zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, opts.zoom));
      container.classList.toggle('radar-kiosk', !!opts.kiosk);
      container.classList.toggle('radar-fixed', !!opts.fixed);
      container.innerHTML = `
        <div class="radar-map" ${opts.fixed ? '' : 'tabindex="0"'} role="img" aria-label="Animated precipitation radar map.${opts.fixed ? '' : ' Drag or use arrow keys to pan, plus and minus to zoom.'}">
          <div class="radar-pane"></div>
          <div class="radar-zoom">
            <button type="button" data-z="1" aria-label="Zoom in">+</button>
            <button type="button" data-z="-1" aria-label="Zoom out">−</button>
            <button type="button" data-z="0" aria-label="Recenter on location" title="Recenter">◎</button>
          </div>
          <p class="radar-note" hidden></p>
          <div class="radar-attrib"><a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a> ·
            © <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, HERE, Garmin, OSM</div>
        </div>
        <div class="radar-bar">
          <button type="button" class="radar-play ghost small">❚❚</button>
          <input type="range" min="0" max="0" value="0" aria-label="Radar frame">
          <span class="radar-time muted small"></span>
        </div>
        <div class="radar-legend" aria-label="Radar color key">
          <span>Drizzle</span><i class="ramp" aria-hidden="true"></i><span>Heavy</span>
        </div>`;
      map = container.querySelector('.radar-map');
      pane = container.querySelector('.radar-pane');
      slider = container.querySelector('input[type=range]');
      playBtn = container.querySelector('.radar-play');
      timeLabel = container.querySelector('.radar-time');
      note = container.querySelector('.radar-note');

      container.querySelector('.radar-zoom').addEventListener('click', (e) => {
        const z = e.target.closest('[data-z]');
        if (!z) return;
        const d = Number(z.dataset.z);
        if (d === 0) recenter(); else setZoom(zoom + d);
      });
      playBtn.addEventListener('click', () => setPlaying(!playing));
      slider.addEventListener('input', () => { setPlaying(false); showFrame(Number(slider.value)); });
      if (!opts.fixed) enableDrag();

      let resizeTimer;
      resizeObserver = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { render(); showFrame(current); }, 120);
      });
      resizeObserver.observe(map);
      listen(matchMedia('(prefers-color-scheme: dark)'), 'change', () => { render(); showFrame(current); });
      listen(document, 'visibilitychange', tick);
      refreshTimer = setInterval(() => { if (!document.hidden && loc && active) loadFrames(); }, REFRESH_MS);
      setPlaying(true);
    }

    function setLocation(l) {
      loc = l;
      center = project(loc.lat, loc.lon, zoom);
      loadFrames();
    }

    // Pause the loop while the map is off-screen; resume (and catch up on new frames) when it's back.
    function setActive(on) {
      if (active === on) return;
      active = on;
      if (on && loc) loadFrames(); else tick();
    }

    function destroy() {
      clearTimeout(timer);
      clearInterval(refreshTimer);
      if (resizeObserver) resizeObserver.disconnect();
      cleanups.splice(0).forEach((fn) => fn());
      if (pane) pane.innerHTML = '';
    }

    return { mount, setLocation, setActive, destroy };
  }

  const main = createRadar();
  return { mount: main.mount, setLocation: main.setLocation, create: createRadar };
})();
