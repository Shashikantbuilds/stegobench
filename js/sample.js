/* StegoBench - procedural sample cover images (landscape with film grain), so you can test without any file.
 * `variant` (0,1,2,...) changes the scene, so a dataset of different covers can be generated offline. */
(function () {
  'use strict';
  const SB = window.SB;
  SB.makeSampleCanvas = function (w, h, variant) {
    w = w || 800; h = h || 600; variant = variant | 0;
    const R = SB.mulberry32(1000 + variant * 7919);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    const hue = variant ? Math.round(R() * 70 - 20) : 0;                 // variant 0 keeps the original look
    const sky = g.createLinearGradient(0, 0, 0, h * 0.62);
    sky.addColorStop(0, variant ? `hsl(${215 + hue} 70% ${35 + R() * 15}%)` : '#2f6fd6');
    sky.addColorStop(1, variant ? `hsl(${205 + hue} 80% ${78 + R() * 12}%)` : '#bfe0ff');
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff6c9'; g.beginPath(); g.arc(w * (variant ? 0.2 + R() * 0.6 : 0.78), h * (variant ? 0.12 + R() * 0.15 : 0.2), h * 0.07, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,.85)';
    const clouds = variant ? Array.from({ length: 4 }, () => [R() * 0.9 + 0.05, R() * 0.2 + 0.05, 0.05 + R() * 0.05]) : [[0.2, 0.18, 0.09], [0.3, 0.2, 0.07], [0.55, 0.12, 0.08], [0.62, 0.14, 0.06]];
    clouds.forEach(([x, y, r]) => { g.beginPath(); g.arc(w * x, h * y, h * r, 0, 7); g.fill(); });
    const hill = (base, amp, col, ph) => {
      g.fillStyle = col; g.beginPath(); g.moveTo(0, h);
      for (let x = 0; x <= w; x += 8) g.lineTo(x, h * base + Math.sin(x / w * (6 + variant % 3) + ph) * h * amp + Math.sin(x / w * 17 + ph) * h * amp * 0.25);
      g.lineTo(w, h); g.fill();
    };
    const tint = (l) => (variant ? `hsl(${130 + hue} ${35 + R() * 15}% ${l}%)` : null);
    hill(0.55, 0.06, tint(48) || '#5f8f6a', variant * 0.9); hill(0.68, 0.07, tint(38) || '#3f7a4f', 2 + variant * 0.7); hill(0.82, 0.05, tint(27) || '#2c5a3a', 4 + variant * 1.3);
    // film-grain texture so the statistics look like a real photo
    const img = g.getImageData(0, 0, w, h), d = img.data, r = SB.mulberry32(77 + variant);
    for (let i = 0; i < d.length; i += 4) {
      const n = (r() + r() + r() - 1.5) * 18;
      d[i] = SB.clamp8(d[i] + n); d[i + 1] = SB.clamp8(d[i + 1] + n); d[i + 2] = SB.clamp8(d[i + 2] + n);
    }
    g.putImageData(img, 0, 0);
    return c;
  };
})();
