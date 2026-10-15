/* StegoBench - classical steganalysis detectors (blind, run on the stego image only).
 *   rs      : RS analysis (Fridrich, Goljan, Du 2001)       -> estimated LSB-replacement rate p
 *   ws      : Weighted Stego (Fridrich & Goljan 2004)       -> estimated LSB-replacement rate p
 *   chiSeq  : progressive chi-square, pairs of values (Westfeld & Pfitzmann 1999) -> max p-value over growing prefixes
 *   chiGlob : the same chi-square test on the whole image
 * RS and WS target LSB *replacement*; they are weaker against LSB matching and adaptive embedding,
 * which is exactly what the benchmark should show. They are classical detectors, not machine-learning
 * steganalysers (SRM/SRNet) - see README for how to cross-check with Aletheia. */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;
  const SB = root.SB;

  function histogram(img) {
    const h = new Float64Array(256), d = img.data;
    for (let i = 0; i < d.length; i += 4) { h[d[i]]++; h[d[i + 1]]++; h[d[i + 2]]++; }
    return h;
  }
  /* P(chi2 >= x) for the pairs-of-values statistic. High p => LSB pairs equalised => LSB embedding likely. */
  function chiLSB(hist) {
    let x = 0, k = 0;
    for (let i = 0; i < 128; i++) {
      const e = (hist[2 * i] + hist[2 * i + 1]) / 2;
      if (e >= 4) { x += ((hist[2 * i] - e) * (hist[2 * i] - e)) / e; k++; }
    }
    if (k < 2) return 0;
    const dof = k - 1;
    const z = (Math.cbrt(x / dof) - (1 - 2 / (9 * dof))) / Math.sqrt(2 / (9 * dof));   // Wilson-Hilferty
    return 0.5 * (1 - SB.erf(z / Math.SQRT2));
  }
  function chiSeq(img) {
    const d = img.data, N = (d.length / 4) * 3;
    const checkpoints = [1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1].map((f) => Math.max(256, Math.floor(N * f)));
    const hist = new Float64Array(256);
    let best = 0, cp = 0, s = 0;
    for (let i = 0; i < d.length && cp < checkpoints.length; i += 4)
      for (let c = 0; c < 3; c++) {
        hist[d[i + c]]++; s++;
        if (s === checkpoints[cp]) { best = Math.max(best, chiLSB(hist)); cp++; }
      }
    return best;
  }

  /* ------------------------------------------------------------ RS analysis */
  const flipF1 = (v) => v ^ 1;                       // 0<->1, 2<->3, ...
  const flipFm = (v) => ((v + 1) ^ 1) - 1;           // -1<->0, 1<->2, ...
  function rsCounts(P, w, h, allFlip) {
    // groups: 4 horizontally adjacent pixels. returns [RM, SM, RnM, SnM] (counts)
    let RM = 0, SM = 0, Rn = 0, Sn = 0;
    const g = [0, 0, 0, 0];
    for (let y = 0; y < h; y++)
      for (let x = 0; x + 3 < w; x += 4) {
        const o = y * w + x;
        for (let k = 0; k < 4; k++) g[k] = allFlip ? P[o + k] ^ 1 : P[o + k];
        const f0 = Math.abs(g[1] - g[0]) + Math.abs(g[2] - g[1]) + Math.abs(g[3] - g[2]);
        // mask M = [0,1,1,0]
        let a1 = flipF1(g[1]), a2 = flipF1(g[2]);
        let f = Math.abs(a1 - g[0]) + Math.abs(a2 - a1) + Math.abs(g[3] - a2);
        if (f > f0) RM++; else if (f < f0) SM++;
        // mask -M = [0,-1,-1,0]
        a1 = flipFm(g[1]); a2 = flipFm(g[2]);
        f = Math.abs(a1 - g[0]) + Math.abs(a2 - a1) + Math.abs(g[3] - a2);
        if (f > f0) Rn++; else if (f < f0) Sn++;
      }
    return [RM, SM, Rn, Sn];
  }
  function rsChannel(P, w, h) {
    const N = h * Math.floor(w / 4);
    if (N < 50) return 0;
    const a = rsCounts(P, w, h, false), b = rsCounts(P, w, h, true);
    const d0 = (a[0] - a[1]) / N, dm0 = (a[2] - a[3]) / N, d1 = (b[0] - b[1]) / N, dm1 = (b[2] - b[3]) / N;
    const A = 2 * (d1 + d0), B = dm0 - dm1 - d1 - 3 * d0, C = d0 - dm0;
    let x;
    if (Math.abs(A) < 1e-12) { if (Math.abs(B) < 1e-12) return 0; x = -C / B; }
    else {
      const disc = B * B - 4 * A * C;
      if (disc < 0) return 0;
      const r1 = (-B + Math.sqrt(disc)) / (2 * A), r2 = (-B - Math.sqrt(disc)) / (2 * A);
      x = Math.abs(r1) < Math.abs(r2) ? r1 : r2;
    }
    const den = x - 0.5;
    if (Math.abs(den) < 1e-9) return 0;
    return SB.clamp(x / den, -0.5, 1.5);
  }

  /* ------------------------------------------------------------ Weighted Stego */
  function wsChannel(P, w, h) {
    let num = 0, den = 0;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x, v = P[i];
        const l = P[i - 1], r = P[i + 1], u = P[i - w], dn = P[i + w];
        const pred = (l + r + u + dn) / 4;
        let m = 0, s2 = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m += P[i + dy * w + dx];
        m /= 9;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const t = P[i + dy * w + dx] - m; s2 += t * t; }
        const wt = 1 / (5 + s2 / 8);
        num += wt * (v - (v ^ 1)) * (v - pred);
        den += wt;
      }
    return den ? SB.clamp((2 * num) / den, -0.5, 1.5) : 0;
  }

  function run(img) {
    const w = img.width, h = img.height, d = img.data, n = w * h;
    let rs = 0, ws = 0;
    const P = new Uint8Array(n);
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < n; i++) P[i] = d[i * 4 + c];
      rs += rsChannel(P, w, h) / 3;
      ws += wsChannel(P, w, h) / 3;
    }
    return { rs, ws, chiSeq: chiSeq(img), chiGlob: chiLSB(histogram(img)) };
  }

  SB.detectors = { run, histogram, chiLSB, chiSeq, rsChannel, wsChannel };
})();
