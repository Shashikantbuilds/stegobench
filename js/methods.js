/* StegoBench - the eight embedding methods.
 * Every method exposes:
 *   capacityBits(w,h)              max payload in bits
 *   embed(imageData, bits, key)    -> new ImageData (cover is never modified)
 *   extract(imageData, nbits, key) -> Uint8Array of bits (blind: no cover needed)
 * `key` is a key object from SB.crypto.deriveKey / SB.keyFromNumber (a plain number is accepted too). */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;
  const SB = root.SB;

  const DELTA = 24;       // DCT margin |c1|-|c2| (higher = more robust, lower PSNR)
  const ALPHA = 3;        // spread-spectrum amplitude (gray levels per chip)
  const SS_MIN_L = 64;    // min chips per bit for spread spectrum
  const VOTE_MIN_R = 3;   // min repetitions per bit for DCT+Vote
  const VOTE_MAX_R = 9;   // max repetitions per bit
  const QIM_STEP = 40;    // DWT-QIM quantisation step
  const QIM_MIN_R = 6, QIM_MAX_R = 12;
  const SUNI_RATE = 0.2;  // S-UNIWARD+STC: max payload = 0.2 bits per colour sample (0.6 bpp)
  const PAIRS = [
    [[2, 1], [1, 2]],
    [[3, 1], [1, 3]],
    [[3, 0], [0, 3]],
  ];

  const sampleToPos = (s) => ((s / 3) | 0) * 4 + (s % 3); // RGB sample index -> RGBA byte offset

  /* ------------------------------------------------------------------ LSB */
  function lsbWrite(img, bits, indexAt) {
    const out = SB.cloneImage(img), d = out.data;
    for (let i = 0; i < bits.length; i++) {
      const p = sampleToPos(indexAt(i));
      d[p] = (d[p] & 254) | bits[i];
    }
    return out;
  }
  function lsbRead(img, n, indexAt) {
    const bits = new Uint8Array(n);
    for (let i = 0; i < n; i++) bits[i] = img.data[sampleToPos(indexAt(i))] & 1;
    return bits;
  }

  const seqLSB = {
    id: 'seqlsb', name: 'Sequential LSB', domain: 'Spatial',
    info: 'Replaces the least-significant bit of the first samples in raster order. Simple, huge capacity, trivially detected and destroyed by any re-compression.',
    capacityBits: (w, h) => w * h * 3,
    embed: (img, bits) => lsbWrite(img, bits, (i) => i),
    extract: (img, n) => lsbRead(img, n, (i) => i),
  };

  const rndLSB = {
    id: 'rndlsb', name: 'Random LSB', domain: 'Spatial',
    info: 'LSB replacement at key-selected random positions. Hides from naive visual and histogram checks; still fragile and still LSB-replacement detectable at higher rates.',
    capacityBits: (w, h) => w * h * 3,
    embed(img, bits, key) {
      const idx = SB.sampleIndices(img.width * img.height * 3, bits.length, SB.keyedRng(key, 0x1515));
      return lsbWrite(img, bits, (i) => idx[i]);
    },
    extract(img, n, key) {
      const idx = SB.sampleIndices(img.width * img.height * 3, n, SB.keyedRng(key, 0x1515));
      return lsbRead(img, n, (i) => idx[i]);
    },
  };

  /* LSB matching (+-1): when the LSB is wrong, add or subtract 1 at random.
   * Removes the pairs-of-values asymmetry that chi-square / RS / WS rely on. */
  const lsbMatch = {
    id: 'lsbm', name: 'LSB Matching (±1)', domain: 'Spatial',
    info: 'Like random LSB, but a wrong LSB is fixed by randomly adding or subtracting 1. Defeats the chi-square pairs test; still not robust to re-compression.',
    capacityBits: (w, h) => w * h * 3,
    embed(img, bits, key) {
      const idx = SB.sampleIndices(img.width * img.height * 3, bits.length, SB.keyedRng(key, 0x1b3));
      const dir = SB.keyedRng(key, 0x1b4), out = SB.cloneImage(img), d = out.data;
      for (let i = 0; i < bits.length; i++) {
        const p = sampleToPos(idx[i]), v = d[p];
        if ((v & 1) !== bits[i]) d[p] = v === 0 ? 1 : v === 255 ? 254 : dir() < 0.5 ? v - 1 : v + 1;
      }
      return out;
    },
    extract(img, n, key) {
      const idx = SB.sampleIndices(img.width * img.height * 3, n, SB.keyedRng(key, 0x1b3));
      return lsbRead(img, n, (i) => idx[i]);
    },
  };

  /* ------------------------------------------------- DCT (Koch-Zhao) core */
  const idxOf = (p) => p[1] * 8 + p[0];
  function setMargin(co, pair, bit) {
    const i1 = idxOf(pair[0]), i2 = idxOf(pair[1]);
    const s1 = co[i1] < 0 ? -1 : 1, s2 = co[i2] < 0 ? -1 : 1;
    let A = Math.abs(co[i1]), B = Math.abs(co[i2]);
    const want = bit ? A - B : B - A;
    if (want < DELTA) {
      const m = (A + B) / 2;
      let hi = m + DELTA / 2, lo = m - DELTA / 2;
      if (lo < 0) { lo = 0; hi = DELTA; }
      if (bit) { A = hi; B = lo; } else { A = lo; B = hi; }
    }
    co[i1] = s1 * A; co[i2] = s2 * B;
  }
  const getMargin = (co, pair) => Math.abs(co[idxOf(pair[0])]) - Math.abs(co[idxOf(pair[1])]);
  const nBlocks = (w, h) => (w >> 3) * (h >> 3);

  function dctEmbed(img, blocks, bitFor, key) {
    const w = img.width, h = img.height, bw = w >> 3, kw = SB.keyWord(key, 0xd0c7);
    const Y = SB.lumaPlane(img);
    const dY = new Float32Array(w * h);
    const buf = new Float64Array(64), co = new Float64Array(64), rec = new Float64Array(64);
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[k];
      const x0 = (b % bw) * 8, y0 = ((b / bw) | 0) * 8;
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) buf[r * 8 + c] = Y[(y0 + r) * w + x0 + c];
      SB.dct8(buf, co);
      setMargin(co, PAIRS[SB.hash32((b + 1) ^ kw) % 3], bitFor(k));
      SB.idct8(co, rec);
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) dY[(y0 + r) * w + x0 + c] = rec[r * 8 + c] - buf[r * 8 + c];
    }
    const out = SB.cloneImage(img);
    SB.applyLumaDelta(out, dY);
    return out;
  }
  function dctMargins(img, blocks, key) {
    const w = img.width, bw = w >> 3, kw = SB.keyWord(key, 0xd0c7);
    const Y = SB.lumaPlane(img);
    const m = new Float64Array(blocks.length);
    const buf = new Float64Array(64), co = new Float64Array(64);
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[k];
      const x0 = (b % bw) * 8, y0 = ((b / bw) | 0) * 8;
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) buf[r * 8 + c] = Y[(y0 + r) * w + x0 + c];
      SB.dct8(buf, co);
      m[k] = getMargin(co, PAIRS[SB.hash32((b + 1) ^ kw) % 3]);
    }
    return m;
  }
  const blockRng = (key) => SB.keyedRng(key, 0xb10c);

  const dct = {
    id: 'dct', name: 'DCT (Koch-Zhao)', domain: 'Transform',
    info: 'One bit per 8×8 block: the order of two mid-frequency DCT coefficients encodes the bit. Survives moderate JPEG, but needs the block grid to stay aligned.',
    capacityBits: (w, h) => nBlocks(w, h),
    embed(img, bits, key) {
      const blocks = SB.sampleIndices(nBlocks(img.width, img.height), bits.length, blockRng(key));
      return dctEmbed(img, blocks, (k) => bits[k], key);
    },
    extract(img, n, key) {
      const blocks = SB.sampleIndices(nBlocks(img.width, img.height), n, blockRng(key));
      const m = dctMargins(img, blocks, key);
      const bits = new Uint8Array(n);
      for (let i = 0; i < n; i++) bits[i] = m[i] > 0 ? 1 : 0;
      return bits;
    },
  };

  /* ---------------------------------------------- DCT + Vote (repetition) */
  function voteR(w, h, n) {
    let R = Math.floor(nBlocks(w, h) / n);
    R = Math.min(R, VOTE_MAX_R);
    if (R % 2 === 0) R--;
    return R;
  }
  const dctVote = {
    id: 'dctvote', name: 'DCT + Vote (ECC)', domain: 'Hybrid',
    info: 'DCT embedding with each bit repeated in 3–9 blocks and decoded by soft majority vote. Trades capacity for robustness.',
    capacityBits: (w, h) => Math.floor(nBlocks(w, h) / VOTE_MIN_R),
    embed(img, bits, key) {
      const R = voteR(img.width, img.height, bits.length);
      const blocks = SB.sampleIndices(nBlocks(img.width, img.height), bits.length * R, blockRng(key));
      return dctEmbed(img, blocks, (k) => bits[(k / R) | 0], key);
    },
    extract(img, n, key) {
      const R = voteR(img.width, img.height, n);
      const blocks = SB.sampleIndices(nBlocks(img.width, img.height), n * R, blockRng(key));
      const m = dctMargins(img, blocks, key);
      const bits = new Uint8Array(n);
      const clip = DELTA * 2;
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let r = 0; r < R; r++) s += SB.clamp(m[i * R + r], -clip, clip);
        bits[i] = s > 0 ? 1 : 0;
      }
      return bits;
    },
  };

  /* ---------------------------------------------------- Spread spectrum */
  function ssLayout(w, h, n, key) {
    const cw = w >> 1, ch = h >> 1, N = cw * ch;
    const L = Math.floor(N / n);
    const perm = SB.shuffle(N, SB.keyedRng(key, 0x5575));
    const prng = SB.keyedRng(key, 0x9a11);
    const pn = new Int8Array(N);
    for (let i = 0; i < N; i++) pn[i] = prng() < 0.5 ? -1 : 1;
    return { cw, ch, N, L, perm, pn };
  }
  const spread = {
    id: 'spread', name: 'Spread Spectrum', domain: 'Transform',
    info: 'Adds a faint key-dependent ±3 noise pattern over thousands of 2×2 cells per bit and detects it by correlation. Very robust to noise and JPEG; low capacity.',
    capacityBits: (w, h) => Math.floor(((w >> 1) * (h >> 1)) / SS_MIN_L),
    embed(img, bits, key) {
      const w = img.width, h = img.height, n = bits.length;
      const { cw, L, perm, pn } = ssLayout(w, h, n, key);
      const dY = new Float32Array(w * h);
      for (let i = 0; i < n; i++) {
        const sgn = bits[i] ? 1 : -1;
        for (let t = 0; t < L; t++) {
          const c = perm[i * L + t];
          const x = (c % cw) * 2, y = ((c / cw) | 0) * 2;
          const v = ALPHA * sgn * pn[c];
          dY[y * w + x] = v; dY[y * w + x + 1] = v;
          dY[(y + 1) * w + x] = v; dY[(y + 1) * w + x + 1] = v;
        }
      }
      const out = SB.cloneImage(img);
      SB.applyLumaDelta(out, dY);
      return out;
    },
    extract(img, n, key) {
      const w = img.width, h = img.height;
      const { cw, L, perm, pn } = ssLayout(w, h, n, key);
      const Y = SB.lumaPlane(img);
      const W1 = w + 1;
      const I = new Float64Array(W1 * (h + 1));
      for (let y = 0; y < h; y++) {
        let row = 0;
        for (let x = 0; x < w; x++) {
          row += Y[y * w + x];
          I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + row;
        }
      }
      const HP = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - 2), y1 = Math.min(h, y + 3);
        for (let x = 0; x < w; x++) {
          const x0 = Math.max(0, x - 2), x1 = Math.min(w, x + 3);
          const sum = I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
          HP[y * w + x] = Y[y * w + x] - sum / ((x1 - x0) * (y1 - y0));
        }
      }
      const bits = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let t = 0; t < L; t++) {
          const c = perm[i * L + t];
          const x = (c % cw) * 2, y = ((c / cw) | 0) * 2;
          s += pn[c] * (HP[y * w + x] + HP[y * w + x + 1] + HP[(y + 1) * w + x] + HP[(y + 1) * w + x + 1]);
        }
        bits[i] = s > 0 ? 1 : 0;
      }
      return bits;
    },
  };

  /* ------------------------------------- DWT (2-level Haar) + dithered QIM */
  function haar2(src, w, h) {            // one level on w x h (both even) -> LL,HL,LH,HH, each (w/2 x h/2)
    const cw = w >> 1, ch = h >> 1, n = cw * ch;
    const LL = new Float32Array(n), HL = new Float32Array(n), LH = new Float32Array(n), HH = new Float32Array(n);
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        const a = src[2 * y * w + 2 * x], b = src[2 * y * w + 2 * x + 1], c = src[(2 * y + 1) * w + 2 * x], d = src[(2 * y + 1) * w + 2 * x + 1];
        const i = y * cw + x;
        LL[i] = (a + b + c + d) / 2; HL[i] = (a - b + c - d) / 2; LH[i] = (a + b - c - d) / 2; HH[i] = (a - b - c + d) / 2;
      }
    return { LL, HL, LH, HH, cw, ch };
  }
  function ihaar2(LL, HL, LH, HH, cw, ch) {
    const w = cw * 2, out = new Float32Array(w * ch * 2);
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        const i = y * cw + x, l = LL[i], hl = HL[i], lh = LH[i], hh = HH[i];
        out[2 * y * w + 2 * x] = (l + hl + lh + hh) / 2;
        out[2 * y * w + 2 * x + 1] = (l - hl + lh - hh) / 2;
        out[(2 * y + 1) * w + 2 * x] = (l + hl - lh - hh) / 2;
        out[(2 * y + 1) * w + 2 * x + 1] = (l - hl - lh + hh) / 2;
      }
    return out;
  }
  function dwtGeom(w, h) {
    const W = w & ~3, Hh = h & ~3;               // work on the area divisible by 4
    return { W, H: Hh, cw: W >> 2, ch: Hh >> 2, slots: 2 * (W >> 2) * (Hh >> 2) };
  }
  function dwtR(slots, n) { return Math.max(1, Math.min(QIM_MAX_R, Math.floor(slots / n))); }
  function cropPlane(Y, w, W, H) {
    if (W === w) return Y;
    const o = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) o[y * W + x] = Y[y * w + x];
    return o;
  }
  const dwtQim = {
    id: 'dwt', name: 'DWT-QIM (Haar)', domain: 'Transform',
    info: 'Quantisation-index modulation on level-2 Haar wavelet coefficients (HL and LH bands) with a key-dependent dither; every bit is repeated 6–12 times.',
    capacityBits: (w, h) => Math.floor(dwtGeom(w, h).slots / QIM_MIN_R),
    embed(img, bits, key) {
      const w = img.width, h = img.height, g = dwtGeom(w, h), n = bits.length, R = dwtR(g.slots, n);
      const Y = cropPlane(SB.lumaPlane(img), w, g.W, g.H);
      const l1 = haar2(Y, g.W, g.H), l2 = haar2(l1.LL, l1.cw, l1.ch);
      const slots = SB.sampleIndices(g.slots, n * R, SB.keyedRng(key, 0xd3a1));
      const dith = SB.keyedRng(key, 0xd3a2), step = QIM_STEP, half = step / 2;
      const bands = [l2.HL, l2.LH];
      const dArr = new Float32Array(g.slots);
      for (let i = 0; i < g.slots; i++) dArr[i] = dith() * step;
      for (let k = 0; k < slots.length; k++) {
        const s = slots[k], band = bands[s & 1], pos = s >> 1, b = bits[(k / R) | 0], u = dArr[s];
        const c = band[pos] - u - b * half;
        band[pos] = Math.round(c / step) * step + b * half + u;
      }
      const LL1 = ihaar2(l2.LL, l2.HL, l2.LH, l2.HH, l2.cw, l2.ch);
      const Yr = ihaar2(LL1, l1.HL, l1.LH, l1.HH, l1.cw, l1.ch);
      const dY = new Float32Array(w * h);
      for (let y = 0; y < g.H; y++) for (let x = 0; x < g.W; x++) dY[y * w + x] = Yr[y * g.W + x] - Y[y * g.W + x];
      const out = SB.cloneImage(img);
      SB.applyLumaDelta(out, dY);
      return out;
    },
    extract(img, n, key) {
      const w = img.width, h = img.height, g = dwtGeom(w, h), R = dwtR(g.slots, n);
      const Y = cropPlane(SB.lumaPlane(img), w, g.W, g.H);
      const l1 = haar2(Y, g.W, g.H), l2 = haar2(l1.LL, l1.cw, l1.ch);
      const slots = SB.sampleIndices(g.slots, n * R, SB.keyedRng(key, 0xd3a1));
      const dith = SB.keyedRng(key, 0xd3a2), step = QIM_STEP, half = step / 2;
      const bands = [l2.HL, l2.LH];
      const dArr = new Float32Array(g.slots);
      for (let i = 0; i < g.slots; i++) dArr[i] = dith() * step;
      const bits = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let r = 0; r < R; r++) {
          const s = slots[i * R + r], c = bands[s & 1][s >> 1] - dArr[s];
          const d0 = Math.abs(c - Math.round(c / step) * step);
          const c1 = c - half, d1 = Math.abs(c1 - Math.round(c1 / step) * step);
          sum += SB.clamp(d0 - d1, -half / 2, half / 2);      // >0 : closer to the bit-1 lattice
        }
        bits[i] = sum > 0 ? 1 : 0;
      }
      return bits;
    },
  };

  /* ------------------------------------- S-UNIWARD costs + syndrome-trellis */
  const suni = {
    id: 'suni', name: 'S-UNIWARD + STC', domain: 'Adaptive',
    info: 'Content-adaptive ±1 embedding: wavelet-based costs steer changes to textured regions, and syndrome-trellis codes minimise the total cost. State of the art against statistical detectors; no robustness to re-compression.',
    capacityBits: (w, h) => Math.floor(w * h * 3 * SUNI_RATE),
    embed(img, bits, key) {
      const w = img.width, h = img.height, N = w * h, n = N * 3;
      const x = new Uint8Array(n), rho = new Float32Array(n);
      for (let c = 0; c < 3; c++) {
        const plane = SB.channelPlane(img, c), cost = SB.suniCosts(plane, w, h);
        for (let i = 0; i < N; i++) { x[c * N + i] = img.data[i * 4 + c] & 1; rho[c * N + i] = cost[i]; }
      }
      const { y } = SB.stc.embed(x, rho, bits, key);
      const out = SB.cloneImage(img), d = out.data, dir = SB.keyedRng(key, 0x5d1);
      for (let c = 0; c < 3; c++)
        for (let i = 0; i < N; i++) {
          if (y[c * N + i] === x[c * N + i]) continue;
          const p = i * 4 + c, v = d[p];
          d[p] = v === 0 ? 1 : v === 255 ? 254 : dir() < 0.5 ? v - 1 : v + 1;
        }
      return out;
    },
    extract(img, n, key) {
      const N = img.width * img.height, y = new Uint8Array(N * 3);
      for (let c = 0; c < 3; c++) for (let i = 0; i < N; i++) y[c * N + i] = img.data[i * 4 + c] & 1;
      return SB.stc.extract(y, n, key);
    },
  };

  SB.METHODS = [seqLSB, rndLSB, lsbMatch, suni, dct, dctVote, spread, dwtQim];
  SB.methodById = (id) => SB.METHODS.find((m) => m.id === id);
  SB.params = { DELTA, ALPHA, SS_MIN_L, VOTE_MIN_R, VOTE_MAX_R, QIM_STEP, QIM_MIN_R, QIM_MAX_R, SUNI_RATE, STC_H: 7 };
})();
