/* StegoBench - quality and detectability metrics */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;
  const SB = root.SB;

  function mse(a, b) {
    let s = 0, n = 0;
    const da = a.data, db = b.data;
    for (let i = 0; i < da.length; i += 4)
      for (let c = 0; c < 3; c++) { const d = da[i + c] - db[i + c]; s += d * d; n++; }
    return s / n;
  }
  const psnr = (m) => (m === 0 ? 99 : Math.min(99, 10 * Math.log10((255 * 255) / m)));

  /* ---- SSIM (Wang et al. 2004): 11x11 Gaussian window, sigma 1.5, on luminance, mean over valid region */
  const KW = 11, KS = 1.5;
  const KERNEL = (() => {
    const k = new Float64Array(KW); let s = 0;
    for (let i = 0; i < KW; i++) { const x = i - (KW - 1) / 2; k[i] = Math.exp(-(x * x) / (2 * KS * KS)); s += k[i]; }
    return k.map((v) => v / s);
  })();
  function filterValid(src, w, h) {
    const ow = w - KW + 1, oh = h - KW + 1, tmp = new Float32Array(ow * h), out = new Float32Array(ow * oh);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < ow; x++) {
        let s = 0;
        for (let t = 0; t < KW; t++) s += KERNEL[t] * src[y * w + x + t];
        tmp[y * ow + x] = s;
      }
    for (let y = 0; y < oh; y++)
      for (let x = 0; x < ow; x++) {
        let s = 0;
        for (let t = 0; t < KW; t++) s += KERNEL[t] * tmp[(y + t) * ow + x];
        out[y * ow + x] = s;
      }
    return out;
  }
  const sq = (a) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * a[i]; return o; };
  function ssimPrep(Y, w, h) { return { mu: filterValid(Y, w, h), s2: filterValid(sq(Y), w, h) }; }
  function ssim(prepA, Ya, Yb, w, h) {
    if (w < KW || h < KW) return 1;
    const C1 = 6.5025, C2 = 58.5225, b = ssimPrep(Yb, w, h);
    const prod = new Float32Array(Ya.length);
    for (let i = 0; i < prod.length; i++) prod[i] = Ya[i] * Yb[i];
    const sab = filterValid(prod, w, h), n = sab.length;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const ma = prepA.mu[i], mb = b.mu[i];
      const va = prepA.s2[i] - ma * ma, vb = b.s2[i] - mb * mb, cv = sab[i] - ma * mb;
      sum += ((2 * ma * mb + C1) * (2 * cv + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
    }
    return sum / n;
  }

  function histDiff(ha, hb) {
    let s = 0, n = 0;
    for (let i = 0; i < 256; i++) { s += Math.abs(ha[i] - hb[i]); n += ha[i]; }
    return s / (2 * n);
  }
  /* std-dev of the high-frequency residual (pixel minus mean of its 4 neighbours) */
  function hfStd(Y, w, h) {
    let s = 0, s2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        const r = Y[p] - (Y[p - 1] + Y[p + 1] + Y[p - w] + Y[p + w]) / 4;
        s += r; s2 += r * r; n++;
      }
    const m = s / n;
    return Math.sqrt(Math.max(0, s2 / n - m * m));
  }

  /* statistics of the reference (the cover as stored in the carrier format) */
  function describe(img) {
    const Y = SB.lumaPlane(img), hist = SB.detectors.histogram(img);
    return { Y, hist, ssimPrep: ssimPrep(Y, img.width, img.height), hf: hfStd(Y, img.width, img.height), det: SB.detectors.run(img), chiP: SB.detectors.chiLSB(hist) };
  }

  const DET_SCALE = 0.1;   // an RS/WS estimate 0.1 above the cover's counts as "fully detected"
  /* compare stego against its reference */
  function compare(refImg, ref, stego) {
    const w = stego.width, h = stego.height;
    const Y = SB.lumaPlane(stego), hist = SB.detectors.histogram(stego);
    const m = mse(refImg, stego), det = SB.detectors.run(stego);
    const out = {
      mse: m, psnr: psnr(m), ssim: ssim(ref.ssimPrep, ref.Y, Y, w, h),
      histDiff: histDiff(ref.hist, hist), chiP: SB.detectors.chiLSB(hist),
      hfRatio: hfStd(Y, w, h) / (ref.hf || 1) - 1,
      det, refDet: ref.det,
    };
    const rsSig = SB.clamp((det.rs - ref.det.rs) / DET_SCALE, 0, 1);
    const wsSig = SB.clamp((det.ws - ref.det.ws) / DET_SCALE, 0, 1);
    const chiSig = SB.clamp(det.chiSeq - ref.det.chiSeq, 0, 1);
    const distort = SB.clamp((55 - out.psnr) / 25, 0, 1);
    const hfSig = SB.clamp(out.hfRatio / 0.25, 0, 1);
    out.detSignal = Math.max(rsSig, wsSig, chiSig);
    // Detection risk 0..100: visible distortion 30 %, strongest classical detector (RS / WS / progressive chi-square) 50 %, HF-noise growth 20 %
    out.risk = Math.round(100 * (0.3 * distort + 0.5 * out.detSignal + 0.2 * hfSig));
    out.riskLabel = out.risk < 25 ? 'Low' : out.risk < 55 ? 'Medium' : 'High';
    return out;
  }

  SB.metrics = { mse, psnr, ssim, histDiff, hfStd, describe, compare, DET_SCALE };
})();
