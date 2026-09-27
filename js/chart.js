// Small SVG line chart with a hover crosshair, shared by the 16-day forecast and forecast-vs-actual cards.
// series: [{ key, label, color, dashed }] — solid series get end labels and hover dots.
const Chart = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const DEFAULT_HEIGHT = 260;
  const M = { top: 14, right: 44, bottom: 28, left: 36 };

  function el(name, attrs = {}, parent) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function legend(container, series) {
    container.innerHTML = series.map((s) => `
      <span class="key"><svg width="22" height="8" aria-hidden="true"><line x1="1" y1="4" x2="21" y2="4"
        stroke="${s.color}" stroke-width="2" stroke-linecap="round" ${s.dashed ? 'stroke-dasharray="4 4"' : ''}/></svg>${s.label}</span>`).join('');
  }

  function niceTicks(min, max) {
    const step = (max - min) > 40 ? 10 : 5;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v);
    return { ticks, lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step };
  }

  // opts: { series, tooltip (element), tip(row) -> html, xLabel(row, i) -> string, ariaLabel, height? }
  function render(container, rows, opts) {
    const { series, tooltip, tip, xLabel, ariaLabel } = opts;
    const H = Math.max(160, opts.height || DEFAULT_HEIGHT);
    container.innerHTML = '';
    const W = Math.max(320, container.clientWidth);
    const iw = W - M.left - M.right;
    const ih = H - M.top - M.bottom;
    const vals = rows.flatMap((r) => series.map((s) => r[s.key])).filter((v) => v != null);
    if (!vals.length) return;
    const { ticks, lo, hi } = niceTicks(Math.min(...vals) - 2, Math.max(...vals) + 2);
    const x = (i) => M.left + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
    const y = (v) => M.top + ih - ((v - lo) / (hi - lo)) * ih;

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': ariaLabel }, container);

    for (const t of ticks) {
      el('line', { x1: M.left, x2: W - M.right, y1: y(t), y2: y(t), class: 'grid' }, svg);
      el('text', { x: M.left - 8, y: y(t) + 4, class: 'tick', 'text-anchor': 'end' }, svg).textContent = `${t}°`;
    }
    const every = Math.max(1, Math.ceil(rows.length / (W < 520 ? 4 : 8)));
    rows.forEach((r, i) => {
      if (i % every) return;
      el('text', { x: x(i), y: H - 8, class: 'tick', 'text-anchor': 'middle' }, svg).textContent = xLabel(r, i);
    });

    for (const s of series) {
      // Break the line at missing days instead of bridging them.
      let run = [];
      const flush = () => {
        if (run.length > 1) {
          el('polyline', { points: run.join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2,
            'stroke-linejoin': 'round', 'stroke-linecap': 'round', ...(s.dashed ? { 'stroke-dasharray': '4 4', opacity: 0.8 } : {}) }, svg);
        }
        run = [];
      };
      rows.forEach((r, i) => (r[s.key] == null ? flush() : run.push(`${x(i)},${y(r[s.key])}`)));
      flush();
    }

    const solid = series.filter((s) => !s.dashed);
    for (const s of solid) {
      let i = rows.length - 1;
      while (i >= 0 && rows[i][s.key] == null) i--;
      if (i < 0) continue;
      el('text', { x: x(i) + 6, y: y(rows[i][s.key]) + 4, class: 'end-label' }, svg).textContent = `${Math.round(rows[i][s.key])}°`;
    }

    const cross = el('line', { y1: M.top, y2: M.top + ih, class: 'cross', visibility: 'hidden' }, svg);
    const dots = solid.map((s) => el('circle', { r: 4.5, fill: s.color, class: 'dot', visibility: 'hidden' }, svg));
    const hit = el('rect', { x: M.left, y: M.top, width: iw, height: ih, fill: 'transparent' }, svg);

    function show(evt) {
      const box = svg.getBoundingClientRect();
      const px = ((evt.clientX - box.left) / box.width) * W;
      const i = Math.max(0, Math.min(rows.length - 1, Math.round(((px - M.left) / iw) * (rows.length - 1))));
      const r = rows[i];
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      solid.forEach((s, k) => {
        const v = r[s.key];
        dots[k].setAttribute('visibility', v == null ? 'hidden' : 'visible');
        if (v != null) { dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(v)); }
      });
      tooltip.innerHTML = tip(r);
      tooltip.hidden = false;
      const tx = Math.min(evt.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
      tooltip.style.left = `${tx}px`;
      tooltip.style.top = `${evt.clientY + 14}px`;
    }
    function hide() {
      tooltip.hidden = true;
      cross.setAttribute('visibility', 'hidden');
      dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    }
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerleave', hide);
  }

  return { render, legend };
})();
