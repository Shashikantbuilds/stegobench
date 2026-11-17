/* StegoBench - one benchmark job (embed -> metrics -> attacks -> ECC decode -> score) and result aggregation.
 * Pure functions of their input: the same code runs on the page and inside a Web Worker. */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;
  const SB = root.SB;

  const FORMAT_LABEL = { lossless: 'PNG/BMP', jpeg: 'JPEG' };
  SB.FORMAT_LABEL = FORMAT_LABEL;
  /* goal presets: weights for robustness / imperceptibility / stealth / capacity */
  SB.GOALS = {
    balanced:      { label: 'Balanced',               w: [0.4, 0.2, 0.2, 0.2] },
    robust:        { label: 'Max robustness',         w: [0.7, 0.1, 0.1, 0.1] },
    imperceptible: { label: 'Best imperceptibility',  w: [0.2, 0.6, 0.1, 0.1] },
    stealth:       { label: 'Lowest detectability',   w: [0.2, 0.2, 0.5, 0.1] },
    capacity:      { label: 'Max capacity',           w: [0.2, 0.1, 0.1, 0.6] },
  };
  SB.overall = (r, goal, w) => {
    w = w || SB.GOALS[goal || 'balanced'].w;
    return w[0] * r.robustness + w[1] * r.quality + w[2] * r.stealth + w[3] * r.capScore;
  };

  const refCache = [];   // small LRU of cover reference statistics (keyed per image + carrier format)
  async function getRef(job) {
    const k = job.imageId + '|' + job.fmt + '|' + job.cover.width + 'x' + job.cover.height;
    const hit = refCache.find((e) => e.k === k);
    if (hit) return hit.v;
    const img = job.fmt === 'jpeg' ? await SB.attackFns.jpeg(job.cover, 90) : job.cover;
    const v = { img, stats: SB.metrics.describe(img) };
    refCache.push({ k, v });
    if (refCache.length > 3) refCache.shift();
    return v;
  }

  /* job: { imageId, methodId, fmt, cover:ImageData, bits, key, nsym, frameBits, frameLen, attacks:[spec], wantStego, lite } */
  SB.runJob = async function (job) {
    const m = SB.methodById(job.methodId), w = job.cover.width, h = job.cover.height, key = job.key;
    const res = {
      key: m.id + ':' + job.fmt, id: m.id, name: m.name, domain: m.domain, format: job.fmt, formatLabel: FORMAT_LABEL[job.fmt],
      imageId: job.imageId, trial: job.trial | 0, capacityBits: m.capacityBits(w, h), payloadBits: job.bits.length, attacks: {},
    };
    res.capacityBytes = Math.floor(res.capacityBits / 8);
    res.bpp = res.capacityBits / (w * h);
    if (job.bits.length > res.capacityBits) { res.status = 'skipped'; res.reason = `Payload (${Math.ceil(job.bits.length / 8)} B) exceeds capacity (${res.capacityBytes} B) for this image`; return res; }

    let stegoRaw, stego;
    try {
      stegoRaw = m.embed(job.cover, job.bits, key);
      stego = job.fmt === 'jpeg' ? await SB.attackFns.jpeg(stegoRaw, 90) : stegoRaw;
    } catch (e) { res.status = 'skipped'; res.reason = String((e && e.message) || e); return res; }
    res.status = 'ok';

    let ref = null;
    if (job.lite) {
      const mse = SB.metrics.mse(job.cover, stego);
      res.mse = mse; res.psnr = SB.metrics.psnr(mse);
    } else {
      ref = await getRef(job);
      Object.assign(res, SB.metrics.compare(ref.img, ref.stats, stego));
    }
    if (job.wantStego) res.stego = stego;

    const supported = [];
    for (const spec of job.attacks) {
      let attacked;
      try { attacked = await SB.attackFromSpec(spec)(stego); }
      catch (e) {
        if (e instanceof SB.Unsupported) { res.attacks[spec.id] = { unsupported: true }; continue; }
        throw e;
      }
      const got = m.extract(attacked, job.bits.length, key);
      const dec = SB.pipeline.decodeBits(got, job.nsym, job.frameLen);
      const gotFrameBits = SB.bytesToBits(dec.frame);
      const match = SB.bitMatch(job.frameBits, gotFrameBits);
      res.attacks[spec.id] = {
        match, raw: SB.bitMatch(job.bits, got),
        recovery: Math.max(0, (match - 0.5) * 2) * 100,   // chance-adjusted: 50 % match = 0 % recovery
        exact: match === 1, eccFailed: dec.ecc.failed || 0, eccCorrected: dec.ecc.corrected || 0,
      };
      if (spec.id === 'none' && job.wantStego) res.recoveredFrame = dec.frame;
      if (spec.group !== 'baseline') supported.push(spec.id);
    }
    if (job.lite) return res;

    const refCap = (w * h * 3) / 8;
    res.robustness = supported.length ? supported.reduce((s, id) => s + res.attacks[id].recovery, 0) / supported.length : 0;
    const psnrN = SB.clamp((res.psnr - 30) / 30, 0, 1), ssimN = SB.clamp((res.ssim - 0.95) / 0.05, 0, 1);
    res.quality = 100 * (0.7 * psnrN + 0.3 * ssimN);
    res.stealth = 100 - res.risk;
    res.capScore = 100 * SB.clamp(Math.log10(Math.max(res.capacityBytes, 1)) / Math.log10(refCap), 0, 1);
    const at = res.attacks;
    res.jpeg75 = at.jpeg75 && !at.jpeg75.unsupported ? at.jpeg75.recovery : NaN;
    res.noise = at.gauss && at.sp ? (at.gauss.recovery + at.sp.recovery) / 2 : NaN;
    return res;
  };

  /* ===================================================================== aggregation */
  const NUM = ['psnr', 'ssim', 'mse', 'histDiff', 'chiP', 'hfRatio', 'risk', 'detSignal', 'robustness', 'quality', 'stealth', 'capScore', 'jpeg75', 'noise'];
  const finite = (a) => a.filter((v) => Number.isFinite(v));
  const mean = (a) => { const f = finite(a); return f.length ? SB.stats.mean(f) : NaN; };
  const sd = (a) => SB.stats.std(finite(a));

  /* raw: array of job results (status ok / skipped). ctx: { attacks:[spec], minAuc: min images for ROC } */
  SB.aggregate = function (raw, ctx) {
    const groups = new Map();
    for (const r of raw) { if (!groups.has(r.key)) groups.set(r.key, []); groups.get(r.key).push(r); }
    const out = [];
    for (const [, list] of groups) {
      const ok = list.filter((r) => r.status === 'ok'), first = list[0];
      if (!ok.length) { out.push(Object.assign({}, first, { n: 0 })); continue; }
      const a = Object.assign({}, first, { status: 'ok', n: ok.length, std: {}, samples: {} });
      NUM.forEach((f) => { const v = ok.map((r) => r[f]); a[f] = mean(v); a.std[f] = sd(v); a.samples[f] = v; });
      a.detMeans = {};
      for (const name of ['rs', 'ws', 'chiSeq']) a.detMeans[name] = mean(ok.map((r) => r.det[name] - r.refDet[name]));
      a.sampleKeys = ok.map((r) => r.imageId + '#' + r.trial);
      a.attacks = {};
      const grp = {};
      for (const spec of ctx.attacks) {
        const v = ok.map((r) => r.attacks[spec.id]).filter((x) => x && !x.unsupported);
        if (!v.length) { a.attacks[spec.id] = { unsupported: true }; continue; }
        const rec = v.map((x) => x.recovery);
        a.attacks[spec.id] = { recovery: mean(rec), std: SB.stats.std(rec), match: mean(v.map((x) => x.match)), raw: mean(v.map((x) => x.raw)), exact: v.filter((x) => x.exact).length / v.length, n: v.length, eccFailed: v.reduce((s, x) => s + x.eccFailed, 0) };
        if (spec.group !== 'baseline') (grp[spec.group] = grp[spec.group] || []).push(a.attacks[spec.id].recovery);
      }
      a.groupRobustness = Object.fromEntries(Object.entries(grp).map(([g, v]) => [g, mean(v)]));
      const withStego = ok.find((r) => r.stego);
      if (withStego) { a.stego = withStego.stego; a.recoveredFrame = withStego.recoveredFrame; }
      // classical-detector ROC across images (needs enough images for a meaningful AUC)
      a.detection = null;
      if (ok.length >= (ctx.minAuc || 12)) {
        const det = {};
        for (const name of ['rs', 'ws', 'chiSeq']) {
          const cov = ok.map((r) => r.refDet[name]), ste = ok.map((r) => r.det[name]);
          const roc = SB.stats.roc(cov, ste);
          const flip = roc.auc < 0.5;           // a defender who knows the direction may flip the threshold
          det[name] = { auc: flip ? 1 - roc.auc : roc.auc, rawAuc: roc.auc, pe: roc.pe, curve: roc.curve, inverted: flip };
        }
        const bestName = Object.keys(det).reduce((x, y) => (det[y].auc > det[x].auc ? y : x));
        a.detection = { byDetector: det, best: bestName, auc: det[bestName].auc, pe: det[bestName].pe };
        a.stealthHeuristic = a.stealth;
        a.stealth = 100 * (1 - Math.max(0, 2 * det[bestName].auc - 1));
        a.risk = 100 - a.stealth;
        a.riskLabel = a.risk < 25 ? 'Low' : a.risk < 55 ? 'Medium' : 'High';
      } else a.riskLabel = a.risk < 25 ? 'Low' : a.risk < 55 ? 'Medium' : 'High';
      out.push(a);
    }
    return out;
  };

  /* ===================================================================== ranking analyses */
  /* rows: aggregated ok results. Returns per-row {pFirst, meanRank} over `iters` random weight vectors (Dirichlet) */
  SB.rankStability = function (rows, iters) {
    iters = iters || 600;
    const rng = SB.mulberry32(424242), first = new Float64Array(rows.length), rankSum = new Float64Array(rows.length);
    for (let it = 0; it < iters; it++) {
      const w = SB.stats.randomWeights(4, rng);
      const sc = rows.map((r) => SB.overall(r, null, w));
      const order = sc.map((v, i) => i).sort((i, j) => sc[j] - sc[i]);
      order.forEach((idx, rank) => { rankSum[idx] += rank + 1; });
      first[order[0]]++;
    }
    return rows.map((r, i) => ({ pFirst: first[i] / iters, meanRank: rankSum[i] / iters }));
  };
  /* Pareto-optimal rows on (robustness, quality, stealth, capacity) */
  SB.pareto = (rows) => SB.stats.paretoFront(rows.map((r) => [r.robustness, r.quality, r.stealth, r.capScore]));
})();
