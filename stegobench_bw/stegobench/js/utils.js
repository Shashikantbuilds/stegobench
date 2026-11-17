/* StegoBench - shared helpers (keyed PRNG, bytes/bits, luma, 8x8 DCT, statistics, canvas helper)
 * Works on the page AND inside a Web Worker (no top-level DOM access). */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;
  const SB = (root.SB = root.SB || {});
  SB.VERSION = '2.0.0';

  /* ---------- plain PRNGs ---------- */
  SB.mulberry32 = function (seed) {           // used for attack noise (fixed seeds, reproducible)
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  SB.hash32 = function (x) {
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    return (x ^ (x >>> 16)) >>> 0;
  };
  function sfc32(a, b, c, d) {                 // 128-bit state generator
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  /* ---------- key material ----------
   * A "key" is { w: [4 x uint32], aes: CryptoKey|null, label }.
   * Passphrase keys come from PBKDF2 (see codec.js). Plain numbers are still accepted
   * (legacy / tests) and expanded deterministically into 128 bits. */
  SB.keyFromNumber = function (n) {
    n = n | 0;
    const w = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) w[i] = SB.hash32(Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(i + 1, 0xc2b2ae35));
    return { w, aes: null, label: 'number:' + n };
  };
  SB.asKey = function (key) {
    if (key && key.w) return key;
    if (typeof key === 'number') return SB.keyFromNumber(key);
    throw new Error('Invalid key');
  };
  /* 32-bit word derived from the key and a salt (domain separation) */
  SB.keyWord = function (key, salt) {
    const k = SB.asKey(key).w;
    let h = SB.hash32((salt | 0) ^ 0x243f6a88);
    for (let i = 0; i < 4; i++) h = SB.hash32(h ^ k[i]) + Math.imul(i + 7, 0x9e3779b1) >>> 0;
    return SB.hash32(h);
  };
  /* keyed generator: sfc32 seeded with 128 bits mixed from key and salt */
  SB.keyedRng = function (key, salt) {
    const r = sfc32(SB.keyWord(key, salt ^ 0x1111), SB.keyWord(key, salt ^ 0x2222), SB.keyWord(key, salt ^ 0x3333), SB.keyWord(key, salt ^ 0x4444));
    for (let i = 0; i < 16; i++) r();
    return r;
  };

  /* k distinct indices out of [0,N) in key-dependent order (sparse Fisher-Yates) */
  SB.sampleIndices = function (N, k, rng) {
    const out = new Uint32Array(k);
    const swapped = new Map();
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(rng() * (N - i));
      const vj = swapped.has(j) ? swapped.get(j) : j;
      const vi = swapped.has(i) ? swapped.get(i) : i;
      out[i] = vj;
      swapped.set(j, vi);
    }
    return out;
  };
  SB.shuffle = function (n, rng) {
    const a = new Uint32Array(n);
    for (let i = 0; i < n; i++) a[i] = i;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };

  /* ---------- bytes / bits / text ---------- */
  SB.bytesToBits = function (bytes) {
    const bits = new Uint8Array(bytes.length * 8);
    for (let i = 0; i < bytes.length; i++)
      for (let j = 0; j < 8; j++) bits[i * 8 + j] = (bytes[i] >> (7 - j)) & 1;
    return bits;
  };
  SB.bitsToBytes = function (bits) {
    const n = Math.ceil(bits.length / 8);
    const bytes = new Uint8Array(n);
    for (let i = 0; i < bits.length; i++) if (bits[i]) bytes[i >> 3] |= 128 >> (i & 7);
    return bytes;
  };
  SB.textToBits = (text) => SB.bytesToBits(new TextEncoder().encode(text));
  SB.bitsToText = (bits) => new TextDecoder('utf-8', { fatal: false }).decode(SB.bitsToBytes(bits.slice(0, bits.length - (bits.length % 8))));
  SB.concatBytes = function () {
    let n = 0; for (const a of arguments) n += a.length;
    const out = new Uint8Array(n); let o = 0;
    for (const a of arguments) { out.set(a, o); o += a.length; }
    return out;
  };
  const CRC_T = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; }
  SB.crc32 = function (bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_T[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  SB.bitMatch = function (a, b) {
    const n = Math.min(a.length, b.length);
    if (!n) return 0;
    let ok = 0;
    for (let i = 0; i < n; i++) if (a[i] === b[i]) ok++;
    return ok / a.length;
  };

  /* ---------- image helpers ---------- */
  SB.clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  SB.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  SB.cloneImage = (img) => new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  SB.lumaPlane = function (img) {
    const { data, width: w, height: h } = img;
    const Y = new Float32Array(w * h);
    for (let i = 0, p = 0; i < Y.length; i++, p += 4) Y[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    return Y;
  };
  SB.channelPlane = function (img, c) {
    const { data, width: w, height: h } = img;
    const P = new Float32Array(w * h);
    for (let i = 0, p = c; i < P.length; i++, p += 4) P[i] = data[p];
    return P;
  };
  SB.applyLumaDelta = function (img, dY) {
    const d = img.data;
    for (let i = 0, p = 0; i < dY.length; i++, p += 4) {
      const v = dY[i];
      if (v !== 0) { d[p] += v; d[p + 1] += v; d[p + 2] += v; }
    }
  };
  /* canvas that works on the page and in a worker */
  SB.makeCanvas = function (w, h) {
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
    }
    return new OffscreenCanvas(w, h);
  };
  SB.tick = () => new Promise((r) => setTimeout(r, 0));
  SB.fmtBytes = function (n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  };

  /* ---------- 8x8 orthonormal DCT-II ---------- */
  const C = new Float64Array(64);
  for (let u = 0; u < 8; u++)
    for (let x = 0; x < 8; x++)
      C[u * 8 + x] = (u === 0 ? Math.sqrt(1 / 8) : Math.sqrt(2 / 8)) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  const tmp = new Float64Array(64);
  SB.dct8 = function (inp, out) {
    for (let y = 0; y < 8; y++)
      for (let u = 0; u < 8; u++) {
        let s = 0;
        for (let x = 0; x < 8; x++) s += C[u * 8 + x] * inp[y * 8 + x];
        tmp[y * 8 + u] = s;
      }
    for (let u = 0; u < 8; u++)
      for (let v = 0; v < 8; v++) {
        let s = 0;
        for (let y = 0; y < 8; y++) s += C[v * 8 + y] * tmp[y * 8 + u];
        out[v * 8 + u] = s;
      }
  };
  SB.idct8 = function (inp, out) {
    for (let v = 0; v < 8; v++)
      for (let x = 0; x < 8; x++) {
        let s = 0;
        for (let u = 0; u < 8; u++) s += C[u * 8 + x] * inp[v * 8 + u];
        tmp[v * 8 + x] = s;
      }
    for (let x = 0; x < 8; x++)
      for (let y = 0; y < 8; y++) {
        let s = 0;
        for (let v = 0; v < 8; v++) s += C[v * 8 + y] * tmp[v * 8 + x];
        out[y * 8 + x] = s;
      }
  };

  /* ---------- statistics ---------- */
  const S = (SB.stats = {});
  S.mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  S.std = (a) => {
    if (a.length < 2) return 0;
    const m = S.mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
  };
  function erf(x) {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  SB.erf = erf;
  S.normalCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
  /* Wilcoxon signed-rank test, paired, two-sided, normal approximation with tie + continuity correction.
   * Returns { n, W, z, p, medianDiff } (p = NaN if fewer than 6 non-zero pairs). */
  S.wilcoxon = function (a, b) {
    const d = [];
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const x = a[i] - b[i]; if (Math.abs(x) > 1e-12) d.push(x); }
    const n = d.length;
    const sorted = [...d].sort((x, y) => x - y);
    const medianDiff = n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : 0;
    if (n < 6) return { n, W: NaN, z: NaN, p: NaN, medianDiff };
    const idx = d.map((v, i) => i).sort((i, j) => Math.abs(d[i]) - Math.abs(d[j]));
    const rank = new Float64Array(n);
    let tieTerm = 0;
    for (let i = 0; i < n;) {
      let j = i;
      while (j + 1 < n && Math.abs(d[idx[j + 1]]) === Math.abs(d[idx[i]])) j++;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) rank[idx[k]] = r;
      const t = j - i + 1; tieTerm += t * t * t - t;
      i = j + 1;
    }
    let Wp = 0;
    for (let i = 0; i < n; i++) if (d[i] > 0) Wp += rank[i];
    const mu = (n * (n + 1)) / 4;
    const sd = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - tieTerm / 48);
    const z = sd > 0 ? (Math.abs(Wp - mu) - 0.5) / sd * Math.sign(Wp - mu) : 0;
    const p = Math.min(1, 2 * (1 - S.normalCdf(Math.abs(z))));
    return { n, W: Wp, z, p, medianDiff };
  };
  /* ROC area (Mann-Whitney) for "stego scores higher than cover" + minimum average error P_E */
  S.roc = function (cover, stego) {
    const nc = cover.length, ns = stego.length;
    if (!nc || !ns) return { auc: NaN, pe: NaN, curve: [] };
    const all = [];
    cover.forEach((v) => all.push([v, 0]));
    stego.forEach((v) => all.push([v, 1]));
    all.sort((a, b) => a[0] - b[0]);
    // AUC via rank sum with ties
    let rs = 0;
    for (let i = 0; i < all.length;) {
      let j = i;
      while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) if (all[k][1] === 1) rs += r;
      i = j + 1;
    }
    const auc = (rs - (ns * (ns + 1)) / 2) / (nc * ns);
    // ROC curve and P_E: threshold sweeps from high to low
    const curve = [[0, 0]];
    let tp = 0, fp = 0, pe = 0.5;
    for (let i = all.length - 1; i >= 0;) {
      let j = i;
      while (j - 1 >= 0 && all[j - 1][0] === all[i][0]) j--;
      for (let k = i; k >= j; k--) all[k][1] ? tp++ : fp++;
      curve.push([fp / nc, tp / ns]);
      pe = Math.min(pe, 0.5 * (fp / nc + (1 - tp / ns)));
      i = j - 1;
    }
    return { auc, pe, curve };
  };
  /* Dirichlet(1,..,1) weight vectors for rank-stability analysis */
  S.randomWeights = function (k, rng) {
    const e = Array.from({ length: k }, () => -Math.log(Math.max(rng(), 1e-12)));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map((v) => v / s);
  };
  /* indices of non-dominated rows (all columns: higher is better) */
  S.paretoFront = function (rows) {
    return rows.map((r, i) => !rows.some((q, j) => j !== i && q.every((v, k) => v >= r[k]) && q.some((v, k) => v > r[k])));
  };
})();
