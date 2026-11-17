/* StegoBench - adaptive embedding building blocks.
 *  1) S-UNIWARD distortion (Holub, Fridrich, Denemark 2014): cost of +-1 change at every sample,
 *     from the three directional Daubechies-8 (8-tap) wavelet residuals.
 *  2) Syndrome-Trellis Codes (Filler, Judas, Fridrich 2011): binary STC, Viterbi minimisation of the
 *     total cost of the changes. Extraction is a plain syndrome computation (needs no costs).
 * The code uses a key-derived random submatrix (not the optimised ones from the paper), h = 7. */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;
  const SB = root.SB;

  /* ------------------------------------------------------------ S-UNIWARD costs */
  const LO = [-0.010597401784997278, 0.032883011666982945, 0.030841381835986965, -0.18703481171888114,
    -0.02798376941698385, 0.6308807679295904, 0.7148465705525415, 0.23037781330885523];
  const HI = LO.map((_, n) => ((n & 1) ? -1 : 1) * LO[7 - n]);
  const ABS_LO = LO.map(Math.abs), ABS_HI = HI.map(Math.abs);
  const L = 8, C0 = 3, SIGMA = Math.pow(2, -6);

  /* correlation along rows: out[x] = sum_t f[t] * in[x + t - C0], mirrored borders */
  function corrRows(src, w, h, f, dst) {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let t = 0; t < L; t++) {
          let xx = x + t - C0;
          if (xx < 0) xx = -xx - 1; else if (xx >= w) xx = 2 * w - xx - 1;
          s += f[t] * src[o + xx];
        }
        dst[o + x] = s;
      }
    }
  }
  function corrCols(src, w, h, f, dst) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let t = 0; t < L; t++) {
          let yy = y + t - C0;
          if (yy < 0) yy = -yy - 1; else if (yy >= h) yy = 2 * h - yy - 1;
          s += f[t] * src[yy * w + x];
        }
        dst[y * w + x] = s;
      }
  }
  /* cost spreading: rho[x] = sum_t |f[t]| * xi[x + C0 - t] */
  function spreadRows(src, w, h, af, dst) {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let t = 0; t < L; t++) {
          let xx = x + C0 - t;
          if (xx < 0) xx = -xx - 1; else if (xx >= w) xx = 2 * w - xx - 1;
          s += af[t] * src[o + xx];
        }
        dst[o + x] = s;
      }
    }
  }
  function spreadCols(src, w, h, af, dst) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let t = 0; t < L; t++) {
          let yy = y + C0 - t;
          if (yy < 0) yy = -yy - 1; else if (yy >= h) yy = 2 * h - yy - 1;
          s += af[t] * src[yy * w + x];
        }
        dst[y * w + x] = s;
      }
  }
  /* plane: Float32Array(w*h) of one colour channel -> Float32Array cost */
  function suniCosts(plane, w, h) {
    const n = w * h, tmp = new Float32Array(n), res = new Float32Array(n), rho = new Float32Array(n);
    // (row filter, column filter) for the three sub-bands LH, HL, HH
    const bands = [[HI, LO, ABS_HI, ABS_LO], [LO, HI, ABS_LO, ABS_HI], [HI, HI, ABS_HI, ABS_HI]];
    for (const [fr, fc, afr, afc] of bands) {
      corrRows(plane, w, h, fr, tmp);
      corrCols(tmp, w, h, fc, res);
      for (let i = 0; i < n; i++) res[i] = 1 / (SIGMA + Math.abs(res[i]));
      spreadRows(res, w, h, afr, tmp);
      spreadCols(tmp, w, h, afc, res);
      for (let i = 0; i < n; i++) rho[i] += res[i];
    }
    return rho;
  }

  /* ------------------------------------------------------------ STC */
  const H = 7, STATES = 1 << H, WORDS = STATES >> 5;

  /* submatrix columns (h-bit integers, first and last row set) from the key */
  function hColumns(key, width) {
    const rng = SB.keyedRng(key, 0x57c0), cols = new Uint8Array(width);
    for (let i = 0; i < width; i++) cols[i] = ((rng() * STATES) | 0) | 1 | (STATES >> 1);
    return cols;
  }
  const blockWidth = (j, w, rem) => w + (j < rem ? 1 : 0);

  /* x: cover LSBs (Uint8Array n), rho: costs (Float32Array n), msg: bits (Uint8Array m)
   * returns { y: stego LSBs, cost, changes } or throws if the message does not fit */
  function stcEmbed(x, rho, msg, key) {
    const n = x.length, m = msg.length;
    if (!m) return { y: Uint8Array.from(x), cost: 0, changes: 0 };
    const w = Math.floor(n / m), rem = n - m * w;
    if (w < 2) throw new Error('STC: payload too large for this cover');
    const hc = hColumns(key, w + 1);
    let cost = new Float64Array(STATES).fill(Infinity), nxt = new Float64Array(STATES);
    cost[0] = 0;
    const back = new Uint32Array(n * WORDS);
    let col = 0;
    for (let j = 0; j < m; j++) {
      const bw = blockWidth(j, w, rem);
      for (let c = 0; c < bw; c++, col++) {
        const hcv = hc[c], xi = x[col], r = rho[col], base = col * WORDS;
        const c0add = xi ? r : 0, c1add = xi ? 0 : r;
        for (let s = 0; s < STATES; s++) {
          const a = cost[s] + c0add, b = cost[s ^ hcv] + c1add;
          if (b < a) { nxt[s] = b; back[base + (s >> 5)] |= 1 << (s & 31); } else nxt[s] = a;
        }
        const t = cost; cost = nxt; nxt = t;
      }
      // row j is complete: its syndrome bit (lowest state bit) must equal msg[j]; shift states down
      const mj = msg[j];
      for (let s = 0; s < STATES >> 1; s++) nxt[s] = cost[(s << 1) | mj];
      for (let s = STATES >> 1; s < STATES; s++) nxt[s] = Infinity;
      const t = cost; cost = nxt; nxt = t;
    }
    // best final state
    let bs = 0, bc = Infinity;
    for (let s = 0; s < STATES; s++) if (cost[s] < bc) { bc = cost[s]; bs = s; }
    if (!isFinite(bc)) throw new Error('STC: no valid path (payload too large)');
    const y = new Uint8Array(n);
    let state = bs; col = n;
    for (let j = m - 1; j >= 0; j--) {
      state = (state << 1) | msg[j];
      const bw = blockWidth(j, w, rem);
      for (let c = bw - 1; c >= 0; c--) {
        col--;
        const bit = (back[col * WORDS + (state >> 5)] >> (state & 31)) & 1;
        y[col] = bit;
        if (bit) state ^= hc[c];
      }
    }
    let changes = 0;
    for (let i = 0; i < n; i++) if (y[i] !== x[i]) changes++;
    return { y, cost: bc, changes };
  }

  /* stego LSBs -> first m message bits */
  function stcExtract(y, m, key) {
    const n = y.length, out = new Uint8Array(m);
    if (!m) return out;
    const w = Math.floor(n / m), rem = n - m * w;
    if (w < 2) return out;
    const hc = hColumns(key, w + 1);
    let col = 0, s = 0;
    for (let j = 0; j < m; j++) {
      const bw = blockWidth(j, w, rem);
      for (let c = 0; c < bw; c++, col++) if (y[col]) s ^= hc[c];
      out[j] = s & 1;
      s >>= 1;
    }
    return out;
  }

  SB.suniCosts = suniCosts;
  SB.stc = { embed: stcEmbed, extract: stcExtract, H };
})();
