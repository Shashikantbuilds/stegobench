/* StegoBench - tiny dependency-free charts on <canvas>: line (error bars, log x, categorical x, ROC) and scatter (Pareto). */
(function () {
  'use strict';
  const SB = window.SB;

  const css = (name, fb) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb);
  function niceTicks(min, max, n) {
    if (!(max > min)) return [min];
    const span = max - min, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const f = step0 / mag, step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag, out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(+v.toPrecision(12));
    return out;
  }
  function logTicks(min, max) {
    const out = [];
    for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++)
      [1, 2, 5].forEach((m) => { const v = m * Math.pow(10, e); if (v >= min * 0.999 && v <= max * 1.001) out.push(v); });
    return out;
  }
  const fmtNum = (v) => (Math.abs(v) >= 1000 ? (v / 1000) + 'k' : Math.abs(v) < 0.01 && v !== 0 ? v.toExponential(0) : +v.toFixed(3) + '');

  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth || +canvas.dataset.w || 640, h = +canvas.dataset.h || 320;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.height = h + 'px';
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g, w, h, ink: css('--ink', '#1b2a55'), muted: css('--muted', '#6b7a99'), line: css('--line', '#e6ecf8'), card: css('--panel', '#fff') };
  }
  function frame(c, spec, xmap, ymin, ymax, xticks, yticks, m) {
    const { g, w, h } = c;
    g.font = '12px Inter, "Segoe UI", system-ui, sans-serif';
    g.strokeStyle = c.line; g.fillStyle = c.muted; g.lineWidth = 1;
    g.textAlign = 'right'; g.textBaseline = 'middle';
    yticks.forEach((v) => {
      const y = m.t + (1 - (v - ymin) / (ymax - ymin)) * (h - m.t - m.b);
      g.beginPath(); g.moveTo(m.l, y); g.lineTo(w - m.r, y); g.stroke();
      g.fillText((spec.yfmt || fmtNum)(v), m.l - 8, y);
    });
    g.textAlign = 'center'; g.textBaseline = 'top';
    xticks.forEach((t) => { const x = xmap(t.v); g.fillText(t.label, x, h - m.b + 7); });
    g.fillStyle = c.ink;
    if (spec.xlabel) g.fillText(spec.xlabel, m.l + (w - m.l - m.r) / 2, h - 16);
    if (spec.ylabel) { g.save(); g.translate(14, m.t + (h - m.t - m.b) / 2); g.rotate(-Math.PI / 2); g.textBaseline = 'top'; g.fillText(spec.ylabel, 0, 0); g.restore(); }
  }

  /* spec: { series:[{name,color,dash,points:[{x,y,e}]}], xlabel,ylabel, xlog, xcats, ymin,ymax, diag, xmin,xmax, yfmt } */
  function line(canvas, spec) {
    const c = setup(canvas), { g, w, h } = c, m = { l: 52, r: 16, t: 14, b: 44 };
    const pts = spec.series.flatMap((s) => s.points.filter((p) => p.y != null && Number.isFinite(p.y)));
    if (!pts.length) { g.fillStyle = c.muted; g.textAlign = 'center'; g.fillText('No data for this chart', w / 2, h / 2); return; }
    let xmin = spec.xmin != null ? spec.xmin : Math.min(...pts.map((p) => p.x)), xmax = spec.xmax != null ? spec.xmax : Math.max(...pts.map((p) => p.x));
    const ymin = spec.ymin != null ? spec.ymin : 0, ymax = spec.ymax != null ? spec.ymax : Math.max(...pts.map((p) => p.y + (p.e || 0))) * 1.05;
    if (xmin === xmax) { xmin -= 0.5; xmax += 0.5; }
    const lx = (v) => (spec.xlog ? Math.log10(v) : v), a = lx(xmin), b = lx(xmax);
    const xmap = (v) => m.l + ((lx(v) - a) / (b - a)) * (w - m.l - m.r);
    const ymap = (v) => m.t + (1 - (v - ymin) / (ymax - ymin)) * (h - m.t - m.b);
    const xticks = spec.xcats ? spec.xcats.map((label, i) => ({ v: i, label })) : (spec.xlog ? logTicks(xmin, xmax) : niceTicks(xmin, xmax, 6)).map((v) => ({ v, label: (spec.xfmt || fmtNum)(v) }));
    frame(c, spec, xmap, ymin, ymax, xticks, niceTicks(ymin, ymax, 5), m);
    if (spec.diag) { g.strokeStyle = c.muted; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(xmap(0), ymap(0)); g.lineTo(xmap(1), ymap(1)); g.stroke(); g.setLineDash([]); }
    const hits = [];
    spec.series.forEach((s) => {
      g.strokeStyle = s.color; g.fillStyle = s.color; g.lineWidth = 2; g.setLineDash(s.dash ? [6, 4] : []);
      let pen = false;
      g.beginPath();
      s.points.forEach((p) => {
        if (p.y == null || !Number.isFinite(p.y)) { pen = false; return; }
        const X = xmap(p.x), Y = ymap(p.y);
        pen ? g.lineTo(X, Y) : g.moveTo(X, Y); pen = true;
      });
      g.stroke(); g.setLineDash([]);
      s.points.forEach((p) => {
        if (p.y == null || !Number.isFinite(p.y)) return;
        const X = xmap(p.x), Y = ymap(p.y);
        if (p.e) { g.lineWidth = 1; g.beginPath(); g.moveTo(X, ymap(Math.max(ymin, p.y - p.e))); g.lineTo(X, ymap(Math.min(ymax, p.y + p.e))); g.stroke(); }
        if (!spec.noMarkers) { g.beginPath(); g.arc(X, Y, 3.2, 0, 7); g.fill(); }
        hits.push({ X, Y, text: `${s.name}: ${spec.xcats ? spec.xcats[p.x] : (spec.xfmt || fmtNum)(p.x)} → ${(spec.yfmt || fmtNum)(+p.y.toFixed(2))}${p.e ? ' ±' + p.e.toFixed(1) : ''}` });
      });
    });
    attachHover(canvas, hits);
  }

  /* spec: { points:[{x,y,r,color,label,ring}], xlabel, ylabel, xmin.. } axes default 0..100 */
  function scatter(canvas, spec) {
    const c = setup(canvas), { g, w, h } = c, m = { l: 52, r: 18, t: 14, b: 44 };
    const xmin = spec.xmin != null ? spec.xmin : 0, xmax = spec.xmax != null ? spec.xmax : 100, ymin = spec.ymin != null ? spec.ymin : 0, ymax = spec.ymax != null ? spec.ymax : 100;
    const xmap = (v) => m.l + ((v - xmin) / (xmax - xmin)) * (w - m.l - m.r), ymap = (v) => m.t + (1 - (v - ymin) / (ymax - ymin)) * (h - m.t - m.b);
    frame(c, spec, xmap, ymin, ymax, niceTicks(xmin, xmax, 5).map((v) => ({ v, label: fmtNum(v) })), niceTicks(ymin, ymax, 5), m);
    const hits = [];
    spec.points.forEach((p) => {
      const X = xmap(p.x), Y = ymap(p.y), r = p.r || 8;
      g.fillStyle = p.color + 'cc'; g.beginPath(); g.arc(X, Y, r, 0, 7); g.fill();
      if (p.ring) { g.strokeStyle = c.ink; g.lineWidth = 2; g.beginPath(); g.arc(X, Y, r + 3, 0, 7); g.stroke(); }
      hits.push({ X, Y, text: p.label + (p.ring ? ' (Pareto-optimal)' : '') + ` – ${spec.xlabel}: ${p.x.toFixed(1)}, ${spec.ylabel}: ${p.y.toFixed(1)}` });
    });
    g.font = '11px Inter, "Segoe UI", system-ui, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillStyle = c.ink;
    spec.points.forEach((p) => { const X = xmap(p.x), Y = ymap(p.y); const right = X < w - 120; g.textAlign = right ? 'left' : 'right'; g.fillText(p.short || '', X + (right ? 1 : -1) * ((p.r || 8) + 6), Y); });
    attachHover(canvas, hits);
  }

  function attachHover(canvas, hits) {
    canvas._hits = hits;
    if (canvas._hoverBound) return;
    canvas._hoverBound = true;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = 14 * 14;
      (canvas._hits || []).forEach((p) => { const d = (p.X - x) * (p.X - x) + (p.Y - y) * (p.Y - y); if (d < bd) { bd = d; best = p; } });
      canvas.title = best ? best.text : '';
    });
  }

  /* register for redraw on resize / theme change */
  const live = new Set();
  function draw(canvas, type, spec) {
    canvas._draw = () => (type === 'scatter' ? scatter : line)(canvas, spec);
    live.add(canvas); canvas._draw();
  }
  SB.charts = { draw, redrawAll() { live.forEach((c) => c.isConnected && c.offsetParent !== null && c._draw()); } };
  let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(SB.charts.redrawAll, 150); });

  SB.METHOD_COLOR = { seqlsb: '#2f66e8', rndlsb: '#16a34a', lsbm: '#0891b2', suni: '#db2777', dct: '#7c3aed', dctvote: '#0d9488', spread: '#ea6a0c', dwt: '#b7791f' };
})();
