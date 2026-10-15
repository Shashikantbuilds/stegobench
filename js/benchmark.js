/* StegoBench - benchmark orchestration (page side): keys, framing, job scheduling on a worker pool,
 * dataset aggregation, payload sweep and breakpoint analysis. The per-job maths lives in job.js. */
(function () {
  'use strict';
  const SB = window.SB;

  /* ===================================================================== worker pool */
  SB.createPool = function (size, useWorkers) {
    const pool = { size: 1, kind: 'main', failed: false };
    let workers = [], url = null;
    if (useWorkers && typeof Worker !== 'undefined' && window.SB_WORKER_SRC) {
      try {
        url = URL.createObjectURL(new Blob([window.SB_WORKER_SRC], { type: 'text/javascript' }));
        workers = Array.from({ length: size }, () => new Worker(url));
        pool.size = size; pool.kind = 'workers';
      } catch (e) { workers = []; pool.kind = 'main'; pool.size = 1; }
    }
    const idle = workers.map((w, i) => i), queue = new Map(), waiting = [];
    let seq = 0;
    function pump() {
      while (idle.length && waiting.length) {
        const wi = idle.shift(), t = waiting.shift(), id = ++seq;
        queue.set(id, { t, wi });
        workers[wi].postMessage({ id, job: t.job });
      }
    }
    workers.forEach((w, wi) => {
      w.onmessage = (e) => {
        const { id, res, error } = e.data, q = queue.get(id);
        if (!q) return;
        queue.delete(id); idle.push(q.wi);
        error ? q.t.reject(new Error(error)) : q.t.resolve(res);
        pump();
      };
      w.onerror = (e) => {                      // e.g. workers blocked by the browser: fall back to the page thread
        pool.failed = true; pool.kind = 'main (worker error)';
        const lost = [...queue.values()].map((q) => q.t).concat(waiting.splice(0));
        queue.clear();
        lost.forEach((t) => SB.runJob(t.job).then(t.resolve, t.reject));
        if (e && e.preventDefault) e.preventDefault();
      };
    });
    pool.run = (job) => {
      if (!workers.length || pool.failed) return SB.runJob(job);
      return new Promise((resolve, reject) => { waiting.push({ job, resolve, reject }); pump(); });
    };
    pool.close = () => { workers.forEach((w) => w.terminate()); if (url) URL.revokeObjectURL(url); };
    return pool;
  };
  const defaultWorkers = () => Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

  /* run `jobs` with bounded concurrency; onDone(result, job) after each */
  async function runAll(pool, jobs, onDone) {
    const results = new Array(jobs.length);
    let next = 0;
    const lanes = Array.from({ length: pool.kind === 'workers' ? pool.size : 1 }, async () => {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await pool.run(jobs[i]);
        onDone && onDone(results[i], jobs[i]);
        if (pool.kind !== 'workers') await SB.tick();
      }
    });
    await Promise.all(lanes);
    return results;
  }
  const COST = { suni: 5, spread: 1.5, dwt: 1.3, dct: 1.2, dctvote: 1.2 };
  const plainKey = (k) => ({ w: k.w });

  /* ===================================================================== main benchmark */
  /* cfg: { covers:[{id,name,img}], payload:Uint8Array, isFile, passphrase, encrypt, ecc, trials, methods, formats, attackIds, useWorkers } */
  SB.runBenchmark = async function (cfg, onProgress) {
    const t0 = performance.now();
    const attacks = cfg.attackIds.map(SB.attackById);
    const specs = attacks.map(SB.attackSpec);
    const methods = cfg.methods.map(SB.methodById);
    const trials = Math.max(1, cfg.trials | 0 || 1);

    // keys: one per trial
    const keys = [];
    for (let t = 0; t < trials; t++) keys.push(await SB.crypto.deriveKey(cfg.passphrase + (t ? '#' + t : '')));
    const encrypt = !!(cfg.encrypt && SB.crypto.available);

    const jobs = [], skipped = [];
    let sample = null;
    for (let ci = 0; ci < cfg.covers.length; ci++) {
      const cov = cfg.covers[ci];
      for (let t = 0; t < trials; t++) {
        const enc = await SB.pipeline.encode(cfg.payload, { key: keys[t], encrypt, isFile: cfg.isFile, ecc: cfg.ecc });
        if (!sample) sample = enc;
        for (const fmt of cfg.formats)
          for (const m of methods) {
            const cap = m.capacityBits(cov.img.width, cov.img.height);
            const base = { key: m.id + ':' + fmt, id: m.id, name: m.name, domain: m.domain, format: fmt, formatLabel: SB.FORMAT_LABEL[fmt], capacityBits: cap, capacityBytes: Math.floor(cap / 8), bpp: cap / (cov.img.width * cov.img.height), payloadBits: enc.bits.length };
            if (enc.bits.length > cap) {
              skipped.push(Object.assign(base, { status: 'skipped', reason: `Payload (${enc.coded.length} B after framing${cfg.ecc ? ' + ECC' : ''}) exceeds capacity (${Math.floor(cap / 8)} B) for this image` }));
              continue;
            }
            jobs.push({
              imageId: cov.id, trial: t, methodId: m.id, fmt, cover: cov.img, bits: enc.bits, key: plainKey(keys[t]), nsym: enc.nsym,
              frameBits: SB.bytesToBits(enc.frame), frameLen: enc.frame.length, attacks: specs,
              wantStego: ci === 0 && t === 0,
            });
          }
      }
    }
    jobs.sort((a, b) => (COST[b.methodId] || 1) - (COST[a.methodId] || 1));

    const pool = SB.createPool(cfg.useWorkers === false ? 1 : defaultWorkers(), cfg.useWorkers !== false);
    let done = 0;
    const total = jobs.length;
    onProgress && onProgress({ done: 0, total, label: `Starting (${pool.kind === 'workers' ? pool.size + ' workers' : 'page thread'})`, eta: null });
    let raw;
    try {
      raw = await runAll(pool, jobs, (r, j) => {
        done++;
        const el = (performance.now() - t0) / 1000;
        onProgress && onProgress({ done, total, label: `${r.name} [${SB.FORMAT_LABEL[j.fmt]}]`, eta: done ? (el / done) * (total - done) : null });
      });
    } finally { pool.close(); }

    const results = SB.aggregate(raw.concat(skipped), { attacks: specs });
    // preserve a stable order: method list order, then format
    const order = (r) => cfg.methods.indexOf(r.id) * 10 + cfg.formats.indexOf(r.format);
    results.sort((a, b) => order(a) - order(b));
    const c0 = cfg.covers[0].img;
    return {
      results, width: c0.width, height: c0.height, nImages: cfg.covers.length, trials, attacks: specs, formats: cfg.formats,
      payloadBytes: cfg.payload.length, frameBytes: sample.frame.length, codedBytes: sample.coded.length, payloadBits: sample.bits.length,
      encrypt, ecc: cfg.ecc, workers: pool.kind, key0: keys[0], seconds: (performance.now() - t0) / 1000,
    };
  };

  /* ===================================================================== payload sweep */
  /* cfg: { covers:[{id,img}], rates:[bpp], methods, attackId, passphrase } -> { series:{methodId:[{bpp,none,atk,psnr,n}]} } */
  SB.runSweep = async function (cfg, onProgress) {
    const attack = SB.attackById(cfg.attackId), specs = [SB.attackSpec(SB.attackById('none'))];
    if (attack.id !== 'none') specs.push(SB.attackSpec(attack));
    const key = plainKey(await SB.crypto.deriveKey(cfg.passphrase + '#sweep'));
    const jobs = [];
    for (const cov of cfg.covers)
      for (const id of cfg.methods) {
        const m = SB.methodById(id), cap = m.capacityBits(cov.img.width, cov.img.height);
        for (const bpp of cfg.rates) {
          const n = Math.floor((bpp * cov.img.width * cov.img.height) / 8) * 8;     // whole bytes
          if (n < 16 || n > cap) continue;
          const rng = SB.mulberry32(SB.hash32(n) ^ 99), bits = new Uint8Array(n);
          for (let i = 0; i < n; i++) bits[i] = rng() < 0.5 ? 1 : 0;
          jobs.push({ imageId: cov.id, methodId: id, fmt: 'lossless', cover: cov.img, bits, key, nsym: 0, frameBits: bits, frameLen: n / 8, attacks: specs, lite: true, _bpp: bpp });
        }
      }
    const pool = SB.createPool(defaultWorkers(), cfg.useWorkers !== false);
    let done = 0;
    let raw;
    try { raw = await runAll(pool, jobs, () => { done++; onProgress && onProgress({ done, total: jobs.length }); }); } finally { pool.close(); }
    const series = {};
    raw.forEach((r, i) => {
      if (r.status !== 'ok') return;
      const bpp = jobs[i]._bpp, arr = (series[r.id] = series[r.id] || {});
      const e = (arr[bpp] = arr[bpp] || { none: [], atk: [], psnr: [] });
      e.none.push(r.attacks.none.recovery);
      if (r.attacks[attack.id] && !r.attacks[attack.id].unsupported) e.atk.push(r.attacks[attack.id].recovery);
      e.psnr.push(r.psnr);
    });
    const out = {};
    for (const id of Object.keys(series))
      out[id] = Object.keys(series[id]).map(Number).sort((a, b) => a - b).map((bpp) => {
        const e = series[id][bpp];
        return { bpp, none: SB.stats.mean(e.none), atk: SB.stats.mean(e.atk), atkStd: SB.stats.std(e.atk), psnr: SB.stats.mean(e.psnr), n: e.none.length };
      });
    return { series: out, attack };
  };

  /* ===================================================================== breakpoint curves */
  /* cfg: { cover:{id,img}, methods, sweepId, passphrase, payloadBytes } -> { curves:{methodId:[recovery per value]}, sweep } */
  SB.runBreakpoint = async function (cfg, onProgress) {
    const sweep = SB.SWEEPS[cfg.sweepId];
    const kind = cfg.sweepId === 'jpeg' ? 'jpeg' : cfg.sweepId;
    const specs = sweep.values.map((v) => ({ id: cfg.sweepId + v, kind: kind, value: v, label: String(v), group: 'sweep' }));
    const key = plainKey(await SB.crypto.deriveKey(cfg.passphrase + '#bp'));
    const payload = new Uint8Array(cfg.payloadBytes || 24).map((_, i) => (i * 37 + 11) & 255);
    const enc = await SB.pipeline.encode(payload, { ecc: cfg.ecc || 0 });
    const jobs = [];
    for (const id of cfg.methods) {
      const m = SB.methodById(id);
      if (enc.bits.length > m.capacityBits(cfg.cover.img.width, cfg.cover.img.height)) continue;
      jobs.push({ imageId: cfg.cover.id, methodId: id, fmt: 'lossless', cover: cfg.cover.img, bits: enc.bits, key, nsym: enc.nsym, frameBits: SB.bytesToBits(enc.frame), frameLen: enc.frame.length, attacks: specs, lite: true });
    }
    const pool = SB.createPool(defaultWorkers(), cfg.useWorkers !== false);
    let done = 0, raw;
    try { raw = await runAll(pool, jobs, () => { done++; onProgress && onProgress({ done, total: jobs.length }); }); } finally { pool.close(); }
    const curves = {};
    raw.forEach((r) => { if (r.status === 'ok') curves[r.id] = specs.map((s) => (r.attacks[s.id] && !r.attacks[s.id].unsupported ? r.attacks[s.id].recovery : null)); });
    return { curves, sweep, sweepId: cfg.sweepId };
  };
})();
